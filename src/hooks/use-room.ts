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
  RoomPresenceDelta,
  RoomState,
  SemanticTransaction,
  Viewport,
  AgentActivity,
} from "@/lib/domain/types";
import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import { reconcileRoomSnapshot } from "@/lib/client/room-reconciliation";
import {
  connectRoomRealtime,
  type RoomRealtimeConnection,
} from "@/lib/realtime/client";
import {
  applyPresenceDelta,
  legacyRoomStateFromEvent,
  presenceDeltaFromEvent,
  roomStateRevision,
} from "@/lib/realtime/events";

export type ConnectionState = "connecting" | "live" | "polling" | "offline";

export function applyTransientHumanPresence(
  room: RoomState,
  participantId: string,
  cursor: Point | null,
  viewport: Viewport | null,
): RoomState {
  const participant = room.participants[participantId];
  if (!participant) return room;
  return {
    ...room,
    participants: {
      ...room.participants,
      [participantId]: {
        ...participant,
        human: {
          ...participant.human,
          cursor: cursor ? { ...cursor } : null,
          viewport: viewport ? { ...viewport } : null,
        },
      },
    },
  };
}

export type LeaseAction =
  | { action: "acquire"; objectId: string; expectedRevision: number; operation: LeaseOperation }
  | { action: "renew" | "release"; objectId: string; leaseId: string };

export type LeaseBatchAction =
  | {
      action: "acquire-many";
      targets: Array<{ objectId: string; expectedRevision: number; operation: LeaseOperation }>;
    }
  | {
      action: "renew-many" | "release-many";
      targets: Array<{ objectId: string; leaseId: string }>;
    };

type RoomResponse = { ok: true; room: RoomState; participantId?: string };
type PresenceResponse = { ok: true; presence: RoomPresenceDelta };

type RoomVisit = {
  roomId: string;
};

type ScopedValue<T> = {
  visit: RoomVisit;
  value: T;
};

/** Compares aggregate state revisions; roomRevision remains document-only. */
export function shouldAcceptRoomRevision(currentRevision: number | null, nextRevision: number): boolean {
  return currentRevision === null || nextRevision > currentRevision;
}

export { reconcileRoomSnapshot } from "@/lib/client/room-reconciliation";

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
  const connectionRef = useRef<ConnectionState>("connecting");
  const realtimeRef = useRef<RoomRealtimeConnection | null>(null);
  const transientPresenceRef = useRef(
    new Map<
      string,
      {
        connectionId: string;
        clientSequence: number;
        serverTime: number;
        cursor: Point | null;
        viewport: Viewport | null;
      }
    >(),
  );
  const roomVisitRef = useRef<RoomVisit | null>(roomVisit);
  const refreshGenerationRef = useRef(0);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const eventRefreshRef = useRef<{
    visit: RoomVisit;
    running: boolean;
    targetRevision: number | null;
  } | null>(null);

  const projectTransientPresence = useCallback((next: RoomState): RoomState => {
    let projected = next;
    for (const [participantId, transient] of transientPresenceRef.current) {
      const participant = projected.participants[participantId];
      if (!participant) {
        transientPresenceRef.current.delete(participantId);
        continue;
      }
      if (participant.human.lastSeenAt >= transient.serverTime) {
        transientPresenceRef.current.delete(participantId);
        continue;
      }
      projected = applyTransientHumanPresence(
        projected,
        participantId,
        transient.cursor,
        transient.viewport,
      );
    }
    return projected;
  }, []);

  const acceptRoom = useCallback((next: RoomState) => {
    const activeVisit = roomVisitRef.current;
    if (!activeVisit || next.id !== activeVisit.roomId) return false;
    const current = roomRef.current?.id === next.id ? roomRef.current : null;
    const reconciled = reconcileRoomSnapshot(current, next);
    if (!reconciled) return false;
    const projected = projectTransientPresence(reconciled);
    roomRef.current = projected;
    setRoomState({ visit: activeVisit, value: projected });
    return true;
  }, [projectTransientPresence]);

  const acceptPresence = useCallback((delta: RoomPresenceDelta) => {
    const activeVisit = roomVisitRef.current;
    const current = roomRef.current;
    if (!activeVisit || delta.roomId !== activeVisit.roomId || !current) return false;
    if (roomStateRevision(current) >= delta.stateRevision) return true;
    const next = applyPresenceDelta(current, delta);
    if (!next) return false;
    const projected = projectTransientPresence(next);
    roomRef.current = projected;
    setRoomState({ visit: activeVisit, value: projected });
    return true;
  }, [projectTransientPresence]);

  const acceptTransientPresence = useCallback((transient: {
    participantId: string;
    connectionId: string;
    clientSequence: number;
    serverTime: number;
    cursor: Point | null;
    viewport: Viewport | null;
  }) => {
    const activeVisit = roomVisitRef.current;
    const current = roomRef.current;
    if (!activeVisit || !current?.participants[transient.participantId]) return;
    const previous = transientPresenceRef.current.get(transient.participantId);
    if (
      previous &&
      ((previous.connectionId === transient.connectionId &&
        previous.clientSequence >= transient.clientSequence) ||
        previous.serverTime > transient.serverTime)
    ) {
      return;
    }
    transientPresenceRef.current.set(transient.participantId, transient);
    const projected = applyTransientHumanPresence(
      current,
      transient.participantId,
      transient.cursor,
      transient.viewport,
    );
    roomRef.current = projected;
    setRoomState({ visit: activeVisit, value: projected });
  }, []);

  const setConnection: Dispatch<SetStateAction<ConnectionState>> = useCallback((next) => {
    const activeVisit = roomVisitRef.current;
    if (!activeVisit) return;
    setConnectionState((current) => {
      const currentValue = current.visit === activeVisit ? current.value : "connecting";
      const value = typeof next === "function" ? next(currentValue) : next;
      connectionRef.current = value;
      return {
        visit: activeVisit,
        value,
      };
    });
  }, []);

  useEffect(() => {
    const transientCache = transientPresenceRef.current;
    roomVisitRef.current = roomVisit;
    refreshGenerationRef.current += 1;
    roomRef.current = null;
    connectionRef.current = "connecting";
    transientCache.clear();

    return () => {
      roomVisitRef.current = null;
      refreshGenerationRef.current += 1;
      realtimeRef.current = null;
      transientCache.clear();
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
        setConnectionState((current) => {
          const value =
            current.visit === requestVisit && current.value === "live" ? "live" : "polling";
          connectionRef.current = value;
          return { visit: requestVisit, value };
        });
        setRoomError({ visit: requestVisit, value: null });
      }
      return response.room;
    } catch (nextError) {
      if (
        requestVisit === roomVisitRef.current &&
        requestGeneration === refreshGenerationRef.current
      ) {
        connectionRef.current = "offline";
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

  const requestEventRefresh = useCallback((targetRevision: number) => {
    if (roomVisitRef.current !== roomVisit) return;
    if (roomRef.current && roomStateRevision(roomRef.current) >= targetRevision) return;
    let state = eventRefreshRef.current;
    if (!state || state.visit !== roomVisit) {
      state = { visit: roomVisit, running: false, targetRevision: null };
      eventRefreshRef.current = state;
    }
    state.targetRevision = Math.max(state.targetRevision ?? -1, targetRevision);
    if (state.running) return;
    state.running = true;

    void (async () => {
      try {
        // One authoritative read normally covers every signal that arrived
        // while it was in flight. Permit one trailing read for the narrow race
        // where a newer commit lands after that read, then let normal polling
        // recover transient failures without a tight retry loop.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (roomVisitRef.current !== roomVisit || state.targetRevision === null) return;
          const requiredRevision = state.targetRevision;
          state.targetRevision = null;
          try {
            const nextRoom = await refresh();
            const latestRequired = Math.max(requiredRevision, state.targetRevision ?? -1);
            if (roomStateRevision(nextRoom) < latestRequired) {
              state.targetRevision = latestRequired;
              continue;
            }
            state.targetRevision = null;
          } catch {
            state.targetRevision = Math.max(requiredRevision, state.targetRevision ?? -1);
            return;
          }
        }
      } finally {
        state.running = false;
      }
    })();
  }, [refresh, roomVisit]);

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
      if (connectionRef.current !== "live") runAutomaticRefresh();
    });
    const initialRefresh = window.setTimeout(() => {
      runAutomaticRefresh();
    }, 0);
    const poll = window.setInterval(() => {
      if (
        document.visibilityState !== "hidden" &&
        connectionRef.current !== "live"
      ) {
        runAutomaticRefresh();
      }
    }, 5_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") return;
      if (connectionRef.current === "live") realtimeRef.current?.requestSync();
      else runAutomaticRefresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearTimeout(initialRefresh);
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisibilityChange);
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
        const presenceDelta = presenceDeltaFromEvent(event);
        if (presenceDelta) {
          if (!acceptPresence(presenceDelta)) requestEventRefresh(event.sequence);
          return;
        }
        const nextRoom = legacyRoomStateFromEvent(event);
        if (nextRoom) acceptRoom(nextRoom);
        requestEventRefresh(event.sequence);
      },
      onTransientPresence(transient) {
        if (connectionVisit !== roomVisitRef.current) return;
        acceptTransientPresence(transient);
      },
      onStatusChange(status) {
        if (connectionVisit !== roomVisitRef.current) return;
        refreshGenerationRef.current += 1;
        if (status === "connected") setConnection("live");
        else if (status === "unavailable" || status === "closed") setConnection("polling");
        else setConnection(roomRef.current ? "polling" : "connecting");
      },
    });
    realtimeRef.current = realtime;
    return () => {
      if (realtimeRef.current === realtime) realtimeRef.current = null;
      realtime.close();
    };
  }, [acceptPresence, acceptRoom, acceptTransientPresence, requestEventRefresh, roomId, roomVisit, setConnection]);

  const transientPresence = useCallback(
    (value: { cursor: Point | null; viewport: Viewport | null }) =>
      realtimeRef.current?.publishTransientPresence(value) ?? false,
    [],
  );

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

  const leaseMany = useCallback(
    async (leaseAction: LeaseBatchAction, actorKind: ActorKind = "human") => {
      const endpoint = actorKind === "agent" ? "agent/leases" : "leases";
      const response = await apiRequest<RoomResponse & { leases: ObjectLease[] }>(
        `/api/rooms/${roomId}/${endpoint}`,
        { method: "POST", body: JSON.stringify(leaseAction) },
      );
      acceptRoom(response.room);
      announceChange();
      return { leases: response.leases, room: response.room };
    },
    [acceptRoom, announceChange, roomId],
  );

  const presence = useCallback(
    async (
      value: { cursor: Point | null; viewport: Viewport | null; activity?: AgentActivity | null },
      actorKind: ActorKind = "human",
    ) => {
      const endpoint = actorKind === "agent" ? "agent/presence" : "presence";
      const response = await apiRequest<PresenceResponse>(`/api/rooms/${roomId}/${endpoint}`, {
        method: "POST",
        headers: { "x-jazzboard-presence-protocol": "delta-v1" },
        body: JSON.stringify({ ...value, activity: value.activity ?? null }),
      });
      if (!acceptPresence(response.presence)) {
        requestEventRefresh(response.presence.stateRevision);
      }
      return response.presence;
    },
    [acceptPresence, requestEventRefresh, roomId],
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

  const renameRoom = useCallback(async (title: string, expectedTitle: string) => {
    const response = await apiRequest<RoomResponse>(`/api/rooms/${roomId}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "rename", title, expectedTitle }),
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
    leaseMany,
    presence,
    transientPresence,
    semanticTransaction,
    spotlight,
    renameRoom,
    upgradeRole,
    acceptRoom,
    setConnection,
  };
}
