// @vitest-environment node

import { describe, expect, it } from "vitest";

const modulePath: string = "./exp0035-session-metrics.mjs";
const { summarizeExp0035Session } = await import(modulePath);

function jsonl(events: unknown[]) {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

function boundaries(extra: unknown[]) {
  return jsonl([
    { type: "session_meta", payload: { id: "thread_exp0035" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn_exp0035", started_at: 100 } },
    ...extra,
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn_exp0035",
        completed_at: 105,
        duration_ms: 5_000,
      },
    },
  ]);
}

function hostCall(item: Record<string, unknown>, startedAtMs: number, completedAtMs: number) {
  return {
    type: "event_msg",
    payload: {
      type: "item_completed",
      turn_id: "turn_exp0035",
      started_at_ms: startedAtMs,
      completed_at_ms: completedAtMs,
      item,
    },
  };
}

describe("EXP0035 retained-session metrics", () => {
  it("reports exact host events, final text, errors, and observed UTF-8 read output", () => {
    const readText = '{"objects":["Mira","café","🎷"]}';
    const raw = boundaries([
      hostCall({
        type: "McpToolCall",
        server: "cua_repl",
        tool: "js",
        status: "completed",
        arguments: { code: 'const result = await tools.call("query_objects", {owner:"Mira"}); nodeRepl.write(result);' },
        result: { content: [{ type: "text", text: readText }] },
      }, 101_000, 102_000),
      hostCall({
        type: "McpToolCall",
        server: "cua_repl",
        tool: "js",
        status: "failed",
        arguments: { code: "await tab.reload()" },
        error: { message: "Navigation failed" },
      }, 103_000, 104_000),
      {
        type: "event_msg",
        payload: {
          type: "agent_message",
          phase: "final",
          turn_id: "turn_exp0035",
          message: "Found 12 questions 🎷",
        },
      },
    ]);

    const result = summarizeExp0035Session(raw, {
      attemptId: "baseline-inventory-1",
      threadId: "thread_exp0035",
    });

    expect(result).toMatchObject({
      schemaVersion: "jazzboard-exp0035-session-metrics/v1",
      attemptId: "baseline-inventory-1",
      threadId: "thread_exp0035",
      turnId: "turn_exp0035",
      timing: { totalWallMs: 5_000, hostExecutionMs: 2_000 },
      finalText: { status: "observed", text: "Found 12 questions 🎷" },
      hostCalls: {
        completedCount: 2,
        failedCount: 1,
        byHostTool: { "cua_repl.js": 2 },
        errors: [{ errorTextStatus: "observed", errorText: "Navigation failed" }],
      },
      webMcp: {
        runtimeCallCount: null,
        runtimeCallCountStatus: "unobservable_from_host_session",
        readOutput: {
          status: "partially_observed",
          observedHostCallCount: 1,
          observedUtf8Bytes: Buffer.byteLength(readText, "utf8"),
        },
      },
    });
    expect(result.finalText.utf8Bytes).toBe(Buffer.byteLength("Found 12 questions 🎷", "utf8"));
  });

  it("does not turn a JavaScript loop into an inferred WebMCP runtime count", () => {
    const raw = boundaries([
      hostCall({
        type: "McpToolCall",
        status: "completed",
        arguments: {
          code: 'for (const page of pages) await tools.call("query_objects", page);',
        },
        result: { structuredContent: { pages: 10 } },
      }, 101_000, 102_000),
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final",
          content: [{ type: "output_text", text: "Complete" }],
        },
      },
    ]);

    const result = summarizeExp0035Session(raw);
    expect(result.webMcp.runtimeCallCount).toBeNull();
    expect(result.webMcp.readOutput).toMatchObject({
      status: "unavailable",
      observedHostCallCount: 0,
      observedUtf8Bytes: null,
      hostCalls: [{ outputStatus: "non_textual", utf8Bytes: null }],
    });
  });

  it("does not attribute mixed host output to a read tool", () => {
    const raw = boundaries([
      hostCall({
        type: "McpToolCall",
        status: "completed",
        arguments: {
          code: 'const before = await tools.call("read_room_state", {}); await tools.call("apply_canvas_transaction", {});',
        },
        result: { content: [{ type: "text", text: "mixed output" }] },
      }, 101_000, 102_000),
    ]);
    expect(summarizeExp0035Session(raw).webMcp.readOutput.hostCalls).toEqual([]);
  });

  it("excludes explicitly truncated read output from the byte total", () => {
    const raw = boundaries([
      hostCall({
        type: "McpToolCall",
        status: "completed",
        arguments: { code: 'await tools.call("read_room_state", {})' },
        result: {
          content: [{ type: "text", text: '{"objects":[1,2]}' }],
          _meta: { output_truncated: true },
        },
      }, 101_000, 102_000),
      hostCall({
        type: "McpToolCall",
        status: "completed",
        arguments: { code: 'await tools.call("query_objects", {})' },
        output: { content: [{ type: "text", text: "[output truncated after 1000 bytes]" }] },
      }, 103_000, 104_000),
    ]);

    expect(summarizeExp0035Session(raw).webMcp.readOutput).toMatchObject({
      status: "unavailable",
      observedHostCallCount: 0,
      observedUtf8Bytes: null,
      hostCalls: [
        { outputStatus: "truncated", outputSourceField: "result", utf8Bytes: null },
        { outputStatus: "truncated", outputSourceField: "output", utf8Bytes: null },
      ],
    });
  });

  it("uses result as the canonical output field when an output alias is also present", () => {
    const raw = boundaries([
      hostCall({
        type: "McpToolCall",
        status: "completed",
        arguments: { code: 'await tools.call("read_room_state", {})' },
        result: { content: [{ type: "text", text: "canonical" }] },
        output: { content: [{ type: "text", text: "duplicate alias" }] },
      }, 101_000, 102_000),
    ]);

    expect(summarizeExp0035Session(raw).webMcp.readOutput).toMatchObject({
      observedHostCallCount: 1,
      observedUtf8Bytes: Buffer.byteLength("canonical", "utf8"),
      hostCalls: [{ outputSourceField: "result" }],
    });
  });

  it("reports native WebMCP metadata entries without claiming a complete runtime count", () => {
    const raw = boundaries([
      hostCall({
        type: "McpToolCall",
        status: "completed",
        arguments: { code: 'for (const page of pages) await tools.call("query_objects", page)' },
        result: {
          content: [{ type: "text", text: "host output" }],
          _meta: {
            "codex/toolSurface": {
              webMcpCalls: [
                {
                  name: "query_objects",
                  sourceHostname: "127.0.0.1",
                  inputJson: '{"offset":0}',
                  outputJson: '{"objects":[1]}',
                },
                {
                  name: "query_objects",
                  sourceHostname: "127.0.0.1",
                  inputJson: '{"offset":1}',
                  outputJson: '{"objects":[2]}',
                  outputTruncated: true,
                },
              ],
            },
          },
        },
      }, 101_000, 102_000),
    ]);

    expect(summarizeExp0035Session(raw).webMcp).toMatchObject({
      runtimeCallCount: null,
      nativeMetadata: {
        status: "observed_without_completeness_signal",
        observedEntryCount: 2,
        observedHostCallCount: 1,
        byName: { query_objects: 2 },
        completeOutputCount: 1,
        completeOutputUtf8Bytes: Buffer.byteLength('{"objects":[1]}', "utf8"),
        truncatedInputCount: 0,
        truncatedOutputCount: 1,
        entries: [
          { name: "query_objects", output: { status: "complete" } },
          { name: "query_objects", output: { status: "truncated", utf8Bytes: null } },
        ],
      },
    });
  });

  it("recognizes the retained Codex final_answer AgentMessage shape", () => {
    const raw = boundaries([
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn_exp0035",
          started_at_ms: 104_500,
          completed_at_ms: 104_500,
          item: {
            type: "AgentMessage",
            phase: "final_answer",
            content: [{ type: "Text", text: "Authoritative final" }],
          },
        },
      },
    ]);

    expect(summarizeExp0035Session(raw).finalText).toMatchObject({
      status: "observed",
      source: "event_msg.item_completed.AgentMessage",
      text: "Authoritative final",
      utf8Bytes: Buffer.byteLength("Authoritative final", "utf8"),
    });
  });

  it("fails closed on an asserted thread mismatch", () => {
    expect(() => summarizeExp0035Session(boundaries([]), { threadId: "wrong_thread" }))
      .toThrow(/does not match --thread-id/i);
  });
});
