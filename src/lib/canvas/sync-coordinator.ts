import type { LeaseOperation, ObjectLease } from "@/lib/domain/types";

export type ManagedObjectLease = {
  lease: ObjectLease;
  renewTimer: number | null;
};

export type CanvasObjectSyncEntry = {
  objectId: string;
  shapeId: string | null;
  generation: number;
  acknowledgedGeneration: number;
  queuedGeneration: number;
  baseRevision: number | null;
  /**
   * The authoritative object's creation timestamp is its incarnation key.
   * Reusing an object ID after deletion must not make revisions from the old
   * incarnation comparable with revisions from the new one.
   */
  baseCreatedAt: number | null;
  interactionActive: boolean;
  dirty: boolean;
  deleted: boolean;
  awaitingRecovery: boolean;
  /**
   * Advances whenever authoritative recovery invalidates queued local work.
   * Unlike `generation`, this does not advance for ordinary newer edits, so a
   * serialized save may safely advance its base revision without making the
   * next queued draft look stale.
   */
  recoveryEpoch: number;
  timer: number | null;
  recoveryTimer: number | null;
  queueTail: Promise<void>;
  queuedTasks: number;
  lease: ManagedObjectLease | null;
  desiredLeaseOperation: LeaseOperation | null;
  leaseIntentEpoch: number;
  leaseRequest: Promise<ObjectLease | null> | null;
  releaseRequest: Promise<void> | null;
};

export type DirtyObjectInput = {
  objectId: string;
  shapeId: string | null;
  baseRevision: number | null;
  /** Omit only when the caller has no authoritative incarnation metadata. */
  baseCreatedAt?: number | null;
  deleted?: boolean;
};

export type ObjectSyncAcknowledgement = {
  /** The incarnation against which the command was prepared. */
  expectedCreatedAt: number | null;
  /** The incarnation returned by the authoritative command response. */
  authoritativeCreatedAt: number | null;
};

/**
 * Tracks the client-only lifecycle of optimistic canvas objects. Authoritative
 * room state remains outside this class; its protected IDs tell projection
 * which local records must not be replaced until their latest generation is
 * acknowledged or deliberately recovered.
 */
export class CanvasObjectSyncCoordinator {
  private readonly entries = new Map<string, CanvasObjectSyncEntry>();

  get(objectId: string): CanvasObjectSyncEntry | undefined {
    return this.entries.get(objectId);
  }

  getOrCreate(
    objectId: string,
    baseRevision: number | null = null,
    baseCreatedAt?: number | null,
  ): CanvasObjectSyncEntry {
    const existing = this.entries.get(objectId);
    if (existing) {
      const isLocallySettled =
        !existing.interactionActive &&
        !existing.dirty &&
        !existing.awaitingRecovery &&
        existing.timer === null &&
        existing.queuedTasks === 0;
      if (isLocallySettled) {
        if (baseCreatedAt !== undefined && baseCreatedAt !== existing.baseCreatedAt) {
          // A new incarnation starts its own revision sequence, commonly back
          // at revision 1, so replacing (rather than maxing) is intentional.
          existing.baseCreatedAt = baseCreatedAt;
          existing.baseRevision = baseRevision;
        } else if (
          baseRevision !== null &&
          (existing.baseRevision === null || baseRevision > existing.baseRevision)
        ) {
          existing.baseRevision = baseRevision;
        }
      }
      return existing;
    }
    const entry: CanvasObjectSyncEntry = {
      objectId,
      shapeId: null,
      generation: 0,
      acknowledgedGeneration: 0,
      queuedGeneration: 0,
      baseRevision,
      baseCreatedAt: baseCreatedAt ?? null,
      interactionActive: false,
      dirty: false,
      deleted: false,
      awaitingRecovery: false,
      recoveryEpoch: 0,
      timer: null,
      recoveryTimer: null,
      queueTail: Promise.resolve(),
      queuedTasks: 0,
      lease: null,
      desiredLeaseOperation: null,
      leaseIntentEpoch: 0,
      leaseRequest: null,
      releaseRequest: null,
    };
    this.entries.set(objectId, entry);
    return entry;
  }

  beginInteraction(
    objectId: string,
    baseRevision: number | null,
    baseCreatedAt?: number | null,
  ): CanvasObjectSyncEntry {
    const entry = this.getOrCreate(objectId, baseRevision, baseCreatedAt);
    entry.interactionActive = true;
    return entry;
  }

  endInteraction(objectId: string): CanvasObjectSyncEntry | undefined {
    const entry = this.entries.get(objectId);
    if (entry) entry.interactionActive = false;
    return entry;
  }

  desireLease(
    objectId: string,
    operation: LeaseOperation,
  ): { entry: CanvasObjectSyncEntry; epoch: number } {
    const entry = this.getOrCreate(objectId);
    if (entry.desiredLeaseOperation !== operation) {
      entry.desiredLeaseOperation = operation;
      entry.leaseIntentEpoch += 1;
    }
    return { entry, epoch: entry.leaseIntentEpoch };
  }

  cancelLeaseIntent(objectId: string): CanvasObjectSyncEntry | undefined {
    const entry = this.entries.get(objectId);
    if (!entry) return undefined;
    entry.desiredLeaseOperation = null;
    entry.leaseIntentEpoch += 1;
    return entry;
  }

  hasLeaseIntent(
    entry: CanvasObjectSyncEntry,
    epoch: number,
    operation: LeaseOperation,
  ): boolean {
    return (
      !entry.awaitingRecovery &&
      entry.leaseIntentEpoch === epoch &&
      entry.desiredLeaseOperation === operation
    );
  }

  markDirty(input: DirtyObjectInput): {
    entry: CanvasObjectSyncEntry;
    generation: number;
    incarnation: number | null;
  } {
    const entry = this.getOrCreate(input.objectId, input.baseRevision, input.baseCreatedAt);
    entry.shapeId = input.shapeId;
    entry.generation += 1;
    entry.dirty = true;
    entry.deleted = input.deleted ?? false;
    return { entry, generation: entry.generation, incarnation: entry.baseCreatedAt };
  }

  acknowledge(
    objectId: string,
    generation: number,
    revision: number | null,
    acknowledgement?: ObjectSyncAcknowledgement,
  ): boolean {
    const entry = this.entries.get(objectId);
    if (!entry || entry.awaitingRecovery) return false;
    if (
      acknowledgement &&
      acknowledgement.expectedCreatedAt !== entry.baseCreatedAt
    ) {
      // The response belongs to an incarnation that has since been replaced.
      // It must not advance the base revision or settle an equal-numbered local
      // generation belonging to the replacement object.
      return false;
    }
    if (
      acknowledgement &&
      ((revision === null && acknowledgement.authoritativeCreatedAt !== null) ||
        (revision !== null && acknowledgement.authoritativeCreatedAt === null) ||
        (revision !== null &&
          entry.baseCreatedAt !== null &&
          acknowledgement.authoritativeCreatedAt !== entry.baseCreatedAt))
    ) {
      return false;
    }
    entry.acknowledgedGeneration = Math.max(entry.acknowledgedGeneration, generation);
    if (revision === null) {
      entry.baseRevision = null;
      if (acknowledgement) entry.baseCreatedAt = acknowledgement.authoritativeCreatedAt;
    } else if (
      acknowledgement &&
      acknowledgement.authoritativeCreatedAt !== entry.baseCreatedAt
    ) {
      // A create begins with no authoritative incarnation and receives one in
      // its acknowledgement. The validation above prevents an update from
      // silently changing incarnation.
      entry.baseCreatedAt = acknowledgement.authoritativeCreatedAt;
      entry.baseRevision = revision;
    } else {
      entry.baseRevision = Math.max(entry.baseRevision ?? 0, revision);
    }
    if (generation !== entry.generation) return false;
    entry.dirty = false;
    entry.deleted = false;
    return true;
  }

  beginRecovery(objectId: string): CanvasObjectSyncEntry | null {
    const entry = this.getOrCreate(objectId);
    if (entry.awaitingRecovery) return null;
    entry.awaitingRecovery = true;
    entry.recoveryEpoch += 1;
    entry.interactionActive = false;
    entry.generation += 1;
    entry.dirty = true;
    return entry;
  }

  completeRecovery(
    objectId: string,
    revision: number | null,
    createdAt?: number | null,
  ): CanvasObjectSyncEntry | undefined {
    const entry = this.entries.get(objectId);
    if (!entry) return undefined;
    entry.awaitingRecovery = false;
    entry.dirty = false;
    entry.deleted = false;
    entry.baseRevision = revision;
    if (createdAt !== undefined || revision === null) entry.baseCreatedAt = createdAt ?? null;
    entry.acknowledgedGeneration = entry.generation;
    return entry;
  }

  enqueue(
    objectId: string,
    task: () => Promise<void>,
    onSettled?: (entry: CanvasObjectSyncEntry) => void,
  ): Promise<void> {
    const entry = this.getOrCreate(objectId);
    entry.queuedTasks += 1;
    const next = entry.queueTail.catch(() => undefined).then(task);
    entry.queueTail = next.catch(() => undefined);
    void next.then(
      () => {
        entry.queuedTasks -= 1;
        onSettled?.(entry);
      },
      () => {
        entry.queuedTasks -= 1;
        onSettled?.(entry);
      },
    );
    return next;
  }

  /**
   * Serializes one atomic task behind every involved object's current tail and
   * publishes a shared successor tail back to all of them. Object IDs are
   * deduplicated so queue accounting and settlement callbacks happen exactly
   * once per entry.
   */
  enqueueBatch(
    objectIds: Iterable<string>,
    task: () => Promise<void>,
    onSettled?: (entry: CanvasObjectSyncEntry) => void,
  ): Promise<void> {
    const entries = [...new Set(objectIds)].map((objectId) => this.getOrCreate(objectId));
    entries.forEach((entry) => {
      entry.queuedTasks += 1;
    });

    const priorTails = entries.map((entry) => entry.queueTail.catch(() => undefined));
    const next = Promise.all(priorTails).then(task);
    const sharedTail = next.catch(() => undefined);
    entries.forEach((entry) => {
      entry.queueTail = sharedTail;
    });

    const settle = () => {
      entries.forEach((entry) => {
        entry.queuedTasks -= 1;
        onSettled?.(entry);
      });
    };
    void next.then(settle, settle);
    return next;
  }

  isProtected(entry: CanvasObjectSyncEntry): boolean {
    return entry.interactionActive || entry.dirty || entry.awaitingRecovery;
  }

  protectedObjectIds(): Set<string> {
    return new Set(
      [...this.entries.values()]
        .filter((entry) => this.isProtected(entry))
        .map((entry) => entry.objectId),
    );
  }

  hasPendingRecovery(): boolean {
    return [...this.entries.values()].some((entry) => entry.awaitingRecovery);
  }

  canSettle(entry: CanvasObjectSyncEntry): boolean {
    return !entry.interactionActive && !entry.dirty && !entry.awaitingRecovery && entry.timer === null;
  }

  canPrune(entry: CanvasObjectSyncEntry): boolean {
    return (
      this.canSettle(entry) &&
      entry.recoveryTimer === null &&
      entry.queuedTasks === 0 &&
      entry.lease === null &&
      entry.leaseRequest === null &&
      entry.releaseRequest === null
    );
  }

  prune(objectId: string): void {
    const entry = this.entries.get(objectId);
    if (entry && this.canPrune(entry)) this.entries.delete(objectId);
  }

  forEach(callback: (entry: CanvasObjectSyncEntry) => void): void {
    this.entries.forEach(callback);
  }
}
