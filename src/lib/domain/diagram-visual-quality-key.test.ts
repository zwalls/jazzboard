import { describe, expect, it } from "vitest";

import type { DiagramVisualQualityFinding } from "./diagram-visual-quality";
import { diagramVisualQualityFindingKey } from "./diagram-visual-quality-key";

function finding(overrides: Partial<DiagramVisualQualityFinding> = {}): DiagramVisualQualityFinding {
  return {
    code: "CONNECTOR_ENDPOINT_REENTRY",
    status: "fail",
    summary: "Move the route out of its endpoint.",
    objectIds: ["node_b"],
    connectorIds: ["connector_a"],
    bounds: { x: 10, y: 20, width: 30, height: 40 },
    details: { endpoint: "start", actualGap: 3 },
    ...overrides,
  };
}

describe("diagram visual quality finding keys", () => {
  it("is stable across geometry measurements while distinguishing semantic conflicts", () => {
    const original = diagramVisualQualityFindingKey(finding());
    const moved = diagramVisualQualityFindingKey(finding({
      bounds: { x: 400, y: 500, width: 10, height: 20 },
      details: { endpoint: "start", actualGap: 99 },
    }));
    const otherEndpoint = diagramVisualQualityFindingKey(finding({
      details: { endpoint: "end", actualGap: 3 },
    }));

    expect(original).toMatch(/^diagram:connector_endpoint_reentry:[a-f0-9]{8}$/);
    expect(moved).toBe(original);
    expect(otherEndpoint).not.toBe(original);
  });
});
