import { describe, expect, it } from "vitest";

import type { CanvasBounds, Viewport } from "@/lib/domain/types";

import {
  CANVAS_ZOOM_LIMITS,
  clampCanvasZoom,
  fitBoundsInViewport,
  pageToViewportPoint,
  viewportToPagePoint,
  zoomViewportAtPoint,
} from "./camera";

const viewport: Viewport = {
  x: 100,
  y: 50,
  width: 600,
  height: 400,
  zoom: 2,
};

describe("renderer-neutral canvas camera", () => {
  it("converts between page and viewport coordinates without losing precision", () => {
    const pagePoint = { x: 250.25, y: 130.5 };
    const viewportPoint = pageToViewportPoint(pagePoint, viewport);

    expect(viewportPoint).toEqual({ x: 300.5, y: 161 });
    expect(viewportToPagePoint(viewportPoint, viewport)).toEqual(pagePoint);
  });

  it("clamps zoom to deterministic defaults and caller-supplied limits", () => {
    expect(clampCanvasZoom(0)).toBe(CANVAS_ZOOM_LIMITS.min);
    expect(clampCanvasZoom(100)).toBe(CANVAS_ZOOM_LIMITS.max);
    expect(clampCanvasZoom(Number.NEGATIVE_INFINITY)).toBe(CANVAS_ZOOM_LIMITS.min);
    expect(clampCanvasZoom(Number.POSITIVE_INFINITY)).toBe(CANVAS_ZOOM_LIMITS.max);
    expect(clampCanvasZoom(Number.NaN)).toBe(1);
    expect(clampCanvasZoom(0.25, { minZoom: 0.5, maxZoom: 4 })).toBe(0.5);
    expect(clampCanvasZoom(5, { minZoom: 0.5, maxZoom: 4 })).toBe(4);
    expect(clampCanvasZoom(1, { minZoom: 3, maxZoom: 2 })).toBe(3);
  });

  it("keeps the page point beneath the pointer fixed while zooming", () => {
    const pointer = { x: 300, y: 200 };
    const pageAnchor = viewportToPagePoint(pointer, viewport);
    const zoomed = zoomViewportAtPoint(viewport, 4, pointer);

    expect(zoomed).toEqual({
      x: 175,
      y: 100,
      width: 300,
      height: 200,
      zoom: 4,
    });
    expect(viewportToPagePoint(pointer, zoomed)).toEqual(pageAnchor);
    expect(zoomed.width * zoomed.zoom).toBe(viewport.width * viewport.zoom);
    expect(zoomed.height * zoomed.zoom).toBe(viewport.height * viewport.zoom);
  });

  it("uses the viewport center when an invalid pointer coordinate is supplied", () => {
    const zoomed = zoomViewportAtPoint(viewport, 1, { x: Number.NaN, y: Number.NaN });

    expect(zoomed).toEqual({
      x: -200,
      y: -150,
      width: 1_200,
      height: 800,
      zoom: 1,
    });
  });

  it("fits bounds with CSS-pixel padding while preserving physical viewport size", () => {
    const bounds: CanvasBounds = { x: 300, y: 200, width: 800, height: 400 };
    const fitted = fitBoundsInViewport(bounds, viewport, { padding: 100 });

    expect(fitted.zoom).toBe(1.25);
    expect(fitted.width).toBe(960);
    expect(fitted.height).toBe(640);
    expect(fitted.x).toBe(220);
    expect(fitted.y).toBe(80);
    expect(fitted.width * fitted.zoom).toBe(viewport.width * viewport.zoom);
    expect(fitted.height * fitted.zoom).toBe(viewport.height * viewport.zoom);
  });

  it("centers point bounds at the maximum zoom and respects custom fit limits", () => {
    expect(
      fitBoundsInViewport(
        { x: 40, y: 80, width: 0, height: 0 },
        { x: 0, y: 0, width: 800, height: 600, zoom: 1 },
      ),
    ).toEqual({
      x: -10,
      y: 42.5,
      width: 100,
      height: 75,
      zoom: CANVAS_ZOOM_LIMITS.max,
    });

    expect(
      fitBoundsInViewport(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 0, y: 0, width: 1_000, height: 600, zoom: 1 },
        { maxZoom: 2 },
      ).zoom,
    ).toBe(2);
  });

  it("falls back to the minimum zoom when padding consumes the viewport", () => {
    expect(
      fitBoundsInViewport(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 0, y: 0, width: 100, height: 100, zoom: 1 },
        { padding: 100 },
      ).zoom,
    ).toBe(CANVAS_ZOOM_LIMITS.min);
  });
});
