// @vitest-environment node

import { EventEmitter } from "node:events";

import type { WebSocket } from "@vercel/functions";
import type Redis from "ioredis";
import { describe, expect, it, vi } from "vitest";

import type { RoomEvent, RoomState } from "@/lib/domain/types";
import { compactRoomEvent } from "@/lib/realtime/events";
import { parseRealtimeServerMessage } from "@/lib/realtime/protocol";

import { RealtimeHub } from "./realtime-hub";
import {
  RedisTransientPresenceRelay, transientPresenceChannel, transientPresenceDTO,
  type TransientPresence,
} from "./transient-presence-relay";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Bus {
  clients: Client[] = [];
  options: unknown[] = [];
  batches: Array<Array<[string, string]>> = [];
  publishGate: ReturnType<typeof deferred<void>> | null = null;
  subscribeGate: ReturnType<typeof deferred<void>> | null = null;
  subscribeFailure = false;
  primary = {
    duplicate: (options?: unknown) => {
      this.options.push(options);
      const client = new Client(this);
      this.clients.push(client);
      return client as unknown as Redis;
    },
    xrevrange: async () => [],
  } as unknown as Redis;

  emit(channel: string, encoded: string): void {
    for (const client of this.clients) {
      if (client.status === "ready" && client.channels.has(channel)) client.emit("message", channel, encoded);
    }
  }
}

class Client extends EventEmitter {
  status = "wait";
  channels = new Set<string>();
  disconnects = 0;
  constructor(readonly bus: Bus) { super(); }
  async connect() { this.status = "ready"; this.emit("ready"); }
  async subscribe(...channels: string[]) {
    for (const channel of channels) this.channels.add(channel);
    if (this.bus.subscribeGate) await this.bus.subscribeGate.promise;
    if (this.bus.subscribeFailure) throw new Error("Subscription acknowledgement lost");
    return this.channels.size;
  }
  async unsubscribe(...channels: string[]) {
    for (const channel of channels) this.channels.delete(channel);
    return this.channels.size;
  }
  pipeline() {
    const commands: Array<[string, string]> = [];
    return {
      publish: (channel: string, encoded: string) => { commands.push([channel, encoded]); },
      exec: async () => {
        this.bus.batches.push(commands);
        if (this.bus.publishGate) await this.bus.publishGate.promise;
        for (const [channel, encoded] of commands) this.bus.emit(channel, encoded);
        return commands.map(() => [null, 1]);
      },
    };
  }
  async xread() { return new Promise<never>(() => {}); }
  disconnect() { this.disconnects++; this.status = "end"; this.channels.clear(); this.emit("close"); }
  loseConnection() { this.status = "reconnecting"; this.channels.clear(); this.emit("close"); }
  recover() { this.status = "ready"; this.emit("ready"); }
}

function presence(sequence = 1, connectionId = "socket_1", roomId = "room_1"): TransientPresence {
  return { type: "presence.transient", roomId, participantId: "p_1", connectionId,
    clientSequence: sequence, clientTime: 990, serverTime: 1_000,
    cursor: { x: sequence, y: 2 }, viewport: null };
}
function packet(message = presence(), hubId = "remote") {
  return JSON.stringify({ version: 1, hubId, message });
}

function fixture(bus: Bus, now: () => number = () => 1_000) {
  const receive = vi.fn();
  const relay = new RedisTransientPresenceRelay(bus.primary, "local", receive, now);
  relay.joinRoom("room_1");
  return { relay, receive, subscriber: bus.clients[0], publisher: bus.clients[1] };
}

describe("Redis transient presence transport", () => {
  it("uses separate bounded connections and publishes no persistent commands", async () => {
    const bus = new Bus();
    const { relay, receive } = fixture(bus);
    relay.publish(presence());
    await vi.waitFor(() => expect(bus.batches).toHaveLength(1));
    expect(receive).not.toHaveBeenCalled(); // own hub was already delivered locally
    expect(bus.options).toHaveLength(2);
    for (const options of bus.options) expect(options).toMatchObject({
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false, autoResubscribe: false, commandTimeout: 1_000,
    });
    expect(bus.batches[0][0][0]).toBe(transientPresenceChannel("room_1"));
    relay.dispose();
    expect(bus.clients.map((client) => client.disconnects)).toEqual([1, 1]);
  });

  it("rejects other rooms, own echoes, expired/future/oversize/invalid and unordered frames", async () => {
    let now = 1_000;
    const bus = new Bus();
    const { relay, receive } = fixture(bus, () => now);
    await vi.waitFor(() => expect(bus.clients[0].channels.size).toBe(1));
    const channel = transientPresenceChannel("room_1");
    bus.emit(channel, packet(presence(), "local"));
    bus.emit(channel, packet(presence(1, "other", "room_2")));
    bus.emit(channel, packet({ ...presence(), serverTime: -1_001 }));
    bus.emit(channel, packet({ ...presence(), serverTime: 2_001 }));
    bus.emit(channel, "{");
    bus.emit(channel, JSON.stringify({ version: 1, hubId: "remote", message: { ...presence(), cursor: { x: "bad", y: 2 } } }));
    bus.emit(channel, packet({ ...presence(), extra: "x".repeat(4_096) } as TransientPresence));
    expect(receive).not.toHaveBeenCalled();
    bus.emit(channel, packet(presence(2)));
    bus.emit(channel, packet(presence(2)));
    bus.emit(channel, packet(presence(1)));
    expect(receive).toHaveBeenCalledExactlyOnceWith(presence(2));
    now = 4_000;
    bus.emit(channel, packet({ ...presence(1), serverTime: now }));
    expect(receive).toHaveBeenCalledTimes(2);
    relay.leaveRoom("room_1");
    bus.clients[0].emit("message", channel, packet({ ...presence(3), serverTime: now }));
    expect(receive).toHaveBeenCalledTimes(2);
    relay.dispose();
  });

  it("keeps at most the latest frame behind one stalled publication, dropping expired pending frames", async () => {
    let now = 1_000;
    const bus = new Bus();
    const gate = deferred<void>(); bus.publishGate = gate;
    const { relay } = fixture(bus, () => now);
    relay.publish(presence(1));
    for (let sequence = 2; sequence <= 1_000; sequence++) relay.publish(presence(sequence));
    expect(bus.batches).toHaveLength(1);
    gate.resolve();
    await vi.waitFor(() => expect(bus.batches).toHaveLength(2));
    expect(JSON.parse(bus.batches[1][0][1]).message.clientSequence).toBe(1_000);
    bus.publishGate = deferred<void>();
    relay.publish(presence(1_001));
    await vi.waitFor(() => expect(bus.batches).toHaveLength(3));
    relay.publish(presence(1_002));
    now = 4_000;
    bus.publishGate.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(bus.batches).toHaveLength(3);
    relay.dispose();
  });

  it("bounds distinct pending connections and forgets detached sources", async () => {
    const bus = new Bus(); const gate = deferred<void>(); bus.publishGate = gate;
    const { relay } = fixture(bus);
    relay.publish(presence(1, "in_flight"));
    for (let index = 0; index < 1_100; index++) relay.publish(presence(1, `socket_${index}`));
    relay.forgetConnection("socket_1099");
    gate.resolve();
    await vi.waitFor(() => expect(bus.batches).toHaveLength(2));
    expect(bus.batches[1]).toHaveLength(1_023);
    expect(bus.batches[1].some(([, value]) => JSON.parse(value).message.connectionId === "socket_1099")).toBe(false);
    relay.dispose();
  });

  it("drops outage traffic and resumes live subscriptions without replay", async () => {
    const bus = new Bus(); const { relay, receive, subscriber, publisher } = fixture(bus);
    await vi.waitFor(() => expect(subscriber.channels.size).toBe(1));
    subscriber.loseConnection(); publisher.loseConnection();
    relay.publish(presence(1));
    expect(bus.batches).toHaveLength(0);
    subscriber.recover(); publisher.recover();
    await vi.waitFor(() => expect(subscriber.channels.has(transientPresenceChannel("room_1"))).toBe(true));
    expect(bus.batches).toHaveLength(0);
    bus.emit(transientPresenceChannel("room_1"), packet(presence(2)));
    expect(receive).toHaveBeenCalledExactlyOnceWith(presence(2));
    relay.publish(presence(3));
    await vi.waitFor(() => expect(bus.batches).toHaveLength(1));
    relay.dispose();
  });

  it("removes a departed room after a subscription acknowledgement fails or races churn", async () => {
    const bus = new Bus(); bus.subscribeGate = deferred<void>(); bus.subscribeFailure = true;
    const { relay, subscriber, receive } = fixture(bus);
    expect(subscriber.channels.size).toBe(1);
    relay.leaveRoom("room_1");
    subscriber.emit("message", transientPresenceChannel("room_1"), packet());
    expect(receive).not.toHaveBeenCalled();
    bus.subscribeGate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Trigger desired-channel reconciliation after the failed acknowledgement.
    bus.subscribeFailure = false; relay.joinRoom("room_2");
    await vi.waitFor(() => expect([...subscriber.channels]).toEqual([transientPresenceChannel("room_2")]));
    relay.dispose();
  });

  it("strips nested client fields and uses exact room channels", () => {
    const input = { ...presence(), cursor: { x: 1, y: 2, credential: "must-not-relay" },
      viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1, extra: "no" }, forged: true };
    expect(transientPresenceDTO(input)).toEqual({ ...presence(),
      viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1 } });
    expect(transientPresenceChannel("room_*?[x]")).toMatch(/^jazzboard:presence:transient:v1:[a-f0-9]{64}$/);
    expect(transientPresenceChannel("room_1")).not.toBe(transientPresenceChannel("room_2"));
  });
});

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; this.emit("close"); }
  messages() { return this.sent.map((value) => JSON.parse(value)); }
  transients() { return this.messages().filter((value) => value.type === "presence.transient"); }
}

function room(roomId = "room_1", revision = 1): RoomState {
  const participant = (participantId: string, role: "participant" | "spectator") => ({
    participantId, role, displayName: participantId, color: "#4F6BED", joinedAt: 1_000,
    lastSeenAt: 1_000, connected: true, agentActive: false,
    human: { cursor: null, viewport: null, lastSeenAt: 1_000, activity: null },
    agent: { cursor: null, viewport: null, lastSeenAt: 1_000, activity: null },
  });
  return { id: roomId, code: "1234", title: "Relay room", createdAt: 1_000, updatedAt: 1_000,
    roomRevision: revision, stateRevision: revision,
    participants: { p_1: participant("p_1", "participant"), p_2: participant("p_2", "spectator") },
    objects: {}, diagrams: {}, leases: {}, spotlight: null, agentEditPolicy: "live", reviewProposals: [] };
}

describe("actual relay integrated with independent realtime hubs", () => {
  it("delivers once locally and remotely, stamps identity, bounds rate, isolates rooms, and fences observed revocation", async () => {
    const bus = new Bus(); let now = 2_000; let current = room();
    const initial = structuredClone(current);
    const readRoom = vi.fn(async (roomId: string) => structuredClone(roomId === "room_1" ? current : room(roomId)));
    const listeners: Array<(event: RoomEvent) => void> = [];
    const hubs = ["first", "second"].map((hubId) => new RealtimeHub({
      hubId, createId: () => `${hubId}_socket_${Math.random()}`, now: () => now,
      getRedis: () => bus.primary, readRoom, readRoomSnapshot: async () => structuredClone(current),
      subscribeLocal: (listener) => { listeners.push(listener); return () => {}; },
      subscribeLocalDrafts: () => () => {},
    }));
    const source = new Socket(), local = new Socket(), remote = new Socket(), otherRoom = new Socket();
    const attach = (hub: RealtimeHub, socket: Socket, participantId: string, roomId = "room_1") =>
      hub.attach(socket as unknown as WebSocket, { participantId, roomId });
    const detachSource = attach(hubs[0], source, "p_1");
    attach(hubs[0], local, "p_2"); attach(hubs[1], remote, "p_2"); attach(hubs[1], otherRoom, "p_2", "room_2");
    await vi.waitFor(() => {
      for (const socket of [source, local, remote, otherRoom]) expect(socket.messages().some((message) => message.type === "snapshot")).toBe(true);
    });
    const send = (sequence: number) => source.emit("message", JSON.stringify({
      type: "presence.transient", clientSequence: sequence, clientTime: now - 10,
      cursor: { x: sequence, y: 2, nestedSecret: "no" }, viewport: null,
      roomId: "room_2", participantId: "p_2", connectionId: "forged",
    }));
    send(1); send(2);
    expect(local.transients()).toHaveLength(1); // synchronous, no Redis await
    await vi.waitFor(() => expect(remote.transients()).toHaveLength(1));
    expect(source.transients()).toHaveLength(0);
    expect(otherRoom.transients()).toHaveLength(0);
    expect(remote.transients()[0]).toEqual(local.transients()[0]);
    expect(remote.transients()[0]).toMatchObject({ roomId: "room_1", participantId: "p_1", cursor: { x: 1, y: 2 } });
    expect(remote.transients()[0].connectionId).not.toBe("forged");
    expect(current).toEqual(initial); // no snapshot/history/revision/presence writes
    expect(readRoom).toHaveBeenCalledTimes(4);
    expect(source.messages()[0].hubId).toBe("first");
    expect(remote.messages()[0].hubId).toBe("second");
    now += 40; send(3);
    await vi.waitFor(() => expect(remote.transients()).toHaveLength(2));

    current = room("room_1", 2); delete current.participants.p_1;
    const change = compactRoomEvent({ id: "removed", type: "room.updated", roomId: "room_1", sequence: 2,
      occurredAt: now, actor: null, payload: { room: current } });
    listeners.forEach((listener) => listener(change));
    await vi.waitFor(() => expect(source.readyState).toBe(3));
    now += 40;
    bus.emit(transientPresenceChannel("room_1"), packet({ ...presence(10), serverTime: now }));
    expect(remote.transients()).toHaveLength(2);
    detachSource(); hubs.forEach((hub) => hub.dispose());
    expect(bus.clients.every((client) => client.disconnects === 1)).toBe(true);
  });

  it("accepts rolling ready messages with or without opaque hub identity", () => {
    const ready = { type: "ready", protocol: 1, roomId: "room_1", participantId: "p_1",
      connectionId: "connection", role: "participant", serverTime: 1_000 };
    expect(parseRealtimeServerMessage(ready)).toEqual(ready);
    expect(parseRealtimeServerMessage({ ...ready, hubId: "process" })).toMatchObject({ hubId: "process" });
    expect(parseRealtimeServerMessage({ ...ready, hubId: 7 })).toBeNull();
  });
});
