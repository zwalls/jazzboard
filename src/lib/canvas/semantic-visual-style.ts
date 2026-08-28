import type { CanvasObject } from "@/lib/domain/types";

/**
 * Renderer-neutral visual contract for Jazzboard's first-party canvas.
 *
 * Named semantic colors intentionally resolve differently for ink and fill:
 * the solid value is used for strokes/text while the pastel value is used for
 * shape interiors. This preserves the visual meaning Jazzboard's color tokens
 * had when they were projected through tldraw's `solid` fill style.
 */
export const SEMANTIC_COLOR_PALETTE = Object.freeze({
  black: { solid: "#1d1d1d", semi: "#e8e8e8" },
  grey: { solid: "#9fa8b2", semi: "#eceef0" },
  "light-violet": { solid: "#e085f4", semi: "#f5eafa" },
  violet: { solid: "#ae3ec9", semi: "#ecdcf2" },
  blue: { solid: "#4465e9", semi: "#dce1f8" },
  "light-blue": { solid: "#4ba1f1", semi: "#ddedfa" },
  yellow: { solid: "#f1ac4b", semi: "#f9f0e6" },
  orange: { solid: "#e16919", semi: "#f8e2d4" },
  green: { solid: "#099268", semi: "#d3e9e3" },
  "light-green": { solid: "#4cb05e", semi: "#dbf0e0" },
  "light-red": { solid: "#f87777", semi: "#f4dadb" },
  red: { solid: "#e03131", semi: "#f4dadb" },
  white: { solid: "#ffffff", semi: "#f5f5f5" },
} as const);

export type SemanticColorName = keyof typeof SEMANTIC_COLOR_PALETTE;
export type SemanticColorMode = "solid" | "semi";

export const SEMANTIC_CANVAS_BACKGROUND = "#f9fafb";
export const SEMANTIC_DRAW_FONT_NAME = "Shantell Sans";
export const SEMANTIC_DRAW_FONT_FAMILY =
  "Shantell Sans,Comic Sans MS,Comic Sans,cursive";
export const SEMANTIC_DRAW_FONT_URL =
  "/fonts/shantell-sans-latin-400-normal.woff2";

export const SEMANTIC_TEXT_FONT_SIZES = Object.freeze({
  s: 18,
  m: 24,
  l: 36,
  xl: 44,
} satisfies Readonly<Record<Extract<CanvasObject, { kind: "text" }>["size"], number>>);

export const SEMANTIC_TEXT_LINE_HEIGHT = 1.35;
export const SEMANTIC_SHAPE_LABEL_FONT_SIZE = 22;
export const SEMANTIC_SHAPE_LABEL_LINE_HEIGHT =
  SEMANTIC_SHAPE_LABEL_FONT_SIZE * SEMANTIC_TEXT_LINE_HEIGHT;
export const SEMANTIC_SHAPE_LABEL_PADDING = 16;
export const SEMANTIC_CONNECTOR_LABEL_FONT_SIZE = 20;
export const SEMANTIC_CONNECTOR_LABEL_LINE_HEIGHT =
  SEMANTIC_CONNECTOR_LABEL_FONT_SIZE * SEMANTIC_TEXT_LINE_HEIGHT;

export const SEMANTIC_SHAPE_STROKE_WIDTH = 3.5;
export const SEMANTIC_CONNECTOR_STROKE_WIDTH = 3.5;
export const SEMANTIC_CONNECTOR_ARROW_SIZE = 12;
export const SEMANTIC_SHAPE_CORNER_RADIUS = 7;
export const SEMANTIC_DRAW_STROKE_WIDTHS = Object.freeze({
  s: 3,
  m: 4.5,
  l: 6,
} satisfies Readonly<Record<Extract<CanvasObject, { kind: "draw" }>["size"], number>>);

export const SEMANTIC_SELECTION_COLOR = "#3182ed";
export const SEMANTIC_SELECTION_FILL = "rgba(45, 147, 255, 0.24)";
export const SEMANTIC_SELECTION_STROKE_WIDTH = 1.5;

export function semanticShapeLabelMaxCharacters(width: number): number {
  return Math.max(
    8,
    Math.floor(
      (width - SEMANTIC_SHAPE_LABEL_PADDING * 2) /
      (SEMANTIC_SHAPE_LABEL_FONT_SIZE * 0.58),
    ),
  );
}

export function semanticShapeLabelMaxLines(height: number): number {
  return Math.max(
    1,
    Math.min(
      5,
      Math.floor(
        (height - SEMANTIC_SHAPE_LABEL_PADDING * 1.5) /
        SEMANTIC_SHAPE_LABEL_LINE_HEIGHT,
      ),
    ),
  );
}

const HEX_COLOR_PATTERN = /^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i;

function normalizedColor(value: string): string {
  return value.trim().toLowerCase();
}

function paletteColor(value: string, mode: SemanticColorMode): string | null {
  const entry = SEMANTIC_COLOR_PALETTE[normalizedColor(value) as SemanticColorName];
  return entry?.[mode] ?? null;
}

function resolvedFallback(value: string, mode: SemanticColorMode): string {
  const normalized = normalizedColor(value);
  return paletteColor(normalized, mode) ??
    (HEX_COLOR_PATTERN.test(normalized) ? normalized : SEMANTIC_COLOR_PALETTE.black[mode]);
}

/** Resolve named ink to its saturated stroke/text value; preserve explicit hex. */
export function semanticStrokeColor(value: string, fallback = "black"): string {
  const normalized = normalizedColor(value);
  return paletteColor(normalized, "solid") ??
    (HEX_COLOR_PATTERN.test(normalized) ? normalized : resolvedFallback(fallback, "solid"));
}

/** Resolve named shape fill to its pastel value; preserve explicit custom hex. */
export function semanticFillColor(
  value: string,
  fallback = "blue",
  allowNone = true,
): string {
  const normalized = normalizedColor(value);
  if (allowNone && normalized === "none") return "none";
  return paletteColor(normalized, "semi") ??
    (HEX_COLOR_PATTERN.test(normalized) ? normalized : resolvedFallback(fallback, "semi"));
}

export function semanticPaletteColor(
  value: string,
  mode: SemanticColorMode,
): string | null {
  return paletteColor(value, mode);
}
