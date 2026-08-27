import {
  BLOB_MAXIMUM_SIZE_IN_BYTES,
  isRoomBlobPathname,
} from "@/lib/assets/policy";
import { roomBlobNamespace } from "@/lib/assets/private";
import { DomainError } from "@/lib/domain/errors";
import { randomUUID } from "node:crypto";

import { sha256 } from "./idempotency";
import { getRedisForRealtime } from "./room-store";

export const BLOB_ASSET_CAPACITY_LIMITS = {
  globalBytes: 512 * 1024 * 1024,
  roomBytes: 128 * 1024 * 1024,
  globalAssets: 500,
  roomAssets: 100,
  reservationBytes: BLOB_MAXIMUM_SIZE_IN_BYTES,
  participantPendingReservations: 2,
} as const;

export const BLOB_ASSET_ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const BLOB_ASSET_RESERVATION_RETENTION_MS = 15 * 60 * 1_000;
export const BLOB_ASSET_CLEANUP_CLAIM_LEASE_MS = 5 * 60 * 1_000;
const MAX_OPPORTUNISTIC_RESERVATION_RECLAIMS = 64;

export type BlobAssetCapacityLimits = {
  globalBytes: number;
  roomBytes: number;
  globalAssets: number;
  roomAssets: number;
  reservationBytes: number;
  participantPendingReservations: number;
};

export type BlobAssetRegistration = {
  version: 1;
  pathname: string;
  pathnameHash: string;
  roomId: string;
  roomHash: string;
  participantHash: string;
  status: "reserved" | "committed" | "cleanup-claimed";
  reservationBytes: number;
  size: number | null;
  contentType: string | null;
  etag: string | null;
  createdAt: number;
  finalizedAt: number | null;
  cleanupClaimId: string | null;
  cleanupClaimedAt: number | null;
};

type RegistryRedis = {
  eval(script: string, numberOfKeys: number, ...parameters: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  zadd(key: string, score: number | string, member: string): Promise<unknown>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  zrangebyscore(
    key: string,
    minimum: number | string,
    maximum: number | string,
    ...arguments_: Array<number | string>
  ): Promise<string[]>;
};

type LocalRegistryState = {
  records: Map<string, BlobAssetRegistration>;
  cleanupScores: Map<string, number>;
};

declare global {
  var __jazzboardLocalBlobAssetRegistry: LocalRegistryState | undefined;
}

const KEY_PREFIX = "jazzboard:blob-assets:v1:";
const GLOBAL_COUNTER_KEY = `${KEY_PREFIX}capacity:global`;
const CLEANUP_INDEX_KEY = `${KEY_PREFIX}cleanup`;
const RESERVATION_INDEX_KEY = `${KEY_PREFIX}reservations`;
const PARTICIPANT_RESERVATION_KEY_PREFIX = `${KEY_PREFIX}reservations:participant:`;

const RESERVE_SCRIPT = `
local existing = redis.call("GET", KEYS[1])
if existing then
  local record = cjson.decode(existing)
  if record.pathname ~= ARGV[1] or record.roomHash ~= ARGV[2] or record.participantHash ~= ARGV[3] then
    return {-1, "conflict"}
  end
  return {2, existing}
end

local function key_type(key)
  local result = redis.call("TYPE", key)
  if type(result) == "table" then return result.ok end
  return result
end
local function is_zset_or_missing(key)
  local kind = key_type(key)
  return kind == "none" or kind == "zset"
end
if not is_zset_or_missing(KEYS[4])
  or not is_zset_or_missing(KEYS[5])
  or not is_zset_or_missing(KEYS[6]) then
  return {-1, "integrity"}
end

local function counter(key, field)
  return tonumber(redis.call("HGET", key, field) or "0")
end
local global_reserved_bytes = counter(KEYS[2], "reservedBytes")
local global_committed_bytes = counter(KEYS[2], "committedBytes")
local global_reserved_count = counter(KEYS[2], "reservedCount")
local global_committed_count = counter(KEYS[2], "committedCount")
local room_reserved_bytes = counter(KEYS[3], "reservedBytes")
local room_committed_bytes = counter(KEYS[3], "committedBytes")
local room_reserved_count = counter(KEYS[3], "reservedCount")
local room_committed_count = counter(KEYS[3], "committedCount")
local reservation_bytes = tonumber(ARGV[7])
local participant_pending_count = tonumber(redis.call("ZCARD", KEYS[5]))

if global_reserved_bytes + global_committed_bytes + reservation_bytes > tonumber(ARGV[8]) then
  return {0, "globalBytes", global_reserved_bytes + global_committed_bytes, tonumber(ARGV[8])}
end
if global_reserved_count + global_committed_count + 1 > tonumber(ARGV[9]) then
  return {0, "globalAssets", global_reserved_count + global_committed_count, tonumber(ARGV[9])}
end
if room_reserved_bytes + room_committed_bytes + reservation_bytes > tonumber(ARGV[10]) then
  return {0, "roomBytes", room_reserved_bytes + room_committed_bytes, tonumber(ARGV[10])}
end
if room_reserved_count + room_committed_count + 1 > tonumber(ARGV[11]) then
  return {0, "roomAssets", room_reserved_count + room_committed_count, tonumber(ARGV[11])}
end
if participant_pending_count + 1 > tonumber(ARGV[12]) then
  return {0, "participantPendingReservations", participant_pending_count, tonumber(ARGV[12])}
end

redis.call("HINCRBY", KEYS[2], "reservedBytes", reservation_bytes)
redis.call("HINCRBY", KEYS[2], "reservedCount", 1)
redis.call("HINCRBY", KEYS[3], "reservedBytes", reservation_bytes)
redis.call("HINCRBY", KEYS[3], "reservedCount", 1)
redis.call("SET", KEYS[1], ARGV[4])
redis.call("ZADD", KEYS[4], ARGV[5], ARGV[6])
redis.call("ZADD", KEYS[5], ARGV[5], ARGV[6])
redis.call("ZADD", KEYS[6], ARGV[5], ARGV[6])
return {1, ARGV[4]}
`;

const FINALIZE_SCRIPT = `
local encoded = redis.call("GET", KEYS[1])
if not encoded then return {0, "missing"} end
local record = cjson.decode(encoded)
if record.pathname ~= ARGV[1] then return {-1, "conflict"} end
if ARGV[2] ~= "" and record.roomHash ~= ARGV[2] then return {-1, "conflict"} end
local size = tonumber(ARGV[3])
if record.status == "committed" or record.status == "cleanup-claimed" then
  if tonumber(record.size) ~= size or record.etag ~= ARGV[5] or record.contentType ~= ARGV[4] then
    return {-1, "changed"}
  end
  return {2, encoded}
end
if record.status ~= "reserved" or size < 1 or size > tonumber(record.reservationBytes) then
  return {-1, "invalid"}
end

local global_reserved_bytes = tonumber(redis.call("HGET", KEYS[2], "reservedBytes") or "0")
local global_reserved_count = tonumber(redis.call("HGET", KEYS[2], "reservedCount") or "0")
local room_reserved_bytes = tonumber(redis.call("HGET", KEYS[3], "reservedBytes") or "0")
local room_reserved_count = tonumber(redis.call("HGET", KEYS[3], "reservedCount") or "0")
if global_reserved_bytes < tonumber(record.reservationBytes) or
   room_reserved_bytes < tonumber(record.reservationBytes) or
   global_reserved_count < 1 or room_reserved_count < 1 then
  return {-1, "counter"}
end

local function key_type(key)
  local result = redis.call("TYPE", key)
  if type(result) == "table" then return result.ok end
  return result
end
local function is_zset_or_missing(key)
  local kind = key_type(key)
  return kind == "none" or kind == "zset"
end
if not is_zset_or_missing(KEYS[4])
  or not is_zset_or_missing(KEYS[5])
  or not is_zset_or_missing(KEYS[6]) then
  return {-1, "integrity"}
end

redis.call("HINCRBY", KEYS[2], "reservedBytes", -tonumber(record.reservationBytes))
redis.call("HINCRBY", KEYS[2], "reservedCount", -1)
redis.call("HINCRBY", KEYS[2], "committedBytes", size)
redis.call("HINCRBY", KEYS[2], "committedCount", 1)
redis.call("HINCRBY", KEYS[3], "reservedBytes", -tonumber(record.reservationBytes))
redis.call("HINCRBY", KEYS[3], "reservedCount", -1)
redis.call("HINCRBY", KEYS[3], "committedBytes", size)
redis.call("HINCRBY", KEYS[3], "committedCount", 1)
record.status = "committed"
record.size = size
record.contentType = ARGV[4]
record.etag = ARGV[5]
record.finalizedAt = tonumber(ARGV[6])
local finalized = cjson.encode(record)
redis.call("SET", KEYS[1], finalized)
redis.call("ZADD", KEYS[4], ARGV[6], ARGV[7])
redis.call("ZREM", KEYS[5], ARGV[7])
redis.call("ZREM", KEYS[6], ARGV[7])
return {1, finalized}
`;

const DELETE_SCRIPT = `
local encoded = redis.call("GET", KEYS[1])
if not encoded then return {0, "missing"} end
local record = cjson.decode(encoded)
if record.pathname ~= ARGV[1] then return {-1, "conflict"} end
if ARGV[2] ~= ""
  and (record.status == "committed" or record.status == "cleanup-claimed")
  and record.etag ~= ARGV[2] then
  return {-1, "changed"}
end
if ARGV[4] ~= "" and record.status ~= ARGV[4] then return {-1, "changed"} end
if ARGV[5] ~= "" and tonumber(record.createdAt) ~= tonumber(ARGV[5]) then
  return {-1, "changed"}
end
if ARGV[6] ~= "" and (
  record.status ~= "cleanup-claimed" or record.cleanupClaimId ~= ARGV[6]
) then return {-1, "changed"} end
local is_committed = record.status == "committed" or record.status == "cleanup-claimed"
local byte_field = is_committed and "committedBytes" or "reservedBytes"
local count_field = is_committed and "committedCount" or "reservedCount"
local bytes = is_committed and tonumber(record.size) or tonumber(record.reservationBytes)
local global_bytes = tonumber(redis.call("HGET", KEYS[2], byte_field) or "0")
local global_count = tonumber(redis.call("HGET", KEYS[2], count_field) or "0")
local room_bytes = tonumber(redis.call("HGET", KEYS[3], byte_field) or "0")
local room_count = tonumber(redis.call("HGET", KEYS[3], count_field) or "0")
if global_bytes < bytes or room_bytes < bytes or global_count < 1 or room_count < 1 then
  return {-1, "counter"}
end
local function key_type(key)
  local result = redis.call("TYPE", key)
  if type(result) == "table" then return result.ok end
  return result
end
local function is_zset_or_missing(key)
  local kind = key_type(key)
  return kind == "none" or kind == "zset"
end
if not is_zset_or_missing(KEYS[4])
  or not is_zset_or_missing(KEYS[5])
  or not is_zset_or_missing(KEYS[6]) then
  return {-1, "integrity"}
end
redis.call("HINCRBY", KEYS[2], byte_field, -bytes)
redis.call("HINCRBY", KEYS[2], count_field, -1)
redis.call("HINCRBY", KEYS[3], byte_field, -bytes)
redis.call("HINCRBY", KEYS[3], count_field, -1)
redis.call("DEL", KEYS[1])
redis.call("ZREM", KEYS[4], ARGV[3])
redis.call("ZREM", KEYS[5], ARGV[3])
redis.call("ZREM", KEYS[6], ARGV[3])
return {1, encoded}
`;

const CLAIM_COMMITTED_CLEANUP_SCRIPT = `
local encoded = redis.call("GET", KEYS[1])
if not encoded then return {0, "missing"} end
local record = cjson.decode(encoded)
local now_ms = tonumber(ARGV[4])
local lease_ms = tonumber(ARGV[5])
if record.pathname ~= ARGV[1] then return {-1, "conflict"} end
if record.roomHash ~= ARGV[6] then return {-1, "conflict"} end
if not now_ms or now_ms < 0 or now_ms % 1 ~= 0
  or not lease_ms or lease_ms < 1 or lease_ms % 1 ~= 0
  or ARGV[3] == "" then return {-1, "invalid"} end
if record.status == "reserved" then return {0, "not_eligible"} end
if record.status == "cleanup-claimed" then
  if type(record.cleanupClaimId) ~= "string"
    or type(record.cleanupClaimedAt) ~= "number"
    or record.cleanupClaimedAt < 0
    or record.cleanupClaimedAt % 1 ~= 0 then return {-1, "integrity"} end
  if record.cleanupClaimId ~= ARGV[3]
    and record.cleanupClaimedAt + lease_ms > now_ms then return {0, "busy"} end
  if record.etag ~= ARGV[2] then return {-1, "changed"} end
  local disposition = record.cleanupClaimId == ARGV[3] and "resumed" or "recovered"
  record.cleanupClaimId = ARGV[3]
  record.cleanupClaimedAt = now_ms
  local claimed = cjson.encode(record)
  redis.call("SET", KEYS[1], claimed)
  return {1, claimed, disposition}
end
if record.status ~= "committed" then return {-1, "integrity"} end
if record.etag ~= ARGV[2] then return {-1, "changed"} end
record.status = "cleanup-claimed"
record.cleanupClaimId = ARGV[3]
record.cleanupClaimedAt = now_ms
local claimed = cjson.encode(record)
redis.call("SET", KEYS[1], claimed)
return {1, claimed, "fresh"}
`;

const RELEASE_COMMITTED_CLEANUP_CLAIM_SCRIPT = `
local encoded = redis.call("GET", KEYS[1])
if not encoded then return {0, "missing"} end
local record = cjson.decode(encoded)
local next_check_at = tonumber(ARGV[3])
if record.pathname ~= ARGV[1] then return {-1, "conflict"} end
if record.roomHash ~= ARGV[5] then return {-1, "conflict"} end
if record.status ~= "cleanup-claimed" or record.cleanupClaimId ~= ARGV[2] then
  return {-1, "changed"}
end
if not next_check_at or next_check_at < 0 or next_check_at % 1 ~= 0 then
  return {-1, "invalid"}
end
local key_type = redis.call("TYPE", KEYS[2])
if type(key_type) == "table" then key_type = key_type.ok end
if key_type ~= "none" and key_type ~= "zset" then return {-1, "integrity"} end
record.status = "committed"
record.cleanupClaimId = cjson.null
record.cleanupClaimedAt = cjson.null
local released = cjson.encode(record)
redis.call("SET", KEYS[1], released)
redis.call("ZADD", KEYS[2], next_check_at, ARGV[4])
return {1, released}
`;

function localState(): LocalRegistryState {
  globalThis.__jazzboardLocalBlobAssetRegistry ??= {
    records: new Map(),
    cleanupScores: new Map(),
  };
  return globalThis.__jazzboardLocalBlobAssetRegistry;
}

function redis(): RegistryRedis | null {
  return getRedisForRealtime() as RegistryRedis | null;
}

function assertLocalRegistryAllowed(): void {
  if (process.env.VERCEL === "1") {
    throw new DomainError(
      "INVALID_OPERATION",
      "Private image capacity storage is unavailable.",
    );
  }
}

function pathnameHash(pathname: string): string {
  return sha256(`jazzboard:blob-asset-path:v1\0${pathname}`);
}

function roomHash(roomId: string): string {
  return sha256(`jazzboard:blob-asset-room:v1\0${roomId}`);
}

function participantHash(participantId: string): string {
  return sha256(`jazzboard:blob-asset-participant:v1\0${participantId}`);
}

function recordKey(hash: string): string {
  return `${KEY_PREFIX}path:${hash}`;
}

function roomCounterKey(hash: string): string {
  return `${KEY_PREFIX}capacity:room:${hash}`;
}

function participantReservationKey(hash: string): string {
  return `${PARTICIPANT_RESERVATION_KEY_PREFIX}${hash}`;
}

export function privateBlobAssetRegistrationRedisKey(pathname: string): string {
  return recordKey(pathnameHash(pathname));
}

export function isPrivateBlobAssetReferenceEligible(
  registration: BlobAssetRegistration | null | undefined,
): registration is BlobAssetRegistration & { status: "committed" } {
  return registration?.status === "committed";
}

export function isPrivateBlobAssetReadable(
  registration: BlobAssetRegistration | null | undefined,
): registration is BlobAssetRegistration & { status: "committed" | "cleanup-claimed" } {
  return registration?.status === "committed" || registration?.status === "cleanup-claimed";
}

export function parsePrivateBlobAssetRegistration(
  encoded: string | null,
): BlobAssetRegistration | null {
  if (!encoded) return null;
  try {
    const candidate = JSON.parse(encoded) as Partial<BlobAssetRegistration>;
    const cleanupClaimId = candidate.cleanupClaimId ?? null;
    const cleanupClaimedAt = candidate.cleanupClaimedAt ?? null;
    if (
      candidate.version !== 1 ||
      typeof candidate.pathname !== "string" ||
      typeof candidate.pathnameHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.pathnameHash) ||
      typeof candidate.roomId !== "string" ||
      typeof candidate.roomHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.roomHash) ||
      typeof candidate.participantHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.participantHash) ||
      (candidate.status !== "reserved" &&
        candidate.status !== "committed" &&
        candidate.status !== "cleanup-claimed") ||
      !Number.isSafeInteger(candidate.reservationBytes) ||
      candidate.reservationBytes! < 1 ||
      !Number.isSafeInteger(candidate.createdAt) ||
      candidate.createdAt! < 0 ||
      (candidate.status === "reserved" &&
        (candidate.size !== null ||
          candidate.contentType !== null ||
          candidate.etag !== null ||
          candidate.finalizedAt !== null ||
          cleanupClaimId !== null ||
          cleanupClaimedAt !== null)) ||
      ((candidate.status === "committed" || candidate.status === "cleanup-claimed") &&
        (!Number.isSafeInteger(candidate.size) ||
          candidate.size! < 1 ||
          typeof candidate.contentType !== "string" ||
          typeof candidate.etag !== "string" ||
          !candidate.etag ||
          !Number.isSafeInteger(candidate.finalizedAt) ||
          candidate.finalizedAt! < candidate.createdAt!)) ||
      (candidate.status === "committed" &&
        (cleanupClaimId !== null || cleanupClaimedAt !== null)) ||
      (candidate.status === "cleanup-claimed" &&
        (typeof cleanupClaimId !== "string" ||
          cleanupClaimId.length < 1 ||
          cleanupClaimId.length > 128 ||
          !Number.isSafeInteger(cleanupClaimedAt) ||
          cleanupClaimedAt! < 0))
    ) {
      throw new Error("invalid registry record");
    }
    if (
      candidate.pathnameHash !== pathnameHash(candidate.pathname) ||
      candidate.roomHash !== roomHash(candidate.roomId) ||
      !isRoomBlobPathname(roomBlobNamespace(candidate.roomId), candidate.pathname)
    ) {
      throw new Error("mismatched registry identity");
    }
    return {
      ...(candidate as BlobAssetRegistration),
      cleanupClaimId,
      cleanupClaimedAt,
    };
  } catch {
    throw new DomainError(
      "INVALID_OPERATION",
      "Jazzboard cannot safely read this private image registration.",
    );
  }
}

function assertCapacityLimits(limits: BlobAssetCapacityLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("Blob asset capacity limits must be positive safe integers.");
    }
  }
  if (limits.reservationBytes > limits.roomBytes || limits.roomBytes > limits.globalBytes) {
    throw new Error("Blob asset byte limits must be ordered reservation <= room <= global.");
  }
}

function capacityError(
  dimension: string,
  used: number,
  limit: number,
): DomainError {
  return new DomainError(
    "ASSET_CAPACITY_EXCEEDED",
    "Jazzboard's private image capacity is temporarily full.",
    { dimension, used, limit },
  );
}

function assertPathForRoom(roomId: string, pathname: string): void {
  if (!isRoomBlobPathname(roomBlobNamespace(roomId), pathname)) {
    throw new DomainError("INVALID_OPERATION", "The private image pathname is invalid.");
  }
}

function localUsage(
  records: Iterable<BlobAssetRegistration>,
  selectedRoomHash?: string,
): { reservedBytes: number; committedBytes: number; reservedCount: number; committedCount: number } {
  const usage = { reservedBytes: 0, committedBytes: 0, reservedCount: 0, committedCount: 0 };
  for (const record of records) {
    if (selectedRoomHash && record.roomHash !== selectedRoomHash) continue;
    if (record.status === "reserved") {
      usage.reservedBytes += record.reservationBytes;
      usage.reservedCount += 1;
    } else {
      usage.committedBytes += record.size ?? 0;
      usage.committedCount += 1;
    }
  }
  return usage;
}

type ReservePrivateBlobAssetInput = {
  pathname: string;
  roomId: string;
  participantId: string;
  now?: number;
  limits?: BlobAssetCapacityLimits;
};

export type BlobAssetReservationOutcome = {
  registration: BlobAssetRegistration;
  created: boolean;
};

async function reclaimExpiredPrivateBlobReservations(now: number): Promise<void> {
  const cutoff = now - BLOB_ASSET_RESERVATION_RETENTION_MS;
  const connection = redis();
  let candidates: BlobAssetRegistration[];
  if (!connection) {
    assertLocalRegistryAllowed();
    candidates = [...localState().records.values()]
      .filter((candidate) => candidate.status === "reserved" && candidate.createdAt <= cutoff)
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, MAX_OPPORTUNISTIC_RESERVATION_RECLAIMS)
      .map((candidate) => structuredClone(candidate));
  } else {
    const hashes = await connection.zrangebyscore(
      RESERVATION_INDEX_KEY,
      "-inf",
      cutoff,
      "LIMIT",
      0,
      MAX_OPPORTUNISTIC_RESERVATION_RECLAIMS,
    );
    if (!hashes.length) return;
    const encoded = await connection.mget(...hashes.map(recordKey));
    const staleIndexMembers: string[] = [];
    candidates = encoded.flatMap((value, index) => {
      const candidate = parsePrivateBlobAssetRegistration(value);
      if (!candidate || candidate.status !== "reserved") {
        staleIndexMembers.push(hashes[index]);
        return [];
      }
      return candidate.createdAt <= cutoff ? [candidate] : [];
    });
    if (staleIndexMembers.length) {
      await connection.zrem(RESERVATION_INDEX_KEY, ...staleIndexMembers);
    }
  }
  for (const candidate of candidates) {
    await deletePrivateBlobAssetRegistration({
      pathname: candidate.pathname,
      expectedStatus: "reserved",
      expectedCreatedAt: candidate.createdAt,
    });
  }
}

export async function reservePrivateBlobAssetWithOutcome(
  input: ReservePrivateBlobAssetInput,
): Promise<BlobAssetReservationOutcome> {
  const limits = input.limits ?? BLOB_ASSET_CAPACITY_LIMITS;
  assertCapacityLimits(limits);
  assertPathForRoom(input.roomId, input.pathname);
  const now = input.now ?? Date.now();
  await reclaimExpiredPrivateBlobReservations(now);
  const pathHash = pathnameHash(input.pathname);
  const selectedRoomHash = roomHash(input.roomId);
  const selectedParticipantHash = participantHash(input.participantId);
  const record: BlobAssetRegistration = {
    version: 1,
    pathname: input.pathname,
    pathnameHash: pathHash,
    roomId: input.roomId,
    roomHash: selectedRoomHash,
    participantHash: selectedParticipantHash,
    status: "reserved",
    reservationBytes: limits.reservationBytes,
    size: null,
    contentType: null,
    etag: null,
    createdAt: now,
    finalizedAt: null,
    cleanupClaimId: null,
    cleanupClaimedAt: null,
  };

  const connection = redis();
  if (!connection) {
    assertLocalRegistryAllowed();
    const state = localState();
    const existing = state.records.get(pathHash);
    if (existing) {
      if (
        existing.pathname !== input.pathname ||
        existing.roomHash !== selectedRoomHash ||
        existing.participantHash !== selectedParticipantHash
      ) {
        throw new DomainError("INVALID_OPERATION", "That private image pathname is already reserved.");
      }
      return { registration: structuredClone(existing), created: false };
    }
    const global = localUsage(state.records.values());
    const room = localUsage(state.records.values(), selectedRoomHash);
    const participantPendingReservations = [...state.records.values()].filter(
      (candidate) =>
        candidate.status === "reserved" &&
        candidate.participantHash === selectedParticipantHash,
    ).length;
    const checks = [
      ["globalBytes", global.reservedBytes + global.committedBytes, limits.globalBytes, limits.reservationBytes],
      ["globalAssets", global.reservedCount + global.committedCount, limits.globalAssets, 1],
      ["roomBytes", room.reservedBytes + room.committedBytes, limits.roomBytes, limits.reservationBytes],
      ["roomAssets", room.reservedCount + room.committedCount, limits.roomAssets, 1],
      [
        "participantPendingReservations",
        participantPendingReservations,
        limits.participantPendingReservations,
        1,
      ],
    ] as const;
    for (const [dimension, used, limit, addition] of checks) {
      if (used + addition > limit) throw capacityError(dimension, used, limit);
    }
    state.records.set(pathHash, record);
    state.cleanupScores.set(pathHash, now);
    return { registration: structuredClone(record), created: true };
  }

  const result = await connection.eval(
    RESERVE_SCRIPT,
    6,
    recordKey(pathHash),
    GLOBAL_COUNTER_KEY,
    roomCounterKey(selectedRoomHash),
    CLEANUP_INDEX_KEY,
    participantReservationKey(selectedParticipantHash),
    RESERVATION_INDEX_KEY,
    input.pathname,
    selectedRoomHash,
    selectedParticipantHash,
    JSON.stringify(record),
    now.toString(),
    pathHash,
    limits.reservationBytes.toString(),
    limits.globalBytes.toString(),
    limits.globalAssets.toString(),
    limits.roomBytes.toString(),
    limits.roomAssets.toString(),
    limits.participantPendingReservations.toString(),
  );
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error("Redis returned an invalid Blob reservation result.");
  }
  const status = Number(result[0]);
  if (status === 1 || status === 2) {
    const parsed = parsePrivateBlobAssetRegistration(String(result[1]));
    if (!parsed) throw new Error("Redis omitted a Blob reservation record.");
    return { registration: parsed, created: status === 1 };
  }
  if (status === 0) {
    throw capacityError(String(result[1]), Number(result[2]), Number(result[3]));
  }
  throw new DomainError("INVALID_OPERATION", "That private image pathname is already reserved.");
}

export async function reservePrivateBlobAsset(
  input: ReservePrivateBlobAssetInput,
): Promise<BlobAssetRegistration> {
  return (await reservePrivateBlobAssetWithOutcome(input)).registration;
}

export async function getPrivateBlobAssetRegistration(
  pathname: string,
): Promise<BlobAssetRegistration | null> {
  const hash = pathnameHash(pathname);
  const connection = redis();
  if (!connection) {
    assertLocalRegistryAllowed();
    return structuredClone(localState().records.get(hash) ?? null);
  }
  return parsePrivateBlobAssetRegistration(await connection.get(recordKey(hash)));
}

export async function getPrivateBlobAssetRegistrations(
  pathnames: readonly string[],
): Promise<Map<string, BlobAssetRegistration>> {
  const result = new Map<string, BlobAssetRegistration>();
  if (!pathnames.length) return result;
  const hashes = pathnames.map(pathnameHash);
  const connection = redis();
  if (!connection) assertLocalRegistryAllowed();
  const records = connection
    ? await connection.mget(...hashes.map(recordKey))
    : hashes.map((hash) => {
        const record = localState().records.get(hash);
        return record ? JSON.stringify(record) : null;
      });
  records.forEach((encoded, index) => {
    const record = parsePrivateBlobAssetRegistration(encoded);
    if (record?.pathname === pathnames[index]) result.set(pathnames[index], record);
  });
  return result;
}

export async function getCommittedPrivateBlobAsset(
  roomId: string,
  pathname: string,
): Promise<BlobAssetRegistration | null> {
  assertPathForRoom(roomId, pathname);
  const record = await getPrivateBlobAssetRegistration(pathname);
  return record?.roomId === roomId && isPrivateBlobAssetReadable(record) ? record : null;
}

export async function finalizePrivateBlobAssetRegistration(input: {
  pathname: string;
  roomId?: string;
  size: number;
  contentType: string;
  etag: string;
  now?: number;
}): Promise<BlobAssetRegistration> {
  if (!Number.isSafeInteger(input.size) || input.size < 1) {
    throw new DomainError("INVALID_OPERATION", "The private image size is invalid.");
  }
  const existing = await getPrivateBlobAssetRegistration(input.pathname);
  if (!existing || (input.roomId && existing.roomId !== input.roomId)) {
    throw new DomainError("INVALID_OPERATION", "That private image upload is not registered.");
  }
  assertPathForRoom(existing.roomId, input.pathname);
  if (input.size > existing.reservationBytes) {
    throw new DomainError("INVALID_OPERATION", "The private image exceeds its reserved capacity.");
  }
  const now = input.now ?? Date.now();
  const connection = redis();
  if (!connection) {
    assertLocalRegistryAllowed();
    if (isPrivateBlobAssetReadable(existing)) {
      if (
        existing.size !== input.size ||
        existing.contentType !== input.contentType ||
        existing.etag !== input.etag
      ) {
        throw new DomainError("INVALID_OPERATION", "The committed private image changed unexpectedly.");
      }
      return existing;
    }
    const finalized: BlobAssetRegistration = {
      ...existing,
      status: "committed",
      size: input.size,
      contentType: input.contentType,
      etag: input.etag,
      finalizedAt: now,
      cleanupClaimId: null,
      cleanupClaimedAt: null,
    };
    const state = localState();
    state.records.set(existing.pathnameHash, finalized);
    state.cleanupScores.set(existing.pathnameHash, now);
    return structuredClone(finalized);
  }

  const result = await connection.eval(
    FINALIZE_SCRIPT,
    6,
    recordKey(existing.pathnameHash),
    GLOBAL_COUNTER_KEY,
    roomCounterKey(existing.roomHash),
    CLEANUP_INDEX_KEY,
    participantReservationKey(existing.participantHash),
    RESERVATION_INDEX_KEY,
    input.pathname,
    input.roomId ? roomHash(input.roomId) : "",
    input.size.toString(),
    input.contentType,
    input.etag,
    now.toString(),
    existing.pathnameHash,
  );
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error("Redis returned an invalid Blob finalization result.");
  }
  const status = Number(result[0]);
  if (status === 1 || status === 2) {
    const parsed = parsePrivateBlobAssetRegistration(String(result[1]));
    if (!parsed) throw new Error("Redis omitted a finalized Blob record.");
    return parsed;
  }
  throw new DomainError("INVALID_OPERATION", "The private image could not be finalized safely.");
}

export type BlobAssetCleanupClaim = {
  claimId: string;
  registration: BlobAssetRegistration;
  disposition: "fresh" | "resumed" | "recovered";
};

export type BlobAssetCleanupClaimAttempt =
  | { outcome: "claimed"; claim: BlobAssetCleanupClaim }
  | { outcome: "busy" | "missing" | "not_eligible" };

export async function claimCommittedPrivateBlobAssetForCleanup(input: {
  pathname: string;
  roomId: string;
  expectedEtag: string;
  claimId?: string;
  now?: number;
  leaseMs?: number;
}): Promise<BlobAssetCleanupClaimAttempt> {
  assertPathForRoom(input.roomId, input.pathname);
  const claimId = input.claimId ?? randomUUID();
  const now = input.now ?? Date.now();
  const leaseMs = input.leaseMs ?? BLOB_ASSET_CLEANUP_CLAIM_LEASE_MS;
  if (
    !input.expectedEtag ||
    !claimId ||
    claimId.length > 128 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 1
  ) {
    throw new DomainError("INVALID_OPERATION", "The private image cleanup claim is invalid.");
  }

  const connection = redis();
  if (!connection) {
    assertLocalRegistryAllowed();
    const state = localState();
    const hash = pathnameHash(input.pathname);
    const existing = state.records.get(hash);
    if (!existing) return { outcome: "missing" };
    if (existing.roomId !== input.roomId || existing.pathname !== input.pathname) {
      throw new DomainError("INVALID_OPERATION", "The private image cleanup identity changed.");
    }
    if (existing.status === "reserved") return { outcome: "not_eligible" };
    if (existing.etag !== input.expectedEtag) {
      throw new DomainError("INVALID_OPERATION", "The private image changed during cleanup.");
    }
    let disposition: BlobAssetCleanupClaim["disposition"] = "fresh";
    if (existing.status === "cleanup-claimed") {
      if (
        existing.cleanupClaimId !== claimId &&
        (existing.cleanupClaimedAt ?? Number.POSITIVE_INFINITY) + leaseMs > now
      ) {
        return { outcome: "busy" };
      }
      disposition = existing.cleanupClaimId === claimId ? "resumed" : "recovered";
    }
    const registration: BlobAssetRegistration = {
      ...existing,
      status: "cleanup-claimed",
      cleanupClaimId: claimId,
      cleanupClaimedAt: now,
    };
    state.records.set(hash, registration);
    return {
      outcome: "claimed",
      claim: { claimId, registration: structuredClone(registration), disposition },
    };
  }

  const result = await connection.eval(
    CLAIM_COMMITTED_CLEANUP_SCRIPT,
    1,
    privateBlobAssetRegistrationRedisKey(input.pathname),
    input.pathname,
    input.expectedEtag,
    claimId,
    now.toString(),
    leaseMs.toString(),
    roomHash(input.roomId),
  );
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error("Redis returned an invalid private image cleanup claim result.");
  }
  if (Number(result[0]) === 0) {
    const outcome = String(result[1]);
    if (outcome === "busy" || outcome === "missing" || outcome === "not_eligible") {
      return { outcome };
    }
  }
  if (Number(result[0]) === 1) {
    const registration = parsePrivateBlobAssetRegistration(String(result[1]));
    const disposition = String(result[2]);
    if (
      !registration ||
      registration.status !== "cleanup-claimed" ||
      registration.roomId !== input.roomId ||
      registration.cleanupClaimId !== claimId ||
      (disposition !== "fresh" && disposition !== "resumed" && disposition !== "recovered")
    ) {
      throw new Error("Redis returned an invalid private image cleanup claim record.");
    }
    return {
      outcome: "claimed",
      claim: { claimId, registration, disposition },
    };
  }
  throw new DomainError("INVALID_OPERATION", "The private image could not be claimed for cleanup.");
}

export async function releasePrivateBlobAssetCleanupClaim(input: {
  pathname: string;
  roomId: string;
  claimId: string;
  nextCheckAt: number;
}): Promise<BlobAssetRegistration | null> {
  assertPathForRoom(input.roomId, input.pathname);
  if (
    !input.claimId ||
    input.claimId.length > 128 ||
    !Number.isSafeInteger(input.nextCheckAt) ||
    input.nextCheckAt < 0
  ) {
    throw new DomainError("INVALID_OPERATION", "The private image cleanup release is invalid.");
  }
  const hash = pathnameHash(input.pathname);
  const connection = redis();
  if (!connection) {
    assertLocalRegistryAllowed();
    const state = localState();
    const existing = state.records.get(hash);
    if (!existing) return null;
    if (
      existing.pathname !== input.pathname ||
      existing.roomId !== input.roomId ||
      existing.status !== "cleanup-claimed" ||
      existing.cleanupClaimId !== input.claimId
    ) {
      throw new DomainError("INVALID_OPERATION", "The private image cleanup claim changed.");
    }
    const released: BlobAssetRegistration = {
      ...existing,
      status: "committed",
      cleanupClaimId: null,
      cleanupClaimedAt: null,
    };
    state.records.set(hash, released);
    state.cleanupScores.set(hash, input.nextCheckAt);
    return structuredClone(released);
  }
  const result = await connection.eval(
    RELEASE_COMMITTED_CLEANUP_CLAIM_SCRIPT,
    2,
    recordKey(hash),
    CLEANUP_INDEX_KEY,
    input.pathname,
    input.claimId,
    input.nextCheckAt.toString(),
    hash,
    roomHash(input.roomId),
  );
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error("Redis returned an invalid private image cleanup release result.");
  }
  if (Number(result[0]) === 0) return null;
  if (Number(result[0]) !== 1) {
    throw new DomainError("INVALID_OPERATION", "The private image cleanup claim changed.");
  }
  const released = parsePrivateBlobAssetRegistration(String(result[1]));
  if (!released || released.status !== "committed" || released.roomId !== input.roomId) {
    throw new Error("Redis returned an invalid released private image registration.");
  }
  return released;
}

export async function listPrivateBlobAssetCleanupCandidates(
  olderThan: number,
  limit = 500,
): Promise<BlobAssetRegistration[]> {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
  const connection = redis();
  if (!connection) {
    assertLocalRegistryAllowed();
    const state = localState();
    return [...state.cleanupScores.entries()]
      .filter(([, score]) => score <= olderThan)
      .sort((left, right) => left[1] - right[1])
      .slice(0, boundedLimit)
      .flatMap(([hash]) => state.records.get(hash) ?? [])
      .map((record) => structuredClone(record));
  }
  const hashes = await connection.zrangebyscore(
    CLEANUP_INDEX_KEY,
    "-inf",
    olderThan,
    "LIMIT",
    0,
    boundedLimit,
  );
  if (!hashes.length) return [];
  const encoded = await connection.mget(...hashes.map(recordKey));
  const staleIndexMembers = hashes.filter((_, index) => encoded[index] === null);
  if (staleIndexMembers.length) {
    await connection.zrem(CLEANUP_INDEX_KEY, ...staleIndexMembers);
  }
  return encoded.flatMap((value) => parsePrivateBlobAssetRegistration(value) ?? []);
}

export async function deferPrivateBlobAssetCleanup(
  pathname: string,
  nextCheckAt: number,
): Promise<void> {
  const hash = pathnameHash(pathname);
  const connection = redis();
  if (!connection) {
    assertLocalRegistryAllowed();
    if (localState().records.has(hash)) localState().cleanupScores.set(hash, nextCheckAt);
    return;
  }
  await connection.zadd(CLEANUP_INDEX_KEY, nextCheckAt, hash);
}

export async function deletePrivateBlobAssetRegistration(input: {
  pathname: string;
  expectedEtag?: string | null;
  expectedStatus?: BlobAssetRegistration["status"];
  expectedCreatedAt?: number;
  expectedCleanupClaimId?: string;
}): Promise<BlobAssetRegistration | null> {
  if (
    input.expectedCreatedAt !== undefined &&
    (!Number.isSafeInteger(input.expectedCreatedAt) || input.expectedCreatedAt < 0)
  ) {
    throw new DomainError("INVALID_OPERATION", "The private image cleanup generation is invalid.");
  }
  if (
    input.expectedCleanupClaimId !== undefined &&
    (!input.expectedCleanupClaimId || input.expectedCleanupClaimId.length > 128)
  ) {
    throw new DomainError("INVALID_OPERATION", "The private image cleanup claim is invalid.");
  }
  const existing = await getPrivateBlobAssetRegistration(input.pathname);
  if (!existing) return null;
  if (input.expectedEtag && existing.etag && input.expectedEtag !== existing.etag) {
    throw new DomainError("INVALID_OPERATION", "The private image changed during cleanup.");
  }
  if (
    (input.expectedStatus && existing.status !== input.expectedStatus) ||
    (input.expectedCreatedAt !== undefined && existing.createdAt !== input.expectedCreatedAt) ||
    (input.expectedCleanupClaimId !== undefined &&
      (existing.status !== "cleanup-claimed" ||
        existing.cleanupClaimId !== input.expectedCleanupClaimId))
  ) {
    throw new DomainError("INVALID_OPERATION", "The private image changed during cleanup.");
  }
  const connection = redis();
  if (!connection) {
    assertLocalRegistryAllowed();
    const state = localState();
    state.records.delete(existing.pathnameHash);
    state.cleanupScores.delete(existing.pathnameHash);
    return existing;
  }
  const result = await connection.eval(
    DELETE_SCRIPT,
    6,
    recordKey(existing.pathnameHash),
    GLOBAL_COUNTER_KEY,
    roomCounterKey(existing.roomHash),
    CLEANUP_INDEX_KEY,
    participantReservationKey(existing.participantHash),
    RESERVATION_INDEX_KEY,
    input.pathname,
    input.expectedEtag ?? "",
    existing.pathnameHash,
    input.expectedStatus ?? "",
    input.expectedCreatedAt?.toString() ?? "",
    input.expectedCleanupClaimId ?? "",
  );
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error("Redis returned an invalid Blob deletion result.");
  }
  if (Number(result[0]) === 0) return null;
  if (Number(result[0]) !== 1) {
    throw new DomainError("INVALID_OPERATION", "The private image could not be released safely.");
  }
  return parsePrivateBlobAssetRegistration(String(result[1]));
}

export function resetPrivateBlobAssetRegistryForTests(): void {
  globalThis.__jazzboardLocalBlobAssetRegistry = undefined;
}
