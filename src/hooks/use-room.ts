"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ActorKind,
  CanvasCommand,
  LeaseOperation,
  ObjectLease,
  Point,
  RoomState,
  SemanticTransaction,
  Viewport,
  AgentActivity,
  RoomEvent,
} from "@/lib/domain/types";
import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import { connectRoomRealtime } from "@/lib/realtime/client";

export type ConnectionState = "connecting" | "live" | "polling" | "offline";

export type LeaseAction =
  | { action: "acquire"; objectId: string; expectedRevision: number; operation: LeaseOperation }
  | { action: "renew" | "release"; objectId: string; leaseId: string };

type RoomResponse = { ok: true; room: RoomState; participantId?: string };

function roomFromEvent(event: RoomEvent): RoomState | null {
  if (!event.payload || typeof event.payload !== "object" || !("room" in event.payload)) return null;
  const candidate = (event.payload as { room?: unknown }).room;
  if (!candidate || typeof candidate !== "object") return null;
  const room = candidate as Partial<RoomState>;
  return typeof room.id === "string" && typeof room.roomRevision === "number" ? (candidate as RoomState) : null;
}

export function useRoom(roomId: string) {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<JazzboardApiError | Error | null>(null);
  const roomRef = useRef<RoomState | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const acceptRoom = useCallback((next: RoomState) => {
    if (!roomRef.current || next.roomRevision >= roomRef.current.roomRevision) {
      roomRef.current = next;
      setRoom(next);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await apiRequest<RoomResponse>(`/api/rooms/${roomId}`);
      acceptRoom(response.room);
      if (response.participantId) setParticipantId(response.participantId);
      setConnection((current) => (current === "live" ? current : "polling"));
      setError(null);
      return response.room;
    } catch (nextError) {
      setConnection("offline");
      setError(nextError as Error);
      throw nextError;
    }
  }, [acceptRoom, roomId]);

  const announceChange = useCallback(() => {
    channelRef.current?.postMessage({ type: "room.changed", roomId });
  }, [roomId]);

  useEffect(() => {
    let cancelled = false;
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`jazzboard:${roomId}`);
    channelRef.current = channel;
    channel?.addEventListener("message", () => {
      if (!cancelled) void refresh().catch(() => undefined);
    });
    const initialRefresh = window.setTimeout(() => {
      if (!cancelled) void refresh().catch(() => undefined);
    }, 0);
    const poll = window.setInterval(() => {
      if (!cancelled && document.visibilityState !== "hidden") void refresh().catch(() => undefined);
    }, 1_200);
    return () => {
      cancelled = true;
      window.clearTimeout(initialRefresh);
      window.clearInterval(poll);
      channel?.close();
      channelRef.current = null;
    };
  }, [refresh, roomId]);

  useEffect(() => {
    const realtime = connectRoomRealtime({
      roomId,
      onSnapshot(nextRoom) {
        acceptRoom(nextRoom);
      },
      onEvent(event) {
        const nextRoom = roomFromEvent(event);
        if (nextRoom) acceptRoom(nextRoom);
      },
      onStatusChange(status) {
        if (status === "connected") setConnection("live");
        else if (status === "unavailable" || status === "closed") setConnection("polling");
        else setConnection(roomRef.current ? "polling" : "connecting");
      },
    });
    return () => realtime.close();
  }, [acceptRoom, roomId]);

  const command = useCallback(
    async (canvasCommand: CanvasCommand, actorKind: ActorKind = "human") => {
      const endpoint = actorKind === "agent" ? "agent/commands" : "commands";
      const response = await apiRequest<RoomResponse & { changedObjectIds: string[] }>(
        `/api/rooms/${roomId}/${endpoint}`,
        { method: "POST", body: JSON.stringify({ command: canvasCommand }) },
      );
      acceptRoom(response.room);
      announceChange();
      return response;
    },
    [acceptRoom, announceChange, roomId],
  );

  const lease = useCallback(
    async (leaseAction: LeaseAction, actorKind: ActorKind = "human") => {
      const endpoint = actorKind === "agent" ? "agent/leases" : "leases";
      const response = await apiRequest<RoomResponse & { lease: ObjectLease | null }>(
        `/api/rooms/${roomId}/${endpoint}`,
        { method: "POST", body: JSON.stringify(leaseAction) },
      );
      acceptRoom(response.room);
      announceChange();
      return response.lease;
    },
    [acceptRoom, announceChange, roomId],
  );

  const presence = useCallback(
    async (
      value: { cursor: Point | null; viewport: Viewport | null; activity?: AgentActivity | null },
      actorKind: ActorKind = "human",
    ) => {
      const endpoint = actorKind === "agent" ? "agent/presence" : "presence";
      const response = await apiRequest<RoomResponse>(`/api/rooms/${roomId}/${endpoint}`, {
        method: "POST",
        body: JSON.stringify({ ...value, activity: value.activity ?? null }),
      });
      acceptRoom(response.room);
      announceChange();
      return response.room;
    },
    [acceptRoom, announceChange, roomId],
  );

  const spotlight = useCallback(
    async (
      value:
        | { action: "start" | "request"; target: ActorKind }
        | { action: "stop" | "handoff" | "dismiss_request" | "join" | "leave" },
    ) => {
      const response = await apiRequest<RoomResponse>(`/api/rooms/${roomId}/spotlight`, {
        method: "POST",
        body: JSON.stringify(value),
      });
      acceptRoom(response.room);
      announceChange();
      return response.room;
    },
    [acceptRoom, announceChange, roomId],
  );

  const semanticTransaction = useCallback(
    async (transaction: SemanticTransaction) => {
      const response = await apiRequest<
        RoomResponse & {
          changedObjectIds: string[];
          changedDiagramIds: string[];
          membershipObjectIds: string[];
        }
      >(`/api/rooms/${roomId}/semantic`, {
        method: "POST",
        body: JSON.stringify({ action: "transaction", transaction }),
      });
      acceptRoom(response.room);
      announceChange();
      return response;
    },
    [acceptRoom, announceChange, roomId],
  );

  const upgradeRole = useCallback(async () => {
    const response = await apiRequest<RoomResponse>(`/api/rooms/${roomId}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "upgrade_role" }),
    });
    acceptRoom(response.room);
    announceChange();
    return response.room;
  }, [acceptRoom, announceChange, roomId]);

  const self = useMemo(
    () => (room && participantId ? room.participants[participantId] ?? null : null),
    [participantId, room],
  );

  return {
    room,
    participantId,
    self,
    connection,
    error,
    refresh,
    command,
    lease,
    presence,
    semanticTransaction,
    spotlight,
    upgradeRole,
    acceptRoom,
    setConnection,
  };
}
