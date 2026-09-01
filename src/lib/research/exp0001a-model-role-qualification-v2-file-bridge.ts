import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { canonicalJson, hashCanonicalJson, SHA256_DIGEST_PATTERN, type JsonValue } from "./provenance-crypto";
import {
  bindQualificationV2CodexAppHostAdapter,
  type QualificationV2CodexAppAdapter,
} from "./exp0001a-model-role-qualification-v2-task-runner";
import { qualificationV2CodexAuthReceiptSchema } from "./exp0001a-model-role-qualification-v2-coordinator";

const digest = z.string().regex(SHA256_DIGEST_PATTERN);
const toolName = z.enum([
  "mcp__codex_app__create_thread",
  "mcp__codex_app__list_threads",
  "mcp__codex_app__wait_threads",
  "mcp__codex_app__read_thread",
]);
export const qualificationV2BridgeRequestSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-codex-app-bridge-request/v2"),
  sequence: z.number().int().positive(),
  toolName,
  arguments: z.unknown(),
  argumentsDigest: digest,
  actionDigest: digest.nullable(),
  releaseJournalDigest: digest.nullable(),
  requestedAt: z.string().datetime({ offset: true }),
  requestDigest: digest,
}).strict().superRefine((request, context) => {
  const { requestDigest: _requestDigest, ...content } = request;
  void _requestDigest;
  if (hashCanonicalJson(request.arguments as JsonValue) !== request.argumentsDigest
      || hashCanonicalJson(content as unknown as JsonValue) !== request.requestDigest
      || (request.toolName === "mcp__codex_app__create_thread")
        !== (request.actionDigest !== null && request.releaseJournalDigest !== null)) {
    context.addIssue({ code: "custom", message: "Bridge request digest is invalid." });
  }
});

export const qualificationV2BridgeCreateAuthorizationSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-create-invocation-authorization/v2"),
  requestDigest: digest,
  actionDigest: digest,
  releaseJournalDigest: digest,
  authReceipt: qualificationV2CodexAuthReceiptSchema,
  authorizedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  authorizationDigest: digest,
}).strict().superRefine((authorization, context) => {
  const { authorizationDigest: _authorizationDigest, ...content } = authorization;
  void _authorizationDigest;
  const ageMs = Date.parse(authorization.authorizedAt) - Date.parse(authorization.authReceipt.checkedAt);
  if (ageMs < 0 || ageMs > 5 * 60_000
      || Date.parse(authorization.expiresAt) - Date.parse(authorization.authorizedAt) !== 5 * 60_000
      || hashCanonicalJson(content as unknown as JsonValue) !== authorization.authorizationDigest) {
    context.addIssue({ code: "custom", message: "Create invocation authorization is invalid." });
  }
});

export const qualificationV2BridgeResultSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-codex-app-bridge-result/v2"),
  requestDigest: digest,
  toolName,
  recordedAt: z.string().datetime({ offset: true }),
  createInvocationAuthorizationDigest: digest.nullable(),
  resultAuthReceipt: qualificationV2CodexAuthReceiptSchema.nullable(),
  resultAuthReceiptDigest: digest.nullable(),
  rawCallToolResult: z.unknown(),
  rawCallToolResultDigest: digest,
  resultDigest: digest,
}).strict().superRefine((result, context) => {
  const { resultDigest: _resultDigest, ...content } = result;
  void _resultDigest;
  let rawDigest: string | null = null;
  try { rawDigest = hashCanonicalJson(result.rawCallToolResult as JsonValue); } catch { rawDigest = null; }
  if (rawDigest !== result.rawCallToolResultDigest
      || hashCanonicalJson(content as unknown as JsonValue) !== result.resultDigest
      || (result.resultAuthReceipt === null
        ? result.resultAuthReceiptDigest !== null
        : result.resultAuthReceipt.receiptSha256 !== result.resultAuthReceiptDigest)
      || (result.toolName === "mcp__codex_app__create_thread")
        !== (result.createInvocationAuthorizationDigest !== null
          && result.resultAuthReceipt !== null
          && result.resultAuthReceiptDigest !== null)) {
    context.addIssue({ code: "custom", message: "Bridge result is not bound to its exact raw CallToolResult." });
  }
});

const CREATE_AUTHORIZATION_MAX_AGE_MS = 5 * 60_000;

async function publishExclusive(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.qualification-v2-bridge-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, filePath); } finally { await unlink(temporary).catch(() => undefined); }
}

async function replacePrivate(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1
      || (existing.mode & 0o777) !== 0o600)) throw new Error("QUALIFICATION_V2_BRIDGE_POINTER_UNSAFE");
  const temporary = path.join(path.dirname(filePath), `.qualification-v2-pointer-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filePath);
}

async function readPrivateJson(filePath: string) {
  // A no-replace publication briefly has two hard links while its private
  // temporary name is being retired. Under a busy trusted host that window can
  // outlive a few scheduler ticks, so wait for the completed single-link state
  // without ever accepting the in-flight file as authoritative.
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const metadata = await lstat(filePath);
    if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && (metadata.mode & 0o777) === 0o600) {
      const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { return JSON.parse((await handle.readFile()).toString("utf8")) as unknown; } finally { await handle.close(); }
    }
    if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 2 && (metadata.mode & 0o777) === 0o600) {
      const directory = path.dirname(filePath);
      const names = await readdir(directory);
      let samePublishTemporaryExists = false;
      for (const name of names.filter((candidate) => /^\.qualification-v2-bridge-[a-f0-9-]+\.tmp$/.test(candidate))) {
        const candidate = await lstat(path.join(directory, name)).catch(() => null);
        if (candidate !== null && candidate.dev === metadata.dev && candidate.ino === metadata.ino) {
          samePublishTemporaryExists = true;
          break;
        }
      }
      if (samePublishTemporaryExists) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        continue;
      }
    }
    throw new Error("QUALIFICATION_V2_BRIDGE_FILE_UNSAFE");
  }
  throw new Error("QUALIFICATION_V2_BRIDGE_FILE_PUBLISH_STALLED");
}

function slotName(sequence: number, name: z.infer<typeof toolName>) {
  return `${String(sequence).padStart(3, "0")}-${name.replace("mcp__codex_app__", "")}`;
}

/** Creates the bridge path one component at a time beneath the already-private
 * root and verifies every component before any release journal may be written.
 * The resolved path is returned so later bridge writes cannot accidentally use
 * a caller-supplied alias or symlink spelling. */
export async function ensureQualificationV2FileBridgeRoot(input: Readonly<{
  privateRoot: string;
  bridgeRoot: string;
}>) {
  const privateMetadata = await lstat(input.privateRoot);
  if (!privateMetadata.isDirectory() || privateMetadata.isSymbolicLink()
      || (privateMetadata.mode & 0o777) !== 0o700) {
    throw new Error("QUALIFICATION_V2_BRIDGE_PRIVATE_ROOT_UNSAFE");
  }
  const resolvedPrivateRoot = await realpath(input.privateRoot);
  const relative = path.relative(path.resolve(input.privateRoot), path.resolve(input.bridgeRoot));
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("QUALIFICATION_V2_BRIDGE_ROOT_NOT_PRIVATE");
  }
  let current = resolvedPrivateRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
      throw new Error("QUALIFICATION_V2_BRIDGE_ROOT_UNSAFE");
    }
    if (await realpath(current) !== current) throw new Error("QUALIFICATION_V2_BRIDGE_ROOT_UNSAFE");
  }
  return current;
}

function createAuthorizationPath(bridgeRoot: string, sequence: number) {
  return path.join(bridgeRoot, `${slotName(sequence, "mcp__codex_app__create_thread")}-create-authorization.json`);
}

export async function authorizeQualificationV2FileBridgeCreateRequest(input: Readonly<{
  bridgeRoot: string;
  sequence: number;
  authReceipt: unknown;
  now?: () => string;
}>) {
  const request = qualificationV2BridgeRequestSchema.parse(await readPrivateJson(path.join(
    input.bridgeRoot,
    `${slotName(input.sequence, "mcp__codex_app__create_thread")}-request.json`,
  )));
  if (request.sequence !== input.sequence
      || request.toolName !== "mcp__codex_app__create_thread"
      || request.actionDigest === null
      || request.releaseJournalDigest === null) {
    throw new Error("QUALIFICATION_V2_BRIDGE_CREATE_AUTH_REQUEST_MISMATCH");
  }
  const authReceipt = qualificationV2CodexAuthReceiptSchema.parse(input.authReceipt);
  const authorizedAt = (input.now ?? (() => new Date().toISOString()))();
  const checkedAgeMs = Date.parse(authorizedAt) - Date.parse(authReceipt.checkedAt);
  if (!Number.isFinite(checkedAgeMs) || checkedAgeMs < 0 || checkedAgeMs > CREATE_AUTHORIZATION_MAX_AGE_MS) {
    throw new Error("QUALIFICATION_V2_BRIDGE_CREATE_AUTH_STALE");
  }
  if (Date.parse(authorizedAt) < Date.parse(request.requestedAt)) {
    throw new Error("QUALIFICATION_V2_BRIDGE_CREATE_AUTH_TIME_NONMONOTONIC");
  }
  const expiresAt = new Date(Date.parse(authorizedAt) + CREATE_AUTHORIZATION_MAX_AGE_MS).toISOString();
  const content = {
    schemaVersion: "exp-0001a-qualification-create-invocation-authorization/v2" as const,
    requestDigest: request.requestDigest,
    actionDigest: request.actionDigest,
    releaseJournalDigest: request.releaseJournalDigest,
    authReceipt,
    authorizedAt,
    expiresAt,
  };
  const authorization = qualificationV2BridgeCreateAuthorizationSchema.parse({
    ...content,
    authorizationDigest: hashCanonicalJson(content as unknown as JsonValue),
  });
  const authorizationPath = createAuthorizationPath(input.bridgeRoot, input.sequence);
  try {
    await publishExclusive(authorizationPath, authorization);
    return authorization;
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const retained = qualificationV2BridgeCreateAuthorizationSchema.parse(await readPrivateJson(authorizationPath));
    if (retained.requestDigest !== authorization.requestDigest
        || retained.actionDigest !== authorization.actionDigest
        || retained.releaseJournalDigest !== authorization.releaseJournalDigest
        || Date.parse(retained.expiresAt) < Date.parse(authorizedAt)) {
      throw new Error("QUALIFICATION_V2_BRIDGE_CREATE_AUTH_CONFLICT");
    }
    return retained;
  }
}

export async function recordQualificationV2FileBridgeResult(input: Readonly<{
  bridgeRoot: string;
  sequence: number;
  toolName: z.infer<typeof toolName>;
  rawCallToolResult: unknown;
  resultAuthReceipt?: unknown;
  now?: () => string;
}>) {
  const slot = slotName(input.sequence, input.toolName);
  const request = qualificationV2BridgeRequestSchema.parse(await readPrivateJson(path.join(input.bridgeRoot, `${slot}-request.json`)));
  if (request.sequence !== input.sequence || request.toolName !== input.toolName) {
    throw new Error("QUALIFICATION_V2_BRIDGE_RESULT_REQUEST_MISMATCH");
  }
  const recordedAt = (input.now ?? (() => new Date().toISOString()))();
  if (Date.parse(recordedAt) < Date.parse(request.requestedAt)) {
    throw new Error("QUALIFICATION_V2_BRIDGE_RESULT_TIME_NONMONOTONIC");
  }
  let createInvocationAuthorizationDigest: string | null = null;
  let retainedResultAuthReceipt: z.infer<typeof qualificationV2CodexAuthReceiptSchema> | null = null;
  let resultAuthReceiptDigest: string | null = null;
  if (input.toolName === "mcp__codex_app__create_thread") {
    const authorization = qualificationV2BridgeCreateAuthorizationSchema.parse(
      await readPrivateJson(createAuthorizationPath(input.bridgeRoot, input.sequence)),
    );
    const resultAuthReceipt = qualificationV2CodexAuthReceiptSchema.parse(input.resultAuthReceipt);
    const resultAuthAgeMs = Date.parse(recordedAt) - Date.parse(resultAuthReceipt.checkedAt);
    if (authorization.requestDigest !== request.requestDigest
        || authorization.actionDigest !== request.actionDigest
        || authorization.releaseJournalDigest !== request.releaseJournalDigest
        || Date.parse(recordedAt) < Date.parse(authorization.authorizedAt)
        || Date.parse(recordedAt) > Date.parse(authorization.expiresAt)
        || !Number.isFinite(resultAuthAgeMs)
        || resultAuthAgeMs < 0
        || resultAuthAgeMs > CREATE_AUTHORIZATION_MAX_AGE_MS) {
      throw new Error("QUALIFICATION_V2_BRIDGE_CREATE_RESULT_AUTH_INVALID");
    }
    createInvocationAuthorizationDigest = authorization.authorizationDigest;
    retainedResultAuthReceipt = resultAuthReceipt;
    resultAuthReceiptDigest = resultAuthReceipt.receiptSha256;
  } else if (input.resultAuthReceipt !== undefined) {
    throw new Error("QUALIFICATION_V2_BRIDGE_NONCREATE_RESULT_AUTH_FORBIDDEN");
  }
  const rawCallToolResult = JSON.parse(canonicalJson(input.rawCallToolResult)) as JsonValue;
  const content = {
    schemaVersion: "exp-0001a-qualification-codex-app-bridge-result/v2" as const,
    requestDigest: request.requestDigest,
    toolName: input.toolName,
    recordedAt,
    createInvocationAuthorizationDigest,
    resultAuthReceipt: retainedResultAuthReceipt,
    resultAuthReceiptDigest,
    rawCallToolResult,
    rawCallToolResultDigest: hashCanonicalJson(rawCallToolResult),
  };
  const result = qualificationV2BridgeResultSchema.parse({
    ...content,
    resultDigest: hashCanonicalJson(content as unknown as JsonValue),
  });
  await publishExclusive(path.join(input.bridgeRoot, `${slot}-result.json`), result);
  return result;
}

async function unresolvedRequestFromSlots(bridgeRoot: string) {
  const names = await readdir(bridgeRoot);
  const unresolved = names.filter((name) => /^\d{3}-(?:create_thread|list_threads|wait_threads|read_thread)-request\.json$/.test(name))
    .filter((name) => !names.includes(name.replace(/-request\.json$/, "-result.json")));
  if (unresolved.length === 0) return null;
  if (unresolved.length !== 1) throw new Error("QUALIFICATION_V2_BRIDGE_UNRESOLVED_REQUEST_AMBIGUOUS");
  return qualificationV2BridgeRequestSchema.parse(await readPrivateJson(path.join(bridgeRoot, unresolved[0]!)));
}

export async function readQualificationV2FileBridgeStatus(bridgeRoot: string) {
  const metadata = await lstat(bridgeRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("QUALIFICATION_V2_BRIDGE_ROOT_UNSAFE");
  }
  const pointerPath = path.join(bridgeRoot, "current-request.json");
  const pointerRaw = await readPrivateJson(pointerPath)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (pointerRaw === null) {
    const request = await unresolvedRequestFromSlots(bridgeRoot);
    if (request === null) return Object.freeze({ status: "idle" as const });
    return Object.freeze({ status: "awaiting_raw_result" as const, request });
  }
  const pointer = z.object({ requestPath: z.string(), requestDigest: digest }).strict().parse(pointerRaw);
  if (await realpath(path.dirname(pointer.requestPath)) !== await realpath(bridgeRoot)
      || !/^\d{3}-(?:create_thread|list_threads|wait_threads|read_thread)-request\.json$/.test(path.basename(pointer.requestPath))) {
    throw new Error("QUALIFICATION_V2_BRIDGE_POINTER_PATH_INVALID");
  }
  const request = qualificationV2BridgeRequestSchema.parse(await readPrivateJson(pointer.requestPath));
  if (request.requestDigest !== pointer.requestDigest) throw new Error("QUALIFICATION_V2_BRIDGE_POINTER_MISMATCH");
  const resultPath = pointer.requestPath.replace(/-request\.json$/, "-result.json");
  const result = await readPrivateJson(resultPath)
    .then((value) => qualificationV2BridgeResultSchema.parse(value))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.message === "QUALIFICATION_V2_BRIDGE_FILE_UNSAFE") return null;
      throw error;
    });
  if (result !== null && (result.requestDigest !== request.requestDigest || result.toolName !== request.toolName)) {
    throw new Error("QUALIFICATION_V2_BRIDGE_RESULT_BINDING_INVALID");
  }
  return Object.freeze({ status: result === null ? "awaiting_raw_result" as const : "raw_result_recorded" as const, request });
}

export function createQualificationV2FileBridgeAdapter(input: Readonly<{
  privateRoot: string;
  bridgeRoot: string;
  now?: () => string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  getCreateBinding?: () => Promise<Readonly<{
    actionDigest: string;
    releaseJournalDigest: string;
  }>>;
}>) {
  let sequence: number | null = null;
  const now = input.now ?? (() => new Date().toISOString());
  const bridgeRootPromise = ensureQualificationV2FileBridgeRoot({
    privateRoot: input.privateRoot,
    bridgeRoot: input.bridgeRoot,
  });
  const invoke = async (name: z.infer<typeof toolName>, args: unknown) => {
    const bridgeRoot = await bridgeRootPromise;
    if (sequence === null) {
      const names = await readdir(bridgeRoot);
      sequence = names.reduce((maximum, fileName) => {
        const match = /^(\d{3})-(?:create_thread|list_threads|wait_threads|read_thread)-request\.json$/.exec(fileName);
        return match === null ? maximum : Math.max(maximum, Number(match[1]));
      }, 0);
    }
    sequence += 1;
    const slot = slotName(sequence, name);
    const createBinding = name === "mcp__codex_app__create_thread"
      ? await input.getCreateBinding?.()
      : null;
    if (name === "mcp__codex_app__create_thread" && createBinding === undefined) {
      throw new Error("QUALIFICATION_V2_BRIDGE_CREATE_BINDING_REQUIRED");
    }
    const content = {
      schemaVersion: "exp-0001a-qualification-codex-app-bridge-request/v2" as const,
      sequence,
      toolName: name,
      arguments: args,
      argumentsDigest: hashCanonicalJson(args as JsonValue),
      actionDigest: createBinding?.actionDigest ?? null,
      releaseJournalDigest: createBinding?.releaseJournalDigest ?? null,
      requestedAt: now(),
    };
    const request = qualificationV2BridgeRequestSchema.parse({
      ...content,
      requestDigest: hashCanonicalJson(content as unknown as JsonValue),
    });
    const requestPath = path.join(bridgeRoot, `${slot}-request.json`);
    await publishExclusive(requestPath, request);
    const pointerContent = { requestPath, requestDigest: request.requestDigest };
    const pointerPath = path.join(bridgeRoot, "current-request.json");
    await replacePrivate(pointerPath, pointerContent);
    const resultPath = path.join(bridgeRoot, `${slot}-result.json`);
    const deadline = Date.now() + (input.maxWaitMs ?? 24 * 60 * 60_000);
    while (Date.now() <= deadline) {
      const result = await readPrivateJson(resultPath).then((value) => qualificationV2BridgeResultSchema.parse(value)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.message === "QUALIFICATION_V2_BRIDGE_FILE_UNSAFE") return null;
        throw error;
      });
      if (result !== null) {
        if (result.requestDigest !== request.requestDigest || result.toolName !== name) {
          throw new Error("QUALIFICATION_V2_BRIDGE_RESULT_BINDING_INVALID");
        }
        // Keep the pointer until the next request atomically replaces it. This
        // avoids a lost-pointer window between two Codex-app calls; status can
        // distinguish a recorded result from a request still awaiting input.
        return result.rawCallToolResult;
      }
      await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs ?? 100));
    }
    throw new Error("QUALIFICATION_V2_BRIDGE_RESULT_TIMEOUT_NO_RETRY");
  };
  const adapter: QualificationV2CodexAppAdapter = {
    createThread: (args) => invoke("mcp__codex_app__create_thread", args),
    listThreads: (args) => invoke("mcp__codex_app__list_threads", args),
    waitThreads: (args) => invoke("mcp__codex_app__wait_threads", args),
    readThread: (args) => invoke("mcp__codex_app__read_thread", args),
  };
  return bindQualificationV2CodexAppHostAdapter(adapter);
}
