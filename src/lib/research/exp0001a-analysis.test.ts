// @vitest-environment node

import { describe, expect, it } from "vitest";

import manifestJson from "../../../research/data/development-execution-manifest-v1.json";
import {
  computeExp0001aPerAttemptAliasVerificationRoot,
  EXP0001A_REQUIRED_ARTIFACT_FIELDS,
  compileExp0001aAnalysis,
  compileExp0001aNormalizedAnalysisForTesting,
  computeExp0001aAnalysisReportDigest,
  computeExp0001aPreferenceMappingDigest,
  verifyExp0001aNormalizedAnalysisForTesting,
  type Exp0001aAnalysisInput,
  type Exp0001aAnalysisSourceContext,
  type Exp0001aAttemptAnalysis,
  type Exp0001aExperimentSpendAccounting,
  type Exp0001aPreference,
} from "./exp0001a-analysis";
import { hashCanonicalJson } from "./provenance-crypto";

function digest(value: unknown): string {
  return hashCanonicalJson(value);
}

function artifactFields(): Exp0001aAttemptAnalysis["artifactFields"] {
  return EXP0001A_REQUIRED_ARTIFACT_FIELDS.map((fieldId) => ({
    fieldId,
    status: "observed" as const,
    evidenceDigest: digest(`artifact:${fieldId}`),
    reason: null,
  }));
}

function observedScorerIdentity(model = "gpt-5.6-sol") {
  return {
    status: "observed" as const,
    requestedModelIdentifier: "gpt-5.6-sol" as const,
    requestedServiceTier: "default" as const,
    observedModelIdentifier: model,
    observedServiceTier: "default",
    requestedAliasExactMatch: model === "gpt-5.6-sol",
  };
}

function scoredReview(
  reviewerId: string,
  accepted: boolean,
  measurementRole: "measurement" | "standard" = "standard",
): Exp0001aAttemptAnalysis["primaryReviews"][number] {
  return {
    reviewerId,
    measurementRole,
    providerIdentity: observedScorerIdentity(),
    status: "scored",
    accepted,
    primaryFailureClass: accepted ? "SUCCESS" : "FAIL_SEMANTIC",
    failureCode: null,
  };
}

function preferenceFor(
  assignment: typeof manifestJson.assignments[number],
  desired: "A0" | "A1" | "tie",
): Exp0001aPreference {
  const [left, right] = assignment.attempts;
  const leftOpaqueLabel = left.opaqueLabel as "A0" | "A1";
  const rightOpaqueLabel = right.opaqueLabel as "A0" | "A1";
  const outcome = desired === "tie" ? "tie"
    : leftOpaqueLabel === desired ? "left" : "right";
  const withoutDigest = {
    pairId: assignment.pairId,
    leftAttemptId: left.attemptId,
    rightAttemptId: right.attemptId,
    leftOpaqueLabel,
    rightOpaqueLabel,
    outcome,
    failureCode: null,
    providerIdentity: observedScorerIdentity(),
  } as const;
  return {
    ...withoutDigest,
    mappingDigest: computeExp0001aPreferenceMappingDigest(withoutDigest),
  };
}

function observedSpendCategory(maximumCalls: number, selectedCalls: number, costPerCall: number) {
  return {
    maximumCalls,
    selectedCalls,
    begunCalls: selectedCalls,
    notBegunSelectedCalls: 0,
    observedUsageReceipts: selectedCalls,
    attestedNoProviderCallSettlements: 0,
    unsettledOrUnobservableBegunCalls: 0,
    observedUsage: {
      inputTokens: selectedCalls * 100,
      uncachedInputTokens: selectedCalls * 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: selectedCalls * 20,
      reasoningTokens: selectedCalls * 5,
      totalTokens: selectedCalls * 120,
    },
    observedCostUsd: selectedCalls * costPerCall,
    conservativeReservedCostUsd: 0,
    accountedCostUsd: selectedCalls * costPerCall,
    unobservableReasonCounts: {},
    status: selectedCalls === 0 ? "unobservable" as const : "complete" as const,
  };
}

function spendAccountingFixture(): Exp0001aExperimentSpendAccounting {
  const authors = observedSpendCategory(48, 48, 0.5);
  const primaryReviews = observedSpendCategory(96, 96, 0.04);
  const adjudications = observedSpendCategory(48, 0, 0.06);
  const pairwisePreferences = observedSpendCategory(24, 24, 0.07);
  const categories = [authors, primaryReviews, adjudications, pairwisePreferences];
  const observedUsage = Object.fromEntries(Object.keys(authors.observedUsage).map((key) => [
    key,
    categories.reduce((sum, category) => sum + category.observedUsage[key as keyof typeof authors.observedUsage], 0),
  ])) as typeof authors.observedUsage;
  const observedCostUsd = categories.reduce((sum, category) => sum + category.observedCostUsd, 0);
  const spendLedgerRoot = digest("spend-ledger");
  return {
    policy: "observed-provider-receipts-plus-frozen-cap-for-every-begun-call-without-usage",
    preProviderCumulativeInputHardCapEnforced: true,
    authorLongContextPricing: {
      thresholdInputTokensPerTurn: 272000,
      inputRateMultiplier: 2,
      outputRateMultiplier: 1.5,
      observedCostBasis: "sum-of-retained-per-turn-usage-with-threshold-pricing",
    },
    authorizedMaximumUsd: 487.2,
    authorizationReceiptDigest: digest("spend-authorization"),
    remainingAuthorizedExposureUsd: 487.2 - observedCostUsd,
    spendLedgerRoot,
    spendExternalAnchorRoot: digest("spend-external-anchor"),
    spendExternalAnchorCount: 168,
    authors,
    primaryReviews,
    adjudications,
    pairwisePreferences,
    total: {
      maximumCalls: categories.reduce((sum, category) => sum + category.maximumCalls, 0),
      selectedCalls: categories.reduce((sum, category) => sum + category.selectedCalls, 0),
      begunCalls: categories.reduce((sum, category) => sum + category.begunCalls, 0),
      notBegunSelectedCalls: 0,
      observedUsageReceipts: categories.reduce((sum, category) => sum + category.observedUsageReceipts, 0),
      attestedNoProviderCallSettlements: 0,
      unsettledOrUnobservableBegunCalls: 0,
      observedUsage,
      observedCostUsd,
      conservativeReservedCostUsd: 0,
      accountedCostUsd: observedCostUsd,
      unobservableReasonCounts: {},
      status: "complete",
    },
  };
}

function fixture(): Exp0001aAnalysisInput {
  const attempts = manifestJson.assignments.flatMap((assignment) => {
    const accepted = assignment.timeBlock % 2 === 0;
    return assignment.attempts.map((expected) => ({
      attemptId: expected.attemptId,
      pairId: assignment.pairId,
      taskId: assignment.taskId,
      taskFamily: assignment.taskFamily as "architecture" | "drawing",
      stratum: assignment.stratum as "creation" | "editing" | "stress",
      opaqueLabel: expected.opaqueLabel as "A0" | "A1",
      orderIndex: expected.orderIndex as 0 | 1,
      timeBlock: assignment.timeBlock,
      treatmentDigest: expected.treatmentDigest,
      executorOutcome: "completed" as const,
      retainedStatus: "completed" as const,
      authorOutcome: "completed" as const,
      incidents: [],
      providerIdentity: {
        provider: "openai_responses" as const,
        requestedModelIdentifier: "gpt-5.6-sol",
        requestedServiceTier: "default" as const,
        immutableModelSnapshotVerified: false as const,
        completedTurns: 2,
        status: "observed" as const,
        observedModelIdentifiers: ["gpt-5.6-sol"],
        observedServiceTiers: ["default"],
        requestedAliasExactMatch: true,
      },
      accepted,
      reviewAccepted: accepted,
      primaryFailureClass: accepted ? "SUCCESS" as const : "FAIL_SEMANTIC" as const,
      mechanismTags: accepted ? [] : [{ tag: "SEM_REQUIRED_ENTITY_MISSING", evidenceRefs: ["rubric:required-entity"] }],
      primaryReviews: [
        scoredReview("rvw-aa-01", accepted, "measurement"),
        scoredReview("rvw-aa-02", accepted),
      ] as Exp0001aAttemptAnalysis["primaryReviews"],
      adjudication: null,
      artifactFields: artifactFields(),
      resources: {
        latencyMs: { status: "observed" as const, value: 1_000 + assignment.timeBlock, reason: null },
        tokens: { status: "observed" as const, value: 10_000 + assignment.timeBlock, reason: null },
        toolCalls: { status: "observed" as const, value: 20 + assignment.timeBlock, reason: null },
        costUsd: { status: "observed" as const, value: 0.5 + assignment.timeBlock / 100, reason: null },
      },
    }));
  });
  const preferences = manifestJson.assignments.map((assignment) => {
    const desired = assignment.timeBlock % 3 === 0 ? "A0"
      : assignment.timeBlock % 3 === 1 ? "A1" : "tie";
    return preferenceFor(assignment, desired);
  });
  return {
    schemaVersion: 1,
    kind: "exp-0001a-normalized-analysis-input",
    protocolId: "EXP-0001A",
    sourceRoots: {
      manifestDigest: manifestJson.manifestDigest,
      batchPlanDigest: digest("batch-plan"),
      batchRegistryDigest: digest("batch-registry"),
      perAttemptAliasVerificationRoot: digest("per-attempt-alias-verification"),
      registryBridgeReceiptDigest: digest("registry-bridge-receipt"),
      attemptRegistryRoot: digest("attempt-registry"),
      reviewPlanRoot: digest("review-plan"),
      reviewLedgerRoot: digest("review-ledger"),
      classificationRoot: digest("classification"),
      pairwisePlanRoot: digest("pairwise-plan"),
      pairwisePreferenceRoot: digest("pairwise-preference"),
      pairwisePreferenceSealRoot: digest("pairwise-preference-seal"),
      unblindedPairwiseReportRoot: digest("unblinded-pairwise-report"),
      attemptMetricsRoot: digest("attempt-metrics"),
      spendLedgerRoot: digest("spend-ledger"),
      spendExternalAnchorRoot: digest("spend-external-anchor"),
      artifactCompletenessRoot: digest("artifact-completeness"),
      failureTaxonomyDigest: digest("failure-taxonomy-v1"),
    },
    manifest: structuredClone(manifestJson),
    attempts,
    preferences,
    experimentSpendAccounting: spendAccountingFixture(),
  };
}

function attemptFor(input: Exp0001aAnalysisInput, pairId: string, label: "A0" | "A1") {
  const attempt = input.attempts.find((candidate) => candidate.pairId === pairId && candidate.opaqueLabel === label);
  if (!attempt) throw new Error(`Fixture attempt missing for ${pairId}/${label}.`);
  return attempt;
}

function setDecision(attempt: Exp0001aAttemptAnalysis, accepted: boolean): void {
  attempt.accepted = accepted;
  attempt.reviewAccepted = accepted;
  attempt.primaryFailureClass = accepted ? "SUCCESS" : "FAIL_SEMANTIC";
  attempt.mechanismTags = accepted ? [] : [{ tag: "SEM_REQUIRED_ENTITY_MISSING", evidenceRefs: ["rubric:required-entity"] }];
  attempt.primaryReviews = [
    scoredReview("rvw-aa-01", accepted, "measurement"),
    scoredReview("rvw-aa-02", accepted),
  ];
  attempt.adjudication = null;
}

describe("EXP-0001A deterministic A/A analysis", () => {
  it("roots exactly one retained pre-brief alias verification per fixed attempt", () => {
    const attemptIds = [...manifestJson.assignments]
      .sort((left, right) => left.timeBlock - right.timeBlock)
      .flatMap((assignment) => [...assignment.attempts]
        .sort((left, right) => left.orderIndex - right.orderIndex)
        .map((attempt) => attempt.attemptId));
    const events = attemptIds.map((attemptId, manifestPosition) => ({
      kind: "alias_verified",
      attemptId,
      eventDigest: digest(`alias-event:${manifestPosition}`),
      data: { receipt: { receiptDigest: digest(`alias-receipt:${manifestPosition}`) } },
    }));
    const root = computeExp0001aPerAttemptAliasVerificationRoot(events, attemptIds);
    expect(root).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(computeExp0001aPerAttemptAliasVerificationRoot([...events].reverse(), attemptIds)).toBe(root);
    expect(() => computeExp0001aPerAttemptAliasVerificationRoot(events.slice(1), attemptIds))
      .toThrow("EXP0001A_PER_ATTEMPT_ALIAS_RECEIPT_DENOMINATOR_INVALID");
    expect(() => computeExp0001aPerAttemptAliasVerificationRoot([...events, events[0]], attemptIds))
      .toThrow("EXP0001A_PER_ATTEMPT_ALIAS_RECEIPT_DENOMINATOR_INVALID");
  });

  it("reconciles all 48 attempts and 24 pairs into a calibration-only hash-rooted report", () => {
    const input = fixture();
    const report = compileExp0001aNormalizedAnalysisForTesting(input);

    expect(report.purpose).toBe("calibration_only");
    expect(report.claimPolicy).toMatchObject({
      improvementClaimPermitted: false,
      equivalenceClaimPermitted: false,
    });
    expect(report.runAccounting).toMatchObject({
      plannedAttempts: 48,
      retainedAttempts: 48,
      plannedPairs: 24,
      reconciledPairs: 24,
      byLabel: { A0: 24, A1: 24 },
    });
    expect(report.pairedSuccess.overall).toMatchObject({
      pairCount: 24,
      attemptCount: 48,
      A0: { successCount: 12, denominator: 24, successRate: 0.5 },
      A1: { successCount: 12, denominator: 24, successRate: 0.5 },
      cells: { bothSuccess: 12, a0OnlySuccess: 0, a1OnlySuccess: 0, bothFail: 12 },
      absoluteDifferenceA1MinusA0: 0,
      exactPairedPValue: 1,
      exactPairedPValueRole: "descriptive_only_naive_pair_level_mcnemar",
      taskClusterSignFlip: {
        inferenceRole: "primary_investigation_decision",
        method: "exact_two_sided_complete_task_vector_sign_flip",
        taskCount: 12,
        replicatesPerTask: 2,
        permutationCount: 4096,
        exactTwoSidedPValue: 1,
        evaluation: "evaluable",
      },
    });
    expect(report.pairedSuccess.byTaskFamily.architecture.pairCount).toBe(12);
    expect(report.pairedSuccess.byTaskFamily.drawing.pairCount).toBe(12);
    expect(report.reviewerDiagnostics).toMatchObject({
      artifactCount: 48,
      primaryReviewCallCount: 96,
      primaryScorerFailureCount: 0,
      rawAgreement: 1,
      cohenKappa: 1,
      adjudicationCount: 0,
    });
    expect(report.measurementContextDiagnostics).toMatchObject({
      scope: "fixed_primary_review_calls_only",
      causalAttributionPermitted: false,
      coverage: {
        expectedMeasurementCalls: 48,
        expectedStandardCalls: 48,
        observedMeasurementCalls: 48,
        observedStandardCalls: 48,
        correctlyPositionedArtifactCount: 48,
        roleCoverageStatus: "complete",
      },
      measurement: { fixedCallCount: 48, scoredCount: 48, acceptanceCount: 24, failureCount: 0 },
      standard: { fixedCallCount: 48, scoredCount: 48, acceptanceCount: 24, failureCount: 0 },
      descriptiveAcceptanceRateDifferenceMeasurementMinusStandard: 0,
      differenceEvaluation: "evaluable",
    });
    expect(report.preferenceDiagnostics).toMatchObject({
      pairCount: 24,
      a0Wins: 8,
      a1Wins: 8,
      ties: 8,
      failedComparisons: 0,
      a1WinRateAmongNonTies: 0.5,
      exactTwoSidedSignPValue: 1,
      exactTwoSidedSignPValueRole: "descriptive_only_naive_non_tie_pair_level_sign_test",
      taskClusterSignFlip: { taskCount: 12, permutationCount: 4096, exactTwoSidedPValue: 1 },
    });
    expect(report.artifactCompleteness).toMatchObject({
      requiredCellCount: 48 * EXP0001A_REQUIRED_ARTIFACT_FIELDS.length,
      observedCellCount: 48 * EXP0001A_REQUIRED_ARTIFACT_FIELDS.length,
      unobservableCellCount: 0,
      missingCellCount: 0,
      completenessRate: 1,
    });
    expect(Object.values(report.resourceRatios).every((ratio) => ratio.medianPairedRatioA1OverA0 === 1)).toBe(true);
    expect(report.orderAndTimeDiagnostics.firstLabelCounts).toEqual({ A0: 12, A1: 12 });
    expect(report.orderAndTimeDiagnostics.blocks).toHaveLength(24);
    expect(report.alarms.triggeredCodes).toEqual([]);
    expect(report.experimentSpendAccounting).toMatchObject({
      policy: "observed-provider-receipts-plus-frozen-cap-for-every-begun-call-without-usage",
      preProviderCumulativeInputHardCapEnforced: true,
      authorizedMaximumUsd: 487.2,
      authors: { maximumCalls: 48, selectedCalls: 48, observedUsageReceipts: 48, unsettledOrUnobservableBegunCalls: 0 },
      primaryReviews: { maximumCalls: 96, selectedCalls: 96, observedUsageReceipts: 96, unsettledOrUnobservableBegunCalls: 0 },
      adjudications: { maximumCalls: 48, selectedCalls: 0, begunCalls: 0 },
      pairwisePreferences: { maximumCalls: 24, selectedCalls: 24, observedUsageReceipts: 24 },
      total: { maximumCalls: 216, selectedCalls: 168, observedUsageReceipts: 168 },
    });
    expect(report.sealedSampleSensitivity).toMatchObject({
      source: "frozen_hypothetical_public_planning_only",
      sealedTaskDataAccessed: false,
      hypotheticalRowsRole: "non_recommendation_diagnostics_only",
      selectedDesignSource: "observed_aa_uncertainty_aware_search_only",
      selectedDesignTest: "two_sided_task_cluster_sign_flip_normal_approximation",
      observedAaCalibrated: {
        source: "development_aa_outcomes_with_externally_fixed_candidate_lifts",
        sealedTaskDataAccessed: false,
        uncertainty: "exploratory-small-sample-24-pairs-12-tasks-not-confirmatory",
        estimates: { pooledSuccessRate: 0.5, pairedDiscordanceRate: 0, pairCount: 24, taskCount: 12 },
      },
    });
    expect(report.sealedSampleSensitivity.rows.map((row) => row.nominal.requiredPairs)).toEqual([112, 172, 448]);
    expect(report.sealedSampleSensitivity.observedAaCalibrated.rows.map((row) => row.candidateLift)).toEqual([0.08, 0.12, 0.15]);
    expect(report.sealedSampleSensitivity.observedAaCalibrated.rows.every((row) => row.status === "estimated")).toBe(true);
    expect(report.providerModelIdentity).toMatchObject({
      requestedModelIdentifier: "gpt-5.6-sol",
      immutableWeightSnapshotAsserted: false,
      observedAttempts: 48,
      unobservableAttempts: 0,
      falsifiedAttempts: 0,
      nonDefaultServiceTierAttempts: 0,
      observedModelIdentifierCounts: { "gpt-5.6-sol": 48 },
      observedServiceTierCounts: { default: 48 },
    });
    expect(report.providerIdentityDiagnostics).toMatchObject({
      providerDependentCalibrationEvaluation: "evaluable",
      authors: { expectedRecords: 48, observedRecords: 48, unobservableRecords: 0, falsifiedRecords: 0 },
      primaryScorers: { expectedRecords: 96, observedRecords: 96, unobservableRecords: 0, falsifiedRecords: 0 },
      adjudicators: { expectedRecords: 0, observedRecords: 0 },
      pairwiseJudges: { expectedRecords: 24, observedRecords: 24, unobservableRecords: 0, falsifiedRecords: 0 },
    });
    expect(report.reportDigest).toBe(computeExp0001aAnalysisReportDigest(report));
    expect(verifyExp0001aNormalizedAnalysisForTesting(report, input)).toEqual({ ok: true, report });
  });

  it("fires every preregistered diagnostic family without turning it into an improvement claim", () => {
    const input = fixture();
    for (const assignment of manifestJson.assignments.slice(0, 4)) {
      setDecision(attemptFor(input, assignment.pairId, "A0"), false);
      setDecision(attemptFor(input, assignment.pairId, "A1"), true);
    }
    input.attempts.slice(0, 10).forEach((attempt, index) => {
      const decision = attempt.accepted;
      attempt.primaryReviews = [
        scoredReview("rvw-aa-01", decision, "measurement"),
        scoredReview("rvw-aa-02", !decision),
      ];
      attempt.adjudication = scoredReview(`rvw-adj-${String(index).padStart(2, "0")}`, decision);
      attempt.reviewAccepted = decision;
    });
    input.preferences.forEach((preference, index) => {
      const winningLabel = index < 20 ? "A1" : "A0";
      preference.outcome = preference.leftOpaqueLabel === winningLabel ? "left" : "right";
    });
    input.attempts.forEach((attempt) => {
      attempt.artifactFields[0] = {
        fieldId: EXP0001A_REQUIRED_ARTIFACT_FIELDS[0],
        status: "missing",
        evidenceDigest: null,
        reason: "capture absent",
      };
      if (attempt.opaqueLabel === "A1") {
        for (const metric of ["latencyMs", "tokens", "toolCalls", "costUsd"] as const) {
          const observation = attempt.resources[metric];
          if (observation.status === "observed") observation.value *= 1.5;
        }
      }
    });

    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    expect(report.claimPolicy.improvementClaimPermitted).toBe(false);
    expect(report.alarms.triggeredCodes).toEqual(expect.arrayContaining([
      "SUCCESS_ABSOLUTE_DIFFERENCE_GT_0_15",
      "PREFERENCE_RATE_OUTSIDE_0_35_0_65",
      "PREFERENCE_TASK_CLUSTER_SIGN_FLIP_P_LT_0_10",
      "REVIEWER_AGREEMENT_LT_0_80",
      "ADJUDICATION_RATE_GT_0_20",
      "ARTIFACT_COMPLETENESS_LT_0_95",
      "LATENCYMS_RATIO_OUTSIDE_0_80_1_25",
      "TOKENS_RATIO_OUTSIDE_0_80_1_25",
      "TOOLCALLS_RATIO_OUTSIDE_0_80_1_25",
      "COSTUSD_RATIO_OUTSIDE_0_80_1_25",
    ]));
    expect(report.alarms.requiresInvestigation).toBe(true);
  });

  it("retains scorer and preference failures and makes resource missingness explicit", () => {
    const input = fixture();
    const first = input.attempts[0];
    first.primaryReviews[0] = {
      reviewerId: "rvw-aa-01",
      measurementRole: "measurement",
      providerIdentity: {
        status: "unobservable",
        requestedModelIdentifier: "gpt-5.6-sol",
        requestedServiceTier: "default",
        observedModelIdentifier: null,
        observedServiceTier: null,
        requestedAliasExactMatch: null,
      },
      status: "failed",
      accepted: null,
      primaryFailureClass: "FAIL_EVALUATOR_SCORER",
      failureCode: "provider_error",
    };
    first.accepted = false;
    first.reviewAccepted = false;
    first.primaryFailureClass = "FAIL_EVALUATOR_SCORER";
    first.mechanismTags = [{ tag: "EVAL_CAPTURE_MISSING_OR_CORRUPT", evidenceRefs: ["review:failure"] }];
    const firstPreference = input.preferences[0];
    firstPreference.outcome = "failed";
    firstPreference.failureCode = "render_unavailable";
    first.resources.costUsd = { status: "unobservable", value: null, reason: "provider usage categories absent" };
    input.attempts.filter((attempt) => attempt.opaqueLabel === "A1").forEach((attempt) => {
      const cost = attempt.resources.costUsd;
      if (cost.status === "observed") cost.value *= 10;
    });

    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    expect(report.runAccounting.retainedAttempts).toBe(48);
    expect(report.reviewerDiagnostics.primaryScorerFailureCount).toBe(1);
    expect(report.preferenceDiagnostics).toMatchObject({ failedComparisons: 1, failureCodes: { render_unavailable: 1 } });
    expect(report.taxonomy.primaryClassCounts.FAIL_EVALUATOR_SCORER).toBe(1);
    expect(report.resourceRatios.costUsd).toMatchObject({
      plannedPairCount: 24,
      observedPairCount: 23,
      unobservablePairCount: 1,
      status: "partial",
      alarmEvaluation: "not_evaluable",
    });
    expect(report.resourceRatios.costUsd.unobservablePairs[0].reasons)
      .toContain("A1:provider usage categories absent");
    expect(report.alarms.checks.find((check) => check.code === "COSTUSD_RATIO_OUTSIDE_0_80_1_25"))
      .toMatchObject({ evaluation: "not_evaluable", triggered: false });
    expect(report.alarms.checks.find((check) => check.code === "PREFERENCE_RATE_OUTSIDE_0_35_0_65"))
      .toMatchObject({ evaluation: "not_evaluable", triggered: false });
    expect(report.alarms.triggeredCodes).toContain("PREFERENCE_SCORER_FAILURES_PRESENT");
    expect(report.alarms.checks.find((check) => check.code === "REVIEWER_AGREEMENT_LT_0_80"))
      .toMatchObject({ evaluation: "not_evaluable", triggered: false });
    expect(report.alarms.checks.find((check) => check.code === "COHEN_KAPPA_LT_0_60"))
      .toMatchObject({ evaluation: "not_evaluable", triggered: false });
    expect(report.alarms.triggeredCodes).toContain("PRIMARY_SCORER_FAILURES_PRESENT");
  });

  it("retains adjudication scorer failures as an explicit investigation alarm", () => {
    const input = fixture();
    const attempt = input.attempts[0];
    attempt.primaryReviews = [
      scoredReview("rvw-aa-01", true, "measurement"),
      scoredReview("rvw-aa-02", false),
    ];
    attempt.adjudication = {
      reviewerId: "rvw-adj-01",
      measurementRole: "standard",
      providerIdentity: {
        status: "unobservable",
        requestedModelIdentifier: "gpt-5.6-sol",
        requestedServiceTier: "default",
        observedModelIdentifier: null,
        observedServiceTier: null,
        requestedAliasExactMatch: null,
      },
      status: "failed",
      accepted: null,
      primaryFailureClass: "FAIL_EVALUATOR_SCORER",
      failureCode: "provider_timeout",
    };
    attempt.accepted = false;
    attempt.reviewAccepted = false;
    attempt.primaryFailureClass = "FAIL_EVALUATOR_SCORER";

    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    expect(report.reviewerDiagnostics).toMatchObject({
      adjudicationCount: 1,
      adjudicationScorerFailureCount: 1,
      adjudicationScorerFailureCodes: { provider_timeout: 1 },
    });
    expect(report.alarms.triggeredCodes).toContain("ADJUDICATION_SCORER_FAILURES_PRESENT");
  });

  it("retains measurement-versus-standard primary context and alarms on ordered-role coverage drift", () => {
    const input = fixture();
    const first = input.attempts[0];
    [first.primaryReviews[0].measurementRole, first.primaryReviews[1].measurementRole] = [
      first.primaryReviews[1].measurementRole,
      first.primaryReviews[0].measurementRole,
    ];

    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    expect(report.measurementContextDiagnostics).toMatchObject({
      causalAttributionPermitted: false,
      coverage: {
        observedMeasurementCalls: 48,
        observedStandardCalls: 48,
        correctlyPositionedArtifactCount: 47,
        roleCoverageStatus: "drifted",
      },
      descriptiveAcceptanceRateDifferenceMeasurementMinusStandard: null,
      differenceEvaluation: "not_evaluable",
    });
    expect(report.alarms.triggeredCodes).toContain("PRIMARY_MEASUREMENT_CONTEXT_ROLE_COVERAGE_DRIFT");
    expect(report.measurementContextDiagnostics.interpretation).toMatch(/descriptive only.*cannot identify a causal/i);
  });

  it("reserves the full frozen call cap when a begun provider call has no usage receipt", () => {
    const input = fixture();
    const spend = input.experimentSpendAccounting;
    spend.primaryReviews.observedUsageReceipts -= 1;
    spend.primaryReviews.unsettledOrUnobservableBegunCalls += 1;
    spend.primaryReviews.observedUsage.inputTokens -= 100;
    spend.primaryReviews.observedUsage.uncachedInputTokens -= 100;
    spend.primaryReviews.observedUsage.outputTokens -= 20;
    spend.primaryReviews.observedUsage.reasoningTokens -= 5;
    spend.primaryReviews.observedUsage.totalTokens -= 120;
    spend.primaryReviews.observedCostUsd -= 0.04;
    spend.primaryReviews.conservativeReservedCostUsd = 0.46;
    spend.primaryReviews.accountedCostUsd = spend.primaryReviews.observedCostUsd + 0.46;
    spend.primaryReviews.unobservableReasonCounts = { provider_receipt_missing: 1 };
    spend.primaryReviews.status = "partial";
    spend.total.observedUsageReceipts -= 1;
    spend.total.unsettledOrUnobservableBegunCalls += 1;
    spend.total.observedUsage.inputTokens -= 100;
    spend.total.observedUsage.uncachedInputTokens -= 100;
    spend.total.observedUsage.outputTokens -= 20;
    spend.total.observedUsage.reasoningTokens -= 5;
    spend.total.observedUsage.totalTokens -= 120;
    spend.total.observedCostUsd -= 0.04;
    spend.total.conservativeReservedCostUsd = 0.46;
    spend.total.accountedCostUsd = spend.total.observedCostUsd + 0.46;
    spend.total.unobservableReasonCounts = { provider_receipt_missing: 1 };
    spend.total.status = "partial";
    spend.remainingAuthorizedExposureUsd = spend.authorizedMaximumUsd - spend.total.accountedCostUsd;

    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    expect(report.experimentSpendAccounting.primaryReviews).toMatchObject({
      begunCalls: 96,
      observedUsageReceipts: 95,
      unsettledOrUnobservableBegunCalls: 1,
      conservativeReservedCostUsd: 0.46,
      status: "partial",
    });
    expect(report.experimentSpendAccounting.total.accountedCostUsd).toBe(
      report.experimentSpendAccounting.total.observedCostUsd + 0.46,
    );
  });

  it("rejects spend-cap and spend-ledger provenance rewrites", () => {
    const wrongCap = fixture();
    (wrongCap.experimentSpendAccounting as { authorizedMaximumUsd: number }).authorizedMaximumUsd = 304.8;
    expect(() => compileExp0001aNormalizedAnalysisForTesting(wrongCap)).toThrow();

    const wrongRoot = fixture();
    wrongRoot.sourceRoots.spendLedgerRoot = digest("forged-spend-ledger");
    expect(() => compileExp0001aNormalizedAnalysisForTesting(wrongRoot)).toThrow(/SPEND_LEDGER_ROOT_MISMATCH/);
  });

  it("flags any observed non-default author service tier", () => {
    const input = fixture();
    input.attempts[0].providerIdentity!.observedServiceTiers = ["priority"];
    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    expect(report.providerModelIdentity.nonDefaultServiceTierAttempts).toBe(1);
    expect(report.alarms.triggeredCodes).toContain("NON_DEFAULT_SERVICE_TIER_OBSERVED");
  });

  it("does not let normalized caller rewrites impersonate source-ledger verification", () => {
    const rewritten = fixture();
    rewritten.attempts.forEach((attempt) => setDecision(attempt, true));
    rewritten.sourceRoots = Object.fromEntries(Object.keys(rewritten.sourceRoots).map((key) => [
      key,
      key === "manifestDigest" ? manifestJson.manifestDigest : digest(`forged:${key}`),
    ])) as Exp0001aAnalysisInput["sourceRoots"];

    expect(() => compileExp0001aAnalysis(rewritten as unknown as Exp0001aAnalysisSourceContext))
      .toThrow(/SOURCE_CONTEXT_REQUIRED/);
  });

  it("marks all-failed preference scoring non-evaluable while retaining the full denominator", () => {
    const input = fixture();
    input.preferences.forEach((preference, index) => {
      preference.outcome = "failed";
      preference.failureCode = `pairwise_failure_${index % 2}`;
    });

    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    expect(report.preferenceDiagnostics).toMatchObject({
      pairCount: 24,
      a0Wins: 0,
      a1Wins: 0,
      ties: 0,
      failedComparisons: 24,
      nonTieCount: 0,
      a1WinRateAmongNonTies: null,
      exactTwoSidedSignPValue: null,
      rateAlarmEvaluation: "not_evaluable",
      taskClusterSignFlip: { evaluation: "not_evaluable", exactTwoSidedPValue: null },
    });
    expect(report.alarms.checks.filter((check) => check.code.startsWith("PREFERENCE_")).map((check) => ({
      code: check.code,
      evaluation: check.evaluation,
      triggered: check.triggered,
    }))).toEqual([
      { code: "PREFERENCE_RATE_OUTSIDE_0_35_0_65", evaluation: "not_evaluable", triggered: false },
      { code: "PREFERENCE_TASK_CLUSTER_SIGN_FLIP_P_LT_0_10", evaluation: "not_evaluable", triggered: false },
      { code: "PREFERENCE_SCORER_FAILURES_PRESENT", evaluation: "evaluated", triggered: true },
    ]);
  });

  it("reports non-estimable kappa instead of treating unanimous marginals as perfect kappa", () => {
    const input = fixture();
    input.attempts.forEach((attempt) => setDecision(attempt, true));

    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    expect(report.reviewerDiagnostics).toMatchObject({
      rawAgreement: 1,
      cohenKappa: null,
      kappaEstimable: false,
    });
    expect(report.alarms.checks.find((check) => check.code === "COHEN_KAPPA_LT_0_60"))
      .toMatchObject({ evaluation: "not_evaluable", triggered: false, observed: null });
  });

  it("keeps equality at inclusive preference/resource boundaries out of alarm state", () => {
    const input = fixture();
    input.preferences.forEach((preference, index) => {
      const desired: "A0" | "A1" | "tie" = index < 7 ? "A1" : index < 20 ? "A0" : "tie";
      const replacement = preferenceFor(manifestJson.assignments[index], desired);
      Object.assign(preference, replacement);
    });
    input.attempts.forEach((attempt) => {
      if (attempt.opaqueLabel !== "A1") return;
      const latency = attempt.resources.latencyMs;
      const tokens = attempt.resources.tokens;
      if (latency.status === "observed") latency.value *= 0.8;
      if (tokens.status === "observed") tokens.value *= 1.25;
    });

    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    expect(report.preferenceDiagnostics.a1WinRateAmongNonTies).toBe(0.35);
    expect(report.resourceRatios.latencyMs.medianPairedRatioA1OverA0).toBeCloseTo(0.8, 12);
    expect(report.resourceRatios.tokens.medianPairedRatioA1OverA0).toBeCloseTo(1.25, 12);
    for (const code of [
      "PREFERENCE_RATE_OUTSIDE_0_35_0_65",
      "LATENCYMS_RATIO_OUTSIDE_0_80_1_25",
      "TOKENS_RATIO_OUTSIDE_0_80_1_25",
    ]) {
      expect(report.alarms.checks.find((check) => check.code === code))
        .toMatchObject({ evaluation: "evaluated", triggered: false });
    }
  });

  it("separates required-cell completeness from unobservable cells and retains incident provenance", () => {
    const input = fixture();
    const attempt = input.attempts[0];
    attempt.executorOutcome = "executor_threw";
    attempt.retainedStatus = "infra_failure";
    attempt.authorOutcome = "infra_failure";
    attempt.accepted = false;
    attempt.primaryFailureClass = "FAIL_INFRASTRUCTURE";
    attempt.incidents = [{
      code: "runner_process_disappeared",
      status: "retained",
      hardIncident: true,
      falsification: false,
      sourceEventDigest: digest("retained-incident-event"),
    }];
    attempt.artifactFields[0] = {
      fieldId: EXP0001A_REQUIRED_ARTIFACT_FIELDS[0],
      status: "unobservable",
      evidenceDigest: null,
      reason: "author attempt ended before artifact retention",
    };

    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    expect(report.artifactCompleteness).toMatchObject({
      definition: "observed_required_cells_divided_by_all_required_cells",
      unobservablePolicy: "retained_separately_and_not_counted_as_observed",
      unobservableCellCount: 1,
      missingCellCount: 0,
    });
    expect(report.artifactCompleteness.completenessRate)
      .toBe((48 * EXP0001A_REQUIRED_ARTIFACT_FIELDS.length - 1) / (48 * EXP0001A_REQUIRED_ARTIFACT_FIELDS.length));
    expect(report.taxonomy).toMatchObject({
      retainedStatusCounts: { completed: 47, infra_failure: 1 },
      executorOutcomeCounts: { completed: 47, executor_threw: 1 },
      incidentCodeCounts: { runner_process_disappeared: 1 },
      incidentStatusCounts: { retained: 1 },
      hardIncidentAttemptCount: 1,
      falsificationAttemptCount: 0,
    });
  });

  it("uses complete-task sign flips when duplicated replicate evidence makes naive pair tests anti-conservative", () => {
    const input = fixture();
    const taskIds = [...new Set(manifestJson.assignments.map((assignment) => assignment.taskId))];
    expect(taskIds).toHaveLength(12);
    manifestJson.assignments.forEach((assignment, index) => {
      const taskIndex = taskIds.indexOf(assignment.taskId);
      const desired: "A0" | "A1" | "tie" = taskIndex < 8 ? "A1" : taskIndex < 10 ? "A0" : "tie";
      if (desired === "A1") {
        setDecision(attemptFor(input, assignment.pairId, "A0"), false);
        setDecision(attemptFor(input, assignment.pairId, "A1"), true);
      } else if (desired === "A0") {
        setDecision(attemptFor(input, assignment.pairId, "A0"), true);
        setDecision(attemptFor(input, assignment.pairId, "A1"), false);
      } else {
        setDecision(attemptFor(input, assignment.pairId, "A0"), false);
        setDecision(attemptFor(input, assignment.pairId, "A1"), false);
      }
      input.preferences[index] = preferenceFor(assignment, desired);
    });

    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    expect(report.pairedSuccess.overall.exactPairedPValue).toBeLessThan(0.10);
    expect(report.pairedSuccess.overall.taskClusterSignFlip.exactTwoSidedPValue).toBeCloseTo(0.109375, 12);
    expect(report.preferenceDiagnostics.exactTwoSidedSignPValue).toBeLessThan(0.10);
    expect(report.preferenceDiagnostics.taskClusterSignFlip.exactTwoSidedPValue).toBeCloseTo(0.109375, 12);
    expect(report.alarms.triggeredCodes).not.toContain("SUCCESS_TASK_CLUSTER_SIGN_FLIP_P_LT_0_10");
    expect(report.alarms.triggeredCodes).not.toContain("PREFERENCE_TASK_CLUSTER_SIGN_FLIP_P_LT_0_10");
  });

  it("makes one missing author identity sufficient to invalidate provider-dependent calibration", () => {
    const input = fixture();
    input.attempts[0].providerIdentity = null;

    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    expect(report.providerIdentityDiagnostics).toMatchObject({
      providerDependentCalibrationEvaluation: "not_evaluable",
      authors: {
        expectedRecords: 48,
        observedRecords: 47,
        unobservableRecords: 1,
        falsifiedRecords: 0,
        evaluation: "not_evaluable",
      },
    });
    expect(report.alarms.triggeredCodes).toContain("AUTHOR_PROVIDER_IDENTITY_UNOBSERVABLE_OR_FALSIFIED");
    expect(report.alarms.requiresInvestigation).toBe(true);
  });

  it("accepts one stable resolved-model snapshot per phase but alarms on one divergent returned model", () => {
    const stable = fixture();
    stable.attempts.forEach((attempt) => {
      attempt.providerIdentity!.observedModelIdentifiers = ["gpt-5.6-sol-2026-08-30"];
      attempt.providerIdentity!.requestedAliasExactMatch = false;
      attempt.primaryReviews.forEach((review) => {
        review.providerIdentity.observedModelIdentifier = "gpt-5.6-sol-2026-08-30";
        review.providerIdentity.requestedAliasExactMatch = false;
      });
    });
    stable.preferences.forEach((preference) => {
      preference.providerIdentity.observedModelIdentifier = "gpt-5.6-sol-2026-08-30";
      preference.providerIdentity.requestedAliasExactMatch = false;
    });
    const stableReport = compileExp0001aNormalizedAnalysisForTesting(stable);
    expect(stableReport.providerIdentityDiagnostics).toMatchObject({
      providerDependentCalibrationEvaluation: "evaluable",
      observedModelStability: {
        authors: { status: "stable", stableObservedModelIdentifier: "gpt-5.6-sol-2026-08-30" },
        individualScorers: { status: "stable", stableObservedModelIdentifier: "gpt-5.6-sol-2026-08-30" },
        pairwiseJudges: { status: "stable", stableObservedModelIdentifier: "gpt-5.6-sol-2026-08-30" },
      },
    });

    stable.attempts[0].providerIdentity!.observedModelIdentifiers = ["gpt-5.6-sol-2026-08-31"];
    stable.attempts[0].primaryReviews[0].providerIdentity.observedModelIdentifier = "gpt-5.6-sol-2026-08-31";
    stable.preferences[0].providerIdentity.observedModelIdentifier = "gpt-5.6-sol-2026-08-31";
    const mixedReport = compileExp0001aNormalizedAnalysisForTesting(stable);
    expect(mixedReport.providerIdentityDiagnostics).toMatchObject({
      providerDependentCalibrationEvaluation: "not_evaluable",
      authors: { observedRecords: 48, unobservableRecords: 0, falsifiedRecords: 0 },
      primaryScorers: { observedRecords: 96, unobservableRecords: 0, falsifiedRecords: 0 },
      pairwiseJudges: { observedRecords: 24, unobservableRecords: 0, falsifiedRecords: 0 },
      observedModelStability: {
        authors: { status: "mixed", stableObservedModelIdentifier: null },
        individualScorers: { status: "mixed", stableObservedModelIdentifier: null },
        pairwiseJudges: { status: "mixed", stableObservedModelIdentifier: null },
      },
    });
    expect(mixedReport.alarms.triggeredCodes).toEqual(expect.arrayContaining([
      "AUTHOR_RESOLVED_MODEL_VARIANCE",
      "INDIVIDUAL_SCORER_RESOLVED_MODEL_VARIANCE",
      "PAIRWISE_JUDGE_RESOLVED_MODEL_VARIANCE",
    ]));
    expect(mixedReport.providerIdentityDiagnostics.observedModelStability.authors.interpretation)
      .toMatch(/does not establish immutable weights|non-evaluable/i);
  });

  it("rejects requested-model alias drift in author, scorer, and pairwise phases", () => {
    const author = fixture();
    (author.attempts[0].providerIdentity as { requestedModelIdentifier: string })
      .requestedModelIdentifier = "gpt-5.6-sol-drift";
    expect(() => compileExp0001aNormalizedAnalysisForTesting(author)).toThrow(/frozen requested model alias/i);

    const scorer = fixture();
    (scorer.attempts[0].primaryReviews[0].providerIdentity as { requestedModelIdentifier: string })
      .requestedModelIdentifier = "gpt-5.6-sol-drift";
    expect(() => compileExp0001aNormalizedAnalysisForTesting(scorer)).toThrow();

    const pairwise = fixture();
    (pairwise.preferences[0].providerIdentity as { requestedModelIdentifier: string })
      .requestedModelIdentifier = "gpt-5.6-sol-drift";
    expect(() => compileExp0001aNormalizedAnalysisForTesting(pairwise)).toThrow();
  });

  it("retains all-record missing and falsified scorer/judge identity denominators as non-evaluable", () => {
    const input = fixture();
    input.attempts.forEach((attempt, index) => {
      attempt.providerIdentity!.status = "falsified";
      const accepted = attempt.accepted;
      attempt.primaryReviews = [
        {
          ...scoredReview("rvw-aa-01", accepted, "measurement"),
          providerIdentity: {
            status: "unobservable",
            requestedModelIdentifier: "gpt-5.6-sol",
            requestedServiceTier: "default",
            observedModelIdentifier: null,
            observedServiceTier: null,
            requestedAliasExactMatch: null,
          },
        },
        {
          ...scoredReview("rvw-aa-02", !accepted),
          providerIdentity: {
            status: "unobservable",
            requestedModelIdentifier: "gpt-5.6-sol",
            requestedServiceTier: "default",
            observedModelIdentifier: null,
            observedServiceTier: null,
            requestedAliasExactMatch: null,
          },
        },
      ];
      attempt.adjudication = {
        ...scoredReview(`rvw-adj-${String(index).padStart(2, "0")}`, accepted),
        providerIdentity: {
          ...observedScorerIdentity("gpt-5.6-sol-resolved"),
          status: "falsified",
        },
      };
      attempt.reviewAccepted = accepted;
    });
    input.preferences.forEach((preference) => {
      preference.providerIdentity = {
        ...observedScorerIdentity("gpt-5.6-sol-resolved"),
        status: "falsified",
      };
    });

    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    expect(report.providerIdentityDiagnostics).toMatchObject({
      providerDependentCalibrationEvaluation: "not_evaluable",
      authors: { expectedRecords: 48, falsifiedRecords: 48, evaluation: "not_evaluable" },
      primaryScorers: { expectedRecords: 96, unobservableRecords: 96, evaluation: "not_evaluable" },
      adjudicators: { expectedRecords: 48, falsifiedRecords: 48, evaluation: "not_evaluable" },
      pairwiseJudges: { expectedRecords: 24, falsifiedRecords: 24, evaluation: "not_evaluable" },
    });
    expect(report.alarms.triggeredCodes).toEqual(expect.arrayContaining([
      "AUTHOR_PROVIDER_IDENTITY_UNOBSERVABLE_OR_FALSIFIED",
      "PRIMARY_SCORER_IDENTITY_UNOBSERVABLE_OR_FALSIFIED",
      "ADJUDICATOR_IDENTITY_UNOBSERVABLE_OR_FALSIFIED",
      "PAIRWISE_JUDGE_IDENTITY_UNOBSERVABLE_OR_FALSIFIED",
    ]));
  });

  it("searches beyond the one-shot design-effect diagnostic until the lower Monte Carlo power bound reaches 0.80", () => {
    const report = compileExp0001aNormalizedAnalysisForTesting(fixture());
    const row = report.sealedSampleSensitivity.observedAaCalibrated.rows.find((candidate) => candidate.status === "estimated");
    expect(row?.plan).not.toBeNull();
    expect(row?.oneShotPlanRole).toBe("diagnostic_only_not_recommended_sample_size");
    expect(row?.recommendation?.trace[0].pointwiseMonteCarlo95Interval[0]).toBeLessThan(0.80);
    expect(row?.recommendation?.status).toBe("target_reached");
    expect(row?.recommendation?.recommendedUniqueTasks).toBeGreaterThan(row!.recommendation!.startUniqueTasks);
    const noisyEarlierCrossing = row?.recommendation?.trace.find((candidate) => (
      candidate.pointwiseMonteCarlo95Interval[0] >= 0.80 && !candidate.lowerBoundReachesTarget
    ));
    expect(noisyEarlierCrossing).toBeDefined();
    expect(row?.recommendation?.recommendedUniqueTasks).toBeGreaterThan(noisyEarlierCrossing!.taskCount);
    expect(row?.recommendation?.trace.at(-1)).toMatchObject({ lowerBoundReachesTarget: true });
    expect(row?.recommendation?.trace.at(-1)?.simultaneousFamilywise95LowerBound).toBeGreaterThanOrEqual(0.80);
    expect(row?.recommendation).toMatchObject({
      familywiseMonteCarloPolicy: "one_sided_hoeffding_bound_with_bonferroni_over_fixed_candidate_universe",
      familywiseErrorProbability: 0.05,
      fixedCandidateUniverseCount: 571,
    });
    expect(report.sealedSampleSensitivity.observedAaCalibrated.estimates).toMatchObject({
      pooledSuccessRate95Interval: { level: 0.95, method: "wilson_score" },
      pairedDiscordanceRate95Interval: { level: 0.95, method: "wilson_score" },
      intrataskCorrelation95Interval: { level: 0.95 },
    });
  });

  it("rejects missing, duplicated, selectively omitted, treatment-drifted, and mis-mapped inputs", () => {
    const missing = fixture();
    missing.attempts.pop();
    expect(() => compileExp0001aNormalizedAnalysisForTesting(missing)).toThrow();

    const duplicate = fixture();
    duplicate.attempts[1] = structuredClone(duplicate.attempts[0]);
    expect(() => compileExp0001aNormalizedAnalysisForTesting(duplicate)).toThrow(/DUPLICATE_ATTEMPT/);

    const selective = fixture() as Exp0001aAnalysisInput & { attempts: Array<Record<string, unknown>> };
    delete (selective.attempts[0].resources as Record<string, unknown>).costUsd;
    expect(() => compileExp0001aNormalizedAnalysisForTesting(selective)).toThrow();

    const missingField = fixture();
    missingField.attempts[0].artifactFields.pop();
    expect(() => compileExp0001aNormalizedAnalysisForTesting(missingField)).toThrow();

    const drift = fixture();
    drift.attempts[0].treatmentDigest = digest("different-treatment");
    expect(() => compileExp0001aNormalizedAnalysisForTesting(drift)).toThrow(/ATTEMPT_MAPPING_DRIFT/);

    const mapping = fixture();
    const preference = mapping.preferences[0];
    [preference.leftAttemptId, preference.rightAttemptId] = [preference.rightAttemptId, preference.leftAttemptId];
    preference.mappingDigest = computeExp0001aPreferenceMappingDigest(preference);
    expect(() => compileExp0001aNormalizedAnalysisForTesting(mapping)).toThrow(/PREFERENCE_LABEL_MAPPING_DRIFT/);

    const duplicatePreference = fixture();
    duplicatePreference.preferences[1] = structuredClone(duplicatePreference.preferences[0]);
    expect(() => compileExp0001aNormalizedAnalysisForTesting(duplicatePreference)).toThrow(/DUPLICATE_PREFERENCE/);
  });

  it("detects both ordinary report tampering and a forged replacement self-hash against source input", () => {
    const input = fixture();
    const report = compileExp0001aNormalizedAnalysisForTesting(input);
    const tampered = structuredClone(report);
    tampered.pairedSuccess.overall.absoluteDifferenceA1MinusA0 = 0.5;
    expect(verifyExp0001aNormalizedAnalysisForTesting(tampered, input)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["REPORT_DIGEST_MISMATCH"]),
    });

    const forged = structuredClone(tampered);
    forged.reportDigest = computeExp0001aAnalysisReportDigest(forged);
    expect(verifyExp0001aNormalizedAnalysisForTesting(forged, input)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["REPORT_INPUT_RECONCILIATION_MISMATCH"]),
    });
  });
});
