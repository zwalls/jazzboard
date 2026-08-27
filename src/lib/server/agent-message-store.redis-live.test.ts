// @vitest-environment node

import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NewStoredAgentMessage } from "./agent-message-store";
import {
  AGENT_MESSAGE_TTL_SECONDS,
  agentMessageRedisKey,
  agentMessageReplyFingerprint,
  agentMessageRequestFingerprint,
  RedisAgentMessageStore,
} from "./agent-message-store";

const redisUrl = process.env.JAZZBOARD_REDIS_TEST_URL;
const liveDescribe = redisUrl ? describe : describe.skip;
const suffix = `test_${randomUUID().replaceAll("-", "")}`;
const scope = { roomId: `room_${suffix}`, participantId: `p_${suffix}` };
const cleanupKeys = new Set([agentMessageRedisKey(scope)]);
const human = { participantId: scope.participantId, displayName: "Live Test", color: "#123456", kind: "human" as const };
const agent = { ...human, kind: "agent" as const };

function scopedRoom(label: string) {
  const next = { ...scope, roomId: `${scope.roomId}_${label}` };
  cleanupKeys.add(agentMessageRedisKey(next));
  return next;
}

function candidate(id: string, prompt = `Question ${id}`): NewStoredAgentMessage {
  const selectedObjectIds = [`object_${id}`];
  return {
    id,
    prompt,
    createdAt: 1_000,
    author: human,
    context: {
      room: { id: scope.roomId, title: "Redis live test", roomRevision: 7 },
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

liveDescribe("RedisAgentMessageStore live Lua behavior", () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(redisUrl!);
    await redis.ping();
  });

  afterAll(async () => {
    if (!redis) return;
    await redis.del(...cleanupKeys);
    await redis.quit();
  });

  it("executes list, claim, reply, and replay-TTL branches against Redis", async () => {
    const store = new RedisAgentMessageStore(redis);
    const input = candidate("message_1");
    await store.create(scope, input);
    await redis.expire(agentMessageRedisKey(scope), 2);
    await expect(store.create(scope, input)).resolves.toMatchObject({ id: input.id, state: "pending" });
    expect(await redis.ttl(agentMessageRedisKey(scope))).toBeGreaterThan(AGENT_MESSAGE_TTL_SECONDS - 5);

    await expect(store.list(scope, { status: "pending", limit: 20 })).resolves.toMatchObject({
      messages: [{ id: input.id, state: "pending" }],
      totalMatched: 1,
      truncated: false,
    });

    const claimed = await store.claim({
      scope,
      messageId: input.id,
      claimId: "claim_1",
      leaseSeconds: 60,
      now: 2_000,
    });
    await redis.expire(agentMessageRedisKey(scope), 2);
    await expect(store.claim({
      scope,
      messageId: input.id,
      claimId: "claim_1",
      leaseSeconds: 60,
      now: 3_000,
    })).resolves.toEqual(claimed);
    expect(await redis.ttl(agentMessageRedisKey(scope))).toBeGreaterThan(AGENT_MESSAGE_TTL_SECONDS - 5);

    const reply = { id: "reply_1", text: "Done", outcome: "completed" as const, createdAt: 4_000, author: agent };
    const replyFingerprint = agentMessageReplyFingerprint({
      ...reply,
      replyId: reply.id,
      claimToken: claimed.claimToken,
    });
    const answered = await store.reply({
      scope,
      messageId: input.id,
      reply,
      claimToken: claimed.claimToken,
      replyFingerprint,
      now: 4_000,
    });
    await redis.expire(agentMessageRedisKey(scope), 2);
    await expect(store.reply({
      scope,
      messageId: input.id,
      reply,
      claimToken: claimed.claimToken,
      replyFingerprint,
      now: 5_000,
    })).resolves.toEqual(answered);
    expect(await redis.ttl(agentMessageRedisKey(scope))).toBeGreaterThan(AGENT_MESSAGE_TTL_SECONDS - 5);
  });

  it("enforces the Redis list byte page and preserves an over-budget claim atomically", async () => {
    const byteScope = scopedRoom("bytes");
    const pageStore = new RedisAgentMessageStore(redis, {
      incomingBytes: 250_000,
      retainedBytes: 600_000,
      listResponseBytes: 250_000,
    });
    await pageStore.create(byteScope, candidate("large_1", "a".repeat(200_000)));
    await pageStore.create(byteScope, candidate("large_2", "b".repeat(200_000)));
    await pageStore.create(byteScope, candidate("small_3", "small"));
    await expect(pageStore.list(byteScope, { limit: 10 })).resolves.toMatchObject({
      messages: [{ id: "large_1" }],
      totalMatched: 3,
      truncated: true,
    });

    const probeScope = scopedRoom("probe");
    const probe = new RedisAgentMessageStore(redis);
    await probe.create(probeScope, candidate("claim_target"));
    const beforeClaim = await redis.strlen(agentMessageRedisKey(probeScope));
    await probe.claim({ scope: probeScope, messageId: "claim_target", claimId: "claim_probe", leaseSeconds: 60, now: 1_000 });
    const afterClaim = await redis.strlen(agentMessageRedisKey(probeScope));

    const blockedScope = scopedRoom("blocked");
    const budget = beforeClaim + Math.max(1, Math.floor((afterClaim - beforeClaim) / 2));
    const blocked = new RedisAgentMessageStore(redis, { incomingBytes: budget, retainedBytes: budget });
    await blocked.create(blockedScope, candidate("claim_target"));
    await expect(blocked.claim({
      scope: blockedScope,
      messageId: "claim_target",
      claimId: "claim_blocked",
      leaseSeconds: 60,
      now: 1_000,
    })).rejects.toMatchObject({ code: "ROOM_CAPACITY_EXCEEDED" });
    await expect(blocked.list(blockedScope, { limit: 10 })).resolves.toMatchObject({
      messages: [{ id: "claim_target", state: "pending", version: 1 }],
    });
  });
});
