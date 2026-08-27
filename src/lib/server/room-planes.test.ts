// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { RoomState } from "@/lib/domain/types";

import {
  composeRoomState,
  documentContentFingerprint,
  reconcileLaterLegacyRoom,
  roomForLegacyCompatibility,
  splitRoomState,
} from "./room-planes";

function room(): RoomState {
  return {
    id: "room_planes",
    code: "1234",
    title: "Plane test",
    stateRevision: 9,
    roomRevision: 4,
    createdAt: 1,
    updatedAt: 4,
    participants: {
      p_owner: {
        participantId: "p_owner",
        displayName: "Owner",
        color: "blue",
        role: "participant",
        joinedAt: 1,
        lastSeenAt: 9,
        connected: true,
        agentActive: true,
        human: {
          cursor: { x: 10, y: 20 },
          viewport: null,
          lastSeenAt: 9,
          activity: null,
        },
        agent: {
          cursor: null,
          viewport: null,
          lastSeenAt: 8,
          activity: null,
        },
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

describe("room storage planes", () => {
  it("keeps live presence and leases out of the durable document", () => {
    const source = room();
    const planes = splitRoomState(source);

    expect(planes.document).not.toHaveProperty("leases");
    expect(planes.document).not.toHaveProperty("spotlight");
    expect(planes.document.participants.p_owner).toEqual({
      participantId: "p_owner",
      displayName: "Owner",
      color: "blue",
      role: "participant",
      joinedAt: 1,
    });
    expect(planes.awareness.participants.p_owner.human.cursor).toEqual({ x: 10, y: 20 });
    expect(planes.awareness.participants.p_owner.member).toEqual(
      planes.document.participants.p_owner,
    );
    expect(planes.coordination.stateRevision).toBe(9);
    expect(planes.coordination.roomRevision).toBe(4);
    expect(composeRoomState(planes)).toEqual(source);
  });

  it("does not classify awareness-only movement as a document change", () => {
    const source = room();
    const before = splitRoomState(source);
    source.participants.p_owner.human.cursor = { x: 40, y: 50 };
    source.stateRevision = 10;
    const after = splitRoomState(source);

    expect(documentContentFingerprint(after.document)).toBe(
      documentContentFingerprint(before.document),
    );
    expect(after.awareness).not.toEqual(before.awareness);
  });

  it("uses aggregate state as the old deployment watermark without exposing stateRevision", () => {
    const source = room();
    const compatible = roomForLegacyCompatibility(source);

    expect(compatible.roomRevision).toBe(9);
    expect(compatible).not.toHaveProperty("stateRevision");
  });

  it("promotes only a later legacy document while preserving v3 awareness and leases", () => {
    const source = room();
    source.leases.object_1 = {
      leaseId: "lease_v3",
      objectId: "object_1",
      actor: {
        participantId: "p_owner",
        displayName: "Owner",
        color: "blue",
        kind: "human",
      },
      operation: "edit",
      objectRevision: 1,
      acquiredAt: 8,
      expiresAt: 20_000,
    };
    const current = splitRoomState(source);
    const legacy = structuredClone(source);
    delete (legacy as { stateRevision?: number }).stateRevision;
    legacy.roomRevision = 10;
    legacy.title = "Changed by the old deployment";
    legacy.participants.p_owner.role = "spectator";
    legacy.participants.p_owner.human.cursor = { x: 999, y: 999 };
    legacy.leases.object_1.leaseId = "stale_legacy_lease";

    const reconciled = reconcileLaterLegacyRoom(current, legacy);
    const composed = composeRoomState(reconciled.planes);

    expect(reconciled).toMatchObject({ legacyAdvanced: true, documentPromoted: true });
    expect(composed).toMatchObject({
      title: "Changed by the old deployment",
      roomRevision: 5,
      stateRevision: 10,
      participants: { p_owner: { human: { cursor: { x: 10, y: 20 } } } },
      leases: { object_1: { leaseId: "lease_v3" } },
    });
    expect(reconciled.planes.awareness.participants.p_owner.member?.role).toBe("spectator");
  });

  it("advances aggregate state for a later legacy awareness write without importing it", () => {
    const source = room();
    const current = splitRoomState(source);
    const legacy = structuredClone(source);
    delete (legacy as { stateRevision?: number }).stateRevision;
    legacy.roomRevision = 10;
    legacy.participants.p_owner.human.cursor = { x: 999, y: 999 };

    const reconciled = reconcileLaterLegacyRoom(current, legacy);
    const composed = composeRoomState(reconciled.planes);

    expect(reconciled).toMatchObject({ legacyAdvanced: true, documentPromoted: false });
    expect(composed.roomRevision).toBe(4);
    expect(composed.stateRevision).toBe(10);
    expect(composed.participants.p_owner.human.cursor).toEqual({ x: 10, y: 20 });
  });

  it("promotes a legacy document fingerprint even when newer v3 awareness has a higher watermark", () => {
    const source = room();
    source.stateRevision = 50;
    const current = splitRoomState(source);
    const legacy = structuredClone(source);
    delete (legacy as { stateRevision?: number }).stateRevision;
    legacy.roomRevision = 10;
    legacy.title = "Old deployment edit after hot-path presence";

    const reconciled = reconcileLaterLegacyRoom(current, legacy);
    const composed = composeRoomState(reconciled.planes);

    expect(reconciled).toMatchObject({ legacyAdvanced: true, documentPromoted: true });
    expect(composed).toMatchObject({
      title: "Old deployment edit after hot-path presence",
      roomRevision: 5,
      stateRevision: 51,
    });
  });
});
