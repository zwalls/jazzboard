import type {
  CanvasObject,
  Diagram,
  LeaseOperation,
  RoomState,
} from "@/lib/domain/types";

import type {
  SemanticCanvasEditEvent,
  SemanticCanvasGestureObject,
  SemanticCanvasObjectChange,
} from "./semantic-edit-events";
import { semanticCreateDraftFromObject } from "./semantic-keyboard-session";

export const DEFAULT_SEMANTIC_HISTORY_CAPACITY = 100;

export type SemanticHistoryErrorCode =
  | "ROOM_MISMATCH"
  | "DUPLICATE_TRANSACTION"
  | "UNKNOWN_TRANSACTION"
  | "BUSY"
  | "PENDING_HUMAN_TRANSACTION"
  | "EMPTY_HISTORY"
  | "STALE_REPLAY"
  | "HISTORY_CONFLICT"
  | "LOCKED_IMAGE"
  | "INVALID_CAPACITY";

export class SemanticHistorySessionError extends Error {
  constructor(
    readonly code: SemanticHistoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SemanticHistorySessionError";
  }
}

export type SemanticHistoryObjectSnapshotChange = Readonly<{
  objectId: string;
  before: CanvasObject | null;
  after: CanvasObject | null;
}>;

export type SemanticHistoryDiagramSnapshotChange = Readonly<{
  diagramId: string;
  before: Diagram | null;
  after: Diagram | null;
}>;

export type SemanticHistoryEntry = Readonly<{
  transactionId: string;
  roomId: string;
  sequence: number;
  objectChanges: readonly SemanticHistoryObjectSnapshotChange[];
  diagramChanges: readonly SemanticHistoryDiagramSnapshotChange[];
}>;

export type SemanticHistoryStageToken = Readonly<{
  transactionId: string;
  roomId: string;
  sequence: number;
}>;

export type SemanticHistoryReplayToken = Readonly<{
  replayId: string;
  attempt: number;
  roomId: string;
  direction: "undo" | "redo";
  transactionId: string;
  sequence: number;
}>;

/**
 * Diagram changes cannot cross SemanticCanvasEditLifecycle today. The host may
 * commit these snapshots through the semantic transaction path alongside the
 * emitted object events. A null target requires diagram-delete support, which
 * the current domain intentionally does not expose yet.
 */
export type SemanticHistoryDiagramRestoration = Readonly<{
  diagramId: string;
  current: Diagram | null;
  target: Diagram | null;
}>;

export type SemanticHistoryReplay = Readonly<{
  token: SemanticHistoryReplayToken;
  entry: SemanticHistoryEntry;
  events: readonly SemanticCanvasEditEvent[];
  diagramRestorations: readonly SemanticHistoryDiagramRestoration[];
  objectIds: readonly string[];
  isNoop: boolean;
}>;

export type SemanticHistoryState = Readonly<{
  roomId: string;
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
  pendingHumanTransactions: number;
  replayPending: boolean;
}>;

export type SemanticHistorySessionOptions = Readonly<{
  roomId: string;
  capacity?: number;
  replayIdFactory?: (input: Readonly<{
    roomId: string;
    transactionId: string;
    direction: "undo" | "redo";
    sequence: number;
    attempt: number;
  }>) => string;
}>;

export type StageSemanticHumanTransactionInput = Readonly<{
  transactionId: string;
  room: RoomState;
  objectIds: readonly string[];
  diagramIds?: readonly string[];
}>;

export type AcknowledgeSemanticHumanTransactionInput = Readonly<{
  token: SemanticHistoryStageToken;
  room: RoomState;
  /** Include server-discovered dependencies such as rerouted connectors. */
  changedObjectIds?: readonly string[];
  changedDiagramIds?: readonly string[];
}>;

type PendingHumanTransaction = {
  token: SemanticHistoryStageToken;
  requestedObjectIds: Set<string>;
  requestedDiagramIds: Set<string>;
  beforeObjects: Readonly<Record<string, CanvasObject>>;
  beforeDiagrams: Readonly<Record<string, Diagram>>;
};

type PendingReplay = {
  replay: SemanticHistoryReplay;
  targetObjects: ReadonlyMap<string, CanvasObject | null>;
  targetDiagrams: ReadonlyMap<string, Diagram | null>;
};

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function cloneFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function cloneObject(object: CanvasObject | null | undefined): CanvasObject | null {
  return object ? cloneFrozen(object) : null;
}

function cloneDiagram(diagram: Diagram | null | undefined): Diagram | null {
  return diagram ? cloneFrozen(diagram) : null;
}

function draftFingerprint(object: CanvasObject | null): string | null {
  return object ? JSON.stringify(semanticCreateDraftFromObject(object)) : null;
}

function diagramFingerprint(diagram: Diagram | null): string | null {
  if (!diagram) return null;
  return JSON.stringify({
    id: diagram.id,
    title: diagram.title,
    description: diagram.description,
    diagramType: diagram.diagramType,
    category: diagram.category,
    tags: diagram.tags,
    memberObjectIds: diagram.memberObjectIds,
    connectorIds: diagram.connectorIds,
  });
}

function objectSemanticsEqual(left: CanvasObject | null, right: CanvasObject | null): boolean {
  if (!left || !right) return left === right;
  return draftFingerprint(left) === draftFingerprint(right) &&
    JSON.stringify(left.diagramIds) === JSON.stringify(right.diagramIds);
}

function diagramSemanticsEqual(left: Diagram | null, right: Diagram | null): boolean {
  return diagramFingerprint(left) === diagramFingerprint(right);
}

function operationForUpdate(object: CanvasObject): Exclude<LeaseOperation, "delete"> {
  return object.kind === "connector" ? "connect" : "edit";
}

function gestureObjectForReplay(
  current: CanvasObject | undefined,
  target: CanvasObject | null,
): SemanticCanvasGestureObject | null {
  if (!current && !target) return null;
  if (!current) {
    return {
      objectId: target!.id,
      baseRevision: null,
      baseCreatedAt: null,
      operation: null,
    };
  }
  return {
    objectId: current.id,
    baseRevision: current.revision,
    baseCreatedAt: current.createdAt,
    operation: target ? operationForUpdate(current) : "delete",
  };
}

function changeForReplay(
  current: CanvasObject | undefined,
  target: CanvasObject | null,
): SemanticCanvasObjectChange | null {
  if (!current && !target) return null;
  if (!current) {
    return {
      kind: "create",
      draft: semanticCreateDraftFromObject(target!),
      baseRevision: null,
      baseCreatedAt: null,
    };
  }
  if (!target) {
    return {
      kind: "delete",
      objectId: current.id,
      baseRevision: current.revision,
      baseCreatedAt: current.createdAt,
      operation: "delete",
    };
  }
  if (current.kind !== target.kind) {
    throw new SemanticHistorySessionError(
      "STALE_REPLAY",
      `Canvas object ${current.id} changed kind and cannot be restored in place.`,
    );
  }
  return {
    kind: "update",
    draft: semanticCreateDraftFromObject(target),
    baseRevision: current.revision,
    baseCreatedAt: current.createdAt,
    operation: operationForUpdate(current),
  };
}

function assertLockedImageSafe(current: CanvasObject | undefined, target: CanvasObject | null): void {
  if (current?.kind !== "image" || !current.locked) return;
  if (target && objectSemanticsEqual(current, target)) return;
  throw new SemanticHistorySessionError(
    "LOCKED_IMAGE",
    `Locked image ${current.id} cannot be changed by undo or redo.`,
  );
}

function entryHasChanges(entry: SemanticHistoryEntry): boolean {
  return entry.objectChanges.length > 0 || entry.diagramChanges.length > 0;
}

function defaultReplayId(input: Readonly<{
  transactionId: string;
  direction: "undo" | "redo";
  sequence: number;
  attempt: number;
}>): string {
  return `history:${input.direction}:${input.sequence}:${input.attempt}:${input.transactionId}`;
}

/**
 * Renderer-neutral, acknowledgement-gated semantic history.
 *
 * The engine never observes transient renderer frames. A host stages the
 * authoritative pre-gesture room, then acknowledges with the authoritative
 * committed room and its changed IDs. Undo/redo only prepare lifecycle events;
 * stacks move after the host acknowledges that replay.
 */
export class SemanticHistorySessionEngine {
  private readonly capacity: number;
  private readonly replayIdFactory: NonNullable<SemanticHistorySessionOptions["replayIdFactory"]>;
  private readonly pendingTransactions = new Map<string, PendingHumanTransaction>();
  private readonly undoStack: SemanticHistoryEntry[] = [];
  private readonly redoStack: SemanticHistoryEntry[] = [];
  private sequence = 0;
  private replayAttempt = 0;
  private pendingReplay: PendingReplay | null = null;

  constructor(private readonly options: SemanticHistorySessionOptions) {
    const capacity = options.capacity ?? DEFAULT_SEMANTIC_HISTORY_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new SemanticHistorySessionError(
        "INVALID_CAPACITY",
        "Semantic history capacity must be a positive safe integer.",
      );
    }
    this.capacity = capacity;
    this.replayIdFactory = options.replayIdFactory ?? defaultReplayId;
  }

  getState(): SemanticHistoryState {
    return Object.freeze({
      roomId: this.options.roomId,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      pendingHumanTransactions: this.pendingTransactions.size,
      replayPending: this.pendingReplay !== null,
    });
  }

  /** Test/debug snapshot; entries are already deeply frozen. */
  entries(): Readonly<{ undo: readonly SemanticHistoryEntry[]; redo: readonly SemanticHistoryEntry[] }> {
    return Object.freeze({
      undo: Object.freeze([...this.undoStack]),
      redo: Object.freeze([...this.redoStack]),
    });
  }

  stageHumanTransaction(input: StageSemanticHumanTransactionInput): SemanticHistoryStageToken {
    this.assertRoom(input.room);
    if (this.pendingReplay) {
      throw new SemanticHistorySessionError("BUSY", "History replay is awaiting acknowledgement.");
    }
    if (this.pendingTransactions.has(input.transactionId) ||
      this.undoStack.some((entry) => entry.transactionId === input.transactionId) ||
      this.redoStack.some((entry) => entry.transactionId === input.transactionId)) {
      throw new SemanticHistorySessionError(
        "DUPLICATE_TRANSACTION",
        `History transaction ${input.transactionId} already exists.`,
      );
    }

    const token = deepFreeze({
      transactionId: input.transactionId,
      roomId: this.options.roomId,
      sequence: ++this.sequence,
    });
    this.pendingTransactions.set(input.transactionId, {
      token,
      requestedObjectIds: new Set(input.objectIds),
      requestedDiagramIds: new Set(input.diagramIds ?? []),
      // The authoritative acknowledgement may report implicit connector or
      // diagram dependencies that were not known at gesture start.
      beforeObjects: cloneFrozen(input.room.objects),
      beforeDiagrams: cloneFrozen(input.room.diagrams),
    });
    return token;
  }

  acknowledgeHumanTransaction(input: AcknowledgeSemanticHumanTransactionInput): SemanticHistoryEntry | null {
    this.assertTokenRoom(input.token);
    this.assertRoom(input.room);
    const pending = this.pendingTransactions.get(input.token.transactionId);
    if (!pending || pending.token.sequence !== input.token.sequence) {
      throw new SemanticHistorySessionError(
        "UNKNOWN_TRANSACTION",
        `History transaction ${input.token.transactionId} is not pending.`,
      );
    }
    this.pendingTransactions.delete(input.token.transactionId);

    const objectIds = sortedUnique([
      ...pending.requestedObjectIds,
      ...(input.changedObjectIds ?? []),
    ]);
    const objectChanges = objectIds.flatMap((objectId) => {
      const before = cloneObject(pending.beforeObjects[objectId]);
      const after = cloneObject(input.room.objects[objectId]);
      if (objectSemanticsEqual(before, after)) return [];
      return [deepFreeze({ objectId, before, after })];
    });

    const membershipDiagramIds = new Set<string>(pending.requestedDiagramIds);
    for (const objectId of objectIds) {
      for (const diagramId of pending.beforeObjects[objectId]?.diagramIds ?? []) {
        membershipDiagramIds.add(diagramId);
      }
      for (const diagramId of input.room.objects[objectId]?.diagramIds ?? []) {
        membershipDiagramIds.add(diagramId);
      }
    }
    for (const diagramId of input.changedDiagramIds ?? []) membershipDiagramIds.add(diagramId);
    const diagramChanges = sortedUnique(membershipDiagramIds).flatMap((diagramId) => {
      const before = cloneDiagram(pending.beforeDiagrams[diagramId]);
      const after = cloneDiagram(input.room.diagrams[diagramId]);
      if (diagramSemanticsEqual(before, after)) return [];
      return [deepFreeze({ diagramId, before, after })];
    });

    const entry = deepFreeze<SemanticHistoryEntry>({
      transactionId: input.token.transactionId,
      roomId: this.options.roomId,
      sequence: input.token.sequence,
      objectChanges: Object.freeze(objectChanges),
      diagramChanges: Object.freeze(diagramChanges),
    });
    if (!entryHasChanges(entry)) return null;

    // A following gesture can start before this one's response arrives. Its
    // before-image must advance to the predecessor's confirmed result, so undo
    // restores just that following gesture rather than both edits. Rebase only
    // pending, later transactions and preserve object incarnation boundaries.
    for (const following of this.pendingTransactions.values()) {
      if (following.token.sequence <= entry.sequence) continue;
      const beforeObjects = { ...following.beforeObjects };
      for (const change of entry.objectChanges) {
        const captured = beforeObjects[change.objectId] ?? null;
        if ((captured?.createdAt ?? null) !== (change.before?.createdAt ?? null)) continue;
        if (change.after) beforeObjects[change.objectId] = change.after;
        else delete beforeObjects[change.objectId];
      }
      following.beforeObjects = deepFreeze(beforeObjects);
      const beforeDiagrams = { ...following.beforeDiagrams };
      for (const change of entry.diagramChanges) {
        const captured = beforeDiagrams[change.diagramId] ?? null;
        if ((captured?.createdAt ?? null) !== (change.before?.createdAt ?? null)) continue;
        if (change.after) beforeDiagrams[change.diagramId] = change.after;
        else delete beforeDiagrams[change.diagramId];
      }
      following.beforeDiagrams = deepFreeze(beforeDiagrams);
    }

    this.redoStack.length = 0;
    const insertion = this.undoStack.findIndex((candidate) => candidate.sequence > entry.sequence);
    if (insertion === -1) this.undoStack.push(entry);
    else this.undoStack.splice(insertion, 0, entry);
    while (this.undoStack.length > this.capacity) this.undoStack.shift();
    return entry;
  }

  rejectHumanTransaction(token: SemanticHistoryStageToken): boolean {
    this.assertTokenRoom(token);
    const pending = this.pendingTransactions.get(token.transactionId);
    if (!pending || pending.token.sequence !== token.sequence) return false;
    this.pendingTransactions.delete(token.transactionId);
    return true;
  }

  prepareUndo(room: RoomState): SemanticHistoryReplay | null {
    return this.prepareReplay("undo", room);
  }

  prepareRedo(room: RoomState): SemanticHistoryReplay | null {
    return this.prepareReplay("redo", room);
  }

  acknowledgeReplay(token: SemanticHistoryReplayToken, room: RoomState): SemanticHistoryEntry {
    this.assertReplayToken(token);
    this.assertRoom(room);
    const pending = this.pendingReplay!;

    for (const [objectId, target] of pending.targetObjects) {
      const current = room.objects[objectId] ?? null;
      if (!objectSemanticsEqual(current, target)) {
        this.pendingReplay = null;
        throw new SemanticHistorySessionError(
          "STALE_REPLAY",
          `History replay did not acknowledge the target state for ${objectId}.`,
        );
      }
    }
    for (const [diagramId, target] of pending.targetDiagrams) {
      const current = room.diagrams[diagramId] ?? null;
      if (!diagramSemanticsEqual(current, target)) {
        this.pendingReplay = null;
        throw new SemanticHistorySessionError(
          "STALE_REPLAY",
          `History replay did not acknowledge the target diagram ${diagramId}.`,
        );
      }
    }

    const source = token.direction === "undo" ? this.undoStack : this.redoStack;
    const destination = token.direction === "undo" ? this.redoStack : this.undoStack;
    const entry = source[source.length - 1];
    if (!entry || entry.sequence !== token.sequence || entry.transactionId !== token.transactionId) {
      this.pendingReplay = null;
      throw new SemanticHistorySessionError("STALE_REPLAY", "History changed before replay settled.");
    }
    source.pop();
    destination.push(entry);
    // A history-owned recreation legitimately receives a new createdAt.
    // Rebase only that incarnation in retained history so repeated undo/redo
    // remains valid without accepting an unrelated reuse of the same ID.
    const restoredIncarnations = new Map<string, { previous: number; current: number }>();
    for (const event of pending.replay.events) {
      if (event.type !== "objects.changed") continue;
      for (const change of event.changes) {
        if (change.kind !== "create") continue;
        const target = pending.targetObjects.get(change.draft.id);
        const restored = room.objects[change.draft.id];
        if (!target || !restored || target.createdAt === restored.createdAt) continue;
        restoredIncarnations.set(target.id, { previous: target.createdAt, current: restored.createdAt });
      }
    }
    if (restoredIncarnations.size) {
      const rebase = (object: CanvasObject | null) => {
        const incarnation = object ? restoredIncarnations.get(object.id) : null;
        return object && incarnation?.previous === object.createdAt
          ? cloneObject({ ...object, createdAt: incarnation.current })
          : object;
      };
      for (const retainedStack of [this.undoStack, this.redoStack]) {
        for (let index = 0; index < retainedStack.length; index += 1) {
          const retained = retainedStack[index];
          retainedStack[index] = deepFreeze({
            ...retained,
            objectChanges: retained.objectChanges.map((snapshot) => ({
              ...snapshot,
              before: rebase(snapshot.before),
              after: rebase(snapshot.after),
            })),
          });
        }
      }
    }
    while (destination.length > this.capacity) destination.shift();
    this.pendingReplay = null;
    return entry;
  }

  rejectReplay(token: SemanticHistoryReplayToken): boolean {
    if (token.roomId !== this.options.roomId) return false;
    if (!this.pendingReplay ||
      this.pendingReplay.replay.token.replayId !== token.replayId ||
      this.pendingReplay.replay.token.attempt !== token.attempt) return false;
    this.pendingReplay = null;
    return true;
  }

  private prepareReplay(direction: "undo" | "redo", room: RoomState): SemanticHistoryReplay | null {
    this.assertRoom(room);
    if (this.pendingReplay) {
      throw new SemanticHistorySessionError("BUSY", "Another history replay is awaiting acknowledgement.");
    }
    if (this.pendingTransactions.size) {
      throw new SemanticHistorySessionError(
        "PENDING_HUMAN_TRANSACTION",
        "Undo and redo wait until every earlier human transaction is acknowledged.",
      );
    }
    const stack = direction === "undo" ? this.undoStack : this.redoStack;
    const entry = stack[stack.length - 1];
    if (!entry) return null;

    // Revisions fence races after replay starts. They cannot prove that the
    // current document still belongs to this history step: rebasing an old
    // snapshot onto a collaborator's latest revision would overwrite their
    // work. Validate the complete transaction before emitting any edits.
    for (const snapshot of entry.objectChanges) {
      const source = direction === "undo" ? snapshot.after : snapshot.before;
      const target = direction === "undo" ? snapshot.before : snapshot.after;
      const current = room.objects[snapshot.objectId] ?? null;
      const matchesSource = objectSemanticsEqual(current, source)
        && current?.createdAt === source?.createdAt;
      if (!matchesSource && !objectSemanticsEqual(current, target)) {
        throw new SemanticHistorySessionError(
          "HISTORY_CONFLICT",
          `Cannot ${direction}: canvas object ${snapshot.objectId} changed since this history step. Its current work has been preserved.`,
        );
      }
    }
    for (const snapshot of entry.diagramChanges) {
      const source = direction === "undo" ? snapshot.after : snapshot.before;
      const target = direction === "undo" ? snapshot.before : snapshot.after;
      const current = room.diagrams[snapshot.diagramId] ?? null;
      const matchesSource = diagramSemanticsEqual(current, source)
        && current?.createdAt === source?.createdAt;
      if (!matchesSource && !diagramSemanticsEqual(current, target)) {
        throw new SemanticHistorySessionError(
          "HISTORY_CONFLICT",
          `Cannot ${direction}: diagram ${snapshot.diagramId} changed since this history step. Its current work has been preserved.`,
        );
      }
    }

    const targetObjects = new Map<string, CanvasObject | null>();
    const gestureObjects: SemanticCanvasGestureObject[] = [];
    const changes: SemanticCanvasObjectChange[] = [];
    for (const snapshot of entry.objectChanges) {
      const target = direction === "undo" ? snapshot.before : snapshot.after;
      const current = room.objects[snapshot.objectId];
      assertLockedImageSafe(current, target);
      if (objectSemanticsEqual(current ?? null, target)) {
        targetObjects.set(snapshot.objectId, target);
        continue;
      }
      const gestureObject = gestureObjectForReplay(current, target);
      const change = changeForReplay(current, target);
      if (gestureObject && change) {
        gestureObjects.push(deepFreeze(gestureObject));
        changes.push(deepFreeze(change));
      }
      targetObjects.set(snapshot.objectId, target);
    }

    const targetDiagrams = new Map<string, Diagram | null>();
    const diagramRestorations = entry.diagramChanges.flatMap((snapshot) => {
      const target = direction === "undo" ? snapshot.before : snapshot.after;
      const current = room.diagrams[snapshot.diagramId] ?? null;
      targetDiagrams.set(snapshot.diagramId, target);
      if (diagramSemanticsEqual(current, target)) return [];
      return [deepFreeze({ diagramId: snapshot.diagramId, current: cloneDiagram(current), target })];
    });

    const token = deepFreeze<SemanticHistoryReplayToken>({
      replayId: "",
      attempt: ++this.replayAttempt,
      roomId: this.options.roomId,
      direction,
      transactionId: entry.transactionId,
      sequence: entry.sequence,
    });
    const fencedToken = deepFreeze<SemanticHistoryReplayToken>({
      ...token,
      replayId: this.replayIdFactory({
        roomId: this.options.roomId,
        transactionId: entry.transactionId,
        direction,
        sequence: entry.sequence,
        attempt: token.attempt,
      }),
    });
    const gestureId = fencedToken.replayId;
    const events: SemanticCanvasEditEvent[] = changes.length
      ? [
          deepFreeze({
            type: "gesture.started",
            gestureId,
            source: "keyboard",
            objects: Object.freeze(gestureObjects),
          }),
          deepFreeze({
            type: "objects.changed",
            gestureId,
            cohortId: gestureId,
            changes: Object.freeze(changes),
          }),
          deepFreeze({
            type: "gesture.finish-requested",
            gestureId,
            reason: "keyboard-idle",
          }),
        ]
      : [];
    const replay = deepFreeze<SemanticHistoryReplay>({
      token: fencedToken,
      entry,
      events: Object.freeze(events),
      diagramRestorations: Object.freeze(diagramRestorations),
      objectIds: Object.freeze(sortedUnique(targetObjects.keys())),
      isNoop: events.length === 0 && diagramRestorations.length === 0,
    });
    this.pendingReplay = { replay, targetObjects, targetDiagrams };
    return replay;
  }

  private assertRoom(room: Pick<RoomState, "id">): void {
    if (room.id !== this.options.roomId) {
      throw new SemanticHistorySessionError(
        "ROOM_MISMATCH",
        `History for ${this.options.roomId} cannot access room ${room.id}.`,
      );
    }
  }

  private assertTokenRoom(token: Pick<SemanticHistoryStageToken, "roomId">): void {
    if (token.roomId !== this.options.roomId) {
      throw new SemanticHistorySessionError("ROOM_MISMATCH", "History token belongs to another room.");
    }
  }

  private assertReplayToken(token: SemanticHistoryReplayToken): void {
    if (token.roomId !== this.options.roomId) {
      throw new SemanticHistorySessionError("ROOM_MISMATCH", "History replay belongs to another room.");
    }
    if (!this.pendingReplay ||
      this.pendingReplay.replay.token.replayId !== token.replayId ||
      this.pendingReplay.replay.token.attempt !== token.attempt) {
      throw new SemanticHistorySessionError("STALE_REPLAY", "History replay token is no longer active.");
    }
  }
}
