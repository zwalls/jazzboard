import type { CanvasRuntime } from "@/lib/canvas/runtime";
import {
  analyzeDiagramVisualQuality,
  type DiagramVisualQualityReport,
} from "@/lib/domain/diagram-visual-quality";
import { materializeConnectorRoute } from "@/lib/domain/connector-routing";
import {
  SEMANTIC_SHAPE_LABEL_FONT_SIZE,
  SEMANTIC_SHAPE_LABEL_LINE_HEIGHT,
  SEMANTIC_TEXT_FONT_SIZES,
  SEMANTIC_TEXT_LINE_HEIGHT,
  semanticShapeLabelMaxCharacters,
  semanticShapeLabelMaxLines,
  semanticFillColor,
  semanticStrokeColor,
} from "@/lib/canvas/semantic-visual-style";
import {
  layoutSemanticText,
  SEMANTIC_TEXT_GRAPHEME_WIDTH_FACTOR,
  semanticTextMaximumCharacters,
  semanticTextMaximumLines,
} from "@/lib/canvas/semantic-text-layout";
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

export type CanvasInspectionRepresentation = "overview" | "working_set" | "focus";

export type CanvasVisualContract = {
  intent: string;
  criteria: string[];
  preserveObjectIds: string[];
};

export type CanvasInspectionRequest = {
  representation: CanvasInspectionRepresentation;
  focusObjectIds: string[];
  visualContract: CanvasVisualContract | null;
  /** Unverified comparison input supplied by the caller, never server history. */
  previousFindingKeys: string[];
};

/** An exact, authoritative scope resolved by the tool before UI rendering begins. */
export type CanvasPreviewRenderRequest = {
  roomId: string;
  authoritativeRoomRevision: number;
  /** Optional for legacy render callers; inspections always supply this incarnation fence. */
  authoritativeRoomCreatedAt?: number;
  source: CanvasPreviewSource;
  objects: CanvasObject[];
  diagram: Diagram | null;
  options: CanvasPreviewRenderOptions;
  /** Present only for inspect_canvas_scope; legacy render keeps its existing input surface. */
  inspection?: CanvasInspectionRequest;
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

export type CanvasCompactObjectRecord = {
  objectId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  kind: CanvasObject["kind"];
  bounds: { x: number; y: number; width: number; height: number };
  rotation: number;
  zIndex: number;
  groupId: string | null;
  /** A lexicographically sorted, bounded prefix of the exact membership set. */
  diagramIds: string[];
  diagramMembershipCoverage: {
    totalDiagramCount: number;
    returnedDiagramCount: number;
    omittedDiagramCount: number;
    limit: number;
    truncated: boolean;
    fullSetDigest: string;
  };
  semanticName: string | null;
  semanticRole: string | null;
  inRequestedScope: boolean;
  text: BoundedCanvasTextEvidence | null;
  nodeType: Extract<CanvasObject, { kind: "shape" }>["nodeType"] | null;
  relationship: {
    startObjectId: string | null;
    endObjectId: string | null;
    direction: "none" | "end" | "both";
  } | null;
  detailDigest: string;
};

export type CanvasFocusedObjectRecord = CanvasCompactObjectRecord & {
  createdBy: { participantId: string; kind: "human" | "agent" };
  lastEditedBy: { participantId: string; kind: "human" | "agent" };
  semantic: CanvasObjectSemanticEvidence;
};

export type CanvasInspectionEvidence = {
  schemaVersion: 2;
  rendererId: string;
  representation: CanvasInspectionRepresentation;
  scope: {
    identity: string;
    kind: CanvasPreviewSource["kind"];
    diagramId: string | null;
    focusObjectIds: string[];
    identityBasis: "created_at_incarnations";
  };
  visualContract: CanvasVisualContract | null;
  revisions: {
    roomRevision: number;
    diagramRevision: number | null;
    explicitObjectRevisions: Array<{ objectId: string; revision: number }>;
    explicitObjectRevisionCoverage: {
      totalCount: number;
      returnedCount: number;
      omittedCount: number;
      limit: number;
      truncated: boolean;
      fullSetDigest: string;
    };
  };
  coverage: {
    scopeObjectCount: number;
    visualContributorCount: number;
    compactRecordCount: number;
    focusedRecordCount: number;
    omittedCompactRecordCount: number;
    allExplicitTargetsRepresented: boolean;
    resultByteLength: number;
    resultByteLimit: number;
    findings: "complete" | "partial";
    geometry: "complete" | "partial";
    unsupported: Array<{
      objectId?: string;
      analysis: "freehand_swept_path" | "vector_path_geometry" | "rotated_exact_intersection" | "image_internal_pixels" | "context_dependent_contrast" | "diagram_geometry_deferred_in_overview" | "text_occlusion_deferred_in_overview";
      reason: string;
    }>;
    omittedUnsupportedCount: number;
  };
  overview: {
    bounds: { x: number; y: number; width: number; height: number };
    objectCount: number;
    kinds: Record<CanvasObject["kind"], number>;
    spatialClusters: Array<{
      clusterId: string;
      bounds: { x: number; y: number; width: number; height: number };
      objectCount: number;
      kinds: Partial<Record<CanvasObject["kind"], number>>;
      representativeObjectIds: string[];
    }>;
  };
  composition: {
    basis: "axis_aligned_renderer_bounds";
    interpretation: "descriptive_relative_geometry_not_quality_judgment";
    framing: {
      scopeKind: CanvasPreviewSource["kind"];
      fullRoomContext: boolean;
      scopeBounds: { x: number; y: number; width: number; height: number };
      framedBounds: { x: number; y: number; width: number; height: number };
      padding: number;
      aspectRatio: number;
    };
    scale: {
      measurement: "positive_area_non_connector_bounds";
      measuredObjectCount: number;
      medianBoundsArea: number | null;
      totalBoundsArea: number;
      scopeBoundsArea: number;
      summedBoundsAreaToScopeAreaRatio: number;
      largestObjects: Array<{
        objectId: string;
        kind: CanvasObject["kind"];
        boundsArea: number;
        areaToMedianRatio: number | null;
        widthToScopeRatio: number;
        heightToScopeRatio: number;
      }>;
      largestObjectCoverage: {
        returnedCount: number;
        omittedCount: number;
        limit: number;
        truncated: boolean;
      };
      caveat: "summed_bounds_area_can_exceed_scope_area_when_objects_overlap";
      heterogeneityCaveat: "median_area_is_selection_sensitive_for_mixed_decorative_and_structural_parts";
    };
    distribution: {
      objectCenterAverageNormalized: { x: number; y: number } | null;
      areaWeightedCenterNormalized: { x: number; y: number } | null;
      quadrantObjectCounts: {
        topLeft: number;
        topRight: number;
        bottomLeft: number;
        bottomRight: number;
      };
      nearestNeighbor: {
        normalization: "scope_diagonal";
        medianNormalizedDistance: number | null;
        farthestObjects: Array<{
          objectId: string;
          nearestObjectId: string;
          normalizedDistance: number;
        }>;
        farthestObjectCoverage: {
          returnedCount: number;
          omittedCount: number;
          limit: number;
          truncated: boolean;
        };
        caveat: "center_distance_is_not_edge_clearance_or_integration_quality";
      };
      caveat: "centers_and_quadrants_do_not_measure_visual_weight_or_user_intent";
    };
  };
  workingSet: CanvasCompactObjectRecord[];
  focused: CanvasFocusedObjectRecord[];
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
  boundsOverlaps: {
    totalCount: number;
    truncated: boolean;
    items: Array<{
      factKey: string;
      method: "axis_aligned_renderer_bounds";
      objectIds: [string, string];
      bounds: { x: number; y: number; width: number; height: number };
      area: number;
      interpretation: "bounds_overlap_only_not_proof_of_painted_intersection_or_occlusion";
    }>;
  };
  textOcclusionRisks: Array<{
    findingKey: string;
    labelObjectId: string;
    labelObjectRevision: number;
    occludingObjectId: string;
    occludingObjectRevision: number;
    source: "shape_label" | "text_object";
    method: "shared_text_layout_bounds_and_exact_rectangle_paint_order";
    status: "likely";
    labelBounds: { x: number; y: number; width: number; height: number };
    overlapBounds: { x: number; y: number; width: number; height: number };
    summary: string;
  }>;
  textFindings: Array<{
    findingKey: string;
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
  findingKeys: string[];
  findingKeysTruncated: boolean;
  findingComparison: {
    basis: "caller_supplied_unverified";
    suppliedKeyCount: number;
    sameScopeSuppliedKeyCount: number;
    ignoredDifferentScopeSuppliedKeyCount: number;
    currentFindingCoverageComplete: boolean;
    observedFindingKeysNotSupplied: string[];
    callerSuppliedFindingKeysObservedAgain: string[];
    callerSuppliedSameScopeKeysNotObserved: string[];
    interpretation: "not_observed_does_not_prove_resolved";
  };
};

export type CanvasInspectionPixels = {
  delivery: "host_capture_required";
  nativeImageResultSupported: false;
  clip: CanvasPreviewPresentation["clip"];
  validationSelector: string | null;
  expiresAt: number;
  action: {
    required: true;
    protocolPath: "data.pixelCaptureProtocol";
    completionGate: "inspect_clean_viewport_pixels_and_scoped_region_before_claiming_visual_qa";
  };
  visualInspectionStatus: "not_performed";
};

export type CanvasSceneContext = CanvasInspectionEvidence & {
  pixels: CanvasInspectionPixels;
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
  if (
    request.authoritativeRoomCreatedAt !== undefined
    && room.createdAt !== request.authoritativeRoomCreatedAt
  ) {
    throw new CanvasPreviewError(
      "PREVIEW_ROOM_CHANGED",
      "The Jazzboard room was deleted and recreated before its inspection could be prepared.",
      {
        roomId: room.id,
        expectedCreatedAt: request.authoritativeRoomCreatedAt,
        actualCreatedAt: room.createdAt,
      },
    );
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
    if (request.diagram && diagram.createdAt !== request.diagram.createdAt) {
      throw new CanvasPreviewError(
        "PREVIEW_SCOPE_CHANGED",
        `Diagram ${request.source.diagramId} was replaced before its preview could be rendered.`,
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
  if (
    request.authoritativeRoomCreatedAt !== undefined
    && room.createdAt !== request.authoritativeRoomCreatedAt
  ) return false;
  if (request.source.kind === "room" && room.roomRevision !== request.source.expectedRevision) return false;
  if (request.source.kind === "diagram") {
    const currentDiagram = room.diagrams[request.source.diagramId];
    if (
      !currentDiagram
      || currentDiagram.revision !== request.source.expectedRevision
      || (request.diagram !== null && currentDiagram.createdAt !== request.diagram.createdAt)
    ) return false;
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
const MAX_COMPOSITION_SAMPLES = 8;

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

type EstimatedTextBounds = {
  source: "shape_label" | "text_object";
  bounds: { x: number; y: number; width: number; height: number };
};

function estimatedTextBounds(object: CanvasObject): EstimatedTextBounds | null {
  if (object.rotation !== 0) return null;
  if (object.kind === "shape" && object.label.trim()) {
    const lines = layoutSemanticText(
      object.label,
      semanticShapeLabelMaxCharacters(object.width),
      semanticShapeLabelMaxLines(object.height),
    ).lines;
    if (!lines.length) return null;
    const maximumGraphemes = Math.max(...lines.map((line) => Array.from(line).length));
    const width = Math.min(
      object.width,
      maximumGraphemes * SEMANTIC_SHAPE_LABEL_FONT_SIZE * SEMANTIC_TEXT_GRAPHEME_WIDTH_FACTOR + 10,
    );
    const height = Math.min(
      object.height,
      (lines.length - 1) * SEMANTIC_SHAPE_LABEL_LINE_HEIGHT + SEMANTIC_SHAPE_LABEL_FONT_SIZE * 1.35,
    );
    return {
      source: "shape_label",
      bounds: {
        x: object.x + (object.width - width) / 2,
        y: object.y + (object.height - height) / 2,
        width,
        height,
      },
    };
  }
  if (object.kind === "text" && object.content.trim()) {
    const fontSize = SEMANTIC_TEXT_FONT_SIZES[object.size];
    const lines = layoutSemanticText(
      object.content,
      semanticTextMaximumCharacters(object.width, fontSize),
      semanticTextMaximumLines(object.height, fontSize),
    ).lines;
    if (!lines.length) return null;
    const maximumGraphemes = Math.max(...lines.map((line) => Array.from(line).length));
    const width = Math.min(
      object.width,
      maximumGraphemes * fontSize * SEMANTIC_TEXT_GRAPHEME_WIDTH_FACTOR,
    );
    const height = Math.min(
      object.height,
      (lines.length - 1) * fontSize * SEMANTIC_TEXT_LINE_HEIGHT + fontSize * 1.2,
    );
    const x = object.align === "start"
      ? object.x
      : object.align === "end"
        ? object.x + object.width - width
        : object.x + (object.width - width) / 2;
    return {
      source: "text_object",
      bounds: { x, y: object.y, width, height },
    };
  }
  return null;
}

function paintsAfter(left: CanvasObject, right: CanvasObject): boolean {
  return left.zIndex > right.zIndex
    || (left.zIndex === right.zIndex && left.id.localeCompare(right.id) > 0);
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

function boundedText(value: string, limit = MAX_INSPECTION_TEXT_LENGTH): BoundedCanvasTextEvidence {
  return {
    value: value.slice(0, limit),
    originalLength: value.length,
    truncated: value.length > limit,
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

function compactRecord(
  object: CanvasObject,
  bounds: { x: number; y: number; width: number; height: number },
  requestedIds: ReadonlySet<string>,
): CanvasCompactObjectRecord {
  const text = objectText(object);
  const fullDiagramIds = [...new Set(object.diagramIds)].sort();
  const diagramIds = fullDiagramIds.slice(0, CANVAS_PREVIEW_LIMITS.maxCompactDiagramIds);
  return {
    objectId: object.id,
    revision: object.revision,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
    kind: object.kind,
    bounds,
    rotation: object.rotation,
    zIndex: object.zIndex,
    groupId: object.groupId,
    diagramIds,
    diagramMembershipCoverage: {
      totalDiagramCount: fullDiagramIds.length,
      returnedDiagramCount: diagramIds.length,
      omittedDiagramCount: fullDiagramIds.length - diagramIds.length,
      limit: CANVAS_PREVIEW_LIMITS.maxCompactDiagramIds,
      truncated: diagramIds.length < fullDiagramIds.length,
      fullSetDigest: stableDigest(fullDiagramIds),
    },
    semanticName: object.semanticName ?? null,
    semanticRole: object.semanticRole ?? null,
    inRequestedScope: requestedIds.has(object.id),
    text: text === null ? null : boundedText(text, 96),
    nodeType: object.kind === "shape" ? object.nodeType : null,
    relationship: object.kind === "connector" ? {
      startObjectId: object.start.objectId,
      endObjectId: object.end.objectId,
      direction: object.direction,
    } : null,
    detailDigest: stableDigest(semanticEvidence(object)),
  };
}

function unionBounds(
  bounds: readonly { x: number; y: number; width: number; height: number }[],
): { x: number; y: number; width: number; height: number } | null {
  if (!bounds.length) return null;
  const x = Math.min(...bounds.map((item) => item.x));
  const y = Math.min(...bounds.map((item) => item.y));
  const maxX = Math.max(...bounds.map((item) => item.x + item.width));
  const maxY = Math.max(...bounds.map((item) => item.y + item.height));
  return { x, y, width: maxX - x, height: maxY - y };
}

function kindCounts(objects: readonly CanvasObject[]): Record<CanvasObject["kind"], number> {
  const counts: Record<CanvasObject["kind"], number> = {
    text: 0,
    shape: 0,
    connector: 0,
    image: 0,
    draw: 0,
    path: 0,
  };
  for (const object of objects) counts[object.kind] += 1;
  return counts;
}

function spatialClusters(
  objects: readonly CanvasObject[],
  scopeBounds: { x: number; y: number; width: number; height: number },
  boundsByObjectId: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>,
): CanvasInspectionEvidence["overview"]["spatialClusters"] {
  const side = Math.max(1, Math.floor(Math.sqrt(CANVAS_PREVIEW_LIMITS.maxSpatialClusters)));
  const clusters = new Map<string, {
    row: number;
    column: number;
    bounds: Array<{ x: number; y: number; width: number; height: number }>;
    objects: CanvasObject[];
  }>();
  for (const object of [...objects].sort((left, right) => left.id.localeCompare(right.id))) {
    const bounds = boundsByObjectId.get(object.id);
    if (!bounds) continue;
    const normalizedX = scopeBounds.width > 0
      ? (bounds.x + bounds.width / 2 - scopeBounds.x) / scopeBounds.width
      : 0;
    const normalizedY = scopeBounds.height > 0
      ? (bounds.y + bounds.height / 2 - scopeBounds.y) / scopeBounds.height
      : 0;
    const column = Math.max(0, Math.min(side - 1, Math.floor(normalizedX * side)));
    const row = Math.max(0, Math.min(side - 1, Math.floor(normalizedY * side)));
    const key = `${row}:${column}`;
    const cluster = clusters.get(key) ?? { row, column, bounds: [], objects: [] };
    cluster.bounds.push(bounds);
    cluster.objects.push(object);
    clusters.set(key, cluster);
  }
  return [...clusters.values()]
    .sort((left, right) => left.row - right.row || left.column - right.column)
    .slice(0, CANVAS_PREVIEW_LIMITS.maxSpatialClusters)
    .map((cluster) => ({
      clusterId: `grid-${cluster.row}-${cluster.column}`,
      bounds: unionBounds(cluster.bounds) ?? scopeBounds,
      objectCount: cluster.objects.length,
      kinds: Object.fromEntries(
        Object.entries(kindCounts(cluster.objects)).filter(([, count]) => count > 0),
      ) as Partial<Record<CanvasObject["kind"], number>>,
      representativeObjectIds: cluster.objects.slice(0, 4).map((object) => object.id),
    }));
}

function roundedEvidence(value: number, fractionDigits = 4): number {
  const factor = 10 ** fractionDigits;
  return Math.round(value * factor) / factor;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function compositionEvidence(
  objects: readonly CanvasObject[],
  scopeKind: CanvasPreviewSource["kind"],
  scopeBounds: { x: number; y: number; width: number; height: number },
  framedBounds: { x: number; y: number; width: number; height: number },
  padding: number,
  boundsByObjectId: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>,
): CanvasInspectionEvidence["composition"] {
  const records = objects
    .filter((object) => object.kind !== "connector")
    .flatMap((object) => {
      const bounds = boundsByObjectId.get(object.id);
      const area = bounds ? bounds.width * bounds.height : 0;
      return bounds && area > 0 ? [{ object, bounds, area }] : [];
    });
  const medianArea = median(records.map((record) => record.area));
  const scopeWidth = Math.max(scopeBounds.width, Number.EPSILON);
  const scopeHeight = Math.max(scopeBounds.height, Number.EPSILON);
  const scopeDiagonal = Math.max(Math.hypot(scopeBounds.width, scopeBounds.height), Number.EPSILON);
  const normalizedCenter = (bounds: { x: number; y: number; width: number; height: number }) => ({
    x: (bounds.x + bounds.width / 2 - scopeBounds.x) / scopeWidth,
    y: (bounds.y + bounds.height / 2 - scopeBounds.y) / scopeHeight,
  });
  const centers = records.map((record) => ({ ...record, center: normalizedCenter(record.bounds) }));
  const centerAverage = centers.length
    ? {
        x: roundedEvidence(centers.reduce((sum, record) => sum + record.center.x, 0) / centers.length),
        y: roundedEvidence(centers.reduce((sum, record) => sum + record.center.y, 0) / centers.length),
      }
    : null;
  const totalArea = records.reduce((sum, record) => sum + record.area, 0);
  const scopeArea = scopeBounds.width * scopeBounds.height;
  const areaWeightedCenter = totalArea > 0
    ? {
        x: roundedEvidence(centers.reduce((sum, record) => sum + record.center.x * record.area, 0) / totalArea),
        y: roundedEvidence(centers.reduce((sum, record) => sum + record.center.y * record.area, 0) / totalArea),
      }
    : null;
  const quadrantObjectCounts = {
    topLeft: 0,
    topRight: 0,
    bottomLeft: 0,
    bottomRight: 0,
  };
  for (const record of centers) {
    const vertical = record.center.y < 0.5 ? "top" : "bottom";
    const horizontal = record.center.x < 0.5 ? "Left" : "Right";
    quadrantObjectCounts[`${vertical}${horizontal}` as keyof typeof quadrantObjectCounts] += 1;
  }
  const nearestNeighborRecords = centers.flatMap((record) => {
    const leftCenterX = record.bounds.x + record.bounds.width / 2;
    const leftCenterY = record.bounds.y + record.bounds.height / 2;
    let nearest: { objectId: string; distance: number } | null = null;
    for (const candidate of centers) {
      if (candidate.object.id === record.object.id) continue;
      const rightCenterX = candidate.bounds.x + candidate.bounds.width / 2;
      const rightCenterY = candidate.bounds.y + candidate.bounds.height / 2;
      const distance = Math.hypot(rightCenterX - leftCenterX, rightCenterY - leftCenterY);
      if (
        !nearest
        || distance < nearest.distance
        || (distance === nearest.distance && candidate.object.id.localeCompare(nearest.objectId) < 0)
      ) nearest = { objectId: candidate.object.id, distance };
    }
    return nearest ? [{
      objectId: record.object.id,
      nearestObjectId: nearest.objectId,
      normalizedDistance: nearest.distance / scopeDiagonal,
    }] : [];
  });
  const medianNearestDistance = median(
    nearestNeighborRecords.map((record) => record.normalizedDistance),
  );
  const largestObjects = [...records]
    .sort((left, right) => right.area - left.area || left.object.id.localeCompare(right.object.id))
    .slice(0, MAX_COMPOSITION_SAMPLES)
    .map((record) => ({
      objectId: record.object.id,
      kind: record.object.kind,
      boundsArea: roundedEvidence(record.area, 2),
      areaToMedianRatio: medianArea && medianArea > 0
        ? roundedEvidence(record.area / medianArea)
        : null,
      widthToScopeRatio: roundedEvidence(record.bounds.width / scopeWidth),
      heightToScopeRatio: roundedEvidence(record.bounds.height / scopeHeight),
    }));
  const farthestObjects = [...nearestNeighborRecords]
    .sort((left, right) => right.normalizedDistance - left.normalizedDistance
      || left.objectId.localeCompare(right.objectId))
    .slice(0, MAX_COMPOSITION_SAMPLES)
    .map((record) => ({ ...record, normalizedDistance: roundedEvidence(record.normalizedDistance) }));

  return {
    basis: "axis_aligned_renderer_bounds",
    interpretation: "descriptive_relative_geometry_not_quality_judgment",
    framing: {
      scopeKind,
      fullRoomContext: scopeKind === "room",
      scopeBounds,
      framedBounds,
      padding,
      aspectRatio: roundedEvidence(scopeBounds.width / scopeHeight),
    },
    scale: {
      measurement: "positive_area_non_connector_bounds",
      measuredObjectCount: records.length,
      medianBoundsArea: medianArea === null ? null : roundedEvidence(medianArea, 2),
      totalBoundsArea: roundedEvidence(totalArea, 2),
      scopeBoundsArea: roundedEvidence(scopeArea, 2),
      summedBoundsAreaToScopeAreaRatio: scopeArea > 0
        ? roundedEvidence(totalArea / scopeArea)
        : 0,
      largestObjects,
      largestObjectCoverage: {
        returnedCount: largestObjects.length,
        omittedCount: Math.max(0, records.length - largestObjects.length),
        limit: MAX_COMPOSITION_SAMPLES,
        truncated: largestObjects.length < records.length,
      },
      caveat: "summed_bounds_area_can_exceed_scope_area_when_objects_overlap",
      heterogeneityCaveat:
        "median_area_is_selection_sensitive_for_mixed_decorative_and_structural_parts",
    },
    distribution: {
      objectCenterAverageNormalized: centerAverage,
      areaWeightedCenterNormalized: areaWeightedCenter,
      quadrantObjectCounts,
      nearestNeighbor: {
        normalization: "scope_diagonal",
        medianNormalizedDistance: medianNearestDistance === null
          ? null
          : roundedEvidence(medianNearestDistance),
        farthestObjects,
        farthestObjectCoverage: {
          returnedCount: farthestObjects.length,
          omittedCount: Math.max(0, nearestNeighborRecords.length - farthestObjects.length),
          limit: MAX_COMPOSITION_SAMPLES,
          truncated: farthestObjects.length < nearestNeighborRecords.length,
        },
        caveat: "center_distance_is_not_edge_clearance_or_integration_quality",
      },
      caveat: "centers_and_quadrants_do_not_measure_visual_weight_or_user_intent",
    },
  };
}

function focusWorkingSetObjects(
  candidates: readonly CanvasObject[],
  focusObjectIds: readonly string[],
  boundsByObjectId: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>,
): CanvasObject[] {
  const byId = new Map(candidates.map((object) => [object.id, object]));
  const focusIds = new Set(focusObjectIds);
  const focusObjects = focusObjectIds.flatMap((objectId) => byId.get(objectId) ?? []);
  const contextIds = new Set<string>();
  const addContext = (objectId: string | null) => {
    if (objectId && !focusIds.has(objectId) && byId.has(objectId)) contextIds.add(objectId);
  };

  for (const object of [...candidates].sort((left, right) => left.id.localeCompare(right.id))) {
    if (object.kind !== "connector") continue;
    if (
      !focusIds.has(object.id)
      && !focusIds.has(object.start.objectId ?? "")
      && !focusIds.has(object.end.objectId ?? "")
    ) continue;
    addContext(object.id);
    addContext(object.start.objectId);
    addContext(object.end.objectId);
  }

  const focusGroupIds = new Set(
    focusObjects.flatMap((object) => object.groupId ? [object.groupId] : []),
  );
  if (focusGroupIds.size) {
    for (const object of candidates) {
      if (object.groupId && focusGroupIds.has(object.groupId)) addContext(object.id);
    }
  }

  const focusBounds = unionBounds(
    focusObjects.flatMap((object) => boundsByObjectId.get(object.id) ?? []),
  );
  const distanceFromFocus = (object: CanvasObject): number => {
    const bounds = boundsByObjectId.get(object.id);
    if (!bounds || !focusBounds) return Number.POSITIVE_INFINITY;
    const x = bounds.x + bounds.width / 2 - (focusBounds.x + focusBounds.width / 2);
    const y = bounds.y + bounds.height / 2 - (focusBounds.y + focusBounds.height / 2);
    return x * x + y * y;
  };
  const orderedContext = [...candidates]
    .filter((object) => !focusIds.has(object.id))
    .sort((left, right) => {
      const leftRelated = contextIds.has(left.id) ? 0 : 1;
      const rightRelated = contextIds.has(right.id) ? 0 : 1;
      return leftRelated - rightRelated
        || distanceFromFocus(left) - distanceFromFocus(right)
        || left.zIndex - right.zIndex
        || left.id.localeCompare(right.id);
    })
    .slice(0, CANVAS_PREVIEW_LIMITS.maxFocusContextRecords);
  return [...focusObjects, ...orderedContext];
}

function diagramFindingKeys(
  report: DiagramVisualQualityReport | null,
  relevantObjectIds: ReadonlySet<string> | null,
): string[] {
  if (!report) return [];
  return report.findings.flatMap((finding) => {
    const identities = [...finding.objectIds, ...finding.connectorIds].sort();
    if (relevantObjectIds && !identities.some((objectId) => relevantObjectIds.has(objectId))) return [];
    return [`diagram:${finding.code.toLowerCase()}:${stableDigest(identities).slice("fnv1a32:".length)}`];
  });
}

function sceneContextByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function stabilizeSceneContextByteLength<
  Packet extends { coverage: { resultByteLength: number } },
>(packet: Packet): number {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const byteLength = sceneContextByteLength(packet);
    if (packet.coverage.resultByteLength === byteLength) return byteLength;
    packet.coverage.resultByteLength = byteLength;
  }
  return sceneContextByteLength(packet);
}

function assertSceneContextByteBudget(
  packet: Pick<CanvasInspectionEvidence, "coverage" | "representation">,
): void {
  if (packet.coverage.resultByteLength <= CANVAS_PREVIEW_LIMITS.maxSceneContextBytes) return;
  throw new CanvasPreviewError(
    "PREVIEW_SCENE_CONTEXT_TOO_LARGE",
    "The bounded scene-context packet exceeds its byte budget; use overview or inspect a smaller focus scope.",
    {
      byteLength: packet.coverage.resultByteLength,
      maxBytes: CANVAS_PREVIEW_LIMITS.maxSceneContextBytes,
      representation: packet.representation,
    },
  );
}

export function finalizeCanvasSceneContext(
  evidence: CanvasInspectionEvidence,
  pixels: CanvasInspectionPixels,
): CanvasSceneContext {
  const packet: CanvasSceneContext = {
    ...evidence,
    coverage: { ...evidence.coverage, resultByteLength: 0 },
    pixels,
  };
  stabilizeSceneContextByteLength(packet);
  assertSceneContextByteBudget(packet);
  return packet;
}

function buildInspectionEvidence(
  canvas: CanvasRuntime,
  room: RoomState,
  request: CanvasPreviewRenderRequest,
  scopeBounds: { x: number; y: number; width: number; height: number },
  renderedBounds: { x: number; y: number; width: number; height: number },
  contributors: readonly CanvasObject[],
  boundsByObjectId: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>,
  visualQuality: DiagramVisualQualityReport | null,
): CanvasInspectionEvidence {
  const isLegacyPreview = request.inspection === undefined;
  const inspection = request.inspection ?? {
    representation: "working_set" as const,
    focusObjectIds: [],
    visualContract: null,
    previousFindingKeys: [],
  };
  const requestedIds = new Set(request.objects.map((object) => object.id));
  const focusIds = new Set(inspection.focusObjectIds);
  const candidateObjects = new Map(contributors.map((object) => [object.id, object]));
  if (
    inspection.representation === "focus"
    || (request.source.kind === "objects" && inspection.representation !== "overview")
  ) {
    for (const object of request.objects) candidateObjects.set(object.id, object);
  }
  const candidateObjectList = [...candidateObjects.values()]
    .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
  const compactCandidateObjects = candidateObjectList
    .filter((object) => boundsByObjectId.has(object.id));
  if (
    !isLegacyPreview
    && inspection.representation === "working_set"
    && compactCandidateObjects.length > CANVAS_PREVIEW_LIMITS.maxWorkingSetRecords
  ) {
    throw new CanvasPreviewError(
      "PREVIEW_WORKING_SET_TOO_LARGE",
      "The exact scope has too many compact working-set records; use overview or inspect a smaller exact/focus scope.",
      {
        recordCount: compactCandidateObjects.length,
        maxWorkingSetRecords: CANVAS_PREVIEW_LIMITS.maxWorkingSetRecords,
      },
    );
  }
  const workingSetObjects = inspection.representation === "overview"
    ? []
    : inspection.representation === "focus"
      ? focusWorkingSetObjects(candidateObjectList, inspection.focusObjectIds, boundsByObjectId)
      : isLegacyPreview
        ? candidateObjectList.slice(0, CANVAS_PREVIEW_LIMITS.maxFocusedRecords)
        : candidateObjectList;
  const workingSet = workingSetObjects
    .flatMap((object) => {
      const bounds = boundsByObjectId.get(object.id);
      return bounds ? [compactRecord(object, bounds, requestedIds)] : [];
    })
    .sort((left, right) => left.zIndex - right.zIndex || left.objectId.localeCompare(right.objectId));
  const allExplicitTargetsRepresented = request.source.kind !== "objects"
    || inspection.representation === "overview"
    || request.objects.every((object) => workingSet.some((record) => record.objectId === object.id));
  if (!isLegacyPreview && inspection.representation === "working_set" && !allExplicitTargetsRepresented) {
    throw new CanvasPreviewError(
      "PREVIEW_EXPLICIT_TARGET_UNREPRESENTED",
      "Every explicit object target must be represented; inspect overview or request a smaller exact object scope.",
      { objectIds: request.objects.map((object) => object.id) },
    );
  }
  const objectById = new Map([...request.objects, ...contributors].map((object) => [object.id, object]));
  const focused = inspection.focusObjectIds.flatMap((objectId): CanvasFocusedObjectRecord[] => {
    const object = objectById.get(objectId);
    if (!object) return [];
    const bounds = boundsByObjectId.get(object.id);
    if (!bounds) return [];
    const compact = compactRecord(object, bounds, requestedIds);
    return [{
      ...compact,
      createdBy: { participantId: object.createdBy.participantId, kind: object.createdBy.kind },
      lastEditedBy: { participantId: object.lastEditedBy.participantId, kind: object.lastEditedBy.kind },
      semantic: semanticEvidence(object),
    }];
  });
  if (focused.length !== focusIds.size) {
    throw new CanvasPreviewError(
      "PREVIEW_FOCUS_UNAVAILABLE",
      "One or more exact focus objects could not be represented; inspect a smaller current scope.",
      { focusObjectIds: inspection.focusObjectIds },
    );
  }

  const contributorIds = new Set(contributors.map((object) => object.id));
  const analysisObjects = inspection.representation === "focus" || isLegacyPreview
    ? workingSetObjects.filter((object) => contributorIds.has(object.id))
    : contributors;
  const analysisObjectIds = new Set(analysisObjects.map((object) => object.id));
  const sourceIdentity = request.source.kind === "diagram"
    ? {
        kind: request.source.kind,
        diagramId: request.source.diagramId,
        createdAt: request.diagram?.createdAt ?? room.diagrams[request.source.diagramId]?.createdAt ?? null,
      }
    : request.source.kind === "objects"
      ? {
          kind: request.source.kind,
          objects: request.objects
            .map((object) => ({ objectId: object.id, createdAt: object.createdAt }))
            .sort((left, right) => left.objectId.localeCompare(right.objectId)),
        }
      : { kind: request.source.kind };
  const scopeObjectIncarnations = request.objects
    .map((object) => ({ objectId: object.id, createdAt: object.createdAt }))
    .sort((left, right) => left.objectId.localeCompare(right.objectId));
  const analysisObjectIncarnations = analysisObjects
    .map((object) => ({ objectId: object.id, createdAt: object.createdAt }))
    .sort((left, right) => left.objectId.localeCompare(right.objectId));
  const scopeIdentity = `scope:v2:${stableDigest({
    room: { roomId: room.id, createdAt: room.createdAt },
    source: sourceIdentity,
    scopeObjectIncarnations,
    representation: inspection.representation,
    focusObjectIds: [...focusIds].sort(),
    evidenceObjectIncarnations: analysisObjectIncarnations,
  }).slice("fnv1a32:".length)}`;

  const overlapRecords = analysisObjects
    .flatMap((object) => {
      const bounds = boundsByObjectId.get(object.id);
      return bounds ? [{ objectId: object.id, bounds }] : [];
    })
    .sort((left, right) => left.objectId.localeCompare(right.objectId));
  const boundsOverlapItems: CanvasInspectionEvidence["boundsOverlaps"]["items"] = [];
  let boundsOverlapCount = 0;
  for (let leftIndex = 0; leftIndex < overlapRecords.length; leftIndex += 1) {
    const left = overlapRecords[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < overlapRecords.length; rightIndex += 1) {
      const right = overlapRecords[rightIndex];
      const overlap = intersects(left.bounds, right.bounds);
      if (!overlap) continue;
      boundsOverlapCount += 1;
      if (boundsOverlapItems.length < MAX_INSPECTION_RELATIONS) {
        const objectIds: [string, string] = [left.objectId, right.objectId];
        boundsOverlapItems.push({
          factKey: `bounds_overlap:${stableDigest(objectIds).slice("fnv1a32:".length)}`,
          method: "axis_aligned_renderer_bounds",
          objectIds,
          bounds: overlap,
          area: overlap.width * overlap.height,
          interpretation: "bounds_overlap_only_not_proof_of_painted_intersection_or_occlusion",
        });
      }
    }
  }

  const textOcclusionRisks: CanvasInspectionEvidence["textOcclusionRisks"] = [];
  if (inspection.representation !== "overview") {
    const opaqueRectangleOccluders = analysisObjects.filter((object) =>
      object.kind === "shape"
      && object.shape === "rectangle"
      && object.rotation === 0
      && semanticFillColor(object.fill, "blue", true) !== "none"
    );
    for (const labelObject of analysisObjects) {
      const text = estimatedTextBounds(labelObject);
      if (!text) continue;
      for (const occluder of opaqueRectangleOccluders) {
        if (occluder.id === labelObject.id || !paintsAfter(occluder, labelObject)) continue;
        const overlapBounds = intersects(text.bounds, {
          x: occluder.x,
          y: occluder.y,
          width: occluder.width,
          height: occluder.height,
        });
        if (!overlapBounds) continue;
        const identity = [
          { objectId: labelObject.id, createdAt: labelObject.createdAt },
          { objectId: occluder.id, createdAt: occluder.createdAt },
        ];
        const findingKey = `${scopeIdentity}:text:text_occlusion_risk:${stableDigest(identity).slice("fnv1a32:".length)}`;
        textOcclusionRisks.push({
          findingKey,
          labelObjectId: labelObject.id,
          labelObjectRevision: labelObject.revision,
          occludingObjectId: occluder.id,
          occludingObjectRevision: occluder.revision,
          source: text.source,
          method: "shared_text_layout_bounds_and_exact_rectangle_paint_order",
          status: "likely",
          labelBounds: text.bounds,
          overlapBounds,
          summary: `A later-painted opaque rectangle ${occluder.id} overlaps the estimated rendered text of ${labelObject.id}. Inspect the exact pixels; if unintended, move or resize one of those exact-revision objects, or place the label in a separate clear text object.`,
        });
        if (textOcclusionRisks.length >= MAX_INSPECTION_RELATIONS) break;
      }
      if (textOcclusionRisks.length >= MAX_INSPECTION_RELATIONS) break;
    }
  }

  const routeObjects = inspection.representation === "overview"
    ? []
    : workingSetObjects.filter((object) => object.kind === "connector");
  const routes = routeObjects.slice(0, CANVAS_PREVIEW_LIMITS.maxWorkingSetRecords).map((object) => {
    if (object.kind !== "connector") throw new Error("connector narrowed above");
    const route = materializeConnectorRoute(object, room);
    return {
      connectorId: object.id,
      revision: object.revision,
      startObjectId: object.start.objectId,
      endObjectId: object.end.objectId,
      routing: route.routing,
      points: route.points,
      labelBounds: route.labelBounds,
      bounds: route.bounds,
    };
  });
  const allTextFindings = analysisObjects.flatMap((object): CanvasInspectionEvidence["textFindings"] => {
    const text = objectText(object);
    if (text === null) return [];
    if (!text.trim()) {
      // Blank visible text is a valid visual choice for decorative shapes and
      // unlabeled connectors. Semantic identity still makes those parts
      // retrievable; presenting them as correction findings would steer an
      // authoring agent toward adding accidental canvas labels. Text objects,
      // images (alt text), and classified diagram nodes do carry an expected
      // textual contract, so an empty value remains useful evidence there.
      const expectsVisibleText = object.kind === "text"
        || object.kind === "image"
        || (object.kind === "shape" && object.nodeType !== null);
      if (!expectsVisibleText) return [];
      const findingKey = `${scopeIdentity}:text:text_empty:${stableDigest(object.id).slice("fnv1a32:".length)}`;
      return [{
        findingKey,
        objectId: object.id,
        code: "TEXT_EMPTY",
        status: "observed",
        summary: "This semantic text field is empty; inspect pixels and intent before treating it as a defect.",
      }];
    }
    const approximateCapacity = Math.max(8, Math.floor(object.width / 11))
      * Math.max(1, Math.floor(object.height / 26));
    if (text.length <= approximateCapacity * 1.5) return [];
    const findingKey = `${scopeIdentity}:text:text_likely_clipped:${stableDigest(object.id).slice("fnv1a32:".length)}`;
    return [{
      findingKey,
      objectId: object.id,
      code: "TEXT_LIKELY_CLIPPED",
      status: "likely",
      summary: "Text exceeds a bounds-based capacity estimate; pixel inspection is required before correction.",
    }];
  });
  const contrastFindings = analysisObjects.flatMap((object): CanvasInspectionEvidence["contrastFindings"] => {
    if (hasContextDependentContrast(object)) return [];
    let foreground: string;
    let background: string;
    let context: CanvasInspectionEvidence["contrastFindings"][number]["context"];
    let caveat: string;
    if (object.kind === "shape" || object.kind === "path") {
      foreground = semanticStrokeColor(object.stroke, "blue");
      background = semanticFillColor(object.fill, "blue", false);
      context = "stroke_vs_fill";
      caveat = "Declared opaque stroke versus fill only; no aesthetic threshold or neighboring pixels are inferred.";
    } else if (object.kind === "text" || object.kind === "connector" || object.kind === "draw") {
      foreground = semanticStrokeColor(object.color, "black");
      background = "#ffffff";
      context = object.kind === "text" ? "text_vs_canvas" : "stroke_vs_canvas";
      caveat = "Declared color versus nominal white canvas only; overlap can change the actual background.";
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
  }).slice(0, MAX_INSPECTION_RELATIONS);
  const unsupported: CanvasInspectionEvidence["coverage"]["unsupported"] = [
    ...(request.diagram && inspection.representation === "overview" && !visualQuality
      ? [{
          analysis: "diagram_geometry_deferred_in_overview" as const,
          reason: "Overview intentionally omits full Diagram geometry; use working_set or focus for deterministic Diagram quality evidence.",
        }]
      : []),
    ...(inspection.representation === "overview"
      ? [{
          analysis: "text_occlusion_deferred_in_overview" as const,
          reason: "Overview omits paint-order text-occlusion analysis; use working_set or focus for bounded exact-object evidence.",
        }]
      : []),
    ...analysisObjects.flatMap((object) => {
    const items: CanvasInspectionEvidence["coverage"]["unsupported"] = [];
    if (object.kind === "draw") items.push({
      objectId: object.id,
      analysis: "freehand_swept_path",
      reason: "Only renderer bounds are deterministic; swept-stroke intersections and visual content require pixels.",
    });
    if (object.kind === "path") items.push({
      objectId: object.id,
      analysis: "vector_path_geometry",
      reason: "Path metadata is exact, but curve intersections and filled-path overlap require pixel inspection.",
    });
    if (hasContextDependentContrast(object)) items.push({
      objectId: object.id,
      analysis: "context_dependent_contrast",
      reason: "Transparency makes contrast depend on actual contributing pixels.",
    });
    if (object.rotation !== 0) items.push({
      objectId: object.id,
      analysis: "rotated_exact_intersection",
      reason: "Bounds-overlap facts use axis-aligned renderer bounds, not rotated polygon clipping.",
    });
    if (object.kind === "image") items.push({
      objectId: object.id,
      analysis: "image_internal_pixels",
      reason: "Image bounds are exact; internal content and contrast require pixel inspection.",
    });
      return items;
    }),
  ];
  const allFindingKeys = [...new Set([
    ...allTextFindings.map((finding) => finding.findingKey),
    ...textOcclusionRisks.map((finding) => finding.findingKey),
    ...diagramFindingKeys(
      visualQuality,
      inspection.representation === "focus" ? analysisObjectIds : null,
    ).map((findingKey) => `${scopeIdentity}:${findingKey}`),
  ])].sort();
  const findingKeys = allFindingKeys.slice(0, CANVAS_PREVIEW_LIMITS.maxFindingKeys);
  const allVisualContributorsAnalyzed = contributors.every((object) => analysisObjectIds.has(object.id));
  const currentFindingSetFullyEnumerated = allVisualContributorsAnalyzed
    && allFindingKeys.length <= findingKeys.length
    && (!request.diagram || visualQuality !== null)
    && !(visualQuality?.metrics.findingsTruncated ?? false);
  const geometryCoverageComplete = unsupported.length === 0
    && (!request.diagram || visualQuality?.geometryCoverage.status === "complete");
  const findingCoverageComplete = currentFindingSetFullyEnumerated && geometryCoverageComplete;
  const currentFindingCoverageComplete = findingCoverageComplete;
  const current = new Set(findingKeys);
  const sameScopeCallerSupplied = new Set(
    inspection.previousFindingKeys.filter((findingKey) => findingKey.startsWith(`${scopeIdentity}:`)),
  );
  const sameScopeCallerSuppliedSorted = [...sameScopeCallerSupplied].sort();
  const allExplicitObjectRevisions = request.source.kind === "objects"
    ? request.objects
        .map((object) => ({ objectId: object.id, revision: object.revision }))
        .sort((left, right) => left.objectId.localeCompare(right.objectId))
    : [];
  const explicitObjectRevisions = allExplicitObjectRevisions.slice(
    0,
    CANVAS_PREVIEW_LIMITS.maxExplicitRevisionRecords,
  );
  const packet: CanvasInspectionEvidence = {
    schemaVersion: 2,
    rendererId: canvas.rendererId,
    representation: inspection.representation,
    scope: {
      identity: scopeIdentity,
      kind: request.source.kind,
      diagramId: request.source.kind === "diagram" ? request.source.diagramId : null,
      focusObjectIds: [...focusIds].sort(),
      identityBasis: "created_at_incarnations",
    },
    visualContract: inspection.visualContract,
    revisions: {
      roomRevision: room.roomRevision,
      diagramRevision: request.source.kind === "diagram" ? request.source.expectedRevision : null,
      explicitObjectRevisions,
      explicitObjectRevisionCoverage: {
        totalCount: allExplicitObjectRevisions.length,
        returnedCount: explicitObjectRevisions.length,
        omittedCount: allExplicitObjectRevisions.length - explicitObjectRevisions.length,
        limit: CANVAS_PREVIEW_LIMITS.maxExplicitRevisionRecords,
        truncated: explicitObjectRevisions.length < allExplicitObjectRevisions.length,
        fullSetDigest: stableDigest(allExplicitObjectRevisions),
      },
    },
    coverage: {
      scopeObjectCount: request.objects.length,
      visualContributorCount: contributors.length,
      compactRecordCount: workingSet.length,
      focusedRecordCount: focused.length,
      omittedCompactRecordCount: Math.max(0, compactCandidateObjects.length - workingSet.length),
      allExplicitTargetsRepresented,
      resultByteLength: 0,
      resultByteLimit: CANVAS_PREVIEW_LIMITS.maxSceneContextBytes,
      findings: findingCoverageComplete ? "complete" : "partial",
      geometry: geometryCoverageComplete ? "complete" : "partial",
      unsupported: unsupported.slice(0, MAX_UNSUPPORTED_DISCLOSURES),
      omittedUnsupportedCount: Math.max(0, unsupported.length - MAX_UNSUPPORTED_DISCLOSURES),
    },
    overview: {
      bounds: scopeBounds,
      objectCount: request.objects.length,
      kinds: kindCounts(request.objects),
      spatialClusters: spatialClusters(request.objects, scopeBounds, boundsByObjectId),
    },
    composition: compositionEvidence(
      request.objects,
      request.source.kind,
      scopeBounds,
      renderedBounds,
      request.options.padding,
      boundsByObjectId,
    ),
    workingSet,
    focused,
    routes,
    relationships: routes.map((route) => {
      const connector = objectById.get(route.connectorId);
      return {
        connectorId: route.connectorId,
        startObjectId: route.startObjectId,
        endObjectId: route.endObjectId,
        direction: connector?.kind === "connector" ? connector.direction : "none",
        label: boundedText(connector?.kind === "connector" ? connector.label : "", 96),
      };
    }),
    boundsOverlaps: {
      totalCount: boundsOverlapCount,
      truncated: boundsOverlapCount > boundsOverlapItems.length,
      items: boundsOverlapItems,
    },
    textOcclusionRisks,
    textFindings: allTextFindings.slice(0, MAX_INSPECTION_RELATIONS),
    contrastFindings,
    findingKeys,
    findingKeysTruncated: allFindingKeys.length > findingKeys.length,
    findingComparison: {
      basis: "caller_supplied_unverified",
      suppliedKeyCount: inspection.previousFindingKeys.length,
      sameScopeSuppliedKeyCount: sameScopeCallerSupplied.size,
      ignoredDifferentScopeSuppliedKeyCount:
        inspection.previousFindingKeys.length - sameScopeCallerSupplied.size,
      currentFindingCoverageComplete,
      observedFindingKeysNotSupplied: findingKeys.filter((key) => !sameScopeCallerSupplied.has(key)),
      callerSuppliedFindingKeysObservedAgain: findingKeys.filter((key) => sameScopeCallerSupplied.has(key)),
      callerSuppliedSameScopeKeysNotObserved: currentFindingCoverageComplete
        ? sameScopeCallerSuppliedSorted.filter((key) => !current.has(key))
        : [],
      interpretation: "not_observed_does_not_prove_resolved",
    },
  };
  stabilizeSceneContextByteLength(packet);
  assertSceneContextByteBudget(packet);
  return packet;
}

function inspectionMetadata(
  canvas: CanvasRuntime,
  room: RoomState,
  request: CanvasPreviewRenderRequest,
  scopeBounds: { x: number; y: number; width: number; height: number },
  renderedBounds: { x: number; y: number; width: number; height: number },
): CanvasInspectionMetadata {
  const boundsByObjectId = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();
  const contributors = canvas.getDocumentObjectIds().flatMap((objectId) => {
    const object = room.objects[objectId];
    const objectBounds = canvas.getObjectBounds(objectId);
    if (objectBounds) boundsByObjectId.set(objectId, objectBounds);
    return object && objectBounds && intersects(objectBounds, renderedBounds) ? [object] : [];
  });
  for (const object of request.objects) {
    if (boundsByObjectId.has(object.id)) continue;
    const objectBounds = canvas.getObjectBounds(object.id);
    if (objectBounds) boundsByObjectId.set(object.id, objectBounds);
  }
  if (contributors.length > CANVAS_PREVIEW_LIMITS.maxTargets) {
    throw new CanvasPreviewError(
      "PREVIEW_VISUAL_CONTEXT_TOO_LARGE",
      "More than 1,000 authoritative objects contribute pixels to this inspection region; inspect a smaller scope.",
      { contributorCount: contributors.length, maxTargets: CANVAS_PREVIEW_LIMITS.maxTargets },
    );
  }
  const visualQuality = request.diagram && request.inspection?.representation !== "overview"
    ? analyzeDiagramVisualQuality(room, request.diagram.id)
    : null;
  return {
    renderedBounds,
    padding: request.options.padding,
    source: {
      ...request.source,
      roomRevision: room.roomRevision,
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
    visualQuality,
    inspectionEvidence: buildInspectionEvidence(
      canvas,
      room,
      request,
      scopeBounds,
      renderedBounds,
      contributors,
      boundsByObjectId,
      visualQuality,
    ),
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
  const scopeBounds = canvas.getVisibleBounds(request.objects.map((object) => object.id));
  if (!scopeBounds || scopeBounds.width <= 0 || scopeBounds.height <= 0) {
    throw new CanvasPreviewError(
      "PREVIEW_BOUNDS_UNAVAILABLE",
      "Jazzboard could not determine renderable bounds for the requested objects.",
    );
  }
  const frameObjectIds = request.inspection?.representation === "focus"
    && request.inspection.focusObjectIds.length
    ? request.inspection.focusObjectIds
    : request.objects.map((object) => object.id);
  const bounds = frameObjectIds.length === request.objects.length
    ? scopeBounds
    : canvas.getVisibleBounds(frameObjectIds);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new CanvasPreviewError(
      "PREVIEW_FOCUS_UNAVAILABLE",
      "Jazzboard could not determine renderable bounds for the requested focus objects.",
      { focusObjectIds: frameObjectIds },
    );
  }
  const renderedBounds = {
    x: bounds.x - request.options.padding,
    y: bounds.y - request.options.padding,
    width: bounds.width + request.options.padding * 2,
    height: bounds.height + request.options.padding * 2,
  };
  const metadata = inspectionMetadata(canvas, room, request, scopeBounds, renderedBounds);
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
  const inspection = inspectionMetadata(canvas, room, request, bounds, renderedBounds);

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
