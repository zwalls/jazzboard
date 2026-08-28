import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { CanvasObject, Diagram, RoomState } from "@/lib/domain/types";

import {
  CANVAS_PREVIEW_LIMITS,
  CanvasPreviewError,
} from "./preview-contract";

export {
  CANVAS_PREVIEW_DEFAULTS,
  CANVAS_PREVIEW_LIMITS,
  CanvasPreviewError,
} from "./preview-contract";

export type CanvasPreviewSource =
  | {
      kind: "room";
      expectedRevision: number;
    }
  | {
      kind: "objects";
      targets: Array<{ objectId: string; expectedRevision: number }>;
    }
  | {
      kind: "diagram";
      diagramId: string;
      expectedRevision: number;
    };

export type CanvasPreviewRenderOptions = {
  padding: number;
  maxWidth: number;
  maxHeight: number;
  pixelRatio: number;
  maxBytes: number;
};

/** An exact, authoritative scope resolved by the tool before UI rendering begins. */
export type CanvasPreviewRenderRequest = {
  roomId: string;
  authoritativeRoomRevision: number;
  source: CanvasPreviewSource;
  objects: CanvasObject[];
  diagram: Diagram | null;
  options: CanvasPreviewRenderOptions;
};

export type CanvasPreviewMetadata = {
  mimeType: "image/png";
  width: number;
  height: number;
  logicalWidth: number;
  logicalHeight: number;
  byteLength: number;
  renderedBounds: { x: number; y: number; width: number; height: number };
  padding: number;
  pixelRatio: number;
  source: CanvasPreviewSource & {
    roomRevision: number;
    objectRevisions: Array<{ objectId: string; revision: number }>;
  };
  warnings: string[];
};

export type CanvasPreviewArtifact = {
  blob: Blob;
  metadata: CanvasPreviewMetadata;
};

export type CanvasPreviewPresentation = {
  previewId: string;
  clip: {
    coordinateSpace: "viewport-css-pixels";
    x: number;
    y: number;
    width: number;
    height: number;
  };
  expiresAt: number;
};

export type CanvasPreviewPresenter = (
  input: CanvasPreviewArtifact,
  signal: AbortSignal,
) => Promise<CanvasPreviewPresentation>;

/**
 * Host-owned multimodal delivery boundary. Implementations receive an
 * ephemeral Blob plus JSON-safe metadata, delegates to a local-only presenter,
 * and returns the complete WebMCP tool result. It must not persist the image or
 * replace it with a public/private provider URL.
 */
export interface CanvasPreviewTransportAdapter {
  emit(
    input: CanvasPreviewArtifact,
    present: CanvasPreviewPresenter,
    signal: AbortSignal,
  ): Promise<unknown>;
  dispose?(): void;
}

type CanvasPreviewRuntime = {
  getCanvasRuntime(): CanvasRuntime | null;
  getRoom(): RoomState | null;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

function abortError(): DOMException {
  return new DOMException("The canvas preview was cancelled.", "AbortError");
}

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertScopeHasNotAdvanced(room: RoomState, request: CanvasPreviewRenderRequest): void {
  if (room.id !== request.roomId) {
    throw new CanvasPreviewError("PREVIEW_ROOM_CHANGED", "The open Jazzboard room changed before it could be rendered.", {
      expectedRoomId: request.roomId,
      actualRoomId: room.id,
    });
  }

  if (request.source.kind === "room" && room.roomRevision > request.source.expectedRevision) {
    throw new CanvasPreviewError(
      "ROOM_REVISION_CONFLICT",
      "The Jazzboard room changed before its PNG could be rendered.",
      {
        expectedRevision: request.source.expectedRevision,
        actualRevision: room.roomRevision,
      },
    );
  }

  if (request.source.kind === "diagram") {
    const diagram = room.diagrams[request.source.diagramId];
    if (!diagram) {
      throw new CanvasPreviewError(
        "DIAGRAM_NOT_FOUND",
        `Diagram ${request.source.diagramId} was removed before its preview could be rendered.`,
        { diagramId: request.source.diagramId },
      );
    }
    if (diagram.revision > request.source.expectedRevision) {
      throw new CanvasPreviewError(
        "DIAGRAM_REVISION_CONFLICT",
        `Diagram ${request.source.diagramId} changed before its preview was rendered.`,
        {
          diagramId: request.source.diagramId,
          expectedRevision: request.source.expectedRevision,
          actualRevision: diagram.revision,
        },
      );
    }
  }

  for (const expected of request.objects) {
    const current = room.objects[expected.id];
    if (!current || current.createdAt !== expected.createdAt) {
      throw new CanvasPreviewError(
        "PREVIEW_SCOPE_CHANGED",
        `Canvas object ${expected.id} was removed or replaced before its preview could be rendered.`,
        { objectId: expected.id },
      );
    }
    if (current.revision > expected.revision) {
      throw new CanvasPreviewError(
        "OBJECT_REVISION_CONFLICT",
        `Canvas object ${expected.id} changed before its preview was rendered.`,
        {
          objectId: expected.id,
          expectedRevision: expected.revision,
          actualRevision: current.revision,
        },
      );
    }
  }
}

function isAuthoritativeScopeProjected(
  canvas: CanvasRuntime,
  room: RoomState,
  request: CanvasPreviewRenderRequest,
): boolean {
  if (room.id !== request.roomId) return false;
  if (request.source.kind === "room" && room.roomRevision !== request.source.expectedRevision) return false;
  if (request.source.kind === "diagram") {
    const currentDiagram = room.diagrams[request.source.diagramId];
    if (!currentDiagram || currentDiagram.revision !== request.source.expectedRevision) return false;
  }
  return request.objects.every((expected) => {
    const current = room.objects[expected.id];
    return (
      current?.revision === expected.revision &&
      current.createdAt === expected.createdAt &&
      canvas.isObjectProjectionExact(current)
    );
  });
}

async function waitForAuthoritativeProjection(
  runtime: CanvasPreviewRuntime,
  request: CanvasPreviewRenderRequest,
  signal: AbortSignal,
): Promise<{ canvas: CanvasRuntime; room: RoomState }> {
  const now = runtime.now ?? Date.now;
  const wait = runtime.wait ?? defaultWait;
  const deadline = now() + CANVAS_PREVIEW_LIMITS.projectionTimeoutMs;

  while (true) {
    if (signal.aborted) throw abortError();
    const canvas = runtime.getCanvasRuntime();
    const room = runtime.getRoom();
    if (room) assertScopeHasNotAdvanced(room, request);
    if (canvas && room && isAuthoritativeScopeProjected(canvas, room, request)) {
      return { canvas, room };
    }
    if (now() >= deadline) {
      throw new CanvasPreviewError(
        "PREVIEW_PROJECTION_TIMEOUT",
        "The exact authoritative canvas revision was not projected in time; no preview was returned.",
        {
          roomId: request.roomId,
          roomRevision: request.authoritativeRoomRevision,
          objectIds: request.objects.map((object) => object.id),
        },
      );
    }
    await wait(20, signal);
  }
}

function assertStillProjected(
  runtime: CanvasPreviewRuntime,
  request: CanvasPreviewRenderRequest,
  canvas: CanvasRuntime,
): void {
  const room = runtime.getRoom();
  if (
    !room ||
    runtime.getCanvasRuntime() !== canvas ||
    !isAuthoritativeScopeProjected(canvas, room, request)
  ) {
    throw new CanvasPreviewError(
      "PREVIEW_SCOPE_CHANGED_DURING_RENDER",
      "The canvas changed while the preview was rendering; the potentially stale image was discarded.",
      { objectIds: request.objects.map((object) => object.id) },
    );
  }
}

export async function renderCanvasPreview(
  runtime: CanvasPreviewRuntime,
  request: CanvasPreviewRenderRequest,
  signal: AbortSignal,
): Promise<CanvasPreviewArtifact> {
  if (!request.objects.length) {
    throw new CanvasPreviewError("PREVIEW_SCOPE_EMPTY", "A canvas preview must contain at least one exact object target.");
  }

  const { canvas } = await waitForAuthoritativeProjection(runtime, request, signal);
  if (!canvas.capabilities.renderPng) {
    throw new CanvasPreviewError(
      "PREVIEW_RENDERER_UNAVAILABLE",
      "The active experimental canvas renderer cannot produce a faithful PNG preview yet.",
      { rendererId: canvas.rendererId },
    );
  }
  const objectIds = request.objects.map((object) => object.id);
  const bounds = canvas.getVisibleBounds(objectIds);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new CanvasPreviewError(
      "PREVIEW_BOUNDS_UNAVAILABLE",
      "Jazzboard could not determine renderable bounds for the requested objects.",
    );
  }

  const paddedWidth = bounds.width + request.options.padding * 2;
  const paddedHeight = bounds.height + request.options.padding * 2;
  const scale = Math.min(
    1,
    request.options.maxWidth / (paddedWidth * request.options.pixelRatio),
    request.options.maxHeight / (paddedHeight * request.options.pixelRatio),
  );
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new CanvasPreviewError("PREVIEW_DIMENSIONS_INVALID", "The requested preview dimensions are not renderable.");
  }

  const result = await canvas.renderPng(objectIds, {
    background: true,
    darkMode: false,
    padding: request.options.padding,
    pixelRatio: request.options.pixelRatio,
    scale,
    signal,
  });
  if (signal.aborted) throw abortError();
  assertStillProjected(runtime, request, canvas);

  const width = Math.ceil(result.logicalWidth * request.options.pixelRatio);
  const height = Math.ceil(result.logicalHeight * request.options.pixelRatio);
  if (width > request.options.maxWidth || height > request.options.maxHeight) {
    throw new CanvasPreviewError(
      "PREVIEW_DIMENSION_BUDGET_EXCEEDED",
      "The rendered preview exceeded its bounded dimensions and was discarded.",
      { width, height, maxWidth: request.options.maxWidth, maxHeight: request.options.maxHeight },
    );
  }
  if (result.blob.size > request.options.maxBytes) {
    throw new CanvasPreviewError(
      "PREVIEW_BYTE_BUDGET_EXCEEDED",
      "The rendered preview exceeded its byte budget and was discarded.",
      { byteLength: result.blob.size, maxBytes: request.options.maxBytes },
    );
  }

  const warnings: string[] = [...(result.warnings ?? [])];
  if (scale < 1) warnings.push("The preview was downscaled to fit the requested dimensions.");

  return {
    blob: result.blob,
    metadata: {
      mimeType: "image/png",
      width,
      height,
      logicalWidth: result.logicalWidth,
      logicalHeight: result.logicalHeight,
      byteLength: result.blob.size,
      renderedBounds: {
        x: bounds.x - request.options.padding,
        y: bounds.y - request.options.padding,
        width: paddedWidth,
        height: paddedHeight,
      },
      padding: request.options.padding,
      pixelRatio: request.options.pixelRatio,
      source: {
        ...request.source,
        roomRevision: request.authoritativeRoomRevision,
        objectRevisions: request.objects.map((object) => ({
          objectId: object.id,
          revision: object.revision,
        })),
      },
      warnings,
    },
  };
}
