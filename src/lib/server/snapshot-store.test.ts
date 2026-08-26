// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Redis } from "ioredis";

import type { ActorRef } from "@/lib/domain/types";
import {
  JAZZBOARD_ARTIFACT_FORMAT,
  JAZZBOARD_ARTIFACT_SCHEMA_URL,
  JAZZBOARD_ARTIFACT_VERSION,
  type JazzboardSemanticArtifactV1,
} from "@/lib/interchange/types";

import { resetSnapshotStoreForTests, SnapshotStore } from "./snapshot-store";

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

class RedisSnapshotFake {
  readonly strings = new Map<string, { value: string; expiresAt: number }>();
  readonly sortedSets = new Map<string, Map<string, number>>();
  readonly expirations = new Map<string, number>();
  lastEvalScript = "";

  async eval(script: string, numberOfKeys: number, ...parameters: string[]): Promise<number> {
    this.lastEvalScript = script;
    if (numberOfKeys !== 3) throw new Error("Expected three snapshot retention keys.");
    const [recordKey, tokenLookupKey, indexKey, ...args] = parameters;
    const [
      recordJson,
      ttlText,
      snapshotId,
      createdAtText,
      maxText,
      snapshotKeyPrefix,
      tokenKeyPrefix,
      indexTtlText,
      sourceRoomId,
      creatorParticipantId,
    ] = args;
    const ttlSeconds = Number(ttlText);
    this.strings.set(recordKey, {
      value: recordJson,
      expiresAt: Date.now() + ttlSeconds * 1_000,
    });
    this.strings.set(tokenLookupKey, {
      value: snapshotId,
      expiresAt: Date.now() + ttlSeconds * 1_000,
    });
    const index = this.sortedSets.get(indexKey) ?? new Map<string, number>();
    index.set(snapshotId, Number(createdAtText));
    this.sortedSets.set(indexKey, index);

    for (const indexedId of this.ascending(indexKey)) {
      if ((await this.get(`${snapshotKeyPrefix}${indexedId}`)) === null) index.delete(indexedId);
    }

    let overflow = index.size - Number(maxText);
    for (const evictedId of this.ascending(indexKey)) {
      if (overflow <= 0) break;
      if (evictedId === snapshotId) continue;
      const evictedRecordJson = await this.get(`${snapshotKeyPrefix}${evictedId}`);
      if (evictedRecordJson) {
        const evictedRecord = JSON.parse(evictedRecordJson) as {
          creatorParticipantId?: string;
          sourceRoomId?: string;
          tokenHash?: string;
        };
        if (
          evictedRecord.sourceRoomId === sourceRoomId &&
          evictedRecord.creatorParticipantId === creatorParticipantId
        ) {
          if (evictedRecord.tokenHash) this.strings.delete(`${tokenKeyPrefix}${evictedRecord.tokenHash}`);
          this.strings.delete(`${snapshotKeyPrefix}${evictedId}`);
        }
      }
      index.delete(evictedId);
      overflow -= 1;
    }

    this.expirations.set(indexKey, Date.now() + Number(indexTtlText) * 1_000);
    return 1;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.strings.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.strings.delete(key);
      return null;
    }
    return entry.value;
  }

  async mget(keys: string[]): Promise<Array<string | null>> {
    return Promise.all(keys.map((key) => this.get(key)));
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
    expect(listed).toHaveLength(50);
    expect(listed[0].title).toBe("Snapshot 50");
    expect(listed.some((snapshot) => snapshot.title === "Snapshot 0")).toBe(false);
    await expect(store.getByTokenHash("hash-0")).resolves.toBeNull();
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
    expect(listed).toHaveLength(50);
    expect(listed[0].title).toBe("Redis snapshot 50");
    await expect(redisStore.getByTokenHash("redis-hash-0")).resolves.toBeNull();
    expect(redis.strings.has(`jazzboard:snapshot:${oldestId}`)).toBe(false);
    expect(redis.strings.has("jazzboard:snapshot-token:redis-hash-0")).toBe(false);

    await expect(redisStore.getByTokenHash("other-hash")).resolves.toMatchObject({
      id: otherCreator.id,
      creatorParticipantId: "p_other",
    });
    expect(redis.lastEvalScript).toContain('redis.call("DEL", token_key_prefix');
    expect(redis.expirations.get("jazzboard:snapshots-by-creator:room_private:p_owner")).toBe(
      Date.now() + 7 * 24 * 60 * 60 * 1_000,
    );
  });
});
