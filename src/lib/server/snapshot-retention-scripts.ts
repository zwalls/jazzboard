/**
 * Snapshot artifacts are intentionally isolated from compact retention
 * metadata. These scripts validate all metadata and counters before their
 * first write because Redis does not roll back commands executed before a Lua
 * runtime error.
 */

export const CREATE_AND_PRUNE_REDIS_SNAPSHOTS_SCRIPT = `
-- jazzboard:snapshot-create:v3
local record_json = ARGV[1]
local metadata_json = ARGV[2]
local record_bytes = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])
local snapshot_id = ARGV[5]
local created_at = tonumber(ARGV[6])
local now_ms = tonumber(ARGV[7])
local source_room_id = ARGV[8]
local creator_participant_id = ARGV[9]
local max_record_bytes = tonumber(ARGV[10])
local max_creator_bytes = tonumber(ARGV[11])
local max_room_bytes = tonumber(ARGV[12])
local max_global_bytes = tonumber(ARGV[13])
local max_creator_count = tonumber(ARGV[14])
local snapshot_key_prefix = ARGV[15]
local token_key_prefix = ARGV[16]
local metadata_key_prefix = ARGV[17]
local creator_index_prefix = ARGV[18]
local room_index_prefix = ARGV[19]
local creator_bytes_prefix = ARGV[20]
local room_bytes_prefix = ARGV[21]
local receipt_json = ARGV[22]
local receipt_ttl_seconds = tonumber(ARGV[23])
local max_room_count = tonumber(ARGV[24])
local max_global_count = tonumber(ARGV[25])

local function decode_metadata(encoded)
  if not encoded then return nil end
  local ok, metadata = pcall(cjson.decode, encoded)
  if not ok
    or type(metadata) ~= "table"
    or metadata.v ~= 1
    or type(metadata.id) ~= "string"
    or type(metadata.tokenHash) ~= "string"
    or type(metadata.sourceRoomId) ~= "string"
    or type(metadata.sourceRoomRevision) ~= "number"
    or type(metadata.creatorParticipantId) ~= "string"
    or type(metadata.scope) ~= "table"
    or type(metadata.title) ~= "string"
    or type(metadata.createdAt) ~= "number"
    or type(metadata.expiresAt) ~= "number"
    or type(metadata.recordBytes) ~= "number"
    or metadata.recordBytes < 1
    or metadata.recordBytes % 1 ~= 0
    or metadata.recordBytes > max_record_bytes then
    return nil
  end
  return metadata
end

local function read_counter(key)
  local encoded = redis.call("GET", key)
  if not encoded then return 0 end
  local value = tonumber(encoded)
  if not value or value < 0 or value % 1 ~= 0 then return nil end
  return value
end

if not record_bytes
  or not ttl_seconds
  or ttl_seconds < 1
  or ttl_seconds % 1 ~= 0
  or not max_record_bytes
  or not max_creator_bytes
  or not max_room_bytes
  or not max_global_bytes
  or not max_creator_count
  or not max_room_count
  or not max_global_count
  or max_record_bytes < 1
  or max_creator_bytes < max_record_bytes
  or max_room_bytes < max_creator_bytes
  or max_global_bytes < max_room_bytes
  or max_creator_count < 1
  or max_room_count < max_creator_count
  or max_global_count < max_room_count
  or record_bytes ~= string.len(record_json)
  or record_bytes < 1
  or record_bytes % 1 ~= 0
  or record_bytes > max_record_bytes then
  return { "record_too_large" }
end
if receipt_json ~= "" and (
  not receipt_ttl_seconds
  or receipt_ttl_seconds < 1
  or receipt_ttl_seconds % 1 ~= 0
) then return { "integrity_error" } end
local new_metadata = decode_metadata(metadata_json)
if not new_metadata
  or new_metadata.id ~= snapshot_id
  or new_metadata.sourceRoomId ~= source_room_id
  or new_metadata.creatorParticipantId ~= creator_participant_id
  or new_metadata.createdAt ~= created_at
  or new_metadata.recordBytes ~= record_bytes
  or snapshot_key_prefix .. snapshot_id ~= KEYS[1]
  or token_key_prefix .. new_metadata.tokenHash ~= KEYS[2]
  or metadata_key_prefix .. snapshot_id ~= KEYS[3]
  or creator_index_prefix .. source_room_id .. ":" .. creator_participant_id ~= KEYS[4]
  or room_index_prefix .. source_room_id ~= KEYS[5]
  or creator_bytes_prefix .. source_room_id .. ":" .. creator_participant_id ~= KEYS[7]
  or room_bytes_prefix .. source_room_id ~= KEYS[8] then
  return { "integrity_error" }
end

if receipt_json ~= "" then
  local existing_receipt = redis.call("GET", KEYS[10])
  if existing_receipt then return { "replay", existing_receipt } end
end
if redis.call("EXISTS", KEYS[1]) == 1
  or redis.call("EXISTS", KEYS[2]) == 1
  or redis.call("EXISTS", KEYS[3]) == 1 then
  return { "orphan" }
end

-- Counts cap the amount of index data a create can ever inspect. A bounded
-- two-cap repair window lets a deployment adopt the v3 limits without turning
-- a modest legacy overage into a permanently wedged room.
local creator_count = tonumber(redis.call("ZCARD", KEYS[4]))
local room_count = tonumber(redis.call("ZCARD", KEYS[5]))
local global_count = tonumber(redis.call("ZCARD", KEYS[6]))
local creator_bytes = read_counter(KEYS[7])
local room_bytes = read_counter(KEYS[8])
local global_bytes = read_counter(KEYS[9])
if not creator_bytes or not room_bytes or not global_bytes then
  return { "integrity_error" }
end
local creator_scan_limit = max_creator_count * 2
local room_scan_limit = max_room_count * 2
local global_scan_limit = max_global_count * 2
if creator_count > creator_scan_limit
  or room_count > room_scan_limit
  or global_count > global_scan_limit then
  return { "capacity_error" }
end

local removed = {}
local removals = {}
local metadata_cache = {}
local creator_deltas = {}
local room_deltas = {}
local global_delta = 0

local function load_candidate(indexed_id)
  if metadata_cache[indexed_id] then return metadata_cache[indexed_id] end
  local encoded_metadata = redis.call("GET", metadata_key_prefix .. indexed_id)
  local metadata = decode_metadata(encoded_metadata)
  if not metadata or metadata.id ~= indexed_id then return nil end
  local expected_creator_index = creator_index_prefix .. metadata.sourceRoomId .. ":" .. metadata.creatorParticipantId
  local expected_room_index = room_index_prefix .. metadata.sourceRoomId
  local global_score = tonumber(redis.call("ZSCORE", KEYS[6], indexed_id))
  local creator_score = tonumber(redis.call("ZSCORE", expected_creator_index, indexed_id))
  local room_score = tonumber(redis.call("ZSCORE", expected_room_index, indexed_id))
  if global_score ~= metadata.createdAt
    or creator_score ~= metadata.createdAt
    or room_score ~= metadata.createdAt then return nil end

  local actual_record_bytes = tonumber(redis.call("STRLEN", snapshot_key_prefix .. indexed_id))
  local token_target = redis.call("GET", token_key_prefix .. metadata.tokenHash)
  if actual_record_bytes > 0 and actual_record_bytes ~= metadata.recordBytes then
    return nil
  end
  if token_target and token_target ~= indexed_id then return nil end
  metadata_cache[indexed_id] = metadata
  return metadata
end

local function mark_removed(metadata)
  if removed[metadata.id] then return end
  removed[metadata.id] = true
  table.insert(removals, metadata)
  global_bytes = global_bytes - metadata.recordBytes
  global_count = global_count - 1
  if metadata.sourceRoomId == source_room_id then
    room_bytes = room_bytes - metadata.recordBytes
    room_count = room_count - 1
    if metadata.creatorParticipantId == creator_participant_id then
      creator_bytes = creator_bytes - metadata.recordBytes
      creator_count = creator_count - 1
    end
  end
  local creator_counter_key = creator_bytes_prefix .. metadata.sourceRoomId .. ":" .. metadata.creatorParticipantId
  local room_counter_key = room_bytes_prefix .. metadata.sourceRoomId
  creator_deltas[creator_counter_key] = (creator_deltas[creator_counter_key] or 0) + metadata.recordBytes
  room_deltas[room_counter_key] = (room_deltas[room_counter_key] or 0) + metadata.recordBytes
  global_delta = global_delta + metadata.recordBytes
end

if creator_bytes + record_bytes > max_creator_bytes
  or creator_count + 1 > max_creator_count then
  local ids = redis.call("ZRANGE", KEYS[4], 0, creator_scan_limit - 1)
  for _, indexed_id in ipairs(ids) do
    if creator_bytes + record_bytes <= max_creator_bytes
      and creator_count + 1 <= max_creator_count then break end
    local metadata = load_candidate(indexed_id)
    if not metadata
      or metadata.sourceRoomId ~= source_room_id
      or metadata.creatorParticipantId ~= creator_participant_id then
      return { "integrity_error" }
    end
    mark_removed(metadata)
  end
end

if room_bytes + record_bytes > max_room_bytes
  or room_count + 1 > max_room_count then
  local ids = redis.call("ZRANGE", KEYS[5], 0, room_scan_limit - 1)
  for _, indexed_id in ipairs(ids) do
    if room_bytes + record_bytes <= max_room_bytes
      and room_count + 1 <= max_room_count then break end
    if not removed[indexed_id] then
      local metadata = load_candidate(indexed_id)
      if not metadata or metadata.sourceRoomId ~= source_room_id then
        return { "integrity_error" }
      end
      mark_removed(metadata)
    end
  end
end

if global_bytes + record_bytes > max_global_bytes
  or global_count + 1 > max_global_count then
  local ids = redis.call("ZRANGE", KEYS[6], 0, global_scan_limit - 1)
  for _, indexed_id in ipairs(ids) do
    if global_bytes + record_bytes <= max_global_bytes
      and global_count + 1 <= max_global_count then break end
    if not removed[indexed_id] then
      local metadata = load_candidate(indexed_id)
      if not metadata then return { "integrity_error" } end
      mark_removed(metadata)
    end
  end
end
if creator_bytes + record_bytes > max_creator_bytes
  or creator_count + 1 > max_creator_count
  or room_bytes + record_bytes > max_room_bytes
  or room_count + 1 > max_room_count
  or global_bytes + record_bytes > max_global_bytes
  or global_count + 1 > max_global_count then return { "capacity_error" } end

for counter_key, delta in pairs(creator_deltas) do
  local current = read_counter(counter_key)
  if not current or current < delta then return { "integrity_error" } end
end
for counter_key, delta in pairs(room_deltas) do
  local current = read_counter(counter_key)
  if not current or current < delta then return { "integrity_error" } end
end
local current_global_counter = read_counter(KEYS[9])
if not current_global_counter or current_global_counter < global_delta then
  return { "integrity_error" }
end

local function subtract_counter(counter_key, delta)
  local current = read_counter(counter_key)
  local next_value = current - delta
  if next_value == 0 then redis.call("DEL", counter_key) else redis.call("SET", counter_key, next_value) end
end
for _, metadata in ipairs(removals) do
  redis.call("DEL", snapshot_key_prefix .. metadata.id)
  redis.call("DEL", token_key_prefix .. metadata.tokenHash)
  redis.call("DEL", metadata_key_prefix .. metadata.id)
  redis.call("ZREM", creator_index_prefix .. metadata.sourceRoomId .. ":" .. metadata.creatorParticipantId, metadata.id)
  redis.call("ZREM", room_index_prefix .. metadata.sourceRoomId, metadata.id)
  redis.call("ZREM", KEYS[6], metadata.id)
end
for counter_key, delta in pairs(creator_deltas) do subtract_counter(counter_key, delta) end
for counter_key, delta in pairs(room_deltas) do subtract_counter(counter_key, delta) end
if global_delta > 0 then subtract_counter(KEYS[9], global_delta) end

redis.call("SET", KEYS[1], record_json, "EX", ttl_seconds)
redis.call("SET", KEYS[2], snapshot_id, "EX", ttl_seconds)
redis.call("SET", KEYS[3], metadata_json)
redis.call("ZADD", KEYS[4], created_at, snapshot_id)
redis.call("ZADD", KEYS[5], created_at, snapshot_id)
redis.call("ZADD", KEYS[6], created_at, snapshot_id)
redis.call("INCRBY", KEYS[7], record_bytes)
redis.call("INCRBY", KEYS[8], record_bytes)
redis.call("INCRBY", KEYS[9], record_bytes)
if receipt_json ~= "" then redis.call("SET", KEYS[10], receipt_json, "EX", receipt_ttl_seconds) end
return { "created", receipt_json, metadata_json }
`;

export const LIST_REDIS_SNAPSHOTS_SCRIPT = `
-- jazzboard:snapshot-list:v2
local room_id = ARGV[1]
local participant_id = ARGV[2]
local now_ms = tonumber(ARGV[3])
local max_count = tonumber(ARGV[4])
local max_creator_bytes = tonumber(ARGV[5])
local snapshot_key_prefix = ARGV[6]
local token_key_prefix = ARGV[7]
local metadata_key_prefix = ARGV[8]
local room_index_prefix = ARGV[9]

local function decode_metadata(encoded)
  if not encoded then return nil end
  local ok, metadata = pcall(cjson.decode, encoded)
  if not ok or type(metadata) ~= "table" or metadata.v ~= 1
    or type(metadata.id) ~= "string" or type(metadata.tokenHash) ~= "string"
    or type(metadata.sourceRoomId) ~= "string" or type(metadata.creatorParticipantId) ~= "string"
    or type(metadata.createdAt) ~= "number" or type(metadata.expiresAt) ~= "number"
    or type(metadata.recordBytes) ~= "number" or metadata.recordBytes < 1
    or metadata.recordBytes % 1 ~= 0 then return nil end
  return metadata
end
local function read_counter(key)
  local encoded = redis.call("GET", key)
  if not encoded then return 0 end
  local value = tonumber(encoded)
  if not value or value < 0 or value % 1 ~= 0 then return nil end
  return value
end

local indexed_count = tonumber(redis.call("ZCARD", KEYS[1]))
if indexed_count > max_count * 2 then return { "integrity_error" } end
local ids = redis.call("ZREVRANGE", KEYS[1], 0, max_count * 2 - 1)
local entries = {}
local creator_sum = 0
local stale = {}
local stale_bytes = 0
for _, snapshot_id in ipairs(ids) do
  local encoded = redis.call("GET", metadata_key_prefix .. snapshot_id)
  local metadata = decode_metadata(encoded)
  if not metadata or metadata.id ~= snapshot_id
    or metadata.sourceRoomId ~= room_id or metadata.creatorParticipantId ~= participant_id
    or tonumber(redis.call("ZSCORE", KEYS[3], snapshot_id)) ~= metadata.createdAt
    or tonumber(redis.call("ZSCORE", KEYS[5], snapshot_id)) ~= metadata.createdAt then
    return { "integrity_error" }
  end
  local actual_bytes = tonumber(redis.call("STRLEN", snapshot_key_prefix .. snapshot_id))
  local token_target = redis.call("GET", token_key_prefix .. metadata.tokenHash)
  if actual_bytes > 0 and actual_bytes ~= metadata.recordBytes then return { "integrity_error" } end
  if token_target and token_target ~= snapshot_id then return { "integrity_error" } end
  if metadata.expiresAt <= now_ms or actual_bytes == 0 or not token_target then
    stale[snapshot_id] = true
    stale_bytes = stale_bytes + metadata.recordBytes
  end
  creator_sum = creator_sum + metadata.recordBytes
  table.insert(entries, { metadata = metadata, encoded = encoded })
end

local creator_counter = read_counter(KEYS[2])
local room_counter = read_counter(KEYS[4])
local global_counter = read_counter(KEYS[6])
if not creator_counter or not room_counter or not global_counter
  or creator_counter ~= creator_sum or room_counter < stale_bytes or global_counter < stale_bytes then
  return { "integrity_error" }
end
local live_count = 0
local live_bytes = 0
for _, entry in ipairs(entries) do
  if not stale[entry.metadata.id] then
    live_count = live_count + 1
    live_bytes = live_bytes + entry.metadata.recordBytes
  end
end
if live_count > max_count or live_bytes > max_creator_bytes then return { "integrity_error" } end

for _, entry in ipairs(entries) do
  local metadata = entry.metadata
  if stale[metadata.id] then
    redis.call("DEL", snapshot_key_prefix .. metadata.id)
    redis.call("DEL", token_key_prefix .. metadata.tokenHash)
    redis.call("DEL", metadata_key_prefix .. metadata.id)
    redis.call("ZREM", KEYS[1], metadata.id)
    redis.call("ZREM", KEYS[3], metadata.id)
    redis.call("ZREM", KEYS[5], metadata.id)
  end
end
if stale_bytes > 0 then
  local next_creator = creator_counter - stale_bytes
  local next_room = room_counter - stale_bytes
  local next_global = global_counter - stale_bytes
  if next_creator == 0 then redis.call("DEL", KEYS[2]) else redis.call("SET", KEYS[2], next_creator) end
  if next_room == 0 then redis.call("DEL", KEYS[4]) else redis.call("SET", KEYS[4], next_room) end
  if next_global == 0 then redis.call("DEL", KEYS[6]) else redis.call("SET", KEYS[6], next_global) end
end
local result = { "ok" }
for _, entry in ipairs(entries) do
  if not stale[entry.metadata.id] then table.insert(result, entry.encoded) end
end
return result
`;

export const READ_REDIS_SNAPSHOT_BY_TOKEN_SCRIPT = `
-- jazzboard:snapshot-read:v2
local token_hash = ARGV[1]
local now_ms = tonumber(ARGV[2])
local snapshot_key_prefix = ARGV[3]
local metadata_key_prefix = ARGV[4]
local creator_index_prefix = ARGV[5]
local room_index_prefix = ARGV[6]
local creator_bytes_prefix = ARGV[7]
local room_bytes_prefix = ARGV[8]

local snapshot_id = redis.call("GET", KEYS[1])
if not snapshot_id then return { "not_found" } end
local encoded_metadata = redis.call("GET", metadata_key_prefix .. snapshot_id)
if not encoded_metadata then return { "integrity_error" } end
local ok, metadata = pcall(cjson.decode, encoded_metadata)
if not ok or type(metadata) ~= "table" or metadata.v ~= 1
  or metadata.id ~= snapshot_id or metadata.tokenHash ~= token_hash
  or type(metadata.sourceRoomId) ~= "string" or type(metadata.creatorParticipantId) ~= "string"
  or type(metadata.expiresAt) ~= "number" or type(metadata.recordBytes) ~= "number" then
  return { "integrity_error" }
end
local record_json = redis.call("GET", snapshot_key_prefix .. snapshot_id)
if record_json and metadata.expiresAt > now_ms then
  if string.len(record_json) ~= metadata.recordBytes then return { "integrity_error" } end
  local record_ok, record = pcall(cjson.decode, record_json)
  if not record_ok or type(record) ~= "table" or record.id ~= snapshot_id
    or record.tokenHash ~= token_hash
    or record.sourceRoomId ~= metadata.sourceRoomId
    or record.sourceRoomRevision ~= metadata.sourceRoomRevision
    or record.creatorParticipantId ~= metadata.creatorParticipantId
    or record.createdAt ~= metadata.createdAt
    or record.expiresAt ~= metadata.expiresAt then return { "integrity_error" } end
  return { "found", record_json }
end

local creator_index = creator_index_prefix .. metadata.sourceRoomId .. ":" .. metadata.creatorParticipantId
local room_index = room_index_prefix .. metadata.sourceRoomId
local creator_counter_key = creator_bytes_prefix .. metadata.sourceRoomId .. ":" .. metadata.creatorParticipantId
local room_counter_key = room_bytes_prefix .. metadata.sourceRoomId
local creator_counter = tonumber(redis.call("GET", creator_counter_key) or "0")
local room_counter = tonumber(redis.call("GET", room_counter_key) or "0")
local global_counter = tonumber(redis.call("GET", KEYS[3]) or "0")
if not creator_counter or not room_counter or not global_counter
  or creator_counter < metadata.recordBytes or room_counter < metadata.recordBytes
  or global_counter < metadata.recordBytes
  or not redis.call("ZSCORE", creator_index, snapshot_id)
  or not redis.call("ZSCORE", room_index, snapshot_id)
  or not redis.call("ZSCORE", KEYS[2], snapshot_id) then return { "integrity_error" } end
redis.call("DEL", snapshot_key_prefix .. snapshot_id)
redis.call("DEL", KEYS[1])
redis.call("DEL", metadata_key_prefix .. snapshot_id)
redis.call("ZREM", creator_index, snapshot_id)
redis.call("ZREM", room_index, snapshot_id)
redis.call("ZREM", KEYS[2], snapshot_id)
local next_creator = creator_counter - metadata.recordBytes
local next_room = room_counter - metadata.recordBytes
local next_global = global_counter - metadata.recordBytes
if next_creator == 0 then redis.call("DEL", creator_counter_key) else redis.call("SET", creator_counter_key, next_creator) end
if next_room == 0 then redis.call("DEL", room_counter_key) else redis.call("SET", room_counter_key, next_room) end
if next_global == 0 then redis.call("DEL", KEYS[3]) else redis.call("SET", KEYS[3], next_global) end
return { "not_found" }
`;

export const REVOKE_IDEMPOTENT_REDIS_SNAPSHOT_SCRIPT = `
-- jazzboard:snapshot-revoke:v2
local receipt_json = ARGV[1]
local receipt_ttl_seconds = tonumber(ARGV[2])
local room_id = ARGV[3]
local participant_id = ARGV[4]
local snapshot_id = ARGV[5]
local token_key_prefix = ARGV[6]
local now_ms = tonumber(ARGV[7])

if receipt_json ~= "" then
  local existing_receipt = redis.call("GET", KEYS[1])
  if existing_receipt then return { "replay", existing_receipt } end
end
local encoded_metadata = redis.call("GET", KEYS[3])
local record_json = redis.call("GET", KEYS[2])
if not encoded_metadata then
  if record_json then return { "integrity_error" } end
  return { "not_found" }
end
local metadata_ok, metadata = pcall(cjson.decode, encoded_metadata)
if not metadata_ok or type(metadata) ~= "table" or metadata.v ~= 1
  or metadata.id ~= snapshot_id or type(metadata.tokenHash) ~= "string"
  or type(metadata.recordBytes) ~= "number" or type(metadata.expiresAt) ~= "number" then
  return { "integrity_error" }
end
if metadata.sourceRoomId ~= room_id or metadata.creatorParticipantId ~= participant_id then return { "not_found" } end
if not redis.call("ZSCORE", KEYS[4], snapshot_id)
  or not redis.call("ZSCORE", KEYS[5], snapshot_id)
  or not redis.call("ZSCORE", KEYS[6], snapshot_id) then return { "integrity_error" } end
local creator_counter = tonumber(redis.call("GET", KEYS[7]) or "0")
local room_counter = tonumber(redis.call("GET", KEYS[8]) or "0")
local global_counter = tonumber(redis.call("GET", KEYS[9]) or "0")
if not creator_counter or not room_counter or not global_counter
  or creator_counter < metadata.recordBytes or room_counter < metadata.recordBytes
  or global_counter < metadata.recordBytes then return { "integrity_error" } end

local token_target = redis.call("GET", token_key_prefix .. metadata.tokenHash)
if token_target and token_target ~= snapshot_id then return { "integrity_error" } end
local live = record_json and metadata.expiresAt > now_ms
if live then
  if string.len(record_json) ~= metadata.recordBytes then return { "integrity_error" } end
  local record_ok, record = pcall(cjson.decode, record_json)
  if not record_ok or type(record) ~= "table" or record.id ~= snapshot_id
    or record.sourceRoomId ~= room_id or record.creatorParticipantId ~= participant_id
    or record.tokenHash ~= metadata.tokenHash then return { "integrity_error" } end
  if token_target ~= snapshot_id then return { "integrity_error" } end
end

if live and receipt_json ~= "" then redis.call("SET", KEYS[1], receipt_json, "EX", receipt_ttl_seconds) end
redis.call("DEL", KEYS[2])
redis.call("DEL", token_key_prefix .. metadata.tokenHash)
redis.call("DEL", KEYS[3])
redis.call("ZREM", KEYS[4], snapshot_id)
redis.call("ZREM", KEYS[5], snapshot_id)
redis.call("ZREM", KEYS[6], snapshot_id)
local next_creator = creator_counter - metadata.recordBytes
local next_room = room_counter - metadata.recordBytes
local next_global = global_counter - metadata.recordBytes
if next_creator == 0 then redis.call("DEL", KEYS[7]) else redis.call("SET", KEYS[7], next_creator) end
if next_room == 0 then redis.call("DEL", KEYS[8]) else redis.call("SET", KEYS[8], next_room) end
if next_global == 0 then redis.call("DEL", KEYS[9]) else redis.call("SET", KEYS[9], next_global) end
if live then return { "revoked", receipt_json } end
return { "not_found" }
`;
