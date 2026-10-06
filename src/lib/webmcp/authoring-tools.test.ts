import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it, vi } from "vitest";
import { createJazzboardRoomWebMcpTools } from "./registration";
import type { JazzboardToolResult, JazzboardWebMcpBinding, WebMcpRequest } from "./types";

function binding(role: "participant" | "spectator" = "participant"): JazzboardWebMcpBinding {
  return { roomId: "schema-test", participantId: "reader", role, context: {
    getRoom: () => null, getViewport: () => null, getSelection: () => [], getFollowTarget: () => null,
    acceptRoom: () => undefined, setFollowTarget: () => undefined, setDeclinedSpotlight: () => undefined, leaveRoomView: () => undefined,
  } };
}

async function discover(input: Record<string, unknown>, role: "participant" | "spectator" = "participant") {
  const request = vi.fn();
  const tools = createJazzboardRoomWebMcpTools(binding(role), { request: request as WebMcpRequest });
  const tool = tools.find((tool) => tool.name === "get_canvas_tool_schema")!;
  const result = await tool.execute(input, { signal: new AbortController().signal }) as JazzboardToolResult;
  expect(request).not.toHaveBeenCalled();
  return result;
}

describe("bounded runtime authoring schema discovery", () => {
  it.each(["create_node", "create_shape", "create_text"])("returns a runtime-validated standalone %s example", async (toolName) => {
    const result = await discover({ toolName });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { inputSchema: object; example: unknown; schemaSource: string };
    expect(data.schemaSource).toBe("runtime_validator");
    const validate = new Ajv2020({ strict: false }).compile(data.inputSchema);
    expect(validate(data.example), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...(data.example as object), unsupportedStyle: "red" })).toBe(false);
    expect(JSON.stringify(data).length).toBeLessThan(10_000);
  });

  it.each(["create_node", "create_shape", "create_text", "connect", "draw_connection", "update_object"])("returns exact %s fields with optional defaults", async (operation) => {
    const result = await discover({ toolName: "apply_canvas_transaction", operation });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { inputSchema: object; example: Record<string, unknown> };
    const validate = new Ajv2020({ strict: false }).compile(data.inputSchema);
    expect(validate(data.example), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ op: data.example.op })).toBe(false);
    expect(validate({ ...data.example, expectedRoomRevision: 2 })).toBe(false);
    if (operation === "create_node") {
      expect(validate({ ...data.example, fill: "url(javascript:x)" })).toBe(false);
      expect(validate({ ...data.example, nodeMetadata: { kind: "decision", arbitrary: true } })).toBe(false);
    }
    expect(JSON.stringify(data).length).toBeLessThan(12_000);
  });

  it("does not expose mutation contracts to a spectator or invent unavailable operations", async () => {
    expect(await discover({ toolName: "apply_canvas_transaction", operation: "create_node" }, "spectator")).toMatchObject({ ok: false });
    expect(await discover({ toolName: "apply_canvas_transaction", operation: "eval" })).toMatchObject({ ok: false });
    expect(await discover({ toolName: "create_node", operation: "create_text" })).toMatchObject({ ok: false });
    expect(await discover({ toolName: "get_canvas_tool_schema", arbitrary: true })).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
  });

  it("exposes exact inspection fields to both roles and rejects an invalid fit before network work", async () => {
    expect(await discover({ toolName: "query_objects" }, "spectator")).toMatchObject({ ok: true, data: { inputSchema: { properties: { detail: { enum: ["summary", "full", "compact"] }, measureText: { type: "boolean" } } } } });
    const request = vi.fn();
    const tools = createJazzboardRoomWebMcpTools(binding(), { request: request as WebMcpRequest });
    const text = tools.find((tool) => tool.name === "create_text")!;
    expect(await text.execute({ content: "hello", height: 100, fit: "content" }, { signal: new AbortController().signal })).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    const transaction = tools.find((tool) => tool.name === "apply_canvas_transaction")!;
    expect(await transaction.execute({ operations: [{ op: "create_text", tempRef: "t", content: "hello", height: 100, fit: "content" }] }, { signal: new AbortController().signal })).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });
});
