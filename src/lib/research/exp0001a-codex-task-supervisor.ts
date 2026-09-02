import path from "node:path";

import { z } from "zod";

import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  sha256Digest,
  type JsonValue,
} from "./provenance-crypto";

export const EXP0001A_CODEX_TASK_SUPERVISOR_VERSION =
  "exp-0001a-codex-task-supervisor/v1" as const;
export const EXP0001A_CODEX_TASK_SUPERVISOR_AUTH_MAX_AGE_MS = 5 * 60_000;
export const EXP0001A_CODEX_TASK_SUPERVISOR_LIST_LIMIT = 200 as const;
export const EXP0001A_CODEX_TASK_SUPERVISOR_WAIT_TIMEOUT_MS = 120_000 as const;
export const EXP0001A_CODEX_TASK_SUPERVISOR_READ_OUTPUT_CHARS = 100_000 as const;
export const EXP0001A_CODEX_TASK_SUPERVISOR_READ_TURN_LIMIT = 10 as const;
export const EXP0001A_CODEX_TASK_SUPERVISOR_MAX_IDENTITY_READS = 3 as const;
export const EXP0001A_CODEX_TASK_SUPERVISOR_MAX_READ_PAGES = 100 as const;

const digest = z.string().regex(SHA256_DIGEST_PATTERN);
const timestamp = z.string().datetime({ offset: true });
const opaqueId = z.string().trim().min(1).max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const taskId = z.string().trim().min(1).max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const cursor = z.string().trim().min(1).max(8_192);
const jsonValue = z.custom<JsonValue>((value) => {
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}, "Expected finite plain JSON.");

export const exp0001aCodexSupervisorRoleSchema = z.enum([
  "author",
  "primary_reviewer",
  "adjudicator",
  "pairwise_visual_judge",
]);
export type Exp0001aCodexSupervisorRole = z.infer<typeof exp0001aCodexSupervisorRoleSchema>;

export const EXP0001A_CODEX_SUPERVISOR_ROLE_POLICY = Object.freeze({
  author: Object.freeze({ model: "gpt-5.6-terra" as const, thinking: "medium" as const }),
  primary_reviewer: Object.freeze({ model: "gpt-5.6-sol" as const, thinking: "high" as const }),
  adjudicator: Object.freeze({ model: "gpt-5.6-sol" as const, thinking: "high" as const }),
  pairwise_visual_judge: Object.freeze({ model: "gpt-5.6-sol" as const, thinking: "high" as const }),
});

const observedDigest = z.object({ observability: z.literal("observed"), value: digest }).strict();
const unobservable = z.object({ observability: z.literal("unobservable"), value: z.null() }).strict();

export const exp0001aCodexSupervisorAuthReceiptSchema = z.object({
  schemaVersion: z.literal("codex-chatgpt-auth-preflight/v1"),
  checkedAt: timestamp,
  command: z.object({
    executable: z.literal("codex"),
    arguments: z.tuple([z.literal("login"), z.literal("status")]),
  }).strict(),
  authentication: z.object({
    method: z.literal("chatgpt"),
    accountIdentifier: unobservable,
    subscriptionPlan: unobservable,
  }).strict(),
  observation: z.object({
    exitCode: z.object({ observability: z.literal("observed"), value: z.literal(0) }).strict(),
    signal: unobservable,
    stdoutSha256: observedDigest,
    stderrSha256: observedDigest,
    rawOutputRetained: z.literal(false),
    outputLimitExceeded: z.literal(false),
    invocationError: z.literal(false),
  }).strict(),
  decision: z.object({
    allowCodexNativeExperiment: z.literal(true),
    reasonCode: z.literal("CHATGPT_AUTHENTICATED"),
  }).strict(),
  receiptSha256: digest,
}).strict().superRefine((receipt, context) => {
  const { receiptSha256: _receiptSha256, ...content } = receipt;
  void _receiptSha256;
  if (hashCanonicalJson(content as unknown as JsonValue) !== receipt.receiptSha256) {
    context.addIssue({ code: "custom", path: ["receiptSha256"], message: "Auth receipt digest is invalid." });
  }
});

const rolePolicySchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("author"), model: z.literal("gpt-5.6-terra"), thinking: z.literal("medium") }).strict(),
  z.object({ role: z.literal("primary_reviewer"), model: z.literal("gpt-5.6-sol"), thinking: z.literal("high") }).strict(),
  z.object({ role: z.literal("adjudicator"), model: z.literal("gpt-5.6-sol"), thinking: z.literal("high") }).strict(),
  z.object({ role: z.literal("pairwise_visual_judge"), model: z.literal("gpt-5.6-sol"), thinking: z.literal("high") }).strict(),
]);

export const exp0001aCodexSupervisorCreateAuthorizationSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-supervisor-create-authorization/v1"),
  supervisorId: opaqueId,
  workItemId: opaqueId,
  priorStateDigest: digest,
  authReceipt: exp0001aCodexSupervisorAuthReceiptSchema,
  authorizedAt: timestamp,
  expiresAt: timestamp,
  invocationOrdinal: z.literal(1),
  authorizationDigest: digest,
}).strict().superRefine((authorization, context) => {
  const { authorizationDigest: _authorizationDigest, ...content } = authorization;
  void _authorizationDigest;
  const authAge = Date.parse(authorization.authorizedAt) - Date.parse(authorization.authReceipt.checkedAt);
  if (authAge < 0 || authAge > EXP0001A_CODEX_TASK_SUPERVISOR_AUTH_MAX_AGE_MS
      || Date.parse(authorization.expiresAt) - Date.parse(authorization.authorizedAt)
        !== EXP0001A_CODEX_TASK_SUPERVISOR_AUTH_MAX_AGE_MS
      || hashCanonicalJson(content as unknown as JsonValue) !== authorization.authorizationDigest) {
    context.addIssue({ code: "custom", message: "Create authorization is stale or has an invalid digest." });
  }
});
export type Exp0001aCodexSupervisorCreateAuthorization =
  z.infer<typeof exp0001aCodexSupervisorCreateAuthorizationSchema>;

export const exp0001aCodexSupervisorToolNameSchema = z.enum([
  "mcp__codex_app__create_thread",
  "mcp__codex_app__list_threads",
  "mcp__codex_app__wait_threads",
  "mcp__codex_app__read_thread",
]);
export type Exp0001aCodexSupervisorToolName = z.infer<typeof exp0001aCodexSupervisorToolNameSchema>;

const requestContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-task-supervisor-request/v1"),
  supervisorId: opaqueId,
  workItemId: opaqueId,
  role: exp0001aCodexSupervisorRoleSchema,
  sequence: z.number().int().positive(),
  toolName: exp0001aCodexSupervisorToolNameSchema,
  arguments: jsonValue,
  argumentsDigest: digest,
  priorStateDigest: digest,
  issuedAt: timestamp,
  createAuthorizationDigest: digest.nullable(),
}).strict();

export const exp0001aCodexSupervisorRequestSchema = requestContentSchema.extend({
  requestDigest: digest,
}).strict().superRefine((request, context) => {
  const { requestDigest: _requestDigest, ...content } = request;
  void _requestDigest;
  if (hashCanonicalJson(request.arguments) !== request.argumentsDigest
      || hashCanonicalJson(content as unknown as JsonValue) !== request.requestDigest
      || (request.toolName === "mcp__codex_app__create_thread") !== (request.createAuthorizationDigest !== null)) {
    context.addIssue({ code: "custom", message: "Supervisor request binding is invalid." });
  }
});
export type Exp0001aCodexSupervisorRequest = z.infer<typeof exp0001aCodexSupervisorRequestSchema>;

export const exp0001aCodexSupervisorObservationSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-task-supervisor-observation/v1"),
  sequence: z.number().int().positive(),
  requestDigest: digest,
  toolName: exp0001aCodexSupervisorToolNameSchema,
  argumentsDigest: digest,
  observedAt: timestamp,
  rawCallToolResultDigest: digest,
  observationDigest: digest,
}).strict().superRefine((observation, context) => {
  const { observationDigest: _observationDigest, ...content } = observation;
  void _observationDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== observation.observationDigest) {
    context.addIssue({ code: "custom", path: ["observationDigest"], message: "Observation digest is invalid." });
  }
});
export type Exp0001aCodexSupervisorObservation = z.infer<typeof exp0001aCodexSupervisorObservationSchema>;

const phase = z.enum([
  "prepared",
  "awaiting_create_result",
  "awaiting_identity_reconciliation",
  "in_progress",
  "actionable",
  "waiting_on_approval",
  "awaiting_terminal_read",
  "completed",
  "failed",
  "usage_limit_interrupted",
]);

const terminalOutcome = z.enum(["completed", "failed", "usage_limit_interrupted"]);

const terminalRecord = z.object({
  outcome: terminalOutcome,
  terminalAt: timestamp,
  failureCode: z.string().trim().min(1).max(160).nullable(),
  terminalText: z.string().max(2_000_000).nullable(),
  terminalTextDigest: digest.nullable(),
  finalReadObservationDigest: digest.nullable(),
}).strict().superRefine((terminal, context) => {
  if ((terminal.terminalText === null) !== (terminal.terminalTextDigest === null)
      || (terminal.terminalText !== null
        && sha256Digest(Buffer.from(terminal.terminalText, "utf8")) !== terminal.terminalTextDigest)) {
    context.addIssue({ code: "custom", message: "Terminal text digest is invalid." });
  }
});

const stateContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_TASK_SUPERVISOR_VERSION),
  protocolId: z.literal("EXP-0001A"),
  supervisorId: opaqueId,
  workItemId: opaqueId,
  rolePolicy: rolePolicySchema,
  preparedAt: timestamp,
  prompt: z.string().min(1).max(40 * 1024 * 1024),
  promptDigest: digest,
  title: z.string().trim().min(1).max(120),
  directoryName: z.string().regex(/^(?:canvas-task|evidence-review|visual-review)-[a-f0-9]{16}$/),
  forbiddenTaskIds: z.array(taskId).max(10_000),
  phase,
  pendingRequest: exp0001aCodexSupervisorRequestSchema.nullable(),
  createAuthorization: exp0001aCodexSupervisorCreateAuthorizationSchema.nullable(),
  createdTaskId: taskId.nullable(),
  hostId: taskId.nullable(),
  clientTaskId: taskId.nullable(),
  identityReconciliationAttempts: z.number().int().min(0).max(EXP0001A_CODEX_TASK_SUPERVISOR_MAX_IDENTITY_READS),
  latestCursor: cursor.nullable(),
  readCursor: cursor.nullable(),
  pendingTerminalOutcome: terminalOutcome.nullable(),
  observations: z.array(exp0001aCodexSupervisorObservationSchema).max(1_000),
  readPageObservationDigests: z.array(digest).max(EXP0001A_CODEX_TASK_SUPERVISOR_MAX_READ_PAGES),
  terminal: terminalRecord.nullable(),
  automaticInterventionPermitted: z.literal(false),
  priorStateDigest: digest.nullable(),
}).strict();

export const exp0001aCodexTaskSupervisorStateSchema = stateContentSchema.extend({
  stateDigest: digest,
}).strict().superRefine((state, context) => {
  const { stateDigest: _stateDigest, ...content } = state;
  void _stateDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== state.stateDigest) {
    context.addIssue({ code: "custom", path: ["stateDigest"], message: "Supervisor state digest is invalid." });
  }
  if (state.promptDigest !== sha256Digest(Buffer.from(state.prompt, "utf8"))) {
    context.addIssue({ code: "custom", path: ["promptDigest"], message: "Prompt digest is invalid." });
  }
  const expected = EXP0001A_CODEX_SUPERVISOR_ROLE_POLICY[state.rolePolicy.role];
  if (state.rolePolicy.model !== expected.model || state.rolePolicy.thinking !== expected.thinking) {
    context.addIssue({ code: "custom", path: ["rolePolicy"], message: "Role policy is not frozen." });
  }
  const terminalPhase = ["completed", "failed", "usage_limit_interrupted"].includes(state.phase);
  if (terminalPhase !== (state.terminal !== null)
      || (state.pendingRequest !== null && state.pendingRequest.priorStateDigest !== state.priorStateDigest)
      || (state.pendingRequest !== null && state.pendingRequest.sequence !== state.observations.length + 1)
      || (state.pendingRequest === null && state.phase.startsWith("awaiting_")
        && state.phase !== "awaiting_identity_reconciliation" && state.phase !== "awaiting_terminal_read")) {
    context.addIssue({ code: "custom", message: "Supervisor phase/pending/terminal state is inconsistent." });
  }
  if ((state.createdTaskId === null) !== (state.hostId === null)) {
    context.addIssue({ code: "custom", message: "Task and host identity must be retained together." });
  }
  if (state.createAuthorization !== null
      && (state.createAuthorization.supervisorId !== state.supervisorId
        || state.createAuthorization.workItemId !== state.workItemId)) {
    context.addIssue({ code: "custom", message: "Create authorization belongs to another supervisor." });
  }
  if (state.observations.some((item, index) => item.sequence !== index + 1)) {
    context.addIssue({ code: "custom", path: ["observations"], message: "Observations are not a contiguous sequence." });
  }
});
export type Exp0001aCodexTaskSupervisorState = z.infer<typeof exp0001aCodexTaskSupervisorStateSchema>;

function sealState(contentInput: z.input<typeof stateContentSchema>): Exp0001aCodexTaskSupervisorState {
  const content = stateContentSchema.parse(contentInput);
  return Object.freeze(exp0001aCodexTaskSupervisorStateSchema.parse({
    ...content,
    stateDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

function advanceState(
  prior: Exp0001aCodexTaskSupervisorState,
  patch: Partial<z.input<typeof stateContentSchema>>,
): Exp0001aCodexTaskSupervisorState {
  const parsed = exp0001aCodexTaskSupervisorStateSchema.parse(prior);
  const { stateDigest: _stateDigest, ...content } = parsed;
  void _stateDigest;
  return sealState({ ...content, ...patch, priorStateDigest: parsed.stateDigest });
}

function taskClass(role: Exp0001aCodexSupervisorRole) {
  if (role === "author") return { title: "Canvas task", directory: "canvas-task" } as const;
  if (role === "pairwise_visual_judge") return { title: "Visual review", directory: "visual-review" } as const;
  return { title: "Evidence review", directory: "evidence-review" } as const;
}

function rolePolicy(role: Exp0001aCodexSupervisorRole): z.infer<typeof rolePolicySchema> {
  switch (role) {
    case "author": return { role, model: "gpt-5.6-terra", thinking: "medium" };
    case "primary_reviewer": return { role, model: "gpt-5.6-sol", thinking: "high" };
    case "adjudicator": return { role, model: "gpt-5.6-sol", thinking: "high" };
    case "pairwise_visual_judge": return { role, model: "gpt-5.6-sol", thinking: "high" };
  }
}

export function createExp0001aCodexTaskSupervisor(input: Readonly<{
  supervisorId: string;
  workItemId: string;
  role: Exp0001aCodexSupervisorRole;
  prompt: string;
  preparedAt: string;
  forbiddenTaskIds?: readonly string[];
}>): Exp0001aCodexTaskSupervisorState {
  const role = exp0001aCodexSupervisorRoleSchema.parse(input.role);
  const supervisorId = opaqueId.parse(input.supervisorId);
  const suffix = hashCanonicalJson({ supervisorId, workItemId: input.workItemId }).slice(-16);
  const visible = taskClass(role);
  return sealState({
    schemaVersion: EXP0001A_CODEX_TASK_SUPERVISOR_VERSION,
    protocolId: "EXP-0001A",
    supervisorId,
    workItemId: opaqueId.parse(input.workItemId),
    rolePolicy: rolePolicy(role),
    preparedAt: timestamp.parse(input.preparedAt),
    prompt: input.prompt,
    promptDigest: sha256Digest(Buffer.from(input.prompt, "utf8")),
    title: `${visible.title} [tx-${suffix}]`,
    directoryName: `${visible.directory}-${suffix}`,
    forbiddenTaskIds: [...new Set((input.forbiddenTaskIds ?? []).map((item) => taskId.parse(item)))],
    phase: "prepared",
    pendingRequest: null,
    createAuthorization: null,
    createdTaskId: null,
    hostId: null,
    clientTaskId: null,
    identityReconciliationAttempts: 0,
    latestCursor: null,
    readCursor: null,
    pendingTerminalOutcome: null,
    observations: [],
    readPageObservationDigests: [],
    terminal: null,
    automaticInterventionPermitted: false,
    priorStateDigest: null,
  });
}

function sealRequest(contentInput: z.input<typeof requestContentSchema>): Exp0001aCodexSupervisorRequest {
  const content = requestContentSchema.parse(contentInput);
  return Object.freeze(exp0001aCodexSupervisorRequestSchema.parse({
    ...content,
    requestDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

function requestState(
  state: Exp0001aCodexTaskSupervisorState,
  toolName: Exp0001aCodexSupervisorToolName,
  args: JsonValue,
  issuedAt: string,
  authorizationDigest: string | null,
  nextPhase: z.infer<typeof phase>,
  authorization?: Exp0001aCodexSupervisorCreateAuthorization,
) {
  const request = sealRequest({
    schemaVersion: "exp-0001a-codex-task-supervisor-request/v1",
    supervisorId: state.supervisorId,
    workItemId: state.workItemId,
    role: state.rolePolicy.role,
    sequence: state.observations.length + 1,
    toolName,
    arguments: args,
    argumentsDigest: hashCanonicalJson(args),
    priorStateDigest: state.stateDigest,
    issuedAt: timestamp.parse(issuedAt),
    createAuthorizationDigest: authorizationDigest,
  });
  return advanceState(state, {
    phase: nextPhase,
    pendingRequest: request,
    ...(authorization === undefined ? {} : { createAuthorization: authorization }),
  });
}

export function authorizeExp0001aCodexSupervisorCreate(input: Readonly<{
  state: Exp0001aCodexTaskSupervisorState;
  authReceipt: unknown;
  authorizedAt: string;
}>): Exp0001aCodexTaskSupervisorState {
  const state = exp0001aCodexTaskSupervisorStateSchema.parse(input.state);
  if (state.phase !== "prepared" || state.pendingRequest !== null || state.createAuthorization !== null
      || state.observations.length !== 0) {
    throw new Error("EXP0001A_SUPERVISOR_CREATE_ALREADY_AUTHORIZED_OR_RELEASED");
  }
  const authReceipt = exp0001aCodexSupervisorAuthReceiptSchema.parse(input.authReceipt);
  const authorizedAt = timestamp.parse(input.authorizedAt);
  const age = Date.parse(authorizedAt) - Date.parse(authReceipt.checkedAt);
  if (age < 0 || age > EXP0001A_CODEX_TASK_SUPERVISOR_AUTH_MAX_AGE_MS) {
    throw new Error("EXP0001A_SUPERVISOR_AUTH_STALE_AT_CREATE_RELEASE");
  }
  const authorizationContent = {
    schemaVersion: "exp-0001a-codex-supervisor-create-authorization/v1" as const,
    supervisorId: state.supervisorId,
    workItemId: state.workItemId,
    priorStateDigest: state.stateDigest,
    authReceipt,
    authorizedAt,
    expiresAt: new Date(Date.parse(authorizedAt) + EXP0001A_CODEX_TASK_SUPERVISOR_AUTH_MAX_AGE_MS).toISOString(),
    invocationOrdinal: 1 as const,
  };
  const authorization = exp0001aCodexSupervisorCreateAuthorizationSchema.parse({
    ...authorizationContent,
    authorizationDigest: hashCanonicalJson(authorizationContent as unknown as JsonValue),
  });
  const args = {
    prompt: state.prompt,
    title: state.title,
    target: { type: "projectless" as const, directoryName: state.directoryName },
    model: state.rolePolicy.model,
    thinking: state.rolePolicy.thinking,
  };
  return requestState(
    state,
    "mcp__codex_app__create_thread",
    args as unknown as JsonValue,
    authorizedAt,
    authorization.authorizationDigest,
    "awaiting_create_result",
    authorization,
  );
}

export function prepareNextExp0001aCodexSupervisorRequest(input: Readonly<{
  state: Exp0001aCodexTaskSupervisorState;
  issuedAt: string;
}>): Exp0001aCodexTaskSupervisorState {
  const state = exp0001aCodexTaskSupervisorStateSchema.parse(input.state);
  if (state.pendingRequest !== null) return state;
  if (["completed", "failed", "usage_limit_interrupted"].includes(state.phase)) return state;
  if (state.phase === "prepared") throw new Error("EXP0001A_SUPERVISOR_CREATE_REQUIRES_FRESH_AUTH");
  if (state.phase === "awaiting_identity_reconciliation") {
    return requestState(state, "mcp__codex_app__list_threads", {
      limit: EXP0001A_CODEX_TASK_SUPERVISOR_LIST_LIMIT,
    }, input.issuedAt, null, state.phase);
  }
  if (["in_progress", "actionable", "waiting_on_approval"].includes(state.phase)) {
    if (state.createdTaskId === null || state.hostId === null) {
      throw new Error("EXP0001A_SUPERVISOR_WAIT_IDENTITY_MISSING");
    }
    return requestState(state, "mcp__codex_app__wait_threads", {
      targets: [{
        threadId: state.createdTaskId,
        hostId: state.hostId,
        ...(state.latestCursor === null ? {} : { afterCursor: state.latestCursor }),
      }],
      timeoutMs: EXP0001A_CODEX_TASK_SUPERVISOR_WAIT_TIMEOUT_MS,
    }, input.issuedAt, null, state.phase);
  }
  if (state.phase === "awaiting_terminal_read") {
    if (state.createdTaskId === null || state.hostId === null) {
      throw new Error("EXP0001A_SUPERVISOR_READ_IDENTITY_MISSING");
    }
    return requestState(state, "mcp__codex_app__read_thread", {
      threadId: state.createdTaskId,
      hostId: state.hostId,
      ...(state.readCursor === null ? {} : { cursor: state.readCursor }),
      includeOutputs: true,
      maxOutputCharsPerItem: EXP0001A_CODEX_TASK_SUPERVISOR_READ_OUTPUT_CHARS,
      turnLimit: EXP0001A_CODEX_TASK_SUPERVISOR_READ_TURN_LIMIT,
    }, input.issuedAt, null, state.phase);
  }
  throw new Error("EXP0001A_SUPERVISOR_PHASE_HAS_NO_NEXT_REQUEST");
}

type RetainedCall = Readonly<{
  raw: JsonValue;
  rawDigest: string;
  isError: boolean;
  payload: Record<string, JsonValue>;
}>;

function record(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && value !== undefined && !Array.isArray(value) && typeof value === "object"
    ? value as Record<string, JsonValue>
    : null;
}

function string(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function retainCallToolResult(rawInput: unknown): RetainedCall {
  const raw = JSON.parse(canonicalJson(rawInput)) as JsonValue;
  const wrapper = record(raw);
  if (wrapper === null || typeof wrapper.isError !== "boolean" || !Array.isArray(wrapper.content)
      || wrapper.content.length !== 1) {
    throw new Error("EXP0001A_SUPERVISOR_CALL_TOOL_RESULT_INVALID");
  }
  const content = record(wrapper.content[0]);
  if (content?.type !== "text" || typeof content.text !== "string") {
    throw new Error("EXP0001A_SUPERVISOR_CALL_TOOL_RESULT_CONTENT_INVALID");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(content.text);
  } catch {
    throw new Error("EXP0001A_SUPERVISOR_CALL_TOOL_RESULT_TEXT_NOT_JSON");
  }
  const payloadRecord = record(payload as JsonValue);
  if (payloadRecord === null) throw new Error("EXP0001A_SUPERVISOR_CALL_TOOL_PAYLOAD_INVALID");
  return { raw, rawDigest: hashCanonicalJson(raw), isError: wrapper.isError, payload: payloadRecord };
}

function sealObservation(
  request: Exp0001aCodexSupervisorRequest,
  rawDigest: string,
  observedAt: string,
): Exp0001aCodexSupervisorObservation {
  const content = {
    schemaVersion: "exp-0001a-codex-task-supervisor-observation/v1" as const,
    sequence: request.sequence,
    requestDigest: request.requestDigest,
    toolName: request.toolName,
    argumentsDigest: request.argumentsDigest,
    observedAt: timestamp.parse(observedAt),
    rawCallToolResultDigest: digest.parse(rawDigest),
  };
  return exp0001aCodexSupervisorObservationSchema.parse({
    ...content,
    observationDigest: hashCanonicalJson(content as unknown as JsonValue),
  });
}

function usageLimit(value: JsonValue): boolean {
  return /(?:subscription[_ -]?usage|usage[_ -]?limit|codex[_ -]?usage[_ -]?limit)/i.test(canonicalJson(value));
}

function terminalize(
  state: Exp0001aCodexTaskSupervisorState,
  observation: Exp0001aCodexSupervisorObservation,
  outcome: z.infer<typeof terminalOutcome>,
  failureCode: string | null,
  terminalText: string | null,
) {
  return advanceState(state, {
    phase: outcome,
    pendingRequest: null,
    pendingTerminalOutcome: null,
    observations: [...state.observations, observation],
    terminal: {
      outcome,
      terminalAt: observation.observedAt,
      failureCode,
      terminalText,
      terminalTextDigest: terminalText === null ? null : sha256Digest(Buffer.from(terminalText, "utf8")),
      finalReadObservationDigest: observation.toolName === "mcp__codex_app__read_thread"
        ? observation.observationDigest : null,
    },
  });
}

function withObservation(
  state: Exp0001aCodexTaskSupervisorState,
  observation: Exp0001aCodexSupervisorObservation,
  patch: Partial<z.input<typeof stateContentSchema>>,
) {
  return advanceState(state, {
    ...patch,
    pendingRequest: null,
    observations: [...state.observations, observation],
  });
}

function expectedLiveTitle(title: string) {
  const normalized = title.trim().replace(/\s+/g, " ");
  const chars = Array.from(normalized);
  return chars.length <= 60 ? normalized : `${chars.slice(0, 59).join("")}…`;
}

function noTruncation(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.every(noTruncation);
  const object = record(value);
  if (object === null) return true;
  if (object.truncated === true) return false;
  return Object.values(object).every(noTruncation);
}

function projectlessCwdMatches(cwd: string, directoryName: string) {
  const normalized = path.resolve(cwd);
  const escaped = directoryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return path.basename(normalized) === directoryName
    && (new RegExp(`^/Users/[^/]+/Documents/Codex/\\d{4}-\\d{2}-\\d{2}/${escaped}$`).test(normalized)
      || normalized === path.join("/private/tmp", directoryName));
}

function finalAgentText(payload: Record<string, JsonValue>): string | null {
  if (!Array.isArray(payload.turns)) return null;
  for (const turnValue of payload.turns) {
    const turn = record(turnValue);
    if (turn?.status !== "completed" || !Array.isArray(turn.items)) continue;
    for (const itemValue of [...turn.items].reverse()) {
      const item = record(itemValue);
      if (item?.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string") {
        return item.text;
      }
    }
  }
  return null;
}

function deriveActionablePhase(poll: Record<string, JsonValue>, latestTurn: Record<string, JsonValue> | null) {
  const threadStatus = record(record(poll.thread as JsonValue)?.status as JsonValue);
  const activeFlags = Array.isArray(threadStatus?.activeFlags)
    ? threadStatus.activeFlags.filter((item): item is string => typeof item === "string") : [];
  const fields = [
    string(latestTurn?.status),
    string(latestTurn?.actionableStatus),
    string(poll.actionableStatus),
    string(threadStatus?.actionableStatus),
    ...activeFlags,
  ].filter((item): item is string => item !== null).map((item) => item.toLowerCase().replace(/[^a-z]/g, ""));
  if (fields.some((item) => item.includes("waitingonapproval") || item.includes("approvalrequired"))) {
    return "waiting_on_approval" as const;
  }
  if (fields.some((item) => item.includes("actionable") || item.includes("needsattention")
      || item.includes("waitingforinput"))) {
    return "actionable" as const;
  }
  if (fields.some((item) => item === "inprogress" || item === "active") || threadStatus?.type === "active") {
    return "in_progress" as const;
  }
  return null;
}

export function ingestExp0001aCodexSupervisorRawResult(input: Readonly<{
  state: Exp0001aCodexTaskSupervisorState;
  rawCallToolResult: unknown;
  observedAt: string;
}>): Exp0001aCodexTaskSupervisorState {
  const state = exp0001aCodexTaskSupervisorStateSchema.parse(input.state);
  const request = state.pendingRequest;
  if (request === null) throw new Error("EXP0001A_SUPERVISOR_HAS_NO_PENDING_REQUEST");
  const call = retainCallToolResult(input.rawCallToolResult);
  const observation = sealObservation(request, call.rawDigest, input.observedAt);

  if (request.toolName === "mcp__codex_app__create_thread") {
    const authorization = state.createAuthorization;
    if (authorization === null || request.createAuthorizationDigest !== authorization.authorizationDigest
        || Date.parse(observation.observedAt) < Date.parse(request.issuedAt)
        || Date.parse(observation.observedAt) > Date.parse(authorization.expiresAt)) {
      throw new Error("EXP0001A_SUPERVISOR_CREATE_RESULT_OUTSIDE_AUTHORIZATION");
    }
    if (call.isError && call.payload.taskCreated === false) {
      return terminalize(state, observation, usageLimit(call.payload as JsonValue)
        ? "usage_limit_interrupted" : "failed", usageLimit(call.payload as JsonValue)
        ? "codex_usage_limit_before_task_creation" : "codex_create_refused_before_task_creation", null);
    }
    const createdTaskId = string(call.payload.threadId);
    const hostId = string(call.payload.hostId);
    const clientTaskId = string(call.payload.clientThreadId);
    if ((createdTaskId === null) !== (hostId === null)
        || (createdTaskId !== null && state.forbiddenTaskIds.includes(createdTaskId))) {
      return terminalize(state, observation, "failed", "codex_create_identity_invalid_or_reused", null);
    }
    return withObservation(state, observation, {
      phase: "awaiting_identity_reconciliation",
      createdTaskId,
      hostId,
      clientTaskId,
    });
  }

  if (request.toolName === "mcp__codex_app__list_threads") {
    if (state.phase !== "awaiting_identity_reconciliation") {
      throw new Error("EXP0001A_SUPERVISOR_LIST_PHASE_INVALID");
    }
    const attempts = state.identityReconciliationAttempts + 1;
    if (call.isError || !Array.isArray(call.payload.pinnedThreads) || !Array.isArray(call.payload.threads)) {
      return terminalize(state, observation, "failed", "codex_identity_reconciliation_result_invalid", null);
    }
    const entries = [...call.payload.pinnedThreads, ...call.payload.threads];
    const matches = entries.flatMap((entry) => {
      const item = record(entry);
      return item?.kind === "codex" && item.title === expectedLiveTitle(state.title) ? [item] : [];
    });
    if (matches.length > 1) {
      return terminalize(state, observation, "failed", "codex_duplicate_unique_title", null);
    }
    const matchTaskId = matches.length === 1 ? string(matches[0]?.id) : null;
    const matchHostId = matches.length === 1 ? string(matches[0]?.hostId) : null;
    if ((matchTaskId === null) !== (matchHostId === null)
        || (matchTaskId !== null && state.forbiddenTaskIds.includes(matchTaskId))) {
      return terminalize(state, observation, "failed", "codex_reconciled_identity_invalid_or_reused", null);
    }
    if (state.createdTaskId !== null) {
      if (matchTaskId !== null && (matchTaskId !== state.createdTaskId || matchHostId !== state.hostId)) {
        return terminalize(state, observation, "failed", "codex_create_and_list_identity_disagree", null);
      }
      return withObservation(state, observation, { phase: "in_progress", identityReconciliationAttempts: attempts });
    }
    if (matchTaskId !== null && matchHostId !== null) {
      return withObservation(state, observation, {
        phase: "in_progress",
        createdTaskId: matchTaskId,
        hostId: matchHostId,
        identityReconciliationAttempts: attempts,
      });
    }
    if (attempts < EXP0001A_CODEX_TASK_SUPERVISOR_MAX_IDENTITY_READS) {
      return withObservation(state, observation, {
        phase: "awaiting_identity_reconciliation",
        identityReconciliationAttempts: attempts,
      });
    }
    return terminalize(state, observation, "failed", "codex_create_identity_unresolved_without_retry", null);
  }

  if (request.toolName === "mcp__codex_app__wait_threads") {
    if (state.createdTaskId === null || state.hostId === null) throw new Error("EXP0001A_SUPERVISOR_WAIT_IDENTITY_MISSING");
    if (call.isError) {
      return withObservation(state, observation, {
        phase: "awaiting_terminal_read",
        pendingTerminalOutcome: usageLimit(call.payload as JsonValue) ? "usage_limit_interrupted" : "failed",
      });
    }
    if (typeof call.payload.timedOut !== "boolean" || !Array.isArray(call.payload.polls)
        || call.payload.polls.length !== 1) {
      return terminalize(state, observation, "failed", "codex_wait_result_invalid", null);
    }
    const poll = record(call.payload.polls[0]);
    const pollThread = record(poll?.thread as JsonValue);
    const latestTurn = record(poll?.latestTurn as JsonValue);
    const nextCursor = string(poll?.cursor);
    if (poll === null || nextCursor === null || nextCursor === state.latestCursor
        || string(pollThread?.id) !== state.createdTaskId || string(pollThread?.hostId) !== state.hostId) {
      return terminalize(state, observation, "failed", "codex_wait_target_or_cursor_invalid", null);
    }
    const status = string(latestTurn?.status)?.toLowerCase();
    const actionablePhase = deriveActionablePhase(poll, latestTurn);
    if (call.payload.timedOut === true) {
      if (call.payload.wake !== null || actionablePhase === null) {
        return terminalize(state, observation, "failed", "codex_wait_timeout_shape_invalid", null);
      }
      return withObservation(state, observation, { phase: actionablePhase, latestCursor: nextCursor });
    }
    const wake = record(call.payload.wake as JsonValue);
    if (wake === null || string(wake.threadId) !== state.createdTaskId || string(wake.hostId) !== state.hostId) {
      return terminalize(state, observation, "failed", "codex_wait_wake_identity_invalid", null);
    }
    if (status === "completed" && wake.reason === "turnCompleted") {
      return withObservation(state, observation, {
        phase: "awaiting_terminal_read",
        latestCursor: nextCursor,
        pendingTerminalOutcome: "completed",
      });
    }
    if (status === "failed") {
      return withObservation(state, observation, {
        phase: "awaiting_terminal_read",
        latestCursor: nextCursor,
        pendingTerminalOutcome: usageLimit(latestTurn as JsonValue) ? "usage_limit_interrupted" : "failed",
      });
    }
    if (actionablePhase !== null) {
      return withObservation(state, observation, { phase: actionablePhase, latestCursor: nextCursor });
    }
    return terminalize(state, observation, "failed", "codex_wait_status_unrecognized", null);
  }

  if (state.createdTaskId === null || state.hostId === null || state.pendingTerminalOutcome === null) {
    throw new Error("EXP0001A_SUPERVISOR_READ_TERMINAL_BINDING_MISSING");
  }
  if (call.isError) {
    return terminalize(state, observation, "failed", "codex_terminal_read_failed", null);
  }
  const thread = record(call.payload.thread as JsonValue);
  const page = record(call.payload.page as JsonValue);
  if (thread === null || page === null || string(thread.id) !== state.createdTaskId
      || string(thread.hostId) !== state.hostId || thread.kind !== "codex"
      || thread.title !== expectedLiveTitle(state.title) || typeof thread.cwd !== "string"
      || !projectlessCwdMatches(thread.cwd, state.directoryName)
      || page.order !== "newest_first" || typeof page.hasMore !== "boolean"
      || !Array.isArray(call.payload.turns) || !noTruncation(call.payload as JsonValue)) {
    return terminalize(state, observation, "failed", "codex_terminal_read_identity_or_trace_invalid", null);
  }
  const pages = [...state.readPageObservationDigests, observation.observationDigest];
  if (pages.length > EXP0001A_CODEX_TASK_SUPERVISOR_MAX_READ_PAGES) {
    return terminalize(state, observation, "failed", "codex_terminal_read_page_limit", null);
  }
  if (page.hasMore) {
    const nextCursor = string(page.nextCursor);
    if (nextCursor === null || nextCursor === state.readCursor) {
      return terminalize(state, observation, "failed", "codex_terminal_read_cursor_invalid", null);
    }
    return withObservation(state, observation, {
      phase: "awaiting_terminal_read",
      readCursor: nextCursor,
      readPageObservationDigests: pages,
    });
  }
  if (page.nextCursor !== null) {
    return terminalize(state, observation, "failed", "codex_terminal_read_exhaustion_invalid", null);
  }
  const finalText = finalAgentText(call.payload);
  const turns = call.payload.turns.flatMap((item) => {
    const turn = record(item);
    return turn === null ? [] : [turn];
  });
  const completed = turns.some((turn) => turn.status === "completed" && turn.error === null);
  const failed = turns.some((turn) => turn.status === "failed");
  if (state.pendingTerminalOutcome === "completed" && (!completed || finalText === null)) {
    return terminalize(state, observation, "failed", "codex_completed_turn_or_final_text_missing", null);
  }
  if (state.pendingTerminalOutcome !== "completed" && !failed
      && !turns.some((turn) => usageLimit(turn as JsonValue))) {
    return terminalize(state, observation, "failed", "codex_failure_terminal_trace_missing", null);
  }
  return terminalize(
    state,
    observation,
    state.pendingTerminalOutcome,
    state.pendingTerminalOutcome === "completed" ? null
      : state.pendingTerminalOutcome === "usage_limit_interrupted" ? "codex_usage_limit_after_task_creation"
        : "codex_task_failed",
    finalText,
  );
}

export function exp0001aCodexSupervisorRedactedStatus(stateInput: unknown) {
  const state = exp0001aCodexTaskSupervisorStateSchema.parse(stateInput);
  return Object.freeze({
    schemaVersion: "exp-0001a-codex-task-supervisor-redacted-status/v1" as const,
    supervisorId: state.supervisorId,
    workItemId: state.workItemId,
    role: state.rolePolicy.role,
    model: state.rolePolicy.model,
    thinking: state.rolePolicy.thinking,
    phase: state.phase,
    stateDigest: state.stateDigest,
    createdTaskId: state.createdTaskId,
    hostId: state.hostId,
    latestCursor: state.latestCursor,
    pendingRequest: state.pendingRequest === null ? null : {
      sequence: state.pendingRequest.sequence,
      toolName: state.pendingRequest.toolName,
      requestDigest: state.pendingRequest.requestDigest,
      argumentsDigest: state.pendingRequest.argumentsDigest,
      issuedAt: state.pendingRequest.issuedAt,
    },
    observationCount: state.observations.length,
    automaticInterventionPermitted: state.automaticInterventionPermitted,
    terminal: state.terminal === null ? null : {
      outcome: state.terminal.outcome,
      terminalAt: state.terminal.terminalAt,
      failureCode: state.terminal.failureCode,
      terminalTextDigest: state.terminal.terminalTextDigest,
    },
  });
}
