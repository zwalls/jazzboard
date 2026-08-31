// @vitest-environment node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import manifestJson from "../../../research/data/development-execution-manifest-v1.json";
import freezeJson from "../../../research/data/exp-0001a-prebrief-freeze-v1.json";
import profileJson from "../../../research/data/development-runner-profile-v1.json";
import {
  EXP0001A_PREBRIEF_FREEZE,
  assertExp0001aExecutionReady,
  computeExp0001aPrebriefFreezeDigest,
  exp0001aPrebriefFreezeSchema,
  priceUsage,
  verifyExp0001aPrebriefFreeze,
  type Exp0001aPrebriefFreeze,
} from "./exp0001a-prebrief-freeze";
import { EXP0001A_AUTHOR_SESSION_IDENTITIES } from "./exp0001a-author-identities";
import { computePairwiseReviewerRosterRoot } from "./pairwise-visual-preference";
import { hashCanonicalJson } from "./provenance-crypto";

function rawFileDigest(path: string): string {
  try {
    return `sha256:${createHash("sha256").update(readFileSync(join(process.cwd(), path))).digest("hex")}`;
  } catch {
    return "missing";
  }
}

function rehash(input: typeof freezeJson): typeof freezeJson {
  const content = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "freezeDigest"));
  return { ...input, freezeDigest: hashCanonicalJson(content) };
}

describe("EXP-0001A pre-brief freeze", () => {
  it("strictly validates its canonical self-hash while the one-time source digest capture remains pending", () => {
    const verification = verifyExp0001aPrebriefFreeze(freezeJson);

    expect(verification).toEqual({ ok: true, receipt: EXP0001A_PREBRIEF_FREEZE, executable: false });
    expect(computeExp0001aPrebriefFreezeDigest(EXP0001A_PREBRIEF_FREEZE)).toBe(freezeJson.freezeDigest);
    const staleSourcePaths = Object.values(freezeJson.frozenSources)
      .filter((source) => rawFileDigest(source.path) !== source.fileDigest)
      .map((source) => source.path);
    expect(staleSourcePaths).toEqual(expect.arrayContaining([
      "src/lib/research/exp0001a-analysis.ts",
      "src/lib/research/exp0001a-execution-gate.ts",
      "research/scripts/exp0001a-batch-command.mjs",
      "package.json",
      "package-lock.json",
    ]));
    expect(exp0001aPrebriefFreezeSchema.safeParse({ ...freezeJson, unexpected: true }).success).toBe(false);
  });

  it("binds all 12 public tasks and the immutable 48-attempt no-rerun order", () => {
    const orderedAttemptIds = [...manifestJson.assignments]
      .sort((left, right) => left.timeBlock - right.timeBlock)
      .flatMap((pair) => [...pair.attempts]
        .sort((left, right) => left.orderIndex - right.orderIndex)
        .map((attempt) => attempt.attemptId));

    expect(orderedAttemptIds).toHaveLength(48);
    expect(new Set(orderedAttemptIds).size).toBe(48);
    expect(freezeJson.schedule.fixedOrderDigest).toBe(hashCanonicalJson(orderedAttemptIds));
    expect(freezeJson.schedule.taskCommitmentsDigest).toBe(hashCanonicalJson(manifestJson.tasks));
    expect(freezeJson.schedule.taskCommitments).toEqual(manifestJson.tasks.map(({ taskId, taskDigest }) => ({ taskId, taskDigest })));
    expect(freezeJson.schedule.rerunsPermitted).toBe(false);
    expect(freezeJson.stopRules.retainAllBegunAttempts).toBe(true);
    expect(freezeJson.stopRules.resumeOnlyAtUnbegunAssignments).toBe(true);
  });

  it("makes A0 and A1 parsed treatment configuration byte-identical without label leakage", () => {
    expect(freezeJson.conditions.A0).toEqual(freezeJson.conditions.A1);
    expect(hashCanonicalJson(freezeJson.conditions.A0)).toBe(freezeJson.conditions.configurationDigest);
    expect(freezeJson.schedule.treatmentDigest).toBe(manifestJson.treatments.A0);
    expect(manifestJson.treatments.A0).toBe(manifestJson.treatments.A1);
    expect(JSON.stringify(freezeJson.conditions)).not.toMatch(/baseline|candidate|control|treatment|conditionLabel|opaqueLabel|taskId|pairId/i);
  });

  it("uses hard author and reviewer budgets with substantial observed-v3 headroom", () => {
    const author = freezeJson.conditions.A0.authorBudgets;
    const primary = freezeJson.reviewerPlan.primaryBudget;
    const adjudicator = freezeJson.reviewerPlan.adjudicatorBudget;

    expect(author).toEqual({
      wallMs: 900_000,
      toolCalls: 120,
      perToolTimeoutMs: 30_000,
      inputTokens: 600_000,
      outputTokens: 80_000,
      perResponseOutputTokens: 20_000,
      correctionRounds: 3,
    });
    expect(profileJson.budgets.inputTokenBudget).toBe(author.inputTokens);
    expect(author.inputTokens).toBeGreaterThan(freezeJson.evidenceBasis.author.inputTokens * 1.8);
    expect(primary.inputTokens).toBeGreaterThan(freezeJson.evidenceBasis.primaryReviewer.inputTokens * 9);
    expect(primary.outputTokens).toBeGreaterThan(freezeJson.evidenceBasis.primaryReviewer.outputTokens * 9);
    expect(adjudicator).toEqual({ inputTokens: 80_000, outputTokens: 10_000, requests: 1 });
    expect(freezeJson.reviewerPlan.pairwisePreference).toMatchObject({
      pairCount: 24,
      model: { id: "gpt-5.6-sol", reasoningEffort: "high" },
      serviceTier: "default",
      budget: { inputTokens: 60_000, outputTokens: 8_000, requests: 1 },
      individualReviewerOverlap: "forbid",
      promptDistinctFromIndividualEvaluatorInstructions: true,
    });
  });

  it("accounts for uncached, cached, cache-write, output, and nested reasoning usage exactly", () => {
    expect(freezeJson.pricing.perMillionTokens).toEqual({
      uncachedInput: 4,
      cachedInput: 0.4,
      cacheWriteInput: 5,
      output: 20,
    });
    for (const usage of [freezeJson.evidenceBasis.author, freezeJson.evidenceBasis.primaryReviewer]) {
      expect(usage.inputTokens).toBe(usage.uncachedInputTokens + usage.cachedInputTokens + usage.cacheWriteInputTokens);
      expect(usage.reasoningTokens).toBeLessThanOrEqual(usage.outputTokens);
      expect(priceUsage(usage, EXP0001A_PREBRIEF_FREEZE.pricing)).toBeCloseTo(usage.estimatedCostUsd, 10);
    }
    expect(freezeJson.evidenceBasis.author.estimatedCostUsd).toBe(0.6220848);
    expect(freezeJson.evidenceBasis.primaryReviewer.estimatedCostUsd).toBe(0.043684);
  });

  it("states reproducible planning and maximum-cap cost envelopes", () => {
    const costs = freezeJson.costProjection;

    const author = freezeJson.evidenceBasis.author;
    expect(costs.longContextThresholdInputTokensPerRequest).toBe(272_000);
    expect(costs.diagnosticMaximumAuthorTurnInputTokens).toBe(56_291);
    expect(costs.diagnosticMaximumAuthorTurnInputTokens).toBeLessThan(costs.longContextThresholdInputTokensPerRequest);
    expect(costs.diagnosticLongContextSurchargeObserved).toBe(false);
    expect(costs.expectedAuthorPerAttemptUsd).toBeCloseTo(author.estimatedCostUsd, 10);
    expect(costs.expectedAuthor48Usd).toBeCloseTo(author.estimatedCostUsd * 48, 10);
    expect(costs.expectedPrimaryReviews96Usd).toBeCloseTo(freezeJson.evidenceBasis.primaryReviewer.estimatedCostUsd * 96, 10);
    expect(costs.expectedWithoutAdjudicationUsd).toBeCloseTo(costs.expectedAuthor48Usd + costs.expectedPrimaryReviews96Usd, 10);
    expect(costs.expectedWithPlanningAdjudicationsUsd).toBeCloseTo(
      costs.expectedWithoutAdjudicationUsd + freezeJson.evidenceBasis.primaryReviewer.estimatedCostUsd * costs.planningAdjudications,
      10,
    );
    expect(costs.expectedPairwisePreferences24Usd).toBeCloseTo(
      costs.expectedPairwisePreferencePerCallUsd * 24,
      10,
    );
    expect(costs.expectedTotalUsd).toBeCloseTo(
      costs.expectedWithPlanningAdjudicationsUsd + costs.expectedPairwisePreferences24Usd,
      10,
    );
    expect(costs.sensitivityOnePointFiveXTotalUsd).toBeCloseTo(
      costs.expectedTotalUsd * 1.5,
      10,
    );
    expect(costs.configuredCapTotalUsd).toBeCloseTo(
      costs.configuredCapAuthor48Usd
        + costs.configuredCapPrimaryReviews96Usd
        + costs.configuredCapAdjudication48Usd
        + costs.configuredCapPairwisePreferences24Usd,
      10,
    );
    expect(costs.preProviderCumulativeInputHardCapEnforced).toBe(true);
    expect(costs.interpretation).toBe("non-statistical planning range, not a confidence interval");
    expect(freezeJson.pricingProvenance).toEqual({
      serviceTier: "default",
      modelDocumentationUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
      fastModeGuideUrl: "https://developers.openai.com/api/docs/guides/fast-mode",
      capturedOn: "2026-08-30",
      promotionalPricingValidAtLeastThrough: "2026-11-21",
      revalidationRequiredBefore: "2026-11-22T00:00:00.000Z",
    });
  });

  it("keeps author/reviewer separation and all execution prerequisites blocked", () => {
    // The checked-in JSON is intentionally refreshed only once all moving source
    // paths settle. Type this test against the authoritative production schema so
    // additions remain compile-checked without weakening or prematurely rehashing it.
    const currentFreeze = freezeJson as unknown as Exp0001aPrebriefFreeze;
    const plan = currentFreeze.reviewerPlan;
    expect(plan.roster).toHaveLength(5);
    expect(new Set(plan.roster.map((entry) => entry.reviewerId)).size).toBe(5);
    expect(new Set(plan.roster.map((entry) => entry.identityCommitment)).size).toBe(5);
    expect(plan.primaryReviewsPerArtifact).toBe(2);
    expect(plan.minimumDistinctReviewers).toBe(3);
    expect(plan.separationPolicy).toEqual({
      authorMayReview: false,
      primaryReviewersDistinct: true,
      adjudicatorDistinctFromPrimaries: true,
      pairedArtifactVisibleBeforeLock: false,
      conditionLabelVisibleBeforeLock: false,
    });
    const pairwise = plan.pairwisePreference;
    expect(pairwise.roster).toHaveLength(24);
    expect(new Set(pairwise.roster.map((entry) => entry.reviewerId)).size).toBe(24);
    expect(new Set(pairwise.roster.map((entry) => entry.identityCommitment)).size).toBe(24);
    expect(computePairwiseReviewerRosterRoot(pairwise.roster)).toBe(pairwise.rosterRoot);
    expect(pairwise.promptDigest).toBe(currentFreeze.frozenSources.pairwisePreferenceInstructions.fileDigest);
    expect(pairwise.promptDigest).not.toBe(currentFreeze.frozenSources.evaluatorInstructions.fileDigest);
    expect(pairwise.roster.some((entry) => plan.roster.some((individual) => (
      entry.reviewerId === individual.reviewerId || entry.identityCommitment === individual.identityCommitment
    )))).toBe(false);
    expect(currentFreeze.executionGate.executable).toBe(false);
    expect(currentFreeze.briefReleaseAuthorized).toBe(false);
    expect(Object.values(currentFreeze.pendingPrerequisites).every((item) => item.status === "pending")).toBe(true);
    expect(currentFreeze.frozenSources.authorSessionIdentityManifest.manifestRoot)
      .toBe(EXP0001A_AUTHOR_SESSION_IDENTITIES.manifestRoot);
    for (const role of [
      "batchCoordinator",
      "batchCli",
      "batchCommandLibrary",
      "batchRegistryBridge",
      "cleanRoomBatchAdapter",
      "completionAttestation",
      "completionSignerCli",
      "atomicRegistryStore",
      "evaluatorRunner",
      "evaluatorSemanticEnvelopeReceipt",
      "executionAuthorityTrustAnchor",
      "launchAuthorityVerifier",
      "launchSignerCli",
      "liveReviewRunner",
      "adjudicationOrchestration",
      "attemptMetrics",
      "perAttemptAliasVerifier",
      "pairwisePreference",
      "pairwisePreferenceInstructions",
      "spendLedger",
      "runtimeComposition",
      "runtimeBundle",
      "runtimeDependencyReceipt",
      "runtimeDependencyVerifier",
      "reportCompiler",
      "experimentFreezeAdapter",
      "executionGate",
      "authorSessionIdentityManifest",
    ] as const) {
      expect(currentFreeze.pendingPrerequisites[role].path).toBe(currentFreeze.frozenSources[role].path);
      expect(currentFreeze.pendingPrerequisites[role].candidateObservedDigest).toBe(currentFreeze.frozenSources[role].fileDigest);
    }
    expect(() => assertExp0001aExecutionReady(currentFreeze)).toThrow(/execution is blocked/i);
  });

  it("keeps the local research host separate from the Vercel runtime and binds dependency resolution", () => {
    expect(freezeJson.baseline.nodeVersion).toBe("24.x");
    expect(freezeJson.executionHost).toMatchObject({
      nodeVersion: "22.22.0",
      platform: "darwin",
      architecture: "arm64",
      operatingSystem: { name: "macOS", version: "26.6.2", build: "25G83" },
      dependencyResolution: { layout: "npm-package-lock", lockfileVersion: 3 },
    });
    expect(freezeJson.executionHost.dependencyResolution.packageManifestDigest)
      .toBe(freezeJson.frozenSources.packageManifest.fileDigest);
    expect(freezeJson.executionHost.dependencyResolution.packageLockDigest)
      .toBe(freezeJson.frozenSources.packageLock.fileDigest);
    expect(freezeJson.executionHost.runtimeDependencies).toEqual({
      receiptPath: "research/data/exp0001a-runtime-dependencies-v1.json",
      receiptDigest: "sha256:624318d3717f9f26211659d6ef552f4e40585ff2a6d598a24f19a2dfdd45e1c4",
      componentSetRoot: "sha256:e17ed0ae303b9ff9d2e1e48ec76d0c88082e7f9e240c5cfada33a2aada3c32e8",
      captureVerificationDurationMs: 925,
      absolutePathsPublished: false,
      fullTreeVerification: "two-identical-captures-before-runtime-import",
      criticalVerification: "two-identical-captures-before-each-attempt-before-browser-or-brief",
    });
    expect(freezeJson.executionHost.runtimeDependencies.receiptPath)
      .toBe(freezeJson.frozenSources.runtimeDependencyReceipt.path);
  });

  it("records provider-model limits without claiming immutable weights", () => {
    expect(freezeJson.providerModelIdentityPolicy).toEqual({
      requestedModelIdFrozen: true,
      immutableWeightSnapshotAsserted: false,
      responseModelRetainedAndDriftChecked: true,
      serviceTierRetainedAndDriftChecked: true,
      rollingProviderRiskMitigation: "aa-interleaving-paired-order-balance-and-time-block-diagnostics",
      confirmatoryPreference: "use-an-immutable-dated-weight-snapshot-when-the-provider-exposes-one",
    });
  });

  it("requires a rooted exact-deployment check immediately before every brief", () => {
    expect(freezeJson.deploymentContinuityPolicy).toEqual({
      executionOrigin: freezeJson.baseline.productionUrl,
      frozenDeploymentId: freezeJson.baseline.deploymentId,
      verifierSourceRole: "perAttemptAliasVerifier",
      verificationTiming: "authenticated-vercel-api-immediately-before-each-brief",
      requiredReceiptCountAtCompletion: 48,
      receiptsHashChainedInBatchRegistry: true,
      driftDisposition: "not_started-hard-stop-before-brief",
      immutableDeploymentAlternative: "protected-immutable-url-requires-authenticated-bypass",
    });
    expect(freezeJson.frozenSources.perAttemptAliasVerifier.path)
      .toBe("src/lib/research/exp0001a-per-attempt-alias-verifier.ts");
  });

  it("detects tampering and contains neither sensitive identifiers nor nondevelopment material", () => {
    const tampered = structuredClone(freezeJson);
    tampered.conditions.A1.authorBudgets.inputTokens += 1;
    const tamperedVerification = verifyExp0001aPrebriefFreeze(rehash(tampered));

    expect(tamperedVerification.ok).toBe(false);
    if (!tamperedVerification.ok) expect(tamperedVerification.errors).toContain("AA_CONDITIONS_NOT_BYTE_IDENTICAL");
    expect(JSON.stringify(freezeJson)).not.toMatch(/sealed-test|replication-B|"(?:roomId|roomCode|sessionId|authorization|cookie|password|secret)"\s*:/i);
  });
});
