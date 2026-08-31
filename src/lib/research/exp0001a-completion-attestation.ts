import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  exp0001aCodexAccountingLedgerSchema,
  exp0001aCodexSchedulerStateSchema,
  summarizeExp0001aCodexAccounting,
  verifyExp0001aCodexAccountingLedgerAsOf,
  verifyExp0001aCodexSchedulerStateAsOf,
  type Exp0001aCodexAccountingLedger,
  type Exp0001aCodexSchedulerState,
} from "./exp0001a-codex-accounting";
import {
  exp0001aCodexAuthoritySignatureSchema,
  verifyExp0001aCodexAuthoritySignature,
  type Exp0001aCodexAuthoritySignature,
} from "./exp0001a-codex-authority";
import {
  verifyExp0001aCodexPrebriefFreeze,
  type Exp0001aCodexPrebriefFreeze,
} from "./exp0001a-codex-prebrief-freeze";
import {
  createExp0001aCodexAdjudicationWorkOrder,
  createExp0001aCodexAnalysisReceipt,
  createExp0001aCodexPairwiseWorkOrder,
  createExp0001aCodexPrimaryReviewWorkOrder,
  lockExp0001aCodexClassifications,
  recordExp0001aCodexAdjudicationResults,
  recordExp0001aCodexPairwiseResults,
  recordExp0001aCodexPrimaryReviewResults,
  sealExp0001aCodexAuthorArtifactCatalog,
  verifyExp0001aCodexReviewPlanManifest,
} from "./exp0001a-codex-review-runtime";
import {
  exp0001aCodexScientificStateSchema,
  type Exp0001aCodexScientificState,
} from "./exp0001a-codex-scientific-runtime";
import {
  exp0001aCodexCoordinatorCheckpointSchema,
  verifyExp0001aCodexRuntimePreflight,
  type Exp0001aCodexCoordinatorCheckpoint,
  type Exp0001aCodexRuntimePreflightReceipt,
} from "./exp0001a-codex-runtime-contract";
import {
  assertExp0001aCodexTaskContextsSeparated,
  exp0001aCodexTaskLifecycleSchema,
  exp0001aCodexTaskTransportPlanSchema,
  type Exp0001aCodexTaskLifecycle,
  type Exp0001aCodexTaskTransportPlan,
} from "./exp0001a-codex-task-transport";
import {
  developmentExecutionManifestSchema,
  verifyDevelopmentExecutionManifest,
  type DevelopmentExecutionManifest,
} from "./development-manifest";
import {
  verifyExp0001aAttemptProvisioningPlan,
  type Exp0001aAttemptProvisioningPlanSet,
} from "./exp0001a-attempt-provisioning";
import { canonicalJson, hashCanonicalJson, SHA256_DIGEST_PATTERN, type JsonValue } from "./provenance-crypto";

export const EXP0001A_CODEX_COMPLETION_ATTESTATION_VERSION = "exp-0001a-codex-completion-attestation/v2" as const;
export const EXP0001A_CODEX_COMPLETION_DRAFT_FILE = "codex-completion-attestation-draft.json" as const;
export const EXP0001A_CODEX_COMPLETION_EVIDENCE_FILE = "codex-completion-evidence.json" as const;
export const EXP0001A_CODEX_COMPLETION_ATTESTATION_FILE = "codex-completion-attestation.json" as const;
export const EXP0001A_COMPLETION_SIGNATURE_MAX_DELAY_MS = 15 * 60_000;
/** A synthetic test draft was accidentally signed with the production key
 * during development. Its exact payload is permanently denied; signatures are
 * purpose- and payload-bound, so this revokes only that non-run artifact. */
export const EXP0001A_REVOKED_COMPLETION_PAYLOAD_DIGESTS = Object.freeze([
  "sha256:4b061142c4dffa3b6393d7966515926c343647f6cb3c40457b7382df4a03f757",
] as const);

/** Compatibility signal: detached, pinned completion authority is installed. */
export const EXP0001A_COMPLETION_AUTHORITY_BLOCKERS = Object.freeze([] as const);

export function assertExp0001aCompletionPayloadNotRevoked(payloadDigest: string): void {
  if ((EXP0001A_REVOKED_COMPLETION_PAYLOAD_DIGESTS as readonly string[]).includes(payloadDigest)) {
    throw new Error("EXP0001A_COMPLETION_AUTHORITY_PAYLOAD_REVOKED");
  }
}

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const roleCountsSchema = z.object({
  subscription_probe: nonNegativeIntegerSchema,
  spike_author: nonNegativeIntegerSchema,
  author: nonNegativeIntegerSchema,
  primary_reviewer: nonNegativeIntegerSchema,
  adjudicator: nonNegativeIntegerSchema,
  pairwise_visual_judge: nonNegativeIntegerSchema,
}).strict();
const transportRoleCountsSchema = z.object({
  author: z.literal(48),
  primary_reviewer: z.literal(96),
  adjudicator: nonNegativeIntegerSchema.max(48),
  pairwise_visual_judge: z.literal(24),
}).strict();
const observableAggregateSchema = z.object({
  observedTotal: nonNegativeIntegerSchema,
  observedTaskCount: nonNegativeIntegerSchema,
  unobservableTaskCount: nonNegativeIntegerSchema,
}).strict();
const accountingSummarySchema = z.object({
  codexTaskCount: nonNegativeIntegerSchema,
  begunTaskCount: nonNegativeIntegerSchema,
  completedTaskCount: nonNegativeIntegerSchema,
  terminalTaskCount: nonNegativeIntegerSchema,
  totalWallTimeMs: nonNegativeIntegerSchema,
  webMcpCallCount: observableAggregateSchema,
  webMcpFailureCount: observableAggregateSchema,
  revisionCount: observableAggregateSchema,
  inspectionCount: observableAggregateSchema,
  usageLimitInterruptionCount: nonNegativeIntegerSchema,
  unobservableResolvedModelCount: nonNegativeIntegerSchema,
  unobservableInputTokenCount: nonNegativeIntegerSchema,
  unobservableOutputTokenCount: nonNegativeIntegerSchema,
  unobservableTotalTokenCount: nonNegativeIntegerSchema,
  unobservableCreditCount: nonNegativeIntegerSchema,
  unobservableSubscriptionUsageCount: nonNegativeIntegerSchema,
  roleTaskCounts: roleCountsSchema,
}).strict();

const completionContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_COMPLETION_ATTESTATION_VERSION),
  kind: z.literal("exp-0001a-codex-experiment-complete"),
  protocolId: z.literal("EXP-0001A"),
  completedAt: timestampSchema,
  lineage: z.object({
    freezeDigest: digestSchema,
    runtimeBundleDigest: digestSchema,
    spikeEvidenceDigest: digestSchema,
    spikeGateDigest: digestSchema,
    executionManifestDigest: digestSchema,
    frozenScheduleDigest: digestSchema,
    schedulerStateDigest: digestSchema,
    accountingLedgerDigest: digestSchema,
    reviewPlanManifestDigest: digestSchema,
    runtimePreflightChainRoot: digestSchema,
    coordinatorCheckpointChainRoot: digestSchema,
  }).strict(),
  schedule: z.object({
    assignmentCount: z.literal(48),
    terminalAssignmentCount: z.literal(48),
    succeededAssignmentCount: nonNegativeIntegerSchema,
    failedAssignmentCount: nonNegativeIntegerSchema,
    usageLimitInterruptedAssignmentCount: nonNegativeIntegerSchema,
    usageResetCount: nonNegativeIntegerSchema,
  }).strict(),
  transport: z.object({
    planCount: nonNegativeIntegerSchema,
    lifecycleCount: nonNegativeIntegerSchema,
    begunTerminalTaskCount: nonNegativeIntegerSchema,
    planRoot: digestSchema,
    lifecycleRoot: digestSchema,
    taskIdentityRoot: digestSchema,
    begunTerminalRoleCounts: transportRoleCountsSchema,
  }).strict(),
  review: z.object({
    scientificStateDigest: digestSchema,
    scientificTransitionRoot: digestSchema,
    authorCatalogDigest: digestSchema,
    primaryWorkOrderDigest: digestSchema,
    primaryResultLedgerDigest: digestSchema,
    adjudicationWorkOrderDigest: digestSchema,
    adjudicationResultLedgerDigest: digestSchema,
    adjudicationTaskCount: nonNegativeIntegerSchema.max(48),
    classificationBookDigest: digestSchema,
    pairwiseWorkOrderDigest: digestSchema,
    pairwiseResultLedgerDigest: digestSchema,
    analysisReceiptDigest: digestSchema,
    analysisReportDigest: digestSchema,
  }).strict(),
  accounting: accountingSummarySchema,
  scientificControls: z.object({
    chatGptSubscriptionTransportOnly: z.literal(true),
    frozenSchedulePreserved: z.literal(true),
    allBegunAttemptsPreserved: z.literal(true),
    freshProjectlessContextsVerified: z.literal(true),
    authorsAndReviewersSeparated: z.literal(true),
    exactFrozenRubricsAndTasksVerified: z.literal(true),
    conditionLabelsBlindedUntilLock: z.literal(true),
    artifactHashesVerified: z.literal(true),
    failedAttemptsRetainedFailClosed: z.literal(true),
    pairwiseUnavailableRetained: z.literal(true),
    clusterAwareAnalysisRetained: z.literal(true),
    usageLimitWindowsPreserved: z.literal(true),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.schedule.succeededAssignmentCount + value.schedule.failedAssignmentCount
      + value.schedule.usageLimitInterruptedAssignmentCount !== 48) {
    context.addIssue({ code: "custom", path: ["schedule"], message: "Terminal assignment outcomes must reconcile to 48." });
  }
  if (value.transport.begunTerminalTaskCount
      !== Object.values(value.transport.begunTerminalRoleCounts).reduce((sum, count) => sum + count, 0)) {
    context.addIssue({ code: "custom", path: ["transport", "begunTerminalTaskCount"], message: "Begun task roles do not reconcile." });
  }
  if (value.transport.begunTerminalRoleCounts.adjudicator !== value.review.adjudicationTaskCount) {
    context.addIssue({ code: "custom", path: ["review", "adjudicationTaskCount"], message: "Adjudication task count does not reconcile." });
  }
});

export const exp0001aCodexCompletionAttestationDraftSchema = completionContentSchema.extend({
  completionDigest: digestSchema,
}).strict();
export type Exp0001aCodexCompletionAttestationDraft = z.infer<typeof exp0001aCodexCompletionAttestationDraftSchema>;

export const exp0001aCodexCompletionAttestationSchema = exp0001aCodexCompletionAttestationDraftSchema.extend({
  authoritySignature: exp0001aCodexAuthoritySignatureSchema,
}).strict();
export type Exp0001aCodexCompletionAttestation = z.infer<typeof exp0001aCodexCompletionAttestationSchema>;

export type Exp0001aCodexCompletionEvidence = Readonly<{
  completedAt: string;
  freeze: Exp0001aCodexPrebriefFreeze;
  executionManifest: DevelopmentExecutionManifest;
  runtimePreflightReceipts: readonly Exp0001aCodexRuntimePreflightReceipt[];
  coordinatorCheckpoints: readonly Exp0001aCodexCoordinatorCheckpoint[];
  scheduler: Exp0001aCodexSchedulerState;
  accountingLedger: Exp0001aCodexAccountingLedger;
  provisioningPlan: Exp0001aAttemptProvisioningPlanSet;
  plans: readonly Exp0001aCodexTaskTransportPlan[];
  lifecycles: readonly Exp0001aCodexTaskLifecycle[];
  scientificState: Exp0001aCodexScientificState;
}>;

function exactEqual(actual: unknown, expected: unknown, code: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(code);
}

function rootOf(values: readonly unknown[]): string {
  return hashCanonicalJson(values as unknown as JsonValue);
}

function verifyCheckpoint(checkpointInput: unknown): Exp0001aCodexCoordinatorCheckpoint {
  const checkpoint = exp0001aCodexCoordinatorCheckpointSchema.parse(checkpointInput);
  const { authoritySignature: _signature, ...payload } = checkpoint;
  void _signature;
  verifyExp0001aCodexAuthoritySignature({
    payload: payload as unknown as JsonValue,
    signature: checkpoint.authoritySignature,
    purpose: "coordinator_checkpoint",
    notBefore: checkpoint.recordedAt,
  });
  if (Date.parse(checkpoint.authoritySignature.signedAt) > Date.parse(checkpoint.expiresAt)) {
    throw new Error("EXP0001A_COMPLETION_CHECKPOINT_SIGNATURE_TIME_INVALID");
  }
  return checkpoint;
}

function verifyRuntimeChain(input: Exp0001aCodexCompletionEvidence, freeze: Exp0001aCodexPrebriefFreeze) {
  if (input.runtimePreflightReceipts.length === 0
      || input.runtimePreflightReceipts.length !== input.coordinatorCheckpoints.length) {
    throw new Error("EXP0001A_COMPLETION_RUNTIME_CHAIN_DENOMINATOR_INVALID");
  }
  const preflights = input.runtimePreflightReceipts.map((receipt) => {
    const checkedAt = typeof receipt === "object" && receipt !== null && "checkedAt" in receipt
      ? String(receipt.checkedAt) : "";
    timestampSchema.parse(checkedAt);
    return verifyExp0001aCodexRuntimePreflight(receipt, checkedAt);
  });
  const checkpoints = input.coordinatorCheckpoints.map(verifyCheckpoint);
  const actions = new Set<string>();
  preflights.forEach((preflight, index) => {
    const checkpoint = checkpoints[index]!;
    const priorCheckpoint = checkpoints[index - 1];
    exactEqual(checkpoint, preflight.coordinatorCheckpoint,
      `EXP0001A_COMPLETION_PREFLIGHT_CHECKPOINT_BYTES_DRIFT:${index}`);
    if (actions.has(preflight.nextAction.actionDigest)) throw new Error("EXP0001A_COMPLETION_RUNTIME_ACTION_REPLAYED");
    actions.add(preflight.nextAction.actionDigest);
    if (preflight.freezeDigest !== freeze.freezeDigest
        || preflight.spikeGateDigest !== freeze.passedSpikeGate.gateDigest
        || preflight.spikeEvidenceDigest !== freeze.passedSpikeGate.spikeEvidenceDigest
        || preflight.nextAction.actionDigest !== checkpoint.authorizedActionDigest
        || preflight.schedulerStateDigest !== checkpoint.schedulerStateDigest
        || preflight.accountingLedgerDigest !== checkpoint.accountingLedgerDigest
        || preflight.provisioningStateDigest !== checkpoint.provisioningStateDigest
        || preflight.coordinatorJournalDigest !== checkpoint.coordinatorJournalDigest
        || checkpoint.freezeDigest !== freeze.freezeDigest
        || checkpoint.runtimeBundleDigest !== freeze.activeRuntime.bundleDigest) {
      throw new Error(`EXP0001A_COMPLETION_RUNTIME_CHAIN_DRIFT:${index}`);
    }
    if ((index === 0 && checkpoint.journalPreviousEntryDigest !== null)
        || (priorCheckpoint !== undefined
          && checkpoint.journalPreviousEntryDigest !== priorCheckpoint.coordinatorJournalDigest)
        || (priorCheckpoint !== undefined
          && Date.parse(checkpoint.recordedAt) < Date.parse(priorCheckpoint.recordedAt))
        || Date.parse(preflight.checkedAt) < Date.parse(checkpoint.recordedAt)) {
      throw new Error(`EXP0001A_COMPLETION_RUNTIME_CHAIN_CONTINUITY_INVALID:${index}`);
    }
  });
  return { preflights, checkpoints };
}

function verifyScheduleAndAccounting(input: Exp0001aCodexCompletionEvidence, freeze: Exp0001aCodexPrebriefFreeze) {
  const accounting = verifyExp0001aCodexAccountingLedgerAsOf(
    exp0001aCodexAccountingLedgerSchema.parse(input.accountingLedger), input.completedAt,
  );
  const scheduler = verifyExp0001aCodexSchedulerStateAsOf({
    scheduler: exp0001aCodexSchedulerStateSchema.parse(input.scheduler),
    accountingLedger: accounting,
    checkedAt: input.completedAt,
  });
  if (scheduler.pause !== null || scheduler.assignments.length !== 48
      || scheduler.assignments.some((assignment) => assignment.state !== "terminal")
      || scheduler.frozenScheduleDigest !== freeze.schedule.codexSchedulerDigest) {
    throw new Error("EXP0001A_COMPLETION_REQUIRES_UNPAUSED_EXACT_48_TERMINAL_SCHEDULE");
  }
  const authorTasks = accounting.tasks.filter((task) => task.role === "author");
  if (authorTasks.length !== 48 || authorTasks.some((task) => task.state !== "terminal")) {
    throw new Error("EXP0001A_COMPLETION_REQUIRES_48_TERMINAL_AUTHOR_TASKS");
  }
  const authorsByAssignment = new Map(authorTasks.map((task) => [task.assignmentId, task]));
  for (const assignment of scheduler.assignments) {
    const task = authorsByAssignment.get(assignment.assignmentId);
    if (!task || task.attemptId !== assignment.attemptId || task.codexTaskId !== assignment.codexTaskId
        || task.threadId !== assignment.threadId || task.terminalOutcome !== assignment.terminalOutcome) {
      throw new Error(`EXP0001A_COMPLETION_SCHEDULER_ACCOUNTING_DRIFT:${assignment.assignmentId}`);
    }
  }
  const successfulResetAccountingIds = new Set<string>();
  for (const reset of scheduler.usageResets) {
    const probe = accounting.tasks.find((task) => task.accountingId === reset.probe.accountingId);
    if (!probe || probe.role !== "subscription_probe" || probe.state !== "terminal"
        || probe.terminalOutcome !== "succeeded" || probe.codexTaskId !== reset.probe.codexTaskId
        || probe.threadId !== reset.probe.threadId || successfulResetAccountingIds.has(probe.accountingId)) {
      throw new Error(`EXP0001A_COMPLETION_USAGE_RESET_PROBE_DRIFT:${reset.observationId}`);
    }
    successfulResetAccountingIds.add(probe.accountingId);
  }
  return { scheduler, accounting };
}

function verifyTransportAndAccounting(input: Exp0001aCodexCompletionEvidence, accounting: Exp0001aCodexAccountingLedger) {
  const plans = input.plans.map((plan) => exp0001aCodexTaskTransportPlanSchema.parse(plan));
  const lifecycles = input.lifecycles.map((lifecycle) => exp0001aCodexTaskLifecycleSchema.parse(lifecycle));
  const plansByDigest = new Map(plans.map((plan) => [plan.planDigest, plan]));
  const lifecyclesByPlan = new Map(lifecycles.map((lifecycle) => [lifecycle.planDigest, lifecycle]));
  if (plansByDigest.size !== plans.length || lifecyclesByPlan.size !== lifecycles.length
      || plans.some((plan) => !lifecyclesByPlan.has(plan.planDigest))
      || lifecycles.some((lifecycle) => !plansByDigest.has(lifecycle.planDigest))) {
    throw new Error("EXP0001A_COMPLETION_PLAN_LIFECYCLE_DENOMINATOR_DRIFT");
  }
  assertExp0001aCodexTaskContextsSeparated(plans.map((plan) => ({ plan, lifecycle: lifecyclesByPlan.get(plan.planDigest)! })));
  const begun = plans.map((plan) => ({ plan, lifecycle: lifecyclesByPlan.get(plan.planDigest)! }))
    .filter(({ lifecycle }) => lifecycle.taskBegun);
  if (begun.some(({ lifecycle }) => lifecycle.state !== "terminal" || lifecycle.readReceipt === null
      || lifecycle.codexTaskId === null || lifecycle.threadId === null)) {
    throw new Error("EXP0001A_COMPLETION_REQUIRES_EVERY_BEGUN_TASK_TERMINAL");
  }
  const roleCounts = { author: 0, primary_reviewer: 0, adjudicator: 0, pairwise_visual_judge: 0 };
  for (const { plan, lifecycle } of begun) {
    roleCounts[plan.role] += 1;
    const record = accounting.tasks.find((task) => task.assignmentId === plan.privateBinding.assignmentId);
    if (!record || record.attemptId !== plan.privateBinding.attemptId || record.role !== plan.role
        || record.state !== "terminal" || record.codexTaskId !== lifecycle.codexTaskId
        || record.threadId !== lifecycle.threadId
        || record.terminalOutcome !== (lifecycle.terminalOutcome === "needs_attention"
          || lifecycle.terminalOutcome === "non_evaluable" ? "failed" : lifecycle.terminalOutcome)) {
      throw new Error(`EXP0001A_COMPLETION_TRANSPORT_ACCOUNTING_DRIFT:${plan.transportId}`);
    }
  }
  const transportedAccounting = accounting.tasks.filter((task) => task.role !== "subscription_probe" && task.role !== "spike_author");
  if (transportedAccounting.length !== begun.length) {
    throw new Error("EXP0001A_COMPLETION_TRANSPORT_ACCOUNTING_DENOMINATOR_DRIFT");
  }
  return { plans, lifecycles, begun, roleCounts, plansByDigest, lifecyclesByPlan };
}

function assertResultTransports(input: Readonly<{
  results: readonly { planDigest: string; lifecycleDigest: string; terminalOutcome: string }[];
  role: "primary_reviewer" | "adjudicator" | "pairwise_visual_judge";
  plansByDigest: Map<string, Exp0001aCodexTaskTransportPlan>;
  lifecyclesByPlan: Map<string, Exp0001aCodexTaskLifecycle>;
}>): void {
  for (const result of input.results) {
    const plan = input.plansByDigest.get(result.planDigest);
    const lifecycle = plan === undefined ? undefined : input.lifecyclesByPlan.get(plan.planDigest);
    if (!plan || !lifecycle || plan.role !== input.role || lifecycle.lifecycleDigest !== result.lifecycleDigest
        || lifecycle.terminalOutcome !== result.terminalOutcome) {
      throw new Error(`EXP0001A_COMPLETION_${input.role.toUpperCase()}_TRANSPORT_DRIFT`);
    }
  }
}

function verifyReviewChain(input: Exp0001aCodexCompletionEvidence, freeze: Exp0001aCodexPrebriefFreeze,
  executionManifest: DevelopmentExecutionManifest, transport: ReturnType<typeof verifyTransportAndAccounting>,
  scheduler: Exp0001aCodexSchedulerState, accounting: Exp0001aCodexAccountingLedger) {
  const provisioningVerification = verifyExp0001aAttemptProvisioningPlan(input.provisioningPlan);
  if (!provisioningVerification.ok) {
    throw new Error(`EXP0001A_COMPLETION_PROVISIONING_PLAN_INVALID:${provisioningVerification.errors.join("|")}`);
  }
  const provisioningPlan = provisioningVerification.plan;
  const scientificState = exp0001aCodexScientificStateSchema.parse(input.scientificState);
  if (scientificState.transitionDigests.length !== 9
      || scientificState.authorCatalog === null
      || scientificState.primaryWorkOrder === null
      || scientificState.primaryResults === null
      || scientificState.adjudicationWorkOrder === null
      || scientificState.adjudicationResults === null
      || scientificState.classifications === null
      || scientificState.pairwiseWorkOrder === null
      || scientificState.pairwiseResults === null
      || scientificState.analysisReceipt === null) {
    throw new Error("EXP0001A_COMPLETION_REQUIRES_FINAL_SCIENTIFIC_STATE");
  }
  const reviewPlan = verifyExp0001aCodexReviewPlanManifest({
    manifest: scientificState.reviewPlanManifest,
    executionManifest,
  });
  if (reviewPlan.manifestDigest !== freeze.reviewCommitments.reviewPlanManifestDigest) {
    throw new Error("EXP0001A_COMPLETION_REVIEW_PLAN_NOT_FROZEN");
  }
  const catalog = sealExp0001aCodexAuthorArtifactCatalog({
    freeze,
    provisioningPlan,
    scheduler,
    plans: transport.plans,
    lifecycles: transport.lifecycles,
  });
  exactEqual(scientificState.authorCatalog, catalog, "EXP0001A_COMPLETION_AUTHOR_CATALOG_DRIFT");
  const primaryWorkOrder = createExp0001aCodexPrimaryReviewWorkOrder({
    freeze,
    catalog,
    reviewPlanManifest: reviewPlan,
  });
  exactEqual(scientificState.primaryWorkOrder, primaryWorkOrder,
    "EXP0001A_COMPLETION_PRIMARY_WORK_ORDER_DRIFT");
  const primaryResults = recordExp0001aCodexPrimaryReviewResults({
    workOrder: primaryWorkOrder,
    plans: transport.plans,
    lifecycles: transport.lifecycles,
  });
  exactEqual(scientificState.primaryResults, primaryResults,
    "EXP0001A_COMPLETION_PRIMARY_RESULT_LEDGER_DRIFT");
  assertResultTransports({ results: primaryResults.results, role: "primary_reviewer", ...transport });
  const adjudicationWorkOrder = createExp0001aCodexAdjudicationWorkOrder({
    freeze, catalog, primaryWorkOrder, primaryResults, reviewPlanManifest: reviewPlan,
    primaryPlans: transport.plans.filter((plan) => plan.role === "primary_reviewer"),
    primaryLifecycles: transport.lifecycles.filter((lifecycle) => lifecycle.role === "primary_reviewer"),
  });
  exactEqual(scientificState.adjudicationWorkOrder, adjudicationWorkOrder,
    "EXP0001A_COMPLETION_ADJUDICATION_WORK_ORDER_DRIFT");
  const adjudicationResults = recordExp0001aCodexAdjudicationResults({
    workOrder: adjudicationWorkOrder,
    plans: transport.plans,
    lifecycles: transport.lifecycles,
  });
  exactEqual(scientificState.adjudicationResults, adjudicationResults,
    "EXP0001A_COMPLETION_ADJUDICATION_RESULT_LEDGER_DRIFT");
  assertResultTransports({ results: adjudicationResults.results, role: "adjudicator", ...transport });
  const classifications = lockExp0001aCodexClassifications({
    lockedAt: scientificState.classifications.lockedAt,
    catalog,
    primaryResults,
    adjudicationWorkOrder,
    adjudicationResults,
  });
  exactEqual(scientificState.classifications, classifications,
    "EXP0001A_COMPLETION_CLASSIFICATION_BOOK_DRIFT");
  const pairwiseWorkOrder = createExp0001aCodexPairwiseWorkOrder({
    freeze, reviewPlanManifest: reviewPlan, catalog, classifications,
    authorPlans: transport.plans.filter((plan) => plan.role === "author"),
    authorLifecycles: transport.lifecycles.filter((lifecycle) => lifecycle.role === "author"),
  });
  exactEqual(scientificState.pairwiseWorkOrder, pairwiseWorkOrder,
    "EXP0001A_COMPLETION_PAIRWISE_WORK_ORDER_DRIFT");
  const pairwiseResults = recordExp0001aCodexPairwiseResults({
    workOrder: pairwiseWorkOrder,
    plans: transport.plans,
    lifecycles: transport.lifecycles,
  });
  exactEqual(scientificState.pairwiseResults, pairwiseResults,
    "EXP0001A_COMPLETION_PAIRWISE_RESULT_LEDGER_DRIFT");
  assertResultTransports({ results: pairwiseResults.results, role: "pairwise_visual_judge", ...transport });
  const analysisReceipt = createExp0001aCodexAnalysisReceipt({
    createdAt: scientificState.analysisReceipt.createdAt,
    catalog,
    classifications,
    pairwiseWorkOrder,
    pairwiseResults,
    accountingLedger: accounting,
  });
  exactEqual(scientificState.analysisReceipt, analysisReceipt,
    "EXP0001A_COMPLETION_ANALYSIS_RECEIPT_DRIFT");
  const reconstructedArtifacts = [catalog, primaryWorkOrder, primaryResults, adjudicationWorkOrder,
    adjudicationResults, classifications, pairwiseWorkOrder, pairwiseResults, analysisReceipt];
  exactEqual(scientificState.transitionDigests, reconstructedArtifacts.map((artifact) => hashCanonicalJson(artifact as unknown as JsonValue)),
    "EXP0001A_COMPLETION_SCIENTIFIC_TRANSITION_CHAIN_DRIFT");
  const claimedPlanDigests = new Set([
    ...catalog.entries.map((entry) => entry.authorPlanDigest),
    ...primaryResults.results.map((entry) => entry.planDigest),
    ...adjudicationResults.results.map((entry) => entry.planDigest),
    ...pairwiseResults.results.map((entry) => entry.planDigest),
  ]);
  if (claimedPlanDigests.size !== transport.begun.length
      || transport.begun.some(({ plan }) => !claimedPlanDigests.has(plan.planDigest))) {
    throw new Error("EXP0001A_COMPLETION_UNCLAIMED_BEGUN_TASK");
  }
  return { provisioningPlan, scientificState, reviewPlan, catalog, primaryWorkOrder, primaryResults, adjudicationWorkOrder,
    adjudicationResults, classifications, pairwiseWorkOrder, pairwiseResults, analysisReceipt };
}

function validateCompletionEvidence(input: Exp0001aCodexCompletionEvidence) {
  timestampSchema.parse(input.completedAt);
  const freeze = verifyExp0001aCodexPrebriefFreeze(input.freeze);
  const manifestVerification = verifyDevelopmentExecutionManifest(input.executionManifest);
  if (!manifestVerification.ok) {
    throw new Error(`EXP0001A_COMPLETION_EXECUTION_MANIFEST_INVALID:${manifestVerification.errors.join("|")}`);
  }
  const executionManifest = developmentExecutionManifestSchema.parse(manifestVerification.manifest);
  if (executionManifest.manifestDigest !== freeze.schedule.manifestDigest) {
    throw new Error("EXP0001A_COMPLETION_EXECUTION_MANIFEST_NOT_FROZEN");
  }
  const runtime = verifyRuntimeChain(input, freeze);
  const { scheduler, accounting } = verifyScheduleAndAccounting(input, freeze);
  const transport = verifyTransportAndAccounting(input, accounting);
  const review = verifyReviewChain(input, freeze, executionManifest, transport, scheduler, accounting);
  if (transport.roleCounts.author !== 48 || transport.roleCounts.primary_reviewer !== 96
      || transport.roleCounts.adjudicator !== review.adjudicationWorkOrder.workItems.length
      || transport.roleCounts.pairwise_visual_judge !== 24) {
    throw new Error("EXP0001A_COMPLETION_TASK_ROLE_DENOMINATOR_INVALID");
  }
  const latestEvidenceMs = Math.max(
    Date.parse(review.analysisReceipt.createdAt),
    Date.parse(review.classifications.lockedAt),
    ...accounting.tasks.map((task) => Date.parse(task.terminalAt ?? task.completedAt ?? task.begunAt)),
    ...runtime.preflights.map((preflight) => Date.parse(preflight.checkedAt)),
    ...runtime.checkpoints.flatMap((checkpoint) => [
      Date.parse(checkpoint.recordedAt),
      Date.parse(checkpoint.authoritySignature.signedAt),
    ]),
    ...scheduler.usageLimitInterruptions.map((interruption) => Date.parse(interruption.observedAt)),
    ...scheduler.usageResets.flatMap((reset) => [
      Date.parse(reset.observedAt),
      Date.parse(reset.resumedAt),
      Date.parse(reset.authoritySignature.signedAt),
    ]),
  );
  if (Date.parse(input.completedAt) < latestEvidenceMs) throw new Error("EXP0001A_COMPLETION_PREDATES_EVIDENCE");
  return { freeze, executionManifest, runtime, scheduler, accounting, transport, review };
}

export function createExp0001aCodexCompletionAttestation(
  input: Exp0001aCodexCompletionEvidence,
): Exp0001aCodexCompletionAttestationDraft {
  const verified = validateCompletionEvidence(input);
  const outcomes = verified.scheduler.assignments.map((assignment) => assignment.terminalOutcome);
  const content = completionContentSchema.parse({
    schemaVersion: EXP0001A_CODEX_COMPLETION_ATTESTATION_VERSION,
    kind: "exp-0001a-codex-experiment-complete",
    protocolId: "EXP-0001A",
    completedAt: input.completedAt,
    lineage: {
      freezeDigest: verified.freeze.freezeDigest,
      runtimeBundleDigest: verified.freeze.activeRuntime.bundleDigest,
      spikeEvidenceDigest: verified.freeze.passedSpikeGate.spikeEvidenceDigest,
      spikeGateDigest: verified.freeze.passedSpikeGate.gateDigest,
      executionManifestDigest: verified.executionManifest.manifestDigest,
      frozenScheduleDigest: verified.scheduler.frozenScheduleDigest,
      schedulerStateDigest: hashCanonicalJson(verified.scheduler as unknown as JsonValue),
      accountingLedgerDigest: hashCanonicalJson(verified.accounting as unknown as JsonValue),
      reviewPlanManifestDigest: verified.review.reviewPlan.manifestDigest,
      runtimePreflightChainRoot: rootOf(verified.runtime.preflights),
      coordinatorCheckpointChainRoot: rootOf(verified.runtime.checkpoints),
    },
    schedule: {
      assignmentCount: 48,
      terminalAssignmentCount: 48,
      succeededAssignmentCount: outcomes.filter((outcome) => outcome === "succeeded").length,
      failedAssignmentCount: outcomes.filter((outcome) => outcome !== "succeeded" && outcome !== "usage_limit_interrupted").length,
      usageLimitInterruptedAssignmentCount: outcomes.filter((outcome) => outcome === "usage_limit_interrupted").length,
      usageResetCount: verified.scheduler.usageResets.length,
    },
    transport: {
      planCount: verified.transport.plans.length,
      lifecycleCount: verified.transport.lifecycles.length,
      begunTerminalTaskCount: verified.transport.begun.length,
      planRoot: rootOf(verified.transport.plans),
      lifecycleRoot: rootOf(verified.transport.lifecycles),
      taskIdentityRoot: rootOf(verified.transport.begun.map(({ plan, lifecycle }) => ({
        role: plan.role, assignmentId: plan.privateBinding.assignmentId, attemptId: plan.privateBinding.attemptId,
        codexTaskId: lifecycle.codexTaskId, threadId: lifecycle.threadId, hostId: lifecycle.hostId,
      }))),
      begunTerminalRoleCounts: verified.transport.roleCounts,
    },
    review: {
      scientificStateDigest: verified.review.scientificState.stateDigest,
      scientificTransitionRoot: rootOf(verified.review.scientificState.transitionDigests),
      authorCatalogDigest: verified.review.catalog.catalogDigest,
      primaryWorkOrderDigest: verified.review.primaryWorkOrder.workOrderDigest,
      primaryResultLedgerDigest: verified.review.primaryResults.resultLedgerDigest,
      adjudicationWorkOrderDigest: verified.review.adjudicationWorkOrder.workOrderDigest,
      adjudicationResultLedgerDigest: verified.review.adjudicationResults.resultLedgerDigest,
      adjudicationTaskCount: verified.review.adjudicationWorkOrder.workItems.length,
      classificationBookDigest: verified.review.classifications.classificationBookDigest,
      pairwiseWorkOrderDigest: verified.review.pairwiseWorkOrder.workOrderDigest,
      pairwiseResultLedgerDigest: verified.review.pairwiseResults.resultLedgerDigest,
      analysisReceiptDigest: verified.review.analysisReceipt.receiptDigest,
      analysisReportDigest: verified.review.analysisReceipt.analysisReportDigest,
    },
    accounting: summarizeExp0001aCodexAccounting(verified.accounting),
    scientificControls: {
      chatGptSubscriptionTransportOnly: true, frozenSchedulePreserved: true,
      allBegunAttemptsPreserved: true, freshProjectlessContextsVerified: true, authorsAndReviewersSeparated: true,
      exactFrozenRubricsAndTasksVerified: true, conditionLabelsBlindedUntilLock: true, artifactHashesVerified: true,
      failedAttemptsRetainedFailClosed: true, pairwiseUnavailableRetained: true, clusterAwareAnalysisRetained: true,
      usageLimitWindowsPreserved: true,
    },
  });
  return Object.freeze(exp0001aCodexCompletionAttestationDraftSchema.parse({
    ...content, completionDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

export function authorizeExp0001aCodexCompletionAttestation(input: Readonly<{
  draft: Exp0001aCodexCompletionAttestationDraft;
  authoritySignature: Exp0001aCodexAuthoritySignature;
  verifiedAt: string;
}>): Exp0001aCodexCompletionAttestation {
  const draft = exp0001aCodexCompletionAttestationDraftSchema.parse(input.draft);
  const { completionDigest: _digest, ...content } = draft;
  void _digest;
  if (hashCanonicalJson(completionContentSchema.parse(content) as unknown as JsonValue) !== draft.completionDigest) {
    throw new Error("EXP0001A_COMPLETION_ATTESTATION_DIGEST_INVALID");
  }
  timestampSchema.parse(input.verifiedAt);
  const signature = verifyExp0001aCodexAuthoritySignature({
    payload: draft as unknown as JsonValue, signature: input.authoritySignature,
    purpose: "completion_attestation", notBefore: draft.completedAt,
  });
  assertExp0001aCompletionPayloadNotRevoked(signature.payloadDigest);
  const delayMs = Date.parse(signature.signedAt) - Date.parse(draft.completedAt);
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > EXP0001A_COMPLETION_SIGNATURE_MAX_DELAY_MS
      || Date.parse(signature.signedAt) > Date.parse(input.verifiedAt)) {
    throw new Error("EXP0001A_COMPLETION_AUTHORITY_SIGNATURE_TIME_INVALID");
  }
  return Object.freeze(exp0001aCodexCompletionAttestationSchema.parse({ ...draft, authoritySignature: signature }));
}

export function verifyExp0001aCodexCompletionAttestation(input: Readonly<{
  attestation: unknown;
  evidence: Exp0001aCodexCompletionEvidence;
  verifiedAt: string;
}>): Exp0001aCodexCompletionAttestation {
  const attestation = exp0001aCodexCompletionAttestationSchema.parse(input.attestation);
  const { authoritySignature, ...draft } = attestation;
  const expected = createExp0001aCodexCompletionAttestation(input.evidence);
  exactEqual(draft, expected, "EXP0001A_COMPLETION_ATTESTATION_EVIDENCE_DRIFT");
  return authorizeExp0001aCodexCompletionAttestation({ draft, authoritySignature, verifiedAt: input.verifiedAt });
}

async function assertPrivatePlainFile(filePath: string): Promise<void> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    throw new Error("Completion attestation must be a private, singly linked, plain file.");
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function retainExp0001aCodexCompletionAttestation(input: Readonly<{
  runRoot: string;
  attestation: Exp0001aCodexCompletionAttestation;
  evidence: Exp0001aCodexCompletionEvidence;
}>): Promise<string> {
  const attestation = verifyExp0001aCodexCompletionAttestation({
    attestation: input.attestation,
    evidence: input.evidence,
    verifiedAt: new Date().toISOString(),
  });
  if (!path.isAbsolute(input.runRoot) || path.normalize(input.runRoot) !== input.runRoot
      || input.runRoot === path.parse(input.runRoot).root) {
    throw new Error("Completion run root must be an absolute normalized non-root path.");
  }
  await mkdir(input.runRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(input.runRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) {
    throw new Error("Completion run root must be a private non-symlink directory.");
  }
  const outputPath = path.join(input.runRoot, EXP0001A_CODEX_COMPLETION_ATTESTATION_FILE);
  const bytes = Buffer.from(`${canonicalJson(attestation)}\n`, "utf8");
  const handle = await open(outputPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await fsyncDirectory(input.runRoot);
  await assertPrivatePlainFile(outputPath);
  const retainedBytes = await readFile(outputPath);
  if (!retainedBytes.equals(bytes)) throw new Error("Completion attestation readback differs from retained bytes.");
  exp0001aCodexCompletionAttestationSchema.parse(JSON.parse(retainedBytes.toString("utf8")));
  return outputPath;
}
