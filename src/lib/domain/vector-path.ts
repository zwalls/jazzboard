import type {
  CanvasBounds,
  PathObject,
  Point,
  VectorPathSegment,
} from "./types";

export const VECTOR_PATH_LIMITS = Object.freeze({
  maxSegments: 2_000,
  maxStrokeWidth: 256,
  flattenStepsPerCurve: 16,
});

export type WorldVectorPathGeometry = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  start: Point;
  segments: VectorPathSegment[];
}>;

export type WorldDrawingGeometry = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  points: Point[];
}>;

/** Shared normalization used by standalone and transactional freehand tools. */
export function normalizeWorldDrawing(points: readonly Point[]): WorldDrawingGeometry {
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
    points: points.map((point) => ({ x: point.x - minX, y: point.y - minY })),
  };
}

function segmentPoints(segment: VectorPathSegment): Point[] {
  if (segment.kind === "line") return [segment.to];
  if (segment.kind === "quadratic") return [segment.control, segment.to];
  return [segment.control1, segment.control2, segment.to];
}

function stable(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

/** Normalize caller-authored world coordinates into a stable object-local box. */
export function normalizeWorldVectorPath(
  start: Point,
  segments: readonly VectorPathSegment[],
): WorldVectorPathGeometry {
  const points = [start, ...segments.flatMap(segmentPoints)];
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const local = (point: Point): Point => ({
    x: stable((point.x - minX) / width),
    y: stable((point.y - minY) / height),
  });
  return {
    x: minX,
    y: minY,
    width,
    height,
    start: local(start),
    segments: segments.map((segment) => {
      if (segment.kind === "line") return { kind: "line", to: local(segment.to) };
      if (segment.kind === "quadratic") {
        return { kind: "quadratic", control: local(segment.control), to: local(segment.to) };
      }
      return {
        kind: "cubic",
        control1: local(segment.control1),
        control2: local(segment.control2),
        to: local(segment.to),
      };
    }),
  };
}

export function polygonWorldVectorPath(points: readonly Point[]): WorldVectorPathGeometry {
  return normalizeWorldVectorPath(
    points[0]!,
    points.slice(1).map((to) => ({ kind: "line" as const, to })),
  );
}

function unrotatedWorldPoint(object: PathObject, point: Point): Point {
  return {
    x: object.x + point.x * object.width,
    y: object.y + point.y * object.height,
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

function quadratic(from: Point, control: Point, to: Point, t: number): Point {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
    y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
  };
}

function cubic(from: Point, control1: Point, control2: Point, to: Point, t: number): Point {
  const inverse = 1 - t;
  return {
    x: inverse ** 3 * from.x + 3 * inverse * inverse * t * control1.x + 3 * inverse * t * t * control2.x + t ** 3 * to.x,
    y: inverse ** 3 * from.y + 3 * inverse * inverse * t * control1.y + 3 * inverse * t * t * control2.y + t ** 3 * to.y,
  };
}

/** Deterministic curve flattening shared by bounds, hit testing and draft choreography. */
export function flattenVectorPath(
  object: PathObject,
  stepsPerCurve = VECTOR_PATH_LIMITS.flattenStepsPerCurve,
): Point[] {
  const center = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  const rotate = (point: Point) => rotateAround(point, center, object.rotation);
  const start = unrotatedWorldPoint(object, object.start);
  const points: Point[] = [rotate(start)];
  let current = start;
  for (const segment of object.segments) {
    const to = unrotatedWorldPoint(object, segment.to);
    if (segment.kind === "line") {
      points.push(rotate(to));
    } else if (segment.kind === "quadratic") {
      const control = unrotatedWorldPoint(object, segment.control);
      for (let index = 1; index <= stepsPerCurve; index += 1) {
        points.push(rotate(quadratic(current, control, to, index / stepsPerCurve)));
      }
    } else {
      const control1 = unrotatedWorldPoint(object, segment.control1);
      const control2 = unrotatedWorldPoint(object, segment.control2);
      for (let index = 1; index <= stepsPerCurve; index += 1) {
        points.push(rotate(cubic(current, control1, control2, to, index / stepsPerCurve)));
      }
    }
    current = to;
  }
  if (object.closed) points.push(points[0]!);
  return points;
}

export function vectorPathBounds(object: PathObject): CanvasBounds {
  const center = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  // The object box encloses every endpoint and Bezier control. Rotating that
  // box is a conservative bound for the entire rotated curve and cannot clip
  // extrema between deterministic flattening samples.
  const points = [
    { x: object.x, y: object.y },
    { x: object.x + object.width, y: object.y },
    { x: object.x + object.width, y: object.y + object.height },
    { x: object.x, y: object.y + object.height },
  ].map((point) => rotateAround(point, center, object.rotation));
  const padding = object.stroke === "none" ? 0 : object.strokeWidth / 2;
  const minX = Math.min(...points.map((point) => point.x)) - padding;
  const minY = Math.min(...points.map((point) => point.y)) - padding;
  const maxX = Math.max(...points.map((point) => point.x)) + padding;
  const maxY = Math.max(...points.map((point) => point.y)) + padding;
  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
  };
}

export function vectorPathPointCount(object: Pick<PathObject, "start" | "segments">): number {
  return 1 + object.segments.reduce(
    (count, segment) => count + (segment.kind === "line" ? 1 : segment.kind === "quadratic" ? 2 : 3),
    0,
  );
}

export function vectorPathSvgData(object: PathObject, format: (value: number) => string): string {
  const point = (value: Point) => {
    const world = unrotatedWorldPoint(object, value);
    return `${format(world.x)} ${format(world.y)}`;
  };
  const commands = [`M ${point(object.start)}`];
  for (const segment of object.segments) {
    if (segment.kind === "line") commands.push(`L ${point(segment.to)}`);
    else if (segment.kind === "quadratic") {
      commands.push(`Q ${point(segment.control)} ${point(segment.to)}`);
    } else {
      commands.push(`C ${point(segment.control1)} ${point(segment.control2)} ${point(segment.to)}`);
    }
  }
  if (object.closed) commands.push("Z");
  return commands.join(" ");
}
