#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assembleExp0036AdmissionEvidence } from "./exp0036-run-evidence.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const LANDING_TOOLS = new Set([
  "create_room", "join_room", "list_recent_rooms", "open_recent_room", "remove_recent_room",
]);

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`Invalid EXP0036 admission-watcher argument ${argv[index] ?? ""}.`);
    }
    values[argv[index].slice(2)] = argv[index + 1];
  }
  return values;
}

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function receiptFrom(value) {
  return value?.body?.receipt ?? value?.receipt ?? value;
}

function ledgerFromReceipt(receipt) {
  if (!Array.isArray(receipt?.retrieval?.chunks)) return null;
  try {
    return JSON.parse(receipt.retrieval.chunks.map((chunk) => chunk.jsonFragment).join(""));
  } catch {
    return null;
  }
}

function admissionCalls(receipt) {
  const ledger = ledgerFromReceipt(receipt);
  const calls = ledger?.calls ?? [];
  const preJoin = calls.find((call) => call.sequence === 1 && call.toolName === "list_recent_rooms"
    && call.outcome === "success" && call.output?.status === "complete");
  const join = calls.find((call) => call.toolName === "join_room" && call.sequence > preJoin?.sequence
    && call.outcome === "success" && call.output?.status === "complete");
  const firstRoomTool = calls.find((call) => call.sequence > join?.sequence
    && !LANDING_TOOLS.has(call.toolName));
  if (firstRoomTool && (firstRoomTool.outcome !== "success" || firstRoomTool.output?.status !== "complete")) {
    throw new Error("The first natural room-tool invocation was not a successful complete capture.");
  }
  return preJoin && join && firstRoomTool ? { preJoin, join, firstRoomTool } : null;
}

async function fetchStatus(launch) {
  const response = await fetch(launch.collector.statusUrl, {
    headers: { "x-exp0036-attempt-secret": launch.collector.secret },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Collector status failed HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deriveTaskReceipt(sessionText, assignment, run, priorBrowserSessionIds, priorIdentityHashes) {
  const records = sessionText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const session = records.find((record) => record.type === "session_meta")?.payload;
  const started = records.find((record) => record.type === "event_msg"
    && record.payload?.type === "task_started");
  const opened = records.find((record) => {
    const item = record.type === "event_msg" && record.payload?.type === "item_completed"
      ? record.payload.item : null;
    return item?.type === "McpToolCall" && item.server === "cua_repl" && item.tool === "js"
      && item.status === "completed" && item.result?.isError === false
      && item.arguments?.code?.includes("createBrowserTab")
      && item.arguments.code.includes(assignment.origin);
  });
  const browserId = opened?.payload?.item?.result?._meta?.["codex/toolSurface"]?.browserId;
  const openTabIds = opened?.payload?.item?.result?._meta?.["codex/toolSurface"]?.openTabIds;
  const tabId = Array.isArray(openTabIds) && openTabIds.length === 1 ? openTabIds[0] : null;
  const threadId = session?.session_id;
  if (![threadId, browserId, tabId, started?.timestamp].every((value) => typeof value === "string" && value)) {
    return null;
  }
  const browserSessionId = `cua:iab:${threadId}:browser:${browserId}:tab:${tabId}`;
  const ordinal = run.assignments.findIndex((candidate) => candidate.attemptId === assignment.attemptId);
  const priorTaskIds = run.assignments.slice(0, ordinal)
    .map((candidate) => candidate.authorThreadId).filter(Boolean);
  return {
    schemaVersion: "jazzboard-exp0036-task-receipt/v2",
    taskId: threadId,
    browserSessionId,
    target: "projectless",
    history: "fresh",
    priorCompletedTurnCount: records.filter((record) => record.type === "event_msg"
      && record.payload?.type === "task_complete"
      && Date.parse(record.timestamp) < Date.parse(started.timestamp)).length,
    startedAt: started.timestamp,
    originFirstUse: run.assignments.slice(0, ordinal).every((candidate) => candidate.origin !== assignment.origin),
    loadedThroughCua: true,
    priorTaskIds,
    priorBrowserSessionIds,
    priorSessionIdentitySha256s: priorIdentityHashes,
    source: {
      sessionId: threadId,
      threadSource: session.thread_source,
      originator: session.originator,
      cuaProvider: "iab",
      browserId,
      tabId,
      createBrowserTabCompletedAt: opened.timestamp,
    },
  };
}

async function waitForTaskReceipt(config, assignment, run, deadline, pollMs) {
  const priorBrowserSessionIds = [];
  for (const priorPath of config.priorSessionLogPaths ?? []) {
    const priorText = await readFile(path.resolve(priorPath), "utf8");
    const priorSession = priorText.split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .find((record) => record.type === "session_meta")?.payload?.session_id;
    const priorAssignment = run.assignments.find((candidate) => candidate.authorThreadId === priorSession);
    const receipt = priorAssignment
      ? deriveTaskReceipt(priorText, priorAssignment, run, [], []) : null;
    if (!receipt) throw new Error(`Prior session log lacks completed CUA creation metadata: ${priorPath}`);
    priorBrowserSessionIds.push(receipt.browserSessionId);
  }
  do {
    try {
      const sessionText = await readFile(path.resolve(config.sessionLogPath), "utf8");
      const receipt = deriveTaskReceipt(
        sessionText,
        assignment,
        run,
        priorBrowserSessionIds,
        config.priorSessionIdentitySha256s ?? [],
      );
      if (receipt) return receipt;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(pollMs);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for completed CUA browser creation metadata.");
}

async function writeNew(filePath, value) {
  await writeFile(path.resolve(filePath), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8", mode: 0o600, flag: "wx",
  });
}

async function readIfExists(filePath) {
  try {
    return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function captureAdmissionSnapshot(config, assignment) {
  const privateEvidence = JSON.parse(await readFile(path.resolve(config.controllerPrivatePath), "utf8"));
  const controllerOrigin = `http://127.0.0.1:${assignment.port}`;
  const roomId = assignment.roomId ?? privateEvidence?.beforeRoom?.id;
  if (privateEvidence?.assignment?.attemptId !== config.attemptId
      || privateEvidence?.controllerOrigin !== controllerOrigin
      || typeof privateEvidence?.controllerCookie !== "string"
      || typeof roomId !== "string"
      || privateEvidence?.beforeRoom?.id !== roomId) {
    throw new Error("Private controller evidence does not match the admission attempt.");
  }
  const response = await fetch(
    new URL(`/api/rooms/${encodeURIComponent(roomId)}`, controllerOrigin),
    {
      headers: {
        cookie: privateEvidence.controllerCookie,
        "x-jazzboard-client-capabilities": "split-state-v1",
      },
      cache: "no-store",
    },
  );
  const body = await response.json();
  if (!response.ok || body?.ok !== true || body?.room?.id !== roomId) {
    throw new Error(`Admission room snapshot failed HTTP ${response.status}.`);
  }
  return body.room;
}

export async function watchExp0036Admission(config) {
  const launch = JSON.parse(await readFile(path.resolve(config.launchPath), "utf8"));
  const run = JSON.parse(await readFile(path.resolve(config.runPath), "utf8"));
  const assignment = run.assignments?.find((candidate) => candidate.attemptId === config.attemptId);
  if (!assignment) throw new Error(`Run ledger has no assignment ${config.attemptId}.`);
  if (launch.attemptId !== config.attemptId || launch.appOrigin !== assignment.origin) {
    throw new Error("Launch receipt does not match the admission attempt.");
  }
  const timeoutMs = positiveInteger(config.timeoutMs, 15 * 60_000, "timeoutMs");
  const pollMs = positiveInteger(config.pollMs, 25, "pollMs");
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  const taskReceipt = await waitForTaskReceipt(config, assignment, run, deadline, pollMs);
  const existingTaskReceipt = await readIfExists(config.taskReceiptPath);
  if (existingTaskReceipt && canonical(existingTaskReceipt) !== canonical(taskReceipt)) {
    throw new Error("Existing task receipt differs from live session metadata.");
  }
  if (!existingTaskReceipt) await writeNew(config.taskReceiptPath, taskReceipt);
  let collectorResponse = await readIfExists(config.collectorReceiptPath);
  let calls = collectorResponse ? admissionCalls(receiptFrom(collectorResponse)) : null;
  while (!calls && Date.now() < deadline) {
    collectorResponse = await fetchStatus(launch);
    calls = admissionCalls(receiptFrom(collectorResponse));
    if (!calls) await delay(pollMs);
  }
  if (!calls) throw new Error("Timed out waiting for ordered native admission calls.");

  const callsObservedAt = new Date().toISOString();
  if (!await readIfExists(config.collectorReceiptPath)) {
    await writeNew(config.collectorReceiptPath, collectorResponse);
  }
  const afterRoomPath = config.afterRoomPath
    ?? path.join(assignment.outputDirectory, ".private", "admission-after.json");
  let afterRoom = await readIfExists(afterRoomPath);
  let snapshotReceipt = await readIfExists(config.snapshotReceiptPath);
  if (Boolean(afterRoom) !== Boolean(snapshotReceipt)) {
    throw new Error("Admission snapshot artifacts are only partially present.");
  }
  if (!afterRoom) {
    const snapshotRequestedAt = new Date().toISOString();
    afterRoom = await captureAdmissionSnapshot(config, assignment);
    const snapshotRespondedAt = new Date().toISOString();
    await writeNew(afterRoomPath, afterRoom);
    snapshotReceipt = {
      requestedAt: snapshotRequestedAt,
      respondedAt: snapshotRespondedAt,
      command: {
        ok: true,
        command: "admission_snapshot",
        attemptId: config.attemptId,
        snapshotPath: path.resolve(afterRoomPath),
        roomRevision: afterRoom.roomRevision,
        afterRoomSha256: sha256(canonical(afterRoom)),
      },
    };
    await writeNew(config.snapshotReceiptPath, snapshotReceipt);
  }

  const result = await assembleExp0036AdmissionEvidence({
    ...config,
    hostAvailabilityPath: undefined,
    afterRoomPath,
  });
  result.admissionWatch = {
    schemaVersion: "jazzboard-exp0036-admission-watcher/v1",
    startedAt,
    callsObservedAt,
    snapshotRequestedAt: snapshotReceipt.requestedAt,
    snapshotRespondedAt: snapshotReceipt.respondedAt,
    invocationSequences: [calls.preJoin.sequence, calls.join.sequence, calls.firstRoomTool.sequence],
    hostAvailabilityDerivedFromAuthorNativeTrace: true,
  };
  await writeNew(config.outputPath, result);
  return result;
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  if (!values.config) throw new Error("Usage: exp0036-admission-watcher.mjs --config /absolute/config.json");
  const config = JSON.parse(await readFile(path.resolve(values.config), "utf8"));
  const result = await watchExp0036Admission(config);
  console.log(JSON.stringify({
    output: path.resolve(config.outputPath),
    decision: result.decision.decision,
    callsObservedAt: result.admissionWatch.callsObservedAt,
    snapshotRespondedAt: result.admissionWatch.snapshotRespondedAt,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
