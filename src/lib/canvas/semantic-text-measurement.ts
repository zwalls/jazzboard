import {
  layoutSemanticText,
  SEMANTIC_TEXT_MAX_LINES,
  semanticTextMaximumCharacters,
  semanticTextMaximumLines,
} from "./semantic-text-layout";
import {
  SEMANTIC_DRAW_FONT_FAMILY,
  SEMANTIC_DRAW_FONT_NAME,
  SEMANTIC_TEXT_FONT_SIZES,
  SEMANTIC_TEXT_LINE_HEIGHT,
} from "./semantic-visual-style";

type TextSize = keyof typeof SEMANTIC_TEXT_FONT_SIZES;
type TextAlign = "start" | "middle" | "end";
export type SemanticTextMetrics = Pick<TextMetrics,
  "width" | "actualBoundingBoxLeft" | "actualBoundingBoxRight" |
  "actualBoundingBoxAscent" | "actualBoundingBoxDescent">;
export type SemanticTextMeasurer = (text: string, fontSize: number) => SemanticTextMetrics;

export class SemanticTextMeasurementError extends Error {
  constructor(public readonly code: "TEXT_MEASUREMENT_UNAVAILABLE" | "TEXT_CANNOT_FIT", message: string) {
    super(message);
    this.name = "SemanticTextMeasurementError";
  }
}

let loadedFont: Promise<void> | undefined;
let measuringContext: CanvasRenderingContext2D | undefined;

function cancelled(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Text measurement cancelled.", "AbortError");
}

/** Load the same font embedded by PNG export before measuring. Never certify fallback-font bounds. */
export async function semanticTextMeasurer(signal: AbortSignal): Promise<SemanticTextMeasurer> {
  cancelled(signal);
  if (typeof document === "undefined" || !document.fonts?.load) {
    throw new SemanticTextMeasurementError("TEXT_MEASUREMENT_UNAVAILABLE", "Loaded-font text measurement requires the canvas browser.");
  }
  const font = `400 24px "${SEMANTIC_DRAW_FONT_NAME}"`;
  loadedFont ??= document.fonts.load(font, "Jazzboard").then((faces) => {
    if (!faces.length || !document.fonts.check(font, "Jazzboard")) {
      throw new SemanticTextMeasurementError("TEXT_MEASUREMENT_UNAVAILABLE", "The canvas font has not loaded; retry after it is available.");
    }
  }).catch((error) => {
    loadedFont = undefined;
    throw error;
  });
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new DOMException("Text measurement cancelled.", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    loadedFont!.then(() => { cleanup(); resolve(); }, (error) => { cleanup(); reject(error); });
  });
  cancelled(signal);
  measuringContext ??= document.createElement("canvas").getContext("2d") ?? undefined;
  if (!measuringContext) {
    throw new SemanticTextMeasurementError("TEXT_MEASUREMENT_UNAVAILABLE", "The browser could not create a text measurement context.");
  }
  const context = measuringContext;
  return (text, fontSize) => {
    cancelled(signal);
    context.font = `400 ${fontSize}px ${SEMANTIC_DRAW_FONT_FAMILY}`;
    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    const metrics = context.measureText(text);
    if (![metrics.width, metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight,
      metrics.actualBoundingBoxAscent, metrics.actualBoundingBoxDescent].every(Number.isFinite)) {
      throw new SemanticTextMeasurementError("TEXT_MEASUREMENT_UNAVAILABLE", "The browser did not return ink metrics for the canvas font.");
    }
    return metrics;
  };
}

/** Measure the exact line strings and baselines used by live SVG, drafts, and PNG SVG. */
export function measureSemanticText(
  content: string, width: number, height: number, size: TextSize, align: TextAlign,
  measure: SemanticTextMeasurer,
) {
  const fontSize = SEMANTIC_TEXT_FONT_SIZES[size];
  const layout = layoutSemanticText(content, semanticTextMaximumCharacters(width, fontSize), semanticTextMaximumLines(height, fontSize));
  const anchor = align === "start" ? 0 : align === "end" ? width : width / 2;
  const boxes = layout.lines.map((line, index) => {
    const metrics = measure(line, fontSize);
    const origin = anchor - (align === "start" ? 0 : align === "end" ? metrics.width : metrics.width / 2);
    const baseline = Math.min(fontSize, height / 2) + index * fontSize * SEMANTIC_TEXT_LINE_HEIGHT;
    return {
      left: origin - metrics.actualBoundingBoxLeft,
      right: origin + metrics.actualBoundingBoxRight,
      top: baseline - metrics.actualBoundingBoxAscent,
      bottom: baseline + metrics.actualBoundingBoxDescent,
    };
  });
  const left = boxes.length ? Math.min(...boxes.map((box) => box.left)) : 0;
  const top = boxes.length ? Math.min(...boxes.map((box) => box.top)) : 0;
  const right = boxes.length ? Math.max(...boxes.map((box) => box.right)) : 0;
  const bottom = boxes.length ? Math.max(...boxes.map((box) => box.bottom)) : 0;
  const inkOverflow = left < -0.5 || top < -0.5 || right > width + 0.5 || bottom > height + 0.5;
  return {
    measurement: "loaded_font_renderer_lines" as const,
    fontFamily: SEMANTIC_DRAW_FONT_FAMILY,
    fontSize,
    ...layout,
    inkBounds: { x: left, y: top, width: right - left, height: bottom - top },
    warnings: [
      ...(layout.truncated ? ["text_truncated"] : []),
      ...(inkOverflow ? ["text_ink_overflow"] : []),
    ],
  };
}

/** Opt-in fitting keeps the established renderer's wrapping; it does not change stored content. */
export function fitSemanticText(
  content: string, minimumWidth: number, size: TextSize, align: TextAlign,
  measure: SemanticTextMeasurer,
) {
  const fontSize = SEMANTIC_TEXT_FONT_SIZES[size];
  let width = minimumWidth;
  // Widen at most 32 times, bounded by the persisted dimension ceiling.
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const layout = layoutSemanticText(content, semanticTextMaximumCharacters(width, fontSize), SEMANTIC_TEXT_MAX_LINES);
    if (layout.truncated) {
      if (width >= 100_000) break;
      width = Math.min(100_000, Math.ceil(width * 1.5));
      continue;
    }
    const metrics = layout.lines.map((line) => measure(line, fontSize));
    const neededWidth = Math.max(width, ...metrics.map((metric) => Math.max(metric.width, metric.actualBoundingBoxRight) + Math.max(0, metric.actualBoundingBoxLeft)));
    if (neededWidth > width) {
      if (neededWidth > 100_000) break;
      width = Math.ceil(neededWidth + 1);
      continue;
    }
    const descent = Math.max(0, ...metrics.map((metric) => metric.actualBoundingBoxDescent));
    const height = Math.ceil(Math.max(2 * fontSize, fontSize + Math.max(0, layout.lines.length - 1) * fontSize * SEMANTIC_TEXT_LINE_HEIGHT + descent + 1));
    if (height > 100_000) break;
    const measured = measureSemanticText(content, width, height, size, align, measure);
    if (measured.warnings.length) {
      throw new SemanticTextMeasurementError("TEXT_CANNOT_FIT", "The rendered text has ink overhang; choose explicit bounds and inspect the canvas.");
    }
    return { width, height };
  }
  throw new SemanticTextMeasurementError("TEXT_CANNOT_FIT", "Text cannot fit the renderer's six-line or dimension limits. Split it into text objects or choose explicit bounds; content was not changed.");
}
