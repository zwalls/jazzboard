import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { CanvasBounds, RoomState, Viewport } from "@/lib/domain/types";

import type {
  CanvasPresentationArtifact,
  CanvasPreviewPresentation,
} from "./canvas-preview";
import { CanvasPreviewError } from "./preview-contract";

const LIVE_CANVAS_CLIP_TTL_MS = 60_000;
const CLEAN_INSPECTION_CLIP_TTL_MS = 60_000;
const LIVE_CANVAS_FRAME_INSET = 72;

type ActiveInspectionLease = {
  canvasElement: HTMLElement;
  previewId: string;
  cleanup(): void;
};

const leasesByCanvas = new WeakMap<HTMLElement, ActiveInspectionLease>();
const activeLeases = new Set<ActiveInspectionLease>();

type InspectionGeometry = {
  canvas: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">;
  innerWidth: number;
  innerHeight: number;
  scrollX: number;
  scrollY: number;
  visualViewport: null | {
    width: number;
    height: number;
    offsetLeft: number;
    offsetTop: number;
    pageLeft: number;
    pageTop: number;
    scale: number;
  };
};

export type LiveCanvasPreviewHost = {
  getCanvasRuntime(): CanvasRuntime | null;
  getCanvasElement(): HTMLElement | null;
  getRoom(): RoomState | null;
  getAgentDraft?(draftId: string): AgentCanvasDraftSnapshot | null;
  isCameraFollowActive(): boolean;
  /** Locally suppress all non-authoritative canvas and room chrome. */
  setCleanInspection?(
    previewId: string | null,
    draftScope?: { draftId: string; expectedDraftRevision: number },
  ): void;
  now?: () => number;
};

function abortError(): DOMException {
  return new DOMException("The live canvas inspection was cancelled.", "AbortError");
}

function nextPaint(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const frame = window.requestAnimationFrame(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    const onAbort = () => {
      window.cancelAnimationFrame(frame);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createPreviewId(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `preview_${suffix}`;
}

function restoreViewport(runtime: CanvasRuntime, viewport: Viewport): void {
  runtime.zoomToBounds(
    { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
    {
      targetZoom: viewport.zoom,
      durationMs: 0,
      force: true,
      publishPresence: false,
    },
  );
}

function inspectionGeometry(canvasElement: HTMLElement): InspectionGeometry {
  const rect = canvasElement.getBoundingClientRect();
  const visualViewport = window.visualViewport;
  return {
    canvas: {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    },
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    visualViewport: visualViewport ? {
      width: visualViewport.width,
      height: visualViewport.height,
      offsetLeft: visualViewport.offsetLeft,
      offsetTop: visualViewport.offsetTop,
      pageLeft: visualViewport.pageLeft,
      pageTop: visualViewport.pageTop,
      scale: visualViewport.scale,
    } : null,
  };
}

function inspectionGeometryChanged(
  initial: InspectionGeometry,
  current: InspectionGeometry,
): boolean {
  const tolerance = 0.5;
  const changed = (left: number, right: number) => Math.abs(left - right) > tolerance;
  if (
    changed(initial.innerWidth, current.innerWidth)
    || changed(initial.innerHeight, current.innerHeight)
    || changed(initial.scrollX, current.scrollX)
    || changed(initial.scrollY, current.scrollY)
    || Object.keys(initial.canvas).some((key) => changed(
      initial.canvas[key as keyof InspectionGeometry["canvas"]],
      current.canvas[key as keyof InspectionGeometry["canvas"]],
    ))
  ) return true;
  if (!initial.visualViewport || !current.visualViewport) {
    return initial.visualViewport !== current.visualViewport;
  }
  return Object.keys(initial.visualViewport).some((key) => changed(
    initial.visualViewport![key as keyof NonNullable<InspectionGeometry["visualViewport"]>],
    current.visualViewport![key as keyof NonNullable<InspectionGeometry["visualViewport"]>],
  ));
}

function assertLiveScopeIsExact(
  host: LiveCanvasPreviewHost,
  runtime: CanvasRuntime,
  artifact: CanvasPresentationArtifact,
): void {
  const room = host.getRoom();
  if (!room) {
    throw new CanvasPreviewError(
      "PREVIEW_SCOPE_CHANGED_DURING_PRESENTATION",
      "The authorized room became unavailable while the live canvas was being framed.",
    );
  }
  const source = artifact.metadata.source;
  if (source.kind === "room" && room.roomRevision !== source.expectedRevision) {
    throw new CanvasPreviewError(
      "PREVIEW_SCOPE_CHANGED_DURING_PRESENTATION",
      "The room changed while the live canvas was being framed; capture a new exact scope.",
    );
  }
  if (source.kind === "diagram") {
    const diagram = room.diagrams[source.diagramId];
    if (!diagram || diagram.revision !== source.expectedRevision) {
      throw new CanvasPreviewError(
        "PREVIEW_SCOPE_CHANGED_DURING_PRESENTATION",
        `Diagram ${source.diagramId} changed while the live canvas was being framed.`,
      );
    }
  }

  const now = host.now ?? Date.now;
  const draft = source.kind === "draft" ? host.getAgentDraft?.(source.draftId) ?? null : null;
  if (source.kind === "draft") {
    if (
      room.roomRevision !== source.roomRevision
      || !draft
      || draft.roomId !== room.id
      || draft.revision !== source.expectedDraftRevision
      || (source.draftCreatedAt !== undefined && draft.createdAt !== source.draftCreatedAt)
      || draft.expiresAt <= now()
      || draft.hardExpiresAt <= now()
    ) {
      throw new CanvasPreviewError(
        "PREVIEW_SCOPE_CHANGED_DURING_PRESENTATION",
        `Canvas draft ${source.draftId} changed while the live canvas was being framed.`,
      );
    }
  }

  const draftObjects = new Map(draft?.previewObjects.map((object) => [object.id, object]) ?? []);
  const expectedObjects = new Map([
    ...source.objectRevisions,
    ...(source.visualContributorRevisions ?? []),
  ].map((item) => [item.objectId, item]));
  const incarnationById = new Map([
    ...(source.objectIncarnations ?? []),
    ...(source.visualContributorIncarnations ?? []),
  ].map((item) => [item.objectId, item]));
  for (const expected of expectedObjects.values()) {
    const draftObject = draftObjects.get(expected.objectId);
    const current = draftObject ?? room.objects[expected.objectId];
    const incarnation = incarnationById.get(expected.objectId);
    const renderedExact = current
      ? draftObject
        ? runtime.isObjectRenderedExact(current)
        : runtime.isObjectProjectionExact(current)
      : false;
    if (
      !current
      || current.revision !== expected.revision
      || (incarnation && current.createdAt !== incarnation.createdAt)
      || !renderedExact
    ) {
      throw new CanvasPreviewError(
        "PREVIEW_SCOPE_CHANGED_DURING_PRESENTATION",
        `Canvas object ${expected.objectId} changed while the live canvas was being framed.`,
        {
          objectId: expected.objectId,
          expectedRevision: expected.revision,
          draftObject: Boolean(draftObject),
          renderedObject: runtime.hasObject(expected.objectId),
          renderedExact,
        },
      );
    }
  }
}

function installInspectionLease(input: {
  canvasElement: HTMLElement;
  host: LiveCanvasPreviewHost;
  previewId: string;
  previousViewport: Viewport;
  runtime: CanvasRuntime;
  ttlMs: number;
}): ActiveInspectionLease {
  leasesByCanvas.get(input.canvasElement)?.cleanup();
  const inspectionRoot = input.canvasElement.closest<HTMLElement>("[data-jazzboard-room]");
  const initialGeometry = inspectionGeometry(input.canvasElement);
  let active = true;
  const cleanupCallbacks: Array<() => void> = [];
  const lease: ActiveInspectionLease = {
    canvasElement: input.canvasElement,
    previewId: input.previewId,
    cleanup() {
      if (!active) return;
      active = false;
      for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
      if (input.canvasElement.dataset.canvasInspectionToken === input.previewId) {
        delete input.canvasElement.dataset.canvasInspectionToken;
      }
      if (inspectionRoot?.dataset.cleanCanvasInspectionToken === input.previewId) {
        delete inspectionRoot.dataset.cleanCanvasInspectionToken;
      }
      input.host.setCleanInspection?.(null);
      if (
        input.host.getCanvasRuntime() === input.runtime &&
        input.host.getCanvasElement() === input.canvasElement
      ) restoreViewport(input.runtime, input.previousViewport);
      if (leasesByCanvas.get(input.canvasElement) === lease) {
        leasesByCanvas.delete(input.canvasElement);
      }
      activeLeases.delete(lease);
    },
  };
  const timeout = window.setTimeout(() => lease.cleanup(), input.ttlMs);
  cleanupCallbacks.push(() => window.clearTimeout(timeout));
  cleanupCallbacks.push(input.runtime.onDocumentChange(() => lease.cleanup()));
  const invalidate = () => lease.cleanup();
  let firstGeometryFrame: number | null = null;
  let secondGeometryFrame: number | null = null;
  const cancelGeometryCheck = () => {
    if (firstGeometryFrame !== null) window.cancelAnimationFrame(firstGeometryFrame);
    if (secondGeometryFrame !== null) window.cancelAnimationFrame(secondGeometryFrame);
    firstGeometryFrame = null;
    secondGeometryFrame = null;
  };
  cleanupCallbacks.push(cancelGeometryCheck);
  const invalidateIfGeometryChanged = () => {
    // Page.captureScreenshot({captureBeyondViewport:true}) can temporarily
    // perturb layout/visual-viewport metrics while taking a clipped image.
    // Check after two settled paints so that browser-internal geometry is
    // restored, while persistent user/layout changes still invalidate.
    cancelGeometryCheck();
    firstGeometryFrame = window.requestAnimationFrame(() => {
      firstGeometryFrame = null;
      secondGeometryFrame = window.requestAnimationFrame(() => {
        secondGeometryFrame = null;
        if (inspectionGeometryChanged(initialGeometry, inspectionGeometry(input.canvasElement))) {
          lease.cleanup();
        }
      });
    });
  };
  for (const eventName of ["pointerdown", "wheel", "keydown"] as const) {
    window.addEventListener(eventName, invalidate, { capture: true, once: true });
    cleanupCallbacks.push(() => window.removeEventListener(eventName, invalidate, { capture: true }));
  }
  for (const eventName of ["resize", "scroll"] as const) {
    window.addEventListener(eventName, invalidateIfGeometryChanged, { capture: true });
    cleanupCallbacks.push(() => window.removeEventListener(eventName, invalidateIfGeometryChanged, { capture: true }));
  }
  const visualViewport = window.visualViewport;
  if (visualViewport) {
    visualViewport.addEventListener("resize", invalidateIfGeometryChanged);
    visualViewport.addEventListener("scroll", invalidateIfGeometryChanged);
    cleanupCallbacks.push(() => {
      visualViewport.removeEventListener("resize", invalidateIfGeometryChanged);
      visualViewport.removeEventListener("scroll", invalidateIfGeometryChanged);
    });
  }
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => invalidateIfGeometryChanged());
    observer.observe(input.canvasElement);
    cleanupCallbacks.push(() => observer.disconnect());
  }
  if (inspectionRoot) inspectionRoot.dataset.cleanCanvasInspectionToken = input.previewId;
  leasesByCanvas.set(input.canvasElement, lease);
  activeLeases.add(lease);
  return lease;
}

/** Clears every short-lived clean presentation owned by this browser tab. */
export function disposeLiveCanvasPreviews(): void {
  for (const lease of [...activeLeases]) lease.cleanup();
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function liveCanvasClip(
  runtime: CanvasRuntime,
  canvasElement: HTMLElement,
  bounds: CanvasBounds,
): CanvasPreviewPresentation["clip"] {
  const canvasRect = canvasElement.getBoundingClientRect();
  if (!finitePositive(canvasRect.width) || !finitePositive(canvasRect.height)) {
    throw new CanvasPreviewError(
      "PREVIEW_PRESENTER_UNAVAILABLE",
      "The live canvas is not visible enough to inspect.",
    );
  }

  const topLeft = runtime.pageToViewport({ x: bounds.x, y: bounds.y });
  const bottomRight = runtime.pageToViewport({
    x: bounds.x + bounds.width,
    y: bounds.y + bounds.height,
  });
  const rawLeft = canvasRect.left + Math.min(topLeft.x, bottomRight.x);
  const rawTop = canvasRect.top + Math.min(topLeft.y, bottomRight.y);
  const rawRight = canvasRect.left + Math.max(topLeft.x, bottomRight.x);
  const rawBottom = canvasRect.top + Math.max(topLeft.y, bottomRight.y);
  const viewportRight = Math.min(window.innerWidth, canvasRect.right);
  const viewportBottom = Math.min(window.innerHeight, canvasRect.bottom);
  const left = Math.max(0, canvasRect.left, rawLeft);
  const top = Math.max(0, canvasRect.top, rawTop);
  const right = Math.min(viewportRight, rawRight);
  const bottom = Math.min(viewportBottom, rawBottom);
  const width = right - left;
  const height = bottom - top;

  if (!finitePositive(width) || !finitePositive(height)) {
    throw new CanvasPreviewError(
      "PREVIEW_BOUNDS_UNAVAILABLE",
      "Jazzboard could not frame the requested objects on the live canvas.",
    );
  }

  // A clipped edge would silently omit part of the requested semantic scope.
  // Reject it instead so the caller can inspect a smaller exact scope.
  const tolerance = 1;
  if (
    rawLeft < left - tolerance
    || rawTop < top - tolerance
    || rawRight > right + tolerance
    || rawBottom > bottom + tolerance
  ) {
    throw new CanvasPreviewError(
      "PREVIEW_SCOPE_TOO_LARGE_FOR_LIVE_CANVAS",
      "The requested scope cannot fit completely in the live canvas viewport; inspect a smaller exact scope.",
      { pageBounds: bounds },
    );
  }

  return {
    coordinateSpace: "viewport-css-pixels",
    x: left,
    y: top,
    width,
    height,
  };
}

/**
 * Frames an exact rendered scope on Jazzboard's existing canvas and returns a
 * browser screenshot clip. No duplicate image, modal, URL, or persisted asset
 * is created. The clip is valid only while the live viewport remains still.
 */
export async function presentLiveCanvasPreview(
  host: LiveCanvasPreviewHost,
  artifact: CanvasPresentationArtifact,
  signal: AbortSignal,
): Promise<CanvasPreviewPresentation> {
  if (signal.aborted) throw abortError();
  const runtime = host.getCanvasRuntime();
  const canvasElement = host.getCanvasElement();
  if (!runtime || !canvasElement) {
    throw new CanvasPreviewError(
      "PREVIEW_PRESENTER_UNAVAILABLE",
      "The live canvas is not available for inspection.",
    );
  }
  if (host.isCameraFollowActive()) {
    throw new CanvasPreviewError(
      "PREVIEW_CAMERA_FOLLOW_ACTIVE",
      "Stop Follow or leave the active Spotlight before framing a live canvas inspection.",
    );
  }

  const { renderedBounds } = artifact.metadata;
  if (!finitePositive(renderedBounds.width) || !finitePositive(renderedBounds.height)) {
    throw new CanvasPreviewError(
      "PREVIEW_BOUNDS_UNAVAILABLE",
      "Jazzboard could not determine visible bounds for the requested scope.",
    );
  }

  const canvasRect = canvasElement.getBoundingClientRect();
  const inset = Math.max(
    8,
    Math.min(
      LIVE_CANVAS_FRAME_INSET,
      Math.floor((Math.min(canvasRect.width, canvasRect.height) - 64) / 2),
    ),
  );
  const previousViewport = runtime.getViewport();
  const previewId = createPreviewId();
  const inspectionRoot = canvasElement.closest<HTMLElement>("[data-jazzboard-room]");
  let cleanInspectionApplied = false;
  try {
    leasesByCanvas.get(canvasElement)?.cleanup();
    canvasElement.dataset.canvasInspectionToken = previewId;
    if (inspectionRoot) inspectionRoot.dataset.cleanCanvasInspectionToken = previewId;
    if (artifact.metadata.source.kind === "draft") {
      host.setCleanInspection?.(previewId, {
        draftId: artifact.metadata.source.draftId,
        expectedDraftRevision: artifact.metadata.source.expectedDraftRevision,
      });
    } else {
      host.setCleanInspection?.(previewId);
    }
    cleanInspectionApplied = true;
    runtime.zoomToBounds(renderedBounds, {
      inset,
      durationMs: 0,
      force: true,
      publishPresence: false,
    });

    // React commits the camera transform on the next paint. A second frame
    // makes the returned coordinates safe for an immediate browser screenshot.
    await nextPaint(signal);
    await nextPaint(signal);
    if (host.getCanvasRuntime() !== runtime || host.getCanvasElement() !== canvasElement) {
      throw new CanvasPreviewError(
        "PREVIEW_PRESENTER_UNAVAILABLE",
        "The live canvas changed while the inspection region was being framed.",
      );
    }
    if (host.isCameraFollowActive()) {
      throw new CanvasPreviewError(
        "PREVIEW_CAMERA_FOLLOW_ACTIVE",
        "Follow or Spotlight became active while the live canvas was being framed.",
      );
    }
    assertLiveScopeIsExact(host, runtime, artifact);

    const now = host.now ?? Date.now;
    const clip = liveCanvasClip(runtime, canvasElement, renderedBounds);
    const baseTtlMs = "blob" in artifact ? LIVE_CANVAS_CLIP_TTL_MS : CLEAN_INSPECTION_CLIP_TTL_MS;
    const draftExpiry = artifact.metadata.source.kind === "draft"
      ? Math.min(
          artifact.metadata.source.draftExpiresAt ?? Number.POSITIVE_INFINITY,
          artifact.metadata.source.draftHardExpiresAt ?? Number.POSITIVE_INFINITY,
        )
      : Number.POSITIVE_INFINITY;
    const ttlMs = Math.min(baseTtlMs, Math.max(1, draftExpiry - now()));
    installInspectionLease({ canvasElement, host, previewId, previousViewport, runtime, ttlMs });
    return {
      previewId,
      clip,
      expiresAt: now() + ttlMs,
      validation: {
        token: previewId,
        activeSelector: `[data-canvas-inspection-token="${previewId}"]`,
        status: "valid_until_invalidated",
      },
    };
  } catch (error) {
    if (cleanInspectionApplied && canvasElement.dataset.canvasInspectionToken === previewId) {
      delete canvasElement.dataset.canvasInspectionToken;
      host.setCleanInspection?.(null);
    }
    if (inspectionRoot?.dataset.cleanCanvasInspectionToken === previewId) {
      delete inspectionRoot.dataset.cleanCanvasInspectionToken;
    }
    if (host.getCanvasRuntime() === runtime && host.getCanvasElement() === canvasElement) {
      restoreViewport(runtime, previousViewport);
    }
    throw error;
  }
}
