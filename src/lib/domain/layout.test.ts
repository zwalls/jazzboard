import { describe, expect, it } from "vitest";

import {
  connectorLabelBounds,
  connectorLabelMetrics,
  connectorLabelPrimaryClearance,
  minimumLayoutGaps,
} from "./layout";

describe("shared deterministic layout metrics", () => {
  it("uses shared comfortable and compact minima without letting caller values shrink them", () => {
    expect(minimumLayoutGaps({ density: "comfortable", primaryGap: 20 })).toMatchObject({
      primaryGap: 160,
      secondaryGap: 100,
    });
    expect(minimumLayoutGaps({ density: "compact", primaryGap: 120 })).toMatchObject({
      primaryGap: 120,
      secondaryGap: 48,
    });
  });

  it("normalizes connector labels and conservatively clears a 20px canvas label", () => {
    const metrics = connectorLabelMetrics("  authorize   signed cookie  ");
    expect(metrics.normalizedLines).toEqual(["authorize signed cookie"]);
    expect(metrics.width).toBe(262);
    expect(connectorLabelPrimaryClearance("authorize signed cookie", "right", "comfortable")).toBe(310);
    expect(connectorLabelPrimaryClearance("authorize signed cookie", "right", "compact")).toBe(286);
  });

  it("returns the shared centered page-space box used by Diagram and export bounds", () => {
    const bounds = connectorLabelBounds(
      "authorize signed cookie",
      { x: 200, y: 100 },
      { x: 510, y: 100 },
    );
    expect(bounds).toEqual({ x: 224, y: 82, width: 262, height: 36 });
    expect(connectorLabelBounds("   ", { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });
});
