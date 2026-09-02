import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  exp0001aCodexSupervisorCreateAuthorizationSchema,
  exp0001aCodexSupervisorRequestSchema,
  type Exp0001aCodexSupervisorCreateAuthorization,
  type Exp0001aCodexSupervisorRequest,
} from "./exp0001a-codex-task-supervisor";
import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

export const EXP0001A_CODEX_TASK_SUPERVISOR_FILE_BRIDGE_VERSION =
  "exp-0001a-codex-task-supervisor-file-bridge/v1" as const;

const digest = z.string().regex(SHA256_DIGEST_PATTERN);
const timestamp = z.string().datetime({ offset: true });

const resultContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_TASK_SUPERVISOR_FILE_BRIDGE_VERSION),
  requestDigest: digest,
  toolName: exp0001aCodexSupervisorRequestSchema.shape.toolName,
  recordedAt: timestamp,
  createAuthorizationDigest: digest.nullable(),
  rawCallToolResult: z.unknown(),
  rawCallToolResultDigest: digest,
}).strict();

export const exp0001aCodexSupervisorBridgeResultSchema = resultContentSchema.extend({
  resultDigest: digest,
}).strict().superRefine((result, context) => {
  const { resultDigest: _resultDigest, ...content } = result;
  void _resultDigest;
  let rawDigest: string | null = null;
  try { rawDigest = hashCanonicalJson(result.rawCallToolResult as JsonValue); } catch { rawDigest = null; }
  if (rawDigest !== result.rawCallToolResultDigest
      || hashCanonicalJson(content as unknown as JsonValue) !== result.resultDigest
      || (result.toolName === "mcp__codex_app__create_thread") !== (result.createAuthorizationDigest !== null)) {
    context.addIssue({ code: "custom", message: "Bridge result is not bound to its exact raw CallToolResult." });
  }
});
export type Exp0001aCodexSupervisorBridgeResult =
  z.infer<typeof exp0001aCodexSupervisorBridgeResultSchema>;

const pointerSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-task-supervisor-bridge-pointer/v1"),
  requestPath: z.string().min(1),
  requestDigest: digest,
  sequence: z.number().int().positive(),
  toolName: exp0001aCodexSupervisorRequestSchema.shape.toolName,
  pointerDigest: digest,
}).strict().superRefine((pointer, context) => {
  const { pointerDigest: _pointerDigest, ...content } = pointer;
  void _pointerDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== pointer.pointerDigest) {
    context.addIssue({ code: "custom", message: "Bridge pointer digest is invalid." });
  }
});

function suffix(toolName: Exp0001aCodexSupervisorRequest["toolName"]) {
  return toolName.replace("mcp__codex_app__", "");
}

function requestFileName(request: Exp0001aCodexSupervisorRequest) {
  return `${String(request.sequence).padStart(4, "0")}-${suffix(request.toolName)}-request.json`;
}

function resultFileName(request: Exp0001aCodexSupervisorRequest) {
  return `${String(request.sequence).padStart(4, "0")}-${suffix(request.toolName)}-result.json`;
}

async function assertPrivateFile(filePath: string) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("EXP0001A_SUPERVISOR_BRIDGE_FILE_UNSAFE");
  }
}

async function readPrivateJson(filePath: string) {
  await assertPrivateFile(filePath);
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function writeExclusive(filePath: string, value: unknown) {
  const temporary = path.join(path.dirname(filePath), `.supervisor-${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${canonicalJson(value as JsonValue)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function replacePrivate(filePath: string, value: unknown) {
  const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1
      || (existing.mode & 0o777) !== 0o600)) {
    throw new Error("EXP0001A_SUPERVISOR_BRIDGE_POINTER_UNSAFE");
  }
  const temporary = path.join(path.dirname(filePath), `.supervisor-pointer-${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${canonicalJson(value as JsonValue)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
}

export async function ensureExp0001aCodexSupervisorPrivateDirectory(input: Readonly<{
  privateRoot: string;
  directory: string;
}>) {
  const root = path.resolve(input.privateRoot);
  const directory = path.resolve(input.directory);
  if (directory !== root && !directory.startsWith(`${root}${path.sep}`)) {
    throw new Error("EXP0001A_SUPERVISOR_PRIVATE_PATH_ESCAPES_ROOT");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (rootMetadata.mode & 0o777) !== 0o700
      || await realpath(root) !== root) {
    throw new Error("EXP0001A_SUPERVISOR_PRIVATE_ROOT_UNSAFE");
  }
  let current = root;
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const prior = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (prior === null) await mkdir(current, { mode: 0o700 });
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
      throw new Error("EXP0001A_SUPERVISOR_PRIVATE_DIRECTORY_UNSAFE");
    }
  }
  if (await realpath(directory) !== directory) throw new Error("EXP0001A_SUPERVISOR_PRIVATE_DIRECTORY_REALPATH_DRIFT");
  return directory;
}

export function exp0001aCodexSupervisorBridgePaths(bridgeRoot: string, request: Exp0001aCodexSupervisorRequest) {
  const parsed = exp0001aCodexSupervisorRequestSchema.parse(request);
  return Object.freeze({
    requestPath: path.join(bridgeRoot, requestFileName(parsed)),
    resultPath: path.join(bridgeRoot, resultFileName(parsed)),
    pointerPath: path.join(bridgeRoot, "current-request.json"),
  });
}

export async function publishExp0001aCodexSupervisorBridgeRequest(input: Readonly<{
  privateRoot: string;
  bridgeRoot: string;
  request: Exp0001aCodexSupervisorRequest;
}>) {
  const bridgeRoot = await ensureExp0001aCodexSupervisorPrivateDirectory({
    privateRoot: input.privateRoot,
    directory: input.bridgeRoot,
  });
  const request = exp0001aCodexSupervisorRequestSchema.parse(input.request);
  const paths = exp0001aCodexSupervisorBridgePaths(bridgeRoot, request);
  const existing = await lstat(paths.requestPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing === null) {
    await writeExclusive(paths.requestPath, request);
  } else {
    const retained = exp0001aCodexSupervisorRequestSchema.parse(await readPrivateJson(paths.requestPath));
    if (canonicalJson(retained as unknown as JsonValue) !== canonicalJson(request as unknown as JsonValue)) {
      throw new Error("EXP0001A_SUPERVISOR_BRIDGE_REQUEST_REPLAY_DRIFT");
    }
  }
  const pointerContent = {
    schemaVersion: "exp-0001a-codex-task-supervisor-bridge-pointer/v1" as const,
    requestPath: paths.requestPath,
    requestDigest: request.requestDigest,
    sequence: request.sequence,
    toolName: request.toolName,
  };
  const pointer = pointerSchema.parse({
    ...pointerContent,
    pointerDigest: hashCanonicalJson(pointerContent as unknown as JsonValue),
  });
  await replacePrivate(paths.pointerPath, pointer);
  return Object.freeze({ request, pointer, ...paths });
}

export async function readExp0001aCodexSupervisorExactBridgeRequest(input: Readonly<{
  privateRoot: string;
  bridgeRoot: string;
}>) {
  const bridgeRoot = await ensureExp0001aCodexSupervisorPrivateDirectory({
    privateRoot: input.privateRoot,
    directory: input.bridgeRoot,
  });
  const pointerPath = path.join(bridgeRoot, "current-request.json");
  const pointer = pointerSchema.parse(await readPrivateJson(pointerPath));
  if (path.dirname(pointer.requestPath) !== bridgeRoot || path.basename(pointer.requestPath)
      !== `${String(pointer.sequence).padStart(4, "0")}-${suffix(pointer.toolName)}-request.json`) {
    throw new Error("EXP0001A_SUPERVISOR_BRIDGE_POINTER_PATH_INVALID");
  }
  const request = exp0001aCodexSupervisorRequestSchema.parse(await readPrivateJson(pointer.requestPath));
  if (request.requestDigest !== pointer.requestDigest || request.sequence !== pointer.sequence
      || request.toolName !== pointer.toolName) {
    throw new Error("EXP0001A_SUPERVISOR_BRIDGE_POINTER_REQUEST_DRIFT");
  }
  return request;
}

export async function recordExp0001aCodexSupervisorBridgeResult(input: Readonly<{
  privateRoot: string;
  bridgeRoot: string;
  requestDigest: string;
  rawCallToolResult: unknown;
  createAuthorization?: Exp0001aCodexSupervisorCreateAuthorization | null;
  now?: () => Date;
}>) {
  const request = await readExp0001aCodexSupervisorExactBridgeRequest(input);
  if (request.requestDigest !== input.requestDigest) {
    throw new Error("EXP0001A_SUPERVISOR_BRIDGE_RESULT_REQUEST_MISMATCH");
  }
  const recordedAt = (input.now?.() ?? new Date()).toISOString();
  let authorizationDigest: string | null = null;
  if (request.toolName === "mcp__codex_app__create_thread") {
    const authorization = exp0001aCodexSupervisorCreateAuthorizationSchema.parse(input.createAuthorization);
    if (request.createAuthorizationDigest !== authorization.authorizationDigest
        || authorization.supervisorId !== request.supervisorId
        || authorization.workItemId !== request.workItemId
        || Date.parse(recordedAt) < Date.parse(request.issuedAt)
        || Date.parse(recordedAt) > Date.parse(authorization.expiresAt)) {
      throw new Error("EXP0001A_SUPERVISOR_BRIDGE_CREATE_AUTHORIZATION_INVALID_OR_EXPIRED");
    }
    authorizationDigest = authorization.authorizationDigest;
  } else if (input.createAuthorization != null) {
    throw new Error("EXP0001A_SUPERVISOR_BRIDGE_NONCREATE_AUTHORIZATION_FORBIDDEN");
  }
  let raw: JsonValue;
  try { raw = JSON.parse(canonicalJson(input.rawCallToolResult)) as JsonValue; } catch {
    throw new Error("EXP0001A_SUPERVISOR_BRIDGE_RESULT_NOT_FINITE_JSON");
  }
  const content = resultContentSchema.parse({
    schemaVersion: EXP0001A_CODEX_TASK_SUPERVISOR_FILE_BRIDGE_VERSION,
    requestDigest: request.requestDigest,
    toolName: request.toolName,
    recordedAt,
    createAuthorizationDigest: authorizationDigest,
    rawCallToolResult: raw,
    rawCallToolResultDigest: hashCanonicalJson(raw),
  });
  const result = exp0001aCodexSupervisorBridgeResultSchema.parse({
    ...content,
    resultDigest: hashCanonicalJson(content as unknown as JsonValue),
  });
  const paths = exp0001aCodexSupervisorBridgePaths(input.bridgeRoot, request);
  const existing = await lstat(paths.resultPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing === null) {
    await writeExclusive(paths.resultPath, result);
  } else {
    const retained = exp0001aCodexSupervisorBridgeResultSchema.parse(await readPrivateJson(paths.resultPath));
    if (retained.requestDigest !== result.requestDigest
        || retained.rawCallToolResultDigest !== result.rawCallToolResultDigest
        || canonicalJson(retained.rawCallToolResult as JsonValue) !== canonicalJson(result.rawCallToolResult as JsonValue)) {
      throw new Error("EXP0001A_SUPERVISOR_BRIDGE_RESULT_REPLAY_DRIFT");
    }
    return retained;
  }
  return result;
}

export async function readExp0001aCodexSupervisorBridgeResult(input: Readonly<{
  privateRoot: string;
  bridgeRoot: string;
  request: Exp0001aCodexSupervisorRequest;
}>) {
  const bridgeRoot = await ensureExp0001aCodexSupervisorPrivateDirectory({
    privateRoot: input.privateRoot,
    directory: input.bridgeRoot,
  });
  const request = exp0001aCodexSupervisorRequestSchema.parse(input.request);
  const resultPath = exp0001aCodexSupervisorBridgePaths(bridgeRoot, request).resultPath;
  const exists = await lstat(resultPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (exists === null) return null;
  const result = exp0001aCodexSupervisorBridgeResultSchema.parse(await readPrivateJson(resultPath));
  if (result.requestDigest !== request.requestDigest || result.toolName !== request.toolName) {
    throw new Error("EXP0001A_SUPERVISOR_BRIDGE_RETAINED_RESULT_BINDING_INVALID");
  }
  return result;
}

export async function exp0001aCodexSupervisorBridgeRedactedStatus(input: Readonly<{
  privateRoot: string;
  bridgeRoot: string;
}>) {
  const request = await readExp0001aCodexSupervisorExactBridgeRequest(input);
  const result = await readExp0001aCodexSupervisorBridgeResult({ ...input, request });
  return Object.freeze({
    schemaVersion: "exp-0001a-codex-task-supervisor-bridge-status/v1" as const,
    sequence: request.sequence,
    toolName: request.toolName,
    requestDigest: request.requestDigest,
    argumentsDigest: request.argumentsDigest,
    issuedAt: request.issuedAt,
    resultRecorded: result !== null,
    resultDigest: result?.resultDigest ?? null,
  });
}
