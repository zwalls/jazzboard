import { randomUUID } from "node:crypto";

import { DomainError } from "./errors";
import {
  connectorLabelPrimaryClearance,
  minimumLayoutGaps,
} from "./layout";
import {
  CONNECTOR_ROUTING_BOUNDED_MAX_CANDIDATES,
  CONNECTOR_ROUTING_LIMITS,
  CONNECTOR_ROUTING_QUALITY_BATCH_LIMIT,
  connectorRouteBounds,
  materializeConnectorRoutes,
  normalizeConnectorRouting,
  resolveAffectedConnectorRoutes,
  type ResolvedConnectorRoute,
} from "./connector-routing";
import { MAX_ROOM_REVIEW_PROPOSALS } from "./review";
import type {
  ActorKind,
  ActorRef,
  CanvasCommand,
  CanvasObject,
  CanvasBounds,
  Diagram,
  DiagramCommand,
  DiagramNodeType,
  LayoutCommand,
  LeaseOperation,
  ObjectLease,
  NodeMetadata,
  NodeMetadataInput,
  Participant,
  RevertActivityRequest,
  RevertDiagramExpectation,
  RevertObjectExpectation,
  RoomActivity,
  RoomState,
  SemanticTransaction,
} from "./types";
import { roomBlobNamespace } from "@/lib/assets/private";
import {
  canonicalRoomAssetProxyPath,
  isRoomBlobPathname,
  parseRoomAssetProxyReference,
} from "@/lib/assets/policy";

export const LEASE_DURATION_MS = 4_000;

export function actorFor(participant: Participant, kind: ActorKind): ActorRef {
  return {
    participantId: participant.participantId,
    displayName: participant.displayName,
    color: participant.color,
    kind,
  };
}

function mutationActor(participant: Participant, kind: ActorKind, override?: ActorRef): ActorRef {
  if (!override) return actorFor(participant, kind);
  if (override.participantId !== participant.participantId || override.kind !== kind) {
    throw new DomainError("INVALID_OPERATION", "Mutation attribution must match the authorized participant and actor kind.");
  }
  return structuredClone(override);
}

export function requireParticipant(room: RoomState, participantId: string): Participant {
  const participant = room.participants[participantId];
  if (!participant) {
    throw new DomainError("FORBIDDEN", "This guest session is not a member of the room.");
  }
  return participant;
}

export function requireMutationRole(participant: Participant, actorKind: ActorKind): void {
  if (participant.role !== "participant") {
    throw new DomainError("FORBIDDEN", "Spectators cannot change the canvas.", {
      role: participant.role,
    });
  }
  if (actorKind === "agent" && participant.role !== "participant") {
    throw new DomainError("FORBIDDEN", "This session cannot connect an agent.");
  }
}

export function pruneExpiredLeases(room: RoomState, now: number): void {
  for (const [objectId, lease] of Object.entries(room.leases)) {
    if (lease.expiresAt <= now) delete room.leases[objectId];
  }
}

function getObject(room: RoomState, objectId: string): CanvasObject {
  const object = room.objects[objectId];
  if (!object) {
    throw new DomainError("OBJECT_NOT_FOUND", `Canvas object ${objectId} does not exist.`, {
      objectId,
    });
  }
  return object;
}

function verifyRevision(object: CanvasObject, expectedRevision: number): void {
  if (object.revision !== expectedRevision) {
    throw new DomainError(
      "REVISION_CONFLICT",
      `Canvas object ${object.id} changed from revision ${expectedRevision} to ${object.revision}.`,
      {
        objectId: object.id,
        expectedRevision,
        currentRevision: object.revision,
      },
    );
  }
}

function verifyLease(
  room: RoomState,
  object: CanvasObject,
  actor: ActorRef,
  leaseId: string | undefined,
  now: number,
): void {
  const lease = room.leases[object.id];
  if (!lease || lease.expiresAt <= now) return;

  const ownsLease =
    lease.actor.participantId === actor.participantId &&
    lease.actor.kind === actor.kind &&
    (!leaseId || lease.leaseId === leaseId);
  if (ownsLease) return;

  throw new DomainError("OBJECT_BUSY", `${lease.actor.displayName} is currently ${lease.operation}ing this object.`, {
    objectId: object.id,
    actor: lease.actor,
    operation: lease.operation,
    currentRevision: object.revision,
    expiresAt: lease.expiresAt,
  });
}

function touchRoom(room: RoomState, now: number): void {
  room.roomRevision += 1;
  room.stateRevision = (room.stateRevision ?? room.roomRevision - 1) + 1;
  room.updatedAt = now;
}

function touchCoordination(room: RoomState): void {
  room.stateRevision = (room.stateRevision ?? room.roomRevision) + 1;
}

function updateObject(object: CanvasObject, patch: Record<string, unknown>, actor: ActorRef, now: number): CanvasObject {
  return {
    ...object,
    ...patch,
    id: object.id,
    kind: object.kind,
    revision: object.revision + 1,
    createdAt: object.createdAt,
    createdBy: object.createdBy,
    updatedAt: now,
    lastEditedBy: actor,
  } as CanvasObject;
}

function validateImageReference(room: RoomState, object: CanvasObject): void {
  if (object.kind !== "image") return;
  const reference = parseRoomAssetProxyReference(object.url);
  if (!reference) return;
  if (
    reference.roomId !== room.id ||
    (reference.pathname !== null &&
      !isRoomBlobPathname(roomBlobNamespace(room.id), reference.pathname))
  ) {
    throw new DomainError(
      "INVALID_OPERATION",
      "A room image must use this room's authenticated asset reference.",
      { objectId: object.id },
    );
  }
  object.url = canonicalRoomAssetProxyPath(reference);
}

const COMMON_PATCH_FIELDS = new Set(["x", "y", "width", "height", "rotation", "zIndex", "groupId"]);
const KIND_PATCH_FIELDS: Record<CanvasObject["kind"], ReadonlySet<string>> = {
  text: new Set(["content", "color", "size", "align"]),
  shape: new Set(["shape", "nodeType", "nodeMetadata", "label", "fill", "stroke"]),
  connector: new Set(["start", "end", "routing", "direction", "label", "color"]),
  image: new Set(["url", "assetId", "alt", "mimeType", "sourceUrl", "locked"]),
  draw: new Set(["points", "color", "size"]),
};

function isLifecycleNodeType(nodeType: DiagramNodeType | null): nodeType is "decision" | "open_question" {
  return nodeType === "decision" || nodeType === "open_question";
}

export function defaultNodeMetadata(nodeType: DiagramNodeType | null): NodeMetadata | null {
  if (nodeType === "decision") {
    return { kind: "decision", status: "proposed", owner: null, resolution: null, resolvedAt: null };
  }
  if (nodeType === "open_question") {
    return { kind: "open_question", status: "open", owner: null, resolution: null, resolvedAt: null };
  }
  return null;
}

function cleanOptionalText(value: string | null, field: "owner" | "resolution", maxLength: number): string | null {
  if (value === null) return null;
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength) {
    throw new DomainError(
      "INVALID_OPERATION",
      `${field === "owner" ? "Node owner" : "Node resolution"} must be non-empty and no longer than ${maxLength} characters.`,
      { field, maxLength },
    );
  }
  return cleaned;
}

function authoritativeNodeMetadata(input: {
  nodeType: DiagramNodeType | null;
  requested: NodeMetadata | NodeMetadataInput | null | undefined;
  previous: NodeMetadata | null;
  now: number;
}): NodeMetadata | null {
  if (!isLifecycleNodeType(input.nodeType)) {
    if (input.requested !== undefined && input.requested !== null) {
      throw new DomainError("INVALID_OPERATION", "Only decision and open-question nodes can carry lifecycle metadata.", {
        nodeType: input.nodeType,
      });
    }
    return null;
  }

  const candidate = input.requested ?? (
    input.previous?.kind === input.nodeType ? input.previous : defaultNodeMetadata(input.nodeType)
  );
  if (!candidate || candidate.kind !== input.nodeType) {
    throw new DomainError("INVALID_OPERATION", "Node metadata kind must match the explicit node type.", {
      nodeType: input.nodeType,
      metadataKind: candidate?.kind ?? null,
    });
  }

  const owner = cleanOptionalText(candidate.owner, "owner", 160);
  const resolution = cleanOptionalText(candidate.resolution, "resolution", 10_000);
  const unresolved = candidate.kind === "decision"
    ? candidate.status === "proposed"
    : candidate.status === "open";
  if (unresolved && resolution !== null) {
    throw new DomainError("INVALID_OPERATION", "An unresolved decision or question cannot carry a resolution.", {
      nodeType: candidate.kind,
      status: candidate.status,
    });
  }
  if (!unresolved && resolution === null) {
    throw new DomainError("INVALID_OPERATION", "A resolved decision or non-open question requires a resolution or deferral note.", {
      nodeType: candidate.kind,
      status: candidate.status,
    });
  }

  const sameResolvedState = Boolean(
    !unresolved &&
    input.previous?.kind === candidate.kind &&
    input.previous.status === candidate.status &&
    input.previous.owner === owner &&
    input.previous.resolution === resolution &&
    input.previous.resolvedAt !== null,
  );
  return {
    ...candidate,
    owner,
    resolution,
    resolvedAt: unresolved ? null : sameResolvedState ? input.previous!.resolvedAt : input.now,
  } as NodeMetadata;
}

function validatePatchForObject(object: CanvasObject, patch: Record<string, unknown>): void {
  const invalidFields = Object.keys(patch).filter(
    (field) => !COMMON_PATCH_FIELDS.has(field) && !KIND_PATCH_FIELDS[object.kind].has(field),
  );
  if (invalidFields.length) {
    throw new DomainError(
      "INVALID_OPERATION",
      `A ${object.kind} object cannot be updated with ${invalidFields.join(", ")}.`,
      { objectId: object.id, kind: object.kind, invalidFields },
    );
  }
}

const EMPTY_BOUNDS: CanvasBounds = { x: 0, y: 0, width: 1, height: 1 };

export const BULK_CONNECTOR_ROUTING_THRESHOLD = CONNECTOR_ROUTING_QUALITY_BATCH_LIMIT;
export const BULK_CONNECTOR_MAX_CANDIDATES = CONNECTOR_ROUTING_BOUNDED_MAX_CANDIDATES;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
}

function samePoint(left: { x: number; y: number }, right: { x: number; y: number }): boolean {
  return left.x === right.x && left.y === right.y;
}

function connectorGeometry(route: ResolvedConnectorRoute) {
  const bounds = connectorRouteBounds(route.points, 0);
  return {
    ...bounds,
    rotation: 0,
    start: route.start,
    end: route.end,
    routing: route.routing,
  };
}

function boundsFor(
  room: RoomState,
  objectIds: readonly string[],
  resolvedRoutes?: Record<string, ResolvedConnectorRoute>,
): CanvasBounds {
  const objects = unique(objectIds).flatMap((id) => room.objects[id] ?? []);
  if (!objects.length) return { ...EMPTY_BOUNDS };
  const bounds = objects.map((object) => {
    if (object.kind === "connector") {
      return resolvedRoutes?.[object.id]?.bounds ?? {
        x: object.x,
        y: object.y,
        width: object.width,
        height: object.height,
      };
    }
    return {
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
    };
  });
  const minX = Math.min(...bounds.map((bound) => bound.x));
  const minY = Math.min(...bounds.map((bound) => bound.y));
  const maxX = Math.max(...bounds.map((bound) => bound.x + bound.width));
  const maxY = Math.max(...bounds.map((bound) => bound.y + bound.height));
  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
  };
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

function connectorSeesObject(
  room: RoomState,
  connectorId: string,
  objectId: string,
): boolean {
  const scopes = Object.values(room.diagrams ?? {}).filter((diagram) =>
    diagram.connectorIds.includes(connectorId),
  );
  return scopes.length === 0 || scopes.some((diagram) => diagram.memberObjectIds.includes(objectId));
}

function connectorInfluenceBounds(
  room: RoomState,
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

function affectedConnectorIds(
  baseline: RoomState,
  room: RoomState,
  touchedObjectIds: ReadonlySet<string>,
  touchedDiagramIds: ReadonlySet<string>,
): Set<string> {
  const baselineRoutes = materializeConnectorRoutes(baseline);
  const currentRoutes = materializeConnectorRoutes(room);
  const currentConnectors = Object.values(room.objects)
    .filter((object): object is Extract<CanvasObject, { kind: "connector" }> => object.kind === "connector")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const order = new Map(currentConnectors.map((connector, index) => [connector.id, index]));
  const affected = new Set<string>();
  const changedGeometryIds = new Set([...touchedObjectIds].filter((objectId) =>
    objectGeometryChanged(baseline.objects[objectId], room.objects[objectId]),
  ));
  const changedObstacleIds = [...changedGeometryIds].filter((objectId) =>
    baseline.objects[objectId]?.kind === "shape" || room.objects[objectId]?.kind === "shape",
  );
  const scopeChangedDiagramIds = new Set(
    [...touchedDiagramIds].filter((diagramId) => {
      const before = baseline.diagrams?.[diagramId];
      const after = room.diagrams?.[diagramId];
      return (
        !before ||
        !after ||
        !sameIdSet(before.memberObjectIds, after.memberObjectIds) ||
        !sameIdSet(before.connectorIds, after.connectorIds)
      );
    }),
  );

  for (const connector of currentConnectors) {
    if (
      touchedObjectIds.has(connector.id) &&
      connectorRouteInputChanged(baseline.objects[connector.id], connector)
    ) {
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
      room.diagrams?.[diagramId]?.connectorIds.includes(connector.id),
    )) {
      affected.add(connector.id);
      continue;
    }
    const routeBounds = currentRoutes[connector.id]?.bounds;
    if (!routeBounds) continue;
    for (const objectId of changedObstacleIds) {
      if (
        !connectorSeesObject(baseline, connector.id, objectId) &&
        !connectorSeesObject(room, connector.id, objectId)
      ) {
        continue;
      }
      const before = baseline.objects[objectId];
      const after = room.objects[objectId];
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
    const after = room.objects[objectId];
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

  // Crossing scores are ordered. Only later auto routes whose influence region
  // overlaps a changed route can depend on that changed route.
  const queue: Array<{
    connectorId: string;
    order: number;
    bounds: CanvasBounds;
    endpointObjectIds: ReadonlySet<string>;
  }> = [];
  for (const connectorId of affected) {
    const connector = room.objects[connectorId];
    if (connector?.kind !== "connector") continue;
    const before = baseline.objects[connectorId];
    const currentBounds = connectorInfluenceBounds(room, connector, currentRoutes[connectorId]);
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
      endpointObjectIds: new Set(
        [connector.start.objectId, connector.end.objectId].filter((id): id is string => Boolean(id)),
      ),
    });
  }
  for (const objectId of touchedObjectIds) {
    const deleted = baseline.objects[objectId];
    if (deleted?.kind !== "connector" || room.objects[objectId]) continue;
    const firstLaterIndex = currentConnectors.findIndex((connector) =>
      connector.createdAt > deleted.createdAt ||
      (connector.createdAt === deleted.createdAt && connector.id.localeCompare(deleted.id) > 0),
    );
    queue.push({
      connectorId: deleted.id,
      order: (firstLaterIndex < 0 ? currentConnectors.length : firstLaterIndex) - 1,
      bounds: connectorInfluenceBounds(baseline, deleted, baselineRoutes[deleted.id]),
      endpointObjectIds: new Set(
        [deleted.start.objectId, deleted.end.objectId].filter((id): id is string => Boolean(id)),
      ),
    });
  }
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const impact = queue[queueIndex];
    for (const connector of currentConnectors) {
      if (
        affected.has(connector.id) ||
        connector.routing?.mode !== "auto" ||
        (order.get(connector.id) ?? -1) <= impact.order ||
        [connector.start.objectId, connector.end.objectId].some(
          (objectId) => objectId && impact.endpointObjectIds.has(objectId),
        )
      ) {
        continue;
      }
      const candidateBounds = connectorInfluenceBounds(room, connector, currentRoutes[connector.id]);
      if (!canvasBoundsIntersect(impact.bounds, candidateBounds)) continue;
      affected.add(connector.id);
      queue.push({
        connectorId: connector.id,
        order: order.get(connector.id) ?? -1,
        bounds: candidateBounds,
        endpointObjectIds: new Set(
          [connector.start.objectId, connector.end.objectId].filter((id): id is string => Boolean(id)),
        ),
      });
    }
  }
  return affected;
}

function diagramComparable(diagram: Diagram) {
  return {
    title: diagram.title,
    description: diagram.description,
    diagramType: diagram.diagramType,
    category: diagram.category,
    tags: diagram.tags,
    memberObjectIds: diagram.memberObjectIds,
    connectorIds: diagram.connectorIds,
    bounds: diagram.bounds,
  };
}

function connectorGeometryChanged(
  connector: Extract<CanvasObject, { kind: "connector" }>,
  geometry: ReturnType<typeof connectorGeometry>,
): boolean {
  return (
    connector.x !== geometry.x ||
    connector.y !== geometry.y ||
    connector.width !== geometry.width ||
    connector.height !== geometry.height ||
    connector.rotation !== geometry.rotation ||
    connector.start.objectId !== geometry.start.objectId ||
    connector.end.objectId !== geometry.end.objectId ||
    !samePoint(connector.start, geometry.start) ||
    !samePoint(connector.end, geometry.end) ||
    JSON.stringify(connector.start) !== JSON.stringify(geometry.start) ||
    JSON.stringify(connector.end) !== JSON.stringify(geometry.end) ||
    JSON.stringify(normalizeConnectorRouting(connector.routing)) !== JSON.stringify(geometry.routing)
  );
}

/**
 * Migrates old persisted rooms into the current authoritative semantic model.
 * The caller must pass a private room copy because this function mutates it.
 */
export function normalizeRoomSemanticState(room: RoomState): RoomState {
  room.stateRevision = Math.max(room.stateRevision ?? room.roomRevision, room.roomRevision);
  room.diagrams ??= {};
  room.agentEditPolicy = room.agentEditPolicy === "review" ? "review" : "live";
  room.reviewProposals = Array.isArray(room.reviewProposals)
    ? room.reviewProposals
        .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
        .slice(0, MAX_ROOM_REVIEW_PROPOSALS)
    : [];
  for (const object of Object.values(room.objects)) {
    object.diagramIds = [];
    if (object.kind === "shape") {
      if (object.nodeType === undefined) object.nodeType = null;
      const persisted = (object as typeof object & { nodeMetadata?: NodeMetadata | null }).nodeMetadata;
      if (!isLifecycleNodeType(object.nodeType)) {
        object.nodeMetadata = null;
      } else if (persisted?.kind === object.nodeType) {
        try {
          object.nodeMetadata = authoritativeNodeMetadata({
            nodeType: object.nodeType,
            requested: persisted,
            previous: persisted,
            now: object.updatedAt,
          });
        } catch {
          object.nodeMetadata = defaultNodeMetadata(object.nodeType);
        }
      } else {
        object.nodeMetadata = defaultNodeMetadata(object.nodeType);
      }
    } else if (object.kind === "connector") {
      object.routing = normalizeConnectorRouting(object.routing);
    }
  }

  // Reads only materialize the canonical persisted route. Obstacle-aware
  // resolution belongs to a revision-checked mutation; doing it here made
  // polling both quadratic and capable of silently rewriting route geometry.
  const materializedRoutes = materializeConnectorRoutes(room);

  for (const diagram of Object.values(room.diagrams)) {
    diagram.tags = unique(diagram.tags ?? []);
    diagram.memberObjectIds = unique(diagram.memberObjectIds ?? []).filter(
      (id) => room.objects[id] && room.objects[id].kind !== "connector",
    );
    diagram.connectorIds = unique(diagram.connectorIds ?? []).filter(
      (id) => room.objects[id]?.kind === "connector",
    );
    diagram.bounds = boundsFor(room, [...diagram.memberObjectIds, ...diagram.connectorIds], materializedRoutes);
    for (const objectId of [...diagram.memberObjectIds, ...diagram.connectorIds]) {
      const object = room.objects[objectId];
      if (object) object.diagramIds.push(diagram.id);
    }
  }
  for (const object of Object.values(room.objects)) object.diagramIds.sort();
  return room;
}

function validateConnectorReferences(room: RoomState, object: CanvasObject): void {
  if (object.kind !== "connector") return;
  for (const [terminal, endpoint] of [["start", object.start], ["end", object.end]] as const) {
    if (!endpoint.objectId) continue;
    const target = room.objects[endpoint.objectId];
    if (!target) {
      throw new DomainError("OBJECT_NOT_FOUND", `Connector ${terminal} object ${endpoint.objectId} does not exist.`, {
        objectId: endpoint.objectId,
        connectorId: object.id,
        terminal,
      });
    }
    if (target.kind === "connector") {
      throw new DomainError("INVALID_OPERATION", "A connector endpoint must reference a non-connector canvas object.", {
        objectId: endpoint.objectId,
        connectorId: object.id,
        terminal,
      });
    }
  }
}

function validateDiagramMembers(room: RoomState, diagram: Pick<Diagram, "id" | "memberObjectIds" | "connectorIds">): void {
  const memberIds = unique(diagram.memberObjectIds);
  const connectorIds = unique(diagram.connectorIds);
  if (memberIds.length !== diagram.memberObjectIds.length || connectorIds.length !== diagram.connectorIds.length) {
    throw new DomainError("INVALID_OPERATION", "Diagram membership IDs must be unique.", { diagramId: diagram.id });
  }
  const overlap = memberIds.find((id) => connectorIds.includes(id));
  if (overlap) {
    throw new DomainError("INVALID_OPERATION", "An object cannot be both a diagram member and connector.", {
      diagramId: diagram.id,
      objectId: overlap,
    });
  }
  for (const objectId of memberIds) {
    const object = room.objects[objectId];
    if (!object) {
      throw new DomainError("OBJECT_NOT_FOUND", `Diagram member ${objectId} does not exist.`, {
        diagramId: diagram.id,
        objectId,
      });
    }
    if (object.kind === "connector") {
      throw new DomainError("INVALID_OPERATION", "Connectors belong in connectorIds, not memberObjectIds.", {
        diagramId: diagram.id,
        objectId,
      });
    }
  }
  for (const connectorId of connectorIds) {
    const object = room.objects[connectorId];
    if (!object) {
      throw new DomainError("OBJECT_NOT_FOUND", `Diagram connector ${connectorId} does not exist.`, {
        diagramId: diagram.id,
        objectId: connectorId,
      });
    }
    if (object.kind !== "connector") {
      throw new DomainError("INVALID_OPERATION", "connectorIds may contain only connector objects.", {
        diagramId: diagram.id,
        objectId: connectorId,
      });
    }
  }
}

function assertUniqueTouch(touched: Set<string>, objectId: string): void {
  if (touched.has(objectId)) {
    throw new DomainError(
      "INVALID_OPERATION",
      `Canvas object ${objectId} is targeted more than once in one semantic transaction. Combine its changes into one operation.`,
      { objectId },
    );
  }
  touched.add(objectId);
}

function applyObjectCommandMutable(
  room: RoomState,
  command: CanvasCommand,
  actor: ActorRef,
  now: number,
  touched: Set<string>,
): void {
  switch (command.type) {
    case "create": {
      if (room.objects[command.object.id] || room.diagrams[command.object.id]) {
        throw new DomainError(
          "INVALID_OPERATION",
          `Semantic ID ${command.object.id} already belongs to an object or Diagram in this room.`,
          { id: command.object.id },
        );
      }
      assertUniqueTouch(touched, command.object.id);
      const object = {
        ...command.object,
        diagramIds: [],
        ...(command.object.kind === "shape"
          ? {
              nodeType: command.object.nodeType ?? null,
              nodeMetadata: authoritativeNodeMetadata({
                nodeType: command.object.nodeType ?? null,
                requested: command.object.nodeMetadata,
                previous: null,
                now,
              }),
            }
          : {}),
        ...(command.object.kind === "connector"
          ? { routing: normalizeConnectorRouting(command.object.routing) }
          : {}),
        revision: 1,
        createdAt: now,
        updatedAt: now,
        createdBy: actor,
        lastEditedBy: actor,
      } as CanvasObject;
      validateConnectorReferences(room, object);
      validateImageReference(room, object);
      room.objects[object.id] = object;
      break;
    }
    case "update": {
      assertUniqueTouch(touched, command.objectId);
      const object = getObject(room, command.objectId);
      verifyLease(room, object, actor, command.leaseId, now);
      verifyRevision(object, command.expectedRevision);
      validatePatchForObject(object, command.patch as Record<string, unknown>);
      let patch = command.patch as Record<string, unknown>;
      if (object.kind === "shape" && ("nodeType" in patch || "nodeMetadata" in patch)) {
        const nextNodeType = "nodeType" in patch
          ? (patch.nodeType as DiagramNodeType | null)
          : object.nodeType;
        const requested = "nodeMetadata" in patch
          ? (patch.nodeMetadata as NodeMetadataInput | null)
          : nextNodeType === object.nodeType
            ? object.nodeMetadata ?? null
            : undefined;
        patch = {
          ...patch,
          nodeType: nextNodeType,
          nodeMetadata: authoritativeNodeMetadata({
            nodeType: nextNodeType,
            requested,
            previous: object.nodeMetadata ?? null,
            now,
          }),
        };
      }
      if (object.kind === "connector" && "routing" in patch) {
        patch = {
          ...patch,
          routing: normalizeConnectorRouting(
            patch.routing as Parameters<typeof normalizeConnectorRouting>[0],
          ),
        };
      }
      const updated = updateObject(object, patch, actor, now);
      validateConnectorReferences(room, updated);
      validateImageReference(room, updated);
      room.objects[object.id] = updated;
      break;
    }
    case "delete": {
      for (const target of command.targets) {
        assertUniqueTouch(touched, target.objectId);
        const object = getObject(room, target.objectId);
        verifyLease(room, object, actor, target.leaseId, now);
        verifyRevision(object, target.expectedRevision);
      }
      for (const target of command.targets) {
        delete room.objects[target.objectId];
        delete room.leases[target.objectId];
      }
      break;
    }
    case "move": {
      for (const target of command.targets) {
        assertUniqueTouch(touched, target.objectId);
        const object = getObject(room, target.objectId);
        verifyLease(room, object, actor, target.leaseId, now);
        verifyRevision(object, target.expectedRevision);
      }
      for (const target of command.targets) {
        const object = room.objects[target.objectId];
        room.objects[target.objectId] = updateObject(object, { x: target.x, y: target.y }, actor, now);
      }
      break;
    }
    case "group": {
      for (const target of command.targets) {
        assertUniqueTouch(touched, target.objectId);
        const object = getObject(room, target.objectId);
        verifyLease(room, object, actor, target.leaseId, now);
        verifyRevision(object, target.expectedRevision);
      }
      for (const target of command.targets) {
        const object = room.objects[target.objectId];
        room.objects[target.objectId] = updateObject(object, { groupId: command.groupId }, actor, now);
      }
      break;
    }
  }
}

function applyDiagramCommandMutable(
  room: RoomState,
  command: DiagramCommand,
  actor: ActorRef,
  now: number,
  touched: Set<string>,
): void {
  const diagrams = room.diagrams ?? (room.diagrams = {});
  if (command.type === "diagram.create") {
    if (diagrams[command.diagram.id] || room.objects[command.diagram.id]) {
      throw new DomainError(
        "INVALID_OPERATION",
        `Semantic ID ${command.diagram.id} already belongs to an object or Diagram in this room.`,
        { id: command.diagram.id },
      );
    }
    if (touched.has(command.diagram.id)) {
      throw new DomainError("INVALID_OPERATION", `Diagram ${command.diagram.id} is targeted more than once.`, {
        diagramId: command.diagram.id,
      });
    }
    touched.add(command.diagram.id);
    validateDiagramMembers(room, command.diagram);
    diagrams[command.diagram.id] = {
      ...command.diagram,
      tags: unique(command.diagram.tags),
      memberObjectIds: [...command.diagram.memberObjectIds],
      connectorIds: [...command.diagram.connectorIds],
      bounds: boundsFor(room, [...command.diagram.memberObjectIds, ...command.diagram.connectorIds]),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      lastEditedBy: actor,
    };
    return;
  }

  const diagram = diagrams[command.diagramId];
  if (!diagram) {
    throw new DomainError("DIAGRAM_NOT_FOUND", `Diagram ${command.diagramId} does not exist.`, {
      diagramId: command.diagramId,
    });
  }
  if (touched.has(command.diagramId)) {
    throw new DomainError("INVALID_OPERATION", `Diagram ${command.diagramId} is targeted more than once.`, {
      diagramId: command.diagramId,
    });
  }
  touched.add(command.diagramId);
  if (diagram.revision !== command.expectedRevision) {
    throw new DomainError(
      "REVISION_CONFLICT",
      `Diagram ${diagram.id} changed from revision ${command.expectedRevision} to ${diagram.revision}.`,
      { diagramId: diagram.id, expectedRevision: command.expectedRevision, currentRevision: diagram.revision },
    );
  }
  const updated = { ...diagram, ...command.patch };
  validateDiagramMembers(room, updated);
  diagrams[diagram.id] = {
    ...updated,
    id: diagram.id,
    createdAt: diagram.createdAt,
    createdBy: diagram.createdBy,
    revision: diagram.revision,
    updatedAt: now,
    lastEditedBy: actor,
  };
}

export type SemanticMutationResult = {
  room: RoomState;
  changedObjectIds: string[];
  changedDiagramIds: string[];
  membershipObjectIds: string[];
  positions?: Array<{ objectId: string; x: number; y: number }>;
};

export function applySemanticTransaction(
  source: RoomState,
  participantId: string,
  actorKind: ActorKind,
  transaction: SemanticTransaction,
  now = Date.now(),
  actorOverride?: ActorRef,
): SemanticMutationResult {
  if (transaction.commands.length + transaction.diagramCommands.length + (transaction.autoLayout ? 1 : 0) === 0) {
    throw new DomainError("INVALID_OPERATION", "A semantic transaction requires at least one operation.");
  }
  const room = normalizeRoomSemanticState(structuredClone(source));
  const baseline = structuredClone(room);
  const participant = requireParticipant(room, participantId);
  requireMutationRole(participant, actorKind);
  const actor = mutationActor(participant, actorKind, actorOverride);
  pruneExpiredLeases(room, now);
  const touchedObjectIds = new Set<string>();
  const touchedDiagramIds = new Set<string>();

  for (const command of transaction.commands) {
    applyObjectCommandMutable(room, command, actor, now, touchedObjectIds);
  }
  for (const command of transaction.diagramCommands) {
    applyDiagramCommandMutable(room, command, actor, now, touchedDiagramIds);
  }
  const positions = transaction.autoLayout
    ? applyLayoutMutable(room, baseline, transaction.autoLayout, actor, now, touchedObjectIds)
    : undefined;

  // Bound connector geometry is authoritative server state. Implicit changes
  // honor active-object leases and receive the same actor attribution.
  const connectorIdsToResolve = affectedConnectorIds(
    baseline,
    room,
    touchedObjectIds,
    touchedDiagramIds,
  );
  const resolvedRoutes = resolveAffectedConnectorRoutes(
    room,
    connectorIdsToResolve,
    connectorIdsToResolve.size > BULK_CONNECTOR_ROUTING_THRESHOLD
      ? { resolutionMode: "bounded", maxCandidates: BULK_CONNECTOR_MAX_CANDIDATES }
      : undefined,
  );
  for (const object of Object.values(room.objects)) {
    if (object.kind !== "connector") continue;
    if (!connectorIdsToResolve.has(object.id)) continue;
    const route = resolvedRoutes[object.id];
    if (!route) continue;
    const geometry = connectorGeometry(route);
    if (!connectorGeometryChanged(object, geometry)) continue;
    const wasExplicitlyTouched = touchedObjectIds.has(object.id);
    if (!wasExplicitlyTouched && baseline.objects[object.id]) verifyLease(room, object, actor, undefined, now);
    Object.assign(object, geometry);
    if (!wasExplicitlyTouched && baseline.objects[object.id]) {
      object.revision += 1;
      object.updatedAt = now;
      object.lastEditedBy = actor;
    }
    touchedObjectIds.add(object.id);
  }

  const diagrams = room.diagrams ?? (room.diagrams = {});
  const baselineDiagrams = baseline.diagrams ?? {};
  const memberTouchedDiagramIds = new Set<string>();
  for (const objectId of touchedObjectIds) {
    for (const diagramId of baseline.objects[objectId]?.diagramIds ?? []) {
      memberTouchedDiagramIds.add(diagramId);
    }
    for (const diagram of Object.values(baselineDiagrams)) {
      if (diagram.memberObjectIds.includes(objectId) || diagram.connectorIds.includes(objectId)) {
        memberTouchedDiagramIds.add(diagram.id);
      }
    }
    for (const diagram of Object.values(diagrams)) {
      if (diagram.memberObjectIds.includes(objectId) || diagram.connectorIds.includes(objectId)) {
        memberTouchedDiagramIds.add(diagram.id);
      }
    }
  }
  for (const diagram of Object.values(diagrams)) {
    const wasExplicitlyTouched = touchedDiagramIds.has(diagram.id);
    if (!wasExplicitlyTouched) {
      diagram.memberObjectIds = unique(diagram.memberObjectIds).filter(
        (id) => room.objects[id] && room.objects[id].kind !== "connector",
      );
      diagram.connectorIds = unique(diagram.connectorIds).filter(
        (id) => room.objects[id]?.kind === "connector",
      );
    }
    diagram.tags = unique(diagram.tags);
    diagram.bounds = boundsFor(room, [...diagram.memberObjectIds, ...diagram.connectorIds], resolvedRoutes);
    const before = baselineDiagrams[diagram.id];
    if (!before) {
      touchedDiagramIds.add(diagram.id);
    } else if (
      wasExplicitlyTouched ||
      memberTouchedDiagramIds.has(diagram.id) ||
      JSON.stringify(diagramComparable(before)) !== JSON.stringify(diagramComparable(diagram))
    ) {
      diagram.revision = before.revision + 1;
      diagram.updatedAt = now;
      diagram.lastEditedBy = actor;
      touchedDiagramIds.add(diagram.id);
    }
  }

  // Diagram records are the source of truth; object.diagramIds is a
  // normalized reverse index for efficient semantic query and neighborhood reads.
  for (const object of Object.values(room.objects)) object.diagramIds = [];
  for (const diagram of Object.values(diagrams)) {
    for (const objectId of [...diagram.memberObjectIds, ...diagram.connectorIds]) {
      const object = room.objects[objectId];
      if (object) object.diagramIds.push(diagram.id);
    }
  }
  for (const object of Object.values(room.objects)) object.diagramIds.sort();
  const membershipObjectIds = Object.values(room.objects)
    .filter((object) => {
      const previous = baseline.objects[object.id]?.diagramIds ?? [];
      return JSON.stringify(previous) !== JSON.stringify(object.diagramIds);
    })
    .map((object) => object.id);

  if (actorKind === "agent") {
    room.participants[participantId].agentActive = true;
    room.participants[participantId].agent.lastSeenAt = now;
  }
  touchRoom(room, now);
  return {
    room,
    changedObjectIds: [...touchedObjectIds],
    changedDiagramIds: [...touchedDiagramIds],
    membershipObjectIds,
    ...(positions ? { positions } : {}),
  };
}

export function applyCanvasCommand(
  source: RoomState,
  participantId: string,
  actorKind: ActorKind,
  command: CanvasCommand,
  now = Date.now(),
  actorOverride?: ActorRef,
): { room: RoomState; changedObjectIds: string[] } {
  const result = applySemanticTransaction(
    source,
    participantId,
    actorKind,
    { commands: [command], diagramCommands: [] },
    now,
    actorOverride,
  );
  return { room: result.room, changedObjectIds: result.changedObjectIds };
}

function rejectUnsafeRevert(message: string, details?: Record<string, unknown>): never {
  throw new DomainError("REVISION_CONFLICT", message, details);
}

function mapUniqueExpectations<T extends { state: "present" | "absent" }>(
  expectations: readonly T[],
  idFor: (expectation: T) => string,
  entityType: "object" | "Diagram",
): Map<string, T> {
  const result = new Map<string, T>();
  for (const expectation of expectations) {
    const id = idFor(expectation);
    if (result.has(id)) {
      throw new DomainError("INVALID_OPERATION", `${entityType} revert expectations must be unique.`, { id });
    }
    result.set(id, expectation);
  }
  return result;
}

function assertExactExpectationIds(
  expectedIds: readonly string[],
  actualIds: Iterable<string>,
  entityType: "object" | "Diagram",
): void {
  const expected = new Set(expectedIds);
  const actual = new Set(actualIds);
  const missingIds = [...expected].filter((id) => !actual.has(id));
  const extraIds = [...actual].filter((id) => !expected.has(id));
  if (missingIds.length || extraIds.length) {
    rejectUnsafeRevert(`Reverting this activity requires exact ${entityType} post-state guards.`, {
      entityType,
      missingIds,
      extraIds,
    });
  }
}

function expectationMatchesGuard(
  expectation: RevertObjectExpectation | RevertDiagramExpectation,
  guard: { state: "present"; revision: number } | { state: "absent" },
): boolean {
  return expectation.state === guard.state &&
    (expectation.state === "absent" || (guard.state === "present" && expectation.expectedRevision === guard.revision));
}

function geometryChanged(before: CanvasObject | null, after: CanvasObject | null): boolean {
  if (!before || !after) return true;
  return before.x !== after.x || before.y !== after.y || before.width !== after.width ||
    before.height !== after.height || before.rotation !== after.rotation;
}

function validateRevertDependencies(room: RoomState, activity: RoomActivity): void {
  const guardedObjectIds = new Set(Object.keys(activity.objectGuards));
  const guardedDiagramIds = new Set(Object.keys(activity.diagramGuards));
  const dependencySensitiveIds = new Set(
    activity.objectChanges
      .filter((change) => change.mode === "direct" && geometryChanged(change.before, change.after))
      .map((change) => change.objectId),
  );
  if (!dependencySensitiveIds.size) return;

  const externalConnectorIds = Object.values(room.objects)
    .filter((object) => object.kind === "connector")
    .filter(
      (connector) =>
        (connector.start.objectId !== null && dependencySensitiveIds.has(connector.start.objectId)) ||
        (connector.end.objectId !== null && dependencySensitiveIds.has(connector.end.objectId)),
    )
    .map((connector) => connector.id)
    .filter((connectorId) => !guardedObjectIds.has(connectorId));

  const externalDiagramIds = Object.values(room.diagrams ?? {})
    .filter((diagram) =>
      [...diagram.memberObjectIds, ...diagram.connectorIds].some((objectId) => dependencySensitiveIds.has(objectId)),
    )
    .map((diagram) => diagram.id)
    .filter((diagramId) => !guardedDiagramIds.has(diagramId));

  if (externalConnectorIds.length || externalDiagramIds.length) {
    rejectUnsafeRevert(
      "The activity cannot be reverted because later relationships depend on an affected object.",
      {
        activityId: activity.id,
        objectIds: [...dependencySensitiveIds],
        externalConnectorIds,
        externalDiagramIds,
      },
    );
  }
}

/**
 * Applies a compensating mutation for a recorded activity. This never rewinds
 * room history: every restored entity receives a new revision and attribution.
 */
export function applyActivityRevert(
  source: RoomState,
  participantId: string,
  actorKind: ActorKind,
  activity: RoomActivity,
  request: RevertActivityRequest,
  now = Date.now(),
  actorOverride?: ActorRef,
): SemanticMutationResult {
  if (activity.roomId !== source.id || request.activityId !== activity.id) {
    throw new DomainError("INVALID_OPERATION", "The requested activity does not belong to this room.", {
      activityId: request.activityId,
    });
  }
  const room = normalizeRoomSemanticState(structuredClone(source));
  const baseline = structuredClone(room);
  const participant = requireParticipant(room, participantId);
  requireMutationRole(participant, actorKind);
  const actor = mutationActor(participant, actorKind, actorOverride);
  pruneExpiredLeases(room, now);

  const objectExpectations = mapUniqueExpectations(
    request.objectExpectations,
    (expectation) => expectation.objectId,
    "object",
  );
  const diagramExpectations = mapUniqueExpectations(
    request.diagramExpectations,
    (expectation) => expectation.diagramId,
    "Diagram",
  );
  assertExactExpectationIds(Object.keys(activity.objectGuards), objectExpectations.keys(), "object");
  assertExactExpectationIds(Object.keys(activity.diagramGuards), diagramExpectations.keys(), "Diagram");

  for (const [objectId, guard] of Object.entries(activity.objectGuards)) {
    const expectation = objectExpectations.get(objectId)!;
    if (!expectationMatchesGuard(expectation, guard)) {
      rejectUnsafeRevert(`The supplied post-state guard for object ${objectId} does not match the activity.`, {
        activityId: activity.id,
        objectId,
        required: guard,
      });
    }
    const current = room.objects[objectId];
    if (guard.state === "absent") {
      if (current) {
        rejectUnsafeRevert(`Canvas object ${objectId} was recreated after this activity.`, {
          activityId: activity.id,
          objectId,
          required: guard,
          current: { state: "present", revision: current.revision },
        });
      }
      continue;
    }
    if (!current || current.revision !== guard.revision) {
      rejectUnsafeRevert(`Canvas object ${objectId} changed after this activity.`, {
        activityId: activity.id,
        objectId,
        required: guard,
        current: current ? { state: "present", revision: current.revision } : { state: "absent" },
      });
    }
    verifyLease(
      room,
      current,
      actor,
      expectation.state === "present" ? expectation.leaseId : undefined,
      now,
    );
  }

  for (const [diagramId, guard] of Object.entries(activity.diagramGuards)) {
    const expectation = diagramExpectations.get(diagramId)!;
    if (!expectationMatchesGuard(expectation, guard)) {
      rejectUnsafeRevert(`The supplied post-state guard for Diagram ${diagramId} does not match the activity.`, {
        activityId: activity.id,
        diagramId,
        required: guard,
      });
    }
    const current = room.diagrams?.[diagramId];
    if (guard.state === "absent") {
      if (current) {
        rejectUnsafeRevert(`Diagram ${diagramId} was recreated after this activity.`, {
          activityId: activity.id,
          diagramId,
          required: guard,
          current: { state: "present", revision: current.revision },
        });
      }
    } else if (!current || current.revision !== guard.revision) {
      rejectUnsafeRevert(`Diagram ${diagramId} changed after this activity.`, {
        activityId: activity.id,
        diagramId,
        required: guard,
        current: current ? { state: "present", revision: current.revision } : { state: "absent" },
      });
    }
  }

  validateRevertDependencies(room, activity);

  for (const change of activity.objectChanges) {
    if (change.mode === "derived_membership") continue;
    const current = room.objects[change.objectId];
    if (!change.before) {
      delete room.objects[change.objectId];
      delete room.leases[change.objectId];
      continue;
    }
    room.objects[change.objectId] = {
      ...structuredClone(change.before),
      diagramIds: [],
      revision: (current?.revision ?? change.before.revision) + 1,
      createdAt: change.before.createdAt,
      createdBy: structuredClone(change.before.createdBy),
      updatedAt: now,
      lastEditedBy: actor,
    } as CanvasObject;
  }

  room.diagrams ??= {};
  for (const change of activity.diagramChanges) {
    const current = room.diagrams[change.diagramId];
    if (!change.before) {
      delete room.diagrams[change.diagramId];
      continue;
    }
    room.diagrams[change.diagramId] = {
      ...structuredClone(change.before),
      revision: (current?.revision ?? change.before.revision) + 1,
      createdAt: change.before.createdAt,
      createdBy: structuredClone(change.before.createdBy),
      updatedAt: now,
      lastEditedBy: actor,
    };
  }

  for (const object of Object.values(room.objects)) validateConnectorReferences(room, object);
  for (const diagram of Object.values(room.diagrams)) validateDiagramMembers(room, diagram);
  normalizeRoomSemanticState(room);

  const membershipObjectIds = Object.values(room.objects)
    .filter((object) =>
      JSON.stringify(baseline.objects[object.id]?.diagramIds ?? []) !== JSON.stringify(object.diagramIds),
    )
    .map((object) => object.id);
  const changedObjectIds = unique(
    activity.objectChanges.filter((change) => change.mode === "direct").map((change) => change.objectId),
  );
  const changedDiagramIds = activity.diagramChanges.map((change) => change.diagramId);
  if (actorKind === "agent") {
    room.participants[participantId].agentActive = true;
    room.participants[participantId].agent.lastSeenAt = now;
  }
  touchRoom(room, now);
  return { room, changedObjectIds, changedDiagramIds, membershipObjectIds };
}

function hierarchyLevels(room: RoomState, orderedIds: readonly string[]): string[][] {
  const selected = new Set(orderedIds);
  const order = new Map(orderedIds.map((id, index) => [id, index]));
  const outgoing = new Map(orderedIds.map((id) => [id, new Set<string>()]));
  const indegree = new Map(orderedIds.map((id) => [id, 0]));

  for (const connector of Object.values(room.objects)) {
    if (connector.kind !== "connector" || connector.direction === "none") continue;
    const start = connector.start.objectId;
    const end = connector.end.objectId;
    if (!start || !end || start === end || !selected.has(start) || !selected.has(end)) continue;
    const neighbors = outgoing.get(start)!;
    if (neighbors.has(end)) continue;
    neighbors.add(end);
    indegree.set(end, (indegree.get(end) ?? 0) + 1);
  }

  const ready = orderedIds.filter((id) => indegree.get(id) === 0);
  const levelById = new Map(orderedIds.map((id) => [id, 0]));
  const visited: string[] = [];
  while (ready.length) {
    ready.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    const current = ready.shift()!;
    visited.push(current);
    for (const next of outgoing.get(current) ?? []) {
      levelById.set(next, Math.max(levelById.get(next) ?? 0, (levelById.get(current) ?? 0) + 1));
      const nextIndegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextIndegree);
      if (nextIndegree === 0) ready.push(next);
    }
  }
  if (visited.length !== orderedIds.length) {
    const cyclicObjectIds = orderedIds.filter((id) => !visited.includes(id));
    throw new DomainError(
      "INVALID_OPERATION",
      "Hierarchy layout requires an acyclic set of directed semantic connectors.",
      { cyclicObjectIds },
    );
  }
  const maxLevel = Math.max(...levelById.values(), 0);
  return Array.from({ length: maxLevel + 1 }, (_, level) =>
    orderedIds.filter((id) => levelById.get(id) === level),
  );
}

function layoutConnectors(room: RoomState, command: LayoutCommand, selected: Set<string>) {
  const diagramConnectorIds = command.diagramId
    ? new Set(room.diagrams?.[command.diagramId]?.connectorIds ?? [])
    : null;
  return Object.values(room.objects)
    .filter((object): object is Extract<CanvasObject, { kind: "connector" }> => {
      if (object.kind !== "connector" || !object.start.objectId || !object.end.objectId) return false;
      if (!selected.has(object.start.objectId) || !selected.has(object.end.objectId)) return false;
      return !diagramConnectorIds || diagramConnectorIds.has(object.id);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function labelAwareBoundaryGaps(input: {
  count: number;
  minimum: number;
  direction: "right" | "down";
  density: LayoutCommand["density"];
  rankById: ReadonlyMap<string, number>;
  connectors: ReturnType<typeof layoutConnectors>;
}): number[] {
  const gaps = Array.from({ length: Math.max(0, input.count - 1) }, () => input.minimum);
  for (const connector of input.connectors) {
    const startRank = input.rankById.get(connector.start.objectId!);
    const endRank = input.rankById.get(connector.end.objectId!);
    if (startRank === undefined || endRank === undefined || startRank === endRank) continue;
    const required = connectorLabelPrimaryClearance(connector.label, input.direction, input.density);
    if (!required) continue;
    const firstBoundary = Math.min(startRank, endRank);
    const lastBoundary = Math.max(startRank, endRank);
    for (let boundary = firstBoundary; boundary < lastBoundary; boundary += 1) {
      gaps[boundary] = Math.max(gaps[boundary] ?? input.minimum, required);
    }
  }
  return gaps;
}

function layoutPositions(room: RoomState, command: LayoutCommand): Map<string, { x: number; y: number }> {
  const objects = command.targets.map((target) => getObject(room, target.objectId));
  for (const object of objects) {
    if (object.kind === "connector") {
      throw new DomainError(
        "INVALID_OPERATION",
        "Layout targets must be nodes or canvas content; bound connectors are positioned automatically.",
        { objectId: object.id },
      );
    }
  }
  const origin = command.origin ?? {
    x: Math.min(...objects.map((object) => object.x)),
    y: Math.min(...objects.map((object) => object.y)),
  };
  const positions = new Map<string, { x: number; y: number }>();
  const selected = new Set(objects.map((object) => object.id));
  const connectors = layoutConnectors(room, command, selected);
  const gaps = minimumLayoutGaps(command);

  if (command.layout === "flow") {
    const rankById = new Map(objects.map((object, index) => [object.id, index]));
    const primaryGaps = labelAwareBoundaryGaps({
      count: objects.length,
      minimum: gaps.primaryGap,
      direction: command.direction,
      density: command.density,
      rankById,
      connectors,
    });
    let cursor = command.direction === "right" ? origin.x : origin.y;
    for (const [index, object] of objects.entries()) {
      positions.set(
        object.id,
        command.direction === "right" ? { x: cursor, y: origin.y } : { x: origin.x, y: cursor },
      );
      cursor +=
        (command.direction === "right" ? object.width : object.height) +
        (primaryGaps[index] ?? 0);
    }
    return positions;
  }

  if (command.layout === "grid") {
    const columns = Math.min(command.columns ?? Math.ceil(Math.sqrt(objects.length)), objects.length);
    const rows = Math.ceil(objects.length / columns);
    const slots = objects.map((object, index) => {
      if (command.direction === "right") return { object, row: Math.floor(index / columns), column: index % columns };
      return { object, row: index % rows, column: Math.floor(index / rows) };
    });
    const columnWidths = Array.from({ length: columns }, (_, column) =>
      Math.max(...slots.filter((slot) => slot.column === column).map((slot) => slot.object.width), 1),
    );
    const rowHeights = Array.from({ length: rows }, (_, row) =>
      Math.max(...slots.filter((slot) => slot.row === row).map((slot) => slot.object.height), 1),
    );
    const columnById = new Map(slots.map((slot) => [slot.object.id, slot.column]));
    const rowById = new Map(slots.map((slot) => [slot.object.id, slot.row]));
    const columnGaps = labelAwareBoundaryGaps({
      count: columns,
      minimum: gaps.primaryGap,
      direction: "right",
      density: command.density,
      rankById: columnById,
      connectors,
    });
    const rowGaps = labelAwareBoundaryGaps({
      count: rows,
      minimum: gaps.secondaryGap,
      direction: "down",
      density: command.density,
      rankById: rowById,
      connectors,
    });
    const columnX = columnWidths.map((_, column) =>
      origin.x + columnWidths.slice(0, column).reduce(
        (sum, width, boundary) => sum + width + (columnGaps[boundary] ?? 0),
        0,
      ),
    );
    const rowY = rowHeights.map((_, row) =>
      origin.y + rowHeights.slice(0, row).reduce(
        (sum, height, boundary) => sum + height + (rowGaps[boundary] ?? 0),
        0,
      ),
    );
    for (const slot of slots) positions.set(slot.object.id, { x: columnX[slot.column], y: rowY[slot.row] });
    return positions;
  }

  const levels = hierarchyLevels(room, objects.map((object) => object.id));
  const levelById = new Map(levels.flatMap((level, index) => level.map((id) => [id, index] as const)));
  const primaryGaps = labelAwareBoundaryGaps({
    count: levels.length,
    minimum: gaps.primaryGap,
    direction: command.direction,
    density: command.density,
    rankById: levelById,
    connectors,
  });
  let primaryCursor = command.direction === "right" ? origin.x : origin.y;
  for (const [levelIndex, level] of levels.entries()) {
    const members = level.map((id) => room.objects[id]);
    let secondaryCursor = command.direction === "right" ? origin.y : origin.x;
    for (const object of members) {
      positions.set(
        object.id,
        command.direction === "right"
          ? { x: primaryCursor, y: secondaryCursor }
          : { x: secondaryCursor, y: primaryCursor },
      );
      secondaryCursor += (command.direction === "right" ? object.height : object.width) + gaps.secondaryGap;
    }
    primaryCursor +=
      Math.max(...members.map((object) => (command.direction === "right" ? object.width : object.height)), 1) +
      (primaryGaps[levelIndex] ?? 0);
  }
  return positions;
}

function applyLayoutMutable(
  room: RoomState,
  baseline: RoomState,
  command: LayoutCommand,
  actor: ActorRef,
  now: number,
  touchedObjectIds: Set<string>,
): Array<{ objectId: string; x: number; y: number }> {
  const ids = command.targets.map((target) => target.objectId);
  if (new Set(ids).size !== ids.length) {
    throw new DomainError("INVALID_OPERATION", "Layout targets must be unique.");
  }
  if ((command.diagramId === undefined) !== (command.expectedDiagramRevision === undefined)) {
    throw new DomainError(
      "INVALID_OPERATION",
      "diagramId and expectedDiagramRevision must be provided together.",
    );
  }
  if (command.diagramId) {
    const diagram = room.diagrams?.[command.diagramId];
    if (!diagram) {
      throw new DomainError("DIAGRAM_NOT_FOUND", `Diagram ${command.diagramId} does not exist.`, {
        diagramId: command.diagramId,
      });
    }
    if (diagram.revision !== command.expectedDiagramRevision) {
      throw new DomainError(
        "REVISION_CONFLICT",
        `Diagram ${diagram.id} changed from revision ${command.expectedDiagramRevision} to ${diagram.revision}.`,
        {
          diagramId: diagram.id,
          expectedRevision: command.expectedDiagramRevision,
          currentRevision: diagram.revision,
        },
      );
    }
    const members = new Set(diagram.memberObjectIds);
    const outsideDiagram = ids.filter((id) => !members.has(id));
    if (outsideDiagram.length) {
      throw new DomainError("INVALID_OPERATION", "Every layout target must be a member of the selected diagram.", {
        diagramId: diagram.id,
        objectIds: outsideDiagram,
      });
    }
  }

  for (const target of command.targets) {
    const object = getObject(room, target.objectId);
    if (object.kind === "connector") {
      throw new DomainError(
        "INVALID_OPERATION",
        "Layout targets must be nodes or canvas content; bound connectors are positioned automatically.",
        { objectId: object.id },
      );
    }
    const existedAtBaseline = Boolean(baseline.objects[target.objectId]);
    if (existedAtBaseline && touchedObjectIds.has(target.objectId)) {
      throw new DomainError(
        "INVALID_OPERATION",
        `Layout target ${target.objectId} is also changed by another operation in this transaction.`,
        { objectId: target.objectId },
      );
    }
    verifyLease(room, object, actor, target.leaseId, now);
    verifyRevision(object, target.expectedRevision);
  }

  const positions = layoutPositions(room, command);
  for (const target of command.targets) {
    const position = positions.get(target.objectId)!;
    const object = room.objects[target.objectId];
    if (baseline.objects[target.objectId]) {
      room.objects[target.objectId] = updateObject(object, position, actor, now);
    } else {
      Object.assign(object, position);
    }
    touchedObjectIds.add(target.objectId);
  }
  return command.targets.map((target) => ({ objectId: target.objectId, ...positions.get(target.objectId)! }));
}

export function applyLayoutCommand(
  source: RoomState,
  participantId: string,
  actorKind: ActorKind,
  command: LayoutCommand,
  now = Date.now(),
  actorOverride?: ActorRef,
): SemanticMutationResult & { positions: Array<{ objectId: string; x: number; y: number }> } {
  const result = applySemanticTransaction(
    source,
    participantId,
    actorKind,
    {
      commands: [],
      diagramCommands: [],
      autoLayout: command,
    },
    now,
    actorOverride,
  );
  return {
    ...result,
    positions: result.positions ?? [],
  };
}

export function acquireObjectLease(
  source: RoomState,
  participantId: string,
  actorKind: ActorKind,
  objectId: string,
  expectedRevision: number,
  operation: LeaseOperation,
  now = Date.now(),
): { room: RoomState; lease: ObjectLease } {
  const room = structuredClone(source);
  const participant = requireParticipant(room, participantId);
  requireMutationRole(participant, actorKind);
  const actor = actorFor(participant, actorKind);
  pruneExpiredLeases(room, now);
  const object = getObject(room, objectId);
  verifyLease(room, object, actor, undefined, now);
  verifyRevision(object, expectedRevision);

  const existing = room.leases[objectId];
  const lease: ObjectLease =
    existing && existing.actor.participantId === participantId && existing.actor.kind === actorKind
      ? { ...existing, operation, expiresAt: now + LEASE_DURATION_MS }
      : {
          leaseId: randomUUID(),
          objectId,
          actor,
          operation,
          objectRevision: object.revision,
          acquiredAt: now,
          expiresAt: now + LEASE_DURATION_MS,
        };

  room.leases[objectId] = lease;
  touchCoordination(room);
  return { room, lease };
}

export function renewObjectLease(
  source: RoomState,
  participantId: string,
  actorKind: ActorKind,
  objectId: string,
  leaseId: string,
  now = Date.now(),
): { room: RoomState; lease: ObjectLease } {
  const room = structuredClone(source);
  const participant = requireParticipant(room, participantId);
  requireMutationRole(participant, actorKind);
  pruneExpiredLeases(room, now);
  const lease = room.leases[objectId];
  if (
    !lease ||
    lease.leaseId !== leaseId ||
    lease.actor.participantId !== participantId ||
    lease.actor.kind !== actorKind
  ) {
    throw new DomainError("LEASE_NOT_FOUND", "The active-object lease is missing or belongs to another actor.", {
      objectId,
    });
  }
  const renewed = { ...lease, expiresAt: now + LEASE_DURATION_MS };
  room.leases[objectId] = renewed;
  touchCoordination(room);
  return { room, lease: renewed };
}

export function releaseObjectLease(
  source: RoomState,
  participantId: string,
  actorKind: ActorKind,
  objectId: string,
  leaseId: string,
  now = Date.now(),
): RoomState {
  const room = structuredClone(source);
  const participant = requireParticipant(room, participantId);
  requireMutationRole(participant, actorKind);
  pruneExpiredLeases(room, now);
  const lease = room.leases[objectId];
  if (!lease) return room;
  if (
    lease.leaseId !== leaseId ||
    lease.actor.participantId !== participantId ||
    lease.actor.kind !== actorKind
  ) {
    throw new DomainError("LEASE_NOT_FOUND", "The active-object lease is missing or belongs to another actor.", {
      objectId,
    });
  }
  delete room.leases[objectId];
  touchCoordination(room);
  return room;
}
