// @vitest-environment node

import type Redis from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentCanvasDraft } from "@/lib/agent-drafts/types";
import { AGENT_CANVAS_DRAFT_SCHEMA_VERSION, isAgentCanvasDraftEvent } from "@/lib/agent-drafts/types";
import { REALTIME_EVENT_STREAM } from "@/lib/realtime/protocol";

import {
  type AgentCanvasDraftStore,
  AGENT_DRAFT_HARD_TTL_MS,
  AGENT_DRAFT_SLIDING_TTL_MS,
  RedisAgentCanvasDraftStore,
  resetMemoryAgentCanvasDraftStoreForTests,
  setAgentCanvasDraftStoreForTests,
} from "./agent-draft-store";
import {
  commitAgentCanvasDraft,
  listAgentCanvasDrafts,
  stageAgentCanvasDraft,
} from "./agent-draft-service";
import { getRoomStore } from "./room-store";
import { runCanvasCommand } from "./room-service";

type FakeState = {
  hashes: Map<string, Map<string, string>>;
  expiries: Map<string, number>;
  stream: Array<{ key: string; fields: string[] }>;
};

class FakeMulti {
  private readonly operations: Array<() => unknown> = [];

  constructor(private readonly state: FakeState) {}

  hset(key: string, field: string, value: string) {
    this.operations.push(() => {
      const hash = this.state.hashes.get(key) ?? new Map<string, string>();
      hash.set(field, value);
      this.state.hashes.set(key, hash);
      return 1;
    });
    return this;
  }

  hdel(key: string, ...fields: string[]) {
    this.operations.push(() => {
      const hash = this.state.hashes.get(key);
      let removed = 0;
      for (const field of fields) if (hash?.delete(field)) removed += 1;
      return removed;
    });
    return this;
  }

  pexpire(key: string, milliseconds: number) {
    this.operations.push(() => {
      this.state.expiries.set(key, milliseconds);
      return 1;
    });
    return this;
  }

  xadd(key: string, ...fields: Array<string | number>) {
    this.operations.push(() => {
      this.state.stream.push({ key, fields: fields.map(String) });
      return `${this.state.stream.length}-0`;
    });
    return this;
  }

  async exec() {
    return this.operations.map((operation) => [null, operation()]);
  }
}

class FakeRedis {
  constructor(readonly state: FakeState = {
    hashes: new Map(),
    expiries: new Map(),
    stream: [],
  }) {}

  duplicate() { return new FakeRedis(this.state); }
  async watch() { return "OK"; }
  async unwatch() { return "OK"; }
  async quit() { return "OK"; }

  async hgetall(key: string) {
    return Object.fromEntries(this.state.hashes.get(key) ?? []);
  }

  async hget(key: string, field: string) {
    return this.state.hashes.get(key)?.get(field) ?? null;
  }

  async hdel(key: string, ...fields: string[]) {
    const hash = this.state.hashes.get(key);
    let removed = 0;
    for (const field of fields) if (hash?.delete(field)) removed += 1;
    return removed;
  }

  multi() { return new FakeMulti(this.state); }
}

const NOW = 1_900_000_000_000;

function draft(overrides: Partial<AgentCanvasDraft> = {}): AgentCanvasDraft {
  return {
    schemaVersion: AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
    id: "draft_redis",
    roomId: "room_redis",
    ownerParticipantId: "p_owner",
    author: { participantId: "p_owner", displayName: "Owner", color: "blue", kind: "agent" },
    revision: 1,
    baselineRoomRevision: 3,
    status: "active",
    transaction: {
      commands: [{
        type: "create",
        object: {
          id: "node_redis", kind: "text", x: 0, y: 0, width: 120, height: 60,
          rotation: 0, zIndex: 0, groupId: null, content: "Redis",
          color: "black", size: "m", align: "start",
        },
      }],
      diagramCommands: [],
    },
    temporaryReferences: { node: "node_redis" },
    previewObjects: [],
    previewDiagrams: [],
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + AGENT_DRAFT_SLIDING_TTL_MS,
    hardExpiresAt: NOW + AGENT_DRAFT_HARD_TTL_MS,
    awaitingReview: null,
    committing: null,
    authoritativeCommit: null,
    ...overrides,
  };
}

function streamEvent(state: FakeState) {
  const record = state.stream.at(-1);
  if (!record) throw new Error("Expected a Redis stream event.");
  const dataIndex = record.fields.lastIndexOf("data");
  return JSON.parse(record.fields[dataIndex + 1]) as unknown;
}

describe("RedisAgentCanvasDraftStore", () => {
  beforeEach(() => {
    vi.stubEnv("REDIS_URL", "");
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    resetMemoryAgentCanvasDraftStoreForTests();
  });

  afterEach(() => {
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    resetMemoryAgentCanvasDraftStoreForTests();
    vi.unstubAllEnvs();
  });

  it("stores the full private draft sidecar but streams only a compact invalidation", async () => {
    const redis = new FakeRedis();
    const store = new RedisAgentCanvasDraftStore(redis as unknown as Redis);
    await store.create(draft());

    const persisted = [...redis.state.hashes.values()][0].get("draft_redis");
    expect(persisted).toContain("transaction");
    expect(redis.state.stream.at(-1)?.key).toBe(REALTIME_EVENT_STREAM);
    const event = streamEvent(redis.state);
    expect(isAgentCanvasDraftEvent(event)).toBe(true);
    expect(event).toMatchObject({ type: "draft.upsert", revision: 1, status: "active" });
    expect(JSON.stringify(event)).not.toContain("transaction");
    expect(JSON.stringify(event)).not.toContain("previewObjects");
    await expect(store.list("room_redis", NOW + 1)).resolves.toMatchObject([{ id: "draft_redis" }]);
  });

  it("atomically renews active expiry and streams same-revision expiry evidence", async () => {
    const redis = new FakeRedis();
    const store = new RedisAgentCanvasDraftStore(redis as unknown as Redis);
    const created = await store.create(draft());
    const readAll = vi.spyOn(FakeRedis.prototype, "hgetall");
    const readOne = vi.spyOn(FakeRedis.prototype, "hget");
    const touchedAt = NOW + 4 * 60_000;
    const touched = await store.touch({
      roomId: created.roomId,
      draftId: created.id,
      ownerParticipantId: created.ownerParticipantId,
      expectedRevision: created.revision,
      now: touchedAt,
    });

    expect(touched).toMatchObject({
      revision: created.revision,
      updatedAt: created.updatedAt,
      expiresAt: touchedAt + AGENT_DRAFT_SLIDING_TTL_MS,
      hardExpiresAt: created.hardExpiresAt,
    });
    expect(streamEvent(redis.state)).toMatchObject({
      type: "draft.upsert",
      revision: created.revision,
      occurredAt: touchedAt,
      expiresAt: touchedAt + AGENT_DRAFT_SLIDING_TTL_MS,
    });
    expect(redis.state.stream).toHaveLength(2);
    expect([...redis.state.expiries.values()]).toEqual([created.hardExpiresAt - NOW]);
    expect(readAll).not.toHaveBeenCalled();
    expect(readOne).toHaveBeenCalledTimes(1);
  });

  it("keeps Redis CAS/status transitions monotonic and publishes removal", async () => {
    const redis = new FakeRedis();
    const store = new RedisAgentCanvasDraftStore(redis as unknown as Redis);
    await store.create(draft());
    const committing = await store.beginCommit({
      roomId: "room_redis",
      draftId: "draft_redis",
      ownerParticipantId: "p_owner",
      expectedRevision: 1,
      mutationId: "mutation_redis",
      now: NOW + 1,
    });
    expect(committing).toMatchObject({ status: "committing", revision: 2 });
    const marked = await store.markAuthoritativelyCommitted({
      roomId: "room_redis",
      draftId: "draft_redis",
      ownerParticipantId: "p_owner",
      mutationId: "mutation_redis",
      authoritativeRoomRevision: 8,
      now: NOW + 2,
    });
    expect(marked).toMatchObject({
      revision: 2,
      authoritativeCommit: {
        mutationId: "mutation_redis",
        roomRevision: 8,
        committedAt: NOW + 2,
      },
    });
    expect(streamEvent(redis.state)).toMatchObject({ type: "draft.upsert", revision: 2 });
    await expect(store.remove({
      roomId: "room_redis",
      draftId: "draft_redis",
      ownerParticipantId: "p_owner",
      expectedRevision: 2,
      requiredStatus: "active",
      reason: "discarded",
      now: NOW + 3,
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    await store.remove({
      roomId: "room_redis",
      draftId: "draft_redis",
      ownerParticipantId: "p_owner",
      committingMutationId: "mutation_redis",
      reason: "committed",
      authoritativeRoomRevision: 8,
      now: NOW + 4,
    });
    expect(streamEvent(redis.state)).toMatchObject({
      type: "draft.removed",
      draftId: "draft_redis",
      revision: 2,
      reason: "committed",
      authoritativeRoomRevision: 8,
    });
    await expect(store.get("room_redis", "draft_redis", NOW + 5)).resolves.toBeNull();
  });

  it("reconciles a cleanup-failed commit from a fresh Redis store after its object is deleted", async () => {
    const redis = new FakeRedis();
    const redisStore = new RedisAgentCanvasDraftStore(redis as unknown as Redis);
    let removeFailures = 1;
    const faultingStore = new Proxy(redisStore, {
      get(target, property) {
        if (property === "remove") {
          return async (...args: Parameters<AgentCanvasDraftStore["remove"]>) => {
            if (removeFailures > 0) {
              removeFailures -= 1;
              throw new Error("Injected Redis sidecar cleanup failure");
            }
            return target.remove(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentCanvasDraftStore;
    setAgentCanvasDraftStoreForTests(faultingStore);

    const roomStore = getRoomStore();
    const room = await roomStore.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Redis draft recovery",
    });
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: {
        draftId: "draft_redis",
        baselineRoomRevision: room.roomRevision,
        transaction: draft().transaction,
        temporaryReferences: { node: "node_redis" },
      },
    });
    const committed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
    });
    expect(committed).toMatchObject({ outcome: "applied", sidecarStatus: "cleanup_pending" });
    await expect(redisStore.get(room.id, staged.id)).resolves.toMatchObject({
      authoritativeCommit: { roomRevision: committed.mutation.room.roomRevision },
    });

    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: {
        type: "delete",
        targets: [{ objectId: "node_redis", expectedRevision: 1 }],
      },
    });
    expect((await roomStore.getRoom(room.id))?.objects.node_redis).toBeUndefined();

    const freshStore = new RedisAgentCanvasDraftStore(redis as unknown as Redis);
    setAgentCanvasDraftStoreForTests(freshStore);
    await expect(listAgentCanvasDrafts({ roomId: room.id, participantId: "p_owner" }))
      .resolves.toMatchObject({ drafts: [] });
    await expect(freshStore.get(room.id, staged.id)).resolves.toBeNull();
    expect(streamEvent(redis.state)).toMatchObject({
      type: "draft.removed",
      reason: "committed",
      authoritativeRoomRevision: committed.mutation.room.roomRevision,
    });
  });

  it("retains awaiting-review state through the sliding deadline and transitions idempotently", async () => {
    const redis = new FakeRedis();
    const store = new RedisAgentCanvasDraftStore(redis as unknown as Redis);
    await store.create(draft());
    await store.beginCommit({
      roomId: "room_redis",
      draftId: "draft_redis",
      ownerParticipantId: "p_owner",
      expectedRevision: 1,
      mutationId: "mutation_review",
      now: NOW + 1,
    });
    const awaiting = await store.markAwaitingReview({
      roomId: "room_redis",
      draftId: "draft_redis",
      ownerParticipantId: "p_owner",
      mutationId: "mutation_review",
      proposalId: "proposal_redis",
      now: NOW + 2,
    });
    const replay = await store.markAwaitingReview({
      roomId: "room_redis",
      draftId: "draft_redis",
      ownerParticipantId: "p_owner",
      mutationId: "mutation_review",
      proposalId: "proposal_redis",
      now: NOW + 3,
    });

    expect(awaiting).toMatchObject({
      status: "awaiting_review",
      revision: 3,
      expiresAt: NOW + AGENT_DRAFT_HARD_TTL_MS,
    });
    expect(replay.revision).toBe(3);
    await expect(store.get(
      "room_redis",
      "draft_redis",
      NOW + AGENT_DRAFT_SLIDING_TTL_MS + 1,
    )).resolves.toMatchObject({ status: "awaiting_review" });
    await expect(store.get(
      "room_redis",
      "draft_redis",
      NOW + AGENT_DRAFT_HARD_TTL_MS,
    )).resolves.toBeNull();
  });
});
