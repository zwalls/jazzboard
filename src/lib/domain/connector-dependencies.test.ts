import { describe, expect, it, vi } from "vitest";

import * as connectorRouting from "./connector-routing";
import { normalizeConnectorRouting } from "./connector-routing";
import {
  computeAffectedConnectorIds,
  computePotentialMoveConnectorIds,
  createConnectorDependencyAnalyzer,
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
  it("does not materialize routes for node labels and Diagram metadata, but tracks connector labels", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const edge = connector("edge", left, right);
    const baseline = room([left, right, edge], [diagram("diagram", [left.id, right.id], [edge.id])]);
    const current = changedRoom(baseline, (state) => {
      (state.objects.left as ShapeObject).label = "A new node label";
      state.diagrams.diagram.title = "A new diagram title";
    });
    const materialize = vi.spyOn(connectorRouting, "materializeConnectorRoute");
    try {
      const input = { baseline, current, touchedObjectIds: new Set(["left"]), touchedDiagramIds: new Set(["diagram"]) };
      expect([...computeAffectedConnectorIds(input)]).toEqual([]);
      expect(materialize).not.toHaveBeenCalled();

      (current.objects.edge as ConnectorObject).label = "A new connector label";
      expect([...computeAffectedConnectorIds({ ...input, touchedObjectIds: new Set(["left", "edge"]) })])
        .toEqual(["edge"]);
      expect(materialize.mock.calls).toEqual([
        [current.objects.edge, current],
        [baseline.objects.edge, baseline],
      ]);
    } finally {
      materialize.mockRestore();
    }
  });

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

  it("indexes forward Diagram scopes once and follows only later overlapping dependencies", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const early = connector("early", left, right, 2);
    const source = connector("source", left, right, 3, "straight");
    const bridge = connector("bridge", left, right, 4);
    const later = connector("later", left, right, 5);
    const disjoint = connector("disjoint", left, right, 6);
    const global = connector("global", left, right, 7, "straight");
    const globalDependent = connector("global-dependent", left, right, 8);
    const otherScope = diagram("third", [], [disjoint.id, globalDependent.id]);
    // The reverse object memberships are deliberately empty in this fixture.
    const scan = vi.fn(() => [disjoint.id, globalDependent.id]);
    Object.defineProperty(otherScope, "connectorIds", { get: scan });
    const state = room(
      [left, right, early, source, bridge, later, disjoint, global, globalDependent],
      [
        diagram("first", [], [source.id, bridge.id]),
        diagram("second", [], [early.id, bridge.id, later.id]),
        otherScope,
      ],
    );

    expect([...computePotentialMoveConnectorIds({
      room: state, movedObjectIds: new Set(), explicitConnectorIds: new Set([source.id]),
    })]).toEqual(["source", "bridge", "later"]);
    expect(scan).toHaveBeenCalledTimes(1);
    expect([...computePotentialMoveConnectorIds({
      room: state, movedObjectIds: new Set(), explicitConnectorIds: new Set([global.id]),
    })]).toEqual(["global", "global-dependent"]);
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

  it("reroutes the full automatic incident cohort when a fan-out edge is added", () => {
    const hub = node("hub", 0, 100);
    const firstLeaf = node("first-leaf", 500, 0);
    const secondLeaf = node("second-leaf", 500, 200);
    const first = connector("first-edge", hub, firstLeaf, 2);
    const baseline = room([hub, firstLeaf, secondLeaf, first]);
    const second = connector("second-edge", hub, secondLeaf, 3);
    const current = changedRoom(baseline, (next) => {
      next.objects[second.id] = second;
    });

    expect(computeAffectedConnectorIds({
      baseline,
      current,
      touchedObjectIds: new Set([second.id]),
    })).toEqual(new Set([second.id, first.id]));
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

  it("uses both geometry snapshots' forward scopes when Diagram membership changes", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const obstacle = node("obstacle", 240, 200);
    const edge = connector("edge", left, right, 4);
    const withoutObstacle = room([left, right, obstacle, edge], [
      diagram("scope", [left.id, right.id], [edge.id]),
    ]);
    const withObstacle = changedRoom(withoutObstacle, (next) => {
      next.objects.obstacle.y = 10;
      next.diagrams.scope.memberObjectIds.push("obstacle");
    });

    const touchedObjectIds = new Set(["obstacle"]);
    expect([...computeAffectedConnectorIds({
      baseline: withoutObstacle, current: withObstacle, touchedObjectIds,
    })]).toEqual(["edge"]);
    expect([...computeAffectedConnectorIds({
      baseline: withObstacle, current: withoutObstacle, touchedObjectIds,
    })]).toEqual(["edge"]);
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

  it("reuses the same rotated influence bounds across impacts but checks fresh geometry next time", () => {
    const a1 = node("a1", 0, 0);
    const b1 = node("b1", 500, 0);
    const a2 = node("a2", 0, 50);
    const b2 = node("b2", 500, 50);
    const a3 = node("a3", 0, 400);
    const b3 = node("b3", 500, 400);
    a3.rotation = Math.PI / 6;
    const first = connector("first", a1, b1, 10);
    const second = connector("second", a2, b2, 20);
    const later = connector("later", a3, b3, 30);
    const baseline = room([a1, b1, a2, b2, a3, b3, first, second, later]);
    const updateTwoLabels = (next: ConnectorDependencyRoom) => {
      (next.objects.first as ConnectorObject).label = "first update";
      (next.objects.second as ConnectorObject).label = "second update";
    };
    const current = changedRoom(baseline, updateTwoLabels);
    const readRotation = vi.fn(() => Math.PI / 6);
    Object.defineProperty(current.objects.a3, "rotation", { get: readRotation });
    const touchedObjectIds = new Set(["first", "second"]);

    expect([...computeAffectedConnectorIds({ baseline, current, touchedObjectIds })]).toEqual(["first", "second"]);
    // One pair of sine/cosine reads for the later endpoint despite two
    // earlier route impacts visiting its unchanged candidate bounds.
    expect(readRotation).toHaveBeenCalledTimes(2);

    const nextBaseline = changedRoom(baseline, (next) => {
      const left = next.objects.a3 as ShapeObject;
      const right = next.objects.b3 as ShapeObject;
      left.y = 80;
      right.y = 80;
      next.objects.later = connector("later", left, right, 30);
    });
    expect([...computeAffectedConnectorIds({
      baseline: nextBaseline, current: changedRoom(nextBaseline, updateTwoLabels), touchedObjectIds,
    })]).toEqual(["first", "second", "later"]);
  });

  it("reuses just the required baseline route across updates and rematerializes current geometry", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const farLeft = node("far-left", 0, 1500);
    const farRight = node("far-right", 500, 1500);
    const baseline = room([left, right, farLeft, farRight,
      connector("edge", left, right), connector("unrelated", farLeft, farRight, 2, "straight")], [
      diagram("near", [left.id, right.id], ["edge"]),
      diagram("far", [farLeft.id, farRight.id], ["unrelated"]),
    ]);
    const metadata = changedRoom(baseline, (next) => {
      (next.objects.left as ShapeObject).label = "New label";
    });
    const updates = [10, 20].map((y) => ({
      current: changedRoom(baseline, (next) => { next.objects.left.y = y; }),
      touchedObjectIds: new Set(["left"]),
    }));
    const expected = updates.map((update) => [...computeAffectedConnectorIds({ ...update, baseline })]);
    const materialize = vi.spyOn(connectorRouting, "materializeConnectorRoute");
    try {
      const analyze = createConnectorDependencyAnalyzer(baseline);
      expect([...analyze({ current: metadata, touchedObjectIds: new Set(["left"]) })]).toEqual([]);
      expect(materialize).not.toHaveBeenCalled();
      expect(expected).toEqual([["edge"], ["edge"]]);
      expect(updates.map((update) => [...analyze(update)])).toEqual(expected);
      expect(materialize.mock.calls).toEqual([
        [updates[0].current.objects.edge, updates[0].current],
        [baseline.objects.edge, baseline],
        [updates[1].current.objects.edge, updates[1].current],
      ]);
    } finally {
      materialize.mockRestore();
    }
  });

  it("keeps considering the old influence of a changed route for later connectors", () => {
    const left = node("left", 0, 0);
    const right = node("right", 500, 0);
    const laterLeft = node("later-left", 0, 55);
    const laterRight = node("later-right", 500, 55);
    const first = connector("first", left, right, 10);
    first.start.objectId = null;
    first.end.objectId = null;
    const later = connector("later", laterLeft, laterRight, 20);
    const baseline = room([left, right, laterLeft, laterRight, first, later]);
    const current = changedRoom(baseline, (next) => {
      const moved = next.objects.first as ConnectorObject;
      moved.y += 600;
      moved.start.y += 600;
      moved.end.y += 600;
    });

    expect([...computeAffectedConnectorIds({
      baseline, current, touchedObjectIds: new Set(["first"]),
    })]).toEqual(["first", "later"]);
  });
});
