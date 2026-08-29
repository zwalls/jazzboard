import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { ipAddress } from "@vercel/functions";

import { sha256 } from "@/lib/server/idempotency";
import { getRedisForRealtime } from "@/lib/server/room-store";
import { deriveSessionSecretValue } from "@/lib/server/session";

export const JOIN_ATTEMPT_LIMIT = 8;
export const JOIN_NETWORK_ATTEMPT_LIMIT = 64;
export const JOIN_ATTEMPT_WINDOW_SECONDS = 60;

const KEY_PREFIX = "jazzboard:join-attempts:v3:";

type LocalWindow = {
  resetAt: number;
  attempts: Set<string>;
};

type DimensionState = {
  count: number;
  limit: number;
  retryAfterSeconds: number;
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
  var __jazzboardLocalJoinAttemptWindowsV3: Map<string, LocalWindow> | undefined;
}

const CONSUME_JOIN_ATTEMPT_SCRIPT = `
local window_seconds = tonumber(ARGV[1])
local attempt_hash = ARGV[2]
local session_limit = tonumber(ARGV[3])
local network_limit = tonumber(ARGV[4])
local has_network = ARGV[5] == "1"

local session_already = redis.call("HEXISTS", KEYS[1], attempt_hash) == 1
local session_count = redis.call("HLEN", KEYS[1])
local session_allows = session_already or session_count < session_limit

local network_already = false
local network_count = 0
local network_allows = true
if has_network then
  network_already = redis.call("HEXISTS", KEYS[2], attempt_hash) == 1
  network_count = redis.call("HLEN", KEYS[2])
  network_allows = network_already or network_count < network_limit
end

local allowed = session_allows and network_allows
if allowed then
  if not session_already then
    redis.call("HSET", KEYS[1], attempt_hash, "1")
    session_count = session_count + 1
  end
  if has_network and not network_already then
    redis.call("HSET", KEYS[2], attempt_hash, "1")
    network_count = network_count + 1
  end
end

local function bounded_ttl(key)
  if redis.call("EXISTS", key) == 0 then return 0 end
  local ttl = redis.call("TTL", key)
  if ttl < 0 then
    redis.call("EXPIRE", key, window_seconds)
    return window_seconds
  end
  return ttl
end

local session_ttl = bounded_ttl(KEYS[1])
local network_ttl = 0
if has_network then network_ttl = bounded_ttl(KEYS[2]) end

return { session_count, session_ttl, network_count, network_ttl, allowed and 1 or 0 }
`;

function localWindows(): Map<string, LocalWindow> {
  globalThis.__jazzboardLocalJoinAttemptWindowsV3 ??= new Map();
  return globalThis.__jazzboardLocalJoinAttemptWindowsV3;
}

function logicalAttemptHash(
  participantId: string,
  identity?: JoinAttemptIdentity | null,
): string {
  const logicalKey = identity
    ? `${identity.idempotencyKey}\0${identity.requestDigest}`
    : `unkeyed_${randomUUID()}`;
  return sha256(`jazzboard:join-attempt:v3\0${participantId}\0${logicalKey}`);
}

function participantWindowKey(participantId: string): string {
  const scope = sha256(`jazzboard:join-participant:v3\0${participantId}`);
  return `${KEY_PREFIX}session:${scope}`;
}

function trustedNetworkScope(request: Request): string | null {
  if (process.env.VERCEL !== "1") return null;
  const address = ipAddress(request);
  if (!address || isIP(address) === 0) return null;
  const token = deriveSessionSecretValue("join-attempt-ip", address.toLowerCase());
  return sha256(`jazzboard:join-network:v3\0${token}`);
}

function networkWindowKey(networkScope: string): string {
  return `${KEY_PREFIX}network:${networkScope}`;
}

function result(
  allowed: boolean,
  session: DimensionState,
  network: DimensionState | null,
): JoinAttemptLimit {
  const dimensions = network ? [session, network] : [session];
  const remaining = allowed
    ? Math.min(...dimensions.map((dimension) => Math.max(0, dimension.limit - dimension.count)))
    : 0;
  const retryAfterSeconds = allowed
    ? 0
    : Math.max(
        1,
        ...dimensions
          .filter((dimension) => dimension.count >= dimension.limit)
          .map((dimension) => dimension.retryAfterSeconds),
      );
  return {
    allowed,
    limit: JOIN_ATTEMPT_LIMIT,
    remaining,
    retryAfterSeconds,
  };
}

function currentLocalWindow(
  windows: Map<string, LocalWindow>,
  key: string,
  now: number,
): LocalWindow {
  const existing = windows.get(key);
  if (existing && existing.resetAt > now && existing.attempts instanceof Set) return existing;
  return {
    resetAt: now + JOIN_ATTEMPT_WINDOW_SECONDS * 1_000,
    attempts: new Set(),
  };
}

function dimensionState(window: LocalWindow, limit: number, now: number): DimensionState {
  return {
    count: window.attempts.size,
    limit,
    retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1_000)),
  };
}

function consumeLocal(
  participantId: string,
  request: Request,
  identity: JoinAttemptIdentity | null | undefined,
  now: number,
): JoinAttemptLimit {
  const windows = localWindows();
  const attemptHash = logicalAttemptHash(participantId, identity);
  const sessionKey = participantWindowKey(participantId);
  const sessionWindow = currentLocalWindow(windows, sessionKey, now);
  const networkScope = trustedNetworkScope(request);
  const networkKey = networkScope ? networkWindowKey(networkScope) : null;
  const networkWindow = networkKey ? currentLocalWindow(windows, networkKey, now) : null;

  const sessionAllows = sessionWindow.attempts.has(attemptHash) ||
    sessionWindow.attempts.size < JOIN_ATTEMPT_LIMIT;
  const networkAllows = !networkWindow || networkWindow.attempts.has(attemptHash) ||
    networkWindow.attempts.size < JOIN_NETWORK_ATTEMPT_LIMIT;
  const allowed = sessionAllows && networkAllows;

  if (allowed) {
    sessionWindow.attempts.add(attemptHash);
    networkWindow?.attempts.add(attemptHash);
  }
  windows.set(sessionKey, sessionWindow);
  if (networkKey && networkWindow) windows.set(networkKey, networkWindow);

  if (windows.size > 1_000) {
    for (const [key, candidate] of windows) {
      if (candidate.resetAt <= now) windows.delete(key);
    }
  }

  return result(
    allowed,
    dimensionState(sessionWindow, JOIN_ATTEMPT_LIMIT, now),
    networkWindow
      ? dimensionState(networkWindow, JOIN_NETWORK_ATTEMPT_LIMIT, now)
      : null,
  );
}

function parseRedisResult(
  value: unknown,
): [sessionCount: number, sessionTtl: number, networkCount: number, networkTtl: number, allowed: boolean] {
  if (!Array.isArray(value) || value.length !== 5) {
    throw new Error("Redis returned an invalid join-attempt limit result.");
  }
  const sessionCount = Number(value[0]);
  const sessionTtl = Number(value[1]);
  const networkCount = Number(value[2]);
  const networkTtl = Number(value[3]);
  const admission = Number(value[4]);
  if (
    !Number.isSafeInteger(sessionCount) || sessionCount < 0 ||
    !Number.isFinite(sessionTtl) ||
    !Number.isSafeInteger(networkCount) || networkCount < 0 ||
    !Number.isFinite(networkTtl) ||
    (admission !== 0 && admission !== 1)
  ) {
    throw new Error("Redis returned an invalid join-attempt limit result.");
  }
  return [sessionCount, sessionTtl, networkCount, networkTtl, admission === 1];
}

/**
 * Consumes one logical exact-code join attempt. A strict signed-session budget
 * handles retries and accidental loops. On Vercel, a larger independent budget
 * derived from the platform-trusted client IP prevents resetting that budget by
 * discarding the guest cookie. Raw IPs and participant IDs never enter Redis.
 * Rejected attempts are not stored, keeping both fixed-window hashes bounded.
 */
export async function consumeJoinAttempt(
  participantId: string,
  request: Request,
  identity?: JoinAttemptIdentity | null,
): Promise<JoinAttemptLimit> {
  const redis = getRedisForRealtime();
  if (!redis) return consumeLocal(participantId, request, identity, Date.now());

  const networkScope = trustedNetworkScope(request);
  const keys = [
    participantWindowKey(participantId),
    ...(networkScope ? [networkWindowKey(networkScope)] : []),
  ];
  const value = await redis.eval(
    CONSUME_JOIN_ATTEMPT_SCRIPT,
    keys.length,
    ...keys,
    JOIN_ATTEMPT_WINDOW_SECONDS.toString(),
    logicalAttemptHash(participantId, identity),
    JOIN_ATTEMPT_LIMIT.toString(),
    JOIN_NETWORK_ATTEMPT_LIMIT.toString(),
    networkScope ? "1" : "0",
  );
  const [sessionCount, sessionTtl, networkCount, networkTtl, allowed] = parseRedisResult(value);
  return result(
    allowed,
    {
      count: sessionCount,
      limit: JOIN_ATTEMPT_LIMIT,
      retryAfterSeconds: sessionTtl,
    },
    networkScope
      ? {
          count: networkCount,
          limit: JOIN_NETWORK_ATTEMPT_LIMIT,
          retryAfterSeconds: networkTtl,
        }
      : null,
  );
}
