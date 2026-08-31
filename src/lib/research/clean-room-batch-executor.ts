import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { DevelopmentAttemptConfig } from "./development-attempt-config";
import {
  executorResultSchema,
  providerUsageSchema,
  type BatchAttemptExecutor,
  type BatchExecutorResult,
} from "./exp0001a-batch-coordinator";
import { canonicalJson } from "./provenance-crypto";

const bareSha256 = z.string().regex(/^[a-f0-9]{64}$/);
const prefixedSha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const safeRelativePath = /^(?!.*(?:^|\/)\.\.(?:\/|$))(?!\/)[\x20-\x7e]+$/;

const leafSchema = z.object({
  path: z.string().regex(safeRelativePath),
  bytes: z.number().int().nonnegative(),
  sha256: bareSha256,
}).strict();

const evidenceRootSchema = z.object({
  algorithm: z.literal("sha256"),
  leaves: z.array(leafSchema),
  root: bareSha256,
}).strict();

const attemptBundleSchema = z.object({
  schemaVersion: z.literal("clean-room-live-attempt/v1"),
  attemptId: z.string().min(1),
  mode: z.literal("live"),
  status: z.string().min(1),
  failure: z.object({ message: z.string().min(1) }).passthrough().nullable(),
  startedAt: timestamp,
  elapsedMs: z.number().int().nonnegative(),
  attemptStartedAt: timestamp.nullable(),
  author: z.object({
    termination: z.string().min(1),
    usage: z.object({
      totals: providerUsageSchema,
      byTurn: z.array(providerUsageSchema.extend({ turn: z.number().int().positive() }).strict()),
    }).passthrough(),
    observedProvider: z.object({
      provider: z.literal("openai_responses"),
      completedTurns: z.number().int().nonnegative(),
      observedModels: z.array(z.string().min(1).max(200)),
      observedServiceTiers: z.array(z.string().min(1).max(80)),
      allTurnsReportedModel: z.boolean(),
      allTurnsReportedServiceTier: z.boolean(),
    }).strict(),
  }).passthrough(),
  providerIntent: z.object({
    provider: z.literal("openai_responses"),
    requestedModelIdentifier: z.string().min(1).max(200),
    requestedServiceTier: z.literal("default"),
    immutableModelSnapshotVerified: z.literal(false),
  }).strict(),
  authorIdentity: z.object({
    identityCommitment: prefixedSha256,
    artifactPath: z.literal("author-identity-commitment.json"),
    artifactSha256: prefixedSha256,
  }).strict(),
  authorEvidenceRoot: evidenceRootSchema.nullable(),
  artifactIndex: evidenceRootSchema,
}).passthrough();

type CleanRoomRunResult = {
  outputDir: string;
  status: string;
  participantContractHash: string;
  spectatorContractHash: string;
};

export type CleanRoomAttemptRunner = (
  runnerConfig: DevelopmentAttemptConfig["runnerConfig"],
  options: {
    onBriefDelivered: (at: string) => Promise<string>;
    /** Trusted batch-owned path; never serialized into author-visible config. */
    expectedOutputDir: string;
    /** Trusted fixed-runtime callback; never serialized into author-visible config. */
    verifyRuntimeDependencies: () => Promise<RuntimeDependencyVerification>;
  },
) => Promise<CleanRoomRunResult>;

export type RuntimeDependencyVerification = {
  receiptDigest: string;
  componentSetRoot: string;
  verificationScope: "critical-load-and-executable-subset";
  verificationDurationMs: number;
};

export type CreateCleanRoomBatchExecutorOptions = {
  outputRoot: string;
  runCleanRoomAttempt: CleanRoomAttemptRunner;
  verifyRuntimeDependencies: () => Promise<RuntimeDependencyVerification>;
  now?: () => string;
};

type InventoryEntry = {
  path: string;
  bytes: number;
  sha256: string;
  contents: Buffer;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function inventoryDirectory(root: string, current = ""): Promise<InventoryEntry[]> {
  const absolute = path.join(root, current);
  const entries = await readdir(absolute, { withFileTypes: true });
  const inventory: InventoryEntry[] = [];
  for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (!safeRelativePath.test(relative)) throw new Error(`Unsafe retained artifact path: ${relative}`);
    const absoluteEntry = path.join(root, relative);
    const stat = await lstat(absoluteEntry);
    if (stat.isSymbolicLink()) throw new Error(`Retained attempt contains a symbolic link: ${relative}`);
    if (stat.isDirectory()) {
      inventory.push(...await inventoryDirectory(root, relative));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Retained attempt contains a non-file artifact: ${relative}`);
    const contents = await readFile(absoluteEntry);
    inventory.push({ path: relative, bytes: contents.byteLength, sha256: sha256(contents), contents });
  }
  return inventory;
}

function rootForLeaves(leaves: Array<{ path: string; bytes: number; sha256: string }>): string {
  return sha256(canonicalJson([...leaves].sort((left, right) => compareCodeUnits(left.path, right.path))));
}

function verifyEvidenceRoot(
  committed: z.infer<typeof evidenceRootSchema>,
  actual: Array<{ path: string; bytes: number; sha256: string }>,
  label: string,
): void {
  const ordered = [...actual].sort((left, right) => compareCodeUnits(left.path, right.path));
  if (canonicalJson(committed.leaves) !== canonicalJson(ordered) || committed.root !== rootForLeaves(ordered)) {
    throw new Error(`${label} evidence commitment does not match retained bytes.`);
  }
}

function incidentCode(bundle: z.infer<typeof attemptBundleSchema>): string | null {
  if (bundle.failure) return "runner_failure";
  if (bundle.status === "author_completed") return null;
  return bundle.status.replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 160) || "author_noncompletion";
}

function outcomeFor(bundle: z.infer<typeof attemptBundleSchema>): Extract<BatchExecutorResult, { kind: "begun" }>["outcome"] {
  if (bundle.failure) return "infra_failure";
  if (bundle.status === "author_completed") return "completed";
  if (/timeout/i.test(bundle.status) || /timeout/i.test(bundle.author.termination)) return "timeout";
  return "failed";
}

function isFalsificationMessage(message: string): boolean {
  return /contract drift|secret leakage|credential|origin drift|policy violation/i.test(message);
}

function authorCostObservability(entry: InventoryEntry): {
  costObservability: "observed" | "attested_no_provider_call" | "unobservable";
  providerEvidenceDigest: string;
} {
  const lines = entry.contents.toString("utf8").split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as { type?: unknown; data?: unknown };
    } catch {
      throw new Error(`author-events.jsonl line ${index + 1} is not valid JSON.`);
    }
  });
  const starts = lines.filter((event) => event.type === "responses_request_started");
  const completions = lines.filter((event) => event.type === "responses_request_completed");
  const startedTurns = starts.map((event) => (event.data as { turn?: unknown } | undefined)?.turn);
  const completedTurns = completions.map((event) => (event.data as { turn?: unknown } | undefined)?.turn);
  if (startedTurns.some((turn) => !Number.isSafeInteger(turn))
      || completedTurns.some((turn) => !Number.isSafeInteger(turn))
      || new Set(startedTurns).size !== startedTurns.length
      || new Set(completedTurns).size !== completedTurns.length
      || completedTurns.some((turn) => !startedTurns.includes(turn))) {
    throw new Error("Author provider event evidence is malformed or does not reconcile.");
  }
  const unresolved = startedTurns.filter((turn) => !completedTurns.includes(turn));
  return {
    costObservability: unresolved.length > 0 ? "unobservable"
      : startedTurns.length === 0 ? "attested_no_provider_call"
        : "observed",
    providerEvidenceDigest: `sha256:${entry.sha256}`,
  };
}

function isCompatibleObservedModel(requested: string, observed: string, observedAt: string): boolean {
  if (observed === requested) return true;
  const escaped = requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}-(20\\d{2}-\\d{2}-\\d{2})(?:[-.][A-Za-z0-9._-]+)?$`).exec(observed);
  if (!match) return false;
  const resolvedAt = Date.parse(`${match[1]}T00:00:00.000Z`);
  if (!Number.isFinite(resolvedAt) || new Date(resolvedAt).toISOString().slice(0, 10) !== match[1]) return false;
  return resolvedAt <= Date.parse(observedAt);
}

function providerIdentityObservation(
  bundle: z.infer<typeof attemptBundleSchema>,
  expected: { requestedModelIdentifier: string; requestedServiceTier: "default" },
) {
  const observed = bundle.author.observedProvider;
  const eventTurns = observed.completedTurns;
  const requestIntentMatches = bundle.providerIntent.requestedModelIdentifier === expected.requestedModelIdentifier
    && bundle.providerIntent.requestedServiceTier === expected.requestedServiceTier;
  const observedModelCompatible = observed.observedModels.length === 1
    && isCompatibleObservedModel(expected.requestedModelIdentifier, observed.observedModels[0], bundle.startedAt);
  const status = !requestIntentMatches ? "falsified" as const
    : eventTurns === 0 ? "unobservable" as const
      : observed.allTurnsReportedModel
      && observed.allTurnsReportedServiceTier
      && observedModelCompatible
      && observed.observedServiceTiers.length === 1
      && observed.observedServiceTiers[0] === expected.requestedServiceTier
      ? "observed" as const
      : "falsified" as const;
  return {
    provider: "openai_responses" as const,
    requestedModelIdentifier: bundle.providerIntent.requestedModelIdentifier,
    requestedServiceTier: bundle.providerIntent.requestedServiceTier,
    immutableModelSnapshotVerified: false as const,
    completedTurns: eventTurns,
    status,
    observedModelIdentifiers: observed.observedModels,
    observedServiceTiers: observed.observedServiceTiers,
    requestedAliasExactMatch: observed.observedModels.length === 1
      && observed.observedModels[0] === bundle.providerIntent.requestedModelIdentifier,
  };
}

export async function retainedAttemptResult(
  outputDir: string,
  expectedAttemptId: string,
  expectedAuthorIdentityCommitment: string,
  expectedProviderIntent: { requestedModelIdentifier: string; requestedServiceTier: "default" },
  expectedBriefDeliveredAt?: string,
): Promise<Extract<BatchExecutorResult, { kind: "begun" }>> {
  prefixedSha256.parse(expectedAuthorIdentityCommitment);
  z.object({
    requestedModelIdentifier: z.string().min(1).max(200),
    requestedServiceTier: z.literal("default"),
  }).strict().parse(expectedProviderIntent);
  const inventory = await inventoryDirectory(outputDir);
  const byPath = new Map(inventory.map((entry) => [entry.path, entry]));
  const bundleEntry = byPath.get("attempt-bundle.json");
  if (!bundleEntry) throw new Error("Retained attempt lacks attempt-bundle.json.");
  const bundle = attemptBundleSchema.parse(JSON.parse(bundleEntry.contents.toString("utf8")));
  if (bundle.attemptId !== expectedAttemptId) throw new Error("Retained attempt identity differs from its frozen assignment.");
  if (bundle.authorIdentity.identityCommitment !== expectedAuthorIdentityCommitment) {
    throw new Error("Retained author identity differs from the trusted commitment frozen into its runner config.");
  }
  if (!bundle.attemptStartedAt) throw new Error("Retained attempt has no brief-delivery timestamp.");
  if (expectedBriefDeliveredAt !== undefined && bundle.attemptStartedAt !== expectedBriefDeliveredAt) {
    throw new Error("Retained attempt brief-delivery timestamp differs from the durable registry event.");
  }

  const indexLeaves = inventory
    .filter((entry) => entry.path !== "attempt-bundle.json")
    .map(({ path: artifactPath, bytes, sha256: digest }) => ({ path: artifactPath, bytes, sha256: digest }));
  verifyEvidenceRoot(bundle.artifactIndex, indexLeaves, "Attempt artifact index");
  if (bundle.authorEvidenceRoot) {
    const authorLeaves = inventory
      .filter((entry) => entry.path.startsWith("author-") && entry.path !== "author-evidence-seal.json")
      .map(({ path: artifactPath, bytes, sha256: digest }) => ({ path: artifactPath, bytes, sha256: digest }));
    verifyEvidenceRoot(bundle.authorEvidenceRoot, authorLeaves, "Author");
  }
  const identityEntry = byPath.get(bundle.authorIdentity.artifactPath);
  if (!identityEntry || `sha256:${identityEntry.sha256}` !== bundle.authorIdentity.artifactSha256) {
    throw new Error("Author identity artifact does not match its attempt-bundle commitment.");
  }
  const identityRecord = JSON.parse(identityEntry.contents.toString("utf8"));
  const expectedIdentityRecord = {
    attemptId: expectedAttemptId,
    identityCommitment: expectedAuthorIdentityCommitment,
    schemaVersion: "author-identity-commitment/v1",
  };
  if (identityEntry.contents.toString("utf8") !== canonicalJson(expectedIdentityRecord)
      || canonicalJson(identityRecord) !== canonicalJson(expectedIdentityRecord)) {
    throw new Error("Author identity artifact is not the exact canonical record for this attempt.");
  }

  const failureMessage = bundle.failure?.message ?? "";
  const falsification = isFalsificationMessage(failureMessage);
  const outcome = outcomeFor(bundle);
  const finishedAt = new Date(Date.parse(bundle.startedAt) + bundle.elapsedMs).toISOString();
  const authorEventsEntry = byPath.get("author-events.jsonl");
  if (!authorEventsEntry) throw new Error("Retained attempt lacks author-events.jsonl provider provenance.");
  const costEvidence = authorCostObservability(authorEventsEntry);
  const providerIdentity = providerIdentityObservation(bundle, expectedProviderIntent);
  const providerIdentityFalsified = providerIdentity.status === "falsified";
  const usageByTurn = bundle.author.usage.byTurn.map(({ turn: _turn, ...usage }) => usage);
  const summedUsage = usageByTurn.reduce((total, turn) => ({
    inputTokens: total.inputTokens + turn.inputTokens,
    uncachedInputTokens: total.uncachedInputTokens + turn.uncachedInputTokens,
    cachedInputTokens: total.cachedInputTokens + turn.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens + turn.cacheWriteInputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens + turn.reasoningOutputTokens,
    totalTokens: total.totalTokens + turn.totalTokens,
  }), {
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  });
  if (canonicalJson(summedUsage) !== canonicalJson(bundle.author.usage.totals)) {
    throw new Error("Per-turn provider usage does not reconcile to retained author totals.");
  }
  const result = executorResultSchema.parse({
    kind: "begun",
    finishedAt,
    outcome,
    usage: bundle.author.usage.totals,
    usageByTurn,
    artifacts: inventory.map(({ path: artifactPath, bytes, sha256: digest }) => ({ path: artifactPath, bytes, sha256: digest })),
    artifactRoot: bundle.artifactIndex.root,
    authorEvidenceRoot: bundle.authorEvidenceRoot?.root ?? null,
    attemptBundleSha256: bundleEntry.sha256,
    authorIdentityCommitment: expectedAuthorIdentityCommitment,
    authorIdentityArtifactSha256: bundle.authorIdentity.artifactSha256,
    ...costEvidence,
    providerIdentity,
    hardIncident: Boolean(bundle.failure) || falsification || providerIdentityFalsified,
    falsification: falsification || providerIdentityFalsified,
    incidentCode: providerIdentityFalsified ? "provider_identity_drift" : incidentCode(bundle),
  });
  if (result.kind !== "begun") throw new Error("Retained attempt parsed as an impossible not-started result.");
  return result;
}

export function createCleanRoomBatchExecutor(options: CreateCleanRoomBatchExecutorOptions): BatchAttemptExecutor {
  if (!path.isAbsolute(options.outputRoot)) throw new Error("Clean-room batch output root must be absolute.");
  if (typeof options.verifyRuntimeDependencies !== "function") {
    throw new Error("Clean-room batch execution requires the fixed runtime dependency verifier.");
  }
  const now = options.now ?? (() => new Date().toISOString());
  return async (config, controls) => {
    const outputDir = path.join(options.outputRoot, config.attempt.attemptId);
    let briefDelivered = false;
    let briefDeliveredAt: string | undefined;
    let briefRegistrationError: Error | null = null;
    let postBriefError: Error | null = null;
    try {
      const runResult = await options.runCleanRoomAttempt(config.runnerConfig, {
        expectedOutputDir: outputDir,
        verifyRuntimeDependencies: options.verifyRuntimeDependencies,
        onBriefDelivered: async (at) => {
          try {
            const retainedAt = await controls.onBriefDelivered(at);
            const effectiveAt = retainedAt ?? at;
            briefDelivered = true;
            briefDeliveredAt = effectiveAt;
            return effectiveAt;
          } catch (error) {
            briefRegistrationError = error instanceof Error ? error : new Error(String(error));
            throw error;
          }
        },
      });
      if (path.resolve(runResult.outputDir) !== path.resolve(outputDir)) {
        throw new Error("Clean-room runner returned an output directory outside its frozen assignment.");
      }
    } catch (error) {
      if (!briefDelivered) {
        return executorResultSchema.parse({
          kind: "not_started",
          at: now(),
          incidentCode: briefRegistrationError ? "brief_registry_persistence_failure" : "runner_failed_before_brief",
          message: error instanceof Error ? error.message : String(error),
          hardIncident: briefRegistrationError !== null,
          falsification: false,
        });
      }
      postBriefError = error instanceof Error ? error : new Error(String(error));
    }
    const retained = await retainedAttemptResult(
      outputDir,
      config.attempt.attemptId,
      config.runnerConfig.authorIdentityCommitment,
      {
        requestedModelIdentifier: config.runnerConfig.model,
        requestedServiceTier: config.runnerConfig.serviceTier,
      },
      briefDeliveredAt,
    );
    if (!postBriefError) return retained;
    const pathDrift = /output directory outside its frozen assignment/i.test(postBriefError.message);
    const falsification = retained.falsification || pathDrift || isFalsificationMessage(postBriefError.message);
    const result = executorResultSchema.parse({
      ...retained,
      hardIncident: true,
      falsification,
      incidentCode: pathDrift ? "runner_output_path_drift" : retained.incidentCode ?? "runner_threw_after_brief",
    });
    if (result.kind !== "begun") throw new Error("Post-brief retained attempt parsed as an impossible not-started result.");
    return result;
  };
}
