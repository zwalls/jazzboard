import { describe, expect, it } from "vitest";

import {
  layoutSemanticText,
  SEMANTIC_CONNECTOR_LABEL_MAX_LINES,
  SEMANTIC_TEXT_MAX_LINES,
  semanticConnectorLabelMaximumCharacters,
  semanticTextMinimumHeightForLines,
  semanticTextMinimumWidthForLines,
  semanticTextMaximumCharacters,
  semanticTextMaximumLines,
} from "./semantic-text-layout";

describe("semantic text layout", () => {
  it("uses the live and PNG text-object six-line limit with truthful omitted-line metadata", () => {
    const maximumCharacters = semanticTextMaximumCharacters(80, 24);
    const maximumLines = semanticTextMaximumLines(320, 24);
    const result = layoutSemanticText(
      Array.from({ length: 7 }, (_, index) => `line${index + 1}`).join("\n"),
      maximumCharacters,
      maximumLines,
    );

    expect(maximumCharacters).toBe(8);
    expect(maximumLines).toBe(SEMANTIC_TEXT_MAX_LINES);
    expect(result).toMatchObject({
      requiredLineCount: 7,
      truncated: true,
    });
    expect(result.lines).toHaveLength(6);
    expect(result.lines.at(-1)).toBe("line6…");
  });

  it("limits text lines to the baselines that fit the authoritative object height", () => {
    const maximumLines = semanticTextMaximumLines(96, 24);
    const result = layoutSemanticText("one\ntwo\nthree\nfour", 20, maximumLines);

    expect(maximumLines).toBe(3);
    expect(result).toMatchObject({
      lines: ["one", "two", "three…"],
      requiredLineCount: 4,
      truncated: true,
    });
    expect(semanticTextMaximumLines(10_000, 24)).toBe(SEMANTIC_TEXT_MAX_LINES);
  });

  it("uses the live and PNG connector-label twenty-line limit", () => {
    const maximumCharacters = semanticConnectorLabelMaximumCharacters(20);
    const result = layoutSemanticText(
      Array.from({ length: 21 }, (_, index) => String.fromCharCode(97 + index)).join("\n"),
      maximumCharacters,
      SEMANTIC_CONNECTOR_LABEL_MAX_LINES,
    );

    expect(maximumCharacters).toBe(1);
    expect(result).toMatchObject({
      requiredLineCount: 21,
      truncated: true,
    });
    expect(result.lines).toHaveLength(20);
    expect(result.lines.at(-1)).toBe("t…");
  });

  it("normalizes whitespace, counts graphemes, and does not report exact-fit text as truncated", () => {
    expect(layoutSemanticText("  alpha   beta\r\ngamma  ", 10, 3)).toEqual({
      lines: ["alpha beta", "gamma"],
      requiredLineCount: 2,
      truncated: false,
    });
    expect(layoutSemanticText("😀😀😀", 2, 2)).toEqual({
      lines: ["😀😀", "😀"],
      requiredLineCount: 2,
      truncated: false,
    });
  });

  it("returns exact non-mutating correction bounds for a truncated heading", () => {
    const value = "TELEMETRY PLATFORM";
    const fontSize = 36;
    const maximumLines = semanticTextMaximumLines(36, fontSize);
    const currentLayout = layoutSemanticText(
      value,
      semanticTextMaximumCharacters(360, fontSize),
      maximumLines,
    );

    expect(currentLayout).toMatchObject({ requiredLineCount: 2, truncated: true });
    expect(semanticTextMinimumWidthForLines(value, fontSize, maximumLines)).toBe(376);
    expect(semanticTextMinimumHeightForLines(currentLayout.requiredLineCount, fontSize)).toBe(85);
    expect(semanticTextMinimumHeightForLines(7, fontSize)).toBeNull();
  });
});
