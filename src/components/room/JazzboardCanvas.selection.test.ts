import type { Editor, TLShape, TLShapeId } from "tldraw";
import { describe, expect, it, vi } from "vitest";

import { editableShapesForTargets, flushCanvasSelectionToRoom } from "./JazzboardCanvas";

describe("editableShapesForTargets", () => {
  it("flattens nested selected groups into their semantic leaf shapes", () => {
    const leafA = { id: "shape:a", type: "geo" } as TLShape;
    const leafB = { id: "shape:b", type: "text" } as TLShape;
    const nestedGroup = { id: "shape:nested", type: "group" } as TLShape;
    const selectedGroup = { id: "shape:selected", type: "group" } as TLShape;
    const shapes = new Map<TLShapeId, TLShape>([
      [leafA.id, leafA],
      [leafB.id, leafB],
      [nestedGroup.id, nestedGroup],
      [selectedGroup.id, selectedGroup],
    ]);
    const editor = {
      getSortedChildIdsForParent: vi.fn((shape: TLShape) =>
        shape.id === selectedGroup.id ? [leafA.id, nestedGroup.id] : [leafB.id]),
      getShape: vi.fn((id: TLShapeId) => shapes.get(id)),
    } as unknown as Editor;

    expect(editableShapesForTargets(editor, [selectedGroup])).toEqual([leafA, leafB]);
  });
});

describe("flushCanvasSelectionToRoom", () => {
  it("flushes and awaits persistence before reading authoritative selection context", async () => {
    const order: string[] = [];
    const room = { objects: { selected: {} } } as unknown as Awaited<ReturnType<Parameters<typeof flushCanvasSelectionToRoom>[0]["refresh"]>>;

    const result = await flushCanvasSelectionToRoom({
      objectIds: ["selected"],
      flush: () => order.push("flush"),
      queueTails: () => [Promise.resolve().then(() => { order.push("settled"); })],
      isUnsettled: () => false,
      refresh: async () => {
        order.push("refresh");
        return room;
      },
      isAuthoritative: (nextRoom, objectId) => Boolean(nextRoom.objects[objectId]),
    });

    expect(result).toBe(room);
    expect(order).toEqual(["flush", "settled", "refresh"]);
  });

  it("fails instead of opening Ask with missing authoritative context", async () => {
    await expect(flushCanvasSelectionToRoom({
      objectIds: ["selected"],
      flush: vi.fn(),
      queueTails: () => [Promise.resolve()],
      isUnsettled: () => false,
      refresh: async () => ({ objects: {} }) as never,
      isAuthoritative: (room, objectId) => Boolean(room.objects[objectId]),
    })).rejects.toThrow("not yet authoritative");
  });
});
