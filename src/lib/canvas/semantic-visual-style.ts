import type { CanvasObject } from "@/lib/domain/types";

/**
 * Renderer-neutral visual contract for Jazzboard's first-party canvas.
 *
 * Named semantic colors intentionally resolve differently for ink and fill:
 * the solid value is used for strokes/text while the pastel value is used for
 * shape interiors. These pairs are Jazzboard's renderer-independent visual
 * language, shared by the live canvas, previews, and exported images.
 */
export const SEMANTIC_COLOR_PALETTE = Object.freeze({
  black: { solid: "#20242c", semi: "#eaecf0" },
  grey: { solid: "#8f99a8", semi: "#eef0f3" },
  "light-violet": { solid: "#c96fe2", semi: "#f2e5f7" },
  violet: { solid: "#9050c8", semi: "#e9dff3" },
  blue: { solid: "#5266df", semi: "#dfe3f7" },
  "light-blue": { solid: "#4f98dc", semi: "#deedf8" },
  yellow: { solid: "#d99a35", semi: "#f8eedc" },
  orange: { solid: "#d56d30", semi: "#f6e3d9" },
  green: { solid: "#158b68", semi: "#d9ebe5" },
  "light-green": { solid: "#51a568", semi: "#dff0e3" },
  "light-red": { solid: "#eb7779", semi: "#f7dfe0" },
  red: { solid: "#d9484a", semi: "#f6dcdd" },
  white: { solid: "#ffffff", semi: "#f7f7f8" },
} as const);

export type SemanticColorName = keyof typeof SEMANTIC_COLOR_PALETTE;
export type SemanticColorMode = "solid" | "semi";

export const SEMANTIC_CANVAS_BACKGROUND = "#ffffff";
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

const HEX_COLOR_PATTERN = /^(?:#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8})$/i;

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
export function semanticStrokeColor(value: string, fallback = "black", allowNone = false): string {
  const normalized = normalizedColor(value);
  if (allowNone && normalized === "none") return "none";
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
