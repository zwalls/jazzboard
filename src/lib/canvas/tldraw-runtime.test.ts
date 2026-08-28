import { describe, expect, it, vi } from "vitest";
import type { Editor, TLShape, TLShapeId } from "tldraw";

import type { CanvasObject } from "@/lib/domain/types";

const projection = vi.hoisted(() => ({
  tldrawShapeId: vi.fn((objectId: string) => `shape:${objectId}`),
  jazzboardMeta: vi.fn((shape: { objectId?: string; revision?: number; createdAt?: number }) => ({
    objectId: shape.objectId ?? null,
    revision: shape.revision ?? null,
    createdAt: shape.createdAt ?? null,
  })),
  tldrawShapeToSemantic: vi.fn((_editor: Editor, shape: { draft?: CanvasObject }) => shape.draft ?? null),
  isEquivalentTldrawProjection: vi.fn((current: CanvasObject, draft: CanvasObject) => current === draft),
}));

vi.mock("@/lib/canvas/projection", () => projection);

import { createTldrawCanvasRuntime } from "./tldraw-runtime";

function shape(id: string, type = "geo", meta: Record<string, unknown> = {}) {
  return { id: `shape:${id}` as TLShapeId, type, meta } as unknown as TLShape;
}

function fakeEditor() {
  const first = shape("first", "geo", { jazzboardId: "first" });
  const local = shape("local", "text");
  const child = shape("child", "geo");
  const group = shape("visual-group", "group");
  const shapes = new Map([first, local, child, group].map((item) => [item.id, item]));
  const stopListening = vi.fn();
  const listen = vi.fn(() => stopListening);
  const select = vi.fn();
  const selectNone = vi.fn();
  const zoomToBounds = vi.fn();
  const toImage = vi.fn(async () => ({
    blob: new Blob(["png"], { type: "image/png" }),
    width: 240,
    height: 120,
  }));
  const editor = {
    getViewportPageBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }),
    getZoomLevel: () => 1.5,
    pageToViewport: ({ x, y }: { x: number; y: number }) => ({ x: (x - 10) * 1.5, y: (y - 20) * 1.5 }),
    getCurrentPageShapesSorted: () => [first, group, child, local],
    getSelectedShapes: () => [group, first],
    getSortedChildIdsForParent: () => [child.id],
    getShape: (id: TLShapeId) => shapes.get(id),
    getShapePageBounds: (id: TLShapeId) => id === first.id
      ? { x: 20, y: 30, w: 100, h: 50 }
      : undefined,
    getShapeMaskedPageBounds: (id: TLShapeId) => ({
      x: id === first.id ? 20 : 200,
      y: id === first.id ? 30 : 100,
      w: id === first.id ? 100 : 40,
      h: id === first.id ? 50 : 60,
    }),
    store: { listen },
    select,
    selectNone,
    zoomToBounds,
    toImage,
  } as unknown as Editor;
  return { editor, first, local, child, group, listen, stopListening, select, selectNone, zoomToBounds, toImage };
}

describe("tldraw CanvasRuntime adapter", () => {
  it("exposes semantic IDs, expands groups, and normalizes viewport and bounds", () => {
    const source = fakeEditor();
    const runtime = createTldrawCanvasRuntime(source.editor);

    expect(runtime.rendererId).toBe("tldraw-v3");
    expect(runtime.capabilities.renderPng).toBe(true);
    expect(runtime.getViewport()).toEqual({ x: 10, y: 20, width: 800, height: 600, zoom: 1.5 });
    expect(runtime.pageToViewport({ x: 18, y: 32 })).toEqual({ x: 12, y: 18 });
    expect(runtime.viewportToPage({ x: 12, y: 18 })).toEqual({ x: 18, y: 32 });
    expect(runtime.getDocumentObjectIds()).toEqual(["first", "child", "local"]);
    expect(runtime.getSelectedObjectIds()).toEqual(["child", "first"]);
    expect(runtime.getObjectBounds("first")).toEqual({ x: 20, y: 30, width: 100, height: 50 });
    expect(runtime.getVisibleBounds(["first", "child"])).toEqual({ x: 20, y: 30, width: 220, height: 130 });
  });

  it("keeps navigation and document subscriptions behind semantic methods", () => {
    const source = fakeEditor();
    const runtime = createTldrawCanvasRuntime(source.editor);
    const listener = vi.fn();

    const unsubscribe = runtime.onDocumentChange(listener);
    runtime.selectObjects(["first", "missing"]);
    runtime.zoomToBounds(
      { x: 1, y: 2, width: 300, height: 200 },
      { inset: 120, targetZoom: 1.25, durationMs: 180 },
    );

    expect(source.listen).toHaveBeenCalledWith(listener, { scope: "document" });
    expect(unsubscribe).toBe(source.stopListening);
    expect(source.select).toHaveBeenCalledWith("shape:first");
    expect(source.zoomToBounds).toHaveBeenCalledWith(
      { x: 1, y: 2, w: 300, h: 200 },
      { inset: 120, targetZoom: 1.25, force: undefined, animation: { duration: 180 } },
    );
  });

  it("renders exact semantic objects and fences cancellation", async () => {
    const source = fakeEditor();
    const runtime = createTldrawCanvasRuntime(source.editor);

    const result = await runtime.renderPng(["first", "child", "first"], {
      background: true,
      darkMode: false,
      padding: 16,
      pixelRatio: 2,
      scale: 0.5,
    });

    expect(source.toImage).toHaveBeenCalledWith(["shape:first", "shape:child"], {
      format: "png",
      background: true,
      darkMode: false,
      padding: 16,
      pixelRatio: 2,
      scale: 0.5,
    });
    expect(result.logicalWidth).toBe(240);
    expect(result.logicalHeight).toBe(120);

    const controller = new AbortController();
    controller.abort();
    await expect(runtime.renderPng(["first"], {
      background: true,
      darkMode: false,
      padding: 0,
      pixelRatio: 1,
      scale: 1,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("owns renderer-specific exact projection checks", () => {
    const source = fakeEditor();
    const runtime = createTldrawCanvasRuntime(source.editor);
    const object = {
      id: "first",
      kind: "shape",
      revision: 3,
      createdAt: 9,
    } as CanvasObject;
    Object.assign(source.first, { objectId: "first", revision: 3, createdAt: 9, draft: object });

    expect(runtime.isObjectProjectionExact(object)).toBe(true);
    expect(projection.tldrawShapeToSemantic).toHaveBeenCalledWith(source.editor, source.first);
  });
});
