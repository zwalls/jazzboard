import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { CanvasObject, RoomState } from "@/lib/domain/types";

import type { CanvasInspectionArtifact, CanvasPreviewArtifact } from "./canvas-preview";
import { disposeLiveCanvasPreviews, presentLiveCanvasPreview } from "./live-canvas-preview";

const CREATED_AT = 10_000;

function object(revision = 3, createdAt = CREATED_AT): CanvasObject {
  const actor = {
    participantId: "alice",
    displayName: "Alice",
    color: "#5965e8",
    kind: "agent" as const,
  };
  return {
    id: "object-a",
    kind: "shape",
    x: 10,
    y: 20,
    width: 320,
    height: 180,
    rotation: 0,
    zIndex: 1,
    groupId: null,
    diagramIds: [],
    revision,
    createdAt,
    updatedAt: CREATED_AT,
    createdBy: actor,
    lastEditedBy: actor,
    shape: "rectangle",
    nodeType: "component",
    label: "Object A",
    fill: "blue",
    stroke: "blue",
  };
}

function room(current = object()): RoomState {
  return {
    id: "room-1",
    code: "ABC234",
    title: "Inspection room",
    roomRevision: 12,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    participants: {},
    objects: { [current.id]: current },
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function artifact(): CanvasPreviewArtifact {
  return {
    blob: new Blob(["preview"], { type: "image/png" }),
    metadata: {
      mimeType: "image/png",
      width: 640,
      height: 360,
      logicalWidth: 640,
      logicalHeight: 360,
      byteLength: 7,
      renderedBounds: { x: 10, y: 20, width: 320, height: 180 },
      padding: 32,
      pixelRatio: 1,
      source: {
        kind: "objects",
        targets: [{ objectId: "object-a", expectedRevision: 3 }],
        roomRevision: 12,
        objectRevisions: [{ objectId: "object-a", revision: 3 }],
        objectIncarnations: [{ objectId: "object-a", revision: 3, createdAt: CREATED_AT }],
      },
      warnings: [],
      visualQuality: null,
    },
  };
}

function inspectionArtifact(): CanvasInspectionArtifact {
  const preview = artifact().metadata;
  return {
    metadata: {
      renderedBounds: preview.renderedBounds,
      padding: preview.padding,
      source: preview.source,
      warnings: preview.warnings,
      visualQuality: preview.visualQuality,
    },
  };
}

function draft(): AgentCanvasDraftSnapshot {
  return {
    schemaVersion: 1,
    id: "draft_exact",
    roomId: "room-1",
    ownerParticipantId: "alice",
    author: {
      participantId: "alice",
      displayName: "Alice",
      color: "#5965e8",
      kind: "agent",
    },
    revision: 2,
    baselineRoomRevision: 12,
    status: "active",
    temporaryReferences: { node: "draft-object" },
    previewObjects: [{ ...object(), id: "draft-object", authority: "draft" }],
    previewDiagrams: [],
    metadata: null,
    createdAt: CREATED_AT - 100,
    updatedAt: CREATED_AT,
    expiresAt: 40_000,
    hardExpiresAt: 80_000,
  };
}

function draftInspectionArtifact(candidate = draft()): CanvasInspectionArtifact {
  return {
    metadata: {
      renderedBounds: { x: 10, y: 20, width: 320, height: 180 },
      padding: 32,
      source: {
        kind: "draft",
        draftId: candidate.id,
        expectedDraftRevision: candidate.revision,
        roomRevision: 12,
        objectRevisions: candidate.previewObjects.map((item) => ({
          objectId: item.id,
          revision: item.revision,
        })),
        objectIncarnations: candidate.previewObjects.map((item) => ({
          objectId: item.id,
          revision: item.revision,
          createdAt: item.createdAt,
        })),
        draftCreatedAt: candidate.createdAt,
        draftExpiresAt: candidate.expiresAt,
        draftHardExpiresAt: candidate.hardExpiresAt,
      },
      warnings: [],
      visualQuality: null,
    },
  };
}

function runtime(overrides: Partial<CanvasRuntime> = {}): CanvasRuntime {
  return {
    rendererId: "jazzboard-semantic-v1",
    capabilities: { renderPng: true },
    getViewport: () => ({ x: 0, y: 0, width: 800, height: 600, zoom: 1 }),
    pageToViewport: (point) => ({
      x: (point.x - 10) * 2 + 72,
      y: (point.y - 20) * 2 + 72,
    }),
    viewportToPage: (point) => point,
    getDocumentObjectIds: () => [],
    getSelectedObjectIds: () => [],
    hasObject: () => true,
    getObjectBounds: () => null,
    getVisibleBounds: () => null,
    onDocumentChange: () => () => undefined,
    selectObjects: () => undefined,
    zoomToBounds: vi.fn(),
    isObjectRenderedExact: () => true,
    isObjectProjectionExact: () => true,
    renderPng: vi.fn(),
    ...overrides,
  };
}

function canvasElement(rect: Partial<DOMRect> = {}): HTMLElement {
  const element = document.createElement("div");
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 100,
    y: 50,
    left: 100,
    top: 50,
    right: 900,
    bottom: 650,
    width: 800,
    height: 600,
    toJSON: () => ({}),
    ...rect,
  });
  return element;
}

function host(
  canvas: CanvasRuntime,
  element: HTMLElement,
  options: {
    getRoom?: () => RoomState | null;
    getAgentDraft?: (draftId: string) => AgentCanvasDraftSnapshot | null;
    isCameraFollowActive?: () => boolean;
    now?: () => number;
    setCleanInspection?: (
      previewId: string | null,
      draftScope?: { draftId: string; expectedDraftRevision: number },
    ) => void;
  } = {},
) {
  return {
    getCanvasRuntime: () => canvas,
    getCanvasElement: () => element,
    getRoom: options.getRoom ?? (() => room()),
    ...(options.getAgentDraft ? { getAgentDraft: options.getAgentDraft } : {}),
    isCameraFollowActive: options.isCameraFollowActive ?? (() => false),
    ...(options.setCleanInspection ? { setCleanInspection: options.setCleanInspection } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
}

describe("presentLiveCanvasPreview", () => {
  let frames: Array<FrameRequestCallback> = [];

  beforeEach(() => {
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("11111111-2222-4333-8444-555555555555");
  });

  afterEach(() => {
    disposeLiveCanvasPreviews();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function paintTwice() {
    frames.shift()?.(performance.now());
    await Promise.resolve();
    frames.shift()?.(performance.now());
    await Promise.resolve();
  }

  it("combines a non-zero canvas client offset with viewport-local scope coordinates", async () => {
    const canvas = runtime();
    const element = canvasElement();
    const presentation = presentLiveCanvasPreview(
      host(canvas, element, { now: () => 10_000 }),
      artifact(),
      new AbortController().signal,
    );

    expect(canvas.zoomToBounds).toHaveBeenCalledWith(
      { x: 10, y: 20, width: 320, height: 180 },
      { inset: 72, durationMs: 0, force: true, publishPresence: false },
    );
    await paintTwice();

    await expect(presentation).resolves.toEqual({
      previewId: "preview_11111111-2222-4333-8444-555555555555",
      clip: {
        coordinateSpace: "viewport-css-pixels",
        x: 172,
        y: 122,
        width: 640,
        height: 360,
      },
      expiresAt: 70_000,
      validation: {
        token: "preview_11111111-2222-4333-8444-555555555555",
        activeSelector: '[data-canvas-inspection-token="preview_11111111-2222-4333-8444-555555555555"]',
        status: "valid_until_invalidated",
      },
    });
    expect(document.querySelector('[role="dialog"][aria-label="Canvas preview"]')).toBeNull();
  });

  it("keeps metadata-only inspection capture valid for sixty seconds", async () => {
    const canvas = runtime();
    const element = canvasElement();
    const presentation = presentLiveCanvasPreview(
      host(canvas, element, { now: () => 10_000 }),
      inspectionArtifact(),
      new AbortController().signal,
    );
    await paintTwice();

    await expect(presentation).resolves.toMatchObject({
      expiresAt: 70_000,
      validation: { status: "valid_until_invalidated" },
    });
  });

  it("presents an exact draft as a clean local scene and bounds the lease by draft expiry", async () => {
    const candidate = draft();
    const canvas = runtime({
      isObjectProjectionExact: (current) => current.id === candidate.previewObjects[0].id,
    });
    const element = canvasElement();
    const setCleanInspection = vi.fn();
    const presentation = presentLiveCanvasPreview(
      host(canvas, element, {
        getAgentDraft: () => candidate,
        now: () => 10_000,
        setCleanInspection,
      }),
      draftInspectionArtifact(candidate),
      new AbortController().signal,
    );
    await paintTwice();

    await expect(presentation).resolves.toMatchObject({ expiresAt: candidate.expiresAt });
    expect(setCleanInspection).toHaveBeenCalledWith("preview_11111111-2222-4333-8444-555555555555", {
      draftId: candidate.id,
      expectedDraftRevision: candidate.revision,
    });
  });

  it("discards draft inspection framing when the visible candidate revision changes before paint", async () => {
    const candidate = draft();
    let visibleDraft = candidate;
    const canvas = runtime({ isObjectProjectionExact: () => true });
    const element = canvasElement();
    const setCleanInspection = vi.fn();
    const presentation = presentLiveCanvasPreview(
      host(canvas, element, {
        getAgentDraft: () => visibleDraft,
        now: () => 10_000,
        setCleanInspection,
      }),
      draftInspectionArtifact(candidate),
      new AbortController().signal,
    );
    frames.shift()?.(performance.now());
    await Promise.resolve();
    visibleDraft = { ...candidate, revision: candidate.revision + 1 };
    frames.shift()?.(performance.now());
    await Promise.resolve();

    await expect(presentation).rejects.toMatchObject({
      code: "PREVIEW_SCOPE_CHANGED_DURING_PRESENTATION",
    });
    expect(setCleanInspection).toHaveBeenLastCalledWith(null);
  });

  it("rejects rather than returning a clip that omits part of the requested scope", async () => {
    const canvas = runtime({
      pageToViewport: (point) => ({ x: point.x * 10, y: point.y * 10 }),
    });
    const element = canvasElement({ right: 500, bottom: 350, width: 400, height: 300 });
    const presentation = presentLiveCanvasPreview(
      host(canvas, element),
      artifact(),
      new AbortController().signal,
    );
    await paintTwice();
    await expect(presentation).rejects.toMatchObject({
      code: "PREVIEW_SCOPE_TOO_LARGE_FOR_LIVE_CANVAS",
    });
  });

  it("honors cancellation while waiting for the live canvas to paint", async () => {
    const canvas = runtime();
    const element = canvasElement();
    const controller = new AbortController();
    const presentation = presentLiveCanvasPreview(
      host(canvas, element),
      artifact(),
      controller.signal,
    );
    controller.abort();
    await expect(presentation).rejects.toMatchObject({ name: "AbortError" });
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    expect(canvas.zoomToBounds).toHaveBeenLastCalledWith(
      { x: 0, y: 0, width: 800, height: 600 },
      { targetZoom: 1, durationMs: 0, force: true, publishPresence: false },
    );
  });

  it("revalidates exact revisions after paint and restores the prior camera on drift", async () => {
    const canvas = runtime();
    const element = canvasElement();
    let currentRoom = room();
    const presentation = presentLiveCanvasPreview(
      host(canvas, element, { getRoom: () => currentRoom }),
      artifact(),
      new AbortController().signal,
    );
    frames.shift()?.(performance.now());
    await Promise.resolve();
    currentRoom = room(object(4));
    frames.shift()?.(performance.now());
    await Promise.resolve();

    await expect(presentation).rejects.toMatchObject({
      code: "PREVIEW_SCOPE_CHANGED_DURING_PRESENTATION",
    });
    expect(canvas.zoomToBounds).toHaveBeenLastCalledWith(
      { x: 0, y: 0, width: 800, height: 600 },
      { targetZoom: 1, durationMs: 0, force: true, publishPresence: false },
    );
  });

  it("does not move the local camera while Follow or Spotlight is active", async () => {
    const canvas = runtime();
    const element = canvasElement();
    await expect(presentLiveCanvasPreview(
      host(canvas, element, { isCameraFollowActive: () => true }),
      artifact(),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "PREVIEW_CAMERA_FOLLOW_ACTIVE" });
    expect(canvas.zoomToBounds).not.toHaveBeenCalled();
  });

  it("holds a clean token until invalidation, then restores camera and UI", async () => {
    const canvas = runtime();
    const element = canvasElement();
    const setCleanInspection = vi.fn();
    const presentation = presentLiveCanvasPreview(
      host(canvas, element, { setCleanInspection }),
      artifact(),
      new AbortController().signal,
    );
    await paintTwice();
    const result = await presentation;

    expect(setCleanInspection).toHaveBeenCalledWith(result.previewId);
    expect(element.dataset.canvasInspectionToken).toBe(result.previewId);
    window.dispatchEvent(new Event("pointerdown"));
    expect(setCleanInspection).toHaveBeenLastCalledWith(null);
    expect(element.dataset.canvasInspectionToken).toBeUndefined();
    expect(canvas.zoomToBounds).toHaveBeenLastCalledWith(
      { x: 0, y: 0, width: 800, height: 600 },
      { targetZoom: 1, durationMs: 0, force: true, publishPresence: false },
    );
  });

  it("ignores screenshot-like transient geometry changes but invalidates settled changes", async () => {
    const canvas = runtime();
    const element = canvasElement();
    const roomElement = document.createElement("main");
    roomElement.dataset.jazzboardRoom = "";
    roomElement.append(element);
    document.body.append(roomElement);
    const setCleanInspection = vi.fn();
    const innerWidth = vi.spyOn(window, "innerWidth", "get").mockReturnValue(1_000);
    const visualViewport = Object.assign(new EventTarget(), {
      width: 1_000,
      height: 700,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 1,
    });
    vi.stubGlobal("visualViewport", visualViewport);
    const presentation = presentLiveCanvasPreview(
      host(canvas, element, { setCleanInspection }),
      artifact(),
      new AbortController().signal,
    );
    await paintTwice();
    const result = await presentation;

    expect(roomElement.dataset.cleanCanvasInspectionToken).toBe(result.previewId);
    visualViewport.width = 999;
    visualViewport.dispatchEvent(new Event("resize"));
    // captureBeyondViewport restores the original metrics before the browser
    // is able to paint the screenshot response.
    visualViewport.width = 1_000;
    await paintTwice();
    expect(element.dataset.canvasInspectionToken).toBe(result.previewId);
    expect(roomElement.dataset.cleanCanvasInspectionToken).toBe(result.previewId);
    expect(setCleanInspection).not.toHaveBeenCalledWith(null);
    expect(canvas.zoomToBounds).toHaveBeenCalledTimes(1);

    innerWidth.mockReturnValue(999);
    window.dispatchEvent(new Event("resize"));
    await paintTwice();
    expect(element.dataset.canvasInspectionToken).toBeUndefined();
    expect(roomElement.dataset.cleanCanvasInspectionToken).toBeUndefined();
    expect(setCleanInspection).toHaveBeenLastCalledWith(null);
    expect(canvas.zoomToBounds).toHaveBeenLastCalledWith(
      { x: 0, y: 0, width: 800, height: 600 },
      { targetZoom: 1, durationMs: 0, force: true, publishPresence: false },
    );
    roomElement.remove();
  });
});
