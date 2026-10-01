// @vitest-environment node

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createJazzboardSemanticWebMcpTools } from "../../src/lib/webmcp/semantic-tools";
import type { JazzboardWebMcpBinding, WebMcpRequest } from "../../src/lib/webmcp/types";

const modulePath: string = "./exp0036-native-recorder.mjs";
const {
  EXP0036_NATIVE_RECORDER_SCHEMA_VERSION,
  installExp0036NativeRecorder,
  sha256Utf8,
} = await import(modulePath);

class RecordingModelContext {
  readonly tools = new Map<string, WebMCP.ModelContextTool>();
  readonly registrationCalls: Array<{
    receiver: unknown;
    tool: WebMCP.ModelContextTool;
    options: WebMCP.ModelContextRegisterToolOptions | undefined;
    argumentsLength: number;
  }> = [];

  registerTool(tool: WebMCP.ModelContextTool, options?: WebMCP.ModelContextRegisterToolOptions) {
    this.registrationCalls.push({ receiver: this, tool, options, argumentsLength: arguments.length });
    this.tools.set(tool.name, tool);
    if (options?.signal) {
      options.signal.addEventListener("abort", () => this.tools.delete(tool.name), { once: true });
    }
    return Promise.resolve();
  }
}

function binding(): JazzboardWebMcpBinding {
  return {
    roomId: "room-exp0036",
    participantId: "participant-exp0036",
    role: "participant",
    context: {
      getRoom: () => null,
      getSelection: () => [],
      getViewport: () => null,
      getFollowTarget: () => null,
      acceptRoom: () => undefined,
      setFollowTarget: () => undefined,
      setDeclinedSpotlight: () => undefined,
      leaveRoomView: () => undefined,
    },
  };
}

function captureFor(value: unknown) {
  const json = JSON.stringify(value);
  return {
    json,
    utf8Bytes: Buffer.byteLength(json, "utf8"),
    sha256: `sha256:${createHash("sha256").update(json).digest("hex")}`,
  };
}

describe("EXP-0036 native WebMCP recorder", () => {
  it("computes browser-compatible SHA-256 over exact UTF-8", () => {
    expect(EXP0036_NATIVE_RECORDER_SCHEMA_VERSION).toBe("jazzboard-exp0036-native-recorder/v1");
    for (const value of ["", "abc", '{"café":"🎷"}']) {
      expect(sha256Utf8(value)).toBe(
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
      );
    }
  });

  it("preserves registration data, receiver, options, execute receiver, and sync result identity", async () => {
    const modelContext = new RecordingModelContext();
    const originalRegisterTool = modelContext.registerTool;
    const recorder = installExp0036NativeRecorder(modelContext, {
      sessionEpoch: "epoch:test-preservation",
    });
    const registrationController = new AbortController();
    const registrationOptions = { signal: registrationController.signal, exposedTo: ["https://example.test"] };
    const executorReceiver = { expected: true };
    const input = { query: "café 🎷" };
    const result = { ok: true, nested: { answer: "résolu" } };
    const schema = { type: "object", properties: { query: { type: "string" } } };
    const executeOptions = { signal: new AbortController().signal };
    const prototype = { researchPrototype: true };
    const executorObservations: Array<{
      receiver: unknown;
      input: unknown;
      options: unknown;
      argumentsLength: number;
    }> = [];
    let observedInput: unknown;
    let observedOptions: unknown;
    const descriptor = Object.assign(Object.create(prototype), {
      name: "binding_probe",
      title: "Binding probe",
      description: "Checks passive wrapper semantics.",
      inputSchema: schema,
      annotations: { readOnlyHint: true },
      execute(this: unknown, suppliedInput: unknown, suppliedOptions: unknown) {
        executorObservations.push({
          receiver: this,
          input: suppliedInput,
          options: suppliedOptions,
          argumentsLength: arguments.length,
        });
        observedInput = suppliedInput;
        observedOptions = suppliedOptions;
        return result;
      },
    }) as WebMCP.ModelContextTool;
    Object.defineProperty(descriptor, "privateMarker", { value: 42, enumerable: false });

    await modelContext.registerTool(descriptor, registrationOptions);
    const registered = modelContext.tools.get("binding_probe") as WebMCP.ModelContextTool & {
      privateMarker: number;
      researchPrototype: boolean;
    };

    expect(modelContext.registrationCalls[0]).toMatchObject({ receiver: modelContext, argumentsLength: 2 });
    expect(modelContext.registrationCalls[0]?.options).toBe(registrationOptions);
    expect(registered).not.toBe(descriptor);
    expect(Object.getPrototypeOf(registered)).toBe(prototype);
    expect(registered.title).toBe(descriptor.title);
    expect(registered.inputSchema).toBe(schema);
    expect(registered.annotations).toBe(descriptor.annotations);
    expect(registered.privateMarker).toBe(42);
    expect(Object.getOwnPropertyDescriptor(registered, "privateMarker")?.enumerable).toBe(false);

    const returned = registered.execute.call(executorReceiver, input, executeOptions);
    expect(returned).toBe(result);
    expect(executorObservations).toEqual([{
      receiver: executorReceiver,
      input,
      options: executeOptions,
      argumentsLength: 2,
    }]);
    expect(observedInput).toBe(input);
    expect(observedOptions).toBe(executeOptions);

    const ledger = recorder.close();
    const expectedInput = captureFor(input);
    const expectedOutput = captureFor(result);
    expect(ledger).toMatchObject({
      schemaVersion: "jazzboard-exp0036-native-recorder/v1",
      sessionEpoch: "epoch:test-preservation",
      lifecycle: { state: "sealed", closeRequested: true, end: { captureComplete: true } },
      captureComplete: true,
      valid: true,
      pendingCount: 0,
      invalidationReasons: [],
      calls: [{
        sequence: 1,
        toolName: "binding_probe",
        outcome: "success",
        kind: "returned_success",
        input: { status: "complete", ...expectedInput },
        output: { status: "complete", ...expectedOutput },
        error: null,
        abortedAtBegin: false,
        abortedAtCompletion: false,
      }],
      aggregates: {
        registrations: 1,
        started: 1,
        completed: 1,
        pending: 0,
        success: 1,
        error: 0,
        inputUtf8Bytes: expectedInput.utf8Bytes,
        outputUtf8Bytes: expectedOutput.utf8Bytes,
      },
    });
    expect(ledger.calls[0].durationMs).toBeGreaterThanOrEqual(0);

    registrationController.abort();
    expect(modelContext.tools.has("binding_probe")).toBe(false);
    recorder.restore();
    expect(modelContext.registerTool).toBe(originalRegisterTool);
  });

  it("records every concurrent invocation in begin order and separates native failures from rejection", async () => {
    const modelContext = new RecordingModelContext();
    const recorder = installExp0036NativeRecorder(modelContext, { sessionEpoch: "epoch:concurrency" });
    const releases = new Map<number, (value: unknown) => void>();
    const promises = new Map<number, Promise<unknown>>();
    const rejection = new Error("third call rejected");
    for (const id of [1, 2, 3]) {
      promises.set(id, new Promise((resolve, reject) => {
        releases.set(id, id === 3 ? reject : resolve);
      }));
    }
    await modelContext.registerTool({
      name: "concurrent_probe",
      description: "Concurrent result probe.",
      execute(input) {
        return promises.get(input.id as number) as Promise<unknown>;
      },
    });
    const tool = modelContext.tools.get("concurrent_probe")!;
    const signal = new AbortController().signal;
    const invocations = [1, 2, 3].map((id) => tool.execute({ id }, { signal }));

    expect(recorder.getLedger()).toMatchObject({
      captureComplete: false,
      pendingCount: 3,
      invalidationReasons: [
        { code: "ledger_open" },
        { code: "pending_invocations", count: 3 },
      ],
      calls: [
        { sequence: 1, outcome: "pending" },
        { sequence: 2, outcome: "pending" },
        { sequence: 3, outcome: "pending" },
      ],
    });

    releases.get(2)!({ isError: true, content: [{ type: "text", text: "native error" }] });
    releases.get(1)!({ ok: false, error: { code: "NOPE" } });
    releases.get(3)!(rejection);
    await expect(invocations[0]).resolves.toEqual({ ok: false, error: { code: "NOPE" } });
    await expect(invocations[1]).resolves.toMatchObject({ isError: true });
    await expect(invocations[2]).rejects.toBe(rejection);

    const ledger = recorder.close();
    expect(ledger.calls.map((call: { sequence: number; kind: string }) => [call.sequence, call.kind])).toEqual([
      [1, "returned_structured_error"],
      [2, "returned_mcp_error"],
      [3, "rejected"],
    ]);
    expect(ledger.calls.map((call: { outcome: string }) => call.outcome)).toEqual(["error", "error", "error"]);
    expect(ledger.calls[2].output).toMatchObject({ status: "unavailable", reason: "rejected" });
    expect(JSON.parse(ledger.calls[2].error.json)).toEqual({
      type: "object",
      name: "Error",
      message: "third call rejected",
    });
    expect(ledger.aggregates).toMatchObject({
      started: 3,
      completed: 3,
      pending: 0,
      success: 0,
      error: 3,
      returnedStructuredError: 1,
      returnedMcpError: 1,
      rejected: 1,
    });
    expect(ledger.captureComplete).toBe(true);
  });

  it("observes a cross-realm-shaped thenable through settlement", async () => {
    const modelContext = new RecordingModelContext();
    const recorder = installExp0036NativeRecorder(modelContext, { sessionEpoch: "epoch:thenable" });
    const output = { ok: true, source: "foreign promise realm" };
    await modelContext.registerTool({
      name: "thenable_probe",
      description: "Cross-realm-shaped thenable probe.",
      execute() {
        return {
          then(resolve: (value: unknown) => void) {
            queueMicrotask(() => resolve(output));
          },
        };
      },
    });

    await expect(modelContext.tools.get("thenable_probe")!.execute({}, {
      signal: new AbortController().signal,
    })).resolves.toBe(output);
    expect(recorder.close().calls[0]).toMatchObject({
      outcome: "success",
      kind: "returned_success",
      output: { status: "complete", json: JSON.stringify(output) },
    });
  });

  it("preserves a synchronous throw and captures abort state without changing options", async () => {
    const modelContext = new RecordingModelContext();
    const recorder = installExp0036NativeRecorder(modelContext, { sessionEpoch: "epoch:throw" });
    const thrown = new TypeError("exact thrown object");
    const controller = new AbortController();
    controller.abort("test cancellation");
    const options = { signal: controller.signal };
    let receivedOptions: unknown;
    await modelContext.registerTool({
      name: "throw_probe",
      description: "Throws synchronously.",
      execute(_input, suppliedOptions) {
        receivedOptions = suppliedOptions;
        throw thrown;
      },
    });

    expect(() => modelContext.tools.get("throw_probe")!.execute({}, options)).toThrow(thrown);
    expect(receivedOptions).toBe(options);
    const ledger = recorder.close();
    expect(ledger.calls[0]).toMatchObject({
      outcome: "error",
      kind: "thrown",
      abortedAtBegin: true,
      abortedAtCompletion: true,
      output: { status: "unavailable", reason: "thrown" },
    });
    expect(JSON.parse(ledger.calls[0].error.json)).toEqual({
      type: "object",
      name: "TypeError",
      message: "exact thrown object",
    });
  });

  it("fails the ledger closed for serialization failures and bounded truncation without mutating results", async () => {
    const modelContext = new RecordingModelContext();
    const recorder = installExp0036NativeRecorder(modelContext, {
      sessionEpoch: "epoch:capture-failures",
      maxCaptureBytes: 24,
    });
    const result = { ok: true, value: "a long output value that exceeds the bound" };
    const before = structuredClone(result);
    await modelContext.registerTool({
      name: "capture_probe",
      description: "Exercises capture failure modes.",
      execute() {
        return result;
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const returned = modelContext.tools.get("capture_probe")!.execute(cycle, {
      signal: new AbortController().signal,
    });

    expect(returned).toBe(result);
    expect(result).toEqual(before);
    const ledger = recorder.close();
    expect(ledger.captureComplete).toBe(false);
    expect(ledger.valid).toBe(false);
    expect(ledger.invalidationReasons.map((reason: { code: string }) => reason.code)).toEqual([
      "serialization_failure",
      "capture_truncated",
    ]);
    expect(ledger.calls[0].input).toMatchObject({ status: "unavailable", reason: "serialization_failure" });
    expect(ledger.calls[0].output).toMatchObject({
      status: "truncated",
      json: null,
      utf8Bytes: captureFor(result).utf8Bytes,
      sha256: captureFor(result).sha256,
      maxCaptureBytes: 24,
    });
    expect(ledger.lifecycle).toMatchObject({ state: "invalidated", end: { captureComplete: false } });
  });

  it("bounds retained invocations and explicitly accounts for every overflowed call", async () => {
    const modelContext = new RecordingModelContext();
    const recorder = installExp0036NativeRecorder(modelContext, {
      sessionEpoch: "epoch:max-invocations",
      maxInvocations: 1,
    });
    await modelContext.registerTool({
      name: "bounded_probe",
      description: "Bounded invocation capture probe.",
      execute(input) {
        return { ok: true, input };
      },
    });
    const tool = modelContext.tools.get("bounded_probe")!;

    expect(tool.execute({ ordinal: 1 }, { signal: new AbortController().signal })).toMatchObject({ ok: true });
    expect(tool.execute({ ordinal: 2 }, { signal: new AbortController().signal })).toMatchObject({ ok: true });
    const ledger = recorder.close();
    expect(ledger).toMatchObject({
      captureComplete: false,
      calls: [{ sequence: 1 }],
      aggregates: {
        started: 2,
        completed: 2,
        droppedInvocations: 1,
        success: 2,
      },
      capturePolicy: { maxInvocations: 1 },
    });
    expect(ledger.invalidationReasons).toContainEqual(expect.objectContaining({
      code: "invocation_dropped",
      details: { sequence: 2, toolName: "bounded_probe", maxInvocations: 1 },
    }));
  });

  it("contains observer errors and drops while explicitly invalidating the ledger", async () => {
    const modelContext = new RecordingModelContext();
    const operationResult = { ok: true, answer: 42 };
    const recorder = installExp0036NativeRecorder(modelContext, {
      sessionEpoch: "epoch:observer",
      onEvent(event: { type: string }) {
        if (event.type === "invocation_begin") throw new Error("observer unavailable");
        if (event.type === "invocation_end") return false;
        if (event.type === "tool_registered") return Promise.reject(new Error("async observer unavailable"));
        return true;
      },
    });
    await modelContext.registerTool({
      name: "observer_probe",
      description: "Observer isolation probe.",
      execute: () => operationResult,
    });

    expect(modelContext.tools.get("observer_probe")!.execute({}, {
      signal: new AbortController().signal,
    })).toBe(operationResult);
    await Promise.resolve();
    const ledger = recorder.close();
    expect(ledger.invalidationReasons.map((reason: { code: string }) => reason.code)).toEqual([
      "asynchronous_observer",
      "observer_error",
      "observer_drop",
    ]);
    expect(ledger.invalidationReasons[1]).toMatchObject({ code: "observer_error", count: 2 });
    expect(ledger.calls[0]).toMatchObject({ outcome: "success", kind: "returned_success" });
  });

  it("contains recorder clock failures without changing the user operation", async () => {
    const modelContext = new RecordingModelContext();
    let wallReads = 0;
    const recorder = installExp0036NativeRecorder(modelContext, {
      sessionEpoch: "epoch:recorder-failure",
      wallNow() {
        wallReads += 1;
        if (wallReads > 1) throw new Error("clock disconnected");
        return 1_000;
      },
    });
    const operationResult = { ok: true, retained: "exactly" };
    await modelContext.registerTool({
      name: "clock_probe",
      description: "Internal recorder failure isolation probe.",
      execute: () => operationResult,
    });

    expect(modelContext.tools.get("clock_probe")!.execute({}, {
      signal: new AbortController().signal,
    })).toBe(operationResult);
    const ledger = recorder.close();
    expect(ledger.captureComplete).toBe(false);
    expect(ledger.calls[0]).toMatchObject({
      outcome: "success",
      output: { status: "complete", json: JSON.stringify(operationResult) },
    });
    expect(ledger.invalidationReasons).toContainEqual(expect.objectContaining({
      code: "recorder_failure",
    }));
  });

  it("does not seal with pending work, seals after drain, then invalidates on a late invocation", async () => {
    const modelContext = new RecordingModelContext();
    const recorder = installExp0036NativeRecorder(modelContext, { sessionEpoch: "epoch:close" });
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    let invocation = 0;
    await modelContext.registerTool({
      name: "close_probe",
      description: "Close lifecycle probe.",
      execute() {
        invocation += 1;
        return invocation === 1 ? pending : { ok: true, invocation };
      },
    });
    const tool = modelContext.tools.get("close_probe")!;
    const first = tool.execute({}, { signal: new AbortController().signal });

    const closing = recorder.close();
    expect(closing).toMatchObject({
      lifecycle: { state: "closing", closeRequested: true, end: null },
      captureComplete: false,
      pendingCount: 1,
      invalidationReasons: [{ code: "pending_invocations", count: 1 }],
    });
    release({ ok: true, invocation: 1 });
    await expect(first).resolves.toEqual({ ok: true, invocation: 1 });
    expect(recorder.getLedger()).toMatchObject({
      lifecycle: { state: "sealed", end: { captureComplete: true } },
      captureComplete: true,
      pendingCount: 0,
    });

    expect(tool.execute({}, { signal: new AbortController().signal })).toEqual({ ok: true, invocation: 2 });
    const invalidated = recorder.getLedger();
    expect(invalidated).toMatchObject({
      lifecycle: { state: "invalidated", end: { captureComplete: false } },
      captureComplete: false,
      valid: false,
      calls: [{ sequence: 1 }, { sequence: 2, outcome: "success" }],
    });
    expect(invalidated.invalidationReasons).toContainEqual(expect.objectContaining({
      code: "invocation_after_close",
    }));
  });

  it("marks reload as an explicit incomplete terminal condition", () => {
    const modelContext = new RecordingModelContext();
    const recorder = installExp0036NativeRecorder(modelContext, { sessionEpoch: "epoch:reload" });
    const ledger = recorder.markReload({ eventType: "pagehide" });

    expect(ledger).toMatchObject({
      lifecycle: { state: "invalidated", closeRequested: true, end: { captureComplete: false } },
      captureComplete: false,
      invalidationReasons: [{ code: "reload", details: { eventType: "pagehide" } }],
    });
  });

  it("records a real Jazzboard semantic executor as a structured native error without network activity", async () => {
    const request = vi.fn(async () => {
      throw new Error("invalid input must not reach transport");
    }) as unknown as WebMcpRequest;
    const realTool = createJazzboardSemanticWebMcpTools(binding(), { request })
      .find((candidate) => candidate.name === "query_objects")!;
    const modelContext = new RecordingModelContext();
    const recorder = installExp0036NativeRecorder(modelContext, { sessionEpoch: "epoch:real-tool" });
    await modelContext.registerTool(realTool);
    expect(modelContext.registrationCalls[0]?.argumentsLength).toBe(1);
    const result = await modelContext.tools.get("query_objects")!.execute(
      { pageSize: 0 },
      { signal: new AbortController().signal },
    );

    expect(request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, tool: "query_objects" });
    const ledger = recorder.close();
    expect(ledger.calls[0]).toMatchObject({
      toolName: "query_objects",
      outcome: "error",
      kind: "returned_structured_error",
      input: { status: "complete", json: JSON.stringify({ pageSize: 0 }) },
      output: { status: "complete", json: JSON.stringify(result) },
    });
    expect(ledger.aggregates).toMatchObject({ returnedStructuredError: 1, error: 1 });
    expect(ledger.captureComplete).toBe(true);
  });
});
