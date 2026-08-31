#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const CODEX_AUTH_PREFLIGHT_SCHEMA_VERSION = "codex-chatgpt-auth-preflight/v1";
export const CODEX_LOGIN_STATUS_COMMAND = Object.freeze(["login", "status"]);
export const CODEX_LOGIN_STATUS_TIMEOUT_MS = 15_000;
export const CODEX_LOGIN_STATUS_MAX_BYTES = 64 * 1024;
export const CODEX_CHATGPT_APP_EXECUTABLE =
  "/Applications/ChatGPT.app/Contents/Resources/codex";

const CHATGPT_STATUS = "Logged in using ChatGPT";
const API_KEY_STATUS = "Logged in using an API key";

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function hasExactKeys(value, keys) {
  const record = plainRecord(value);
  if (!record) return false;
  const observed = Object.keys(record).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  return canonicalJson(observed) === canonicalJson(expected);
}

function validObservationField(value, valuePredicate) {
  return hasExactKeys(value, ["observability", "value"])
    && (value.observability === "observed" || value.observability === "unobservable")
    && valuePredicate(value.value, value.observability);
}

function outputLines(value) {
  if (typeof value !== "string" || value.length === 0) return [];
  const normalized = value.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) return null;
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (withoutFinalNewline.length === 0) return [];
  const lines = withoutFinalNewline.split("\n");
  if (lines.some((line) => line.length === 0)) return null;
  return lines;
}

function exactStatusLine(observation) {
  const stdoutLines = outputLines(observation?.stdout);
  const stderrLines = outputLines(observation?.stderr);
  if (stdoutLines === null || stderrLines === null) return null;
  const lines = [...stdoutLines, ...stderrLines];
  const statusLines = lines.filter((line) => line === CHATGPT_STATUS || line === API_KEY_STATUS);
  if (statusLines.length !== 1) return null;
  const auxiliary = lines.filter((line) => line !== statusLines[0]);
  // Codex can emit a benign PATH-alias warning before the status in restricted
  // environments. Accept warning framing only when it cannot itself smuggle a
  // second authentication assertion.
  if (auxiliary.some((line) => !line.startsWith("WARNING: ") || /logged in using/i.test(line))) return null;
  return statusLines[0];
}

export function classifyCodexLoginStatus(observation) {
  const exitCode = Number.isSafeInteger(observation?.exitCode) ? observation.exitCode : null;
  const signal = typeof observation?.signal === "string" && observation.signal.length > 0
    ? observation.signal
    : null;
  const invocationError = observation?.invocationError === true;
  const outputLimitExceeded = observation?.outputLimitExceeded === true;
  if (invocationError) {
    return Object.freeze({ method: "unobservable", allowed: false, reasonCode: "AUTH_STATUS_COMMAND_ERROR" });
  }
  if (outputLimitExceeded) {
    return Object.freeze({ method: "unknown", allowed: false, reasonCode: "AUTH_STATUS_OUTPUT_LIMIT" });
  }
  if (exitCode !== 0 || signal !== null) {
    return Object.freeze({ method: "unobservable", allowed: false, reasonCode: "AUTH_STATUS_COMMAND_FAILED" });
  }
  const status = exactStatusLine(observation);
  if (status === CHATGPT_STATUS) {
    return Object.freeze({ method: "chatgpt", allowed: true, reasonCode: "CHATGPT_AUTHENTICATED" });
  }
  if (status === API_KEY_STATUS) {
    return Object.freeze({ method: "api_key", allowed: false, reasonCode: "API_KEY_AUTHENTICATION_FORBIDDEN" });
  }
  return Object.freeze({ method: "unknown", allowed: false, reasonCode: "AUTH_METHOD_UNKNOWN" });
}

export function createCodexAuthPreflightReceipt(observation, options = {}) {
  const checkedAt = new Date(options.checkedAt ?? new Date()).toISOString();
  const stdout = typeof observation?.stdout === "string" ? observation.stdout : "";
  const stderr = typeof observation?.stderr === "string" ? observation.stderr : "";
  const classification = classifyCodexLoginStatus(observation);
  const content = {
    schemaVersion: CODEX_AUTH_PREFLIGHT_SCHEMA_VERSION,
    checkedAt,
    command: Object.freeze({ executable: "codex", arguments: CODEX_LOGIN_STATUS_COMMAND }),
    authentication: Object.freeze({
      method: classification.method,
      accountIdentifier: Object.freeze({ observability: "unobservable", value: null }),
      subscriptionPlan: Object.freeze({ observability: "unobservable", value: null }),
    }),
    observation: Object.freeze({
      exitCode: Object.freeze({
        observability: Number.isSafeInteger(observation?.exitCode) ? "observed" : "unobservable",
        value: Number.isSafeInteger(observation?.exitCode) ? observation.exitCode : null,
      }),
      signal: Object.freeze({
        observability: typeof observation?.signal === "string" ? "observed" : "unobservable",
        value: typeof observation?.signal === "string" ? observation.signal : null,
      }),
      stdoutSha256: Object.freeze({ observability: "observed", value: sha256(Buffer.from(stdout, "utf8")) }),
      stderrSha256: Object.freeze({ observability: "observed", value: sha256(Buffer.from(stderr, "utf8")) }),
      rawOutputRetained: false,
      outputLimitExceeded: observation?.outputLimitExceeded === true,
      invocationError: observation?.invocationError === true,
    }),
    decision: Object.freeze({
      allowCodexNativeExperiment: classification.allowed,
      reasonCode: classification.reasonCode,
    }),
  };
  const receipt = {
    ...content,
    receiptSha256: sha256(Buffer.from(canonicalJson(content), "utf8")),
  };
  return deepFreeze(receipt);
}

function boundedAppend(current, chunk) {
  const next = current + chunk.toString("utf8");
  return Buffer.byteLength(next, "utf8") <= CODEX_LOGIN_STATUS_MAX_BYTES
    ? Object.freeze({ value: next, exceeded: false })
    : Object.freeze({ value: current, exceeded: true });
}

async function verifyTrustedCodexExecutable(executable) {
  const canonical = await realpath(executable);
  const metadata = await lstat(executable);
  if (canonical !== executable || !metadata.isFile() || metadata.isSymbolicLink()
      || (metadata.mode & 0o111) === 0) {
    throw new Error("Codex authentication preflight requires the trusted ChatGPT app executable.");
  }
}

export async function invokeCodexLoginStatus(options = {}) {
  const executable = options.executable ?? CODEX_CHATGPT_APP_EXECUTABLE;
  const spawnImpl = options.spawn ?? spawn;
  const timeoutMs = options.timeoutMs ?? CODEX_LOGIN_STATUS_TIMEOUT_MS;
  if (executable !== CODEX_CHATGPT_APP_EXECUTABLE) {
    throw new Error("Codex authentication preflight refuses PATH or caller-selected executables.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Codex authentication preflight timeout must be between 1 and 60000 milliseconds.");
  }
  // Unit tests inject the process launcher but cannot change the executable
  // identity. Production resolves the fixed ChatGPT app binary before every
  // invocation, so a PATH alias cannot forge subscription authentication.
  if (options.spawn === undefined) await verifyTrustedCodexExecutable(executable);
  return new Promise((resolveObservation) => {
    let stdout = "";
    let stderr = "";
    let outputLimitExceeded = false;
    let settled = false;
    let child;
    let timer;
    const finish = (observation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveObservation(Object.freeze(observation));
    };
    try {
      child = spawnImpl(executable, CODEX_LOGIN_STATUS_COMMAND, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolveObservation(Object.freeze({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        invocationError: true,
        outputLimitExceeded: false,
      }));
      return;
    }
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ stdout, stderr, exitCode: null, signal: "TIMEOUT", invocationError: true, outputLimitExceeded });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      const next = boundedAppend(stdout, chunk);
      stdout = next.value;
      outputLimitExceeded ||= next.exceeded;
      if (next.exceeded) child.kill("SIGTERM");
    });
    child.stderr?.on("data", (chunk) => {
      const next = boundedAppend(stderr, chunk);
      stderr = next.value;
      outputLimitExceeded ||= next.exceeded;
      if (next.exceeded) child.kill("SIGTERM");
    });
    child.once("error", () => finish({
      stdout,
      stderr,
      exitCode: null,
      signal: null,
      invocationError: true,
      outputLimitExceeded,
    }));
    child.once("close", (exitCode, signal) => finish({
      stdout,
      stderr,
      exitCode,
      signal,
      invocationError: false,
      outputLimitExceeded,
    }));
  });
}

export async function runCodexAuthPreflight(options = {}) {
  const invoke = options.invoke ?? invokeCodexLoginStatus;
  const observation = await invoke(options);
  return createCodexAuthPreflightReceipt(observation, { checkedAt: options.checkedAt });
}

/**
 * Verify a retained receipt without re-running `codex login status`. The
 * receipt intentionally contains only hashes and non-secret classifications;
 * raw CLI output is neither accepted nor returned.
 */
export function verifyCodexAuthPreflightReceipt(receiptInput) {
  if (!hasExactKeys(receiptInput, [
    "schemaVersion",
    "checkedAt",
    "command",
    "authentication",
    "observation",
    "decision",
    "receiptSha256",
  ])) throw new Error("CODEX_AUTH_PREFLIGHT_RECEIPT_INVALID");
  const receipt = receiptInput;
  if (receipt.schemaVersion !== CODEX_AUTH_PREFLIGHT_SCHEMA_VERSION
      || Number.isNaN(Date.parse(receipt.checkedAt))
      || !hasExactKeys(receipt.command, ["executable", "arguments"])
      || receipt.command.executable !== "codex"
      || canonicalJson(receipt.command.arguments) !== canonicalJson(CODEX_LOGIN_STATUS_COMMAND)
      || !hasExactKeys(receipt.authentication, ["method", "accountIdentifier", "subscriptionPlan"])
      || !["chatgpt", "api_key", "unknown", "unobservable"].includes(receipt.authentication.method)
      || !validObservationField(receipt.authentication.accountIdentifier,
        (value, observability) => observability === "unobservable" && value === null)
      || !validObservationField(receipt.authentication.subscriptionPlan,
        (value, observability) => observability === "unobservable" && value === null)
      || !hasExactKeys(receipt.observation, [
        "exitCode",
        "signal",
        "stdoutSha256",
        "stderrSha256",
        "rawOutputRetained",
        "outputLimitExceeded",
        "invocationError",
      ])
      || !validObservationField(receipt.observation.exitCode,
        (value, observability) => observability === "unobservable"
          ? value === null
          : Number.isSafeInteger(value))
      || !validObservationField(receipt.observation.signal,
        (value, observability) => observability === "unobservable"
          ? value === null
          : typeof value === "string")
      || !validObservationField(receipt.observation.stdoutSha256,
        (value, observability) => observability === "observed" && /^sha256:[a-f0-9]{64}$/.test(value))
      || !validObservationField(receipt.observation.stderrSha256,
        (value, observability) => observability === "observed" && /^sha256:[a-f0-9]{64}$/.test(value))
      || receipt.observation.rawOutputRetained !== false
      || typeof receipt.observation.outputLimitExceeded !== "boolean"
      || typeof receipt.observation.invocationError !== "boolean"
      || !hasExactKeys(receipt.decision, ["allowCodexNativeExperiment", "reasonCode"])
      || typeof receipt.decision.allowCodexNativeExperiment !== "boolean"
      || typeof receipt.decision.reasonCode !== "string") {
    throw new Error("CODEX_AUTH_PREFLIGHT_RECEIPT_INVALID");
  }
  const allowed = receipt.authentication.method === "chatgpt";
  if (receipt.decision.allowCodexNativeExperiment !== allowed
      || (allowed && receipt.decision.reasonCode !== "CHATGPT_AUTHENTICATED")) {
    throw new Error("CODEX_AUTH_PREFLIGHT_RECEIPT_INCONSISTENT");
  }
  const { receiptSha256, ...content } = receipt;
  if (!/^sha256:[a-f0-9]{64}$/.test(receiptSha256)
      || receiptSha256 !== sha256(Buffer.from(canonicalJson(content), "utf8"))) {
    throw new Error("CODEX_AUTH_PREFLIGHT_RECEIPT_DIGEST_INVALID");
  }
  return deepFreeze(receipt);
}

export function assertCodexNativeExperimentAuthorized(receipt) {
  let verified;
  try {
    verified = verifyCodexAuthPreflightReceipt(receipt);
  } catch (cause) {
    const error = new Error("CODEX_CHATGPT_AUTH_REQUIRED: AUTH_PREFLIGHT_RECEIPT_INVALID", { cause });
    error.code = "CODEX_CHATGPT_AUTH_REQUIRED";
    error.receipt = null;
    throw error;
  }
  if (verified.decision.allowCodexNativeExperiment !== true
      || verified.authentication.method !== "chatgpt") {
    const error = new Error(
      `CODEX_CHATGPT_AUTH_REQUIRED: ${verified.decision.reasonCode}`,
    );
    error.code = "CODEX_CHATGPT_AUTH_REQUIRED";
    error.receipt = verified;
    throw error;
  }
  return verified;
}

function parseCli(argv) {
  if (argv.length !== 0) throw new Error("Usage: node research/scripts/codex-auth-preflight.mjs");
}

async function main() {
  parseCli(process.argv.slice(2));
  const receipt = await runCodexAuthPreflight();
  process.stdout.write(`${canonicalJson(receipt)}\n`);
  assertCodexNativeExperimentAuthorized(receipt);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
