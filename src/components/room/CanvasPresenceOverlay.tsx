"use client";

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LockKeyhole, MousePointer2 } from "lucide-react";

import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import {
  AgentDraftChoreographyCoordinator,
  buildAgentDraftChoreographyPlan,
  type AgentDraftChoreographyFrame,
} from "@/lib/canvas/agent-draft-choreography";
import type { AgentDraftRevealRegistry } from "@/lib/canvas/agent-draft-reveal";
import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { AgentActivity, Participant, Point, RoomState } from "@/lib/domain/types";

import { AgentAvatar, isAgentActivityWorking } from "./AgentAvatar";
import styles from "./room.module.css";

const AGENT_PARK_INSET = 8;
const AGENT_AVATAR_SIZE = 63;
const AGENT_MARKER_SIZE = 70;
const AGENT_KEYBOARD_STEP = 8;
const AGENT_HANDOFF_SPEED = 760;
const AGENT_HANDOFF_MAX_FRAME_MS = 16;
const AGENT_HANDOFF_CONVERGENCE_PX = 0.75;
const AGENT_HANDOFF_SETTLE_MS = 180;
const AGENT_HANDOFF_SOURCE_GRACE_MS = 5_000;
const NO_SETTLED_DRAFTS: ReadonlySet<string> = new Set();

type AgentCursorDrag = {
  pointerId: number;
  grabOffset: Point;
  originalParkedPoint: Point | null;
  moved: boolean;
};

type DraftCursorHandoff = {
  point: Point;
  recordedAt: number;
};

export function shouldRenderLeaseDebugLabel(environment = process.env.NODE_ENV) {
  return environment !== "production";
}

export function CanvasPresenceOverlay({
  agentDrafts = [],
  initiallySettledDraftIds = NO_SETTLED_DRAFTS,
  revealRegistry,
  runtime,
  room,
  selfId,
}: {
  agentDrafts?: readonly AgentCanvasDraftSnapshot[];
  initiallySettledDraftIds?: ReadonlySet<string>;
  revealRegistry?: AgentDraftRevealRegistry;
  runtime: CanvasRuntime | null;
  room: RoomState;
  selfId: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const draftCursorHandoffs = useMemo(() => new Map<string, DraftCursorHandoff>(), []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 120);
    return () => window.clearInterval(timer);
  }, []);
  const workingDraftsByParticipant = useMemo(() => {
    const entries = Object.values(room.participants).flatMap((participant) => {
      const canonicalAgentWorking = Boolean(
        participant.agentActive &&
        participant.agent.cursor &&
        isAgentActivityWorking(participant.agent.activity, now),
      );
      const draft = canonicalAgentWorking
        ? null
        : activeDraftForParticipant(agentDrafts, room.id, participant.participantId, now);
      return draft ? [[participant.participantId, draft] as const] : [];
    });
    return new Map(entries);
  }, [agentDrafts, now, room.id, room.participants]);
  const drivenDraftIds = useMemo(
    () => new Set([...workingDraftsByParticipant.values()].map((draft) => draft.id)),
    [workingDraftsByParticipant],
  );
  useLayoutEffect(() => {
    revealRegistry?.settleUndrivenDrafts(drivenDraftIds);
  }, [drivenDraftIds, revealRegistry]);
  if (!runtime) return null;

  const viewportBounds = (objectId: string) => {
    const bounds = runtime.getObjectBounds(objectId);
    if (!bounds) return null;
    const topLeft = runtime.pageToViewport({ x: bounds.x, y: bounds.y });
    const bottomRight = runtime.pageToViewport({
      x: bounds.x + bounds.width,
      y: bounds.y + bounds.height,
    });
    return {
      left: topLeft.x,
      top: topLeft.y,
      width: Math.max(bottomRight.x - topLeft.x, 1),
      height: Math.max(bottomRight.y - topLeft.y, 1),
    };
  };

  return (
    <div className={styles.presenceOverlay}>
      {Object.values(room.participants).flatMap((participant) => {
        const items: React.ReactNode[] = [];
        if (
          participant.participantId !== selfId &&
          participant.human.cursor &&
          now - participant.human.lastSeenAt < 12_000
        ) {
          const point = runtime.pageToViewport(participant.human.cursor);
          items.push(
            <div
              aria-hidden="true"
              className={styles.humanCursor}
              key={`${participant.participantId}:human`}
              style={{ transform: `translate(${point.x}px, ${point.y}px)`, color: participant.color }}
            >
              <MousePointer2 size={22} fill="white" strokeWidth={2.5} />
              <span style={{ background: participant.color }}>{participant.displayName}</span>
            </div>,
          );
        }
        const canonicalAgentActivity = participant.agent.activity;
        const canonicalAgentWorking = Boolean(
          participant.agentActive &&
          participant.agent.cursor &&
          isAgentActivityWorking(canonicalAgentActivity, now),
        );
        const workingDraft = canonicalAgentWorking
          ? null
          : workingDraftsByParticipant.get(participant.participantId) ?? null;
        if (workingDraft) {
          items.push(
            <DraftAgentCursor
              draft={workingDraft}
              initiallySettled={initiallySettledDraftIds.has(workingDraft.id)}
              key={`${participant.participantId}:agent:draft:${workingDraft.id}`}
              participant={participant}
              room={room}
              runtime={runtime}
              revealRegistry={revealRegistry}
              handoffRegistry={draftCursorHandoffs}
            />,
          );
        } else if (participant.agentActive && participant.agent.cursor) {
          const activity = participant.agent.activity;
          const elapsed = activity ? Math.max(now - activity.startedAt, 0) : 0;
          const duration = activity?.durationMs ?? 1;
          const working = isAgentActivityWorking(activity, now);
          const progress = activity ? Math.min(elapsed / duration, 1) : 1;
          const from = activity?.fromCursor ?? participant.agent.cursor;
          const to = activity?.toCursor ?? participant.agent.cursor;
          const cursor: Point = {
            x: from.x + (to.x - from.x) * progress,
            y: from.y + (to.y - from.y) * progress,
          };
          const draftHandoff = draftCursorHandoffs.get(participant.participantId);
          const handoffPagePoint = draftHandoff?.point ?? null;
          items.push(
            <LocalAgentCursor
              activity={activity}
              authoritativeCursor={cursor}
              handoffPagePoint={handoffPagePoint}
              handoffRegistry={draftCursorHandoffs}
              key={`${participant.participantId}:agent:${activity?.id ?? "none"}:${activity?.startedAt ?? 0}`}
              participant={participant}
              progress={progress}
              runtime={runtime}
              working={working}
            />,
          );
          if (activity && elapsed < duration + 600) {
            for (const objectId of activity.objectIds) {
              const bounds = viewportBounds(objectId);
              if (!bounds) continue;
              items.push(
                <div
                  aria-hidden="true"
                  className={styles.agentWorkOutline}
                  key={`${participant.participantId}:work:${objectId}`}
                  style={{
                    ...bounds,
                    borderColor: participant.color,
                    color: participant.color,
                    "--agent-progress": progress,
                    "--agent-progress-percent": `${Math.round(progress * 100)}%`,
                  } as React.CSSProperties}
                />,
              );
            }
          }
        }
        return items;
      })}
      {Object.values(room.leases).map((activeLease) => {
        if (activeLease.expiresAt <= now) return null;
        const bounds = viewportBounds(activeLease.objectId);
        if (!bounds) return null;
        return (
          <div
            aria-hidden="true"
            className={styles.leaseOutline}
            key={activeLease.leaseId}
            style={{ ...bounds, borderColor: activeLease.actor.color }}
          >
            {shouldRenderLeaseDebugLabel() ? (
              <span style={{ background: activeLease.actor.color }}>
                <LockKeyhole size={11} />
                {activeLease.actor.displayName}
                {activeLease.actor.kind === "agent" ? "’s agent" : ""} · {activeLease.operation}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function clampAgentViewportPoint(point: Point, overlay: HTMLElement | null): Point {
  const maxX = overlay?.clientWidth
    ? Math.max(AGENT_PARK_INSET, overlay.clientWidth - AGENT_MARKER_SIZE - AGENT_PARK_INSET)
    : Number.POSITIVE_INFINITY;
  const maxY = overlay?.clientHeight
    ? Math.max(AGENT_PARK_INSET, overlay.clientHeight - AGENT_MARKER_SIZE - AGENT_PARK_INSET)
    : Number.POSITIVE_INFINITY;
  return {
    x: Math.max(AGENT_PARK_INSET, Math.min(point.x, maxX)),
    y: Math.max(AGENT_PARK_INSET, Math.min(point.y, maxY)),
  };
}

function activeDraftForParticipant(
  drafts: readonly AgentCanvasDraftSnapshot[],
  roomId: string,
  participantId: string,
  now: number,
): AgentCanvasDraftSnapshot | null {
  return drafts.reduce<AgentCanvasDraftSnapshot | null>((current, draft) => {
    if (
      draft.roomId !== roomId ||
      draft.ownerParticipantId !== participantId ||
      (draft.status !== "active" && draft.status !== "committing") ||
      draft.expiresAt <= now ||
      draft.hardExpiresAt <= now
    ) {
      return current;
    }
    if (!current) return draft;
    if (draft.updatedAt !== current.updatedAt) {
      return draft.updatedAt > current.updatedAt ? draft : current;
    }
    return draft.revision > current.revision ? draft : current;
  }, null);
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

function DraftAgentCursor({
  draft,
  handoffRegistry,
  initiallySettled,
  participant,
  room,
  runtime,
  revealRegistry,
}: {
  draft: AgentCanvasDraftSnapshot;
  handoffRegistry: Map<string, DraftCursorHandoff>;
  initiallySettled: boolean;
  participant: Participant;
  room: RoomState;
  runtime: CanvasRuntime;
  revealRegistry?: AgentDraftRevealRegistry;
}) {
  const markerRef = useRef<HTMLDivElement | null>(null);
  const coordinatorRef = useRef<AgentDraftChoreographyCoordinator | null>(null);
  const coordinatorInitializedRef = useRef(false);
  const reducedMotion = usePrefersReducedMotion();
  const renderedViewport = runtime.getViewport();
  const fallbackX = participant.agent.cursor?.x
    ?? renderedViewport.x + renderedViewport.width / 2;
  const fallbackY = participant.agent.cursor?.y
    ?? renderedViewport.y + renderedViewport.height / 2;
  const plan = useMemo(() => {
    return buildAgentDraftChoreographyPlan({
      authoritativeDiagrams: room.diagrams,
      authoritativeObjects: room.objects,
      draft,
      fallbackPoint: { x: fallbackX, y: fallbackY },
      viewportZoom: renderedViewport.zoom,
    });
  }, [draft, fallbackX, fallbackY, renderedViewport.zoom, room.diagrams, room.objects]);
  if (coordinatorRef.current == null) {
    coordinatorRef.current = new AgentDraftChoreographyCoordinator();
  }

  useEffect(() => () => {
    const handoff = handoffRegistry.get(participant.participantId);
    if (!handoff) return;
    const released = { ...handoff, recordedAt: Date.now() };
    handoffRegistry.set(participant.participantId, released);
    window.setTimeout(() => {
      if (handoffRegistry.get(participant.participantId) === released) {
        handoffRegistry.delete(participant.participantId);
      }
    }, AGENT_HANDOFF_SOURCE_GRACE_MS);
  }, [handoffRegistry, participant.participantId]);

  useLayoutEffect(() => {
    const coordinator = coordinatorRef.current!;
    let animationFrame = 0;
    let disposed = false;

    const cancelAnimation = () => {
      if (!animationFrame) return;
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };

    const applyFrame = (frame: AgentDraftChoreographyFrame) => {
      revealRegistry?.applyEvents(draft.id, coordinator.drainRevealEvents());
      revealRegistry?.applyFrame(draft.id, frame);
      const marker = markerRef.current;
      if (!marker || disposed) return;
      const viewportPoint = runtime.pageToViewport(frame.pagePoint);
      marker.style.transform = `translate(${viewportPoint.x}px, ${viewportPoint.y}px)`;
      marker.style.setProperty("--agent-choreography-progress", String(frame.phaseProgress));
      marker.dataset.activityProgress = String(Math.round(frame.phaseProgress * 100));
      marker.dataset.agentDraftChoreographyPhase = frame.phase;
      marker.dataset.agentDraftChoreographyObjectId = frame.objectId ?? "";
      marker.dataset.agentDraftChoreographyFingerprint = frame.fingerprint ?? "";
      handoffRegistry.set(participant.participantId, {
        point: { ...frame.pagePoint },
        recordedAt: Date.now(),
      });

      const viewport = runtime.getViewport();
      const physicalWidth = viewport.width * viewport.zoom;
      const physicalHeight = viewport.height * viewport.zoom;
      const labelWidth = Math.min(280, Math.max(150, participant.displayName.length * 6 + 170));
      marker.dataset.labelSide = physicalWidth && viewportPoint.x + AGENT_MARKER_SIZE + labelWidth > physicalWidth - AGENT_PARK_INSET
        ? "left"
        : "right";
      marker.dataset.labelVertical = physicalHeight && viewportPoint.y + AGENT_MARKER_SIZE + 24 > physicalHeight - AGENT_PARK_INSET
        ? "above"
        : "below";
    };

    const reduceBeforePaint = reducedMotion || (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    const visiblePlanObjects = plan.visibleObjects ?? plan.targets;
    const alreadyRevealed = Boolean(
      revealRegistry &&
      visiblePlanObjects.length &&
      visiblePlanObjects.every((object) => {
        const snapshot = revealRegistry.snapshot(plan.draftId, object.objectId);
        return snapshot?.state === "complete" && snapshot.fingerprint === object.fingerprint;
      }),
    );
    const seedSettledPlan = !coordinatorInitializedRef.current && (
      initiallySettled || alreadyRevealed
    );
    coordinatorInitializedRef.current = true;
    revealRegistry?.syncPlan(plan);
    if (seedSettledPlan) {
      applyFrame(coordinator.finish(plan));
      return () => { disposed = true; };
    }
    if (reduceBeforePaint || document.visibilityState === "hidden") {
      applyFrame(coordinator.finish(plan));
      return () => { disposed = true; };
    }

    const initial = coordinator.accept(plan, performance.now());
    applyFrame(initial);
    const tick = (timestamp: number) => {
      if (disposed) return;
      const frame = coordinator.sample(timestamp, plan.startPoint);
      applyFrame(frame);
      if (frame.active) animationFrame = window.requestAnimationFrame(tick);
    };
    if (initial.active) animationFrame = window.requestAnimationFrame(tick);
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden" || disposed) return;
      cancelAnimation();
      applyFrame(coordinator.finish(plan));
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      cancelAnimation();
    };
  }, [
    draft.id,
    initiallySettled,
    participant.displayName,
    participant.participantId,
    plan,
    reducedMotion,
    renderedViewport.height,
    renderedViewport.width,
    renderedViewport.x,
    renderedViewport.y,
    renderedViewport.zoom,
    runtime,
    handoffRegistry,
    revealRegistry,
  ]);

  const initialPoint = runtime.pageToViewport(plan.startPoint);
  const label = draft.status === "committing"
    ? "Validating draft · not saved"
    : "Drafting preview · not saved";
  return (
    <div
      aria-hidden="true"
      className={styles.agentCursor}
      data-activity-progress="0"
      data-agent-draft-choreography="true"
      data-agent-draft-choreography-object-id=""
      data-agent-draft-choreography-fingerprint=""
      data-agent-draft-choreography-phase="travel"
      data-agent-draft-choreography-revision={draft.revision}
      data-label-side="right"
      data-label-vertical="below"
      data-local-parked="false"
      data-working="true"
      data-testid={`agent-cursor-${participant.participantId}`}
      ref={markerRef}
      style={{
        "--agent-marker-size": `${AGENT_MARKER_SIZE}px`,
        color: participant.color,
        transform: `translate(${initialPoint.x}px, ${initialPoint.y}px)`,
      } as CSSProperties}
    >
      <AgentAvatar
        displayName={participant.displayName}
        motion={reducedMotion ? "none" : "always"}
        participantColor={participant.color}
        size={AGENT_AVATAR_SIZE}
        state="working"
      />
      <span className={styles.agentCursorLabel} data-agent-cursor-label="true" style={{ background: participant.color }}>
        {participant.displayName} · agent · {label}
      </span>
    </div>
  );
}

function LocalAgentCursor({
  activity,
  authoritativeCursor,
  handoffPagePoint: initialHandoffPagePoint,
  handoffRegistry,
  participant,
  progress,
  runtime,
  working,
  workingLabel,
}: {
  activity: AgentActivity | null;
  authoritativeCursor: Point;
  handoffPagePoint?: Point | null;
  handoffRegistry?: Map<string, DraftCursorHandoff>;
  participant: Participant;
  progress: number;
  runtime: CanvasRuntime;
  working: boolean;
  workingLabel?: string;
}) {
  const markerRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<AgentCursorDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const [handoffSourcePoint] = useState<Point | null>(() =>
    initialHandoffPagePoint ? { ...initialHandoffPagePoint } : null
  );
  const handoffCurrentRef = useRef<Point | null>(handoffSourcePoint);
  const handoffTargetRef = useRef<Point>({ ...authoritativeCursor });
  const handoffRuntimeRef = useRef(runtime);
  const [handoffInitialTargetAt] = useState(() => performance.now());
  const handoffTargetChangedAtRef = useRef(handoffInitialTargetAt);
  const [handoffActive, setHandoffActive] = useState(Boolean(handoffSourcePoint));
  const [parkedPagePoint, setParkedPagePoint] = useState<Point | null>(null);

  useLayoutEffect(() => {
    const previousTarget = handoffTargetRef.current;
    if (
      Math.abs(previousTarget.x - authoritativeCursor.x) > 0.001 ||
      Math.abs(previousTarget.y - authoritativeCursor.y) > 0.001
    ) {
      handoffTargetChangedAtRef.current = performance.now();
    }
    handoffTargetRef.current = { ...authoritativeCursor };
    handoffRuntimeRef.current = runtime;
    const current = handoffCurrentRef.current;
    const marker = markerRef.current;
    if (!handoffActive || !current || !marker) return;
    const viewportPoint = runtime.pageToViewport(current);
    marker.style.transform = `translate(${viewportPoint.x}px, ${viewportPoint.y}px)`;
  }, [authoritativeCursor, handoffActive, runtime]);

  useLayoutEffect(() => {
    if (!handoffActive || !handoffCurrentRef.current) return;
    let animationFrame = 0;
    let disposed = false;
    let started = false;
    let previousTimestamp = performance.now();

    const writeCurrentPoint = (point: Point) => {
      const marker = markerRef.current;
      const activeRuntime = handoffRuntimeRef.current;
      if (marker) {
        const viewportPoint = activeRuntime.pageToViewport(point);
        marker.style.transform = `translate(${viewportPoint.x}px, ${viewportPoint.y}px)`;
      }
      handoffRegistry?.set(participant.participantId, {
        point: { ...point },
        recordedAt: Date.now(),
      });
    };

    const complete = () => {
      if (disposed) return;
      const target = { ...handoffTargetRef.current };
      handoffCurrentRef.current = target;
      writeCurrentPoint(target);
      handoffRegistry?.delete(participant.participantId);
      setHandoffActive(false);
    };

    const reduceBeforePaint = reducedMotion || (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    if (reduceBeforePaint || document.visibilityState === "hidden") {
      complete();
      return () => { disposed = true; };
    }

    const tick = (timestamp: number) => {
      if (disposed) return;
      const current = handoffCurrentRef.current;
      if (!current) {
        complete();
        return;
      }
      const target = handoffTargetRef.current;
      const activeRuntime = handoffRuntimeRef.current;
      const currentViewportPoint = activeRuntime.pageToViewport(current);
      const targetViewportPoint = activeRuntime.pageToViewport(target);
      const remainingPixels = Math.hypot(
        targetViewportPoint.x - currentViewportPoint.x,
        targetViewportPoint.y - currentViewportPoint.y,
      );
      const elapsed = Math.max(0, Math.min(timestamp - previousTimestamp, AGENT_HANDOFF_MAX_FRAME_MS));
      previousTimestamp = timestamp;
      const stepPixels = AGENT_HANDOFF_SPEED * elapsed / 1_000;
      if (remainingPixels <= Math.max(stepPixels, AGENT_HANDOFF_CONVERGENCE_PX)) {
        handoffCurrentRef.current = { ...target };
        writeCurrentPoint(target);
        if (timestamp - handoffTargetChangedAtRef.current >= AGENT_HANDOFF_SETTLE_MS) {
          complete();
          return;
        }
        animationFrame = window.requestAnimationFrame(tick);
        return;
      }

      const ratio = stepPixels / remainingPixels;
      const next = {
        x: current.x + (target.x - current.x) * ratio,
        y: current.y + (target.y - current.y) * ratio,
      };
      handoffCurrentRef.current = next;
      writeCurrentPoint(next);
      if (!started) {
        started = true;
        if (markerRef.current) markerRef.current.dataset.agentHandoffPhase = "transition";
      }
      animationFrame = window.requestAnimationFrame(tick);
    };

    animationFrame = window.requestAnimationFrame(tick);
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden" || disposed) return;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      complete();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, [handoffActive, handoffRegistry, participant.participantId, reducedMotion]);

  useEffect(() => () => {
    const drag = dragRef.current;
    const marker = markerRef.current;
    if (drag && marker?.hasPointerCapture?.(drag.pointerId)) {
      marker.releasePointerCapture?.(drag.pointerId);
    }
    dragRef.current = null;
  }, []);

  const presentingAsWorking = working || handoffActive;
  const pagePoint = handoffActive && handoffSourcePoint
    ? handoffSourcePoint
    : working
      ? authoritativeCursor
      : parkedPagePoint ?? authoritativeCursor;
  const viewportPoint = runtime.pageToViewport(pagePoint);
  const viewport = runtime.getViewport();
  const overlayWidth = viewport.width * viewport.zoom;
  const overlayHeight = viewport.height * viewport.zoom;
  const labelWidth = Math.min(280, Math.max(150, participant.displayName.length * 6 + 70));
  const labelHeight = 24;
  const placeLabelLeft = Boolean(
    overlayWidth && viewportPoint.x + AGENT_MARKER_SIZE + labelWidth > overlayWidth - AGENT_PARK_INSET,
  );
  const placeLabelAbove = Boolean(
    overlayHeight && viewportPoint.y + AGENT_MARKER_SIZE + labelHeight > overlayHeight - AGENT_PARK_INSET,
  );
  const sharedProps = {
    className: styles.agentCursor,
    "data-activity-progress": Math.round(progress * 100),
    "data-agent-handoff": handoffActive ? "true" : "false",
    "data-agent-handoff-phase": handoffActive ? "source" : "none",
    "data-label-side": placeLabelLeft ? "left" : "right",
    "data-label-vertical": placeLabelAbove ? "above" : "below",
    "data-local-parked": parkedPagePoint ? "true" : "false",
    "data-working": presentingAsWorking ? "true" : "false",
    "data-testid": `agent-cursor-${participant.participantId}`,
    style: {
      "--agent-marker-size": `${AGENT_MARKER_SIZE}px`,
      color: participant.color,
      transform: `translate(${viewportPoint.x}px, ${viewportPoint.y}px)`,
      transition: handoffActive ? "none" : undefined,
    } as CSSProperties,
  } as const;
  const contents = (
    <>
      <AgentAvatar
        displayName={participant.displayName}
        motion={presentingAsWorking ? "always" : "hover"}
        participantColor={participant.color}
        size={AGENT_AVATAR_SIZE}
        state={presentingAsWorking ? "working" : "idle"}
      />
      <span
        className={styles.agentCursorLabel}
        data-agent-cursor-label="true"
        style={{ background: participant.color }}
      >
        {participant.displayName} · agent
        {workingLabel
          ? ` · ${workingLabel}`
          : presentingAsWorking && activity
            ? ` · ${activity.label} · ${Math.round(progress * 100)}%`
            : ""}
      </span>
    </>
  );

  if (presentingAsWorking) {
    return (
      <div {...sharedProps} aria-hidden="true" ref={(element) => { markerRef.current = element; }}>
        {contents}
      </div>
    );
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const overlayRect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!overlayRect) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      grabOffset: {
        x: event.clientX - overlayRect.left - viewportPoint.x,
        y: event.clientY - overlayRect.top - viewportPoint.y,
      },
      originalParkedPoint: parkedPagePoint,
      moved: false,
    };
    suppressClickRef.current = false;
    setDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const overlayElement = event.currentTarget.parentElement;
    const overlayRect = overlayElement?.getBoundingClientRect();
    if (!overlayElement || !overlayRect) return;
    const nextViewportPoint = clampAgentViewportPoint({
      x: event.clientX - overlayRect.left - drag.grabOffset.x,
      y: event.clientY - overlayRect.top - drag.grabOffset.y,
    }, overlayElement);
    drag.moved = true;
    setParkedPagePoint(runtime.viewportToPage(nextViewportPoint));
  }

  function finishPointerDrag(event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    if (cancelled) setParkedPagePoint(drag.originalParkedPoint);
    suppressClickRef.current = !cancelled && drag.moved;
    dragRef.current = null;
    setDragging(false);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      if (!parkedPagePoint) return;
      event.preventDefault();
      event.stopPropagation();
      setParkedPagePoint(null);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      setParkedPagePoint((current) => current ? null : authoritativeCursor);
      return;
    }
    const direction = event.key === "ArrowLeft"
      ? { x: -1, y: 0 }
      : event.key === "ArrowRight"
        ? { x: 1, y: 0 }
        : event.key === "ArrowUp"
          ? { x: 0, y: -1 }
          : event.key === "ArrowDown"
            ? { x: 0, y: 1 }
            : null;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? AGENT_KEYBOARD_STEP * 4 : AGENT_KEYBOARD_STEP;
    const currentViewportPoint = runtime.pageToViewport(parkedPagePoint ?? authoritativeCursor);
    const nextViewportPoint = clampAgentViewportPoint({
      x: currentViewportPoint.x + direction.x * step,
      y: currentViewportPoint.y + direction.y * step,
    }, event.currentTarget.parentElement);
    setParkedPagePoint(runtime.viewportToPage(nextViewportPoint));
  }

  return (
    <button
      {...sharedProps}
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Escape Enter Space"
      aria-label={parkedPagePoint
        ? `Return ${participant.displayName}’s idle agent to its live position. Activate or press Escape.`
        : `Move ${participant.displayName}’s idle agent locally. Drag or use the arrow keys; activate to park it at its current position.`}
      aria-pressed={Boolean(parkedPagePoint)}
      className={`${styles.agentCursor} ${styles.idleAgentCursor}`}
      data-agent-draggable="true"
      data-dragging={dragging ? "true" : "false"}
      draggable={false}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        setParkedPagePoint((current) => current ? null : authoritativeCursor);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setParkedPagePoint(null);
      }}
      onDragStart={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
      onPointerCancel={(event) => finishPointerDrag(event, true)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishPointerDrag(event, false)}
      ref={(element) => { markerRef.current = element; }}
      title="Drag to park this idle agent locally. Double-click to return it to its live position."
      type="button"
    >
      {contents}
    </button>
  );
}
