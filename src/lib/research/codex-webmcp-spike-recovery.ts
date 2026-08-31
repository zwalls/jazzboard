import { z } from "zod";
import { parse as parseJavaScript } from "acorn";

import {
  exp0001aCodexAuthoritySignatureSchema,
  verifyExp0001aCodexAuthoritySignature,
} from "./exp0001a-codex-authority";
import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const webMcpToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);

/**
 * EXP-0001A's one disposable spike is a historical, one-shot gate input, not
 * a generic "source looked plausible" attestation.  The retained read_thread
 * CallToolResult (including every Node-REPL source block) was independently
 * audited before this digest was admitted.  Reconstructing a gate from any
 * other task trace requires a new reviewed constant and a new gate version.
 */
export const EXP0001A_APPROVED_SPIKE_RAW_TASK_RECORD_DIGEST =
  "sha256:6208fd0cc3c08b218685dd9438027ff59ff0be3b37862cf602c3ba7040a449d0" as const;
export const EXP0001A_APPROVED_SPIKE_BROWSER_TRACE_DIGEST =
  "sha256:5129f1f17190ad1791c9bb92706c6fee9dca30b4bbd4a6ad546e11aeae3e3a99" as const;

export const EXP0001A_CODEX_SPIKE_RECOVERY_GATE_VERSION =
  "exp-0001a-codex-webmcp-spike-recovery-gate/v2" as const;
export const EXP0001A_CODEX_SPIKE_MODEL = "gpt-5.6-sol" as const;
export const EXP0001A_CODEX_SPIKE_REASONING = "max" as const;

/** These signatures were created before raw Codex/Jazzboard authority was
 * bound, or were production-key signatures over synthetic test material. */
export const EXP0001A_REVOKED_SPIKE_GATE_PAYLOAD_DIGESTS = Object.freeze([
  "sha256:8a544d5422f8bd998f6d6919faa37f0b6d2fbba63d569e849104dde5188d7e4a",
  "sha256:2bb94e7ea7bfffbdfaadc1a0c7ba8d53ce45223e9aef779208210d611dd68b66",
] as const);

const taskEvidenceSchema = z.object({
  taskIdentityDigest: digestSchema,
  turnIdentityDigest: digestSchema,
  workspaceKind: z.literal("projectless"),
  requestedModel: z.object({
    id: z.literal(EXP0001A_CODEX_SPIKE_MODEL),
    reasoningEffort: z.literal(EXP0001A_CODEX_SPIKE_REASONING),
  }).strict(),
  observedResolvedModel: z.literal("unobservable"),
  observedResolvedReasoningEffort: z.literal("unobservable"),
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  wallTimeMs: z.number().int().positive(),
  sourceTaskIdentityDigest: z.null(),
  forkedFromTaskIdentityDigest: z.null(),
  sharedHistory: z.literal(false),
  commandExecutionCount: z.literal(1),
  nodeReplCallCount: z.number().int().positive(),
  browserSkillReadCount: z.literal(1),
  projectOrRepositoryReadCount: z.literal(0),
  filesystemWriteCount: z.literal(0),
  directHttpRequestCount: z.literal(0),
  directProviderApiRequestCount: z.literal(0),
  browserTraceDigest: z.literal(EXP0001A_APPROVED_SPIKE_BROWSER_TRACE_DIGEST),
  terminalResultDigest: digestSchema,
}).strict();

const webMcpEvidenceSchema = z.object({
  surface: z.literal("browser-exposed"),
  discoveryObserved: z.literal(true),
  callCount: z.number().int().positive(),
  failureCount: z.literal(0),
  callSequence: z.array(webMcpToolNameSchema).min(2).max(1_000),
  usedToolNames: z.array(webMcpToolNameSchema).min(2).max(256),
  successfulAuthoritativeTransactionCount: z.number().int().positive(),
  inspectionObserved: z.literal(true),
  postMutationAuthoritativeReadObserved: z.literal(true),
}).strict();

const roomEvidenceSchema = z.object({
  visibility: z.literal("private"),
  freshProvisioningObserved: z.literal(true),
  accessMode: z.literal("invite"),
  roomAccessBindingDigest: digestSchema,
  roomIdentityDigest: digestSchema,
  coordinatorChallengeDigest: digestSchema,
  actorParticipantBindingDigest: digestSchema,
  finalRoomRevision: z.number().int().positive(),
  finalDiagramRevision: z.number().int().positive(),
  finalDiagramIdentityDigest: digestSchema,
  objectCount: z.number().int().positive(),
  diagramCount: z.literal(1),
  authoritativeTransactionCount: z.number().int().positive(),
  semanticStateDigest: digestSchema,
  diagramStateDigest: digestSchema,
  activityDigest: digestSchema,
  layoutStatus: z.enum(["pass", "fail"]),
  layoutFindingCount: z.number().int().nonnegative(),
  exactRevisionInspectionObserved: z.literal(true),
}).strict();

const rawAuthoritySchema = z.object({
  preSpikeAuthReceiptDigest: digestSchema,
  signingAuthReceiptDigest: digestSchema,
  roomProvisioningPlanDigest: digestSchema,
  roomProvisioningReceiptDigest: digestSchema,
  taskProvisioningPlanDigest: digestSchema,
  taskCreationCallResultDigest: digestSchema,
  rawTaskRecordDigest: digestSchema,
  authoritativeJazzboardRecoveryDigest: digestSchema,
}).strict();

export const exp0001aCodexSpikeRecoveryEvidenceSchema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("codex-webmcp-spike-recovery-evidence"),
  authMethod: z.literal("chatgpt"),
  subscriptionPlan: z.literal("unobservable"),
  task: taskEvidenceSchema,
  webMcp: webMcpEvidenceSchema,
  room: roomEvidenceSchema,
  rawAuthority: rawAuthoritySchema,
}).strict();

export type Exp0001aCodexSpikeRecoveryEvidence = z.infer<
  typeof exp0001aCodexSpikeRecoveryEvidenceSchema
>;

const recoveryGateDraftContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_SPIKE_RECOVERY_GATE_VERSION),
  protocolId: z.literal("EXP-0001A"),
  kind: z.literal("codex-webmcp-spike-recovery-gate"),
  evaluatedAt: timestampSchema,
  decision: z.literal("allow"),
  reasons: z.tuple([z.literal("VERIFIED_CODEX_NATIVE_PROJECTLESS_WEBMCP_SPIKE")]),
  evidence: exp0001aCodexSpikeRecoveryEvidenceSchema,
  evidenceDigest: digestSchema,
}).strict();

export const exp0001aCodexSpikeRecoveryGateDraftSchema = recoveryGateDraftContentSchema.extend({
  gateDigest: digestSchema,
}).strict();

export const exp0001aCodexSpikeRecoveryGateSchema = exp0001aCodexSpikeRecoveryGateDraftSchema.extend({
  authoritySignature: exp0001aCodexAuthoritySignatureSchema,
}).strict();

export type Exp0001aCodexSpikeRecoveryGateDraft = z.infer<
  typeof exp0001aCodexSpikeRecoveryGateDraftSchema
>;
export type Exp0001aCodexSpikeRecoveryGate = z.infer<
  typeof exp0001aCodexSpikeRecoveryGateSchema
>;

type PlainRecord = Record<string, unknown>;

function record(value: unknown, label: string): PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as PlainRecord;
}

function exactKeys(value: unknown, expected: readonly string[], label: string): PlainRecord {
  const parsed = record(value, label);
  const observed = Object.keys(parsed).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(observed) !== canonicalJson(wanted)) {
    throw new Error(`${label} has an unexpected field set.`);
  }
  return parsed;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer.`);
  return value as number;
}

function integerLike(value: unknown, label: string): number {
  const parsed = typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
    ? Number(value)
    : value;
  return integer(parsed, label);
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function nullable(value: unknown, label: string): null {
  if (value !== null) throw new Error(`${label} must be null.`);
  return null;
}

function assertEqual(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left as JsonValue) !== canonicalJson(right as JsonValue)) {
    throw new Error(`${label} differs from its authoritative source.`);
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function asTimestamp(epochSeconds: number): string {
  return new Date(epochSeconds * 1_000).toISOString();
}

const taskProvisioningPlanContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-spike-task-provisioning/v1"),
  issuedAt: timestampSchema,
  coordinatorChallenge: z.string().regex(/^spike_[a-f0-9]{32}$/),
  toolName: z.literal("mcp__codex_app__create_thread"),
  arguments: z.object({
    prompt: z.string().min(20),
    target: z.object({
      type: z.literal("projectless"),
      directoryName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    }).strict(),
    model: z.literal(EXP0001A_CODEX_SPIKE_MODEL),
    thinking: z.literal(EXP0001A_CODEX_SPIKE_REASONING),
    title: z.string().min(1).max(200),
  }).strict(),
}).strict();

const taskProvisioningPlanSchema = taskProvisioningPlanContentSchema.extend({
  commandDigest: digestSchema,
}).strict();

const roomProvisioningPlanContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-spike-room-provisioning/v1"),
  issuedAt: timestampSchema,
  origin: z.literal("https://www.jazzboard.xyz"),
  toolName: z.literal("create_room"),
  arguments: z.object({
    displayName: z.string().min(1).max(48),
    title: z.string().min(1).max(100),
  }).strict(),
}).strict();

const roomProvisioningPlanSchema = roomProvisioningPlanContentSchema.extend({
  commandDigest: digestSchema,
}).strict();

const taskCreationCallResultSchema = z.object({
  content: z.tuple([z.object({ type: z.literal("text"), text: z.string().min(1) }).strict()]),
  isError: z.literal(false),
}).strict();

const codexAuthReceiptSchema = z.object({
  schemaVersion: z.literal("codex-chatgpt-auth-preflight/v1"),
  checkedAt: timestampSchema,
  command: z.object({
    executable: z.literal("codex"),
    arguments: z.tuple([z.literal("login"), z.literal("status")]),
  }).strict(),
  authentication: z.object({
    method: z.literal("chatgpt"),
    accountIdentifier: z.object({ observability: z.literal("unobservable"), value: z.null() }).strict(),
    subscriptionPlan: z.object({ observability: z.literal("unobservable"), value: z.null() }).strict(),
  }).strict(),
  observation: z.object({
    exitCode: z.object({ observability: z.literal("observed"), value: z.literal(0) }).strict(),
    signal: z.object({ observability: z.literal("unobservable"), value: z.null() }).strict(),
    stdoutSha256: z.object({ observability: z.literal("observed"), value: digestSchema }).strict(),
    stderrSha256: z.object({ observability: z.literal("observed"), value: digestSchema }).strict(),
    rawOutputRetained: z.literal(false),
    outputLimitExceeded: z.literal(false),
    invocationError: z.literal(false),
  }).strict(),
  decision: z.object({
    allowCodexNativeExperiment: z.literal(true),
    reasonCode: z.literal("CHATGPT_AUTHENTICATED"),
  }).strict(),
  receiptSha256: digestSchema,
}).strict();

function verifyAuthReceipt(input: unknown): z.infer<typeof codexAuthReceiptSchema> {
  const receipt = codexAuthReceiptSchema.parse(input);
  const { receiptSha256: _digest, ...content } = receipt;
  void _digest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== receipt.receiptSha256) {
    throw new Error("Codex ChatGPT-auth preflight receipt digest is invalid.");
  }
  return receipt;
}

const ROOM_INVITE_PATTERN = /^https:\/\/www\.jazzboard\.xyz\/#join=([A-HJ-NP-Z2-9]{6})$/;

function extractDelegatedPrompt(taskRaw: PlainRecord): string {
  const turns = list(taskRaw.turns, "Codex task turns");
  if (turns.length !== 1) throw new Error("Disposable spike task must contain exactly one turn.");
  const turn = record(turns[0], "Codex task turn");
  const items = list(turn.items, "Codex task items");
  const promptOutputs = items.filter((item) => {
    const candidate = record(item, "Codex task item");
    return candidate.type === "functionCallOutput"
      && candidate.namespace === "codex_app"
      && candidate.name === "create_thread";
  });
  if (promptOutputs.length !== 1) throw new Error("Disposable task must retain exactly one create_thread prompt record.");
  const output = exactKeys(record(promptOutputs[0], "Prompt output").output, ["text", "truncated"], "Prompt output body");
  if (bool(output.truncated, "Prompt output truncation")) throw new Error("Disposable task prompt is truncated.");
  const delegated = text(output.text, "Disposable task prompt");
  const match = /^<codex_delegation>\n  <source_thread_id>[A-Za-z0-9-]+<\/source_thread_id>\n  <input>([\s\S]*)<\/input>\n<\/codex_delegation>\n?$/.exec(delegated);
  if (match === null) throw new Error("Disposable task does not retain one exact delegated input envelope.");
  return match[1]!;
}

function parseRoomAccess(prompt: string): { url: string; mode: "invite"; code: string; roomId: null } {
  const urls = prompt.match(/https:\/\/www\.jazzboard\.xyz[^\s<]+/g) ?? [];
  if (urls.length !== 1) throw new Error("Disposable task prompt must contain exactly one Jazzboard location.");
  const url = urls[0]!.replace(/[).,]+$/, "");
  const invite = ROOM_INVITE_PATTERN.exec(url);
  if (invite !== null) return { url, mode: "invite", code: invite[1]!, roomId: null };
  throw new Error("Disposable task prompt must contain one exact private Jazzboard invite.");
}

function assertCleanRoomPrompt(prompt: string): void {
  const requiredBoundaries = [
    /\bno repository\b/i,
    /\bproject\b/i,
    /\bsource code\b/i,
    /\bprivate API\b/i,
    /\bdirect HTTP request\b/i,
    /\binherited conversation history\b/i,
    /\bprepared coordinates\b/i,
    /\bevaluator context\b/i,
    /\bno coordinates are supplied\b/i,
  ];
  if (requiredBoundaries.some((pattern) => !pattern.test(prompt))
      || /\b(?:x|y|width|height)\s*[:=]\s*-?\d/i.test(prompt)) {
    throw new Error("Disposable task prompt is not the frozen clean-room, no-coordinate brief.");
  }
}

const FORBIDDEN_NODE_IDENTIFIERS = new Set([
  "AsyncFunction",
  "Bun",
  "Deno",
  "Function",
  "SharedWorker",
  "WebAssembly",
  "WebSocket",
  "Worker",
  "XMLHttpRequest",
  "child_process",
  "eval",
  "exports",
  "fetch",
  "global",
  "globalThis",
  "http",
  "https",
  "module",
  "process",
  "require",
]);

const FORBIDDEN_CAPABILITY_PROPERTIES = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "_compile",
  "_linkedBinding",
  "appendFile",
  "appendFileSync",
  "assign",
  "binding",
  "bind",
  "compileFunction",
  "constructor",
  "createRequire",
  "defineProperties",
  "defineProperty",
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fetch",
  "getBuiltinModule",
  "getOwnPropertyDescriptor",
  "getPrototypeOf",
  "mainModule",
  "open",
  "openSync",
  "prototype",
  "readFile",
  "readFileSync",
  "request",
  "set",
  "setPrototypeOf",
  "spawn",
  "spawnSync",
  "writeFile",
  "writeFileSync",
]);

const BROWSER_CLIENT_IMPORT_SUFFIX =
  "/browser/26.825.51511/scripts/browser-client.mjs";

function assertStaticBrowserProgram(program: AstNode, roomUrl: string): Readonly<{
  imports: readonly string[];
  browserSelectionCount: number;
  freshTabCount: number;
  gotoCount: number;
}> {
  const imports: string[] = [];
  let browserSelectionCount = 0;
  let freshTabCount = 0;
  let gotoCount = 0;
  walkAst(program, (node) => {
    if (node.type === "Identifier" && typeof node.name === "string"
        && FORBIDDEN_NODE_IDENTIFIERS.has(node.name)) {
      throw new Error(`Disposable task referenced forbidden Node capability identifier ${node.name}.`);
    }
    if (["AssignmentExpression", "UpdateExpression", "MetaProperty", "ThisExpression"].includes(node.type)
        || (node.type === "UnaryExpression" && node.operator === "delete")) {
      throw new Error("Disposable task may not mutate or dynamically escape its frozen Browser bindings.");
    }
    if (node.type === "ImportExpression") {
      const imported = stringLiteral(node.source);
      if (imported === null || !imported.endsWith(BROWSER_CLIENT_IMPORT_SUFFIX)) {
        throw new Error("Disposable task may import only the frozen browser client bootstrap.");
      }
      imports.push(imported);
    }
    if (node.type === "NewExpression") {
      if (identifierName(node.callee) !== "Error") {
        throw new Error("Disposable task may construct only fail-closed Error values.");
      }
    }
    if (node.type === "MemberExpression") {
      if (node.computed === true) {
        const property = astNode(node.property);
        if (property?.type !== "Literal" || typeof property.value !== "number"
            || !Number.isSafeInteger(property.value) || property.value < 0) {
          throw new Error("Disposable task used a computed capability member.");
        }
      } else {
        const property = identifierName(node.property);
        if (property !== null && FORBIDDEN_CAPABILITY_PROPERTIES.has(property)) {
          throw new Error(`Disposable task referenced forbidden capability member ${property}.`);
        }
      }
    }
    if (node.type !== "CallExpression") return;
    const directCallee = identifierName(node.callee);
    if (directCallee !== null && directCallee !== "setupBrowserRuntime") {
      throw new Error(`Disposable task invoked unapproved direct callable ${directCallee}.`);
    }
    const callee = memberName(node.callee);
    if (directCallee === null && callee === null) {
      throw new Error("Disposable task invoked a computed or dynamically produced callable.");
    }
    if (callee?.property === "get" && canonicalJson(memberPath(callee.object) as unknown as JsonValue)
        === canonicalJson(["agent", "browsers"])) {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (args.length !== 1 || stringLiteral(args[0]) !== "iab") {
        throw new Error("Disposable task may select only the isolated in-app browser.");
      }
      browserSelectionCount += 1;
    }
    const freshTabPath = callee?.property === "new" ? memberPath(callee.object) : null;
    if (callee?.property === "new" && freshTabPath !== null
        && freshTabPath.length === 2 && freshTabPath[1] === "tabs"
        && ["iab", "browser"].includes(freshTabPath[0]!)) {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (args.length !== 0) throw new Error("Disposable task fresh-tab creation accepts no arguments.");
      freshTabCount += 1;
    }
    if (callee?.property === "goto") {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (args.length < 1 || stringLiteral(args[0]) !== roomUrl) {
        throw new Error("Disposable task attempted browser navigation outside its exact private invite.");
      }
      gotoCount += 1;
    }
  });
  return Object.freeze({
    imports: Object.freeze(imports),
    browserSelectionCount,
    freshTabCount,
    gotoCount,
  });
}

function assertBrowserOnlyNodeCode(codeBlocks: readonly string[], roomUrl: string): void {
  const source = codeBlocks.join("\n");
  const forbidden = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\bnavigator\.sendBeacon\b/,
    /\brequire\s*\(/,
    /\b(?:child_process|node:fs|node:http|node:https|node:net|node:tls|node:dns)\b/,
    /\b(?:readFile|writeFile|appendFile|execFile|spawn|execSync)\s*\(/,
    /api\.openai\.com/i,
    /OPENAI_API_KEY/,
    /\bBearer\s+[A-Za-z0-9._-]+/,
    /\bopenTabs\s*\(/,
    /\.tabs\.(?:list|get)\s*\(/,
  ];
  if (forbidden.some((pattern) => pattern.test(source))) {
    throw new Error("Disposable task executed a forbidden non-browser access surface.");
  }
  const imports: string[] = [];
  let browserSelectionCount = 0;
  let freshTabCount = 0;
  let gotoCount = 0;
  for (const codeBlock of codeBlocks) {
    const program = parseJavaScript(codeBlock, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
    }) as unknown as AstNode;
    const staticEvidence = assertStaticBrowserProgram(program, roomUrl);
    imports.push(...staticEvidence.imports);
    browserSelectionCount += staticEvidence.browserSelectionCount;
    freshTabCount += staticEvidence.freshTabCount;
    gotoCount += staticEvidence.gotoCount;
    walkAst(program, (node) => {
      const member = memberName(node);
      if (member !== null && identifierName(member.object) === "tools") {
        throw new Error("Disposable task executed a forbidden non-browser tool surface.");
      }
    });
  }
  if (imports.length !== 1 || !imports[0]!.endsWith(BROWSER_CLIENT_IMPORT_SUFFIX)) {
    throw new Error("Disposable task may import only the frozen browser client bootstrap.");
  }
  if (browserSelectionCount !== 1 || freshTabCount !== 1 || gotoCount !== 1) {
    throw new Error("Disposable task must select one in-app browser, create one tab, and navigate once to its invite.");
  }
  const postJoinRoomPattern = "https://www.jazzboard.xyz/room/**";
  const urls = [...source.matchAll(/https?:\/\/[^'"\s)]+/g)].map((match) => match[0]);
  if (urls.some((url) => url !== roomUrl && url !== postJoinRoomPattern)) {
    throw new Error("Disposable task code referenced a URL other than its exact private Jazzboard location.");
  }
  const sourceFreshTabCount = (source.match(/\.tabs\.new\s*\(\s*\)/g) ?? []).length;
  const inviteNavigation = source.indexOf(`.goto("${roomUrl}")`);
  const discovery = source.indexOf("fetchTools()");
  if (sourceFreshTabCount !== 1 || inviteNavigation < 0 || discovery < 0 || inviteNavigation > discovery) {
    throw new Error("Disposable task did not start from exactly one new tab navigated to its invite before WebMCP discovery.");
  }
  const postJoinWait = source.indexOf(`.waitForURL("${postJoinRoomPattern}"`);
  const joinCall = source.indexOf('.call("join_room"');
  if (urls.filter((url) => url === postJoinRoomPattern).length > 1
      || (postJoinWait >= 0 && (joinCall < 0 || postJoinWait < joinCall))) {
    throw new Error("Disposable task used the post-join room navigation pattern outside the join transition.");
  }
  if (!/const\s+landingTools\s*=\s*await\s+\w+\.fetchTools\s*\(\s*\)/.test(source)
      || !/const\s+roomTools\s*=\s*await\s+\w+\.fetchTools\s*\(\s*\)/.test(source)) {
    throw new Error("Disposable task did not bind its landing and room WebMCP discoveries to the frozen tool-set names.");
  }
}

function memberPath(value: unknown): string[] | null {
  const node = astNode(value);
  if (node?.type === "Identifier" && typeof node.name === "string") return [node.name];
  const member = memberName(node);
  if (member === null) return null;
  const parent = memberPath(member.object);
  return parent === null ? null : [...parent, member.property];
}

function transactionBindsJoinedParticipant(
  codeBlocks: readonly string[],
  coordinatorChallenge: string,
): boolean {
  const boundParticipantVariables = new Set<string>();
  let taggedParticipantVariable: string | null = null;
  let challengeTagObserved = false;
  let collaborationIdentityGuardObserved = false;
  for (const source of codeBlocks) {
    const program = parseJavaScript(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
    }) as unknown as AstNode;
    walkAst(program, (node) => {
      if (node.type === "VariableDeclarator") {
        const declaredName = identifierName(node.id);
        const sourcePath = memberPath(node.init);
        if (declaredName === "resolvedParticipantId"
            && canonicalJson(sourcePath as unknown as JsonValue)
              === canonicalJson(["collaborationResult", "data", "session", "participantId"])) {
          boundParticipantVariables.add(declaredName);
        }
      }
      if (node.type === "IfStatement") {
        const test = astNode(node.test);
        const consequent = astNode(node.consequent);
        const throws = consequent?.type === "ThrowStatement"
          || (consequent?.type === "BlockStatement"
            && Array.isArray(consequent.body)
            && consequent.body.length === 1
            && astNode(consequent.body[0])?.type === "ThrowStatement");
        if (test?.type === "BinaryExpression" && test.operator === "!==" && throws) {
          const leftPath = memberPath(test.left);
          const rightPath = memberPath(test.right);
          const selfPath = ["finalRoomStateResult", "data", "room", "selfParticipantId"];
          if ((canonicalJson(leftPath as unknown as JsonValue) === canonicalJson(selfPath)
              && identifierName(test.right) === "resolvedParticipantId")
              || (canonicalJson(rightPath as unknown as JsonValue) === canonicalJson(selfPath)
                && identifierName(test.left) === "resolvedParticipantId")) {
            collaborationIdentityGuardObserved = true;
          }
        }
      }
      if (node.type !== "CallExpression") return;
      const callee = memberName(node.callee);
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (callee?.property !== "call" || stringLiteral(args[0]) !== "apply_canvas_transaction") return;
      const transactionInput = astNode(args[1]);
      if (transactionInput === null) return;
      walkAst(transactionInput, (candidate) => {
        if (candidate.type === "Literal"
            && candidate.value === `spike-challenge:${coordinatorChallenge}`) {
          challengeTagObserved = true;
        }
        if (candidate.type !== "TemplateLiteral"
            || !Array.isArray(candidate.quasis)
            || !Array.isArray(candidate.expressions)
            || candidate.quasis.length !== 2
            || candidate.expressions.length !== 1) return;
        const head = astNode(candidate.quasis[0]);
        const tail = astNode(candidate.quasis[1]);
        const headValue = record(head?.value, "Participant tag template head");
        const tailValue = record(tail?.value, "Participant tag template tail");
        if (headValue.cooked === "spike-participant:"
            && tailValue.cooked === ""
            && identifierName(candidate.expressions[0]) !== null) {
          taggedParticipantVariable = identifierName(candidate.expressions[0]);
        }
      });
    });
  }
  if (taggedParticipantVariable === null || !boundParticipantVariables.has(taggedParticipantVariable)) return false;
  const collaborationBinding = taggedParticipantVariable === "resolvedParticipantId"
    && collaborationIdentityGuardObserved;
  return collaborationBinding && challengeTagObserved;
}

function observedTitleMatchesProvisioning(observedTitle: unknown, plannedTitle: string): boolean {
  if (observedTitle === plannedTitle) return true;
  if (typeof observedTitle !== "string" || !observedTitle.endsWith("…")) return false;
  const retainedPrefix = observedTitle.slice(0, -1);
  return retainedPrefix.length >= 24 && plannedTitle.startsWith(retainedPrefix);
}

type AstNode = Readonly<{ type: string; [key: string]: unknown }>;

function astNode(value: unknown): AstNode | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === "string"
    ? value as AstNode
    : null;
}

function walkAst(node: AstNode, visit: (candidate: AstNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc", "range"].includes(key)) continue;
    const child = astNode(value);
    if (child !== null) walkAst(child, visit);
    else if (Array.isArray(value)) {
      for (const item of value) {
        const arrayChild = astNode(item);
        if (arrayChild !== null) walkAst(arrayChild, visit);
      }
    }
  }
}

function identifierName(value: unknown): string | null {
  const node = astNode(value);
  return node?.type === "Identifier" && typeof node.name === "string" ? node.name : null;
}

function stringLiteral(value: unknown): string | null {
  const node = astNode(value);
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : null;
}

function memberName(value: unknown): { object: AstNode; property: string } | null {
  const node = astNode(value);
  if (node?.type !== "MemberExpression" || node.computed === true) return null;
  const object = astNode(node.object);
  const property = identifierName(node.property);
  return object !== null && property !== null ? { object, property } : null;
}

function awaitedCall(value: unknown): AstNode | null {
  const node = astNode(value);
  const awaited = node?.type === "AwaitExpression" ? astNode(node.argument) : null;
  return awaited?.type === "CallExpression" ? awaited : null;
}

function isImmediateOkThrowGuard(value: unknown, resultName: string): boolean {
  const statement = astNode(value);
  if (statement?.type !== "IfStatement" || statement.alternate !== null) return false;
  const test = astNode(statement.test);
  const unary = test?.type === "UnaryExpression" && test.operator === "!" ? astNode(test.argument) : null;
  const okMember = memberName(unary);
  const guardedName = okMember === null ? null : identifierName(okMember.object);
  const consequent = astNode(statement.consequent);
  const directThrow = consequent?.type === "ThrowStatement";
  const blockBody = consequent?.type === "BlockStatement" && Array.isArray(consequent.body)
    ? consequent.body.map(astNode).filter((node): node is AstNode => node !== null)
    : [];
  return okMember?.property === "ok" && guardedName === resultName
    && (directThrow || (blockBody.length === 1 && blockBody[0]!.type === "ThrowStatement"));
}

function extractVerifiedWebMcpCalls(codeBlocks: readonly string[]): string[] {
  const calls: string[] = [];
  for (const source of codeBlocks) {
    const program = parseJavaScript(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
    }) as unknown as AstNode;
    const body = Array.isArray(program.body) ? program.body : [];
    let totalCallExpressions = 0;
    walkAst(program, (node) => {
      if (node.type === "TryStatement") throw new Error("Disposable task may not catch or suppress WebMCP failures.");
      if (node.type === "CallExpression" && memberName(node.callee)?.property === "call") totalCallExpressions += 1;
    });
    let verifiedInBlock = 0;
    for (let index = 0; index < body.length; index += 1) {
      const statement = astNode(body[index]);
      if (statement?.type !== "VariableDeclaration" || !Array.isArray(statement.declarations)) continue;
      for (const declarationValue of statement.declarations) {
        const declaration = astNode(declarationValue);
        if (declaration?.type !== "VariableDeclarator") continue;
        const resultName = identifierName(declaration.id);
        const call = awaitedCall(declaration.init);
        const callee = call === null ? null : memberName(call.callee);
        if (resultName === null || call === null || callee?.property !== "call") continue;
        const toolSetName = identifierName(callee.object);
        if (toolSetName !== "landingTools" && toolSetName !== "roomTools") {
          throw new Error("Disposable task called WebMCP through an unbound tool-set object.");
        }
        const args = Array.isArray(call.arguments) ? call.arguments : [];
        const toolName = stringLiteral(args[0]);
        if (toolName === null || !/^[a-z][a-z0-9_]*$/.test(toolName)) {
          throw new Error("Disposable task used a computed or invalid WebMCP tool name.");
        }
        if (!isImmediateOkThrowGuard(body[index + 1], resultName)) {
          throw new Error(`Disposable task did not immediately fail closed after ${toolName}.`);
        }
        calls.push(toolName);
        verifiedInBlock += 1;
      }
    }
    if (verifiedInBlock !== totalCallExpressions) {
      throw new Error("Disposable task contains an unverified or control-flow-hidden WebMCP call.");
    }
  }
  return calls;
}

export function verifyExp0001aCodexSpikeBrowserTrace(input: Readonly<{
  codeBlocks: readonly string[];
  roomUrl: string;
}>): readonly string[] {
  const roomUrl = text(input.roomUrl, "Disposable task room URL");
  if (ROOM_INVITE_PATTERN.exec(roomUrl) === null) {
    throw new Error("Disposable task trace requires one exact private Jazzboard invite.");
  }
  if (!Array.isArray(input.codeBlocks) || input.codeBlocks.length === 0) {
    throw new Error("Disposable task trace requires retained Node REPL source blocks.");
  }
  assertBrowserOnlyNodeCode(input.codeBlocks, roomUrl);
  return Object.freeze(extractVerifiedWebMcpCalls(input.codeBlocks));
}

function objectIdentityList(objects: unknown[]): Array<{ objectId: string; revision: number }> {
  return objects.map((value, index) => {
    const object = record(value, `Canvas object ${index}`);
    return { objectId: text(object.id, `Canvas object ${index} id`), revision: integer(object.revision, `Canvas object ${index} revision`) };
  }).sort((left, right) => left.objectId.localeCompare(right.objectId));
}

export type Exp0001aCodexSpikeRecoveryInput = Readonly<{
  evaluatedAt: string;
  preSpikeAuthEvidence: unknown;
  signingAuthReceipt: unknown;
  roomProvisioningPlan: unknown;
  roomProvisioningReceipt: unknown;
  taskProvisioningPlan: unknown;
  taskCreationCallResult: unknown;
  rawTaskRecord: unknown;
  authoritativeJazzboardRecovery: unknown;
  rawDigests: Readonly<{
    preSpikeAuthReceiptDigest: string;
    roomProvisioningPlanDigest: string;
    roomProvisioningReceiptDigest: string;
    taskProvisioningPlanDigest: string;
    taskCreationCallResultDigest: string;
    rawTaskRecordDigest: string;
    authoritativeJazzboardRecoveryDigest: string;
  }>;
}>;

export function reconstructExp0001aCodexSpikeRecoveryEvidence(
  input: Exp0001aCodexSpikeRecoveryInput,
): Exp0001aCodexSpikeRecoveryEvidence {
  const evaluatedAt = timestampSchema.parse(input.evaluatedAt);
  if (digestSchema.parse(input.rawDigests.rawTaskRecordDigest)
      !== EXP0001A_APPROVED_SPIKE_RAW_TASK_RECORD_DIGEST) {
    throw new Error("Disposable spike raw task record is not the independently audited one-shot trace.");
  }
  const preAuth = verifyAuthReceipt(input.preSpikeAuthEvidence);
  const signingAuth = verifyAuthReceipt(input.signingAuthReceipt);
  const roomPlan = roomProvisioningPlanSchema.parse(input.roomProvisioningPlan);
  const { commandDigest: _roomCommandDigest, ...roomPlanContent } = roomPlan;
  void _roomCommandDigest;
  if (hashCanonicalJson(roomPlanContent as unknown as JsonValue) !== roomPlan.commandDigest) {
    throw new Error("Codex spike room provisioning plan digest is invalid.");
  }
  const taskPlan = taskProvisioningPlanSchema.parse(input.taskProvisioningPlan);
  const { commandDigest: _commandDigest, ...taskPlanContent } = taskPlan;
  void _commandDigest;
  if (hashCanonicalJson(taskPlanContent as unknown as JsonValue) !== taskPlan.commandDigest) {
    throw new Error("Codex spike task provisioning plan digest is invalid.");
  }
  const creationCall = taskCreationCallResultSchema.parse(input.taskCreationCallResult);
  let creationResult: PlainRecord;
  try {
    creationResult = record(JSON.parse(creationCall.content[0].text), "Codex create_thread result");
  } catch (error) {
    throw new Error("Codex create_thread result is not exact JSON.", { cause: error });
  }
  const taskRaw = exactKeys(input.rawTaskRecord, ["schemaVersion", "thread", "turns", "page"], "Raw Codex task record");
  if (taskRaw.schemaVersion !== 1) throw new Error("Raw Codex task record schema is unsupported.");
  const thread = exactKeys(taskRaw.thread, ["id", "kind", "hostId", "title", "preview", "status", "cwd", "createdAt", "updatedAt"], "Raw Codex thread");
  const page = exactKeys(taskRaw.page, ["order", "limit", "nextCursor", "hasMore"], "Raw Codex task page");
  if (page.order !== "newest_first" || bool(page.hasMore, "Raw Codex page hasMore") || page.nextCursor !== null) {
    throw new Error("Raw Codex task record is not a complete one-page history.");
  }
  const taskId = text(creationResult.threadId, "Created Codex task id");
  const hostId = text(creationResult.hostId, "Created Codex host id");
  const projectlessOutputDirectory = text(creationResult.projectlessOutputDirectory, "Created projectless output directory");
  const workspaceDirectory = projectlessOutputDirectory.replace(/\/outputs$/, "");
  if (workspaceDirectory === projectlessOutputDirectory
      || thread.kind !== "codex" || thread.id !== taskId || thread.hostId !== hostId
      || thread.cwd !== workspaceDirectory
      || !observedTitleMatchesProvisioning(thread.title, taskPlan.arguments.title)
      || workspaceDirectory.split("/").at(-1) !== taskPlan.arguments.target.directoryName) {
    throw new Error("Raw Codex thread does not match its creation receipt.");
  }
  const turns = list(taskRaw.turns, "Raw Codex turns");
  const turn = exactKeys(turns[0], ["id", "status", "startedAt", "completedAt", "durationMs", "error", "items"], "Raw Codex turn");
  const turnId = text(turn.id, "Codex terminal turn id");
  const startedAtEpochSeconds = integer(turn.startedAt, "Codex turn start");
  const completedAtEpochSeconds = integer(turn.completedAt, "Codex turn completion");
  const turnDurationMs = integer(turn.durationMs, "Codex turn duration");
  if (turns.length !== 1 || turn.status !== "completed" || turn.error !== null) {
    throw new Error("Raw Codex task does not contain one completed terminal turn.");
  }
  const timestampWallTimeMs = (completedAtEpochSeconds - startedAtEpochSeconds) * 1_000;
  // read_thread exposes turn endpoints at whole-second precision while
  // durationMs retains millisecond precision. Their difference must fit
  // entirely inside that two-endpoint quantization window.
  if (completedAtEpochSeconds <= startedAtEpochSeconds
      || turnDurationMs <= 0
      || Math.abs(timestampWallTimeMs - turnDurationMs) >= 1_000) {
    throw new Error("Codex task receipt wall time is internally inconsistent.");
  }
  if (Date.parse(taskPlan.issuedAt) > startedAtEpochSeconds * 1_000
      || Date.parse(evaluatedAt) < completedAtEpochSeconds * 1_000) {
    throw new Error("Spike recovery gate cannot predate task completion.");
  }

  const prompt = extractDelegatedPrompt(taskRaw);
  if (prompt !== taskPlan.arguments.prompt) throw new Error("Raw Codex task prompt differs from the frozen create_thread command.");
  const access = parseRoomAccess(prompt);
  assertCleanRoomPrompt(prompt);
  if (!prompt.includes(taskPlan.coordinatorChallenge)) {
    throw new Error("Disposable task prompt is not bound to its coordinator challenge.");
  }

  const items = list(turn.items, "Raw Codex task items").map((item, index) => record(item, `Raw Codex item ${index}`));
  const commandItems = items.filter((item) => item.type === "commandExecution");
  if (commandItems.length !== 1) throw new Error("Disposable task must have exactly one platform-bootstrap command.");
  const bootstrap = exactKeys(commandItems[0], ["type", "id", "command", "cwd", "status", "exitCode", "durationMs", "output"], "Browser-skill bootstrap command");
  const bootstrapOutput = exactKeys(bootstrap.output, ["text", "truncated"], "Browser-skill bootstrap output");
  const command = text(bootstrap.command, "Browser-skill bootstrap command text");
  if (bootstrap.cwd !== workspaceDirectory || bootstrap.status !== "completed" || bootstrap.exitCode !== 0
      || bool(bootstrapOutput.truncated, "Browser-skill bootstrap output truncation")
      || !/^\/bin\/zsh -lc "sed -n '1,240p' \/Users\/[^/]+\/\.codex\/plugins\/cache\/openai-bundled\/browser\/26\.825\.51511\/skills\/control-in-app-browser\/SKILL\.md"$/.test(command)) {
    throw new Error("Disposable task platform bootstrap is not the single frozen Browser skill read.");
  }
  const executableTypes = new Set(["commandExecution", "mcpToolCall"]);
  const unexpectedExecutable = items.some((item) => (
    typeof item.type === "string"
    && /(?:Execution|ToolCall|fileChange|subAgent|computer)/i.test(item.type)
    && !executableTypes.has(item.type)
  ));
  if (unexpectedExecutable) throw new Error("Disposable task used an unapproved executable surface.");

  const nodeItems = items.filter((item) => item.type === "mcpToolCall");
  if (nodeItems.length === 0) throw new Error("Disposable task did not use the Browser Node REPL.");
  const codeBlocks = nodeItems.map((item, index) => {
    const call = exactKeys(item, ["type", "id", "server", "tool", "status", "durationMs", "arguments"], `Node REPL call ${index}`);
    const args = record(call.arguments, `Node REPL call ${index} arguments`);
    const argumentKeys = Object.keys(args).sort();
    if (canonicalJson(argumentKeys) !== canonicalJson(["code", "title"])
        && canonicalJson(argumentKeys) !== canonicalJson(["code", "timeout_ms", "title"])) {
      throw new Error(`Node REPL call ${index} arguments has an unexpected field set.`);
    }
    if (call.server !== "node_repl" || call.tool !== "js" || call.status !== "completed") {
      throw new Error("Disposable task used an unapproved MCP execution surface.");
    }
    if (args.timeout_ms !== undefined) integer(args.timeout_ms, `Node REPL call ${index} timeout`);
    text(args.title, `Node REPL call ${index} title`);
    return text(args.code, `Node REPL call ${index} code`);
  });
  const browserTraceDigest = hashCanonicalJson({ codeBlocks } as unknown as JsonValue);
  if (browserTraceDigest !== EXP0001A_APPROVED_SPIKE_BROWSER_TRACE_DIGEST) {
    throw new Error("Disposable spike Browser trace differs from the independently audited one-shot trace.");
  }
  const webMcpCalls = [...verifyExp0001aCodexSpikeBrowserTrace({ codeBlocks, roomUrl: access.url })];
  const joinedCode = [...codeBlocks.join("\n").matchAll(/\bjoin_room\s*",\s*\{\s*code:\s*"([A-HJ-NP-Z2-9]{6})"/g)].map((match) => match[1]!);
  const joinedDisplayNames = [...codeBlocks.join("\n").matchAll(/\bjoin_room\s*",\s*\{[^}]*displayName:\s*"([^"]+)"/g)].map((match) => match[1]!);
  if (joinedCode.length !== 1 || joinedCode[0] !== access.code
      || joinedDisplayNames.length !== 1) {
    throw new Error("Disposable task did not join its exact private invite.");
  }
  const joinedDisplayName = joinedDisplayNames[0]!;
  const combinedCode = codeBlocks.join("\n");
  if (!transactionBindsJoinedParticipant(codeBlocks, taskPlan.coordinatorChallenge)) {
    throw new Error("Disposable task code did not bind its coordinator challenge to the joined participant identity.");
  }
  const discoveryIndex = combinedCode.indexOf("fetchTools()");
  if (discoveryIndex < 0 || webMcpCalls.length < 2 || combinedCode.indexOf(".call(") < discoveryIndex) {
    throw new Error("Disposable task did not discover WebMCP before using it.");
  }
  if (webMcpCalls[0] !== "join_room") {
    throw new Error("Invite spike must join before any room operation.");
  }
  const lastMutation = Math.max(
    webMcpCalls.lastIndexOf("apply_canvas_transaction"),
    webMcpCalls.lastIndexOf("finish_canvas_draft"),
  );
  const lastRoomRead = webMcpCalls.lastIndexOf("read_room_state");
  if (lastMutation < 0 || lastRoomRead <= lastMutation) {
    throw new Error("Disposable task lacks a post-mutation authoritative room read.");
  }
  const inspectionObserved = webMcpCalls.includes("inspect_canvas_scope")
    && webMcpCalls.includes("analyze_diagram_layout")
    && webMcpCalls.includes("read_diagram");
  if (!inspectionObserved) throw new Error("Disposable task did not inspect its artifact semantically and visually.");

  const finalMessages = items.filter((item) => item.type === "agentMessage" && item.phase === "final_answer");
  if (finalMessages.length !== 1) throw new Error("Disposable task must have exactly one terminal result.");
  const terminalText = text(finalMessages[0]!.text, "Disposable task terminal result");

  const provisioning = record(input.roomProvisioningReceipt, "Room provisioning receipt");
  if (provisioning.ok !== true || provisioning.tool !== "create_room") throw new Error("Fresh private room provisioning did not succeed through WebMCP.");
  const provisionData = record(provisioning.data, "Room provisioning data");
  const provisionedRoom = record(provisionData.room, "Provisioned room");
  const provisionedRecent = record(provisionData.recentRoom, "Provisioned recent room");
  const roomId = text(provisionedRoom.id, "Provisioned room id");
  const roomCode = text(provisionedRoom.code, "Provisioned room code");
  if (!/^room_[A-Za-z0-9_-]{8,}$/.test(roomId) || !/^[A-HJ-NP-Z2-9]{6}$/.test(roomCode)
      || provisionData.role !== "participant" || provisionedRecent.roomId !== roomId || provisionedRecent.code !== roomCode
      || provisionedRecent.role !== "participant" || provisionData.recentReferenceStored !== true
      || provisionedRoom.title !== roomPlan.arguments.title || provisionedRecent.title !== roomPlan.arguments.title) {
    throw new Error("Fresh private room provisioning receipt is internally inconsistent.");
  }
  if (access.code !== roomCode) {
    throw new Error("Disposable task private room does not match its fresh provisioning receipt.");
  }

  const recovery = exactKeys(input.authoritativeJazzboardRecovery,
    ["schemaVersion", "kind", "capturedAt", "roomState", "diagram", "layout", "inspection", "activity", "preview", "exportResult"],
    "Authoritative Jazzboard recovery");
  if (recovery.schemaVersion !== 2 || recovery.kind !== "exp0001a-spike-authoritative-recovery-raw") {
    throw new Error("Authoritative Jazzboard recovery schema is unsupported.");
  }
  const capturedAt = timestampSchema.parse(recovery.capturedAt);
  if (Date.parse(capturedAt) < completedAtEpochSeconds * 1_000 || Date.parse(evaluatedAt) < Date.parse(capturedAt)) {
    throw new Error("Authoritative Jazzboard recovery is not temporally bound after the task and before the gate.");
  }
  const roomStateResult = record(recovery.roomState, "Authoritative room state result");
  if (roomStateResult.ok !== true || roomStateResult.tool !== "read_room_state") throw new Error("Authoritative room read failed.");
  const roomState = record(roomStateResult.data, "Authoritative room state");
  const finalRoom = record(roomState.room, "Authoritative room");
  const finalRoomRevision = integer(finalRoom.roomRevision, "Final room revision");
  if (finalRoom.id !== roomId) throw new Error("Authoritative room identity differs from provisioning.");
  const objects = list(roomState.objects, "Authoritative canvas objects");
  const diagrams = list(roomState.diagrams, "Authoritative diagrams");
  if (objects.length === 0 || diagrams.length !== 1) throw new Error("Disposable spike did not create one non-empty semantic diagram.");
  const objectIdentities = objectIdentityList(objects);
  const diagram = record(diagrams[0], "Authoritative diagram");
  const diagramId = text(diagram.id, "Authoritative diagram id");
  const diagramRevision = integer(diagram.revision, "Authoritative diagram revision");
  const diagramTags = list(diagram.tags, "Authoritative diagram tags")
    .map((value) => text(value, "Authoritative diagram tag"));
  const challengeTag = `spike-challenge:${taskPlan.coordinatorChallenge}`;
  const participantTags = diagramTags.filter((tag) => tag.startsWith("spike-participant:"));
  if (!diagramTags.includes(challengeTag) || participantTags.length !== 1) {
    throw new Error("Authoritative Diagram metadata does not retain the coordinator challenge and one joined participant identity.");
  }
  const joinedParticipantId = participantTags[0]!.slice("spike-participant:".length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(joinedParticipantId)) {
    throw new Error("Authoritative Diagram metadata contains an invalid participant identity binding.");
  }
  const memberIds = list(diagram.memberObjectIds, "Diagram members").map((value) => text(value, "Diagram member id"));
  const connectorIds = list(diagram.connectorIds, "Diagram connectors").map((value) => text(value, "Diagram connector id"));
  assertEqual(sortedUnique([...memberIds, ...connectorIds]), objectIdentities.map((object) => object.objectId), "Diagram membership");

  const diagramResult = record(recovery.diagram, "Authoritative diagram read result");
  if (diagramResult.ok !== true || diagramResult.tool !== "read_diagram") throw new Error("Authoritative diagram read failed.");
  const diagramData = record(diagramResult.data, "Authoritative diagram read");
  if (diagramData.roomRevision !== finalRoomRevision) throw new Error("Authoritative diagram read is not at the final room revision.");
  assertEqual(diagramData.diagram, diagram, "Diagram metadata readback");
  assertEqual(
    objectIdentityList([...list(diagramData.objects, "Diagram member objects"), ...list(diagramData.connectors, "Diagram connector objects")]),
    objectIdentities,
    "Diagram object readback",
  );

  const activityResult = record(recovery.activity, "Authoritative activity result");
  if (activityResult.ok !== true || activityResult.tool !== "list_activity") throw new Error("Authoritative activity read failed.");
  const activityData = record(activityResult.data, "Authoritative activity data");
  if (activityData.hasMore !== false || activityData.nextBeforeRoomRevision !== null) {
    throw new Error("Authoritative activity recovery is truncated.");
  }
  const activities = list(activityData.activities, "Authoritative activities");
  if (activities.length < 1) throw new Error("Disposable spike must retain at least one authoritative authoring transaction.");
  const chronological = [...activities].map((value, index) => record(value, `Activity ${index}`))
    .sort((left, right) => integer(left.roomRevision, "Activity room revision") - integer(right.roomRevision, "Activity room revision"));
  const expectedObjectIds = objectIdentities.map((object) => object.objectId);
  for (let index = 0; index < chronological.length; index += 1) {
    const activity = chronological[index]!;
    const actor = record(activity.actor, `Activity ${index} actor`);
    const occurredAt = integer(activity.occurredAt, `Activity ${index} timestamp`);
    if (activity.action !== "canvas.transaction" || activity.roomId !== roomId
        || actor.kind !== "agent" || actor.displayName !== joinedDisplayName
        || actor.participantId !== joinedParticipantId
        || occurredAt < startedAtEpochSeconds * 1_000
        || occurredAt > completedAtEpochSeconds * 1_000) {
      throw new Error("Authoritative activity is not attributable to the disposable Codex task window.");
    }
    assertEqual(sortedUnique(list(activity.affectedObjectIds, "Activity affected objects").map((value) => text(value, "Affected object id"))), expectedObjectIds, "Activity object coverage");
    assertEqual(list(activity.affectedDiagramIds, "Activity diagrams"), [diagramId], "Activity diagram coverage");
  }
  const finalActivity = chronological.at(-1)!;
  if (integer(finalActivity.roomRevision, "Final activity revision") !== finalRoomRevision) {
    throw new Error("Final authoritative activity is not bound to the final room revision.");
  }
  const finalObjectGuards = record(finalActivity.objectGuards, "Final activity object guards");
  for (const object of objectIdentities) {
    const guard = record(finalObjectGuards[object.objectId], `Final guard for ${object.objectId}`);
    if (guard.state !== "present" || guard.revision !== object.revision) throw new Error("Final activity guards do not match final object revisions.");
  }
  const finalDiagramGuard = record(record(finalActivity.diagramGuards, "Final diagram guards")[diagramId], "Final diagram guard");
  if (finalDiagramGuard.state !== "present" || finalDiagramGuard.revision !== diagramRevision) {
    throw new Error("Final activity guard does not match the final diagram revision.");
  }

  const layoutResult = record(recovery.layout, "Authoritative layout analysis result");
  if (layoutResult.ok !== true || layoutResult.tool !== "analyze_diagram_layout") throw new Error("Authoritative layout analysis failed.");
  const layoutData = record(layoutResult.data, "Authoritative layout analysis");
  const report = record(layoutData.report, "Authoritative layout report");
  const findings = list(report.findings, "Authoritative layout findings");
  if (!['pass', 'fail'].includes(String(report.status)) || report.roomRevision !== finalRoomRevision
      || report.diagramId !== diagramId || report.diagramRevision !== diagramRevision) {
    throw new Error("Authoritative layout analysis is not bound to the final revisions.");
  }
  const inspectionResult = record(recovery.inspection, "Authoritative exact-revision inspection result");
  if (inspectionResult.ok !== true || inspectionResult.tool !== "inspect_canvas_scope") {
    throw new Error("Authoritative exact-revision canvas inspection failed.");
  }
  const inspectionData = record(inspectionResult.data, "Authoritative exact-revision canvas inspection");
  const inspectionScene = record(inspectionData.sceneContext, "Authoritative inspection scene context");
  const inspectionScope = record(inspectionScene.scope, "Authoritative inspection scope");
  const inspectionRevisions = record(inspectionScene.revisions, "Authoritative inspection revisions");
  if (inspectionScope.kind !== "diagram" || inspectionScope.diagramId !== diagramId
      || inspectionRevisions.diagramRevision !== diagramRevision
      || inspectionRevisions.roomRevision !== finalRoomRevision) {
    throw new Error("Canvas inspection is not bound to the final diagram revision.");
  }

  const terminalTools = [...terminalText.matchAll(/^\s*-\s+([a-z][a-z0-9_]*)\s*$/gm)].map((match) => match[1]!);
  if (!/^STATUS:\s*COMPLETE\s*$/m.test(terminalText)
      || !terminalText.includes(`diagram_id: ${diagramId}`)
      || !terminalText.includes(`diagram_revision: ${diagramRevision}`)
      || !terminalText.includes(`authoritative_room_revision: ${finalRoomRevision}`)
      || !terminalText.includes(`participant_id: ${joinedParticipantId}`)
      || !sortedUnique(webMcpCalls).every((toolName) => terminalTools.includes(toolName))) {
    throw new Error("Disposable task terminal result is not bound to the final authoritative evidence.");
  }

  const signingAuthDigest = signingAuth.receiptSha256;
  const evidence = exp0001aCodexSpikeRecoveryEvidenceSchema.parse({
    schemaVersion: 2,
    kind: "codex-webmcp-spike-recovery-evidence",
    authMethod: "chatgpt",
    subscriptionPlan: "unobservable",
    task: {
      taskIdentityDigest: hashCanonicalJson({
        schemaVersion: 1,
        kind: "codex-private-task-identity-commitment",
        taskId,
        hostId,
      }),
      turnIdentityDigest: hashCanonicalJson({
        schemaVersion: 1,
        kind: "codex-private-turn-identity-commitment",
        taskId,
        turnId,
      }),
      workspaceKind: "projectless",
      requestedModel: { id: taskPlan.arguments.model, reasoningEffort: taskPlan.arguments.thinking },
      observedResolvedModel: "unobservable",
      observedResolvedReasoningEffort: "unobservable",
      startedAt: asTimestamp(startedAtEpochSeconds),
      completedAt: asTimestamp(completedAtEpochSeconds),
      wallTimeMs: turnDurationMs,
      sourceTaskIdentityDigest: null,
      forkedFromTaskIdentityDigest: null,
      sharedHistory: false,
      commandExecutionCount: 1,
      nodeReplCallCount: nodeItems.length,
      browserSkillReadCount: 1,
      projectOrRepositoryReadCount: 0,
      filesystemWriteCount: 0,
      directHttpRequestCount: 0,
      directProviderApiRequestCount: 0,
      browserTraceDigest,
      terminalResultDigest: hashCanonicalJson({ text: terminalText }),
    },
    webMcp: {
      surface: "browser-exposed",
      discoveryObserved: true,
      callCount: webMcpCalls.length,
      failureCount: 0,
      callSequence: webMcpCalls,
      usedToolNames: sortedUnique(webMcpCalls),
      successfulAuthoritativeTransactionCount: chronological.length,
      inspectionObserved: true,
      postMutationAuthoritativeReadObserved: true,
    },
    room: {
      visibility: "private",
      freshProvisioningObserved: true,
      accessMode: access.mode,
      roomAccessBindingDigest: hashCanonicalJson({ roomId, roomCode, roomUrl: access.url, accessMode: access.mode }),
      roomIdentityDigest: hashCanonicalJson({ roomId }),
      coordinatorChallengeDigest: hashCanonicalJson({ challenge: taskPlan.coordinatorChallenge }),
      actorParticipantBindingDigest: hashCanonicalJson({ participantId: joinedParticipantId }),
      finalRoomRevision,
      finalDiagramRevision: diagramRevision,
      finalDiagramIdentityDigest: hashCanonicalJson({ diagramId }),
      objectCount: objects.length,
      diagramCount: 1,
      authoritativeTransactionCount: chronological.length,
      semanticStateDigest: hashCanonicalJson(roomState as JsonValue),
      diagramStateDigest: hashCanonicalJson(diagramData as JsonValue),
      activityDigest: hashCanonicalJson(activityData as JsonValue),
      layoutStatus: report.status,
      layoutFindingCount: findings.length,
      exactRevisionInspectionObserved: true,
    },
    rawAuthority: {
      preSpikeAuthReceiptDigest: input.rawDigests.preSpikeAuthReceiptDigest,
      signingAuthReceiptDigest: signingAuthDigest,
      roomProvisioningPlanDigest: input.rawDigests.roomProvisioningPlanDigest,
      roomProvisioningReceiptDigest: input.rawDigests.roomProvisioningReceiptDigest,
      taskProvisioningPlanDigest: input.rawDigests.taskProvisioningPlanDigest,
      taskCreationCallResultDigest: input.rawDigests.taskCreationCallResultDigest,
      rawTaskRecordDigest: input.rawDigests.rawTaskRecordDigest,
      authoritativeJazzboardRecoveryDigest: input.rawDigests.authoritativeJazzboardRecoveryDigest,
    },
  });
  const roomProvisionedAt = integerLike(provisionedRecent.lastOpenedAt, "Provisioned recent-room timestamp");
  if (Date.parse(preAuth.checkedAt) > Date.parse(roomPlan.issuedAt)
      || Date.parse(roomPlan.issuedAt) > roomProvisionedAt
      || roomProvisionedAt > Date.parse(taskPlan.issuedAt)
      || preAuth.checkedAt > asTimestamp(startedAtEpochSeconds)
      || signingAuth.checkedAt < asTimestamp(completedAtEpochSeconds)) {
    throw new Error("ChatGPT authentication receipts do not bracket the disposable Codex task.");
  }
  return Object.freeze(evidence);
}

export function createExp0001aCodexSpikeRecoveryGateDraft(
  input: Exp0001aCodexSpikeRecoveryInput,
): Exp0001aCodexSpikeRecoveryGateDraft {
  const evidence = reconstructExp0001aCodexSpikeRecoveryEvidence(input);
  const evidenceDigest = hashCanonicalJson(evidence as unknown as JsonValue);
  const content = recoveryGateDraftContentSchema.parse({
    schemaVersion: EXP0001A_CODEX_SPIKE_RECOVERY_GATE_VERSION,
    protocolId: "EXP-0001A",
    kind: "codex-webmcp-spike-recovery-gate",
    evaluatedAt: input.evaluatedAt,
    decision: "allow",
    reasons: ["VERIFIED_CODEX_NATIVE_PROJECTLESS_WEBMCP_SPIKE"],
    evidence,
    evidenceDigest,
  });
  return Object.freeze(exp0001aCodexSpikeRecoveryGateDraftSchema.parse({
    ...content,
    gateDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

export function authorizeExp0001aCodexSpikeRecoveryGate(input: Readonly<{
  draft: unknown;
  authoritySignature: unknown;
}>): Exp0001aCodexSpikeRecoveryGate {
  const draft = verifyExp0001aCodexSpikeRecoveryGateDraft(input.draft);
  const authoritySignature = exp0001aCodexAuthoritySignatureSchema.parse(input.authoritySignature);
  if ((EXP0001A_REVOKED_SPIKE_GATE_PAYLOAD_DIGESTS as readonly string[]).includes(authoritySignature.payloadDigest)) {
    throw new Error("EXP0001A_REVOKED_SPIKE_GATE_PAYLOAD");
  }
  verifyExp0001aCodexAuthoritySignature({
    payload: draft as unknown as JsonValue,
    signature: authoritySignature,
    purpose: "spike_gate",
    notBefore: draft.evaluatedAt,
  });
  return Object.freeze(exp0001aCodexSpikeRecoveryGateSchema.parse({ ...draft, authoritySignature }));
}

export function verifyExp0001aCodexSpikeRecoveryGateDraft(input: unknown): Exp0001aCodexSpikeRecoveryGateDraft {
  const draft = exp0001aCodexSpikeRecoveryGateDraftSchema.parse(input);
  const { gateDigest: _gateDigest, ...content } = draft;
  void _gateDigest;
  if (hashCanonicalJson(draft.evidence as unknown as JsonValue) !== draft.evidenceDigest
      || hashCanonicalJson(content as unknown as JsonValue) !== draft.gateDigest) {
    throw new Error("EXP0001A_CODEX_SPIKE_RECOVERY_GATE_DIGEST_INVALID");
  }
  return Object.freeze(draft);
}

export function verifyExp0001aCodexSpikeRecoveryGate(input: unknown): Exp0001aCodexSpikeRecoveryGate {
  const gate = exp0001aCodexSpikeRecoveryGateSchema.parse(input);
  const { authoritySignature, ...draft } = gate;
  return authorizeExp0001aCodexSpikeRecoveryGate({ draft, authoritySignature });
}
