"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { LockKeyhole, MousePointer2 } from "lucide-react";

import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { AgentActivity, Participant, Point, RoomState } from "@/lib/domain/types";

import { AgentAvatar, isAgentActivityWorking } from "./AgentAvatar";
import styles from "./room.module.css";

const AGENT_PARK_INSET = 8;
const AGENT_MARKER_SIZE = 30;
const AGENT_KEYBOARD_STEP = 8;

type AgentCursorDrag = {
  pointerId: number;
  grabOffset: Point;
  originalParkedPoint: Point | null;
  moved: boolean;
};

export function shouldRenderLeaseDebugLabel(environment = process.env.NODE_ENV) {
  return environment !== "production";
}

export function CanvasPresenceOverlay({
  runtime,
  room,
  selfId,
}: {
  runtime: CanvasRuntime | null;
  room: RoomState;
  selfId: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 120);
    return () => window.clearInterval(timer);
  }, []);
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
        if (participant.agentActive && participant.agent.cursor) {
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
          items.push(
            <LocalAgentCursor
              activity={activity}
              authoritativeCursor={cursor}
              key={`${participant.participantId}:agent:${working ? "working" : "idle"}:${activity?.id ?? "none"}:${activity?.startedAt ?? 0}`}
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

function LocalAgentCursor({
  activity,
  authoritativeCursor,
  participant,
  progress,
  runtime,
  working,
}: {
  activity: AgentActivity | null;
  authoritativeCursor: Point;
  participant: Participant;
  progress: number;
  runtime: CanvasRuntime;
  working: boolean;
}) {
  const markerRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<AgentCursorDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [parkedPagePoint, setParkedPagePoint] = useState<Point | null>(null);

  useEffect(() => () => {
    const drag = dragRef.current;
    const marker = markerRef.current;
    if (drag && marker?.hasPointerCapture?.(drag.pointerId)) {
      marker.releasePointerCapture?.(drag.pointerId);
    }
    dragRef.current = null;
  }, []);

  const pagePoint = working ? authoritativeCursor : parkedPagePoint ?? authoritativeCursor;
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
    "data-label-side": placeLabelLeft ? "left" : "right",
    "data-label-vertical": placeLabelAbove ? "above" : "below",
    "data-local-parked": parkedPagePoint ? "true" : "false",
    "data-working": working ? "true" : "false",
    "data-testid": `agent-cursor-${participant.participantId}`,
    style: {
      color: participant.color,
      transform: `translate(${viewportPoint.x}px, ${viewportPoint.y}px)`,
    },
  } as const;
  const contents = (
    <>
      <AgentAvatar
        displayName={participant.displayName}
        motion={working ? "always" : "hover"}
        participantColor={participant.color}
        size={26}
        state={working ? "working" : "idle"}
      />
      <span
        className={styles.agentCursorLabel}
        data-agent-cursor-label="true"
        style={{ background: participant.color }}
      >
        {participant.displayName} · agent
        {working && activity ? ` · ${activity.label} · ${Math.round(progress * 100)}%` : ""}
      </span>
    </>
  );

  if (working) {
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
