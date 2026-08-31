// @vitest-environment node

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import manifestJson from "../../../research/data/development-execution-manifest-v1.json";
import {
  computeExp0001aPreferenceMappingDigest,
  EXP0001A_REQUIRED_ARTIFACT_FIELDS,
  type Exp0001aAnalysisInput,
  type Exp0001aAttemptAnalysis,
  type Exp0001aExperimentSpendAccounting,
} from "./exp0001a-analysis";
import {
  createExp0001aAnalysisRuntime,
  verifyExp0001aAnalysisCompletionSeal,
} from "./exp0001a-analysis-runtime";
import {
  createSyntheticExp0001aAnalysisRuntimeForTesting,
  syntheticExp0001aAnalysisCompletionSealSchema,
} from "./exp0001a-analysis-runtime.synthetic-test-helper";
import type { Exp0001aBatchPlan } from "./exp0001a-batch-coordinator";
import { canonicalJson, hashCanonicalJson } from "./provenance-crypto";

function digest(value: unknown): string {
  return hashCanonicalJson(value);
}

function observedCategory(maximumCalls: number, selectedCalls: number) {
  return {
    maximumCalls,
    selectedCalls,
    begunCalls: selectedCalls,
    notBegunSelectedCalls: 0,
    observedUsageReceipts: selectedCalls,
    attestedNoProviderCallSettlements: 0,
    unsettledOrUnobservableBegunCalls: 0,
    observedUsage: {
      inputTokens: 0,
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    observedCostUsd: 0,
    conservativeReservedCostUsd: 0,
    accountedCostUsd: 0,
    unobservableReasonCounts: {},
    status: selectedCalls === 0 ? "unobservable" as const : "complete" as const,
  };
}

function spendAccounting(): Exp0001aExperimentSpendAccounting {
  const authors = observedCategory(48, 48);
  const primaryReviews = observedCategory(96, 96);
  const adjudications = observedCategory(48, 0);
  const pairwisePreferences = observedCategory(24, 24);
  return {
    policy: "observed-provider-receipts-plus-frozen-cap-for-every-begun-call-without-usage",
    preProviderCumulativeInputHardCapEnforced: true,
    authorLongContextPricing: {
      thresholdInputTokensPerTurn: 272000,
      inputRateMultiplier: 2,
      outputRateMultiplier: 1.5,
      observedCostBasis: "sum-of-retained-per-turn-usage-with-threshold-pricing",
    },
    authorizedMaximumUsd: 100,
    authorizationReceiptDigest: digest("analysis-spend-authorization"),
    remainingAuthorizedExposureUsd: 100,
    spendLedgerRoot: digest("analysis-spend-ledger"),
    spendExternalAnchorRoot: digest("analysis-spend-external-anchor"),
    spendExternalAnchorCount: 168,
    authors,
    primaryReviews,
    adjudications,
    pairwisePreferences,
    total: {
      maximumCalls: 216,
      selectedCalls: 168,
      begunCalls: 168,
      notBegunSelectedCalls: 0,
      observedUsageReceipts: 168,
      attestedNoProviderCallSettlements: 0,
      unsettledOrUnobservableBegunCalls: 0,
      observedUsage: {
        inputTokens: 0,
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      },
      observedCostUsd: 0,
      conservativeReservedCostUsd: 0,
      accountedCostUsd: 0,
      unobservableReasonCounts: {},
      status: "complete",
    },
  };
}

function artifactFields(attemptId: string): Exp0001aAttemptAnalysis["artifactFields"] {
  return EXP0001A_REQUIRED_ARTIFACT_FIELDS.map((fieldId) => ({
    fieldId,
    status: "observed" as const,
    evidenceDigest: digest({ attemptId, fieldId }),
    reason: null,
  }));
}

const observedScorerIdentity = {
  status: "observed" as const,
  requestedModelIdentifier: "gpt-5.6-sol" as const,
  requestedServiceTier: "default" as const,
  observedModelIdentifier: "gpt-5.6-sol-2026-08-30",
  observedServiceTier: "default",
  requestedAliasExactMatch: false,
};

function analysisInput(): Exp0001aAnalysisInput {
  const attempts = manifestJson.assignments.flatMap((assignment) => assignment.attempts.map((attempt) => ({
    attemptId: attempt.attemptId,
    pairId: assignment.pairId,
    taskId: assignment.taskId,
    taskFamily: assignment.taskFamily as "architecture" | "drawing",
    stratum: assignment.stratum as "creation" | "editing" | "stress",
    opaqueLabel: attempt.opaqueLabel as "A0" | "A1",
    orderIndex: attempt.orderIndex as 0 | 1,
    timeBlock: assignment.timeBlock,
    treatmentDigest: attempt.treatmentDigest,
    executorOutcome: "completed" as const,
    retainedStatus: "completed" as const,
    authorOutcome: "completed" as const,
    incidents: [],
    providerIdentity: {
      provider: "openai_responses" as const,
      requestedModelIdentifier: "gpt-5.6-sol",
      requestedServiceTier: "default" as const,
      immutableModelSnapshotVerified: false as const,
      completedTurns: 1,
      status: "observed" as const,
      observedModelIdentifiers: ["gpt-5.6-sol-2026-08-30"],
      observedServiceTiers: ["default"],
      requestedAliasExactMatch: false,
    },
    accepted: true,
    reviewAccepted: true,
    primaryFailureClass: "SUCCESS" as const,
    mechanismTags: [],
    primaryReviews: [
      {
        reviewerId: "reviewer-one",
        measurementRole: "measurement" as const,
        providerIdentity: observedScorerIdentity,
        status: "scored" as const,
        accepted: true,
        primaryFailureClass: "SUCCESS" as const,
        failureCode: null,
      },
      {
        reviewerId: "reviewer-two",
        measurementRole: "standard" as const,
        providerIdentity: observedScorerIdentity,
        status: "scored" as const,
        accepted: true,
        primaryFailureClass: "SUCCESS" as const,
        failureCode: null,
      },
    ] as Exp0001aAttemptAnalysis["primaryReviews"],
    adjudication: null,
    artifactFields: artifactFields(attempt.attemptId),
    resources: {
      latencyMs: { status: "observed" as const, value: 1_000, reason: null },
      tokens: { status: "observed" as const, value: 10_000, reason: null },
      toolCalls: { status: "observed" as const, value: 10, reason: null },
      costUsd: { status: "observed" as const, value: 0.5, reason: null },
    },
  })));
  const preferences = manifestJson.assignments.map((assignment) => {
    const [left, right] = assignment.attempts;
    const content = {
      pairId: assignment.pairId,
      leftAttemptId: left.attemptId,
      rightAttemptId: right.attemptId,
      leftOpaqueLabel: left.opaqueLabel as "A0" | "A1",
      rightOpaqueLabel: right.opaqueLabel as "A0" | "A1",
      outcome: "tie" as const,
      failureCode: null,
      providerIdentity: observedScorerIdentity,
    };
    return { ...content, mappingDigest: computeExp0001aPreferenceMappingDigest(content) };
  });
  return {
    schemaVersion: 1,
    kind: "exp-0001a-normalized-analysis-input",
    protocolId: "EXP-0001A",
    sourceRoots: {
      manifestDigest: manifestJson.manifestDigest,
      batchPlanDigest: digest("analysis-batch-plan"),
      batchRegistryDigest: digest("analysis-batch-registry"),
      perAttemptAliasVerificationRoot: digest("analysis-alias-receipts"),
      registryBridgeReceiptDigest: digest("analysis-bridge"),
      attemptRegistryRoot: digest("analysis-attempt-registry"),
      reviewPlanRoot: digest("analysis-review-plan"),
      reviewLedgerRoot: digest("analysis-review-ledger"),
      classificationRoot: digest("analysis-classification"),
      pairwisePlanRoot: digest("analysis-pairwise-plan"),
      pairwisePreferenceRoot: digest("analysis-pairwise-ledger"),
      pairwisePreferenceSealRoot: digest("analysis-pairwise-seal"),
      unblindedPairwiseReportRoot: digest("analysis-unblinded-report"),
      attemptMetricsRoot: digest("analysis-attempt-metrics"),
      spendLedgerRoot: digest("analysis-spend-ledger"),
      spendExternalAnchorRoot: digest("analysis-spend-external-anchor"),
      artifactCompletenessRoot: digest("analysis-artifact-completeness"),
      failureTaxonomyDigest: digest("analysis-taxonomy"),
    },
    manifest: structuredClone(manifestJson),
    attempts,
    preferences,
    experimentSpendAccounting: spendAccounting(),
  };
}

const reviewCompletedAt = "2026-08-30T20:00:00.000Z";
const metricsSealedAt = "2026-08-30T20:01:00.000Z";
const analysisCompletedAt = "2026-08-30T20:02:00.000Z";

function testingRuntime(outputRoot: string) {
  return createSyntheticExp0001aAnalysisRuntimeForTesting({
    outputRoot,
    fixture: analysisInput(),
    reviewCompletedAt,
    attemptMetricsSealedAt: metricsSealedAt,
    now: () => analysisCompletedAt,
  });
}

describe("standalone immutable EXP-0001A analysis finalization runtime", () => {
  it("exercises crash-safe mechanics only through a distinctly synthetic completion kind", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "exp0001a-analysis-runtime-"));
    const outputRoot = path.join(parent, "analysis-finalization");
    const fetchSpy = vi.fn(async () => { throw new Error("analysis must never call a provider"); });
    vi.stubGlobal("fetch", fetchSpy);

    const first = testingRuntime(outputRoot);
    expect(await first.advance()).toMatchObject({
      status: "in_progress",
      retainedArtifacts: ["00-synthetic-analysis-input.json"],
    });

    const resumed = testingRuntime(outputRoot);
    const seal = await resumed.run();
    expect(seal).toMatchObject({
      kind: "synthetic_analysis_complete",
      syntheticOnly: true,
      analysisCompletedAt,
      reviewCompletedAt,
      attemptMetricsSealedAt: metricsSealedAt,
    });
    expect((await resumed.read()).status).toBe("synthetic_analysis_complete");
    expect(await readdir(outputRoot)).toEqual([
      "00-synthetic-analysis-input.json",
      "01-synthetic-analysis-report.json",
      "02-synthetic-failure-taxonomy.json",
      "03-synthetic-scorer-judge-validation.json",
      "04-synthetic-sample-plan.json",
      "05-synthetic-analysis-completion-seal.json",
    ]);
    for (const fileName of await readdir(outputRoot)) {
      expect((await lstat(path.join(outputRoot, fileName))).mode & 0o777).toBe(0o600);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects ordinary tampering and a self-consistently rehashed report rewrite on resume", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "exp0001a-analysis-tamper-"));
    const inputTamperRoot = path.join(parent, "input-tamper");
    const partial = testingRuntime(inputTamperRoot);
    await partial.advance();
    await writeFile(partial.artifactPaths.analysisInput, "{}", { encoding: "utf8", mode: 0o600 });
    await expect(testingRuntime(inputTamperRoot).run()).rejects.toThrow(/tampered or rewritten/);

    const reportTamperRoot = path.join(parent, "report-tamper");
    const completed = testingRuntime(reportTamperRoot);
    await completed.run();
    const report = JSON.parse(await readFile(completed.artifactPaths.analysisReport, "utf8"));
    report.fixtureDigest = digest("self-consistent-forged-synthetic-fixture");
    const { artifactRoot: _ignored, ...reportContent } = report;
    void _ignored;
    report.artifactRoot = hashCanonicalJson(reportContent);
    await writeFile(completed.artifactPaths.analysisReport, canonicalJson(report), "utf8");
    await expect(completed.read()).rejects.toThrow(/tampered or rewritten/);
  });

  it("rejects unexpected files, sequence gaps, unsafe permissions, and sealed-test paths", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "exp0001a-analysis-adversarial-"));
    const extraRoot = path.join(parent, "extra");
    const withExtra = testingRuntime(extraRoot);
    await withExtra.advance();
    await writeFile(path.join(extraRoot, "unexpected.json"), "{}", { encoding: "utf8", mode: 0o600 });
    await expect(withExtra.read()).rejects.toThrow(/Unexpected synthetic analysis artifact/);

    const gapRoot = path.join(parent, "gap");
    await mkdir(gapRoot, { mode: 0o700 });
    await writeFile(path.join(gapRoot, "01-synthetic-analysis-report.json"), "{}", { encoding: "utf8", mode: 0o600 });
    await expect(testingRuntime(gapRoot).read()).rejects.toThrow(/sequence has a gap/);

    const permissionsRoot = path.join(parent, "permissions");
    const unsafe = testingRuntime(permissionsRoot);
    await unsafe.advance();
    await chmod(unsafe.artifactPaths.analysisInput, 0o644);
    await expect(unsafe.read()).rejects.toThrow(/private, singly linked/);

    expect(() => testingRuntime(path.join(parent, "sealed-test", "analysis")))
      .toThrow(/forbidden from accessing sealed-test data/);
  });

  it("refuses missing production evidence without creating or contacting anything", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "exp0001a-analysis-missing-source-"));
    const missingRoot = path.join(parent, "missing");
    const external = {
      batchPlanDigest: digest("missing-plan"),
      reviewPhaseReceiptDigest: digest("missing-review"),
      attemptMetricsBindingRoot: digest("missing-metrics-binding"),
      attemptMetricsAuthorizationReceiptDigest: digest("missing-metrics-authorization"),
      attemptMetricsRegistryRoot: digest("missing-metrics-registry"),
      attemptMetricsCompletionSealDigest: digest("missing-metrics-seal"),
      runtimeDependencyReceiptDigest: digest("missing-runtime-dependency-receipt"),
      runtimeDependencyComponentSetRoot: digest("missing-runtime-dependency-components"),
      runtimeDependencyLaunchVerificationDurationMs: 1,
    };
    const runtime = createExp0001aAnalysisRuntime({
      outputRoot: path.join(parent, "analysis"),
      batchPlan: { planDigest: external.batchPlanDigest } as Exp0001aBatchPlan,
      externalCommitments: external,
      evidence: {
        batchRegistryFile: path.join(missingRoot, "batch-registry.json"),
        sealedAttemptRegistryFile: path.join(missingRoot, "attempt-registry.json"),
        registryBridgeReceiptFile: path.join(missingRoot, "bridge.json"),
        reviewPlanFile: path.join(missingRoot, "review-plan.json"),
        reviewReceiptFile: path.join(missingRoot, "review-receipt.json"),
        reviewAggregateDirectory: path.join(missingRoot, "review-aggregates"),
        spendLedgerDirectory: path.join(missingRoot, "spend"),
        attemptMetricsBindingFile: path.join(missingRoot, "metrics-binding.json"),
        attemptMetricsRegistryDirectory: path.join(missingRoot, "metrics"),
      },
      now: () => analysisCompletedAt,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(runtime.advance()).rejects.toThrow(/ENOENT/);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(lstat(runtime.artifactPaths.analysisInput)).rejects.toMatchObject({ code: "ENOENT" });
    vi.unstubAllGlobals();
  });

  it("refuses an analysis completion timestamp preceding either sealed prerequisite", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "exp0001a-analysis-time-order-"));
    const runtime = createSyntheticExp0001aAnalysisRuntimeForTesting({
      outputRoot: path.join(parent, "analysis"),
      fixture: analysisInput(),
      reviewCompletedAt,
      attemptMetricsSealedAt: metricsSealedAt,
      now: () => "2026-08-30T19:59:00.000Z",
    });
    await expect(runtime.advance()).rejects.toThrow(/cannot predate review completion/);
  });

  it("keeps the retained completion seal strictly self-hashed", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "exp0001a-analysis-seal-"));
    const runtime = testingRuntime(path.join(parent, "analysis"));
    const seal = await runtime.run();
    expect(syntheticExp0001aAnalysisCompletionSealSchema.parse(seal)).toEqual(seal);
    const { completionSealDigest: _ignored, ...content } = seal;
    void _ignored;
    expect(seal.completionSealDigest).toBe(hashCanonicalJson(content));
  });

  it("cannot mint a production analysis_complete seal under NODE_ENV=test", async () => {
    vi.stubEnv("NODE_ENV", "test");
    try {
      const parent = await mkdtemp(path.join(tmpdir(), "exp0001a-analysis-seam-attack-"));
      const seal = await testingRuntime(path.join(parent, "synthetic-analysis")).run();
      expect(seal.kind).toBe("synthetic_analysis_complete");
      expect(verifyExp0001aAnalysisCompletionSeal(seal)).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([expect.stringContaining("COMPLETION_SEAL_SCHEMA:kind")]),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
