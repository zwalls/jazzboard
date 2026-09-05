import { describe, expect, it } from "vitest";

import { reconcileGuidedWalkthrough, type GuidedWalkthrough } from "./guided-walkthrough";

const walkthrough: GuidedWalkthrough = {
  id: "walkthrough-1",
  roomId: "room-1",
  revision: 2,
  title: "Cache miss",
  startedAt: 1,
  currentStepIndex: 1,
  steps: [
    { caption: "Client", objectIds: ["client"], connectorIds: [] },
    { caption: "Missing edge", objectIds: [], connectorIds: ["request"] },
    { caption: "Cache", objectIds: ["cache"], connectorIds: [] },
  ],
};

describe("guided walkthrough reconciliation", () => {
  it("removes deleted targets and empty steps while retaining a bounded active step", () => {
    const reconciled = reconcileGuidedWalkthrough(walkthrough, {
      objects: {
        client: { kind: "shape" },
        cache: { kind: "shape" },
      },
    } as never);
    expect(reconciled).toMatchObject({
      currentStepIndex: 1,
      steps: [{ caption: "Client" }, { caption: "Cache" }],
    });
  });

  it("ends the local presentation when every target disappeared", () => {
    expect(reconcileGuidedWalkthrough(walkthrough, { objects: {} })).toBeNull();
  });
});
