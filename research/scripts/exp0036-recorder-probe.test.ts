// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

const modulePath: string = "./exp0036-recorder-probe.mjs";
const {
  EXP0036_PROBE_EVENT_SCHEMA_VERSION,
  buildExp0036RecorderInjection,
  prepareExp0036RecorderProbe,
  startExp0036ProbeCollector,
} = await import(modulePath);

const APP_ORIGIN = "http://exp0036-test-91bd1f.localhost:3103";
const ATTEMPT_SECRET = "test_secret_abcdefghijklmnopqrstuvwxyz_123456789";
const CONTROL_SECRET = "control_secret_abcdefghijklmnopqrstuvwxyz_123456";
const SESSION_EPOCH = "epoch:test-probe";
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const CONFIG_DIGEST = `sha256:${"b".repeat(64)}`;
const collectors: Array<{ close(): Promise<void> }> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(collectors.splice(0).map((collector) => collector.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function collector(options: Record<string, unknown> = {}) {
  const value = await startExp0036ProbeCollector({
    attemptId: "attempt-test",
    appOrigin: APP_ORIGIN,
    attemptSecret: ATTEMPT_SECRET,
    sessionEpoch: SESSION_EPOCH,
    observerSourceSha256: SOURCE_DIGEST,
    observerConfigSha256: CONFIG_DIGEST,
    ...options,
  });
  collectors.push(value);
  return value;
}

function ledger(state: "open" | "sealed" = "sealed", padding = "") {
  return {
    schemaVersion: "jazzboard-exp0036-native-recorder/v1",
    sessionEpoch: SESSION_EPOCH,
    lifecycle: {
      state,
      closeRequested: state === "sealed",
      restored: false,
      begin: { epochMs: 1, monotonicMs: 1 },
      end: state === "sealed" ? { epochMs: 2, monotonicMs: 2, captureComplete: true } : null,
    },
    captureComplete: state === "sealed",
    valid: state === "sealed",
    pendingCount: 0,
    invalidationReasons: state === "sealed" ? [] : [{ code: "ledger_open", count: 1 }],
    calls: [],
    aggregates: { started: 0, completed: 0, pending: 0 },
    padding,
  };
}

function eventBody(sequence: number, eventType: string, value = ledger()) {
  return {
    schemaVersion: EXP0036_PROBE_EVENT_SCHEMA_VERSION,
    attemptId: "attempt-test",
    sessionEpoch: SESSION_EPOCH,
    observerConfigSha256: CONFIG_DIGEST,
    streamSequence: sequence,
    event: { type: eventType },
    ledger: value,
  };
}

async function postEvent(
  value: Awaited<ReturnType<typeof collector>>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(value.eventUrl, {
    method: "POST",
    headers: {
      origin: APP_ORIGIN,
      "content-type": "application/json",
      "x-exp0036-attempt-secret": ATTEMPT_SECRET,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function issueClose(value: Awaited<ReturnType<typeof collector>>) {
  return fetch(value.closeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-exp0036-attempt-secret": ATTEMPT_SECRET,
    },
    body: JSON.stringify({ taskTerminal: true, terminalReference: "task-terminal:test" }),
  });
}

describe("EXP-0036 recorder probe", () => {
  it("rejects the wrong browser origin or attempt token", async () => {
    const value = await collector({ controlSecret: CONTROL_SECRET });

    const wrongOrigin = await postEvent(value, eventBody(1, "ledger_begin"), {
      origin: "http://wrong.localhost:3103",
    });
    expect(wrongOrigin.status).toBe(403);
    await expect(wrongOrigin.json()).resolves.toMatchObject({ code: "ORIGIN_MISMATCH" });

    const wrongToken = await postEvent(value, eventBody(1, "ledger_begin"), {
      "x-exp0036-attempt-secret": "wrong_secret_abcdefghijklmnopqrstuvwxyz_123456",
    });
    expect(wrongToken.status).toBe(401);
    await expect(wrongToken.json()).resolves.toMatchObject({ code: "TOKEN_MISMATCH" });

    const ingestCannotReadStatus = await fetch(value.statusUrl, {
      headers: { "x-exp0036-attempt-secret": ATTEMPT_SECRET },
    });
    expect(ingestCannotReadStatus.status).toBe(401);
    expect((await fetch(value.statusUrl, {
      headers: { "x-exp0036-attempt-secret": CONTROL_SECRET },
    })).status).toBe(200);

    const receipt = value.receipt();
    expect(receipt.transport).toMatchObject({
      acceptedEventCount: 0,
      rejectedEventCount: 0,
      rejectedAuxiliaryRequestCount: 0,
      externalRejectedRequestCount: 3,
      rejectionDiagnosticCount: 3,
      rejectionDiagnosticsCapped: false,
      zeroDrops: true,
    });
    expect(receipt.transport.rejectionDiagnostics).toEqual([
      expect.objectContaining({
        ordinal: 1,
        classification: "external_untrusted",
        code: "ORIGIN_MISMATCH",
        method: "POST",
        tokenPresent: true,
        originMatches: false,
        ingestTokenMatches: true,
      }),
      expect.objectContaining({
        ordinal: 2,
        classification: "external_untrusted",
        code: "TOKEN_MISMATCH",
        method: "POST",
        tokenPresent: true,
        originMatches: true,
        ingestTokenMatches: false,
      }),
      expect.objectContaining({
        ordinal: 3,
        classification: "external_untrusted",
        code: "TOKEN_MISMATCH",
        method: "GET",
        tokenPresent: true,
        controlTokenMatches: false,
      }),
    ]);
    expect(JSON.stringify(receipt)).not.toContain("wrong_secret_abcdefghijklmnopqrstuvwxyz_123456");
    expect(JSON.stringify(receipt)).not.toContain(ATTEMPT_SECRET);
    expect(JSON.stringify(receipt)).not.toContain(CONTROL_SECRET);
    expect(receipt.access.separateIngestAndControlSecrets).toBe(true);
    expect(receipt.seal.complete).toBe(false);
  });

  it("fails closed for a missing sequence and for a capped event stream", async () => {
    const missing = await collector();
    const gapResponse = await postEvent(missing, eventBody(2, "ledger_end"));
    expect(gapResponse.status).toBe(409);
    expect(missing.receipt()).toMatchObject({
      transport: {
        acceptedEventCount: 0,
        rejectedEventCount: 1,
        gapCount: 1,
        gaps: [{ expected: 1, observed: 2 }],
        zeroDrops: false,
      },
      seal: { complete: false },
    });

    const capped = await collector({ attemptId: "attempt-capped", maxEvents: 1 });
    const firstBody = { ...eventBody(1, "ledger_begin", ledger("open")), attemptId: "attempt-capped" };
    const secondBody = { ...eventBody(2, "ledger_end"), attemptId: "attempt-capped" };
    expect((await postEvent(capped, firstBody)).status).toBe(200);
    expect((await postEvent(capped, secondBody)).status).toBe(507);
    expect(capped.receipt()).toMatchObject({
      transport: {
        acceptedEventCount: 1,
        rejectedEventCount: 1,
        capped: true,
        zeroDrops: false,
      },
      seal: { complete: false },
      retrieval: { complete: false, truncated: true },
    });
  });

  it("seals only after controller terminal close and emits complete ordered hashed chunks", async () => {
    const value = await collector();
    const terminalLedger = ledger("sealed", "🎷".repeat(20_000));
    const commandPromise = fetch(value.commandUrl, {
      headers: {
        origin: APP_ORIGIN,
        "x-exp0036-attempt-secret": ATTEMPT_SECRET,
      },
    }).then((response) => response.json());

    expect((await issueClose(value)).status).toBe(202);
    await expect(commandPromise).resolves.toMatchObject({
      ok: true,
      command: "close",
      close: { taskTerminal: true, terminalReference: "task-terminal:test" },
    });
    const response = await postEvent(value, eventBody(1, "ledger_end", terminalLedger));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      acknowledgedSequence: 1,
      nextExpectedSequence: 2,
      sealAccepted: true,
    });

    const receipt = value.receipt();
    expect(receipt).toMatchObject({
      binding: {
        sessionEpoch: SESSION_EPOCH,
        appOrigin: APP_ORIGIN,
        observerSourceSha256: SOURCE_DIGEST,
        observerConfigSha256: CONFIG_DIGEST,
      },
      access: {
        controllerOnly: true,
        authorQueryable: false,
        authorQueryableScope: "permitted_native_webmcp_surface",
        pageJavaScriptIsolationClaimed: false,
        injectionWorld: "main",
        authorFacingEndpointCount: 0,
        publicWebMcpToolCountAdded: 0,
      },
      transport: {
        acceptedEventCount: 1,
        firstSequence: 1,
        lastSequence: 1,
        nextExpectedSequence: 2,
        duplicateEventCount: 0,
        rejectedEventCount: 0,
        rejectedAuxiliaryRequestCount: 0,
        gapCount: 0,
        capped: false,
        zeroDrops: true,
        events: [{
          sequence: 1,
          eventType: "ledger_end",
          envelopeSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          ledgerJsonSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }],
      },
      close: {
        taskTerminal: true,
        terminalReference: "task-terminal:test",
        issuedBy: "controller",
      },
      seal: { eventSequence: 1, ledgerSealed: true, complete: true },
      retrieval: {
        method: "authenticated_loopback_collector",
        complete: true,
        truncated: false,
        originHostname: "exp0036-test-91bd1f.localhost",
        maxChunkUtf8Bytes: 32_768,
        chunkCount: 3,
        completeChunkCount: 3,
      },
    });
    expect(receipt.retrieval.chunks.every((chunk: { utf8Bytes: number }) => (
      chunk.utf8Bytes <= 32_768
    ))).toBe(true);
    expect(receipt.retrieval.chunks.map((chunk: { jsonFragment: string }) => (
      chunk.jsonFragment
    )).join("")).toBe(JSON.stringify(terminalLedger));
    expect(receipt.receiptSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("builds a no-external IIFE and prepends it only inside a new git archive copy", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "exp0036-recorder-probe-test-"));
    temporaryDirectories.push(base);
    const outputDirectory = path.join(base, "archive");
    const built = await buildExp0036RecorderInjection({
      attemptId: "attempt-prepare",
      sessionEpoch: "epoch:prepare",
      eventUrl: "http://127.0.0.1:32123/v1/attempts/attempt-prepare/events",
      commandUrl: "http://127.0.0.1:32123/v1/attempts/attempt-prepare/commands",
      attemptSecret: ATTEMPT_SECRET,
    });
    expect(built.source).toContain("installExp0036NativeRecorder");
    expect(built.source).toMatch(/typeof window[^;]+typeof document/);
    expect(built.source).not.toMatch(/^\s*import\s/m);
    expect(built.source).toMatch(/export \{\s+exp0036InstrumentModelContext\s+\};/);

    const prepared = await prepareExp0036RecorderProbe({
      ref: "HEAD",
      outputDirectory,
      attemptId: "attempt-prepare",
      appOrigin: "http://exp0036-prepare.localhost:3103",
      attemptSecret: ATTEMPT_SECRET,
      sessionEpoch: "epoch:prepare",
      eventUrl: "http://127.0.0.1:32123/v1/attempts/attempt-prepare/events",
      commandUrl: "http://127.0.0.1:32123/v1/attempts/attempt-prepare/commands",
      copyDependencies: false,
    });
    const instrumentation = await readFile(
      path.join(outputDirectory, prepared.instrumentationRelativePath),
      "utf8",
    );
    const observer = await readFile(path.join(outputDirectory, prepared.observerRelativePath), "utf8");
    expect(instrumentation.startsWith('import "./exp0036-recorder-observer";\n')).toBe(true);
    expect(observer).toBe(built.source);
    for (const relativePath of prepared.registrationAdapterRelativePaths) {
      const source = await readFile(path.join(outputDirectory, relativePath), "utf8");
      expect(source).toContain("exp0036InstrumentModelContext(this.getModelContext())");
    }
    expect(prepared.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(prepared.copyDependencies).toBe(false);
  });

  it("runs the built observer end to end without exposing a controller global or changing tool results", async () => {
    const value = await startExp0036ProbeCollector({
      attemptId: "attempt-browser-sim",
      appOrigin: APP_ORIGIN,
      attemptSecret: ATTEMPT_SECRET,
      sessionEpoch: SESSION_EPOCH,
    });
    collectors.push(value);
    const built = await buildExp0036RecorderInjection({
      attemptId: "attempt-browser-sim",
      sessionEpoch: SESSION_EPOCH,
      eventUrl: value.eventUrl,
      commandUrl: value.commandUrl,
      attemptSecret: ATTEMPT_SECRET,
    });
    value.bindProbe({
      sessionEpoch: SESSION_EPOCH,
      observerSourceSha256: built.observerSourceSha256,
      observerConfigSha256: built.observerConfigSha256,
    });
    const tools = new Map<string, { name: string; execute: (...args: unknown[]) => unknown }>();
    const modelContext = {
      registerTool(tool: { name: string; execute: (...args: unknown[]) => unknown }) {
        tools.set(tool.name, tool);
        return Promise.resolve();
      },
    };
    const context = {
      window: {},
      document: { modelContext },
      fetch(input: string | URL | Request, init: RequestInit = {}) {
        return fetch(input, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init.headers)), origin: APP_ORIGIN },
        });
      },
      queueMicrotask,
      TextEncoder,
      performance,
      AbortController,
      Promise,
      URL,
      JSON,
      Object,
      Array,
      Map,
      Set,
      Date,
      Math,
      Number,
      String,
      Boolean,
      BigInt,
      Error,
      TypeError,
      Reflect,
    };
    const initialKeys = Object.keys(context).sort();
    const executableSource = built.source.replace(
      /export \{\s+exp0036InstrumentModelContext\s+\};\s*$/,
      "globalThis.__exp0036TestAdapter = exp0036InstrumentModelContext;",
    );
    runInNewContext(executableSource, context);
    const result = { ok: true, data: "unchanged 🎷" };
    const adapter = (context as typeof context & {
      __exp0036TestAdapter: (value: typeof modelContext) => typeof modelContext;
    }).__exp0036TestAdapter(modelContext);
    await adapter.registerTool({ name: "query_objects", execute: () => result });
    expect(tools.get("query_objects")!.execute({ detail: "summary" })).toBe(result);

    expect((await fetch(value.closeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-exp0036-attempt-secret": ATTEMPT_SECRET },
      body: JSON.stringify({ taskTerminal: true, terminalReference: "task-terminal:browser-sim" }),
    })).status).toBe(202);
    const deadline = Date.now() + 2_000;
    while (!value.receipt().seal.complete && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const receipt = value.receipt();
    expect(receipt.seal).toMatchObject({ ledgerSealed: true, complete: true });
    expect(receipt.transport).toMatchObject({
      rejectedEventCount: 0,
      gapCount: 0,
      capped: false,
      zeroDrops: true,
    });
    expect(receipt.transport.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      "ledger_begin",
      "tool_registered",
      "invocation_begin",
      "invocation_end",
      "close_requested",
      "ledger_end",
    ]);
    const terminalLedger = JSON.parse(receipt.retrieval.chunks.map(
      (chunk: { jsonFragment: string }) => chunk.jsonFragment,
    ).join(""));
    expect(terminalLedger.calls[0]).toMatchObject({
      toolName: "query_objects",
      outcome: "success",
      output: { status: "complete", json: JSON.stringify(result) },
    });
    // The VM test rewrites the ESM export into a classic-script hook. The real
    // module keeps every other top-level binding module-scoped.
    expect(initialKeys).not.toContain("__exp0036TestAdapter");
  });

  it("is inert when registration modules are evaluated during server rendering", async () => {
    const built = await buildExp0036RecorderInjection({
      attemptId: "attempt-ssr-sim",
      sessionEpoch: SESSION_EPOCH,
      eventUrl: "http://127.0.0.1:9/v1/attempts/attempt-ssr-sim/events",
      startupFailureUrl: "http://127.0.0.1:9/v1/attempts/attempt-ssr-sim/startup-failures",
      commandUrl: "http://127.0.0.1:9/v1/attempts/attempt-ssr-sim/commands",
      attemptSecret: ATTEMPT_SECRET,
    });
    let fetchCalls = 0;
    const context = {
      fetch() { fetchCalls += 1; throw new Error("SSR observer attempted transport"); },
      queueMicrotask,
      TextEncoder,
      performance,
    };
    const executableSource = built.source.replace(
      /export \{\s+exp0036InstrumentModelContext\s+\};\s*$/,
      "globalThis.__exp0036SsrAdapter = exp0036InstrumentModelContext;",
    );
    runInNewContext(executableSource, context);
    const modelContext = { registerTool() { return undefined; } };
    const adapter = (context as typeof context & {
      __exp0036SsrAdapter: (value: typeof modelContext) => typeof modelContext;
    }).__exp0036SsrAdapter;
    expect(adapter(modelContext)).toBe(modelContext);
    expect(fetchCalls).toBe(0);
  });
});
