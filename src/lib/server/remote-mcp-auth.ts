import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";

import { DomainError } from "@/lib/domain/errors";
import { sha256 } from "@/lib/server/idempotency";
import { getRedisForRealtime } from "@/lib/server/room-store";
import { deriveSessionSecretValue } from "@/lib/server/session";

const MCP_READ_SCOPE = "room:read";
const MCP_WRITE_SCOPE = "room:write";
const DAY_SECONDS = 24 * 60 * 60;
const GRANT_LIFETIME_SECONDS = 30 * DAY_SECONDS;
const MAX_GRANTS_PER_ROOM = 128;
const MAX_GRANTS_PER_PARTICIPANT = 12;
const uuidPattern = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const uuid = new RegExp(`^${uuidPattern}$`);
const tokenPattern = new RegExp(String.raw`^Bearer (jb_mcp_v1\.(room_${uuidPattern})\.(${uuidPattern})\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43})$`, "i");

export const remoteRoomIdSchema = z.string().regex(new RegExp(`^room_${uuidPattern}$`), "Use the exact room ID.");
export const remoteGrantIdSchema = z.string().regex(uuid);
export const remoteGrantAccessSchema = z.enum(["read", "write"]);
export type RemoteGrantAccess = z.infer<typeof remoteGrantAccessSchema>;

type Grant = {
  id: string;
  roomId: string;
  participantId: string;
  label: string;
  access: RemoteGrantAccess;
  expiresAt: number;
  digest: string;
};

declare global {
  var __jazzboardLocalMcpGrants: Map<string, Map<string, Grant>> | undefined;
}

function localRoom(roomId: string) {
  globalThis.__jazzboardLocalMcpGrants ??= new Map();
  let room = globalThis.__jazzboardLocalMcpGrants.get(roomId);
  if (!room) {
    room = new Map();
    globalThis.__jazzboardLocalMcpGrants.set(roomId, room);
  }
  return room;
}

function grantKey(resource: URL, roomId: string) {
  return `jazzboard:remote-mcp:v1:${sha256(resource.href)}:{${roomId}}`;
}

const ISSUE_SCRIPT = `
local fields = redis.call('HGETALL', KEYS[1])
local active = 0
local own = 0
for i = 1, #fields, 2 do
  local grant = cjson.decode(fields[i + 1])
  if grant.expiresAt <= tonumber(ARGV[1]) then
    redis.call('HDEL', KEYS[1], fields[i])
  else
    active = active + 1
    if grant.participantId == ARGV[2] then own = own + 1 end
  end
end
if active >= tonumber(ARGV[3]) or own >= tonumber(ARGV[4]) then return 0 end
if redis.call('HSETNX', KEYS[1], ARGV[5], ARGV[6]) == 0 then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[7])
return 1
`;

const REVOKE_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if raw and cjson.decode(raw).participantId == ARGV[2] then
  return redis.call('HDEL', KEYS[1], ARGV[1])
end
return 0
`;

function publicGrant({ id, label, access, expiresAt }: Grant) {
  return { id, label, access, expiresAt };
}

export async function createRemoteMcpGrant(resource: URL, input: Pick<Grant, "roomId" | "participantId" | "label" | "access">) {
  const id = randomUUID();
  const now = Date.now();
  const payload = `jb_mcp_v1.${input.roomId}.${id}.${randomBytes(32).toString("base64url")}`;
  const token = `${payload}.${signCapability(resource, payload)}`;
  const key = grantKey(resource, input.roomId);
  const grant: Grant = { ...input, id, digest: sha256(token), expiresAt: now + GRANT_LIFETIME_SECONDS * 1000 };
  const redis = getRedisForRealtime();
  let created: boolean;
  if (redis) {
    created = await redis.eval(ISSUE_SCRIPT, 1, key, now, input.participantId, MAX_GRANTS_PER_ROOM,
      MAX_GRANTS_PER_PARTICIPANT, id, JSON.stringify(grant), GRANT_LIFETIME_SECONDS) === 1;
  } else {
    const room = localRoom(key);
    for (const entry of room.values()) if (entry.expiresAt <= now) room.delete(entry.id);
    const own = [...room.values()].filter((entry) => entry.participantId === input.participantId).length;
    created = room.size < MAX_GRANTS_PER_ROOM && own < MAX_GRANTS_PER_PARTICIPANT && !room.has(id);
    if (created) room.set(id, grant);
  }
  if (!created) throw new DomainError("ROOM_CAPACITY_EXCEEDED", "Revoke an existing MCP connection before creating another.");
  return { ...publicGrant(grant), token };
}

export async function listRemoteMcpGrants(resource: URL, roomId: string, participantId: string) {
  const redis = getRedisForRealtime();
  const grants: Grant[] = redis
    ? (await redis.hvals(grantKey(resource, roomId))).map((value) => JSON.parse(value) as Grant)
    : [...(globalThis.__jazzboardLocalMcpGrants?.get(grantKey(resource, roomId))?.values() ?? [])];
  const now = Date.now();
  return grants.filter((grant) => grant.participantId === participantId && grant.expiresAt > now).map(publicGrant);
}

export async function revokeRemoteMcpGrant(resource: URL, roomId: string, participantId: string, id: string) {
  const redis = getRedisForRealtime();
  if (redis) return await redis.eval(REVOKE_SCRIPT, 1, grantKey(resource, roomId), id, participantId) === 1;
  const room = globalThis.__jazzboardLocalMcpGrants?.get(grantKey(resource, roomId));
  return !!(room && room.get(id)?.participantId === participantId && room.delete(id));
}

function signCapability(resource: URL, payload: string) {
  return deriveSessionSecretValue("remote-mcp-bearer", JSON.stringify([resource.href, payload]));
}

export async function authenticateRemoteMcp(request: Request, resource: URL): Promise<AuthInfo | undefined> {
  const header = request.headers.get("authorization");
  const match = header && header.length < 210 ? tokenPattern.exec(header) : null;
  if (!match) return undefined;
  const [, token, roomId, id] = match;
  // Reject fabricated lookup keys before touching Redis.
  const payload = token.slice(0, -44);
  const presentedSignature = token.slice(-43);
  if (!timingSafeEqual(Buffer.from(presentedSignature), Buffer.from(signCapability(resource, payload)))) return undefined;
  const redis = getRedisForRealtime();
  const raw = await redis?.hget(grantKey(resource, roomId), id);
  const grant: Grant | undefined = redis ? raw ? JSON.parse(raw) : undefined
    : globalThis.__jazzboardLocalMcpGrants?.get(grantKey(resource, roomId))?.get(id);
  if (!grant || grant.id !== id || grant.roomId !== roomId || grant.expiresAt <= Date.now()) return undefined;
  const digest = Buffer.from(grant.digest, "hex");
  const candidate = Buffer.from(sha256(token), "hex");
  if (digest.length !== candidate.length || !timingSafeEqual(digest, candidate)) return undefined;
  return {
    token,
    clientId: grant.id,
    scopes: grant.access === "write" ? [MCP_READ_SCOPE, MCP_WRITE_SCOPE] : [MCP_READ_SCOPE],
    expiresAt: Math.floor(grant.expiresAt / 1000),
    extra: { roomId: grant.roomId, participantId: grant.participantId },
  };
}

export function requireRemoteMcpGrant(auth: AuthInfo | undefined, roomId: string, access: RemoteGrantAccess) {
  if (auth?.extra?.roomId === roomId && typeof auth.extra.participantId === "string" &&
    auth.scopes.includes(MCP_READ_SCOPE) && (access === "read" || auth.scopes.includes(MCP_WRITE_SCOPE))) {
    return { id: auth.clientId, roomId, participantId: auth.extra.participantId };
  }
  throw new DomainError("FORBIDDEN", "This connection does not have the requested room access.");
}
