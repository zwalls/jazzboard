// @vitest-environment node

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/domain/errors";
import type { ActorKind, ActorRef, Participant, RoomState } from "@/lib/domain/types";

const mocks = vi.hoisted(() => ({ readAuthorizedRoom: vi.fn() }));

vi.mock("./room-service", () => ({
  readAuthorizedRoom: mocks.readAuthorizedRoom,
}));

import {
  createReadonlySnapshot,
  listReadonlySnapshots,
  readPublicSnapshot,
  revokeReadonlySnapshot,
} from "./snapshot-service";
import { resetSnapshotStoreForTests } from "./snapshot-store";

const START = new Date("2026-08-26T12:00:00.000Z");

function actor(participantId = "p_owner", kind: ActorKind = "human"): ActorRef {
  return { participantId, displayName: participantId === "p_owner" ? "Maya" : "Peer", color: "#5965e8", kind };
}

function participant(participantId: string, role: "participant" | "spectator"): Participant {
  const presence = { cursor: null, viewport: null, lastSeenAt: Date.now(), activity: null };
  return {
    participantId,
    displayName: participantId === "p_owner" ? "Maya" : participantId === "p_peer" ? "Peer" : "Observer",
    color: "#5965e8",
    role,
    joinedAt: Date.now(),
    lastSeenAt: Date.now(),
    connected: true,
    agentActive: false,
    human: { ...presence },
    agent: { ...presence },
  };
}

function room(): RoomState {
  return {
    id: "room_private_identifier",
    code: "4242",
    title: "Private authentication board",
    roomRevision: 7,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    participants: {
      p_owner: participant("p_owner", "participant"),
      p_peer: participant("p_peer", "participant"),
      p_spectator: participant("p_spectator", "spectator"),
    },
    objects: {
      "private-image": {
        id: "private-image",
        kind: "image",
        x: 20,
        y: 30,
        width: 320,
        height: 180,
        rotation: 0,
        zIndex: 1,
        revision: 2,
        groupId: null,
        diagramIds: ["diagram_auth"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: actor(),
        lastEditedBy: actor("p_owner", "agent"),
        url: "/api/rooms/room_private_identifier/assets?assetId=secret",
        assetId: "secret-asset-id",
        alt: "Login screen annotation",
        mimeType: "image/png",
        sourceUrl: "https://private.example/internal-image.png",
        locked: false,
      },
    },
    diagrams: {
      diagram_auth: {
        id: "diagram_auth",
        title: "Authentication request flow",
        description: "Explains the private request path.",
        diagramType: "flow",
        category: "security",
        tags: ["authorization"],
        memberObjectIds: ["private-image"],
        connectorIds: [],
        bounds: { x: 20, y: 30, width: 320, height: 180 },
        revision: 3,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: actor(),
        lastEditedBy: actor("p_owner", "agent"),
      },
    },
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

async function expectDomainError(promise: Promise<unknown>, code: DomainError["code"]) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("snapshot service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    resetSnapshotStoreForTests();
    mocks.readAuthorizedRoom.mockResolvedValue(room());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a high-entropy exact-token link while storing only its hash", async () => {
    const result = await createReadonlySnapshot({
      roomId: "room_private_identifier",
      participantId: "p_owner",
      actorKind: "agent",
      expectedRoomRevision: 7,
      scope: { kind: "room" },
      title: "Safe shared view",
    });
    const token = result.snapshot.path.replace("/snapshot/", "");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.snapshot.expiresAt - result.snapshot.createdAt).toBe(24 * 60 * 60 * 1_000);

    const tokenHash = createHash("sha256").update(token).digest("hex");
    const record = await storedRecord(tokenHash);
    expect(record).toMatchObject({
      tokenHash,
      sourceRoomId: "room_private_identifier",
      creatorParticipantId: "p_owner",
      creator: { displayName: "Maya", kind: "agent" },
      title: "Safe shared view",
      artifact: { kind: "snapshot" },
    });
    expect(JSON.stringify(record)).not.toContain(token);

    const publicView = await readPublicSnapshot(token);
    const serialized = JSON.stringify(publicView);
    expect(publicView).toMatchObject({
      title: "Safe shared view",
      creator: { displayName: "Maya", kind: "agent" },
      artifact: {
        kind: "snapshot",
        objects: [
          {
            id: "private-image",
            media: { availability: "placeholder", reason: "private_or_external_source_omitted" },
          },
        ],
      },
    });
    for (const forbidden of [
      "room_private_identifier",
      "4242",
      "participantId",
      "secret-asset-id",
      "private.example",
      "sourceUrl",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("requires exact room and Diagram revisions before projecting", async () => {
    await expectDomainError(
      createReadonlySnapshot({
        roomId: "room_private_identifier",
        participantId: "p_owner",
        actorKind: "human",
        expectedRoomRevision: 6,
        scope: { kind: "room" },
      }),
      "REVISION_CONFLICT",
    );
    await expectDomainError(
      createReadonlySnapshot({
        roomId: "room_private_identifier",
        participantId: "p_owner",
        actorKind: "human",
        expectedRoomRevision: 7,
        scope: { kind: "diagram", diagramId: "diagram_auth", expectedDiagramRevision: 2 },
      }),
      "REVISION_CONFLICT",
    );
  });

  it("blocks spectators and keeps list/revoke creator-only for human and agent routes", async () => {
    await expectDomainError(
      createReadonlySnapshot({
        roomId: "room_private_identifier",
        participantId: "p_spectator",
        actorKind: "agent",
        expectedRoomRevision: 7,
        scope: { kind: "room" },
      }),
      "FORBIDDEN",
    );

    const created = await createReadonlySnapshot({
      roomId: "room_private_identifier",
      participantId: "p_owner",
      actorKind: "agent",
      expectedRoomRevision: 7,
      scope: { kind: "diagram", diagramId: "diagram_auth", expectedDiagramRevision: 3 },
    });
    await expect(
      listReadonlySnapshots({
        roomId: "room_private_identifier",
        participantId: "p_owner",
        actorKind: "agent",
      }),
    ).resolves.toMatchObject({ snapshots: [{ id: created.snapshot.id }] });
    await expect(
      listReadonlySnapshots({
        roomId: "room_private_identifier",
        participantId: "p_peer",
        actorKind: "human",
      }),
    ).resolves.toEqual({ snapshots: [] });
    await expectDomainError(
      revokeReadonlySnapshot({
        roomId: "room_private_identifier",
        participantId: "p_peer",
        actorKind: "human",
        snapshotId: created.snapshot.id,
      }),
      "SNAPSHOT_NOT_FOUND",
    );

    await expect(
      revokeReadonlySnapshot({
        roomId: "room_private_identifier",
        participantId: "p_owner",
        actorKind: "agent",
        snapshotId: created.snapshot.id,
      }),
    ).resolves.toEqual({ snapshotId: created.snapshot.id, revoked: true });
    await expect(readPublicSnapshot(created.snapshot.path.replace("/snapshot/", ""))).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_FOUND",
      message: "That snapshot is unavailable.",
    });
  });

  it("uses one generic not-found result for malformed and expired links", async () => {
    await expectDomainError(readPublicSnapshot("not-a-token"), "SNAPSHOT_NOT_FOUND");

    const created = await createReadonlySnapshot({
      roomId: "room_private_identifier",
      participantId: "p_owner",
      actorKind: "human",
      expectedRoomRevision: 7,
      scope: { kind: "room" },
      expiresInHours: 1,
    });
    vi.advanceTimersByTime(60 * 60 * 1_000);
    await expect(readPublicSnapshot(created.snapshot.path.replace("/snapshot/", ""))).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_FOUND",
      message: "That snapshot is unavailable.",
    });
  });
});

async function storedRecord(tokenHash: string) {
  // The service and test share the current injected process-local store.
  const { getSnapshotStore } = await import("./snapshot-store");
  return getSnapshotStore().getByTokenHash(tokenHash);
}
