import type { CanvasBounds, CanvasObject, Point, Viewport } from "@/lib/domain/types";

/**
 * Renderer identity is diagnostic only. Product code must branch on explicit
 * capabilities or feature flags, never on this value.
 */
export type CanvasRendererId = "tldraw-v3" | "jazzboard-semantic-v1";

export type CanvasZoomOptions = {
  inset?: number;
  targetZoom?: number;
  durationMs?: number;
  force?: boolean;
};

export type CanvasPngRenderOptions = {
  background: boolean;
  darkMode: boolean;
  padding: number;
  pixelRatio: number;
  scale: number;
  signal?: AbortSignal;
};

export type CanvasPngRenderResult = {
  blob: Blob;
  /** Logical CSS-pixel dimensions before pixelRatio is applied. */
  logicalWidth: number;
  logicalHeight: number;
  /** Faithfulness degradations such as an unavailable authorized image. */
  warnings?: readonly string[];
};

/**
 * The renderer-neutral surface exposed to the rest of Jazzboard.
 *
 * Every object is addressed by its authoritative Jazzboard semantic ID. Raw
 * renderer records, bindings, groups, and editor handles deliberately stay
 * behind an adapter so another renderer can implement the same product
 * behavior without emulating tldraw internals.
 */
export interface CanvasRuntime {
  readonly rendererId: CanvasRendererId;
  readonly capabilities: {
    /** Whether this renderer can faithfully rasterize authorized live images. */
    renderPng: boolean;
  };

  getViewport(): Viewport;
  pageToViewport(point: Point): Point;
  viewportToPage(point: Point): Point;
  getDocumentObjectIds(): readonly string[];
  getSelectedObjectIds(): readonly string[];
  hasObject(objectId: string): boolean;
  getObjectBounds(objectId: string): CanvasBounds | null;
  getVisibleBounds(objectIds: readonly string[]): CanvasBounds | null;
  onDocumentChange(listener: () => void): () => void;

  selectObjects(objectIds: readonly string[]): void;
  zoomToBounds(bounds: CanvasBounds, options?: CanvasZoomOptions): void;

  isObjectProjectionExact(object: CanvasObject): boolean;
  renderPng(
    objectIds: readonly string[],
    options: CanvasPngRenderOptions,
  ): Promise<CanvasPngRenderResult>;
}
