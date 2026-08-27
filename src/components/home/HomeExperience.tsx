"use client";

import {
  ArrowRight,
  Bot,
  Clock3,
  Eye,
  Loader2,
  MousePointer2,
  PencilLine,
  Radio,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { JazzboardLogo } from "@/components/brand/JazzboardLogo";
import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import {
  persistDisplayName,
  readDisplayName,
  readRecentRooms,
  removeRecentRoom as removeStoredRecentRoom,
  touchRecentRoom,
  upsertRecentRoom,
} from "@/lib/client/recent-rooms";
import { roomInviteCodeFromHash } from "@/lib/client/room-invite";
import type { RecentRoom, RoomRole } from "@/lib/domain/types";
import {
  attachLandingWebMcpContext,
  detachLandingWebMcpContext,
  JAZZBOARD_RECENT_ROOMS_EVENT,
} from "@/lib/webmcp/landing-bootstrap";
import { JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES } from "@/lib/webmcp/landing-tools";
import type { JazzboardLandingWebMcpRegistrationStatus } from "@/lib/webmcp/landing-types";

type EntryMode = "create" | "join";
type BusyAction = EntryMode | null;

type SuccessfulRoomResponse = {
  ok: true;
  participantId: string;
  room: {
    id: string;
    code: string;
    title: string;
  };
};

type AuthorizedRecentRoomResponse = {
  ok: true;
  participantId: string;
  room: SuccessfulRoomResponse["room"] & {
    participants: Record<string, { role: RoomRole }>;
  };
};

function formatLastOpened(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}

function roleLabel(role: RoomRole): string {
  return role === "participant" ? "Participant" : "Spectator";
}

async function postRoom(body: Record<string, unknown>): Promise<SuccessfulRoomResponse> {
  try {
    return await apiRequest<SuccessfulRoomResponse>("/api/rooms", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof JazzboardApiError) throw error;
    throw new Error("Jazzboard could not reach the room service. Check your connection and try again.");
  }
}

async function readAuthorizedRecentRooms(signal: AbortSignal): Promise<RecentRoom[]> {
  const candidates = readRecentRooms();
  const verified = await Promise.all(
    candidates.map(async (candidate): Promise<RecentRoom | null> => {
      try {
        const payload = await apiRequest<AuthorizedRecentRoomResponse>(
          `/api/rooms/${encodeURIComponent(candidate.roomId)}`,
          { signal },
        );
        const role = payload.room.participants[payload.participantId]?.role;
        if (
          payload.ok !== true ||
          payload.room.id !== candidate.roomId ||
          (role !== "participant" && role !== "spectator")
        ) {
          return null;
        }
        return {
          roomId: payload.room.id,
          code: payload.room.code,
          title: payload.room.title,
          role,
          lastOpenedAt: candidate.lastOpenedAt,
        };
      } catch {
        return null;
      }
    }),
  );
  signal.throwIfAborted();
  return verified.filter((room): room is RecentRoom => room !== null);
}

function HeroCanvasPreview() {
  return (
    <div aria-hidden="true" className="hero-board">
      <div className="hero-board__chrome">
        <span />
        <span />
        <span />
        <div className="hero-board__presence">
          <i />
          <i />
          <b>+2</b>
        </div>
      </div>

      <div className="preview-image-card">
        <div className="preview-image-card__bar" />
        <div className="preview-image-card__hero" />
        <div className="preview-image-card__lines">
          <span />
          <span />
          <span />
        </div>
        <div className="preview-markup" />
      </div>

      <svg className="preview-connector" viewBox="0 0 160 72">
        <path d="M4 48C54 48 68 13 143 13" />
        <path d="m136 7 9 6-9 7" />
      </svg>

      <div className="preview-node preview-node--first">
        <span className="preview-node__dot" />
        <strong>Faster handoff</strong>
        <small>One shared model</small>
      </div>
      <div className="preview-node preview-node--second">
        <Sparkles size={13} strokeWidth={2.4} />
        <span>Agent mapping flow</span>
      </div>

      <div className="preview-cursor preview-cursor--human">
        <MousePointer2 fill="currentColor" size={18} strokeWidth={2} />
        <span>Maya</span>
      </div>
      <div className="preview-cursor preview-cursor--agent">
        <span className="preview-agent-pointer">
          <Bot size={13} strokeWidth={2.4} />
        </span>
        <span>Devon · agent</span>
      </div>
      <div className="preview-live-pill">
        <Radio size={12} />
        Live canvas
      </div>
    </div>
  );
}

type EntryCardProps = {
  onEnteredRoom: (response: SuccessfulRoomResponse, role: RoomRole) => void;
};

function RoomEntryCard({ onEnteredRoom }: EntryCardProps) {
  const [mode, setMode] = useState<EntryMode>("create");
  const [displayName, setDisplayName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [role, setRole] = useState<RoomRole>("participant");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let inviteFrame: number | null = null;
    const timer = window.setTimeout(() => {
      setDisplayName(readDisplayName());
      const invitedCode = roomInviteCodeFromHash(window.location.hash);
      if (invitedCode) {
        setMode("join");
        // Mount the join field before assigning its fragment-provided value.
        // Some browsers restore one-time-code fields immediately after mount;
        // a next-frame controlled update keeps that restoration from clearing
        // a valid private invite code.
        inviteFrame = window.requestAnimationFrame(() => setJoinCode(invitedCode));
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (inviteFrame !== null) window.cancelAnimationFrame(inviteFrame);
    };
  }, []);

  function selectMode(nextMode: EntryMode): void {
    if (busy) return;
    setMode(nextMode);
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const name = displayName.trim();
    const code = joinCode.trim();

    if (!name) {
      setError("Enter the name collaborators should see in the room.");
      return;
    }
    if (mode === "join" && !/^\d{4}$/.test(code)) {
      setError("Enter the four-digit Jazzboard code.");
      return;
    }

    setBusy(mode);
    setError(null);
    try {
      const response = await postRoom(
        mode === "create"
          ? { action: "create", displayName: name, title: "Untitled Jazzboard" }
          : { action: "join", code, displayName: name, role },
      );
      persistDisplayName(name);
      onEnteredRoom(response, mode === "create" ? "participant" : role);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Jazzboard could not open that room.");
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="room-entry-title" className="entry-card">
      <div className="entry-card__heading">
        <span className="entry-card__eyebrow">Start collaborating</span>
        <h2 id="room-entry-title">Open a Jazzboard</h2>
      </div>

      <div aria-label="Choose how to enter" className="entry-tabs" role="tablist">
        <button
          aria-controls="create-room-panel"
          aria-selected={mode === "create"}
          className="entry-tab"
          disabled={Boolean(busy)}
          id="create-room-tab"
          onClick={() => selectMode("create")}
          role="tab"
          type="button"
        >
          Create a room
        </button>
        <button
          aria-controls="join-room-panel"
          aria-selected={mode === "join"}
          className="entry-tab"
          disabled={Boolean(busy)}
          id="join-room-tab"
          onClick={() => selectMode("join")}
          role="tab"
          type="button"
        >
          Join by code
        </button>
      </div>

      <form
        aria-busy={Boolean(busy)}
        aria-labelledby={mode === "create" ? "create-room-tab" : "join-room-tab"}
        className="entry-form"
        id={mode === "create" ? "create-room-panel" : "join-room-panel"}
        onSubmit={submit}
        role="tabpanel"
      >
        {mode === "join" ? (
          <label className="field-group" htmlFor="room-code">
            <span className="field-label">Room code</span>
            <span className="code-input-wrap">
              <input
                aria-describedby="room-code-hint"
                autoComplete="one-time-code"
                className="code-input"
                id="room-code"
                inputMode="numeric"
                maxLength={4}
                name="room-code"
                onChange={(event) => setJoinCode(event.target.value.replace(/\D/g, "").slice(0, 4))}
                pattern="[0-9]{4}"
                placeholder="0000"
                required
                type="text"
                value={joinCode}
              />
            </span>
            <small className="field-hint" id="room-code-hint">
              Ask someone in the room for its four-digit code.
            </small>
          </label>
        ) : (
          <p className="entry-form__intro">
            Create a fresh infinite canvas and share its four-digit code when you are ready.
          </p>
        )}

        <label className="field-group" htmlFor="display-name">
          <span className="field-label">Your display name</span>
          <input
            autoCapitalize="words"
            autoComplete="name"
            className="text-input"
            id="display-name"
            maxLength={48}
            name="display-name"
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="e.g. Maya Chen"
            required
            type="text"
            value={displayName}
          />
          <small className="field-hint">This is how people and agents identify you.</small>
        </label>

        {mode === "join" ? (
          <fieldset className="role-picker">
            <legend>Join as</legend>
            <div className="role-options">
              <label className={`role-option${role === "participant" ? " role-option--selected" : ""}`}>
                <input
                  checked={role === "participant"}
                  name="room-role"
                  onChange={() => setRole("participant")}
                  type="radio"
                  value="participant"
                />
                <span className="role-option__icon">
                  <PencilLine size={17} strokeWidth={2.1} />
                </span>
                <span>
                  <strong>Participant</strong>
                  <small>Edit and bring your agent</small>
                </span>
              </label>
              <label className={`role-option${role === "spectator" ? " role-option--selected" : ""}`}>
                <input
                  checked={role === "spectator"}
                  name="room-role"
                  onChange={() => setRole("spectator")}
                  type="radio"
                  value="spectator"
                />
                <span className="role-option__icon">
                  <Eye size={17} strokeWidth={2.1} />
                </span>
                <span>
                  <strong>Spectator</strong>
                  <small>Watch and follow only</small>
                </span>
              </label>
            </div>
          </fieldset>
        ) : null}

        <div aria-live="polite" className={`form-notice${error ? " form-notice--error" : ""}`} role="status">
          {error ?? ""}
        </div>

        <button className="primary-button" disabled={Boolean(busy)} type="submit">
          {busy === mode ? (
            <>
              <Loader2 aria-hidden="true" className="spin" size={18} />
              {mode === "create" ? "Creating room…" : `Joining ${joinCode}…`}
            </>
          ) : (
            <>
              {mode === "create" ? "Create my Jazzboard" : "Join this Jazzboard"}
              <ArrowRight aria-hidden="true" size={18} strokeWidth={2.2} />
            </>
          )}
        </button>
      </form>

      <div className="entry-card__trust">
        <ShieldCheck aria-hidden="true" size={16} strokeWidth={2.1} />
        <span>No account required. Access stays with this secure browser session.</span>
      </div>
    </section>
  );
}

type RecentRoomsProps = {
  loaded: boolean;
  onOpen: (room: RecentRoom) => void;
  onRemove: (room: RecentRoom) => void;
  rooms: RecentRoom[];
};

function RecentRooms({ loaded, onOpen, onRemove, rooms }: RecentRoomsProps) {
  return (
    <section aria-labelledby="recent-heading" className="recent-section">
      <div className="section-heading">
        <div>
          <span className="section-kicker">This browser</span>
          <h2 id="recent-heading">Recent Jazzboards</h2>
        </div>
        <p>Return to server-persisted rooms without entering the code again.</p>
      </div>

      {!loaded ? (
        <div aria-label="Loading recent Jazzboards" className="recent-grid recent-grid--loading">
          <div className="recent-skeleton" />
          <div className="recent-skeleton" />
        </div>
      ) : rooms.length > 0 ? (
        <div className="recent-grid">
          {rooms.map((room) => (
            <article className="recent-card" key={room.roomId}>
              <Link
                aria-label={`Open ${room.title}, room ${room.code}`}
                className="recent-card__link"
                href={`/room/${encodeURIComponent(room.roomId)}`}
                onClick={() => onOpen(room)}
              >
                <span className="recent-card__mark" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="recent-card__content">
                  <strong>{room.title}</strong>
                  <span className="recent-card__meta">
                    <code>{room.code}</code>
                    <i aria-hidden="true" />
                    {formatLastOpened(room.lastOpenedAt)}
                  </span>
                </span>
                <span className={`role-badge role-badge--${room.role}`}>{roleLabel(room.role)}</span>
                <ArrowRight aria-hidden="true" className="recent-card__arrow" size={18} />
              </Link>
              <button
                aria-label={`Remove ${room.title} from this browser`}
                className="recent-card__remove"
                onClick={() => onRemove(room)}
                title="Remove from this browser"
                type="button"
              >
                <Trash2 aria-hidden="true" size={15} strokeWidth={2} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="recent-empty">
          <span className="recent-empty__icon">
            <Clock3 aria-hidden="true" size={20} strokeWidth={2} />
          </span>
          <div>
            <strong>Your boards will wait here.</strong>
            <p>Create or join a room and Jazzboard will remember the shortcut on this browser.</p>
          </div>
        </div>
      )}
    </section>
  );
}

export function HomeExperience() {
  const router = useRouter();
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>([]);
  const [recentsLoaded, setRecentsLoaded] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [webMcpStatus, setWebMcpStatus] = useState<JazzboardLandingWebMcpRegistrationStatus | null>(null);
  const webMcpContext = useMemo(
    () => ({
      acceptRecentRooms: (rooms: RecentRoom[]) => setRecentRooms(rooms),
      navigateToRoom: (roomId: string) => router.push(`/room/${encodeURIComponent(roomId)}`),
    }),
    [router],
  );

  useEffect(() => {
    const controller = new AbortController();
    void readAuthorizedRecentRooms(controller.signal)
      .then((rooms) => {
        setRecentRooms(rooms);
        setRecentsLoaded(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRecentsLoaded(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const acceptBootstrapRecents = (event: CustomEvent<RecentRoom[]>) => {
      setRecentRooms(event.detail);
    };
    window.addEventListener(JAZZBOARD_RECENT_ROOMS_EVENT, acceptBootstrapRecents);
    let disposed = false;
    void attachLandingWebMcpContext(webMcpContext)
      .then((status) => {
        if (!disposed) setWebMcpStatus(status);
      })
      .catch(() => {
        if (!disposed) {
          setWebMcpStatus({ supported: false, registeredToolNames: [] });
          setStatusMessage("AI room controls could not be registered in this browser.");
        }
      });
    return () => {
      disposed = true;
      window.removeEventListener(JAZZBOARD_RECENT_ROOMS_EVENT, acceptBootstrapRecents);
      detachLandingWebMcpContext(webMcpContext);
    };
  }, [webMcpContext]);

  function enterRoom(response: SuccessfulRoomResponse, role: RoomRole): void {
    const nextRoom: RecentRoom = {
      roomId: response.room.id,
      code: response.room.code,
      title: response.room.title,
      role,
      lastOpenedAt: Date.now(),
    };
    const recent = upsertRecentRoom(nextRoom);
    setRecentRooms(recent.rooms);
    router.push(`/room/${encodeURIComponent(response.room.id)}`);
  }

  function openRecent(room: RecentRoom): void {
    const recent = touchRecentRoom(room.roomId, Date.now());
    if (recent) setRecentRooms(recent.rooms);
  }

  function removeRecent(room: RecentRoom): void {
    const recent = removeStoredRecentRoom(room.roomId);
    setRecentRooms(recent.rooms);
    setStatusMessage(`${room.title} was removed from this browser. The shared room was not deleted.`);
  }

  return (
    <main className="home-page">
      <div className="home-grid-pattern" aria-hidden="true" />
      <header className="home-header">
        <Link aria-label="Jazzboard home" className="home-brand-link" href="/">
          <JazzboardLogo />
        </Link>
        <div className="home-header__signals">
          <div
            className={`home-header__agent-status ${webMcpStatus?.registeredToolNames.length ? "is-ready" : ""}`}
            title="Browser-exposed WebMCP lifecycle tools"
          >
            <Bot aria-hidden="true" size={14} />
            {webMcpStatus?.registeredToolNames.length
              ? `Agent ready · ${webMcpStatus.registeredToolNames.length} tools`
              : webMcpStatus?.supported
                ? "Agent tools loading"
                : `WebMCP-enabled · ${JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES.length} tools`}
          </div>
          <div className="home-header__status">
            <span aria-hidden="true" />
            No account required
          </div>
        </div>
      </header>

      <section className="home-hero">
        <div className="hero-copy">
          <div className="hero-eyebrow">
            <Sparkles aria-hidden="true" size={15} strokeWidth={2.3} />
            Multiplayer thinking, in the open
          </div>
          <h1>
            Make room for
            <span> every idea.</span>
          </h1>
          <p className="hero-lede">
            A shared architecture canvas where people and AI collaborators think, diagram, and edit together in real
            time—from text, voice, or another agent interface.
          </p>
          <div className="hero-points" aria-label="Jazzboard highlights">
            <span>
              <Users aria-hidden="true" size={16} />
              People + their agents
            </span>
            <span>
              <MousePointer2 aria-hidden="true" size={16} />
              One live canvas
            </span>
            <span>
              <Radio aria-hidden="true" size={16} />
              Follow or Spotlight
            </span>
          </div>
          <HeroCanvasPreview />
        </div>

        <div className="entry-column">
          <RoomEntryCard onEnteredRoom={enterRoom} />
          <p className="entry-column__note">
            Jazzboard provides the shared room. Each participant brings the intelligence.
          </p>
        </div>
      </section>

      <RecentRooms loaded={recentsLoaded} onOpen={openRecent} onRemove={removeRecent} rooms={recentRooms} />

      <footer className="home-footer">
        <JazzboardLogo />
        <p>Collaborative architecture, played live.</p>
      </footer>
      <div aria-live="polite" className="sr-only" role="status">
        {statusMessage}
      </div>
    </main>
  );
}
