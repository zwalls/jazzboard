// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LEASE_DURATION_MS } from "@/lib/domain/engine";
import { DomainError } from "@/lib/domain/errors";
import type { CanvasCommand, RevertDiagramExpectation, RevertObjectExpectation, RoomEvent } from "@/lib/domain/types";

import {
  listRoomActivities,
  readAuthorizedRoom,
  readRoomActivity,
  renameRoom,
  runActivityRevert,
  runCanvasCommand,
  runLeaseAction,
  updateSpotlight,
  updatePresence,
  upgradeMembership,
} from "./room-service";
import {
  getRoomStore,
  PRESENCE_AWAY_MS,
  subscribeToLocalRoomEvents,
} from "./room-store";

const START = new Date("2026-08-25T12:00:00.000Z");

function createTextCommand(id: string, content = id): CanvasCommand {
  return {
    type: "create",
    object: {
      id,
      kind: "text",
      x: 10,
      y: 20,
      width: 240,
      height: 80,
      rotation: 0,
      zIndex: 0,
      groupId: null,
      content,
      color: "black",
      size: "m",
      align: "start",
    },
  };
}

async function seededRoom() {
  const store = getRoomStore();
  const created = await store.createRoom({
    participantId: "p_owner",
    displayName: "Owner",
    title: "Authorization room",
  });
  const room = await store.joinRoom({
    participantId: "p_spectator",
    displayName: "Sam",
    code: created.code,
    role: "spectator",
  });
  return { store, room };
}

async function expectDomainError(
  promise: Promise<unknown>,
  code: DomainError["code"],
): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
    return error as DomainError;
  }
  throw new Error(`Expected ${code} to be thrown.`);
}

describe("room service authorization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.stubEnv("REDIS_URL", "");
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
  });

  afterEach(() => {
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("allows room members to read but rejects an unrelated guest session", async () => {
    const { room } = await seededRoom();

    await expect(readAuthorizedRoom(room.id, "p_owner")).resolves.toMatchObject({ id: room.id });
    await expect(readAuthorizedRoom(room.id, "p_spectator")).resolves.toMatchObject({
      participants: { p_spectator: { role: "spectator" } },
    });
    await expectDomainError(readAuthorizedRoom(room.id, "p_outsider"), "FORBIDDEN");
  });

  it("renames a room as a durable participant mutation without touching awareness", async () => {
    const { store, room } = await seededRoom();
    const before = await store.getRoom(room.id);
    const events: RoomEvent[] = [];
    const unsubscribe = subscribeToLocalRoomEvents((event) => events.push(event));

    const renamed = await renameRoom(
      room.id,
      "p_owner",
      "Architecture review",
      "Authorization room",
    );
    unsubscribe();

    expect(renamed.title).toBe("Architecture review");
    expect(renamed.roomRevision).toBe((before?.roomRevision ?? 0) + 1);
    expect(renamed.participants.p_owner.lastSeenAt).toBe(before?.participants.p_owner.lastSeenAt);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "room.updated",
      actor: { participantId: "p_owner", kind: "human" },
    });
  });

  it("rejects spectator and stale concurrent room renames", async () => {
    const { store, room } = await seededRoom();

    await expectDomainError(
      renameRoom(room.id, "p_spectator", "Spectator title", "Authorization room"),
      "FORBIDDEN",
    );
    await renameRoom(room.id, "p_owner", "First title", "Authorization room");
    const conflict = await expectDomainError(
      renameRoom(room.id, "p_owner", "Second title", "Authorization room"),
      "REVISION_CONFLICT",
    );

    expect(conflict.details).toEqual({
      expectedTitle: "Authorization room",
      actualTitle: "First title",
    });
    await expect(store.getRoom(room.id)).resolves.toMatchObject({ title: "First title" });
  });

  it("attributes a membership join event to the joining guest", async () => {
    const store = getRoomStore();
    const created = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Membership room",
    });
    const events: RoomEvent[] = [];
    const unsubscribe = subscribeToLocalRoomEvents((event) => events.push(event));

    await store.joinRoom({
      participantId: "p_spectator",
      displayName: "Sam",
      code: created.code,
      role: "spectator",
    });
    unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "presence.updated",
      actor: {
        participantId: "p_spectator",
        displayName: "Sam",
        kind: "human",
      },
    });
  });

  it("blocks spectator human and agent mutations until an explicit role upgrade", async () => {
    const { room } = await seededRoom();

    const humanError = await expectDomainError(
      runCanvasCommand({
        roomId: room.id,
        participantId: "p_spectator",
        actorKind: "human",
        command: createTextCommand("human-blocked"),
      }),
      "FORBIDDEN",
    );
    expect(humanError.details).toEqual({ role: "spectator" });

    await expectDomainError(
      runCanvasCommand({
        roomId: room.id,
        participantId: "p_spectator",
        actorKind: "agent",
        command: createTextCommand("agent-blocked"),
      }),
      "FORBIDDEN",
    );
    await expectDomainError(
      updatePresence({
        roomId: room.id,
        participantId: "p_spectator",
        actorKind: "agent",
        cursor: null,
        viewport: null,
        activity: null,
      }),
      "FORBIDDEN",
    );

    const observing = await updatePresence({
      roomId: room.id,
      participantId: "p_spectator",
      actorKind: "human",
      cursor: { x: 5, y: 10 },
      viewport: null,
      activity: null,
    });
    expect(observing).toMatchObject({
      participantId: "p_spectator",
      actorKind: "human",
      agentActive: false,
      presence: { cursor: { x: 5, y: 10 } },
    });
    expect((await readAuthorizedRoom(room.id, "p_spectator")).participants.p_spectator.role)
      .toBe("spectator");

    await upgradeMembership(room.id, "p_spectator");
    const allowed = await runCanvasCommand({
      roomId: room.id,
      participantId: "p_spectator",
      actorKind: "agent",
      command: createTextCommand("allowed-after-upgrade"),
    });
    expect(allowed.room.participants.p_spectator).toMatchObject({
      role: "participant",
      agentActive: true,
    });
    expect(allowed.room.objects["allowed-after-upgrade"].createdBy).toMatchObject({
      participantId: "p_spectator",
      kind: "agent",
    });
  });

  it("attributes realtime mutations to the authenticated participant and server-selected actor kind", async () => {
    const { room } = await seededRoom();
    const events: RoomEvent[] = [];
    const unsubscribe = subscribeToLocalRoomEvents((event) => events.push(event));

    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("human-note"),
    });
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      command: createTextCommand("agent-note"),
    });
    unsubscribe();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "room.updated",
      actor: {
        participantId: "p_owner",
        displayName: "Owner",
        kind: "human",
      },
    });
    expect(events[1]).toMatchObject({
      type: "agent.activity",
      actor: {
        participantId: "p_owner",
        displayName: "Owner",
        kind: "agent",
      },
      payload: {
        room: {
          participants: {
            p_owner: {
              agent: {
                activity: {
                  type: "typing",
                  label: "Typing canvas text",
                  progress: 0,
                  objectIds: ["agent-note"],
                },
              },
            },
          },
        },
      },
    });
  });

  it("enforces leases and revisions through the transactional service boundary", async () => {
    const { store, room } = await seededRoom();
    await store.joinRoom({
      participantId: "p_bob",
      displayName: "Bob",
      code: room.code,
      role: "participant",
    });
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("note", "Initial"),
    });

    const leased = await runLeaseAction({
      action: "acquire",
      roomId: room.id,
      participantId: "p_bob",
      actorKind: "agent",
      objectId: "note",
      expectedRevision: 1,
      operation: "edit",
    });
    expect(leased.room.participants.p_bob.agentActive).toBe(true);
    expect(leased.lease?.actor).toMatchObject({ participantId: "p_bob", kind: "agent" });

    const busy = await expectDomainError(
      runCanvasCommand({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "agent",
        command: {
          type: "update",
          objectId: "note",
          expectedRevision: 1,
          operation: "edit",
          patch: { content: "Blocked" },
        },
      }),
      "OBJECT_BUSY",
    );
    expect(busy.details).toMatchObject({
      objectId: "note",
      actor: { participantId: "p_bob", displayName: "Bob", kind: "agent" },
      operation: "edit",
      currentRevision: 1,
    });
    expect((await readAuthorizedRoom(room.id, "p_owner")).participants.p_owner.agentActive).toBe(false);

    await runLeaseAction({
      action: "release",
      roomId: room.id,
      participantId: "p_bob",
      actorKind: "agent",
      objectId: "note",
      leaseId: leased.lease!.leaseId,
    });
    const updated = await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: {
        type: "update",
        objectId: "note",
        expectedRevision: 1,
        operation: "edit",
        patch: { content: "Current" },
      },
    });
    expect(updated.room.objects.note).toMatchObject({ revision: 2, content: "Current" });

    const stale = await expectDomainError(
      runCanvasCommand({
        roomId: room.id,
        participantId: "p_bob",
        actorKind: "human",
        command: {
          type: "update",
          objectId: "note",
          expectedRevision: 1,
          operation: "edit",
          patch: { content: "Stale" },
        },
      }),
      "REVISION_CONFLICT",
    );
    expect(stale.details).toEqual({
      objectId: "note",
      expectedRevision: 1,
      currentRevision: 2,
    });
    expect((await readAuthorizedRoom(room.id, "p_owner")).objects.note).toMatchObject({
      revision: 2,
      content: "Current",
    });
  });

  it("keeps awareness and coordination churn out of the durable document revision", async () => {
    const { room } = await seededRoom();
    const created = await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("plane-note"),
    });
    const durableRevision = created.room.roomRevision;
    const initialStateRevision = created.room.stateRevision!;

    const present = await updatePresence({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      cursor: { x: 33, y: 44 },
      viewport: null,
      activity: null,
    });
    expect(present.roomRevision).toBe(durableRevision);
    expect(present.stateRevision).toBeGreaterThan(initialStateRevision);

    const leased = await runLeaseAction({
      action: "acquire",
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      objectId: "plane-note",
      expectedRevision: 1,
      operation: "move",
    });
    expect(leased.room.roomRevision).toBe(durableRevision);
    expect(leased.room.stateRevision).toBeGreaterThan(present.stateRevision!);

    const spotlighted = await updateSpotlight({
      roomId: room.id,
      participantId: "p_owner",
      action: "start",
      target: "human",
    });
    expect(spotlighted.roomRevision).toBe(durableRevision);
    expect(spotlighted.stateRevision).toBeGreaterThan(leased.room.stateRevision!);

    const updated = await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: {
        type: "update",
        objectId: "plane-note",
        expectedRevision: 1,
        leaseId: leased.lease!.leaseId,
        operation: "edit",
        patch: { content: "Durable edit" },
      },
    });
    expect(updated.room.roomRevision).toBe(durableRevision + 1);
    expect(updated.room.stateRevision).toBeGreaterThan(spotlighted.stateRevision!);
  });

  it("handles a multi-object lease lifecycle in one room transaction per action", async () => {
    const { room } = await seededRoom();
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("batch-a"),
    });
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("batch-b"),
    });
    const baseline = await readAuthorizedRoom(room.id, "p_owner");

    const acquired = await runLeaseAction({
      action: "acquire-many",
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      targets: [
        { objectId: "batch-a", expectedRevision: 1, operation: "move" },
        { objectId: "batch-b", expectedRevision: 1, operation: "resize" },
      ],
    });
    expect("leases" in acquired && acquired.leases).toHaveLength(2);
    expect(acquired.room.roomRevision).toBe(baseline.roomRevision);
    expect(acquired.room.stateRevision).toBe(baseline.stateRevision! + 1);

    if (!("leases" in acquired)) throw new Error("Expected batch leases.");
    const targets = acquired.leases.map(({ objectId, leaseId }) => ({ objectId, leaseId }));
    vi.setSystemTime(new Date(START.getTime() + 100));
    const renewed = await runLeaseAction({
      action: "renew-many",
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      targets,
    });
    expect(renewed.room.stateRevision).toBe(acquired.room.stateRevision! + 1);

    const released = await runLeaseAction({
      action: "release-many",
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      targets,
    });
    expect("leases" in released && released.leases).toEqual([]);
    expect(released.room.leases).toEqual({});
    expect(released.room.stateRevision).toBe(renewed.room.stateRevision! + 1);
  });

  it("persists liveness, lease expiry, and presenter Spotlight teardown as one revisioned transition", async () => {
    const { room } = await seededRoom();
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("expiring-note"),
    });
    await runLeaseAction({
      action: "acquire",
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      objectId: "expiring-note",
      expectedRevision: 1,
      operation: "move",
    });
    const spotlighted = await updateSpotlight({
      roomId: room.id,
      participantId: "p_owner",
      action: "start",
      target: "human",
    });
    const durableRevision = spotlighted.roomRevision;
    const stateRevision = spotlighted.stateRevision!;
    const events: RoomEvent[] = [];
    const unsubscribe = subscribeToLocalRoomEvents((event) => events.push(event));

    vi.setSystemTime(START.getTime() + Math.max(LEASE_DURATION_MS, PRESENCE_AWAY_MS) + 1);
    const expired = await readAuthorizedRoom(room.id, "p_owner");
    const stable = await readAuthorizedRoom(room.id, "p_owner");
    unsubscribe();

    expect(expired).toMatchObject({
      roomRevision: durableRevision,
      stateRevision: stateRevision + 1,
      participants: {
        p_owner: { connected: false },
        p_spectator: { connected: false },
      },
      leases: {},
      spotlight: null,
    });
    expect(stable.stateRevision).toBe(expired.stateRevision);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sequence: stateRevision + 1,
      type: "spotlight.updated",
      payload: {
        schemaVersion: 3,
        kind: "room.invalidated",
        stateRevision: stateRevision + 1,
        roomRevision: durableRevision,
      },
    });
  });

  it("supports Spotlight follow membership, requests, and presenter-approved handoff", async () => {
    const { room } = await seededRoom();
    await upgradeMembership(room.id, "p_spectator");
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      command: createTextCommand("spotlight-agent-work"),
    });

    const started = await updateSpotlight({
      roomId: room.id,
      participantId: "p_owner",
      action: "start",
      target: "agent",
    });
    expect(started.spotlight).toMatchObject({
      presenterId: "p_owner",
      target: "agent",
      followingParticipantIds: ["p_owner"],
      autoFollowAt: START.getTime() + 5_000,
    });

    const joined = await updateSpotlight({
      roomId: room.id,
      participantId: "p_spectator",
      action: "join",
    });
    expect(joined.spotlight?.followingParticipantIds).toEqual(["p_owner", "p_spectator"]);

    const requested = await updateSpotlight({
      roomId: room.id,
      participantId: "p_spectator",
      action: "request",
      target: "human",
    });
    expect(requested.spotlight?.handoffRequest).toMatchObject({
      requesterId: "p_spectator",
      target: "human",
    });

    const handedOff = await updateSpotlight({
      roomId: room.id,
      participantId: "p_owner",
      action: "handoff",
    });
    expect(handedOff.spotlight).toMatchObject({
      presenterId: "p_spectator",
      target: "human",
      followingParticipantIds: ["p_spectator"],
      handoffRequest: null,
    });
  });

  it("attributes WebMCP Spotlight actions to the agent and activates it atomically", async () => {
    const { room } = await seededRoom();
    const events: RoomEvent[] = [];
    const unsubscribe = subscribeToLocalRoomEvents((event) => events.push(event));

    const started = await updateSpotlight({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      action: "start",
      target: "agent",
    });
    unsubscribe();

    expect(started.participants.p_owner).toMatchObject({
      agentActive: true,
      connected: true,
      agent: { lastSeenAt: START.getTime() },
    });
    expect(started.spotlight).toMatchObject({ presenterId: "p_owner", target: "agent" });
    expect(events.at(-1)).toMatchObject({
      type: "spotlight.updated",
      actor: { participantId: "p_owner", kind: "agent" },
    });

    await expectDomainError(
      updateSpotlight({
        roomId: room.id,
        participantId: "p_spectator",
        actorKind: "agent",
        action: "join",
      }),
      "FORBIDDEN",
    );
  });

  it("does not expose an expired lease in an authorized room snapshot", async () => {
    const { room } = await seededRoom();
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("expiring-note"),
    });
    await runLeaseAction({
      action: "acquire",
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      objectId: "expiring-note",
      expectedRevision: 1,
      operation: "move",
    });

    vi.setSystemTime(new Date(START.getTime() + LEASE_DURATION_MS));

    expect((await readAuthorizedRoom(room.id, "p_owner")).leases).toEqual({});
  });

  it("persists private mutation records atomically and exposes concise authorized activity summaries", async () => {
    const { store, room } = await seededRoom();
    const events: RoomEvent[] = [];
    const unsubscribe = subscribeToLocalRoomEvents((event) => events.push(event));
    const created = await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("review-note", "Original"),
      metadata: { intent: "Seed the review", summary: "Created the review note" },
    });
    const updated = await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      command: {
        type: "update",
        objectId: "review-note",
        expectedRevision: 1,
        operation: "edit",
        patch: { content: "Agent edit" },
      },
      metadata: { intent: "Clarify the note", summary: "Updated review copy" },
    });
    if (updated.outcome !== "applied") throw new Error("Expected a live mutation.");
    unsubscribe();

    expect(created.activity).toMatchObject({ action: "canvas.create", intent: "Seed the review" });
    expect(updated.activity).toMatchObject({
      action: "canvas.update",
      actor: { participantId: "p_owner", kind: "agent" },
      objectGuards: { "review-note": { state: "present", revision: 2 } },
    });
    expect(updated.activity).not.toHaveProperty("objectChanges");
    const privateRecord = await store.getActivity(room.id, updated.activity.id);
    expect(privateRecord?.objectChanges[0]).toMatchObject({
      objectId: "review-note",
      before: { content: "Original", revision: 1 },
      after: { content: "Agent edit", revision: 2 },
    });

    const spectatorPage = await listRoomActivities({
      roomId: room.id,
      participantId: "p_spectator",
      actorKind: "agent",
      objectId: "review-note",
    });
    expect(spectatorPage.activities).toEqual([updated.activity]);
    expect(await readRoomActivity({
      roomId: room.id,
      participantId: "p_spectator",
      activityId: updated.activity.id,
    })).toEqual(updated.activity);
    await expectDomainError(
      listRoomActivities({ roomId: room.id, participantId: "p_outsider" }),
      "FORBIDDEN",
    );
    expect(events.at(-1)?.payload).toMatchObject({ activity: updated.activity });
    expect(events.at(-1)?.payload).not.toHaveProperty("activity.objectChanges");
  });

  it("creates an attributed forward compensation while retaining immutable history", async () => {
    const { store, room } = await seededRoom();
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("revert-note", "Before"),
    });
    const target = await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      command: {
        type: "update",
        objectId: "revert-note",
        expectedRevision: 1,
        operation: "edit",
        patch: { content: "After" },
      },
    });
    if (target.outcome !== "applied") throw new Error("Expected a live mutation.");
    const objectExpectations = Object.entries(target.activity.objectGuards).map(([objectId, guard]) =>
      guard.state === "present"
        ? { objectId, state: "present" as const, expectedRevision: guard.revision }
        : { objectId, state: "absent" as const },
    ) satisfies RevertObjectExpectation[];
    const diagramExpectations = Object.entries(target.activity.diagramGuards).map(([diagramId, guard]) =>
      guard.state === "present"
        ? { diagramId, state: "present" as const, expectedRevision: guard.revision }
        : { diagramId, state: "absent" as const },
    ) satisfies RevertDiagramExpectation[];

    await expectDomainError(
      runActivityRevert({
        roomId: room.id,
        participantId: "p_spectator",
        actorKind: "human",
        revert: { activityId: target.activity.id, objectExpectations, diagramExpectations },
      }),
      "FORBIDDEN",
    );

    const reverted = await runActivityRevert({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      revert: {
        activityId: target.activity.id,
        objectExpectations,
        diagramExpectations,
        metadata: { intent: "Undo incorrect copy", summary: "Restored the earlier text" },
      },
    });
    if (reverted.outcome !== "applied") throw new Error("Expected a live revert.");

    expect(reverted.room.objects["revert-note"]).toMatchObject({
      content: "Before",
      revision: 3,
      lastEditedBy: { participantId: "p_owner", kind: "agent" },
    });
    expect(reverted.activity).toMatchObject({
      action: "canvas.revert",
      revertsActivityId: target.activity.id,
      intent: "Undo incorrect copy",
      objectGuards: { "revert-note": { state: "present", revision: 3 } },
    });
    expect(await store.getActivity(room.id, target.activity.id)).not.toBeNull();
    expect((await store.listActivities(room.id)).map((item) => item.id)).toEqual([
      reverted.activity.id,
      target.activity.id,
      expect.any(String),
    ]);

    const beforeRejectedRevert = await store.listActivities(room.id);
    await expectDomainError(
      runActivityRevert({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "agent",
        revert: { activityId: target.activity.id, objectExpectations, diagramExpectations },
      }),
      "REVISION_CONFLICT",
    );
    expect(await store.listActivities(room.id)).toEqual(beforeRejectedRevert);
  });

  it("bounds the immutable per-room log while retaining newest-first order", async () => {
    const { store, room } = await seededRoom();
    for (let index = 0; index <= 200; index += 1) {
      await runCanvasCommand({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "human",
        command: createTextCommand(`bounded-${index}`),
      });
    }

    const records = await store.listActivities(room.id);
    expect(records).toHaveLength(200);
    expect(records[0].affectedObjectIds).toEqual(["bounded-200"]);
    expect(records.at(-1)?.affectedObjectIds).toEqual(["bounded-1"]);
    expect(records.some((record) => record.affectedObjectIds.includes("bounded-0"))).toBe(false);
  }, 20_000);
});
