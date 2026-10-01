#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  buildExp0036RecorderInjection,
  startExp0036ProbeCollector,
} from "./exp0036-recorder-probe.mjs";

export const EXP0036_RECORDER_CALIBRATION_SCHEMA_VERSION =
  "jazzboard-exp0036-recorder-calibration/v1";

function integer(value, fallback, label) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive safe integer.`);
  return parsed;
}

function exactPayload(targetJsonUtf8Bytes) {
  const empty = JSON.stringify({ ok: true, data: "" });
  const overhead = Buffer.byteLength(empty, "utf8");
  if (targetJsonUtf8Bytes < overhead) throw new Error(`target bytes must be at least ${overhead}.`);
  const payload = { ok: true, data: "x".repeat(targetJsonUtf8Bytes - overhead) };
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") !== targetJsonUtf8Bytes) {
    throw new Error("Synthetic payload byte construction failed.");
  }
  return payload;
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? null,
    medianMs: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    maxMs: sorted.at(-1) ?? null,
    meanMs: sorted.length === 0 ? null : sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * Synthetic Node/ESM calibration. This does not use native browser WebMCP and
 * cannot establish author speed or end-user latency.
 */
export async function runExp0036RecorderCalibration(options = {}) {
  const samples = integer(options.samples, 10, "samples");
  const warmups = integer(options.warmups, 3, "warmups");
  const targetOutputJsonUtf8Bytes = integer(
    options.targetOutputJsonUtf8Bytes,
    267_642,
    "targetOutputJsonUtf8Bytes",
  );
  const attemptId = `calibration-${randomBytes(8).toString("hex")}`;
  const sessionEpoch = `epoch:${attemptId}`;
  const appOrigin = `http://${attemptId}.localhost:3199`;
  const ingestSecret = randomBytes(32).toString("base64url");
  const controlSecret = randomBytes(32).toString("base64url");
  const payload = exactPayload(targetOutputJsonUtf8Bytes);
  const collector = await startExp0036ProbeCollector({
    attemptId,
    appOrigin,
    ingestSecret,
    controlSecret,
    sessionEpoch,
    maxEvents: (samples + warmups) * 2 + 10,
    maxBodyBytes: Math.max(8_000_000, targetOutputJsonUtf8Bytes * (samples + warmups + 2)),
  });
  const nativeFetch = globalThis.fetch;
  const nativeWindow = globalThis.window;
  const nativeDocument = globalThis.document;
  const hadWindow = Object.hasOwn(globalThis, "window");
  const hadDocument = Object.hasOwn(globalThis, "document");
  let fetchPatched = false;

  try {
    const built = await buildExp0036RecorderInjection({
      attemptId,
      sessionEpoch,
      eventUrl: collector.eventUrl,
      startupFailureUrl: collector.startupFailureUrl,
      commandUrl: collector.commandUrl,
      attemptSecret: ingestSecret,
      maxCaptureBytes: targetOutputJsonUtf8Bytes + 1_024,
      maxInvocations: samples + warmups,
    });
    collector.bindProbe({
      sessionEpoch,
      observerSourceSha256: built.observerSourceSha256,
      observerConfigSha256: built.observerConfigSha256,
    });

    const tools = new Map();
    const nativeTarget = {
      registerTool(tool) {
        tools.set(tool.name, tool);
        return Promise.resolve();
      },
    };
    globalThis.fetch = function calibrationFetch(input, init = {}) {
      return nativeFetch(input, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init.headers)), origin: appOrigin },
      });
    };
    globalThis.window = {};
    globalThis.document = {};
    fetchPatched = true;
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.source, "utf8").toString("base64")}`;
    const observerModule = await import(moduleUrl);
    const adapter = observerModule.exp0036InstrumentModelContext(nativeTarget);
    const wrappedDescriptor = {
      name: "synthetic_representative_read",
      description: "Synthetic representative read used only for recorder calibration.",
      async execute() { return payload; },
    };
    const baselineDescriptor = {
      ...wrappedDescriptor,
      async execute() { return payload; },
    };
    await adapter.registerTool(wrappedDescriptor);
    await waitFor(() => collector.receipt().transport.acceptedEventCount >= 2, 5_000, "observer startup ACKs");

    const baselineMs = [];
    const wrappedCompletionMs = [];
    const collectorAckAfterCompletionMs = [];
    const total = warmups + samples;
    for (let ordinal = 0; ordinal < total; ordinal += 1) {
      const measured = ordinal >= warmups;
      const baselineFirst = ordinal % 2 === 0;
      let baselineDuration;
      let wrappedDuration;
      let ackDuration;

      const runBaseline = async () => {
        const started = performance.now();
        const result = await baselineDescriptor.execute({ ordinal });
        baselineDuration = performance.now() - started;
        if (result !== payload) throw new Error("Baseline executor changed result identity.");
      };
      const runWrapped = async () => {
        const beforeCount = collector.receipt().transport.acceptedEventCount;
        const started = performance.now();
        const result = await tools.get(wrappedDescriptor.name).execute({ ordinal });
        const completed = performance.now();
        wrappedDuration = completed - started;
        if (result !== payload) throw new Error("Wrapped executor changed result identity.");
        await waitFor(
          () => collector.receipt().transport.acceptedEventCount >= beforeCount + 2,
          10_000,
          `invocation ${ordinal + 1} collector ACKs`,
        );
        ackDuration = performance.now() - completed;
      };
      if (baselineFirst) {
        await runBaseline();
        await runWrapped();
      } else {
        await runWrapped();
        await runBaseline();
      }
      if (measured) {
        baselineMs.push(baselineDuration);
        wrappedCompletionMs.push(wrappedDuration);
        collectorAckAfterCompletionMs.push(ackDuration);
      }
    }

    const closeResponse = await fetch(collector.closeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-exp0036-attempt-secret": controlSecret },
      body: JSON.stringify({ taskTerminal: true, terminalReference: "synthetic-calibration-terminal" }),
    });
    if (!closeResponse.ok) throw new Error(`Calibration close failed HTTP ${closeResponse.status}.`);
    await waitFor(() => collector.receipt().seal.complete, 10_000, "terminal collector seal");
    const receipt = collector.receipt();
    const overheadMs = wrappedCompletionMs.map((value, index) => value - baselineMs[index]);
    return {
      schemaVersion: EXP0036_RECORDER_CALIBRATION_SCHEMA_VERSION,
      classification: "synthetic_node_esm_generated_adapter_and_loopback_collector",
      claims: {
        nativeBrowserWebMcpMeasured: false,
        authorOutcomeMeasured: false,
        agentSpeedMeasured: false,
        collectorNetworkExcludedFromWrappedCompletion: true,
      },
      settings: {
        samples,
        warmups,
        targetOutputJsonUtf8Bytes,
        alternatingOrder: true,
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      timing: {
        baselineExecutor: summarize(baselineMs),
        generatedAdapterCompletion: summarize(wrappedCompletionMs),
        pairedAddedCompletionCost: summarize(overheadMs),
        collectorAckAfterCompletion: summarize(collectorAckAfterCompletionMs),
      },
      proof: {
        observerSourceSha256: built.observerSourceSha256,
        observerConfigSha256: built.observerConfigSha256,
        recordedInvocationCount: receipt.retrieval.complete
          ? JSON.parse(receipt.retrieval.chunks.map((chunk) => chunk.jsonFragment).join("")).calls.length
          : null,
        acceptedEventCount: receipt.transport.acceptedEventCount,
        rejectedEventCount: receipt.transport.rejectedEventCount,
        rejectedAuxiliaryRequestCount: receipt.transport.rejectedAuxiliaryRequestCount,
        gapCount: receipt.transport.gapCount,
        collectorSealComplete: receipt.seal.complete,
        terminalLedgerJsonSha256: receipt.retrieval.jsonSha256,
        collectorReceiptSha256: receipt.receiptSha256,
      },
    };
  } finally {
    if (fetchPatched) {
      globalThis.fetch = nativeFetch;
      if (hadWindow) globalThis.window = nativeWindow;
      else delete globalThis.window;
      if (hadDocument) globalThis.document = nativeDocument;
      else delete globalThis.document;
    }
    await collector.close();
  }
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || argv[index + 1] === undefined) throw new Error(`Invalid argument ${flag ?? ""}.`);
    options[flag.slice(2)] = argv[index + 1];
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = parseCli(process.argv.slice(2));
  runExp0036RecorderCalibration({
    samples: cli.samples,
    warmups: cli.warmups,
    targetOutputJsonUtf8Bytes: cli["target-output-json-utf8-bytes"],
  }).then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
