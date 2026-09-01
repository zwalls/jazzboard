import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

// @ts-expect-error committed ESM auth preflight intentionally has no declaration file
import { assertCodexNativeExperimentAuthorized, runCodexAuthPreflight } from "../../../research/scripts/codex-auth-preflight.mjs";

import {
  ingestQualificationV2ExternalTaskReceipt,
  qualificationV2CoordinatorStateSchema,
  qualificationV2ExternalActionSchema,
  qualificationV2ExternalTaskReceiptSchema,
  recordQualificationV2RunnerDispatch,
  sealQualificationV2ExternalTaskReceipt,
  type QualificationV2CoordinatorState,
} from "./exp0001a-model-role-qualification-v2-coordinator";
import {
  canonicalJson,
  hashCanonicalJson,
  sha256Digest,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";
import {
  qualificationV2EvidenceSidecarReadReceiptSchema,
  verifyQualificationV2EvidenceReadReceipt,
} from "./exp0001a-model-role-qualification-v2-png-sidecar";
import { validateQualificationV2NodeReplIsolation } from "./exp0001a-model-role-qualification-v2-node-repl-trace";

const digest = z.string().regex(SHA256_DIGEST_PATTERN);
const timestamp = z.string().datetime({ offset: true });
/** Live Codex read_thread rejects values above 20,000. */
const QUALIFICATION_V2_READ_THREAD_MAX_OUTPUT_CHARS_PER_ITEM = 20_000 as const;
/** Live Codex list_threads rejects values above 50. */
const QUALIFICATION_V2_LIST_THREADS_LIMIT = 50 as const;
/** The frozen browser skill v26.825.51511 is 150 lines. A bounded sed range
 * whose upper line covers the whole file is semantically the same bootstrap,
 * even when a conforming agent chooses 240 or 260 as the harmless bound. */
const QUALIFICATION_V2_BROWSER_SKILL_COMPLETE_LINE_COUNT = 150 as const;
const QUALIFICATION_V2_BROWSER_SKILL_MAXIMUM_READ_LINE = 1_000 as const;
/** Qualification titles are kept below this observed live-host display bound. */
const QUALIFICATION_V2_LIVE_TITLE_LENGTH = 60 as const;
const jsonValue = z.custom<JsonValue>((value) => {
  try { canonicalJson(value); return true; } catch { return false; }
});

export const qualificationV2ReleaseJournalSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-release-journal/v2"),
  action: qualificationV2ExternalActionSchema,
  preReleaseStateDigest: digest,
  dispatchAuthReceiptDigest: digest,
  recordedAt: timestamp,
  invocationOrdinal: z.literal(1),
  invocationWillOccurExactlyOnce: z.literal(true),
  createResultMustBeRetainedBeforeTerminalObservation: z.literal(true),
  journalDigest: digest,
}).strict().superRefine((journal, context) => {
  const { journalDigest: _journalDigest, ...content } = journal;
  void _journalDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== journal.journalDigest) {
    context.addIssue({ code: "custom", path: ["journalDigest"], message: "Release journal digest is invalid." });
  }
});

export const qualificationV2RawToolObservationSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-raw-tool-observation/v2"),
  actionDigest: digest,
  toolName: z.enum([
    "mcp__codex_app__create_thread",
    "mcp__codex_app__list_threads",
    "mcp__codex_app__wait_threads",
    "mcp__codex_app__read_thread",
  ]),
  invocationOrdinal: z.number().int().positive(),
  argumentsDigest: digest,
  invokedAt: timestamp,
  observedAt: timestamp,
  outcome: z.enum(["returned", "threw"]),
  rawResult: jsonValue.nullable(),
  rawResultDigest: digest.nullable(),
  thrownError: z.object({ name: z.string(), message: z.string() }).strict().nullable(),
  observationDigest: digest,
}).strict().superRefine((observation, context) => {
  const { observationDigest: _observationDigest, ...content } = observation;
  void _observationDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== observation.observationDigest
      || (observation.outcome === "returned") !== (observation.rawResult !== null)
      || (observation.rawResult === null) !== (observation.rawResultDigest === null)
      || (observation.outcome === "threw") !== (observation.thrownError !== null)
      || (observation.rawResult !== null && hashCanonicalJson(observation.rawResult) !== observation.rawResultDigest)) {
    context.addIssue({ code: "custom", message: "Raw tool observation is not derived from its exact result." });
  }
});

export type QualificationV2CodexAppAdapter = Readonly<{
  createThread: (input: z.infer<typeof qualificationV2ExternalActionSchema>["arguments"]) => Promise<unknown>;
  listThreads: (input: Readonly<{ limit: typeof QUALIFICATION_V2_LIST_THREADS_LIMIT }>) => Promise<unknown>;
  waitThreads: (input: Readonly<{
    targets: readonly [Readonly<{ threadId: string; hostId: string; afterCursor?: string }>];
    timeoutMs: 120_000;
  }>) => Promise<unknown>;
  readThread: (input: Readonly<{
    threadId: string;
    hostId: string;
    cursor?: string;
    includeOutputs: true;
    maxOutputCharsPerItem: typeof QUALIFICATION_V2_READ_THREAD_MAX_OUTPUT_CHARS_PER_ITEM;
    turnLimit: 10;
  }>) => Promise<unknown>;
}>;

const trustedHostAdapters = new WeakSet<object>();

/** Called by the Codex desktop host integration, never from request JSON. */
export function bindQualificationV2CodexAppHostAdapter(adapter: QualificationV2CodexAppAdapter) {
  const frozen = Object.freeze({ ...adapter });
  trustedHostAdapters.add(frozen);
  return frozen;
}

type RetainedCall = Readonly<{
  raw: JsonValue;
  digest: string;
  isError: boolean;
  payload: Record<string, JsonValue> | null;
}>;

function retainCall(input: unknown): RetainedCall {
  const raw = JSON.parse(canonicalJson(input)) as JsonValue;
  if (raw === null || Array.isArray(raw) || typeof raw !== "object") throw new Error("CODEX_APP_RESULT_NOT_OBJECT");
  const envelope = raw as Record<string, JsonValue>;
  if (typeof envelope.isError !== "boolean" || !Array.isArray(envelope.content) || envelope.content.length !== 1) {
    throw new Error("CODEX_APP_RESULT_WRAPPER_INVALID");
  }
  const block = envelope.content[0];
  if (block === null || Array.isArray(block) || typeof block !== "object"
      || (block as Record<string, JsonValue>).type !== "text"
      || typeof (block as Record<string, JsonValue>).text !== "string") {
    throw new Error("CODEX_APP_RESULT_TEXT_BLOCK_INVALID");
  }
  let payload: Record<string, JsonValue> | null = null;
  try {
    const parsed = JSON.parse((block as { text: string }).text) as unknown;
    if (parsed !== null && !Array.isArray(parsed) && typeof parsed === "object") payload = parsed as Record<string, JsonValue>;
  } catch {
    if (!envelope.isError) throw new Error("CODEX_APP_SUCCESS_RESULT_NOT_JSON");
  }
  return Object.freeze({ raw, digest: hashCanonicalJson(raw), isError: envelope.isError, payload });
}

function string(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() === value && value.length > 0 ? value : null;
}

async function readPrivate(filePath: string, label: string) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must be a singly linked mode-600 plain file.`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function publishExclusive(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.qualification-v2-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, filePath); } finally { await unlink(temporary).catch(() => undefined); }
  return bytes;
}

async function replaceStateCas(statePath: string, expectedBytes: Buffer, state: QualificationV2CoordinatorState) {
  const current = await readPrivate(statePath, "Qualification-v2 state");
  if (!current.equals(expectedBytes)) throw new Error("QUALIFICATION_V2_STATE_CAS_MISMATCH");
  const temporary = path.join(path.dirname(statePath), `.qualification-v2-state-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(state)}\n`, "utf8");
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, statePath);
  return bytes;
}

function sealObservation(input: Omit<z.infer<typeof qualificationV2RawToolObservationSchema>, "observationDigest">) {
  return qualificationV2RawToolObservationSchema.parse({
    ...input,
    observationDigest: hashCanonicalJson(input as unknown as JsonValue),
  });
}

async function invokeAndRetain(input: Readonly<{
  actionDigest: string;
  toolName: z.infer<typeof qualificationV2RawToolObservationSchema>["toolName"];
  invocationOrdinal: number;
  arguments: unknown;
  invoke: () => Promise<unknown>;
  filePath: string;
  now: () => string;
}>) {
  const invokedAt = input.now();
  try {
    const rawResult = await input.invoke();
    const raw = JSON.parse(canonicalJson(rawResult)) as JsonValue;
    const observation = sealObservation({
      schemaVersion: "exp-0001a-qualification-raw-tool-observation/v2",
      actionDigest: input.actionDigest,
      toolName: input.toolName,
      invocationOrdinal: input.invocationOrdinal,
      argumentsDigest: hashCanonicalJson(input.arguments as JsonValue),
      invokedAt,
      observedAt: input.now(),
      outcome: "returned",
      rawResult: raw,
      rawResultDigest: hashCanonicalJson(raw),
      thrownError: null,
    });
    await publishExclusive(input.filePath, observation);
    return observation;
  } catch (error) {
    const observation = sealObservation({
      schemaVersion: "exp-0001a-qualification-raw-tool-observation/v2",
      actionDigest: input.actionDigest,
      toolName: input.toolName,
      invocationOrdinal: input.invocationOrdinal,
      argumentsDigest: hashCanonicalJson(input.arguments as JsonValue),
      invokedAt,
      observedAt: input.now(),
      outcome: "threw",
      rawResult: null,
      rawResultDigest: null,
      thrownError: {
        name: error instanceof Error ? error.name : "UnknownThrownValue",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    await publishExclusive(input.filePath, observation);
    return observation;
  }
}

function usageLimit(payload: Record<string, JsonValue> | null) {
  const error = payload?.error;
  const errorRecord = error !== null && !Array.isArray(error) && typeof error === "object"
    ? error as Record<string, JsonValue>
    : null;
  const code = string(errorRecord?.code)?.toLowerCase() ?? "";
  return ["usage_limit", "subscription_usage_limit", "subscription_limit", "codex_usage_limit"].includes(code);
}

function liveCodexThreadTitle(requestedTitle: string): string {
  const characters = Array.from(requestedTitle.trim().replace(/\s+/g, " "));
  return characters.length <= QUALIFICATION_V2_LIVE_TITLE_LENGTH
    ? characters.join("")
    : `${characters.slice(0, QUALIFICATION_V2_LIVE_TITLE_LENGTH - 1).join("")}…`;
}

function codexDelegationTextNode(requestedPrompt: string): string {
  return requestedPrompt
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function codexDelegationReadbackMatches(actual: string, requestedPrompt: string): boolean {
  const expected = codexDelegationTextNode(requestedPrompt);
  if (actual === expected) return true;
  const segments = actual.split("…");
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) return false;
  const first = segments[0]!;
  const last = segments.at(-1)!;
  const retainedLength = segments.reduce((total, segment) => total + segment.length, 0);
  if (first.length < 256 || last.length < 256
      || retainedLength < Math.min(2_048, Math.floor(expected.length / 2))
      || !expected.startsWith(first) || !expected.endsWith(last)) return false;
  let cursor = first.length;
  const suffixStart = expected.length - last.length;
  for (const segment of segments.slice(1, -1)) {
    const index = expected.indexOf(segment, cursor);
    if (index < cursor || index + segment.length > suffixStart) return false;
    cursor = index + segment.length;
  }
  return cursor <= suffixStart;
}

function terminalMessages(payloads: readonly Record<string, JsonValue>[]) {
  const messages: string[] = [];
  for (const payload of payloads) {
    if (!Array.isArray(payload.turns)) continue;
    for (const turnValue of payload.turns) {
      if (turnValue === null || Array.isArray(turnValue) || typeof turnValue !== "object") continue;
      const items = (turnValue as Record<string, JsonValue>).items;
      if (!Array.isArray(items)) continue;
      for (const itemValue of items) {
        if (itemValue === null || Array.isArray(itemValue) || typeof itemValue !== "object") continue;
        const item = itemValue as Record<string, JsonValue>;
        if (item.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string") {
          messages.push(item.text);
        }
      }
    }
  }
  return messages;
}

function validateRetainedTaskIsolation(input: Readonly<{
  payloads: readonly Record<string, JsonValue>[];
  action: z.infer<typeof qualificationV2ExternalActionSchema>;
  repositoryRoot: string;
}>) {
  const items: Record<string, JsonValue>[] = [];
  let retainedProjectlessCwd: string | null = null;
  for (const payload of input.payloads) {
    const threadValue = payload.thread;
    if (threadValue === null || Array.isArray(threadValue) || typeof threadValue !== "object") return false;
    const thread = threadValue as Record<string, JsonValue>;
    if (thread.title !== liveCodexThreadTitle(input.action.arguments.title) || typeof thread.cwd !== "string"
        || path.resolve(thread.cwd).startsWith(`${path.resolve(input.repositoryRoot)}${path.sep}`)
        || path.resolve(thread.cwd) === path.resolve(input.repositoryRoot)) return false;
    const expectedDirectoryName = input.action.arguments.target.directoryName;
    const normalizedCwd = path.resolve(thread.cwd);
    const escapedDirectoryName = expectedDirectoryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const projectlessMacPattern = new RegExp(
      `^/Users/[^/]+/Documents/Codex/\\d{4}-\\d{2}-\\d{2}/${escapedDirectoryName}$`,
    );
    if (path.basename(normalizedCwd) !== expectedDirectoryName
        || (!projectlessMacPattern.test(normalizedCwd)
          && normalizedCwd !== path.join("/private/tmp", expectedDirectoryName))
        || (retainedProjectlessCwd !== null && normalizedCwd !== retainedProjectlessCwd)) return false;
    retainedProjectlessCwd = normalizedCwd;
    if (["sourceTaskId", "forkedFromTaskId", "parentThreadId"].some((key) => thread[key] != null)) return false;
    if (!Array.isArray(payload.turns)) return false;
    for (const turnValue of payload.turns) {
      if (turnValue === null || Array.isArray(turnValue) || typeof turnValue !== "object") return false;
      const turnItems = (turnValue as Record<string, JsonValue>).items;
      if (!Array.isArray(turnItems)) return false;
      for (const itemValue of turnItems) {
        if (itemValue !== null && !Array.isArray(itemValue) && typeof itemValue === "object") {
          items.push(itemValue as Record<string, JsonValue>);
        }
      }
    }
  }
  const promptRecords = items.filter((item) => item.type === "functionCallOutput"
    && item.namespace === "codex_app" && item.name === "create_thread");
  if (promptRecords.length !== 1) return false;
  const promptOutput = promptRecords[0]!.output;
  if (promptOutput === null || Array.isArray(promptOutput) || typeof promptOutput !== "object"
      || (promptOutput as Record<string, JsonValue>).truncated !== false
      || typeof (promptOutput as Record<string, JsonValue>).text !== "string") return false;
  const delegated = (promptOutput as Record<string, JsonValue>).text as string;
  const delegatedMatch = /^<codex_delegation>\n  <source_thread_id>[A-Za-z0-9-]+<\/source_thread_id>\n  <input>([\s\S]*)<\/input>\n<\/codex_delegation>\n?$/.exec(delegated);
  if (delegatedMatch === null
      || !codexDelegationReadbackMatches(delegatedMatch[1], input.action.arguments.prompt)) return false;
  const commands = items.filter((item) => item.type === "commandExecution");
  if (commands.length !== 1) return false;
  const bootstrap = commands[0]!;
  const bootstrapOutput = bootstrap.output;
  const absoluteBootstrapCommandMatch = typeof bootstrap.command === "string"
    ? /^\/bin\/zsh -lc "sed -n '1,(\d+)p' \/Users\/[^/]+\/\.codex\/plugins\/cache\/openai-bundled\/browser\/26\.825\.51511\/skills\/control-in-app-browser\/SKILL\.md"$/.exec(bootstrap.command)
    : null;
  const portableBootstrapCommandMatch = typeof bootstrap.command === "string"
    ? /^\/bin\/zsh -lc "sed -n '1,(\d+)p' ~\/\.codex\/plugins\/cache\/openai-bundled\/browser\/26\.825\.51511\/skills\/control-in-app-browser\/SKILL\.md"$/.exec(bootstrap.command)
    : null;
  const bootstrapLastLineText = absoluteBootstrapCommandMatch?.[1]
    ?? portableBootstrapCommandMatch?.[1]
    ?? null;
  const bootstrapLastLine = bootstrapLastLineText === null
    ? null
    : Number.parseInt(bootstrapLastLineText, 10);
  if (typeof bootstrap.cwd !== "string" || retainedProjectlessCwd === null
      || path.resolve(bootstrap.cwd) !== retainedProjectlessCwd
      || path.resolve(bootstrap.cwd) === path.resolve(input.repositoryRoot)
      || path.resolve(bootstrap.cwd).startsWith(`${path.resolve(input.repositoryRoot)}${path.sep}`)
      || typeof bootstrap.command !== "string"
      || bootstrap.status !== "completed" || bootstrap.exitCode !== 0
      || bootstrapOutput === null || Array.isArray(bootstrapOutput) || typeof bootstrapOutput !== "object"
      || (bootstrapOutput as Record<string, JsonValue>).truncated !== false
      || typeof (bootstrapOutput as Record<string, JsonValue>).text !== "string"
      || bootstrapLastLine === null
      || bootstrapLastLine < QUALIFICATION_V2_BROWSER_SKILL_COMPLETE_LINE_COUNT
      || bootstrapLastLine > QUALIFICATION_V2_BROWSER_SKILL_MAXIMUM_READ_LINE) {
    return false;
  }
  const allowedRetainedItemTypes = new Set([
    "agentMessage", "commandExecution", "functionCallOutput", "mcpToolCall", "reasoning",
  ]);
  if (items.some((item) => typeof item.type !== "string"
      || !allowedRetainedItemTypes.has(item.type))) return false;
  const mcpCalls = items.filter((item) => item.type === "mcpToolCall");
  if (mcpCalls.length === 0) return false;
  const codeBlocks: string[] = [];
  for (const call of mcpCalls) {
    if (call.server !== "node_repl" || call.tool !== "js" || !["completed", "failed"].includes(String(call.status))) return false;
    const args = call.arguments;
    if (args === null || Array.isArray(args) || typeof args !== "object"
        || typeof (args as Record<string, JsonValue>).code !== "string") return false;
    const argumentKeys = Object.keys(args).sort();
    if (canonicalJson(argumentKeys as unknown as JsonValue) !== canonicalJson(["code"])
        && canonicalJson(argumentKeys as unknown as JsonValue) !== canonicalJson(["code", "title"])
        && canonicalJson(argumentKeys as unknown as JsonValue) !== canonicalJson(["code", "timeout_ms", "title"])) {
      return false;
    }
    if ((args as Record<string, JsonValue>).title !== undefined
        && typeof (args as Record<string, JsonValue>).title !== "string") return false;
    if ((args as Record<string, JsonValue>).timeout_ms !== undefined
        && !Number.isSafeInteger((args as Record<string, JsonValue>).timeout_ms)) return false;
    codeBlocks.push((args as Record<string, JsonValue>).code as string);
  }
  const inviteMatch = /(?:^|\n)PRIVATE_ROOM_INVITE_URL=(https:\/\/www\.jazzboard\.xyz\/#join=[A-HJ-NP-Z2-9]{6})(?:\n|$)/
    .exec(input.action.arguments.prompt);
  if (input.action.role === "author" && inviteMatch === null) return false;
  return validateQualificationV2NodeReplIsolation({
    codeBlocks,
    role: input.action.role,
    privateInviteUrl: inviteMatch?.[1],
    exactRevisionPngUrl: input.action.reviewEvidenceSidecar?.exactRevisionPngUrl,
  });
}

const reviewerDecisionInput = z.object({
  artifactAccepted: z.boolean(),
  criterionPasses: z.record(z.string(), z.boolean()),
  evidenceRoot: digest,
  blindness: z.object({
    authorTranscriptSeen: z.literal(false),
    authorIdentitySeen: z.literal(false),
    conditionLabelSeen: z.literal(false),
    pairedArtifactSeen: z.literal(false),
    repositoryAccessed: z.literal(false),
    otherReviewerDecisionSeen: z.literal(false),
  }).strict(),
}).strict();

type RunnerDependencies = Readonly<{
  adapter: QualificationV2CodexAppAdapter;
  now?: () => string;
  runAuthPreflight?: () => Promise<unknown>;
  reviewEvidenceReadReceiptPath?: string;
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  /** Deliberate process-crash seam. It is exposed only by the test runner. */
  crashAfterRetained?: "dispatch_lock" | "recovery_lock" | "release_journal" | "create_observation" | "list_observation" | "final_state_cas";
}>;

type RunnerMode = "dispatch" | "recover";

const runnerLockSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-runner-lock/v2"),
  mode: z.enum(["dispatch", "recover"]),
  acquiredAt: timestamp,
  actionDigest: digest,
}).strict();

const recoveryRunnerLockSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-runner-recovery-lock/v2"),
  mode: z.literal("recover"),
  acquiredAt: timestamp,
  actionDigest: digest,
  ownerProcessId: z.number().int().positive(),
  attemptId: z.string().uuid(),
}).strict();

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function retireTerminalPriorDispatchLock(input: Readonly<{
  lockPath: string;
  statePath: string;
  privateRoot: string;
  state: QualificationV2CoordinatorState;
}>) {
  let retainedBytes: Buffer;
  try {
    retainedBytes = await readPrivate(input.lockPath, "Qualification-v2 prior dispatch lock");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  const retainedLock = runnerLockSchema.parse(JSON.parse(retainedBytes.toString("utf8")));
  const currentAction = input.state.pendingAction;
  if (retainedLock.actionDigest === currentAction?.actionDigest
      || !input.state.releasedActionDigests.includes(retainedLock.actionDigest)) {
    return;
  }
  const externalActionsRoot = path.join(input.privateRoot, "external-actions");
  const actionEntries = await readdir(externalActionsRoot, { withFileTypes: true }).catch((error) => {
    if (isMissingFile(error)) return [];
    throw error;
  });
  const terminalReceipts: z.infer<typeof qualificationV2ExternalTaskReceiptSchema>[] = [];
  for (const entry of actionEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const receiptPath = path.join(externalActionsRoot, entry.name, "external-task-receipt.json");
    const receiptBytes = await readPrivate(receiptPath, "Qualification-v2 retained terminal task receipt")
      .catch((error) => {
        if (isMissingFile(error)) return null;
        throw error;
      });
    if (receiptBytes === null) continue;
    const receipt = qualificationV2ExternalTaskReceiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
    if (receipt.actionDigest === retainedLock.actionDigest) terminalReceipts.push(receipt);
  }
  if (terminalReceipts.length !== 1
      || !input.state.retainedTaskReceiptDigests.includes(terminalReceipts[0]!.receiptDigest)) {
    throw new Error("QUALIFICATION_V2_TERMINAL_DISPATCH_LOCK_EVIDENCE_MISSING");
  }
  const archivePath = path.join(
    `${input.statePath}.terminal-dispatch-locks`,
    `${retainedLock.actionDigest.replace("sha256:", "")}.json`,
  );
  try {
    await publishExclusive(archivePath, retainedLock);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const archived = await readPrivate(archivePath, "Qualification-v2 archived terminal dispatch lock");
    if (!archived.equals(Buffer.from(`${canonicalJson(retainedLock)}\n`, "utf8"))) {
      throw new Error("QUALIFICATION_V2_TERMINAL_DISPATCH_LOCK_ARCHIVE_MISMATCH");
    }
  }
  await unlink(input.lockPath);
}

function processAppearsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

async function retireAbandonedRecoveryLock(input: Readonly<{
  recoveryLockPath: string;
  statePath: string;
  actionDigest: string;
  isProcessAlive: (processId: number) => boolean;
}>) {
  let retainedBytes: Buffer;
  try {
    retainedBytes = await readPrivate(input.recoveryLockPath, "Qualification-v2 prior recovery lock");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  const retainedLock = recoveryRunnerLockSchema.parse(JSON.parse(retainedBytes.toString("utf8")));
  if (retainedLock.actionDigest !== input.actionDigest) {
    throw new Error("QUALIFICATION_V2_RECOVERY_LOCK_BINDING_INVALID");
  }
  if (input.isProcessAlive(retainedLock.ownerProcessId)) {
    throw new Error("QUALIFICATION_V2_RECOVERY_ALREADY_ACTIVE");
  }
  const archivePath = path.join(
    `${input.statePath}.terminal-recovery-locks`,
    `${retainedLock.actionDigest.replace("sha256:", "")}-${retainedLock.attemptId}.json`,
  );
  try {
    await publishExclusive(archivePath, retainedLock);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const archived = await readPrivate(archivePath, "Qualification-v2 archived recovery lock");
    if (!archived.equals(Buffer.from(`${canonicalJson(retainedLock)}\n`, "utf8"))) {
      throw new Error("QUALIFICATION_V2_RECOVERY_LOCK_ARCHIVE_MISMATCH");
    }
  }
  await unlink(input.recoveryLockPath);
}

async function readRetainedObservationIfPresent(input: Readonly<{
  filePath: string;
  actionDigest: string;
  toolName: z.infer<typeof qualificationV2RawToolObservationSchema>["toolName"];
  invocationOrdinal: number;
  arguments: unknown;
}>) {
  let bytes: Buffer;
  try {
    bytes = await readPrivate(input.filePath, "Qualification-v2 raw tool observation");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  const observation = qualificationV2RawToolObservationSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (observation.actionDigest !== input.actionDigest
      || observation.toolName !== input.toolName
      || observation.invocationOrdinal !== input.invocationOrdinal
      || observation.argumentsDigest !== hashCanonicalJson(input.arguments as JsonValue)) {
    throw new Error("QUALIFICATION_V2_RETAINED_OBSERVATION_BINDING_INVALID");
  }
  return observation;
}

async function retainOrInvoke(input: Readonly<{
  mode: RunnerMode;
  actionDigest: string;
  toolName: z.infer<typeof qualificationV2RawToolObservationSchema>["toolName"];
  invocationOrdinal: number;
  arguments: unknown;
  invoke: () => Promise<unknown>;
  filePath: string;
  now: () => string;
}>) {
  const retained = await readRetainedObservationIfPresent(input);
  if (retained !== null) return retained;
  return invokeAndRetain(input);
}

function retainedPayloadHasTruncationMetadata(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(retainedPayloadHasTruncationMetadata);
  if (value === null || typeof value !== "object") return false;
  const object = value as Record<string, JsonValue>;
  if (object.truncated === true) return true;
  if (typeof object.text === "string"
      && object.text.length >= QUALIFICATION_V2_READ_THREAD_MAX_OUTPUT_CHARS_PER_ITEM) return true;
  if (typeof object.originalChars === "number" && typeof object.text === "string"
      && object.originalChars > object.text.length) return true;
  return Object.values(object).some(retainedPayloadHasTruncationMetadata);
}

async function runWithAdapter(input: Readonly<{
  repositoryRoot: string;
  statePath: string;
}>, dependencies: RunnerDependencies, mode: RunnerMode) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const privateRoot = path.join(input.repositoryRoot, ".research-private", "exp0001a-qualification-v2");
  const [resolvedPrivateRoot, resolvedState] = await Promise.all([realpath(privateRoot), realpath(input.statePath)]);
  const relative = path.relative(resolvedPrivateRoot, resolvedState);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) {
    throw new Error("QUALIFICATION_V2_RUNNER_STATE_NOT_PRIVATE");
  }
  const lockPath = `${resolvedState}.dispatch.lock`;
  const authReceipt = assertCodexNativeExperimentAuthorized(
    await (dependencies.runAuthPreflight ?? runCodexAuthPreflight)(),
  );
  const initialBytes = await readPrivate(resolvedState, "Qualification-v2 pre-lock state");
  const state = qualificationV2CoordinatorStateSchema.parse(JSON.parse(initialBytes.toString("utf8")));
  const action = state.pendingAction;
  if (mode === "dispatch") {
    await retireTerminalPriorDispatchLock({
      lockPath,
      statePath: resolvedState,
      privateRoot: resolvedPrivateRoot,
      state,
    });
  }
  if (state.stopped || action === null
      || (mode === "dispatch" && state.pendingDispatchReceipt !== null)) {
    if (mode === "recover") {
      await retireTerminalPriorDispatchLock({
        lockPath,
        statePath: resolvedState,
        privateRoot: resolvedPrivateRoot,
        state,
      });
      const terminalLockStillPresent = await readPrivate(lockPath, "Qualification-v2 retained dispatch lock")
        .then(() => true)
        .catch((error) => {
          if (isMissingFile(error)) return false;
          throw error;
        });
      if (!terminalLockStillPresent) {
        throw new Error("QUALIFICATION_V2_RECOVERY_ALREADY_TERMINAL");
      }
    }
    throw new Error("QUALIFICATION_V2_RUNNER_NO_PENDING_ACTION");
  }
  let recoveryLockPath: string | null = null;
  if (mode === "dispatch") {
    await publishExclusive(lockPath, runnerLockSchema.parse({
      schemaVersion: "exp-0001a-qualification-runner-lock/v2",
      mode: "dispatch",
      acquiredAt: now(),
      actionDigest: action.actionDigest,
    }));
  } else {
    const retainedDispatchLock = runnerLockSchema.parse(JSON.parse(
      (await readPrivate(lockPath, "Qualification-v2 retained dispatch lock")).toString("utf8"),
    ));
    if (retainedDispatchLock.mode !== "dispatch"
        || retainedDispatchLock.actionDigest !== action.actionDigest) {
      throw new Error("QUALIFICATION_V2_RECOVERY_LOCK_BINDING_INVALID");
    }
    recoveryLockPath = `${lockPath}.recovery.${action.actionDigest.replace("sha256:", "")}`;
    await retireAbandonedRecoveryLock({
      recoveryLockPath,
      statePath: resolvedState,
      actionDigest: action.actionDigest,
      isProcessAlive: dependencies.isProcessAlive ?? processAppearsAlive,
    });
    await publishExclusive(recoveryLockPath, recoveryRunnerLockSchema.parse({
      schemaVersion: "exp-0001a-qualification-runner-recovery-lock/v2",
      mode: "recover",
      acquiredAt: now(),
      actionDigest: action.actionDigest,
      ownerProcessId: dependencies.processId ?? process.pid,
      attemptId: randomUUID(),
    }));
  }
  let completedNormally = false;
  try {
    const lockedStateBytes = await readPrivate(resolvedState, "Qualification-v2 locked state");
    if (!lockedStateBytes.equals(initialBytes)) {
      throw new Error("QUALIFICATION_V2_STATE_CAS_MISMATCH");
    }
    if (mode === "dispatch" && dependencies.crashAfterRetained === "dispatch_lock") {
      throw new Error("QUALIFICATION_V2_TEST_CRASH_AFTER_DISPATCH_LOCK");
    }
    if (mode === "recover" && dependencies.crashAfterRetained === "recovery_lock") {
      throw new Error("QUALIFICATION_V2_TEST_CRASH_AFTER_RECOVERY_LOCK");
    }
    const actionRoot = path.join(resolvedPrivateRoot, "external-actions", action.actionId);
    const createPath = path.join(actionRoot, "create-result.json");
    let journal: z.infer<typeof qualificationV2ReleaseJournalSchema>;
    let dispatched: QualificationV2CoordinatorState | null = null;
    let dispatchedBytes: Buffer | null = null;
    let recoveryMayInvokeCreate = false;
    if (mode === "dispatch") {
      const journalContent = {
        schemaVersion: "exp-0001a-qualification-release-journal/v2" as const,
        action,
        preReleaseStateDigest: state.stateDigest,
        dispatchAuthReceiptDigest: authReceipt.receiptSha256,
        recordedAt: now(),
        invocationOrdinal: 1 as const,
        invocationWillOccurExactlyOnce: true as const,
        createResultMustBeRetainedBeforeTerminalObservation: true as const,
      };
      journal = qualificationV2ReleaseJournalSchema.parse({
        ...journalContent,
        journalDigest: hashCanonicalJson(journalContent as unknown as JsonValue),
      });
      await publishExclusive(path.join(actionRoot, "release-journal.json"), journal);
      dispatched = recordQualificationV2RunnerDispatch(state, journal.recordedAt, journal.journalDigest);
      dispatchedBytes = await replaceStateCas(resolvedState, initialBytes, dispatched);
      if (dependencies.crashAfterRetained === "release_journal") throw new Error("QUALIFICATION_V2_TEST_CRASH_AFTER_RELEASE_JOURNAL");
    } else {
      const journalPath = path.join(actionRoot, "release-journal.json");
      const journalBytes = await readPrivate(journalPath, "Qualification-v2 retained release journal")
        .catch((error) => {
          if (isMissingFile(error)) return null;
          throw error;
        });
      if (journalBytes === null) {
        if (state.pendingDispatchReceipt !== null
            || await readRetainedObservationIfPresent({
              filePath: createPath,
              actionDigest: action.actionDigest,
              toolName: "mcp__codex_app__create_thread",
              invocationOrdinal: 1,
              arguments: action.arguments,
            }) !== null) {
          throw new Error("QUALIFICATION_V2_RECOVERY_MISSING_JOURNAL_NOT_PROVABLY_UNSTARTED");
        }
        const journalContent = {
          schemaVersion: "exp-0001a-qualification-release-journal/v2" as const,
          action,
          preReleaseStateDigest: state.stateDigest,
          dispatchAuthReceiptDigest: authReceipt.receiptSha256,
          recordedAt: now(),
          invocationOrdinal: 1 as const,
          invocationWillOccurExactlyOnce: true as const,
          createResultMustBeRetainedBeforeTerminalObservation: true as const,
        };
        journal = qualificationV2ReleaseJournalSchema.parse({
          ...journalContent,
          journalDigest: hashCanonicalJson(journalContent as unknown as JsonValue),
        });
        await publishExclusive(journalPath, journal);
        dispatched = recordQualificationV2RunnerDispatch(state, journal.recordedAt, journal.journalDigest);
        dispatchedBytes = await replaceStateCas(resolvedState, initialBytes, dispatched);
        recoveryMayInvokeCreate = true;
      } else {
        journal = qualificationV2ReleaseJournalSchema.parse(JSON.parse(journalBytes.toString("utf8")));
      }
      if (journal.action.actionDigest !== action.actionDigest) {
        throw new Error("QUALIFICATION_V2_RECOVERY_JOURNAL_BINDING_INVALID");
      }
      if (!recoveryMayInvokeCreate && state.pendingDispatchReceipt === null) {
        // A crash may occur after the immutable journal is published but
        // before its dispatch transition is CAS-written. No create call is
        // permitted during recovery; bind that exact journal into state and
        // reconcile only by the unique title.
        if (journal.preReleaseStateDigest !== state.stateDigest) {
          throw new Error("QUALIFICATION_V2_RECOVERY_JOURNAL_STATE_MISMATCH");
        }
        dispatched = recordQualificationV2RunnerDispatch(state, journal.recordedAt, journal.journalDigest);
        dispatchedBytes = await replaceStateCas(resolvedState, initialBytes, dispatched);
      } else if (!recoveryMayInvokeCreate) {
        const pendingDispatch = state.pendingDispatchReceipt;
        if (pendingDispatch === null
            || pendingDispatch.actionDigest !== action.actionDigest
            || pendingDispatch.releaseJournalDigest !== journal.journalDigest) {
          throw new Error("QUALIFICATION_V2_RECOVERY_JOURNAL_BINDING_INVALID");
        }
        dispatched = state;
        dispatchedBytes = initialBytes;
      }
    }
    if (dispatched === null || dispatchedBytes === null) {
      throw new Error("QUALIFICATION_V2_RUNNER_DISPATCH_STATE_MISSING");
    }
    const createArguments = action.arguments;
    const createObservation = mode === "dispatch" || recoveryMayInvokeCreate
      ? await retainOrInvoke({
        mode: "dispatch",
        actionDigest: action.actionDigest,
        toolName: "mcp__codex_app__create_thread",
        invocationOrdinal: 1,
        arguments: createArguments,
        invoke: () => dependencies.adapter.createThread(createArguments),
        filePath: createPath,
        now,
      })
      : await readRetainedObservationIfPresent({
        filePath: createPath,
        actionDigest: action.actionDigest,
        toolName: "mcp__codex_app__create_thread",
        invocationOrdinal: 1,
        arguments: createArguments,
      });
    if (dependencies.crashAfterRetained === "create_observation") throw new Error("QUALIFICATION_V2_TEST_CRASH_AFTER_CREATE_OBSERVATION");

    let createdTaskId: string | null = null;
    let hostId: string | null = null;
    let clientTaskId: string | null = null;
    let listThreadsObservationDigest: string | null = null;
    let terminalStatus: "completed" | "failed" | "usage_limit_interrupted" | "invalid_setup" = "invalid_setup";
    const waitObservations: z.infer<typeof qualificationV2RawToolObservationSchema>[] = [];
    const readObservations: z.infer<typeof qualificationV2RawToolObservationSchema>[] = [];
    let terminalText: string | null = null;
    let isolationVerified = false;
    if (createObservation !== null && createObservation.rawResult !== null) {
      let retained: RetainedCall | null = null;
      try { retained = retainCall(createObservation.rawResult); } catch { retained = null; }
      if (retained !== null) {
        createdTaskId = string(retained.payload?.threadId);
        hostId = string(retained.payload?.hostId);
        clientTaskId = string(retained.payload?.clientThreadId);
        if (retained.isError && retained.payload?.taskCreated === false && usageLimit(retained.payload)) {
          terminalStatus = "usage_limit_interrupted";
          createdTaskId = null;
          hostId = null;
          clientTaskId = null;
        }
      }
    }

    // A direct-ready create result already provides the authoritative task and
    // host identity; wait_threads/read_thread validate that exact identity.
    // list_threads does not necessarily enumerate a newly created active task,
    // so exact-title reconciliation is reserved for missing/client-setup
    // identities. Zero or duplicate matches remain fail-closed and must never
    // trigger another create invocation.
    if (terminalStatus !== "usage_limit_interrupted" && createdTaskId === null
        && (mode === "recover" || clientTaskId !== null)) {
      const expectedCreatedTaskId = createdTaskId;
      const expectedHostId = hostId;
      createdTaskId = null;
      hostId = null;
      const listArguments = { limit: QUALIFICATION_V2_LIST_THREADS_LIMIT };
      const listObservation = await retainOrInvoke({
        mode,
        actionDigest: action.actionDigest,
        toolName: "mcp__codex_app__list_threads",
        invocationOrdinal: 1,
        arguments: listArguments,
        invoke: () => dependencies.adapter.listThreads(listArguments),
        filePath: path.join(actionRoot, "list-result.json"),
        now,
      });
      listThreadsObservationDigest = listObservation.observationDigest;
      if (dependencies.crashAfterRetained === "list_observation") throw new Error("QUALIFICATION_V2_TEST_CRASH_AFTER_LIST_OBSERVATION");
      if (listObservation.rawResult !== null) {
        try {
          const list = retainCall(listObservation.rawResult);
          const entries = [...(Array.isArray(list.payload?.pinnedThreads) ? list.payload!.pinnedThreads as JsonValue[] : []),
            ...(Array.isArray(list.payload?.threads) ? list.payload!.threads as JsonValue[] : [])];
          const matches = entries.filter((entry) => entry !== null && !Array.isArray(entry) && typeof entry === "object"
            && (entry as Record<string, JsonValue>).kind === "codex"
            && (entry as Record<string, JsonValue>).title === liveCodexThreadTitle(action.arguments.title));
          if (matches.length === 1) {
            const match = matches[0] as Record<string, JsonValue>;
            const matchTaskId = string(match.id);
            const matchHostId = string(match.hostId);
            if (matchTaskId !== null && matchHostId !== null
                && (expectedCreatedTaskId === null || (matchTaskId === expectedCreatedTaskId && matchHostId === expectedHostId))) {
              createdTaskId = matchTaskId;
              hostId = matchHostId;
            }
          }
        } catch { /* exact retained ambiguity remains invalid_setup */ }
      }
    }

    let latestCursor: string | undefined;
    if (createdTaskId !== null && hostId !== null) {
      for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
        const waitArguments = {
          targets: [{ threadId: createdTaskId, hostId, ...(latestCursor === undefined ? {} : { afterCursor: latestCursor }) }] as const,
          timeoutMs: 120_000 as const,
        };
        const observation = await retainOrInvoke({
          mode,
          actionDigest: action.actionDigest,
          toolName: "mcp__codex_app__wait_threads",
          invocationOrdinal: ordinal,
          arguments: waitArguments,
          invoke: () => dependencies.adapter.waitThreads(waitArguments),
          filePath: path.join(actionRoot, `wait-${String(ordinal).padStart(3, "0")}.json`),
          now,
        });
        waitObservations.push(observation);
        if (observation.rawResult === null) { terminalStatus = "failed"; break; }
        let retained: RetainedCall;
        try { retained = retainCall(observation.rawResult); } catch { terminalStatus = "failed"; break; }
        if (retained.isError) {
          terminalStatus = usageLimit(retained.payload) ? "usage_limit_interrupted" : "failed";
          break;
        }
        const payload = retained.payload;
        if (payload === null || !Array.isArray(payload.polls) || payload.polls.length !== 1) {
          terminalStatus = "failed";
          break;
        }
        const pollValue = payload.polls[0];
        const poll = pollValue !== null && !Array.isArray(pollValue) && typeof pollValue === "object"
          ? pollValue as Record<string, JsonValue> : null;
        latestCursor = string(poll?.cursor) ?? undefined;
        if (payload.timedOut === true && latestCursor !== undefined) continue;
        const latestTurnValue = poll?.latestTurn;
        const latestTurn = latestTurnValue !== null && !Array.isArray(latestTurnValue) && typeof latestTurnValue === "object"
          ? latestTurnValue as Record<string, JsonValue> : null;
        const status = string(latestTurn?.status)?.toLowerCase();
        if (status === "completed") terminalStatus = "completed";
        else if (status === "failed" && /usage[_ -]?limit|subscription[_ -]?usage/i.test(canonicalJson(latestTurn?.error))) {
          terminalStatus = "usage_limit_interrupted";
        } else terminalStatus = "failed";
        break;
      }
      if (waitObservations.length === 100 && terminalStatus === "invalid_setup") terminalStatus = "failed";
    }

    if ((terminalStatus === "completed" || terminalStatus === "failed" || terminalStatus === "usage_limit_interrupted")
        && createdTaskId !== null && hostId !== null) {
      let cursor: string | undefined;
      const payloads: Record<string, JsonValue>[] = [];
      for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
        const readArguments = {
          threadId: createdTaskId,
          hostId,
          ...(cursor === undefined ? {} : { cursor }),
          includeOutputs: true as const,
          maxOutputCharsPerItem: QUALIFICATION_V2_READ_THREAD_MAX_OUTPUT_CHARS_PER_ITEM,
          turnLimit: 10 as const,
        };
        const observation = await retainOrInvoke({
          mode,
          actionDigest: action.actionDigest,
          toolName: "mcp__codex_app__read_thread",
          invocationOrdinal: ordinal,
          arguments: readArguments,
          invoke: () => dependencies.adapter.readThread(readArguments),
          filePath: path.join(actionRoot, `read-${String(ordinal).padStart(3, "0")}.json`),
          now,
        });
        readObservations.push(observation);
        if (observation.rawResult === null) { terminalStatus = "failed"; break; }
        let retained: RetainedCall;
        try { retained = retainCall(observation.rawResult); } catch { terminalStatus = "failed"; break; }
        if (retained.isError || retained.payload === null
            || retainedPayloadHasTruncationMetadata(retained.payload as JsonValue)
            || (retained.payload.thread as Record<string, JsonValue> | undefined)?.id !== createdTaskId
            || (retained.payload.thread as Record<string, JsonValue> | undefined)?.hostId !== hostId) {
          terminalStatus = "failed";
          break;
        }
        payloads.push(retained.payload);
        const page = retained.payload.page;
        if (page === null || Array.isArray(page) || typeof page !== "object") { terminalStatus = "failed"; break; }
        const pageRecord = page as Record<string, JsonValue>;
        if (pageRecord.hasMore === false && pageRecord.nextCursor === null) break;
        cursor = string(pageRecord.nextCursor) ?? undefined;
        if (cursor === undefined) { terminalStatus = "failed"; break; }
      }
      const messages = terminalMessages(payloads);
      isolationVerified = validateRetainedTaskIsolation({ payloads, action, repositoryRoot: input.repositoryRoot });
      if (terminalStatus === "completed" && messages.length === 1 && isolationVerified) {
        terminalText = messages[0]!;
      }
      else if (terminalStatus === "completed") terminalStatus = "failed";
    }

    let reviewDecision: z.infer<typeof reviewerDecisionInput> | null = null;
    if (action.role !== "author" && terminalStatus === "completed" && terminalText !== null) {
      try { reviewDecision = reviewerDecisionInput.parse(JSON.parse(terminalText)); } catch { terminalStatus = "failed"; }
    }
    let evidenceReadReceiptDigest: string | null = null;
    if (action.role !== "author" && terminalStatus === "completed") {
      if (action.reviewEvidenceSidecar === null || dependencies.reviewEvidenceReadReceiptPath === undefined) {
        terminalStatus = "failed";
        reviewDecision = null;
      } else {
        try {
          const resolvedReceiptPath = await realpath(dependencies.reviewEvidenceReadReceiptPath);
          const receiptRelative = path.relative(resolvedPrivateRoot, resolvedReceiptPath);
          if (receiptRelative.startsWith("..") || path.isAbsolute(receiptRelative)) {
            throw new Error("QUALIFICATION_V2_EVIDENCE_READ_RECEIPT_NOT_PRIVATE");
          }
          const readReceiptBytes = await readPrivate(
            resolvedReceiptPath,
            "Qualification-v2 evidence read receipt",
          );
          const readReceipt = qualificationV2EvidenceSidecarReadReceiptSchema.parse(
            JSON.parse(readReceiptBytes.toString("utf8")),
          );
          verifyQualificationV2EvidenceReadReceipt({
            receipt: readReceipt,
            manifest: action.reviewEvidenceSidecar.manifest,
          });
          evidenceReadReceiptDigest = readReceipt.receiptDigest;
        } catch {
          terminalStatus = "failed";
          reviewDecision = null;
        }
      }
    }
    const terminalResultDigest = terminalText === null
      ? hashCanonicalJson({ terminalStatus, wait: waitObservations.map((item) => item.observationDigest) })
      : sha256Digest(Buffer.from(terminalText, "utf8"));
    const receiptDraft = sealQualificationV2ExternalTaskReceipt({
      schemaVersion: "exp-0001a-qualification-external-task-receipt/v2",
      actionDigest: action.actionDigest,
      dispatchReceiptDigest: dispatched.pendingDispatchReceipt!.receiptDigest,
      taskId: action.taskId,
      role: action.role,
      roleOrdinal: action.roleOrdinal,
      requestedModel: action.arguments.model,
      requestedReasoningEffort: action.arguments.thinking,
      workspace: "projectless",
      repositoryAccess: isolationVerified ? false : "unobservable",
      privateApiAccess: isolationVerified ? false : "unobservable",
      sourceTaskId: null,
      forkedFromTaskId: null,
      createdTaskId,
      hostId,
      clientTaskId,
      rawCreateToolResultDigest: createObservation?.rawResultDigest
        ?? createObservation?.observationDigest
        ?? journal.journalDigest,
      listThreadsObservationDigest,
      rawTerminalToolResultDigest: hashCanonicalJson({
        waits: waitObservations.map((item) => item.observationDigest),
        reads: readObservations.map((item) => item.observationDigest),
        evidenceReadReceiptDigest,
      }),
      terminalStatus,
      terminalResultDigest,
      reviewDecision,
      wallTimeMs: Math.max(0, Date.parse(now()) - Date.parse(journal.recordedAt)),
      subscriptionUsage: "unobservable",
      resolvedModelSnapshot: "unobservable",
      exactTokens: "unobservable",
      retainedAt: now(),
    });
    const receiptPath = path.join(actionRoot, "external-task-receipt.json");
    let receipt = receiptDraft;
    try {
      const retainedReceiptBytes = await readPrivate(receiptPath, "Qualification-v2 external task receipt");
      const retainedReceipt = qualificationV2ExternalTaskReceiptSchema.parse(
        JSON.parse(retainedReceiptBytes.toString("utf8")),
      );
      if (retainedReceipt.actionDigest !== action.actionDigest
          || retainedReceipt.dispatchReceiptDigest !== dispatched.pendingDispatchReceipt!.receiptDigest) {
        throw new Error("QUALIFICATION_V2_RETAINED_TASK_RECEIPT_BINDING_INVALID");
      }
      receipt = retainedReceipt;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await publishExclusive(receiptPath, receipt);
    }
    const finalState = ingestQualificationV2ExternalTaskReceipt(dispatched, receipt, now());
    dispatchedBytes = await replaceStateCas(resolvedState, dispatchedBytes, finalState);
    void dispatchedBytes;
    if (dependencies.crashAfterRetained === "final_state_cas") {
      throw new Error("QUALIFICATION_V2_TEST_CRASH_AFTER_FINAL_STATE_CAS");
    }
    completedNormally = true;
    return Object.freeze({ journal, receipt, state: finalState, actionRoot });
  } finally {
    if (completedNormally) {
      if (recoveryLockPath !== null) await unlink(recoveryLockPath).catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

export async function runQualificationV2PendingAction(
  input: Readonly<{
    repositoryRoot: string;
    statePath: string;
    adapter: QualificationV2CodexAppAdapter;
    reviewEvidenceReadReceiptPath?: string;
  }>,
) {
  if (!trustedHostAdapters.has(input.adapter as object)) throw new Error("QUALIFICATION_V2_TRUSTED_CODEX_HOST_ADAPTER_REQUIRED");
  return runWithAdapter(input, {
    adapter: input.adapter,
    reviewEvidenceReadReceiptPath: input.reviewEvidenceReadReceiptPath,
  }, "dispatch");
}

/** Explicitly reconciles an interrupted runner. It never recreates an action
 * after a release journal existed. The sole create exception is a retained
 * matching dispatch lock with no journal, no dispatch-state transition, and no
 * create observation: that state proves the action was never invocable, so
 * recovery re-authenticates, journals first, and invokes it once. */
export async function recoverQualificationV2PendingAction(
  input: Readonly<{
    repositoryRoot: string;
    statePath: string;
    adapter: QualificationV2CodexAppAdapter;
    reviewEvidenceReadReceiptPath?: string;
  }>,
) {
  if (!trustedHostAdapters.has(input.adapter as object)) throw new Error("QUALIFICATION_V2_TRUSTED_CODEX_HOST_ADAPTER_REQUIRED");
  return runWithAdapter(input, {
    adapter: input.adapter,
    reviewEvidenceReadReceiptPath: input.reviewEvidenceReadReceiptPath,
  }, "recover");
}

/** Test-only seam. Production CLI and scripts do not import this function. */
export async function runQualificationV2PendingActionForTesting(
  input: Readonly<{ repositoryRoot: string; statePath: string }>,
  dependencies: RunnerDependencies,
) {
  return runWithAdapter(input, dependencies, "dispatch");
}

/** Test-only recovery seam. */
export async function recoverQualificationV2PendingActionForTesting(
  input: Readonly<{ repositoryRoot: string; statePath: string }>,
  dependencies: RunnerDependencies,
) {
  return runWithAdapter(input, dependencies, "recover");
}
