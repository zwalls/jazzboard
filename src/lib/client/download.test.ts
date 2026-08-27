import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor, TLShape, TLShapeId } from "tldraw";

import { tldrawShapeId } from "@/lib/canvas/projection";
import { safeDownloadStem } from "@/lib/export-filename";

import {
  boundedRasterSize,
  downloadBlobFile,
  downloadCanvasPng,
  liveCanvasObjectIds,
  resolveCanvasPngShapeIds,
} from "./download";

describe("safeDownloadStem", () => {
  it("creates a stable, filesystem-safe export stem", () => {
    expect(safeDownloadStem("  Authentication Request Flow  ")).toBe("authentication-request-flow");
    expect(safeDownloadStem("Caf\u00e9 / API: v2")).toBe("cafe-api-v2");
  });

  it("uses a fallback and bounds long names", () => {
    expect(safeDownloadStem("***", "board")).toBe("board");
    expect(safeDownloadStem("A".repeat(200))).toHaveLength(80);
  });
});

describe("PNG raster bounds", () => {
  it("bounds large raster exports by side and total pixels", () => {
    const result = boundedRasterSize(20_000, 10_000, 4);
    expect(result.width).toBeLessThanOrEqual(4_096);
    expect(result.height).toBeLessThanOrEqual(4_096);
    expect(result.width * result.height).toBeLessThanOrEqual(16_000_000);
    expect(result.scale).toBeLessThan(1);
  });

  it("rejects invalid raster scales", () => {
    expect(() => boundedRasterSize(100, 100, Number.NaN)).toThrow("scale");
    expect(() => boundedRasterSize(100, 100, 0)).toThrow("scale");
  });
});

type TestBounds = { x: number; y: number; width: number; height: number };

function pngEditor(input: {
  bounds: Record<string, TestBounds | null>;
  result: { blob: Blob; width: number; height: number };
}) {
  const getShape = vi.fn((shapeId: TLShapeId) => (
    Object.hasOwn(input.bounds, shapeId) ? { id: shapeId, type: "geo" } : undefined
  ));
  const getShapeMaskedPageBounds = vi.fn((shapeId: TLShapeId) => input.bounds[shapeId] ?? null);
  const toImage = vi.fn().mockResolvedValue(input.result);
  return {
    editor: { getShape, getShapeMaskedPageBounds, toImage } as unknown as Editor,
    getShape,
    getShapeMaskedPageBounds,
    toImage,
  };
}

describe("faithful live-canvas PNG downloads", () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>();
  const revokeObjectURL = vi.fn<(url: string) => void>();
  let click: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    createObjectURL.mockReset();
    createObjectURL.mockReturnValue("blob:canvas-png");
    revokeObjectURL.mockReset();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it("downloads an arbitrary Blob and revokes its temporary URL", () => {
    const blob = new Blob(["png"], { type: "image/png" });

    downloadBlobFile(blob, "board.png");

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    vi.runOnlyPendingTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:canvas-png");
  });

  it("maps exact semantic IDs, deduplicates them, and renders through Editor.toImage", async () => {
    const imageId = tldrawShapeId("image-1");
    const nodeId = tldrawShapeId("node-1");
    const png = new Blob(["faithful image pixels"], { type: "image/png" });
    const runtime = pngEditor({
      bounds: {
        [imageId]: { x: 0, y: 0, width: 300, height: 200 },
        [nodeId]: { x: 400, y: 100, width: 100, height: 100 },
      },
      result: { blob: png, width: 564, height: 264 },
    });

    const result = await downloadCanvasPng({
      editor: runtime.editor,
      objectIds: ["image-1", "node-1", "image-1"],
      filename: "architecture",
    });

    expect(runtime.toImage).toHaveBeenCalledWith([imageId, nodeId], {
      format: "png",
      background: true,
      darkMode: false,
      padding: 32,
      pixelRatio: 2,
      scale: 1,
    });
    expect(createObjectURL).toHaveBeenCalledWith(png);
    expect(result).toEqual({
      filename: "architecture.png",
      width: 1_128,
      height: 528,
      byteLength: png.size,
      warnings: [],
    });
  });

  it("reads acknowledged, local-first, and grouped objects from the live document", () => {
    const acknowledged = {
      id: tldrawShapeId("acknowledged"),
      type: "text",
      meta: { jazzboardId: "acknowledged" },
    } as unknown as TLShape;
    const local = {
      id: "shape:local-first" as TLShapeId,
      type: "text",
      meta: {},
    } as unknown as TLShape;
    const child = {
      id: "shape:group-child" as TLShapeId,
      type: "geo",
      meta: {},
    } as unknown as TLShape;
    const group = {
      id: "shape:visual-group" as TLShapeId,
      type: "group",
      meta: {},
    } as unknown as TLShape;
    const editor = {
      getCurrentPageShapesSorted: () => [acknowledged, local, group, child],
      getSortedChildIdsForParent: () => [child.id],
      getShape: (shapeId: TLShapeId) => shapeId === child.id ? child : undefined,
    } as unknown as Editor;

    expect(liveCanvasObjectIds(editor)).toEqual([
      "acknowledged",
      "local-first",
      "group-child",
    ]);
  });

  it("downscales oversized boards before tldraw rasterizes them", async () => {
    const shapeId = tldrawShapeId("large-board");
    const runtime = pngEditor({
      bounds: { [shapeId]: { x: 0, y: 0, width: 20_000, height: 10_000 } },
      result: {
        blob: new Blob(["bounded"], { type: "image/png" }),
        width: 1_024,
        height: 512,
      },
    });

    const result = await downloadCanvasPng({
      editor: runtime.editor,
      objectIds: ["large-board"],
      filename: "large-board.png",
      padding: 0,
      pixelRatio: 4,
    });

    expect(runtime.toImage).toHaveBeenCalledWith([shapeId], expect.objectContaining({
      padding: 0,
      pixelRatio: 4,
      scale: 0.0512,
    }));
    expect(result.width).toBe(4_096);
    expect(result.height).toBe(2_048);
    expect(result.width * result.height).toBeLessThanOrEqual(16_000_000);
    expect(result.warnings).toEqual([
      "The PNG was downscaled to fit the 4096-pixel and 16-megapixel limits.",
    ]);
  });

  it("rejects empty, missing, and entirely masked scopes without downloading", async () => {
    const visibleId = tldrawShapeId("visible");
    const maskedId = tldrawShapeId("masked");
    const runtime = pngEditor({
      bounds: {
        [visibleId]: { x: 0, y: 0, width: 100, height: 100 },
        [maskedId]: null,
      },
      result: { blob: new Blob(["unused"]), width: 100, height: 100 },
    });

    expect(() => resolveCanvasPngShapeIds(runtime.editor, [])).toThrow("at least one");
    expect(() => resolveCanvasPngShapeIds(runtime.editor, ["missing"])).toThrow("not available");
    await expect(downloadCanvasPng({
      editor: runtime.editor,
      objectIds: ["masked"],
      filename: "masked.png",
    })).rejects.toThrow("visible export bounds");
    expect(runtime.toImage).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("discards an invalid tldraw render instead of downloading it", async () => {
    const shapeId = tldrawShapeId("node");
    const runtime = pngEditor({
      bounds: { [shapeId]: { x: 0, y: 0, width: 100, height: 100 } },
      result: { blob: new Blob([]), width: 100, height: 100 },
    });

    await expect(downloadCanvasPng({
      editor: runtime.editor,
      objectIds: ["node"],
      filename: "node.png",
    })).rejects.toThrow("empty PNG");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("does not download when the caller cancels a slow tldraw render", async () => {
    const shapeId = tldrawShapeId("slow-image");
    const runtime = pngEditor({
      bounds: { [shapeId]: { x: 0, y: 0, width: 100, height: 100 } },
      result: { blob: new Blob(["unused"]), width: 100, height: 100 },
    });
    let finishRender!: (value: { blob: Blob; width: number; height: number }) => void;
    runtime.toImage.mockImplementationOnce(() => new Promise((resolve) => {
      finishRender = resolve;
    }));
    const controller = new AbortController();

    const download = downloadCanvasPng({
      editor: runtime.editor,
      objectIds: ["slow-image"],
      filename: "slow-image.png",
      signal: controller.signal,
    });
    controller.abort();
    finishRender({ blob: new Blob(["cancelled"]), width: 100, height: 100 });

    await expect(download).rejects.toMatchObject({ name: "AbortError" });
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
