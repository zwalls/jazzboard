"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, LockKeyhole, MousePointer2 } from "lucide-react";
import {
  Tldraw,
  type Editor,
  type TLComponents,
  type TLImageShape,
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
  tldrawShapeToSemantic,
  tldrawShapeId,
} from "@/lib/canvas/projection";
import type {
  ActorKind,
  CanvasCommand,
  FollowTarget,
  ObjectPatch,
  ObjectLease,
  Participant,
  RoomState,
} from "@/lib/domain/types";
import type { LeaseAction } from "@/hooks/use-room";

import styles from "./room.module.css";

type CommandResult = { room: RoomState; changedObjectIds: string[] };

type Props = {
  room: RoomState;
  self: Participant;
  followTarget: FollowTarget;
  command: (command: CanvasCommand, actorKind?: ActorKind) => Promise<CommandResult>;
  lease: (action: LeaseAction, actorKind?: ActorKind) => Promise<ObjectLease | null>;
  presence: (
    value: {
      cursor: { x: number; y: number } | null;
      viewport: { x: number; y: number; zoom: number; width: number; height: number } | null;
    },
    actorKind?: ActorKind,
  ) => Promise<RoomState>;
  onSelectionChange: (objectIds: string[]) => void;
  onEditorChange: (editor: Editor | null) => void;
  onExitFollow: () => void;
  onError: (message: string, details?: unknown) => void;
};

type ActiveLease = { lease: ObjectLease; renewTimer: number | null };

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

export function JazzboardCanvas({
  room,
  self,
  followTarget,
  command,
  lease,
  presence,
  onSelectionChange,
  onEditorChange,
  onExitFollow,
  onError,
}: Props) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const roomRef = useRef(room);
  const selfRef = useRef(self);
  const timersRef = useRef(new Map<string, number>());
  const queuesRef = useRef(new Map<string, Promise<void>>());
  const activeLeasesRef = useRef(new Map<string, ActiveLease>());
  const projectingRoomRef = useRef(false);
  const presenceTimerRef = useRef<number | null>(null);
  const pendingCursorRef = useRef<{ x: number; y: number } | null>(null);
  const assetStore = useMemo(
    () =>
      createJazzboardAssetStore(room.id, (progress) => {
        setUploadProgress(progress);
        if (progress >= 100) window.setTimeout(() => setUploadProgress(null), 700);
      }),
    [room.id],
  );

  useEffect(() => {
    roomRef.current = room;
    selfRef.current = self;
  }, [room, self]);

  useEffect(() => {
    if (!editor) return;
    editor.updateInstanceState({ isReadonly: self.role === "spectator" });
  }, [editor, self.role]);

  useEffect(() => {
    if (!editor) return;
    projectingRoomRef.current = true;
    try {
      projectRoomIntoTldraw(editor, room, new Set(activeLeasesRef.current.keys()));
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

  const releaseLease = useCallback(
    async (objectId: string) => {
      const active = activeLeasesRef.current.get(objectId);
      if (!active) return;
      activeLeasesRef.current.delete(objectId);
      if (active.renewTimer) window.clearInterval(active.renewTimer);
      await lease({ action: "release", objectId, leaseId: active.lease.leaseId }).catch(() => undefined);
    },
    [lease],
  );

  const acquireLease = useCallback(
    async (objectId: string, operation: "move" | "resize" | "edit" | "connect" | "delete" | "annotate") => {
      const active = activeLeasesRef.current.get(objectId);
      if (active?.lease.operation === operation) return active.lease;
      const object = roomRef.current.objects[objectId];
      if (!object) return null;
      const acquired = await lease({
        action: "acquire",
        objectId,
        expectedRevision: object.revision,
        operation,
      });
      if (!acquired) return null;
      if (active?.renewTimer) window.clearInterval(active.renewTimer);
      const leaseState: ActiveLease = { lease: acquired, renewTimer: null };
      leaseState.renewTimer = window.setInterval(() => {
        void lease({ action: "renew", objectId, leaseId: acquired.leaseId })
          .then((renewed) => {
            if (renewed) leaseState.lease = renewed;
          })
          .catch(() => {
            if (leaseState.renewTimer) window.clearInterval(leaseState.renewTimer);
            activeLeasesRef.current.delete(objectId);
          });
      }, 1_500);
      activeLeasesRef.current.set(objectId, leaseState);
      return acquired;
    },
    [lease],
  );

  const enqueue = useCallback((objectId: string, task: () => Promise<void>) => {
    const previous = queuesRef.current.get(objectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    queuesRef.current.set(objectId, next);
    void next.finally(() => {
      if (queuesRef.current.get(objectId) === next) queuesRef.current.delete(objectId);
    });
  }, []);

  const syncShape = useCallback(
    async (shapeId: TLShapeId) => {
      if (!editor || selfRef.current.role !== "participant") return;
      const shape = editor.getShape(shapeId);
      if (!shape) return;
      const draft = tldrawShapeToSemantic(editor, shape);
      if (!draft) return;
      const current = roomRef.current.objects[draft.id];
      try {
        if (!current) {
          const result = await command({ type: "create", object: draft });
          roomRef.current = result.room;
          return;
        }
        if (isEquivalentTldrawProjection(current, draft)) return;
        const hadActiveLease = activeLeasesRef.current.has(draft.id);
        const inferredOperation = semanticOperation(editor, shape, current);
        const currentLeaseOperation = activeLeasesRef.current.get(draft.id)?.lease.operation;
        const operation = inferredOperation === "edit" && currentLeaseOperation
          ? currentLeaseOperation
          : inferredOperation;
        const active = await acquireLease(draft.id, operation);
        if (!active) return;
        const patch: Record<string, unknown> = { ...draft };
        delete patch.id;
        delete patch.kind;
        const result = await command({
          type: "update",
          objectId: draft.id,
          expectedRevision: current.revision,
          patch: patch as ObjectPatch,
          leaseId: active.leaseId,
          operation,
        });
        roomRef.current = result.room;
        if (!hadActiveLease && editor.getEditingShapeId() !== shape.id) await releaseLease(draft.id);
      } catch (error) {
        if (isBusyError(error)) {
          editor.cancel();
          onError(error.message, error.failure.details);
        } else {
          onError(error instanceof Error ? error.message : "The canvas change could not be saved.");
        }
      }
    },
    [acquireLease, command, editor, onError, releaseLease],
  );

  const scheduleSync = useCallback(
    (shapeId: TLShapeId) => {
      const key = String(shapeId);
      const existing = timersRef.current.get(key);
      if (existing) window.clearTimeout(existing);
      timersRef.current.set(
        key,
        window.setTimeout(() => {
          timersRef.current.delete(key);
          enqueue(key, () => syncShape(shapeId));
        }, 220),
      );
    },
    [enqueue, syncShape],
  );

  const syncDeletion = useCallback(
    (shape: TLShape) => {
      if (selfRef.current.role !== "participant") return;
      const { objectId, revision } = jazzboardMeta(shape);
      if (!objectId || !revision) return;
      enqueue(objectId, async () => {
        try {
          const active = await acquireLease(objectId, "delete");
          if (!active) return;
          const result = await command({
            type: "delete",
            targets: [{ objectId, expectedRevision: revision, leaseId: active.leaseId }],
          });
          roomRef.current = result.room;
          await releaseLease(objectId);
        } catch (error) {
          onError(error instanceof Error ? error.message : "The object could not be deleted.");
        }
      });
    },
    [acquireLease, command, enqueue, onError, releaseLease],
  );

  useEffect(() => {
    if (!editor) return;
    const stopDocument = editor.store.listen(
      ({ changes }) => {
        if (projectingRoomRef.current) return;
        const scheduleAssetShapes = (assetId: string) => {
          for (const shape of editor.getCurrentPageShapes()) {
            if (shape.type === "image" && (shape as TLImageShape).props.assetId === assetId) scheduleSync(shape.id);
          }
        };
        for (const record of Object.values(changes.added)) {
          if (isShape(record)) scheduleSync(record.id);
          else if (record.typeName === "asset") scheduleAssetShapes(record.id);
        }
        for (const [, next] of Object.values(changes.updated)) {
          if (isShape(next)) scheduleSync(next.id);
          else if (next.typeName === "asset") scheduleAssetShapes(next.id);
        }
        for (const record of Object.values(changes.removed)) if (isShape(record)) syncDeletion(record);
      },
      { source: "user", scope: "document" },
    );
    const stopSession = editor.store.listen(
      () => {
        onSelectionChange(
          editor
            .getSelectedShapes()
            .map((shape) => jazzboardMeta(shape).objectId)
            .filter((id): id is string => Boolean(id)),
        );
        const editingShapeId = editor.getEditingShapeId();
        for (const [objectId, active] of activeLeasesRef.current) {
          if (active.lease.operation === "edit" && editingShapeId !== tldrawShapeId(objectId)) {
            void releaseLease(objectId);
          }
        }
      },
      { source: "user", scope: "session" },
    );
    return () => {
      stopDocument();
      stopSession();
    };
  }, [editor, onSelectionChange, releaseLease, scheduleSync, syncDeletion]);

  useEffect(
    () => () => {
      for (const timeout of timersRef.current.values()) window.clearTimeout(timeout);
      for (const [objectId, active] of activeLeasesRef.current) {
        if (active.renewTimer) window.clearInterval(active.renewTimer);
        void lease({ action: "release", objectId, leaseId: active.lease.leaseId }).catch(() => undefined);
      }
    },
    [lease],
  );

  const publishPresence = useCallback(
    (cursor: { x: number; y: number } | null) => {
      if (!editor || presenceTimerRef.current) return;
      pendingCursorRef.current = cursor;
      presenceTimerRef.current = window.setTimeout(() => {
        presenceTimerRef.current = null;
        const camera = editor.getCamera();
        const viewport = editor.getViewportPageBounds();
        void presence({
          cursor: pendingCursorRef.current,
          viewport: { x: viewport.x, y: viewport.y, zoom: camera.z, width: viewport.width, height: viewport.height },
        }).catch(() => undefined);
      }, 90);
    },
    [editor, presence],
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
    const heartbeat = window.setInterval(() => publishPresence(pendingCursorRef.current), 8_000);
    return () => window.clearInterval(heartbeat);
  }, [editor, publishPresence]);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!editor) return;
      const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
      pendingCursorRef.current = { x: point.x, y: point.y };
      publishPresence(pendingCursorRef.current);
    },
    [editor, publishPresence],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!editor) return;
      if (followTarget) onExitFollow();
      if (selfRef.current.role !== "participant") return;
      const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
      const hit = editor.getShapeAtPoint(point, { hitInside: true, margin: 8 });
      if (!hit) return;
      const { objectId } = jazzboardMeta(hit);
      if (!objectId) return;
      const current = roomRef.current.objects[objectId];
      if (!current) return;
      const inferredOperation = semanticOperation(editor, hit, current);
      const operation = inferredOperation === "edit" && hit.type !== "text" && hit.type !== "note"
        ? "move"
        : inferredOperation;
      void acquireLease(objectId, operation).catch((error) => {
        editor.cancel();
        onError(error instanceof Error ? error.message : "That object is busy.");
      });
    },
    [acquireLease, editor, followTarget, onError, onExitFollow],
  );

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!editor || selfRef.current.role !== "participant") return;
      const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
      const hit = editor.getShapeAtPoint(point, { hitInside: true, margin: 8 });
      if (!hit) return;
      const { objectId } = jazzboardMeta(hit);
      if (!objectId) return;
      void acquireLease(objectId, hit.type === "arrow" ? "connect" : "edit").catch((error) => {
        editor.cancel();
        onError(error instanceof Error ? error.message : "That object is busy.");
      });
    },
    [acquireLease, editor, onError],
  );

  const handlePointerUp = useCallback(() => {
    window.setTimeout(() => {
      const editingShapeId = editor?.getEditingShapeId();
      for (const [objectId, active] of activeLeasesRef.current) {
        if (active.lease.operation !== "edit" || editingShapeId !== tldrawShapeId(objectId)) {
          void releaseLease(objectId);
        }
      }
    }, 420);
  }, [editor, releaseLease]);

  const exitFollowForManualViewControl = useCallback(() => {
    if (followTarget) onExitFollow();
  }, [followTarget, onExitFollow]);

  return (
    <div
      className={styles.canvasShell}
      data-testid="jazzboard-canvas"
      onPointerMove={handlePointerMove}
      onPointerDownCapture={handlePointerDown}
      onDoubleClickCapture={handleDoubleClick}
      onPointerUpCapture={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheelCapture={exitFollowForManualViewControl}
      onKeyDownCapture={exitFollowForManualViewControl}
    >
      <Tldraw
        key={self.role}
        assets={assetStore}
        autoFocus
        components={self.role === "spectator" ? SPECTATOR_COMPONENTS : undefined}
        overrides={[JAZZBOARD_UI_OVERRIDES]}
        onMount={(mountedEditor) => {
          setEditor(mountedEditor);
          onEditorChange(mountedEditor);
          mountedEditor.updateInstanceState({ isReadonly: self.role === "spectator" });
          projectRoomIntoTldraw(mountedEditor, room);
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
}

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
