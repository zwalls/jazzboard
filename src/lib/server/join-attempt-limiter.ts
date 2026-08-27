import { randomUUID } from "node:crypto";

import { sha256 } from "@/lib/server/idempotency";
import { getRedisForRealtime } from "@/lib/server/room-store";

export const JOIN_ATTEMPT_LIMIT = 8;
export const JOIN_ATTEMPT_WINDOW_SECONDS = 60;

const KEY_PREFIX = "jazzboard:join-attempts:";

type LocalWindow = {
  count: number;
  resetAt: number;
  attempts: Map<string, boolean>;
};

export type JoinAttemptLimit = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export type JoinAttemptIdentity = {
  idempotencyKey: string;
  requestDigest: string;
};

declare global {
  var __jazzboardLocalJoinAttemptWindows: Map<string, LocalWindow> | undefined;
}

const CONSUME_FIXED_WINDOW_SCRIPT = `
local admission = redis.call("HGET", KEYS[1], ARGV[2])
if not admission then
  local count_before = redis.call("HLEN", KEYS[1])
  admission = count_before < tonumber(ARGV[3]) and "1" or "0"
  redis.call("HSET", KEYS[1], ARGV[2], admission)
end
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
local count = redis.call("HLEN", KEYS[1])
return { count, ttl, tonumber(admission) }
`;

function result(
  count: number,
  retryAfterSeconds: number,
  allowed = count <= JOIN_ATTEMPT_LIMIT,
): JoinAttemptLimit {
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

function logicalAttemptHash(
  participantId: string,
  identity?: JoinAttemptIdentity | null,
): string {
  const logicalKey = identity
    ? `${identity.idempotencyKey}\0${identity.requestDigest}`
    : `unkeyed_${randomUUID()}`;
  return sha256(`jazzboard:join-attempt:v2\0${participantId}\0${logicalKey}`);
}

function participantWindowKey(participantId: string): string {
  return `${KEY_PREFIX}v2:${sha256(`jazzboard:join-participant:v2\0${participantId}`)}`;
}

function consumeLocal(
  participantId: string,
  identity: JoinAttemptIdentity | null | undefined,
  now: number,
): JoinAttemptLimit {
  const windows = localWindows();
  const existing = windows.get(participantId);
  if (existing && !(existing.attempts instanceof Map)) {
    const legacyAttempts = existing.attempts as unknown as Set<string>;
    existing.attempts = new Map(
      [...legacyAttempts].map((hash, index) => [hash, index < JOIN_ATTEMPT_LIMIT]),
    );
  }
  const resetAt = now + JOIN_ATTEMPT_WINDOW_SECONDS * 1_000;
  const attemptHash = logicalAttemptHash(participantId, identity);
  const window = !existing || existing.resetAt <= now
    ? { count: 1, resetAt, attempts: new Map([[attemptHash, true]]) }
    : existing;

  if (existing && existing.resetAt > now && !existing.attempts.has(attemptHash)) {
    existing.count += 1;
    existing.attempts.set(attemptHash, existing.count <= JOIN_ATTEMPT_LIMIT);
  }

  windows.set(participantId, window);

  if (windows.size > 1_000) {
    for (const [key, candidate] of windows) {
      if (candidate.resetAt <= now) windows.delete(key);
    }
  }

  return result(
    window.count,
    Math.ceil((window.resetAt - now) / 1_000),
    window.attempts.get(attemptHash) ?? false,
  );
}

function parseRedisResult(value: unknown): [count: number, ttl: number, allowed: boolean] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error("Redis returned an invalid join-attempt limit result.");
  }
  const count = Number(value[0]);
  const ttl = Number(value[1]);
  const admission = Number(value[2]);
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isFinite(ttl) ||
    (admission !== 0 && admission !== 1)
  ) {
    throw new Error("Redis returned an invalid join-attempt limit result.");
  }
  return [count, ttl, admission === 1];
}

/**
 * Consumes one logical exact-code join attempt for a signed guest session.
 *
 * Production uses one atomic Redis script so concurrent serverless requests share
 * a fixed window. Development without Redis uses the same policy in local memory.
 * The optional keyed request identity deduplicates delivery retries within the
 * fixed window. Both participant and retry identities are one-way hashed before
 * Redis storage; callers cannot accidentally key the limit by IP or room code.
 */
export async function consumeJoinAttempt(
  participantId: string,
  identity?: JoinAttemptIdentity | null,
): Promise<JoinAttemptLimit> {
  const redis = getRedisForRealtime();
  if (!redis) return consumeLocal(participantId, identity, Date.now());

  const attemptHash = logicalAttemptHash(participantId, identity);

  const value = await redis.eval(
    CONSUME_FIXED_WINDOW_SCRIPT,
    1,
    participantWindowKey(participantId),
    JOIN_ATTEMPT_WINDOW_SECONDS.toString(),
    attemptHash,
    JOIN_ATTEMPT_LIMIT.toString(),
  );
  const [count, ttl, allowed] = parseRedisResult(value);
  return result(count, ttl, allowed);
}
