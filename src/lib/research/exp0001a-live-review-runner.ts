import { z } from "zod";

import {
  computeExp0001aEffectiveAliasVerificationRoot,
} from "./exp0001a-batch-coordinator";
import {
  blindedReviewPlanSchema,
  computeEvaluatorRecordSha256,
  createBlindedReviewPlan,
  finalizeArtifactClassifications,
  lockedEvaluatorRecordSchema,
  lockAdjudicationReviews,
  lockPrimaryReviews,
  prepareAdjudicationWork,
  type BlindedReviewPolicy,
  type ClassificationBook,
  type EvaluatorArtifactSource,
  type LockedEvaluatorRecord,
  type ReviewLedger,
  type ReviewerRosterEntry,
  type ReviewerWorkItem,
} from "./blinded-review-orchestration";
import {
  computeReviewStageRecordRoot,
  reviewPhaseReceiptSchema,
  type ReviewAmbiguousFailureRecord,
  type ReviewPhaseReceipt,
  type ReviewPhaseRunner,
  type ReviewPhaseRunnerInput,
  type ReviewPhaseResumeState,
  type ReviewStage,
  type ReviewWorkItemSpend,
} from "./exp0001a-batch-command";
import {
  computePairwiseInputSha256,
  computePairwisePreferenceRecordRoot,
  computePairwiseScorerPolicyDigest,
  computePairwiseWorkItemSha256,
  createPairwiseVisualPreferencePlan,
  maximumPairwisePreferenceCallCost,
  lockPairwisePreferenceRecords,
  pairwisePreferenceRecordSchema,
  unblindPairwiseVisualPreferences,
  type PairwiseExactRenderCatalog,
  type PairwiseExactRenderVerificationReceipt,
  type PairwisePlanContext,
  type PairwisePreferenceLedger,
  type PairwisePreferenceLedgerSeal,
  type PairwisePreferenceRecord,
  type PairwiseVisualPreferencePlan,
  type UnblindedPairwiseReport,
} from "./pairwise-visual-preference";
import { canonicalJson, hashCanonicalJson } from "./provenance-crypto";

export const EXP0001A_LIVE_REVIEW_RUNNER_SOURCE_PATH =
  "src/lib/research/exp0001a-live-review-runner.ts" as const;

export type EvaluatorRunResult = { record: LockedEvaluatorRecord; outputPath?: string };
export type Exp0001aEvaluatorReviewRuntime = {
  run(input: {
    workItem: ReviewerWorkItem;
    spendAuthorizationReceiptDigest: string;
  }): Promise<EvaluatorRunResult>;
  recover(input: {
    workItem: ReviewerWorkItem;
    spendAuthorizationReceiptDigest: string;
  }): Promise<EvaluatorRunResult>;
  load(input: {
    workItem: ReviewerWorkItem;
    spendAuthorizationReceiptDigest: string;
  }): Promise<LockedEvaluatorRecord | null>;
};

export type Exp0001aPairwiseReviewRuntime = {
  context(input: {
    reviewPlan: ReturnType<typeof blindedReviewPlanSchema.parse>;
    reviewLedger: ReturnType<typeof lockAdjudicationReviews>;
    classificationBook: ReturnType<typeof finalizeArtifactClassifications>;
  }): Promise<PairwisePlanContext> | PairwisePlanContext;
  run(input: {
    plan: PairwiseVisualPreferencePlan;
    context: PairwisePlanContext;
    workItemId: string;
  }): Promise<PairwisePreferenceRecord>;
  recover(input: {
    plan: PairwiseVisualPreferencePlan;
    context: PairwisePlanContext;
    workItemId: string;
  }): Promise<PairwisePreferenceRecord>;
  load(input: {
    plan: PairwiseVisualPreferencePlan;
    context: PairwisePlanContext;
    workItemId: string;
  }): Promise<PairwisePreferenceRecord | null>;
  sealedAt: () => Promise<string> | string;
};

export type Exp0001aReviewAggregateSet = {
  reviewLedger: ReviewLedger;
  classificationBook: ClassificationBook;
  pairwiseExactRenderCatalog: PairwiseExactRenderCatalog;
  pairwiseExactRenderVerificationReceipt: PairwiseExactRenderVerificationReceipt;
  pairwisePlan: PairwiseVisualPreferencePlan;
  pairwiseLedger: PairwisePreferenceLedger;
  pairwiseLedgerSeal: PairwisePreferenceLedgerSeal;
  pairwiseReport: UnblindedPairwiseReport;
};

const aggregateArtifactNameSchema = z.enum([
  "review-ledger.json",
  "classification-book.json",
  "pairwise-exact-render-catalog.json",
  "pairwise-exact-render-verification.json",
  "pairwise-plan.json",
  "pairwise-ledger.json",
  "pairwise-ledger-seal.json",
  "pairwise-report.json",
]);

const reviewAggregateIndexWithoutRootSchema = z.object({
  schemaVersion: z.literal("exp-0001a-review-aggregate-index/v1"),
  protocolId: z.literal("EXP-0001A"),
  denominator: z.literal(48),
  pairwiseDenominator: z.literal(24),
  artifacts: z.array(z.object({
    fileName: aggregateArtifactNameSchema,
    bytesDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    semanticRoot: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict()).length(8),
}).strict();

export const exp0001aReviewAggregateIndexSchema = reviewAggregateIndexWithoutRootSchema.extend({
  aggregateIndexRoot: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type Exp0001aReviewAggregateIndex = z.infer<typeof exp0001aReviewAggregateIndexSchema>;

const aggregateDescriptors: readonly {
  key: keyof Exp0001aReviewAggregateSet;
  fileName: z.infer<typeof aggregateArtifactNameSchema>;
  semanticRoot: (value: Exp0001aReviewAggregateSet[keyof Exp0001aReviewAggregateSet]) => string;
}[] = [
  { key: "reviewLedger", fileName: "review-ledger.json", semanticRoot: (value) => (value as ReviewLedger).ledgerRoot },
  { key: "classificationBook", fileName: "classification-book.json", semanticRoot: (value) => (value as ClassificationBook).classificationRoot },
  { key: "pairwiseExactRenderCatalog", fileName: "pairwise-exact-render-catalog.json", semanticRoot: (value) => (value as PairwiseExactRenderCatalog).catalogRoot },
  { key: "pairwiseExactRenderVerificationReceipt", fileName: "pairwise-exact-render-verification.json", semanticRoot: (value) => (value as PairwiseExactRenderVerificationReceipt).receiptRoot },
  { key: "pairwisePlan", fileName: "pairwise-plan.json", semanticRoot: (value) => (value as PairwiseVisualPreferencePlan).planRoot },
  { key: "pairwiseLedger", fileName: "pairwise-ledger.json", semanticRoot: (value) => (value as PairwisePreferenceLedger).ledgerRoot },
  { key: "pairwiseLedgerSeal", fileName: "pairwise-ledger-seal.json", semanticRoot: (value) => (value as PairwisePreferenceLedgerSeal).sealRoot },
  { key: "pairwiseReport", fileName: "pairwise-report.json", semanticRoot: (value) => (value as UnblindedPairwiseReport).reportRoot },
];

export function createExp0001aReviewAggregateIndex(aggregates: Exp0001aReviewAggregateSet): Exp0001aReviewAggregateIndex {
  const content = reviewAggregateIndexWithoutRootSchema.parse({
    schemaVersion: "exp-0001a-review-aggregate-index/v1",
    protocolId: "EXP-0001A",
    denominator: 48,
    pairwiseDenominator: 24,
    artifacts: aggregateDescriptors.map(({ key, fileName, semanticRoot }) => ({
      fileName,
      bytesDigest: hashCanonicalJson(aggregates[key]),
      semanticRoot: semanticRoot(aggregates[key]),
    })),
  });
  return exp0001aReviewAggregateIndexSchema.parse({
    ...content,
    aggregateIndexRoot: hashCanonicalJson(content),
  });
}

export type Exp0001aLiveReviewRunnerOptions = {
  mode?: "dry-run" | "execute";
  sources(input: Parameters<ReviewPhaseRunner>[0]): Promise<readonly EvaluatorArtifactSource[]> | readonly EvaluatorArtifactSource[];
  reviewerRoster: readonly ReviewerRosterEntry[];
  reviewPolicy: BlindedReviewPolicy;
  pairwise: Exp0001aPairwiseReviewRuntime;
  retainAggregates(input: {
    aggregates: Exp0001aReviewAggregateSet;
    expectedIndex: Exp0001aReviewAggregateIndex;
  }): Promise<Exp0001aReviewAggregateIndex>;
  evaluator: Exp0001aEvaluatorReviewRuntime;
  now?: () => string;
};

function evaluatorRecordRoot(record: LockedEvaluatorRecord): string {
  return `sha256:${record.recordSha256}`;
}

function evaluatorSpend(record: LockedEvaluatorRecord): ReviewWorkItemSpend {
  if (record.provider.usage !== null && record.provider.estimatedCostUsd !== null) {
    return {
      observability: "observed",
      actualCostUsd: record.provider.estimatedCostUsd,
      usageDigest: hashCanonicalJson(record.provider.usage),
      providerReceiptDigest: evaluatorRecordRoot(record),
    };
  }
  return record.provider.providerReleaseStatus === "not_released"
    ? { observability: "attested_no_provider_call" }
    : { observability: "unobservable" };
}

function pairwiseSpend(record: PairwisePreferenceRecord): ReviewWorkItemSpend {
  if (record.provider.usage !== null) {
    return {
      observability: "observed",
      actualCostUsd: record.provider.estimatedCostUsd,
      usageDigest: hashCanonicalJson(record.provider.usage),
      providerReceiptDigest: record.recordRoot,
    };
  }
  return record.failure?.code === "RENDER_STAGING_FAILED"
    || record.failure?.code === "PAIRWISE_INPUT_BUDGET_EXCEEDED"
    ? { observability: "attested_no_provider_call" }
    : { observability: "unobservable" };
}

function resolvedFor(state: ReviewPhaseResumeState, stage: ReviewStage, workItemId: string) {
  return state.resolvedWorkItems.find((item) => item.stage === stage && item.workItemId === workItemId) ?? null;
}

function ambiguousFor(failures: readonly ReviewAmbiguousFailureRecord[], stage: ReviewStage, workItemId: string) {
  return failures.find((failure) => failure.stage === stage && failure.workItemId === workItemId) ?? null;
}

function syntheticEvaluatorFailure(item: ReviewerWorkItem, ambiguity: ReviewAmbiguousFailureRecord): LockedEvaluatorRecord {
  const content: Omit<LockedEvaluatorRecord, "recordSha256"> = {
    schemaVersion: "blinded-evaluator-run/v1",
    artifactId: item.artifactId,
    taskId: item.evaluatorConfig.taskId,
    reviewer: { id: item.reviewerId, role: item.reviewerRole, invocationCount: 1 },
    lockedAt: ambiguity.recordedAt,
    treatmentLabelKnownAtLock: false,
    pairedArtifactSeenBeforeLock: false,
    committedSourceSetRoot: item.evaluatorConfig.committedSourceSetRoot,
    configSha256: item.evaluatorConfigSha256,
    budgets: {
      inputTokens: item.evaluatorConfig.inputTokenBudget,
      outputTokens: item.evaluatorConfig.outputTokenBudget,
    },
    pricing: item.evaluatorConfig.pricing,
    measurement: {
      role: item.evaluatorConfig.measurement.role,
      packet: null,
      assessmentOutputSha256: null,
    },
    status: "failed",
    evidence: null,
    hashes: {
      promptSha256: null,
      inputSha256: null,
      providerRequestSha256: null,
      providerOutputSha256: null,
      outputSha256: null,
    },
    provider: {
      modelRequested: item.evaluatorConfig.model,
      modelObserved: null,
      serviceTierRequested: item.evaluatorConfig.serviceTier,
      serviceTierObserved: null,
      identityStatus: "unobservable",
      providerReleaseStatus: "released_without_receipt",
      responseIdSha256: null,
      usage: null,
      usageDetailsStatus: "unobservable",
      estimatedCostUsd: null,
      inputPreflight: null,
    },
    accepted: false,
    primaryFailureClass: "FAIL_EVALUATOR_SCORER",
    result: null,
    failure: {
      stage: ambiguity.failure.stage,
      code: ambiguity.failure.code,
      message: ambiguity.failure.message,
    },
    ...(item.reviewerRole === "adjudicator" ? {
      adjudication: {
        schemaVersion: "blinded-adjudication-input/v1" as const,
        primaryRecordSha256s: item.evaluatorConfig.adjudication!.primaryRecordSha256s,
      },
    } : {}),
  };
  return lockedEvaluatorRecordSchema.parse({ ...content, recordSha256: computeEvaluatorRecordSha256(content) });
}

function syntheticPairwiseFailure(
  plan: PairwiseVisualPreferencePlan,
  context: PairwisePlanContext,
  workItemId: string,
  ambiguity: ReviewAmbiguousFailureRecord,
): PairwisePreferenceRecord {
  const assignment = plan.assignments.find((candidate) => candidate.workItem.workItemId === workItemId);
  if (!assignment) throw new Error(`Unknown ambiguous pairwise work item ${workItemId}.`);
  const content: Omit<PairwisePreferenceRecord, "recordRoot"> = {
    schemaVersion: "pairwise-visual-preference-run/v1",
    workItemId,
    reviewContextId: assignment.workItem.reviewContextId,
    lockedAt: ambiguity.recordedAt,
    invocationCount: 1,
    treatmentMappingKnownAtLock: false,
    individualDecisionsVisibleAtLock: false,
    status: "failed",
    result: null,
    failure: {
      stage: ambiguity.failure.stage,
      code: ambiguity.failure.code,
      message: ambiguity.failure.message,
    },
    providerRequest: null,
    providerOutputJson: null,
    hashes: {
      workItemSha256: computePairwiseWorkItemSha256(assignment.workItem),
      scorerPolicyDigest: computePairwiseScorerPolicyDigest(plan.scorerPolicy),
      inputSha256: computePairwiseInputSha256(assignment.workItem, plan.scorerPolicy.promptSha256),
      providerRequestSha256: null,
      providerOutputSha256: null,
      resultSha256: null,
    },
    provider: {
      modelRequested: plan.scorerPolicy.model,
      responseId: null,
      responseIdSha256: null,
      usage: null,
      estimatedCostUsd: 0,
    },
  };
  const record = pairwisePreferenceRecordSchema.parse({ ...content, recordRoot: computePairwisePreferenceRecordRoot(content) });
  // The normal ledger verifier below revalidates this record against all frozen context.
  void context;
  return record;
}

async function collectEvaluatorRecords(input: {
  stage: "primary" | "adjudication";
  items: readonly ReviewerWorkItem[];
  state: ReviewPhaseResumeState;
  ambiguities: readonly ReviewAmbiguousFailureRecord[];
  controls: Parameters<ReviewPhaseRunner>[1];
  evaluator: Exp0001aEvaluatorReviewRuntime;
  spendAuthorizationReceiptDigest: string;
  now: () => string;
}): Promise<{ records: LockedEvaluatorRecord[]; state: ReviewPhaseResumeState }> {
  let state = input.state;
  const records: LockedEvaluatorRecord[] = [];
  for (const item of input.items) {
    const resolution = resolvedFor(state, input.stage, item.workItemId);
    const ambiguity = ambiguousFor(input.ambiguities, input.stage, item.workItemId);
    let record: LockedEvaluatorRecord;
    if (ambiguity) {
      if (!resolution?.ambiguousAfterBegin) throw new Error("Ambiguity evidence and progress resolution disagree.");
      record = syntheticEvaluatorFailure(item, ambiguity);
    } else if (resolution) {
      const retained = await input.evaluator.load({
        workItem: item,
        spendAuthorizationReceiptDigest: input.spendAuthorizationReceiptDigest,
      });
      if (!retained || evaluatorRecordRoot(retained) !== resolution.recordRoot) {
        throw new Error(`Locked ${input.stage} record is missing or differs from append-only progress for ${item.workItemId}.`);
      }
      record = retained;
    } else {
      const maximumInputRate = Math.max(
        item.evaluatorConfig.pricing.inputUsdPerMillionTokens,
        item.evaluatorConfig.pricing.cachedInputUsdPerMillionTokens,
        item.evaluatorConfig.pricing.cacheWriteInputUsdPerMillionTokens,
      );
      const maximumCostUsd = (item.evaluatorConfig.inputTokenBudget * maximumInputRate
        + item.evaluatorConfig.outputTokenBudget * item.evaluatorConfig.pricing.outputUsdPerMillionTokens) / 1_000_000;
      await input.controls.onReviewWorkItemBegun({
        at: input.now(),
        stage: input.stage,
        workItemId: item.workItemId,
        maximumCostUsd,
        budgetDigest: hashCanonicalJson({
          inputTokens: item.evaluatorConfig.inputTokenBudget,
          outputTokens: item.evaluatorConfig.outputTokenBudget,
        }),
        pricingDigest: hashCanonicalJson(item.evaluatorConfig.pricing),
      });
      const retained = await input.evaluator.run({
        workItem: item,
        spendAuthorizationReceiptDigest: input.spendAuthorizationReceiptDigest,
      });
      record = lockedEvaluatorRecordSchema.parse(retained.record);
      state = await input.controls.onReviewWorkItemLocked({
        at: record.lockedAt,
        stage: input.stage,
        workItemId: item.workItemId,
        recordRoot: evaluatorRecordRoot(record),
        status: record.status,
        spend: evaluatorSpend(record),
      });
    }
    records.push(record);
  }
  return { records, state };
}

function assertStageManifest(state: ReviewPhaseResumeState, stage: ReviewStage, expected: readonly string[]): void {
  if (!state.plannedStages.includes(stage) || canonicalJson(state.expectedWorkItemIds[stage]) !== canonicalJson(expected)) {
    throw new Error(`Retained ${stage} work manifest differs from deterministic orchestration.`);
  }
}

function assertEvaluatorRecordForItem(item: ReviewerWorkItem, recordInput: LockedEvaluatorRecord): LockedEvaluatorRecord {
  const record = lockedEvaluatorRecordSchema.parse(recordInput);
  if (record.artifactId !== item.artifactId || record.taskId !== item.evaluatorConfig.taskId
      || record.reviewer.id !== item.reviewerId || record.reviewer.role !== item.reviewerRole
      || record.configSha256 !== item.evaluatorConfigSha256) {
    throw new Error(`Retained evaluator record identity differs from ${item.workItemId}.`);
  }
  return record;
}

async function loadResolvedEvaluatorStage(input: {
  items: readonly ReviewerWorkItem[];
  stage: "primary" | "adjudication";
  state: ReviewPhaseResumeState;
  ambiguities: readonly ReviewAmbiguousFailureRecord[];
  evaluator: Exp0001aEvaluatorReviewRuntime;
  spendAuthorizationReceiptDigest: string;
}): Promise<LockedEvaluatorRecord[]> {
  const records: LockedEvaluatorRecord[] = [];
  for (const item of input.items) {
    const resolution = resolvedFor(input.state, input.stage, item.workItemId);
    if (!resolution) throw new Error(`Cannot recover later review work before ${input.stage}:${item.workItemId} is durably resolved.`);
    if (resolution.ambiguousAfterBegin) {
      const ambiguity = ambiguousFor(input.ambiguities, input.stage, item.workItemId);
      if (!ambiguity) throw new Error(`Ambiguous ${input.stage} progress lacks its retained failure record.`);
      records.push(syntheticEvaluatorFailure(item, ambiguity));
      continue;
    }
    const retained = await input.evaluator.load({
      workItem: item,
      spendAuthorizationReceiptDigest: input.spendAuthorizationReceiptDigest,
    });
    if (!retained) throw new Error(`Resolved ${input.stage} record is missing for ${item.workItemId}.`);
    const record = assertEvaluatorRecordForItem(item, retained);
    if (evaluatorRecordRoot(record) !== resolution.recordRoot) {
      throw new Error(`Resolved ${input.stage} record root drifted for ${item.workItemId}.`);
    }
    records.push(record);
  }
  return records;
}

async function recoverActiveWorkItem(
  options: Exp0001aLiveReviewRunnerOptions,
  input: ReviewPhaseRunnerInput & { active: Parameters<NonNullable<ReviewPhaseRunner["recoverActiveWorkItem"]>>[0]["active"] },
) {
  if (!input.resume.phaseBegun || input.resume.reviewPlanRoot === null) {
    throw new Error("An active reviewer item cannot precede the retained blinded-review plan.");
  }
  const sources = await options.sources(input);
  const plan = createBlindedReviewPlan({
    registry: input.sealedAttemptRegistry,
    sources,
    reviewerRoster: options.reviewerRoster,
    policy: options.reviewPolicy,
  });
  if (plan.planRoot !== input.resume.reviewPlanRoot) throw new Error("Recovery plan differs from the retained blinded-review plan.");
  const primaryItems = plan.artifacts.flatMap((artifact) => artifact.primaryWorkItems);
  if (input.active.stage === "primary") {
    const item = primaryItems.find((candidate) => candidate.workItemId === input.active.workItemId);
    if (!item) throw new Error("Active primary work is outside the fixed review manifest.");
    const recovered = await options.evaluator.recover({
      workItem: item,
      spendAuthorizationReceiptDigest: input.spendAuthorizationReceiptDigest,
    });
    const record = assertEvaluatorRecordForItem(item, recovered.record);
    return { lockedAt: record.lockedAt, recordRoot: evaluatorRecordRoot(record), status: record.status, spend: evaluatorSpend(record) } as const;
  }

  const primaryRecords = await loadResolvedEvaluatorStage({
    items: primaryItems,
    stage: "primary",
    state: input.resume,
    ambiguities: input.retainedAmbiguousFailures,
    evaluator: options.evaluator,
    spendAuthorizationReceiptDigest: input.spendAuthorizationReceiptDigest,
  });
  const primaryLedger = lockPrimaryReviews(plan, primaryRecords);
  const prepared = prepareAdjudicationWork(plan, primaryLedger);
  if (input.active.stage === "adjudication") {
    const item = prepared.workItems.find((candidate) => candidate.workItemId === input.active.workItemId);
    if (!item) throw new Error("Active adjudication work is outside the deterministic disagreement manifest.");
    const recovered = await options.evaluator.recover({
      workItem: item,
      spendAuthorizationReceiptDigest: input.spendAuthorizationReceiptDigest,
    });
    const record = assertEvaluatorRecordForItem(item, recovered.record);
    return { lockedAt: record.lockedAt, recordRoot: evaluatorRecordRoot(record), status: record.status, spend: evaluatorSpend(record) } as const;
  }

  const adjudicationRecords = await loadResolvedEvaluatorStage({
    items: prepared.workItems,
    stage: "adjudication",
    state: input.resume,
    ambiguities: input.retainedAmbiguousFailures,
    evaluator: options.evaluator,
    spendAuthorizationReceiptDigest: input.spendAuthorizationReceiptDigest,
  });
  const reviewLedger = lockAdjudicationReviews(plan, prepared.ledger, adjudicationRecords);
  const classificationBook = finalizeArtifactClassifications(plan, reviewLedger);
  const pairwiseContext = await options.pairwise.context({ reviewPlan: plan, reviewLedger, classificationBook });
  const pairwisePlan = createPairwiseVisualPreferencePlan(pairwiseContext);
  const assignment = pairwisePlan.assignments.find((candidate) => candidate.workItem.workItemId === input.active.workItemId);
  if (!assignment) throw new Error("Active pairwise work is outside the fixed pairwise manifest.");
  const retained = await options.pairwise.recover({
    plan: pairwisePlan,
    context: pairwiseContext,
    workItemId: input.active.workItemId,
  });
  if (!retained) return null;
  const record = pairwisePreferenceRecordSchema.parse(retained);
  if (record.workItemId !== input.active.workItemId) throw new Error("Recovered pairwise record identity drifted.");
  return { lockedAt: record.lockedAt, recordRoot: record.recordRoot, status: record.status, spend: pairwiseSpend(record) } as const;
}

/**
 * Composes the live blinded evaluator, deterministic adjudication, fixed
 * pairwise plan, and append-only command controls. It is fail-safe dry-run by
 * default; only `mode: "execute"` may call either injected model seam.
 */
export function createExp0001aLiveReviewRunner(options: Exp0001aLiveReviewRunnerOptions): ReviewPhaseRunner {
  const mode = options.mode ?? "dry-run";
  const now = options.now ?? (() => new Date().toISOString());
  const runner: ReviewPhaseRunner = async (input, controls) => {
    if (mode !== "execute") throw new Error("EXP-0001A live review runner is dry-run; explicit execute mode is required before any scorer call.");
    const sources = await options.sources(input);
    const plan = createBlindedReviewPlan({
      registry: input.sealedAttemptRegistry,
      sources,
      reviewerRoster: options.reviewerRoster,
      policy: options.reviewPolicy,
    });
    let state = input.resume;
    if (!state.phaseBegun) state = await controls.onReviewPhaseBegun({ at: now(), reviewPlan: plan });
    else if (state.reviewPlanRoot !== plan.planRoot) throw new Error("Resumed blinded review plan differs from its retained root.");

    const primaryItems = plan.artifacts.flatMap((artifact) => artifact.primaryWorkItems);
    assertStageManifest(state, "primary", primaryItems.map((item) => item.workItemId));
    const primaries = await collectEvaluatorRecords({
      stage: "primary",
      items: primaryItems,
      state,
      ambiguities: input.retainedAmbiguousFailures,
      controls,
      evaluator: options.evaluator,
      spendAuthorizationReceiptDigest: input.spendAuthorizationReceiptDigest,
      now,
    });
    state = primaries.state;
    const primaryLedger = lockPrimaryReviews(plan, primaries.records);
    const prepared = prepareAdjudicationWork(plan, primaryLedger);
    const adjudicationIds = prepared.workItems.map((item) => item.workItemId);
    if (!state.plannedStages.includes("adjudication")) {
      state = await controls.onReviewStagePlanned({
        at: now(),
        stage: "adjudication",
        planRoot: prepared.ledger.ledgerRoot,
        workItemIds: adjudicationIds,
      });
    } else assertStageManifest(state, "adjudication", adjudicationIds);
    const adjudications = await collectEvaluatorRecords({
      stage: "adjudication",
      items: prepared.workItems,
      state,
      ambiguities: input.retainedAmbiguousFailures,
      controls,
      evaluator: options.evaluator,
      spendAuthorizationReceiptDigest: input.spendAuthorizationReceiptDigest,
      now,
    });
    state = adjudications.state;
    const reviewLedger = lockAdjudicationReviews(plan, prepared.ledger, adjudications.records);
    const classificationBook = finalizeArtifactClassifications(plan, reviewLedger);
    if (state.classification === null) {
      state = await controls.onClassificationsLocked({
        at: now(),
        count: 48,
        reviewLedgerRoot: reviewLedger.ledgerRoot,
        classificationRoot: classificationBook.classificationRoot,
      });
    } else if (state.classification.reviewLedgerRoot !== reviewLedger.ledgerRoot
        || state.classification.classificationRoot !== classificationBook.classificationRoot) {
      throw new Error("Resumed classification commitments differ from deterministic review output.");
    }

    const pairwiseContext = await options.pairwise.context({ reviewPlan: plan, reviewLedger, classificationBook });
    const pairwisePlan = createPairwiseVisualPreferencePlan(pairwiseContext);
    const pairwiseIds = pairwisePlan.assignments.map((assignment) => assignment.workItem.workItemId);
    if (!state.plannedStages.includes("pairwise")) {
      state = await controls.onReviewStagePlanned({ at: now(), stage: "pairwise", planRoot: pairwisePlan.planRoot, workItemIds: pairwiseIds });
    } else assertStageManifest(state, "pairwise", pairwiseIds);

    const pairwiseRecords: PairwisePreferenceRecord[] = [];
    for (const workItemId of pairwiseIds) {
      const resolution = resolvedFor(state, "pairwise", workItemId);
      const ambiguity = ambiguousFor(input.retainedAmbiguousFailures, "pairwise", workItemId);
      let record: PairwisePreferenceRecord;
      if (ambiguity) {
        if (!resolution?.ambiguousAfterBegin) throw new Error("Pairwise ambiguity evidence and progress resolution disagree.");
        record = syntheticPairwiseFailure(pairwisePlan, pairwiseContext, workItemId, ambiguity);
      } else if (resolution) {
        const retained = await options.pairwise.load({ plan: pairwisePlan, context: pairwiseContext, workItemId });
        if (!retained || retained.recordRoot !== resolution.recordRoot) {
          throw new Error(`Locked pairwise record is missing or differs from append-only progress for ${workItemId}.`);
        }
        record = pairwisePreferenceRecordSchema.parse(retained);
      } else {
        await controls.onReviewWorkItemBegun({
          at: now(),
          stage: "pairwise",
          workItemId,
          maximumCostUsd: maximumPairwisePreferenceCallCost(pairwisePlan.scorerPolicy),
          budgetDigest: hashCanonicalJson(pairwisePlan.scorerPolicy.tokenBudget),
          pricingDigest: hashCanonicalJson(pairwisePlan.scorerPolicy.pricing),
        });
        record = pairwisePreferenceRecordSchema.parse(await options.pairwise.run({ plan: pairwisePlan, context: pairwiseContext, workItemId }));
        state = await controls.onReviewWorkItemLocked({
          at: record.lockedAt,
          stage: "pairwise",
          workItemId,
          recordRoot: record.recordRoot,
          status: record.status,
          spend: pairwiseSpend(record),
        });
      }
      pairwiseRecords.push(record);
    }
    const pairwise = lockPairwisePreferenceRecords(pairwisePlan, pairwiseContext, pairwiseRecords, await options.pairwise.sealedAt());
    const pairwiseReport = unblindPairwiseVisualPreferences({
      plan: pairwisePlan,
      ledger: pairwise.ledger,
      seal: pairwise.seal,
      context: pairwiseContext,
    });
    const aggregates: Exp0001aReviewAggregateSet = {
      reviewLedger,
      classificationBook,
      pairwiseExactRenderCatalog: pairwiseContext.exactRenderCatalog,
      pairwiseExactRenderVerificationReceipt: pairwiseContext.exactRenderVerificationReceipt,
      pairwisePlan,
      pairwiseLedger: pairwise.ledger,
      pairwiseLedgerSeal: pairwise.seal,
      pairwiseReport,
    };
    const expectedAggregateIndex = createExp0001aReviewAggregateIndex(aggregates);
    const retainedAggregateIndex = exp0001aReviewAggregateIndexSchema.parse(await options.retainAggregates({
      aggregates,
      expectedIndex: expectedAggregateIndex,
    }));
    if (canonicalJson(retainedAggregateIndex) !== canonicalJson(expectedAggregateIndex)) {
      throw new Error("Retained review aggregate bytes or roots differ from deterministic review output.");
    }
    const spend = await controls.readSpendSummary();
    const content: Omit<ReviewPhaseReceipt, "receiptDigest"> = {
      schemaVersion: 1,
      kind: "exp-0001a-review-phase-complete",
      protocolId: "EXP-0001A",
      completedAt: now(),
      authorBatchRegistryDigest: input.authorBatchRegistry.registryDigest,
      effectiveAliasVerificationRoot: computeExp0001aEffectiveAliasVerificationRoot(input.authorBatchRegistry, input.plan),
      sealedAttemptRegistryRoot: input.sealedAttemptRegistry.registryRoot,
      registryBridgeReceiptDigest: input.registryBridgeReceipt.receiptDigest,
      denominator: 48,
      primaryReviewRecords: 96,
      primaryReviewRecordRoot: computeReviewStageRecordRoot(state, "primary"),
      adjudicationReviewRecords: adjudicationIds.length,
      adjudicationReviewRecordRoot: computeReviewStageRecordRoot(state, "adjudication"),
      classificationCount: 48,
      reviewPlanRoot: plan.planRoot,
      reviewLedgerRoot: reviewLedger.ledgerRoot,
      classificationRoot: classificationBook.classificationRoot,
      reviewAggregateIndexRoot: retainedAggregateIndex.aggregateIndexRoot,
      pairwiseExactRenderCatalogRoot: pairwiseContext.exactRenderCatalog.catalogRoot,
      pairwiseExactRenderVerificationReceiptRoot: pairwiseContext.exactRenderVerificationReceipt.receiptRoot,
      pairwisePreferenceDenominator: 24,
      pairwisePlanRoot: pairwisePlan.planRoot,
      pairwisePreferenceRecords: 24,
      pairwisePreferenceRecordRoot: computeReviewStageRecordRoot(state, "pairwise"),
      pairwiseLedgerRoot: pairwise.ledger.ledgerRoot,
      pairwiseLedgerSealRoot: pairwise.seal.sealRoot,
      pairwiseReportRoot: pairwiseReport.reportRoot,
      reviewProgressRoot: state.progressRoot,
      spendLedgerRoot: spend.ledgerRoot,
      spendExternalAnchorRoot: spend.externalAnchorRoot,
      spendExternalAnchorCount: spend.externalAnchorCount,
      spendAuthorizationReceiptDigest: input.spendAuthorizationReceiptDigest,
      authorizedMaximumUsd: spend.authorizedMaximumUsd,
      userAuthorizedMaximumUsd: spend.userAuthorizedMaximumUsd,
      frozenProtocolMaximumUsd: spend.frozenProtocolMaximumUsd,
      observedProviderCostUsd: spend.observedSettledUsd,
      unobservableProviderExposureUsd: spend.unobservableReservedExposureUsd,
      totalChargedExposureUsd: spend.totalChargedExposureUsd,
    };
    return reviewPhaseReceiptSchema.parse({ ...content, receiptDigest: hashCanonicalJson(content) });
  };
  runner.recoverActiveWorkItem = async (input) => recoverActiveWorkItem(options, input);
  return runner;
}
