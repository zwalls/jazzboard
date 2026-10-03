import { describe, expect, it } from "vitest";

import { equalDocumentValue, shareDocumentRecords } from "./document-sharing";

describe("immutable document sharing", () => {
  it("compares all nested values independently of record insertion order", () => {
    const current = {
      a: { id: "a", points: [{ x: 1, y: 2 }], routing: { bend: 0, mode: "auto" } },
      b: { id: "b", points: [], routing: { bend: 1, mode: "elbow" } },
    };
    const next = {
      b: { routing: { mode: "elbow", bend: 1 }, points: [], id: "b" },
      a: { routing: { mode: "auto", bend: 0 }, points: [{ y: 2, x: 1 }], id: "a" },
    };
    expect(shareDocumentRecords(current, next)).toBe(current);
    expect(next.a).not.toBe(current.a);
    const changed = structuredClone(next);
    changed.a.points[0].x = 3;
    const shared = shareDocumentRecords(current, changed);
    expect(shared.a).toBe(changed.a);
    expect(shared.b).toBe(current.b);
    expect(current.a.points[0].x).toBe(1);
    expect(changed.b).not.toBe(current.b);
    expect(shareDocumentRecords(current, { a: next.a })).toEqual({ a: current.a });
    expect(shareDocumentRecords(current, { a: next.a })).not.toBe(current);
  });

  it("retains distinctions in missing fields, nulls, array order, and nested geometry", () => {
    expect(equalDocumentValue({ owner: null }, {})).toBe(false);
    expect(equalDocumentValue({ owner: undefined }, {})).toBe(false);
    expect(equalDocumentValue({ members: ["a", "b"] }, { members: ["b", "a"] })).toBe(false);
    expect(equalDocumentValue({ anchor: { x: 0.5 } }, { anchor: { x: 0.6 } })).toBe(false);
    expect(equalDocumentValue({ values: [] }, { values: {} })).toBe(false);
    expect(equalDocumentValue({ createdAt: 1 }, { createdAt: 2 })).toBe(false);
  });
});
