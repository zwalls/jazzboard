import { describe, expect, it } from "vitest";

import type { ActorRef, CanvasObject } from "@/lib/domain/types";

import {
  planSemanticZOrder,
  SemanticZOrderError,
} from "./semantic-z-order";

const actor: ActorRef = {
  participantId: "human-z",
  displayName: "Z",
  color: "blue",
  kind: "human",
};

function shape(id: string, zIndex: number): CanvasObject {
  return {
    id,
    kind: "shape",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    zIndex,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
    shape: "rectangle",
    nodeType: null,
    nodeMetadata: null,
    label: id,
    fill: "white",
    stroke: "black",
  };
}

function projectedOrder(objects: readonly CanvasObject[], plan: ReturnType<typeof planSemanticZOrder>) {
  const updates = new Map(plan.updates.map(({ object, zIndex }) => [object.id, zIndex]));
  return [...objects]
    .map((object) => ({ ...object, zIndex: updates.get(object.id) ?? object.zIndex }))
    .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id))
    .map((object) => object.id);
}

describe("planSemanticZOrder", () => {
  it("visibly swaps duplicate-z layers and revision-fences both participants", () => {
    const objects = [shape("a", 4), shape("b", 4), shape("c", 5)];
    const plan = planSemanticZOrder({
      objects,
      selectedObjectIds: ["a"],
      direction: "forward",
    });
    expect(plan.orderedObjectIds).toEqual(["b", "a", "c"]);
    expect(plan.updates.map(({ object }) => object.id).sort()).toEqual(["a", "b"]);
    expect(projectedOrder(objects, plan)).toEqual(["b", "a", "c"]);
  });

  it("uses local room at both z-index bounds without overflowing", () => {
    const bottom = [shape("a", 0), shape("b", 0), shape("c", 1)];
    const backward = planSemanticZOrder({
      objects: bottom,
      selectedObjectIds: ["b"],
      direction: "backward",
    });
    expect(projectedOrder(bottom, backward)).toEqual(["b", "a", "c"]);
    expect(backward.updates.every(({ zIndex }) => zIndex >= 0)).toBe(true);

    const top = [shape("a", 999_999), shape("b", 1_000_000), shape("c", 1_000_000)];
    const forward = planSemanticZOrder({
      objects: top,
      selectedObjectIds: ["b"],
      direction: "forward",
    });
    expect(projectedOrder(top, forward)).toEqual(["a", "c", "b"]);
    expect(forward.updates.every(({ zIndex }) => zIndex <= 1_000_000)).toBe(true);
  });

  it("preserves selected cohort order while each member crosses one adjacent outsider", () => {
    const objects = [shape("a", 0), shape("b", 1), shape("c", 2), shape("d", 3)];
    const plan = planSemanticZOrder({
      objects,
      selectedObjectIds: ["a", "c"],
      direction: "forward",
    });
    expect(plan.orderedObjectIds).toEqual(["b", "a", "d", "c"]);
    expect(projectedOrder(objects, plan)).toEqual(["b", "a", "d", "c"]);
  });

  it("implements stable front/back partitions", () => {
    const objects = [shape("a", 0), shape("b", 1), shape("c", 2), shape("d", 3)];
    const front = planSemanticZOrder({
      objects,
      selectedObjectIds: ["a", "c"],
      direction: "front",
    });
    expect(projectedOrder(objects, front)).toEqual(["b", "d", "a", "c"]);
    const back = planSemanticZOrder({
      objects,
      selectedObjectIds: ["b", "d"],
      direction: "back",
    });
    expect(projectedOrder(objects, back)).toEqual(["b", "d", "a", "c"]);
  });

  it("returns boundary no-ops without fake updates", () => {
    const objects = [shape("a", 0), shape("b", 1), shape("c", 1_000_000)];
    expect(planSemanticZOrder({
      objects,
      selectedObjectIds: ["a"],
      direction: "backward",
    })).toMatchObject({ status: "noop", updates: [] });
    expect(planSemanticZOrder({
      objects,
      selectedObjectIds: ["c"],
      direction: "forward",
    })).toMatchObject({ status: "noop", updates: [] });
  });

  it("is independent of room insertion order and uses IDs to break duplicate ties", () => {
    const objects = [shape("c", 7), shape("a", 7), shape("b", 7)];
    const first = planSemanticZOrder({ objects, selectedObjectIds: ["a"], direction: "front" });
    const second = planSemanticZOrder({ objects: [...objects].reverse(), selectedObjectIds: ["a"], direction: "front" });
    expect(first.orderedObjectIds).toEqual(["b", "c", "a"]);
    expect(second).toEqual(first);
    expect(projectedOrder(objects, first)).toEqual(["b", "c", "a"]);
  });

  it("throws a typed error before a front operation can exceed 200 updates", () => {
    const objects = Array.from({ length: 201 }, (_, index) => shape(`object-${String(index).padStart(3, "0")}`, index));
    expect(() => planSemanticZOrder({
      objects,
      selectedObjectIds: [objects[0]!.id],
      direction: "front",
    })).toThrowError(expect.objectContaining<Partial<SemanticZOrderError>>({
      code: "OPERATION_LIMIT",
    }));
  });
});
