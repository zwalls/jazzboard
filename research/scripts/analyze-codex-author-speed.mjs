#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PHASES = [
  "room_entry",
  "capability_discovery",
  "initial_authoring",
  "draft_finish",
  "inspection",
  "correction",
  "state_read",
  "other",
];

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number.`);
  return value;
}

function extractThreadExport(value) {
  const direct = record(value);
  if (!direct) throw new Error("Thread export must be an object.");
  if (Array.isArray(direct.turns)) return direct;
  if (!Array.isArray(direct.content)) throw new Error("Input is neither a thread export nor a CallToolResult.");
  const text = direct.content
    .filter((item) => record(item)?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  if (!text) throw new Error("CallToolResult contains no text thread export.");
  return extractThreadExport(JSON.parse(text));
}

function parseSessionJsonl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Session JSONL must be a non-empty string.");
  }
  return value
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Session JSONL line ${index + 1} is not valid JSON.`);
      }
    });
}

function webMcpCalls(code) {
  if (typeof code !== "string") return [];
  const names = [];
  const pattern = /\.call\(\s*["'`]([A-Za-z0-9_]+)["'`]/g;
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) names.push(match[1]);
  return names;
}

function phaseFor(item, afterFinish) {
  if (item.type === "commandExecution") return "capability_discovery";
  const code = typeof item.arguments?.code === "string" ? item.arguments.code : "";
  const title = typeof item.arguments?.title === "string" ? item.arguments.title : "";
  const calls = webMcpCalls(code);
  const haystack = `${title}\n${code}`;

  if (calls.includes("finish_canvas_draft") || /finish_canvas_draft|commit the .*draft/i.test(haystack)) {
    return "draft_finish";
  }
  if (calls.includes("apply_canvas_transaction")) {
    const draftDelivery = /delivery\s*:\s*\{\s*mode\s*:\s*["'`]draft["'`]/s.test(code);
    return afterFinish && !draftDelivery ? "correction" : "initial_authoring";
  }
  if (
    calls.some((name) => ["inspect_canvas_scope", "render_canvas_preview", "analyze_diagram_layout"].includes(name)) ||
    /screenshot\s*\(|emitImage\s*\(|inspect.*pixel|visual qa|live canvas pixels/i.test(haystack)
  ) return "inspection";
  if (calls.some((name) => ["join_room", "create_room", "open_recent_room"].includes(name))) return "room_entry";
  if (
    calls.includes("get_canvas_capabilities") ||
    /documentation\s*\(|capabilities\.|fetchTools\s*\(|tool.*description|discover.*control|authoring guidance/i.test(haystack)
  ) return "capability_discovery";
  if (
    calls.some((name) => [
      "read_room_state",
      "read_diagram",
      "read_neighborhood",
      "query_objects",
      "read_canvas_drafts",
      "read_collaboration_state",
    ].includes(name)) || /read.*room|confirm.*revision/i.test(haystack)
  ) return "state_read";
  return "other";
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * probability) - 1));
  return sorted[index];
}

export function summarizeCodexAuthorThread(raw, options = {}) {
  const data = extractThreadExport(raw);
  const turns = data.turns.filter((turn) => record(turn));
  if (turns.length !== 1) throw new Error("Speed evidence must contain exactly one author turn.");
  const turn = turns[0];
  const totalWallMs = finiteNonNegative(turn.durationMs, "Turn duration");
  const items = Array.isArray(turn.items) ? turn.items : [];
  const calls = items.filter((item) => item?.type === "mcpToolCall" || item?.type === "commandExecution");
  const phaseMetrics = Object.fromEntries(PHASES.map((phase) => [phase, {
    hostCallCount: 0,
    failedHostCallCount: 0,
    hostExecutionMs: 0,
    webMcpCallCount: 0,
    webMcpTools: {},
  }]));
  let afterFinish = false;
  const durations = [];
  const allWebMcpTools = {};

  for (const item of calls) {
    const durationMs = finiteNonNegative(item.durationMs ?? 0, "Tool-call duration");
    durations.push(durationMs);
    const phase = phaseFor(item, afterFinish);
    const metric = phaseMetrics[phase];
    metric.hostCallCount += 1;
    metric.hostExecutionMs += durationMs;
    if (item.status === "failed") metric.failedHostCallCount += 1;
    const names = webMcpCalls(item.arguments?.code);
    metric.webMcpCallCount += names.length;
    for (const name of names) {
      metric.webMcpTools[name] = (metric.webMcpTools[name] ?? 0) + 1;
      allWebMcpTools[name] = (allWebMcpTools[name] ?? 0) + 1;
      if (name === "finish_canvas_draft") afterFinish = true;
    }
    if (phase === "draft_finish") afterFinish = true;
  }

  const hostExecutionMs = durations.reduce((total, duration) => total + duration, 0);
  if (hostExecutionMs > totalWallMs) throw new Error("Recorded tool execution exceeds author wall time.");
  const sortedDurations = [...durations].sort((left, right) => left - right);
  return {
    schemaVersion: "jazzboard-codex-author-speed/v1",
    attemptId: typeof options.attemptId === "string" ? options.attemptId : null,
    threadId: typeof data.thread?.id === "string" ? data.thread.id : null,
    turnId: typeof turn.id === "string" ? turn.id : null,
    status: typeof turn.status === "string" ? turn.status : "unknown",
    timing: {
      totalWallMs,
      hostExecutionMs,
      modelAndCoordinationMs: totalWallMs - hostExecutionMs,
      hostExecutionShare: totalWallMs === 0 ? 0 : hostExecutionMs / totalWallMs,
      medianHostCallMs: quantile(sortedDurations, 0.5),
      p95HostCallMs: quantile(sortedDurations, 0.95),
      maximumHostCallMs: sortedDurations.at(-1) ?? null,
    },
    calls: {
      hostCallCount: calls.length,
      failedHostCallCount: calls.filter((item) => item.status === "failed").length,
      webMcpCallCount: Object.values(allWebMcpTools).reduce((total, count) => total + count, 0),
      webMcpTools: allWebMcpTools,
    },
    phases: phaseMetrics,
    observability: {
      modelReasoningTime: "unobservable",
      exactTokens: "unobservable_unless_present_in_separate_task_usage_evidence",
      authoritativeCompletionMs: "requires_room_activity_evidence",
      presentationCompletionMs: "requires_live_presentation_evidence",
    },
  };
}

function normalizedSessionCall(event) {
  const payload = record(event)?.payload;
  const item = record(payload)?.item;
  if (record(event)?.type !== "event_msg" || payload?.type !== "item_completed" || !item) return null;
  if (item.type !== "McpToolCall" && item.type !== "CommandExecution") return null;
  const startedAtMs = finiteNonNegative(payload.started_at_ms, "Tool-call start");
  const completedAtMs = finiteNonNegative(payload.completed_at_ms, "Tool-call completion");
  if (completedAtMs < startedAtMs) throw new Error("Tool-call completion precedes its start.");
  return {
    turnId: typeof payload.turn_id === "string" ? payload.turn_id : null,
    startedAtMs,
    completedAtMs,
    item: {
      type: item.type === "McpToolCall" ? "mcpToolCall" : "commandExecution",
      arguments: record(item.arguments) ?? {},
      command: Array.isArray(item.command) ? item.command.join(" ") : "",
      status: typeof item.status === "string" ? item.status : "unknown",
      durationMs: completedAtMs - startedAtMs,
    },
  };
}

function epochSecondsToMs(value, label) {
  return finiteNonNegative(value, label) * 1000;
}

export function summarizeCodexAuthorSessionJsonl(raw, options = {}) {
  const records = parseSessionJsonl(raw);
  const starts = records.filter((event) => event?.type === "event_msg" && event.payload?.type === "task_started");
  const completions = records.filter((event) => event?.type === "event_msg" && event.payload?.type === "task_complete");
  if (starts.length !== 1 || completions.length !== 1) {
    throw new Error("Speed evidence must contain exactly one started and completed author turn.");
  }

  const start = starts[0].payload;
  const completion = completions[0].payload;
  if (start.turn_id !== completion.turn_id) throw new Error("Task start and completion turn IDs differ.");
  const taskStartedAtMs = epochSecondsToMs(start.started_at, "Task start");
  const taskCompletedAtMs = epochSecondsToMs(completion.completed_at, "Task completion");
  const totalWallMs = finiteNonNegative(completion.duration_ms, "Turn duration");
  if (taskCompletedAtMs < taskStartedAtMs) throw new Error("Task completion precedes its start.");

  const calls = records
    .map(normalizedSessionCall)
    .filter((call) => call?.turnId === start.turn_id)
    .sort((left, right) => left.startedAtMs - right.startedAtMs);
  const phaseMetrics = Object.fromEntries(PHASES.map((phase) => [phase, {
    segmentWallMs: 0,
    modelAndCoordinationMs: 0,
    hostExecutionMs: 0,
    hostCallCount: 0,
    failedHostCallCount: 0,
    webMcpCallCount: 0,
    webMcpTools: {},
  }]));
  phaseMetrics.terminal = {
    segmentWallMs: 0,
    modelAndCoordinationMs: 0,
    hostExecutionMs: 0,
    hostCallCount: 0,
    failedHostCallCount: 0,
    webMcpCallCount: 0,
    webMcpTools: {},
  };

  let cursorMs = taskStartedAtMs;
  let afterFinish = false;
  let hostExecutionMs = 0;
  const allWebMcpTools = {};
  const sequence = [];

  for (const call of calls) {
    if (call.startedAtMs < cursorMs) throw new Error("Tool calls overlap or are out of order.");
    const phase = phaseFor(call.item, afterFinish);
    const metric = phaseMetrics[phase];
    const leadInMs = call.startedAtMs - cursorMs;
    const callExecutionMs = call.completedAtMs - call.startedAtMs;
    metric.segmentWallMs += leadInMs + callExecutionMs;
    metric.modelAndCoordinationMs += leadInMs;
    metric.hostExecutionMs += callExecutionMs;
    metric.hostCallCount += 1;
    if (call.item.status === "failed") metric.failedHostCallCount += 1;
    const calledTools = webMcpCalls(call.item.arguments?.code);
    metric.webMcpCallCount += calledTools.length;
    for (const name of calledTools) {
      metric.webMcpTools[name] = (metric.webMcpTools[name] ?? 0) + 1;
      allWebMcpTools[name] = (allWebMcpTools[name] ?? 0) + 1;
      if (name === "finish_canvas_draft") afterFinish = true;
    }
    if (phase === "draft_finish") afterFinish = true;
    hostExecutionMs += callExecutionMs;
    sequence.push({
      phase,
      leadInMs,
      hostExecutionMs: callExecutionMs,
      segmentWallMs: leadInMs + callExecutionMs,
      failed: call.item.status === "failed",
      webMcpTools: calledTools,
    });
    cursorMs = call.completedAtMs;
  }

  if (cursorMs > taskCompletedAtMs) throw new Error("Recorded tool execution exceeds task completion.");
  const terminalMs = taskCompletedAtMs - cursorMs;
  phaseMetrics.terminal.segmentWallMs = terminalMs;
  phaseMetrics.terminal.modelAndCoordinationMs = terminalMs;
  const accountedWallMs = calls.length === 0
    ? terminalMs
    : sequence.reduce((total, item) => total + item.segmentWallMs, 0) + terminalMs;
  const clockDeltaMs = totalWallMs - accountedWallMs;

  return {
    schemaVersion: "jazzboard-codex-author-timeline/v1",
    attemptId: typeof options.attemptId === "string" ? options.attemptId : null,
    threadId: typeof options.threadId === "string" ? options.threadId : null,
    turnId: start.turn_id,
    status: "completed",
    timing: {
      totalWallMs,
      accountedWallMs,
      clockDeltaMs,
      hostExecutionMs,
      modelAndCoordinationMs: accountedWallMs - hostExecutionMs,
      hostExecutionShare: accountedWallMs === 0 ? 0 : hostExecutionMs / accountedWallMs,
    },
    calls: {
      hostCallCount: calls.length,
      failedHostCallCount: calls.filter((call) => call.item.status === "failed").length,
      webMcpCallCount: Object.values(allWebMcpTools).reduce((total, count) => total + count, 0),
      webMcpTools: allWebMcpTools,
    },
    phases: phaseMetrics,
    sequence,
    attribution: {
      method: "Time before each host call is assigned to the phase of that next call; post-call tail is terminal.",
      interpretation: "modelAndCoordinationMs includes all between-call latency and is not pure model reasoning time.",
    },
    observability: {
      modelReasoningTime: "unobservable",
      exactTokens: "unobservable_unless_present_in_separate_task_usage_evidence",
      authoritativeCompletionMs: "requires_room_activity_evidence",
      presentationCompletionMs: "requires_live_presentation_evidence",
    },
  };
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--input") {
    throw new Error("Usage: analyze-codex-author-speed.mjs --input /absolute/path/to/read-thread.json");
  }
  return path.resolve(argv[1]);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const inputPath = parseArgs(process.argv.slice(2));
    const input = readFileSync(inputPath, "utf8");
    const options = { attemptId: path.basename(inputPath, path.extname(inputPath)) };
    const summary = inputPath.endsWith(".jsonl")
      ? summarizeCodexAuthorSessionJsonl(input, options)
      : summarizeCodexAuthorThread(JSON.parse(input), options);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
