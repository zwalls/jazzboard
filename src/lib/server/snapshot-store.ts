import { randomUUID } from "node:crypto";

import type { Redis } from "ioredis";

import type { ActorRef } from "@/lib/domain/types";
import type { JazzboardSemanticArtifactV1 } from "@/lib/interchange/types";

import { getRedisForAssets } from "./room-store";

const SNAPSHOT_KEY_PREFIX = "jazzboard:snapshot:";
const SNAPSHOT_TOKEN_KEY_PREFIX = "jazzboard:snapshot-token:";
const SNAPSHOT_CREATOR_KEY_PREFIX = "jazzboard:snapshots-by-creator:";
const MAX_CREATOR_SNAPSHOTS = 50;
const MAX_SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

// Creating a snapshot and enforcing the per-creator limit must be one Redis
// operation. Removing only the sorted-set member would leave its record and
// token lookup live but impossible for the creator to list or revoke.
const CREATE_AND_PRUNE_REDIS_SNAPSHOTS_SCRIPT = `
local record_json = ARGV[1]
local ttl_seconds = tonumber(ARGV[2])
local snapshot_id = ARGV[3]
local created_at = tonumber(ARGV[4])
local max_snapshots = tonumber(ARGV[5])
local snapshot_key_prefix = ARGV[6]
local token_key_prefix = ARGV[7]
local index_ttl_seconds = tonumber(ARGV[8])
local source_room_id = ARGV[9]
local creator_participant_id = ARGV[10]

redis.call("SET", KEYS[1], record_json, "EX", ttl_seconds)
redis.call("SET", KEYS[2], snapshot_id, "EX", ttl_seconds)
redis.call("ZADD", KEYS[3], created_at, snapshot_id)

local indexed_ids = redis.call("ZRANGE", KEYS[3], 0, -1)
for _, indexed_id in ipairs(indexed_ids) do
  if not redis.call("EXISTS", snapshot_key_prefix .. indexed_id) then
    redis.call("ZREM", KEYS[3], indexed_id)
  end
end

indexed_ids = redis.call("ZRANGE", KEYS[3], 0, -1)
local overflow = #indexed_ids - max_snapshots
for _, evicted_id in ipairs(indexed_ids) do
  if overflow <= 0 then
    break
  end

  -- Always retain the record created by this invocation when scores tie.
  if evicted_id ~= snapshot_id then
    local evicted_record_json = redis.call("GET", snapshot_key_prefix .. evicted_id)
    if evicted_record_json then
      local decode_ok, evicted_record = pcall(cjson.decode, evicted_record_json)
      if decode_ok
        and type(evicted_record) == "table"
        and evicted_record.sourceRoomId == source_room_id
        and evicted_record.creatorParticipantId == creator_participant_id then
        if type(evicted_record.tokenHash) == "string" then
          redis.call("DEL", token_key_prefix .. evicted_record.tokenHash)
        end
        redis.call("DEL", snapshot_key_prefix .. evicted_id)
      end
    end
    redis.call("ZREM", KEYS[3], evicted_id)
    overflow = overflow - 1
  end
end

-- A short-lived new snapshot must not shorten the lifetime of the creator's
-- index while an older seven-day snapshot remains.
redis.call("EXPIRE", KEYS[3], index_ttl_seconds)
return 1
`;

export type SnapshotScope =
  | { kind: "room" }
  | { kind: "diagram"; diagramId: string; expectedDiagramRevision: number };

export type ReadonlySnapshotRecord = {
  id: string;
  tokenHash: string;
  sourceRoomId: string;
  sourceRoomRevision: number;
  creatorParticipantId: string;
  creator: ActorRef;
  scope: SnapshotScope;
  title: string;
  createdAt: number;
  expiresAt: number;
  artifact: JazzboardSemanticArtifactV1;
};

export type ReadonlySnapshotSummary = Pick<
  ReadonlySnapshotRecord,
  "id" | "sourceRoomRevision" | "scope" | "title" | "createdAt" | "expiresAt"
>;

type MemorySnapshotState = {
  records: Map<string, ReadonlySnapshotRecord>;
  tokenIndex: Map<string, string>;
};

declare global {
  var __jazzboardSnapshotState: MemorySnapshotState | undefined;
}

function memoryState(): MemorySnapshotState {
  globalThis.__jazzboardSnapshotState ??= {
    records: new Map(),
    tokenIndex: new Map(),
  };
  return globalThis.__jazzboardSnapshotState;
}

function snapshotKey(snapshotId: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${snapshotId}`;
}

function tokenKey(tokenHash: string): string {
  return `${SNAPSHOT_TOKEN_KEY_PREFIX}${tokenHash}`;
}

function creatorKey(roomId: string, participantId: string): string {
  return `${SNAPSHOT_CREATOR_KEY_PREFIX}${roomId}:${participantId}`;
}

function currentRecord(record: ReadonlySnapshotRecord | null, now = Date.now()): ReadonlySnapshotRecord | null {
  return record && record.expiresAt > now ? record : null;
}

function deleteMemoryRecord(state: MemorySnapshotState, record: ReadonlySnapshotRecord): void {
  state.records.delete(record.id);
  state.tokenIndex.delete(record.tokenHash);
}

function pruneMemoryState(state: MemorySnapshotState, now = Date.now()): void {
  for (const record of state.records.values()) {
    if (record.expiresAt <= now) deleteMemoryRecord(state, record);
  }
}

function enforceMemoryCreatorLimit(
  state: MemorySnapshotState,
  roomId: string,
  participantId: string,
  newestRecordId: string,
): void {
  const overflow = [...state.records.values()]
    .filter(
      (record) =>
        record.sourceRoomId === roomId && record.creatorParticipantId === participantId,
    )
    .sort((left, right) => {
      if (left.id === newestRecordId) return -1;
      if (right.id === newestRecordId) return 1;
      return right.createdAt - left.createdAt;
    })
    .slice(MAX_CREATOR_SNAPSHOTS);
  for (const record of overflow) deleteMemoryRecord(state, record);
}

function parseRecord(value: string | null): ReadonlySnapshotRecord | null {
  if (!value) return null;
  try {
    const record = JSON.parse(value) as Partial<ReadonlySnapshotRecord>;
    return typeof record.id === "string" &&
      typeof record.tokenHash === "string" &&
      typeof record.sourceRoomId === "string" &&
      typeof record.creatorParticipantId === "string" &&
      typeof record.expiresAt === "number" &&
      record.artifact !== undefined
      ? (record as ReadonlySnapshotRecord)
      : null;
  } catch {
    return null;
  }
}

export class SnapshotStore {
  constructor(private readonly redis: Redis | null = getRedisForAssets()) {}

  async create(input: Omit<ReadonlySnapshotRecord, "id">): Promise<ReadonlySnapshotRecord> {
    const record: ReadonlySnapshotRecord = { ...input, id: `snapshot_${randomUUID()}` };
    const ttlSeconds = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1_000));
    if (!this.redis) {
      const state = memoryState();
      pruneMemoryState(state);
      state.records.set(record.id, structuredClone(record));
      state.tokenIndex.set(record.tokenHash, record.id);
      enforceMemoryCreatorLimit(
        state,
        record.sourceRoomId,
        record.creatorParticipantId,
        record.id,
      );
      return structuredClone(record);
    }

    const indexKey = creatorKey(record.sourceRoomId, record.creatorParticipantId);
    await this.redis.eval(
      CREATE_AND_PRUNE_REDIS_SNAPSHOTS_SCRIPT,
      3,
      snapshotKey(record.id),
      tokenKey(record.tokenHash),
      indexKey,
      JSON.stringify(record),
      ttlSeconds.toString(),
      record.id,
      record.createdAt.toString(),
      MAX_CREATOR_SNAPSHOTS.toString(),
      SNAPSHOT_KEY_PREFIX,
      SNAPSHOT_TOKEN_KEY_PREFIX,
      MAX_SNAPSHOT_TTL_SECONDS.toString(),
      record.sourceRoomId,
      record.creatorParticipantId,
    );
    return record;
  }

  async getByTokenHash(tokenHash: string): Promise<ReadonlySnapshotRecord | null> {
    if (!this.redis) {
      const state = memoryState();
      pruneMemoryState(state);
      const snapshotId = state.tokenIndex.get(tokenHash);
      const record = snapshotId ? currentRecord(state.records.get(snapshotId) ?? null) : null;
      if (!record && snapshotId) {
        state.records.delete(snapshotId);
        state.tokenIndex.delete(tokenHash);
      }
      return record ? structuredClone(record) : null;
    }
    const snapshotId = await this.redis.get(tokenKey(tokenHash));
    if (!snapshotId) return null;
    return currentRecord(parseRecord(await this.redis.get(snapshotKey(snapshotId))));
  }

  async listForCreator(roomId: string, participantId: string): Promise<ReadonlySnapshotSummary[]> {
    if (!this.redis) {
      const state = memoryState();
      pruneMemoryState(state);
      return [...state.records.values()]
        .filter(
          (record) =>
            record.sourceRoomId === roomId &&
            record.creatorParticipantId === participantId &&
            record.expiresAt > Date.now(),
        )
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, MAX_CREATOR_SNAPSHOTS)
        .map(summaryFor);
    }
    const ids = await this.redis.zrevrange(
      creatorKey(roomId, participantId),
      0,
      MAX_CREATOR_SNAPSHOTS - 1,
    );
    if (!ids.length) return [];
    const records = await this.redis.mget(ids.map(snapshotKey));
    return records
      .map(parseRecord)
      .filter(
        (record): record is ReadonlySnapshotRecord =>
          Boolean(
            record &&
              record.expiresAt > Date.now() &&
              record.sourceRoomId === roomId &&
              record.creatorParticipantId === participantId,
          ),
      )
      .map(summaryFor);
  }

  async revoke(roomId: string, participantId: string, snapshotId: string): Promise<boolean> {
    if (!this.redis) {
      const state = memoryState();
      const record = state.records.get(snapshotId);
      if (!record || record.sourceRoomId !== roomId || record.creatorParticipantId !== participantId) {
        return false;
      }
      deleteMemoryRecord(state, record);
      return true;
    }
    const record = parseRecord(await this.redis.get(snapshotKey(snapshotId)));
    if (!record || record.sourceRoomId !== roomId || record.creatorParticipantId !== participantId) {
      return false;
    }
    await this.redis
      .multi()
      .del(snapshotKey(record.id))
      .del(tokenKey(record.tokenHash))
      .zrem(creatorKey(roomId, participantId), record.id)
      .exec();
    return true;
  }
}

function summaryFor(record: ReadonlySnapshotRecord): ReadonlySnapshotSummary {
  return {
    id: record.id,
    sourceRoomRevision: record.sourceRoomRevision,
    scope: record.scope,
    title: record.title,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

let defaultSnapshotStore: SnapshotStore | null = null;

export function getSnapshotStore(): SnapshotStore {
  defaultSnapshotStore ??= new SnapshotStore();
  return defaultSnapshotStore;
}

/** Test-only reset for deterministic process-local service coverage. */
export function resetSnapshotStoreForTests(): SnapshotStore {
  globalThis.__jazzboardSnapshotState = undefined;
  defaultSnapshotStore = new SnapshotStore(null);
  return defaultSnapshotStore;
}
