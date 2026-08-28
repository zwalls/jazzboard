import { describe, expect, it, vi } from "vitest";

import type { ActorRef, CanvasObject, RoomState } from "@/lib/domain/types";

import { SemanticLocalDocumentStore } from "./semantic-local-document";

const actor: ActorRef = {
  participantId: "participant-local",
  displayName: "Local Editor",
  color: "blue",
  kind: "human",
};

function shape(id: string, x: number, revision = 1): CanvasObject {
  return {
    id,
    kind: "shape",
    x,
    y: 20,
    width: 160,
    height: 90,
    rotation: 0,
    zIndex: 1,
    revision,
    groupId: null,
    diagramIds: [],
    createdAt: 100,
    updatedAt: 100 + revision,
    createdBy: actor,
    lastEditedBy: actor,
    shape: "rectangle",
    nodeType: "service",
    nodeMetadata: null,
    label: id,
    fill: "white",
    stroke: "blue",
  };
}

function room(
  objects: readonly CanvasObject[],
  roomRevision: number,
  stateRevision = roomRevision,
): RoomState {
  return {
    id: "room-local",
    code: "LOCAL1",
    title: "Local document",
    stateRevision,
    roomRevision,
    createdAt: 1,
    updatedAt: stateRevision,
    participants: {},
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

describe("SemanticLocalDocumentStore", () => {
  it("keeps frame-immediate local pixels while accepting newer presence and document rooms", () => {
    const initial = shape("node", 10, 3);
    const store = new SemanticLocalDocumentStore(room([initial], 3));
    const listener = vi.fn();
    store.subscribe(listener);
    const local = { ...initial, x: 420 };

    expect(store.applyOverride({
      kind: "upsert",
      object: local,
      generation: 1,
      recoveryEpoch: 0,
    })).toBe(true);
    expect(store.getSnapshot().objects.node.x).toBe(420);

    expect(store.acceptAuthoritative(room([{ ...initial, x: 10 }], 3, 4))).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ stateRevision: 4, roomRevision: 3 });
    expect(store.getSnapshot().objects.node.x).toBe(420);

    expect(store.acceptAuthoritative(room([{ ...initial, x: 80, revision: 4 }], 4, 5))).toBe(true);
    expect(store.getAuthoritativeRoom().objects.node.x).toBe(80);
    expect(store.getSnapshot().objects.node.x).toBe(420);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("installs an acknowledgement room before revealing it and clears only the exact generation", () => {
    const initial = shape("node", 10, 3);
    const store = new SemanticLocalDocumentStore(room([initial], 3));
    store.applyOverride({
      kind: "upsert",
      object: { ...initial, x: 200 },
      generation: 1,
      recoveryEpoch: 0,
    });
    store.applyOverride({
      kind: "upsert",
      object: { ...initial, x: 360 },
      generation: 2,
      recoveryEpoch: 0,
    });

    expect(store.acceptAuthoritative(room([{ ...initial, x: 200, revision: 4 }], 4))).toBe(true);
    expect(store.clearAcknowledged("node", { generation: 1, recoveryEpoch: 0 })).toBe(false);
    expect(store.getSnapshot().objects.node.x).toBe(360);

    expect(store.acceptAuthoritative(room([{ ...initial, x: 360, revision: 5 }], 5))).toBe(true);
    expect(store.clearAcknowledged("node", { generation: 2, recoveryEpoch: 0 })).toBe(true);
    expect(store.getSnapshot().objects.node).toMatchObject({ x: 360, revision: 5 });
    expect(store.getOverride("node")).toBeUndefined();
  });

  it("keeps pending creations and deletion tombstones across stale room projection", () => {
    const existing = shape("existing", 10, 2);
    const created = shape("created", 300, 0);
    const store = new SemanticLocalDocumentStore(room([existing], 2));

    store.applyOverride({
      kind: "upsert",
      object: created,
      generation: 1,
      recoveryEpoch: 0,
    });
    store.applyOverride({
      kind: "delete",
      objectId: existing.id,
      generation: 1,
      recoveryEpoch: 0,
    });
    store.acceptAuthoritative(room([{ ...existing, revision: 3 }], 3));

    expect(store.getSnapshot().objects.created).toBe(created);
    expect(store.getSnapshot().objects.existing).toBeUndefined();
    expect(store.optimisticObjectIds()).toEqual(new Set(["created", "existing"]));
  });

  it("rejects stale overrides and performs one explicit authoritative recovery", () => {
    const initial = shape("node", 10, 3);
    const store = new SemanticLocalDocumentStore(room([initial], 3));
    store.applyOverride({
      kind: "upsert",
      object: { ...initial, x: 500 },
      generation: 4,
      recoveryEpoch: 2,
    });
    expect(store.applyOverride({
      kind: "upsert",
      object: { ...initial, x: 250 },
      generation: 99,
      recoveryEpoch: 1,
    })).toBe(false);
    expect(store.getSnapshot().objects.node.x).toBe(500);

    const recovered = room([{ ...initial, x: 40, revision: 4 }], 4);
    store.forceRecover(recovered, ["node"]);
    expect(store.getSnapshot().objects.node).toMatchObject({ x: 40, revision: 4 });
    expect(store.optimisticObjectIds()).toEqual(new Set());
  });

  it("ignores equal or older room responses and becomes inert after disposal", () => {
    const initial = room([shape("node", 10)], 5, 8);
    const store = new SemanticLocalDocumentStore(initial);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.acceptAuthoritative(room([shape("node", 99)], 5, 8))).toBe(false);
    expect(store.acceptAuthoritative(room([shape("node", 99)], 4, 7))).toBe(false);
    store.dispose();
    expect(store.applyOverride({
      kind: "delete",
      objectId: "node",
      generation: 1,
      recoveryEpoch: 0,
    })).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("accepts equal-watermark transient presence only when document and coordination planes are shared", () => {
    const initial = room([shape("node", 10)], 5, 8);
    const store = new SemanticLocalDocumentStore(initial);
    const transient = {
      ...initial,
      participants: {
        transient: {
          participantId: "transient",
          displayName: "Transient peer",
          color: "violet",
          role: "spectator" as const,
          joinedAt: 1,
          lastSeenAt: 9,
          connected: true,
          agentActive: false,
          human: { cursor: { x: 40, y: 50 }, viewport: null, lastSeenAt: 9, activity: null },
          agent: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
        },
      },
    };

    expect(store.acceptAuthoritative(transient)).toBe(true);
    expect(store.getSnapshot().participants.transient.human.cursor).toEqual({ x: 40, y: 50 });
    expect(store.getSnapshot().objects).toBe(initial.objects);

    const decodedEqualSnapshot = {
      ...transient,
      objects: { node: { ...initial.objects.node, x: 999 } },
    };
    expect(store.acceptAuthoritative(decodedEqualSnapshot)).toBe(false);
    expect(store.getSnapshot().objects.node.x).toBe(10);
  });

  it("accepts a newer document behind a presence watermark and preserves newer coordination", () => {
    const initial = room([shape("node", 10, 1)], 1, 5);
    initial.leases.node = {
      leaseId: "lease-node",
      objectId: "node",
      actor,
      operation: "move",
      objectRevision: 1,
      acquiredAt: 4,
      expiresAt: 10,
    };
    const store = new SemanticLocalDocumentStore(initial);
    const commandResponse = room([
      shape("node", 10, 1),
      shape("created-by-agent", 400, 1),
    ], 2, 4);

    expect(store.acceptAuthoritative(commandResponse)).toBe(true);
    expect(store.getAuthoritativeRoom()).toMatchObject({ roomRevision: 2, stateRevision: 5 });
    expect(store.getSnapshot().objects["created-by-agent"]).toBe(commandResponse.objects["created-by-agent"]);
    expect(store.getSnapshot().leases).toBe(initial.leases);
  });
});
