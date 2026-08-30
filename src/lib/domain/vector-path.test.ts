import { describe, expect, it } from "vitest";

import type { PathObject } from "./types";
import {
  flattenVectorPath,
  normalizeWorldVectorPath,
  polygonWorldVectorPath,
  vectorPathBounds,
  vectorPathPointCount,
  vectorPathSvgData,
} from "./vector-path";

const actor = { participantId: "p", displayName: "Agent", color: "blue", kind: "agent" as const };

function path(input: Partial<PathObject> = {}): PathObject {
  return {
    id: "path",
    kind: "path",
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    rotation: 0,
    zIndex: 0,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
    start: { x: 0, y: 0.5 },
    segments: [{ kind: "cubic", control1: { x: 0.2, y: 0 }, control2: { x: 0.8, y: 1 }, to: { x: 1, y: 0.5 } }],
    closed: false,
    fill: "none",
    stroke: "black",
    strokeWidth: 4,
    opacity: 1,
    lineCap: "round",
    lineJoin: "round",
    fillRule: "nonzero",
    ...input,
  };
}

describe("vector path geometry", () => {
  it("normalizes world Bezier controls and polygons without raw path strings", () => {
    expect(normalizeWorldVectorPath(
      { x: 100, y: 200 },
      [{ kind: "quadratic", control: { x: 150, y: 100 }, to: { x: 200, y: 200 } }],
    )).toEqual({
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      start: { x: 0, y: 1 },
      segments: [{ kind: "quadratic", control: { x: 0.5, y: 0 }, to: { x: 1, y: 1 } }],
    });
    expect(polygonWorldVectorPath([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 10 }]).segments).toHaveLength(2);
  });

  it("builds safe SVG data, deterministic traces and conservative stroked bounds", () => {
    const object = path();
    expect(vectorPathSvgData(object, String)).toBe("M 10 60 C 30 20 90 100 110 60");
    expect(flattenVectorPath(object)).toHaveLength(17);
    expect(vectorPathBounds(object)).toEqual({ x: 8, y: 18, width: 104, height: 84 });
    expect(vectorPathPointCount(object)).toBe(4);
  });
});
