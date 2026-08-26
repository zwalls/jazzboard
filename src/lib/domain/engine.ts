import { randomUUID } from "node:crypto";

import { DomainError } from "./errors";
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
  room.updatedAt = now;
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

const COMMON_PATCH_FIELDS = new Set(["x", "y", "width", "height", "rotation", "zIndex", "groupId"]);
const KIND_PATCH_FIELDS: Record<CanvasObject["kind"], ReadonlySet<string>> = {
  text: new Set(["content", "color", "size", "align"]),
  shape: new Set(["shape", "nodeType", "nodeMetadata", "label", "fill", "stroke"]),
  connector: new Set(["start", "end", "direction", "label", "color"]),
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function samePoint(left: { x: number; y: number }, right: { x: number; y: number }): boolean {
  return left.x === right.x && left.y === right.y;
}

function centerOf(object: CanvasObject): { x: number; y: number } {
  return { x: object.x + object.width / 2, y: object.y + object.height / 2 };
}

function edgePoint(
  object: CanvasObject,
  toward: { x: number; y: number },
): { x: number; y: number } {
  const center = centerOf(object);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return center;
  const halfWidth = Math.max(object.width / 2, 1);
  const halfHeight = Math.max(object.height / 2, 1);
  const scale = 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function resolvedConnectorGeometry(room: RoomState, connector: Extract<CanvasObject, { kind: "connector" }>) {
  const startObject = connector.start.objectId ? room.objects[connector.start.objectId] : undefined;
  const endObject = connector.end.objectId ? room.objects[connector.end.objectId] : undefined;
  const startFallback = { x: connector.start.x, y: connector.start.y };
  const endFallback = { x: connector.end.x, y: connector.end.y };
  const startToward = endObject ? centerOf(endObject) : endFallback;
  const endToward = startObject ? centerOf(startObject) : startFallback;
  const start = startObject ? edgePoint(startObject, startToward) : startFallback;
  const end = endObject ? edgePoint(endObject, endToward) : endFallback;
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.max(Math.abs(end.x - start.x), 1),
    height: Math.max(Math.abs(end.y - start.y), 1),
    rotation: startObject || endObject ? 0 : connector.rotation,
    start: { ...start, objectId: startObject ? startObject.id : null },
    end: { ...end, objectId: endObject ? endObject.id : null },
  };
}

function boundsFor(room: RoomState, objectIds: readonly string[]): CanvasBounds {
  const objects = unique(objectIds).flatMap((id) => room.objects[id] ?? []);
  if (!objects.length) return { ...EMPTY_BOUNDS };
  const minX = Math.min(...objects.map((object) => object.x));
  const minY = Math.min(...objects.map((object) => object.y));
  const maxX = Math.max(...objects.map((object) => object.x + object.width));
  const maxY = Math.max(...objects.map((object) => object.y + object.height));
  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
  };
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
  geometry: ReturnType<typeof resolvedConnectorGeometry>,
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
    !samePoint(connector.end, geometry.end)
  );
}

/**
 * Migrates old persisted rooms into the current authoritative semantic model.
 * The caller must pass a private room copy because this function mutates it.
 */
export function normalizeRoomSemanticState(room: RoomState): RoomState {
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
    }
  }

  for (const connector of Object.values(room.objects)) {
    if (connector.kind !== "connector") continue;
    const geometry = resolvedConnectorGeometry(room, connector);
    Object.assign(connector, geometry);
  }

  for (const diagram of Object.values(room.diagrams)) {
    diagram.tags = unique(diagram.tags ?? []);
    diagram.memberObjectIds = unique(diagram.memberObjectIds ?? []).filter(
      (id) => room.objects[id] && room.objects[id].kind !== "connector",
    );
    diagram.connectorIds = unique(diagram.connectorIds ?? []).filter(
      (id) => room.objects[id]?.kind === "connector",
    );
    diagram.bounds = boundsFor(room, [...diagram.memberObjectIds, ...diagram.connectorIds]);
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
        revision: 1,
        createdAt: now,
        updatedAt: now,
        createdBy: actor,
        lastEditedBy: actor,
      } as CanvasObject;
      validateConnectorReferences(room, object);
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
      const updated = updateObject(object, patch, actor, now);
      validateConnectorReferences(room, updated);
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
};

export function applySemanticTransaction(
  source: RoomState,
  participantId: string,
  actorKind: ActorKind,
  transaction: SemanticTransaction,
  now = Date.now(),
  actorOverride?: ActorRef,
): SemanticMutationResult {
  if (transaction.commands.length + transaction.diagramCommands.length === 0) {
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

  // Bound connector geometry is authoritative server state. Implicit changes
  // honor active-object leases and receive the same actor attribution.
  for (const object of Object.values(room.objects)) {
    if (object.kind !== "connector") continue;
    const geometry = resolvedConnectorGeometry(room, object);
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
    diagram.bounds = boundsFor(room, [...diagram.memberObjectIds, ...diagram.connectorIds]);
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

  if (command.layout === "flow") {
    let cursor = command.direction === "right" ? origin.x : origin.y;
    for (const object of objects) {
      positions.set(
        object.id,
        command.direction === "right" ? { x: cursor, y: origin.y } : { x: origin.x, y: cursor },
      );
      cursor += (command.direction === "right" ? object.width : object.height) + command.primaryGap;
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
    const columnX = columnWidths.map((_, column) =>
      origin.x + columnWidths.slice(0, column).reduce((sum, width) => sum + width + command.primaryGap, 0),
    );
    const rowY = rowHeights.map((_, row) =>
      origin.y + rowHeights.slice(0, row).reduce((sum, height) => sum + height + command.secondaryGap, 0),
    );
    for (const slot of slots) positions.set(slot.object.id, { x: columnX[slot.column], y: rowY[slot.row] });
    return positions;
  }

  const levels = hierarchyLevels(room, objects.map((object) => object.id));
  let primaryCursor = command.direction === "right" ? origin.x : origin.y;
  for (const level of levels) {
    const members = level.map((id) => room.objects[id]);
    let secondaryCursor = command.direction === "right" ? origin.y : origin.x;
    for (const object of members) {
      positions.set(
        object.id,
        command.direction === "right"
          ? { x: primaryCursor, y: secondaryCursor }
          : { x: secondaryCursor, y: primaryCursor },
      );
      secondaryCursor += (command.direction === "right" ? object.height : object.width) + command.secondaryGap;
    }
    primaryCursor +=
      Math.max(...members.map((object) => (command.direction === "right" ? object.width : object.height)), 1) +
      command.primaryGap;
  }
  return positions;
}

export function applyLayoutCommand(
  source: RoomState,
  participantId: string,
  actorKind: ActorKind,
  command: LayoutCommand,
  now = Date.now(),
  actorOverride?: ActorRef,
): SemanticMutationResult & { positions: Array<{ objectId: string; x: number; y: number }> } {
  const current = normalizeRoomSemanticState(structuredClone(source));
  const participant = requireParticipant(current, participantId);
  requireMutationRole(participant, actorKind);
  const ids = command.targets.map((target) => target.objectId);
  if (new Set(ids).size !== ids.length) {
    throw new DomainError("INVALID_OPERATION", "Layout targets must be unique.");
  }
  if (command.diagramId) {
    const diagram = current.diagrams?.[command.diagramId];
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
  const positions = layoutPositions(current, command);
  const result = applySemanticTransaction(
    current,
    participantId,
    actorKind,
    {
      commands: [
        {
          type: "move",
          targets: command.targets.map((target) => ({
            ...target,
            ...positions.get(target.objectId)!,
          })),
        },
      ],
      diagramCommands: [],
    },
    now,
    actorOverride,
  );
  return {
    ...result,
    positions: command.targets.map((target) => ({ objectId: target.objectId, ...positions.get(target.objectId)! })),
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
  touchRoom(room, now);
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
  touchRoom(room, now);
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
  touchRoom(room, now);
  return room;
}
