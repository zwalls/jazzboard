import { SEMANTIC_TEXT_LINE_HEIGHT } from "./semantic-visual-style";

/**
 * Renderer-neutral text wrapping shared by the live semantic canvas, PNG
 * export, and deterministic visual-quality analysis.
 *
 * These limits are presentation constraints, not schema limits: content is
 * preserved authoritatively even when the renderer has to show an ellipsis.
 */
export const SEMANTIC_TEXT_MAX_LINES = 6;
export const SEMANTIC_CONNECTOR_LABEL_MAX_LINES = 20;
export const SEMANTIC_TEXT_GRAPHEME_WIDTH_FACTOR = 0.58;
export const SEMANTIC_CONNECTOR_LABEL_GRAPHEME_WIDTH = 11;
export const SEMANTIC_CONNECTOR_LABEL_TOTAL_INSET = 9;

export type SemanticTextLayout = Readonly<{
  lines: readonly string[];
  requiredLineCount: number;
  truncated: boolean;
}>;

export function semanticTextMaximumCharacters(width: number, fontSize: number): number {
  return Math.max(
    8,
    Math.floor(width / (fontSize * SEMANTIC_TEXT_GRAPHEME_WIDTH_FACTOR)),
  );
}

/**
 * Return the number of baselines that fit inside a text object's authoritative
 * height using the same first-baseline and line-height geometry as both SVG
 * renderers. The six-line presentation cap still applies to tall objects.
 */
export function semanticTextMaximumLines(height: number, fontSize: number): number {
  const safeHeight = Math.max(0, height);
  const safeFontSize = Math.max(1, fontSize);
  const firstBaselineOffset = Math.min(safeFontSize, safeHeight / 2);
  const availableAfterFirstBaseline = Math.max(0, safeHeight - firstBaselineOffset);
  return Math.max(
    1,
    Math.min(
      SEMANTIC_TEXT_MAX_LINES,
      1 + Math.floor(
        (availableAfterFirstBaseline + 1e-9) /
        (safeFontSize * SEMANTIC_TEXT_LINE_HEIGHT),
      ),
    ),
  );
}

export function semanticConnectorLabelMaximumCharacters(availableWidth: number): number {
  return Math.max(
    1,
    Math.floor(
      (availableWidth - SEMANTIC_CONNECTOR_LABEL_TOTAL_INSET) /
      SEMANTIC_CONNECTOR_LABEL_GRAPHEME_WIDTH,
    ),
  );
}

/**
 * Wrap text exactly as Jazzboard's first-party SVG renderers do, while also
 * retaining the unbounded line count needed to report likely truncation.
 */
export function layoutSemanticText(
  value: string,
  maxCharacters: number,
  maxLines: number,
): SemanticTextLayout {
  const safeMaximumCharacters = Math.max(1, Math.floor(maxCharacters));
  const safeMaximumLines = Math.max(1, Math.floor(maxLines));
  const paragraphs = value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const allLines: string[] = [];

  for (const paragraph of paragraphs) {
    let current = "";
    for (const sourceWord of paragraph.split(" ")) {
      const graphemes = Array.from(sourceWord);
      const words = Array.from(
        { length: Math.ceil(graphemes.length / safeMaximumCharacters) },
        (_, index) => graphemes
          .slice(
            index * safeMaximumCharacters,
            (index + 1) * safeMaximumCharacters,
          )
          .join(""),
      );
      for (const word of words) {
        if (!current) current = word;
        else if (Array.from(`${current} ${word}`).length <= safeMaximumCharacters) {
          current = `${current} ${word}`;
        } else {
          allLines.push(current);
          current = word;
        }
      }
    }
    if (current) allLines.push(current);
  }

  const requiredLineCount = allLines.length;
  const truncated = requiredLineCount > safeMaximumLines;
  const lines = allLines.slice(0, safeMaximumLines);
  if (truncated && lines.length) {
    const last = lines.length - 1;
    lines[last] = `${Array.from(lines[last])
      .slice(0, Math.max(1, safeMaximumCharacters - 1))
      .join("")}…`;
  }

  return { lines, requiredLineCount, truncated };
}
