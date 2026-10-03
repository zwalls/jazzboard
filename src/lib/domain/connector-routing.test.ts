import { describe, expect, it } from "vitest";

import type {
  ActorRef,
  CanvasObject,
  ConnectorObject,
  ConnectorRouting,
  Diagram,
  RoomState,
  ShapeObject,
} from "./types";
import {
  createConnectorRoutingContext,
  CONNECTOR_ROUTING_LIMITS,
  CONNECTOR_ROUTING_BOUNDED_MAX_CANDIDATES,
  CONNECTOR_ROUTING_QUALITY_BATCH_LIMIT,
  LEGACY_CONNECTOR_ROUTING,
  cardinalNormalizedAnchor,
  connectorLabelBoundsForRoute,
  connectorPortSide,
  connectorRouteBounds,
  materializeConnectorRoutes,
  normalizeConnectorRouting,
  pointAlongConnectorRoute,
  resolveConnectorRoute,
  resolveConnectorRoutes,
} from "./connector-routing";

const actor: ActorRef = {
  participantId: "participant-routing",
  displayName: "Router",
  color: "blue",
  kind: "agent",
};

function base(id: string, createdAt = 1) {
  return {
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    zIndex: 0,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt,
    updatedAt: createdAt,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function node(id: string, x: number, y: number, width = 100, height = 80): ShapeObject {
  return {
    ...base(id),
    kind: "shape",
    x,
    y,
    width,
    height,
    shape: "rectangle",
    nodeType: "service",
    label: id,
    fill: "blue",
    stroke: "blue",
  };
}

function connector(
  id: string,
  startObjectId: string,
  endObjectId: string,
  routing?: ConnectorRouting,
  createdAt = 1,
): ConnectorObject {
  return {
    ...base(id, createdAt),
    kind: "connector",
    x: 100,
    y: 40,
    width: 400,
    height: 1,
    start: { x: 100, y: 40, objectId: startObjectId },
    end: { x: 500, y: 40, objectId: endObjectId },
    ...(routing ? { routing } : {}),
    direction: "end",
    label: "request",
    color: "black",
  };
}

function diagram(objects: CanvasObject[], connectorIds: string[]): Diagram {
  return {
    id: "diagram-routing",
    title: "Routing",
    description: "",
    diagramType: "architecture",
    category: null,
    tags: [],
    memberObjectIds: objects.filter((object) => object.kind !== "connector").map((object) => object.id),
    connectorIds,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function room(objects: CanvasObject[], includeDiagram = true): Pick<RoomState, "objects" | "diagrams"> {
  const connectors = objects.filter((object) => object.kind === "connector");
  return {
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: includeDiagram
      ? { "diagram-routing": diagram(objects, connectors.map((object) => object.id)) }
      : {},
  };
}

describe("canonical connector routing", () => {
  it("keeps persisted legacy connectors straight while canonicalizing bounded inputs", () => {
    expect(normalizeConnectorRouting()).toEqual(LEGACY_CONNECTOR_ROUTING);
    expect(
      normalizeConnectorRouting({
        mode: "curved",
        bend: 0,
        elbowMidPoint: 2,
        labelPosition: -1,
      }),
    ).toEqual({
      mode: "curved",
      kind: "curved",
      bend: CONNECTOR_ROUTING_LIMITS.minCurvedBend,
      elbowMidPoint: 1,
      labelPosition: 0,
    });
    expect(normalizeConnectorRouting({ mode: "curved", bend: 1_000_000 }).bend).toBe(
      CONNECTOR_ROUTING_LIMITS.maxBend,
    );
    expect(
      normalizeConnectorRouting({
        mode: "auto",
        kind: "elbow",
        bend: 80,
        elbowMidPoint: 0.25,
        labelPosition: 0.75,
      }),
    ).toEqual({
      mode: "auto",
      kind: "elbow",
      bend: 0,
      elbowMidPoint: 0.25,
      labelPosition: 0.75,
      labelPositionSource: "authored",
    });
  });

  it("uses exact cardinal anchors", () => {
    expect(cardinalNormalizedAnchor("top", 0.25)).toEqual({ x: 0.25, y: 0 });
    expect(cardinalNormalizedAnchor("right", 0.25)).toEqual({ x: 1, y: 0.25 });
    expect(cardinalNormalizedAnchor("bottom", 0.75)).toEqual({ x: 0.75, y: 1 });
    expect(cardinalNormalizedAnchor("left", 0.75)).toEqual({ x: 0, y: 0.75 });
  });

  it("retains bounded authored waypoints only for explicit elbow routing", () => {
    const waypoints = [{ x: 120, y: -40 }, { x: 360, y: -40 }];
    expect(normalizeConnectorRouting({ mode: "elbow", waypoints })).toMatchObject({
      mode: "elbow",
      kind: "elbow",
      waypoints,
    });
    expect(normalizeConnectorRouting({ mode: "auto", waypoints })).not.toHaveProperty("waypoints");

    const oversized = Array.from(
      { length: CONNECTOR_ROUTING_LIMITS.maxWaypoints + 5 },
      (_, index) => ({ x: index, y: 2_000_000 }),
    );
    const normalized = normalizeConnectorRouting({ mode: "elbow", waypoints: oversized });
    expect(normalized.waypoints).toHaveLength(CONNECTOR_ROUTING_LIMITS.maxWaypoints);
    expect(normalized.waypoints?.every(
      (point) => point.y === CONNECTOR_ROUTING_LIMITS.maxWaypointCoordinate,
    )).toBe(true);
  });
});

describe("connector route bounds numeric behavior", () => {
  it("retains empty, single-point, and negative-padding bounds", () => {
    const padding = CONNECTOR_ROUTING_LIMITS.routeBoundsPadding;
    expect(connectorRouteBounds([])).toEqual({
      x: -padding, y: -padding, width: Math.max(padding * 2, 1), height: Math.max(padding * 2, 1),
    });
    expect(connectorRouteBounds([], 0)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(connectorRouteBounds([{ x: 7, y: -3 }], 0)).toEqual({ x: 7, y: -3, width: 1, height: 1 });
    expect(connectorRouteBounds([{ x: -3, y: -4 }, { x: 7, y: 6 }], -2))
      .toEqual({ x: -1, y: -2, width: 6, height: 6 });
  });

  it("preserves signed-zero extrema and padding arithmetic", () => {
    const negative = connectorRouteBounds([{ x: -0, y: -0 }], 0);
    const positive = connectorRouteBounds([{ x: -0, y: -0 }], -0);
    const mixed = connectorRouteBounds([{ x: 0, y: -0 }, { x: -0, y: 0 }], 0);
    expect(Object.is(negative.x, -0)).toBe(true);
    expect(Object.is(negative.y, -0)).toBe(true);
    expect(Object.is(positive.x, 0)).toBe(true);
    expect(Object.is(positive.y, 0)).toBe(true);
    expect(Object.is(mixed.x, -0)).toBe(true);
    expect(Object.is(mixed.y, -0)).toBe(true);
    expect(mixed.width).toBe(1);
    expect(mixed.height).toBe(1);
  });

  it("propagates non-finite coordinates without changing unaffected dimensions", () => {
    const notANumber = connectorRouteBounds([{ x: NaN, y: 4 }, { x: 10, y: 9 }], 2);
    expect(notANumber.x).toBeNaN();
    expect(notANumber.width).toBeNaN();
    expect(notANumber.y).toBe(2);
    expect(notANumber.height).toBe(9);
    expect(connectorRouteBounds([{ x: -Infinity, y: 3 }, { x: Infinity, y: 3 }], 0))
      .toEqual({ x: -Infinity, y: 3, width: Infinity, height: 1 });
  });
});

describe("deterministic route geometry", () => {
  it("resolves legacy straight geometry, route-relative labels, and complete bounds", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const edge = connector("edge", left.id, right.id);
    const route = resolveConnectorRoutes(room([left, right, edge])).edge;

    expect(route.routing).toEqual(LEGACY_CONNECTOR_ROUTING);
    expect(route.points).toEqual([
      { x: 100, y: 40 },
      { x: 500, y: 40 },
    ]);
    expect(route.start).toMatchObject({
      objectId: "left",
      normalizedAnchor: { x: 1, y: 0.5 },
      isPrecise: false,
      isExact: false,
      snap: "none",
    });
    expect(route.end).toMatchObject({ objectId: "right", normalizedAnchor: { x: 0, y: 0.5 } });
    expect(route.labelPoint).toEqual({ x: 300, y: 40 });
    expect(route.labelBounds).not.toBeNull();
    expect(route.bounds.x).toBeLessThanOrEqual(route.pathBounds.x);
    expect(route.bounds.y).toBeLessThanOrEqual(route.labelBounds!.y);
  });

  it("keeps a clean auto route straight and recomputes its resolved ports", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const edge = connector(
      "edge",
      left.id,
      right.id,
      normalizeConnectorRouting({ mode: "auto" }),
    );
    edge.start = {
      ...edge.start,
      normalizedAnchor: { x: 0.5, y: 1 },
      isPrecise: true,
    };
    edge.end = {
      ...edge.end,
      normalizedAnchor: { x: 0.5, y: 0 },
      isPrecise: true,
    };

    const route = resolveConnectorRoutes(room([left, right, edge])).edge;

    expect(route.routing).toMatchObject({ mode: "auto", kind: "straight" });
    expect(route.start).toMatchObject({ normalizedAnchor: { x: 1, y: 0.5 }, isPrecise: true });
    expect(route.end).toMatchObject({ normalizedAnchor: { x: 0, y: 0.5 }, isPrecise: true });
    expect(route.points).toEqual([
      { x: 100, y: 40 },
      { x: 500, y: 40 },
    ]);
  });

  it("centers each side of an aligned auto-routed chain without treating opposite sides as competing ports", () => {
    const nodes = [
      node("client", 0, 0),
      node("api", 300, 0),
      node("auth", 600, 0),
      node("store", 900, 0),
    ];
    const edges = nodes.slice(0, -1).map((current, index) => connector(
      `chain-${index}`,
      current.id,
      nodes[index + 1].id,
      normalizeConnectorRouting({ mode: "auto" }),
      index + 1,
    ));

    const routes = resolveConnectorRoutes(room([...nodes, ...edges]));

    for (const edge of edges) {
      expect(routes[edge.id].routing).toMatchObject({ mode: "auto", kind: "straight" });
      expect(routes[edge.id].start.normalizedAnchor).toEqual({ x: 1, y: 0.5 });
      expect(routes[edge.id].end.normalizedAnchor).toEqual({ x: 0, y: 0.5 });
      expect(routes[edge.id].points.every((point) => point.y === 40)).toBe(true);
    }
  });

  it("keeps imprecise straight ports movable across a later layout", () => {
    const start = node("start", 0, 0);
    const end = node("end", 0, 300);
    const edge = connector("edge", start.id, end.id);
    const before = resolveConnectorRoutes(room([start, end, edge])).edge;

    expect(before.start).toMatchObject({ normalizedAnchor: { x: 0.5, y: 1 }, isPrecise: false });
    expect(before.end).toMatchObject({ normalizedAnchor: { x: 0.5, y: 0 }, isPrecise: false });

    const movedEnd = { ...end, x: 500, y: 0 };
    const normalizedEdge = {
      ...edge,
      start: before.start,
      end: before.end,
      routing: before.routing,
    };
    const after = resolveConnectorRoutes(room([start, movedEnd, normalizedEdge])).edge;

    expect(after.start).toMatchObject({ normalizedAnchor: { x: 1, y: 0.5 }, isPrecise: false });
    expect(after.end).toMatchObject({ normalizedAnchor: { x: 0, y: 0.5 }, isPrecise: false });
    expect(after.points).toEqual([
      { x: 100, y: 40 },
      { x: 500, y: 40 },
    ]);
  });

  it("chooses a collision-free elbow around an unrelated service", () => {
    const left = node("left", 0, 100);
    const blocker = node("blocker", 250, 100, 100, 80);
    const right = node("right", 500, 100);
    const edge = connector(
      "edge",
      left.id,
      right.id,
      normalizeConnectorRouting({ mode: "auto" }),
    );
    const routingRoom = room([left, blocker, right, edge]);
    const originalSearch = resolveConnectorRoutes(routingRoom, { maxCandidates: 89 }).edge;
    const route = resolveConnectorRoutes(routingRoom, { maxCandidates: 90 }).edge;

    // The blocked preferred route must leave the complete fallback search,
    // its geometry, and its candidate budget unchanged.
    expect(route).toEqual(originalSearch);

    expect(route.routing).toMatchObject({ mode: "auto", kind: "elbow" });
    expect(route.collisionObjectIds).toEqual([]);
    expect(route.start.normalizedAnchor).toBeDefined();
    expect(route.end.normalizedAnchor).toBeDefined();
    expect(route.points.length).toBeGreaterThan(2);
    expect(route.points.some((point) => point.y < blocker.y || point.y > blocker.y + blocker.height)).toBe(true);
    expect(route.candidateCount).toBeLessThanOrEqual(CONNECTOR_ROUTING_LIMITS.maxCandidates);
  });

  it("samples a persisted curved route deterministically and places labels by path length", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const edge = connector(
      "curve",
      left.id,
      right.id,
      normalizeConnectorRouting({ mode: "curved", bend: 72, labelPosition: 0.25 }),
    );
    const first = resolveConnectorRoutes(room([left, right, edge])).curve;
    const second = resolveConnectorRoutes(room([edge, right, left])).curve;

    expect(first.routing).toMatchObject({ mode: "curved", kind: "curved", bend: 72 });
    expect(first.arc).not.toBeNull();
    expect(first.points.length).toBeGreaterThan(8);
    expect(first.points.length).toBeLessThanOrEqual(CONNECTOR_ROUTING_LIMITS.maxRoutePoints);
    expect(second).toEqual(first);
    expect(first.labelPoint).toEqual(pointAlongConnectorRoute(first.points, 0.25));
    expect(first.labelBounds).toEqual(connectorLabelBoundsForRoute("request", first.points, 0.25));
  });

  it("routes explicit elbows through authored absolute waypoints and materializes the same label path", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const waypoints = [{ x: 180, y: -120 }, { x: 420, y: -120 }];
    const edge = connector(
      "waypoint-edge",
      left.id,
      right.id,
      normalizeConnectorRouting({ mode: "elbow", waypoints, labelPosition: 0.6 }),
    );
    edge.start = {
      ...edge.start,
      normalizedAnchor: { x: 1, y: 0.5 },
      isPrecise: true,
      isExact: true,
      snap: "edge-point",
    };
    edge.end = {
      ...edge.end,
      normalizedAnchor: { x: 0, y: 0.5 },
      isPrecise: true,
      isExact: true,
      snap: "edge-point",
    };

    const routingRoom = room([left, right, edge]);
    const resolved = resolveConnectorRoutes(routingRoom)[edge.id];
    expect(resolved.start).toMatchObject({ objectId: left.id, isPrecise: true, isExact: true });
    expect(resolved.end).toMatchObject({ objectId: right.id, isPrecise: true, isExact: true });
    expect(resolved.routing.waypoints).toEqual(waypoints);
    expect(resolved.points).toEqual([
      { x: 100, y: 40 },
      ...waypoints,
      { x: 500, y: 40 },
    ]);
    expect(resolved.labelPoint).toEqual(pointAlongConnectorRoute(resolved.points, 0.6));

    const persisted = {
      ...edge,
      ...connectorRouteBounds(resolved.points, 0),
      start: resolved.start,
      end: resolved.end,
      routing: resolved.routing,
    };
    const materialized = materializeConnectorRoutes(room([left, right, persisted]))[edge.id];
    expect(materialized.points).toEqual(resolved.points);
    expect(materialized.labelPoint).toEqual(resolved.labelPoint);
    expect(materialized.labelBounds).toEqual(resolved.labelBounds);
  });

  it("materializes persisted straight, curved, elbow, and resolved-auto geometry without choosing a new route", () => {
    const left = node("left", 0, 100);
    const blocker = node("blocker", 250, 100, 100, 80);
    const right = node("right", 500, 100);
    const routings = [
      normalizeConnectorRouting({ mode: "straight", labelPosition: 0.2 }),
      normalizeConnectorRouting({ mode: "curved", bend: -72, labelPosition: 0.35 }),
      normalizeConnectorRouting({ mode: "elbow", elbowMidPoint: 0.65, labelPosition: 0.6 }),
      normalizeConnectorRouting({ mode: "auto", labelPosition: 0.75 }),
    ];

    for (const [index, routing] of routings.entries()) {
      const edge = connector(`persisted-${index}`, left.id, right.id, routing);
      const authoritativeRoom = room([left, blocker, right, edge]);
      const authoritative = resolveConnectorRoutes(authoritativeRoom)[edge.id];
      const persisted = {
        ...edge,
        ...connectorRouteBounds(authoritative.points, 0),
        start: authoritative.start,
        end: authoritative.end,
        routing: authoritative.routing,
      };
      const persistedRoom = room([left, blocker, right, persisted]);
      const materialized = materializeConnectorRoutes(persistedRoom)[edge.id];

      expect(materialized).toMatchObject({
        connectorId: edge.id,
        routing: authoritative.routing,
        start: authoritative.start,
        end: authoritative.end,
        points: authoritative.points,
        arc: authoritative.arc,
        labelPoint: authoritative.labelPoint,
        pathBounds: authoritative.pathBounds,
        labelBounds: authoritative.labelBounds,
        bounds: authoritative.bounds,
        candidateCount: 1,
      });
    }
  });

  it("detaches a deleted endpoint at its last point and clears stale binding metadata", () => {
    const left = node("left", 0, 0);
    const edge = connector("edge", left.id, "deleted");
    edge.end = {
      x: 640,
      y: 240,
      objectId: "deleted",
      normalizedAnchor: { x: 0, y: 0.25 },
      isPrecise: true,
      isExact: true,
      snap: "edge",
    };

    const route = resolveConnectorRoutes(room([left, edge], false)).edge;

    expect(route.end).toEqual({ x: 640, y: 240, objectId: null });
    expect(route.points.at(-1)).toEqual({ x: 640, y: 240 });
  });

  it("assigns stable parallel lanes and produces distinct persisted binding anchors", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const firstEdge = connector(
      "edge-a",
      left.id,
      right.id,
      normalizeConnectorRouting({ mode: "auto" }),
      10,
    );
    const secondEdge = connector(
      "edge-b",
      left.id,
      right.id,
      normalizeConnectorRouting({ mode: "auto" }),
      20,
    );
    const first = resolveConnectorRoutes(room([left, right, firstEdge, secondEdge]));
    const reordered = resolveConnectorRoutes(room([secondEdge, right, firstEdge, left]));

    expect(first["edge-a"].laneIndex).toBe(0);
    expect(first["edge-b"].laneIndex).toBe(1);
    expect(first["edge-a"].start.normalizedAnchor).not.toEqual(first["edge-b"].start.normalizedAnchor);
    expect(first["edge-b"].start.normalizedAnchor?.y).toBe(first["edge-b"].end.normalizedAnchor?.y);
    expect(first["edge-b"].routing).toMatchObject({ mode: "auto", kind: "curved", bend: 48 });
    expect(first["edge-b"].start).toMatchObject({ isPrecise: true, isExact: true });
    expect(first["edge-b"].end).toMatchObject({ isPrecise: true, isExact: true });
    expect(first["edge-a"].start).toMatchObject({ isExact: false });
    expect(first["edge-a"].end).toMatchObject({ isExact: false });
    expect(first["edge-b"].points.every((point) => point.y > first["edge-a"].points[0].y)).toBe(true);
    expect(first["edge-b"].labelBounds!.y).toBeGreaterThan(
      first["edge-a"].labelBounds!.y + first["edge-a"].labelBounds!.height,
    );
    expect(reordered).toEqual(first);
  });

  it("keeps mixed-direction connectors on unique physical lanes", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const routes = [
      connector("edge-a", left.id, right.id, normalizeConnectorRouting({ mode: "auto" }), 10),
      connector("edge-b", right.id, left.id, normalizeConnectorRouting({ mode: "auto" }), 20),
      connector("edge-c", left.id, right.id, normalizeConnectorRouting({ mode: "auto" }), 30),
    ];

    const resolved = resolveConnectorRoutes(room([left, right, ...routes]));
    expect(routes.map((edge) => resolved[edge.id].laneIndex)).toEqual([0, 1, -1]);
    expect(
      new Set(routes.map((edge) => resolved[edge.id].start.normalizedAnchor?.y)).size,
    ).toBe(3);
    expect(
      new Set(routes.map((edge) => Math.round(resolved[edge.id].labelPoint.y * 1_000))).size,
    ).toBe(3);
    expect(routes.map((edge) => resolved[edge.id].routing.kind)).toEqual([
      "straight",
      "curved",
      "curved",
    ]);
  });

  it("uses the structurally bounded deterministic solver for large connector batches", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const connectors = Array.from(
      { length: CONNECTOR_ROUTING_QUALITY_BATCH_LIMIT + 1 },
      (_, index) => connector(
        `bulk-${index}`,
        left.id,
        right.id,
        normalizeConnectorRouting({ mode: "auto" }),
        index + 1,
      ),
    );

    const routes = Object.values(resolveConnectorRoutes(room([left, right, ...connectors])));

    expect(routes).toHaveLength(CONNECTOR_ROUTING_QUALITY_BATCH_LIMIT + 1);
    expect(Math.max(...routes.map((route) => route.candidateCount))).toBeLessThanOrEqual(
      CONNECTOR_ROUTING_BOUNDED_MAX_CANDIDATES,
    );
    expect(Math.max(...routes.map((route) => Math.abs(route.routing.bend)))).toBeLessThanOrEqual(
      CONNECTOR_ROUTING_LIMITS.maxBend,
    );
  });

  it("limits obstacle scope to the connector's Diagram and reports deterministic fallback collisions", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const outside = node("outside", 250, -500, 100, 1_000);
    const edge = connector(
      "edge",
      left.id,
      right.id,
      normalizeConnectorRouting({ mode: "straight" }),
    );
    const scopedRoom = room([left, right, edge]);
    scopedRoom.objects.outside = outside;
    const scoped = resolveConnectorRoutes(scopedRoom).edge;
    const unscoped = resolveConnectorRoutes(room([left, right, outside, edge], false)).edge;

    expect(scoped.collisionObjectIds).toEqual([]);
    expect(unscoped.collisionObjectIds).toEqual(["outside"]);
    expect(unscoped.routing.kind).toBe("straight");
  });

  it("distributes a high-degree hub's incident ports in neighbor order", () => {
    const hub = node("hub", 0, 210, 160, 140);
    const leaves = Array.from({ length: 8 }, (_, index) =>
      node(`leaf-${index}`, 560, index * 80, 120, 64),
    );
    const edges = leaves.map((leaf, index) => {
      const edge = connector(
        `hub-edge-${index}`,
        hub.id,
        leaf.id,
        normalizeConnectorRouting({ mode: "auto" }),
        index + 1,
      );
      edge.label = `hub request ${index}`;
      return edge;
    });

    const resolved = resolveConnectorRoutes(room([hub, ...leaves, ...edges]));
    const hubAnchors = edges.map((edge) => resolved[edge.id].start.normalizedAnchor!);

    expect(new Set(hubAnchors.map((anchor) => `${anchor.x}:${anchor.y}`)).size).toBe(edges.length);
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const incident = edges
        .map((edge, index) => ({
          leafY: leaves[index].y,
          anchor: resolved[edge.id].start.normalizedAnchor!,
        }))
        .filter(({ anchor }) => connectorPortSide(anchor) === side)
        .sort((left, right) => left.leafY - right.leafY);
      const positions = incident.map(({ anchor }) => side === "top" || side === "bottom" ? anchor.x : anchor.y);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
    }
  });

  it("allocates fan-in and fan-out independently on opposite sides of one hub", () => {
    const hub = node("two-sided-hub", 300, 200, 120, 80);
    const leftLeaves = [0, 200, 400].map((y, index) =>
      node(`left-leaf-${index}`, 0, y),
    );
    const rightLeaves = [0, 200, 400].map((y, index) =>
      node(`right-leaf-${index}`, 620, y),
    );
    const incoming = leftLeaves.map((leaf, index) => connector(
      `incoming-${index}`,
      leaf.id,
      hub.id,
      normalizeConnectorRouting({ mode: "auto" }),
      index + 1,
    ));
    const outgoing = rightLeaves.map((leaf, index) => connector(
      `outgoing-${index}`,
      hub.id,
      leaf.id,
      normalizeConnectorRouting({ mode: "auto" }),
      index + 10,
    ));

    const all = [
      hub,
      ...leftLeaves,
      ...rightLeaves,
      ...incoming,
      ...outgoing,
    ];
    const routes = resolveConnectorRoutes(room(all));
    const reversed = resolveConnectorRoutes(room([...all].reverse()));

    const incomingAnchors = incoming.map((edge) => routes[edge.id].end.normalizedAnchor!);
    const outgoingAnchors = outgoing.map((edge) => routes[edge.id].start.normalizedAnchor!);
    expect(incomingAnchors.map((anchor) => anchor.x)).toEqual([0, 0, 0]);
    expect(incomingAnchors.map((anchor) => Number(anchor.y.toFixed(2)))).toEqual([0.16, 0.5, 0.84]);
    expect(outgoingAnchors.map((anchor) => anchor.x)).toEqual([1, 1, 1]);
    expect(outgoingAnchors.map((anchor) => Number(anchor.y.toFixed(2)))).toEqual([0.16, 0.5, 0.84]);
    expect(reversed).toEqual(routes);
  });

  it("solves default auto label positions around prior labels and routes but preserves explicit positions", () => {
    const first = connector(
      "label-a",
      "missing-a",
      "missing-b",
      normalizeConnectorRouting({ mode: "auto" }),
      1,
    );
    first.start = { x: 0, y: 0, objectId: null };
    first.end = { x: 600, y: 0, objectId: null };
    first.label = "route label";
    const second = connector(
      "label-b",
      "missing-c",
      "missing-d",
      normalizeConnectorRouting({ mode: "auto" }),
      2,
    );
    second.start = { x: 0, y: 8, objectId: null };
    second.end = { x: 600, y: 8, objectId: null };
    second.label = first.label;
    const explicit = connector(
      "label-explicit",
      "missing-e",
      "missing-f",
      normalizeConnectorRouting({ mode: "auto", labelPosition: 0.75 }),
      3,
    );
    explicit.start = { x: 0, y: 16, objectId: null };
    explicit.end = { x: 600, y: 16, objectId: null };
    explicit.label = first.label;

    const resolved = resolveConnectorRoutes(
      room([first, second, explicit], false),
      { maxCandidates: 1 },
    );

    expect(resolved[first.id].routing.labelPosition).toBe(0.5);
    expect(resolved[second.id].routing.labelPosition).not.toBe(0.5);
    expect(resolved[explicit.id].routing.labelPosition).toBe(0.75);
    expect(resolved[first.id].routing.labelPositionSource).toBe("generated");
    expect(resolved[second.id].routing.labelPositionSource).toBe("generated");
    expect(resolved[explicit.id].routing.labelPositionSource).toBe("authored");
    expect(resolved[first.id].labelBounds).not.toBeNull();
    expect(resolved[second.id].labelBounds).not.toBeNull();
    const a = resolved[first.id].labelBounds!;
    const b = resolved[second.id].labelBounds!;
    expect(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y)
      .toBe(true);

    const persistedGenerated = {
      ...second,
      start: resolved[second.id].start,
      end: resolved[second.id].end,
      routing: resolved[second.id].routing,
    };
    const recomputed = resolveConnectorRoutes(
      room([persistedGenerated], false),
      { maxCandidates: 1 },
    )[second.id];
    expect(recomputed.routing).toMatchObject({
      labelPosition: 0.5,
      labelPositionSource: "generated",
    });
  });

  it("counts shared-endpoint crossings away from the terminal but waives the shared terminal itself", () => {
    const source = node("shared-source", 0, 0, 100, 100);
    const upper = node("upper-target", 500, 0);
    const lower = node("lower-target", 500, 200);
    const upperEdge = connector(
      "upper-edge",
      source.id,
      upper.id,
      normalizeConnectorRouting({ mode: "straight" }),
      1,
    );
    upperEdge.start = {
      ...upperEdge.start,
      normalizedAnchor: { x: 1, y: 0.8 },
      isPrecise: true,
    };
    upperEdge.end = {
      ...upperEdge.end,
      normalizedAnchor: { x: 0, y: 0.8 },
      isPrecise: true,
    };
    const crossingEdge = connector(
      "crossing-edge",
      source.id,
      lower.id,
      normalizeConnectorRouting({ mode: "straight" }),
      2,
    );
    crossingEdge.start = {
      ...crossingEdge.start,
      normalizedAnchor: { x: 1, y: 0.2 },
      isPrecise: true,
    };
    crossingEdge.end = {
      ...crossingEdge.end,
      normalizedAnchor: { x: 0, y: 0.2 },
      isPrecise: true,
    };

    const crossed = resolveConnectorRoutes(room([source, upper, lower, upperEdge, crossingEdge]));
    expect(crossed[crossingEdge.id].crossingCount).toBe(1);

    crossingEdge.start.normalizedAnchor = { x: 1, y: 0.8 };
    const terminalOnly = resolveConnectorRoutes(
      room([source, upper, lower, upperEdge, crossingEdge]),
    );
    expect(terminalOnly[crossingEdge.id].crossingCount).toBe(0);
  });

  it("keeps author-bound auto ports while recomputing generated snap-none anchors", () => {
    const left = node("bound-left", 0, 0);
    const right = node("bound-right", 500, 0);
    const edge = connector(
      "bound-edge",
      left.id,
      right.id,
      normalizeConnectorRouting({ mode: "auto", labelPosition: 0.75 }),
    );
    edge.start = {
      ...edge.start,
      normalizedAnchor: { x: 1, y: 0.2 },
      isPrecise: true,
      snap: "edge-point",
    };
    edge.end = {
      ...edge.end,
      normalizedAnchor: { x: 0.5, y: 0 },
      isPrecise: true,
      snap: "none",
    };

    const route = resolveConnectorRoutes(room([left, right, edge]))[edge.id];

    expect(route.routing).toMatchObject({ labelPosition: 0.75, labelPositionSource: "authored" });
    expect(route.labelPoint).toEqual(pointAlongConnectorRoute(route.points, 0.75));
    expect(route.candidateCount).toBe(1);
    expect(route.start).toMatchObject({
      normalizedAnchor: { x: 1, y: 0.2 },
      isPrecise: true,
      snap: "edge-point",
    });
    expect(route.end).toMatchObject({
      normalizedAnchor: { x: 0, y: 0.5 },
      isPrecise: true,
      snap: "none",
    });
  });

  it("does not let an authored attachment displace an automatic singleton's generated port", () => {
    const hub = node("hub", 0, 100);
    const authoredTarget = node("authored-target", 500, 0);
    const automaticTarget = node("automatic-target", 500, 200);
    const authored = connector(
      "authored-edge",
      hub.id,
      authoredTarget.id,
      normalizeConnectorRouting({ mode: "auto" }),
      1,
    );
    authored.start = {
      ...authored.start,
      normalizedAnchor: { x: 1, y: 0.2 },
      isPrecise: true,
      isExact: false,
      snap: "edge-point",
    };
    const automatic = connector(
      "automatic-edge",
      hub.id,
      automaticTarget.id,
      normalizeConnectorRouting({ mode: "auto" }),
      2,
    );

    const routes = resolveConnectorRoutes(room([
      hub,
      authoredTarget,
      automaticTarget,
      authored,
      automatic,
    ]));

    expect(routes[authored.id].start.normalizedAnchor).toEqual({ x: 1, y: 0.2 });
    const automaticAnchor = routes[automatic.id].start.normalizedAnchor!;
    expect(automaticAnchor).toEqual(
      cardinalNormalizedAnchor(connectorPortSide(automaticAnchor), 0.5),
    );
  });

  it("routes a dense architecture fan-out deterministically across insertion orders", () => {
    const api = node("api", 0, 240, 140, 100);
    const services = Array.from({ length: 10 }, (_, index) =>
      node(`service-${index}`, 620 + (index % 2) * 220, index * 72, 150, 58),
    );
    const edges = services.map((service, index) => {
      const edge = connector(
        `dense-edge-${String(index).padStart(2, "0")}`,
        api.id,
        service.id,
        normalizeConnectorRouting({ mode: "auto" }),
        100 + index,
      );
      edge.label = ["authorize", "status webhook", "assemble", "fulfill"][index % 4];
      return edge;
    });
    const all = [api, ...services, ...edges];

    const first = resolveConnectorRoutes(room(all));
    const reversed = resolveConnectorRoutes(room([...all].reverse()));

    expect(reversed).toEqual(first);
    expect(Object.keys(first)).toHaveLength(edges.length);
    expect(new Set(edges.map((edge) => {
      const anchor = first[edge.id].start.normalizedAnchor!;
      return `${anchor.x.toFixed(4)}:${anchor.y.toFixed(4)}`;
    })).size).toBe(edges.length);
    expect(Math.max(...Object.values(first).map((route) => route.candidateCount)))
      .toBeLessThanOrEqual(CONNECTOR_ROUTING_LIMITS.maxCandidates);
  });
});


describe("quality routing search preserves visible geometry", () => {
  it("keeps clean route geometry identical across the 89/90 candidate budget boundary", () => {
    const left = node("budget-left", 0, 0);
    const right = node("budget-right", 500, 0);
    const edge = connector("budget-edge", left.id, right.id, normalizeConnectorRouting({ mode: "auto" }));
    const routingRoom = room([left, right, edge]);
    const constrained = resolveConnectorRoutes(routingRoom, { maxCandidates: 89 })[edge.id];
    const complete = resolveConnectorRoutes(routingRoom, { maxCandidates: 90 })[edge.id];

    expect(complete.points).toEqual([{ x: 100, y: 40 }, { x: 500, y: 40 }]);
    expect(complete.collisionObjectIds).toEqual([]);
    expect({ ...complete, candidateCount: constrained.candidateCount }).toEqual(constrained);
    expect(constrained.candidateCount).toBe(89);
    expect(complete.candidateCount).toBe(1);
  });

  it("preserves a clamped reverse parallel curve without routing the whole lane cohort", () => {
    const left = node("clamp-left", 0, 0);
    const right = node("clamp-right", 500, 0);
    const edges = Array.from({ length: 43 }, (_, index) => {
      const edge = connector(
        "clamp-" + String(index).padStart(2, "0"),
        index % 2 ? right.id : left.id,
        index % 2 ? left.id : right.id,
        normalizeConnectorRouting({ mode: "auto" }),
        index + 1,
      );
      edge.label = "";
      return edge;
    });
    const routingRoom = room([left, right, ...edges]);
    const target = edges[39];
    const constrained = resolveConnectorRoute(target, createConnectorRoutingContext(routingRoom, {
      resolutionMode: "quality", laneSpacing: 256, maxCandidates: 89,
    }));
    const complete = resolveConnectorRoute(target, createConnectorRoutingContext(routingRoom, {
      resolutionMode: "quality", laneSpacing: 256, maxCandidates: 90,
    }));

    expect(complete.laneIndex).toBe(20);
    expect(complete.routing.kind).toBe("curved");
    expect(Math.abs(complete.routing.bend)).toBe(CONNECTOR_ROUTING_LIMITS.maxBend);
    expect(complete.start.objectId).toBe(right.id);
    expect(complete.end.objectId).toBe(left.id);
    expect(complete.arc).not.toBeNull();
    expect(complete.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    expect({ ...complete, candidateCount: constrained.candidateCount }).toEqual(constrained);
    expect(constrained.candidateCount).toBeGreaterThan(1);
    expect(complete.candidateCount).toBe(1);
  });

  it("keeps an unlabeled path clear of a prior route's label", () => {
    const prior = connector("prior-labeled", "missing-a", "missing-b", normalizeConnectorRouting({ mode: "straight" }), 1);
    prior.start = { x: 0, y: 0, objectId: null };
    prior.end = { x: 600, y: 0, objectId: null };
    prior.label = "Prior route label";
    const following = connector("following-unlabeled", "missing-c", "missing-d", normalizeConnectorRouting({ mode: "auto" }), 2);
    following.start = { x: 0, y: 8, objectId: null };
    following.end = { x: 600, y: 8, objectId: null };
    following.label = "";

    const visibleLabel = resolveConnectorRoutes(room([prior, following], false));
    const withoutLabel = resolveConnectorRoutes(room([{ ...prior, label: "" }, following], false));
    const route = visibleLabel[following.id];
    const priorLabel = visibleLabel[prior.id].labelBounds!;

    expect(route.labelBounds).toBeNull();
    expect(route.crossingCount).toBe(0);
    expect(route.collisionObjectIds).toEqual([]);
    expect(route.routing.kind).toBe("curved");
    expect(route.labelPoint.y).toBeGreaterThan(priorLabel.y + priorLabel.height);
    expect(withoutLabel[following.id].routing.kind).toBe("straight");
    expect(withoutLabel[following.id].points).toEqual([{ x: 0, y: 8 }, { x: 600, y: 8 }]);
  });
});

describe("connector obstacle preparation preserves routing scope", () => {
  it("keeps the same collision-free scoped route among 1,000 unrelated obstacles", () => {
    const left = node("scope-left", 0, 100);
    const right = node("scope-right", 500, 100);
    const blocker = node("scope-blocker", 250, 100);
    const otherMembers = Array.from({ length: 5 }, (_, index) =>
      node("scope-member-" + index, index * 150, 500),
    );
    const edge = connector("scope-edge", left.id, right.id, normalizeConnectorRouting({ mode: "auto" }));
    edge.label = "Scoped decision";
    const scoped = room([left, right, blocker, ...otherMembers, edge]);
    const crowded = {
      ...scoped,
      objects: {
        ...scoped.objects,
        ...Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => {
          const outside = node("outside-" + String(index).padStart(4, "0"),
            (index % 20) * 30, Math.floor(index / 20) * 10 - 100, 18, 18);
          return [outside.id, outside];
        })),
      },
    };

    const reference = resolveConnectorRoutes(scoped)[edge.id];
    const route = resolveConnectorRoutes(crowded)[edge.id];
    expect(route).toEqual(reference);
    expect(route.routing.kind).toBe("elbow");
    expect(route.collisionObjectIds).toEqual([]);
    expect(crowded.diagrams["diagram-routing"].memberObjectIds).toHaveLength(8);
  });

  it("retains sorted collision IDs and endpoint exclusions when an allowed map entry is absent", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const firstAlongPath = node("z-obstacle", 180, 0);
    const lastAlongPath = node("a-obstacle", 350, 0);
    const edge = connector("edge", left.id, right.id, normalizeConnectorRouting({ mode: "straight" }));
    edge.label = "";
    const context = createConnectorRoutingContext(room([left, right, firstAlongPath, lastAlongPath, edge], false));

    const absent = resolveConnectorRoute(edge, { ...context, obstacleIdsByConnector: new Map() });
    const empty = resolveConnectorRoute(edge, {
      ...context, obstacleIdsByConnector: new Map([[edge.id, new Set<string>()]]),
    });
    expect(absent.collisionObjectIds).toEqual(["a-obstacle", "z-obstacle"]);
    expect(empty.collisionObjectIds).toEqual([]);
    expect(empty.points).toEqual(absent.points);
  });

  it("applies obstacle padding to label-only collisions as well as paths", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const edge = connector("edge", left.id, right.id, normalizeConnectorRouting({ mode: "straight" }));
    const clear = resolveConnectorRoutes(room([left, right, edge]))[edge.id];
    const label = clear.labelBounds!;
    const nearLabel = node("label-padding", label.x + label.width / 2, label.y - 2, 4, 1);
    const routingRoom = room([left, right, nearLabel, edge]);
    const unpadded = resolveConnectorRoutes(routingRoom, { obstaclePadding: 0 })[edge.id];
    const padded = resolveConnectorRoutes(routingRoom, { obstaclePadding: 2 })[edge.id];

    expect(unpadded.collisionObjectIds).toEqual([]);
    expect(padded.collisionObjectIds).toEqual([nearLabel.id]);
    expect(padded.points).toEqual(unpadded.points);
    expect(padded.labelBounds).toEqual(unpadded.labelBounds);
  });
});

describe("native Mermaid group boundaries", () => {
  function groupedRoom() {
    const container = { ...node("group-box", 0, 0, 400, 300), label: "", groupId: "g", semanticRole: "diagram.group_container" };
    const inside = { ...node("inside", 80, 100), groupId: "g", zIndex: 1 };
    const outside = { ...node("outside", 600, 100), zIndex: 1 };
    const title: CanvasObject = { ...base("group-title"), kind: "text", content: "Services", color: "black", size: "m", align: "start",
      x: 30, y: 20, width: 300, height: 40, groupId: "g", semanticRole: "diagram.group_title", zIndex: 1 };
    const edge = { ...connector("owned", inside.id, outside.id), zIndex: 2 };
    return { container, inside, outside, title, edge };
  }
  it("allows entry and exit through an endpoint's background group but retains its title obstacle", () => {
    const { container, inside, outside, title, edge } = groupedRoom();
    const incoming = { ...connector("incoming", outside.id, inside.id), zIndex: 2 };
    const context = createConnectorRoutingContext(room([container, inside, outside, title, edge, incoming]));
    for (const connection of [edge, incoming]) {
      expect(context.obstacleIdsByConnector.get(connection.id)?.has(container.id)).toBe(false);
      expect(context.obstacleIdsByConnector.get(connection.id)?.has(title.id)).toBe(true);
      expect(context.obstacleIdsByConnector.get(connection.id)?.has(inside.id)).toBe(true);
    }
  });
  it("keeps a passable background boundary out of collision results while retaining titles", () => {
    const { container, inside, outside, title, edge } = groupedRoom();
    const passable = resolveConnectorRoutes(room([container, inside, outside, title, edge]))[edge.id];
    const titleAcrossRoute = { ...title, x: 250, y: 120, width: 80, height: 40 };
    const titleBlocked = resolveConnectorRoutes(room([container, inside, outside, titleAcrossRoute, edge]))[edge.id];
    const labeledBoundary = resolveConnectorRoutes(room([
      { ...container, label: "Visible boundary" }, inside, outside, title, edge,
    ]))[edge.id];

    expect(passable.collisionObjectIds).toEqual([]);
    expect(titleBlocked.collisionObjectIds).toEqual([title.id]);
    expect(labeledBoundary.collisionObjectIds).toEqual([container.id]);
  });

  it("retains unrelated, foreground, labeled, and non-containing boundaries as obstacles", () => {
    const { container, inside, outside, edge } = groupedRoom();
    for (const boundary of [
      { ...container, groupId: "other" }, { ...container, zIndex: 3 },
      { ...container, label: "Visible label" }, { ...container, x: 2000 },
    ]) {
      const context = createConnectorRoutingContext(room([boundary, inside, outside, edge]));
      expect(context.obstacleIdsByConnector.get(edge.id)?.has(boundary.id)).toBe(true);
    }
  });
});
