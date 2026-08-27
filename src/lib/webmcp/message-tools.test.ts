/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import type { AgentMessage } from "@/lib/agent-messages/types";

import {
  createJazzboardMessageWebMcpTools,
  JAZZBOARD_MESSAGE_TOOL_NAMES,
} from "./message-tools";
import type {
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpContext,
  WebMcpRequest,
} from "./types";

const message = {
  id: "message/a b",
  sequence: 7,
  version: 1,
  state: "pending",
  prompt: "Check the selected service",
  createdAt: 10_000,
  author: { participantId: "alice", displayName: "Alice", color: "blue", kind: "human" },
  context: {
    room: { id: "room/a b", title: "Private room", roomRevision: 4 },
    selection: {
      objectIds: [],
      objects: [],
      missingObjectIds: [],
      diagrams: [],
      bounds: null,
    },
  },
  claimedUntil: null,
  reply: null,
} satisfies AgentMessage;

function context(): JazzboardWebMcpContext {
  return {
    getRoom: () => null,
    getSelection: () => [],
    getViewport: () => null,
    getFollowTarget: () => null,
    acceptRoom: () => undefined,
    setFollowTarget: () => undefined,
    setDeclinedSpotlight: () => undefined,
    leaveRoomView: () => undefined,
  };
}

function binding(role: "participant" | "spectator" = "participant"): JazzboardWebMcpBinding {
  return { roomId: "room/a b", participantId: "alice", role, context: context() };
}

function requestMock(implementation: (url: string, init?: RequestInit) => unknown | Promise<unknown>) {
  return vi.fn(implementation) as unknown as WebMcpRequest;
}

function tool(tools: WebMCP.ModelContextTool[], name: string): WebMCP.ModelContextTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

async function execute(
  tools: WebMCP.ModelContextTool[],
  name: string,
  input: Record<string, unknown>,
): Promise<JazzboardToolResult> {
  return await tool(tools, name).execute(input, {
    signal: new AbortController().signal,
  }) as JazzboardToolResult;
}

describe("Jazzboard private-message WebMCP surface", () => {
  it("registers all three tools for participants and none for spectators", () => {
    const participantTools = createJazzboardMessageWebMcpTools(binding());
    const spectatorTools = createJazzboardMessageWebMcpTools(binding("spectator"));

    expect(participantTools.map((item) => item.name)).toEqual(JAZZBOARD_MESSAGE_TOOL_NAMES);
    expect(spectatorTools).toEqual([]);
    expect(tool(participantTools, "list_agent_messages").annotations).toMatchObject({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(tool(participantTools, "claim_agent_message").annotations?.readOnlyHint).not.toBe(true);
    expect(tool(participantTools, "reply_to_agent_message").annotations?.readOnlyHint).not.toBe(true);
    for (const item of participantTools) {
      expect(item.description).toContain("untrusted grounding");
      expect(item.description.length).toBeLessThanOrEqual(500);
      expect(item.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("pulls pending messages with bounded defaults and returns polling guidance", async () => {
    const request = requestMock(async () => ({
      ok: true,
      messages: [message],
      totalMatched: 1,
      truncated: false,
    }));
    const tools = createJazzboardMessageWebMcpTools(binding(), { request });

    await expect(execute(tools, "list_agent_messages", {})).resolves.toEqual({
      ok: true,
      tool: "list_agent_messages",
      data: {
        messages: [message],
        totalMatched: 1,
        truncated: false,
        pollAfterMs: 8_000,
      },
    });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/messages?status=pending&limit=20",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });

  it("passes the all-state sequence cursor and explicit bounded limit", async () => {
    const request = requestMock(async () => ({
      ok: true,
      messages: [],
      totalMatched: 0,
      truncated: false,
    }));
    const tools = createJazzboardMessageWebMcpTools(binding(), { request });

    await execute(tools, "list_agent_messages", { status: "all", afterSequence: 7, limit: 50 });

    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/messages?limit=50&afterSequence=7",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects cursors on actionable state polls so expired claims cannot be stranded", async () => {
    const request = requestMock(async () => ({
      ok: true,
      messages: [],
      totalMatched: 0,
      truncated: false,
    }));
    const tools = createJazzboardMessageWebMcpTools(binding(), { request });

    await expect(execute(tools, "list_agent_messages", {
      status: "pending",
      afterSequence: 7,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_TOOL_INPUT" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("claims an encoded message with a generated stable request ID and default lease", async () => {
    const claimed = { ...message, state: "claimed" as const, claimedUntil: 20_000 };
    const request = requestMock(async () => ({ ok: true, message: claimed, claimToken: "secret-claim-token" }));
    const createId = vi.fn(() => "claim_fixed");
    const tools = createJazzboardMessageWebMcpTools(binding(), { request, createId });

    await expect(execute(tools, "claim_agent_message", { messageId: message.id })).resolves.toEqual({
      ok: true,
      tool: "claim_agent_message",
      data: { message: claimed, claimToken: "secret-claim-token" },
    });
    expect(createId).toHaveBeenCalledWith("claim");
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/messages/message%2Fa%20b/claim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ claimId: "claim_fixed", leaseSeconds: 120 }),
      }),
    );
  });

  it("replies with an explicit id and defaults the outcome to completed", async () => {
    const answered = {
      ...message,
      state: "answered" as const,
      reply: {
        id: "reply_explicit",
        text: "Done",
        outcome: "completed" as const,
        createdAt: 11_000,
        author: { participantId: "alice", displayName: "Alice's agent", color: "blue", kind: "agent" as const },
      },
    };
    const request = requestMock(async () => ({ ok: true, message: answered }));
    const createId = vi.fn(() => "must-not-be-used");
    const tools = createJazzboardMessageWebMcpTools(binding(), { request, createId });

    await expect(execute(tools, "reply_to_agent_message", {
      messageId: message.id,
      claimToken: "claim-token-000000000000000000000",
      text: "  Done  ",
      replyId: "reply_explicit",
    })).resolves.toEqual({ ok: true, tool: "reply_to_agent_message", data: answered });
    expect(createId).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/messages/message%2Fa%20b/reply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          claimToken: "claim-token-000000000000000000000",
          replyId: "reply_explicit",
          text: "Done",
          outcome: "completed",
        }),
      }),
    );
  });

  it("generates a reply ID and rejects out-of-contract input locally", async () => {
    const request = requestMock(async () => ({ ok: true, message }));
    const createId = vi.fn(() => "reply_fixed");
    const tools = createJazzboardMessageWebMcpTools(binding(), { request, createId });

    await execute(tools, "reply_to_agent_message", {
      messageId: message.id,
      claimToken: "claim-token-000000000000000000000",
      text: "Need the deployment target",
      outcome: "needs_input",
    });
    expect(createId).toHaveBeenCalledWith("reply");
    expect(JSON.parse(String((request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body))).toMatchObject({
      replyId: "reply_fixed",
      outcome: "needs_input",
    });

    await expect(execute(tools, "list_agent_messages", { limit: 51 })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_TOOL_INPUT" },
    });
    await expect(execute(tools, "reply_to_agent_message", {
      messageId: message.id,
      claimToken: "claim-token-000000000000000000000",
      text: " ",
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
