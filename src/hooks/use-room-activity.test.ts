import { describe, expect, it } from "vitest";

import type { RoomActivitySummary } from "@/lib/domain/types";

import { revertBodyFor } from "./use-room-activity";

describe("revertBodyFor", () => {
  it("turns private-summary guards into exact compensating expectations", () => {
    const activity = {
      id: "activity_1",
      label: "Created a flow",
      objectGuards: {
        shape_created: { state: "present", revision: 2 },
        shape_removed: { state: "absent" },
      },
      diagramGuards: {
        diagram_flow: { state: "present", revision: 3 },
      },
    } as unknown as RoomActivitySummary;

    expect(revertBodyFor(activity)).toEqual({
      objectExpectations: [
        { objectId: "shape_created", state: "present", expectedRevision: 2 },
        { objectId: "shape_removed", state: "absent" },
      ],
      diagramExpectations: [
        { diagramId: "diagram_flow", state: "present", expectedRevision: 3 },
      ],
      metadata: {
        intent: "Revert activity activity_1",
        summary: "Compensating revert for: Created a flow",
      },
    });
  });
});
