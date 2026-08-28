import { createCanvasObjectSchema } from "@/lib/domain/schemas";
import type {
  CanvasObject,
  CreateCanvasObject,
  DiagramNodeType,
  DrawObject,
  NodeMetadataInput,
  Point,
  RoomState,
  ShapeObject,
  TextObject,
} from "@/lib/domain/types";

import type {
  SemanticCanvasEditEvent,
  SemanticCanvasGestureCancelRequestedEvent,
  SemanticCanvasGestureFinishReason,
  SemanticCanvasGestureFinishRequestedEvent,
  SemanticCanvasGestureStartedEvent,
  SemanticCanvasObjectsChangedEvent,
} from "./semantic-edit-events";

export const SEMANTIC_CREATE_LIMITS = Object.freeze({
  maxDrawPoints: 20_000,
  minDimension: 1,
  defaultDrawSampleDistance: 2,
  defaultShapeSize: Object.freeze({ width: 160, height: 100 }),
  defaultTextSize: Object.freeze({ width: 240, height: 64 }),
});

export type SemanticCreateSessionToken = Readonly<{
  sessionId: string;
  fence: number;
}>;

export type SemanticCreateTool = "shape" | "draw" | "text";
export type SemanticCreateSessionPhase = "prepared" | "creating" | "finished";

export type SemanticCreateSession = Readonly<{
  token: SemanticCreateSessionToken;
  gestureId: string;
  tool: SemanticCreateTool;
  objectId: string;
  phase: SemanticCreateSessionPhase;
  pointerStart: Readonly<Point>;
  pointerCurrent: Readonly<Point>;
  /** Complete renderer-neutral semantic draft in absolute canvas coordinates. */
  draft: CreateCanvasObject;
  dirty: boolean;
}>;

type SemanticCreateCommonInput = Readonly<{
  id: string;
  zIndex: number;
  groupId?: string | null;
  rotation?: number;
}>;

export type SemanticShapeCreateInput = SemanticCreateCommonInput &
  Readonly<{
    pointerStart: Point;
    shape: ShapeObject["shape"];
    /** Explicit semantic classification; null deliberately means generic artwork. */
    nodeType: DiagramNodeType | null;
    nodeMetadata?: NodeMetadataInput | null;
    label: string;
    fill: string;
    stroke: string;
    /** Used only when a click finishes without a drag. */
    defaultSize?: Readonly<{ width: number; height: number }>;
  }>;

export type SemanticDrawCreateInput = SemanticCreateCommonInput &
  Readonly<{
    pointerStart: Point;
    color: string;
    size: DrawObject["size"];
    /** Consecutive samples closer than this are coalesced. */
    minSampleDistance?: number;
    /** A local cap that may be lower, but never higher, than the domain maximum. */
    maxPoints?: number;
  }>;

export type SemanticTextCreateInput = SemanticCreateCommonInput &
  Readonly<{
    point: Point;
    content: string;
    color: string;
    size: TextObject["size"];
    align: TextObject["align"];
    defaultSize?: Readonly<{ width: number; height: number }>;
  }>;

export type SemanticCreatePrepared = Readonly<{
  status: "prepared";
  session: SemanticCreateSession;
  command: null;
  lifecycleEvents: readonly [];
}>;

export type SemanticCreatePublished = Readonly<{
  status: "published";
  session: SemanticCreateSession;
  command: null;
  /** Protection is always emitted before the first absolute create draft. */
  lifecycleEvents: readonly [
    SemanticCanvasGestureStartedEvent,
    SemanticCanvasObjectsChangedEvent,
  ];
}>;

export type SemanticProvisionalTextStarted = Readonly<{
  status: "started";
  session: SemanticCreateSession;
  command: null;
  /** Protects the unpublished semantic ID without scheduling persistence. */
  lifecycleEvents: readonly [SemanticCanvasGestureStartedEvent];
}>;

export type SemanticProvisionalTextUpdated = Readonly<{
  status: "updated";
  session: SemanticCreateSession;
  command: null;
  /** Provisional text is renderer-local until the single atomic commit. */
  lifecycleEvents: readonly [];
}>;

export type SemanticProvisionalTextCommitted = Readonly<{
  status: "committed";
  session: SemanticCreateSession;
  command: null;
  lifecycleEvents: readonly [
    SemanticCanvasObjectsChangedEvent,
    SemanticCanvasGestureFinishRequestedEvent,
  ];
}>;

export type SemanticProvisionalTextCancelled = Readonly<{
  status: "cancelled";
  token: SemanticCreateSessionToken;
  objectId: string;
  clearObjectIds: readonly [string];
  command: null;
  lifecycleEvents: readonly [SemanticCanvasGestureCancelRequestedEvent];
}>;

export type SemanticCreatePointerUpdated = Readonly<{
  status: "updated";
  session: SemanticCreateSession;
  command: null;
  /** Empty when this frame is an exact duplicate or was coalesced by draw sampling. */
  lifecycleEvents: readonly SemanticCanvasObjectsChangedEvent[];
}>;

export type SemanticCreateFinished = Readonly<{
  status: "finished";
  session: SemanticCreateSession;
  command: null;
  lifecycleEvents: readonly SemanticCanvasEditEvent[];
}>;

export type SemanticCreateAbandoned = Readonly<{
  status: "abandoned";
  token: SemanticCreateSessionToken;
  objectId: string;
  /** The host may discard its not-yet-painted prepared draft by semantic ID. */
  clearObjectIds: readonly [string];
  command: null;
  /** Abandon is legal only before publish, so it is intentionally not a fake finish. */
  lifecycleEvents: readonly [];
}>;

export type SemanticCreateStaleResult = Readonly<{
  status: "stale";
  token: SemanticCreateSessionToken;
}>;

export type SemanticDeleteSelectionReport = Readonly<{
  missingObjectIds: readonly string[];
  missingGroupIds: readonly string[];
  resolvedGroupIds: readonly string[];
}>;

export type SemanticDeleteSelectionNoop = Readonly<{
  status: "noop";
  targetObjectIds: readonly [];
  selectionReport: SemanticDeleteSelectionReport;
  command: null;
  lifecycleEvents: readonly [];
}>;

export type SemanticDeleteSelectionFinished = Readonly<{
  status: "finished";
  gestureId: string;
  targetObjectIds: readonly string[];
  selectionReport: SemanticDeleteSelectionReport;
  command: null;
  /** Start protection, tombstones, then the one-shot keyboard-idle boundary. */
  lifecycleEvents: readonly [
    SemanticCanvasGestureStartedEvent,
    SemanticCanvasObjectsChangedEvent,
    SemanticCanvasGestureFinishRequestedEvent,
  ];
}>;

export type SemanticDeleteSelectionResult =
  | SemanticDeleteSelectionNoop
  | SemanticDeleteSelectionFinished;

export class SemanticCreateSessionError extends Error {
  constructor(
    readonly code:
      | "ACTIVE_SESSION"
      | "INVALID_DRAFT"
      | "INVALID_PHASE"
      | "INVALID_POINTER"
      | "INVALID_SAMPLING"
      | "INVALID_TOOL",
    message: string,
  ) {
    super(message);
    this.name = "SemanticCreateSessionError";
  }
}

type InternalShapeSession = {
  kind: "shape";
  snapshot: SemanticCreateSession;
  defaultSize: Readonly<{ width: number; height: number }>;
  everMoved: boolean;
};

type InternalDrawSession = {
  kind: "draw";
  snapshot: SemanticCreateSession;
  absolutePoints: Point[];
  minSampleDistance: number;
  maxPoints: number;
};

type InternalTextSession = {
  kind: "text";
  snapshot: SemanticCreateSession;
  initialContent: string;
};

type InternalSession =
  | InternalShapeSession
  | InternalDrawSession
  | InternalTextSession;

const EMPTY_EVENTS = Object.freeze([]) as readonly [];

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function freezePoint(point: Point): Readonly<Point> {
  return Object.freeze({ x: point.x, y: point.y });
}

function assertFinitePoint(point: Point): void {
  if (Number.isFinite(point.x) && Number.isFinite(point.y)) return;
  throw new SemanticCreateSessionError(
    "INVALID_POINTER",
    "A semantic creation pointer must contain finite canvas-world coordinates.",
  );
}

function assertSize(
  size: Readonly<{ width: number; height: number }>,
  label: string,
): void {
  if (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0 &&
    size.width <= 100_000 &&
    size.height <= 100_000
  ) return;
  throw new SemanticCreateSessionError(
    "INVALID_DRAFT",
    `${label} width and height must be positive, finite, and at most 100000.`,
  );
}

function freezeDraft(draft: CreateCanvasObject): CreateCanvasObject {
  if (draft.kind === "draw") {
    const points = draft.points.map(freezePoint) as Point[];
    Object.freeze(points);
    return Object.freeze({ ...draft, points });
  }
  if (draft.kind === "shape" && draft.nodeMetadata) {
    return Object.freeze({
      ...draft,
      nodeMetadata: Object.freeze({ ...draft.nodeMetadata }),
    });
  }
  return Object.freeze({ ...draft });
}

function validateDraft(draft: CreateCanvasObject): CreateCanvasObject {
  const parsed = createCanvasObjectSchema.safeParse(draft);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.length ? `${first.path.join(".")}: ` : "";
    throw new SemanticCreateSessionError(
      "INVALID_DRAFT",
      `Invalid semantic canvas draft. ${path}${first?.message ?? "Unknown validation error."}`,
    );
  }
  return freezeDraft(parsed.data as CreateCanvasObject);
}

function freezeToken(sessionId: string, fence: number): SemanticCreateSessionToken {
  return Object.freeze({ sessionId, fence });
}

function freezeSession(
  session: Omit<SemanticCreateSession, "token"> & { token: SemanticCreateSessionToken },
): SemanticCreateSession {
  return Object.freeze({ ...session });
}

function minimumBoundsAt(point: Point): Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  return Object.freeze({
    x: point.x,
    y: point.y,
    width: SEMANTIC_CREATE_LIMITS.minDimension,
    height: SEMANTIC_CREATE_LIMITS.minDimension,
  });
}

function normalizedDragBounds(start: Point, current: Point): Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  return Object.freeze({
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.max(Math.abs(current.x - start.x), SEMANTIC_CREATE_LIMITS.minDimension),
    height: Math.max(Math.abs(current.y - start.y), SEMANTIC_CREATE_LIMITS.minDimension),
  });
}

function centeredBounds(
  center: Point,
  size: Readonly<{ width: number; height: number }>,
): Readonly<{ x: number; y: number; width: number; height: number }> {
  return Object.freeze({
    x: center.x - size.width / 2,
    y: center.y - size.height / 2,
    width: size.width,
    height: size.height,
  });
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function startedEvent(
  session: SemanticCreateSession,
  source: "pointer" | "text" = "pointer",
): SemanticCanvasGestureStartedEvent {
  return Object.freeze({
    type: "gesture.started",
    gestureId: session.gestureId,
    source,
    objects: Object.freeze([
      Object.freeze({
        objectId: session.objectId,
        baseRevision: null,
        baseCreatedAt: null,
        operation: null,
      }),
    ]),
  });
}

function changedEvent(session: SemanticCreateSession): SemanticCanvasObjectsChangedEvent {
  return Object.freeze({
    type: "objects.changed",
    gestureId: session.gestureId,
    changes: Object.freeze([
      Object.freeze({
        kind: "create",
        draft: session.draft,
        baseRevision: null,
        baseCreatedAt: null,
      }),
    ]),
  });
}

function finishEvent(
  session: SemanticCreateSession,
  reason: Extract<SemanticCanvasGestureFinishReason, "pointer-up" | "pointer-cancel" | "text-commit">,
): SemanticCanvasGestureFinishRequestedEvent {
  return Object.freeze({
    type: "gesture.finish-requested",
    gestureId: session.gestureId,
    reason,
  });
}

function drawDraft(
  base: Extract<CreateCanvasObject, { kind: "draw" }>,
  absolutePoints: readonly Point[],
): Extract<CreateCanvasObject, { kind: "draw" }> {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of absolutePoints) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return validateDraft({
    ...base,
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, SEMANTIC_CREATE_LIMITS.minDimension),
    height: Math.max(maxY - minY, SEMANTIC_CREATE_LIMITS.minDimension),
    points: absolutePoints.map((point) => ({ x: point.x - minX, y: point.y - minY })),
  }) as Extract<CreateCanvasObject, { kind: "draw" }>;
}

function sameDraftGeometry(left: CreateCanvasObject, right: CreateCanvasObject): boolean {
  if (
    left.kind !== right.kind ||
    left.x !== right.x ||
    left.y !== right.y ||
    left.width !== right.width ||
    left.height !== right.height
  ) return false;
  if (left.kind !== "draw" || right.kind !== "draw") return true;
  return left.points.length === right.points.length && left.points.every((point, index) => {
    const other = right.points[index];
    return other?.x === point.x && other.y === point.y;
  });
}

function reportForDelete(
  missingObjectIds: readonly string[],
  missingGroupIds: readonly string[],
  resolvedGroupIds: readonly string[],
): SemanticDeleteSelectionReport {
  return Object.freeze({
    missingObjectIds: Object.freeze([...missingObjectIds]),
    missingGroupIds: Object.freeze([...missingGroupIds]),
    resolvedGroupIds: Object.freeze([...resolvedGroupIds]),
  });
}

/**
 * Renderer-neutral synchronous state machine for first-party object creation.
 *
 * The engine owns no renderer records, DOM, timers, leases, persistence client,
 * or commands. A host prepares first, dispatches the publish events in their
 * returned order, and only then paints the absolute draft. That explicit split
 * gives callers a truthful pre-persistence abandon path.
 */
export class SemanticCreateSessionEngine {
  private nextFence = 0;
  private active: InternalSession | null = null;

  prepareShape(input: SemanticShapeCreateInput): SemanticCreatePrepared {
    this.assertIdle();
    assertFinitePoint(input.pointerStart);
    const defaultSize = Object.freeze({
      ...(input.defaultSize ?? SEMANTIC_CREATE_LIMITS.defaultShapeSize),
    });
    assertSize(defaultSize, "Default shape");
    const bounds = minimumBoundsAt(input.pointerStart);
    const draft = validateDraft({
      id: input.id,
      kind: "shape",
      ...bounds,
      rotation: input.rotation ?? 0,
      zIndex: input.zIndex,
      groupId: input.groupId ?? null,
      shape: input.shape,
      nodeType: input.nodeType,
      nodeMetadata: input.nodeMetadata,
      label: input.label,
      fill: input.fill,
      stroke: input.stroke,
    });
    return this.installPrepared("shape", input.pointerStart, draft, {
      defaultSize,
      everMoved: false,
    });
  }

  prepareDraw(input: SemanticDrawCreateInput): SemanticCreatePrepared {
    this.assertIdle();
    assertFinitePoint(input.pointerStart);
    const minSampleDistance = input.minSampleDistance
      ?? SEMANTIC_CREATE_LIMITS.defaultDrawSampleDistance;
    const maxPoints = input.maxPoints ?? SEMANTIC_CREATE_LIMITS.maxDrawPoints;
    if (!Number.isFinite(minSampleDistance) || minSampleDistance < 0) {
      throw new SemanticCreateSessionError(
        "INVALID_SAMPLING",
        "Draw sample distance must be a finite non-negative number.",
      );
    }
    if (
      !Number.isInteger(maxPoints) ||
      maxPoints < 2 ||
      maxPoints > SEMANTIC_CREATE_LIMITS.maxDrawPoints
    ) {
      throw new SemanticCreateSessionError(
        "INVALID_SAMPLING",
        `Draw point capacity must be an integer from 2 through ${SEMANTIC_CREATE_LIMITS.maxDrawPoints}.`,
      );
    }
    const absolutePoints = [
      { x: input.pointerStart.x, y: input.pointerStart.y },
      { x: input.pointerStart.x, y: input.pointerStart.y },
    ];
    const base = {
      id: input.id,
      kind: "draw" as const,
      x: input.pointerStart.x,
      y: input.pointerStart.y,
      width: SEMANTIC_CREATE_LIMITS.minDimension,
      height: SEMANTIC_CREATE_LIMITS.minDimension,
      rotation: input.rotation ?? 0,
      zIndex: input.zIndex,
      groupId: input.groupId ?? null,
      points: absolutePoints,
      color: input.color,
      size: input.size,
    };
    const draft = drawDraft(base, absolutePoints);
    return this.installPrepared("draw", input.pointerStart, draft, {
      absolutePoints,
      minSampleDistance,
      maxPoints,
    });
  }

  prepareText(input: SemanticTextCreateInput): SemanticCreatePrepared {
    this.assertIdle();
    assertFinitePoint(input.point);
    const defaultSize = Object.freeze({
      ...(input.defaultSize ?? SEMANTIC_CREATE_LIMITS.defaultTextSize),
    });
    assertSize(defaultSize, "Default text");
    const draft = validateDraft({
      id: input.id,
      kind: "text",
      ...centeredBounds(input.point, defaultSize),
      rotation: input.rotation ?? 0,
      zIndex: input.zIndex,
      groupId: input.groupId ?? null,
      content: input.content,
      color: input.color,
      size: input.size,
      align: input.align,
    });
    return this.installPrepared("text", input.point, draft, { initialContent: input.content });
  }

  current(): SemanticCreateSession | null {
    return this.active?.snapshot ?? null;
  }

  isCurrent(token: SemanticCreateSessionToken): boolean {
    return this.matches(token);
  }

  /**
   * Returns the synchronous protection + first-draft events. Dispatch both in
   * order before projecting the returned draft into visible local state.
   */
  publish(
    token: SemanticCreateSessionToken,
  ): SemanticCreatePublished | SemanticCreateStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    if (active.snapshot.phase !== "prepared") {
      throw new SemanticCreateSessionError(
        "INVALID_PHASE",
        "A semantic creation session can be published only once.",
      );
    }
    active.snapshot = freezeSession({ ...active.snapshot, phase: "creating" });
    return Object.freeze({
      status: "published",
      session: active.snapshot,
      command: null,
      lifecycleEvents: Object.freeze([
        startedEvent(active.snapshot),
        changedEvent(active.snapshot),
      ]) as SemanticCreatePublished["lifecycleEvents"],
    });
  }

  /**
   * Opens a local-first text create without publishing a placeholder draft.
   * The semantic ID is protected synchronously, but no sync is scheduled until
   * `commitProvisionalText` emits the one complete create operation.
   */
  startProvisionalText(
    token: SemanticCreateSessionToken,
  ): SemanticProvisionalTextStarted | SemanticCreateStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    if (active.kind !== "text") {
      throw new SemanticCreateSessionError(
        "INVALID_TOOL",
        "Only a text draft can start a provisional text session.",
      );
    }
    if (active.snapshot.phase !== "prepared") {
      throw new SemanticCreateSessionError(
        "INVALID_PHASE",
        "A provisional text session can be started only once.",
      );
    }
    active.snapshot = freezeSession({ ...active.snapshot, phase: "creating" });
    return Object.freeze({
      status: "started" as const,
      session: active.snapshot,
      command: null,
      lifecycleEvents: Object.freeze([
        startedEvent(active.snapshot, "text"),
      ]) as SemanticProvisionalTextStarted["lifecycleEvents"],
    });
  }

  updateProvisionalText(
    token: SemanticCreateSessionToken,
    content: string,
  ): SemanticProvisionalTextUpdated | SemanticCreateStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    if (active.kind !== "text") {
      throw new SemanticCreateSessionError(
        "INVALID_TOOL",
        "Only a text draft can update provisional text content.",
      );
    }
    if (active.snapshot.phase !== "creating") {
      throw new SemanticCreateSessionError(
        "INVALID_PHASE",
        "Start a provisional text session before updating its content.",
      );
    }
    if (active.snapshot.draft.kind !== "text") {
      throw new SemanticCreateSessionError("INVALID_TOOL", "The active draft is not text.");
    }
    const draft = validateDraft({ ...active.snapshot.draft, content });
    if (draft.kind !== "text") {
      throw new SemanticCreateSessionError("INVALID_TOOL", "The validated draft is not text.");
    }
    active.snapshot = freezeSession({
      ...active.snapshot,
      draft,
      dirty: draft.content !== active.initialContent,
    });
    return Object.freeze({
      status: "updated" as const,
      session: active.snapshot,
      command: null,
      lifecycleEvents: EMPTY_EVENTS,
    });
  }

  commitProvisionalText(
    token: SemanticCreateSessionToken,
  ): SemanticProvisionalTextCommitted | SemanticCreateStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    if (active.kind !== "text") {
      throw new SemanticCreateSessionError(
        "INVALID_TOOL",
        "Only a text draft can commit provisional text.",
      );
    }
    if (active.snapshot.phase !== "creating") {
      throw new SemanticCreateSessionError(
        "INVALID_PHASE",
        "Start a provisional text session before committing it.",
      );
    }
    active.snapshot = freezeSession({ ...active.snapshot, phase: "finished" });
    const result = Object.freeze({
      status: "committed" as const,
      session: active.snapshot,
      command: null,
      lifecycleEvents: Object.freeze([
        changedEvent(active.snapshot),
        finishEvent(active.snapshot, "text-commit"),
      ]) as SemanticProvisionalTextCommitted["lifecycleEvents"],
    });
    this.active = null;
    return result;
  }

  cancelProvisionalText(
    token: SemanticCreateSessionToken,
  ): SemanticProvisionalTextCancelled | SemanticCreateStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    if (active.kind !== "text") {
      throw new SemanticCreateSessionError(
        "INVALID_TOOL",
        "Only a text draft can cancel provisional text.",
      );
    }
    if (active.snapshot.phase !== "creating") {
      throw new SemanticCreateSessionError(
        "INVALID_PHASE",
        "Start a provisional text session before cancelling it.",
      );
    }
    const result = Object.freeze({
      status: "cancelled" as const,
      token: active.snapshot.token,
      objectId: active.snapshot.objectId,
      clearObjectIds: Object.freeze([active.snapshot.objectId]) as readonly [string],
      command: null,
      lifecycleEvents: Object.freeze([
        Object.freeze({
          type: "gesture.cancel-requested" as const,
          gestureId: active.snapshot.gestureId,
          reason: "text-cancel" as const,
        }),
      ]) as SemanticProvisionalTextCancelled["lifecycleEvents"],
    });
    this.active = null;
    return result;
  }

  updatePointer(
    token: SemanticCreateSessionToken,
    pointer: Point,
  ): SemanticCreatePointerUpdated | SemanticCreateStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    return this.updatePointerCurrent(pointer, false);
  }

  finish(
    token: SemanticCreateSessionToken,
    pointer?: Point,
    reason: Extract<SemanticCanvasGestureFinishReason, "pointer-up" | "pointer-cancel"> = "pointer-up",
  ): SemanticCreateFinished | SemanticCreateStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    if (active.snapshot.phase !== "creating") {
      throw new SemanticCreateSessionError(
        "INVALID_PHASE",
        "Publish a semantic creation before requesting its final flush.",
      );
    }
    const precedingEvents: SemanticCanvasEditEvent[] = [];
    if (pointer) {
      if (active.kind === "text") {
        throw new SemanticCreateSessionError(
          "INVALID_TOOL",
          "A click-created text object does not accept drag geometry.",
        );
      }
      const updated = this.updatePointerCurrent(pointer, true);
      precedingEvents.push(...updated.lifecycleEvents);
    } else if (active.kind === "draw") {
      // A coalesced final pointer is still semantically meaningful. Force the
      // last observed endpoint into the bounded sample set before final flush.
      const updated = this.updatePointerCurrent(active.snapshot.pointerCurrent, true);
      precedingEvents.push(...updated.lifecycleEvents);
    }

    if (active.kind === "shape" && !active.everMoved) {
      const bounds = centeredBounds(active.snapshot.pointerStart, active.defaultSize);
      const previous = active.snapshot.draft;
      const draft = validateDraft({ ...previous, ...bounds });
      if (!sameDraftGeometry(previous, draft)) {
        active.snapshot = freezeSession({ ...active.snapshot, draft, dirty: true });
        precedingEvents.push(changedEvent(active.snapshot));
      }
    }

    active.snapshot = freezeSession({ ...active.snapshot, phase: "finished" });
    const result = Object.freeze({
      status: "finished" as const,
      session: active.snapshot,
      command: null,
      lifecycleEvents: Object.freeze([
        ...precedingEvents,
        finishEvent(active.snapshot, reason),
      ]),
    });
    this.active = null;
    return result;
  }

  pointerCancel(
    token: SemanticCreateSessionToken,
    pointer?: Point,
  ): SemanticCreateFinished | SemanticCreateStaleResult {
    return this.finish(token, pointer, "pointer-cancel");
  }

  /**
   * Discards a prepared draft before any lifecycle event exists. Once publish
   * has returned, callers must finish or recover through the shared lifecycle.
   */
  abandon(
    token: SemanticCreateSessionToken,
  ): SemanticCreateAbandoned | SemanticCreateStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    if (active.snapshot.phase !== "prepared") {
      throw new SemanticCreateSessionError(
        "INVALID_PHASE",
        "A published create cannot be abandoned as though persistence never began.",
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

  /** One-shot, deterministic semantic group-aware deletion. */
  deleteSelection(input: Readonly<{
    room: RoomState;
    selectedObjectIds: readonly string[];
    selectedGroupIds?: readonly string[];
  }>): SemanticDeleteSelectionResult {
    const selectedObjectIds = sortedUnique(input.selectedObjectIds);
    const selectedObjectIdSet = new Set(selectedObjectIds);
    const selectedGroupIds = sortedUnique(input.selectedGroupIds ?? []);
    const roomGroups = new Set(
      Object.values(input.room.objects).flatMap((object) => object.groupId ? [object.groupId] : []),
    );
    const missingObjectIds = selectedObjectIds.filter((id) => !input.room.objects[id]);
    const missingGroupIds = selectedGroupIds.filter((id) => !roomGroups.has(id));
    const resolvedGroupIds = new Set(selectedGroupIds.filter((id) => roomGroups.has(id)));
    for (const objectId of selectedObjectIds) {
      const groupId = input.room.objects[objectId]?.groupId;
      if (groupId) resolvedGroupIds.add(groupId);
    }
    const targetObjectIds = sortedUnique(Object.values(input.room.objects).flatMap((object) => {
      if (selectedObjectIdSet.has(object.id)) return [object.id];
      if (object.groupId && resolvedGroupIds.has(object.groupId)) return [object.id];
      return [];
    }));
    const selectionReport = reportForDelete(
      missingObjectIds,
      missingGroupIds,
      sortedUnique(resolvedGroupIds),
    );
    if (!targetObjectIds.length) {
      return Object.freeze({
        status: "noop",
        targetObjectIds: EMPTY_EVENTS,
        selectionReport,
        command: null,
        lifecycleEvents: EMPTY_EVENTS,
      });
    }

    const fence = ++this.nextFence;
    const gestureId = `semantic-delete:${fence}`;
    const targets = targetObjectIds.map((objectId) => input.room.objects[objectId] as CanvasObject);
    const started: SemanticCanvasGestureStartedEvent = Object.freeze({
      type: "gesture.started",
      gestureId,
      source: "keyboard",
      objects: Object.freeze(targets.map((object) => Object.freeze({
        objectId: object.id,
        baseRevision: object.revision,
        baseCreatedAt: object.createdAt,
        operation: "delete" as const,
      }))),
    });
    const changed: SemanticCanvasObjectsChangedEvent = Object.freeze({
      type: "objects.changed",
      gestureId,
      changes: Object.freeze(targets.map((object) => Object.freeze({
        kind: "delete" as const,
        objectId: object.id,
        baseRevision: object.revision,
        baseCreatedAt: object.createdAt,
        operation: "delete" as const,
      }))),
    });
    const finished: SemanticCanvasGestureFinishRequestedEvent = Object.freeze({
      type: "gesture.finish-requested",
      gestureId,
      reason: "keyboard-idle",
    });
    return Object.freeze({
      status: "finished",
      gestureId,
      targetObjectIds: Object.freeze(targetObjectIds),
      selectionReport,
      command: null,
      lifecycleEvents: Object.freeze([
        started,
        changed,
        finished,
      ]) as SemanticDeleteSelectionFinished["lifecycleEvents"],
    });
  }

  private installPrepared(
    kind: InternalSession["kind"],
    pointerStartInput: Point,
    draft: CreateCanvasObject,
    details:
      | Pick<InternalShapeSession, "defaultSize" | "everMoved">
      | Pick<InternalDrawSession, "absolutePoints" | "minSampleDistance" | "maxPoints">
      | Pick<InternalTextSession, "initialContent">,
  ): SemanticCreatePrepared {
    const fence = ++this.nextFence;
    const sessionId = `semantic-create:${fence}:${draft.id}`;
    const pointerStart = freezePoint(pointerStartInput);
    const snapshot = freezeSession({
      token: freezeToken(sessionId, fence),
      gestureId: sessionId,
      tool: kind,
      objectId: draft.id,
      phase: "prepared",
      pointerStart,
      pointerCurrent: pointerStart,
      draft,
      dirty: false,
    });
    if (kind === "shape") {
      const shapeDetails = details as Pick<InternalShapeSession, "defaultSize" | "everMoved">;
      this.active = { kind, snapshot, ...shapeDetails };
    } else if (kind === "draw") {
      const drawDetails = details as Pick<InternalDrawSession, "absolutePoints" | "minSampleDistance" | "maxPoints">;
      this.active = { kind, snapshot, ...drawDetails };
    } else {
      const textDetails = details as Pick<InternalTextSession, "initialContent">;
      this.active = { kind, snapshot, ...textDetails };
    }
    return Object.freeze({
      status: "prepared",
      session: snapshot,
      command: null,
      lifecycleEvents: EMPTY_EVENTS,
    });
  }

  private updatePointerCurrent(
    pointer: Point,
    forceDrawEndpoint: boolean,
  ): SemanticCreatePointerUpdated {
    const active = this.active!;
    if (active.snapshot.phase !== "creating") {
      throw new SemanticCreateSessionError(
        "INVALID_PHASE",
        "Publish a semantic creation before updating its pointer geometry.",
      );
    }
    if (active.kind === "text") {
      throw new SemanticCreateSessionError(
        "INVALID_TOOL",
        "A click-created text object does not accept drag geometry.",
      );
    }
    assertFinitePoint(pointer);

    if (active.kind === "shape") {
      if (samePoint(pointer, active.snapshot.pointerCurrent)) {
        return Object.freeze({
          status: "updated",
          session: active.snapshot,
          command: null,
          lifecycleEvents: EMPTY_EVENTS,
        });
      }
      const bounds = normalizedDragBounds(active.snapshot.pointerStart, pointer);
      const draft = validateDraft({ ...active.snapshot.draft, ...bounds });
      active.everMoved ||= !samePoint(pointer, active.snapshot.pointerStart);
      active.snapshot = freezeSession({
        ...active.snapshot,
        pointerCurrent: freezePoint(pointer),
        draft,
        dirty: true,
      });
      return Object.freeze({
        status: "updated",
        session: active.snapshot,
        command: null,
        lifecycleEvents: Object.freeze([changedEvent(active.snapshot)]),
      });
    }

    const previousPointer = active.snapshot.pointerCurrent;
    const lastSample = active.absolutePoints[active.absolutePoints.length - 1]!;
    const distance = Math.hypot(pointer.x - lastSample.x, pointer.y - lastSample.y);
    const pointerChanged = !samePoint(pointer, previousPointer);
    const endpointChanged = !samePoint(pointer, lastSample);
    active.snapshot = freezeSession({
      ...active.snapshot,
      pointerCurrent: freezePoint(pointer),
    });
    if (
      !endpointChanged ||
      (!forceDrawEndpoint && distance < active.minSampleDistance)
    ) {
      return Object.freeze({
        status: "updated",
        session: active.snapshot,
        command: null,
        lifecycleEvents: EMPTY_EVENTS,
      });
    }

    const nextPoints = active.absolutePoints.map((point) => ({ ...point }));
    const initialDuplicate = nextPoints.length === 2 && samePoint(nextPoints[0]!, nextPoints[1]!);
    if (initialDuplicate) nextPoints[1] = { x: pointer.x, y: pointer.y };
    else if (nextPoints.length >= active.maxPoints) {
      nextPoints[nextPoints.length - 1] = { x: pointer.x, y: pointer.y };
    } else nextPoints.push({ x: pointer.x, y: pointer.y });

    const base = active.snapshot.draft as Extract<CreateCanvasObject, { kind: "draw" }>;
    const draft = drawDraft(base, nextPoints);
    active.absolutePoints = nextPoints;
    active.snapshot = freezeSession({
      ...active.snapshot,
      pointerCurrent: freezePoint(pointer),
      draft,
      dirty: active.snapshot.dirty || pointerChanged || endpointChanged,
    });
    return Object.freeze({
      status: "updated",
      session: active.snapshot,
      command: null,
      lifecycleEvents: Object.freeze([changedEvent(active.snapshot)]),
    });
  }

  private assertIdle(): void {
    if (!this.active) return;
    throw new SemanticCreateSessionError(
      "ACTIVE_SESSION",
      "Finish or abandon the active semantic creation before preparing another.",
    );
  }

  private matches(token: SemanticCreateSessionToken): boolean {
    const current = this.active?.snapshot.token;
    return current?.fence === token.fence && current.sessionId === token.sessionId;
  }
}
