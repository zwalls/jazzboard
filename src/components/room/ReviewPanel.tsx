"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  Check,
  Eye,
  Focus,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import type {
  AgentEditPolicy,
  AgentEditProposalSummary,
  AgentEditProposalStatus,
  RoomState,
} from "@/lib/domain/types";

import styles from "./review-panel.module.css";

type ReviewListResponse = {
  ok: true;
  policy: AgentEditPolicy;
  proposals: AgentEditProposalSummary[];
  totalMatched: number;
  truncated: boolean;
};

function messageFor(error: unknown): string {
  if (error instanceof JazzboardApiError) return error.failure.message;
  return error instanceof Error ? error.message : "Jazzboard could not complete that review action.";
}

function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ReviewPanel({
  room,
  role,
  acceptRoom,
  onClose,
  onFocus,
  onAnnounce,
}: {
  room: RoomState;
  role: "participant" | "spectator";
  acceptRoom(room: RoomState): void;
  onClose(): void;
  onFocus(objectIds: string[]): void;
  onAnnounce(message: string): void;
}) {
  const [filter, setFilter] = useState<AgentEditProposalStatus | "all">("pending");
  const [proposals, setProposals] = useState<AgentEditProposalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reviewUrl = `/api/rooms/${encodeURIComponent(room.id)}/review`;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: "100" });
    if (filter !== "all") query.set("status", filter);
    try {
      const response = await apiRequest<ReviewListResponse>(`${reviewUrl}?${query}`, {
        method: "GET",
        signal,
      });
      setError(null);
      setProposals(response.proposals);
    } catch (requestError) {
      if (!(requestError instanceof DOMException && requestError.name === "AbortError")) {
        setError(messageFor(requestError));
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [filter, reviewUrl]);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => void refresh(controller.signal), 0);
    const interval = window.setInterval(() => void refresh(controller.signal), 4_000);
    return () => {
      controller.abort();
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [refresh]);

  async function setPolicy(policy: AgentEditPolicy) {
    setBusy("policy");
    setError(null);
    try {
      const response = await apiRequest<{ ok: true; room: RoomState; policy: AgentEditPolicy; changed: boolean }>(
        `${reviewUrl}/policy`,
        { method: "POST", body: JSON.stringify({ policy }) },
      );
      acceptRoom(response.room);
      onAnnounce(
        policy === "review"
          ? "Future agent edits now require human review."
          : "Agents can now edit the canvas live.",
      );
    } catch (requestError) {
      setError(messageFor(requestError));
    } finally {
      setBusy(null);
    }
  }

  async function decide(proposal: AgentEditProposalSummary, action: "approve" | "reject") {
    setBusy(`${action}:${proposal.id}`);
    setError(null);
    try {
      const response = await apiRequest<{
        ok: true;
        outcome: "applied" | "rejected";
        room: RoomState;
        proposal: AgentEditProposalSummary;
      }>(`${reviewUrl}/${encodeURIComponent(proposal.id)}`, {
        method: "POST",
        body: JSON.stringify({ action, expectedProposalRevision: proposal.revision }),
      });
      acceptRoom(response.room);
      setProposals((current) => filter === "pending"
        ? current.filter((item) => item.id !== proposal.id)
        : current.map((item) => item.id === proposal.id ? response.proposal : item));
      onAnnounce(action === "approve" ? "Agent edit approved and applied safely." : "Agent edit rejected.");
    } catch (requestError) {
      setError(messageFor(requestError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <aside className={styles.panel} aria-label="Agent edit review">
      <div className={styles.heading}>
        <span className={styles.headingIcon}><ShieldCheck size={17} /></span>
        <div><span>Human control</span><strong>Agent edit review</strong></div>
        <button className={styles.closeButton} onClick={onClose} aria-label="Close agent edit review"><X size={16} /></button>
      </div>

      <div className={styles.policy}>
        <div>
          <span className={room.agentEditPolicy === "review" ? styles.reviewDot : styles.liveDot} />
          <div>
            <strong>{room.agentEditPolicy === "review" ? "Review before apply" : "Live agent edits"}</strong>
            <span>{room.agentEditPolicy === "review" ? "Agents propose; a person decides." : "Authorized agents edit shared state directly."}</span>
          </div>
        </div>
        {role === "participant" ? (
          <div className={styles.policySwitch} aria-label="Agent edit policy">
            <button disabled={busy !== null} className={room.agentEditPolicy === "live" ? styles.selected : ""} onClick={() => void setPolicy("live")}>Live</button>
            <button disabled={busy !== null} className={room.agentEditPolicy === "review" ? styles.selected : ""} onClick={() => void setPolicy("review")}>Review</button>
          </div>
        ) : null}
      </div>

      <div className={styles.filters}>
        {(["pending", "applied", "rejected", "all"] as const).map((status) => (
          <button key={status} className={filter === status ? styles.selectedFilter : ""} onClick={() => setFilter(status)}>
            {status}
          </button>
        ))}
        <button
          className={styles.refreshButton}
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setError(null);
            void refresh();
          }}
          aria-label="Refresh proposals"
        >
          <RefreshCw className={loading ? styles.spin : ""} size={13} />
        </button>
      </div>

      <div className={styles.list}>
        {proposals.map((proposal) => (
          <article className={styles.card} key={proposal.id}>
            <div className={styles.cardTopline}>
              <span style={{ background: proposal.author.color }}><Bot size={14} /></span>
              <div>
                <strong>{proposal.author.displayName}’s agent</strong>
                <small>{proposal.status} · {relativeTime(proposal.updatedAt)}</small>
              </div>
              <i className={styles[proposal.status]}>{proposal.status}</i>
            </div>
            <div className={styles.cardBody}>
              <strong>{proposal.purpose.label}</strong>
              {proposal.intent ? <p><b>Intent</b> {proposal.intent}</p> : null}
              {proposal.summary ? <p>{proposal.summary}</p> : null}
              <small>
                {proposal.purpose.operationCount} operation{proposal.purpose.operationCount === 1 ? "" : "s"}
                {proposal.purpose.objectIds.length ? ` · ${proposal.purpose.objectIds.length} objects` : ""}
                {proposal.purpose.diagramIds.length ? ` · ${proposal.purpose.diagramIds.length} diagrams` : ""}
                {` · based on room r${proposal.baselineRoomRevision}`}
              </small>
              {proposal.review ? (
                <span className={styles.reviewRecord}>
                  {proposal.review.decision === "approved" ? "Approved" : "Rejected"} by {proposal.review.reviewer.displayName}
                  {proposal.review.note ? ` — ${proposal.review.note}` : ""}
                </span>
              ) : null}
            </div>
            <div className={styles.actions}>
              {proposal.purpose.objectIds.length ? (
                <button onClick={() => onFocus(proposal.purpose.objectIds)}><Focus size={13} /> Show affected</button>
              ) : null}
              {role === "participant" && proposal.status === "pending" ? (
                <>
                  <button
                    className={styles.approveButton}
                    disabled={busy !== null}
                    onClick={() => void decide(proposal, "approve")}
                  >
                    {busy === `approve:${proposal.id}` ? <LoaderCircle className={styles.spin} size={13} /> : <Check size={13} />} Approve &amp; apply
                  </button>
                  <button
                    className={styles.rejectButton}
                    disabled={busy !== null}
                    onClick={() => void decide(proposal, "reject")}
                  >
                    {busy === `reject:${proposal.id}` ? <LoaderCircle className={styles.spin} size={13} /> : <X size={13} />} Reject
                  </button>
                </>
              ) : null}
            </div>
          </article>
        ))}
        {!loading && !proposals.length ? (
          <div className={styles.empty}>
            <Eye size={18} />
            <strong>No {filter === "all" ? "agent edits" : filter} here</strong>
            <span>{filter === "pending" ? "New proposals will appear here before they can change the canvas." : "Try another status filter."}</span>
          </div>
        ) : null}
        {loading && !proposals.length ? (
          <div className={styles.empty}><LoaderCircle className={styles.spin} size={18} /><span>Reading the review queue…</span></div>
        ) : null}
        {error ? <div className={styles.error} role="alert">{error}</div> : null}
      </div>
    </aside>
  );
}
