import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
  type AgentCanvasDraftSnapshot,
  type AgentDraftCanvasObject,
} from "@/lib/agent-drafts/types";
import type { ActorRef, CanvasObject, Viewport } from "@/lib/domain/types";
import { AgentDraftRevealRegistry } from "@/lib/canvas/agent-draft-reveal";

import { agentAvatarPrimaryColor } from "./AgentAvatar";
import { AgentDraftLayer } from "./AgentDraftLayer";

const author: ActorRef = {
  participantId: "participant-agent",
  displayName: "Avery",
  color: "#5965e8",
  kind: "agent",
};

const viewport: Viewport = { x: 0, y: 0, width: 800, height: 600, zoom: 1 };

function shape(id = "draft-shape"): AgentDraftCanvasObject {
  return {
    authority: "draft",
    id,
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
    createdBy: author,
    lastEditedBy: author,
    shape: "rectangle",
    nodeType: "service",
    label: "Room API",
    fill: "light-violet",
    stroke: "blue",
  };
}

function connector(id = "draft-connector"): AgentDraftCanvasObject {
  return {
    authority: "draft",
    id,
    kind: "connector",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    rotation: 0,
    zIndex: 3,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: author,
    lastEditedBy: author,
    start: { x: 40, y: 195, objectId: null },
    end: { x: 120, y: 195, objectId: "draft-shape" },
    routing: { mode: "straight", kind: "straight", bend: 0, elbowMidPoint: 0.5, labelPosition: 0.5 },
    direction: "end",
    label: "calls",
    color: "blue",
  };
}

function path(id = "draft-path"): Extract<AgentDraftCanvasObject, { kind: "path" }> {
  return {
    authority: "draft",
    id,
    kind: "path",
    x: 20,
    y: 30,
    width: 160,
    height: 90,
    rotation: Math.PI / 6,
    zIndex: 4,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: author,
    lastEditedBy: author,
    start: { x: 0, y: 0.5 },
    segments: [{ kind: "quadratic", control: { x: 0.5, y: 0 }, to: { x: 1, y: 0.5 } }],
    closed: false,
    fill: "none",
    stroke: "red",
    strokeWidth: 5,
    opacity: 0.7,
    lineCap: "square",
    lineJoin: "bevel",
    fillRule: "evenodd",
  };
}

function draft(input: Partial<AgentCanvasDraftSnapshot> = {}): AgentCanvasDraftSnapshot {
  const now = Date.now();
  return {
    schemaVersion: AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
    id: "draft-1",
    roomId: "room-1",
    ownerParticipantId: author.participantId,
    author,
    revision: 1,
    baselineRoomRevision: 3,
    status: "active",
    temporaryReferences: {},
    previewObjects: [shape(), connector()],
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AgentDraftLayer", () => {
  it("renders native paths as separate fill, final-stroke, and construction layers", () => {
    const filledPath = {
      ...path(),
      closed: true,
      fill: "light-blue",
    };
    const { container } = render(
      <AgentDraftLayer
        authoritativeObjects={{}}
        drafts={[draft({ previewObjects: [filledPath] })]}
        roomId="room-1"
        viewport={viewport}
      />,
    );

    const element = container.querySelector('[data-agent-draft-object-id="draft-path"]');
    const artwork = element!.querySelector("g");
    const fill = element!.querySelector('[data-agent-draft-reveal-part="fill"]');
    const finalStroke = element!.querySelector('[data-agent-draft-reveal-part="final"]');
    const trace = element!.querySelector('[data-agent-draft-reveal-part="trace"]');
    expect(artwork).toHaveAttribute("opacity", "0.7");
    expect(artwork).toHaveAttribute("transform", "rotate(30 100 75)");
    expect(fill).toHaveAttribute("d", "M 20 75 Q 100 30 180 75 Z");
    expect(fill).toHaveAttribute("fill", "#deedf8");
    expect(fill).toHaveAttribute("fill-rule", "evenodd");
    expect(fill).toHaveAttribute("stroke", "none");
    expect(finalStroke).toHaveAttribute("fill", "none");
    expect(finalStroke).toHaveAttribute("stroke", "#d9484a");
    expect(finalStroke).toHaveAttribute("stroke-width", "5");
    expect(trace).toHaveAttribute("fill", "none");
    expect(trace).toHaveAttribute("stroke", "#d9484a");
    expect(trace).toHaveAttribute("stroke-width", "5");
    expect(trace).toHaveAttribute("pathLength", "1");
  });

  it("keeps open unfilled paths visible through construction and final-stroke layers", () => {
    const { container } = render(
      <AgentDraftLayer
        authoritativeObjects={{}}
        drafts={[draft({ previewObjects: [path()] })]}
        roomId="room-1"
        viewport={viewport}
      />,
    );

    const element = container.querySelector('[data-agent-draft-object-id="draft-path"]')!;
    expect(element.querySelector('[data-agent-draft-reveal-part="fill"]')).toHaveAttribute(
      "fill",
      "none",
    );
    expect(element.querySelector('[data-agent-draft-reveal-part="final"]')).toHaveAttribute(
      "stroke",
      "#d9484a",
    );
    expect(element.querySelector('[data-agent-draft-reveal-part="trace"]')).toHaveAttribute(
      "stroke",
      "#d9484a",
    );
  });

  it("materializes authored elbow waypoints into the draft connector trace", () => {
    const routed = {
      ...connector(),
      start: { x: 40, y: 195, objectId: null },
      end: { x: 340, y: 195, objectId: null },
      routing: {
        mode: "elbow" as const,
        kind: "elbow" as const,
        bend: 0,
        elbowMidPoint: 0.5,
        labelPosition: 0.6,
        waypoints: [{ x: 100, y: 80 }, { x: 280, y: 80 }],
      },
    };
    const { container } = render(
      <AgentDraftLayer
        authoritativeObjects={{}}
        drafts={[draft({ previewObjects: [routed] })]}
        roomId="room-1"
        viewport={viewport}
      />,
    );

    const element = container.querySelector('[data-agent-draft-object-id="draft-connector"]')!;
    expect(element.querySelector('[data-agent-draft-reveal-part="trace"]')).toHaveAttribute(
      "d",
      "M 40 195 L 100 80 L 280 80 L 340 195",
    );
    expect(element.querySelector('[data-agent-draft-reveal-part="final"]')).toHaveAttribute(
      "d",
      "M 40 195 L 100 80 L 280 80 L 340 195",
    );
  });

  it("renders draft artwork in authoritative z-order without canonical IDs or interaction semantics", () => {
    const background = { ...shape("draft-zone"), zIndex: 1 };
    const foreground = { ...shape(), zIndex: 4 };
    const { container } = render(
      <AgentDraftLayer
        authoritativeObjects={{}}
        drafts={[draft({ previewObjects: [foreground, connector(), background] })]}
        roomId="room-1"
        viewport={viewport}
      />,
    );

    const backgroundElement = container.querySelector('[data-agent-draft-object-id="draft-zone"]');
    const connectorElement = container.querySelector('[data-agent-draft-object-id="draft-connector"]');
    const shapeElement = container.querySelector('[data-agent-draft-object-id="draft-shape"]');
    expect(backgroundElement).not.toBeNull();
    expect(connectorElement).not.toBeNull();
    expect(shapeElement).not.toBeNull();
    expect(backgroundElement!.compareDocumentPosition(connectorElement!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(connectorElement!.compareDocumentPosition(shapeElement!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(container.querySelector('[data-object-id="draft-shape"]')).toBeNull();
    expect(container.querySelector('#draft-shape')).toBeNull();
    expect(container.querySelector('[data-agent-draft-object-id][role]')).toBeNull();
    expect(container.querySelector('[data-agent-draft-object-id][tabindex]')).toBeNull();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("svg")).toHaveAttribute("pointer-events", "none");
    const statusPill = container.querySelector("[data-agent-draft-pill]");
    expect((statusPill as HTMLElement).style.getPropertyValue("--agent-avatar-color")).toBe(
      agentAvatarPrimaryColor(author.displayName),
    );
    expect(statusPill).toHaveTextContent("Draft preview · not saved");
    expect(statusPill).not.toHaveTextContent("· agent");
  });

  it("registers normalized reveal parts and paints only the active work in the bot's wake", () => {
    const revealRegistry = new AgentDraftRevealRegistry();
    const { container } = render(
      <AgentDraftLayer
        authoritativeObjects={{}}
        drafts={[draft({
          previewObjects: [
            shape(),
            connector(),
            { ...path(), closed: true, fill: "light-blue" },
          ],
        })]}
        revealRegistry={revealRegistry}
        roomId="room-1"
        viewport={viewport}
      />,
    );
    const shapeElement = container.querySelector<SVGGElement>(
      '[data-agent-draft-object-id="draft-shape"]',
    )!;
    const connectorElement = container.querySelector<SVGGElement>(
      '[data-agent-draft-object-id="draft-connector"]',
    )!;
    const pathElement = container.querySelector<SVGGElement>(
      '[data-agent-draft-object-id="draft-path"]',
    )!;
    expect(shapeElement).toHaveAttribute("data-agent-draft-reveal-state", "pending");
    expect(connectorElement).toHaveAttribute("data-agent-draft-reveal-state", "pending");
    expect(pathElement).toHaveAttribute("data-agent-draft-reveal-state", "pending");
    expect(shapeElement.querySelector('[data-agent-draft-reveal-part="trace"]')).toHaveAttribute(
      "pathLength",
      "1",
    );
    expect(connectorElement.querySelector('[data-agent-draft-reveal-part="trace"]')).toHaveAttribute(
      "pathLength",
      "1",
    );
    expect(connectorElement.querySelector('[data-agent-draft-reveal-part="final"]')).not.toBeNull();
    expect(connectorElement.querySelector('[data-agent-draft-reveal-part="terminal"]')).not.toBeNull();
    expect(connectorElement.querySelector('[data-agent-draft-reveal-part="label"]')).not.toBeNull();
    expect(pathElement.querySelector('[data-agent-draft-reveal-part="fill"]')).toHaveAttribute(
      "fill",
      "#deedf8",
    );
    expect(pathElement.querySelector('[data-agent-draft-reveal-part="final"]')).toHaveAttribute(
      "fill",
      "none",
    );
    expect(pathElement.querySelector('[data-agent-draft-reveal-part="trace"]')).toHaveAttribute(
      "fill",
      "none",
    );

    const fingerprint = shapeElement.getAttribute("data-agent-draft-reveal-fingerprint")!;
    expect(revealRegistry.snapshot("draft-1", "draft-shape")?.fingerprint).toBe(fingerprint);
    act(() => {
      revealRegistry.applyFrame("draft-1", {
        pagePoint: { x: 230, y: 140 },
        phase: "outline",
        objectId: "draft-shape",
        fingerprint,
        phaseProgress: 0.5,
        active: true,
      });
    });
    expect(shapeElement).toHaveAttribute("data-agent-draft-reveal-state", "active");
    expect(shapeElement).toHaveAttribute("data-agent-draft-reveal-phase", "outline");
    expect(shapeElement.style.getPropertyValue("--agent-draft-reveal-progress")).toBe("0.5");
    expect(connectorElement).toHaveAttribute("data-agent-draft-reveal-state", "pending");
    expect(pathElement).toHaveAttribute("data-agent-draft-reveal-state", "pending");

    act(() => {
      revealRegistry.applyEvents("draft-1", [{
        type: "object-complete",
        objectId: "draft-shape",
        fingerprint,
        phase: "label",
      }]);
    });
    expect(shapeElement).toHaveAttribute("data-agent-draft-reveal-state", "complete");
    expect(shapeElement.style.getPropertyValue("--agent-draft-reveal-remaining")).toBe("0%");
  });

  it("suppresses any draft object whose semantic ID is already authoritative", () => {
    const authoritativeShape = { ...shape(), authority: undefined } as unknown as CanvasObject;
    const authoritativeConnector = { ...connector(), authority: undefined } as unknown as CanvasObject;
    const { container, rerender } = render(
      <AgentDraftLayer
        authoritativeObjects={{ "draft-shape": authoritativeShape }}
        drafts={[draft()]}
        roomId="room-1"
        viewport={viewport}
      />,
    );

    expect(container.querySelector('[data-agent-draft-object-id="draft-shape"]')).toBeNull();
    expect(container.querySelector('[data-agent-draft-object-id="draft-connector"]')).not.toBeNull();

    rerender(
      <AgentDraftLayer
        authoritativeObjects={{ "draft-shape": authoritativeShape, "draft-connector": authoritativeConnector }}
        drafts={[draft()]}
        roomId="room-1"
        viewport={viewport}
      />,
    );
    expect(container.querySelector("[data-agent-draft-object-id]")).toBeNull();
    expect(container.querySelector("[data-agent-draft-pill]")).toBeNull();
  });

  it("preserves existing artwork nodes when a cumulative revision adds more objects", () => {
    const first = draft({ previewObjects: [shape("first")] });
    const { container, rerender } = render(
      <AgentDraftLayer authoritativeObjects={{}} drafts={[first]} roomId="room-1" viewport={viewport} />,
    );
    const existing = container.querySelector('[data-agent-draft-object-id="first"]');
    expect(existing).not.toBeNull();

    rerender(
      <AgentDraftLayer
        authoritativeObjects={{}}
        drafts={[draft({
          revision: 2,
          previewObjects: [shape("first"), shape("second")],
          updatedAt: first.updatedAt + 1,
        })]}
        roomId="room-1"
        viewport={viewport}
      />,
    );

    expect(container.querySelector('[data-agent-draft-object-id="first"]')).toBe(existing);
    expect(container.querySelector('[data-agent-draft-object-id="second"]')).not.toBeNull();
  });

  it("shows truthful phase labels and throttles one live announcement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const { rerender } = render(
      <AgentDraftLayer authoritativeObjects={{}} drafts={[draft()]} roomId="room-1" viewport={viewport} />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Draft preview · not saved");
    expect(status).toHaveTextContent("2 elements staged");

    rerender(
      <AgentDraftLayer
        authoritativeObjects={{}}
        drafts={[draft({ status: "committing" })]}
        roomId="room-1"
        viewport={viewport}
      />,
    );
    expect(document.querySelector("[data-agent-draft-pill]")).toHaveTextContent("Validating atomic change · not saved");
    expect(status).toHaveTextContent("Draft preview · not saved");
    await act(async () => vi.advanceTimersByTimeAsync(240));
    expect(status).toHaveTextContent("Validating atomic change · not saved");

    rerender(
      <AgentDraftLayer
        authoritativeObjects={{}}
        drafts={[
          draft({
            status: "awaiting_review",
            awaitingReview: { proposalId: "proposal-1", proposedAt: 2_100 },
          }),
        ]}
        roomId="room-1"
        viewport={viewport}
      />,
    );
    expect(document.querySelector("[data-agent-draft-pill]")).toHaveTextContent("Awaiting human approval · not on board");
    expect(status).toHaveTextContent("Validating atomic change · not saved");
    await act(async () => vi.advanceTimersByTimeAsync(240));
    expect(status).toHaveTextContent("Awaiting human approval · not on board");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("tracks the page-space camera and cleans up art at expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const expiring = draft({ expiresAt: 2_200, hardExpiresAt: 3_000 });
    const { container, rerender } = render(
      <AgentDraftLayer authoritativeObjects={{}} drafts={[expiring]} roomId="room-1" viewport={viewport} />,
    );
    expect(container.querySelector('svg > g')).toHaveAttribute("transform", "translate(0 0) scale(1)");

    rerender(
      <AgentDraftLayer
        authoritativeObjects={{}}
        drafts={[expiring]}
        roomId="room-1"
        viewport={{ x: 50, y: 25, width: 400, height: 300, zoom: 2 }}
      />,
    );
    expect(container.querySelector('svg > g')).toHaveAttribute("transform", "translate(-100 -50) scale(2)");

    await act(async () => vi.advanceTimersByTimeAsync(201));
    expect(container.querySelector("[data-agent-draft-object-id]")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(240));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
