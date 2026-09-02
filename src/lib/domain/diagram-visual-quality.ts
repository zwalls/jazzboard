import {
  SEMANTIC_TEXT_FONT_SIZES,
  semanticShapeLabelMaxCharacters,
  semanticShapeLabelMaxLines,
} from "@/lib/canvas/semantic-visual-style";
import {
  layoutSemanticText,
  SEMANTIC_CONNECTOR_LABEL_MAX_LINES,
  semanticConnectorLabelMaximumCharacters,
  semanticTextMaximumCharacters,
  semanticTextMaximumLines,
} from "@/lib/canvas/semantic-text-layout";

import {
  connectorPortSide,
  materializeConnectorRoute,
  type ConnectorPortSide,
  type ResolvedConnectorRoute,
} from "./connector-routing";
import type {
  CanvasBounds,
  CanvasObject,
  ConnectorObject,
  Diagram,
  Point,
  RoomState,
} from "./types";

/**
 * Page-space thresholds for deterministic, renderer-neutral diagram QA.
 *
 * The values intentionally describe visible canvas geometry rather than
 * screen pixels: 32px leaves roughly one large-text line between members;
 * 12px is one arrow-head width; and 16/24px shared runs are long enough to be
 * perceived as the same edge/corridor rather than a coincident endpoint.
 * Truncation checks consume the first-party renderers' shared text-layout
 * contract so they remain deterministic without browser font measurement.
 */
export const DIAGRAM_VISUAL_QUALITY_THRESHOLDS = Object.freeze({
  geometryEpsilon: 0.01,
  objectOverlapMinimumArea: 4,
  connectorIntrusionInset: 2,
  connectorSharedSegmentMinimumLength: 16,
  sharedInitialCorridorMinimumLength: 24,
  attachmentPortRadius: 12,
  attachmentPortMinimumConnectors: 3,
  minimumMemberSpacing: 32,
} as const);

/** Bounds one tool result while retaining representative findings of every kind. */
export const DIAGRAM_VISUAL_QUALITY_LIMITS = Object.freeze({
  maxReturnedFindings: 96,
  maxReturnedFindingsPerCode: 8,
  maxReturnedObjectIdsPerFinding: 16,
  maxReturnedConnectorIdsPerFinding: 32,
  maxReturnedUnsupportedDrawObjectIds: 96,
} as const);

export type DiagramVisualQualityStatus = "pass" | "warning" | "fail";

export type DiagramVisualQualityFindingCode =
  | "ATTACHMENT_PORT_CONGESTION"
  | "CONNECTOR_CROSSING"
  | "CONNECTOR_LABEL_EDGE_COLLISION"
  | "CONNECTOR_LABEL_LABEL_COLLISION"
  | "CONNECTOR_LABEL_LIKELY_TRUNCATED"
  | "CONNECTOR_LABEL_OBJECT_COLLISION"
  | "CONNECTOR_OBJECT_INTRUSION"
  | "CONNECTOR_SHARED_INITIAL_CORRIDOR"
  | "CONNECTOR_SHARED_SEGMENT"
  | "DIAGRAM_EMPTY"
  | "MEMBER_OBJECT_OVERLAP"
  | "MEMBER_SPACING_TOO_SMALL"
  | "SHAPE_LABEL_LIKELY_TRUNCATED"
  | "TEXT_CONTENT_LIKELY_TRUNCATED";

export type DiagramVisualQualityDetailValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | number[];

export type DiagramVisualQualityFinding = {
  code: DiagramVisualQualityFindingCode;
  status: Exclude<DiagramVisualQualityStatus, "pass">;
  /** A concise corrective action, not merely a restatement of the defect. */
  summary: string;
  objectIds: string[];
  connectorIds: string[];
  bounds?: CanvasBounds;
  details?: Record<string, DiagramVisualQualityDetailValue>;
};

export type DiagramVisualQualityMetrics = {
  memberObjectCount: number;
  unsupportedDrawMemberCount: number;
  unsupportedPathMemberCount: number;
  connectorCount: number;
  findingCount: number;
  returnedFindingCount: number;
  omittedFindingCount: number;
  findingsTruncated: boolean;
  failCount: number;
  warningCount: number;
  minimumMemberSpacing: number | null;
  crossingPairCount: number;
  sharedSegmentPairCount: number;
  congestedPortCount: number;
  truncatedConnectorLabelCount: number;
  truncatedShapeLabelCount: number;
  truncatedTextContentCount: number;
  findingsByCode: Partial<Record<DiagramVisualQualityFindingCode, number>>;
};

export type DiagramVisualQualityGeometryCoverage = {
  /** `partial` means `status` applies only to the supported deterministic geometry. */
  status: "complete" | "partial";
  analyzedMemberObjectCount: number;
  unsupportedDrawObjectCount: number;
  /** Stable IDs for freehand members whose swept-stroke relationships need pixel inspection. */
  unsupportedDrawObjectIds: string[];
  omittedUnsupportedDrawObjectIdCount: number;
  unsupportedDrawObjectIdsTruncated: boolean;
  unsupportedPathObjectCount: number;
  unsupportedPathObjectIds: string[];
  omittedUnsupportedPathObjectIdCount: number;
  unsupportedPathObjectIdsTruncated: boolean;
};

export type DiagramVisualQualityReport = {
  schemaVersion: 1;
  diagramId: string;
  diagramRevision: number;
  roomRevision: number;
  status: DiagramVisualQualityStatus;
  summary: string;
  geometryCoverage: DiagramVisualQualityGeometryCoverage;
  findings: DiagramVisualQualityFinding[];
  metrics: DiagramVisualQualityMetrics;
};

type QualityRoom = Pick<RoomState, "roomRevision" | "objects" | "diagrams">;

type Segment = {
  start: Point;
  end: Point;
  index: number;
};

type RouteEndpointUse = {
  connectorId: string;
  objectId: string;
  point: Point;
  outward: Segment | null;
};

type SegmentRelation =
  | { kind: "none" }
  | { kind: "point"; point: Point }
  | { kind: "overlap"; start: Point; end: Point; length: number };

type MemberGeometry = {
  polygon: Point[];
  bounds: CanvasBounds;
};

const T = DIAGRAM_VISUAL_QUALITY_THRESHOLDS;

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function roundedBounds(bounds: CanvasBounds): CanvasBounds {
  return {
    x: round(bounds.x),
    y: round(bounds.y),
    width: round(bounds.width),
    height: round(bounds.height),
  };
}

function rotateAround(point: Point, center: Point, rotation: number): Point {
  if (!rotation) return point;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine,
  };
}

function objectPolygon(object: CanvasObject, inset = 0): Point[] {
  // Draw objects contain an open freehand polyline, not a filled rectangular
  // member. Treating their storage bounds as solid creates blocking overlap
  // and intrusion findings over visibly empty space. Stroke/path proximity is
  // intentionally left to pixel inspection until the analyzer models swept
  // stroke geometry explicitly.
  if (object.kind === "draw" || object.kind === "path") return [];
  if (object.width <= inset * 2 || object.height <= inset * 2) return [];
  const center = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  let polygon: Point[];
  if (object.kind === "shape" && object.shape === "ellipse") {
    const radiusX = object.width / 2 - inset;
    const radiusY = object.height / 2 - inset;
    polygon = Array.from({ length: 48 }, (_, index) => {
      const angle = index * Math.PI * 2 / 48;
      return {
        x: center.x + Math.cos(angle) * radiusX,
        y: center.y + Math.sin(angle) * radiusY,
      };
    });
  } else if (object.kind === "shape" && object.shape === "diamond") {
    polygon = [
      { x: center.x, y: object.y + inset },
      { x: object.x + object.width - inset, y: center.y },
      { x: center.x, y: object.y + object.height - inset },
      { x: object.x + inset, y: center.y },
    ];
  } else {
    polygon = [
      { x: object.x + inset, y: object.y + inset },
      { x: object.x + object.width - inset, y: object.y + inset },
      { x: object.x + object.width - inset, y: object.y + object.height - inset },
      { x: object.x + inset, y: object.y + object.height - inset },
    ];
  }
  return polygon.map((point) => rotateAround(point, center, object.rotation));
}

function polygonBounds(polygon: readonly Point[]): CanvasBounds {
  const minX = Math.min(...polygon.map((point) => point.x));
  const minY = Math.min(...polygon.map((point) => point.y));
  const maxX = Math.max(...polygon.map((point) => point.x));
  const maxY = Math.max(...polygon.map((point) => point.y));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function boundsPolygon(bounds: CanvasBounds): Point[] {
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ];
}

function polygonSignedArea(polygon: readonly Point[]): number {
  return polygon.reduce((area, point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function polygonArea(polygon: readonly Point[]): number {
  return Math.abs(polygonSignedArea(polygon));
}

function lineIntersection(left: Segment, right: Segment): Point {
  const leftVector = subtract(left.end, left.start);
  const rightVector = subtract(right.end, right.start);
  const denominator = cross(leftVector, rightVector);
  if (Math.abs(denominator) <= T.geometryEpsilon) return left.end;
  const scale = cross(subtract(right.start, left.start), rightVector) / denominator;
  return addScaled(left.start, leftVector, scale);
}

/** Sutherland-Hodgman clipping for the convex member polygons used here. */
function intersectConvexPolygons(subject: readonly Point[], clip: readonly Point[]): Point[] {
  if (subject.length < 3 || clip.length < 3) return [];
  const orientation = polygonSignedArea(clip) >= 0 ? 1 : -1;
  let output = [...subject];
  for (let index = 0; index < clip.length && output.length; index += 1) {
    const clipStart = clip[index];
    const clipEnd = clip[(index + 1) % clip.length];
    const clipVector = subtract(clipEnd, clipStart);
    const input = output;
    output = [];
    let previous = input[input.length - 1];
    let previousInside = orientation * cross(clipVector, subtract(previous, clipStart)) >= -T.geometryEpsilon;
    for (const current of input) {
      const currentInside = orientation * cross(clipVector, subtract(current, clipStart)) >= -T.geometryEpsilon;
      if (currentInside !== previousInside) {
        output.push(lineIntersection(
          { start: previous, end: current, index: 0 },
          { start: clipStart, end: clipEnd, index: 0 },
        ));
      }
      if (currentInside) output.push(current);
      previous = current;
      previousInside = currentInside;
    }
  }
  return output;
}

function polygonOverlap(
  left: readonly Point[],
  right: readonly Point[],
): { area: number; bounds: CanvasBounds } | null {
  const intersection = intersectConvexPolygons(left, right);
  const area = polygonArea(intersection);
  if (intersection.length < 3 || area <= T.geometryEpsilon) return null;
  return { area, bounds: polygonBounds(intersection) };
}

function intersectionBounds(left: CanvasBounds, right: CanvasBounds): CanvasBounds | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const maxX = Math.min(left.x + left.width, right.x + right.width);
  const maxY = Math.min(left.y + left.height, right.y + right.height);
  if (maxX - x <= T.geometryEpsilon || maxY - y <= T.geometryEpsilon) return null;
  return { x, y, width: maxX - x, height: maxY - y };
}

function unionBounds(bounds: readonly CanvasBounds[]): CanvasBounds | undefined {
  if (!bounds.length) return undefined;
  const minX = Math.min(...bounds.map((bound) => bound.x));
  const minY = Math.min(...bounds.map((bound) => bound.y));
  const maxX = Math.max(...bounds.map((bound) => bound.x + bound.width));
  const maxY = Math.max(...bounds.map((bound) => bound.y + bound.height));
  return roundedBounds({ x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) });
}

function pointBounds(point: Point): CanvasBounds {
  return roundedBounds({ x: point.x - 1, y: point.y - 1, width: 2, height: 2 });
}

function distance(left: Point, right: Point): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function segments(points: readonly Point[]): Segment[] {
  return points.slice(1).map((end, index) => ({ start: points[index], end, index }));
}

/** Liang-Barsky clipping against a closed axis-aligned box. */
function segmentIntersectsBounds(segment: Segment, bounds: CanvasBounds): boolean {
  let minimum = 0;
  let maximum = 1;
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  for (const [p, q] of [
    [-dx, segment.start.x - bounds.x],
    [dx, bounds.x + bounds.width - segment.start.x],
    [-dy, segment.start.y - bounds.y],
    [dy, bounds.y + bounds.height - segment.start.y],
  ] as const) {
    if (Math.abs(p) <= T.geometryEpsilon) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }
  return true;
}

function cross(left: Point, right: Point): number {
  return left.x * right.y - left.y * right.x;
}

function subtract(left: Point, right: Point): Point {
  return { x: left.x - right.x, y: left.y - right.y };
}

function addScaled(origin: Point, vector: Point, scale: number): Point {
  return { x: origin.x + vector.x * scale, y: origin.y + vector.y * scale };
}

function segmentRelation(left: Segment, right: Segment): SegmentRelation {
  const r = subtract(left.end, left.start);
  const s = subtract(right.end, right.start);
  const denominator = cross(r, s);
  const offset = subtract(right.start, left.start);
  if (Math.abs(denominator) > T.geometryEpsilon) {
    const t = cross(offset, s) / denominator;
    const u = cross(offset, r) / denominator;
    if (
      t < -T.geometryEpsilon || t > 1 + T.geometryEpsilon ||
      u < -T.geometryEpsilon || u > 1 + T.geometryEpsilon
    ) return { kind: "none" };
    return { kind: "point", point: addScaled(left.start, r, t) };
  }
  if (Math.abs(cross(offset, r)) > T.geometryEpsilon) return { kind: "none" };

  const leftLength = Math.hypot(r.x, r.y);
  if (leftLength <= T.geometryEpsilon) return { kind: "none" };
  const useX = Math.abs(r.x) >= Math.abs(r.y);
  const denominatorAxis = useX ? r.x : r.y;
  const rightStartT = ((useX ? right.start.x : right.start.y) - (useX ? left.start.x : left.start.y)) / denominatorAxis;
  const rightEndT = ((useX ? right.end.x : right.end.y) - (useX ? left.start.x : left.start.y)) / denominatorAxis;
  const overlapStart = Math.max(0, Math.min(rightStartT, rightEndT));
  const overlapEnd = Math.min(1, Math.max(rightStartT, rightEndT));
  if (overlapEnd < overlapStart - T.geometryEpsilon) return { kind: "none" };
  if ((overlapEnd - overlapStart) * leftLength <= T.geometryEpsilon) {
    return { kind: "point", point: addScaled(left.start, r, overlapStart) };
  }
  return {
    kind: "overlap",
    start: addScaled(left.start, r, overlapStart),
    end: addScaled(left.start, r, overlapEnd),
    length: (overlapEnd - overlapStart) * leftLength,
  };
}

function polygonSegments(polygon: readonly Point[]): Segment[] {
  return polygon.map((start, index) => ({
    start,
    end: polygon[(index + 1) % polygon.length],
    index,
  }));
}

function pointInConvexPolygon(point: Point, polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false;
  let sign = 0;
  for (const edge of polygonSegments(polygon)) {
    const value = cross(subtract(edge.end, edge.start), subtract(point, edge.start));
    if (Math.abs(value) <= T.geometryEpsilon) continue;
    const nextSign = Math.sign(value);
    if (sign && nextSign !== sign) return false;
    sign = nextSign;
  }
  return true;
}

function pointSegmentDistance(point: Point, segment: Segment): number {
  const vector = subtract(segment.end, segment.start);
  const lengthSquared = vector.x * vector.x + vector.y * vector.y;
  if (lengthSquared <= T.geometryEpsilon * T.geometryEpsilon) return distance(point, segment.start);
  const offset = subtract(point, segment.start);
  const scale = Math.max(0, Math.min(1, (offset.x * vector.x + offset.y * vector.y) / lengthSquared));
  return distance(point, addScaled(segment.start, vector, scale));
}

function polygonGap(left: readonly Point[], right: readonly Point[]): number {
  const leftEdges = polygonSegments(left);
  const rightEdges = polygonSegments(right);
  if (
    leftEdges.some((leftEdge) => rightEdges.some((rightEdge) => segmentRelation(leftEdge, rightEdge).kind !== "none")) ||
    pointInConvexPolygon(left[0], right) ||
    pointInConvexPolygon(right[0], left)
  ) return 0;
  return Math.min(
    ...left.flatMap((point) => rightEdges.map((edge) => pointSegmentDistance(point, edge))),
    ...right.flatMap((point) => leftEdges.map((edge) => pointSegmentDistance(point, edge))),
  );
}

function segmentIntersectsPolygon(segment: Segment, polygon: readonly Point[]): boolean {
  return pointInConvexPolygon(segment.start, polygon) ||
    pointInConvexPolygon(segment.end, polygon) ||
    polygonSegments(polygon).some((edge) => segmentRelation(segment, edge).kind !== "none");
}

type ConnectorTerminal = {
  objectId: string | null;
};

function terminalsAt(
  connector: ConnectorObject,
  route: ResolvedConnectorRoute,
  point: Point,
): ConnectorTerminal[] {
  const result: ConnectorTerminal[] = [];
  if (distance(route.points[0], point) <= T.geometryEpsilon) {
    result.push({ objectId: connector.start.objectId });
  }
  if (distance(route.points[route.points.length - 1], point) <= T.geometryEpsilon) {
    result.push({ objectId: connector.end.objectId });
  }
  return result;
}

/**
 * A coincident route endpoint is intentional only when both connectors really
 * terminate there and either bind to the same semantic object or are both free.
 * One endpoint touching the other connector's interior is a T-junction and must
 * remain visible to the quality report.
 */
function legitimateSharedTerminal(
  leftConnector: ConnectorObject,
  leftRoute: ResolvedConnectorRoute,
  rightConnector: ConnectorObject,
  rightRoute: ResolvedConnectorRoute,
  point: Point,
): boolean {
  const leftTerminals = terminalsAt(leftConnector, leftRoute, point);
  const rightTerminals = terminalsAt(rightConnector, rightRoute, point);
  return leftTerminals.some((left) => rightTerminals.some((right) =>
    (left.objectId === null && right.objectId === null) ||
    (left.objectId !== null && left.objectId === right.objectId),
  ));
}

function routePairGeometry(
  leftConnector: ConnectorObject,
  left: ResolvedConnectorRoute,
  rightConnector: ConnectorObject,
  right: ResolvedConnectorRoute,
): { crossing: Point | null; overlap: Extract<SegmentRelation, { kind: "overlap" }> | null } {
  let crossing: Point | null = null;
  let overlap: Extract<SegmentRelation, { kind: "overlap" }> | null = null;
  for (const leftSegment of segments(left.points)) {
    for (const rightSegment of segments(right.points)) {
      const relation = segmentRelation(leftSegment, rightSegment);
      if (
        relation.kind === "overlap" &&
        relation.length >= T.connectorSharedSegmentMinimumLength &&
        (!overlap || relation.length > overlap.length)
      ) overlap = relation;
      if (
        relation.kind === "point" &&
        !legitimateSharedTerminal(leftConnector, left, rightConnector, right, relation.point) &&
        !crossing
      ) crossing = relation.point;
    }
  }
  return { crossing, overlap };
}

function connectorObject(object: CanvasObject | undefined): object is ConnectorObject {
  return object?.kind === "connector";
}

function intentionalGroupedOverlap(left: CanvasObject, right: CanvasObject): boolean {
  return left.groupId !== null && left.groupId === right.groupId;
}

const SEMANTIC_CONTAINER_ROLE_TOKENS = new Set([
  "background",
  "boundary",
  "container",
  "region",
  "zone",
]);

function isExplicitSemanticContainer(object: CanvasObject): boolean {
  if (object.kind !== "shape" || !object.semanticRole) return false;
  return object.semanticRole
    .toLocaleLowerCase()
    .split(/[.:/_-]+/)
    .some((token) => SEMANTIC_CONTAINER_ROLE_TOKENS.has(token));
}

function paintsBefore(background: CanvasObject, foreground: CanvasObject): boolean {
  return background.zIndex < foreground.zIndex ||
    (background.zIndex === foreground.zIndex && background.id.localeCompare(foreground.id) < 0);
}

function intentionalSemanticContainment(
  left: CanvasObject,
  leftGeometry: MemberGeometry,
  right: CanvasObject,
  rightGeometry: MemberGeometry,
): boolean {
  const leftContainsRight = isExplicitSemanticContainer(left) &&
    paintsBefore(left, right) &&
    rightGeometry.polygon.every((point) => pointInConvexPolygon(point, leftGeometry.polygon));
  const rightContainsLeft = isExplicitSemanticContainer(right) &&
    paintsBefore(right, left) &&
    leftGeometry.polygon.every((point) => pointInConvexPolygon(point, rightGeometry.polygon));
  return leftContainsRight || rightContainsLeft;
}

function connectorUsesSemanticContainer(
  connector: ConnectorObject,
  container: CanvasObject,
  containerGeometry: MemberGeometry,
  room: QualityRoom,
  memberGeometry: ReadonlyMap<string, MemberGeometry>,
): boolean {
  if (!isExplicitSemanticContainer(container)) return false;
  return [connector.start.objectId, connector.end.objectId].some((objectId) => {
    if (!objectId || objectId === container.id) return false;
    const endpoint = room.objects[objectId];
    const endpointGeometry = memberGeometry.get(objectId);
    return Boolean(endpoint && endpointGeometry) && endpointGeometry!.polygon.every(
      (point) => pointInConvexPolygon(point, containerGeometry.polygon),
    );
  });
}

function endpointObjectIds(connector: ConnectorObject): Set<string> {
  return new Set([connector.start.objectId, connector.end.objectId].filter((id): id is string => Boolean(id)));
}

function finding(input: DiagramVisualQualityFinding): DiagramVisualQualityFinding {
  const objectIds = [...new Set(input.objectIds)].sort();
  const connectorIds = [...new Set(input.connectorIds)].sort();
  const returnedObjectIds = objectIds.slice(0, DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedObjectIdsPerFinding);
  const returnedConnectorIds = connectorIds.slice(0, DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedConnectorIdsPerFinding);
  const omittedObjectIdCount = objectIds.length - returnedObjectIds.length;
  const omittedConnectorIdCount = connectorIds.length - returnedConnectorIds.length;
  const details = omittedObjectIdCount || omittedConnectorIdCount
    ? {
        ...input.details,
        ...(omittedObjectIdCount
          ? { objectReferenceCount: objectIds.length, omittedObjectReferenceCount: omittedObjectIdCount }
          : {}),
        ...(omittedConnectorIdCount
          ? { connectorReferenceCount: connectorIds.length, omittedConnectorReferenceCount: omittedConnectorIdCount }
          : {}),
      }
    : input.details;
  return {
    ...input,
    objectIds: returnedObjectIds,
    connectorIds: returnedConnectorIds,
    ...(details ? { details } : {}),
    ...(input.bounds ? { bounds: roundedBounds(input.bounds) } : {}),
  };
}

function compareFindings(left: DiagramVisualQualityFinding, right: DiagramVisualQualityFinding): number {
  const statusDelta = (left.status === "fail" ? 0 : 1) - (right.status === "fail" ? 0 : 1);
  return statusDelta ||
    left.code.localeCompare(right.code) ||
    left.objectIds.join("\u0000").localeCompare(right.objectIds.join("\u0000")) ||
    left.connectorIds.join("\u0000").localeCompare(right.connectorIds.join("\u0000")) ||
    (left.bounds?.x ?? 0) - (right.bounds?.x ?? 0) ||
    (left.bounds?.y ?? 0) - (right.bounds?.y ?? 0);
}

class BoundedFindingCollector {
  readonly items: DiagramVisualQualityFinding[] = [];
  readonly findingsByCode: Partial<Record<DiagramVisualQualityFindingCode, number>> = {};
  private readonly retainedByCode: Partial<Record<DiagramVisualQualityFindingCode, number>> = {};
  failCount = 0;
  warningCount = 0;

  push(item: DiagramVisualQualityFinding): number {
    this.findingsByCode[item.code] = (this.findingsByCode[item.code] ?? 0) + 1;
    if (item.status === "fail") this.failCount += 1;
    else this.warningCount += 1;
    const retainedForCode = this.retainedByCode[item.code] ?? 0;
    if (
      this.items.length < DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedFindings &&
      retainedForCode < DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedFindingsPerCode
    ) {
      this.items.push(item);
      this.retainedByCode[item.code] = retainedForCode + 1;
    }
    return this.findingCount;
  }

  get findingCount(): number {
    return this.failCount + this.warningCount;
  }
}

function portSide(use: RouteEndpointUse, object: CanvasObject, connector: ConnectorObject): ConnectorPortSide {
  const endpoint = connector.start.objectId === object.id ? connector.start : connector.end;
  if (endpoint.normalizedAnchor) return connectorPortSide(endpoint.normalizedAnchor);
  const center = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  const dx = use.point.x - center.x;
  const dy = use.point.y - center.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function endpointUses(
  connectors: readonly ConnectorObject[],
  routes: Readonly<Record<string, ResolvedConnectorRoute>>,
): RouteEndpointUse[] {
  const uses: RouteEndpointUse[] = [];
  for (const connector of connectors) {
    const route = routes[connector.id];
    if (!route) continue;
    if (connector.start.objectId) {
      uses.push({
        connectorId: connector.id,
        objectId: connector.start.objectId,
        point: route.points[0],
        outward: route.points.length > 1
          ? { start: route.points[0], end: route.points[1], index: 0 }
          : null,
      });
    }
    if (connector.end.objectId) {
      uses.push({
        connectorId: connector.id,
        objectId: connector.end.objectId,
        point: route.points[route.points.length - 1],
        outward: route.points.length > 1
          ? { start: route.points[route.points.length - 1], end: route.points[route.points.length - 2], index: 0 }
          : null,
      });
    }
  }
  return uses.sort((left, right) =>
    left.objectId.localeCompare(right.objectId) || left.connectorId.localeCompare(right.connectorId),
  );
}

function connectedPortClusters(uses: readonly RouteEndpointUse[]): RouteEndpointUse[][] {
  const remaining = new Set(uses.map((_, index) => index));
  const clusters: RouteEndpointUse[][] = [];
  while (remaining.size) {
    const seed = Math.min(...remaining);
    remaining.delete(seed);
    const indexes = [seed];
    for (let cursor = 0; cursor < indexes.length; cursor += 1) {
      const current = uses[indexes[cursor]];
      for (const candidateIndex of [...remaining].sort((a, b) => a - b)) {
        if (distance(current.point, uses[candidateIndex].point) <= T.attachmentPortRadius) {
          remaining.delete(candidateIndex);
          indexes.push(candidateIndex);
        }
      }
    }
    clusters.push(indexes.map((index) => uses[index]));
  }
  return clusters;
}

function reportSummary(
  status: DiagramVisualQualityStatus,
  failCount: number,
  warningCount: number,
  omittedFindingCount: number,
  unsupportedDrawObjectCount: number,
  unsupportedPathObjectCount: number,
): string {
  const truncation = omittedFindingCount
    ? ` ${omittedFindingCount} additional finding${omittedFindingCount === 1 ? " was" : "s were"} summarized in metrics; fix the returned representatives and rerun.`
    : "";
  const unsupportedCount = unsupportedDrawObjectCount + unsupportedPathObjectCount;
  const coverage = unsupportedCount
    ? ` Deterministic geometry coverage is partial: ${unsupportedCount} freehand drawing or native vector path member${unsupportedCount === 1 ? " is" : "s are"} excluded from relationship checks. Report status applies only to supported geometry; inspect the exact preview pixels for those objects.`
    : "";
  if (status === "pass") {
    return unsupportedCount
      ? `Supported deterministic geometry has no findings.${coverage}`
      : "Conventional diagram geometry has no deterministic findings; composition intent and pixels still require agent judgment.";
  }
  if (status === "fail") {
    return `Conventional diagram geometry has ${failCount} blocking finding${failCount === 1 ? "" : "s"} and ${warningCount} warning${warningCount === 1 ? "" : "s"}; compare them with the requested composition and correct only unintended overlaps, intrusions, or label collisions before visual sign-off.${truncation}${coverage}`;
  }
  return `Conventional diagram geometry has ${warningCount} warning${warningCount === 1 ? "" : "s"}; compare spacing, routing, and label fit with the requested composition before deciding whether to edit.${truncation}${coverage}`;
}

/**
 * Analyze the authoritative persisted geometry of one Diagram without mutating
 * RoomState or asking the routing solver to choose a different path.
 *
 * Throws when `diagramId` is not an authoritative diagram in `room`; callers
 * should treat that as input validation rather than a visual-quality result.
 */
export function analyzeDiagramVisualQuality(
  room: QualityRoom,
  diagramId: string,
): DiagramVisualQualityReport {
  const diagram: Diagram | undefined = room.diagrams[diagramId];
  if (!diagram) throw new Error(`Diagram not found: ${diagramId}`);

  const members = [...new Set(diagram.memberObjectIds)]
    .map((id) => room.objects[id])
    .filter((object): object is CanvasObject => Boolean(object) && object.kind !== "connector")
    .sort((left, right) => left.id.localeCompare(right.id));
  const unsupportedDrawObjectIds = members
    .filter((object) => object.kind === "draw")
    .map((object) => object.id);
  const unsupportedPathObjectIds = members
    .filter((object) => object.kind === "path")
    .map((object) => object.id);
  const unsupportedObjectIds = [...unsupportedDrawObjectIds, ...unsupportedPathObjectIds].sort();
  const returnedUnsupportedDrawObjectIds = unsupportedDrawObjectIds.slice(
    0,
    DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedUnsupportedDrawObjectIds,
  );
  const connectors = [...new Set(diagram.connectorIds)]
    .map((id) => room.objects[id])
    .filter(connectorObject)
    .sort((left, right) => left.id.localeCompare(right.id));
  const memberGeometry = new Map(members.flatMap((object): Array<[string, MemberGeometry]> => {
    const polygon = objectPolygon(object);
    return polygon.length
      ? [[object.id, { polygon, bounds: polygonBounds(polygon) }]]
      : [];
  }));
  const routes = Object.fromEntries(
    connectors.map((connector) => [connector.id, materializeConnectorRoute(connector, room)]),
  );
  const findings = new BoundedFindingCollector();
  let minimumMemberSpacing = Number.POSITIVE_INFINITY;

  if (!members.length) {
    findings.push(finding({
      code: "DIAGRAM_EMPTY",
      status: "fail",
      summary: `Add at least one semantic member object to ${diagram.id} before visual sign-off.`,
      objectIds: [],
      connectorIds: connectors.map((connector) => connector.id),
      details: { declaredMemberCount: diagram.memberObjectIds.length },
    }));
  }

  for (let leftIndex = 0; leftIndex < members.length; leftIndex += 1) {
    const left = members[leftIndex];
    const leftGeometry = memberGeometry.get(left.id);
    if (!leftGeometry) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < members.length; rightIndex += 1) {
      const right = members[rightIndex];
      const rightGeometry = memberGeometry.get(right.id);
      if (!rightGeometry) continue;
      const overlap = polygonOverlap(leftGeometry.polygon, rightGeometry.polygon);
      const gap = overlap ? 0 : polygonGap(leftGeometry.polygon, rightGeometry.polygon);
      if (
        intentionalGroupedOverlap(left, right) ||
        intentionalSemanticContainment(left, leftGeometry, right, rightGeometry)
      ) continue;
      minimumMemberSpacing = Math.min(minimumMemberSpacing, gap);
      if (overlap && overlap.area >= T.objectOverlapMinimumArea) {
        findings.push(finding({
          code: "MEMBER_OBJECT_OVERLAP",
          status: "fail",
          summary: `If this overlap is unintended, move or resize ${left.id} and ${right.id} so their member bounds no longer overlap.`,
          objectIds: [left.id, right.id],
          connectorIds: [],
          bounds: overlap.bounds,
          details: { overlapArea: round(overlap.area) },
        }));
      } else if (!overlap && gap < T.minimumMemberSpacing) {
        findings.push(finding({
          code: "MEMBER_SPACING_TOO_SMALL",
          status: "warning",
          summary: `If conventional separation is intended, increase the gap between ${left.id} and ${right.id} to at least ${T.minimumMemberSpacing}px.`,
          objectIds: [left.id, right.id],
          connectorIds: [],
          bounds: unionBounds([leftGeometry.bounds, rightGeometry.bounds]),
          details: { actualGap: round(gap), minimumGap: T.minimumMemberSpacing },
        }));
      }
    }
  }

  for (const connector of connectors) {
    const route = routes[connector.id];
    if (!route) continue;
    const endpoints = endpointObjectIds(connector);
    for (const member of members) {
      if (endpoints.has(member.id)) continue;
      const memberGeometryValue = memberGeometry.get(member.id);
      if (
        memberGeometryValue &&
        (isExplicitSemanticContainer(member) && paintsBefore(member, connector) ||
          connectorUsesSemanticContainer(connector, member, memberGeometryValue, room, memberGeometry))
      ) continue;
      const interior = objectPolygon(member, T.connectorIntrusionInset);
      if (!interior.length || !segments(route.points).some((segment) => segmentIntersectsPolygon(segment, interior))) continue;
      findings.push(finding({
        code: "CONNECTOR_OBJECT_INTRUSION",
        status: "fail",
        summary: `If this crossing-through is unintended, reroute ${connector.id} around unrelated member ${member.id}.`,
        objectIds: [member.id],
        connectorIds: [connector.id],
        bounds: memberGeometry.get(member.id)!.bounds,
        details: { intrusionInset: T.connectorIntrusionInset },
      }));
    }
  }

  for (let leftIndex = 0; leftIndex < connectors.length; leftIndex += 1) {
    const left = connectors[leftIndex];
    const leftRoute = routes[left.id];
    if (!leftRoute) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < connectors.length; rightIndex += 1) {
      const right = connectors[rightIndex];
      const rightRoute = routes[right.id];
      if (!rightRoute) continue;
      const geometry = routePairGeometry(left, leftRoute, right, rightRoute);
      if (geometry.crossing) {
        findings.push(finding({
          code: "CONNECTOR_CROSSING",
          status: "warning",
          summary: `If this crossing is unintended, reroute ${left.id} and ${right.id} into separate lanes.`,
          objectIds: [],
          connectorIds: [left.id, right.id],
          bounds: pointBounds(geometry.crossing),
          details: { point: [round(geometry.crossing.x), round(geometry.crossing.y)] },
        }));
      }
      if (geometry.overlap) {
        findings.push(finding({
          code: "CONNECTOR_SHARED_SEGMENT",
          status: "warning",
          summary: `If this shared segment is unintended, separate ${left.id} and ${right.id} into distinct paths.`,
          objectIds: [],
          connectorIds: [left.id, right.id],
          bounds: unionBounds([pointBounds(geometry.overlap.start), pointBounds(geometry.overlap.end)]),
          details: { sharedLength: round(geometry.overlap.length) },
        }));
      }
    }
  }

  const labeled = connectors.filter((connector) => routes[connector.id]?.labelBounds);
  for (const connector of labeled) {
    const labelBounds = routes[connector.id].labelBounds!;
    for (const member of members) {
      const geometry = memberGeometry.get(member.id);
      if (!geometry) continue;
      if (
        isExplicitSemanticContainer(member) && paintsBefore(member, connector) ||
        connectorUsesSemanticContainer(connector, member, geometry, room, memberGeometry)
      ) continue;
      const overlap = polygonOverlap(boundsPolygon(labelBounds), geometry.polygon);
      if (!overlap) continue;
      findings.push(finding({
        code: "CONNECTOR_LABEL_OBJECT_COLLISION",
        status: "fail",
        summary: `If this occlusion is unintended, move the label for ${connector.id} or reroute it away from ${member.id}.`,
        objectIds: [member.id],
        connectorIds: [connector.id],
        bounds: overlap.bounds,
      }));
    }
    for (const other of connectors) {
      if (other.id === connector.id) continue;
      const otherRoute = routes[other.id];
      if (!otherRoute || !segments(otherRoute.points).some((segment) => segmentIntersectsBounds(segment, labelBounds))) continue;
      findings.push(finding({
        code: "CONNECTOR_LABEL_EDGE_COLLISION",
        status: "warning",
        summary: `If this overlap is unintended, move the label for ${connector.id} away from unrelated edge ${other.id}.`,
        objectIds: [],
        connectorIds: [connector.id, other.id],
        bounds: labelBounds,
        details: { labelConnectorId: connector.id, edgeConnectorId: other.id },
      }));
    }
  }
  for (let leftIndex = 0; leftIndex < labeled.length; leftIndex += 1) {
    const left = labeled[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < labeled.length; rightIndex += 1) {
      const right = labeled[rightIndex];
      const overlap = intersectionBounds(routes[left.id].labelBounds!, routes[right.id].labelBounds!);
      if (!overlap) continue;
      findings.push(finding({
        code: "CONNECTOR_LABEL_LABEL_COLLISION",
        status: "fail",
        summary: `If both labels should be independently readable, separate those for ${left.id} and ${right.id}.`,
        objectIds: [],
        connectorIds: [left.id, right.id],
        bounds: overlap,
      }));
    }
  }

  const uses = endpointUses(connectors, routes);
  for (const member of members) {
    const memberUses = uses.filter((use) => use.objectId === member.id);
    const connectorById = new Map(connectors.map((connector) => [connector.id, connector]));
    for (const cluster of connectedPortClusters(memberUses)) {
      const distinctConnectorIds = [...new Set(cluster.map((use) => use.connectorId))].sort();
      if (distinctConnectorIds.length < T.attachmentPortMinimumConnectors) continue;
      const sides = [...new Set(cluster.map((use) => portSide(use, member, connectorById.get(use.connectorId)!)))].sort();
      findings.push(finding({
        code: "ATTACHMENT_PORT_CONGESTION",
        status: "warning",
        summary: `If the shared attachment is unintended, distribute these ${distinctConnectorIds.length} connectors across additional ports on ${member.id}.`,
        objectIds: [member.id],
        connectorIds: distinctConnectorIds,
        bounds: unionBounds(cluster.map((use) => pointBounds(use.point))),
        details: {
          connectorCount: distinctConnectorIds.length,
          portRadius: T.attachmentPortRadius,
          sides,
        },
      }));
    }
    for (let leftIndex = 0; leftIndex < memberUses.length; leftIndex += 1) {
      const left = memberUses[leftIndex];
      if (!left.outward) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < memberUses.length; rightIndex += 1) {
        const right = memberUses[rightIndex];
        if (!right.outward || left.connectorId === right.connectorId) continue;
        const relation = segmentRelation(left.outward, right.outward);
        if (relation.kind !== "overlap" || relation.length < T.sharedInitialCorridorMinimumLength) continue;
        findings.push(finding({
          code: "CONNECTOR_SHARED_INITIAL_CORRIDOR",
          status: "warning",
          summary: `If the shared corridor is unintended, fan ${left.connectorId} and ${right.connectorId} out from separate ports on ${member.id}.`,
          objectIds: [member.id],
          connectorIds: [left.connectorId, right.connectorId],
          bounds: unionBounds([pointBounds(relation.start), pointBounds(relation.end)]),
          details: { sharedLength: round(relation.length) },
        }));
      }
    }
  }

  for (const member of members) {
    if (member.kind === "shape" && member.label.trim()) {
      const maximumCharacters = semanticShapeLabelMaxCharacters(member.width);
      const maximumLines = semanticShapeLabelMaxLines(member.height);
      const textLayout = layoutSemanticText(member.label, maximumCharacters, maximumLines);
      if (textLayout.truncated) {
        findings.push(finding({
          code: "SHAPE_LABEL_LIKELY_TRUNCATED",
          status: "warning",
          summary: `If the full label should be visible, enlarge ${member.id} or shorten it to fit within ${maximumLines} line${maximumLines === 1 ? "" : "s"}.`,
          objectIds: [member.id],
          connectorIds: [],
          bounds: memberGeometry.get(member.id)!.bounds,
          details: {
            maximumCharactersPerLine: maximumCharacters,
            maximumLines,
            requiredLines: textLayout.requiredLineCount,
          },
        }));
      }
    }

    if (member.kind === "text" && member.content.trim()) {
      const fontSize = SEMANTIC_TEXT_FONT_SIZES[member.size];
      const maximumCharacters = semanticTextMaximumCharacters(member.width, fontSize);
      const maximumLines = semanticTextMaximumLines(member.height, fontSize);
      const textLayout = layoutSemanticText(
        member.content,
        maximumCharacters,
        maximumLines,
      );
      if (textLayout.truncated) {
        findings.push(finding({
          code: "TEXT_CONTENT_LIKELY_TRUNCATED",
          status: "warning",
          summary: `If the full text should be visible, resize ${member.id} or shorten it to fit within ${maximumLines} rendered line${maximumLines === 1 ? "" : "s"}.`,
          objectIds: [member.id],
          connectorIds: [],
          bounds: memberGeometry.get(member.id)!.bounds,
          details: {
            maximumCharactersPerLine: maximumCharacters,
            maximumLines,
            requiredLines: textLayout.requiredLineCount,
          },
        }));
      }
    }
  }

  for (const connector of connectors) {
    if (!connector.label.trim()) continue;
    const labelBounds = routes[connector.id]?.labelBounds;
    if (!labelBounds) continue;
    const maximumCharacters = semanticConnectorLabelMaximumCharacters(labelBounds.width);
    const textLayout = layoutSemanticText(
      connector.label,
      maximumCharacters,
      SEMANTIC_CONNECTOR_LABEL_MAX_LINES,
    );
    if (!textLayout.truncated) continue;
    findings.push(finding({
      code: "CONNECTOR_LABEL_LIKELY_TRUNCATED",
      status: "warning",
      summary: `If the full relationship label should be visible, shorten ${connector.id} or split it to fit within ${SEMANTIC_CONNECTOR_LABEL_MAX_LINES} rendered lines.`,
      objectIds: [],
      connectorIds: [connector.id],
      bounds: labelBounds,
      details: {
        maximumCharactersPerLine: maximumCharacters,
        maximumLines: SEMANTIC_CONNECTOR_LABEL_MAX_LINES,
        requiredLines: textLayout.requiredLineCount,
      },
    }));
  }

  const returnedFindings = [...findings.items].sort(compareFindings);
  const failCount = findings.failCount;
  const warningCount = findings.warningCount;
  const status: DiagramVisualQualityStatus = failCount ? "fail" : warningCount ? "warning" : "pass";
  const findingsByCode = findings.findingsByCode;
  const omittedFindingCount = findings.findingCount - returnedFindings.length;

  return {
    schemaVersion: 1,
    diagramId: diagram.id,
    diagramRevision: diagram.revision,
    roomRevision: room.roomRevision,
    status,
    summary: reportSummary(
      status,
      failCount,
      warningCount,
      omittedFindingCount,
      unsupportedDrawObjectIds.length,
      unsupportedPathObjectIds.length,
    ),
    geometryCoverage: {
      status: unsupportedObjectIds.length ? "partial" : "complete",
      analyzedMemberObjectCount: members.length - unsupportedObjectIds.length,
      unsupportedDrawObjectCount: unsupportedDrawObjectIds.length,
      unsupportedDrawObjectIds: returnedUnsupportedDrawObjectIds,
      omittedUnsupportedDrawObjectIdCount:
        unsupportedDrawObjectIds.length - returnedUnsupportedDrawObjectIds.length,
      unsupportedDrawObjectIdsTruncated:
        returnedUnsupportedDrawObjectIds.length < unsupportedDrawObjectIds.length,
      unsupportedPathObjectCount: unsupportedPathObjectIds.length,
      unsupportedPathObjectIds: unsupportedPathObjectIds.slice(
        0,
        DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedUnsupportedDrawObjectIds,
      ),
      omittedUnsupportedPathObjectIdCount: Math.max(
        0,
        unsupportedPathObjectIds.length - DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedUnsupportedDrawObjectIds,
      ),
      unsupportedPathObjectIdsTruncated:
        unsupportedPathObjectIds.length > DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedUnsupportedDrawObjectIds,
    },
    findings: returnedFindings,
    metrics: {
      memberObjectCount: members.length,
      unsupportedDrawMemberCount: unsupportedDrawObjectIds.length,
      unsupportedPathMemberCount: unsupportedPathObjectIds.length,
      connectorCount: connectors.length,
      findingCount: findings.findingCount,
      returnedFindingCount: returnedFindings.length,
      omittedFindingCount,
      findingsTruncated: omittedFindingCount > 0,
      failCount,
      warningCount,
      minimumMemberSpacing: Number.isFinite(minimumMemberSpacing) ? round(minimumMemberSpacing) : null,
      crossingPairCount: findingsByCode.CONNECTOR_CROSSING ?? 0,
      sharedSegmentPairCount: findingsByCode.CONNECTOR_SHARED_SEGMENT ?? 0,
      congestedPortCount: findingsByCode.ATTACHMENT_PORT_CONGESTION ?? 0,
      truncatedConnectorLabelCount: findingsByCode.CONNECTOR_LABEL_LIKELY_TRUNCATED ?? 0,
      truncatedShapeLabelCount: findingsByCode.SHAPE_LABEL_LIKELY_TRUNCATED ?? 0,
      truncatedTextContentCount: findingsByCode.TEXT_CONTENT_LIKELY_TRUNCATED ?? 0,
      findingsByCode,
    },
  };
}
