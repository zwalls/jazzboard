import { describe, expect, it } from "vitest";

import { boundedRasterSize, safeDownloadStem, svgDownloadDimensions } from "./download";

describe("safeDownloadStem", () => {
  it("creates a stable, filesystem-safe export stem", () => {
    expect(safeDownloadStem("  Authentication Request Flow  ")).toBe("authentication-request-flow");
    expect(safeDownloadStem("Caf\u00e9 / API: v2")).toBe("cafe-api-v2");
  });

  it("uses a fallback and bounds long names", () => {
    expect(safeDownloadStem("***", "board")).toBe("board");
    expect(safeDownloadStem("A".repeat(200))).toHaveLength(80);
  });
});

describe("SVG-to-PNG bounds", () => {
  it("reads deterministic viewBox dimensions", () => {
    expect(svgDownloadDimensions('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -20 640 360" />')).toEqual({
      width: 640,
      height: 360,
    });
  });

  it("rejects dimensionless or malformed SVG", () => {
    expect(() => svgDownloadDimensions("<svg><broken></svg>")).toThrow("valid image");
    expect(() => svgDownloadDimensions('<svg xmlns="http://www.w3.org/2000/svg" />')).toThrow("dimensions");
  });

  it("bounds large raster exports by side and total pixels", () => {
    const result = boundedRasterSize(20_000, 10_000, 4);
    expect(result.width).toBeLessThanOrEqual(4_096);
    expect(result.height).toBeLessThanOrEqual(4_096);
    expect(result.width * result.height).toBeLessThanOrEqual(16_000_000);
    expect(result.scale).toBeLessThan(1);
  });
});
