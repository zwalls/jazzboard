import type {
  CreateCanvasObject,
  LeaseOperation,
  ObjectLeaseAcquireTarget,
} from "@/lib/domain/types";

/** Renderer-neutral sources whose completion has a durable sync boundary. */
export type SemanticCanvasGestureSource = "pointer" | "text" | "keyboard";

export type SemanticCanvasGestureFinishReason =
  | "pointer-up"
  | "pointer-cancel"
  | "text-commit"
  | "text-blur"
  | "keyboard-idle";

/** Cancellation is intentionally distinct from a successful edit boundary. */
export type SemanticCanvasGestureCancelReason = "text-cancel";

/**
 * Authoritative identity known when a renderer starts protecting an object.
 * `baseRevision: null` represents an object that has not been created on the
 * server yet. No renderer record or renderer-specific ID crosses this seam.
 */
export type SemanticCanvasGestureObject = Readonly<{
  objectId: string;
  baseRevision: number | null;
  baseCreatedAt: number | null;
  /** Null for a new object, which does not need an object lease yet. */
  operation: LeaseOperation | null;
}>;

export type SemanticCanvasGestureStartedEvent = Readonly<{
  type: "gesture.started";
  gestureId: string;
  source: SemanticCanvasGestureSource;
  objects: readonly SemanticCanvasGestureObject[];
}>;

/**
 * Add implicit dependencies discovered after a gesture begins but before its
 * next optimistic pixels are installed. The host must dispatch this event
 * synchronously and in-order ahead of the paired `objects.changed` event.
 * Dependencies are protected and leased, but are not themselves persisted as
 * explicit edits; the authoritative semantic transaction may update them.
 */
export type SemanticCanvasGestureDependenciesAddedEvent = Readonly<{
  type: "gesture.dependencies-added";
  gestureId: string;
  objects: readonly SemanticCanvasGestureObject[];
}>;

export type SemanticCanvasObjectCreate = Readonly<{
  kind: "create";
  draft: CreateCanvasObject;
  baseRevision: null;
  baseCreatedAt: null;
}>;

export type SemanticCanvasObjectUpdate = Readonly<{
  kind: "update";
  draft: CreateCanvasObject;
  baseRevision: number;
  baseCreatedAt: number | null;
  operation: Exclude<LeaseOperation, "delete">;
}>;

/**
 * A delete deliberately carries no renderer snapshot. A null base revision is
 * valid when a locally-created object is removed before its create settles.
 */
export type SemanticCanvasObjectDelete = Readonly<{
  kind: "delete";
  objectId: string;
  baseRevision: number | null;
  baseCreatedAt: number | null;
  operation: "delete";
}>;

export type SemanticCanvasObjectChange =
  | SemanticCanvasObjectCreate
  | SemanticCanvasObjectUpdate
  | SemanticCanvasObjectDelete;

export type SemanticCanvasObjectsChangedEvent = Readonly<{
  type: "objects.changed";
  /** Null for edits such as paste/create that have no explicit gesture. */
  gestureId: string | null;
  changes: readonly SemanticCanvasObjectChange[];
  /** Optional semantic cohort key for a renderer transaction without a gesture. */
  cohortId?: string;
}>;

export type SemanticCanvasGestureFinishRequestedEvent = Readonly<{
  type: "gesture.finish-requested";
  gestureId: string;
  reason: SemanticCanvasGestureFinishReason;
}>;

/** Opaque lifecycle fence returned when a gesture requests its final flush. */
export type SemanticCanvasGestureFinalizationToken = Readonly<{
  gestureId: string;
  lifecycle: number;
}>;

/**
 * Renderers dispatch this only after their final document update has settled.
 * Final changes are optional because ordinary change events may already have
 * captured the final semantic snapshot.
 */
export type SemanticCanvasGestureSettledEvent = Readonly<{
  type: "gesture.settled";
  token: SemanticCanvasGestureFinalizationToken;
  finalChanges?: readonly SemanticCanvasObjectChange[];
}>;

export type SemanticCanvasGestureCancelRequestedEvent = Readonly<{
  type: "gesture.cancel-requested";
  gestureId: string;
  reason: SemanticCanvasGestureCancelReason;
}>;

export type SemanticCanvasGestureCancellationToken = Readonly<{
  gestureId: string;
  lifecycle: number;
}>;

export type SemanticCanvasAuthoritativeRecovery = Readonly<{
  objectId: string;
  revision: number | null;
  createdAt: number | null;
}>;

/**
 * The host dispatches this only after it has fenced pending work, refreshed
 * authority, force-projected the recovered objects, and released owned leases.
 */
export type SemanticCanvasGestureCancellationSettledEvent = Readonly<{
  type: "gesture.cancellation-settled";
  token: SemanticCanvasGestureCancellationToken;
  authoritative: readonly SemanticCanvasAuthoritativeRecovery[];
}>;

/**
 * Generic terminal recovery for a failed pointer, text, or keyboard gesture.
 * The persistence host dispatches this only after refresh, forced projection,
 * release of the matching lease cohort, and coordinator recovery completion.
 */
export type SemanticCanvasGestureRecoverySettledEvent = Readonly<{
  type: "gesture.recovery-settled";
  gestureId: string;
  authoritative: readonly SemanticCanvasAuthoritativeRecovery[];
}>;

export type SemanticCanvasEditEvent =
  | SemanticCanvasGestureStartedEvent
  | SemanticCanvasGestureDependenciesAddedEvent
  | SemanticCanvasObjectsChangedEvent
  | SemanticCanvasGestureFinishRequestedEvent
  | SemanticCanvasGestureSettledEvent
  | SemanticCanvasGestureCancelRequestedEvent
  | SemanticCanvasGestureCancellationSettledEvent
  | SemanticCanvasGestureRecoverySettledEvent;

type PendingSemanticCanvasEditBase = Readonly<{
  objectId: string;
  generation: number;
  recoveryEpoch: number;
  baseRevision: number | null;
  baseCreatedAt: number | null;
  gestureId: string | null;
}>;

/** Immutable semantic snapshot captured for a later coordinator-backed save. */
export type PendingSemanticCanvasEdit =
  | (PendingSemanticCanvasEditBase &
      Readonly<{
        kind: "create";
        draft: CreateCanvasObject;
        operation: null;
      }>)
  | (PendingSemanticCanvasEditBase &
      Readonly<{
        kind: "update";
        draft: CreateCanvasObject;
        operation: Exclude<LeaseOperation, "delete">;
      }>)
  | (PendingSemanticCanvasEditBase &
      Readonly<{
        kind: "delete";
        operation: "delete";
      }>);

/** Networking is deliberately left to the host that consumes this intent. */
export type SemanticCanvasLeaseAcquireIntent = Readonly<{
  type: "lease.acquire";
  gestureId: string | null;
  targets: readonly ObjectLeaseAcquireTarget[];
}>;

export type SemanticCanvasSyncScheduleIntent = Readonly<{
  type: "sync.schedule";
  batchKey: string;
  objectIds: readonly string[];
  edits: readonly PendingSemanticCanvasEdit[];
}>;

/**
 * The host should wait for one renderer-settle boundary, then dispatch the
 * matching `gesture.settled` event. Protection remains synchronous until then.
 */
export type SemanticCanvasGestureSettleIntent = Readonly<{
  type: "gesture.settle";
  timing: "after-render-settle";
  token: SemanticCanvasGestureFinalizationToken;
  source: SemanticCanvasGestureSource;
  reason: SemanticCanvasGestureFinishReason;
  objectIds: readonly string[];
}>;

export type SemanticCanvasSyncFlushIntent = Readonly<{
  type: "sync.flush";
  mode: "final";
  batchKey: string;
  gestureId: string;
  source: SemanticCanvasGestureSource;
  reason: SemanticCanvasGestureFinishReason;
  objectIds: readonly string[];
  edits: readonly PendingSemanticCanvasEdit[];
}>;

/**
 * Cancellation is a recovery boundary, never a disguised successful flush.
 * The host must cancel debounce timers, fence queued work, reconcile authority,
 * force-project the returned objects, and release leases before settling it.
 */
export type SemanticCanvasSyncCancelIntent = Readonly<{
  type: "sync.cancel";
  mode: "authoritative-recovery";
  token: SemanticCanvasGestureCancellationToken;
  gestureId: string;
  source: "text";
  reason: SemanticCanvasGestureCancelReason;
  objectIds: readonly string[];
  edits: readonly PendingSemanticCanvasEdit[];
}>;

export type SemanticCanvasEditIntent =
  | SemanticCanvasLeaseAcquireIntent
  | SemanticCanvasSyncScheduleIntent
  | SemanticCanvasGestureSettleIntent
  | SemanticCanvasSyncFlushIntent
  | SemanticCanvasSyncCancelIntent;
