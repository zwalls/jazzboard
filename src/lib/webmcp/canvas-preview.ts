import type { CanvasRuntime } from "@/lib/canvas/runtime";
import {
  analyzeDiagramVisualQuality,
  type DiagramVisualQualityReport,
} from "@/lib/domain/diagram-visual-quality";
import { materializeConnectorRoute } from "@/lib/domain/connector-routing";
import {
  semanticFillColor,
  semanticStrokeColor,
} from "@/lib/canvas/semantic-visual-style";
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
    /** Internal identity fence; not serialized into the WebMCP result. */
    objectIncarnations?: Array<{ objectId: string; revision: number; createdAt: number }>;
    /** Every authoritative object whose pixels can contribute inside the clip. */
    visualContributorRevisions?: Array<{ objectId: string; revision: number }>;
    /** Internal identity fence for visual contributors. */
    visualContributorIncarnations?: Array<{ objectId: string; revision: number; createdAt: number }>;
  };
  warnings: string[];
  /** Deterministic geometry QA for Diagram scope; null for arbitrary object scope. */
  visualQuality: DiagramVisualQualityReport | null;
  /** Bounded semantic evidence derived from the same exact renderer projection. */
  inspectionEvidence?: CanvasInspectionEvidence;
};

export type BoundedCanvasTextEvidence = {
  value: string;
  originalLength: number;
  truncated: boolean;
  digest: string;
};

export type CanvasObjectSemanticEvidence =
  | {
      kind: "text";
      content: BoundedCanvasTextEvidence;
      color: string;
      size: "s" | "m" | "l" | "xl";
      align: "start" | "middle" | "end";
    }
  | {
      kind: "shape";
      shape: "rectangle" | "ellipse" | "diamond";
      nodeType: Extract<CanvasObject, { kind: "shape" }>["nodeType"];
      label: BoundedCanvasTextEvidence;
      fill: string;
      stroke: string;
    }
  | {
      kind: "connector";
      label: BoundedCanvasTextEvidence;
      direction: "none" | "end" | "both";
      color: string;
      start: Extract<CanvasObject, { kind: "connector" }>["start"];
      end: Extract<CanvasObject, { kind: "connector" }>["end"];
    }
  | {
      kind: "image";
      alt: BoundedCanvasTextEvidence;
      mimeType: string;
      locked: boolean;
      assetId: string | null;
      omittedFields: ["url", "sourceUrl"];
    }
  | {
      kind: "draw";
      color: string;
      size: "s" | "m" | "l";
      pointCount: number;
      pointDigest: string;
      sample: Array<{ x: number; y: number }>;
      sampleTruncated: boolean;
    }
  | {
      kind: "path";
      start: { x: number; y: number };
      segmentCount: number;
      segmentDigest: string;
      sample: Extract<CanvasObject, { kind: "path" }>["segments"];
      sampleTruncated: boolean;
      closed: boolean;
      fill: string;
      stroke: string;
      strokeWidth: number;
      opacity: number;
      lineCap: "butt" | "round" | "square";
      lineJoin: "miter" | "round" | "bevel";
      fillRule: "nonzero" | "evenodd";
    };

export type CanvasInspectionEvidence = {
  schemaVersion: 1;
  rendererId: string;
  objects: Array<{
    objectId: string;
    revision: number;
    createdAt: number;
    kind: CanvasObject["kind"];
    bounds: { x: number; y: number; width: number; height: number };
    zIndex: number;
    groupId: string | null;
    diagramIds: string[];
    inRequestedScope: boolean;
    semantic: CanvasObjectSemanticEvidence;
  }>;
  routes: Array<{
    connectorId: string;
    revision: number;
    startObjectId: string | null;
    endObjectId: string | null;
    routing: unknown;
    points: Array<{ x: number; y: number }>;
    labelBounds: { x: number; y: number; width: number; height: number } | null;
    bounds: { x: number; y: number; width: number; height: number };
  }>;
  relationships: Array<{
    connectorId: string;
    startObjectId: string | null;
    endObjectId: string | null;
    direction: string;
    label: BoundedCanvasTextEvidence;
  }>;
  intersections: {
    totalCount: number;
    truncated: boolean;
    items: Array<{
      objectIds: [string, string];
      bounds: { x: number; y: number; width: number; height: number };
      area: number;
    }>;
  };
  occlusions: {
    totalCount: number;
    truncated: boolean;
    items: Array<{
      lowerObjectId: string;
      upperObjectId: string;
      overlapArea: number;
      estimatedLowerCoverage: number;
    }>;
  };
  textFindings: Array<{
    objectId: string;
    code: "TEXT_EMPTY" | "TEXT_LIKELY_CLIPPED";
    status: "observed" | "likely";
    summary: string;
  }>;
  contrastFindings: Array<{
    objectId: string;
    foreground: string;
    background: string;
    ratio: number;
    context: "text_vs_canvas" | "stroke_vs_canvas" | "stroke_vs_fill";
    caveat: string;
  }>;
  coverage: {
    geometry: "complete" | "partial";
    unsupported: Array<{
      objectId?: string;
      analysis: "freehand_swept_path" | "vector_path_geometry" | "rotated_exact_intersection" | "image_internal_pixels" | "context_dependent_contrast";
      reason: string;
    }>;
    omittedUnsupportedCount: number;
  };
};

export type CanvasPreviewArtifact = {
  blob: Blob;
  metadata: CanvasPreviewMetadata;
};

export type CanvasInspectionMetadata = Omit<
  CanvasPreviewMetadata,
  "mimeType" | "width" | "height" | "logicalWidth" | "logicalHeight" | "byteLength" | "pixelRatio"
>;

/** Metadata-only live-canvas evidence. It never creates or describes a duplicate raster surface. */
export type CanvasInspectionArtifact = {
  metadata: CanvasInspectionMetadata;
};

export type CanvasPresentationArtifact = CanvasPreviewArtifact | CanvasInspectionArtifact;

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
  validation?: {
    token: string;
    activeSelector: string;
    status: "valid_until_invalidated";
  };
};

export type CanvasPreviewPresenter = {
  bivarianceHack(
    input: CanvasPresentationArtifact,
    signal: AbortSignal,
  ): Promise<CanvasPreviewPresentation>;
}["bivarianceHack"];

/**
 * Host-owned multimodal delivery boundary. Implementations receive either an
 * ephemeral PNG Blob with metadata or metadata-only live inspection evidence,
 * delegate to a local-only presenter, and return the complete WebMCP result.
 * They must not persist images or replace them with provider URLs.
 */
export interface CanvasPreviewTransportAdapter {
  emit(
    input: CanvasPresentationArtifact,
    present: CanvasPreviewPresenter,
    signal: AbortSignal,
    toolName?: "render_canvas_preview" | "inspect_canvas_scope",
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

const MAX_INSPECTION_RELATIONS = 128;
const MAX_UNSUPPORTED_DISCLOSURES = 128;
const MAX_INSPECTION_TEXT_LENGTH = 256;
const MAX_INSPECTION_POINT_SAMPLE = 16;

function intersects(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const maxX = Math.min(left.x + left.width, right.x + right.width);
  const maxY = Math.min(left.y + left.height, right.y + right.height);
  return maxX > x && maxY > y
    ? { x, y, width: maxX - x, height: maxY - y }
    : null;
}

function objectText(object: CanvasObject): string | null {
  if (object.kind === "text") return object.content;
  if (object.kind === "shape" || object.kind === "connector") return object.label;
  if (object.kind === "image") return object.alt;
  return null;
}

function stableDigest(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function boundedText(value: string): BoundedCanvasTextEvidence {
  return {
    value: value.slice(0, MAX_INSPECTION_TEXT_LENGTH),
    originalLength: value.length,
    truncated: value.length > MAX_INSPECTION_TEXT_LENGTH,
    digest: stableDigest(value),
  };
}

function semanticEvidence(object: CanvasObject): CanvasObjectSemanticEvidence {
  switch (object.kind) {
    case "text":
      return {
        kind: object.kind,
        content: boundedText(object.content),
        color: object.color,
        size: object.size,
        align: object.align,
      };
    case "shape":
      return {
        kind: object.kind,
        shape: object.shape,
        nodeType: object.nodeType,
        label: boundedText(object.label),
        fill: object.fill,
        stroke: object.stroke,
      };
    case "connector":
      return {
        kind: object.kind,
        label: boundedText(object.label),
        direction: object.direction,
        color: object.color,
        start: object.start,
        end: object.end,
      };
    case "image":
      return {
        kind: object.kind,
        alt: boundedText(object.alt),
        mimeType: object.mimeType,
        locked: object.locked,
        assetId: object.assetId,
        omittedFields: ["url", "sourceUrl"],
      };
    case "draw":
      return {
        kind: object.kind,
        color: object.color,
        size: object.size,
        pointCount: object.points.length,
        pointDigest: stableDigest(object.points),
        sample: object.points.slice(0, MAX_INSPECTION_POINT_SAMPLE),
        sampleTruncated: object.points.length > MAX_INSPECTION_POINT_SAMPLE,
      };
    case "path":
      return {
        kind: object.kind,
        start: object.start,
        segmentCount: object.segments.length,
        segmentDigest: stableDigest({ start: object.start, segments: object.segments }),
        sample: object.segments.slice(0, MAX_INSPECTION_POINT_SAMPLE),
        sampleTruncated: object.segments.length > MAX_INSPECTION_POINT_SAMPLE,
        closed: object.closed,
        fill: object.fill,
        stroke: object.stroke,
        strokeWidth: object.strokeWidth,
        opacity: object.opacity,
        lineCap: object.lineCap,
        lineJoin: object.lineJoin,
        fillRule: object.fillRule,
      };
  }
}

function hasTransparentColor(value: string): boolean {
  const normalized = value.trim().toLowerCase().replaceAll(" ", "");
  if (normalized === "none" || normalized === "transparent") return true;
  const shortHex = /^#[0-9a-f]{3}([0-9a-f])$/.exec(normalized);
  if (shortHex) return shortHex[1] !== "f";
  const fullHex = /^#[0-9a-f]{6}([0-9a-f]{2})$/.exec(normalized);
  if (fullHex) return fullHex[1] !== "ff";
  const colorFunction = /^(rgba?|hsla?)\(([^)]+)\)$/.exec(normalized);
  if (!colorFunction) return false;
  const body = colorFunction[2];
  const alphaText = body.includes("/")
    ? body.slice(body.lastIndexOf("/") + 1)
    : colorFunction[1].endsWith("a")
      ? body.split(",").at(-1) ?? ""
      : "";
  if (!alphaText) return false;
  const alpha = alphaText.endsWith("%")
    ? Number.parseFloat(alphaText) / 100
    : Number.parseFloat(alphaText);
  return Number.isFinite(alpha) && alpha < 1;
}

function hasContextDependentContrast(object: CanvasObject): boolean {
  if (object.kind === "shape") {
    return hasTransparentColor(object.fill) || hasTransparentColor(object.stroke);
  }
  if (object.kind === "path") {
    return object.opacity < 1
      || hasTransparentColor(object.fill)
      || hasTransparentColor(object.stroke);
  }
  if (object.kind === "text" || object.kind === "connector" || object.kind === "draw") {
    return hasTransparentColor(object.color);
  }
  return false;
}

function rgb(hex: string): [number, number, number] | null {
  const normalized = hex.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/i.exec(normalized)?.[1];
  const full = short
    ? short.split("").map((value) => value + value).join("")
    : /^#([0-9a-f]{6})$/i.exec(normalized)?.[1];
  if (!full) return null;
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number | null {
  const color = rgb(hex);
  if (!color) return null;
  const channels = color.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string): number | null {
  const left = luminance(foreground);
  const right = luminance(background);
  if (left === null || right === null) return null;
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function buildInspectionEvidence(
  canvas: CanvasRuntime,
  room: RoomState,
  requestedIds: ReadonlySet<string>,
  contributors: readonly CanvasObject[],
): CanvasInspectionEvidence {
  const objects = contributors
    .flatMap((object) => {
      const bounds = canvas.getObjectBounds(object.id);
      return bounds ? [{
        objectId: object.id,
        revision: object.revision,
        createdAt: object.createdAt,
        kind: object.kind,
        bounds,
        zIndex: object.zIndex,
        groupId: object.groupId,
        diagramIds: [...object.diagramIds],
        inRequestedScope: requestedIds.has(object.id),
        semantic: semanticEvidence(object),
      }] : [];
    })
    .sort((left, right) => left.zIndex - right.zIndex || left.objectId.localeCompare(right.objectId));
  const objectById = new Map(contributors.map((object) => [object.id, object]));
  const intersections: CanvasInspectionEvidence["intersections"]["items"] = [];
  const occlusions: CanvasInspectionEvidence["occlusions"]["items"] = [];
  let intersectionCount = 0;
  for (let leftIndex = 0; leftIndex < objects.length; leftIndex += 1) {
    const left = objects[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < objects.length; rightIndex += 1) {
      const right = objects[rightIndex];
      if (
        left.kind === "draw" || right.kind === "draw" ||
        left.kind === "path" || right.kind === "path"
      ) continue;
      const overlap = intersects(left.bounds, right.bounds);
      if (!overlap) continue;
      intersectionCount += 1;
      const area = overlap.width * overlap.height;
      if (intersections.length < MAX_INSPECTION_RELATIONS) {
        intersections.push({ objectIds: [left.objectId, right.objectId], bounds: overlap, area });
        occlusions.push({
          lowerObjectId: left.objectId,
          upperObjectId: right.objectId,
          overlapArea: area,
          estimatedLowerCoverage: Math.min(1, area / Math.max(left.bounds.width * left.bounds.height, 1)),
        });
      }
    }
  }
  const routes = contributors.flatMap((object) => {
    if (object.kind !== "connector") return [];
    const route = materializeConnectorRoute(object, room);
    return [{
      connectorId: object.id,
      revision: object.revision,
      startObjectId: object.start.objectId,
      endObjectId: object.end.objectId,
      routing: route.routing,
      points: route.points,
      labelBounds: route.labelBounds,
      bounds: route.bounds,
    }];
  });
  const textFindings = contributors.flatMap((object): CanvasInspectionEvidence["textFindings"] => {
    const text = objectText(object);
    if (text === null) return [];
    if (!text.trim()) return [{
      objectId: object.id,
      code: "TEXT_EMPTY",
      status: "observed",
      summary: "This semantic text field is empty and may not communicate intent in the captured pixels.",
    }];
    const approximateCapacity = Math.max(8, Math.floor(object.width / 11)) * Math.max(1, Math.floor(object.height / 26));
    return text.length > approximateCapacity * 1.5 ? [{
      objectId: object.id,
      code: "TEXT_LIKELY_CLIPPED",
      status: "likely",
      summary: "Text length substantially exceeds the deterministic bounds-based capacity estimate; inspect the pixels for clipping.",
    }] : [];
  });
  const contrastFindings = contributors.flatMap((object): CanvasInspectionEvidence["contrastFindings"] => {
    if (hasContextDependentContrast(object)) return [];
    let foreground: string;
    let background: string;
    let context: CanvasInspectionEvidence["contrastFindings"][number]["context"];
    let caveat: string;
    if (object.kind === "shape" || object.kind === "path") {
      foreground = semanticStrokeColor(object.stroke, "blue");
      background = semanticFillColor(object.fill, "blue", false);
      context = "stroke_vs_fill";
      caveat = "Measures declared stroke against declared opaque fill; it does not infer aesthetic intent or inspect neighboring pixels.";
    } else if (object.kind === "text" || object.kind === "connector" || object.kind === "draw") {
      foreground = semanticStrokeColor(object.color, "black");
      background = "#ffffff";
      context = object.kind === "text" ? "text_vs_canvas" : "stroke_vs_canvas";
      caveat = "Measures declared color against the nominal white canvas; overlap can change the contributing background and no threshold judgment is applied.";
    } else return [];
    const ratio = contrastRatio(foreground, background);
    return ratio === null ? [] : [{
      objectId: object.id,
      foreground,
      background,
      ratio: Math.round(ratio * 100) / 100,
      context,
      caveat,
    }];
  });
  const unsupported = contributors.flatMap((object) => {
    const items: CanvasInspectionEvidence["coverage"]["unsupported"] = [];
    if (object.kind === "draw") items.push({
      objectId: object.id,
      analysis: "freehand_swept_path",
      reason: "Bounds and pixels are exact, but swept-stroke intersections and occlusion percentages are not analyzed deterministically.",
    });
    if (object.kind === "path") items.push({
      objectId: object.id,
      analysis: "vector_path_geometry",
      reason: "Path style, bounds, segment count, digest, and a bounded segment sample are exact; curve intersections and filled-path occlusion require pixel inspection.",
    });
    if (hasContextDependentContrast(object)) items.push({
      objectId: object.id,
      analysis: "context_dependent_contrast",
      reason: "Transparent or partially transparent content depends on the actual contributing background; no fabricated contrast ratio is reported.",
    });
    if (object.rotation !== 0) items.push({
      objectId: object.id,
      analysis: "rotated_exact_intersection",
      reason: "Intersection and occlusion evidence uses renderer bounds for rotated objects rather than exact polygon clipping.",
    });
    if (object.kind === "image") items.push({
      objectId: object.id,
      analysis: "image_internal_pixels",
      reason: "Image bounds are exact, but internal image contrast and visual content require pixel inspection.",
    });
    return items;
  });
  return {
    schemaVersion: 1,
    rendererId: canvas.rendererId,
    objects,
    routes,
    relationships: routes.map((route) => {
      const connector = objectById.get(route.connectorId);
      return {
        connectorId: route.connectorId,
        startObjectId: route.startObjectId,
        endObjectId: route.endObjectId,
        direction: connector?.kind === "connector" ? connector.direction : "none",
        label: boundedText(connector?.kind === "connector" ? connector.label : ""),
      };
    }),
    intersections: {
      totalCount: intersectionCount,
      truncated: intersectionCount > intersections.length,
      items: intersections,
    },
    occlusions: {
      totalCount: intersectionCount,
      truncated: intersectionCount > occlusions.length,
      items: occlusions,
    },
    textFindings,
    contrastFindings,
    coverage: {
      geometry: unsupported.length ? "partial" : "complete",
      unsupported: unsupported.slice(0, MAX_UNSUPPORTED_DISCLOSURES),
      omittedUnsupportedCount: Math.max(0, unsupported.length - MAX_UNSUPPORTED_DISCLOSURES),
    },
  };
}

function inspectionMetadata(
  canvas: CanvasRuntime,
  room: RoomState,
  request: CanvasPreviewRenderRequest,
  renderedBounds: { x: number; y: number; width: number; height: number },
): CanvasInspectionMetadata {
  const requestedIds = request.objects.map((object) => object.id);
  const requestedIdSet = new Set(requestedIds);
  const contributors = canvas.getDocumentObjectIds().flatMap((objectId) => {
    const object = room.objects[objectId];
    const objectBounds = canvas.getObjectBounds(objectId);
    return object && objectBounds && intersects(objectBounds, renderedBounds) ? [object] : [];
  });
  if (contributors.length > CANVAS_PREVIEW_LIMITS.maxTargets) {
    throw new CanvasPreviewError(
      "PREVIEW_VISUAL_CONTEXT_TOO_LARGE",
      "More than 1,000 authoritative objects contribute pixels to this inspection region; inspect a smaller scope.",
      { contributorCount: contributors.length, maxTargets: CANVAS_PREVIEW_LIMITS.maxTargets },
    );
  }
  return {
    renderedBounds,
    padding: request.options.padding,
    source: {
      ...request.source,
      roomRevision: request.authoritativeRoomRevision,
      objectRevisions: request.objects.map((object) => ({
        objectId: object.id,
        revision: object.revision,
      })),
      objectIncarnations: request.objects.map((object) => ({
        objectId: object.id,
        revision: object.revision,
        createdAt: object.createdAt,
      })),
      visualContributorRevisions: contributors.map((object) => ({
        objectId: object.id,
        revision: object.revision,
      })),
      visualContributorIncarnations: contributors.map((object) => ({
        objectId: object.id,
        revision: object.revision,
        createdAt: object.createdAt,
      })),
    },
    warnings: [],
    visualQuality: request.diagram
      ? analyzeDiagramVisualQuality(room, request.diagram.id)
      : null,
    inspectionEvidence: buildInspectionEvidence(canvas, room, requestedIdSet, contributors),
  };
}

/** Prepare exact semantic/live-canvas evidence without rasterizing a second surface. */
export async function prepareCanvasInspection(
  runtime: CanvasPreviewRuntime,
  request: CanvasPreviewRenderRequest,
  signal: AbortSignal,
): Promise<CanvasInspectionArtifact> {
  if (!request.objects.length) {
    throw new CanvasPreviewError("PREVIEW_SCOPE_EMPTY", "A canvas inspection must contain at least one exact object target.");
  }
  if (request.objects.length > CANVAS_PREVIEW_LIMITS.maxTargets) {
    throw new CanvasPreviewError(
      "PREVIEW_SCOPE_TOO_LARGE",
      "A canvas inspection cannot exceed the 1,000-target limit.",
      { targetCount: request.objects.length, maxTargets: CANVAS_PREVIEW_LIMITS.maxTargets },
    );
  }
  const { canvas, room } = await waitForAuthoritativeProjection(runtime, request, signal);
  const bounds = canvas.getVisibleBounds(request.objects.map((object) => object.id));
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new CanvasPreviewError(
      "PREVIEW_BOUNDS_UNAVAILABLE",
      "Jazzboard could not determine renderable bounds for the requested objects.",
    );
  }
  const renderedBounds = {
    x: bounds.x - request.options.padding,
    y: bounds.y - request.options.padding,
    width: bounds.width + request.options.padding * 2,
    height: bounds.height + request.options.padding * 2,
  };
  const metadata = inspectionMetadata(canvas, room, request, renderedBounds);
  assertStillProjected(runtime, request, canvas);
  return { metadata };
}

export async function renderCanvasPreview(
  runtime: CanvasPreviewRuntime,
  request: CanvasPreviewRenderRequest,
  signal: AbortSignal,
): Promise<CanvasPreviewArtifact> {
  if (!request.objects.length) {
    throw new CanvasPreviewError("PREVIEW_SCOPE_EMPTY", "A canvas preview must contain at least one exact object target.");
  }
  if (request.objects.length > CANVAS_PREVIEW_LIMITS.maxTargets) {
    throw new CanvasPreviewError(
      "PREVIEW_SCOPE_TOO_LARGE",
      "A canvas preview cannot exceed the 1,000-target render limit.",
      { targetCount: request.objects.length, maxTargets: CANVAS_PREVIEW_LIMITS.maxTargets },
    );
  }

  const { canvas, room } = await waitForAuthoritativeProjection(runtime, request, signal);
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

  const renderedBounds = {
    x: bounds.x - request.options.padding,
    y: bounds.y - request.options.padding,
    width: paddedWidth,
    height: paddedHeight,
  };
  const inspection = inspectionMetadata(canvas, room, request, renderedBounds);

  return {
    blob: result.blob,
    metadata: {
      mimeType: "image/png",
      width,
      height,
      logicalWidth: result.logicalWidth,
      logicalHeight: result.logicalHeight,
      byteLength: result.blob.size,
      ...inspection,
      pixelRatio: request.options.pixelRatio,
      warnings,
    },
  };
}
