// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Diagram, RoomState, ShapeObject } from "@/lib/domain/types";
import { applyRoomPatch, isRoomPatch } from "@/lib/realtime/room-patch";
import { parseRealtimeServerMessage } from "@/lib/realtime/protocol";
import { buildRoomPatch, fingerprintRoomDocument } from "./room-patch";

function shape(id: string): ShapeObject {
  const actor = { participantId: "p_1", displayName: "Ada", color: "blue", kind: "human" as const };
  return { id, kind: "shape", x: 0, y: 0, width: 100, height: 100, rotation: 0,
    zIndex: 0, revision: 1, groupId: null, diagramIds: [], createdAt: 1, updatedAt: 1,
    createdBy: actor, lastEditedBy: actor, shape: "rectangle", nodeType: null,
    label: id, fill: "white", stroke: "black" };
}
function room(): RoomState {
  return { id: "room_1", code: "1234", title: "Patches", roomRevision: 1, stateRevision: 1,
    createdAt: 1, updatedAt: 1, participants: {}, objects: { a: shape("a"), b: shape("b"), c: shape("c") },
    diagrams: {}, leases: {}, spotlight: null, agentEditPolicy: "live", reviewProposals: [] };
}
function patch(before: RoomState, next: RoomState) {
  return buildRoomPatch(next, fingerprintRoomDocument(before), fingerprintRoomDocument(next), before.stateRevision!, before.roomRevision)!;
}

describe("revision-checked room patches", () => {
  it("matches the complete authoritative room through updates, deletion, recreation, and unversioned membership normalization", () => {
    const before = room();
    const next = structuredClone(before);
    next.stateRevision = 3; next.roomRevision = 2;
    next.objects.a = { ...next.objects.a, x: 30, revision: 2 };
    delete next.objects.b;
    // Normalization can change membership without incrementing object.revision.
    next.objects.c.diagramIds = ["diagram_1"];
    next.diagrams.diagram_1 = { id: "diagram_1", title: "Graph", description: "", diagramType: "custom", category: null,
      tags: [], memberObjectIds: ["c"], connectorIds: [], bounds: { x: 0, y: 0, width: 100, height: 100 },
      revision: 1, createdAt: 1, updatedAt: 1, createdBy: before.objects.a.createdBy, lastEditedBy: before.objects.a.lastEditedBy } satisfies Diagram;
    const first = patch(before, next);
    expect(isRoomPatch(first)).toBe(true);
    expect(parseRealtimeServerMessage({ type: "room.patch", cursor: "3-0", ...first })).not.toBeNull();
    expect(Object.keys(first.objects)).toEqual(["a", "c"]);
    expect(first.deletedObjectIds).toEqual(["b"]);
    expect(applyRoomPatch(before, first)).toEqual(next);
    const recreated = structuredClone(next);
    recreated.stateRevision = 4; recreated.roomRevision = 3;
    recreated.objects.b = { ...shape("b"), createdAt: 4 };
    delete recreated.diagrams.diagram_1;
    expect(applyRoomPatch(next, patch(next, recreated))).toEqual(recreated);
    expect(before.objects.b).toBeDefined();
  });

  it("shares unchanged objects and fingerprints while sending complete coordination metadata", () => {
    const before = room(); const next = structuredClone(before);
    next.stateRevision = 2; next.title = "New title";
    const fingerprints = fingerprintRoomDocument(before)!;
    expect(fingerprintRoomDocument(next, fingerprints)).toBe(fingerprints);
    const update = patch(before, next);
    expect(update.objects).toEqual({});
    const applied = applyRoomPatch(before, update)!;
    expect(applied).toEqual(next);
    expect(applied.objects.a).toBe(before.objects.a);
    expect(applyRoomPatch(applied, update)).toBe(applied);
  });

  it("rejects missing, cross-room, and partially advanced bases rather than applying incomplete documents", () => {
    const before = room(); const next = { ...before, stateRevision: 3, roomRevision: 2 };
    const update = patch(before, next);
    expect(applyRoomPatch(null, update)).toBeNull();
    expect(applyRoomPatch({ ...before, id: "room_other" }, update)).toBeNull();
    expect(applyRoomPatch({ ...before, stateRevision: 2 }, update)).toBeNull();
    expect(applyRoomPatch({ ...before, stateRevision: 3, roomRevision: 1 }, update)).toBeNull();
    const ahead = { ...next, stateRevision: 5, roomRevision: 4 };
    expect(applyRoomPatch(ahead, update)).toBe(ahead);
  });

  it("rejects malformed upserts, ambiguous deletions and backwards watermarks", () => {
    const before = room(); const update = patch(before, { ...before, stateRevision: 2 });
    for (const malformed of [
      { ...update, baseStateRevision: 3 },
      { ...update, room: { ...update.room, stateRevision: undefined } },
      { ...update, objects: { a: { ...shape("a"), id: "other" } } },
      { ...update, objects: { a: { ...shape("a"), revision: -1 } } },
      { ...update, deletedObjectIds: ["a", "a"] },
      { ...update, objects: { a: shape("a") }, deletedObjectIds: ["a"] },
    ]) expect(isRoomPatch(malformed)).toBe(false);
  });

  it("captures immutable before-images and bounds server cache allocation with snapshot fallback", () => {
    const before = room(); const captured = fingerprintRoomDocument(before)!;
    before.objects.a.x = 50; before.stateRevision = 2; before.roomRevision = 2;
    const update = buildRoomPatch(before, captured, fingerprintRoomDocument(before), 1, 1)!;
    expect(update.objects.a.x).toBe(50);
    const huge = room(); (huge.objects.a as ShapeObject).label = "x".repeat(1024 * 1024);
    expect(fingerprintRoomDocument(huge)).toBeNull();
    expect(buildRoomPatch(huge, captured, null, 1, 1)).toBeNull();
    const replaced = room(); replaced.objects = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`n${i}`, shape(`n${i}`)]));
    expect(buildRoomPatch(replaced, captured, fingerprintRoomDocument(replaced), 1, 1)).toBeNull();
  });
});
