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
    const connection = connectRoomRealtime({
      roomId: "room_1",
      url: "https://jazzboard.example/api/ws",
      minReconnectMs: 50,
      maxReconnectMs: 1_000,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onEvent: (roomEvent) => events.push(roomEvent),
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
    sockets[0].serverMessage({ type: "checkpoint", cursor: "12-0" });

    expect(statuses).toEqual(["connecting", "connected"]);
    expect(snapshots).toHaveLength(1);
    expect(events).toHaveLength(1);
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
