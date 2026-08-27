// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type Redis from "ioredis";

import type { NewStoredAgentMessage } from "./agent-message-store";
import {
  agentMessageRedisKey,
  agentMessageReplyFingerprint,
  agentMessageRequestFingerprint,
  MemoryAgentMessageStore,
  RedisAgentMessageStore,
} from "./agent-message-store";

const scope = { roomId: "room_alpha", participantId: "p_alice" };
const human = { participantId: "p_alice", displayName: "Alice", color: "#123456", kind: "human" as const };
const agent = { ...human, kind: "agent" as const };

function candidate(id: string): NewStoredAgentMessage {
  const prompt = `Question ${id}`;
  const selectedObjectIds = [`object_${id}`];
  return {
    id,
    prompt,
    createdAt: 1_000,
    author: human,
    context: {
      room: { id: scope.roomId, title: "Room", roomRevision: 7 },
      selection: {
        objectIds: selectedObjectIds,
        objects: [],
        missingObjectIds: selectedObjectIds,
        diagrams: [],
        bounds: null,
      },
    },
    requestFingerprint: agentMessageRequestFingerprint({ prompt, selectedObjectIds }),
  };
}

async function answer(store: MemoryAgentMessageStore, messageId: string, now: number) {
  const claimed = await store.claim({ scope, messageId, claimId: `claim_${messageId}`, leaseSeconds: 60, now });
  const reply = { id: `reply_${messageId}`, text: "Done", outcome: "completed" as const, createdAt: now + 1, author: agent };
  return store.reply({
    scope,
    messageId,
    reply,
    claimToken: claimed.claimToken,
    replyFingerprint: agentMessageReplyFingerprint({ ...reply, claimToken: claimed.claimToken, replyId: reply.id }),
    now: now + 1,
  });
}

function retainedBytes(store: MemoryAgentMessageStore): number {
  const stored = [...store.state.channels.values()][0];
  if (!stored) return 0;
  return Buffer.byteLength(JSON.stringify(stored.channel), "utf8");
}

async function submitReply(
  store: MemoryAgentMessageStore,
  messageId: string,
  claimToken: string,
  text: string,
  now: number,
) {
  const reply = { id: `reply_${messageId}`, text, outcome: "completed" as const, createdAt: now, author: agent };
  return store.reply({
    scope,
    messageId,
    reply,
    claimToken,
    replyFingerprint: agentMessageReplyFingerprint({ ...reply, replyId: reply.id, claimToken }),
    now,
  });
}

describe("MemoryAgentMessageStore", () => {
  it("scopes private channels by participant and preserves stable create replay semantics", async () => {
    const store = new MemoryAgentMessageStore();
    const first = await store.create(scope, candidate("message_1"));
    const replay = await store.create(scope, { ...candidate("message_1"), createdAt: 9_999 });

    expect(replay).toEqual(first);
    await expect(store.create(scope, { ...candidate("message_1"), requestFingerprint: "different" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(store.list({ ...scope, participantId: "p_bob" }, { limit: 10 }))
      .resolves.toEqual({ messages: [], totalMatched: 0, truncated: false });
  });

  it("claims atomically, replays the exact claim, and fences conflicting or expired claims", async () => {
    const store = new MemoryAgentMessageStore();
    await store.create(scope, candidate("message_1"));
    const claimed = await store.claim({ scope, messageId: "message_1", claimId: "claim_1", leaseSeconds: 60, now: 1_000 });
    const replay = await store.claim({ scope, messageId: "message_1", claimId: "claim_1", leaseSeconds: 60, now: 2_000 });

    expect(replay).toEqual(claimed);
    await expect(store.claim({ scope, messageId: "message_1", claimId: "claim_2", leaseSeconds: 60, now: 2_000 }))
      .rejects.toMatchObject({ code: "MESSAGE_ALREADY_CLAIMED" });
    const reclaimed = await store.claim({ scope, messageId: "message_1", claimId: "claim_2", leaseSeconds: 60, now: 62_000 });
    expect(reclaimed.claimToken).not.toBe(claimed.claimToken);
    expect(reclaimed.message).toMatchObject({ state: "claimed", version: 3, claimedUntil: 122_000 });
  });

  it("accepts one reply under an active claim and provides exact reply replay", async () => {
    const store = new MemoryAgentMessageStore();
    await store.create(scope, candidate("message_1"));
    const claimed = await store.claim({ scope, messageId: "message_1", claimId: "claim_1", leaseSeconds: 60, now: 1_000 });
    const reply = { id: "reply_1", text: "Finished", outcome: "completed" as const, createdAt: 2_000, author: agent };
    const fingerprint = agentMessageReplyFingerprint({ ...reply, replyId: reply.id, claimToken: claimed.claimToken });
    const answered = await store.reply({ scope, messageId: "message_1", reply, claimToken: claimed.claimToken, replyFingerprint: fingerprint, now: 2_000 });
    const replay = await store.reply({ scope, messageId: "message_1", reply: { ...reply, createdAt: 9_999 }, claimToken: claimed.claimToken, replyFingerprint: fingerprint, now: 9_999 });

    expect(answered).toMatchObject({ state: "answered", version: 3, claimedUntil: null, reply });
    expect(replay).toEqual(answered);
    await expect(store.reply({ scope, messageId: "message_1", reply: { ...reply, text: "Changed" }, claimToken: claimed.claimToken, replyFingerprint: "different", now: 2_000 }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("never evicts actionable asks and evicts the oldest answered history first", async () => {
    const store = new MemoryAgentMessageStore(undefined, { retainedCount: 2 });
    await store.create(scope, candidate("message_1"));
    await store.create(scope, candidate("message_2"));
    await expect(store.create(scope, candidate("message_3")))
      .rejects.toMatchObject({ code: "ROOM_CAPACITY_EXCEEDED" });
    expect((await store.list(scope, { limit: 10 })).messages.map((message) => message.id))
      .toEqual(["message_1", "message_2"]);

    await answer(store, "message_1", 2_000);
    await store.create(scope, candidate("message_3"));
    expect((await store.list(scope, { limit: 10 })).messages.map((message) => message.id))
      .toEqual(["message_2", "message_3"]);
  });

  it("supports cursor filtering, status at observation time, truncation, and route-selected ordering", async () => {
    let now = 1_000;
    const store = new MemoryAgentMessageStore(undefined, {}, () => now);
    await store.create(scope, candidate("message_1"));
    await store.create(scope, candidate("message_2"));
    await store.claim({ scope, messageId: "message_2", claimId: "claim_2", leaseSeconds: 15, now });
    await store.create(scope, candidate("message_3"));

    expect((await store.list(scope, { limit: 2, order: "newest" })).messages.map((message) => message.id))
      .toEqual(["message_3", "message_2"]);
    expect(await store.list(scope, { limit: 1, afterSequence: 1, order: "oldest" }))
      .toMatchObject({ totalMatched: 2, truncated: true, messages: [{ id: "message_2" }] });
    now = 20_000;
    expect((await store.list(scope, { limit: 10, status: "pending" })).messages.map((message) => message.id))
      .toEqual(["message_1", "message_2", "message_3"]);
  });

  it("bounds list responses by encoded bytes as well as record count", async () => {
    const store = new MemoryAgentMessageStore(undefined, {
      incomingBytes: 250_000,
      retainedBytes: 600_000,
      listResponseBytes: 250_000,
    });
    const first = candidate("message_1");
    const second = candidate("message_2");
    first.prompt = "a".repeat(200_000);
    second.prompt = "b".repeat(200_000);
    first.requestFingerprint = agentMessageRequestFingerprint({
      prompt: first.prompt,
      selectedObjectIds: first.context.selection.objectIds,
    });
    second.requestFingerprint = agentMessageRequestFingerprint({
      prompt: second.prompt,
      selectedObjectIds: second.context.selection.objectIds,
    });
    await store.create(scope, first);
    await store.create(scope, second);

    const listed = await store.list(scope, { limit: 10 });
    expect(listed.messages).toHaveLength(1);
    expect(listed).toMatchObject({ totalMatched: 2, truncated: true });
    expect(Buffer.byteLength(JSON.stringify(listed), "utf8")).toBeLessThan(250_000);
  });

  it("evicts only older answered history for claim growth and rolls back when no safe eviction exists", async () => {
    const probe = new MemoryAgentMessageStore();
    await probe.create(scope, candidate("message_old"));
    await answer(probe, "message_old", 1_000);
    await probe.create(scope, candidate("message_target"));
    const beforeClaim = retainedBytes(probe);
    await probe.claim({ scope, messageId: "message_target", claimId: "claim_target", leaseSeconds: 60, now: 2_000 });
    const afterClaim = retainedBytes(probe);
    expect(afterClaim).toBeGreaterThan(beforeClaim);

    const budget = beforeClaim + Math.max(1, Math.floor((afterClaim - beforeClaim) / 2));
    const store = new MemoryAgentMessageStore(undefined, { incomingBytes: budget, retainedBytes: budget });
    await store.create(scope, candidate("message_old"));
    await answer(store, "message_old", 1_000);
    await store.create(scope, candidate("message_target"));
    await expect(store.claim({ scope, messageId: "message_target", claimId: "claim_target", leaseSeconds: 60, now: 2_000 }))
      .resolves.toMatchObject({ message: { id: "message_target", state: "claimed" } });
    expect((await store.list(scope, { limit: 10 })).messages.map((message) => message.id))
      .toEqual(["message_target"]);

    const pendingProbe = new MemoryAgentMessageStore();
    await pendingProbe.create(scope, candidate("message_only"));
    const pendingBefore = retainedBytes(pendingProbe);
    await pendingProbe.claim({ scope, messageId: "message_only", claimId: "claim_only", leaseSeconds: 60, now: 2_000 });
    const pendingAfter = retainedBytes(pendingProbe);
    const pendingBudget = pendingBefore + Math.max(1, Math.floor((pendingAfter - pendingBefore) / 2));
    const blocked = new MemoryAgentMessageStore(undefined, { incomingBytes: pendingBudget, retainedBytes: pendingBudget });
    await blocked.create(scope, candidate("message_only"));
    await expect(blocked.claim({ scope, messageId: "message_only", claimId: "claim_only", leaseSeconds: 60, now: 2_000 }))
      .rejects.toMatchObject({ code: "ROOM_CAPACITY_EXCEEDED" });
    expect((await blocked.list(scope, { limit: 10 })).messages[0]).toMatchObject({
      id: "message_only",
      state: "pending",
      version: 1,
      claimedUntil: null,
    });
  });

  it("evicts only older answered history for reply growth and atomically preserves a claim on capacity failure", async () => {
    const replyText = "x".repeat(300);
    const prepare = async (store: MemoryAgentMessageStore) => {
      await store.create(scope, candidate("message_old"));
      await answer(store, "message_old", 1_000);
      await store.create(scope, candidate("message_target"));
      return store.claim({ scope, messageId: "message_target", claimId: "claim_target", leaseSeconds: 60, now: 2_000 });
    };
    const probe = new MemoryAgentMessageStore();
    const probeClaim = await prepare(probe);
    const beforeReply = retainedBytes(probe);
    await submitReply(probe, "message_target", probeClaim.claimToken, replyText, 3_000);
    const afterReply = retainedBytes(probe);
    expect(afterReply).toBeGreaterThan(beforeReply);

    const budget = beforeReply + Math.max(1, Math.floor((afterReply - beforeReply) / 2));
    const store = new MemoryAgentMessageStore(undefined, { incomingBytes: budget, retainedBytes: budget });
    const claim = await prepare(store);
    await expect(submitReply(store, "message_target", claim.claimToken, replyText, 3_000))
      .resolves.toMatchObject({ id: "message_target", state: "answered", version: 3 });
    expect((await store.list(scope, { limit: 10 })).messages.map((message) => message.id))
      .toEqual(["message_target"]);

    const blockedProbe = new MemoryAgentMessageStore();
    await blockedProbe.create(scope, candidate("message_only"));
    const blockedProbeClaim = await blockedProbe.claim({ scope, messageId: "message_only", claimId: "claim_only", leaseSeconds: 60, now: 2_000 });
    const blockedBefore = retainedBytes(blockedProbe);
    await submitReply(blockedProbe, "message_only", blockedProbeClaim.claimToken, replyText, 3_000);
    const blockedAfter = retainedBytes(blockedProbe);
    const blockedBudget = blockedBefore + Math.max(1, Math.floor((blockedAfter - blockedBefore) / 2));
    const blocked = new MemoryAgentMessageStore(
      undefined,
      { incomingBytes: blockedBudget, retainedBytes: blockedBudget },
      () => 3_000,
    );
    await blocked.create(scope, candidate("message_only"));
    const blockedClaim = await blocked.claim({ scope, messageId: "message_only", claimId: "claim_only", leaseSeconds: 60, now: 2_000 });
    await expect(submitReply(blocked, "message_only", blockedClaim.claimToken, replyText, 3_000))
      .rejects.toMatchObject({ code: "ROOM_CAPACITY_EXCEEDED" });
    expect((await blocked.list(scope, { limit: 10 })).messages[0]).toMatchObject({
      id: "message_only",
      state: "claimed",
      version: 2,
      reply: null,
    });
  });

  it("maps atomic Redis claim and reply capacity outcomes without reconstructing a mutation", async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue(["capacity"]),
    } as unknown as Redis;
    const store = new RedisAgentMessageStore(redis, { incomingBytes: 1_000, retainedBytes: 1_000 });
    await expect(store.claim({ scope, messageId: "message_1", claimId: "claim_1", leaseSeconds: 60, now: 1_000 }))
      .rejects.toMatchObject({ code: "ROOM_CAPACITY_EXCEEDED" });
    await expect(store.reply({
      scope,
      messageId: "message_1",
      claimToken: "t".repeat(43),
      replyFingerprint: "f".repeat(64),
      now: 2_000,
      reply: { id: "reply_1", text: "Done", outcome: "completed", createdAt: 2_000, author: agent },
    })).rejects.toMatchObject({ code: "ROOM_CAPACITY_EXCEEDED" });
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(redis.eval).toHaveBeenNthCalledWith(1, expect.any(String), 1, expect.any(String), "message_1", "claim_1", "60", "1000", expect.any(String), "1000", expect.any(String));
    expect(redis.eval).toHaveBeenNthCalledWith(2, expect.any(String), 1, expect.any(String), "message_1", "f".repeat(64), "t".repeat(43), "2000", expect.any(String), "1000", expect.any(String));
  });

  it("lists through a byte-bounded Redis script without transferring the whole channel", async () => {
    const memory = new MemoryAgentMessageStore();
    await memory.create(scope, candidate("message_1"));
    const stored = structuredClone([...memory.state.channels.values()][0].channel.messages[0]);
    const redis = {
      eval: vi.fn().mockResolvedValue(["listed", "2", "1", JSON.stringify(stored)]),
    } as unknown as Redis;
    const store = new RedisAgentMessageStore(redis);

    await expect(store.list(scope, { status: "pending", limit: 20 })).resolves.toMatchObject({
      messages: [{ id: "message_1", state: "pending" }],
      totalMatched: 2,
      truncated: true,
    });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("local byteLimit = tonumber(ARGV[6])"),
      1,
      agentMessageRedisKey(scope),
      "pending",
      "20",
      "",
      "oldest",
      expect.any(String),
      "1048576",
    );
    expect((redis as unknown as { get?: unknown }).get).toBeUndefined();
  });

  it("refreshes Redis TTL inside every successful idempotent replay branch", async () => {
    const memory = new MemoryAgentMessageStore();
    await memory.create(scope, candidate("message_1"));
    const created = structuredClone([...memory.state.channels.values()][0].channel.messages[0]);
    const claimed = await memory.claim({
      scope,
      messageId: "message_1",
      claimId: "claim_1",
      leaseSeconds: 60,
      now: 1_000,
    });
    const claimedStored = structuredClone([...memory.state.channels.values()][0].channel.messages[0]);
    const reply = {
      id: "reply_1",
      text: "Done",
      outcome: "completed" as const,
      createdAt: 2_000,
      author: agent,
    };
    const replyFingerprint = agentMessageReplyFingerprint({
      ...reply,
      replyId: reply.id,
      claimToken: claimed.claimToken,
    });
    await memory.reply({
      scope,
      messageId: "message_1",
      reply,
      claimToken: claimed.claimToken,
      replyFingerprint,
      now: 2_000,
    });
    const answeredStored = structuredClone([...memory.state.channels.values()][0].channel.messages[0]);
    const evalMock = vi.fn()
      .mockResolvedValueOnce(["replayed", JSON.stringify(created)])
      .mockResolvedValueOnce(["replayed", JSON.stringify(claimedStored), claimed.claimToken])
      .mockResolvedValueOnce(["replayed", JSON.stringify(answeredStored)]);
    const store = new RedisAgentMessageStore({ eval: evalMock } as unknown as Redis);

    await store.create(scope, candidate("message_1"));
    await store.claim({ scope, messageId: "message_1", claimId: "claim_1", leaseSeconds: 60, now: 1_000 });
    await store.reply({
      scope,
      messageId: "message_1",
      reply,
      claimToken: claimed.claimToken,
      replyFingerprint,
      now: 2_000,
    });

    expect(evalMock).toHaveBeenCalledTimes(3);
    expect(String(evalMock.mock.calls[0][0])).toContain('redis.call("EXPIRE", KEYS[1], tonumber(ARGV[5]))');
    expect(String(evalMock.mock.calls[1][0])).toContain('redis.call("EXPIRE", KEYS[1], tonumber(ARGV[7]))');
    expect(String(evalMock.mock.calls[2][0])).toContain('redis.call("EXPIRE", KEYS[1], tonumber(ARGV[7]))');
  });
});
