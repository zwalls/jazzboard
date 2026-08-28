import {
  computeAffectedConnectorIds,
  computePotentialMoveConnectorIds,
} from "@/lib/domain/connector-dependencies";
import type {
  CanvasObject,
  CreateCanvasObject,
  NodeMetadata,
  NodeMetadataInput,
  Point,
  RoomState,
} from "@/lib/domain/types";

import type {
  SemanticCanvasEditEvent,
  SemanticCanvasGestureDependenciesAddedEvent,
  SemanticCanvasGestureFinishReason,
  SemanticCanvasGestureFinishRequestedEvent,
  SemanticCanvasGestureStartedEvent,
  SemanticCanvasObjectsChangedEvent,
} from "./semantic-edit-events";

/** Opaque identity used to fence delayed pointer and recovery results. */
export type SemanticMoveSessionToken = Readonly<{
  sessionId: string;
  fence: number;
}>;

export type SemanticMoveCohortMember = Readonly<{
  objectId: string;
  kind: Exclude<CanvasObject["kind"], "connector">;
  groupId: string | null;
  baseRevision: number;
  baseCreatedAt: number;
  basePosition: Readonly<Point>;
  /** A locked image may move only as a member of an explicitly resolved group. */
  lockedImage: boolean;
  movedViaGroup: boolean;
}>;

export type SemanticMoveConnectorDependency = Readonly<{
  objectId: string;
  baseRevision: number;
  baseCreatedAt: number;
}>;

export type SemanticMoveSelectionReport = Readonly<{
  missingObjectIds: readonly string[];
  missingGroupIds: readonly string[];
  /** Connectors require endpoint editing and never enter a position-only move. */
  connectorObjectIds: readonly string[];
  /** Ungrouped locked images cannot begin or join a direct move. */
  lockedImageObjectIds: readonly string[];
}>;

export type SemanticMovePositionOverrides = Readonly<
  Record<string, Readonly<Point>>
>;

export type SemanticMoveSessionPhase = "moving" | "finished";

export const SEMANTIC_MOVE_LIMITS = Object.freeze({ maxOperations: 200 });

export type SemanticMoveSession = Readonly<{
  token: SemanticMoveSessionToken;
  gestureId: string;
  roomId: string;
  baseRoomRevision: number;
  selectedObjectIds: readonly string[];
  selectedGroupIds: readonly string[];
  /** Includes groups inferred from selected member objects. */
  resolvedGroupIds: readonly string[];
  pointerStart: Readonly<Point>;
  pointerCurrent: Readonly<Point>;
  delta: Readonly<Point>;
  cohort: readonly SemanticMoveCohortMember[];
  objectIds: readonly string[];
  /** Pointer-down preflight plus any exact dependencies discovered by later frames. */
  connectorDependencies: readonly SemanticMoveConnectorDependency[];
  affectedConnectorIds: readonly string[];
  selectionReport: SemanticMoveSelectionReport;
  positionOverrides: SemanticMovePositionOverrides;
  dirty: boolean;
  phase: SemanticMoveSessionPhase;
}>;

export type SemanticMoveStaleResult = Readonly<{
  status: "stale";
  token: SemanticMoveSessionToken;
}>;

export type SemanticMoveRolledBack = Readonly<{
  status: "rolled-back";
  token: SemanticMoveSessionToken;
  reason: "cancelled" | "authoritative-change" | "command-rejected";
  detail: string | null;
  /** Hosts clear their optimistic overlay with this empty record. */
  positionOverrides: SemanticMovePositionOverrides;
  /** Current page-space positions from the supplied authoritative room. */
  authoritativePositions: SemanticMovePositionOverrides;
  /** Recovery is owned by the shared lifecycle/persistence host, not this engine. */
  lifecycleEvents: readonly [];
}>;

export type SemanticMoveStarted = Readonly<{
  status: "started";
  session: SemanticMoveSession;
  lifecycleEvent: SemanticCanvasGestureStartedEvent;
  /** A still-active prior pointer gesture is finalized as pointer-cancel. */
  superseded: SemanticMoveFinished | null;
}>;

export type SemanticMoveBlocked = Readonly<{
  status: "blocked";
  reason: "no-movable-objects";
  selectionReport: SemanticMoveSelectionReport;
  superseded: SemanticMoveFinished | null;
}>;

export type SemanticMovePointerUpdated = Readonly<{
  status: "updated";
  session: SemanticMoveSession;
  /** New dependency protection always precedes the absolute draft event. */
  lifecycleEvents: readonly SemanticCanvasEditEvent[];
}>;

export type SemanticMoveFinished = Readonly<{
  status: "finished";
  session: SemanticMoveSession;
  /** Network commands are deliberately owned by the shared persistence driver. */
  command: null;
  lifecycleEvents: readonly SemanticCanvasEditEvent[];
}>;

export type SemanticMoveAuthoritativeCurrent = Readonly<{
  status: "current";
  session: SemanticMoveSession;
}>;

export class SemanticMoveSessionError extends Error {
  constructor(
    readonly code: "INVALID_PHASE" | "INVALID_POINTER" | "OPERATION_LIMIT",
    message: string,
  ) {
    super(message);
    this.name = "SemanticMoveSessionError";
  }
}

type MovableObject = Exclude<CanvasObject, { kind: "connector" }>;

type ResolvedCohort = {
  objects: MovableObject[];
  movedViaGroup: ReadonlySet<string>;
  resolvedGroupIds: string[];
  report: SemanticMoveSelectionReport;
};

type InternalSession = {
  snapshot: SemanticMoveSession;
  baseline: RoomState;
  baseDrafts: ReadonlyMap<string, CreateCanvasObject>;
  selectedObjectIds: readonly string[];
  requestedGroupIds: readonly string[];
  dependencyById: ReadonlyMap<string, SemanticMoveConnectorDependency>;
};

const EMPTY_EVENTS = Object.freeze([]) as readonly [];
const EMPTY_OVERRIDES = Object.freeze({}) as SemanticMovePositionOverrides;

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function freezePoint(point: Point): Readonly<Point> {
  return Object.freeze({ x: point.x, y: point.y });
}

function assertFinitePoint(point: Point): void {
  if (Number.isFinite(point.x) && Number.isFinite(point.y)) return;
  throw new SemanticMoveSessionError(
    "INVALID_POINTER",
    "A semantic move pointer must contain finite canvas-world coordinates.",
  );
}

function freezeSelectionReport(
  report: SemanticMoveSelectionReport,
): SemanticMoveSelectionReport {
  return Object.freeze({
    missingObjectIds: Object.freeze([...report.missingObjectIds]),
    missingGroupIds: Object.freeze([...report.missingGroupIds]),
    connectorObjectIds: Object.freeze([...report.connectorObjectIds]),
    lockedImageObjectIds: Object.freeze([...report.lockedImageObjectIds]),
  });
}

function resolveCohort(
  room: RoomState,
  selectedObjectIds: readonly string[],
  selectedGroupIds: readonly string[],
): ResolvedCohort {
  const selectedIds = new Set(selectedObjectIds);
  const requestedGroups = new Set(selectedGroupIds);
  const roomGroupIds = new Set(
    Object.values(room.objects).flatMap((object) => object.groupId ? [object.groupId] : []),
  );
  const missingObjectIds = sortedUnique(
    selectedObjectIds.filter((objectId) => !room.objects[objectId]),
  );
  const missingGroupIds = sortedUnique(
    selectedGroupIds.filter((groupId) => !roomGroupIds.has(groupId)),
  );

  for (const objectId of selectedObjectIds) {
    const groupId = room.objects[objectId]?.groupId;
    if (groupId) requestedGroups.add(groupId);
  }

  const candidates = Object.values(room.objects).filter(
    (object) => selectedIds.has(object.id) || Boolean(object.groupId && requestedGroups.has(object.groupId)),
  );
  const movedViaGroup = new Set(
    candidates
      .filter((object) => Boolean(object.groupId && requestedGroups.has(object.groupId)))
      .map((object) => object.id),
  );
  const connectorObjectIds: string[] = [];
  const lockedImageObjectIds: string[] = [];
  const objects: MovableObject[] = [];

  for (const object of candidates) {
    if (object.kind === "connector") {
      connectorObjectIds.push(object.id);
      continue;
    }
    if (object.kind === "image" && object.locked && !movedViaGroup.has(object.id)) {
      lockedImageObjectIds.push(object.id);
      continue;
    }
    objects.push(object);
  }
  objects.sort((left, right) => left.id.localeCompare(right.id));

  return {
    objects,
    movedViaGroup,
    resolvedGroupIds: sortedUnique(requestedGroups),
    report: freezeSelectionReport({
      missingObjectIds,
      missingGroupIds,
      connectorObjectIds: sortedUnique(connectorObjectIds),
      lockedImageObjectIds: sortedUnique(lockedImageObjectIds),
    }),
  };
}

function nodeMetadataInput(
  metadata: NodeMetadata | null | undefined,
): NodeMetadataInput | null | undefined {
  if (metadata === undefined || metadata === null) return metadata;
  const { kind, status, owner, resolution } = metadata;
  return { kind, status, owner, resolution } as NodeMetadataInput;
}

function draftFromObject(object: MovableObject): CreateCanvasObject {
  const {
    revision: _revision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    createdBy: _createdBy,
    lastEditedBy: _lastEditedBy,
    diagramIds: _diagramIds,
    ...draft
  } = object;
  void _revision;
  void _createdAt;
  void _updatedAt;
  void _createdBy;
  void _lastEditedBy;
  void _diagramIds;

  if (draft.kind === "shape") {
    return Object.freeze({
      ...draft,
      nodeMetadata: nodeMetadataInput(draft.nodeMetadata),
    });
  }
  if (draft.kind === "draw") {
    const points = draft.points.map((point) => ({ x: point.x, y: point.y }));
    for (const point of points) Object.freeze(point);
    Object.freeze(points);
    return Object.freeze({ ...draft, points });
  }
  return Object.freeze({ ...draft });
}

function freezeOverrides(
  cohort: readonly SemanticMoveCohortMember[],
  delta: Point,
): SemanticMovePositionOverrides {
  return Object.freeze(Object.fromEntries(cohort.map((member) => [
    member.objectId,
    freezePoint({
      x: member.basePosition.x + delta.x,
      y: member.basePosition.y + delta.y,
    }),
  ])));
}

function authoritativePositions(
  room: RoomState,
  objectIds: readonly string[],
): SemanticMovePositionOverrides {
  return Object.freeze(Object.fromEntries(objectIds.flatMap((objectId) => {
    const object = room.objects[objectId];
    return object ? [[objectId, freezePoint({ x: object.x, y: object.y })] as const] : [];
  })));
}

function freezeSession(
  session: Omit<SemanticMoveSession, "token"> & { token: SemanticMoveSessionToken },
): SemanticMoveSession {
  return Object.freeze({ ...session });
}

function lifecycleStartedEvent(session: SemanticMoveSession): SemanticCanvasGestureStartedEvent {
  return Object.freeze({
    type: "gesture.started",
    gestureId: session.gestureId,
    source: "pointer",
    objects: Object.freeze([
      ...session.cohort.map((member) => Object.freeze({
        objectId: member.objectId,
        baseRevision: member.baseRevision,
        baseCreatedAt: member.baseCreatedAt,
        operation: "move" as const,
      })),
      ...session.connectorDependencies.map((dependency) => Object.freeze({
        objectId: dependency.objectId,
        baseRevision: dependency.baseRevision,
        baseCreatedAt: dependency.baseCreatedAt,
        operation: "connect" as const,
      })),
    ]),
  });
}

function dependenciesAddedEvent(
  session: SemanticMoveSession,
  dependencies: readonly SemanticMoveConnectorDependency[],
): SemanticCanvasGestureDependenciesAddedEvent {
  return Object.freeze({
    type: "gesture.dependencies-added",
    gestureId: session.gestureId,
    objects: Object.freeze(dependencies.map((dependency) => Object.freeze({
      objectId: dependency.objectId,
      baseRevision: dependency.baseRevision,
      baseCreatedAt: dependency.baseCreatedAt,
      operation: "connect" as const,
    }))),
  });
}

function finishRequestedEvent(
  session: SemanticMoveSession,
  reason: Extract<SemanticCanvasGestureFinishReason, "pointer-up" | "pointer-cancel">,
): SemanticCanvasGestureFinishRequestedEvent {
  return Object.freeze({
    type: "gesture.finish-requested",
    gestureId: session.gestureId,
    reason,
  });
}

function changedEvent(internal: InternalSession): SemanticCanvasObjectsChangedEvent {
  const { snapshot } = internal;
  return Object.freeze({
    type: "objects.changed",
    gestureId: snapshot.gestureId,
    changes: Object.freeze(snapshot.cohort.map((member) => {
      const baseDraft = internal.baseDrafts.get(member.objectId);
      const position = snapshot.positionOverrides[member.objectId];
      if (!baseDraft || !position) {
        throw new Error(`Semantic move member ${member.objectId} lost its immutable base draft.`);
      }
      return Object.freeze({
        kind: "update" as const,
        draft: Object.freeze({ ...baseDraft, x: position.x, y: position.y }),
        baseRevision: member.baseRevision,
        baseCreatedAt: member.baseCreatedAt,
        operation: "move" as const,
      });
    })),
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function proposedRoom(internal: InternalSession): RoomState {
  const objects = { ...internal.baseline.objects };
  for (const member of internal.snapshot.cohort) {
    const object = objects[member.objectId];
    const position = internal.snapshot.positionOverrides[member.objectId];
    if (!object || !position) continue;
    objects[member.objectId] = { ...object, x: position.x, y: position.y };
  }
  return { ...internal.baseline, objects };
}

function discoverDependencies(
  internal: InternalSession,
): SemanticMoveConnectorDependency[] {
  const affected = computeAffectedConnectorIds({
    baseline: internal.baseline,
    current: proposedRoom(internal),
    touchedObjectIds: new Set(internal.snapshot.objectIds),
  });
  const dependencies: SemanticMoveConnectorDependency[] = [];
  for (const objectId of affected) {
    if (internal.dependencyById.has(objectId)) continue;
    const object = internal.baseline.objects[objectId];
    if (object?.kind !== "connector") continue;
    dependencies.push(Object.freeze({
      objectId,
      baseRevision: object.revision,
      baseCreatedAt: object.createdAt,
    }));
  }
  return dependencies;
}

function baseMismatch(internal: InternalSession, room: RoomState): string | null {
  const { snapshot } = internal;
  if (room.id !== snapshot.roomId) {
    return `Move session belongs to room ${snapshot.roomId}, not ${room.id}.`;
  }

  const current = resolveCohort(room, internal.selectedObjectIds, internal.requestedGroupIds);
  const currentIds = current.objects.map((object) => object.id);
  if (!sameStrings(currentIds, snapshot.objectIds)) {
    return "The selected or grouped move cohort changed while the move was active.";
  }

  for (const member of snapshot.cohort) {
    const object = room.objects[member.objectId];
    if (!object) return `Canvas object ${member.objectId} was removed while moving.`;
    if (object.kind === "connector" || object.kind !== member.kind) {
      return `Canvas object ${member.objectId} changed kind while moving.`;
    }
    if (object.createdAt !== member.baseCreatedAt) {
      return `Canvas object ${member.objectId} changed incarnation while moving.`;
    }
    if (object.revision !== member.baseRevision) {
      return `Canvas object ${member.objectId} changed revision while moving.`;
    }
    if (
      object.x !== member.basePosition.x ||
      object.y !== member.basePosition.y ||
      object.groupId !== member.groupId
    ) {
      return `Canvas object ${member.objectId} changed its authoritative move base.`;
    }
  }
  for (const dependency of snapshot.connectorDependencies) {
    const connector = room.objects[dependency.objectId];
    if (connector?.kind !== "connector") {
      return `Connector dependency ${dependency.objectId} was removed or changed kind while moving.`;
    }
    if (connector.createdAt !== dependency.baseCreatedAt) {
      return `Connector dependency ${dependency.objectId} changed incarnation while moving.`;
    }
    if (connector.revision !== dependency.baseRevision) {
      return `Connector dependency ${dependency.objectId} changed revision while moving.`;
    }
  }
  return null;
}

/**
 * Renderer-neutral synchronous state machine for one optimistic pointer move.
 *
 * The engine owns no renderer records, DOM state, timers, persistence client,
 * lease IDs, or network commands. Its lifecycle events are the only durable
 * seam: callers dispatch them synchronously in returned order before painting
 * each frame's `positionOverrides`.
 */
export class SemanticMoveSessionEngine {
  private nextFence = 0;
  private active: InternalSession | null = null;

  begin(input: Readonly<{
    room: RoomState;
    selectedObjectIds: readonly string[];
    selectedGroupIds?: readonly string[];
    pointerStart: Point;
  }>): SemanticMoveStarted | SemanticMoveBlocked {
    assertFinitePoint(input.pointerStart);
    const selectedObjectIds = sortedUnique(input.selectedObjectIds);
    const selectedGroupIds = sortedUnique(input.selectedGroupIds ?? []);
    const superseded = this.active
      ? this.finishCurrent("pointer-cancel", EMPTY_EVENTS)
      : null;
    const baseline = structuredClone(input.room);
    const resolved = resolveCohort(baseline, selectedObjectIds, selectedGroupIds);
    if (!resolved.objects.length) {
      this.nextFence += 1;
      return Object.freeze({
        status: "blocked",
        reason: "no-movable-objects",
        selectionReport: resolved.report,
        superseded,
      });
    }

    const fence = ++this.nextFence;
    const sessionId = `semantic-move:${fence}`;
    const token = Object.freeze({ sessionId, fence });
    const cohort = Object.freeze(resolved.objects.map((object): SemanticMoveCohortMember => Object.freeze({
      objectId: object.id,
      kind: object.kind,
      groupId: object.groupId,
      baseRevision: object.revision,
      baseCreatedAt: object.createdAt,
      basePosition: freezePoint({ x: object.x, y: object.y }),
      lockedImage: object.kind === "image" && object.locked,
      movedViaGroup: resolved.movedViaGroup.has(object.id),
    })));
    const objectIds = Object.freeze(cohort.map((member) => member.objectId));
    const initialConnectorIds = computePotentialMoveConnectorIds({
      room: baseline,
      movedObjectIds: new Set(objectIds),
      explicitConnectorIds: new Set(resolved.report.connectorObjectIds),
    });
    const connectorDependencies = Object.freeze([...initialConnectorIds].flatMap((objectId) => {
      const object = baseline.objects[objectId];
      return object?.kind === "connector"
        ? [Object.freeze({
            objectId,
            baseRevision: object.revision,
            baseCreatedAt: object.createdAt,
          })]
        : [];
    }));
    if (objectIds.length + connectorDependencies.length > SEMANTIC_MOVE_LIMITS.maxOperations) {
      throw new SemanticMoveSessionError(
        "OPERATION_LIMIT",
        `A semantic move can protect at most ${SEMANTIC_MOVE_LIMITS.maxOperations} objects and connector dependencies.`,
      );
    }
    const pointerStart = freezePoint(input.pointerStart);
    const zeroDelta = freezePoint({ x: 0, y: 0 });
    const snapshot = freezeSession({
      token,
      gestureId: sessionId,
      roomId: baseline.id,
      baseRoomRevision: baseline.roomRevision,
      selectedObjectIds: Object.freeze(selectedObjectIds),
      selectedGroupIds: Object.freeze(selectedGroupIds),
      resolvedGroupIds: Object.freeze(resolved.resolvedGroupIds),
      pointerStart,
      pointerCurrent: pointerStart,
      delta: zeroDelta,
      cohort,
      objectIds,
      connectorDependencies,
      affectedConnectorIds: Object.freeze(connectorDependencies.map(({ objectId }) => objectId)),
      selectionReport: resolved.report,
      positionOverrides: freezeOverrides(cohort, zeroDelta),
      dirty: false,
      phase: "moving",
    });
    this.active = {
      snapshot,
      baseline,
      baseDrafts: new Map(resolved.objects.map((object) => [object.id, draftFromObject(object)])),
      selectedObjectIds: snapshot.selectedObjectIds,
      requestedGroupIds: snapshot.selectedGroupIds,
      dependencyById: new Map(connectorDependencies.map((dependency) => [dependency.objectId, dependency])),
    };

    return Object.freeze({
      status: "started",
      session: snapshot,
      lifecycleEvent: lifecycleStartedEvent(snapshot),
      superseded,
    });
  }

  current(): SemanticMoveSession | null {
    return this.active?.snapshot ?? null;
  }

  isCurrent(token: SemanticMoveSessionToken): boolean {
    return this.matches(token);
  }

  updatePointer(
    token: SemanticMoveSessionToken,
    pointer: Point,
  ): SemanticMovePointerUpdated | SemanticMoveStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    if (active.snapshot.phase !== "moving") {
      throw new SemanticMoveSessionError(
        "INVALID_PHASE",
        "A finished semantic move cannot accept another pointer frame.",
      );
    }
    assertFinitePoint(pointer);
    const delta = freezePoint({
      x: pointer.x - active.snapshot.pointerStart.x,
      y: pointer.y - active.snapshot.pointerStart.y,
    });
    if (delta.x === active.snapshot.delta.x && delta.y === active.snapshot.delta.y) {
      return Object.freeze({
        status: "updated",
        session: active.snapshot,
        lifecycleEvents: EMPTY_EVENTS,
      });
    }

    active.snapshot = freezeSession({
      ...active.snapshot,
      pointerCurrent: freezePoint(pointer),
      delta,
      positionOverrides: freezeOverrides(active.snapshot.cohort, delta),
      dirty: delta.x !== 0 || delta.y !== 0,
    });
    const addedDependencies = discoverDependencies(active);
    if (addedDependencies.length) {
      const dependencyById = new Map(active.dependencyById);
      for (const dependency of addedDependencies) dependencyById.set(dependency.objectId, dependency);
      active.dependencyById = dependencyById;
      const connectorDependencies = Object.freeze([...dependencyById.values()]);
      active.snapshot = freezeSession({
        ...active.snapshot,
        connectorDependencies,
        affectedConnectorIds: Object.freeze(connectorDependencies.map(({ objectId }) => objectId)),
      });
    }

    const lifecycleEvents: SemanticCanvasEditEvent[] = [];
    if (addedDependencies.length) {
      lifecycleEvents.push(dependenciesAddedEvent(active.snapshot, addedDependencies));
    }
    lifecycleEvents.push(changedEvent(active));
    return Object.freeze({
      status: "updated",
      session: active.snapshot,
      lifecycleEvents: Object.freeze(lifecycleEvents),
    });
  }

  finish(
    token: SemanticMoveSessionToken,
    pointer?: Point,
    reason: Extract<SemanticCanvasGestureFinishReason, "pointer-up" | "pointer-cancel"> = "pointer-up",
  ): SemanticMoveFinished | SemanticMoveStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    let frameEvents: readonly SemanticCanvasEditEvent[] = EMPTY_EVENTS;
    if (pointer) {
      const updated = this.updatePointer(token, pointer);
      if (updated.status === "stale") return updated;
      frameEvents = updated.lifecycleEvents;
    }
    return this.finishCurrent(reason, frameEvents);
  }

  pointerCancel(
    token: SemanticMoveSessionToken,
    pointer?: Point,
  ): SemanticMoveFinished | SemanticMoveStaleResult {
    return this.finish(token, pointer, "pointer-cancel");
  }

  /** Checks a newly received room without disturbing unrelated room updates. */
  reconcileAuthoritative(
    token: SemanticMoveSessionToken,
    room: RoomState,
  ): SemanticMoveAuthoritativeCurrent | SemanticMoveRolledBack | SemanticMoveStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const mismatch = baseMismatch(this.active!, room);
    return mismatch
      ? this.rollbackCurrent("authoritative-change", room, mismatch)
      : Object.freeze({ status: "current", session: this.active!.snapshot });
  }

  /** Explicit local cancellation/escape; pointer-cancel must use `pointerCancel`. */
  cancel(
    token: SemanticMoveSessionToken,
    room: RoomState,
  ): SemanticMoveRolledBack | SemanticMoveStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    return this.rollbackCurrent("cancelled", room, null);
  }

  /** Explicit recovery path for a persistence rejection. */
  rollback(
    token: SemanticMoveSessionToken,
    room: RoomState,
    detail: string | null = null,
  ): SemanticMoveRolledBack | SemanticMoveStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    return this.rollbackCurrent("command-rejected", room, detail);
  }

  private finishCurrent(
    reason: Extract<SemanticCanvasGestureFinishReason, "pointer-up" | "pointer-cancel">,
    precedingEvents: readonly SemanticCanvasEditEvent[],
  ): SemanticMoveFinished {
    const active = this.active!;
    active.snapshot = freezeSession({ ...active.snapshot, phase: "finished" });
    const result = Object.freeze({
      status: "finished" as const,
      session: active.snapshot,
      command: null,
      lifecycleEvents: Object.freeze([
        ...precedingEvents,
        finishRequestedEvent(active.snapshot, reason),
      ]),
    });
    this.active = null;
    return result;
  }

  private rollbackCurrent(
    reason: SemanticMoveRolledBack["reason"],
    room: RoomState,
    detail: string | null,
  ): SemanticMoveRolledBack {
    const active = this.active!;
    const result = Object.freeze({
      status: "rolled-back" as const,
      token: active.snapshot.token,
      reason,
      detail,
      positionOverrides: EMPTY_OVERRIDES,
      authoritativePositions: authoritativePositions(room, active.snapshot.objectIds),
      lifecycleEvents: EMPTY_EVENTS,
    });
    this.active = null;
    return result;
  }

  private matches(token: SemanticMoveSessionToken): boolean {
    const current = this.active?.snapshot.token;
    return current?.fence === token.fence && current.sessionId === token.sessionId;
  }
}
