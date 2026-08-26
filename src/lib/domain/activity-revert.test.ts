import { describe, expect, it } from "vitest";

import { applyActivityRevert, applySemanticTransaction, normalizeRoomSemanticState } from "./engine";
import { DomainError } from "./errors";
import { buildRoomActivity } from "./review";
import type {
  ActorRef,
  CanvasObject,
  Diagram,
  Participant,
  RevertActivityRequest,
  RoomActivity,
  RoomState,
  SemanticTransaction,
} from "./types";

const NOW = 5_000;

function participant(id: string): Participant {
  const presence = { cursor: null, viewport: null, lastSeenAt: NOW, activity: null };
  return {
    participantId: id,
    displayName: id === "alice" ? "Alice" : "Bob",
    color: id === "alice" ? "blue" : "red",
    role: "participant",
    joinedAt: NOW,
    lastSeenAt: NOW,
    connected: true,
    agentActive: false,
    human: { ...presence },
    agent: { ...presence },
  };
}

const alice = participant("alice");
const bob = participant("bob");

function actor(owner: Participant, kind: "human" | "agent" = "human"): ActorRef {
  return {
    participantId: owner.participantId,
    displayName: owner.displayName,
    color: owner.color,
    kind,
  };
}

function node(id: string, x = 0, revision = 1): CanvasObject {
  return {
    id,
    kind: "shape",
    x,
    y: 0,
    width: 200,
    height: 100,
    rotation: 0,
    zIndex: 1,
    revision,
    groupId: null,
    diagramIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(alice),
    lastEditedBy: actor(alice),
    shape: "rectangle",
    nodeType: "service",
    nodeMetadata: null,
    label: id,
    fill: "green",
    stroke: "green",
  };
}

function connector(id: string, startId: string, endId: string): CanvasObject {
  return {
    id,
    kind: "connector",
    x: 200,
    y: 50,
    width: 200,
    height: 1,
    rotation: 0,
    zIndex: 0,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(alice),
    lastEditedBy: actor(alice),
    start: { x: 200, y: 50, objectId: startId },
    end: { x: 400, y: 50, objectId: endId },
    direction: "end",
    label: "depends on",
    color: "black",
  };
}

function diagram(members: string[], revision = 1): Diagram {
  return {
    id: "diagram-main",
    title: "System",
    description: "System diagram",
    diagramType: "architecture",
    category: null,
    tags: [],
    memberObjectIds: members,
    connectorIds: [],
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    revision,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(alice),
    lastEditedBy: actor(alice),
  };
}

function room(objects: CanvasObject[], diagrams: Diagram[] = []): RoomState {
  return normalizeRoomSemanticState({
    id: "room-review",
    code: "1234",
    title: "Review room",
    roomRevision: 4,
    createdAt: NOW,
    updatedAt: NOW,
    participants: { alice: structuredClone(alice), bob: structuredClone(bob) },
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: Object.fromEntries(diagrams.map((item) => [item.id, item])),
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  });
}

function recordedMutation(source: RoomState, transaction: SemanticTransaction, now = NOW + 100) {
  const result = applySemanticTransaction(source, "alice", "agent", transaction, now);
  const activity = buildRoomActivity({
    before: source,
    after: result.room,
    actor: actor(alice, "agent"),
    action: "canvas.transaction",
    label: "Applied semantic change",
    changedObjectIds: result.changedObjectIds,
    changedDiagramIds: result.changedDiagramIds,
    membershipObjectIds: result.membershipObjectIds,
    id: "activity-target",
    occurredAt: now,
  });
  return { result, activity };
}

function requestFor(activity: RoomActivity): RevertActivityRequest {
  return {
    activityId: activity.id,
    objectExpectations: Object.entries(activity.objectGuards).map(([objectId, guard]) =>
      guard.state === "present"
        ? { objectId, state: "present", expectedRevision: guard.revision }
        : { objectId, state: "absent" },
    ),
    diagramExpectations: Object.entries(activity.diagramGuards).map(([diagramId, guard]) =>
      guard.state === "present"
        ? { diagramId, state: "present", expectedRevision: guard.revision }
        : { diagramId, state: "absent" },
    ),
  };
}

function captureDomainError(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error("Expected DomainError");
}

describe("compensating activity revert", () => {
  it("restores semantic state as a new revision with the reverting actor's attribution", () => {
    const source = room([node("api")]);
    const { result, activity } = recordedMutation(source, {
      commands: [{ type: "update", objectId: "api", expectedRevision: 1, operation: "edit", patch: { label: "API v2" } }],
      diagramCommands: [],
    });

    const reverted = applyActivityRevert(
      result.room,
      "bob",
      "agent",
      activity,
      requestFor(activity),
      NOW + 200,
    );

    expect(reverted.room.objects.api).toMatchObject({
      label: "api",
      revision: 3,
      updatedAt: NOW + 200,
      lastEditedBy: actor(bob, "agent"),
    });
    expect(reverted.room.objects.api.createdBy).toEqual(actor(alice));
    expect(reverted.room.roomRevision).toBe(result.room.roomRevision + 1);
    expect(result.room.objects.api).toMatchObject({ label: "API v2", revision: 2 });
  });

  it("rejects stale guards atomically instead of rewinding later edits", () => {
    const source = room([node("api")]);
    const { result, activity } = recordedMutation(source, {
      commands: [{ type: "move", targets: [{ objectId: "api", expectedRevision: 1, x: 100, y: 40 }] }],
      diagramCommands: [],
    });
    const later = applySemanticTransaction(
      result.room,
      "alice",
      "human",
      { commands: [{ type: "update", objectId: "api", expectedRevision: 2, operation: "edit", patch: { label: "Later" } }], diagramCommands: [] },
      NOW + 150,
    ).room;
    const before = structuredClone(later);

    const error = captureDomainError(() =>
      applyActivityRevert(later, "bob", "agent", activity, requestFor(activity), NOW + 200),
    );

    expect(error).toMatchObject({ code: "REVISION_CONFLICT", details: { objectId: "api" } });
    expect(later).toEqual(before);
  });

  it("honors active-object leases before applying any compensation", () => {
    const source = room([node("api")]);
    const { result, activity } = recordedMutation(source, {
      commands: [{ type: "update", objectId: "api", expectedRevision: 1, operation: "edit", patch: { label: "Changed" } }],
      diagramCommands: [],
    });
    result.room.leases.api = {
      leaseId: "alice-lease",
      objectId: "api",
      actor: actor(alice),
      operation: "edit",
      objectRevision: 2,
      acquiredAt: NOW + 110,
      expiresAt: NOW + 1_000,
    };

    const error = captureDomainError(() =>
      applyActivityRevert(result.room, "bob", "agent", activity, requestFor(activity), NOW + 200),
    );
    expect(error).toMatchObject({ code: "OBJECT_BUSY", details: { objectId: "api" } });
  });

  it("blocks deletion when a later connector depends on the created object", () => {
    const source = room([node("worker", 400)]);
    const { result, activity } = recordedMutation(source, {
      commands: [{ type: "create", object: { ...node("api"), revision: undefined, diagramIds: undefined, createdAt: undefined, updatedAt: undefined, createdBy: undefined, lastEditedBy: undefined } as never }],
      diagramCommands: [],
    });
    const later = normalizeRoomSemanticState(structuredClone(result.room));
    later.objects.edge = connector("edge", "api", "worker");
    const request = requestFor(activity);

    const error = captureDomainError(() =>
      applyActivityRevert(later, "bob", "agent", activity, request, NOW + 200),
    );
    expect(error).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { externalConnectorIds: ["edge"] },
    });
  });

  it("restores Diagram membership without overwriting a derived member object", () => {
    const source = room([node("api"), node("worker", 400)], [diagram(["api"])]);
    const { result, activity } = recordedMutation(source, {
      commands: [],
      diagramCommands: [{
        type: "diagram.update",
        diagramId: "diagram-main",
        expectedRevision: 1,
        patch: { memberObjectIds: ["api", "worker"] },
      }],
    });
    expect(activity.objectChanges.find((change) => change.objectId === "worker")?.mode).toBe("derived_membership");

    const reverted = applyActivityRevert(
      result.room,
      "bob",
      "human",
      activity,
      requestFor(activity),
      NOW + 200,
    );

    expect(reverted.room.diagrams["diagram-main"]).toMatchObject({ memberObjectIds: ["api"], revision: 3 });
    expect(reverted.room.objects.worker).toMatchObject({ revision: 1, diagramIds: [] });
    expect(reverted.membershipObjectIds).toEqual(["worker"]);
  });
});
