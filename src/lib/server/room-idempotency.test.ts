// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/domain/errors";
import type { CanvasCommand } from "@/lib/domain/types";

import { createMutationContext, runWithMutationContext } from "./mutation-context";
import { listRoomActivities, runCanvasCommand } from "./room-service";
import { getRoomStore, subscribeToLocalRoomEvents } from "./room-store";
import { createReadonlySnapshot } from "./snapshot-service";
import { getSnapshotStore, resetSnapshotStoreForTests } from "./snapshot-store";

function command(content: string): CanvasCommand {
  return {
    type: "create",
    object: {
      id: "idempotent-note",
      kind: "text",
      x: 20,
      y: 30,
      width: 200,
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

function context(roomId: string, body: unknown) {
  return createMutationContext({
    request: new Request("https://jazzboard.test/api/commands", {
      method: "POST",
      headers: { "idempotency-key": "logical-command-0001" },
    }),
    participantId: "p_owner",
    roomId,
    operation: "canvas.command.human",
    actorKind: "human",
    parsedBody: body,
  });
}

describe("room mutation idempotency", () => {
  beforeEach(() => {
    vi.stubEnv("REDIS_URL", "");
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    resetSnapshotStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    vi.unstubAllEnvs();
  });

  it("records one commit and refuses to execute an ambiguous retry twice", async () => {
    const room = await getRoomStore().createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Idempotency",
    });
    const body = { command: command("Only once") };

    await runWithMutationContext(context(room.id, body), () =>
      runCanvasCommand({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "human",
        command: body.command,
      }),
    );

    await expect(
      runWithMutationContext(context(room.id, body), () =>
        runCanvasCommand({
          roomId: room.id,
          participantId: "p_owner",
          actorKind: "human",
          command: body.command,
        }),
      ),
    ).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });

    const authoritative = await getRoomStore().getRoom(room.id);
    expect(authoritative?.objects["idempotent-note"]).toMatchObject({ content: "Only once", revision: 1 });
    await expect(
      listRoomActivities({ roomId: room.id, participantId: "p_owner" }),
    ).resolves.toMatchObject({ activities: [{ affectedObjectIds: ["idempotent-note"] }] });
  });

  it("records the receipt before a throwing local event listener can surface a committed failure", async () => {
    const room = await getRoomStore().createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Publish ordering",
    });
    const body = { command: command("Committed before publish") };
    const unsubscribe = subscribeToLocalRoomEvents(() => {
      throw new Error("local listener failed");
    });

    await expect(runWithMutationContext(context(room.id, body), () =>
      runCanvasCommand({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "human",
        command: body.command,
      }),
    )).rejects.toThrow("local listener failed");
    unsubscribe();

    await expect(runWithMutationContext(context(room.id, body), () =>
      runCanvasCommand({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "human",
        command: body.command,
      }),
    )).rejects.toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
      details: { replayed: true },
    });
    expect((await getRoomStore().getRoom(room.id))?.objects["idempotent-note"]).toMatchObject({
      revision: 1,
    });
    await expect(listRoomActivities({
      roomId: room.id,
      participantId: "p_owner",
    })).resolves.toMatchObject({ activities: [expect.objectContaining({
      affectedObjectIds: ["idempotent-note"],
    })] });
  });

  it("replays room creation to the same deterministic room", async () => {
    const createContext = (title: string) => createMutationContext({
      request: new Request("https://jazzboard.test/api/rooms", {
        method: "POST",
        headers: { "idempotency-key": "room-create-0001" },
      }),
      participantId: "p_owner",
      operation: "room.create",
      actorKind: "human",
      parsedBody: { displayName: "Owner", title },
    });
    const create = (title: string) => runWithMutationContext(createContext(title), () =>
      getRoomStore().createRoom({ participantId: "p_owner", displayName: "Owner", title }),
    );

    const first = await create("Retry-safe room");
    const replay = await create("Retry-safe room");
    expect(replay).toEqual(first);
    expect(globalThis.__jazzboardLocalState?.rooms.size).toBe(1);
    expect(globalThis.__jazzboardLocalState?.codes.size).toBe(1);

    await expect(create("Different room")).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("converges concurrent memory first creates without allocating a second code", async () => {
    const createContext = () => createMutationContext({
      request: new Request("https://jazzboard.test/api/rooms", {
        method: "POST",
        headers: { "idempotency-key": "room-concurrent-0001" },
      }),
      participantId: "p_owner",
      operation: "room.create",
      actorKind: "human",
      parsedBody: { displayName: "Owner", title: "Concurrent room" },
    });
    const create = () => runWithMutationContext(createContext(), () =>
      getRoomStore().createRoom({
        participantId: "p_owner",
        displayName: "Owner",
        title: "Concurrent room",
      }),
    );

    const [first, second] = await Promise.all([create(), create()]);
    expect(second).toEqual(first);
    expect(globalThis.__jazzboardLocalState?.rooms.size).toBe(1);
    expect(globalThis.__jazzboardLocalState?.codes.size).toBe(1);
  });

  it("creates a distinct memory room generation after the 24-hour contract", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const createContext = () => createMutationContext({
      request: new Request("https://jazzboard.test/api/rooms", {
        method: "POST",
        headers: { "idempotency-key": "room-generation-0001" },
      }),
      participantId: "p_owner",
      operation: "room.create",
      actorKind: "human",
      parsedBody: { displayName: "Owner", title: "Generation room" },
    });
    const create = () => runWithMutationContext(createContext(), () =>
      getRoomStore().createRoom({
        participantId: "p_owner",
        displayName: "Owner",
        title: "Generation room",
      }),
    );

    const first = await create();
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000 + 1);
    const second = await create();

    expect(second.id).not.toBe(first.id);
    expect(second.code).not.toBe(first.code);
    expect(globalThis.__jazzboardLocalState?.rooms.size).toBe(2);
    expect(globalThis.__jazzboardLocalState?.codes.size).toBe(2);
    expect(globalThis.__jazzboardLocalState?.rooms.has(first.id)).toBe(true);
  });

  it("rejects reuse of one key for a different request digest", async () => {
    const room = await getRoomStore().createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Idempotency conflict",
    });
    const first = { command: command("First") };
    await runWithMutationContext(context(room.id, first), () =>
      runCanvasCommand({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "human",
        command: first.command,
      }),
    );

    const conflicting = { command: command("Different") };
    await expect(
      runWithMutationContext(context(room.id, conflicting), () =>
        runCanvasCommand({
          roomId: room.id,
          participantId: "p_owner",
          actorKind: "human",
          command: conflicting.command,
        }),
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<DomainError>>({ code: "IDEMPOTENCY_CONFLICT" }));
  });

  it("binds one participant-scoped key to the target room", async () => {
    const firstRoom = await getRoomStore().createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "First room",
    });
    const secondRoom = await getRoomStore().createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Second room",
    });
    const body = { command: command("Same request body") };

    await runWithMutationContext(context(firstRoom.id, body), () =>
      runCanvasCommand({
        roomId: firstRoom.id,
        participantId: "p_owner",
        actorKind: "human",
        command: body.command,
      }),
    );

    await expect(runWithMutationContext(context(secondRoom.id, body), () =>
      runCanvasCommand({
        roomId: secondRoom.id,
        participantId: "p_owner",
        actorKind: "human",
        command: body.command,
      }),
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await getRoomStore().getRoom(secondRoom.id))?.objects).toEqual({});
  });

  it("serializes concurrent process-local reuse of one key across rooms", async () => {
    const store = getRoomStore();
    const firstRoom = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Concurrent first room",
    });
    const secondRoom = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Concurrent second room",
    });
    const body = { command: command("Only one room") };
    const mutate = (roomId: string) => runWithMutationContext(context(roomId, body), () =>
      runCanvasCommand({
        roomId,
        participantId: "p_owner",
        actorKind: "human",
        command: body.command,
      }),
    );

    const outcomes = await Promise.allSettled([
      mutate(firstRoom.id),
      mutate(secondRoom.id),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
    });
    const committedRooms = await Promise.all([
      store.getRoom(firstRoom.id),
      store.getRoom(secondRoom.id),
    ]);
    expect(committedRooms.filter((room) => room?.objects["idempotent-note"])).toHaveLength(1);
  });

  it("shares one process-local receipt namespace across room and snapshot mutations", async () => {
    const store = getRoomStore();
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Cross-subsystem receipt",
    });
    const body = { command: command("Room contender") };
    const sharedKey = "cross-subsystem-0001";
    const roomContext = createMutationContext({
      request: new Request("https://jazzboard.test/api/commands", {
        method: "POST",
        headers: { "idempotency-key": sharedKey },
      }),
      participantId: "p_owner",
      roomId: room.id,
      operation: "canvas.command.human",
      actorKind: "human",
      parsedBody: body,
    });
    const snapshotBody = {
      expectedRoomRevision: room.roomRevision,
      scope: { kind: "room" as const },
      title: "Snapshot contender",
      expiresInHours: 1,
    };
    const snapshotContext = createMutationContext({
      request: new Request("https://jazzboard.test/api/snapshots", {
        method: "POST",
        headers: { "idempotency-key": sharedKey },
      }),
      participantId: "p_owner",
      roomId: room.id,
      operation: "room.snapshot.create",
      actorKind: "human",
      parsedBody: snapshotBody,
    });

    const outcomes = await Promise.allSettled([
      runWithMutationContext(roomContext, () => runCanvasCommand({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "human",
        command: body.command,
      })),
      runWithMutationContext(snapshotContext, () => createReadonlySnapshot({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "human",
        ...snapshotBody,
      })),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
    });
    const current = await store.getRoom(room.id);
    const snapshots = await getSnapshotStore().listForCreator(room.id, "p_owner");
    expect(Number(Boolean(current?.objects["idempotent-note"])) + snapshots.length).toBe(1);
  });

  it("fails closed when a live process-local mutation receipt is corrupt", async () => {
    const store = getRoomStore();
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Corrupt receipt",
    });
    const body = { command: command("Original") };
    await runWithMutationContext(context(room.id, body), () =>
      runCanvasCommand({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "human",
        command: body.command,
      }),
    );
    const receipt = [...globalThis.__jazzboardLocalState!.mutationReceipts.values()][0];
    receipt.encoded = "{not-valid-json";

    await expect(runWithMutationContext(context(room.id, body), () =>
      runCanvasCommand({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "human",
        command: body.command,
      }),
    )).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    expect((await store.getRoom(room.id))?.objects["idempotent-note"]).toMatchObject({
      content: "Original",
      revision: 1,
    });
  });

  it("does not infer a successful join from an unverified matching participant state", async () => {
    const store = getRoomStore();
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Join proof",
    });
    const join = {
      participantId: "p_guest",
      displayName: "Guest",
      code: room.code,
      role: "participant" as const,
    };
    await store.joinRoom(join);
    const transact = vi.spyOn(store, "transact").mockRejectedValueOnce(
      new DomainError(
        "MUTATION_OUTCOME_UNKNOWN",
        "The attempted join could not be verified.",
        { replayed: false, verificationUnavailable: true },
      ),
    );

    await expect(store.joinRoom(join)).rejects.toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
      details: { replayed: false, verificationUnavailable: true },
    });
    transact.mockRestore();
  });

  it("recovers a join only from a receipt-proven committed replay", async () => {
    const store = getRoomStore();
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Join replay proof",
    });
    const join = {
      participantId: "p_guest",
      displayName: "Guest",
      code: room.code,
      role: "spectator" as const,
    };
    const joined = await store.joinRoom(join);
    const transact = vi.spyOn(store, "transact").mockRejectedValueOnce(
      new DomainError(
        "MUTATION_OUTCOME_UNKNOWN",
        "The join committed and its receipt was verified.",
        { replayed: true, committedRoomRevision: joined.roomRevision },
      ),
    );

    await expect(store.joinRoom(join)).resolves.toMatchObject({
      id: room.id,
      participants: {
        p_guest: {
          displayName: "Guest",
          role: "spectator",
          connected: true,
        },
      },
    });
    transact.mockRestore();
  });
});
