import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
  type AgentCanvasDraftSnapshot,
  type AgentDraftCanvasObject,
} from "@/lib/agent-drafts/types";
import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { ActorRef, AgentActivity, Participant, Point, RoomState } from "@/lib/domain/types";

import { CanvasPresenceOverlay } from "./CanvasPresenceOverlay";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const self: Participant = {
  participantId: "participant_self",
  displayName: "Maya Host",
  color: "#5965e8",
  role: "participant",
  joinedAt: 1,
  lastSeenAt: 1,
  connected: true,
  agentActive: false,
  human: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
  agent: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
};

function remoteAgent(cursor: Point, activity: AgentActivity | null = null): Participant {
  return {
    participantId: "participant_orbit",
    displayName: "Orbit Architect",
    color: "#169b7d",
    role: "participant",
    joinedAt: 1,
    lastSeenAt: Date.now(),
    connected: true,
    agentActive: true,
    human: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
    agent: { cursor, viewport: null, lastSeenAt: Date.now(), activity },
  };
}

function roomWithAgent(agent: Participant): RoomState {
  return {
    id: "room_presence",
    code: "BOT234",
    title: "Presence parking",
    roomRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    participants: {
      [self.participantId]: self,
      [agent.participantId]: agent,
    },
    objects: {},
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

const runtime = {
  getViewport: () => ({ x: 0, y: 0, width: 800, height: 600, zoom: 1 }),
  pageToViewport: (point: Point) => ({ ...point }),
  viewportToPage: (point: Point) => ({ ...point }),
  getObjectBounds: () => null,
} as unknown as CanvasRuntime;

const draftAuthor: ActorRef = {
  participantId: "participant_orbit",
  displayName: "Orbit Architect",
  color: "#169b7d",
  kind: "agent",
};

function inactiveRemoteAgent(): Participant {
  const participant = remoteAgent({ x: 100, y: 120 });
  return {
    ...participant,
    agentActive: false,
    agent: { ...participant.agent, cursor: null, activity: null },
  };
}

function draftShape(): AgentDraftCanvasObject {
  return {
    authority: "draft",
    id: "draft-shape",
    kind: "shape",
    x: 120,
    y: 140,
    width: 220,
    height: 110,
    rotation: 0,
    zIndex: 2,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: draftAuthor,
    lastEditedBy: draftAuthor,
    shape: "rectangle",
    nodeType: "service",
    label: "Room API",
    fill: "light-violet",
    stroke: "blue",
  };
}

function agentDraft(input: Partial<AgentCanvasDraftSnapshot> = {}): AgentCanvasDraftSnapshot {
  const now = Date.now();
  return {
    schemaVersion: AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
    id: "draft-working",
    roomId: "room_presence",
    ownerParticipantId: draftAuthor.participantId,
    author: draftAuthor,
    revision: 1,
    baselineRoomRevision: 1,
    status: "active",
    temporaryReferences: {},
    previewObjects: [draftShape()],
    previewDiagrams: [],
    metadata: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 10_000,
    hardExpiresAt: now + 20_000,
    awaitingReview: null,
    ...input,
  };
}

function installPointerGeometry(marker: HTMLElement) {
  const overlay = marker.parentElement as HTMLElement;
  Object.defineProperties(overlay, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
  });
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
    bottom: 600,
    height: 600,
    left: 0,
    right: 800,
    top: 0,
    width: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.defineProperties(marker, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });
  return { releasePointerCapture, setPointerCapture };
}

describe("CanvasPresenceOverlay idle agent parking", () => {
  it("parks an idle agent locally with the keyboard and preserves it across idle room envelopes", () => {
    const initialRoom = roomWithAgent(remoteAgent({ x: 100, y: 120 }));
    const rendered = render(
      <CanvasPresenceOverlay room={initialRoom} runtime={runtime} selfId={self.participantId} />,
    );
    const marker = screen.getByRole("button", { name: /Move Orbit Architect’s idle agent locally/i });

    expect(marker).toHaveAttribute("data-agent-draggable", "true");
    expect(marker).toHaveAttribute("data-local-parked", "false");
    expect(marker).toHaveStyle({ transform: "translate(100px, 120px)" });

    fireEvent.keyDown(marker, { key: "ArrowRight" });
    expect(marker).toHaveAttribute("aria-pressed", "true");
    expect(marker).toHaveStyle({ transform: "translate(108px, 120px)" });

    rendered.rerender(
      <CanvasPresenceOverlay
        room={roomWithAgent(remoteAgent({ x: 300, y: 330 }))}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(marker).toHaveStyle({ transform: "translate(108px, 120px)" });

    fireEvent.keyDown(marker, { key: "Escape" });
    expect(marker).toHaveAttribute("aria-pressed", "false");
    expect(marker).toHaveStyle({ transform: "translate(300px, 330px)" });
  });

  it("gives pointer and assistive-technology activation the same park and restore behavior", () => {
    const rendered = render(
      <CanvasPresenceOverlay
        room={roomWithAgent(remoteAgent({ x: 100, y: 120 }))}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    const marker = screen.getByRole("button", { name: /Move Orbit Architect’s idle agent locally/i });

    fireEvent.click(marker);
    expect(marker).toHaveAttribute("aria-pressed", "true");
    expect(marker).toHaveAccessibleName(/Return Orbit Architect’s idle agent to its live position/i);

    rendered.rerender(
      <CanvasPresenceOverlay
        room={roomWithAgent(remoteAgent({ x: 300, y: 330 }))}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(marker).toHaveStyle({ transform: "translate(100px, 120px)" });

    fireEvent.click(marker);
    expect(marker).toHaveAttribute("aria-pressed", "false");
    expect(marker).toHaveStyle({ transform: "translate(300px, 330px)" });
  });

  it("captures an idle drag without reaching the canvas and restores its prior point on cancel", () => {
    const canvasPointerDown = vi.fn();
    render(
      <div onPointerDown={canvasPointerDown}>
        <CanvasPresenceOverlay
          room={roomWithAgent(remoteAgent({ x: 100, y: 120 }))}
          runtime={runtime}
          selfId={self.participantId}
        />
      </div>,
    );
    const marker = screen.getByRole("button", { name: /Move Orbit Architect’s idle agent locally/i });
    const pointerCapture = installPointerGeometry(marker);

    fireEvent.pointerDown(marker, {
      button: 0,
      clientX: 110,
      clientY: 130,
      isPrimary: true,
      pointerId: 7,
    });
    fireEvent.pointerMove(marker, { clientX: 210, clientY: 230, isPrimary: true, pointerId: 7 });
    fireEvent.pointerUp(marker, { clientX: 210, clientY: 230, isPrimary: true, pointerId: 7 });

    expect(pointerCapture.setPointerCapture).toHaveBeenCalledWith(7);
    expect(pointerCapture.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(canvasPointerDown).not.toHaveBeenCalled();
    expect(marker).toHaveAttribute("data-local-parked", "true");
    expect(marker).toHaveStyle({ transform: "translate(200px, 220px)" });

    fireEvent.pointerDown(marker, {
      button: 0,
      clientX: 210,
      clientY: 230,
      isPrimary: true,
      pointerId: 8,
    });
    fireEvent.pointerMove(marker, { clientX: 280, clientY: 300, isPrimary: true, pointerId: 8 });
    expect(marker).toHaveStyle({ transform: "translate(270px, 290px)" });
    fireEvent.pointerCancel(marker, { clientX: 280, clientY: 300, isPrimary: true, pointerId: 8 });
    expect(marker).toHaveStyle({ transform: "translate(200px, 220px)" });
  });

  it("immediately clears local parking and pointer interception when the agent starts working", () => {
    const idleRoom = roomWithAgent(remoteAgent({ x: 100, y: 120 }));
    const rendered = render(
      <CanvasPresenceOverlay room={idleRoom} runtime={runtime} selfId={self.participantId} />,
    );
    const idleMarker = screen.getByRole("button", { name: /Move Orbit Architect’s idle agent locally/i });
    fireEvent.keyDown(idleMarker, { key: "ArrowDown", shiftKey: true });
    expect(idleMarker).toHaveStyle({ transform: "translate(100px, 152px)" });

    const activity: AgentActivity = {
      id: "activity_working",
      type: "creating",
      label: "Building the flow",
      objectIds: [],
      progress: 0.4,
      startedAt: Date.now(),
      durationMs: 10_000,
      fromCursor: { x: 300, y: 310 },
      toCursor: { x: 340, y: 350 },
    };
    rendered.rerender(
      <CanvasPresenceOverlay
        room={roomWithAgent(remoteAgent({ x: 340, y: 350 }, activity))}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    const workingMarker = screen.getByTestId("agent-cursor-participant_orbit");
    expect(workingMarker.tagName).toBe("DIV");
    expect(workingMarker).toHaveAttribute("aria-hidden", "true");
    expect(workingMarker).toHaveAttribute("data-working", "true");
    expect(workingMarker).toHaveAttribute("data-local-parked", "false");
    expect(screen.queryByRole("button", { name: /Move Orbit Architect’s idle agent locally/i })).toBeNull();
  });

  it("does not resurrect parking when a resumed activity reuses an earlier activity ID", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_002_000);
    const expiredActivity: AgentActivity = {
      id: "activity_reused",
      type: "moving",
      label: "Earlier arrangement",
      objectIds: [],
      progress: 1,
      startedAt: 1_000_000,
      durationMs: 100,
      fromCursor: { x: 100, y: 120 },
      toCursor: { x: 100, y: 120 },
    };
    const rendered = render(
      <CanvasPresenceOverlay
        room={roomWithAgent(remoteAgent({ x: 100, y: 120 }, expiredActivity))}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    const marker = screen.getByRole("button", { name: /Move Orbit Architect’s idle agent locally/i });
    fireEvent.keyDown(marker, { key: "ArrowRight" });
    expect(marker).toHaveStyle({ transform: "translate(108px, 120px)" });

    const resumedActivity = {
      ...expiredActivity,
      label: "Resumed arrangement",
      progress: 0,
      startedAt: 1_002_000,
      durationMs: 10_000,
      fromCursor: { x: 300, y: 310 },
      toCursor: { x: 340, y: 350 },
    };
    rendered.rerender(
      <CanvasPresenceOverlay
        room={roomWithAgent(remoteAgent({ x: 340, y: 350 }, resumedActivity))}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(screen.getByTestId("agent-cursor-participant_orbit")).toHaveAttribute("data-working", "true");

    act(() => { vi.advanceTimersByTime(12_000); });
    const returnedIdleMarker = screen.getByRole("button", { name: /Move Orbit Architect’s idle agent locally/i });
    expect(returnedIdleMarker).toHaveAttribute("data-local-parked", "false");
    expect(returnedIdleMarker).toHaveStyle({ transform: "translate(340px, 350px)" });
  });

  it("lets a participant park their own idle agent without exposing other presence visuals", () => {
    const agent = remoteAgent({ x: 140, y: 160 });
    const rendered = render(
      <CanvasPresenceOverlay room={roomWithAgent(agent)} runtime={runtime} selfId={agent.participantId} />,
    );

    expect(screen.getByRole("button", { name: /Move Orbit Architect’s idle agent locally/i })).toBeVisible();
    expect(rendered.container.firstElementChild).not.toHaveAttribute("aria-hidden");
  });
});

describe("CanvasPresenceOverlay draft-working presence", () => {
  it("shows an inactive participant's unique bot thinking near active candidate work", () => {
    const agent = inactiveRemoteAgent();
    const { container } = render(
      <CanvasPresenceOverlay
        agentDrafts={[agentDraft()]}
        room={roomWithAgent(agent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    const marker = screen.getByTestId("agent-cursor-participant_orbit");
    expect(marker.tagName).toBe("DIV");
    expect(marker).toHaveAttribute("aria-hidden", "true");
    expect(marker).toHaveAttribute("data-working", "true");
    expect(marker).toHaveStyle({ transform: "translate(356px, 266px)" });
    expect(marker).toHaveTextContent("Orbit Architect · agent · Drafting preview · not saved");
    expect(container.querySelector('[data-agent-avatar-state="working"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Move Orbit Architect’s idle agent locally/i })).toBeNull();
  });

  it("uses a truthful validating label while committing", () => {
    const agent = inactiveRemoteAgent();
    render(
      <CanvasPresenceOverlay
        agentDrafts={[agentDraft({ status: "committing" })]}
        room={roomWithAgent(agent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    expect(screen.getByTestId("agent-cursor-participant_orbit")).toHaveTextContent(
      "Orbit Architect · agent · Validating draft · not saved",
    );
  });

  it("keeps a canonical in-flight activity authoritative over its draft hint", () => {
    vi.useFakeTimers();
    vi.setSystemTime(8_000);
    const activity: AgentActivity = {
      id: "activity-canonical",
      type: "creating",
      label: "Building the flow",
      objectIds: [],
      progress: 0,
      startedAt: 8_000,
      durationMs: 10_000,
      fromCursor: { x: 300, y: 310 },
      toCursor: { x: 340, y: 350 },
    };
    render(
      <CanvasPresenceOverlay
        agentDrafts={[agentDraft()]}
        room={roomWithAgent(remoteAgent({ x: 340, y: 350 }, activity))}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    const marker = screen.getByTestId("agent-cursor-participant_orbit");
    expect(marker).toHaveStyle({ transform: "translate(300px, 310px)" });
    expect(marker).toHaveTextContent("Building the flow · 0%");
    expect(marker).not.toHaveTextContent("Drafting preview");
  });

  it("does not make an awaiting-review or expired draft look actively worked", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const agent = inactiveRemoteAgent();
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[agentDraft({ status: "awaiting_review" })]}
        room={roomWithAgent(agent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(screen.queryByTestId("agent-cursor-participant_orbit")).toBeNull();

    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[agentDraft({ expiresAt: 4_999, hardExpiresAt: 10_000 })]}
        room={roomWithAgent(agent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(screen.queryByTestId("agent-cursor-participant_orbit")).toBeNull();
  });

  it("clears local idle parking while drafting and returns unparked after the draft ends", () => {
    const idleRoom = roomWithAgent(remoteAgent({ x: 100, y: 120 }));
    const rendered = render(
      <CanvasPresenceOverlay room={idleRoom} runtime={runtime} selfId={self.participantId} />,
    );
    const idleMarker = screen.getByRole("button", { name: /Move Orbit Architect’s idle agent locally/i });
    fireEvent.keyDown(idleMarker, { key: "ArrowRight" });
    expect(idleMarker).toHaveStyle({ transform: "translate(108px, 120px)" });

    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[agentDraft()]}
        room={idleRoom}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(screen.getByTestId("agent-cursor-participant_orbit")).toHaveAttribute("data-working", "true");

    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[]}
        room={idleRoom}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    const returnedIdleMarker = screen.getByRole("button", { name: /Move Orbit Architect’s idle agent locally/i });
    expect(returnedIdleMarker).toHaveAttribute("data-local-parked", "false");
    expect(returnedIdleMarker).toHaveStyle({ transform: "translate(100px, 120px)" });
  });
});
