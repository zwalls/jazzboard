import { describe, expect, it, vi } from "vitest";

import type { SemanticScene } from "@/lib/canvas/semantic-scene";
import type { CanvasObject, RoomState, Viewport } from "@/lib/domain/types";

const png = vi.hoisted(() => ({
  render: vi.fn(async () => ({
    blob: new Blob(["png"], { type: "image/png" }),
    logicalWidth: 320,
    logicalHeight: 180,
    width: 640,
    height: 360,
    bounds: { x: 0, y: 0, width: 320, height: 180 },
    warnings: [{ code: "IMAGE_FETCH_FAILED", objectId: "node-a", message: "Image unavailable." }],
  })),
}));

vi.mock("./semantic-png-browser", () => ({ renderSemanticScenePng: png.render }));

import { createSemanticCanvasRuntime, type SemanticCanvasRuntimeHost } from "./semantic-runtime";

const object = {
  id: "node-a",
  kind: "shape",
  revision: 2,
  createdAt: 10,
} as CanvasObject;
const scene = {
  objects: [{ object, bounds: { x: 100, y: 200, width: 300, height: 120 } }],
  objectsById: {
    "node-a": { object, bounds: { x: 100, y: 200, width: 300, height: 120 } },
  },
} as unknown as SemanticScene;

function host() {
  let viewport: Viewport = { x: 0, y: 0, width: 800, height: 600, zoom: 1 };
  let selection: readonly string[] = [];
  const setViewport = vi.fn((next: Viewport) => { viewport = next; });
  const setSelection = vi.fn((next: readonly string[]) => { selection = next; });
  const source = {
    getRoom: () => ({ objects: { "node-a": object } }) as unknown as RoomState,
    getScene: () => scene,
    getViewport: () => viewport,
    setViewport,
    getSelection: () => selection,
    setSelection,
    onDocumentChange: vi.fn(() => vi.fn()),
  } satisfies SemanticCanvasRuntimeHost;
  return { source, setViewport, setSelection };
}

describe("semantic CanvasRuntime", () => {
  it("exposes exact semantic state and renderer capabilities", () => {
    const source = host();
    const runtime = createSemanticCanvasRuntime(source.source);

    expect(runtime.rendererId).toBe("jazzboard-semantic-v1");
    expect(runtime.capabilities.renderPng).toBe(true);
    expect(runtime.getDocumentObjectIds()).toEqual(["node-a"]);
    expect(runtime.getObjectBounds("node-a")).toEqual({ x: 100, y: 200, width: 300, height: 120 });
    expect(runtime.isObjectProjectionExact(object)).toBe(true);
  });

  it("does not describe optimistic pixels with an unchanged revision as authoritative", () => {
    const source = host();
    const optimistic = { ...object, x: 420 } as CanvasObject;
    const optimisticScene = {
      ...scene,
      objects: [{ object: optimistic, bounds: { x: 420, y: 200, width: 300, height: 120 } }],
      objectsById: {
        "node-a": {
          object: optimistic,
          bounds: { x: 420, y: 200, width: 300, height: 120 },
        },
      },
    } as unknown as SemanticScene;
    source.source.getScene = () => optimisticScene;
    const runtime = createSemanticCanvasRuntime(source.source);

    expect(optimistic.revision).toBe(object.revision);
    expect(runtime.isObjectProjectionExact(object)).toBe(false);
  });

  it("accepts an equivalent authoritative object from a separately decoded room envelope", () => {
    const source = host();
    const decoded = JSON.parse(JSON.stringify(object)) as CanvasObject;
    source.source.getRoom = () => ({ objects: { "node-a": decoded } }) as unknown as RoomState;
    const runtime = createSemanticCanvasRuntime(source.source);

    expect(decoded).not.toBe(object);
    expect(runtime.isObjectProjectionExact(decoded)).toBe(true);
  });

  it("rejects a separately allocated same-revision object with different semantic pixels", () => {
    const source = host();
    const changed = { ...object, x: 321 } as CanvasObject;
    source.source.getRoom = () => ({ objects: { "node-a": changed } }) as unknown as RoomState;
    const runtime = createSemanticCanvasRuntime(source.source);

    expect(runtime.isObjectProjectionExact(changed)).toBe(false);
  });

  it("rejects derived optimistic connector pixels even when the connector record is authoritative", () => {
    const source = host();
    const runtime = createSemanticCanvasRuntime({
      ...source.source,
      isProjectionAuthoritative: (objectId) => objectId !== "node-a",
    });

    expect(source.source.getScene().objectsById["node-a"].object).toBe(object);
    expect(source.source.getRoom().objects["node-a"]).toBe(object);
    expect(runtime.isObjectProjectionExact(object)).toBe(false);
  });

  it("renders through the bounded semantic PNG backend and preserves warnings", async () => {
    const source = host();
    const runtime = createSemanticCanvasRuntime(source.source);
    const signal = new AbortController().signal;

    await expect(runtime.renderPng(["node-a"], {
      background: true,
      darkMode: false,
      padding: 24,
      pixelRatio: 2,
      scale: 1,
      signal,
    })).resolves.toMatchObject({
      logicalWidth: 320,
      logicalHeight: 180,
      warnings: ["Image unavailable."],
    });
    expect(png.render).toHaveBeenCalledWith(scene, ["node-a"], {
      background: true,
      darkMode: false,
      padding: 24,
      pixelRatio: 2,
      scale: 1,
      signal,
    });
  });

  it("selects semantic IDs, converts coordinates, and focuses bounds", () => {
    const source = host();
    const runtime = createSemanticCanvasRuntime(source.source);

    runtime.selectObjects(["node-a", "missing", "node-a"]);
    expect(source.setSelection).toHaveBeenCalledWith(["node-a"]);
    expect(runtime.pageToViewport({ x: 20, y: 30 })).toEqual({ x: 20, y: 30 });
    expect(runtime.viewportToPage({ x: 40, y: 50 })).toEqual({ x: 40, y: 50 });

    runtime.zoomToBounds({ x: 100, y: 200, width: 300, height: 120 }, { inset: 100 });
    expect(source.setViewport).toHaveBeenCalledOnce();
    const focused = source.setViewport.mock.calls[0][0];
    expect(focused.x + focused.width / 2).toBeCloseTo(250);
    expect(focused.y + focused.height / 2).toBeCloseTo(260);
  });
});
