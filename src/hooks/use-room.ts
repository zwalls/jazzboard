"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

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

type RoomVisit = {
  roomId: string;
};

type ScopedValue<T> = {
  visit: RoomVisit;
  value: T;
};

function roomFromEvent(event: RoomEvent): RoomState | null {
  if (!event.payload || typeof event.payload !== "object" || !("room" in event.payload)) return null;
  const candidate = (event.payload as { room?: unknown }).room;
  if (!candidate || typeof candidate !== "object") return null;
  const room = candidate as Partial<RoomState>;
  return typeof room.id === "string" && typeof room.roomRevision === "number" ? (candidate as RoomState) : null;
}

export function shouldAcceptRoomRevision(currentRevision: number | null, nextRevision: number): boolean {
  return currentRevision === null || nextRevision > currentRevision;
}

export function useRoom(roomId: string) {
  const roomVisit = useMemo<RoomVisit>(() => ({ roomId }), [roomId]);
  const [roomState, setRoomState] = useState<ScopedValue<RoomState | null>>({
    visit: roomVisit,
    value: null,
  });
  const [participant, setParticipant] = useState<ScopedValue<string | null>>({
    visit: roomVisit,
    value: null,
  });
  const [connectionState, setConnectionState] = useState<ScopedValue<ConnectionState>>({
    visit: roomVisit,
    value: "connecting",
  });
  const [roomError, setRoomError] = useState<ScopedValue<JazzboardApiError | Error | null>>({
    visit: roomVisit,
    value: null,
  });
  const roomRef = useRef<RoomState | null>(null);
  const roomVisitRef = useRef<RoomVisit | null>(roomVisit);
  const refreshGenerationRef = useRef(0);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const acceptRoom = useCallback((next: RoomState) => {
    const activeVisit = roomVisitRef.current;
    if (!activeVisit || next.id !== activeVisit.roomId) return false;
    const currentRevision = roomRef.current?.id === next.id ? roomRef.current.roomRevision : null;
    if (shouldAcceptRoomRevision(currentRevision, next.roomRevision)) {
      roomRef.current = next;
      setRoomState({ visit: activeVisit, value: next });
      return true;
    }
    return false;
  }, []);

  const setConnection: Dispatch<SetStateAction<ConnectionState>> = useCallback((next) => {
    const activeVisit = roomVisitRef.current;
    if (!activeVisit) return;
    setConnectionState((current) => {
      const currentValue = current.visit === activeVisit ? current.value : "connecting";
      return {
        visit: activeVisit,
        value: typeof next === "function" ? next(currentValue) : next,
      };
    });
  }, []);

  useEffect(() => {
    roomVisitRef.current = roomVisit;
    refreshGenerationRef.current += 1;
    roomRef.current = null;

    return () => {
      roomVisitRef.current = null;
      refreshGenerationRef.current += 1;
    };
  }, [roomVisit]);

  const refresh = useCallback(async () => {
    const requestRoomId = roomId;
    const requestVisit = roomVisit;
    const requestGeneration = ++refreshGenerationRef.current;
    try {
      const response = await apiRequest<RoomResponse>(`/api/rooms/${roomId}`);
      const matchesActiveRoom =
        requestVisit === roomVisitRef.current &&
        response.room.id === requestRoomId;
      if (matchesActiveRoom) acceptRoom(response.room);
      if (matchesActiveRoom && response.participantId) {
        setParticipant((current) => {
          if (
            current.visit === requestVisit &&
            current.value !== null &&
            requestGeneration !== refreshGenerationRef.current
          ) {
            return current;
          }
          return { visit: requestVisit, value: response.participantId ?? null };
        });
      }
      if (matchesActiveRoom && requestGeneration === refreshGenerationRef.current) {
        setConnectionState((current) => ({
          visit: requestVisit,
          value:
            current.visit === requestVisit && current.value === "live" ? "live" : "polling",
        }));
        setRoomError({ visit: requestVisit, value: null });
      }
      return response.room;
    } catch (nextError) {
      if (
        requestVisit === roomVisitRef.current &&
        requestGeneration === refreshGenerationRef.current
      ) {
        setConnectionState({ visit: requestVisit, value: "offline" });
        setRoomError({ visit: requestVisit, value: nextError as Error });
      }
      throw nextError;
    }
  }, [acceptRoom, roomId, roomVisit]);

  const announceChange = useCallback(() => {
    if (roomVisitRef.current !== roomVisit) return;
    channelRef.current?.postMessage({ type: "room.changed", roomId });
  }, [roomId, roomVisit]);

  useEffect(() => {
    let cancelled = false;
    let automaticRefreshPending = false;
    const runAutomaticRefresh = () => {
      if (cancelled || automaticRefreshPending) return;
      automaticRefreshPending = true;
      void refresh()
        .catch(() => undefined)
        .finally(() => {
          automaticRefreshPending = false;
        });
    };
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`jazzboard:${roomId}`);
    channelRef.current = channel;
    channel?.addEventListener("message", () => {
      runAutomaticRefresh();
    });
    const initialRefresh = window.setTimeout(() => {
      runAutomaticRefresh();
    }, 0);
    const poll = window.setInterval(() => {
      if (document.visibilityState !== "hidden") runAutomaticRefresh();
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
    const connectionVisit = roomVisit;
    const realtime = connectRoomRealtime({
      roomId,
      onSnapshot(nextRoom) {
        if (connectionVisit !== roomVisitRef.current) return;
        acceptRoom(nextRoom);
      },
      onEvent(event) {
        if (connectionVisit !== roomVisitRef.current) return;
        const nextRoom = roomFromEvent(event);
        if (nextRoom) acceptRoom(nextRoom);
      },
      onStatusChange(status) {
        if (connectionVisit !== roomVisitRef.current) return;
        refreshGenerationRef.current += 1;
        if (status === "connected") setConnection("live");
        else if (status === "unavailable" || status === "closed") setConnection("polling");
        else setConnection(roomRef.current ? "polling" : "connecting");
      },
    });
    return () => realtime.close();
  }, [acceptRoom, roomId, roomVisit, setConnection]);

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
      return { lease: response.lease, room: response.room };
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

  const visibleRoom = roomState.visit === roomVisit ? roomState.value : null;
  const participantId = participant.visit === roomVisit ? participant.value : null;
  const connection = connectionState.visit === roomVisit ? connectionState.value : "connecting";
  const error = roomError.visit === roomVisit ? roomError.value : null;
  const self = useMemo(
    () => (visibleRoom && participantId ? visibleRoom.participants[participantId] ?? null : null),
    [participantId, visibleRoom],
  );

  return {
    room: visibleRoom,
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
