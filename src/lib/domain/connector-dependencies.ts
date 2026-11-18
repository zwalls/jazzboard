import {
  CONNECTOR_ROUTING_LIMITS,
  materializeConnectorRoutes,
  normalizeConnectorRouting,
  type ResolvedConnectorRoute,
} from "./connector-routing";
import type { CanvasBounds, CanvasObject, Diagram, RoomState } from "./types";

/**
 * The authoritative state needed to calculate connector dependencies. Keeping
 * this contract narrower than RoomState makes it safe to use in browser-side
 * optimistic previews without importing server coordination concerns.
 */
export type ConnectorDependencyRoom = Pick<RoomState, "objects" | "diagrams">;

export type ConnectorDependencyClosureInput = {
  /** State before the proposed object or diagram changes. */
  baseline: ConnectorDependencyRoom;
  /** State with the proposed changes already applied locally. */
  current: ConnectorDependencyRoom;
  /** Objects created, changed, or deleted by the proposed operation. */
  touchedObjectIds: ReadonlySet<string>;
  /** Diagrams created, changed, or deleted by the proposed operation. */
  touchedDiagramIds?: ReadonlySet<string>;
};

export type PotentialMoveConnectorInput = {
  /** Authoritative state at pointer-down. */
  room: ConnectorDependencyRoom;
  /** Non-connector objects whose geometry the gesture may translate. */
  movedObjectIds: ReadonlySet<string>;
  /** Connectors selected directly or pulled in through an explicit group. */
  explicitConnectorIds?: ReadonlySet<string>;
};

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
}

function unionCanvasBounds(left: CanvasBounds, right: CanvasBounds): CanvasBounds {
  const minX = Math.min(left.x, right.x);
  const minY = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

function expandCanvasBounds(bounds: CanvasBounds, padding: number): CanvasBounds {
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}

function canvasBoundsIntersect(left: CanvasBounds, right: CanvasBounds): boolean {
  return !(
    left.x + left.width < right.x ||
    right.x + right.width < left.x ||
    left.y + left.height < right.y ||
    right.y + right.height < left.y
  );
}

function routedObjectBounds(object: CanvasObject): CanvasBounds {
  const center = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  const cosine = Math.cos(object.rotation);
  const sine = Math.sin(object.rotation);
  const corners = [
    { x: object.x, y: object.y },
    { x: object.x + object.width, y: object.y },
    { x: object.x + object.width, y: object.y + object.height },
    { x: object.x, y: object.y + object.height },
  ].map((point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
      x: center.x + dx * cosine - dy * sine,
      y: center.y + dx * sine + dy * cosine,
    };
  });
  const minX = Math.min(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y));
  const maxX = Math.max(...corners.map((point) => point.x));
  const maxY = Math.max(...corners.map((point) => point.y));
  return { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

function objectGeometryChanged(before: CanvasObject | undefined, after: CanvasObject | undefined): boolean {
  if (!before || !after) return before !== after;
  return (
    before.x !== after.x ||
    before.y !== after.y ||
    before.width !== after.width ||
    before.height !== after.height ||
    before.rotation !== after.rotation
  );
}

function connectorPairKey(connector: Extract<CanvasObject, { kind: "connector" }>): string {
  const endpointKey = (endpoint: typeof connector.start): string => endpoint.objectId
    ? `object:${endpoint.objectId}`
    : `point:${Math.round(endpoint.x * 1_000) / 1_000},${Math.round(endpoint.y * 1_000) / 1_000}`;
  const start = endpointKey(connector.start);
  const end = endpointKey(connector.end);
  return start <= end ? `${start}\u0000${end}` : `${end}\u0000${start}`;
}

function autoIncidentSignature(object: CanvasObject | undefined): string | null {
  if (object?.kind !== "connector" || normalizeConnectorRouting(object.routing).mode !== "auto") {
    return null;
  }
  return `${object.start.objectId ?? ""}\u0000${object.end.objectId ?? ""}`;
}

function boundEndpointObjectIds(object: CanvasObject | undefined): string[] {
  if (object?.kind !== "connector") return [];
  return [object.start.objectId, object.end.objectId].filter(
    (objectId): objectId is string => Boolean(objectId),
  );
}

function connectorRouteInputChanged(
  before: CanvasObject | undefined,
  after: CanvasObject | undefined,
): boolean {
  if (before?.kind !== "connector" || after?.kind !== "connector") {
    return before?.kind === "connector" || after?.kind === "connector";
  }
  return (
    objectGeometryChanged(before, after) ||
    before.label !== after.label ||
    JSON.stringify(before.start) !== JSON.stringify(after.start) ||
    JSON.stringify(before.end) !== JSON.stringify(after.end) ||
    JSON.stringify(normalizeConnectorRouting(before.routing)) !==
      JSON.stringify(normalizeConnectorRouting(after.routing))
  );
}

type ConnectorScopes = ReadonlyMap<string, readonly Diagram[]>;

/** Index the forward memberships, including documents whose reverse index has not been normalized. */
function indexConnectorScopes(diagrams: ConnectorDependencyRoom["diagrams"]): ConnectorScopes {
  const scopes = new Map<string, Diagram[]>();
  for (const diagram of Object.values(diagrams ?? {})) {
    for (const connectorId of diagram.connectorIds) {
      const existing = scopes.get(connectorId);
      if (existing) existing.push(diagram);
      else scopes.set(connectorId, [diagram]);
    }
  }
  return scopes;
}

function connectorSeesObject(
  byConnector: ConnectorScopes,
  connectorId: string,
  objectId: string,
): boolean {
  const scopes = byConnector.get(connectorId);
  return !scopes || scopes.some((diagram) => diagram.memberObjectIds.includes(objectId));
}

function connectorScopesOverlap(
  byConnector: ConnectorScopes,
  leftConnectorId: string,
  rightConnectorId: string,
): boolean {
  const left = byConnector.get(leftConnectorId);
  const right = byConnector.get(rightConnectorId);
  // A connector without Diagram metadata is intentionally board-scoped.
  if (!left || !right) return true;
  return left.some((diagram) => right.some((other) => diagram.id === other.id));
}

/**
 * Conservatively preflight connector dependencies for a pointer move before
 * its future delta is known. Bound connectors always depend on their moved
 * endpoint. An auto route can see any moved shape in its Diagram scope, so it
 * must be protected even when the shape is not yet inside today's route
 * corridor. Later ordered auto routes are included transitively when they
 * share that scope, matching the ordered crossing dependency used by route
 * materialization without turning a scoped Diagram move into a board-global
 * lease cohort.
 */
export function computePotentialMoveConnectorIds({
  room,
  movedObjectIds,
  explicitConnectorIds = new Set<string>(),
}: PotentialMoveConnectorInput): Set<string> {
  const connectors = Object.values(room.objects)
    .filter((object): object is Extract<CanvasObject, { kind: "connector" }> => object.kind === "connector")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const order = new Map(connectors.map((connector, index) => [connector.id, index]));
  const movedShapeIds = [...movedObjectIds].filter(
    (objectId) => room.objects[objectId]?.kind === "shape",
  );
  const scopes = indexConnectorScopes(room.diagrams);
  const affected = new Set<string>();

  for (const connector of connectors) {
    if (explicitConnectorIds.has(connector.id)) {
      affected.add(connector.id);
      continue;
    }
    if (
      movedObjectIds.has(connector.start.objectId ?? "")
      || movedObjectIds.has(connector.end.objectId ?? "")
    ) {
      affected.add(connector.id);
      continue;
    }
    if (
      connector.routing?.mode === "auto"
      && movedShapeIds.some((objectId) => connectorSeesObject(scopes, connector.id, objectId))
    ) {
      affected.add(connector.id);
    }
  }

  const queue = [...affected];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const connectorId = queue[queueIndex]!;
    const sourceOrder = order.get(connectorId) ?? -1;
    for (const candidate of connectors) {
      if (
        affected.has(candidate.id)
        || candidate.routing?.mode !== "auto"
        || (order.get(candidate.id) ?? -1) <= sourceOrder
        || !connectorScopesOverlap(scopes, connectorId, candidate.id)
      ) {
        continue;
      }
      affected.add(candidate.id);
      queue.push(candidate.id);
    }
  }

  return affected;
}

function connectorInfluenceBounds(
  room: ConnectorDependencyRoom,
  connector: Extract<CanvasObject, { kind: "connector" }>,
  route: ResolvedConnectorRoute | undefined,
): CanvasBounds {
  let bounds = route?.bounds ?? {
    x: connector.x,
    y: connector.y,
    width: connector.width,
    height: connector.height,
  };
  for (const objectId of [connector.start.objectId, connector.end.objectId]) {
    const target = objectId ? room.objects[objectId] : undefined;
    if (target) bounds = unionCanvasBounds(bounds, routedObjectBounds(target));
  }
  return expandCanvasBounds(bounds, CONNECTOR_ROUTING_LIMITS.obstaclePadding);
}

/**
 * Return the complete set of connectors whose authoritative route can change
 * after a proposed edit. Clients can use the result to protect optimistic
 * pixels and acquire the same connector leases the server may need, while the
 * server uses it to select routes for deterministic recomputation.
 *
 * The returned Set has stable insertion order: directly affected connectors
 * follow creation/id order, followed by later ordered auto-route dependants.
 */
export function computeAffectedConnectorIds({
  baseline,
  current,
  touchedObjectIds,
  touchedDiagramIds = new Set<string>(),
}: ConnectorDependencyClosureInput): Set<string> {
  const affected = new Set<string>();
  const changedGeometryIds = new Set([...touchedObjectIds].filter((objectId) =>
    objectGeometryChanged(baseline.objects[objectId], current.objects[objectId]),
  ));
  const changedConnectorInputIds = new Set([...touchedObjectIds].filter((objectId) =>
    connectorRouteInputChanged(baseline.objects[objectId], current.objects[objectId]),
  ));
  const scopeChangedDiagramIds = new Set(
    [...touchedDiagramIds].filter((diagramId) => {
      const before = baseline.diagrams?.[diagramId];
      const after = current.diagrams?.[diagramId];
      return (
        !before ||
        !after ||
        !sameIdSet(before.memberObjectIds, after.memberObjectIds) ||
        !sameIdSet(before.connectorIds, after.connectorIds)
      );
    }),
  );

  // Text/style/metadata edits can still update the document and its Diagram
  // revisions, but without any route inputs changing there is no closure to
  // compute and no need to materialize either connector snapshot here.
  if (!changedGeometryIds.size && !changedConnectorInputIds.size && !scopeChangedDiagramIds.size) {
    return affected;
  }

  const baselineRoutes = materializeConnectorRoutes(baseline);
  const currentRoutes = materializeConnectorRoutes(current);
  const currentConnectors = Object.values(current.objects)
    .filter((object): object is Extract<CanvasObject, { kind: "connector" }> => object.kind === "connector")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const order = new Map(currentConnectors.map((connector, index) => [connector.id, index]));
  const changedObstacleIds = [...changedGeometryIds].filter((objectId) =>
    baseline.objects[objectId]?.kind === "shape" || current.objects[objectId]?.kind === "shape",
  );
  const baselineScopes = changedObstacleIds.length ? indexConnectorScopes(baseline.diagrams) : null;
  // Optimistic move frames keep the same Diagram map. Durable edits can
  // supply different memberships without changing object revisions.
  const currentScopes = baselineScopes && baseline.diagrams !== current.diagrams
    ? indexConnectorScopes(current.diagrams)
    : baselineScopes;

  for (const connector of currentConnectors) {
    if (changedConnectorInputIds.has(connector.id)) {
      affected.add(connector.id);
    }
    if (
      changedGeometryIds.has(connector.start.objectId ?? "") ||
      changedGeometryIds.has(connector.end.objectId ?? "")
    ) {
      affected.add(connector.id);
    }
    if (connector.routing?.mode !== "auto") continue;
    if ([...scopeChangedDiagramIds].some((diagramId) =>
      baseline.diagrams?.[diagramId]?.connectorIds.includes(connector.id) ||
      current.diagrams?.[diagramId]?.connectorIds.includes(connector.id),
    )) {
      affected.add(connector.id);
      continue;
    }
    const routeBounds = currentRoutes[connector.id]?.bounds;
    if (!routeBounds || !baselineScopes || !currentScopes) continue;
    for (const objectId of changedObstacleIds) {
      if (
        !connectorSeesObject(baselineScopes, connector.id, objectId) &&
        !connectorSeesObject(currentScopes, connector.id, objectId)
      ) {
        continue;
      }
      const before = baseline.objects[objectId];
      const after = current.objects[objectId];
      const impactBounds = before && after
        ? unionCanvasBounds(routedObjectBounds(before), routedObjectBounds(after))
        : routedObjectBounds((before ?? after)!);
      const priorRouteBounds = baselineRoutes[connector.id]?.bounds ?? routeBounds;
      if (
        canvasBoundsIntersect(priorRouteBounds, expandCanvasBounds(impactBounds, CONNECTOR_ROUTING_LIMITS.obstaclePadding)) ||
        canvasBoundsIntersect(routeBounds, expandCanvasBounds(impactBounds, CONNECTOR_ROUTING_LIMITS.obstaclePadding))
      ) {
        affected.add(connector.id);
        break;
      }
    }
  }

  // A create/delete or endpoint edit can change stable parallel-lane indexes.
  const affectedPairKeys = new Set<string>();
  for (const objectId of touchedObjectIds) {
    const before = baseline.objects[objectId];
    const after = current.objects[objectId];
    const beforePair = before?.kind === "connector" ? connectorPairKey(before) : null;
    const afterPair = after?.kind === "connector" ? connectorPairKey(after) : null;
    if (beforePair !== afterPair) {
      if (beforePair) affectedPairKeys.add(beforePair);
      if (afterPair) affectedPairKeys.add(afterPair);
    }
  }
  for (const connector of currentConnectors) {
    if (affectedPairKeys.has(connectorPairKey(connector))) affected.add(connector.id);
  }

  // Automatic ports are assigned as a stable cohort for every object side.
  // Adding, deleting, rebinding, or changing the routing mode of one auto
  // connector can therefore move every other automatic port incident to the
  // same object, even when the connectors do not share the same endpoint pair.
  const changedIncidentObjectIds = new Set<string>();
  for (const objectId of touchedObjectIds) {
    const before = baseline.objects[objectId];
    const after = current.objects[objectId];
    if (autoIncidentSignature(before) === autoIncidentSignature(after)) continue;
    for (const endpointObjectId of [...boundEndpointObjectIds(before), ...boundEndpointObjectIds(after)]) {
      changedIncidentObjectIds.add(endpointObjectId);
    }
  }
  if (changedIncidentObjectIds.size) {
    for (const connector of currentConnectors) {
      if (
        normalizeConnectorRouting(connector.routing).mode === "auto" &&
        [connector.start.objectId, connector.end.objectId].some(
          (objectId) => objectId && changedIncidentObjectIds.has(objectId),
        )
      ) {
        affected.add(connector.id);
      }
    }
  }

  // Crossing scores are ordered. Only later auto routes whose influence region
  // overlaps a changed route can depend on that changed route.
  // Every impact tests the same current snapshot. Reuse a candidate's bounds
  // across queue visits, but never across snapshots or pointer frames.
  const currentInfluenceBounds = new Map<string, CanvasBounds>();
  const currentInfluence = (connector: Extract<CanvasObject, { kind: "connector" }>): CanvasBounds => {
    const cached = currentInfluenceBounds.get(connector.id);
    if (cached) return cached;
    const bounds = connectorInfluenceBounds(current, connector, currentRoutes[connector.id]);
    currentInfluenceBounds.set(connector.id, bounds);
    return bounds;
  };
  const queue: Array<{
    connectorId: string;
    order: number;
    bounds: CanvasBounds;
  }> = [];
  for (const connectorId of affected) {
    const connector = current.objects[connectorId];
    if (connector?.kind !== "connector") continue;
    const before = baseline.objects[connectorId];
    const currentBounds = currentInfluence(connector);
    const bounds = before?.kind === "connector"
      ? unionCanvasBounds(
          currentBounds,
          connectorInfluenceBounds(baseline, before, baselineRoutes[connectorId]),
        )
      : currentBounds;
    queue.push({
      connectorId,
      order: order.get(connectorId) ?? -1,
      bounds,
    });
  }
  for (const objectId of touchedObjectIds) {
    const deleted = baseline.objects[objectId];
    if (deleted?.kind !== "connector" || current.objects[objectId]) continue;
    const firstLaterIndex = currentConnectors.findIndex((connector) =>
      connector.createdAt > deleted.createdAt ||
      (connector.createdAt === deleted.createdAt && connector.id.localeCompare(deleted.id) > 0),
    );
    queue.push({
      connectorId: deleted.id,
      order: (firstLaterIndex < 0 ? currentConnectors.length : firstLaterIndex) - 1,
      bounds: connectorInfluenceBounds(baseline, deleted, baselineRoutes[deleted.id]),
    });
  }
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const impact = queue[queueIndex];
    for (const connector of currentConnectors) {
      if (
        affected.has(connector.id) ||
        connector.routing?.mode !== "auto" ||
        (order.get(connector.id) ?? -1) <= impact.order
      ) {
        continue;
      }
      const candidateBounds = currentInfluence(connector);
      if (!canvasBoundsIntersect(impact.bounds, candidateBounds)) continue;
      affected.add(connector.id);
      queue.push({
        connectorId: connector.id,
        order: order.get(connector.id) ?? -1,
        bounds: candidateBounds,
      });
    }
  }
  return affected;
}
