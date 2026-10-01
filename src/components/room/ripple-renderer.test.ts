import { describe, expect, it } from "vitest";

import { renderAvatarBody, renderRippleBody } from "./ripple-renderer";

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

  it("renders each selected family with family-specific face placement", () => {
    const puddle = renderAvatarBody("Sol", 64);
    const loop = renderAvatarBody("Astra", 64);
    const mochi = renderAvatarBody("Mira", 64);
    const ripple = renderAvatarBody("Kai", 64);

    expect([puddle.family, loop.family, mochi.family, ripple.family]).toEqual([
      "puddle",
      "loop",
      "mochi",
      "ripple",
    ]);
    expect(loop.eyeGeometry.centersX[1]).toBeLessThan(0);
    expect(puddle.data).not.toEqual(mochi.data);
  });
});
