// @vitest-environment node

import { EventEmitter } from "node:events";

import type { WebSocket } from "@vercel/functions";
import type Redis from "ioredis";
import { describe, expect, it, vi } from "vitest";

import type { RoomEvent, RoomState } from "@/lib/domain/types";
import type { RealtimeServerMessage } from "@/lib/realtime/protocol";

import { RealtimeHub } from "./realtime-hub";

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closes: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }

  messages(): RealtimeServerMessage[] {
    return this.sent.map((value) => JSON.parse(value) as RealtimeServerMessage);
  }
}

function room(revision = 1): RoomState {
  const now = 1_000;
  return {
    id: "room_1",
    code: "1234",
    title: "Realtime room",
    roomRevision: revision,
    createdAt: now,
    updatedAt: now,
    participants: {
      p_1: {
        participantId: "p_1",
        displayName: "Ada",
        color: "#4F6BED",
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

function event(id: string, sequence: number, roomId = "room_1"): RoomEvent {
  return {
    id,
    roomId,
    sequence,
    occurredAt: 1_000 + sequence,
    type: "room.updated",
    actor: null,
    payload: { room: room(sequence) },
  };
}

function streamEntry(cursor: string, roomEvent: RoomEvent): [string, string[]] {
  return [cursor, ["roomId", roomEvent.roomId, "data", JSON.stringify(roomEvent)]];
}

describe("RealtimeHub", () => {
  it("attaches listeners synchronously, sends an authoritative snapshot, and locally broadcasts", async () => {
    let publishLocal: ((roomEvent: RoomEvent) => void) | null = null;
    const readRoom = vi.fn(async () => room());
    const hub = new RealtimeHub({
      readRoom,
      subscribeLocal: (listener) => {
        publishLocal = listener;
        return vi.fn();
      },
      getRedis: () => null,
      createId: () => "connection_1",
      now: () => 2_000,
    });
    const socket = new FakeSocket();

    hub.attach(socket as unknown as WebSocket, {
      roomId: "room_1",
      participantId: "p_1",
    });

    expect(socket.listenerCount("message")).toBe(1);
    expect(socket.listenerCount("close")).toBe(1);
    expect(socket.listenerCount("error")).toBe(1);

    await vi.waitFor(() => expect(socket.messages().map((message) => message.type)).toEqual(["ready", "snapshot"]));
    expect(readRoom).toHaveBeenCalledWith("room_1", "p_1");

    const update = event("event_2", 2);
    publishLocal!(update);
    publishLocal!(update);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "ping", clientTime: 12 })));

    expect(socket.messages().filter((message) => message.type === "event")).toHaveLength(1);
    expect(socket.messages().at(-1)).toMatchObject({ type: "pong", clientTime: 12, serverTime: 2_000 });

    socket.emit("close");
    publishLocal!(event("event_3", 3));
    expect(socket.messages().filter((message) => message.type === "event")).toHaveLength(1);
    hub.dispose();
  });

  it("queues live events during bootstrap and delivers them only after the snapshot", async () => {
    let publishLocal: ((roomEvent: RoomEvent) => void) | null = null;
    let resolveRoom!: (value: RoomState) => void;
    const roomPromise = new Promise<RoomState>((resolve) => {
      resolveRoom = resolve;
    });
    const hub = new RealtimeHub({
      readRoom: () => roomPromise,
      subscribeLocal: (listener) => {
        publishLocal = listener;
        return vi.fn();
      },
      getRedis: () => null,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, { roomId: "room_1", participantId: "p_1" });

    publishLocal!(event("event_2", 2));
    resolveRoom(room(1));

    await vi.waitFor(() =>
      expect(socket.messages().map((message) => message.type)).toEqual(["ready", "snapshot", "event"]),
    );
    hub.dispose();
  });

  it("replays Redis Stream records and deduplicates a local event echoed through XREAD", async () => {
    let publishLocal: ((roomEvent: RoomEvent) => void) | null = null;
    const replayEvent = event("event_8", 8);
    const tailEvent = event("event_10", 10, "room_other");
    const xreadResolvers: Array<(value: unknown) => void> = [];
    const reader = {
      xread: vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            xreadResolvers.push(resolve);
          }),
      ),
      disconnect: vi.fn(() => {
        for (const resolve of xreadResolvers.splice(0)) resolve(null);
      }),
    };
    const redis = {
      duplicate: vi.fn(() => reader),
      xrevrange: vi.fn(async () => [streamEntry("10-0", tailEvent)]),
      xrange: vi.fn(async () => [streamEntry("8-0", replayEvent)]),
    } as unknown as Redis;
    const hub = new RealtimeHub({
      readRoom: async () => room(10),
      subscribeLocal: (listener) => {
        publishLocal = listener;
        return vi.fn();
      },
      getRedis: () => redis,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, {
      roomId: "room_1",
      participantId: "p_1",
      cursor: "5-0",
    });

    await vi.waitFor(() => expect(socket.messages().some((message) => message.type === "snapshot")).toBe(true));
    expect(socket.messages().map((message) => message.type)).toEqual(["ready", "replay", "snapshot"]);
    expect(redis.xrange).toHaveBeenCalledWith("jazzboard:events", "(5-0", "10-0", "COUNT", 500);

    const liveEvent = event("event_11", 11);
    publishLocal!(liveEvent);
    expect(socket.messages().filter((message) => message.type === "event")).toHaveLength(1);

    await vi.waitFor(() => expect(xreadResolvers.length).toBeGreaterThan(0));
    xreadResolvers.shift()!([["jazzboard:events", [streamEntry("11-0", liveEvent)]]]);

    await vi.waitFor(() => expect(socket.messages().some((message) => message.type === "checkpoint")).toBe(true));
    expect(socket.messages().filter((message) => message.type === "event")).toHaveLength(1);
    expect(socket.messages().at(-1)).toEqual({ type: "checkpoint", cursor: "11-0" });
    expect(reader.xread).toHaveBeenCalledWith(
      "COUNT",
      100,
      "BLOCK",
      5_000,
      "STREAMS",
      "jazzboard:events",
      "10-0",
    );

    hub.dispose();
    expect(reader.disconnect).toHaveBeenCalled();
  });

  it("closes a socket when membership cannot be revalidated during bootstrap", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const hub = new RealtimeHub({
      readRoom: async () => {
        throw new Error("forbidden");
      },
      subscribeLocal: () => vi.fn(),
      getRedis: () => null,
      logger,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, { roomId: "room_1", participantId: "p_unknown" });

    await vi.waitFor(() => expect(socket.closes).toContainEqual({ code: 1011, reason: "Room synchronization failed" }));
    expect(socket.messages().at(-1)).toMatchObject({ type: "error", recoverable: false });
    hub.dispose();
  });
});
