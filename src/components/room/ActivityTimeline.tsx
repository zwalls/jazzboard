"use client";

import { Bot, Eye, History, LoaderCircle, RotateCcw, UserRound, X } from "lucide-react";

import type { RoomActivitySummary } from "@/lib/domain/types";

import { AgentAvatar } from "./AgentAvatar";
import styles from "./activity-timeline.module.css";

export type ActivityActorFilter = "all" | "human" | "agent";

export function formatActivityTime(occurredAt: number, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - occurredAt) / 1_000));
  if (elapsedSeconds < 10) return "just now";
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function activityDescription(activity: RoomActivitySummary): string {
  if (activity.summary) return activity.summary;
  if (activity.intent) return activity.intent;
  const objectCount = activity.affectedObjectIds.length;
  const diagramCount = activity.affectedDiagramIds.length;
  if (objectCount && diagramCount) {
    return `${objectCount} object${objectCount === 1 ? "" : "s"} and ${diagramCount} diagram${diagramCount === 1 ? "" : "s"}`;
  }
  if (objectCount) return `${objectCount} object${objectCount === 1 ? "" : "s"}`;
  if (diagramCount) return `${diagramCount} diagram${diagramCount === 1 ? "" : "s"}`;
  return "No canvas objects were affected.";
}

export function ActivityTimeline({
  activities,
  actorFilter,
  canRevert,
  loading,
  revertingActivityId,
  error,
  now,
  onActorFilterChange,
  onClose,
  onFocus,
  onRefresh,
  onRevert,
}: {
  activities: readonly RoomActivitySummary[];
  actorFilter: ActivityActorFilter;
  canRevert: boolean;
  loading: boolean;
  revertingActivityId: string | null;
  error: string | null;
  now?: number;
  onActorFilterChange(filter: ActivityActorFilter): void;
  onClose(): void;
  onFocus(activity: RoomActivitySummary): void;
  onRefresh(): void;
  onRevert(activity: RoomActivitySummary): void;
}) {
  const filtered = activities.filter(
    (activity) => actorFilter === "all" || activity.actor.kind === actorFilter,
  );

  return (
    <aside className={styles.panel} aria-label="Room activity">
      <div className={styles.heading}>
        <span className={styles.headingIcon}><History size={17} /></span>
        <div>
          <span>Reviewable work</span>
          <strong>Room activity</strong>
        </div>
        <button className={styles.closeButton} onClick={onClose} aria-label="Close room activity">
          <X size={16} />
        </button>
      </div>

      <div className={styles.filters} aria-label="Filter activity by actor">
        {(["all", "agent", "human"] as const).map((filter) => (
          <button
            className={actorFilter === filter ? styles.selectedFilter : ""}
            key={filter}
            onClick={() => onActorFilterChange(filter)}
            aria-pressed={actorFilter === filter}
          >
            {filter === "agent" ? <Bot size={12} /> : filter === "human" ? <UserRound size={12} /> : null}
            {filter}
          </button>
        ))}
        <button className={styles.refreshButton} onClick={onRefresh} disabled={loading}>
          {loading ? <LoaderCircle className={styles.spin} size={12} /> : "Refresh"}
        </button>
      </div>

      <div className={styles.list} aria-live="polite" aria-busy={loading}>
        {error ? (
          <div className={styles.error} role="alert">
            <strong>Activity could not be loaded</strong>
            <span>{error}</span>
            <button onClick={onRefresh}>Try again</button>
          </div>
        ) : null}

        {!error && !loading && !filtered.length ? (
          <div className={styles.empty}>
            <History size={21} />
            <strong>No matching edits yet</strong>
            <span>Canvas and diagram changes will appear here with attribution and revision guards.</span>
          </div>
        ) : null}

        {filtered.map((activity) => {
          const isRevert = activity.action === "canvas.revert";
          const reverting = revertingActivityId === activity.id;
          return (
            <article className={styles.card} key={activity.id}>
              <div className={styles.cardTopline}>
                {activity.actor.kind === "agent" ? (
                  <AgentAvatar
                    displayName={activity.actor.displayName}
                    participantColor={activity.actor.color}
                    size={26}
                    motion="none"
                  />
                ) : (
                  <span className={styles.actorMark} style={{ background: activity.actor.color }}>
                    <UserRound size={12} />
                  </span>
                )}
                <div>
                  <strong>{activity.actor.displayName}</strong>
                  <span>{activity.actor.kind} · {formatActivityTime(activity.occurredAt, now)}</span>
                </div>
                <small>r{activity.roomRevision}</small>
              </div>
              <div className={styles.cardBody}>
                <strong>{activity.label}</strong>
                <p>{activityDescription(activity)}</p>
                {activity.intent && activity.summary ? <small>Intent: {activity.intent}</small> : null}
              </div>
              <div className={styles.cardActions}>
                <button
                  onClick={() => onFocus(activity)}
                  disabled={!activity.affectedBounds && !activity.affectedObjectIds.length}
                >
                  <Eye size={13} /> Show affected
                </button>
                {canRevert && !isRevert ? (
                  <button onClick={() => onRevert(activity)} disabled={reverting}>
                    {reverting ? <LoaderCircle className={styles.spin} size={13} /> : <RotateCcw size={13} />}
                    {reverting ? "Reverting…" : "Revert safely"}
                  </button>
                ) : null}
              </div>
              {isRevert && activity.revertsActivityId ? (
                <span className={styles.revertBadge}>Compensates {activity.revertsActivityId}</span>
              ) : null}
            </article>
          );
        })}
      </div>
    </aside>
  );
}
