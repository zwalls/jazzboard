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
import type {
  AgentCanvasDraftEvent,
  AgentCanvasDraftListResult,
  AgentCanvasDraftSnapshot,
} from "@/lib/agent-drafts/types";
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
type DraftListResponse = { ok: true } & AgentCanvasDraftListResult;

type RoomVisit = {
  roomId: string;
};

type ScopedValue<T> = {
  visit: RoomVisit;
  value: T;
};

type DraftRefreshState = {
  visit: RoomVisit;
  running: boolean;
  queued: boolean;
};

const REALTIME_FALLBACK_GRACE_MS = 5_000;
const ROOM_FALLBACK_POLL_MS = 5_000;
const ACTIVE_DRAFT_FALLBACK_POLL_MS = 2_000;
const IDLE_DRAFT_FALLBACK_POLL_MS = 30_000;
const FAILED_DRAFT_RETRY_MS = 30_000;

type DeferredCommittedDraftRemoval = {
  firstFrame: number;
  secondFrame: number | null;
  visit: RoomVisit;
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
  const [draftState, setDraftState] = useState<ScopedValue<AgentCanvasDraftSnapshot[]>>({
    visit: roomVisit,
    value: [],
  });
  const [initialDraftIdsState, setInitialDraftIdsState] = useState<ScopedValue<string[]>>({
    visit: roomVisit,
    value: [],
  });
  const roomRef = useRef<RoomState | null>(null);
  const connectionRef = useRef<ConnectionState>("connecting");
  const realtimeRef = useRef<RoomRealtimeConnection | null>(null);
  const draftsRef = useRef(new Map<string, AgentCanvasDraftSnapshot>());
  const initialDraftListVisitRef = useRef<RoomVisit | null>(null);
  const draftTombstonesRef = useRef(new Map<string, number>());
  const pendingCommittedDraftRemovalsRef = useRef(
    new Map<
      string,
      { draftRevision: number; authoritativeRoomRevision: number }
    >(),
  );
  const deferredCommittedDraftRemovalsRef = useRef(
    new Map<string, DeferredCommittedDraftRemoval>(),
  );
  const pendingDraftListAbsencesRef = useRef(
    new Map<string, { draftRevision: number; serverTime: number }>(),
  );
  const reconcileCommittedDraftRemovalsRef = useRef<(roomRevision: number) => void>(
    () => undefined,
  );
  const refreshRoomRef = useRef<(() => Promise<RoomState>) | null>(null);
  const requestDraftRefreshRef = useRef<(() => void) | null>(null);
  const draftEventRefreshRef = useRef<DraftRefreshState | null>(null);
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
  const roomVisitStartedAtRef = useRef<{ visit: RoomVisit; startedAt: number } | null>(null);
  const refreshGenerationRef = useRef(0);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const realtimeUnavailableSinceRef = useRef<number | null>(null);
  const authoritativeRefreshFailedAtRef = useRef<number | null>(null);
  const lastDraftRequestAtRef = useRef<number | null>(null);
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
    reconcileCommittedDraftRemovalsRef.current(projected.roomRevision);
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

  const publishDraftState = useCallback(() => {
    const activeVisit = roomVisitRef.current;
    if (!activeVisit) return;
    const drafts = [...draftsRef.current.values()].sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
    setDraftState({ visit: activeVisit, value: drafts });
  }, []);

  const acceptAgentDraft = useCallback((draft: AgentCanvasDraftSnapshot) => {
    const activeVisit = roomVisitRef.current;
    if (!activeVisit || draft.roomId !== activeVisit.roomId) return false;
    const pendingAbsence = pendingDraftListAbsencesRef.current.get(draft.id);
    if (pendingAbsence && draft.revision >= pendingAbsence.draftRevision) {
      pendingDraftListAbsencesRef.current.delete(draft.id);
    }
    const pendingRemoval = pendingCommittedDraftRemovalsRef.current.get(draft.id);
    if (pendingRemoval && draft.revision > pendingRemoval.draftRevision) {
      pendingCommittedDraftRemovalsRef.current.delete(draft.id);
    }
    const tombstoneRevision = draftTombstonesRef.current.get(draft.id) ?? 0;
    const current = draftsRef.current.get(draft.id);
    if (draft.revision <= tombstoneRevision || (current && current.revision > draft.revision)) return false;
    if (current?.revision === draft.revision) {
      const expiryRefresh =
        current.status === draft.status &&
        current.baselineRoomRevision === draft.baselineRoomRevision &&
        draft.expiresAt > current.expiresAt &&
        draft.updatedAt >= current.updatedAt;
      if (!expiryRefresh) return false;
    }
    if (draft.expiresAt <= Date.now()) {
      draftsRef.current.delete(draft.id);
      draftTombstonesRef.current.set(draft.id, Math.max(tombstoneRevision, draft.revision));
    } else {
      draftsRef.current.set(draft.id, draft);
    }
    publishDraftState();
    return true;
  }, [publishDraftState]);

  const removeAgentDraft = useCallback((draftId: string, revision = Number.MAX_SAFE_INTEGER) => {
    const deferred = deferredCommittedDraftRemovalsRef.current.get(draftId);
    if (deferred) {
      window.cancelAnimationFrame(deferred.firstFrame);
      if (deferred.secondFrame !== null) window.cancelAnimationFrame(deferred.secondFrame);
      deferredCommittedDraftRemovalsRef.current.delete(draftId);
    }
    pendingDraftListAbsencesRef.current.delete(draftId);
    pendingCommittedDraftRemovalsRef.current.delete(draftId);
    const current = draftsRef.current.get(draftId);
    const tombstoneRevision = Math.max(draftTombstonesRef.current.get(draftId) ?? 0, revision);
    draftTombstonesRef.current.set(draftId, tombstoneRevision);
    if (!current || current.revision <= tombstoneRevision) draftsRef.current.delete(draftId);
    publishDraftState();
  }, [publishDraftState]);

  const scheduleCommittedDraftRemoval = useCallback((
    draftId: string,
    pending: { draftRevision: number; authoritativeRoomRevision: number },
  ) => {
    const activeVisit = roomVisitRef.current;
    if (!activeVisit) return;
    const currentDeferred = deferredCommittedDraftRemovalsRef.current.get(draftId);
    if (currentDeferred) {
      window.cancelAnimationFrame(currentDeferred.firstFrame);
      if (currentDeferred.secondFrame !== null) {
        window.cancelAnimationFrame(currentDeferred.secondFrame);
      }
      deferredCommittedDraftRemovalsRef.current.delete(draftId);
    }

    const finalize = () => {
      const deferred = deferredCommittedDraftRemovalsRef.current.get(draftId);
      if (!deferred || deferred.visit !== activeVisit) return;
      deferredCommittedDraftRemovalsRef.current.delete(draftId);
      const latest = pendingCommittedDraftRemovalsRef.current.get(draftId);
      if (
        !latest ||
        latest.draftRevision !== pending.draftRevision ||
        latest.authoritativeRoomRevision !== pending.authoritativeRoomRevision ||
        (roomRef.current?.roomRevision ?? -1) < pending.authoritativeRoomRevision
      ) return;
      removeAgentDraft(draftId, pending.draftRevision);
    };

    if (document.visibilityState === "hidden") {
      removeAgentDraft(draftId, pending.draftRevision);
      return;
    }

    const deferred: DeferredCommittedDraftRemoval = {
      firstFrame: 0,
      secondFrame: null,
      visit: activeVisit,
    };
    deferred.firstFrame = window.requestAnimationFrame(() => {
      if (deferredCommittedDraftRemovalsRef.current.get(draftId) !== deferred) return;
      deferred.secondFrame = window.requestAnimationFrame(finalize);
    });
    deferredCommittedDraftRemovalsRef.current.set(draftId, deferred);
  }, [removeAgentDraft]);

  const reconcileCommittedDraftRemovals = useCallback((roomRevision: number) => {
    for (const [draftId, pending] of pendingCommittedDraftRemovalsRef.current) {
      if (roomRevision < pending.authoritativeRoomRevision) continue;
      scheduleCommittedDraftRemoval(draftId, pending);
    }
  }, [scheduleCommittedDraftRemoval]);

  const retireCommittedAgentDraft = useCallback((
    sourceRoomId: string,
    draftId: string,
    draftRevision: number,
    authoritativeRoomRevision: number,
  ) => {
    const activeVisit = roomVisitRef.current;
    if (!activeVisit || activeVisit.roomId !== sourceRoomId) return;
    const current = pendingCommittedDraftRemovalsRef.current.get(draftId);
    pendingCommittedDraftRemovalsRef.current.set(draftId, {
      draftRevision: Math.max(current?.draftRevision ?? 0, draftRevision),
      authoritativeRoomRevision: Math.max(
        current?.authoritativeRoomRevision ?? 0,
        authoritativeRoomRevision,
      ),
    });
    reconcileCommittedDraftRemovalsRef.current(roomRef.current?.roomRevision ?? -1);
  }, []);

  useEffect(() => {
    reconcileCommittedDraftRemovalsRef.current = reconcileCommittedDraftRemovals;
    return () => {
      if (reconcileCommittedDraftRemovalsRef.current === reconcileCommittedDraftRemovals) {
        reconcileCommittedDraftRemovalsRef.current = () => undefined;
      }
    };
  }, [reconcileCommittedDraftRemovals]);

  const fenceDraftListAbsence = useCallback((draft: AgentCanvasDraftSnapshot, serverTime: number) => {
    const activeVisit = roomVisitRef.current;
    const refreshRoom = refreshRoomRef.current;
    if (!activeVisit || !refreshRoom) return;

    const pending = pendingDraftListAbsencesRef.current.get(draft.id);
    if (
      pending &&
      pending.draftRevision >= draft.revision &&
      pending.serverTime >= serverTime
    ) {
      return;
    }
    const fence = { draftRevision: draft.revision, serverTime };
    pendingDraftListAbsencesRef.current.set(draft.id, fence);

    void refreshRoom()
      .then(() => {
        if (roomVisitRef.current !== activeVisit) return;
        const currentFence = pendingDraftListAbsencesRef.current.get(draft.id);
        if (
          !currentFence ||
          currentFence.draftRevision !== fence.draftRevision ||
          currentFence.serverTime !== fence.serverTime
        ) {
          return;
        }
        pendingDraftListAbsencesRef.current.delete(draft.id);
        if (pendingCommittedDraftRemovalsRef.current.has(draft.id)) return;
        const current = draftsRef.current.get(draft.id);
        if (!current || current.revision > fence.draftRevision) return;
        draftsRef.current.delete(draft.id);
        draftTombstonesRef.current.set(
          draft.id,
          Math.max(draftTombstonesRef.current.get(draft.id) ?? 0, fence.draftRevision),
        );
        publishDraftState();
      })
      .catch(() => {
        const currentFence = pendingDraftListAbsencesRef.current.get(draft.id);
        if (
          currentFence?.draftRevision === fence.draftRevision &&
          currentFence.serverTime === fence.serverTime
        ) {
          // Keep the local ghost and let the next authorized list read retry
          // the room fence. A failed room read must never create a blank frame.
          pendingDraftListAbsencesRef.current.delete(draft.id);
        }
      });
  }, [publishDraftState]);

  const acceptDraftList = useCallback((result: AgentCanvasDraftListResult) => {
    const activeVisit = roomVisitRef.current;
    if (!activeVisit) return;
    const returned = new Set<string>();
    for (const draft of result.drafts) {
      if (draft.roomId !== activeVisit.roomId || draft.expiresAt <= result.serverTime) continue;
      returned.add(draft.id);
      const pendingAbsence = pendingDraftListAbsencesRef.current.get(draft.id);
      if (pendingAbsence && draft.revision >= pendingAbsence.draftRevision) {
        pendingDraftListAbsencesRef.current.delete(draft.id);
      }
      const pendingRemoval = pendingCommittedDraftRemovalsRef.current.get(draft.id);
      if (pendingRemoval && draft.revision > pendingRemoval.draftRevision) {
        pendingCommittedDraftRemovalsRef.current.delete(draft.id);
      }
      const tombstoneRevision = draftTombstonesRef.current.get(draft.id) ?? 0;
      const current = draftsRef.current.get(draft.id);
      if (draft.revision <= tombstoneRevision || (current && draft.revision < current.revision)) {
        continue;
      }
      if (!current || draft.revision > current.revision) {
        draftsRef.current.set(draft.id, draft);
        continue;
      }
      if (draft.updatedAt > current.updatedAt) {
        draftsRef.current.set(draft.id, {
          ...draft,
          expiresAt: Math.max(current.expiresAt, draft.expiresAt),
        });
      } else if (draft.expiresAt > current.expiresAt) {
        draftsRef.current.set(draft.id, {
          ...current,
          expiresAt: draft.expiresAt,
        });
      }
    }
    for (const [draftId, draft] of draftsRef.current) {
      const pendingRemoval = pendingCommittedDraftRemovalsRef.current.get(draftId);
      if (pendingRemoval) {
        if ((roomRef.current?.roomRevision ?? -1) >= pendingRemoval.authoritativeRoomRevision) {
          reconcileCommittedDraftRemovalsRef.current(roomRef.current?.roomRevision ?? -1);
        }
        continue;
      }
      if (!returned.has(draftId) && draft.updatedAt < result.serverTime) {
        // A missing sidecar can mean a successful commit. Refresh authority
        // after observing the absence, then retire the ghost. This makes list-
        // first and realtime-event-first delivery equally gap-free.
        fenceDraftListAbsence(draft, result.serverTime);
      }
    }
    if (initialDraftListVisitRef.current !== activeVisit) {
      initialDraftListVisitRef.current = activeVisit;
      // Calibrate the browser visit against this response's server clock. The
      // elapsed-time subtraction is deliberately conservative: network time
      // can make the estimated boundary slightly earlier, which may animate a
      // historical draft, but a draft created or revised after the board visit
      // began can never be mistaken for settled hydration and pop into view.
      const visitTiming = roomVisitStartedAtRef.current;
      const visitStartedAt = visitTiming?.visit === activeVisit
        ? visitTiming.startedAt
        : performance.now();
      const elapsedSinceVisitStarted = Math.max(0, performance.now() - visitStartedAt);
      const estimatedServerTimeAtVisitStart = result.serverTime - elapsedSinceVisitStarted;
      const initiallySettledDraftIds = result.drafts
        .filter((draft) => (
          returned.has(draft.id) &&
          draft.updatedAt <= estimatedServerTimeAtVisitStart
        ))
        .map((draft) => draft.id);
      setInitialDraftIdsState({ visit: activeVisit, value: initiallySettledDraftIds });
    }
    publishDraftState();
  }, [fenceDraftListAbsence, publishDraftState]);

  const acceptDraftInvalidation = useCallback((event: AgentCanvasDraftEvent) => {
    const activeVisit = roomVisitRef.current;
    if (!activeVisit || event.roomId !== activeVisit.roomId) return;
    if (event.type === "draft.removed") {
      if (event.reason === "committed") {
        pendingDraftListAbsencesRef.current.delete(event.draftId);
        const draft = draftsRef.current.get(event.draftId);
        if (!draft) {
          removeAgentDraft(event.draftId, event.revision);
          return;
        }
        const currentPending = pendingCommittedDraftRemovalsRef.current.get(event.draftId);
        pendingCommittedDraftRemovalsRef.current.set(event.draftId, {
          draftRevision: Math.max(currentPending?.draftRevision ?? 0, event.revision),
          authoritativeRoomRevision: Math.max(
            currentPending?.authoritativeRoomRevision ?? 0,
            event.authoritativeRoomRevision,
          ),
        });
        if ((roomRef.current?.roomRevision ?? -1) >= event.authoritativeRoomRevision) {
          reconcileCommittedDraftRemovalsRef.current(roomRef.current?.roomRevision ?? -1);
        } else {
          void refreshRoomRef.current?.().catch(() => undefined);
        }
        return;
      }
      removeAgentDraft(event.draftId, event.revision);
      return;
    }
    const current = draftsRef.current.get(event.draftId);
    const tombstoneRevision = draftTombstonesRef.current.get(event.draftId) ?? 0;
    if (
      current?.revision === event.revision &&
      tombstoneRevision < event.revision &&
      (event.expiresAt > current.expiresAt || event.status !== current.status)
    ) {
      draftsRef.current.set(event.draftId, {
        ...current,
        expiresAt: Math.max(current.expiresAt, event.expiresAt),
        status: event.status,
      });
      publishDraftState();
      return;
    }
    if ((!current || current.revision < event.revision) && tombstoneRevision < event.revision) {
      requestDraftRefreshRef.current?.();
    }
  }, [publishDraftState, removeAgentDraft]);

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
    const draftCache = draftsRef.current;
    const draftTombstones = draftTombstonesRef.current;
    const pendingCommittedDraftRemovals = pendingCommittedDraftRemovalsRef.current;
    const deferredCommittedDraftRemovals = deferredCommittedDraftRemovalsRef.current;
    const pendingDraftListAbsences = pendingDraftListAbsencesRef.current;
    roomVisitRef.current = roomVisit;
    refreshGenerationRef.current += 1;
    roomRef.current = null;
    connectionRef.current = "connecting";
    realtimeUnavailableSinceRef.current = null;
    authoritativeRefreshFailedAtRef.current = null;
    lastDraftRequestAtRef.current = null;
    transientCache.clear();
    draftCache.clear();
    draftTombstones.clear();
    pendingCommittedDraftRemovals.clear();
    for (const deferred of deferredCommittedDraftRemovals.values()) {
      window.cancelAnimationFrame(deferred.firstFrame);
      if (deferred.secondFrame !== null) window.cancelAnimationFrame(deferred.secondFrame);
    }
    deferredCommittedDraftRemovals.clear();
    pendingDraftListAbsences.clear();
    initialDraftListVisitRef.current = null;
    roomVisitStartedAtRef.current = { visit: roomVisit, startedAt: performance.now() };

    return () => {
      roomVisitRef.current = null;
      refreshGenerationRef.current += 1;
      realtimeRef.current = null;
      realtimeUnavailableSinceRef.current = null;
      authoritativeRefreshFailedAtRef.current = null;
      lastDraftRequestAtRef.current = null;
      draftEventRefreshRef.current = null;
      transientCache.clear();
      draftCache.clear();
      draftTombstones.clear();
      pendingCommittedDraftRemovals.clear();
      for (const deferred of deferredCommittedDraftRemovals.values()) {
        window.cancelAnimationFrame(deferred.firstFrame);
        if (deferred.secondFrame !== null) window.cancelAnimationFrame(deferred.secondFrame);
      }
      deferredCommittedDraftRemovals.clear();
      pendingDraftListAbsences.clear();
      initialDraftListVisitRef.current = null;
      if (roomVisitStartedAtRef.current?.visit === roomVisit) {
        roomVisitStartedAtRef.current = null;
      }
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
        authoritativeRefreshFailedAtRef.current = null;
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
        authoritativeRefreshFailedAtRef.current ??= Date.now();
        if (connectionRef.current === "live") {
          setConnectionState({ visit: requestVisit, value: "live" });
          setRoomError({ visit: requestVisit, value: null });
        } else {
          connectionRef.current = "offline";
          setConnectionState({ visit: requestVisit, value: "offline" });
          setRoomError({ visit: requestVisit, value: nextError as Error });
        }
      }
      throw nextError;
    }
  }, [acceptRoom, roomId, roomVisit]);

  useEffect(() => {
    refreshRoomRef.current = refresh;
    return () => {
      if (refreshRoomRef.current === refresh) refreshRoomRef.current = null;
    };
  }, [refresh]);

  const refreshDrafts = useCallback(async () => {
    const requestVisit = roomVisit;
    const response = await apiRequest<DraftListResponse>(`/api/rooms/${roomId}/drafts`);
    if (requestVisit === roomVisitRef.current) acceptDraftList(response);
    return response.drafts;
  }, [acceptDraftList, roomId, roomVisit]);

  const requestDraftRefresh = useCallback(() => {
    if (roomVisitRef.current !== roomVisit) return;
    let state = draftEventRefreshRef.current;
    if (!state || state.visit !== roomVisit) {
      state = { visit: roomVisit, running: false, queued: false };
      draftEventRefreshRef.current = state;
    }
    state.queued = true;
    if (state.running) return;
    state.running = true;

    void (async () => {
      let consecutiveFailures = 0;
      try {
        while (
          roomVisitRef.current === roomVisit &&
          state.queued &&
          consecutiveFailures < 3
        ) {
          state.queued = false;
          try {
            lastDraftRequestAtRef.current = Date.now();
            await refreshDrafts();
            consecutiveFailures = 0;
          } catch {
            consecutiveFailures += 1;
            state.queued = true;
            if (consecutiveFailures < 3) {
              await new Promise<void>((resolve) => {
                window.setTimeout(resolve, consecutiveFailures === 1 ? 120 : 360);
              });
            }
          }
        }
      } finally {
        state.running = false;
      }
    })();
  }, [refreshDrafts, roomVisit]);

  useEffect(() => {
    requestDraftRefreshRef.current = requestDraftRefresh;
    return () => {
      if (requestDraftRefreshRef.current === requestDraftRefresh) {
        requestDraftRefreshRef.current = null;
      }
    };
  }, [requestDraftRefresh]);

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
    const runDraftRefresh = () => {
      if (cancelled) return;
      requestDraftRefresh();
    };
    const realtimeFallbackPollingActive = () => {
      const unavailableSince = realtimeUnavailableSinceRef.current;
      return (
        connectionRef.current !== "live" &&
        unavailableSince !== null &&
        Date.now() - unavailableSince >= REALTIME_FALLBACK_GRACE_MS
      );
    };
    const roomFallbackPollingActive = () => {
      const failedAt = authoritativeRefreshFailedAtRef.current;
      return realtimeFallbackPollingActive() || (
        failedAt !== null &&
        Date.now() - failedAt >= REALTIME_FALLBACK_GRACE_MS
      );
    };
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`jazzboard:${roomId}`);
    channelRef.current = channel;
    channel?.addEventListener("message", () => {
      if (connectionRef.current !== "live") runAutomaticRefresh();
    });
    const initialRefresh = window.setTimeout(() => {
      runAutomaticRefresh();
    }, 0);
    const initialDraftRefresh = window.setTimeout(() => {
      if (
        document.visibilityState !== "hidden" &&
        lastDraftRequestAtRef.current === null
      ) {
        runDraftRefresh();
      }
    }, ACTIVE_DRAFT_FALLBACK_POLL_MS);
    const poll = window.setInterval(() => {
      if (
        document.visibilityState !== "hidden" &&
        roomFallbackPollingActive()
      ) {
        runAutomaticRefresh();
      }
    }, ROOM_FALLBACK_POLL_MS);
    const draftPoll = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      const lastRequestAt = lastDraftRequestAtRef.current;
      const elapsed = lastRequestAt === null ? Number.POSITIVE_INFINITY : now - lastRequestAt;
      const queuedRetryDue =
        draftEventRefreshRef.current?.queued === true &&
        draftEventRefreshRef.current.running === false &&
        elapsed >= FAILED_DRAFT_RETRY_MS;
      const fallbackCadence = draftsRef.current.size > 0
        ? ACTIVE_DRAFT_FALLBACK_POLL_MS
        : IDLE_DRAFT_FALLBACK_POLL_MS;
      const fallbackRefreshDue = realtimeFallbackPollingActive() && elapsed >= fallbackCadence;
      if (queuedRetryDue || fallbackRefreshDue) runDraftRefresh();
    }, ACTIVE_DRAFT_FALLBACK_POLL_MS);
    const draftExpiry = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [draftId, draft] of draftsRef.current) {
        if (pendingCommittedDraftRemovalsRef.current.has(draftId)) continue;
        if (draft.expiresAt > now) continue;
        draftsRef.current.delete(draftId);
        draftTombstonesRef.current.set(
          draftId,
          Math.max(draftTombstonesRef.current.get(draftId) ?? 0, draft.revision),
        );
        changed = true;
      }
      if (changed) publishDraftState();
    }, 1_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") return;
      if (connectionRef.current === "live") {
        realtimeRef.current?.requestSync();
        runDraftRefresh();
      } else {
        runAutomaticRefresh();
        runDraftRefresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearTimeout(initialRefresh);
      window.clearTimeout(initialDraftRefresh);
      window.clearInterval(poll);
      window.clearInterval(draftPoll);
      window.clearInterval(draftExpiry);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      channel?.close();
      channelRef.current = null;
    };
  }, [publishDraftState, refresh, requestDraftRefresh, roomId]);

  useEffect(() => {
    const connectionVisit = roomVisit;
    const realtime = connectRoomRealtime({
      roomId,
      onSnapshot(nextRoom) {
        if (connectionVisit !== roomVisitRef.current) return;
        acceptRoom(nextRoom);
        if ([...draftsRef.current.values()].some((draft) => draft.status === "awaiting_review")) {
          requestDraftRefreshRef.current?.();
        }
      },
      onReady() {
        if (connectionVisit !== roomVisitRef.current) return;
        requestDraftRefreshRef.current?.();
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
        if ([...draftsRef.current.values()].some((draft) => draft.status === "awaiting_review")) {
          requestDraftRefreshRef.current?.();
        }
      },
      onTransientPresence(transient) {
        if (connectionVisit !== roomVisitRef.current) return;
        acceptTransientPresence(transient);
      },
      onDraftInvalidated(event) {
        if (connectionVisit !== roomVisitRef.current) return;
        acceptDraftInvalidation(event);
      },
      onStatusChange(status) {
        if (connectionVisit !== roomVisitRef.current) return;
        refreshGenerationRef.current += 1;
        if (status === "connected") {
          realtimeUnavailableSinceRef.current = null;
          setConnection("live");
          return;
        }
        if (realtimeUnavailableSinceRef.current === null) {
          realtimeUnavailableSinceRef.current = Date.now();
        }
        if (status === "unavailable" || status === "closed") setConnection("polling");
        else setConnection(roomRef.current ? "polling" : "connecting");
      },
    });
    realtimeRef.current = realtime;
    return () => {
      if (realtimeRef.current === realtime) realtimeRef.current = null;
      realtime.close();
    };
  }, [acceptDraftInvalidation, acceptPresence, acceptRoom, acceptTransientPresence, requestEventRefresh, roomId, roomVisit, setConnection]);

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
  const agentDrafts = draftState.visit === roomVisit ? draftState.value : [];
  const initialAgentDraftIds = initialDraftIdsState.visit === roomVisit
    ? initialDraftIdsState.value
    : [];
  const self = useMemo(
    () => (visibleRoom && participantId ? visibleRoom.participants[participantId] ?? null : null),
    [participantId, visibleRoom],
  );

  return {
    room: visibleRoom,
    agentDrafts,
    initialAgentDraftIds,
    participantId,
    self,
    connection,
    error,
    refresh,
    refreshDrafts,
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
    acceptAgentDraft,
    removeAgentDraft,
    retireCommittedAgentDraft,
    setConnection,
  };
}
