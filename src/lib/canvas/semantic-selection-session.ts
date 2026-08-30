import type {
  CanvasBounds,
  CanvasObject,
  Point,
} from "@/lib/domain/types";
import { flattenVectorPath } from "@/lib/domain/vector-path";

import type {
  SemanticScene,
  SemanticSceneObject,
} from "./semantic-scene";

const EPSILON = 1e-9;
const TWO_PI = Math.PI * 2;

const DRAW_STROKE_WIDTH: Readonly<
  Record<Extract<CanvasObject, { kind: "draw" }>["size"], number>
> = Object.freeze({ s: 2, m: 4, l: 7 });

export const SEMANTIC_SELECTION_DEFAULTS = Object.freeze({
  hitTolerancePx: 8,
  marqueeTolerancePx: 0,
});

export type SemanticSelectionIntent = "replace" | "add" | "toggle";
export type SemanticMarqueeMode = "intersect" | "contain";
export type SemanticSelectionGroupMode = "object" | "group";
export type SemanticLockedImageMode = "selectable" | "exclude";

export type SemanticSelectionHitTestOptions = Readonly<{
  /** Current camera zoom, used only to convert screen pixels to page units. */
  zoom: number;
  tolerancePx?: number;
  groupMode?: SemanticSelectionGroupMode;
  lockedImages?: SemanticLockedImageMode;
}>;

export type SemanticSelectionBoundsQueryOptions = Readonly<{
  mode?: SemanticMarqueeMode;
  /** Current camera zoom, used only to convert screen pixels to page units. */
  zoom?: number;
  tolerancePx?: number;
  groupMode?: SemanticSelectionGroupMode;
  lockedImages?: SemanticLockedImageMode;
}>;

export type SemanticSelectionHit = Readonly<{
  objectId: string;
  object: CanvasObject;
  sceneObject: SemanticSceneObject;
  groupId: string | null;
  /** Page-space distance to the selectable geometry; zero means inside a fill or label. */
  distance: number;
  /** Atomic selection target after optional semantic-group expansion. */
  selectionObjectIds: readonly string[];
}>;

export type SemanticMarqueeToken = Readonly<{
  sessionId: string;
  fence: number;
}>;

export type SemanticMarqueeSession = Readonly<{
  token: SemanticMarqueeToken;
  pointerStart: Readonly<Point>;
  pointerCurrent: Readonly<Point>;
  bounds: Readonly<CanvasBounds>;
  mode: SemanticMarqueeMode;
  intent: SemanticSelectionIntent;
  groupMode: SemanticSelectionGroupMode;
  lockedImages: SemanticLockedImageMode;
  zoom: number;
  tolerancePx: number;
  /** Direct geometry matches, before group expansion. */
  candidateObjectIds: readonly string[];
  /** Group-expanded candidates in stable paint order. */
  targetObjectIds: readonly string[];
  /** Selection after applying the session intent to its initial selection. */
  selectedObjectIds: readonly string[];
  phase: "selecting" | "finished" | "cancelled";
}>;

export type SemanticMarqueeBeginInput = Readonly<{
  pointerStart: Point;
  selectedObjectIds?: readonly string[];
  mode?: SemanticMarqueeMode;
  intent?: SemanticSelectionIntent;
  groupMode?: SemanticSelectionGroupMode;
  lockedImages?: SemanticLockedImageMode;
  zoom?: number;
  tolerancePx?: number;
  sessionId?: string;
}>;

export type SemanticMarqueeStarted = Readonly<{
  status: "started";
  session: SemanticMarqueeSession;
  /** Beginning a new marquee deterministically cancels the previous one. */
  superseded: SemanticMarqueeCancelled | null;
}>;

export type SemanticMarqueeUpdated = Readonly<{
  status: "updated";
  session: SemanticMarqueeSession;
}>;

export type SemanticMarqueeFinished = Readonly<{
  status: "finished";
  session: SemanticMarqueeSession;
}>;

export type SemanticMarqueeCancelled = Readonly<{
  status: "cancelled";
  session: SemanticMarqueeSession;
  /** The normalized selection from before this marquee began. */
  selectedObjectIds: readonly string[];
}>;

export type SemanticMarqueeStale = Readonly<{
  status: "stale";
  token: SemanticMarqueeToken;
}>;

export class SemanticSelectionSessionError extends Error {
  constructor(
    readonly code:
      | "INVALID_POINT"
      | "INVALID_BOUNDS"
      | "INVALID_ZOOM"
      | "INVALID_TOLERANCE",
    message: string,
  ) {
    super(message);
    this.name = "SemanticSelectionSessionError";
  }
}

type InternalMarqueeSession = {
  scene: SemanticScene;
  initialSelection: readonly string[];
  snapshot: SemanticMarqueeSession;
};

function finitePoint(point: Point): void {
  if (Number.isFinite(point.x) && Number.isFinite(point.y)) return;
  throw new SemanticSelectionSessionError(
    "INVALID_POINT",
    "Selection points must contain finite page-space coordinates.",
  );
}

function finiteBounds(bounds: CanvasBounds): void {
  if (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width >= 0 &&
    bounds.height >= 0
  ) return;
  throw new SemanticSelectionSessionError(
    "INVALID_BOUNDS",
    "Selection bounds must contain finite coordinates and non-negative dimensions.",
  );
}

/** Convert a screen-pixel affordance to page units without coupling selection to a camera. */
export function selectionScreenPixelsToPageUnits(
  pixels: number,
  zoom: number,
): number {
  if (!Number.isFinite(zoom) || zoom <= 0) {
    throw new SemanticSelectionSessionError(
      "INVALID_ZOOM",
      "Selection zoom must be a finite number greater than zero.",
    );
  }
  if (!Number.isFinite(pixels) || pixels < 0) {
    throw new SemanticSelectionSessionError(
      "INVALID_TOLERANCE",
      "Selection tolerance must be a finite, non-negative number of screen pixels.",
    );
  }
  return pixels / zoom;
}

/** Normalize a page-space drag, including right-to-left and bottom-to-top drags. */
export function normalizeSemanticSelectionBounds(
  start: Point,
  end: Point,
): CanvasBounds {
  finitePoint(start);
  finitePoint(end);
  return Object.freeze({
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  });
}

function expandBounds(bounds: CanvasBounds, amount: number): CanvasBounds {
  return {
    x: bounds.x - amount,
    y: bounds.y - amount,
    width: bounds.width + amount * 2,
    height: bounds.height + amount * 2,
  };
}

function boundsIntersect(left: CanvasBounds, right: CanvasBounds): boolean {
  return left.x <= right.x + right.width + EPSILON &&
    left.x + left.width + EPSILON >= right.x &&
    left.y <= right.y + right.height + EPSILON &&
    left.y + left.height + EPSILON >= right.y;
}

function boundsContain(outer: CanvasBounds, inner: CanvasBounds): boolean {
  return inner.x + EPSILON >= outer.x &&
    inner.y + EPSILON >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width + EPSILON &&
    inner.y + inner.height <= outer.y + outer.height + EPSILON;
}

function pointInBounds(point: Point, bounds: CanvasBounds): boolean {
  return point.x + EPSILON >= bounds.x &&
    point.x <= bounds.x + bounds.width + EPSILON &&
    point.y + EPSILON >= bounds.y &&
    point.y <= bounds.y + bounds.height + EPSILON;
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return distance(point, start);
  const ratio = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
  ));
  return distance(point, {
    x: start.x + dx * ratio,
    y: start.y + dy * ratio,
  });
}

function polylineDistance(point: Point, points: readonly Point[]): number {
  if (!points.length) return Number.POSITIVE_INFINITY;
  if (points.length === 1) return distance(point, points[0]);
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    nearest = Math.min(nearest, distanceToSegment(point, points[index - 1], points[index]));
  }
  return nearest;
}

function rotateAround(point: Point, center: Point, angle: number): Point {
  if (Math.abs(angle) <= EPSILON) return { ...point };
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine,
  };
}

function objectCenter(object: CanvasObject): Point {
  return {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2,
  };
}

function objectLocalPoint(object: CanvasObject, point: Point): Point {
  return rotateAround(point, objectCenter(object), -object.rotation);
}

function rectangleCorners(object: CanvasObject): Point[] {
  const center = objectCenter(object);
  return [
    { x: object.x, y: object.y },
    { x: object.x + object.width, y: object.y },
    { x: object.x + object.width, y: object.y + object.height },
    { x: object.x, y: object.y + object.height },
  ].map((point) => rotateAround(point, center, object.rotation));
}

function diamondCorners(object: CanvasObject): Point[] {
  const center = objectCenter(object);
  return [
    { x: center.x, y: object.y },
    { x: object.x + object.width, y: center.y },
    { x: center.x, y: object.y + object.height },
    { x: object.x, y: center.y },
  ].map((point) => rotateAround(point, center, object.rotation));
}

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let index = 0, prior = polygon.length - 1; index < polygon.length; prior = index, index += 1) {
    const currentPoint = polygon[index];
    const priorPoint = polygon[prior];
    if (distanceToSegment(point, priorPoint, currentPoint) <= EPSILON) return true;
    const crosses = (currentPoint.y > point.y) !== (priorPoint.y > point.y) &&
      point.x < (priorPoint.x - currentPoint.x) * (point.y - currentPoint.y) /
        (priorPoint.y - currentPoint.y) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function polygonDistance(point: Point, polygon: readonly Point[]): number {
  if (pointInPolygon(point, polygon)) return 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    nearest = Math.min(
      nearest,
      distanceToSegment(point, polygon[index], polygon[(index + 1) % polygon.length]),
    );
  }
  return nearest;
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: Point, start: Point, end: Point): boolean {
  return Math.abs(orientation(start, end, point)) <= EPSILON &&
    point.x + EPSILON >= Math.min(start.x, end.x) &&
    point.x <= Math.max(start.x, end.x) + EPSILON &&
    point.y + EPSILON >= Math.min(start.y, end.y) &&
    point.y <= Math.max(start.y, end.y) + EPSILON;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) &&
      ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))) return true;
  return pointOnSegment(c, a, b) || pointOnSegment(d, a, b) ||
    pointOnSegment(a, c, d) || pointOnSegment(b, c, d);
}

function boundsCorners(bounds: CanvasBounds): Point[] {
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ];
}

function segmentIntersectsBounds(start: Point, end: Point, bounds: CanvasBounds): boolean {
  if (pointInBounds(start, bounds) || pointInBounds(end, bounds)) return true;
  const corners = boundsCorners(bounds);
  return corners.some((corner, index) =>
    segmentsIntersect(start, end, corner, corners[(index + 1) % corners.length]));
}

function polygonIntersectsBounds(polygon: readonly Point[], bounds: CanvasBounds): boolean {
  if (polygon.some((point) => pointInBounds(point, bounds))) return true;
  const corners = boundsCorners(bounds);
  if (corners.some((point) => pointInPolygon(point, polygon))) return true;
  return polygon.some((point, index) =>
    corners.some((corner, cornerIndex) => segmentsIntersect(
      point,
      polygon[(index + 1) % polygon.length],
      corner,
      corners[(cornerIndex + 1) % corners.length],
    )));
}

function ellipseContainsPoint(object: CanvasObject, point: Point): boolean {
  const local = objectLocalPoint(object, point);
  const center = objectCenter(object);
  const radiusX = Math.max(object.width / 2, EPSILON);
  const radiusY = Math.max(object.height / 2, EPSILON);
  const dx = (local.x - center.x) / radiusX;
  const dy = (local.y - center.y) / radiusY;
  return dx * dx + dy * dy <= 1 + EPSILON;
}

function ellipseDistance(object: CanvasObject, point: Point): number {
  if (ellipseContainsPoint(object, point)) return 0;
  const local = objectLocalPoint(object, point);
  const center = objectCenter(object);
  const dx = local.x - center.x;
  const dy = local.y - center.y;
  const radiusX = Math.max(object.width / 2, EPSILON);
  const radiusY = Math.max(object.height / 2, EPSILON);
  const radialScale = Math.sqrt((dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY));
  return distance(local, {
    x: center.x + dx / radialScale,
    y: center.y + dy / radialScale,
  });
}

function segmentIntersectsEllipse(
  start: Point,
  end: Point,
  object: CanvasObject,
): boolean {
  const center = objectCenter(object);
  const localStart = objectLocalPoint(object, start);
  const localEnd = objectLocalPoint(object, end);
  const radiusX = Math.max(object.width / 2, EPSILON);
  const radiusY = Math.max(object.height / 2, EPSILON);
  const x1 = (localStart.x - center.x) / radiusX;
  const y1 = (localStart.y - center.y) / radiusY;
  const dx = (localEnd.x - localStart.x) / radiusX;
  const dy = (localEnd.y - localStart.y) / radiusY;
  const a = dx * dx + dy * dy;
  const b = 2 * (x1 * dx + y1 * dy);
  const c = x1 * x1 + y1 * y1 - 1;
  if (a <= EPSILON) return c <= EPSILON;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -EPSILON) return false;
  const root = Math.sqrt(Math.max(0, discriminant));
  const first = (-b - root) / (2 * a);
  const second = (-b + root) / (2 * a);
  return (first >= -EPSILON && first <= 1 + EPSILON) ||
    (second >= -EPSILON && second <= 1 + EPSILON);
}

function ellipseIntersectsBounds(object: CanvasObject, bounds: CanvasBounds): boolean {
  const corners = boundsCorners(bounds);
  if (corners.some((point) => ellipseContainsPoint(object, point))) return true;
  if (pointInBounds(objectCenter(object), bounds)) return true;
  return corners.some((point, index) =>
    segmentIntersectsEllipse(point, corners[(index + 1) % corners.length], object));
}

function ellipseWorldBounds(object: CanvasObject): CanvasBounds {
  const center = objectCenter(object);
  const radiusX = object.width / 2;
  const radiusY = object.height / 2;
  const cosine = Math.cos(object.rotation);
  const sine = Math.sin(object.rotation);
  const extentX = Math.sqrt(radiusX * radiusX * cosine * cosine + radiusY * radiusY * sine * sine);
  const extentY = Math.sqrt(radiusX * radiusX * sine * sine + radiusY * radiusY * cosine * cosine);
  return {
    x: center.x - extentX,
    y: center.y - extentY,
    width: extentX * 2,
    height: extentY * 2,
  };
}

function normalizeAngle(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

function angleOnArc(angle: number, startAngle: number, sweepAngle: number): boolean {
  if (sweepAngle >= 0) {
    return normalizeAngle(angle - startAngle) <= sweepAngle + EPSILON;
  }
  return normalizeAngle(startAngle - angle) <= -sweepAngle + EPSILON;
}

function arcDistance(
  point: Point,
  arc: NonNullable<SemanticScene["connectorRoutes"][string]["arc"]>,
  start: Point,
  end: Point,
): number {
  const pointAngle = Math.atan2(point.y - arc.center.y, point.x - arc.center.x);
  if (angleOnArc(pointAngle, arc.startAngle, arc.sweepAngle)) {
    return Math.abs(distance(point, arc.center) - arc.radius);
  }
  return Math.min(distance(point, start), distance(point, end));
}

function segmentCircleIntersections(
  start: Point,
  end: Point,
  center: Point,
  radius: number,
): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const offsetX = start.x - center.x;
  const offsetY = start.y - center.y;
  const a = dx * dx + dy * dy;
  if (a <= EPSILON) return [];
  const b = 2 * (offsetX * dx + offsetY * dy);
  const c = offsetX * offsetX + offsetY * offsetY - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -EPSILON) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)]
    .filter((ratio, index, values) =>
      ratio >= -EPSILON && ratio <= 1 + EPSILON &&
      (index === 0 || Math.abs(ratio - values[0]) > EPSILON))
    .map((ratio) => ({ x: start.x + dx * ratio, y: start.y + dy * ratio }));
}

function arcIntersectsBounds(
  arc: NonNullable<SemanticScene["connectorRoutes"][string]["arc"]>,
  start: Point,
  end: Point,
  bounds: CanvasBounds,
): boolean {
  if (pointInBounds(start, bounds) || pointInBounds(end, bounds)) return true;
  const corners = boundsCorners(bounds);
  return corners.some((corner, index) =>
    segmentCircleIntersections(
      corner,
      corners[(index + 1) % corners.length],
      arc.center,
      arc.radius,
    ).some((point) => angleOnArc(
      Math.atan2(point.y - arc.center.y, point.x - arc.center.x),
      arc.startAngle,
      arc.sweepAngle,
    )));
}

function drawWorldPoints(object: Extract<CanvasObject, { kind: "draw" }>): Point[] {
  const cosine = Math.cos(object.rotation);
  const sine = Math.sin(object.rotation);
  return object.points.map((point) => ({
    x: object.x + point.x * cosine - point.y * sine,
    y: object.y + point.x * sine + point.y * cosine,
  }));
}

function objectHitDistance(
  scene: SemanticScene,
  item: SemanticSceneObject,
  point: Point,
): number {
  const object = item.object;
  if (object.kind === "connector") {
    const route = scene.connectorRoutes[object.id];
    if (!route) return Number.POSITIVE_INFINITY;
    if (route.labelBounds && pointInBounds(point, route.labelBounds)) return 0;
    return route.arc
      ? arcDistance(point, route.arc, route.start, route.end)
      : polylineDistance(point, route.points);
  }
  if (object.kind === "draw") {
    return Math.max(0, polylineDistance(point, drawWorldPoints(object)) - DRAW_STROKE_WIDTH[object.size] / 2);
  }
  if (object.kind === "path") {
    const points = flattenVectorPath(object);
    if (object.fill.trim().toLowerCase() !== "none") {
      return polygonDistance(point, points);
    }
    return Math.max(0, polylineDistance(point, points) - object.strokeWidth / 2);
  }
  if (object.kind === "shape" && object.shape === "ellipse") {
    return ellipseDistance(object, point);
  }
  const polygon = object.kind === "shape" && object.shape === "diamond"
    ? diamondCorners(object)
    : rectangleCorners(object);
  return polygonDistance(point, polygon);
}

function stableSceneOrder(scene: SemanticScene, ids: Iterable<string>): string[] {
  const requested = new Set(ids);
  return scene.objects
    .filter(({ object }) => requested.has(object.id))
    .map(({ object }) => object.id);
}

/**
 * Expand semantic groups without changing paint order. Locks never affect this
 * expansion: a locked image is still a valid selection target even when an
 * editing engine later refuses a direct geometry mutation.
 */
export function expandSemanticSelectionGroups(
  scene: SemanticScene,
  objectIds: Iterable<string>,
  groupMode: SemanticSelectionGroupMode = "group",
): readonly string[] {
  const expanded = new Set<string>();
  for (const objectId of objectIds) {
    const item = scene.objectsById[objectId];
    if (!item) continue;
    expanded.add(objectId);
    if (groupMode !== "group" || !item.object.groupId) continue;
    for (const memberId of scene.groupMembers[item.object.groupId] ?? []) expanded.add(memberId);
  }
  return Object.freeze(stableSceneOrder(scene, expanded));
}

function selectable(item: SemanticSceneObject, lockedImages: SemanticLockedImageMode): boolean {
  return !(lockedImages === "exclude" && item.object.kind === "image" && item.object.locked);
}

/** Return every hit in deterministic topmost-first order. */
export function hitTestSemanticSceneObjects(
  scene: SemanticScene,
  point: Point,
  options: SemanticSelectionHitTestOptions,
): readonly SemanticSelectionHit[] {
  finitePoint(point);
  const tolerance = selectionScreenPixelsToPageUnits(
    options.tolerancePx ?? SEMANTIC_SELECTION_DEFAULTS.hitTolerancePx,
    options.zoom,
  );
  const groupMode = options.groupMode ?? "group";
  const lockedImages = options.lockedImages ?? "selectable";
  const hits = scene.objects
    .filter((item) => selectable(item, lockedImages))
    .flatMap((item): SemanticSelectionHit[] => {
      if (!pointInBounds(point, expandBounds(item.bounds, tolerance))) return [];
      const hitDistance = objectHitDistance(scene, item, point);
      if (hitDistance > tolerance + EPSILON) return [];
      return [{
        objectId: item.object.id,
        object: item.object,
        sceneObject: item,
        groupId: item.object.groupId,
        distance: hitDistance,
        selectionObjectIds: expandSemanticSelectionGroups(scene, [item.object.id], groupMode),
      }];
    })
    .sort((left, right) =>
      right.object.zIndex - left.object.zIndex || right.object.id.localeCompare(left.object.id));
  return Object.freeze(hits.map((hit) => Object.freeze(hit)));
}

/** Return the stable topmost semantic hit, independent of object proximity. */
export function hitTestSemanticScene(
  scene: SemanticScene,
  point: Point,
  options: SemanticSelectionHitTestOptions,
): SemanticSelectionHit | null {
  return hitTestSemanticSceneObjects(scene, point, options)[0] ?? null;
}

function objectIntersectsMarquee(
  scene: SemanticScene,
  item: SemanticSceneObject,
  marquee: CanvasBounds,
  mode: SemanticMarqueeMode,
): boolean {
  const object = item.object;
  if (mode === "contain") {
    if (object.kind === "shape" && object.shape === "ellipse") {
      return boundsContain(marquee, ellipseWorldBounds(object));
    }
    if (object.kind === "connector") {
      const route = scene.connectorRoutes[object.id];
      return Boolean(route && boundsContain(marquee, route.bounds));
    }
    if (object.kind === "draw" || object.kind === "path") return boundsContain(marquee, item.bounds);
    const polygon = object.kind === "shape" && object.shape === "diamond"
      ? diamondCorners(object)
      : rectangleCorners(object);
    return polygon.every((point) => pointInBounds(point, marquee));
  }

  if (!boundsIntersect(item.bounds, marquee)) return false;
  if (object.kind === "shape" && object.shape === "ellipse") {
    return ellipseIntersectsBounds(object, marquee);
  }
  if (object.kind === "draw") {
    const strokeBounds = expandBounds(marquee, DRAW_STROKE_WIDTH[object.size] / 2);
    const points = drawWorldPoints(object);
    if (points.length === 1) return pointInBounds(points[0], strokeBounds);
    return points.some((point, index) =>
      index > 0 && segmentIntersectsBounds(points[index - 1], point, strokeBounds));
  }
  if (object.kind === "path") {
    const points = flattenVectorPath(object);
    if (object.fill.trim().toLowerCase() !== "none" && polygonIntersectsBounds(points, marquee)) {
      return true;
    }
    const strokeBounds = expandBounds(marquee, object.stroke === "none" ? 0 : object.strokeWidth / 2);
    return points.some((point, index) =>
      index > 0 && segmentIntersectsBounds(points[index - 1], point, strokeBounds));
  }
  if (object.kind === "connector") {
    const route = scene.connectorRoutes[object.id];
    if (!route) return false;
    if (route.labelBounds && boundsIntersect(route.labelBounds, marquee)) return true;
    if (route.arc) return arcIntersectsBounds(route.arc, route.start, route.end, marquee);
    return route.points.some((point, index) =>
      index > 0 && segmentIntersectsBounds(route.points[index - 1], point, marquee));
  }
  const polygon = object.kind === "shape" && object.shape === "diamond"
    ? diamondCorners(object)
    : rectangleCorners(object);
  return polygonIntersectsBounds(polygon, marquee);
}

/**
 * Query a page-space marquee. Direct matches are returned in ascending paint
 * order; callers can request group expansion without any renderer records.
 */
export function querySemanticSceneBounds(
  scene: SemanticScene,
  bounds: CanvasBounds,
  options: SemanticSelectionBoundsQueryOptions = {},
): readonly string[] {
  finiteBounds(bounds);
  const zoom = options.zoom ?? 1;
  const tolerance = selectionScreenPixelsToPageUnits(
    options.tolerancePx ?? SEMANTIC_SELECTION_DEFAULTS.marqueeTolerancePx,
    zoom,
  );
  const marquee = expandBounds(bounds, tolerance);
  const lockedImages = options.lockedImages ?? "selectable";
  const direct = scene.objects
    .filter((item) => selectable(item, lockedImages))
    .filter((item) => objectIntersectsMarquee(scene, item, marquee, options.mode ?? "intersect"))
    .map(({ object }) => object.id);
  return expandSemanticSelectionGroups(scene, direct, options.groupMode ?? "group");
}

/** Apply replace/add/toggle semantics and return a normalized, stable selection. */
export function applySemanticSelectionIntent(
  scene: SemanticScene,
  selectedObjectIds: Iterable<string>,
  targetObjectIds: Iterable<string>,
  intent: SemanticSelectionIntent,
  groupMode: SemanticSelectionGroupMode = "group",
): readonly string[] {
  const selected = new Set(expandSemanticSelectionGroups(scene, selectedObjectIds, groupMode));
  const targets = expandSemanticSelectionGroups(scene, targetObjectIds, groupMode);
  if (intent === "replace") return targets;
  if (intent === "add") {
    for (const objectId of targets) selected.add(objectId);
  } else {
    for (const objectId of targets) {
      if (selected.has(objectId)) selected.delete(objectId);
      else selected.add(objectId);
    }
  }
  return Object.freeze(stableSceneOrder(scene, selected));
}

function freezePoint(point: Point): Readonly<Point> {
  return Object.freeze({ x: point.x, y: point.y });
}

function freezeSession(session: SemanticMarqueeSession): SemanticMarqueeSession {
  return Object.freeze({
    ...session,
    token: Object.freeze({ ...session.token }),
    pointerStart: freezePoint(session.pointerStart),
    pointerCurrent: freezePoint(session.pointerCurrent),
    bounds: Object.freeze({ ...session.bounds }),
    candidateObjectIds: Object.freeze([...session.candidateObjectIds]),
    targetObjectIds: Object.freeze([...session.targetObjectIds]),
    selectedObjectIds: Object.freeze([...session.selectedObjectIds]),
  });
}

function sameToken(left: SemanticMarqueeToken, right: SemanticMarqueeToken): boolean {
  return left.fence === right.fence && left.sessionId === right.sessionId;
}

/**
 * Pure drag-marquee lifecycle with stale-token fencing. The scene is captured
 * at begin time so polling or rendering cannot change membership halfway
 * through one pointer gesture; the host may begin a fresh session for a newer
 * scene. Zero-area sessions intentionally match nothing—ordinary clicks use
 * `hitTestSemanticScene`.
 */
export class SemanticMarqueeSelectionSessionEngine {
  private fence = 0;
  private active: InternalMarqueeSession | null = null;

  getActiveSession(): SemanticMarqueeSession | null {
    return this.active?.snapshot ?? null;
  }

  begin(
    scene: SemanticScene,
    input: SemanticMarqueeBeginInput,
  ): SemanticMarqueeStarted {
    finitePoint(input.pointerStart);
    const zoom = input.zoom ?? 1;
    const tolerancePx = input.tolerancePx ?? SEMANTIC_SELECTION_DEFAULTS.marqueeTolerancePx;
    selectionScreenPixelsToPageUnits(tolerancePx, zoom);
    const superseded = this.active ? this.cancelCurrent() : null;
    this.fence += 1;
    const token = Object.freeze({
      sessionId: input.sessionId ?? `semantic-marquee-${this.fence}`,
      fence: this.fence,
    });
    const groupMode = input.groupMode ?? "group";
    const initialSelection = expandSemanticSelectionGroups(
      scene,
      input.selectedObjectIds ?? [],
      groupMode,
    );
    const bounds = normalizeSemanticSelectionBounds(input.pointerStart, input.pointerStart);
    const snapshot = freezeSession({
      token,
      pointerStart: input.pointerStart,
      pointerCurrent: input.pointerStart,
      bounds,
      mode: input.mode ?? "intersect",
      intent: input.intent ?? "replace",
      groupMode,
      lockedImages: input.lockedImages ?? "selectable",
      zoom,
      tolerancePx,
      candidateObjectIds: [],
      targetObjectIds: [],
      selectedObjectIds: initialSelection,
      phase: "selecting",
    });
    this.active = { scene, initialSelection, snapshot };
    return Object.freeze({ status: "started", session: snapshot, superseded });
  }

  updatePointer(
    token: SemanticMarqueeToken,
    pointer: Point,
  ): SemanticMarqueeUpdated | SemanticMarqueeStale {
    finitePoint(pointer);
    if (!this.active || !sameToken(this.active.snapshot.token, token)) {
      return Object.freeze({ status: "stale", token: Object.freeze({ ...token }) });
    }
    this.active.snapshot = this.snapshotAt(this.active, pointer, "selecting");
    return Object.freeze({ status: "updated", session: this.active.snapshot });
  }

  finish(
    token: SemanticMarqueeToken,
    pointer?: Point,
  ): SemanticMarqueeFinished | SemanticMarqueeStale {
    if (pointer) finitePoint(pointer);
    if (!this.active || !sameToken(this.active.snapshot.token, token)) {
      return Object.freeze({ status: "stale", token: Object.freeze({ ...token }) });
    }
    const current = this.active;
    current.snapshot = this.snapshotAt(
      current,
      pointer ?? current.snapshot.pointerCurrent,
      "finished",
    );
    this.active = null;
    return Object.freeze({ status: "finished", session: current.snapshot });
  }

  cancel(token: SemanticMarqueeToken): SemanticMarqueeCancelled | SemanticMarqueeStale {
    if (!this.active || !sameToken(this.active.snapshot.token, token)) {
      return Object.freeze({ status: "stale", token: Object.freeze({ ...token }) });
    }
    return this.cancelCurrent();
  }

  private cancelCurrent(): SemanticMarqueeCancelled {
    const current = this.active;
    if (!current) throw new Error("Cannot cancel an inactive semantic marquee.");
    current.snapshot = freezeSession({
      ...current.snapshot,
      selectedObjectIds: current.initialSelection,
      phase: "cancelled",
    });
    this.active = null;
    return Object.freeze({
      status: "cancelled",
      session: current.snapshot,
      selectedObjectIds: current.initialSelection,
    });
  }

  private snapshotAt(
    current: InternalMarqueeSession,
    pointer: Point,
    phase: SemanticMarqueeSession["phase"],
  ): SemanticMarqueeSession {
    const previous = current.snapshot;
    const bounds = normalizeSemanticSelectionBounds(previous.pointerStart, pointer);
    const hasArea = bounds.width > EPSILON || bounds.height > EPSILON;
    const candidateObjectIds = hasArea
      ? querySemanticSceneBounds(current.scene, bounds, {
          mode: previous.mode,
          zoom: previous.zoom,
          tolerancePx: previous.tolerancePx,
          groupMode: "object",
          lockedImages: previous.lockedImages,
        })
      : [];
    const targetObjectIds = expandSemanticSelectionGroups(
      current.scene,
      candidateObjectIds,
      previous.groupMode,
    );
    const selectedObjectIds = applySemanticSelectionIntent(
      current.scene,
      current.initialSelection,
      targetObjectIds,
      previous.intent,
      previous.groupMode,
    );
    return freezeSession({
      ...previous,
      pointerCurrent: pointer,
      bounds,
      candidateObjectIds,
      targetObjectIds,
      selectedObjectIds,
      phase,
    });
  }
}
