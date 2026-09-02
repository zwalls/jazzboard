/// <reference types="webmcp-types" />

import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";

import { JazzboardApiError } from "@/lib/client/api";
import type { ActorRef, CanvasObject, FollowTarget, Participant, RoomState, Viewport } from "@/lib/domain/types";

import {
  createJazzboardWebMcpTools,
  JAZZBOARD_WEBMCP_READ_TOOL_NAMES,
  JAZZBOARD_WEBMCP_TOOL_NAMES,
} from "./tools";
import { CONNECTOR_ROUTING_INPUT_JSON_SCHEMA } from "./routing-schema";
import type {
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpContext,
  WebMcpRequest,
} from "./types";

const NOW = 10_000;

function actor(participantId: string, kind: "human" | "agent" = "human"): ActorRef {
  return {
    participantId,
    displayName: participantId === "alice" ? "Alice" : "Bob",
    color: participantId === "alice" ? "#ef476f" : "#118ab2",
    kind,
  };
}

function participant(participantId: string): Participant {
  const target = { cursor: null, viewport: null, lastSeenAt: NOW, activity: null };
  return {
    participantId,
    displayName: participantId === "alice" ? "Alice" : "Bob",
    color: participantId === "alice" ? "#ef476f" : "#118ab2",
    role: "participant",
    joinedAt: NOW,
    lastSeenAt: NOW,
    connected: true,
    agentActive: participantId === "alice",
    human: structuredClone(target),
    agent: structuredClone(target),
  };
}

function object(id: string, x: number, y: number, revision = 1): CanvasObject {
  return {
    id,
    kind: "shape",
    x,
    y,
    width: 200,
    height: 100,
    rotation: 0,
    zIndex: id === "service-a" ? 2 : 3,
    revision,
    groupId: null,
    diagramIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor("alice"),
    lastEditedBy: actor("alice"),
    shape: "rectangle",
    nodeType: null,
    label: id,
    fill: "blue",
    stroke: "blue",
  };
}

function room(overrides: Partial<RoomState> = {}): RoomState {
  return {
    id: "room/a b",
    code: "1234",
    title: "Architecture",
    roomRevision: 9,
    createdAt: NOW,
    updatedAt: NOW,
    participants: { alice: participant("alice"), bob: participant("bob") },
    objects: {
      "service-a": object("service-a", 100, 200, 3),
      "service-b": object("service-b", 500, 400, 7),
    },
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
    ...overrides,
  };
}

function contextFixture(initialRoom = room(), selection: string[] = ["service-a"]) {
  let currentRoom: RoomState | null = initialRoom;
  let currentSelection = selection;
  let currentViewport: Viewport | null = { x: 0, y: 100, width: 1_000, height: 800, zoom: 1.25 };
  let currentFollowTarget: FollowTarget = null;
  const accepted: RoomState[] = [];
  const context: JazzboardWebMcpContext = {
    getRoom: () => currentRoom,
    getSelection: () => currentSelection,
    getViewport: () => currentViewport,
    getFollowTarget: () => currentFollowTarget,
    acceptRoom(nextRoom) {
      currentRoom = nextRoom;
      accepted.push(nextRoom);
    },
    setFollowTarget(target) {
      currentFollowTarget = target;
    },
    setDeclinedSpotlight: () => undefined,
    leaveRoomView: () => undefined,
  };
  return {
    context,
    accepted,
    setSelection(value: string[]) {
      currentSelection = value;
    },
    setViewport(value: Viewport | null) {
      currentViewport = value;
    },
  };
}

function binding(
  context: JazzboardWebMcpContext,
  role: "participant" | "spectator" = "participant",
): JazzboardWebMcpBinding {
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

async function execute(
  tool: WebMCP.ModelContextTool,
  input: Record<string, unknown>,
): Promise<JazzboardToolResult> {
  return (await tool.execute(input, { signal: new AbortController().signal })) as JazzboardToolResult;
}

function parsedBody(request: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = request.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("Jazzboard semantic WebMCP surface", () => {
  it("exposes the complete first-demo tool set for participants", () => {
    const fixture = contextFixture();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), {
      request: requestMock(async () => ({ ok: true, room: room() })),
    });

    expect(tools.map((tool) => tool.name)).toEqual(JAZZBOARD_WEBMCP_TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(30);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
      expect(tool.execute).toBeTypeOf("function");
    }
    for (const name of JAZZBOARD_WEBMCP_TOOL_NAMES.filter(
      (name) => !["focus_viewport"].includes(name),
    )) {
      expect(toolByName(tools, name).annotations?.untrustedContentHint).toBe(true);
    }
  });

  it("returns only truthful read tools for a spectator binding", () => {
    const fixture = contextFixture();
    const tools = createJazzboardWebMcpTools(binding(fixture.context, "spectator"));

    expect(tools.map((tool) => tool.name)).toEqual(JAZZBOARD_WEBMCP_READ_TOOL_NAMES);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    expect(tools.every((tool) => tool.annotations?.untrustedContentHint)).toBe(true);
  });

  it("advertises concise create/update endpoint and routing guidance", () => {
    const fixture = contextFixture();
    const tools = createJazzboardWebMcpTools(binding(fixture.context));
    const drawProperties = (toolByName(tools, "draw_connection").inputSchema as unknown as {
      properties?: Record<string, { description?: string; maxLength?: number }>;
    }).properties;
    expect(drawProperties?.routing?.description).toMatch(/auto\|straight\|curved\|elbow/);
    expect(drawProperties?.start?.description).toMatch(/objectId.*port/);
    for (const name of [
      "create_text",
      "create_shape",
      "create_node",
      "add_image",
      "create_drawing",
      "create_path",
      "create_polygon",
      "draw_connection",
    ]) {
      const properties = (toolByName(tools, name).inputSchema as {
        properties?: Record<string, unknown>;
      }).properties;
      expect(properties?.semanticName, name).toMatchObject({
        type: "string",
        minLength: 1,
        maxLength: 160,
      });
      expect(properties?.semanticRole, name).toMatchObject({
        type: "string",
        minLength: 1,
        maxLength: 128,
      });
    }
    const updateProperties = (toolByName(tools, "update_object").inputSchema as unknown as {
      properties?: { patch?: { properties?: Record<string, { description?: string }> } };
    }).properties?.patch?.properties;
    expect(updateProperties?.routing?.description).toMatch(/auto\/straight\/curved\/elbow/);
    expect(CONNECTOR_ROUTING_INPUT_JSON_SCHEMA.properties.mode.description).toContain(
      "delegates routing",
    );
    expect(updateProperties?.end?.description).toMatch(/attachment metadata is optional/);
    expect(updateProperties?.semanticName?.description).toMatch(/revise or clear/i);
    expect(updateProperties?.semanticRole?.description).toMatch(/revise or clear/i);

    const validatesUpdate = new Ajv({ allErrors: true, logger: false }).compile(
      toolByName(tools, "update_object").inputSchema as object,
    );
    expect(validatesUpdate({
      objectId: "path-a",
      expectedRevision: 2,
      patch: { fill: "none", color: "red", semanticName: null },
    })).toBe(true);
    expect(validatesUpdate({
      objectId: "path-a",
      expectedRevision: 2,
      patch: { fill: "chartreuse" },
    })).toBe(false);
  });
});

describe("authenticated read tools", () => {
  it("reads authoritative room state through signed-session GET without activating the agent", async () => {
    const fixture = contextFixture();
    const authoritative = room({ roomRevision: 10 });
    const request = requestMock(async () => ({ ok: true, room: authoritative }));
    const tools = createJazzboardWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "read_room_state"), { objectIds: ["service-a"] });

    expect(result).toMatchObject({
      ok: true,
      tool: "read_room_state",
      data: {
        room: {
          id: "room/a b",
          roomRevision: 10,
          selfParticipantId: "alice",
          agentEditPolicy: "live",
          pendingAgentEditProposalCount: 0,
        },
        objects: [{ id: "service-a", revision: 3 }],
        diagrams: [],
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
    expect(fixture.accepted).toEqual([authoritative]);
  });

  it("reads current local selection against fresh server objects", async () => {
    const fixture = contextFixture(room(), ["service-b", "deleted-object"]);
    const authoritative = room({ roomRevision: 11 });
    const request = requestMock(async () => ({ ok: true, room: authoritative }));
    const tools = createJazzboardWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "read_selection"), {});

    expect(result).toMatchObject({
      ok: true,
      data: {
        selectedObjectIds: ["service-b", "deleted-object"],
        objects: [{ id: "service-b", revision: 7 }],
        missingObjectIds: ["deleted-object"],
        roomRevision: 11,
      },
    });
  });

  it("returns a structured authorization error and does not accept room state on failed reads", async () => {
    const fixture = contextFixture();
    const request = requestMock(async () => {
      throw new JazzboardApiError(403, {
        code: "FORBIDDEN",
        message: "Spectators cannot change the canvas.",
        details: { role: "spectator" },
      });
    });
    const tools = createJazzboardWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "read_room_state"), {});

    expect(result).toMatchObject({
      ok: false,
      tool: "read_room_state",
      error: {
        code: "FORBIDDEN",
        message: "Spectators cannot change the canvas.",
        details: { role: "spectator" },
        recovery: {
          retry: "do_not_retry",
          instructions: expect.stringMatching(/do not bypass permissions.*human must grant/i),
        },
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(fixture.accepted).toEqual([]);
  });
});

describe("semantic mutation handlers", () => {
  function successfulRequest(responseRoom = room({ roomRevision: 10 })) {
    return requestMock(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { command: { type: string; object?: { id?: string } } };
      return {
        ok: true,
        room: responseRoom,
        changedObjectIds: body.command.object?.id ? [body.command.object.id] : ["service-a"],
        outcome: "applied",
        activity: null,
        proposal: null,
      };
    });
  }

  it("creates viewport-centered text without sending actor or role input", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), {
      request,
      createId: (prefix) => `${prefix}_fixed`,
    });

    const result = await execute(toolByName(tools, "create_text"), {
      content: "Replace synchronous fan-out",
      size: "l",
    });

    expect(result).toMatchObject({ ok: true, tool: "create_text" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/commands",
      expect.objectContaining({ method: "POST" }),
    );
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).toEqual({
      command: {
        type: "create",
        object: {
          id: "text_fixed",
          kind: "text",
          x: 340,
          y: 452,
          width: 320,
          height: 96,
          rotation: 0,
          zIndex: 4,
          groupId: null,
          content: "Replace synchronous fan-out",
          color: "black",
          size: "l",
          align: "start",
        },
      },
    });
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).not.toHaveProperty("actorKind");
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).not.toHaveProperty("role");
  });

  it("truthfully reports a review-mode proposal instead of claiming the edit was applied", async () => {
    const reviewRoom = room({ roomRevision: 10, agentEditPolicy: "review" });
    const proposal = {
      id: "proposal_1",
      roomId: reviewRoom.id,
      revision: 1,
      status: "pending" as const,
      createdAt: NOW,
      updatedAt: NOW,
      baselineRoomRevision: 9,
      author: actor("alice", "agent"),
      intent: null,
      summary: null,
      purpose: {
        kind: "canvas_command" as const,
        label: "Update service-a",
        operationCount: 1,
        objectIds: ["service-a"],
        diagramIds: [],
        layout: null,
      },
      review: null,
    };
    const fixture = contextFixture(reviewRoom);
    const request = requestMock(async () => ({
      ok: true,
      room: reviewRoom,
      changedObjectIds: [],
      outcome: "proposed",
      activity: null,
      proposal,
    }));
    const tools = createJazzboardWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "update_object"), {
      objectId: "service-a",
      expectedRevision: 3,
      patch: { label: "Proposed label" },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "proposed",
        changedObjectIds: [],
        objects: [],
        activity: null,
        proposal: { id: "proposal_1", status: "pending" },
      },
    });
    expect(toolByName(tools, "update_object").description).toContain("outcome `proposed`");
  });

  it.each([
    ["create_shape", { label: "Queue", shape: "diamond", x: 10, y: 20 }, "create"],
    ["create_node", { label: "API gateway", nodeType: "service", x: 10, y: 20 }, "create"],
    [
      "update_object",
      { objectId: "service-a", expectedRevision: 3, operation: "edit", patch: { label: "Gateway v2" } },
      "update",
    ],
    [
      "move_objects",
      { targets: [{ objectId: "service-a", expectedRevision: 3, x: 300, y: 400 }] },
      "move",
    ],
    [
      "group_objects",
      { targets: [{ objectId: "service-a", expectedRevision: 3 }] },
      "group",
    ],
    [
      "delete_objects",
      { targets: [{ objectId: "service-a", expectedRevision: 3 }] },
      "delete",
    ],
  ] as const)("maps %s to an authenticated %s command", async (toolName, input, commandType) => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), {
      request,
      createId: (prefix) => `${prefix}_fixed`,
    });

    const result = await execute(toolByName(tools, toolName), input);

    expect(result.ok).toBe(true);
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).toMatchObject({
      command: { type: commandType },
    });
    expect(fixture.accepted).toHaveLength(1);
  });

  it("persists explicit diagram-node classifications and distinguishes generic shapes", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), {
      request,
      createId: (prefix) => `${prefix}_fixed`,
    });

    await execute(toolByName(tools, "create_node"), {
      label: "Guest session API",
      nodeType: "service",
    });
    await execute(toolByName(tools, "create_shape"), { label: "Visual callout" });

    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>, 0)).toMatchObject({
      command: { object: { kind: "shape", nodeType: "service", label: "Guest session API" } },
    });
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>, 1)).toMatchObject({
      command: { object: { kind: "shape", nodeType: null, label: "Visual callout" } },
    });
  });

  it("creates and updates lifecycle nodes with reviewable intent metadata", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), {
      request,
      createId: () => "node_decision",
    });

    const result = await execute(toolByName(tools, "create_node"), {
      label: "Use signed sessions?",
      nodeMetadata: {
        kind: "decision",
        status: "accepted",
        owner: "Platform team",
        resolution: "Use HMAC-signed, HttpOnly cookies.",
      },
      intent: "Record the authorization decision",
      summary: "Accepted signed guest sessions",
    });

    expect(result.ok).toBe(true);
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).toMatchObject({
      command: {
        type: "create",
        object: {
          id: "node_decision",
          nodeType: "decision",
          nodeMetadata: {
            kind: "decision",
            status: "accepted",
            owner: "Platform team",
            resolution: "Use HMAC-signed, HttpOnly cookies.",
          },
        },
      },
      metadata: {
        intent: "Record the authorization decision",
        summary: "Accepted signed guest sessions",
      },
    });
  });

  it("keeps create_node lifecycle discovery compact and runtime validation exact", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), {
      request,
      createId: () => "node_lifecycle",
    });
    const createNode = toolByName(tools, "create_node");
    const validatesAdvertisedSchema = new Ajv({ allErrors: true, logger: false }).compile(
      createNode.inputSchema as object,
    );
    expect((createNode.inputSchema as { properties?: { nodeMetadata?: { description?: string } } })
      .properties?.nodeMetadata?.description).toMatch(/kind matches nodeType/);
    const acceptedInputs = [
      {
        label: "Pending decision",
        nodeMetadata: { kind: "decision" },
      },
      {
        label: "Accepted decision",
        nodeType: "decision",
        nodeMetadata: { kind: "decision", status: "accepted", resolution: "Use signed sessions." },
      },
      {
        label: "Open question",
        nodeType: "open_question",
        nodeMetadata: { kind: "open_question" },
      },
    ];
    const rejectedInputs = [
      {
        label: "Premature resolution",
        nodeMetadata: { kind: "decision", resolution: "Status was omitted." },
      },
      {
        label: "Mismatched kind",
        nodeType: "decision",
        nodeMetadata: { kind: "open_question" },
      },
      {
        label: "Metadata on a component",
        nodeType: "component",
        nodeMetadata: { kind: "decision" },
      },
    ];

    for (const input of acceptedInputs) {
      expect(validatesAdvertisedSchema(input), JSON.stringify(validatesAdvertisedSchema.errors)).toBe(true);
      await expect(execute(createNode, input)).resolves.toMatchObject({ ok: true });
    }
    for (const input of rejectedInputs) {
      expect(validatesAdvertisedSchema(input)).toBe(true);
      await expect(execute(createNode, input)).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_TOOL_INPUT" },
      });
    }
    expect(request).toHaveBeenCalledTimes(acceptedInputs.length);
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>, 0)).toMatchObject({
      command: {
        object: {
          nodeType: "decision",
          nodeMetadata: {
            kind: "decision",
            status: "proposed",
            owner: null,
            resolution: null,
          },
        },
      },
    });
  });

  it("updates an authoritative node classification through update_object", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "update_object"), {
      objectId: "service-a",
      expectedRevision: 3,
      patch: { nodeType: "decision" },
    });

    expect(result.ok).toBe(true);
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).toMatchObject({
      command: {
        type: "update",
        objectId: "service-a",
        expectedRevision: 3,
        patch: { nodeType: "decision" },
      },
    });
  });

  it("adds only accessible HTTPS images and preserves source attribution", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), {
      request,
      createId: () => "image_fixed",
    });

    const invalid = await execute(toolByName(tools, "add_image"), {
      url: "http://example.com/screenshot.png",
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();

    const valid = await execute(toolByName(tools, "add_image"), {
      url: "https://example.com/screenshot.png",
      alt: "Checkout screenshot",
      locked: true,
    });
    expect(valid.ok).toBe(true);
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).toMatchObject({
      command: {
        type: "create",
        object: {
          id: "image_fixed",
          kind: "image",
          url: "https://example.com/screenshot.png",
          sourceUrl: "https://example.com/screenshot.png",
          assetId: null,
          alt: "Checkout screenshot",
          locked: true,
        },
      },
    });

    const privateReference =
      "/api/rooms/room_private/assets?pathname=" +
      encodeURIComponent(
        `jazzboard/${"a".repeat(48)}/550e8400-e29b-41d4-a716-446655440000-private.png`,
      );
    const privateResult = await execute(toolByName(tools, "add_image"), {
      url: privateReference,
      alt: "Authorized private image",
    });
    expect(privateResult.ok).toBe(true);
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>, 1)).toMatchObject({
      command: {
        object: {
          url: privateReference,
          sourceUrl: null,
        },
      },
    });
  });

  it("creates a bounded freehand drawing from canvas-world points", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), {
      request,
      createId: () => "draw_fixed",
    });

    const result = await execute(toolByName(tools, "create_drawing"), {
      points: [
        { x: -10, y: 50 },
        { x: 40, y: 70 },
        { x: 30, y: 100 },
      ],
      size: "l",
    });

    expect(result.ok).toBe(true);
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).toEqual({
      command: {
        type: "create",
        object: {
          id: "draw_fixed",
          kind: "draw",
          x: -10,
          y: 50,
          width: 50,
          height: 50,
          rotation: 0,
          zIndex: 4,
          groupId: null,
          points: [
            { x: 0, y: 0 },
            { x: 50, y: 20 },
            { x: 40, y: 50 },
          ],
          color: "black",
          size: "l",
        },
      },
    });
  });

  it("rejects oversized drawing payloads before any server request", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "create_drawing"), {
      points: Array.from({ length: 2_001 }, (_, index) => ({ x: index, y: index })),
    });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("creates native Bezier paths and polygons from safe numeric world geometry", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), {
      request,
      createId: () => "path_fixed",
    });

    await execute(toolByName(tools, "create_path"), {
      start: { x: 100, y: 200 },
      segments: [{
        kind: "cubic",
        control1: { x: 120, y: 160 },
        control2: { x: 180, y: 260 },
        to: { x: 200, y: 220 },
      }],
      closed: true,
      fill: "#abc",
      stroke: "red",
      strokeWidth: 7,
      opacity: 0.6,
      lineCap: "square",
      lineJoin: "bevel",
      fillRule: "evenodd",
    });
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).toMatchObject({
      command: {
        object: {
          id: "path_fixed",
          kind: "path",
          x: 100,
          y: 160,
          width: 100,
          height: 100,
          start: { x: 0, y: 0.4 },
          segments: [{
            kind: "cubic",
            control1: { x: 0.2, y: 0 },
            control2: { x: 0.8, y: 1 },
            to: { x: 1, y: 0.6 },
          }],
          fill: "#abc",
          strokeWidth: 7,
          opacity: 0.6,
        },
      },
    });

    await execute(toolByName(tools, "create_polygon"), {
      points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 30 }],
      fill: "blue",
    });
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>, 1)).toMatchObject({
      command: { object: { kind: "path", closed: true, segments: [{ kind: "line" }, { kind: "line" }] } },
    });
  });

  it("persists named vector-art and architecture identities and can clear them by revision", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), {
      request,
      createId: (prefix) => `${prefix}_semantic`,
    });

    await execute(toolByName(tools, "create_path"), {
      semanticName: "Mona Lisa left eye",
      semanticRole: "portrait.eye.contour",
      start: { x: 10, y: 10 },
      segments: [{ kind: "line", to: { x: 30, y: 10 } }],
    });
    await execute(toolByName(tools, "create_node"), {
      semanticName: "Netflix API gateway",
      semanticRole: "architecture.edge_service",
      label: "API gateway",
      nodeType: "service",
    });
    await execute(toolByName(tools, "update_object"), {
      objectId: "service-a",
      expectedRevision: 3,
      patch: { semanticName: null, semanticRole: null },
    });

    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>, 0)).toMatchObject({
      command: {
        type: "create",
        object: {
          id: "path_semantic",
          semanticName: "Mona Lisa left eye",
          semanticRole: "portrait.eye.contour",
        },
      },
    });
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>, 1)).toMatchObject({
      command: {
        type: "create",
        object: {
          id: "node_semantic",
          semanticName: "Netflix API gateway",
          semanticRole: "architecture.edge_service",
        },
      },
    });
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>, 2)).toMatchObject({
      command: {
        type: "update",
        objectId: "service-a",
        expectedRevision: 3,
        patch: { semanticName: null, semanticRole: null },
      },
    });
  });

  it("rejects unsupported authoring colors and invisible path styles before mutation", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), { request });
    for (const input of [
      { start: { x: 0, y: 0 }, segments: [{ kind: "line", to: { x: 10, y: 10 } }], stroke: "chartreuse" },
      { start: { x: 0, y: 0 }, segments: [{ kind: "line", to: { x: 10, y: 10 } }], fill: "none", stroke: "none" },
      { start: { x: 0, y: 0 }, segments: [{ kind: "line", to: { x: 10, y: 10 } }], stroke: "red", strokeWidth: 0 },
    ]) {
      await expect(execute(toolByName(tools, "create_path"), input)).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_TOOL_INPUT" },
      });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("connects objects semantically by ID and derives their current centers", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), {
      request,
      createId: () => "connector_fixed",
    });

    const result = await execute(toolByName(tools, "draw_connection"), {
      start: { objectId: "service-a" },
      end: { objectId: "service-b" },
      direction: "both",
      label: "events",
    });

    expect(result.ok).toBe(true);
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).toMatchObject({
      command: {
        type: "create",
        object: {
          id: "connector_fixed",
          kind: "connector",
          start: { objectId: "service-a", x: 200, y: 250 },
          end: { objectId: "service-b", x: 600, y: 450 },
          routing: {
            mode: "auto",
            kind: "straight",
            bend: 0,
            elbowMidPoint: 0.5,
            labelPosition: 0.5,
          },
          direction: "both",
          label: "events",
        },
      },
    });
  });

  it("connects bound semantic ports without requiring pixel coordinates", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), {
      request,
      createId: () => "connector_ported",
    });

    const result = await execute(toolByName(tools, "draw_connection"), {
      start: { objectId: "service-a", port: { side: "right", position: 0.25 } },
      end: { objectId: "service-b", port: { side: "left", position: 0.75 } },
      routing: { mode: "elbow" },
    });

    expect(result.ok).toBe(true);
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).toMatchObject({
      command: {
        type: "create",
        object: {
          id: "connector_ported",
          start: {
            objectId: "service-a",
            x: 300,
            y: 225,
            normalizedAnchor: { x: 1, y: 0.25 },
            isPrecise: true,
            isExact: false,
            snap: "edge-point",
          },
          end: {
            objectId: "service-b",
            x: 500,
            y: 475,
            normalizedAnchor: { x: 0, y: 0.75 },
            isPrecise: true,
            isExact: false,
            snap: "edge-point",
          },
        },
      },
    });
  });

  it("exposes explicit connector routing through revision-safe mutations", async () => {
    const fixture = contextFixture();
    const request = successfulRequest();
    const tools = createJazzboardWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "update_object"), {
      objectId: "connector-a",
      expectedRevision: 4,
      operation: "connect",
      patch: {
        routing: { mode: "curved", bend: -72, labelPosition: 0.4 },
      },
    });

    expect(result.ok).toBe(true);
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).toMatchObject({
      command: {
        type: "update",
        objectId: "connector-a",
        expectedRevision: 4,
        operation: "connect",
        patch: {
          routing: {
            mode: "curved",
            kind: "curved",
            bend: -72,
            elbowMidPoint: 0.5,
            labelPosition: 0.4,
          },
        },
      },
    });
  });

  it("preserves structured OBJECT_BUSY details and performs no activation side request", async () => {
    const fixture = contextFixture();
    const busy = {
      objectId: "service-a",
      actor: actor("bob"),
      operation: "edit",
      currentRevision: 3,
      expiresAt: NOW + 4_000,
    };
    const request = requestMock(async () => {
      throw new JazzboardApiError(409, {
        code: "OBJECT_BUSY",
        message: "Bob is currently editing this object.",
        details: busy,
      });
    });
    const tools = createJazzboardWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "move_objects"), {
      targets: [{ objectId: "service-a", expectedRevision: 1, x: 0, y: 0 }],
    });

    expect(result).toMatchObject({
      ok: false,
      tool: "move_objects",
      error: {
        code: "OBJECT_BUSY",
        message: "Bob is currently editing this object.",
        details: busy,
        recovery: {
          retry: "after_wait",
          suggestedTools: expect.arrayContaining(["read_collaboration_state", "read_room_state"]),
          instructions: expect.stringMatching(/do not steal.*lease.*current exact revisions/i),
        },
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(String((request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain("/agent/commands");
    expect(fixture.accepted).toEqual([]);
  });
});

describe("agent virtual viewport", () => {
  it("focuses around semantic objects through the authenticated agent presence route", async () => {
    const fixture = contextFixture();
    const request = requestMock(async () => ({
      ok: true,
      presence: {
        roomId: "room/a b",
        stateRevision: 10,
        roomRevision: 9,
        participantId: "alice",
        actorKind: "agent",
        lastSeenAt: NOW + 1,
        connected: true,
        agentActive: true,
        presence: {
          cursor: { x: 400, y: 350 },
          viewport: { x: 50, y: 150, width: 700, height: 400, zoom: 0.75 },
          lastSeenAt: NOW + 1,
          activity: null,
        },
      },
    }));
    const tools = createJazzboardWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "focus_viewport"), {
      objectIds: ["service-a", "service-b"],
      padding: 50,
      zoom: 0.75,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        viewport: { x: 50, y: 150, width: 700, height: 400, zoom: 0.75 },
        roomRevision: 9,
      },
    });
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).toEqual({
      cursor: { x: 400, y: 350 },
      viewport: { x: 50, y: 150, width: 700, height: 400, zoom: 0.75 },
      activity: null,
    });
    expect(parsedBody(request as unknown as ReturnType<typeof vi.fn>)).not.toHaveProperty("actorKind");
    expect((request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
      headers: { "x-jazzboard-presence-protocol": "delta-v1" },
    });
    expect(fixture.accepted.at(-1)).toMatchObject({
      stateRevision: 10,
      roomRevision: 9,
      participants: { alice: { agent: { viewport: { x: 50, y: 150 } } } },
    });
  });

  it("authoritatively refreshes when focus_viewport receives a non-cumulative delta gap", async () => {
    const fixture = contextFixture(room({ stateRevision: 9 }));
    const authoritative = room({ stateRevision: 11 });
    const request = requestMock(async (_url, init) => {
      if (init?.method === "GET") return { ok: true, room: authoritative };
      return {
        ok: true,
        presence: {
          roomId: "room/a b",
          stateRevision: 11,
          roomRevision: 9,
          participantId: "alice",
          actorKind: "agent",
          lastSeenAt: NOW + 1,
          connected: true,
          agentActive: true,
          presence: {
            cursor: { x: 400, y: 350 },
            viewport: { x: 50, y: 150, width: 700, height: 400, zoom: 1 },
            lastSeenAt: NOW + 1,
            activity: null,
          },
        },
      };
    });
    const tools = createJazzboardWebMcpTools(binding(fixture.context), { request });

    await execute(toolByName(tools, "focus_viewport"), {
      objectIds: ["service-a", "service-b"],
      padding: 50,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(fixture.accepted).toEqual([authoritative]);
  });

  it("rejects partial explicit viewports before making a request", async () => {
    const fixture = contextFixture();
    const request = requestMock(async () => ({ ok: true, room: room() }));
    const tools = createJazzboardWebMcpTools(binding(fixture.context), { request });

    const result = await execute(toolByName(tools, "focus_viewport"), { x: 0, y: 0 });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });
});
