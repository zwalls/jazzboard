import {
  materializeConnectorRoute,
  materializeConnectorRoutes,
  resolveAffectedConnectorRoutes,
  type ResolvedConnectorRoute,
} from "@/lib/domain/connector-routing";
import type {
  CanvasBounds,
  CanvasObject,
  Point,
  RoomState,
} from "@/lib/domain/types";
import { vectorPathBounds } from "@/lib/domain/vector-path";
import { equalDocumentValue } from "@/lib/domain/document-sharing";

import { SEMANTIC_DRAW_STROKE_WIDTHS } from "./semantic-visual-style";

type SemanticSceneRoom = Pick<
  RoomState,
  "id" | "roomRevision" | "objects" | "diagrams"
>;

export type SemanticSceneBuildOptions = Readonly<{
  /**
   * Connectors whose pixels must be resolved against an optimistic document.
   * Omit this for ordinary authoritative projection: persisted endpoint and
   * routing geometry remains the read model everywhere else.
   */
  optimisticConnectorIds?: ReadonlySet<string>;
}>;

export type SemanticSceneObject = Readonly<{
  /** The authoritative semantic object; renderer-specific records never enter the scene. */
  object: CanvasObject;
  /** Page-space bounds including rotation, stroke width, and connector labels. */
  bounds: CanvasBounds;
}>;

export type SemanticScene = Readonly<{
  roomId: string;
  roomRevision: number;
  /** Stable paint order: ascending z-index with semantic ID as the tie-breaker. */
  objects: readonly SemanticSceneObject[];
  objectsById: Readonly<Record<string, SemanticSceneObject>>;
  /** Null only when the room has no semantic objects. */
  bounds: CanvasBounds | null;
  /** Group IDs and members are both deterministic; ungrouped objects are omitted. */
  groupMembers: Readonly<Record<string, readonly string[]>>;
  /** Persisted geometry, except explicitly requested optimistic routes during a local edit. */
  connectorRoutes: Readonly<Record<string, ResolvedConnectorRoute>>;
}>;

// Keep projection provenance with the scene that produced it. A previously
// resolved route is not a cached persisted route even when its inputs match.
const optimisticRoutesByScene = new WeakMap<SemanticScene, ReadonlySet<string>>();
const noOptimisticRoutes: ReadonlySet<string> = new Set();

function materializeSceneRoute(previous?: SemanticScene): typeof materializeConnectorRoute {
  const previousOptimisticRoutes = previous && optimisticRoutesByScene.get(previous);
  if (!previous || !previousOptimisticRoutes) return materializeConnectorRoute;
  const matchesEndpoint = (id: string | null | undefined, objects: RoomState["objects"]) =>
    !id || previous.objectsById[id]?.object === objects[id];

  return (connector, room, options, laneIndex = 0) => {
    const cached = previous.connectorRoutes[connector.id];
    if (
      cached?.laneIndex === laneIndex &&
      options?.maxRoutePoints === undefined &&
      !previousOptimisticRoutes.has(connector.id) &&
      previous.objectsById[connector.id]?.object === connector &&
      matchesEndpoint(connector.start.objectId, room.objects) &&
      matchesEndpoint(connector.end.objectId, room.objects)
    ) {
      return cached;
    }
    return materializeConnectorRoute(connector, room, options, laneIndex);
  };
}

function compareObjects(left: CanvasObject, right: CanvasObject): number {
  return left.zIndex - right.zIndex || left.id.localeCompare(right.id);
}

function rotateAround(point: Point, origin: Point, rotation: number): Point {
  if (!rotation) return { ...point };
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return {
    x: origin.x + dx * cosine - dy * sine,
    y: origin.y + dx * sine + dy * cosine,
  };
}

function boundsForPoints(points: readonly Point[], padding = 0): CanvasBounds {
  const safePoints = points.length ? points : [{ x: 0, y: 0 }];
  const minX = Math.min(...safePoints.map((point) => point.x)) - padding;
  const minY = Math.min(...safePoints.map((point) => point.y)) - padding;
  const maxX = Math.max(...safePoints.map((point) => point.x)) + padding;
  const maxY = Math.max(...safePoints.map((point) => point.y)) + padding;
  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
  };
}

function rectangularObjectBounds(object: CanvasObject): CanvasBounds {
  const center = {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2,
  };
  return boundsForPoints(
    [
      { x: object.x, y: object.y },
      { x: object.x + object.width, y: object.y },
      { x: object.x + object.width, y: object.y + object.height },
      { x: object.x, y: object.y + object.height },
    ].map((point) => rotateAround(point, center, object.rotation)),
  );
}

function drawObjectBounds(object: Extract<CanvasObject, { kind: "draw" }>): CanvasBounds {
  const origin = { x: 0, y: 0 };
  const points = object.points.map((point) => {
    const rotated = rotateAround(point, origin, object.rotation);
    return { x: object.x + rotated.x, y: object.y + rotated.y };
  });
  return boundsForPoints(points, SEMANTIC_DRAW_STROKE_WIDTHS[object.size] / 2);
}

function unionBounds(left: CanvasBounds | null, right: CanvasBounds): CanvasBounds {
  if (!left) return { ...right };
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return {
    x,
    y,
    width: Math.max(maxX - x, 1),
    height: Math.max(maxY - y, 1),
  };
}

function objectBounds(
  object: CanvasObject,
  connectorRoutes: Readonly<Record<string, ResolvedConnectorRoute>>,
): CanvasBounds {
  if (object.kind === "connector") {
    const route = connectorRoutes[object.id];
    // materializeConnectorRoutes returns every connector in the same room. The
    // fallback keeps this total if a future bounded materializer omits one.
    return route?.bounds ?? rectangularObjectBounds(object);
  }
  if (object.kind === "draw") return drawObjectBounds(object);
  if (object.kind === "path") return vectorPathBounds(object);
  return rectangularObjectBounds(object);
}

/** Project only the supplied artwork; endpoint context is not part of it. */
export function projectPersistedSemanticArtwork(
  artwork: Readonly<RoomState["objects"]>,
  endpointObjects: Readonly<RoomState["objects"]>,
): Pick<SemanticScene, "objects" | "bounds" | "connectorRoutes"> {
  const sorted = Object.values(artwork).sort(compareObjects);
  const connectorRoutes = Object.fromEntries(sorted.flatMap((object) =>
    object.kind === "connector"
      ? [[object.id, materializeConnectorRoute(object, { objects: endpointObjects })] as const]
      : [],
  ));
  const objects = sorted.map((object) => ({ object, bounds: objectBounds(object, connectorRoutes) }));
  const bounds = objects.reduce<CanvasBounds | null>(
    (current, item) => unionBounds(current, item.bounds),
    null,
  );
  return { objects, bounds, connectorRoutes };
}

/**
 * Derive a deterministic renderer-neutral scene from authoritative RoomState.
 *
 * This is projection-only work. By default connector geometry comes from
 * `materializeConnectorRoutes`, which preserves persisted endpoints and route
 * kinds and never performs obstacle search. An explicit optimistic connector
 * set is the sole exception: those routes are deterministically resolved
 * against the caller's already-overridden local document for frame-immediate
 * move previews.
 */
export function buildSemanticScene(
  room: SemanticSceneRoom,
  options: SemanticSceneBuildOptions = {},
  previousScene?: SemanticScene,
): SemanticScene {
  const sortedObjects = Object.values(room.objects).sort(compareObjects);
  const optimisticRouteIds = options.optimisticConnectorIds;
  // Like object-bound sharing, route reuse relies on immutable scene inputs.
  const materializeRoute = materializeSceneRoute(previousScene?.roomId === room.id ? previousScene : undefined);
  const materializedConnectorRoutes = optimisticRouteIds?.size
    ? resolveAffectedConnectorRoutes(room, optimisticRouteIds, undefined, materializeRoute)
    : materializeConnectorRoutes(room, undefined, materializeRoute);
  const connectorRoutes = Object.fromEntries(
    sortedObjects
      .filter((object) => object.kind === "connector")
      .map((object) => {
        const route = materializedConnectorRoutes[object.id];
        const previous = previousScene?.connectorRoutes[object.id];
        // Newly resolved routes can still match the previous projection.
        // Persisted cache hits take the identity fast path here.
        return [object.id, previous && equalDocumentValue(previous, route) ? previous : route];
      }),
  );
  const objects = sortedObjects.map((object): SemanticSceneObject => {
    const previous = previousScene?.objectsById[object.id];
    if (previous?.object === object && (
      object.kind !== "connector"
      || previousScene?.connectorRoutes[object.id] === connectorRoutes[object.id]
    )) return previous;
    return { object, bounds: objectBounds(object, connectorRoutes) };
  });
  const objectsById = Object.fromEntries(objects.map((item) => [item.object.id, item]));
  const bounds = objects.reduce<CanvasBounds | null>(
    (current, item) => unionBounds(current, item.bounds),
    null,
  );

  const membersByGroup = new Map<string, string[]>();
  for (const { object } of objects) {
    if (!object.groupId) continue;
    const members = membersByGroup.get(object.groupId) ?? [];
    members.push(object.id);
    membersByGroup.set(object.groupId, members);
  }
  const groupMembers = Object.fromEntries(
    [...membersByGroup.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );

  const scene: SemanticScene = {
    roomId: room.id,
    roomRevision: room.roomRevision,
    objects,
    objectsById,
    bounds,
    groupMembers,
    connectorRoutes,
  };
  optimisticRoutesByScene.set(scene, optimisticRouteIds?.size ? new Set(optimisticRouteIds) : noOptimisticRoutes);
  return scene;
}
