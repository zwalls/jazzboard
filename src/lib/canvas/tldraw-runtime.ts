import type { Editor, TLShape, TLShapeId } from "tldraw";

import type {
  CanvasPngRenderOptions,
  CanvasRuntime,
  CanvasZoomOptions,
} from "@/lib/canvas/runtime";
import {
  isEquivalentTldrawProjection,
  jazzboardMeta,
  tldrawShapeId,
  tldrawShapeToSemantic,
} from "@/lib/canvas/projection";
import type { CanvasBounds, CanvasObject } from "@/lib/domain/types";

function abortError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new DOMException("The canvas render was cancelled.", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal.reason);
}

function semanticObjectId(shape: TLShape): string {
  const storedId = (shape.meta as { jazzboardId?: unknown }).jazzboardId;
  if (typeof storedId === "string" && shape.id === tldrawShapeId(storedId)) return storedId;
  return String(shape.id).slice("shape:".length);
}

function semanticLeafIds(editor: Editor, roots: readonly TLShape[]): string[] {
  const objectIds: string[] = [];
  const visited = new Set<TLShapeId>();
  const visit = (shape: TLShape) => {
    if (visited.has(shape.id)) return;
    visited.add(shape.id);
    if (shape.type === "group") {
      for (const childId of editor.getSortedChildIdsForParent(shape)) {
        const child = editor.getShape(childId);
        if (child) visit(child);
      }
      return;
    }
    objectIds.push(semanticObjectId(shape));
  };
  roots.forEach(visit);
  return objectIds;
}

function boundsOf(box: { x: number; y: number; w: number; h: number } | null | undefined): CanvasBounds | null {
  return box ? { x: box.x, y: box.y, width: box.w, height: box.h } : null;
}

function unionBounds(left: CanvasBounds | null, right: CanvasBounds): CanvasBounds {
  if (!left) return { ...right };
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return { x, y, width: maxX - x, height: maxY - y };
}

function isExactImageProjection(
  editor: Editor,
  shape: TLShape,
  object: Extract<CanvasObject, { kind: "image" }>,
): boolean {
  const draft = tldrawShapeToSemantic(editor, shape);
  if (!draft || draft.kind !== "image") return false;
  return isEquivalentTldrawProjection(
    {
      ...object,
      // tldraw stores its render asset identity and intentionally omits the
      // provenance-only source URL from the projected document.
      assetId: object.assetId ?? object.id,
      sourceUrl: null,
    },
    draft,
  );
}

/** Adapt a mounted tldraw editor to Jazzboard's semantic canvas contract. */
export function createTldrawCanvasRuntime(editor: Editor): CanvasRuntime {
  const resolveShapeIds = (objectIds: readonly string[]): TLShapeId[] => {
    const shapeIds: TLShapeId[] = [];
    const seen = new Set<TLShapeId>();
    for (const objectId of objectIds) {
      if (typeof objectId !== "string" || !objectId.trim()) {
        throw new Error("Canvas object IDs must be non-empty strings.");
      }
      const shapeId = tldrawShapeId(objectId);
      if (seen.has(shapeId)) continue;
      seen.add(shapeId);
      if (!editor.getShape(shapeId)) {
        throw new Error(`Canvas object ${objectId} is not available in the live canvas.`);
      }
      shapeIds.push(shapeId);
    }
    return shapeIds;
  };

  return {
    rendererId: "tldraw-v3",
    capabilities: { renderPng: true },

    getViewport() {
      const bounds = editor.getViewportPageBounds();
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        zoom: editor.getZoomLevel(),
      };
    },

    pageToViewport(point) {
      const result = editor.pageToViewport(point);
      return { x: result.x, y: result.y };
    },

    viewportToPage(point) {
      const bounds = editor.getViewportPageBounds();
      const zoom = editor.getZoomLevel();
      return { x: bounds.x + point.x / zoom, y: bounds.y + point.y / zoom };
    },

    getDocumentObjectIds() {
      return semanticLeafIds(editor, editor.getCurrentPageShapesSorted());
    },

    getSelectedObjectIds() {
      return semanticLeafIds(editor, editor.getSelectedShapes());
    },

    hasObject(objectId) {
      return Boolean(editor.getShape(tldrawShapeId(objectId)));
    },

    getObjectBounds(objectId) {
      return boundsOf(editor.getShapePageBounds(tldrawShapeId(objectId)));
    },

    getVisibleBounds(objectIds) {
      let bounds: CanvasBounds | null = null;
      for (const shapeId of resolveShapeIds(objectIds)) {
        const next = boundsOf(editor.getShapeMaskedPageBounds(shapeId));
        if (next) bounds = unionBounds(bounds, next);
      }
      return bounds;
    },

    onDocumentChange(listener) {
      return editor.store.listen(listener, { scope: "document" });
    },

    selectObjects(objectIds) {
      const shapeIds = objectIds
        .map(tldrawShapeId)
        .filter((shapeId) => Boolean(editor.getShape(shapeId)));
      if (shapeIds.length) editor.select(...shapeIds);
      else editor.selectNone();
    },

    zoomToBounds(bounds, options: CanvasZoomOptions = {}) {
      editor.zoomToBounds(
        { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height },
        {
          inset: options.inset,
          targetZoom: options.targetZoom,
          force: options.force,
          animation: options.durationMs === undefined ? undefined : { duration: options.durationMs },
        },
      );
    },

    isObjectProjectionExact(object) {
      const shape = editor.getShape(tldrawShapeId(object.id));
      if (!shape) return false;
      const metadata = jazzboardMeta(shape);
      if (
        metadata.objectId !== object.id ||
        metadata.revision !== object.revision ||
        metadata.createdAt !== object.createdAt
      ) return false;
      if (object.kind === "image") return isExactImageProjection(editor, shape, object);
      const draft = tldrawShapeToSemantic(editor, shape);
      return Boolean(draft && isEquivalentTldrawProjection(object, draft));
    },

    async renderPng(objectIds, options: CanvasPngRenderOptions) {
      throwIfAborted(options.signal);
      if (!objectIds.length) throw new Error("A canvas render must contain at least one object.");
      const result = await editor.toImage(resolveShapeIds(objectIds), {
        format: "png",
        background: options.background,
        darkMode: options.darkMode,
        padding: options.padding,
        pixelRatio: options.pixelRatio,
        scale: options.scale,
      });
      throwIfAborted(options.signal);
      return {
        blob: result.blob,
        logicalWidth: result.width,
        logicalHeight: result.height,
      };
    },
  };
}
