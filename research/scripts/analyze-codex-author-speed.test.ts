// @vitest-environment node

import { describe, expect, it } from "vitest";

const modulePath: string = "./analyze-codex-author-speed.mjs";
const { summarizeCodexAuthorThread } = await import(modulePath);

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
});

