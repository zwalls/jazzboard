import { CanvasObjectSyncCoordinator } from "@/lib/canvas/sync-coordinator";
import type { ObjectLeaseAcquireTarget } from "@/lib/domain/types";

import type {
  PendingSemanticCanvasEdit,
  SemanticCanvasEditEvent,
  SemanticCanvasEditIntent,
  SemanticCanvasGestureFinishReason,
  SemanticCanvasGestureCancelReason,
  SemanticCanvasGestureDependenciesAddedEvent,
  SemanticCanvasGestureCancellationSettledEvent,
  SemanticCanvasGestureRecoverySettledEvent,
  SemanticCanvasGestureObject,
  SemanticCanvasGestureSettleIntent,
  SemanticCanvasGestureSource,
  SemanticCanvasGestureStartedEvent,
  SemanticCanvasGestureSettledEvent,
  SemanticCanvasObjectChange,
  SemanticCanvasObjectsChangedEvent,
  SemanticCanvasSyncFlushIntent,
  SemanticCanvasSyncCancelIntent,
} from "./semantic-edit-events";

type ProtectedGesture = {
  gestureId: string;
  lifecycle: number;
  source: SemanticCanvasGestureSource;
  batchKey: string;
  objectIds: Set<string>;
  leaseTargets: Map<string, ObjectLeaseAcquireTarget>;
  finishReason: SemanticCanvasGestureFinishReason | null;
  cancelReason: SemanticCanvasGestureCancelReason | null;
};

type GestureOwner = {
  gestureId: string;
  lifecycle: number;
};

function sortedUnique(objectIds: Iterable<string>): string[] {
  return [...new Set(objectIds)].sort((left, right) => left.localeCompare(right));
}

function objectIdForChange(change: SemanticCanvasObjectChange): string {
  return change.kind === "delete" ? change.objectId : change.draft.id;
}

function gestureObjectForChange(change: SemanticCanvasObjectChange): SemanticCanvasGestureObject {
  return {
    objectId: objectIdForChange(change),
    baseRevision: change.baseRevision,
    baseCreatedAt: change.baseCreatedAt,
    operation: change.kind === "create" ? null : change.operation,
  };
}

function reasonMatchesSource(
  source: SemanticCanvasGestureSource,
  reason: SemanticCanvasGestureFinishReason,
): boolean {
  if (source === "pointer") return reason === "pointer-up" || reason === "pointer-cancel";
  if (source === "text") return reason === "text-commit" || reason === "text-blur";
  return reason === "keyboard-idle";
}

/**
 * Owns only local edit lifecycle state. It synchronously protects semantic IDs
 * through CanvasObjectSyncCoordinator and returns declarative intents for the
 * host to schedule, flush, or turn into lease requests. It has no timers,
 * renderer handles, persistence clients, or network callbacks.
 */
export class SemanticCanvasEditLifecycleController {
  private lifecycleSequence = 0;
  private readonly gestures = new Map<string, ProtectedGesture>();
  private readonly ownerByObjectId = new Map<string, GestureOwner>();
  private readonly latestLifecycleByObjectId = new Map<string, number>();
  private readonly pendingEdits = new Map<string, PendingSemanticCanvasEdit>();

  constructor(private readonly coordinator: CanvasObjectSyncCoordinator) {}

  dispatch(event: SemanticCanvasEditEvent): readonly SemanticCanvasEditIntent[] {
    switch (event.type) {
      case "gesture.started":
        return this.startGesture(event);
      case "gesture.dependencies-added":
        return this.addGestureDependencies(event);
      case "objects.changed":
        return this.recordChanges(event);
      case "gesture.finish-requested":
        return this.requestGestureFinish(event.gestureId, event.reason);
      case "gesture.settled":
        return this.settleGesture(event);
      case "gesture.cancel-requested":
        return this.requestGestureCancel(event.gestureId, event.reason);
      case "gesture.cancellation-settled":
        return this.settleGestureCancellation(event);
      case "gesture.recovery-settled":
        return this.settleGestureRecovery(event);
    }
  }

  getPendingEdit(objectId: string): PendingSemanticCanvasEdit | undefined {
    return this.pendingEdits.get(objectId);
  }

  /** Prevents an older acknowledgement from discarding a newer generation. */
  clearPendingEdit(objectId: string, generation: number): boolean {
    const pending = this.pendingEdits.get(objectId);
    if (!pending || pending.generation !== generation) return false;
    this.pendingEdits.delete(objectId);
    return true;
  }

  private startGesture(
    event: SemanticCanvasGestureStartedEvent,
  ): readonly SemanticCanvasEditIntent[] {
    if (this.gestures.has(event.gestureId)) {
      throw new Error(`Canvas gesture ${event.gestureId} is already active.`);
    }

    const lifecycle = ++this.lifecycleSequence;
    const gesture: ProtectedGesture = {
      gestureId: event.gestureId,
      lifecycle,
      source: event.source,
      batchKey: `gesture:${lifecycle}`,
      objectIds: new Set(),
      leaseTargets: new Map(),
      finishReason: null,
      cancelReason: null,
    };
    this.gestures.set(event.gestureId, gesture);

    const targets = new Map(event.objects.map((object) => [object.objectId, object]));
    const leases: ObjectLeaseAcquireTarget[] = [];
    for (const object of targets.values()) {
      if (!this.protectObject(gesture, object)) continue;
      const lease = this.rememberLeaseTarget(gesture, object);
      if (lease) leases.push(lease);
    }

    return leases.length
      ? [{ type: "lease.acquire", gestureId: event.gestureId, targets: leases }]
      : [];
  }

  private protectObject(
    gesture: ProtectedGesture,
    object: SemanticCanvasGestureObject,
  ): boolean {
    const currentOwner = this.ownerByObjectId.get(object.objectId);
    if ((this.latestLifecycleByObjectId.get(object.objectId) ?? 0) > gesture.lifecycle) return false;
    if (this.coordinator.get(object.objectId)?.awaitingRecovery) return false;

    if (
      !currentOwner ||
      currentOwner.gestureId !== gesture.gestureId ||
      currentOwner.lifecycle !== gesture.lifecycle
    ) {
      this.coordinator.beginInteraction(
        object.objectId,
        object.baseRevision,
        object.baseCreatedAt,
      );
      this.ownerByObjectId.set(object.objectId, {
        gestureId: gesture.gestureId,
        lifecycle: gesture.lifecycle,
      });
      this.latestLifecycleByObjectId.set(object.objectId, gesture.lifecycle);
    }
    gesture.objectIds.add(object.objectId);
    return true;
  }

  private addGestureDependencies(
    event: SemanticCanvasGestureDependenciesAddedEvent,
  ): readonly SemanticCanvasEditIntent[] {
    const gesture = this.gestures.get(event.gestureId);
    if (!gesture) throw new Error(`Canvas gesture ${event.gestureId} is not active.`);
    if (gesture.finishReason !== null || gesture.cancelReason !== null) return [];

    const targets = new Map(event.objects.map((object) => [object.objectId, object]));
    const leases: ObjectLeaseAcquireTarget[] = [];
    for (const object of targets.values()) {
      if (!this.protectObject(gesture, object)) continue;
      const lease = this.rememberLeaseTarget(gesture, object);
      if (lease) leases.push(lease);
    }
    return leases.length
      ? [{ type: "lease.acquire", gestureId: event.gestureId, targets: leases }]
      : [];
  }

  private rememberLeaseTarget(
    gesture: ProtectedGesture,
    object: SemanticCanvasGestureObject,
  ): ObjectLeaseAcquireTarget | null {
    if (object.baseRevision === null || object.operation === null) return null;
    const target: ObjectLeaseAcquireTarget = {
      objectId: object.objectId,
      expectedRevision: object.baseRevision,
      operation: object.operation,
    };
    const previous = gesture.leaseTargets.get(object.objectId);
    if (
      previous?.expectedRevision === target.expectedRevision &&
      previous.operation === target.operation
    ) {
      return null;
    }
    gesture.leaseTargets.set(object.objectId, target);
    return target;
  }

  private recordChanges(
    event: SemanticCanvasObjectsChangedEvent,
    emitSchedule = true,
  ): readonly SemanticCanvasEditIntent[] {
    const gesture = event.gestureId === null ? null : this.gestures.get(event.gestureId);
    if (event.gestureId !== null && !gesture) {
      throw new Error(`Canvas gesture ${event.gestureId} is not active.`);
    }

    const changedObjectIds = new Set<string>();
    const leases: ObjectLeaseAcquireTarget[] = [];
    for (const change of event.changes) {
      const gestureObject = gestureObjectForChange(change);
      if (this.coordinator.get(gestureObject.objectId)?.awaitingRecovery) continue;
      if (gesture && !this.protectObject(gesture, gestureObject)) continue;

      const marked = this.coordinator.markDirty({
        objectId: gestureObject.objectId,
        shapeId: null,
        baseRevision: gestureObject.baseRevision,
        baseCreatedAt: gestureObject.baseCreatedAt,
        deleted: change.kind === "delete",
      });
      const common = {
        objectId: gestureObject.objectId,
        generation: marked.generation,
        recoveryEpoch: marked.entry.recoveryEpoch,
        baseRevision: marked.entry.baseRevision,
        baseCreatedAt: marked.entry.baseCreatedAt,
        gestureId: gesture?.gestureId ?? null,
      };
      const pending: PendingSemanticCanvasEdit =
        change.kind === "create"
          ? { ...common, kind: "create", draft: change.draft, operation: null }
          : change.kind === "update"
            ? {
                ...common,
                kind: "update",
                draft: change.draft,
                operation: change.operation,
              }
            : { ...common, kind: "delete", operation: "delete" };
      this.pendingEdits.set(gestureObject.objectId, pending);
      changedObjectIds.add(gestureObject.objectId);

      if (gesture) {
        const lease = this.rememberLeaseTarget(gesture, gestureObject);
        if (lease) leases.push(lease);
      } else if (gestureObject.baseRevision !== null && gestureObject.operation !== null) {
        leases.push({
          objectId: gestureObject.objectId,
          expectedRevision: gestureObject.baseRevision,
          operation: gestureObject.operation,
        });
      }
    }

    const intents: SemanticCanvasEditIntent[] = [];
    if (leases.length) {
      intents.push({ type: "lease.acquire", gestureId: gesture?.gestureId ?? null, targets: leases });
    }
    if (!emitSchedule || !changedObjectIds.size) return intents;

    const objectIds = gesture
      ? sortedUnique(gesture.objectIds)
      : sortedUnique(changedObjectIds);
    intents.push({
      type: "sync.schedule",
      batchKey: gesture?.batchKey ?? event.cohortId ?? `objects:${objectIds.join("|")}`,
      objectIds,
      edits: this.pendingEditsFor(objectIds),
    });
    return intents;
  }

  private requestGestureFinish(
    gestureId: string,
    reason: SemanticCanvasGestureFinishReason,
  ): readonly SemanticCanvasEditIntent[] {
    const gesture = this.gestures.get(gestureId);
    if (!gesture) return [];
    if (gesture.cancelReason !== null) return [];
    if (!reasonMatchesSource(gesture.source, reason)) {
      throw new Error(`Canvas ${gesture.source} gesture cannot finish with ${reason}.`);
    }
    gesture.finishReason ??= reason;
    return [this.settleIntentFor(gesture)];
  }

  private requestGestureCancel(
    gestureId: string,
    reason: SemanticCanvasGestureCancelReason,
  ): readonly SemanticCanvasEditIntent[] {
    const gesture = this.gestures.get(gestureId);
    if (!gesture) return [];
    if (gesture.source !== "text" || reason !== "text-cancel") {
      throw new Error(`Canvas ${gesture.source} gesture cannot cancel with ${reason}.`);
    }
    if (gesture.finishReason !== null) return [];
    if (gesture.cancelReason !== null) return [];

    gesture.cancelReason = reason;
    const objectIds = sortedUnique(
      [...gesture.objectIds].filter((objectId) => {
        const owner = this.ownerByObjectId.get(objectId);
        return owner?.gestureId === gesture.gestureId && owner.lifecycle === gesture.lifecycle;
      }),
    );
    for (const objectId of objectIds) this.coordinator.beginRecovery(objectId);

    const intent: SemanticCanvasSyncCancelIntent = {
      type: "sync.cancel",
      mode: "authoritative-recovery",
      token: { gestureId: gesture.gestureId, lifecycle: gesture.lifecycle },
      gestureId: gesture.gestureId,
      source: "text",
      reason,
      objectIds,
      edits: this.pendingEditsFor(objectIds),
    };
    return [intent];
  }

  private settleGestureCancellation(
    event: SemanticCanvasGestureCancellationSettledEvent,
  ): readonly SemanticCanvasEditIntent[] {
    const gesture = this.gestures.get(event.token.gestureId);
    if (
      !gesture ||
      gesture.lifecycle !== event.token.lifecycle ||
      gesture.cancelReason === null
    ) {
      return [];
    }

    const authoritativeById = new Map(
      event.authoritative.map((object) => [object.objectId, object]),
    );
    const ownedObjectIds = sortedUnique(
      [...gesture.objectIds].filter((objectId) => {
        const owner = this.ownerByObjectId.get(objectId);
        return owner?.gestureId === gesture.gestureId && owner.lifecycle === gesture.lifecycle;
      }),
    );
    if (ownedObjectIds.some((objectId) => !authoritativeById.has(objectId))) return [];

    for (const objectId of ownedObjectIds) {
      const authoritative = authoritativeById.get(objectId)!;
      this.coordinator.completeRecovery(
        objectId,
        authoritative.revision,
        authoritative.createdAt,
      );
      const pending = this.pendingEdits.get(objectId);
      if (pending?.gestureId === gesture.gestureId) this.pendingEdits.delete(objectId);
      this.ownerByObjectId.delete(objectId);
    }
    this.gestures.delete(gesture.gestureId);
    return [];
  }

  private settleGestureRecovery(
    event: SemanticCanvasGestureRecoverySettledEvent,
  ): readonly SemanticCanvasEditIntent[] {
    const gesture = this.gestures.get(event.gestureId);
    if (!gesture) return [];

    const authoritativeById = new Map(
      event.authoritative.map((object) => [object.objectId, object]),
    );
    const ownedObjectIds = sortedUnique(
      [...gesture.objectIds].filter((objectId) => {
        const owner = this.ownerByObjectId.get(objectId);
        return owner?.gestureId === gesture.gestureId && owner.lifecycle === gesture.lifecycle;
      }),
    );
    if (ownedObjectIds.some((objectId) => !authoritativeById.has(objectId))) return [];

    // Persistence must install the recovered identity before lifecycle cleanup;
    // this also fences an accidentally early or mismatched host callback.
    const authorityInstalled = ownedObjectIds.every((objectId) => {
      const authoritative = authoritativeById.get(objectId)!;
      const entry = this.coordinator.get(objectId);
      return Boolean(
        !entry ||
          (!entry.awaitingRecovery &&
            !entry.interactionActive &&
            !entry.dirty &&
            entry.baseRevision === authoritative.revision &&
            entry.baseCreatedAt === authoritative.createdAt),
      );
    });
    if (!authorityInstalled) return [];

    for (const objectId of ownedObjectIds) {
      const pending = this.pendingEdits.get(objectId);
      if (pending?.gestureId === gesture.gestureId) this.pendingEdits.delete(objectId);
      this.ownerByObjectId.delete(objectId);
    }
    this.gestures.delete(gesture.gestureId);
    return [];
  }

  private settleIntentFor(gesture: ProtectedGesture): SemanticCanvasGestureSettleIntent {
    return {
      type: "gesture.settle",
      timing: "after-render-settle",
      token: { gestureId: gesture.gestureId, lifecycle: gesture.lifecycle },
      source: gesture.source,
      reason: gesture.finishReason!,
      objectIds: sortedUnique(gesture.objectIds),
    };
  }

  private settleGesture(
    event: SemanticCanvasGestureSettledEvent,
  ): readonly SemanticCanvasEditIntent[] {
    const gesture = this.gestures.get(event.token.gestureId);
    if (
      !gesture ||
      gesture.lifecycle !== event.token.lifecycle ||
      gesture.finishReason === null
    ) {
      return [];
    }

    const finalChanges = (event.finalChanges ?? []).filter((change) => {
      const latestLifecycle = this.latestLifecycleByObjectId.get(objectIdForChange(change)) ?? 0;
      return latestLifecycle <= gesture.lifecycle;
    });
    const intents = this.recordChanges(
      {
        type: "objects.changed",
        gestureId: gesture.gestureId,
        changes: finalChanges,
      },
      false,
    );

    // Final renderer settlement may introduce a new semantic object (for
    // example, the completed draw shape). Recompute ownership after recording
    // those changes while still excluding members claimed by a newer gesture.
    const ownedObjectIds = new Set(
      [...gesture.objectIds].filter((objectId) => {
        const owner = this.ownerByObjectId.get(objectId);
        return owner?.gestureId === gesture.gestureId && owner.lifecycle === gesture.lifecycle;
      }),
    );
    const objectIds = sortedUnique(ownedObjectIds);
    for (const objectId of objectIds) {
      this.coordinator.endInteraction(objectId);
      this.ownerByObjectId.delete(objectId);
    }
    this.gestures.delete(gesture.gestureId);

    // A newer gesture may own every object by the time this render-settlement
    // callback runs. The retired gesture still owns a lease cohort, however,
    // and persistence needs a final (possibly empty) flush to retire it. An
    // early return here leaked the pointer-down `move` cohort indefinitely and
    // could prevent the newer text gesture from upgrading authority to `edit`.
    const flush: SemanticCanvasSyncFlushIntent = {
      type: "sync.flush",
      mode: "final",
      batchKey: gesture.batchKey,
      gestureId: gesture.gestureId,
      source: gesture.source,
      reason: gesture.finishReason,
      objectIds,
      edits: this.pendingEditsFor(objectIds),
    };
    return [...intents, flush];
  }

  private pendingEditsFor(objectIds: Iterable<string>): PendingSemanticCanvasEdit[] {
    return sortedUnique(objectIds).flatMap((objectId) => {
      const edit = this.pendingEdits.get(objectId);
      return edit ? [edit] : [];
    });
  }
}
