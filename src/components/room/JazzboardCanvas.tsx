"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Bot, LockKeyhole, MousePointer2 } from "lucide-react";
import {
  DefaultFontFaces,
  Tldraw,
  type Editor,
  type TLComponents,
  type TLImageShape,
  type JsonObject,
  type TLRecord,
  type TLShape,
  type TLShapeId,
  type TLUiOverrides,
} from "tldraw";

import { JazzboardApiError } from "@/lib/client/api";
import { createJazzboardAssetStore } from "@/lib/client/assets";
import {
  isEquivalentTldrawProjection,
  jazzboardMeta,
  projectRoomIntoTldraw,
  tldrawGroupShapeId,
  tldrawShapeToSemantic,
  tldrawShapeId,
} from "@/lib/canvas/projection";
import { CanvasObjectSyncCoordinator } from "@/lib/canvas/sync-coordinator";
import type {
  ActorKind,
  CanvasCommand,
  FollowTarget,
  LeaseOperation,
  ObjectPatch,
  ObjectLease,
  Participant,
  RoomState,
  RoomPresenceDelta,
  SemanticTransaction,
} from "@/lib/domain/types";
import type { ConnectionState, LeaseAction } from "@/hooks/use-room";
import { roomStateRevision } from "@/lib/realtime/events";
import {
  IDLE_PRESENCE_KEYFRAME_MS,
  TRANSIENT_PRESENCE_INTERVAL_MS,
  activePresenceDelay,
  idlePresenceKeyframeDue,
} from "@/lib/client/presence-cadence";

import styles from "./room.module.css";

type CommandResult = { room: RoomState; changedObjectIds: string[] };
type SemanticTransactionResult = CommandResult & {
  changedDiagramIds: string[];
  membershipObjectIds: string[];
};
type LeaseResult = { lease: ObjectLease | null; room: RoomState };

type ScheduledObjectSync = {
  objectId: string;
  generation: number;
  recoveryEpoch: number;
  deleted: boolean;
  draft: NonNullable<ReturnType<typeof tldrawShapeToSemantic>> | null;
  operation: LeaseOperation | null;
};

type RecoveryGroupLock = {
  objectIds: Set<string>;
  wasLocked: boolean;
};

type PendingObjectSyncBatch = {
  key: string;
  objectIds: Set<string>;
  timer: number | null;
};

type DocumentRecordChanges = {
  added: Record<string, TLRecord>;
  updated: Record<string, [TLRecord, TLRecord]>;
  removed: Record<string, TLRecord>;
};

type Props = {
  room: RoomState;
  self: Participant;
  followTarget: FollowTarget;
  command: (command: CanvasCommand, actorKind?: ActorKind) => Promise<CommandResult>;
  semanticTransaction: (transaction: SemanticTransaction) => Promise<SemanticTransactionResult>;
  lease: (action: LeaseAction, actorKind?: ActorKind) => Promise<LeaseResult>;
  refresh: () => Promise<RoomState>;
  presence: (
    value: {
      cursor: { x: number; y: number } | null;
      viewport: { x: number; y: number; zoom: number; width: number; height: number } | null;
    },
    actorKind?: ActorKind,
  ) => Promise<RoomPresenceDelta>;
  transientPresence: (value: {
    cursor: { x: number; y: number } | null;
    viewport: { x: number; y: number; zoom: number; width: number; height: number } | null;
  }) => boolean;
  connection: ConnectionState;
  onSelectionChange: (objectIds: string[]) => void;
  onEditorChange: (editor: Editor | null) => void;
  onExitFollow: () => void;
  onError: (message: string, details?: unknown) => void;
};

export type JazzboardCanvasHandle = {
  prepareSelectionForAgentMessage(): Promise<{ objectIds: string[]; room: RoomState }>;
};

const SPECTATOR_COMPONENTS: TLComponents = {
  ActionsMenu: null,
  ContextMenu: null,
  ImageToolbar: null,
  MainMenu: null,
  PageMenu: null,
  QuickActions: null,
  RichTextToolbar: null,
  StylePanel: null,
  Toolbar: null,
  VideoToolbar: null,
};

const SUPPORTED_TOOL_IDS = new Set(["select", "hand", "draw", "text", "note", "geo", "arrow", "eraser", "asset"]);
const JAZZBOARD_UI_OVERRIDES: TLUiOverrides = {
  tools(_editor, tools) {
    return Object.fromEntries(Object.entries(tools).filter(([id]) => SUPPORTED_TOOL_IDS.has(id)));
  },
};

function isShape(record: TLRecord | undefined): record is TLShape {
  return record?.typeName === "shape";
}

function isBusyError(error: unknown): error is JazzboardApiError {
  return error instanceof JazzboardApiError && error.failure.code === "OBJECT_BUSY";
}

function isCommittedOutcomeReplay(error: unknown): error is JazzboardApiError {
  return (
    error instanceof JazzboardApiError &&
    error.failure.code === "MUTATION_OUTCOME_UNKNOWN" &&
    error.failure.details?.replayed === true
  );
}

function objectIdForShape(shape: TLShape): string {
  return jazzboardMeta(shape).objectId ?? String(shape.id).slice("shape:".length);
}

function patchForDraft(draft: NonNullable<ReturnType<typeof tldrawShapeToSemantic>>): ObjectPatch {
  const patch: Record<string, unknown> = { ...draft };
  delete patch.id;
  delete patch.kind;
  return patch as ObjectPatch;
}

function stripCopiedJazzboardIdentity(shape: TLShape): JsonObject {
  const meta = { ...(shape.meta as JsonObject) };
  // tldraw merges shape metadata updates, so explicit nulls are required to
  // clear identity fields copied by duplicateShapes / alt-drag.
  meta.jazzboardId = null;
  meta.jazzboardRevision = null;
  meta.jazzboardCreatedAt = null;
  meta.jazzboardKind = null;
  meta.jazzboardGroupId = null;
  return meta;
}

export function editableShapesForTargets(editor: Editor, targets: readonly TLShape[]): TLShape[] {
  const editable = new Map<TLShapeId, TLShape>();
  const visit = (shape: TLShape) => {
    if (shape.type !== "group") {
      editable.set(shape.id, shape);
      return;
    }
    for (const childId of editor.getSortedChildIdsForParent(shape)) {
      const child = editor.getShape(childId);
      if (child) visit(child);
    }
  };
  targets.forEach(visit);
  return [...editable.values()];
}

export async function flushCanvasSelectionToRoom({
  objectIds,
  flush,
  queueTails,
  isUnsettled,
  refresh,
  isAuthoritative,
  timeoutMs = 12_000,
}: {
  objectIds: string[];
  flush(): void;
  queueTails(): Promise<void>[];
  isUnsettled(objectId: string): boolean;
  refresh(): Promise<RoomState>;
  isAuthoritative(room: RoomState, objectId: string): boolean;
  timeoutMs?: number;
}): Promise<RoomState> {
  flush();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.all(queueTails()),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("The selected canvas items are still saving. Try Ask again in a moment.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
  if (objectIds.some(isUnsettled)) {
    throw new Error("The selected canvas items could not be saved for agent context.");
  }
  const room = await refresh();
  if (objectIds.some((objectId) => !isAuthoritative(room, objectId))) {
    throw new Error("The selected canvas items are not yet authoritative. Try Ask again.");
  }
  return room;
}

function boundConnectorsForTargets(editor: Editor, targets: readonly TLShape[]): TLShape[] {
  const connectors = new Map<TLShapeId, TLShape>();
  for (const shape of targets) {
    for (const binding of editor.getBindingsToShape(shape, "arrow")) {
      const connector = editor.getShape(binding.fromId);
      if (connector?.type === "arrow") connectors.set(connector.id, connector);
    }
  }
  return [...connectors.values()];
}

function semanticOperation(editor: Editor, shape: TLShape, current: RoomState["objects"][string]): ObjectLease["operation"] {
  const tool = editor.getCurrentToolId();
  if (editor.getEditingShapeId() === shape.id || tool === "text") return "edit";
  const draft = tldrawShapeToSemantic(editor, shape);
  if (!draft) return "edit";
  if (draft.x !== current.x || draft.y !== current.y) return "move";
  const heightChanged = shape.type !== "text" && shape.type !== "note" && draft.height !== current.height;
  if (editor.isIn("select.resizing") || draft.width !== current.width || heightChanged || draft.rotation !== current.rotation) {
    return "resize";
  }
  if (shape.type === "arrow" || tool === "arrow") return "connect";
  if (shape.type === "draw" || tool === "draw") return "annotate";
  return "edit";
}

export const JazzboardCanvas = forwardRef<JazzboardCanvasHandle, Props>(function JazzboardCanvas({
  room,
  self,
  followTarget,
  command,
  semanticTransaction,
  lease,
  refresh,
  presence,
  transientPresence,
  connection,
  onSelectionChange,
  onEditorChange,
  onExitFollow,
  onError,
}: Props, ref) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const roomRef = useRef(room);
  const selfRef = useRef(self);
  const syncCoordinatorRef = useRef(new CanvasObjectSyncCoordinator());
  const projectingRoomRef = useRef(false);
  const mountedRef = useRef(true);
  const pointerGestureActiveRef = useRef(false);
  const pointerGestureEpochRef = useRef(0);
  const objectGestureEpochRef = useRef(new Map<string, number>());
  const pointerGestureBatchRef = useRef<{ epoch: number; objectIds: Set<string> } | null>(null);
  const keyboardInteractionBatchRef = useRef<{
    key: string;
    epoch: number;
    objectIds: Set<string>;
    dependentObjectIds: Set<string>;
    timer: number | null;
  } | null>(null);
  const manualDocumentInputEpochRef = useRef(0);
  const manualDocumentInputActiveRef = useRef(false);
  const gestureObjectIdsRef = useRef(new Set<string>());
  const gestureDependentObjectIdsRef = useRef(new Set<string>());
  const pendingObjectSyncBatchesRef = useRef(new Map<string, PendingObjectSyncBatch>());
  const outstandingSyncBatchSequenceRef = useRef(0);
  const outstandingSyncBatchesRef = useRef(new Map<number, Set<string>>());
  const editingObjectIdRef = useRef<string | null>(null);
  const recoveryGroupLocksRef = useRef(new Map<TLShapeId, RecoveryGroupLock>());
  const flushFramesRef = useRef(new Set<number>());
  const transientPresenceTimerRef = useRef<number | null>(null);
  const durablePresenceTimerRef = useRef<number | null>(null);
  const durablePresenceInFlightRef = useRef(false);
  const durablePresenceQueuedRef = useRef(false);
  const lastDurablePresenceAtRef = useRef(0);
  const durablePresenceSenderRef = useRef<(force?: boolean) => void>(() => undefined);
  const reconciliationWaitersRef = useRef(new Map<number, () => void>());
  const pendingCursorRef = useRef<{ x: number; y: number } | null>(null);
  const projectedDocumentRef = useRef<{
    editor: Editor;
    roomId: string;
    roomRevision: number;
  } | null>(null);
  const assetStore = useMemo(
    () =>
      createJazzboardAssetStore(room.id, (progress) => {
        setUploadProgress(progress);
        if (progress >= 100) window.setTimeout(() => setUploadProgress(null), 700);
      }),
    [room.id],
  );

  useEffect(() => {
    if (
      room.id !== roomRef.current.id ||
      roomStateRevision(room) > roomStateRevision(roomRef.current)
    ) {
      roomRef.current = room;
    }
    selfRef.current = self;
  }, [room, self]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!editor) return;
    editor.updateInstanceState({ isReadonly: self.role === "spectator" });
  }, [editor, self.role]);

  useEffect(() => {
    if (!editor) return;
    const projected = projectedDocumentRef.current;
    if (
      projected?.editor === editor &&
      projected.roomId === room.id &&
      projected.roomRevision === room.roomRevision
    ) {
      return;
    }
    projectingRoomRef.current = true;
    try {
      projectRoomIntoTldraw(editor, room, {
        protectedObjectIds: syncCoordinatorRef.current.protectedObjectIds(),
      });
      projectedDocumentRef.current = {
        editor,
        roomId: room.id,
        roomRevision: room.roomRevision,
      };
    } finally {
      projectingRoomRef.current = false;
    }
  }, [editor, room]);

  const followedViewport = followTarget
    ? room.participants[followTarget.participantId]?.[followTarget.kind].viewport
    : null;
  const followX = followedViewport?.x;
  const followY = followedViewport?.y;
  const followWidth = followedViewport?.width;
  const followHeight = followedViewport?.height;
  const followZoom = followedViewport?.zoom;

  useEffect(() => {
    if (!editor || followX === undefined || followY === undefined || followWidth === undefined || followHeight === undefined || followZoom === undefined) return;
    editor.zoomToBounds(
      {
        x: followX,
        y: followY,
        w: followWidth,
        h: followHeight,
      },
      { targetZoom: followZoom, inset: 0, force: true, animation: { duration: 180 } },
    );
  }, [editor, followHeight, followWidth, followX, followY, followZoom]);

  const advanceRoomRef = useCallback((next: RoomState) => {
    if (next.id !== roomRef.current.id) return roomRef.current;
    if (roomStateRevision(next) > roomStateRevision(roomRef.current)) roomRef.current = next;
    return roomRef.current;
  }, []);

  const projectAuthoritativeRoom = useCallback(
    (next: RoomState, forceObjectIds: ReadonlySet<string> = new Set()) => {
      if (!editor || !mountedRef.current) return;
      projectingRoomRef.current = true;
      try {
        projectRoomIntoTldraw(editor, next, {
          protectedObjectIds: syncCoordinatorRef.current.protectedObjectIds(),
          forceObjectIds,
        });
      } finally {
        projectingRoomRef.current = false;
      }
    },
    [editor],
  );

  const lockObjectsForRecovery = useCallback(
    (objectIds: Iterable<string>, completeActiveEdit = false) => {
      if (!editor || !mountedRef.current) return;
      const coordinator = syncCoordinatorRef.current;
      projectingRoomRef.current = true;
      try {
        editor.store.mergeRemoteChanges(() => {
          if (completeActiveEdit) editor.complete();
          for (const objectId of new Set(objectIds)) {
            const entry = coordinator.get(objectId);
            const shape = editor.getShape(
              (entry?.shapeId as TLShapeId | null) ?? tldrawShapeId(objectId),
            );
            if (!shape) continue;
            if (!shape.isLocked) editor.updateShape({ id: shape.id, type: shape.type, isLocked: true });

            let parentId = shape.parentId;
            while (String(parentId).startsWith("shape:")) {
              const parent = editor.getShape(parentId as TLShapeId);
              if (!parent) break;
              if (parent.type === "group") {
                const existing = recoveryGroupLocksRef.current.get(parent.id);
                if (existing) existing.objectIds.add(objectId);
                else {
                  recoveryGroupLocksRef.current.set(parent.id, {
                    objectIds: new Set([objectId]),
                    wasLocked: parent.isLocked,
                  });
                }
                if (!parent.isLocked) {
                  editor.updateShape({ id: parent.id, type: parent.type, isLocked: true });
                }
              }
              parentId = parent.parentId;
            }
          }
        });
      } finally {
        projectingRoomRef.current = false;
      }
    },
    [editor],
  );

  const unlockRecoveryGroups = useCallback(
    (objectIds: Iterable<string>) => {
      if (!editor || !mountedRef.current) return;
      const settledIds = new Set(objectIds);
      const unlock: TLShapeId[] = [];
      for (const [groupId, recoveryLock] of recoveryGroupLocksRef.current) {
        for (const objectId of settledIds) recoveryLock.objectIds.delete(objectId);
        if (recoveryLock.objectIds.size) continue;
        recoveryGroupLocksRef.current.delete(groupId);
        if (!recoveryLock.wasLocked) unlock.push(groupId);
      }
      if (!unlock.length) return;
      projectingRoomRef.current = true;
      try {
        editor.store.mergeRemoteChanges(() => {
          for (const groupId of unlock) {
            const group = editor.getShape(groupId);
            if (group?.type === "group" && group.isLocked) {
              editor.updateShape({ id: group.id, type: group.type, isLocked: false });
            }
          }
        });
      } finally {
        projectingRoomRef.current = false;
      }
    },
    [editor],
  );

  const releaseLease = useCallback(
    async (objectId: string) => {
      const coordinator = syncCoordinatorRef.current;
      // Cancellation is synchronous: no in-flight acquire may install or
      // reacquire a lease after this object has become locally settled.
      const entry = coordinator.cancelLeaseIntent(objectId);
      if (!entry) return;
      if (entry.releaseRequest) return entry.releaseRequest;

      const request = (async () => {
        if (entry.leaseRequest) await entry.leaseRequest.catch(() => null);
        const active = entry.lease;
        if (!active) return;
        if (active.renewTimer) window.clearInterval(active.renewTimer);
        active.renewTimer = null;
        try {
          const released = await lease({ action: "release", objectId, leaseId: active.lease.leaseId });
          advanceRoomRef(released.room);
        } catch {
          // The server lease is short-lived. Once the optimistic edit is
          // settled, a failed best-effort release must not hold local state.
        } finally {
          if (entry.lease?.lease.leaseId === active.lease.leaseId) entry.lease = null;
        }
      })();
      entry.releaseRequest = request;
      try {
        await request;
      } finally {
        if (entry.releaseRequest === request) entry.releaseRequest = null;
        coordinator.prune(objectId);
      }
    },
    [advanceRoomRef, lease],
  );

  const settleObject = useCallback(
    (objectId: string, authoritativeRoom?: RoomState) => {
      const coordinator = syncCoordinatorRef.current;
      const entry = coordinator.get(objectId);
      if (!entry || !coordinator.canSettle(entry)) return;
      // A successful acknowledgement always advances an object's revision (or
      // confirms an already-equivalent no-op), so normal incremental
      // projection is sufficient. Reserve forced projection for deliberate
      // rollback/recovery; forcing an acknowledged bound connector can
      // transiently apply its target movement twice before tldraw settles the
      // binding.
      projectAuthoritativeRoom(authoritativeRoom ?? roomRef.current);
      void releaseLease(objectId);
    },
    [projectAuthoritativeRoom, releaseLease],
  );

  const recoverObjects = useCallback(
    (objectIds: Iterable<string>, error: unknown) => {
      if (!mountedRef.current) return;
      const coordinator = syncCoordinatorRef.current;
      const recoveryIdSet = new Set(objectIds);
      let expanded = true;
      while (expanded) {
        expanded = false;
        const gestureBatch = pointerGestureBatchRef.current;
        if (
          gestureBatch &&
          [...gestureBatch.objectIds].some((objectId) => recoveryIdSet.has(objectId))
        ) {
          for (const objectId of gestureBatch.objectIds) {
            if (recoveryIdSet.has(objectId)) continue;
            recoveryIdSet.add(objectId);
            expanded = true;
          }
        }
        for (const batch of pendingObjectSyncBatchesRef.current.values()) {
          if (![...batch.objectIds].some((objectId) => recoveryIdSet.has(objectId))) continue;
          for (const objectId of batch.objectIds) {
            if (recoveryIdSet.has(objectId)) continue;
            recoveryIdSet.add(objectId);
            expanded = true;
          }
        }
        for (const batchObjectIds of outstandingSyncBatchesRef.current.values()) {
          if (![...batchObjectIds].some((objectId) => recoveryIdSet.has(objectId))) continue;
          for (const objectId of batchObjectIds) {
            if (recoveryIdSet.has(objectId)) continue;
            recoveryIdSet.add(objectId);
            expanded = true;
          }
        }
      }
      const ids = [...recoveryIdSet];
      const entries = ids
        .map((objectId) => coordinator.beginRecovery(objectId))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
      if (!entries.length) return;
      const recoveryIds = entries.map((entry) => entry.objectId);

      for (const entry of entries) {
        entry.timer = null;
        if (entry.recoveryTimer) window.clearTimeout(entry.recoveryTimer);
        entry.recoveryTimer = null;
      }
      for (const [key, batch] of pendingObjectSyncBatchesRef.current) {
        if (![...batch.objectIds].some((objectId) => recoveryIdSet.has(objectId))) continue;
        if (batch.timer) window.clearTimeout(batch.timer);
        pendingObjectSyncBatchesRef.current.delete(key);
      }
      if (
        pointerGestureBatchRef.current &&
        [...pointerGestureBatchRef.current.objectIds].some((objectId) => recoveryIdSet.has(objectId))
      ) {
        pointerGestureBatchRef.current = null;
      }

      const failedIds = new Set(recoveryIds);
      const activeEditFailed =
        (editingObjectIdRef.current !== null && failedIds.has(editingObjectIdRef.current)) ||
        (pointerGestureActiveRef.current &&
          [...gestureObjectIdsRef.current].some((objectId) => failedIds.has(objectId)));
      lockObjectsForRecovery(recoveryIds, activeEditFailed);

      if (isBusyError(error)) onError(error.message, error.failure.details);
      else if (!isCommittedOutcomeReplay(error)) {
        onError(error instanceof Error ? error.message : "The canvas change could not be saved.");
      }

      const attemptRecovery = () => {
        void refresh()
          .then((next) => {
            if (!mountedRef.current) return;
            const authoritative = advanceRoomRef(next);
            for (const entry of entries) {
              if (entry.recoveryTimer) window.clearTimeout(entry.recoveryTimer);
              entry.recoveryTimer = null;
              const authoritativeObject = authoritative.objects[entry.objectId];
              coordinator.completeRecovery(
                entry.objectId,
                authoritativeObject?.revision ?? null,
                authoritativeObject?.createdAt ?? null,
              );
            }
            projectAuthoritativeRoom(authoritative, new Set(recoveryIds));
            unlockRecoveryGroups(recoveryIds);
            for (const objectId of recoveryIds) void releaseLease(objectId);
          })
          .catch(() => {
            if (!mountedRef.current) return;
            const timer = window.setTimeout(attemptRecovery, 1_200);
            for (const entry of entries) entry.recoveryTimer = timer;
          });
      };
      attemptRecovery();
    },
    [
      advanceRoomRef,
      lockObjectsForRecovery,
      onError,
      projectAuthoritativeRoom,
      refresh,
      releaseLease,
      unlockRecoveryGroups,
    ],
  );

  const recoverObject = useCallback(
    (objectId: string, error: unknown) => recoverObjects([objectId], error),
    [recoverObjects],
  );

  const acquireLease = useCallback(
    async (
      objectId: string,
      operation: LeaseOperation,
      mode: "latest-intent" | "ensure-ownership" = "latest-intent",
    ) => {
      const coordinator = syncCoordinatorRef.current;
      const initialObject = roomRef.current.objects[objectId];
      const entry = coordinator.getOrCreate(
        objectId,
        initialObject?.revision ?? null,
        initialObject?.createdAt ?? null,
      );
      // Immediate document events publish the newest human intent. An older
      // serialized save only needs proof of ownership and must not overwrite
      // that newer operation intent when it reaches the head of the queue.
      const intent =
        mode === "latest-intent" ? coordinator.desireLease(objectId, operation) : null;

      while (mountedRef.current && !entry.awaitingRecovery) {
        if (
          intent &&
          !coordinator.hasLeaseIntent(entry, intent.epoch, operation)
        ) {
          return entry.lease?.lease ?? null;
        }
        if (mode === "ensure-ownership" && !entry.dirty) return entry.lease?.lease ?? null;
        if (entry.releaseRequest) {
          await entry.releaseRequest.catch(() => undefined);
          if (
            intent &&
            !coordinator.hasLeaseIntent(entry, intent.epoch, operation)
          ) {
            return entry.lease?.lease ?? null;
          }
          if (mode === "ensure-ownership" && (!entry.dirty || entry.awaitingRecovery)) {
            return entry.lease?.lease ?? null;
          }
        }
        if (
          entry.lease &&
          (mode === "ensure-ownership" || entry.lease.lease.operation === operation)
        ) {
          if (coordinator.canSettle(entry)) void releaseLease(objectId);
          return entry.lease.lease;
        }
        if (entry.leaseRequest) {
          await entry.leaseRequest;
          if (
            intent &&
            !coordinator.hasLeaseIntent(entry, intent.epoch, operation)
          ) {
            return entry.lease?.lease ?? null;
          }
          continue;
        }

        const current = roomRef.current.objects[objectId];
        const expectedRevision = entry.baseRevision ?? current?.revision ?? null;
        if (!current || expectedRevision === null) return null;
        const requestedOperation: LeaseOperation =
          mode === "ensure-ownership"
            ? entry.desiredLeaseOperation ?? operation
            : operation;
        const request: Promise<ObjectLease | null> = lease({
          action: "acquire",
          objectId,
          expectedRevision,
          operation: requestedOperation,
        }).then((result) => {
          advanceRoomRef(result.room);
          return result.lease;
        });
        entry.leaseRequest = request;
        try {
          const acquired: ObjectLease | null = await request;
          if (!acquired) return null;
          if (!mountedRef.current) {
            void lease({ action: "release", objectId, leaseId: acquired.leaseId })
              .then((result) => advanceRoomRef(result.room))
              .catch(() => undefined);
            return null;
          }
          if (entry.lease?.renewTimer) window.clearInterval(entry.lease.renewTimer);
          const managed: {
            lease: ObjectLease;
            renewTimer: number | null;
            renewRequest: Promise<void> | null;
          } = {
            lease: acquired,
            renewTimer: null,
            renewRequest: null,
          };
          managed.renewTimer = window.setInterval(() => {
            if (managed.renewRequest || entry.lease !== managed) return;
            const renewRequest = lease({ action: "renew", objectId, leaseId: managed.lease.leaseId })
              .then((result) => {
                if (!mountedRef.current) return;
                advanceRoomRef(result.room);
                if (result.lease && entry.lease === managed) managed.lease = result.lease;
              })
              .catch(() => {
                // A transport failure is ambiguous: the server may have renewed
                // this exact lease even though its response was lost. Retain the
                // managed identity so acknowledgement can still release it, and
                // let the next serialized interval attempt reconcile expiry.
              })
              .finally(() => {
                if (managed.renewRequest === renewRequest) managed.renewRequest = null;
              });
            managed.renewRequest = renewRequest;
          }, 1_500);
          entry.lease = managed;
          if (
            intent &&
            !coordinator.hasLeaseIntent(entry, intent.epoch, requestedOperation)
          ) {
            // Keep a superseded same-actor lease installed: the next intent can
            // update its operation using the server-reused lease ID. A genuine
            // cancellation/recovery already owns releaseRequest and will drain
            // this exact lease before any newer acquire is allowed to continue.
            if (
              !entry.releaseRequest &&
              (entry.desiredLeaseOperation === null || entry.awaitingRecovery)
            ) {
              void releaseLease(objectId);
            }
            return acquired;
          }
        } finally {
          if (entry.leaseRequest === request) entry.leaseRequest = null;
        }

        if (
          entry.lease &&
          (mode === "ensure-ownership" ||
            (intent &&
              coordinator.hasLeaseIntent(entry, intent.epoch, operation) &&
              entry.lease.lease.operation === operation))
        ) {
          if (coordinator.canSettle(entry)) void releaseLease(objectId);
          return entry.lease.lease;
        }
      }
      return null;
    },
    [advanceRoomRef, lease, releaseLease],
  );

  const syncObjectBatch = useCallback(
    async (scheduledObjects: readonly ScheduledObjectSync[]) => {
      if (!editor || selfRef.current.role !== "participant") return;
      const coordinator = syncCoordinatorRef.current;
      const scheduled = [...new Map(scheduledObjects.map((item) => [item.objectId, item])).values()];
      const ids = scheduled.map((item) => item.objectId);
      const entries = ids.map((objectId) => coordinator.get(objectId));
      const invalidated = scheduled.some((item, index) => {
        const entry = entries[index];
        return !entry || entry.awaitingRecovery || entry.recoveryEpoch !== item.recoveryEpoch;
      });
      const mixedAtomicState =
        scheduled.length > 1 &&
        entries.some((entry) => entry?.dirty) &&
        entries.some((entry) => !entry?.dirty);
      if (invalidated || mixedAtomicState) {
        if (scheduled.length > 1) {
          recoverObjects(ids, new Error("A related canvas change was invalidated before its atomic save."));
        }
        return;
      }
      if (entries.every((entry) => !entry?.dirty)) return;
      if (entries.some((entry) => entry?.awaitingRecovery)) {
        recoverObjects(ids, new Error("A related canvas change is already being reconciled."));
        return;
      }

      type Snapshot = {
        objectId: string;
        generation: number;
        baseRevision: number | null;
        baseCreatedAt: number | null;
        mode: "create" | "update" | "delete" | "delete-noop" | "noop";
        draft: NonNullable<ReturnType<typeof tldrawShapeToSemantic>> | null;
        operation: LeaseOperation | null;
      };

      const snapshots: Snapshot[] = [];
      try {
        for (const scheduledObject of scheduled) {
          const { objectId } = scheduledObject;
          const entry = coordinator.get(objectId);
          if (!entry?.dirty || entry.awaitingRecovery) {
            if (scheduled.length > 1) {
              throw new Error("An atomic canvas change lost one of its members before saving.");
            }
            continue;
          }
          if (entry.recoveryEpoch !== scheduledObject.recoveryEpoch) {
            throw new Error(`Canvas object ${objectId} was reconciled before its queued save.`);
          }
          // A newer single-object save already owns this object. Multi-object
          // snapshots retain their captured drafts so the original gesture is
          // still committed atomically before any later per-object edit.
          if (
            scheduled.length === 1 &&
            entry.generation > scheduledObject.generation &&
            entry.queuedGeneration > scheduledObject.generation
          ) {
            continue;
          }
          const current = roomRef.current.objects[objectId];
          if (scheduledObject.deleted) {
            if (!current) {
              snapshots.push({
                objectId,
                generation: scheduledObject.generation,
                baseRevision: entry.baseRevision,
                baseCreatedAt: entry.baseCreatedAt,
                mode: "delete-noop",
                draft: null,
                operation: null,
              });
              continue;
            }
            if (
              entry.baseRevision === null ||
              current.revision !== entry.baseRevision ||
              current.createdAt !== entry.baseCreatedAt
            ) {
              throw new Error(`Canvas object ${objectId} changed before it could be deleted.`);
            }
            snapshots.push({
              objectId,
              generation: scheduledObject.generation,
              baseRevision: entry.baseRevision,
              baseCreatedAt: entry.baseCreatedAt,
              mode: "delete",
              draft: null,
              operation: "delete",
            });
            continue;
          }

          const draft = scheduledObject.draft;
          if (!draft) throw new Error(`Canvas object ${objectId} is no longer editable.`);
          if (!current) {
            if (entry.baseRevision !== null) {
              throw new Error(`Canvas object ${objectId} was removed by another collaborator.`);
            }
            snapshots.push({
              objectId,
              generation: scheduledObject.generation,
              baseRevision: entry.baseRevision,
              baseCreatedAt: entry.baseCreatedAt,
              mode: "create",
              draft,
              operation: null,
            });
            continue;
          }
          if (current.createdAt !== entry.baseCreatedAt) {
            throw new Error(`Canvas object ${objectId} changed incarnation before it could be saved.`);
          }
          if (isEquivalentTldrawProjection(current, draft)) {
            snapshots.push({
              objectId,
              generation: scheduledObject.generation,
              baseRevision: entry.baseRevision,
              baseCreatedAt: entry.baseCreatedAt,
              mode: "noop",
              draft,
              operation: null,
            });
            continue;
          }
          if (entry.baseRevision === null || current.revision !== entry.baseRevision) {
            throw new Error(
              `Canvas object ${objectId} changed from revision ${entry.baseRevision ?? "unknown"} to ${current.revision}.`,
            );
          }
          snapshots.push({
            objectId,
            generation: scheduledObject.generation,
            baseRevision: entry.baseRevision,
            baseCreatedAt: entry.baseCreatedAt,
            mode: "update",
            draft,
            operation: scheduledObject.operation ?? "edit",
          });
        }

        const leaseSnapshots = snapshots.filter(
          (snapshot): snapshot is Snapshot & { operation: LeaseOperation } => snapshot.operation !== null,
        );
        const leaseResults = await Promise.allSettled(
          leaseSnapshots.map((snapshot) =>
            acquireLease(snapshot.objectId, snapshot.operation, "ensure-ownership"),
          ),
        );
        const acquired = new Map<string, ObjectLease>();
        let acquisitionError: unknown = null;
        leaseResults.forEach((result, index) => {
          if (result.status === "fulfilled" && result.value) acquired.set(leaseSnapshots[index].objectId, result.value);
          else if (!acquisitionError) {
            acquisitionError = result.status === "rejected" ? result.reason : new Error("An object lease could not be acquired.");
          }
        });
        if (acquisitionError) throw acquisitionError;
        if (
          scheduled.some((item) => {
            const entry = coordinator.get(item.objectId);
            return !entry || entry.awaitingRecovery || entry.recoveryEpoch !== item.recoveryEpoch;
          })
        ) {
          throw new Error("The canvas change was reconciled while its leases were being acquired.");
        }
        for (const snapshot of leaseSnapshots) {
          const current = roomRef.current.objects[snapshot.objectId];
          if (
            !current ||
            snapshot.baseRevision === null ||
            current.revision !== snapshot.baseRevision ||
            current.createdAt !== snapshot.baseCreatedAt
          ) {
            throw new Error(`Canvas object ${snapshot.objectId} changed while its lease was being acquired.`);
          }
        }

        const commands: CanvasCommand[] = [];
        for (const snapshot of snapshots
          .filter((item) => item.mode === "create")
          .sort((left, right) => Number(left.draft?.kind === "connector") - Number(right.draft?.kind === "connector"))) {
          if (snapshot.draft) commands.push({ type: "create", object: snapshot.draft });
        }
        for (const snapshot of snapshots.filter((item) => item.mode === "update")) {
          const current = roomRef.current.objects[snapshot.objectId];
          const active = acquired.get(snapshot.objectId);
          if (!current || snapshot.baseRevision === null || !snapshot.draft || !snapshot.operation || !active) {
            throw new Error(`Canvas object ${snapshot.objectId} could not be prepared for saving.`);
          }
          commands.push({
            type: "update",
            objectId: snapshot.objectId,
            expectedRevision: snapshot.baseRevision,
            patch: patchForDraft(snapshot.draft),
            leaseId: active.leaseId,
            operation: snapshot.operation,
          });
        }
        const deletionTargets = snapshots
          .filter((item) => item.mode === "delete")
          .map((snapshot) => {
            const current = roomRef.current.objects[snapshot.objectId];
            const active = acquired.get(snapshot.objectId);
            if (!current || snapshot.baseRevision === null || !active) {
              throw new Error(`Canvas object ${snapshot.objectId} could not be prepared for deletion.`);
            }
            return {
              objectId: snapshot.objectId,
              expectedRevision: snapshot.baseRevision,
              leaseId: active.leaseId,
            };
          });
        if (deletionTargets.length) commands.push({ type: "delete", targets: deletionTargets });

        let result: CommandResult | null = null;
        if (commands.length === 1) result = await command(commands[0]);
        else if (commands.length > 1) {
          result = await semanticTransaction({ commands, diagramCommands: [] });
        }
        if (
          scheduled.some((item) => {
            const entry = coordinator.get(item.objectId);
            return !entry || entry.awaitingRecovery || entry.recoveryEpoch !== item.recoveryEpoch;
          })
        ) {
          throw new Error("The canvas change was reconciled while its save was in flight.");
        }
        const authoritative = result ? advanceRoomRef(result.room) : roomRef.current;
        const settledIds: string[] = [];
        for (const snapshot of snapshots) {
          const authoritativeObject = authoritative.objects[snapshot.objectId];
          const revision =
            snapshot.mode === "delete" || snapshot.mode === "delete-noop"
              ? null
              : authoritativeObject?.revision ??
                roomRef.current.objects[snapshot.objectId]?.revision ??
                null;
          const authoritativeCreatedAt = authoritativeObject?.createdAt ?? null;
          if (snapshot.mode !== "delete" && snapshot.mode !== "delete-noop" && revision === null) {
            throw new Error(`Canvas object ${snapshot.objectId} was not returned by the room.`);
          }
          if (
            ((snapshot.mode === "delete" || snapshot.mode === "delete-noop") && authoritativeObject) ||
            (snapshot.mode !== "create" &&
              snapshot.mode !== "delete" &&
              snapshot.mode !== "delete-noop" &&
              snapshot.baseCreatedAt !== authoritativeCreatedAt)
          ) {
            throw new Error(`Canvas object ${snapshot.objectId} changed incarnation while it was saving.`);
          }
          if (
            coordinator.acknowledge(snapshot.objectId, snapshot.generation, revision, {
              expectedCreatedAt: snapshot.baseCreatedAt,
              authoritativeCreatedAt,
            })
          ) {
            settledIds.push(snapshot.objectId);
          }
        }
        for (const objectId of settledIds) settleObject(objectId, authoritative);
      } catch (error) {
        if (!mountedRef.current) return;
        if (isCommittedOutcomeReplay(error)) {
          // The idempotency receipt proves this exact command body committed,
          // but the generic API cannot reconstruct its original response. Keep
          // the serialized queue and every owned lease intact until an
          // authoritative refresh advances the base revisions. Crucially, an
          // older acknowledgement updates the base without clearing a newer
          // local generation or projecting over its pixels.
          const waitForAuthoritativeRetry = () => new Promise<void>((resolve) => {
            let timer = 0;
            const complete = () => {
              for (const scheduledObject of scheduled) {
                const entry = coordinator.get(scheduledObject.objectId);
                if (entry?.recoveryTimer === timer) entry.recoveryTimer = null;
              }
              reconciliationWaitersRef.current.delete(timer);
              resolve();
            };
            timer = window.setTimeout(complete, 1_200);
            reconciliationWaitersRef.current.set(timer, complete);
            for (const scheduledObject of scheduled) {
              const entry = coordinator.get(scheduledObject.objectId);
              if (entry) entry.recoveryTimer = timer;
            }
          });
          const committedRoomRevision =
            typeof error.failure.details?.committedRoomRevision === "number"
              ? error.failure.details.committedRoomRevision
              : null;
          while (mountedRef.current) {
            let authoritative: RoomState;
            try {
              const refreshed = await refresh();
              if (refreshed.id !== roomRef.current.id) {
                await waitForAuthoritativeRetry();
                continue;
              }
              authoritative = advanceRoomRef(refreshed);
            } catch {
              await waitForAuthoritativeRetry();
              continue;
            }
            if (!mountedRef.current) return;
            if (
              committedRoomRevision !== null &&
              authoritative.roomRevision < committedRoomRevision
            ) {
              await waitForAuthoritativeRetry();
              continue;
            }

            const settledIds: string[] = [];
            let invalidIncarnation = false;
            for (const snapshot of snapshots) {
              const entry = coordinator.get(snapshot.objectId);
              if (!entry || entry.recoveryEpoch !== scheduled.find(
                (item) => item.objectId === snapshot.objectId,
              )?.recoveryEpoch) {
                continue;
              }
              if (entry.recoveryTimer) window.clearTimeout(entry.recoveryTimer);
              entry.recoveryTimer = null;
              const authoritativeObject = authoritative.objects[snapshot.objectId];
              if (
                ((snapshot.mode === "create" || snapshot.mode === "update") &&
                  !authoritativeObject) ||
                (snapshot.mode === "delete" && authoritativeObject)
              ) {
                invalidIncarnation = true;
                break;
              }
              const acknowledged = coordinator.acknowledge(
                snapshot.objectId,
                snapshot.generation,
                authoritativeObject?.revision ?? null,
                {
                  expectedCreatedAt: snapshot.baseCreatedAt,
                  authoritativeCreatedAt: authoritativeObject?.createdAt ?? null,
                },
              );
              if (entry.acknowledgedGeneration < snapshot.generation) {
                invalidIncarnation = true;
                break;
              }
              if (acknowledged) settledIds.push(snapshot.objectId);
            }
            if (invalidIncarnation) {
              recoverObjects(
                ids,
                new Error("A committed canvas change was superseded by a different object incarnation."),
              );
              return;
            }
            if (settledIds.length) projectAuthoritativeRoom(authoritative);
            for (const objectId of settledIds) void releaseLease(objectId);
            return;
          }
          return;
        }
        recoverObjects(ids, error);
      }
    },
    [
      acquireLease,
      advanceRoomRef,
      command,
      editor,
      recoverObjects,
      refresh,
      projectAuthoritativeRoom,
      releaseLease,
      semanticTransaction,
      settleObject,
    ],
  );

  const enqueueObjectSyncBatch = useCallback(
    (objectIds: Iterable<string>) => {
      const coordinator = syncCoordinatorRef.current;
      const scheduled = [...new Set(objectIds)].flatMap((objectId): ScheduledObjectSync[] => {
        const entry = coordinator.get(objectId);
        if (!entry) return [];
        entry.timer = null;
        if (!entry.dirty || entry.awaitingRecovery) {
          settleObject(objectId);
          return [];
        }
        if (entry.queuedGeneration >= entry.generation) return [];
        entry.queuedGeneration = entry.generation;
        const shape = entry.shapeId ? editor?.getShape(entry.shapeId as TLShapeId) : undefined;
        const draft = !entry.deleted && shape ? tldrawShapeToSemantic(editor!, shape) : null;
        const current = roomRef.current.objects[objectId];
        return [
          {
            objectId,
            generation: entry.generation,
            recoveryEpoch: entry.recoveryEpoch,
            deleted: entry.deleted,
            draft,
            operation: shape && current ? semanticOperation(editor!, shape, current) : null,
          },
        ];
      });
      if (!scheduled.length) return;
      const ids = scheduled.map((item) => item.objectId);
      const onSettled = (entry: NonNullable<ReturnType<typeof coordinator.get>>) => {
        if (coordinator.canSettle(entry)) settleObject(entry.objectId);
        coordinator.prune(entry.objectId);
      };
      const batchToken = ++outstandingSyncBatchSequenceRef.current;
      outstandingSyncBatchesRef.current.set(batchToken, new Set(ids));
      const queued =
        ids.length === 1
          ? coordinator.enqueue(ids[0], () => syncObjectBatch(scheduled), onSettled)
          : coordinator.enqueueBatch(ids, () => syncObjectBatch(scheduled), onSettled);
      void queued.then(
        () => outstandingSyncBatchesRef.current.delete(batchToken),
        () => outstandingSyncBatchesRef.current.delete(batchToken),
      );
    },
    [editor, settleObject, syncObjectBatch],
  );

  const flushPendingObjectSync = useCallback(
    (objectIds: Iterable<string> = [], batchKey?: string) => {
      const ids = new Set(objectIds);
      const gestureBatch = pointerGestureBatchRef.current;
      if (gestureBatch && [...gestureBatch.objectIds].some((objectId) => ids.has(objectId))) {
        for (const objectId of gestureBatch.objectIds) ids.add(objectId);
      }

      const batchesToFlush = [...pendingObjectSyncBatchesRef.current.values()].filter(
        (batch) =>
          batch.key === batchKey || [...batch.objectIds].some((objectId) => ids.has(objectId)),
      );
      for (const batch of batchesToFlush) {
        if (batch.timer) window.clearTimeout(batch.timer);
        for (const objectId of batch.objectIds) ids.add(objectId);
        pendingObjectSyncBatchesRef.current.delete(batch.key);
      }
      if (!ids.size) return;
      const flushedTimers = new Set(
        batchesToFlush
          .map((batch) => batch.timer)
          .filter((timer): timer is number => timer !== null),
      );
      for (const objectId of ids) {
        const entry = syncCoordinatorRef.current.get(objectId);
        if (entry && entry.timer !== null && flushedTimers.has(entry.timer)) entry.timer = null;
      }
      enqueueObjectSyncBatch(ids);
    },
    [enqueueObjectSyncBatch],
  );

  const scheduleObjectSyncBatch = useCallback(
    (objectIds: Iterable<string>, requestedBatchKey?: string) => {
      const requestedIds = new Set(objectIds);
      const gestureBatch = pointerGestureBatchRef.current;
      if (
        gestureBatch &&
        [...gestureBatch.objectIds].some((objectId) => requestedIds.has(objectId))
      ) {
        for (const objectId of gestureBatch.objectIds) requestedIds.add(objectId);
      }
      for (const objectId of [...requestedIds]) {
        const entry = syncCoordinatorRef.current.get(objectId);
        if (!entry || entry.awaitingRecovery) requestedIds.delete(objectId);
      }
      if (!requestedIds.size) return;

      const overlappingBatches = [...pendingObjectSyncBatchesRef.current.values()].filter((batch) =>
        [...batch.objectIds].some((objectId) => requestedIds.has(objectId)),
      );
      const batchKey =
        requestedBatchKey ??
        overlappingBatches[0]?.key ??
        `objects:${[...requestedIds].sort().join("|")}`;
      const batch =
        pendingObjectSyncBatchesRef.current.get(batchKey) ?? {
          key: batchKey,
          objectIds: new Set<string>(),
          timer: null,
        };
      if (batch.timer) window.clearTimeout(batch.timer);
      for (const overlapping of overlappingBatches) {
        if (overlapping.timer) window.clearTimeout(overlapping.timer);
        for (const objectId of overlapping.objectIds) batch.objectIds.add(objectId);
        if (overlapping.key !== batchKey) pendingObjectSyncBatchesRef.current.delete(overlapping.key);
      }
      for (const objectId of requestedIds) batch.objectIds.add(objectId);

      const timer = window.setTimeout(() => {
        if (pendingObjectSyncBatchesRef.current.get(batchKey)?.timer !== timer) return;
        flushPendingObjectSync([], batchKey);
      }, 220);
      batch.timer = timer;
      pendingObjectSyncBatchesRef.current.set(batchKey, batch);
      for (const objectId of batch.objectIds) {
        const entry = syncCoordinatorRef.current.get(objectId);
        if (entry) entry.timer = timer;
      }
    },
    [flushPendingObjectSync],
  );

  const finishInteractionsAfterFrame = useCallback(
    (
      objectIds: Iterable<string>,
      dependentObjectIds: Iterable<string> = [],
      gestureEpochs?: ReadonlyMap<string, number>,
      gestureEpoch?: number,
    ) => {
      const ids = [...new Set(objectIds)];
      const dependencyIds = new Set(dependentObjectIds);
      if (!ids.length) return;
      const frame = window.requestAnimationFrame(() => {
        flushFramesRef.current.delete(frame);
        const readyToFlush: string[] = [];
        for (const objectId of ids) {
          if (editingObjectIdRef.current === objectId) continue;
          const expectedEpoch = gestureEpochs?.get(objectId);
          if (
            expectedEpoch !== undefined &&
            objectGestureEpochRef.current.get(objectId) !== expectedEpoch
          ) {
            continue;
          }
          const coordinator = syncCoordinatorRef.current;
          const entry = coordinator.get(objectId);
          if (entry && !entry.awaitingRecovery) {
            const shape = entry.shapeId && editor
              ? editor.getShape(entry.shapeId as TLShapeId)
              : undefined;
            const current = roomRef.current.objects[objectId];
            const draft = shape && editor ? tldrawShapeToSemantic(editor, shape) : null;
            const differsFromAuthority =
              Boolean(draft) && (!current || !isEquivalentTldrawProjection(current, draft!));
            if (
              entry.deleted ||
              (shape && (entry.dirty || dependencyIds.has(objectId) || differsFromAuthority))
            ) {
              coordinator.markDirty({
                objectId,
                shapeId: entry.shapeId,
                baseRevision: entry.baseRevision,
                baseCreatedAt: entry.baseCreatedAt,
                deleted: entry.deleted,
              });
            }
          }
          coordinator.endInteraction(objectId);
          if (expectedEpoch !== undefined) objectGestureEpochRef.current.delete(objectId);
          readyToFlush.push(objectId);
        }
        flushPendingObjectSync(
          readyToFlush,
          gestureEpoch === undefined ? undefined : `gesture:${gestureEpoch}`,
        );
        if (gestureEpoch !== undefined && pointerGestureBatchRef.current?.epoch === gestureEpoch) {
          pointerGestureBatchRef.current = null;
        }
      });
      flushFramesRef.current.add(frame);
    },
    [editor, flushPendingObjectSync],
  );

  useEffect(() => {
    if (!editor) return;
    const processDocumentChanges = (changes: DocumentRecordChanges) => {
      if (!projectingRoomRef.current) {
        const addedShapes = Object.values(changes.added).filter(isShape);
        const copiedShapeUpdates: Array<{ shape: TLShape; meta: JsonObject }> = [];
        for (const shape of addedShapes) {
          const meta = shape.meta as JsonObject;
          const copiedObjectId = jazzboardMeta(shape).objectId;
          if (copiedObjectId && shape.id !== tldrawShapeId(copiedObjectId)) {
            copiedShapeUpdates.push({ shape, meta: stripCopiedJazzboardIdentity(shape) });
            continue;
          }
          const copiedGroupId = meta.jazzboardGroupId;
          if (
            shape.type === "group" &&
            typeof copiedGroupId === "string" &&
            shape.id !== tldrawGroupShapeId(copiedGroupId)
          ) {
            copiedShapeUpdates.push({ shape, meta: { ...meta, jazzboardGroupId: null } });
          }
        }
        if (copiedShapeUpdates.length) {
          projectingRoomRef.current = true;
          try {
            editor.store.mergeRemoteChanges(() => {
              for (const { shape, meta } of copiedShapeUpdates) {
                editor.updateShape({ id: shape.id, type: shape.type, meta });
              }
            });
          } finally {
            projectingRoomRef.current = false;
          }
        }
        const changedObjectIds = new Set<string>();
        const immediateLeaseOperations = new Map<string, LeaseOperation>();
        const markedShapeIds = new Set<TLShapeId>();
        const markShapeForSync = (
          candidate: TLShape,
          includeDependencies = true,
          forceSemanticSync = false,
        ) => {
          if (markedShapeIds.has(candidate.id)) return;
          if (candidate.type === "group") {
            markedShapeIds.add(candidate.id);
            for (const childId of editor.getSortedChildIdsForParent(candidate)) {
              const child = editor.getShape(childId);
              if (child) markShapeForSync(child, includeDependencies, forceSemanticSync);
            }
            return;
          }
          let shape = editor.getShape(candidate.id) ?? candidate;
          const copiedIdentity = jazzboardMeta(shape).objectId;
          if (copiedIdentity && shape.id !== tldrawShapeId(copiedIdentity)) {
            projectingRoomRef.current = true;
            try {
              editor.store.mergeRemoteChanges(() => {
                editor.updateShape({
                  id: shape.id,
                  type: shape.type,
                  meta: stripCopiedJazzboardIdentity(shape),
                });
              });
              shape = editor.getShape(shape.id) ?? shape;
            } finally {
              projectingRoomRef.current = false;
            }
          }
          const draft = tldrawShapeToSemantic(editor, shape);
          if (!draft) return;
          const metadata = jazzboardMeta(shape);
          const current = roomRef.current.objects[draft.id];
          const baseRevision = current ? (metadata.revision ?? current.revision) : null;
          const baseCreatedAt = current?.createdAt ?? null;
          const existingEntry = syncCoordinatorRef.current.get(draft.id);
          if (existingEntry?.awaitingRecovery) {
            markedShapeIds.add(candidate.id);
            existingEntry.shapeId = String(shape.id);
            lockObjectsForRecovery([draft.id]);
            return;
          }
          const isDirectInteraction =
            pointerGestureActiveRef.current ||
            manualDocumentInputActiveRef.current ||
            editor.getEditingShapeId() === shape.id;
          const isDerivedBoundConnector =
            current?.kind === "connector" &&
            shape.type === "arrow" &&
            (current.start.objectId !== null || current.end.objectId !== null);
          if (
            current &&
            !forceSemanticSync &&
            !isDirectInteraction &&
            (isDerivedBoundConnector || isEquivalentTldrawProjection(current, draft))
          ) {
            // tldraw can emit a later user-sourced arrow/binding geometry update after a
            // remote projection. It has no semantic delta, so it must not masquerade as
            // a human edit and acquire a transient connector lease.
            return;
          }
          markedShapeIds.add(candidate.id);
          const { entry } = syncCoordinatorRef.current.markDirty({
            objectId: draft.id,
            shapeId: String(shape.id),
            baseRevision,
            baseCreatedAt,
          });
          if (pointerGestureActiveRef.current || editor.getEditingShapeId() === shape.id) {
            syncCoordinatorRef.current.beginInteraction(draft.id, baseRevision, baseCreatedAt);
            gestureObjectIdsRef.current.add(draft.id);
            if (pointerGestureActiveRef.current) {
              objectGestureEpochRef.current.set(draft.id, pointerGestureEpochRef.current);
              pointerGestureBatchRef.current?.objectIds.add(draft.id);
            }
          }
          if (!entry.awaitingRecovery) {
            changedObjectIds.add(draft.id);
            if (current && baseRevision !== null) {
              immediateLeaseOperations.set(
                draft.id,
                shape.type === "arrow" ? "connect" : semanticOperation(editor, shape, current),
              );
            }
          }
          if (includeDependencies) {
            for (const connector of boundConnectorsForTargets(editor, [shape])) {
              // A connector remains part of an atomic local node edit even when its
              // bound endpoints make the semantic snapshot look equivalent here.
              markShapeForSync(connector, false, true);
            }
          }
        };
        const scheduleAssetShapes = (assetId: string) => {
          for (const shape of editor.getCurrentPageShapes()) {
            if (shape.type === "image" && (shape as TLImageShape).props.assetId === assetId) markShapeForSync(shape);
          }
        };
        const scheduleBindingShape = (record: TLRecord) => {
          if (record.typeName !== "binding") return;
          const fromId = (record as TLRecord & { fromId?: TLShapeId }).fromId;
          const shape = fromId ? editor.getShape(fromId) : null;
          if (shape) markShapeForSync(shape);
        };
        for (const record of Object.values(changes.added)) {
          if (isShape(record)) markShapeForSync(record);
          else if (record.typeName === "asset") scheduleAssetShapes(record.id);
          else scheduleBindingShape(record);
        }
        for (const [, next] of Object.values(changes.updated)) {
          if (isShape(next)) markShapeForSync(next);
          else if (next.typeName === "asset") scheduleAssetShapes(next.id);
          else scheduleBindingShape(next);
        }
        for (const record of Object.values(changes.removed)) {
          if (!isShape(record)) {
            scheduleBindingShape(record);
            continue;
          }
          if (record.type === "group") continue;
          const metadata = jazzboardMeta(record);
          const objectId = metadata.objectId ?? objectIdForShape(record);
          const current = roomRef.current.objects[objectId];
          const baseRevision = current ? (metadata.revision ?? current.revision) : null;
          const baseCreatedAt = current?.createdAt ?? null;
          if (syncCoordinatorRef.current.get(objectId)?.awaitingRecovery) continue;
          syncCoordinatorRef.current.markDirty({
            objectId,
            shapeId: String(record.id),
            baseRevision,
            baseCreatedAt,
            deleted: true,
          });
          if (current && baseRevision !== null) immediateLeaseOperations.set(objectId, "delete");
          if (pointerGestureActiveRef.current) {
            syncCoordinatorRef.current.beginInteraction(objectId, baseRevision, baseCreatedAt);
            gestureObjectIdsRef.current.add(objectId);
            objectGestureEpochRef.current.set(objectId, pointerGestureEpochRef.current);
            pointerGestureBatchRef.current?.objectIds.add(objectId);
          }
          changedObjectIds.add(objectId);
        }
        if (pointerGestureActiveRef.current && changedObjectIds.size) {
          for (const objectId of gestureObjectIdsRef.current) {
            const entry = syncCoordinatorRef.current.get(objectId);
            const current = roomRef.current.objects[objectId];
            const shape = entry?.shapeId ? editor.getShape(entry.shapeId as TLShapeId) : undefined;
            if (!entry || entry.awaitingRecovery) continue;
            if (entry.deleted) {
              changedObjectIds.add(objectId);
              if (current && entry.baseRevision !== null) {
                immediateLeaseOperations.set(objectId, "delete");
              }
              continue;
            }
            if (!current || !shape) continue;
            syncCoordinatorRef.current.markDirty({
              objectId,
              shapeId: entry.shapeId,
              baseRevision: entry.baseRevision,
              baseCreatedAt: entry.baseCreatedAt,
            });
            immediateLeaseOperations.set(
              objectId,
              gestureDependentObjectIdsRef.current.has(objectId)
                ? "connect"
                : semanticOperation(editor, shape, current),
            );
            changedObjectIds.add(objectId);
          }
        }
        if (immediateLeaseOperations.size) {
          const requests = [...immediateLeaseOperations];
          const recoveryIds = [...changedObjectIds];
          void Promise.allSettled(
            requests.map(([objectId, operation]) => acquireLease(objectId, operation)),
          ).then((results) => {
            if (!mountedRef.current) return;
            const failed = results.find((result) => result.status === "rejected");
            if (!failed) return;
            recoverObjects(recoveryIds, failed.reason);
          });
        }
        const gestureBatch = pointerGestureBatchRef.current;
        const changedInGesture =
          gestureBatch && [...gestureBatch.objectIds].some((objectId) => changedObjectIds.has(objectId));
        const editingObjectId = editingObjectIdRef.current;
        const batchKey = changedInGesture
          ? `gesture:${gestureBatch.epoch}`
          : editingObjectId && changedObjectIds.has(editingObjectId)
            ? `edit:${editingObjectId}`
            : undefined;
        scheduleObjectSyncBatch(changedObjectIds, batchKey);
      }
    };
    const stopDocument = editor.store.listen(
      ({ changes }) => processDocumentChanges(changes),
      { source: "user", scope: "document" },
    );
    // tldraw is interactive before React installs this persistence effect (and
    // before its drawing font finishes loading). Reconcile the already-visible
    // document once after subscribing so an immediate draw or fast image
    // upload cannot be lost merely because its store event preceded the
    // listener. Authoritative projected shapes are filtered by the same
    // equivalence checks as ordinary events; only unsynchronized local work is
    // queued through the normal coordinator and debounce path.
    const existingShapes = editor.getCurrentPageShapes();
    if (existingShapes.length) {
      processDocumentChanges({
        added: Object.fromEntries(existingShapes.map((shape) => [shape.id, shape])),
        updated: {},
        removed: {},
      });
    }
    const stopSession = editor.store.listen(
      () => {
        onSelectionChange(
          editableShapesForTargets(editor, editor.getSelectedShapes())
            .map((shape) => jazzboardMeta(shape).objectId)
            .filter((id): id is string => Boolean(id)),
        );
        const editingShapeId = editor.getEditingShapeId();
        const editingShape = editingShapeId ? editor.getShape(editingShapeId) : null;
        const nextEditingObjectId = editingShape ? objectIdForShape(editingShape) : null;
        const previousEditingObjectId = editingObjectIdRef.current;
        if (previousEditingObjectId && previousEditingObjectId !== nextEditingObjectId) {
          editingObjectIdRef.current = nextEditingObjectId;
          finishInteractionsAfterFrame([previousEditingObjectId]);
        } else {
          editingObjectIdRef.current = nextEditingObjectId;
        }
        if (editingShape && nextEditingObjectId && nextEditingObjectId !== previousEditingObjectId) {
          const current = roomRef.current.objects[nextEditingObjectId];
          const revision = jazzboardMeta(editingShape).revision ?? current?.revision ?? null;
          syncCoordinatorRef.current.beginInteraction(
            nextEditingObjectId,
            revision,
            current?.createdAt ?? null,
          );
          gestureObjectIdsRef.current.add(nextEditingObjectId);
          if (revision !== null) {
            void acquireLease(nextEditingObjectId, editingShape.type === "arrow" ? "connect" : "edit").catch((error) => {
              recoverObject(nextEditingObjectId, error);
            });
          }
        }
      },
      { source: "user", scope: "session" },
    );
    return () => {
      stopDocument();
      stopSession();
    };
  }, [
    acquireLease,
    editor,
    finishInteractionsAfterFrame,
    lockObjectsForRecovery,
    onSelectionChange,
    recoverObject,
    recoverObjects,
    scheduleObjectSyncBatch,
  ]);

  const flushDetachedDirtyState = useCallback(() => {
    if (!editor || selfRef.current.role !== "participant") return new Set<string>();
    const coordinator = syncCoordinatorRef.current;
    const snapshots: Array<{
      objectId: string;
      generation: number;
      deleted: boolean;
      draft: NonNullable<ReturnType<typeof tldrawShapeToSemantic>> | null;
      operation: LeaseOperation;
      queueTail: Promise<void>;
    }> = [];
    coordinator.forEach((entry) => {
      if (!entry.dirty || entry.awaitingRecovery) return;
      const shape = entry.shapeId ? editor.getShape(entry.shapeId as TLShapeId) : undefined;
      const draft = shape ? tldrawShapeToSemantic(editor, shape) : null;
      if (!entry.deleted && !draft) return;
      const current = roomRef.current.objects[entry.objectId];
      snapshots.push({
        objectId: entry.objectId,
        generation: entry.generation,
        deleted: entry.deleted,
        draft,
        operation: shape && current ? semanticOperation(editor, shape, current) : "edit",
        queueTail: entry.queueTail,
      });
    });
    const objectIds = new Set(snapshots.map((snapshot) => snapshot.objectId));
    if (!snapshots.length) return objectIds;

    void Promise.all(snapshots.map((snapshot) => snapshot.queueTail.catch(() => undefined)))
      .then(async () => {
        const creates: CanvasCommand[] = [];
        const updates: CanvasCommand[] = [];
        const deletionTargets: Extract<CanvasCommand, { type: "delete" }>["targets"] = [];
        for (const snapshot of snapshots) {
          const entry = coordinator.get(snapshot.objectId);
          if (!entry?.dirty || entry.awaitingRecovery || entry.generation !== snapshot.generation) continue;
          const current = roomRef.current.objects[snapshot.objectId];
          const activeLeaseId = entry.lease?.lease.leaseId;
          if (snapshot.deleted) {
            if (current && entry.baseRevision === current.revision) {
              deletionTargets.push({
                objectId: snapshot.objectId,
                expectedRevision: current.revision,
                leaseId: activeLeaseId,
              });
            }
            continue;
          }
          if (!snapshot.draft) continue;
          if (!current && entry.baseRevision === null) {
            creates.push({ type: "create", object: snapshot.draft });
            continue;
          }
          if (
            current &&
            entry.baseRevision === current.revision &&
            !isEquivalentTldrawProjection(current, snapshot.draft)
          ) {
            updates.push({
              type: "update",
              objectId: snapshot.objectId,
              expectedRevision: current.revision,
              patch: patchForDraft(snapshot.draft),
              leaseId: activeLeaseId,
              operation: snapshot.operation,
            });
          }
        }
        creates.sort(
          (left, right) =>
            Number(left.type === "create" && left.object.kind === "connector") -
            Number(right.type === "create" && right.object.kind === "connector"),
        );
        const commands = [
          ...creates,
          ...updates,
          ...(deletionTargets.length ? ([{ type: "delete", targets: deletionTargets }] as CanvasCommand[]) : []),
        ];
        if (commands.length === 1) await command(commands[0]);
        else if (commands.length > 1) await semanticTransaction({ commands, diagramCommands: [] });
      })
      .catch(() => undefined)
      .finally(() => {
        for (const snapshot of snapshots) {
          const active = coordinator.get(snapshot.objectId)?.lease?.lease;
          if (active) {
            void lease({ action: "release", objectId: snapshot.objectId, leaseId: active.leaseId }).catch(
              () => undefined,
            );
          }
        }
      });
    return objectIds;
  }, [command, editor, lease, semanticTransaction]);

  useEffect(
    () => () => {
      const detachedObjectIds = flushDetachedDirtyState();
      for (const frame of flushFramesRef.current) window.cancelAnimationFrame(frame);
      flushFramesRef.current.clear();
      for (const batch of pendingObjectSyncBatchesRef.current.values()) {
        if (batch.timer) window.clearTimeout(batch.timer);
      }
      pendingObjectSyncBatchesRef.current.clear();
      outstandingSyncBatchesRef.current.clear();
      if (keyboardInteractionBatchRef.current?.timer) {
        window.clearTimeout(keyboardInteractionBatchRef.current.timer);
      }
      keyboardInteractionBatchRef.current = null;
      objectGestureEpochRef.current.clear();
      pointerGestureBatchRef.current = null;
      if (transientPresenceTimerRef.current) {
        window.clearTimeout(transientPresenceTimerRef.current);
      }
      if (durablePresenceTimerRef.current) {
        window.clearTimeout(durablePresenceTimerRef.current);
      }
      transientPresenceTimerRef.current = null;
      durablePresenceTimerRef.current = null;
      durablePresenceQueuedRef.current = false;
      for (const [timer, complete] of reconciliationWaitersRef.current) {
        window.clearTimeout(timer);
        complete();
      }
      reconciliationWaitersRef.current.clear();
      syncCoordinatorRef.current.forEach((entry) => {
        if (entry.timer) window.clearTimeout(entry.timer);
        if (entry.recoveryTimer) window.clearTimeout(entry.recoveryTimer);
        if (entry.lease?.renewTimer) window.clearInterval(entry.lease.renewTimer);
        if (entry.lease && !detachedObjectIds.has(entry.objectId)) {
          void lease({ action: "release", objectId: entry.objectId, leaseId: entry.lease.lease.leaseId }).catch(
            () => undefined,
          );
        }
      });
      recoveryGroupLocksRef.current.clear();
    },
    [flushDetachedDirtyState, lease],
  );

  const currentPresenceValue = useCallback(() => {
    if (!editor) return null;
    const camera = editor.getCamera();
    const viewport = editor.getViewportPageBounds();
    return {
      cursor: pendingCursorRef.current,
      viewport: {
        x: viewport.x,
        y: viewport.y,
        zoom: camera.z,
        width: viewport.width,
        height: viewport.height,
      },
    };
  }, [editor]);

  const sendDurablePresence = useCallback(
    (force = false) => {
      if (
        !editor ||
        !mountedRef.current ||
        document.visibilityState === "hidden"
      ) {
        return;
      }
      if (durablePresenceInFlightRef.current) {
        durablePresenceQueuedRef.current = true;
        return;
      }
      const delay = activePresenceDelay(lastDurablePresenceAtRef.current, Date.now());
      if (!force && delay > 0) {
        if (!durablePresenceTimerRef.current) {
          durablePresenceTimerRef.current = window.setTimeout(() => {
            durablePresenceTimerRef.current = null;
            durablePresenceSenderRef.current(false);
          }, delay);
        }
        return;
      }
      if (durablePresenceTimerRef.current) {
        window.clearTimeout(durablePresenceTimerRef.current);
        durablePresenceTimerRef.current = null;
      }
      const value = currentPresenceValue();
      if (!value) return;
      durablePresenceInFlightRef.current = true;
      lastDurablePresenceAtRef.current = Date.now();
      void presence(value)
        .catch(() => undefined)
        .finally(() => {
          durablePresenceInFlightRef.current = false;
          if (!mountedRef.current || !durablePresenceQueuedRef.current) return;
          durablePresenceQueuedRef.current = false;
          const remaining = activePresenceDelay(
            lastDurablePresenceAtRef.current,
            Date.now(),
          );
          durablePresenceTimerRef.current = window.setTimeout(() => {
            durablePresenceTimerRef.current = null;
            durablePresenceSenderRef.current(false);
          }, remaining);
        });
    },
    [currentPresenceValue, editor, presence],
  );

  useEffect(() => {
    durablePresenceSenderRef.current = sendDurablePresence;
  }, [sendDurablePresence]);

  const publishPresence = useCallback(
    (cursor: { x: number; y: number } | null) => {
      if (!editor || document.visibilityState === "hidden") return;
      pendingCursorRef.current = cursor;
      if (!transientPresenceTimerRef.current) {
        transientPresenceTimerRef.current = window.setTimeout(() => {
          transientPresenceTimerRef.current = null;
          const value = currentPresenceValue();
          if (value) transientPresence(value);
        }, TRANSIENT_PRESENCE_INTERVAL_MS);
      }
      sendDurablePresence(false);
    },
    [currentPresenceValue, editor, sendDurablePresence, transientPresence],
  );

  useEffect(() => {
    if (!editor) return;
    return editor.store.listen(
      ({ changes }) => {
        const cameraChanged = [...Object.values(changes.added), ...Object.values(changes.updated).map(([, next]) => next)]
          .some((record) => record.typeName === "camera");
        if (cameraChanged) publishPresence(pendingCursorRef.current);
      },
      { scope: "session" },
    );
  }, [editor, publishPresence]);

  useEffect(() => {
    if (!editor) return;
    const heartbeat = window.setInterval(() => {
      if (
        document.visibilityState !== "hidden" &&
        idlePresenceKeyframeDue(lastDurablePresenceAtRef.current, Date.now())
      ) {
        sendDurablePresence(true);
      }
    }, IDLE_PRESENCE_KEYFRAME_MS);
    return () => window.clearInterval(heartbeat);
  }, [editor, sendDurablePresence]);

  useEffect(() => {
    if (!editor || connection !== "live") return;
    sendDurablePresence(true);
  }, [connection, editor, sendDurablePresence]);

  useEffect(() => {
    if (!editor) return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const value = currentPresenceValue();
      if (value) transientPresence(value);
      sendDurablePresence(true);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [currentPresenceValue, editor, sendDurablePresence, transientPresence]);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!editor) return;
      const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
      pendingCursorRef.current = { x: point.x, y: point.y };
      publishPresence(pendingCursorRef.current);
    },
    [editor, publishPresence],
  );

  const flagManualDocumentInput = useCallback(() => {
    const epoch = ++manualDocumentInputEpochRef.current;
    manualDocumentInputActiveRef.current = true;
    queueMicrotask(() => {
      if (manualDocumentInputEpochRef.current === epoch) {
        manualDocumentInputActiveRef.current = false;
      }
    });
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!editor) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".tlui-layout")) flagManualDocumentInput();
      if (
        target?.closest(
          "button, a, input, textarea, select, [role='button'], [role='menuitem'], [contenteditable='true']",
        )
      ) {
        return;
      }
      if (followTarget) onExitFollow();
      if (selfRef.current.role !== "participant") return;
      pointerGestureActiveRef.current = true;
      const gestureEpoch = ++pointerGestureEpochRef.current;
      pointerGestureBatchRef.current = { epoch: gestureEpoch, objectIds: new Set() };
      gestureObjectIdsRef.current.clear();
      gestureDependentObjectIdsRef.current.clear();
      const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
      const hit = editor.getShapeAtPoint(point, { hitInside: true, margin: 8 });
      if (!hit) return;
      const selected = editor.getSelectedShapes();
      const targets = selected.some((shape) => shape.id === hit.id) ? selected : [hit];
      const directShapes = editableShapesForTargets(editor, targets);
      const dependentConnectors = boundConnectorsForTargets(editor, directShapes);
      const dependentShapeIds = new Set(dependentConnectors.map((shape) => shape.id));
      const gestureShapes = new Map<TLShapeId, TLShape>(
        [...directShapes, ...dependentConnectors].map((shape) => [shape.id, shape]),
      );
      const gestureShapeObjectIds = new Set(
        [...gestureShapes.values()]
          .map((shape) => jazzboardMeta(shape).objectId)
          .filter((objectId): objectId is string => Boolean(objectId)),
      );
      const keyboardBatch = keyboardInteractionBatchRef.current;
      if (
        keyboardBatch &&
        [...keyboardBatch.objectIds].some((objectId) => gestureShapeObjectIds.has(objectId))
      ) {
        if (keyboardBatch.timer) window.clearTimeout(keyboardBatch.timer);
        keyboardInteractionBatchRef.current = null;
        for (const objectId of keyboardBatch.objectIds) {
          const entry = syncCoordinatorRef.current.get(objectId);
          if (!entry || entry.awaitingRecovery) continue;
          entry.interactionActive = true;
          objectGestureEpochRef.current.set(objectId, gestureEpoch);
          gestureObjectIdsRef.current.add(objectId);
          pointerGestureBatchRef.current.objectIds.add(objectId);
        }
        for (const objectId of keyboardBatch.dependentObjectIds) {
          gestureDependentObjectIdsRef.current.add(objectId);
        }
      }
      const leaseRequests: Array<{ objectId: string; operation: LeaseOperation }> = [];
      for (const shape of gestureShapes.values()) {
        const { objectId, revision } = jazzboardMeta(shape);
        const current = objectId ? roomRef.current.objects[objectId] : undefined;
        if (!objectId || revision === null || !current) continue;
        const existing = syncCoordinatorRef.current.get(objectId);
        if (existing?.awaitingRecovery) continue;
        if (dependentShapeIds.has(shape.id)) {
          gestureDependentObjectIdsRef.current.add(objectId);
        }
        const entry = syncCoordinatorRef.current.beginInteraction(objectId, revision, current.createdAt);
        entry.shapeId = String(shape.id);
        objectGestureEpochRef.current.set(objectId, gestureEpoch);
        gestureObjectIdsRef.current.add(objectId);
        pointerGestureBatchRef.current.objectIds.add(objectId);
        const inferredOperation = semanticOperation(editor, shape, current);
        const operation =
          shape.type === "arrow"
            ? "connect"
            : inferredOperation === "edit"
              ? "move"
              : inferredOperation;
        leaseRequests.push({ objectId, operation });
      }
      if (leaseRequests.length) {
        scheduleObjectSyncBatch(gestureDependentObjectIdsRef.current, `gesture:${gestureEpoch}`);
        void Promise.allSettled(
          leaseRequests.map(({ objectId, operation }) => acquireLease(objectId, operation)),
        ).then((results) => {
          const failed = results.find((result) => result.status === "rejected");
          if (!failed) return;
          recoverObjects(leaseRequests.map(({ objectId }) => objectId), failed.reason);
        });
      }
    },
    [
      acquireLease,
      editor,
      flagManualDocumentInput,
      followTarget,
      onExitFollow,
      recoverObjects,
      scheduleObjectSyncBatch,
    ],
  );

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!editor || selfRef.current.role !== "participant") return;
      const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
      const hit = editor.getShapeAtPoint(point, { hitInside: true, margin: 8 });
      if (!hit) return;
      const { objectId, revision } = jazzboardMeta(hit);
      if (!objectId || revision === null) return;
      syncCoordinatorRef.current.beginInteraction(
        objectId,
        revision,
        roomRef.current.objects[objectId]?.createdAt ?? null,
      );
      gestureObjectIdsRef.current.add(objectId);
      void acquireLease(objectId, hit.type === "arrow" ? "connect" : "edit").catch((error) => {
        recoverObject(objectId, error);
      });
    },
    [acquireLease, editor, recoverObject],
  );

  const handlePointerUp = useCallback(() => {
    pointerGestureActiveRef.current = false;
    const objectIds = [...gestureObjectIdsRef.current];
    const dependentObjectIds = [...gestureDependentObjectIdsRef.current];
    const gestureEpochs = new Map(
      objectIds.map((objectId) => [objectId, objectGestureEpochRef.current.get(objectId) ?? -1]),
    );
    const gestureEpoch = pointerGestureBatchRef.current?.epoch;
    gestureObjectIdsRef.current.clear();
    gestureDependentObjectIdsRef.current.clear();
    finishInteractionsAfterFrame(objectIds, dependentObjectIds, gestureEpochs, gestureEpoch);
  }, [finishInteractionsAfterFrame]);

  const exitFollowForManualViewControl = useCallback(() => {
    if (followTarget) onExitFollow();
  }, [followTarget, onExitFollow]);

  const handleClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".tlui-layout")) flagManualDocumentInput();
    },
    [flagManualDocumentInput],
  );

  const handleKeyDownCapture = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      const isTldrawInput = Boolean(target?.closest("[data-tldraw]"));
      if (isTldrawInput) flagManualDocumentInput();
      exitFollowForManualViewControl();
      if (
        !editor ||
        !isTldrawInput ||
        selfRef.current.role !== "participant" ||
        !["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)
      ) {
        return;
      }

      // tldraw may coalesce a rapid keyboard nudge and its inverse into one
      // semantically unchanged store notification. Protect the selection at
      // key-down so the lease lifecycle remains correct even in that case.
      const directShapes = editableShapesForTargets(editor, editor.getSelectedShapes());
      const dependentConnectors = boundConnectorsForTargets(editor, directShapes);
      const dependentIds = new Set(
        dependentConnectors
          .map((shape) => jazzboardMeta(shape).objectId)
          .filter((objectId): objectId is string => Boolean(objectId)),
      );
      const shapes = new Map<TLShapeId, TLShape>(
        [...directShapes, ...dependentConnectors].map((shape) => [shape.id, shape]),
      );
      const objectIds: string[] = [];
      const leaseRequests: Array<{ objectId: string; operation: LeaseOperation }> = [];
      for (const shape of shapes.values()) {
        const { objectId, revision } = jazzboardMeta(shape);
        const current = objectId ? roomRef.current.objects[objectId] : undefined;
        if (!objectId || revision === null || !current) continue;
        const existing = syncCoordinatorRef.current.get(objectId);
        if (existing?.awaitingRecovery) continue;
        const entry = syncCoordinatorRef.current.beginInteraction(
          objectId,
          revision,
          current.createdAt,
        );
        entry.shapeId = String(shape.id);
        objectIds.push(objectId);
        leaseRequests.push({
          objectId,
          operation: shape.type === "arrow" ? "connect" : "move",
        });
      }
      if (!objectIds.length) return;
      void Promise.allSettled(
        leaseRequests.map(({ objectId, operation }) => acquireLease(objectId, operation)),
      ).then((results) => {
        const failed = results.find((result) => result.status === "rejected");
        if (failed) recoverObjects(objectIds, failed.reason);
      });
      const interactionObjectIds = [...new Set(objectIds)];
      const interactionKey = [...interactionObjectIds].sort().join("|");
      const previousKeyboardBatch = keyboardInteractionBatchRef.current;
      if (previousKeyboardBatch && previousKeyboardBatch.key !== interactionKey) {
        if (previousKeyboardBatch.timer) window.clearTimeout(previousKeyboardBatch.timer);
        keyboardInteractionBatchRef.current = null;
        finishInteractionsAfterFrame(
          previousKeyboardBatch.objectIds,
          previousKeyboardBatch.dependentObjectIds,
          new Map(
            [...previousKeyboardBatch.objectIds].map((objectId) => [
              objectId,
              previousKeyboardBatch.epoch,
            ]),
          ),
        );
      }
      const currentKeyboardBatch = keyboardInteractionBatchRef.current;
      if (currentKeyboardBatch?.timer) window.clearTimeout(currentKeyboardBatch.timer);
      const keyboardEpoch = currentKeyboardBatch?.epoch ?? ++pointerGestureEpochRef.current;
      const keyboardObjectIds = new Set(currentKeyboardBatch?.objectIds);
      const keyboardDependentObjectIds = new Set(currentKeyboardBatch?.dependentObjectIds);
      for (const objectId of interactionObjectIds) {
        keyboardObjectIds.add(objectId);
        objectGestureEpochRef.current.set(objectId, keyboardEpoch);
      }
      for (const objectId of dependentIds) keyboardDependentObjectIds.add(objectId);
      const timer = window.setTimeout(() => {
        if (keyboardInteractionBatchRef.current?.timer !== timer) return;
        keyboardInteractionBatchRef.current = null;
        finishInteractionsAfterFrame(
          keyboardObjectIds,
          keyboardDependentObjectIds,
          new Map(
            [...keyboardObjectIds].map((objectId) => [objectId, keyboardEpoch]),
          ),
        );
      }, 220);
      keyboardInteractionBatchRef.current = {
        key: interactionKey,
        epoch: keyboardEpoch,
        objectIds: keyboardObjectIds,
        dependentObjectIds: keyboardDependentObjectIds,
        timer,
      };
    },
    [
      acquireLease,
      editor,
      exitFollowForManualViewControl,
      finishInteractionsAfterFrame,
      flagManualDocumentInput,
      recoverObjects,
    ],
  );

  const prepareSelectionForAgentMessage = useCallback(async () => {
    if (!editor || !mountedRef.current) {
      throw new Error("The canvas is still starting. Try Ask again in a moment.");
    }
    editor.complete();
    const keyboardBatch = keyboardInteractionBatchRef.current;
    if (keyboardBatch) {
      if (keyboardBatch.timer) window.clearTimeout(keyboardBatch.timer);
      keyboardInteractionBatchRef.current = null;
      finishInteractionsAfterFrame(
        keyboardBatch.objectIds,
        keyboardBatch.dependentObjectIds,
        new Map([...keyboardBatch.objectIds].map((objectId) => [objectId, keyboardBatch.epoch])),
      );
    }
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    if (!mountedRef.current) throw new Error("The canvas closed before the selection could be saved.");

    const selectedShapes = editableShapesForTargets(editor, editor.getSelectedShapes());
    const drafts = new Map<string, NonNullable<ReturnType<typeof tldrawShapeToSemantic>>>();
    for (const shape of selectedShapes) {
      const draft = tldrawShapeToSemantic(editor, shape);
      if (!draft) continue;
      drafts.set(draft.id, draft);
      const current = roomRef.current.objects[draft.id];
      const existing = syncCoordinatorRef.current.get(draft.id);
      if (existing?.awaitingRecovery) {
        throw new Error(`Canvas item ${draft.id} is recovering from a save conflict. Try Ask again shortly.`);
      }
      if (!current || !isEquivalentTldrawProjection(current, draft)) {
        syncCoordinatorRef.current.markDirty({
          objectId: draft.id,
          shapeId: String(shape.id),
          baseRevision: current?.revision ?? null,
          baseCreatedAt: current?.createdAt ?? null,
        });
      }
      syncCoordinatorRef.current.endInteraction(draft.id);
    }
    const objectIds = [...drafts.keys()];
    const authoritative = await flushCanvasSelectionToRoom({
      objectIds,
      flush: () => flushPendingObjectSync(objectIds),
      queueTails: () => {
        const tails: Promise<void>[] = [];
        syncCoordinatorRef.current.forEach((entry) => tails.push(entry.queueTail));
        return tails;
      },
      isUnsettled: (objectId) => {
        const entry = syncCoordinatorRef.current.get(objectId);
        return Boolean(entry && (
          entry.interactionActive
          || entry.dirty
          || entry.awaitingRecovery
          || entry.timer !== null
          || entry.queuedTasks > 0
        ));
      },
      refresh: async () => advanceRoomRef(await refresh()),
      isAuthoritative: (nextRoom, objectId) => {
        const object = nextRoom.objects[objectId];
        const draft = drafts.get(objectId);
        return Boolean(object && draft && isEquivalentTldrawProjection(object, draft));
      },
    });
    return { objectIds, room: authoritative };
  }, [advanceRoomRef, editor, finishInteractionsAfterFrame, flushPendingObjectSync, refresh]);

  useImperativeHandle(ref, () => ({ prepareSelectionForAgentMessage }), [prepareSelectionForAgentMessage]);

  return (
    <div
      className={styles.canvasShell}
      data-testid="jazzboard-canvas"
      onPointerMove={handlePointerMove}
      onPointerDownCapture={handlePointerDown}
      onClickCapture={handleClickCapture}
      onDoubleClickCapture={handleDoubleClick}
      onPointerUpCapture={handlePointerUp}
      onPointerCancelCapture={handlePointerUp}
      onWheelCapture={exitFollowForManualViewControl}
      onKeyDownCapture={handleKeyDownCapture}
    >
      <Tldraw
        key={self.role}
        assets={assetStore}
        autoFocus
        components={self.role === "spectator" ? SPECTATOR_COMPONENTS : undefined}
        overrides={[JAZZBOARD_UI_OVERRIDES]}
        onMount={(mountedEditor) => {
          mountedEditor.updateInstanceState({ isReadonly: self.role === "spectator" });
          void mountedEditor.fonts
            .ensureFontIsLoaded(DefaultFontFaces.tldraw_draw.normal.normal)
            .then(() => {
              if (mountedEditor.isDisposed) return;
              setEditor(mountedEditor);
              onEditorChange(mountedEditor);
            });
        }}
      />
      <CanvasPresenceOverlay editor={editor} room={room} selfId={self.participantId} />
      {uploadProgress !== null ? (
        <div className={styles.uploadProgress} role="status">
          <span>Adding image</span>
          <span>{Math.round(uploadProgress)}%</span>
          <i style={{ width: `${uploadProgress}%` }} />
        </div>
      ) : null}
    </div>
  );
});

function CanvasPresenceOverlay({ editor, room, selfId }: { editor: Editor | null; room: RoomState; selfId: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 120);
    return () => window.clearInterval(timer);
  }, []);
  if (!editor) return null;

  return (
    <div className={styles.presenceOverlay} aria-hidden="true">
      {Object.values(room.participants).flatMap((participant) => {
        const items: React.ReactNode[] = [];
        if (participant.participantId !== selfId && participant.human.cursor && now - participant.human.lastSeenAt < 12_000) {
          const point = editor.pageToViewport(participant.human.cursor);
          items.push(
            <div
              className={styles.humanCursor}
              key={`${participant.participantId}:human`}
              style={{ transform: `translate(${point.x}px, ${point.y}px)`, color: participant.color }}
            >
              <MousePointer2 size={22} fill="white" strokeWidth={2.5} />
              <span style={{ background: participant.color }}>{participant.displayName}</span>
            </div>,
          );
        }
        if (participant.agentActive && participant.agent.cursor) {
          const activity = participant.agent.activity;
          const elapsed = activity ? Math.max(now - activity.startedAt, 0) : 0;
          const duration = activity?.durationMs ?? 1;
          const progress = activity ? Math.min(elapsed / duration, 1) : 1;
          const from = activity?.fromCursor ?? participant.agent.cursor;
          const to = activity?.toCursor ?? participant.agent.cursor;
          const cursor = {
            x: from.x + (to.x - from.x) * progress,
            y: from.y + (to.y - from.y) * progress,
          };
          const point = editor.pageToViewport(cursor);
          items.push(
            <div
              className={styles.agentCursor}
              data-testid={`agent-cursor-${participant.participantId}`}
              data-activity-progress={Math.round(progress * 100)}
              key={`${participant.participantId}:agent`}
              style={{ transform: `translate(${point.x}px, ${point.y}px)`, color: participant.color }}
            >
              <Bot size={19} />
              <span style={{ background: participant.color }}>
                {participant.displayName} · agent
                {activity && elapsed < duration + 1_600 ? ` · ${activity.label} · ${Math.round(progress * 100)}%` : ""}
              </span>
            </div>,
          );
          if (activity && elapsed < duration + 600) {
            for (const objectId of activity.objectIds) {
              const bounds = editor.getShapePageBounds(tldrawShapeId(objectId));
              if (!bounds) continue;
              const topLeft = editor.pageToViewport({ x: bounds.x, y: bounds.y });
              const bottomRight = editor.pageToViewport({ x: bounds.maxX, y: bounds.maxY });
              items.push(
                <div
                  className={styles.agentWorkOutline}
                  key={`${participant.participantId}:work:${objectId}`}
                  style={{
                    left: topLeft.x,
                    top: topLeft.y,
                    width: Math.max(bottomRight.x - topLeft.x, 1),
                    height: Math.max(bottomRight.y - topLeft.y, 1),
                    borderColor: participant.color,
                    color: participant.color,
                    "--agent-progress": progress,
                    "--agent-progress-percent": `${Math.round(progress * 100)}%`,
                  } as React.CSSProperties}
                />,
              );
            }
          }
        }
        return items;
      })}
      {Object.values(room.leases).map((activeLease) => {
        if (activeLease.expiresAt <= now) return null;
        const bounds = editor.getShapePageBounds(tldrawShapeId(activeLease.objectId));
        if (!bounds) return null;
        const topLeft = editor.pageToViewport({ x: bounds.x, y: bounds.y });
        const bottomRight = editor.pageToViewport({ x: bounds.maxX, y: bounds.maxY });
        return (
          <div
            className={styles.leaseOutline}
            key={activeLease.leaseId}
            style={{
              left: topLeft.x,
              top: topLeft.y,
              width: Math.max(bottomRight.x - topLeft.x, 1),
              height: Math.max(bottomRight.y - topLeft.y, 1),
              borderColor: activeLease.actor.color,
            }}
          >
            <span style={{ background: activeLease.actor.color }}>
              <LockKeyhole size={11} />
              {activeLease.actor.displayName}
              {activeLease.actor.kind === "agent" ? "’s agent" : ""} · {activeLease.operation}
            </span>
          </div>
        );
      })}
    </div>
  );
}
