import { z } from "zod";

import {
  allocateAttempt,
  createArtifactIndex,
  createAttemptRegistry,
  sealAttempt,
  transitionAttempt,
} from "./attempt-ledger";
import { attemptRegistrySchema, type ArtifactEntry, type AttemptRegistry, type RunSpec } from "./attempt-schemas";
import {
  summarizeBatchDenominator,
  verifyExp0001aBatchRegistry,
  type BatchRegistry,
  type BatchRegistryEvent,
  type Exp0001aBatchPlan,
} from "./exp0001a-batch-coordinator";
import {
  exp0001aExperimentFreezeAdapterReceiptSchema,
  computeExp0001aExperimentFreezeAdapterReceiptDigest,
  verifyExp0001aAdapterPrebriefSource,
  type Exp0001aAdapterPrebriefSource,
  type Exp0001aExperimentFreezeAdapterReceipt,
} from "./exp0001a-experiment-freeze-adapter";
import { verifyAttemptRegistry } from "./provenance-verification";
import { hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const rawDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const EXP0001A_REGISTRY_BRIDGE_SOURCE_PATH = "src/lib/research/exp0001a-registry-bridge.ts" as const;

const mappingSchema = z.object({
  manifestPosition: z.number().int().min(0).max(47),
  attemptId: z.string().min(1),
  opaqueLabel: z.enum(["A0", "A1"]),
  compatibilityCondition: z.enum(["baseline", "candidate"]),
  batchRetainedEventDigest: digestSchema,
  retainedOutcome: z.enum(["completed", "failed", "timeout", "infra_failure", "policy_violation"]),
  batchArtifactRoot: rawDigestSchema.nullable(),
  batchAuthorEvidenceRoot: rawDigestSchema.nullable(),
  batchAttemptBundleSha256: rawDigestSchema.nullable(),
  authorIdentityCommitment: digestSchema,
  authorIdentityArtifactSha256: digestSchema,
  batchArtifactEntriesCommitment: digestSchema,
  sealedArtifactMerkleRoot: digestSchema,
  sealedAuthorEvidenceRoot: digestSchema,
}).strict();

const bridgeContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("exp-0001a-batch-to-sealed-attempt-registry"),
  protocolId: z.literal("EXP-0001A"),
  batchPlanDigest: digestSchema,
  batchRegistryDigest: digestSchema,
  freezeAdapterReceiptDigest: digestSchema,
  sourcePrebriefFreezeDigest: digestSchema,
  conditionCompatibilityMapping: z.object({
    A0: z.literal("baseline"),
    A1: z.literal("candidate"),
    semantics: z.literal("schema-slots-only-aa-treatments-remain-identical"),
  }).strict(),
  denominator: z.literal(48),
  mappings: z.array(mappingSchema).length(48),
  sealedRunSpecDigest: digestSchema,
  sealedRegistryRoot: digestSchema,
}).strict();

export const exp0001aRegistryBridgeReceiptSchema = bridgeContentSchema.extend({
  receiptDigest: digestSchema,
}).strict();

export type Exp0001aRegistryBridgeReceipt = z.infer<typeof exp0001aRegistryBridgeReceiptSchema>;

export type Exp0001aRegistryBridgeResult = {
  registry: AttemptRegistry;
  receipt: Exp0001aRegistryBridgeReceipt;
};

function computeReceiptDigest(receipt: Exp0001aRegistryBridgeReceipt): string {
  const { receiptDigest: _ignored, ...content } = receipt;
  void _ignored;
  return hashCanonicalJson(content);
}

export function computeExp0001aRegistryBridgeReceiptDigest(
  receipt: Exp0001aRegistryBridgeReceipt,
): string {
  return computeReceiptDigest(receipt);
}

function retainedEvent(
  registry: BatchRegistry,
  attemptId: string,
): Extract<BatchRegistryEvent, { kind: "attempt_retained" }> {
  const matches = registry.events.filter((event): event is Extract<BatchRegistryEvent, { kind: "attempt_retained" }> => (
    event.kind === "attempt_retained" && event.attemptId === attemptId
  ));
  if (matches.length !== 1) throw new Error(`Expected one retained batch event for ${attemptId}.`);
  return matches[0];
}

function registeredAt(registry: BatchRegistry, attemptId: string): string {
  const event = registry.events.find((candidate) => candidate.kind === "assignment_registered" && candidate.attemptId === attemptId);
  if (!event) throw new Error(`Missing batch registration event for ${attemptId}.`);
  return event.at;
}

function briefAt(registry: BatchRegistry, attemptId: string): string {
  const events = registry.events.filter((candidate) => candidate.kind === "brief_delivered" && candidate.attemptId === attemptId);
  if (events.length !== 1) throw new Error(`Expected one brief-delivery event for retained attempt ${attemptId}.`);
  return events[0].at;
}

function artifactCategory(artifactPath: string): ArtifactEntry["category"] {
  if (artifactPath === "author-brief.json") return "prompt";
  if (/\.png$/i.test(artifactPath)) return "image";
  if (/final-state|inspection/.test(artifactPath)) return "semantic-state";
  if (/events|trace/.test(artifactPath)) return "trace";
  if (/contract|identity|seal|bundle|final/.test(artifactPath)) return "other";
  return "log";
}

function artifactMimeType(artifactPath: string): string {
  if (/\.png$/i.test(artifactPath)) return "image/png";
  if (/\.jsonl$/i.test(artifactPath)) return "application/x-ndjson";
  if (/\.json$/i.test(artifactPath)) return "application/json";
  return "application/octet-stream";
}

function makeRunSpec(
  plan: Exp0001aBatchPlan,
  prebrief: Exp0001aAdapterPrebriefSource,
): RunSpec {
  const profile = plan.configs[0].runnerConfig;
  const product = {
    gitCommit: prebrief.baseline.gitCommit,
    buildDigest: prebrief.baseline.buildIdentityDigest,
    deploymentUrl: prebrief.baseline.productionUrl,
  } as const;
  return {
    schemaVersion: 1,
    runId: `run-${plan.livePreflight.batchId}`,
    protocol: { id: "EXP-0001A", digest: prebrief.frozenSources.protocol.fileDigest },
    conditions: { baseline: product, candidate: product },
    runner: { runnerDigest: prebrief.conditions.A0.authorRunnerDigest },
    taskSet: {
      id: plan.manifest.benchmark.benchmarkId,
      version: plan.manifest.manifestId,
      split: "development",
      commitment: plan.manifest.benchmark.bundleDigest,
    },
    model: {
      provider: "openai",
      snapshot: profile.model,
      reasoningEffort: profile.reasoningEffort,
      temperature: null,
      seed: null,
    },
    environment: {
      imageDigest: hashCanonicalJson({
        planDigest: plan.planDigest,
        runnerProfileDigest: plan.configs[0].sourceCommitments.runnerProfileDigest,
      }),
      browser: `${prebrief.conditions.A0.browser.product} ${prebrief.conditions.A0.browser.version}`,
      viewport: {
        width: prebrief.conditions.A0.viewport.width,
        height: prebrief.conditions.A0.viewport.height,
        deviceScaleFactor: prebrief.conditions.A0.viewport.deviceScaleFactor,
      },
      locale: prebrief.conditions.A0.viewport.locale,
      timezone: prebrief.conditions.A0.viewport.timezone,
    },
    budgets: {
      wallTimeMs: prebrief.conditions.A0.authorBudgets.wallMs,
      maxToolCalls: prebrief.conditions.A0.authorBudgets.toolCalls,
      maxInputTokens: prebrief.conditions.A0.authorBudgets.inputTokens,
      maxOutputTokens: prebrief.conditions.A0.authorBudgets.outputTokens,
    },
    createdAt: prebrief.frozenAt,
  };
}

function terminalState(outcome: "completed" | "failed" | "timeout" | "infra_failure" | "policy_violation") {
  if (outcome === "completed") return "author_completed" as const;
  if (outcome === "failed") return "author_failed" as const;
  return outcome;
}

function parseFreezeSources(input: {
  plan: Exp0001aBatchPlan;
  prebriefFreeze: unknown;
  freezeAdapterReceipt: unknown;
}): { prebrief: Exp0001aAdapterPrebriefSource; adapter: Exp0001aExperimentFreezeAdapterReceipt } {
  const prebrief = verifyExp0001aAdapterPrebriefSource(input.prebriefFreeze);
  const adapter = exp0001aExperimentFreezeAdapterReceiptSchema.parse(input.freezeAdapterReceipt);
  if (computeExp0001aExperimentFreezeAdapterReceiptDigest(adapter) !== adapter.receiptDigest) {
    throw new Error("Experiment-freeze adapter receipt digest is invalid.");
  }
  if (adapter.sourcePrebriefFreezeDigest !== prebrief.freezeDigest) {
    throw new Error("Experiment-freeze adapter is bound to another pre-brief freeze.");
  }
  if (hashCanonicalJson(adapter.legacyExecutionFreeze) !== hashCanonicalJson(input.plan.executionFreeze)) {
    throw new Error("Batch plan was not compiled from the retained experiment-freeze adapter output.");
  }
  return { prebrief, adapter };
}

/**
 * Losslessly commits the batch registry's fixed denominator, outcomes, event
 * roots, and artifact hashes into the generic sealed registry consumed by the
 * blinded-review system. It never reads outcomes to select or order attempts.
 */
export function bridgeExp0001aBatchRegistry(input: {
  plan: Exp0001aBatchPlan;
  batchRegistry: BatchRegistry;
  prebriefFreeze: unknown;
  freezeAdapterReceipt: unknown;
}): Exp0001aRegistryBridgeResult {
  const batchRegistry = verifyExp0001aBatchRegistry(input.batchRegistry, input.plan);
  const denominator = summarizeBatchDenominator(batchRegistry, input.plan);
  if (denominator.retainedAuthorAttempts !== 48 || denominator.unresolvedBegunAttempts !== 0
      || denominator.remainingUnbegunAssignments !== 0) {
    throw new Error("Registry bridge requires all 48 fixed author assignments to be retained.");
  }
  if (batchRegistry.events.some((event) => event.kind === "hard_stop")) {
    throw new Error("A hard-stopped author batch cannot enter blinded review.");
  }
  const { prebrief, adapter } = parseFreezeSources(input);
  let registry = createAttemptRegistry(makeRunSpec(input.plan, prebrief));
  const mappings: z.infer<typeof mappingSchema>[] = [];

  input.plan.configs.forEach((config, manifestPosition) => {
    const retained = retainedEvent(batchRegistry, config.attempt.attemptId);
    if (!retained.data.evidenceComplete) {
      throw new Error(`Attempt ${config.attempt.attemptId} lacks complete retained evidence.`);
    }
    const task = input.plan.manifest.tasks.find((candidate) => candidate.taskId === config.attempt.taskId);
    if (!task) throw new Error(`Task commitment is missing for ${config.attempt.taskId}.`);
    const condition = config.attempt.opaqueLabel === "A0" ? "baseline" : "candidate";
    registry = allocateAttempt(registry, {
      attemptId: config.attempt.attemptId,
      taskId: config.attempt.taskId,
      taskCommitment: task.taskDigest,
      pairId: config.attempt.pairId,
      condition,
      replicateIndex: config.attempt.replicateIndex,
      orderIndex: config.attempt.orderIndex,
      timeBlock: config.attempt.timeBlock,
      at: registeredAt(batchRegistry, config.attempt.attemptId),
    });
    const beganAt = briefAt(batchRegistry, config.attempt.attemptId);
    registry = transitionAttempt(registry, config.attempt.attemptId, "provisioned", beganAt, {
      sourceBatchRegistryDigest: batchRegistry.registryDigest,
    });
    registry = transitionAttempt(registry, config.attempt.attemptId, "started", beganAt, {
      sourceBriefDigest: config.hashes.brief,
    });
    registry = transitionAttempt(
      registry,
      config.attempt.attemptId,
      terminalState(retained.data.retainedOutcome),
      retained.at,
      {
        sourceRetainedEventDigest: retained.eventDigest,
        sourceArtifactRoot: retained.data.artifactRoot,
        sourceAuthorEvidenceRoot: retained.data.authorEvidenceRoot,
        sourceAttemptBundleSha256: retained.data.attemptBundleSha256,
      },
    );
    const artifactIndex = createArtifactIndex(config.attempt.attemptId, retained.data.artifacts.map((artifact) => ({
      path: artifact.path,
      category: artifactCategory(artifact.path),
      mimeType: artifactMimeType(artifact.path),
      bytes: artifact.bytes,
      sha256: `sha256:${artifact.sha256}`,
    })));
    registry = sealAttempt(registry, config.attempt.attemptId, retained.at, artifactIndex);
    const sealed = registry.attempts.at(-1)!;
    mappings.push(mappingSchema.parse({
      manifestPosition,
      attemptId: config.attempt.attemptId,
      opaqueLabel: config.attempt.opaqueLabel,
      compatibilityCondition: condition,
      batchRetainedEventDigest: retained.eventDigest,
      retainedOutcome: retained.data.retainedOutcome,
      batchArtifactRoot: retained.data.artifactRoot,
      batchAuthorEvidenceRoot: retained.data.authorEvidenceRoot,
      batchAttemptBundleSha256: retained.data.attemptBundleSha256,
      authorIdentityCommitment: retained.data.authorIdentityCommitment,
      authorIdentityArtifactSha256: retained.data.authorIdentityArtifactSha256,
      batchArtifactEntriesCommitment: hashCanonicalJson(retained.data.artifacts),
      sealedArtifactMerkleRoot: sealed.artifactIndex!.merkleRoot,
      sealedAuthorEvidenceRoot: sealed.authorEvidenceRoot!,
    }));
  });

  registry = attemptRegistrySchema.parse(registry);
  const verification = verifyAttemptRegistry(registry);
  if (!verification.ok) throw new Error(`Bridged attempt registry is invalid: ${verification.errors.join(" ")}`);
  const content = bridgeContentSchema.parse({
    schemaVersion: 1,
    kind: "exp-0001a-batch-to-sealed-attempt-registry",
    protocolId: "EXP-0001A",
    batchPlanDigest: input.plan.planDigest,
    batchRegistryDigest: batchRegistry.registryDigest,
    freezeAdapterReceiptDigest: adapter.receiptDigest,
    sourcePrebriefFreezeDigest: prebrief.freezeDigest,
    conditionCompatibilityMapping: {
      A0: "baseline",
      A1: "candidate",
      semantics: "schema-slots-only-aa-treatments-remain-identical",
    },
    denominator: 48,
    mappings,
    sealedRunSpecDigest: registry.runSpecDigest,
    sealedRegistryRoot: registry.registryRoot,
  });
  return {
    registry,
    receipt: exp0001aRegistryBridgeReceiptSchema.parse({
      ...content,
      receiptDigest: hashCanonicalJson(content),
    }),
  };
}

export function verifyExp0001aRegistryBridge(input: {
  plan: Exp0001aBatchPlan;
  batchRegistry: BatchRegistry;
  prebriefFreeze: unknown;
  freezeAdapterReceipt: unknown;
  registry: unknown;
  receipt: unknown;
}): Exp0001aRegistryBridgeResult {
  const expected = bridgeExp0001aBatchRegistry(input);
  const registry = attemptRegistrySchema.parse(input.registry);
  const receipt = exp0001aRegistryBridgeReceiptSchema.parse(input.receipt);
  if (computeReceiptDigest(receipt) !== receipt.receiptDigest) throw new Error("Registry-bridge receipt digest is invalid.");
  if (hashCanonicalJson(registry) !== hashCanonicalJson(expected.registry)
      || hashCanonicalJson(receipt) !== hashCanonicalJson(expected.receipt)) {
    throw new Error("Registry bridge output drifted from the complete retained batch.");
  }
  return { registry, receipt };
}
