import { describe, expect, it } from "vitest";

import type {
  ActorRef,
  CanvasObject,
  ConnectorObject,
  RoomState,
  ShapeObject,
} from "@/lib/domain/types";

import {
  SEMANTIC_CANVAS_CLIPBOARD_FORMAT,
  SEMANTIC_KEYBOARD_LIMITS,
  SemanticKeyboardSessionEngine,
  decodeSemanticCanvasClipboard,
  encodeSemanticCanvasClipboard,
  isSemanticTextEntryTarget,
  normalizeSemanticCanvasShortcut,
  selectAllSemanticObjectIds,
  type SemanticCanvasClipboardPayload,
} from "./semantic-keyboard-session";

const AUTHOR: ActorRef = {
  participantId: "human-1",
  displayName: "Human",
  color: "violet",
  kind: "human",
};

function shape(
  id: string,
  overrides: Partial<ShapeObject> = {},
): ShapeObject {
  return {
    id,
    kind: "shape",
    x: 10,
    y: 20,
    width: 120,
    height: 80,
    rotation: 0,
    zIndex: 1,
    revision: 3,
    groupId: null,
    diagramIds: ["diagram-private"],
    createdAt: 100,
    updatedAt: 200,
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

function connector(
  id: string,
  startObjectId: string | null,
  endObjectId: string | null,
  overrides: Partial<ConnectorObject> = {},
): ConnectorObject {
  return {
    id,
    kind: "connector",
    x: 130,
    y: 50,
    width: 100,
    height: 1,
    rotation: 0,
    zIndex: 2,
    revision: 4,
    groupId: null,
    diagramIds: ["diagram-private"],
    createdAt: 101,
    updatedAt: 201,
    createdBy: AUTHOR,
    lastEditedBy: AUTHOR,
    start: {
      x: 130,
      y: 50,
      objectId: startObjectId,
      normalizedAnchor: { x: 1, y: 0.5 },
      isPrecise: true,
      isExact: false,
      snap: "edge",
    },
    end: {
      x: 230,
      y: 50,
      objectId: endObjectId,
      normalizedAnchor: { x: 0, y: 0.5 },
      isPrecise: true,
      isExact: false,
      snap: "edge",
    },
    routing: {
      mode: "elbow",
      kind: "elbow",
      bend: 0,
      elbowMidPoint: 0.4,
      labelPosition: 0.6,
    },
    direction: "both",
    label: "calls",
    color: "black",
    ...overrides,
  };
}

function image(id: string, locked = true): CanvasObject {
  return {
    id,
    kind: "image",
    x: 300,
    y: 80,
    width: 200,
    height: 160,
    rotation: 0.2,
    zIndex: 8,
    revision: 9,
    groupId: null,
    diagramIds: [],
    createdAt: 102,
    updatedAt: 202,
    createdBy: AUTHOR,
    lastEditedBy: AUTHOR,
    url: "/api/rooms/room-keyboard/assets?assetId=private-image",
    assetId: "private-image",
    alt: "Private architecture screenshot",
    mimeType: "image/png",
    sourceUrl: "https://example.com/source.png",
    locked,
  };
}

function room(objects: readonly CanvasObject[], id = "room-keyboard"): RoomState {
  return {
    id,
    code: "KEYS",
    title: "Keyboard room",
    stateRevision: 12,
    roomRevision: 10,
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

function eventTypes(events: readonly { type: string }[]): string[] {
  return events.map((event) => event.type);
}

function updateDrafts(result: { lifecycleEvents: readonly unknown[] }) {
  const changed = result.lifecycleEvents.find(
    (event) => (event as { type?: string }).type === "objects.changed",
  ) as { changes: Array<{ kind: string; draft?: CanvasObject }> } | undefined;
  return changed?.changes.map((change) => change.draft) ?? [];
}

describe("normalizeSemanticCanvasShortcut", () => {
  it("normalizes participant editing, clipboard, grouping, ordering, and navigation shortcuts", () => {
    const action = (key: string, rest: Record<string, unknown> = {}) =>
      normalizeSemanticCanvasShortcut({
        role: "participant",
        event: { key, ...rest },
      });

    expect(action("Delete")).toEqual({ type: "delete-selection" });
    expect(action("Backspace")).toEqual({ type: "delete-selection" });
    expect(action("a", { metaKey: true })).toEqual({ type: "select-all" });
    expect(action("a", { ctrlKey: true })).toEqual({ type: "select-all" });
    expect(action("z", { metaKey: true })).toEqual({ type: "undo" });
    expect(action("Z", { ctrlKey: true, shiftKey: true })).toEqual({ type: "redo" });
    expect(action("Escape")).toEqual({ type: "escape" });
    expect(action("F2")).toEqual({ type: "edit-text" });
    expect(action("Enter")).toEqual({ type: "edit-text" });
    expect(action("ArrowLeft")).toEqual({ type: "nudge", delta: { x: -1, y: 0 } });
    expect(action("ArrowDown", { shiftKey: true })).toEqual({ type: "nudge", delta: { x: 0, y: 10 } });
    expect(action("c", { metaKey: true })).toEqual({ type: "copy" });
    expect(action("x", { ctrlKey: true })).toEqual({ type: "cut" });
    expect(action("v", { metaKey: true })).toEqual({ type: "paste" });
    expect(action("d", { ctrlKey: true })).toEqual({ type: "duplicate" });
    expect(action("g", { metaKey: true })).toEqual({ type: "group" });
    expect(action("G", { metaKey: true, shiftKey: true })).toEqual({ type: "ungroup" });
    expect(action("]", { metaKey: true, code: "BracketRight" })).toEqual({ type: "order-forward" });
    expect(action("{", { ctrlKey: true, shiftKey: true, code: "BracketLeft" })).toEqual({ type: "order-backward" });
  });

  it("does not hijack spectators, text entry, composition, prevented events, or unrelated modifiers", () => {
    const input = { tagName: "INPUT" };
    const parent = { isContentEditable: true, parentElement: null };
    const child = { tagName: "SPAN", parentElement: parent };
    const aria = { getAttribute: (name: string) => name === "role" ? "textbox" : null };

    expect(isSemanticTextEntryTarget(input)).toBe(true);
    expect(isSemanticTextEntryTarget(child)).toBe(true);
    expect(isSemanticTextEntryTarget(aria)).toBe(true);
    expect(normalizeSemanticCanvasShortcut({ role: "participant", event: { key: "a", metaKey: true, target: input } })).toBeNull();
    expect(normalizeSemanticCanvasShortcut({ role: "participant", event: { key: "z", metaKey: true, target: input } })).toBeNull();
    expect(normalizeSemanticCanvasShortcut({ role: "participant", event: { key: "Delete", target: child } })).toBeNull();
    expect(normalizeSemanticCanvasShortcut({ role: "spectator", event: { key: "Delete" } })).toBeNull();
    expect(normalizeSemanticCanvasShortcut({ role: "spectator", event: { key: "z", metaKey: true } })).toBeNull();
    expect(normalizeSemanticCanvasShortcut({ role: "participant", event: { key: "ArrowUp", isComposing: true } })).toBeNull();
    expect(normalizeSemanticCanvasShortcut({ role: "participant", event: { key: "ArrowUp", defaultPrevented: true } })).toBeNull();
    expect(normalizeSemanticCanvasShortcut({ role: "participant", event: { key: "ArrowUp", altKey: true } })).toBeNull();
    expect(normalizeSemanticCanvasShortcut({ role: "participant", event: { key: "a", metaKey: true, shiftKey: true } })).toBeNull();
  });
});

describe("semantic clipboard", () => {
  it("captures complete groups deterministically while stripping authority and external connector bindings", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const decision = shape("decision", {
      zIndex: 4,
      groupId: "group-auth",
      nodeType: "decision",
      nodeMetadata: {
        kind: "decision",
        status: "accepted",
        owner: "Architecture",
        resolution: "Use guest sessions",
        resolvedAt: 999,
      },
    });
    const service = shape("service", { zIndex: 1, groupId: "group-auth" });
    const edge = connector("edge", "service", "external", { zIndex: 3, groupId: "group-auth" });
    const external = shape("external", { zIndex: 7 });
    const copied = engine.copy({
      room: room([decision, external, edge, service]),
      selection: { objectIds: ["decision"] },
    });

    expect(copied.status).toBe("copied");
    expect(copied.capturedObjectIds).toEqual(["service", "edge", "decision"]);
    expect(copied.selectionReport.resolvedGroupIds).toEqual(["group-auth"]);
    expect(copied.payload?.objects.map((entry) => entry.sourceObjectId)).toEqual([
      "service", "edge", "decision",
    ]);
    const drafts = copied.payload!.objects.map((entry) => entry.draft);
    expect(drafts[0]).not.toHaveProperty("revision");
    expect(drafts[0]).not.toHaveProperty("diagramIds");
    expect(drafts[0]).not.toHaveProperty("createdBy");
    expect(drafts[1]).toMatchObject({
      kind: "connector",
      start: { objectId: "service" },
      end: {
        objectId: null,
        normalizedAnchor: null,
        isPrecise: null,
        isExact: null,
        snap: null,
      },
      routing: { kind: "elbow", labelPosition: 0.6 },
    });
    expect(drafts[2]).toMatchObject({
      kind: "shape",
      nodeType: "decision",
      nodeMetadata: {
        kind: "decision",
        status: "accepted",
        owner: "Architecture",
        resolution: "Use guest sessions",
      },
    });
    expect((drafts[2] as Record<string, unknown>).nodeMetadata).not.toHaveProperty("resolvedAt");
  });

  it("round trips validated payloads and rejects malformed, cross-room, and dangling-binding data", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const copied = engine.copy({ room: room([shape("a")]), selection: { objectIds: ["a"] } });
    const serialized = encodeSemanticCanvasClipboard(copied.payload!);

    expect(decodeSemanticCanvasClipboard(serialized, "room-keyboard")).toEqual(copied.payload);
    expect(() => decodeSemanticCanvasClipboard(serialized, "room-other")).toThrowError(
      expect.objectContaining({ code: "CROSS_ROOM_CLIPBOARD" }),
    );
    expect(() => decodeSemanticCanvasClipboard("not-json", "room-keyboard")).toThrowError(
      expect.objectContaining({ code: "INVALID_CLIPBOARD" }),
    );

    const dangling = {
      ...copied.payload!,
      objects: [{
        sourceObjectId: "edge",
        draft: {
          ...connector("edge", "missing", null),
          revision: undefined,
          createdAt: undefined,
          updatedAt: undefined,
          createdBy: undefined,
          lastEditedBy: undefined,
          diagramIds: undefined,
        },
      }],
    };
    expect(() => encodeSemanticCanvasClipboard(dangling as unknown as SemanticCanvasClipboardPayload)).toThrowError(
      expect.objectContaining({ code: "INVALID_CLIPBOARD" }),
    );
  });

  it("keeps locked private images same-room and preserves their semantic fields", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const copied = engine.copy({ room: room([image("private")]), selection: { objectIds: ["private"] } });
    expect(copied.payload?.objects[0]?.draft).toMatchObject({
      kind: "image",
      locked: true,
      url: "/api/rooms/room-keyboard/assets?assetId=private-image",
      assetId: "private-image",
      alt: "Private architecture screenshot",
      mimeType: "image/png",
    });
    expect(() => engine.paste({
      room: room([], "room-other"),
      payload: copied.payload!,
      objectIdFactory: () => "new-private",
      groupIdFactory: () => "new-group",
    })).toThrowError(expect.objectContaining({ code: "CROSS_ROOM_CLIPBOARD" }));

    const forged = {
      ...copied.payload!,
      roomId: "room-other",
    };
    expect(() => encodeSemanticCanvasClipboard(forged)).toThrowError(
      expect.objectContaining({ code: "CROSS_ROOM_CLIPBOARD" }),
    );

    const absoluteForged = {
      ...copied.payload!,
      roomId: "room-other",
      objects: [{
        ...copied.payload!.objects[0]!,
        draft: {
          ...copied.payload!.objects[0]!.draft,
          url: "https://jazzboard.example/api/rooms/room-keyboard/assets?assetId=private-image",
        },
      }],
    };
    expect(() => encodeSemanticCanvasClipboard(absoluteForged as SemanticCanvasClipboardPayload)).toThrowError(
      expect.objectContaining({ code: "CROSS_ROOM_CLIPBOARD" }),
    );
  });

  it("atomically pastes remapped objects, groups, and internal bindings with deterministic offset and z-order", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const left = shape("left", { zIndex: 1, groupId: "pair" });
    const right = shape("right", { x: 260, zIndex: 5, groupId: "pair" });
    const edge = connector("edge", "left", "right", { zIndex: 3, groupId: "pair" });
    const copied = engine.copy({ room: room([right, edge, left]), selection: { groupIds: ["pair"], objectIds: [] } });
    const pasteRoom = room([shape("existing", { zIndex: 20 })]);
    const result = engine.paste({
      room: pasteRoom,
      payload: copied.payload!,
      objectIdFactory: (source) => `copy-${source}`,
      groupIdFactory: (source) => `copy-${source}`,
      offset: { x: 40, y: -10 },
    });

    expect(result.status).toBe("finished");
    expect(result.objectIdMap).toEqual({ left: "copy-left", edge: "copy-edge", right: "copy-right" });
    expect(result.groupIdMap).toEqual({ pair: "copy-pair" });
    expect(result.createdObjectIds).toEqual(["copy-left", "copy-edge", "copy-right"]);
    expect(result.drafts.map((draft) => draft.zIndex)).toEqual([21, 22, 23]);
    expect(result.drafts[0]).toMatchObject({ id: "copy-left", x: 50, y: 10, groupId: "copy-pair" });
    expect(result.drafts[1]).toMatchObject({
      id: "copy-edge",
      x: 170,
      y: 40,
      start: { x: 170, y: 40, objectId: "copy-left" },
      end: { x: 270, y: 40, objectId: "copy-right" },
      groupId: "copy-pair",
    });
    expect(eventTypes(result.lifecycleEvents)).toEqual([
      "gesture.started", "objects.changed", "gesture.finish-requested",
    ]);
    expect(result.lifecycleEvents[0]).toMatchObject({
      source: "keyboard",
      objects: [
        { objectId: "copy-left", baseRevision: null, operation: null },
        { objectId: "copy-edge", baseRevision: null, operation: null },
        { objectId: "copy-right", baseRevision: null, operation: null },
      ],
    });
    expect(result.lifecycleEvents[1]).toMatchObject({
      changes: [
        { kind: "create", draft: { id: "copy-left" } },
        { kind: "create", draft: { id: "copy-edge" } },
        { kind: "create", draft: { id: "copy-right" } },
      ],
    });
    expect(result.lifecycleEvents[2]).toMatchObject({ reason: "keyboard-idle" });
  });

  it("rejects factory conflicts and invalid IDs before producing lifecycle events", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const copied = engine.copy({ room: room([shape("a"), shape("b")]), selection: { objectIds: ["a", "b"] } });
    const target = room([shape("existing")]);

    expect(() => engine.paste({
      room: target,
      payload: copied.payload!,
      objectIdFactory: () => "existing",
      groupIdFactory: (id) => `g-${id}`,
    })).toThrowError(expect.objectContaining({ code: "ID_COLLISION" }));
    expect(() => engine.paste({
      room: target,
      payload: copied.payload!,
      objectIdFactory: () => "same-id",
      groupIdFactory: (id) => `g-${id}`,
    })).toThrowError(expect.objectContaining({ code: "ID_COLLISION" }));
    expect(() => engine.paste({
      room: target,
      payload: copied.payload!,
      objectIdFactory: () => "",
      groupIdFactory: (id) => `g-${id}`,
    })).toThrowError(expect.objectContaining({ code: "INVALID_FACTORY" }));
  });

  it("cuts and duplicates through one atomic keyboard lifecycle", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const source = room([shape("a", { groupId: "g" }), shape("b", { groupId: "g", zIndex: 2 })]);
    const cut = engine.cut({ room: source, selection: { objectIds: ["a"] } });
    expect(cut.status).toBe("finished");
    expect(cut.payload?.objects).toHaveLength(2);
    expect(eventTypes(cut.mutation.lifecycleEvents)).toEqual([
      "gesture.started", "objects.changed", "gesture.finish-requested",
    ]);
    expect(cut.mutation.lifecycleEvents[1]).toMatchObject({
      changes: [
        { kind: "delete", objectId: "a", baseRevision: 3 },
        { kind: "delete", objectId: "b", baseRevision: 3 },
      ],
    });

    const duplicate = engine.duplicate({
      room: source,
      selection: { objectIds: ["a"] },
      objectIdFactory: (id) => `dupe-${id}`,
      groupIdFactory: (id) => `dupe-${id}`,
    });
    expect(duplicate.createdObjectIds).toEqual(["dupe-a", "dupe-b"]);
    expect(duplicate.groupIdMap).toEqual({ g: "dupe-g" });
  });

  it("dissolves stale singleton groups when copying or duplicating while preserving real groups", () => {
    const engine = new SemanticKeyboardSessionEngine();
    // This is the authoritative shape left behind after its former peer was
    // deleted. The server-side groupId can still exist, but no relationship
    // remains for a clone to inherit.
    const survivorRoom = room([shape("survivor", { groupId: "dissolved" })]);
    const copied = engine.copy({
      room: survivorRoom,
      selection: { objectIds: ["survivor"] },
    });

    expect(copied.payload?.objects[0]?.draft.groupId).toBeNull();

    const duplicate = engine.duplicate({
      room: survivorRoom,
      selection: { objectIds: ["survivor"] },
      objectIdFactory: () => "clone",
      groupIdFactory: () => "must-not-be-called",
    });
    expect(duplicate.groupIdMap).toEqual({});
    expect(duplicate.drafts).toMatchObject([{ id: "clone", groupId: null }]);

    const realGroup = room([
      shape("left", { groupId: "pair" }),
      shape("right", { groupId: "pair", zIndex: 2 }),
    ]);
    const realCopy = engine.copy({
      room: realGroup,
      selection: { objectIds: ["left"] },
    });
    expect(realCopy.payload?.objects.map(({ draft }) => draft.groupId)).toEqual([
      "pair",
      "pair",
    ]);
  });

  it("normalizes a legacy clipboard payload that contains a singleton group", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const copied = engine.copy({
      room: room([shape("source")]),
      selection: { objectIds: ["source"] },
    });
    const legacyPayload = {
      ...copied.payload!,
      objects: copied.payload!.objects.map((entry) => ({
        ...entry,
        draft: { ...entry.draft, groupId: "legacy-singleton" },
      })),
    };
    const pasted = engine.paste({
      room: room([]),
      payload: legacyPayload,
      objectIdFactory: () => "pasted",
      groupIdFactory: () => "must-not-be-called",
    });

    expect(pasted.groupIdMap).toEqual({});
    expect(pasted.drafts).toMatchObject([{ id: "pasted", groupId: null }]);
  });
});

describe("semantic keyboard mutations", () => {
  it("nudges complete groups, permits grouped locked images, and protects connector dependencies before updates", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const left = shape("left", { groupId: "g" });
    const locked = image("locked", true) as Extract<CanvasObject, { kind: "image" }>;
    locked.groupId = "g";
    const external = shape("external", { x: 500 });
    const edge = connector("edge", "left", "external", { groupId: null });
    const state = room([left, locked, external, edge]);
    const result = engine.nudge({
      room: state,
      selection: { objectIds: ["left"] },
      delta: { x: 10, y: 0 },
    });

    expect(result.targetObjectIds).toEqual(["left", "locked"]);
    expect(result.selectionReport.lockedImageObjectIds).toEqual([]);
    expect(eventTypes(result.lifecycleEvents)).toEqual([
      "gesture.started",
      "gesture.dependencies-added",
      "objects.changed",
      "gesture.finish-requested",
    ]);
    expect(result.lifecycleEvents[1]).toMatchObject({
      objects: [{ objectId: "edge", operation: "connect" }],
    });
    expect(updateDrafts(result)).toMatchObject([
      { id: "left", x: 20, y: 20 },
      { id: "locked", x: 310, y: 80, locked: true },
    ]);
  });

  it("does not directly move locked images and moves only free or internally captured connector endpoints", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const lockedResult = engine.nudge({
      room: room([image("locked")]),
      selection: { objectIds: ["locked"] },
      delta: { x: 1, y: 0 },
    });
    expect(lockedResult.status).toBe("noop");
    expect(lockedResult.selectionReport.lockedImageObjectIds).toEqual(["locked"]);

    const left = shape("left");
    const right = shape("right", { x: 300 });
    const edge = connector("edge", "left", "right");
    const connectorResult = engine.nudge({
      room: room([left, right, edge]),
      selection: { objectIds: ["edge", "left"] },
      delta: { x: 1, y: 0 },
    });
    const edgeDraft = updateDrafts(connectorResult).find((draft) => draft?.id === "edge") as ConnectorObject;
    expect(edgeDraft.start).toMatchObject({ x: 131, objectId: "left" });
    expect(edgeDraft.end).toMatchObject({ x: 230, objectId: "right" });
    expect(edgeDraft.routing).toEqual(edge.routing);
    expect(connectorResult.lifecycleEvents[0]).toMatchObject({
      objects: [
        { objectId: "left", operation: "move" },
        { objectId: "edge", operation: "connect" },
      ],
    });
    expect(connectorResult.lifecycleEvents.find((event) => event.type === "objects.changed")).toMatchObject({
      changes: [
        { kind: "update", draft: { id: "left" }, operation: "move" },
        { kind: "update", draft: { id: "edge" }, operation: "connect" },
      ],
    });
  });

  it("keeps directly selected locked images out of cut and delete while allowing copy", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const state = room([image("locked")]);
    const copied = engine.copy({ room: state, selection: { objectIds: ["locked"] } });
    const cut = engine.cut({ room: state, selection: { objectIds: ["locked"] } });
    const deleted = engine.deleteSelection({ room: state, selection: { objectIds: ["locked"] } });

    expect(copied.status).toBe("copied");
    expect(copied.payload?.objects[0]?.draft).toMatchObject({ id: "locked", locked: true });
    expect(cut).toMatchObject({
      status: "noop",
      payload: null,
      mutation: {
        status: "noop",
        selectionReport: { lockedImageObjectIds: ["locked"] },
      },
    });
    expect(deleted).toMatchObject({
      status: "noop",
      selectionReport: { lockedImageObjectIds: ["locked"] },
      lifecycleEvents: [],
    });
  });

  it("rejects non-keyboard nudge deltas", () => {
    const engine = new SemanticKeyboardSessionEngine();
    expect(() => engine.nudge({ room: room([shape("a")]), selection: { objectIds: ["a"] }, delta: { x: 2, y: 0 } })).toThrowError(
      expect.objectContaining({ code: "INVALID_NUDGE" }),
    );
    expect(() => engine.nudge({ room: room([shape("a")]), selection: { objectIds: ["a"] }, delta: { x: 0, y: 0 } })).toThrowError(
      expect.objectContaining({ code: "INVALID_NUDGE" }),
    );
  });

  it("reports missing selections and orders select-all deterministically", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const state = room([shape("z", { zIndex: 9 }), shape("b", { zIndex: 1 }), shape("a", { zIndex: 1 })]);
    expect(selectAllSemanticObjectIds(state)).toEqual(["a", "b", "z"]);
    const result = engine.deleteSelection({
      room: state,
      selection: { objectIds: ["missing"], groupIds: ["missing-group"] },
    });
    expect(result.status).toBe("noop");
    expect(result.selectionReport).toMatchObject({
      missingObjectIds: ["missing"],
      missingGroupIds: ["missing-group"],
    });
  });

  it("groups, ungroups, and changes stacking order with revision-fenced keyboard updates", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const state = room([shape("a", { zIndex: 3 }), shape("b", { zIndex: 5 })]);
    const grouped = engine.group({
      room: state,
      selection: { objectIds: ["a", "b"] },
      groupIdFactory: () => "new-group",
    });
    expect(updateDrafts(grouped)).toMatchObject([
      { id: "a", groupId: "new-group" },
      { id: "b", groupId: "new-group" },
    ]);
    expect(eventTypes(grouped.lifecycleEvents)).toEqual([
      "gesture.started", "objects.changed", "gesture.finish-requested",
    ]);
    expect(grouped.lifecycleEvents[0]).toMatchObject({
      objects: [
        { objectId: "a", baseRevision: 3, operation: "edit" },
        { objectId: "b", baseRevision: 3, operation: "edit" },
      ],
    });

    const groupedRoom = room([
      shape("a", { groupId: "old", zIndex: 0 }),
      shape("outside", { zIndex: 500_000 }),
      shape("b", { groupId: "old", zIndex: 1_000_000 }),
    ]);
    const ungrouped = engine.ungroup({ room: groupedRoom, selection: { objectIds: ["a"] } });
    expect(updateDrafts(ungrouped)).toMatchObject([
      { id: "a", groupId: null }, { id: "b", groupId: null },
    ]);
    const backward = engine.order({ room: groupedRoom, selection: { objectIds: ["a"] }, direction: "backward" });
    expect(updateDrafts(backward)).toMatchObject([
      { id: "b", zIndex: 1_000_000 },
      { id: "outside", zIndex: 1_000_000 },
    ]);
    const forwardAtLimit = engine.order({ room: groupedRoom, selection: { objectIds: ["a"] }, direction: "forward" });
    expect(updateDrafts(forwardAtLimit)).toMatchObject([
      { id: "outside", zIndex: 500_000 },
      { id: "a", zIndex: 500_001 },
    ]);

    const lockedOrder = engine.order({
      room: room([shape("lower", { zIndex: 0 }), image("locked"), shape("upper", { zIndex: 9 })]),
      selection: { objectIds: ["locked"] },
      direction: "forward",
    });
    expect(lockedOrder).toMatchObject({
      status: "noop",
      lifecycleEvents: [],
      selectionReport: { lockedImageObjectIds: ["locked"] },
    });
  });

  it("caps every group-expanded operation at 200 objects", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const objects = Array.from({ length: SEMANTIC_KEYBOARD_LIMITS.maxOperations + 1 }, (_, index) =>
      shape(`shape-${index}`, { groupId: "large-group", zIndex: index }),
    );
    expect(() => engine.copy({
      room: room(objects),
      selection: { objectIds: ["shape-0"] },
    })).toThrowError(expect.objectContaining({ code: "OPERATION_LIMIT" }));
  });

  it("rejects group ID conflicts instead of silently joining an existing group", () => {
    const engine = new SemanticKeyboardSessionEngine();
    const state = room([
      shape("existing", { groupId: "taken" }),
      shape("a"),
      shape("b", { zIndex: 2 }),
    ]);
    expect(() => engine.group({
      room: state,
      selection: { objectIds: ["a", "b"] },
      groupIdFactory: () => "taken",
    })).toThrowError(expect.objectContaining({ code: "ID_COLLISION" }));
  });
});

describe("clipboard payload contract", () => {
  it("uses a stable explicit format identifier", () => {
    expect(SEMANTIC_CANVAS_CLIPBOARD_FORMAT).toBe("application/x-jazzboard-semantic-canvas+json");
  });

  it("rejects more than 200 clipboard operations during decode", () => {
    const objects = Array.from({ length: 201 }, (_, index) => ({
      sourceObjectId: `shape-${index}`,
      draft: {
        id: `shape-${index}`,
        kind: "shape" as const,
        x: index,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        zIndex: index,
        groupId: null,
        shape: "rectangle" as const,
        nodeType: null,
        label: "",
        fill: "white",
        stroke: "black",
      },
    }));
    expect(() => decodeSemanticCanvasClipboard(JSON.stringify({
      format: SEMANTIC_CANVAS_CLIPBOARD_FORMAT,
      version: 1,
      roomId: "room-keyboard",
      objects,
    }), "room-keyboard")).toThrowError(expect.objectContaining({ code: "INVALID_CLIPBOARD" }));
  });
});
