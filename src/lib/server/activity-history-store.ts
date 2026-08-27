import { createHash } from "node:crypto";

import type Redis from "ioredis";
import type { ChainableCommander } from "ioredis";

import { DomainError } from "@/lib/domain/errors";
import { roomActivitySummary } from "@/lib/domain/review";
import type { RoomActivity, RoomActivitySummary } from "@/lib/domain/types";

import { DEFAULT_CAPACITY_LIMITS, REDIS_SAFE_PLANE_WRITE_BYTES } from "./capacity";

const MEBIBYTE = 1024 * 1024;
const KEY_NAMESPACE = "jazzboard:{activity-history}:v2";
const DETAIL_KEY_PREFIX = `${KEY_NAMESPACE}:detail:`;
const SUMMARY_KEY_PREFIX = `${KEY_NAMESPACE}:summary:`;
const METADATA_KEY_PREFIX = `${KEY_NAMESPACE}:metadata:`;
const ROOM_INDEX_KEY_PREFIX = `${KEY_NAMESPACE}:room-index:`;
const ROOM_COUNTER_KEY_PREFIX = `${KEY_NAMESPACE}:room-counter:`;
const GLOBAL_INDEX_KEY = `${KEY_NAMESPACE}:global-index`;
const GLOBAL_COUNTER_KEY = `${KEY_NAMESPACE}:global-counter`;
const LEGACY_ACTIVITY_KEY_PREFIX = "jazzboard:activity:";
const MIGRATION_KEY_PREFIX = `${KEY_NAMESPACE}:migration:`;
const NO_RECEIPT_KEY = `${KEY_NAMESPACE}:no-receipt`;
const INDEX_SEPARATOR = "\u001f";

/**
 * History is deliberately much smaller than the durable canvas plane. An
 * individual detail record keeps the existing mutation-time 1 MiB ceiling,
 * while retained history is bounded independently at room and deployment
 * scope. The count limit is a secondary guard against tiny-record index growth.
 */
export type ActivityHistoryLimits = {
  incomingBytes: number;
  roomRetainedBytes: number;
  deploymentRetainedBytes: number;
  roomEntryCount: number;
};

export const DEFAULT_ACTIVITY_HISTORY_LIMITS: Readonly<ActivityHistoryLimits> = Object.freeze({
  incomingBytes: DEFAULT_CAPACITY_LIMITS.activityBytes,
  roomRetainedBytes: 8 * MEBIBYTE,
  deploymentRetainedBytes: 32 * MEBIBYTE,
  roomEntryCount: 200,
});

export const LEGACY_ACTIVITY_MIGRATION_MAX_BATCH_BYTES = 6 * MEBIBYTE;
export const ACTIVITY_HISTORY_ROOM_COMMIT_GUARD_LIMIT = 100;

export type ActivityHistoryAppendResult = {
  status: "stored" | "replayed";
  evictedCount: number;
  roomBytes: number;
  deploymentBytes: number;
};

export type ActivityHistoryListOptions = {
  limit?: number;
  beforeRoomRevision?: number;
};

export type LegacyActivityMigrationResult = {
  status: "complete" | "in_progress";
  migratedCount: number;
  nextIndex: number;
};

type StoredActivityMetadata = {
  v: 1;
  r: string;
  i: string;
  b: number;
  h: string;
  q: number;
  t: number;
  g: string;
};

type ActivityHistoryCounter = {
  v: 1;
  bytes: number;
  count: number;
};

export type PreparedActivityHistoryEntry = {
  activity: RoomActivity;
  summary: RoomActivitySummary;
  detailJson: string;
  summaryJson: string;
  metadataJson: string;
  metadata: StoredActivityMetadata;
  roomIndexMember: string;
  globalIndexMember: string;
  entryBytes: number;
};

/** A prepared activity-only append command, used by migration and focused tests. */
export type ActivityHistoryAppendCommand = {
  activityId: string;
  roomId: string;
  script: string;
  keys: readonly string[];
  arguments: readonly string[];
};

export type RedisExecTuple = readonly [Error | null, unknown];

export type RoomPlaneCommitValues = {
  document: string | null;
  awareness: string | null;
  coordination: string | null;
};

export type RoomPlaneCommitChanges = {
  document?: string;
  awareness?: string;
  coordination?: string;
};

export type ActivityHistoryRoomCommitInput = {
  planeKeys: {
    document: string;
    awareness: string;
    coordination: string;
  };
  /** Current encoded values are hashed in-process and never duplicated in the Redis request. */
  expectedPlanes: RoomPlaneCommitValues;
  /** Only changed planes are sent back to Redis. */
  changedPlanes: RoomPlaneCommitChanges;
  event: {
    streamKey: string;
    roomId: string;
    encoded: string;
  };
  receipt?: {
    key: string;
    encoded: string;
    ttlSeconds: number;
  };
  /**
   * Additional small string keys whose exact previously-read values must still
   * match at commit time. A null expectation means the key must remain absent.
   */
  guards?: readonly {
    key: string;
    expectedValue: string | null;
  }[];
};

export type ActivityHistoryRoomCommitCommand = ActivityHistoryAppendCommand & {
  requestBytes: number;
};

export type ActivityHistoryRoomCommitResult =
  | ({ status: "stored" } & Omit<ActivityHistoryAppendResult, "status">)
  | { status: "replayed"; receipt: string }
  | { status: "revision_conflict" };

type MemoryActivityEntry = PreparedActivityHistoryEntry;

export type MemoryActivityHistoryState = {
  entries: Map<string, MemoryActivityEntry>;
  roomIndexes: Map<string, string[]>;
  globalIndex: string[];
  roomCounters: Map<string, ActivityHistoryCounter>;
  globalCounter: ActivityHistoryCounter;
};

type LegacyMigrationMarker = {
  v: 1;
  total: number;
  next: number;
  head: string | null;
  tail: string | null;
  migrated: number;
  complete: boolean;
};

function activityStorageError(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError("MUTATION_OUTCOME_UNKNOWN", message, {
    activityHistoryCorrupt: true,
    ...details,
  });
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function resolveLimits(input: Partial<ActivityHistoryLimits> = {}): ActivityHistoryLimits {
  const limits = {
    incomingBytes: positiveSafeInteger(
      input.incomingBytes ?? DEFAULT_ACTIVITY_HISTORY_LIMITS.incomingBytes,
      "Activity incoming byte limit",
    ),
    roomRetainedBytes: positiveSafeInteger(
      input.roomRetainedBytes ?? DEFAULT_ACTIVITY_HISTORY_LIMITS.roomRetainedBytes,
      "Activity room byte limit",
    ),
    deploymentRetainedBytes: positiveSafeInteger(
      input.deploymentRetainedBytes ?? DEFAULT_ACTIVITY_HISTORY_LIMITS.deploymentRetainedBytes,
      "Activity deployment byte limit",
    ),
    roomEntryCount: positiveSafeInteger(
      input.roomEntryCount ?? DEFAULT_ACTIVITY_HISTORY_LIMITS.roomEntryCount,
      "Activity room count limit",
    ),
  };
  if (limits.incomingBytes > limits.roomRetainedBytes) {
    throw new Error("The incoming activity limit cannot exceed the retained room limit.");
  }
  if (limits.roomRetainedBytes > limits.deploymentRetainedBytes) {
    throw new Error("The retained room limit cannot exceed the deployment history limit.");
  }
  return limits;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function activityDigest(detailJson: string, summaryJson: string): string {
  // Redis exposes SHA-1 inside Lua via redis.sha1hex. This digest is an
  // integrity/idempotency fingerprint, not a credential or signature.
  return createHash("sha1")
    .update(detailJson)
    .update("\0")
    .update(summaryJson)
    .digest("hex");
}

const MISSING_REDIS_VALUE_DIGEST = "missing";

export function redisRoomPlaneDigest(value: string | null): string {
  return value === null
    ? MISSING_REDIS_VALUE_DIGEST
    : createHash("sha1").update(value).digest("hex");
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw new DomainError(
      "INVALID_OPERATION",
      `${label} must contain only letters, numbers, underscores, or hyphens.`,
    );
  }
}

function entryKey(prefix: string, roomId: string, activityId: string): string {
  return `${prefix}${roomId}:${activityId}`;
}

function globalIndexMember(roomId: string, activityId: string): string {
  return `${roomId}${INDEX_SEPARATOR}${activityId}`;
}

function counterJson(counter: ActivityHistoryCounter): string {
  return JSON.stringify(counter);
}

function metadataWithStableBytes(input: Omit<StoredActivityMetadata, "b">, baseBytes: number): {
  metadata: StoredActivityMetadata;
  encoded: string;
} {
  let bytes = baseBytes;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const metadata: StoredActivityMetadata = { ...input, b: bytes };
    const encoded = JSON.stringify(metadata);
    const next = baseBytes + utf8Bytes(encoded);
    if (next === bytes) return { metadata, encoded };
    bytes = next;
  }
  throw new Error("Activity history byte accounting did not converge.");
}

export function prepareActivityHistoryEntry(
  activityInput: RoomActivity,
  limitsInput: Partial<ActivityHistoryLimits> = {},
): PreparedActivityHistoryEntry {
  const limits = resolveLimits(limitsInput);
  const activity = structuredClone(activityInput);
  assertIdentifier(activity.roomId, "Room ID");
  assertIdentifier(activity.id, "Activity ID");
  if (!Number.isSafeInteger(activity.roomRevision) || activity.roomRevision <= 0) {
    throw new DomainError("INVALID_OPERATION", "Activity roomRevision must be a positive integer.");
  }
  if (!Number.isSafeInteger(activity.occurredAt) || activity.occurredAt < 0) {
    throw new DomainError("INVALID_OPERATION", "Activity occurredAt must be a non-negative integer.");
  }

  const summary = roomActivitySummary(activity);
  const detailJson = JSON.stringify(activity);
  const summaryJson = JSON.stringify(summary);
  const incomingBytes = utf8Bytes(detailJson);
  if (incomingBytes > limits.incomingBytes) {
    throw new DomainError(
      "REQUEST_TOO_LARGE",
      "The private activity detail exceeds Jazzboard's 1 MiB activity limit.",
      { used: incomingBytes, limit: limits.incomingBytes },
    );
  }

  const roomIndexMember = activity.id;
  const deploymentIndexMember = globalIndexMember(activity.roomId, activity.id);
  const digest = activityDigest(detailJson, summaryJson);
  const baseBytes =
    incomingBytes +
    utf8Bytes(summaryJson) +
    utf8Bytes(roomIndexMember) +
    utf8Bytes(deploymentIndexMember);
  const { metadata, encoded: metadataJson } = metadataWithStableBytes(
    {
      v: 1,
      r: activity.roomId,
      i: activity.id,
      h: digest,
      q: activity.roomRevision,
      t: activity.occurredAt,
      g: deploymentIndexMember,
    },
    baseBytes,
  );
  if (metadata.b > limits.roomRetainedBytes || metadata.b > limits.deploymentRetainedBytes) {
    throw new DomainError(
      "ROOM_CAPACITY_EXCEEDED",
      "The activity cannot fit within Jazzboard's retained history budget.",
      {
        used: metadata.b,
        roomLimit: limits.roomRetainedBytes,
        deploymentLimit: limits.deploymentRetainedBytes,
      },
    );
  }

  return {
    activity,
    summary,
    detailJson,
    summaryJson,
    metadataJson,
    metadata,
    roomIndexMember,
    globalIndexMember: deploymentIndexMember,
    entryBytes: metadata.b,
  };
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw activityStorageError(`${label} is malformed.`);
  }
}

function parseStoredMetadata(value: string): StoredActivityMetadata {
  const parsed = parseJsonObject(value, "Activity history metadata");
  if (
    parsed.v !== 1 ||
    typeof parsed.r !== "string" ||
    typeof parsed.i !== "string" ||
    !Number.isSafeInteger(parsed.b) ||
    Number(parsed.b) <= 0 ||
    typeof parsed.h !== "string" ||
    !/^[a-f0-9]{40}$/.test(parsed.h) ||
    !Number.isSafeInteger(parsed.q) ||
    Number(parsed.q) <= 0 ||
    !Number.isSafeInteger(parsed.t) ||
    Number(parsed.t) < 0 ||
    typeof parsed.g !== "string"
  ) {
    throw activityStorageError("Activity history metadata is malformed.");
  }
  return parsed as StoredActivityMetadata;
}

function parseActivity(value: string, roomId: string, activityId: string): RoomActivity {
  const parsed = parseJsonObject(value, "Activity history detail") as RoomActivity;
  if (parsed.roomId !== roomId || parsed.id !== activityId) {
    throw activityStorageError("Activity history detail identity does not match its index.", {
      roomId,
      activityId,
    });
  }
  return parsed;
}

function parseSummary(value: string, roomId: string, activityId: string): RoomActivitySummary {
  const parsed = parseJsonObject(value, "Activity history summary") as RoomActivitySummary;
  if (parsed.roomId !== roomId || parsed.id !== activityId) {
    throw activityStorageError("Activity history summary identity does not match its index.", {
      roomId,
      activityId,
    });
  }
  if ("objectChanges" in parsed || "diagramChanges" in parsed) {
    throw activityStorageError("Activity history summary contains private revert detail.");
  }
  return parsed;
}

function validateMemoryEntry(entry: MemoryActivityEntry): void {
  const metadata = parseStoredMetadata(entry.metadataJson);
  const actualBytes =
    utf8Bytes(entry.detailJson) +
    utf8Bytes(entry.summaryJson) +
    utf8Bytes(entry.roomIndexMember) +
    utf8Bytes(entry.globalIndexMember) +
    utf8Bytes(entry.metadataJson);
  if (
    metadata.r !== entry.activity.roomId ||
    metadata.i !== entry.activity.id ||
    metadata.g !== entry.globalIndexMember ||
    metadata.b !== actualBytes ||
    metadata.h !== activityDigest(entry.detailJson, entry.summaryJson) ||
    entry.entryBytes !== actualBytes
  ) {
    throw activityStorageError("Activity history entry metadata does not match its stored payload.");
  }
  parseActivity(entry.detailJson, metadata.r, metadata.i);
  parseSummary(entry.summaryJson, metadata.r, metadata.i);
}

function compareEntries(a: MemoryActivityEntry, b: MemoryActivityEntry, scope: "room" | "global"): number {
  const primary = scope === "room"
    ? a.metadata.q - b.metadata.q
    : a.metadata.t - b.metadata.t;
  return primary || a.globalIndexMember.localeCompare(b.globalIndexMember);
}

function emptyCounter(): ActivityHistoryCounter {
  return { v: 1, bytes: 0, count: 0 };
}

export function createMemoryActivityHistoryState(): MemoryActivityHistoryState {
  return {
    entries: new Map(),
    roomIndexes: new Map(),
    globalIndex: [],
    roomCounters: new Map(),
    globalCounter: emptyCounter(),
  };
}

function assertCounter(counter: ActivityHistoryCounter | undefined, expectedCount: number, label: string): ActivityHistoryCounter {
  if (
    !counter ||
    counter.v !== 1 ||
    !Number.isSafeInteger(counter.bytes) ||
    counter.bytes < 0 ||
    !Number.isSafeInteger(counter.count) ||
    counter.count < 0 ||
    counter.count !== expectedCount
  ) {
    throw activityStorageError(`${label} is malformed or disagrees with its index.`);
  }
  return counter;
}

export function assertMemoryActivityHistoryIntegrity(state: MemoryActivityHistoryState): void {
  const seen = new Set<string>();
  let deploymentBytes = 0;
  for (const [roomId, index] of state.roomIndexes) {
    const counter = assertCounter(state.roomCounters.get(roomId), index.length, "Room activity counter");
    let roomBytes = 0;
    for (const member of index) {
      if (seen.has(member)) throw activityStorageError("An activity is indexed more than once.");
      const entry = state.entries.get(member);
      if (!entry || entry.activity.roomId !== roomId) {
        throw activityStorageError("A room activity index points to missing metadata.");
      }
      validateMemoryEntry(entry);
      seen.add(member);
      roomBytes += entry.entryBytes;
    }
    if (roomBytes !== counter.bytes) {
      throw activityStorageError("Room activity byte accounting disagrees with retained entries.");
    }
  }
  if (
    state.globalIndex.length !== state.entries.size ||
    state.globalIndex.some((member) => !seen.has(member))
  ) {
    throw activityStorageError("The deployment activity index disagrees with room indexes.");
  }
  for (const member of state.globalIndex) deploymentBytes += state.entries.get(member)!.entryBytes;
  const globalCounter = assertCounter(
    state.globalCounter,
    state.globalIndex.length,
    "Deployment activity counter",
  );
  if (deploymentBytes !== globalCounter.bytes) {
    throw activityStorageError("Deployment activity byte accounting disagrees with retained entries.");
  }
}

function removeMemoryEntry(state: MemoryActivityHistoryState, member: string): void {
  const entry = state.entries.get(member);
  if (!entry) throw activityStorageError("An activity eviction candidate is missing.");
  const roomId = entry.activity.roomId;
  const roomIndex = state.roomIndexes.get(roomId);
  const roomCounter = state.roomCounters.get(roomId);
  if (!roomIndex || !roomCounter) throw activityStorageError("An activity room index is incomplete.");
  const roomPosition = roomIndex.indexOf(member);
  const globalPosition = state.globalIndex.indexOf(member);
  if (roomPosition < 0 || globalPosition < 0) {
    throw activityStorageError("An activity eviction candidate is not fully indexed.");
  }
  roomIndex.splice(roomPosition, 1);
  state.globalIndex.splice(globalPosition, 1);
  state.entries.delete(member);
  roomCounter.bytes -= entry.entryBytes;
  roomCounter.count -= 1;
  state.globalCounter.bytes -= entry.entryBytes;
  state.globalCounter.count -= 1;
}

export class MemoryActivityHistoryStore {
  readonly state: MemoryActivityHistoryState;
  private readonly limits: ActivityHistoryLimits;

  constructor(
    state: MemoryActivityHistoryState = createMemoryActivityHistoryState(),
    limits: Partial<ActivityHistoryLimits> = {},
  ) {
    this.state = state;
    this.limits = resolveLimits(limits);
  }

  async appendActivity(activity: RoomActivity): Promise<ActivityHistoryAppendResult> {
    assertMemoryActivityHistoryIntegrity(this.state);
    const entry = prepareActivityHistoryEntry(activity, this.limits);
    const existing = this.state.entries.get(entry.globalIndexMember);
    if (existing) {
      validateMemoryEntry(existing);
      if (
        existing.metadata.h !== entry.metadata.h ||
        existing.detailJson !== entry.detailJson ||
        existing.summaryJson !== entry.summaryJson
      ) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "That activity ID is already associated with a different mutation.",
        );
      }
      return {
        status: "replayed",
        evictedCount: 0,
        roomBytes: this.state.roomCounters.get(activity.roomId)?.bytes ?? 0,
        deploymentBytes: this.state.globalCounter.bytes,
      };
    }

    const draft = structuredClone(this.state);
    const roomIndex = draft.roomIndexes.get(activity.roomId) ?? [];
    const roomCounter = draft.roomCounters.get(activity.roomId) ?? emptyCounter();
    draft.roomIndexes.set(activity.roomId, roomIndex);
    draft.roomCounters.set(activity.roomId, roomCounter);
    draft.entries.set(entry.globalIndexMember, entry);
    roomIndex.push(entry.globalIndexMember);
    roomIndex.sort((left, right) => compareEntries(draft.entries.get(left)!, draft.entries.get(right)!, "room"));
    draft.globalIndex.push(entry.globalIndexMember);
    draft.globalIndex.sort((left, right) => compareEntries(draft.entries.get(left)!, draft.entries.get(right)!, "global"));
    roomCounter.bytes += entry.entryBytes;
    roomCounter.count += 1;
    draft.globalCounter.bytes += entry.entryBytes;
    draft.globalCounter.count += 1;

    let evictedCount = 0;
    while (
      roomCounter.bytes > this.limits.roomRetainedBytes ||
      roomCounter.count > this.limits.roomEntryCount
    ) {
      const oldest = roomIndex[0];
      if (!oldest) throw activityStorageError("Room history cannot satisfy its retention limits.");
      removeMemoryEntry(draft, oldest);
      evictedCount += 1;
    }
    while (draft.globalCounter.bytes > this.limits.deploymentRetainedBytes) {
      const oldest = draft.globalIndex[0];
      if (!oldest) throw activityStorageError("Deployment history cannot satisfy its retention limit.");
      removeMemoryEntry(draft, oldest);
      evictedCount += 1;
    }
    assertMemoryActivityHistoryIntegrity(draft);

    this.state.entries = draft.entries;
    this.state.roomIndexes = draft.roomIndexes;
    this.state.globalIndex = draft.globalIndex;
    this.state.roomCounters = draft.roomCounters;
    this.state.globalCounter = draft.globalCounter;
    return {
      status: "stored",
      evictedCount,
      roomBytes: this.state.roomCounters.get(activity.roomId)?.bytes ?? 0,
      deploymentBytes: this.state.globalCounter.bytes,
    };
  }

  async listActivitySummaries(
    roomId: string,
    options: ActivityHistoryListOptions = {},
  ): Promise<RoomActivitySummary[]> {
    assertIdentifier(roomId, "Room ID");
    assertMemoryActivityHistoryIntegrity(this.state);
    const limit = Math.min(
      positiveSafeInteger(options.limit ?? 50, "Activity list limit"),
      this.limits.roomEntryCount,
    );
    const before = options.beforeRoomRevision ?? Number.POSITIVE_INFINITY;
    return [...(this.state.roomIndexes.get(roomId) ?? [])]
      .reverse()
      .map((member) => this.state.entries.get(member)!)
      .filter((entry) => entry.metadata.q < before)
      .slice(0, limit)
      .map((entry) => structuredClone(entry.summary));
  }

  async getActivity(roomId: string, activityId: string): Promise<RoomActivity | null> {
    assertIdentifier(roomId, "Room ID");
    assertIdentifier(activityId, "Activity ID");
    assertMemoryActivityHistoryIntegrity(this.state);
    const entry = this.state.entries.get(globalIndexMember(roomId, activityId));
    return entry ? structuredClone(entry.activity) : null;
  }
}

/**
 * The script preflights counters, every prospective eviction, all referenced
 * detail/summary payloads, and idempotency state before its first write. This
 * ordering is essential: a Redis Lua runtime error does not undo earlier
 * writes. Only after preflight succeeds does one atomic script store the new
 * detail and summary, update both indexes/counters, and delete evictions.
 */
export const APPEND_ACTIVITY_HISTORY_LUA = String.raw`
local room_index = KEYS[1]
local room_counter_key = KEYS[2]
local global_index = KEYS[3]
local global_counter_key = KEYS[4]
local new_detail_key = KEYS[5]
local new_summary_key = KEYS[6]
local new_metadata_key = KEYS[7]
local document_key = KEYS[8]
local awareness_key = KEYS[9]
local coordination_key = KEYS[10]
local event_stream_key = KEYS[11]
local receipt_key = KEYS[12]

local room_id = ARGV[1]
local activity_id = ARGV[2]
local global_member = ARGV[3]
local room_score = tonumber(ARGV[4])
local global_score = tonumber(ARGV[5])
local detail_json = ARGV[6]
local summary_json = ARGV[7]
local metadata_json = ARGV[8]
local entry_bytes = tonumber(ARGV[9])
local digest = ARGV[10]
local room_byte_limit = tonumber(ARGV[11])
local global_byte_limit = tonumber(ARGV[12])
local room_count_limit = tonumber(ARGV[13])
local detail_prefix = ARGV[14]
local summary_prefix = ARGV[15]
local metadata_prefix = ARGV[16]
local room_index_prefix = ARGV[17]
local room_counter_prefix = ARGV[18]
local separator = ARGV[19]
local commit_mode = ARGV[20] == "1"
local expected_document_digest = ARGV[21]
local expected_awareness_digest = ARGV[22]
local expected_coordination_digest = ARGV[23]
local write_document = ARGV[24] == "1"
local next_document = ARGV[25]
local write_awareness = ARGV[26] == "1"
local next_awareness = ARGV[27]
local write_coordination = ARGV[28] == "1"
local next_coordination = ARGV[29]
local event_room_id = ARGV[30]
local event_json = ARGV[31]
local has_receipt = ARGV[32] == "1"
local receipt_json = ARGV[33]
local receipt_ttl = tonumber(ARGV[34])
local guard_count = tonumber(ARGV[35] or "0")

local function corrupt(message)
  return { "corrupt", message }
end

local function integer(value)
  return type(value) == "number" and value >= 0 and value == math.floor(value)
end

local function decode(raw)
  if not raw then return nil end
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= "table" then return nil end
  return value
end

local function read_counter(key, expected_count)
  local raw = redis.call("GET", key)
  if not raw then
    if expected_count == 0 then return { v = 1, bytes = 0, count = 0 } end
    return nil
  end
  local value = decode(raw)
  if not value or value.v ~= 1 or not integer(value.bytes) or
      not integer(value.count) or value.count ~= expected_count then
    return nil
  end
  return value
end

local function split_global_member(member)
  local start_at, end_at = string.find(member, separator, 1, true)
  if not start_at or start_at <= 1 or end_at >= string.len(member) then return nil, nil end
  if string.find(member, separator, end_at + 1, true) then return nil, nil end
  return string.sub(member, 1, start_at - 1), string.sub(member, end_at + 1)
end

local function read_entry(candidate_room, candidate_id, expected_global_member, room_index_key)
  local detail_key = detail_prefix .. candidate_room .. ":" .. candidate_id
  local summary_key = summary_prefix .. candidate_room .. ":" .. candidate_id
  local metadata_key = metadata_prefix .. candidate_room .. ":" .. candidate_id
  local values = redis.call("MGET", detail_key, summary_key, metadata_key)
  if not values[1] or not values[2] or not values[3] then return nil end
  local metadata = decode(values[3])
  if not metadata or metadata.v ~= 1 or metadata.r ~= candidate_room or
      metadata.i ~= candidate_id or metadata.g ~= expected_global_member or
      not integer(metadata.b) or metadata.b <= 0 or
      not integer(metadata.q) or metadata.q <= 0 or
      not integer(metadata.t) or string.len(metadata.h or "") ~= 40 then
    return nil
  end
  local actual_bytes = string.len(values[1]) + string.len(values[2]) +
    string.len(values[3]) + string.len(candidate_id) + string.len(expected_global_member)
  if metadata.b ~= actual_bytes then return nil end
  if redis.sha1hex(values[1] .. "\0" .. values[2]) ~= metadata.h then return nil end
  local room_member_score = redis.call("ZSCORE", room_index_key, candidate_id)
  local global_member_score = redis.call("ZSCORE", global_index, expected_global_member)
  if not room_member_score or not global_member_score or
      tonumber(room_member_score) ~= metadata.q or tonumber(global_member_score) ~= metadata.t then
    return nil
  end
  return {
    room = candidate_room,
    id = candidate_id,
    global = expected_global_member,
    bytes = metadata.b,
    detail_key = detail_key,
    summary_key = summary_key,
    metadata_key = metadata_key,
    room_index_key = room_index_key,
  }
end

if commit_mode then
  local function valid_digest(value)
    return value == "missing" or (type(value) == "string" and string.len(value) == 40)
  end
  local function current_digest(value)
    if not value then return "missing" end
    return redis.sha1hex(value)
  end
  if not valid_digest(expected_document_digest) or
      not valid_digest(expected_awareness_digest) or
      not valid_digest(expected_coordination_digest) or
      (ARGV[24] ~= "0" and ARGV[24] ~= "1") or
      (ARGV[26] ~= "0" and ARGV[26] ~= "1") or
      (ARGV[28] ~= "0" and ARGV[28] ~= "1") or
      (ARGV[32] ~= "0" and ARGV[32] ~= "1") or
      not event_room_id or event_room_id == "" or not decode(event_json) then
    return corrupt("invalid room commit arguments")
  end
  if (write_document and not decode(next_document)) or
      (write_awareness and not decode(next_awareness)) or
      (write_coordination and not decode(next_coordination)) then
    return corrupt("invalid changed room plane")
  end
  if has_receipt then
    if not receipt_ttl or receipt_ttl <= 0 or receipt_ttl ~= math.floor(receipt_ttl) or
        not decode(receipt_json) then
      return corrupt("invalid mutation receipt")
    end
    local existing_receipt = redis.call("GET", receipt_key)
    if existing_receipt then
      return { "commit_replayed", existing_receipt }
    end
  end
  if not integer(guard_count) or guard_count > 100 then
    return corrupt("invalid exact guard count")
  end
  for guard_index = 1, guard_count do
    local guard_key = KEYS[12 + guard_index]
    local flag_offset = 34 + ((guard_index - 1) * 2)
    local expected_exists = ARGV[flag_offset + 2]
    local expected_value = ARGV[flag_offset + 3]
    if not guard_key or guard_key == "" or
        (expected_exists ~= "0" and expected_exists ~= "1") then
      return corrupt("invalid exact guard")
    end
    local guard_type_reply = redis.call("TYPE", guard_key)
    local guard_type = type(guard_type_reply) == "table" and guard_type_reply.ok or guard_type_reply
    if guard_type ~= "none" and guard_type ~= "string" then
      return corrupt("exact guard has an invalid type")
    end
    local current_value = redis.call("GET", guard_key)
    if (expected_exists == "0" and current_value) or
        (expected_exists == "1" and current_value ~= expected_value) then
      return { "revision_conflict" }
    end
  end
  local stream_type_reply = redis.call("TYPE", event_stream_key)
  local stream_type = type(stream_type_reply) == "table" and stream_type_reply.ok or stream_type_reply
  if stream_type ~= "none" and stream_type ~= "stream" then
    return corrupt("event stream has an invalid type")
  end
  local current_planes = redis.call("MGET", document_key, awareness_key, coordination_key)
  if current_digest(current_planes[1]) ~= expected_document_digest or
      current_digest(current_planes[2]) ~= expected_awareness_digest or
      current_digest(current_planes[3]) ~= expected_coordination_digest then
    return { "revision_conflict" }
  end
end

if not room_score or room_score <= 0 or not global_score or global_score < 0 or
    not entry_bytes or entry_bytes <= 0 or not room_byte_limit or
    not global_byte_limit or not room_count_limit then
  return corrupt("invalid append arguments")
end

local room_cardinality = redis.call("ZCARD", room_index)
local global_cardinality = redis.call("ZCARD", global_index)
local room_counter = read_counter(room_counter_key, room_cardinality)
local global_counter = read_counter(global_counter_key, global_cardinality)
if not room_counter or not global_counter then return corrupt("counter/index mismatch") end

local existing_values = redis.call("MGET", new_detail_key, new_summary_key, new_metadata_key)
local existing_room_score = redis.call("ZSCORE", room_index, activity_id)
local existing_global_score = redis.call("ZSCORE", global_index, global_member)
local existing_count = 0
for index = 1, 3 do if existing_values[index] then existing_count = existing_count + 1 end end
if existing_room_score then existing_count = existing_count + 1 end
if existing_global_score then existing_count = existing_count + 1 end
if existing_count > 0 then
  if existing_count ~= 5 then return corrupt("partial existing activity") end
  local existing = read_entry(room_id, activity_id, global_member, room_index)
  if not existing then return corrupt("invalid existing activity") end
  local existing_metadata = decode(existing_values[3])
  if existing_metadata.h ~= digest or existing_values[1] ~= detail_json or
      existing_values[2] ~= summary_json then
    return { "conflict" }
  end
  if commit_mode then
    return corrupt("activity exists without a committed receipt")
  end
  return { "replayed", "0", tostring(room_counter.bytes), tostring(global_counter.bytes) }
end

local supplied_metadata = decode(metadata_json)
local supplied_actual_bytes = string.len(detail_json) + string.len(summary_json) +
  string.len(metadata_json) + string.len(activity_id) + string.len(global_member)
if not supplied_metadata or supplied_metadata.v ~= 1 or supplied_metadata.r ~= room_id or
    supplied_metadata.i ~= activity_id or supplied_metadata.g ~= global_member or
    supplied_metadata.b ~= entry_bytes or supplied_actual_bytes ~= entry_bytes or
    supplied_metadata.q ~= room_score or supplied_metadata.t ~= global_score or
    supplied_metadata.h ~= digest or redis.sha1hex(detail_json .. "\0" .. summary_json) ~= digest then
  return corrupt("invalid supplied metadata")
end
if entry_bytes > room_byte_limit or entry_bytes > global_byte_limit then
  return { "capacity" }
end

local evictions = {}
local eviction_set = {}
local room_bytes = room_counter.bytes + entry_bytes
local room_count = room_counter.count + 1
local room_offset = 0
while room_bytes > room_byte_limit or room_count > room_count_limit do
  local candidates = redis.call("ZRANGE", room_index, room_offset, room_offset)
  local candidate_id = candidates[1]
  if not candidate_id then return corrupt("room eviction underflow") end
  local candidate_global = room_id .. separator .. candidate_id
  local candidate = read_entry(room_id, candidate_id, candidate_global, room_index)
  if not candidate then return corrupt("invalid room eviction metadata") end
  table.insert(evictions, candidate)
  eviction_set[candidate_global] = true
  room_bytes = room_bytes - candidate.bytes
  room_count = room_count - 1
  room_offset = room_offset + 1
end

local global_bytes = global_counter.bytes + entry_bytes
local global_count = global_counter.count + 1
for _, candidate in ipairs(evictions) do
  global_bytes = global_bytes - candidate.bytes
  global_count = global_count - 1
end

local affected_rooms = {}
affected_rooms[room_id] = { key = room_counter_key, index = room_index, bytes = room_bytes, count = room_count }
local global_offset = 0
while global_bytes > global_byte_limit do
  local candidates = redis.call("ZRANGE", global_index, global_offset, global_offset)
  local candidate_global = candidates[1]
  if not candidate_global then return corrupt("global eviction underflow") end
  global_offset = global_offset + 1
  if not eviction_set[candidate_global] then
    local candidate_room, candidate_id = split_global_member(candidate_global)
    if not candidate_room then return corrupt("invalid global index member") end
    local candidate_room_index = room_index_prefix .. candidate_room
    local candidate = read_entry(candidate_room, candidate_id, candidate_global, candidate_room_index)
    if not candidate then return corrupt("invalid global eviction metadata") end
    local affected = affected_rooms[candidate_room]
    if not affected then
      local candidate_counter_key = room_counter_prefix .. candidate_room
      local candidate_count = redis.call("ZCARD", candidate_room_index)
      local candidate_counter = read_counter(candidate_counter_key, candidate_count)
      if not candidate_counter then return corrupt("global eviction room counter mismatch") end
      affected = {
        key = candidate_counter_key,
        index = candidate_room_index,
        bytes = candidate_counter.bytes,
        count = candidate_counter.count,
      }
      affected_rooms[candidate_room] = affected
    end
    affected.bytes = affected.bytes - candidate.bytes
    affected.count = affected.count - 1
    if affected.bytes < 0 or affected.count < 0 then return corrupt("eviction counter underflow") end
    table.insert(evictions, candidate)
    eviction_set[candidate_global] = true
    global_bytes = global_bytes - candidate.bytes
    global_count = global_count - 1
  end
end

-- All validation and planning is complete. Writes begin here.
for _, candidate in ipairs(evictions) do
  redis.call("DEL", candidate.detail_key, candidate.summary_key, candidate.metadata_key)
  redis.call("ZREM", candidate.room_index_key, candidate.id)
  redis.call("ZREM", global_index, candidate.global)
end
redis.call("SET", new_detail_key, detail_json)
redis.call("SET", new_summary_key, summary_json)
redis.call("SET", new_metadata_key, metadata_json)
redis.call("ZADD", room_index, room_score, activity_id)
redis.call("ZADD", global_index, global_score, global_member)
for _, affected in pairs(affected_rooms) do
  redis.call("SET", affected.key,
    string.format('{"v":1,"bytes":%d,"count":%d}', affected.bytes, affected.count))
end
redis.call("SET", global_counter_key,
  string.format('{"v":1,"bytes":%d,"count":%d}', global_bytes, global_count))
if commit_mode then
  if write_document then redis.call("SET", document_key, next_document) end
  if write_awareness then redis.call("SET", awareness_key, next_awareness) end
  if write_coordination then redis.call("SET", coordination_key, next_coordination) end
  redis.call("XADD", event_stream_key, "MAXLEN", "~", 20000, "*",
    "roomId", event_room_id, "data", event_json)
  if has_receipt then redis.call("SET", receipt_key, receipt_json, "EX", receipt_ttl) end
  return { "commit_stored", tostring(#evictions),
    tostring(affected_rooms[room_id].bytes), tostring(global_bytes) }
end
return { "stored", tostring(#evictions), tostring(affected_rooms[room_id].bytes), tostring(global_bytes) }
`;

const ADVANCE_MIGRATION_LUA = String.raw`
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return { "retry" } end
redis.call("SET", KEYS[1], ARGV[2])
return { "advanced" }
`;

const COMPLETE_MIGRATION_LUA = String.raw`
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return { "retry" } end
redis.call("SET", KEYS[1], ARGV[2])
redis.call("DEL", KEYS[2])
return { "complete" }
`;

function appendKeys(entry: PreparedActivityHistoryEntry): string[] {
  return [
    `${ROOM_INDEX_KEY_PREFIX}${entry.activity.roomId}`,
    `${ROOM_COUNTER_KEY_PREFIX}${entry.activity.roomId}`,
    GLOBAL_INDEX_KEY,
    GLOBAL_COUNTER_KEY,
    entryKey(DETAIL_KEY_PREFIX, entry.activity.roomId, entry.activity.id),
    entryKey(SUMMARY_KEY_PREFIX, entry.activity.roomId, entry.activity.id),
    entryKey(METADATA_KEY_PREFIX, entry.activity.roomId, entry.activity.id),
  ];
}

function appendArguments(entry: PreparedActivityHistoryEntry, limits: ActivityHistoryLimits): string[] {
  return [
    entry.activity.roomId,
    entry.activity.id,
    entry.globalIndexMember,
    String(entry.activity.roomRevision),
    String(entry.activity.occurredAt),
    entry.detailJson,
    entry.summaryJson,
    entry.metadataJson,
    String(entry.entryBytes),
    entry.metadata.h,
    String(limits.roomRetainedBytes),
    String(limits.deploymentRetainedBytes),
    String(limits.roomEntryCount),
    DETAIL_KEY_PREFIX,
    SUMMARY_KEY_PREFIX,
    METADATA_KEY_PREFIX,
    ROOM_INDEX_KEY_PREFIX,
    ROOM_COUNTER_KEY_PREFIX,
    INDEX_SEPARATOR,
  ];
}

function redisArray(result: unknown): string[] {
  if (!Array.isArray(result)) throw activityStorageError("Activity history returned an invalid result.");
  return result.map((item) => String(item));
}

export function parseActivityHistoryAppendResult(result: unknown): ActivityHistoryAppendResult {
  const values = redisArray(result);
  switch (values[0]) {
    case "stored":
    case "replayed": {
      const evictedCount = Number(values[1]);
      const roomBytes = Number(values[2]);
      const deploymentBytes = Number(values[3]);
      if (![evictedCount, roomBytes, deploymentBytes].every(Number.isSafeInteger)) {
        throw activityStorageError("Activity history returned malformed counters.");
      }
      return { status: values[0], evictedCount, roomBytes, deploymentBytes };
    }
    case "conflict":
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "That activity ID is already associated with a different mutation.",
      );
    case "capacity":
      throw new DomainError(
        "ROOM_CAPACITY_EXCEEDED",
        "The activity cannot fit within Jazzboard's retained history budget.",
      );
    case "corrupt":
      throw activityStorageError("Activity history storage is inconsistent; the mutation was not committed.", {
        reason: values[1] ?? "unknown",
      });
    default:
      throw activityStorageError("Activity history returned an unknown append outcome.");
  }
}

export function createActivityHistoryAppendCommand(
  activity: RoomActivity,
  limitsInput: Partial<ActivityHistoryLimits> = {},
): ActivityHistoryAppendCommand {
  const limits = resolveLimits(limitsInput);
  const entry = prepareActivityHistoryEntry(activity, limits);
  return {
    activityId: entry.activity.id,
    roomId: entry.activity.roomId,
    script: APPEND_ACTIVITY_HISTORY_LUA,
    keys: appendKeys(entry),
    arguments: appendArguments(entry, limits),
  };
}

/**
 * Queues an activity-only append. Do not combine this helper with room-plane
 * writes in MULTI: Redis does not roll those writes back if a sibling command
 * fails. Room mutations must use createActivityHistoryRoomCommitCommand.
 */
export function queueActivityHistoryAppend(
  transaction: ChainableCommander,
  command: ActivityHistoryAppendCommand,
): ChainableCommander {
  transaction.eval(
    command.script,
    command.keys.length,
    ...command.keys,
    ...command.arguments,
  );
  return transaction;
}

/**
 * Extracts and validates the queued script outcome. In particular, a Redis
 * command error or a returned corruption/capacity status is never treated as
 * a successful room commit by integration code.
 */
export function activityHistoryAppendResultFromExec(
  results: readonly RedisExecTuple[] | null,
  commandIndex: number,
): ActivityHistoryAppendResult {
  if (!results) {
    throw new DomainError("REVISION_CONFLICT", "The activity history transaction was superseded.");
  }
  if (!Number.isSafeInteger(commandIndex) || commandIndex < 0 || commandIndex >= results.length) {
    throw activityStorageError("The activity history transaction result is missing.");
  }
  const [error, result] = results[commandIndex];
  if (error) {
    throw activityStorageError("The activity history command failed during the room commit.", {
      commandFailed: true,
    });
  }
  return parseActivityHistoryAppendResult(result);
}

function hasChangedPlane(
  changes: RoomPlaneCommitChanges,
  name: keyof RoomPlaneCommitChanges,
): boolean {
  return Object.prototype.hasOwnProperty.call(changes, name) && changes[name] !== undefined;
}

function commandEnvelopeBytes(script: string, keys: readonly string[], args: readonly string[]): number {
  return utf8Bytes(script) +
    keys.reduce((total, value) => total + utf8Bytes(value), 0) +
    args.reduce((total, value) => total + utf8Bytes(value), 0);
}

export function createActivityHistoryRoomCommitCommand(
  activity: RoomActivity,
  input: ActivityHistoryRoomCommitInput,
  limitsInput: Partial<ActivityHistoryLimits> = {},
): ActivityHistoryRoomCommitCommand {
  if (input.event.roomId !== activity.roomId) {
    throw new DomainError("INVALID_OPERATION", "The room event and activity must target the same room.");
  }
  const guards = input.guards ?? [];
  if (!Array.isArray(guards) || guards.length > ACTIVITY_HISTORY_ROOM_COMMIT_GUARD_LIMIT) {
    throw new DomainError(
      "INVALID_OPERATION",
      `An atomic room commit supports at most ${ACTIVITY_HISTORY_ROOM_COMMIT_GUARD_LIMIT} exact Redis guards.`,
    );
  }
  for (const guard of guards) {
    if (
      !guard ||
      typeof guard.key !== "string" ||
      guard.key.length === 0 ||
      (guard.expectedValue !== null && typeof guard.expectedValue !== "string")
    ) {
      throw new DomainError("INVALID_OPERATION", "Atomic room commit Redis guards are malformed.");
    }
  }
  const limits = resolveLimits(limitsInput);
  const entry = prepareActivityHistoryEntry(activity, limits);
  const expectedDigests = {
    document: redisRoomPlaneDigest(input.expectedPlanes.document),
    awareness: redisRoomPlaneDigest(input.expectedPlanes.awareness),
    coordination: redisRoomPlaneDigest(input.expectedPlanes.coordination),
  };
  for (const name of ["document", "awareness", "coordination"] as const) {
    const value = input.changedPlanes[name];
    if (hasChangedPlane(input.changedPlanes, name) && value !== undefined) {
      if (redisRoomPlaneDigest(value) === expectedDigests[name]) {
        throw new Error(`Changed ${name} plane must differ from its expected value.`);
      }
      try {
        const parsed = JSON.parse(value) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      } catch {
        throw new Error(`Changed ${name} plane must be an encoded JSON object.`);
      }
    }
  }
  try {
    const event = JSON.parse(input.event.encoded) as unknown;
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error();
  } catch {
    throw new Error("The compact room event must be an encoded JSON object.");
  }
  if (input.receipt) {
    positiveSafeInteger(input.receipt.ttlSeconds, "Mutation receipt TTL");
    try {
      const receipt = JSON.parse(input.receipt.encoded) as unknown;
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error();
    } catch {
      throw new Error("The mutation receipt must be an encoded JSON object.");
    }
  }

  const keys = [
    ...appendKeys(entry),
    input.planeKeys.document,
    input.planeKeys.awareness,
    input.planeKeys.coordination,
    input.event.streamKey,
    input.receipt?.key ?? NO_RECEIPT_KEY,
    ...guards.map((guard) => guard.key),
  ];
  if (new Set(keys).size !== keys.length) {
    throw new DomainError(
      "INVALID_OPERATION",
      "Atomic room commit keys and exact Redis guards must be unique.",
    );
  }
  const args = [
    ...appendArguments(entry, limits),
    "1",
    expectedDigests.document,
    expectedDigests.awareness,
    expectedDigests.coordination,
    hasChangedPlane(input.changedPlanes, "document") ? "1" : "0",
    input.changedPlanes.document ?? "",
    hasChangedPlane(input.changedPlanes, "awareness") ? "1" : "0",
    input.changedPlanes.awareness ?? "",
    hasChangedPlane(input.changedPlanes, "coordination") ? "1" : "0",
    input.changedPlanes.coordination ?? "",
    input.event.roomId,
    input.event.encoded,
    input.receipt ? "1" : "0",
    input.receipt?.encoded ?? "",
    String(input.receipt?.ttlSeconds ?? 0),
    String(guards.length),
    ...guards.flatMap((guard) => [
      guard.expectedValue === null ? "0" : "1",
      guard.expectedValue ?? "",
    ]),
  ];
  const requestBytes = commandEnvelopeBytes(APPEND_ACTIVITY_HISTORY_LUA, keys, args);
  if (requestBytes > REDIS_SAFE_PLANE_WRITE_BYTES) {
    throw new DomainError(
      "REQUEST_TOO_LARGE",
      "The atomic room and activity commit exceeds Jazzboard's safe Redis request envelope.",
      { used: requestBytes, limit: REDIS_SAFE_PLANE_WRITE_BYTES },
    );
  }
  return {
    activityId: activity.id,
    roomId: activity.roomId,
    script: APPEND_ACTIVITY_HISTORY_LUA,
    keys,
    arguments: args,
    requestBytes,
  };
}

export function parseActivityHistoryRoomCommitResult(
  result: unknown,
): ActivityHistoryRoomCommitResult {
  const values = redisArray(result);
  switch (values[0]) {
    case "commit_stored": {
      const evictedCount = Number(values[1]);
      const roomBytes = Number(values[2]);
      const deploymentBytes = Number(values[3]);
      if (
        ![evictedCount, roomBytes, deploymentBytes].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      ) {
        throw activityStorageError("Atomic room commit returned malformed history counters.");
      }
      return { status: "stored", evictedCount, roomBytes, deploymentBytes };
    }
    case "commit_replayed":
      if (!values[1]) {
        throw activityStorageError("Atomic room commit replay omitted its mutation receipt.");
      }
      return { status: "replayed", receipt: values[1] };
    case "revision_conflict":
      return { status: "revision_conflict" };
    case "conflict":
    case "capacity":
    case "corrupt":
      // Reuse the activity-only error mapping for exceptional outcomes.
      return parseActivityHistoryAppendResult(values) as never;
    default:
      throw activityStorageError("Atomic room commit returned an unknown outcome.");
  }
}

export async function executeActivityHistoryRoomCommit(
  redis: Redis,
  command: ActivityHistoryRoomCommitCommand,
): Promise<ActivityHistoryRoomCommitResult> {
  const result = await redis.eval(
    command.script,
    command.keys.length,
    ...command.keys,
    ...command.arguments,
  );
  return parseActivityHistoryRoomCommitResult(result);
}

function parseMigrationMarker(value: string): LegacyMigrationMarker {
  const parsed = parseJsonObject(value, "Activity migration marker");
  if (
    parsed.v !== 1 ||
    !Number.isSafeInteger(parsed.total) ||
    Number(parsed.total) < 0 ||
    !Number.isSafeInteger(parsed.next) ||
    Number(parsed.next) < -1 ||
    typeof parsed.migrated !== "number" ||
    !Number.isSafeInteger(parsed.migrated) ||
    Number(parsed.migrated) < 0 ||
    typeof parsed.complete !== "boolean" ||
    !((typeof parsed.head === "string" && /^[a-f0-9]{40}$/.test(parsed.head)) || parsed.head === null) ||
    !((typeof parsed.tail === "string" && /^[a-f0-9]{40}$/.test(parsed.tail)) || parsed.tail === null)
  ) {
    throw activityStorageError("Activity migration marker is malformed.");
  }
  return parsed as LegacyMigrationMarker;
}

function legacyValueDigest(value: string | null): string | null {
  return value === null ? null : createHash("sha1").update(value).digest("hex");
}

export class RedisActivityHistoryStore {
  private readonly limits: ActivityHistoryLimits;

  constructor(
    private readonly redis: Redis,
    limits: Partial<ActivityHistoryLimits> = {},
  ) {
    this.limits = resolveLimits(limits);
  }

  async appendActivity(activity: RoomActivity): Promise<ActivityHistoryAppendResult> {
    const command = createActivityHistoryAppendCommand(activity, this.limits);
    const result = await this.redis.eval(
      command.script,
      command.keys.length,
      ...command.keys,
      ...command.arguments,
    );
    return parseActivityHistoryAppendResult(result);
  }

  async listActivitySummaries(
    roomId: string,
    options: ActivityHistoryListOptions = {},
  ): Promise<RoomActivitySummary[]> {
    assertIdentifier(roomId, "Room ID");
    const limit = Math.min(
      positiveSafeInteger(options.limit ?? 50, "Activity list limit"),
      this.limits.roomEntryCount,
    );
    const before = options.beforeRoomRevision;
    if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) {
      throw new DomainError("INVALID_OPERATION", "beforeRoomRevision must be a positive integer.");
    }
    const members = before === undefined
      ? await this.redis.zrevrange(`${ROOM_INDEX_KEY_PREFIX}${roomId}`, 0, limit - 1)
      : await this.redis.zrevrangebyscore(
          `${ROOM_INDEX_KEY_PREFIX}${roomId}`,
          `(${before}`,
          "-inf",
          "LIMIT",
          0,
          limit,
        );
    if (members.length === 0) return [];
    const encoded = await this.redis.mget(
      ...members.map((activityId) => entryKey(SUMMARY_KEY_PREFIX, roomId, activityId)),
    );
    return encoded.map((value, index) => {
      if (!value) {
        throw activityStorageError("An activity summary index points to a missing record.", {
          roomId,
          activityId: members[index],
        });
      }
      return parseSummary(value, roomId, members[index]);
    });
  }

  async getActivity(roomId: string, activityId: string): Promise<RoomActivity | null> {
    assertIdentifier(roomId, "Room ID");
    assertIdentifier(activityId, "Activity ID");
    const values = await this.redis.mget(
      entryKey(DETAIL_KEY_PREFIX, roomId, activityId),
      entryKey(SUMMARY_KEY_PREFIX, roomId, activityId),
      entryKey(METADATA_KEY_PREFIX, roomId, activityId),
    );
    if (values.every((value) => value === null)) return null;
    if (values.some((value) => value === null)) {
      throw activityStorageError("Activity history detail is only partially present.", { roomId, activityId });
    }
    const [detailJson, summaryJson, metadataJson] = values as [string, string, string];
    const metadata = parseStoredMetadata(metadataJson);
    const expectedGlobalMember = globalIndexMember(roomId, activityId);
    const actualBytes =
      utf8Bytes(detailJson) +
      utf8Bytes(summaryJson) +
      utf8Bytes(metadataJson) +
      utf8Bytes(activityId) +
      utf8Bytes(expectedGlobalMember);
    if (
      metadata.r !== roomId ||
      metadata.i !== activityId ||
      metadata.g !== expectedGlobalMember ||
      metadata.b !== actualBytes ||
      metadata.h !== activityDigest(detailJson, summaryJson)
    ) {
      throw activityStorageError("Activity history detail metadata does not match its payload.", {
        roomId,
        activityId,
      });
    }
    parseSummary(summaryJson, roomId, activityId);
    return parseActivity(detailJson, roomId, activityId);
  }

  /**
   * Migrates the legacy newest-first Redis list one element at a time, starting
   * with its oldest entry. No LRANGE or whole-list transfer is used: every
   * network command is bounded by the existing 1 MiB activity-record limit.
   * A compact compare-and-set marker advances only after the idempotent append,
   * so interruption can at worst replay the same activity ID.
   */
  async migrateLegacyActivities(
    roomId: string,
    options: { maxRecords?: number; maxReadBytes?: number } = {},
  ): Promise<LegacyActivityMigrationResult> {
    assertIdentifier(roomId, "Room ID");
    const maxRecords = positiveSafeInteger(options.maxRecords ?? 8, "Migration record limit");
    const maxReadBytes = positiveSafeInteger(
      options.maxReadBytes ?? LEGACY_ACTIVITY_MIGRATION_MAX_BATCH_BYTES,
      "Migration byte limit",
    );
    if (maxReadBytes >= 8 * MEBIBYTE) {
      throw new Error("Legacy activity migration must remain below the 8 MiB safe command envelope.");
    }

    const legacyKey = `${LEGACY_ACTIVITY_KEY_PREFIX}${roomId}`;
    const markerKey = `${MIGRATION_KEY_PREFIX}${roomId}`;
    let markerEncoded = await this.redis.get(markerKey);
    if (!markerEncoded) {
      const total = await this.redis.llen(legacyKey);
      const head = total > 0 ? await this.redis.lindex(legacyKey, 0) : null;
      const tail = total > 0 ? await this.redis.lindex(legacyKey, total - 1) : null;
      for (const endpoint of [head, tail]) {
        if (endpoint !== null && utf8Bytes(endpoint) > this.limits.incomingBytes) {
          throw new DomainError("REQUEST_TOO_LARGE", "A legacy activity exceeds the migration limit.");
        }
      }
      const initial: LegacyMigrationMarker = {
        v: 1,
        total,
        next: total - 1,
        head: legacyValueDigest(head),
        tail: legacyValueDigest(tail),
        migrated: 0,
        complete: false,
      };
      const candidate = JSON.stringify(initial);
      const stored = await this.redis.set(markerKey, candidate, "NX");
      markerEncoded = stored === "OK" ? candidate : await this.redis.get(markerKey);
      if (!markerEncoded) throw activityStorageError("Activity migration marker could not be established.");
    }

    let migratedThisCall = 0;
    let readBytes = 0;
    for (let attempt = 0; attempt < maxRecords; attempt += 1) {
      const marker = parseMigrationMarker(markerEncoded);
      if (marker.complete) {
        return { status: "complete", migratedCount: migratedThisCall, nextIndex: -1 };
      }
      const currentLength = await this.redis.llen(legacyKey);
      const currentHead = currentLength > 0 ? await this.redis.lindex(legacyKey, 0) : null;
      const currentTail = currentLength > 0
        ? await this.redis.lindex(legacyKey, currentLength - 1)
        : null;
      if (
        currentLength !== marker.total ||
        legacyValueDigest(currentHead) !== marker.head ||
        legacyValueDigest(currentTail) !== marker.tail
      ) {
        throw activityStorageError("Legacy activity history changed during migration.");
      }

      if (marker.next < 0) {
        const complete: LegacyMigrationMarker = { ...marker, complete: true };
        const completeEncoded = JSON.stringify(complete);
        const result = redisArray(await this.redis.eval(
          COMPLETE_MIGRATION_LUA,
          2,
          markerKey,
          legacyKey,
          markerEncoded,
          completeEncoded,
        ));
        if (result[0] === "retry") {
          markerEncoded = await this.redis.get(markerKey);
          if (!markerEncoded) throw activityStorageError("Activity migration marker disappeared.");
          continue;
        }
        return { status: "complete", migratedCount: migratedThisCall, nextIndex: -1 };
      }

      const encodedActivity = await this.redis.lindex(legacyKey, marker.next);
      if (encodedActivity === null) {
        throw activityStorageError("A legacy activity disappeared during migration.");
      }
      const activityBytes = utf8Bytes(encodedActivity);
      if (activityBytes > this.limits.incomingBytes) {
        throw new DomainError("REQUEST_TOO_LARGE", "A legacy activity exceeds the migration limit.", {
          used: activityBytes,
          limit: this.limits.incomingBytes,
        });
      }
      if (migratedThisCall > 0 && readBytes + activityBytes > maxReadBytes) break;
      const parsed = parseJsonObject(encodedActivity, "Legacy activity record") as RoomActivity;
      if (parsed.roomId !== roomId || typeof parsed.id !== "string") {
        throw activityStorageError("A legacy activity does not belong to its room.");
      }
      await this.appendActivity(parsed);

      const advanced: LegacyMigrationMarker = {
        ...marker,
        next: marker.next - 1,
        migrated: marker.migrated + 1,
      };
      const advancedEncoded = JSON.stringify(advanced);
      const result = redisArray(await this.redis.eval(
        ADVANCE_MIGRATION_LUA,
        1,
        markerKey,
        markerEncoded,
        advancedEncoded,
      ));
      if (result[0] === "retry") {
        markerEncoded = await this.redis.get(markerKey);
        if (!markerEncoded) throw activityStorageError("Activity migration marker disappeared.");
        continue;
      }
      markerEncoded = advancedEncoded;
      migratedThisCall += 1;
      readBytes += activityBytes;
    }

    const finalMarker = parseMigrationMarker(markerEncoded);
    return {
      status: finalMarker.complete ? "complete" : "in_progress",
      migratedCount: migratedThisCall,
      nextIndex: finalMarker.next,
    };
  }
}

/** Exposed for integration tests and the room-store cutover; all keys share one Redis hash tag. */
export const activityHistoryKeys = {
  detail(roomId: string, activityId: string) {
    return entryKey(DETAIL_KEY_PREFIX, roomId, activityId);
  },
  summary(roomId: string, activityId: string) {
    return entryKey(SUMMARY_KEY_PREFIX, roomId, activityId);
  },
  metadata(roomId: string, activityId: string) {
    return entryKey(METADATA_KEY_PREFIX, roomId, activityId);
  },
  roomIndex(roomId: string) {
    return `${ROOM_INDEX_KEY_PREFIX}${roomId}`;
  },
  roomCounter(roomId: string) {
    return `${ROOM_COUNTER_KEY_PREFIX}${roomId}`;
  },
  globalIndex: GLOBAL_INDEX_KEY,
  globalCounter: GLOBAL_COUNTER_KEY,
  legacy(roomId: string) {
    return `${LEGACY_ACTIVITY_KEY_PREFIX}${roomId}`;
  },
  migration(roomId: string) {
    return `${MIGRATION_KEY_PREFIX}${roomId}`;
  },
};

/** Compact counter serialization used by tests and later transaction integration. */
export function serializeActivityHistoryCounter(counter: { bytes: number; count: number }): string {
  return counterJson({ v: 1, bytes: counter.bytes, count: counter.count });
}
