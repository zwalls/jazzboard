import { describe, expect, it } from "vitest";

import type { ActorRef, RoomActivity, RoomState } from "@/lib/domain/types";

import {
  assertRedisPlaneWriteCapacity,
  assertRoomCapacity,
  assertRoomMutationCapacity,
  capacityErrorDetails,
  evaluateAwarenessMutationCapacity,
  evaluateRoomCapacity,
  evaluateRoomMutationCapacity,
  REDIS_SAFE_PLANE_WRITE_BYTES,
  resolveCapacityPolicy,
  utf8JsonBytes,
} from "./capacity";
import { splitRoomState } from "./room-planes";

const actor: ActorRef = {
  participantId: "p_private",
  displayName: "Private Person",
  color: "#123456",
  kind: "human",
};

function room(): RoomState {
  return {
    id: "room_private",
    code: "1234",
    title: "Private architecture",
    roomRevision: 1,
    stateRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    participants: {
      p_private: {
        participantId: "p_private",
        displayName: "Private Person",
        color: "#123456",
        role: "participant",
        joinedAt: 1,
        lastSeenAt: 1,
        connected: true,
        agentActive: false,
        human: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
        agent: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
      },
    },
    objects: {},
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function activity(): RoomActivity {
  return {
    id: "activity_private",
    roomId: "room_private",
    roomRevision: 2,
    occurredAt: 2,
    actor,
    action: "canvas.create",
    label: "Private label",
    intent: null,
    summary: null,
    affectedObjectIds: [],
    affectedDiagramIds: [],
    affectedBounds: null,
    objectChanges: [],
    diagramChanges: [],
    objectGuards: {},
    diagramGuards: {},
    revertsActivityId: null,
  };
}

describe("room capacity", () => {
  it("measures durable document, awareness, and coordination as distinct planes", () => {
    const initial = evaluateRoomCapacity(room());
    const withAwareness = room();
    withAwareness.participants.p_private.human.cursor = { x: 200, y: 300 };
    withAwareness.participants.p_private.human.activity = {
      id: "presence_private",
      type: "moving",
      label: "Private activity",
      objectIds: [],
      progress: 0.5,
      startedAt: 2,
    };
    const awareness = evaluateRoomCapacity(withAwareness);
    expect(awareness.metrics.awarenessBytes.used).toBeGreaterThan(initial.metrics.awarenessBytes.used);
    expect(awareness.metrics.durableDocumentBytes.used).toBe(initial.metrics.durableDocumentBytes.used);
    expect(awareness.metrics.coordinationBytes.used).toBe(initial.metrics.coordinationBytes.used);

    const withLease = structuredClone(withAwareness);
    withLease.leases.object = {
      leaseId: "lease_private",
      objectId: "object",
      actor,
      operation: "edit",
      objectRevision: 1,
      acquiredAt: 2,
      expiresAt: 4_002,
    };
    const coordination = evaluateRoomCapacity(withLease);
    expect(coordination.metrics.coordinationBytes.used).toBeGreaterThan(awareness.metrics.coordinationBytes.used);
    expect(coordination.metrics.durableDocumentBytes.used).toBe(awareness.metrics.durableDocumentBytes.used);
  });

  it("accounts for aggregate objects, drawing points, proposals, and activity bytes", () => {
    const value = room();
    value.objects.ink = {
      id: "ink",
      kind: "draw",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      zIndex: 0,
      revision: 1,
      groupId: null,
      diagramIds: [],
      createdAt: 1,
      updatedAt: 1,
      createdBy: actor,
      lastEditedBy: actor,
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: "red",
      size: "m",
    };
    const summary = evaluateRoomCapacity(value, { activity: activity() });
    expect(summary.metrics.objects.used).toBe(1);
    expect(summary.metrics.drawingPoints.used).toBe(2);
    expect(summary.metrics.activityBytes.used).toBe(utf8JsonBytes(activity()));
    expect(summary.metrics.retainedProposalBytes.used).toBe(2);
  });

  it("reports an exceeded warning without rejecting during rollout", () => {
    const value = room();
    value.participants.second = { ...structuredClone(value.participants.p_private), participantId: "second" };
    const summary = assertRoomCapacity(value, {
      policy: { mode: "warn", limits: { participants: 1 } },
    });
    expect(summary.allowed).toBe(true);
    expect(summary.level).toBe("exceeded");
    expect(summary.warningMetrics).toContain("participants");
  });

  it("rejects pre-commit in enforce mode with numeric-only details", () => {
    const value = room();
    value.participants.second = { ...structuredClone(value.participants.p_private), participantId: "second" };
    expect(() => assertRoomCapacity(value, {
      policy: { mode: "enforce", limits: { participants: 1 } },
    })).toThrowError(expect.objectContaining({
      code: "ROOM_CAPACITY_EXCEEDED",
      details: { participantsUsed: 2, participantsLimit: 1 },
    }));

    const summary = evaluateRoomCapacity(value, {
      policy: { mode: "enforce", limits: { participants: 1 } },
    });
    const encoded = JSON.stringify(capacityErrorDetails(summary));
    expect(encoded).not.toContain("Private");
    expect(encoded).not.toContain("room_private");
  });

  it("rejects unsafe policy values", () => {
    expect(() => resolveCapacityPolicy({ warningRatio: 1 })).toThrow();
    expect(() => resolveCapacityPolicy({ limits: { objects: 0 } })).toThrow();
  });

  it("keeps awareness available when an unchanged legacy document is already oversized", () => {
    const before = room();
    before.title = "x".repeat(200);
    const after = structuredClone(before);
    after.participants.p_private.human.cursor = { x: 123_456, y: 654_321 };
    const summary = evaluateRoomMutationCapacity({
      before,
      after,
      changedPlanes: { document: false, awareness: true, coordination: true },
      policy: {
        mode: "enforce",
        limits: { durableDocumentBytes: 1, persistedRoomBytes: 1 },
      },
    });

    expect(summary.allowed).toBe(true);
    expect(summary.grandfatheredMetrics).toEqual(
      expect.arrayContaining(["durableDocumentBytes", "persistedRoomBytes"]),
    );
    expect(summary.blockedMetrics).toEqual([]);
  });

  it("allows partial cleanup but rejects a mutation that worsens its own overage", () => {
    const objectFor = (id: string) => ({
      id,
      kind: "text" as const,
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      rotation: 0,
      zIndex: 0,
      revision: 1,
      groupId: null,
      diagramIds: [],
      createdAt: 1,
      updatedAt: 1,
      createdBy: actor,
      lastEditedBy: actor,
      content: id,
      color: "black",
      size: "m" as const,
      align: "start" as const,
    });
    const before = room();
    before.objects = {
      first: objectFor("first"),
      second: objectFor("second"),
      third: objectFor("third"),
    };
    const cleanup = structuredClone(before);
    delete cleanup.objects.third;
    expect(() =>
      assertRoomMutationCapacity({
        before,
        after: cleanup,
        changedPlanes: { document: true, awareness: false, coordination: true },
        policy: { mode: "enforce", limits: { objects: 1 } },
      }),
    ).not.toThrow();

    const growth = structuredClone(before);
    growth.objects.fourth = objectFor("fourth");
    expect(() =>
      assertRoomMutationCapacity({
        before,
        after: growth,
        changedPlanes: { document: true, awareness: false, coordination: true },
        policy: { mode: "enforce", limits: { objects: 1 } },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "ROOM_CAPACITY_EXCEEDED",
        details: { objectsUsed: 4, objectsLimit: 1 },
      }),
    );
  });

  it("never permits a single Redis plane to approach the provider request ceiling", () => {
    const value = room();
    value.title = "x".repeat(REDIS_SAFE_PLANE_WRITE_BYTES);

    expect(() => assertRedisPlaneWriteCapacity(value)).toThrowError(
      expect.objectContaining({
        code: "ROOM_CAPACITY_EXCEEDED",
        details: expect.objectContaining({
          durableDocumentBytesSafeWriteLimit: REDIS_SAFE_PLANE_WRITE_BYTES,
        }),
      }),
    );
  });

  it("allows an already-oversized awareness plane to shrink but not grow", () => {
    const source = room();
    source.participants.p_private.human.activity = {
      id: "large-awareness",
      type: "moving",
      label: "x".repeat(160),
      objectIds: [],
      progress: 0.5,
      startedAt: 2,
    };
    const before = splitRoomState(source).awareness;
    const smallerRoom = structuredClone(source);
    smallerRoom.participants.p_private.human.activity = null;
    const smaller = splitRoomState(smallerRoom).awareness;
    const largerRoom = structuredClone(source);
    largerRoom.participants.p_private.human.viewport = {
      x: 0,
      y: 0,
      width: 1_000,
      height: 800,
      zoom: 1,
    };
    const larger = splitRoomState(largerRoom).awareness;
    const limit = Math.max(1, Math.min(utf8JsonBytes(before), utf8JsonBytes(smaller)) - 1);

    const shrink = evaluateAwarenessMutationCapacity({
      before,
      after: smaller,
      policy: { mode: "enforce", limits: { awarenessBytes: limit } },
    });
    expect(shrink.allowed).toBe(true);
    expect(shrink.grandfatheredMetrics).toContain("awarenessBytes");

    const growth = evaluateAwarenessMutationCapacity({
      before,
      after: larger,
      policy: { mode: "enforce", limits: { awarenessBytes: limit } },
    });
    expect(growth.allowed).toBe(false);
    expect(growth.blockedMetrics).toContain("awarenessBytes");
  });
});
