/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import type { ActorRef, CanvasObject, Diagram, Participant, RoomState } from "@/lib/domain/types";

import { InRoomCanvasPreviewTransport } from "./in-room-preview-transport";
import { createJazzboardPreviewWebMcpTools } from "./preview-tools";
import type {
  CanvasPreviewArtifact,
  CanvasPreviewTransportAdapter,
} from "./canvas-preview";
import type {
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpContext,
  WebMcpRequest,
} from "./types";

const NOW = 10_000;

function actor(): ActorRef {
  return { participantId: "alice", displayName: "Alice", color: "#ef476f", kind: "agent" };
}

function participant(): Participant {
  const presence = { cursor: null, viewport: null, lastSeenAt: NOW, activity: null };
  return {
    participantId: "alice",
    displayName: "Alice",
    color: "#ef476f",
    role: "participant",
    joinedAt: NOW,
    lastSeenAt: NOW,
    connected: true,
    agentActive: true,
    human: structuredClone(presence),
    agent: structuredClone(presence),
  };
}

function object(id: string, revision: number): CanvasObject {
  return {
    id,
    kind: "shape",
    x: revision * 10,
    y: 20,
    width: 200,
    height: 100,
    rotation: 0,
    zIndex: revision,
    revision,
    groupId: null,
    diagramIds: ["diagram-1"],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(),
    lastEditedBy: actor(),
    shape: "rectangle",
    nodeType: null,
    label: id,
    fill: "blue",
    stroke: "blue",
  };
}

function diagram(revision = 4): Diagram {
  return {
    id: "diagram-1",
    title: "System",
    description: "",
    diagramType: "architecture",
    category: null,
    tags: [],
    memberObjectIds: ["object-a"],
    connectorIds: ["connector-a"],
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    revision,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(),
    lastEditedBy: actor(),
  };
}

function room(): RoomState {
  return {
    id: "room/a b",
    code: "1234",
    title: "Preview room",
    roomRevision: 12,
    createdAt: NOW,
    updatedAt: NOW,
    participants: { alice: participant() },
    objects: {
      "object-a": object("object-a", 3),
      "connector-a": { ...object("connector-a", 7), diagramIds: ["diagram-1"] },
    },
    diagrams: { "diagram-1": diagram() },
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function artifact(): CanvasPreviewArtifact {
  return {
    blob: new Blob(["png"], { type: "image/png" }),
    metadata: {
      mimeType: "image/png",
      width: 320,
      height: 180,
      logicalWidth: 320,
      logicalHeight: 180,
      byteLength: 3,
      renderedBounds: { x: 10, y: 20, width: 320, height: 180 },
      padding: 32,
      pixelRatio: 1,
      source: {
        kind: "objects",
        targets: [{ objectId: "object-a", expectedRevision: 3 }],
        roomRevision: 12,
        objectRevisions: [{ objectId: "object-a", revision: 3 }],
      },
      warnings: [],
    },
  };
}

function fixture(options: { role?: "participant" | "spectator"; withPresenter?: boolean } = {}) {
  let accepted: RoomState | null = null;
  const renderCanvasPreview = vi.fn(async () => artifact());
  const presentCanvasPreview = vi.fn(async () => ({
    previewId: "preview-1",
    clip: { coordinateSpace: "viewport-css-pixels" as const, x: 12, y: 24, width: 320, height: 180 },
    expiresAt: 70_000,
  }));
  const context: JazzboardWebMcpContext = {
    getRoom: () => accepted,
    getSelection: () => [],
    getViewport: () => null,
    getFollowTarget: () => null,
    renderCanvasPreview,
    ...(options.withPresenter === false ? {} : { presentCanvasPreview }),
    acceptRoom: (next) => {
      accepted = next;
    },
    setFollowTarget: () => undefined,
    setDeclinedSpotlight: () => undefined,
    leaveRoomView: () => undefined,
  };
  const binding: JazzboardWebMcpBinding = {
    roomId: "room/a b",
    participantId: "alice",
    role: options.role ?? "participant",
    context,
  };
  return { binding, renderCanvasPreview, presentCanvasPreview, accepted: () => accepted };
}

function requestMock(authoritative = room()) {
  return vi.fn(async () => ({ ok: true, room: authoritative })) as unknown as WebMcpRequest;
}

async function execute(tool: WebMCP.ModelContextTool, input: Record<string, unknown>) {
  return tool.execute(input, { signal: new AbortController().signal });
}

describe("render_canvas_preview WebMCP tool", () => {
  it("registers only for a participant with both render and presentation transports", () => {
    const ready = fixture();
    const transport = new InRoomCanvasPreviewTransport();
    expect(
      createJazzboardPreviewWebMcpTools(ready.binding, { request: requestMock(), canvasPreviewTransport: transport }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["render_canvas_preview"]);
    expect(
      createJazzboardPreviewWebMcpTools(ready.binding, {
        request: requestMock(),
        canvasPreviewTransport: transport,
      })[0].annotations,
    ).toEqual({ untrustedContentHint: true });
    expect(createJazzboardPreviewWebMcpTools(fixture({ role: "spectator" }).binding, { canvasPreviewTransport: transport })).toEqual([]);
    expect(createJazzboardPreviewWebMcpTools(ready.binding, {})).toEqual([]);
    expect(
      createJazzboardPreviewWebMcpTools(fixture({ withPresenter: false }).binding, {
        canvasPreviewTransport: transport,
      }),
    ).toEqual([]);
  });

  it("resolves exact authoritative object revisions and returns the painted screenshot handoff", async () => {
    const current = room();
    const state = fixture();
    const request = requestMock(current);
    const transport = new InRoomCanvasPreviewTransport();
    const [tool] = createJazzboardPreviewWebMcpTools(state.binding, {
      request,
      canvasPreviewTransport: transport,
    });

    const result = await execute(tool, {
      scope: { kind: "objects", targets: [{ objectId: "object-a", expectedRevision: 3 }] },
      padding: 20,
      maxWidth: 1024,
      maxHeight: 768,
      pixelRatio: 1.5,
      maxBytes: 1_000_000,
    });

    expect(request).toHaveBeenCalledWith("/api/rooms/room%2Fa%20b", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(state.accepted()).toBe(current);
    expect(state.renderCanvasPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room/a b",
        authoritativeRoomRevision: 12,
        source: { kind: "objects", targets: [{ objectId: "object-a", expectedRevision: 3 }] },
        objects: [current.objects["object-a"]],
        options: { padding: 20, maxWidth: 1024, maxHeight: 768, pixelRatio: 1.5, maxBytes: 1_000_000 },
      }),
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({
      ok: true,
      tool: "render_canvas_preview",
      data: {
        previewId: "preview-1",
        screenshotClip: {
          coordinateSpace: "viewport-css-pixels",
          x: 12,
          y: 24,
          width: 320,
          height: 180,
        },
        sourceRevisions: { roomRevision: 12, objects: [{ objectId: "object-a", revision: 3 }] },
        nextStep: expect.stringContaining("screenshotClip"),
      },
    });
    expect((result as { data: Record<string, unknown> }).data).not.toHaveProperty("previewUrl");
  });

  it("expands an exact Diagram revision to only its declared members and connectors", async () => {
    const current = room();
    const state = fixture();
    const [tool] = createJazzboardPreviewWebMcpTools(state.binding, {
      request: requestMock(current),
      canvasPreviewTransport: new InRoomCanvasPreviewTransport(),
    });

    await execute(tool, { scope: { kind: "diagram", diagramId: "diagram-1", expectedRevision: 4 } });

    expect(state.renderCanvasPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "diagram", diagramId: "diagram-1", expectedRevision: 4 },
        diagram: current.diagrams["diagram-1"],
        objects: [current.objects["object-a"], current.objects["connector-a"]],
      }),
      expect.any(AbortSignal),
    );
  });

  it("fails truthfully before rendering when an object revision is stale", async () => {
    const state = fixture();
    const transport: CanvasPreviewTransportAdapter = { emit: vi.fn() };
    const [tool] = createJazzboardPreviewWebMcpTools(state.binding, {
      request: requestMock(),
      canvasPreviewTransport: transport,
    });

    const result = (await execute(tool, {
      scope: { kind: "objects", targets: [{ objectId: "object-a", expectedRevision: 2 }] },
    })) as JazzboardToolResult;

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "OBJECT_REVISION_CONFLICT",
        details: { objectId: "object-a", expectedRevision: 2, actualRevision: 3 },
      },
    });
    expect(state.renderCanvasPreview).not.toHaveBeenCalled();
    expect(transport.emit).not.toHaveBeenCalled();
  });

  it("rejects implicit room, viewport, selection, and last-created scopes", async () => {
    const state = fixture();
    const [tool] = createJazzboardPreviewWebMcpTools(state.binding, {
      request: requestMock(),
      canvasPreviewTransport: new InRoomCanvasPreviewTransport(),
    });

    for (const input of [{}, { scope: { kind: "room" } }, { lastCreated: true }, { scope: { kind: "objects", targets: [] } }]) {
      const result = (await execute(tool, input)) as JazzboardToolResult;
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    }
    expect(state.renderCanvasPreview).not.toHaveBeenCalled();
  });
});
