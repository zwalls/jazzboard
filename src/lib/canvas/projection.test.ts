import {
  AssetRecordType,
  Editor,
  createTLStore,
  defaultAddFontsFromNode,
  defaultBindingUtils,
  defaultShapeTools,
  defaultShapeUtils,
  defaultTools,
  registerDefaultSideEffects,
  tipTapDefaultExtensions,
  toRichText,
  type TLArrowBinding,
  type TLArrowShape,
  type TLGeoShape,
  type TLMeasureTextOpts,
  type TLTextShape,
} from "tldraw";
import { afterEach, describe, expect, it } from "vitest";

import type { ActorRef, CanvasObject, RoomState } from "@/lib/domain/types";

import {
  isEquivalentTldrawProjection,
  projectRoomIntoTldraw,
  tldrawShapeId,
  tldrawShapeToSemantic,
} from "./projection";

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

const actor: ActorRef = {
  participantId: "participant-1",
  displayName: "Projector",
  color: "blue",
  kind: "agent",
};

function roomWith(...objects: CanvasObject[]): RoomState {
  return {
    id: "room-1",
    code: "1234",
    title: "Projection test",
    roomRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    participants: {},
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function common(id: string, zIndex: number) {
  return {
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
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

function node(id: string, x: number, zIndex: number): CanvasObject {
  return {
    ...common(id, zIndex),
    kind: "shape",
    x,
    shape: "rectangle",
    nodeType: null,
    label: id,
    fill: "yellow",
    stroke: "blue",
  };
}

function connector(id: string, startId: string, endId: string, zIndex: number): CanvasObject {
  return {
    ...common(id, zIndex),
    kind: "connector",
    x: 100,
    y: 50,
    width: 200,
    height: 1,
    start: { x: 100, y: 50, objectId: startId },
    end: { x: 300, y: 50, objectId: endId },
    direction: "end",
    label: id,
    color: "black",
  };
}

function projectedGroup(editor: Editor, groupId: string) {
  return editor
    .getCurrentPageShapes()
    .find(
      (shape) =>
        shape.type === "group" &&
        (shape.meta as { jazzboardGroupId?: string }).jazzboardGroupId === groupId,
    );
}

function projectedGroupMemberOrder(editor: Editor, groupId: string) {
  const group = projectedGroup(editor, groupId);
  if (!group) throw new Error(`Expected projected group ${groupId}.`);
  return editor
    .getSortedChildIdsForParent(group.id)
    .map((id) => (editor.getShape(id)?.meta as { jazzboardId?: string }).jazzboardId)
    .filter((id): id is string => typeof id === "string");
}

const editors: Editor[] = [];

function createEditor(): Editor {
  const shapeUtils = [...defaultShapeUtils];
  const bindingUtils = [...defaultBindingUtils];
  const container = document.createElement("div");
  container.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width: 1080,
    height: 720,
    bottom: 720,
    right: 1080,
    toJSON: () => ({}),
  });
  document.body.appendChild(container);

  const editor = new Editor({
    store: createTLStore({ shapeUtils, bindingUtils }),
    shapeUtils,
    bindingUtils,
    tools: [...defaultTools, ...defaultShapeTools],
    getContainer: () => container,
    initialState: "select",
    textOptions: {
      addFontsFromNode: defaultAddFontsFromNode,
      tipTapConfig: { extensions: tipTapDefaultExtensions },
    },
  });
  editor.textMeasure.measureText = (text: string, options: TLMeasureTextOpts) => {
    const lines = text.split("\n");
    const naturalWidth = Math.max(...lines.map((line) => line.length), 1) * options.fontSize * 0.5;
    const width = options.maxWidth === null ? naturalWidth : Math.max(naturalWidth, options.maxWidth);
    return {
      x: 0,
      y: 0,
      w: width,
      h: lines.length * options.fontSize,
      scrollWidth: width,
    };
  };
  editor.textMeasure.measureHtml = (html: string, options: TLMeasureTextOpts) =>
    editor.textMeasure.measureText(html.replace(/<[^>]+>/g, ""), options);
  registerDefaultSideEffects(editor);
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.getContainer().remove();
    editor.dispose();
  }
});

describe("bidirectional tldraw projection", () => {
  it("preserves local moves and text edits when only the room revision advances", () => {
    const editor = createEditor();
    const shape = node("shape", 0, 0);
    const text: CanvasObject = {
      ...common("text", 1),
      kind: "text",
      width: 240,
      height: 80,
      content: "Authoritative text",
      color: "black",
      size: "m",
      align: "start",
    };
    const room = roomWith(shape, text);
    projectRoomIntoTldraw(editor, room);

    const shapeId = tldrawShapeId(shape.id);
    const textId = tldrawShapeId(text.id);
    editor.updateShape<TLGeoShape>({
      id: shapeId,
      type: "geo",
      x: 125,
      props: { richText: toRichText("Locally edited shape") },
    });
    editor.updateShape<TLTextShape>({
      id: textId,
      type: "text",
      x: 275,
      props: { richText: toRichText("Locally edited text") },
    });
    const localShapeRecord = editor.getShape(shapeId);
    const localTextRecord = editor.getShape(textId);

    projectRoomIntoTldraw(editor, { ...room, roomRevision: 2, updatedAt: 2 });

    expect(editor.getShape(shapeId)).toBe(localShapeRecord);
    expect(editor.getShape(textId)).toBe(localTextRecord);
    expect(tldrawShapeToSemantic(editor, editor.getShape(shapeId)!)).toMatchObject({
      x: 125,
      label: "Locally edited shape",
    });
    expect(tldrawShapeToSemantic(editor, editor.getShape(textId)!)).toMatchObject({
      x: 275,
      content: "Locally edited text",
    });
    expect(editor.getShape(shapeId)?.meta).toMatchObject({ jazzboardRevision: 1 });
    expect(editor.getShape(textId)?.meta).toMatchObject({ jazzboardRevision: 1 });
  });

  it("applies a strictly higher authoritative object revision", () => {
    const editor = createEditor();
    const initial = node("shape", 0, 0);
    if (initial.kind !== "shape") throw new Error("Expected a semantic shape.");
    projectRoomIntoTldraw(editor, roomWith(initial));

    const id = tldrawShapeId(initial.id);
    editor.updateShape<TLGeoShape>({
      id,
      type: "geo",
      x: 80,
      props: { richText: toRichText("Local label") },
    });
    const updated: CanvasObject = {
      ...initial,
      revision: 2,
      x: 240,
      label: "Higher authoritative label",
    };

    projectRoomIntoTldraw(editor, { ...roomWith(updated), roomRevision: 2 });

    expect(tldrawShapeToSemantic(editor, editor.getShape(id)!)).toMatchObject({
      x: 240,
      label: "Higher authoritative label",
    });
    expect(editor.getShape(id)?.meta).toMatchObject({ jazzboardRevision: 2 });
  });

  it("requires forceObjectIds to apply an equal or lower revision rollback", () => {
    const editor = createEditor();
    const current = node("shape", 300, 0);
    if (current.kind !== "shape") throw new Error("Expected a semantic shape.");
    current.revision = 3;
    current.label = "Current state";
    projectRoomIntoTldraw(editor, roomWith(current));

    const rollback: CanvasObject = {
      ...current,
      revision: 2,
      x: 30,
      label: "Rolled back state",
    };
    const id = tldrawShapeId(current.id);
    projectRoomIntoTldraw(editor, { ...roomWith(rollback), roomRevision: 2 });
    expect(tldrawShapeToSemantic(editor, editor.getShape(id)!)).toMatchObject({
      x: 300,
      label: "Current state",
    });

    projectRoomIntoTldraw(editor, { ...roomWith(rollback), roomRevision: 3 }, {
      forceObjectIds: new Set([rollback.id]),
    });
    expect(tldrawShapeToSemantic(editor, editor.getShape(id)!)).toMatchObject({
      x: 30,
      label: "Rolled back state",
    });
    expect(editor.getShape(id)?.meta).toMatchObject({ jazzboardRevision: 2 });
  });

  it("projects a recreated object incarnation even when its revision restarts lower", () => {
    const editor = createEditor();
    const original = { ...node("reused-id", 20, 0), revision: 7, createdAt: 10 };
    projectRoomIntoTldraw(editor, roomWith(original));

    const recreated = {
      ...node("reused-id", 440, 0),
      revision: 1,
      createdAt: 200,
      updatedAt: 200,
    };
    projectRoomIntoTldraw(editor, { ...roomWith(recreated), roomRevision: 9 });

    const projected = editor.getShape<TLGeoShape>(tldrawShapeId(recreated.id));
    expect(projected?.x).toBe(440);
    expect(projected?.meta).toMatchObject({
      jazzboardRevision: 1,
      jazzboardCreatedAt: 200,
    });
  });

  it("never creates, updates, or deletes a protected object, even when forced", () => {
    const editor = createEditor();
    const object = node("protected", 0, 0);
    const id = tldrawShapeId(object.id);

    projectRoomIntoTldraw(editor, roomWith(object), {
      protectedObjectIds: new Set([object.id]),
    });
    expect(editor.getShape(id)).toBeUndefined();

    projectRoomIntoTldraw(editor, roomWith(object));
    editor.updateShape<TLGeoShape>({ id, type: "geo", x: 75 });
    const localRecord = editor.getShape(id);
    const updated = { ...object, revision: 2, x: 200 };
    projectRoomIntoTldraw(editor, { ...roomWith(updated), roomRevision: 2 }, {
      protectedObjectIds: new Set([object.id]),
      forceObjectIds: new Set([object.id]),
    });
    expect(editor.getShape(id)).toBe(localRecord);
    expect(editor.getShape(id)?.x).toBe(75);

    projectRoomIntoTldraw(editor, { ...roomWith(), roomRevision: 3 }, {
      protectedObjectIds: new Set([object.id]),
    });
    expect(editor.getShape(id)).toBe(localRecord);

    projectRoomIntoTldraw(editor, { ...roomWith(), roomRevision: 4 });
    expect(editor.getShape(id)).toBeUndefined();
  });

  it("force-deletes a rejected pending creation before it has Jazzboard metadata", () => {
    const editor = createEditor();
    const objectId = "pending-create";
    const id = tldrawShapeId(objectId);
    editor.createShape<TLGeoShape>({
      id,
      type: "geo",
      x: 90,
      y: 120,
      props: { w: 180, h: 100, geo: "rectangle" },
      meta: {},
    });

    expect((editor.getShape(id)?.meta as { jazzboardId?: string }).jazzboardId).toBeUndefined();

    projectRoomIntoTldraw(editor, roomWith());
    expect(editor.getShape(id)).toBeDefined();

    projectRoomIntoTldraw(editor, { ...roomWith(), roomRevision: 2 }, {
      protectedObjectIds: new Set([objectId]),
      forceObjectIds: new Set([objectId]),
    });
    expect(editor.getShape(id)).toBeDefined();

    projectRoomIntoTldraw(editor, { ...roomWith(), roomRevision: 3 }, {
      forceObjectIds: new Set([objectId]),
    });
    expect(editor.getShape(id)).toBeUndefined();
  });

  it("does not dissolve a group around a protected member while reconciling its sibling", () => {
    const editor = createEditor();
    const protectedMember = { ...node("protected-member", 0, 0), groupId: "cluster" };
    const sibling = { ...node("sibling", 150, 1), groupId: "cluster" };
    projectRoomIntoTldraw(editor, roomWith(protectedMember, sibling));

    const group = projectedGroup(editor, "cluster");
    if (!group) throw new Error("Expected a projected group.");
    const protectedId = tldrawShapeId(protectedMember.id);
    const protectedRecord = editor.getShape(protectedId);
    const updatedProtected = { ...protectedMember, revision: 2, groupId: null };
    const updatedSibling = { ...sibling, revision: 2, groupId: null, x: 500 };

    projectRoomIntoTldraw(
      editor,
      { ...roomWith(updatedProtected, updatedSibling), roomRevision: 2 },
      { protectedObjectIds: new Set([protectedMember.id]) },
    );

    expect(editor.getShape(protectedId)).toBe(protectedRecord);
    expect(editor.getShape(protectedId)?.parentId).toBe(group.id);
    expect(editor.getShape(tldrawShapeId(sibling.id))?.parentId).toBe(group.id);
    expect(editor.getShape(tldrawShapeId(sibling.id))?.x).not.toBe(500);

    projectRoomIntoTldraw(editor, {
      ...roomWith(updatedProtected, updatedSibling),
      roomRevision: 3,
    });
    expect(projectedGroup(editor, "cluster")).toBeUndefined();
    expect(editor.getShape(protectedId)?.parentId).toBe(editor.getCurrentPageId());
    expect(tldrawShapeToSemantic(editor, editor.getShape(tldrawShapeId(sibling.id))!)).toMatchObject({
      x: 500,
      groupId: null,
    });
  });

  it("preserves a singleton's authoritative semantic group after tldraw dissolves its container", () => {
    const editor = createEditor();
    const standalone = node("standalone", 300, 1);
    const survivor = { ...node("survivor", 0, 5), groupId: "cluster" };
    const removed = { ...node("removed", 150, 6), groupId: "cluster" };
    projectRoomIntoTldraw(editor, roomWith(standalone, survivor, removed));

    expect(projectedGroup(editor, "cluster")).toBeDefined();
    expect(editor.getShape(tldrawShapeId(survivor.id))?.meta).not.toMatchObject({
      jazzboardGroupId: "cluster",
    });

    projectRoomIntoTldraw(editor, {
      ...roomWith(standalone, survivor),
      roomRevision: 2,
      updatedAt: 2,
    });

    const survivorId = tldrawShapeId(survivor.id);
    expect(projectedGroup(editor, "cluster")).toBeUndefined();
    expect(editor.getShape(survivorId)?.parentId).toBe(editor.getCurrentPageId());
    expect(editor.getShape(survivorId)?.meta).toMatchObject({ jazzboardGroupId: "cluster" });
    expect(
      editor
        .getCurrentPageShapesSorted()
        .map((shape) => shape.id)
        .filter((id) => id === tldrawShapeId(standalone.id) || id === survivorId),
    ).toEqual([tldrawShapeId(standalone.id), survivorId]);

    editor.updateShape<TLGeoShape>({ id: survivorId, type: "geo", x: 225 });
    expect(tldrawShapeToSemantic(editor, editor.getShape(survivorId)!)).toMatchObject({
      id: survivor.id,
      x: 225,
      zIndex: 5,
      groupId: "cluster",
    });

    const authoritativelyUngrouped = {
      ...survivor,
      revision: 2,
      groupId: null,
      x: 225,
      updatedAt: 3,
    };
    projectRoomIntoTldraw(editor, {
      ...roomWith(standalone, authoritativelyUngrouped),
      roomRevision: 3,
      updatedAt: 3,
    });
    expect(editor.getShape(survivorId)?.meta).toMatchObject({ jazzboardGroupId: null });
    expect(tldrawShapeToSemantic(editor, editor.getShape(survivorId)!)).toMatchObject({
      groupId: null,
    });
  });

  it("continues to round-trip an explicit ungroup for a multi-member visual group", () => {
    const editor = createEditor();
    const first = { ...node("first", 0, 0), groupId: "cluster" };
    const second = { ...node("second", 150, 1), groupId: "cluster" };
    projectRoomIntoTldraw(editor, roomWith(first, second));

    const group = projectedGroup(editor, "cluster");
    if (!group) throw new Error("Expected a projected group.");
    expect(editor.getShape(tldrawShapeId(first.id))?.meta).not.toMatchObject({
      jazzboardGroupId: "cluster",
    });

    editor.ungroupShapes([group.id], { select: false });

    expect(tldrawShapeToSemantic(editor, editor.getShape(tldrawShapeId(first.id))!)).toMatchObject({
      groupId: null,
    });
    expect(tldrawShapeToSemantic(editor, editor.getShape(tldrawShapeId(second.id))!)).toMatchObject({
      groupId: null,
    });
  });

  it("reconciles authoritative child order when a higher-revision member stays in its group", () => {
    const editor = createEditor();
    const first = { ...node("first", 0, 0), groupId: "cluster" };
    const second = { ...node("second", 150, 1), groupId: "cluster" };
    const third = { ...node("third", 300, 2), groupId: "cluster" };
    projectRoomIntoTldraw(editor, roomWith(first, second, third));
    expect(projectedGroupMemberOrder(editor, "cluster")).toEqual(["first", "second", "third"]);

    const reorderedFirst = {
      ...first,
      revision: 2,
      zIndex: 3,
      label: "Higher authoritative revision",
    };
    projectRoomIntoTldraw(editor, {
      ...roomWith(reorderedFirst, second, third),
      roomRevision: 2,
    });

    expect(projectedGroupMemberOrder(editor, "cluster")).toEqual(["second", "third", "first"]);
    expect(tldrawShapeToSemantic(editor, editor.getShape(tldrawShapeId(first.id))!)).toMatchObject({
      label: "Higher authoritative revision",
      zIndex: 3,
    });
  });

  it("defers all protected-group ordering and applies it after protection clears", () => {
    const editor = createEditor();
    const protectedMember = { ...node("protected-member", 0, 0), groupId: "cluster" };
    const updatedMember = { ...node("updated-member", 150, 1), groupId: "cluster" };
    const unchangedMember = { ...node("unchanged-member", 300, 2), groupId: "cluster" };
    projectRoomIntoTldraw(editor, roomWith(protectedMember, updatedMember, unchangedMember));
    expect(projectedGroupMemberOrder(editor, "cluster")).toEqual([
      "protected-member",
      "updated-member",
      "unchanged-member",
    ]);

    const remotelyReordered = {
      ...updatedMember,
      revision: 2,
      zIndex: 4,
      label: "Updated while sibling protected",
    };
    const addedMember = { ...node("added-member", 450, -1), groupId: "cluster" };
    const updatedRoom = {
      ...roomWith(protectedMember, remotelyReordered, unchangedMember, addedMember),
      roomRevision: 2,
    };
    projectRoomIntoTldraw(editor, updatedRoom, {
      protectedObjectIds: new Set([protectedMember.id]),
    });

    const group = projectedGroup(editor, "cluster");
    if (!group) throw new Error("Expected a projected group.");
    expect(projectedGroupMemberOrder(editor, "cluster")).toEqual([
      "protected-member",
      "updated-member",
      "unchanged-member",
    ]);
    expect(editor.getShape(tldrawShapeId(addedMember.id))?.parentId).toBe(editor.getCurrentPageId());
    expect(editor.getShape(tldrawShapeId(updatedMember.id))?.meta).toMatchObject({
      jazzboardRevision: 2,
    });

    projectRoomIntoTldraw(editor, updatedRoom);

    expect(editor.getShape(tldrawShapeId(addedMember.id))?.parentId).toBe(group.id);
    expect(projectedGroupMemberOrder(editor, "cluster")).toEqual([
      "added-member",
      "protected-member",
      "unchanged-member",
      "updated-member",
    ]);
  });

  it("defers authoritative stack ordering until no top-level object is protected", () => {
    const editor = createEditor();
    const lower = node("lower", 0, 0);
    const protectedNode = node("protected", 180, 1);
    const initialRoom = roomWith(lower, protectedNode);
    projectRoomIntoTldraw(editor, initialRoom);
    const sortedIds = () =>
      editor
        .getCurrentPageShapesSorted()
        .map((shape) => shape.id)
        .filter((id) => id === tldrawShapeId(lower.id) || id === tldrawShapeId(protectedNode.id));
    expect(sortedIds()).toEqual([tldrawShapeId(lower.id), tldrawShapeId(protectedNode.id)]);

    const reorderedLower = { ...lower, revision: 2, zIndex: 3, label: "Remote update" };
    const updatedRoom = { ...roomWith(reorderedLower, protectedNode), roomRevision: 2 };
    projectRoomIntoTldraw(editor, updatedRoom, {
      protectedObjectIds: new Set([protectedNode.id]),
    });
    expect(sortedIds()).toEqual([tldrawShapeId(lower.id), tldrawShapeId(protectedNode.id)]);

    projectRoomIntoTldraw(editor, updatedRoom, {
      forceObjectIds: new Set([protectedNode.id]),
    });
    expect(sortedIds()).toEqual([tldrawShapeId(protectedNode.id), tldrawShapeId(lower.id)]);
  });

  it("retains authoritative z-index across tldraw normalization until a real reorder", () => {
    const editor = createEditor();
    const lower = node("lower-gap", 0, 10);
    const upper = node("upper-gap", 180, 30);
    projectRoomIntoTldraw(editor, roomWith(lower, upper));

    const lowerId = tldrawShapeId(lower.id);
    const upperId = tldrawShapeId(upper.id);
    expect(editor.getShape(lowerId)?.meta).toMatchObject({
      jazzboardZIndex: 10,
      jazzboardRenderedZIndex: 0,
    });
    expect(editor.getShape(upperId)?.meta).toMatchObject({
      jazzboardZIndex: 30,
      jazzboardRenderedZIndex: 1,
    });
    const projectedLower = tldrawShapeToSemantic(editor, editor.getShape(lowerId)!);
    expect(projectedLower).toMatchObject({ zIndex: 10 });
    expect(tldrawShapeToSemantic(editor, editor.getShape(upperId)!)).toMatchObject({ zIndex: 30 });
    expect(projectedLower && isEquivalentTldrawProjection(lower, projectedLower)).toBe(true);

    editor.updateShape<TLGeoShape>({ id: lowerId, type: "geo", x: 40 });
    const moved = tldrawShapeToSemantic(editor, editor.getShape(lowerId)!);
    expect(moved).toMatchObject({ x: 40, zIndex: 10 });

    editor.bringToFront([lowerId]);
    expect(tldrawShapeToSemantic(editor, editor.getShape(lowerId)!)).toMatchObject({ zIndex: 1 });
    expect(tldrawShapeToSemantic(editor, editor.getShape(upperId)!)).toMatchObject({ zIndex: 0 });
  });

  it("rebuilds an authoritative group from all members when one member is force-recovered", () => {
    const editor = createEditor();
    const groupedA = { ...node("grouped-a", 0, 0), groupId: "cluster" };
    const groupedB = { ...node("grouped-b", 150, 1), groupId: "cluster" };
    const room = roomWith(groupedA, groupedB);
    projectRoomIntoTldraw(editor, room);

    const originalGroup = projectedGroup(editor, "cluster");
    if (!originalGroup) throw new Error("Expected a projected group.");
    editor.ungroupShapes([originalGroup.id], { select: false });
    expect(projectedGroup(editor, "cluster")).toBeUndefined();

    projectRoomIntoTldraw(editor, room, {
      forceObjectIds: new Set([groupedA.id]),
    });

    const recoveredGroup = projectedGroup(editor, "cluster");
    expect(recoveredGroup).toBeDefined();
    expect(editor.getShape(tldrawShapeId(groupedA.id))?.parentId).toBe(recoveredGroup?.id);
    expect(editor.getShape(tldrawShapeId(groupedB.id))?.parentId).toBe(recoveredGroup?.id);
  });

  it("leaves locally changed connector bindings and groups alone on a room-only update", () => {
    const editor = createEditor();
    const groupedA = { ...node("grouped-a", 0, 0), groupId: "cluster" };
    const groupedB = { ...node("grouped-b", 150, 1), groupId: "cluster" };
    const left = node("left", 400, 2);
    const right = node("right", 700, 3);
    const arrow = connector("arrow", left.id, right.id, 4);
    const room = roomWith(groupedA, groupedB, left, right, arrow);
    projectRoomIntoTldraw(editor, room);

    const group = projectedGroup(editor, "cluster");
    if (!group) throw new Error("Expected a projected group.");
    editor.ungroupShapes([group.id], { select: false });

    const arrowId = tldrawShapeId(arrow.id);
    const startBinding = editor
      .getBindingsFromShape<TLArrowBinding>(arrowId, "arrow")
      .find((binding) => binding.props.terminal === "start");
    if (!startBinding) throw new Error("Expected a start binding.");
    editor.deleteBinding(startBinding.id);
    editor.updateShape<TLArrowShape>({
      id: arrowId,
      type: "arrow",
      props: { text: "Locally edited arrow" },
    });

    projectRoomIntoTldraw(editor, { ...room, roomRevision: 2, updatedAt: 2 });

    expect(projectedGroup(editor, "cluster")).toBeUndefined();
    expect(editor.getShape(tldrawShapeId(groupedA.id))?.parentId).toBe(editor.getCurrentPageId());
    expect(editor.getShape(tldrawShapeId(groupedB.id))?.parentId).toBe(editor.getCurrentPageId());
    expect(editor.getBindingsFromShape<TLArrowBinding>(arrowId, "arrow")).toHaveLength(1);
    expect(editor.getShape<TLArrowShape>(arrowId)?.props.text).toBe("Locally edited arrow");
  });

  it("reconciles connector bindings and grouping after higher object revisions", () => {
    const editor = createEditor();
    const groupedA = { ...node("grouped-a", 0, 0), groupId: "cluster" };
    const groupedB = { ...node("grouped-b", 150, 1), groupId: "cluster" };
    const left = node("left", 400, 2);
    const right = node("right", 700, 3);
    const arrow = connector("arrow", left.id, right.id, 4);
    projectRoomIntoTldraw(editor, roomWith(groupedA, groupedB, left, right, arrow));

    const initialGroup = projectedGroup(editor, "cluster");
    if (!initialGroup) throw new Error("Expected a projected group.");
    editor.ungroupShapes([initialGroup.id], { select: false });
    const arrowId = tldrawShapeId(arrow.id);
    editor.deleteBindings(editor.getBindingsFromShape<TLArrowBinding>(arrowId, "arrow"));

    const updatedA = { ...groupedA, revision: 2 };
    const updatedB = { ...groupedB, revision: 2 };
    const updatedArrow = { ...arrow, revision: 2 };
    projectRoomIntoTldraw(
      editor,
      { ...roomWith(updatedA, updatedB, left, right, updatedArrow), roomRevision: 2 },
    );

    const reconciledGroup = projectedGroup(editor, "cluster");
    expect(reconciledGroup).toBeDefined();
    expect(editor.getShape(tldrawShapeId(groupedA.id))?.parentId).toBe(reconciledGroup?.id);
    expect(editor.getShape(tldrawShapeId(groupedB.id))?.parentId).toBe(reconciledGroup?.id);
    expect(editor.getBindingsFromShape<TLArrowBinding>(arrowId, "arrow")).toHaveLength(2);
  });

  it("treats tldraw's interleaved bound-arrow stack indexes as derived", () => {
    const editor = createEditor();
    const nodes = [
      node("client", 0, 0),
      node("api", 300, 1),
      node("auth", 600, 2),
      node("redis", 900, 3),
    ];
    const connectors: CanvasObject[] = [
      {
        ...common("client-api", 4),
        kind: "connector",
        x: 100,
        y: 50,
        width: 200,
        height: 1,
        start: { x: 100, y: 50, objectId: "client" },
        end: { x: 300, y: 50, objectId: "api" },
        direction: "end",
        label: "request",
        color: "black",
      },
      {
        ...common("api-auth", 5),
        kind: "connector",
        x: 400,
        y: 50,
        width: 200,
        height: 1,
        start: { x: 400, y: 50, objectId: "api" },
        end: { x: 600, y: 50, objectId: "auth" },
        direction: "end",
        label: "authorize",
        color: "black",
      },
      {
        ...common("auth-redis", 6),
        kind: "connector",
        x: 700,
        y: 50,
        width: 200,
        height: 1,
        start: { x: 700, y: 50, objectId: "auth" },
        end: { x: 900, y: 50, objectId: "redis" },
        direction: "end",
        label: "session",
        color: "black",
      },
    ];
    const room = roomWith(...nodes, ...connectors);

    projectRoomIntoTldraw(editor, room);

    const drafts = connectors.map((connector) =>
      tldrawShapeToSemantic(editor, editor.getShape(tldrawShapeId(connector.id))!),
    );
    expect(drafts.map((draft) => draft?.zIndex)).toEqual([4, 5, 6]);
    expect(connectors.map((connector) => connector.zIndex)).toEqual([4, 5, 6]);
    expect(
      drafts.flatMap((draft, index) =>
        draft && !isEquivalentTldrawProjection(connectors[index], draft) ? [draft.id] : [],
      ),
    ).toEqual([]);
  });

  it("settles repeated bound-arrow projections without semantic writes or revisions", () => {
    const editor = createEditor();
    const left = node("left", 0, 0);
    const right = node("right", 300, 1);
    const connector: CanvasObject = {
      ...common("connector", 2),
      kind: "connector",
      x: 100,
      y: 50,
      width: 200,
      height: 1,
      start: { x: 100, y: 50, objectId: "left" },
      end: { x: 300, y: 50, objectId: "right" },
      direction: "end",
      label: "request",
      color: "black",
    };
    const room = roomWith(left, connector, right);
    projectRoomIntoTldraw(editor, room);
    const updatedRight: CanvasObject = { ...right, x: 400, revision: 2 };
    const updatedConnector: CanvasObject = {
      ...connector,
      width: 300,
      revision: 2,
      end: { x: 400, y: 50, objectId: "right" },
    };
    const updatedRoom = roomWith(left, updatedRight, updatedConnector);

    const arrowId = tldrawShapeId(connector.id);
    const writes: string[] = [];
    for (let projection = 0; projection < 10; projection += 1) {
      projectRoomIntoTldraw(editor, updatedRoom);
      const draft = tldrawShapeToSemantic(editor, editor.getShape(arrowId)!);
      if (draft && !isEquivalentTldrawProjection(updatedConnector, draft)) writes.push(draft.id);
    }
    const projected = tldrawShapeToSemantic(editor, editor.getShape(arrowId)!);
    expect(projected).toMatchObject({
      kind: "connector",
      start: { x: 50, y: 50, objectId: "left" },
      end: { x: 450, y: 50, objectId: "right" },
    });
    expect(projected).not.toMatchObject({ start: updatedConnector.start, end: updatedConnector.end });
    expect(projected && isEquivalentTldrawProjection(updatedConnector, projected)).toBe(true);

    expect(writes).toEqual([]);
    expect(updatedConnector.revision).toBe(2);

    if (!projected || projected.kind !== "connector") throw new Error("Expected a connector projection.");
    expect(isEquivalentTldrawProjection(updatedConnector, { ...projected, label: "edited" })).toBe(false);
    expect(
      isEquivalentTldrawProjection(updatedConnector, {
        ...projected,
        end: { ...projected.end, objectId: "left" },
      }),
    ).toBe(false);
    expect(isEquivalentTldrawProjection(updatedConnector, { ...projected, zIndex: 1 })).toBe(true);
    expect(isEquivalentTldrawProjection(updatedConnector, { ...projected, groupId: "group-1" })).toBe(false);

    const unbound: CanvasObject = {
      ...connector,
      id: "unbound",
      start: { x: 20, y: 30, objectId: null },
      end: { x: 220, y: 30, objectId: null },
    };
    expect(
      isEquivalentTldrawProjection(unbound, {
        ...unbound,
        start: { ...unbound.start, x: unbound.start.x + 1 },
      }),
    ).toBe(false);
    expect(isEquivalentTldrawProjection(unbound, { ...unbound, zIndex: unbound.zIndex + 1 })).toBe(false);
  });

  it("creates v3 arrow bindings after all targets exist and reconciles changed endpoints", () => {
    const editor = createEditor();
    const connector: CanvasObject = {
      ...common("connector", 0),
      kind: "connector",
      width: 300,
      height: 1,
      start: { x: 50, y: 50, objectId: "left" },
      end: { x: 350, y: 50, objectId: "right" },
      direction: "end",
      label: "request",
      color: "black",
    };
    const left = node("left", 0, 2);
    const right = node("right", 300, 1);

    projectRoomIntoTldraw(editor, roomWith(connector, right, left));

    const arrowId = tldrawShapeId("connector");
    const bindings = editor.getBindingsFromShape<TLArrowBinding>(arrowId, "arrow");
    expect(bindings).toHaveLength(2);
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromId: arrowId,
          toId: tldrawShapeId("left"),
          props: expect.objectContaining({ terminal: "start", snap: "none" }),
        }),
        expect.objectContaining({
          fromId: arrowId,
          toId: tldrawShapeId("right"),
          props: expect.objectContaining({ terminal: "end", snap: "none" }),
        }),
      ]),
    );
    editor.updateShape<TLArrowShape>({
      id: arrowId,
      type: "arrow",
      props: { text: "human-edited request" },
    });
    const semantic = tldrawShapeToSemantic(editor, editor.getShape(arrowId)!);
    expect(semantic).toMatchObject({
      kind: "connector",
      label: "human-edited request",
      start: { objectId: "left" },
      end: { objectId: "right" },
    });
    if (!semantic || semantic.kind !== "connector") throw new Error("Expected a semantic connector.");
    expect(semantic.start.x).toBeCloseTo(50);
    expect(semantic.start.y).toBeCloseTo(50);
    expect(semantic.end.x).toBeCloseTo(350);
    expect(semantic.end.y).toBeCloseTo(50);

    const changedConnector: CanvasObject = {
      ...connector,
      revision: 2,
      start: { x: 100, y: 50, objectId: null },
      end: { x: 350, y: 50, objectId: "left" },
    };
    projectRoomIntoTldraw(editor, roomWith(changedConnector, right, left));

    const reconciled = editor.getBindingsFromShape<TLArrowBinding>(arrowId, "arrow");
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({
      toId: tldrawShapeId("left"),
      props: { terminal: "end" },
    });
  });

  it("does not apply connector rotation to page-space endpoints twice", () => {
    const editor = createEditor();
    const connector: CanvasObject = {
      ...common("rotated", 0),
      kind: "connector",
      rotation: Math.PI / 2,
      width: 100,
      height: 1,
      start: { x: 10, y: 20, objectId: null },
      end: { x: 110, y: 20, objectId: null },
      direction: "none",
      label: "",
      color: "black",
    };

    projectRoomIntoTldraw(editor, roomWith(connector));

    const arrow = editor.getShape<TLArrowShape>(tldrawShapeId(connector.id))!;
    const semantic = tldrawShapeToSemantic(editor, arrow);
    expect(semantic).toMatchObject({
      kind: "connector",
      rotation: Math.PI / 2,
      start: { x: 10, y: 20, objectId: null },
      end: { x: 110, y: 20, objectId: null },
    });
  });

  it("upserts authoritative image asset metadata and dimensions", () => {
    const editor = createEditor();
    const image: CanvasObject = {
      ...common("image", 0),
      kind: "image",
      width: 320,
      height: 180,
      url: "https://example.com/first.png",
      assetId: "shared-image",
      alt: "First image",
      mimeType: "image/png",
      sourceUrl: null,
      locked: false,
    };
    projectRoomIntoTldraw(editor, roomWith(image));

    const updated: CanvasObject = {
      ...image,
      revision: 2,
      width: 640,
      height: 360,
      url: "https://example.com/authoritative.gif",
      alt: "Authoritative image",
      mimeType: "image/gif",
    };
    projectRoomIntoTldraw(editor, roomWith(updated));

    expect(editor.getAsset(AssetRecordType.createId("shared-image"))).toMatchObject({
      type: "image",
      props: {
        src: updated.url,
        w: 640,
        h: 360,
        mimeType: "image/gif",
        name: "Authoritative image",
        isAnimated: true,
      },
    });
  });

  it("preserves rich-text paragraph breaks and semantic-only style and height values", () => {
    const editor = createEditor();
    const text: CanvasObject = {
      ...common("text", 0),
      kind: "text",
      width: 240,
      height: 180,
      content: "First paragraph\n\nThird paragraph",
      color: "black",
      size: "m",
      align: "start",
    };
    const shape = node("styled-shape", 300, 1);
    if (shape.kind !== "shape") throw new Error("Expected a semantic shape.");
    shape.nodeType = "service";
    projectRoomIntoTldraw(editor, roomWith(text, shape));

    const textId = tldrawShapeId(text.id);
    editor.updateShape<TLTextShape>({
      id: textId,
      type: "text",
      x: 25,
      props: { richText: toRichText("First paragraph\n\nEdited third paragraph") },
    });
    const roundTrippedText = tldrawShapeToSemantic(editor, editor.getShape(textId)!);
    expect(roundTrippedText).toMatchObject({
      kind: "text",
      x: 25,
      height: 180,
      content: "First paragraph\n\nEdited third paragraph",
    });

    const shapeId = tldrawShapeId(shape.id);
    editor.updateShape<TLGeoShape>({
      id: shapeId,
      type: "geo",
      x: 325,
      props: { richText: toRichText("Edited label") },
    });
    const roundTrippedShape = tldrawShapeToSemantic(editor, editor.getShape(shapeId)!);
    expect(roundTrippedShape).toMatchObject({
      kind: "shape",
      x: 325,
      nodeType: "service",
      label: "Edited label",
      fill: "yellow",
      stroke: "blue",
    });
  });
});
