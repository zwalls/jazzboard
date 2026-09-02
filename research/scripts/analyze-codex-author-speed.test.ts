// @vitest-environment node

import { describe, expect, it } from "vitest";

const modulePath: string = "./analyze-codex-author-speed.mjs";
const { summarizeCodexAuthorSessionJsonl, summarizeCodexAuthorThread } = await import(modulePath);

function thread(items: unknown[], durationMs = 100_000) {
  return {
    schemaVersion: 1,
    thread: { id: "thread_test" },
    turns: [{
      id: "turn_test",
      status: "completed",
      durationMs,
      items,
    }],
  };
}

function call(title: string, code: string, durationMs: number, status = "completed") {
  return {
    type: "mcpToolCall",
    tool: "js",
    arguments: { title, code },
    durationMs,
    status,
  };
}

describe("Codex author speed analysis", () => {
  it("separates declarative authoring, finish, inspection, and direct corrections", () => {
    const result = summarizeCodexAuthorThread(thread([
      call("Join", `await tools.call("join_room", {code:"ABC123"})`, 4_000),
      call("Discover", `await tools.call("get_canvas_capabilities", {bundle:"architecture"})`, 2_000),
      call("Draft", `await tools.call("apply_canvas_transaction", {delivery:{mode:"draft"},operations:[]})`, 3_000),
      call("Finish", `await tools.call("finish_canvas_draft", {action:"commit"})`, 7_000),
      call("Inspect", `await tools.call("inspect_canvas_scope", {}); await tab.screenshot()`, 5_000),
      call("Correct", `await tools.call("apply_canvas_transaction", {operations:[]})`, 3_000),
      call("Read", `await tools.call("read_room_state", {})`, 2_000),
    ]), { attemptId: "attempt_test" });

    expect(result).toMatchObject({
      schemaVersion: "jazzboard-codex-author-speed/v1",
      attemptId: "attempt_test",
      timing: {
        totalWallMs: 100_000,
        hostExecutionMs: 26_000,
        modelAndCoordinationMs: 74_000,
        hostExecutionShare: 0.26,
      },
      calls: {
        hostCallCount: 7,
        failedHostCallCount: 0,
        webMcpCallCount: 7,
      },
      phases: {
        room_entry: { hostCallCount: 1 },
        capability_discovery: { hostCallCount: 1 },
        initial_authoring: { hostCallCount: 1 },
        draft_finish: { hostCallCount: 1 },
        inspection: { hostCallCount: 1 },
        correction: { hostCallCount: 1 },
        state_read: { hostCallCount: 1 },
      },
    });
  });

  it("accepts a read_thread CallToolResult and retains failures without exposing prompts", () => {
    const exported = thread([
      call("Connect", "await browser.documentation()", 1_000, "failed"),
      call("Inspect", "await tab.screenshot()", 500),
    ], 10_000);
    const result = summarizeCodexAuthorThread({
      content: [{ type: "text", text: JSON.stringify(exported) }],
    });

    expect(result.calls.failedHostCallCount).toBe(1);
    expect(result.timing.modelAndCoordinationMs).toBe(8_500);
    expect(JSON.stringify(result)).not.toContain("browser.documentation");
  });

  it("fails closed for multiple turns or inconsistent timing", () => {
    const multiple = thread([], 10_000);
    multiple.turns.push({ id: "turn_other", status: "completed", durationMs: 1, items: [] });
    expect(() => summarizeCodexAuthorThread(multiple)).toThrow(/exactly one author turn/i);
    expect(() => summarizeCodexAuthorThread(thread([
      call("Slow", "", 11_000),
    ], 10_000))).toThrow(/exceeds author wall time/i);
  });

  it("attributes exact JSONL wall time to the next action phase without exposing content", () => {
    const events = [
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn_jsonl", started_at: 100 } },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn_jsonl",
          started_at_ms: 103_000,
          completed_at_ms: 104_000,
          item: {
            type: "McpToolCall",
            status: "completed",
            arguments: { title: "private title", code: `await tools.call("join_room", {code:"SECRET"})` },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn_jsonl",
          started_at_ms: 107_000,
          completed_at_ms: 109_000,
          item: {
            type: "McpToolCall",
            status: "completed",
            arguments: {
              title: "private draft",
              code: `await tools.call("apply_canvas_transaction", {delivery:{mode:"draft"},operations:[]})`,
            },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn_jsonl",
          started_at: 100,
          completed_at: 112,
          duration_ms: 12_000,
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n");

    const result = summarizeCodexAuthorSessionJsonl(events, {
      attemptId: "attempt_jsonl",
      threadId: "thread_jsonl",
    });

    expect(result).toMatchObject({
      schemaVersion: "jazzboard-codex-author-timeline/v1",
      attemptId: "attempt_jsonl",
      threadId: "thread_jsonl",
      timing: {
        totalWallMs: 12_000,
        accountedWallMs: 12_000,
        clockDeltaMs: 0,
        hostExecutionMs: 3_000,
        modelAndCoordinationMs: 9_000,
      },
      phases: {
        room_entry: {
          segmentWallMs: 4_000,
          modelAndCoordinationMs: 3_000,
          hostExecutionMs: 1_000,
        },
        initial_authoring: {
          segmentWallMs: 5_000,
          modelAndCoordinationMs: 3_000,
          hostExecutionMs: 2_000,
        },
        terminal: {
          segmentWallMs: 3_000,
          modelAndCoordinationMs: 3_000,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("private title");
  });

  it("fails closed when JSONL contains multiple task boundaries", () => {
    const events = [
      { type: "event_msg", payload: { type: "task_started", turn_id: "one", started_at: 1 } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "two", started_at: 2 } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "two", completed_at: 3, duration_ms: 1_000 } },
    ].map((event) => JSON.stringify(event)).join("\n");
    expect(() => summarizeCodexAuthorSessionJsonl(events)).toThrow(/exactly one started and completed/i);
  });
});
