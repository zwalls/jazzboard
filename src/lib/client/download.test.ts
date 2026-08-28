import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasRuntime } from "@/lib/canvas/runtime";
import { safeDownloadStem } from "@/lib/export-filename";

import {
  boundedRasterSize,
  downloadBlobFile,
  downloadCanvasPng,
  resolveCanvasPngObjectIds,
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

function pngRuntime(input: {
  bounds: Record<string, TestBounds | null>;
  result: { blob: Blob; width: number; height: number };
  warnings?: readonly string[];
}) {
  const hasObject = vi.fn((objectId: string) => Object.hasOwn(input.bounds, objectId));
  const getVisibleBounds = vi.fn((objectIds: readonly string[]) => {
    let result: TestBounds | null = null;
    for (const objectId of objectIds) {
      const next = input.bounds[objectId];
      if (!next) continue;
      if (!result) {
        result = { ...next };
        continue;
      }
      const maxX = Math.max(result.x + result.width, next.x + next.width);
      const maxY = Math.max(result.y + result.height, next.y + next.height);
      result.x = Math.min(result.x, next.x);
      result.y = Math.min(result.y, next.y);
      result.width = maxX - result.x;
      result.height = maxY - result.y;
    }
    return result;
  });
  const renderPng = vi.fn().mockResolvedValue({
    blob: input.result.blob,
    logicalWidth: input.result.width,
    logicalHeight: input.result.height,
    warnings: input.warnings,
  });
  return {
    runtime: {
      capabilities: { renderPng: true },
      hasObject,
      getVisibleBounds,
      renderPng,
    } as unknown as CanvasRuntime,
    hasObject,
    getVisibleBounds,
    renderPng,
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

  it("maps exact semantic IDs, deduplicates them, and renders through CanvasRuntime", async () => {
    const png = new Blob(["faithful image pixels"], { type: "image/png" });
    const runtime = pngRuntime({
      bounds: {
        "image-1": { x: 0, y: 0, width: 300, height: 200 },
        "node-1": { x: 400, y: 100, width: 100, height: 100 },
      },
      result: { blob: png, width: 564, height: 264 },
      warnings: ["One image used a placeholder."],
    });

    const result = await downloadCanvasPng({
      runtime: runtime.runtime,
      objectIds: ["image-1", "node-1", "image-1"],
      filename: "architecture",
    });

    expect(runtime.renderPng).toHaveBeenCalledWith(["image-1", "node-1"], {
      background: true,
      darkMode: false,
      padding: 32,
      pixelRatio: 2,
      scale: 1,
      signal: undefined,
    });
    expect(createObjectURL).toHaveBeenCalledWith(png);
    expect(result).toEqual({
      filename: "architecture.png",
      width: 1_128,
      height: 528,
      byteLength: png.size,
      warnings: ["One image used a placeholder."],
    });
  });

  it("downscales oversized boards before the canvas runtime rasterizes them", async () => {
    const runtime = pngRuntime({
      bounds: { "large-board": { x: 0, y: 0, width: 20_000, height: 10_000 } },
      result: {
        blob: new Blob(["bounded"], { type: "image/png" }),
        width: 1_024,
        height: 512,
      },
    });

    const result = await downloadCanvasPng({
      runtime: runtime.runtime,
      objectIds: ["large-board"],
      filename: "large-board.png",
      padding: 0,
      pixelRatio: 4,
    });

    expect(runtime.renderPng).toHaveBeenCalledWith(["large-board"], expect.objectContaining({
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
    const runtime = pngRuntime({
      bounds: {
        visible: { x: 0, y: 0, width: 100, height: 100 },
        masked: null,
      },
      result: { blob: new Blob(["unused"]), width: 100, height: 100 },
    });

    expect(() => resolveCanvasPngObjectIds(runtime.runtime, [])).toThrow("at least one");
    expect(() => resolveCanvasPngObjectIds(runtime.runtime, ["missing"])).toThrow("not available");
    await expect(downloadCanvasPng({
      runtime: runtime.runtime,
      objectIds: ["masked"],
      filename: "masked.png",
    })).rejects.toThrow("visible export bounds");
    expect(runtime.renderPng).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("discards an invalid renderer result instead of downloading it", async () => {
    const runtime = pngRuntime({
      bounds: { node: { x: 0, y: 0, width: 100, height: 100 } },
      result: { blob: new Blob([]), width: 100, height: 100 },
    });

    await expect(downloadCanvasPng({
      runtime: runtime.runtime,
      objectIds: ["node"],
      filename: "node.png",
    })).rejects.toThrow("empty PNG");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("does not download when the caller cancels a slow renderer", async () => {
    const runtime = pngRuntime({
      bounds: { "slow-image": { x: 0, y: 0, width: 100, height: 100 } },
      result: { blob: new Blob(["unused"]), width: 100, height: 100 },
    });
    let finishRender!: (value: { blob: Blob; logicalWidth: number; logicalHeight: number }) => void;
    runtime.renderPng.mockImplementationOnce(() => new Promise((resolve) => {
      finishRender = resolve;
    }));
    const controller = new AbortController();

    const download = downloadCanvasPng({
      runtime: runtime.runtime,
      objectIds: ["slow-image"],
      filename: "slow-image.png",
      signal: controller.signal,
    });
    controller.abort();
    finishRender({ blob: new Blob(["cancelled"]), logicalWidth: 100, logicalHeight: 100 });

    await expect(download).rejects.toMatchObject({ name: "AbortError" });
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
