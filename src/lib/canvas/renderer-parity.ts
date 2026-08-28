import {
  getArrowInfo,
  type Editor,
  type TLArrowShape,
  type TLShape,
  type TLShapeId,
} from "tldraw";

import {
  jazzboardMeta,
  tldrawShapeId,
  tldrawShapeToSemantic,
} from "@/lib/canvas/projection";
import type { SemanticScene } from "@/lib/canvas/semantic-scene";
import {
  connectorEndpointBindingDefaults,
  normalizeConnectorRouting,
} from "@/lib/domain/connector-routing";
import type {
  CanvasBounds,
  ConnectorEndpoint,
  ConnectorRouting,
  ObjectKind,
  Point,
} from "@/lib/domain/types";

export const RENDERER_PARITY_DEFAULTS = Object.freeze({
  /** Absolute page-space tolerance for object and scene bounds. */
  boundsTolerance: 1,
  /** Absolute page-space tolerance for connector terminal positions. */
  endpointTolerance: 1,
  /** Absolute page-space tolerance at each normalized route sample. */
  routeTolerance: 2,
  /** Absolute tolerance for numeric routing props such as bend and label position. */
  routingTolerance: 0.001,
  /** Keeps one shadow comparison from walking an unbounded document. */
  maxComparedObjects: 2_048,
  /** Diagnostics are counted exhaustively within the comparison window but only this many are retained. */
  maxDiagnostics: 128,
  /** Route geometry is compared at deterministic, equally spaced length samples. */
  routeSamples: 9,
});

const RENDERER_PARITY_HARD_LIMITS = Object.freeze({
  maxComparedObjects: 4_096,
  maxDiagnostics: 512,
  routeSamples: 33,
  capturedRoutePoints: 64,
  diagnosticGroupMembers: 64,
});

export type RendererParityOptions = Partial<
  Record<keyof typeof RENDERER_PARITY_DEFAULTS, number>
>;

export type RendererParityConnectorSnapshot = Readonly<{
  start: ConnectorEndpoint;
  end: ConnectorEndpoint;
  routing: ConnectorRouting;
  /** Page-space points describing the renderer's visible connector body. */
  routePoints: readonly Point[];
}>;

export type RendererParityObjectSnapshot = Readonly<{
  objectId: string;
  /** Null means the renderer record could not be projected to a supported semantic kind. */
  kind: ObjectKind | null;
  /** Renderer-native kind retained only to make unsupported projections diagnosable. */
  rendererKind: string;
  bounds: CanvasBounds | null;
  groupId: string | null;
  connector: RendererParityConnectorSnapshot | null;
}>;

export type RendererParitySnapshot = Readonly<{
  rendererId: string;
  objects: readonly RendererParityObjectSnapshot[];
  /** Union of renderer object bounds, in page space. */
  bounds: CanvasBounds | null;
}>;

export type RendererParityDiagnosticCode =
  | "comparison_truncated"
  | "duplicate_object_id"
  | "missing_object"
  | "unexpected_object"
  | "kind_mismatch"
  | "bounds_mismatch"
  | "connector_endpoint_mismatch"
  | "connector_route_mismatch"
  | "group_membership_mismatch"
  | "scene_bounds_mismatch";

export type RendererParityDiagnostic = Readonly<{
  code: RendererParityDiagnosticCode;
  scope: "comparison" | "scene" | "object" | "connector" | "group";
  objectId?: string;
  groupId?: string;
  field?: string;
  expected: unknown;
  actual: unknown;
  tolerance?: number;
  /** Null represents a non-finite delta such as one side having no bounds. */
  maxDelta?: number | null;
}>;

export type RendererParityReport = Readonly<{
  rendererId: string;
  roomId: string;
  roomRevision: number;
  matches: boolean;
  /** False when the hard comparison window prevented a complete object walk. */
  complete: boolean;
  authoritativeObjectCount: number;
  rendererObjectCount: number;
  comparedObjectCount: number;
  totalDiagnosticCount: number;
  omittedDiagnosticCount: number;
  diagnostics: readonly RendererParityDiagnostic[];
  summary: Readonly<Record<RendererParityDiagnosticCode, number>>;
  tolerances: Readonly<{
    bounds: number;
    endpoint: number;
    route: number;
    routing: number;
  }>;
  limits: Readonly<{
    maxComparedObjects: number;
    maxDiagnostics: number;
    routeSamples: number;
  }>;
}>;

export type TldrawParitySnapshotOptions = Readonly<{
  /** Maximum retained points for any one renderer route. */
  maxRoutePoints?: number;
}>;

const DIAGNOSTIC_CODES: readonly RendererParityDiagnosticCode[] = [
  "comparison_truncated",
  "duplicate_object_id",
  "missing_object",
  "unexpected_object",
  "kind_mismatch",
  "bounds_mismatch",
  "connector_endpoint_mismatch",
  "connector_route_mismatch",
  "group_membership_mismatch",
  "scene_bounds_mismatch",
];

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(candidate, minimum), maximum);
}

function normalizedOptions(options: RendererParityOptions) {
  return {
    boundsTolerance: finiteNonNegative(options.boundsTolerance, RENDERER_PARITY_DEFAULTS.boundsTolerance),
    endpointTolerance: finiteNonNegative(options.endpointTolerance, RENDERER_PARITY_DEFAULTS.endpointTolerance),
    routeTolerance: finiteNonNegative(options.routeTolerance, RENDERER_PARITY_DEFAULTS.routeTolerance),
    routingTolerance: finiteNonNegative(options.routingTolerance, RENDERER_PARITY_DEFAULTS.routingTolerance),
    maxComparedObjects: boundedInteger(
      options.maxComparedObjects,
      RENDERER_PARITY_DEFAULTS.maxComparedObjects,
      1,
      RENDERER_PARITY_HARD_LIMITS.maxComparedObjects,
    ),
    maxDiagnostics: boundedInteger(
      options.maxDiagnostics,
      RENDERER_PARITY_DEFAULTS.maxDiagnostics,
      1,
      RENDERER_PARITY_HARD_LIMITS.maxDiagnostics,
    ),
    routeSamples: boundedInteger(
      options.routeSamples,
      RENDERER_PARITY_DEFAULTS.routeSamples,
      2,
      RENDERER_PARITY_HARD_LIMITS.routeSamples,
    ),
  };
}

function numericDelta(left: number, right: number): number {
  return Number.isFinite(left) && Number.isFinite(right) ? Math.abs(left - right) : Number.POSITIVE_INFINITY;
}

function pointDelta(left: Point, right: Point): number {
  return Math.max(numericDelta(left.x, right.x), numericDelta(left.y, right.y));
}

function boundsDelta(left: CanvasBounds, right: CanvasBounds): number {
  return Math.max(
    numericDelta(left.x, right.x),
    numericDelta(left.y, right.y),
    numericDelta(left.width, right.width),
    numericDelta(left.height, right.height),
  );
}

function unionBounds(left: CanvasBounds | null, right: CanvasBounds): CanvasBounds {
  if (!left) return { ...right };
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

function compactPoints(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    if (!result.length || pointDelta(result[result.length - 1], point) > 0.000_001) {
      result.push({ x: point.x, y: point.y });
    }
  }
  return result;
}

function pointAtRoutePosition(points: readonly Point[], position: number): Point {
  if (!points.length) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0] };
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const segment = Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
    );
    lengths.push(segment);
    total += segment;
  }
  if (total <= 0.000_001) return { ...points[0] };
  const target = Math.min(Math.max(position, 0), 1) * total;
  let traversed = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const next = traversed + lengths[index];
    if (target <= next || index === lengths.length - 1) {
      const ratio = lengths[index] <= 0.000_001 ? 0 : (target - traversed) / lengths[index];
      return {
        x: points[index].x + (points[index + 1].x - points[index].x) * ratio,
        y: points[index].y + (points[index + 1].y - points[index].y) * ratio,
      };
    }
    traversed = next;
  }
  return { ...points[points.length - 1] };
}

function sampleRoute(points: readonly Point[], sampleCount: number): Point[] {
  if (!points.length) return [];
  if (sampleCount <= 1) return [{ ...points[0] }];
  return Array.from({ length: sampleCount }, (_, index) =>
    pointAtRoutePosition(points, index / (sampleCount - 1)),
  );
}

function routeDelta(
  expected: readonly Point[],
  actual: readonly Point[],
  sampleCount: number,
): { delta: number; expectedSamples: Point[]; actualSamples: Point[] } {
  if (!expected.length || !actual.length) {
    return {
      delta: expected.length === actual.length ? 0 : Number.POSITIVE_INFINITY,
      expectedSamples: sampleRoute(expected, sampleCount),
      actualSamples: sampleRoute(actual, sampleCount),
    };
  }
  const expectedSamples = sampleRoute(expected, sampleCount);
  const actualSamples = sampleRoute(actual, sampleCount);
  return {
    delta: Math.max(
      ...expectedSamples.map((point, index) => pointDelta(point, actualSamples[index])),
    ),
    expectedSamples,
    actualSamples,
  };
}

function routingDelta(expected: ConnectorRouting, actual: ConnectorRouting): number {
  return Math.max(
    numericDelta(expected.bend, actual.bend),
    numericDelta(expected.elbowMidPoint, actual.elbowMidPoint),
    numericDelta(expected.labelPosition, actual.labelPosition),
  );
}

function endpointComparison(
  expected: ConnectorEndpoint,
  actual: ConnectorEndpoint,
): { matchesMetadata: boolean; delta: number } {
  const expectedBinding = connectorEndpointBindingDefaults(expected);
  const actualBinding = connectorEndpointBindingDefaults(actual);
  return {
    matchesMetadata:
      expected.objectId === actual.objectId &&
      expectedBinding.isPrecise === actualBinding.isPrecise &&
      expectedBinding.isExact === actualBinding.isExact &&
      expectedBinding.snap === actualBinding.snap &&
      pointDelta(expectedBinding.normalizedAnchor, actualBinding.normalizedAnchor) <= 0.001,
    delta: pointDelta(expected, actual),
  };
}

function endpointDiagnosticValue(endpoint: ConnectorEndpoint) {
  const binding = connectorEndpointBindingDefaults(endpoint);
  return {
    x: endpoint.x,
    y: endpoint.y,
    objectId: endpoint.objectId,
    normalizedAnchor: binding.normalizedAnchor,
    isPrecise: binding.isPrecise,
    isExact: binding.isExact,
    snap: binding.snap,
  };
}

function reportedDelta(delta: number): number | null {
  return Number.isFinite(delta) ? delta : null;
}

function objectIndex<ObjectSnapshot extends { objectId: string }>(
  objects: readonly ObjectSnapshot[],
) {
  const index = new Map<string, ObjectSnapshot>();
  const counts = new Map<string, number>();
  for (const object of objects) {
    counts.set(object.objectId, (counts.get(object.objectId) ?? 0) + 1);
    if (!index.has(object.objectId)) index.set(object.objectId, object);
  }
  return { index, counts };
}

function normalizedGroups(
  objects: readonly { objectId: string; groupId: string | null }[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const object of objects) {
    if (!object.groupId) continue;
    const members = groups.get(object.groupId) ?? [];
    members.push(object.objectId);
    groups.set(object.groupId, members);
  }
  for (const members of groups.values()) members.sort((left, right) => left.localeCompare(right));
  return groups;
}

function groupDiagnosticValue(members: readonly string[]) {
  const objectIds = members.slice(0, RENDERER_PARITY_HARD_LIMITS.diagnosticGroupMembers);
  return {
    count: members.length,
    objectIds,
    omittedObjectCount: members.length - objectIds.length,
  };
}

function connectorDiagnosticValue(
  connector: RendererParityConnectorSnapshot | null,
  sampleCount: number,
) {
  if (!connector) return null;
  return {
    start: endpointDiagnosticValue(connector.start),
    end: endpointDiagnosticValue(connector.end),
    routing: normalizeConnectorRouting(connector.routing),
    samples: sampleRoute(connector.routePoints, sampleCount),
  };
}

/**
 * Compare a renderer snapshot with the authoritative renderer-neutral scene.
 *
 * The report is deterministic and JSON-safe. Detailed object comparison,
 * retained diagnostics, and route sampling all have hard ceilings so callers
 * can run it in shadow mode without producing unbounded diagnostic payloads.
 */
export function compareRendererParity(
  scene: SemanticScene,
  snapshot: RendererParitySnapshot,
  options: RendererParityOptions = {},
): RendererParityReport {
  const normalized = normalizedOptions(options);
  const summary = Object.fromEntries(
    DIAGNOSTIC_CODES.map((code) => [code, 0]),
  ) as Record<RendererParityDiagnosticCode, number>;
  const diagnostics: RendererParityDiagnostic[] = [];
  let totalDiagnosticCount = 0;
  const record = (diagnostic: RendererParityDiagnostic) => {
    totalDiagnosticCount += 1;
    summary[diagnostic.code] += 1;
    if (diagnostics.length < normalized.maxDiagnostics) diagnostics.push(diagnostic);
  };

  const authoritativeObjects = scene.objects.map(({ object, bounds }) => ({
    objectId: object.id,
    kind: object.kind,
    bounds,
    groupId: object.groupId,
    connector: object.kind === "connector"
      ? {
          start: scene.connectorRoutes[object.id]?.start ?? object.start,
          end: scene.connectorRoutes[object.id]?.end ?? object.end,
          routing: scene.connectorRoutes[object.id]?.routing ?? normalizeConnectorRouting(object.routing),
          routePoints: scene.connectorRoutes[object.id]?.points ?? [object.start, object.end],
        }
      : null,
  }));
  const authoritative = objectIndex(authoritativeObjects);
  const rendered = objectIndex(snapshot.objects);

  for (const [source, counts] of [
    ["authoritative", authoritative.counts],
    [snapshot.rendererId, rendered.counts],
  ] as const) {
    for (const [objectId, count] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (count <= 1) continue;
      record({
        code: "duplicate_object_id",
        scope: "object",
        objectId,
        field: "objectId",
        expected: 1,
        actual: { source, count },
      });
    }
  }

  const objectIds = [...new Set([...authoritative.index.keys(), ...rendered.index.keys()])]
    .sort((left, right) => left.localeCompare(right));
  const complete = objectIds.length <= normalized.maxComparedObjects;
  if (!complete) {
    record({
      code: "comparison_truncated",
      scope: "comparison",
      field: "objectCount",
      expected: { atMost: normalized.maxComparedObjects },
      actual: { objectCount: objectIds.length },
    });
  }

  let comparedObjectCount = 0;
  for (const objectId of objectIds.slice(0, normalized.maxComparedObjects)) {
    const expected = authoritative.index.get(objectId);
    const actual = rendered.index.get(objectId);
    if (!expected) {
      record({
        code: "unexpected_object",
        scope: "object",
        objectId,
        expected: null,
        actual: { kind: actual?.kind ?? null, rendererKind: actual?.rendererKind ?? null },
      });
      continue;
    }
    if (!actual) {
      record({
        code: "missing_object",
        scope: "object",
        objectId,
        expected: { kind: expected.kind },
        actual: null,
      });
      continue;
    }
    comparedObjectCount += 1;

    if (expected.kind !== actual.kind) {
      record({
        code: "kind_mismatch",
        scope: "object",
        objectId,
        field: "kind",
        expected: expected.kind,
        actual: { kind: actual.kind, rendererKind: actual.rendererKind },
      });
    }

    const objectBoundsDelta = expected.bounds && actual.bounds
      ? boundsDelta(expected.bounds, actual.bounds)
      : expected.bounds === actual.bounds
        ? 0
        : Number.POSITIVE_INFINITY;
    if (objectBoundsDelta > normalized.boundsTolerance) {
      record({
        code: "bounds_mismatch",
        scope: "object",
        objectId,
        field: "bounds",
        expected: expected.bounds,
        actual: actual.bounds,
        tolerance: normalized.boundsTolerance,
        maxDelta: reportedDelta(objectBoundsDelta),
      });
    }

    if (expected.kind !== "connector") continue;
    if (!expected.connector || !actual.connector) {
      record({
        code: "connector_route_mismatch",
        scope: "connector",
        objectId,
        field: "connector",
        expected: connectorDiagnosticValue(expected.connector, normalized.routeSamples),
        actual: connectorDiagnosticValue(actual.connector, normalized.routeSamples),
      });
      continue;
    }

    for (const terminal of ["start", "end"] as const) {
      const expectedEndpoint = expected.connector[terminal];
      const actualEndpoint = actual.connector[terminal];
      const endpoint = endpointComparison(expectedEndpoint, actualEndpoint);
      if (!endpoint.matchesMetadata || endpoint.delta > normalized.endpointTolerance) {
        record({
          code: "connector_endpoint_mismatch",
          scope: "connector",
          objectId,
          field: terminal,
          expected: endpointDiagnosticValue(expectedEndpoint),
          actual: endpointDiagnosticValue(actualEndpoint),
          tolerance: normalized.endpointTolerance,
          maxDelta: reportedDelta(endpoint.delta),
        });
      }
    }

    const expectedRouting = normalizeConnectorRouting(expected.connector.routing);
    const actualRouting = normalizeConnectorRouting(actual.connector.routing);
    const numericRoutingDelta = routingDelta(expectedRouting, actualRouting);
    const sameRouting =
      expectedRouting.mode === actualRouting.mode &&
      expectedRouting.kind === actualRouting.kind &&
      numericRoutingDelta <= normalized.routingTolerance;
    const geometry = routeDelta(
      expected.connector.routePoints,
      actual.connector.routePoints,
      normalized.routeSamples,
    );
    if (!sameRouting || geometry.delta > normalized.routeTolerance) {
      record({
        code: "connector_route_mismatch",
        scope: "connector",
        objectId,
        field: "route",
        expected: { routing: expectedRouting, samples: geometry.expectedSamples },
        actual: { routing: actualRouting, samples: geometry.actualSamples },
        tolerance: Math.max(normalized.routingTolerance, normalized.routeTolerance),
        maxDelta: reportedDelta(Math.max(numericRoutingDelta, geometry.delta)),
      });
    }
  }

  const authoritativeGroups = normalizedGroups(authoritativeObjects);
  const renderedGroups = normalizedGroups(snapshot.objects);
  const groupIds = [...new Set([...authoritativeGroups.keys(), ...renderedGroups.keys()])]
    .sort((left, right) => left.localeCompare(right));
  for (const groupId of groupIds) {
    const expected = authoritativeGroups.get(groupId) ?? [];
    const actual = renderedGroups.get(groupId) ?? [];
    if (expected.length === actual.length && expected.every((objectId, index) => objectId === actual[index])) {
      continue;
    }
    record({
      code: "group_membership_mismatch",
      scope: "group",
      groupId,
      field: "members",
      expected: groupDiagnosticValue(expected),
      actual: groupDiagnosticValue(actual),
    });
  }

  const sceneBoundsDelta = scene.bounds && snapshot.bounds
    ? boundsDelta(scene.bounds, snapshot.bounds)
    : scene.bounds === snapshot.bounds
      ? 0
      : Number.POSITIVE_INFINITY;
  if (sceneBoundsDelta > normalized.boundsTolerance) {
    record({
      code: "scene_bounds_mismatch",
      scope: "scene",
      field: "bounds",
      expected: scene.bounds,
      actual: snapshot.bounds,
      tolerance: normalized.boundsTolerance,
      maxDelta: reportedDelta(sceneBoundsDelta),
    });
  }

  return {
    rendererId: snapshot.rendererId,
    roomId: scene.roomId,
    roomRevision: scene.roomRevision,
    matches: totalDiagnosticCount === 0,
    complete,
    authoritativeObjectCount: scene.objects.length,
    rendererObjectCount: snapshot.objects.length,
    comparedObjectCount,
    totalDiagnosticCount,
    omittedDiagnosticCount: totalDiagnosticCount - diagnostics.length,
    diagnostics,
    summary,
    tolerances: {
      bounds: normalized.boundsTolerance,
      endpoint: normalized.endpointTolerance,
      route: normalized.routeTolerance,
      routing: normalized.routingTolerance,
    },
    limits: {
      maxComparedObjects: normalized.maxComparedObjects,
      maxDiagnostics: normalized.maxDiagnostics,
      routeSamples: normalized.routeSamples,
    },
  };
}

function semanticObjectId(shape: TLShape): string {
  const metadataId = jazzboardMeta(shape).objectId;
  if (metadataId && shape.id === tldrawShapeId(metadataId)) return metadataId;
  return String(shape.id).slice("shape:".length);
}

function semanticLeafShapes(editor: Editor): TLShape[] {
  const shapes: TLShape[] = [];
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
    shapes.push(shape);
  };
  editor.getCurrentPageShapesSorted().forEach(visit);
  return shapes;
}

function pageBounds(
  bounds: { x: number; y: number; w: number; h: number } | null | undefined,
): CanvasBounds | null {
  return bounds ? { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h } : null;
}

function routePointsForArrow(
  editor: Editor,
  shape: TLArrowShape,
  fallback: readonly Point[],
  maxRoutePoints: number,
): Point[] {
  const info = getArrowInfo(editor, shape);
  if (!info) return compactPoints(fallback);
  const transform = editor.getShapePageTransform(shape);
  const toPage = (point: Point): Point => {
    const result = transform.applyToPoint(point);
    return { x: result.x, y: result.y };
  };

  let points: Point[];
  if (info.type === "elbow") {
    points = info.route.points.map(toPage);
  } else if (info.type === "arc") {
    const center = info.bodyArc.center;
    const startAngle = Math.atan2(info.start.point.y - center.y, info.start.point.x - center.x);
    const count = Math.max(2, Math.min(maxRoutePoints, Math.ceil(Math.abs(info.bodyArc.length) / 24) + 1));
    points = Array.from({ length: count }, (_, index) => {
      const angle = startAngle + info.bodyArc.size * (index / (count - 1));
      return toPage({
        x: center.x + Math.cos(angle) * info.bodyArc.radius,
        y: center.y + Math.sin(angle) * info.bodyArc.radius,
      });
    });
    points[0] = toPage(info.start.point);
    points[points.length - 1] = toPage(info.end.point);
  } else {
    points = [toPage(info.start.point), toPage(info.end.point)];
  }

  const compacted = compactPoints(points);
  return compacted.length <= maxRoutePoints
    ? compacted
    : sampleRoute(compacted, maxRoutePoints);
}

/**
 * Capture the mounted tldraw renderer as a renderer-neutral parity snapshot.
 * Unsupported or temporarily incomplete records remain in the ID comparison
 * with a null kind instead of throwing into the visible canvas.
 */
export function captureTldrawRendererParitySnapshot(
  editor: Editor,
  options: TldrawParitySnapshotOptions = {},
): RendererParitySnapshot {
  const maxRoutePoints = boundedInteger(
    options.maxRoutePoints,
    32,
    2,
    RENDERER_PARITY_HARD_LIMITS.capturedRoutePoints,
  );
  const objects = semanticLeafShapes(editor).map((shape): RendererParityObjectSnapshot => {
    let draft: ReturnType<typeof tldrawShapeToSemantic> = null;
    try {
      draft = tldrawShapeToSemantic(editor, shape);
    } catch {
      // A shadow diagnostic must not interfere with the mounted renderer. The
      // null semantic kind below turns this into a structured parity mismatch.
    }

    let bounds: CanvasBounds | null = null;
    try {
      bounds = pageBounds(editor.getShapePageBounds(shape.id));
    } catch {
      // Keep the record and let the bounds comparator report null geometry.
    }

    let connector: RendererParityConnectorSnapshot | null = null;
    if (draft?.kind === "connector" && shape.type === "arrow") {
      let routePoints: readonly Point[] = [draft.start, draft.end];
      try {
        routePoints = routePointsForArrow(
          editor,
          shape as TLArrowShape,
          routePoints,
          maxRoutePoints,
        );
      } catch {
        // Endpoint and routing comparisons are still useful if tldraw cannot
        // materialize its visible route during a transient editor state.
      }
      connector = {
        start: draft.start,
        end: draft.end,
        routing: normalizeConnectorRouting(draft.routing),
        routePoints,
      };
    }

    return {
      objectId: draft?.id ?? semanticObjectId(shape),
      kind: draft?.kind ?? null,
      rendererKind: shape.type,
      bounds,
      groupId: draft?.groupId ?? null,
      connector,
    };
  });
  const bounds = objects.reduce<CanvasBounds | null>(
    (current, object) => object.bounds ? unionBounds(current, object.bounds) : current,
    null,
  );
  return { rendererId: "tldraw-v3", objects, bounds };
}
