import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RoomActivitySummary } from "@/lib/domain/types";

import { ActivityTimeline, formatActivityTime } from "./ActivityTimeline";

const activity: RoomActivitySummary = {
  id: "activity_1",
  roomId: "room_1",
  roomRevision: 8,
  occurredAt: 1_000,
  actor: {
    participantId: "participant_1",
    displayName: "Ari",
    color: "#4F6BED",
    kind: "agent",
  },
  action: "canvas.transaction",
  label: "Created 4 objects",
  intent: "Sketch the auth flow",
  summary: "Added the client, API, Redis, and their connectors.",
  affectedObjectIds: ["shape_a", "shape_b", "connector_a"],
  affectedDiagramIds: ["diagram_auth"],
  affectedBounds: { x: 0, y: 0, width: 400, height: 200 },
  objectGuards: {
    shape_a: { state: "present", revision: 1 },
  },
  diagramGuards: {
    diagram_auth: { state: "present", revision: 1 },
  },
  revertsActivityId: null,
};

describe("ActivityTimeline", () => {
  it("renders attributable agent work and safe review actions", () => {
    render(
      <ActivityTimeline
        activities={[activity]}
        actorFilter="all"
        canRevert
        loading={false}
        revertingActivityId={null}
        error={null}
        now={61_000}
        onActorFilterChange={vi.fn()}
        onClose={vi.fn()}
        onFocus={vi.fn()}
        onRefresh={vi.fn()}
        onRevert={vi.fn()}
      />,
    );

    expect(screen.getByText("Ari")).toBeInTheDocument();
    expect(screen.getByText("agent · 1m ago")).toBeInTheDocument();
    expect(screen.getByText(activity.summary!)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show affected" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Revert safely" })).toBeEnabled();
  });

  it("hides human work when filtering for agents", () => {
    render(
      <ActivityTimeline
        activities={[{ ...activity, actor: { ...activity.actor, kind: "human" } }]}
        actorFilter="agent"
        canRevert
        loading={false}
        revertingActivityId={null}
        error={null}
        onActorFilterChange={vi.fn()}
        onClose={vi.fn()}
        onFocus={vi.fn()}
        onRefresh={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    expect(screen.getByText("No matching edits yet")).toBeInTheDocument();
  });
});

describe("formatActivityTime", () => {
  it("uses compact relative time labels", () => {
    expect(formatActivityTime(55_000, 60_000)).toBe("just now");
    expect(formatActivityTime(30_000, 60_000)).toBe("30s ago");
    expect(formatActivityTime(0, 3_600_000)).toBe("1h ago");
  });
});
