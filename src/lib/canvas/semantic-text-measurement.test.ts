import { afterEach, describe, expect, it, vi } from "vitest";
import { fitSemanticText, measureSemanticText, type SemanticTextMeasurer } from "./semantic-text-measurement";
import { renderSemanticSceneSvg } from "./semantic-png-svg";
import { buildSemanticScene } from "./semantic-scene";
import type { TextObject } from "@/lib/domain/types";

const measure: SemanticTextMeasurer = (text, size) => ({
  width: Array.from(text).reduce((sum, glyph) => sum + size * (glyph === "W" ? 1.4 : glyph === "i" ? 0.2 : 0.6), 0),
  actualBoundingBoxLeft: 0,
  actualBoundingBoxRight: Array.from(text).reduce((sum, glyph) => sum + size * (glyph === "W" ? 1.4 : glyph === "i" ? 0.2 : 0.6), 0),
  actualBoundingBoxAscent: size * 0.8,
  actualBoundingBoxDescent: size * 0.22,
});

describe("renderer-consistent measured text bounds", () => {
  it("measures ink rather than treating wide and narrow glyphs as equal", () => {
    const wide = measureSemanticText("WWWW", 300, 96, "m", "start", measure);
    const narrow = measureSemanticText("iiii", 300, 96, "m", "start", measure);
    expect(wide.inkBounds.width).toBeCloseTo(134.4);
    expect(narrow.inkBounds.width).toBeCloseTo(19.2);
    expect(wide.inkBounds.width).toBeGreaterThan(narrow.inkBounds.width * 6);
  });

  it.each(["start", "middle", "end"] as const)("fits wide glyphs and baselines with %s alignment", (align) => {
    const content = "WWWWWWWW\nsecond line\nthird line";
    const fitted = fitSemanticText(content, 100, "l", align, measure);
    const result = measureSemanticText(content, fitted.width, fitted.height, "l", align, measure);
    expect(fitted.width).toBeGreaterThanOrEqual(100);
    expect(result.requiredLineCount).toBeLessThanOrEqual(6);
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.inkBounds.y).toBeGreaterThanOrEqual(0);
    expect(result.inkBounds.y + result.inkBounds.height).toBeLessThanOrEqual(fitted.height);
  });

  it("reports clipping and truncation for explicit undersized bounds without altering content", () => {
    const content = "Heading one\nHeading two\nHeading three";
    const result = measureSemanticText(content, 100, 12, "xl", "start", measure);
    expect(result.warnings).toContain("text_truncated");
    expect(result.warnings).toContain("text_ink_overflow");
    expect(result.inkBounds.y).toBeLessThan(0);
    expect(content).toBe("Heading one\nHeading two\nHeading three");
  });

  it("rejects unrepresentable content and dimension overflow instead of silently ellipsizing fitted text", () => {
    expect(() => fitSemanticText("1\n2\n3\n4\n5\n6\n7", 300, "m", "start", measure)).toThrow(/six-line/);
    expect(() => fitSemanticText("x", 100_000, "m", "start", () => ({ ...measure("x", 24), width: 200_000, actualBoundingBoxRight: 200_000 }))).toThrow(/dimension/);
  });

  it("requires inspection for ink that cannot fit the established SVG origin", () => {
    expect(() => fitSemanticText("x", 320, "m", "start", () => ({ ...measure("x", 24), actualBoundingBoxLeft: 4 }))).toThrow(/ink overhang/);
  });

  it("uses the same wrapped strings as PNG SVG without changing the stored content", () => {
    const content = "Heading one\nHeading two";
    const fitted = fitSemanticText(content, 200, "l", "start", measure);
    const measured = measureSemanticText(content, fitted.width, fitted.height, "l", "start", measure);
    const actor = { participantId: "test", kind: "agent" as const, displayName: "Test", color: "blue" };
    const text: TextObject = { createdAt: 1, updatedAt: 1, createdBy: actor, lastEditedBy: actor, id: "text_test", kind: "text", content, size: "l", align: "start", color: "black", x: 0, y: 0,
      ...fitted, rotation: 0, zIndex: 0, revision: 1, groupId: null, diagramIds: [] };
    const scene = buildSemanticScene({ id: "test", roomRevision: 1, objects: { text_test: text }, diagrams: {} });
    const svg = renderSemanticSceneSvg(scene, ["text_test"]).svg;
    for (const line of measured.lines) expect(svg).toContain(`>${line}</tspan>`);
    expect(svg).not.toContain("…");
    expect(text.content).toBe(content);
  });
});

describe("loaded-font browser measurement boundary", () => {
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
    else Reflect.deleteProperty(document, "fonts");
  });

  it("shares font loading while cancelling one reader without cancelling another", async () => {
    vi.resetModules();
    const { semanticTextMeasurer } = await import("./semantic-text-measurement");
    let finish!: (value: FontFace[]) => void;
    const fonts = { load: vi.fn(() => new Promise<FontFace[]>((resolve) => { finish = resolve; })), check: vi.fn(() => true) };
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    const context = { measureText: vi.fn((text: string) => measure(text, 24)) };
    vi.spyOn(document, "createElement").mockReturnValueOnce({ getContext: () => context } as unknown as HTMLCanvasElement);
    const cancelled = new AbortController();
    const first = semanticTextMeasurer(cancelled.signal);
    const second = semanticTextMeasurer(new AbortController().signal);
    cancelled.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    finish([{} as FontFace]);
    const measured = await second;
    expect(measured("hello", 24).width).toBeGreaterThan(0);
    expect(fonts.load).toHaveBeenCalledTimes(1);
    expect(context).toMatchObject({ textAlign: "left", textBaseline: "alphabetic", font: expect.stringContaining("Shantell Sans") });
  });

  it("fails closed when the declared font is unavailable and allows a later retry", async () => {
    vi.resetModules();
    const { semanticTextMeasurer } = await import("./semantic-text-measurement");
    const load = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{} as FontFace]);
    Object.defineProperty(document, "fonts", { configurable: true, value: { load, check: () => true } });
    await expect(semanticTextMeasurer(new AbortController().signal)).rejects.toMatchObject({ code: "TEXT_MEASUREMENT_UNAVAILABLE" });
    vi.spyOn(document, "createElement").mockReturnValueOnce({ getContext: () => ({ measureText: () => measure("x", 24) }) } as unknown as HTMLCanvasElement);
    const measured = await semanticTextMeasurer(new AbortController().signal);
    expect(measured("x", 24).width).toBeGreaterThan(0);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
