/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import { JazzboardApiError } from "@/lib/client/api";
import type { FollowTarget, Participant, RoomState } from "@/lib/domain/types";

import {
  createJazzboardLifecycleWebMcpTools,
  JAZZBOARD_LIFECYCLE_READ_TOOL_NAMES,
  JAZZBOARD_LIFECYCLE_TOOL_NAMES,
} from "./lifecycle-tools";
import type {
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpContext,
  WebMcpRequest,
} from "./types";

const NOW = 20_000;

function participant(
  participantId: string,
  overrides: Partial<Participant> = {},
): Participant {
  const target = { cursor: null, viewport: null, lastSeenAt: NOW, activity: null };
  return {
    participantId,
    displayName: participantId === "alice" ? "Alice" : participantId === "bob" ? "Bob" : "Viewer",
    color: participantId === "alice" ? "#ef476f" : "#118ab2",
    role: "participant",
    joinedAt: NOW,
    lastSeenAt: NOW,
    connected: true,
    agentActive: participantId === "alice",
    human: structuredClone(target),
    agent: structuredClone(target),
    ...overrides,
  };
}

function room(overrides: Partial<RoomState> = {}): RoomState {
  return {
    id: "room/a b",
    code: "1234",
    title: "Architecture flow",
    roomRevision: 9,
    createdAt: NOW,
    updatedAt: NOW,
    participants: {
      alice: participant("alice"),
      bob: participant("bob", { agentActive: true }),
      viewer: participant("viewer", { role: "spectator", agentActive: false }),
    },
    objects: {},
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
    ...overrides,
  };
}

function contextFixture(initialRoom = room(), initialFollowTarget: FollowTarget = null) {
  let currentRoom: RoomState | null = initialRoom;
  let followTarget = initialFollowTarget;
  let declinedSpotlight: number | null = null;
  const accepted: RoomState[] = [];
  const leaveRoomView = vi.fn();
  const context: JazzboardWebMcpContext = {
    getRoom: () => currentRoom,
    getSelection: () => [],
    getViewport: () => null,
    getFollowTarget: () => followTarget,
    acceptRoom(nextRoom) {
      currentRoom = nextRoom;
      accepted.push(nextRoom);
    },
    setFollowTarget(target) {
      followTarget = target;
    },
    setDeclinedSpotlight(startedAt) {
      declinedSpotlight = startedAt;
    },
    leaveRoomView,
  };
  return {
    context,
    accepted,
    leaveRoomView,
    getFollowTarget: () => followTarget,
    getDeclinedSpotlight: () => declinedSpotlight,
  };
}

function binding(
  context: JazzboardWebMcpContext,
  role: "participant" | "spectator" = "participant",
): JazzboardWebMcpBinding {
  return {
    roomId: "room/a b",
    participantId: role === "participant" ? "alice" : "viewer",
    role,
    context,
  };
}

function requestMock(implementation: (url: string, init?: RequestInit) => unknown | Promise<unknown>) {
  return vi.fn(implementation) as unknown as WebMcpRequest;
}

function toolByName(tools: WebMCP.ModelContextTool[], name: string): WebMCP.ModelContextTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

async function execute(
  tool: WebMCP.ModelContextTool,
  input: Record<string, unknown> = {},
): Promise<JazzboardToolResult> {
  return (await tool.execute(input, { signal: new AbortController().signal })) as JazzboardToolResult;
}

function parsedBody(request: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  const init = request.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("Jazzboard collaboration WebMCP role surface", () => {
  it("registers the full lifecycle for participants and one strict read for spectators", () => {
    const participantFixture = contextFixture();
    const spectatorFixture = contextFixture();

    const participantTools = createJazzboardLifecycleWebMcpTools(binding(participantFixture.context));
    const spectatorTools = createJazzboardLifecycleWebMcpTools(binding(spectatorFixture.context, "spectator"));

    expect(participantTools.map((tool) => tool.name)).toEqual(JAZZBOARD_LIFECYCLE_TOOL_NAMES);
    expect(spectatorTools.map((tool) => tool.name)).toEqual(JAZZBOARD_LIFECYCLE_READ_TOOL_NAMES);
    expect(spectatorTools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    expect(spectatorTools.every((tool) => tool.annotations?.untrustedContentHint)).toBe(true);
  });

  it("gives every tool a semantic schema, title, and explanatory description", () => {
    const fixture = contextFixture();
    const tools = createJazzboardLifecycleWebMcpTools(binding(fixture.context));

    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(35);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });
});

describe("read_collaboration_state", () => {
  it("reads signed-session collaboration state without mutating presence", async () => {
    const fixture = contextFixture(room(), { participantId: "bob", kind: "agent" });
    const authoritative = room({ roomRevision: 10 });
    const request = requestMock(async () => ({ ok: true, room: authoritative, participantId: "alice" }));
    const tools = createJazzboardLifecycleWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "read_collaboration_state"));

    expect(result).toMatchObject({
      ok: true,
      tool: "read_collaboration_state",
      data: {
        room: {
          id: "room/a b",
          code: "1234",
          roomRevision: 10,
          stateRevision: 10,
          agentEditPolicy: "live",
          pendingAgentEditProposalCount: 0,
        },
        session: { participantId: "alice", role: "participant", agentActive: true },
        follow: {
          mode: "private",
          target: { participantId: "bob", kind: "agent", displayName: "Bob" },
        },
      },
    });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
    expect(fixture.accepted).toEqual([authoritative]);
  });
});

describe("private Follow lifecycle", () => {
  it("leaves an active Spotlight before following an exact private target", async () => {
    const spotlight = {
      presenterId: "bob",
      target: "human" as const,
      startedAt: NOW,
      autoFollowAt: NOW + 5_000,
      followingParticipantIds: ["alice", "bob"],
      handoffRequest: null,
    };
    const initial = room({ spotlight });
    const afterLeave = room({
      roomRevision: 10,
      spotlight: { ...spotlight, followingParticipantIds: ["bob"] },
    });
    const fixture = contextFixture(initial);
    const request = requestMock(async (_url, init) =>
      init?.method === "GET"
        ? { ok: true, room: initial }
        : { ok: true, room: afterLeave },
    );
    const tools = createJazzboardLifecycleWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "follow_participant"), {
      participantId: "bob",
      target: "agent",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        leftSpotlight: true,
        follow: { mode: "private", target: { participantId: "bob", kind: "agent" } },
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/rooms/room%2Fa%20b/agent/spotlight",
      expect.objectContaining({ method: "POST" }),
    );
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>, 1)).toEqual({ action: "leave" });
    expect(fixture.getFollowTarget()).toEqual({ participantId: "bob", kind: "agent" });
    expect(fixture.getDeclinedSpotlight()).toBe(NOW);
  });

  it("rejects unknown, spectator, inactive-agent, and self-human targets locally", async () => {
    const fixture = contextFixture();
    const authoritative = room({
      participants: {
        alice: participant("alice"),
        bob: participant("bob", { agentActive: false }),
        viewer: participant("viewer", { role: "spectator", agentActive: false }),
      },
    });
    const request = requestMock(async () => ({ ok: true, room: authoritative }));
    const tools = createJazzboardLifecycleWebMcpTools(binding(fixture.context), { request });
    const follow = toolByName(tools, "follow_participant");

    await expect(execute(follow, { participantId: "missing", target: "human" })).resolves.toMatchObject({
      ok: false,
      error: { code: "FOLLOW_TARGET_NOT_FOUND" },
    });
    await expect(execute(follow, { participantId: "viewer", target: "human" })).resolves.toMatchObject({
      ok: false,
      error: { code: "FOLLOW_TARGET_NOT_FOUND" },
    });
    await expect(execute(follow, { participantId: "bob", target: "agent" })).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_NOT_ACTIVE" },
    });
    await expect(execute(follow, { participantId: "alice", target: "human" })).resolves.toMatchObject({
      ok: false,
      error: { code: "SELF_FOLLOW_INVALID" },
    });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("stops a private follow without writing shared room state", async () => {
    const authoritative = room();
    const fixture = contextFixture(authoritative, { participantId: "bob", kind: "human" });
    const request = requestMock(async () => ({ ok: true, room: authoritative }));
    const tools = createJazzboardLifecycleWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "stop_following"));

    expect(result).toMatchObject({ ok: true, data: { stopped: true, leftSpotlight: false } });
    expect(request).toHaveBeenCalledTimes(1);
    expect((request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(fixture.getFollowTarget()).toBeNull();
  });
});

describe("Spotlight and room-view lifecycle", () => {
  it.each([
    ["start_spotlight", { target: "human" }, { action: "start", target: "human" }],
    ["request_spotlight", { target: "agent" }, { action: "request", target: "agent" }],
    ["stop_spotlight", {}, { action: "stop" }],
    ["join_spotlight", {}, { action: "join" }],
    ["leave_spotlight", {}, { action: "leave" }],
    ["approve_spotlight_handoff", {}, { action: "handoff" }],
    ["dismiss_spotlight_request", {}, { action: "dismiss_request" }],
  ] as const)("maps %s to the signed agent Spotlight endpoint", async (toolName, input, body) => {
    const activeSpotlight = {
      presenterId: "bob",
      target: "human" as const,
      startedAt: NOW,
      autoFollowAt: NOW + 5_000,
      followingParticipantIds: ["bob"],
      handoffRequest: null,
    };
    const responseRoom = room({ roomRevision: 10, spotlight: toolName === "stop_spotlight" ? null : activeSpotlight });
    const fixture = contextFixture();
    const request = requestMock(async () => ({ ok: true, room: responseRoom }));
    const tools = createJazzboardLifecycleWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, toolName), input);

    expect(result.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/spotlight",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>, 0)).toEqual(body);
    expect(fixture.accepted).toEqual([responseRoom]);
  });

  it("preserves signed-session errors as structured tool failures", async () => {
    const fixture = contextFixture();
    const request = requestMock(async () => {
      throw new JazzboardApiError(403, {
        code: "FORBIDDEN",
        message: "Only the current presenter can stop Spotlight.",
      });
    });
    const tools = createJazzboardLifecycleWebMcpTools(binding(fixture.context), { request });

    await expect(execute(toolByName(tools, "stop_spotlight"))).resolves.toMatchObject({
      ok: false,
      tool: "stop_spotlight",
      error: {
        code: "FORBIDDEN",
        message: "Only the current presenter can stop Spotlight.",
        recovery: {
          retry: "do_not_retry",
          instructions: expect.stringMatching(/do not bypass permissions.*human must grant/i),
        },
      },
    });
    expect(fixture.accepted).toEqual([]);
  });

  it("leaves only the browser room view and states that membership is retained", async () => {
    const fixture = contextFixture();
    const request = requestMock(async () => {
      throw new Error("leave_room must not call the server");
    });
    const tools = createJazzboardLifecycleWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "leave_room"));

    expect(result).toEqual({
      ok: true,
      tool: "leave_room",
      data: {
        leftRoomId: "room/a b",
        path: "/",
        membershipRetained: true,
        roomDeleted: false,
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(fixture.leaveRoomView).toHaveBeenCalledTimes(1);
  });
});
