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
    expect(drafts.map((draft) => draft?.zIndex)).toEqual([2, 4, 6]);
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
