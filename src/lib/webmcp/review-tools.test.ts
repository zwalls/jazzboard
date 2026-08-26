/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import { agentEditProposalSummary } from "@/lib/domain/review";
import type { AgentEditProposal, AgentEditProposalSummary, RoomState } from "@/lib/domain/types";

import {
  createJazzboardReviewWebMcpTools,
  JAZZBOARD_REVIEW_READ_TOOL_NAMES,
  JAZZBOARD_REVIEW_TOOL_NAMES,
} from "./review-tools";
import type {
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpContext,
  WebMcpRequest,
} from "./types";

const proposal: AgentEditProposal = {
  id: "proposal/a b",
  roomId: "room/a b",
  revision: 1,
  status: "pending",
  createdAt: 10_000,
  updatedAt: 10_000,
  baselineRoomRevision: 7,
  author: { participantId: "alice", displayName: "Alice", color: "blue", kind: "agent" },
  intent: "Clarify the API",
  summary: "Rename the API node",
  purpose: {
    kind: "canvas_command",
    label: "Proposed: Updated 1 object",
    operationCount: 1,
    objectIds: ["api"],
    diagramIds: [],
    layout: null,
  },
  request: {
    kind: "canvas_command",
    command: {
      type: "update",
      objectId: "api",
      expectedRevision: 2,
      operation: "edit",
      patch: { content: "Room API" },
    },
  },
  review: null,
};
const proposalSummary = agentEditProposalSummary(proposal);

const room: RoomState = {
  id: "room/a b",
  code: "1234",
  title: "Review room",
  roomRevision: 8,
  createdAt: 1,
  updatedAt: 2,
  participants: {},
  objects: {},
  diagrams: {},
  leases: {},
  spotlight: null,
  agentEditPolicy: "review",
  reviewProposals: [proposal],
};

function contextFixture() {
  const accepted: RoomState[] = [];
  const context: JazzboardWebMcpContext = {
    getRoom: () => room,
    getSelection: () => [],
    getViewport: () => null,
    getFollowTarget: () => null,
    acceptRoom: (next) => accepted.push(next),
    setFollowTarget: () => undefined,
    setDeclinedSpotlight: () => undefined,
    leaveRoomView: () => undefined,
  };
  return { context, accepted };
}

function binding(context: JazzboardWebMcpContext, role: "participant" | "spectator" = "participant"): JazzboardWebMcpBinding {
  return { roomId: "room/a b", participantId: "alice", role, context };
}

function requestMock(implementation: (url: string, init?: RequestInit) => unknown | Promise<unknown>) {
  return vi.fn(implementation) as unknown as WebMcpRequest;
}

function toolByName(tools: WebMCP.ModelContextTool[], name: string): WebMCP.ModelContextTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

async function execute(tool: WebMCP.ModelContextTool, input: Record<string, unknown>): Promise<JazzboardToolResult> {
  return await tool.execute(input, { signal: new AbortController().signal }) as JazzboardToolResult;
}

describe("Jazzboard agent review WebMCP surface", () => {
  it("gives spectators authorized reads and gives participants only the one-way policy mutation", () => {
    const fixture = contextFixture();
    const participantTools = createJazzboardReviewWebMcpTools(binding(fixture.context));
    const spectatorTools = createJazzboardReviewWebMcpTools(binding(fixture.context, "spectator"));

    expect(participantTools.map((tool) => tool.name)).toEqual(JAZZBOARD_REVIEW_TOOL_NAMES);
    expect(spectatorTools.map((tool) => tool.name)).toEqual(JAZZBOARD_REVIEW_READ_TOOL_NAMES);
    expect(spectatorTools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    expect(participantTools.find((tool) => tool.name === "enable_agent_review")?.annotations?.readOnlyHint).not.toBe(true);
    expect(participantTools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["approve_agent_edit", "reject_agent_edit", "disable_agent_review"]),
    );
    for (const tool of participantTools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(100);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("lists concise proposals with semantic filters and no room-directory access", async () => {
    const fixture = contextFixture();
    const request = requestMock(async () => ({
      ok: true,
      policy: "review",
      proposals: [proposalSummary] satisfies AgentEditProposalSummary[],
      totalMatched: 3,
      truncated: true,
    }));
    const tools = createJazzboardReviewWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "list_agent_edit_proposals"), {
      limit: 1,
      status: "pending",
      authorParticipantId: "alice",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { policy: "review", proposals: [proposalSummary], totalMatched: 3, truncated: true },
    });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/review?limit=1&status=pending&authorParticipantId=alice",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });

  it("reads one exact request by encoded stable proposal ID", async () => {
    const fixture = contextFixture();
    const request = requestMock(async () => ({ ok: true, proposal }));
    const tools = createJazzboardReviewWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "read_agent_edit_proposal"), {
      proposalId: "proposal/a b",
    });

    expect(result).toEqual({ ok: true, tool: "read_agent_edit_proposal", data: proposal });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/review/proposal%2Fa%20b",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("can only post the review policy to the fixed agent route", async () => {
    const fixture = contextFixture();
    const responseRoom = { ...room, roomRevision: 9 };
    const request = requestMock(async () => ({
      ok: true,
      room: responseRoom,
      policy: "review",
      changed: true,
    }));
    const tools = createJazzboardReviewWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "enable_agent_review"), {});

    expect(result).toEqual({
      ok: true,
      tool: "enable_agent_review",
      data: { policy: "review", changed: true, roomRevision: 9 },
    });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/review/policy",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ policy: "review" }) }),
    );
    expect(fixture.accepted).toEqual([responseRoom]);
  });

  it("rejects unknown list input before making a request", async () => {
    const fixture = contextFixture();
    const request = requestMock(async () => ({ ok: true }));
    const tools = createJazzboardReviewWebMcpTools(binding(fixture.context), { request });

    await expect(execute(toolByName(tools, "list_agent_edit_proposals"), {
      limit: 10,
      roomId: "another-room",
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });
});
