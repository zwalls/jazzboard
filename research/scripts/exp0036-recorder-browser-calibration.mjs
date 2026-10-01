#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  buildExp0036RecorderInjection,
  startExp0036ProbeCollector,
} from "./exp0036-recorder-probe.mjs";

export const EXP0036_BROWSER_CALIBRATION_SCHEMA_VERSION =
  "jazzboard-exp0036-recorder-browser-calibration/v1";

function integer(value, fallback, label) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive safe integer.`);
  return parsed;
}

function quantile(sorted, probability) {
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
    minMs: sorted[0],
    medianMs: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    maxMs: sorted.at(-1),
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function startCalibrationPageServer(attemptId) {
  let observerSource = null;
  const pageSource = `<!doctype html><meta charset="utf-8"><title>EXP-0036 synthetic calibration</title>
<script type="module">
import { exp0036InstrumentModelContext } from "/observer.mjs";
const tools = new Map();
const nativeTarget = { registerTool(tool) { tools.set(tool.name, tool); return Promise.resolve(); } };
const adapter = exp0036InstrumentModelContext(nativeTarget);
window.exp0036Calibration = {
  async prepare(targetBytes) {
    const overhead = new TextEncoder().encode(JSON.stringify({ ok: true, data: "" })).byteLength;
    const payload = { ok: true, data: "x".repeat(targetBytes - overhead) };
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength !== targetBytes) throw new Error("payload byte mismatch");
    const descriptor = { name: "synthetic_representative_read", async execute() { return payload; } };
    await adapter.registerTool(descriptor);
    this.payload = payload;
    this.baseline = descriptor.execute;
  },
  async runBaseline(ordinal) {
    const started = performance.now();
    const result = await this.baseline({ ordinal });
    return { durationMs: performance.now() - started, identityPreserved: result === this.payload };
  },
  async runWrapped(ordinal) {
    const started = performance.now();
    const result = await tools.get("synthetic_representative_read").execute({ ordinal });
    return { durationMs: performance.now() - started, identityPreserved: result === this.payload };
  },
};
</script>`;
  const server = createServer((request, response) => {
    if (request.url === "/observer.mjs" && observerSource !== null) {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(observerSource);
      return;
    }
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(pageSource);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  return {
    appOrigin: `http://${attemptId}.localhost:${address.port}`,
    setObserverSource(value) { observerSource = value; },
    close() { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}

export async function runExp0036BrowserCalibration(options = {}) {
  const samples = integer(options.samples, 10, "samples");
  const warmups = integer(options.warmups, 3, "warmups");
  const targetOutputJsonUtf8Bytes = integer(options.targetOutputJsonUtf8Bytes, 267_642, "targetOutputJsonUtf8Bytes");
  const attemptId = `calibration-browser-${randomBytes(8).toString("hex")}`;
  const sessionEpoch = `epoch:${attemptId}`;
  const ingestSecret = randomBytes(32).toString("base64url");
  const controlSecret = randomBytes(32).toString("base64url");
  const pageServer = await startCalibrationPageServer(attemptId);
  const collector = await startExp0036ProbeCollector({
    attemptId,
    appOrigin: pageServer.appOrigin,
    ingestSecret,
    controlSecret,
    sessionEpoch,
    maxEvents: (samples + warmups) * 2 + 10,
    maxBodyBytes: Math.max(8_000_000, targetOutputJsonUtf8Bytes * (samples + warmups + 2)),
  });
  let browser;
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
    pageServer.setObserverSource(built.source);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${pageServer.appOrigin}/`, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.exp0036Calibration));
    await page.evaluate((bytes) => window.exp0036Calibration.prepare(bytes), targetOutputJsonUtf8Bytes);
    await waitFor(() => collector.receipt().transport.acceptedEventCount >= 2, 10_000, "browser observer startup ACKs");

    const baselineMs = [];
    const wrappedCompletionMs = [];
    const collectorAckAfterEvaluationMs = [];
    const total = warmups + samples;
    for (let ordinal = 0; ordinal < total; ordinal += 1) {
      let baseline;
      let wrapped;
      let ackDuration;
      const runBaseline = async () => {
        baseline = await page.evaluate((value) => window.exp0036Calibration.runBaseline(value), ordinal);
        if (!baseline.identityPreserved) throw new Error("Browser baseline changed result identity.");
      };
      const runWrapped = async () => {
        const beforeCount = collector.receipt().transport.acceptedEventCount;
        wrapped = await page.evaluate((value) => window.exp0036Calibration.runWrapped(value), ordinal);
        const evaluationReturned = performance.now();
        if (!wrapped.identityPreserved) throw new Error("Browser adapter changed result identity.");
        await waitFor(
          () => collector.receipt().transport.acceptedEventCount >= beforeCount + 2,
          15_000,
          `browser invocation ${ordinal + 1} collector ACKs`,
        );
        ackDuration = performance.now() - evaluationReturned;
      };
      if (ordinal % 2 === 0) { await runBaseline(); await runWrapped(); }
      else { await runWrapped(); await runBaseline(); }
      if (ordinal >= warmups) {
        baselineMs.push(baseline.durationMs);
        wrappedCompletionMs.push(wrapped.durationMs);
        collectorAckAfterEvaluationMs.push(ackDuration);
      }
    }

    const closeResponse = await fetch(collector.closeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-exp0036-attempt-secret": controlSecret },
      body: JSON.stringify({ taskTerminal: true, terminalReference: "synthetic-browser-calibration-terminal" }),
    });
    if (!closeResponse.ok) throw new Error(`Browser calibration close failed HTTP ${closeResponse.status}.`);
    await waitFor(() => collector.receipt().seal.complete, 15_000, "browser terminal collector seal");
    const receipt = collector.receipt();
    return {
      schemaVersion: EXP0036_BROWSER_CALIBRATION_SCHEMA_VERSION,
      classification: "synthetic_playwright_chromium_generated_adapter_and_loopback_collector",
      claims: {
        targetBrowserJavaScriptEngineMeasured: true,
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
        browserVersion: browser.version(),
        playwright: "1.62.1",
      },
      timing: {
        baselineExecutor: summarize(baselineMs),
        generatedAdapterCompletion: summarize(wrappedCompletionMs),
        pairedAddedCompletionCost: summarize(wrappedCompletionMs.map((value, index) => value - baselineMs[index])),
        collectorAckAfterEvaluation: summarize(collectorAckAfterEvaluationMs),
      },
      proof: {
        observerSourceSha256: built.observerSourceSha256,
        observerConfigSha256: built.observerConfigSha256,
        recordedInvocationCount: JSON.parse(receipt.retrieval.chunks.map((chunk) => chunk.jsonFragment).join("")).calls.length,
        acceptedEventCount: receipt.transport.acceptedEventCount,
        rejectedEventCount: receipt.transport.rejectedEventCount,
        externalRejectedRequestCount: receipt.transport.externalRejectedRequestCount,
        gapCount: receipt.transport.gapCount,
        collectorSealComplete: receipt.seal.complete,
        terminalLedgerJsonSha256: receipt.retrieval.jsonSha256,
        collectorReceiptSha256: receipt.receiptSha256,
      },
    };
  } finally {
    await browser?.close();
    await collector.close();
    await pageServer.close();
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
  runExp0036BrowserCalibration({
    samples: cli.samples,
    warmups: cli.warmups,
    targetOutputJsonUtf8Bytes: cli["target-output-json-utf8-bytes"],
  }).then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; },
  );
}
