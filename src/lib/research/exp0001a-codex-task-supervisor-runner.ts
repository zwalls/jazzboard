import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

// @ts-expect-error committed ESM auth preflight intentionally has no declaration file
import { runCodexAuthPreflight } from "../../../research/scripts/codex-auth-preflight.mjs";

import {
  authorizeExp0001aCodexSupervisorCreate,
  createExp0001aCodexTaskSupervisor,
  exp0001aCodexSupervisorAuthReceiptSchema,
  exp0001aCodexSupervisorRedactedStatus,
  exp0001aCodexTaskSupervisorStateSchema,
  ingestExp0001aCodexSupervisorRawResult,
  prepareNextExp0001aCodexSupervisorRequest,
  type Exp0001aCodexSupervisorRole,
  type Exp0001aCodexTaskSupervisorState,
} from "./exp0001a-codex-task-supervisor";
import {
  ensureExp0001aCodexSupervisorPrivateDirectory,
  exp0001aCodexSupervisorBridgeRedactedStatus,
  publishExp0001aCodexSupervisorBridgeRequest,
  readExp0001aCodexSupervisorBridgeResult,
  recordExp0001aCodexSupervisorBridgeResult,
} from "./exp0001a-codex-task-supervisor-file-bridge";
import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

export const EXP0001A_CODEX_TASK_SUPERVISOR_RUNNER_VERSION =
  "exp-0001a-codex-task-supervisor-runner/v1" as const;
export const EXP0001A_CODEX_TASK_SUPERVISOR_PRIVATE_DIRECTORY =
  "exp0001a-codex-task-supervisor-v1" as const;

const digest = z.string().regex(SHA256_DIGEST_PATTERN);
const timestamp = z.string().datetime({ offset: true });
const opaqueId = z.string().trim().min(1).max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const claimContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-task-supervisor-transition-claim/v1"),
  supervisorId: opaqueId,
  priorStateDigest: digest,
  operation: z.enum(["authorize_create", "publish_request", "ingest_result", "terminal_noop"]),
  claimedAt: timestamp,
}).strict();
const claimSchema = claimContentSchema.extend({ claimDigest: digest }).strict().superRefine((claim, context) => {
  const { claimDigest: _claimDigest, ...content } = claim;
  void _claimDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== claim.claimDigest) {
    context.addIssue({ code: "custom", message: "Transition claim digest is invalid." });
  }
});

type RunnerPaths = Readonly<{
  privateRoot: string;
  runRoot: string;
  statesRoot: string;
  claimsRoot: string;
  bridgeRoot: string;
}>;

export function exp0001aCodexTaskSupervisorRunnerPaths(repositoryRoot: string, supervisorId: string): RunnerPaths {
  const id = opaqueId.parse(supervisorId);
  const privateRoot = path.join(
    path.resolve(repositoryRoot),
    ".research-private",
    EXP0001A_CODEX_TASK_SUPERVISOR_PRIVATE_DIRECTORY,
  );
  const runRoot = path.join(privateRoot, id);
  return Object.freeze({
    privateRoot,
    runRoot,
    statesRoot: path.join(runRoot, "states"),
    claimsRoot: path.join(runRoot, "claims"),
    bridgeRoot: path.join(runRoot, "bridge"),
  });
}

async function writeExclusive(filePath: string, value: unknown) {
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${canonicalJson(value as JsonValue)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replacePrivate(filePath: string, value: unknown) {
  const temporary = path.join(path.dirname(filePath), `.runner-${randomUUID()}.tmp`);
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

async function readPrivateJson(filePath: string) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("EXP0001A_SUPERVISOR_RUNNER_FILE_UNSAFE");
  }
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function ensurePaths(paths: RunnerPaths) {
  await ensureExp0001aCodexSupervisorPrivateDirectory({
    privateRoot: paths.privateRoot,
    directory: paths.bridgeRoot,
  });
  await ensureExp0001aCodexSupervisorPrivateDirectory({
    privateRoot: paths.privateRoot,
    directory: paths.statesRoot,
  });
  await ensureExp0001aCodexSupervisorPrivateDirectory({
    privateRoot: paths.privateRoot,
    directory: paths.claimsRoot,
  });
}

function statePath(paths: RunnerPaths, state: Exp0001aCodexTaskSupervisorState) {
  return path.join(paths.statesRoot, `${state.stateDigest.slice("sha256:".length)}.json`);
}

async function retainState(paths: RunnerPaths, stateInput: Exp0001aCodexTaskSupervisorState) {
  const state = exp0001aCodexTaskSupervisorStateSchema.parse(stateInput);
  const filePath = statePath(paths, state);
  const exists = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (exists === null) {
    await writeExclusive(filePath, state);
  } else {
    const retained = exp0001aCodexTaskSupervisorStateSchema.parse(await readPrivateJson(filePath));
    if (canonicalJson(retained as unknown as JsonValue) !== canonicalJson(state as unknown as JsonValue)) {
      throw new Error("EXP0001A_SUPERVISOR_STATE_DIGEST_COLLISION");
    }
  }
  return state;
}

export async function loadExp0001aCodexTaskSupervisorState(input: Readonly<{
  repositoryRoot: string;
  supervisorId: string;
}>) {
  const paths = exp0001aCodexTaskSupervisorRunnerPaths(input.repositoryRoot, input.supervisorId);
  await ensurePaths(paths);
  const names = (await readdir(paths.statesRoot)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  if (names.length === 0) throw new Error("EXP0001A_SUPERVISOR_STATE_NOT_INITIALIZED");
  const states = await Promise.all(names.map(async (name) => {
    const state = exp0001aCodexTaskSupervisorStateSchema.parse(
      await readPrivateJson(path.join(paths.statesRoot, name)),
    );
    if (name !== `${state.stateDigest.slice("sha256:".length)}.json`
        || state.supervisorId !== input.supervisorId) {
      throw new Error("EXP0001A_SUPERVISOR_STATE_FILE_BINDING_INVALID");
    }
    return state;
  }));
  const roots = states.filter((state) => state.priorStateDigest === null);
  if (roots.length !== 1) throw new Error("EXP0001A_SUPERVISOR_STATE_ROOT_NOT_UNIQUE");
  const childByPrior = new Map<string, Exp0001aCodexTaskSupervisorState>();
  for (const state of states) {
    if (state.priorStateDigest === null) continue;
    const prior = childByPrior.get(state.priorStateDigest);
    if (prior !== undefined && prior.stateDigest !== state.stateDigest) {
      throw new Error("EXP0001A_SUPERVISOR_STATE_CHAIN_FORKED");
    }
    childByPrior.set(state.priorStateDigest, state);
  }
  let current = roots[0]!;
  const visited = new Set([current.stateDigest]);
  while (childByPrior.has(current.stateDigest)) {
    current = childByPrior.get(current.stateDigest)!;
    if (visited.has(current.stateDigest)) throw new Error("EXP0001A_SUPERVISOR_STATE_CHAIN_CYCLE");
    visited.add(current.stateDigest);
  }
  if (visited.size !== states.length) throw new Error("EXP0001A_SUPERVISOR_STATE_CHAIN_DISCONNECTED");
  return Object.freeze({ paths, state: current });
}

export async function initializeExp0001aCodexTaskSupervisorRun(input: Readonly<{
  repositoryRoot: string;
  supervisorId: string;
  workItemId: string;
  role: Exp0001aCodexSupervisorRole;
  prompt: string;
  preparedAt: string;
  forbiddenTaskIds?: readonly string[];
}>) {
  const paths = exp0001aCodexTaskSupervisorRunnerPaths(input.repositoryRoot, input.supervisorId);
  await ensurePaths(paths);
  const existing = (await readdir(paths.statesRoot)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  const candidate = createExp0001aCodexTaskSupervisor(input);
  if (existing.length > 0) {
    const retained = await loadExp0001aCodexTaskSupervisorState(input);
    if (canonicalJson(retained.state as unknown as JsonValue) !== canonicalJson(candidate as unknown as JsonValue)) {
      throw new Error("EXP0001A_SUPERVISOR_INITIALIZATION_REPLAY_DRIFT");
    }
    return retained;
  }
  await retainState(paths, candidate);
  return Object.freeze({ paths, state: candidate });
}

function transitionOperation(state: Exp0001aCodexTaskSupervisorState) {
  if (["completed", "failed", "usage_limit_interrupted"].includes(state.phase)) return "terminal_noop" as const;
  if (state.pendingRequest !== null) return "ingest_result" as const;
  if (state.phase === "prepared") return "authorize_create" as const;
  return "publish_request" as const;
}

async function retainClaim(paths: RunnerPaths, state: Exp0001aCodexTaskSupervisorState, now: () => Date) {
  const filePath = path.join(paths.claimsRoot, `${state.stateDigest.slice("sha256:".length)}.json`);
  const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) return claimSchema.parse(await readPrivateJson(filePath));
  const content = claimContentSchema.parse({
    schemaVersion: "exp-0001a-codex-task-supervisor-transition-claim/v1",
    supervisorId: state.supervisorId,
    priorStateDigest: state.stateDigest,
    operation: transitionOperation(state),
    claimedAt: now().toISOString(),
  });
  const claim = claimSchema.parse({ ...content, claimDigest: hashCanonicalJson(content as unknown as JsonValue) });
  try {
    await writeExclusive(filePath, claim);
    return claim;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return claimSchema.parse(await readPrivateJson(filePath));
  }
}

async function retainedAuthForClaim(input: Readonly<{
  paths: RunnerPaths;
  state: Exp0001aCodexTaskSupervisorState;
  claimDigest: string;
  runAuthPreflight: () => Promise<unknown>;
}>) {
  const filePath = path.join(input.paths.claimsRoot, `${input.state.stateDigest.slice("sha256:".length)}-auth.json`);
  const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    const retained = z.object({ claimDigest: digest, authReceipt: exp0001aCodexSupervisorAuthReceiptSchema }).strict()
      .parse(await readPrivateJson(filePath));
    if (retained.claimDigest !== input.claimDigest) throw new Error("EXP0001A_SUPERVISOR_AUTH_CLAIM_DRIFT");
    return retained.authReceipt;
  }
  const authReceipt = exp0001aCodexSupervisorAuthReceiptSchema.parse(await input.runAuthPreflight());
  try {
    await writeExclusive(filePath, { claimDigest: input.claimDigest, authReceipt });
    return authReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const retained = z.object({ claimDigest: digest, authReceipt: exp0001aCodexSupervisorAuthReceiptSchema }).strict()
      .parse(await readPrivateJson(filePath));
    if (retained.claimDigest !== input.claimDigest) throw new Error("EXP0001A_SUPERVISOR_AUTH_CLAIM_DRIFT");
    return retained.authReceipt;
  }
}

export type Exp0001aCodexSupervisorRunnerDependencies = Readonly<{
  now?: () => Date;
  runAuthPreflight?: () => Promise<unknown>;
}>;

export async function advanceExp0001aCodexTaskSupervisorRun(
  input: Readonly<{ repositoryRoot: string; supervisorId: string }>,
  dependencies: Exp0001aCodexSupervisorRunnerDependencies = {},
) {
  const now = dependencies.now ?? (() => new Date());
  const runAuth = dependencies.runAuthPreflight ?? (() => runCodexAuthPreflight());
  const loaded = await loadExp0001aCodexTaskSupervisorState(input);
  let state = loaded.state;
  const claim = await retainClaim(loaded.paths, state, now);
  if (claim.priorStateDigest !== state.stateDigest || claim.operation !== transitionOperation(state)) {
    throw new Error("EXP0001A_SUPERVISOR_TRANSITION_CLAIM_DRIFT");
  }
  if (["completed", "failed", "usage_limit_interrupted"].includes(state.phase)) {
    return Object.freeze({ status: "terminal" as const, state, redacted: exp0001aCodexSupervisorRedactedStatus(state) });
  }
  if (state.pendingRequest !== null) {
    await publishExp0001aCodexSupervisorBridgeRequest({
      privateRoot: loaded.paths.privateRoot,
      bridgeRoot: loaded.paths.bridgeRoot,
      request: state.pendingRequest,
    });
    const result = await readExp0001aCodexSupervisorBridgeResult({
      privateRoot: loaded.paths.privateRoot,
      bridgeRoot: loaded.paths.bridgeRoot,
      request: state.pendingRequest,
    });
    if (result === null) {
      const expired = state.createAuthorization !== null
        && state.pendingRequest.toolName === "mcp__codex_app__create_thread"
        && now().getTime() > Date.parse(state.createAuthorization.expiresAt);
      return Object.freeze({
        status: expired ? "create_authorization_expired" as const : "awaiting_host_result" as const,
        state,
        redacted: exp0001aCodexSupervisorRedactedStatus(state),
        bridge: await exp0001aCodexSupervisorBridgeRedactedStatus({
          privateRoot: loaded.paths.privateRoot,
          bridgeRoot: loaded.paths.bridgeRoot,
        }),
      });
    }
    state = ingestExp0001aCodexSupervisorRawResult({
      state,
      rawCallToolResult: result.rawCallToolResult,
      observedAt: result.recordedAt,
    });
    await retainState(loaded.paths, state);
    return Object.freeze({ status: "result_ingested" as const, state, redacted: exp0001aCodexSupervisorRedactedStatus(state) });
  }
  if (state.phase === "prepared") {
    const authReceipt = await retainedAuthForClaim({
      paths: loaded.paths,
      state,
      claimDigest: claim.claimDigest,
      runAuthPreflight: runAuth,
    });
    state = authorizeExp0001aCodexSupervisorCreate({
      state,
      authReceipt,
      // The preflight necessarily runs after the transition claim is retained.
      // Bind release time to the trusted preflight observation rather than the
      // earlier claim timestamp so a fresh receipt cannot appear to come from
      // the future, while replay remains deterministic from retained bytes.
      authorizedAt: authReceipt.checkedAt,
    });
  } else {
    state = prepareNextExp0001aCodexSupervisorRequest({ state, issuedAt: claim.claimedAt });
  }
  await retainState(loaded.paths, state);
  if (state.pendingRequest === null) throw new Error("EXP0001A_SUPERVISOR_RUNNER_PENDING_REQUEST_NOT_CREATED");
  await publishExp0001aCodexSupervisorBridgeRequest({
    privateRoot: loaded.paths.privateRoot,
    bridgeRoot: loaded.paths.bridgeRoot,
    request: state.pendingRequest,
  });
  return Object.freeze({
    status: "request_published" as const,
    state,
    redacted: exp0001aCodexSupervisorRedactedStatus(state),
    bridge: await exp0001aCodexSupervisorBridgeRedactedStatus({
      privateRoot: loaded.paths.privateRoot,
      bridgeRoot: loaded.paths.bridgeRoot,
    }),
  });
}

export async function recordExp0001aCodexTaskSupervisorRawResult(input: Readonly<{
  repositoryRoot: string;
  supervisorId: string;
  requestDigest: string;
  rawCallToolResult: unknown;
}>, dependencies: Readonly<{ now?: () => Date }> = {}) {
  const loaded = await loadExp0001aCodexTaskSupervisorState(input);
  if (loaded.state.pendingRequest === null
      || loaded.state.pendingRequest.requestDigest !== input.requestDigest) {
    throw new Error("EXP0001A_SUPERVISOR_RESULT_NOT_FOR_CURRENT_REQUEST");
  }
  const result = await recordExp0001aCodexSupervisorBridgeResult({
    privateRoot: loaded.paths.privateRoot,
    bridgeRoot: loaded.paths.bridgeRoot,
    requestDigest: input.requestDigest,
    rawCallToolResult: input.rawCallToolResult,
    createAuthorization: loaded.state.pendingRequest.toolName === "mcp__codex_app__create_thread"
      ? loaded.state.createAuthorization : null,
    now: dependencies.now,
  });
  return Object.freeze({
    status: "result_recorded" as const,
    requestDigest: result.requestDigest,
    resultDigest: result.resultDigest,
    toolName: result.toolName,
  });
}

export async function writeExp0001aCodexSupervisorStatusProjection(input: Readonly<{
  repositoryRoot: string;
  supervisorId: string;
}>) {
  const loaded = await loadExp0001aCodexTaskSupervisorState(input);
  const statusPath = path.join(loaded.paths.runRoot, "status.json");
  const projection = exp0001aCodexSupervisorRedactedStatus(loaded.state);
  await replacePrivate(statusPath, projection);
  return Object.freeze({ statusPath, projection });
}
