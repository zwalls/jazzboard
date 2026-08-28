import { describe, expect, it } from "vitest";

import {
  SEMANTIC_CANVAS_BACKGROUND,
  SEMANTIC_COLOR_PALETTE,
  SEMANTIC_CONNECTOR_ARROW_SIZE,
  SEMANTIC_CONNECTOR_LABEL_FONT_SIZE,
  SEMANTIC_CONNECTOR_LABEL_LINE_HEIGHT,
  SEMANTIC_CONNECTOR_STROKE_WIDTH,
  SEMANTIC_DRAW_FONT_FAMILY,
  SEMANTIC_DRAW_FONT_NAME,
  SEMANTIC_DRAW_FONT_URL,
  SEMANTIC_DRAW_STROKE_WIDTHS,
  SEMANTIC_SELECTION_COLOR,
  SEMANTIC_SELECTION_FILL,
  SEMANTIC_SELECTION_STROKE_WIDTH,
  SEMANTIC_SHAPE_CORNER_RADIUS,
  SEMANTIC_SHAPE_LABEL_FONT_SIZE,
  SEMANTIC_SHAPE_LABEL_LINE_HEIGHT,
  SEMANTIC_SHAPE_LABEL_PADDING,
  SEMANTIC_SHAPE_STROKE_WIDTH,
  SEMANTIC_TEXT_FONT_SIZES,
  SEMANTIC_TEXT_LINE_HEIGHT,
  semanticFillColor,
  semanticPaletteColor,
  semanticShapeLabelMaxCharacters,
  semanticShapeLabelMaxLines,
  semanticStrokeColor,
} from "./semantic-visual-style";

describe("semantic canvas visual contract", () => {
  it("locks the tldraw-derived light palette as saturated ink and pastel fill pairs", () => {
    expect(SEMANTIC_COLOR_PALETTE).toEqual({
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
    });
    expect(semanticPaletteColor(" BLUE ", "solid")).toBe("#4465e9");
    expect(semanticPaletteColor("blue", "semi")).toBe("#dce1f8");
    expect(semanticPaletteColor("not-a-token", "solid")).toBeNull();
  });

  it("resolves named ink and fills independently while preserving bounded custom hex", () => {
    expect(semanticStrokeColor("light-blue")).toBe("#4ba1f1");
    expect(semanticFillColor("light-blue")).toBe("#ddedfa");
    expect(semanticStrokeColor(" #AbC ")).toBe("#abc");
    expect(semanticFillColor("#ABCDEF80")).toBe("#abcdef80");
    expect(semanticFillColor("none")).toBe("none");
    expect(semanticFillColor("none", "violet", false)).toBe("#ecdcf2");
    expect(semanticStrokeColor("unsafe-value", "green")).toBe("#099268");
    expect(semanticFillColor("unsafe-value", "orange")).toBe("#f8e2d4");
    expect(semanticStrokeColor("unsafe-value", "#123456")).toBe("#123456");
    expect(semanticFillColor("unsafe-value", "#abcdef")).toBe("#abcdef");
  });

  it("locks the draw font, typography, line weights, and selection metrics", () => {
    expect(SEMANTIC_DRAW_FONT_NAME).toBe("Shantell Sans");
    expect(SEMANTIC_DRAW_FONT_FAMILY).toBe(
      "Shantell Sans,Comic Sans MS,Comic Sans,cursive",
    );
    expect(SEMANTIC_DRAW_FONT_URL).toBe(
      "/fonts/shantell-sans-latin-400-normal.woff2",
    );
    expect(SEMANTIC_TEXT_FONT_SIZES).toEqual({ s: 18, m: 24, l: 36, xl: 44 });
    expect(SEMANTIC_TEXT_LINE_HEIGHT).toBe(1.35);
    expect(SEMANTIC_SHAPE_LABEL_FONT_SIZE).toBe(22);
    expect(SEMANTIC_SHAPE_LABEL_LINE_HEIGHT).toBeCloseTo(29.7);
    expect(SEMANTIC_SHAPE_LABEL_PADDING).toBe(16);
    expect(SEMANTIC_CONNECTOR_LABEL_FONT_SIZE).toBe(20);
    expect(SEMANTIC_CONNECTOR_LABEL_LINE_HEIGHT).toBe(27);
    expect(SEMANTIC_SHAPE_STROKE_WIDTH).toBe(3.5);
    expect(SEMANTIC_CONNECTOR_STROKE_WIDTH).toBe(3.5);
    expect(SEMANTIC_DRAW_STROKE_WIDTHS).toEqual({ s: 3, m: 4.5, l: 6 });
    expect(SEMANTIC_CONNECTOR_ARROW_SIZE).toBe(12);
    expect(SEMANTIC_SHAPE_CORNER_RADIUS).toBe(7);
    expect(SEMANTIC_CANVAS_BACKGROUND).toBe("#f9fafb");
    expect(SEMANTIC_SELECTION_COLOR).toBe("#3182ed");
    expect(SEMANTIC_SELECTION_FILL).toBe("rgba(45, 147, 255, 0.24)");
    expect(SEMANTIC_SELECTION_STROKE_WIDTH).toBe(1.5);
  });

  it("bounds shape labels using the same type metrics as both renderers", () => {
    expect(semanticShapeLabelMaxCharacters(280)).toBe(19);
    expect(semanticShapeLabelMaxCharacters(40)).toBe(8);
    expect(semanticShapeLabelMaxLines(152)).toBe(4);
    expect(semanticShapeLabelMaxLines(30)).toBe(1);
    expect(semanticShapeLabelMaxLines(1_000)).toBe(5);
  });
});
