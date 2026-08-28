import type {
  CanvasCommand,
  CanvasObject,
  CreateCanvasObject,
  Diagram,
  DiagramCommand,
  ObjectLease,
  ObjectLeaseAcquireTarget,
  ObjectPatch,
  RoomState,
  SemanticTransaction,
} from "@/lib/domain/types";

import type {
  PendingSemanticCanvasEdit,
  SemanticCanvasAuthoritativeRecovery,
  SemanticCanvasEditIntent,
  SemanticCanvasGestureCancellationToken,
  SemanticCanvasSyncCancelIntent,
  SemanticCanvasSyncFlushIntent,
  SemanticCanvasSyncScheduleIntent,
} from "./semantic-edit-events";
import {
  CanvasObjectSyncCoordinator,
  type CanvasObjectSyncEntry,
} from "./sync-coordinator";

export const SEMANTIC_EDIT_DEBOUNCE_MS = 220;
export const SEMANTIC_EDIT_RECOVERY_RETRY_MS = 1_200;

export type SemanticEditCommandResult = Readonly<{
  room: RoomState;
  changedObjectIds: readonly string[];
}>;

export type SemanticEditTransactionResult = SemanticEditCommandResult &
  Readonly<{ changedDiagramIds?: readonly string[] }>;

export type SemanticEditLeaseCohortResult = Readonly<{
  cohortId: string;
  objectIds: readonly string[];
  leases: ReadonlyMap<string, ObjectLease>;
}>;

export type SemanticEditPersistenceErrorClassification =
  | Readonly<{ kind: "confirmed-failure" }>
  | Readonly<{
      kind: "committed-replay";
      committedRoomRevision: number | null;
    }>;

export type SemanticEditPersistenceAcknowledgement = Readonly<{
  objectId: string;
  generation: number;
  revision: number | null;
  createdAt: number | null;
  latestGenerationSettled: boolean;
}>;

export type SemanticEditPersistenceAcknowledgementEvent = Readonly<{
  room: RoomState;
  objectIds: readonly string[];
  acknowledgements: readonly SemanticEditPersistenceAcknowledgement[];
  committedReplay: boolean;
  /** Human gesture/cohort identity; null only for anonymous renderer batches. */
  gestureId: string | null;
  /** True only after the batch's final generation is authoritative. */
  final: boolean;
  /** Server-reported dependencies accumulated across every generation. */
  changedObjectIds: readonly string[];
  changedDiagramIds: readonly string[];
}>;

export type SemanticEditDiagramRestoration = Readonly<{
  diagramId: string;
  target: Diagram;
}>;

export type SemanticEditPersistenceRollbackEvent = Readonly<{
  room: RoomState;
  objectIds: readonly string[];
  /** Exact renderer session to stop before force-projecting; null for anonymous batches. */
  gestureId: string | null;
  error: unknown;
  reason: "confirmed-failure" | "cancelled";
  cancellationToken: SemanticCanvasGestureCancellationToken | null;
}>;

export type SemanticEditLeaseCohortRecovery = Readonly<{
  cohortId: string;
  /** The complete atomic cohort, not only the member whose renewal failed. */
  objectIds: readonly string[];
  cause: unknown;
}>;

export type SemanticEditPersistenceRecoverySettledEvent = Readonly<{
  gestureId: string | null;
  authoritative: readonly SemanticCanvasAuthoritativeRecovery[];
  reason: "confirmed-failure" | "cancelled";
}>;

/**
 * All external effects are injected so the persistence coordinator can be
 * tested without React, a renderer, browser globals, or server modules.
 * `acceptRoom` must retain the monotonic room selected by the application and
 * return that accepted value.
 */
export type SemanticEditPersistenceHost = Readonly<{
  currentRoom(): RoomState;
  /** Backed by SemanticLeaseCohortManager.ensureCohort. */
  ensureLeaseCohort(input: Readonly<{
    cohortId: string;
    targets: readonly ObjectLeaseAcquireTarget[];
  }>): Promise<SemanticEditLeaseCohortResult>;
  /** Backed by SemanticLeaseCohortManager.releaseCohort. */
  releaseLeaseCohort(cohortId: string): Promise<void>;
  command(command: CanvasCommand): Promise<SemanticEditCommandResult>;
  semanticTransaction(
    transaction: SemanticTransaction,
  ): Promise<SemanticEditTransactionResult>;
  refresh(): Promise<RoomState>;
  acceptRoom(room: RoomState): RoomState;
  classifyError(error: unknown): SemanticEditPersistenceErrorClassification;
  /**
   * Fires synchronously once when a cohort enters confirmed-failure recovery.
   * Authoritative refresh/rollback may still be pending, so the UI can report
   * a rejected save without pretending reconciliation has already completed.
   */
  onFailureConfirmed(error: unknown): void;
  onAcknowledged(event: SemanticEditPersistenceAcknowledgementEvent): void | Promise<void>;
  onRollback(event: SemanticEditPersistenceRollbackEvent): void | Promise<void>;
  onRecoverySettled(
    event: SemanticEditPersistenceRecoverySettledEvent,
  ): void | Promise<void>;
}>;

export type SemanticEditPersistenceClock = Readonly<{
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timer: number): void;
}>;

type ScheduledBatch = {
  batchKey: string;
  cohortId: string;
  objectIds: Set<string>;
  version: number;
  queuedVersion: number;
  acknowledgedVersion: number;
  finalVersion: number | null;
  released: boolean;
  inputFingerprint: string;
  timer: number | null;
  changedObjectIds: Set<string>;
  changedDiagramIds: Set<string>;
  finalAcknowledgementEmitted: boolean;
};

type QueuedObject = Readonly<{
  objectId: string;
  generation: number;
  recoveryEpoch: number;
  edit: PendingSemanticCanvasEdit | null;
}>;

type ExecutedObject = QueuedObject &
  Readonly<{
    expectedRevision: number | null;
    expectedCreatedAt: number | null;
    mode: "create" | "update" | "update-noop" | "delete" | "delete-noop" | "dependency";
  }>;

type ActiveRecoveryGroup = {
  phase: "collecting" | "projecting" | "settled";
  objectIds: Set<string>;
  cohortIds: Set<string>;
  cancellationsByCohort: Map<string, SemanticCanvasSyncCancelIntent>;
  primaryCohortId: string;
  error: unknown;
  hasConfirmedFailure: boolean;
  promise: Promise<void>;
};

type ExecutionPlan = Readonly<{
  commands: readonly CanvasCommand[];
  diagramCommands: readonly DiagramCommand[];
  objects: readonly ExecutedObject[];
}>;

function defaultClock(): SemanticEditPersistenceClock {
  return {
    setTimeout(callback, delayMs) {
      return globalThis.setTimeout(callback, delayMs) as unknown as number;
    },
    clearTimeout(timer) {
      globalThis.clearTimeout(timer);
    },
  };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function editFingerprint(edit: PendingSemanticCanvasEdit | undefined): string {
  return edit
    ? `${edit.objectId}:${edit.generation}:${edit.recoveryEpoch}:${edit.kind}`
    : "dependency";
}

function patchForDraft(draft: CreateCanvasObject): ObjectPatch {
  const patch: Record<string, unknown> = { ...draft };
  delete patch.id;
  delete patch.kind;
  return patch as ObjectPatch;
}

function draftMatchesAuthoritativeObject(
  draft: CreateCanvasObject,
  current: CanvasObject,
): boolean {
  const patch = patchForDraft(draft) as Readonly<Record<string, unknown>>;
  const authoritative = current as unknown as Readonly<Record<string, unknown>>;
  return Object.entries(patch).every(([key, value]) =>
    semanticInputFingerprint(value) === semanticInputFingerprint(authoritative[key])
  );
}

function semanticInputFingerprint(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Readonly<Record<string, unknown>>)
        // resolvedAt is authoritative workflow state and is deliberately not
        // present in CreateCanvasObject input drafts.
        .filter(([key]) => key !== "resolvedAt")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function roomObjectIdentity(
  room: RoomState,
  objectId: string,
): { revision: number | null; createdAt: number | null } {
  const object = room.objects[objectId];
  return object
    ? { revision: object.revision, createdAt: object.createdAt }
    : { revision: null, createdAt: null };
}

/**
 * The one persistence writer for renderer-neutral semantic edit intents.
 *
 * The lifecycle owns synchronous protection and generations; this driver owns
 * debounce, lease cohorts, serialized commands, acknowledgement, recovery,
 * and release. Absolute drafts remain renderer-owned data and are never
 * replaced by a stale command response.
 */
export class SemanticCanvasEditPersistenceDriver {
  private readonly batches = new Map<string, ScheduledBatch>();
  private readonly latestEdits = new Map<string, PendingSemanticCanvasEdit>();
  private readonly leaseTargetsByCohort = new Map<
    string,
    Map<string, ObjectLeaseAcquireTarget>
  >();
  private readonly pendingAnonymousLeaseTargets = new Map<
    string,
    ObjectLeaseAcquireTarget
  >();
  private readonly activeCohortIds = new Set<string>();
  private readonly gestureIdByCohort = new Map<string, string | null>();
  private readonly diagramRestorationsByCohort = new Map<
    string,
    readonly SemanticEditDiagramRestoration[]
  >();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly pendingTimerPromises = new Map<number, Promise<void>>();
  private readonly pendingTimerResolvers = new Map<number, () => void>();
  private readonly recoveryByObjectId = new Map<string, ActiveRecoveryGroup>();
  private readonly failureReportedCohortIds = new Set<string>();
  private readonly cancellationRecoveryCohortIds = new Set<string>();
  private readonly delayResolvers = new Map<number, () => void>();
  private disposed = false;
  private shuttingDown = false;

  constructor(
    private readonly coordinator: CanvasObjectSyncCoordinator,
    private readonly host: SemanticEditPersistenceHost,
    private readonly clock: SemanticEditPersistenceClock = defaultClock(),
  ) {}

  /**
   * Adds revision-fenced Diagram restoration to the same transaction as a
   * history replay. Diagram deletion is deliberately unsupported by the
   * current domain API and must be rejected by the controller before here.
   */
  registerDiagramRestorations(
    gestureId: string,
    restorations: readonly SemanticEditDiagramRestoration[],
  ): void {
    if (this.disposed) return;
    this.diagramRestorationsByCohort.set(
      gestureId,
      restorations.map((restoration) => ({
        diagramId: restoration.diagramId,
        target: structuredClone(restoration.target),
      })),
    );
  }

  /** Idempotent cleanup for a replay that failed before a persistence batch existed. */
  unregisterDiagramRestorations(gestureId: string): void {
    this.diagramRestorationsByCohort.delete(gestureId);
  }

  consume(intent: SemanticCanvasEditIntent): Promise<void> | null {
    if (this.disposed) return null;
    switch (intent.type) {
      case "lease.acquire": {
        if (intent.gestureId === null) {
          for (const target of intent.targets) {
            this.pendingAnonymousLeaseTargets.set(target.objectId, target);
          }
          return null;
        }
        this.gestureIdByCohort.set(intent.gestureId, intent.gestureId);
        this.rememberLeaseTargets(intent.gestureId, intent.targets);
        const operation = this.ensureLeaseCohort(intent.gestureId, intent.targets)
          .then(() => undefined)
          .catch((error) => {
            if (this.shuttingDown) return undefined;
            // A no-change pointer gesture may settle while its initial lease
            // request is still in flight. If a newer overlapping gesture (for
            // example double-click text editing) has already claimed the
            // object, releasing the retired cohort deliberately makes that
            // acquire reject with INACTIVE_COHORT. The cohort is no longer an
            // authority boundary, so treating the expected late rejection as
            // a conflict would roll back the newer protected gesture.
            if (!this.activeCohortIds.has(intent.gestureId!)) return undefined;
            return this.recoverConfirmed(
              this.objectIdsForCohort(
                intent.gestureId!,
                intent.targets.map((target) => target.objectId),
              ),
              error,
              null,
              intent.gestureId!,
            );
          });
        this.track(operation);
        return operation;
      }
      case "sync.schedule":
        this.schedule(intent);
        return null;
      case "sync.flush":
        return this.flush(intent);
      case "sync.cancel": {
        this.rememberEdits(intent.edits);
        const recovery = this.recoverConfirmed(
          intent.objectIds,
          new SemanticEditCancellationError(intent.reason),
          intent,
          intent.gestureId,
        );
        this.track(recovery);
        return recovery;
      }
      case "gesture.settle":
        // A renderer consumes this render-settlement boundary and dispatches
        // the resulting lifecycle event. It has no persistence side effect.
        return null;
    }
  }

  /** Direct composition point for SemanticLeaseCohortManager.onCohortRecovery. */
  recoverLeaseCohort(recovery: SemanticEditLeaseCohortRecovery): Promise<void> {
    if (this.disposed || this.shuttingDown) return Promise.resolve();
    if (!this.gestureIdByCohort.has(recovery.cohortId)) {
      this.gestureIdByCohort.set(
        recovery.cohortId,
        recovery.cohortId.startsWith("batch:") ? null : recovery.cohortId,
      );
    }
    const operation = this.recoverConfirmed(
      recovery.objectIds,
      recovery.cause,
      null,
      recovery.cohortId,
    );
    this.track(operation);
    return operation;
  }

  /**
   * Resolves once every pending debounce and every network/recovery task has
   * settled. A caller taking an authoritative snapshot (for example Ask) must
   * not mistake a locally painted, not-yet-queued edit for an idle canvas.
   */
  async whenIdle(): Promise<void> {
    while (this.operations.size || this.pendingTimerPromises.size) {
      await Promise.allSettled([
        ...this.operations,
        ...this.pendingTimerPromises.values(),
      ]);
    }
  }

  /**
   * Converts every still-debounced batch into one final queued generation.
   * The returned drain performs at most the already-intended mutation: it
   * does not reconcile or retry an ambiguous failure during renderer teardown.
   */
  flushPendingForShutdown(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      for (const batch of this.batches.values()) {
        this.clearBatchTimer(batch);
        batch.finalVersion = batch.version;
        const operation = this.queueBatch(batch);
        if (operation) this.track(operation);
      }
    }
    return this.whenIdle();
  }

  /** Bounded-state assertion surface for deterministic longevity tests. */
  debugStateForTests(): Readonly<{
    batches: number;
    cohortTargets: number;
    anonymousLeaseTargets: number;
    activeCohorts: number;
    gestureCohorts: number;
    recoveries: number;
  }> {
    return {
      batches: this.batches.size,
      cohortTargets: this.leaseTargetsByCohort.size,
      anonymousLeaseTargets: this.pendingAnonymousLeaseTargets.size,
      activeCohorts: this.activeCohortIds.size,
      gestureCohorts: this.gestureIdByCohort.size,
      recoveries: this.recoveryByObjectId.size,
    };
  }

  /**
   * Transfers still-debounced objects out of an older gesture batch so a new
   * pointer gesture can persist their latest absolute drafts atomically. The
   * shared `latestEdits` entries intentionally remain: the new gesture either
   * replaces them on its first moved frame or adopts them on pointer-up.
   */
  absorbPendingGestureObjects(input: Readonly<{
    fromGestureIds: ReadonlySet<string>;
    objectIds: readonly string[];
  }>): readonly string[] {
    if (this.disposed || !input.fromGestureIds.size || !input.objectIds.length) return [];
    const requested = new Set(input.objectIds);
    const absorbed = new Set<string>();
    for (const batch of this.batches.values()) {
      if (!input.fromGestureIds.has(batch.cohortId) || batch.queuedVersion > 0) continue;
      const removed: string[] = [];
      for (const objectId of requested) {
        if (!batch.objectIds.delete(objectId)) continue;
        removed.push(objectId);
        absorbed.add(objectId);
      }
      if (!removed.length) continue;
      if (batch.timer !== null) this.clearCoordinatorTimer(removed, batch.timer);
      batch.inputFingerprint = sortedUnique(batch.objectIds)
        .map((objectId) => `${objectId}=${editFingerprint(this.latestEdits.get(objectId))}`)
        .join(";");
      if (!batch.objectIds.size) {
        batch.version = 0;
        batch.queuedVersion = 0;
        batch.acknowledgedVersion = 0;
      }
    }
    return Object.freeze(sortedUnique(absorbed));
  }

  /**
   * Fences all late work. In-flight requests cannot be aborted generically,
   * but their results will not project, acknowledge, or invoke callbacks.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const batch of this.batches.values()) this.clearBatchTimer(batch);
    for (const timer of [...this.pendingTimerResolvers.keys()]) {
      this.settlePendingTimer(timer);
    }
    for (const [timer, resolve] of this.delayResolvers) {
      this.clock.clearTimeout(timer);
      resolve();
    }
    this.delayResolvers.clear();
    this.batches.clear();
    this.latestEdits.clear();
    this.leaseTargetsByCohort.clear();
    this.gestureIdByCohort.clear();
    this.diagramRestorationsByCohort.clear();
    this.pendingAnonymousLeaseTargets.clear();
    this.recoveryByObjectId.clear();
    this.failureReportedCohortIds.clear();
    this.cancellationRecoveryCohortIds.clear();

    this.coordinator.forEach((entry) => {
      entry.timer = null;
    });
    for (const cohortId of this.activeCohortIds) {
      void this.host.releaseLeaseCohort(cohortId).catch(() => undefined);
    }
    this.activeCohortIds.clear();
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }

  private rememberEdits(edits: readonly PendingSemanticCanvasEdit[]): void {
    for (const edit of edits) {
      const entry = this.coordinator.get(edit.objectId);
      if (
        entry &&
        edit.recoveryEpoch === entry.recoveryEpoch &&
        edit.generation <= entry.acknowledgedGeneration
      ) {
        continue;
      }
      const previous = this.latestEdits.get(edit.objectId);
      if (
        !previous ||
        edit.recoveryEpoch > previous.recoveryEpoch ||
        (edit.recoveryEpoch === previous.recoveryEpoch && edit.generation >= previous.generation)
      ) {
        this.latestEdits.set(edit.objectId, edit);
      }
    }
  }

  private rememberLeaseTargets(
    cohortId: string,
    targets: readonly ObjectLeaseAcquireTarget[],
  ): void {
    const cohortTargets = this.leaseTargetsByCohort.get(cohortId) ?? new Map();
    for (const target of targets) {
      const previous = cohortTargets.get(target.objectId);
      if (
        previous &&
        (previous.expectedRevision !== target.expectedRevision ||
          previous.operation !== target.operation)
      ) {
        throw new SemanticEditAuthorityError(
          `Lease cohort ${cohortId} changed the identity of ${target.objectId}.`,
        );
      }
      cohortTargets.set(target.objectId, { ...target });
    }
    this.leaseTargetsByCohort.set(cohortId, cohortTargets);
  }

  private objectIdsForCohort(
    cohortId: string,
    fallback: Iterable<string> = [],
  ): string[] {
    const objectIds = new Set(fallback);
    for (const objectId of this.leaseTargetsByCohort.get(cohortId)?.keys() ?? []) {
      objectIds.add(objectId);
    }
    for (const batch of this.batches.values()) {
      if (batch.cohortId !== cohortId) continue;
      for (const objectId of batch.objectIds) objectIds.add(objectId);
    }
    for (const edit of this.latestEdits.values()) {
      if (edit.gestureId === cohortId) objectIds.add(edit.objectId);
    }
    return sortedUnique(objectIds);
  }

  /**
   * Recovery is an atomic graph operation. If a failed object participates in
   * another still-live gesture/batch, every member of that cohort (and every
   * transitively overlapping cohort) must share one recovery boundary.
   */
  private recoveryScope(
    objectIdsInput: readonly string[],
    cohortId: string,
  ): Readonly<{ objectIds: readonly string[]; cohortIds: readonly string[] }> {
    const objectIds = new Set(objectIdsInput);
    const cohortIds = new Set([cohortId]);
    const knownCohortIds = new Set<string>([
      ...this.gestureIdByCohort.keys(),
      ...this.leaseTargetsByCohort.keys(),
      ...[...this.batches.values()].map((batch) => batch.cohortId),
      ...[...this.latestEdits.values()].flatMap((edit) => edit.gestureId ? [edit.gestureId] : []),
    ]);

    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of knownCohortIds) {
        const members = this.objectIdsForCohort(candidate);
        if (
          !cohortIds.has(candidate) &&
          !members.some((objectId) => objectIds.has(objectId))
        ) continue;
        if (!cohortIds.has(candidate)) {
          cohortIds.add(candidate);
          changed = true;
        }
        for (const objectId of members) {
          if (objectIds.has(objectId)) continue;
          objectIds.add(objectId);
          changed = true;
        }
      }
    }

    return {
      objectIds: sortedUnique(objectIds),
      cohortIds: sortedUnique(cohortIds),
    };
  }

  private updateBatch(
    intent: SemanticCanvasSyncScheduleIntent | SemanticCanvasSyncFlushIntent,
  ): ScheduledBatch {
    this.rememberEdits(intent.edits);
    let batch = this.batches.get(intent.batchKey);
    const gestureId =
      intent.type === "sync.flush"
        ? intent.gestureId
        : intent.edits.find((edit) => edit.gestureId !== null)?.gestureId ?? null;
    const cohortId = gestureId ?? `batch:${intent.batchKey}`;
    this.gestureIdByCohort.set(cohortId, gestureId);
    if (!batch) {
      batch = {
        batchKey: intent.batchKey,
        cohortId,
        objectIds: new Set(),
        version: 0,
        queuedVersion: 0,
        acknowledgedVersion: 0,
        finalVersion: gestureId === null ? 0 : null,
        released: false,
        inputFingerprint: "",
        timer: null,
        changedObjectIds: new Set(),
        changedDiagramIds: new Set(),
        finalAcknowledgementEmitted: false,
      };
      this.batches.set(intent.batchKey, batch);
    } else if (batch.cohortId !== cohortId) {
      throw new SemanticEditAuthorityError(
        `Persistence batch ${intent.batchKey} changed lease cohorts.`,
      );
    }
    for (const objectId of intent.objectIds) batch.objectIds.add(objectId);
    const ids = sortedUnique(batch.objectIds);
    const fingerprint = ids
      .map((objectId) => `${objectId}=${editFingerprint(this.latestEdits.get(objectId))}`)
      .join(";");
    if (fingerprint !== batch.inputFingerprint) {
      batch.inputFingerprint = fingerprint;
      batch.version += 1;
    }
    if (gestureId === null) batch.finalVersion = batch.version;

    const anonymousTargets = sortedUnique(batch.objectIds).flatMap((objectId) => {
      const target = this.pendingAnonymousLeaseTargets.get(objectId);
      return target ? [target] : [];
    });
    if (anonymousTargets.length) {
      this.rememberLeaseTargets(batch.cohortId, anonymousTargets);
      for (const target of anonymousTargets) {
        this.pendingAnonymousLeaseTargets.delete(target.objectId);
      }
      const operation = this.ensureLeaseCohort(batch.cohortId, anonymousTargets)
        .then(() => undefined)
        .catch((error) => {
          if (this.shuttingDown) return undefined;
          return this.recoverConfirmed(
            sortedUnique(batch!.objectIds),
            error,
            null,
            batch!.cohortId,
          );
        });
      this.track(operation);
    }
    return batch;
  }

  private schedule(intent: SemanticCanvasSyncScheduleIntent): void {
    const batch = this.updateBatch(intent);
    this.clearBatchTimer(batch);
    let timer = 0;
    timer = this.clock.setTimeout(() => {
      this.settlePendingTimer(timer);
      if (this.disposed || batch.timer !== timer) return;
      batch.timer = null;
      this.clearCoordinatorTimer(batch.objectIds, timer);
      const operation = this.queueBatch(batch);
      if (operation) this.track(operation);
    }, SEMANTIC_EDIT_DEBOUNCE_MS);
    let resolvePendingTimer!: () => void;
    const pendingTimer = new Promise<void>((resolve) => {
      resolvePendingTimer = resolve;
    });
    this.pendingTimerPromises.set(timer, pendingTimer);
    this.pendingTimerResolvers.set(timer, resolvePendingTimer);
    batch.timer = timer;
    for (const objectId of batch.objectIds) {
      const object = this.host.currentRoom().objects[objectId];
      const entry = this.coordinator.getOrCreate(
        objectId,
        object?.revision ?? null,
        object?.createdAt ?? null,
      );
      entry.timer = timer;
    }
  }

  private flush(intent: SemanticCanvasSyncFlushIntent): Promise<void> | null {
    const batch = this.updateBatch(intent);
    batch.finalVersion = batch.version;
    this.clearBatchTimer(batch);
    const operation = this.queueBatch(batch);
    if (operation) {
      this.track(operation);
      return operation;
    }
    const finalize = this.emitFinalAcknowledgementIfReady(batch).then(async () => {
      const release = this.releaseFinalCohortIfAcknowledged(batch);
      if (release) await release;
    });
    this.track(finalize);
    return finalize;
  }

  private clearBatchTimer(batch: ScheduledBatch): void {
    if (batch.timer === null) return;
    const timer = batch.timer;
    this.clock.clearTimeout(timer);
    this.settlePendingTimer(timer);
    batch.timer = null;
    this.clearCoordinatorTimer(batch.objectIds, timer);
  }

  private settlePendingTimer(timer: number): void {
    const resolve = this.pendingTimerResolvers.get(timer);
    if (!resolve) return;
    this.pendingTimerResolvers.delete(timer);
    this.pendingTimerPromises.delete(timer);
    resolve();
  }

  private clearCoordinatorTimer(objectIds: Iterable<string>, timer: number): void {
    for (const objectId of objectIds) {
      const entry = this.coordinator.get(objectId);
      if (entry?.timer === timer) entry.timer = null;
    }
  }

  private queueBatch(batch: ScheduledBatch): Promise<void> | null {
    if (this.disposed || batch.queuedVersion >= batch.version) return null;
    batch.queuedVersion = batch.version;
    const room = this.host.currentRoom();
    const objects: QueuedObject[] = [];

    for (const objectId of sortedUnique(batch.objectIds)) {
      const current = room.objects[objectId];
      let entry = this.coordinator.getOrCreate(
        objectId,
        current?.revision ?? null,
        current?.createdAt ?? null,
      );
      let edit = this.latestEdits.get(objectId) ?? null;
      if (edit && edit.recoveryEpoch !== entry.recoveryEpoch) edit = null;

      if (edit && edit.generation > entry.queuedGeneration) {
        entry.queuedGeneration = edit.generation;
        objects.push({
          objectId,
          generation: edit.generation,
          recoveryEpoch: edit.recoveryEpoch,
          edit,
        });
        continue;
      }

      // A cohort member without a new explicit edit may still be an implicit
      // connector/group dependency. Give it a generation checkpoint so stale
      // projection stays fenced through this batch without inventing a command.
      const marked = this.coordinator.markDirty({
        objectId,
        shapeId: null,
        baseRevision: entry.baseRevision,
        baseCreatedAt: entry.baseCreatedAt,
        deleted: false,
      });
      entry = marked.entry;
      entry.queuedGeneration = marked.generation;
      objects.push({
        objectId,
        generation: marked.generation,
        recoveryEpoch: entry.recoveryEpoch,
        edit: null,
      });
    }

    if (!objects.length) return null;
    const objectIds = objects.map((object) => object.objectId);
    const queuedVersion = batch.version;
    const operation = this.coordinator.enqueueBatch(
      objectIds,
      async () => this.executeBatch(batch, queuedVersion, objects),
      (entry) => this.coordinator.prune(entry.objectId),
    );
    return operation;
  }

  private async executeBatch(
    batch: ScheduledBatch,
    queuedVersion: number,
    objects: readonly QueuedObject[],
  ): Promise<void> {
    if (this.disposed || this.isFenced(objects)) return;
    let plan: ExecutionPlan | null = null;
    try {
      const leaseTargets = this.dynamicLeaseTargets(objects, batch.cohortId);
      if (leaseTargets.length) {
        await this.ensureLeaseCohort(batch.cohortId, leaseTargets);
      }
      if (this.disposed || this.isFenced(objects)) return;
      plan = this.buildExecutionPlan(objects, batch.cohortId);

      let result: SemanticEditCommandResult | SemanticEditTransactionResult | null = null;
      if (plan.commands.length === 1 && plan.diagramCommands.length === 0) {
        result = await this.host.command(plan.commands[0]);
      } else if (plan.commands.length > 0 || plan.diagramCommands.length > 0) {
        result = await this.host.semanticTransaction({
          commands: [...plan.commands],
          diagramCommands: [...plan.diagramCommands],
        });
      }
      // Renderer teardown has already fenced every UI callback. Once the one
      // queued mutation resolves, leave acknowledgement/release cleanup to the
      // shutdown finalizer rather than projecting into an unmounted surface.
      if (this.shuttingDown) return;
      if (this.disposed || this.isFenced(objects)) return;
      const authoritative = result
        ? this.host.acceptRoom(result.room)
        : this.host.currentRoom();
      for (const objectId of result?.changedObjectIds ?? []) batch.changedObjectIds.add(objectId);
      for (const diagramId of (result as SemanticEditTransactionResult | null)?.changedDiagramIds ?? []) {
        batch.changedDiagramIds.add(diagramId);
      }
      batch.acknowledgedVersion = Math.max(batch.acknowledgedVersion, queuedVersion);
      await this.acknowledge(
        plan,
        authoritative,
        false,
        batch,
        this.isFinalAcknowledgement(batch, queuedVersion),
      );
      const release = this.releaseFinalCohortIfAcknowledged(batch);
      if (release) await release;
    } catch (error) {
      if (this.disposed || this.shuttingDown) return;
      const classification = this.safeClassify(error);
      if (classification.kind === "committed-replay" && plan?.commands.length) {
        try {
          const replayed = await this.reconcileCommittedReplay(
            batch,
            queuedVersion,
            plan,
            error,
            classification.committedRoomRevision,
          );
          if (replayed) return;
        } catch (reconciliationError) {
          await this.recoverConfirmed(
            objects.map((object) => object.objectId),
            reconciliationError,
            null,
            batch.cohortId,
          );
          return;
        }
      }
      await this.recoverConfirmed(
        objects.map((object) => object.objectId),
        error,
        null,
        batch.cohortId,
      );
    }
  }

  private isFenced(objects: readonly QueuedObject[]): boolean {
    return objects.some((object) => {
      const entry = this.coordinator.get(object.objectId);
      return !entry || entry.awaitingRecovery || entry.recoveryEpoch !== object.recoveryEpoch;
    });
  }

  private dynamicLeaseTargets(
    objects: readonly QueuedObject[],
    cohortId: string,
  ): ObjectLeaseAcquireTarget[] {
    const room = this.host.currentRoom();
    const targets: ObjectLeaseAcquireTarget[] = [];
    for (const queued of objects) {
      const entry = this.requiredEntry(queued);
      const current = room.objects[queued.objectId];
      if (current && (
        entry.baseRevision !== current.revision ||
        entry.baseCreatedAt !== current.createdAt
      )) {
        throw new SemanticEditAuthorityError(
          `Canvas object ${queued.objectId} changed before its edit could be saved.`,
        );
      }
      if (!current) {
        if (entry.baseRevision !== null || entry.baseCreatedAt !== null) {
          throw new SemanticEditAuthorityError(
            `Canvas object ${queued.objectId} disappeared before its edit could be saved.`,
          );
        }
        continue;
      }

      let operation = this.leaseTargetsByCohort.get(cohortId)?.get(queued.objectId)?.operation ?? null;
      if (queued.edit?.kind === "update") operation = queued.edit.operation;
      else if (queued.edit?.kind === "delete") operation = "delete";
      else if (queued.edit?.kind === "create") operation ??= "edit";
      if (operation && !entry.lease) {
        targets.push({
          objectId: queued.objectId,
          expectedRevision: entry.baseRevision!,
          operation,
        });
      }
    }
    return targets;
  }

  private requiredEntry(queued: QueuedObject): CanvasObjectSyncEntry {
    const entry = this.coordinator.get(queued.objectId);
    if (
      !entry ||
      entry.awaitingRecovery ||
      entry.recoveryEpoch !== queued.recoveryEpoch
    ) {
      throw new SemanticEditAuthorityError(
        `Canvas object ${queued.objectId} was reconciled before its edit could be saved.`,
      );
    }
    return entry;
  }

  private buildExecutionPlan(objects: readonly QueuedObject[], cohortId: string): ExecutionPlan {
    const room = this.host.currentRoom();
    const executed: ExecutedObject[] = [];
    type UpdateSpec = Readonly<{
      queued: QueuedObject;
      expectedRevision: number;
      expectedCreatedAt: number;
      draft: CreateCanvasObject;
      operation: Exclude<PendingSemanticCanvasEdit, { kind: "create" | "delete" }>[
        "operation"
      ];
      leaseId: string;
    }>;
    const creates: CanvasCommand[] = [];
    const updates: UpdateSpec[] = [];
    const deletions: Extract<CanvasCommand, { type: "delete" }>["targets"] = [];

    for (const queued of objects) {
      const entry = this.requiredEntry(queued);
      const current = room.objects[queued.objectId];
      if (current && (
        entry.baseRevision !== current.revision ||
        entry.baseCreatedAt !== current.createdAt
      )) {
        throw new SemanticEditAuthorityError(
          `Canvas object ${queued.objectId} changed while its lease was being acquired.`,
        );
      }
      if (!current && (entry.baseRevision !== null || entry.baseCreatedAt !== null)) {
        throw new SemanticEditAuthorityError(
          `Canvas object ${queued.objectId} changed incarnation while its lease was being acquired.`,
        );
      }

      if (!queued.edit) {
        executed.push({
          ...queued,
          expectedRevision: entry.baseRevision,
          expectedCreatedAt: entry.baseCreatedAt,
          mode: "dependency",
        });
        continue;
      }

      if (queued.edit.kind === "delete") {
        if (!current) {
          executed.push({
            ...queued,
            expectedRevision: null,
            expectedCreatedAt: null,
            mode: "delete-noop",
          });
          continue;
        }
        const leaseId = entry.lease?.lease.leaseId;
        if (!leaseId) throw new SemanticEditAuthorityError(`Canvas object ${queued.objectId} has no lease.`);
        deletions.push({
          objectId: queued.objectId,
          expectedRevision: current.revision,
          leaseId,
        });
        executed.push({
          ...queued,
          expectedRevision: current.revision,
          expectedCreatedAt: current.createdAt,
          mode: "delete",
        });
        continue;
      }

      if (!current) {
        creates.push({ type: "create", object: queued.edit.draft });
        executed.push({
          ...queued,
          expectedRevision: null,
          expectedCreatedAt: null,
          mode: "create",
        });
        continue;
      }


      if (queued.edit.kind === "update" && draftMatchesAuthoritativeObject(queued.edit.draft, current)) {
        executed.push({
          ...queued,
          expectedRevision: current.revision,
          expectedCreatedAt: current.createdAt,
          mode: "update-noop",
        });
        continue;
      }

      const leaseId = entry.lease?.lease.leaseId;
      if (!leaseId) throw new SemanticEditAuthorityError(`Canvas object ${queued.objectId} has no lease.`);
      updates.push({
        queued,
        expectedRevision: current.revision,
        expectedCreatedAt: current.createdAt,
        draft: queued.edit.draft,
        operation: queued.edit.kind === "update" ? queued.edit.operation : "edit",
        leaseId,
      });
      executed.push({
        ...queued,
        expectedRevision: current.revision,
        expectedCreatedAt: current.createdAt,
        mode: "update",
      });
    }

    creates.sort(
      (left, right) =>
        Number(left.type === "create" && left.object.kind === "connector") -
        Number(right.type === "create" && right.object.kind === "connector"),
    );
    const commands: CanvasCommand[] = [];
    if (
      creates.length === 0 &&
      deletions.length === 0 &&
      updates.length > 0 &&
      updates.every((update) => update.operation === "move")
    ) {
      commands.push({
        type: "move",
        targets: updates.map((update) => ({
          objectId: update.queued.objectId,
          expectedRevision: update.expectedRevision,
          x: update.draft.x,
          y: update.draft.y,
          leaseId: update.leaseId,
        })),
      });
    } else {
      commands.push(...creates);
      for (const update of updates) {
        commands.push({
          type: "update",
          objectId: update.queued.objectId,
          expectedRevision: update.expectedRevision,
          patch: patchForDraft(update.draft),
          leaseId: update.leaseId,
          operation: update.operation,
        });
      }
      if (deletions.length) commands.push({ type: "delete", targets: deletions });
    }
    const diagramCommands = this.buildDiagramCommands(cohortId, room);
    if (commands.length + diagramCommands.length > 200) {
      throw new SemanticEditAuthorityError(
        "A history replay cannot exceed 200 atomic semantic operations.",
      );
    }
    return { commands, diagramCommands, objects: executed };
  }

  private buildDiagramCommands(cohortId: string, room: RoomState): DiagramCommand[] {
    const commands: DiagramCommand[] = [];
    for (const restoration of this.diagramRestorationsByCohort.get(cohortId) ?? []) {
      const current = room.diagrams[restoration.diagramId];
      const target = restoration.target;
      const patch = {
        title: target.title,
        description: target.description,
        diagramType: target.diagramType,
        category: target.category,
        tags: [...target.tags],
        memberObjectIds: [...target.memberObjectIds],
        connectorIds: [...target.connectorIds],
      };
      if (!current) {
        commands.push({ type: "diagram.create", diagram: { id: target.id, ...patch } });
        continue;
      }
      const currentFingerprint = JSON.stringify({
        title: current.title,
        description: current.description,
        diagramType: current.diagramType,
        category: current.category,
        tags: current.tags,
        memberObjectIds: current.memberObjectIds,
        connectorIds: current.connectorIds,
      });
      if (currentFingerprint === JSON.stringify(patch)) continue;
      commands.push({
        type: "diagram.update",
        diagramId: target.id,
        expectedRevision: current.revision,
        patch,
      });
    }
    return commands;
  }

  private async acknowledge(
    plan: ExecutionPlan,
    authoritative: RoomState,
    committedReplay: boolean,
    batch: ScheduledBatch,
    final: boolean,
  ): Promise<void> {
    if (this.disposed) return;
    const acknowledgements: SemanticEditPersistenceAcknowledgement[] = [];
    for (const object of plan.objects) {
      const identity = roomObjectIdentity(authoritative, object.objectId);
      if (
        (object.mode === "create" || object.mode === "update" || object.mode === "update-noop") &&
        identity.revision === null
      ) {
        throw new SemanticEditAuthorityError(
          `Canvas object ${object.objectId} was not returned by authority.`,
        );
      }
      if (
        (object.mode === "delete" || object.mode === "delete-noop") &&
        identity.revision !== null
      ) {
        throw new SemanticEditAuthorityError(
          `Deleted canvas object ${object.objectId} remains in authority.`,
        );
      }
      if (
        object.expectedCreatedAt !== null &&
        object.mode !== "delete" &&
        object.mode !== "delete-noop" &&
        identity.createdAt !== object.expectedCreatedAt
      ) {
        throw new SemanticEditAuthorityError(
          `Canvas object ${object.objectId} changed incarnation while it was saving.`,
        );
      }
      const latestGenerationSettled = this.coordinator.acknowledge(
        object.objectId,
        object.generation,
        identity.revision,
        {
          expectedCreatedAt: object.expectedCreatedAt,
          authoritativeCreatedAt: identity.createdAt,
        },
      );
      const entry = this.coordinator.get(object.objectId);
      if (!entry || entry.acknowledgedGeneration < object.generation) {
        throw new SemanticEditAuthorityError(
          `Canvas object ${object.objectId} acknowledgement was fenced.`,
        );
      }
      if (this.latestEdits.get(object.objectId)?.generation === object.generation) {
        this.latestEdits.delete(object.objectId);
      }
      acknowledgements.push({
        objectId: object.objectId,
        generation: object.generation,
        revision: identity.revision,
        createdAt: identity.createdAt,
        latestGenerationSettled,
      });
    }
    await this.host.onAcknowledged({
      room: authoritative,
      objectIds: plan.objects.map((object) => object.objectId),
      acknowledgements,
      committedReplay,
      gestureId: this.gestureIdByCohort.get(batch.cohortId) ?? null,
      final,
      changedObjectIds: sortedUnique(batch.changedObjectIds),
      changedDiagramIds: sortedUnique(batch.changedDiagramIds),
    });
    if (final) batch.finalAcknowledgementEmitted = true;
  }

  private isFinalAcknowledgement(batch: ScheduledBatch, queuedVersion: number): boolean {
    return batch.finalVersion !== null &&
      queuedVersion >= batch.finalVersion &&
      batch.acknowledgedVersion >= batch.finalVersion &&
      queuedVersion === batch.version;
  }

  private async emitFinalAcknowledgementIfReady(batch: ScheduledBatch): Promise<void> {
    if (
      this.disposed ||
      batch.finalAcknowledgementEmitted ||
      batch.finalVersion === null ||
      batch.acknowledgedVersion < batch.finalVersion
    ) return;
    batch.finalAcknowledgementEmitted = true;
    await this.host.onAcknowledged({
      room: this.host.currentRoom(),
      objectIds: sortedUnique(batch.objectIds),
      acknowledgements: [],
      committedReplay: false,
      gestureId: this.gestureIdByCohort.get(batch.cohortId) ?? null,
      final: true,
      changedObjectIds: sortedUnique(batch.changedObjectIds),
      changedDiagramIds: sortedUnique(batch.changedDiagramIds),
    });
  }

  private async ensureLeaseCohort(
    cohortId: string,
    requestedTargets: readonly ObjectLeaseAcquireTarget[],
  ): Promise<SemanticEditLeaseCohortResult | null> {
    if (this.disposed || !requestedTargets.length) return null;
    this.rememberLeaseTargets(cohortId, requestedTargets);
    const targets = sortedUnique(requestedTargets.map((target) => target.objectId)).map(
      (objectId) => requestedTargets.find((target) => target.objectId === objectId)!,
    );
    this.activeCohortIds.add(cohortId);
    const result = await this.host.ensureLeaseCohort({ cohortId, targets });
    if (this.disposed) {
      return null;
    }
    if (result.cohortId !== cohortId) {
      throw new SemanticEditAuthorityError(
        `Lease host returned cohort ${result.cohortId} for ${cohortId}.`,
      );
    }
    for (const target of targets) {
      const lease = result.leases.get(target.objectId);
      const installed = this.coordinator.get(target.objectId)?.lease?.lease;
      if (
        !lease ||
        !installed ||
        lease.leaseId !== installed.leaseId
      ) {
        throw new SemanticEditAuthorityError(
          `Lease cohort ${cohortId} did not install ${target.objectId}.`,
        );
      }
    }
    return result;
  }

  private releaseFinalCohortIfAcknowledged(
    batch: ScheduledBatch,
  ): Promise<void> | null {
    if (
      this.disposed ||
      batch.released ||
      batch.finalVersion === null ||
      batch.acknowledgedVersion < batch.finalVersion
    ) {
      return null;
    }
    batch.released = true;
    this.activeCohortIds.delete(batch.cohortId);
    this.leaseTargetsByCohort.delete(batch.cohortId);
    this.diagramRestorationsByCohort.delete(batch.cohortId);
    this.gestureIdByCohort.delete(batch.cohortId);
    if (this.batches.get(batch.batchKey) === batch) this.batches.delete(batch.batchKey);
    return this.host.releaseLeaseCohort(batch.cohortId).catch(() => undefined);
  }

  private safeClassify(error: unknown): SemanticEditPersistenceErrorClassification {
    try {
      return this.host.classifyError(error);
    } catch {
      return { kind: "confirmed-failure" };
    }
  }

  private async reconcileCommittedReplay(
    batch: ScheduledBatch,
    queuedVersion: number,
    plan: ExecutionPlan,
    error: unknown,
    committedRoomRevision: number | null,
  ): Promise<boolean> {
    while (!this.disposed) {
      let authoritative: RoomState;
      try {
        const refreshed = await this.host.refresh();
        if (this.disposed) return true;
        if (refreshed.id !== this.host.currentRoom().id) {
          if (!(await this.waitForRecoveryRetry())) return true;
          continue;
        }
        authoritative = this.host.acceptRoom(refreshed);
      } catch {
        if (!(await this.waitForRecoveryRetry())) return true;
        continue;
      }
      const visibility = this.replayVisibility(
        plan,
        authoritative,
        committedRoomRevision,
      );
      if (visibility === "incompatible") {
        await this.recoverConfirmed(
          plan.objects.map((object) => object.objectId),
          error,
          null,
          batch.cohortId,
        );
        return true;
      }
      if (visibility === "visible") {
        for (const object of plan.objects) batch.changedObjectIds.add(object.objectId);
        for (const command of plan.diagramCommands) {
          batch.changedDiagramIds.add(
            command.type === "diagram.create" ? command.diagram.id : command.diagramId,
          );
        }
        batch.acknowledgedVersion = Math.max(batch.acknowledgedVersion, queuedVersion);
        await this.acknowledge(
          plan,
          authoritative,
          true,
          batch,
          this.isFinalAcknowledgement(batch, queuedVersion),
        );
        const release = this.releaseFinalCohortIfAcknowledged(batch);
        if (release) await release;
        return true;
      }
      if (!(await this.waitForRecoveryRetry())) return true;
    }
    return true;
  }

  private replayVisibility(
    plan: ExecutionPlan,
    room: RoomState,
    committedRoomRevision: number | null,
  ): "pending" | "visible" | "incompatible" {
    if (
      committedRoomRevision !== null &&
      room.roomRevision < committedRoomRevision
    ) {
      return "pending";
    }
    for (const object of plan.objects) {
      const current = room.objects[object.objectId];
      if (object.mode === "delete" || object.mode === "delete-noop") {
        if (!current) continue;
        if (
          object.expectedCreatedAt !== null &&
          current.createdAt !== object.expectedCreatedAt
        ) {
          return "incompatible";
        }
        return "pending";
      }
      if (object.mode === "create") {
        if (!current) return "pending";
        continue;
      }
      if (!current) return "pending";
      if (
        object.expectedCreatedAt !== null &&
        current.createdAt !== object.expectedCreatedAt
      ) {
        return "incompatible";
      }
      if (
        object.mode === "update" &&
        object.expectedRevision !== null &&
        current.revision <= object.expectedRevision
      ) {
        return "pending";
      }
    }
    return "visible";
  }

  private recoverConfirmed(
    objectIdsInput: readonly string[],
    error: unknown,
    cancellation: SemanticCanvasSyncCancelIntent | null,
    cohortId: string,
  ): Promise<void> {
    const scope = this.recoveryScope(objectIdsInput, cohortId);
    const existingGroups = new Set(
      scope.objectIds.flatMap((objectId) => {
        const group = this.recoveryByObjectId.get(objectId);
        return group ? [group] : [];
      }),
    );
    const collecting = existingGroups.size === 1
      ? [...existingGroups][0]
      : null;
    if (collecting?.phase === "collecting") {
      this.extendRecoveryGroup(collecting, scope.objectIds, scope.cohortIds);
      this.rememberRecoveryCause(collecting, cohortId, error, cancellation);
      return collecting.promise;
    }

    // A recovery already projecting authority cannot be widened without
    // creating a partial frame. Its covered IDs are already fenced; any truly
    // uncovered IDs receive a follow-up recovery after those predecessors.
    const predecessors = [...existingGroups].map((group) => group.promise);
    const uncovered = scope.objectIds.filter((objectId) => !this.recoveryByObjectId.has(objectId));
    if (!uncovered.length && existingGroups.size) {
      const existing = [...existingGroups][0];
      this.rememberRecoveryCause(existing, cohortId, error, cancellation);
      return Promise.allSettled(predecessors).then(() => undefined);
    }

    const group: ActiveRecoveryGroup = {
      phase: "collecting",
      objectIds: new Set<string>(),
      cohortIds: new Set<string>(),
      cancellationsByCohort: new Map(),
      primaryCohortId: cohortId,
      error,
      hasConfirmedFailure: false,
      promise: Promise.resolve(),
    };
    this.extendRecoveryGroup(group, uncovered, scope.cohortIds);
    this.rememberRecoveryCause(group, cohortId, error, cancellation);
    group.promise = (async () => {
      if (predecessors.length) await Promise.allSettled(predecessors);
      if (this.disposed) return;
      await this.performRecovery(group);
    })();
    for (const objectId of group.objectIds) this.recoveryByObjectId.set(objectId, group);
    const cleanup = () => {
      group.phase = "settled";
      for (const objectId of group.objectIds) {
        if (this.recoveryByObjectId.get(objectId) === group) {
          this.recoveryByObjectId.delete(objectId);
        }
      }
    };
    void group.promise.then(cleanup, cleanup);
    return group.promise;
  }

  private extendRecoveryGroup(
    group: ActiveRecoveryGroup,
    objectIds: readonly string[],
    cohortIds: readonly string[],
  ): void {
    const newlyCovered = objectIds.filter((objectId) => !group.objectIds.has(objectId));
    for (const objectId of newlyCovered) group.objectIds.add(objectId);
    for (const relatedCohortId of cohortIds) group.cohortIds.add(relatedCohortId);
    this.fenceRecovery(newlyCovered);
    for (const objectId of newlyCovered) this.recoveryByObjectId.set(objectId, group);
  }

  private rememberRecoveryCause(
    group: ActiveRecoveryGroup,
    cohortId: string,
    error: unknown,
    cancellation: SemanticCanvasSyncCancelIntent | null,
  ): void {
    if (cancellation) this.cancellationRecoveryCohortIds.add(cohortId);
    if (cancellation) group.cancellationsByCohort.set(cohortId, cancellation);
    if (
      !cancellation &&
      !this.cancellationRecoveryCohortIds.has(cohortId) &&
      !this.failureReportedCohortIds.has(cohortId)
    ) {
      if (!group.hasConfirmedFailure) group.error = error;
      group.hasConfirmedFailure = true;
      this.failureReportedCohortIds.add(cohortId);
      // Error presentation is deliberately independent from the recovery
      // network loop. A host callback must never make authority recovery fail.
      try {
        this.host.onFailureConfirmed(error);
      } catch {
        // Recovery remains mandatory even if a presentation host misbehaves.
      }
    }
  }

  private fenceRecovery(objectIds: readonly string[]): void {
    if (!objectIds.length) return;
    for (const batch of this.batches.values()) {
      if ([...batch.objectIds].some((objectId) => objectIds.includes(objectId))) {
        this.clearBatchTimer(batch);
      }
    }
    for (const objectId of objectIds) this.coordinator.beginRecovery(objectId);
  }

  private async performRecovery(group: ActiveRecoveryGroup): Promise<void> {
      let authoritative: RoomState;
      while (true) {
        if (this.disposed) return;
        try {
          const refreshed = await this.host.refresh();
          if (this.disposed) return;
          if (refreshed.id !== this.host.currentRoom().id) {
            if (!(await this.waitForRecoveryRetry())) return;
            continue;
          }
          authoritative = this.host.acceptRoom(refreshed);
          break;
        } catch {
          if (!(await this.waitForRecoveryRetry())) return;
        }
      }
      if (this.disposed) return;
      group.phase = "projecting";
      const recoveryObjectIds = sortedUnique(group.objectIds);
      const cohortIds = sortedUnique(group.cohortIds);
      const gestureIdsByCohort = new Map(
        cohortIds.map((cohortId) => [cohortId, this.gestureIdByCohort.get(cohortId) ?? null]),
      );
      const primaryGestureId = gestureIdsByCohort.get(group.primaryCohortId) ?? null;
      const primaryCancellation = group.cancellationsByCohort.get(group.primaryCohortId) ?? null;
      const rollbackReason = group.hasConfirmedFailure ? "confirmed-failure" : "cancelled";
      if (recoveryObjectIds.length) {
        await this.host.onRollback({
          room: authoritative!,
          objectIds: recoveryObjectIds,
          gestureId: primaryGestureId,
          error: group.error,
          reason: rollbackReason,
          cancellationToken: rollbackReason === "cancelled" ? primaryCancellation?.token ?? null : null,
        });
      }
      if (this.disposed) return;
      await Promise.all(cohortIds.map((cohortId) => this.releaseRecoveryCohort(cohortId)));
      if (this.disposed) return;
      for (const objectId of recoveryObjectIds) {
        const identity = roomObjectIdentity(authoritative!, objectId);
        this.coordinator.completeRecovery(
          objectId,
          identity.revision,
          identity.createdAt,
        );
        this.latestEdits.delete(objectId);
      }
      const authoritativeObjects = recoveryObjectIds.map((objectId) => ({
          objectId,
          ...roomObjectIdentity(authoritative!, objectId),
      }));
      for (const cohortId of cohortIds) {
        const cancellation = group.cancellationsByCohort.get(cohortId);
        await this.host.onRecoverySettled({
          gestureId: gestureIdsByCohort.get(cohortId) ?? null,
          authoritative: authoritativeObjects,
          reason:
            !group.hasConfirmedFailure && cancellation
              ? "cancelled"
              : "confirmed-failure",
        });
      }
      for (const objectId of recoveryObjectIds) this.coordinator.prune(objectId);
  }

  private async releaseRecoveryCohort(cohortId: string): Promise<void> {
    await this.host.releaseLeaseCohort(cohortId).catch(() => undefined);
    this.activeCohortIds.delete(cohortId);
    this.leaseTargetsByCohort.delete(cohortId);
    this.diagramRestorationsByCohort.delete(cohortId);
    this.gestureIdByCohort.delete(cohortId);
    this.failureReportedCohortIds.delete(cohortId);
    this.cancellationRecoveryCohortIds.delete(cohortId);
    for (const [batchKey, batch] of this.batches) {
      if (batch.cohortId === cohortId) this.batches.delete(batchKey);
    }
  }

  private waitForRecoveryRetry(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer = 0;
      const finish = () => {
        this.delayResolvers.delete(timer);
        resolve(!this.disposed);
      };
      timer = this.clock.setTimeout(finish, SEMANTIC_EDIT_RECOVERY_RETRY_MS);
      this.delayResolvers.set(timer, finish);
    });
  }
}

export class SemanticEditAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticEditAuthorityError";
  }
}

export class SemanticEditCancellationError extends Error {
  constructor(readonly reason: SemanticCanvasSyncCancelIntent["reason"]) {
    super("The semantic text edit was cancelled and requires authoritative recovery.");
    this.name = "SemanticEditCancellationError";
  }
}
