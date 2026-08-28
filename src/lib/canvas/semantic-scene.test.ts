import { describe, expect, it } from "vitest";

import {
  materializeConnectorRoutes,
  normalizeConnectorRouting,
  resolveAffectedConnectorRoutes,
  resolveConnectorRoutes,
} from "@/lib/domain/connector-routing";
import type {
  ActorRef,
  CanvasObject,
  ConnectorObject,
  RoomState,
} from "@/lib/domain/types";

import { buildSemanticScene } from "./semantic-scene";

const actor: ActorRef = {
  participantId: "participant-scene",
  displayName: "Scene Builder",
  color: "violet",
  kind: "agent",
};

function base(id: string, zIndex: number) {
  return {
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    zIndex,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function shape(
  id: string,
  x: number,
  y: number,
  zIndex: number,
  width = 100,
  height = 80,
): Extract<CanvasObject, { kind: "shape" }> {
  return {
    ...base(id, zIndex),
    kind: "shape",
    x,
    y,
    width,
    height,
    shape: "rectangle",
    nodeType: "service",
    label: id,
    fill: "light-blue",
    stroke: "blue",
  };
}

function connector(
  id: string,
  startObjectId: string,
  endObjectId: string,
  zIndex: number,
): ConnectorObject {
  return {
    ...base(id, zIndex),
    kind: "connector",
    x: 100,
    y: 140,
    width: 400,
    height: 1,
    start: { x: 100, y: 140, objectId: startObjectId },
    end: { x: 500, y: 140, objectId: endObjectId },
    routing: normalizeConnectorRouting({ mode: "auto" }),
    direction: "end",
    label: "request",
    color: "black",
  };
}

function room(objects: readonly CanvasObject[]): RoomState {
  return {
    id: "room-scene",
    code: "SCENE1",
    title: "Semantic scene",
    stateRevision: 7,
    roomRevision: 5,
    createdAt: 1,
    updatedAt: 2,
    participants: {},
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

describe("buildSemanticScene", () => {
  it("indexes every object kind in stable z-index and semantic-ID order", () => {
    const text: CanvasObject = {
      ...base("text", 2),
      kind: "text",
      content: "Semantic",
      color: "black",
      size: "m",
      align: "middle",
    };
    const shapeB: CanvasObject = {
      ...shape("shape-b", 20, 20, 1),
      groupId: "group-b",
    };
    const imageA: CanvasObject = {
      ...base("image-a", 1),
      kind: "image",
      groupId: "group-b",
      url: "https://example.com/image.png",
      assetId: "asset-image",
      alt: "Diagram",
      mimeType: "image/png",
      sourceUrl: null,
      locked: false,
    };
    const draw: CanvasObject = {
      ...base("draw", 3),
      kind: "draw",
      points: [{ x: 0, y: 0 }, { x: 30, y: 20 }],
      color: "red",
      size: "m",
    };
    const edge = connector("edge", shapeB.id, imageA.id, 4);
    const scene = buildSemanticScene(room([draw, edge, text, shapeB, imageA]));

    expect(scene.roomId).toBe("room-scene");
    expect(scene.roomRevision).toBe(5);
    expect(scene.objects.map(({ object }) => object.id)).toEqual([
      "image-a",
      "shape-b",
      "text",
      "draw",
      "edge",
    ]);
    expect(scene.objects.map(({ object }) => object.kind)).toEqual([
      "image",
      "shape",
      "text",
      "draw",
      "connector",
    ]);
    expect(scene.objectsById.draw.object).toBe(draw);
    expect(Object.keys(scene.groupMembers)).toEqual(["group-b"]);
    expect(scene.groupMembers["group-b"]).toEqual(["image-a", "shape-b"]);
  });

  it("derives rotated rectangular and local-point drawing bounds in page space", () => {
    const rotatedShape: CanvasObject = {
      ...shape("rotated", 10, 20, 1, 100, 40),
      rotation: Math.PI / 2,
    };
    const draw: CanvasObject = {
      ...base("draw", 2),
      kind: "draw",
      x: 100,
      y: 200,
      rotation: Math.PI / 2,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }],
      color: "red",
      size: "m",
    };
    const scene = buildSemanticScene(room([draw, rotatedShape]));

    expect(scene.objectsById.rotated.bounds.x).toBeCloseTo(40);
    expect(scene.objectsById.rotated.bounds.y).toBeCloseTo(-10);
    expect(scene.objectsById.rotated.bounds.width).toBeCloseTo(40);
    expect(scene.objectsById.rotated.bounds.height).toBeCloseTo(100);
    expect(scene.objectsById.draw.bounds.x).toBeCloseTo(77.75);
    expect(scene.objectsById.draw.bounds.y).toBeCloseTo(197.75);
    expect(scene.objectsById.draw.bounds.width).toBeCloseTo(24.5);
    expect(scene.objectsById.draw.bounds.height).toBeCloseTo(14.5);
    expect(scene.bounds?.x).toBeCloseTo(40);
    expect(scene.bounds?.y).toBeCloseTo(-10);
    expect(scene.bounds?.width).toBeCloseTo(62.25);
    expect(scene.bounds?.height).toBeCloseTo(222.25);
  });

  it("returns null scene bounds and an empty group index for an empty room", () => {
    const scene = buildSemanticScene(room([]));

    expect(scene.objects).toEqual([]);
    expect(scene.objectsById).toEqual({});
    expect(scene.bounds).toBeNull();
    expect(scene.groupMembers).toEqual({});
    expect(scene.connectorRoutes).toEqual({});
  });

  it("materializes persisted connector paths without resolving a new obstacle-aware route", () => {
    const left = shape("left", 0, 100, 1);
    const blocker = shape("blocker", 250, 100, 2);
    const right = shape("right", 500, 100, 3);
    const edge = connector("edge", left.id, right.id, 4);
    const source = room([left, blocker, right, edge]);
    const materialized = materializeConnectorRoutes(source).edge;
    const resolved = resolveConnectorRoutes(source).edge;
    const scene = buildSemanticScene(source);

    expect(resolved.routing.kind).toBe("elbow");
    expect(resolved.points.length).toBeGreaterThan(2);
    expect(materialized.routing).toMatchObject({ mode: "auto", kind: "straight" });
    expect(materialized.points).toEqual([
      { x: edge.start.x, y: edge.start.y },
      { x: edge.end.x, y: edge.end.y },
    ]);
    expect(scene.connectorRoutes.edge).toEqual(materialized);
    expect(scene.connectorRoutes.edge.candidateCount).toBe(1);
    expect(scene.connectorRoutes.edge.collisionObjectIds).toEqual([]);
    expect(scene.objectsById.edge.bounds).toEqual(materialized.bounds);
  });

  it("resolves only explicit optimistic connector dependencies against local node overrides", () => {
    const left = shape("left", 0, 100, 1);
    const right = shape("right", 500, 100, 2);
    const edge = connector("edge", left.id, right.id, 3);
    const movedLeft = { ...left, x: 160, y: 260 };
    const optimisticRoom = room([movedLeft, right, edge]);

    const authoritativeProjection = buildSemanticScene(optimisticRoom);
    const expected = resolveAffectedConnectorRoutes(optimisticRoom, new Set([edge.id])).edge;
    const optimisticProjection = buildSemanticScene(optimisticRoom, {
      optimisticConnectorIds: new Set([edge.id]),
    });

    expect(authoritativeProjection.connectorRoutes.edge.start).toEqual(edge.start);
    expect(optimisticProjection.connectorRoutes.edge).toEqual(expected);
    expect(optimisticProjection.connectorRoutes.edge.start).not.toEqual(edge.start);
    expect(optimisticProjection.connectorRoutes.edge.start.objectId).toBe(left.id);
    expect(optimisticProjection.objectsById.edge.bounds).toEqual(expected.bounds);
  });

  it("keeps group keys and members deterministic across room insertion orders", () => {
    const a: CanvasObject = { ...shape("a", 0, 0, 3), groupId: "group-z" };
    const b: CanvasObject = { ...shape("b", 0, 0, 1), groupId: "group-z" };
    const c: CanvasObject = { ...shape("c", 0, 0, 2), groupId: "group-a" };

    const first = buildSemanticScene(room([a, b, c]));
    const second = buildSemanticScene(room([c, a, b]));

    expect(first.groupMembers).toEqual({
      "group-a": ["c"],
      "group-z": ["b", "a"],
    });
    expect(second.groupMembers).toEqual(first.groupMembers);
    expect(second.objects.map(({ object }) => object.id)).toEqual(
      first.objects.map(({ object }) => object.id),
    );
  });
});
