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
  it("locks Jazzboard's light palette as saturated ink and pastel fill pairs", () => {
    expect(SEMANTIC_COLOR_PALETTE).toEqual({
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
    });
    expect(semanticPaletteColor(" BLUE ", "solid")).toBe("#5266df");
    expect(semanticPaletteColor("blue", "semi")).toBe("#dfe3f7");
    expect(semanticPaletteColor("not-a-token", "solid")).toBeNull();
  });

  it("resolves named ink and fills independently while preserving bounded custom hex", () => {
    expect(semanticStrokeColor("light-blue")).toBe("#4f98dc");
    expect(semanticFillColor("light-blue")).toBe("#deedf8");
    expect(semanticStrokeColor(" #AbC ")).toBe("#abc");
    expect(semanticFillColor("#ABCDEF80")).toBe("#abcdef80");
    expect(semanticFillColor("none")).toBe("none");
    expect(semanticFillColor("none", "violet", false)).toBe("#e9dff3");
    expect(semanticStrokeColor("unsafe-value", "green")).toBe("#158b68");
    expect(semanticFillColor("unsafe-value", "orange")).toBe("#f6e3d9");
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
    expect(SEMANTIC_CANVAS_BACKGROUND).toBe("#ffffff");
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
