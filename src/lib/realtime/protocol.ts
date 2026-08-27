import type { Point, RoomEvent, RoomRole, RoomState, Viewport } from "@/lib/domain/types";

import {
  isCompactRoomEventPayload,
  isLegacyRoomEventPayload,
  isPresenceDeltaRoomEventPayload,
} from "./events";

export const REALTIME_PROTOCOL_VERSION = 1 as const;
export const REALTIME_PRESENCE_DELTA_CAPABILITY = "presence-delta-v1" as const;
export const SPLIT_STATE_CLIENT_CAPABILITY = "split-state-v1" as const;
export const CLIENT_CAPABILITIES_HEADER = "x-jazzboard-client-capabilities" as const;
export const REALTIME_MAX_CLIENT_PAYLOAD_BYTES = 32 * 1024;
export const REALTIME_EVENT_STREAM = "jazzboard:events";

const STREAM_CURSOR_PATTERN = /^(?:0|[1-9]\d*)-(?:0|[1-9]\d*)$/;

export type RealtimeConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "unavailable"
  | "closed";

export type RealtimeClientMessage =
  | { type: "ping"; clientTime?: number }
  | { type: "sync.request"; cursor?: string }
  | {
      type: "presence.transient";
      clientSequence: number;
      clientTime: number;
      cursor: Point | null;
      viewport: Viewport | null;
    };

export type RealtimeServerMessage =
  | {
      type: "ready";
      protocol: typeof REALTIME_PROTOCOL_VERSION;
      connectionId: string;
      roomId: string;
      participantId: string;
      role: RoomRole;
      serverTime: number;
    }
  | {
      type: "replay";
      cursor: string;
      event: RoomEvent;
    }
  | {
      type: "snapshot";
      cursor: string | null;
      room: RoomState;
      replayTruncated: boolean;
    }
  | {
      type: "event";
      cursor: string | null;
      event: RoomEvent;
    }
  | {
      type: "checkpoint";
      cursor: string;
    }
  | {
      type: "pong";
      clientTime: number | null;
      serverTime: number;
    }
  | {
      type: "presence.transient";
      roomId: string;
      participantId: string;
      connectionId: string;
      clientSequence: number;
      clientTime: number;
      serverTime: number;
      cursor: Point | null;
      viewport: Viewport | null;
    }
  | {
      type: "error";
      error: {
        code: "INVALID_MESSAGE" | "SYNC_FAILED" | "FORBIDDEN";
        message: string;
      };
      recoverable: boolean;
    };

export function parseStreamCursor(value: string | null | undefined): string | null {
  if (!value || value.length > 64 || !STREAM_CURSOR_PATTERN.test(value)) return null;
  return value;
}

export function compareStreamCursors(left: string, right: string): number {
  const [leftTime, leftSequence] = left.split("-").map(BigInt);
  const [rightTime, rightSequence] = right.split("-").map(BigInt);
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  if (leftSequence === rightSequence) return 0;
  return leftSequence < rightSequence ? -1 : 1;
}

export function laterStreamCursor(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (!current || compareStreamCursors(candidate, current) > 0) return candidate;
  return current;
}

export function parseRealtimeClientMessage(value: unknown): RealtimeClientMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;

  if (message.type === "ping") {
    if (message.clientTime !== undefined && !Number.isFinite(message.clientTime)) return null;
    return {
      type: "ping",
      ...(message.clientTime === undefined ? {} : { clientTime: Number(message.clientTime) }),
    };
  }

  if (message.type === "sync.request") {
    if (message.cursor !== undefined && parseStreamCursor(String(message.cursor)) === null) return null;
    return {
      type: "sync.request",
      ...(message.cursor === undefined ? {} : { cursor: String(message.cursor) }),
    };
  }

  if (message.type === "presence.transient") {
    if (
      !validSequence(message.clientSequence) ||
      typeof message.clientTime !== "number" ||
      !Number.isFinite(message.clientTime) ||
      !nullablePoint(message.cursor) ||
      !nullableViewport(message.viewport)
    ) {
      return null;
    }
    return message as RealtimeClientMessage;
  }

  return null;
}

function validSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function point(value: unknown): value is Point {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.x === "number" &&
    Number.isFinite(candidate.x) &&
    typeof candidate.y === "number" &&
    Number.isFinite(candidate.y)
  );
}

function nullablePoint(value: unknown): value is Point | null {
  return value === null || point(value);
}

function nullableViewport(value: unknown): value is Viewport | null {
  if (value === null) return true;
  if (!point(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.zoom === "number" &&
    Number.isFinite(candidate.zoom) &&
    candidate.zoom > 0 &&
    typeof candidate.width === "number" &&
    Number.isFinite(candidate.width) &&
    candidate.width > 0 &&
    typeof candidate.height === "number" &&
    Number.isFinite(candidate.height) &&
    candidate.height > 0
  );
}

export function isRoomEvent(value: unknown): value is RoomEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    typeof event.roomId === "string" &&
    typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence >= 0 &&
    typeof event.occurredAt === "number" &&
    Number.isFinite(event.occurredAt) &&
    typeof event.type === "string" &&
    [
      "room.snapshot",
      "room.updated",
      "presence.updated",
      "agent.activity",
      "lease.updated",
      "spotlight.updated",
    ].includes(event.type) &&
    (isCompactRoomEventPayload(event.payload, event.sequence) ||
      isPresenceDeltaRoomEventPayload(event.payload, String(event.roomId), event.sequence) ||
      isLegacyRoomEventPayload(event.payload, event.roomId, event.sequence))
  );
}

export function parseRealtimeServerMessage(value: unknown): RealtimeServerMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;

  switch (message.type) {
    case "ready":
      if (
        message.protocol !== REALTIME_PROTOCOL_VERSION ||
        typeof message.connectionId !== "string" ||
        typeof message.roomId !== "string" ||
        typeof message.participantId !== "string" ||
        (message.role !== "participant" && message.role !== "spectator") ||
        typeof message.serverTime !== "number"
      ) {
        return null;
      }
      return message as RealtimeServerMessage;
    case "replay":
      if (parseStreamCursor(message.cursor as string) === null || !isRoomEvent(message.event)) return null;
      return message as RealtimeServerMessage;
    case "snapshot": {
      const cursor = message.cursor;
      if (cursor !== null && parseStreamCursor(cursor as string) === null) return null;
      if (!message.room || typeof message.room !== "object" || typeof message.replayTruncated !== "boolean") {
        return null;
      }
      return message as RealtimeServerMessage;
    }
    case "event": {
      const cursor = message.cursor;
      if (cursor !== null && parseStreamCursor(cursor as string) === null) return null;
      if (!isRoomEvent(message.event)) return null;
      return message as RealtimeServerMessage;
    }
    case "checkpoint":
      if (parseStreamCursor(message.cursor as string) === null) return null;
      return message as RealtimeServerMessage;
    case "pong":
      if (
        (message.clientTime !== null && typeof message.clientTime !== "number") ||
        typeof message.serverTime !== "number"
      ) {
        return null;
      }
      return message as RealtimeServerMessage;
    case "presence.transient":
      if (
        typeof message.roomId !== "string" ||
        typeof message.participantId !== "string" ||
        typeof message.connectionId !== "string" ||
        !validSequence(message.clientSequence) ||
        typeof message.clientTime !== "number" ||
        !Number.isFinite(message.clientTime) ||
        typeof message.serverTime !== "number" ||
        !Number.isFinite(message.serverTime) ||
        !nullablePoint(message.cursor) ||
        !nullableViewport(message.viewport)
      ) {
        return null;
      }
      return message as RealtimeServerMessage;
    case "error":
      if (
        !message.error ||
        typeof message.error !== "object" ||
        typeof (message.error as Record<string, unknown>).code !== "string" ||
        typeof (message.error as Record<string, unknown>).message !== "string" ||
        typeof message.recoverable !== "boolean"
      ) {
        return null;
      }
      return message as RealtimeServerMessage;
    default:
      return null;
  }
}

export function encodeRealtimeMessage(message: RealtimeServerMessage | RealtimeClientMessage): string {
  return JSON.stringify(message);
}
