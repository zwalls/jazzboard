/**
 * Passive, research-only WebMCP invocation recorder for EXP-0036.
 *
 * This module performs no I/O. It only wraps tools as they pass through
 * modelContext.registerTool and keeps the resulting ledger in memory. A caller
 * may mirror ledger events through onEvent, but observer failures fail the
 * ledger closed and never change the registered tool's behavior.
 */

export const EXP0036_NATIVE_RECORDER_SCHEMA_VERSION = "jazzboard-exp0036-native-recorder/v1";

const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

/** Browser-compatible, synchronous SHA-256 over a UTF-8 string. */
export function sha256Utf8(value) {
  const input = new TextEncoder().encode(value);
  const bitLength = BigInt(input.byteLength) * 8n;
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.byteLength] = 0x80;
  for (let index = 0; index < 8; index += 1) {
    bytes[paddedLength - 1 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
  }

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);

  for (let offset = 0; offset < bytes.byteLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const cursor = offset + index * 4;
      words[index] = (
        (bytes[cursor] << 24)
        | (bytes[cursor + 1] << 16)
        | (bytes[cursor + 2] << 8)
        | bytes[cursor + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const upper1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + upper1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const upper0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (upper0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return `sha256:${hash.map((word) => word.toString(16).padStart(8, "0")).join("")}`;
}

function defaultMonotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function defaultEpoch() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `epoch:${uuid}` : `epoch:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function errorText(error) {
  try {
    return {
      name: typeof error?.name === "string" ? error.name : "Error",
      message: typeof error?.message === "string" ? error.message : String(error),
    };
  } catch {
    return { name: "Error", message: "Recorder could not inspect the error." };
  }
}

function thrownProjection(error) {
  const type = error === null ? "null" : typeof error;
  if (error instanceof Error || (error && type === "object")) {
    const projected = { type, ...errorText(error) };
    try {
      if (["string", "number"].includes(typeof error.code)) projected.code = error.code;
    } catch {
      // The projection remains exact for its documented base fields.
    }
    return projected;
  }
  if (type === "bigint" || type === "symbol") return { type, value: String(error) };
  if (type === "number" && !Number.isFinite(error)) return { type, value: String(error) };
  if (type === "undefined") return { type };
  if (type === "function") return { type, name: typeof error.name === "string" ? error.name : "" };
  return { type, value: error };
}

function cloneToolWithExecute(tool, execute) {
  const descriptors = Object.getOwnPropertyDescriptors(tool);
  const existing = descriptors.execute;
  descriptors.execute = {
    value: execute,
    enumerable: existing?.enumerable ?? true,
    configurable: existing?.configurable ?? true,
    writable: "writable" in (existing ?? {}) ? existing.writable : true,
  };
  return Object.create(Object.getPrototypeOf(tool), descriptors);
}

/**
 * Patch one ModelContext instance and return its in-memory recorder controller.
 * Installation errors are configuration errors. Once installed, recording and
 * observer failures never replace a tool return value or rejection reason.
 */
export function installExp0036NativeRecorder(modelContext, options = {}) {
  if (!modelContext || typeof modelContext.registerTool !== "function") {
    throw new TypeError("EXP-0036 recorder requires a modelContext.registerTool function.");
  }
  if (options.maxCaptureBytes !== undefined
    && (!Number.isSafeInteger(options.maxCaptureBytes) || options.maxCaptureBytes < 0)) {
    throw new TypeError("maxCaptureBytes must be a non-negative safe integer.");
  }
  if (options.maxInvocations !== undefined
    && (!Number.isSafeInteger(options.maxInvocations) || options.maxInvocations < 0)) {
    throw new TypeError("maxInvocations must be a non-negative safe integer.");
  }

  const sessionEpoch = options.sessionEpoch ?? defaultEpoch();
  if (typeof sessionEpoch !== "string" || !sessionEpoch) {
    throw new TypeError("sessionEpoch must be a non-empty string.");
  }

  const monotonicNow = options.now ?? defaultMonotonicNow;
  const wallNow = options.wallNow ?? Date.now;
  const maxCaptureBytes = options.maxCaptureBytes ?? null;
  const maxInvocations = options.maxInvocations ?? null;
  const onEvent = options.onEvent;
  const originalOwnDescriptor = Object.getOwnPropertyDescriptor(modelContext, "registerTool");
  const originalRegisterTool = modelContext.registerTool;
  const invalidations = new Map();
  const calls = [];
  const counters = {
    registrations: 0,
    started: 0,
    completed: 0,
    pending: 0,
    success: 0,
    error: 0,
    returnedSuccess: 0,
    returnedStructuredError: 0,
    returnedMcpError: 0,
    thrown: 0,
    rejected: 0,
    droppedInvocations: 0,
  };
  let phase = "open";
  let closeRequested = false;
  let end = null;
  let restored = false;
  let lifecycleTarget = null;
  let lifecycleHandler = null;

  function rawTime(clock) {
    const value = clock();
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Recorder clock returned a non-finite value.");
    return value;
  }

  function fallbackTime(clock, kind) {
    try {
      return rawTime(clock);
    } catch (error) {
      invalidate("recorder_failure", { stage: `${kind}_clock`, ...errorText(error) });
      return null;
    }
  }

  const begin = {
    epochMs: rawTime(wallNow),
    monotonicMs: rawTime(monotonicNow),
  };

  function invalidate(code, details) {
    const existing = invalidations.get(code);
    if (existing) {
      existing.count += 1;
      return;
    }
    invalidations.set(code, {
      code,
      count: 1,
      ...(details === undefined ? {} : { details }),
    });
    if (phase === "sealed") phase = "invalidated";
    if (end) end.captureComplete = false;
  }

  function emit(event) {
    if (typeof onEvent !== "function") return;
    try {
      const accepted = onEvent(event);
      if (accepted === false) invalidate("observer_drop", { eventType: event.type });
      if (accepted !== null && (typeof accepted === "object" || typeof accepted === "function")) {
        // close() is deliberately synchronous, so an asynchronous observer
        // cannot contribute evidence before sealing. Fail closed immediately,
        // then contain and classify its eventual rejection or drop as well.
        invalidate("asynchronous_observer", { eventType: event.type });
        Promise.resolve(accepted).then(
          (resolved) => {
            if (resolved === false) invalidate("observer_drop", { eventType: event.type });
          },
          (error) => invalidate("observer_error", { eventType: event.type, ...errorText(error) }),
        );
      }
    } catch (error) {
      invalidate("observer_error", { eventType: event.type, ...errorText(error) });
    }
  }

  function capture(value, stage, sequence) {
    let json;
    try {
      json = JSON.stringify(value);
      if (json === undefined) throw new TypeError("Value has no JSON representation.");
    } catch (error) {
      invalidate("serialization_failure", { stage, sequence, ...errorText(error) });
      return {
        status: "unavailable",
        json: null,
        utf8Bytes: null,
        sha256: null,
        reason: "serialization_failure",
      };
    }

    const utf8Bytes = new TextEncoder().encode(json).byteLength;
    let sha256;
    try {
      sha256 = sha256Utf8(json);
    } catch (error) {
      invalidate("recorder_failure", { stage: `${stage}_digest`, sequence, ...errorText(error) });
      return {
        status: "unavailable",
        json: null,
        utf8Bytes,
        sha256: null,
        reason: "digest_failure",
      };
    }
    if (maxCaptureBytes !== null && utf8Bytes > maxCaptureBytes) {
      invalidate("capture_truncated", { stage, sequence, utf8Bytes, maxCaptureBytes });
      return {
        status: "truncated",
        json: null,
        utf8Bytes,
        sha256,
        maxCaptureBytes,
      };
    }
    return { status: "complete", json, utf8Bytes, sha256 };
  }

  function timePoint() {
    return {
      epochMs: fallbackTime(wallNow, "wall"),
      monotonicMs: fallbackTime(monotonicNow, "monotonic"),
    };
  }

  function executionSignal(executeOptions, sequence) {
    try {
      return executeOptions?.signal ?? null;
    } catch (error) {
      invalidate("recorder_failure", { stage: "execute_signal", sequence, ...errorText(error) });
      return null;
    }
  }

  function abortedState(signal, stage, sequence) {
    if (!signal) return false;
    try {
      return Boolean(signal.aborted);
    } catch (error) {
      invalidate("recorder_failure", { stage, sequence, ...errorText(error) });
      return null;
    }
  }

  function classifyReturned(result) {
    let structuredOkFalse = false;
    let mcpIsError = false;
    try {
      structuredOkFalse = Boolean(result && typeof result === "object" && result.ok === false);
      mcpIsError = Boolean(result && typeof result === "object" && result.isError === true);
    } catch (error) {
      invalidate("recorder_failure", { stage: "result_classification", ...errorText(error) });
    }
    if (mcpIsError) return { outcome: "error", kind: "returned_mcp_error", structuredOkFalse, mcpIsError };
    if (structuredOkFalse) return { outcome: "error", kind: "returned_structured_error", structuredOkFalse, mcpIsError };
    return { outcome: "success", kind: "returned_success", structuredOkFalse, mcpIsError };
  }

  function maybeSeal() {
    if (!closeRequested || counters.pending !== 0 || end) return;
    const completed = timePoint();
    end = {
      ...completed,
      captureComplete: invalidations.size === 0,
    };
    phase = invalidations.size === 0 ? "sealed" : "invalidated";
    emit({
      type: "ledger_end",
      sessionEpoch,
      captureComplete: invalidations.size === 0,
      counts: { ...counters },
    });
    if (invalidations.size > 0) {
      phase = "invalidated";
      end.captureComplete = false;
    }
  }

  function complete(call, resolution, value, asynchronous) {
    try {
      const completed = timePoint();
      const durationMs = call.begun.monotonicMs === null || completed.monotonicMs === null
        ? null
        : Math.max(0, completed.monotonicMs - call.begun.monotonicMs);
      const abortedAtCompletion = abortedState(call.signal, "abort_at_completion", call.sequence);
      if (resolution === "returned") {
        const classification = classifyReturned(value);
        call.outcome = classification.outcome;
        call.kind = classification.kind;
        call.output = call.retained
          ? capture(value, "output", call.sequence)
          : { status: "unavailable", json: null, utf8Bytes: null, sha256: null, reason: "invocation_dropped" };
        call.error = null;
        call.classification = {
          structuredOkFalse: classification.structuredOkFalse,
          mcpIsError: classification.mcpIsError,
        };
        counters[classification.outcome] += 1;
        if (classification.kind === "returned_success") counters.returnedSuccess += 1;
        if (classification.kind === "returned_structured_error") counters.returnedStructuredError += 1;
        if (classification.kind === "returned_mcp_error") counters.returnedMcpError += 1;
      } else {
        call.outcome = "error";
        call.kind = asynchronous ? "rejected" : "thrown";
        call.output = {
          status: "unavailable",
          json: null,
          utf8Bytes: null,
          sha256: null,
          reason: call.kind,
        };
        call.error = call.retained
          ? capture(thrownProjection(value), "error", call.sequence)
          : { status: "unavailable", json: null, utf8Bytes: null, sha256: null, reason: "invocation_dropped" };
        call.classification = { structuredOkFalse: false, mcpIsError: false };
        counters.error += 1;
        counters[call.kind] += 1;
      }
      call.completed = completed;
      call.durationMs = durationMs;
      call.abortedAtCompletion = abortedAtCompletion;
    } catch (error) {
      invalidate("recorder_failure", { stage: "invocation_completion", sequence: call.sequence, ...errorText(error) });
      call.outcome = resolution === "returned" ? "success" : "error";
      call.kind = resolution === "returned" ? "returned_success" : asynchronous ? "rejected" : "thrown";
      call.output = { status: "unavailable", json: null, utf8Bytes: null, sha256: null, reason: "recorder_failure" };
      call.error = null;
      call.completed = timePoint();
      call.durationMs = null;
      call.abortedAtCompletion = abortedState(call.signal, "abort_at_completion_fallback", call.sequence);
      counters[call.outcome] += 1;
      if (call.kind === "returned_success") counters.returnedSuccess += 1;
      if (call.kind === "thrown") counters.thrown += 1;
      if (call.kind === "rejected") counters.rejected += 1;
    } finally {
      delete call.signal;
      counters.completed += 1;
      counters.pending -= 1;
      emit({
        type: "invocation_end",
        sessionEpoch,
        sequence: call.sequence,
        toolName: call.toolName,
        outcome: call.outcome,
        kind: call.kind,
      });
      maybeSeal();
    }
  }

  function invoke(originalExecute, toolName, receiver, executeArguments) {
    const input = executeArguments[0];
    const executeOptions = executeArguments[1];
    if (closeRequested || phase === "sealed" || phase === "invalidated") {
      invalidate("invocation_after_close", { toolName });
    }
    const sequence = ++counters.started;
    counters.pending += 1;
    const retained = maxInvocations === null || calls.length < maxInvocations;
    if (!retained) {
      counters.droppedInvocations += 1;
      invalidate("invocation_dropped", { sequence, toolName, maxInvocations });
    }
    const signal = executionSignal(executeOptions, sequence);
    const call = {
      sequence,
      sessionEpoch,
      toolName,
      begun: timePoint(),
      completed: null,
      durationMs: null,
      input: retained
        ? capture(input, "input", sequence)
        : { status: "unavailable", json: null, utf8Bytes: null, sha256: null, reason: "invocation_dropped" },
      output: null,
      error: null,
      outcome: "pending",
      kind: "pending",
      abortedAtBegin: abortedState(signal, "abort_at_begin", sequence),
      abortedAtCompletion: null,
      retained,
      signal,
    };
    if (retained) calls.push(call);
    emit({ type: "invocation_begin", sessionEpoch, sequence, toolName });

    let result;
    try {
      result = Reflect.apply(originalExecute, receiver, executeArguments);
    } catch (error) {
      complete(call, "threw", error, false);
      throw error;
    }

    let isThenable;
    try {
      isThenable = result !== null
        && (typeof result === "object" || typeof result === "function")
        && typeof result.then === "function";
    } catch (error) {
      complete(call, "threw", error, false);
      throw error;
    }
    if (!isThenable) {
      complete(call, "returned", result, false);
      return result;
    }
    return Promise.resolve(result).then(
      (value) => {
        complete(call, "returned", value, true);
        return value;
      },
      (error) => {
        complete(call, "threw", error, true);
        throw error;
      },
    );
  }

  function wrappedRegisterTool(...registerArguments) {
    const tool = registerArguments[0];
    let registeredTool = tool;
    try {
      if (!tool || typeof tool.execute !== "function") {
        invalidate("recorder_failure", { stage: "tool_wrapping", message: "Tool has no callable execute property." });
      } else {
        const originalExecute = tool.execute;
        registeredTool = cloneToolWithExecute(tool, function exp0036RecordedExecute(...executeArguments) {
          return invoke(originalExecute, tool.name, this, executeArguments);
        });
        counters.registrations += 1;
        emit({ type: "tool_registered", sessionEpoch, toolName: tool.name });
      }
    } catch (error) {
      invalidate("recorder_failure", { stage: "tool_wrapping", ...errorText(error) });
      registeredTool = tool;
    }
    registerArguments[0] = registeredTool;
    return Reflect.apply(originalRegisterTool, this, registerArguments);
  }

  Object.defineProperty(modelContext, "registerTool", {
    value: wrappedRegisterTool,
    configurable: true,
    writable: true,
    enumerable: originalOwnDescriptor?.enumerable ?? false,
  });

  function restoreRegisterTool() {
    if (restored) return;
    restored = true;
    try {
      if (modelContext.registerTool === wrappedRegisterTool) {
        if (originalOwnDescriptor) Object.defineProperty(modelContext, "registerTool", originalOwnDescriptor);
        else delete modelContext.registerTool;
      } else {
        invalidate("recorder_failure", { stage: "restore", message: "registerTool was replaced after recorder installation." });
      }
    } catch (error) {
      invalidate("recorder_failure", { stage: "restore", ...errorText(error) });
    }
  }

  function close() {
    if (!closeRequested) {
      closeRequested = true;
      if (phase === "open") phase = "closing";
      emit({ type: "close_requested", sessionEpoch, pending: counters.pending });
    }
    maybeSeal();
    return getLedger();
  }

  function markReload(details = {}) {
    invalidate("reload", details);
    return close();
  }

  function restore() {
    restoreRegisterTool();
    if (lifecycleTarget && lifecycleHandler) {
      try {
        lifecycleTarget.removeEventListener("pagehide", lifecycleHandler);
        lifecycleTarget.removeEventListener("beforeunload", lifecycleHandler);
      } catch (error) {
        invalidate("recorder_failure", { stage: "lifecycle_detach", ...errorText(error) });
      }
      lifecycleTarget = null;
      lifecycleHandler = null;
    }
    return close();
  }

  function aggregate() {
    let inputUtf8Bytes = 0;
    let outputUtf8Bytes = 0;
    let errorUtf8Bytes = 0;
    let completeInputCount = 0;
    let completeOutputCount = 0;
    for (const call of calls) {
      if (typeof call.input?.utf8Bytes === "number") inputUtf8Bytes += call.input.utf8Bytes;
      if (typeof call.output?.utf8Bytes === "number") outputUtf8Bytes += call.output.utf8Bytes;
      if (typeof call.error?.utf8Bytes === "number") errorUtf8Bytes += call.error.utf8Bytes;
      if (call.input?.status === "complete") completeInputCount += 1;
      if (call.output?.status === "complete") completeOutputCount += 1;
    }
    return {
      ...counters,
      inputUtf8Bytes,
      outputUtf8Bytes,
      errorUtf8Bytes,
      completeInputCount,
      completeOutputCount,
    };
  }

  function publicCall(call) {
    const result = { ...call };
    delete result.signal;
    return {
      ...result,
      begun: { ...result.begun },
      completed: result.completed ? { ...result.completed } : null,
      input: result.input ? { ...result.input } : null,
      output: result.output ? { ...result.output } : null,
      error: result.error ? { ...result.error } : null,
      ...(result.classification ? { classification: { ...result.classification } } : {}),
    };
  }

  function getLedger() {
    const dynamicReasons = [];
    if (!closeRequested) dynamicReasons.push({ code: "ledger_open", count: 1 });
    if (counters.pending > 0) dynamicReasons.push({ code: "pending_invocations", count: counters.pending });
    const invalidationReasons = [...invalidations.values()].map((reason) => ({
      ...reason,
      ...(reason.details && typeof reason.details === "object" ? { details: { ...reason.details } } : {}),
    }));
    const reasons = [...invalidationReasons, ...dynamicReasons];
    const captureComplete = Boolean(end && counters.pending === 0 && reasons.length === 0 && phase === "sealed");
    return {
      schemaVersion: EXP0036_NATIVE_RECORDER_SCHEMA_VERSION,
      sessionEpoch,
      lifecycle: {
        state: phase,
        closeRequested,
        restored,
        begin: { ...begin },
        end: end ? { ...end } : null,
      },
      captureComplete,
      valid: captureComplete,
      invalidationReasons: reasons,
      pendingCount: counters.pending,
      calls: calls.map(publicCall),
      aggregates: aggregate(),
      capturePolicy: {
        maxCaptureBytes,
        maxInvocations,
        truncationInvalidates: true,
      },
    };
  }

  const candidateLifecycleTarget = options.lifecycleTarget
    ?? (typeof globalThis.addEventListener === "function" ? globalThis : null);
  if (candidateLifecycleTarget && typeof candidateLifecycleTarget.addEventListener === "function") {
    lifecycleTarget = candidateLifecycleTarget;
    lifecycleHandler = (event) => markReload({ eventType: event?.type ?? "lifecycle" });
    try {
      lifecycleTarget.addEventListener("pagehide", lifecycleHandler);
      lifecycleTarget.addEventListener("beforeunload", lifecycleHandler);
    } catch (error) {
      invalidate("recorder_failure", { stage: "lifecycle_attach", ...errorText(error) });
    }
  }

  emit({ type: "ledger_begin", sessionEpoch, begin: { ...begin } });

  return {
    sessionEpoch,
    getLedger,
    close,
    markReload,
    invalidate(code, details) {
      if (typeof code !== "string" || !code) throw new TypeError("Invalidation code must be a non-empty string.");
      invalidate(code, details);
      return getLedger();
    },
    restore,
  };
}
