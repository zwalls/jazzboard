export const CANVAS_PREVIEW_DEFAULTS = {
  padding: 32,
  maxWidth: 1_536,
  maxHeight: 1_536,
  pixelRatio: 1,
  maxBytes: 4_000_000,
} as const;

export const CANVAS_PREVIEW_LIMITS = {
  // Diagram membership is bounded to 500 members plus 500 connectors. Keep a
  // complete exact-Diagram preview possible while retaining a hard browser
  // memory ceiling for arbitrary object scopes.
  maxTargets: 1_000,
  maxPadding: 256,
  minDimension: 64,
  maxDimension: 4_096,
  minBytes: 16_384,
  maxBytes: 8_000_000,
  maxPixelRatio: 2,
  projectionTimeoutMs: 2_500,
  maxWorkingSetRecords: 120,
  maxFocusedRecords: 16,
  maxFocusContextRecords: 8,
  maxCompactDiagramIds: 16,
  maxExplicitRevisionRecords: 64,
  maxSpatialClusters: 16,
  // The scene context is only one member of the WebMCP result. Keep explicit
  // headroom for the bounded framing/protocol envelope and then enforce the
  // complete serialized result separately.
  maxSceneContextBytes: 88_000,
  maxInspectionResultBytes: 96_000,
  maxFindingKeys: 128,
  maxContractIntentLength: 1_000,
  maxContractCriteria: 16,
  maxContractCriterionLength: 500,
  maxContractPreserveObjectIds: 64,
} as const;

export class CanvasPreviewError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CanvasPreviewError";
  }
}

export const JAZZBOARD_PREVIEW_READ_TOOL_NAMES = ["inspect_canvas_scope"] as const;
export const JAZZBOARD_PREVIEW_TOOL_NAMES = [
  "render_canvas_preview",
  ...JAZZBOARD_PREVIEW_READ_TOOL_NAMES,
] as const;
