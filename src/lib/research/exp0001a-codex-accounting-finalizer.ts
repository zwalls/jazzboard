import { z } from "zod";

import {
  EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
  UNOBSERVABLE,
  beginExp0001aCodexTask,
  completeExp0001aCodexTask,
  exp0001aCodexTaskAccountingSchema,
  interruptExp0001aCodexTaskForUsageLimit,
  terminateExp0001aCodexTask,
  type Exp0001aCodexTaskAccounting,
} from "./exp0001a-codex-accounting";
import {
  exp0001aCodexTaskLifecycleSchema,
  exp0001aCodexTaskTransportPlanSchema,
  type Exp0001aCodexTaskLifecycle,
  type Exp0001aCodexTaskTransportPlan,
} from "./exp0001a-codex-task-transport";
import { canonicalJson, hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

export const EXP0001A_CODEX_ACCOUNTING_FINALIZER_VERSION = "exp-0001a-codex-accounting-finalizer/v1" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const idSchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z.string().datetime({ offset: true });
const observableOrUnobservableCountSchema = z.union([
  z.literal(UNOBSERVABLE),
  z.object({
    value: z.number().int().nonnegative(),
    source: z.literal("retained_task_receipt"),
    observedAt: timestampSchema,
    evidenceDigest: digestSchema,
  }).strict(),
]);

const finalizationContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_ACCOUNTING_FINALIZER_VERSION),
  kind: z.literal("codex-task-accounting-finalization-receipt"),
  planDigest: digestSchema,
  lifecycleDigest: digestSchema,
  readReceiptDigest: digestSchema,
  traceObservationEvidenceDigest: digestSchema.nullable(),
  accountingId: idSchema,
  assignmentId: idSchema,
  attemptId: idSchema,
  role: z.enum(["subscription_probe", "spike_author", "author", "primary_reviewer", "adjudicator", "pairwise_visual_judge"]),
  codexTaskId: idSchema,
  threadId: idSchema,
  hostId: idSchema,
  begunAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  terminalAt: timestampSchema,
  terminalOutcome: z.enum(["succeeded", "failed", "usage_limit_interrupted", "infra_failure", "policy_violation"]),
  webMcpCallCount: observableOrUnobservableCountSchema,
  webMcpFailureCount: observableOrUnobservableCountSchema,
  revisionCount: z.literal(UNOBSERVABLE),
  inspectionCount: z.literal(UNOBSERVABLE),
  accountingRecord: exp0001aCodexTaskAccountingSchema,
  accountingRecordDigest: digestSchema,
}).strict();

export const exp0001aCodexAccountingFinalizationReceiptSchema = finalizationContentSchema
  .extend({ receiptDigest: digestSchema }).strict().superRefine((receipt, context) => {
    const { receiptDigest: _receiptDigest, ...content } = receipt;
    void _receiptDigest;
    if (hashCanonicalJson(content) !== receipt.receiptDigest
        || hashCanonicalJson(receipt.accountingRecord) !== receipt.accountingRecordDigest) {
      context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Accounting finalization receipt is not content-addressed." });
    }
  });
export type Exp0001aCodexAccountingFinalizationReceipt = z.infer<typeof exp0001aCodexAccountingFinalizationReceiptSchema>;

function observedCount(value: number | typeof UNOBSERVABLE, observedAt: string, evidenceDigest: string) {
  return value === UNOBSERVABLE ? UNOBSERVABLE : Object.freeze({
    value,
    source: "retained_task_receipt" as const,
    observedAt,
    evidenceDigest,
  });
}

function deriveTerminalOutcome(lifecycle: Exp0001aCodexTaskLifecycle) {
  switch (lifecycle.terminalOutcome) {
    case "succeeded": return { outcome: "succeeded" as const, reasonCode: "retained_task_succeeded" };
    case "usage_limit_interrupted": return { outcome: "usage_limit_interrupted" as const, reasonCode: "subscription_usage_limit" };
    case "policy_violation": return { outcome: "policy_violation" as const, reasonCode: "retained_task_policy_violation" };
    case "infra_failure": return { outcome: "infra_failure" as const, reasonCode: "retained_task_infra_failure" };
    case "needs_attention": return { outcome: "failed" as const, reasonCode: "retained_task_needs_attention" };
    case "non_evaluable": return { outcome: "failed" as const, reasonCode: "retained_task_non_evaluable" };
    default: throw new Error("EXP0001A_ACCOUNTING_FINALIZATION_REQUIRES_TERMINAL_OUTCOME");
  }
}

/**
 * Reconstructs accounting only from an exact terminal transport lifecycle.
 * No caller supplies activity counts. Missing trace observability remains the
 * literal `unobservable`; it is never converted into an inferred zero.
 */
export function finalizeExp0001aCodexTaskAccounting(input: Readonly<{
  accountingId: string;
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
}>): Exp0001aCodexAccountingFinalizationReceipt {
  const accountingId = idSchema.parse(input.accountingId);
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.plan);
  const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  const read = lifecycle.readReceipt;
  const directReadyIdentity = lifecycle.createReceipt.outcome === "ready"
    && lifecycle.createReceipt.codexTaskId === lifecycle.codexTaskId
    && lifecycle.createReceipt.threadId === lifecycle.threadId
    && lifecycle.createReceipt.hostId === lifecycle.hostId;
  const readyReconciliations = lifecycle.reconciliationReceipts.filter((receipt) =>
    receipt.outcome === "ready"
      && receipt.transportId === plan.transportId
      && receipt.expectedUniqueTaskTitle === plan.createThreadCommand.arguments.title
      && receipt.matches.length === 1
      && receipt.matches[0]?.threadId === lifecycle.threadId
      && receipt.matches[0]?.hostId === lifecycle.hostId
      && receipt.matches[0]?.exactTitle === plan.createThreadCommand.arguments.title,
  );
  const reconciledReadyIdentity = lifecycle.createReceipt.outcome === "uncertain_after_release"
    && lifecycle.createReceipt.codexTaskId === null
    && lifecycle.createReceipt.threadId === null
    && lifecycle.createReceipt.hostId === null
    && readyReconciliations.length === 1;
  if (lifecycle.planDigest !== plan.planDigest || lifecycle.transportId !== plan.transportId
      || lifecycle.role !== plan.role || lifecycle.state !== "terminal" || !lifecycle.taskBegun
      || lifecycle.codexTaskId === null || lifecycle.threadId === null || lifecycle.hostId === null
      || read === null || read.codexTaskId !== lifecycle.codexTaskId
      || (directReadyIdentity ? readyReconciliations.length !== 0 : !reconciledReadyIdentity)) {
    throw new Error("EXP0001A_ACCOUNTING_FINALIZATION_TRANSPORT_BINDING_INVALID");
  }
  const roleSettings = EXP0001A_CODEX_FROZEN_ROLE_SETTINGS[plan.role];
  let accounting = beginExp0001aCodexTask({
    accountingId,
    assignmentId: plan.privateBinding.assignmentId,
    attemptId: plan.privateBinding.attemptId,
    role: plan.role,
    codexTaskId: lifecycle.codexTaskId,
    threadId: lifecycle.threadId,
    hostId: lifecycle.hostId,
    isolation: {
      workspace: "projectless",
      repositoryAccess: false,
      privateApiAccess: false,
      sharedHistory: false,
      forkedFromAnotherTask: false,
      preparedCoordinates: false,
      evaluatorContext: false,
    },
    requestedModel: roleSettings.requestedModel,
    requestedReasoningEffort: roleSettings.requestedReasoningEffort,
    // A task released before its identity is returned or reconciled may have
    // executed during that interval. The retained invocation is therefore the
    // single conservative begin boundary for both direct and reconciled tasks.
    begunAt: lifecycle.releaseInvocationReceipt.invokedAt,
  });
  const trace = read.taskTraceObservation;
  const traceEvidenceDigest = trace?.observationEvidenceDigest ?? null;
  const webMcpCallCount = trace === null
    ? UNOBSERVABLE : observedCount(trace.webMcpCallCount, read.observedAt, trace.observationEvidenceDigest);
  const webMcpFailureCount = trace === null
    ? UNOBSERVABLE : observedCount(trace.webMcpFailureCount, read.observedAt, trace.observationEvidenceDigest);
  const lastWait = lifecycle.waitReceipts.at(-1);
  const completedAt = lifecycle.terminalOutcome === "succeeded" ? lastWait?.terminalCompletedAt ?? null : null;
  if (lifecycle.terminalOutcome === "succeeded") {
    if (completedAt === null) throw new Error("EXP0001A_ACCOUNTING_SUCCESS_COMPLETION_TIME_MISSING");
    accounting = completeExp0001aCodexTask(accounting, completedAt);
  }
  const terminalAt = read.observedAt;
  const terminal = deriveTerminalOutcome(lifecycle);
  accounting = terminal.outcome === "usage_limit_interrupted"
    ? interruptExp0001aCodexTaskForUsageLimit(accounting, {
      observedAt: terminalAt,
      phase: lastWait?.outcome === "usage_limit" ? "task_wait" : "artifact_collection",
      evidenceDigest: read.evidenceDigest,
      reasonCode: terminal.reasonCode,
    })
    : terminateExp0001aCodexTask(accounting, {
      terminalAt,
      outcome: terminal.outcome,
      reasonCode: terminal.reasonCode,
    });
  accounting = exp0001aCodexTaskAccountingSchema.parse({
    ...accounting,
    webMcp: { callCount: webMcpCallCount, failureCount: webMcpFailureCount },
    // The retained trace currently proves task-level WebMCP counts, but not a
    // complete per-revision/per-inspection event ledger. Preserve that gap.
    canvas: { revisionCount: UNOBSERVABLE, inspectionCount: UNOBSERVABLE },
  });
  const content = finalizationContentSchema.parse({
    schemaVersion: EXP0001A_CODEX_ACCOUNTING_FINALIZER_VERSION,
    kind: "codex-task-accounting-finalization-receipt",
    planDigest: plan.planDigest,
    lifecycleDigest: lifecycle.lifecycleDigest,
    readReceiptDigest: read.receiptDigest,
    traceObservationEvidenceDigest: traceEvidenceDigest,
    accountingId,
    assignmentId: plan.privateBinding.assignmentId,
    attemptId: plan.privateBinding.attemptId,
    role: plan.role,
    codexTaskId: lifecycle.codexTaskId,
    threadId: lifecycle.threadId,
    hostId: lifecycle.hostId,
    begunAt: accounting.begunAt,
    completedAt: accounting.completedAt,
    terminalAt: accounting.terminalAt,
    terminalOutcome: accounting.terminalOutcome,
    webMcpCallCount,
    webMcpFailureCount,
    revisionCount: UNOBSERVABLE,
    inspectionCount: UNOBSERVABLE,
    accountingRecord: accounting,
    accountingRecordDigest: hashCanonicalJson(accounting),
  });
  return Object.freeze(exp0001aCodexAccountingFinalizationReceiptSchema.parse({
    ...content,
    receiptDigest: hashCanonicalJson(content),
  }));
}

export function verifyExp0001aCodexAccountingFinalizationReceipt(input: Readonly<{
  receipt: unknown;
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
}>): Exp0001aCodexAccountingFinalizationReceipt {
  const receipt = exp0001aCodexAccountingFinalizationReceiptSchema.parse(input.receipt);
  const expected = finalizeExp0001aCodexTaskAccounting({
    accountingId: receipt.accountingId,
    plan: input.plan,
    lifecycle: input.lifecycle,
  });
  if (canonicalJson(receipt) !== canonicalJson(expected)) {
    throw new Error("EXP0001A_ACCOUNTING_FINALIZATION_RECEIPT_DRIFT");
  }
  return Object.freeze(receipt);
}
