import { describe, expect, it } from "vitest";

import { renderRippleBody } from "./ripple-renderer";

describe("renderRippleBody", () => {
  it("is deterministic for a name and varies the generated family by name", () => {
    const first = renderRippleBody("Mira", 64);
    const repeat = renderRippleBody("Mira", 64);
    const other = renderRippleBody("Orbit Architect", 64);

    expect(first.eyeGeometry).toEqual(repeat.eyeGeometry);
    expect(first.data).toEqual(repeat.data);
    expect(other.data).not.toEqual(first.data);
  });

  it("bounds raster dimensions and returns independently animatable eye geometry", () => {
    const rendered = renderRippleBody("Mira", 1_000);

    expect(rendered.width).toBe(192);
    expect(rendered.height).toBe(192);
    expect(rendered.data.byteLength).toBe(192 * 192 * 4);
    expect(rendered.eyeGeometry.centersX[0]).toBeLessThan(0);
    expect(rendered.eyeGeometry.centersX[1]).toBeGreaterThan(0);
    expect(rendered.eyeGeometry.maxLookOffset).toBeGreaterThan(0);
  });
});
