// @vitest-environment node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoomActivity } from "@/lib/domain/types";

import {
  ACTIVITY_HISTORY_ROOM_COMMIT_GUARD_LIMIT,
  activityHistoryAppendResultFromExec,
  activityHistoryKeys,
  assertMemoryActivityHistoryIntegrity,
  createActivityHistoryAppendCommand,
  createActivityHistoryRoomCommitCommand,
  createMemoryActivityHistoryState,
  executeActivityHistoryRoomCommit,
  MemoryActivityHistoryStore,
  parseActivityHistoryRoomCommitResult,
  prepareActivityHistoryEntry,
  queueActivityHistoryAppend,
  RedisActivityHistoryStore,
  serializeActivityHistoryCounter,
  type ActivityHistoryLimits,
} from "./activity-history-store";

function activity(input: {
  id: string;
  roomId?: string;
  roomRevision?: number;
  occurredAt?: number;
  padding?: number;
}): RoomActivity {
  const roomId = input.roomId ?? "room_alpha";
  const roomRevision = input.roomRevision ?? 1;
  return {
    id: input.id,
    roomId,
    roomRevision,
    occurredAt: input.occurredAt ?? roomRevision * 1_000,
    actor: {
      participantId: "participant_owner",
      displayName: "Owner",
      color: "blue",
      kind: "agent",
    },
    action: "canvas.update",
    label: `Updated note ${"x".repeat(input.padding ?? 0)}`,
    intent: "Keep the board legible",
    summary: "Changed one semantic note",
    affectedObjectIds: ["object_note"],
    affectedDiagramIds: [],
    affectedBounds: { x: 10, y: 20, width: 100, height: 60 },
    objectChanges: [
      {
        objectId: "object_note",
        mode: "direct",
        before: null,
        after: null,
      },
    ],
    diagramChanges: [],
    objectGuards: { object_note: { state: "absent" } },
    diagramGuards: {},
    revertsActivityId: null,
  };
}

function limitsFor(entries: RoomActivity[], input: {
  roomEntries?: number;
  deploymentEntries?: number;
  count?: number;
}): ActivityHistoryLimits {
  const prepared = entries.map((item) => prepareActivityHistoryEntry(item));
  const largest = Math.max(...prepared.map((item) => item.entryBytes));
  return {
    incomingBytes: largest,
    roomRetainedBytes: largest * (input.roomEntries ?? entries.length),
    deploymentRetainedBytes: largest * (input.deploymentEntries ?? entries.length),
    roomEntryCount: input.count ?? 200,
  };
}

describe("MemoryActivityHistoryStore", () => {
  it("keeps compact list metadata separate from direct private revert detail", async () => {
    const store = new MemoryActivityHistoryStore();
    const record = activity({ id: "activity_001" });

    await store.appendActivity(record);

    const summaries = await store.listActivitySummaries(record.roomId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: record.id, label: record.label });
    expect(summaries[0]).not.toHaveProperty("objectChanges");
    expect(summaries[0]).not.toHaveProperty("diagramChanges");
    expect(await store.getActivity(record.roomId, record.id)).toEqual(record);
    expect(await store.getActivity(record.roomId, "activity_missing")).toBeNull();
  });

  it("evicts oldest room entries by bytes, then enforces the secondary count cap", async () => {
    const records = [1, 2, 3].map((revision) =>
      activity({ id: `activity_00${revision}`, roomRevision: revision }),
    );
    const byteStore = new MemoryActivityHistoryStore(
      undefined,
      limitsFor(records, { roomEntries: 2, deploymentEntries: 6 }),
    );
    await Promise.all(records.slice(0, 2).map((record) => byteStore.appendActivity(record)));
    const result = await byteStore.appendActivity(records[2]);
    expect(result).toMatchObject({ status: "stored", evictedCount: 1 });
    expect((await byteStore.listActivitySummaries("room_alpha", { limit: 10 })).map(({ id }) => id))
      .toEqual(["activity_003", "activity_002"]);
    expect(await byteStore.getActivity("room_alpha", "activity_001")).toBeNull();

    const countStore = new MemoryActivityHistoryStore(
      undefined,
      limitsFor(records, { roomEntries: 6, deploymentEntries: 6, count: 2 }),
    );
    for (const record of records) await countStore.appendActivity(record);
    expect((await countStore.listActivitySummaries("room_alpha", { limit: 10 })).map(({ id }) => id))
      .toEqual(["activity_003", "activity_002"]);
  });

  it("evicts the deployment's oldest entry while updating its source room counter", async () => {
    const records = [
      activity({ id: "activity_001", roomId: "room_alpha", roomRevision: 1, occurredAt: 1_000 }),
      activity({ id: "activity_002", roomId: "room_bravo", roomRevision: 1, occurredAt: 2_000 }),
      activity({ id: "activity_003", roomId: "room_alpha", roomRevision: 2, occurredAt: 3_000 }),
    ];
    const store = new MemoryActivityHistoryStore(
      undefined,
      limitsFor(records, { roomEntries: 2, deploymentEntries: 2 }),
    );
    for (const record of records) await store.appendActivity(record);

    expect(await store.getActivity("room_alpha", "activity_001")).toBeNull();
    expect((await store.listActivitySummaries("room_alpha", { limit: 10 })).map(({ id }) => id))
      .toEqual(["activity_003"]);
    expect((await store.listActivitySummaries("room_bravo", { limit: 10 })).map(({ id }) => id))
      .toEqual(["activity_002"]);
    assertMemoryActivityHistoryIntegrity(store.state);
  });

  it("replays an identical append without double accounting and rejects ID reuse", async () => {
    const store = new MemoryActivityHistoryStore();
    const record = activity({ id: "activity_replay" });
    const first = await store.appendActivity(record);
    const second = await store.appendActivity(structuredClone(record));

    expect(first.status).toBe("stored");
    expect(second).toEqual({ ...first, status: "replayed", evictedCount: 0 });
    expect(store.state.entries.size).toBe(1);
    await expect(store.appendActivity({ ...record, label: "Different mutation" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("fails closed on corrupt counters or metadata without changing retained history", async () => {
    const counterState = createMemoryActivityHistoryState();
    const counterStore = new MemoryActivityHistoryStore(counterState);
    await counterStore.appendActivity(activity({ id: "activity_001" }));
    counterState.globalCounter.bytes = Number.NaN;
    await expect(counterStore.appendActivity(activity({ id: "activity_002", roomRevision: 2 })))
      .rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    expect(counterState.entries.size).toBe(1);

    const metadataState = createMemoryActivityHistoryState();
    const metadataStore = new MemoryActivityHistoryStore(metadataState);
    await metadataStore.appendActivity(activity({ id: "activity_003" }));
    metadataState.entries.values().next().value!.metadataJson = "{broken";
    await expect(metadataStore.appendActivity(activity({ id: "activity_004", roomRevision: 2 })))
      .rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    expect(metadataState.entries.size).toBe(1);
  });
});

describe("queued activity append command", () => {
  it("queues EVAL without executing eagerly and validates its exact EXEC result slot", () => {
    const command = createActivityHistoryAppendCommand(activity({ id: "activity_queue" }));
    const transaction = { eval: vi.fn().mockReturnThis() };

    queueActivityHistoryAppend(transaction as never, command);

    expect(transaction.eval).toHaveBeenCalledWith(
      command.script,
      command.keys.length,
      ...command.keys,
      ...command.arguments,
    );
    expect(activityHistoryAppendResultFromExec(
      [[null, "OK"], [null, ["stored", "0", "100", "200"]]],
      1,
    )).toEqual({ status: "stored", evictedCount: 0, roomBytes: 100, deploymentBytes: 200 });
    expect(() => activityHistoryAppendResultFromExec(
      [[null, ["corrupt", "counter/index mismatch"]]],
      0,
    )).toThrow(expect.objectContaining({ code: "MUTATION_OUTCOME_UNKNOWN" }));
    expect(() => activityHistoryAppendResultFromExec(
      [[new Error("EXEC command failed"), null]],
      0,
    )).toThrow(expect.objectContaining({ code: "MUTATION_OUTCOME_UNKNOWN" }));
  });

  it("prepares a digest-CAS commit without duplicating expected plane values", () => {
    const expectedDocument = JSON.stringify({ roomRevision: 7, title: "Expected marker" });
    const nextDocument = JSON.stringify({ roomRevision: 8, title: "Changed marker" });
    const command = createActivityHistoryRoomCommitCommand(
      activity({ id: "activity_commit", roomRevision: 8 }),
      {
        planeKeys: {
          document: "document-key",
          awareness: "awareness-key",
          coordination: "coordination-key",
        },
        expectedPlanes: {
          document: expectedDocument,
          awareness: JSON.stringify({ participants: {} }),
          coordination: JSON.stringify({ stateRevision: 7 }),
        },
        changedPlanes: { document: nextDocument },
        event: {
          streamKey: "events-key",
          roomId: "room_alpha",
          encoded: JSON.stringify({ schemaVersion: 3, kind: "room.invalidated" }),
        },
      },
    );

    expect(command.arguments).not.toContain(expectedDocument);
    expect(command.arguments).toContain(nextDocument);
    expect(command.requestBytes).toBeLessThan(8 * 1024 * 1024);
    expect(parseActivityHistoryRoomCommitResult(["revision_conflict"]))
      .toEqual({ status: "revision_conflict" });
    expect(parseActivityHistoryRoomCommitResult(["commit_replayed", "encoded-receipt"]))
      .toEqual({ status: "replayed", receipt: "encoded-receipt" });
  });

  it("serializes bounded exact guards through the fake Redis command seam", async () => {
    const guardValue = JSON.stringify({ state: "reserved", bytes: 1_024 });
    const command = createActivityHistoryRoomCommitCommand(
      activity({ id: "activity_guard_fake", roomRevision: 2 }),
      {
        planeKeys: {
          document: "document-guard-fake",
          awareness: "awareness-guard-fake",
          coordination: "coordination-guard-fake",
        },
        expectedPlanes: {
          document: JSON.stringify({ roomRevision: 1 }),
          awareness: JSON.stringify({ participants: {} }),
          coordination: JSON.stringify({ stateRevision: 1 }),
        },
        changedPlanes: { document: JSON.stringify({ roomRevision: 2 }) },
        event: {
          streamKey: "events-guard-fake",
          roomId: "room_alpha",
          encoded: JSON.stringify({ schemaVersion: 3, kind: "room.invalidated" }),
        },
        guards: [
          { key: "blob-registration-present", expectedValue: guardValue },
          { key: "blob-registration-absent", expectedValue: null },
        ],
      },
    );
    const redis = {
      eval: vi.fn(async () => ["commit_stored", "0", "500", "900"]),
    } as unknown as Redis;

    await expect(executeActivityHistoryRoomCommit(redis, command)).resolves.toEqual({
      status: "stored",
      evictedCount: 0,
      roomBytes: 500,
      deploymentBytes: 900,
    });
    expect(command.keys.slice(-2)).toEqual([
      "blob-registration-present",
      "blob-registration-absent",
    ]);
    expect(command.arguments.slice(-5)).toEqual(["2", "1", guardValue, "0", ""]);
    expect(vi.mocked(redis.eval)).toHaveBeenCalledTimes(1);

    const maximumGuards = Array.from(
      { length: ACTIVITY_HISTORY_ROOM_COMMIT_GUARD_LIMIT },
      (_, index) => ({ key: `maximum-guard-${index}`, expectedValue: null }),
    );
    const maximumCommand = createActivityHistoryRoomCommitCommand(
      activity({ id: "activity_maximum_guards", roomRevision: 2 }),
      {
        planeKeys: {
          document: "document-maximum",
          awareness: "awareness-maximum",
          coordination: "coordination-maximum",
        },
        expectedPlanes: { document: null, awareness: null, coordination: null },
        changedPlanes: { document: JSON.stringify({ roomRevision: 2 }) },
        event: {
          streamKey: "events-maximum",
          roomId: "room_alpha",
          encoded: JSON.stringify({ schemaVersion: 3, kind: "room.invalidated" }),
        },
        guards: maximumGuards,
      },
    );
    expect(maximumCommand.keys.slice(-ACTIVITY_HISTORY_ROOM_COMMIT_GUARD_LIMIT))
      .toEqual(maximumGuards.map(({ key }) => key));
    expect(maximumCommand.requestBytes).toBeLessThan(8 * 1024 * 1024);

    expect(() => createActivityHistoryRoomCommitCommand(
      activity({ id: "activity_too_many_guards", roomRevision: 2 }),
      {
        planeKeys: {
          document: "document-too-many",
          awareness: "awareness-too-many",
          coordination: "coordination-too-many",
        },
        expectedPlanes: { document: null, awareness: null, coordination: null },
        changedPlanes: { document: JSON.stringify({ roomRevision: 2 }) },
        event: {
          streamKey: "events-too-many",
          roomId: "room_alpha",
          encoded: JSON.stringify({ schemaVersion: 3, kind: "room.invalidated" }),
        },
        guards: Array.from(
          { length: ACTIVITY_HISTORY_ROOM_COMMIT_GUARD_LIMIT + 1 },
          (_, index) => ({ key: `guard-${index}`, expectedValue: null }),
        ),
      },
    )).toThrow(expect.objectContaining({ code: "INVALID_OPERATION" }));
  });
});

const redisServerAvailable = spawnSync("redis-server", ["--version"], {
  stdio: "ignore",
}).status === 0;
const runRedisLuaTests =
  redisServerAvailable && process.env.JAZZBOARD_RUN_REDIS_LUA_TESTS === "1";

describe.runIf(runRedisLuaTests)("RedisActivityHistoryStore Lua persistence", () => {
  let server: ChildProcess;
  let redis: Redis;
  let directory: string;

  beforeAll(async () => {
    // Keep the Unix-domain socket below macOS' 104-byte path ceiling.
    directory = mkdtempSync(join("/tmp", "jbah-"));
    const socket = join(directory, "redis.sock");
    server = spawn("redis-server", [
      "--port", "0",
      "--save", "",
      "--appendonly", "no",
      "--unixsocket", socket,
      "--unixsocketperm", "700",
    ], { stdio: "ignore" });
    const deadline = Date.now() + 5_000;
    while (!existsSync(socket) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!existsSync(socket)) throw new Error("Test Redis socket did not start.");
    redis = new Redis({ path: socket, maxRetriesPerRequest: 1 });
    await redis.ping();
  });

  afterAll(async () => {
    await redis?.quit().catch(() => undefined);
    server?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!server || server.exitCode !== null) return resolve();
      server.once("exit", () => resolve());
      setTimeout(resolve, 1_000);
    });
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  it("runs one atomic Lua append with room-first and deployment-wide oldest eviction", async () => {
    const records = [
      activity({ id: "activity_001", roomId: "room_alpha", roomRevision: 1, occurredAt: 1_000 }),
      activity({ id: "activity_002", roomId: "room_alpha", roomRevision: 2, occurredAt: 2_000 }),
      activity({ id: "activity_003", roomId: "room_alpha", roomRevision: 3, occurredAt: 3_000 }),
      activity({ id: "activity_004", roomId: "room_bravo", roomRevision: 1, occurredAt: 4_000 }),
    ];
    const roomLimits = limitsFor(records, { roomEntries: 2, deploymentEntries: 2 });
    const store = new RedisActivityHistoryStore(redis, roomLimits);
    for (const record of records.slice(0, 3)) await store.appendActivity(record);
    expect(await store.getActivity("room_alpha", "activity_001")).toBeNull();
    expect((await store.listActivitySummaries("room_alpha", { limit: 10 })).map(({ id }) => id))
      .toEqual(["activity_003", "activity_002"]);

    await store.appendActivity(records[3]);
    expect((await store.listActivitySummaries("room_alpha", { limit: 10 })).map(({ id }) => id))
      .toEqual(["activity_003"]);
    expect((await store.listActivitySummaries("room_bravo", { limit: 10 })).map(({ id }) => id))
      .toEqual(["activity_004"]);
    expect(JSON.parse((await redis.get(activityHistoryKeys.globalCounter))!)).toMatchObject({ count: 2 });
  });

  it("uses direct detail keys, compact summary reads, and an idempotent append", async () => {
    const store = new RedisActivityHistoryStore(redis);
    const record = activity({ id: "activity_direct", padding: 256 });
    expect((await store.appendActivity(record)).status).toBe("stored");
    expect((await store.appendActivity(structuredClone(record))).status).toBe("replayed");
    expect(await redis.zcard(activityHistoryKeys.roomIndex(record.roomId))).toBe(1);

    const detail = await store.getActivity(record.roomId, record.id);
    const summaries = await store.listActivitySummaries(record.roomId);
    expect(detail?.objectChanges).toEqual(record.objectChanges);
    expect(summaries[0]).not.toHaveProperty("objectChanges");
    expect(await redis.get(activityHistoryKeys.detail(record.roomId, record.id))).not.toBeNull();
    expect(await redis.get(activityHistoryKeys.summary(record.roomId, record.id))).not.toContain("objectChanges");
  });

  it("atomically CAS-commits changed planes, event, receipt, and history, then replays", async () => {
    const planeKeys = {
      document: "jazzboard:room:v3:document:room_alpha",
      awareness: "jazzboard:room:v3:awareness:room_alpha",
      coordination: "jazzboard:room:v3:coordination:room_alpha",
    };
    const expectedPlanes = {
      document: JSON.stringify({ id: "room_alpha", roomRevision: 4, title: "Before" }),
      awareness: JSON.stringify({ participants: { owner: { connected: true } } }),
      coordination: JSON.stringify({ roomRevision: 4, stateRevision: 4, leases: {} }),
    };
    await redis.mset(
      planeKeys.document, expectedPlanes.document,
      planeKeys.awareness, expectedPlanes.awareness,
      planeKeys.coordination, expectedPlanes.coordination,
    );
    const nextDocument = JSON.stringify({ id: "room_alpha", roomRevision: 5, title: "After" });
    const nextCoordination = JSON.stringify({ roomRevision: 5, stateRevision: 5, leases: {} });
    const receiptKey = "jazzboard:idempotency:activity-commit-001";
    const receipt = JSON.stringify({ v: 1, outcome: "room_mutation", committedRoomRevision: 5 });
    const streamKey = "jazzboard:events:test-activity-commit";
    const record = activity({ id: "activity_atomic", roomRevision: 5, occurredAt: 5_000 });
    const command = createActivityHistoryRoomCommitCommand(record, {
      planeKeys,
      expectedPlanes,
      changedPlanes: { document: nextDocument, coordination: nextCoordination },
      event: {
        streamKey,
        roomId: record.roomId,
        encoded: JSON.stringify({ schemaVersion: 3, kind: "room.invalidated", roomRevision: 5 }),
      },
      receipt: { key: receiptKey, encoded: receipt, ttlSeconds: 86_400 },
    });

    expect(await executeActivityHistoryRoomCommit(redis, command)).toMatchObject({
      status: "stored",
      evictedCount: 0,
    });
    expect(await redis.get(planeKeys.document)).toBe(nextDocument);
    expect(await redis.get(planeKeys.awareness)).toBe(expectedPlanes.awareness);
    expect(await redis.get(planeKeys.coordination)).toBe(nextCoordination);
    expect(await redis.get(receiptKey)).toBe(receipt);
    expect(await redis.xlen(streamKey)).toBe(1);
    expect(await new RedisActivityHistoryStore(redis).getActivity(record.roomId, record.id))
      .toEqual(record);

    expect(await executeActivityHistoryRoomCommit(redis, command)).toEqual({
      status: "replayed",
      receipt,
    });
    expect(await redis.xlen(streamKey)).toBe(1);
    expect(await redis.zcard(activityHistoryKeys.roomIndex(record.roomId))).toBe(1);

    const losingRecord = activity({
      id: "activity_atomic_loser",
      roomRevision: 5,
      occurredAt: 5_001,
    });
    const losingCommand = createActivityHistoryRoomCommitCommand(losingRecord, {
      planeKeys,
      expectedPlanes,
      changedPlanes: { document: nextDocument, coordination: nextCoordination },
      event: {
        streamKey,
        roomId: losingRecord.roomId,
        encoded: JSON.stringify({ schemaVersion: 3, kind: "room.invalidated", roomRevision: 5 }),
      },
      receipt: {
        key: receiptKey,
        encoded: JSON.stringify({ v: 1, outcome: "different_generation", committedRoomRevision: 5 }),
        ttlSeconds: 86_400,
      },
    });
    expect(await executeActivityHistoryRoomCommit(redis, losingCommand)).toEqual({
      status: "replayed",
      receipt,
    });
    expect(await redis.get(activityHistoryKeys.detail(losingRecord.roomId, losingRecord.id))).toBeNull();
    expect(await redis.xlen(streamKey)).toBe(1);
  });

  it("returns revision_conflict before writing any room or history key", async () => {
    const planeKeys = {
      document: "document:room_alpha",
      awareness: "awareness:room_alpha",
      coordination: "coordination:room_alpha",
    };
    const actualDocument = JSON.stringify({ roomRevision: 9 });
    await redis.mset(
      planeKeys.document, actualDocument,
      planeKeys.awareness, JSON.stringify({ participants: {} }),
      planeKeys.coordination, JSON.stringify({ stateRevision: 9 }),
    );
    const record = activity({ id: "activity_conflict", roomRevision: 10 });
    const receiptKey = "receipt:activity-conflict";
    const streamKey = "events:activity-conflict";
    const command = createActivityHistoryRoomCommitCommand(record, {
      planeKeys,
      expectedPlanes: {
        document: JSON.stringify({ roomRevision: 8 }),
        awareness: JSON.stringify({ participants: {} }),
        coordination: JSON.stringify({ stateRevision: 9 }),
      },
      changedPlanes: { document: JSON.stringify({ roomRevision: 10 }) },
      event: {
        streamKey,
        roomId: record.roomId,
        encoded: JSON.stringify({ schemaVersion: 3, kind: "room.invalidated" }),
      },
      receipt: {
        key: receiptKey,
        encoded: JSON.stringify({ v: 1, committedRoomRevision: 10 }),
        ttlSeconds: 60,
      },
    });

    expect(await executeActivityHistoryRoomCommit(redis, command))
      .toEqual({ status: "revision_conflict" });
    expect(await redis.get(planeKeys.document)).toBe(actualDocument);
    expect(await redis.get(activityHistoryKeys.detail(record.roomId, record.id))).toBeNull();
    expect(await redis.get(receiptKey)).toBeNull();
    expect(await redis.xlen(streamKey)).toBe(0);
  });

  it("commits with unchanged exact guards and conflicts all-or-nothing after a guard changes", async () => {
    const planeKeys = {
      document: "document:exact-guard",
      awareness: "awareness:exact-guard",
      coordination: "coordination:exact-guard",
    };
    const expectedPlanes = {
      document: JSON.stringify({ roomRevision: 1 }),
      awareness: JSON.stringify({ participants: {} }),
      coordination: JSON.stringify({ stateRevision: 1 }),
    };
    const guardKey = "blob-registration:exact-guard";
    const guardValue = JSON.stringify({ state: "reserved", owner: "participant_owner" });
    const boundaryGuards = [
      { key: guardKey, expectedValue: guardValue },
      ...Array.from(
        { length: ACTIVITY_HISTORY_ROOM_COMMIT_GUARD_LIMIT - 1 },
        (_, index) => ({ key: `blob-registration:absent-${index}`, expectedValue: null }),
      ),
    ];
    await redis.mset(
      planeKeys.document, expectedPlanes.document,
      planeKeys.awareness, expectedPlanes.awareness,
      planeKeys.coordination, expectedPlanes.coordination,
      guardKey, guardValue,
    );

    const successRecord = activity({ id: "activity_guard_success", roomRevision: 2 });
    const successDocument = JSON.stringify({ roomRevision: 2 });
    const successStream = "events:exact-guard-success";
    const successCommand = createActivityHistoryRoomCommitCommand(successRecord, {
      planeKeys,
      expectedPlanes,
      changedPlanes: { document: successDocument },
      event: {
        streamKey: successStream,
        roomId: successRecord.roomId,
        encoded: JSON.stringify({ schemaVersion: 3, kind: "room.invalidated" }),
      },
      guards: boundaryGuards,
    });
    expect(await executeActivityHistoryRoomCommit(redis, successCommand)).toMatchObject({
      status: "stored",
    });
    expect(await redis.get(planeKeys.document)).toBe(successDocument);
    expect(await redis.xlen(successStream)).toBe(1);

    await redis.flushdb();
    await redis.mset(
      planeKeys.document, expectedPlanes.document,
      planeKeys.awareness, expectedPlanes.awareness,
      planeKeys.coordination, expectedPlanes.coordination,
      guardKey, guardValue,
    );
    const conflictRecord = activity({ id: "activity_guard_conflict", roomRevision: 2 });
    const conflictDocument = JSON.stringify({ roomRevision: 2, changed: true });
    const conflictStream = "events:exact-guard-conflict";
    const receiptKey = "receipt:exact-guard-conflict";
    const conflictCommand = createActivityHistoryRoomCommitCommand(conflictRecord, {
      planeKeys,
      expectedPlanes,
      changedPlanes: { document: conflictDocument },
      event: {
        streamKey: conflictStream,
        roomId: conflictRecord.roomId,
        encoded: JSON.stringify({ schemaVersion: 3, kind: "room.invalidated" }),
      },
      receipt: {
        key: receiptKey,
        encoded: JSON.stringify({ v: 1, committedRoomRevision: 2 }),
        ttlSeconds: 60,
      },
      guards: [{ key: guardKey, expectedValue: guardValue }],
    });
    await redis.set(guardKey, JSON.stringify({ state: "committed" }));

    expect(await executeActivityHistoryRoomCommit(redis, conflictCommand))
      .toEqual({ status: "revision_conflict" });
    expect(await redis.get(planeKeys.document)).toBe(expectedPlanes.document);
    expect(await redis.get(activityHistoryKeys.detail(conflictRecord.roomId, conflictRecord.id)))
      .toBeNull();
    expect(await redis.xlen(conflictStream)).toBe(0);
    expect(await redis.get(receiptKey)).toBeNull();
  });

  it("fails corrupt history preflight without committing planes, event, or receipt", async () => {
    const seed = activity({ id: "activity_seed", roomRevision: 1 });
    const historyStore = new RedisActivityHistoryStore(redis);
    await historyStore.appendActivity(seed);
    await redis.set(
      activityHistoryKeys.roomCounter(seed.roomId),
      JSON.stringify({ v: 1, bytes: "corrupt", count: 1 }),
    );

    const planeKeys = {
      document: "document:corrupt-test",
      awareness: "awareness:corrupt-test",
      coordination: "coordination:corrupt-test",
    };
    const expectedPlanes = {
      document: JSON.stringify({ roomRevision: 1 }),
      awareness: JSON.stringify({ participants: {} }),
      coordination: JSON.stringify({ stateRevision: 1 }),
    };
    await redis.mset(
      planeKeys.document, expectedPlanes.document,
      planeKeys.awareness, expectedPlanes.awareness,
      planeKeys.coordination, expectedPlanes.coordination,
    );
    const nextDocument = JSON.stringify({ roomRevision: 2 });
    const record = activity({ id: "activity_blocked", roomRevision: 2 });
    const receiptKey = "receipt:corrupt-test";
    const streamKey = "events:corrupt-test";
    const command = createActivityHistoryRoomCommitCommand(record, {
      planeKeys,
      expectedPlanes,
      changedPlanes: { document: nextDocument },
      event: {
        streamKey,
        roomId: record.roomId,
        encoded: JSON.stringify({ schemaVersion: 3, kind: "room.invalidated" }),
      },
      receipt: {
        key: receiptKey,
        encoded: JSON.stringify({ v: 1, committedRoomRevision: 2 }),
        ttlSeconds: 60,
      },
    });

    await expect(executeActivityHistoryRoomCommit(redis, command))
      .rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    expect(await redis.get(planeKeys.document)).toBe(expectedPlanes.document);
    expect(await redis.get(activityHistoryKeys.detail(record.roomId, record.id))).toBeNull();
    expect(await redis.get(receiptKey)).toBeNull();
    expect(await redis.xlen(streamKey)).toBe(0);
  });

  it("preflights corrupt counters and eviction metadata before any write", async () => {
    const first = activity({ id: "activity_001", roomRevision: 1 });
    const second = activity({ id: "activity_002", roomRevision: 2 });
    const limits = limitsFor([first, second], { roomEntries: 1, deploymentEntries: 4 });
    const store = new RedisActivityHistoryStore(redis, limits);
    await store.appendActivity(first);

    await redis.set(
      activityHistoryKeys.roomCounter(first.roomId),
      JSON.stringify({ v: 1, bytes: "broken", count: 1 }),
    );
    await expect(store.appendActivity(second)).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    expect(await redis.get(activityHistoryKeys.detail(second.roomId, second.id))).toBeNull();
    expect(await redis.get(activityHistoryKeys.detail(first.roomId, first.id))).not.toBeNull();

    const prepared = prepareActivityHistoryEntry(first, limits);
    await redis.set(
      activityHistoryKeys.roomCounter(first.roomId),
      serializeActivityHistoryCounter({ bytes: prepared.entryBytes, count: 1 }),
    );
    await redis.set(activityHistoryKeys.metadata(first.roomId, first.id), "{broken");
    await expect(store.appendActivity(second)).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    expect(await redis.get(activityHistoryKeys.detail(second.roomId, second.id))).toBeNull();
    expect(await redis.get(activityHistoryKeys.detail(first.roomId, first.id))).not.toBeNull();
  });

  it("migrates a legacy full-record list in bounded idempotent resumable steps", async () => {
    const records = [1, 2, 3].map((revision) =>
      activity({ id: `activity_00${revision}`, roomRevision: revision, occurredAt: revision * 1_000 }),
    );
    // Legacy LPUSH storage is newest first.
    await redis.rpush(
      activityHistoryKeys.legacy("room_alpha"),
      ...[...records].reverse().map((record) => JSON.stringify(record)),
    );
    const store = new RedisActivityHistoryStore(redis);
    const lrange = vi.spyOn(redis, "lrange");
    const lindex = vi.spyOn(redis, "lindex");
    const evalCommand = vi.spyOn(redis, "eval");

    expect(await store.migrateLegacyActivities("room_alpha", { maxRecords: 1 }))
      .toMatchObject({ status: "in_progress", migratedCount: 1, nextIndex: 1 });
    expect(await store.migrateLegacyActivities("room_alpha", { maxRecords: 1 }))
      .toMatchObject({ status: "in_progress", migratedCount: 1, nextIndex: 0 });
    expect(await store.migrateLegacyActivities("room_alpha", { maxRecords: 2 }))
      .toMatchObject({ status: "complete", migratedCount: 1, nextIndex: -1 });
    expect(await store.migrateLegacyActivities("room_alpha", { maxRecords: 1 }))
      .toMatchObject({ status: "complete", migratedCount: 0, nextIndex: -1 });

    expect(lrange).not.toHaveBeenCalled();
    expect(lindex).toHaveBeenCalled();
    expect(evalCommand.mock.calls.every((call) =>
      call.every((argument) => typeof argument !== "string" || Buffer.byteLength(argument) < 8 * 1024 * 1024),
    )).toBe(true);
    expect(await redis.exists(activityHistoryKeys.legacy("room_alpha"))).toBe(0);
    expect((await store.listActivitySummaries("room_alpha", { limit: 10 })).map(({ id }) => id))
      .toEqual(["activity_003", "activity_002", "activity_001"]);
    expect(await redis.zcard(activityHistoryKeys.roomIndex("room_alpha"))).toBe(3);
  });
});
