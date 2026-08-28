import { createCanvasObjectSchema } from "@/lib/domain/schemas";
import { normalizeConnectorRouting } from "@/lib/domain/connector-routing";
import { computeAffectedConnectorIds } from "@/lib/domain/connector-dependencies";
import type {
  CanvasObject,
  ConnectorObject,
  ConnectorRoutingInput,
  CreateCanvasObject,
  DiagramNodeType,
  NodeMetadata,
  NodeMetadataInput,
  Point,
  RoomState,
} from "@/lib/domain/types";

import type {
  SemanticCanvasEditEvent,
  SemanticCanvasGestureDependenciesAddedEvent,
  SemanticCanvasGestureFinishRequestedEvent,
  SemanticCanvasGestureStartedEvent,
  SemanticCanvasObjectsChangedEvent,
} from "./semantic-edit-events";
import { planSemanticZOrder, type SemanticZOrderDirection } from "./semantic-z-order";

export const SEMANTIC_TRANSFORM_LIMITS = Object.freeze({
  minDimension: 1,
  maxDimension: 100_000,
});

export type SemanticResizeHandle =
  | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type SemanticTransformMode = "resize" | "rotate";
export type SemanticTransformToken = Readonly<{ sessionId: string; fence: number }>;
export type SemanticTransformBounds = Readonly<{
  x: number; y: number; width: number; height: number;
}>;
export type SemanticTransformFrame = Readonly<{
  bounds: SemanticTransformBounds;
  /** A sole rectangular object transforms in its own rotated local axes. */
  rotation: number;
  localAxes: boolean;
}>;
export type SemanticTransformPointerOptions = Readonly<{
  lockAspectRatio?: boolean;
}>;

export type SemanticTransformSelectionReport = Readonly<{
  missingObjectIds: readonly string[];
  missingGroupIds: readonly string[];
  lockedImageObjectIds: readonly string[];
}>;

export type SemanticTransformMember = Readonly<{
  objectId: string;
  kind: CanvasObject["kind"];
  baseRevision: number;
  baseCreatedAt: number;
  groupId: string | null;
  movedViaGroup: boolean;
}>;

export type SemanticTransformSession = Readonly<{
  token: SemanticTransformToken;
  gestureId: string;
  roomId: string;
  baseRoomRevision: number;
  mode: SemanticTransformMode;
  handle: SemanticResizeHandle | null;
  pointerStart: Readonly<Point>;
  pointerCurrent: Readonly<Point>;
  bounds: SemanticTransformBounds;
  baseBounds: SemanticTransformBounds;
  rotationDelta: number;
  cohort: readonly SemanticTransformMember[];
  objectIds: readonly string[];
  drafts: Readonly<Record<string, CreateCanvasObject>>;
  connectorDependencies: readonly Readonly<{ objectId: string; baseRevision: number; baseCreatedAt: number }>[];
  affectedConnectorIds: readonly string[];
  selectionReport: SemanticTransformSelectionReport;
  dirty: boolean;
  phase: "transforming" | "finished" | "aborted";
}>;

export type SemanticTransformStarted = Readonly<{
  status: "started";
  session: SemanticTransformSession;
  lifecycleEvent: SemanticCanvasGestureStartedEvent;
  superseded: SemanticTransformFinished | null;
}>;
export type SemanticTransformBlocked = Readonly<{
  status: "blocked";
  reason: "no-transformable-objects";
  selectionReport: SemanticTransformSelectionReport;
  superseded: SemanticTransformFinished | null;
}>;
export type SemanticTransformUpdated = Readonly<{
  status: "updated";
  session: SemanticTransformSession;
  lifecycleEvents: readonly SemanticCanvasEditEvent[];
}>;
export type SemanticTransformFinished = Readonly<{
  status: "finished";
  session: SemanticTransformSession;
  command: null;
  lifecycleEvents: readonly SemanticCanvasEditEvent[];
}>;
export type SemanticTransformStale = Readonly<{
  status: "stale";
  token: SemanticTransformToken;
}>;
export type SemanticTransformAborted = Readonly<{
  status: "aborted";
  session: SemanticTransformSession;
  /** Abort is renderer-local recovery and must never masquerade as a save. */
  lifecycleEvents: readonly [];
}>;

export type SemanticObjectStylePatch =
  | Readonly<{ kind: "text"; color?: string; size?: "s" | "m" | "l" | "xl"; align?: "start" | "middle" | "end" }>
  | Readonly<{ kind: "shape"; fill?: string; stroke?: string; nodeType?: DiagramNodeType | null; nodeMetadata?: NodeMetadataInput | null }>
  | Readonly<{ kind: "connector"; color?: string; direction?: ConnectorObject["direction"]; routing?: ConnectorRoutingInput }>
  | Readonly<{ kind: "draw"; color?: string; size?: "s" | "m" | "l" }>
  | Readonly<{ kind: "image"; alt?: string; locked?: boolean }>;

export type SemanticOneShotResult = Readonly<{
  status: "finished" | "noop";
  gestureId: string;
  targetObjectIds: readonly string[];
  command: null;
  lifecycleEvents: readonly SemanticCanvasEditEvent[];
}>;

export class SemanticTransformSessionError extends Error {
  constructor(
    readonly code: "INVALID_POINTER" | "INVALID_STYLE" | "INVALID_GROUP_ID" | "INVALID_ORDER",
    message: string,
  ) {
    super(message);
    this.name = "SemanticTransformSessionError";
  }
}

type InternalSession = {
  snapshot: SemanticTransformSession;
  baseObjects: readonly CanvasObject[];
  baseline: RoomState;
  dependencyById: Map<string, Readonly<{ objectId: string; baseRevision: number; baseCreatedAt: number }>>;
};

const EMPTY_EVENTS = Object.freeze([]) as readonly [];

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function finitePoint(point: Point): void {
  if (Number.isFinite(point.x) && Number.isFinite(point.y)) return;
  throw new SemanticTransformSessionError("INVALID_POINTER", "Transform pointers must use finite page-space coordinates.");
}

function nodeMetadataInput(metadata: NodeMetadata | null | undefined): NodeMetadataInput | null | undefined {
  if (metadata === undefined || metadata === null) return metadata;
  const value = metadata as NodeMetadataInput & { resolvedAt?: number | null };
  const { kind, status, owner, resolution } = value;
  return { kind, status, owner, resolution } as NodeMetadataInput;
}

function draftFromObject(object: CanvasObject): CreateCanvasObject {
  const {
    revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt,
    createdBy: _createdBy, lastEditedBy: _lastEditedBy, diagramIds: _diagramIds,
    ...draft
  } = object;
  void _revision; void _createdAt; void _updatedAt; void _createdBy; void _lastEditedBy; void _diagramIds;
  if (draft.kind === "shape") return { ...draft, nodeMetadata: nodeMetadataInput(draft.nodeMetadata) };
  if (draft.kind === "draw") return { ...draft, points: draft.points.map((point) => ({ ...point })) };
  if (draft.kind === "connector") return {
    ...draft,
    start: { ...draft.start, normalizedAnchor: draft.start.normalizedAnchor ? { ...draft.start.normalizedAnchor } : draft.start.normalizedAnchor },
    end: { ...draft.end, normalizedAnchor: draft.end.normalizedAnchor ? { ...draft.end.normalizedAnchor } : draft.end.normalizedAnchor },
    routing: draft.routing ? { ...draft.routing } : undefined,
  };
  return { ...draft };
}

function rotatedCorners(object: CanvasObject): Point[] {
  if (object.kind === "connector") {
    return [{ x: object.start.x, y: object.start.y }, { x: object.end.x, y: object.end.y }];
  }
  if (object.kind === "draw") {
    const cosine = Math.cos(object.rotation);
    const sine = Math.sin(object.rotation);
    return object.points.map((point) => ({
      x: object.x + point.x * cosine - point.y * sine,
      y: object.y + point.x * sine + point.y * cosine,
    }));
  }
  const cx = object.x + object.width / 2;
  const cy = object.y + object.height / 2;
  const cosine = Math.cos(object.rotation);
  const sine = Math.sin(object.rotation);
  return [
    { x: object.x, y: object.y },
    { x: object.x + object.width, y: object.y },
    { x: object.x + object.width, y: object.y + object.height },
    { x: object.x, y: object.y + object.height },
  ].map((point) => {
    const dx = point.x - cx;
    const dy = point.y - cy;
    return { x: cx + dx * cosine - dy * sine, y: cy + dx * sine + dy * cosine };
  });
}

function boundsFor(objects: readonly CanvasObject[]): SemanticTransformBounds {
  const points = objects.flatMap(rotatedCorners);
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return Object.freeze({
    x: stableCoordinate(minX),
    y: stableCoordinate(minY),
    width: clampDimension(maxX - minX),
    height: clampDimension(maxY - minY),
  });
}

/**
 * The canonical page-space transform frame shared by the engine and overlay.
 * A sole non-connector keeps its logical box and rotation so its handles resize
 * in local axes. Cohorts (including drawings and connectors) use one stable,
 * axis-aligned union for deterministic scaling and rotation.
 */
export function semanticTransformFrameForObjects(
  objects: readonly CanvasObject[],
): SemanticTransformFrame | null {
  if (!objects.length) return null;
  const sole = objects.length === 1 ? objects[0]! : null;
  if (sole && sole.kind !== "connector" && sole.kind !== "draw") {
    return Object.freeze({
      bounds: Object.freeze({
        x: sole.x,
        y: sole.y,
        width: clampDimension(sole.width),
        height: clampDimension(sole.height),
      }),
      rotation: sole.rotation,
      localAxes: true,
    });
  }
  return Object.freeze({ bounds: boundsFor(objects), rotation: 0, localAxes: false });
}

function selection(
  room: RoomState,
  selectedObjectIds: readonly string[],
  selectedGroupIds: readonly string[],
): { objects: CanvasObject[]; report: SemanticTransformSelectionReport; movedViaGroup: Set<string> } {
  const selected = new Set(selectedObjectIds);
  const groups = new Set(selectedGroupIds);
  const existingGroups = new Set(Object.values(room.objects).flatMap((object) => object.groupId ? [object.groupId] : []));
  for (const id of selectedObjectIds) {
    const groupId = room.objects[id]?.groupId;
    if (groupId) groups.add(groupId);
  }
  const movedViaGroup = new Set<string>();
  const locked: string[] = [];
  const objects = Object.values(room.objects).filter((object) => {
    const viaGroup = Boolean(object.groupId && groups.has(object.groupId));
    if (!selected.has(object.id) && !viaGroup) return false;
    if (viaGroup) movedViaGroup.add(object.id);
    if (object.kind === "image" && object.locked && !viaGroup) {
      locked.push(object.id);
      return false;
    }
    return true;
  }).sort((a, b) => a.id.localeCompare(b.id));
  return {
    objects,
    movedViaGroup,
    report: Object.freeze({
      missingObjectIds: Object.freeze(sortedUnique(selectedObjectIds.filter((id) => !room.objects[id]))),
      missingGroupIds: Object.freeze(sortedUnique(selectedGroupIds.filter((id) => !existingGroups.has(id)))),
      lockedImageObjectIds: Object.freeze(sortedUnique(locked)),
    }),
  };
}

function clampDimension(value: number): number {
  const clamped = Math.min(SEMANTIC_TRANSFORM_LIMITS.maxDimension, Math.max(SEMANTIC_TRANSFORM_LIMITS.minDimension, value));
  return Math.round(clamped * 1_000_000_000) / 1_000_000_000;
}

function stableCoordinate(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function resizedBounds(
  base: SemanticTransformBounds,
  handle: SemanticResizeHandle,
  pointerStart: Point,
  pointer: Point,
  lockAspectRatio = false,
): SemanticTransformBounds {
  const dx = pointer.x - pointerStart.x;
  const dy = pointer.y - pointerStart.y;
  let left = base.x;
  let top = base.y;
  let right = base.x + base.width;
  let bottom = base.y + base.height;
  if (handle.includes("w")) left = Math.min(right - 1, left + dx);
  if (handle.includes("e")) right = Math.max(left + 1, right + dx);
  if (handle.includes("n")) top = Math.min(bottom - 1, top + dy);
  if (handle.includes("s")) bottom = Math.max(top + 1, bottom + dy);
  if (lockAspectRatio) {
    const ratio = base.width / base.height;
    const movesX = handle.includes("w") || handle.includes("e");
    const movesY = handle.includes("n") || handle.includes("s");
    let width = right - left;
    let height = bottom - top;
    if (movesX && movesY) {
      if (width / base.width >= height / base.height) height = width / ratio;
      else width = height * ratio;
    } else if (movesX) {
      height = width / ratio;
      top = base.y + (base.height - height) / 2;
      bottom = top + height;
    } else if (movesY) {
      width = height * ratio;
      left = base.x + (base.width - width) / 2;
      right = left + width;
    }
    if (handle.includes("w")) left = right - width;
    else if (handle.includes("e")) right = left + width;
    if (handle.includes("n")) top = bottom - height;
    else if (handle.includes("s")) bottom = top + height;
  }
  return Object.freeze({ x: left, y: top, width: clampDimension(right - left), height: clampDimension(bottom - top) });
}

function unrotateVector(vector: Point, radians: number): Point {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: stableCoordinate(vector.x * cosine + vector.y * sine),
    y: stableCoordinate(-vector.x * sine + vector.y * cosine),
  };
}

function resizeSoleRotatedObject(
  object: CanvasObject,
  handle: SemanticResizeHandle,
  pointerStart: Point,
  pointer: Point,
  lockAspectRatio: boolean,
): { bounds: SemanticTransformBounds; draft: CreateCanvasObject } {
  const base = Object.freeze({ x: 0, y: 0, width: object.width, height: object.height });
  const localDelta = unrotateVector(
    { x: pointer.x - pointerStart.x, y: pointer.y - pointerStart.y },
    object.rotation,
  );
  const local = resizedBounds(base, handle, { x: 0, y: 0 }, localDelta, lockAspectRatio);
  const baseCenter = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  const localCenterOffset = {
    x: local.x + local.width / 2 - object.width / 2,
    y: local.y + local.height / 2 - object.height / 2,
  };
  const rotatedCenterOffset = rotatePoint(localCenterOffset, { x: 0, y: 0 }, object.rotation);
  const center = {
    x: stableCoordinate(baseCenter.x + rotatedCenterOffset.x),
    y: stableCoordinate(baseCenter.y + rotatedCenterOffset.y),
  };
  const bounds = Object.freeze({
    x: stableCoordinate(center.x - local.width / 2),
    y: stableCoordinate(center.y - local.height / 2),
    width: local.width,
    height: local.height,
  });
  return {
    bounds,
    draft: validateDraft({
      ...draftFromObject(object),
      ...bounds,
      rotation: object.rotation,
    } as CreateCanvasObject),
  };
}

function mapPoint(point: Point, from: SemanticTransformBounds, to: SemanticTransformBounds): Point {
  return {
    x: stableCoordinate(to.x + ((point.x - from.x) / from.width) * to.width),
    y: stableCoordinate(to.y + ((point.y - from.y) / from.height) * to.height),
  };
}

function rotatePoint(point: Point, center: Point, radians: number): Point {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: stableCoordinate(center.x + dx * cosine - dy * sine), y: stableCoordinate(center.y + dx * sine + dy * cosine) };
}

function transformDraftForResize(object: CanvasObject, from: SemanticTransformBounds, to: SemanticTransformBounds): CreateCanvasObject {
  const draft = draftFromObject(object);
  const scaleX = to.width / from.width;
  const scaleY = to.height / from.height;
  if (draft.kind === "connector") {
    const start = mapPoint(draft.start, from, to);
    const end = mapPoint(draft.end, from, to);
    return { ...draft, x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: clampDimension(Math.abs(end.x - start.x)), height: clampDimension(Math.abs(end.y - start.y)), start: { ...draft.start, ...start }, end: { ...draft.end, ...end } };
  }
  if (draft.kind === "draw") {
    const cosine = Math.cos(draft.rotation);
    const sine = Math.sin(draft.rotation);
    const inverseCosine = Math.cos(-draft.rotation);
    const inverseSine = Math.sin(-draft.rotation);
    const mappedOrigin = mapPoint({ x: draft.x, y: draft.y }, from, to);
    const rawPoints = draft.points.map((point) => {
      const rendered = {
        x: draft.x + point.x * cosine - point.y * sine,
        y: draft.y + point.x * sine + point.y * cosine,
      };
      const mapped = mapPoint(rendered, from, to);
      const dx = mapped.x - mappedOrigin.x;
      const dy = mapped.y - mappedOrigin.y;
      return {
        x: stableCoordinate(dx * inverseCosine - dy * inverseSine),
        y: stableCoordinate(dx * inverseSine + dy * inverseCosine),
      };
    });
    const minX = Math.min(...rawPoints.map((point) => point.x));
    const minY = Math.min(...rawPoints.map((point) => point.y));
    const maxX = Math.max(...rawPoints.map((point) => point.x));
    const maxY = Math.max(...rawPoints.map((point) => point.y));
    const normalizedOrigin = {
      x: stableCoordinate(mappedOrigin.x + minX * cosine - minY * sine),
      y: stableCoordinate(mappedOrigin.y + minX * sine + minY * cosine),
    };
    return {
      ...draft,
      ...normalizedOrigin,
      width: clampDimension(maxX - minX),
      height: clampDimension(maxY - minY),
      points: rawPoints.map((point) => ({
        x: stableCoordinate(point.x - minX),
        y: stableCoordinate(point.y - minY),
      })),
    };
  }
  const center = mapPoint({ x: object.x + object.width / 2, y: object.y + object.height / 2 }, from, to);
  const width = clampDimension(object.width * scaleX);
  const height = clampDimension(object.height * scaleY);
  return { ...draft, x: stableCoordinate(center.x - width / 2), y: stableCoordinate(center.y - height / 2), width, height };
}

function transformDraftForRotation(object: CanvasObject, center: Point, delta: number): CreateCanvasObject {
  const draft = draftFromObject(object);
  if (draft.kind === "connector") {
    const start = rotatePoint(draft.start, center, delta);
    const end = rotatePoint(draft.end, center, delta);
    return { ...draft, x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: clampDimension(Math.abs(end.x - start.x)), height: clampDimension(Math.abs(end.y - start.y)), start: { ...draft.start, ...start }, end: { ...draft.end, ...end } };
  }
  if (draft.kind === "draw") {
    const origin = rotatePoint({ x: object.x, y: object.y }, center, delta);
    return { ...draft, ...origin, rotation: object.rotation + delta };
  }
  const objectCenter = rotatePoint({ x: object.x + object.width / 2, y: object.y + object.height / 2 }, center, delta);
  return { ...draft, x: objectCenter.x - object.width / 2, y: objectCenter.y - object.height / 2, rotation: object.rotation + delta };
}

function validateDraft(draft: CreateCanvasObject): CreateCanvasObject {
  const parsed = createCanvasObjectSchema.safeParse(draft);
  if (!parsed.success) throw new SemanticTransformSessionError("INVALID_STYLE", parsed.error.issues[0]?.message ?? "Invalid semantic draft.");
  return parsed.data;
}

function changedEvent(session: SemanticTransformSession): SemanticCanvasObjectsChangedEvent {
  return Object.freeze({
    type: "objects.changed",
    gestureId: session.gestureId,
    changes: Object.freeze(session.cohort.map((member) => Object.freeze({
      kind: "update" as const,
      draft: session.drafts[member.objectId]!,
      baseRevision: member.baseRevision,
      baseCreatedAt: member.baseCreatedAt,
      operation: "resize" as const,
    }))),
  });
}

function discoverDependencies(active: InternalSession): Readonly<{ objectId: string; baseRevision: number; baseCreatedAt: number }>[] {
  const objects = { ...active.baseline.objects };
  for (const object of active.baseObjects) {
    const draft = active.snapshot.drafts[object.id];
    if (draft) objects[object.id] = { ...object, ...draft } as CanvasObject;
  }
  const affected = computeAffectedConnectorIds({
    baseline: active.baseline,
    current: { ...active.baseline, objects },
    touchedObjectIds: new Set(active.snapshot.objectIds),
  });
  return [...affected].flatMap((objectId) => {
    if (active.dependencyById.has(objectId) || active.snapshot.objectIds.includes(objectId)) return [];
    const object = active.baseline.objects[objectId];
    return object?.kind === "connector"
      ? [Object.freeze({ objectId, baseRevision: object.revision, baseCreatedAt: object.createdAt })]
      : [];
  });
}

function dependenciesEvent(
  session: SemanticTransformSession,
  dependencies: readonly Readonly<{ objectId: string; baseRevision: number; baseCreatedAt: number }>[],
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

function startEvent(session: SemanticTransformSession): SemanticCanvasGestureStartedEvent {
  return Object.freeze({ type: "gesture.started", gestureId: session.gestureId, source: "pointer", objects: Object.freeze(session.cohort.map((member) => Object.freeze({ objectId: member.objectId, baseRevision: member.baseRevision, baseCreatedAt: member.baseCreatedAt, operation: "resize" as const }))) });
}

function finishEvent(gestureId: string, reason: "pointer-up" | "pointer-cancel" | "keyboard-idle"): SemanticCanvasGestureFinishRequestedEvent {
  return Object.freeze({ type: "gesture.finish-requested", gestureId, reason });
}

function freezeSession(session: SemanticTransformSession): SemanticTransformSession {
  return Object.freeze({ ...session, drafts: Object.freeze({ ...session.drafts }) });
}

export class SemanticTransformSessionEngine {
  private fence = 0;
  private active: InternalSession | null = null;

  begin(input: Readonly<{ room: RoomState; mode: SemanticTransformMode; handle?: SemanticResizeHandle; selectedObjectIds: readonly string[]; selectedGroupIds?: readonly string[]; pointerStart: Point }>): SemanticTransformStarted | SemanticTransformBlocked {
    finitePoint(input.pointerStart);
    const superseded = this.active ? this.finishCurrent("pointer-cancel") : null;
    const baseline = structuredClone(input.room);
    const resolved = selection(baseline, sortedUnique(input.selectedObjectIds), sortedUnique(input.selectedGroupIds ?? []));
    if (!resolved.objects.length) return Object.freeze({ status: "blocked", reason: "no-transformable-objects", selectionReport: resolved.report, superseded });
    const frame = semanticTransformFrameForObjects(resolved.objects)!;
    const baseBounds = frame.bounds;
    const token = Object.freeze({ sessionId: `semantic-transform:${++this.fence}`, fence: this.fence });
    const cohort = Object.freeze(resolved.objects.map((object) => Object.freeze({ objectId: object.id, kind: object.kind, baseRevision: object.revision, baseCreatedAt: object.createdAt, groupId: object.groupId, movedViaGroup: resolved.movedViaGroup.has(object.id) })));
    const drafts = Object.freeze(Object.fromEntries(resolved.objects.map((object) => [object.id, draftFromObject(object)])));
    const snapshot = freezeSession({ token, gestureId: token.sessionId, roomId: input.room.id, baseRoomRevision: input.room.roomRevision, mode: input.mode, handle: input.mode === "resize" ? input.handle ?? "se" : null, pointerStart: Object.freeze({ ...input.pointerStart }), pointerCurrent: Object.freeze({ ...input.pointerStart }), bounds: baseBounds, baseBounds, rotationDelta: 0, cohort, objectIds: Object.freeze(cohort.map((member) => member.objectId)), drafts, connectorDependencies: Object.freeze([]), affectedConnectorIds: Object.freeze([]), selectionReport: resolved.report, dirty: false, phase: "transforming" });
    this.active = { snapshot, baseObjects: resolved.objects, baseline, dependencyById: new Map() };
    return Object.freeze({ status: "started", session: snapshot, lifecycleEvent: startEvent(snapshot), superseded });
  }

  current(): SemanticTransformSession | null { return this.active?.snapshot ?? null; }
  isCurrent(token: SemanticTransformToken): boolean { return this.active?.snapshot.token.sessionId === token.sessionId && this.active.snapshot.token.fence === token.fence; }

  updatePointer(
    token: SemanticTransformToken,
    pointer: Point,
    options: SemanticTransformPointerOptions = {},
  ): SemanticTransformUpdated | SemanticTransformStale {
    if (!this.isCurrent(token)) return Object.freeze({ status: "stale", token });
    finitePoint(pointer);
    const active = this.active!;
    if (pointer.x === active.snapshot.pointerCurrent.x && pointer.y === active.snapshot.pointerCurrent.y) return Object.freeze({ status: "updated", session: active.snapshot, lifecycleEvents: EMPTY_EVENTS });
    let drafts: Record<string, CreateCanvasObject>;
    let bounds = active.snapshot.baseBounds;
    let rotationDelta = 0;
    if (active.snapshot.mode === "resize") {
      const frame = semanticTransformFrameForObjects(active.baseObjects)!;
      if (frame.localAxes) {
        const resized = resizeSoleRotatedObject(
          active.baseObjects[0]!,
          active.snapshot.handle!,
          active.snapshot.pointerStart,
          pointer,
          options.lockAspectRatio === true,
        );
        bounds = resized.bounds;
        drafts = { [active.baseObjects[0]!.id]: resized.draft };
      } else {
        bounds = resizedBounds(
          active.snapshot.baseBounds,
          active.snapshot.handle!,
          active.snapshot.pointerStart,
          pointer,
          options.lockAspectRatio === true,
        );
        drafts = Object.fromEntries(active.baseObjects.map((object) => [object.id, validateDraft(transformDraftForResize(object, active.snapshot.baseBounds, bounds))]));
      }
    } else {
      const center = { x: active.snapshot.baseBounds.x + active.snapshot.baseBounds.width / 2, y: active.snapshot.baseBounds.y + active.snapshot.baseBounds.height / 2 };
      const startAngle = Math.atan2(active.snapshot.pointerStart.y - center.y, active.snapshot.pointerStart.x - center.x);
      const currentAngle = Math.atan2(pointer.y - center.y, pointer.x - center.x);
      rotationDelta = currentAngle - startAngle;
      drafts = Object.fromEntries(active.baseObjects.map((object) => [object.id, validateDraft(transformDraftForRotation(object, center, rotationDelta))]));
      bounds = boundsFor(active.baseObjects.map((object) => ({ ...object, ...drafts[object.id] }) as CanvasObject));
    }
    active.snapshot = freezeSession({ ...active.snapshot, pointerCurrent: Object.freeze({ ...pointer }), bounds, rotationDelta, drafts: Object.freeze(drafts), dirty: true });
    const added = discoverDependencies(active);
    if (added.length) {
      for (const dependency of added) active.dependencyById.set(dependency.objectId, dependency);
      const connectorDependencies = Object.freeze([...active.dependencyById.values()]);
      active.snapshot = freezeSession({ ...active.snapshot, connectorDependencies, affectedConnectorIds: Object.freeze(connectorDependencies.map((dependency) => dependency.objectId)) });
    }
    const lifecycleEvents: SemanticCanvasEditEvent[] = [];
    if (added.length) lifecycleEvents.push(dependenciesEvent(active.snapshot, added));
    lifecycleEvents.push(changedEvent(active.snapshot));
    return Object.freeze({ status: "updated", session: active.snapshot, lifecycleEvents: Object.freeze(lifecycleEvents) });
  }

  finish(token: SemanticTransformToken, reason: "pointer-up" | "pointer-cancel"): SemanticTransformFinished | SemanticTransformStale {
    if (!this.isCurrent(token)) return Object.freeze({ status: "stale", token });
    return this.finishCurrent(reason);
  }

  abort(token: SemanticTransformToken): SemanticTransformAborted | SemanticTransformStale {
    if (!this.isCurrent(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    const snapshot = freezeSession({ ...active.snapshot, phase: "aborted" });
    this.active = null;
    ++this.fence;
    return Object.freeze({ status: "aborted", session: snapshot, lifecycleEvents: EMPTY_EVENTS });
  }

  private finishCurrent(reason: "pointer-up" | "pointer-cancel"): SemanticTransformFinished {
    const active = this.active!;
    const snapshot = freezeSession({ ...active.snapshot, phase: "finished" });
    this.active = null;
    return Object.freeze({ status: "finished", session: snapshot, command: null, lifecycleEvents: Object.freeze(snapshot.dirty ? [changedEvent(snapshot), finishEvent(snapshot.gestureId, reason)] : [finishEvent(snapshot.gestureId, reason)]) });
  }
}

function oneShot(
  room: RoomState,
  gestureId: string,
  objects: readonly CanvasObject[],
  drafts: readonly CreateCanvasObject[],
  forceObjectIds: ReadonlySet<string> = new Set(),
): SemanticOneShotResult {
  void room;
  const changedPairs = objects.flatMap((object, index) =>
    forceObjectIds.has(object.id) || JSON.stringify(draftFromObject(object)) !== JSON.stringify(drafts[index])
      ? [{ object, draft: drafts[index]! }]
      : []);
  if (!changedPairs.length) return Object.freeze({ status: "noop", gestureId, targetObjectIds: Object.freeze([]), command: null, lifecycleEvents: EMPTY_EVENTS });
  const changes = Object.freeze(changedPairs.map(({ object, draft }) => Object.freeze({ kind: "update" as const, draft: validateDraft(draft), baseRevision: object.revision, baseCreatedAt: object.createdAt, operation: "edit" as const })));
  const changedObjects = changedPairs.map(({ object }) => object);
  const ids = Object.freeze(changedObjects.map((object) => object.id));
  return Object.freeze({ status: "finished", gestureId, targetObjectIds: ids, command: null, lifecycleEvents: Object.freeze([
    Object.freeze({ type: "gesture.started", gestureId, source: "keyboard", objects: Object.freeze(changedObjects.map((object) => Object.freeze({ objectId: object.id, baseRevision: object.revision, baseCreatedAt: object.createdAt, operation: "edit" as const }))) }),
    Object.freeze({ type: "objects.changed", gestureId, changes }),
    finishEvent(gestureId, "keyboard-idle"),
  ]) });
}

export function applySemanticObjectStyles(input: Readonly<{ room: RoomState; gestureId: string; objectIds: readonly string[]; patch: SemanticObjectStylePatch }>): SemanticOneShotResult {
  const objects = sortedUnique(input.objectIds).flatMap((id) => input.room.objects[id] ? [input.room.objects[id]!] : []);
  const targets = objects.filter((object) => object.kind === input.patch.kind);
  const patch = { ...input.patch } as Record<string, unknown>;
  delete patch.kind;
  if (input.patch.kind === "connector" && input.patch.routing) {
    patch.routing = normalizeConnectorRouting(input.patch.routing);
  }
  const drafts = targets.map((object) => {
    const draft = { ...draftFromObject(object), ...patch } as CreateCanvasObject;
    if (draft.kind !== "shape" || input.patch.kind !== "shape") return draft;

    const nextNodeType = input.patch.nodeType === undefined
      ? draft.nodeType
      : input.patch.nodeType;
    let nextMetadata = input.patch.nodeMetadata;
    if (nextMetadata === undefined) {
      const currentMetadata = nodeMetadataInput(object.kind === "shape" ? object.nodeMetadata : null);
      if (nextNodeType === "decision") {
        nextMetadata = currentMetadata?.kind === "decision"
          ? currentMetadata
          : { kind: "decision", status: "proposed", owner: null, resolution: null };
      } else if (nextNodeType === "open_question") {
        nextMetadata = currentMetadata?.kind === "open_question"
          ? currentMetadata
          : { kind: "open_question", status: "open", owner: null, resolution: null };
      } else {
        nextMetadata = null;
      }
    }
    if (nextMetadata !== null && nextMetadata.kind !== nextNodeType) {
      throw new SemanticTransformSessionError(
        "INVALID_STYLE",
        `Node metadata kind ${nextMetadata.kind} is incompatible with node type ${nextNodeType ?? "generic"}.`,
      );
    }
    return { ...draft, nodeType: nextNodeType, nodeMetadata: nextMetadata };
  });
  return oneShot(input.room, input.gestureId, targets, drafts);
}

export function groupSemanticObjects(input: Readonly<{ room: RoomState; gestureId: string; objectIds: readonly string[]; groupId: string }>): SemanticOneShotResult {
  if (!input.groupId || input.groupId.length > 128) throw new SemanticTransformSessionError("INVALID_GROUP_ID", "A semantic group ID must contain 1 to 128 characters.");
  const objects = sortedUnique(input.objectIds).flatMap((id) => input.room.objects[id] ? [input.room.objects[id]!] : []);
  return oneShot(input.room, input.gestureId, objects, objects.map((object) => ({ ...draftFromObject(object), groupId: input.groupId })));
}

export function ungroupSemanticObjects(input: Readonly<{ room: RoomState; gestureId: string; objectIds?: readonly string[]; groupIds?: readonly string[] }>): SemanticOneShotResult {
  const groups = new Set(input.groupIds ?? []);
  for (const id of input.objectIds ?? []) {
    const groupId = input.room.objects[id]?.groupId;
    if (groupId) groups.add(groupId);
  }
  const direct = new Set(input.objectIds ?? []);
  const objects = Object.values(input.room.objects).filter((object) => direct.has(object.id) || Boolean(object.groupId && groups.has(object.groupId))).sort((a, b) => a.id.localeCompare(b.id));
  return oneShot(input.room, input.gestureId, objects, objects.map((object) => ({ ...draftFromObject(object), groupId: null })));
}

export function orderSemanticObjects(input: Readonly<{
  room: RoomState;
  gestureId: string;
  objectIds: readonly string[];
  mode: SemanticZOrderDirection | "explicit";
  zIndexById?: Readonly<Record<string, number>>;
}>): SemanticOneShotResult {
  const directIds = new Set(input.objectIds);
  if (input.mode === "explicit") {
    const objects = sortedUnique(input.objectIds)
      .flatMap((id) => input.room.objects[id] ? [input.room.objects[id]!] : []);
    const drafts = objects.map((object) => {
      const zIndex = input.zIndexById?.[object.id];
      if (!Number.isInteger(zIndex) || zIndex! < 0 || zIndex! > 1_000_000) {
        throw new SemanticTransformSessionError("INVALID_ORDER", `Invalid zIndex for ${object.id}.`);
      }
      return { ...draftFromObject(object), zIndex: zIndex! } as CreateCanvasObject;
    });
    return oneShot(input.room, input.gestureId, objects, drafts);
  }

  const selectedGroupIds = new Set(
    input.objectIds.flatMap((id) => {
      const groupId = input.room.objects[id]?.groupId;
      return groupId ? [groupId] : [];
    }),
  );
  const objects = Object.values(input.room.objects)
    .filter((object) => {
      const viaGroup = Boolean(object.groupId && selectedGroupIds.has(object.groupId));
      if (!directIds.has(object.id) && !viaGroup) return false;
      return object.kind !== "image" || !object.locked || viaGroup;
    })
    .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));

  const plan = planSemanticZOrder({
    objects: Object.values(input.room.objects),
    selectedObjectIds: objects.map((object) => object.id),
    direction: input.mode,
  });
  if (plan.status === "noop") {
    return Object.freeze({ status: "noop", gestureId: input.gestureId, targetObjectIds: Object.freeze([]), command: null, lifecycleEvents: EMPTY_EVENTS });
  }
  const updates = plan.updates;
  return oneShot(
    input.room,
    input.gestureId,
    updates.map(({ object }) => object),
    updates.map(({ object, zIndex }) => ({ ...draftFromObject(object), zIndex } as CreateCanvasObject)),
    new Set(updates.map(({ object }) => object.id)),
  );
}
