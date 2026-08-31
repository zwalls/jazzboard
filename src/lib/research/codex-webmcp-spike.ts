import { z } from "zod";

import {
  exp0001aCodexAuthoritySignatureSchema,
  verifyExp0001aCodexAuthoritySignature,
} from "./exp0001a-codex-authority";
import {
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";
import { assertNoSecretLeakage } from "./provenance-redaction";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const identifierSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const roomIdSchema = z.string().regex(/^room_[A-Za-z0-9_-]{8,}$/);
const toolNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const observedTimestampSchema = z.union([timestampSchema, z.literal("unobservable")]);

export const CODEX_WEBMCP_SPIKE_MODEL = "gpt-5.6-sol" as const;
export const CODEX_WEBMCP_SPIKE_REASONING = "max" as const;
/**
 * Logical identity used by new Codex-native task evidence. Historical spike
 * evidence retained the host-resolved path; the verifier accepts that private
 * value only when it ends in this frozen, product-owned suffix. Keeping the
 * host prefix out of executable bytes prevents a developer home/cache path
 * from becoming part of the portable experiment runtime.
 */
export const CODEX_BROWSER_SKILL_ID = "browser:control-in-app-browser" as const;
export const CODEX_BROWSER_SKILL_VERSION = "26.825.51511" as const;
export const CODEX_BROWSER_SKILL_PATH = `${CODEX_BROWSER_SKILL_ID}@${CODEX_BROWSER_SKILL_VERSION}` as const;
const CODEX_BROWSER_SKILL_RESOLVED_SUFFIX = `/browser/${CODEX_BROWSER_SKILL_VERSION}/skills/control-in-app-browser/SKILL.md` as const;

const browserSkillReferenceSchema = z.string().trim().min(1).max(4_096).superRefine((value, context) => {
  const isLogicalReference = value === CODEX_BROWSER_SKILL_PATH;
  const isHistoricalResolvedReference = value.startsWith("/")
    && value.endsWith(CODEX_BROWSER_SKILL_RESOLVED_SUFFIX)
    && !value.includes("\\")
    && !value.split("/").includes("..");
  if (!isLogicalReference && !isHistoricalResolvedReference) {
    context.addIssue({
      code: "custom",
      message: "Expected the frozen logical Browser skill identity or its private host-resolved historical suffix.",
    });
  }
});

const TRUSTED_JAZZBOARD_HOST = "www.jazzboard.xyz" as const;
const CURRENT_INVITE_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

type PrivateRoomAccess =
  | { mode: "authorized_direct"; roomId: string; inviteCode: null }
  | { mode: "invite"; roomId: null; inviteCode: string };

function parsePrivateRoomAccessUrl(value: string): PrivateRoomAccess {
  const directMatch = new RegExp(`^https://${TRUSTED_JAZZBOARD_HOST.replaceAll(".", "\\.")}/room/(room_[A-Za-z0-9_-]{8,})/?$`).exec(value);
  if (directMatch !== null) {
    return { mode: "authorized_direct", roomId: directMatch[1]!, inviteCode: null };
  }

  const inviteMatch = new RegExp(`^https://${TRUSTED_JAZZBOARD_HOST.replaceAll(".", "\\.")}/#join=([A-HJ-NP-Z2-9]{6})$`).exec(value);
  if (inviteMatch !== null && CURRENT_INVITE_CODE_PATTERN.test(inviteMatch[1]!)) {
    return { mode: "invite", roomId: null, inviteCode: inviteMatch[1]! };
  }

  throw new Error("Expected an exact credential-free production /room/room_id URL or #join=ABC234 invite URL.");
}

const privateRoomUrlSchema = z.string().url().superRefine((value, context) => {
  try {
    parsePrivateRoomAccessUrl(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid private room URL.",
    });
  }
});

export function computePrivateRoomAccessBinding(input: {
  privateRoomUrl: string;
  roomId: string;
}): string {
  const access = parsePrivateRoomAccessUrl(input.privateRoomUrl);
  const roomId = roomIdSchema.parse(input.roomId);
  if (access.mode === "authorized_direct" && access.roomId !== roomId) {
    throw new Error("Direct room URL and authoritative room ID do not match.");
  }
  return hashCanonicalJson({
    schemaVersion: 1,
    kind: "private-room-access-binding",
    accessMode: access.mode,
    privateRoomUrl: input.privateRoomUrl,
    roomId,
  });
}

export const codexWebMcpPromptEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("codex-webmcp-disposable-spike-prompt"),
  publicBrief: z.string().trim().min(20).max(8_000),
  privateRoomUrl: privateRoomUrlSchema,
  permittedAccess: z.object({
    browser: z.literal(true),
    browserExposedWebMcp: z.literal(true),
    repository: z.literal(false),
    privateApis: z.literal(false),
  }).strict(),
  operatingInstructions: z.tuple([
    z.literal("Open the supplied private Jazzboard room URL in the browser."),
    z.literal("Discover the WebMCP tools exposed by that page before authoring."),
    z.literal("Use browser-exposed WebMCP tools to build and inspect the requested artifact."),
    z.literal("Return a terminal result only after reading authoritative Jazzboard canvas state."),
  ]),
}).strict();

export type CodexWebMcpPromptEnvelope = z.infer<typeof codexWebMcpPromptEnvelopeSchema>;

export type PromptContaminationCode =
  | "COORDINATE_HINT"
  | "EVALUATOR_CONTEXT"
  | "FORK_OR_HISTORY"
  | "PRIVATE_API"
  | "REPOSITORY_ACCESS"
  | "UNDECLARED_URL";

// Keep retired credential/provider markers effective as contamination checks
// without embedding the legacy endpoint or environment-variable name as an
// executable-runtime literal that could be mistaken for an active transport.
const RETIRED_PROVIDER_HOST_PATTERN = ["api", "openai", "com"].join("\\.");
const RETIRED_PROVIDER_CREDENTIAL_PATTERN = ["OPENAI", "API", "KEY"].join("_");
const privateApiContaminationPattern = new RegExp(
  `(?:${RETIRED_PROVIDER_HOST_PATTERN}|${RETIRED_PROVIDER_CREDENTIAL_PATTERN}|\\bBearer\\s+[A-Za-z0-9._-]+|\\bprivate API\\b)`,
  "i",
);

const PROMPT_CONTAMINATION_PATTERNS: ReadonlyArray<{
  code: PromptContaminationCode;
  pattern: RegExp;
}> = Object.freeze([
  {
    code: "COORDINATE_HINT",
    pattern: /(?:\b(?:x|y|left|top|width|height)\s*(?:[:=]|\s+(?:is|of))\s*-?\d)|(?:\b(?:x|y)\s+(?:coordinate|position)\s*(?:[:=]|\bis\b|\bof\b)?\s*-?\d)|(?:[([]\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*[)\]])|(?:\b(?:at|position)\s+-?\d+(?:\.\d+)?\s*(?:,|x|×|by)\s*-?\d+(?:\.\d+)?)|(?:\b-?\d+(?:\.\d+)?\s*(?:px|pixels?)\b)/i,
  },
  {
    code: "EVALUATOR_CONTEXT",
    // The frozen adversarial-text benchmark legitimately asks the author to
    // remove "evaluator-directed [canvas] text" from the board.  That phrase
    // describes untrusted artifact content, not leaked evaluator context.
    // Keep the exception exact so ordinary evaluator/rubric instructions are
    // still rejected at the author boundary.
    pattern: /\b(?:adjudicat(?:e|ion|or)|author transcript|blinded reviewer|condition label|evaluation criteria|evaluator(?!-directed\s+(?:canvas\s+)?text\b)|judge context|paired result|reviewer|rubric|scorecard)\b/i,
  },
  {
    code: "FORK_OR_HISTORY",
    pattern: /\b(?:fork(?:ed|ing)?\s+(?:the\s+)?(?:task|thread|session)|(?:chat|conversation|previous|prior|shared|task|thread) history|history from (?:another|the|this)|previous (?:attempt|conversation|session|transcript)|reuse (?:an?|the) (?:attempt|coordinates|history|transcript))\b/i,
  },
  {
    code: "PRIVATE_API",
    pattern: privateApiContaminationPattern,
  },
  {
    code: "REPOSITORY_ACCESS",
    pattern: /(?:\/Volumes\/|\/Users\/|\/home\/|[A-Za-z]:\\|(?:^|\s)(?:\.\.\/|\.\/|src\/|app\/|research\/)|\b(?:package\.json|\.git|git clone|repository path)\b)/im,
  },
  {
    code: "UNDECLARED_URL",
    pattern: /\bhttps?:\/\//i,
  },
]);

export function findCodexWebMcpPromptContamination(publicBrief: string): PromptContaminationCode[] {
  return PROMPT_CONTAMINATION_PATTERNS
    .filter(({ pattern }) => pattern.test(publicBrief))
    .map(({ code }) => code);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Builds the complete author prompt from exactly one public brief, one private
 * room URL, and a fixed least-privilege browser/WebMCP capability declaration.
 */
export function createCodexWebMcpPromptEnvelope(input: {
  publicBrief: string;
  privateRoomUrl: string;
}): CodexWebMcpPromptEnvelope {
  const contamination = findCodexWebMcpPromptContamination(input.publicBrief);
  if (contamination.length > 0) {
    throw new Error(`Public brief contains prohibited experimental context: ${contamination.join(", ")}.`);
  }
  return freezeDeep(codexWebMcpPromptEnvelopeSchema.parse({
    schemaVersion: 1,
    kind: "codex-webmcp-disposable-spike-prompt",
    publicBrief: input.publicBrief,
    privateRoomUrl: input.privateRoomUrl,
    permittedAccess: {
      browser: true,
      browserExposedWebMcp: true,
      repository: false,
      privateApis: false,
    },
    operatingInstructions: [
      "Open the supplied private Jazzboard room URL in the browser.",
      "Discover the WebMCP tools exposed by that page before authoring.",
      "Use browser-exposed WebMCP tools to build and inspect the requested artifact.",
      "Return a terminal result only after reading authoritative Jazzboard canvas state.",
    ],
  }));
}

/** Renders the exact user-visible prompt sent to the disposable Codex task. */
export function renderCodexWebMcpPromptEnvelope(envelopeInput: unknown): string {
  const envelope = codexWebMcpPromptEnvelopeSchema.parse(envelopeInput);
  return [
    "Public task brief:",
    envelope.publicBrief,
    "",
    "Private Jazzboard room:",
    envelope.privateRoomUrl,
    "",
    "Permitted access:",
    "- The browser and the WebMCP tools exposed by the Jazzboard page.",
    "- No repository, project, private API, or inherited conversation context.",
    "",
    ...envelope.operatingInstructions,
  ].join("\n");
}

const artifactReferenceSchema = z.object({
  sha256: digestSchema,
  bytes: z.number().int().positive(),
  mimeType: z.string().trim().min(1).max(160),
}).strict();

const requiredArtifactsSchema = z.object({
  authPreflight: artifactReferenceSchema,
  promptEnvelope: artifactReferenceSchema,
  taskCreationReceipt: artifactReferenceSchema,
  roomCreationReceipt: artifactReferenceSchema,
  platformBootstrapTrace: artifactReferenceSchema,
  isolationAttestation: artifactReferenceSchema,
  webMcpTrace: artifactReferenceSchema,
  terminalResult: artifactReferenceSchema,
  semanticState: artifactReferenceSchema,
  canvasImage: artifactReferenceSchema.extend({ mimeType: z.literal("image/png") }).strict(),
}).strict();

const authEvidenceSchema = z.object({
  method: z.enum(["chatgpt", "api_key", "unobservable"]),
  observedAt: timestampSchema,
  preflightReceiptDigest: digestSchema,
}).strict();

const requestedModelSchema = z.object({
  id: z.literal(CODEX_WEBMCP_SPIKE_MODEL),
  reasoningEffort: z.literal(CODEX_WEBMCP_SPIKE_REASONING),
  settingsFrozen: z.literal(true),
}).strict();

const observedModelSchema = z.object({
  id: z.union([z.literal(CODEX_WEBMCP_SPIKE_MODEL), z.literal("unobservable")]),
  reasoningEffort: z.union([z.literal(CODEX_WEBMCP_SPIKE_REASONING), z.literal("unobservable")]),
}).strict();

const taskEvidenceSchema = z.object({
  taskId: identifierSchema,
  hostId: identifierSchema,
  createdAt: timestampSchema,
  creationReceiptDigest: digestSchema,
  creationMode: z.literal("fresh_projectless_task"),
  workspaceKind: z.literal("projectless"),
  projectId: z.null(),
  sourceTaskId: z.null(),
  forkedFromTaskId: z.null(),
  sharedHistory: z.literal(false),
  requestedModel: requestedModelSchema,
  observedModel: observedModelSchema,
}).strict();

const roomEvidenceSchema = z.object({
  roomId: roomIdSchema,
  privateRoomUrl: privateRoomUrlSchema,
  accessMode: z.enum(["invite", "authorized_direct"]),
  privateAccessBindingDigest: digestSchema,
  createdAt: observedTimestampSchema,
  creationReceiptDigest: digestSchema,
  creationMode: z.literal("fresh_private_room"),
  visibility: z.literal("private"),
}).strict().superRefine((room, context) => {
  try {
    const access = parsePrivateRoomAccessUrl(room.privateRoomUrl);
    if (access.mode !== room.accessMode) {
      context.addIssue({ code: "custom", path: ["accessMode"], message: "Access mode does not match the private room URL." });
    }
    if (access.mode === "authorized_direct" && access.roomId !== room.roomId) {
      context.addIssue({ code: "custom", path: ["privateRoomUrl"], message: "Room URL and room ID do not match." });
    }
    if (computePrivateRoomAccessBinding({ privateRoomUrl: room.privateRoomUrl, roomId: room.roomId }) !== room.privateAccessBindingDigest) {
      context.addIssue({ code: "custom", path: ["privateAccessBindingDigest"], message: "Private room access binding is invalid." });
    }
  } catch {
    // The URL schema reports the more specific issue.
  }
});

const platformBootstrapEvidenceSchema = z.object({
  observed: z.literal(true),
  at: observedTimestampSchema,
  operation: z.literal("read_installed_browser_skill"),
  skillPath: browserSkillReferenceSchema,
  skillFileDigest: digestSchema,
  traceArtifactDigest: digestSchema,
  workingDirectoryKind: z.literal("empty_projectless_workspace"),
  commandExecutionCount: z.literal(1),
  filesystemReadCount: z.literal(1),
  filesystemWriteCount: z.literal(0),
  projectOrRepositoryReadCount: z.literal(0),
  otherCommandExecutionCount: z.literal(0),
  directHttpRequestCount: z.literal(0),
}).strict();

const isolationEvidenceSchema = z.object({
  repositoryAccess: z.literal("absent"),
  privateApiAccess: z.literal("absent"),
  openAiApiKeyAvailable: z.literal(false),
  directProviderApiRequestCount: z.literal(0),
  directHttpRequestCount: z.literal(0),
  filesystemProjectContext: z.literal("empty_projectless_workspace"),
  attestationDigest: digestSchema,
}).strict();

const webMcpCallSchema = z.object({
  sequence: z.number().int().nonnegative(),
  at: observedTimestampSchema,
  toolName: toolNameSchema,
  kind: z.enum(["read", "mutation", "inspection", "lifecycle"]),
  status: z.enum(["succeeded", "failed"]),
  argumentsDigest: digestSchema,
  resultDigest: digestSchema.nullable(),
  failureCode: identifierSchema.nullable(),
  authoritativeRoomRevision: z.number().int().nonnegative().nullable(),
}).strict().superRefine((call, context) => {
  if (call.status === "succeeded" && (call.resultDigest === null || call.failureCode !== null)) {
    context.addIssue({ code: "custom", message: "Successful calls require a result digest and no failure code." });
  }
  if (call.status === "failed" && (call.resultDigest !== null || call.failureCode === null || call.authoritativeRoomRevision !== null)) {
    context.addIssue({ code: "custom", message: "Failed calls require only a failure code." });
  }
});

const webMcpEvidenceSchema = z.object({
  surface: z.literal("browser-exposed"),
  discoveredAt: observedTimestampSchema,
  toolNames: z.array(toolNameSchema).min(2).max(256),
  inventoryDigest: digestSchema,
  calls: z.array(webMcpCallSchema).min(2).max(10_000),
  traceArtifactDigest: digestSchema,
}).strict();

const revisionObservationSchema = z.object({
  sequence: z.number().int().nonnegative(),
  at: observedTimestampSchema,
  roomRevision: z.number().int().nonnegative(),
  sourceToolCallSequence: z.number().int().nonnegative(),
  semanticStateDigest: digestSchema.nullable(),
  final: z.boolean(),
}).strict();

const objectRevisionSchema = z.object({
  semanticObjectId: identifierSchema,
  revision: z.number().int().positive(),
}).strict();

const authoritativeCanvasEvidenceSchema = z.object({
  finalRoomRevision: z.number().int().positive(),
  objectCount: z.number().int().positive(),
  revisionObservations: z.array(revisionObservationSchema).min(2).max(10_000),
  objectRevisions: z.array(objectRevisionSchema).min(1).max(50_000),
  semanticStateDigest: digestSchema,
  canvasImageDigest: digestSchema,
}).strict();

const terminalEvidenceSchema = z.object({
  status: z.literal("completed"),
  completedAt: timestampSchema,
  resultDigest: digestSchema,
}).strict();

export const codexWebMcpSpikeFailureCodeSchema = z.enum([
  "AUTH_NOT_CHATGPT",
  "AUTH_UNOBSERVABLE",
  "PROMPT_REJECTED",
  "ROOM_PROVISION_FAILED",
  "TASK_PROVISION_FAILED",
  "TASK_NOT_PROJECTLESS",
  "ISOLATION_VIOLATION",
  "WEBMCP_DISCOVERY_FAILED",
  "WEBMCP_CALL_FAILED",
  "AUTHOR_TERMINAL_FAILED",
  "AUTHORITATIVE_EVIDENCE_MISSING",
  "ARTIFACT_INTEGRITY_FAILED",
  "TIMEOUT",
  "USAGE_LIMIT",
  "OTHER",
]);

const failureReasonSchema = z.object({
  code: codexWebMcpSpikeFailureCodeSchema,
  phase: z.enum(["preflight", "room", "task", "author", "evidence", "terminal"]),
  at: timestampSchema,
  message: z.string().trim().min(1).max(2_000),
}).strict();

const spikeCommonSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("codex-webmcp-disposable-spike-evidence"),
  spikeId: identifierSchema,
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  wallTimeMs: z.number().int().nonnegative(),
});

const passEvidenceContentSchema = spikeCommonSchema.extend({
  status: z.literal("pass"),
  failureReasons: z.tuple([]),
  auth: authEvidenceSchema,
  promptEnvelopeDigest: digestSchema,
  task: taskEvidenceSchema,
  room: roomEvidenceSchema,
  platformBootstrap: platformBootstrapEvidenceSchema,
  isolation: isolationEvidenceSchema,
  webMcp: webMcpEvidenceSchema,
  terminal: terminalEvidenceSchema,
  authoritativeCanvas: authoritativeCanvasEvidenceSchema,
  artifacts: requiredArtifactsSchema,
  artifactSetRoot: digestSchema,
}).strict();

const failureEvidenceContentSchema = spikeCommonSchema.extend({
  status: z.literal("fail"),
  failureReasons: z.array(failureReasonSchema).min(1).max(100),
  auth: authEvidenceSchema.nullable(),
  promptEnvelopeDigest: digestSchema.nullable(),
  task: taskEvidenceSchema.nullable(),
  room: roomEvidenceSchema.nullable(),
  platformBootstrap: platformBootstrapEvidenceSchema.nullable(),
  isolation: isolationEvidenceSchema.nullable(),
  webMcp: webMcpEvidenceSchema.nullable(),
  terminal: terminalEvidenceSchema.nullable(),
  authoritativeCanvas: authoritativeCanvasEvidenceSchema.nullable(),
  artifacts: requiredArtifactsSchema.partial().strict(),
  artifactSetRoot: digestSchema.nullable(),
}).strict();

export const codexWebMcpSpikeEvidenceContentSchema = z.union([
  passEvidenceContentSchema,
  failureEvidenceContentSchema,
]);

export const codexWebMcpSpikeEvidenceSchema = z.union([
  passEvidenceContentSchema.extend({ evidenceDigest: digestSchema }).strict(),
  failureEvidenceContentSchema.extend({ evidenceDigest: digestSchema }).strict(),
]);

export type CodexWebMcpSpikeEvidenceContent = z.infer<typeof codexWebMcpSpikeEvidenceContentSchema>;
export type CodexWebMcpSpikeEvidence = z.infer<typeof codexWebMcpSpikeEvidenceSchema>;

export type CodexWebMcpSpikeFreshnessContext = {
  priorTaskIds?: ReadonlySet<string>;
  priorRoomIds?: ReadonlySet<string>;
};

export type CodexWebMcpSpikeVerification =
  | { ok: true; evidence: CodexWebMcpSpikeEvidence }
  | { ok: false; errors: string[] };

function artifactSetRoot(artifacts: z.infer<typeof requiredArtifactsSchema>): string {
  return hashCanonicalJson({
    schemaVersion: 1,
    artifacts: Object.entries(artifacts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, artifact]) => ({ name, ...artifact })),
  });
}

function contentOf(evidence: CodexWebMcpSpikeEvidence): CodexWebMcpSpikeEvidenceContent {
  const { evidenceDigest: _evidenceDigest, ...content } = evidence;
  void _evidenceDigest;
  return codexWebMcpSpikeEvidenceContentSchema.parse(content);
}

function pushTimestampErrors(content: CodexWebMcpSpikeEvidenceContent, errors: string[]): void {
  const start = Date.parse(content.startedAt);
  const end = Date.parse(content.completedAt);
  if (end < start) errors.push("SPIKE_COMPLETION_PRECEDES_START");
  if (end - start !== content.wallTimeMs) errors.push("WALL_TIME_MISMATCH");
  for (const reason of content.failureReasons) {
    const at = Date.parse(reason.at);
    if (at < start || at > end) errors.push("FAILURE_TIMESTAMP_OUTSIDE_SPIKE");
  }
}

function pushPassErrors(
  evidence: Extract<CodexWebMcpSpikeEvidence, { status: "pass" }>,
  errors: string[],
  freshness: CodexWebMcpSpikeFreshnessContext,
): void {
  if (evidence.auth.method !== "chatgpt") errors.push("AUTH_NOT_CHATGPT");
  if (freshness.priorTaskIds?.has(evidence.task.taskId)) errors.push("TASK_ID_NOT_FRESH");
  if (freshness.priorRoomIds?.has(evidence.room.roomId)) errors.push("ROOM_ID_NOT_FRESH");

  const start = Date.parse(evidence.startedAt);
  const end = Date.parse(evidence.completedAt);
  const temporalEvidence = [
    evidence.auth.observedAt,
    evidence.task.createdAt,
    evidence.room.createdAt,
    evidence.webMcp.discoveredAt,
    evidence.terminal.completedAt,
    evidence.platformBootstrap.at,
    ...evidence.webMcp.calls.map((call) => call.at),
    ...evidence.authoritativeCanvas.revisionObservations.map((observation) => observation.at),
  ].filter((at): at is string => at !== "unobservable");
  if (temporalEvidence.some((at) => Date.parse(at) < start || Date.parse(at) > end)) {
    errors.push("EVIDENCE_TIMESTAMP_OUTSIDE_SPIKE");
  }

  const expectedInventoryDigest = hashCanonicalJson({
    surface: "browser-exposed",
    toolNames: evidence.webMcp.toolNames,
  });
  if (expectedInventoryDigest !== evidence.webMcp.inventoryDigest) errors.push("WEBMCP_INVENTORY_DIGEST_INVALID");
  if (new Set(evidence.webMcp.toolNames).size !== evidence.webMcp.toolNames.length) errors.push("WEBMCP_TOOLS_NOT_UNIQUE");
  if (evidence.webMcp.toolNames.some((name, index) => index > 0 && evidence.webMcp.toolNames[index - 1]!.localeCompare(name) >= 0)) {
    errors.push("WEBMCP_TOOLS_NOT_SORTED");
  }

  const calls = evidence.webMcp.calls;
  if (calls.some((call, index) => call.sequence !== index)) errors.push("WEBMCP_CALL_SEQUENCE_INVALID");
  const observedCalls = calls.filter((call): call is typeof call & { at: string } => call.at !== "unobservable");
  if (observedCalls.some((call, index) => index > 0 && Date.parse(observedCalls[index - 1]!.at) > Date.parse(call.at))) {
    errors.push("WEBMCP_CALL_TIME_ORDER_INVALID");
  }
  if (calls.some((call) => !evidence.webMcp.toolNames.includes(call.toolName))) errors.push("WEBMCP_UNDISCOVERED_TOOL_USED");
  const successfulMutations = calls.filter((call) => call.kind === "mutation" && call.status === "succeeded");
  if (successfulMutations.length === 0) errors.push("WEBMCP_SUCCESSFUL_MUTATION_MISSING");
  if (evidence.room.accessMode === "invite") {
    const successfulJoin = calls.find((call) => (
      call.toolName === "join_room"
      && call.kind === "lifecycle"
      && call.status === "succeeded"
    ));
    if (successfulJoin === undefined || successfulJoin.sequence >= (successfulMutations[0]?.sequence ?? -1)) {
      errors.push("INVITE_JOIN_ROOM_CALL_MISSING");
    }
  }
  const lastMutationSequence = successfulMutations.at(-1)?.sequence ?? Number.POSITIVE_INFINITY;
  const finalAuthoritativeRead = calls.find((call) => (
    call.sequence > lastMutationSequence
    && call.toolName === "read_room_state"
    && call.kind === "read"
    && call.status === "succeeded"
    && call.authoritativeRoomRevision === evidence.authoritativeCanvas.finalRoomRevision
  ));
  if (finalAuthoritativeRead === undefined) errors.push("POST_MUTATION_AUTHORITATIVE_READ_MISSING");

  const observations = evidence.authoritativeCanvas.revisionObservations;
  if (observations.some((observation, index) => observation.sequence !== index)) errors.push("REVISION_OBSERVATION_SEQUENCE_INVALID");
  if (observations.some((observation, index) => index > 0 && observation.roomRevision < observations[index - 1]!.roomRevision)) {
    errors.push("ROOM_REVISIONS_NOT_MONOTONIC");
  }
  if (observations[0]!.roomRevision >= evidence.authoritativeCanvas.finalRoomRevision) errors.push("ROOM_REVISION_DID_NOT_ADVANCE");
  const finalObservations = observations.filter((observation) => observation.final);
  const finalObservation = finalObservations[0];
  if (
    finalObservations.length !== 1
    || finalObservation !== observations.at(-1)
    || finalObservation?.roomRevision !== evidence.authoritativeCanvas.finalRoomRevision
    || finalObservation?.semanticStateDigest !== evidence.authoritativeCanvas.semanticStateDigest
    || finalObservation?.sourceToolCallSequence !== finalAuthoritativeRead?.sequence
  ) {
    errors.push("FINAL_REVISION_OBSERVATION_INVALID");
  }
  if (observations.some((observation) => !calls.some((call) => (
    call.sequence === observation.sourceToolCallSequence
    && call.status === "succeeded"
    && call.authoritativeRoomRevision === observation.roomRevision
  )))) {
    errors.push("REVISION_OBSERVATION_CALL_UNBOUND");
  }

  const objectRevisions = evidence.authoritativeCanvas.objectRevisions;
  if (objectRevisions.length !== evidence.authoritativeCanvas.objectCount) errors.push("OBJECT_REVISION_COUNT_MISMATCH");
  if (new Set(objectRevisions.map((object) => object.semanticObjectId)).size !== objectRevisions.length) {
    errors.push("OBJECT_REVISIONS_NOT_UNIQUE");
  }
  if (objectRevisions.some((object, index) => index > 0 && objectRevisions[index - 1]!.semanticObjectId.localeCompare(object.semanticObjectId) >= 0)) {
    errors.push("OBJECT_REVISIONS_NOT_SORTED");
  }

  const { artifacts } = evidence;
  if (new Set(Object.values(artifacts).map((artifact) => artifact.sha256)).size !== Object.keys(artifacts).length) {
    errors.push("ARTIFACT_DIGESTS_NOT_UNIQUE");
  }
  if (artifacts.authPreflight.sha256 !== evidence.auth.preflightReceiptDigest) errors.push("AUTH_ARTIFACT_UNBOUND");
  if (artifacts.promptEnvelope.sha256 !== evidence.promptEnvelopeDigest) errors.push("PROMPT_ARTIFACT_UNBOUND");
  if (artifacts.taskCreationReceipt.sha256 !== evidence.task.creationReceiptDigest) errors.push("TASK_RECEIPT_ARTIFACT_UNBOUND");
  if (artifacts.roomCreationReceipt.sha256 !== evidence.room.creationReceiptDigest) errors.push("ROOM_RECEIPT_ARTIFACT_UNBOUND");
  if (artifacts.platformBootstrapTrace.sha256 !== evidence.platformBootstrap.traceArtifactDigest) errors.push("PLATFORM_BOOTSTRAP_ARTIFACT_UNBOUND");
  if (artifacts.isolationAttestation.sha256 !== evidence.isolation.attestationDigest) errors.push("ISOLATION_ARTIFACT_UNBOUND");
  if (artifacts.webMcpTrace.sha256 !== evidence.webMcp.traceArtifactDigest) errors.push("WEBMCP_TRACE_ARTIFACT_UNBOUND");
  if (artifacts.terminalResult.sha256 !== evidence.terminal.resultDigest) errors.push("TERMINAL_ARTIFACT_UNBOUND");
  if (artifacts.semanticState.sha256 !== evidence.authoritativeCanvas.semanticStateDigest) errors.push("SEMANTIC_STATE_ARTIFACT_UNBOUND");
  if (artifacts.canvasImage.sha256 !== evidence.authoritativeCanvas.canvasImageDigest) errors.push("CANVAS_IMAGE_ARTIFACT_UNBOUND");
  if (artifactSetRoot(artifacts) !== evidence.artifactSetRoot) errors.push("ARTIFACT_SET_ROOT_INVALID");
}

export function sealCodexWebMcpSpikeEvidence(contentInput: unknown): CodexWebMcpSpikeEvidence {
  const content = codexWebMcpSpikeEvidenceContentSchema.parse(contentInput);
  const evidence = codexWebMcpSpikeEvidenceSchema.parse({
    ...content,
    evidenceDigest: hashCanonicalJson(content as unknown as JsonValue),
  });
  const verification = verifyCodexWebMcpSpikeEvidence(evidence);
  if (!verification.ok) {
    throw new Error(`Cannot seal invalid Codex/WebMCP spike evidence: ${verification.errors.join(", ")}.`);
  }
  return verification.evidence;
}

export function verifyCodexWebMcpSpikeEvidence(
  evidenceInput: unknown,
  freshness: CodexWebMcpSpikeFreshnessContext = {},
): CodexWebMcpSpikeVerification {
  const parsed = codexWebMcpSpikeEvidenceSchema.safeParse(evidenceInput);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => `SCHEMA:${issue.path.join("/")}:${issue.message}`) };
  }
  const evidence = parsed.data;
  const content = contentOf(evidence);
  const errors: string[] = [];
  if (hashCanonicalJson(content as unknown as JsonValue) !== evidence.evidenceDigest) errors.push("EVIDENCE_DIGEST_INVALID");
  pushTimestampErrors(content, errors);
  if (evidence.status === "pass") pushPassErrors(evidence, errors, freshness);
  return errors.length === 0
    ? { ok: true, evidence: freezeDeep(evidence) }
    : { ok: false, errors: [...new Set(errors)].sort() };
}

export const codexWebMcpAaGateDraftSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("codex-webmcp-aa-execution-gate"),
  evaluatedAt: timestampSchema,
  spikeEvidenceDigest: digestSchema.nullable(),
  decision: z.enum(["allow", "block"]),
  reasons: z.array(z.string().min(1)).min(1),
  gateDigest: digestSchema,
}).strict();

export const codexWebMcpAaGateSchema = codexWebMcpAaGateDraftSchema.extend({
  authoritySignature: exp0001aCodexAuthoritySignatureSchema,
}).strict();

export type CodexWebMcpAaGateDraft = z.infer<typeof codexWebMcpAaGateDraftSchema>;
export type CodexWebMcpAaGate = z.infer<typeof codexWebMcpAaGateSchema>;

function gateContent(gate: Omit<CodexWebMcpAaGateDraft, "gateDigest">): JsonValue {
  return gate as unknown as JsonValue;
}

/** A/A may be released only by a verified PASS, never by a reported status alone. */
export function createCodexWebMcpAaGate(input: {
  evaluatedAt: string;
  spikeEvidence?: unknown;
  freshness?: CodexWebMcpSpikeFreshnessContext;
}): CodexWebMcpAaGateDraft {
  const verification = input.spikeEvidence === undefined
    ? { ok: false as const, errors: ["SPIKE_EVIDENCE_MISSING"] }
    : verifyCodexWebMcpSpikeEvidence(input.spikeEvidence, input.freshness);
  const gateAfterCompletion = verification.ok
    && Date.parse(input.evaluatedAt) >= Date.parse(verification.evidence.completedAt);
  const reportedPass = verification.ok && verification.evidence.status === "pass" && gateAfterCompletion;
  const reasons = reportedPass
    ? ["VERIFIED_CODEX_WEBMCP_SPIKE_PASS"]
    : verification.ok && !gateAfterCompletion
      ? ["GATE_PRECEDES_SPIKE_COMPLETION"]
      : verification.ok
      ? ["SPIKE_REPORTED_FAILURE"]
      : verification.errors;
  const content = {
    schemaVersion: 1 as const,
    kind: "codex-webmcp-aa-execution-gate" as const,
    evaluatedAt: input.evaluatedAt,
    spikeEvidenceDigest: verification.ok ? verification.evidence.evidenceDigest : null,
    decision: reportedPass ? "allow" as const : "block" as const,
    reasons,
  };
  return freezeDeep(codexWebMcpAaGateDraftSchema.parse({
    ...content,
    gateDigest: hashCanonicalJson(gateContent(content)),
  }));
}

function verifyGateDraft(input: unknown): CodexWebMcpAaGateDraft {
  const gate = codexWebMcpAaGateDraftSchema.parse(input);
  const { gateDigest: _gateDigest, ...content } = gate;
  void _gateDigest;
  if (hashCanonicalJson(gateContent(content)) !== gate.gateDigest) {
    throw new Error("Codex/WebMCP A/A gate digest is invalid.");
  }
  return gate;
}

/**
 * Attaches a separately produced signature under the frozen EXP-0001A trust
 * anchor. The exact complete gate draft, including its digest, is signed.
 */
export function authorizeCodexWebMcpAaGate(input: Readonly<{
  gate: unknown;
  authoritySignature: unknown;
}>): CodexWebMcpAaGate {
  const gate = verifyGateDraft(input.gate);
  if (gate.decision !== "allow") throw new Error("Only a verified allow gate may receive spike-gate authority.");
  const authoritySignature = exp0001aCodexAuthoritySignatureSchema.parse(input.authoritySignature);
  verifyExp0001aCodexAuthoritySignature({
    payload: gate as unknown as JsonValue,
    signature: authoritySignature,
    purpose: "spike_gate",
    notBefore: gate.evaluatedAt,
  });
  return freezeDeep(codexWebMcpAaGateSchema.parse({
    ...gate,
    authoritySignature,
  }));
}

export function verifyCodexWebMcpAaGateAuthority(gateInput: unknown): CodexWebMcpAaGate {
  const gate = codexWebMcpAaGateSchema.parse(gateInput);
  verifyGateDraft((({ authoritySignature: _authoritySignature, ...draft }) => {
    void _authoritySignature;
    return draft;
  })(gate));
  verifyExp0001aCodexAuthoritySignature({
    payload: (({ authoritySignature: _authoritySignature, ...draft }) => {
      void _authoritySignature;
      return draft as unknown as JsonValue;
    })(gate),
    signature: gate.authoritySignature,
    purpose: "spike_gate",
    notBefore: gate.evaluatedAt,
  });
  return freezeDeep(gate);
}

export function assertCodexWebMcpAaExecutionAllowed(
  gateInput: unknown,
  spikeEvidenceInput: unknown,
  freshness: CodexWebMcpSpikeFreshnessContext = {},
): CodexWebMcpAaGate {
  const gate = verifyCodexWebMcpAaGateAuthority(gateInput);
  const verification = verifyCodexWebMcpSpikeEvidence(spikeEvidenceInput, freshness);
  if (!verification.ok) throw new Error(`Codex/WebMCP A/A spike evidence is invalid: ${verification.errors.join(", ")}.`);
  if (verification.evidence.status !== "pass") throw new Error("Codex/WebMCP A/A spike did not pass.");
  if (Date.parse(gate.evaluatedAt) < Date.parse(verification.evidence.completedAt)) {
    throw new Error("Codex/WebMCP A/A gate predates spike completion.");
  }
  if (gate.spikeEvidenceDigest !== verification.evidence.evidenceDigest) {
    throw new Error("Codex/WebMCP A/A gate is not bound to the supplied spike evidence.");
  }
  if (gate.decision !== "allow" || gate.reasons.length !== 1 || gate.reasons[0] !== "VERIFIED_CODEX_WEBMCP_SPIKE_PASS") {
    throw new Error(`Codex/WebMCP A/A execution is blocked: ${gate.reasons.join(", ")}.`);
  }
  return freezeDeep(gate);
}

export const publicCodexWebMcpAaGateSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("public-codex-webmcp-aa-execution-gate"),
  evaluatedAt: timestampSchema,
  spikeEvidenceDigest: digestSchema,
  decision: z.literal("allow"),
  reasons: z.tuple([z.literal("VERIFIED_CODEX_WEBMCP_SPIKE_PASS")]),
  gateDigest: digestSchema,
  authoritySignature: exp0001aCodexAuthoritySignatureSchema,
  sensitiveMaterialRedacted: z.literal(true),
}).strict();
export type PublicCodexWebMcpAaGate = z.infer<typeof publicCodexWebMcpAaGateSchema>;

export function createPublicCodexWebMcpAaGate(gateInput: unknown): PublicCodexWebMcpAaGate {
  const gate = verifyCodexWebMcpAaGateAuthority(gateInput);
  return freezeDeep(publicCodexWebMcpAaGateSchema.parse({
    schemaVersion: 1,
    kind: "public-codex-webmcp-aa-execution-gate",
    evaluatedAt: gate.evaluatedAt,
    spikeEvidenceDigest: gate.spikeEvidenceDigest,
    decision: gate.decision,
    reasons: gate.reasons,
    gateDigest: gate.gateDigest,
    authoritySignature: gate.authoritySignature,
    sensitiveMaterialRedacted: true,
  }));
}

export const publicCodexWebMcpSpikeEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("public-codex-webmcp-disposable-spike-evidence"),
  spikeId: identifierSchema,
  status: z.enum(["pass", "fail"]),
  failureCodes: z.array(codexWebMcpSpikeFailureCodeSchema),
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  wallTimeMs: z.number().int().nonnegative(),
  privateEvidenceDigest: digestSchema,
  authMethod: z.enum(["chatgpt", "api_key", "unobservable"]),
  task: z.object({
    taskIdentityDigest: digestSchema.nullable(),
    workspaceKind: z.union([z.literal("projectless"), z.literal("unobserved")]),
    requestedModel: requestedModelSchema.nullable(),
  }).strict(),
  room: z.object({
    privateLocation: z.literal("[REDACTED]"),
    visibility: z.union([z.literal("private"), z.literal("unobserved")]),
    creationReceiptDigest: digestSchema.nullable(),
  }).strict(),
  evidence: z.object({
    webMcpInventoryDigest: digestSchema.nullable(),
    webMcpTraceDigest: digestSchema.nullable(),
    terminalResultDigest: digestSchema.nullable(),
    semanticStateDigest: digestSchema.nullable(),
    canvasImageDigest: digestSchema.nullable(),
    artifactSetRoot: digestSchema.nullable(),
    finalRoomRevision: z.number().int().positive().nullable(),
  }).strict(),
  isolation: z.object({
    repositoryAccess: z.union([z.literal("absent"), z.literal("unobserved")]),
    privateApiAccess: z.union([z.literal("absent"), z.literal("unobserved")]),
    directProviderApiRequestCount: z.number().int().nonnegative().nullable(),
    directHttpRequestCount: z.number().int().nonnegative().nullable(),
    platformBootstrap: z.union([z.literal("browser_skill_read_only"), z.literal("unobserved")]),
    platformCommandExecutionCount: z.number().int().nonnegative().nullable(),
    otherCommandExecutionCount: z.number().int().nonnegative().nullable(),
  }).strict(),
  sensitiveMaterialRedacted: z.literal(true),
}).strict();

export type PublicCodexWebMcpSpikeEvidence = z.infer<typeof publicCodexWebMcpSpikeEvidenceSchema>;

export function createPublicCodexWebMcpSpikeEvidence(evidenceInput: unknown): PublicCodexWebMcpSpikeEvidence {
  const verification = verifyCodexWebMcpSpikeEvidence(evidenceInput);
  if (!verification.ok) throw new Error(`Cannot publish invalid spike evidence: ${verification.errors.join(", ")}.`);
  const evidence = verification.evidence;
  const publicEvidence = publicCodexWebMcpSpikeEvidenceSchema.parse({
    schemaVersion: 1,
    kind: "public-codex-webmcp-disposable-spike-evidence",
    spikeId: evidence.spikeId,
    status: evidence.status,
    failureCodes: evidence.failureReasons.map((reason) => reason.code),
    startedAt: evidence.startedAt,
    completedAt: evidence.completedAt,
    wallTimeMs: evidence.wallTimeMs,
    privateEvidenceDigest: evidence.evidenceDigest,
    authMethod: evidence.auth?.method ?? "unobservable",
    task: {
      taskIdentityDigest: evidence.task === null ? null : hashCanonicalJson({
        schemaVersion: 1,
        kind: "codex-private-task-identity-commitment",
        taskId: evidence.task.taskId,
      }),
      workspaceKind: evidence.task?.workspaceKind ?? "unobserved",
      requestedModel: evidence.task?.requestedModel ?? null,
    },
    room: {
      privateLocation: "[REDACTED]",
      visibility: evidence.room?.visibility ?? "unobserved",
      creationReceiptDigest: evidence.room?.creationReceiptDigest ?? null,
    },
    evidence: {
      webMcpInventoryDigest: evidence.webMcp?.inventoryDigest ?? null,
      webMcpTraceDigest: evidence.webMcp?.traceArtifactDigest ?? null,
      terminalResultDigest: evidence.terminal?.resultDigest ?? null,
      semanticStateDigest: evidence.authoritativeCanvas?.semanticStateDigest ?? null,
      canvasImageDigest: evidence.authoritativeCanvas?.canvasImageDigest ?? null,
      artifactSetRoot: evidence.artifactSetRoot,
      finalRoomRevision: evidence.authoritativeCanvas?.finalRoomRevision ?? null,
    },
    isolation: {
      repositoryAccess: evidence.isolation?.repositoryAccess ?? "unobserved",
      privateApiAccess: evidence.isolation?.privateApiAccess ?? "unobserved",
      directProviderApiRequestCount: evidence.isolation?.directProviderApiRequestCount ?? null,
      directHttpRequestCount: evidence.isolation?.directHttpRequestCount ?? null,
      platformBootstrap: evidence.platformBootstrap === null ? "unobserved" : "browser_skill_read_only",
      platformCommandExecutionCount: evidence.platformBootstrap?.commandExecutionCount ?? null,
      otherCommandExecutionCount: evidence.platformBootstrap?.otherCommandExecutionCount ?? null,
    },
    sensitiveMaterialRedacted: true,
  });
  assertNoSecretLeakage(publicEvidence, [
    evidence.room?.roomId ?? "",
    evidence.room?.privateRoomUrl ?? "",
    evidence.room === null
      ? ""
      : (parsePrivateRoomAccessUrl(evidence.room.privateRoomUrl).inviteCode ?? ""),
  ]);
  return freezeDeep(publicEvidence);
}
