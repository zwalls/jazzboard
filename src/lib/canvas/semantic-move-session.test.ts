import { describe, expect, it } from "vitest";

import { normalizeConnectorRouting } from "@/lib/domain/connector-routing";
import type {
  ActorRef,
  CanvasObject,
  ConnectorObject,
  Diagram,
  RoomState,
} from "@/lib/domain/types";

import {
  SEMANTIC_MOVE_LIMITS,
  SemanticMoveSessionEngine,
} from "./semantic-move-session";

const actor: ActorRef = {
  participantId: "move-participant",
  displayName: "Mover",
  color: "violet",
  kind: "human",
};

function base(
  id: string,
  x: number,
  y: number,
  revision = 1,
  groupId: string | null = null,
) {
  return {
    id,
    x,
    y,
    width: 120,
    height: 80,
    rotation: 0,
    zIndex: 1,
    revision,
    groupId,
    diagramIds: [],
    createdAt: 1_000 + revision,
    updatedAt: 2_000 + revision,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function shape(
  id: string,
  x: number,
  y: number,
  revision = 1,
  groupId: string | null = null,
): Extract<CanvasObject, { kind: "shape" }> {
  return {
    ...base(id, x, y, revision, groupId),
    kind: "shape",
    shape: "rectangle",
    nodeType: null,
    label: id,
    fill: "white",
    stroke: "black",
  };
}

function image(
  id: string,
  x: number,
  y: number,
  locked: boolean,
  groupId: string | null = null,
): Extract<CanvasObject, { kind: "image" }> {
  return {
    ...base(id, x, y, 1, groupId),
    kind: "image",
    url: `https://example.com/${id}.png`,
    assetId: `asset-${id}`,
    alt: id,
    mimeType: "image/png",
    sourceUrl: null,
    locked,
  };
}

function connector(
  id: string,
  startObjectId: string | null,
  endObjectId: string | null,
  groupId: string | null = null,
  routingMode: "auto" | "straight" = "straight",
): ConnectorObject {
  return {
    ...base(id, 120, 40, 1, groupId),
    kind: "connector",
    width: 380,
    height: 1,
    start: { x: 120, y: 40, objectId: startObjectId },
    end: { x: 500, y: 40, objectId: endObjectId },
    routing: normalizeConnectorRouting({ mode: routingMode }),
    direction: "end",
    label: id,
    color: "black",
  };
}

function diagram(
  id: string,
  memberObjectIds: readonly string[],
  connectorIds: readonly string[],
): Diagram {
  return {
    id,
    title: id,
    description: "Move dependency scope",
    diagramType: "architecture",
    category: null,
    tags: [],
    memberObjectIds: [...memberObjectIds],
    connectorIds: [...connectorIds],
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function room(objects: readonly CanvasObject[], diagrams: readonly Diagram[] = []): RoomState {
  return {
    id: "room-move",
    code: "MOVE01",
    title: "Move sessions",
    stateRevision: 10,
    roomRevision: 7,
    createdAt: 100,
    updatedAt: 200,
    participants: {},
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: Object.fromEntries(diagrams.map((item) => [item.id, item])),
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function begin(
  engine: SemanticMoveSessionEngine,
  source: RoomState,
  selectedObjectIds: readonly string[],
  selectedGroupIds: readonly string[] = [],
) {
  const result = engine.begin({
    room: source,
    selectedObjectIds,
    selectedGroupIds,
    pointerStart: { x: 40, y: 60 },
  });
  if (result.status !== "started") throw new Error("Expected a move session to start.");
  return result;
}

describe("SemanticMoveSessionEngine", () => {
  it("synchronously protects the complete immutable group cohort without owning lease transport", () => {
    const first = shape("first", 10, 20, 3, "group-a");
    const second = shape("second", 210, 120, 5, "group-a");
    const outside = shape("outside", 500, 400, 9);
    const edge = connector("edge", "first", "outside");
    const source = room([outside, edge, second, first]);
    const engine = new SemanticMoveSessionEngine();

    const started = begin(engine, source, ["first"]);

    expect(started.session.objectIds).toEqual(["first", "second"]);
    expect(started.session.resolvedGroupIds).toEqual(["group-a"]);
    expect(started.session.cohort).toEqual([
      expect.objectContaining({
        objectId: "first",
        baseRevision: 3,
        baseCreatedAt: first.createdAt,
        basePosition: { x: 10, y: 20 },
        movedViaGroup: true,
      }),
      expect.objectContaining({
        objectId: "second",
        baseRevision: 5,
        baseCreatedAt: second.createdAt,
        basePosition: { x: 210, y: 120 },
        movedViaGroup: true,
      }),
    ]);
    expect(started.session.affectedConnectorIds).toEqual(["edge"]);
    expect("leaseTargets" in started.session).toBe(false);
    expect("prepareCommand" in engine).toBe(false);
    expect(started.lifecycleEvent).toEqual({
      type: "gesture.started",
      gestureId: started.session.gestureId,
      source: "pointer",
      objects: [
        { objectId: "first", baseRevision: 3, baseCreatedAt: first.createdAt, operation: "move" },
        { objectId: "second", baseRevision: 5, baseCreatedAt: second.createdAt, operation: "move" },
        { objectId: "edge", baseRevision: 1, baseCreatedAt: edge.createdAt, operation: "connect" },
      ],
    });
    expect(Object.isFrozen(started.session.cohort)).toBe(true);
    expect(Object.isFrozen(started.session.cohort[0])).toBe(true);
    expect(Object.isFrozen(started.session.cohort[0].basePosition)).toBe(true);

    const capturedCreatedAt = first.createdAt;
    source.objects.first.revision = 99;
    source.objects.first.createdAt = 99;
    expect(started.session.cohort[0]).toMatchObject({
      baseRevision: 3,
      baseCreatedAt: capturedCreatedAt,
    });
  });

  it("protects an explicitly grouped connector at begin while drafts translate nodes only", () => {
    const left = shape("left", 10, 20, 1, "pair");
    const right = shape("right", 310, 220, 1, "pair");
    const edge = connector("edge", "left", "right", "pair");
    const source = room([left, right, edge]);
    const originalEndpoints = structuredClone({ start: edge.start, end: edge.end });
    const engine = new SemanticMoveSessionEngine();
    const started = begin(engine, source, [], ["pair"]);

    expect(started.lifecycleEvent.objects).toEqual([
      expect.objectContaining({ objectId: "left", operation: "move" }),
      expect.objectContaining({ objectId: "right", operation: "move" }),
      expect.objectContaining({ objectId: "edge", operation: "connect" }),
    ]);
    expect(started.session.connectorDependencies).toEqual([
      expect.objectContaining({ objectId: "edge" }),
    ]);

    const updated = engine.updatePointer(started.session.token, { x: 65, y: 45 });
    expect(updated.status).toBe("updated");
    if (updated.status !== "updated") return;
    expect(updated.session.delta).toEqual({ x: 25, y: -15 });
    expect(updated.session.positionOverrides).toEqual({
      left: { x: 35, y: 5 },
      right: { x: 335, y: 205 },
    });
    expect(updated.session.affectedConnectorIds).toEqual(["edge"]);
    expect(updated.lifecycleEvents.map((event) => event.type)).toEqual(["objects.changed"]);
    expect(updated.lifecycleEvents[0]).toMatchObject({
      type: "objects.changed",
      changes: [
        { kind: "update", draft: { id: "left", x: 35, y: 5 }, operation: "move" },
        { kind: "update", draft: { id: "right", x: 335, y: 205 }, operation: "move" },
      ],
    });
    expect(source.objects.left).toMatchObject({ x: 10, y: 20 });
    expect(source.objects.right).toMatchObject({ x: 310, y: 220 });
    expect(source.objects.edge).toMatchObject(originalEndpoints);
    expect("edge" in updated.session.positionOverrides).toBe(false);
  });

  it("marks a move-away-and-return frame as an authoritative no-op", () => {
    const object = shape("node", 10, 20, 3);
    const engine = new SemanticMoveSessionEngine();
    const started = begin(engine, room([object]), [object.id]);

    const away = engine.updatePointer(started.session.token, { x: 80, y: 90 });
    expect(away).toMatchObject({ status: "updated", session: { dirty: true } });

    const returned = engine.updatePointer(started.session.token, started.session.pointerStart);
    expect(returned).toMatchObject({
      status: "updated",
      session: {
        dirty: false,
        delta: { x: 0, y: 0 },
        positionOverrides: { node: { x: 10, y: 20 } },
      },
      lifecycleEvents: [{
        type: "objects.changed",
        changes: [{ kind: "update", draft: { id: "node", x: 10, y: 20 } }],
      }],
    });

    expect(engine.finish(started.session.token)).toMatchObject({
      status: "finished",
      session: { dirty: false },
    });
  });

  it("protects an implicitly bound connector at begin and never rediscovers it", () => {
    const left = shape("left", 0, 0);
    const right = shape("right", 500, 0);
    const edge = connector("edge", "left", "right");
    const source = room([left, right, edge]);
    const engine = new SemanticMoveSessionEngine();
    const started = begin(engine, source, ["left"]);

    expect(started.lifecycleEvent.objects).toEqual([
      expect.objectContaining({ objectId: "left", operation: "move" }),
      expect.objectContaining({ objectId: "edge", operation: "connect" }),
    ]);

    const first = engine.updatePointer(started.session.token, { x: 80, y: 90 });
    expect(first.status).toBe("updated");
    if (first.status !== "updated") return;
    expect(first.lifecycleEvents.map((event) => event.type)).toEqual(["objects.changed"]);

    const duplicate = engine.updatePointer(started.session.token, { x: 80, y: 90 });
    expect(duplicate).toMatchObject({ status: "updated", lifecycleEvents: [] });

    const next = engine.updatePointer(started.session.token, { x: 100, y: 110 });
    expect(next.status).toBe("updated");
    if (next.status !== "updated") return;
    expect(next.lifecycleEvents.map((event) => event.type)).toEqual(["objects.changed"]);
    expect(next.session.affectedConnectorIds).toEqual(["edge"]);
  });

  it("protects a potentially affected auto route before an obstacle starts moving", () => {
    const left = shape("left", 0, 0);
    const right = shape("right", 500, 0);
    const obstacle = shape("obstacle", 240, 200);
    const edge = connector("edge", "left", "right", null, "auto");
    const source = room([left, right, obstacle, edge]);
    const engine = new SemanticMoveSessionEngine();
    const started = begin(engine, source, ["obstacle"]);

    expect(started.lifecycleEvent.objects).toEqual([
      expect.objectContaining({ objectId: "obstacle", operation: "move" }),
      expect.objectContaining({ objectId: "edge", operation: "connect" }),
    ]);

    const updated = engine.updatePointer(started.session.token, { x: 40, y: -130 });
    expect(updated.status).toBe("updated");
    if (updated.status !== "updated") return;
    expect(updated.session.positionOverrides.obstacle).toEqual({ x: 240, y: 10 });
    expect(updated.lifecycleEvents).toHaveLength(1);
    expect(updated.lifecycleEvents[0]).toMatchObject({
      type: "objects.changed",
      changes: [{ draft: { id: "obstacle", x: 240, y: 10 } }],
    });
  });

  it("keeps auto-route preflight inside Diagram scope and includes later scoped dependencies", () => {
    const left = shape("left", 0, 0);
    const right = shape("right", 500, 0);
    const obstacle = shape("obstacle", 200, 180);
    const outside = shape("outside", 800, 180);
    const first = connector("first-edge", "left", "right", null, "auto");
    const later = { ...connector("later-edge", "left", "right", null, "auto"), createdAt: 9_000 };
    const unrelated = { ...connector("unrelated-edge", null, null, null, "auto"), createdAt: 10_000 };
    const source = room(
      [left, right, obstacle, outside, first, later, unrelated],
      [
        diagram("inside-diagram", ["left", "right", "obstacle"], ["first-edge", "later-edge"]),
        diagram("outside-diagram", ["outside"], ["unrelated-edge"]),
      ],
    );

    const started = begin(new SemanticMoveSessionEngine(), source, ["obstacle"]);
    expect(started.session.affectedConnectorIds).toEqual(["first-edge", "later-edge"]);
  });

  it("enforces the 200-operation protection cap before starting a gesture", () => {
    const groupId = "large-group";
    const nodes = Array.from(
      { length: SEMANTIC_MOVE_LIMITS.maxOperations },
      (_, index) => shape(`node-${index}`, index * 10, 0, 1, groupId),
    );
    const edge = connector("edge", "node-0", null, groupId);
    const engine = new SemanticMoveSessionEngine();

    expect(() => begin(engine, room([...nodes, edge]), [], [groupId])).toThrowError(
      expect.objectContaining({ code: "OPERATION_LIMIT" }),
    );
    expect(engine.current()).toBeNull();
  });

  it("finishes with a flush boundary and never constructs a CanvasCommand", () => {
    const source = room([shape("node", 25, 35, 2)]);
    const engine = new SemanticMoveSessionEngine();
    const started = begin(engine, source, ["node"]);

    const finished = engine.finish(started.session.token, { x: 50, y: 80 });

    expect(finished.status).toBe("finished");
    if (finished.status !== "finished") return;
    expect(finished.command).toBeNull();
    expect(finished.session.phase).toBe("finished");
    expect(finished.session.positionOverrides).toEqual({ node: { x: 35, y: 55 } });
    expect(finished.lifecycleEvents.map((event) => event.type)).toEqual([
      "objects.changed",
      "gesture.finish-requested",
    ]);
    expect(finished.lifecycleEvents.at(-1)).toEqual({
      type: "gesture.finish-requested",
      gestureId: started.session.gestureId,
      reason: "pointer-up",
    });
    expect(engine.current()).toBeNull();
  });

  it("treats pointer-cancel as a successful final flush rather than a rollback", () => {
    const source = room([shape("node", 25, 35, 2)]);
    const engine = new SemanticMoveSessionEngine();
    const started = begin(engine, source, ["node"]);

    const finished = engine.pointerCancel(started.session.token, { x: 90, y: 100 });

    expect(finished).toMatchObject({
      status: "finished",
      command: null,
      session: { positionOverrides: { node: { x: 75, y: 75 } } },
      lifecycleEvents: [
        { type: "objects.changed" },
        { type: "gesture.finish-requested", reason: "pointer-cancel" },
      ],
    });
    expect(engine.current()).toBeNull();
  });

  it("rolls back only through the explicit rejection/cancellation paths", () => {
    const source = room([shape("node", 25, 35, 2)]);
    const engine = new SemanticMoveSessionEngine();
    const cancelled = begin(engine, source, ["node"]);
    engine.updatePointer(cancelled.session.token, { x: 90, y: 100 });

    expect(engine.cancel(cancelled.session.token, source)).toMatchObject({
      status: "rolled-back",
      reason: "cancelled",
      positionOverrides: {},
      authoritativePositions: { node: { x: 25, y: 35 } },
      lifecycleEvents: [],
    });

    const rejected = begin(engine, source, ["node"]);
    engine.updatePointer(rejected.session.token, { x: 90, y: 100 });
    expect(engine.rollback(rejected.session.token, source, "OBJECT_BUSY")).toMatchObject({
      status: "rolled-back",
      reason: "command-rejected",
      detail: "OBJECT_BUSY",
      lifecycleEvents: [],
    });
  });

  it("fences cohort and connector incarnation/revision changes while allowing unrelated room updates", () => {
    const first = shape("first", 0, 0, 1, "group");
    const second = shape("second", 100, 0, 1, "group");
    const outside = shape("outside", 500, 0);
    const edge = connector("edge", "first", "outside");
    const source = room([first, second, outside, edge]);
    const engine = new SemanticMoveSessionEngine();
    const started = begin(engine, source, ["first"]);
    engine.updatePointer(started.session.token, { x: 60, y: 80 });

    const unrelated = structuredClone(source);
    unrelated.roomRevision += 1;
    unrelated.objects.other = shape("other", 900, 900, 1);
    expect(engine.reconcileAuthoritative(started.session.token, unrelated)).toMatchObject({
      status: "current",
      session: { token: started.session.token },
    });

    const connectorRevised = structuredClone(unrelated);
    connectorRevised.objects.edge.revision += 1;
    expect(engine.reconcileAuthoritative(started.session.token, connectorRevised)).toMatchObject({
      status: "rolled-back",
      reason: "authoritative-change",
      detail: expect.stringContaining("edge"),
      authoritativePositions: { first: { x: 0, y: 0 }, second: { x: 100, y: 0 } },
    });

    const restarted = begin(engine, source, ["first"]);
    const regrouped = structuredClone(source);
    regrouped.objects.joined = shape("joined", 200, 0, 1, "group");
    expect(engine.reconcileAuthoritative(restarted.session.token, regrouped)).toMatchObject({
      status: "rolled-back",
      reason: "authoritative-change",
      detail: expect.stringContaining("cohort"),
    });
  });

  it("fences stale frames and successfully finalizes a superseded pointer gesture", () => {
    const source = room([shape("old", 0, 0), shape("new", 300, 300)]);
    const engine = new SemanticMoveSessionEngine();
    const oldSession = begin(engine, source, ["old"]);
    engine.updatePointer(oldSession.session.token, { x: 100, y: 100 });

    const newSession = begin(engine, source, ["new"]);
    expect(newSession.superseded).toMatchObject({
      status: "finished",
      command: null,
      session: { positionOverrides: { old: { x: 60, y: 40 } } },
      lifecycleEvents: [{ type: "gesture.finish-requested", reason: "pointer-cancel" }],
    });
    expect(engine.updatePointer(oldSession.session.token, { x: 500, y: 500 })).toEqual({
      status: "stale",
      token: oldSession.session.token,
    });
    expect(engine.rollback(oldSession.session.token, source, "late failure")).toEqual({
      status: "stale",
      token: oldSession.session.token,
    });
    expect(engine.current()?.token).toEqual(newSession.session.token);
  });

  it("blocks direct connectors and locked images but moves locked images with their group", () => {
    const locked = image("locked", 0, 0, true);
    const movable = shape("movable", 200, 0);
    const edge = connector("edge", "movable", null);
    const source = room([locked, movable, edge]);
    const engine = new SemanticMoveSessionEngine();

    expect(engine.begin({
      room: source,
      selectedObjectIds: ["edge"],
      pointerStart: { x: 0, y: 0 },
    })).toMatchObject({
      status: "blocked",
      selectionReport: { connectorObjectIds: ["edge"] },
    });
    expect(engine.begin({
      room: source,
      selectedObjectIds: ["locked"],
      pointerStart: { x: 0, y: 0 },
    })).toMatchObject({
      status: "blocked",
      reason: "no-movable-objects",
      selectionReport: { lockedImageObjectIds: ["locked"] },
    });

    const groupedSource = room([
      { ...locked, groupId: "backdrop" },
      { ...movable, groupId: "backdrop" },
    ]);
    const grouped = begin(engine, groupedSource, [], ["backdrop"]);
    expect(grouped.session.objectIds).toEqual(["locked", "movable"]);
    expect(grouped.session.cohort[0]).toMatchObject({
      objectId: "locked",
      lockedImage: true,
      movedViaGroup: true,
    });
    expect(grouped.session.selectionReport.lockedImageObjectIds).toEqual([]);
  });
});
