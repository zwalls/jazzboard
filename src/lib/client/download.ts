import type { CanvasRuntime } from "@/lib/canvas/runtime";

export const PNG_RASTER_LIMITS = Object.freeze({
  defaultPadding: 32,
  defaultPixelRatio: 2,
  maxPadding: 256,
  maxPixelRatio: 4,
  maxSide: 4_096,
  maxPixels: 16_000_000,
});

export type CanvasPngDownloadResult = {
  filename: string;
  width: number;
  height: number;
  byteLength: number;
  warnings: string[];
};

export function downloadBlobFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadTextFile(input: {
  content: string;
  filename: string;
  mimeType: string;
}): void {
  downloadBlobFile(new Blob([input.content], { type: `${input.mimeType};charset=utf-8` }), input.filename);
}

export function boundedRasterSize(
  width: number,
  height: number,
  requestedScale = 2,
): { width: number; height: number; scale: number } {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("PNG dimensions must be finite positive numbers.");
  }
  if (!Number.isFinite(requestedScale) || requestedScale <= 0) {
    throw new Error("PNG scale must be a finite positive number.");
  }
  const scale = Math.min(Math.max(requestedScale, 1), PNG_RASTER_LIMITS.maxPixelRatio);
  const boundedScale = Math.min(
    scale,
    PNG_RASTER_LIMITS.maxSide / width,
    PNG_RASTER_LIMITS.maxSide / height,
    Math.sqrt(PNG_RASTER_LIMITS.maxPixels / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * boundedScale)),
    height: Math.max(1, Math.floor(height * boundedScale)),
    scale: boundedScale,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The PNG export was cancelled.", "AbortError");
}

/**
 * Resolve exact Jazzboard semantic object IDs against the mounted renderer.
 * Missing objects are rejected so an export can never silently omit part of
 * the requested board, Diagram, or selection.
 */
export function resolveCanvasPngObjectIds(runtime: CanvasRuntime, objectIds: readonly string[]): string[] {
  if (!objectIds.length) throw new Error("A PNG export must contain at least one canvas object.");

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const objectId of objectIds) {
    if (typeof objectId !== "string" || !objectId.trim()) {
      throw new Error("PNG object IDs must be non-empty strings.");
    }
    if (seen.has(objectId)) continue;
    seen.add(objectId);
    if (!runtime.hasObject(objectId)) {
      throw new Error(`Canvas object ${objectId} is not available in the live canvas.`);
    }
    resolved.push(objectId);
  }
  return resolved;
}

/**
 * Render and download a faithful local PNG from the mounted canvas runtime.
 *
 * This deliberately bypasses Jazzboard's privacy-redacted SVG interchange
 * format. The renderer resolves authorized live assets into the image, so the
 * downloaded PNG contains the same images the person can see. Nothing is
 * uploaded or persisted by this helper.
 */
export async function downloadCanvasPng(input: {
  runtime: CanvasRuntime;
  objectIds: readonly string[];
  filename: string;
  padding?: number;
  pixelRatio?: number;
  signal?: AbortSignal;
}): Promise<CanvasPngDownloadResult> {
  throwIfAborted(input.signal);
  if (!input.runtime.capabilities.renderPng) {
    throw new Error("This canvas renderer does not support faithful PNG export yet.");
  }
  const filename = input.filename.trim();
  if (!filename) throw new Error("A PNG export filename is required.");

  const requestedPadding = input.padding ?? PNG_RASTER_LIMITS.defaultPadding;
  if (!Number.isFinite(requestedPadding) || requestedPadding < 0) {
    throw new Error("PNG padding must be a finite non-negative number.");
  }
  const padding = Math.min(requestedPadding, PNG_RASTER_LIMITS.maxPadding);

  const requestedPixelRatio = input.pixelRatio ?? PNG_RASTER_LIMITS.defaultPixelRatio;
  if (!Number.isFinite(requestedPixelRatio) || requestedPixelRatio <= 0) {
    throw new Error("PNG pixel ratio must be a finite positive number.");
  }
  const pixelRatio = Math.min(
    Math.max(requestedPixelRatio, 1),
    PNG_RASTER_LIMITS.maxPixelRatio,
  );

  const objectIds = resolveCanvasPngObjectIds(input.runtime, input.objectIds);
  const bounds = input.runtime.getVisibleBounds(objectIds);
  if (!bounds) throw new Error("The requested canvas objects do not have visible export bounds.");

  const paddedWidth = bounds.width + padding * 2;
  const paddedHeight = bounds.height + padding * 2;
  const raster = boundedRasterSize(paddedWidth, paddedHeight, pixelRatio);
  // Keep the renderer's DPR truthful for image asset resolution while using
  // logical scale to enforce our combined side and pixel budgets.
  const scale = raster.scale / pixelRatio;
  const result = await input.runtime.renderPng(objectIds, {
    background: true,
    darkMode: false,
    padding,
    pixelRatio,
    scale,
    signal: input.signal,
  });
  throwIfAborted(input.signal);

  if (
    !Number.isFinite(result.logicalWidth) ||
    result.logicalWidth <= 0 ||
    !Number.isFinite(result.logicalHeight) ||
    result.logicalHeight <= 0
  ) {
    throw new Error("The live canvas returned invalid PNG dimensions.");
  }
  if (!result.blob.size) throw new Error("The live canvas returned an empty PNG.");

  const width = Math.max(1, Math.floor(result.logicalWidth * pixelRatio));
  const height = Math.max(1, Math.floor(result.logicalHeight * pixelRatio));
  if (
    width > PNG_RASTER_LIMITS.maxSide ||
    height > PNG_RASTER_LIMITS.maxSide ||
    width * height > PNG_RASTER_LIMITS.maxPixels
  ) {
    throw new Error("The rendered PNG exceeded Jazzboard's safe image dimensions.");
  }

  const downloadFilename = /\.png$/i.test(filename) ? filename : `${filename}.png`;
  throwIfAborted(input.signal);
  downloadBlobFile(result.blob, downloadFilename);

  const warnings: string[] = [...(result.warnings ?? [])];
  if (requestedPadding > padding) {
    warnings.push(`PNG padding was capped at ${PNG_RASTER_LIMITS.maxPadding} pixels.`);
  }
  if (requestedPixelRatio !== pixelRatio) {
    warnings.push(`PNG pixel ratio was bounded to ${pixelRatio}\u00d7.`);
  }
  if (scale < 1) {
    warnings.push("The PNG was downscaled to fit the 4096-pixel and 16-megapixel limits.");
  }

  return {
    filename: downloadFilename,
    width,
    height,
    byteLength: result.blob.size,
    warnings,
  };
}
