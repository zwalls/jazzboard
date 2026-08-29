// @vitest-environment node

import { EventEmitter } from "node:events";

import type { WebSocket } from "@vercel/functions";
import type Redis from "ioredis";
import { describe, expect, it, vi } from "vitest";

import type { RoomEvent, RoomState } from "@/lib/domain/types";
import type { AgentCanvasDraftEvent } from "@/lib/agent-drafts/types";
import { compactRoomEvent } from "@/lib/realtime/events";
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

function room(stateRevision = 1, roomRevision = stateRevision): RoomState {
  const now = 1_000;
  return {
    id: "room_1",
    code: "1234",
    title: "Realtime room",
    stateRevision,
    roomRevision,
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

function event(
  id: string,
  sequence: number,
  roomId = "room_1",
  roomRevision = sequence,
): RoomEvent {
  return {
    id,
    roomId,
    sequence,
    occurredAt: 1_000 + sequence,
    type: "room.updated",
    actor: null,
    payload: { room: room(sequence, roomRevision) },
  };
}

function compactEvent(
  id: string,
  sequence: number,
  roomId = "room_1",
  roomRevision = sequence,
): RoomEvent {
  return compactRoomEvent(event(id, sequence, roomId, roomRevision));
}

function presenceEvent(sequence: number, roomRevision: number): RoomEvent {
  return {
    id: `presence_${sequence}`,
    roomId: "room_1",
    sequence,
    occurredAt: 1_000 + sequence,
    type: "presence.updated",
    actor: null,
    payload: {
      schemaVersion: 4,
      kind: "presence.delta",
      stateRevision: sequence,
      roomRevision,
      participantId: "p_1",
      actorKind: "human",
      lastSeenAt: 1_000 + sequence,
      connected: true,
      agentActive: false,
      presence: {
        cursor: { x: sequence, y: sequence + 1 },
        viewport: null,
        lastSeenAt: 1_000 + sequence,
        activity: null,
      },
    },
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

  it("broadcasts compact draft invalidations without reconciling room revisions", async () => {
    let publishDraft: ((draftEvent: AgentCanvasDraftEvent) => void) | null = null;
    const readRoomSnapshot = vi.fn(async () => room());
    const hub = new RealtimeHub({
      readRoom: async () => room(),
      readRoomSnapshot,
      subscribeLocal: () => vi.fn(),
      subscribeLocalDrafts: (listener) => {
        publishDraft = listener;
        return vi.fn();
      },
      getRedis: () => null,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, {
      roomId: "room_1",
      participantId: "p_1",
      supportsAgentDrafts: true,
    });
    await vi.waitFor(() =>
      expect(socket.messages().map((message) => message.type)).toEqual(["ready", "snapshot"]),
    );

    publishDraft!({
      schemaVersion: 1,
      id: "draft_event_1",
      roomId: "room_1",
      occurredAt: 2_001,
      type: "draft.upsert",
      draftId: "draft_1",
      ownerParticipantId: "p_1",
      revision: 2,
      status: "active",
      expiresAt: 92_001,
    });

    expect(socket.messages().at(-1)).toMatchObject({
      type: "draft.invalidated",
      cursor: null,
      event: { draftId: "draft_1", revision: 2 },
    });
    expect(readRoomSnapshot).not.toHaveBeenCalled();
    hub.dispose();
  });

  it("fans out coalesced human transient presence locally, including for spectators", async () => {
    const sharedRoom = room();
    sharedRoom.participants.p_2 = {
      ...structuredClone(sharedRoom.participants.p_1),
      participantId: "p_2",
      displayName: "Spectator",
      role: "spectator",
    };
    let now = 2_000;
    let id = 0;
    const readRoom = vi.fn(async () => structuredClone(sharedRoom));
    const readRoomSnapshot = vi.fn(async () => structuredClone(sharedRoom));
    const hub = new RealtimeHub({
      readRoom,
      readRoomSnapshot,
      subscribeLocal: () => vi.fn(),
      getRedis: () => null,
      createId: () => `connection_${++id}`,
      now: () => now,
    });
    const participant = new FakeSocket();
    const spectator = new FakeSocket();
    hub.attach(participant as unknown as WebSocket, {
      roomId: "room_1",
      participantId: "p_1",
    });
    hub.attach(spectator as unknown as WebSocket, {
      roomId: "room_1",
      participantId: "p_2",
    });
    await vi.waitFor(() => {
      expect(participant.messages().some((message) => message.type === "snapshot")).toBe(true);
      expect(spectator.messages().some((message) => message.type === "snapshot")).toBe(true);
    });

    spectator.emit("message", Buffer.from(JSON.stringify({
      type: "presence.transient",
      clientSequence: 1,
      clientTime: 1_990,
      cursor: { x: 10, y: 20 },
      viewport: null,
    })));
    spectator.emit("message", Buffer.from(JSON.stringify({
      type: "presence.transient",
      clientSequence: 2,
      clientTime: 1_991,
      cursor: { x: 11, y: 21 },
      viewport: null,
    })));

    expect(participant.messages().filter((message) => message.type === "presence.transient"))
      .toEqual([{
        type: "presence.transient",
        roomId: "room_1",
        participantId: "p_2",
        connectionId: "connection_2",
        clientSequence: 1,
        clientTime: 1_990,
        serverTime: 2_000,
        cursor: { x: 10, y: 20 },
        viewport: null,
      }]);
    expect(spectator.messages().some((message) => message.type === "presence.transient")).toBe(false);

    now += 40;
    spectator.emit("message", Buffer.from(JSON.stringify({
      type: "presence.transient",
      clientSequence: 3,
      clientTime: 2_030,
      cursor: { x: 12, y: 22 },
      viewport: null,
    })));
    expect(participant.messages().filter((message) => message.type === "presence.transient"))
      .toHaveLength(2);
    expect(readRoomSnapshot).not.toHaveBeenCalled();
    hub.dispose();
  });

  it("delivers a same-document presence delta without an authoritative room read", async () => {
    let publishLocal: ((roomEvent: RoomEvent) => void) | null = null;
    const readRoomSnapshot = vi.fn(async () => room(11, 4));
    const hub = new RealtimeHub({
      readRoom: async () => room(10, 4),
      readRoomSnapshot,
      subscribeLocal: (listener) => {
        publishLocal = listener;
        return vi.fn();
      },
      getRedis: () => null,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, { roomId: "room_1", participantId: "p_1" });
    await vi.waitFor(() =>
      expect(socket.messages().map((message) => message.type)).toEqual(["ready", "snapshot"]),
    );

    publishLocal!(presenceEvent(11, 4));

    expect(socket.messages().at(-1)).toMatchObject({
      type: "event",
      event: { payload: { kind: "presence.delta", stateRevision: 11, roomRevision: 4 } },
    });
    expect(readRoomSnapshot).not.toHaveBeenCalled();
    hub.dispose();
  });

  it("reconciles instead of applying a presence delta across a missing document generation", async () => {
    let publishLocal: ((roomEvent: RoomEvent) => void) | null = null;
    const readRoomSnapshot = vi.fn(async () => room(12, 5));
    const hub = new RealtimeHub({
      readRoom: async () => room(10, 4),
      readRoomSnapshot,
      subscribeLocal: (listener) => {
        publishLocal = listener;
        return vi.fn();
      },
      getRedis: () => null,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, { roomId: "room_1", participantId: "p_1" });
    await vi.waitFor(() =>
      expect(socket.messages().map((message) => message.type)).toEqual(["ready", "snapshot"]),
    );

    publishLocal!(presenceEvent(12, 5));

    await vi.waitFor(() =>
      expect(socket.messages().filter((message) => message.type === "snapshot")).toHaveLength(2),
    );
    expect(socket.messages().filter((message) => message.type === "event")).toHaveLength(0);
    expect(readRoomSnapshot).toHaveBeenCalledOnce();
    hub.dispose();
  });

  it("reconciles instead of delivering a non-cumulative presence delta across a state gap", async () => {
    let publishLocal: ((roomEvent: RoomEvent) => void) | null = null;
    const readRoomSnapshot = vi.fn(async () => room(12, 4));
    const hub = new RealtimeHub({
      readRoom: async () => room(10, 4),
      readRoomSnapshot,
      subscribeLocal: (listener) => {
        publishLocal = listener;
        return vi.fn();
      },
      getRedis: () => null,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, { roomId: "room_1", participantId: "p_1" });
    await vi.waitFor(() =>
      expect(socket.messages().map((message) => message.type)).toEqual(["ready", "snapshot"]),
    );

    publishLocal!(presenceEvent(12, 4));

    await vi.waitFor(() =>
      expect(socket.messages().filter((message) => message.type === "snapshot")).toHaveLength(2),
    );
    expect(socket.messages().filter((message) => message.type === "event")).toHaveLength(0);
    expect(readRoomSnapshot).toHaveBeenCalledOnce();
    hub.dispose();
  });

  it("coalesces interleaved Spotlight, lease, and presence gaps into one authoritative snapshot", async () => {
    let publishLocal: ((roomEvent: RoomEvent) => void) | null = null;
    let resolveSnapshot!: (value: RoomState) => void;
    const snapshot = new Promise<RoomState>((resolve) => {
      resolveSnapshot = resolve;
    });
    const readRoomSnapshot = vi.fn(() => snapshot);
    const hub = new RealtimeHub({
      readRoom: async () => room(10, 4),
      readRoomSnapshot,
      subscribeLocal: (listener) => {
        publishLocal = listener;
        return vi.fn();
      },
      getRedis: () => null,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, { roomId: "room_1", participantId: "p_1" });
    await vi.waitFor(() =>
      expect(socket.messages().map((message) => message.type)).toEqual(["ready", "snapshot"]),
    );

    publishLocal!({ ...compactEvent("spotlight_11", 11, "room_1", 4), type: "spotlight.updated" });
    publishLocal!({ ...compactEvent("lease_12", 12, "room_1", 4), type: "lease.updated" });
    publishLocal!(presenceEvent(13, 4));
    resolveSnapshot(room(13, 4));

    await vi.waitFor(() =>
      expect(socket.messages().filter((message) => message.type === "snapshot")).toHaveLength(2),
    );
    expect(readRoomSnapshot).toHaveBeenCalledOnce();
    expect(socket.messages().filter((message) => message.type === "event")).toHaveLength(0);
    expect(socket.messages().at(-1)).toMatchObject({
      type: "snapshot",
      room: { stateRevision: 13, roomRevision: 4 },
    });
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

  it("recovers stale reconnect cursors from the authoritative snapshot without reading global history", async () => {
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
    const oversizedHistoryRead = vi.fn(async () => {
      throw new Error("ERR response exceeds Upstash max request size: 10512597 bytes");
    });
    const redis = {
      duplicate: vi.fn(() => reader),
      xrevrange: vi.fn(async () => [streamEntry("10-0", tailEvent)]),
      xrange: oversizedHistoryRead,
    } as unknown as Redis;
    const hub = new RealtimeHub({
      readRoom: async () => room(10),
      subscribeLocal: () => vi.fn(),
      getRedis: () => redis,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, {
      roomId: "room_1",
      participantId: "p_1",
      cursor: "5-0",
    });

    await vi.waitFor(() => expect(socket.messages().some((message) => message.type === "snapshot")).toBe(true));
    expect(socket.messages().map((message) => message.type)).toEqual(["ready", "snapshot"]);
    expect(oversizedHistoryRead).not.toHaveBeenCalled();
    expect(socket.messages().at(-1)).toMatchObject({
      type: "snapshot",
      cursor: "10-0",
      room: { roomRevision: 10 },
      replayTruncated: false,
    });
    expect(reader.xread).toHaveBeenCalledWith(
      "COUNT",
      100,
      "BLOCK",
      30_000,
      "STREAMS",
      "jazzboard:events",
      "10-0",
    );

    hub.dispose();
    expect(reader.disconnect).toHaveBeenCalled();
  });

  it("never substitutes a reusable dollar cursor when the initial Stream fence fails", async () => {
    const tailEvent = compactEvent("event_10", 10, "room_other");
    const firstReader = {
      xread: vi.fn(),
      disconnect: vi.fn(),
    };
    let resolveSecondRead!: (value: unknown) => void;
    const secondReader = {
      xread: vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            resolveSecondRead = resolve;
          }),
      ),
      disconnect: vi.fn(() => resolveSecondRead?.(null)),
    };
    const redis = {
      duplicate: vi
        .fn()
        .mockReturnValueOnce(firstReader)
        .mockReturnValueOnce(secondReader),
      xrevrange: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary tail read failure"))
        .mockRejectedValueOnce(new Error("temporary tail read failure"))
        .mockRejectedValueOnce(new Error("temporary tail read failure"))
        .mockResolvedValueOnce([streamEntry("10-0", tailEvent)]),
    } as unknown as Redis;
    const readRoom = vi.fn(async () => room(10));
    const logger = { error: vi.fn(), warn: vi.fn() };
    const hub = new RealtimeHub({
      readRoom,
      subscribeLocal: () => vi.fn(),
      getRedis: () => redis,
      logger,
    });

    const failedSocket = new FakeSocket();
    hub.attach(failedSocket as unknown as WebSocket, {
      roomId: "room_1",
      participantId: "p_1",
    });
    await vi.waitFor(() =>
      expect(failedSocket.closes).toContainEqual({
        code: 1011,
        reason: "Room synchronization failed",
      }),
    );
    expect(firstReader.xread).not.toHaveBeenCalled();
    expect(firstReader.disconnect).toHaveBeenCalledOnce();
    expect(readRoom).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();

    const recoveredSocket = new FakeSocket();
    hub.attach(recoveredSocket as unknown as WebSocket, {
      roomId: "room_1",
      participantId: "p_1",
    });
    await vi.waitFor(() =>
      expect(recoveredSocket.messages().map((message) => message.type)).toEqual([
        "ready",
        "snapshot",
      ]),
    );
    expect(redis.xrevrange).toHaveBeenCalledTimes(5);
    expect(secondReader.xread).toHaveBeenCalledWith(
      "COUNT",
      100,
      "BLOCK",
      30_000,
      "STREAMS",
      "jazzboard:events",
      "10-0",
    );

    hub.dispose();
  });

  it("drops a stream event racing the snapshot read when the snapshot already includes it", async () => {
    const tailEvent = event("event_10", 10, "room_other");
    const racingEvent = event("event_11", 11);
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
    let resolveRoom!: (value: RoomState) => void;
    const readRoom = vi.fn(
      () =>
        new Promise<RoomState>((resolve) => {
          resolveRoom = resolve;
        }),
    );
    const redis = {
      duplicate: vi.fn(() => reader),
      xrevrange: vi.fn(async () => [streamEntry("10-0", tailEvent)]),
      xrange: vi.fn(),
    } as unknown as Redis;
    const hub = new RealtimeHub({
      readRoom,
      subscribeLocal: () => vi.fn(),
      getRedis: () => redis,
    });
    const socket = new FakeSocket();

    hub.attach(socket as unknown as WebSocket, {
      roomId: "room_1",
      participantId: "p_1",
      cursor: "1-0",
    });

    await vi.waitFor(() => {
      expect(readRoom).toHaveBeenCalledOnce();
      expect(xreadResolvers).toHaveLength(1);
    });
    xreadResolvers.shift()!([["jazzboard:events", [streamEntry("11-0", racingEvent)]]]);
    await vi.waitFor(() => expect(reader.xread).toHaveBeenCalledTimes(2));
    resolveRoom(room(11));

    await vi.waitFor(() =>
      expect(socket.messages().map((message) => message.type)).toEqual(["ready", "snapshot", "checkpoint"]),
    );
    expect(socket.messages().filter((message) => message.type === "event")).toHaveLength(0);
    expect(socket.messages().at(-1)).toEqual({ type: "checkpoint", cursor: "11-0" });
    expect(redis.xrange).not.toHaveBeenCalled();

    hub.dispose();
  });

  it("delivers a stream event racing the snapshot read when it is newer than the snapshot", async () => {
    const tailEvent = event("event_10", 10, "room_other");
    const racingEvent = event("event_11", 11);
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
    let resolveRoom!: (value: RoomState) => void;
    const readRoom = vi.fn(
      () =>
        new Promise<RoomState>((resolve) => {
          resolveRoom = resolve;
        }),
    );
    const redis = {
      duplicate: vi.fn(() => reader),
      xrevrange: vi.fn(async () => [streamEntry("10-0", tailEvent)]),
      xrange: vi.fn(),
    } as unknown as Redis;
    const hub = new RealtimeHub({
      readRoom,
      subscribeLocal: () => vi.fn(),
      getRedis: () => redis,
    });
    const socket = new FakeSocket();

    hub.attach(socket as unknown as WebSocket, {
      roomId: "room_1",
      participantId: "p_1",
      cursor: "1-0",
    });

    await vi.waitFor(() => {
      expect(readRoom).toHaveBeenCalledOnce();
      expect(xreadResolvers).toHaveLength(1);
    });
    xreadResolvers.shift()!([["jazzboard:events", [streamEntry("11-0", racingEvent)]]]);
    await vi.waitFor(() => expect(reader.xread).toHaveBeenCalledTimes(2));
    resolveRoom(room(10));

    await vi.waitFor(() =>
      expect(socket.messages().map((message) => message.type)).toEqual(["ready", "snapshot", "event"]),
    );
    expect(socket.messages().at(-1)).toMatchObject({
      type: "event",
      cursor: "11-0",
      event: { id: "event_11", sequence: 11 },
    });
    expect(redis.xrange).not.toHaveBeenCalled();

    hub.dispose();
  });

  it("reconciles a compact cross-instance signal through one authoritative snapshot", async () => {
    const tailEvent = compactEvent("event_10", 10, "room_other");
    const signal = compactEvent("event_11", 11);
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
    } as unknown as Redis;
    const readRoomSnapshot = vi.fn(async () => room(11));
    const hub = new RealtimeHub({
      readRoom: async () => room(10),
      readRoomSnapshot,
      subscribeLocal: () => vi.fn(),
      getRedis: () => redis,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, { roomId: "room_1", participantId: "p_1" });

    await vi.waitFor(() => expect(socket.messages().some((message) => message.type === "snapshot")).toBe(true));
    await vi.waitFor(() => expect(xreadResolvers).toHaveLength(1));
    xreadResolvers.shift()!([["jazzboard:events", [streamEntry("11-0", signal)]]]);

    await vi.waitFor(() =>
      expect(socket.messages().map((message) => message.type)).toEqual(["ready", "snapshot", "snapshot"]),
    );
    expect(readRoomSnapshot).toHaveBeenCalledOnce();
    expect(socket.messages().at(-1)).toMatchObject({
      type: "snapshot",
      cursor: "11-0",
      room: { roomRevision: 11 },
    });
    expect(socket.messages().filter((message) => message.type === "event")).toHaveLength(0);
    hub.dispose();
  });

  it("reconciles a newer state revision when the document revision is unchanged", async () => {
    const tailEvent = compactEvent("event_10", 10, "room_other", 4);
    const signal = compactEvent("event_11", 11, "room_1", 4);
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
    } as unknown as Redis;
    const readRoomSnapshot = vi.fn(async () => room(11, 4));
    const hub = new RealtimeHub({
      readRoom: async () => room(10, 4),
      readRoomSnapshot,
      subscribeLocal: () => vi.fn(),
      getRedis: () => redis,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, { roomId: "room_1", participantId: "p_1" });

    await vi.waitFor(() => expect(xreadResolvers).toHaveLength(1));
    xreadResolvers.shift()!([["jazzboard:events", [streamEntry("11-0", signal)]]]);

    await vi.waitFor(() =>
      expect(socket.messages().filter((message) => message.type === "snapshot")).toHaveLength(2),
    );
    expect(socket.messages().at(-1)).toMatchObject({
      type: "snapshot",
      cursor: "11-0",
      room: { stateRevision: 11, roomRevision: 4 },
    });
    expect(readRoomSnapshot).toHaveBeenCalledOnce();
    hub.dispose();
  });

  it("authoritatively reconciles a lower rolling v2 watermark after newer v3 awareness", async () => {
    const tailEvent = compactEvent("event_100", 100, "room_other", 4);
    const v2Signal: RoomEvent = {
      id: "event_legacy_5",
      roomId: "room_1",
      sequence: 5,
      occurredAt: 2_000,
      type: "room.updated",
      actor: null,
      payload: {
        schemaVersion: 2,
        kind: "room.invalidated",
        roomRevision: 5,
        activityId: null,
      },
    };
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
      xrevrange: vi.fn(async () => [streamEntry("100-0", tailEvent)]),
    } as unknown as Redis;
    // The store classifies a changed legacy fingerprint as one new durable
    // revision and advances aggregate state beyond the hot-path awareness.
    const readRoomSnapshot = vi.fn(async () => room(101, 5));
    const hub = new RealtimeHub({
      readRoom: async () => room(100, 4),
      readRoomSnapshot,
      subscribeLocal: () => vi.fn(),
      getRedis: () => redis,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, { roomId: "room_1", participantId: "p_1" });

    await vi.waitFor(() => expect(xreadResolvers).toHaveLength(1));
    xreadResolvers.shift()!([["jazzboard:events", [streamEntry("101-0", v2Signal)]]]);

    await vi.waitFor(() =>
      expect(socket.messages().filter((message) => message.type === "snapshot")).toHaveLength(2),
    );
    expect(socket.messages().at(-1)).toMatchObject({
      type: "snapshot",
      room: { stateRevision: 101, roomRevision: 5 },
    });
    expect(readRoomSnapshot).toHaveBeenCalledOnce();
    hub.dispose();
  });

  it("reconciles a pre-plane full-room event by aggregate state without inventing a document revision", async () => {
    const tailEvent = compactEvent("event_100", 100, "room_other", 4);
    const legacySnapshot = room(11, 11);
    delete (legacySnapshot as { stateRevision?: number }).stateRevision;
    const legacySignal: RoomEvent = {
      id: "event_old_presence_11",
      roomId: "room_1",
      sequence: 11,
      occurredAt: 2_000,
      type: "presence.updated",
      actor: null,
      payload: { room: legacySnapshot, activity: null },
    };
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
      xrevrange: vi.fn(async () => [streamEntry("100-0", tailEvent)]),
    } as unknown as Redis;
    const readRoomSnapshot = vi.fn(async () => room(11, 4));
    const hub = new RealtimeHub({
      readRoom: async () => room(10, 4),
      readRoomSnapshot,
      subscribeLocal: () => vi.fn(),
      getRedis: () => redis,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, { roomId: "room_1", participantId: "p_1" });

    await vi.waitFor(() => expect(xreadResolvers).toHaveLength(1));
    xreadResolvers.shift()!([["jazzboard:events", [streamEntry("101-0", legacySignal)]]]);

    await vi.waitFor(() =>
      expect(socket.messages().filter((message) => message.type === "snapshot")).toHaveLength(2),
    );
    expect(socket.messages().at(-1)).toMatchObject({
      type: "snapshot",
      room: { stateRevision: 11, roomRevision: 4 },
    });
    expect(readRoomSnapshot).toHaveBeenCalledOnce();
    expect(socket.closes).toEqual([]);
    hub.dispose();
  });

  it("retries a transient authoritative read failure without disconnecting the room", async () => {
    const tailEvent = compactEvent("event_10", 10, "room_other");
    const signal = compactEvent("event_11", 11);
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
    } as unknown as Redis;
    const readRoomSnapshot = vi
      .fn<() => Promise<RoomState>>()
      .mockRejectedValueOnce(new Error("temporary Redis timeout"))
      .mockResolvedValueOnce(room(11));
    const logger = { error: vi.fn(), warn: vi.fn() };
    const hub = new RealtimeHub({
      readRoom: async () => room(10),
      readRoomSnapshot,
      subscribeLocal: () => vi.fn(),
      getRedis: () => redis,
      logger,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, { roomId: "room_1", participantId: "p_1" });

    await vi.waitFor(() => expect(xreadResolvers).toHaveLength(1));
    xreadResolvers.shift()!([["jazzboard:events", [streamEntry("11-0", signal)]]]);

    await vi.waitFor(() => expect(readRoomSnapshot).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(socket.messages().filter((message) => message.type === "snapshot")).toHaveLength(2),
    );
    expect(socket.closes).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
    hub.dispose();
  });

  it("deduplicates a locally delivered full event when its compact Redis echo arrives", async () => {
    let publishLocal: ((roomEvent: RoomEvent) => void) | null = null;
    const tailEvent = compactEvent("event_10", 10, "room_other");
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
    } as unknown as Redis;
    const readRoomSnapshot = vi.fn(async () => room(11));
    const hub = new RealtimeHub({
      readRoom: async () => room(10),
      readRoomSnapshot,
      subscribeLocal: (listener) => {
        publishLocal = listener;
        return vi.fn();
      },
      getRedis: () => redis,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, { roomId: "room_1", participantId: "p_1" });

    await vi.waitFor(() => expect(socket.messages().some((message) => message.type === "snapshot")).toBe(true));
    const update = event("event_11", 11);
    publishLocal!(update);
    await vi.waitFor(() => expect(xreadResolvers).toHaveLength(1));
    xreadResolvers.shift()!([["jazzboard:events", [streamEntry("11-0", compactRoomEvent(update))]]]);

    await vi.waitFor(() => expect(socket.messages().some((message) => message.type === "checkpoint")).toBe(true));
    expect(socket.messages().filter((message) => message.type === "event")).toHaveLength(1);
    expect(socket.messages().filter((message) => message.type === "snapshot")).toHaveLength(1);
    expect(readRoomSnapshot).not.toHaveBeenCalled();
    expect(socket.messages().at(-1)).toEqual({ type: "checkpoint", cursor: "11-0" });
    hub.dispose();
  });

  it("coalesces compact signals that arrive during one authoritative room read", async () => {
    const tailEvent = compactEvent("event_10", 10, "room_other");
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
    } as unknown as Redis;
    let resolveRoomSnapshot!: (value: RoomState) => void;
    const readRoomSnapshot = vi.fn(
      () =>
        new Promise<RoomState>((resolve) => {
          resolveRoomSnapshot = resolve;
        }),
    );
    const hub = new RealtimeHub({
      readRoom: async () => room(10),
      readRoomSnapshot,
      subscribeLocal: () => vi.fn(),
      getRedis: () => redis,
    });
    const socket = new FakeSocket();
    hub.attach(socket as unknown as WebSocket, { roomId: "room_1", participantId: "p_1" });

    await vi.waitFor(() => expect(socket.messages().some((message) => message.type === "snapshot")).toBe(true));
    await vi.waitFor(() => expect(xreadResolvers).toHaveLength(1));
    xreadResolvers.shift()!([["jazzboard:events", [streamEntry("11-0", compactEvent("event_11", 11))]]]);
    await vi.waitFor(() => {
      expect(readRoomSnapshot).toHaveBeenCalledOnce();
      expect(xreadResolvers).toHaveLength(1);
    });
    xreadResolvers.shift()!([["jazzboard:events", [streamEntry("12-0", compactEvent("event_12", 12))]]]);
    resolveRoomSnapshot(room(12));

    await vi.waitFor(() =>
      expect(socket.messages().map((message) => message.type)).toEqual(["ready", "snapshot", "snapshot"]),
    );
    expect(readRoomSnapshot).toHaveBeenCalledOnce();
    expect(socket.messages().at(-1)).toMatchObject({
      type: "snapshot",
      cursor: "12-0",
      room: { roomRevision: 12 },
    });
    hub.dispose();
  });

  it("fans an in-flight reconciliation out to replacement peers after room peer churn", async () => {
    let publishLocal: ((roomEvent: RoomEvent) => void) | null = null;
    let resolveRoomSnapshot!: (value: RoomState) => void;
    const readRoomSnapshot = vi.fn(
      () =>
        new Promise<RoomState>((resolve) => {
          resolveRoomSnapshot = resolve;
        }),
    );
    const hub = new RealtimeHub({
      readRoom: async () => room(10),
      readRoomSnapshot,
      subscribeLocal: (listener) => {
        publishLocal = listener;
        return vi.fn();
      },
      getRedis: () => null,
    });
    const firstSocket = new FakeSocket();
    hub.attach(firstSocket as unknown as WebSocket, {
      roomId: "room_1",
      participantId: "p_1",
    });
    await vi.waitFor(() =>
      expect(firstSocket.messages().map((message) => message.type)).toEqual(["ready", "snapshot"]),
    );

    publishLocal!(compactEvent("event_11", 11));
    await vi.waitFor(() => expect(readRoomSnapshot).toHaveBeenCalledOnce());
    firstSocket.emit("close");

    const replacementSocket = new FakeSocket();
    hub.attach(replacementSocket as unknown as WebSocket, {
      roomId: "room_1",
      participantId: "p_1",
    });
    await vi.waitFor(() =>
      expect(replacementSocket.messages().map((message) => message.type)).toEqual([
        "ready",
        "snapshot",
      ]),
    );

    publishLocal!(compactEvent("event_12", 12));
    resolveRoomSnapshot(room(12));

    await vi.waitFor(() =>
      expect(
        replacementSocket
          .messages()
          .filter((message) => message.type === "snapshot")
          .map((message) => message.room.roomRevision),
      ).toEqual([10, 12]),
    );
    expect(firstSocket.messages().filter((message) => message.type === "snapshot")).toHaveLength(1);
    expect(readRoomSnapshot).toHaveBeenCalledOnce();
    hub.dispose();
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
