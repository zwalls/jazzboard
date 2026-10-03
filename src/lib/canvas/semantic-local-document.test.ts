import { describe, expect, it, vi } from "vitest";

import type { ActorRef, CanvasObject, RoomState } from "@/lib/domain/types";
import { reconcileRoomSnapshot } from "@/lib/client/room-reconciliation";

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

describe("atomic shared document projection", () => {
  it("publishes mixed group changes once and preserves per-object fence ordering within a batch", () => {
    const a = shape("a", 10);
    const b = shape("b", 20);
    const unchanged = shape("unchanged", 30);
    const store = new SemanticLocalDocumentStore(room([a, b, unchanged], 1));
    const before = store.getSnapshot();
    const snapshots: RoomState[] = [];
    store.subscribe(() => snapshots.push(store.getSnapshot()));

    expect(store.applyOverrides([
      { kind: "upsert", object: { ...a, x: 100 }, generation: 3, recoveryEpoch: 2 },
      { kind: "upsert", object: { ...a, x: 999 }, generation: 99, recoveryEpoch: 1 },
      { kind: "delete", objectId: b.id, generation: 1, recoveryEpoch: 0 },
      { kind: "upsert", object: shape("created", 200, 0), generation: 1, recoveryEpoch: 0 },
    ])).toBe(true);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].objects.a.x).toBe(100);
    expect(snapshots[0].objects.b).toBeUndefined();
    expect(snapshots[0].objects.created.x).toBe(200);
    expect(snapshots[0].objects.unchanged).toBe(unchanged);
    expect(before.objects.a).toBe(a);
    expect(before.objects.b).toBe(b);
    expect(before.objects.created).toBeUndefined();

    expect(store.applyOverrides([])).toBe(false);
    expect(store.applyOverrides([
      { kind: "delete", objectId: a.id, generation: 2, recoveryEpoch: 2 },
    ])).toBe(false);
    expect(snapshots).toHaveLength(1);
    expect(store.getSnapshot()).toBe(snapshots[0]);
  });

  it("removes acknowledged cohorts together without clearing a newer generation or recovery epoch", () => {
    const initial = room([shape("a", 10), shape("b", 20), shape("c", 30)], 1);
    const store = new SemanticLocalDocumentStore(initial);
    store.applyOverrides(Object.values(initial.objects).map((object) => ({
      kind: "upsert" as const, object: { ...object, x: object.x + 100 },
      generation: 2, recoveryEpoch: 1,
    })));
    const saved = room([shape("a", 110, 2), shape("b", 120, 2), shape("c", 130, 2)], 2);
    store.acceptAuthoritative(saved);
    const snapshots: RoomState[] = [];
    store.subscribe(() => snapshots.push(store.getSnapshot()));

    expect(store.clearAcknowledgedMany([
      { objectId: "a", generation: 2, recoveryEpoch: 1 },
      { objectId: "b", generation: 2, recoveryEpoch: 0 },
      { objectId: "c", generation: 1, recoveryEpoch: 1 },
    ])).toBe(true);
    expect(snapshots).toHaveLength(1);
    expect(store.getSnapshot().objects.a).toBe(saved.objects.a);
    expect(store.getOverride("b")).toBeDefined();
    expect(store.getOverride("c")).toBeDefined();
    expect(store.clearAcknowledgedMany([
      { objectId: "b", generation: 2, recoveryEpoch: 1 },
      { objectId: "c", generation: 2, recoveryEpoch: 1 },
    ])).toBe(true);
    expect(snapshots).toHaveLength(2);
    expect(store.getSnapshot()).toBe(store.getAuthoritativeRoom());
  });

  it("preserves document identities across decoded coordination updates, including optimistic overlays", () => {
    const initial = room([shape("a", 10), shape("b", 20)], 1);
    const store = new SemanticLocalDocumentStore(initial);
    store.applyOverride({
      kind: "upsert", object: { ...initial.objects.a, x: 80 }, generation: 1, recoveryEpoch: 0,
    });
    const optimistic = store.getSnapshot();
    const presence = structuredClone(initial);
    presence.stateRevision = 2;
    presence.updatedAt = 2;
    presence.spotlight = null;
    expect(store.acceptAuthoritative(presence)).toBe(true);
    expect(store.getAuthoritativeRoom().objects).toBe(initial.objects);
    expect(store.getAuthoritativeRoom().diagrams).toBe(initial.diagrams);
    expect(store.getSnapshot().objects).toBe(optimistic.objects);
    expect(store.getSnapshot()).not.toBe(optimistic);
    expect(store.getSnapshot().stateRevision).toBe(2);
    expect(presence.objects).not.toBe(initial.objects);
    expect(presence.objects.a.x).toBe(10);

    const decodedEqual = structuredClone(store.getAuthoritativeRoom());
    expect(store.acceptAuthoritative(decodedEqual)).toBe(false);
    expect(store.getSnapshot().objects).toBe(optimistic.objects);
  });

  it("observes same-revision nested membership changes and preserves unchanged records", () => {
    const initial = room([shape("a", 10), shape("b", 20)], 1);
    const store = new SemanticLocalDocumentStore(initial);
    const next = structuredClone(initial);
    next.roomRevision = 2;
    next.stateRevision = 2;
    next.objects.a.diagramIds = ["diagram-new"];
    expect(store.acceptAuthoritative(next)).toBe(true);
    expect(store.getSnapshot().objects.a).toBe(next.objects.a);
    expect(store.getSnapshot().objects.a.revision).toBe(initial.objects.a.revision);
    expect(store.getSnapshot().objects.b).toBe(initial.objects.b);
    expect(initial.objects.a.diagramIds).toEqual([]);
    expect(next.objects.b).not.toBe(initial.objects.b);

    const deletedAndRecreated = structuredClone(next);
    deletedAndRecreated.roomRevision = 3;
    deletedAndRecreated.stateRevision = 3;
    deletedAndRecreated.objects.a.createdAt += 1000;
    delete deletedAndRecreated.objects.b;
    expect(store.acceptAuthoritative(deletedAndRecreated)).toBe(true);
    expect(store.getSnapshot().objects.a).toBe(deletedAndRecreated.objects.a);
    expect(store.getSnapshot().objects.b).toBeUndefined();
  });
});

describe("canonical hook document ingress", () => {
  it.each(["objects", "diagrams"] as const)("realigns independent %s decodes at a newer canonical boundary without trusting equal or stale documents", (plane) => {
    const initial = room([shape("node", 10)], 1, 1);
    initial.diagrams.scope = {
      id: "scope", title: "Before", description: "", diagramType: "architecture", category: null,
      tags: [], memberObjectIds: ["node"], connectorIds: [], bounds: { x: 10, y: 20, width: 160, height: 90 },
      revision: 1, createdAt: 1, updatedAt: 1, createdBy: actor, lastEditedBy: actor,
    };
    initial.participants.peer = {
      participantId: "peer", displayName: "Peer", color: "blue", role: "participant", joinedAt: 1,
      connected: true, agentActive: false, lastSeenAt: 1,
      human: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
      agent: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
    };
    const socketDecoded = structuredClone(initial);
    socketDecoded.roomRevision = 2;
    socketDecoded.stateRevision = 2;
    if (plane === "objects") socketDecoded.objects.node.x = 100;
    else socketDecoded.diagrams.scope.title = "After";
    const httpDecoded = structuredClone(socketDecoded);
    const hookRoom = reconcileRoomSnapshot(initial, socketDecoded)!;
    const store = new SemanticLocalDocumentStore(initial);
    expect(store.acceptAuthoritative(httpDecoded)).toBe(true);
    const independentlyAccepted = store.getAuthoritativeRoom();
    expect(independentlyAccepted[plane]).not.toBe(hookRoom[plane]);

    // The existing immediate race remains rejected: even canonical input is
    // not permission to replace an equal-watermark decoded snapshot.
    expect(store.acceptAuthoritative(hookRoom, { canonicalDocument: true })).toBe(false);
    expect(store.getAuthoritativeRoom()).toBe(independentlyAccepted);
    // An older document with newer coordination must never canonicalize its
    // stale document maps over the already accepted revision.
    const staleDocument = { ...initial, stateRevision: 3 };
    expect(store.acceptAuthoritative(staleDocument, { canonicalDocument: true })).toBe(true);
    expect(store.getAuthoritativeRoom().objects).toBe(independentlyAccepted.objects);
    expect(store.getAuthoritativeRoom().diagrams).toBe(independentlyAccepted.diagrams);
    expect(store.getAuthoritativeRoom().roomRevision).toBe(2);

    const hookNewerPresence = reconcileRoomSnapshot(hookRoom, { ...hookRoom, stateRevision: 4 })!;
    expect(store.acceptAuthoritative(hookNewerPresence, { canonicalDocument: true })).toBe(true);
    expect(store.getAuthoritativeRoom().objects).toBe(hookNewerPresence.objects);
    expect(store.getAuthoritativeRoom().diagrams).toBe(hookNewerPresence.diagrams);
    const viewport = { x: 10, y: 20, width: 800, height: 600, zoom: 1 };
    const transient = {
      ...hookNewerPresence,
      participants: {
        ...hookNewerPresence.participants,
        peer: { ...hookNewerPresence.participants.peer,
          human: { ...hookNewerPresence.participants.peer.human, cursor: { x: 80, y: 90 }, viewport },
        },
      },
    };
    expect(store.acceptAuthoritative(transient, { canonicalDocument: true })).toBe(true);
    expect(store.getSnapshot().participants.peer.human).toMatchObject({ cursor: { x: 80, y: 90 }, viewport });
    expect(store.getSnapshot().objects).toBe(hookNewerPresence.objects);
    expect(store.getSnapshot().diagrams).toBe(hookNewerPresence.diagrams);
    const decodedEqual = { ...transient, objects: structuredClone(transient.objects) };
    expect(store.acceptAuthoritative(decodedEqual, { canonicalDocument: true })).toBe(false);
    expect(store.getAuthoritativeRoom().roomRevision).toBe(2);
    store.dispose();
  });
});
