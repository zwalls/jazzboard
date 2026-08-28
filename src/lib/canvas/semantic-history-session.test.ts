import { describe, expect, it } from "vitest";

import type {
  ActorRef,
  CanvasObject,
  ConnectorObject,
  Diagram,
  DrawObject,
  ImageObject,
  RoomState,
  ShapeObject,
} from "@/lib/domain/types";

import type {
  SemanticCanvasEditEvent,
  SemanticCanvasObjectsChangedEvent,
} from "./semantic-edit-events";
import {
  SemanticHistorySessionEngine,
} from "./semantic-history-session";

const AUTHOR: ActorRef = {
  participantId: "human-1",
  displayName: "Human",
  color: "violet",
  kind: "human",
};

function shape(id: string, overrides: Partial<ShapeObject> = {}): ShapeObject {
  return {
    id,
    kind: "shape",
    x: 10,
    y: 20,
    width: 160,
    height: 90,
    rotation: 0,
    zIndex: 3,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 100,
    updatedAt: 100,
    createdBy: AUTHOR,
    lastEditedBy: AUTHOR,
    shape: "rectangle",
    nodeType: "service",
    label: id,
    fill: "white",
    stroke: "blue",
    ...overrides,
  };
}

function connector(id: string, overrides: Partial<ConnectorObject> = {}): ConnectorObject {
  return {
    id,
    kind: "connector",
    x: 170,
    y: 65,
    width: 180,
    height: 1,
    rotation: 0,
    zIndex: 4,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 101,
    updatedAt: 101,
    createdBy: AUTHOR,
    lastEditedBy: AUTHOR,
    start: {
      x: 170,
      y: 65,
      objectId: "left",
      normalizedAnchor: { x: 1, y: 0.5 },
      isPrecise: true,
      isExact: false,
      snap: "edge",
    },
    end: {
      x: 350,
      y: 65,
      objectId: "right",
      normalizedAnchor: { x: 0, y: 0.5 },
      isPrecise: true,
      isExact: false,
      snap: "edge",
    },
    routing: {
      mode: "elbow",
      kind: "elbow",
      bend: 0,
      elbowMidPoint: 0.35,
      labelPosition: 0.65,
    },
    direction: "end",
    label: "calls",
    color: "black",
    ...overrides,
  };
}

function draw(id: string, overrides: Partial<DrawObject> = {}): DrawObject {
  return {
    id,
    kind: "draw",
    x: 50,
    y: 200,
    width: 40,
    height: 50,
    rotation: 0.2,
    zIndex: 8,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 102,
    updatedAt: 102,
    createdBy: AUTHOR,
    lastEditedBy: AUTHOR,
    points: [{ x: 0, y: 0 }, { x: 12, y: 17 }, { x: 40, y: 50 }],
    color: "red",
    size: "m",
    ...overrides,
  };
}

function image(id: string, locked = false, overrides: Partial<ImageObject> = {}): ImageObject {
  return {
    id,
    kind: "image",
    x: 400,
    y: 80,
    width: 240,
    height: 180,
    rotation: 0,
    zIndex: 9,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 103,
    updatedAt: 103,
    createdBy: AUTHOR,
    lastEditedBy: AUTHOR,
    url: "/api/rooms/room-history/assets?assetId=asset-1",
    assetId: "asset-1",
    alt: "Architecture",
    mimeType: "image/png",
    sourceUrl: "https://example.com/source.png",
    locked,
    ...overrides,
  };
}

function diagram(id: string, overrides: Partial<Diagram> = {}): Diagram {
  return {
    id,
    title: "Authentication flow",
    description: "Web client through Redis",
    diagramType: "architecture",
    category: "system",
    tags: ["auth", "redis"],
    memberObjectIds: ["left", "right"],
    connectorIds: ["edge"],
    bounds: { x: 0, y: 0, width: 500, height: 200 },
    revision: 1,
    createdAt: 90,
    updatedAt: 90,
    createdBy: AUTHOR,
    lastEditedBy: AUTHOR,
    ...overrides,
  };
}

function room(
  objects: readonly CanvasObject[],
  options: { id?: string; diagrams?: readonly Diagram[]; revision?: number } = {},
): RoomState {
  return {
    id: options.id ?? "room-history",
    code: "HIST",
    title: "History room",
    stateRevision: options.revision ?? 1,
    roomRevision: options.revision ?? 1,
    createdAt: 1,
    updatedAt: 2,
    participants: {},
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: Object.fromEntries((options.diagrams ?? []).map((value) => [value.id, value])),
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function changedEvent(replay: { events: readonly SemanticCanvasEditEvent[] }): SemanticCanvasObjectsChangedEvent {
  const event = replay.events.find(
    (candidate): candidate is SemanticCanvasObjectsChangedEvent => candidate.type === "objects.changed",
  );
  if (!event) throw new Error("Expected objects.changed history event.");
  return event;
}

function committed(object: CanvasObject, patch: Partial<CanvasObject>): CanvasObject {
  return {
    ...object,
    ...patch,
    revision: object.revision + 1,
    updatedAt: object.updatedAt + 100,
  } as CanvasObject;
}

function record(
  engine: SemanticHistorySessionEngine,
  transactionId: string,
  before: RoomState,
  after: RoomState,
  objectIds: readonly string[],
  diagramIds: readonly string[] = [],
) {
  const token = engine.stageHumanTransaction({ transactionId, room: before, objectIds, diagramIds });
  return engine.acknowledgeHumanTransaction({
    token,
    room: after,
    changedObjectIds: objectIds,
    changedDiagramIds: diagramIds,
  });
}

describe("SemanticHistorySessionEngine", () => {
  it("records only acknowledged human gesture transactions, never transient frames", () => {
    const beforeObject = shape("node");
    const before = room([beforeObject]);
    const engine = new SemanticHistorySessionEngine({ roomId: before.id });
    const token = engine.stageHumanTransaction({
      transactionId: "drag-1",
      room: before,
      objectIds: ["node"],
    });

    expect(engine.getState()).toMatchObject({ canUndo: false, pendingHumanTransactions: 1 });
    expect(() => engine.prepareUndo(before)).toThrowError(
      expect.objectContaining({ code: "PENDING_HUMAN_TRANSACTION" }),
    );

    const finalObject = committed(beforeObject, { x: 340, y: 180 });
    const entry = engine.acknowledgeHumanTransaction({ token, room: room([finalObject], { revision: 2 }) });
    expect(entry?.objectChanges[0]).toMatchObject({
      before: { x: 10, y: 20 },
      after: { x: 340, y: 180 },
    });
    expect(engine.getState()).toMatchObject({ canUndo: true, undoDepth: 1, pendingHumanTransactions: 0 });
  });

  it("emits complete lifecycle events using current authoritative revisions for update and group restoration", () => {
    const original = shape("node", { groupId: "old-group", zIndex: 2 });
    const edited = committed(original, { x: 500, groupId: "new-group", zIndex: 20 });
    const engine = new SemanticHistorySessionEngine({ roomId: "room-history" });
    record(engine, "group-and-move", room([original]), room([edited], { revision: 2 }), ["node"]);

    const current = { ...edited, revision: 11, updatedAt: 900 };
    const replay = engine.prepareUndo(room([current], { revision: 12 }))!;
    expect(replay.events.map((event) => event.type)).toEqual([
      "gesture.started",
      "objects.changed",
      "gesture.finish-requested",
    ]);
    const started = replay.events[0];
    if (started?.type !== "gesture.started") throw new Error("Expected gesture.started.");
    expect(started.objects[0]).toMatchObject({
      objectId: "node",
      baseRevision: 11,
      baseCreatedAt: 100,
      operation: "edit",
    });
    const change = changedEvent(replay).changes[0];
    expect(change).toMatchObject({
      kind: "update",
      baseRevision: 11,
      baseCreatedAt: 100,
      operation: "edit",
      draft: { id: "node", x: 10, groupId: "old-group", zIndex: 2 },
    });
  });

  it("undoes and redoes an acknowledged create without moving stacks before acknowledgement", () => {
    const created = shape("created", { revision: 1 });
    const before = room([]);
    const after = room([created], { revision: 2 });
    const engine = new SemanticHistorySessionEngine({ roomId: before.id });
    record(engine, "create", before, after, ["created"]);

    const undo = engine.prepareUndo(after)!;
    expect(changedEvent(undo).changes).toEqual([
      expect.objectContaining({ kind: "delete", objectId: "created", baseRevision: 1 }),
    ]);
    expect(engine.getState()).toMatchObject({ undoDepth: 1, redoDepth: 0, replayPending: true });
    engine.acknowledgeReplay(undo.token, room([], { revision: 3 }));
    expect(engine.getState()).toMatchObject({ undoDepth: 0, redoDepth: 1 });

    const redo = engine.prepareRedo(room([], { revision: 3 }))!;
    expect(changedEvent(redo).changes[0]).toMatchObject({
      kind: "create",
      baseRevision: null,
      draft: { id: "created", label: "created", zIndex: 3 },
    });
    const recreated = committed(created, { revision: 1, createdAt: 999 });
    engine.acknowledgeReplay(redo.token, room([recreated], { revision: 4 }));
    expect(engine.getState()).toMatchObject({ undoDepth: 1, redoDepth: 0 });
  });

  it("undoes a delete by recreating the exact semantic object and redoes against its new revision", () => {
    const deleted = shape("deleted", {
      rotation: 0.4,
      zIndex: 77,
      groupId: "cluster",
      fill: "yellow",
    });
    const engine = new SemanticHistorySessionEngine({ roomId: "room-history" });
    record(engine, "delete", room([deleted]), room([], { revision: 2 }), ["deleted"]);

    const undo = engine.prepareUndo(room([], { revision: 2 }))!;
    expect(changedEvent(undo).changes[0]).toMatchObject({
      kind: "create",
      draft: {
        id: "deleted",
        rotation: 0.4,
        zIndex: 77,
        groupId: "cluster",
        fill: "yellow",
      },
    });
    const recreated = { ...deleted, revision: 9, createdAt: 700, updatedAt: 700 };
    engine.acknowledgeReplay(undo.token, room([recreated], { revision: 3 }));

    const redo = engine.prepareRedo(room([recreated], { revision: 3 }))!;
    expect(changedEvent(redo).changes[0]).toMatchObject({
      kind: "delete",
      objectId: "deleted",
      baseRevision: 9,
      baseCreatedAt: 700,
    });
  });

  it("preserves connector bindings/routing, draw points, image metadata, grouping, and z-order exactly", () => {
    const originals = [
      connector("edge", { groupId: "diagram-group", zIndex: 5 }),
      draw("ink", { groupId: "diagram-group", zIndex: 6 }),
      image("photo", false, { groupId: "diagram-group", zIndex: 7 }),
    ];
    const edits: CanvasObject[] = [
      committed(originals[0]!, {
        end: { x: 800, y: 400, objectId: null },
        routing: { mode: "curved", kind: "curved", bend: 80, elbowMidPoint: 0.5, labelPosition: 0.2 },
      } as Partial<CanvasObject>),
      committed(originals[1]!, { points: [{ x: 9, y: 9 }, { x: 20, y: 30 }], zIndex: 100 } as Partial<CanvasObject>),
      committed(originals[2]!, { alt: "Edited", width: 800, groupId: null } as Partial<CanvasObject>),
    ];
    const engine = new SemanticHistorySessionEngine({ roomId: "room-history" });
    record(engine, "complex", room(originals), room(edits, { revision: 2 }), ["photo", "edge", "ink"]);

    const replay = engine.prepareUndo(room(edits, { revision: 2 }))!;
    const changes = changedEvent(replay).changes;
    const edge = changes.find((change) => change.kind !== "delete" && change.draft.id === "edge");
    const ink = changes.find((change) => change.kind !== "delete" && change.draft.id === "ink");
    const photo = changes.find((change) => change.kind !== "delete" && change.draft.id === "photo");
    expect(edge).toMatchObject({
      operation: "connect",
      draft: {
        groupId: "diagram-group",
        zIndex: 5,
        end: {
          objectId: "right",
          normalizedAnchor: { x: 0, y: 0.5 },
          isPrecise: true,
          isExact: false,
          snap: "edge",
        },
        routing: { mode: "elbow", kind: "elbow", bend: 0, elbowMidPoint: 0.35, labelPosition: 0.65 },
      },
    });
    expect(ink).toMatchObject({ draft: { points: [{ x: 0, y: 0 }, { x: 12, y: 17 }, { x: 40, y: 50 }], zIndex: 6 } });
    expect(photo).toMatchObject({
      draft: {
        url: "/api/rooms/room-history/assets?assetId=asset-1",
        assetId: "asset-1",
        alt: "Architecture",
        sourceUrl: "https://example.com/source.png",
        groupId: "diagram-group",
        zIndex: 7,
      },
    });
  });

  it("captures first-class diagram metadata and membership as explicit replay restorations", () => {
    const left = shape("left", { diagramIds: ["diagram-auth"] });
    const right = shape("right", { x: 300, diagramIds: ["diagram-auth"] });
    const beforeDiagram = diagram("diagram-auth");
    const afterDiagram = {
      ...beforeDiagram,
      title: "Authentication and authorization flow",
      description: "Updated purpose",
      tags: ["auth", "redis", "guest-session"],
      memberObjectIds: ["left"],
      revision: 2,
      updatedAt: 200,
    };
    const before = room([left, right], { diagrams: [beforeDiagram] });
    const afterRight = committed(right, { diagramIds: [] });
    const after = room([left, afterRight], { diagrams: [afterDiagram], revision: 2 });
    const engine = new SemanticHistorySessionEngine({ roomId: before.id });
    const entry = record(engine, "diagram-edit", before, after, ["right"], ["diagram-auth"]);

    expect(entry?.diagramChanges[0]).toMatchObject({
      diagramId: "diagram-auth",
      before: { title: "Authentication flow", memberObjectIds: ["left", "right"] },
      after: { title: "Authentication and authorization flow", memberObjectIds: ["left"] },
    });
    const replay = engine.prepareUndo(after)!;
    expect(replay.diagramRestorations[0]).toMatchObject({
      diagramId: "diagram-auth",
      current: { revision: 2, memberObjectIds: ["left"] },
      target: {
        title: "Authentication flow",
        description: "Web client through Redis",
        tags: ["auth", "redis"],
        memberObjectIds: ["left", "right"],
        connectorIds: ["edge"],
      },
    });
  });

  it("keeps stacks intact after rejected or stale replay so the host can roll back and retry", () => {
    const original = shape("node");
    const edited = committed(original, { x: 200 });
    const after = room([edited], { revision: 2 });
    const engine = new SemanticHistorySessionEngine({ roomId: after.id });
    record(engine, "move", room([original]), after, ["node"]);

    const first = engine.prepareUndo(after)!;
    expect(engine.rejectReplay(first.token)).toBe(true);
    expect(engine.getState()).toMatchObject({ undoDepth: 1, redoDepth: 0, replayPending: false });

    const second = engine.prepareUndo(after)!;
    expect(second.token.replayId).not.toBe(first.token.replayId);
    expect(engine.rejectReplay(first.token)).toBe(false);
    expect(() => engine.acknowledgeReplay(second.token, after)).toThrowError(
      expect.objectContaining({ code: "STALE_REPLAY" }),
    );
    expect(engine.getState()).toMatchObject({ undoDepth: 1, redoDepth: 0, replayPending: false });
    expect(engine.prepareUndo(after)).not.toBeNull();
  });

  it("clears redo only when a new human edit is acknowledged after undo", () => {
    const original = shape("node");
    const edited = committed(original, { x: 200 });
    const engine = new SemanticHistorySessionEngine({ roomId: "room-history" });
    record(engine, "move", room([original]), room([edited], { revision: 2 }), ["node"]);
    const undo = engine.prepareUndo(room([edited], { revision: 2 }))!;
    const restored = committed(edited, { x: original.x });
    const restoredRoom = room([restored], { revision: 3 });
    engine.acknowledgeReplay(undo.token, restoredRoom);
    expect(engine.getState().canRedo).toBe(true);

    const nextToken = engine.stageHumanTransaction({
      transactionId: "style",
      room: restoredRoom,
      objectIds: ["node"],
    });
    expect(engine.getState().canRedo).toBe(true);
    const styled = committed(restored, { fill: "pink" });
    engine.acknowledgeHumanTransaction({ token: nextToken, room: room([styled], { revision: 4 }) });
    expect(engine.getState()).toMatchObject({ canRedo: false, redoDepth: 0, undoDepth: 1 });
  });

  it("fences rooms and tokens so history can never replay across rooms", () => {
    const source = room([shape("node")]);
    const other = room([shape("node")], { id: "room-other" });
    const engine = new SemanticHistorySessionEngine({ roomId: source.id });
    expect(() => engine.stageHumanTransaction({ transactionId: "bad", room: other, objectIds: ["node"] }))
      .toThrowError(expect.objectContaining({ code: "ROOM_MISMATCH" }));

    const token = engine.stageHumanTransaction({ transactionId: "move", room: source, objectIds: ["node"] });
    expect(() => engine.acknowledgeHumanTransaction({ token, room: other }))
      .toThrowError(expect.objectContaining({ code: "ROOM_MISMATCH" }));
    expect(() => engine.prepareUndo(other)).toThrowError(expect.objectContaining({ code: "ROOM_MISMATCH" }));
  });

  it("keeps acknowledged gesture order under out-of-order acknowledgements and enforces capacity", () => {
    const base = shape("node");
    const engine = new SemanticHistorySessionEngine({ roomId: "room-history", capacity: 2 });
    const first = engine.stageHumanTransaction({ transactionId: "first", room: room([base]), objectIds: ["node"] });
    const secondBefore = committed(base, { x: 100 });
    const second = engine.stageHumanTransaction({ transactionId: "second", room: room([secondBefore]), objectIds: ["node"] });
    engine.acknowledgeHumanTransaction({ token: second, room: room([committed(secondBefore, { x: 200 })]) });
    engine.acknowledgeHumanTransaction({ token: first, room: room([secondBefore]) });
    expect(engine.entries().undo.map((entry) => entry.transactionId)).toEqual(["first", "second"]);

    const thirdBefore = committed(secondBefore, { x: 200 });
    record(engine, "third", room([thirdBefore]), room([committed(thirdBefore, { x: 300 })]), ["node"]);
    expect(engine.entries().undo.map((entry) => entry.transactionId)).toEqual(["second", "third"]);
  });

  it("rejects mutation or deletion of a locked image while leaving history retryable", () => {
    const unlocked = image("photo", false);
    const lockedEdited = committed(unlocked, { locked: true, alt: "Locked final" });
    const after = room([lockedEdited], { revision: 2 });
    const engine = new SemanticHistorySessionEngine({ roomId: after.id });
    record(engine, "image-edit", room([unlocked]), after, ["photo"]);

    expect(() => engine.prepareUndo(after)).toThrowError(
      expect.objectContaining({ code: "LOCKED_IMAGE" }),
    );
    expect(engine.getState()).toMatchObject({ undoDepth: 1, redoDepth: 0, replayPending: false });

    const createdEngine = new SemanticHistorySessionEngine({ roomId: after.id });
    record(createdEngine, "image-create", room([]), after, ["photo"]);
    expect(() => createdEngine.prepareUndo(after)).toThrowError(
      expect.objectContaining({ code: "LOCKED_IMAGE" }),
    );
  });

  it("drops failed/no-op human transactions and validates capacity", () => {
    const base = room([shape("node")]);
    const engine = new SemanticHistorySessionEngine({ roomId: base.id });
    const failed = engine.stageHumanTransaction({ transactionId: "failed", room: base, objectIds: ["node"] });
    expect(engine.rejectHumanTransaction(failed)).toBe(true);
    expect(engine.rejectHumanTransaction(failed)).toBe(false);

    const noop = engine.stageHumanTransaction({ transactionId: "noop", room: base, objectIds: ["node"] });
    expect(engine.acknowledgeHumanTransaction({ token: noop, room: base })).toBeNull();
    expect(engine.getState()).toMatchObject({ canUndo: false, undoDepth: 0 });
    expect(() => new SemanticHistorySessionEngine({ roomId: base.id, capacity: 0 }))
      .toThrowError(expect.objectContaining({ code: "INVALID_CAPACITY" }));
  });
});
