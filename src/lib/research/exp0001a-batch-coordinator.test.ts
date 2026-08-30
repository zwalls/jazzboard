// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import manifestJson from "../../../research/data/development-execution-manifest-v1.json";
import profileJson from "../../../research/data/development-runner-profile-v1.json";
import {
  computeEnvironmentFreezeDigest,
  computeModelFreezeDigest,
  computeTreatmentDigest,
  createExperimentFreezeReceipt,
  type ExperimentFreezeContent,
} from "./experiment-freeze";
import {
  computeActualProviderCost,
  createExp0001aBatchPlan,
  createOpaqueEvaluatorWorkItem,
  determineSafeResume,
  initializeExp0001aBatchRegistry,
  runExp0001aBatch,
  summarizeBatchDenominator,
  verifyExp0001aBatchRegistry,
  type BatchAttemptExecutor,
  type BatchExecutorResult,
  type BatchRegistry,
} from "./exp0001a-batch-coordinator";
import { hashCanonicalJson, sha256Digest } from "./provenance-crypto";

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
  outputUsdPerMillionTokens: 20,
  source: "openai-sol-pricing-2026-08-30",
} as const;

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
});

function registry(): BatchRegistry {
  return initializeExp0001aBatchRegistry(plan, "2026-08-30T23:00:01.000Z");
}

const completeArtifactPaths = [
  "attempt-bundle.json",
  "author-brief.json",
  "author-events.jsonl",
  "author-evidence-seal.json",
  "author-final.json",
  "coordinator-events.jsonl",
  "participant-tool-contract.json",
  "spectator-final-state.json",
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
    usage: { inputTokens: 10_000, cachedInputTokens: 2_000, outputTokens: 1_000 },
    artifacts: artifacts(),
    artifactRoot: "a".repeat(64),
    authorEvidenceRoot: "b".repeat(64),
    attemptBundleSha256: "c".repeat(64),
    hardIncident: false,
    falsification: false,
    incidentCode: null,
    ...overrides,
  };
}

function successfulExecutor(results: BatchExecutorResult[] = []): BatchAttemptExecutor {
  let invocation = 0;
  return async (_config, controls) => {
    const result = results[invocation++] ?? begunResult();
    if (result.kind === "begun") controls.onBriefDelivered("2026-08-30T23:00:02.000Z");
    return result;
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
      executor: successfulExecutor(),
      maxAssignments: 1,
    });
    expect(resumed.invokedAttemptIds).toEqual([plan.configs[0].attempt.attemptId]);
    expect(resumed.resume).toMatchObject({ safe: true, nextManifestPosition: 1, attemptId: plan.configs[1].attempt.attemptId });
  });

  it("counts every begun outcome in the denominator and computes retained provider cost", async () => {
    const failed = begunResult({
      outcome: "timeout",
      usage: { inputTokens: 20_000, cachedInputTokens: 5_000, outputTokens: 2_000 },
      artifacts: artifacts([
        "attempt-bundle.json",
        "author-brief.json",
        "author-events.jsonl",
        "author-final.json",
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
      computeActualProviderCost(begunResult().usage, PRICING) + computeActualProviderCost(failed.usage, PRICING),
    );
  });

  it("returns new hash-chained registries without mutating prior snapshots", async () => {
    const initial = registry();
    const initialBytes = JSON.stringify(initial);
    const result = await runExp0001aBatch({
      plan,
      registry: initial,
      mode: "execute",
      executionAuthorized: true,
      executor: successfulExecutor(),
      maxAssignments: 1,
    });

    expect(JSON.stringify(initial)).toBe(initialBytes);
    expect(result.registry.events).toHaveLength(initial.events.length + 2);
    expect(result.registry.events.slice(0, initial.events.length)).toEqual(initial.events);
    expect(result.registry.registryDigest).not.toBe(initial.registryDigest);

    const tampered = structuredClone(result.registry);
    tampered.events[0].attemptId = "attempt-tampered";
    expect(() => verifyExp0001aBatchRegistry(tampered, plan)).toThrow(/digest|assignment/i);
  });

  it("refuses overwrite and retains duplicate or missing artifact failures before stopping", async () => {
    const executor = vi.fn(successfulExecutor());
    await expect(runExp0001aBatch({
      plan,
      registry: registry(),
      mode: "execute",
      executionAuthorized: true,
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
      executor: async (_config, controls) => {
        controls.onBriefDelivered("2026-08-30T23:00:02.000Z");
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
    expect(() => createExp0001aBatchPlan({ executionFreeze: drifted, livePreflight: PREFLIGHT, pricing: PRICING }))
      .toThrow(/randomization schedule digest drifted/);
  });
});
