// @vitest-environment node

import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import manifestJson from "../../../research/data/development-execution-manifest-v1.json";
import profileJson from "../../../research/data/development-runner-profile-v1.json";
import { createAtomicRegistryStore } from "./atomic-registry-store";
import {
  computeEnvironmentFreezeDigest,
  computeModelFreezeDigest,
  computeTreatmentDigest,
  createExperimentFreezeReceipt,
  type ExperimentFreezeContent,
} from "./experiment-freeze";
import { exp0001aAuthorIdentityCommitments } from "./exp0001a-author-identities";
import {
  computeExp0001aPerAttemptAliasReceiptDigest,
  computeExp0001aReleaseGateInvocationDigest,
  type Exp0001aPerAttemptAliasVerifier,
} from "./exp0001a-per-attempt-alias-verifier";
import {
  computeActualProviderCost,
  computeActualProviderTurnCost,
  createExp0001aBatchPlan,
  createOpaqueEvaluatorWorkItem,
  determineSafeResume,
  initializeExp0001aBatchRegistry,
  runExp0001aBatch as runExp0001aBatchProduction,
  summarizeBatchDenominator,
  verifyExp0001aBatchRegistry,
  type BatchAttemptExecutor,
  type BatchExecutorResult,
  type BatchRegistry,
} from "./exp0001a-batch-coordinator";
import { hashCanonicalJson, sha256Digest } from "./provenance-crypto";

async function runExp0001aBatch(input: Parameters<typeof runExp0001aBatchProduction>[0]) {
  if ((input.mode ?? "dry-run") !== "execute") return runExp0001aBatchProduction(input);
  if (input.registryStore) return runExp0001aBatchProduction(input);
  const root = await mkdtemp(path.join(os.tmpdir(), "exp0001a-coordinator-store-"));
  const store = createAtomicRegistryStore<BatchRegistry>({
    filePath: path.join(root, "registry.json"),
    validate: (value) => verifyExp0001aBatchRegistry(value, input.plan),
    identity: (value) => value.registryDigest,
  });
  await store.initialize(input.registry);
  try {
    return await runExp0001aBatchProduction({ ...input, registryStore: store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const PREFLIGHT = {
  batchId: "exp-0001a-batch-001",
  method: "authenticated-vercel-cli-or-api",
  authenticated: true,
  alias: "https://www.jazzboard.xyz",
  resolvedDeploymentId: "dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD",
  verifiedAt: "2026-08-30T23:00:00.000Z",
} as const;

const PRICING = {
  currency: "USD",
  inputUsdPerMillionTokens: 4,
  cachedInputUsdPerMillionTokens: 0.4,
  cacheWriteInputUsdPerMillionTokens: 5,
  outputUsdPerMillionTokens: 20,
  source: "openai-sol-pricing-2026-08-30",
} as const;
const AUTHOR_IDENTITIES = exp0001aAuthorIdentityCommitments();

function freezeReceipt() {
  const modelContent = {
    provider: "openai",
    snapshot: profileJson.model.id,
    reasoningEffort: "max",
    sampling: { temperature: null, topP: null, seed: null },
  } as const;
  const environmentContent = {
    browser: {
      name: profileJson.browser.product,
      version: profileJson.browser.version,
      buildDigest: sha256Digest("browser-build"),
    },
    host: {
      name: "local-macos-host",
      version: "frozen-host-v1",
      capabilityDigest: sha256Digest("host-capabilities"),
    },
    viewport: {
      width: profileJson.viewport.width,
      height: profileJson.viewport.height,
      deviceScaleFactor: profileJson.viewport.deviceScaleFactor,
    },
    runtime: {
      nodeVersion: "24.x",
      operatingSystem: "darwin-arm64",
      imageDigest: sha256Digest("runtime-image"),
    },
    locale: profileJson.viewport.locale,
    timezone: profileJson.viewport.timezone,
  } as const;
  const treatmentContent = {
    baselineReceiptDigest: profileJson.expectedDeployment.baselineReceiptDigest,
    buildDigest: profileJson.expectedDeployment.buildIdentityDigest,
    harnessDigest: sha256Digest("clean-room-runner"),
    systemInstructionsDigest: sha256Digest("author-system-instructions"),
    toolConfigurationDigest: sha256Digest("author-tool-configuration"),
  } as const;
  const condition = (opaqueLabel: "A0" | "A1") => ({
    ...treatmentContent,
    opaqueLabel,
    treatmentDigest: computeTreatmentDigest(treatmentContent),
  });
  const content: ExperimentFreezeContent = {
    schemaVersion: 1,
    freezeId: "exp-0001a-execution-freeze-v1",
    studyKind: "aa_calibration",
    partition: "development",
    frozenAt: "2026-08-30T22:30:00.000Z",
    executionStateAtFreeze: "not_started",
    baselineReceipt: {
      receiptId: "baseline-freeze-v1",
      receiptDigest: profileJson.expectedDeployment.baselineReceiptDigest,
      gitCommit: profileJson.expectedDeployment.gitCommit,
      gitTree: profileJson.expectedDeployment.gitTree,
      deploymentId: profileJson.expectedDeployment.deploymentId,
      buildIdentityDigest: profileJson.expectedDeployment.buildIdentityDigest,
    },
    commitments: {
      protocol: { id: "EXP-0001A", digest: sha256Digest("protocol") },
      taskManifest: { id: "jazzboard-development-v1", digest: manifestJson.benchmark.bundleDigest },
      randomizationSchedule: { id: manifestJson.manifestId, digest: manifestJson.manifestDigest },
      runner: { id: "clean-room-live-runner-v1", digest: sha256Digest("runner") },
      scorerConfiguration: { id: "scorer-config-v1", digest: sha256Digest("scorer") },
      evaluatorInstructions: { id: "blinded-evaluator-v1", digest: sha256Digest("evaluator") },
      artifactSchemas: [{ id: "attempt-artifacts-v1", digest: sha256Digest("artifacts") }],
      toolInventory: { id: "baseline-webmcp-inventory-v1", digest: sha256Digest("tools") },
    },
    model: { ...modelContent, configurationDigest: computeModelFreezeDigest(modelContent) },
    environment: { ...environmentContent, configurationDigest: computeEnvironmentFreezeDigest(environmentContent) },
    budgets: {
      wallTimeMs: profileJson.budgets.wallBudgetMs,
      maxInputTokens: profileJson.budgets.inputTokenBudget,
      maxOutputTokens: profileJson.budgets.outputTokenBudget,
      maxToolCalls: profileJson.budgets.toolCallBudget,
      maxCorrectionRounds: profileJson.budgets.maxCorrectionRounds,
    },
    conditions: { first: condition("A0"), second: condition("A1") },
    sensitiveMaterialRedacted: true,
  };
  return createExperimentFreezeReceipt(content);
}

const plan = createExp0001aBatchPlan({
  executionFreeze: freezeReceipt(),
  livePreflight: PREFLIGHT,
  pricing: PRICING,
  authorIdentityCommitments: AUTHOR_IDENTITIES,
});

function registry(): BatchRegistry {
  return initializeExp0001aBatchRegistry(plan, "2026-08-30T23:00:01.000Z");
}

function rehashRegistry(
  source: BatchRegistry,
  mutate: (events: Array<Record<string, unknown>>) => void,
): BatchRegistry {
  const candidate = structuredClone(source) as unknown as Record<string, unknown> & {
    events: Array<Record<string, unknown>>;
  };
  mutate(candidate.events);
  let previousEventDigest: string | null = null;
  candidate.events.forEach((event, sequence) => {
    event.sequence = sequence;
    event.previousEventDigest = previousEventDigest;
    delete event.eventDigest;
    previousEventDigest = hashCanonicalJson(event);
    event.eventDigest = previousEventDigest;
  });
  delete candidate.registryDigest;
  candidate.registryDigest = hashCanonicalJson(candidate);
  return candidate as unknown as BatchRegistry;
}

const verifyAliasBeforeAttempt: Exp0001aPerAttemptAliasVerifier = async (expected) => {
  const content = {
    schemaVersion: "exp-0001a-per-attempt-alias-verification/v1" as const,
    protocolId: "EXP-0001A" as const,
    attemptId: expected.attemptId,
    manifestPosition: expected.manifestPosition,
    alias: "https://www.jazzboard.xyz" as const,
    expectedDeploymentId: expected.expectedDeploymentId,
    resolvedDeploymentId: expected.expectedDeploymentId,
    method: "authenticated-vercel-api-immediately-before-brief" as const,
    releaseGateRequestedAt: expected.releaseGateRequestedAt,
    releaseGateInvocationDigest: computeExp0001aReleaseGateInvocationDigest(expected),
    verifiedAt: expected.releaseGateRequestedAt,
    providerResponseDigest: sha256Digest(`alias:${expected.attemptId}:${expected.expectedDeploymentId}`),
  };
  const receipt = { ...content, receiptDigest: hashCanonicalJson(content) };
  // Exercise the public digest helper as part of every synthetic verification.
  expect(computeExp0001aPerAttemptAliasReceiptDigest(receipt)).toBe(receipt.receiptDigest);
  return receipt;
};

const completeArtifactPaths = [
  "attempt-bundle.json",
  "author-brief.json",
  "author-events.jsonl",
  "author-evidence-seal.json",
  "author-final.json",
  "author-identity-commitment.json",
  "coordinator-events.jsonl",
  "participant-tool-contract.json",
  "spectator-final-state.json",
  "spectator-final-r7.png",
  "spectator-inspection.json",
  "spectator-tool-contract.json",
];

function artifacts(paths = completeArtifactPaths) {
  return paths.map((artifactPath, index) => ({
    path: artifactPath,
    bytes: 100 + index,
    sha256: (index + 1).toString(16).padStart(64, "0"),
  }));
}

function begunResult(overrides: Partial<Extract<BatchExecutorResult, { kind: "begun" }>> = {}): Extract<BatchExecutorResult, { kind: "begun" }> {
  return {
    kind: "begun",
    finishedAt: "2026-08-30T23:00:03.000Z",
    outcome: "completed",
    usage: {
      inputTokens: 10_000,
      uncachedInputTokens: 3_000,
      cachedInputTokens: 2_000,
      cacheWriteInputTokens: 5_000,
      outputTokens: 1_000,
      reasoningOutputTokens: 250,
      totalTokens: 11_000,
    },
    usageByTurn: [{
      inputTokens: 10_000,
      uncachedInputTokens: 3_000,
      cachedInputTokens: 2_000,
      cacheWriteInputTokens: 5_000,
      outputTokens: 1_000,
      reasoningOutputTokens: 250,
      totalTokens: 11_000,
    }],
    artifacts: artifacts(),
    artifactRoot: "a".repeat(64),
    authorEvidenceRoot: "b".repeat(64),
    attemptBundleSha256: "c".repeat(64),
    authorIdentityCommitment: plan.configs[0].runnerConfig.authorIdentityCommitment,
    authorIdentityArtifactSha256: `sha256:${artifacts().find((artifact) => artifact.path === "author-identity-commitment.json")!.sha256}`,
    costObservability: "observed",
    providerEvidenceDigest: `sha256:${"d".repeat(64)}`,
    providerIdentity: {
      provider: "openai_responses",
      requestedModelIdentifier: "gpt-5.6-sol",
      requestedServiceTier: "default",
      immutableModelSnapshotVerified: false,
      completedTurns: 1,
      status: "observed",
      observedModelIdentifiers: ["gpt-5.6-sol"],
      observedServiceTiers: ["default"],
      requestedAliasExactMatch: true,
    },
    hardIncident: false,
    falsification: false,
    incidentCode: null,
    ...overrides,
  };
}

function successfulExecutor(results: BatchExecutorResult[] = []): BatchAttemptExecutor {
  let invocation = 0;
  return async (config, controls) => {
    const result = results[invocation++] ?? begunResult();
    if (result.kind === "begun") await controls.onBriefDelivered("2026-08-30T23:00:02.000Z");
    if (result.kind !== "begun") return result;
    const identityArtifact = result.artifacts.find((artifact) => artifact.path === "author-identity-commitment.json");
    return {
      ...result,
      authorIdentityCommitment: config.runnerConfig.authorIdentityCommitment,
      authorIdentityArtifactSha256: identityArtifact
        ? `sha256:${identityArtifact.sha256}`
        : result.authorIdentityArtifactSha256,
    };
  };
}

describe("trusted EXP-0001A batch coordinator", () => {
  it("binds all 48 exact configs in strict manifest and within-pair order", () => {
    const expectedOrder = [...manifestJson.assignments]
      .sort((left, right) => left.timeBlock - right.timeBlock)
      .flatMap((pair) => [...pair.attempts]
        .sort((left, right) => left.orderIndex - right.orderIndex)
        .map((attempt) => attempt.attemptId));

    expect(plan.configs).toHaveLength(48);
    expect(plan.configs.map((config) => config.attempt.attemptId)).toEqual(expectedOrder);
    expect(new Set(plan.configs.map((config) => config.configDigest)).size).toBe(48);
    expect(new Set(plan.configs.map((config) => config.treatmentConfigurationDigest)).size).toBe(1);
    expect(verifyExp0001aBatchRegistry(registry(), plan).events.slice(0, 48).map((event) => event.attemptId))
      .toEqual(expectedOrder);
  });

  it("defaults to a deterministic dry run with no executor, network, or process hook", async () => {
    const initial = registry();
    const executor = vi.fn(successfulExecutor());
    const first = await runExp0001aBatch({ plan, registry: initial, executor });
    const second = await runExp0001aBatch({ plan, registry: initial, executor });

    expect(executor).not.toHaveBeenCalled();
    expect(first.mode).toBe("dry-run");
    expect(first.registry).toEqual(initial);
    expect(first.plannedConfigs.map((config) => config.configDigest))
      .toEqual(second.plannedConfigs.map((config) => config.configDigest));
    expect(first.resume).toMatchObject({ safe: true, nextManifestPosition: 0 });
  });

  it("resumes only at the first unbegun assignment and retains pre-brief incidents as not_started", async () => {
    const notStarted: BatchExecutorResult = {
      kind: "not_started",
      at: "2026-08-30T23:00:02.000Z",
      incidentCode: "temporary_alias_preflight_error",
      message: "Authenticated alias read was temporarily unavailable.",
      hardIncident: false,
      falsification: false,
    };
    const interrupted = await runExp0001aBatch({
      plan,
      registry: registry(),
      mode: "execute",
      executionAuthorized: true,
      verifyAliasBeforeAttempt,
      executor: successfulExecutor([notStarted]),
    });
    expect(interrupted.invokedAttemptIds).toEqual([plan.configs[0].attempt.attemptId]);
    expect(interrupted.resume).toMatchObject({ safe: true, nextManifestPosition: 0, attemptId: plan.configs[0].attempt.attemptId });
    expect(summarizeBatchDenominator(interrupted.registry, plan)).toMatchObject({
      plannedAssignments: 48,
      begunAttempts: 0,
      retainedAuthorAttempts: 0,
      notStartedIncidentEvents: 1,
    });

    const resumed = await runExp0001aBatch({
      plan,
      registry: interrupted.registry,
      mode: "execute",
      executionAuthorized: true,
      verifyAliasBeforeAttempt,
      executor: successfulExecutor(),
      maxAssignments: 1,
    });
    expect(resumed.invokedAttemptIds).toEqual([plan.configs[0].attempt.attemptId]);
    expect(resumed.resume).toMatchObject({ safe: true, nextManifestPosition: 1, attemptId: plan.configs[1].attempt.attemptId });
  });

  it("counts every begun outcome in the denominator and computes retained provider cost", async () => {
    const failed = begunResult({
      outcome: "timeout",
      usage: {
        inputTokens: 20_000,
        uncachedInputTokens: 5_000,
        cachedInputTokens: 5_000,
        cacheWriteInputTokens: 10_000,
        outputTokens: 2_000,
        reasoningOutputTokens: 500,
        totalTokens: 22_000,
      },
      usageByTurn: [{
        inputTokens: 20_000,
        uncachedInputTokens: 5_000,
        cachedInputTokens: 5_000,
        cacheWriteInputTokens: 10_000,
        outputTokens: 2_000,
        reasoningOutputTokens: 500,
        totalTokens: 22_000,
      }],
      artifacts: artifacts([
        "attempt-bundle.json",
        "author-brief.json",
        "author-events.jsonl",
        "author-final.json",
        "author-identity-commitment.json",
        "coordinator-events.jsonl",
      ]),
      artifactRoot: null,
      authorEvidenceRoot: null,
      attemptBundleSha256: null,
      incidentCode: "wall_timeout",
    });
    const result = await runExp0001aBatch({
      plan,
      registry: registry(),
      mode: "execute",
      executionAuthorized: true,
      verifyAliasBeforeAttempt,
      executor: successfulExecutor([begunResult(), failed]),
      maxAssignments: 2,
    });
    const summary = summarizeBatchDenominator(result.registry, plan);

    expect(summary).toMatchObject({
      plannedAssignments: 48,
      begunAttempts: 2,
      retainedAuthorAttempts: 2,
      completedAttempts: 1,
      failedAttempts: 1,
      unresolvedBegunAttempts: 0,
      remainingUnbegunAssignments: 46,
      knownCostAttempts: 2,
    });
    expect(summary.actualCostUsd).toBe(
      computeActualProviderTurnCost(begunResult().usageByTurn, PRICING)
        + computeActualProviderTurnCost(failed.usageByTurn, PRICING),
    );
    expect(computeActualProviderCost(begunResult().usage, PRICING)).toBe(0.0578);
    expect(() => computeActualProviderCost({
      ...begunResult().usage,
      cacheWriteInputTokens: 4_999,
    }, PRICING)).toThrow(/reconcile/i);
  });

  it("requires exactly one final spectator PNG for every completed attempt", async () => {
    for (const completedArtifacts of [
      artifacts(completeArtifactPaths.filter((item) => !item.startsWith("spectator-final-r"))),
      artifacts([...completeArtifactPaths, "spectator-final-r8.png"]),
    ]) {
      const result = await runExp0001aBatch({
        plan,
        registry: registry(),
        mode: "execute",
        executionAuthorized: true,
        verifyAliasBeforeAttempt,
        executor: successfulExecutor([begunResult({ artifacts: completedArtifacts })]),
        maxAssignments: 1,
      });
      const retained = result.registry.events.find((event) => event.kind === "attempt_retained");
      expect(retained).toMatchObject({
        kind: "attempt_retained",
        data: {
          retainedOutcome: "infra_failure",
          evidenceComplete: false,
          missingArtifacts: ["spectator-final-r<revision>.png"],
        },
      });
      expect(result.registry.events.at(-1)?.kind).toBe("hard_stop");
    }
  });

  it("returns new hash-chained registries without mutating prior snapshots", async () => {
    const initial = registry();
    const initialBytes = JSON.stringify(initial);
    const persisted: Array<{ cause: string; registry: BatchRegistry }> = [];
    const result = await runExp0001aBatch({
      plan,
      registry: initial,
      mode: "execute",
      executionAuthorized: true,
      verifyAliasBeforeAttempt,
      executor: successfulExecutor(),
      maxAssignments: 1,
      afterRegistryPersisted: async (next, cause) => {
        await Promise.resolve();
        persisted.push({ cause, registry: structuredClone(next) });
      },
    });

    expect(JSON.stringify(initial)).toBe(initialBytes);
    expect(result.registry.events).toHaveLength(initial.events.length + 3);
    expect(result.registry.events.slice(0, initial.events.length)).toEqual(initial.events);
    expect(result.registry.registryDigest).not.toBe(initial.registryDigest);
    expect(persisted.map((item) => item.cause)).toEqual([
      `alias_verified:${plan.configs[0].attempt.attemptId}`,
      `brief_delivered:${plan.configs[0].attempt.attemptId}`,
      `attempt_retained:${plan.configs[0].attempt.attemptId}`,
    ]);
    expect(persisted.map((item) => item.registry.events.length)).toEqual([49, 50, 51]);
    for (const item of persisted) expect(verifyExp0001aBatchRegistry(item.registry, plan)).toEqual(item.registry);

    const tampered = structuredClone(result.registry);
    tampered.events[0].attemptId = "attempt-tampered";
    expect(() => verifyExp0001aBatchRegistry(tampered, plan)).toThrow(/digest|assignment/i);
  });

  it("performs the one authoritative alias check inside the exact brief-release gate", async () => {
    const order: string[] = [];
    const aliasVerifier = vi.fn(async (expected: Parameters<Exp0001aPerAttemptAliasVerifier>[0]) => {
      order.push("alias-verifier");
      return verifyAliasBeforeAttempt(expected);
    });
    const result = await runExp0001aBatch({
      plan,
      registry: registry(),
      mode: "execute",
      executionAuthorized: true,
      verifyAliasBeforeAttempt: aliasVerifier,
      maxAssignments: 1,
      executor: async (config, controls) => {
        order.push("runner-pre-gate");
        const effectiveAt = await controls.onBriefDelivered("2026-08-30T23:00:02.000Z");
        order.push("runner-post-gate");
        expect(effectiveAt).toBe("2026-08-30T23:00:02.000Z");
        const identity = artifacts().find((artifact) => artifact.path === "author-identity-commitment.json")!;
        return begunResult({
          authorIdentityCommitment: config.runnerConfig.authorIdentityCommitment,
          authorIdentityArtifactSha256: `sha256:${identity.sha256}`,
        });
      },
    });
    expect(order).toEqual(["runner-pre-gate", "alias-verifier", "runner-post-gate"]);
    expect(aliasVerifier).toHaveBeenCalledTimes(1);
    const alias = result.registry.events.find((event) => event.kind === "alias_verified");
    const brief = result.registry.events.find((event) => event.kind === "brief_delivered");
    expect(alias).toMatchObject({
      kind: "alias_verified",
      data: { receipt: { releaseGateRequestedAt: "2026-08-30T23:00:02.000Z" } },
    });
    expect(brief?.at).toBe(alias?.at);
  });

  it("rejects self-consistent forged author lifecycle order, timestamps, and extra events", async () => {
    const completed = await runExp0001aBatch({
      plan,
      registry: registry(),
      mode: "execute",
      executionAuthorized: true,
      verifyAliasBeforeAttempt,
      executor: successfulExecutor(),
      maxAssignments: 1,
    });
    const attemptId = plan.configs[0].attempt.attemptId;
    const lifecycleStart = completed.registry.events.findIndex((event) => (
      event.attemptId === attemptId && event.kind === "alias_verified"
    ));
    expect(lifecycleStart).toBe(48);

    const retainedBeforeAlias = rehashRegistry(completed.registry, (events) => {
      const lifecycle = events.splice(lifecycleStart, 3);
      events.splice(lifecycleStart, 0, lifecycle[2], lifecycle[0], lifecycle[1]);
    });
    expect(() => verifyExp0001aBatchRegistry(retainedBeforeAlias, plan)).toThrow(/lifecycle|retained without brief|alias receipt/i);

    const retainedBeforeBriefTime = rehashRegistry(completed.registry, (events) => {
      events[lifecycleStart + 2].at = "2026-08-30T23:00:01.900Z";
    });
    expect(() => verifyExp0001aBatchRegistry(retainedBeforeBriefTime, plan)).toThrow(/retained before/i);

    const extraAfterRetention = rehashRegistry(completed.registry, (events) => {
      events.splice(lifecycleStart + 3, 0, {
        schemaVersion: 1,
        sequence: 0,
        at: "2026-08-30T23:00:04.000Z",
        previousEventDigest: null,
        eventDigest: sha256Digest("placeholder-event"),
        kind: "not_started",
        attemptId,
        data: {
          incidentCode: "forged_post_retention_incident",
          message: "This self-consistent extra event must not be accepted.",
          hardIncident: false,
          falsification: false,
        },
      });
    });
    expect(() => verifyExp0001aBatchRegistry(extraAfterRetention, plan)).toThrow(/lifecycle/i);

    const wrongBriefDigest = rehashRegistry(completed.registry, (events) => {
      const brief = events[lifecycleStart + 1];
      brief.data = { briefDigest: sha256Digest("different-author-brief") };
    });
    expect(() => verifyExp0001aBatchRegistry(wrongBriefDigest, plan)).toThrow(/brief digest/i);

    const forgedUnknownAttempt = rehashRegistry(completed.registry, (events) => {
      events[lifecycleStart].attemptId = "attempt-not-in-frozen-manifest";
    });
    expect(() => verifyExp0001aBatchRegistry(forgedUnknownAttempt, plan)).toThrow(/unknown attempt/i);
  });

  it("never marks a brief delivered when durable registry persistence fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exp0001a-coordinator-failure-store-"));
    const registryFile = path.join(root, "registry.json");
    const lockFile = `${registryFile}.lock`;
    const initial = registry();
    const store = createAtomicRegistryStore<BatchRegistry>({
      filePath: registryFile,
      validate: (value) => verifyExp0001aBatchRegistry(value, plan),
      identity: (value) => value.registryDigest,
    });
    await store.initialize(initial);
    const causes: string[] = [];
    let result;
    try {
      result = await runExp0001aBatchProduction({
        plan,
        registry: initial,
        mode: "execute",
        executionAuthorized: true,
        verifyAliasBeforeAttempt,
        registryStore: store,
        executor: async (_config, controls) => {
          try {
            await controls.onBriefDelivered("2026-08-30T23:01:00.000Z");
          } catch (error) {
            await unlink(lockFile);
            throw error;
          }
          return begunResult();
        },
        maxAssignments: 1,
        afterRegistryPersisted: async (_next, cause) => {
          causes.push(cause);
          if (cause.startsWith("alias_verified:")) await writeFile(lockFile, "forced persistence collision");
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(result.registry.events.some((event) => event.kind === "brief_delivered")).toBe(false);
    expect(result.registry.events.find((event) => event.kind === "not_started")).toMatchObject({
      kind: "not_started",
      data: {
        incidentCode: "brief_registry_persistence_failure",
        hardIncident: true,
        falsification: false,
      },
    });
    expect(result.registry.events.at(-1)).toMatchObject({
      kind: "hard_stop",
      data: { reason: "brief_registry_persistence_failure" },
    });
    expect(causes).toEqual([
      `alias_verified:${plan.configs[0].attempt.attemptId}`,
      `not_started:${plan.configs[0].attempt.attemptId}`,
      `hard_stop:${plan.configs[0].attempt.attemptId}`,
    ]);
  });

  it("refuses overwrite and retains duplicate or missing artifact failures before stopping", async () => {
    const executor = vi.fn(successfulExecutor());
    await expect(runExp0001aBatch({
      plan,
      registry: registry(),
      mode: "execute",
      executionAuthorized: true,
      verifyAliasBeforeAttempt,
      executor,
      existingArtifactPaths: { [plan.configs[0].attempt.attemptId]: ["attempt-bundle.json"] },
    })).rejects.toThrow(/overwrite existing artifacts/);
    expect(executor).not.toHaveBeenCalled();

    const duplicateArtifacts = artifacts(completeArtifactPaths.filter((item) => item !== "spectator-tool-contract.json"));
    duplicateArtifacts.push(structuredClone(duplicateArtifacts[0]));
    const retainedFailure = await runExp0001aBatch({
      plan,
      registry: registry(),
      mode: "execute",
      executionAuthorized: true,
      verifyAliasBeforeAttempt,
      executor: successfulExecutor([begunResult({ artifacts: duplicateArtifacts })]),
      maxAssignments: 1,
    });
    const retained = retainedFailure.registry.events.find((event) => event.kind === "attempt_retained");
    expect(retained).toMatchObject({
      kind: "attempt_retained",
      data: {
        executorOutcome: "completed",
        retainedOutcome: "infra_failure",
        evidenceComplete: false,
        hardIncident: true,
        missingArtifacts: ["spectator-tool-contract.json"],
        duplicateArtifactPaths: ["attempt-bundle.json"],
      },
    });
    expect(retainedFailure.registry.events.at(-1)?.kind).toBe("hard_stop");
    expect(retainedFailure.resume).toMatchObject({ safe: false, reason: "BATCH_HARD_STOPPED" });
    expect(summarizeBatchDenominator(retainedFailure.registry, plan)).toMatchObject({ begunAttempts: 1, failedAttempts: 1 });
  });

  it("retains executor failure after brief delivery and forbids unsafe resume", async () => {
    const result = await runExp0001aBatch({
      plan,
      registry: registry(),
      mode: "execute",
      executionAuthorized: true,
      verifyAliasBeforeAttempt,
      executor: async (_config, controls) => {
        await controls.onBriefDelivered("2026-08-30T23:00:02.000Z");
        throw new Error("runner process disappeared");
      },
    });
    const retained = result.registry.events.find((event) => event.kind === "attempt_retained");

    expect(retained).toMatchObject({
      kind: "attempt_retained",
      data: {
        executorOutcome: "executor_threw",
        retainedOutcome: "infra_failure",
        usage: null,
        actualCostUsd: null,
        evidenceComplete: false,
      },
    });
    expect(summarizeBatchDenominator(result.registry, plan)).toMatchObject({
      begunAttempts: 1,
      retainedAuthorAttempts: 1,
      failedAttempts: 1,
      knownCostAttempts: 0,
    });
    expect(determineSafeResume(result.registry, plan)).toMatchObject({ safe: false, reason: "BATCH_HARD_STOPPED" });
  });

  it("stops immediately on pre-brief falsification without adding an author denominator", async () => {
    const result = await runExp0001aBatch({
      plan,
      registry: registry(),
      mode: "execute",
      executionAuthorized: true,
      verifyAliasBeforeAttempt,
      executor: successfulExecutor([{
        kind: "not_started",
        at: "2026-08-30T23:00:02.000Z",
        incidentCode: "contract_hash_drift",
        message: "Participant contract did not match the freeze.",
        hardIncident: true,
        falsification: true,
      }]),
    });

    expect(result.registry.events.slice(-2).map((event) => event.kind)).toEqual(["not_started", "hard_stop"]);
    expect(summarizeBatchDenominator(result.registry, plan)).toMatchObject({
      begunAttempts: 0,
      retainedAuthorAttempts: 0,
      notStartedIncidentEvents: 1,
    });
  });

  it("emits evaluator configs with opaque staging identity and no assignment label metadata", async () => {
    const completed = await runExp0001aBatch({
      plan,
      registry: registry(),
      mode: "execute",
      executionAuthorized: true,
      verifyAliasBeforeAttempt,
      executor: successfulExecutor(),
      maxAssignments: 1,
    });
    const attempt = plan.configs[0].attempt;
    const workItem = createOpaqueEvaluatorWorkItem(completed.registry, plan, attempt.attemptId, {
      stagingRoot: "/private/tmp/exp0001a-opaque-evidence",
      reviewerId: "reviewer-opaque-001",
      reviewerRole: "primary",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      inputTokenBudget: 100_000,
      outputTokenBudget: 12_000,
      pricing: PRICING,
    });
    const config = workItem.evaluatorConfig as Record<string, unknown>;
    const serialized = JSON.stringify(config);

    expect(Object.keys(config)).not.toEqual(expect.arrayContaining(["attemptId", "opaqueLabel", "pairId", "orderIndex", "timeBlock", "condition"]));
    expect(serialized).not.toContain(attempt.attemptId);
    expect(Object.values(config)).not.toContain(attempt.opaqueLabel);
    expect(config.attemptDirectory).toMatch(/\/artifact-[a-f0-9]{32}$/);
    expect(config.expectedAuthorIdentityCommitment).toBe(plan.configs[0].runnerConfig.authorIdentityCommitment);
    expect(config.expectedAuthorIdentityArtifactSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(workItem.workItemDigest).toBe(hashCanonicalJson(Object.fromEntries(
      Object.entries(workItem).filter(([key]) => key !== "workItemDigest"),
    )));
  });

  it("rejects execution-freeze identity, schedule, and budget drift before planning", () => {
    const drifted = structuredClone(freezeReceipt());
    drifted.commitments.randomizationSchedule.digest = sha256Digest("wrong-schedule");
    drifted.freezeDigest = hashCanonicalJson(Object.fromEntries(
      Object.entries(drifted).filter(([key]) => key !== "freezeDigest"),
    ));
    expect(() => createExp0001aBatchPlan({
      executionFreeze: drifted,
      livePreflight: PREFLIGHT,
      pricing: PRICING,
      authorIdentityCommitments: AUTHOR_IDENTITIES,
    }))
      .toThrow(/randomization schedule digest drifted/);
  });

  it("requires an exact, unique trusted author identity map and binds it into every config", () => {
    const entries = Object.entries(AUTHOR_IDENTITIES);
    const [firstAttemptId, firstCommitment] = entries[0];
    const [secondAttemptId, secondCommitment] = entries[1];
    expect(plan.configs[0].runnerConfig.authorIdentityCommitment).toBe(AUTHOR_IDENTITIES[plan.configs[0].attempt.attemptId]);
    expect(plan.authorIdentityCommitmentsDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const missing = Object.fromEntries(entries.slice(1));
    expect(() => createExp0001aBatchPlan({
      executionFreeze: freezeReceipt(), livePreflight: PREFLIGHT, pricing: PRICING, authorIdentityCommitments: missing,
    })).toThrow(/exact frozen attempt set/);

    const extra = { ...AUTHOR_IDENTITIES, unexpected_attempt: hashCanonicalJson("unexpected") };
    expect(() => createExp0001aBatchPlan({
      executionFreeze: freezeReceipt(), livePreflight: PREFLIGHT, pricing: PRICING, authorIdentityCommitments: extra,
    })).toThrow(/exact frozen attempt set/);

    const duplicate = { ...AUTHOR_IDENTITIES, [secondAttemptId]: firstCommitment };
    expect(() => createExp0001aBatchPlan({
      executionFreeze: freezeReceipt(), livePreflight: PREFLIGHT, pricing: PRICING, authorIdentityCommitments: duplicate,
    })).toThrow(/unique commitment/);

    const invalid = { ...AUTHOR_IDENTITIES, [firstAttemptId]: "not-a-digest" };
    expect(() => createExp0001aBatchPlan({
      executionFreeze: freezeReceipt(), livePreflight: PREFLIGHT, pricing: PRICING, authorIdentityCommitments: invalid,
    })).toThrow();

    const changed = { ...AUTHOR_IDENTITIES, [firstAttemptId]: hashCanonicalJson({ replacement: firstAttemptId }) };
    const changedPlan = createExp0001aBatchPlan({
      executionFreeze: freezeReceipt(), livePreflight: PREFLIGHT, pricing: PRICING, authorIdentityCommitments: changed,
    });
    expect(changedPlan.configs[0].configDigest).not.toBe(plan.configs[0].configDigest);
    expect(changedPlan.planDigest).not.toBe(plan.planDigest);
    expect(firstCommitment).not.toBe(secondCommitment);
  });
});
