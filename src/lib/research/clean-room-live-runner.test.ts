import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { JAZZBOARD_ROOM_SPECTATOR_WEBMCP_TOOL_NAMES } from "@/lib/webmcp/registration";

// Keep the executable plain ESM so it runs without a build step. A non-literal
// dynamic import prevents the application typecheck from treating the research
// CLI as compiled product source while Vitest still loads the real module.
const runnerModulePath: string = "../../../research/scripts/clean-room-live-runner.mjs";
const {
  buildResponsesTools,
  buildAuthorVisibleSpec,
  canonicalJson,
  classifyAuthorToolObservation,
  commitCleanRoomAttemptEvidence,
  createAuthorIdentityEvidence,
  createConcurrentEventController,
  executePreBriefSetup,
  accumulateResponseUsage,
  assertFrozenRuntimeEnvironment,
  assertFreshRoomCode,
  assertSpectatorToolIsolation,
  extractFunctionCalls,
  extractPixelCapture,
  emptyResponseUsageTotals,
  hashArtifactSet,
  notifyBriefDelivered,
  recoverCompletedResponseUsage,
  responseProviderObservation,
  responseUsageCostInputs,
  responsesRequestCompletedData,
  responsesRequestInputExposure,
  runAuthor,
  runCleanRoomAttempt,
  resolveCleanRoomAttemptOutputDirectory,
  sanitizeForResearch,
  summarizeObservedProvider,
  toolContractHash,
  validateRunnerConfig,
  verifyCommittedCleanRoomAttemptEvidence,
} = await import(runnerModulePath);

const liveTools = [
  {
    name: "read_room_state",
    title: "Read room",
    description: "Read exact state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_object",
    title: "Create object",
    description: "Create one object.",
    inputSchema: {
      type: "object",
      properties: { object: { type: "object" } },
      required: ["object"],
      additionalProperties: false,
    },
    annotations: {},
  },
];

describe("clean-room live runner pure contracts", () => {
  it("notifies the trusted coordinator exactly when a live brief is delivered", async () => {
    const callback = vi.fn();
    await expect(notifyBriefDelivered(callback, 1_788_124_641_111))
      .resolves.toBe("2026-08-30T21:17:21.111Z");
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith("2026-08-30T21:17:21.111Z");
    await expect(notifyBriefDelivered("not-a-function", 1_788_124_641_111)).rejects.toThrow(/function/);
    await expect(notifyBriefDelivered(callback, Number.NaN)).rejects.toThrow(/safe epoch/);
  });

  it("canonicalizes and hashes artifact sets independently of insertion order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(hashArtifactSet({ "b.json": "two", "a.json": "one" })).toEqual(
      hashArtifactSet({ "a.json": "one", "b.json": "two" }),
    );
  });

  it("uses an exclusive terminal bundle as the durable commit marker and verifies exact readback", async () => {
    const outputDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "clean-room-attempt-commit-")));
    try {
      const staged = new Map<string, string | Buffer>([
        ["author-events.jsonl", '{"type":"brief_delivered"}\n'],
        ["author-final.json", '{"termination":"author_completed"}\n'],
      ]);
      const bundle = { artifactIndex: hashArtifactSet(Object.fromEntries(staged)) };

      await writeFile(path.join(outputDir, "author-events.jsonl"), staged.get("author-events.jsonl")!);
      await expect(verifyCommittedCleanRoomAttemptEvidence(outputDir, staged, bundle))
        .rejects.toThrow(/missing or unexpected artifacts/i);
      await rm(path.join(outputDir, "author-events.jsonl"));

      await expect(commitCleanRoomAttemptEvidence(outputDir, staged, bundle)).resolves.toMatchObject({
        artifactIndex: bundle.artifactIndex,
        attemptBundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      await expect(verifyCommittedCleanRoomAttemptEvidence(outputDir, staged, bundle)).resolves.toBeTruthy();
      await expect(commitCleanRoomAttemptEvidence(outputDir, staged, bundle)).rejects.toThrow();

      await writeFile(path.join(outputDir, "author-final.json"), "tampered\n");
      await expect(verifyCommittedCleanRoomAttemptEvidence(outputDir, staged, bundle))
        .rejects.toThrow(/readback differs/i);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("seals the trusted registry author identity in exact canonical artifact bytes", () => {
    const firstCommitment = `sha256:${"1".repeat(64)}`;
    const secondCommitment = `sha256:${"2".repeat(64)}`;
    const first = createAuthorIdentityEvidence("attempt-001", firstCommitment);
    const second = createAuthorIdentityEvidence("attempt-001", secondCommitment);

    expect(first.path).toBe("author-identity-commitment.json");
    expect(first.record).toEqual({
      attemptId: "attempt-001",
      identityCommitment: firstCommitment,
      schemaVersion: "author-identity-commitment/v1",
    });
    expect(first.bytes.toString("utf8")).toBe(canonicalJson(first.record));
    expect(first.bytes.toString("utf8")).not.toMatch(/\n$/);
    expect(first.artifactSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.record.identityCommitment).not.toBe(second.record.identityCommitment);
    expect(() => createAuthorIdentityEvidence("../unsafe", Buffer.alloc(32))).toThrow(/safe attempt/);
    expect(() => createAuthorIdentityEvidence("attempt-001", `sha256:${"g".repeat(64)}`)).toThrow(/trusted registry/);
  });

  it("redacts room, participant, preview, session, and literal secret values without destroying object IDs", () => {
    const sanitized = sanitizeForResearch({
      room: { id: "room-secret", code: "ABC123", roomRevision: 7 },
      participantId: "participant-secret",
      sessionToken: "session-secret",
      previewId: "preview-secret",
      objectId: "object-1",
      path: "/room/room-secret?code=ABC123",
    }, { secrets: ["room-secret", "ABC123"] });
    expect(sanitized).toEqual({
      room: { id: "[REDACTED]", code: "[REDACTED]", roomRevision: 7 },
      participantId: "[REDACTED]",
      sessionToken: "[REDACTED]",
      previewId: "[REDACTED]",
      objectId: "object-1",
      path: "/room/[REDACTED]?code=[REDACTED]",
    });
  });

  it("publishes only exact allowlisted schemas in one deferred jazzboard namespace", () => {
    const tools = buildResponsesTools(liveTools, ["create_object"]);
    expect(tools[0]).toEqual({ type: "tool_search", execution: "server" });
    expect(tools[1]).toMatchObject({ type: "namespace", name: "jazzboard" });
    expect(tools[1].tools).toEqual([{
      type: "function",
      name: "create_object",
      description: "Create one object.",
      parameters: liveTools[1].inputSchema,
      strict: false,
      defer_loading: true,
      allowed_callers: ["direct"],
    }]);
    expect(toolContractHash(liveTools)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects current participant-only tools from a spectator inventory", () => {
    const spectatorRead = liveTools[0];
    expect(assertSpectatorToolIsolation([spectatorRead])).toHaveLength(1);
    for (const name of ["apply_canvas_transaction", "create_node", "update_object", "finish_canvas_draft", "enable_agent_review"]) {
      expect(() => assertSpectatorToolIsolation([{ ...spectatorRead, name }])).toThrow(/outside the frozen/);
    }
  });

  it("keeps the frozen spectator allowlist aligned with the current product registration", () => {
    const descriptors = JAZZBOARD_ROOM_SPECTATOR_WEBMCP_TOOL_NAMES.map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
      annotations: {},
    }));
    expect(assertSpectatorToolIsolation(descriptors).map((tool: { name: string }) => tool.name)).toEqual([
      ...JAZZBOARD_ROOM_SPECTATOR_WEBMCP_TOOL_NAMES,
    ]);
  });

  it("accepts only listed, explicitly jazzboard-namespaced function calls", () => {
    expect(extractFunctionCalls({ output: [{
      type: "function_call",
      namespace: "jazzboard",
      name: "read_room_state",
      call_id: "call-1",
      arguments: "{}",
    }] }, ["read_room_state"])).toEqual([
      { callId: "call-1", name: "read_room_state", input: {} },
    ]);
    expect(() => extractFunctionCalls({ output: [{
      type: "function_call",
      name: "shell",
      call_id: "call-2",
      arguments: "{}",
    }] }, ["read_room_state"])).toThrow(/unlisted or unnamespaced/);
    expect(() => extractFunctionCalls({ output: [{
      type: "function_call",
      name: "other.read_room_state",
      call_id: "call-3",
      arguments: "{}",
    }] }, ["read_room_state"])).toThrow(/unlisted or unnamespaced/);
  });

  it("requires a live, revision-bound, unexpired, in-viewport clip", () => {
    const result = {
      ok: true,
      tool: "inspect_canvas_scope",
      data: {
        presentation: "live_canvas",
        screenshotClip: { x: 10, y: 20, width: 300, height: 200 },
        expiresAt: "2030-01-01T00:00:00.000Z",
        validation: { activeSelector: "[data-preview='active']" },
        sceneContext: { revisions: { roomRevision: 12 } },
      },
    };
    expect(extractPixelCapture("inspect_canvas_scope", result, { width: 1280, height: 720 }, Date.UTC(2029, 0, 1))).toEqual({
      clip: { left: 10, top: 20, width: 300, height: 200 },
      selector: "[data-preview='active']",
      expiresAt: "2030-01-01T00:00:00.000Z",
      roomRevision: 12,
    });
    expect(() => extractPixelCapture("inspect_canvas_scope", {
      ...result,
      data: { ...result.data, screenshotClip: { x: 1200, y: 0, width: 100, height: 10 } },
    }, { width: 1280, height: 720 })).toThrow(/outside/);
    expect(() => extractPixelCapture("inspect_canvas_scope", {
      ...result,
      data: { ...result.data, expiresAt: "2020-01-01T00:00:00.000Z" },
    }, { width: 1280, height: 720 }, Date.UTC(2029, 0, 1))).toThrow(/expired/);

    const productionEpochMs = 1_788_123_768_754;
    expect(extractPixelCapture("inspect_canvas_scope", {
      ...result,
      data: { ...result.data, expiresAt: productionEpochMs },
    }, { width: 1280, height: 720 }, productionEpochMs - 1)).toMatchObject({
      expiresAt: new Date(productionEpochMs).toISOString(),
      roomRevision: 12,
    });
    for (const expiresAt of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      "not-a-timestamp",
      "2030-02-30T00:00:00.000Z",
      {},
      null,
    ]) {
      expect(() => extractPixelCapture("inspect_canvas_scope", {
        ...result,
        data: { ...result.data, expiresAt },
      }, { width: 1280, height: 720 }, Date.UTC(2029, 0, 1))).toThrow(/invalid pixel lease expiry/);
    }
    expect(() => extractPixelCapture("inspect_canvas_scope", {
      ...result,
      data: { ...result.data, expiresAt: productionEpochMs },
    }, { width: 1280, height: 720 }, productionEpochMs)).toThrow(/expired/);
  });

  it("runs frozen setup before delivery, outside author budgets, and retains its provenance", async () => {
    const order: string[] = [];
    let authorBudget = 0;
    const setup = await executePreBriefSetup({
      operations: [{ tool: "create_object", input: { object: { x: 10, y: 20 } } }],
      execute: async (tool: string) => {
        order.push(`setup:${tool}`);
        return { ok: true, roomRevision: 2 };
      },
      captureState: async () => ({ roomRevision: 2, objects: [{ id: "seed", revision: 1 }] }),
    });
    order.push("brief:delivered");
    authorBudget += 1;
    expect(order).toEqual(["setup:create_object", "brief:delivered"]);
    expect(authorBudget).toBe(1);
    expect(setup.receipts).toHaveLength(1);
    expect(setup.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(setup.initialStateHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires a frozen digest for a trusted setup callback", async () => {
    await expect(executePreBriefSetup({
      operations: [],
      execute: vi.fn(),
      callback: vi.fn(),
      captureState: async () => ({}),
    })).rejects.toThrow(/frozen SHA-256/);
  });

  it("keeps coordinator setup and concurrent operations out of author-visible inputs", () => {
    const visible = buildAuthorVisibleSpec({
      attemptId: "attempt-1",
      sessionAlias: "session-0123456789ab",
      expectedRuntime: { nodeVersion: "22.22.0", browserVersion: "151.0.7922.34" },
      authorIdentityCommitment: `sha256:${"9".repeat(64)}`,
      model: "model-snapshot",
      brief: "Edit the supplied scene.",
      allowedToolNames: ["read_room_state"],
      wallBudgetMs: 100_000,
      toolCallBudget: 20,
      perToolTimeoutMs: 10_000,
      inputTokenBudget: 50_000,
      outputTokenBudget: 10_000,
      setupOperations: [{ tool: "create_node", input: { x: 20, y: 30 } }],
      concurrentEvents: [{ id: "hidden", operations: [] }],
    });
    expect(visible).not.toHaveProperty("setupOperations");
    expect(visible).not.toHaveProperty("concurrentEvents");
    expect(visible).not.toHaveProperty("authorIdentityCommitment");
    expect(JSON.stringify(visible)).not.toContain("create_node");
  });

  it("fires concurrent events once at their exact observable ordinal and records timing/digests", async () => {
    const calls: string[] = [];
    let now = 1_300;
    const controller = createConcurrentEventController([{
      id: "human-edit",
      afterAuthorToolCall: 2,
      operations: [{ tool: "create_object", input: { object: { label: "Human note" } } }],
    }], async (tool: string) => {
      calls.push(tool);
      return { ok: true, roomRevision: 4 };
    }, () => now);
    expect(await controller.afterAuthorToolCall(1, 1_000)).toEqual([]);
    expect(await controller.afterAuthorToolCall(2, 1_000)).toEqual(["human-edit"]);
    now = 1_500;
    expect(await controller.afterAuthorToolCall(2, 1_000)).toEqual([]);
    expect(calls).toEqual(["create_object"]);
    expect(controller.receipts).toMatchObject([{
      id: "human-edit",
      trigger: { afterAuthorToolCall: 2 },
      elapsedMs: 300,
      operationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    expect(controller.unresolved()).toEqual([]);
  });

  it("fires semantic concurrent events only after the matching successful author observation", async () => {
    const controller = createConcurrentEventController([{
      id: "after-inspection",
      trigger: { observable: "first_visual_inspection", occurrence: 1 },
      operations: [{ tool: "create_text", input: { text: "Human note" } }],
    }], async () => ({ ok: true }), () => 2_000);
    const mutationTool = { name: "apply_canvas_transaction", annotations: {} };
    const inspectTool = { name: "inspect_canvas_scope", annotations: { readOnlyHint: true } };
    expect(classifyAuthorToolObservation(mutationTool, { ok: true, data: { changedObjectIds: ["a"] } })).toEqual(["first_author_mutation"]);
    expect(classifyAuthorToolObservation(inspectTool, { ok: false })).toEqual([]);
    expect(await controller.afterAuthorToolCall({
      ordinal: 1,
      name: mutationTool.name,
      observations: classifyAuthorToolObservation(mutationTool, { ok: true }),
    }, 1_000)).toEqual([]);
    expect(await controller.afterAuthorToolCall({
      ordinal: 2,
      name: inspectTool.name,
      observations: classifyAuthorToolObservation(inspectTool, { ok: true }),
    }, 1_000)).toEqual(["after-inspection"]);
    expect(controller.receipts[0]).toMatchObject({
      trigger: {
        observable: "first_visual_inspection",
        occurrence: 1,
        authorToolOrdinal: 2,
        authorToolName: "inspect_canvas_scope",
      },
      status: "completed",
    });
  });

  it("distinguishes the first staged draft from a generic successful mutation", async () => {
    const transactionTool = { name: "apply_canvas_transaction", annotations: {} };
    expect(classifyAuthorToolObservation(transactionTool, {
      ok: true,
      data: { outcome: "drafted", changedObjectIds: [] },
    })).toEqual(["first_draft_staged", "first_author_mutation"]);
    expect(classifyAuthorToolObservation(transactionTool, {
      ok: true,
      data: { outcome: "applied", changedObjectIds: ["node-1"] },
    })).toEqual(["first_author_mutation"]);
  });

  it("supports a digest-pinned trusted executor for semantic fixture operations", async () => {
    const translated: unknown[] = [];
    const controller = createConcurrentEventController([{
      id: "semantic-human-edit",
      trigger: { observable: "first_author_mutation", occurrence: 1 },
      operations: [{ type: "create_object", objectRef: "note", bounds: { x: 1, y: 2 } }],
    }], async () => ({ ok: true }), () => 1_200, {
      executorHash: "c".repeat(64),
      eventExecutor: async ({ event }: { event: unknown }) => {
        translated.push(event);
        return { translatedOperationCount: 1 };
      },
    });
    await controller.afterAuthorToolCall({
      ordinal: 1,
      name: "create_node",
      observations: ["first_author_mutation"],
    }, 1_000);
    expect(translated).toHaveLength(1);
    expect(controller.receipts[0]).toMatchObject({
      status: "completed",
      callbackReceipt: { translatedOperationCount: 1 },
      operationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("tracks cumulative provider usage and exhausts separate input/output budgets", () => {
    const first = accumulateResponseUsage(
      emptyResponseUsageTotals(),
      {
        input_tokens: 80,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 12 },
      },
      { inputTokenBudget: 150, outputTokenBudget: 50 },
    );
    expect(first).toMatchObject({
      totals: {
        inputTokens: 80,
        uncachedInputTokens: 50,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 12,
        totalTokens: 100,
      },
      turn: {
        inputTokens: 80,
        uncachedInputTokens: 50,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 12,
        totalTokens: 100,
      },
      exhausted: { input: false, output: false },
      remaining: { input: 70, output: 30 },
    });
    const second = accumulateResponseUsage(first.totals, { input_tokens: 75, output_tokens: 30 }, {
      inputTokenBudget: 150,
      outputTokenBudget: 50,
    });
    expect(second.exhausted).toEqual({ input: true, output: true });
    // reasoning_tokens is already included in provider output_tokens and is not double counted.
    expect(second.totals).toEqual({
      inputTokens: 155,
      uncachedInputTokens: 125,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      outputTokens: 50,
      reasoningOutputTokens: 12,
      totalTokens: 205,
    });
    expect(responseUsageCostInputs(second.totals)).toEqual({
      uncachedInputTokens: 125,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      outputTokens: 50,
    });
  });

  it("rejects inconsistent or non-integer provider token detail counts", () => {
    const budgets = { inputTokenBudget: 1_000, outputTokenBudget: 1_000 };
    const accumulate = (usage: unknown) => accumulateResponseUsage(emptyResponseUsageTotals(), usage, budgets);
    expect(() => accumulate({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 },
      output_tokens: 1,
    })).toThrow(/exceed input_tokens/);
    expect(() => accumulate({
      input_tokens: 1,
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 3 },
    })).toThrow(/exceeds output_tokens/);
    expect(() => accumulate({ input_tokens: 2, output_tokens: 3, total_tokens: 6 }))
      .toThrow(/does not equal/);
    for (const usage of [
      { input_tokens: 1, input_tokens_details: { cached_tokens: -1 }, output_tokens: 0 },
      { input_tokens: 1, input_tokens_details: { cache_write_tokens: 0.5 }, output_tokens: 0 },
      { input_tokens: 1, input_tokens_details: { cached_tokens: "1" }, output_tokens: 0 },
      { input_tokens: 1, input_tokens_details: [], output_tokens: 0 },
      { input_tokens: 1, output_tokens: 1, output_tokens_details: { reasoning_tokens: Number.NaN } },
    ]) {
      expect(() => accumulate(usage)).toThrow(/invalid token usage/);
    }
  });

  it("recovers detailed usage after interruption without retaining response secrets", () => {
    const first = accumulateResponseUsage(emptyResponseUsageTotals(), {
      input_tokens: 40,
      input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
      output_tokens: 15,
      output_tokens_details: { reasoning_tokens: 8 },
    }, { inputTokenBudget: 1_000, outputTokenBudget: 1_000 });
    const second = accumulateResponseUsage(first.totals, {
      input_tokens: 30,
      input_tokens_details: { cached_tokens: 12 },
      output_tokens: 10,
      output_tokens_details: { reasoning_tokens: 4 },
    }, { inputTokenBudget: 1_000, outputTokenBudget: 1_000 });
    const events = [
      { type: "responses_request_started", data: { turn: 1 } },
      {
        type: "responses_request_completed",
        data: {
          turn: 1,
          usage: first.turn,
          cumulativeUsage: first.totals,
          responseId: "resp_secret_1",
          token: "sk-secret-1",
        },
      },
      {
        type: "responses_request_completed",
        data: {
          turn: 2,
          usage: second.turn,
          cumulativeUsage: second.totals,
          responseId: "resp_secret_2",
          payload: "encrypted-secret-payload",
        },
      },
      { type: "author_attempt_interrupted", data: { message: "host failed" } },
    ];
    const recovered = recoverCompletedResponseUsage(events);
    expect(recovered.totals).toEqual(second.totals);
    expect(recovered.byTurn).toEqual([
      { turn: 1, ...first.turn },
      { turn: 2, ...second.turn },
    ]);
    expect(recovered.costInputs).toEqual({
      uncachedInputTokens: 43,
      cachedInputTokens: 22,
      cacheWriteInputTokens: 5,
      outputTokens: 25,
    });
    expect(JSON.stringify(recovered)).not.toMatch(/resp_secret|sk-secret|encrypted-secret/);
  });

  it("retains only sanitized per-turn provider model and service tier provenance", () => {
    const providerResponse = {
      id: "resp_secret_provider_identifier",
      model: "gpt-5.6-sol-2026-08-01",
      service_tier: "priority",
      status: "completed",
      api_key: "sk-secret-token",
      output: [{ type: "message", encrypted_content: "secret-response-token" }],
    };
    const turnUsage = {
      inputTokens: 20,
      uncachedInputTokens: 12,
      cachedInputTokens: 6,
      cacheWriteInputTokens: 2,
      outputTokens: 10,
      reasoningOutputTokens: 4,
      totalTokens: 30,
    };
    const completed = responsesRequestCompletedData(
      1,
      turnUsage,
      turnUsage,
      providerResponse,
      12_345,
    );
    expect(completed).toEqual({
      turn: 1,
      usage: turnUsage,
      cumulativeUsage: turnUsage,
      status: "completed",
      provider: { model: "gpt-5.6-sol-2026-08-01", serviceTier: "priority" },
      requestContextBytes: 12_345,
    });
    expect(Object.isFrozen(completed)).toBe(true);
    expect(Object.isFrozen(completed.provider)).toBe(true);
    const serialized = JSON.stringify(completed);
    expect(serialized).not.toContain(providerResponse.id);
    expect(serialized).not.toContain(providerResponse.api_key);
    expect(serialized).not.toContain("secret-response-token");
    expect(serialized).not.toContain("response_id");
  });

  it("uses exact serialized UTF-8 bytes plus a fixed margin as a conservative pre-call input bound", () => {
    const request = JSON.stringify({ input: [{ role: "user", content: "🎷".repeat(100) }], store: false });
    const exposure = responsesRequestInputExposure(request, 16_384);
    expect(exposure.requestContextBytes).toBe(Buffer.byteLength(request, "utf8"));
    expect(exposure.maximumInputTokens).toBe(exposure.requestContextBytes + 16_384);
    expect(() => responsesRequestInputExposure(request, -1)).toThrow(/margin/i);
  });

  it("rejects frozen Node or browser drift before execution can proceed", () => {
    const expected = { nodeVersion: "22.22.0", browserVersion: "151.0.7922.34" };
    expect(assertFrozenRuntimeEnvironment(expected, expected)).toEqual(expected);
    expect(() => assertFrozenRuntimeEnvironment(expected, { ...expected, nodeVersion: "22.21.0" })).toThrow("RUNTIME_NODE_VERSION_DRIFT");
    expect(() => assertFrozenRuntimeEnvironment(expected, { ...expected, browserVersion: "150.0.0.0" })).toThrow("RUNTIME_BROWSER_VERSION_DRIFT");
  });

  it("hard-blocks the removed author transport before token preflight or provider release", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const retainedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    try {
      const result = await runAuthor({
        config: {
          model: "gpt-5.6-sol",
          brief: "x".repeat(4_000),
          allowedToolNames: [],
          wallBudgetMs: 60_000,
          toolCallBudget: 1,
          perToolTimeoutMs: 1_000,
          inputTokenBudget: 10_000,
          outputTokenBudget: 1_000,
          perResponseMaxOutputTokens: 1_000,
          reasoningEffort: "high",
        },
        page: null,
        tools: [],
        events: { add: (type: string, data: Record<string, unknown>) => retainedEvents.push({ type, data }) },
        secrets: [],
        artifacts: new Map(),
        startedAt: Date.now(),
        concurrentEvents: { afterAuthorToolCall: async () => [] },
      });
      expect(result.termination).toBe("codex_native_transport_required");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(retainedEvents).toEqual([
        {
          type: "legacy_author_transport_blocked",
          data: {
            reasonCode: "CODEX_NATIVE_TRANSPORT_REQUIRED",
            providerCallMayHaveOccurred: false,
          },
        },
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not consult global fetch when the removed author transport is called directly", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const retainedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    try {
      const result = await runAuthor({
        config: {
          model: "gpt-5.6-sol",
          serviceTier: "default",
          brief: "Create a small diagram.",
          allowedToolNames: [],
          wallBudgetMs: 60_000,
          toolCallBudget: 1,
          perToolTimeoutMs: 1_000,
          inputTokenBudget: 100_000,
          outputTokenBudget: 1_000,
          perResponseMaxOutputTokens: 1_000,
          reasoningEffort: "high",
        },
        page: null,
        tools: [],
        events: { add: (type: string, data: Record<string, unknown>) => retainedEvents.push({ type, data }) },
        secrets: [],
        artifacts: new Map(),
        startedAt: Date.now(),
        concurrentEvents: { afterAuthorToolCall: async () => [] },
      });
      expect(result.termination).toBe("codex_native_transport_required");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(retainedEvents).toEqual([{
        type: "legacy_author_transport_blocked",
        data: {
          reasonCode: "CODEX_NATIVE_TRANSPORT_REQUIRED",
          providerCallMayHaveOccurred: false,
        },
      }]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("summarizes observed provider provenance across turns without substituting configured intent", () => {
    const first = responseProviderObservation({ model: "gpt-5.6-sol", service_tier: "priority", id: "resp_1" });
    const second = responseProviderObservation({ model: "gpt-5.6-sol", service_tier: "default", id: "resp_2" });
    const missing = responseProviderObservation({ model: "\ninvalid-control", service_tier: null, id: "resp_3" });
    const summary = summarizeObservedProvider([first, second, missing]);
    expect(summary).toEqual({
      provider: "openai_responses",
      completedTurns: 3,
      observedModels: ["gpt-5.6-sol"],
      observedServiceTiers: ["default", "priority"],
      allTurnsReportedModel: false,
      allTurnsReportedServiceTier: false,
    });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.observedModels)).toBe(true);
    expect(Object.isFrozen(summary.observedServiceTiers)).toBe(true);
    expect(JSON.stringify(summary)).not.toMatch(/resp_[123]/);
    expect(summarizeObservedProvider([])).toMatchObject({
      completedTurns: 0,
      observedModels: [],
      observedServiceTiers: [],
      allTurnsReportedModel: false,
      allTurnsReportedServiceTier: false,
    });
  });

  it("rejects legacy or malformed fresh-room codes", () => {
    expect(assertFreshRoomCode("ABC234")).toBe("ABC234");
    expect(() => assertFreshRoomCode("1234")).toThrow(/low-entropy/);
    expect(() => assertFreshRoomCode("ABC01O")).toThrow(/low-entropy/);
  });

  it("binds batch output to one canonical attempt directory and blocks path attacks before brief delivery", async () => {
    const allowedRunsRoot = path.join(process.cwd(), "research/results/runs");
    const runRoot = await mkdtemp(path.join(allowedRunsRoot, "runner-output-test-"));
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "runner-output-external-"));
    const attemptId = "live-path-1";
    try {
      const attemptsRoot = path.join(runRoot, "attempts");
      await mkdir(attemptsRoot, { mode: 0o700 });
      const expectedOutputDir = path.join(attemptsRoot, attemptId);
      await expect(resolveCleanRoomAttemptOutputDirectory({
        attemptId,
        allowedRunsRoot,
        expectedOutputDir,
      })).resolves.toBe(expectedOutputDir);
      await expect(resolveCleanRoomAttemptOutputDirectory({
        attemptId,
        allowedRunsRoot,
        expectedOutputDir: path.join(externalRoot, attemptId),
      })).rejects.toThrow(/beneath the fixed research runs root/i);
      await expect(resolveCleanRoomAttemptOutputDirectory({
        attemptId,
        allowedRunsRoot,
        expectedOutputDir: path.join(attemptsRoot, "wrong-attempt"),
      })).rejects.toThrow(/exact attempt ID leaf/i);

      const linkedParent = path.join(runRoot, "linked-attempts");
      await symlink(externalRoot, linkedParent, "dir");
      await expect(resolveCleanRoomAttemptOutputDirectory({
        attemptId,
        allowedRunsRoot,
        expectedOutputDir: path.join(linkedParent, attemptId),
      })).rejects.toThrow(/canonical plain directory/i);

      const onBriefDelivered = vi.fn();
      await expect(runCleanRoomAttempt({
        attemptId,
        sessionAlias: "session-0123456789ab",
        expectedRuntime: { nodeVersion: "22.22.0", browserVersion: "151.0.7922.34" },
        authorIdentityCommitment: `sha256:${"9".repeat(64)}`,
        baseUrl: "https://jazzboard.example",
        brief: "Create a diagram.",
        model: "model-snapshot",
        serviceTier: "default",
        allowedToolNames: ["read_room_state"],
        participantToolContractHash: "a".repeat(64),
        spectatorToolContractHash: "b".repeat(64),
        inputTokenBudget: 20_000,
        outputTokenBudget: 5_000,
        perResponseMaxOutputTokens: 2_000,
      }, {
        dryRun: true,
        expectedOutputDir: path.join(attemptsRoot, "wrong-attempt"),
        onBriefDelivered,
        verifyRuntimeDependencies: async () => ({
          receiptDigest: `sha256:${"a".repeat(64)}`,
          componentSetRoot: `sha256:${"b".repeat(64)}`,
          verificationScope: "critical-load-and-executable-subset",
          verificationDurationMs: 1,
        }),
      })).rejects.toThrow(/exact attempt ID leaf/i);
      expect(onBriefDelivered).not.toHaveBeenCalled();
    } finally {
      await Promise.all([
        rm(runRoot, { recursive: true, force: true }),
        rm(externalRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("checks frozen runtime dependencies before browser load and never releases a brief on drift", async () => {
    const allowedRunsRoot = path.join(process.cwd(), "research/results/runs");
    const runRoot = await mkdtemp(path.join(allowedRunsRoot, "runner-dependency-test-"));
    const attemptId = "dependency-drift-1";
    const expectedOutputDir = path.join(runRoot, attemptId);
    const onBriefDelivered = vi.fn();
    const verifyRuntimeDependencies = vi.fn(async () => {
      throw new Error("runtime dependency critical root drift");
    });
    try {
      await expect(runCleanRoomAttempt({
        attemptId,
        sessionAlias: "session-0123456789ab",
        expectedRuntime: { nodeVersion: "22.22.0", browserVersion: "151.0.7922.34" },
        authorIdentityCommitment: `sha256:${"9".repeat(64)}`,
        baseUrl: "https://jazzboard.example",
        brief: "Create a diagram.",
        model: "gpt-5.6-sol",
        serviceTier: "default",
        allowedToolNames: ["read_room_state"],
        participantToolContractHash: "a".repeat(64),
        spectatorToolContractHash: "b".repeat(64),
        inputTokenBudget: 20_000,
        outputTokenBudget: 5_000,
        perResponseMaxOutputTokens: 2_000,
      }, {
        dryRun: true,
        expectedOutputDir,
        onBriefDelivered,
        verifyRuntimeDependencies,
      })).rejects.toThrow(/runtime dependency critical root drift.*attempt evidence/i);
      expect(verifyRuntimeDependencies).toHaveBeenCalledTimes(1);
      expect(onBriefDelivered).not.toHaveBeenCalled();
      const bundle = JSON.parse(await readFile(path.join(expectedOutputDir, "attempt-bundle.json"), "utf8"));
      expect(bundle.attemptStartedAt).toBeNull();
      expect(bundle.author.toolCalls).toBe(0);
      expect(bundle.environment.browser.version).toBeNull();
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it("validates setup and concurrent plans without adding them to the author allowlist", () => {
    const config = validateRunnerConfig({
      attemptId: "contract-1",
      sessionAlias: "session-0123456789ab",
      expectedRuntime: { nodeVersion: "22.22.0", browserVersion: "151.0.7922.34" },
      baseUrl: "http://127.0.0.1:3000",
      serviceTier: "default",
      brief: "",
      allowedToolNames: ["read_room_state"],
      setupOperations: [{ tool: "create_object", input: { object: { x: 1, y: 2 } } }],
      concurrentEvents: [{
        id: "edit-1",
        afterAuthorToolCall: 3,
        operations: [{ tool: "update_object", input: { objectId: "seed" } }],
      }],
    }, true);
    expect(config.allowedToolNames).toEqual(["read_room_state"]);
    expect(config.setupOperations[0].tool).toBe("create_object");
    expect(config.concurrentEvents[0]).toMatchObject({ id: "edit-1", trigger: { afterAuthorToolCall: 3 } });
  });

  it("normalizes frozen observable event triggers from benchmark-style records", () => {
    const config = validateRunnerConfig({
      attemptId: "contract-trigger",
      sessionAlias: "session-0123456789ab",
      expectedRuntime: { nodeVersion: "22.22.0", browserVersion: "151.0.7922.34" },
      baseUrl: "http://127.0.0.1:3000",
      serviceTier: "default",
      concurrentEvents: [{
        eventFixtureId: "human-note-v1",
        observableTrigger: { kind: "after_observable", observable: "first_author_mutation", occurrence: 1 },
        operations: [{ tool: "create_text", input: { text: "Human note" } }],
      }],
    }, true);
    expect(config.concurrentEvents[0]).toMatchObject({
      id: "human-note-v1",
      trigger: { observable: "first_author_mutation", occurrence: 1 },
    });
  });

  it("accepts the staged-draft observable used by progressive-authoring fixtures", () => {
    const config = validateRunnerConfig({
      attemptId: "contract-draft-trigger",
      sessionAlias: "session-0123456789ab",
      expectedRuntime: { nodeVersion: "22.22.0", browserVersion: "151.0.7922.34" },
      baseUrl: "http://127.0.0.1:3000",
      serviceTier: "default",
      concurrentEvents: [{
        eventFixtureId: "after-first-draft",
        observableTrigger: { kind: "after_observable", observable: "first_draft_staged", occurrence: 1 },
        operations: [{ tool: "create_text", input: { text: "Human note" } }],
      }],
    }, true);
    expect(config.concurrentEvents[0]).toMatchObject({
      trigger: { observable: "first_draft_staged", occurrence: 1 },
    });
  });

  it("accepts opaque semantic event operations only with a frozen callback digest", () => {
    const config = validateRunnerConfig({
      attemptId: "semantic-trigger",
      sessionAlias: "session-0123456789ab",
      expectedRuntime: { nodeVersion: "22.22.0", browserVersion: "151.0.7922.34" },
      baseUrl: "http://127.0.0.1:3000",
      serviceTier: "default",
      concurrentEventCallbackHash: "d".repeat(64),
      concurrentEvents: [{
        eventFixtureId: "event-v1",
        observableTrigger: { kind: "after_observable", observable: "first_author_mutation", occurrence: 1 },
        operations: [{ type: "create_object", objectRef: "human-note", bounds: { x: 1, y: 2 } }],
      }],
    }, true);
    expect(config.concurrentEvents[0].operations[0]).toMatchObject({ type: "create_object", objectRef: "human-note" });
    expect(config.concurrentEventCallbackHash).toBe("d".repeat(64));
  });

  it("requires cumulative token and both live contract pins for paid runs", () => {
    const base = {
      attemptId: "live-1",
      sessionAlias: "session-0123456789ab",
      expectedRuntime: { nodeVersion: "22.22.0", browserVersion: "151.0.7922.34" },
      authorIdentityCommitment: `sha256:${"9".repeat(64)}`,
      baseUrl: "https://jazzboard.example",
      brief: "Create a diagram.",
      model: "model-snapshot",
      serviceTier: "default",
      allowedToolNames: ["read_room_state"],
      participantToolContractHash: "a".repeat(64),
      spectatorToolContractHash: "b".repeat(64),
      inputTokenBudget: 20_000,
      outputTokenBudget: 5_000,
      perResponseMaxOutputTokens: 2_000,
    };
    expect(validateRunnerConfig(base).outputTokenBudget).toBe(5_000);
    expect(validateRunnerConfig(base).authorIdentityCommitment).toBe(base.authorIdentityCommitment);
    expect(() => validateRunnerConfig({ ...base, authorIdentityCommitment: undefined })).toThrow(/identity-registry commitment/);
    expect(() => validateRunnerConfig({ ...base, inputTokenBudget: undefined })).toThrow(/inputTokenBudget/);
    expect(() => validateRunnerConfig({ ...base, spectatorToolContractHash: undefined })).toThrow(/spectator tool-contract/);
    expect(() => validateRunnerConfig({ ...base, perResponseMaxOutputTokens: 6_000 })).toThrow(/cumulative output-token/);
  });
});
