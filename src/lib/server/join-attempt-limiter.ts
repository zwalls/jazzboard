import { getRedisForRealtime } from "@/lib/server/room-store";

export const JOIN_ATTEMPT_LIMIT = 8;
export const JOIN_ATTEMPT_WINDOW_SECONDS = 60;

const KEY_PREFIX = "jazzboard:join-attempts:";

type LocalWindow = {
  count: number;
  resetAt: number;
};

export type JoinAttemptLimit = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

declare global {
  var __jazzboardLocalJoinAttemptWindows: Map<string, LocalWindow> | undefined;
}

const CONSUME_FIXED_WINDOW_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("TTL", KEYS[1])
if count == 1 or ttl < 0 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

function result(count: number, retryAfterSeconds: number): JoinAttemptLimit {
  const allowed = count <= JOIN_ATTEMPT_LIMIT;
  return {
    allowed,
    limit: JOIN_ATTEMPT_LIMIT,
    remaining: Math.max(0, JOIN_ATTEMPT_LIMIT - count),
    retryAfterSeconds: allowed ? 0 : Math.max(1, retryAfterSeconds),
  };
}

function localWindows(): Map<string, LocalWindow> {
  globalThis.__jazzboardLocalJoinAttemptWindows ??= new Map();
  return globalThis.__jazzboardLocalJoinAttemptWindows;
}

function consumeLocal(participantId: string, now: number): JoinAttemptLimit {
  const windows = localWindows();
  const existing = windows.get(participantId);
  const resetAt = now + JOIN_ATTEMPT_WINDOW_SECONDS * 1_000;
  const window = !existing || existing.resetAt <= now
    ? { count: 1, resetAt }
    : { count: existing.count + 1, resetAt: existing.resetAt };

  windows.set(participantId, window);

  if (windows.size > 1_000) {
    for (const [key, candidate] of windows) {
      if (candidate.resetAt <= now) windows.delete(key);
    }
  }

  return result(window.count, Math.ceil((window.resetAt - now) / 1_000));
}

function parseRedisResult(value: unknown): [count: number, ttl: number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("Redis returned an invalid join-attempt limit result.");
  }
  const count = Number(value[0]);
  const ttl = Number(value[1]);
  if (!Number.isInteger(count) || count < 1 || !Number.isFinite(ttl)) {
    throw new Error("Redis returned an invalid join-attempt limit result.");
  }
  return [count, ttl];
}

/**
 * Consumes one exact-code join attempt for a signed guest session.
 *
 * Production uses one atomic Redis script so concurrent serverless requests share
 * a fixed window. Development without Redis uses the same policy in local memory.
 * Deliberately accepts only the opaque session participant ID; callers cannot
 * accidentally key the limit by IP address or room code.
 */
export async function consumeJoinAttempt(participantId: string): Promise<JoinAttemptLimit> {
  const redis = getRedisForRealtime();
  if (!redis) return consumeLocal(participantId, Date.now());

  const value = await redis.eval(
    CONSUME_FIXED_WINDOW_SCRIPT,
    1,
    `${KEY_PREFIX}${participantId}`,
    JOIN_ATTEMPT_WINDOW_SECONDS.toString(),
  );
  const [count, ttl] = parseRedisResult(value);
  return result(count, ttl);
}
