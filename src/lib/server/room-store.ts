import { EventEmitter } from "node:events";
import { randomInt, randomUUID } from "node:crypto";

import Redis from "ioredis";

import { actorFor, normalizeRoomSemanticState, pruneExpiredLeases } from "@/lib/domain/engine";
import { DomainError } from "@/lib/domain/errors";
import { roomActivitySummary } from "@/lib/domain/review";
import type { ActorRef, Participant, RoomActivity, RoomEvent, RoomRole, RoomState } from "@/lib/domain/types";

const COLORS = ["#4F6BED", "#00A68A", "#9B51E0", "#E0528D", "#D9822B", "#00A2C7", "#E5484D"];
const ROOM_KEY_PREFIX = "jazzboard:room:";
const CODE_KEY_PREFIX = "jazzboard:code:";
const ACTIVITY_KEY_PREFIX = "jazzboard:activity:";
const EVENT_STREAM = "jazzboard:events";
const PRESENCE_AWAY_MS = 20_000;
export const ROOM_ACTIVITY_LIMIT = 200;

type RoomUpdater<T> = (room: RoomState) => {
  room: RoomState;
  result: T;
  eventActor?: ActorRef | null;
  activity?: RoomActivity;
};

export interface RoomStore {
  createRoom(input: {
    participantId: string;
    displayName: string;
    title: string;
  }): Promise<RoomState>;
  joinRoom(input: {
    participantId: string;
    displayName: string;
    code: string;
    role: RoomRole;
  }): Promise<RoomState>;
  getRoom(roomId: string): Promise<RoomState | null>;
  getRoomByCode(code: string): Promise<RoomState | null>;
  listActivities(roomId: string): Promise<RoomActivity[]>;
  getActivity(roomId: string, activityId: string): Promise<RoomActivity | null>;
  transact<T>(roomId: string, updater: RoomUpdater<T>, eventType?: RoomEvent["type"]): Promise<T>;
}

type LocalState = {
  rooms: Map<string, RoomState>;
  codes: Map<string, string>;
  activities: Map<string, RoomActivity[]>;
  queues: Map<string, Promise<void>>;
  bus: EventEmitter;
};

declare global {
  var __jazzboardLocalState: LocalState | undefined;
  var __jazzboardRoomStore: RoomStore | undefined;
  var __jazzboardRedis: Redis | null | undefined;
}

function localState(): LocalState {
  globalThis.__jazzboardLocalState ??= {
    rooms: new Map(),
    codes: new Map(),
    activities: new Map(),
    queues: new Map(),
    bus: new EventEmitter(),
  };
  // Development hot reload can retain a process-local state created by an
  // earlier module version before activity persistence existed.
  globalThis.__jazzboardLocalState.activities ??= new Map();
  globalThis.__jazzboardLocalState.bus.setMaxListeners(200);
  return globalThis.__jazzboardLocalState;
}

function makeParticipant(input: {
  participantId: string;
  displayName: string;
  role: RoomRole;
  color: string;
  now: number;
}): Participant {
  const presence = { cursor: null, viewport: null, lastSeenAt: input.now, activity: null };
  return {
    participantId: input.participantId,
    displayName: input.displayName,
    color: input.color,
    role: input.role,
    joinedAt: input.now,
    lastSeenAt: input.now,
    connected: true,
    agentActive: false,
    human: { ...presence },
    agent: { ...presence },
  };
}

function availableColor(room: RoomState): string {
  const used = new Set(Object.values(room.participants).map((participant) => participant.color));
  return COLORS.find((color) => !used.has(color)) ?? COLORS[Object.keys(room.participants).length % COLORS.length];
}

function currentRoomCopy(room: RoomState): RoomState {
  const current = normalizeRoomSemanticState(structuredClone(room));
  const now = Date.now();
  pruneExpiredLeases(current, now);
  for (const participant of Object.values(current.participants)) {
    participant.connected =
      now - participant.human.lastSeenAt < PRESENCE_AWAY_MS ||
      now - participant.agent.lastSeenAt < PRESENCE_AWAY_MS;
  }
  if (current.spotlight) {
    const presenter = current.participants[current.spotlight.presenterId];
    if (!presenter?.connected) current.spotlight = null;
    else {
      current.spotlight.followingParticipantIds = current.spotlight.followingParticipantIds.filter(
        (participantId) => current.participants[participantId]?.connected,
      );
    }
  }
  return current;
}

function roomEvent(
  room: RoomState,
  type: RoomEvent["type"],
  actor: ActorRef | null = null,
  activity: RoomActivity | null = null,
): RoomEvent {
  return {
    id: randomUUID(),
    roomId: room.id,
    sequence: room.roomRevision,
    occurredAt: Date.now(),
    type,
    actor,
    payload: { room, activity: activity ? roomActivitySummary(activity) : null },
  };
}

export function subscribeToLocalRoomEvents(listener: (event: RoomEvent) => void): () => void {
  const bus = localState().bus;
  bus.on("room-event", listener);
  return () => bus.off("room-event", listener);
}

function publishLocal(event: RoomEvent): void {
  localState().bus.emit("room-event", event);
}

class MemoryRoomStore implements RoomStore {
  async createRoom(input: {
    participantId: string;
    displayName: string;
    title: string;
  }): Promise<RoomState> {
    const state = localState();
    let code = "";
    do code = randomInt(0, 10_000).toString().padStart(4, "0");
    while (state.codes.has(code));

    const now = Date.now();
    const room: RoomState = {
      id: `room_${randomUUID()}`,
      code,
      title: input.title,
      roomRevision: 1,
      createdAt: now,
      updatedAt: now,
      participants: {
        [input.participantId]: makeParticipant({
          ...input,
          role: "participant",
          color: COLORS[0],
          now,
        }),
      },
      objects: {},
      diagrams: {},
      leases: {},
      spotlight: null,
      agentEditPolicy: "live",
      reviewProposals: [],
    };
    state.rooms.set(room.id, structuredClone(room));
    state.codes.set(code, room.id);
    state.activities.set(room.id, []);
    publishLocal(
      roomEvent(room, "room.snapshot", actorFor(room.participants[input.participantId], "human")),
    );
    return room;
  }

  async joinRoom(input: {
    participantId: string;
    displayName: string;
    code: string;
    role: RoomRole;
  }): Promise<RoomState> {
    const roomId = localState().codes.get(input.code);
    if (!roomId) throw new DomainError("ROOM_NOT_FOUND", "No Jazzboard exists with that code.");
    return this.transact(
      roomId,
      (room) => {
        const now = Date.now();
        const existing = room.participants[input.participantId];
        room.participants[input.participantId] = existing
          ? {
              ...existing,
              displayName: input.displayName,
              role: input.role,
              connected: true,
              lastSeenAt: now,
            }
          : makeParticipant({ ...input, color: availableColor(room), now });
        room.roomRevision += 1;
        room.updatedAt = now;
        return {
          room,
          result: room,
          eventActor: actorFor(room.participants[input.participantId], "human"),
        };
      },
      "presence.updated",
    );
  }

  async getRoom(roomId: string): Promise<RoomState | null> {
    const room = localState().rooms.get(roomId);
    return room ? currentRoomCopy(room) : null;
  }

  async getRoomByCode(code: string): Promise<RoomState | null> {
    const roomId = localState().codes.get(code);
    return roomId ? this.getRoom(roomId) : null;
  }

  async listActivities(roomId: string): Promise<RoomActivity[]> {
    return structuredClone(localState().activities.get(roomId) ?? []);
  }

  async getActivity(roomId: string, activityId: string): Promise<RoomActivity | null> {
    const activity = localState().activities.get(roomId)?.find((item) => item.id === activityId);
    return activity ? structuredClone(activity) : null;
  }

  async transact<T>(
    roomId: string,
    updater: RoomUpdater<T>,
    eventType: RoomEvent["type"] = "room.updated",
  ): Promise<T> {
    const state = localState();
    const previous = state.queues.get(roomId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    state.queues.set(roomId, queued);
    await previous;
    try {
      const existing = state.rooms.get(roomId);
      if (!existing) throw new DomainError("ROOM_NOT_FOUND", "This Jazzboard no longer exists.");
      const { room, result, eventActor, activity } = updater(currentRoomCopy(existing));
      state.rooms.set(roomId, structuredClone(room));
      if (activity) {
        const activities = state.activities.get(roomId) ?? [];
        state.activities.set(
          roomId,
          [structuredClone(activity), ...activities].slice(0, ROOM_ACTIVITY_LIMIT),
        );
      }
      publishLocal(roomEvent(room, eventType, eventActor, activity ?? null));
      return result;
    } finally {
      release();
      if (state.queues.get(roomId) === queued) state.queues.delete(roomId);
    }
  }
}

function redisClient(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) {
    if (process.env.VERCEL === "1") {
      throw new Error("REDIS_URL is required for deployed Jazzboard rooms; process-local state is development-only.");
    }
    return null;
  }
  if (globalThis.__jazzboardRedis !== undefined) return globalThis.__jazzboardRedis;
  globalThis.__jazzboardRedis = new Redis(url, {
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  return globalThis.__jazzboardRedis;
}

class RedisRoomStore implements RoomStore {
  constructor(private readonly redis: Redis) {}

  async createRoom(input: {
    participantId: string;
    displayName: string;
    title: string;
  }): Promise<RoomState> {
    const roomId = `room_${randomUUID()}`;
    let code: string | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = randomInt(0, 10_000).toString().padStart(4, "0");
      if ((await this.redis.set(`${CODE_KEY_PREFIX}${candidate}`, roomId, "NX")) === "OK") {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error("Unable to allocate a unique room code.");

    const now = Date.now();
    const room: RoomState = {
      id: roomId,
      code,
      title: input.title,
      roomRevision: 1,
      createdAt: now,
      updatedAt: now,
      participants: {
        [input.participantId]: makeParticipant({
          ...input,
          role: "participant",
          color: COLORS[0],
          now,
        }),
      },
      objects: {},
      diagrams: {},
      leases: {},
      spotlight: null,
      agentEditPolicy: "live",
      reviewProposals: [],
    };
    await this.redis.set(`${ROOM_KEY_PREFIX}${room.id}`, JSON.stringify(room));
    await this.publish(
      room,
      "room.snapshot",
      actorFor(room.participants[input.participantId], "human"),
    );
    return room;
  }

  async joinRoom(input: {
    participantId: string;
    displayName: string;
    code: string;
    role: RoomRole;
  }): Promise<RoomState> {
    const roomId = await this.redis.get(`${CODE_KEY_PREFIX}${input.code}`);
    if (!roomId) throw new DomainError("ROOM_NOT_FOUND", "No Jazzboard exists with that code.");
    return this.transact(
      roomId,
      (room) => {
        const now = Date.now();
        const existing = room.participants[input.participantId];
        room.participants[input.participantId] = existing
          ? {
              ...existing,
              displayName: input.displayName,
              role: input.role,
              connected: true,
              lastSeenAt: now,
            }
          : makeParticipant({ ...input, color: availableColor(room), now });
        room.roomRevision += 1;
        room.updatedAt = now;
        return {
          room,
          result: room,
          eventActor: actorFor(room.participants[input.participantId], "human"),
        };
      },
      "presence.updated",
    );
  }

  async getRoom(roomId: string): Promise<RoomState | null> {
    const encoded = await this.redis.get(`${ROOM_KEY_PREFIX}${roomId}`);
    return encoded ? currentRoomCopy(JSON.parse(encoded) as RoomState) : null;
  }

  async getRoomByCode(code: string): Promise<RoomState | null> {
    const roomId = await this.redis.get(`${CODE_KEY_PREFIX}${code}`);
    return roomId ? this.getRoom(roomId) : null;
  }

  async listActivities(roomId: string): Promise<RoomActivity[]> {
    const encoded = await this.redis.lrange(`${ACTIVITY_KEY_PREFIX}${roomId}`, 0, ROOM_ACTIVITY_LIMIT - 1);
    return encoded.flatMap((item) => {
      try {
        return [JSON.parse(item) as RoomActivity];
      } catch {
        return [];
      }
    });
  }

  async getActivity(roomId: string, activityId: string): Promise<RoomActivity | null> {
    return (await this.listActivities(roomId)).find((activity) => activity.id === activityId) ?? null;
  }

  async transact<T>(
    roomId: string,
    updater: RoomUpdater<T>,
    eventType: RoomEvent["type"] = "room.updated",
  ): Promise<T> {
    const connection = this.redis.duplicate();
    const key = `${ROOM_KEY_PREFIX}${roomId}`;
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await connection.watch(key);
        const encoded = await connection.get(key);
        if (!encoded) {
          await connection.unwatch();
          throw new DomainError("ROOM_NOT_FOUND", "This Jazzboard no longer exists.");
        }
        const { room, result, eventActor, activity } = updater(
          currentRoomCopy(JSON.parse(encoded) as RoomState),
        );
        const event = roomEvent(room, eventType, eventActor, activity ?? null);
        const transaction = connection
          .multi()
          .set(key, JSON.stringify(room))
          .xadd(
            EVENT_STREAM,
            "MAXLEN",
            "~",
            20_000,
            "*",
            "roomId",
            roomId,
            "data",
            JSON.stringify(event),
          );
        if (activity) {
          transaction
            .lpush(`${ACTIVITY_KEY_PREFIX}${roomId}`, JSON.stringify(activity))
            .ltrim(`${ACTIVITY_KEY_PREFIX}${roomId}`, 0, ROOM_ACTIVITY_LIMIT - 1);
        }
        const committed = await transaction.exec();
        if (committed) {
          publishLocal(event);
          return result;
        }
      }
      throw new DomainError("REVISION_CONFLICT", "The room changed too quickly; inspect the latest state and retry.");
    } finally {
      await connection.quit().catch(() => undefined);
    }
  }

  private async publish(
    room: RoomState,
    type: RoomEvent["type"],
    actor: ActorRef | null = null,
  ): Promise<void> {
    const event = roomEvent(room, type, actor);
    await this.redis.xadd(
      EVENT_STREAM,
      "MAXLEN",
      "~",
      20_000,
      "*",
      "roomId",
      room.id,
      "data",
      JSON.stringify(event),
    );
    publishLocal(event);
  }
}

export function getRoomStore(): RoomStore {
  if (globalThis.__jazzboardRoomStore) return globalThis.__jazzboardRoomStore;
  const redis = redisClient();
  globalThis.__jazzboardRoomStore = redis ? new RedisRoomStore(redis) : new MemoryRoomStore();
  return globalThis.__jazzboardRoomStore;
}

export function getRedisForRealtime(): Redis | null {
  return redisClient();
}

export function getRedisForAssets(): Redis | null {
  return redisClient();
}
