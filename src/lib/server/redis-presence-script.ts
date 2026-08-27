import { createHash } from "node:crypto";

/**
 * Atomic Redis-side presence transition.
 *
 * The hot path deliberately declares only awareness, coordination, and the
 * event stream. In particular, it never locks or reads the durable document
 * plane. Membership and the durable document revision are fenced by mirrors
 * that durable transactions maintain in the two live planes.
 *
 * Upstash bills commands executed by a script as well as EVAL/EVALSHA itself,
 * so the steady transition uses one MGET, one MSET, and one XADD. The outer
 * invocation is still one network round trip and one atomic critical section.
 */
export const REDIS_PRESENCE_COMMIT_SCRIPT = String.raw`
local function reply(...)
  return { ... }
end

-- Upstash's Redis-compatible cjson build omits object properties whose value
-- is JSON null, while Redis OSS preserves them. Presence deltas and persisted
-- awareness have required nullable fields, so encode a private marker and
-- restore only those schema-owned properties after cjson serialization.
local null_marker = "JAZZBOARD_INTERNAL_NULL_7D65C042A48B4F75"
local nullable_fields = {
  "cursor",
  "viewport",
  "activity",
  "spotlight",
  "handoffRequest",
  "actor",
  "activityId",
}

local function nullable(value)
  if value == nil or value == cjson.null then
    return null_marker
  end
  return value
end

local function normalize_presence(target)
  target.cursor = nullable(target.cursor)
  target.viewport = nullable(target.viewport)
  target.activity = nullable(target.activity)
end

local function valid_integer(value)
  return type(value) == "number"
    and value >= 0
    and value < 9007199254740991
    and value == math.floor(value)
end

local function decode_json(encoded)
  local ok, decoded = pcall(cjson.decode, encoded)
  if not ok or type(decoded) ~= "table" then
    return nil
  end
  return decoded
end

local function encode_json(value)
  local ok, encoded = pcall(cjson.encode, value)
  if not ok then
    return nil
  end
  -- Redis' bundled cjson cannot distinguish an empty Lua array from an empty
  -- object, and provider builds differ on which representation they emit.
  -- Restore every ambiguous field according to Jazzboard's authoritative
  -- schema before persisting or publishing it.
  encoded = string.gsub(encoded, '"followingParticipantIds":{}', '"followingParticipantIds":[]')
  encoded = string.gsub(encoded, '"objectIds":{}', '"objectIds":[]')
  encoded = string.gsub(encoded, '"leases":%[%]', '"leases":{}')
  for _, field in ipairs(nullable_fields) do
    encoded = string.gsub(
      encoded,
      '"' .. field .. '":"' .. null_marker .. '"',
      '"' .. field .. '":null'
    )
  end
  return encoded
end

local encoded_planes = redis.call("MGET", KEYS[1], KEYS[2])
local encoded_awareness = encoded_planes[1]
local encoded_coordination = encoded_planes[2]
if not encoded_awareness and not encoded_coordination then
  return reply("not_found")
end
if not encoded_awareness or not encoded_coordination then
  return reply("repair_required", "missing_live_plane")
end

local awareness = decode_json(encoded_awareness)
local coordination = decode_json(encoded_coordination)
local presence_input = decode_json(ARGV[5])
if not awareness or not coordination or not presence_input then
  return reply("corrupt", "malformed_json")
end
if awareness.schemaVersion ~= 1
  or coordination.schemaVersion ~= 1
  or coordination.legacyRetired ~= true then
  return reply("repair_required", "live_plane_version")
end
if coordination.roomRevision == nil then
  return reply("repair_required", "missing_document_fence")
end
if type(awareness.participants) ~= "table"
  or type(coordination.leases) ~= "table"
  or not valid_integer(coordination.stateRevision)
  or not valid_integer(coordination.roomRevision)
  or coordination.stateRevision < coordination.roomRevision then
  return reply("corrupt", "live_plane_shape")
end

local room_id = ARGV[1]
local participant_id = ARGV[2]
local actor_kind = ARGV[3]
local now = tonumber(ARGV[4])
local away_ms = tonumber(ARGV[6])
local capacity_mode = ARGV[7]
local awareness_limit = tonumber(ARGV[8])
local awareness_warning = tonumber(ARGV[9])
local provider_limit = tonumber(ARGV[10])
if (actor_kind ~= "human" and actor_kind ~= "agent")
  or not valid_integer(now)
  or not valid_integer(away_ms)
  or not valid_integer(awareness_limit)
  or not valid_integer(awareness_warning)
  or not valid_integer(provider_limit) then
  return reply("corrupt", "invalid_script_arguments")
end

local participant = awareness.participants[participant_id]
if type(participant) ~= "table" or type(participant.member) ~= "table" then
  return reply("repair_required", "missing_member_mirror")
end
local member = participant.member
if member.participantId ~= participant_id
  or type(member.displayName) ~= "string"
  or type(member.color) ~= "string"
  or (member.role ~= "participant" and member.role ~= "spectator") then
  return reply("repair_required", "invalid_member_mirror")
end
if actor_kind == "agent" and member.role ~= "participant" then
  return reply("forbidden", "spectator_agent_presence")
end
if type(participant.human) ~= "table" or type(participant.agent) ~= "table" then
  return reply("corrupt", "invalid_presence_target")
end

participant[actor_kind] = {
  cursor = nullable(presence_input.cursor),
  viewport = nullable(presence_input.viewport),
  lastSeenAt = now,
  activity = nullable(presence_input.activity),
}
participant.lastSeenAt = now
participant.connected = true
if actor_kind == "agent" then
  participant.agentActive = true
end

-- Apply the incoming heartbeat before deriving liveness. A returning
-- presenter therefore rescues their Spotlight instead of tearing it down and
-- immediately reconnecting in two consecutive revisions.
local presence_changed = false
for _, candidate in pairs(awareness.participants) do
  if type(candidate) ~= "table"
    or type(candidate.human) ~= "table"
    or type(candidate.agent) ~= "table"
    or not valid_integer(candidate.human.lastSeenAt)
    or not valid_integer(candidate.agent.lastSeenAt) then
    return reply("corrupt", "invalid_participant_awareness")
  end
  normalize_presence(candidate.human)
  normalize_presence(candidate.agent)
  local connected = (now - candidate.human.lastSeenAt < away_ms)
    or (now - candidate.agent.lastSeenAt < away_ms)
  if candidate.connected ~= connected then
    candidate.connected = connected
    presence_changed = true
  end
end

local leases_changed = false
local retained_leases = {}
for object_id, lease in pairs(coordination.leases) do
  if type(lease) ~= "table" or not valid_integer(lease.expiresAt) then
    return reply("corrupt", "invalid_lease")
  end
  if lease.expiresAt > now then
    retained_leases[object_id] = lease
  else
    leases_changed = true
  end
end
if leases_changed then
  coordination.leases = retained_leases
end

local spotlight_changed = false
local spotlight = awareness.spotlight
if spotlight ~= cjson.null then
  if type(spotlight) ~= "table"
    or type(spotlight.presenterId) ~= "string"
    or type(spotlight.followingParticipantIds) ~= "table" then
    return reply("corrupt", "invalid_spotlight")
  end
  local presenter = awareness.participants[spotlight.presenterId]
  if type(presenter) ~= "table" or presenter.connected ~= true then
    awareness.spotlight = cjson.null
    spotlight_changed = true
  else
    local followers = {}
    for _, follower_id in ipairs(spotlight.followingParticipantIds) do
      if type(follower_id) ~= "string" then
        return reply("corrupt", "invalid_spotlight_follower")
      end
      local follower = awareness.participants[follower_id]
      if type(follower) == "table" and follower.connected == true then
        table.insert(followers, follower_id)
      else
        spotlight_changed = true
      end
    end
    if spotlight_changed then
      spotlight.followingParticipantIds = followers
    end
  end
end

if awareness.spotlight == nil or awareness.spotlight == cjson.null then
  awareness.spotlight = null_marker
else
  awareness.spotlight.handoffRequest = nullable(awareness.spotlight.handoffRequest)
end

local derived_changed = presence_changed or leases_changed or spotlight_changed
local base_revision = math.max(coordination.stateRevision, coordination.roomRevision)
local derived_revision = derived_changed and (base_revision + 1) or nil
local state_revision = base_revision + (derived_changed and 2 or 1)
coordination.stateRevision = state_revision

local presence = participant[actor_kind]
local presence_event = {
  id = ARGV[11],
  roomId = room_id,
  sequence = state_revision,
  occurredAt = now,
  type = actor_kind == "agent" and "agent.activity" or "presence.updated",
  actor = {
    participantId = participant_id,
    displayName = member.displayName,
    color = member.color,
    kind = actor_kind,
  },
  payload = {
    schemaVersion = 4,
    kind = "presence.delta",
    stateRevision = state_revision,
    roomRevision = coordination.roomRevision,
    participantId = participant_id,
    actorKind = actor_kind,
    lastSeenAt = now,
    connected = true,
    agentActive = participant.agentActive == true,
    presence = presence,
  },
}

local derived_event = nil
if derived_changed then
  local event_type = spotlight_changed and "spotlight.updated"
    or (leases_changed and "lease.updated" or "presence.updated")
  derived_event = {
    id = ARGV[12],
    roomId = room_id,
    sequence = derived_revision,
    occurredAt = now,
    type = event_type,
    actor = null_marker,
    payload = {
      schemaVersion = 3,
      kind = "room.invalidated",
      stateRevision = derived_revision,
      roomRevision = coordination.roomRevision,
      activityId = null_marker,
    },
  }
end

local next_awareness = encode_json(awareness)
local next_coordination = encode_json(coordination)
local encoded_presence_event = encode_json(presence_event)
local encoded_derived_event = derived_event and encode_json(derived_event) or ""
if not next_awareness or not next_coordination
  or not encoded_presence_event or (derived_event and not encoded_derived_event) then
  return reply("corrupt", "encoding_failed")
end

local before_awareness_bytes = string.len(encoded_awareness)
local awareness_bytes = string.len(next_awareness)
local coordination_bytes = string.len(next_coordination)
local transaction_bytes = awareness_bytes + coordination_bytes
  + string.len(encoded_presence_event) + string.len(encoded_derived_event) + 16384
local worsens_awareness_overage = awareness_bytes > awareness_limit
  and not (before_awareness_bytes > awareness_limit and awareness_bytes <= before_awareness_bytes)
if capacity_mode == "enforce" and worsens_awareness_overage then
  return reply(
    "capacity",
    "awareness_product_limit",
    before_awareness_bytes,
    awareness_bytes,
    awareness_limit,
    coordination_bytes,
    transaction_bytes,
    provider_limit,
    coordination.roomRevision
  )
end
if awareness_bytes > provider_limit
  or coordination_bytes > provider_limit
  or transaction_bytes > provider_limit then
  return reply(
    "capacity",
    "provider_safe_limit",
    before_awareness_bytes,
    awareness_bytes,
    awareness_limit,
    coordination_bytes,
    transaction_bytes,
    provider_limit,
    coordination.roomRevision
  )
end

local stored = redis.pcall("MSET", KEYS[1], next_awareness, KEYS[2], next_coordination)
if type(stored) == "table" and stored.err then
  return reply("provider_error", "mset")
end

local derived_stream_id = nil
if derived_event then
  local appended = redis.pcall(
    "XADD", KEYS[3], "MAXLEN", "~", 20000, "*",
    "roomId", room_id, "data", encoded_derived_event
  )
  if type(appended) == "table" and appended.err then
    redis.pcall("MSET", KEYS[1], encoded_awareness, KEYS[2], encoded_coordination)
    return reply("provider_error", "derived_xadd")
  end
  derived_stream_id = appended
end

local presence_appended = redis.pcall(
  "XADD", KEYS[3], "MAXLEN", "~", 20000, "*",
  "roomId", room_id, "data", encoded_presence_event
)
if type(presence_appended) == "table" and presence_appended.err then
  if derived_stream_id then
    redis.pcall("XDEL", KEYS[3], derived_stream_id)
  end
  redis.pcall("MSET", KEYS[1], encoded_awareness, KEYS[2], encoded_coordination)
  return reply("provider_error", "presence_xadd")
end

local capacity_level = awareness_bytes > awareness_limit and "exceeded"
  or (awareness_bytes >= awareness_warning and "warning" or "ok")
return reply(
  "ok",
  encoded_presence_event,
  encoded_derived_event,
  awareness_bytes,
  capacity_level,
  coordination.roomRevision
)
`;

/** Upstash-specific flag keeps this short, known-key script off the global lock. */
export const UPSTASH_REDIS_PRESENCE_COMMIT_SCRIPT =
  `#!lua flags=allow-key-locking\n${REDIS_PRESENCE_COMMIT_SCRIPT}`;

export function redisPresenceScript(upstash: boolean): string {
  return upstash
    ? UPSTASH_REDIS_PRESENCE_COMMIT_SCRIPT
    : REDIS_PRESENCE_COMMIT_SCRIPT;
}

export function redisPresenceScriptSha(script: string): string {
  return createHash("sha1").update(script).digest("hex");
}
