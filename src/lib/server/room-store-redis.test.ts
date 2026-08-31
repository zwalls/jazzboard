// @vitest-environment node

import type Redis from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";

import { blobAssetPathname, privateAssetProxyPath } from "@/lib/assets/policy";
import { roomBlobNamespace } from "@/lib/assets/private";
import { isCurrentRoomCode } from "@/lib/domain/room-code";
import type { ImageObject, RoomActivity, RoomEvent, RoomState } from "@/lib/domain/types";

import {
  privateBlobAssetRegistrationRedisKey,
  type BlobAssetRegistration,
} from "./blob-asset-registry";
import { parseMutationReceipt, sha256 } from "./idempotency";
import { createMutationContext, runWithMutationContext } from "./mutation-context";
import { splitRoomState, type PersistedRoomPlanes } from "./room-planes";
import { RedisRoomStore, roomIdFromMutationGeneration } from "./room-store";

type FakeRedisState = {
  values: Map<string, string>;
  versions: Map<string, number>;
  writes: Array<{ key: string; value: string }>;
  deletions: string[];
  watches: string[][];
  mgets: string[][];
  ttls: Map<string, number>;
  expiresAt: Map<string, number>;
  expirations: string[];
  streamPayloads: string[];
  presenceEvalCalls: number;
  presenceEvalShaCalls: number;
  activityCommitCalls: Array<{ keys: string[]; arguments: string[] }>;
  failNextExecAfterCommit: boolean;
  afterMget: ((keys: readonly string[], values: readonly (string | null)[]) => void) | null;
};

class FakeRedisConnection {
  private watched = new Map<string, number>();

  constructor(readonly state: FakeRedisState) {}

  duplicate(): FakeRedisConnection {
    return new FakeRedisConnection(this.state);
  }

  private bump(key: string): void {
    this.state.versions.set(key, (this.state.versions.get(key) ?? 0) + 1);
  }

  private current(key: string): string | null {
    const expiresAt = this.state.expiresAt.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.state.values.delete(key);
      this.state.expiresAt.delete(key);
      this.state.ttls.delete(key);
      this.bump(key);
      return null;
    }
    return this.state.values.get(key) ?? null;
  }

  private setValue(
    key: string,
    value: string,
    options: readonly (string | number)[] = [],
  ): void {
    this.state.values.set(key, value);
    this.bump(key);
    this.state.writes.push({ key, value });
    const exIndex = options.findIndex((option) => option === "EX");
    if (exIndex >= 0) {
      this.state.expiresAt.set(
        key,
        Date.now() + Number(options[exIndex + 1]) * 1_000,
      );
    } else if (!options.includes("KEEPTTL")) {
      this.state.expiresAt.delete(key);
      this.state.ttls.delete(key);
    }
  }

  async watch(...keys: string[]): Promise<"OK"> {
    this.state.watches.push(keys);
    for (const key of keys) {
      if (!this.watched.has(key)) {
        this.watched.set(key, this.state.versions.get(key) ?? 0);
      }
    }
    return "OK";
  }

  async unwatch(): Promise<"OK"> {
    this.watched.clear();
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.current(key);
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    this.state.mgets.push(keys);
    const values = keys.map((key) => this.current(key));
    this.state.afterMget?.(keys, values);
    return values;
  }

  async ttl(key: string): Promise<number> {
    if (this.current(key) === null) return -2;
    const expiresAt = this.state.expiresAt.get(key);
    if (expiresAt !== undefined) {
      return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
    }
    return this.state.ttls.get(key) ?? -1;
  }

  async eval(
    _script: string,
    numberOfKeys: number,
    ...parameters: (string | number)[]
  ): Promise<unknown> {
    if (numberOfKeys === 3) {
      this.state.presenceEvalCalls += 1;
      return this.evalPresence(parameters);
    }
    if (numberOfKeys >= 12) {
      const keys = parameters.slice(0, numberOfKeys).map(String);
      const args = parameters.slice(numberOfKeys).map(String);
      this.state.activityCommitCalls.push({ keys, arguments: args });
      if (args[23] === "1") this.setValue(keys[7], args[24]);
      if (args[25] === "1") this.setValue(keys[8], args[26]);
      if (args[27] === "1") this.setValue(keys[9], args[28]);
      this.state.streamPayloads.push(args[30]);
      if (args[31] === "1") {
        this.setValue(keys[11], args[32], ["EX", Number(args[33])]);
      }
      return ["commit_stored", "0", "0", "0"];
    }
    if (numberOfKeys !== 5 && numberOfKeys !== 6) {
      throw new Error("Expected five or six room-creation keys.");
    }
    const keys = parameters.slice(0, numberOfKeys).map(String);
    const args = parameters.slice(numberOfKeys).map(String);
    const [codeKey, documentKey, awarenessKey, coordinationKey] = keys;
    const receiptKey = numberOfKeys === 6 ? keys[5] : null;
    if (receiptKey) {
      const existingReceipt = this.current(receiptKey);
      if (existingReceipt) return ["replay", existingReceipt];
    }
    if (this.current(codeKey)) return ["code_conflict"];
    if (
      this.current(documentKey) ||
      this.current(awarenessKey) ||
      this.current(coordinationKey)
    ) {
      return ["orphan"];
    }
    this.setValue(codeKey, args[0]);
    this.setValue(documentKey, args[1]);
    this.setValue(awarenessKey, args[2]);
    this.setValue(coordinationKey, args[3]);
    this.state.streamPayloads.push(args[4]);
    if (receiptKey) this.setValue(receiptKey, args[5], ["EX", Number(args[6])]);
    return ["created", receiptKey ? args[5] : ""];
  }

  async evalsha(
    _sha: string,
    numberOfKeys: number,
    ...parameters: (string | number)[]
  ): Promise<unknown> {
    if (numberOfKeys !== 3) throw new Error("Expected three presence keys.");
    this.state.presenceEvalShaCalls += 1;
    return this.evalPresence(parameters);
  }

  private evalPresence(parameters: (string | number)[]): unknown {
    const [awarenessKey, coordinationKey] = parameters.slice(0, 3).map(String);
    const args = parameters.slice(3).map(String);
    const encodedAwareness = this.current(awarenessKey);
    const encodedCoordination = this.current(coordinationKey);
    if (!encodedAwareness && !encodedCoordination) return ["not_found"];
    if (!encodedAwareness || !encodedCoordination) {
      return ["repair_required", "missing_live_plane"];
    }
    const awareness = JSON.parse(encodedAwareness) as PersistedRoomPlanes["awareness"];
    const coordination = JSON.parse(encodedCoordination) as PersistedRoomPlanes["coordination"];
    const participant = awareness.participants[args[1]];
    if (!participant?.member) return ["repair_required", "missing_member_mirror"];
    if (args[2] === "agent" && participant.member.role !== "participant") {
      return ["forbidden", "spectator_agent_presence"];
    }
    const now = Number(args[3]);
    const presence = JSON.parse(args[4]) as {
      cursor: { x: number; y: number } | null;
      viewport: RoomState["participants"][string]["human"]["viewport"];
      activity: RoomState["participants"][string]["human"]["activity"];
    };
    const actorKind = args[2] as "human" | "agent";
    participant[actorKind] = { ...presence, lastSeenAt: now };
    participant.lastSeenAt = now;
    participant.connected = true;
    if (actorKind === "agent") participant.agentActive = true;
    coordination.stateRevision = Math.max(
      coordination.stateRevision,
      coordination.roomRevision ?? 0,
    ) + 1;
    const event: RoomEvent = {
      id: args[10],
      roomId: args[0],
      sequence: coordination.stateRevision,
      occurredAt: now,
      type: actorKind === "agent" ? "agent.activity" : "presence.updated",
      actor: {
        participantId: participant.member.participantId,
        displayName: participant.member.displayName,
        color: participant.member.color,
        kind: actorKind,
      },
      payload: {
        schemaVersion: 4,
        kind: "presence.delta",
        stateRevision: coordination.stateRevision,
        roomRevision: coordination.roomRevision ?? 0,
        participantId: args[1],
        actorKind,
        lastSeenAt: now,
        connected: true,
        agentActive: participant.agentActive,
        presence: participant[actorKind],
      },
    };
    const nextAwareness = JSON.stringify(awareness);
    this.setValue(awarenessKey, nextAwareness);
    this.setValue(coordinationKey, JSON.stringify(coordination));
    this.state.streamPayloads.push(JSON.stringify(event));
    return [
      "ok",
      JSON.stringify(event),
      "",
      Buffer.byteLength(nextAwareness),
      "ok",
      coordination.roomRevision ?? 0,
    ];
  }

  multi() {
    const operations: Array<() => void> = [];
    const chain = {
      set: (key: string, value: string, ...options: (string | number)[]) => {
        operations.push(() => this.setValue(key, value, options));
        return chain;
      },
      del: (key: string) => {
        operations.push(() => {
          this.state.values.delete(key);
          this.state.expiresAt.delete(key);
          this.state.ttls.delete(key);
          this.bump(key);
          this.state.deletions.push(key);
        });
        return chain;
      },
      xadd: (...args: unknown[]) => {
        operations.push(() => {
          this.state.streamPayloads.push(String(args.at(-1)));
        });
        return chain;
      },
      lpush: () => {
        operations.push(() => undefined);
        return chain;
      },
      ltrim: () => {
        operations.push(() => undefined);
        return chain;
      },
      expire: (key: string, ttlSeconds: number) => {
        operations.push(() => {
          this.bump(key);
          this.state.ttls.set(key, ttlSeconds);
          this.state.expiresAt.set(key, Date.now() + ttlSeconds * 1_000);
          this.state.expirations.push(key);
        });
        return chain;
      },
      exec: async () => {
        const conflicted = [...this.watched].some(
          ([key, version]) => (this.state.versions.get(key) ?? 0) !== version,
        );
        this.watched.clear();
        if (conflicted) return null;
        for (const operation of operations) operation();
        if (this.state.failNextExecAfterCommit) {
          this.state.failNextExecAfterCommit = false;
          throw new Error("ambiguous transaction response");
        }
        return operations.map(() => [null, "OK"]);
      },
    };
    return chain;
  }

  async quit(): Promise<"OK"> {
    return "OK";
  }
}

function fakeRedis(initial: Iterable<readonly [string, string]> = []) {
  const state: FakeRedisState = {
    values: new Map(initial),
    versions: new Map(),
    writes: [],
    deletions: [],
    watches: [],
    mgets: [],
    ttls: new Map(),
    expiresAt: new Map(),
    expirations: [],
    streamPayloads: [],
    presenceEvalCalls: 0,
    presenceEvalShaCalls: 0,
    activityCommitCalls: [],
    failNextExecAfterCommit: false,
    afterMget: null,
  };
  return { connection: new FakeRedisConnection(state), state };
}

const PRIVATE_IMAGE_UUID = "550e8400-e29b-41d4-a716-446655440000";

function privateBlobPathname(roomId: string): string {
  return blobAssetPathname(
    roomBlobNamespace(roomId),
    `${PRIVATE_IMAGE_UUID}-room-store.png`,
  );
}

function privateBlobRegistration(
  roomId: string,
  pathname: string,
  status: "committed" | "cleanup-claimed" = "committed",
): BlobAssetRegistration {
  return {
    version: 1,
    pathname,
    pathnameHash: sha256(`jazzboard:blob-asset-path:v1\0${pathname}`),
    roomId,
    roomHash: sha256(`jazzboard:blob-asset-room:v1\0${roomId}`),
    participantHash: sha256("jazzboard:blob-asset-participant:v1\0p_owner"),
    status,
    reservationBytes: 10 * 1024 * 1024,
    size: 128,
    contentType: "image/png",
    etag: '"private-image-etag"',
    createdAt: 1,
    finalizedAt: 2,
    cleanupClaimId: status === "cleanup-claimed" ? "cleanup-claim-test" : null,
    cleanupClaimedAt: status === "cleanup-claimed" ? 3 : null,
  };
}

function privateImage(room: RoomState, pathname: string): ImageObject {
  const now = Date.now();
  const owner = room.participants.p_owner;
  const actor = {
    participantId: owner.participantId,
    displayName: owner.displayName,
    color: owner.color,
    kind: "human" as const,
  };
  return {
    id: "image_private",
    kind: "image",
    x: 10,
    y: 20,
    width: 320,
    height: 180,
    rotation: 0,
    zIndex: 0,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    lastEditedBy: actor,
    url: privateAssetProxyPath(room.id, pathname),
    assetId: null,
    alt: "Private room image",
    mimeType: "image/png",
    sourceUrl: null,
    locked: false,
  };
}

function writeFakeValue(state: FakeRedisState, key: string, value: string): void {
  state.values.set(key, value);
  state.versions.set(key, (state.versions.get(key) ?? 0) + 1);
}

function privateImageActivity(room: RoomState, image: ImageObject): RoomActivity {
  return {
    id: "activity_private_image",
    roomId: room.id,
    roomRevision: room.roomRevision + 1,
    occurredAt: Date.now(),
    actor: image.createdBy,
    action: "canvas.create",
    label: "Added a private image",
    intent: null,
    summary: null,
    affectedObjectIds: [image.id],
    affectedDiagramIds: [],
    affectedBounds: {
      x: image.x,
      y: image.y,
      width: image.width,
      height: image.height,
    },
    objectChanges: [{ objectId: image.id, mode: "direct", before: null, after: image }],
    diagramChanges: [],
    objectGuards: { [image.id]: { state: "absent" } },
    diagramGuards: {},
    revertsActivityId: null,
  };
}

function presenceRoom(): RoomState {
  const now = Date.now();
  return {
    id: "room_presence",
    code: "2468",
    title: "Presence room",
    stateRevision: 7,
    roomRevision: 3,
    createdAt: 1,
    updatedAt: 3,
    participants: {
      p_owner: {
        participantId: "p_owner",
        displayName: "Owner",
        color: "blue",
        role: "participant",
        joinedAt: now,
        lastSeenAt: now,
        connected: true,
        agentActive: false,
        human: { cursor: null, viewport: null, lastSeenAt: now, activity: null },
        agent: { cursor: null, viewport: null, lastSeenAt: now, activity: null },
      },
    },
    objects: {},
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function preRetirementPlanes(room: RoomState): PersistedRoomPlanes {
  const planes = splitRoomState(room);
  delete planes.coordination.legacyRetired;
  return planes;
}

function roomCreateContext(key: string, title = "Atomic room") {
  return createMutationContext({
    request: new Request("https://jazzboard.test/api/rooms", {
      method: "POST",
      headers: { "idempotency-key": key },
    }),
    participantId: "p_owner",
    operation: "room.create",
    actorKind: "human",
    parsedBody: { action: "create", title, displayName: "Owner" },
  });
}

function codeKeys(state: FakeRedisState): string[] {
  return [...state.values.keys()].filter((key) => key.startsWith("jazzboard:code:"));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RedisRoomStore v3 persistence", () => {
  it("models Redis WATCH as cumulative across successive calls", async () => {
    const { connection, state } = fakeRedis([
      ["watch:first", "v1"],
      ["watch:second", "v1"],
    ]);
    const transaction = connection.duplicate();
    await transaction.watch("watch:first");
    await transaction.watch("watch:second");
    writeFakeValue(state, "watch:first", "v2");

    await expect(transaction.multi().set("write", "blocked").exec()).resolves.toBeNull();
    expect(state.values.has("write")).toBe(false);
  });

  it("creates only the code, three planes, and compact invalidation atomically", async () => {
    const redis = { eval: vi.fn(async () => ["created"]) } as unknown as Redis;
    const room = await new RedisRoomStore(redis).createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Atomic room",
    });

    expect(isCurrentRoomCode(room.code)).toBe(true);
    const args = vi.mocked(redis.eval).mock.calls[0];
    expect(args[1]).toBe(5);
    expect(args.slice(2, 7)).toEqual([
      `jazzboard:code:${room.code}`,
      `jazzboard:room:v3:document:${room.id}`,
      `jazzboard:room:v3:awareness:${room.id}`,
      `jazzboard:room:v3:coordination:${room.id}`,
      "jazzboard:events",
    ]);
    expect(args.map(String).some((value) => value === `jazzboard:room:${room.id}`)).toBe(false);
    expect(JSON.parse(String(args[8]))).toMatchObject({
      id: room.id,
      code: room.code,
      roomRevision: 1,
    });
    expect(JSON.parse(String(args[9]))).toMatchObject({
      participants: { p_owner: { connected: true } },
      spotlight: null,
    });
    expect(JSON.parse(String(args[10]))).toMatchObject({
      stateRevision: 1,
      roomRevision: 1,
      legacyRetired: true,
      leases: {},
    });
    const event = JSON.parse(String(args[11])) as RoomEvent;
    expect(event).toMatchObject({
      roomId: room.id,
      sequence: 1,
      payload: { schemaVersion: 3, kind: "room.invalidated" },
    });
    expect(event.payload).not.toHaveProperty("room");
  });

  it("commits a receipt-derived creation generation in the same Lua operation", async () => {
    const redis = {
      get: vi.fn(async () => null),
      eval: vi.fn(async () => ["created"]),
    } as unknown as Redis;
    const context = roomCreateContext("create-room-0001");
    const room = await runWithMutationContext(context, () =>
      new RedisRoomStore(redis).createRoom({
        participantId: "p_owner",
        displayName: "Owner",
        title: "Atomic room",
      }),
    );

    const args = vi.mocked(redis.eval).mock.calls[0];
    expect(args[1]).toBe(6);
    expect(args[7]).toBe(context.idempotency?.receiptKey);
    const receipt = parseMutationReceipt(String(args[13]));
    expect(receipt).toMatchObject({
      namespace: "room.create",
      requestDigest: context.idempotency?.requestDigest,
      outcome: "room_created",
      committedAt: room.createdAt,
      committedRoomRevision: 1,
    });
    expect(room.id).toBe(
      roomIdFromMutationGeneration(
        context.idempotency!.scopedKeyHash,
        receipt!.committedAt,
      ),
    );
    expect(JSON.stringify(receipt)).not.toContain(room.code);
    expect(args[14]).toBe(86_400);
  });

  it("returns an explicit unknown outcome when post-write receipt verification is unavailable", async () => {
    const redis = {
      get: vi.fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("verification transport unavailable")),
      eval: vi.fn(async () => {
        throw new Error("ambiguous write transport failure");
      }),
    } as unknown as Redis;
    const context = roomCreateContext("create-room-verify-0001");

    await expect(runWithMutationContext(context, () =>
      new RedisRoomStore(redis).createRoom({
        participantId: "p_owner",
        displayName: "Owner",
        title: "Atomic room",
      }),
    )).rejects.toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
      details: { replayed: false, verificationUnavailable: true },
    });
  });

  it("returns an explicit unknown outcome when room-create preflight verification is unavailable", async () => {
    const redis = {
      get: vi.fn().mockRejectedValue(new Error("verification transport unavailable")),
      eval: vi.fn(),
    } as unknown as Redis;
    const context = roomCreateContext("create-room-preflight-verify-0001");

    await expect(runWithMutationContext(context, () =>
      new RedisRoomStore(redis).createRoom({
        participantId: "p_owner",
        displayName: "Owner",
        title: "Atomic room",
      }),
    )).rejects.toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
      details: { replayed: false, verificationUnavailable: true },
    });
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("recovers a receipt-only no-op commit after an ambiguous transaction response", async () => {
    const { connection, state } = fakeRedis();
    const store = new RedisRoomStore(connection as unknown as Redis);
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "No-op receipt",
    });
    const context = createMutationContext({
      request: new Request(`https://jazzboard.test/api/rooms/${room.id}/policy`, {
        method: "POST",
        headers: { "idempotency-key": "noop-receipt-0001" },
      }),
      participantId: "p_owner",
      roomId: room.id,
      operation: "room.agent_policy.set",
      actorKind: "human",
      parsedBody: { policy: "live" },
    });
    state.failNextExecAfterCommit = true;

    await expect(runWithMutationContext(context, () =>
      store.transact(room.id, (current) => ({
        room: current,
        result: { room: current, changed: false },
      })),
    )).rejects.toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
      details: {
        replayed: true,
        committedRoomRevision: room.roomRevision,
      },
    });
    expect(state.values.get(context.idempotency!.receiptKey)).toBeTruthy();
  });

  it("converges concurrent first creates on the receipt-winning generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const { connection, state } = fakeRedis();
    const store = new RedisRoomStore(connection as unknown as Redis);
    const firstContext = roomCreateContext("concurrent-room-0001");
    const secondContext = roomCreateContext("concurrent-room-0001");

    const firstPromise = runWithMutationContext(firstContext, () =>
      store.createRoom({ participantId: "p_owner", displayName: "Owner", title: "Atomic room" }),
    );
    vi.advanceTimersByTime(1);
    const secondPromise = runWithMutationContext(secondContext, () =>
      store.createRoom({ participantId: "p_owner", displayName: "Owner", title: "Atomic room" }),
    );
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(second).toEqual(first);
    expect(codeKeys(state)).toHaveLength(1);
    expect(state.values.has(`jazzboard:room:v3:document:${first.id}`)).toBe(true);
    expect([...state.values.keys()].some((key) => key.startsWith("jazzboard:room:") && !key.startsWith("jazzboard:room:v3:"))).toBe(false);
  });

  it("creates a new room generation after 24 hours without overwriting the first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const { connection, state } = fakeRedis();
    const store = new RedisRoomStore(connection as unknown as Redis);
    const create = () => runWithMutationContext(roomCreateContext("room-window-0001"), () =>
      store.createRoom({ participantId: "p_owner", displayName: "Owner", title: "Atomic room" }),
    );

    const first = await create();
    const replay = await create();
    expect(replay).toEqual(first);
    expect(codeKeys(state)).toHaveLength(1);

    vi.advanceTimersByTime(24 * 60 * 60 * 1_000 + 1);
    const second = await create();
    expect(second.id).not.toBe(first.id);
    expect(second.code).not.toBe(first.code);
    expect(codeKeys(state)).toHaveLength(2);
    expect(JSON.parse(state.values.get(`jazzboard:room:v3:document:${first.id}`)!)).toMatchObject({
      id: first.id,
      code: first.code,
    });
    expect(JSON.parse(state.values.get(`jazzboard:room:v3:document:${second.id}`)!)).toMatchObject({
      id: second.id,
      code: second.code,
    });
  });

  it("imports and deletes a legacy-only room once, then never reads legacy again", async () => {
    const source = presenceRoom();
    const legacyKey = `jazzboard:room:${source.id}`;
    const { connection, state } = fakeRedis([[legacyKey, JSON.stringify(source)]]);
    const store = new RedisRoomStore(connection as unknown as Redis);

    const migrated = await store.getRoom(source.id);
    expect(migrated).toMatchObject({ id: source.id, roomRevision: 3, stateRevision: 7 });
    expect(state.values.has(legacyKey)).toBe(false);
    expect(state.deletions).toEqual([legacyKey]);
    expect(state.watches.some((keys) => keys.includes(legacyKey))).toBe(true);
    expect(JSON.parse(state.values.get(`jazzboard:room:v3:coordination:${source.id}`)!))
      .toMatchObject({ legacyRetired: true });

    state.mgets.length = 0;
    state.watches.length = 0;
    state.deletions.length = 0;
    await store.getRoom(source.id);
    expect(state.mgets.flat()).not.toContain(legacyKey);
    expect(state.watches.flat()).not.toContain(legacyKey);
    expect(state.deletions).toEqual([]);
  });

  it("DEL-fences a legacy transaction that began before cutover", async () => {
    const source = presenceRoom();
    const legacyKey = `jazzboard:room:${source.id}`;
    const { connection } = fakeRedis([[legacyKey, JSON.stringify(source)]]);
    const oldDeployment = connection.duplicate();
    await oldDeployment.watch(legacyKey);
    const stale = (await oldDeployment.get(legacyKey))!;

    await new RedisRoomStore(connection as unknown as Redis).getRoom(source.id);
    const committed = await oldDeployment.multi().set(legacyKey, stale).exec();
    expect(committed).toBeNull();
    await expect(connection.get(legacyKey)).resolves.toBeNull();
  });

  it("imports newer old-writer document, presence, Spotlight, and active leases conservatively", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const now = Date.now();
    const current = presenceRoom();
    current.stateRevision = 50;
    current.roomRevision = 4;
    current.participants.p_owner.agentActive = true;
    current.participants.p_owner.human = {
      cursor: { x: 10, y: 20 }, viewport: null, lastSeenAt: now, activity: null,
    };
    current.participants.p_owner.agent = {
      cursor: { x: 30, y: 40 }, viewport: null, lastSeenAt: now - 100, activity: null,
    };
    current.leases.object_1 = {
      leaseId: "lease_v3",
      objectId: "object_1",
      actor: { participantId: "p_owner", displayName: "Owner", color: "blue", kind: "human" },
      operation: "edit",
      objectRevision: 1,
      acquiredAt: now,
      expiresAt: now + 60_000,
    };
    const planes = preRetirementPlanes(current);

    const legacy = structuredClone(current);
    delete (legacy as { stateRevision?: number }).stateRevision;
    legacy.roomRevision = 10;
    legacy.title = "Committed by old deployment";
    legacy.participants.p_owner.human = {
      cursor: { x: 900, y: 900 }, viewport: null, lastSeenAt: now - 50, activity: null,
    };
    legacy.participants.p_owner.agent = {
      cursor: { x: 800, y: 800 }, viewport: null, lastSeenAt: now + 1, activity: null,
    };
    legacy.participants.p_peer = {
      participantId: "p_peer",
      displayName: "Peer",
      color: "green",
      role: "participant",
      joinedAt: now,
      lastSeenAt: now,
      connected: true,
      agentActive: false,
      human: { cursor: { x: 5, y: 6 }, viewport: null, lastSeenAt: now, activity: null },
      agent: { cursor: null, viewport: null, lastSeenAt: now, activity: null },
    };
    legacy.spotlight = {
      presenterId: "p_owner",
      target: "human",
      startedAt: now,
      autoFollowAt: now + 5_000,
      followingParticipantIds: ["p_peer"],
      handoffRequest: null,
    };
    legacy.leases.object_1 = { ...legacy.leases.object_1, leaseId: "lease_old_conflict" };
    legacy.leases.object_2 = {
      leaseId: "lease_old_only",
      objectId: "object_2",
      actor: { participantId: "p_peer", displayName: "Peer", color: "green", kind: "human" },
      operation: "move",
      objectRevision: 2,
      acquiredAt: now,
      expiresAt: now + 60_000,
    };

    const legacyKey = `jazzboard:room:${current.id}`;
    const { connection, state } = fakeRedis([
      [legacyKey, JSON.stringify(legacy)],
      [`jazzboard:room:v3:document:${current.id}`, JSON.stringify(planes.document)],
      [`jazzboard:room:v3:awareness:${current.id}`, JSON.stringify(planes.awareness)],
      [`jazzboard:room:v3:coordination:${current.id}`, JSON.stringify(planes.coordination)],
    ]);

    const retired = await new RedisRoomStore(connection as unknown as Redis).getRoom(current.id);
    expect(retired).toMatchObject({
      title: "Committed by old deployment",
      roomRevision: 5,
      stateRevision: 51,
      participants: {
        p_owner: {
          agentActive: true,
          human: { cursor: { x: 10, y: 20 } },
          agent: { cursor: { x: 800, y: 800 } },
        },
        p_peer: { human: { cursor: { x: 5, y: 6 } } },
      },
      spotlight: { presenterId: "p_owner", followingParticipantIds: ["p_peer"] },
      leases: {
        object_1: { leaseId: "lease_v3" },
        object_2: { leaseId: "lease_old_only" },
      },
    });
    expect(state.values.has(legacyKey)).toBe(false);
    expect(state.streamPayloads).toHaveLength(1);
    expect(JSON.parse(state.streamPayloads[0])).toMatchObject({
      sequence: 51,
      payload: { schemaVersion: 3, kind: "room.invalidated", stateRevision: 51 },
    });
  });

  it("deletes a positive-TTL stale mirror without importing it or emitting an event", async () => {
    const current = presenceRoom();
    const planes = preRetirementPlanes(current);
    const stale = structuredClone(current);
    stale.title = "Stale mirror title";
    stale.participants.p_owner.human.cursor = { x: 999, y: 999 };
    const legacyKey = `jazzboard:room:${current.id}`;
    const { connection, state } = fakeRedis([
      [legacyKey, JSON.stringify(stale)],
      [`jazzboard:room:v3:document:${current.id}`, JSON.stringify(planes.document)],
      [`jazzboard:room:v3:awareness:${current.id}`, JSON.stringify(planes.awareness)],
      [`jazzboard:room:v3:coordination:${current.id}`, JSON.stringify(planes.coordination)],
    ]);
    state.ttls.set(legacyKey, 60);

    const retired = await new RedisRoomStore(connection as unknown as Redis).getRoom(current.id);
    expect(retired).toMatchObject({
      title: current.title,
      stateRevision: current.stateRevision,
      participants: { p_owner: { human: { cursor: null } } },
    });
    expect(state.values.has(legacyKey)).toBe(false);
    expect(state.streamPayloads).toHaveLength(0);
    expect(JSON.parse(state.values.get(`jazzboard:room:v3:coordination:${current.id}`)!))
      .toMatchObject({ legacyRetired: true, stateRevision: current.stateRevision });
  });

  it("never touches a legacy key during new-room presence or generic transactions", async () => {
    const { connection, state } = fakeRedis();
    const store = new RedisRoomStore(connection as unknown as Redis);
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "No legacy",
    });
    const legacyKey = `jazzboard:room:${room.id}`;
    state.mgets.length = 0;
    state.watches.length = 0;
    state.writes.length = 0;
    state.deletions.length = 0;
    state.expirations.length = 0;

    await store.updatePresence({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      cursor: { x: 7, y: 8 },
      viewport: null,
      activity: null,
    });
    await store.transact(room.id, (current) => {
      current.title = "Still no legacy";
      return { room: current, result: true };
    });

    expect(state.values.has(legacyKey)).toBe(false);
    expect(state.mgets.flat()).not.toContain(legacyKey);
    expect(state.watches.flat()).not.toContain(legacyKey);
    expect(state.writes.map(({ key }) => key)).not.toContain(legacyKey);
    expect(state.deletions).toEqual([]);
    expect(state.expirations).toEqual([]);
  });

  it("lets a document transaction outlive sustained awareness contention", async () => {
    const { connection, state } = fakeRedis();
    const store = new RedisRoomStore(connection as unknown as Redis);
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Contention baseline",
    });
    const documentKey = `jazzboard:room:v3:document:${room.id}`;
    const awarenessKey = `jazzboard:room:v3:awareness:${room.id}`;
    let conflicts = 0;
    state.afterMget = (keys) => {
      if (!keys.includes(documentKey) || !keys.includes(awarenessKey) || conflicts >= 8) return;
      conflicts += 1;
      writeFakeValue(state, awarenessKey, state.values.get(awarenessKey)!);
    };

    const updated = await store.transact(room.id, (current) => {
      current.title = "Contention survived";
      return { room: current, result: current.title };
    });

    expect(conflicts).toBe(8);
    expect(updated).toBe("Contention survived");
    expect((await store.getRoom(room.id))?.title).toBe("Contention survived");
  });

  it("atomically accepts a newly introduced committed private Blob reference", async () => {
    const { connection, state } = fakeRedis();
    const store = new RedisRoomStore(connection as unknown as Redis);
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Committed private image",
    });
    const pathname = privateBlobPathname(room.id);
    const registrationKey = privateBlobAssetRegistrationRedisKey(pathname);
    writeFakeValue(
      state,
      registrationKey,
      JSON.stringify(privateBlobRegistration(room.id, pathname)),
    );

    const result = await store.transact(room.id, (current) => {
      current.objects.image_private = privateImage(current, pathname);
      return { room: current, result: current.objects.image_private };
    });

    expect(result).toMatchObject({
      id: "image_private",
      kind: "image",
      url: privateAssetProxyPath(room.id, pathname),
    });
    expect((await store.getRoom(room.id))?.objects.image_private).toMatchObject({
      id: "image_private",
      kind: "image",
    });
    expect(state.watches.some((keys) => keys.includes(registrationKey))).toBe(true);
    expect(state.mgets.some((keys) => keys.includes(registrationKey))).toBe(true);
  });

  it("carries a new private Blob registration guard into an activity-bearing commit", async () => {
    const { connection, state } = fakeRedis();
    const store = new RedisRoomStore(connection as unknown as Redis);
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Activity private image",
    });
    const pathname = privateBlobPathname(room.id);
    const registrationKey = privateBlobAssetRegistrationRedisKey(pathname);
    const encodedRegistration = JSON.stringify(privateBlobRegistration(room.id, pathname));
    writeFakeValue(state, registrationKey, encodedRegistration);

    await store.transact(room.id, (current) => {
      const image = privateImage(current, pathname);
      current.objects.image_private = image;
      return {
        room: current,
        result: true,
        eventActor: image.createdBy,
        activity: privateImageActivity(current, image),
      };
    });

    expect(state.activityCommitCalls).toHaveLength(1);
    const commit = state.activityCommitCalls[0];
    expect(commit.keys.slice(12)).toEqual([registrationKey]);
    expect(commit.arguments[34]).toBe("1");
    expect(commit.arguments.slice(35)).toEqual(["1", encodedRegistration]);
    expect((await store.getRoom(room.id))?.objects.image_private).toMatchObject({
      id: "image_private",
      kind: "image",
    });
  });

  it("rejects a newly introduced private Blob while its cleanup claim is active", async () => {
    const { connection, state } = fakeRedis();
    const store = new RedisRoomStore(connection as unknown as Redis);
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Claimed private image",
    });
    const pathname = privateBlobPathname(room.id);
    writeFakeValue(
      state,
      privateBlobAssetRegistrationRedisKey(pathname),
      JSON.stringify(privateBlobRegistration(room.id, pathname, "cleanup-claimed")),
    );
    state.writes.length = 0;

    await expect(
      store.transact(room.id, (current) => {
        current.objects.image_private = privateImage(current, pathname);
        return { room: current, result: true };
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPERATION" });

    expect((await store.getRoom(room.id))?.objects).not.toHaveProperty("image_private");
    expect(state.writes).toEqual([]);
  });

  it("keeps an existing private image editable during a cleanup claim", async () => {
    const { connection, state } = fakeRedis();
    const store = new RedisRoomStore(connection as unknown as Redis);
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Existing private image",
    });
    const pathname = privateBlobPathname(room.id);
    const registrationKey = privateBlobAssetRegistrationRedisKey(pathname);
    writeFakeValue(
      state,
      registrationKey,
      JSON.stringify(privateBlobRegistration(room.id, pathname)),
    );
    await store.transact(room.id, (current) => {
      current.objects.image_private = privateImage(current, pathname);
      return { room: current, result: true };
    });

    writeFakeValue(
      state,
      registrationKey,
      JSON.stringify(privateBlobRegistration(room.id, pathname, "cleanup-claimed")),
    );
    state.watches.length = 0;
    state.mgets.length = 0;
    const moved = await store.transact(room.id, (current) => {
      const image = current.objects.image_private;
      if (image?.kind !== "image") throw new Error("Expected private image fixture.");
      current.objects.image_private = {
        ...image,
        x: 240,
        revision: image.revision + 1,
        updatedAt: Date.now(),
      };
      return { room: current, result: current.objects.image_private };
    });

    expect(moved).toMatchObject({ id: "image_private", x: 240 });
    expect((await store.getRoom(room.id))?.objects.image_private).toMatchObject({ x: 240 });
    expect(state.watches.flat()).not.toContain(registrationKey);
    expect(state.mgets.flat()).not.toContain(registrationKey);
  });

  it("retries and rejects when cleanup claims a registration after reference preflight", async () => {
    const { connection, state } = fakeRedis();
    const store = new RedisRoomStore(connection as unknown as Redis);
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Private image claim race",
    });
    const pathname = privateBlobPathname(room.id);
    const registrationKey = privateBlobAssetRegistrationRedisKey(pathname);
    writeFakeValue(
      state,
      registrationKey,
      JSON.stringify(privateBlobRegistration(room.id, pathname)),
    );
    const documentKey = `jazzboard:room:v3:document:${room.id}`;
    const beforeDocument = state.values.get(documentKey);
    state.writes.length = 0;
    let flipped = false;
    state.afterMget = (keys) => {
      if (flipped || !keys.includes(registrationKey)) return;
      flipped = true;
      writeFakeValue(
        state,
        registrationKey,
        JSON.stringify(privateBlobRegistration(room.id, pathname, "cleanup-claimed")),
      );
    };

    await expect(
      store.transact(room.id, (current) => {
        current.objects.image_private = privateImage(current, pathname);
        return { room: current, result: true };
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPERATION" });

    expect(flipped).toBe(true);
    expect(state.values.get(documentKey)).toBe(beforeDocument);
    expect(state.writes.filter(({ key }) => key === documentKey)).toEqual([]);
    expect((await store.getRoom(room.id))?.objects).not.toHaveProperty("image_private");
  });

  it("commits steady presence with one cached atomic script and no document read or WATCH", async () => {
    const { connection, state } = fakeRedis();
    const store = new RedisRoomStore(connection as unknown as Redis);
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Atomic presence",
    });
    state.mgets.length = 0;
    state.watches.length = 0;
    state.streamPayloads.length = 0;

    const first = await store.updatePresence({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      cursor: { x: 10, y: 20 },
      viewport: null,
      activity: null,
    });
    const second = await store.updatePresence({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      cursor: { x: 30, y: 40 },
      viewport: null,
      activity: null,
    });

    expect(first.stateRevision).toBe(room.stateRevision! + 1);
    expect(second.stateRevision).toBe(first.stateRevision + 1);
    expect(state.presenceEvalCalls).toBe(1);
    expect(state.presenceEvalShaCalls).toBe(1);
    expect(state.mgets).toEqual([]);
    expect(state.watches).toEqual([]);
    expect(state.streamPayloads).toHaveLength(2);
    expect(state.streamPayloads.map((encoded) => JSON.parse(encoded))).toMatchObject([
      { sequence: first.stateRevision, payload: { schemaVersion: 4, kind: "presence.delta" } },
      { sequence: second.stateRevision, payload: { schemaVersion: 4, kind: "presence.delta" } },
    ]);
  });

  it("repairs a missing member authorization mirror once, then returns to the hot path", async () => {
    const { connection, state } = fakeRedis();
    const store = new RedisRoomStore(connection as unknown as Redis);
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Repair presence",
    });
    const awarenessKey = `jazzboard:room:v3:awareness:${room.id}`;
    const awareness = JSON.parse(state.values.get(awarenessKey)!) as PersistedRoomPlanes["awareness"];
    delete awareness.participants.p_owner.member;
    state.values.set(awarenessKey, JSON.stringify(awareness));
    state.mgets.length = 0;

    const delta = await store.updatePresence({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      cursor: { x: 1, y: 2 },
      viewport: null,
      activity: null,
    });

    expect(delta.participantId).toBe("p_owner");
    expect(JSON.parse(state.values.get(awarenessKey)!)).toMatchObject({
      participants: { p_owner: { member: { participantId: "p_owner", role: "participant" } } },
    });
    expect(state.mgets.flat()).toContain(`jazzboard:room:v3:document:${room.id}`);
    expect(state.presenceEvalCalls).toBe(1);
    expect(state.presenceEvalShaCalls).toBe(1);
  });

  it("rejects spectator agent presence inside the atomic authorization fence", async () => {
    const { connection, state } = fakeRedis();
    const store = new RedisRoomStore(connection as unknown as Redis);
    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Spectator fence",
    });
    await store.joinRoom({
      participantId: "p_spectator",
      displayName: "Observer",
      code: room.code,
      role: "spectator",
    });
    const coordinationKey = `jazzboard:room:v3:coordination:${room.id}`;
    const before = JSON.parse(state.values.get(coordinationKey)!) as PersistedRoomPlanes["coordination"];

    await expect(store.updatePresence({
      roomId: room.id,
      participantId: "p_spectator",
      actorKind: "agent",
      cursor: null,
      viewport: null,
      activity: null,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(JSON.parse(state.values.get(coordinationKey)!)).toMatchObject({
      stateRevision: before.stateRevision,
      roomRevision: before.roomRevision,
    });
  });

  it("returns stable current planes with one atomic read and no WATCH", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const source = presenceRoom();
    const planes = splitRoomState(source);
    const documentKey = `jazzboard:room:v3:document:${source.id}`;
    const awarenessKey = `jazzboard:room:v3:awareness:${source.id}`;
    const coordinationKey = `jazzboard:room:v3:coordination:${source.id}`;
    const { connection, state } = fakeRedis([
      [documentKey, JSON.stringify(planes.document)],
      [awarenessKey, JSON.stringify(planes.awareness)],
      [coordinationKey, JSON.stringify(planes.coordination)],
    ]);

    await expect(
      new RedisRoomStore(connection as unknown as Redis).getRoom(source.id),
    ).resolves.toMatchObject({
      id: source.id,
      stateRevision: source.stateRevision,
      participants: { p_owner: { connected: true } },
    });
    expect(state.mgets).toEqual([[documentKey, awarenessKey, coordinationKey]]);
    expect(state.watches).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(state.streamPayloads).toEqual([]);
  });

  it("rechecks stale derived state under WATCH before persisting it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const source = presenceRoom();
    const planes = splitRoomState(source);
    const documentKey = `jazzboard:room:v3:document:${source.id}`;
    const awarenessKey = `jazzboard:room:v3:awareness:${source.id}`;
    const coordinationKey = `jazzboard:room:v3:coordination:${source.id}`;
    const { connection, state } = fakeRedis([
      [documentKey, JSON.stringify(planes.document)],
      [awarenessKey, JSON.stringify(planes.awareness)],
      [coordinationKey, JSON.stringify(planes.coordination)],
    ]);
    vi.advanceTimersByTime(75_001);
    let refreshed = false;
    state.afterMget = (keys) => {
      if (
        refreshed ||
        keys.length !== 3 ||
        !keys.includes(documentKey) ||
        !keys.includes(awarenessKey) ||
        !keys.includes(coordinationKey)
      ) {
        return;
      }
      refreshed = true;
      const awareness = JSON.parse(
        state.values.get(awarenessKey)!,
      ) as PersistedRoomPlanes["awareness"];
      const coordination = JSON.parse(
        state.values.get(coordinationKey)!,
      ) as PersistedRoomPlanes["coordination"];
      awareness.participants.p_owner.connected = true;
      awareness.participants.p_owner.lastSeenAt = Date.now();
      awareness.participants.p_owner.human.lastSeenAt = Date.now();
      coordination.stateRevision += 1;
      writeFakeValue(state, awarenessKey, JSON.stringify(awareness));
      writeFakeValue(state, coordinationKey, JSON.stringify(coordination));
    };

    const room = await new RedisRoomStore(
      connection as unknown as Redis,
    ).getRoom(source.id);

    expect(refreshed).toBe(true);
    expect(room).toMatchObject({
      stateRevision: 8,
      participants: {
        p_owner: {
          connected: true,
          human: { lastSeenAt: Date.now() },
        },
      },
    });
    expect(state.mgets).toEqual([
      [documentKey, awarenessKey, coordinationKey],
      [awarenessKey, coordinationKey],
    ]);
    expect(state.watches).toEqual([[awarenessKey, coordinationKey]]);
    expect(state.writes).toEqual([]);
    expect(state.streamPayloads).toEqual([]);
  });

  it("does not bypass a mismatched durable-document fence on a stable read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const source = presenceRoom();
    const planes = splitRoomState(source);
    planes.coordination.roomRevision = planes.document.roomRevision + 1;
    const documentKey = `jazzboard:room:v3:document:${source.id}`;
    const awarenessKey = `jazzboard:room:v3:awareness:${source.id}`;
    const coordinationKey = `jazzboard:room:v3:coordination:${source.id}`;
    const { connection, state } = fakeRedis([
      [documentKey, JSON.stringify(planes.document)],
      [awarenessKey, JSON.stringify(planes.awareness)],
      [coordinationKey, JSON.stringify(planes.coordination)],
    ]);

    await expect(
      new RedisRoomStore(connection as unknown as Redis).getRoom(source.id),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(state.watches).toHaveLength(8);
    expect(state.watches).toEqual(
      Array.from({ length: 8 }, () => [awarenessKey, coordinationKey]),
    );
    expect(state.writes).toEqual([]);
    expect(state.streamPayloads).toEqual([]);
  });

  it("persists derived expiry once without consulting legacy storage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const source = presenceRoom();
    source.leases.object_1 = {
      leaseId: "lease_1",
      objectId: "object_1",
      actor: { participantId: "p_owner", displayName: "Owner", color: "blue", kind: "human" },
      operation: "move",
      objectRevision: 1,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 5_000,
    };
    source.spotlight = {
      presenterId: "p_owner",
      target: "human",
      startedAt: Date.now(),
      autoFollowAt: Date.now() + 5_000,
      followingParticipantIds: ["p_owner"],
      handoffRequest: null,
    };
    const planes = splitRoomState(source);
    const documentKey = `jazzboard:room:v3:document:${source.id}`;
    const awarenessKey = `jazzboard:room:v3:awareness:${source.id}`;
    const coordinationKey = `jazzboard:room:v3:coordination:${source.id}`;
    const { connection, state } = fakeRedis([
      [documentKey, JSON.stringify(planes.document)],
      [awarenessKey, JSON.stringify(planes.awareness)],
      [coordinationKey, JSON.stringify(planes.coordination)],
    ]);
    const store = new RedisRoomStore(connection as unknown as Redis);

    vi.advanceTimersByTime(75_001);
    const expired = await store.getRoom(source.id);
    expect(expired).toMatchObject({
      stateRevision: 8,
      participants: { p_owner: { connected: false } },
      leases: {},
      spotlight: null,
    });
    expect(state.mgets).toEqual([
      [documentKey, awarenessKey, coordinationKey],
      [awarenessKey, coordinationKey],
    ]);
    expect(state.watches).toEqual([[awarenessKey, coordinationKey]]);
    expect(state.writes.map(({ key }) => key)).toEqual([
      awarenessKey,
      coordinationKey,
    ]);
    expect(state.streamPayloads).toHaveLength(1);

    state.mgets.length = 0;
    state.watches.length = 0;
    state.writes.length = 0;
    state.streamPayloads.length = 0;
    const stable = await store.getRoom(source.id);
    expect(stable?.stateRevision).toBe(8);
    expect(state.mgets).toEqual([[documentKey, awarenessKey, coordinationKey]]);
    expect(state.watches).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(state.streamPayloads).toEqual([]);
    expect(state.mgets.flat()).not.toContain(`jazzboard:room:${source.id}`);
  });

  it("strictly retires grandfathered legacy data under the provider wire limit", async () => {
    const source = presenceRoom();
    source.title = "x".repeat(3 * 1024 * 1024);
    const legacyKey = `jazzboard:room:${source.id}`;
    const { connection, state } = fakeRedis([[legacyKey, JSON.stringify(source)]]);

    const migrated = await new RedisRoomStore(connection as unknown as Redis).getRoom(source.id);
    expect(migrated?.title).toHaveLength(3 * 1024 * 1024);
    expect(state.values.has(legacyKey)).toBe(false);
    expect(state.values.has(`jazzboard:room:v3:document:${source.id}`)).toBe(true);
    expect(state.writes.every(({ value }) => Buffer.byteLength(value) <= 8 * 1024 * 1024)).toBe(true);
  });

  it("fails closed without deleting a legacy document that exceeds provider-safe planes", async () => {
    const source = presenceRoom();
    source.title = "x".repeat(9 * 1024 * 1024);
    const legacyKey = `jazzboard:room:${source.id}`;
    const { connection, state } = fakeRedis([[legacyKey, JSON.stringify(source)]]);

    await expect(
      new RedisRoomStore(connection as unknown as Redis).getRoom(source.id),
    ).rejects.toMatchObject({ code: "ROOM_CAPACITY_EXCEEDED" });
    expect(state.values.has(legacyKey)).toBe(true);
    expect(state.writes).toEqual([]);
    expect(state.deletions).toEqual([]);
  });
});
