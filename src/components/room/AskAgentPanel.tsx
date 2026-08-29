"use client";

import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Clock3,
  Focus,
  LoaderCircle,
  MessageCircleQuestion,
  RefreshCw,
  Send,
  X,
} from "lucide-react";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import type { AgentMessage, AgentMessageListResult } from "@/lib/agent-messages/types";
import type { CanvasObject } from "@/lib/domain/types";

import { AgentAvatar } from "./AgentAvatar";
import styles from "./ask-agent-panel.module.css";

const POLL_INTERVAL_MS = 8_000;
export const ASK_AGENT_PANEL_ID = "ask-agent-panel";

type MessageListResponse = { ok: true } & AgentMessageListResult;

function errorMessage(error: unknown): string {
  if (error instanceof JazzboardApiError) return error.failure.message;
  return error instanceof Error ? error.message : "Jazzboard could not reach your agent inbox.";
}

function objectLabel(object: CanvasObject): string {
  if (object.kind === "text") return object.content || "Untitled text";
  if (object.kind === "shape") return object.label || `${object.shape} node`;
  if (object.kind === "connector") return object.label || "Connector";
  if (object.kind === "image") return object.alt || "Image";
  return "Freehand annotation";
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

function contextObjects(message: AgentMessage): CanvasObject[] {
  return message.context.selection.objects;
}

function statusText(message: AgentMessage): string {
  if (message.state === "pending") return "Waiting for your agent to check Jazzboard";
  if (message.state === "claimed") return "Your agent is working on this";
  if (message.reply?.outcome === "completed") return "Completed";
  if (message.reply?.outcome === "needs_input") return "Needs your input";
  return "Agent could not complete this";
}

function sameObjectIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((objectId, index) => objectId === right[index]);
}

export function AskAgentPanel({
  roomId,
  selection,
  onClose,
  onFocus,
  onAnnounce,
}: {
  roomId: string;
  selection: CanvasObject[];
  onClose(): void;
  onFocus(objectIds: string[]): void;
  onAnnounce(message: string): void;
}) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(true);
  const pollControllerRef = useRef<AbortController | null>(null);
  const draftMessageRef = useRef<{ id: string; prompt: string; selectedObjectIds: string[] } | null>(null);
  const messagesRef = useRef<AgentMessage[] | null>(null);
  const announcedSentIdsRef = useRef(new Set<string>());
  const onAnnounceRef = useRef(onAnnounce);
  const messagesUrl = `/api/rooms/${encodeURIComponent(roomId)}/messages`;

  useEffect(() => {
    onAnnounceRef.current = onAnnounce;
  }, [onAnnounce]);

  const announceSent = useCallback((messageId: string) => {
    if (announcedSentIdsRef.current.has(messageId)) return;
    announcedSentIdsRef.current.add(messageId);
    const announcement = "Message sent. Waiting for your agent to check Jazzboard.";
    setStatusAnnouncement(announcement);
    onAnnounceRef.current(announcement);
  }, []);

  const refresh = useCallback(async (replaceInFlight = false) => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (pollControllerRef.current) {
      if (!replaceInFlight) return;
      pollControllerRef.current.abort();
    }
    const controller = new AbortController();
    pollControllerRef.current = controller;
    try {
      const response = await apiRequest<MessageListResponse>(`${messagesUrl}?limit=40`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!mountedRef.current || pollControllerRef.current !== controller) return;
      const previous = messagesRef.current;
      const draft = draftMessageRef.current;
      const reconciled = draft
        ? response.messages.find((message) =>
            message.id === draft.id
            && message.prompt === draft.prompt
            && sameObjectIds(message.context.selection.objectIds, draft.selectedObjectIds))
        : null;
      if (reconciled && draft) {
        draftMessageRef.current = null;
        setSendError(null);
        setPrompt((current) => current.trim() === draft.prompt ? "" : current);
        announceSent(reconciled.id);
      }
      if (previous) {
        const transitions = response.messages.flatMap((message) => {
          const prior = previous.find((candidate) => candidate.id === message.id);
          if (!prior) return [];
          if (prior.state !== message.state) {
            if (message.state === "claimed") return [`Your agent started working on: ${message.prompt}`];
            if (message.state === "answered") return [`Your agent replied: ${statusText(message)}.`];
          }
          if (prior.reply?.id !== message.reply?.id && message.reply) {
            return [`Your agent replied: ${statusText(message)}.`];
          }
          return [];
        });
        if (transitions.length) setStatusAnnouncement(transitions.join(" "));
      }
      messagesRef.current = response.messages;
      setMessages(response.messages);
      setError(null);
    } catch (requestError) {
      if (!(requestError instanceof DOMException && requestError.name === "AbortError") && mountedRef.current) {
        setError(errorMessage(requestError));
      }
    } finally {
      if (pollControllerRef.current === controller) {
        pollControllerRef.current = null;
        if (mountedRef.current) setLoading(false);
      }
    }
  }, [announceSent, messagesUrl]);

  useEffect(() => {
    mountedRef.current = true;
    if (selection.length) textareaRef.current?.focus();
    else closeButtonRef.current?.focus();
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mountedRef.current = false;
      pollControllerRef.current?.abort();
      pollControllerRef.current = null;
      window.clearTimeout(initial);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh, selection.length]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, submitting]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || !selection.length || submitting) return;
    setSubmitting(true);
    setSendError(null);
    pollControllerRef.current?.abort();
    pollControllerRef.current = null;
    setLoading(false);
    let attemptedMessageId: string | null = null;
    try {
      const selectedObjectIds = selection.map((object) => object.id);
      const draft = draftMessageRef.current;
      const sameRequest = draft
        && draft.prompt === cleanPrompt
        && draft.selectedObjectIds.length === selectedObjectIds.length
        && draft.selectedObjectIds.every((objectId, index) => objectId === selectedObjectIds[index]);
      const messageId = sameRequest ? draft.id : `message_${crypto.randomUUID()}`;
      attemptedMessageId = messageId;
      draftMessageRef.current = { id: messageId, prompt: cleanPrompt, selectedObjectIds };
      const response = await apiRequest<{ ok: true; message: AgentMessage }>(messagesUrl, {
        method: "POST",
        body: JSON.stringify({
          messageId,
          prompt: cleanPrompt,
          selectedObjectIds,
        }),
      });
      if (draftMessageRef.current?.id === messageId) draftMessageRef.current = null;
      setSendError(null);
      setMessages((current) => {
        const next = [response.message, ...current.filter((message) => message.id !== response.message.id)];
        messagesRef.current = next;
        return next;
      });
      setPrompt("");
      announceSent(messageId);
      await refresh(true);
      textareaRef.current?.focus();
    } catch (requestError) {
      if (!attemptedMessageId || !announcedSentIdsRef.current.has(attemptedMessageId)) {
        setSendError(errorMessage(requestError));
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <aside id={ASK_AGENT_PANEL_ID} className={styles.panel} aria-label="Ask your agent">
      <div className={styles.heading}>
        <span className={styles.headingIcon}><MessageCircleQuestion size={17} /></span>
        <div><span>Private agent inbox</span><strong>Ask your agent</strong></div>
        <button ref={closeButtonRef} className={styles.closeButton} onClick={onClose} aria-label="Close Ask your agent"><X size={16} /></button>
      </div>

      <form className={styles.composer} onSubmit={(event) => void submit(event)}>
        <label htmlFor="ask-agent-prompt">What should your agent do?</label>
        <textarea
          ref={textareaRef}
          id="ask-agent-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          maxLength={10_000}
          rows={3}
          placeholder={selection.length ? "Review these items, answer a question, or make a change…" : "Select one or more canvas items to include as context."}
          disabled={!selection.length || submitting}
          aria-describedby="ask-agent-composer-help"
        />
        <div className={styles.composerMeta} id="ask-agent-composer-help">
          <span>{selection.length ? "This prompt is visible only to your agent." : "Select a canvas item, close this panel, then open Ask again."}</span>
          <span>⌘/Ctrl + Enter to send</span>
        </div>
        {selection.length ? (
          <div className={styles.context} aria-label="Selected context">
            {selection.map((object) => (
              <span className={styles.contextChip} key={object.id} title={object.id}>
                {objectLabel(object)} <small>r{object.revision}</small>
              </span>
            ))}
          </div>
        ) : (
          <p className={styles.selectionRequired}>A selection is required to send a new message. Your message history is still available below.</p>
        )}
        <div className={styles.composerActions}>
          <button type="button" className={styles.refreshButton} disabled={loading} onClick={() => void refresh(true)}>
            <RefreshCw className={loading ? styles.spin : ""} size={13} /> Refresh
          </button>
          <button type="submit" className={styles.sendButton} disabled={!selection.length || !prompt.trim() || submitting}>
            {submitting ? <LoaderCircle className={styles.spin} size={14} /> : <Send size={14} />}
            {submitting ? "Sending…" : "Send to agent"}
          </button>
        </div>
        {sendError ?? error ? <p className={styles.error} role="alert">{sendError ?? error}</p> : null}
      </form>

      <div className={styles.historyHeading}>
        <strong>Messages</strong>
        <span>{messages.length ? `${messages.length} recent` : "Private to this room"}</span>
      </div>
      <div className={styles.list} aria-busy={loading}>
        {messages.map((message) => {
          const objects = contextObjects(message);
          return (
            <article className={styles.card} key={message.id}>
              <div className={styles.cardTopline}>
                <span className={styles.actorMark} style={{ background: message.author.color }}>{message.author.displayName.slice(0, 1).toUpperCase()}</span>
                <div><strong>{message.author.displayName}</strong><small>{relativeTime(message.createdAt)}</small></div>
                <span className={`${styles.state} ${styles[message.state]}`}>
                  {message.state === "pending" ? <Clock3 size={11} /> : message.state === "claimed" ? <Bot size={11} /> : <CheckCircle2 size={11} />}
                  {message.state}
                </span>
              </div>
              <p className={styles.prompt}>{message.prompt}</p>
              {objects.length ? (
                <div className={styles.context} aria-label="Message context">
                  {objects.map((object) => (
                    <span className={styles.contextChip} key={object.id} title={object.id}>
                      {objectLabel(object)} <small>r{object.revision}</small>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className={styles.messageStatus}>
                <span>{statusText(message)}</span>
                {message.context.selection.objectIds.length ? (
                  <button type="button" onClick={() => onFocus(message.context.selection.objectIds)}>
                    <Focus size={12} /> Show context
                  </button>
                ) : null}
              </div>
              {message.reply ? (
                <div className={`${styles.reply} ${styles[message.reply.outcome]}`}>
                  <div>
                    <AgentAvatar
                      className={styles.replyAvatar}
                      displayName={message.reply.author.displayName}
                      participantColor={message.reply.author.color}
                      size={20}
                      motion="none"
                    />
                    <strong>{message.reply.author.displayName}</strong>
                    <span>{message.reply.outcome.replace("_", " ")}</span>
                  </div>
                  <p>{message.reply.text}</p>
                </div>
              ) : null}
            </article>
          );
        })}
        {!messages.length && !loading ? <p className={styles.empty}>No messages yet. Select something on the board and ask your agent about it.</p> : null}
        {loading && !messages.length ? <p className={styles.loading}><LoaderCircle className={styles.spin} size={15} /> Loading messages…</p> : null}
      </div>
      <span className={styles.liveRegion} aria-live="polite">{statusAnnouncement}</span>
    </aside>
  );
}
