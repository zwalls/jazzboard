import { createHash, randomBytes } from "node:crypto";

import type Redis from "ioredis";

import type {
  AgentMessage,
  AgentMessageListResult,
  AgentMessageReply,
  AgentMessageState,
} from "@/lib/agent-messages/types";
import { DomainError } from "@/lib/domain/errors";

import { getRedisForRealtime } from "./room-store";

const KEY_PREFIX = "jazzboard:{agent-messages}:v1:";
export const AGENT_MESSAGE_TTL_SECONDS = 60 * 60 * 24 * 30;
export const DEFAULT_AGENT_MESSAGE_LIMITS = Object.freeze({
  incomingBytes: 512 * 1024,
  retainedBytes: 2 * 1024 * 1024,
  retainedCount: 200,
  listResponseBytes: 1024 * 1024,
});

export type AgentMessageLimits = {
  incomingBytes: number;
  retainedBytes: number;
  retainedCount: number;
  listResponseBytes: number;
};

export type AgentMessageScope = {
  roomId: string;
  participantId: string;
};

export type AgentMessageListOptions = {
  status?: AgentMessageState;
  limit: number;
  afterSequence?: number;
  order?: "oldest" | "newest";
};

type StoredClaim = {
  id: string;
  leaseSeconds: number;
  token: string;
  claimedAt: number;
  until: number;
};

export type StoredAgentMessage = AgentMessage & {
  requestFingerprint: string;
  claim: StoredClaim | null;
  replyFingerprint: string | null;
};

type StoredChannel = {
  v: 1;
  nextSequence: number;
  messages: StoredAgentMessage[];
};

export type NewStoredAgentMessage = Omit<
  StoredAgentMessage,
  "sequence" | "version" | "state" | "claimedUntil" | "reply" | "claim" | "replyFingerprint"
>;

export interface AgentMessageStore {
  create(scope: AgentMessageScope, message: NewStoredAgentMessage): Promise<AgentMessage>;
  list(scope: AgentMessageScope, options: AgentMessageListOptions): Promise<AgentMessageListResult>;
  claim(input: {
    scope: AgentMessageScope;
    messageId: string;
    claimId: string;
    leaseSeconds: number;
    now: number;
  }): Promise<{ message: AgentMessage; claimToken: string }>;
  reply(input: {
    scope: AgentMessageScope;
    messageId: string;
    reply: AgentMessageReply;
    claimToken: string;
    replyFingerprint: string;
    now: number;
  }): Promise<AgentMessage>;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function limits(input: Partial<AgentMessageLimits>): AgentMessageLimits {
  const resolved = {
    incomingBytes: positiveInteger(input.incomingBytes ?? DEFAULT_AGENT_MESSAGE_LIMITS.incomingBytes, "Incoming byte limit"),
    retainedBytes: positiveInteger(input.retainedBytes ?? DEFAULT_AGENT_MESSAGE_LIMITS.retainedBytes, "Retained byte limit"),
    retainedCount: positiveInteger(input.retainedCount ?? DEFAULT_AGENT_MESSAGE_LIMITS.retainedCount, "Retained count limit"),
    listResponseBytes: positiveInteger(
      input.listResponseBytes ?? DEFAULT_AGENT_MESSAGE_LIMITS.listResponseBytes,
      "List response byte limit",
    ),
  };
  if (resolved.incomingBytes > resolved.retainedBytes) {
    throw new Error("The incoming byte limit cannot exceed the retained byte limit.");
  }
  return resolved;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function keyPart(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) {
    throw new DomainError("INVALID_OPERATION", `${label} is invalid.`);
  }
  return value;
}

export function agentMessageRedisKey(scope: AgentMessageScope): string {
  return `${KEY_PREFIX}${keyPart(scope.roomId, "Room ID")}:${keyPart(scope.participantId, "Participant ID")}`;
}

export function agentMessageRequestFingerprint(input: {
  prompt: string;
  selectedObjectIds: readonly string[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify([input.prompt, input.selectedObjectIds]))
    .digest("hex");
}

export function agentMessageReplyFingerprint(input: {
  replyId: string;
  claimToken: string;
  text: string;
  outcome: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([input.replyId, input.claimToken, input.text, input.outcome]))
    .digest("hex");
}

function storageError(message: string): DomainError {
  return new DomainError("MUTATION_OUTCOME_UNKNOWN", message, { agentMessageStoreCorrupt: true });
}

function parseChannel(encoded: string): StoredChannel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw storageError("The private agent-message channel is malformed.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as StoredChannel).v !== 1 ||
    !Number.isSafeInteger((parsed as StoredChannel).nextSequence) ||
    (parsed as StoredChannel).nextSequence < 1 ||
    !Array.isArray((parsed as StoredChannel).messages)
  ) {
    throw storageError("The private agent-message channel is malformed.");
  }
  const channel = parsed as StoredChannel;
  let lastSequence = 0;
  for (const message of channel.messages) {
    if (
      !message ||
      typeof message.id !== "string" ||
      !Number.isSafeInteger(message.sequence) ||
      message.sequence <= lastSequence ||
      !Number.isSafeInteger(message.version) ||
      message.version < 1 ||
      !["pending", "claimed", "answered"].includes(message.state) ||
      typeof message.requestFingerprint !== "string"
    ) {
      throw storageError("A private agent-message entry is malformed.");
    }
    lastSequence = message.sequence;
  }
  if (channel.nextSequence <= lastSequence) {
    throw storageError("The private agent-message sequence is malformed.");
  }
  return channel;
}

function publicMessage(stored: StoredAgentMessage, now: number): AgentMessage {
  const message: AgentMessage = {
    id: stored.id,
    sequence: stored.sequence,
    version: stored.version,
    state: stored.state,
    prompt: stored.prompt,
    createdAt: stored.createdAt,
    author: structuredClone(stored.author),
    context: structuredClone(stored.context),
    claimedUntil: stored.claimedUntil,
    reply: structuredClone(stored.reply),
  };
  if (message.state === "claimed" && (message.claimedUntil ?? 0) <= now) {
    message.state = "pending";
    message.claimedUntil = null;
  }
  return message;
}

function listChannel(
  channel: StoredChannel | null,
  options: AgentMessageListOptions,
  now: number,
  responseByteLimit: number,
): AgentMessageListResult {
  const matching = (channel?.messages ?? [])
    .map((message) => publicMessage(message, now))
    .filter((message) => options.afterSequence === undefined || message.sequence > options.afterSequence)
    .filter((message) => options.status === undefined || message.state === options.status);
  if (options.order === "newest") matching.reverse();
  const messages: AgentMessage[] = [];
  // Reserve a small amount for the response envelope and JSON separators so
  // the API remains safely below the configured byte budget.
  let responseBytes = 256;
  for (const message of matching) {
    if (messages.length >= options.limit) break;
    const messageBytes = encodedBytes(message) + 1;
    if (responseBytes + messageBytes > responseByteLimit) break;
    messages.push(message);
    responseBytes += messageBytes;
  }
  return {
    messages,
    totalMatched: matching.length,
    truncated: matching.length > messages.length,
  };
}

function messageNotFound(): DomainError {
  return new DomainError("MESSAGE_NOT_FOUND", "That private agent message was not found.");
}

function messageClaimed(message: StoredAgentMessage): DomainError {
  return new DomainError("MESSAGE_ALREADY_CLAIMED", "That message is already claimed by an agent.", {
    messageId: message.id,
    claimedUntil: message.claimedUntil,
  });
}

function messageAnswered(): DomainError {
  return new DomainError("MESSAGE_ALREADY_ANSWERED", "That message already has an agent reply.");
}

function retainedCapacityError(): DomainError {
  return new DomainError(
    "ROOM_CAPACITY_EXCEEDED",
    "The private message history is full of requests that cannot be safely evicted.",
  );
}

function enforceMemoryRetention(
  channel: StoredChannel,
  retention: AgentMessageLimits,
  protectedMessageId: string,
): void {
  while (
    channel.messages.length > retention.retainedCount ||
    encodedBytes(channel) > retention.retainedBytes
  ) {
    const answeredIndex = channel.messages.findIndex(
      (candidate) => candidate.id !== protectedMessageId && candidate.reply !== null,
    );
    if (answeredIndex < 0) throw retainedCapacityError();
    channel.messages.splice(answeredIndex, 1);
  }
}

type MemoryChannel = { channel: StoredChannel; expiresAt: number };
export type MemoryAgentMessageState = {
  channels: Map<string, MemoryChannel>;
  queues: Map<string, Promise<void>>;
};

export function createMemoryAgentMessageState(): MemoryAgentMessageState {
  return { channels: new Map(), queues: new Map() };
}

export class MemoryAgentMessageStore implements AgentMessageStore {
  private readonly limits: AgentMessageLimits;

  constructor(
    readonly state: MemoryAgentMessageState = createMemoryAgentMessageState(),
    limitsInput: Partial<AgentMessageLimits> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limits = limits(limitsInput);
  }

  private async locked<T>(scope: AgentMessageScope, operation: (channel: StoredChannel) => T): Promise<T> {
    const key = agentMessageRedisKey(scope);
    const prior = this.state.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => gate);
    this.state.queues.set(key, queued);
    await prior;
    try {
      const current = this.state.channels.get(key);
      const channel = current && current.expiresAt > this.now()
        ? structuredClone(current.channel)
        : { v: 1 as const, nextSequence: 1, messages: [] };
      const result = operation(channel);
      this.state.channels.set(key, {
        channel,
        expiresAt: this.now() + AGENT_MESSAGE_TTL_SECONDS * 1_000,
      });
      return result;
    } finally {
      release();
      if (this.state.queues.get(key) === queued) this.state.queues.delete(key);
    }
  }

  async create(scope: AgentMessageScope, input: NewStoredAgentMessage): Promise<AgentMessage> {
    return this.locked(scope, (channel) => {
      const existing = channel.messages.find((message) => message.id === input.id);
      if (existing) {
        if (existing.requestFingerprint !== input.requestFingerprint) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "That message ID is already associated with a different request.");
        }
        return publicMessage(existing, this.now());
      }
      const message: StoredAgentMessage = {
        ...structuredClone(input),
        sequence: channel.nextSequence,
        version: 1,
        state: "pending",
        claimedUntil: null,
        reply: null,
        claim: null,
        replyFingerprint: null,
      };
      const incomingBytes = encodedBytes(message);
      if (incomingBytes > this.limits.incomingBytes) {
        throw new DomainError("REQUEST_TOO_LARGE", "The selected context is too large for a private agent message.", {
          used: incomingBytes,
          limit: this.limits.incomingBytes,
        });
      }
      channel.nextSequence += 1;
      channel.messages.push(message);
      enforceMemoryRetention(channel, this.limits, message.id);
      return publicMessage(message, this.now());
    });
  }

  async list(scope: AgentMessageScope, options: AgentMessageListOptions): Promise<AgentMessageListResult> {
    const key = agentMessageRedisKey(scope);
    const stored = this.state.channels.get(key);
    if (!stored || stored.expiresAt <= this.now()) {
      if (stored) this.state.channels.delete(key);
      return listChannel(null, options, this.now(), this.limits.listResponseBytes);
    }
    return listChannel(
      structuredClone(stored.channel),
      options,
      this.now(),
      this.limits.listResponseBytes,
    );
  }

  async claim(input: {
    scope: AgentMessageScope;
    messageId: string;
    claimId: string;
    leaseSeconds: number;
    now: number;
  }): Promise<{ message: AgentMessage; claimToken: string }> {
    return this.locked(input.scope, (channel) => {
      const message = channel.messages.find((candidate) => candidate.id === input.messageId);
      if (!message) throw messageNotFound();
      if (message.claim?.id === input.claimId) {
        if (message.claim.leaseSeconds !== input.leaseSeconds) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "That claim ID is already associated with a different lease.");
        }
        return { message: publicMessage(message, input.now), claimToken: message.claim.token };
      }
      if (message.reply) throw messageAnswered();
      if (message.claim && message.claim.until > input.now) throw messageClaimed(message);
      const token = randomBytes(32).toString("base64url");
      const until = input.now + input.leaseSeconds * 1_000;
      message.claim = {
        id: input.claimId,
        leaseSeconds: input.leaseSeconds,
        token,
        claimedAt: input.now,
        until,
      };
      message.state = "claimed";
      message.claimedUntil = until;
      message.version += 1;
      enforceMemoryRetention(channel, this.limits, message.id);
      return { message: publicMessage(message, input.now), claimToken: token };
    });
  }

  async reply(input: {
    scope: AgentMessageScope;
    messageId: string;
    reply: AgentMessageReply;
    claimToken: string;
    replyFingerprint: string;
    now: number;
  }): Promise<AgentMessage> {
    return this.locked(input.scope, (channel) => {
      const message = channel.messages.find((candidate) => candidate.id === input.messageId);
      if (!message) throw messageNotFound();
      if (message.reply) {
        if (message.replyFingerprint !== input.replyFingerprint) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "That message already has a different reply.");
        }
        return publicMessage(message, input.now);
      }
      if (!message.claim || message.claim.token !== input.claimToken) {
        throw new DomainError("MESSAGE_CLAIM_REQUIRED", "A valid agent claim is required before replying.");
      }
      if (message.claim.until <= input.now) {
        throw new DomainError("MESSAGE_CLAIM_EXPIRED", "The agent claim expired before the reply was submitted.");
      }
      message.reply = structuredClone(input.reply);
      message.replyFingerprint = input.replyFingerprint;
      message.state = "answered";
      message.claimedUntil = null;
      message.version += 1;
      enforceMemoryRetention(channel, this.limits, message.id);
      return publicMessage(message, input.now);
    });
  }
}

const CREATE_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
local state = raw and cjson.decode(raw) or { v = 1, nextSequence = 1, messages = {} }
local candidate = cjson.decode(ARGV[1])
for _, message in ipairs(state.messages) do
  if message.id == candidate.id then
    if message.requestFingerprint ~= candidate.requestFingerprint then return { "idempotency_conflict" } end
    redis.call("EXPIRE", KEYS[1], tonumber(ARGV[5]))
    return { "replayed", cjson.encode(message) }
  end
end
candidate.sequence = state.nextSequence
candidate.version = 1
candidate.state = "pending"
candidate.claimedUntil = cjson.null
candidate.reply = cjson.null
candidate.claim = cjson.null
candidate.replyFingerprint = cjson.null
local candidateRaw = cjson.encode(candidate)
if string.len(candidateRaw) > tonumber(ARGV[2]) then return { "too_large", tostring(string.len(candidateRaw)) } end
state.nextSequence = state.nextSequence + 1
table.insert(state.messages, candidate)
local encoded = cjson.encode(state)
while #state.messages > tonumber(ARGV[3]) or string.len(encoded) > tonumber(ARGV[4]) do
  local answeredIndex = nil
  for index, message in ipairs(state.messages) do
    if message.reply ~= nil and message.reply ~= cjson.null then answeredIndex = index break end
  end
  if answeredIndex == nil then return { "capacity" } end
  table.remove(state.messages, answeredIndex)
  encoded = cjson.encode(state)
end
redis.call("SET", KEYS[1], encoded, "EX", tonumber(ARGV[5]))
return { "stored", cjson.encode(candidate) }
`;

const CLAIM_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return { "not_found" } end
local state = cjson.decode(raw)
local message = nil
for _, candidate in ipairs(state.messages) do if candidate.id == ARGV[1] then message = candidate break end end
if not message then return { "not_found" } end
if message.claim ~= nil and message.claim ~= cjson.null and message.claim.id == ARGV[2] then
  if tonumber(message.claim.leaseSeconds) ~= tonumber(ARGV[3]) then return { "idempotency_conflict" } end
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[7]))
  return { "replayed", cjson.encode(message), message.claim.token }
end
if message.reply ~= nil and message.reply ~= cjson.null then return { "answered" } end
if message.claim ~= nil and message.claim ~= cjson.null and tonumber(message.claim["until"]) > tonumber(ARGV[4]) then
  return { "claimed", tostring(message.claim["until"]) }
end
local untilAt = tonumber(ARGV[4]) + tonumber(ARGV[3]) * 1000
message.claim = { id = ARGV[2], leaseSeconds = tonumber(ARGV[3]), token = ARGV[5], claimedAt = tonumber(ARGV[4]), ["until"] = untilAt }
message.state = "claimed"
message.claimedUntil = untilAt
message.version = tonumber(message.version) + 1
local encoded = cjson.encode(state)
while string.len(encoded) > tonumber(ARGV[6]) do
  local answeredIndex = nil
  for index, candidate in ipairs(state.messages) do
    if candidate.id ~= ARGV[1] and candidate.reply ~= nil and candidate.reply ~= cjson.null then answeredIndex = index break end
  end
  if answeredIndex == nil then return { "capacity" } end
  table.remove(state.messages, answeredIndex)
  encoded = cjson.encode(state)
end
redis.call("SET", KEYS[1], encoded, "EX", tonumber(ARGV[7]))
return { "claimed_ok", cjson.encode(message), ARGV[5] }
`;

const REPLY_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return { "not_found" } end
local state = cjson.decode(raw)
local message = nil
for _, candidate in ipairs(state.messages) do if candidate.id == ARGV[1] then message = candidate break end end
if not message then return { "not_found" } end
if message.reply ~= nil and message.reply ~= cjson.null then
  if message.replyFingerprint ~= ARGV[2] then return { "idempotency_conflict" } end
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[7]))
  return { "replayed", cjson.encode(message) }
end
if message.claim == nil or message.claim == cjson.null or message.claim.token ~= ARGV[3] then return { "claim_required" } end
if tonumber(message.claim["until"]) <= tonumber(ARGV[4]) then return { "claim_expired" } end
message.reply = cjson.decode(ARGV[5])
message.replyFingerprint = ARGV[2]
message.state = "answered"
message.claimedUntil = cjson.null
message.version = tonumber(message.version) + 1
local encoded = cjson.encode(state)
while string.len(encoded) > tonumber(ARGV[6]) do
  local answeredIndex = nil
  for index, candidate in ipairs(state.messages) do
    if candidate.id ~= ARGV[1] and candidate.reply ~= nil and candidate.reply ~= cjson.null then answeredIndex = index break end
  end
  if answeredIndex == nil then return { "capacity" } end
  table.remove(state.messages, answeredIndex)
  encoded = cjson.encode(state)
end
redis.call("SET", KEYS[1], encoded, "EX", tonumber(ARGV[7]))
return { "answered_ok", cjson.encode(message) }
`;

const LIST_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return { "listed", "0", "0" } end
local state = cjson.decode(raw)
local status = ARGV[1]
local limit = tonumber(ARGV[2])
local afterSequence = ARGV[3] ~= "" and tonumber(ARGV[3]) or nil
local newest = ARGV[4] == "newest"
local now = tonumber(ARGV[5])
local byteLimit = tonumber(ARGV[6])
local responseBytes = 256
local totalMatched = 0
local truncated = false
local pageFull = false
local output = { "listed", "0", "0" }
for offset = 1, #state.messages do
  local index = newest and (#state.messages - offset + 1) or offset
  local message = state.messages[index]
  if message.state == "claimed" and message.claimedUntil ~= nil and message.claimedUntil ~= cjson.null and tonumber(message.claimedUntil) <= now then
    message.state = "pending"
    message.claimedUntil = cjson.null
  end
  local matchesSequence = afterSequence == nil or tonumber(message.sequence) > afterSequence
  local matchesStatus = status == "" or message.state == status
  if matchesSequence and matchesStatus then
    totalMatched = totalMatched + 1
    local encoded = cjson.encode(message)
    if not pageFull and (#output - 3) < limit and responseBytes + string.len(encoded) + 1 <= byteLimit then
      table.insert(output, encoded)
      responseBytes = responseBytes + string.len(encoded) + 1
    else
      truncated = true
      pageFull = true
    end
  end
end
output[2] = tostring(totalMatched)
output[3] = truncated and "1" or "0"
return output
`;

function redisResult(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((part) => typeof part !== "string" && !Buffer.isBuffer(part))) {
    throw storageError("The private agent-message mutation returned an unreadable result.");
  }
  return value.map((part) => Buffer.isBuffer(part) ? part.toString("utf8") : part as string);
}

function parseStoredMessage(encoded: string): StoredAgentMessage {
  try {
    const message = JSON.parse(encoded) as { sequence?: unknown };
    if (!Number.isSafeInteger(message.sequence)) throw new Error("invalid sequence");
    const channel = parseChannel(JSON.stringify({
      v: 1,
      nextSequence: Number(message.sequence) + 1,
      messages: [message],
    }));
    return channel.messages[0];
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw storageError("The private agent-message mutation returned malformed message JSON.");
  }
}

export class RedisAgentMessageStore implements AgentMessageStore {
  private readonly limits: AgentMessageLimits;

  constructor(private readonly redis: Redis, limitsInput: Partial<AgentMessageLimits> = {}) {
    this.limits = limits(limitsInput);
  }

  async create(scope: AgentMessageScope, input: NewStoredAgentMessage): Promise<AgentMessage> {
    const result = redisResult(await this.redis.eval(
      CREATE_SCRIPT,
      1,
      agentMessageRedisKey(scope),
      JSON.stringify(input),
      String(this.limits.incomingBytes),
      String(this.limits.retainedCount),
      String(this.limits.retainedBytes),
      String(AGENT_MESSAGE_TTL_SECONDS),
    ));
    if (result[0] === "idempotency_conflict") throw new DomainError("IDEMPOTENCY_CONFLICT", "That message ID is already associated with a different request.");
    if (result[0] === "too_large") throw new DomainError("REQUEST_TOO_LARGE", "The selected context is too large for a private agent message.", { used: Number(result[1]), limit: this.limits.incomingBytes });
    if (result[0] === "capacity") throw new DomainError("ROOM_CAPACITY_EXCEEDED", "The selected context cannot fit in the private message history budget.");
    if ((result[0] !== "stored" && result[0] !== "replayed") || !result[1]) throw storageError("The private agent-message create outcome is unknown.");
    return publicMessage(parseStoredMessage(result[1]), Date.now());
  }

  async list(scope: AgentMessageScope, options: AgentMessageListOptions): Promise<AgentMessageListResult> {
    const now = Date.now();
    const result = redisResult(await this.redis.eval(
      LIST_SCRIPT,
      1,
      agentMessageRedisKey(scope),
      options.status ?? "",
      String(options.limit),
      options.afterSequence === undefined ? "" : String(options.afterSequence),
      options.order ?? "oldest",
      String(now),
      String(this.limits.listResponseBytes),
    ));
    if (result[0] !== "listed" || !result[1] || !result[2]) {
      throw storageError("The private agent-message list outcome is unknown.");
    }
    const totalMatched = Number(result[1]);
    if (!Number.isSafeInteger(totalMatched) || totalMatched < 0 || !["0", "1"].includes(result[2])) {
      throw storageError("The private agent-message list outcome is malformed.");
    }
    return {
      messages: result.slice(3).map((encoded) => publicMessage(parseStoredMessage(encoded), now)),
      totalMatched,
      truncated: result[2] === "1",
    };
  }

  async claim(input: {
    scope: AgentMessageScope;
    messageId: string;
    claimId: string;
    leaseSeconds: number;
    now: number;
  }): Promise<{ message: AgentMessage; claimToken: string }> {
    const proposedToken = randomBytes(32).toString("base64url");
    const result = redisResult(await this.redis.eval(
      CLAIM_SCRIPT,
      1,
      agentMessageRedisKey(input.scope),
      input.messageId,
      input.claimId,
      String(input.leaseSeconds),
      String(input.now),
      proposedToken,
      String(this.limits.retainedBytes),
      String(AGENT_MESSAGE_TTL_SECONDS),
    ));
    if (result[0] === "not_found") throw messageNotFound();
    if (result[0] === "idempotency_conflict") throw new DomainError("IDEMPOTENCY_CONFLICT", "That claim ID is already associated with a different lease.");
    if (result[0] === "answered") throw messageAnswered();
    if (result[0] === "claimed") throw new DomainError("MESSAGE_ALREADY_CLAIMED", "That message is already claimed by an agent.", { messageId: input.messageId, claimedUntil: Number(result[1]) });
    if (result[0] === "capacity") throw retainedCapacityError();
    if ((result[0] !== "claimed_ok" && result[0] !== "replayed") || !result[1] || !result[2]) throw storageError("The private agent-message claim outcome is unknown.");
    return { message: publicMessage(parseStoredMessage(result[1]), input.now), claimToken: result[2] };
  }

  async reply(input: {
    scope: AgentMessageScope;
    messageId: string;
    reply: AgentMessageReply;
    claimToken: string;
    replyFingerprint: string;
    now: number;
  }): Promise<AgentMessage> {
    const result = redisResult(await this.redis.eval(
      REPLY_SCRIPT,
      1,
      agentMessageRedisKey(input.scope),
      input.messageId,
      input.replyFingerprint,
      input.claimToken,
      String(input.now),
      JSON.stringify(input.reply),
      String(this.limits.retainedBytes),
      String(AGENT_MESSAGE_TTL_SECONDS),
    ));
    if (result[0] === "not_found") throw messageNotFound();
    if (result[0] === "idempotency_conflict") throw new DomainError("IDEMPOTENCY_CONFLICT", "That message already has a different reply.");
    if (result[0] === "claim_required") throw new DomainError("MESSAGE_CLAIM_REQUIRED", "A valid agent claim is required before replying.");
    if (result[0] === "claim_expired") throw new DomainError("MESSAGE_CLAIM_EXPIRED", "The agent claim expired before the reply was submitted.");
    if (result[0] === "capacity") throw retainedCapacityError();
    if ((result[0] !== "answered_ok" && result[0] !== "replayed") || !result[1]) throw storageError("The private agent-message reply outcome is unknown.");
    return publicMessage(parseStoredMessage(result[1]), input.now);
  }
}

declare global {
  var __jazzboardAgentMessageStore: AgentMessageStore | undefined;
  var __jazzboardAgentMessageMemoryState: MemoryAgentMessageState | undefined;
}

export function getAgentMessageStore(): AgentMessageStore {
  if (globalThis.__jazzboardAgentMessageStore) return globalThis.__jazzboardAgentMessageStore;
  const redis = getRedisForRealtime();
  globalThis.__jazzboardAgentMessageMemoryState ??= createMemoryAgentMessageState();
  globalThis.__jazzboardAgentMessageStore = redis
    ? new RedisAgentMessageStore(redis)
    : new MemoryAgentMessageStore(globalThis.__jazzboardAgentMessageMemoryState);
  return globalThis.__jazzboardAgentMessageStore;
}

export function setAgentMessageStoreForTests(store: AgentMessageStore | undefined): void {
  globalThis.__jazzboardAgentMessageStore = store;
}
