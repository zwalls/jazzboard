// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EXP0001A_CODEX_SUPERVISOR_ROLE_POLICY,
  authorizeExp0001aCodexSupervisorCreate,
  createExp0001aCodexTaskSupervisor,
  exp0001aCodexTaskSupervisorStateSchema,
  ingestExp0001aCodexSupervisorRawResult,
  prepareNextExp0001aCodexSupervisorRequest,
} from "./exp0001a-codex-task-supervisor";
import {
  exp0001aCodexSupervisorBridgePaths,
  exp0001aCodexSupervisorBridgeRedactedStatus,
  publishExp0001aCodexSupervisorBridgeRequest,
  readExp0001aCodexSupervisorExactBridgeRequest,
  recordExp0001aCodexSupervisorBridgeResult,
} from "./exp0001a-codex-task-supervisor-file-bridge";
import {
  advanceExp0001aCodexTaskSupervisorRun,
  initializeExp0001aCodexTaskSupervisorRun,
  loadExp0001aCodexTaskSupervisorState,
  recordExp0001aCodexTaskSupervisorRawResult,
} from "./exp0001a-codex-task-supervisor-runner";
import { canonicalJson, hashCanonicalJson, type JsonValue } from "./provenance-crypto";

const PREPARED = "2026-09-01T16:00:00.000Z";
const AUTHORIZED = "2026-09-01T16:00:01.000Z";
const CREATE_OBSERVED = "2026-09-01T16:00:02.000Z";
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function authReceipt(checkedAt = AUTHORIZED) {
  const content = {
    schemaVersion: "codex-chatgpt-auth-preflight/v1" as const,
    checkedAt,
    command: { executable: "codex" as const, arguments: ["login", "status"] as const },
    authentication: {
      method: "chatgpt" as const,
      accountIdentifier: { observability: "unobservable" as const, value: null },
      subscriptionPlan: { observability: "unobservable" as const, value: null },
    },
    observation: {
      exitCode: { observability: "observed" as const, value: 0 as const },
      signal: { observability: "unobservable" as const, value: null },
      stdoutSha256: { observability: "observed" as const, value: hashCanonicalJson({ stdout: "chatgpt" }) },
      stderrSha256: { observability: "observed" as const, value: hashCanonicalJson({ stderr: "" }) },
      rawOutputRetained: false as const,
      outputLimitExceeded: false as const,
      invocationError: false as const,
    },
    decision: { allowCodexNativeExperiment: true as const, reasonCode: "CHATGPT_AUTHENTICATED" as const },
  };
  return { ...content, receiptSha256: hashCanonicalJson(content as unknown as JsonValue) };
}

function callResult(payload: unknown, isError = false) {
  return { content: [{ type: "text", text: canonicalJson(payload as JsonValue) }], isError };
}

function prepared(role: "author" | "primary_reviewer" | "adjudicator" | "pairwise_visual_judge" = "author") {
  return createExp0001aCodexTaskSupervisor({
    supervisorId: `supervisor-${role}`,
    workItemId: `work-${role}`,
    role,
    prompt: `Private ${role} prompt`,
    preparedAt: PREPARED,
  });
}

function authorized(role: "author" | "primary_reviewer" | "adjudicator" | "pairwise_visual_judge" = "author") {
  return authorizeExp0001aCodexSupervisorCreate({
    state: prepared(role),
    authReceipt: authReceipt(),
    authorizedAt: AUTHORIZED,
  });
}

function ingest(state: ReturnType<typeof authorized>, raw: unknown, observedAt = CREATE_OBSERVED) {
  return ingestExp0001aCodexSupervisorRawResult({ state, rawCallToolResult: raw, observedAt });
}

describe("EXP-0001A Codex task supervisor", () => {
  it("freezes exact model/reasoning policy and releases only a fresh projectless create", () => {
    expect(EXP0001A_CODEX_SUPERVISOR_ROLE_POLICY).toEqual({
      author: { model: "gpt-5.6-terra", thinking: "medium" },
      primary_reviewer: { model: "gpt-5.6-sol", thinking: "high" },
      adjudicator: { model: "gpt-5.6-sol", thinking: "high" },
      pairwise_visual_judge: { model: "gpt-5.6-sol", thinking: "high" },
    });
    for (const role of ["author", "primary_reviewer", "adjudicator", "pairwise_visual_judge"] as const) {
      const state = authorized(role);
      expect(state.pendingRequest?.toolName).toBe("mcp__codex_app__create_thread");
      expect(state.pendingRequest?.arguments).toEqual({
        prompt: `Private ${role} prompt`,
        title: state.title,
        target: { type: "projectless", directoryName: state.directoryName },
        model: EXP0001A_CODEX_SUPERVISOR_ROLE_POLICY[role].model,
        thinking: EXP0001A_CODEX_SUPERVISOR_ROLE_POLICY[role].thinking,
      });
      expect(() => authorizeExp0001aCodexSupervisorCreate({
        state,
        authReceipt: authReceipt(),
        authorizedAt: AUTHORIZED,
      })).toThrow("EXP0001A_SUPERVISOR_CREATE_ALREADY_AUTHORIZED_OR_RELEASED");
    }
  });

  it("fails closed on stale or non-ChatGPT authentication", () => {
    expect(() => authorizeExp0001aCodexSupervisorCreate({
      state: prepared(),
      authReceipt: authReceipt("2026-09-01T15:50:00.000Z"),
      authorizedAt: AUTHORIZED,
    })).toThrow("EXP0001A_SUPERVISOR_AUTH_STALE_AT_CREATE_RELEASE");
    expect(() => authorizeExp0001aCodexSupervisorCreate({
      state: prepared(),
      authReceipt: {
        ...authReceipt(),
        authentication: { method: "api_key" },
      },
      authorizedAt: AUTHORIZED,
    })).toThrow();
  });

  it("reconciles identity, preserves waiting-on-approval as nonterminal, then completes by exact read", () => {
    let state = ingest(authorized(), callResult({ threadId: "thread-1", hostId: "local" }));
    state = prepareNextExp0001aCodexSupervisorRequest({ state, issuedAt: "2026-09-01T16:00:03.000Z" });
    expect(state.pendingRequest?.toolName).toBe("mcp__codex_app__list_threads");
    state = ingestExp0001aCodexSupervisorRawResult({
      state,
      observedAt: "2026-09-01T16:00:04.000Z",
      rawCallToolResult: callResult({
        pinnedThreads: [],
        threads: [{ id: "thread-1", hostId: "local", kind: "codex", title: state.title }],
      }),
    });
    state = prepareNextExp0001aCodexSupervisorRequest({ state, issuedAt: "2026-09-01T16:00:05.000Z" });
    expect(state.pendingRequest?.arguments).toEqual({
      targets: [{ threadId: "thread-1", hostId: "local" }],
      timeoutMs: 120_000,
    });
    state = ingestExp0001aCodexSupervisorRawResult({
      state,
      observedAt: "2026-09-01T16:00:06.000Z",
      rawCallToolResult: callResult({
        timedOut: true,
        wake: null,
        polls: [{
          cursor: "cursor-1",
          thread: { id: "thread-1", hostId: "local", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
          latestTurn: { status: "inProgress", actionableStatus: "waitingOnApproval" },
        }],
      }),
    });
    expect(state.phase).toBe("waiting_on_approval");
    expect(state.automaticInterventionPermitted).toBe(false);
    state = prepareNextExp0001aCodexSupervisorRequest({ state, issuedAt: "2026-09-01T16:00:07.000Z" });
    expect(state.pendingRequest?.toolName).toBe("mcp__codex_app__wait_threads");
    expect(state.pendingRequest?.arguments).toMatchObject({ targets: [{ afterCursor: "cursor-1" }] });
    state = ingestExp0001aCodexSupervisorRawResult({
      state,
      observedAt: "2026-09-01T16:00:08.000Z",
      rawCallToolResult: callResult({
        timedOut: false,
        wake: { threadId: "thread-1", hostId: "local", reason: "turnCompleted" },
        polls: [{
          cursor: "cursor-2",
          thread: { id: "thread-1", hostId: "local", status: { type: "idle", activeFlags: [] } },
          latestTurn: { status: "completed" },
        }],
      }),
    });
    state = prepareNextExp0001aCodexSupervisorRequest({ state, issuedAt: "2026-09-01T16:00:09.000Z" });
    expect(state.pendingRequest?.arguments).toMatchObject({
      threadId: "thread-1",
      hostId: "local",
      includeOutputs: true,
      maxOutputCharsPerItem: 100_000,
    });
    state = ingestExp0001aCodexSupervisorRawResult({
      state,
      observedAt: "2026-09-01T16:00:10.000Z",
      rawCallToolResult: callResult({
        thread: {
          id: "thread-1",
          hostId: "local",
          kind: "codex",
          title: state.title,
          cwd: `/private/tmp/${state.directoryName}`,
        },
        page: { order: "newest_first", hasMore: false, nextCursor: null },
        turns: [{
          status: "completed",
          error: null,
          items: [{ type: "agentMessage", phase: "final_answer", text: "finished" }],
        }],
      }),
    });
    expect(state.phase).toBe("completed");
    expect(state.terminal).toMatchObject({ outcome: "completed", failureCode: null, terminalText: "finished" });
  });

  it("retains pre-create usage limits and duplicate identities as terminal without a create replay", () => {
    const refused = ingest(authorized(), callResult({
      taskCreated: false,
      error: "subscription usage limit reached",
    }, true));
    expect(refused.phase).toBe("usage_limit_interrupted");
    expect(prepareNextExp0001aCodexSupervisorRequest({ state: refused, issuedAt: CREATE_OBSERVED })).toEqual(refused);

    let duplicated = ingest(authorized(), callResult({ threadId: "thread-1", hostId: "local" }));
    duplicated = prepareNextExp0001aCodexSupervisorRequest({
      state: duplicated,
      issuedAt: "2026-09-01T16:00:03.000Z",
    });
    duplicated = ingestExp0001aCodexSupervisorRawResult({
      state: duplicated,
      observedAt: "2026-09-01T16:00:04.000Z",
      rawCallToolResult: callResult({
        pinnedThreads: [{ id: "thread-1", hostId: "local", kind: "codex", title: duplicated.title }],
        threads: [{ id: "thread-2", hostId: "local", kind: "codex", title: duplicated.title }],
      }),
    });
    expect(duplicated.terminal?.failureCode).toBe("codex_duplicate_unique_title");
  });

  it("rejects truncated or non-projectless terminal reads", () => {
    let state = ingest(authorized(), callResult({ threadId: "thread-1", hostId: "local" }));
    state = prepareNextExp0001aCodexSupervisorRequest({ state, issuedAt: "2026-09-01T16:00:03.000Z" });
    state = ingestExp0001aCodexSupervisorRawResult({
      state,
      observedAt: "2026-09-01T16:00:04.000Z",
      rawCallToolResult: callResult({ pinnedThreads: [], threads: [] }),
    });
    state = prepareNextExp0001aCodexSupervisorRequest({ state, issuedAt: "2026-09-01T16:00:05.000Z" });
    state = ingestExp0001aCodexSupervisorRawResult({
      state,
      observedAt: "2026-09-01T16:00:06.000Z",
      rawCallToolResult: callResult({
        timedOut: false,
        wake: { threadId: "thread-1", hostId: "local", reason: "turnCompleted" },
        polls: [{
          cursor: "cursor-1",
          thread: { id: "thread-1", hostId: "local", status: { type: "idle", activeFlags: [] } },
          latestTurn: { status: "completed" },
        }],
      }),
    });
    state = prepareNextExp0001aCodexSupervisorRequest({ state, issuedAt: "2026-09-01T16:00:07.000Z" });
    state = ingestExp0001aCodexSupervisorRawResult({
      state,
      observedAt: "2026-09-01T16:00:08.000Z",
      rawCallToolResult: callResult({
        thread: {
          id: "thread-1", hostId: "local", kind: "codex", title: state.title,
          cwd: "/Volumes/Development/Projects/jazzboard",
        },
        page: { order: "newest_first", hasMore: false, nextCursor: null },
        turns: [{ status: "completed", error: null, truncated: true, items: [] }],
      }),
    });
    expect(state.terminal?.failureCode).toBe("codex_terminal_read_identity_or_trace_invalid");
  });
});

describe("EXP-0001A Codex task supervisor file bridge and runner", () => {
  it("retains exact mode-0600 requests/results, redacts arguments, and rejects conflicting replay", async () => {
    const createdRoot = await mkdtemp(path.join(tmpdir(), "exp0001a-supervisor-"));
    temporaryRoots.push(createdRoot);
    const root = await realpath(createdRoot);
    const privateRoot = path.join(root, "private");
    const bridgeRoot = path.join(privateRoot, "bridge");
    const state = authorized();
    const request = state.pendingRequest!;
    const published = await publishExp0001aCodexSupervisorBridgeRequest({ privateRoot, bridgeRoot, request });
    expect(await readExp0001aCodexSupervisorExactBridgeRequest({ privateRoot, bridgeRoot })).toEqual(request);
    expect((await lstat(published.requestPath)).mode & 0o777).toBe(0o600);
    const raw = callResult({ threadId: "thread-1", hostId: "local" });
    const result = await recordExp0001aCodexSupervisorBridgeResult({
      privateRoot,
      bridgeRoot,
      requestDigest: request.requestDigest,
      rawCallToolResult: raw,
      createAuthorization: state.createAuthorization,
      now: () => new Date(CREATE_OBSERVED),
    });
    expect((await lstat(exp0001aCodexSupervisorBridgePaths(bridgeRoot, request).resultPath)).mode & 0o777).toBe(0o600);
    expect(await recordExp0001aCodexSupervisorBridgeResult({
      privateRoot,
      bridgeRoot,
      requestDigest: request.requestDigest,
      rawCallToolResult: raw,
      createAuthorization: state.createAuthorization,
      now: () => new Date("2026-09-01T16:00:03.000Z"),
    })).toEqual(result);
    await expect(recordExp0001aCodexSupervisorBridgeResult({
      privateRoot,
      bridgeRoot,
      requestDigest: request.requestDigest,
      rawCallToolResult: callResult({ threadId: "different", hostId: "local" }),
      createAuthorization: state.createAuthorization,
      now: () => new Date("2026-09-01T16:00:03.000Z"),
    })).rejects.toThrow("EXP0001A_SUPERVISOR_BRIDGE_RESULT_REPLAY_DRIFT");
    const status = await exp0001aCodexSupervisorBridgeRedactedStatus({ privateRoot, bridgeRoot });
    expect(status).not.toHaveProperty("arguments");
    expect(canonicalJson(status as unknown as JsonValue)).not.toContain("Private author prompt");
  });

  it("replays one durable pending create without rerunning auth or issuing a second request", async () => {
    const createdRoot = await mkdtemp(path.join(tmpdir(), "exp0001a-supervisor-runner-"));
    temporaryRoots.push(createdRoot);
    const repositoryRoot = await realpath(createdRoot);
    const auth = vi.fn(async () => authReceipt());
    await initializeExp0001aCodexTaskSupervisorRun({
      repositoryRoot,
      supervisorId: "runner-one",
      workItemId: "work-one",
      role: "author",
      prompt: "Private runner prompt",
      preparedAt: PREPARED,
    });
    const first = await advanceExp0001aCodexTaskSupervisorRun(
      { repositoryRoot, supervisorId: "runner-one" },
      { runAuthPreflight: auth, now: () => new Date(PREPARED) },
    );
    expect(first.status).toBe("request_published");
    expect(auth).toHaveBeenCalledTimes(1);
    const replay = await advanceExp0001aCodexTaskSupervisorRun(
      { repositoryRoot, supervisorId: "runner-one" },
      { runAuthPreflight: auth, now: () => new Date("2026-09-01T16:00:01.500Z") },
    );
    expect(replay.status).toBe("awaiting_host_result");
    expect(replay.state.pendingRequest?.requestDigest).toBe(first.state.pendingRequest?.requestDigest);
    expect(auth).toHaveBeenCalledTimes(1);
    const request = first.state.pendingRequest!;
    await recordExp0001aCodexTaskSupervisorRawResult({
      repositoryRoot,
      supervisorId: "runner-one",
      requestDigest: request.requestDigest,
      rawCallToolResult: callResult({ threadId: "thread-1", hostId: "local" }),
    }, { now: () => new Date(CREATE_OBSERVED) });
    const ingested = await advanceExp0001aCodexTaskSupervisorRun(
      { repositoryRoot, supervisorId: "runner-one" },
      { runAuthPreflight: auth, now: () => new Date("2026-09-01T16:00:03.000Z") },
    );
    expect(ingested.status).toBe("result_ingested");
    expect(ingested.state.createdTaskId).toBe("thread-1");
    expect(auth).toHaveBeenCalledTimes(1);
    const retained = await loadExp0001aCodexTaskSupervisorState({ repositoryRoot, supervisorId: "runner-one" });
    expect(exp0001aCodexTaskSupervisorStateSchema.parse(retained.state).stateDigest).toBe(ingested.state.stateDigest);
    const requestBytes = await readFile(
      exp0001aCodexSupervisorBridgePaths(retained.paths.bridgeRoot, request).requestPath,
      "utf8",
    );
    expect(requestBytes).toContain(request.requestDigest);
  });
});
