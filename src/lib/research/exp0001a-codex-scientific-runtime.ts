import { z } from "zod";

import type { DevelopmentExecutionManifest } from "./development-manifest";
import type { Exp0001aAttemptProvisioningPlanSet } from "./exp0001a-attempt-provisioning";
import {
  exp0001aCodexAccountingLedgerSchema,
  exp0001aCodexSchedulerStateSchema,
  type Exp0001aCodexAccountingLedger,
  type Exp0001aCodexSchedulerState,
} from "./exp0001a-codex-accounting";
import type { Exp0001aCodexPrebriefFreeze } from "./exp0001a-codex-prebrief-freeze";
import {
  createExp0001aCodexAdjudicationWorkOrder,
  createExp0001aCodexAnalysisReceipt,
  createExp0001aCodexPairwiseWorkOrder,
  createExp0001aCodexPrimaryReviewWorkOrder,
  exp0001aCodexAdjudicationResultLedgerSchema,
  exp0001aCodexAdjudicationWorkOrderSchema,
  exp0001aCodexAnalysisReceiptSchema,
  exp0001aCodexAuthorArtifactCatalogSchema,
  exp0001aCodexClassificationBookSchema,
  exp0001aCodexPairwiseResultLedgerSchema,
  exp0001aCodexPairwiseWorkOrderSchema,
  exp0001aCodexPrimaryReviewResultLedgerSchema,
  exp0001aCodexPrimaryReviewWorkOrderSchema,
  exp0001aCodexReviewPlanManifestSchema,
  lockExp0001aCodexClassifications,
  recordExp0001aCodexAdjudicationResults,
  recordExp0001aCodexPairwiseResults,
  recordExp0001aCodexPrimaryReviewResults,
  sealExp0001aCodexAuthorArtifactCatalog,
  verifyExp0001aCodexReviewPlanManifest,
  type Exp0001aCodexReviewPlanManifest,
} from "./exp0001a-codex-review-runtime";
import {
  exp0001aCodexTaskLifecycleSchema,
  exp0001aCodexTaskTransportPlanSchema,
  type Exp0001aCodexTaskLifecycle,
  type Exp0001aCodexTaskTransportPlan,
} from "./exp0001a-codex-task-transport";
import { hashCanonicalJson, SHA256_DIGEST_PATTERN, type JsonValue } from "./provenance-crypto";

export const EXP0001A_CODEX_SCIENTIFIC_RUNTIME_VERSION =
  "exp-0001a-codex-scientific-runtime/v1" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const scientificContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_SCIENTIFIC_RUNTIME_VERSION),
  protocolId: z.literal("EXP-0001A"),
  reviewPlanManifest: exp0001aCodexReviewPlanManifestSchema,
  authorCatalog: exp0001aCodexAuthorArtifactCatalogSchema.nullable(),
  primaryWorkOrder: exp0001aCodexPrimaryReviewWorkOrderSchema.nullable(),
  primaryResults: exp0001aCodexPrimaryReviewResultLedgerSchema.nullable(),
  adjudicationWorkOrder: exp0001aCodexAdjudicationWorkOrderSchema.nullable(),
  adjudicationResults: exp0001aCodexAdjudicationResultLedgerSchema.nullable(),
  classifications: exp0001aCodexClassificationBookSchema.nullable(),
  pairwiseWorkOrder: exp0001aCodexPairwiseWorkOrderSchema.nullable(),
  pairwiseResults: exp0001aCodexPairwiseResultLedgerSchema.nullable(),
  analysisReceipt: exp0001aCodexAnalysisReceiptSchema.nullable(),
  transitionDigests: z.array(digestSchema).max(9),
}).strict();

export const exp0001aCodexScientificStateSchema = scientificContentSchema.extend({
  stateDigest: digestSchema,
}).strict().superRefine((state, context) => {
  const { stateDigest: _stateDigest, ...content } = state;
  void _stateDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== state.stateDigest) {
    context.addIssue({ code: "custom", path: ["stateDigest"], message: "Scientific state digest is invalid." });
  }
  const ordered = [state.authorCatalog, state.primaryWorkOrder, state.primaryResults,
    state.adjudicationWorkOrder, state.adjudicationResults, state.classifications,
    state.pairwiseWorkOrder, state.pairwiseResults, state.analysisReceipt];
  const retainedCount = ordered.filter((value) => value !== null).length;
  if (ordered.some((value, index) => value !== null && ordered.slice(0, index).some((prior) => prior === null))
      || state.transitionDigests.length !== retainedCount) {
    context.addIssue({ code: "custom", path: ["transitionDigests"],
      message: "Scientific artifacts must form one complete ordered prefix." });
  }
});
export type Exp0001aCodexScientificState = z.infer<typeof exp0001aCodexScientificStateSchema>;

function sealScientificState(contentInput: z.input<typeof scientificContentSchema>): Exp0001aCodexScientificState {
  const content = scientificContentSchema.parse(contentInput);
  return Object.freeze(exp0001aCodexScientificStateSchema.parse({
    ...content,
    stateDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

export function createExp0001aCodexScientificState(input: Readonly<{
  executionManifest: DevelopmentExecutionManifest;
  reviewPlanManifest: Exp0001aCodexReviewPlanManifest;
}>): Exp0001aCodexScientificState {
  const reviewPlan = verifyExp0001aCodexReviewPlanManifest({
    manifest: input.reviewPlanManifest,
    executionManifest: input.executionManifest,
  });
  return sealScientificState({
    schemaVersion: EXP0001A_CODEX_SCIENTIFIC_RUNTIME_VERSION,
    protocolId: "EXP-0001A",
    reviewPlanManifest: reviewPlan,
    authorCatalog: null,
    primaryWorkOrder: null,
    primaryResults: null,
    adjudicationWorkOrder: null,
    adjudicationResults: null,
    classifications: null,
    pairwiseWorkOrder: null,
    pairwiseResults: null,
    analysisReceipt: null,
    transitionDigests: [],
  });
}

export type Exp0001aScientificTransition =
  | "seal_author_artifact_catalog"
  | "prepare_primary_review_work_order"
  | "record_primary_review_results"
  | "derive_disagreement_adjudication_work_order"
  | "record_adjudication_results"
  | "lock_blinded_classifications"
  | "prepare_pairwise_visual_work_order"
  | "record_pairwise_visual_results"
  | "run_cluster_aware_analysis";

/** Pure, provider-free scientific transition executor. Every output is
 * reconstructed from the exact frozen inputs and retained task lifecycles;
 * callers cannot submit roots or reviewer decisions as transition data. */
export function performExp0001aCodexScientificTransition(input: Readonly<{
  transition: Exp0001aScientificTransition;
  transitionedAt: string;
  freeze: Exp0001aCodexPrebriefFreeze;
  provisioningPlan: Exp0001aAttemptProvisioningPlanSet;
  scheduler: Exp0001aCodexSchedulerState;
  accountingLedger: Exp0001aCodexAccountingLedger;
  plans: readonly Exp0001aCodexTaskTransportPlan[];
  lifecycles: readonly Exp0001aCodexTaskLifecycle[];
  priorState: Exp0001aCodexScientificState;
}>): Exp0001aCodexScientificState {
  const prior = exp0001aCodexScientificStateSchema.parse(input.priorState);
  const scheduler = exp0001aCodexSchedulerStateSchema.parse(input.scheduler);
  const accounting = exp0001aCodexAccountingLedgerSchema.parse(input.accountingLedger);
  const plans = input.plans.map((plan) => exp0001aCodexTaskTransportPlanSchema.parse(plan));
  const lifecycles = input.lifecycles.map((lifecycle) => exp0001aCodexTaskLifecycleSchema.parse(lifecycle));
  const base = { ...prior };
  delete (base as Partial<Exp0001aCodexScientificState>).stateDigest;
  let artifact: unknown;
  switch (input.transition) {
    case "seal_author_artifact_catalog":
      if (prior.authorCatalog !== null) throw new Error("EXP0001A_SCIENTIFIC_TRANSITION_ALREADY_RETAINED");
      artifact = sealExp0001aCodexAuthorArtifactCatalog({
        freeze: input.freeze, provisioningPlan: input.provisioningPlan, scheduler, plans, lifecycles,
      });
      base.authorCatalog = artifact as never;
      break;
    case "prepare_primary_review_work_order":
      if (!prior.authorCatalog || prior.primaryWorkOrder !== null) throw new Error("EXP0001A_SCIENTIFIC_TRANSITION_ORDER_INVALID");
      artifact = createExp0001aCodexPrimaryReviewWorkOrder({
        freeze: input.freeze, catalog: prior.authorCatalog, reviewPlanManifest: prior.reviewPlanManifest,
      });
      base.primaryWorkOrder = artifact as never;
      break;
    case "record_primary_review_results":
      if (!prior.primaryWorkOrder || prior.primaryResults !== null) throw new Error("EXP0001A_SCIENTIFIC_TRANSITION_ORDER_INVALID");
      artifact = recordExp0001aCodexPrimaryReviewResults({ workOrder: prior.primaryWorkOrder, plans, lifecycles });
      base.primaryResults = artifact as never;
      break;
    case "derive_disagreement_adjudication_work_order":
      if (!prior.authorCatalog || !prior.primaryWorkOrder || !prior.primaryResults || prior.adjudicationWorkOrder !== null) {
        throw new Error("EXP0001A_SCIENTIFIC_TRANSITION_ORDER_INVALID");
      }
      artifact = createExp0001aCodexAdjudicationWorkOrder({
        freeze: input.freeze, catalog: prior.authorCatalog, primaryWorkOrder: prior.primaryWorkOrder,
        primaryResults: prior.primaryResults, reviewPlanManifest: prior.reviewPlanManifest,
        primaryPlans: plans.filter((plan) => plan.role === "primary_reviewer"),
        primaryLifecycles: lifecycles.filter((lifecycle) => lifecycle.role === "primary_reviewer"),
      });
      base.adjudicationWorkOrder = artifact as never;
      break;
    case "record_adjudication_results":
      if (!prior.adjudicationWorkOrder || prior.adjudicationResults !== null) throw new Error("EXP0001A_SCIENTIFIC_TRANSITION_ORDER_INVALID");
      artifact = recordExp0001aCodexAdjudicationResults({ workOrder: prior.adjudicationWorkOrder, plans, lifecycles });
      base.adjudicationResults = artifact as never;
      break;
    case "lock_blinded_classifications":
      if (!prior.authorCatalog || !prior.primaryResults || !prior.adjudicationWorkOrder
          || !prior.adjudicationResults || prior.classifications !== null) {
        throw new Error("EXP0001A_SCIENTIFIC_TRANSITION_ORDER_INVALID");
      }
      artifact = lockExp0001aCodexClassifications({
        lockedAt: input.transitionedAt, catalog: prior.authorCatalog, primaryResults: prior.primaryResults,
        adjudicationWorkOrder: prior.adjudicationWorkOrder, adjudicationResults: prior.adjudicationResults,
      });
      base.classifications = artifact as never;
      break;
    case "prepare_pairwise_visual_work_order":
      if (!prior.authorCatalog || !prior.classifications || prior.pairwiseWorkOrder !== null) {
        throw new Error("EXP0001A_SCIENTIFIC_TRANSITION_ORDER_INVALID");
      }
      artifact = createExp0001aCodexPairwiseWorkOrder({
        freeze: input.freeze, reviewPlanManifest: prior.reviewPlanManifest, catalog: prior.authorCatalog,
        classifications: prior.classifications,
        authorPlans: plans.filter((plan) => plan.role === "author"),
        authorLifecycles: lifecycles.filter((lifecycle) => lifecycle.role === "author"),
      });
      base.pairwiseWorkOrder = artifact as never;
      break;
    case "record_pairwise_visual_results":
      if (!prior.pairwiseWorkOrder || prior.pairwiseResults !== null) throw new Error("EXP0001A_SCIENTIFIC_TRANSITION_ORDER_INVALID");
      artifact = recordExp0001aCodexPairwiseResults({ workOrder: prior.pairwiseWorkOrder, plans, lifecycles });
      base.pairwiseResults = artifact as never;
      break;
    case "run_cluster_aware_analysis":
      if (!prior.authorCatalog || !prior.classifications || !prior.pairwiseWorkOrder
          || !prior.pairwiseResults || prior.analysisReceipt !== null) {
        throw new Error("EXP0001A_SCIENTIFIC_TRANSITION_ORDER_INVALID");
      }
      artifact = createExp0001aCodexAnalysisReceipt({
        createdAt: input.transitionedAt, catalog: prior.authorCatalog, classifications: prior.classifications,
        pairwiseWorkOrder: prior.pairwiseWorkOrder, pairwiseResults: prior.pairwiseResults,
        accountingLedger: accounting,
      });
      base.analysisReceipt = artifact as never;
      break;
  }
  return sealScientificState({
    ...base,
    transitionDigests: [...prior.transitionDigests, hashCanonicalJson(artifact as JsonValue)],
  });
}

export type Exp0001aNextScientificReviewWorkItem = Readonly<{
  role: "primary_reviewer" | "adjudicator" | "pairwise_visual_judge";
  workItem: JsonValue;
}> | null;

/** Returns the exact next genuinely unstarted frozen review item. Precreation
 * attempts remain retained, but only `taskBegun:true` consumes a denominator. */
export function nextExp0001aScientificReviewWorkItem(input: Readonly<{
  state: Exp0001aCodexScientificState;
  plans: readonly Exp0001aCodexTaskTransportPlan[];
  lifecycles: readonly Exp0001aCodexTaskLifecycle[];
}>): Exp0001aNextScientificReviewWorkItem {
  const state = exp0001aCodexScientificStateSchema.parse(input.state);
  const plans = input.plans.map((plan) => exp0001aCodexTaskTransportPlanSchema.parse(plan));
  const lifecycles = input.lifecycles.map((lifecycle) => exp0001aCodexTaskLifecycleSchema.parse(lifecycle));
  const lifecycleByPlan = new Map(lifecycles.map((lifecycle) => [lifecycle.planDigest, lifecycle]));
  const begunAssignments = new Set(plans.flatMap((plan) =>
    lifecycleByPlan.get(plan.planDigest)?.taskBegun === true ? [plan.privateBinding.assignmentId] : []));
  const active = plans.filter((plan) => !lifecycleByPlan.has(plan.planDigest));
  if (active.length > 1) throw new Error("EXP0001A_SCIENTIFIC_MULTIPLE_UNINGESTED_PLANS");
  if (active.length === 1) return null;
  const phase = state.primaryWorkOrder && !state.primaryResults
    ? { role: "primary_reviewer" as const, workItems: state.primaryWorkOrder.workItems }
    : state.adjudicationWorkOrder && !state.adjudicationResults
      ? { role: "adjudicator" as const, workItems: state.adjudicationWorkOrder.workItems }
      : state.pairwiseWorkOrder && !state.pairwiseResults
        ? { role: "pairwise_visual_judge" as const, workItems: state.pairwiseWorkOrder.workItems }
        : null;
  if (phase === null) return null;
  const next = phase.workItems.find((item) => !begunAssignments.has(item.assignmentId));
  return next === undefined ? null : Object.freeze({ role: phase.role, workItem: next as unknown as JsonValue });
}
