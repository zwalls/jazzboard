"use client";

import { useEffect, useState } from "react";
import { LockKeyhole, MousePointer2 } from "lucide-react";

import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { Point, RoomState } from "@/lib/domain/types";

import { AgentAvatar, isAgentActivityWorking } from "./AgentAvatar";
import styles from "./room.module.css";

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
    <div className={styles.presenceOverlay} aria-hidden="true">
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
          const point = runtime.pageToViewport(cursor);
          items.push(
            <div
              className={styles.agentCursor}
              data-testid={`agent-cursor-${participant.participantId}`}
              data-activity-progress={Math.round(progress * 100)}
              key={`${participant.participantId}:agent`}
              style={{ transform: `translate(${point.x}px, ${point.y}px)`, color: participant.color }}
            >
              <AgentAvatar
                displayName={participant.displayName}
                motion={working ? "always" : "none"}
                participantColor={participant.color}
                size={26}
                state={working ? "working" : "idle"}
              />
              <span className={styles.agentCursorLabel} style={{ background: participant.color }}>
                {participant.displayName} · agent
                {working && activity ? ` · ${activity.label} · ${Math.round(progress * 100)}%` : ""}
              </span>
            </div>,
          );
          if (activity && elapsed < duration + 600) {
            for (const objectId of activity.objectIds) {
              const bounds = viewportBounds(objectId);
              if (!bounds) continue;
              items.push(
                <div
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
