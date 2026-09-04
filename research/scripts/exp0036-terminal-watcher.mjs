#!/usr/bin/env node

import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`Invalid EXP0036 terminal-watcher argument ${argv[index] ?? ""}.`);
    }
    values[argv[index].slice(2)] = argv[index + 1];
  }
  return values;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function terminalEvent(line, expectedThreadId) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event?.type === "session_meta") {
    const observedThreadId = event.payload?.session_id ?? event.payload?.id;
    if (observedThreadId && observedThreadId !== expectedThreadId) {
      throw new Error(`Session log belongs to unexpected task ${observedThreadId}.`);
    }
  }
  if (event?.type !== "event_msg" || event.payload?.type !== "task_complete") return null;
  if (typeof event.payload.turn_id !== "string" || !event.payload.turn_id) {
    throw new Error("task_complete lacks a turn id.");
  }
  return {
    recordedAt: event.timestamp,
    reportedCompletedAt: typeof event.payload.completed_at === "number"
      ? new Date(event.payload.completed_at * 1_000).toISOString() : null,
    turnId: event.payload.turn_id,
  };
}

async function fetchJson(url, secret, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-exp0036-attempt-secret": secret,
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Collector HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTerminal(sessionLogPath, threadId, timeoutMs) {
  const started = Date.now();
  let offset = 0;
  let remainder = "";
  let wake;
  let watcher;

  const changed = () => new Promise((resolve) => {
    wake = resolve;
    const remaining = Math.max(1, timeoutMs - (Date.now() - started));
    setTimeout(resolve, Math.min(remaining, 250));
  });

  try {
    watcher = watch(sessionLogPath, () => wake?.());
    while (Date.now() - started < timeoutMs) {
      const size = (await stat(sessionLogPath)).size;
      if (size > offset) {
        const bytes = await readFile(sessionLogPath);
        const addition = bytes.subarray(offset).toString("utf8");
        offset = bytes.length;
        const lines = `${remainder}${addition}`.split("\n");
        remainder = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const terminal = terminalEvent(line, threadId);
          if (terminal) return { ...terminal, detectedAt: new Date().toISOString() };
        }
      }
      await changed();
    }
  } finally {
    watcher?.close();
  }
  throw new Error(`Timed out waiting for task_complete in ${sessionLogPath}.`);
}

export async function watchExp0036Terminal(options) {
  const sessionLogPath = path.resolve(options.sessionLogPath);
  const launchPath = path.resolve(options.launchPath);
  const outputPath = path.resolve(options.outputPath);
  const timeoutMs = positiveInteger(options.timeoutMs, 15 * 60_000, "timeoutMs");
  const sealTimeoutMs = positiveInteger(options.sealTimeoutMs, 30_000, "sealTimeoutMs");
  const statusPollMs = positiveInteger(options.statusPollMs, 25, "statusPollMs");
  if (typeof options.threadId !== "string" || !options.threadId) throw new Error("threadId is required.");

  const launchBytes = await readFile(launchPath);
  const launch = JSON.parse(launchBytes.toString("utf8"));
  const closeUrl = launch?.collector?.closeUrl;
  const statusUrl = launch?.collector?.statusUrl;
  const secret = launch?.collector?.secret;
  if (![closeUrl, statusUrl, secret].every((value) => typeof value === "string" && value)) {
    throw new Error("Launch receipt lacks collector control fields.");
  }

  const armedAt = new Date().toISOString();
  const terminal = await waitForTerminal(sessionLogPath, options.threadId, timeoutMs);
  const closeRequestedAt = new Date().toISOString();
  const terminalReference = `${options.threadId}:${terminal.turnId}`;
  const closeResponse = await fetchJson(closeUrl, secret, {
    method: "POST",
    body: JSON.stringify({ taskTerminal: true, terminalReference }),
  });
  const closeRespondedAt = new Date().toISOString();

  const sealDeadline = Date.now() + sealTimeoutMs;
  let statusResponse;
  do {
    statusResponse = await fetchJson(statusUrl, secret);
    if (statusResponse?.receipt?.seal?.complete === true) break;
    await delay(statusPollMs);
  } while (Date.now() < sealDeadline);

  const result = {
    schemaVersion: "jazzboard-exp0036-terminal-watcher/v1",
    threadId: options.threadId,
    turnId: terminal.turnId,
    terminalReference,
    armedAt,
    terminalRecordedAt: terminal.recordedAt,
    taskCompletedAt: terminal.recordedAt,
    taskReportedCompletedAt: terminal.reportedCompletedAt,
    terminalDetectedAt: terminal.detectedAt,
    closeRequestedAt,
    closeRespondedAt,
    detectionLatencyMs: Date.parse(terminal.detectedAt) - Date.parse(terminal.recordedAt),
    closeRequestLatencyMs: Date.parse(closeRequestedAt) - Date.parse(terminal.detectedAt),
    taskCompleteToCloseRequestMs: Date.parse(closeRequestedAt) - Date.parse(terminal.recordedAt),
    launchReceiptSha256: sha256(launchBytes),
    closeAccepted: closeResponse?.ok === true,
    receipt: statusResponse?.receipt ?? null,
    sealed: statusResponse?.receipt?.seal?.complete === true,
  };
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8", mode: 0o600, flag: "wx",
  });
  return result;
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  if (!values["session-log"] || !values.launch || !values["thread-id"] || !values.output) {
    throw new Error("Usage: exp0036-terminal-watcher.mjs --session-log PATH --launch PATH --thread-id ID --output PATH [--timeout-ms N] [--seal-timeout-ms N]");
  }
  const result = await watchExp0036Terminal({
    sessionLogPath: values["session-log"],
    launchPath: values.launch,
    threadId: values["thread-id"],
    outputPath: values.output,
    timeoutMs: values["timeout-ms"],
    sealTimeoutMs: values["seal-timeout-ms"],
    statusPollMs: values["status-poll-ms"],
  });
  console.log(JSON.stringify({
    output: path.resolve(values.output),
    terminalDetectedAt: result.terminalDetectedAt,
    closeRequestedAt: result.closeRequestedAt,
    detectionLatencyMs: result.detectionLatencyMs,
    closeRequestLatencyMs: result.closeRequestLatencyMs,
    sealed: result.sealed,
  }));
  if (!result.sealed) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
