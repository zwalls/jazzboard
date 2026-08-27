// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Redis } from "ioredis";

import { DomainError } from "@/lib/domain/errors";
import type { ActorRef } from "@/lib/domain/types";
import {
  JAZZBOARD_ARTIFACT_FORMAT,
  JAZZBOARD_ARTIFACT_SCHEMA_URL,
  JAZZBOARD_ARTIFACT_VERSION,
  type JazzboardSemanticArtifactV1,
} from "@/lib/interchange/types";

import {
  MAX_CREATOR_SNAPSHOT_BYTES,
  MAX_CREATOR_SNAPSHOTS,
  MAX_DEPLOYMENT_SNAPSHOT_BYTES,
  MAX_DEPLOYMENT_SNAPSHOTS,
  MAX_ROOM_SNAPSHOT_BYTES,
  MAX_ROOM_SNAPSHOTS,
  MAX_SNAPSHOT_RECORD_BYTES,
  resetSnapshotStoreForTests,
  snapshotIdFromMutationGeneration,
  SnapshotStore,
} from "./snapshot-store";
import { CREATE_AND_PRUNE_REDIS_SNAPSHOTS_SCRIPT } from "./snapshot-retention-scripts";
import { createMutationContext, runWithMutationContext } from "./mutation-context";

const START = new Date("2026-08-26T12:00:00.000Z");
const actor: ActorRef = {
  participantId: "p_owner",
  displayName: "Owner",
  color: "#5965e8",
  kind: "human",
};

function artifact(title = "Checkout architecture"): JazzboardSemanticArtifactV1 {
  return {
    $schema: JAZZBOARD_ARTIFACT_SCHEMA_URL,
    format: JAZZBOARD_ARTIFACT_FORMAT,
    version: JAZZBOARD_ARTIFACT_VERSION,
    kind: "snapshot",
    title,
    description: "A privacy-safe frozen board.",
    source: { roomRevision: 4, diagramId: null, diagramRevision: null },
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    objects: [],
    diagrams: [],
    warnings: [],
  };
}

function artifactWithPayload(payloadBytes: number): JazzboardSemanticArtifactV1 {
  return {
    ...artifact("Capacity fixture"),
    description: "x".repeat(payloadBytes),
  };
}

function input(tokenHash: string, overrides: Record<string, unknown> = {}) {
  return {
    tokenHash,
    sourceRoomId: "room_private",
    sourceRoomRevision: 4,
    creatorParticipantId: "p_owner",
    creator: actor,
    scope: { kind: "room" as const },
    title: "Checkout architecture",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    artifact: artifact(),
    ...overrides,
  };
}

function snapshotCreateContext(
  idempotencyKey: string,
  title = "Retry-safe snapshot",
) {
  return createMutationContext({
    request: new Request("https://jazzboard.test/api/rooms/room_private/snapshots", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
    }),
    participantId: "p_owner",
    roomId: "room_private",
    operation: "room.snapshot.create",
    actorKind: "human",
    parsedBody: {
      expectedRoomRevision: 4,
      scope: { kind: "room" },
      title,
      expiresInHours: 1,
    },
  });
}

function idempotentSnapshotInput(
  context: ReturnType<typeof snapshotCreateContext>,
  tokenHash: string,
  overrides: Record<string, unknown> = {},
) {
  const createdAt = typeof overrides.createdAt === "number"
    ? overrides.createdAt
    : Date.now();
  return input(tokenHash, {
    ...overrides,
    id: snapshotIdFromMutationGeneration(
      context.idempotency!.scopedKeyHash,
      createdAt,
    ),
    idempotencyRequestDigest: context.idempotency!.requestDigest,
    createdAt,
  });
}

async function createIdempotentSnapshot(
  store: SnapshotStore,
  context: ReturnType<typeof snapshotCreateContext>,
  tokenHash: string,
  overrides: Record<string, unknown> = {},
) {
  return runWithMutationContext(context, () =>
    store.create(idempotentSnapshotInput(context, tokenHash, overrides)),
  );
}

type SnapshotMetadataFixture = {
  id: string;
  tokenHash: string;
  sourceRoomId: string;
  creatorParticipantId: string;
  createdAt: number;
  expiresAt: number;
  recordBytes: number;
};

class RedisSnapshotFake {
  readonly strings = new Map<string, { value: string; expiresAt: number }>();
  readonly sortedSets = new Map<string, Map<string, number>>();
  readonly expirations = new Map<string, number>();
  lastEvalScript = "";
  mgetCalls = 0;

  async eval(script: string, numberOfKeys: number, ...parameters: string[]): Promise<unknown> {
    this.lastEvalScript = script;
    if (script.includes("jazzboard:snapshot-create:v3")) {
      if (numberOfKeys !== 10) throw new Error("Expected ten snapshot creation keys.");
      const [
        recordKey,
        tokenLookupKey,
        metadataKey,
        creatorIndexKey,
        roomIndexKey,
        globalIndexKey,
        creatorBytesKey,
        roomBytesKey,
        globalBytesKey,
        receiptKey,
        ...args
      ] = parameters;
      const [
        recordJson,
        metadataJson,
        recordBytesText,
        ttlText,
        snapshotId,
        createdAtText,
        nowText,
        sourceRoomId,
        creatorParticipantId,
        maxRecordText,
        maxCreatorBytesText,
        maxRoomBytesText,
        maxGlobalBytesText,
        maxCountText,
        snapshotKeyPrefix,
        tokenKeyPrefix,
        metadataKeyPrefix,
        creatorIndexPrefix,
        roomIndexPrefix,
        creatorBytesPrefix,
        roomBytesPrefix,
        receiptJson,
        receiptTtlText,
        maxRoomCountText,
        maxGlobalCountText,
      ] = args;
      if (receiptJson) {
        const existingReceipt = this.currentString(receiptKey);
        if (existingReceipt) return ["replay", existingReceipt];
      }
      if (
        this.currentString(recordKey) ||
        this.currentString(tokenLookupKey) ||
        this.currentString(metadataKey)
      ) return ["orphan"];
      const recordBytes = Number(recordBytesText);
      if (Buffer.byteLength(recordJson, "utf8") !== recordBytes || recordBytes > Number(maxRecordText)) {
        return ["record_too_large"];
      }
      const metadata = JSON.parse(metadataJson) as SnapshotMetadataFixture;
      if (
        metadata.id !== snapshotId ||
        metadata.sourceRoomId !== sourceRoomId ||
        metadata.creatorParticipantId !== creatorParticipantId ||
        metadata.recordBytes !== recordBytes
      ) return ["integrity_error"];

      for (const indexedId of this.ascending(globalIndexKey)) {
        const encoded = this.currentString(`${metadataKeyPrefix}${indexedId}`);
        if (!encoded) return ["integrity_error"];
        const indexed = JSON.parse(encoded) as SnapshotMetadataFixture;
        const tokenTarget = this.currentString(`${tokenKeyPrefix}${indexed.tokenHash}`);
        if (
          indexed.expiresAt <= Number(nowText) ||
          !this.currentString(`${snapshotKeyPrefix}${indexed.id}`) ||
          !tokenTarget
        ) this.removeMetadata(indexed, {
          globalIndexKey,
          globalBytesKey,
          snapshotKeyPrefix,
          tokenKeyPrefix,
          metadataKeyPrefix,
          creatorIndexPrefix,
          roomIndexPrefix,
          creatorBytesPrefix,
          roomBytesPrefix,
        });
      }

      const evictOldest = (
        ids: () => string[],
        over: () => boolean,
      ) => {
        while (over()) {
          const victimId = ids()[0];
          if (!victimId) return false;
          const encoded = this.currentString(`${metadataKeyPrefix}${victimId}`);
          if (!encoded) return false;
          this.removeMetadata(JSON.parse(encoded) as SnapshotMetadataFixture, {
            globalIndexKey,
            globalBytesKey,
            snapshotKeyPrefix,
            tokenKeyPrefix,
            metadataKeyPrefix,
            creatorIndexPrefix,
            roomIndexPrefix,
            creatorBytesPrefix,
            roomBytesPrefix,
          });
        }
        return true;
      };
      if (!evictOldest(
        () => this.ascending(creatorIndexKey),
        () => this.ascending(creatorIndexKey).length + 1 > Number(maxCountText) ||
          this.counter(creatorBytesKey) + recordBytes > Number(maxCreatorBytesText),
      )) return ["integrity_error"];
      if (!evictOldest(
        () => this.ascending(roomIndexKey),
        () => this.ascending(roomIndexKey).length + 1 > Number(maxRoomCountText) ||
          this.counter(roomBytesKey) + recordBytes > Number(maxRoomBytesText),
      )) return ["integrity_error"];
      if (!evictOldest(
        () => this.ascending(globalIndexKey),
        () => this.ascending(globalIndexKey).length + 1 > Number(maxGlobalCountText) ||
          this.counter(globalBytesKey) + recordBytes > Number(maxGlobalBytesText),
      )) return ["integrity_error"];

      const expiresAt = Date.now() + Number(ttlText) * 1_000;
      this.strings.set(recordKey, { value: recordJson, expiresAt });
      this.strings.set(tokenLookupKey, { value: snapshotId, expiresAt });
      this.strings.set(metadataKey, { value: metadataJson, expiresAt: Number.POSITIVE_INFINITY });
      this.addSorted(creatorIndexKey, snapshotId, Number(createdAtText));
      this.addSorted(roomIndexKey, snapshotId, Number(createdAtText));
      this.addSorted(globalIndexKey, snapshotId, Number(createdAtText));
      this.setCounter(creatorBytesKey, this.counter(creatorBytesKey) + recordBytes);
      this.setCounter(roomBytesKey, this.counter(roomBytesKey) + recordBytes);
      this.setCounter(globalBytesKey, this.counter(globalBytesKey) + recordBytes);
      if (receiptJson) {
        this.strings.set(receiptKey, {
          value: receiptJson,
          expiresAt: Date.now() + Number(receiptTtlText) * 1_000,
        });
      }
      return ["created", receiptJson, metadataJson];
    }

    if (script.includes("jazzboard:snapshot-list:v2")) {
      if (numberOfKeys !== 6) throw new Error("Expected six snapshot list keys.");
      const [creatorIndexKey, , , , globalIndexKey, globalBytesKey, roomId, participantId, nowText, , , snapshotKeyPrefix, tokenKeyPrefix, metadataKeyPrefix, roomIndexPrefix] = parameters;
      const result: string[] = ["ok"];
      for (const snapshotId of this.ascending(creatorIndexKey).reverse()) {
        const encoded = this.currentString(`${metadataKeyPrefix}${snapshotId}`);
        if (!encoded) return ["integrity_error"];
        const metadata = JSON.parse(encoded) as SnapshotMetadataFixture;
        if (metadata.sourceRoomId !== roomId || metadata.creatorParticipantId !== participantId) {
          return ["integrity_error"];
        }
        const tokenTarget = this.currentString(`${tokenKeyPrefix}${metadata.tokenHash}`);
        if (metadata.expiresAt <= Number(nowText) || !this.currentString(`${snapshotKeyPrefix}${snapshotId}`) || !tokenTarget) {
          this.removeMetadata(metadata, {
            globalIndexKey,
            globalBytesKey,
            snapshotKeyPrefix,
            tokenKeyPrefix,
            metadataKeyPrefix,
            creatorIndexPrefix: "jazzboard:snapshots-by-creator:",
            roomIndexPrefix,
            creatorBytesPrefix: "jazzboard:snapshot-bytes-by-creator:",
            roomBytesPrefix: "jazzboard:snapshot-bytes-by-room:",
          });
        } else {
          result.push(encoded);
        }
      }
      return result;
    }

    if (script.includes("jazzboard:snapshot-read:v2")) {
      if (numberOfKeys !== 3) throw new Error("Expected three snapshot read keys.");
      const [tokenLookupKey, , , tokenHash, nowText, snapshotKeyPrefix, metadataKeyPrefix] = parameters;
      const snapshotId = this.currentString(tokenLookupKey);
      if (!snapshotId) return ["not_found"];
      const encodedMetadata = this.currentString(`${metadataKeyPrefix}${snapshotId}`);
      if (!encodedMetadata) return ["integrity_error"];
      const metadata = JSON.parse(encodedMetadata) as SnapshotMetadataFixture;
      const recordJson = this.currentString(`${snapshotKeyPrefix}${snapshotId}`);
      if (metadata.tokenHash !== tokenHash) return ["integrity_error"];
      if (!recordJson || metadata.expiresAt <= Number(nowText)) return ["not_found"];
      return ["found", recordJson];
    }

    if (script.includes("jazzboard:snapshot-revoke:v2")) {
      if (numberOfKeys !== 9) throw new Error("Expected nine snapshot revoke keys.");
      const [receiptKey, recordKey, metadataKey, , , globalIndexKey, , , globalBytesKey, receiptJson, receiptTtlText, roomId, participantId, snapshotId, tokenKeyPrefix, nowText] = parameters;
      if (receiptJson) {
        const existingReceipt = this.currentString(receiptKey);
        if (existingReceipt) return ["replay", existingReceipt];
      }
      const encodedMetadata = this.currentString(metadataKey);
      const recordJson = this.currentString(recordKey);
      if (!encodedMetadata) return recordJson ? ["integrity_error"] : ["not_found"];
      const metadata = JSON.parse(encodedMetadata) as SnapshotMetadataFixture;
      if (metadata.id !== snapshotId) return ["integrity_error"];
      if (metadata.sourceRoomId !== roomId || metadata.creatorParticipantId !== participantId) return ["not_found"];
      const live = Boolean(recordJson) && metadata.expiresAt > Number(nowText);
      if (live && receiptJson) {
        this.strings.set(receiptKey, {
          value: receiptJson,
          expiresAt: Date.now() + Number(receiptTtlText) * 1_000,
        });
      }
      this.removeMetadata(metadata, {
        globalIndexKey,
        globalBytesKey,
        snapshotKeyPrefix: "jazzboard:snapshot:",
        tokenKeyPrefix,
        metadataKeyPrefix: "jazzboard:snapshot-metadata:",
        creatorIndexPrefix: "jazzboard:snapshots-by-creator:",
        roomIndexPrefix: "jazzboard:snapshots-by-room:",
        creatorBytesPrefix: "jazzboard:snapshot-bytes-by-creator:",
        roomBytesPrefix: "jazzboard:snapshot-bytes-by-room:",
      });
      return live ? ["revoked", receiptJson] : ["not_found"];
    }
    throw new Error("Unexpected snapshot Lua script.");
  }

  async get(key: string): Promise<string | null> {
    return this.currentString(key);
  }

  private currentString(key: string): string | null {
    const entry = this.strings.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.strings.delete(key);
      return null;
    }
    return entry.value;
  }

  async mget(keys: string[]): Promise<Array<string | null>> {
    this.mgetCalls += 1;
    return Promise.all(keys.map((key) => this.get(key)));
  }

  async strlen(key: string): Promise<number> {
    return Buffer.byteLength(this.currentString(key) ?? "", "utf8");
  }

  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.ascending(key).reverse().slice(start, stop + 1);
  }

  private ascending(key: string): string[] {
    return [...(this.sortedSets.get(key) ?? new Map<string, number>()).entries()]
      .sort(([leftId, leftScore], [rightId, rightScore]) => {
        if (leftScore !== rightScore) return leftScore - rightScore;
        return leftId.localeCompare(rightId);
      })
      .map(([id]) => id);
  }

  private addSorted(key: string, id: string, score: number): void {
    const index = this.sortedSets.get(key) ?? new Map<string, number>();
    index.set(id, score);
    this.sortedSets.set(key, index);
  }

  private counter(key: string): number {
    return Number(this.currentString(key) ?? "0");
  }

  private setCounter(key: string, value: number): void {
    if (value <= 0) this.strings.delete(key);
    else this.strings.set(key, { value: value.toString(), expiresAt: Number.POSITIVE_INFINITY });
  }

  private removeMetadata(metadata: SnapshotMetadataFixture, keys: {
    globalIndexKey: string;
    globalBytesKey: string;
    snapshotKeyPrefix: string;
    tokenKeyPrefix: string;
    metadataKeyPrefix: string;
    creatorIndexPrefix: string;
    roomIndexPrefix: string;
    creatorBytesPrefix: string;
    roomBytesPrefix: string;
  }): void {
    this.strings.delete(`${keys.snapshotKeyPrefix}${metadata.id}`);
    this.strings.delete(`${keys.tokenKeyPrefix}${metadata.tokenHash}`);
    this.strings.delete(`${keys.metadataKeyPrefix}${metadata.id}`);
    this.sortedSets.get(`${keys.creatorIndexPrefix}${metadata.sourceRoomId}:${metadata.creatorParticipantId}`)?.delete(metadata.id);
    this.sortedSets.get(`${keys.roomIndexPrefix}${metadata.sourceRoomId}`)?.delete(metadata.id);
    this.sortedSets.get(keys.globalIndexKey)?.delete(metadata.id);
    const creatorBytesKey = `${keys.creatorBytesPrefix}${metadata.sourceRoomId}:${metadata.creatorParticipantId}`;
    const roomBytesKey = `${keys.roomBytesPrefix}${metadata.sourceRoomId}`;
    this.setCounter(creatorBytesKey, this.counter(creatorBytesKey) - metadata.recordBytes);
    this.setCounter(roomBytesKey, this.counter(roomBytesKey) - metadata.recordBytes);
    this.setCounter(keys.globalBytesKey, this.counter(keys.globalBytesKey) - metadata.recordBytes);
  }
}

describe("SnapshotStore", () => {
  let store: SnapshotStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    store = resetSnapshotStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("indexes only the token hash and returns defensive copies", async () => {
    const created = await store.create(input("hash-only-token-index"));

    expect(created.id).toMatch(/^snapshot_[0-9a-f-]{36}$/i);
    expect(JSON.stringify(globalThis.__jazzboardSnapshotState)).not.toContain("plain-share-token");
    const firstRead = await store.getByTokenHash("hash-only-token-index");
    expect(firstRead).toEqual(created);

    if (!firstRead) throw new Error("Expected snapshot artifact.");
    firstRead.artifact.title = "Mutated caller copy";
    await expect(store.getByTokenHash("hash-only-token-index")).resolves.toMatchObject({
      artifact: { title: "Checkout architecture" },
    });
  });

  it("lists and revokes snapshots only for the exact creator and room", async () => {
    const created = await store.create(input("creator-token-hash"));

    await expect(store.listForCreator("room_private", "p_owner")).resolves.toEqual([
      expect.objectContaining({ id: created.id, title: "Checkout architecture" }),
    ]);
    await expect(store.listForCreator("room_private", "p_other")).resolves.toEqual([]);
    await expect(store.revoke("room_private", "p_other", created.id)).resolves.toBe(false);
    await expect(store.getByTokenHash("creator-token-hash")).resolves.toMatchObject({ id: created.id });

    await expect(store.revoke("room_private", "p_owner", created.id)).resolves.toBe(true);
    await expect(store.getByTokenHash("creator-token-hash")).resolves.toBeNull();
  });

  it("purges expired records and keeps creator history bounded", async () => {
    await store.create(input("already-expiring", { expiresAt: Date.now() + 1_000 }));
    vi.advanceTimersByTime(1_000);
    await expect(store.getByTokenHash("already-expiring")).resolves.toBeNull();

    for (let index = 0; index < 51; index += 1) {
      vi.advanceTimersByTime(1);
      await store.create(
        input(`hash-${index}`, {
          title: `Snapshot ${index}`,
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          artifact: artifact(`Snapshot ${index}`),
        }),
      );
    }

    const listed = await store.listForCreator("room_private", "p_owner");
    expect(listed).toHaveLength(MAX_CREATOR_SNAPSHOTS);
    expect(listed[0].title).toBe("Snapshot 50");
    expect(listed.some((snapshot) => snapshot.title === "Snapshot 0")).toBe(false);
    await expect(store.getByTokenHash("hash-0")).resolves.toBeNull();
  });

  it("rejects an encoded artifact above 3.5 MiB without any partial memory or Redis write", async () => {
    const oversized = input("oversized-token", {
      artifact: artifactWithPayload(MAX_SNAPSHOT_RECORD_BYTES),
    });
    await expect(store.create(oversized)).rejects.toMatchObject({
      code: "ROOM_CAPACITY_EXCEEDED",
    });
    expect(globalThis.__jazzboardSnapshotState?.records.size ?? 0).toBe(0);
    expect(globalThis.__jazzboardSnapshotState?.deploymentBytes ?? 0).toBe(0);

    const redis = new RedisSnapshotFake();
    const redisStore = new SnapshotStore(redis as unknown as Redis);
    await expect(redisStore.create(oversized)).rejects.toMatchObject({
      code: "ROOM_CAPACITY_EXCEEDED",
    });
    expect([...redis.strings.keys()].some((key) => key.startsWith("jazzboard:snapshot:"))).toBe(false);
    expect(redis.sortedSets.get("jazzboard:snapshots:global")?.size ?? 0).toBe(0);
  });

  it("evicts oldest memory artifacts to enforce creator, room, and deployment byte ceilings", async () => {
    const payloadBytes = 3 * 1024 * 1024;
    for (let index = 0; index < 3; index += 1) {
      await store.create(input(`creator-budget-${index}`, {
        createdAt: Date.now(),
        artifact: artifactWithPayload(payloadBytes),
      }));
      vi.advanceTimersByTime(1);
    }
    expect(globalThis.__jazzboardSnapshotState?.creatorBytes.get("room_private:p_owner")).toBeLessThanOrEqual(
      MAX_CREATOR_SNAPSHOT_BYTES,
    );
    await expect(store.getByTokenHash("creator-budget-0")).resolves.toBeNull();

    store = resetSnapshotStoreForTests();
    for (let index = 0; index < 6; index += 1) {
      await store.create(input(`room-budget-${index}`, {
        creatorParticipantId: `p_room_${index}`,
        createdAt: Date.now(),
        artifact: artifactWithPayload(payloadBytes),
      }));
      vi.advanceTimersByTime(1);
    }
    expect(globalThis.__jazzboardSnapshotState?.roomBytes.get("room_private")).toBeLessThanOrEqual(
      MAX_ROOM_SNAPSHOT_BYTES,
    );
    await expect(store.getByTokenHash("room-budget-0")).resolves.toBeNull();

    store = resetSnapshotStoreForTests();
    for (let index = 0; index < 17; index += 1) {
      await store.create(input(`deployment-budget-${index}`, {
        sourceRoomId: `room_${index}`,
        creatorParticipantId: `p_${index}`,
        createdAt: Date.now(),
        artifact: artifactWithPayload(payloadBytes),
      }));
      vi.advanceTimersByTime(1);
    }
    expect(globalThis.__jazzboardSnapshotState?.deploymentBytes).toBeLessThanOrEqual(
      MAX_DEPLOYMENT_SNAPSHOT_BYTES,
    );
    await expect(store.getByTokenHash("deployment-budget-0")).resolves.toBeNull();
  });

  it("evicts oldest artifacts to enforce room and deployment count ceilings", async () => {
    for (let index = 0; index <= MAX_ROOM_SNAPSHOTS; index += 1) {
      await store.create(input(`room-count-${index}`, {
        creatorParticipantId: `p_room_count_${index}`,
        createdAt: Date.now(),
        title: `Room count ${index}`,
      }));
      vi.advanceTimersByTime(1);
    }
    expect(globalThis.__jazzboardSnapshotState?.roomIndexes.get("room_private")?.size).toBe(
      MAX_ROOM_SNAPSHOTS,
    );
    await expect(store.getByTokenHash("room-count-0")).resolves.toBeNull();

    store = resetSnapshotStoreForTests();
    for (let index = 0; index <= MAX_DEPLOYMENT_SNAPSHOTS; index += 1) {
      await store.create(input(`deployment-count-${index}`, {
        sourceRoomId: `room_count_${index}`,
        creatorParticipantId: `p_deployment_count_${index}`,
        createdAt: Date.now(),
        title: `Deployment count ${index}`,
      }));
      vi.advanceTimersByTime(1);
    }
    expect(globalThis.__jazzboardSnapshotState?.globalIndex.size).toBe(
      MAX_DEPLOYMENT_SNAPSHOTS,
    );
    await expect(store.getByTokenHash("deployment-count-0")).resolves.toBeNull();
  });

  it("keeps Redis global eviction scans statically bounded and enforces the global count cap", async () => {
    expect(CREATE_AND_PRUNE_REDIS_SNAPSHOTS_SCRIPT).not.toMatch(
      /ZRANGE[^\n]*KEYS\[6\][^\n]*0,\s*-1/,
    );
    expect(CREATE_AND_PRUNE_REDIS_SNAPSHOTS_SCRIPT).toContain(
      'redis.call("ZRANGE", KEYS[6], 0, global_scan_limit - 1)',
    );

    const redis = new RedisSnapshotFake();
    const redisStore = new SnapshotStore(redis as unknown as Redis);
    for (let index = 0; index <= MAX_DEPLOYMENT_SNAPSHOTS; index += 1) {
      await redisStore.create(input(`redis-deployment-count-${index}`, {
        sourceRoomId: `redis_room_count_${index}`,
        creatorParticipantId: `redis_p_count_${index}`,
        createdAt: Date.now(),
        title: `Redis deployment count ${index}`,
      }));
      vi.advanceTimersByTime(1);
    }

    expect(redis.sortedSets.get("jazzboard:snapshots:global")?.size).toBe(
      MAX_DEPLOYMENT_SNAPSHOTS,
    );
    await expect(redisStore.getByTokenHash("redis-deployment-count-0")).resolves.toBeNull();
  });

  it("lists Redis history from compact metadata and cleans expired bytes atomically", async () => {
    const redis = new RedisSnapshotFake();
    const redisStore = new SnapshotStore(redis as unknown as Redis);
    const expired = await redisStore.create(input("redis-expiring-summary", {
      expiresAt: Date.now() + 1_000,
    }));
    vi.advanceTimersByTime(1);
    const live = await redisStore.create(input("redis-live-summary", {
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }));
    const liveMetadata = JSON.parse(
      redis.strings.get(`jazzboard:snapshot-metadata:${live.id}`)!.value,
    ) as SnapshotMetadataFixture;

    vi.advanceTimersByTime(1_000);
    const listed = await redisStore.listForCreator("room_private", "p_owner");
    expect(listed).toEqual([expect.objectContaining({ id: live.id })]);
    expect(redis.mgetCalls).toBe(0);
    expect(redis.lastEvalScript).toContain("jazzboard:snapshot-list:v2");
    expect(redis.strings.has(`jazzboard:snapshot-metadata:${expired.id}`)).toBe(false);
    expect(Number(redis.strings.get("jazzboard:snapshot-bytes-by-creator:room_private:p_owner")?.value)).toBe(
      liveMetadata.recordBytes,
    );

    await expect(redisStore.revoke("room_private", "p_owner", live.id)).resolves.toBe(true);
    expect(redis.strings.has("jazzboard:snapshot-bytes-by-creator:room_private:p_owner")).toBe(false);
    expect(redis.strings.has("jazzboard:snapshot-bytes-by-room:room_private")).toBe(false);
    expect(redis.strings.has("jazzboard:snapshot-bytes:global")).toBe(false);
    expect(redis.sortedSets.get("jazzboard:snapshots:global")?.size ?? 0).toBe(0);
  });

  it("fails closed without deleting an artifact when compact Redis metadata is missing", async () => {
    const redis = new RedisSnapshotFake();
    const redisStore = new SnapshotStore(redis as unknown as Redis);
    const created = await redisStore.create(input("redis-integrity-token"));
    redis.strings.delete(`jazzboard:snapshot-metadata:${created.id}`);

    await expect(redisStore.listForCreator("room_private", "p_owner")).rejects.toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
    });
    expect(redis.strings.has(`jazzboard:snapshot:${created.id}`)).toBe(true);
    expect(redis.strings.has("jazzboard:snapshot-token:redis-integrity-token")).toBe(true);
  });

  it("keeps a memory create tombstone after expiry and distinguishes conflicting reuse", async () => {
    const context = snapshotCreateContext("snapshot-expiry-0001");
    await createIdempotentSnapshot(store, context, "expired-idempotent-token", {
      expiresAt: Date.now() + 1_000,
    });
    vi.advanceTimersByTime(1_000);

    await expect(
      createIdempotentSnapshot(store, snapshotCreateContext("snapshot-expiry-0001"), "expired-idempotent-token", {
        expiresAt: Date.now() + 1_000,
      }),
    ).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    const conflicting = snapshotCreateContext("snapshot-expiry-0001", "Different request");
    await expect(
      createIdempotentSnapshot(store, conflicting, "different-token", {
        title: "Different request",
        artifact: artifact("Different request"),
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("keeps a memory create tombstone after revocation", async () => {
    const context = snapshotCreateContext("snapshot-recreate-0001");
    const created = await createIdempotentSnapshot(store, context, "revoked-idempotent-token");
    const revokeContext = createMutationContext({
      request: new Request("https://jazzboard.test/api/rooms/room_private/snapshots", {
        method: "DELETE",
        headers: { "idempotency-key": "snapshot-revoke-safe-0001" },
      }),
      participantId: "p_owner",
      roomId: "room_private",
      operation: "room.snapshot.revoke",
      actorKind: "human",
      parsedBody: { snapshotId: created.id },
    });
    await expect(
      runWithMutationContext(revokeContext, () =>
        store.revoke("room_private", "p_owner", created.id),
      ),
    ).resolves.toBe(true);

    await expect(
      createIdempotentSnapshot(
        store,
        snapshotCreateContext("snapshot-recreate-0001"),
        "revoked-idempotent-token",
      ),
    ).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    await expect(store.getByTokenHash("revoked-idempotent-token")).resolves.toBeNull();
  });

  it("keeps a memory create tombstone after retention eviction", async () => {
    const context = snapshotCreateContext("snapshot-evicted-0001");
    await createIdempotentSnapshot(store, context, "evicted-idempotent-token");
    for (let index = 0; index < 50; index += 1) {
      vi.advanceTimersByTime(1);
      await store.create(input(`newer-memory-token-${index}`, {
        title: `Newer memory snapshot ${index}`,
        createdAt: Date.now(),
      }));
    }
    await expect(store.getByTokenHash("evicted-idempotent-token")).resolves.toBeNull();

    await expect(
      createIdempotentSnapshot(
        store,
        snapshotCreateContext("snapshot-evicted-0001"),
        "evicted-idempotent-token",
      ),
    ).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
  });

  it("returns one receipt-winning generation to concurrent memory first attempts", async () => {
    const firstContext = snapshotCreateContext("memory-snapshot-concurrent-0001");
    const secondContext = snapshotCreateContext("memory-snapshot-concurrent-0001");
    const firstCreatedAt = Date.now();
    const secondCreatedAt = firstCreatedAt + 1;

    const [first, second] = await Promise.all([
      createIdempotentSnapshot(store, firstContext, "memory-winning-token-hash", {
        createdAt: firstCreatedAt,
      }),
      createIdempotentSnapshot(store, secondContext, "memory-losing-token-hash", {
        createdAt: secondCreatedAt,
      }),
    ]);

    expect(first.id).toBe(
      snapshotIdFromMutationGeneration(
        firstContext.idempotency!.scopedKeyHash,
        firstCreatedAt,
      ),
    );
    expect(second).toEqual(first);
    await expect(store.getByTokenHash("memory-losing-token-hash")).resolves.toBeNull();
  });

  it("atomically removes evicted Redis records and token mappings without crossing creator indexes", async () => {
    const redis = new RedisSnapshotFake();
    const redisStore = new SnapshotStore(redis as unknown as Redis);
    const otherCreator = await redisStore.create(
      input("other-hash", {
        creatorParticipantId: "p_other",
        title: "Other creator snapshot",
      }),
    );

    let oldestId = "";
    for (let index = 0; index < 51; index += 1) {
      vi.advanceTimersByTime(1);
      const created = await redisStore.create(
        input(`redis-hash-${index}`, {
          title: `Redis snapshot ${index}`,
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          artifact: artifact(`Redis snapshot ${index}`),
        }),
      );
      if (index === 0) oldestId = created.id;
    }

    const listed = await redisStore.listForCreator("room_private", "p_owner");
    expect(listed).toHaveLength(MAX_CREATOR_SNAPSHOTS);
    expect(listed[0].title).toBe("Redis snapshot 50");
    await expect(redisStore.getByTokenHash("redis-hash-0")).resolves.toBeNull();
    expect(redis.strings.has(`jazzboard:snapshot:${oldestId}`)).toBe(false);
    expect(redis.strings.has("jazzboard:snapshot-token:redis-hash-0")).toBe(false);

    await expect(redisStore.getByTokenHash("other-hash")).resolves.toMatchObject({
      id: otherCreator.id,
      creatorParticipantId: "p_other",
    });
    expect(Number(redis.strings.get("jazzboard:snapshot-bytes-by-creator:room_private:p_owner")?.value)).toBeGreaterThan(0);
    expect(redis.sortedSets.get("jazzboard:snapshots-by-creator:room_private:p_owner")?.size).toBe(
      MAX_CREATOR_SNAPSHOTS,
    );
  });

  it("keeps an atomic Redis creation receipt after expiry", async () => {
    const redis = new RedisSnapshotFake();
    const redisStore = new SnapshotStore(redis as unknown as Redis);
    const context = snapshotCreateContext("redis-snapshot-expiry-0001");
    await createIdempotentSnapshot(redisStore, context, "redis-expired-token", {
      expiresAt: Date.now() + 1_000,
    });
    vi.advanceTimersByTime(1_000);

    await expect(
      createIdempotentSnapshot(
        redisStore,
        snapshotCreateContext("redis-snapshot-expiry-0001"),
        "redis-expired-token",
        { expiresAt: Date.now() + 1_000 },
      ),
    ).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    expect(redis.lastEvalScript).toContain('return { "replay", existing_receipt }');
  });

  it("returns the receipt-winning Redis generation to concurrent first attempts", async () => {
    const redis = new RedisSnapshotFake();
    const redisStore = new SnapshotStore(redis as unknown as Redis);
    const firstContext = snapshotCreateContext("redis-snapshot-concurrent-0001");
    const secondContext = snapshotCreateContext("redis-snapshot-concurrent-0001");
    const firstCreatedAt = Date.now();
    const secondCreatedAt = firstCreatedAt + 1;

    const [first, second] = await Promise.all([
      createIdempotentSnapshot(redisStore, firstContext, "winning-token-hash", {
        createdAt: firstCreatedAt,
      }),
      createIdempotentSnapshot(redisStore, secondContext, "losing-token-hash", {
        createdAt: secondCreatedAt,
      }),
    ]);

    expect(first.id).toBe(
      snapshotIdFromMutationGeneration(
        firstContext.idempotency!.scopedKeyHash,
        firstCreatedAt,
      ),
    );
    expect(second).toEqual(first);
    expect(second.tokenHash).toBe("winning-token-hash");
    await expect(redisStore.getByTokenHash("losing-token-hash")).resolves.toBeNull();
    const winningMetadata = JSON.parse(
      redis.strings.get(`jazzboard:snapshot-metadata:${first.id}`)!.value,
    ) as SnapshotMetadataFixture;
    expect(Number(redis.strings.get("jazzboard:snapshot-bytes:global")?.value)).toBe(
      winningMetadata.recordBytes,
    );
    expect(redis.sortedSets.get("jazzboard:snapshots:global")?.size).toBe(1);
  });

  it("reports unavailable replay verification when snapshot metadata cannot be read", async () => {
    const redis = new RedisSnapshotFake();
    const redisStore = new SnapshotStore(redis as unknown as Redis);
    const firstContext = snapshotCreateContext("redis-snapshot-verify-0001");
    await createIdempotentSnapshot(
      redisStore,
      firstContext,
      "redis-snapshot-verify-token",
    );
    vi.spyOn(redis, "get").mockRejectedValue(new Error("verification transport unavailable"));

    await expect(
      createIdempotentSnapshot(
        redisStore,
        snapshotCreateContext("redis-snapshot-verify-0001"),
        "redis-snapshot-verify-token",
      ),
    ).rejects.toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
      details: { replayed: true, verificationUnavailable: true },
    });
  });

  it("reports an unproven outcome when the initial snapshot receipt cannot be read", async () => {
    const redis = new RedisSnapshotFake();
    const redisStore = new SnapshotStore(redis as unknown as Redis);
    const context = snapshotCreateContext("redis-snapshot-receipt-read-0001");
    vi.spyOn(redis, "get").mockRejectedValue(new Error("receipt transport unavailable"));

    await expect(runWithMutationContext(context, () =>
      redisStore.replayCreate(idempotentSnapshotInput(
        context,
        "redis-snapshot-receipt-read-token",
      )),
    )).rejects.toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
      details: { replayed: false, verificationUnavailable: true },
    });
  });

  it("creates a distinct Redis generation after the 24-hour receipt contract", async () => {
    const redis = new RedisSnapshotFake();
    const redisStore = new SnapshotStore(redis as unknown as Redis);
    const first = await createIdempotentSnapshot(
      redisStore,
      snapshotCreateContext("redis-snapshot-generation-0001"),
      "old-generation-token-hash",
    );

    vi.advanceTimersByTime(24 * 60 * 60 * 1_000 + 1);
    const second = await createIdempotentSnapshot(
      redisStore,
      snapshotCreateContext("redis-snapshot-generation-0001"),
      "new-generation-token-hash",
    );

    expect(second.id).not.toBe(first.id);
    await expect(redisStore.getByTokenHash("old-generation-token-hash")).resolves.toBeNull();
    await expect(redisStore.getByTokenHash("new-generation-token-hash")).resolves.toMatchObject({
      id: second.id,
    });
  });

  it("keeps an atomic Redis create tombstone after revocation", async () => {
    const redis = new RedisSnapshotFake();
    const redisStore = new SnapshotStore(redis as unknown as Redis);
    const context = snapshotCreateContext("redis-snapshot-recreate-0001");
    const created = await createIdempotentSnapshot(redisStore, context, "redis-revoked-token");
    const revokeContext = createMutationContext({
      request: new Request("https://jazzboard.test/api/rooms/room_private/snapshots", {
        method: "DELETE",
        headers: { "idempotency-key": "redis-revoke-safe-0001" },
      }),
      participantId: "p_owner",
      roomId: "room_private",
      operation: "room.snapshot.revoke",
      actorKind: "human",
      parsedBody: { snapshotId: created.id },
    });
    await expect(
      runWithMutationContext(revokeContext, () =>
        redisStore.revoke("room_private", "p_owner", created.id),
      ),
    ).resolves.toBe(true);

    await expect(
      createIdempotentSnapshot(
        redisStore,
        snapshotCreateContext("redis-snapshot-recreate-0001"),
        "redis-revoked-token",
      ),
    ).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    await expect(redisStore.getByTokenHash("redis-revoked-token")).resolves.toBeNull();
  });

  it("keeps an atomic Redis create tombstone after retention eviction", async () => {
    const redis = new RedisSnapshotFake();
    const redisStore = new SnapshotStore(redis as unknown as Redis);
    const context = snapshotCreateContext("redis-snapshot-evicted-0001");
    await createIdempotentSnapshot(redisStore, context, "redis-evicted-token");
    for (let index = 0; index < 50; index += 1) {
      vi.advanceTimersByTime(1);
      await redisStore.create(input(`newer-redis-token-${index}`, {
        title: `Newer Redis snapshot ${index}`,
        createdAt: Date.now(),
      }));
    }
    await expect(redisStore.getByTokenHash("redis-evicted-token")).resolves.toBeNull();

    await expect(
      createIdempotentSnapshot(
        redisStore,
        snapshotCreateContext("redis-snapshot-evicted-0001"),
        "redis-evicted-token",
      ),
    ).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
  });

  it("atomically rejects concurrent different-body revocations using one key", async () => {
    const redis = new RedisSnapshotFake();
    const redisStore = new SnapshotStore(redis as unknown as Redis);
    const first = await redisStore.create(input("first-revoke-hash"));
    const second = await redisStore.create(input("second-revoke-hash"));
    const context = (snapshotId: string) =>
      createMutationContext({
        request: new Request("https://jazzboard.test/api/snapshots", {
          method: "DELETE",
          headers: { "idempotency-key": "concurrent-revoke-0001" },
        }),
        participantId: "p_owner",
        roomId: "room_private",
        operation: "room.snapshot.revoke",
        actorKind: "human",
        parsedBody: { snapshotId },
      });

    const outcomes = await Promise.allSettled([
      runWithMutationContext(context(first.id), () =>
        redisStore.revoke("room_private", "p_owner", first.id),
      ),
      runWithMutationContext(context(second.id), () =>
        redisStore.revoke("room_private", "p_owner", second.id),
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining<Partial<DomainError>>({ code: "IDEMPOTENCY_CONFLICT" }),
    });
    const remaining = await redisStore.listForCreator("room_private", "p_owner");
    expect(remaining).toHaveLength(1);
  });
});
