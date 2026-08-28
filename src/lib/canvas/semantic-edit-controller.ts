import type {
  ActorKind,
  ActorRef,
  CanvasCommand,
  CanvasObject,
  CreateCanvasObject,
  NodeMetadata,
  ObjectLease,
  Participant,
  RoomState,
  SemanticTransaction,
} from "@/lib/domain/types";

import type { SemanticCanvasEditEvent, SemanticCanvasEditIntent, PendingSemanticCanvasEdit } from "./semantic-edit-events";
import { SemanticCanvasEditLifecycleController } from "./semantic-edit-lifecycle";
import {
  SEMANTIC_EDIT_DEBOUNCE_MS,
  SemanticCanvasEditPersistenceDriver,
  type SemanticEditPersistenceErrorClassification,
  type SemanticEditPersistenceRollbackEvent,
  type SemanticEditPersistenceClock,
} from "./semantic-edit-persistence";
import {
  SemanticHistorySessionEngine,
  SemanticHistorySessionError,
  type SemanticHistoryReplayToken,
  type SemanticHistoryStageToken,
  type SemanticHistoryState,
} from "./semantic-history-session";
import {
  SemanticLeaseCohortManager,
  type SemanticLeaseAction,
  type SemanticLeaseBatchAction,
} from "./semantic-lease-manager";
import { SemanticLocalDocumentStore } from "./semantic-local-document";
import { CanvasObjectSyncCoordinator } from "./sync-coordinator";

type CommandResult = Readonly<{ room: RoomState; changedObjectIds: readonly string[] }>;
type TransactionResult = CommandResult & Readonly<{ changedDiagramIds?: readonly string[] }>;
type LeaseResult = Readonly<{ lease: ObjectLease | null; room: RoomState }>;
type LeaseBatchResult = Readonly<{ leases: readonly ObjectLease[]; room: RoomState }>;

export type SemanticEditControllerRollback = Readonly<{
  gestureId: string | null;
  objectIds: readonly string[];
  error: unknown;
  reason: "confirmed-failure" | "cancelled";
}>;

/** Structurally compatible with SemanticCanvasEditingHost without importing React-facing code. */
export type SemanticEditControllerHost = Readonly<{
  command(command: CanvasCommand, actorKind?: ActorKind): Promise<CommandResult>;
  semanticTransaction(transaction: SemanticTransaction): Promise<TransactionResult>;
  lease(action: SemanticLeaseAction, actorKind?: ActorKind): Promise<LeaseResult>;
  leaseMany(action: SemanticLeaseBatchAction, actorKind?: ActorKind): Promise<LeaseBatchResult>;
  refresh(): Promise<RoomState>;
  onError(message: string, details?: unknown): void;
  /** Stops any renderer-local move/text engine after authoritative pixels are installed. */
  onRollback?(rollback: SemanticEditControllerRollback): void;
}>;

export type SemanticEditControllerOptions = Readonly<{
  room: RoomState;
  self: Participant;
  host: SemanticEditControllerHost;
  now?: () => number;
  persistenceClock?: SemanticEditPersistenceClock;
  /** Must invoke callback after one renderer commit boundary and may return a cancellation function. */
  scheduleRenderSettle?: (callback: () => void) => void | (() => void);
  onRollback?: (rollback: SemanticEditControllerRollback) => void;
}>;

type ApiLikeFailure = Readonly<{
  code?: unknown;
  message?: unknown;
  details?: unknown;
}>;

function apiLikeFailure(error: unknown): ApiLikeFailure | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; details?: unknown; failure?: unknown };
  if (candidate.failure && typeof candidate.failure === "object") {
    return candidate.failure as ApiLikeFailure;
  }
  return candidate;
}

function errorCode(error: unknown): string | null {
  const code = apiLikeFailure(error)?.code;
  return typeof code === "string" ? code : null;
}

function failureDetails(error: unknown): Record<string, unknown> | null {
  const details = apiLikeFailure(error)?.details;
  return details && typeof details === "object" ? details as Record<string, unknown> : null;
}

/** API-client independent classification shared by command replay and lease renewal. */
export function classifySemanticEditError(
  error: unknown,
): SemanticEditPersistenceErrorClassification {
  const details = failureDetails(error);
  if (errorCode(error) === "MUTATION_OUTCOME_UNKNOWN" && details?.replayed === true) {
    return {
      kind: "committed-replay",
      committedRoomRevision:
        typeof details.committedRoomRevision === "number"
          ? details.committedRoomRevision
          : null,
    };
  }
  return { kind: "confirmed-failure" };
}

export function isSemanticLeaseNotFound(error: unknown): boolean {
  return errorCode(error) === "LEASE_NOT_FOUND";
}

function defaultRenderSettle(callback: () => void): () => void {
  if (typeof globalThis.requestAnimationFrame === "function") {
    const handle = globalThis.requestAnimationFrame(callback);
    return () => globalThis.cancelAnimationFrame(handle);
  }
  const handle = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(handle);
}

function humanActor(self: Participant): ActorRef {
  return {
    participantId: self.participantId,
    displayName: self.displayName,
    color: self.color,
    kind: "human",
  };
}

function resolvedShapeMetadata(
  existing: CanvasObject,
  draft: CreateCanvasObject,
): NodeMetadata | null | undefined {
  if (existing.kind !== "shape" || draft.kind !== "shape") return undefined;
  if (!("nodeMetadata" in draft) || draft.nodeMetadata === undefined) {
    return existing.nodeMetadata;
  }
  if (draft.nodeMetadata === null) return null;
  const existingMetadata = existing.nodeMetadata;
  const metadataUnchanged =
    existingMetadata?.kind === draft.nodeMetadata.kind &&
    existingMetadata.status === draft.nodeMetadata.status &&
    existingMetadata.owner === draft.nodeMetadata.owner &&
    existingMetadata.resolution === draft.nodeMetadata.resolution;
  return {
    ...draft.nodeMetadata,
    resolvedAt: metadataUnchanged ? existingMetadata.resolvedAt : null,
  };
}

function optimisticObject(
  edit: Exclude<PendingSemanticCanvasEdit, { kind: "delete" }>,
  projectedRoom: RoomState,
  actor: ActorRef,
  now: number,
): CanvasObject {
  const existing = projectedRoom.objects[edit.objectId];
  if (!existing) {
    return {
      ...edit.draft,
      revision: 0,
      diagramIds: [],
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      lastEditedBy: actor,
      ...(edit.draft.kind === "shape" && edit.draft.nodeMetadata
        ? { nodeMetadata: { ...edit.draft.nodeMetadata, resolvedAt: null } }
        : {}),
    } as CanvasObject;
  }
  if (existing.kind !== edit.draft.kind) {
    throw new Error(`Canvas object ${edit.objectId} cannot change kind optimistically.`);
  }

  const next = {
    ...existing,
    ...edit.draft,
    id: existing.id,
    kind: existing.kind,
    revision: existing.revision,
    diagramIds: existing.diagramIds,
    createdAt: existing.createdAt,
    updatedAt: now,
    createdBy: existing.createdBy,
    lastEditedBy: actor,
  } as CanvasObject;
  if (next.kind === "shape" && existing.kind === "shape" && edit.draft.kind === "shape") {
    next.nodeMetadata = resolvedShapeMetadata(existing, edit.draft) as typeof next.nodeMetadata;
  }
  return next;
}

function rollbackMessage(error: unknown): string {
  const failureMessage = apiLikeFailure(error)?.message;
  if (typeof failureMessage === "string" && failureMessage.trim()) {
    return failureMessage;
  }
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }
  return "The canvas change could not be saved. Jazzboard is checking the latest version.";
}

/**
 * Pure renderer-neutral composition root for first-party canvas editing.
 * Local pixels are installed in the same call stack as lifecycle dispatch;
 * persistence callbacks can only remove the exact generation they settled.
 */
export class SemanticCanvasEditController {
  private readonly coordinator = new CanvasObjectSyncCoordinator();
  private readonly lifecycle = new SemanticCanvasEditLifecycleController(this.coordinator);
  private readonly store: SemanticLocalDocumentStore;
  private readonly leaseManager: SemanticLeaseCohortManager;
  private readonly persistence: SemanticCanvasEditPersistenceDriver;
  private readonly history: SemanticHistorySessionEngine;
  private readonly actor: ActorRef;
  private readonly now: () => number;
  private readonly host: SemanticEditControllerHost;
  private readonly rollbackCallback: SemanticEditControllerHost["onRollback"];
  private readonly scheduleRenderSettle: NonNullable<SemanticEditControllerOptions["scheduleRenderSettle"]>;
  private readonly hasCustomRenderSettle: boolean;
  private readonly settleCancellations = new Map<string, () => void>();
  private readonly cancellationTokens = new Map<string, { gestureId: string; lifecycle: number }>();
  private readonly objectIdsByGesture = new Map<string, Set<string>>();
  private readonly rollbackNotifiedGestures = new Set<string>();
  private readonly historyStagesByGesture = new Map<string, SemanticHistoryStageToken>();
  private readonly historyReplaysByGesture = new Map<string, SemanticHistoryReplayToken>();
  private disposed = false;

  constructor(options: SemanticEditControllerOptions) {
    this.host = options.host;
    this.rollbackCallback = options.onRollback ?? options.host.onRollback;
    this.actor = humanActor(options.self);
    this.now = options.now ?? Date.now;
    this.hasCustomRenderSettle = Boolean(options.scheduleRenderSettle);
    this.scheduleRenderSettle = options.scheduleRenderSettle ?? defaultRenderSettle;
    this.store = new SemanticLocalDocumentStore(options.room);
    this.history = new SemanticHistorySessionEngine({ roomId: options.room.id });

    this.leaseManager = new SemanticLeaseCohortManager({
      coordinator: this.coordinator,
      lease: (action) => this.host.lease(action, "human"),
      leaseMany: (action) => this.host.leaseMany(action, "human"),
      onRoom: (room) => {
        if (!this.disposed) this.store.acceptAuthoritative(room);
      },
      isLeaseNotFound: isSemanticLeaseNotFound,
      onCohortRecovery: (recovery) => {
        if (!this.disposed) void this.persistence.recoverLeaseCohort(recovery);
      },
    });

    this.persistence = new SemanticCanvasEditPersistenceDriver(
      this.coordinator,
      {
        currentRoom: () => this.store.getAuthoritativeRoom(),
        ensureLeaseCohort: (input) => this.leaseManager.ensureCohort(input),
        releaseLeaseCohort: (cohortId) => this.leaseManager.releaseCohort(cohortId),
        command: (command) => this.host.command(command, "human"),
        semanticTransaction: (transaction) => this.host.semanticTransaction(transaction),
        refresh: () => this.host.refresh(),
        acceptRoom: (room) => this.acceptRoom(room),
        classifyError: classifySemanticEditError,
        onFailureConfirmed: (error) => {
          if (!this.disposed) this.host.onError(rollbackMessage(error), error);
        },
        onAcknowledged: (event) => {
          if (this.disposed) return;
          // Persistence has already accepted event.room. Exact fences prevent
          // an N acknowledgement from clearing optimistic generation N+1.
          for (const acknowledgement of event.acknowledgements) {
            const override = this.store.getOverride(acknowledgement.objectId);
            if (
              acknowledgement.latestGenerationSettled &&
              override?.generation === acknowledgement.generation
            ) {
              this.store.clearAcknowledged(acknowledgement.objectId, {
                generation: override.generation,
                recoveryEpoch: override.recoveryEpoch,
              });
            }
            this.lifecycle.clearPendingEdit(
              acknowledgement.objectId,
              acknowledgement.generation,
            );
          }
          if (event.final && event.gestureId) {
            const replay = this.historyReplaysByGesture.get(event.gestureId);
            if (replay) {
              this.historyReplaysByGesture.delete(event.gestureId);
              try {
                this.history.acknowledgeReplay(replay, event.room);
              } catch (error) {
                this.host.onError("The history replay did not match authoritative canvas state.", error);
              }
            } else {
              const stage = this.historyStagesByGesture.get(event.gestureId);
              if (stage) {
                this.historyStagesByGesture.delete(event.gestureId);
                try {
                  this.history.acknowledgeHumanTransaction({
                    token: stage,
                    room: event.room,
                    changedObjectIds: event.changedObjectIds,
                    changedDiagramIds: event.changedDiagramIds,
                  });
                } catch (error) {
                  this.host.onError("The completed canvas edit could not be added to history.", error);
                }
              }
            }
          }
          this.pruneAcknowledgedGestureTracking();
        },
        onRollback: (event) => this.handleRollback(event),
        onRecoverySettled: (event) => {
          if (this.disposed || !event.gestureId) return;
          // A fully-overlapped recovery may have no unique objects and thus no
          // onRollback callback. Settlement is still terminal for its history
          // transaction and must reject it idempotently.
          this.rejectHistoryForGesture(event.gestureId);
          if (!this.rollbackNotifiedGestures.has(event.gestureId)) {
            // Overlapping cohorts may coalesce authority recovery so this
            // gesture has no unique rollback object. It still owns a renderer
            // engine that must be stopped before lifecycle cleanup.
            this.rollbackCallback?.({
              gestureId: event.gestureId,
              objectIds: event.authoritative.map((object) => object.objectId),
              error: undefined,
              reason: event.reason,
            });
          }
          this.rollbackNotifiedGestures.delete(event.gestureId);
          this.objectIdsByGesture.delete(event.gestureId);
          if (event.reason === "cancelled") {
            const token = this.cancellationTokens.get(event.gestureId);
            this.cancellationTokens.delete(event.gestureId);
            if (token) {
              this.dispatchLifecycleOnly({
                type: "gesture.cancellation-settled",
                token,
                authoritative: event.authoritative,
              });
            }
            return;
          }
          this.dispatchLifecycleOnly({
            type: "gesture.recovery-settled",
            gestureId: event.gestureId,
            authoritative: event.authoritative,
          });
        },
      },
      options.persistenceClock,
    );
  }

  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  getSnapshot = (): RoomState => this.store.getSnapshot();

  getAuthoritativeRoom(): RoomState {
    return this.store.getAuthoritativeRoom();
  }

  historyState(): SemanticHistoryState {
    return this.history.getState();
  }

  /**
   * Starts an acknowledgement-gated undo. Optimistic replay pixels are
   * installed before this method returns; the history stacks move only after
   * the final authoritative persistence acknowledgement.
   */
  async undo(): Promise<boolean> {
    return this.replayHistory("undo");
  }

  /** Same contract as undo, targeting the redo stack. */
  async redo(): Promise<boolean> {
    return this.replayHistory("redo");
  }

  acceptRoom(room: RoomState): RoomState {
    if (!this.disposed) this.store.acceptAuthoritative(room);
    return this.store.getAuthoritativeRoom();
  }

  /** Includes implicit protected connectors whose route follows optimistic nodes. */
  optimisticConnectorIds(): ReadonlySet<string> {
    if (this.disposed) return new Set();
    const room = this.store.getSnapshot();
    return new Set(
      [...this.coordinator.protectedObjectIds()].filter(
        (objectId) => room.objects[objectId]?.kind === "connector",
      ),
    );
  }

  /**
   * True only when the renderer is showing the exact authoritative object and
   * no protected dependency is deriving different pixels from local state.
   */
  isProjectionAuthoritative(objectId: string): boolean {
    if (this.disposed || this.coordinator.protectedObjectIds().has(objectId)) return false;
    return (
      this.store.getSnapshot().objects[objectId] ===
      this.store.getAuthoritativeRoom().objects[objectId]
    );
  }

  dispatch(event: SemanticCanvasEditEvent): readonly SemanticCanvasEditIntent[] {
    if (this.disposed) return [];
    if (event.type === "gesture.settled") {
      this.cancelSettle(event.token.gestureId, event.token.lifecycle);
    }
    return this.dispatchLifecycleOnly(event);
  }

  async whenIdle(): Promise<void> {
    await this.persistence.whenIdle();
  }

  /**
   * Drain local persistence, refresh authority, and prove the requested scope
   * is no longer an optimistic projection before it is handed to another
   * actor. This is the authoritative boundary used by Ask and similar reads.
   */
  async flushAndDrain(objectIds: readonly string[]): Promise<RoomState> {
    await this.persistence.whenIdle();
    if (this.disposed) return this.store.getAuthoritativeRoom();

    const refreshed = await this.host.refresh();
    if (this.disposed) return this.store.getAuthoritativeRoom();
    this.acceptRoom(refreshed);

    // Work may have started while refresh was in flight. Its command response
    // is itself authoritative, so one more complete drain is sufficient.
    await this.persistence.whenIdle();
    if (this.disposed) return this.store.getAuthoritativeRoom();

    const unresolved = [...new Set(objectIds)].filter(
      (objectId) => !this.isProjectionAuthoritative(objectId),
    );
    if (unresolved.length) {
      throw new Error(
        `Canvas objects are still being saved: ${unresolved.join(", ")}.`,
      );
    }
    return this.store.getAuthoritativeRoom();
  }

  dispose(): void {
    if (this.disposed) return;
    for (const cancel of this.settleCancellations.values()) cancel();
    this.settleCancellations.clear();
    // Queue the newest debounced generation before fencing this controller.
    // The persistence driver owns one best-effort drain; late authority and
    // failure callbacks observe `disposed` and cannot repaint or notify UI.
    const shutdown = this.persistence.flushPendingForShutdown();
    this.disposed = true;
    this.cancellationTokens.clear();
    this.objectIdsByGesture.clear();
    this.rollbackNotifiedGestures.clear();
    this.historyStagesByGesture.clear();
    this.historyReplaysByGesture.clear();
    this.store.dispose();
    void shutdown.finally(() => {
      this.persistence.dispose();
      void this.leaseManager.dispose();
    });
  }

  private dispatchLifecycleOnly(
    event: SemanticCanvasEditEvent,
  ): readonly SemanticCanvasEditIntent[] {
    if (this.disposed) return [];
    if (event.type === "gesture.started" && event.source === "pointer") {
      const pendingKeyboardGestures = new Set<string>();
      const overlappingObjectIds: string[] = [];
      for (const object of event.objects) {
        const pending = this.lifecycle.getPendingEdit(object.objectId);
        if (!pending?.gestureId?.startsWith("semantic-keyboard:")) continue;
        pendingKeyboardGestures.add(pending.gestureId);
        overlappingObjectIds.push(object.objectId);
      }
      if (pendingKeyboardGestures.size) {
        this.persistence.absorbPendingGestureObjects({
          fromGestureIds: pendingKeyboardGestures,
          objectIds: overlappingObjectIds,
        });
      }
    }
    const staged = this.stageHistoryBeforeOptimisticChange(event);
    try {
      this.rememberGestureObjects(event);
      const intents = this.lifecycle.dispatch(event);
      for (const intent of intents) this.consumeIntent(intent);
      return intents;
    } catch (error) {
      if (staged) {
        this.historyStagesByGesture.delete(staged.transactionId);
        this.history.rejectHumanTransaction(staged);
      }
      throw error;
    }
  }

  private consumeIntent(intent: SemanticCanvasEditIntent): void {
    if (this.disposed) return;
    if (intent.type === "sync.schedule" || intent.type === "sync.flush") {
      this.applyOptimisticEdits(intent.edits);
    } else if (intent.type === "sync.cancel") {
      this.cancellationTokens.set(intent.gestureId, intent.token);
    } else if (intent.type === "gesture.settle") {
      this.scheduleSettlement(intent);
    }
    this.persistence.consume(intent);
  }

  private applyOptimisticEdits(edits: readonly PendingSemanticCanvasEdit[]): void {
    for (const edit of edits) {
      if (this.disposed) return;
      const fence = { generation: edit.generation, recoveryEpoch: edit.recoveryEpoch };
      if (edit.kind === "delete") {
        this.store.applyOverride({ kind: "delete", objectId: edit.objectId, ...fence });
        continue;
      }
      this.store.applyOverride({
        kind: "upsert",
        object: optimisticObject(edit, this.store.getSnapshot(), this.actor, this.now()),
        ...fence,
      });
    }
  }

  private scheduleSettlement(intent: Extract<SemanticCanvasEditIntent, { type: "gesture.settle" }>): void {
    const key = `${intent.token.gestureId}:${intent.token.lifecycle}`;
    this.settleCancellations.get(key)?.();
    let active = true;
    const callback = () => {
      if (!active || this.disposed) return;
      active = false;
      this.settleCancellations.delete(key);
      this.dispatchLifecycleOnly({ type: "gesture.settled", token: intent.token });
    };
    const scheduled = intent.source === "keyboard"
      && intent.reason === "keyboard-idle"
      && !this.hasCustomRenderSettle
      ? (() => {
          const handle = globalThis.setTimeout(callback, SEMANTIC_EDIT_DEBOUNCE_MS);
          return () => globalThis.clearTimeout(handle);
        })()
      : this.scheduleRenderSettle(callback);
    const cancel = () => {
      if (!active) return;
      active = false;
      if (typeof scheduled === "function") scheduled();
    };
    this.settleCancellations.set(key, cancel);
  }

  private cancelSettle(gestureId: string, lifecycle: number): void {
    const key = `${gestureId}:${lifecycle}`;
    this.settleCancellations.get(key)?.();
    this.settleCancellations.delete(key);
  }

  private handleRollback(event: SemanticEditPersistenceRollbackEvent): void {
    if (this.disposed) return;
    // Install authority and remove optimistic pixels before notifying renderer
    // engines. The save error itself was already reported when recovery began;
    // do not emit a second toast after refresh eventually succeeds.
    this.store.forceRecover(event.room, event.objectIds);
    const affectedGestureIds = new Set(event.gestureId ? [event.gestureId] : []);
    for (const [gestureId, objectIds] of this.objectIdsByGesture) {
      if (event.objectIds.some((objectId) => objectIds.has(objectId))) {
        affectedGestureIds.add(gestureId);
      }
    }
    for (const gestureId of affectedGestureIds) {
      this.rejectHistoryForGesture(gestureId);
      // Persistence emits one atomic rollback for the transitive cohort, then
      // settles every invalidated gesture. Mark all of them now so those later
      // settlements cannot trigger a second renderer callback/frame.
      this.rollbackNotifiedGestures.add(gestureId);
    }
    this.rollbackCallback?.({
      gestureId: event.gestureId,
      objectIds: event.objectIds,
      error: event.error,
      reason: event.reason,
    });
  }

  private stageHistoryBeforeOptimisticChange(
    event: SemanticCanvasEditEvent,
  ): SemanticHistoryStageToken | null {
    if (event.type !== "objects.changed" || !event.gestureId || !event.changes.length) return null;
    if (
      this.historyReplaysByGesture.has(event.gestureId) ||
      this.historyStagesByGesture.has(event.gestureId)
    ) return null;
    const tracked = this.objectIdsByGesture.get(event.gestureId) ?? new Set<string>();
    const changed = event.changes.map((change) =>
      change.kind === "delete" ? change.objectId : change.draft.id
    );
    const token = this.history.stageHumanTransaction({
      transactionId: event.gestureId,
      room: this.store.getAuthoritativeRoom(),
      objectIds: [...tracked, ...changed],
    });
    this.historyStagesByGesture.set(event.gestureId, token);
    return token;
  }

  private rejectHistoryForGesture(gestureId: string): void {
    const stage = this.historyStagesByGesture.get(gestureId);
    if (stage) {
      this.historyStagesByGesture.delete(gestureId);
      this.history.rejectHumanTransaction(stage);
    }
    const replay = this.historyReplaysByGesture.get(gestureId);
    if (replay) {
      this.historyReplaysByGesture.delete(gestureId);
      this.history.rejectReplay(replay);
    }
  }

  private async replayHistory(direction: "undo" | "redo"): Promise<boolean> {
    if (this.disposed) return false;
    const room = this.store.getAuthoritativeRoom();
    const replay = direction === "undo"
      ? this.history.prepareUndo(room)
      : this.history.prepareRedo(room);
    if (!replay) return false;

    try {
      const unsupportedDelete = replay.diagramRestorations.find(
        (restoration) => restoration.target === null,
      );
      if (unsupportedDelete) {
        throw new SemanticHistorySessionError(
          "STALE_REPLAY",
          `Diagram ${unsupportedDelete.diagramId} cannot be removed by canvas history.`,
        );
      }
      if (replay.diagramRestorations.length && replay.events.length === 0) {
        throw new SemanticHistorySessionError(
          "STALE_REPLAY",
          "Diagram-only history replay is not a canvas gesture.",
        );
      }
      if (replay.isNoop) {
        this.history.acknowledgeReplay(replay.token, room);
        return true;
      }

      this.historyReplaysByGesture.set(replay.token.replayId, replay.token);
      this.persistence.registerDiagramRestorations(
        replay.token.replayId,
        replay.diagramRestorations.map((restoration) => ({
          diagramId: restoration.diagramId,
          target: restoration.target!,
        })),
      );
      for (const event of replay.events) this.dispatchLifecycleOnly(event);
      return true;
    } catch (error) {
      this.historyReplaysByGesture.delete(replay.token.replayId);
      this.persistence.unregisterDiagramRestorations(replay.token.replayId);
      this.history.rejectReplay(replay.token);
      throw error;
    }
  }

  private rememberGestureObjects(event: SemanticCanvasEditEvent): void {
    if (event.type === "gesture.started" || event.type === "gesture.dependencies-added") {
      const objectIds = this.objectIdsByGesture.get(event.gestureId) ?? new Set<string>();
      for (const object of event.objects) objectIds.add(object.objectId);
      this.objectIdsByGesture.set(event.gestureId, objectIds);
      return;
    }
    if (event.type === "objects.changed" && event.gestureId) {
      const objectIds = this.objectIdsByGesture.get(event.gestureId) ?? new Set<string>();
      for (const change of event.changes) {
        objectIds.add(change.kind === "delete" ? change.objectId : change.draft.id);
      }
      this.objectIdsByGesture.set(event.gestureId, objectIds);
    }
  }

  private pruneAcknowledgedGestureTracking(): void {
    for (const [gestureId, objectIds] of this.objectIdsByGesture) {
      const settled = [...objectIds].every((objectId) => {
        const entry = this.coordinator.get(objectId);
        return !this.lifecycle.getPendingEdit(objectId) && (!entry || !this.coordinator.isProtected(entry));
      });
      if (settled) {
        this.objectIdsByGesture.delete(gestureId);
        this.rollbackNotifiedGestures.delete(gestureId);
      }
    }
  }
}
