import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { CanvasBounds, RoomState, Viewport } from "@/lib/domain/types";

import type {
  CanvasPreviewArtifact,
  CanvasPreviewPresentation,
} from "./canvas-preview";
import { CanvasPreviewError } from "./preview-contract";

const LIVE_CANVAS_CLIP_TTL_MS = 60_000;
const LIVE_CANVAS_FRAME_INSET = 72;

export type LiveCanvasPreviewHost = {
  getCanvasRuntime(): CanvasRuntime | null;
  getCanvasElement(): HTMLElement | null;
  getRoom(): RoomState | null;
  isCameraFollowActive(): boolean;
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

function assertLiveScopeIsExact(
  host: LiveCanvasPreviewHost,
  runtime: CanvasRuntime,
  artifact: CanvasPreviewArtifact,
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

  const incarnationById = new Map(
    source.objectIncarnations?.map((item) => [item.objectId, item]) ?? [],
  );
  for (const expected of source.objectRevisions) {
    const current = room.objects[expected.objectId];
    const incarnation = incarnationById.get(expected.objectId);
    if (
      !current
      || current.revision !== expected.revision
      || (incarnation && current.createdAt !== incarnation.createdAt)
      || !runtime.isObjectProjectionExact(current)
    ) {
      throw new CanvasPreviewError(
        "PREVIEW_SCOPE_CHANGED_DURING_PRESENTATION",
        `Canvas object ${expected.objectId} changed while the live canvas was being framed.`,
        { objectId: expected.objectId, expectedRevision: expected.revision },
      );
    }
  }
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
  artifact: CanvasPreviewArtifact,
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
  try {
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
    return {
      previewId: createPreviewId(),
      clip: liveCanvasClip(runtime, canvasElement, renderedBounds),
      expiresAt: now() + LIVE_CANVAS_CLIP_TTL_MS,
    };
  } catch (error) {
    if (host.getCanvasRuntime() === runtime && host.getCanvasElement() === canvasElement) {
      restoreViewport(runtime, previousViewport);
    }
    throw error;
  }
}
