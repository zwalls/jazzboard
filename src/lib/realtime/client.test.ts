import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoomEvent, RoomState } from "@/lib/domain/types";
import type { RealtimeServerMessage } from "./protocol";

import { connectRoomRealtime } from "./client";

type Listener = (event: Record<string, unknown>) => void;

class FakeBrowserSocket {
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch("close", { code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.dispatch("open", {});
  }

  serverMessage(message: RealtimeServerMessage): void {
    this.dispatch("message", { data: JSON.stringify(message) });
  }

  serverClose(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.dispatch("close", { code, reason });
  }

  private dispatch(type: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function room(roomRevision = 1): RoomState {
  return {
    id: "room_1",
    code: "1234",
    title: "Realtime room",
    roomRevision,
    createdAt: 1,
    updatedAt: 1,
    participants: {},
    objects: {},
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function event(): RoomEvent {
  return {
    id: "event_2",
    roomId: "room_1",
    sequence: 2,
    occurredAt: 2,
    type: "room.updated",
    actor: null,
    payload: { room: room(2) },
  };
}

function presenceEvent(): RoomEvent {
  return {
    id: "presence_3",
    roomId: "room_1",
    sequence: 3,
    occurredAt: 3,
    type: "presence.updated",
    actor: null,
    payload: {
      schemaVersion: 4,
      kind: "presence.delta",
      stateRevision: 3,
      roomRevision: 2,
      participantId: "p_1",
      actorKind: "human",
      lastSeenAt: 3,
      connected: true,
      agentActive: false,
      presence: {
        cursor: { x: 1, y: 2 },
        viewport: null,
        lastSeenAt: 3,
        activity: null,
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("connectRoomRealtime", () => {
  it("delivers snapshots/events, retains a cursor, and reconnects with exponential backoff", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const sockets: FakeBrowserSocket[] = [];
    const statuses: string[] = [];
    const snapshots: RoomState[] = [];
    const events: RoomEvent[] = [];
    const draftEvents: string[] = [];
    const identities: string[] = [];
    const connection = connectRoomRealtime({
      roomId: "room_1",
      url: "https://jazzboard.example/api/ws",
      minReconnectMs: 50,
      maxReconnectMs: 1_000,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onEvent: (roomEvent) => events.push(roomEvent),
      onReady: (identity) => identities.push(`${identity.participantId}:${identity.role}`),
      onDraftInvalidated: (draftEvent) => draftEvents.push(draftEvent.id),
      onStatusChange: (status) => statuses.push(status),
      webSocketFactory: (url) => {
        const socket = new FakeBrowserSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    expect(connection.getStatus()).toBe("connecting");
    expect(new URL(sockets[0].url).protocol).toBe("wss:");
    expect(new URL(sockets[0].url).searchParams.get("roomId")).toBe("room_1");
    expect(new URL(sockets[0].url).searchParams.get("capabilities")).toBe(
      "presence-delta-v1,agent-draft-v1",
    );

    sockets[0].open();
    sockets[0].serverMessage({
      type: "ready",
      protocol: 1,
      connectionId: "connection_1",
      roomId: "room_1",
      participantId: "p_1",
      role: "participant",
      serverTime: 1,
    });
    sockets[0].serverMessage({ type: "snapshot", room: room(), cursor: "10-0", replayTruncated: false });
    sockets[0].serverMessage({ type: "event", event: event(), cursor: "11-0" });
    sockets[0].serverMessage({ type: "event", event: event(), cursor: "11-0" });
    sockets[0].serverMessage({ type: "event", event: presenceEvent(), cursor: "11-1" });
    sockets[0].serverMessage({
      type: "draft.invalidated",
      cursor: "11-2",
      event: {
        schemaVersion: 1,
        id: "draft_event_1",
        roomId: "room_1",
        occurredAt: 4,
        type: "draft.upsert",
        draftId: "draft_1",
        ownerParticipantId: "p_1",
        revision: 1,
        status: "active",
        expiresAt: 90_004,
      },
    });
    sockets[0].serverMessage({
      type: "draft.invalidated",
      cursor: "11-2",
      event: {
        schemaVersion: 1,
        id: "draft_event_1",
        roomId: "room_1",
        occurredAt: 4,
        type: "draft.upsert",
        draftId: "draft_1",
        ownerParticipantId: "p_1",
        revision: 1,
        status: "active",
        expiresAt: 90_004,
      },
    });
    sockets[0].serverMessage({ type: "checkpoint", cursor: "12-0" });

    expect(statuses).toEqual(["connecting", "connected"]);
    expect(identities).toEqual(["p_1:participant"]);
    expect(snapshots).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(draftEvents).toEqual(["draft_event_1"]);
    expect(events[1].payload).toMatchObject({ kind: "presence.delta", stateRevision: 3 });
    expect(connection.getCursor()).toBe("12-0");

    sockets[0].serverClose();
    expect(connection.getStatus()).toBe("reconnecting");
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);
    expect(new URL(sockets[1].url).searchParams.get("cursor")).toBe("12-0");

    connection.close();
    vi.advanceTimersByTime(5_000);
    expect(sockets).toHaveLength(2);
    expect(connection.getStatus()).toBe("closed");
  });

  it("preserves backoff across short-lived ready connections and resets it only after 60 stable seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const sockets: FakeBrowserSocket[] = [];
    const connection = connectRoomRealtime({
      roomId: "room_1",
      url: "wss://jazzboard.example/api/ws",
      onSnapshot: vi.fn(),
      onEvent: vi.fn(),
      webSocketFactory: (url) => {
        const socket = new FakeBrowserSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    const openReadyAndClose = () => {
      const socket = sockets.at(-1)!;
      socket.open();
      socket.serverMessage({
        type: "ready",
        protocol: 1,
        connectionId: `connection_${sockets.length}`,
        roomId: "room_1",
        participantId: "p_1",
        role: "participant",
        serverTime: Date.now(),
      });
      socket.serverClose();
    };
    const expectReconnectAfter = (delayMs: number) => {
      const count = sockets.length;
      vi.advanceTimersByTime(delayMs - 1);
      expect(sockets).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(count + 1);
    };

    for (const delayMs of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      openReadyAndClose();
      expectReconnectAfter(delayMs);
    }

    const almostStableSocket = sockets.at(-1)!;
    almostStableSocket.open();
    almostStableSocket.serverMessage({
      type: "ready",
      protocol: 1,
      connectionId: "connection_almost_stable",
      roomId: "room_1",
      participantId: "p_1",
      role: "participant",
      serverTime: Date.now(),
    });
    vi.setSystemTime(Date.now() + 59_999);
    almostStableSocket.serverClose();
    expectReconnectAfter(30_000);

    const stableSocket = sockets.at(-1)!;
    stableSocket.open();
    stableSocket.serverMessage({
      type: "ready",
      protocol: 1,
      connectionId: "connection_stable",
      roomId: "room_1",
      participantId: "p_1",
      role: "participant",
      serverTime: Date.now(),
    });
    vi.setSystemTime(Date.now() + 60_000);
    stableSocket.serverClose();
    expectReconnectAfter(1_000);

    connection.close();
  });

  it("requests an explicit resync with the latest checkpoint", () => {
    const socket = new FakeBrowserSocket("ws://jazzboard.test/api/ws");
    const connection = connectRoomRealtime({
      roomId: "room_1",
      initialCursor: "20-4",
      url: "ws://jazzboard.test/api/ws",
      onSnapshot: vi.fn(),
      onEvent: vi.fn(),
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    connection.requestSync();

    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "sync.request",
      cursor: "20-4",
    });
    connection.close();
  });

  it("publishes and receives lossy transient presence without a room-state event", () => {
    const socket = new FakeBrowserSocket("ws://jazzboard.test/api/ws");
    const received: unknown[] = [];
    const connection = connectRoomRealtime({
      roomId: "room_1",
      url: "ws://jazzboard.test/api/ws",
      onSnapshot: vi.fn(),
      onEvent: vi.fn(),
      onTransientPresence: (presence) => received.push(presence),
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    expect(connection.publishTransientPresence({ cursor: null, viewport: null })).toBe(false);
    socket.open();
    expect(connection.publishTransientPresence({
      cursor: { x: 4, y: 5 },
      viewport: { x: 0, y: 0, zoom: 1, width: 800, height: 600 },
    })).toBe(true);
    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "presence.transient",
      clientSequence: 1,
      clientTime: expect.any(Number),
      cursor: { x: 4, y: 5 },
      viewport: { x: 0, y: 0, zoom: 1, width: 800, height: 600 },
    });

    socket.serverMessage({
      type: "presence.transient",
      roomId: "room_1",
      participantId: "p_2",
      connectionId: "connection_2",
      clientSequence: 3,
      clientTime: 100,
      serverTime: 105,
      cursor: { x: 9, y: 10 },
      viewport: null,
    });
    expect(received).toEqual([{
      participantId: "p_2",
      connectionId: "connection_2",
      clientSequence: 3,
      clientTime: 100,
      serverTime: 105,
      cursor: { x: 9, y: 10 },
      viewport: null,
    }]);
    connection.close();
  });

  it("falls back cleanly when browser WebSockets are unavailable", () => {
    vi.stubGlobal("WebSocket", undefined);
    const statuses: string[] = [];

    const connection = connectRoomRealtime({
      roomId: "room_1",
      url: "ws://jazzboard.test/api/ws",
      onSnapshot: vi.fn(),
      onEvent: vi.fn(),
      onStatusChange: (status) => statuses.push(status),
    });

    expect(connection.getStatus()).toBe("unavailable");
    expect(statuses).toEqual(["unavailable"]);
    expect(() => connection.requestSync()).not.toThrow();
    connection.close();
  });
});
