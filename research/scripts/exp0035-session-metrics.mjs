#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { summarizeCodexAuthorSessionJsonl } from "./analyze-codex-author-speed.mjs";

const READ_TOOLS = new Set([
  "find_diagrams",
  "query_objects",
  "read_canvas_drafts",
  "read_collaboration_state",
  "read_diagram",
  "read_neighborhood",
  "read_room_state",
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseJsonl(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Session JSONL must be non-empty.");
  return raw.trim().split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Session JSONL line ${index + 1} is not valid JSON.`);
    }
  });
}

function completedHostCall(event) {
  const outer = record(event);
  const payload = record(outer?.payload);
  const item = record(payload?.item);
  if (outer?.type !== "event_msg" || payload?.type !== "item_completed" || !item) return null;
  if (item.type !== "McpToolCall" && item.type !== "CommandExecution") return null;
  return { payload, item };
}

function hostToolIdentity(item) {
  if (item.type === "CommandExecution") return "commandExecution";
  const server = typeof item.server === "string" ? item.server : null;
  const tool = typeof item.tool === "string" ? item.tool : null;
  if (server && tool) return `${server}.${tool}`;
  return tool ?? server ?? "mcpToolCall";
}

function explicitErrorText(item) {
  const candidates = [item.error, item.errorMessage, item.failure, item.message];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    const candidateRecord = record(candidate);
    if (typeof candidateRecord?.message === "string" && candidateRecord.message.trim()) {
      return candidateRecord.message;
    }
  }
  return null;
}

function textFragments(value, seen = new Set()) {
  if (typeof value === "string") return [value];
  if (value === null || value === undefined || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((entry) => textFragments(entry, seen));

  const item = record(value);
  if (!item) return [];
  if (["Text", "text", "output_text"].includes(item.type) && typeof item.text === "string") {
    return [item.text];
  }

  const fragments = [];
  for (const key of ["content", "output", "result"]) {
    if (key in item) fragments.push(...textFragments(item[key], seen));
  }
  return fragments;
}

function hasTruncationEvidence(value, seen = new Set()) {
  if (typeof value === "string") {
    return /\[(?:output\s+)?truncated(?:\s+[^\]\r\n]*)?\]/i.test(value)
      || /<(?:output[-_\s]+)?truncated>/i.test(value)
      || /(?:^|\r?\n)\s*[…\.]*\s*truncated\s*[…\.]*\s*(?:\r?\n|$)/i.test(value);
  }
  if (value === null || value === undefined || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => hasTruncationEvidence(entry, seen));

  const item = record(value);
  if (!item) return false;
  const booleanFlags = [
    "truncated",
    "isTruncated",
    "is_truncated",
    "wasTruncated",
    "was_truncated",
    "outputTruncated",
    "output_truncated",
  ];
  if (booleanFlags.some((key) => item[key] === true)) return true;
  if (item.truncatedAt !== undefined || item.truncated_at !== undefined) return true;
  if (typeof item.truncation === "string" && item.truncation.length > 0) return true;
  if (record(item.truncation)) return true;
  return Object.values(item).some((entry) => hasTruncationEvidence(entry, seen));
}

function visibleHostOutput(item) {
  const canonicalField = "result" in item ? "result" : "output" in item ? "output" : null;
  if (!canonicalField) return { status: "unavailable", fragments: [], sourceField: null };
  const value = item[canonicalField];
  if (hasTruncationEvidence(value)) {
    return { status: "truncated", fragments: [], sourceField: canonicalField };
  }
  const fragments = textFragments(value);
  if (fragments.length === 0) return { status: "non_textual", fragments: [], sourceField: canonicalField };
  return { status: "observed", fragments, sourceField: canonicalField };
}

function nativeWebMcpMetadata(item) {
  const result = record(item.result);
  const meta = record(result?._meta);
  const toolSurface = record(meta?.["codex/toolSurface"]);
  if (!toolSurface || !("webMcpCalls" in toolSurface)) return { status: "absent", entries: [] };
  if (!Array.isArray(toolSurface.webMcpCalls)) return { status: "invalid", entries: [] };
  const entries = toolSurface.webMcpCalls.map((value) => record(value));
  if (entries.some((entry) => !entry || typeof entry.name !== "string")) {
    return { status: "invalid", entries: [] };
  }
  return { status: "observed", entries };
}

function retainedJsonMetric(value, truncated) {
  if (truncated === true) return { status: "truncated", utf8Bytes: null };
  if (typeof value !== "string") return { status: "unavailable", utf8Bytes: null };
  return { status: "complete", utf8Bytes: Buffer.byteLength(value, "utf8") };
}

function literalWebMcpNames(code) {
  if (typeof code !== "string") return [];
  const names = [];
  const pattern = /\.call\(\s*["'`]([A-Za-z0-9_]+)["'`]/g;
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) names.push(match[1]);
  return names;
}

function finalTextCandidate(event, turnId) {
  const outer = record(event);
  const payload = record(outer?.payload);
  if (!outer || !payload) return null;
  if (typeof payload.turn_id === "string" && payload.turn_id !== turnId) return null;

  if (outer.type === "event_msg" && payload.type === "agent_message") {
    if (payload.phase && !["final", "final_answer"].includes(payload.phase)) return null;
    if (typeof payload.message === "string") {
      return { text: payload.message, source: "event_msg.agent_message" };
    }
  }

  if (outer.type === "event_msg" && payload.type === "item_completed") {
    const item = record(payload.item);
    if (item?.type === "AgentMessage" && (!item.phase || ["final", "final_answer"].includes(item.phase))) {
      const fragments = textFragments(item.content ?? item.message ?? item.text);
      if (fragments.length) return { text: fragments.join(""), source: "event_msg.item_completed.AgentMessage" };
    }
  }

  if (outer.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
    if (!["final", "final_answer"].includes(payload.phase)) return null;
    const fragments = textFragments(payload.content);
    if (fragments.length) return { text: fragments.join(""), source: "response_item.message" };
  }
  return null;
}

function observedSessionId(records) {
  const values = new Set();
  for (const event of records) {
    const outer = record(event);
    const payload = record(outer?.payload);
    if (outer?.type !== "session_meta" || !payload) continue;
    for (const value of [payload.id, payload.thread_id, payload.threadId]) {
      if (typeof value === "string" && value) values.add(value);
    }
  }
  if (values.size > 1) throw new Error("Session JSONL contains conflicting session identifiers.");
  return [...values][0] ?? null;
}

/**
 * Summarize one retained Codex author-task JSONL without estimating nested WebMCP
 * calls, hidden response payloads, or token use.
 */
export function summarizeExp0035Session(raw, options = {}) {
  const records = parseJsonl(raw);
  const timeline = summarizeCodexAuthorSessionJsonl(raw, {
    attemptId: options.attemptId,
    threadId: options.threadId,
  });
  const sessionId = observedSessionId(records);
  if (sessionId && options.threadId && sessionId !== options.threadId) {
    throw new Error(`Observed session identifier ${sessionId} does not match --thread-id ${options.threadId}.`);
  }

  const hostCalls = records
    .map(completedHostCall)
    .filter((call) => call?.payload.turn_id === timeline.turnId);
  const byHostTool = {};
  const errors = [];
  const readOutputs = [];
  const nativeMetadataHostCalls = [];
  const nativeMetadataEntries = [];
  let readOutputUtf8Bytes = 0;

  hostCalls.forEach(({ item }, index) => {
    const hostTool = hostToolIdentity(item);
    byHostTool[hostTool] = (byHostTool[hostTool] ?? 0) + 1;
    const failed = item.status === "failed";
    if (failed) {
      const errorText = explicitErrorText(item);
      errors.push({
        hostCallOrdinal: index + 1,
        hostTool,
        status: item.status,
        errorTextStatus: errorText ? "observed" : "unavailable",
        ...(errorText ? { errorText } : {}),
      });
    }

    const nativeMetadata = nativeWebMcpMetadata(item);
    nativeMetadataHostCalls.push({
      hostCallOrdinal: index + 1,
      status: nativeMetadata.status,
      observedEntryCount: nativeMetadata.entries.length,
    });
    nativeMetadata.entries.forEach((entry, nativeIndex) => {
      nativeMetadataEntries.push({
        hostCallOrdinal: index + 1,
        nativeEntryOrdinal: nativeIndex + 1,
        name: entry.name,
        sourceHostname: typeof entry.sourceHostname === "string" ? entry.sourceHostname : null,
        input: retainedJsonMetric(entry.inputJson, entry.inputTruncated),
        output: retainedJsonMetric(entry.outputJson, entry.outputTruncated),
      });
    });

    const code = typeof item.arguments?.code === "string" ? item.arguments.code : "";
    const names = literalWebMcpNames(code);
    const uniqueNames = [...new Set(names)];
    if (uniqueNames.length !== 1 || !READ_TOOLS.has(uniqueNames[0])) return;
    const output = visibleHostOutput(item);
    const utf8Bytes = output.status === "observed"
      ? output.fragments.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0)
      : null;
    if (utf8Bytes !== null) readOutputUtf8Bytes += utf8Bytes;
    readOutputs.push({
      hostCallOrdinal: index + 1,
      readToolReferenced: uniqueNames[0],
      outputStatus: output.status,
      outputSourceField: output.sourceField,
      utf8Bytes,
    });
  });

  const finalCandidates = records.map((event) => finalTextCandidate(event, timeline.turnId)).filter(Boolean);
  const finalText = finalCandidates.at(-1) ?? null;
  const observedReadOutputs = readOutputs.filter((item) => item.outputStatus === "observed");
  const metadataByName = {};
  for (const entry of nativeMetadataEntries) metadataByName[entry.name] = (metadataByName[entry.name] ?? 0) + 1;
  const completeMetadataOutputs = nativeMetadataEntries.filter((entry) => entry.output.status === "complete");
  const metadataStatus = nativeMetadataHostCalls.some((item) => item.status === "invalid")
    ? "invalid_metadata_observed"
    : nativeMetadataEntries.length > 0
      ? "observed_without_completeness_signal"
      : "unavailable";

  return {
    schemaVersion: "jazzboard-exp0035-session-metrics/v1",
    attemptId: typeof options.attemptId === "string" ? options.attemptId : null,
    threadId: typeof options.threadId === "string" ? options.threadId : sessionId,
    turnId: timeline.turnId,
    status: timeline.status,
    finalText: finalText ? {
      status: "observed",
      source: finalText.source,
      utf8Bytes: Buffer.byteLength(finalText.text, "utf8"),
      text: finalText.text,
    } : {
      status: "unavailable",
      source: null,
      utf8Bytes: null,
      text: null,
    },
    timing: timeline.timing,
    hostCalls: {
      completedCount: hostCalls.length,
      failedCount: hostCalls.filter(({ item }) => item.status === "failed").length,
      byHostTool,
      errors,
    },
    webMcp: {
      runtimeCallCount: null,
      runtimeCallCountStatus: "unobservable_from_host_session",
      nativeMetadata: {
        status: metadataStatus,
        observedEntryCount: nativeMetadataEntries.length,
        observedHostCallCount: nativeMetadataHostCalls.filter((item) => item.status === "observed").length,
        byName: metadataByName,
        completeOutputCount: completeMetadataOutputs.length,
        completeOutputUtf8Bytes: completeMetadataOutputs.length > 0
          ? completeMetadataOutputs.reduce((total, entry) => total + entry.output.utf8Bytes, 0)
          : null,
        truncatedInputCount: nativeMetadataEntries.filter((entry) => entry.input.status === "truncated").length,
        truncatedOutputCount: nativeMetadataEntries.filter((entry) => entry.output.status === "truncated").length,
        hostCalls: nativeMetadataHostCalls,
        entries: nativeMetadataEntries,
      },
      readOutput: {
        status: observedReadOutputs.length > 0 ? "partially_observed" : "unavailable",
        observedHostCallCount: observedReadOutputs.length,
        observedUtf8Bytes: observedReadOutputs.length > 0 ? readOutputUtf8Bytes : null,
        hostCalls: readOutputs,
      },
    },
    observability: {
      hostCalls: "exact_completed_item_events",
      webMcpCalls: "Native tool-surface metadata entries are reported as observed entries, but runtimeCallCount stays null because the metadata provides no completeness or capping signal.",
      nativeOutputBytes: "Counts retained outputJson UTF-8 bytes only when the corresponding native metadata entry is not marked outputTruncated; this is additive evidence and not a complete-attempt byte total.",
      readOutputBytes: "Counts only the canonical result field (or output when result is absent) when complete textual host output is retained for a host call that references exactly one read tool; excludes structured-only, hidden, and explicitly truncated payloads.",
      exactTokens: "unobservable",
    },
  };
}

function parseArgs(argv) {
  let input = null;
  let attemptId = null;
  let threadId = null;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--input", "--attempt-id", "--thread-id"].includes(flag)) {
      throw new Error("Usage: exp0035-session-metrics.mjs --input /absolute/task.jsonl [--attempt-id ID] [--thread-id ID]");
    }
    if (flag === "--input") input = value;
    if (flag === "--attempt-id") attemptId = value;
    if (flag === "--thread-id") threadId = value;
  }
  if (!input) throw new Error("Usage: exp0035-session-metrics.mjs --input /absolute/task.jsonl [--attempt-id ID] [--thread-id ID]");
  return { inputPath: path.resolve(input), attemptId, threadId };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { inputPath, attemptId, threadId } = parseArgs(process.argv.slice(2));
    const summary = summarizeExp0035Session(readFileSync(inputPath, "utf8"), {
      attemptId: attemptId ?? path.basename(inputPath, path.extname(inputPath)),
      threadId,
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
