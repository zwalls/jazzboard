export const CANVAS_PREVIEW_DEFAULTS = {
  padding: 32,
  maxWidth: 1_536,
  maxHeight: 1_536,
  pixelRatio: 1,
  maxBytes: 4_000_000,
} as const;

export const CANVAS_PREVIEW_LIMITS = {
  maxTargets: 200,
  maxPadding: 256,
  minDimension: 64,
  maxDimension: 4_096,
  minBytes: 16_384,
  maxBytes: 8_000_000,
  maxPixelRatio: 2,
  projectionTimeoutMs: 2_500,
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

export const JAZZBOARD_PREVIEW_TOOL_NAMES = ["render_canvas_preview"] as const;
