// @vitest-environment node

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createQualificationV2FileBridgeAdapter,
  authorizeQualificationV2FileBridgeCreateRequest,
  ensureQualificationV2FileBridgeRoot,
  readQualificationV2FileBridgeStatus,
  recordQualificationV2FileBridgeResult,
} from "./exp0001a-model-role-qualification-v2-file-bridge";
import { runQualificationV2TaskRunnerCli } from "./exp0001a-model-role-qualification-v2-task-runner-cli";
import { canonicalJson, hashCanonicalJson, type JsonValue } from "./provenance-crypto";

const NOW = "2026-08-31T22:00:00.000Z";
const ACTION_DIGEST = `sha256:${"a".repeat(64)}`;
const JOURNAL_DIGEST = `sha256:${"b".repeat(64)}`;

function authReceipt(checkedAt = NOW) {
  const content = {
    schemaVersion: "codex-chatgpt-auth-preflight/v1",
    checkedAt,
    command: { executable: "codex", arguments: ["login", "status"] },
    authentication: {
      method: "chatgpt",
      accountIdentifier: { observability: "unobservable", value: null },
      subscriptionPlan: { observability: "unobservable", value: null },
    },
    observation: {
      exitCode: { observability: "observed", value: 0 },
      signal: { observability: "unobservable", value: null },
      stdoutSha256: { observability: "observed", value: `sha256:${"1".repeat(64)}` },
      stderrSha256: { observability: "observed", value: `sha256:${"2".repeat(64)}` },
      rawOutputRetained: false,
      outputLimitExceeded: false,
      invocationError: false,
    },
    decision: { allowCodexNativeExperiment: true, reasonCode: "CHATGPT_AUTHENTICATED" },
  };
  return { ...content, receiptSha256: hashCanonicalJson(content as unknown as JsonValue) };
}

function deniedAuthReceipt(checkedAt = NOW) {
  const allowed = authReceipt(checkedAt);
  const content = {
    ...allowed,
    authentication: { ...allowed.authentication, method: "api_key" },
    decision: { allowCodexNativeExperiment: false, reasonCode: "API_KEY_AUTHENTICATION_FORBIDDEN" },
  };
  const { receiptSha256: _receiptSha256, ...withoutDigest } = content;
  void _receiptSha256;
  return { ...withoutDigest, receiptSha256: hashCanonicalJson(withoutDigest as unknown as JsonValue) };
}

const cliDependencies = {
  now: () => NOW,
  runAuthPreflightForTesting: async () => authReceipt(),
};

async function fixture(createBridge = true) {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "qualification-v2-bridge-repo-"));
  const privateRoot = path.join(repositoryRoot, ".research-private", "exp0001a-qualification-v2");
  const bridgeRoot = path.join(privateRoot, "bridge");
  if (createBridge) await mkdir(bridgeRoot, { recursive: true, mode: 0o700 });
  else await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await chmod(privateRoot, 0o700);
  if (createBridge) await chmod(bridgeRoot, 0o700);
  return { repositoryRoot, privateRoot, bridgeRoot };
}

async function waitForRequest(bridgeRoot: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await readQualificationV2FileBridgeStatus(bridgeRoot);
    if (status.status === "awaiting_raw_result") return status.request;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("bridge request unavailable");
}

async function writeRequest(filePath: string, value: unknown) {
  await writeFile(filePath, `${canonicalJson(value)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function streams(stdin?: AsyncIterable<Buffer | string>) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdin,
      stdout: { write: (value: string | Uint8Array) => { stdout += String(value); return true; } },
      stderr: { write: (value: string | Uint8Array) => { stderr += String(value); return true; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function oneChunk(value: Buffer | string): AsyncIterable<Buffer | string> {
  return { async *[Symbol.asyncIterator]() { yield value; } };
}

describe("EXP-0001A qualification-v2 Codex-app file bridge", () => {
  it("redacts normal status, privately exports the exact request, and binds an exact stdin result", async () => {
    const item = await fixture();
    const adapter = createQualificationV2FileBridgeAdapter({
      privateRoot: item.privateRoot,
      bridgeRoot: item.bridgeRoot,
      now: () => NOW,
      pollIntervalMs: 2,
      getCreateBinding: async () => ({ actionDigest: ACTION_DIGEST, releaseJournalDigest: JOURNAL_DIGEST }),
    });
    const pending = adapter.createThread({
      prompt: "private invite https://www.jazzboard.xyz/#join=ABC234",
      target: { type: "projectless", directoryName: "qualification-private" },
      model: "gpt-5.6-terra",
      thinking: "medium",
      title: "unique qualification title",
    });
    const request = await waitForRequest(item.bridgeRoot);

    const statusPath = path.join(item.privateRoot, "status-request.json");
    await writeRequest(statusPath, { operation: "status", bridgeRoot: item.bridgeRoot });
    const statusStreams = streams();
    expect(await runQualificationV2TaskRunnerCli(["--request", statusPath], statusStreams.io, item.repositoryRoot, cliDependencies)).toBe(0);
    expect(statusStreams.stdout()).not.toContain("ABC234");
    expect(statusStreams.stdout()).not.toContain("private invite");
    expect(JSON.parse(statusStreams.stdout())).toMatchObject({
      status: "awaiting_raw_result",
      request: { sequence: request.sequence, toolName: request.toolName, requestDigest: request.requestDigest },
    });

    const exactOutputPath = path.join(item.privateRoot, "exact-request.json");
    const exportPath = path.join(item.privateRoot, "export-request.json");
    await writeRequest(exportPath, {
      operation: "export_exact_request",
      bridgeRoot: item.bridgeRoot,
      outputPath: exactOutputPath,
    });
    const exportStreams = streams();
    expect(await runQualificationV2TaskRunnerCli(["--request", exportPath], exportStreams.io, item.repositoryRoot, cliDependencies)).toBe(0);
    expect(exportStreams.stdout()).not.toContain("ABC234");
    expect(JSON.parse(await readFile(exactOutputPath, "utf8"))).toEqual(request);

    const rawResult = { isError: false, content: [{ type: "text", text: "{\"threadId\":\"t1\",\"hostId\":\"local\"}" }] };
    const recordPath = path.join(item.privateRoot, "record-request.json");
    await writeRequest(recordPath, {
      operation: "record_raw_create_thread_result",
      bridgeRoot: item.bridgeRoot,
      sequence: request.sequence,
      rawResultSource: "stdin",
    });
    const recordStreams = streams(oneChunk(`${canonicalJson(rawResult)}\n`));
    expect(await runQualificationV2TaskRunnerCli(["--request", recordPath], recordStreams.io, item.repositoryRoot, cliDependencies)).toBe(0);
    expect(recordStreams.stdout()).not.toContain("threadId");
    await expect(pending).resolves.toEqual(rawResult);
    const retainedResultName = (await readdir(item.bridgeRoot))
      .find((name) => name.endsWith("create_thread-result.json"))!;
    expect(JSON.parse(await readFile(path.join(item.bridgeRoot, retainedResultName), "utf8"))).toMatchObject({
      createInvocationAuthorizationDigest: expect.stringMatching(/^sha256:/),
      resultAuthReceipt: { authentication: { method: "chatgpt" } },
      resultAuthReceiptDigest: authReceipt().receiptSha256,
      recordedAt: NOW,
    });
    await expect(recordQualificationV2FileBridgeResult({
      bridgeRoot: item.bridgeRoot,
      sequence: request.sequence,
      toolName: request.toolName,
      rawCallToolResult: rawResult,
      resultAuthReceipt: authReceipt(),
      now: () => NOW,
    })).rejects.toThrow();
  });

  it("rejects malformed, multiple, and oversized stdin without recording a result", async () => {
    const cases: Array<{ suffix: string; input: AsyncIterable<Buffer | string>; expected: string }> = [
      { suffix: "malformed", input: oneChunk("{"), expected: "NOT_EXACT_JSON" },
      { suffix: "multiple", input: oneChunk("{}\n{}"), expected: "NOT_EXACT_JSON" },
      { suffix: "oversize", input: oneChunk(Buffer.alloc(64 * 1024 * 1024 + 1, 0x20)), expected: "TOO_LARGE" },
    ];
    for (const testCase of cases) {
      const item = await fixture();
      const adapter = createQualificationV2FileBridgeAdapter({ privateRoot: item.privateRoot, bridgeRoot: item.bridgeRoot, now: () => NOW, maxWaitMs: 1 });
      void adapter.listThreads({ limit: 100 }).catch(() => undefined);
      const request = await waitForRequest(item.bridgeRoot);
      const requestPath = path.join(item.privateRoot, `${testCase.suffix}-request.json`);
      await writeRequest(requestPath, {
        operation: "record_raw_list_threads_result",
        bridgeRoot: item.bridgeRoot,
        sequence: request.sequence,
        rawResultSource: "stdin",
      });
      const output = streams(testCase.input);
      expect(await runQualificationV2TaskRunnerCli(["--request", requestPath], output.io, item.repositoryRoot, cliDependencies)).toBe(1);
      expect(output.stderr()).toContain("QUALIFICATION_V2_TASK_RUNNER_OPERATION_FAILED");
      expect(output.stderr()).not.toContain(testCase.expected);
      const incidents = await readdir(path.join(item.bridgeRoot, "incidents"));
      expect(incidents).toHaveLength(1);
      expect(JSON.parse(await readFile(path.join(item.bridgeRoot, "incidents", incidents[0]!), "utf8")))
        .toMatchObject({ errorMessage: expect.stringContaining(testCase.expected) });
      expect((await readQualificationV2FileBridgeStatus(item.bridgeRoot)).status).toBe("awaiting_raw_result");
    }
  });

  it("recovers a missing pointer from the one immutable unresolved slot", async () => {
    const item = await fixture();
    const adapter = createQualificationV2FileBridgeAdapter({ privateRoot: item.privateRoot, bridgeRoot: item.bridgeRoot, now: () => NOW, maxWaitMs: 1 });
    void adapter.listThreads({ limit: 100 }).catch(() => undefined);
    const request = await waitForRequest(item.bridgeRoot);
    // Simulate loss before the atomic pointer publish by retaining only the
    // immutable request slot. Status reconstructs it from that slot.
    await unlink(path.join(item.bridgeRoot, "current-request.json")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await expect(readQualificationV2FileBridgeStatus(item.bridgeRoot)).resolves.toEqual({
      status: "awaiting_raw_result",
      request,
    });
  });

  it("securely creates a fresh mode-700 bridge root before the first request", async () => {
    const item = await fixture(false);
    const resolved = await ensureQualificationV2FileBridgeRoot({
      privateRoot: item.privateRoot,
      bridgeRoot: item.bridgeRoot,
    });
    expect(resolved).toBe(await realpath(item.bridgeRoot));
    expect((await lstat(item.bridgeRoot)).mode & 0o777).toBe(0o700);
    const adapter = createQualificationV2FileBridgeAdapter({
      privateRoot: item.privateRoot,
      bridgeRoot: item.bridgeRoot,
      now: () => NOW,
      pollIntervalMs: 2,
    });
    const pending = adapter.listThreads({ limit: 100 });
    const request = await waitForRequest(item.bridgeRoot);
    const rawResult = { isError: false, content: [{ type: "text", text: "{\"threads\":[]}" }] };
    await recordQualificationV2FileBridgeResult({
      bridgeRoot: item.bridgeRoot,
      sequence: request.sequence,
      toolName: request.toolName,
      rawCallToolResult: rawResult,
      now: () => NOW,
    });
    await expect(pending).resolves.toEqual(rawResult);
  });

  it("rejects an unsafe existing bridge root, symlink, or non-private mode", async () => {
    const wrongMode = await fixture(false);
    await mkdir(wrongMode.bridgeRoot, { mode: 0o755 });
    await expect(ensureQualificationV2FileBridgeRoot({
      privateRoot: wrongMode.privateRoot,
      bridgeRoot: wrongMode.bridgeRoot,
    })).rejects.toThrow("QUALIFICATION_V2_BRIDGE_ROOT_UNSAFE");

    const linked = await fixture(false);
    const target = path.join(linked.privateRoot, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked.bridgeRoot);
    await expect(ensureQualificationV2FileBridgeRoot({
      privateRoot: linked.privateRoot,
      bridgeRoot: linked.bridgeRoot,
    })).rejects.toThrow("QUALIFICATION_V2_BRIDGE_ROOT_UNSAFE");
  });

  it("requires a create binding and rejects a stale export-bound auth preflight", async () => {
    const unbound = await fixture();
    const unboundAdapter = createQualificationV2FileBridgeAdapter({
      privateRoot: unbound.privateRoot,
      bridgeRoot: unbound.bridgeRoot,
      now: () => NOW,
      maxWaitMs: 1,
    });
    await expect(unboundAdapter.createThread({ prompt: "x" } as never))
      .rejects.toThrow("QUALIFICATION_V2_BRIDGE_CREATE_BINDING_REQUIRED");

    const item = await fixture();
    const adapter = createQualificationV2FileBridgeAdapter({
      privateRoot: item.privateRoot,
      bridgeRoot: item.bridgeRoot,
      now: () => NOW,
      maxWaitMs: 1,
      getCreateBinding: async () => ({ actionDigest: ACTION_DIGEST, releaseJournalDigest: JOURNAL_DIGEST }),
    });
    void adapter.createThread({ prompt: "private" } as never).catch(() => undefined);
    await waitForRequest(item.bridgeRoot);
    const exactOutputPath = path.join(item.privateRoot, "stale-exact-request.json");
    const requestPath = path.join(item.privateRoot, "stale-export-request.json");
    await writeRequest(requestPath, { operation: "export_exact_request", bridgeRoot: item.bridgeRoot, outputPath: exactOutputPath });
    const output = streams();
    expect(await runQualificationV2TaskRunnerCli(
      ["--request", requestPath],
      output.io,
      item.repositoryRoot,
      {
        now: () => NOW,
        runAuthPreflightForTesting: async () => authReceipt("2026-08-31T21:54:59.999Z"),
      },
    )).toBe(1);
    await expect(readFile(exactOutputPath)).rejects.toThrow();
  });

  it("rejects an auth switch before create-result ingestion", async () => {
    const item = await fixture();
    const adapter = createQualificationV2FileBridgeAdapter({
      privateRoot: item.privateRoot,
      bridgeRoot: item.bridgeRoot,
      now: () => NOW,
      maxWaitMs: 1,
      getCreateBinding: async () => ({ actionDigest: ACTION_DIGEST, releaseJournalDigest: JOURNAL_DIGEST }),
    });
    void adapter.createThread({ prompt: "private" } as never).catch(() => undefined);
    const request = await waitForRequest(item.bridgeRoot);
    await authorizeQualificationV2FileBridgeCreateRequest({
      bridgeRoot: item.bridgeRoot,
      sequence: request.sequence,
      authReceipt: authReceipt(),
      now: () => NOW,
    });
    const recordPath = path.join(item.privateRoot, "switched-record-request.json");
    await writeRequest(recordPath, {
      operation: "record_raw_create_thread_result",
      bridgeRoot: item.bridgeRoot,
      sequence: request.sequence,
      rawResultSource: "stdin",
    });
    const output = streams(oneChunk("{}"));
    expect(await runQualificationV2TaskRunnerCli(
      ["--request", recordPath],
      output.io,
      item.repositoryRoot,
      { now: () => NOW, runAuthPreflightForTesting: async () => deniedAuthReceipt() },
    )).toBe(1);
    expect((await readQualificationV2FileBridgeStatus(item.bridgeRoot)).status).toBe("awaiting_raw_result");
  });

  it("rejects a create result after the invocation authorization expires", async () => {
    const item = await fixture();
    const adapter = createQualificationV2FileBridgeAdapter({
      privateRoot: item.privateRoot,
      bridgeRoot: item.bridgeRoot,
      now: () => NOW,
      maxWaitMs: 1,
      getCreateBinding: async () => ({ actionDigest: ACTION_DIGEST, releaseJournalDigest: JOURNAL_DIGEST }),
    });
    void adapter.createThread({ prompt: "private" } as never).catch(() => undefined);
    const request = await waitForRequest(item.bridgeRoot);
    await authorizeQualificationV2FileBridgeCreateRequest({
      bridgeRoot: item.bridgeRoot,
      sequence: request.sequence,
      authReceipt: authReceipt(),
      now: () => NOW,
    });
    const late = "2026-08-31T22:05:00.001Z";
    await expect(recordQualificationV2FileBridgeResult({
      bridgeRoot: item.bridgeRoot,
      sequence: request.sequence,
      toolName: request.toolName,
      rawCallToolResult: {},
      resultAuthReceipt: authReceipt(late),
      now: () => late,
    })).rejects.toThrow("QUALIFICATION_V2_BRIDGE_CREATE_RESULT_AUTH_INVALID");
  });

  it("rejects caller-authored record timestamps and uses the internally observed time", async () => {
    const item = await fixture();
    const adapter = createQualificationV2FileBridgeAdapter({
      privateRoot: item.privateRoot,
      bridgeRoot: item.bridgeRoot,
      now: () => NOW,
      maxWaitMs: 1,
    });
    void adapter.listThreads({ limit: 100 }).catch(() => undefined);
    const request = await waitForRequest(item.bridgeRoot);
    const badPath = path.join(item.privateRoot, "caller-time-request.json");
    await writeRequest(badPath, {
      operation: "record_raw_list_threads_result",
      bridgeRoot: item.bridgeRoot,
      sequence: request.sequence,
      rawResultSource: "stdin",
      at: "2000-01-01T00:00:00.000Z",
    });
    const badOutput = streams(oneChunk("{}"));
    expect(await runQualificationV2TaskRunnerCli(
      ["--request", badPath], badOutput.io, item.repositoryRoot, cliDependencies,
    )).toBe(1);

    const goodPath = path.join(item.privateRoot, "internal-time-request.json");
    await writeRequest(goodPath, {
      operation: "record_raw_list_threads_result",
      bridgeRoot: item.bridgeRoot,
      sequence: request.sequence,
      rawResultSource: "stdin",
    });
    const goodOutput = streams(oneChunk("{}"));
    expect(await runQualificationV2TaskRunnerCli(
      ["--request", goodPath], goodOutput.io, item.repositoryRoot, cliDependencies,
    )).toBe(0);
    const resultFiles = (await readdir(item.bridgeRoot)).filter((name) => name.endsWith("-result.json"));
    const retained = JSON.parse(await readFile(path.join(item.bridgeRoot, resultFiles[0]!), "utf8"));
    expect(retained.recordedAt).toBe(NOW);
  });
});
