import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuidedWalkthrough } from "@/lib/canvas/guided-walkthrough";
import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { RoomState, Viewport } from "@/lib/domain/types";

import {
  GuidedWalkthroughOverlay,
  walkthroughCameraFrame,
} from "./GuidedWalkthroughOverlay";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const viewport: Viewport = { x: 0, y: 0, width: 800, height: 600, zoom: 1 };
const room = {
  id: "room-guide",
  code: "GUIDE1",
  title: "Guide",
  roomRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  participants: {},
  objects: {},
  diagrams: {},
  leases: {},
  spotlight: null,
  agentEditPolicy: "live",
  reviewProposals: [],
} as RoomState;
const walkthrough: GuidedWalkthrough = {
  id: "walkthrough-1",
  roomId: room.id,
  revision: 1,
  title: "System tour",
  currentStepIndex: 0,
  startedAt: 1,
  steps: [{ caption: "Overview", objectIds: [], connectorIds: [] }],
};
const runtime = {
  getViewport: () => viewport,
  getVisibleBounds: () => null,
  hasObject: () => false,
  pageToViewport: (point: { x: number; y: number }) => point,
  zoomToBounds: vi.fn(),
} as unknown as CanvasRuntime;

describe("GuidedWalkthroughOverlay tool activity", () => {
  it("animates the single guide avatar only during a registered local tool call", () => {
    const props = {
      agentDisplayName: "Maya Host",
      agentColor: "#5965e8",
      connectorRoutes: {},
      room,
      runtime,
      viewport,
      walkthrough,
      onStepChange: vi.fn(),
      onExit: vi.fn(),
      onDisplayed: vi.fn(),
    };
    const rendered = render(<GuidedWalkthroughOverlay {...props} />);

    const overlay = screen.getByTestId("guided-walkthrough");
    expect(overlay.querySelector('[data-local-tool-activity="false"]')).not.toBeNull();
    expect(overlay.querySelectorAll("[data-agent-avatar-state]")).toHaveLength(1);
    expect(overlay.querySelector('[data-agent-avatar-state="idle"]')).not.toBeNull();
    expect(overlay.querySelector('[data-agent-avatar-motion="hover"]')).not.toBeNull();

    rendered.rerender(<GuidedWalkthroughOverlay {...props} localToolActivityActive />);
    expect(overlay.querySelector('[data-local-tool-activity="true"]')).not.toBeNull();
    expect(overlay.querySelectorAll("[data-agent-avatar-state]")).toHaveLength(1);
    expect(overlay.querySelector('[data-agent-avatar-state="working"]')).not.toBeNull();
    expect(overlay.querySelector('[data-agent-avatar-motion="always"]')).not.toBeNull();
  });
});

describe("GuidedWalkthroughOverlay camera framing", () => {
  it("zooms in from a distant camera and reserves the caption panel band", () => {
    const distantViewport: Viewport = {
      x: 0,
      y: 0,
      width: 3_200,
      height: 2_400,
      zoom: 0.25,
    };
    const targetBounds = { x: 120, y: 80, width: 160, height: 80 };
    const frame = walkthroughCameraFrame(targetBounds, distantViewport, "bottom", 160);
    const pixelHeight = distantViewport.height * distantViewport.zoom;
    const targetCenterY = targetBounds.y + targetBounds.height / 2;
    const frameCenterY = frame.bounds.y + frame.bounds.height / 2;
    const projectedComfortableTop = pixelHeight / 2
      + (targetCenterY - 150 - frameCenterY) * frame.targetZoom;
    const projectedComfortableBottom = pixelHeight / 2
      + (targetCenterY + 150 - frameCenterY) * frame.targetZoom;

    expect(frame.targetZoom).toBeGreaterThan(distantViewport.zoom);
    expect(projectedComfortableTop).toBeCloseTo(32);
    expect(projectedComfortableBottom).toBeCloseTo(324);
    expect(projectedComfortableBottom).toBeLessThanOrEqual(600 - 92 - 160 - 24);

    const topFrame = walkthroughCameraFrame(targetBounds, distantViewport, "top", 160);
    const topFrameCenterY = topFrame.bounds.y + topFrame.bounds.height / 2;
    const topProjectedComfortableTop = pixelHeight / 2
      + (targetCenterY - 150 - topFrameCenterY) * topFrame.targetZoom;
    expect(topProjectedComfortableTop).toBeGreaterThanOrEqual(18 + 160 + 24);
  });

  it("frames once for the active step, leaves manual camera changes alone, and reframes the next step", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 508,
      height: 160,
      left: 210,
      right: 590,
      top: 348,
      width: 380,
      x: 210,
      y: 348,
      toJSON: () => ({}),
    });
    let currentViewport: Viewport = {
      x: 0,
      y: 0,
      width: 3_200,
      height: 2_400,
      zoom: 0.25,
    };
    const targetBounds = { x: 120, y: 80, width: 160, height: 80 };
    const zoomToBounds = vi.fn();
    const framingRuntime = {
      getViewport: () => currentViewport,
      getVisibleBounds: () => targetBounds,
      getObjectBounds: () => targetBounds,
      hasObject: () => true,
      pageToViewport: (point: { x: number; y: number }) => ({
        x: (point.x - currentViewport.x) * currentViewport.zoom,
        y: (point.y - currentViewport.y) * currentViewport.zoom,
      }),
      zoomToBounds,
    } as unknown as CanvasRuntime;
    const targetRoom = {
      ...room,
      objects: {
        target: {
          id: "target",
          kind: "shape",
          x: targetBounds.x,
          y: targetBounds.y,
          width: targetBounds.width,
          height: targetBounds.height,
          rotation: 0,
          zIndex: 1,
          revision: 1,
          groupId: null,
          diagramIds: [],
          createdAt: 1,
          updatedAt: 1,
          createdBy: { participantId: "agent", displayName: "Maya", color: "#5965e8", kind: "agent" },
          lastEditedBy: { participantId: "agent", displayName: "Maya", color: "#5965e8", kind: "agent" },
          shape: "rectangle",
          nodeType: null,
          label: "Target",
          fill: "light-violet",
          stroke: "blue",
        },
      },
    } as RoomState;
    const targetWalkthrough: GuidedWalkthrough = {
      ...walkthrough,
      steps: [{ caption: "Inspect target", objectIds: ["target"], connectorIds: [] }],
    };
    const props = {
      agentDisplayName: "Maya Host",
      agentColor: "#5965e8",
      connectorRoutes: {},
      room: targetRoom,
      runtime: framingRuntime,
      viewport: currentViewport,
      walkthrough: targetWalkthrough,
      onStepChange: vi.fn(),
      onExit: vi.fn(),
      onDisplayed: vi.fn(),
    };
    const rendered = render(<GuidedWalkthroughOverlay {...props} />);

    expect(zoomToBounds).toHaveBeenCalledTimes(1);
    expect(zoomToBounds.mock.calls[0]?.[1]).toMatchObject({
      targetZoom: expect.any(Number),
      force: true,
      publishPresence: false,
    });
    expect(zoomToBounds.mock.calls[0]?.[1].targetZoom).toBeGreaterThan(currentViewport.zoom);

    currentViewport = { x: 40, y: 20, width: 800, height: 600, zoom: 1 };
    rendered.rerender(<GuidedWalkthroughOverlay {...props} viewport={currentViewport} />);
    expect(zoomToBounds).toHaveBeenCalledTimes(1);

    rendered.rerender(<GuidedWalkthroughOverlay
      {...props}
      viewport={currentViewport}
      walkthrough={{
        ...targetWalkthrough,
        revision: 2,
        currentStepIndex: 1,
        steps: [...targetWalkthrough.steps, {
          caption: "Inspect target again",
          objectIds: ["target"],
          connectorIds: [],
        }],
      }}
    />);
    expect(zoomToBounds).toHaveBeenCalledTimes(2);
  });
});
