import { describe, expect, it } from "vitest";

import {
  normalizeConnectorRouting,
} from "@/lib/domain/connector-routing";
import { createCanvasObjectSchema } from "@/lib/domain/schemas";
import type {
  ActorRef,
  CanvasObject,
  ConnectorObject,
  ConnectorRoutingInput,
  RoomState,
} from "@/lib/domain/types";

import {
  normalizedConnectorAnchorAtPoint,
  SemanticConnectorSessionEngine,
  SemanticConnectorSessionError,
  type SemanticConnectorCreateInput,
} from "./semantic-connector-session";

const actor: ActorRef = {
  participantId: "connector-participant",
  displayName: "Connector editor",
  color: "violet",
  kind: "human",
};

function base(
  id: string,
  x: number,
  y: number,
  revision = 1,
  createdAt = 1_000 + revision,
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
    groupId: null,
    diagramIds: [],
    createdAt,
    updatedAt: createdAt + 10,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function shape(
  id: string,
  x: number,
  y: number,
  options: Readonly<{
    width?: number;
    height?: number;
    rotation?: number;
    revision?: number;
    createdAt?: number;
  }> = {},
): Extract<CanvasObject, { kind: "shape" }> {
  return {
    ...base(
      id,
      x,
      y,
      options.revision ?? 1,
      options.createdAt ?? 1_000 + (options.revision ?? 1),
    ),
    width: options.width ?? 120,
    height: options.height ?? 80,
    rotation: options.rotation ?? 0,
    kind: "shape",
    shape: "rectangle",
    nodeType: null,
    label: id,
    fill: "white",
    stroke: "black",
  };
}

function connector(
  id: string,
  startObjectId: string | null,
  endObjectId: string | null,
  options: Readonly<{
    revision?: number;
    createdAt?: number;
    routing?: ConnectorRoutingInput;
    label?: string;
  }> = {},
): ConnectorObject {
  return {
    ...base(
      id,
      120,
      40,
      options.revision ?? 1,
      options.createdAt ?? 2_000 + (options.revision ?? 1),
    ),
    kind: "connector",
    width: 380,
    height: 1,
    start: {
      x: 120,
      y: 40,
      objectId: startObjectId,
      ...(startObjectId
        ? {
            normalizedAnchor: { x: 1, y: 0.5 },
            isPrecise: true,
            isExact: false,
            snap: "none" as const,
          }
        : {}),
    },
    end: {
      x: 500,
      y: 40,
      objectId: endObjectId,
      ...(endObjectId
        ? {
            normalizedAnchor: { x: 0, y: 0.5 },
            isPrecise: true,
            isExact: false,
            snap: "none" as const,
          }
        : {}),
    },
    routing: normalizeConnectorRouting(options.routing ?? { mode: "straight" }),
    direction: "end",
    label: options.label ?? id,
    color: "black",
  };
}

function room(objects: readonly CanvasObject[]): RoomState {
  return {
    id: "room-connectors",
    code: "CONN",
    title: "Connector sessions",
    stateRevision: 10,
    roomRevision: 7,
    createdAt: 100,
    updatedAt: 200,
    participants: {},
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function prepare(
  engine: SemanticConnectorSessionEngine,
  source: RoomState,
  overrides: Partial<SemanticConnectorCreateInput> = {},
) {
  return engine.prepareCreate({
    room: source,
    id: "connector-new",
    start: { point: { x: 10, y: 20 } },
    end: { point: { x: 310, y: 120 } },
    routing: { mode: "straight" },
    direction: "end",
    label: "request",
    color: "black",
    zIndex: 8,
    groupId: null,
    ...overrides,
  });
}

describe("SemanticConnectorSessionEngine", () => {
  it("computes rotation-aware anchors and exact binding metadata without renderer records", () => {
    const rotated = shape("rotated", 100, 100, {
      width: 100,
      height: 50,
      rotation: Math.PI / 2,
    });
    // The unrotated right midpoint (200, 125) becomes (150, 175).
    expect(normalizedConnectorAnchorAtPoint(rotated, { x: 150, y: 175 })).toEqual({
      x: 1,
      y: 0.5,
    });

    const engine = new SemanticConnectorSessionEngine();
    const prepared = prepare(engine, room([rotated]), {
      start: {
        point: { x: 150, y: 175 },
        objectId: rotated.id,
        snap: "none",
        isExact: true,
      },
      end: { point: { x: 420, y: 175 } },
    });

    expect(prepared.session.draft.start).toEqual({
      x: 150,
      y: 175,
      objectId: "rotated",
      normalizedAnchor: { x: 1, y: 0.5 },
      isPrecise: true,
      isExact: true,
      snap: "none",
    });
    expect(prepared.session.draft.end).toEqual({
      x: 420,
      y: 175,
      objectId: null,
    });
    expect("editor" in prepared.session).toBe(false);
    expect("leaseId" in prepared.session).toBe(false);
    expect("command" in prepared.session).toBe(false);
  });

  it("preserves object relationships and truthful center, edge, and edge-point snaps", () => {
    const left = shape("left", 0, 0);
    const right = shape("right", 400, 100, { rotation: Math.PI / 4 });
    const source = room([left, right]);

    const centerEngine = new SemanticConnectorSessionEngine();
    const centered = prepare(centerEngine, source, {
      start: { point: { x: 10, y: 10 }, objectId: "left", snap: "center" },
      end: { point: { x: 460, y: 140 }, objectId: "right", snap: "center" },
      routing: { mode: "straight" },
    });
    expect(centered.session.draft.start).toMatchObject({
      objectId: "left",
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isPrecise: true,
      isExact: false,
      snap: "center",
    });
    expect(centered.session.draft.end).toMatchObject({
      objectId: "right",
      normalizedAnchor: { x: 0.5, y: 0.5 },
      snap: "center",
    });

    const edgeEngine = new SemanticConnectorSessionEngine();
    const edged = prepare(edgeEngine, source, {
      start: { point: { x: 5, y: 18 }, objectId: "left", snap: "edge" },
      end: { point: { x: 520, y: 140 }, objectId: "right", snap: "edge-point" },
      routing: { mode: "elbow", elbowMidPoint: 0.4 },
    });
    expect(edged.session.draft.start).toMatchObject({
      objectId: "left",
      normalizedAnchor: { x: 0, y: 0.225 },
      isPrecise: true,
      snap: "edge",
    });
    const endAnchor = edged.session.draft.end.normalizedAnchor!;
    expect([0, 0.5, 1]).toContain(endAnchor.x);
    expect([0, 0.5, 1]).toContain(endAnchor.y);
    expect([endAnchor.x, endAnchor.y].filter((value) => value === 0.5)).toHaveLength(1);
    expect(edged.session.draft.end).toMatchObject({
      objectId: "right",
      isPrecise: true,
      isExact: false,
      snap: "edge-point",
    });
  });

  it.each([
    [{ mode: "straight" } satisfies ConnectorRoutingInput, "straight"],
    [{ mode: "curved", bend: -64 } satisfies ConnectorRoutingInput, "curved"],
    [{ mode: "elbow", elbowMidPoint: 0.3 } satisfies ConnectorRoutingInput, "elbow"],
    [{ mode: "auto" } satisfies ConnectorRoutingInput, null],
  ] as const)("produces a schema-valid %s semantic route", (routing, expectedKind) => {
    const obstacle = shape("obstacle", 140, 30, { width: 80, height: 100 });
    const engine = new SemanticConnectorSessionEngine();
    const prepared = prepare(engine, room([obstacle]), { routing });
    const canonical = prepared.session.draft.routing!;

    expect(canonical.mode).toBe(routing.mode);
    if (expectedKind) expect(canonical.kind).toBe(expectedKind);
    else expect(["straight", "curved", "elbow"]).toContain(canonical.kind);
    if (routing.mode === "curved") expect(canonical.bend).toBe(-64);
    if (routing.mode === "elbow") expect(canonical.elbowMidPoint).toBe(0.3);
    expect(createCanvasObjectSchema.safeParse(prepared.session.draft).success).toBe(true);
    expect(prepared.session.previewRoute.points.length).toBeGreaterThanOrEqual(2);
  });

  it("never replaces an explicit overlapping route with obstacle avoidance", () => {
    const obstacle = shape("obstacle", 130, -30, { width: 80, height: 120 });
    const engine = new SemanticConnectorSessionEngine();
    const prepared = prepare(engine, room([obstacle]), {
      start: { point: { x: 0, y: 20 } },
      end: { point: { x: 340, y: 20 } },
      routing: { mode: "straight", labelPosition: 0.4 },
    });

    expect(prepared.session.draft.routing).toMatchObject({
      mode: "straight",
      kind: "straight",
      labelPosition: 0.4,
    });
    expect(prepared.session.previewRoute.points).toEqual([
      { x: 0, y: 20 },
      { x: 340, y: 20 },
    ]);
    expect(prepared.session.previewRoute.collisionObjectIds).toContain("obstacle");
  });

  it("publishes protection before dependencies and a base-null create draft", () => {
    const left = shape("left", 0, 0);
    const right = shape("right", 500, 0);
    const existing = connector("existing", "left", "right", {
      routing: { mode: "auto" },
      createdAt: 2_000,
    });
    const source = room([left, right, existing]);
    const engine = new SemanticConnectorSessionEngine();
    const prepared = prepare(engine, source, {
      start: { point: { x: 120, y: 40 }, objectId: "left" },
      end: { point: { x: 500, y: 40 }, objectId: "right" },
      routing: { mode: "auto" },
      id: "parallel",
      zIndex: 99,
      groupId: "request-flow",
      direction: "both",
      label: "authorized request",
      color: "violet",
    });
    expect(prepared.lifecycleEvents).toEqual([]);

    const published = engine.publish(prepared.session.token);
    expect(published.status).toBe("published");
    if (published.status !== "published") return;
    expect(published.lifecycleEvents.map((event) => event.type)).toEqual([
      "gesture.started",
      "gesture.dependencies-added",
      "objects.changed",
    ]);
    expect(published.lifecycleEvents[0]).toMatchObject({
      objects: [{
        objectId: "parallel",
        baseRevision: null,
        baseCreatedAt: null,
        operation: null,
      }],
    });
    expect(published.lifecycleEvents[1]).toMatchObject({
      objects: [{
        objectId: "existing",
        baseRevision: existing.revision,
        baseCreatedAt: existing.createdAt,
        operation: "connect",
      }],
    });
    expect(published.lifecycleEvents[2]).toMatchObject({
      changes: [{
        kind: "create",
        baseRevision: null,
        baseCreatedAt: null,
        draft: {
          id: "parallel",
          zIndex: 99,
          groupId: "request-flow",
          direction: "both",
          label: "authorized request",
          color: "violet",
        },
      }],
    });
    expect(published.session.affectedConnectorIds).toEqual(["existing"]);
  });

  it("emits absolute drafts frame-immediately and suppresses duplicate pointer frames", () => {
    const engine = new SemanticConnectorSessionEngine();
    const prepared = prepare(engine, room([]));
    const published = engine.publish(prepared.session.token);
    if (published.status !== "published") throw new Error("Expected publish.");

    const duplicate = engine.updatePointer(published.session.token, {
      point: { x: 310, y: 120 },
    });
    expect(duplicate).toMatchObject({ status: "updated", lifecycleEvents: [] });

    const moved = engine.updatePointer(published.session.token, {
      point: { x: 410, y: 220 },
    });
    expect(moved.status).toBe("updated");
    if (moved.status !== "updated") return;
    expect(moved.lifecycleEvents.map((event) => event.type)).toEqual(["objects.changed"]);
    expect(moved.lifecycleEvents[0]).toMatchObject({
      changes: [{
        kind: "create",
        draft: { end: { x: 410, y: 220, objectId: null } },
        baseRevision: null,
      }],
    });
  });

  it("flushes the last pointer-up frame without constructing a network command", () => {
    const engine = new SemanticConnectorSessionEngine();
    const prepared = prepare(engine, room([]));
    const published = engine.publish(prepared.session.token);
    if (published.status !== "published") throw new Error("Expected publish.");

    const finished = engine.finish(published.session.token, {
      point: { x: 600, y: 260 },
    });
    expect(finished.status).toBe("finished");
    if (finished.status !== "finished") return;
    expect(finished.command).toBeNull();
    expect(finished.session.draft.end).toEqual({ x: 600, y: 260, objectId: null });
    expect(finished.lifecycleEvents.map((event) => event.type)).toEqual([
      "objects.changed",
      "gesture.finish-requested",
    ]);
    expect(finished.lifecycleEvents.at(-1)).toEqual({
      type: "gesture.finish-requested",
      gestureId: published.session.gestureId,
      reason: "pointer-up",
    });
    expect(engine.current()).toBeNull();
  });

  it("treats pointer-cancel as a successful final flush", () => {
    const engine = new SemanticConnectorSessionEngine();
    const prepared = prepare(engine, room([]));
    const published = engine.publish(prepared.session.token);
    if (published.status !== "published") throw new Error("Expected publish.");

    const cancelled = engine.pointerCancel(published.session.token, {
      point: { x: 500, y: 200 },
    });
    expect(cancelled).toMatchObject({
      status: "finished",
      command: null,
      lifecycleEvents: [
        { type: "objects.changed" },
        { type: "gesture.finish-requested", reason: "pointer-cancel" },
      ],
    });
    expect(engine.current()).toBeNull();
  });

  it("abandons only an unpublished draft and fences every late token", () => {
    const engine = new SemanticConnectorSessionEngine();
    const first = prepare(engine, room([]), { id: "first" });
    expect(engine.abandon(first.session.token)).toEqual({
      status: "abandoned",
      token: first.session.token,
      objectId: "first",
      clearObjectIds: ["first"],
      command: null,
      lifecycleEvents: [],
    });

    const second = prepare(engine, room([]), { id: "second" });
    expect(engine.updatePointer(first.session.token, { point: { x: 9, y: 9 } })).toEqual({
      status: "stale",
      token: first.session.token,
    });
    const published = engine.publish(second.session.token);
    if (published.status !== "published") throw new Error("Expected publish.");
    expect(() => engine.abandon(second.session.token)).toThrowError(
      expect.objectContaining({ code: "INVALID_PHASE" }),
    );
    engine.finish(second.session.token);
    expect(engine.finish(second.session.token)).toEqual({
      status: "stale",
      token: second.session.token,
    });
  });

  it("edits endpoint relationships, routing, and label with exact revision fences", () => {
    const left = shape("left", 0, 0);
    const right = shape("right", 500, 0);
    const lower = shape("lower", 500, 300, { rotation: Math.PI / 6 });
    const edge = connector("edge", "left", "right", {
      revision: 7,
      createdAt: 4_242,
    });
    const source = room([left, right, lower, edge]);
    const engine = new SemanticConnectorSessionEngine();
    const started = engine.beginEdit({ room: source, connectorId: "edge", terminal: "end" });

    expect(started.lifecycleEvents).toEqual([{
      type: "gesture.started",
      gestureId: started.session.gestureId,
      source: "pointer",
      objects: [{
        objectId: "edge",
        baseRevision: 7,
        baseCreatedAt: 4_242,
        operation: "connect",
      }],
    }]);
    source.objects.edge.revision = 99;
    source.objects.edge.createdAt = 99;

    const updated = engine.update(started.session.token, {
      end: {
        point: { x: 560, y: 340 },
        objectId: "lower",
        snap: "edge",
      },
      routing: { mode: "curved", bend: 72, labelPosition: 0.6 },
      label: "async response",
      direction: "both",
      color: "orange",
    });
    expect(updated.status).toBe("updated");
    if (updated.status !== "updated") return;
    expect(updated.session.draft).toMatchObject({
      id: "edge",
      end: {
        objectId: "lower",
        normalizedAnchor: expect.any(Object),
        isPrecise: true,
        isExact: false,
        snap: "edge",
      },
      routing: { mode: "curved", kind: "curved", bend: 72, labelPosition: 0.6 },
      label: "async response",
      direction: "both",
      color: "orange",
    });
    const changed = updated.lifecycleEvents.at(-1);
    expect(changed).toMatchObject({
      type: "objects.changed",
      changes: [{
        kind: "update",
        baseRevision: 7,
        baseCreatedAt: 4_242,
        operation: "connect",
        draft: { id: "edge" },
      }],
    });
    expect("expectedRevision" in updated.session).toBe(false);
    expect(updated.command).toBeNull();
  });

  it("protects both old-pair and new-pair siblings before a relationship rebind", () => {
    const left = shape("left", 0, 0);
    const right = shape("right", 500, 0);
    const lower = shape("lower", 500, 300);
    const edge = connector("edge", "left", "right", { createdAt: 2_000 });
    const oldSibling = connector("old-sibling", "left", "right", {
      revision: 4,
      createdAt: 2_100,
    });
    const newSibling = connector("new-sibling", "left", "lower", {
      revision: 6,
      createdAt: 2_200,
    });
    const engine = new SemanticConnectorSessionEngine();
    const started = engine.beginEdit({
      room: room([left, right, lower, edge, oldSibling, newSibling]),
      connectorId: "edge",
      terminal: "end",
    });

    const rebound = engine.updatePointer(started.session.token, {
      point: { x: 500, y: 340 },
      objectId: "lower",
      snap: "edge",
    });
    expect(rebound.status).toBe("updated");
    if (rebound.status !== "updated") return;
    expect(rebound.lifecycleEvents.map((event) => event.type)).toEqual([
      "gesture.dependencies-added",
      "objects.changed",
    ]);
    expect(rebound.lifecycleEvents[0]).toEqual({
      type: "gesture.dependencies-added",
      gestureId: started.session.gestureId,
      objects: [
        {
          objectId: "old-sibling",
          baseRevision: 4,
          baseCreatedAt: 2_100,
          operation: "connect",
        },
        {
          objectId: "new-sibling",
          baseRevision: 6,
          baseCreatedAt: 2_200,
          operation: "connect",
        },
      ],
    });
    expect(rebound.session.affectedConnectorIds).toEqual([
      "old-sibling",
      "new-sibling",
    ]);

    const relabeled = engine.update(started.session.token, { label: "rebound" });
    expect(relabeled.status).toBe("updated");
    if (relabeled.status !== "updated") return;
    expect(relabeled.lifecycleEvents.map((event) => event.type)).toEqual([
      "objects.changed",
    ]);
  });

  it("suppresses duplicate edit frames and successfully flushes a pointer-cancelled endpoint edit", () => {
    const left = shape("left", 0, 0);
    const right = shape("right", 500, 0);
    const edge = connector("edge", "left", "right", { revision: 3 });
    const engine = new SemanticConnectorSessionEngine();
    const started = engine.beginEdit({
      room: room([left, right, edge]),
      connectorId: "edge",
      terminal: "end",
    });

    expect(engine.update(started.session.token, { label: edge.label })).toMatchObject({
      status: "updated",
      lifecycleEvents: [],
    });
    const cancelled = engine.pointerCancel(started.session.token, {
      point: { x: 700, y: 180 },
    });
    expect(cancelled).toMatchObject({
      status: "finished",
      session: { draft: { end: { x: 700, y: 180, objectId: null } } },
      lifecycleEvents: [
        { type: "objects.changed", changes: [{ operation: "connect", baseRevision: 3 }] },
        { type: "gesture.finish-requested", reason: "pointer-cancel" },
      ],
    });
  });

  it("rejects false binding metadata, connector targets, invalid routing, and schema-invalid fields", () => {
    const target = shape("target", 0, 0);
    const edge = connector("edge", null, null);
    const source = room([target, edge]);

    expect(() => prepare(new SemanticConnectorSessionEngine(), source, {
      start: {
        point: { x: 20, y: 20 },
        objectId: "target",
        snap: "edge",
        isExact: true,
      },
    })).toThrowError(expect.objectContaining({ code: "INVALID_ENDPOINT" }));

    expect(() => prepare(new SemanticConnectorSessionEngine(), source, {
      start: { point: { x: 20, y: 20 }, objectId: "edge" },
    })).toThrowError(expect.objectContaining({ code: "INVALID_TARGET" }));

    expect(() => prepare(new SemanticConnectorSessionEngine(), source, {
      routing: { mode: "curved", bend: 2 },
    })).toThrowError(expect.objectContaining({ code: "INVALID_ROUTING" }));

    expect(() => prepare(new SemanticConnectorSessionEngine(), source, {
      label: "x".repeat(2_001),
    })).toThrowError(expect.objectContaining({ code: "INVALID_DRAFT" }));

    expect(() => new SemanticConnectorSessionEngine().beginEdit({
      room: source,
      connectorId: "target",
    })).toThrowError(SemanticConnectorSessionError);
  });
});
