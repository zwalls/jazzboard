import { z } from "zod";

import {
  verifyDevelopmentExecutionManifest,
  type DevelopmentExecutionManifest,
} from "./development-manifest";
import {
  FROZEN_PRIMARY_FAILURE_CLASSES,
  blindedReviewPlanSchema,
  classificationBookSchema,
  computeClassificationRoot,
  finalizeArtifactClassifications,
  reviewLedgerSchema,
  verifyBlindedReviewPlan,
  verifyReviewLedger,
  type BlindedReviewPlan,
  type ClassificationBook,
  type LockedEvaluatorRecord,
  type ReviewLedger,
} from "./blinded-review-orchestration";
import {
  batchRegistrySchema,
  computeActualProviderTurnCost,
  createExp0001aBatchPlan,
  providerIdentityObservationSchema,
  verifyExp0001aBatchRegistry,
  type BatchRegistry,
  type BatchRegistryEvent,
  type Exp0001aBatchPlan,
} from "./exp0001a-batch-coordinator";
import {
  computeExp0001aRegistryBridgeReceiptDigest,
  exp0001aRegistryBridgeReceiptSchema,
  type Exp0001aRegistryBridgeReceipt,
} from "./exp0001a-registry-bridge";
import {
  attemptRegistrySchema,
  type AttemptRegistry,
} from "./attempt-schemas";
import { verifyAttemptRegistry } from "./provenance-verification";
import {
  computePairwiseLedgerRoot,
  computePairwiseLedgerSealRoot,
  computeUnblindedPairwiseReportRoot,
  pairwisePreferenceLedgerSchema,
  pairwisePreferenceLedgerSealSchema,
  pairwiseVisualPreferencePlanSchema,
  unblindPairwiseVisualPreferences,
  unblindedPairwiseReportSchema,
  verifyPairwisePreferenceLedger,
  verifyPairwiseVisualPreferencePlan,
  type PairwisePlanContext,
  type PairwisePreferenceLedger,
  type PairwisePreferenceLedgerSeal,
  type PairwiseVisualPreferencePlan,
  type UnblindedPairwiseReport,
} from "./pairwise-visual-preference";
import {
  summarizeExp0001aSpendLedger,
  type Exp0001aSpendEvent,
  type Exp0001aSpendPhase,
} from "./exp0001a-spend-ledger";
import {
  findNominalPairRequirement,
  intrataskDesignEffect,
  monteCarloClusterPower,
  monteCarloTaskClusterSignFlipPower,
  planSealedSampleScenarios,
  type SealedSamplePlanRow,
  type SealedSampleScenario,
} from "./sample-planning";
import {
  summarizePairedBinary,
  summarizePairedPositiveRatio,
  type ConfidenceInterval,
} from "./statistics";
import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
} from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const stableIdSchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const labelSchema = z.enum(["A0", "A1"]);
const primaryFailureClassSchema = z.enum(FROZEN_PRIMARY_FAILURE_CLASSES);
const taskFamilySchema = z.enum(["architecture", "drawing"]);
const stratumSchema = z.enum(["creation", "editing", "stress"]);

export const EXP0001A_REQUIRED_ARTIFACT_FIELDS = Object.freeze([
  "attempt-bundle.json",
  "author-brief.json",
  "author-events.jsonl",
  "author-final.json",
  "author-identity-commitment.json",
  "coordinator-events.jsonl",
  "author-evidence-seal.json",
  "participant-tool-contract.json",
  "spectator-final-state.json",
  "spectator-inspection.json",
  "spectator-tool-contract.json",
  "spectator-final-png",
  "attempt-metrics",
  "locked-classification",
] as const);

export const EXP0001A_ANALYSIS_THRESHOLDS = Object.freeze({
  maximumAbsoluteSuccessDifference: 0.15,
  maximumExactPairedPValueForAlarm: 0.10,
  minimumPreferenceWinRate: 0.35,
  maximumPreferenceWinRate: 0.65,
  maximumPreferencePValueForAlarm: 0.10,
  minimumReviewerAgreement: 0.80,
  minimumCohenKappa: 0.60,
  maximumAdjudicationRate: 0.20,
  minimumArtifactCompleteness: 0.95,
  minimumPairedResourceRatio: 0.80,
  maximumPairedResourceRatio: 1.25,
} as const);

export const EXP0001A_SEALED_SAMPLE_SENSITIVITY_SCENARIOS = Object.freeze([
  {
    id: "sensitivity-larger-lift",
    baselineRate: 0.55,
    candidateLift: 0.15,
    discordanceRate: 0.30,
    alpha: 0.05,
    targetPower: 0.80,
    maximumPairs: 1_000,
    replicatesPerTask: 2,
    intrataskCorrelation: 0.10,
    simulations: 10_000,
    seed: 2_026_083_101,
  },
  {
    id: "sensitivity-central",
    baselineRate: 0.55,
    candidateLift: 0.12,
    discordanceRate: 0.30,
    alpha: 0.05,
    targetPower: 0.80,
    maximumPairs: 1_000,
    replicatesPerTask: 2,
    intrataskCorrelation: 0.25,
    simulations: 10_000,
    seed: 2_026_083_102,
  },
  {
    id: "sensitivity-smaller-lift",
    baselineRate: 0.55,
    candidateLift: 0.08,
    discordanceRate: 0.35,
    alpha: 0.05,
    targetPower: 0.80,
    maximumPairs: 2_000,
    replicatesPerTask: 3,
    intrataskCorrelation: 0.40,
    simulations: 10_000,
    seed: 2_026_083_103,
  },
] satisfies readonly SealedSampleScenario[]);

const artifactFieldSchema = z.discriminatedUnion("status", [
  z.object({
    fieldId: z.enum(EXP0001A_REQUIRED_ARTIFACT_FIELDS),
    status: z.literal("observed"),
    evidenceDigest: digestSchema,
    reason: z.null(),
  }).strict(),
  z.object({
    fieldId: z.enum(EXP0001A_REQUIRED_ARTIFACT_FIELDS),
    status: z.enum(["unobservable", "missing"]),
    evidenceDigest: z.null(),
    reason: z.string().trim().min(1).max(500),
  }).strict(),
]);

const artifactFieldsSchema = z.array(artifactFieldSchema)
  .length(EXP0001A_REQUIRED_ARTIFACT_FIELDS.length)
  .superRefine((fields, context) => {
    fields.forEach((field, index) => {
      if (field.fieldId !== EXP0001A_REQUIRED_ARTIFACT_FIELDS[index]) {
        context.addIssue({
          code: "custom",
          path: [index, "fieldId"],
          message: "Artifact fields must contain the exact frozen field universe in canonical order.",
        });
      }
    });
  });

const resourceObservationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("observed"),
    value: z.number().finite().nonnegative(),
    reason: z.null(),
  }).strict(),
  z.object({
    status: z.literal("unobservable"),
    value: z.null(),
    reason: z.string().trim().min(1).max(500),
  }).strict(),
]);

const providerRecordIdentitySchema = z.object({
  status: z.enum(["observed", "unobservable", "falsified"]),
  requestedModelIdentifier: z.literal("gpt-5.6-sol"),
  requestedServiceTier: z.literal("default"),
  observedModelIdentifier: stableIdSchema.nullable(),
  observedServiceTier: stableIdSchema.nullable(),
  requestedAliasExactMatch: z.boolean().nullable(),
}).strict().superRefine((identity, context) => {
  const hasObservedIdentity = identity.observedModelIdentifier !== null
    && identity.observedServiceTier !== null
    && identity.requestedAliasExactMatch !== null;
  if (identity.status === "observed" && !hasObservedIdentity) {
    context.addIssue({ code: "custom", message: "Observed provider identity requires model, tier, and alias evidence." });
  }
});

const scoredReviewSchema = z.object({
  reviewerId: stableIdSchema,
  measurementRole: z.enum(["measurement", "standard"]),
  providerIdentity: providerRecordIdentitySchema,
  status: z.literal("scored"),
  accepted: z.boolean(),
  primaryFailureClass: primaryFailureClassSchema,
  failureCode: z.null(),
}).strict().superRefine((review, context) => {
  if ((review.primaryFailureClass === "SUCCESS") !== review.accepted) {
    context.addIssue({ code: "custom", message: "A scored review accepts exactly when its class is SUCCESS." });
  }
});

const failedReviewSchema = z.object({
  reviewerId: stableIdSchema,
  measurementRole: z.enum(["measurement", "standard"]),
  providerIdentity: providerRecordIdentitySchema,
  status: z.literal("failed"),
  accepted: z.null(),
  primaryFailureClass: z.literal("FAIL_EVALUATOR_SCORER"),
  failureCode: stableIdSchema,
}).strict();

const reviewSchema = z.union([scoredReviewSchema, failedReviewSchema]);

const mechanismSchema = z.object({
  tag: z.string().regex(/^[A-Z][A-Z0-9_]{1,159}$/),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(64),
}).strict().superRefine((mechanism, context) => {
  if (new Set(mechanism.evidenceRefs).size !== mechanism.evidenceRefs.length) {
    context.addIssue({ code: "custom", path: ["evidenceRefs"], message: "Mechanism evidence references must be unique." });
  }
});

const incidentSchema = z.object({
  code: stableIdSchema,
  status: z.enum(["not_started", "retained"]),
  hardIncident: z.boolean(),
  falsification: z.boolean(),
  sourceEventDigest: digestSchema,
}).strict();

const attemptAnalysisSchema = z.object({
  attemptId: stableIdSchema,
  pairId: stableIdSchema,
  taskId: stableIdSchema,
  taskFamily: taskFamilySchema,
  stratum: stratumSchema,
  opaqueLabel: labelSchema,
  orderIndex: z.union([z.literal(0), z.literal(1)]),
  timeBlock: z.number().int().min(0).max(23),
  treatmentDigest: digestSchema,
  executorOutcome: z.enum(["completed", "failed", "timeout", "infra_failure", "policy_violation", "executor_threw"]),
  retainedStatus: z.enum(["completed", "failed", "timeout", "infra_failure", "policy_violation"]),
  authorOutcome: z.enum(["completed", "failed", "timeout", "infra_failure", "policy_violation"]),
  incidents: z.array(incidentSchema).max(128),
  providerIdentity: providerIdentityObservationSchema.nullable(),
  accepted: z.boolean(),
  reviewAccepted: z.boolean(),
  primaryFailureClass: primaryFailureClassSchema,
  mechanismTags: z.array(mechanismSchema).max(128),
  primaryReviews: z.tuple([reviewSchema, reviewSchema]),
  adjudication: reviewSchema.nullable(),
  artifactFields: artifactFieldsSchema,
  resources: z.object({
    latencyMs: resourceObservationSchema,
    tokens: resourceObservationSchema,
    toolCalls: resourceObservationSchema,
    costUsd: resourceObservationSchema,
  }).strict(),
}).strict().superRefine((attempt, context) => {
  if (attempt.providerIdentity !== null && attempt.providerIdentity.requestedModelIdentifier !== "gpt-5.6-sol") {
    context.addIssue({
      code: "custom",
      path: ["providerIdentity", "requestedModelIdentifier"],
      message: "Author provider identity must retain the exact frozen requested model alias.",
    });
  }
  if (attempt.authorOutcome !== attempt.retainedStatus) {
    context.addIssue({ code: "custom", path: ["retainedStatus"], message: "Author outcome must equal the retained batch status." });
  }
  if (attempt.executorOutcome !== attempt.retainedStatus && attempt.incidents.length === 0) {
    context.addIssue({ code: "custom", path: ["incidents"], message: "Executor/retained status normalization requires a retained incident." });
  }
  if ((attempt.primaryFailureClass === "SUCCESS") !== attempt.accepted) {
    context.addIssue({ code: "custom", path: ["primaryFailureClass"], message: "Final acceptance must exactly match SUCCESS." });
  }
  const expectedAuthorFailure = attempt.authorOutcome === "infra_failure" ? "FAIL_INFRASTRUCTURE"
    : attempt.authorOutcome === "policy_violation" ? "FAIL_PROTOCOL_VIOLATION"
      : attempt.authorOutcome === "completed" ? null : "FAIL_AUTHOR_NONCOMPLETION";
  if (expectedAuthorFailure !== null && (attempt.accepted || attempt.primaryFailureClass !== expectedAuthorFailure)) {
    context.addIssue({ code: "custom", path: ["authorOutcome"], message: "A non-completed author outcome must retain its frozen failure class." });
  }
  if (new Set(attempt.mechanismTags.map((mechanism) => mechanism.tag)).size !== attempt.mechanismTags.length) {
    context.addIssue({ code: "custom", path: ["mechanismTags"], message: "Mechanism tags must be unique per attempt." });
  }
  const [first, second] = attempt.primaryReviews;
  if (first.reviewerId === second.reviewerId) {
    context.addIssue({ code: "custom", path: ["primaryReviews"], message: "Primary reviewers must be distinct." });
  }
  const scorerFailed = first.status === "failed" || second.status === "failed";
  if (scorerFailed) {
    if (attempt.adjudication !== null) {
      context.addIssue({ code: "custom", path: ["adjudication"], message: "A primary scorer failure cannot trigger outcome-selective adjudication." });
    }
    if (attempt.reviewAccepted) {
      context.addIssue({ code: "custom", path: ["reviewAccepted"], message: "A primary scorer failure must remain non-accepted." });
    }
  } else {
    const disagreement = first.accepted !== second.accepted;
    if (disagreement !== (attempt.adjudication !== null)) {
      context.addIssue({ code: "custom", path: ["adjudication"], message: "Every and only binary primary disagreement requires adjudication." });
    }
    if (attempt.adjudication !== null
        && [first.reviewerId, second.reviewerId].includes(attempt.adjudication.reviewerId)) {
      context.addIssue({ code: "custom", path: ["adjudication", "reviewerId"], message: "The adjudicator must be independent." });
    }
    const resolved = disagreement
      ? attempt.adjudication?.status === "scored" ? attempt.adjudication.accepted : false
      : first.accepted;
    if (attempt.reviewAccepted !== resolved) {
      context.addIssue({ code: "custom", path: ["reviewAccepted"], message: "Review acceptance does not reconcile to locked primaries/adjudication." });
    }
  }
  if (attempt.authorOutcome === "completed" && attempt.accepted !== attempt.reviewAccepted) {
    context.addIssue({ code: "custom", path: ["accepted"], message: "A completed attempt must use the resolved blinded-review decision." });
  }
  const adjudicationFailed = attempt.adjudication?.status === "failed";
  if (attempt.authorOutcome === "completed" && (scorerFailed || adjudicationFailed)
      && attempt.primaryFailureClass !== "FAIL_EVALUATOR_SCORER") {
    context.addIssue({
      code: "custom",
      path: ["primaryFailureClass"],
      message: "A completed artifact with an unresolved scorer failure must retain FAIL_EVALUATOR_SCORER.",
    });
  }
});

const preferenceSchema = z.object({
  pairId: stableIdSchema,
  leftAttemptId: stableIdSchema,
  rightAttemptId: stableIdSchema,
  leftOpaqueLabel: labelSchema,
  rightOpaqueLabel: labelSchema,
  outcome: z.enum(["left", "right", "tie", "failed"]),
  failureCode: stableIdSchema.nullable(),
  providerIdentity: providerRecordIdentitySchema,
  mappingDigest: digestSchema,
}).strict().superRefine((preference, context) => {
  if (preference.leftAttemptId === preference.rightAttemptId || preference.leftOpaqueLabel === preference.rightOpaqueLabel) {
    context.addIssue({ code: "custom", message: "A preference must compare the two distinct pair artifacts." });
  }
  if ((preference.outcome === "failed") !== (preference.failureCode !== null)) {
    context.addIssue({ code: "custom", path: ["failureCode"], message: "Preference failures require exactly one explicit failure code." });
  }
});

const sourceRootsSchema = z.object({
  manifestDigest: digestSchema,
  batchPlanDigest: digestSchema,
  batchRegistryDigest: digestSchema,
  perAttemptAliasVerificationRoot: digestSchema,
  registryBridgeReceiptDigest: digestSchema,
  attemptRegistryRoot: digestSchema,
  reviewPlanRoot: digestSchema,
  reviewLedgerRoot: digestSchema,
  classificationRoot: digestSchema,
  pairwisePlanRoot: digestSchema,
  pairwisePreferenceRoot: digestSchema,
  pairwisePreferenceSealRoot: digestSchema,
  unblindedPairwiseReportRoot: digestSchema,
  attemptMetricsRoot: digestSchema,
  spendLedgerRoot: digestSchema,
  spendExternalAnchorRoot: digestSchema,
  artifactCompletenessRoot: digestSchema,
  failureTaxonomyDigest: digestSchema,
}).strict();

const spendUsageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  uncachedInputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict().superRefine((usage, context) => {
  if (usage.inputTokens !== usage.uncachedInputTokens + usage.cachedInputTokens + usage.cacheWriteInputTokens) {
    context.addIssue({ code: "custom", path: ["inputTokens"], message: "Spend input token classes must reconcile." });
  }
  if (usage.totalTokens !== usage.inputTokens + usage.outputTokens || usage.reasoningTokens > usage.outputTokens) {
    context.addIssue({ code: "custom", path: ["totalTokens"], message: "Spend output and total tokens must reconcile." });
  }
});

const spendCategorySchema = z.object({
  maximumCalls: z.number().int().nonnegative(),
  selectedCalls: z.number().int().nonnegative(),
  begunCalls: z.number().int().nonnegative(),
  notBegunSelectedCalls: z.number().int().nonnegative(),
  observedUsageReceipts: z.number().int().nonnegative(),
  attestedNoProviderCallSettlements: z.number().int().nonnegative(),
  unsettledOrUnobservableBegunCalls: z.number().int().nonnegative(),
  observedUsage: spendUsageTotalsSchema,
  observedCostUsd: z.number().finite().nonnegative(),
  conservativeReservedCostUsd: z.number().finite().nonnegative(),
  accountedCostUsd: z.number().finite().nonnegative(),
  unobservableReasonCounts: z.record(z.string().min(1), z.number().int().positive()),
  status: z.enum(["complete", "partial", "unobservable"]),
}).strict().superRefine((category, context) => {
  if (category.selectedCalls > category.maximumCalls
      || category.begunCalls > category.selectedCalls
      || category.notBegunSelectedCalls !== category.selectedCalls - category.begunCalls
      || category.observedUsageReceipts + category.attestedNoProviderCallSettlements
        + category.unsettledOrUnobservableBegunCalls !== category.begunCalls) {
    context.addIssue({ code: "custom", message: "Spend call denominators do not reconcile." });
  }
  if (Math.abs(category.accountedCostUsd - category.observedCostUsd - category.conservativeReservedCostUsd) > 1e-9) {
    context.addIssue({ code: "custom", path: ["accountedCostUsd"], message: "Spend observed and reserved costs do not reconcile." });
  }
  if (category.unsettledOrUnobservableBegunCalls > 0 && category.conservativeReservedCostUsd <= 0) {
    context.addIssue({ code: "custom", path: ["conservativeReservedCostUsd"], message: "Every begun call without usage must reserve a positive frozen cap." });
  }
  const expectedStatus = category.begunCalls === 0 ? "unobservable"
    : category.unsettledOrUnobservableBegunCalls === 0 ? "complete" : "partial";
  if (category.status !== expectedStatus) {
    context.addIssue({ code: "custom", path: ["status"], message: "Spend observability status does not match retained receipts." });
  }
});

const experimentSpendAccountingSchema = z.object({
  policy: z.literal("observed-provider-receipts-plus-frozen-cap-for-every-begun-call-without-usage"),
  preProviderCumulativeInputHardCapEnforced: z.literal(true),
  authorLongContextPricing: z.object({
    thresholdInputTokensPerTurn: z.literal(272000),
    inputRateMultiplier: z.literal(2),
    outputRateMultiplier: z.literal(1.5),
    observedCostBasis: z.literal("sum-of-retained-per-turn-usage-with-threshold-pricing"),
  }).strict(),
  authorizedMaximumUsd: z.number().finite().positive().max(487.2),
  authorizationReceiptDigest: digestSchema,
  remainingAuthorizedExposureUsd: z.number().finite().nonnegative(),
  spendLedgerRoot: digestSchema,
  spendExternalAnchorRoot: digestSchema,
  spendExternalAnchorCount: z.number().int().nonnegative(),
  authors: spendCategorySchema,
  primaryReviews: spendCategorySchema,
  adjudications: spendCategorySchema,
  pairwisePreferences: spendCategorySchema,
  total: spendCategorySchema,
}).strict().superRefine((spend, context) => {
  const categories = [spend.authors, spend.primaryReviews, spend.adjudications, spend.pairwisePreferences];
  const fixed = [
    [spend.authors, 48, 48],
    [spend.primaryReviews, 96, 96],
    [spend.adjudications, 48, null],
    [spend.pairwisePreferences, 24, 24],
  ] as const;
  for (const [category, maximumCalls, selectedCalls] of fixed) {
    if (category.maximumCalls !== maximumCalls || (selectedCalls !== null && category.selectedCalls !== selectedCalls)) {
      context.addIssue({ code: "custom", message: "Spend category does not retain the frozen call universe." });
    }
  }
  for (const key of [
    "maximumCalls", "selectedCalls", "begunCalls", "notBegunSelectedCalls",
    "observedUsageReceipts", "attestedNoProviderCallSettlements", "unsettledOrUnobservableBegunCalls",
  ] as const) {
    if (spend.total[key] !== categories.reduce((sum, category) => sum + category[key], 0)) {
      context.addIssue({ code: "custom", path: ["total", key], message: "Total spend denominator does not reconcile." });
    }
  }
  for (const key of ["observedCostUsd", "conservativeReservedCostUsd", "accountedCostUsd"] as const) {
    const expected = categories.reduce((sum, category) => sum + category[key], 0);
    if (Math.abs(spend.total[key] - expected) > 1e-9) {
      context.addIssue({ code: "custom", path: ["total", key], message: "Total spend cost does not reconcile." });
    }
  }
  for (const key of Object.keys(spend.total.observedUsage) as Array<keyof typeof spend.total.observedUsage>) {
    if (spend.total.observedUsage[key] !== categories.reduce((sum, category) => sum + category.observedUsage[key], 0)) {
      context.addIssue({ code: "custom", path: ["total", "observedUsage", key], message: "Total spend usage does not reconcile." });
    }
  }
  if (spend.total.accountedCostUsd > spend.authorizedMaximumUsd + 1e-9
      || Math.abs(spend.remainingAuthorizedExposureUsd
        - (spend.authorizedMaximumUsd - spend.total.accountedCostUsd)) > 1e-9) {
    context.addIssue({ code: "custom", path: ["remainingAuthorizedExposureUsd"], message: "Spend exposure does not reconcile to the frozen global authorization." });
  }
});

export type Exp0001aExperimentSpendAccounting = z.infer<typeof experimentSpendAccountingSchema>;

export const exp0001aAnalysisInputSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("exp-0001a-normalized-analysis-input"),
  protocolId: z.literal("EXP-0001A"),
  sourceRoots: sourceRootsSchema,
  manifest: z.unknown(),
  attempts: z.array(attemptAnalysisSchema).length(48),
  preferences: z.array(preferenceSchema).length(24),
  experimentSpendAccounting: experimentSpendAccountingSchema,
}).strict();

export type Exp0001aAnalysisInput = z.infer<typeof exp0001aAnalysisInputSchema>;
export type Exp0001aAttemptAnalysis = z.infer<typeof attemptAnalysisSchema>;
export type Exp0001aPreference = z.infer<typeof preferenceSchema>;

export function computeExp0001aPreferenceMappingDigest(
  preference: Pick<Exp0001aPreference, "pairId" | "leftAttemptId" | "rightAttemptId" | "leftOpaqueLabel" | "rightOpaqueLabel">,
): string {
  return hashCanonicalJson({
    pairId: preference.pairId,
    leftAttemptId: preference.leftAttemptId,
    rightAttemptId: preference.rightAttemptId,
    leftOpaqueLabel: preference.leftOpaqueLabel,
    rightOpaqueLabel: preference.rightOpaqueLabel,
  });
}

type LabelSummary = {
  successCount: number;
  denominator: number;
  successRate: number;
};

type TaskClusterSignFlipInference = {
  inferenceRole: "primary_investigation_decision";
  method: "exact_two_sided_complete_task_vector_sign_flip";
  taskCount: number;
  replicatesPerTask: 2;
  permutationCount: number;
  observedSignedSum: number | null;
  observedMeanPerPair: number | null;
  exactTwoSidedPValue: number | null;
  evaluation: "evaluable" | "not_evaluable";
  nonEvaluableReason: string | null;
};

export type Exp0001aPairedSuccessStratum = {
  pairCount: number;
  taskCount: number;
  attemptCount: number;
  A0: LabelSummary;
  A1: LabelSummary;
  cells: {
    bothSuccess: number;
    a0OnlySuccess: number;
    a1OnlySuccess: number;
    bothFail: number;
  };
  absoluteDifferenceA1MinusA0: number;
  /** @deprecated Pair-level McNemar is retained only as a descriptive sensitivity. */
  exactPairedPValue: number;
  exactPairedPValueRole: "descriptive_only_naive_pair_level_mcnemar";
  taskClusterSignFlip: TaskClusterSignFlipInference;
  descriptiveDifference95Interval: ConfidenceInterval;
};

type PreferenceDiagnostics = {
  pairCount: number;
  a0Wins: number;
  a1Wins: number;
  ties: number;
  failedComparisons: number;
  failureCodes: Record<string, number>;
  nonTieCount: number;
  a1WinRateAmongNonTies: number | null;
  /** @deprecated Non-tie pair-level sign testing is descriptive only. */
  exactTwoSidedSignPValue: number | null;
  exactTwoSidedSignPValueRole: "descriptive_only_naive_non_tie_pair_level_sign_test";
  rateAlarmEvaluation: "evaluable" | "not_evaluable";
  taskClusterSignFlip: TaskClusterSignFlipInference;
};

type ProviderIdentityDenominator = {
  expectedRecords: number;
  observedRecords: number;
  unobservableRecords: number;
  falsifiedRecords: number;
  evaluation: "evaluable" | "not_evaluable";
};

type ProviderIdentityDiagnostics = {
  policy: "any_unobservable_or_falsified_identity_makes_provider_dependent_calibration_non_evaluable";
  providerDependentCalibrationEvaluation: "evaluable" | "not_evaluable";
  authors: ProviderIdentityDenominator;
  primaryScorers: ProviderIdentityDenominator;
  adjudicators: ProviderIdentityDenominator;
  pairwiseJudges: ProviderIdentityDenominator;
  observedModelStability: {
    authors: ResolvedModelStability;
    individualScorers: ResolvedModelStability;
    pairwiseJudges: ResolvedModelStability;
  };
};

type ResolvedModelStability = {
  status: "stable" | "mixed" | "unobservable";
  stableObservedModelIdentifier: string | null;
  observedModelIdentifierCounts: Record<string, number>;
  observedIdentifierCount: number;
  interpretation: string;
};

type PlanningInterval = {
  lower: number;
  upper: number;
  level: 0.95;
  method: "wilson_score" | "deterministic_task_cluster_percentile_bootstrap" | "predeclared_nonestimable_fallback";
  draws: number;
  seed: number;
};

type ReviewerDiagnostics = {
  artifactCount: number;
  primaryReviewCallCount: number;
  primaryScorerFailureCount: number;
  primaryScorerFailureRate: number;
  primaryScorerFailureCodes: Record<string, number>;
  fullyScoredArtifactCount: number;
  agreementCount: number;
  disagreementCount: number;
  rawAgreement: number | null;
  classAgreementCount: number;
  classAgreementRate: number | null;
  cohenKappa: number | null;
  kappaEstimable: boolean;
  agreementAlarmEvaluation: "evaluable" | "not_evaluable";
  kappaAlarmEvaluation: "evaluable" | "not_evaluable";
  confusion: { bothAccept: number; firstOnlyAccept: number; secondOnlyAccept: number; bothReject: number };
  adjudicationCount: number;
  adjudicationRate: number;
  adjudicationScorerFailureCount: number;
  adjudicationScorerFailureCodes: Record<string, number>;
};

type MeasurementContextRoleSummary = {
  fixedCallCount: number;
  scoredCount: number;
  acceptanceCount: number;
  acceptanceRateAmongScored: number | null;
  failureCount: number;
  failureRate: number;
};

type MeasurementContextDiagnostics = {
  scope: "fixed_primary_review_calls_only";
  expectedAssignment: "first_ordered_primary_measurement_second_ordered_primary_standard";
  causalAttributionPermitted: false;
  interpretation: string;
  coverage: {
    expectedMeasurementCalls: 48;
    expectedStandardCalls: 48;
    observedMeasurementCalls: number;
    observedStandardCalls: number;
    correctlyPositionedArtifactCount: number;
    roleCoverageStatus: "complete" | "drifted";
  };
  measurement: MeasurementContextRoleSummary;
  standard: MeasurementContextRoleSummary;
  descriptiveAcceptanceRateDifferenceMeasurementMinusStandard: number | null;
  differenceEvaluation: "evaluable" | "not_evaluable";
};

type ArtifactCompleteness = {
  definition: "observed_required_cells_divided_by_all_required_cells";
  unobservablePolicy: "retained_separately_and_not_counted_as_observed";
  requiredFieldIds: readonly string[];
  attemptCount: number;
  requiredCellCount: number;
  observedCellCount: number;
  unobservableCellCount: number;
  missingCellCount: number;
  completenessRate: number;
  byField: Array<{ fieldId: string; observed: number; unobservable: number; missing: number; completenessRate: number }>;
  byLabel: Record<"A0" | "A1", { required: number; observed: number; unobservable: number; missing: number; completenessRate: number }>;
};

type ResourceRatioSummary = {
  metric: "latencyMs" | "tokens" | "toolCalls" | "costUsd";
  plannedPairCount: number;
  observedPairCount: number;
  unobservablePairCount: number;
  unobservablePairs: Array<{ pairId: string; reasons: string[] }>;
  status: "complete" | "partial" | "unobservable";
  alarmEvaluation: "evaluable" | "not_evaluable";
  medianA0: number | null;
  medianA1: number | null;
  medianPairedRatioA1OverA0: number | null;
  descriptiveRatio95Interval: ConfidenceInterval | null;
};

export type Exp0001aAlarm = {
  code: string;
  rule: string;
  evaluation: "evaluated" | "not_evaluable";
  observed: number | null;
  triggered: boolean;
};

export type Exp0001aAnalysisReport = {
  schemaVersion: "exp-0001a-analysis/v1";
  kind: "exp-0001a-aa-calibration-report";
  protocolId: "EXP-0001A";
  purpose: "calibration_only";
  claimPolicy: {
    improvementClaimPermitted: false;
    equivalenceClaimPermitted: false;
    permittedClaim: string;
  };
  provenance: {
    manifestDigest: string;
    analysisInputDigest: string;
    normalizedAttemptsRoot: string;
    normalizedPreferencesRoot: string;
    sourceRoots: z.infer<typeof sourceRootsSchema>;
  };
  integrity: {
    exactManifestReconciliation: true;
    exactAttemptCount: 48;
    exactPairCount: 24;
    exclusionsPermitted: false;
    exclusionCount: 0;
    identicalTreatmentDigest: string;
  };
  providerModelIdentity: {
    requestedModelIdentifier: "gpt-5.6-sol";
    immutableWeightSnapshotAsserted: false;
    responseModelAndServiceTierRetentionRequired: true;
    observedAttempts: number;
    unobservableAttempts: number;
    falsifiedAttempts: number;
    nonDefaultServiceTierAttempts: number;
    observedModelIdentifierCounts: Record<string, number>;
    observedServiceTierCounts: Record<string, number>;
    interpretation: string;
  };
  providerIdentityDiagnostics: ProviderIdentityDiagnostics;
  runAccounting: {
    plannedAttempts: 48;
    retainedAttempts: 48;
    plannedPairs: 24;
    reconciledPairs: 24;
    byLabel: Record<"A0" | "A1", number>;
    executorOutcomeCounts: Record<string, number>;
    retainedStatusCounts: Record<string, number>;
    authorOutcomeCounts: Record<string, number>;
    incidentCodeCounts: Record<string, number>;
  };
  pairedSuccess: {
    overall: Exp0001aPairedSuccessStratum;
    byTaskFamily: Record<string, Exp0001aPairedSuccessStratum>;
  };
  reviewerDiagnostics: ReviewerDiagnostics;
  measurementContextDiagnostics: MeasurementContextDiagnostics;
  preferenceDiagnostics: PreferenceDiagnostics;
  artifactCompleteness: ArtifactCompleteness;
  taxonomy: {
    primaryClassCounts: Record<string, number>;
    primaryClassCountsByLabel: Record<"A0" | "A1", Record<string, number>>;
    mechanismTagCounts: Record<string, number>;
    mechanismTagAttemptCounts: Record<string, number>;
    retainedStatusCounts: Record<string, number>;
    executorOutcomeCounts: Record<string, number>;
    incidentCodeCounts: Record<string, number>;
    incidentStatusCounts: Record<string, number>;
    evaluatorFailureCodeCounts: Record<string, number>;
    hardIncidentAttemptCount: number;
    falsificationAttemptCount: number;
  };
  experimentSpendAccounting: Exp0001aExperimentSpendAccounting;
  resourceRatios: Record<"latencyMs" | "tokens" | "toolCalls" | "costUsd", ResourceRatioSummary>;
  orderAndTimeDiagnostics: {
    firstLabelCounts: Record<"A0" | "A1", number>;
    byOrderIndex: Record<"0" | "1", Record<"A0" | "A1", LabelSummary>>;
    byTimeQuartile: Array<{
      quartile: 1 | 2 | 3 | 4;
      timeBlockStart: number;
      timeBlockEnd: number;
      A0: LabelSummary;
      A1: LabelSummary;
      absoluteDifferenceA1MinusA0: number;
    }>;
    blocks: Array<{
      timeBlock: number;
      pairId: string;
      firstLabel: "A0" | "A1";
      a0Accepted: boolean;
      a1Accepted: boolean;
      signedDifferenceA1MinusA0: -1 | 0 | 1;
    }>;
  };
  alarms: {
    thresholds: typeof EXP0001A_ANALYSIS_THRESHOLDS;
    checks: Exp0001aAlarm[];
    triggeredCodes: string[];
    requiresInvestigation: boolean;
  };
  sealedSampleSensitivity: {
    source: "frozen_hypothetical_public_planning_only";
    sealedTaskDataAccessed: false;
    scenarioInputsDigest: string;
    hypotheticalRowsRole: "non_recommendation_diagnostics_only";
    selectedDesignSource: "observed_aa_uncertainty_aware_search_only";
    selectedDesignTest: "two_sided_task_cluster_sign_flip_normal_approximation";
    rows: SealedSamplePlanRow[];
    observedAaCalibrated: {
      source: "development_aa_outcomes_with_externally_fixed_candidate_lifts";
      sealedTaskDataAccessed: false;
      uncertainty: "exploratory-small-sample-24-pairs-12-tasks-not-confirmatory";
      estimates: {
        pooledSuccessRate: number;
        pooledSuccessRate95Interval: PlanningInterval;
        pairedDiscordanceRate: number;
        pairedDiscordanceRate95Interval: PlanningInterval;
        signedPairDifferenceVariance: number;
        taskMeanDifferenceVariance: number;
        intrataskCorrelation: number | null;
        intrataskCorrelation95Interval: PlanningInterval;
        dependenceIntervalBootstrap: {
          method: "deterministic_task_cluster_percentile_bootstrap";
          seed: number;
          draws: number;
        };
        pairCount: 24;
        taskCount: 12;
        replicatesPerTask: 2;
      };
      planningPolicy: {
        candidateLiftsAreExternallyFixed: true;
        candidateLifts: readonly [0.08, 0.12, 0.15];
        discordanceBound: "max-upper-95-percent-interval-and-absolute-fixed-lift";
        minimumConservativeDiscordance: 0.30;
        negativeIccTruncatedToZero: true;
        conservativeIccBound: "max-upper-95-percent-bootstrap-interval-and-predeclared-floor";
        minimumConservativeIcc: 0.40;
        nonestimableIccFallback: 0.40;
        decisionTest: "two_sided_task_cluster_sign_flip_normal_approximation";
        targetLowerMonteCarlo95Power: 0.80;
        simulationsPerCandidate: number;
        taskIncrement: 1;
        familywiseMonteCarloPolicy: "one_sided_hoeffding_bound_with_bonferroni_over_fixed_candidate_universe";
        familywiseErrorProbability: 0.05;
        fixedCandidateUniverse: { minimumUniqueTasks: 30; maximumUniqueTasks: number; candidateCount: number };
        maximumUniqueTasks: number;
      };
      rows: Array<{
        candidateLift: number;
        status: "estimated" | "not_estimable";
        reason: string | null;
        planningBaselineRate: number;
        planningDiscordanceRate: number | null;
        planningIntrataskCorrelation: number;
        oneShotPlanRole: "diagnostic_only_not_recommended_sample_size";
        plan: SealedSamplePlanRow | null;
        recommendation: null | {
          status: "target_reached" | "maximum_exhausted";
          recommendedUniqueTasks: number | null;
          recommendedTotalPairs: number | null;
          startUniqueTasks: number;
          maximumUniqueTasks: number;
          simulationsPerCandidate: number;
          seedBase: number;
          decisionTest: "two_sided_task_cluster_sign_flip_normal_approximation";
          familywiseMonteCarloPolicy: "one_sided_hoeffding_bound_with_bonferroni_over_fixed_candidate_universe";
          familywiseErrorProbability: 0.05;
          fixedCandidateUniverseCount: number;
          trace: Array<{
            taskCount: number;
            totalPairs: number;
            simulations: number;
            seed: number;
            estimatedPower: number;
            pointwiseMonteCarlo95Interval: [number, number];
            simultaneousFamilywise95LowerBound: number;
            lowerBoundReachesTarget: boolean;
          }>;
        };
      }>;
    };
  };
  reportDigest: string;
};

type Reconciled = {
  manifest: DevelopmentExecutionManifest;
  attempts: Exp0001aAttemptAnalysis[];
  preferences: Exp0001aPreference[];
  pairs: Array<{
    pairId: string;
    taskId: string;
    taskFamily: "architecture" | "drawing";
    stratum: "creation" | "editing" | "stress";
    timeBlock: number;
    firstLabel: "A0" | "A1";
    A0: Exp0001aAttemptAnalysis;
    A1: Exp0001aAttemptAnalysis;
    preference: Exp0001aPreference;
  }>;
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareCodeUnits(left, right)));
}

function reconcile(input: Exp0001aAnalysisInput): Reconciled {
  const manifestVerification = verifyDevelopmentExecutionManifest(input.manifest);
  if (!manifestVerification.ok) {
    throw new Error(`EXP0001A_MANIFEST_INVALID:${manifestVerification.errors.join(",")}`);
  }
  const manifest = manifestVerification.manifest;
  if (input.sourceRoots.manifestDigest !== manifest.manifestDigest) {
    throw new Error("EXP0001A_MANIFEST_ROOT_MISMATCH");
  }
  if (input.sourceRoots.spendLedgerRoot !== input.experimentSpendAccounting.spendLedgerRoot) {
    throw new Error("EXP0001A_SPEND_LEDGER_ROOT_MISMATCH");
  }
  if (input.sourceRoots.spendExternalAnchorRoot !== input.experimentSpendAccounting.spendExternalAnchorRoot) {
    throw new Error("EXP0001A_SPEND_EXTERNAL_ANCHOR_ROOT_MISMATCH");
  }
  if (manifest.treatments.A0 !== manifest.treatments.A1) {
    throw new Error("EXP0001A_TREATMENT_DRIFT");
  }
  const attemptsById = new Map<string, Exp0001aAttemptAnalysis>();
  for (const attempt of input.attempts) {
    if (attemptsById.has(attempt.attemptId)) throw new Error(`EXP0001A_DUPLICATE_ATTEMPT:${attempt.attemptId}`);
    attemptsById.set(attempt.attemptId, attempt);
  }
  const preferencesByPair = new Map<string, Exp0001aPreference>();
  for (const preference of input.preferences) {
    if (preferencesByPair.has(preference.pairId)) throw new Error(`EXP0001A_DUPLICATE_PREFERENCE:${preference.pairId}`);
    preferencesByPair.set(preference.pairId, preference);
  }

  const pairs = manifest.assignments.map((assignment) => {
    const pairAttempts = assignment.attempts.map((expected) => {
      const actual = attemptsById.get(expected.attemptId);
      if (!actual) throw new Error(`EXP0001A_MISSING_ATTEMPT:${expected.attemptId}`);
      for (const [field, expectedValue] of Object.entries({
        pairId: assignment.pairId,
        taskId: assignment.taskId,
        taskFamily: assignment.taskFamily,
        stratum: assignment.stratum,
        opaqueLabel: expected.opaqueLabel,
        orderIndex: expected.orderIndex,
        timeBlock: assignment.timeBlock,
        treatmentDigest: expected.treatmentDigest,
      })) {
        if (actual[field as keyof Exp0001aAttemptAnalysis] !== expectedValue) {
          throw new Error(`EXP0001A_ATTEMPT_MAPPING_DRIFT:${expected.attemptId}:${field}`);
        }
      }
      return actual;
    });
    const A0 = pairAttempts.find((attempt) => attempt.opaqueLabel === "A0");
    const A1 = pairAttempts.find((attempt) => attempt.opaqueLabel === "A1");
    if (!A0 || !A1) throw new Error(`EXP0001A_PAIR_LABEL_COVERAGE_INVALID:${assignment.pairId}`);
    const preference = preferencesByPair.get(assignment.pairId);
    if (!preference) throw new Error(`EXP0001A_MISSING_PREFERENCE:${assignment.pairId}`);
    const expectedIds = [A0.attemptId, A1.attemptId].sort();
    const actualIds = [preference.leftAttemptId, preference.rightAttemptId].sort();
    if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) {
      throw new Error(`EXP0001A_PREFERENCE_PAIR_MAPPING_DRIFT:${assignment.pairId}`);
    }
    const labelById = new Map([[A0.attemptId, "A0"], [A1.attemptId, "A1"]] as const);
    if (preference.leftOpaqueLabel !== labelById.get(preference.leftAttemptId)
        || preference.rightOpaqueLabel !== labelById.get(preference.rightAttemptId)) {
      throw new Error(`EXP0001A_PREFERENCE_LABEL_MAPPING_DRIFT:${assignment.pairId}`);
    }
    if (preference.mappingDigest !== computeExp0001aPreferenceMappingDigest(preference)) {
      throw new Error(`EXP0001A_PREFERENCE_MAPPING_DIGEST_INVALID:${assignment.pairId}`);
    }
    return {
      pairId: assignment.pairId,
      taskId: assignment.taskId,
      taskFamily: assignment.taskFamily,
      stratum: assignment.stratum,
      timeBlock: assignment.timeBlock,
      firstLabel: assignment.order[0],
      A0,
      A1,
      preference,
    };
  });
  if (attemptsById.size !== 48 || preferencesByPair.size !== 24 || pairs.length !== 24) {
    throw new Error("EXP0001A_DENOMINATOR_RECONCILIATION_FAILED");
  }
  return {
    manifest,
    attempts: [...attemptsById.values()].sort((left, right) => left.timeBlock - right.timeBlock || left.orderIndex - right.orderIndex),
    preferences: [...preferencesByPair.values()].sort((left, right) => compareCodeUnits(left.pairId, right.pairId)),
    pairs: pairs.sort((left, right) => left.timeBlock - right.timeBlock),
  };
}

function labelSummary(attempts: readonly Exp0001aAttemptAnalysis[]): LabelSummary {
  const successCount = attempts.filter((attempt) => attempt.accepted).length;
  return { successCount, denominator: attempts.length, successRate: successCount / attempts.length };
}

function exactTaskClusterSignFlip(
  observations: readonly { taskId: string; signedValue: -1 | 0 | 1 | null }[],
): TaskClusterSignFlipInference {
  const byTask = new Map<string, Array<-1 | 0 | 1 | null>>();
  for (const observation of observations) {
    const values = byTask.get(observation.taskId) ?? [];
    values.push(observation.signedValue);
    byTask.set(observation.taskId, values);
  }
  const taskCount = byTask.size;
  const permutationCount = 2 ** taskCount;
  const incomplete = [...byTask.entries()].find(([, values]) => values.length !== 2);
  const unobservable = [...byTask.entries()].find(([, values]) => values.some((value) => value === null));
  if (incomplete || unobservable) {
    return {
      inferenceRole: "primary_investigation_decision",
      method: "exact_two_sided_complete_task_vector_sign_flip",
      taskCount,
      replicatesPerTask: 2,
      permutationCount,
      observedSignedSum: null,
      observedMeanPerPair: null,
      exactTwoSidedPValue: null,
      evaluation: "not_evaluable",
      nonEvaluableReason: incomplete
        ? `Task ${incomplete[0]} does not retain its complete two-replicate vector.`
        : `Task ${unobservable![0]} contains a failed or otherwise unobservable comparison.`,
    };
  }
  const taskSums = [...byTask.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, values]) => (values[0] as number) + (values[1] as number));
  const observedSignedSum = taskSums.reduce((sum, value) => sum + value, 0);
  let atLeastAsExtreme = 0;
  for (let assignment = 0; assignment < permutationCount; assignment += 1) {
    const randomizedSum = taskSums.reduce((sum, value, index) => (
      sum + ((assignment >>> index) & 1 ? value : -value)
    ), 0);
    if (Math.abs(randomizedSum) >= Math.abs(observedSignedSum)) atLeastAsExtreme += 1;
  }
  return {
    inferenceRole: "primary_investigation_decision",
    method: "exact_two_sided_complete_task_vector_sign_flip",
    taskCount,
    replicatesPerTask: 2,
    permutationCount,
    observedSignedSum,
    observedMeanPerPair: observations.length === 0 ? 0 : observedSignedSum / observations.length,
    exactTwoSidedPValue: atLeastAsExtreme / permutationCount,
    evaluation: "evaluable",
    nonEvaluableReason: null,
  };
}

function pairedSuccessStratum(pairs: readonly Reconciled["pairs"][number][]): Exp0001aPairedSuccessStratum {
  const summary = summarizePairedBinary(pairs.map((pair) => ({
    pairId: pair.pairId,
    taskId: pair.taskId,
    taskFamily: pair.taskFamily,
    baselineAccepted: pair.A0.accepted,
    candidateAccepted: pair.A1.accepted,
  })), { bootstrapDraws: 10_000, seed: 20_260_830 });
  return {
    pairCount: summary.pairCount,
    taskCount: summary.taskCount,
    attemptCount: summary.pairCount * 2,
    A0: {
      successCount: summary.baselineAcceptedCount,
      denominator: summary.pairCount,
      successRate: summary.baselinePassRate,
    },
    A1: {
      successCount: summary.candidateAcceptedCount,
      denominator: summary.pairCount,
      successRate: summary.candidatePassRate,
    },
    cells: {
      bothSuccess: summary.concordantSuccessCount,
      a0OnlySuccess: summary.baselineOnlySuccessCount,
      a1OnlySuccess: summary.candidateOnlySuccessCount,
      bothFail: summary.concordantFailureCount,
    },
    absoluteDifferenceA1MinusA0: summary.absoluteDifference,
    exactPairedPValue: summary.exactMcNemarPValue,
    exactPairedPValueRole: "descriptive_only_naive_pair_level_mcnemar",
    taskClusterSignFlip: exactTaskClusterSignFlip(pairs.map((pair) => ({
      taskId: pair.taskId,
      signedValue: (Number(pair.A1.accepted) - Number(pair.A0.accepted)) as -1 | 0 | 1,
    }))),
    descriptiveDifference95Interval: summary.absoluteDifferenceConfidenceInterval,
  };
}

function exactTwoSidedSignPValue(wins: number, losses: number): number {
  const trials = wins + losses;
  if (trials === 0) return 1;
  const lower = Math.min(wins, losses);
  let mass = 2 ** -trials;
  let cumulative = mass;
  for (let count = 1; count <= lower; count += 1) {
    mass *= (trials - count + 1) / count;
    cumulative += mass;
  }
  return Math.min(1, cumulative * 2);
}

function preferenceDiagnostics(pairs: readonly Reconciled["pairs"][number][]): PreferenceDiagnostics {
  let a0Wins = 0;
  let a1Wins = 0;
  let ties = 0;
  const failures: string[] = [];
  for (const pair of pairs) {
    const preference = pair.preference;
    if (preference.outcome === "failed") {
      failures.push(preference.failureCode as string);
      continue;
    }
    if (preference.outcome === "tie") {
      ties += 1;
      continue;
    }
    const winningLabel = preference.outcome === "left" ? preference.leftOpaqueLabel : preference.rightOpaqueLabel;
    if (winningLabel === "A1") a1Wins += 1;
    else a0Wins += 1;
  }
  const nonTieCount = a0Wins + a1Wins;
  const rateAlarmEvaluation = failures.length === 0 && nonTieCount > 0 ? "evaluable" : "not_evaluable";
  const taskClusterSignFlip = exactTaskClusterSignFlip(pairs.map((pair) => {
    const preference = pair.preference;
    if (preference.outcome === "failed") return { taskId: pair.taskId, signedValue: null };
    if (preference.outcome === "tie") return { taskId: pair.taskId, signedValue: 0 as const };
    const winningLabel = preference.outcome === "left" ? preference.leftOpaqueLabel : preference.rightOpaqueLabel;
    return { taskId: pair.taskId, signedValue: winningLabel === "A1" ? 1 as const : -1 as const };
  }));
  return {
    pairCount: pairs.length,
    a0Wins,
    a1Wins,
    ties,
    failedComparisons: failures.length,
    failureCodes: countBy(failures),
    nonTieCount,
    a1WinRateAmongNonTies: nonTieCount === 0 ? null : a1Wins / nonTieCount,
    exactTwoSidedSignPValue: nonTieCount === 0 ? null : exactTwoSidedSignPValue(a1Wins, a0Wins),
    exactTwoSidedSignPValueRole: "descriptive_only_naive_non_tie_pair_level_sign_test",
    rateAlarmEvaluation,
    taskClusterSignFlip,
  };
}

function safeRate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function reviewerDiagnostics(attempts: readonly Exp0001aAttemptAnalysis[]): ReviewerDiagnostics {
  const primaryScorerFailureCount = attempts.flatMap((attempt) => attempt.primaryReviews)
    .filter((review) => review.status === "failed").length;
  const primaryScorerFailureCodes = countBy(attempts.flatMap((attempt) => attempt.primaryReviews)
    .flatMap((review) => review.status === "failed" ? [review.failureCode] : []));
  const fullyScored = attempts.filter((attempt) => attempt.primaryReviews.every((review) => review.status === "scored"));
  let bothAccept = 0;
  let firstOnlyAccept = 0;
  let secondOnlyAccept = 0;
  let bothReject = 0;
  let classAgreementCount = 0;
  for (const attempt of fullyScored) {
    const [first, second] = attempt.primaryReviews;
    if (first.status !== "scored" || second.status !== "scored") continue;
    if (first.accepted && second.accepted) bothAccept += 1;
    else if (first.accepted) firstOnlyAccept += 1;
    else if (second.accepted) secondOnlyAccept += 1;
    else bothReject += 1;
    if (first.primaryFailureClass === second.primaryFailureClass) classAgreementCount += 1;
  }
  const agreementCount = bothAccept + bothReject;
  const fullyScoredCount = fullyScored.length;
  const rawAgreement = safeRate(agreementCount, fullyScoredCount);
  const firstAcceptance = safeRate(bothAccept + firstOnlyAccept, fullyScoredCount);
  const secondAcceptance = safeRate(bothAccept + secondOnlyAccept, fullyScoredCount);
  const expectedAgreement = firstAcceptance === null || secondAcceptance === null ? null
    : firstAcceptance * secondAcceptance + (1 - firstAcceptance) * (1 - secondAcceptance);
  const kappaEstimable = rawAgreement !== null && expectedAgreement !== null && expectedAgreement < 1;
  const cohenKappa = kappaEstimable
    ? ((rawAgreement as number) - (expectedAgreement as number)) / (1 - (expectedAgreement as number))
    : null;
  const adjudications = attempts.filter((attempt) => attempt.adjudication !== null);
  const failedAdjudications = adjudications.flatMap((attempt) => (
    attempt.adjudication?.status === "failed" ? [attempt.adjudication] : []
  ));
  return {
    artifactCount: attempts.length,
    primaryReviewCallCount: attempts.length * 2,
    primaryScorerFailureCount,
    primaryScorerFailureRate: primaryScorerFailureCount / (attempts.length * 2),
    primaryScorerFailureCodes,
    fullyScoredArtifactCount: fullyScoredCount,
    agreementCount,
    disagreementCount: fullyScoredCount - agreementCount,
    rawAgreement,
    classAgreementCount,
    classAgreementRate: safeRate(classAgreementCount, fullyScoredCount),
    cohenKappa,
    kappaEstimable,
    agreementAlarmEvaluation: primaryScorerFailureCount === 0 && rawAgreement !== null ? "evaluable" : "not_evaluable",
    kappaAlarmEvaluation: primaryScorerFailureCount === 0 && kappaEstimable ? "evaluable" : "not_evaluable",
    confusion: { bothAccept, firstOnlyAccept, secondOnlyAccept, bothReject },
    adjudicationCount: adjudications.length,
    adjudicationRate: adjudications.length / attempts.length,
    adjudicationScorerFailureCount: failedAdjudications.length,
    adjudicationScorerFailureCodes: countBy(failedAdjudications.map((review) => review.failureCode)),
  };
}

function measurementContextRoleSummary(
  reviews: readonly Exp0001aAttemptAnalysis["primaryReviews"][number][],
): MeasurementContextRoleSummary {
  const scored = reviews.filter((review) => review.status === "scored");
  const failureCount = reviews.length - scored.length;
  const acceptanceCount = scored.filter((review) => review.accepted).length;
  return {
    fixedCallCount: reviews.length,
    scoredCount: scored.length,
    acceptanceCount,
    acceptanceRateAmongScored: safeRate(acceptanceCount, scored.length),
    failureCount,
    failureRate: reviews.length === 0 ? 0 : failureCount / reviews.length,
  };
}

function measurementContextDiagnostics(
  attempts: readonly Exp0001aAttemptAnalysis[],
): MeasurementContextDiagnostics {
  const primaries = attempts.flatMap((attempt) => attempt.primaryReviews);
  const measurementReviews = primaries.filter((review) => review.measurementRole === "measurement");
  const standardReviews = primaries.filter((review) => review.measurementRole === "standard");
  const correctlyPositionedArtifactCount = attempts.filter((attempt) => (
    attempt.primaryReviews[0].measurementRole === "measurement"
      && attempt.primaryReviews[1].measurementRole === "standard"
  )).length;
  const roleCoverageStatus = measurementReviews.length === 48
    && standardReviews.length === 48
    && correctlyPositionedArtifactCount === 48
    ? "complete" as const
    : "drifted" as const;
  const measurement = measurementContextRoleSummary(measurementReviews);
  const standard = measurementContextRoleSummary(standardReviews);
  const differenceEvaluation = roleCoverageStatus === "complete"
    && measurement.failureCount === 0
    && standard.failureCount === 0
    && measurement.acceptanceRateAmongScored !== null
    && standard.acceptanceRateAmongScored !== null
    ? "evaluable" as const
    : "not_evaluable" as const;
  return {
    scope: "fixed_primary_review_calls_only",
    expectedAssignment: "first_ordered_primary_measurement_second_ordered_primary_standard",
    causalAttributionPermitted: false,
    interpretation: "This context contrast is descriptive only: the measurement packet was assigned by ordered primary role, not randomized independently of reviewer identity or review order, so it cannot identify a causal packet effect.",
    coverage: {
      expectedMeasurementCalls: 48,
      expectedStandardCalls: 48,
      observedMeasurementCalls: measurementReviews.length,
      observedStandardCalls: standardReviews.length,
      correctlyPositionedArtifactCount,
      roleCoverageStatus,
    },
    measurement,
    standard,
    descriptiveAcceptanceRateDifferenceMeasurementMinusStandard: differenceEvaluation === "evaluable"
      ? (measurement.acceptanceRateAmongScored as number) - (standard.acceptanceRateAmongScored as number)
      : null,
    differenceEvaluation,
  };
}

function providerIdentityDenominator(
  expectedRecords: number,
  identities: ReadonlyArray<{ status: "observed" | "unobservable" | "falsified" } | null>,
): ProviderIdentityDenominator {
  if (identities.length !== expectedRecords) {
    throw new Error("EXP0001A_PROVIDER_IDENTITY_DENOMINATOR_MISMATCH");
  }
  const observedRecords = identities.filter((identity) => identity?.status === "observed").length;
  const unobservableRecords = identities.filter((identity) => identity === null || identity.status === "unobservable").length;
  const falsifiedRecords = identities.filter((identity) => identity?.status === "falsified").length;
  return {
    expectedRecords,
    observedRecords,
    unobservableRecords,
    falsifiedRecords,
    evaluation: unobservableRecords === 0 && falsifiedRecords === 0 ? "evaluable" : "not_evaluable",
  };
}

function resolvedModelStability(observedModelIdentifiers: readonly string[]): ResolvedModelStability {
  const observedModelIdentifierCounts = countBy(observedModelIdentifiers);
  const identifiers = Object.keys(observedModelIdentifierCounts).sort(compareCodeUnits);
  const status = identifiers.length === 0 ? "unobservable" as const
    : identifiers.length === 1 ? "stable" as const
      : "mixed" as const;
  return {
    status,
    stableObservedModelIdentifier: status === "stable" ? identifiers[0] : null,
    observedModelIdentifierCounts,
    observedIdentifierCount: observedModelIdentifiers.length,
    interpretation: status === "stable"
      ? "All retained responses in this phase returned one stable provider-resolved model identifier; this does not establish immutable weights."
      : status === "mixed"
        ? "Retained responses in this phase returned multiple provider-resolved model identifiers, so provider-dependent calibration is non-evaluable pending investigation."
        : "No provider-resolved model identifier was observable for this phase; immutable weights are not asserted.",
  };
}

function providerIdentityDiagnostics(reconciled: Reconciled): ProviderIdentityDiagnostics {
  const authors = providerIdentityDenominator(48, reconciled.attempts.map((attempt) => {
    const identity = attempt.providerIdentity;
    if (identity === null) return null;
    if (identity.status !== "observed") return { status: identity.status };
    if (identity.observedModelIdentifiers.length === 0 || identity.observedServiceTiers.length === 0) {
      return { status: "unobservable" as const };
    }
    return {
      status: identity.observedServiceTiers.some((tier) => tier !== "default")
        ? "falsified" as const
        : "observed" as const,
    };
  }));
  const primaryScorers = providerIdentityDenominator(
    96,
    reconciled.attempts.flatMap((attempt) => attempt.primaryReviews.map((review) => ({
      status: review.providerIdentity.status === "observed" && review.providerIdentity.observedServiceTier !== "default"
        ? "falsified" as const
        : review.providerIdentity.status,
    }))),
  );
  const adjudicationIdentities = reconciled.attempts.flatMap((attempt) => (
    attempt.adjudication === null ? [] : [{
      status: attempt.adjudication.providerIdentity.status === "observed"
        && attempt.adjudication.providerIdentity.observedServiceTier !== "default"
        ? "falsified" as const
        : attempt.adjudication.providerIdentity.status,
    }]
  ));
  const adjudicators = providerIdentityDenominator(adjudicationIdentities.length, adjudicationIdentities);
  const pairwiseJudges = providerIdentityDenominator(
    24,
    reconciled.preferences.map((preference) => ({
      status: preference.providerIdentity.status === "observed"
        && preference.providerIdentity.observedServiceTier !== "default"
        ? "falsified" as const
        : preference.providerIdentity.status,
    })),
  );
  const observedModelStability = {
    authors: resolvedModelStability(reconciled.attempts.flatMap((attempt) => (
      attempt.providerIdentity?.observedModelIdentifiers ?? []
    ))),
    individualScorers: resolvedModelStability(reconciled.attempts.flatMap((attempt) => [
      ...attempt.primaryReviews,
      ...(attempt.adjudication === null ? [] : [attempt.adjudication]),
    ].flatMap((review) => review.providerIdentity.observedModelIdentifier === null
      ? []
      : [review.providerIdentity.observedModelIdentifier]))),
    pairwiseJudges: resolvedModelStability(reconciled.preferences.flatMap((preference) => (
      preference.providerIdentity.observedModelIdentifier === null
        ? []
        : [preference.providerIdentity.observedModelIdentifier]
    ))),
  };
  const denominators = [authors, primaryScorers, adjudicators, pairwiseJudges];
  return {
    policy: "any_unobservable_or_falsified_identity_makes_provider_dependent_calibration_non_evaluable",
    providerDependentCalibrationEvaluation: denominators.every((denominator) => denominator.evaluation === "evaluable")
      && Object.values(observedModelStability).every((stability) => stability.status === "stable")
      ? "evaluable"
      : "not_evaluable",
    authors,
    primaryScorers,
    adjudicators,
    pairwiseJudges,
    observedModelStability,
  };
}

function artifactCompleteness(attempts: readonly Exp0001aAttemptAnalysis[]): ArtifactCompleteness {
  const allFields = attempts.flatMap((attempt) => attempt.artifactFields);
  const observedCellCount = allFields.filter((field) => field.status === "observed").length;
  const unobservableCellCount = allFields.filter((field) => field.status === "unobservable").length;
  const missingCellCount = allFields.filter((field) => field.status === "missing").length;
  const byField = EXP0001A_REQUIRED_ARTIFACT_FIELDS.map((fieldId) => {
    const fields = allFields.filter((field) => field.fieldId === fieldId);
    const observed = fields.filter((field) => field.status === "observed").length;
    const unobservable = fields.filter((field) => field.status === "unobservable").length;
    const missing = fields.filter((field) => field.status === "missing").length;
    return { fieldId, observed, unobservable, missing, completenessRate: observed / fields.length };
  });
  const byLabel = Object.fromEntries((["A0", "A1"] as const).map((label) => {
    const fields = attempts.filter((attempt) => attempt.opaqueLabel === label).flatMap((attempt) => attempt.artifactFields);
    const observed = fields.filter((field) => field.status === "observed").length;
    const unobservable = fields.filter((field) => field.status === "unobservable").length;
    const missing = fields.filter((field) => field.status === "missing").length;
    return [label, {
      required: fields.length,
      observed,
      unobservable,
      missing,
      completenessRate: observed / fields.length,
    }];
  })) as ArtifactCompleteness["byLabel"];
  return {
    definition: "observed_required_cells_divided_by_all_required_cells",
    unobservablePolicy: "retained_separately_and_not_counted_as_observed",
    requiredFieldIds: EXP0001A_REQUIRED_ARTIFACT_FIELDS,
    attemptCount: attempts.length,
    requiredCellCount: allFields.length,
    observedCellCount,
    unobservableCellCount,
    missingCellCount,
    completenessRate: observedCellCount / allFields.length,
    byField,
    byLabel,
  };
}

const RESOURCE_METRICS = ["latencyMs", "tokens", "toolCalls", "costUsd"] as const;

function resourceRatio(
  metric: typeof RESOURCE_METRICS[number],
  pairs: readonly Reconciled["pairs"][number][],
): ResourceRatioSummary {
  const observations: Array<{ pairId: string; taskId: string; baselineValue: number; candidateValue: number }> = [];
  const unobservablePairs: Array<{ pairId: string; reasons: string[] }> = [];
  for (const pair of pairs) {
    const A0 = pair.A0.resources[metric];
    const A1 = pair.A1.resources[metric];
    const reasons: string[] = [];
    if (A0.status === "unobservable") reasons.push(`A0:${A0.reason}`);
    else if (A0.value <= 0) reasons.push("A0:ratio requires a positive observed value");
    if (A1.status === "unobservable") reasons.push(`A1:${A1.reason}`);
    else if (A1.value <= 0) reasons.push("A1:ratio requires a positive observed value");
    if (reasons.length > 0) {
      unobservablePairs.push({ pairId: pair.pairId, reasons });
      continue;
    }
    observations.push({
      pairId: pair.pairId,
      taskId: pair.taskId,
      baselineValue: A0.value as number,
      candidateValue: A1.value as number,
    });
  }
  if (observations.length === 0) {
    return {
      metric,
      plannedPairCount: pairs.length,
      observedPairCount: 0,
      unobservablePairCount: unobservablePairs.length,
      unobservablePairs,
      status: "unobservable",
      alarmEvaluation: "not_evaluable",
      medianA0: null,
      medianA1: null,
      medianPairedRatioA1OverA0: null,
      descriptiveRatio95Interval: null,
    };
  }
  const summary = summarizePairedPositiveRatio(observations, { bootstrapDraws: 10_000, seed: 20_260_830 });
  return {
    metric,
    plannedPairCount: pairs.length,
    observedPairCount: observations.length,
    unobservablePairCount: unobservablePairs.length,
    unobservablePairs,
    status: observations.length === pairs.length ? "complete" : "partial",
    alarmEvaluation: observations.length === pairs.length ? "evaluable" : "not_evaluable",
    medianA0: summary.medianBaseline,
    medianA1: summary.medianCandidate,
    medianPairedRatioA1OverA0: summary.medianPairedRatio,
    descriptiveRatio95Interval: summary.medianPairedRatioConfidenceInterval,
  };
}

function alarm(
  code: string,
  rule: string,
  observed: number | null,
  triggered: boolean,
  evaluation: Exp0001aAlarm["evaluation"] = observed === null ? "not_evaluable" : "evaluated",
): Exp0001aAlarm {
  return { code, rule, evaluation, observed, triggered: evaluation === "evaluated" && triggered };
}

function analysisAlarms(
  success: Exp0001aPairedSuccessStratum,
  preference: PreferenceDiagnostics,
  reviewer: ReviewerDiagnostics,
  completeness: ArtifactCompleteness,
  ratios: Exp0001aAnalysisReport["resourceRatios"],
  identities: ProviderIdentityDiagnostics,
  measurementContext: MeasurementContextDiagnostics,
): Exp0001aAlarm[] {
  const thresholds = EXP0001A_ANALYSIS_THRESHOLDS;
  const preferenceRate = preference.a1WinRateAmongNonTies;
  const checks: Exp0001aAlarm[] = [
    alarm(
      "SUCCESS_ABSOLUTE_DIFFERENCE_GT_0_15",
      "abs(A1 - A0) > 0.15",
      Math.abs(success.absoluteDifferenceA1MinusA0),
      Math.abs(success.absoluteDifferenceA1MinusA0) > thresholds.maximumAbsoluteSuccessDifference,
    ),
    alarm(
      "SUCCESS_TASK_CLUSTER_SIGN_FLIP_P_LT_0_10",
      "exact two-sided complete-task-vector sign-flip p < 0.10",
      success.taskClusterSignFlip.exactTwoSidedPValue,
      success.taskClusterSignFlip.exactTwoSidedPValue !== null
        && success.taskClusterSignFlip.exactTwoSidedPValue < thresholds.maximumExactPairedPValueForAlarm,
      success.taskClusterSignFlip.evaluation === "evaluable" ? "evaluated" : "not_evaluable",
    ),
    alarm(
      "PREFERENCE_RATE_OUTSIDE_0_35_0_65",
      "A1 win rate among non-ties outside [0.35, 0.65]",
      preferenceRate,
      preferenceRate !== null && (
        preferenceRate < thresholds.minimumPreferenceWinRate
        || preferenceRate > thresholds.maximumPreferenceWinRate
      ),
      preference.rateAlarmEvaluation === "evaluable" ? "evaluated" : "not_evaluable",
    ),
    alarm(
      "PREFERENCE_TASK_CLUSTER_SIGN_FLIP_P_LT_0_10",
      "exact two-sided complete-task-vector preference sign-flip p < 0.10",
      preference.taskClusterSignFlip.exactTwoSidedPValue,
      preference.taskClusterSignFlip.exactTwoSidedPValue !== null
        && preference.taskClusterSignFlip.exactTwoSidedPValue < thresholds.maximumPreferencePValueForAlarm,
      preference.taskClusterSignFlip.evaluation === "evaluable" ? "evaluated" : "not_evaluable",
    ),
    alarm(
      "PREFERENCE_SCORER_FAILURES_PRESENT",
      "one or more of the 24 fixed pairwise preference records failed",
      preference.failedComparisons,
      preference.failedComparisons > 0,
    ),
    alarm(
      "REVIEWER_AGREEMENT_LT_0_80",
      "binary reviewer agreement < 0.80",
      reviewer.rawAgreement,
      reviewer.rawAgreement !== null && reviewer.rawAgreement < thresholds.minimumReviewerAgreement,
      reviewer.agreementAlarmEvaluation === "evaluable" ? "evaluated" : "not_evaluable",
    ),
    alarm(
      "COHEN_KAPPA_LT_0_60",
      "Cohen kappa < 0.60 when estimable",
      reviewer.cohenKappa,
      reviewer.cohenKappa !== null && reviewer.cohenKappa < thresholds.minimumCohenKappa,
      reviewer.kappaAlarmEvaluation === "evaluable" ? "evaluated" : "not_evaluable",
    ),
    alarm(
      "PRIMARY_SCORER_FAILURES_PRESENT",
      "one or more of the 96 fixed primary scorer calls failed",
      reviewer.primaryScorerFailureCount,
      reviewer.primaryScorerFailureCount > 0,
    ),
    alarm(
      "ADJUDICATION_RATE_GT_0_20",
      "adjudication rate > 0.20",
      reviewer.adjudicationRate,
      reviewer.adjudicationRate > thresholds.maximumAdjudicationRate,
    ),
    alarm(
      "ADJUDICATION_SCORER_FAILURES_PRESENT",
      "one or more selected adjudication scorer calls failed",
      reviewer.adjudicationScorerFailureCount,
      reviewer.adjudicationScorerFailureCount > 0,
    ),
    alarm(
      "ARTIFACT_COMPLETENESS_LT_0_95",
      "required artifact-field completeness < 0.95",
      completeness.completenessRate,
      completeness.completenessRate < thresholds.minimumArtifactCompleteness,
    ),
    alarm(
      "AUTHOR_PROVIDER_IDENTITY_UNOBSERVABLE_OR_FALSIFIED",
      "all 48 author provider identities must be observed and unfalsified",
      identities.authors.unobservableRecords + identities.authors.falsifiedRecords,
      identities.authors.evaluation === "not_evaluable",
    ),
    alarm(
      "PRIMARY_SCORER_IDENTITY_UNOBSERVABLE_OR_FALSIFIED",
      "all 96 primary scorer provider identities must be observed and unfalsified",
      identities.primaryScorers.unobservableRecords + identities.primaryScorers.falsifiedRecords,
      identities.primaryScorers.evaluation === "not_evaluable",
    ),
    alarm(
      "ADJUDICATOR_IDENTITY_UNOBSERVABLE_OR_FALSIFIED",
      "every selected adjudicator provider identity must be observed and unfalsified",
      identities.adjudicators.unobservableRecords + identities.adjudicators.falsifiedRecords,
      identities.adjudicators.evaluation === "not_evaluable",
    ),
    alarm(
      "PAIRWISE_JUDGE_IDENTITY_UNOBSERVABLE_OR_FALSIFIED",
      "all 24 pairwise judge provider identities must be observed and unfalsified",
      identities.pairwiseJudges.unobservableRecords + identities.pairwiseJudges.falsifiedRecords,
      identities.pairwiseJudges.evaluation === "not_evaluable",
    ),
    alarm(
      "PRIMARY_MEASUREMENT_CONTEXT_ROLE_COVERAGE_DRIFT",
      "every artifact must retain first-primary measurement context and second-primary standard context (48 calls each)",
      48 - measurementContext.coverage.correctlyPositionedArtifactCount,
      measurementContext.coverage.roleCoverageStatus === "drifted",
    ),
    alarm(
      "AUTHOR_RESOLVED_MODEL_VARIANCE",
      "author responses must retain one stable provider-resolved model identifier across the fixed phase",
      Object.keys(identities.observedModelStability.authors.observedModelIdentifierCounts).length,
      identities.observedModelStability.authors.status === "mixed",
    ),
    alarm(
      "INDIVIDUAL_SCORER_RESOLVED_MODEL_VARIANCE",
      "primary and adjudication responses must retain one stable provider-resolved model identifier across the individual-scorer phase",
      Object.keys(identities.observedModelStability.individualScorers.observedModelIdentifierCounts).length,
      identities.observedModelStability.individualScorers.status === "mixed",
    ),
    alarm(
      "PAIRWISE_JUDGE_RESOLVED_MODEL_VARIANCE",
      "pairwise responses must retain one stable provider-resolved model identifier across the fixed phase",
      Object.keys(identities.observedModelStability.pairwiseJudges.observedModelIdentifierCounts).length,
      identities.observedModelStability.pairwiseJudges.status === "mixed",
    ),
  ];
  for (const metric of RESOURCE_METRICS) {
    const observed = ratios[metric].medianPairedRatioA1OverA0;
    checks.push(alarm(
      `${metric.toUpperCase()}_RATIO_OUTSIDE_0_80_1_25`,
      `${metric} median paired A1/A0 ratio outside [0.80, 1.25]`,
      observed,
      observed !== null && (
        observed < thresholds.minimumPairedResourceRatio
        || observed > thresholds.maximumPairedResourceRatio
      ),
      ratios[metric].alarmEvaluation === "evaluable" ? "evaluated" : "not_evaluable",
    ));
  }
  return checks;
}

function taxonomy(attempts: readonly Exp0001aAttemptAnalysis[]): Exp0001aAnalysisReport["taxonomy"] {
  const primaryClassCounts = Object.fromEntries(FROZEN_PRIMARY_FAILURE_CLASSES.map((classification) => [
    classification,
    attempts.filter((attempt) => attempt.primaryFailureClass === classification).length,
  ]));
  const primaryClassCountsByLabel = Object.fromEntries((["A0", "A1"] as const).map((label) => [
    label,
    Object.fromEntries(FROZEN_PRIMARY_FAILURE_CLASSES.map((classification) => [
      classification,
      attempts.filter((attempt) => attempt.opaqueLabel === label && attempt.primaryFailureClass === classification).length,
    ])),
  ])) as Exp0001aAnalysisReport["taxonomy"]["primaryClassCountsByLabel"];
  const mechanisms = attempts.flatMap((attempt) => attempt.mechanismTags.map((mechanism) => mechanism.tag));
  const mechanismTagCounts = countBy(mechanisms);
  const mechanismTagAttemptCounts = countBy(attempts.flatMap((attempt) => [
    ...new Set(attempt.mechanismTags.map((mechanism) => mechanism.tag)),
  ]));
  const incidentAttempts = attempts.filter((attempt) => attempt.incidents.length > 0);
  return {
    primaryClassCounts,
    primaryClassCountsByLabel,
    mechanismTagCounts,
    mechanismTagAttemptCounts,
    retainedStatusCounts: countBy(attempts.map((attempt) => attempt.retainedStatus)),
    executorOutcomeCounts: countBy(attempts.map((attempt) => attempt.executorOutcome)),
    incidentCodeCounts: countBy(attempts.flatMap((attempt) => attempt.incidents.map((incident) => incident.code))),
    incidentStatusCounts: countBy(attempts.flatMap((attempt) => attempt.incidents.map((incident) => incident.status))),
    evaluatorFailureCodeCounts: countBy(attempts.flatMap((attempt) => [
      ...attempt.primaryReviews,
      ...(attempt.adjudication ? [attempt.adjudication] : []),
    ].flatMap((review) => review.status === "failed" ? [review.failureCode] : []))),
    hardIncidentAttemptCount: incidentAttempts.filter((attempt) => attempt.incidents.some((incident) => incident.hardIncident)).length,
    falsificationAttemptCount: incidentAttempts.filter((attempt) => attempt.incidents.some((incident) => incident.falsification)).length,
  };
}

function orderAndTime(pairs: readonly Reconciled["pairs"][number][]): Exp0001aAnalysisReport["orderAndTimeDiagnostics"] {
  const byOrderIndex = Object.fromEntries(([0, 1] as const).map((orderIndex) => [
    String(orderIndex),
    Object.fromEntries((["A0", "A1"] as const).map((label) => [
      label,
      labelSummary(pairs.map((pair) => pair[label]).filter((attempt) => attempt.orderIndex === orderIndex)),
    ])),
  ])) as Exp0001aAnalysisReport["orderAndTimeDiagnostics"]["byOrderIndex"];
  const byTimeQuartile = ([1, 2, 3, 4] as const).map((quartile) => {
    const start = (quartile - 1) * 6;
    const end = start + 5;
    const selected = pairs.filter((pair) => pair.timeBlock >= start && pair.timeBlock <= end);
    const A0 = labelSummary(selected.map((pair) => pair.A0));
    const A1 = labelSummary(selected.map((pair) => pair.A1));
    return {
      quartile,
      timeBlockStart: start,
      timeBlockEnd: end,
      A0,
      A1,
      absoluteDifferenceA1MinusA0: A1.successRate - A0.successRate,
    };
  });
  return {
    firstLabelCounts: {
      A0: pairs.filter((pair) => pair.firstLabel === "A0").length,
      A1: pairs.filter((pair) => pair.firstLabel === "A1").length,
    },
    byOrderIndex,
    byTimeQuartile,
    blocks: pairs.map((pair) => ({
      timeBlock: pair.timeBlock,
      pairId: pair.pairId,
      firstLabel: pair.firstLabel,
      a0Accepted: pair.A0.accepted,
      a1Accepted: pair.A1.accepted,
      signedDifferenceA1MinusA0: (Number(pair.A1.accepted) - Number(pair.A0.accepted)) as -1 | 0 | 1,
    })),
  };
}

const metricsObservableSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("observed"), value: z.unknown() }).passthrough(),
  z.object({ status: z.literal("unobservable"), reason: z.string().min(1) }).passthrough(),
]);

const attemptMetricsArtifactSchema = z.object({
  schemaVersion: z.literal("exp-0001a-attempt-metrics/v1"),
  attemptId: stableIdSchema,
  taskId: stableIdSchema,
  completion: z.object({ status: z.string().min(1) }).passthrough(),
  provenance: z.object({
    attemptBundleDigest: digestSchema,
    artifactRoot: digestSchema,
    authorEvidenceRoot: digestSchema.nullable(),
    verifiedArtifactCount: z.number().int().nonnegative(),
  }).passthrough(),
  timing: z.object({ totalAttemptWallMs: metricsObservableSchema }).passthrough(),
  efficiency: z.object({
    toolCalls: metricsObservableSchema,
    tokens: metricsObservableSchema,
    costUsd: metricsObservableSchema,
  }).passthrough(),
  artifactDigest: digestSchema,
}).passthrough();

export type Exp0001aAnalysisSourceContext = {
  batchPlan: Exp0001aBatchPlan;
  batchRegistry: BatchRegistry;
  registryBridge: {
    registry: AttemptRegistry;
    receipt: Exp0001aRegistryBridgeReceipt;
  };
  individualReview: {
    plan: BlindedReviewPlan;
    ledger: ReviewLedger;
    classifications: ClassificationBook;
  };
  pairwiseReview: {
    context: PairwisePlanContext;
    plan: PairwiseVisualPreferencePlan;
    ledger: PairwisePreferenceLedger;
    seal: PairwisePreferenceLedgerSeal;
    unblindedReport: UnblindedPairwiseReport;
  };
  /** Raw, self-hashed score artifacts. Missing attempts remain missing cells; duplicate/extra artifacts are rejected. */
  attemptMetricsArtifacts: readonly unknown[];
  spendLedger: {
    events: readonly Exp0001aSpendEvent[];
    authorizedMaximumUsd: number;
    authorizationReceiptDigest: string;
    externalAnchorRoot: string;
    externalAnchorCount: number;
  };
};

function canonicalEquals(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertExactIds(actual: readonly string[], expected: readonly string[], code: string): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length
      || !canonicalEquals([...actual].sort(compareCodeUnits), [...expected].sort(compareCodeUnits))) {
    throw new Error(code);
  }
}

const aliasVerificationRootEventSchema = z.object({
  kind: z.literal("alias_verified"),
  attemptId: stableIdSchema,
  eventDigest: digestSchema,
  data: z.object({
    receipt: z.object({ receiptDigest: digestSchema }).passthrough(),
  }).passthrough(),
}).passthrough();

/**
 * Roots the exact fixed-attempt alias checks already validated by the batch
 * registry. This is deliberately separate from the larger registry root so a
 * report cannot silently omit, duplicate, or substitute a pre-brief check.
 */
export function computeExp0001aPerAttemptAliasVerificationRoot(
  rawEvents: readonly unknown[],
  expectedAttemptIds: readonly string[],
): string {
  const events = rawEvents.map((event) => aliasVerificationRootEventSchema.parse(event));
  assertExactIds(
    events.map((event) => event.attemptId),
    expectedAttemptIds,
    "EXP0001A_PER_ATTEMPT_ALIAS_RECEIPT_DENOMINATOR_INVALID",
  );
  const byAttempt = new Map(events.map((event) => [event.attemptId, event]));
  return hashCanonicalJson(expectedAttemptIds.map((attemptId) => {
    const event = byAttempt.get(attemptId);
    if (!event) throw new Error(`EXP0001A_PER_ATTEMPT_ALIAS_RECEIPT_MISSING:${attemptId}`);
    return {
      attemptId,
      eventDigest: event.eventDigest,
      receiptDigest: event.data.receipt.receiptDigest,
    };
  }));
}

function retainedBatchEvent(
  registry: BatchRegistry,
  attemptId: string,
): Extract<BatchRegistryEvent, { kind: "attempt_retained" }> {
  const matches = registry.events.filter((event): event is Extract<BatchRegistryEvent, { kind: "attempt_retained" }> => (
    event.kind === "attempt_retained" && event.attemptId === attemptId
  ));
  if (matches.length !== 1) throw new Error(`EXP0001A_BATCH_RETAINED_DENOMINATOR_INVALID:${attemptId}`);
  return matches[0];
}

function verifyRegistryBridgeSources(input: {
  plan: Exp0001aBatchPlan;
  batchRegistry: BatchRegistry;
  registry: AttemptRegistry;
  receipt: Exp0001aRegistryBridgeReceipt;
}): void {
  if (input.batchRegistry.events.some((event) => event.kind === "hard_stop")) {
    throw new Error("EXP0001A_HARD_STOPPED_BATCH_CANNOT_BE_ANALYZED");
  }
  const receipt = exp0001aRegistryBridgeReceiptSchema.parse(input.receipt);
  if (computeExp0001aRegistryBridgeReceiptDigest(receipt) !== receipt.receiptDigest) {
    throw new Error("EXP0001A_REGISTRY_BRIDGE_RECEIPT_DIGEST_INVALID");
  }
  if (receipt.batchPlanDigest !== input.plan.planDigest
      || receipt.batchRegistryDigest !== input.batchRegistry.registryDigest
      || receipt.sealedRunSpecDigest !== input.registry.runSpecDigest
      || receipt.sealedRegistryRoot !== input.registry.registryRoot
      || receipt.denominator !== 48) {
    throw new Error("EXP0001A_REGISTRY_BRIDGE_ROOT_MISMATCH");
  }
  const expectedAttemptIds = input.plan.configs.map((config) => config.attempt.attemptId);
  assertExactIds(receipt.mappings.map((mapping) => mapping.attemptId), expectedAttemptIds, "EXP0001A_REGISTRY_BRIDGE_MAPPING_DENOMINATOR_INVALID");
  const registryById = new Map(input.registry.attempts.map((attempt) => [attempt.attemptId, attempt]));
  receipt.mappings.forEach((mapping, manifestPosition) => {
    const config = input.plan.configs[manifestPosition];
    const batch = retainedBatchEvent(input.batchRegistry, config.attempt.attemptId);
    const sealed = registryById.get(config.attempt.attemptId);
    const expectedCondition = config.attempt.opaqueLabel === "A0" ? "baseline" : "candidate";
    if (!sealed || sealed.state !== "sealed" || !batch.data.evidenceComplete
        || mapping.manifestPosition !== manifestPosition || mapping.attemptId !== config.attempt.attemptId
        || mapping.opaqueLabel !== config.attempt.opaqueLabel || mapping.compatibilityCondition !== expectedCondition
        || mapping.batchRetainedEventDigest !== batch.eventDigest
        || mapping.retainedOutcome !== batch.data.retainedOutcome
        || mapping.batchArtifactRoot !== batch.data.artifactRoot
        || mapping.batchAuthorEvidenceRoot !== batch.data.authorEvidenceRoot
        || mapping.batchAttemptBundleSha256 !== batch.data.attemptBundleSha256
        || mapping.authorIdentityCommitment !== batch.data.authorIdentityCommitment
        || mapping.authorIdentityArtifactSha256 !== batch.data.authorIdentityArtifactSha256
        || mapping.batchArtifactEntriesCommitment !== hashCanonicalJson(batch.data.artifacts)
        || mapping.sealedArtifactMerkleRoot !== sealed.artifactIndex?.merkleRoot
        || mapping.sealedAuthorEvidenceRoot !== sealed.authorEvidenceRoot) {
      throw new Error(`EXP0001A_REGISTRY_BRIDGE_MAPPING_DRIFT:${config.attempt.attemptId}`);
    }
  });
}

function verifyMetricsArtifacts(
  rawArtifacts: readonly unknown[],
  expectedAttemptIds: readonly string[],
): Map<string, z.infer<typeof attemptMetricsArtifactSchema>> {
  const byAttempt = new Map<string, z.infer<typeof attemptMetricsArtifactSchema>>();
  const expected = new Set(expectedAttemptIds);
  for (const rawArtifact of rawArtifacts) {
    const artifact = attemptMetricsArtifactSchema.parse(rawArtifact);
    if (!expected.has(artifact.attemptId)) throw new Error(`EXP0001A_EXTRA_METRICS_ARTIFACT:${artifact.attemptId}`);
    if (byAttempt.has(artifact.attemptId)) throw new Error(`EXP0001A_DUPLICATE_METRICS_ARTIFACT:${artifact.attemptId}`);
    const { artifactDigest, ...unsigned } = artifact;
    if (hashCanonicalJson(unsigned) !== artifactDigest) {
      throw new Error(`EXP0001A_METRICS_ARTIFACT_DIGEST_INVALID:${artifact.attemptId}`);
    }
    byAttempt.set(artifact.attemptId, artifact);
  }
  return byAttempt;
}

function numericMetricObservation(
  observable: z.infer<typeof metricsObservableSchema> | undefined,
  projection: (value: unknown) => number | null,
  missingReason: string,
): z.infer<typeof resourceObservationSchema> {
  if (!observable) return { status: "unobservable", value: null, reason: missingReason };
  if (observable.status === "unobservable") return { status: "unobservable", value: null, reason: observable.reason };
  const value = projection(observable.value);
  return value === null || !Number.isFinite(value) || value < 0
    ? { status: "unobservable", value: null, reason: "Retained metric value is not a finite nonnegative number." }
    : { status: "observed", value, reason: null };
}

function directNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function tokenTotal(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const total = (value as Record<string, unknown>).totalTokens;
    return typeof total === "number" ? total : null;
  }
  return null;
}

function normalizedReview(record: LockedEvaluatorRecord): z.infer<typeof reviewSchema> {
  const providerIdentity = providerRecordIdentitySchema.parse({
    status: record.provider.identityStatus,
    requestedModelIdentifier: record.provider.modelRequested,
    requestedServiceTier: record.provider.serviceTierRequested,
    observedModelIdentifier: record.provider.modelObserved,
    observedServiceTier: record.provider.serviceTierObserved,
    requestedAliasExactMatch: record.provider.modelObserved === null
      ? null
      : record.provider.modelObserved === record.provider.modelRequested,
  });
  if (record.status === "failed") {
    return {
      reviewerId: record.reviewer.id,
      measurementRole: record.measurement.role,
      providerIdentity,
      status: "failed",
      accepted: null,
      primaryFailureClass: "FAIL_EVALUATOR_SCORER",
      failureCode: record.failure!.code,
    };
  }
  return {
    reviewerId: record.reviewer.id,
    measurementRole: record.measurement.role,
    providerIdentity,
    status: "scored",
    accepted: record.accepted,
    primaryFailureClass: record.primaryFailureClass,
    failureCode: null,
  };
}

function mechanismsFromPrimaryRecords(records: readonly LockedEvaluatorRecord[]): Exp0001aAttemptAnalysis["mechanismTags"] {
  const evidenceByTag = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.status !== "scored" || record.reviewer.role !== "primary" || !record.result
        || !("mechanismTags" in record.result)) continue;
    for (const mechanism of record.result.mechanismTags) {
      const evidence = evidenceByTag.get(mechanism.tag) ?? new Set<string>();
      mechanism.evidenceRefs.forEach((reference) => evidence.add(reference));
      evidenceByTag.set(mechanism.tag, evidence);
    }
  }
  return [...evidenceByTag.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([tag, evidenceRefs]) => ({ tag, evidenceRefs: [...evidenceRefs].sort(compareCodeUnits) }));
}

function requiredArtifactFields(input: {
  retained: Extract<BatchRegistryEvent, { kind: "attempt_retained" }>;
  metrics: z.infer<typeof attemptMetricsArtifactSchema> | undefined;
  classification: ClassificationBook["classifications"][number];
}): Exp0001aAttemptAnalysis["artifactFields"] {
  const artifactByPath = new Map(input.retained.data.artifacts.map((artifact) => [artifact.path, artifact]));
  return EXP0001A_REQUIRED_ARTIFACT_FIELDS.map((fieldId) => {
    if (fieldId === "attempt-metrics") {
      return input.metrics
        ? { fieldId, status: "observed" as const, evidenceDigest: input.metrics.artifactDigest, reason: null }
        : { fieldId, status: "missing" as const, evidenceDigest: null, reason: "No retained attempt-metrics artifact." };
    }
    if (fieldId === "locked-classification") {
      return { fieldId, status: "observed" as const, evidenceDigest: hashCanonicalJson(input.classification), reason: null };
    }
    const artifact = fieldId === "spectator-final-png"
      ? input.retained.data.artifacts.find((candidate) => /^spectator-final-r\d+\.png$/.test(candidate.path))
      : artifactByPath.get(fieldId);
    if (artifact) {
      return { fieldId, status: "observed" as const, evidenceDigest: `sha256:${artifact.sha256}`, reason: null };
    }
    const reason = input.retained.data.retainedOutcome === "completed"
      ? `Required retained artifact ${fieldId} is absent.`
      : `Artifact ${fieldId} is unobservable after retained ${input.retained.data.retainedOutcome} outcome.`;
    return input.retained.data.retainedOutcome === "completed"
      ? { fieldId, status: "missing" as const, evidenceDigest: null, reason }
      : { fieldId, status: "unobservable" as const, evidenceDigest: null, reason };
  });
}

type SpendUsage = z.infer<typeof spendUsageTotalsSchema>;
type SpendRecord = {
  callId: string;
  phase: Exp0001aSpendPhase;
  expectedBegun: boolean;
  usage: SpendUsage | null;
  costUsd: number | null;
  usageDigest: string | null;
  providerReceiptDigest: string | null;
  frozenCallCapUsd: number;
  budgetDigest: string;
  pricingDigest: string;
  noProviderCallAttestedBySource: boolean;
  unobservableReason: string;
};

function emptySpendUsage(): SpendUsage {
  return {
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function normalizeSpendUsage(usage: {
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens: number;
}): SpendUsage {
  return spendUsageTotalsSchema.parse({
    inputTokens: usage.inputTokens,
    uncachedInputTokens: usage.uncachedInputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens ?? usage.reasoningOutputTokens ?? 0,
    totalTokens: usage.totalTokens,
  });
}

function addSpendUsage(left: SpendUsage, right: SpendUsage): SpendUsage {
  return spendUsageTotalsSchema.parse(Object.fromEntries(
    Object.keys(left).map((key) => [key, left[key as keyof SpendUsage] + right[key as keyof SpendUsage]]),
  ));
}

function roundUsd(value: number): number {
  return Number(value.toFixed(12));
}

function frozenProviderCallCapUsd(input: {
  inputTokens: number;
  outputTokens: number;
  pricing: {
    inputUsdPerMillionTokens: number;
    cachedInputUsdPerMillionTokens: number;
    cacheWriteInputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
  };
  longContextCeiling?: boolean;
}): number {
  const maximumInputRate = Math.max(
    input.pricing.inputUsdPerMillionTokens,
    input.pricing.cachedInputUsdPerMillionTokens,
    input.pricing.cacheWriteInputUsdPerMillionTokens,
  );
  const inputMultiplier = input.longContextCeiling ? 2 : 1;
  const outputMultiplier = input.longContextCeiling ? 1.5 : 1;
  return roundUsd((
    input.inputTokens * maximumInputRate * inputMultiplier
      + input.outputTokens * input.pricing.outputUsdPerMillionTokens * outputMultiplier
  ) / 1_000_000);
}

function spendCategory(
  maximumCalls: number,
  selectedCalls: number,
  records: readonly SpendRecord[],
  ledgerEvents: readonly Exp0001aSpendEvent[],
) {
  if (records.length !== selectedCalls) throw new Error("EXP0001A_SPEND_SELECTED_CALL_DENOMINATOR_MISMATCH");
  const reservations = new Map(ledgerEvents.flatMap((event) => event.kind === "reservation" ? [[event.callId, event]] : []));
  const settlements = new Map(ledgerEvents.flatMap((event) => event.kind === "settlement" ? [[event.callId, event]] : []));
  const begun = records.filter((record) => record.expectedBegun);
  const observed: SpendRecord[] = [];
  const attestedNoProvider: SpendRecord[] = [];
  const unobservable: SpendRecord[] = [];
  for (const record of records) {
    const reservation = reservations.get(record.callId);
    const settlement = settlements.get(record.callId);
    if ((reservation !== undefined) !== record.expectedBegun) {
      throw new Error(`EXP0001A_SPEND_RESERVATION_SOURCE_MISMATCH:${record.callId}`);
    }
    if (!reservation) {
      if (settlement) throw new Error(`EXP0001A_SPEND_SETTLEMENT_WITHOUT_EXPECTED_BEGIN:${record.callId}`);
      continue;
    }
    if (reservation.phase !== record.phase
        || Math.abs(reservation.maximumCostUsd - record.frozenCallCapUsd) > 1e-12
        || reservation.budgetDigest !== record.budgetDigest
        || reservation.pricingDigest !== record.pricingDigest) {
      throw new Error(`EXP0001A_SPEND_RESERVATION_POLICY_DRIFT:${record.callId}`);
    }
    if (!settlement) {
      unobservable.push(record);
      continue;
    }
    if (settlement.observability === "attested_no_provider_call") {
      if (!record.noProviderCallAttestedBySource || record.usage !== null || record.costUsd !== null) {
        throw new Error(`EXP0001A_SPEND_NO_CALL_ATTESTATION_CONTRADICTS_PROVIDER_RECEIPT:${record.callId}`);
      }
      attestedNoProvider.push(record);
      continue;
    }
    if (record.usage === null || record.costUsd === null || record.usageDigest === null || record.providerReceiptDigest === null
        || Math.abs(settlement.actualCostUsd - record.costUsd) > 1e-12 || settlement.usageDigest !== record.usageDigest
        || settlement.providerReceiptDigest !== record.providerReceiptDigest) {
      throw new Error(`EXP0001A_SPEND_SETTLEMENT_PROVIDER_RECEIPT_MISMATCH:${record.callId}`);
    }
    observed.push(record);
  }
  const observedUsage = observed.reduce(
    (total, record) => addSpendUsage(total, record.usage as SpendUsage),
    emptySpendUsage(),
  );
  const observedCostUsd = roundUsd(observed.reduce((total, record) => total + (record.costUsd as number), 0));
  const conservativeReservedCostUsd = roundUsd(unobservable.reduce(
    (total, record) => total + record.frozenCallCapUsd,
    0,
  ));
  return spendCategorySchema.parse({
    maximumCalls,
    selectedCalls,
    begunCalls: begun.length,
    notBegunSelectedCalls: selectedCalls - begun.length,
    observedUsageReceipts: observed.length,
    attestedNoProviderCallSettlements: attestedNoProvider.length,
    unsettledOrUnobservableBegunCalls: unobservable.length,
    observedUsage,
    observedCostUsd,
    conservativeReservedCostUsd,
    accountedCostUsd: roundUsd(observedCostUsd + conservativeReservedCostUsd),
    unobservableReasonCounts: countBy(unobservable.map((record) => record.unobservableReason)),
    status: begun.length === 0 ? "unobservable" : unobservable.length === 0 ? "complete" : "partial",
  });
}

function totalSpendCategory(categories: readonly z.infer<typeof spendCategorySchema>[]) {
  const integer = (key: "maximumCalls" | "selectedCalls" | "begunCalls" | "notBegunSelectedCalls"
    | "observedUsageReceipts" | "attestedNoProviderCallSettlements"
    | "unsettledOrUnobservableBegunCalls") => categories.reduce((sum, category) => sum + category[key], 0);
  const observedUsage = categories.reduce((total, category) => addSpendUsage(total, category.observedUsage), emptySpendUsage());
  const observedCostUsd = roundUsd(categories.reduce((sum, category) => sum + category.observedCostUsd, 0));
  const conservativeReservedCostUsd = roundUsd(categories.reduce(
    (sum, category) => sum + category.conservativeReservedCostUsd,
    0,
  ));
  const reasons = categories.flatMap((category) => Object.entries(category.unobservableReasonCounts)
    .flatMap(([reason, count]) => Array.from({ length: count }, () => reason)));
  const begunCalls = integer("begunCalls");
  const unsettledOrUnobservableBegunCalls = integer("unsettledOrUnobservableBegunCalls");
  return spendCategorySchema.parse({
    maximumCalls: integer("maximumCalls"),
    selectedCalls: integer("selectedCalls"),
    begunCalls,
    notBegunSelectedCalls: integer("notBegunSelectedCalls"),
    observedUsageReceipts: integer("observedUsageReceipts"),
    attestedNoProviderCallSettlements: integer("attestedNoProviderCallSettlements"),
    unsettledOrUnobservableBegunCalls,
    observedUsage,
    observedCostUsd,
    conservativeReservedCostUsd,
    accountedCostUsd: roundUsd(observedCostUsd + conservativeReservedCostUsd),
    unobservableReasonCounts: countBy(reasons),
    status: begunCalls === 0 ? "unobservable" : unsettledOrUnobservableBegunCalls === 0 ? "complete" : "partial",
  });
}

function buildExperimentSpendAccounting(input: {
  batchPlan: Exp0001aBatchPlan;
  batchRegistry: BatchRegistry;
  reviewPlan: BlindedReviewPlan;
  reviewLedger: ReviewLedger;
  pairwisePlan: PairwiseVisualPreferencePlan;
  pairwiseLedger: PairwisePreferenceLedger;
  spendEvents: readonly Exp0001aSpendEvent[];
  authorizedMaximumUsd: number;
  authorizationReceiptDigest: string;
  externalAnchorRoot: string;
  externalAnchorCount: number;
}): Exp0001aExperimentSpendAccounting {
  if (input.authorizedMaximumUsd > 487.2) throw new Error("EXP0001A_SPEND_AUTHORIZATION_EXCEEDS_FROZEN_CAP");
  const spendSummary = summarizeExp0001aSpendLedger(
    input.spendEvents,
    input.authorizedMaximumUsd,
    input.authorizationReceiptDigest,
  );
  if (spendSummary.externalAnchorRoot !== input.externalAnchorRoot
      || spendSummary.externalAnchorCount !== input.externalAnchorCount) {
    throw new Error("EXP0001A_SPEND_EXTERNAL_ANCHOR_MISMATCH");
  }
  const begunAuthorIds = new Set(input.batchRegistry.events.flatMap((event) => (
    event.kind === "brief_delivered" ? [event.attemptId] : []
  )));
  const authorRecords = input.batchPlan.configs.map((config): SpendRecord => {
    const retained = retainedBatchEvent(input.batchRegistry, config.attempt.attemptId);
    const begun = begunAuthorIds.has(config.attempt.attemptId);
    if (retained.data.usageByTurn !== null && retained.data.actualCostUsd !== null
        && Math.abs(computeActualProviderTurnCost(retained.data.usageByTurn, input.batchPlan.pricing)
          - retained.data.actualCostUsd) > 1e-12) {
      throw new Error(`EXP0001A_AUTHOR_PER_TURN_COST_DRIFT:${config.attempt.attemptId}`);
    }
    const budget = {
      inputTokens: config.runnerConfig.inputTokenBudget,
      outputTokens: config.runnerConfig.outputTokenBudget,
    };
    return {
      callId: `author:${config.attempt.attemptId}`,
      phase: "author",
      expectedBegun: begun,
      usage: begun && retained.data.usage ? normalizeSpendUsage(retained.data.usage) : null,
      costUsd: begun ? retained.data.actualCostUsd : null,
      usageDigest: begun && retained.data.usage ? hashCanonicalJson(retained.data.usage) : null,
      providerReceiptDigest: begun && retained.data.usage ? retained.eventDigest : null,
      frozenCallCapUsd: frozenProviderCallCapUsd({
        ...budget,
        pricing: input.batchPlan.pricing,
        longContextCeiling: true,
      }),
      budgetDigest: hashCanonicalJson(budget),
      pricingDigest: hashCanonicalJson(input.batchPlan.pricing),
      noProviderCallAttestedBySource: retained.data.costObservability === "attested_no_provider_call",
      unobservableReason: "author-provider-usage-or-cost-receipt-missing-after-brief-delivery",
    };
  });
  const reviewRecord = (
    record: LockedEvaluatorRecord,
    workItemId: string,
    phase: "primary" | "adjudication",
    reason: string,
  ): SpendRecord => ({
    callId: `${phase}:${workItemId}`,
    phase,
    expectedBegun: record.reviewer.invocationCount === 1,
    usage: record.provider.usage ? normalizeSpendUsage(record.provider.usage) : null,
    costUsd: record.provider.usage ? record.provider.estimatedCostUsd : null,
    usageDigest: record.provider.usage ? hashCanonicalJson(record.provider.usage) : null,
    providerReceiptDigest: record.provider.usage ? `sha256:${record.recordSha256}` : null,
    frozenCallCapUsd: frozenProviderCallCapUsd({
      inputTokens: record.budgets.inputTokens,
      outputTokens: record.budgets.outputTokens,
      pricing: record.pricing,
    }),
    budgetDigest: hashCanonicalJson(record.budgets),
    pricingDigest: hashCanonicalJson(record.pricing),
    noProviderCallAttestedBySource: record.provider.usage === null
      && record.hashes.providerRequestSha256 === null,
    unobservableReason: reason,
  });
  const primaryWorkItems = new Map(input.reviewPlan.artifacts.flatMap((artifact) => (
    artifact.primaryWorkItems.map((item) => [`${item.artifactId}:${item.reviewerId}`, item] as const)
  )));
  const primaryRecords = input.reviewLedger.primaryLocks.map(({ record }) => {
    const item = primaryWorkItems.get(`${record.artifactId}:${record.reviewer.id}`);
    if (!item) throw new Error(`EXP0001A_SPEND_PRIMARY_WORK_ITEM_MISSING:${record.artifactId}:${record.reviewer.id}`);
    return reviewRecord(record, item.workItemId, "primary", "primary-provider-usage-receipt-missing-after-invocation");
  });
  const adjudicationAssignments = new Map(input.reviewLedger.adjudicationAssignments.map((assignment) => (
    [assignment.artifactId, assignment] as const
  )));
  const adjudicationRecords = input.reviewLedger.adjudicationLocks.map(({ record }) => {
    const assignment = adjudicationAssignments.get(record.artifactId);
    if (!assignment || assignment.reviewerId !== record.reviewer.id) {
      throw new Error(`EXP0001A_SPEND_ADJUDICATION_WORK_ITEM_MISSING:${record.artifactId}`);
    }
    return reviewRecord(
      record,
      assignment.workItem.workItemId,
      "adjudication",
      "adjudication-provider-usage-receipt-missing-after-invocation",
    );
  });
  const pairwiseCallCap = frozenProviderCallCapUsd({
    inputTokens: input.pairwisePlan.scorerPolicy.tokenBudget.inputTokens,
    outputTokens: input.pairwisePlan.scorerPolicy.tokenBudget.outputTokens,
    pricing: input.pairwisePlan.scorerPolicy.pricing,
  });
  const pairwiseAssignments = new Set(input.pairwisePlan.assignments.map((assignment) => assignment.workItem.workItemId));
  const pairwiseRecords = input.pairwiseLedger.records.map(({ record }): SpendRecord => {
    if (!pairwiseAssignments.has(record.workItemId)) {
      throw new Error(`EXP0001A_SPEND_PAIRWISE_WORK_ITEM_MISSING:${record.workItemId}`);
    }
    return {
      callId: `pairwise:${record.workItemId}`,
      phase: "pairwise",
      expectedBegun: record.invocationCount === 1,
      usage: record.provider.usage ? normalizeSpendUsage(record.provider.usage) : null,
      costUsd: record.provider.usage ? record.provider.estimatedCostUsd : null,
      usageDigest: record.provider.usage ? hashCanonicalJson(record.provider.usage) : null,
      providerReceiptDigest: record.provider.usage ? record.recordRoot : null,
      frozenCallCapUsd: pairwiseCallCap,
      budgetDigest: hashCanonicalJson(input.pairwisePlan.scorerPolicy.tokenBudget),
      pricingDigest: hashCanonicalJson(input.pairwisePlan.scorerPolicy.pricing),
      noProviderCallAttestedBySource: record.provider.usage === null
        && record.failure?.code === "RENDER_STAGING_FAILED",
      unobservableReason: "pairwise-provider-usage-receipt-missing-after-invocation",
    };
  });
  const allRecords = [...authorRecords, ...primaryRecords, ...adjudicationRecords, ...pairwiseRecords];
  const expectedReservationCallIds = allRecords.filter((record) => record.expectedBegun).map((record) => record.callId);
  const actualReservationCallIds = input.spendEvents.flatMap((event) => event.kind === "reservation" ? [event.callId] : []);
  assertExactIds(actualReservationCallIds, expectedReservationCallIds, "EXP0001A_SPEND_RESERVATION_DENOMINATOR_INVALID");
  const authors = spendCategory(48, 48, authorRecords, input.spendEvents);
  const primaryReviews = spendCategory(96, 96, primaryRecords, input.spendEvents);
  const adjudications = spendCategory(48, adjudicationRecords.length, adjudicationRecords, input.spendEvents);
  const pairwisePreferences = spendCategory(24, 24, pairwiseRecords, input.spendEvents);
  const total = totalSpendCategory([authors, primaryReviews, adjudications, pairwisePreferences]);
  if (Math.abs(total.observedCostUsd - spendSummary.observedSettledUsd) > 1e-9
      || Math.abs(total.conservativeReservedCostUsd - spendSummary.unobservableReservedExposureUsd) > 1e-9
      || Math.abs(total.accountedCostUsd - spendSummary.totalChargedExposureUsd) > 1e-9
      || total.begunCalls !== spendSummary.reservationCount
      || total.observedUsageReceipts + total.attestedNoProviderCallSettlements !== spendSummary.settlementCount) {
    throw new Error("EXP0001A_SPEND_SUMMARY_RECONCILIATION_FAILED");
  }
  return experimentSpendAccountingSchema.parse({
    policy: "observed-provider-receipts-plus-frozen-cap-for-every-begun-call-without-usage",
    preProviderCumulativeInputHardCapEnforced: true,
    authorLongContextPricing: {
      thresholdInputTokensPerTurn: 272000,
      inputRateMultiplier: 2,
      outputRateMultiplier: 1.5,
      observedCostBasis: "sum-of-retained-per-turn-usage-with-threshold-pricing",
    },
    authorizedMaximumUsd: input.authorizedMaximumUsd,
    authorizationReceiptDigest: input.authorizationReceiptDigest,
    remainingAuthorizedExposureUsd: spendSummary.remainingAuthorizedExposureUsd,
    spendLedgerRoot: spendSummary.ledgerRoot,
    spendExternalAnchorRoot: spendSummary.externalAnchorRoot,
    spendExternalAnchorCount: spendSummary.externalAnchorCount,
    authors,
    primaryReviews,
    adjudications,
    pairwisePreferences,
    total,
  });
}

function verifySourceContext(raw: unknown): Exp0001aAnalysisSourceContext {
  if (!raw || typeof raw !== "object") throw new Error("EXP0001A_SOURCE_CONTEXT_REQUIRED");
  const candidate = raw as Partial<Exp0001aAnalysisSourceContext>;
  if (!candidate.batchPlan || !candidate.batchRegistry || !candidate.registryBridge
      || !candidate.individualReview || !candidate.pairwiseReview || !candidate.attemptMetricsArtifacts
      || !candidate.spendLedger) {
    throw new Error("EXP0001A_SOURCE_CONTEXT_REQUIRED");
  }
  return candidate as Exp0001aAnalysisSourceContext;
}

/**
 * Builds the only production analysis input from immutable, independently
 * verifiable experiment ledgers. Callers never supply normalized outcomes or
 * provenance roots; every row and root below is derived from retained sources.
 */
export function buildExp0001aAnalysisInput(rawContext: unknown): Exp0001aAnalysisInput {
  const source = verifySourceContext(rawContext);
  const manifestVerification = verifyDevelopmentExecutionManifest(source.batchPlan.manifest);
  if (!manifestVerification.ok) throw new Error(`EXP0001A_MANIFEST_INVALID:${manifestVerification.errors.join(",")}`);
  const manifest = manifestVerification.manifest;
  if (manifest.treatments.A0 !== manifest.treatments.A1) throw new Error("EXP0001A_TREATMENT_DRIFT");

  const identityCommitments = Object.fromEntries(source.batchPlan.configs.map((config) => [
    config.attempt.attemptId,
    config.runnerConfig.authorIdentityCommitment,
  ]));
  const expectedBatchPlan = createExp0001aBatchPlan({
    executionFreeze: source.batchPlan.executionFreeze,
    livePreflight: source.batchPlan.livePreflight,
    pricing: source.batchPlan.pricing,
    authorIdentityCommitments: identityCommitments,
    manifest,
  });
  if (!canonicalEquals(source.batchPlan, expectedBatchPlan)) {
    throw new Error("EXP0001A_BATCH_PLAN_RECOMPUTATION_MISMATCH");
  }

  const batchRegistry = verifyExp0001aBatchRegistry(batchRegistrySchema.parse(source.batchRegistry), source.batchPlan);
  const expectedAttemptIds = source.batchPlan.configs.map((config) => config.attempt.attemptId);
  const aliasVerificationEvents = batchRegistry.events.filter((event) => event.kind === "alias_verified");
  assertExactIds(
    aliasVerificationEvents.map((event) => event.attemptId),
    expectedAttemptIds,
    "EXP0001A_PER_ATTEMPT_ALIAS_RECEIPT_DENOMINATOR_INVALID",
  );
  const perAttemptAliasVerificationRoot = computeExp0001aPerAttemptAliasVerificationRoot(
    aliasVerificationEvents,
    expectedAttemptIds,
  );
  const registry = attemptRegistrySchema.parse(source.registryBridge.registry);
  const registryVerification = verifyAttemptRegistry(registry);
  if (!registryVerification.ok) throw new Error(`EXP0001A_ATTEMPT_REGISTRY_INVALID:${registryVerification.errors.join(",")}`);
  assertExactIds(registry.attempts.map((attempt) => attempt.attemptId), expectedAttemptIds, "EXP0001A_ATTEMPT_REGISTRY_DENOMINATOR_INVALID");
  verifyRegistryBridgeSources({
    plan: source.batchPlan,
    batchRegistry,
    registry,
    receipt: source.registryBridge.receipt,
  });

  const reviewPlan = blindedReviewPlanSchema.parse(source.individualReview.plan);
  const reviewLedger = reviewLedgerSchema.parse(source.individualReview.ledger);
  const classifications = classificationBookSchema.parse(source.individualReview.classifications);
  verifyBlindedReviewPlan(reviewPlan);
  verifyReviewLedger(reviewPlan, reviewLedger);
  if (reviewPlan.registryRoot !== registry.registryRoot || reviewPlan.runSpecDigest !== registry.runSpecDigest
      || classifications.registryRoot !== registry.registryRoot
      || classifications.planRoot !== reviewPlan.planRoot
      || classifications.ledgerRoot !== reviewLedger.ledgerRoot
      || computeClassificationRoot(classifications) !== classifications.classificationRoot) {
    throw new Error("EXP0001A_INDIVIDUAL_REVIEW_ROOT_MISMATCH");
  }
  const expectedClassifications = finalizeArtifactClassifications(reviewPlan, reviewLedger);
  if (!canonicalEquals(classifications, expectedClassifications)) {
    throw new Error("EXP0001A_CLASSIFICATION_LEDGER_RECONCILIATION_FAILED");
  }

  const pairwiseContext = source.pairwiseReview.context;
  if (!canonicalEquals(pairwiseContext.manifest, manifest)
      || !canonicalEquals(pairwiseContext.blindedReviewPlan, reviewPlan)
      || !canonicalEquals(pairwiseContext.reviewLedger, reviewLedger)
      || !canonicalEquals(pairwiseContext.classificationBook, classifications)) {
    throw new Error("EXP0001A_PAIRWISE_CONTEXT_REWRITTEN");
  }
  const pairwisePlan = pairwiseVisualPreferencePlanSchema.parse(source.pairwiseReview.plan);
  const pairwiseLedger = pairwisePreferenceLedgerSchema.parse(source.pairwiseReview.ledger);
  const pairwiseSeal = pairwisePreferenceLedgerSealSchema.parse(source.pairwiseReview.seal);
  const unblindedReport = unblindedPairwiseReportSchema.parse(source.pairwiseReview.unblindedReport);
  verifyPairwiseVisualPreferencePlan(pairwisePlan, pairwiseContext);
  verifyPairwisePreferenceLedger(pairwisePlan, pairwiseLedger, pairwiseSeal);
  if (computePairwiseLedgerRoot(pairwiseLedger) !== pairwiseLedger.ledgerRoot
      || computePairwiseLedgerSealRoot(pairwiseSeal) !== pairwiseSeal.sealRoot
      || computeUnblindedPairwiseReportRoot(unblindedReport) !== unblindedReport.reportRoot) {
    throw new Error("EXP0001A_PAIRWISE_ROOT_INVALID");
  }
  const expectedUnblinded = unblindPairwiseVisualPreferences({
    context: pairwiseContext,
    plan: pairwisePlan,
    ledger: pairwiseLedger,
    seal: pairwiseSeal,
  });
  if (!canonicalEquals(unblindedReport, expectedUnblinded)) {
    throw new Error("EXP0001A_UNBLINDED_PAIRWISE_REPORT_REWRITTEN");
  }

  const metricsByAttempt = verifyMetricsArtifacts(source.attemptMetricsArtifacts, expectedAttemptIds);
  const registryByAttempt = new Map(registry.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const classificationByAttempt = new Map(classifications.classifications.map((item) => [item.attemptId, item]));
  const reviewArtifactByAttempt = new Map(reviewPlan.artifacts.map((artifact) => [artifact.attemptId, artifact]));

  const attempts = manifest.assignments.flatMap((assignment) => assignment.attempts.map((expected) => {
    const retained = retainedBatchEvent(batchRegistry, expected.attemptId);
    const sealed = registryByAttempt.get(expected.attemptId);
    const classification = classificationByAttempt.get(expected.attemptId);
    const reviewArtifact = reviewArtifactByAttempt.get(expected.attemptId);
    const metrics = metricsByAttempt.get(expected.attemptId);
    if (!sealed || !classification || !reviewArtifact) throw new Error(`EXP0001A_SOURCE_ROW_MISSING:${expected.attemptId}`);
    const expectedCondition = expected.opaqueLabel === "A0" ? "baseline" : "candidate";
    if (sealed.pairId !== assignment.pairId || sealed.taskId !== assignment.taskId
        || sealed.condition !== expectedCondition || sealed.orderIndex !== expected.orderIndex
        || sealed.timeBlock !== assignment.timeBlock || sealed.authorOutcome !== retained.data.retainedOutcome
        || classification.taskId !== assignment.taskId || classification.authorOutcome !== retained.data.retainedOutcome
        || reviewArtifact.taskId !== assignment.taskId || reviewArtifact.authorOutcome !== retained.data.retainedOutcome
        || (metrics && (metrics.taskId !== assignment.taskId
          || metrics.provenance.attemptBundleDigest !== `sha256:${retained.data.attemptBundleSha256}`
          || metrics.provenance.artifactRoot !== `sha256:${retained.data.artifactRoot}`
          || metrics.provenance.authorEvidenceRoot !== `sha256:${retained.data.authorEvidenceRoot}`
          || metrics.provenance.verifiedArtifactCount !== retained.data.artifacts.length))) {
      throw new Error(`EXP0001A_SOURCE_ROW_MAPPING_DRIFT:${expected.attemptId}`);
    }
    if (metrics) {
      const tokens = metrics.efficiency.tokens;
      const cost = metrics.efficiency.costUsd;
      if (tokens.status === "observed" && retained.data.usage
          && tokenTotal(tokens.value) !== retained.data.usage.totalTokens) {
        throw new Error(`EXP0001A_METRICS_USAGE_DRIFT:${expected.attemptId}:tokens`);
      }
      if (cost.status === "observed" && retained.data.actualCostUsd !== null
          && directNumber(cost.value) !== retained.data.actualCostUsd) {
        throw new Error(`EXP0001A_METRICS_USAGE_DRIFT:${expected.attemptId}:costUsd`);
      }
    }
    const primaryLocks = reviewArtifact.primaryReviewerIds.map((reviewerId) => reviewLedger.primaryLocks.find((lock) => (
      lock.artifactId === reviewArtifact.artifactId && lock.reviewerId === reviewerId
    )));
    if (primaryLocks.some((lock) => !lock)) throw new Error(`EXP0001A_PRIMARY_REVIEW_MISSING:${expected.attemptId}`);
    const lockedPrimaries = primaryLocks.map((lock) => lock!.record) as [LockedEvaluatorRecord, LockedEvaluatorRecord];
    const adjudicationLock = reviewLedger.adjudicationLocks.find((lock) => lock.artifactId === reviewArtifact.artifactId)?.record ?? null;
    const missingMetricsReason = "No verified attempt-metrics artifact was retained for this attempt.";
    const incidents = [
      ...batchRegistry.events.flatMap((event) => event.kind === "not_started" && event.attemptId === expected.attemptId ? [{
        code: event.data.incidentCode,
        status: "not_started" as const,
        hardIncident: event.data.hardIncident,
        falsification: event.data.falsification,
        sourceEventDigest: event.eventDigest,
      }] : []),
      ...(retained.data.incidentCode === null ? [] : [{
        code: retained.data.incidentCode,
        status: "retained" as const,
        hardIncident: retained.data.hardIncident,
        falsification: retained.data.falsification,
        sourceEventDigest: retained.eventDigest,
      }]),
    ];
    return attemptAnalysisSchema.parse({
      attemptId: expected.attemptId,
      pairId: assignment.pairId,
      taskId: assignment.taskId,
      taskFamily: assignment.taskFamily,
      stratum: assignment.stratum,
      opaqueLabel: expected.opaqueLabel,
      orderIndex: expected.orderIndex,
      timeBlock: assignment.timeBlock,
      treatmentDigest: expected.treatmentDigest,
      executorOutcome: retained.data.executorOutcome,
      retainedStatus: retained.data.retainedOutcome,
      authorOutcome: sealed.authorOutcome,
      incidents,
      providerIdentity: retained.data.providerIdentity,
      accepted: classification.accepted,
      reviewAccepted: classification.reviewAccepted,
      primaryFailureClass: classification.primaryFailureClass,
      mechanismTags: mechanismsFromPrimaryRecords(lockedPrimaries),
      primaryReviews: lockedPrimaries.map(normalizedReview),
      adjudication: adjudicationLock ? normalizedReview(adjudicationLock) : null,
      artifactFields: requiredArtifactFields({ retained, metrics, classification }),
      resources: {
        latencyMs: numericMetricObservation(metrics?.timing.totalAttemptWallMs, directNumber, missingMetricsReason),
        tokens: numericMetricObservation(metrics?.efficiency.tokens, tokenTotal, missingMetricsReason),
        toolCalls: numericMetricObservation(metrics?.efficiency.toolCalls, directNumber, missingMetricsReason),
        costUsd: numericMetricObservation(metrics?.efficiency.costUsd, directNumber, missingMetricsReason),
      },
    });
  }));

  const reportRowByPairKey = new Map(unblindedReport.rows.map((row) => [row.pairKey, row]));
  const classificationByArtifact = new Map(classifications.classifications.map((item) => [item.artifactId, item]));
  const preferences = pairwisePlan.assignments.map((pairwiseAssignment, index) => {
    const manifestPair = manifest.assignments.find((assignment) => assignment.pairDigest === pairwiseAssignment.manifestPairDigest);
    const reportRow = reportRowByPairKey.get(pairwiseAssignment.pairKey);
    const locked = pairwiseLedger.records[index];
    const leftAttemptId = classificationByArtifact.get(pairwiseAssignment.bindings.left.artifactId)?.attemptId;
    const rightAttemptId = classificationByArtifact.get(pairwiseAssignment.bindings.right.artifactId)?.attemptId;
    if (!manifestPair || !reportRow || locked.pairKey !== pairwiseAssignment.pairKey || !leftAttemptId || !rightAttemptId) {
      throw new Error(`EXP0001A_PAIRWISE_MAPPING_MISSING:${pairwiseAssignment.pairKey}`);
    }
    const labelByAttempt = new Map(manifestPair.attempts.map((attempt) => [attempt.attemptId, attempt.opaqueLabel]));
    const leftOpaqueLabel = labelByAttempt.get(leftAttemptId);
    const rightOpaqueLabel = labelByAttempt.get(rightAttemptId);
    if (!leftOpaqueLabel || !rightOpaqueLabel || reportRow.leftLabel !== leftOpaqueLabel || reportRow.rightLabel !== rightOpaqueLabel) {
      throw new Error(`EXP0001A_PAIRWISE_LABEL_MAPPING_DRIFT:${manifestPair.pairId}`);
    }
    const outcome = reportRow.status === "failed" ? "failed" as const
      : reportRow.labelPreference === "tie" ? "tie" as const
        : reportRow.labelPreference === leftOpaqueLabel ? "left" as const : "right" as const;
    const provider = locked.record.provider;
    const providerIdentity = provider.responseId === null
      ? providerRecordIdentitySchema.parse({
        status: "unobservable",
        requestedModelIdentifier: provider.modelRequested,
        requestedServiceTier: pairwisePlan.scorerPolicy.serviceTier,
        observedModelIdentifier: null,
        observedServiceTier: null,
        requestedAliasExactMatch: null,
      })
      : providerRecordIdentitySchema.parse({
        status: provider.serviceTierObserved === pairwisePlan.scorerPolicy.serviceTier ? "observed" : "falsified",
        requestedModelIdentifier: provider.modelRequested,
        requestedServiceTier: pairwisePlan.scorerPolicy.serviceTier,
        observedModelIdentifier: provider.modelObserved,
        observedServiceTier: provider.serviceTierObserved,
        requestedAliasExactMatch: provider.requestedAliasExactMatch,
      });
    const withoutMapping = {
      pairId: manifestPair.pairId,
      leftAttemptId,
      rightAttemptId,
      leftOpaqueLabel,
      rightOpaqueLabel,
      outcome,
      failureCode: outcome === "failed" ? locked.record.failure?.code ?? "pairwise_scorer_failed" : null,
      providerIdentity,
    };
    return preferenceSchema.parse({
      ...withoutMapping,
      mappingDigest: computeExp0001aPreferenceMappingDigest(withoutMapping),
    });
  });

  const attemptMetricsRoot = hashCanonicalJson([...metricsByAttempt.values()]
    .map((artifact) => ({ attemptId: artifact.attemptId, artifactDigest: artifact.artifactDigest }))
    .sort((left, right) => compareCodeUnits(left.attemptId, right.attemptId)));
  const artifactCompletenessRoot = hashCanonicalJson(attempts.map((attempt) => ({
    attemptId: attempt.attemptId,
    fields: attempt.artifactFields,
  })));
  const failureTaxonomyDigest = hashCanonicalJson({
    schemaVersion: "exp-0001a-analysis-taxonomy/v1",
    primaryFailureClasses: FROZEN_PRIMARY_FAILURE_CLASSES,
    mechanismTags: reviewPlan.policy.mechanismTags,
    retainedStatuses: ["completed", "failed", "timeout", "infra_failure", "policy_violation"],
    incidentSources: ["batch-registry-not-started", "batch-registry-attempt-retained"],
  });
  const experimentSpendAccounting = buildExperimentSpendAccounting({
    batchPlan: source.batchPlan,
    batchRegistry,
    reviewPlan,
    reviewLedger,
    pairwisePlan,
    pairwiseLedger,
    spendEvents: source.spendLedger.events,
    authorizedMaximumUsd: source.spendLedger.authorizedMaximumUsd,
    authorizationReceiptDigest: source.spendLedger.authorizationReceiptDigest,
    externalAnchorRoot: source.spendLedger.externalAnchorRoot,
    externalAnchorCount: source.spendLedger.externalAnchorCount,
  });
  return exp0001aAnalysisInputSchema.parse({
    schemaVersion: 1,
    kind: "exp-0001a-normalized-analysis-input",
    protocolId: "EXP-0001A",
    sourceRoots: {
      manifestDigest: manifest.manifestDigest,
      batchPlanDigest: source.batchPlan.planDigest,
      batchRegistryDigest: batchRegistry.registryDigest,
      perAttemptAliasVerificationRoot,
      registryBridgeReceiptDigest: source.registryBridge.receipt.receiptDigest,
      attemptRegistryRoot: registry.registryRoot,
      reviewPlanRoot: reviewPlan.planRoot,
      reviewLedgerRoot: reviewLedger.ledgerRoot,
      classificationRoot: classifications.classificationRoot,
      pairwisePlanRoot: pairwisePlan.planRoot,
      pairwisePreferenceRoot: pairwiseLedger.ledgerRoot,
      pairwisePreferenceSealRoot: pairwiseSeal.sealRoot,
      unblindedPairwiseReportRoot: unblindedReport.reportRoot,
      attemptMetricsRoot,
      spendLedgerRoot: experimentSpendAccounting.spendLedgerRoot,
      spendExternalAnchorRoot: experimentSpendAccounting.spendExternalAnchorRoot,
      artifactCompletenessRoot,
      failureTaxonomyDigest,
    },
    manifest,
    attempts,
    preferences,
    experimentSpendAccounting,
  });
}

const SEALED_SENSITIVITY_ROWS = planSealedSampleScenarios(EXP0001A_SEALED_SAMPLE_SENSITIVITY_SCENARIOS);
const EXTERNALLY_FIXED_CANDIDATE_LIFTS = [0.08, 0.12, 0.15] as const;
const OBSERVED_PLANNING_SIMULATIONS = 1_000;
const OBSERVED_PLANNING_MINIMUM_UNIQUE_TASKS = 30;
const OBSERVED_PLANNING_MAXIMUM_UNIQUE_TASKS = 600;
const OBSERVED_PLANNING_FAMILYWISE_ERROR = 0.05;
const OBSERVED_PLANNING_CANDIDATE_COUNT = OBSERVED_PLANNING_MAXIMUM_UNIQUE_TASKS
  - OBSERVED_PLANNING_MINIMUM_UNIQUE_TASKS + 1;
const OBSERVED_PLANNING_MINIMUM_DISCORDANCE = 0.30;
const OBSERVED_PLANNING_MINIMUM_ICC = 0.40;
const OBSERVED_PLANNING_BOOTSTRAP_DRAWS = 10_000;
const OBSERVED_PLANNING_BOOTSTRAP_SEED = 2_026_083_200;
const observedAaSamplePlanningCache = new Map<
  string,
  Exp0001aAnalysisReport["sealedSampleSensitivity"]["observedAaCalibrated"]
>();

function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

function wilsonScoreInterval(successes: number, trials: number): PlanningInterval {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || trials < 1 || successes < 0 || successes > trials) {
    throw new Error("EXP0001A_WILSON_INTERVAL_INPUT_INVALID");
  }
  const zValue = 1.959963984540054;
  const estimate = successes / trials;
  const denominator = 1 + zValue ** 2 / trials;
  const center = (estimate + zValue ** 2 / (2 * trials)) / denominator;
  const halfWidth = zValue / denominator * Math.sqrt(
    estimate * (1 - estimate) / trials + zValue ** 2 / (4 * trials ** 2),
  );
  return {
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    level: 0.95,
    method: "wilson_score",
    draws: 0,
    seed: 0,
  };
}

function deterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function intrataskCorrelationForVectors(vectors: readonly (readonly [number, number])[]): number | null {
  if (vectors.length < 2) return null;
  const differences = vectors.flatMap((values) => values);
  const taskMeans = vectors.map((values) => (values[0] + values[1]) / 2);
  const grandMean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const betweenMeanSquare = 2 * taskMeans.reduce((sum, value) => sum + (value - grandMean) ** 2, 0)
    / (vectors.length - 1);
  const withinMeanSquare = vectors.reduce((sum, values) => {
    const mean = (values[0] + values[1]) / 2;
    return sum + values.reduce((inner, value) => inner + (value - mean) ** 2, 0);
  }, 0) / vectors.length;
  const denominator = betweenMeanSquare + withinMeanSquare;
  return denominator === 0 ? null : (betweenMeanSquare - withinMeanSquare) / denominator;
}

function percentile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) throw new Error("EXP0001A_PERCENTILE_REQUIRES_OBSERVATIONS");
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function dependenceBootstrapInterval(vectors: readonly (readonly [number, number])[]): PlanningInterval {
  const random = deterministicRandom(OBSERVED_PLANNING_BOOTSTRAP_SEED);
  const estimates: number[] = [];
  for (let draw = 0; draw < OBSERVED_PLANNING_BOOTSTRAP_DRAWS; draw += 1) {
    const resampled = Array.from({ length: vectors.length }, () => (
      vectors[Math.floor(random() * vectors.length)]
    ));
    const estimate = intrataskCorrelationForVectors(resampled);
    if (estimate !== null && Number.isFinite(estimate)) estimates.push(estimate);
  }
  if (estimates.length === 0) {
    return {
      lower: 0,
      upper: OBSERVED_PLANNING_MINIMUM_ICC,
      level: 0.95,
      method: "predeclared_nonestimable_fallback",
      draws: OBSERVED_PLANNING_BOOTSTRAP_DRAWS,
      seed: OBSERVED_PLANNING_BOOTSTRAP_SEED,
    };
  }
  estimates.sort((left, right) => left - right);
  return {
    lower: percentile(estimates, 0.025),
    upper: percentile(estimates, 0.975),
    level: 0.95,
    method: "deterministic_task_cluster_percentile_bootstrap",
    draws: OBSERVED_PLANNING_BOOTSTRAP_DRAWS,
    seed: OBSERVED_PLANNING_BOOTSTRAP_SEED,
  };
}

function observedAaSamplePlanning(reconciled: Reconciled): Exp0001aAnalysisReport["sealedSampleSensitivity"]["observedAaCalibrated"] {
  const cacheKey = hashCanonicalJson(reconciled.pairs.map((pair) => ({
    pairId: pair.pairId,
    taskId: pair.taskId,
    a0Accepted: pair.A0.accepted,
    a1Accepted: pair.A1.accepted,
  })));
  const cached = observedAaSamplePlanningCache.get(cacheKey);
  if (cached) return structuredClone(cached);
  const differences = reconciled.pairs.map((pair) => Number(pair.A1.accepted) - Number(pair.A0.accepted));
  const pooledSuccessCount = reconciled.attempts.filter((attempt) => attempt.accepted).length;
  const discordantPairCount = differences.filter((difference) => difference !== 0).length;
  const pooledSuccessRate = pooledSuccessCount / 48;
  const pairedDiscordanceRate = discordantPairCount / 24;
  const byTask = new Map<string, number[]>();
  reconciled.pairs.forEach((pair, index) => {
    const values = byTask.get(pair.taskId) ?? [];
    values.push(differences[index]);
    byTask.set(pair.taskId, values);
  });
  if (byTask.size !== 12 || [...byTask.values()].some((values) => values.length !== 2)) {
    throw new Error("EXP0001A_SAMPLE_PLAN_TASK_REPLICATION_DRIFT");
  }
  const taskVectors = [...byTask.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, values]) => [values[0], values[1]] as const);
  const taskMeans = taskVectors.map((values) => (values[0] + values[1]) / 2);
  const intrataskCorrelation = intrataskCorrelationForVectors(taskVectors);
  const pooledSuccessRate95Interval = wilsonScoreInterval(pooledSuccessCount, 48);
  const pairedDiscordanceRate95Interval = wilsonScoreInterval(discordantPairCount, 24);
  const intrataskCorrelation95Interval = dependenceBootstrapInterval(taskVectors);
  const planningIcc = Math.min(0.95, Math.max(
    OBSERVED_PLANNING_MINIMUM_ICC,
    intrataskCorrelation95Interval.upper,
  ));
  const rows = EXTERNALLY_FIXED_CANDIDATE_LIFTS.map((candidateLift, index) => {
    const planningDiscordanceRate = Math.max(
      pairedDiscordanceRate95Interval.upper,
      OBSERVED_PLANNING_MINIMUM_DISCORDANCE,
      candidateLift,
    );
    const maximumFeasibleDiscordance = Math.min(
      1,
      2 * (1 - pooledSuccessRate) - candidateLift,
      2 * pooledSuccessRate + candidateLift,
    );
    if (pooledSuccessRate + candidateLift > 1 || planningDiscordanceRate > maximumFeasibleDiscordance) {
      return {
        candidateLift,
        status: "not_estimable" as const,
        reason: "Observed A/A baseline and discordance do not define a feasible paired distribution for this externally fixed positive lift.",
        planningBaselineRate: pooledSuccessRate,
        planningDiscordanceRate: null,
        planningIntrataskCorrelation: planningIcc,
        oneShotPlanRole: "diagnostic_only_not_recommended_sample_size" as const,
        plan: null,
        recommendation: null,
      };
    }
    const id = `sensitivity-observed-aa-lift-${String(Math.round(candidateLift * 100)).padStart(2, "0")}`;
    const assumptions = {
      baselineRate: pooledSuccessRate,
      candidateLift,
      discordanceRate: planningDiscordanceRate,
      alpha: 0.05,
      targetPower: 0.80,
    };
    const nominal = findNominalPairRequirement({ ...assumptions, maximumPairs: 2_000 });
    const designEffect = intrataskDesignEffect(2, planningIcc);
    const adjustedPairRequirement = nominal.requiredPairs === null ? null : Math.ceil(nominal.requiredPairs * designEffect);
    const uniqueTaskRequirement = adjustedPairRequirement === null ? null : Math.ceil(adjustedPairRequirement / 2);
    const roundedTotalPairs = uniqueTaskRequirement === null ? null : uniqueTaskRequirement * 2;
    const plan: SealedSamplePlanRow = {
      id,
      assumptions,
      nominal,
      clusterAdjusted: {
        replicatesPerTask: 2,
        intrataskCorrelation: planningIcc,
        designEffect,
        adjustedPairRequirement,
        uniqueTaskRequirement,
        roundedTotalPairs,
        monteCarlo: uniqueTaskRequirement !== null && uniqueTaskRequirement >= 30
          ? monteCarloClusterPower({
            ...assumptions,
            taskCount: uniqueTaskRequirement,
            replicatesPerTask: 2,
            intrataskCorrelation: planningIcc,
            simulations: 1_000,
            seed: 2_026_083_110 + index,
          })
          : null,
      },
    };
    const startUniqueTasks = Math.max(
      OBSERVED_PLANNING_MINIMUM_UNIQUE_TASKS,
      plan.clusterAdjusted.uniqueTaskRequirement ?? OBSERVED_PLANNING_MINIMUM_UNIQUE_TASKS,
    );
    const seedBase = 2_026_084_000 + index * 100_000;
    const trace = [];
    let recommendedUniqueTasks: number | null = null;
    for (let taskCount = startUniqueTasks; taskCount <= OBSERVED_PLANNING_MAXIMUM_UNIQUE_TASKS; taskCount += 1) {
      const seed = seedBase + taskCount;
      const power = monteCarloTaskClusterSignFlipPower({
        ...assumptions,
        taskCount,
        replicatesPerTask: 2,
        intrataskCorrelation: planningIcc,
        simulations: OBSERVED_PLANNING_SIMULATIONS,
        seed,
      });
      const simultaneousFamilywise95LowerBound = Math.max(0, power.power - Math.sqrt(
        Math.log(OBSERVED_PLANNING_CANDIDATE_COUNT / OBSERVED_PLANNING_FAMILYWISE_ERROR)
          / (2 * power.simulations),
      ));
      const lowerBoundReachesTarget = simultaneousFamilywise95LowerBound >= assumptions.targetPower;
      trace.push({
        taskCount,
        totalPairs: taskCount * 2,
        simulations: power.simulations,
        seed,
        estimatedPower: power.power,
        pointwiseMonteCarlo95Interval: power.monteCarlo95Interval,
        simultaneousFamilywise95LowerBound,
        lowerBoundReachesTarget,
      });
      if (lowerBoundReachesTarget) {
        recommendedUniqueTasks = taskCount;
        break;
      }
    }
    return {
      candidateLift,
      status: "estimated" as const,
      reason: null,
      planningBaselineRate: pooledSuccessRate,
      planningDiscordanceRate,
      planningIntrataskCorrelation: planningIcc,
      oneShotPlanRole: "diagnostic_only_not_recommended_sample_size" as const,
      plan,
      recommendation: {
        status: recommendedUniqueTasks === null ? "maximum_exhausted" as const : "target_reached" as const,
        recommendedUniqueTasks,
        recommendedTotalPairs: recommendedUniqueTasks === null ? null : recommendedUniqueTasks * 2,
        startUniqueTasks,
        maximumUniqueTasks: OBSERVED_PLANNING_MAXIMUM_UNIQUE_TASKS,
        simulationsPerCandidate: OBSERVED_PLANNING_SIMULATIONS,
        seedBase,
        decisionTest: "two_sided_task_cluster_sign_flip_normal_approximation" as const,
        familywiseMonteCarloPolicy: "one_sided_hoeffding_bound_with_bonferroni_over_fixed_candidate_universe" as const,
        familywiseErrorProbability: OBSERVED_PLANNING_FAMILYWISE_ERROR as 0.05,
        fixedCandidateUniverseCount: OBSERVED_PLANNING_CANDIDATE_COUNT,
        trace,
      },
    };
  });
  const result: Exp0001aAnalysisReport["sealedSampleSensitivity"]["observedAaCalibrated"] = {
    source: "development_aa_outcomes_with_externally_fixed_candidate_lifts",
    sealedTaskDataAccessed: false,
    uncertainty: "exploratory-small-sample-24-pairs-12-tasks-not-confirmatory",
    estimates: {
      pooledSuccessRate,
      pooledSuccessRate95Interval,
      pairedDiscordanceRate,
      pairedDiscordanceRate95Interval,
      signedPairDifferenceVariance: sampleVariance(differences),
      taskMeanDifferenceVariance: sampleVariance(taskMeans),
      intrataskCorrelation,
      intrataskCorrelation95Interval,
      dependenceIntervalBootstrap: {
        method: "deterministic_task_cluster_percentile_bootstrap",
        seed: OBSERVED_PLANNING_BOOTSTRAP_SEED,
        draws: OBSERVED_PLANNING_BOOTSTRAP_DRAWS,
      },
      pairCount: 24,
      taskCount: 12,
      replicatesPerTask: 2,
    },
    planningPolicy: {
      candidateLiftsAreExternallyFixed: true,
      candidateLifts: EXTERNALLY_FIXED_CANDIDATE_LIFTS,
      discordanceBound: "max-upper-95-percent-interval-and-absolute-fixed-lift",
      minimumConservativeDiscordance: OBSERVED_PLANNING_MINIMUM_DISCORDANCE,
      negativeIccTruncatedToZero: true,
      conservativeIccBound: "max-upper-95-percent-bootstrap-interval-and-predeclared-floor",
      minimumConservativeIcc: OBSERVED_PLANNING_MINIMUM_ICC,
      nonestimableIccFallback: OBSERVED_PLANNING_MINIMUM_ICC,
      decisionTest: "two_sided_task_cluster_sign_flip_normal_approximation",
      targetLowerMonteCarlo95Power: 0.80,
      simulationsPerCandidate: OBSERVED_PLANNING_SIMULATIONS,
      taskIncrement: 1,
      familywiseMonteCarloPolicy: "one_sided_hoeffding_bound_with_bonferroni_over_fixed_candidate_universe",
      familywiseErrorProbability: OBSERVED_PLANNING_FAMILYWISE_ERROR,
      fixedCandidateUniverse: {
        minimumUniqueTasks: OBSERVED_PLANNING_MINIMUM_UNIQUE_TASKS,
        maximumUniqueTasks: OBSERVED_PLANNING_MAXIMUM_UNIQUE_TASKS,
        candidateCount: OBSERVED_PLANNING_CANDIDATE_COUNT,
      },
      maximumUniqueTasks: OBSERVED_PLANNING_MAXIMUM_UNIQUE_TASKS,
    },
    rows,
  };
  observedAaSamplePlanningCache.set(cacheKey, result);
  return structuredClone(result);
}

function withoutReportDigest(report: Exp0001aAnalysisReport): Omit<Exp0001aAnalysisReport, "reportDigest"> {
  const { reportDigest: _ignored, ...unsigned } = report;
  void _ignored;
  return unsigned;
}

export function computeExp0001aAnalysisReportDigest(report: Exp0001aAnalysisReport): string {
  return hashCanonicalJson(withoutReportDigest(report));
}

function compileNormalizedExp0001aAnalysis(raw: unknown): Exp0001aAnalysisReport {
  const input = exp0001aAnalysisInputSchema.parse(raw);
  const reconciled = reconcile(input);
  const overall = pairedSuccessStratum(reconciled.pairs);
  const byTaskFamily = Object.fromEntries((["architecture", "drawing"] as const).map((family) => [
    family,
    pairedSuccessStratum(reconciled.pairs.filter((pair) => pair.taskFamily === family)),
  ]));
  const reviewer = reviewerDiagnostics(reconciled.attempts);
  const measurementContext = measurementContextDiagnostics(reconciled.attempts);
  const preference = preferenceDiagnostics(reconciled.pairs);
  const completeness = artifactCompleteness(reconciled.attempts);
  const ratios = Object.fromEntries(RESOURCE_METRICS.map((metric) => [
    metric,
    resourceRatio(metric, reconciled.pairs),
  ])) as Exp0001aAnalysisReport["resourceRatios"];
  const identityDiagnostics = providerIdentityDiagnostics(reconciled);
  const checks = analysisAlarms(
    overall,
    preference,
    reviewer,
    completeness,
    ratios,
    identityDiagnostics,
    measurementContext,
  );
  const providerIdentities = reconciled.attempts.map((attempt) => attempt.providerIdentity);
  const observedProviderIdentities = providerIdentities.filter((identity) => identity?.status === "observed");
  const nonDefaultServiceTierAttempts = observedProviderIdentities.filter((identity) => (
    identity!.observedServiceTiers.some((tier) => tier !== "default")
  )).length;
  checks.push({
    code: "NON_DEFAULT_SERVICE_TIER_OBSERVED",
    rule: "Every observed author response must retain the frozen default service tier.",
    evaluation: "evaluated",
    observed: nonDefaultServiceTierAttempts,
    triggered: nonDefaultServiceTierAttempts > 0,
  });
  const reportWithoutDigest: Omit<Exp0001aAnalysisReport, "reportDigest"> = {
    schemaVersion: "exp-0001a-analysis/v1",
    kind: "exp-0001a-aa-calibration-report",
    protocolId: "EXP-0001A",
    purpose: "calibration_only",
    claimPolicy: {
      improvementClaimPermitted: false,
      equivalenceClaimPermitted: false,
      permittedClaim: "Observed A0/A1 differences are instrumentation diagnostics from identical treatments, not evidence of product or harness improvement, harm, equivalence, or absence of bias.",
    },
    provenance: {
      manifestDigest: reconciled.manifest.manifestDigest,
      analysisInputDigest: hashCanonicalJson(input),
      normalizedAttemptsRoot: hashCanonicalJson(reconciled.attempts),
      normalizedPreferencesRoot: hashCanonicalJson(reconciled.preferences),
      sourceRoots: input.sourceRoots,
    },
    integrity: {
      exactManifestReconciliation: true,
      exactAttemptCount: 48,
      exactPairCount: 24,
      exclusionsPermitted: false,
      exclusionCount: 0,
      identicalTreatmentDigest: reconciled.manifest.treatments.A0,
    },
    providerModelIdentity: {
      requestedModelIdentifier: "gpt-5.6-sol",
      immutableWeightSnapshotAsserted: false,
      responseModelAndServiceTierRetentionRequired: true,
      observedAttempts: observedProviderIdentities.length,
      unobservableAttempts: providerIdentities.filter((identity) => identity === null || identity.status === "unobservable").length,
      falsifiedAttempts: providerIdentities.filter((identity) => identity?.status === "falsified").length,
      nonDefaultServiceTierAttempts,
      observedModelIdentifierCounts: countBy(observedProviderIdentities.flatMap((identity) => identity!.observedModelIdentifiers)),
      observedServiceTierCounts: countBy(observedProviderIdentities.flatMap((identity) => identity!.observedServiceTiers)),
      interpretation: "The requested provider model ID is frozen and returned model/service-tier values are retained and drift-checked; the provider does not expose a dated immutable weight snapshot, so weight immutability is not asserted.",
    },
    providerIdentityDiagnostics: identityDiagnostics,
    runAccounting: {
      plannedAttempts: 48,
      retainedAttempts: 48,
      plannedPairs: 24,
      reconciledPairs: 24,
      byLabel: {
        A0: reconciled.attempts.filter((attempt) => attempt.opaqueLabel === "A0").length,
        A1: reconciled.attempts.filter((attempt) => attempt.opaqueLabel === "A1").length,
      },
      executorOutcomeCounts: countBy(reconciled.attempts.map((attempt) => attempt.executorOutcome)),
      retainedStatusCounts: countBy(reconciled.attempts.map((attempt) => attempt.retainedStatus)),
      authorOutcomeCounts: countBy(reconciled.attempts.map((attempt) => attempt.authorOutcome)),
      incidentCodeCounts: countBy(reconciled.attempts.flatMap((attempt) => attempt.incidents.map((incident) => incident.code))),
    },
    pairedSuccess: { overall, byTaskFamily },
    reviewerDiagnostics: reviewer,
    measurementContextDiagnostics: measurementContext,
    preferenceDiagnostics: preference,
    artifactCompleteness: completeness,
    taxonomy: taxonomy(reconciled.attempts),
    experimentSpendAccounting: input.experimentSpendAccounting,
    resourceRatios: ratios,
    orderAndTimeDiagnostics: orderAndTime(reconciled.pairs),
    alarms: {
      thresholds: EXP0001A_ANALYSIS_THRESHOLDS,
      checks,
      triggeredCodes: checks.filter((check) => check.triggered).map((check) => check.code),
      requiresInvestigation: checks.some((check) => check.triggered),
    },
    sealedSampleSensitivity: {
      source: "frozen_hypothetical_public_planning_only",
      sealedTaskDataAccessed: false,
      scenarioInputsDigest: hashCanonicalJson(EXP0001A_SEALED_SAMPLE_SENSITIVITY_SCENARIOS),
      hypotheticalRowsRole: "non_recommendation_diagnostics_only",
      selectedDesignSource: "observed_aa_uncertainty_aware_search_only",
      selectedDesignTest: "two_sided_task_cluster_sign_flip_normal_approximation",
      rows: SEALED_SENSITIVITY_ROWS,
      observedAaCalibrated: observedAaSamplePlanning(reconciled),
    },
  };
  return Object.freeze({
    ...reportWithoutDigest,
    reportDigest: hashCanonicalJson(reportWithoutDigest),
  });
}

/** Production compiler: raw experiment sources in, deterministic report out. */
export function compileExp0001aAnalysis(rawSourceContext: Exp0001aAnalysisSourceContext): Exp0001aAnalysisReport {
  return compileNormalizedExp0001aAnalysis(buildExp0001aAnalysisInput(rawSourceContext));
}

/**
 * Test-only statistical seam. It deliberately does not constitute source
 * verification and must never be used to issue an experiment report.
 */
export function compileExp0001aNormalizedAnalysisForTesting(raw: unknown): Exp0001aAnalysisReport {
  return compileNormalizedExp0001aAnalysis(raw);
}

const analysisReportSchema = z.object({
  schemaVersion: z.literal("exp-0001a-analysis/v1"),
  kind: z.literal("exp-0001a-aa-calibration-report"),
  protocolId: z.literal("EXP-0001A"),
  purpose: z.literal("calibration_only"),
  claimPolicy: z.object({
    improvementClaimPermitted: z.literal(false),
    equivalenceClaimPermitted: z.literal(false),
    permittedClaim: z.string().min(1),
  }).strict(),
  provenance: z.unknown(),
  integrity: z.unknown(),
  providerModelIdentity: z.unknown(),
  providerIdentityDiagnostics: z.unknown(),
  runAccounting: z.unknown(),
  pairedSuccess: z.unknown(),
  reviewerDiagnostics: z.unknown(),
  measurementContextDiagnostics: z.unknown(),
  preferenceDiagnostics: z.unknown(),
  artifactCompleteness: z.unknown(),
  taxonomy: z.unknown(),
  experimentSpendAccounting: experimentSpendAccountingSchema,
  resourceRatios: z.unknown(),
  orderAndTimeDiagnostics: z.unknown(),
  alarms: z.unknown(),
  sealedSampleSensitivity: z.unknown(),
  reportDigest: digestSchema,
}).strict();

export type Exp0001aAnalysisVerification =
  | { ok: true; report: Exp0001aAnalysisReport }
  | { ok: false; errors: string[] };

function verifyReportAgainstCompiler(
  rawReport: unknown,
  rawInput: unknown,
  compiler: (raw: unknown) => Exp0001aAnalysisReport,
): Exp0001aAnalysisVerification {
  const parsed = analysisReportSchema.safeParse(rawReport);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `REPORT_SCHEMA:${issue.path.join("/")}:${issue.message}`),
    };
  }
  const report = parsed.data as Exp0001aAnalysisReport;
  const errors: string[] = [];
  if (computeExp0001aAnalysisReportDigest(report) !== report.reportDigest) {
    errors.push("REPORT_DIGEST_MISMATCH");
  }
  try {
    const expected = compiler(rawInput);
    if (canonicalJson(expected) !== canonicalJson(report)) errors.push("REPORT_INPUT_RECONCILIATION_MISMATCH");
  } catch (error) {
    errors.push(`REPORT_INPUT_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
  return errors.length === 0 ? { ok: true, report } : { ok: false, errors };
}

export function verifyExp0001aAnalysisReport(
  rawReport: unknown,
  rawSourceContext: Exp0001aAnalysisSourceContext,
): Exp0001aAnalysisVerification {
  return verifyReportAgainstCompiler(
    rawReport,
    rawSourceContext,
    (raw) => compileExp0001aAnalysis(raw as Exp0001aAnalysisSourceContext),
  );
}

/** Test-only verifier counterpart to the normalized statistical seam. */
export function verifyExp0001aNormalizedAnalysisForTesting(
  rawReport: unknown,
  rawNormalizedInput: unknown,
): Exp0001aAnalysisVerification {
  return verifyReportAgainstCompiler(rawReport, rawNormalizedInput, compileNormalizedExp0001aAnalysis);
}
