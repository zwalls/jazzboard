import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
  type AgentCanvasDraftSnapshot,
  type AgentDraftCanvasObject,
} from "@/lib/agent-drafts/types";
import type { CanvasRuntime } from "@/lib/canvas/runtime";
import { agentDraftObjectFingerprint } from "@/lib/canvas/agent-draft-choreography";
import { AgentDraftRevealRegistry } from "@/lib/canvas/agent-draft-reveal";
import type { ActorRef, AgentActivity, Participant, Point, RoomState } from "@/lib/domain/types";

import { CanvasPresenceOverlay } from "./CanvasPresenceOverlay";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

function draftShape(
  input: Partial<Extract<AgentDraftCanvasObject, { kind: "shape" }>> = {},
): Extract<AgentDraftCanvasObject, { kind: "shape" }> {
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
    ...input,
  };
}

function installAnimationFrames() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  const cancelledCallbacks: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    const callback = callbacks.get(id);
    if (callback) cancelledCallbacks.push(callback);
    callbacks.delete(id);
    cancelled.push(id);
  });
  return {
    cancelled,
    flush(timestamp: number) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      act(() => pending.forEach((callback) => callback(timestamp)));
    },
    pending: () => callbacks.size,
    runCancelled(timestamp: number) {
      act(() => cancelledCallbacks.forEach((callback) => callback(timestamp)));
    },
  };
}

function translatedPoint(element: HTMLElement): Point {
  const match = element.style.transform.match(/^translate\(([-\d.]+)px, ([-\d.]+)px\)$/);
  if (!match) throw new Error(`Expected a pixel translate, received ${element.style.transform}.`);
  return { x: Number(match[1]), y: Number(match[2]) };
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
  it("starts an inactive participant's unique bot on a real construction path", () => {
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
    expect(marker).toHaveStyle({ transform: "translate(400px, 300px)" });
    expect(marker).toHaveAttribute("data-agent-draft-choreography", "true");
    expect(marker).toHaveAttribute("data-agent-draft-choreography-phase", "travel");
    expect(marker).toHaveAttribute("data-agent-draft-choreography-object-id", "draft-shape");
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

  it("does not remount or jump when an active draft starts committing", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const animation = installAnimationFrames();
    const agent = inactiveRemoteAgent();
    const room = roomWithAgent(agent);
    const active = agentDraft();
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[active]}
        room={room}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    const marker = screen.getByTestId("agent-cursor-participant_orbit");
    now = 70;
    animation.flush(now);
    const before = marker.style.transform;

    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[agentDraft({
          revision: active.revision + 1,
          status: "committing",
          updatedAt: active.updatedAt + 1,
        })]}
        room={room}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    const validating = screen.getByTestId("agent-cursor-participant_orbit");
    expect(validating).toBe(marker);
    expect(validating.style.transform).toBe(before);
    expect(validating).toHaveTextContent("Validating draft · not saved");
    expect(animation.pending()).toBe(1);
  });

  it("travels through intermediate positions and outlines the authored object without React frame state", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const animation = installAnimationFrames();
    const agent = inactiveRemoteAgent();
    render(
      <CanvasPresenceOverlay
        agentDrafts={[agentDraft()]}
        room={roomWithAgent(agent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    const marker = screen.getByTestId("agent-cursor-participant_orbit");
    const start = marker.style.transform;
    expect(animation.pending()).toBe(1);

    now = 60;
    animation.flush(now);
    const travelMidpoint = marker.style.transform;
    expect(travelMidpoint).not.toBe(start);
    expect(marker).toHaveAttribute("data-agent-draft-choreography-phase", "travel");

    now = 480;
    animation.flush(now);
    expect(marker.style.transform).not.toBe(travelMidpoint);
    expect(marker).toHaveAttribute("data-agent-draft-choreography-phase", "outline");
    expect(marker).toHaveAttribute("data-agent-draft-choreography-object-id", "draft-shape");

    now = 720;
    animation.flush(now);
    expect(marker.style.transform).not.toBe(travelMidpoint);
    expect(marker).toHaveAttribute("data-agent-draft-choreography-phase", "outline");
  });

  it("drives artwork reveal from the same frame clock and settles it when canonical activity takes over", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const animation = installAnimationFrames();
    const agent = inactiveRemoteAgent();
    const candidate = agentDraft();
    const revealRegistry = new AgentDraftRevealRegistry();
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[candidate]}
        revealRegistry={revealRegistry}
        room={roomWithAgent(agent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(revealRegistry.snapshot(candidate.id, "draft-shape")?.state).toBe("pending");

    now = 480;
    animation.flush(now);
    expect(revealRegistry.snapshot(candidate.id, "draft-shape")).toMatchObject({
      state: "active",
      phase: "outline",
    });
    const activity: AgentActivity = {
      id: "activity-authoritative",
      type: "creating",
      label: "Applying the draft",
      objectIds: [],
      progress: 0,
      startedAt: Date.now(),
      durationMs: 5_000,
      fromCursor: { x: 300, y: 300 },
      toCursor: { x: 340, y: 340 },
    };
    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[candidate]}
        revealRegistry={revealRegistry}
        room={roomWithAgent(remoteAgent({ x: 340, y: 340 }, activity))}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(revealRegistry.snapshot(candidate.id, "draft-shape")?.state).toBe("complete");
  });

  it("does not replay the initial draft baseline but animates work appended afterward", () => {
    const now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const animation = installAnimationFrames();
    const agent = inactiveRemoteAgent();
    const room = roomWithAgent(agent);
    const baseline = agentDraft();
    const initiallySettledDraftIds = new Set([baseline.id]);
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[baseline]}
        initiallySettledDraftIds={initiallySettledDraftIds}
        room={room}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    const marker = screen.getByTestId("agent-cursor-participant_orbit");
    expect(marker).toHaveAttribute("data-agent-draft-choreography-phase", "inspect");
    expect(marker).toHaveAttribute("data-agent-draft-choreography-object-id", "");
    expect(animation.pending()).toBe(0);

    const appended = draftShape({
      id: "draft-shape-new",
      label: "New work",
      x: 460,
      y: 260,
      zIndex: 3,
    });
    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[agentDraft({
          previewObjects: [draftShape(), appended],
          revision: baseline.revision + 1,
          updatedAt: baseline.updatedAt + 1,
        })]}
        initiallySettledDraftIds={initiallySettledDraftIds}
        room={room}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    expect(screen.getByTestId("agent-cursor-participant_orbit")).toBe(marker);
    expect(marker).toHaveAttribute("data-agent-draft-choreography-object-id", appended.id);
    expect(animation.pending()).toBe(1);
  });

  it("seeds a remounted cursor from already-complete artwork without suppressing a later edit", () => {
    const now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const animation = installAnimationFrames();
    const agent = inactiveRemoteAgent();
    const room = roomWithAgent(agent);
    const baselineShape = draftShape();
    const baseline = agentDraft({ previewObjects: [baselineShape] });
    const revealRegistry = new AgentDraftRevealRegistry();
    revealRegistry.syncRenderedDraft({
      draftId: baseline.id,
      objects: [{
        objectId: baselineShape.id,
        fingerprint: agentDraftObjectFingerprint(baselineShape),
      }],
      revealImmediately: true,
      seedComplete: false,
    });

    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[baseline]}
        revealRegistry={revealRegistry}
        room={room}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    const marker = screen.getByTestId("agent-cursor-participant_orbit");
    expect(marker).toHaveAttribute("data-agent-draft-choreography-phase", "inspect");
    expect(animation.pending()).toBe(0);

    const changedShape = draftShape({
      label: "Room API updated",
      revision: baselineShape.revision + 1,
      updatedAt: baselineShape.updatedAt + 1,
    });
    const changed = agentDraft({
      previewObjects: [changedShape],
      revision: baseline.revision + 1,
      updatedAt: baseline.updatedAt + 1,
    });
    revealRegistry.syncRenderedDraft({
      draftId: changed.id,
      objects: [{
        objectId: changedShape.id,
        fingerprint: agentDraftObjectFingerprint(changedShape),
      }],
      revealImmediately: false,
      seedComplete: false,
    });
    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[changed]}
        revealRegistry={revealRegistry}
        room={room}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    expect(screen.getByTestId("agent-cursor-participant_orbit")).toBe(marker);
    expect(marker).toHaveAttribute("data-agent-draft-choreography-object-id", changedShape.id);
    expect(animation.pending()).toBe(1);
    expect(revealRegistry.snapshot(changed.id, changedShape.id)?.state).toBe("pending");
  });

  it("keeps the same bot at the same pixel while a cumulative revision appends more work", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const animation = installAnimationFrames();
    const agent = inactiveRemoteAgent();
    const room = roomWithAgent(agent);
    const firstDraft = agentDraft();
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[firstDraft]}
        room={room}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    const marker = screen.getByTestId("agent-cursor-participant_orbit");

    now = 70;
    animation.flush(now);
    const before = marker.style.transform;
    const secondShape = draftShape({
      id: "draft-shape-2",
      x: 440,
      y: 280,
      label: "Storage",
      zIndex: 3,
    });
    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[agentDraft({
          revision: 2,
          updatedAt: firstDraft.updatedAt + 1,
          previewObjects: [draftShape(), secondShape],
        })]}
        room={room}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    const sameMarker = screen.getByTestId("agent-cursor-participant_orbit");
    expect(sameMarker).toBe(marker);
    expect(sameMarker.style.transform).toBe(before);

    const observedIds = new Set<string>();
    for (now = 120; now <= 8_000 && animation.pending(); now += 80) {
      animation.flush(now);
      const objectId = sameMarker.dataset.agentDraftChoreographyObjectId;
      if (objectId) observedIds.add(objectId);
    }
    expect(observedIds).toContain("draft-shape-2");
  });

  it("keeps simultaneous draft coordinators isolated when one participant finishes", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const animation = installAnimationFrames();
    const firstAgent = inactiveRemoteAgent();
    const secondAgent: Participant = {
      ...inactiveRemoteAgent(),
      participantId: "participant_nova",
      displayName: "Nova Builder",
      color: "#d97706",
    };
    const secondAuthor: ActorRef = {
      participantId: secondAgent.participantId,
      displayName: secondAgent.displayName,
      color: secondAgent.color,
      kind: "agent",
    };
    const room = {
      ...roomWithAgent(firstAgent),
      participants: {
        ...roomWithAgent(firstAgent).participants,
        [secondAgent.participantId]: secondAgent,
      },
    };
    const firstDraft = agentDraft();
    const secondDraft = agentDraft({
      id: "draft-nova",
      ownerParticipantId: secondAgent.participantId,
      author: secondAuthor,
      previewObjects: [draftShape({
        id: "draft-shape-nova",
        createdBy: secondAuthor,
        lastEditedBy: secondAuthor,
        x: 520,
      })],
    });
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[firstDraft, secondDraft]}
        room={room}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(animation.pending()).toBe(2);
    now = 70;
    animation.flush(now);
    const survivor = screen.getByTestId("agent-cursor-participant_nova");
    const before = survivor.style.transform;

    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[secondDraft]}
        room={room}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(screen.queryByTestId("agent-cursor-participant_orbit")).toBeNull();
    expect(screen.getByTestId("agent-cursor-participant_nova")).toBe(survivor);
    expect(animation.pending()).toBe(1);

    now = 140;
    animation.flush(now);
    expect(survivor.style.transform).not.toBe(before);
    expect(animation.pending()).toBe(1);
  });

  it("honors reduced motion with one static inspection pose and no animation loop", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const animation = installAnimationFrames();
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
    expect(marker).toHaveAttribute("data-agent-draft-choreography-phase", "inspect");
    expect(marker).toHaveAttribute("data-activity-progress", "100");
    expect(container.querySelector('[data-agent-avatar-motion="none"]')).not.toBeNull();
    expect(animation.pending()).toBe(0);
  });

  it("finishes active playback in a static inspection pose when the document becomes hidden", () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.spyOn(performance, "now").mockReturnValue(0);
    const animation = installAnimationFrames();
    const agent = inactiveRemoteAgent();
    render(
      <CanvasPresenceOverlay
        agentDrafts={[agentDraft()]}
        room={roomWithAgent(agent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(animation.pending()).toBe(1);

    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    const marker = screen.getByTestId("agent-cursor-participant_orbit");
    expect(marker).toHaveAttribute("data-agent-draft-choreography-phase", "inspect");
    expect(marker).toHaveAttribute("data-activity-progress", "100");
    expect(animation.pending()).toBe(0);
    expect(animation.cancelled).toHaveLength(1);
  });

  it("keeps a completed construction pose attached to page space while the camera changes", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    let mutableViewport = { x: 0, y: 0, width: 800, height: 600, zoom: 1 };
    const cameraRuntime = {
      ...runtime,
      getViewport: () => mutableViewport,
      pageToViewport: (point: Point) => ({
        x: (point.x - mutableViewport.x) * mutableViewport.zoom,
        y: (point.y - mutableViewport.y) * mutableViewport.zoom,
      }),
    } as unknown as CanvasRuntime;
    const agent = inactiveRemoteAgent();
    const candidate = agentDraft();
    const room = roomWithAgent(agent);
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[candidate]}
        room={room}
        runtime={cameraRuntime}
        selfId={self.participantId}
      />,
    );
    const marker = screen.getByTestId("agent-cursor-participant_orbit");
    expect(marker).toHaveStyle({ transform: "translate(362px, 219.2px)" });

    mutableViewport = { x: 100, y: 50, width: 400, height: 300, zoom: 2 };
    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[candidate]}
        room={room}
        runtime={cameraRuntime}
        selfId={self.participantId}
      />,
    );
    expect(marker).toHaveStyle({ transform: "translate(524px, 338.4px)" });
  });

  it("cancels its only animation frame and ignores late callbacks after commit removal", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const animation = installAnimationFrames();
    const agent = inactiveRemoteAgent();
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[agentDraft()]}
        room={roomWithAgent(agent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(animation.pending()).toBe(1);

    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[]}
        room={roomWithAgent(agent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(screen.queryByTestId("agent-cursor-participant_orbit")).toBeNull();
    expect(animation.pending()).toBe(0);
    expect(animation.cancelled).toHaveLength(1);
    animation.runCancelled(2_000);
    expect(screen.queryByTestId("agent-cursor-participant_orbit")).toBeNull();
    expect(animation.pending()).toBe(0);
  });

  it("cancels playback on unmount and ignores an already-delivered stale frame", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const animation = installAnimationFrames();
    const agent = inactiveRemoteAgent();
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[agentDraft()]}
        room={roomWithAgent(agent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(animation.pending()).toBe(1);

    rendered.unmount();
    expect(animation.pending()).toBe(0);
    expect(animation.cancelled).toHaveLength(1);
    animation.runCancelled(2_000);
    expect(animation.pending()).toBe(0);
    expect(screen.queryByTestId("agent-cursor-participant_orbit")).toBeNull();
  });

  it("cancels draft playback when canonical activity takes over without a duplicate marker", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const animation = installAnimationFrames();
    const agent = inactiveRemoteAgent();
    const candidate = agentDraft();
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[candidate]}
        room={roomWithAgent(agent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(animation.pending()).toBe(1);
    now = 80;
    animation.flush(now);
    const draftMarker = screen.getByTestId("agent-cursor-participant_orbit");
    const beforeHandoff = draftMarker.style.transform;

    const activity: AgentActivity = {
      id: "activity-takeover",
      type: "creating",
      label: "Building the flow",
      objectIds: [],
      progress: 0,
      startedAt: Date.now(),
      durationMs: 10_000,
      fromCursor: { x: 300, y: 310 },
      toCursor: { x: 340, y: 350 },
    };
    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[candidate]}
        room={roomWithAgent(remoteAgent({ x: 340, y: 350 }, activity))}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    const markers = screen.getAllByTestId("agent-cursor-participant_orbit");
    expect(markers).toHaveLength(1);
    expect(markers[0]).not.toHaveAttribute("data-agent-draft-choreography");
    expect(markers[0]).toHaveAttribute("data-agent-handoff", "true");
    expect(markers[0].style.transform).toBe(beforeHandoff);
    expect(markers[0]).toHaveTextContent("Building the flow");
    expect(animation.pending()).toBe(1);
    expect(animation.cancelled).toHaveLength(1);
    animation.runCancelled(2_000);
    expect(animation.pending()).toBe(1);
    now = 96;
    animation.flush(now);
    expect(markers[0]).toHaveAttribute("data-agent-handoff", "true");
    expect(markers[0]).toHaveAttribute("data-agent-handoff-phase", "transition");
    expect(markers[0].style.transform).not.toBe(beforeHandoff);
    const afterFirstFrame = markers[0].style.transform;
    now = 112;
    animation.flush(now);
    expect(markers[0].style.transform).not.toBe(afterFirstFrame);
    expect(markers[0]).toHaveAttribute("data-agent-handoff-phase", "transition");
    expect(animation.pending()).toBe(1);
    expect(screen.getAllByTestId("agent-cursor-participant_orbit")).toHaveLength(1);
  });

  it("hands a committed draft off continuously to an idle canonical agent", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const animation = installAnimationFrames();
    const draftAgent = inactiveRemoteAgent();
    const canonicalAgent = remoteAgent({ x: 100, y: 120 });
    const candidate = agentDraft();
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[candidate]}
        room={roomWithAgent(draftAgent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    now = 80;
    animation.flush(now);
    const beforeHandoff = screen.getByTestId("agent-cursor-participant_orbit").style.transform;

    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[]}
        room={roomWithAgent(draftAgent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(screen.queryByTestId("agent-cursor-participant_orbit")).toBeNull();

    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[]}
        room={roomWithAgent(canonicalAgent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    const marker = screen.getByTestId("agent-cursor-participant_orbit");
    expect(marker.tagName).toBe("DIV");
    expect(marker).toHaveAttribute("data-agent-handoff", "true");
    expect(marker.style.transform).toBe(beforeHandoff);
    expect(animation.pending()).toBe(1);
    now = 96;
    animation.flush(now);
    expect(marker).toHaveAttribute("data-agent-handoff-phase", "transition");
    expect(marker.style.transform).not.toBe(beforeHandoff);
  });

  it("converges at bounded screen speed while the canonical target keeps moving", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const animation = installAnimationFrames();
    const agent = inactiveRemoteAgent();
    const candidate = agentDraft();
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[candidate]}
        room={roomWithAgent(agent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    now = 80;
    animation.flush(now);
    const draftMarker = screen.getByTestId("agent-cursor-participant_orbit");
    let previous = translatedPoint(draftMarker);
    const startedAt = Date.now();
    const activityFor = (target: Point): AgentActivity => ({
      id: "activity-moving-handoff",
      type: "creating",
      label: "Building a large flow",
      objectIds: [],
      progress: 0,
      startedAt,
      durationMs: 10_000,
      fromCursor: target,
      toCursor: target,
    });
    let target = { x: 1_200, y: 300 };
    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[candidate]}
        room={roomWithAgent(remoteAgent(target, activityFor(target)))}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    const marker = screen.getByTestId("agent-cursor-participant_orbit");
    expect(translatedPoint(marker)).toEqual(previous);
    let maximumStep = 0;
    for (let frame = 0; frame < 180 && animation.pending(); frame += 1) {
      if (frame < 20) target = { x: target.x + 4, y: target.y + 1 };
      rendered.rerender(
        <CanvasPresenceOverlay
          agentDrafts={[candidate]}
          room={roomWithAgent(remoteAgent(target, activityFor(target)))}
          runtime={runtime}
          selfId={self.participantId}
        />,
      );
      now += 16;
      animation.flush(now);
      const current = translatedPoint(marker);
      maximumStep = Math.max(maximumStep, Math.hypot(current.x - previous.x, current.y - previous.y));
      previous = current;
    }

    expect(maximumStep).toBeLessThanOrEqual(12.2);
    expect(animation.pending()).toBe(0);
    expect(marker).toHaveAttribute("data-agent-handoff", "false");
    expect(marker).toHaveAttribute("data-agent-handoff-phase", "none");
    expect(translatedPoint(marker).x).toBeCloseTo(target.x);
    expect(translatedPoint(marker).y).toBeCloseTo(target.y);
  });

  it("keeps an extreme-distance handoff alive after canonical activity expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let frameNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => frameNow);
    const animation = installAnimationFrames();
    const candidate = agentDraft();
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[candidate]}
        room={roomWithAgent(inactiveRemoteAgent())}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    frameNow = 80;
    animation.flush(frameNow);

    const target = { x: 10_000, y: 2_000 };
    const activity: AgentActivity = {
      id: "activity-extreme-handoff",
      type: "creating",
      label: "Building a distant scene",
      objectIds: [],
      progress: 0,
      startedAt: Date.now(),
      durationMs: 1_000,
      fromCursor: target,
      toCursor: target,
    };
    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[]}
        room={roomWithAgent(remoteAgent(target, activity))}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    const handoffMarker = screen.getByTestId("agent-cursor-participant_orbit");
    expect(handoffMarker.tagName).toBe("DIV");
    for (let frame = 0; frame < 10; frame += 1) {
      frameNow += 16;
      animation.flush(frameNow);
    }
    const beforeExpiry = translatedPoint(handoffMarker);

    act(() => vi.advanceTimersByTime(3_000));

    const afterExpiry = screen.getByTestId("agent-cursor-participant_orbit");
    expect(afterExpiry).toBe(handoffMarker);
    expect(afterExpiry.tagName).toBe("DIV");
    expect(afterExpiry).toHaveAttribute("data-agent-handoff", "true");
    expect(afterExpiry).toHaveAttribute("data-working", "true");
    expect(translatedPoint(afterExpiry)).toEqual(beforeExpiry);
    expect(animation.pending()).toBe(1);

    let previous = beforeExpiry;
    let maximumStep = 0;
    for (let frame = 0; frame < 1_000 && animation.pending(); frame += 1) {
      frameNow += 16;
      animation.flush(frameNow);
      const current = translatedPoint(screen.getByTestId("agent-cursor-participant_orbit"));
      maximumStep = Math.max(maximumStep, Math.hypot(current.x - previous.x, current.y - previous.y));
      previous = current;
    }
    const settled = screen.getByTestId("agent-cursor-participant_orbit");
    expect(maximumStep).toBeLessThanOrEqual(12.2);
    expect(animation.pending()).toBe(0);
    expect(settled.tagName).toBe("BUTTON");
    expect(settled).toHaveAttribute("data-agent-handoff", "false");
    expect(translatedPoint(settled)).toEqual(target);
  });

  it("completes a canonical handoff before paint when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    vi.spyOn(performance, "now").mockReturnValue(0);
    const animation = installAnimationFrames();
    const agent = inactiveRemoteAgent();
    const candidate = agentDraft();
    const rendered = render(
      <CanvasPresenceOverlay
        agentDrafts={[candidate]}
        room={roomWithAgent(agent)}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );
    expect(animation.pending()).toBe(0);

    const target = { x: 640, y: 360 };
    const activity: AgentActivity = {
      id: "activity-reduced-handoff",
      type: "creating",
      label: "Building without motion",
      objectIds: [],
      progress: 0,
      startedAt: Date.now(),
      durationMs: 10_000,
      fromCursor: target,
      toCursor: target,
    };
    rendered.rerender(
      <CanvasPresenceOverlay
        agentDrafts={[candidate]}
        room={roomWithAgent(remoteAgent(target, activity))}
        runtime={runtime}
        selfId={self.participantId}
      />,
    );

    const marker = screen.getByTestId("agent-cursor-participant_orbit");
    expect(marker).toHaveAttribute("data-agent-handoff", "false");
    expect(marker).toHaveAttribute("data-agent-handoff-phase", "none");
    expect(marker).toHaveStyle({ transform: "translate(640px, 360px)" });
    expect(animation.pending()).toBe(0);
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
    expect(marker).not.toHaveAttribute("data-agent-draft-choreography");
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
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const animation = installAnimationFrames();
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
    expect(screen.getByTestId("agent-cursor-participant_orbit")).toHaveAttribute("data-agent-handoff", "true");
    now = 300;
    animation.flush(now);
    const returnedIdleMarker = screen.getByRole("button", { name: /Move Orbit Architect’s idle agent locally/i });
    expect(returnedIdleMarker).toHaveAttribute("data-local-parked", "false");
    expect(returnedIdleMarker).toHaveStyle({ transform: "translate(100px, 120px)" });
  });
});
