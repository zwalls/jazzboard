import type { CanvasBounds, Point, Viewport } from "@/lib/domain/types";

/** Matches Jazzboard's current practical canvas range while remaining renderer-neutral. */
export const CANVAS_ZOOM_LIMITS = Object.freeze({
  min: 0.05,
  max: 8,
});

export type CanvasZoomLimits = {
  minZoom?: number;
  maxZoom?: number;
};

export type FitCanvasBoundsOptions = CanvasZoomLimits & {
  /** Inset from every viewport edge, measured in viewport (CSS) pixels. */
  padding?: number;
};

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeOr(value: number, fallback = 0): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function resolvedZoomLimits(limits: CanvasZoomLimits = {}): { min: number; max: number } {
  const min = positiveOr(limits.minZoom ?? CANVAS_ZOOM_LIMITS.min, CANVAS_ZOOM_LIMITS.min);
  const requestedMax = positiveOr(
    limits.maxZoom ?? CANVAS_ZOOM_LIMITS.max,
    CANVAS_ZOOM_LIMITS.max,
  );
  return { min, max: Math.max(min, requestedMax) };
}

function usableZoom(zoom: number): number {
  return positiveOr(zoom, 1);
}

function viewportPixelDimensions(viewport: Viewport): { width: number; height: number } {
  const zoom = usableZoom(viewport.zoom);
  return {
    width: nonNegativeOr(viewport.width) * zoom,
    height: nonNegativeOr(viewport.height) * zoom,
  };
}

/**
 * Converts an authoritative page-space point to a point relative to the
 * viewport's top-left corner. Viewport coordinates are CSS pixels.
 */
export function pageToViewportPoint(point: Point, viewport: Viewport): Point {
  const zoom = usableZoom(viewport.zoom);
  return {
    x: (finiteOr(point.x, 0) - finiteOr(viewport.x, 0)) * zoom,
    y: (finiteOr(point.y, 0) - finiteOr(viewport.y, 0)) * zoom,
  };
}

/** Converts a viewport-relative CSS-pixel point to authoritative page space. */
export function viewportToPagePoint(point: Point, viewport: Viewport): Point {
  const zoom = usableZoom(viewport.zoom);
  return {
    x: finiteOr(viewport.x, 0) + finiteOr(point.x, 0) / zoom,
    y: finiteOr(viewport.y, 0) + finiteOr(point.y, 0) / zoom,
  };
}

/** Clamps a requested zoom and converts invalid input to a safe 1x fallback. */
export function clampCanvasZoom(zoom: number, limits: CanvasZoomLimits = {}): number {
  const { min, max } = resolvedZoomLimits(limits);
  const requested = Number.isNaN(zoom) ? 1 : zoom;
  return Math.min(max, Math.max(min, requested));
}

/**
 * Returns a camera whose zoom is centered on one viewport-relative pointer.
 * The page point beneath the pointer is invariant, and the physical viewport
 * dimensions remain invariant while its page-space width and height change.
 */
export function zoomViewportAtPoint(
  viewport: Viewport,
  requestedZoom: number,
  pointer: Point,
  limits: CanvasZoomLimits = {},
): Viewport {
  const oldZoom = usableZoom(viewport.zoom);
  const zoom = clampCanvasZoom(requestedZoom, limits);
  const pixels = viewportPixelDimensions(viewport);
  const pointerX = finiteOr(pointer.x, pixels.width / 2);
  const pointerY = finiteOr(pointer.y, pixels.height / 2);
  const anchorX = finiteOr(viewport.x, 0) + pointerX / oldZoom;
  const anchorY = finiteOr(viewport.y, 0) + pointerY / oldZoom;

  return {
    x: anchorX - pointerX / zoom,
    y: anchorY - pointerY / zoom,
    width: pixels.width / zoom,
    height: pixels.height / zoom,
    zoom,
  };
}

/**
 * Fits page-space bounds into the current physical viewport. The result is
 * centered, deterministically clamped, and expressed as a domain Viewport.
 */
export function fitBoundsInViewport(
  bounds: CanvasBounds,
  viewport: Viewport,
  options: FitCanvasBoundsOptions = {},
): Viewport {
  const pixels = viewportPixelDimensions(viewport);
  const padding = nonNegativeOr(options.padding ?? 0);
  const availableWidth = Math.max(0, pixels.width - padding * 2);
  const availableHeight = Math.max(0, pixels.height - padding * 2);
  const boundsWidth = nonNegativeOr(bounds.width);
  const boundsHeight = nonNegativeOr(bounds.height);

  const horizontalZoom = boundsWidth > 0
    ? availableWidth / boundsWidth
    : Number.POSITIVE_INFINITY;
  const verticalZoom = boundsHeight > 0
    ? availableHeight / boundsHeight
    : Number.POSITIVE_INFINITY;
  const requestedZoom = Math.min(horizontalZoom, verticalZoom);
  const zoom = clampCanvasZoom(
    Number.isFinite(requestedZoom) ? requestedZoom : CANVAS_ZOOM_LIMITS.max,
    options,
  );
  const width = pixels.width / zoom;
  const height = pixels.height / zoom;
  const centerX = finiteOr(bounds.x, 0) + boundsWidth / 2;
  const centerY = finiteOr(bounds.y, 0) + boundsHeight / 2;

  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    zoom,
  };
}
