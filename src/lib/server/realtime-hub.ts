import { randomUUID } from "node:crypto";

import type { WebSocket, WebSocketData } from "@vercel/functions";
import type Redis from "ioredis";

import type { RoomEvent, RoomState } from "@/lib/domain/types";
import { isDomainError } from "@/lib/domain/errors";
import { isCompactRoomEventPayload } from "@/lib/realtime/events";
import {
  REALTIME_EVENT_STREAM,
  REALTIME_PROTOCOL_VERSION,
  encodeRealtimeMessage,
  laterStreamCursor,
  parseRealtimeClientMessage,
  parseStreamCursor,
  type RealtimeServerMessage,
} from "@/lib/realtime/protocol";
import {
  decodeXRead,
  latestCursorFromStreamEntries,
  latestCursorFromXRead,
} from "@/lib/realtime/redis-stream";

import { readAuthorizedRoom } from "./room-service";
import { getRedisForRealtime, getRoomStore, subscribeToLocalRoomEvents } from "./room-store";

const SOCKET_OPEN = 1;
const MAX_PENDING_EVENTS = 512;
const MAX_DELIVERED_EVENT_IDS = 1_024;
const MAX_SOCKET_BUFFER_BYTES = 2 * 1024 * 1024;
const STREAM_READ_COUNT = 100;
const STREAM_BLOCK_MS = 5_000;
const STREAM_FENCE_ATTEMPTS = 3;
const STREAM_FENCE_RETRY_MS = 50;
const ROOM_RECONCILIATION_ATTEMPTS = 3;
const ROOM_RECONCILIATION_RETRY_MS = 50;

type RoomReader = (roomId: string, participantId: string) => Promise<RoomState>;
type RoomSnapshotReader = (roomId: string) => Promise<RoomState | null>;
type LocalSubscriber = (listener: (event: RoomEvent) => void) => () => void;

export type RealtimeHubDependencies = {
  readRoom?: RoomReader;
  readRoomSnapshot?: RoomSnapshotReader;
  subscribeLocal?: LocalSubscriber;
  getRedis?: () => Redis | null;
  createId?: () => string;
  now?: () => number;
  logger?: Pick<Console, "error" | "warn">;
};

export type AttachRealtimeSocketOptions = {
  roomId: string;
  participantId: string;
  cursor?: string | null;
};

type PendingEvent = {
  event: RoomEvent;
  cursor: string | null;
};

type RoomReconciliation = {
  signals: Map<string, PendingEvent>;
  running: boolean;
};

type Peer = {
  id: string;
  socket: WebSocket;
  roomId: string;
  participantId: string;
  ready: boolean;
  readySent: boolean;
  disposed: boolean;
  cursor: string | null;
  snapshotRevision: number;
  syncGeneration: number;
  synchronizing: boolean;
  nextSyncCursor: string | null | undefined;
  pendingOrder: string[];
  pending: Map<string, PendingEvent>;
  deliveredOrder: string[];
  delivered: Set<string>;
};

function socketDataToText(data: WebSocketData | unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    if (!data.every((part) => part instanceof Uint8Array)) return null;
    return Buffer.concat(data.map((part) => Buffer.from(part))).toString("utf8");
  }
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  return null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rememberDelivered(peer: Peer, eventId: string): void {
  if (peer.delivered.has(eventId)) return;
  peer.delivered.add(eventId);
  peer.deliveredOrder.push(eventId);
  while (peer.deliveredOrder.length > MAX_DELIVERED_EVENT_IDS) {
    const oldest = peer.deliveredOrder.shift();
    if (oldest) peer.delivered.delete(oldest);
  }
}

function queuePending(peer: Peer, event: RoomEvent, cursor: string | null): void {
  const existing = peer.pending.get(event.id);
  if (existing) {
    existing.cursor = laterStreamCursor(existing.cursor, cursor);
    return;
  }
  peer.pending.set(event.id, { event, cursor });
  peer.pendingOrder.push(event.id);
  while (peer.pendingOrder.length > MAX_PENDING_EVENTS) {
    const oldest = peer.pendingOrder.shift();
    if (oldest) peer.pending.delete(oldest);
  }
}

export class RealtimeHub {
  private readonly readRoom: RoomReader;
  private readonly readRoomSnapshot: RoomSnapshotReader;
  private readonly subscribeLocal: LocalSubscriber;
  private readonly getRedis: () => Redis | null;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly logger: Pick<Console, "error" | "warn">;

  private readonly peersByRoom = new Map<string, Set<Peer>>();
  private readonly roomReconciliations = new Map<string, RoomReconciliation>();
  private unsubscribeLocal: (() => void) | null = null;
  private redis: Redis | null | undefined;
  private streamReader: Redis | null = null;
  private readerReady: Promise<void> | null = null;
  private readerGeneration = 0;
  private readerCursor = "0-0";

  constructor(dependencies: RealtimeHubDependencies = {}) {
    this.readRoom = dependencies.readRoom ?? readAuthorizedRoom;
    this.readRoomSnapshot =
      dependencies.readRoomSnapshot ?? ((roomId) => getRoomStore().getRoom(roomId));
    this.subscribeLocal = dependencies.subscribeLocal ?? subscribeToLocalRoomEvents;
    this.getRedis = dependencies.getRedis ?? getRedisForRealtime;
    this.createId = dependencies.createId ?? randomUUID;
    this.now = dependencies.now ?? Date.now;
    this.logger = dependencies.logger ?? console;
  }

  /**
   * Attaches every socket listener before beginning authentication-sensitive I/O.
   * The route performs a pre-upgrade membership check; the bootstrap read below
   * revalidates membership and provides the authoritative initial snapshot.
   */
  attach(socket: WebSocket, options: AttachRealtimeSocketOptions): () => void {
    const peer: Peer = {
      id: this.createId(),
      socket,
      roomId: options.roomId,
      participantId: options.participantId,
      ready: false,
      readySent: false,
      disposed: false,
      cursor: parseStreamCursor(options.cursor),
      snapshotRevision: -1,
      syncGeneration: 0,
      synchronizing: false,
      nextSyncCursor: undefined,
      pendingOrder: [],
      pending: new Map(),
      deliveredOrder: [],
      delivered: new Set(),
    };

    const onMessage = (data: WebSocketData) => this.handleMessage(peer, data);
    const onClose = () => this.detach(peer);
    const onError = () => this.detach(peer);

    // Keep these registrations together and above every asynchronous operation.
    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onError);

    this.ensureLocalSubscription();
    const roomPeers = this.peersByRoom.get(peer.roomId) ?? new Set<Peer>();
    roomPeers.add(peer);
    this.peersByRoom.set(peer.roomId, roomPeers);

    this.requestSynchronization(peer, peer.cursor);
    return () => this.detach(peer);
  }

  dispose(): void {
    for (const peers of this.peersByRoom.values()) {
      for (const peer of peers) peer.disposed = true;
    }
    this.peersByRoom.clear();
    this.roomReconciliations.clear();
    this.unsubscribeLocal?.();
    this.unsubscribeLocal = null;
    this.stopStreamReader();
  }

  private ensureLocalSubscription(): void {
    this.unsubscribeLocal ??= this.subscribeLocal((event) => {
      this.broadcastEvent(event, null);
    });
  }

  private detach(peer: Peer): void {
    if (peer.disposed) return;
    peer.disposed = true;
    peer.syncGeneration += 1;
    peer.nextSyncCursor = undefined;
    const peers = this.peersByRoom.get(peer.roomId);
    peers?.delete(peer);
    if (peers?.size === 0) this.peersByRoom.delete(peer.roomId);
    if (this.peerCount() === 0) this.stopStreamReader();
  }

  private peerCount(): number {
    let count = 0;
    for (const peers of this.peersByRoom.values()) count += peers.size;
    return count;
  }

  private handleMessage(peer: Peer, data: WebSocketData): void {
    const encoded = socketDataToText(data);
    let decoded: unknown;
    try {
      decoded = encoded === null ? null : JSON.parse(encoded);
    } catch {
      decoded = null;
    }
    const message = parseRealtimeClientMessage(decoded);
    if (!message) {
      this.send(peer, {
        type: "error",
        error: { code: "INVALID_MESSAGE", message: "The realtime message is not valid." },
        recoverable: true,
      });
      return;
    }

    if (message.type === "ping") {
      this.send(peer, {
        type: "pong",
        clientTime: message.clientTime ?? null,
        serverTime: this.now(),
      });
      return;
    }

    this.requestSynchronization(peer, parseStreamCursor(message.cursor) ?? peer.cursor);
  }

  private requestSynchronization(peer: Peer, cursor: string | null): void {
    if (peer.disposed) return;
    peer.nextSyncCursor = cursor;
    if (peer.synchronizing) return;
    peer.synchronizing = true;

    void (async () => {
      while (!peer.disposed && peer.nextSyncCursor !== undefined) {
        peer.nextSyncCursor = undefined;
        await this.synchronize(peer);
      }
    })().finally(() => {
      peer.synchronizing = false;
      if (!peer.disposed && peer.nextSyncCursor !== undefined) {
        this.requestSynchronization(peer, peer.nextSyncCursor);
      }
    });
  }

  private async synchronize(peer: Peer): Promise<void> {
    const generation = ++peer.syncGeneration;
    peer.ready = false;

    try {
      await this.ensureStreamReader();
      const redis = this.redisClient();
      const snapshotCursor = redis ? await this.readStreamTail(redis) : null;
      const room = await this.readRoom(peer.roomId, peer.participantId);
      if (peer.disposed || generation !== peer.syncGeneration) return;

      const participant = room.participants[peer.participantId];
      if (!participant) throw new Error("Membership disappeared during realtime synchronization.");

      if (!peer.readySent) {
        this.send(peer, {
          type: "ready",
          protocol: REALTIME_PROTOCOL_VERSION,
          connectionId: peer.id,
          roomId: peer.roomId,
          participantId: peer.participantId,
          role: participant.role,
          serverTime: this.now(),
        });
        peer.readySent = true;
      }

      peer.snapshotRevision = room.roomRevision;
      // A reconnect always establishes a fresh authoritative snapshot. The
      // cursor is only a transport checkpoint; correctness never depends on
      // replaying client history. Events racing this read were queued after the
      // live reader fence and are reconciled by revision below.
      peer.cursor = snapshotCursor;
      this.send(peer, {
        type: "snapshot",
        cursor: peer.cursor,
        room,
        replayTruncated: false,
      });
      peer.ready = true;
      this.flushPending(peer);
    } catch (error) {
      if (peer.disposed || generation !== peer.syncGeneration) return;
      const accessDenied =
        isDomainError(error) &&
        (error.code === "AUTH_REQUIRED" || error.code === "FORBIDDEN" || error.code === "ROOM_NOT_FOUND");
      if (!accessDenied) this.logger.error("Jazzboard realtime synchronization failed.", error);
      this.send(peer, {
        type: "error",
        error: {
          code: accessDenied ? "FORBIDDEN" : "SYNC_FAILED",
          message: accessDenied
            ? "This guest session is no longer authorized for the room."
            : "Jazzboard could not synchronize this room. Reconnect to try again.",
        },
        recoverable: false,
      });
      peer.socket.close(accessDenied ? 1008 : 1011, accessDenied ? "Room membership required" : "Room synchronization failed");
      this.detach(peer);
    }
  }

  private flushPending(peer: Peer): void {
    const pending = peer.pendingOrder
      .map((eventId) => peer.pending.get(eventId))
      .filter((entry): entry is PendingEvent => entry !== undefined)
      .sort((left, right) => left.event.sequence - right.event.sequence || left.event.occurredAt - right.event.occurredAt);
    peer.pending.clear();
    peer.pendingOrder = [];

    for (const entry of pending) {
      if (entry.event.sequence <= peer.snapshotRevision) {
        this.advancePeerCursor(peer, entry.cursor);
        rememberDelivered(peer, entry.event.id);
        continue;
      }
      if (isCompactRoomEventPayload(entry.event.payload, entry.event.sequence)) {
        this.requestRoomReconciliation(entry.event, entry.cursor);
        continue;
      }
      this.deliverEvent(peer, entry.event, entry.cursor);
    }
  }

  private broadcastEvent(event: RoomEvent, cursor: string | null): void {
    const peers = this.peersByRoom.get(event.roomId);
    if (!peers) return;
    const compact = isCompactRoomEventPayload(event.payload, event.sequence);
    let needsReconciliation = false;
    for (const peer of peers) {
      if (peer.disposed) continue;
      if (!peer.ready) {
        queuePending(peer, event, cursor);
      } else if (!compact) {
        this.deliverEvent(peer, event, cursor);
      } else if (event.sequence <= peer.snapshotRevision || peer.delivered.has(event.id)) {
        rememberDelivered(peer, event.id);
        this.advancePeerCursor(peer, cursor);
      } else {
        needsReconciliation = true;
      }
    }
    if (needsReconciliation) this.requestRoomReconciliation(event, cursor);
  }

  private deliverEvent(peer: Peer, event: RoomEvent, cursor: string | null): void {
    if (isCompactRoomEventPayload(event.payload, event.sequence)) {
      this.requestRoomReconciliation(event, cursor);
      return;
    }
    if (peer.delivered.has(event.id)) {
      this.advancePeerCursor(peer, cursor);
      return;
    }
    if (event.sequence <= peer.snapshotRevision) {
      rememberDelivered(peer, event.id);
      this.advancePeerCursor(peer, cursor);
      return;
    }
    this.send(peer, { type: "event", cursor, event });
    rememberDelivered(peer, event.id);
    peer.snapshotRevision = Math.max(peer.snapshotRevision, event.sequence);
    peer.cursor = laterStreamCursor(peer.cursor, cursor);
  }

  private requestRoomReconciliation(event: RoomEvent, cursor: string | null): void {
    const state = this.roomReconciliations.get(event.roomId) ?? {
      signals: new Map<string, PendingEvent>(),
      running: false,
    };
    const existing = state.signals.get(event.id);
    if (existing) existing.cursor = laterStreamCursor(existing.cursor, cursor);
    else state.signals.set(event.id, { event, cursor });
    this.roomReconciliations.set(event.roomId, state);
    if (state.running) return;
    state.running = true;
    void this.reconcileRoom(event.roomId, state);
  }

  private async reconcileRoom(roomId: string, state: RoomReconciliation): Promise<void> {
    try {
      while (this.roomReconciliations.get(roomId) === state && state.signals.size > 0) {
        if (!this.peersByRoom.get(roomId)?.size) return;
        const targetRevision = Math.max(
          ...[...state.signals.values()].map((entry) => entry.event.sequence),
        );
        const room = await this.readReconciledRoom(roomId, targetRevision);

        // Peers can churn while the authoritative read is in flight. The last
        // old peer detaching removes its Set, and a replacement peer attaches
        // to a new Set, so never fan out through a pre-read Set reference.
        const peers = this.peersByRoom.get(roomId);
        if (!peers?.size) return;

        const satisfied = [...state.signals.values()].filter(
          (entry) => entry.event.sequence <= room.roomRevision,
        );
        const satisfiedCursor = satisfied.reduce<string | null>(
          (latest, entry) => laterStreamCursor(latest, entry.cursor),
          null,
        );
        for (const entry of satisfied) state.signals.delete(entry.event.id);

        for (const peer of [...peers]) {
          if (peer.disposed || !peer.ready) continue;
          if (!room.participants[peer.participantId]) {
            this.send(peer, {
              type: "error",
              error: {
                code: "FORBIDDEN",
                message: "This guest session is no longer authorized for the room.",
              },
              recoverable: false,
            });
            peer.socket.close(1008, "Room membership required");
            this.detach(peer);
            continue;
          }

          for (const entry of satisfied) rememberDelivered(peer, entry.event.id);
          const nextCursor = laterStreamCursor(peer.cursor, satisfiedCursor);
          if (room.roomRevision > peer.snapshotRevision) {
            peer.snapshotRevision = room.roomRevision;
            peer.cursor = nextCursor;
            this.send(peer, {
              type: "snapshot",
              cursor: nextCursor,
              room,
              replayTruncated: false,
            });
          } else {
            this.advancePeerCursor(peer, nextCursor);
          }
        }
      }
    } catch (error) {
      this.logger.error("Jazzboard realtime room reconciliation failed.", error);
      const peers = this.peersByRoom.get(roomId);
      for (const peer of [...(peers ?? [])]) {
        if (peer.disposed) continue;
        this.send(peer, {
          type: "error",
          error: {
            code: "SYNC_FAILED",
            message: "Jazzboard could not synchronize this room. Reconnect to try again.",
          },
          recoverable: false,
        });
        peer.socket.close(1011, "Room synchronization failed");
        this.detach(peer);
      }
    } finally {
      state.running = false;
      if (state.signals.size === 0 || !this.peersByRoom.get(roomId)?.size) {
        if (this.roomReconciliations.get(roomId) === state) {
          this.roomReconciliations.delete(roomId);
        }
      }
    }
  }

  private async readReconciledRoom(roomId: string, targetRevision: number): Promise<RoomState> {
    let lastError: unknown = new Error("Realtime room reconciliation failed.");
    for (let attempt = 0; attempt < ROOM_RECONCILIATION_ATTEMPTS; attempt += 1) {
      try {
        const room = await this.readRoomSnapshot(roomId);
        if (room && room.roomRevision >= targetRevision) return room;
        lastError = new Error(
          room
            ? `Authoritative room revision ${room.roomRevision} is behind stream revision ${targetRevision}.`
            : "The authoritative room disappeared during realtime reconciliation.",
        );
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < ROOM_RECONCILIATION_ATTEMPTS) {
        await delay(ROOM_RECONCILIATION_RETRY_MS * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private advancePeerCursor(peer: Peer, cursor: string | null): void {
    const next = laterStreamCursor(peer.cursor, cursor);
    if (!next || next === peer.cursor) return;
    peer.cursor = next;
    this.send(peer, { type: "checkpoint", cursor: next });
  }

  private send(peer: Peer, message: RealtimeServerMessage): boolean {
    if (peer.disposed || peer.socket.readyState !== SOCKET_OPEN) return false;
    if (peer.socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
      peer.socket.close(1013, "Realtime client is too slow");
      this.detach(peer);
      return false;
    }
    try {
      peer.socket.send(encodeRealtimeMessage(message));
      return true;
    } catch (error) {
      this.logger.warn("Jazzboard realtime send failed.", error);
      this.detach(peer);
      return false;
    }
  }

  private redisClient(): Redis | null {
    if (this.redis === undefined) this.redis = this.getRedis();
    return this.redis;
  }

  private ensureStreamReader(): Promise<void> {
    const redis = this.redisClient();
    if (!redis) return Promise.resolve();
    if (this.readerReady) return this.readerReady;

    const reader = redis.duplicate();
    const generation = ++this.readerGeneration;
    this.streamReader = reader;
    this.readerReady = (async () => {
      try {
        this.readerCursor = await this.readInitialStreamCursor(redis);
      } catch (error) {
        this.logger.warn("Jazzboard realtime could not establish a Redis Stream fence.", error);
        if (generation === this.readerGeneration && this.streamReader === reader) {
          this.stopStreamReader();
        }
        throw error;
      }
      if (generation === this.readerGeneration && this.streamReader === reader) {
        void this.runStreamReader(reader, generation);
      }
    })();
    return this.readerReady;
  }

  private async readInitialStreamCursor(redis: Redis): Promise<string> {
    let lastError: unknown = new Error("Redis Stream fence acquisition failed.");
    for (let attempt = 0; attempt < STREAM_FENCE_ATTEMPTS; attempt += 1) {
      try {
        return (await this.readStreamTail(redis)) ?? "0-0";
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < STREAM_FENCE_ATTEMPTS) {
        await delay(STREAM_FENCE_RETRY_MS * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private stopStreamReader(): void {
    this.readerGeneration += 1;
    const reader = this.streamReader;
    this.streamReader = null;
    this.readerReady = null;
    if (reader) reader.disconnect(false);
  }

  private async runStreamReader(reader: Redis, generation: number): Promise<void> {
    let retryMilliseconds = 200;
    while (generation === this.readerGeneration && this.streamReader === reader && this.peerCount() > 0) {
      try {
        const result: unknown = await reader.xread(
          "COUNT",
          STREAM_READ_COUNT,
          "BLOCK",
          STREAM_BLOCK_MS,
          "STREAMS",
          REALTIME_EVENT_STREAM,
          this.readerCursor,
        );
        if (generation !== this.readerGeneration || this.streamReader !== reader) return;
        const records = decodeXRead(result);
        for (const record of records) {
          this.broadcastEvent(record.event, record.cursor);
        }
        const batchCursor = latestCursorFromXRead(result);
        if (batchCursor) this.readerCursor = batchCursor;
        retryMilliseconds = 200;
      } catch (error) {
        if (generation !== this.readerGeneration || this.streamReader !== reader || this.peerCount() === 0) return;
        this.logger.warn("Jazzboard realtime Redis Stream reader will retry.", error);
        await delay(retryMilliseconds);
        retryMilliseconds = Math.min(retryMilliseconds * 2, 5_000);
      }
    }
  }

  private async readStreamTail(redis: Redis): Promise<string | null> {
    const value: unknown = await redis.xrevrange(REALTIME_EVENT_STREAM, "+", "-", "COUNT", 1);
    return latestCursorFromStreamEntries(value);
  }

}

declare global {
  var __jazzboardRealtimeHub: RealtimeHub | undefined;
}

export function getRealtimeHub(): RealtimeHub {
  globalThis.__jazzboardRealtimeHub ??= new RealtimeHub();
  return globalThis.__jazzboardRealtimeHub;
}
