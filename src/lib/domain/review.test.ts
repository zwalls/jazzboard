import { describe, expect, it } from "vitest";

import { normalizeRoomSemanticState } from "./engine";
import {
  agentEditProposalPurpose,
  agentEditProposalSummary,
  buildAgentEditProposal,
  buildRoomActivity,
  roomActivitySummary,
} from "./review";
import type { ActorRef, CanvasObject, Diagram, RoomState, SemanticTransaction } from "./types";

const NOW = 1_000;
const actor: ActorRef = {
  participantId: "participant-1",
  displayName: "Avery",
  color: "blue",
  kind: "agent",
};

function object(id: string, revision: number, x: number): CanvasObject {
  return {
    id,
    kind: "text",
    x,
    y: 20,
    width: 100,
    height: 60,
    rotation: 0,
    zIndex: 1,
    revision,
    groupId: null,
    diagramIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor,
    lastEditedBy: actor,
    content: id,
    color: "black",
    size: "m",
    align: "start",
  };
}

function diagram(memberObjectIds: string[], revision: number): Diagram {
  return {
    id: "diagram-1",
    title: "Flow",
    description: "Review flow",
    diagramType: "flow",
    category: null,
    tags: ["review"],
    memberObjectIds,
    connectorIds: [],
    bounds: { x: 10, y: 20, width: 220, height: 60 },
    revision,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function room(objects: CanvasObject[], diagrams: Diagram[], roomRevision: number): RoomState {
  return {
    id: "room-1",
    code: "1234",
    title: "Review room",
    roomRevision,
    createdAt: NOW,
    updatedAt: NOW + roomRevision,
    participants: {},
    objects: Object.fromEntries(objects.map((item) => [item.id, item])),
    diagrams: Object.fromEntries(diagrams.map((item) => [item.id, item])),
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

describe("reviewable room activities", () => {
  it("captures immutable full snapshots, exact guards, metadata, and affected bounds", () => {
    const beforeObject = object("existing", 1, 10);
    const createdObject = object("created", 1, 130);
    const before = room([beforeObject], [], 2);
    const after = room([{ ...beforeObject, x: 30, revision: 2 }, createdObject], [], 3);

    const activity = buildRoomActivity({
      before,
      after,
      actor,
      action: "canvas.transaction",
      label: "Applied 2 semantic operations",
      changedObjectIds: ["created", "existing"],
      changedDiagramIds: [],
      metadata: { intent: "Clarify ownership", summary: "Moved one note and added another" },
      id: "activity-1",
      occurredAt: NOW + 10,
    });

    after.objects.existing.x = 999;
    expect(activity).toMatchObject({
      id: "activity-1",
      roomRevision: 3,
      intent: "Clarify ownership",
      summary: "Moved one note and added another",
      affectedObjectIds: ["created", "existing"],
      affectedBounds: { x: 10, y: 20, width: 220, height: 60 },
      objectGuards: {
        created: { state: "present", revision: 1 },
        existing: { state: "present", revision: 2 },
      },
    });
    expect(activity.objectChanges.find((change) => change.objectId === "existing")?.after?.x).toBe(30);
    expect(activity.objectChanges.every((change) => change.mode === "direct")).toBe(true);
  });

  it("marks reverse-index-only objects as derived and keeps private snapshots out of summaries", () => {
    const memberBefore = object("member", 4, 10);
    const memberAfter = { ...memberBefore, diagramIds: ["diagram-1"] };
    const before = room([memberBefore], [], 7);
    const after = room([memberAfter], [diagram(["member"], 1)], 8);
    const activity = buildRoomActivity({
      before,
      after,
      actor,
      action: "canvas.transaction",
      label: "Created a Diagram",
      changedObjectIds: [],
      membershipObjectIds: ["member"],
      changedDiagramIds: ["diagram-1"],
      id: "activity-2",
    });

    expect(activity.objectChanges).toEqual([
      expect.objectContaining({ objectId: "member", mode: "derived_membership" }),
    ]);
    expect(activity.objectGuards.member).toEqual({ state: "present", revision: 4 });
    const summary = roomActivitySummary(activity);
    expect(summary).not.toHaveProperty("objectChanges");
    expect(summary).not.toHaveProperty("diagramChanges");
    expect(summary.affectedDiagramIds).toEqual(["diagram-1"]);
  });

  it("records absence as the exact post-state guard for deleted entities", () => {
    const before = room([object("deleted", 3, 10)], [diagram(["deleted"], 2)], 4);
    const after = room([], [], 5);
    const activity = buildRoomActivity({
      before,
      after,
      actor,
      action: "canvas.delete",
      label: "Deleted 1 object",
      changedObjectIds: ["deleted"],
      changedDiagramIds: ["diagram-1"],
      id: "activity-3",
    });

    expect(activity.objectGuards.deleted).toEqual({ state: "absent" });
    expect(activity.diagramGuards["diagram-1"]).toEqual({ state: "absent" });
    expect(activity.objectChanges[0].before?.revision).toBe(3);
    expect(activity.objectChanges[0].after).toBeNull();
  });
});

describe("agent edit review domain records", () => {
  it("migrates pre-policy rooms to live editing with an authoritative empty queue", () => {
    const legacy = room([], [], 4) as Partial<RoomState>;
    delete legacy.agentEditPolicy;
    delete legacy.reviewProposals;

    const normalized = normalizeRoomSemanticState(legacy as RoomState);

    expect(normalized.agentEditPolicy).toBe("live");
    expect(normalized.reviewProposals).toEqual([]);
  });

  it("retains an immutable exact semantic request, baseline, attribution, and concise purpose", () => {
    const transaction: SemanticTransaction = {
      commands: [
        {
          type: "create",
          object: {
            id: "api",
            kind: "shape",
            x: 10,
            y: 20,
            width: 180,
            height: 90,
            rotation: 0,
            zIndex: 1,
            groupId: null,
            shape: "rectangle",
            nodeType: "service",
            label: "Room API",
            fill: "blue",
            stroke: "blue",
          },
        },
      ],
      diagramCommands: [
        {
          type: "diagram.create",
          diagram: {
            id: "system",
            title: "Room system",
            description: "Shows the room API boundary",
            diagramType: "architecture",
            category: "system",
            tags: ["rooms"],
            memberObjectIds: ["api", "existing"],
            connectorIds: [],
          },
        },
      ],
    };
    const sourceRoom = room([], [], 17);
    const proposal = buildAgentEditProposal({
      room: sourceRoom,
      actor,
      request: { kind: "semantic_transaction", transaction },
      metadata: { intent: "Describe room authorization", summary: "Add the room API container" },
      id: "proposal-1",
      now: NOW + 20,
    });

    transaction.commands[0] = { ...transaction.commands[0], type: "delete", targets: [] };
    expect(proposal).toMatchObject({
      id: "proposal-1",
      revision: 1,
      status: "pending",
      baselineRoomRevision: 17,
      author: actor,
      intent: "Describe room authorization",
      summary: "Add the room API container",
      purpose: {
        kind: "semantic_transaction",
        operationCount: 2,
        objectIds: ["api", "existing"],
        diagramIds: ["system"],
        layout: null,
      },
      request: {
        kind: "semantic_transaction",
        transaction: { commands: [expect.objectContaining({ type: "create" })] },
      },
    });
    expect(agentEditProposalSummary(proposal)).not.toHaveProperty("request");
  });

  it("summarizes layouts and compensating reverts without inspecting the canvas", () => {
    expect(agentEditProposalPurpose({
      kind: "layout",
      layout: {
        layout: "flow",
        direction: "right",
        targets: [
          { objectId: "b", expectedRevision: 2 },
          { objectId: "a", expectedRevision: 1 },
        ],
        primaryGap: 160,
        secondaryGap: 100,
        diagramId: "diagram-1",
        expectedDiagramRevision: 3,
      },
    })).toMatchObject({
      kind: "layout",
      operationCount: 1,
      objectIds: ["a", "b"],
      diagramIds: ["diagram-1"],
      layout: "flow",
    });
    expect(agentEditProposalPurpose({
      kind: "activity_revert",
      revert: {
        activityId: "activity-1",
        objectExpectations: [{ objectId: "a", state: "present", expectedRevision: 4 }],
        diagramExpectations: [{ diagramId: "diagram-1", state: "absent" }],
      },
    })).toMatchObject({
      kind: "activity_revert",
      objectIds: ["a"],
      diagramIds: ["diagram-1"],
    });
  });
});
