import {
  connectorEndpointSchema,
  connectorRoutingInputSchema,
  createCanvasObjectSchema,
} from "@/lib/domain/schemas";
import {
  computeAffectedConnectorIds,
} from "@/lib/domain/connector-dependencies";
import {
  connectorRouteBounds,
  normalizeConnectorRouting,
  resolveAffectedConnectorRoutes,
  type ResolvedConnectorRoute,
} from "@/lib/domain/connector-routing";
import type {
  ActorRef,
  CanvasObject,
  ConnectorEndpoint,
  ConnectorEndpointSnap,
  ConnectorObject,
  ConnectorRoutingInput,
  CreateCanvasObject,
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

type ConnectorDraft = Extract<CreateCanvasObject, { kind: "connector" }>;

export type SemanticConnectorTerminal = "start" | "end";
export type SemanticConnectorDirection = ConnectorObject["direction"];

/**
 * A renderer supplies the current pointer in canvas-world coordinates and,
 * when hit testing found a semantic object, its stable ID. Snap metadata is
 * explicit input rather than an inference from visual style.
 */
export type SemanticConnectorPointerTarget = Readonly<{
  point: Point;
  objectId?: string | null;
  /** Defaults to `none`. Auto routing may choose a different port and clears it. */
  snap?: ConnectorEndpointSnap;
  /** True deliberately lets the connector enter the target at its anchor. */
  isExact?: boolean;
}>;

export type SemanticConnectorCreateInput = Readonly<{
  room: RoomState;
  id: string;
  start: SemanticConnectorPointerTarget;
  /** Defaults to a free point colocated with `start` until the first frame. */
  end?: SemanticConnectorPointerTarget;
  routing?: ConnectorRoutingInput;
  direction?: SemanticConnectorDirection;
  label?: string;
  color?: string;
  zIndex: number;
  groupId?: string | null;
}>;

export type SemanticConnectorEditInput = Readonly<{
  room: RoomState;
  connectorId: string;
  /** When present, `updatePointer` edits this terminal. */
  terminal?: SemanticConnectorTerminal | null;
}>;

export type SemanticConnectorEditPatch = Readonly<{
  start?: SemanticConnectorPointerTarget;
  end?: SemanticConnectorPointerTarget;
  routing?: ConnectorRoutingInput;
  direction?: SemanticConnectorDirection;
  label?: string;
  color?: string;
  zIndex?: number;
  groupId?: string | null;
}>;

export type SemanticConnectorSessionToken = Readonly<{
  sessionId: string;
  fence: number;
}>;

export type SemanticConnectorDependency = Readonly<{
  objectId: string;
  baseRevision: number;
  baseCreatedAt: number;
}>;

export type SemanticConnectorSessionPhase = "prepared" | "connecting" | "finished";
export type SemanticConnectorSessionMode = "create" | "update";

export type SemanticConnectorSession = Readonly<{
  token: SemanticConnectorSessionToken;
  gestureId: string;
  mode: SemanticConnectorSessionMode;
  phase: SemanticConnectorSessionPhase;
  roomId: string;
  baseRoomRevision: number;
  objectId: string;
  baseRevision: number | null;
  baseCreatedAt: number | null;
  editingTerminal: SemanticConnectorTerminal | null;
  draft: ConnectorDraft;
  previewRoute: ResolvedConnectorRoute;
  connectorDependencies: readonly SemanticConnectorDependency[];
  affectedConnectorIds: readonly string[];
  dirty: boolean;
}>;

export type SemanticConnectorPrepared = Readonly<{
  status: "prepared";
  session: SemanticConnectorSession;
  command: null;
  lifecycleEvents: readonly [];
}>;

export type SemanticConnectorPublished = Readonly<{
  status: "published";
  session: SemanticConnectorSession;
  command: null;
  /** Protection and route dependencies always precede the first draft. */
  lifecycleEvents: readonly SemanticCanvasEditEvent[];
}>;

export type SemanticConnectorEditStarted = Readonly<{
  status: "started";
  session: SemanticConnectorSession;
  command: null;
  lifecycleEvents: readonly [SemanticCanvasGestureStartedEvent];
}>;

export type SemanticConnectorUpdated = Readonly<{
  status: "updated";
  session: SemanticConnectorSession;
  command: null;
  /** Empty for an exact duplicate frame. */
  lifecycleEvents: readonly SemanticCanvasEditEvent[];
}>;

export type SemanticConnectorFinished = Readonly<{
  status: "finished";
  session: SemanticConnectorSession;
  command: null;
  lifecycleEvents: readonly SemanticCanvasEditEvent[];
}>;

export type SemanticConnectorAbandoned = Readonly<{
  status: "abandoned";
  token: SemanticConnectorSessionToken;
  objectId: string;
  clearObjectIds: readonly [string];
  command: null;
  lifecycleEvents: readonly [];
}>;

export type SemanticConnectorStaleResult = Readonly<{
  status: "stale";
  token: SemanticConnectorSessionToken;
}>;

export class SemanticConnectorSessionError extends Error {
  constructor(
    readonly code:
      | "ACTIVE_SESSION"
      | "INVALID_DRAFT"
      | "INVALID_ENDPOINT"
      | "INVALID_PHASE"
      | "INVALID_ROUTING"
      | "INVALID_TARGET"
      | "MISSING_CONNECTOR",
    message: string,
  ) {
    super(message);
    this.name = "SemanticConnectorSessionError";
  }
}

type InternalSession = {
  snapshot: SemanticConnectorSession;
  baseline: RoomState;
  dependencyById: ReadonlyMap<string, SemanticConnectorDependency>;
  syntheticCreatedAt: number;
};

const EMPTY_EVENTS = Object.freeze([]) as readonly [];
const PREVIEW_ACTOR: ActorRef = Object.freeze({
  participantId: "semantic-connector-preview",
  displayName: "Semantic connector preview",
  color: "black",
  kind: "human",
});

function freezePoint(point: Point): Readonly<Point> {
  return Object.freeze({ x: point.x, y: point.y });
}

function assertFinitePoint(point: Point): void {
  if (Number.isFinite(point.x) && Number.isFinite(point.y)) return;
  throw new SemanticConnectorSessionError(
    "INVALID_ENDPOINT",
    "A connector endpoint must contain finite canvas-world coordinates.",
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function objectCenter(object: CanvasObject): Point {
  return { x: object.x + object.width / 2, y: object.y + object.height / 2 };
}

function pointFromNormalizedAnchor(object: CanvasObject, anchor: Point): Point {
  const center = objectCenter(object);
  const local = {
    x: object.x + object.width * anchor.x,
    y: object.y + object.height * anchor.y,
  };
  if (!object.rotation) return local;
  const cosine = Math.cos(object.rotation);
  const sine = Math.sin(object.rotation);
  const dx = local.x - center.x;
  const dy = local.y - center.y;
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine,
  };
}

/** Inverse-rotates a page point into the target's unrotated local bounds. */
export function normalizedConnectorAnchorAtPoint(
  object: Exclude<CanvasObject, { kind: "connector" }>,
  point: Point,
): Point {
  assertFinitePoint(point);
  const center = objectCenter(object);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const cosine = Math.cos(object.rotation);
  const sine = Math.sin(object.rotation);
  const local = {
    x: center.x + dx * cosine + dy * sine,
    y: center.y - dx * sine + dy * cosine,
  };
  return {
    x: clamp((local.x - object.x) / object.width, 0, 1),
    y: clamp((local.y - object.y) / object.height, 0, 1),
  };
}

function snappedAnchor(anchor: Point, snap: ConnectorEndpointSnap): Point {
  if (snap === "center") return { x: 0.5, y: 0.5 };
  if (snap === "none") return anchor;

  const sides = [
    { side: "left" as const, distance: anchor.x },
    { side: "right" as const, distance: 1 - anchor.x },
    { side: "top" as const, distance: anchor.y },
    { side: "bottom" as const, distance: 1 - anchor.y },
  ].sort((left, right) => left.distance - right.distance);
  const side = sides[0].side;
  if (snap === "edge-point") {
    if (side === "left") return { x: 0, y: 0.5 };
    if (side === "right") return { x: 1, y: 0.5 };
    if (side === "top") return { x: 0.5, y: 0 };
    return { x: 0.5, y: 1 };
  }
  if (side === "left") return { x: 0, y: anchor.y };
  if (side === "right") return { x: 1, y: anchor.y };
  if (side === "top") return { x: anchor.x, y: 0 };
  return { x: anchor.x, y: 1 };
}

function endpointForTarget(
  room: RoomState,
  target: SemanticConnectorPointerTarget,
): ConnectorEndpoint {
  assertFinitePoint(target.point);
  const objectId = target.objectId ?? null;
  if (!objectId) {
    if (target.snap !== undefined || target.isExact !== undefined) {
      throw new SemanticConnectorSessionError(
        "INVALID_ENDPOINT",
        "A free connector endpoint cannot carry object-binding metadata.",
      );
    }
    return Object.freeze({ ...freezePoint(target.point), objectId: null });
  }

  const object = room.objects[objectId];
  if (!object) {
    throw new SemanticConnectorSessionError(
      "INVALID_TARGET",
      `Connector target ${objectId} does not exist in the room.`,
    );
  }
  if (object.kind === "connector") {
    throw new SemanticConnectorSessionError(
      "INVALID_TARGET",
      "A connector cannot target another connector.",
    );
  }
  const snap = target.snap ?? "none";
  const isExact = target.isExact ?? false;
  if (isExact && snap !== "none") {
    throw new SemanticConnectorSessionError(
      "INVALID_ENDPOINT",
      "An exact endpoint enters its target and therefore cannot also request edge or center snapping.",
    );
  }
  const normalizedAnchor = snappedAnchor(
    normalizedConnectorAnchorAtPoint(object, target.point),
    snap,
  );
  const endpoint = {
    ...pointFromNormalizedAnchor(object, normalizedAnchor),
    objectId,
    normalizedAnchor,
    // The first-party renderer has an explicit page point, rather than an
    // imprecise hover-only binding. Center snap is precise too.
    isPrecise: true,
    isExact,
    snap,
  } satisfies ConnectorEndpoint;
  const parsed = connectorEndpointSchema.safeParse(endpoint);
  if (!parsed.success) {
    throw new SemanticConnectorSessionError(
      "INVALID_ENDPOINT",
      parsed.error.issues[0]?.message ?? "Invalid connector endpoint.",
    );
  }
  return Object.freeze({
    ...parsed.data,
    ...(parsed.data.normalizedAnchor
      ? { normalizedAnchor: freezePoint(parsed.data.normalizedAnchor) }
      : {}),
  });
}

function parseRouting(input: ConnectorRoutingInput): ConnectorRoutingInput {
  const parsed = connectorRoutingInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.length ? `${first.path.join(".")}: ` : "";
    throw new SemanticConnectorSessionError(
      "INVALID_ROUTING",
      `${path}${first?.message ?? "Invalid connector routing."}`,
    );
  }
  return parsed.data;
}

function freezeEndpoint(endpoint: ConnectorEndpoint): ConnectorEndpoint {
  return Object.freeze({
    ...endpoint,
    ...(endpoint.normalizedAnchor
      ? { normalizedAnchor: freezePoint(endpoint.normalizedAnchor) }
      : {}),
  });
}

function freezeRoute(route: ResolvedConnectorRoute): ResolvedConnectorRoute {
  const points = route.points.map((point) => freezePoint(point)) as Point[];
  const collisionObjectIds = [...route.collisionObjectIds];
  Object.freeze(points);
  Object.freeze(collisionObjectIds);
  return Object.freeze({
    ...route,
    routing: Object.freeze({ ...route.routing }),
    start: freezeEndpoint(route.start),
    end: freezeEndpoint(route.end),
    points,
    labelPoint: freezePoint(route.labelPoint),
    pathBounds: Object.freeze({ ...route.pathBounds }),
    labelBounds: route.labelBounds ? Object.freeze({ ...route.labelBounds }) : null,
    bounds: Object.freeze({ ...route.bounds }),
    collisionObjectIds,
    arc: route.arc
      ? Object.freeze({
          ...route.arc,
          center: freezePoint(route.arc.center),
        })
      : null,
  });
}

function freezeDraft(draft: ConnectorDraft): ConnectorDraft {
  return Object.freeze({
    ...draft,
    start: freezeEndpoint(draft.start),
    end: freezeEndpoint(draft.end),
    routing: draft.routing ? Object.freeze({ ...draft.routing }) : undefined,
  });
}

function validateDraft(draft: ConnectorDraft): ConnectorDraft {
  const parsed = createCanvasObjectSchema.safeParse(draft);
  if (!parsed.success || parsed.data.kind !== "connector") {
    const first = parsed.success ? null : parsed.error.issues[0];
    const path = first?.path.length ? `${first.path.join(".")}: ` : "";
    throw new SemanticConnectorSessionError(
      "INVALID_DRAFT",
      `Invalid connector draft. ${path}${first?.message ?? "Expected a connector."}`,
    );
  }
  return freezeDraft(parsed.data);
}

function connectorObjectFromDraft(
  draft: ConnectorDraft,
  identity: Readonly<{ revision: number; createdAt: number }>,
): ConnectorObject {
  return {
    ...draft,
    routing: normalizeConnectorRouting(draft.routing),
    revision: identity.revision,
    diagramIds: [],
    createdAt: identity.createdAt,
    updatedAt: identity.createdAt,
    createdBy: PREVIEW_ACTOR,
    lastEditedBy: PREVIEW_ACTOR,
  };
}

function routeDraft(
  baseline: RoomState,
  source: ConnectorDraft,
  identity: Readonly<{ revision: number; createdAt: number }>,
): Readonly<{ draft: ConnectorDraft; route: ResolvedConnectorRoute; proposed: RoomState }> {
  const connector = connectorObjectFromDraft(source, identity);
  const proposed: RoomState = {
    ...baseline,
    objects: { ...baseline.objects, [connector.id]: connector },
  };
  // Only the actively edited connector needs a high-quality route preview.
  // Other routes are materialized in stable order for crossing scores, keeping
  // a pointer frame linear outside the one bounded candidate search.
  const route = resolveAffectedConnectorRoutes(
    proposed,
    new Set([connector.id]),
  )[connector.id];
  if (!route) {
    throw new SemanticConnectorSessionError(
      "INVALID_DRAFT",
      `Connector ${connector.id} could not be resolved.`,
    );
  }
  const bounds = connectorRouteBounds(route.points, 0);
  const draft = validateDraft({
    ...source,
    ...bounds,
    rotation: 0,
    start: route.start,
    end: route.end,
    routing: route.routing,
  });
  const routedConnector = connectorObjectFromDraft(draft, identity);
  return Object.freeze({
    draft,
    route: freezeRoute({ ...route, start: draft.start, end: draft.end, routing: draft.routing! }),
    proposed: { ...proposed, objects: { ...proposed.objects, [connector.id]: routedConnector } },
  });
}

function connectorDraftFromObject(object: ConnectorObject): ConnectorDraft {
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
  return validateDraft({
    ...draft,
    routing: normalizeConnectorRouting(draft.routing),
  });
}

function freezeToken(sessionId: string, fence: number): SemanticConnectorSessionToken {
  return Object.freeze({ sessionId, fence });
}

function freezeSession(
  session: Omit<SemanticConnectorSession, "token"> & { token: SemanticConnectorSessionToken },
): SemanticConnectorSession {
  return Object.freeze({ ...session });
}

function startedEvent(session: SemanticConnectorSession): SemanticCanvasGestureStartedEvent {
  return Object.freeze({
    type: "gesture.started",
    gestureId: session.gestureId,
    source: "pointer",
    objects: Object.freeze([
      Object.freeze({
        objectId: session.objectId,
        baseRevision: session.baseRevision,
        baseCreatedAt: session.baseCreatedAt,
        operation: session.mode === "create" ? null : "connect",
      }),
    ]),
  });
}

function dependenciesEvent(
  session: SemanticConnectorSession,
  dependencies: readonly SemanticConnectorDependency[],
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

function changedEvent(session: SemanticConnectorSession): SemanticCanvasObjectsChangedEvent {
  const change = session.mode === "create"
    ? Object.freeze({
        kind: "create" as const,
        draft: session.draft,
        baseRevision: null,
        baseCreatedAt: null,
      })
    : Object.freeze({
        kind: "update" as const,
        draft: session.draft,
        baseRevision: session.baseRevision!,
        baseCreatedAt: session.baseCreatedAt,
        operation: "connect" as const,
      });
  return Object.freeze({
    type: "objects.changed",
    gestureId: session.gestureId,
    changes: Object.freeze([change]),
  });
}

function finishEvent(
  session: SemanticConnectorSession,
  reason: Extract<SemanticCanvasGestureFinishReason, "pointer-up" | "pointer-cancel">,
): SemanticCanvasGestureFinishRequestedEvent {
  return Object.freeze({
    type: "gesture.finish-requested",
    gestureId: session.gestureId,
    reason,
  });
}

function sameDraft(left: ConnectorDraft, right: ConnectorDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Pure first-party connector gesture state machine.
 *
 * It owns no DOM records, renderer values, timers, leases, persistence calls, or
 * CanvasCommands. Hosts render `session.draft` / `previewRoute` immediately and
 * dispatch every returned lifecycle event synchronously in array order.
 */
export class SemanticConnectorSessionEngine {
  private nextFence = 0;
  private active: InternalSession | null = null;

  prepareCreate(input: SemanticConnectorCreateInput): SemanticConnectorPrepared {
    this.assertIdle();
    if (input.room.objects[input.id] || input.room.diagrams[input.id]) {
      throw new SemanticConnectorSessionError(
        "INVALID_DRAFT",
        `Semantic ID ${input.id} already exists in this room.`,
      );
    }
    const baseline = structuredClone(input.room);
    const routingInput = parseRouting(input.routing ?? { mode: "auto" });
    let start = endpointForTarget(baseline, input.start);
    let end = endpointForTarget(
      baseline,
      input.end ?? { point: input.start.point, objectId: null },
    );
    if (routingInput.mode === "auto") {
      if (start.objectId) start = freezeEndpoint({ ...start, snap: "none" });
      if (end.objectId) end = freezeEndpoint({ ...end, snap: "none" });
    }
    const initial: ConnectorDraft = {
      id: input.id,
      kind: "connector",
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.max(Math.abs(end.x - start.x), 1),
      height: Math.max(Math.abs(end.y - start.y), 1),
      rotation: 0,
      zIndex: input.zIndex,
      groupId: input.groupId ?? null,
      start,
      end,
      routing: normalizeConnectorRouting(routingInput),
      direction: input.direction ?? "end",
      label: input.label ?? "",
      color: input.color ?? "black",
    };
    const syntheticCreatedAt = Math.max(
      0,
      ...Object.values(baseline.objects).map((object) => object.createdAt),
    ) + 1;
    const routed = routeDraft(baseline, initial, { revision: 1, createdAt: syntheticCreatedAt });
    const snapshot = this.newSession({
      mode: "create",
      phase: "prepared",
      baseline,
      objectId: input.id,
      baseRevision: null,
      baseCreatedAt: null,
      editingTerminal: "end",
      draft: routed.draft,
      route: routed.route,
      syntheticCreatedAt,
    });
    return Object.freeze({
      status: "prepared",
      session: snapshot,
      command: null,
      lifecycleEvents: EMPTY_EVENTS,
    });
  }

  publish(
    token: SemanticConnectorSessionToken,
  ): SemanticConnectorPublished | SemanticConnectorStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    if (active.snapshot.mode !== "create" || active.snapshot.phase !== "prepared") {
      throw new SemanticConnectorSessionError(
        "INVALID_PHASE",
        "Only a prepared connector creation can be published.",
      );
    }
    active.snapshot = freezeSession({ ...active.snapshot, phase: "connecting" });
    const added = this.discoverDependencies(active);
    this.installDependencies(active, added);
    const events: SemanticCanvasEditEvent[] = [startedEvent(active.snapshot)];
    if (added.length) events.push(dependenciesEvent(active.snapshot, added));
    events.push(changedEvent(active.snapshot));
    return Object.freeze({
      status: "published",
      session: active.snapshot,
      command: null,
      lifecycleEvents: Object.freeze(events),
    });
  }

  beginEdit(input: SemanticConnectorEditInput): SemanticConnectorEditStarted {
    this.assertIdle();
    const baseline = structuredClone(input.room);
    const object = baseline.objects[input.connectorId];
    if (!object || object.kind !== "connector") {
      throw new SemanticConnectorSessionError(
        "MISSING_CONNECTOR",
        `Canvas object ${input.connectorId} is not an editable connector.`,
      );
    }
    const source = connectorDraftFromObject(object);
    const routed = routeDraft(baseline, source, {
      revision: object.revision,
      createdAt: object.createdAt,
    });
    const snapshot = this.newSession({
      mode: "update",
      phase: "connecting",
      baseline,
      objectId: object.id,
      baseRevision: object.revision,
      baseCreatedAt: object.createdAt,
      editingTerminal: input.terminal ?? null,
      draft: routed.draft,
      route: routed.route,
      syntheticCreatedAt: object.createdAt,
    });
    return Object.freeze({
      status: "started",
      session: snapshot,
      command: null,
      lifecycleEvents: Object.freeze([startedEvent(snapshot)]) as readonly [SemanticCanvasGestureStartedEvent],
    });
  }

  current(): SemanticConnectorSession | null {
    return this.active?.snapshot ?? null;
  }

  isCurrent(token: SemanticConnectorSessionToken): boolean {
    return this.matches(token);
  }

  updatePointer(
    token: SemanticConnectorSessionToken,
    target: SemanticConnectorPointerTarget,
  ): SemanticConnectorUpdated | SemanticConnectorStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    if (active.snapshot.phase !== "connecting" || !active.snapshot.editingTerminal) {
      throw new SemanticConnectorSessionError(
        "INVALID_PHASE",
        "This connector session has no active terminal pointer gesture.",
      );
    }
    return this.updateCurrent({
      [active.snapshot.editingTerminal]: target,
    });
  }

  update(
    token: SemanticConnectorSessionToken,
    patch: SemanticConnectorEditPatch,
  ): SemanticConnectorUpdated | SemanticConnectorStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    if (this.active!.snapshot.phase !== "connecting") {
      throw new SemanticConnectorSessionError(
        "INVALID_PHASE",
        "A finished connector session cannot accept another edit.",
      );
    }
    return this.updateCurrent(patch);
  }

  finish(
    token: SemanticConnectorSessionToken,
    target?: SemanticConnectorPointerTarget,
    reason: Extract<SemanticCanvasGestureFinishReason, "pointer-up" | "pointer-cancel"> = "pointer-up",
  ): SemanticConnectorFinished | SemanticConnectorStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    if (active.snapshot.phase !== "connecting") {
      throw new SemanticConnectorSessionError(
        "INVALID_PHASE",
        "Publish a connector creation before requesting its final flush.",
      );
    }
    const preceding: SemanticCanvasEditEvent[] = [];
    if (target) {
      if (!active.snapshot.editingTerminal) {
        throw new SemanticConnectorSessionError(
          "INVALID_PHASE",
          "This connector edit does not have a pointer terminal.",
        );
      }
      const updated = this.updateCurrent({
        [active.snapshot.editingTerminal]: target,
      });
      preceding.push(...updated.lifecycleEvents);
    }
    active.snapshot = freezeSession({ ...active.snapshot, phase: "finished" });
    const result = Object.freeze({
      status: "finished" as const,
      session: active.snapshot,
      command: null,
      lifecycleEvents: Object.freeze([
        ...preceding,
        finishEvent(active.snapshot, reason),
      ]),
    });
    this.active = null;
    return result;
  }

  pointerCancel(
    token: SemanticConnectorSessionToken,
    target?: SemanticConnectorPointerTarget,
  ): SemanticConnectorFinished | SemanticConnectorStaleResult {
    return this.finish(token, target, "pointer-cancel");
  }

  /** Discards only a prepared create, before any lifecycle event was emitted. */
  abandon(
    token: SemanticConnectorSessionToken,
  ): SemanticConnectorAbandoned | SemanticConnectorStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    if (active.snapshot.mode !== "create" || active.snapshot.phase !== "prepared") {
      throw new SemanticConnectorSessionError(
        "INVALID_PHASE",
        "Only an unpublished connector creation can be abandoned.",
      );
    }
    const result = Object.freeze({
      status: "abandoned" as const,
      token: active.snapshot.token,
      objectId: active.snapshot.objectId,
      clearObjectIds: Object.freeze([active.snapshot.objectId]) as readonly [string],
      command: null,
      lifecycleEvents: EMPTY_EVENTS,
    });
    this.active = null;
    return result;
  }

  private updateCurrent(patch: SemanticConnectorEditPatch): SemanticConnectorUpdated {
    const active = this.active!;
    const current = active.snapshot.draft;
    const routing = patch.routing
      ? normalizeConnectorRouting(parseRouting(patch.routing))
      : current.routing;
    let start = patch.start ? endpointForTarget(active.baseline, patch.start) : current.start;
    let end = patch.end ? endpointForTarget(active.baseline, patch.end) : current.end;

    // Auto routing owns its ports. Carrying an earlier explicit snap label while
    // the solver chooses a different anchor would be false metadata.
    if (routing?.mode === "auto") {
      start = freezeEndpoint({ ...start, snap: "none" });
      end = freezeEndpoint({ ...end, snap: "none" });
    }
    const source: ConnectorDraft = {
      ...current,
      start,
      end,
      routing,
      ...(patch.direction !== undefined ? { direction: patch.direction } : {}),
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.zIndex !== undefined ? { zIndex: patch.zIndex } : {}),
      ...(patch.groupId !== undefined ? { groupId: patch.groupId } : {}),
    };
    const routed = routeDraft(active.baseline, source, {
      revision: active.snapshot.baseRevision ?? 1,
      createdAt: active.syntheticCreatedAt,
    });
    if (sameDraft(current, routed.draft)) {
      return Object.freeze({
        status: "updated",
        session: active.snapshot,
        command: null,
        lifecycleEvents: EMPTY_EVENTS,
      });
    }
    active.snapshot = freezeSession({
      ...active.snapshot,
      draft: routed.draft,
      previewRoute: routed.route,
      dirty: true,
    });
    const added = this.discoverDependencies(active);
    this.installDependencies(active, added);
    const events: SemanticCanvasEditEvent[] = [];
    if (added.length) events.push(dependenciesEvent(active.snapshot, added));
    events.push(changedEvent(active.snapshot));
    return Object.freeze({
      status: "updated",
      session: active.snapshot,
      command: null,
      lifecycleEvents: Object.freeze(events),
    });
  }

  private discoverDependencies(active: InternalSession): SemanticConnectorDependency[] {
    const connector = connectorObjectFromDraft(active.snapshot.draft, {
      revision: active.snapshot.baseRevision ?? 1,
      createdAt: active.syntheticCreatedAt,
    });
    const current: RoomState = {
      ...active.baseline,
      objects: { ...active.baseline.objects, [connector.id]: connector },
    };
    const affected = computeAffectedConnectorIds({
      baseline: active.baseline,
      current,
      touchedObjectIds: new Set([connector.id]),
    });
    const dependencies: SemanticConnectorDependency[] = [];
    for (const objectId of affected) {
      if (objectId === connector.id || active.dependencyById.has(objectId)) continue;
      const baseline = active.baseline.objects[objectId];
      if (baseline?.kind !== "connector") continue;
      dependencies.push(Object.freeze({
        objectId,
        baseRevision: baseline.revision,
        baseCreatedAt: baseline.createdAt,
      }));
    }
    return dependencies;
  }

  private installDependencies(
    active: InternalSession,
    dependencies: readonly SemanticConnectorDependency[],
  ): void {
    if (!dependencies.length) return;
    const dependencyById = new Map(active.dependencyById);
    for (const dependency of dependencies) dependencyById.set(dependency.objectId, dependency);
    active.dependencyById = dependencyById;
    const connectorDependencies = Object.freeze([...dependencyById.values()]);
    active.snapshot = freezeSession({
      ...active.snapshot,
      connectorDependencies,
      affectedConnectorIds: Object.freeze(connectorDependencies.map(({ objectId }) => objectId)),
    });
  }

  private newSession(input: Readonly<{
    mode: SemanticConnectorSessionMode;
    phase: SemanticConnectorSessionPhase;
    baseline: RoomState;
    objectId: string;
    baseRevision: number | null;
    baseCreatedAt: number | null;
    editingTerminal: SemanticConnectorTerminal | null;
    draft: ConnectorDraft;
    route: ResolvedConnectorRoute;
    syntheticCreatedAt: number;
  }>): SemanticConnectorSession {
    const fence = ++this.nextFence;
    const sessionId = `semantic-connector:${input.mode}:${fence}:${input.objectId}`;
    const snapshot = freezeSession({
      token: freezeToken(sessionId, fence),
      gestureId: sessionId,
      mode: input.mode,
      phase: input.phase,
      roomId: input.baseline.id,
      baseRoomRevision: input.baseline.roomRevision,
      objectId: input.objectId,
      baseRevision: input.baseRevision,
      baseCreatedAt: input.baseCreatedAt,
      editingTerminal: input.editingTerminal,
      draft: input.draft,
      previewRoute: input.route,
      connectorDependencies: Object.freeze([]),
      affectedConnectorIds: Object.freeze([]),
      dirty: false,
    });
    this.active = {
      snapshot,
      baseline: input.baseline,
      dependencyById: new Map(),
      syntheticCreatedAt: input.syntheticCreatedAt,
    };
    return snapshot;
  }

  private assertIdle(): void {
    if (!this.active) return;
    throw new SemanticConnectorSessionError(
      "ACTIVE_SESSION",
      "Finish or abandon the active connector session before beginning another.",
    );
  }

  private matches(token: SemanticConnectorSessionToken): boolean {
    const current = this.active?.snapshot.token;
    return current?.fence === token.fence && current.sessionId === token.sessionId;
  }
}
