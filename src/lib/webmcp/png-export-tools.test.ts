/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import type { ActorRef, CanvasObject, RoomState } from "@/lib/domain/types";

import {
  createJazzboardPngExportWebMcpTools,
  JAZZBOARD_PNG_EXPORT_TOOL_NAMES,
} from "./png-export-tools";
import type {
  CanvasPreviewArtifact,
  JazzboardToolResult,
  JazzboardWebMcpBinding,
} from "./index";
import type { WebMcpRequest } from "./types";

function room(): RoomState {
  const actor = {
    participantId: "p_owner",
    displayName: "Ari",
    color: "#5965e8",
    kind: "human" as const,
  };
  return {
    id: "room/a b",
    code: "1234",
    title: "Image board",
    roomRevision: 8,
    createdAt: 1,
    updatedAt: 2,
    participants: {},
    objects: {
      image: {
        id: "image",
        kind: "image",
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        rotation: 0,
        zIndex: 1,
        groupId: null,
        diagramIds: ["diagram"],
        revision: 3,
        createdAt: 1,
        updatedAt: 2,
        createdBy: actor,
        lastEditedBy: actor,
        url: "/api/rooms/room%2Fa%20b/assets?assetId=private",
        assetId: "private",
        alt: "Screenshot",
        mimeType: "image/png",
        sourceUrl: null,
        locked: false,
      },
    },
    diagrams: {
      diagram: {
        id: "diagram",
        title: "Screenshot flow",
        description: "One image",
        diagramType: "custom",
        category: null,
        tags: [],
        memberObjectIds: ["image"],
        connectorIds: [],
        bounds: { x: 0, y: 0, width: 320, height: 180 },
        revision: 4,
        createdAt: 1,
        updatedAt: 2,
        createdBy: actor,
        lastEditedBy: actor,
      },
    },
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function diagramShape(id: string, index: number, createdBy: ActorRef): CanvasObject {
  return {
    id,
    kind: "shape",
    x: index * 240,
    y: 20,
    width: 200,
    height: 100,
    rotation: 0,
    zIndex: index + 1,
    groupId: null,
    diagramIds: ["diagram"],
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    createdBy,
    lastEditedBy: createdBy,
    shape: "rectangle",
    nodeType: "component",
    nodeMetadata: null,
    label: `member ${index}`,
    fill: "blue",
    stroke: "blue",
  };
}

function diagramConnector(
  id: string,
  index: number,
  startObjectId: string,
  endObjectId: string,
  createdBy: ActorRef,
): CanvasObject {
  return {
    id,
    kind: "connector",
    x: index * 240 + 200,
    y: 70,
    width: 40,
    height: 1,
    rotation: 0,
    zIndex: index,
    groupId: null,
    diagramIds: ["diagram"],
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    createdBy,
    lastEditedBy: createdBy,
    start: { x: index * 240 + 200, y: 70, objectId: startObjectId },
    end: { x: index * 240 + 240, y: 70, objectId: endObjectId },
    direction: "end",
    label: `route ${index}`,
    color: "black",
  };
}

function maximumDiagramRoom(): RoomState {
  const current = room();
  const createdBy = current.objects.image.createdBy;
  const memberIds = Array.from({ length: 500 }, (_, index) => `member-${index}`);
  const connectorIds = Array.from({ length: 500 }, (_, index) => `connector-${index}`);
  const members = memberIds.map((id, index) => diagramShape(id, index, createdBy));
  const connectors = connectorIds.map((id, index) => diagramConnector(
    id,
    index,
    memberIds[index],
    memberIds[(index + 1) % memberIds.length],
    createdBy,
  ));
  current.objects = Object.fromEntries([...members, ...connectors].map((item) => [item.id, item]));
  current.diagrams.diagram = {
    ...current.diagrams.diagram,
    memberObjectIds: memberIds,
    connectorIds,
  };
  return current;
}

function artifact(): CanvasPreviewArtifact {
  const blob = new Blob(["faithful png"], { type: "image/png" });
  return {
    blob,
    metadata: {
      mimeType: "image/png",
      width: 704,
      height: 424,
      logicalWidth: 352,
      logicalHeight: 212,
      byteLength: blob.size,
      renderedBounds: { x: -32, y: -32, width: 384, height: 244 },
      padding: 32,
      pixelRatio: 2,
      source: {
        kind: "room",
        expectedRevision: 8,
        roomRevision: 8,
        objectRevisions: [{ objectId: "image", revision: 3 }],
      },
      warnings: [],
      visualQuality: null,
    },
  };
}

function fixture(role: "participant" | "spectator" = "participant") {
  const current = room();
  const renderCanvasPreview = vi.fn().mockResolvedValue(artifact());
  const saveCanvasPng = vi.fn().mockResolvedValue(undefined);
  const acceptRoom = vi.fn();
  const binding: JazzboardWebMcpBinding = {
    roomId: current.id,
    participantId: "p_owner",
    role,
    context: {
      getRoom: () => current,
      getSelection: () => [],
      getViewport: () => null,
      getFollowTarget: () => null,
      renderCanvasPreview,
      saveCanvasPng,
      acceptRoom,
      setFollowTarget: () => undefined,
      setDeclinedSpotlight: () => undefined,
      leaveRoomView: () => undefined,
    },
  };
  const request = vi.fn().mockResolvedValue({ ok: true, room: current }) as unknown as WebMcpRequest;
  return { binding, current, request, renderCanvasPreview, saveCanvasPng, acceptRoom };
}

async function execute(
  tool: WebMCP.ModelContextTool,
  input: Record<string, unknown>,
): Promise<JazzboardToolResult> {
  return await tool.execute(input, { signal: new AbortController().signal }) as JazzboardToolResult;
}

describe("faithful PNG WebMCP export", () => {
  it("registers one local-download tool for participants and spectators", () => {
    for (const role of ["participant", "spectator"] as const) {
      const state = fixture(role);
      const tools = createJazzboardPngExportWebMcpTools(state.binding, { request: state.request });
      expect(tools.map((tool) => tool.name)).toEqual(JAZZBOARD_PNG_EXPORT_TOOL_NAMES);
      expect(tools[0].annotations).toEqual({ untrustedContentHint: true });
    }
  });

  it("downloads an exact room revision through the live canvas without persisting bytes", async () => {
    const state = fixture("spectator");
    const [tool] = createJazzboardPngExportWebMcpTools(state.binding, { request: state.request });

    const result = await execute(tool, {
      scope: { kind: "room", expectedRevision: 8 },
      filename: "Visual review.png",
    });

    expect(state.request).toHaveBeenCalledWith("/api/rooms/room%2Fa%20b", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(state.acceptRoom).toHaveBeenCalledWith(state.current);
    expect(state.renderCanvasPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room/a b",
        source: { kind: "room", expectedRevision: 8 },
        objects: [state.current.objects.image],
        options: expect.objectContaining({ maxWidth: 4_096, maxHeight: 4_096, pixelRatio: 2 }),
      }),
      expect.any(AbortSignal),
    );
    expect(state.saveCanvasPng).toHaveBeenCalledWith(
      expect.objectContaining({ blob: expect.any(Blob) }),
      "visual-review.png",
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({
      ok: true,
      tool: "export_canvas_png",
      data: {
        filename: "visual-review.png",
        width: 704,
        height: 424,
        persistedByJazzboard: false,
      },
    });
  });

  it("resolves a Diagram semantically and rejects stale revisions before rendering", async () => {
    const state = fixture();
    const [tool] = createJazzboardPngExportWebMcpTools(state.binding, { request: state.request });

    await execute(tool, { scope: { kind: "diagram", diagramId: "diagram", expectedRevision: 4 } });
    expect(state.renderCanvasPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "diagram", diagramId: "diagram", expectedRevision: 4 },
        diagram: state.current.diagrams.diagram,
        objects: [state.current.objects.image],
      }),
      expect.any(AbortSignal),
    );

    state.renderCanvasPreview.mockClear();
    const stale = await execute(tool, {
      scope: { kind: "objects", targets: [{ objectId: "image", expectedRevision: 2 }] },
    });
    expect(stale).toMatchObject({
      ok: false,
      error: {
        code: "OBJECT_REVISION_CONFLICT",
        details: { objectId: "image", expectedRevision: 2, actualRevision: 3 },
      },
    });
    expect(state.renderCanvasPreview).not.toHaveBeenCalled();
    expect(state.saveCanvasPng).toHaveBeenCalledOnce();
  });

  it("exports all 500 members and 500 connectors from a schema-maximum Diagram", async () => {
    const state = fixture();
    const maximum = maximumDiagramRoom();
    const request = vi.fn().mockResolvedValue({ ok: true, room: maximum }) as unknown as WebMcpRequest;
    const [tool] = createJazzboardPngExportWebMcpTools(state.binding, { request });

    const result = await execute(tool, {
      scope: { kind: "diagram", diagramId: "diagram", expectedRevision: 4 },
    });

    expect(result).toMatchObject({ ok: true });
    const renderRequest = state.renderCanvasPreview.mock.calls[0]?.[0];
    expect(renderRequest.objects).toHaveLength(1_000);
    expect(renderRequest.objects.slice(0, 500).every((item: CanvasObject) => item.kind === "shape")).toBe(true);
    expect(renderRequest.objects.slice(500).every((item: CanvasObject) => item.kind === "connector")).toBe(true);
    expect(state.saveCanvasPng).toHaveBeenCalledOnce();
  });

  it("rejects object scopes larger than the shared preview safety limit", async () => {
    const state = fixture();
    const [tool] = createJazzboardPngExportWebMcpTools(state.binding, { request: state.request });

    const result = await execute(tool, {
      scope: {
        kind: "objects",
        targets: Array.from({ length: 1_001 }, (_, index) => ({
          objectId: `object-${index}`,
          expectedRevision: 1,
        })),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_TOOL_INPUT" },
    });
    expect(state.request).not.toHaveBeenCalled();
    expect(state.renderCanvasPreview).not.toHaveBeenCalled();
    expect(state.saveCanvasPng).not.toHaveBeenCalled();
  });
});
