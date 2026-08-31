import type { Point, RoomEvent, RoomState, Viewport } from "@/lib/domain/types";
import type { AgentCanvasDraftEvent } from "@/lib/agent-drafts/types";

import {
  encodeRealtimeMessage,
  laterStreamCursor,
  parseRealtimeServerMessage,
  parseStreamCursor,
  REALTIME_AGENT_DRAFT_CAPABILITY,
  REALTIME_PRESENCE_DELTA_CAPABILITY,
  type RealtimeConnectionStatus,
} from "./protocol";

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const DEFAULT_MIN_RECONNECT_MS = 1_000;
const DEFAULT_MAX_RECONNECT_MS = 30_000;
const RECONNECT_STABILITY_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
const MAX_REMEMBERED_EVENT_IDS = 1_024;

export type RealtimeSnapshotMetadata = {
  cursor: string | null;
  replayTruncated: boolean;
};

export type RealtimeEventMetadata = {
  cursor: string | null;
  replay: boolean;
};

export type RoomRealtimeOptions = {
  roomId: string;
  initialCursor?: string | null;
  url?: string;
  onSnapshot: (room: RoomState, metadata: RealtimeSnapshotMetadata) => void;
  onEvent: (event: RoomEvent, metadata: RealtimeEventMetadata) => void;
  onReady?: (identity: { connectionId: string; participantId: string; role: "participant" | "spectator" }) => void;
  onTransientPresence?: (presence: {
    participantId: string;
    connectionId: string;
    clientSequence: number;
    clientTime: number;
    serverTime: number;
    cursor: Point | null;
    viewport: Viewport | null;
  }) => void;
  onDraftInvalidated?: (event: AgentCanvasDraftEvent) => void;
  onStatusChange?: (status: RealtimeConnectionStatus) => void;
  onError?: (error: Error) => void;
  minReconnectMs?: number;
  maxReconnectMs?: number;
  heartbeatMs?: number;
  /** Test/local adapter seam. Cookies still follow the behavior of the supplied socket implementation. */
  webSocketFactory?: (url: string) => WebSocket;
};

export type RoomRealtimeConnection = {
  close: () => void;
  reconnect: () => void;
  requestSync: () => void;
  getCursor: () => string | null;
  getStatus: () => RealtimeConnectionStatus;
  publishTransientPresence: (presence: {
    cursor: Point | null;
    viewport: Viewport | null;
  }) => boolean;
};

function reportCallbackError(error: unknown): void {
  console.error("Jazzboard realtime callback failed.", error);
}

function invokeSafely<TArgs extends unknown[]>(callback: ((...args: TArgs) => void) | undefined, ...args: TArgs): void {
  if (!callback) return;
  try {
    callback(...args);
  } catch (error) {
    reportCallbackError(error);
  }
}

function buildRealtimeUrl(options: RoomRealtimeOptions, cursor: string | null): string | null {
  let url: URL;
  try {
    if (options.url) {
      const base = typeof window === "undefined" ? undefined : window.location.href;
      url = new URL(options.url, base);
    } else {
      if (typeof window === "undefined") return null;
      url = new URL("/api/ws", window.location.href);
    }
  } catch {
    return null;
  }

  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;

  url.searchParams.set("roomId", options.roomId);
  url.searchParams.set(
    "capabilities",
    `${REALTIME_PRESENCE_DELTA_CAPABILITY},${REALTIME_AGENT_DRAFT_CAPABILITY}`,
  );
  if (cursor) url.searchParams.set("cursor", cursor);
  else url.searchParams.delete("cursor");
  return url.toString();
}

export function connectRoomRealtime(options: RoomRealtimeOptions): RoomRealtimeConnection {
  let socket: WebSocket | null = null;
  let stopped = false;
  let status: RealtimeConnectionStatus = "closed";
  let cursor = parseStreamCursor(options.initialCursor);
  let reconnectAttempt = 0;
  let transientSequence = 0;
  let generation = 0;
  let lastServerMessageAt = 0;
  let connectedAt: number | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const deliveredIds = new Set<string>();
  const deliveredOrder: string[] = [];

  const minReconnectMs = Math.max(50, options.minReconnectMs ?? DEFAULT_MIN_RECONNECT_MS);
  const maxReconnectMs = Math.max(minReconnectMs, options.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS);
  const heartbeatMs = Math.max(1_000, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

  function setStatus(next: RealtimeConnectionStatus): void {
    if (status === next) return;
    status = next;
    invokeSafely(options.onStatusChange, status);
  }

  function updateCursor(candidate: string | null): void {
    cursor = laterStreamCursor(cursor, candidate);
  }

  function rememberEvent(eventId: string): boolean {
    if (deliveredIds.has(eventId)) return false;
    deliveredIds.add(eventId);
    deliveredOrder.push(eventId);
    while (deliveredOrder.length > MAX_REMEMBERED_EVENT_IDS) {
      const oldest = deliveredOrder.shift();
      if (oldest) deliveredIds.delete(oldest);
    }
    return true;
  }

  function clearTimers(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    reconnectTimer = null;
    heartbeatTimer = null;
  }

  function sendPing(): void {
    if (socket?.readyState !== SOCKET_OPEN) return;
    try {
      socket.send(encodeRealtimeMessage({ type: "ping", clientTime: Date.now() }));
    } catch {
      // The close/error event owns reconnect scheduling.
    }
  }

  function heartbeat(): void {
    if (socket?.readyState !== SOCKET_OPEN) return;
    if (lastServerMessageAt > 0 && Date.now() - lastServerMessageAt > heartbeatMs * 2.5) {
      socket.close(4000, "Realtime heartbeat timed out");
      return;
    }
    sendPing();
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    setStatus("reconnecting");
    const exponential = Math.min(maxReconnectMs, minReconnectMs * 2 ** reconnectAttempt);
    const jittered = Math.round(exponential * (0.8 + Math.random() * 0.4));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, jittered);
  }

  function rejectMismatchedRoom(): void {
    if (socket) socket.close(1008, "Realtime server returned a different room");
    else invokeSafely(options.onError, new Error("The realtime server returned data for a different room."));
  }

  function handleServerMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return;
    }
    const message = parseRealtimeServerMessage(decoded);
    if (!message) return;
    lastServerMessageAt = Date.now();

    switch (message.type) {
      case "ready":
        if (message.roomId !== options.roomId) {
          rejectMismatchedRoom();
          return;
        }
        connectedAt ??= Date.now();
        setStatus("connected");
        invokeSafely(options.onReady, {
          connectionId: message.connectionId,
          participantId: message.participantId,
          role: message.role,
        });
        return;
      case "snapshot":
        if (message.room.id !== options.roomId) {
          rejectMismatchedRoom();
          return;
        }
        // A snapshot is an authoritative synchronization boundary and may
        // intentionally clamp an invalid client-supplied future cursor.
        cursor = message.cursor;
        invokeSafely(options.onSnapshot, message.room, {
          cursor: message.cursor,
          replayTruncated: message.replayTruncated,
        });
        return;
      case "replay":
        if (message.event.roomId !== options.roomId) {
          rejectMismatchedRoom();
          return;
        }
        updateCursor(message.cursor);
        if (rememberEvent(message.event.id)) {
          invokeSafely(options.onEvent, message.event, { cursor: message.cursor, replay: true });
        }
        return;
      case "event":
        if (message.event.roomId !== options.roomId) {
          rejectMismatchedRoom();
          return;
        }
        updateCursor(message.cursor);
        if (rememberEvent(message.event.id)) {
          invokeSafely(options.onEvent, message.event, { cursor: message.cursor, replay: false });
        }
        return;
      case "checkpoint":
        updateCursor(message.cursor);
        return;
      case "error":
        invokeSafely(options.onError, new Error(message.error.message));
        return;
      case "pong":
        return;
      case "presence.transient":
        if (message.roomId !== options.roomId) {
          rejectMismatchedRoom();
          return;
        }
        invokeSafely(options.onTransientPresence, {
          participantId: message.participantId,
          connectionId: message.connectionId,
          clientSequence: message.clientSequence,
          clientTime: message.clientTime,
          serverTime: message.serverTime,
          cursor: message.cursor,
          viewport: message.viewport,
        });
        return;
      case "draft.invalidated":
        if (message.event.roomId !== options.roomId) {
          rejectMismatchedRoom();
          return;
        }
        updateCursor(message.cursor);
        if (rememberEvent(message.event.id)) {
          invokeSafely(options.onDraftInvalidated, message.event);
        }
        return;
    }
  }

  function openSocket(): void {
    if (stopped) return;
    const url = buildRealtimeUrl(options, cursor);
    const factory =
      options.webSocketFactory ??
      (typeof WebSocket === "undefined" ? null : (socketUrl: string) => new WebSocket(socketUrl));
    if (!url || !factory) {
      setStatus("unavailable");
      return;
    }

    const currentGeneration = ++generation;
    connectedAt = null;
    setStatus(reconnectAttempt > 0 ? "reconnecting" : "connecting");
    try {
      socket = factory(url);
    } catch (error) {
      invokeSafely(options.onError, error instanceof Error ? error : new Error("Realtime connection failed."));
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      if (stopped || currentGeneration !== generation) return;
      lastServerMessageAt = Date.now();
      heartbeatTimer = setInterval(heartbeat, heartbeatMs);
      sendPing();
    });
    socket.addEventListener("message", (event) => {
      if (stopped || currentGeneration !== generation) return;
      handleServerMessage(event.data);
    });
    socket.addEventListener("error", () => {
      if (stopped || currentGeneration !== generation) return;
      invokeSafely(options.onError, new Error("The Jazzboard realtime connection encountered an error."));
    });
    socket.addEventListener("close", (event) => {
      if (currentGeneration !== generation) return;
      const wasStable = connectedAt !== null && Date.now() - connectedAt >= RECONNECT_STABILITY_MS;
      connectedAt = null;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      socket = null;
      if (stopped) {
        setStatus("closed");
        return;
      }
      if (event.code === 1008) {
        invokeSafely(options.onError, new Error(event.reason || "This session may not connect to the room."));
        setStatus("closed");
        return;
      }
      if (wasStable) reconnectAttempt = 0;
      scheduleReconnect();
    });
  }

  function close(): void {
    if (stopped) return;
    stopped = true;
    generation += 1;
    clearTimers();
    const activeSocket = socket;
    socket = null;
    connectedAt = null;
    if (activeSocket && (activeSocket.readyState === SOCKET_OPEN || activeSocket.readyState === SOCKET_CONNECTING)) {
      activeSocket.close(1000, "Realtime client closed");
    }
    setStatus("closed");
  }

  function reconnect(): void {
    if (stopped) return;
    generation += 1;
    clearTimers();
    const activeSocket = socket;
    socket = null;
    connectedAt = null;
    activeSocket?.close(1000, "Realtime client reconnecting");
    reconnectAttempt = 0;
    openSocket();
  }

  function requestSync(): void {
    if (socket?.readyState !== SOCKET_OPEN) return;
    try {
      socket.send(
        encodeRealtimeMessage({
          type: "sync.request",
          ...(cursor ? { cursor } : {}),
        }),
      );
    } catch {
      // The close/error event owns reconnect scheduling.
    }
  }

  function publishTransientPresence(presence: {
    cursor: Point | null;
    viewport: Viewport | null;
  }): boolean {
    if (socket?.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(
        encodeRealtimeMessage({
          type: "presence.transient",
          clientSequence: ++transientSequence,
          clientTime: Date.now(),
          cursor: presence.cursor,
          viewport: presence.viewport,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  openSocket();

  return {
    close,
    reconnect,
    requestSync,
    publishTransientPresence,
    getCursor: () => cursor,
    getStatus: () => status,
  };
}
