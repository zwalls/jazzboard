import { describe, expect, it } from "vitest";

import type {
  ActorRef,
  CanvasObject,
  ConnectorObject,
  ConnectorRouting,
  Diagram,
  RoomState,
} from "./types";
import {
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

function node(id: string, x: number, y: number, width = 100, height = 80): CanvasObject {
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
    const route = resolveConnectorRoutes(room([left, blocker, right, edge])).edge;

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
      normalizeConnectorRouting({ mode: "auto" }),
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
