import { z } from "zod";

import {
  exp0001aCodexAuthoritySignatureSchema,
  verifyExp0001aCodexAuthoritySignature,
} from "./exp0001a-codex-authority";
import { hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

const idSchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z.string().datetime({ offset: true });
const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const EXP0001A_CODEX_TASK_ACCOUNTING_VERSION = "exp-0001a-codex-task-accounting/v1" as const;
export const EXP0001A_CODEX_SCHEDULER_VERSION = "exp-0001a-codex-subscription-scheduler/v1" as const;
export const UNOBSERVABLE = "unobservable" as const;

const observationSourceSchema = z.enum([
  "codex_app",
  "codex_cli",
  "chatgpt_account",
  "retained_task_receipt",
]);

function observableFieldSchema<T extends z.ZodType>(valueSchema: T) {
  return z.union([
    z.literal(UNOBSERVABLE),
    z.object({
      value: valueSchema,
      source: observationSourceSchema,
      observedAt: timestampSchema,
      evidenceDigest: digestSchema,
    }).strict(),
  ]);
}

export const observableStringSchema = observableFieldSchema(z.string().trim().min(1).max(240));
export const observableCountSchema = observableFieldSchema(nonNegativeIntegerSchema);
export const observableCreditSchema = observableFieldSchema(z.number().finite().nonnegative());
export type ObservableString = z.infer<typeof observableStringSchema>;
export type ObservableCount = z.infer<typeof observableCountSchema>;
export type ObservableCredit = z.infer<typeof observableCreditSchema>;

const subscriptionUsageValueSchema = z.object({
  unit: z.enum(["credits", "percent_used", "percent_remaining", "tasks_used", "tasks_remaining"]),
  amount: z.number().finite().nonnegative(),
  windowStartedAt: timestampSchema.nullable(),
  windowEndsAt: timestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.unit === "percent_used" || value.unit === "percent_remaining") && value.amount > 100) {
    context.addIssue({ code: "custom", path: ["amount"], message: "A percentage observation cannot exceed 100." });
  }
  if (value.windowStartedAt !== null && value.windowEndsAt !== null
      && Date.parse(value.windowEndsAt) < Date.parse(value.windowStartedAt)) {
    context.addIssue({ code: "custom", path: ["windowEndsAt"], message: "Usage-window end cannot precede its start." });
  }
});

export const observableSubscriptionUsageSchema = observableFieldSchema(subscriptionUsageValueSchema);
export type ObservableSubscriptionUsage = z.infer<typeof observableSubscriptionUsageSchema>;

export const exp0001aCodexTaskRoleSchema = z.enum([
  "subscription_probe",
  "spike_author",
  "author",
  "primary_reviewer",
  "adjudicator",
  "pairwise_visual_judge",
]);
export type Exp0001aCodexTaskRole = z.infer<typeof exp0001aCodexTaskRoleSchema>;

const frozenRoleSettingSchema = z.object({
  requestedModel: z.literal("gpt-5.6-sol"),
  requestedReasoningEffort: z.enum(["max", "high", "low"]),
}).strict();

export const exp0001aCodexFrozenRoleSettingsSchema = z.object({
  subscription_probe: frozenRoleSettingSchema.extend({ requestedReasoningEffort: z.literal("low") }).strict(),
  spike_author: frozenRoleSettingSchema.extend({ requestedReasoningEffort: z.literal("max") }).strict(),
  author: frozenRoleSettingSchema.extend({ requestedReasoningEffort: z.literal("max") }).strict(),
  primary_reviewer: frozenRoleSettingSchema.extend({ requestedReasoningEffort: z.literal("high") }).strict(),
  adjudicator: frozenRoleSettingSchema.extend({ requestedReasoningEffort: z.literal("high") }).strict(),
  pairwise_visual_judge: frozenRoleSettingSchema.extend({ requestedReasoningEffort: z.literal("high") }).strict(),
}).strict();

export const EXP0001A_CODEX_FROZEN_ROLE_SETTINGS = Object.freeze({
  subscription_probe: Object.freeze({ requestedModel: "gpt-5.6-sol", requestedReasoningEffort: "low" }),
  spike_author: Object.freeze({ requestedModel: "gpt-5.6-sol", requestedReasoningEffort: "max" }),
  author: Object.freeze({ requestedModel: "gpt-5.6-sol", requestedReasoningEffort: "max" }),
  primary_reviewer: Object.freeze({ requestedModel: "gpt-5.6-sol", requestedReasoningEffort: "high" }),
  adjudicator: Object.freeze({ requestedModel: "gpt-5.6-sol", requestedReasoningEffort: "high" }),
  pairwise_visual_judge: Object.freeze({ requestedModel: "gpt-5.6-sol", requestedReasoningEffort: "high" }),
} as const);

export const exp0001aCodexTaskStateSchema = z.enum(["begun", "completed", "terminal"]);
export const exp0001aCodexTerminalOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "usage_limit_interrupted",
  "infra_failure",
  "policy_violation",
]);
export type Exp0001aCodexTerminalOutcome = z.infer<typeof exp0001aCodexTerminalOutcomeSchema>;

const usageLimitInterruptionSchema = z.object({
  observedAt: timestampSchema,
  phase: z.enum(["task_creation", "task_execution", "task_wait", "artifact_collection"]),
  evidenceDigest: digestSchema,
}).strict();

const taskIsolationSchema = z.object({
  workspace: z.literal("projectless"),
  repositoryAccess: z.literal(false),
  privateApiAccess: z.literal(false),
  sharedHistory: z.literal(false),
  forkedFromAnotherTask: z.literal(false),
  preparedCoordinates: z.literal(false),
  evaluatorContext: z.literal(false),
}).strict();

export const exp0001aCodexTaskAccountingSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_TASK_ACCOUNTING_VERSION),
  protocolId: z.literal("EXP-0001A"),
  accountingId: idSchema,
  assignmentId: idSchema,
  attemptId: idSchema,
  role: exp0001aCodexTaskRoleSchema,
  codexTaskId: idSchema,
  threadId: idSchema,
  hostId: idSchema.or(z.literal(UNOBSERVABLE)),
  isolation: taskIsolationSchema,
  requestedModel: z.string().trim().min(1).max(160),
  requestedReasoningEffort: z.string().trim().min(1).max(40),
  resolvedModelSnapshot: observableStringSchema,
  inputTokens: observableCountSchema,
  outputTokens: observableCountSchema,
  totalTokens: observableCountSchema,
  chatGptCredits: observableCreditSchema,
  subscriptionUsage: observableSubscriptionUsageSchema,
  begunAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  terminalAt: timestampSchema.nullable(),
  state: exp0001aCodexTaskStateSchema,
  terminalOutcome: exp0001aCodexTerminalOutcomeSchema.nullable(),
  terminalReasonCode: idSchema.nullable(),
  wallTimeMs: nonNegativeIntegerSchema,
  webMcp: z.object({
    callCount: observableCountSchema,
    failureCount: observableCountSchema,
  }).strict(),
  canvas: z.object({
    revisionCount: observableCountSchema,
    inspectionCount: observableCountSchema,
  }).strict(),
  usageLimitInterruptions: z.array(usageLimitInterruptionSchema),
}).strict().superRefine((record, context) => {
  const begunMs = Date.parse(record.begunAt);
  if (record.completedAt !== null && Date.parse(record.completedAt) < begunMs) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Completion cannot precede task start." });
  }
  if (record.terminalAt !== null && Date.parse(record.terminalAt) < begunMs) {
    context.addIssue({ code: "custom", path: ["terminalAt"], message: "Terminal time cannot precede task start." });
  }
  if (record.completedAt !== null && record.terminalAt !== null
      && Date.parse(record.terminalAt) < Date.parse(record.completedAt)) {
    context.addIssue({ code: "custom", path: ["terminalAt"], message: "Terminal time cannot precede completion." });
  }
  if (record.webMcp.failureCount !== UNOBSERVABLE && record.webMcp.callCount !== UNOBSERVABLE
      && record.webMcp.failureCount.value > record.webMcp.callCount.value) {
    context.addIssue({ code: "custom", path: ["webMcp", "failureCount"], message: "WebMCP failures cannot exceed calls." });
  }
  if (record.state === "begun"
      && (record.completedAt !== null || record.terminalAt !== null
        || record.terminalOutcome !== null || record.terminalReasonCode !== null)) {
    context.addIssue({ code: "custom", message: "A begun task cannot claim completion or a terminal result." });
  }
  if (record.state === "begun" && record.wallTimeMs !== 0) {
    context.addIssue({ code: "custom", path: ["wallTimeMs"], message: "A newly begun retained task has zero finalized wall time." });
  }
  if (record.state === "completed"
      && (record.completedAt === null || record.terminalAt !== null
        || record.terminalOutcome !== null || record.terminalReasonCode !== null)) {
    context.addIssue({ code: "custom", message: "A completed task requires completion time and cannot yet claim terminal retention." });
  }
  if (record.state === "terminal"
      && (record.terminalAt === null || record.terminalOutcome === null || record.terminalReasonCode === null)) {
    context.addIssue({ code: "custom", message: "A terminal task requires terminal time, outcome, and reason code." });
  }
  if (record.state === "terminal" && record.terminalOutcome === "succeeded" && record.completedAt === null) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "A successful terminal task must first complete." });
  }
  if (record.terminalOutcome === "usage_limit_interrupted" && record.usageLimitInterruptions.length === 0) {
    context.addIssue({ code: "custom", path: ["usageLimitInterruptions"], message: "Usage-limit termination requires a retained interruption." });
  }
  if (record.usageLimitInterruptions.length > 1) {
    context.addIssue({ code: "custom", path: ["usageLimitInterruptions"], message: "A fresh Codex task can encounter at most one terminal usage-limit interruption." });
  }
  if (record.usageLimitInterruptions.length > 0 && record.terminalOutcome !== "usage_limit_interrupted") {
    context.addIssue({ code: "custom", path: ["usageLimitInterruptions"], message: "A retained task interruption must be the task's terminal outcome." });
  }
  if (record.terminalOutcome === "usage_limit_interrupted"
      && record.terminalAt !== record.usageLimitInterruptions[0]?.observedAt) {
    context.addIssue({ code: "custom", path: ["terminalAt"], message: "Usage-limit terminal time must match its retained observation." });
  }
  if (record.inputTokens !== UNOBSERVABLE && record.outputTokens !== UNOBSERVABLE
      && record.totalTokens !== UNOBSERVABLE
      && record.totalTokens.value !== record.inputTokens.value + record.outputTokens.value) {
    context.addIssue({ code: "custom", path: ["totalTokens"], message: "Observed total tokens must equal observed input plus output tokens." });
  }
  const endAt = record.terminalAt ?? record.completedAt;
  if (endAt !== null && record.wallTimeMs !== Date.parse(endAt) - begunMs) {
    context.addIssue({ code: "custom", path: ["wallTimeMs"], message: "Wall time must exactly match retained task timestamps." });
  }
  const observableFields = [
    ["resolvedModelSnapshot", record.resolvedModelSnapshot],
    ["inputTokens", record.inputTokens],
    ["outputTokens", record.outputTokens],
    ["totalTokens", record.totalTokens],
    ["chatGptCredits", record.chatGptCredits],
    ["subscriptionUsage", record.subscriptionUsage],
    ["webMcp.callCount", record.webMcp.callCount],
    ["webMcp.failureCount", record.webMcp.failureCount],
    ["canvas.revisionCount", record.canvas.revisionCount],
    ["canvas.inspectionCount", record.canvas.inspectionCount],
  ] as const;
  for (const [field, observation] of observableFields) {
    if (observation === UNOBSERVABLE) continue;
    const observedMs = Date.parse(observation.observedAt);
    if (observedMs < begunMs || (endAt !== null && observedMs > Date.parse(endAt))) {
      context.addIssue({ code: "custom", path: [field, "observedAt"],
        message: "Observed telemetry must fall within the retained task lifetime." });
    }
  }
});

export type Exp0001aCodexTaskAccounting = z.infer<typeof exp0001aCodexTaskAccountingSchema>;

export type BeginExp0001aCodexTaskInput = Omit<
  Exp0001aCodexTaskAccounting,
  "schemaVersion" | "protocolId" | "state" | "completedAt" | "terminalAt"
  | "terminalOutcome" | "terminalReasonCode" | "wallTimeMs" | "webMcp" | "canvas" | "usageLimitInterruptions"
  | "resolvedModelSnapshot" | "inputTokens" | "outputTokens" | "totalTokens"
  | "chatGptCredits" | "subscriptionUsage"
>;

export function beginExp0001aCodexTask(input: BeginExp0001aCodexTaskInput): Exp0001aCodexTaskAccounting {
  return exp0001aCodexTaskAccountingSchema.parse({
    ...input,
    schemaVersion: EXP0001A_CODEX_TASK_ACCOUNTING_VERSION,
    protocolId: "EXP-0001A",
    state: "begun",
    completedAt: null,
    terminalAt: null,
    terminalOutcome: null,
    terminalReasonCode: null,
    resolvedModelSnapshot: UNOBSERVABLE,
    inputTokens: UNOBSERVABLE,
    outputTokens: UNOBSERVABLE,
    totalTokens: UNOBSERVABLE,
    chatGptCredits: UNOBSERVABLE,
    subscriptionUsage: UNOBSERVABLE,
    wallTimeMs: 0,
    webMcp: { callCount: UNOBSERVABLE, failureCount: UNOBSERVABLE },
    canvas: { revisionCount: UNOBSERVABLE, inspectionCount: UNOBSERVABLE },
    usageLimitInterruptions: [],
  });
}

export function recordExp0001aCodexTaskActivity(
  _current: Exp0001aCodexTaskAccounting,
  _activity: Readonly<{
    webMcpCalls?: number;
    webMcpFailures?: number;
    revisions?: number;
    inspections?: number;
  }>,
): Exp0001aCodexTaskAccounting {
  throw new Error("CODEX_TASK_ACTIVITY_CALLER_INCREMENT_RETIRED");
}

const codexTaskObservabilityPatchSchema = z.object({
  resolvedModelSnapshot: observableStringSchema.optional(),
  inputTokens: observableCountSchema.optional(),
  outputTokens: observableCountSchema.optional(),
  totalTokens: observableCountSchema.optional(),
  chatGptCredits: observableCreditSchema.optional(),
  subscriptionUsage: observableSubscriptionUsageSchema.optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "At least one observability field is required.");

export type Exp0001aCodexTaskObservabilityPatch = z.infer<typeof codexTaskObservabilityPatchSchema>;

export function recordExp0001aCodexTaskObservability(
  current: Exp0001aCodexTaskAccounting,
  patch: Exp0001aCodexTaskObservabilityPatch,
): Exp0001aCodexTaskAccounting {
  const record = exp0001aCodexTaskAccountingSchema.parse(current);
  if (record.state === "terminal") throw new Error("CODEX_TASK_OBSERVABILITY_AFTER_TERMINAL_RETENTION");
  const parsedPatch = codexTaskObservabilityPatchSchema.parse(patch);
  const collectedAt = Date.now();
  for (const [field, next] of Object.entries(parsedPatch) as Array<[
    keyof Exp0001aCodexTaskObservabilityPatch,
    NonNullable<Exp0001aCodexTaskObservabilityPatch[keyof Exp0001aCodexTaskObservabilityPatch]>,
  ]>) {
    const prior = record[field];
    if (prior !== UNOBSERVABLE && hashCanonicalJson(prior) !== hashCanonicalJson(next)) {
      throw new Error(`CODEX_TASK_OBSERVABILITY_REWRITE_FORBIDDEN:${field}`);
    }
    if (prior !== UNOBSERVABLE && next === UNOBSERVABLE) {
      throw new Error(`CODEX_TASK_OBSERVABILITY_DOWNGRADE_FORBIDDEN:${field}`);
    }
    if (next !== UNOBSERVABLE) {
      const observedAt = Date.parse(next.observedAt);
      const retainedEnd = record.terminalAt ?? record.completedAt;
      if (observedAt < Date.parse(record.begunAt)
          || observedAt > collectedAt
          || (retainedEnd !== null && observedAt > Date.parse(retainedEnd))) {
        throw new Error(`CODEX_TASK_OBSERVABILITY_TIME_INVALID:${field}`);
      }
    }
  }
  return exp0001aCodexTaskAccountingSchema.parse({
    ...record,
    ...parsedPatch,
  });
}

export function completeExp0001aCodexTask(
  current: Exp0001aCodexTaskAccounting,
  completedAt: string,
): Exp0001aCodexTaskAccounting {
  const record = exp0001aCodexTaskAccountingSchema.parse(current);
  if (record.state !== "begun") throw new Error("CODEX_TASK_CANNOT_COMPLETE_FROM_CURRENT_STATE");
  timestampSchema.parse(completedAt);
  return exp0001aCodexTaskAccountingSchema.parse({
    ...record,
    state: "completed",
    completedAt,
    wallTimeMs: Date.parse(completedAt) - Date.parse(record.begunAt),
  });
}

export function terminateExp0001aCodexTask(
  current: Exp0001aCodexTaskAccounting,
  input: Readonly<{
    terminalAt: string;
    outcome: Exclude<Exp0001aCodexTerminalOutcome, "usage_limit_interrupted">;
    reasonCode: string;
  }>,
): Exp0001aCodexTaskAccounting {
  const record = exp0001aCodexTaskAccountingSchema.parse(current);
  if (record.state === "terminal") throw new Error("CODEX_TASK_ALREADY_TERMINAL");
  if (input.outcome === "succeeded" && record.state !== "completed") {
    throw new Error("CODEX_TASK_SUCCESS_REQUIRES_COMPLETION");
  }
  timestampSchema.parse(input.terminalAt);
  return exp0001aCodexTaskAccountingSchema.parse({
    ...record,
    state: "terminal",
    terminalAt: input.terminalAt,
    terminalOutcome: input.outcome,
    terminalReasonCode: input.reasonCode,
    wallTimeMs: Date.parse(input.terminalAt) - Date.parse(record.begunAt),
  });
}

export function interruptExp0001aCodexTaskForUsageLimit(
  current: Exp0001aCodexTaskAccounting,
  input: Readonly<{
    observedAt: string;
    phase: z.infer<typeof usageLimitInterruptionSchema>["phase"];
    evidenceDigest: string;
    reasonCode: string;
  }>,
): Exp0001aCodexTaskAccounting {
  const record = exp0001aCodexTaskAccountingSchema.parse(current);
  if (record.state === "terminal") throw new Error("CODEX_USAGE_LIMIT_REQUIRES_NONTERMINAL_TASK");
  const interruption = usageLimitInterruptionSchema.parse({
    observedAt: input.observedAt,
    phase: input.phase,
    evidenceDigest: input.evidenceDigest,
  });
  return exp0001aCodexTaskAccountingSchema.parse({
    ...record,
    state: "terminal",
    completedAt: record.completedAt,
    terminalAt: interruption.observedAt,
    terminalOutcome: "usage_limit_interrupted",
    terminalReasonCode: idSchema.parse(input.reasonCode),
    wallTimeMs: Date.parse(interruption.observedAt) - Date.parse(record.begunAt),
    usageLimitInterruptions: [...record.usageLimitInterruptions, interruption],
  });
}

export const exp0001aCodexAccountingLedgerSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-accounting-ledger/v1"),
  protocolId: z.literal("EXP-0001A"),
  frozenRoleSettings: exp0001aCodexFrozenRoleSettingsSchema,
  tasks: z.array(exp0001aCodexTaskAccountingSchema),
}).strict().superRefine((ledger, context) => {
  const uniqueFields: Array<["accountingId" | "assignmentId" | "attemptId" | "codexTaskId" | "threadId", Set<string>]> = [
    ["accountingId", new Set()],
    ["assignmentId", new Set()],
    ["attemptId", new Set()],
    ["codexTaskId", new Set()],
    ["threadId", new Set()],
  ];
  ledger.tasks.forEach((task, index) => {
    for (const [field, values] of uniqueFields) {
      if (values.has(task[field])) {
        context.addIssue({ code: "custom", path: ["tasks", index, field], message: `${field} must be unique across fresh Codex tasks.` });
      }
      values.add(task[field]);
    }
    const roleSetting = ledger.frozenRoleSettings[task.role];
    if (task.requestedModel !== roleSetting.requestedModel) {
      context.addIssue({ code: "custom", path: ["tasks", index, "requestedModel"], message: "Requested model differs from the frozen setting." });
    }
    if (task.requestedReasoningEffort !== roleSetting.requestedReasoningEffort) {
      context.addIssue({ code: "custom", path: ["tasks", index, "requestedReasoningEffort"], message: "Requested reasoning differs from the frozen setting." });
    }
  });
});

export type Exp0001aCodexAccountingLedger = z.infer<typeof exp0001aCodexAccountingLedgerSchema>;

/**
 * Applies a trusted wall-clock bound to an otherwise structurally valid retained
 * ledger. Zod deliberately cannot know the verifier's clock; every release and
 * completion boundary must call this verifier instead of accepting a parsed
 * snapshot as temporal authority.
 */
export function verifyExp0001aCodexAccountingLedgerAsOf(
  value: Exp0001aCodexAccountingLedger,
  checkedAt: string,
): Exp0001aCodexAccountingLedger {
  const ledger = exp0001aCodexAccountingLedgerSchema.parse(value);
  const checkedAtMs = Date.parse(timestampSchema.parse(checkedAt));
  const assertNotFuture = (candidate: string | null, label: string): void => {
    if (candidate !== null && Date.parse(candidate) > checkedAtMs) {
      throw new Error(`EXP0001A_CODEX_ACCOUNTING_FUTURE_EVIDENCE:${label}`);
    }
  };
  for (const task of ledger.tasks) {
    assertNotFuture(task.begunAt, `${task.accountingId}:begunAt`);
    assertNotFuture(task.completedAt, `${task.accountingId}:completedAt`);
    assertNotFuture(task.terminalAt, `${task.accountingId}:terminalAt`);
    for (const interruption of task.usageLimitInterruptions) {
      assertNotFuture(interruption.observedAt, `${task.accountingId}:usageLimitInterruption`);
    }
    const observableFields = [
      ["resolvedModelSnapshot", task.resolvedModelSnapshot],
      ["inputTokens", task.inputTokens],
      ["outputTokens", task.outputTokens],
      ["totalTokens", task.totalTokens],
      ["chatGptCredits", task.chatGptCredits],
      ["subscriptionUsage", task.subscriptionUsage],
      ["webMcp.callCount", task.webMcp.callCount],
      ["webMcp.failureCount", task.webMcp.failureCount],
      ["canvas.revisionCount", task.canvas.revisionCount],
      ["canvas.inspectionCount", task.canvas.inspectionCount],
    ] as const;
    for (const [field, observation] of observableFields) {
      if (observation !== UNOBSERVABLE) {
        assertNotFuture(observation.observedAt, `${task.accountingId}:${field}`);
      }
    }
  }
  return Object.freeze(ledger);
}

export type Exp0001aCodexAccountingSummary = Readonly<{
  codexTaskCount: number;
  begunTaskCount: number;
  completedTaskCount: number;
  terminalTaskCount: number;
  totalWallTimeMs: number;
  webMcpCallCount: ObservableAggregate;
  webMcpFailureCount: ObservableAggregate;
  revisionCount: ObservableAggregate;
  inspectionCount: ObservableAggregate;
  usageLimitInterruptionCount: number;
  unobservableResolvedModelCount: number;
  unobservableInputTokenCount: number;
  unobservableOutputTokenCount: number;
  unobservableTotalTokenCount: number;
  unobservableCreditCount: number;
  unobservableSubscriptionUsageCount: number;
  roleTaskCounts: Record<Exp0001aCodexTaskRole, number>;
}>;

export type ObservableAggregate = Readonly<{
  observedTotal: number;
  observedTaskCount: number;
  unobservableTaskCount: number;
}>;

function summarizeObservableCounts(values: readonly ObservableCount[]): ObservableAggregate {
  const observed = values.filter((value): value is Exclude<ObservableCount, typeof UNOBSERVABLE> => value !== UNOBSERVABLE);
  return Object.freeze({
    observedTotal: observed.reduce((total, observation) => total + observation.value, 0),
    observedTaskCount: observed.length,
    unobservableTaskCount: values.length - observed.length,
  });
}

export function summarizeExp0001aCodexAccounting(
  value: Exp0001aCodexAccountingLedger,
): Exp0001aCodexAccountingSummary {
  const ledger = exp0001aCodexAccountingLedgerSchema.parse(value);
  const roleTaskCounts: Record<Exp0001aCodexTaskRole, number> = {
    subscription_probe: 0,
    spike_author: 0,
    author: 0,
    primary_reviewer: 0,
    adjudicator: 0,
    pairwise_visual_judge: 0,
  };
  for (const task of ledger.tasks) roleTaskCounts[task.role] += 1;
  return {
    codexTaskCount: ledger.tasks.length,
    begunTaskCount: ledger.tasks.length,
    completedTaskCount: ledger.tasks.filter((task) => task.completedAt !== null).length,
    terminalTaskCount: ledger.tasks.filter((task) => task.state === "terminal").length,
    totalWallTimeMs: ledger.tasks.reduce((sum, task) => sum + task.wallTimeMs, 0),
    webMcpCallCount: summarizeObservableCounts(ledger.tasks.map((task) => task.webMcp.callCount)),
    webMcpFailureCount: summarizeObservableCounts(ledger.tasks.map((task) => task.webMcp.failureCount)),
    revisionCount: summarizeObservableCounts(ledger.tasks.map((task) => task.canvas.revisionCount)),
    inspectionCount: summarizeObservableCounts(ledger.tasks.map((task) => task.canvas.inspectionCount)),
    usageLimitInterruptionCount: ledger.tasks.reduce((sum, task) => sum + task.usageLimitInterruptions.length, 0),
    unobservableResolvedModelCount: ledger.tasks.filter((task) => task.resolvedModelSnapshot === UNOBSERVABLE).length,
    unobservableInputTokenCount: ledger.tasks.filter((task) => task.inputTokens === UNOBSERVABLE).length,
    unobservableOutputTokenCount: ledger.tasks.filter((task) => task.outputTokens === UNOBSERVABLE).length,
    unobservableTotalTokenCount: ledger.tasks.filter((task) => task.totalTokens === UNOBSERVABLE).length,
    unobservableCreditCount: ledger.tasks.filter((task) => task.chatGptCredits === UNOBSERVABLE).length,
    unobservableSubscriptionUsageCount: ledger.tasks.filter((task) => task.subscriptionUsage === UNOBSERVABLE).length,
    roleTaskCounts,
  };
}

export const exp0001aOpaqueConditionSchema = z.enum(["A0", "A1"]);
export type Exp0001aOpaqueCondition = z.infer<typeof exp0001aOpaqueConditionSchema>;

const frozenAssignmentSchema = z.object({
  assignmentId: idSchema,
  attemptId: idSchema,
  pairId: idSchema,
  condition: exp0001aOpaqueConditionSchema,
  plannedIndex: nonNegativeIntegerSchema,
  timeBlock: nonNegativeIntegerSchema,
  orderInPair: z.union([z.literal(0), z.literal(1)]),
}).strict();
export type Exp0001aFrozenCodexAssignment = z.infer<typeof frozenAssignmentSchema>;

export function computeExp0001aCodexScheduleDigest(
  assignments: readonly Exp0001aFrozenCodexAssignment[],
): string {
  const parsed = z.array(frozenAssignmentSchema).parse(assignments);
  return hashCanonicalJson({
    schemaVersion: "exp-0001a-codex-frozen-schedule/v1",
    protocolId: "EXP-0001A",
    assignments: parsed,
  });
}

const schedulerAssignmentSchema = frozenAssignmentSchema.extend({
  state: z.enum(["unstarted", "begun", "completed", "terminal"]),
  usageWindow: nonNegativeIntegerSchema.nullable(),
  begunAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
  terminalAt: timestampSchema.nullable(),
  terminalOutcome: exp0001aCodexTerminalOutcomeSchema.nullable(),
  codexTaskId: idSchema.nullable(),
  threadId: idSchema.nullable(),
}).strict();
export type Exp0001aScheduledCodexAssignment = z.infer<typeof schedulerAssignmentSchema>;

const schedulerUsageInterruptionSchema = z.object({
  observedAt: timestampSchema,
  usageWindow: nonNegativeIntegerSchema,
  affectedAssignmentId: idSchema.nullable(),
  affectedTask: z.object({
    role: exp0001aCodexTaskRoleSchema,
    assignmentId: idSchema,
    attemptId: idSchema,
    planDigest: digestSchema,
    transportId: idSchema,
    taskBegun: z.boolean(),
  }).strict().nullable(),
  evidenceDigest: digestSchema,
}).strict();

export const EXP0001A_SUBSCRIPTION_PROBE_PROMPT =
  "Availability probe only. Do not open Jazzboard, access a repository, or perform experiment work. Return exactly SUBSCRIPTION_AVAILABLE." as const;
export const EXP0001A_SUBSCRIPTION_PROBE_PROMPT_DIGEST = hashCanonicalJson(EXP0001A_SUBSCRIPTION_PROBE_PROMPT);

const chatGptUsageResetObservationContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-chatgpt-usage-reset-observation/v1"),
  kind: z.literal("chatgpt-usage-reset-observation"),
  observationId: idSchema,
  observedAt: timestampSchema,
  resumedAt: timestampSchema,
  priorUsageWindow: nonNegativeIntegerSchema,
  nextUsageWindow: z.number().int().positive(),
  source: z.literal("codex_app_host"),
  resetState: z.literal("availability_probe_succeeded"),
  priorInterruptionDigest: digestSchema,
  subscriptionUsageBefore: observableSubscriptionUsageSchema,
  subscriptionUsageAfter: observableSubscriptionUsageSchema,
  probe: z.object({
    role: z.literal("subscription_probe"),
    neutralPromptDigest: z.literal(EXP0001A_SUBSCRIPTION_PROBE_PROMPT_DIGEST),
    benchmarkContentIncluded: z.literal(false),
    accountingId: idSchema,
    accountingRecordDigest: digestSchema,
    codexTaskId: idSchema,
    threadId: idSchema,
    hostId: idSchema,
    createThreadRawOutputDigest: digestSchema,
    terminalRawOutputDigest: digestSchema,
  }).strict(),
}).strict().superRefine((observation, context) => {
  if (observation.nextUsageWindow !== observation.priorUsageWindow + 1) {
    context.addIssue({ code: "custom", path: ["nextUsageWindow"], message: "Usage reset must advance exactly one window." });
  }
  if (Date.parse(observation.resumedAt) < Date.parse(observation.observedAt)) {
    context.addIssue({ code: "custom", path: ["resumedAt"], message: "Resume cannot precede the host observation." });
  }
  if (observation.probe.codexTaskId !== observation.probe.threadId) {
    context.addIssue({ code: "custom", path: ["probe", "threadId"], message: "Availability probe task/thread IDs must match." });
  }
});

export const exp0001aChatGptUsageResetObservationSchema = chatGptUsageResetObservationContentSchema.extend({
  authoritySignature: exp0001aCodexAuthoritySignatureSchema,
}).strict();
export type Exp0001aChatGptUsageResetObservation = z.infer<typeof exp0001aChatGptUsageResetObservationSchema>;

const schedulerUsageResetSchema = exp0001aChatGptUsageResetObservationSchema;

const schedulerPauseSchema = schedulerUsageInterruptionSchema.extend({
  reason: z.literal("usage_limit"),
}).strict();

export const exp0001aCodexSchedulerStateSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_SCHEDULER_VERSION),
  protocolId: z.literal("EXP-0001A"),
  frozenScheduleDigest: digestSchema,
  currentUsageWindow: nonNegativeIntegerSchema,
  pause: schedulerPauseSchema.nullable(),
  usageLimitInterruptions: z.array(schedulerUsageInterruptionSchema),
  usageResets: z.array(schedulerUsageResetSchema),
  assignments: z.array(schedulerAssignmentSchema).min(2),
}).strict().superRefine((state, context) => {
  const assignmentIds = new Set<string>();
  const attemptIds = new Set<string>();
  const taskIds = new Set<string>();
  const threadIds = new Set<string>();
  let encounteredUnstarted = false;
  let activeCount = 0;
  let previousTerminalAt: string | null = null;
  state.assignments.forEach((assignment, index) => {
    if (assignment.plannedIndex !== index) {
      context.addIssue({ code: "custom", path: ["assignments", index, "plannedIndex"], message: "Planned indexes must be contiguous and retained in frozen order." });
    }
    if (assignmentIds.has(assignment.assignmentId)) context.addIssue({ code: "custom", path: ["assignments", index, "assignmentId"], message: "Assignment IDs must be unique." });
    if (attemptIds.has(assignment.attemptId)) context.addIssue({ code: "custom", path: ["assignments", index, "attemptId"], message: "Attempt IDs must be unique." });
    assignmentIds.add(assignment.assignmentId);
    attemptIds.add(assignment.attemptId);
    if (assignment.state === "unstarted") encounteredUnstarted = true;
    else if (encounteredUnstarted) context.addIssue({ code: "custom", path: ["assignments", index, "state"], message: "Begun assignments must remain a contiguous frozen-order prefix." });
    if (assignment.state === "begun" || assignment.state === "completed") activeCount += 1;
    const identityIsNull = assignment.codexTaskId === null && assignment.threadId === null;
    const timestampsAreNull = assignment.usageWindow === null && assignment.begunAt === null
      && assignment.completedAt === null && assignment.terminalAt === null && assignment.terminalOutcome === null;
    if (assignment.state === "unstarted" && (!identityIsNull || !timestampsAreNull)) {
      context.addIssue({ code: "custom", path: ["assignments", index], message: "An unstarted assignment cannot carry task identity, timestamps, or outcome." });
    }
    if (assignment.state !== "unstarted") {
      if (assignment.usageWindow === null || assignment.usageWindow > state.currentUsageWindow
          || assignment.begunAt === null || assignment.codexTaskId === null || assignment.threadId === null) {
        context.addIssue({ code: "custom", path: ["assignments", index], message: "A begun assignment requires retained identity, start time, and a valid usage window." });
      }
      if (assignment.codexTaskId !== null) {
        if (taskIds.has(assignment.codexTaskId)) context.addIssue({ code: "custom", path: ["assignments", index, "codexTaskId"], message: "Every assignment requires a fresh Codex task." });
        taskIds.add(assignment.codexTaskId);
      }
      if (assignment.threadId !== null) {
        if (threadIds.has(assignment.threadId)) context.addIssue({ code: "custom", path: ["assignments", index, "threadId"], message: "Every assignment requires a fresh Codex thread." });
        threadIds.add(assignment.threadId);
      }
      if (previousTerminalAt !== null && Date.parse(assignment.begunAt!) < Date.parse(previousTerminalAt)) {
        context.addIssue({ code: "custom", path: ["assignments", index, "begunAt"], message: "A later frozen assignment cannot begin before its predecessor became terminal." });
      }
      const reset = assignment.usageWindow === 0 ? null : state.usageResets[assignment.usageWindow! - 1];
      if (assignment.usageWindow! > 0 && (!reset || Date.parse(assignment.begunAt!) < Date.parse(reset.resumedAt))) {
        context.addIssue({ code: "custom", path: ["assignments", index, "begunAt"], message: "Assignment cannot begin in a usage window before its retained reset." });
      }
    }
    if (assignment.state === "begun" && (assignment.completedAt !== null || assignment.terminalAt !== null || assignment.terminalOutcome !== null)) {
      context.addIssue({ code: "custom", path: ["assignments", index], message: "A begun assignment cannot claim completion or terminal state." });
    }
    if (assignment.state === "completed" && (assignment.completedAt === null || assignment.terminalAt !== null || assignment.terminalOutcome !== null)) {
      context.addIssue({ code: "custom", path: ["assignments", index], message: "A completed assignment requires completion and cannot claim terminal state." });
    }
    if (assignment.state === "terminal" && (assignment.terminalAt === null || assignment.terminalOutcome === null)) {
      context.addIssue({ code: "custom", path: ["assignments", index], message: "A terminal assignment requires a retained terminal result." });
    }
    if (assignment.state === "terminal" && assignment.terminalOutcome === "succeeded" && assignment.completedAt === null) {
      context.addIssue({ code: "custom", path: ["assignments", index, "completedAt"], message: "A successful terminal assignment must first complete." });
    }
    if (assignment.begunAt !== null && assignment.completedAt !== null
        && Date.parse(assignment.completedAt) < Date.parse(assignment.begunAt)) {
      context.addIssue({ code: "custom", path: ["assignments", index, "completedAt"], message: "Assignment completion cannot precede release." });
    }
    if (assignment.begunAt !== null && assignment.terminalAt !== null
        && Date.parse(assignment.terminalAt) < Date.parse(assignment.completedAt ?? assignment.begunAt)) {
      context.addIssue({ code: "custom", path: ["assignments", index, "terminalAt"], message: "Assignment terminal time cannot precede its active state." });
    }
    if (assignment.terminalAt !== null) previousTerminalAt = assignment.terminalAt;
  });
  if (activeCount > 1) context.addIssue({ code: "custom", path: ["assignments"], message: "Only one assignment may be active." });
  const frozen = state.assignments.map((assignment) => frozenAssignmentSchema.parse({
    assignmentId: assignment.assignmentId,
    attemptId: assignment.attemptId,
    pairId: assignment.pairId,
    condition: assignment.condition,
    plannedIndex: assignment.plannedIndex,
    timeBlock: assignment.timeBlock,
    orderInPair: assignment.orderInPair,
  }));
  try {
    validateFrozenAssignments(frozen);
  } catch (error) {
    context.addIssue({ code: "custom", path: ["assignments"], message: error instanceof Error ? error.message : "Frozen schedule is invalid." });
  }
  if (state.frozenScheduleDigest !== computeExp0001aCodexScheduleDigest(frozen)) {
    context.addIssue({ code: "custom", path: ["frozenScheduleDigest"], message: "Frozen schedule commitment no longer matches assignment identity or order." });
  }
  state.usageLimitInterruptions.forEach((interruption, index) => {
    if (interruption.usageWindow !== index || interruption.usageWindow > state.currentUsageWindow) {
      context.addIssue({ code: "custom", path: ["usageLimitInterruptions", index, "usageWindow"], message: "Usage-limit windows must be monotonic and contiguous." });
    }
    if (interruption.affectedAssignmentId !== null && !assignmentIds.has(interruption.affectedAssignmentId)) {
      context.addIssue({ code: "custom", path: ["usageLimitInterruptions", index, "affectedAssignmentId"], message: "Usage-limit interruption references an unknown assignment." });
    }
    if (interruption.affectedTask?.role === "author"
        && interruption.affectedTask.assignmentId !== interruption.affectedAssignmentId) {
      context.addIssue({ code: "custom", path: ["usageLimitInterruptions", index, "affectedTask"], message: "Author interruption task must bind the affected frozen assignment." });
    }
    if (index > 0 && Date.parse(interruption.observedAt) < Date.parse(state.usageLimitInterruptions[index - 1].observedAt)) {
      context.addIssue({ code: "custom", path: ["usageLimitInterruptions", index, "observedAt"], message: "Usage-limit observations must be monotonic." });
    }
  });
  const expectedInterruptionCount = state.pause === null ? state.currentUsageWindow : state.currentUsageWindow + 1;
  if (state.usageLimitInterruptions.length !== expectedInterruptionCount) {
    context.addIssue({ code: "custom", path: ["usageLimitInterruptions"], message: "Usage-window index must be backed by exactly one retained interruption per reset." });
  }
  if (state.usageResets.length !== state.currentUsageWindow) {
    context.addIssue({ code: "custom", path: ["usageResets"], message: "Each resumed usage window requires exactly one retained reset observation." });
  }
  state.usageResets.forEach((reset, index) => {
    const interruption = state.usageLimitInterruptions[index];
    if (reset.priorUsageWindow !== index || reset.nextUsageWindow !== index + 1
        || !interruption || Date.parse(reset.resumedAt) < Date.parse(interruption.observedAt)) {
      context.addIssue({ code: "custom", path: ["usageResets", index], message: "Usage reset must monotonically advance the corresponding interrupted window." });
    }
  });
  if (state.pause !== null) {
    const latest = state.usageLimitInterruptions.at(-1);
    if (!latest || state.pause.observedAt !== latest.observedAt
        || state.pause.usageWindow !== latest.usageWindow
        || state.pause.affectedAssignmentId !== latest.affectedAssignmentId
        || hashCanonicalJson(state.pause.affectedTask) !== hashCanonicalJson(latest.affectedTask)
        || state.pause.evidenceDigest !== latest.evidenceDigest) {
      context.addIssue({ code: "custom", path: ["pause"], message: "Paused state must match the latest retained usage-limit interruption." });
    }
  }
  for (const assignment of state.assignments) {
    if (assignment.terminalOutcome !== "usage_limit_interrupted") continue;
    const matching = state.usageLimitInterruptions.find((interruption) => interruption.affectedAssignmentId === assignment.assignmentId);
    if (!matching || matching.observedAt !== assignment.terminalAt || matching.usageWindow !== assignment.usageWindow) {
      context.addIssue({ code: "custom", path: ["assignments", assignment.plannedIndex], message: "Interrupted terminal assignment must match retained usage-limit evidence." });
    }
  }
});

export type Exp0001aCodexSchedulerState = z.infer<typeof exp0001aCodexSchedulerStateSchema>;

/**
 * Re-establishes the authority and wall-clock chain of a retained scheduler.
 *
 * The Zod schema intentionally proves only structure.  In particular, a
 * caller can recompute a structurally valid scheduler snapshot after replacing
 * a nested usage-reset receipt.  Release and completion boundaries must call
 * this verifier with the retained accounting ledger so every reset is checked
 * against the fixed Ed25519 authority and the exact neutral probe task that
 * earned it.
 */
export function verifyExp0001aCodexSchedulerStateAsOf(input: Readonly<{
  scheduler: Exp0001aCodexSchedulerState;
  accountingLedger: Exp0001aCodexAccountingLedger;
  checkedAt: string;
}>): Exp0001aCodexSchedulerState {
  const scheduler = exp0001aCodexSchedulerStateSchema.parse(input.scheduler);
  const ledger = verifyExp0001aCodexAccountingLedgerAsOf(input.accountingLedger, input.checkedAt);
  const checkedAtMs = Date.parse(timestampSchema.parse(input.checkedAt));
  const assertNotFuture = (candidate: string | null, label: string): void => {
    if (candidate !== null && Date.parse(candidate) > checkedAtMs) {
      throw new Error(`EXP0001A_CODEX_SCHEDULER_FUTURE_EVIDENCE:${label}`);
    }
  };

  for (const assignment of scheduler.assignments) {
    assertNotFuture(assignment.begunAt, `${assignment.assignmentId}:begunAt`);
    assertNotFuture(assignment.completedAt, `${assignment.assignmentId}:completedAt`);
    assertNotFuture(assignment.terminalAt, `${assignment.assignmentId}:terminalAt`);
  }
  for (const interruption of scheduler.usageLimitInterruptions) {
    assertNotFuture(interruption.observedAt, `usage-window-${interruption.usageWindow}:interruption`);
  }
  if (scheduler.pause !== null) {
    assertNotFuture(scheduler.pause.observedAt, `usage-window-${scheduler.pause.usageWindow}:pause`);
  }

  const probes = ledger.tasks.filter((task) => task.role === "subscription_probe");
  const probesByAccountingId = new Map(probes.map((task) => [task.accountingId, task]));
  const boundProbeAccountingIds = new Set<string>();
  const boundProbeTaskIds = new Set<string>();
  const boundSignatures = new Set<string>();

  for (const [index, reset] of scheduler.usageResets.entries()) {
    const interruption = scheduler.usageLimitInterruptions[index];
    if (interruption === undefined
        || reset.priorUsageWindow !== index
        || reset.nextUsageWindow !== index + 1
        || reset.priorInterruptionDigest !== interruption.evidenceDigest) {
      throw new Error(`EXP0001A_CODEX_USAGE_RESET_INTERRUPTION_CHAIN_INVALID:${reset.observationId}`);
    }
    const probe = probesByAccountingId.get(reset.probe.accountingId);
    if (probe === undefined || probe.state !== "terminal" || probe.terminalOutcome !== "succeeded"
        || probe.terminalAt === null
        || probe.codexTaskId !== reset.probe.codexTaskId
        || probe.threadId !== reset.probe.threadId
        || probe.hostId === UNOBSERVABLE || probe.hostId !== reset.probe.hostId
        || hashCanonicalJson(probe) !== reset.probe.accountingRecordDigest) {
      throw new Error(`EXP0001A_CODEX_USAGE_RESET_PROBE_ACCOUNTING_BINDING_INVALID:${reset.observationId}`);
    }
    if (boundProbeAccountingIds.has(probe.accountingId)
        || boundProbeTaskIds.has(probe.codexTaskId)
        || boundSignatures.has(reset.authoritySignature.signatureBase64)) {
      throw new Error(`EXP0001A_CODEX_USAGE_RESET_PROBE_REUSED:${reset.observationId}`);
    }
    boundProbeAccountingIds.add(probe.accountingId);
    boundProbeTaskIds.add(probe.codexTaskId);
    boundSignatures.add(reset.authoritySignature.signatureBase64);

    const { authoritySignature: _authoritySignature, ...signedPayload } = reset;
    void _authoritySignature;
    const notBefore = [probe.terminalAt, interruption.observedAt, reset.observedAt]
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0]!;
    verifyExp0001aCodexAuthoritySignature({
      payload: signedPayload,
      signature: reset.authoritySignature,
      purpose: "usage_reset_probe",
      notBefore,
    });
    if (Date.parse(reset.observedAt) < Date.parse(probe.terminalAt)
        || Date.parse(reset.resumedAt) < Date.parse(reset.authoritySignature.signedAt)
        || Date.parse(reset.resumedAt) - Date.parse(reset.observedAt) > 5 * 60_000) {
      throw new Error(`EXP0001A_CODEX_USAGE_RESET_AUTHORITY_TIME_INVALID:${reset.observationId}`);
    }
    assertNotFuture(reset.observedAt, `${reset.observationId}:observedAt`);
    assertNotFuture(reset.authoritySignature.signedAt, `${reset.observationId}:signedAt`);
    assertNotFuture(reset.resumedAt, `${reset.observationId}:resumedAt`);
    for (const [label, usage] of [
      ["subscriptionUsageBefore", reset.subscriptionUsageBefore],
      ["subscriptionUsageAfter", reset.subscriptionUsageAfter],
    ] as const) {
      if (usage !== UNOBSERVABLE) {
        if (Date.parse(usage.observedAt) > Date.parse(reset.observedAt)) {
          throw new Error(`EXP0001A_CODEX_USAGE_RESET_OBSERVATION_TIME_INVALID:${reset.observationId}:${label}`);
        }
        assertNotFuture(usage.observedAt, `${reset.observationId}:${label}`);
      }
    }
  }

  const unboundSucceeded = probes.filter((probe) => probe.terminalOutcome === "succeeded"
    && !boundProbeAccountingIds.has(probe.accountingId));
  const activeUnbound = probes.filter((probe) => probe.state !== "terminal"
    && !boundProbeAccountingIds.has(probe.accountingId));
  if (unboundSucceeded.length > 1 || (unboundSucceeded.length === 1 && scheduler.pause === null)) {
    throw new Error("EXP0001A_CODEX_UNBOUND_SUCCESSFUL_USAGE_PROBE");
  }
  if (activeUnbound.length > 1 || (activeUnbound.length === 1 && scheduler.pause === null)) {
    throw new Error("EXP0001A_CODEX_UNBOUND_ACTIVE_USAGE_PROBE");
  }
  if (unboundSucceeded[0]?.terminalAt !== null && unboundSucceeded[0]?.terminalAt !== undefined
      && scheduler.pause !== null
      && Date.parse(unboundSucceeded[0].terminalAt) < Date.parse(scheduler.pause.observedAt)) {
    throw new Error("EXP0001A_CODEX_STALE_UNBOUND_SUCCESSFUL_USAGE_PROBE");
  }
  return Object.freeze(scheduler);
}

function validateFrozenAssignments(assignments: readonly Exp0001aFrozenCodexAssignment[]): Exp0001aFrozenCodexAssignment[] {
  const parsed = z.array(frozenAssignmentSchema).min(2).parse(assignments);
  const assignmentIds = new Set<string>();
  const attemptIds = new Set<string>();
  const pairs = new Map<string, Exp0001aFrozenCodexAssignment[]>();
  parsed.forEach((assignment, index) => {
    if (assignment.plannedIndex !== index) throw new Error("CODEX_SCHEDULE_INDEX_OR_ORDER_CHANGED");
    if (assignmentIds.has(assignment.assignmentId)) throw new Error("CODEX_SCHEDULE_DUPLICATE_ASSIGNMENT_ID");
    if (attemptIds.has(assignment.attemptId)) throw new Error("CODEX_SCHEDULE_DUPLICATE_ATTEMPT_ID");
    assignmentIds.add(assignment.assignmentId);
    attemptIds.add(assignment.attemptId);
    pairs.set(assignment.pairId, [...(pairs.get(assignment.pairId) ?? []), assignment]);
  });
  for (const [pairId, pair] of pairs) {
    const ordered = [...pair].sort((left, right) => left.orderInPair - right.orderInPair);
    if (ordered.length !== 2 || ordered[0].orderInPair !== 0 || ordered[1].orderInPair !== 1
        || ordered[0].condition === ordered[1].condition
        || ordered[0].timeBlock !== ordered[1].timeBlock
        || ordered[1].plannedIndex !== ordered[0].plannedIndex + 1) {
      throw new Error(`CODEX_SCHEDULE_PAIR_NOT_BALANCED:${pairId}`);
    }
  }
  let a0 = 0;
  let a1 = 0;
  for (const assignment of parsed) {
    if (assignment.condition === "A0") a0 += 1;
    else a1 += 1;
    if (Math.abs(a0 - a1) > 1) throw new Error("CODEX_SCHEDULE_PREFIX_NOT_BALANCED");
  }
  if (a0 !== a1) throw new Error("CODEX_SCHEDULE_TOTAL_NOT_BALANCED");
  return parsed;
}

export function createExp0001aCodexScheduler(
  assignments: readonly Exp0001aFrozenCodexAssignment[],
): Exp0001aCodexSchedulerState {
  const frozen = validateFrozenAssignments(assignments);
  return exp0001aCodexSchedulerStateSchema.parse({
    schemaVersion: EXP0001A_CODEX_SCHEDULER_VERSION,
    protocolId: "EXP-0001A",
    frozenScheduleDigest: computeExp0001aCodexScheduleDigest(frozen),
    currentUsageWindow: 0,
    pause: null,
    usageLimitInterruptions: [],
    usageResets: [],
    assignments: frozen.map((assignment) => ({
      ...assignment,
      state: "unstarted",
      usageWindow: null,
      begunAt: null,
      completedAt: null,
      terminalAt: null,
      terminalOutcome: null,
      codexTaskId: null,
      threadId: null,
    })),
  });
}

export type Exp0001aNextAssignment =
  | { kind: "paused"; pause: z.infer<typeof schedulerPauseSchema> }
  | { kind: "awaiting_terminal"; assignment: Exp0001aScheduledCodexAssignment }
  | { kind: "ready"; assignment: Exp0001aScheduledCodexAssignment }
  | { kind: "complete" };

export function nextExp0001aCodexAssignment(stateInput: Exp0001aCodexSchedulerState): Exp0001aNextAssignment {
  const state = exp0001aCodexSchedulerStateSchema.parse(stateInput);
  if (state.pause !== null) return { kind: "paused", pause: state.pause };
  const active = state.assignments.find((assignment) => assignment.state === "begun" || assignment.state === "completed");
  if (active) return { kind: "awaiting_terminal", assignment: active };
  const next = state.assignments.find((assignment) => assignment.state === "unstarted");
  return next ? { kind: "ready", assignment: next } : { kind: "complete" };
}

export function beginNextExp0001aCodexAssignment(
  stateInput: Exp0001aCodexSchedulerState,
  input: Readonly<{
    assignmentId: string;
    begunAt: string;
    codexTaskId: string;
    threadId: string;
    /** Retains the release window when an identity-pending create is only
     * discovered after a signed subscription reset. */
    usageWindow?: number;
  }>,
): Exp0001aCodexSchedulerState {
  const state = exp0001aCodexSchedulerStateSchema.parse(stateInput);
  const next = nextExp0001aCodexAssignment(state);
  if (next.kind === "paused") throw new Error("CODEX_SCHEDULE_PAUSED_FOR_USAGE_LIMIT");
  if (next.kind === "awaiting_terminal") throw new Error("CODEX_SCHEDULE_PREVIOUS_ATTEMPT_NOT_TERMINAL");
  if (next.kind === "complete") throw new Error("CODEX_SCHEDULE_COMPLETE");
  if (next.assignment.assignmentId !== input.assignmentId) throw new Error("CODEX_SCHEDULE_MUST_RELEASE_EXACT_NEXT_ASSIGNMENT");
  timestampSchema.parse(input.begunAt);
  idSchema.parse(input.codexTaskId);
  idSchema.parse(input.threadId);
  const usageWindow = input.usageWindow ?? state.currentUsageWindow;
  nonNegativeIntegerSchema.parse(usageWindow);
  if (usageWindow > state.currentUsageWindow) throw new Error("CODEX_SCHEDULE_BEGIN_USAGE_WINDOW_IN_FUTURE");
  return exp0001aCodexSchedulerStateSchema.parse({
    ...state,
    assignments: state.assignments.map((assignment) => assignment.assignmentId === input.assignmentId ? {
      ...assignment,
      state: "begun",
      usageWindow,
      begunAt: input.begunAt,
      codexTaskId: input.codexTaskId,
      threadId: input.threadId,
    } : assignment),
  });
}

export function completeActiveExp0001aCodexAssignment(
  stateInput: Exp0001aCodexSchedulerState,
  completedAt: string,
): Exp0001aCodexSchedulerState {
  const state = exp0001aCodexSchedulerStateSchema.parse(stateInput);
  const active = state.assignments.find((assignment) => assignment.state === "begun");
  if (!active) throw new Error("CODEX_SCHEDULE_HAS_NO_BEGUN_ASSIGNMENT");
  timestampSchema.parse(completedAt);
  if (Date.parse(completedAt) < Date.parse(active.begunAt!)) throw new Error("CODEX_SCHEDULE_COMPLETION_PRECEDES_BEGIN");
  return exp0001aCodexSchedulerStateSchema.parse({
    ...state,
    assignments: state.assignments.map((assignment) => assignment.assignmentId === active.assignmentId ? {
      ...assignment,
      state: "completed",
      completedAt,
    } : assignment),
  });
}

export function terminalizeActiveExp0001aCodexAssignment(
  stateInput: Exp0001aCodexSchedulerState,
  input: Readonly<{
    terminalAt: string;
    outcome: Exclude<Exp0001aCodexTerminalOutcome, "usage_limit_interrupted">;
  }>,
): Exp0001aCodexSchedulerState {
  const state = exp0001aCodexSchedulerStateSchema.parse(stateInput);
  const active = state.assignments.find((assignment) => assignment.state === "begun" || assignment.state === "completed");
  if (!active) throw new Error("CODEX_SCHEDULE_HAS_NO_ACTIVE_ASSIGNMENT");
  if (input.outcome === "succeeded" && active.state !== "completed") throw new Error("CODEX_SCHEDULE_SUCCESS_REQUIRES_COMPLETION");
  timestampSchema.parse(input.terminalAt);
  if (Date.parse(input.terminalAt) < Date.parse(active.completedAt ?? active.begunAt!)) {
    throw new Error("CODEX_SCHEDULE_TERMINAL_PRECEDES_ACTIVE_STATE");
  }
  return exp0001aCodexSchedulerStateSchema.parse({
    ...state,
    assignments: state.assignments.map((assignment) => assignment.assignmentId === active.assignmentId ? {
      ...assignment,
      state: "terminal",
      terminalAt: input.terminalAt,
      terminalOutcome: input.outcome,
    } : assignment),
  });
}

export function pauseExp0001aCodexSchedulerForUsageLimit(
  stateInput: Exp0001aCodexSchedulerState,
  input: Readonly<{
    observedAt: string;
    evidenceDigest: string;
    affectedTask?: Readonly<{
      role: Exp0001aCodexTaskRole;
      assignmentId: string;
      attemptId: string;
      planDigest: string;
      transportId: string;
      taskBegun: boolean;
    }> | null;
  }>,
): Exp0001aCodexSchedulerState {
  const state = exp0001aCodexSchedulerStateSchema.parse(stateInput);
  if (state.pause !== null) throw new Error("CODEX_SCHEDULE_ALREADY_PAUSED");
  timestampSchema.parse(input.observedAt);
  digestSchema.parse(input.evidenceDigest);
  const active = state.assignments.find((assignment) => assignment.state === "begun" || assignment.state === "completed");
  const nextUnstarted = state.assignments.find((assignment) => assignment.state === "unstarted");
  const authorAssignmentWithoutActiveTask = active === undefined && input.affectedTask?.role === "author"
    ? nextUnstarted : undefined;
  if (active === undefined && input.affectedTask?.role === "author" && authorAssignmentWithoutActiveTask === undefined) {
    throw new Error("CODEX_USAGE_LIMIT_AUTHOR_ASSIGNMENT_NOT_AVAILABLE");
  }
  if (authorAssignmentWithoutActiveTask !== undefined
      && (authorAssignmentWithoutActiveTask.assignmentId !== input.affectedTask?.assignmentId
        || authorAssignmentWithoutActiveTask.attemptId !== input.affectedTask.attemptId)) {
    throw new Error("CODEX_USAGE_LIMIT_AUTHOR_TASK_NOT_NEXT_FROZEN_ASSIGNMENT");
  }
  const interruption = schedulerUsageInterruptionSchema.parse({
    observedAt: input.observedAt,
    usageWindow: state.currentUsageWindow,
    affectedAssignmentId: active?.assignmentId ?? authorAssignmentWithoutActiveTask?.assignmentId ?? null,
    affectedTask: input.affectedTask ?? null,
    evidenceDigest: input.evidenceDigest,
  });
  return exp0001aCodexSchedulerStateSchema.parse({
    ...state,
    pause: { ...interruption, reason: "usage_limit" },
    usageLimitInterruptions: [...state.usageLimitInterruptions, interruption],
    assignments: state.assignments.map((assignment) => assignment.assignmentId === active?.assignmentId
      && (assignment.state === "begun" || assignment.state === "completed") ? {
        ...assignment,
        state: "terminal",
        terminalAt: input.observedAt,
        terminalOutcome: "usage_limit_interrupted",
      } : assignment),
  });
}

export function resumeExp0001aCodexSchedulerAfterUsageReset(
  stateInput: Exp0001aCodexSchedulerState,
  input: Readonly<{
    observation: Exp0001aChatGptUsageResetObservation;
    probeAccounting: Exp0001aCodexTaskAccounting;
  }>,
): Exp0001aCodexSchedulerState {
  const state = exp0001aCodexSchedulerStateSchema.parse(stateInput);
  if (state.pause === null) throw new Error("CODEX_SCHEDULE_IS_NOT_PAUSED");
  const reset = schedulerUsageResetSchema.parse(input.observation);
  const probe = exp0001aCodexTaskAccountingSchema.parse(input.probeAccounting);
  if (probe.role !== "subscription_probe" || probe.state !== "terminal" || probe.terminalOutcome !== "succeeded"
      || probe.accountingId !== reset.probe.accountingId
      || probe.codexTaskId !== reset.probe.codexTaskId || probe.threadId !== reset.probe.threadId
      || probe.hostId === UNOBSERVABLE || probe.hostId !== reset.probe.hostId
      || hashCanonicalJson(probe) !== reset.probe.accountingRecordDigest) {
    throw new Error("CODEX_USAGE_RESET_PROBE_ACCOUNTING_BINDING_INVALID");
  }
  const { authoritySignature: _authoritySignature, ...signedPayload } = reset;
  void _authoritySignature;
  verifyExp0001aCodexAuthoritySignature({
    payload: signedPayload,
    signature: reset.authoritySignature,
    purpose: "usage_reset_probe",
    notBefore: probe.terminalAt ?? state.pause.observedAt,
  });
  if (reset.priorUsageWindow !== state.currentUsageWindow
      || reset.nextUsageWindow !== state.currentUsageWindow + 1) {
    throw new Error("CODEX_USAGE_RESET_WINDOW_BINDING_INVALID");
  }
  if (reset.priorInterruptionDigest !== state.pause.evidenceDigest) {
    throw new Error("CODEX_USAGE_RESET_INTERRUPTION_BINDING_INVALID");
  }
  if (Date.parse(reset.resumedAt) < Date.parse(state.pause.observedAt)) throw new Error("CODEX_USAGE_RESET_PRECEDES_LIMIT");
  if (probe.terminalAt === null || Date.parse(reset.observedAt) < Date.parse(probe.terminalAt)
      || Date.parse(reset.authoritySignature.signedAt) < Date.parse(reset.observedAt)
      || Date.parse(reset.authoritySignature.signedAt) > Date.parse(reset.resumedAt)) {
    throw new Error("CODEX_USAGE_RESET_AUTHORITY_TIME_INVALID");
  }
  if (Date.parse(reset.resumedAt) - Date.parse(reset.observedAt) > 5 * 60_000) {
    throw new Error("CODEX_USAGE_RESET_PROBE_STALE");
  }
  if (state.usageResets.some((prior) => prior.observationId === reset.observationId
      || prior.probe.codexTaskId === reset.probe.codexTaskId
      || prior.authoritySignature.signatureBase64 === reset.authoritySignature.signatureBase64)) {
    throw new Error("CODEX_USAGE_RESET_PROBE_REUSED");
  }
  return exp0001aCodexSchedulerStateSchema.parse({
    ...state,
    currentUsageWindow: state.currentUsageWindow + 1,
    pause: null,
    usageResets: [...state.usageResets, reset],
  });
}

export type Exp0001aCodexBalanceReport = Readonly<{
  begunA0: number;
  begunA1: number;
  cumulativeImbalance: number;
  maximumAbsolutePrefixImbalance: number;
  fullyBegunPairCount: number;
  splitAcrossUsageWindowPairCount: number;
  partialPairIds: string[];
  byUsageWindow: Array<{
    usageWindow: number;
    begunA0: number;
    begunA1: number;
    imbalance: number;
  }>;
}>;

export function exp0001aCodexBalanceReport(
  stateInput: Exp0001aCodexSchedulerState,
): Exp0001aCodexBalanceReport {
  const state = exp0001aCodexSchedulerStateSchema.parse(stateInput);
  const begun = state.assignments.filter((assignment) => assignment.state !== "unstarted");
  let a0 = 0;
  let a1 = 0;
  let maximumAbsolutePrefixImbalance = 0;
  for (const assignment of begun) {
    if (assignment.condition === "A0") a0 += 1;
    else a1 += 1;
    maximumAbsolutePrefixImbalance = Math.max(maximumAbsolutePrefixImbalance, Math.abs(a0 - a1));
  }
  const pairs = new Map<string, Exp0001aScheduledCodexAssignment[]>();
  for (const assignment of begun) pairs.set(assignment.pairId, [...(pairs.get(assignment.pairId) ?? []), assignment]);
  let fullyBegunPairCount = 0;
  let splitAcrossUsageWindowPairCount = 0;
  const partialPairIds: string[] = [];
  for (const [pairId, pair] of pairs) {
    if (pair.length !== 2) {
      partialPairIds.push(pairId);
      continue;
    }
    fullyBegunPairCount += 1;
    if (pair[0].usageWindow !== pair[1].usageWindow) splitAcrossUsageWindowPairCount += 1;
  }
  const windowMap = new Map<number, { begunA0: number; begunA1: number }>();
  for (const assignment of begun) {
    const window = assignment.usageWindow!;
    const counts = windowMap.get(window) ?? { begunA0: 0, begunA1: 0 };
    if (assignment.condition === "A0") counts.begunA0 += 1;
    else counts.begunA1 += 1;
    windowMap.set(window, counts);
  }
  return {
    begunA0: a0,
    begunA1: a1,
    cumulativeImbalance: a0 - a1,
    maximumAbsolutePrefixImbalance,
    fullyBegunPairCount,
    splitAcrossUsageWindowPairCount,
    partialPairIds: partialPairIds.sort(),
    byUsageWindow: [...windowMap.entries()].sort(([left], [right]) => left - right).map(([usageWindow, counts]) => ({
      usageWindow,
      ...counts,
      imbalance: counts.begunA0 - counts.begunA1,
    })),
  };
}
