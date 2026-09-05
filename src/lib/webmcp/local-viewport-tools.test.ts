/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import { fitBoundsInViewport } from "@/lib/canvas/camera";
import type { GuidedWalkthrough } from "@/lib/canvas/guided-walkthrough";
import type { CanvasRuntime, CanvasZoomOptions } from "@/lib/canvas/runtime";
import type { CanvasBounds, CanvasObject, Diagram, RoomState, Viewport } from "@/lib/domain/types";

import {
  createJazzboardLocalViewportWebMcpTools,
  JAZZBOARD_LOCAL_VIEWPORT_TOOL_NAMES,
} from "./local-viewport-tools";
import type { JazzboardToolResult, JazzboardWebMcpBinding, JazzboardWebMcpContext } from "./types";

const actor = {
  participantId: "participant-1",
  displayName: "Loop",
  color: "#5965e8",
  kind: "agent" as const,
};

function shape(id: string, x: number, y: number, width = 160, height = 80): CanvasObject {
  return {
    id,
    kind: "shape",
    x,
    y,
    width,
    height,
    rotation: 0,
    zIndex: 1,
    revision: 1,
    groupId: null,
    diagramIds: ["diagram-1"],
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
    shape: "rectangle",
    nodeType: null,
    label: id,
    fill: "light-violet",
    stroke: "blue",
  };
}

function diagram(): Diagram {
  return {
    id: "diagram-1",
    title: "Request flow",
    description: "",
    diagramType: "flow",
    category: null,
    tags: [],
    memberObjectIds: ["client", "worker"],
    connectorIds: [],
    bounds: { x: 10, y: 20, width: 550, height: 280 },
    revision: 4,
    createdAt: 1,
    updatedAt: 2,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function room(): RoomState {
  const objects = [shape("client", 10, 20), shape("worker", 400, 220)];
  const currentDiagram = diagram();
  return {
    id: "room-1",
    code: "ABC234",
    title: "Local camera",
    roomRevision: 8,
    createdAt: 1,
    updatedAt: 2,
    participants: {},
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: { [currentDiagram.id]: currentDiagram },
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function unionBounds(bounds: CanvasBounds | null, next: CanvasBounds): CanvasBounds {
  if (!bounds) return next;
  const right = Math.max(bounds.x + bounds.width, next.x + next.width);
  const bottom = Math.max(bounds.y + bounds.height, next.y + next.height);
  const x = Math.min(bounds.x, next.x);
  const y = Math.min(bounds.y, next.y);
  return { x, y, width: right - x, height: bottom - y };
}

function fixture(role: "participant" | "spectator" = "participant") {
  const currentRoom = room();
  let viewport: Viewport = { x: 0, y: 0, width: 800, height: 600, zoom: 1 };
  const selection = ["client"];
  const walkthrough = {
    id: "walkthrough-1",
    roomId: currentRoom.id,
    revision: 3,
    currentStepIndex: 1,
  } as GuidedWalkthrough;
  let activeWalkthrough: GuidedWalkthrough | null = walkthrough;
  const presentGuidedWalkthrough = vi.fn();
  const stopGuidedWalkthrough = vi.fn((walkthroughId?: string) => {
    if (walkthroughId && activeWalkthrough?.id !== walkthroughId) return;
    activeWalkthrough = null;
  });
  const acceptRoom = vi.fn();
  const setFollowTarget = vi.fn();
  const zoomToBounds = vi.fn((bounds: CanvasBounds, options: CanvasZoomOptions = {}) => {
    if (options.targetZoom !== undefined) {
      const physicalWidth = viewport.width * viewport.zoom;
      const physicalHeight = viewport.height * viewport.zoom;
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      viewport = {
        x: centerX - physicalWidth / options.targetZoom / 2,
        y: centerY - physicalHeight / options.targetZoom / 2,
        width: physicalWidth / options.targetZoom,
        height: physicalHeight / options.targetZoom,
        zoom: options.targetZoom,
      };
      return;
    }
    viewport = fitBoundsInViewport(bounds, viewport, { padding: options.inset });
  });
  const runtime = {
    rendererId: "jazzboard-semantic-v1",
    capabilities: { renderPng: true },
    getViewport: () => viewport,
    hasObject: (objectId: string) => Boolean(currentRoom.objects[objectId]),
    getVisibleBounds: (objectIds: readonly string[]) => objectIds.reduce<CanvasBounds | null>(
      (bounds, objectId) => {
        const object = currentRoom.objects[objectId];
        return object
          ? unionBounds(bounds, { x: object.x, y: object.y, width: object.width, height: object.height })
          : bounds;
      },
      null,
    ),
    zoomToBounds,
  } as unknown as CanvasRuntime;
  const context: JazzboardWebMcpContext = {
    getRoom: () => currentRoom,
    getSelection: () => selection,
    getViewport: () => viewport,
    getCanvasRuntime: () => runtime,
    getFollowTarget: () => ({ participantId: "other", kind: "human" }),
    getGuidedWalkthrough: () => activeWalkthrough,
    presentGuidedWalkthrough,
    stopGuidedWalkthrough,
    acceptRoom,
    setFollowTarget,
    setDeclinedSpotlight: vi.fn(),
    leaveRoomView: vi.fn(),
  };
  const binding: JazzboardWebMcpBinding = {
    roomId: currentRoom.id,
    participantId: actor.participantId,
    role,
    context,
  };
  return {
    acceptRoom,
    binding,
    context,
    presentGuidedWalkthrough,
    runtime,
    selection,
    setFollowTarget,
    stopGuidedWalkthrough,
    walkthrough,
    zoomToBounds,
  };
}

function tool(binding: JazzboardWebMcpBinding): WebMCP.ModelContextTool {
  return createJazzboardLocalViewportWebMcpTools(binding)[0]!;
}

async function execute(
  binding: JazzboardWebMcpBinding,
  input: Record<string, unknown>,
): Promise<JazzboardToolResult> {
  return await tool(binding).execute(input, {
    signal: new AbortController().signal,
  }) as JazzboardToolResult;
}

describe("local viewport WebMCP tool", () => {
  it("registers one bounded role-neutral camera tool", () => {
    const participant = fixture("participant");
    const spectator = fixture("spectator");

    expect(createJazzboardLocalViewportWebMcpTools(participant.binding).map(({ name }) => name))
      .toEqual(JAZZBOARD_LOCAL_VIEWPORT_TOOL_NAMES);
    expect(createJazzboardLocalViewportWebMcpTools(spectator.binding).map(({ name }) => name))
      .toEqual(JAZZBOARD_LOCAL_VIEWPORT_TOOL_NAMES);
    expect(tool(participant.binding).annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
  });

  it("reads and zooms the current local camera without publishing or changing tour state", async () => {
    const current = fixture();
    const walkthroughBefore = current.context.getGuidedWalkthrough?.();
    const selectionBefore = current.context.getSelection();

    await expect(execute(current.binding, { action: "read" })).resolves.toMatchObject({
      ok: true,
      data: {
        action: "read",
        changed: false,
        viewport: { x: 0, y: 0, width: 800, height: 600, zoom: 1 },
        localOnly: true,
        presencePublished: false,
        walkthroughDismissal: { requested: false, stopped: false, walkthroughId: null },
      },
    });
    expect(current.zoomToBounds).not.toHaveBeenCalled();

    await expect(execute(current.binding, { action: "zoom_out" })).resolves.toMatchObject({
      ok: true,
      data: {
        action: "zoom_out",
        changed: true,
        viewport: { zoom: 1 / 1.2 },
        scope: { type: "viewport_center", factor: 1.2 },
        localOnly: true,
        presencePublished: false,
      },
    });
    expect(current.zoomToBounds).toHaveBeenLastCalledWith(
      { x: 0, y: 0, width: 800, height: 600, zoom: 1 },
      { targetZoom: 1 / 1.2, durationMs: 120, force: true, publishPresence: false },
    );
    expect(current.context.getSelection()).toBe(selectionBefore);
    expect(current.context.getGuidedWalkthrough?.()).toBe(walkthroughBefore);
    expect(current.presentGuidedWalkthrough).not.toHaveBeenCalled();
    expect(current.stopGuidedWalkthrough).not.toHaveBeenCalled();
    expect(current.acceptRoom).not.toHaveBeenCalled();
    expect(current.setFollowTarget).not.toHaveBeenCalled();
  });

  it("reports handler execution time without claiming transport or paint latency", async () => {
    const now = vi.spyOn(performance, "now")
      .mockReturnValueOnce(120)
      .mockReturnValueOnce(124.75);

    const result = await execute(fixture().binding, { action: "read" });

    expect(result).toMatchObject({
      ok: true,
      data: {
        executionTiming: {
          handlerDurationMs: 4.75,
          measurement: "execute_entry_to_result_preparation",
          excludes: ["webmcp_transport", "react_paint"],
        },
      },
    });
    expect(now).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("fits an exact Diagram, exact object IDs, and the rendered room", async () => {
    const current = fixture();

    await expect(execute(current.binding, {
      action: "fit_diagram",
      diagramId: "diagram-1",
    })).resolves.toMatchObject({
      ok: true,
      data: { scope: { type: "diagram", diagramId: "diagram-1", diagramRevision: 4 } },
    });
    expect(current.zoomToBounds).toHaveBeenLastCalledWith(
      { x: 10, y: 20, width: 550, height: 280 },
      { inset: 96, durationMs: 180, force: true, publishPresence: false },
    );

    await expect(execute(current.binding, {
      action: "fit_objects",
      objectIds: ["client", "worker"],
      inset: 40,
    })).resolves.toMatchObject({
      ok: true,
      data: { scope: { type: "objects", objectIds: ["client", "worker"] } },
    });
    expect(current.zoomToBounds).toHaveBeenLastCalledWith(
      { x: 10, y: 20, width: 550, height: 280 },
      { inset: 40, durationMs: 180, force: true, publishPresence: false },
    );

    await expect(execute(current.binding, { action: "fit_room" })).resolves.toMatchObject({
      ok: true,
      data: { scope: { type: "room", objectCount: 2, roomRevision: 8 } },
    });
    expect(current.acceptRoom).not.toHaveBeenCalled();
    expect(current.setFollowTarget).not.toHaveBeenCalled();
    expect(current.context.getGuidedWalkthrough?.()).toBe(current.walkthrough);
    expect(current.stopGuidedWalkthrough).not.toHaveBeenCalled();
  });

  it("stops the active walkthrough and fits a validated Diagram in one call", async () => {
    const current = fixture();

    await expect(execute(current.binding, {
      action: "fit_diagram",
      diagramId: "diagram-1",
      dismissWalkthrough: true,
    })).resolves.toMatchObject({
      ok: true,
      data: {
        action: "fit_diagram",
        scope: { type: "diagram", diagramId: "diagram-1", diagramRevision: 4 },
        walkthroughDismissal: {
          requested: true,
          stopped: true,
          walkthroughId: "walkthrough-1",
        },
        executionTiming: {
          measurement: "execute_entry_to_result_preparation",
        },
      },
    });
    expect(current.stopGuidedWalkthrough).toHaveBeenCalledOnce();
    expect(current.stopGuidedWalkthrough).toHaveBeenCalledWith("walkthrough-1");
    expect(current.context.getGuidedWalkthrough?.()).toBeNull();
    expect(current.zoomToBounds).toHaveBeenCalledOnce();
    expect(current.stopGuidedWalkthrough.mock.invocationCallOrder[0])
      .toBeLessThan(current.zoomToBounds.mock.invocationCallOrder[0]!);
    expect(current.zoomToBounds).toHaveBeenCalledWith(
      { x: 10, y: 20, width: 550, height: 280 },
      { inset: 96, durationMs: 180, force: true, publishPresence: false },
    );
    expect(current.presentGuidedWalkthrough).not.toHaveBeenCalled();
    expect(current.acceptRoom).not.toHaveBeenCalled();
    expect(current.setFollowTarget).not.toHaveBeenCalled();
  });

  it("rejects missing and invalid IDs atomically before changing the camera", async () => {
    const current = fixture();

    await expect(execute(current.binding, {
      action: "fit_objects",
      objectIds: ["client", "missing"],
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "OBJECT_NOT_FOUND", details: { objectIds: ["missing"] } },
    });
    await expect(execute(current.binding, {
      action: "fit_diagram",
      diagramId: "missing-diagram",
      dismissWalkthrough: true,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "DIAGRAM_NOT_FOUND", details: { diagramId: "missing-diagram" } },
    });
    await expect(execute(current.binding, {
      action: "zoom_in",
      objectIds: ["client"],
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(current.zoomToBounds).not.toHaveBeenCalled();
    expect(current.stopGuidedWalkthrough).not.toHaveBeenCalled();
    expect(current.context.getGuidedWalkthrough?.()).toBe(current.walkthrough);
    expect(current.acceptRoom).not.toHaveBeenCalled();
  });

  it("reports an unavailable renderer without changing room or presence state", async () => {
    const current = fixture();
    current.binding.context.getCanvasRuntime = () => null;

    await expect(execute(current.binding, { action: "zoom_in" })).resolves.toMatchObject({
      ok: false,
      error: { code: "CANVAS_UNAVAILABLE" },
    });
    expect(current.acceptRoom).not.toHaveBeenCalled();
    expect(current.setFollowTarget).not.toHaveBeenCalled();
  });
});
