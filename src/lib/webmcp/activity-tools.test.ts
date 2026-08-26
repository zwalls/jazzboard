/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import type { RoomActivitySummary, RoomState } from "@/lib/domain/types";

import {
  createJazzboardActivityWebMcpTools,
  JAZZBOARD_ACTIVITY_READ_TOOL_NAMES,
  JAZZBOARD_ACTIVITY_TOOL_NAMES,
} from "./activity-tools";
import type {
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpContext,
  WebMcpRequest,
} from "./types";

const activity: RoomActivitySummary = {
  id: "activity/a b",
  roomId: "room/a b",
  roomRevision: 8,
  occurredAt: 10_000,
  actor: { participantId: "alice", displayName: "Alice", color: "blue", kind: "agent" },
  action: "canvas.update",
  label: "Updated 1 object",
  intent: "Clarify the API",
  summary: "Renamed the API node",
  affectedObjectIds: ["api"],
  affectedDiagramIds: ["system"],
  affectedBounds: { x: 10, y: 20, width: 200, height: 100 },
  objectGuards: { api: { state: "present", revision: 2 } },
  diagramGuards: { system: { state: "present", revision: 4 } },
  revertsActivityId: null,
};

const room: RoomState = {
  id: "room/a b",
  code: "1234",
  title: "Review room",
  roomRevision: 9,
  createdAt: 1,
  updatedAt: 2,
  participants: {},
  objects: {},
  diagrams: {},
  leases: {},
  spotlight: null,
  agentEditPolicy: "live",
  reviewProposals: [],
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

describe("Jazzboard activity WebMCP surface", () => {
  it("gives participants review and revert tools while spectators receive only strict reads", () => {
    const fixture = contextFixture();
    const participantTools = createJazzboardActivityWebMcpTools(binding(fixture.context));
    const spectatorTools = createJazzboardActivityWebMcpTools(binding(fixture.context, "spectator"));

    expect(participantTools.map((tool) => tool.name)).toEqual(JAZZBOARD_ACTIVITY_TOOL_NAMES);
    expect(spectatorTools.map((tool) => tool.name)).toEqual(JAZZBOARD_ACTIVITY_READ_TOOL_NAMES);
    expect(spectatorTools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    expect(participantTools.find((tool) => tool.name === "revert_activity")?.annotations?.readOnlyHint).not.toBe(true);
    for (const tool of participantTools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(100);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("lists bounded activity with semantic filters and no room-directory access", async () => {
    const fixture = contextFixture();
    const request = requestMock(async () => ({
      ok: true,
      activities: [activity],
      hasMore: true,
      nextBeforeRoomRevision: 8,
    }));
    const tools = createJazzboardActivityWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "list_activity"), {
      limit: 20,
      actorKind: "agent",
      objectId: "api",
      diagramId: "system",
      beforeRoomRevision: 10,
    });

    expect(result).toMatchObject({ ok: true, data: { activities: [activity], hasMore: true } });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/activity?limit=20&beforeRoomRevision=10&actorKind=agent&objectId=api&diagramId=system",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });

  it("reads one concise activity by its encoded stable ID", async () => {
    const fixture = contextFixture();
    const request = requestMock(async () => ({ ok: true, activity }));
    const tools = createJazzboardActivityWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "read_activity"), { activityId: "activity/a b" });

    expect(result).toEqual({ ok: true, tool: "read_activity", data: activity });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/activity/activity%2Fa%20b",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("posts exact guards and optional intent to the agent-only compensating route", async () => {
    const fixture = contextFixture();
    const responseRoom = { ...room, roomRevision: 9 };
    const compensation = { ...activity, id: "activity-revert", action: "canvas.revert" as const, revertsActivityId: activity.id };
    const request = requestMock(async () => ({
      ok: true,
      room: responseRoom,
      changedObjectIds: ["api"],
      changedDiagramIds: ["system"],
      membershipObjectIds: [],
      outcome: "applied",
      activity: compensation,
      proposal: null,
    }));
    const tools = createJazzboardActivityWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "revert_activity"), {
      activityId: activity.id,
      objectExpectations: [{ objectId: "api", state: "present", expectedRevision: 2, leaseId: "lease-1" }],
      diagramExpectations: [{ diagramId: "system", state: "present", expectedRevision: 4 }],
      intent: "Undo the mistaken rename",
    });

    expect(result).toMatchObject({ ok: true, data: { roomRevision: 9, activity: compensation } });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/activity/activity%2Fa%20b/revert",
      expect.objectContaining({ method: "POST" }),
    );
    const init = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      objectExpectations: [{ objectId: "api", state: "present", expectedRevision: 2, leaseId: "lease-1" }],
      diagramExpectations: [{ diagramId: "system", state: "present", expectedRevision: 4 }],
      metadata: { intent: "Undo the mistaken rename" },
    });
    expect(fixture.accepted).toEqual([responseRoom]);
  });

  it("reports when a compensating revert is queued for human review", async () => {
    const fixture = contextFixture();
    const reviewRoom = { ...room, roomRevision: 10, agentEditPolicy: "review" as const };
    const proposal = {
      id: "proposal_revert",
      roomId: room.id,
      revision: 1,
      status: "pending" as const,
      createdAt: 12_000,
      updatedAt: 12_000,
      baselineRoomRevision: 9,
      author: activity.actor,
      intent: "Undo the mistaken rename",
      summary: null,
      purpose: {
        kind: "activity_revert" as const,
        label: "Revert activity",
        operationCount: 1,
        objectIds: ["api"],
        diagramIds: ["system"],
        layout: null,
      },
      review: null,
    };
    const request = requestMock(async () => ({
      ok: true,
      outcome: "proposed",
      room: reviewRoom,
      changedObjectIds: [],
      changedDiagramIds: [],
      membershipObjectIds: [],
      activity: null,
      proposal,
    }));
    const tools = createJazzboardActivityWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "revert_activity"), {
      activityId: activity.id,
      objectExpectations: [{ objectId: "api", state: "present", expectedRevision: 2 }],
      diagramExpectations: [{ diagramId: "system", state: "present", expectedRevision: 4 }],
      intent: "Undo the mistaken rename",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "proposed",
        changedObjectIds: [],
        activity: null,
        proposal: { id: "proposal_revert", status: "pending" },
      },
    });
    expect(fixture.accepted).toEqual([reviewRoom]);
  });

  it("rejects duplicate guards locally before making a request", async () => {
    const fixture = contextFixture();
    const request = requestMock(async () => ({ ok: true }));
    const tools = createJazzboardActivityWebMcpTools(binding(fixture.context), { request });

    await expect(execute(toolByName(tools, "revert_activity"), {
      activityId: activity.id,
      objectExpectations: [
        { objectId: "api", state: "present", expectedRevision: 2 },
        { objectId: "api", state: "present", expectedRevision: 2 },
      ],
      diagramExpectations: [],
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });
});
