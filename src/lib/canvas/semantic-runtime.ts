import {
  clampCanvasZoom,
  fitBoundsInViewport,
  pageToViewportPoint,
  viewportToPagePoint,
} from "@/lib/canvas/camera";
import type { CanvasRuntime, CanvasZoomOptions } from "@/lib/canvas/runtime";
import { renderSemanticScenePng } from "@/lib/canvas/semantic-png-browser";
import type { SemanticScene } from "@/lib/canvas/semantic-scene";
import type { CanvasBounds, CanvasObject, RoomState, Viewport } from "@/lib/domain/types";

export type SemanticCanvasRuntimeHost = {
  getRoom(): RoomState;
  getScene(): SemanticScene;
  getViewport(): Viewport;
  setViewport(
    viewport: Viewport,
    options: Pick<CanvasZoomOptions, "durationMs" | "force" | "publishPresence">,
  ): void;
  getSelection(): readonly string[];
  setSelection(objectIds: readonly string[]): void;
  onDocumentChange(listener: () => void): () => void;
  /**
   * Additional renderer-owned exactness fence for pixels derived from local
   * state without replacing the semantic object record (notably connector
   * routes recomputed around an optimistic node move).
   */
  isProjectionAuthoritative?(objectId: string): boolean;
};

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalJsonValue(record[key])]),
  );
}

/**
 * A scene cache may deliberately retain an equivalent object from an earlier
 * aggregate room envelope. Reference identity therefore cannot prove whether
 * its pixels are current. Revisions/incarnations are the authority fence and
 * this value comparison rejects a same-revision optimistic/stale draft even
 * when a host forgets to provide the additional protection predicate.
 */
function isSameSemanticObject(
  current: CanvasObject,
  projected: CanvasObject,
): boolean {
  if (current === projected) return true;
  if (
    current.id !== projected.id ||
    current.kind !== projected.kind ||
    current.revision !== projected.revision ||
    current.createdAt !== projected.createdAt
  ) {
    return false;
  }
  return JSON.stringify(canonicalJsonValue(current)) ===
    JSON.stringify(canonicalJsonValue(projected));
}

function unionBounds(left: CanvasBounds | null, right: CanvasBounds): CanvasBounds {
  if (!left) return { ...right };
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

function viewportAtZoom(bounds: CanvasBounds, current: Viewport, zoom: number): Viewport {
  const physicalWidth = current.width * current.zoom;
  const physicalHeight = current.height * current.zoom;
  const width = physicalWidth / zoom;
  const height = physicalHeight / zoom;
  return {
    x: bounds.x + bounds.width / 2 - width / 2,
    y: bounds.y + bounds.height / 2 - height / 2,
    width,
    height,
    zoom,
  };
}

/** Create the runtime exposed by the first-party authoritative read model. */
export function createSemanticCanvasRuntime(host: SemanticCanvasRuntimeHost): CanvasRuntime {
  return {
    rendererId: "jazzboard-semantic-v1",
    capabilities: { renderPng: true },

    getViewport: host.getViewport,
    pageToViewport(point) {
      return pageToViewportPoint(point, host.getViewport());
    },
    viewportToPage(point) {
      return viewportToPagePoint(point, host.getViewport());
    },
    getDocumentObjectIds() {
      return host.getScene().objects.map(({ object }) => object.id);
    },
    getSelectedObjectIds: host.getSelection,
    hasObject(objectId) {
      return Boolean(host.getScene().objectsById[objectId]);
    },
    getObjectBounds(objectId) {
      return host.getScene().objectsById[objectId]?.bounds ?? null;
    },
    getVisibleBounds(objectIds) {
      return objectIds.reduce<CanvasBounds | null>((bounds, objectId) => {
        const next = host.getScene().objectsById[objectId]?.bounds;
        return next ? unionBounds(bounds, next) : bounds;
      }, null);
    },
    onDocumentChange: host.onDocumentChange,
    selectObjects(objectIds) {
      host.setSelection([...new Set(objectIds)].filter((objectId) => Boolean(host.getScene().objectsById[objectId])));
    },
    zoomToBounds(bounds, options = {}) {
      const current = host.getViewport();
      const fitted = fitBoundsInViewport(bounds, current, { padding: options.inset });
      const next = options.targetZoom === undefined
        ? fitted
        : viewportAtZoom(bounds, current, clampCanvasZoom(options.targetZoom));
      host.setViewport(next, {
        durationMs: options.durationMs,
        force: options.force,
        ...(options.publishPresence === undefined
          ? {}
          : { publishPresence: options.publishPresence }),
      });
    },
    isObjectRenderedExact(object) {
      const projected = host.getScene().objectsById[object.id]?.object;
      return Boolean(
        projected &&
        isSameSemanticObject(object, projected) &&
        projected.kind === object.kind &&
        projected.revision === object.revision &&
        projected.createdAt === object.createdAt,
      );
    },
    isObjectProjectionExact(object) {
      const current = host.getRoom().objects[object.id];
      const projected = host.getScene().objectsById[object.id]?.object;
      return Boolean(
        current &&
        projected &&
        isSameSemanticObject(current, projected) &&
        isSameSemanticObject(object, projected) &&
        host.isProjectionAuthoritative?.(object.id) !== false &&
        current.kind === object.kind &&
        current.revision === object.revision &&
        current.createdAt === object.createdAt,
      );
    },
    async renderPng(objectIds, options) {
      const rendered = await renderSemanticScenePng(host.getScene(), objectIds, options);
      return {
        blob: rendered.blob,
        logicalWidth: rendered.logicalWidth,
        logicalHeight: rendered.logicalHeight,
        warnings: rendered.warnings.map((warning) => warning.message),
      };
    },
  };
}
