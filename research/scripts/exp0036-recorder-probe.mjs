#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

export const EXP0036_PROBE_COLLECTOR_SCHEMA_VERSION =
  "jazzboard-exp0036-probe-collector/v1";
export const EXP0036_PROBE_EVENT_SCHEMA_VERSION =
  "jazzboard-exp0036-probe-event/v1";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY = path.dirname(SCRIPT_PATH);
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_CHUNK_UTF8_BYTES = 32_768;

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function exactSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseAppOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash
      || !parsed.hostname.endsWith(".localhost")) {
    throw new Error("EXP0036 probe app origin must be an exact http://<unique>.localhost[:port] origin.");
  }
  return parsed.origin;
}

function splitUtf8(value, maxBytes = MAX_CHUNK_UTF8_BYTES) {
  const chunks = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (current && currentBytes + characterBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current || value === "") chunks.push(current);
  return chunks;
}

function readBody(request, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        reject(Object.assign(new Error("request body exceeds collector cap"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("request body is not JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function writeJson(response, status, value, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(bytes);
}

function validateCollectorOptions(options) {
  const attemptId = options.attemptId;
  if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId)) {
    throw new Error("EXP0036 collector attemptId is invalid.");
  }
  const appOrigin = parseAppOrigin(options.appOrigin);
  const ingestSecret = options.ingestSecret ?? options.attemptSecret;
  const controlSecret = options.controlSecret ?? options.attemptSecret;
  if (typeof ingestSecret !== "string" || !SECRET.test(ingestSecret)) {
    throw new Error("EXP0036 collector ingestSecret is invalid.");
  }
  if (typeof controlSecret !== "string" || !SECRET.test(controlSecret)) {
    throw new Error("EXP0036 collector controlSecret is invalid.");
  }
  for (const [label, value] of [
    ["maxEvents", options.maxEvents ?? 10_000],
    ["maxBodyBytes", options.maxBodyBytes ?? 8_000_000],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`EXP0036 collector ${label} is invalid.`);
  }
  return {
    attemptId,
    appOrigin,
    ingestSecret,
    controlSecret,
    sessionEpoch: options.sessionEpoch ?? null,
    observerSourceSha256: options.observerSourceSha256 ?? null,
    observerConfigSha256: options.observerConfigSha256 ?? null,
    maxEvents: options.maxEvents ?? 10_000,
    maxBodyBytes: options.maxBodyBytes ?? 8_000_000,
  };
}

/** Start one controller-owned, memory-only loopback collector. */
export async function startExp0036ProbeCollector(options) {
  const config = validateCollectorOptions(options);
  let expectedHost = null;
  let nextSequence = 1;
  let accepted = 0;
  let duplicates = 0;
  let rejectedEvents = 0;
  let rejectedAuxiliaryRequests = 0;
  let externalRejectedRequests = 0;
  let rejectionDiagnosticsCapped = false;
  let capped = false;
  let latestLedger = null;
  let latestLedgerJson = null;
  let sealEventSequence = null;
  let closeControl = null;
  let closed = false;
  const gaps = [];
  const startupFailures = [];
  const eventDigests = new Map();
  const commandWaiters = new Set();
  const rejectionDiagnostics = [];

  function recordRejection(request, url, code, classification) {
    if (classification === "authenticated_event") rejectedEvents += 1;
    else if (classification === "authenticated_auxiliary") rejectedAuxiliaryRequests += 1;
    else externalRejectedRequests += 1;
    if (rejectionDiagnostics.length >= 64) {
      rejectionDiagnosticsCapped = true;
      return;
    }
    const suppliedSecret = request.headers["x-exp0036-attempt-secret"];
    rejectionDiagnostics.push({
      ordinal: rejectedEvents + rejectedAuxiliaryRequests + externalRejectedRequests,
      classification,
      code,
      method: request.method ?? null,
      path: url?.pathname?.slice(0, 512) ?? null,
      origin: typeof request.headers.origin === "string" ? request.headers.origin.slice(0, 512) : null,
      tokenPresent: typeof suppliedSecret === "string" && suppliedSecret.length > 0,
      hostMatches: request.headers.host === expectedHost,
      originMatches: request.headers.origin === config.appOrigin,
      ingestTokenMatches: exactSecret(suppliedSecret, config.ingestSecret),
      controlTokenMatches: exactSecret(suppliedSecret, config.controlSecret),
    });
  }

  function bindProbe(binding) {
    if (accepted > 0) throw new Error("EXP0036 collector binding cannot change after receipt.");
    for (const key of ["sessionEpoch", "observerSourceSha256", "observerConfigSha256"]) {
      if (typeof binding[key] !== "string" || (key !== "sessionEpoch" && !SHA256.test(binding[key]))) {
        throw new Error(`EXP0036 collector ${key} binding is invalid.`);
      }
      config[key] = binding[key];
    }
  }

  function terminalReceipt() {
    const ledgerJson = latestLedgerJson;
    const chunks = ledgerJson === null ? [] : splitUtf8(ledgerJson).map((jsonFragment, index) => ({
      ordinal: index + 1,
      complete: true,
      truncated: false,
      jsonFragment,
      utf8Bytes: Buffer.byteLength(jsonFragment, "utf8"),
      sha256: sha256(Buffer.from(jsonFragment, "utf8")),
    }));
    const orderedEventsComplete = accepted === nextSequence - 1
      && gaps.length === 0 && !capped && rejectedEvents === 0 && startupFailures.length === 0;
    const ledgerSealed = latestLedger?.sessionEpoch === config.sessionEpoch
      && latestLedger?.lifecycle?.state === "sealed"
      && latestLedger?.lifecycle?.closeRequested === true
      && latestLedger?.lifecycle?.end !== null
      && latestLedger?.captureComplete === true
      && latestLedger?.valid === true
      && latestLedger?.pendingCount === 0;
    const sealComplete = Boolean(
      closeControl?.taskTerminal === true
      && sealEventSequence !== null
      && orderedEventsComplete
      && ledgerSealed,
    );
    const content = {
      schemaVersion: EXP0036_PROBE_COLLECTOR_SCHEMA_VERSION,
      attemptId: config.attemptId,
      binding: {
        sessionEpoch: config.sessionEpoch,
        appOrigin: config.appOrigin,
        observerSourceSha256: config.observerSourceSha256,
        observerConfigSha256: config.observerConfigSha256,
      },
      access: {
        controllerOnly: true,
        authorQueryable: false,
        authorQueryableScope: "permitted_native_webmcp_surface",
        pageJavaScriptIsolationClaimed: false,
        separateIngestAndControlSecrets: !exactSecret(config.ingestSecret, config.controlSecret),
        injectionWorld: "main",
        authorFacingEndpointCount: 0,
        publicWebMcpToolCountAdded: 0,
        startupFailures: startupFailures.map((failure) => ({ ...failure })),
      },
      transport: {
        acceptedEventCount: accepted,
        nextExpectedSequence: nextSequence,
        firstSequence: accepted > 0 ? 1 : null,
        lastSequence: accepted > 0 ? nextSequence - 1 : null,
        duplicateEventCount: duplicates,
        rejectedEventCount: rejectedEvents,
        rejectedAuxiliaryRequestCount: rejectedAuxiliaryRequests,
        externalRejectedRequestCount: externalRejectedRequests,
        rejectionDiagnosticCount: rejectionDiagnostics.length,
        rejectionDiagnosticsCapped,
        rejectionDiagnostics: rejectionDiagnostics.map((diagnostic) => ({ ...diagnostic })),
        gapCount: gaps.length,
        gaps: gaps.map((gap) => ({ ...gap })),
        capped,
        maxEvents: config.maxEvents,
        zeroDrops: orderedEventsComplete,
        events: [...eventDigests.entries()].map(([sequence, event]) => ({
          sequence,
          eventType: event.eventType,
          envelopeSha256: event.envelopeSha256,
          ledgerJsonSha256: event.ledgerJsonSha256,
        })),
      },
      close: closeControl ? { ...closeControl } : null,
      seal: {
        eventSequence: sealEventSequence,
        ledgerSealed,
        complete: sealComplete,
      },
      retrieval: {
        method: "authenticated_loopback_collector",
        complete: sealComplete,
        truncated: capped,
        originHostname: new URL(config.appOrigin).hostname,
        maxChunkUtf8Bytes: MAX_CHUNK_UTF8_BYTES,
        chunkCount: chunks.length,
        completeChunkCount: chunks.length,
        jsonUtf8Bytes: ledgerJson === null ? null : Buffer.byteLength(ledgerJson, "utf8"),
        jsonSha256: ledgerJson === null ? null : sha256(Buffer.from(ledgerJson, "utf8")),
        chunks,
        ledgerSha256: latestLedger === null ? null : sha256(Buffer.from(canonicalJson(latestLedger), "utf8")),
      },
    };
    return { ...content, receiptSha256: sha256(Buffer.from(canonicalJson(content), "utf8")) };
  }

  function cors(request) {
    return request.headers.origin === config.appOrigin ? {
      "access-control-allow-origin": config.appOrigin,
      "access-control-allow-headers": "content-type, x-exp0036-attempt-secret",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-private-network": "true",
      vary: "origin",
    } : null;
  }

  function authenticated(request, requireOrigin) {
    if (request.headers.host !== expectedHost) return { status: 421, code: "HOST_MISMATCH" };
    if (requireOrigin && request.headers.origin !== config.appOrigin) return { status: 403, code: "ORIGIN_MISMATCH" };
    const expectedSecret = requireOrigin ? config.ingestSecret : config.controlSecret;
    if (!exactSecret(request.headers["x-exp0036-attempt-secret"], expectedSecret)) {
      return { status: 401, code: "TOKEN_MISMATCH" };
    }
    return null;
  }

  const attemptPath = `/v1/attempts/${encodeURIComponent(config.attemptId)}`;
  const server = createServer(async (request, response) => {
    let eventRequest = false;
    let authenticatedRequest = false;
    let rejectionRecorded = false;
    let url = null;
    try {
      url = new URL(request.url, `http://${request.headers.host ?? "invalid"}`);
      eventRequest = request.method === "POST" && url.pathname === `${attemptPath}/events`;
      const isBrowserRoute = url.pathname === `${attemptPath}/events`
        || url.pathname === `${attemptPath}/commands`
        || url.pathname === `${attemptPath}/startup-failures`;
      if (request.method === "OPTIONS" && isBrowserRoute) {
        const corsHeaders = cors(request);
        if (!corsHeaders) {
          recordRejection(request, url, "ORIGIN_MISMATCH", "external_untrusted");
          rejectionRecorded = true;
          return writeJson(response, 403, { ok: false, code: "ORIGIN_MISMATCH" });
        }
        response.writeHead(204, corsHeaders);
        response.end();
        return;
      }
      const authFailure = authenticated(request, isBrowserRoute);
      if (authFailure) {
        recordRejection(request, url, authFailure.code, "external_untrusted");
        rejectionRecorded = true;
        return writeJson(response, authFailure.status, { ok: false, code: authFailure.code }, cors(request) ?? {});
      }
      authenticatedRequest = true;

      if (request.method === "POST" && url.pathname === `${attemptPath}/events`) {
        const corsHeaders = cors(request) ?? {};
        const body = await readBody(request, config.maxBodyBytes);
        if (body?.schemaVersion !== EXP0036_PROBE_EVENT_SCHEMA_VERSION
            || body.attemptId !== config.attemptId
            || body.sessionEpoch !== config.sessionEpoch
            || body.observerConfigSha256 !== config.observerConfigSha256
            || !Number.isSafeInteger(body.streamSequence) || body.streamSequence < 1
            || !body.event || typeof body.event.type !== "string"
            || !body.ledger || body.ledger.sessionEpoch !== config.sessionEpoch) {
          recordRejection(request, url, "EVENT_INVALID", "authenticated_event");
          rejectionRecorded = true;
          return writeJson(response, 400, { ok: false, code: "EVENT_INVALID" }, corsHeaders);
        }
        const bodyDigest = sha256(Buffer.from(canonicalJson(body), "utf8"));
        if (body.streamSequence < nextSequence) {
          if (eventDigests.get(body.streamSequence)?.envelopeSha256 === bodyDigest) {
            duplicates += 1;
            return writeJson(response, 200, {
              ok: true, acknowledgedSequence: body.streamSequence, nextExpectedSequence: nextSequence, duplicate: true,
            }, corsHeaders);
          }
          recordRejection(request, url, "SEQUENCE_REPLAY_MISMATCH", "authenticated_event");
          rejectionRecorded = true;
          return writeJson(response, 409, { ok: false, code: "SEQUENCE_REPLAY_MISMATCH" }, corsHeaders);
        }
        if (body.streamSequence > nextSequence) {
          gaps.push({ expected: nextSequence, observed: body.streamSequence });
          recordRejection(request, url, "SEQUENCE_GAP", "authenticated_event");
          rejectionRecorded = true;
          return writeJson(response, 409, { ok: false, code: "SEQUENCE_GAP", expected: nextSequence }, corsHeaders);
        }
        if (accepted >= config.maxEvents) {
          capped = true;
          recordRejection(request, url, "EVENT_CAP_REACHED", "authenticated_event");
          rejectionRecorded = true;
          return writeJson(response, 507, { ok: false, code: "EVENT_CAP_REACHED" }, corsHeaders);
        }
        eventDigests.set(body.streamSequence, {
          eventType: body.event.type,
          envelopeSha256: bodyDigest,
          ledgerJsonSha256: sha256(Buffer.from(JSON.stringify(body.ledger), "utf8")),
        });
        accepted += 1;
        nextSequence += 1;
        latestLedger = body.ledger;
        latestLedgerJson = JSON.stringify(body.ledger);
        if (body.event.type === "ledger_end") sealEventSequence = body.streamSequence;
        return writeJson(response, 200, {
          ok: true,
          acknowledgedSequence: body.streamSequence,
          nextExpectedSequence: nextSequence,
          duplicate: false,
          sealAccepted: body.event.type === "ledger_end",
        }, corsHeaders);
      }

      if (request.method === "POST" && url.pathname === `${attemptPath}/startup-failures`) {
        const corsHeaders = cors(request) ?? {};
        const body = await readBody(request, 32_768);
        startupFailures.push({
          stage: typeof body?.stage === "string" ? body.stage : "unknown",
          name: typeof body?.name === "string" ? body.name : "Error",
          message: typeof body?.message === "string" ? body.message.slice(0, 2_000) : "Unknown startup failure",
        });
        return writeJson(response, 202, { ok: true, recorded: true }, corsHeaders);
      }

      if (request.method === "GET" && url.pathname === `${attemptPath}/commands`) {
        const corsHeaders = cors(request) ?? {};
        if (closeControl) return writeJson(response, 200, { ok: true, command: "close", close: closeControl }, corsHeaders);
        const timer = setTimeout(() => {
          commandWaiters.delete(waiter);
          if (!response.writableEnded) writeJson(response, 200, { ok: true, command: "wait" }, corsHeaders);
        }, 20_000);
        const waiter = () => {
          clearTimeout(timer);
          if (!response.writableEnded) writeJson(response, 200, { ok: true, command: "close", close: closeControl }, corsHeaders);
        };
        commandWaiters.add(waiter);
        response.on("close", () => {
          clearTimeout(timer);
          commandWaiters.delete(waiter);
        });
        return;
      }

      if (request.method === "POST" && url.pathname === `${attemptPath}/control/close`) {
        const body = await readBody(request, 32_768);
        if (body?.taskTerminal !== true || typeof body.terminalReference !== "string" || !body.terminalReference) {
          recordRejection(request, url, "TERMINAL_CLOSE_PROOF_INVALID", "authenticated_auxiliary");
          rejectionRecorded = true;
          return writeJson(response, 400, { ok: false, code: "TERMINAL_CLOSE_PROOF_INVALID" });
        }
        closeControl ??= {
          taskTerminal: true,
          terminalReference: body.terminalReference,
          requestedAt: new Date().toISOString(),
          issuedBy: "controller",
        };
        for (const waiter of [...commandWaiters]) waiter();
        commandWaiters.clear();
        return writeJson(response, 202, { ok: true, close: closeControl, seal: terminalReceipt().seal });
      }

      if (request.method === "GET" && url.pathname === `${attemptPath}/status`) {
        return writeJson(response, 200, { ok: true, receipt: terminalReceipt() });
      }

      recordRejection(request, url, "NOT_FOUND", "authenticated_auxiliary");
      rejectionRecorded = true;
      return writeJson(response, 404, { ok: false, code: "NOT_FOUND" });
    } catch (error) {
      if (!rejectionRecorded) {
        recordRejection(
          request,
          url,
          error?.statusCode === 413 ? "BODY_CAP_REACHED" : "COLLECTOR_ERROR",
          authenticatedRequest ? (eventRequest ? "authenticated_event" : "authenticated_auxiliary") : "external_untrusted",
        );
      }
      if (!response.headersSent) writeJson(response, error?.statusCode ?? 500, { ok: false, code: "COLLECTOR_ERROR" });
      else response.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: options.port ?? 0, exclusive: true }, () => resolve());
  });
  const address = server.address();
  expectedHost = `127.0.0.1:${address.port}`;
  const origin = `http://${expectedHost}`;

  return {
    origin,
    eventUrl: `${origin}${attemptPath}/events`,
    startupFailureUrl: `${origin}${attemptPath}/startup-failures`,
    commandUrl: `${origin}${attemptPath}/commands`,
    closeUrl: `${origin}${attemptPath}/control/close`,
    statusUrl: `${origin}${attemptPath}/status`,
    bindProbe,
    receipt: terminalReceipt,
    async close() {
      if (closed) return;
      closed = true;
      for (const waiter of [...commandWaiters]) waiter();
      commandWaiters.clear();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function observerEntry(config) {
  return `
import { installExp0036NativeRecorder } from "./exp0036-native-recorder.mjs";
const config = Object.freeze(${JSON.stringify(config)});
const browserRuntime = typeof window !== "undefined" && typeof document !== "undefined";
let controller = null;
let streamSequence = 0;
const queue = [];
let draining = null;
function observe(event) {
  queue.push({ streamSequence: ++streamSequence, event });
  queueMicrotask(() => { void drain(); });
  return true;
}
async function drain() {
  if (draining) return draining;
  draining = (async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      const body = {
        schemaVersion: ${JSON.stringify(EXP0036_PROBE_EVENT_SCHEMA_VERSION)},
        attemptId: config.attemptId,
        sessionEpoch: config.sessionEpoch,
        observerConfigSha256: config.observerConfigSha256,
        streamSequence: entry.streamSequence,
        event: entry.event,
        ledger: controller.getLedger(),
      };
      try {
        const response = await fetch(config.eventUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "x-exp0036-attempt-secret": config.attemptSecret },
          body: JSON.stringify(body),
          cache: "no-store",
        });
        const ack = await response.json();
        if (!response.ok || ack.acknowledgedSequence !== entry.streamSequence) {
          controller.invalidate("collector_delivery_failure", { sequence: entry.streamSequence, status: response.status });
        }
      } catch (error) {
        controller.invalidate("collector_delivery_failure", { sequence: entry.streamSequence, message: String(error) });
      }
    }
  })().finally(() => { draining = null; if (queue.length > 0) void drain(); });
  return draining;
}
async function commandLoop() {
  while (true) {
    try {
      const response = await fetch(config.commandUrl, {
        headers: { "x-exp0036-attempt-secret": config.attemptSecret },
        cache: "no-store",
      });
      const command = await response.json();
      if (!response.ok) throw new Error("command HTTP " + response.status);
      if (command.command === "close") {
        controller.close();
        await drain();
        return;
      }
    } catch (error) {
      controller.invalidate("collector_control_failure", { message: String(error) });
      return;
    }
  }
}
let targetModelContext = null;
const modelContextBridge = {
  registerTool(...args) {
    if (!targetModelContext || typeof targetModelContext.registerTool !== "function") {
      throw new Error("EXP0036 native ModelContext target is unavailable.");
    }
    return Reflect.apply(targetModelContext.registerTool, targetModelContext, args);
  },
};
if (browserRuntime) {
  try {
    controller = installExp0036NativeRecorder(modelContextBridge, {
      sessionEpoch: config.sessionEpoch,
      maxCaptureBytes: config.maxCaptureBytes,
      maxInvocations: config.maxInvocations,
      onEvent: observe,
    });
    void drain();
    void commandLoop();
  } catch (error) {
    void fetch(config.startupFailureUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-exp0036-attempt-secret": config.attemptSecret },
      body: JSON.stringify({ stage: "recorder_install", name: error?.name ?? "Error", message: error?.message ?? String(error) }),
      cache: "no-store",
    }).catch(() => undefined);
  }
}
export function exp0036InstrumentModelContext(modelContext) {
  if (!modelContext || !controller) return modelContext;
  targetModelContext = modelContext;
  return modelContextBridge;
}
`;
}

/** Build the exact self-contained browser module injected into a disposable archive. */
export async function buildExp0036RecorderInjection(config) {
  const observerConfig = {
    attemptId: config.attemptId,
    sessionEpoch: config.sessionEpoch,
    eventUrl: config.eventUrl,
    startupFailureUrl: config.startupFailureUrl,
    commandUrl: config.commandUrl,
    attemptSecret: config.attemptSecret,
    maxCaptureBytes: config.maxCaptureBytes ?? 4_000_000,
    maxInvocations: config.maxInvocations ?? 1_000,
  };
  observerConfig.observerConfigSha256 = sha256(Buffer.from(canonicalJson(observerConfig), "utf8"));
  const result = await build({
    stdin: { contents: observerEntry(observerConfig), resolveDir: SCRIPT_DIRECTORY, sourcefile: "exp0036-probe-entry.mjs" },
    bundle: true,
    platform: "browser",
    format: "esm",
    target: ["chrome120"],
    write: false,
    minify: false,
    sourcemap: false,
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
  });
  if (result.outputFiles?.length !== 1) throw new Error("EXP0036 observer IIFE build produced an unexpected output set.");
  if (Object.values(result.metafile.outputs).some((output) => output.imports.length > 0)) {
    throw new Error("EXP0036 observer IIFE contains an external import.");
  }
  const source = `// @ts-nocheck\n${result.outputFiles[0].text}`;
  return {
    source,
    observerConfig,
    observerConfigSha256: observerConfig.observerConfigSha256,
    observerSourceSha256: sha256(Buffer.from(source, "utf8")),
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

async function extractGitArchive(ref, outputDirectory) {
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  const archive = spawn("git", ["archive", "--format=tar", ref], {
    cwd: REPOSITORY_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const extractor = spawn("tar", ["-xf", "-", "-C", outputDirectory], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  archive.stdout.pipe(extractor.stdin);
  const errors = [];
  archive.stderr.on("data", (chunk) => errors.push(chunk));
  extractor.stderr.on("data", (chunk) => errors.push(chunk));
  const [archiveCode, extractCode] = await Promise.all([
    new Promise((resolve, reject) => { archive.once("error", reject); archive.once("close", resolve); }),
    new Promise((resolve, reject) => { extractor.once("error", reject); extractor.once("close", resolve); }),
  ]);
  if (archiveCode !== 0 || extractCode !== 0) {
    throw new Error(`EXP0036 git archive extraction failed: ${Buffer.concat(errors).toString("utf8")}`);
  }
}

/** Prepare a new archive copy and inject the observer before instrumentation registration. */
export async function prepareExp0036RecorderProbe(options) {
  const appOrigin = parseAppOrigin(options.appOrigin);
  const commit = (await runProcess("git", ["rev-parse", `${options.ref}^{commit}`], { cwd: REPOSITORY_ROOT }))
    .toString("utf8").trim();
  const requestedOutput = path.resolve(options.outputDirectory);
  const outputDirectory = path.join(await realpath(path.dirname(requestedOutput)), path.basename(requestedOutput));
  if (outputDirectory === REPOSITORY_ROOT || outputDirectory.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) {
    throw new Error("EXP0036 disposable archive output must be outside the source repository.");
  }
  await extractGitArchive(commit, outputDirectory);
  const built = await buildExp0036RecorderInjection({
    attemptId: options.attemptId,
    sessionEpoch: options.sessionEpoch,
    eventUrl: options.eventUrl,
    startupFailureUrl: options.startupFailureUrl,
    commandUrl: options.commandUrl,
    attemptSecret: options.attemptSecret,
    maxCaptureBytes: options.maxCaptureBytes,
    maxInvocations: options.maxInvocations,
  });
  const observerRelativePath = "src/exp0036-recorder-observer.ts";
  const observerPath = path.join(outputDirectory, observerRelativePath);
  await writeFile(observerPath, built.source, { mode: 0o600 });
  const instrumentationPath = path.join(outputDirectory, "src/instrumentation-client.ts");
  const instrumentation = await readFile(instrumentationPath, "utf8");
  const importLine = 'import "./exp0036-recorder-observer";\n';
  if (instrumentation.includes("exp0036-recorder-observer")) {
    throw new Error("EXP0036 disposable archive already contains an observer injection.");
  }
  await writeFile(instrumentationPath, `${importLine}${instrumentation}`, { mode: 0o600 });
  const registrationFiles = [
    "src/lib/webmcp/landing-registration.ts",
    "src/lib/webmcp/registration.ts",
    "src/lib/webmcp/snapshot-registration.ts",
  ];
  for (const relativePath of registrationFiles) {
    const registrationPath = path.join(outputDirectory, relativePath);
    const original = await readFile(registrationPath, "utf8");
    const declaration = 'import { exp0036InstrumentModelContext } from "@/exp0036-recorder-observer";\n';
    const target = "const modelContext = this.getModelContext();";
    if (!original.includes(target)) throw new Error(`EXP0036 registration adapter target missing in ${relativePath}.`);
    const adapted = original.replace(target, "const modelContext = exp0036InstrumentModelContext(this.getModelContext());");
    const insertion = adapted.startsWith("/// <reference") ? adapted.indexOf("\n") + 1 : 0;
    await writeFile(
      registrationPath,
      `${adapted.slice(0, insertion)}${declaration}${adapted.slice(insertion)}`,
      { mode: 0o600 },
    );
  }
  if (options.copyDependencies !== false) {
    const dependencySource = path.join(REPOSITORY_ROOT, "node_modules");
    if (!(await stat(dependencySource)).isDirectory()) throw new Error("EXP0036 source node_modules is unavailable.");
    await cp(dependencySource, path.join(outputDirectory, "node_modules"), {
      recursive: true,
      force: false,
      preserveTimestamps: true,
    });
  }
  return {
    schemaVersion: "jazzboard-exp0036-recorder-probe-prepare/v1",
    attemptId: options.attemptId,
    sessionEpoch: options.sessionEpoch,
    commit,
    appOrigin,
    outputDirectory,
    observerRelativePath,
    instrumentationRelativePath: "src/instrumentation-client.ts",
    registrationAdapterRelativePaths: registrationFiles,
    observerSourceSha256: built.observerSourceSha256,
    observerConfigSha256: built.observerConfigSha256,
    copyDependencies: options.copyDependencies !== false,
  };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag?.startsWith("--") || rest[index + 1] === undefined) throw new Error(`Invalid CLI argument ${flag ?? ""}.`);
    values[flag.slice(2)] = rest[index + 1];
  }
  return { command, values };
}

async function fetchControl(url, secret, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", "x-exp0036-attempt-secret": secret, ...init.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Collector control failed HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (!["probe", "status", "close"].includes(command)) {
    throw new Error("Usage: exp0036-recorder-probe.mjs probe|status|close [--flag value ...]");
  }
  if (command === "status") {
    console.log(JSON.stringify(await fetchControl(values.url, values.secret)));
    return;
  }
  if (command === "close") {
    console.log(JSON.stringify(await fetchControl(values.url, values.secret, {
      method: "POST",
      body: JSON.stringify({ taskTerminal: true, terminalReference: values["terminal-reference"] }),
    })));
    return;
  }

  const attemptId = values["attempt-id"];
  const appOrigin = parseAppOrigin(values["app-origin"]);
  const ingestSecret = randomBytes(32).toString("base64url");
  const controlSecret = values.secret ?? randomBytes(32).toString("base64url");
  const sessionEpoch = values["session-epoch"] ?? `epoch:${attemptId}:${randomBytes(16).toString("hex")}`;
  const collector = await startExp0036ProbeCollector({
    attemptId,
    appOrigin,
    ingestSecret,
    controlSecret,
    sessionEpoch,
  });
  const prepared = await prepareExp0036RecorderProbe({
    ref: values.ref,
    outputDirectory: values.output,
    attemptId,
    appOrigin,
    attemptSecret: ingestSecret,
    sessionEpoch,
    eventUrl: collector.eventUrl,
    startupFailureUrl: collector.startupFailureUrl,
    commandUrl: collector.commandUrl,
    copyDependencies: values["copy-dependencies"] !== "false",
    maxCaptureBytes: values["max-capture-bytes"] ? Number(values["max-capture-bytes"]) : undefined,
    maxInvocations: values["max-invocations"] ? Number(values["max-invocations"]) : undefined,
  });
  collector.bindProbe(prepared);
  console.log(JSON.stringify({
    state: "ready",
    ...prepared,
    collector: {
      origin: collector.origin,
      statusUrl: collector.statusUrl,
      closeUrl: collector.closeUrl,
      secret: controlSecret,
    },
    launch: {
      cwd: prepared.outputDirectory,
      command: `npm run dev -- --hostname 127.0.0.1 --port ${new URL(appOrigin).port || "3000"}`,
      browserUrl: appOrigin,
    },
  }));
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await collector.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
