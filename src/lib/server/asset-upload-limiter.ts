import { sha256 } from "@/lib/server/idempotency";
import { getRedisForRealtime } from "@/lib/server/room-store";

export const ASSET_UPLOAD_GRANT_LIMIT = 12;
export const ASSET_UPLOAD_GRANT_WINDOW_SECONDS = 60;

const KEY_PREFIX = "jazzboard:asset-upload-grants:v1:";

type LocalWindow = {
  resetAt: number;
  grants: Set<string>;
};

export type AssetUploadGrantLimit = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

declare global {
  var __jazzboardLocalAssetUploadGrantWindows: Map<string, LocalWindow> | undefined;
}

const CONSUME_GRANT_SCRIPT = `
local alreadyGranted = redis.call("HEXISTS", KEYS[1], ARGV[3])
local count = redis.call("HLEN", KEYS[1])
local allowed = 0
if alreadyGranted == 1 then
  allowed = 1
elseif count < tonumber(ARGV[2]) then
  redis.call("HSET", KEYS[1], ARGV[3], "1")
  count = count + 1
  allowed = 1
end
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl, allowed }
`;

function localWindows(): Map<string, LocalWindow> {
  globalThis.__jazzboardLocalAssetUploadGrantWindows ??= new Map();
  return globalThis.__jazzboardLocalAssetUploadGrantWindows;
}

function scopeHash(participantId: string): string {
  return sha256(`jazzboard:asset-upload-participant:v1\0${participantId}`);
}

function grantHash(roomId: string, pathname: string): string {
  return sha256(`jazzboard:asset-upload-path:v1\0${roomId}\0${pathname}`);
}

function result(count: number, retryAfterSeconds: number, allowed: boolean): AssetUploadGrantLimit {
  return {
    allowed,
    limit: ASSET_UPLOAD_GRANT_LIMIT,
    remaining: Math.max(0, ASSET_UPLOAD_GRANT_LIMIT - count),
    retryAfterSeconds: allowed ? 0 : Math.max(1, retryAfterSeconds),
  };
}

function consumeLocal(roomId: string, participantId: string, pathname: string): AssetUploadGrantLimit {
  const now = Date.now();
  const windows = localWindows();
  const key = scopeHash(participantId);
  const existing = windows.get(key);
  const window = !existing || existing.resetAt <= now
    ? { resetAt: now + ASSET_UPLOAD_GRANT_WINDOW_SECONDS * 1_000, grants: new Set<string>() }
    : existing;
  const grant = grantHash(roomId, pathname);
  const alreadyGranted = window.grants.has(grant);
  const allowed = alreadyGranted || window.grants.size < ASSET_UPLOAD_GRANT_LIMIT;
  if (allowed) window.grants.add(grant);
  windows.set(key, window);

  if (windows.size > 1_000) {
    for (const [candidateKey, candidate] of windows) {
      if (candidate.resetAt <= now) windows.delete(candidateKey);
    }
  }

  return result(
    window.grants.size,
    Math.ceil((window.resetAt - now) / 1_000),
    allowed,
  );
}

function parseRedisResult(value: unknown): [number, number, boolean] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error("Redis returned an invalid asset-upload grant limit result.");
  }
  const count = Number(value[0]);
  const ttl = Number(value[1]);
  const allowed = Number(value[2]);
  if (
    !Number.isSafeInteger(count) || count < 0 ||
    !Number.isFinite(ttl) ||
    (allowed !== 0 && allowed !== 1)
  ) {
    throw new Error("Redis returned an invalid asset-upload grant limit result.");
  }
  return [count, ttl, allowed === 1];
}

/**
 * Bounds short-lived Blob capabilities per signed guest across all rooms. The
 * pathname hash deduplicates provider/client retries, and the Lua script stops
 * adding fields once the window is full so rejection traffic cannot grow Redis.
 */
export async function consumeAssetUploadGrant(
  roomId: string,
  participantId: string,
  pathname: string,
): Promise<AssetUploadGrantLimit> {
  const redis = getRedisForRealtime();
  if (!redis) return consumeLocal(roomId, participantId, pathname);

  const value = await redis.eval(
    CONSUME_GRANT_SCRIPT,
    1,
    `${KEY_PREFIX}${scopeHash(participantId)}`,
    ASSET_UPLOAD_GRANT_WINDOW_SECONDS.toString(),
    ASSET_UPLOAD_GRANT_LIMIT.toString(),
    grantHash(roomId, pathname),
  );
  const [count, ttl, allowed] = parseRedisResult(value);
  return result(count, ttl, allowed);
}
