import { connectorLabelMetrics } from "./layout";
import type {
  CanvasBounds,
  CanvasObject,
  ConnectorEndpoint,
  ConnectorEndpointSnap,
  ConnectorObject,
  ConnectorRouting,
  ConnectorRoutingInput,
  ConnectorRoutingKind,
  Point,
  RoomState,
} from "./types";

export const CONNECTOR_ROUTING_LIMITS = {
  maxBend: 10_000,
  minCurvedBend: 8,
  maxCandidates: 96,
  maxRoutePoints: 32,
  obstaclePadding: 16,
  laneSpacing: 24,
  elbowLegLength: 36,
  portLaneStep: 0.08,
  routeBoundsPadding: 2,
} as const;

/**
 * Crossing-aware quality scoring is quadratic in the number of routes. Above
 * this structural threshold, the default batch solver retains deterministic
 * ports and obstacle checks but uses a first-clear, crossing-neutral search.
 */
export const CONNECTOR_ROUTING_QUALITY_BATCH_LIMIT = 128;
export const CONNECTOR_ROUTING_BOUNDED_MAX_CANDIDATES = 16;

export const LEGACY_CONNECTOR_ROUTING: ConnectorRouting = {
  mode: "straight",
  kind: "straight",
  bend: 0,
  elbowMidPoint: 0.5,
  labelPosition: 0.5,
};

export type ConnectorPortSide = "top" | "right" | "bottom" | "left";

export type ConnectorRouteArc = {
  center: Point;
  radius: number;
  startAngle: number;
  sweepAngle: number;
};

export type ResolvedConnectorRoute = {
  connectorId: string;
  routing: ConnectorRouting;
  start: ConnectorEndpoint;
  end: ConnectorEndpoint;
  /** Deterministically bounded route samples; elbow vertices are retained exactly. */
  points: Point[];
  arc: ConnectorRouteArc | null;
  labelPoint: Point;
  pathLength: number;
  pathBounds: CanvasBounds;
  labelBounds: CanvasBounds | null;
  /** Union of pathBounds and labelBounds. */
  bounds: CanvasBounds;
  collisionObjectIds: string[];
  crossingCount: number;
  laneIndex: number;
  candidateCount: number;
};

export type ConnectorRoutingOptions = {
  obstaclePadding?: number;
  laneSpacing?: number;
  maxCandidates?: number;
  maxRoutePoints?: number;
  /** Bounded deterministic fallback for large authoritative mutation batches. */
  resolutionMode?: "quality" | "bounded";
};

type RoutingRoom = Pick<RoomState, "objects" | "diagrams">;

type RoutingObstacle = {
  id: string;
  bounds: CanvasBounds;
};

type NormalizedRoutingOptions = Required<ConnectorRoutingOptions>;

export type ConnectorRoutingContext = {
  room: RoutingRoom;
  options: NormalizedRoutingOptions;
  obstacles: readonly RoutingObstacle[];
  obstacleIdsByConnector: ReadonlyMap<string, ReadonlySet<string>>;
  laneIndexByConnector: ReadonlyMap<string, number>;
  laneDirectionByConnector: ReadonlyMap<string, 1 | -1>;
};

type Candidate = {
  ordinal: number;
  kind: ConnectorRoutingKind;
  bend: number;
  elbowMidPoint: number;
  start: ConnectorEndpoint;
  end: ConnectorEndpoint;
  points: Point[];
  arc: ConnectorRouteArc | null;
  pathLength: number;
  collisionObjectIds: string[];
  crossingCount: number;
};

const SIDES: readonly ConnectorPortSide[] = ["right", "bottom", "left", "top"];
const ELBOW_MIDPOINTS = [0.5, 0.35, 0.65, 0.2, 0.8] as const;
const DEFAULT_CURVE_BEND = 40;
const EPSILON = 0.001;
const TWO_PI = Math.PI * 2;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function validKind(value: unknown): value is ConnectorRoutingKind {
  return value === "straight" || value === "curved" || value === "elbow";
}

/**
 * Canonicalize routing without consulting canvas geometry. Missing persisted
 * state is deliberately straight for backward compatibility; callers that
 * want obstacle-aware routing must explicitly request mode `auto`.
 */
export function normalizeConnectorRouting(
  input?: ConnectorRoutingInput | ConnectorRouting | null,
): ConnectorRouting {
  if (!input) return { ...LEGACY_CONNECTOR_ROUTING };

  const mode = input.mode;
  const requestedKind = "kind" in input && validKind(input.kind) ? input.kind : null;
  const kind: ConnectorRoutingKind =
    mode === "auto" ? (requestedKind ?? "straight") : mode;
  let bend = clamp(
    finiteOr(input.bend, mode === "curved" || kind === "curved" ? DEFAULT_CURVE_BEND : 0),
    -CONNECTOR_ROUTING_LIMITS.maxBend,
    CONNECTOR_ROUTING_LIMITS.maxBend,
  );
  if (kind !== "curved") bend = 0;
  else if (Math.abs(bend) < CONNECTOR_ROUTING_LIMITS.minCurvedBend) {
    bend = (bend < 0 ? -1 : 1) * CONNECTOR_ROUTING_LIMITS.minCurvedBend;
  }

  return {
    mode,
    kind,
    bend,
    elbowMidPoint: clamp(finiteOr(input.elbowMidPoint, 0.5), 0, 1),
    labelPosition: clamp(finiteOr(input.labelPosition, 0.5), 0, 1),
  };
}

/** Position runs left-to-right on horizontal sides and top-to-bottom on vertical sides. */
export function cardinalNormalizedAnchor(
  side: ConnectorPortSide,
  position: number = 0.5,
): Point {
  const along = clamp(finiteOr(position, 0.5), 0, 1);
  if (side === "top") return { x: along, y: 0 };
  if (side === "right") return { x: 1, y: along };
  if (side === "bottom") return { x: along, y: 1 };
  return { x: 0, y: along };
}

export function connectorPortSide(anchor: Point): ConnectorPortSide {
  const distances = [
    { side: "right" as const, distance: Math.abs(1 - anchor.x) },
    { side: "bottom" as const, distance: Math.abs(1 - anchor.y) },
    { side: "left" as const, distance: Math.abs(anchor.x) },
    { side: "top" as const, distance: Math.abs(anchor.y) },
  ];
  distances.sort((left, right) => left.distance - right.distance || SIDES.indexOf(left.side) - SIDES.indexOf(right.side));
  return distances[0].side;
}

function normalizedOptions(options: ConnectorRoutingOptions = {}): NormalizedRoutingOptions {
  return {
    obstaclePadding: clamp(
      finiteOr(options.obstaclePadding, CONNECTOR_ROUTING_LIMITS.obstaclePadding),
      0,
      512,
    ),
    laneSpacing: clamp(finiteOr(options.laneSpacing, CONNECTOR_ROUTING_LIMITS.laneSpacing), 8, 256),
    maxCandidates: Math.floor(
      clamp(finiteOr(options.maxCandidates, CONNECTOR_ROUTING_LIMITS.maxCandidates), 1, 256),
    ),
    maxRoutePoints: Math.floor(
      clamp(finiteOr(options.maxRoutePoints, CONNECTOR_ROUTING_LIMITS.maxRoutePoints), 8, 64),
    ),
    resolutionMode: options.resolutionMode ?? "quality",
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

function objectCenter(object: CanvasObject): Point {
  return { x: object.x + object.width / 2, y: object.y + object.height / 2 };
}

function objectBounds(object: CanvasObject): CanvasBounds {
  const center = objectCenter(object);
  const corners = [
    { x: object.x, y: object.y },
    { x: object.x + object.width, y: object.y },
    { x: object.x + object.width, y: object.y + object.height },
    { x: object.x, y: object.y + object.height },
  ].map((point) => rotateAround(point, center, object.rotation));
  const minX = Math.min(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y));
  const maxX = Math.max(...corners.map((point) => point.x));
  const maxY = Math.max(...corners.map((point) => point.y));
  return { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

function endpointKey(endpoint: ConnectorEndpoint): string {
  if (endpoint.objectId) return `object:${endpoint.objectId}`;
  const x = Math.round(endpoint.x * 1_000) / 1_000;
  const y = Math.round(endpoint.y * 1_000) / 1_000;
  return `point:${x},${y}`;
}

function pairKey(connector: ConnectorObject): { key: string; direction: 1 | -1 } {
  const start = endpointKey(connector.start);
  const end = endpointKey(connector.end);
  return start <= end
    ? { key: `${start}\u0000${end}`, direction: 1 }
    : { key: `${end}\u0000${start}`, direction: -1 };
}

function symmetricLane(index: number): number {
  if (index === 0) return 0;
  const magnitude = Math.ceil(index / 2);
  return index % 2 === 1 ? magnitude : -magnitude;
}

function connectorLaneIndexes(connectors: readonly ConnectorObject[]): {
  laneIndexByConnector: Map<string, number>;
  laneDirectionByConnector: Map<string, 1 | -1>;
} {
  const lanes = new Map<string, ConnectorObject[]>();
  const laneDirectionByConnector = new Map<string, 1 | -1>();
  for (const connector of connectors) {
    const pair = pairKey(connector);
    const group = lanes.get(pair.key) ?? [];
    group.push(connector);
    lanes.set(pair.key, group);
    laneDirectionByConnector.set(connector.id, pair.direction);
  }
  const laneIndexByConnector = new Map<string, number>();
  for (const group of lanes.values()) {
    group.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    group.forEach((connector, index) => laneIndexByConnector.set(connector.id, symmetricLane(index)));
  }
  return { laneIndexByConnector, laneDirectionByConnector };
}

/** Build stable obstacle and parallel-lane indexes once for a batch resolution. */
export function createConnectorRoutingContext(
  room: RoutingRoom,
  options: ConnectorRoutingOptions = {},
  targetConnectorIds?: ReadonlySet<string>,
): ConnectorRoutingContext {
  const normalized = normalizedOptions(options);
  const obstacles = Object.values(room.objects)
    .filter((object) => object.kind === "shape")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((object) => ({ id: object.id, bounds: objectBounds(object) }));
  const allObstacleIds = new Set(obstacles.map((obstacle) => obstacle.id));
  const obstacleIdsByConnector = new Map<string, ReadonlySet<string>>();
  const diagrams = Object.values(room.diagrams ?? {}).sort((left, right) => left.id.localeCompare(right.id));
  for (const connector of Object.values(room.objects)) {
    if (connector.kind !== "connector") continue;
    if (targetConnectorIds && !targetConnectorIds.has(connector.id)) continue;
    const diagramObstacleIds = new Set<string>();
    let scoped = false;
    for (const diagram of diagrams) {
      if (!diagram.connectorIds.includes(connector.id)) continue;
      scoped = true;
      for (const objectId of diagram.memberObjectIds) {
        if (room.objects[objectId]?.kind === "shape") diagramObstacleIds.add(objectId);
      }
    }
    obstacleIdsByConnector.set(connector.id, scoped ? diagramObstacleIds : allObstacleIds);
  }

  const connectors = Object.values(room.objects).filter(
    (object): object is ConnectorObject => object.kind === "connector",
  );
  const { laneIndexByConnector, laneDirectionByConnector } = connectorLaneIndexes(connectors);

  return {
    room,
    options: normalized,
    obstacles,
    obstacleIdsByConnector,
    laneIndexByConnector,
    laneDirectionByConnector,
  };
}

function preferredSide(from: Point, toward: Point): ConnectorPortSide {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function sideDirection(side: ConnectorPortSide, rotation: number): Point {
  const local = {
    top: { x: 0, y: -1 },
    right: { x: 1, y: 0 },
    bottom: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
  }[side];
  if (!rotation) return local;
  return {
    x: local.x * Math.cos(rotation) - local.y * Math.sin(rotation),
    y: local.x * Math.sin(rotation) + local.y * Math.cos(rotation),
  };
}

function anchorForEndpoint(
  endpoint: ConnectorEndpoint,
  target: CanvasObject | undefined,
  side: ConnectorPortSide,
  lanePosition: number,
  options: {
    respectPrecise: boolean;
    persistPrecise: boolean;
  },
): ConnectorEndpoint {
  if (!target) return { x: endpoint.x, y: endpoint.y, objectId: null };
  const supplied = options.respectPrecise && endpoint.isPrecise && endpoint.normalizedAnchor
    ? { x: clamp(endpoint.normalizedAnchor.x, 0, 1), y: clamp(endpoint.normalizedAnchor.y, 0, 1) }
    : null;
  const normalizedAnchor = supplied ?? cardinalNormalizedAnchor(side, lanePosition);
  const localPoint = {
    x: target.x + target.width * normalizedAnchor.x,
    y: target.y + target.height * normalizedAnchor.y,
  };
  const point = rotateAround(localPoint, objectCenter(target), target.rotation);
  return {
    x: point.x,
    y: point.y,
    objectId: target.id,
    normalizedAnchor,
    isPrecise: supplied ? true : options.persistPrecise,
    isExact: endpoint.isExact ?? false,
    snap: endpoint.snap ?? "none",
  };
}

function endpointSideOptions(
  endpoint: ConnectorEndpoint,
  target: CanvasObject | undefined,
  fallbackSide: ConnectorPortSide,
  exhaustive: boolean,
  respectPrecise: boolean,
): readonly ConnectorPortSide[] {
  if (!target) return [fallbackSide];
  if (respectPrecise && endpoint.isPrecise && endpoint.normalizedAnchor) {
    return [connectorPortSide(endpoint.normalizedAnchor)];
  }
  return exhaustive ? SIDES : [fallbackSide];
}

function add(left: Point, right: Point): Point {
  return { x: left.x + right.x, y: left.y + right.y };
}

function multiply(point: Point, scalar: number): Point {
  return { x: point.x * scalar, y: point.y * scalar };
}

function distance(left: Point, right: Point): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function samePoint(left: Point, right: Point): boolean {
  return distance(left, right) <= EPSILON;
}

function compactPoints(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const source of points) {
    const point = { x: source.x, y: source.y };
    if (result.length && samePoint(result[result.length - 1], point)) continue;
    while (result.length >= 2) {
      const before = result[result.length - 2];
      const current = result[result.length - 1];
      const cross = (current.x - before.x) * (point.y - current.y) -
        (current.y - before.y) * (point.x - current.x);
      if (Math.abs(cross) > EPSILON) break;
      const continuesForward =
        (current.x - before.x) * (point.x - current.x) +
        (current.y - before.y) * (point.y - current.y) >= 0;
      if (!continuesForward) break;
      result.pop();
    }
    result.push(point);
  }
  return result.length === 1 ? [result[0], { x: result[0].x + 1, y: result[0].y }] : result;
}

function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1], points[index]);
  return total;
}

function elbowPoints(input: {
  start: ConnectorEndpoint;
  end: ConnectorEndpoint;
  startSide: ConnectorPortSide;
  endSide: ConnectorPortSide;
  startRotation: number;
  endRotation: number;
  midpoint: number;
  legLength: number;
}): Point[] {
  const startDirection = sideDirection(input.startSide, input.startRotation);
  const endDirection = sideDirection(input.endSide, input.endRotation);
  const startOut = add(input.start, multiply(startDirection, input.legLength));
  const endOut = add(input.end, multiply(endDirection, input.legLength));
  const startHorizontal = Math.abs(startDirection.x) >= Math.abs(startDirection.y);
  const endHorizontal = Math.abs(endDirection.x) >= Math.abs(endDirection.y);
  const points: Point[] = [input.start, startOut];
  if (startHorizontal && endHorizontal) {
    const laneX = startOut.x + (endOut.x - startOut.x) * input.midpoint;
    points.push({ x: laneX, y: startOut.y }, { x: laneX, y: endOut.y });
  } else if (!startHorizontal && !endHorizontal) {
    const laneY = startOut.y + (endOut.y - startOut.y) * input.midpoint;
    points.push({ x: startOut.x, y: laneY }, { x: endOut.x, y: laneY });
  } else if (startHorizontal) {
    points.push({ x: endOut.x, y: startOut.y });
  } else {
    points.push({ x: startOut.x, y: endOut.y });
  }
  points.push(endOut, input.end);
  return compactPoints(points);
}

function normalizeAngle(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

function circumcenter(a: Point, b: Point, c: Point): Point | null {
  const denominator = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(denominator) <= EPSILON) return null;
  const aa = a.x * a.x + a.y * a.y;
  const bb = b.x * b.x + b.y * b.y;
  const cc = c.x * c.x + c.y * c.y;
  return {
    x: (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / denominator,
    y: (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / denominator,
  };
}

function curvedRoute(
  start: Point,
  end: Point,
  bend: number,
  maxRoutePoints: number,
): { points: Point[]; arc: ConnectorRouteArc | null } {
  const chordLength = distance(start, end);
  if (chordLength <= EPSILON || Math.abs(bend) < CONNECTOR_ROUTING_LIMITS.minCurvedBend) {
    return { points: compactPoints([start, end]), arc: null };
  }
  const unit = { x: (end.x - start.x) / chordLength, y: (end.y - start.y) / chordLength };
  const middle = {
    x: (start.x + end.x) / 2 - unit.y * bend,
    y: (start.y + end.y) / 2 + unit.x * bend,
  };
  const center = circumcenter(start, end, middle);
  if (!center) return { points: compactPoints([start, end]), arc: null };
  const radius = distance(center, start);
  if (!Number.isFinite(radius) || radius <= EPSILON) return { points: compactPoints([start, end]), arc: null };

  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const middleAngle = Math.atan2(middle.y - center.y, middle.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const counterClockwiseSweep = normalizeAngle(endAngle - startAngle);
  const middleCounterClockwise = normalizeAngle(middleAngle - startAngle);
  const sweepAngle = middleCounterClockwise <= counterClockwiseSweep + EPSILON
    ? counterClockwiseSweep
    : -(TWO_PI - counterClockwiseSweep);
  const estimatedLength = Math.abs(sweepAngle) * radius;
  const sampleCount = Math.floor(clamp(Math.ceil(estimatedLength / 24), 8, maxRoutePoints - 1));
  const points = Array.from({ length: sampleCount + 1 }, (_, index) => {
    const angle = startAngle + sweepAngle * (index / sampleCount);
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
  });
  points[0] = { ...start };
  points[points.length - 1] = { ...end };
  return { points, arc: { center, radius, startAngle, sweepAngle } };
}

function expandBounds(bounds: CanvasBounds, padding: number): CanvasBounds {
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}

function segmentIntersectsBounds(start: Point, end: Point, bounds: CanvasBounds): boolean {
  const minX = bounds.x;
  const minY = bounds.y;
  const maxX = bounds.x + bounds.width;
  const maxY = bounds.y + bounds.height;
  let minimum = 0;
  let maximum = 1;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  for (const [p, q] of [
    [-dx, start.x - minX],
    [dx, maxX - start.x],
    [-dy, start.y - minY],
    [dy, maxY - start.y],
  ] as const) {
    if (Math.abs(p) <= EPSILON) {
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

function boundsIntersect(left: CanvasBounds, right: CanvasBounds): boolean {
  return !(
    left.x + left.width < right.x ||
    right.x + right.width < left.x ||
    left.y + left.height < right.y ||
    right.y + right.height < left.y
  );
}

function collisionIds(
  connector: ConnectorObject,
  points: readonly Point[],
  labelBounds: CanvasBounds | null,
  context: ConnectorRoutingContext,
): string[] {
  const allowed = context.obstacleIdsByConnector.get(connector.id);
  const excluded = new Set([connector.start.objectId, connector.end.objectId].filter(Boolean));
  const collisions: string[] = [];
  const routeEnvelope = unionBounds(connectorRouteBounds(points, 0), labelBounds);
  for (const obstacle of context.obstacles) {
    if (excluded.has(obstacle.id) || (allowed && !allowed.has(obstacle.id))) continue;
    const expanded = expandBounds(obstacle.bounds, context.options.obstaclePadding);
    if (!boundsIntersect(routeEnvelope, expanded)) continue;
    const pathHit = points.slice(1).some((point, index) =>
      segmentIntersectsBounds(points[index], point, expanded),
    );
    if (pathHit || (labelBounds && boundsIntersect(labelBounds, expanded))) collisions.push(obstacle.id);
  }
  return collisions;
}

function orientation(left: Point, middle: Point, right: Point): number {
  const value = (middle.y - left.y) * (right.x - middle.x) -
    (middle.x - left.x) * (right.y - middle.y);
  if (Math.abs(value) <= EPSILON) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(left: Point, middle: Point, right: Point): boolean {
  return (
    middle.x <= Math.max(left.x, right.x) + EPSILON &&
    middle.x >= Math.min(left.x, right.x) - EPSILON &&
    middle.y <= Math.max(left.y, right.y) + EPSILON &&
    middle.y >= Math.min(left.y, right.y) - EPSILON
  );
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(a, c, b)) ||
    (o2 === 0 && onSegment(a, d, b)) ||
    (o3 === 0 && onSegment(c, a, d)) ||
    (o4 === 0 && onSegment(c, b, d))
  );
}

function crossingCount(
  connector: ConnectorObject,
  points: readonly Point[],
  resolvedRoutes: readonly ResolvedConnectorRoute[],
  room: RoutingRoom,
): number {
  let count = 0;
  const routeBounds = connectorRouteBounds(points, 0);
  for (const route of resolvedRoutes) {
    const other = room.objects[route.connectorId];
    if (!other || other.kind !== "connector") continue;
    const sharesEndpoint = [connector.start.objectId, connector.end.objectId].some(
      (id) => id && (id === other.start.objectId || id === other.end.objectId),
    );
    if (sharesEndpoint) continue;
    if (!boundsIntersect(routeBounds, route.pathBounds)) continue;
    let intersects = false;
    for (let leftIndex = 1; leftIndex < points.length && !intersects; leftIndex += 1) {
      for (let rightIndex = 1; rightIndex < route.points.length; rightIndex += 1) {
        if (segmentsIntersect(points[leftIndex - 1], points[leftIndex], route.points[rightIndex - 1], route.points[rightIndex])) {
          intersects = true;
          break;
        }
      }
    }
    if (intersects) count += 1;
  }
  return count;
}

export function connectorRouteBounds(
  points: readonly Point[],
  padding: number = CONNECTOR_ROUTING_LIMITS.routeBoundsPadding,
): CanvasBounds {
  const safePoints = points.length ? points : [{ x: 0, y: 0 }];
  const minX = Math.min(...safePoints.map((point) => point.x)) - padding;
  const minY = Math.min(...safePoints.map((point) => point.y)) - padding;
  const maxX = Math.max(...safePoints.map((point) => point.x)) + padding;
  const maxY = Math.max(...safePoints.map((point) => point.y)) + padding;
  return { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

export function pointAlongConnectorRoute(points: readonly Point[], position: number): Point {
  if (!points.length) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0] };
  const lengths = points.slice(1).map((point, index) => distance(points[index], point));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= EPSILON) return { ...points[0] };
  let remaining = clamp(finiteOr(position, 0.5), 0, 1) * total;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (remaining <= length || index === lengths.length - 1) {
      const ratio = length <= EPSILON ? 0 : remaining / length;
      return {
        x: points[index].x + (points[index + 1].x - points[index].x) * ratio,
        y: points[index].y + (points[index + 1].y - points[index].y) * ratio,
      };
    }
    remaining -= length;
  }
  return { ...points[points.length - 1] };
}

export function connectorLabelBoundsForRoute(
  label: string,
  points: readonly Point[],
  labelPosition: number = 0.5,
): CanvasBounds | null {
  const metrics = connectorLabelMetrics(label);
  if (!metrics.normalizedLines.length) return null;
  const point = pointAlongConnectorRoute(points, labelPosition);
  return {
    x: point.x - metrics.width / 2,
    y: point.y - metrics.height / 2,
    width: metrics.width,
    height: metrics.height,
  };
}

function unionBounds(left: CanvasBounds, right: CanvasBounds | null): CanvasBounds {
  if (!right) return left;
  const minX = Math.min(left.x, right.x);
  const minY = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

function candidateScore(
  candidate: Candidate,
  mode: ConnectorRouting["mode"],
  laneIndex: number,
  preferredLaneBend: number,
): readonly number[] {
  const kindRank = mode === "auto"
    ? laneIndex === 0
      ? ({ straight: 0, elbow: 1, curved: 2 } as const)[candidate.kind]
      : ({ curved: 0, elbow: 1, straight: 2 } as const)[candidate.kind]
    : 0;
  return [
    candidate.collisionObjectIds.length,
    candidate.crossingCount,
    kindRank,
    mode === "auto" && laneIndex !== 0 && candidate.kind === "curved"
      ? Math.abs(candidate.bend - preferredLaneBend)
      : 0,
    Math.max(0, candidate.points.length - 2),
    candidate.pathLength,
    candidate.ordinal,
  ];
}

function compareScore(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (Math.abs(delta) > EPSILON) return delta;
  }
  return 0;
}

/** Resolve one connector against a precomputed context and prior deterministic routes. */
export function resolveConnectorRoute(
  connector: ConnectorObject,
  context: ConnectorRoutingContext,
  resolvedRoutes: readonly ResolvedConnectorRoute[] = [],
): ResolvedConnectorRoute {
  const sourceRouting = normalizeConnectorRouting(connector.routing);
  const startObject = connector.start.objectId ? context.room.objects[connector.start.objectId] : undefined;
  const endObject = connector.end.objectId ? context.room.objects[connector.end.objectId] : undefined;
  const startReference = startObject ? objectCenter(startObject) : connector.start;
  const endReference = endObject ? objectCenter(endObject) : connector.end;
  const startPreferred = preferredSide(startReference, endReference);
  const endPreferred = preferredSide(endReference, startReference);
  const laneIndex = context.laneIndexByConnector.get(connector.id) ?? 0;
  const laneDirection = context.laneDirectionByConnector.get(connector.id) ?? 1;
  const physicalLane = laneIndex * laneDirection;
  const preferredLaneBend = clamp(
    physicalLane * context.options.laneSpacing * 2,
    -CONNECTOR_ROUTING_LIMITS.maxBend,
    CONNECTOR_ROUTING_LIMITS.maxBend,
  );
  // The pair-wide lane index is already unique. Endpoint direction must not
  // flip this port position, or mixed A→B / B→A routes can collapse onto the
  // same lane. Direction only orients the signed curve bend below.
  const startPortPosition = clamp(0.5 + laneIndex * CONNECTOR_ROUTING_LIMITS.portLaneStep, 0.15, 0.85);
  // Parallel lanes use the same side-relative position at both endpoints.
  // Mirroring the end position would turn otherwise parallel routes into an X.
  const endPortPosition = startPortPosition;
  const candidates: Candidate[] = [];
  let boundedClearCandidate = false;
  // Auto anchors are resolved output, never caller constraints.
  const respectPrecise = sourceRouting.mode !== "auto";

  const addCandidate = (input: Omit<Candidate, "ordinal" | "collisionObjectIds" | "crossingCount" | "pathLength">) => {
    if (candidates.length >= context.options.maxCandidates) return;
    const labelBounds = connectorLabelBoundsForRoute(
      connector.label,
      input.points,
      sourceRouting.labelPosition,
    );
    const candidate = {
      ...input,
      ordinal: candidates.length,
      pathLength: polylineLength(input.points),
      collisionObjectIds: collisionIds(connector, input.points, labelBounds, context),
      crossingCount: context.options.resolutionMode === "bounded"
        ? 0
        : crossingCount(connector, input.points, resolvedRoutes, context.room),
    };
    candidates.push(candidate);
    if (
      context.options.resolutionMode === "bounded" &&
      sourceRouting.mode === "auto" &&
      candidate.collisionObjectIds.length === 0
    ) {
      boundedClearCandidate = true;
    }
  };

  const startDirectSide = endpointSideOptions(
    connector.start,
    startObject,
    startPreferred,
    false,
    respectPrecise,
  )[0];
  const endDirectSide = endpointSideOptions(
    connector.end,
    endObject,
    endPreferred,
    false,
    respectPrecise,
  )[0];
  const startSides = endpointSideOptions(
    connector.start,
    startObject,
    startPreferred,
    sourceRouting.mode === "auto" || sourceRouting.mode === "elbow",
    respectPrecise,
  );
  const endSides = endpointSideOptions(
    connector.end,
    endObject,
    endPreferred,
    sourceRouting.mode === "auto" || sourceRouting.mode === "elbow",
    respectPrecise,
  );

  // Explicit modes retain a human-authored precise anchor, while ordinary straight/curved
  // bindings stay imprecise so a later move or layout can choose a new side.
  const persistPrecise = (kind: ConnectorRoutingKind): boolean =>
    sourceRouting.mode === "auto" || kind === "elbow" || laneIndex !== 0;
  const resolveEndpoint = (
    endpoint: ConnectorEndpoint,
    target: CanvasObject | undefined,
    side: ConnectorPortSide,
    lanePosition: number,
    kind: ConnectorRoutingKind,
  ): ConnectorEndpoint => anchorForEndpoint(endpoint, target, side, lanePosition, {
    respectPrecise,
    persistPrecise: persistPrecise(kind),
  });

  const addStraight = () => {
    const start = resolveEndpoint(connector.start, startObject, startDirectSide, startPortPosition, "straight");
    const end = resolveEndpoint(connector.end, endObject, endDirectSide, endPortPosition, "straight");
    addCandidate({ kind: "straight", bend: 0, elbowMidPoint: 0.5, start, end, points: compactPoints([start, end]), arc: null });
  };
  const addCurved = (bend: number) => {
    const start = resolveEndpoint(connector.start, startObject, startDirectSide, startPortPosition, "curved");
    const end = resolveEndpoint(connector.end, endObject, endDirectSide, endPortPosition, "curved");
    const route = curvedRoute(start, end, bend, context.options.maxRoutePoints);
    if (!route.arc) return;
    addCandidate({ kind: "curved", bend, elbowMidPoint: 0.5, start, end, ...route });
  };
  const addElbows = (midpoints: readonly number[]) => {
    for (const startSide of startSides) {
      for (const endSide of endSides) {
        for (const midpoint of midpoints) {
          if (candidates.length >= context.options.maxCandidates || boundedClearCandidate) return;
          const start = resolveEndpoint(connector.start, startObject, startSide, startPortPosition, "elbow");
          const end = resolveEndpoint(connector.end, endObject, endSide, endPortPosition, "elbow");
          const points = elbowPoints({
            start,
            end,
            startSide,
            endSide,
            startRotation: startObject?.rotation ?? 0,
            endRotation: endObject?.rotation ?? 0,
            midpoint,
            // Jazzboard arrows always use tldraw's medium size, whose v3.15.6
            // elbow expansion is exactly 36 page-space pixels.
            legLength: CONNECTOR_ROUTING_LIMITS.elbowLegLength,
          });
          addCandidate({ kind: "elbow", bend: 0, elbowMidPoint: midpoint, start, end, points, arc: null });
        }
      }
    }
  };

  if (sourceRouting.mode === "straight") addStraight();
  else if (sourceRouting.mode === "curved") addCurved(sourceRouting.bend);
  else if (sourceRouting.mode === "elbow") addElbows([sourceRouting.elbowMidPoint]);
  else if (context.options.resolutionMode === "bounded") {
    // Large topology changes use one preferred candidate first, then a bounded
    // set of deterministic elbow escapes. The first obstacle-clear route wins;
    // crossing minimization remains a quality-mode concern.
    if (laneIndex === 0) addStraight();
    else addCurved(preferredLaneBend);
    if (!boundedClearCandidate) addElbows(ELBOW_MIDPOINTS);
    if (!boundedClearCandidate) {
      for (const bend of [
        context.options.laneSpacing,
        -context.options.laneSpacing,
        context.options.laneSpacing * 2,
        context.options.laneSpacing * -2,
      ]) {
        if (candidates.length >= context.options.maxCandidates || boundedClearCandidate) break;
        addCurved(bend);
      }
    }
    if (!boundedClearCandidate && laneIndex !== 0) addStraight();
  }
  else {
    addElbows(ELBOW_MIDPOINTS);
    // A full two-spacing sagitta keeps ordinary one-line labels on adjacent
    // routes from overlapping at their default midpoint.
    const bendCandidates = [
      preferredLaneBend,
      context.options.laneSpacing,
      -context.options.laneSpacing,
      context.options.laneSpacing * 2,
      context.options.laneSpacing * -2,
      context.options.laneSpacing * 4,
      context.options.laneSpacing * -4,
      context.options.laneSpacing * 6,
      context.options.laneSpacing * -6,
    ];
    for (const bend of [...new Set(bendCandidates)]) {
      if (Math.abs(bend) >= CONNECTOR_ROUTING_LIMITS.minCurvedBend) addCurved(bend);
    }
    addStraight();
  }

  if (!candidates.length) addStraight();
  const chosen = [...candidates].sort((left, right) =>
    compareScore(
      candidateScore(left, sourceRouting.mode, laneIndex, preferredLaneBend),
      candidateScore(right, sourceRouting.mode, laneIndex, preferredLaneBend),
    ),
  )[0];
  const routing: ConnectorRouting = {
    mode: sourceRouting.mode,
    kind: chosen.kind,
    bend: chosen.kind === "curved" ? chosen.bend : 0,
    elbowMidPoint: chosen.kind === "elbow" ? chosen.elbowMidPoint : sourceRouting.elbowMidPoint,
    labelPosition: sourceRouting.labelPosition,
  };
  const pathBounds = connectorRouteBounds(chosen.points);
  const labelPoint = pointAlongConnectorRoute(chosen.points, routing.labelPosition);
  const labelBounds = connectorLabelBoundsForRoute(connector.label, chosen.points, routing.labelPosition);
  return {
    connectorId: connector.id,
    routing,
    start: chosen.start,
    end: chosen.end,
    points: chosen.points,
    arc: chosen.arc,
    labelPoint,
    pathLength: chosen.pathLength,
    pathBounds,
    labelBounds,
    bounds: unionBounds(pathBounds, labelBounds),
    collisionObjectIds: chosen.collisionObjectIds,
    crossingCount: chosen.crossingCount,
    laneIndex,
    candidateCount: candidates.length,
  };
}

/** Resolve all connectors in stable creation/ID order so crossing scores cannot depend on map insertion order. */
export function resolveConnectorRoutes(
  room: RoutingRoom,
  options: ConnectorRoutingOptions = {},
): Record<string, ResolvedConnectorRoute> {
  const connectors = Object.values(room.objects)
    .filter((object): object is ConnectorObject => object.kind === "connector")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const effectiveOptions = options.resolutionMode === undefined &&
    connectors.length > CONNECTOR_ROUTING_QUALITY_BATCH_LIMIT
    ? {
        ...options,
        resolutionMode: "bounded" as const,
        maxCandidates: Math.min(
          options.maxCandidates ?? CONNECTOR_ROUTING_BOUNDED_MAX_CANDIDATES,
          CONNECTOR_ROUTING_BOUNDED_MAX_CANDIDATES,
        ),
      }
    : options;
  const context = createConnectorRoutingContext(room, effectiveOptions);
  const resolved: ResolvedConnectorRoute[] = [];
  for (const connector of connectors) resolved.push(resolveConnectorRoute(connector, context, resolved));
  return Object.fromEntries(resolved.map((route) => [route.connectorId, route]));
}

/**
 * Rebuild the rendered geometry of one already-resolved persisted connector.
 *
 * Unlike `resolveConnectorRoute`, this performs no obstacle search, port
 * selection, or crossing scoring. Persisted endpoints and the canonical
 * routing kind are authoritative here, which makes this suitable for room
 * reads, polling, bounds, and other projection-only work.
 */
export function materializeConnectorRoute(
  connector: ConnectorObject,
  room: RoutingRoom,
  options: Pick<ConnectorRoutingOptions, "maxRoutePoints"> = {},
  laneIndex = 0,
): ResolvedConnectorRoute {
  const routing = normalizeConnectorRouting(connector.routing);
  const normalized = normalizedOptions(options);
  const start = { ...connector.start };
  const end = { ...connector.end };
  const startObject = start.objectId ? room.objects[start.objectId] : undefined;
  const endObject = end.objectId ? room.objects[end.objectId] : undefined;
  const startReference = startObject ? objectCenter(startObject) : start;
  const endReference = endObject ? objectCenter(endObject) : end;
  const startSide = startObject && start.normalizedAnchor
    ? connectorPortSide(start.normalizedAnchor)
    : preferredSide(startReference, endReference);
  const endSide = endObject && end.normalizedAnchor
    ? connectorPortSide(end.normalizedAnchor)
    : preferredSide(endReference, startReference);

  let points: Point[];
  let arc: ConnectorRouteArc | null = null;
  if (routing.kind === "curved") {
    const curve = curvedRoute(start, end, routing.bend, normalized.maxRoutePoints);
    points = curve.points;
    arc = curve.arc;
  } else if (routing.kind === "elbow") {
    points = elbowPoints({
      start,
      end,
      startSide,
      endSide,
      startRotation: startObject?.rotation ?? 0,
      endRotation: endObject?.rotation ?? 0,
      midpoint: routing.elbowMidPoint,
      legLength: CONNECTOR_ROUTING_LIMITS.elbowLegLength,
    });
  } else {
    points = compactPoints([start, end]);
  }

  const pathBounds = connectorRouteBounds(points);
  const labelPoint = pointAlongConnectorRoute(points, routing.labelPosition);
  const labelBounds = connectorLabelBoundsForRoute(connector.label, points, routing.labelPosition);
  return {
    connectorId: connector.id,
    routing,
    start,
    end,
    points,
    arc,
    labelPoint,
    pathLength: polylineLength(points),
    pathBounds,
    labelBounds,
    bounds: unionBounds(pathBounds, labelBounds),
    collisionObjectIds: [],
    crossingCount: 0,
    laneIndex,
    candidateCount: 1,
  };
}

/**
 * Materialize canonical persisted routes in O(objects + connectors). This is
 * intentionally separate from the obstacle-aware authoritative resolver so a
 * room read can never silently choose new ports or routes.
 */
export function materializeConnectorRoutes(
  room: RoutingRoom,
  options: Pick<ConnectorRoutingOptions, "maxRoutePoints"> = {},
): Record<string, ResolvedConnectorRoute> {
  const connectors = Object.values(room.objects).filter(
    (object): object is ConnectorObject => object.kind === "connector",
  );
  return Object.fromEntries(
    connectors.map((connector) => [connector.id, materializeConnectorRoute(connector, room, options)]),
  );
}

/**
 * Resolve only connectors whose authoritative geometry can have changed while
 * retaining every other persisted route as-is. Prior materialized routes are
 * still supplied to crossing scoring in stable order, so targeted resolution
 * has the same deterministic ordering contract as a full solve.
 */
export function resolveAffectedConnectorRoutes(
  room: RoutingRoom,
  connectorIds: ReadonlySet<string>,
  options: ConnectorRoutingOptions = {},
): Record<string, ResolvedConnectorRoute> {
  const effectiveOptions = options.resolutionMode === undefined &&
    connectorIds.size > CONNECTOR_ROUTING_QUALITY_BATCH_LIMIT
    ? {
        ...options,
        resolutionMode: "bounded" as const,
        maxCandidates: Math.min(
          options.maxCandidates ?? CONNECTOR_ROUTING_BOUNDED_MAX_CANDIDATES,
          CONNECTOR_ROUTING_BOUNDED_MAX_CANDIDATES,
        ),
      }
    : options;
  const context = createConnectorRoutingContext(room, effectiveOptions, connectorIds);
  const connectors = Object.values(room.objects)
    .filter((object): object is ConnectorObject => object.kind === "connector")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const resolved: ResolvedConnectorRoute[] = [];
  for (const connector of connectors) {
    resolved.push(
      connectorIds.has(connector.id)
        ? resolveConnectorRoute(connector, context, resolved)
        : materializeConnectorRoute(
            connector,
            room,
            effectiveOptions,
            context.laneIndexByConnector.get(connector.id) ?? 0,
          ),
    );
  }
  return Object.fromEntries(resolved.map((route) => [route.connectorId, route]));
}

/** Exact tldraw defaults for a legacy/null endpoint binding. */
export function connectorEndpointBindingDefaults(endpoint: ConnectorEndpoint): {
  normalizedAnchor: Point;
  isPrecise: boolean;
  isExact: boolean;
  snap: ConnectorEndpointSnap;
} {
  return {
    normalizedAnchor: endpoint.normalizedAnchor ?? { x: 0.5, y: 0.5 },
    isPrecise: endpoint.isPrecise ?? false,
    isExact: endpoint.isExact ?? false,
    snap: endpoint.snap ?? "none",
  };
}
