import { describe, expect, it } from "vitest";

import { normalizeConnectorRouting } from "./connector-routing";
import {
  computeAffectedConnectorIds,
  computePotentialMoveConnectorIds,
  type ConnectorDependencyRoom,
} from "./connector-dependencies";
import type { ActorRef, CanvasObject, ConnectorObject, Diagram, ShapeObject } from "./types";

const actor: ActorRef = {
  participantId: "participant-dependencies",
  displayName: "Dependency tester",
  color: "blue",
  kind: "agent",
};

function base(id: string, createdAt = 1) {
  return {
    id,
    x: 0,
    y: 0,
    width: 80,
    height: 60,
    rotation: 0,
    zIndex: createdAt,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt,
    updatedAt: createdAt,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function node(id: string, x: number, y: number, createdAt = 1): ShapeObject {
  return {
    ...base(id, createdAt),
    kind: "shape",
    x,
    y,
    shape: "rectangle",
    nodeType: "service",
    label: id,
    fill: "blue",
    stroke: "blue",
  };
}

function connector(
  id: string,
  start: ShapeObject,
  end: ShapeObject,
  createdAt = 1,
  mode: "auto" | "straight" = "auto",
): ConnectorObject {
  const y = start.y + start.height / 2;
  const startX = start.x + start.width;
  const endX = end.x;
  return {
    ...base(id, createdAt),
    kind: "connector",
    x: startX,
    y,
    width: Math.max(endX - startX, 1),
    height: 1,
    start: { x: startX, y, objectId: start.id },
    end: { x: endX, y: end.y + end.height / 2, objectId: end.id },
    routing: normalizeConnectorRouting({ mode }),
    direction: "end",
    label: id,
    color: "black",
  };
}

function diagram(
  id: string,
  memberObjectIds: string[],
  connectorIds: string[],
): Diagram {
  return {
    id,
    title: id,
    description: "Connector dependency fixture",
    diagramType: "architecture",
    category: null,
    tags: [],
    memberObjectIds,
    connectorIds,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function room(objects: CanvasObject[], diagrams: Diagram[] = []): ConnectorDependencyRoom {
  return {
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: Object.fromEntries(diagrams.map((item) => [item.id, item])),
  };
}

function changedRoom(
  baseline: ConnectorDependencyRoom,
  change: (current: ConnectorDependencyRoom) => void,
): ConnectorDependencyRoom {
  const current = structuredClone(baseline);
  change(current);
  return current;
}

describe("connector dependency closure", () => {
  it("preflights grouped, bound, scoped auto, and transitive move dependencies", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const obstacle = node("obstacle", 250, 300);
    const outside = node("outside", 900, 300);
    const grouped = connector("grouped", left, right, 2, "straight");
    const auto = connector("auto", left, right, 3, "auto");
    const later = connector("later", left, right, 4, "auto");
    const unrelated = connector("unrelated", outside, outside, 5, "auto");
    const state = room(
      [left, right, obstacle, outside, grouped, auto, later, unrelated],
      [
        diagram("diagram-main", [left.id, right.id, obstacle.id], [grouped.id, auto.id, later.id]),
        diagram("diagram-outside", [outside.id], [unrelated.id]),
      ],
    );

    expect([...computePotentialMoveConnectorIds({
      room: state,
      movedObjectIds: new Set(["obstacle"]),
      explicitConnectorIds: new Set(["grouped"]),
    })]).toEqual(["grouped", "auto", "later"]);
  });

  it("includes a connector bound to a moved object for optimistic protection and leasing", () => {
    const left = node("left", 0, 0);
    const right = node("right", 400, 0);
    const edge = connector("edge", left, right, 3, "straight");
    const baseline = room([left, right, edge]);
    const current = changedRoom(baseline, (next) => {
      next.objects.left.x += 120;
    });

    expect([...computeAffectedConnectorIds({
      baseline,
      current,
      touchedObjectIds: new Set(["left"]),
    })]).toEqual(["edge"]);
  });

  it("includes an auto route when a moved shape crosses its obstacle corridor", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const obstacle = node("obstacle", 240, 200);
    const edge = connector("edge", left, right, 4);
    const baseline = room([left, right, obstacle, edge]);
    const current = changedRoom(baseline, (next) => {
      next.objects.obstacle.y = 10;
    });

    expect(computeAffectedConnectorIds({
      baseline,
      current,
      touchedObjectIds: new Set(["obstacle"]),
    })).toEqual(new Set(["edge"]));
  });

  it("limits obstacle dependencies to the connector's diagram membership", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const scopedObstacle = node("scoped-obstacle", 220, 200);
    const outsideObstacle = node("outside-obstacle", 300, 200);
    const edge = connector("edge", left, right, 5);
    const scope = diagram(
      "diagram-one",
      [left.id, right.id, scopedObstacle.id],
      [edge.id],
    );
    const baseline = room([left, right, scopedObstacle, outsideObstacle, edge], [scope]);
    const outsideMove = changedRoom(baseline, (next) => {
      next.objects["outside-obstacle"].y = 10;
    });
    const scopedMove = changedRoom(baseline, (next) => {
      next.objects["scoped-obstacle"].y = 10;
    });

    expect(computeAffectedConnectorIds({
      baseline,
      current: outsideMove,
      touchedObjectIds: new Set(["outside-obstacle"]),
    })).toEqual(new Set());
    expect(computeAffectedConnectorIds({
      baseline,
      current: scopedMove,
      touchedObjectIds: new Set(["scoped-obstacle"]),
    })).toEqual(new Set(["edge"]));
  });

  it("transitively includes only later ordered auto routes with overlapping influence", () => {
    const a1 = node("a1", 0, 0);
    const b1 = node("b1", 500, 0);
    const a2 = node("a2", 0, 70);
    const b2 = node("b2", 500, 70);
    const a3 = node("a3", 0, 140);
    const b3 = node("b3", 500, 140);
    const edge1 = connector("edge-1", a1, b1, 10);
    const edge2 = connector("edge-2", a2, b2, 20);
    const edge3 = connector("edge-3", a3, b3, 30);
    const baseline = room([a1, b1, a2, b2, a3, b3, edge1, edge2, edge3]);
    const current = changedRoom(baseline, (next) => {
      const changed = next.objects["edge-1"];
      if (changed.kind === "connector") changed.label = "changed first route";
    });

    expect([...computeAffectedConnectorIds({
      baseline,
      current,
      touchedObjectIds: new Set(["edge-1"]),
    })]).toEqual(["edge-1", "edge-2", "edge-3"]);

    const lastCurrent = changedRoom(baseline, (next) => {
      const changed = next.objects["edge-3"];
      if (changed.kind === "connector") changed.label = "changed last route";
    });
    expect([...computeAffectedConnectorIds({
      baseline,
      current: lastCurrent,
      touchedObjectIds: new Set(["edge-3"]),
    })]).toEqual(["edge-3"]);
  });
});
