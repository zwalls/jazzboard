import { createHash } from "node:crypto";

import type Redis from "ioredis";

import { parseRealtimeServerMessage, type RealtimeServerMessage } from "@/lib/realtime/protocol";

export type TransientPresence = Extract<RealtimeServerMessage, { type: "presence.transient" }>;

export interface TransientPresenceRelay {
  joinRoom(roomId: string): void;
  leaveRoom(roomId: string): void;
  publish(message: TransientPresence): void;
  forgetConnection(connectionId: string): void;
  dispose(): void;
}

export const TRANSIENT_PRESENCE_TTL_MS = 2_000;
const MAX_FUTURE_MS = 1_000;
const MAX_PACKET_BYTES = 4_096;
const MAX_CONNECTIONS = 1_024;
const COMMAND_TIMEOUT_MS = 1_000;
const PREFIX = "jazzboard:presence:transient:v1:";

/** Exact channels, even if an identifier contains Redis glob characters. */
export function transientPresenceChannel(roomId: string): string {
  return PREFIX + createHash("sha256").update(roomId).digest("hex");
}

/** Only these fields can leave the authenticated hub; strip nested client extras too. */
export function transientPresenceDTO(message: TransientPresence): TransientPresence {
  return {
    type: "presence.transient",
    roomId: message.roomId,
    participantId: message.participantId,
    connectionId: message.connectionId,
    clientSequence: message.clientSequence,
    clientTime: message.clientTime,
    serverTime: message.serverTime,
    cursor: message.cursor ? { x: message.cursor.x, y: message.cursor.y } : null,
    viewport: message.viewport ? {
      x: message.viewport.x, y: message.viewport.y, zoom: message.viewport.zoom,
      width: message.viewport.width, height: message.viewport.height,
    } : null,
  };
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

type Pending = { message: TransientPresence; encoded: string };
type Seen = { sequence: number; expiresAt: number };

/**
 * Lossy awareness only. No stream append, key write, room mutation or replay.
 * Both owned connections disable offline queues and command resends. A stalled
 * publish has one bounded batch in flight, with at most one latest frame per
 * connection waiting behind it. Durable traffic never shares these connections.
 */
export class RedisTransientPresenceRelay implements TransientPresenceRelay {
  private readonly subscriber: Redis;
  private readonly publisher: Redis;
  private readonly rooms = new Map<string, string>(); // channel -> room
  private readonly subscribed = new Set<string>();
  private readonly attempted = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Map<string, Seen>();
  private nextSeenPruneAt = 0;
  private disposed = false;
  private publishing = false;
  private synchronizing = false;
  private subscriptionGeneration = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUnavailableAt = -Infinity;

  constructor(
    redis: Redis,
    private readonly hubId: string,
    private readonly onMessage: (message: TransientPresence) => void,
    private readonly now: () => number = Date.now,
    private readonly onUnavailable: () => void = () => {},
  ) {
    const options = {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false,
      autoResubscribe: false,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: COMMAND_TIMEOUT_MS,
      retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
    };
    this.subscriber = redis.duplicate(options);
    this.publisher = redis.duplicate(options);
    // Errors are expected during outages. ioredis otherwise emits unhandled
    // error warnings per connection; reconnect is owned by its retry strategy.
    this.subscriber.on("error", () => this.reportUnavailable());
    this.publisher.on("error", () => this.reportUnavailable());
    this.subscriber.on("ready", () => {
      this.subscriptionGeneration += 1;
      this.subscribed.clear();
      this.attempted.clear();
      void this.synchronizeSubscriptions();
    });
    this.subscriber.on("close", () => {
      this.subscriptionGeneration += 1;
      this.subscribed.clear();
      this.attempted.clear();
      this.seen.clear();
    });
    this.publisher.on("close", () => this.pending.clear());
    this.subscriber.on("message", (channel: string, encoded: string) => {
      this.receive(channel, encoded);
    });
    void this.subscriber.connect().catch(() => this.reportUnavailable());
    void this.publisher.connect().catch(() => this.reportUnavailable());
  }

  joinRoom(roomId: string): void {
    if (this.disposed || !validId(roomId)) return;
    this.rooms.set(transientPresenceChannel(roomId), roomId);
    void this.synchronizeSubscriptions();
  }

  leaveRoom(roomId: string): void {
    this.rooms.delete(transientPresenceChannel(roomId));
    for (const [connectionId, pending] of this.pending) {
      if (pending.message.roomId === roomId) this.pending.delete(connectionId);
    }
    // Channel membership is checked again at receive time, so an in-flight
    // UNSUBSCRIBE cannot leak a departed room through a stale subscription.
    void this.synchronizeSubscriptions();
  }

  forgetConnection(connectionId: string): void {
    this.pending.delete(connectionId);
  }

  publish(message: TransientPresence): void {
    if (this.disposed || this.publisher.status !== "ready" ||
      this.rooms.get(transientPresenceChannel(message.roomId)) !== message.roomId ||
      !validId(message.participantId) || !validId(message.connectionId)) return;
    const dto = transientPresenceDTO(message);
    const encoded = JSON.stringify({ version: 1, hubId: this.hubId, message: dto });
    if (Buffer.byteLength(encoded) > MAX_PACKET_BYTES) return;
    this.pending.delete(dto.connectionId);
    this.pending.set(dto.connectionId, { message: dto, encoded });
    while (this.pending.size > MAX_CONNECTIONS) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    void this.flush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscriptionGeneration += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.rooms.clear();
    this.subscribed.clear();
    this.attempted.clear();
    this.pending.clear();
    this.seen.clear();
    this.subscriber.disconnect(false);
    this.publisher.disconnect(false);
  }

  private fresh(serverTime: number): boolean {
    const age = this.now() - serverTime;
    return age >= -MAX_FUTURE_MS && age <= TRANSIENT_PRESENCE_TTL_MS;
  }

  private reportUnavailable(): void {
    if (this.disposed || this.now() - this.lastUnavailableAt < 30_000) return;
    this.lastUnavailableAt = this.now();
    this.onUnavailable();
  }

  private receive(channel: string, encoded: string): void {
    if (this.disposed || !this.rooms.has(channel) || Buffer.byteLength(encoded) > MAX_PACKET_BYTES) return;
    let packet: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(encoded);
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      packet = value as Record<string, unknown>;
    } catch { return; }
    if (packet.version !== 1 || !validId(packet.hubId) || packet.hubId === this.hubId) return;
    const message = parseRealtimeServerMessage(packet.message);
    if (!message || message.type !== "presence.transient" ||
      this.rooms.get(channel) !== message.roomId || channel !== transientPresenceChannel(message.roomId) ||
      !validId(message.participantId) || !validId(message.connectionId) || !this.fresh(message.serverTime)) return;
    // Reject duplicates and out-of-order frames without retaining connection
    // identities forever. Independent socket generations have independent IDs.
    const now = this.now();
    if (now >= this.nextSeenPruneAt) {
      for (const [id, entry] of this.seen) {
        if (entry.expiresAt < now) this.seen.delete(id);
      }
      this.nextSeenPruneAt = now + 1_000;
    }
    const id = `${packet.hubId}:${message.connectionId}`;
    const previous = this.seen.get(id);
    if (previous && previous.expiresAt >= now && previous.sequence >= message.clientSequence) return;
    this.seen.delete(id);
    this.seen.set(id, { sequence: message.clientSequence, expiresAt: now + TRANSIENT_PRESENCE_TTL_MS });
    while (this.seen.size > MAX_CONNECTIONS) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.onMessage(transientPresenceDTO(message));
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.publishing || this.publisher.status !== "ready") return;
    this.publishing = true;
    try {
      while (!this.disposed && this.publisher.status === "ready" && this.pending.size) {
        const batch = [...this.pending.values()];
        this.pending.clear();
        const pipeline = this.publisher.pipeline();
        let count = 0;
        for (const { message, encoded } of batch) {
          if (!this.rooms.has(transientPresenceChannel(message.roomId)) || !this.fresh(message.serverTime)) continue;
          pipeline.publish(transientPresenceChannel(message.roomId), encoded);
          count += 1;
        }
        if (!count) continue;
        // Failed or timed-out awareness is discarded, never retried or replayed.
        const results = await pipeline.exec();
        if (!results || results.some(([error]) => error !== null)) this.reportUnavailable();
      }
    } catch {
      this.reportUnavailable();
      this.pending.clear();
    } finally {
      this.publishing = false;
    }
  }

  private async synchronizeSubscriptions(): Promise<void> {
    if (this.disposed || this.synchronizing || this.subscriber.status !== "ready") return;
    this.synchronizing = true;
    const generation = this.subscriptionGeneration;
    try {
      while (!this.disposed && generation === this.subscriptionGeneration && this.subscriber.status === "ready") {
        const remove = [...this.attempted].filter((channel) => !this.rooms.has(channel));
        const add = [...this.rooms.keys()].filter((channel) => !this.subscribed.has(channel));
        if (!remove.length && !add.length) break;
        if (remove.length) {
          await this.subscriber.unsubscribe(...remove);
          if (generation !== this.subscriptionGeneration || this.disposed) break;
          for (const channel of remove) this.subscribed.delete(channel);
          for (const channel of remove) this.attempted.delete(channel);
        }
        if (add.length) {
          for (const channel of add) this.attempted.add(channel);
          await this.subscriber.subscribe(...add);
          if (generation !== this.subscriptionGeneration || this.disposed) break;
          for (const channel of add) this.subscribed.add(channel);
        }
      }
    } catch {
      this.reportUnavailable();
      if (!this.disposed && !this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.synchronizeSubscriptions();
        }, COMMAND_TIMEOUT_MS);
        this.retryTimer.unref?.();
      }
    } finally {
      this.synchronizing = false;
      // A new connection may become ready while the old command is rejecting.
      if (!this.disposed && generation !== this.subscriptionGeneration) {
        void this.synchronizeSubscriptions();
      }
    }
  }
}
