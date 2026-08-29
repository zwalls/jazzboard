"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  ArrowLeft,
  Download,
  ListTree,
  Maximize2,
  Menu,
  MessageCircle,
  Minus,
  Plus,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";

import {
  clampCanvasZoom,
  fitBoundsInViewport,
  viewportToPagePoint,
  zoomViewportAtPoint,
} from "@/lib/canvas/camera";
import {
  SemanticConnectorSessionEngine,
  type SemanticConnectorPointerTarget,
  type SemanticConnectorSessionToken,
} from "@/lib/canvas/semantic-connector-session";
import {
  SemanticCreateSessionEngine,
  type SemanticCreateSession,
  type SemanticCreateSessionToken,
} from "@/lib/canvas/semantic-create-session";
import {
  SemanticCanvasEditController,
  type SemanticEditControllerRollback,
} from "@/lib/canvas/semantic-edit-controller";
import {
  SemanticImageSessionEngine,
} from "@/lib/canvas/semantic-image-session";
import {
  decodeSemanticCanvasClipboard,
  encodeSemanticCanvasClipboard,
  normalizeSemanticCanvasShortcut,
  SEMANTIC_CANVAS_CLIPBOARD_FORMAT,
  selectAllSemanticObjectIds,
  SemanticKeyboardSessionEngine,
  type SemanticCanvasClipboardPayload,
} from "@/lib/canvas/semantic-keyboard-session";
import {
  SemanticMoveSessionEngine,
  type SemanticMoveSessionToken,
} from "@/lib/canvas/semantic-move-session";
import { SemanticPresencePublisher } from "@/lib/canvas/semantic-presence-publisher";
import { createSemanticCanvasRuntime } from "@/lib/canvas/semantic-runtime";
import { buildSemanticScene } from "@/lib/canvas/semantic-scene";
import {
  hitTestSemanticScene,
  hitTestSemanticSceneObjects,
  SemanticMarqueeSelectionSessionEngine,
  type SemanticMarqueeSession,
  type SemanticMarqueeToken,
  type SemanticSelectionIntent,
} from "@/lib/canvas/semantic-selection-session";
import {
  SemanticTextEditSessionEngine,
  type SemanticTextEditSession,
  type SemanticTextEditSessionToken,
} from "@/lib/canvas/semantic-text-edit-session";
import {
  applySemanticObjectStyles,
  SemanticTransformSessionEngine,
  type SemanticObjectStylePatch,
  type SemanticResizeHandle,
  type SemanticTransformToken,
} from "@/lib/canvas/semantic-transform-session";
import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { SemanticCanvasEditEvent } from "@/lib/canvas/semantic-edit-events";
import { JazzboardApiError } from "@/lib/client/api";
import { formatRoomCode } from "@/lib/domain/room-code";
import type {
  ConnectorRoutingInput,
  Point,
  RoomState,
  Viewport,
} from "@/lib/domain/types";

import { AgentDraftLayer } from "./AgentDraftLayer";
import { CanvasPresenceOverlay } from "./CanvasPresenceOverlay";
import type {
  CanvasSurfaceHandle,
  CanvasSurfaceProps,
  SemanticCanvasEditingHost,
} from "./canvas-surface-types";
import {
  SemanticCanvasContextMenu,
  type SemanticCanvasContextMenuActionId,
  type SemanticCanvasContextMenuItem,
} from "./SemanticCanvasContextMenu";
import {
  SemanticCanvasConnectorOverlay,
  SemanticCanvasObject,
} from "./SemanticCanvasObject";
import {
  SemanticImagePicker,
  type SemanticImagePickerHandle,
  type SemanticImagePickerReady,
} from "./SemanticImagePicker";
import {
  SemanticSelectionControls,
  type SemanticTransformPointerStart,
} from "./SemanticSelectionControls";
import {
  SemanticStyleControls,
  type SemanticStyleEditRequest,
} from "./SemanticStyleControls";
import { SemanticTextEditor } from "./SemanticTextEditor";
import {
  SemanticToolPalette,
  type SemanticCanvasTool,
  type SemanticConnectorDirectionIntent,
  type SemanticConnectorRoutingIntent,
} from "./SemanticToolPalette";
import styles from "./semantic-canvas.module.css";

export type SemanticCanvasProps = Pick<
  CanvasSurfaceProps,
  | "boardMenuActions"
  | "persistentChromeHost"
  | "room"
  | "agentDrafts"
  | "self"
  | "followTarget"
  | "presence"
  | "transientPresence"
  | "connection"
  | "onSelectionChange"
  | "onRuntimeChange"
  | "onExitFollow"
> & {
  editing?: SemanticCanvasEditingHost | null;
  renameRoom?: CanvasSurfaceProps["renameRoom"];
};

type PanState = {
  pointerId: number;
  clientX: number;
  clientY: number;
  viewport: Viewport;
};

type ActiveMovePointer = Readonly<{
  pointerId: number;
  gestureId: string;
  token: SemanticMoveSessionToken;
  captured: boolean;
}>;

type ActiveCreatePointer = Readonly<{
  pointerId: number;
  gestureId: string;
  objectId: string;
  token: SemanticCreateSessionToken;
  tool: Extract<SemanticCanvasTool, "draw" | "rectangle" | "ellipse" | "diamond">;
}>;

type ActiveConnectorPointer = Readonly<{
  pointerId: number;
  gestureId: string;
  objectId: string;
  token: SemanticConnectorSessionToken;
}>;

type ActiveMarqueePointer = Readonly<{
  pointerId: number;
  token: SemanticMarqueeToken;
}>;

type ActiveExistingTextEditor = Readonly<{
  mode: "edit";
  gestureId: string;
  objectId: string;
  token: SemanticTextEditSessionToken;
  session: SemanticTextEditSession;
}>;

type ActiveCreatedTextEditor = Readonly<{
  mode: "create";
  gestureId: string;
  objectId: string;
  token: SemanticCreateSessionToken;
  session: SemanticCreateSession;
}>;

type ActiveTextEditor = ActiveExistingTextEditor | ActiveCreatedTextEditor;

type ActiveTransformPointer = Readonly<{
  pointerId: number;
  gestureId: string;
  token: SemanticTransformToken;
}>;

type ActiveConnectorEndpointPointer = Readonly<{
  pointerId: number;
  gestureId: string;
  objectId: string;
  token: SemanticConnectorSessionToken;
}>;

type CanvasContextMenuState = Readonly<{
  objectId: string | null;
  x: number;
  y: number;
}>;

const CONTEXT_MENU_MARGIN = 8;

const emptySubscribe = () => () => undefined;
let fallbackSemanticId = 0;

function semanticDocumentKey(room: RoomState): string {
  // Aggregate room envelopes may replace object-map references for presence or
  // lease updates. A structural document key keeps that coordination traffic
  // from rebuilding routes and bounds while still observing every optimistic
  // pixel (whose object revision intentionally remains unchanged until ack).
  return `${room.id}\u0000${room.roomRevision}\u0000${JSON.stringify(room.objects)}\u0000${JSON.stringify(room.diagrams)}`;
}

function useSemanticSceneProjection(
  room: RoomState,
  optimisticConnectorIds: ReadonlySet<string> | undefined,
) {
  const optimisticConnectorKey = optimisticConnectorIds?.size
    ? [...optimisticConnectorIds].sort().join("\u0000")
    : "";
  const documentKey = semanticDocumentKey(room);
  return useMemo(
    () => buildSemanticScene(room, {
      optimisticConnectorIds: optimisticConnectorKey
        ? new Set(optimisticConnectorKey.split("\u0000"))
        : undefined,
    }),
    // The structural document key deliberately replaces aggregate RoomState
    // identity. Presence and lease envelopes do not belong in this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentKey, optimisticConnectorKey],
  );
}

function withCount(label: string, count: number, suffix: string): string {
  return count ? `${label} · ${count} ${suffix}` : label;
}

function connectorRoutingInput(intent: SemanticConnectorRoutingIntent): ConnectorRoutingInput {
  if (intent === "curved") return { mode: "curved", bend: 64 };
  if (intent === "elbow") return { mode: "elbow", elbowMidPoint: 0.5 };
  return { mode: intent };
}

function physicalSize(viewport: Viewport) {
  return { width: viewport.width * viewport.zoom, height: viewport.height * viewport.zoom };
}

function viewportWithPhysicalSize(viewport: Viewport, width: number, height: number): Viewport {
  const zoom = clampCanvasZoom(viewport.zoom);
  return { ...viewport, width: width / zoom, height: height / zoom, zoom };
}

function InlineRoomTitle({
  editable,
  renameRoom,
  title,
}: {
  editable: boolean;
  renameRoom?: CanvasSurfaceProps["renameRoom"];
  title: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusTriggerAfterSaveRef = useRef(false);
  const savingRef = useRef(false);
  const skipNextBlurRef = useRef(false);
  const [draft, setDraft] = useState(title);
  const [startingTitle, setStartingTitle] = useState(title);
  const [editingTitle, setEditingTitle] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editingTitle) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingTitle]);

  const finishEditing = useCallback((focusTrigger: boolean) => {
    setEditingTitle(false);
    setError(null);
    if (focusTrigger) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const saveTitle = useCallback(async (focusTrigger: boolean) => {
    if (savingRef.current || !renameRoom) return;
    const nextTitle = draft.trim();
    if (!nextTitle) {
      setError("Enter a room name.");
      if (focusTrigger) window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (nextTitle === title) {
      finishEditing(focusTrigger);
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await renameRoom(nextTitle, startingTitle);
      setDraft(nextTitle);
      finishEditing(focusTrigger);
    } catch (renameError) {
      if (renameError instanceof JazzboardApiError && renameError.failure.code === "REVISION_CONFLICT") {
        const actualTitle = renameError.failure.details?.actualTitle;
        if (typeof actualTitle === "string") setStartingTitle(actualTitle);
      }
      setError(renameError instanceof Error ? renameError.message : "Jazzboard could not rename this room.");
      if (focusTrigger) window.requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [draft, finishEditing, renameRoom, startingTitle, title]);

  if (!editable || !renameRoom) {
    return <strong className={styles.roomTitleText}>{title}</strong>;
  }

  if (!editingTitle) {
    return (
      <button
        ref={triggerRef}
        aria-label={`Edit room title, currently ${title}`}
        className={styles.roomTitleButton}
        onClick={() => {
          focusTriggerAfterSaveRef.current = false;
          skipNextBlurRef.current = false;
          setDraft(title);
          setStartingTitle(title);
          setError(null);
          setEditingTitle(true);
        }}
        title="Edit room title"
        type="button"
      >
        <span>{title}</span>
      </button>
    );
  }

  return (
    <form
      className={styles.roomTitleEditor}
      onSubmit={(event) => {
        event.preventDefault();
        inputRef.current?.blur();
      }}
    >
      <input
        ref={inputRef}
        aria-describedby={error ? "semantic-room-title-error" : undefined}
        aria-busy={saving}
        aria-invalid={Boolean(error)}
        aria-label="Room name"
        disabled={saving}
        maxLength={100}
        onChange={(event) => {
          setDraft(event.target.value);
          if (error) setError(null);
        }}
        onBlur={() => {
          if (skipNextBlurRef.current) {
            skipNextBlurRef.current = false;
            return;
          }
          const focusTrigger = focusTriggerAfterSaveRef.current;
          focusTriggerAfterSaveRef.current = false;
          void saveTitle(focusTrigger);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            focusTriggerAfterSaveRef.current = true;
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            focusTriggerAfterSaveRef.current = false;
            skipNextBlurRef.current = true;
            setDraft(title);
            finishEditing(true);
          }
        }}
        value={draft}
      />
      {error ? <span id="semantic-room-title-error" role="alert">{error}</span> : null}
    </form>
  );
}

export const SemanticCanvas = forwardRef<CanvasSurfaceHandle, SemanticCanvasProps>(function SemanticCanvas({
  boardMenuActions,
  persistentChromeHost = null,
  room,
  agentDrafts = [],
  self,
  renameRoom,
  followTarget,
  presence,
  transientPresence,
  connection,
  onSelectionChange,
  onRuntimeChange,
  onExitFollow,
  editing = null,
}, ref) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const editingHostRef = useRef(editing);
  const onExitFollowRef = useRef(onExitFollow);
  const presenceRef = useRef(presence);
  const transientPresenceRef = useRef(transientPresence);
  const presencePublisherRef = useRef<SemanticPresencePublisher | null>(null);
  const controllerRef = useRef<SemanticCanvasEditController | null>(null);
  const mountedControllerRef = useRef<SemanticCanvasEditController | null>(null);
  const moveEngineRef = useRef(new SemanticMoveSessionEngine());
  const createEngineRef = useRef(new SemanticCreateSessionEngine());
  const connectorEngineRef = useRef(new SemanticConnectorSessionEngine());
  const transformEngineRef = useRef(new SemanticTransformSessionEngine());
  const imageEngineRef = useRef(new SemanticImageSessionEngine());
  const keyboardEngineRef = useRef(new SemanticKeyboardSessionEngine());
  const marqueeEngineRef = useRef(new SemanticMarqueeSelectionSessionEngine());
  const textEngineRef = useRef(new SemanticTextEditSessionEngine());
  const activeMoveRef = useRef<ActiveMovePointer | null>(null);
  const activeCreateRef = useRef<ActiveCreatePointer | null>(null);
  const activeConnectorRef = useRef<ActiveConnectorPointer | null>(null);
  const activeMarqueeRef = useRef<ActiveMarqueePointer | null>(null);
  const activeTextRef = useRef<ActiveTextEditor | null>(null);
  const activeTransformRef = useRef<ActiveTransformPointer | null>(null);
  const activeConnectorEndpointRef = useRef<ActiveConnectorEndpointPointer | null>(null);
  const imagePickerRef = useRef<SemanticImagePickerHandle | null>(null);
  const clipboardRef = useRef<string | null>(null);
  const clipboardSummaryRef = useRef<string | null>(null);
  const previousConnectionRef = useRef(connection);
  const spaceHeldRef = useRef(false);
  const rollbackHandlerRef = useRef<(rollback: SemanticEditControllerRollback) => void>(() => undefined);
  const commitTextEditRef = useRef<() => void>(() => undefined);
  const editingEnabled = Boolean(editing && self.role === "participant");

  editingHostRef.current = editing;
  onExitFollowRef.current = onExitFollow;
  presenceRef.current = presence;
  transientPresenceRef.current = transientPresence;

  const controller = useMemo(() => {
    if (!editingEnabled) return null;
    const currentHost = () => {
      const host = editingHostRef.current;
      if (!host) throw new Error("Semantic canvas editing host is unavailable.");
      return host;
    };
    return new SemanticCanvasEditController({
      room,
      self,
      host: {
        command: (...args) => currentHost().command(...args),
        semanticTransaction: (...args) => currentHost().semanticTransaction(...args),
        lease: (...args) => currentHost().lease(...args),
        leaseMany: (...args) => currentHost().leaseMany(...args),
        refresh: () => currentHost().refresh(),
        onError: (...args) => currentHost().onError(...args),
        onRollback: (rollback) => rollbackHandlerRef.current(rollback),
      },
    });
    // Editing callbacks intentionally do not participate in this identity.
    // JazzboardRoom recreates its host object as room state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingEnabled, room.id, self.participantId]);
  controllerRef.current = controller;

  useLayoutEffect(() => {
    controller?.acceptRoom(room);
  }, [controller, room]);

  useLayoutEffect(() => {
    mountedControllerRef.current = controller;
    return () => {
      if (mountedControllerRef.current === controller) mountedControllerRef.current = null;
      // React development Strict Mode replays effect setup/cleanup while
      // preserving memoized values. Defer terminal disposal one microtask so
      // the replayed setup can reclaim the same controller. A real unmount or
      // controller replacement leaves it unclaimed and disposes it exactly once.
      queueMicrotask(() => {
        if (controller && mountedControllerRef.current !== controller) controller.dispose();
      });
    };
  }, [controller]);

  const subscribeProjectedRoom = useCallback(
    (listener: () => void) => controller ? controller.subscribe(listener) : emptySubscribe(),
    [controller],
  );
  const getProjectedRoom = useCallback(
    () => controller?.getSnapshot() ?? room,
    [controller, room],
  );
  const projectedRoom = useSyncExternalStore(
    subscribeProjectedRoom,
    getProjectedRoom,
    getProjectedRoom,
  );
  const [activeTextEditor, setActiveTextEditor] = useState<ActiveTextEditor | null>(null);
  const renderedRoom = useMemo<RoomState>(() => {
    if (activeTextEditor?.mode !== "create" || activeTextEditor.session.draft.kind !== "text") {
      return projectedRoom;
    }
    const draft = activeTextEditor.session.draft;
    const actor = {
      participantId: self.participantId,
      displayName: self.displayName,
      color: self.color,
      kind: "human" as const,
    };
    const provisional = {
      ...draft,
      revision: 0,
      diagramIds: [],
      createdAt: projectedRoom.updatedAt,
      updatedAt: projectedRoom.updatedAt,
      createdBy: actor,
      lastEditedBy: actor,
    };
    return {
      ...projectedRoom,
      objects: { ...projectedRoom.objects, [draft.id]: provisional },
    };
  }, [activeTextEditor, projectedRoom, self.color, self.displayName, self.participantId]);
  const roomRef = useRef(controller?.getAuthoritativeRoom() ?? room);
  const scene = useSemanticSceneProjection(
    renderedRoom,
    controller?.optimisticConnectorIds(),
  );
  const sceneRef = useRef(scene);
  const [selection, setSelection] = useState<string[]>([]);
  const selectionRef = useRef<readonly string[]>(selection);
  const [focusedObjectId, setFocusedObjectId] = useState<string | null>(null);
  const [tabStopObjectId, setTabStopObjectId] = useState<string | null>(null);
  const pendingFocusObjectIdRef = useRef<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<PanState | null>(null);
  const pointerPageRef = useRef<{ x: number; y: number } | null>(null);
  const initialFitRoomRef = useRef<string | null>(null);
  const documentListenersRef = useRef(new Set<() => void>());
  const [viewport, setViewport] = useState<Viewport>({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    zoom: 1,
  });
  const viewportRef = useRef(viewport);
  const [activeTool, setActiveTool] = useState<SemanticCanvasTool>("select");
  const activeToolRef = useRef<SemanticCanvasTool>(activeTool);
  const [connectorRouting, setConnectorRouting] = useState<SemanticConnectorRoutingIntent>("auto");
  const connectorRoutingRef = useRef<SemanticConnectorRoutingIntent>(connectorRouting);
  const [connectorDirection, setConnectorDirection] = useState<SemanticConnectorDirectionIntent>("end");
  const connectorDirectionRef = useRef<SemanticConnectorDirectionIntent>(connectorDirection);
  const [activeMarqueeSession, setActiveMarqueeSession] = useState<SemanticMarqueeSession | null>(null);
  const selectionSet = useMemo(() => new Set(selection), [selection]);
  const objectNavigation = useMemo(() => {
    const objectIds = scene.objects.map(({ object }) => object.id);
    return {
      objectIds,
      indexById: new Map(objectIds.map((objectId, index) => [objectId, index])),
    };
  }, [scene]);
  const effectiveTabStopObjectId = tabStopObjectId && scene.objectsById[tabStopObjectId]
    ? tabStopObjectId
    : objectNavigation.objectIds[0] ?? null;
  const historyState = controller?.historyState() ?? null;
  const historyReplayReady = Boolean(
    historyState
    && !historyState.replayPending
    && historyState.pendingHumanTransactions === 0,
  );
  const canUndo = Boolean(historyReplayReady && historyState?.canUndo);
  const canRedo = Boolean(historyReplayReady && historyState?.canRedo);
  const activeContextMenu = contextMenu
    && (contextMenu.objectId === null || scene.objectsById[contextMenu.objectId])
    ? contextMenu
    : null;

  roomRef.current = controller?.getAuthoritativeRoom() ?? room;
  sceneRef.current = scene;
  selectionRef.current = selection;
  viewportRef.current = viewport;
  activeToolRef.current = activeTool;
  connectorRoutingRef.current = connectorRouting;
  connectorDirectionRef.current = connectorDirection;

  rollbackHandlerRef.current = (rollback) => {
    const activeMove = activeMoveRef.current;
    const activeMoveObjectIds = moveEngineRef.current.current()?.objectIds ?? [];
    if (
      activeMove
      && (
        rollback.gestureId === activeMove.gestureId
        || rollback.objectIds.some((id) => activeMoveObjectIds.includes(id))
      )
    ) {
      moveEngineRef.current.rollback(
        activeMove.token,
        controllerRef.current?.getAuthoritativeRoom() ?? roomRef.current,
        rollback.error instanceof Error ? rollback.error.message : null,
      );
      if (activeMove.captured) releasePointerCapture(activeMove.pointerId);
      activeMoveRef.current = null;
    }
    const activeCreate = activeCreateRef.current;
    if (
      activeCreate
      && (
        rollback.gestureId === activeCreate.gestureId
        || rollback.objectIds.includes(activeCreate.objectId)
      )
    ) {
      releasePointerCapture(activeCreate.pointerId);
      activeCreateRef.current = null;
      createEngineRef.current = new SemanticCreateSessionEngine();
      setActiveTool("select");
    }
    const activeConnector = activeConnectorRef.current;
    if (
      activeConnector
      && (
        rollback.gestureId === activeConnector.gestureId
        || rollback.objectIds.includes(activeConnector.objectId)
      )
    ) {
      releasePointerCapture(activeConnector.pointerId);
      activeConnectorRef.current = null;
      connectorEngineRef.current = new SemanticConnectorSessionEngine();
      setActiveTool("select");
    }
    const activeEndpoint = activeConnectorEndpointRef.current;
    if (
      activeEndpoint
      && (rollback.gestureId === activeEndpoint.gestureId || rollback.objectIds.includes(activeEndpoint.objectId))
    ) {
      releasePointerCapture(activeEndpoint.pointerId);
      activeConnectorEndpointRef.current = null;
      connectorEngineRef.current = new SemanticConnectorSessionEngine();
    }
    const activeTransform = activeTransformRef.current;
    const transformedIds = transformEngineRef.current.current()?.objectIds ?? [];
    if (
      activeTransform
      && (rollback.gestureId === activeTransform.gestureId || rollback.objectIds.some((id) => transformedIds.includes(id)))
    ) {
      transformEngineRef.current.abort(activeTransform.token);
      releasePointerCapture(activeTransform.pointerId);
      activeTransformRef.current = null;
    }
    const activeText = activeTextRef.current;
    if (
      activeText
      && (rollback.gestureId === activeText.gestureId || rollback.objectIds.includes(activeText.objectId))
    ) {
      if (activeText.mode === "edit") textEngineRef.current.cancel(activeText.token);
      else createEngineRef.current = new SemanticCreateSessionEngine();
      activeTextRef.current = null;
      setActiveTextEditor(null);
    }
    if (imageEngineRef.current.current()?.objectIds.some((id) => rollback.objectIds.includes(id))) {
      imageEngineRef.current = new SemanticImageSessionEngine();
    }
  };

  const focusObjectElement = useCallback((objectId: string) => {
    const element = document.getElementById(objectId);
    if (!(element instanceof SVGElement) || !shellRef.current?.contains(element)) return false;
    element.focus();
    return document.activeElement === element;
  }, []);

  const requestObjectFocus = useCallback((objectId: string | null) => {
    pendingFocusObjectIdRef.current = objectId;
    setTabStopObjectId(objectId);
    if (!objectId) return;
    queueMicrotask(() => {
      if (pendingFocusObjectIdRef.current !== objectId) return;
      if (focusObjectElement(objectId)) pendingFocusObjectIdRef.current = null;
    });
  }, [focusObjectElement]);

  const updateSelection = useCallback((objectIds: readonly string[]) => {
    const projected = controllerRef.current?.getSnapshot();
    const next = [...new Set(objectIds)].filter((objectId) => Boolean(
      sceneRef.current.objectsById[objectId] || projected?.objects[objectId],
    ));
    selectionRef.current = next;
    setSelection(next);
    onSelectionChange(next);
  }, [onSelectionChange]);

  const updateViewport = useCallback((next: Viewport) => {
    viewportRef.current = next;
    setViewport(next);
    presencePublisherRef.current?.notifyChanged();
  }, []);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const wheelSurface = shell.closest<HTMLElement>("[data-jazzboard-room]") ?? shell;

    const handleNativeWheel = (event: globalThis.WheelEvent) => {
      // macOS trackpad pinch is delivered as a cancelable ctrl+wheel stream.
      // This listener must remain explicitly non-passive so the browser never
      // applies page/visual-viewport zoom in addition to Jazzboard camera zoom.
      const isPinch = event.ctrlKey || event.metaKey;
      if (!isPinch && !(event.target instanceof Node && shell.contains(event.target))) return;
      event.preventDefault();
      setContextMenu(null);
      onExitFollowRef.current();

      if (isPinch) {
        const rect = shell.getBoundingClientRect();
        const factor = Math.exp(-event.deltaY * 0.0025);
        updateViewport(zoomViewportAtPoint(
          viewportRef.current,
          viewportRef.current.zoom * factor,
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
        ));
        return;
      }

      updateViewport({
        ...viewportRef.current,
        x: viewportRef.current.x + event.deltaX / viewportRef.current.zoom,
        y: viewportRef.current.y + event.deltaY / viewportRef.current.zoom,
      });
    };

    wheelSurface.addEventListener("wheel", handleNativeWheel, { capture: true, passive: false });
    return () => wheelSurface.removeEventListener("wheel", handleNativeWheel, { capture: true });
  }, [updateViewport]);

  const runtime = useMemo<CanvasRuntime>(() => createSemanticCanvasRuntime({
    getRoom: () => roomRef.current,
    getScene: () => sceneRef.current,
    getViewport: () => viewportRef.current,
    setViewport: (next) => updateViewport(next),
    getSelection: () => selectionRef.current,
    setSelection: (objectIds) => {
      updateSelection(objectIds);
      requestObjectFocus(objectIds.find((objectId) => Boolean(sceneRef.current.objectsById[objectId])) ?? null);
    },
    onDocumentChange: (listener) => {
      documentListenersRef.current.add(listener);
      return () => documentListenersRef.current.delete(listener);
    },
    isProjectionAuthoritative: (objectId) => controllerRef.current?.isProjectionAuthoritative(objectId) ?? true,
  }), [requestObjectFocus, updateSelection, updateViewport]);

  useEffect(() => {
    onRuntimeChange(runtime);
    return () => onRuntimeChange(null);
  }, [onRuntimeChange, runtime]);

  useEffect(() => {
    for (const listener of documentListenersRef.current) listener();
    updateSelection(selectionRef.current);
  }, [scene, updateSelection]);

  useLayoutEffect(() => {
    const pending = pendingFocusObjectIdRef.current;
    const next = pending && scene.objectsById[pending]
      ? pending
      : effectiveTabStopObjectId;
    if (next !== tabStopObjectId) setTabStopObjectId(next);
    if (pending && scene.objectsById[pending] && focusObjectElement(pending)) {
      pendingFocusObjectIdRef.current = null;
    }
  }, [effectiveTabStopObjectId, focusObjectElement, scene, tabStopObjectId]);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const dismissOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuButtonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [menuOpen]);

  useEffect(() => {
    if (!contextMenu) return;
    const dismissOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-semantic-context-menu="true"]')) return;
      setContextMenu(null);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [contextMenu]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const resize = () => {
      const rect = shell.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const resized = viewportWithPhysicalSize(viewportRef.current, rect.width, rect.height);
      if (initialFitRoomRef.current !== projectedRoom.id && sceneRef.current.bounds) {
        initialFitRoomRef.current = projectedRoom.id;
        updateViewport(fitBoundsInViewport(sceneRef.current.bounds, resized, { padding: 96 }));
      } else updateViewport(resized);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [projectedRoom.id, updateViewport]);

  useEffect(() => {
    if (!followTarget) return;
    const followed = projectedRoom.participants[followTarget.participantId]?.[followTarget.kind].viewport;
    if (!followed) return;
    const physical = physicalSize(viewportRef.current);
    const width = physical.width / followed.zoom;
    const height = physical.height / followed.zoom;
    updateViewport({
      x: followed.x + followed.width / 2 - width / 2,
      y: followed.y + followed.height / 2 - height / 2,
      width,
      height,
      zoom: followed.zoom,
    });
  }, [followTarget, projectedRoom.participants, updateViewport]);

  useEffect(() => {
    const publisher = new SemanticPresencePublisher({
      current: () => ({ cursor: pointerPageRef.current, viewport: viewportRef.current }),
      transient: (value) => transientPresenceRef.current(value),
      durable: (value) => presenceRef.current(value),
      isVisible: () => document.visibilityState !== "hidden",
    });
    presencePublisherRef.current = publisher;
    // Mounting a hydrated room surface is the first live keyframe. A reconnect
    // edge can use the same publisher once CanvasSurface forwards connection.
    if (previousConnectionRef.current === "live") publisher.connectionBecameLive();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") publisher.becameVisible();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (presencePublisherRef.current === publisher) presencePublisherRef.current = null;
      publisher.dispose();
    };
  }, [room.id, self.participantId]);

  useEffect(() => {
    const previous = previousConnectionRef.current;
    previousConnectionRef.current = connection;
    if (connection === "live" && previous !== "live") {
      presencePublisherRef.current?.connectionBecameLive();
    }
  }, [connection]);

  commitTextEditRef.current = commitTextEdit;

  useImperativeHandle(ref, () => ({
    async prepareSelectionForAgentMessage() {
      if (hasActivePointerSession()) {
        throw new Error("Finish the active canvas gesture before asking an agent about this selection.");
      }
      if (activeTextRef.current) commitTextEditRef.current();
      const objectIds = [...selectionRef.current];
      await controller?.flushAndDrain(objectIds);
      return {
        objectIds,
        room: controller?.getAuthoritativeRoom() ?? roomRef.current,
      };
    },
  }), [controller]);

  useLayoutEffect(() => {
    clipboardRef.current = null;
    clipboardSummaryRef.current = null;
    activeTextRef.current = null;
    // Controller identity is the room/authorization boundary; transient UI
    // state must be cleared in the same lifecycle boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTextEditor(null);
    setActiveMarqueeSession(null);
    setContextMenu(null);
    if (!controller) setActiveTool("select");
    return () => {
      const activeMove = activeMoveRef.current;
      if (activeMove?.captured) releasePointerCapture(activeMove.pointerId);
      const activeCreate = activeCreateRef.current;
      if (activeCreate) releasePointerCapture(activeCreate.pointerId);
      const activeConnector = activeConnectorRef.current;
      if (activeConnector) releasePointerCapture(activeConnector.pointerId);
      const activeMarquee = activeMarqueeRef.current;
      if (activeMarquee) releasePointerCapture(activeMarquee.pointerId);
      const pan = panRef.current;
      if (pan) releasePointerCapture(pan.pointerId);
      activeMoveRef.current = null;
      activeCreateRef.current = null;
      activeConnectorRef.current = null;
      activeMarqueeRef.current = null;
      activeTextRef.current = null;
      const activeTransform = activeTransformRef.current;
      if (activeTransform) {
        transformEngineRef.current.abort(activeTransform.token);
        releasePointerCapture(activeTransform.pointerId);
      }
      const activeEndpoint = activeConnectorEndpointRef.current;
      if (activeEndpoint) releasePointerCapture(activeEndpoint.pointerId);
      activeTransformRef.current = null;
      activeConnectorEndpointRef.current = null;
      panRef.current = null;
      spaceHeldRef.current = false;
      moveEngineRef.current = new SemanticMoveSessionEngine();
      createEngineRef.current = new SemanticCreateSessionEngine();
      connectorEngineRef.current = new SemanticConnectorSessionEngine();
      marqueeEngineRef.current = new SemanticMarqueeSelectionSessionEngine();
      textEngineRef.current = new SemanticTextEditSessionEngine();
      transformEngineRef.current = new SemanticTransformSessionEngine();
      imageEngineRef.current = new SemanticImageSessionEngine();
    };
  }, [controller]);

  function fitBoard() {
    if (!scene.bounds) return;
    onExitFollow();
    updateViewport(fitBoundsInViewport(scene.bounds, viewportRef.current, { padding: 96 }));
  }

  function zoomAtCenter(multiplier: number) {
    onExitFollow();
    const physical = physicalSize(viewportRef.current);
    updateViewport(zoomViewportAtPoint(
      viewportRef.current,
      viewportRef.current.zoom * multiplier,
      { x: physical.width / 2, y: physical.height / 2 },
    ));
  }

  function selectObject(objectId: string, additive: boolean) {
    const object = sceneRef.current.objectsById[objectId]?.object;
    if (!object) return;
    const cohort = object.groupId
      ? sceneRef.current.groupMembers[object.groupId] ?? [objectId]
      : [objectId];
    if (!additive) {
      if (selectionRef.current.includes(objectId)) return;
      updateSelection(cohort);
      return;
    }
    const current = new Set(selectionRef.current);
    const remove = cohort.every((id) => current.has(id));
    cohort.forEach((id) => remove ? current.delete(id) : current.add(id));
    updateSelection([...current]);
  }

  function selectAndFocusObject(objectId: string, additive: boolean) {
    selectObject(objectId, additive);
    requestObjectFocus(objectId);
  }

  function pointerPage(event: { clientX: number; clientY: number }) {
    const rect = shellRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return viewportToPagePoint(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      viewportRef.current,
    );
  }

  function releasePointerCapture(pointerId: number) {
    const shell = shellRef.current;
    if (!shell) return;
    if (typeof shell.hasPointerCapture !== "function" || shell.hasPointerCapture(pointerId)) {
      shell.releasePointerCapture?.(pointerId);
    }
  }

  function dispatchEditEvents(events: readonly SemanticCanvasEditEvent[]) {
    const currentController = controllerRef.current;
    if (!currentController) return;
    for (const event of events) currentController.dispatch(event);
  }

  function hasActivePointerSession(): boolean {
    return Boolean(
      activeMoveRef.current
      || activeCreateRef.current
      || activeConnectorRef.current
      || activeMarqueeRef.current
      || activeTransformRef.current
      || activeConnectorEndpointRef.current
      || panRef.current,
    );
  }

  function createObjectId(prefix: "shape" | "draw" | "text" | "connector" | "image"): string {
    const currentRoom = controllerRef.current?.getSnapshot() ?? roomRef.current;
    let candidate = "";
    do {
      const suffix = typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}_${++fallbackSemanticId}`;
      candidate = `${prefix}_${suffix}`;
    } while (currentRoom.objects[candidate] || currentRoom.diagrams[candidate]);
    return candidate;
  }

  function createGroupId(prefix = "group"): string {
    return `${prefix}_${typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}_${++fallbackSemanticId}`}`;
  }

  function nextObjectZIndex(): number {
    const currentRoom = controllerRef.current?.getSnapshot() ?? roomRef.current;
    return Math.min(
      1_000_000,
      Math.max(0, ...Object.values(currentRoom.objects).map((object) => object.zIndex)) + 1,
    );
  }

  function reportAuthoringError(error: unknown) {
    const message = error instanceof Error ? error.message : "The canvas tool could not complete that action.";
    editingHostRef.current?.onError(message, error);
  }

  function chooseTool(tool: SemanticCanvasTool) {
    if (tool === "image") {
      pointerPageRef.current ??= {
        x: viewportRef.current.x + viewportRef.current.width / 2,
        y: viewportRef.current.y + viewportRef.current.height / 2,
      };
      imagePickerRef.current?.open();
    }
    setActiveTool(tool);
  }

  function startPan(input: Readonly<{
    pointerId: number;
    clientX: number;
    clientY: number;
  }>) {
    if (hasActivePointerSession() || activeTextRef.current) return;
    onExitFollow();
    panRef.current = {
      pointerId: input.pointerId,
      clientX: input.clientX,
      clientY: input.clientY,
      viewport: viewportRef.current,
    };
    shellRef.current?.setPointerCapture?.(input.pointerId);
    setPanning(true);
  }

  function selectionIntent(event: Readonly<{
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
  }>): SemanticSelectionIntent {
    if (event.metaKey || event.ctrlKey) return "toggle";
    if (event.shiftKey) return "add";
    return "replace";
  }

  function startMarquee(input: Readonly<{
    pointerId: number;
    clientX: number;
    clientY: number;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
  }>) {
    if (hasActivePointerSession() || activeTextRef.current) return;
    const start = pointerPage(input);
    if (!start) return;
    onExitFollow();
    const result = marqueeEngineRef.current.begin(sceneRef.current, {
      pointerStart: start,
      selectedObjectIds: selectionRef.current,
      intent: selectionIntent(input),
      groupMode: "group",
      zoom: viewportRef.current.zoom,
    });
    activeMarqueeRef.current = { pointerId: input.pointerId, token: result.session.token };
    setActiveMarqueeSession(result.session);
    shellRef.current?.setPointerCapture?.(input.pointerId);
  }

  function updateMarquee(event: PointerEvent<HTMLDivElement>): boolean {
    const active = activeMarqueeRef.current;
    if (!active || active.pointerId !== event.pointerId) return false;
    const point = pointerPage(event);
    if (!point) return true;
    const result = marqueeEngineRef.current.updatePointer(active.token, point);
    if (result.status === "updated") {
      setActiveMarqueeSession(result.session);
      updateSelection(result.session.selectedObjectIds);
    }
    return true;
  }

  function finishMarquee(event: PointerEvent<HTMLDivElement>, cancel = false): boolean {
    const active = activeMarqueeRef.current;
    if (!active || active.pointerId !== event.pointerId) return false;
    const result = cancel
      ? marqueeEngineRef.current.cancel(active.token)
      : marqueeEngineRef.current.finish(active.token, pointerPage(event) ?? undefined);
    if (result.status === "finished") updateSelection(result.session.selectedObjectIds);
    else if (result.status === "cancelled") updateSelection(result.selectedObjectIds);
    releasePointerCapture(active.pointerId);
    activeMarqueeRef.current = null;
    setActiveMarqueeSession(null);
    return true;
  }

  function startObjectMove(input: Readonly<{
    objectId: string;
    pointerId: number;
    clientX: number;
    clientY: number;
    additive: boolean;
  }>) {
    const currentController = controllerRef.current;
    if (!currentController || activeTextRef.current || hasActivePointerSession()) return;
    const start = pointerPage(input);
    if (!start) return;
    onExitFollow();
    const result = moveEngineRef.current.begin({
      room: currentController.getSnapshot(),
      selectedObjectIds: selectionRef.current.includes(input.objectId)
        ? selectionRef.current
        : [input.objectId],
      pointerStart: start,
    });
    if (result.superseded) dispatchEditEvents(result.superseded.lifecycleEvents);
    if (result.status === "blocked") return;
    // Protection is installed in this exact pointer-down call stack, before
    // the lease manager begins any asynchronous work.
    currentController.dispatch(result.lifecycleEvent);
    activeMoveRef.current = {
      pointerId: input.pointerId,
      gestureId: result.session.gestureId,
      token: result.session.token,
      captured: false,
    };
  }

  function updateObjectMove(event: PointerEvent<HTMLDivElement>): boolean {
    const active = activeMoveRef.current;
    const currentController = controllerRef.current;
    if (!active || active.pointerId !== event.pointerId || !currentController) return false;
    const point = pointerPage(event);
    if (!point) return true;
    if (!active.captured) {
      shellRef.current?.setPointerCapture?.(active.pointerId);
      activeMoveRef.current = { ...active, captured: true };
    }
    const result = moveEngineRef.current.updatePointer(active.token, point);
    if (result.status === "updated") {
      for (const lifecycleEvent of result.lifecycleEvents) currentController.dispatch(lifecycleEvent);
    }
    return true;
  }

  function finishObjectMove(
    event: PointerEvent<HTMLDivElement>,
    reason: "pointer-up" | "pointer-cancel",
  ): boolean {
    const active = activeMoveRef.current;
    const currentController = controllerRef.current;
    if (!active || active.pointerId !== event.pointerId || !currentController) return false;
    const point = pointerPage(event) ?? undefined;
    const result = reason === "pointer-cancel"
      ? moveEngineRef.current.pointerCancel(active.token, point)
      : moveEngineRef.current.finish(active.token, point);
    if (result.status === "finished") {
      for (const lifecycleEvent of result.lifecycleEvents) currentController.dispatch(lifecycleEvent);
    }
    if (active.captured) releasePointerCapture(active.pointerId);
    activeMoveRef.current = null;
    return true;
  }

  function startCreate(input: Readonly<{
    tool: Extract<SemanticCanvasTool, "draw" | "text" | "rectangle" | "ellipse" | "diamond">;
    pointerId: number;
    clientX: number;
    clientY: number;
  }>) {
    const currentController = controllerRef.current;
    if (!currentController || activeTextRef.current || hasActivePointerSession()) return;
    const point = pointerPage(input);
    if (!point) return;
    onExitFollow();
    try {
      const engine = createEngineRef.current;
      const prepared = input.tool === "draw"
        ? engine.prepareDraw({
            id: createObjectId("draw"),
            pointerStart: point,
            zIndex: nextObjectZIndex(),
            color: "black",
            size: "m",
          })
        : input.tool === "text"
          ? engine.prepareText({
              id: createObjectId("text"),
              point,
              zIndex: nextObjectZIndex(),
              content: "",
              color: "black",
              size: "m",
              align: "start",
            })
          : engine.prepareShape({
              id: createObjectId("shape"),
              pointerStart: point,
              zIndex: nextObjectZIndex(),
              shape: input.tool,
              nodeType: null,
              label: "",
              fill: "blue",
              stroke: "blue",
            });

      if (input.tool === "text") {
        const started = engine.startProvisionalText(prepared.session.token);
        if (started.status !== "started") return;
        dispatchEditEvents(started.lifecycleEvents);
        const next: ActiveCreatedTextEditor = {
          mode: "create",
          gestureId: started.session.gestureId,
          objectId: started.session.objectId,
          token: started.session.token,
          session: started.session,
        };
        activeTextRef.current = next;
        setActiveTextEditor(next);
        updateSelection([started.session.objectId]);
        setActiveTool("select");
        return;
      }

      const published = engine.publish(prepared.session.token);
      if (published.status !== "published") return;
      // Dispatch order is the local-first protection contract: started first,
      // then the optimistic draft, all within this pointer-down call stack.
      dispatchEditEvents(published.lifecycleEvents);
      updateSelection([published.session.objectId]);

      activeCreateRef.current = {
        pointerId: input.pointerId,
        gestureId: published.session.gestureId,
        objectId: published.session.objectId,
        token: published.session.token,
        tool: input.tool,
      };
      shellRef.current?.setPointerCapture?.(input.pointerId);
    } catch (error) {
      createEngineRef.current = new SemanticCreateSessionEngine();
      reportAuthoringError(error);
      setActiveTool("select");
    }
  }

  function updateCreate(event: PointerEvent<HTMLDivElement>): boolean {
    const active = activeCreateRef.current;
    if (!active || active.pointerId !== event.pointerId || !controllerRef.current) return false;
    const point = pointerPage(event);
    if (!point) return true;
    try {
      const result = createEngineRef.current.updatePointer(active.token, point);
      if (result.status === "updated") dispatchEditEvents(result.lifecycleEvents);
    } catch (error) {
      reportAuthoringError(error);
    }
    return true;
  }

  function finishCreate(
    event: PointerEvent<HTMLDivElement>,
    reason: "pointer-up" | "pointer-cancel",
  ): boolean {
    const active = activeCreateRef.current;
    if (!active || active.pointerId !== event.pointerId || !controllerRef.current) return false;
    try {
      const point = pointerPage(event) ?? undefined;
      const result = reason === "pointer-cancel"
        ? createEngineRef.current.pointerCancel(active.token, point)
        : createEngineRef.current.finish(active.token, point);
      if (result.status === "finished") dispatchEditEvents(result.lifecycleEvents);
    } catch (error) {
      reportAuthoringError(error);
    }
    releasePointerCapture(active.pointerId);
    activeCreateRef.current = null;
    if (active.tool !== "draw") setActiveTool("select");
    return true;
  }

  function connectorTarget(
    point: Point,
    preferredObjectId: string | null = null,
  ): SemanticConnectorPointerTarget {
    const roomObject = preferredObjectId
      ? controllerRef.current?.getSnapshot().objects[preferredObjectId]
      : null;
    let objectId = roomObject && roomObject.kind !== "connector" ? preferredObjectId : null;
    if (!objectId) {
      const first = hitTestSemanticScene(sceneRef.current, point, {
        zoom: viewportRef.current.zoom,
        groupMode: "object",
      });
      if (first?.object.kind !== "connector") objectId = first?.objectId ?? null;
      else {
        objectId = hitTestSemanticSceneObjects(sceneRef.current, point, {
          zoom: viewportRef.current.zoom,
          groupMode: "object",
        }).find((hit) => hit.object.kind !== "connector")?.objectId ?? null;
      }
    }
    return objectId
      ? { point, objectId, snap: "edge", isExact: false }
      : { point };
  }

  function startConnector(input: Readonly<{
    pointerId: number;
    clientX: number;
    clientY: number;
    objectId?: string | null;
  }>) {
    const currentController = controllerRef.current;
    if (!currentController || activeTextRef.current || hasActivePointerSession()) return;
    const point = pointerPage(input);
    if (!point) return;
    onExitFollow();
    try {
      const prepared = connectorEngineRef.current.prepareCreate({
        room: currentController.getSnapshot(),
        id: createObjectId("connector"),
        start: connectorTarget(point, input.objectId ?? null),
        routing: connectorRoutingInput(connectorRoutingRef.current),
        direction: connectorDirectionRef.current,
        label: "",
        color: "black",
        zIndex: nextObjectZIndex(),
      });
      const published = connectorEngineRef.current.publish(prepared.session.token);
      if (published.status !== "published") return;
      // Dependencies, when present, are dispatched ahead of the connector's
      // first optimistic route by the engine's ordered event list.
      dispatchEditEvents(published.lifecycleEvents);
      updateSelection([published.session.objectId]);
      activeConnectorRef.current = {
        pointerId: input.pointerId,
        gestureId: published.session.gestureId,
        objectId: published.session.objectId,
        token: published.session.token,
      };
      shellRef.current?.setPointerCapture?.(input.pointerId);
    } catch (error) {
      connectorEngineRef.current = new SemanticConnectorSessionEngine();
      reportAuthoringError(error);
      setActiveTool("select");
    }
  }

  function updateConnector(event: PointerEvent<HTMLDivElement>): boolean {
    const active = activeConnectorRef.current;
    if (!active || active.pointerId !== event.pointerId || !controllerRef.current) return false;
    const point = pointerPage(event);
    if (!point) return true;
    try {
      const result = connectorEngineRef.current.updatePointer(active.token, connectorTarget(point));
      if (result.status === "updated") dispatchEditEvents(result.lifecycleEvents);
    } catch (error) {
      reportAuthoringError(error);
    }
    return true;
  }

  function finishConnector(
    event: PointerEvent<HTMLDivElement>,
    reason: "pointer-up" | "pointer-cancel",
  ): boolean {
    const active = activeConnectorRef.current;
    if (!active || active.pointerId !== event.pointerId || !controllerRef.current) return false;
    try {
      const point = pointerPage(event);
      const target = point ? connectorTarget(point) : undefined;
      const result = reason === "pointer-cancel"
        ? connectorEngineRef.current.pointerCancel(active.token, target)
        : connectorEngineRef.current.finish(active.token, target);
      if (result.status === "finished") dispatchEditEvents(result.lifecycleEvents);
    } catch (error) {
      reportAuthoringError(error);
    }
    releasePointerCapture(active.pointerId);
    activeConnectorRef.current = null;
    setActiveTool("select");
    return true;
  }

  function beginTextEdit(objectId: string) {
    const currentController = controllerRef.current;
    if (!currentController || activeTextRef.current || hasActivePointerSession()) return;
    const object = currentController.getSnapshot().objects[objectId];
    // Revision zero is an optimistic create. Wait for its authoritative create
    // acknowledgement before beginning a revision-fenced update gesture.
    if (!object || object.revision <= 0 || object.kind === "draw" || (object.kind === "image" && object.locked)) return;
    let result;
    try {
      result = textEngineRef.current.begin(object);
    } catch (error) {
      reportAuthoringError(error);
      return;
    }
    if (result.superseded) {
      for (const lifecycleEvent of result.superseded.lifecycleEvents) {
        currentController.dispatch(lifecycleEvent);
      }
    }
    currentController.dispatch(result.lifecycleEvent);
    const next: ActiveExistingTextEditor = {
      mode: "edit",
      gestureId: result.session.gestureId,
      objectId,
      token: result.session.token,
      session: result.session,
    };
    activeTextRef.current = next;
    setActiveTextEditor(next);
  }

  function requestTextEdit(objectId: string) {
    if (!controllerRef.current || activeTextRef.current) return;
    const activeMove = activeMoveRef.current;
    const moveSession = activeMove ? moveEngineRef.current.current() : null;
    if (activeMove && moveSession?.objectIds.includes(objectId)) {
      const finished = moveEngineRef.current.finish(activeMove.token, moveSession.pointerCurrent);
      if (finished.status === "finished") dispatchEditEvents(finished.lifecycleEvents);
      if (activeMove.captured) releasePointerCapture(activeMove.pointerId);
      activeMoveRef.current = null;
      // A synthesized or accessibility-driven double-click can arrive before
      // the active pointer-up has reached this React root. Attach the newer
      // text lifecycle immediately before the move gesture's render-settlement
      // callback can release its
      // lease cohort. The lease manager then transitions the shared token from
      // move to edit without an unprotected frame or a second independent lock.
      beginTextEdit(objectId);
      return;
    }
    // Native double-click dispatch follows its pointer-up synchronously, while
    // the completed move gesture settles at the next render boundary. Attach
    // text protection now so the edit cohort overlaps the retiring move cohort;
    // deferring this to another frame creates a real authority gap and can let
    // the move release retire the shared lease before editing begins.
    beginTextEdit(objectId);
  }

  function updateTextDraft(value: string) {
    const active = activeTextRef.current;
    const currentController = controllerRef.current;
    if (!active || !currentController) return;
    if (active.mode === "create") {
      try {
        const result = createEngineRef.current.updateProvisionalText(active.token, value);
        if (result.status !== "updated") return;
        const next: ActiveCreatedTextEditor = { ...active, session: result.session };
        activeTextRef.current = next;
        setActiveTextEditor(next);
      } catch (error) {
        reportAuthoringError(error);
      }
      return;
    }
    const result = textEngineRef.current.updateDraft(active.token, value);
    if (result.status !== "updated") return;
    for (const event of result.lifecycleEvents) currentController.dispatch(event);
    const next = { ...active, session: result.session };
    activeTextRef.current = next;
    setActiveTextEditor(next);
  }

  function commitTextEdit() {
    const active = activeTextRef.current;
    const currentController = controllerRef.current;
    if (!active || !currentController) return;
    if (active.mode === "create") {
      const content = active.session.draft.kind === "text" ? active.session.draft.content : "";
      if (!content.trim()) {
        cancelTextEdit();
        return;
      }
      try {
        const result = createEngineRef.current.commitProvisionalText(active.token);
        if (result.status !== "committed") return;
        // Install the final optimistic create before removing the renderer-only
        // provisional draft, so no render can reveal an empty frame.
        dispatchEditEvents(result.lifecycleEvents);
      } catch (error) {
        createEngineRef.current = new SemanticCreateSessionEngine();
        reportAuthoringError(error);
      }
      activeTextRef.current = null;
      setActiveTextEditor(null);
      return;
    }
    const result = textEngineRef.current.commit(active.token);
    if (result.status !== "committed") return;
    for (const event of result.lifecycleEvents) currentController.dispatch(event);
    activeTextRef.current = null;
    setActiveTextEditor(null);
  }

  function cancelTextEdit() {
    const active = activeTextRef.current;
    const currentController = controllerRef.current;
    if (!active || !currentController) return;
    if (active.mode === "create") {
      try {
        const result = createEngineRef.current.cancelProvisionalText(active.token);
        if (result.status !== "cancelled") return;
        dispatchEditEvents(result.lifecycleEvents);
      } catch (error) {
        createEngineRef.current = new SemanticCreateSessionEngine();
        reportAuthoringError(error);
      }
      activeTextRef.current = null;
      setActiveTextEditor(null);
      updateSelection(selectionRef.current.filter((objectId) => objectId !== active.objectId));
      return;
    }
    const result = textEngineRef.current.cancel(active.token);
    if (result.status !== "cancelled") return;
    for (const event of result.lifecycleEvents) currentController.dispatch(event);
    activeTextRef.current = null;
    setActiveTextEditor(null);
  }

  function handleImageReady(result: SemanticImagePickerReady) {
    const currentController = controllerRef.current;
    if (!currentController || self.role !== "participant" || activeToolRef.current !== "image") return;
    const anchor = pointerPageRef.current ?? {
      x: viewportRef.current.x + viewportRef.current.width / 2,
      y: viewportRef.current.y + viewportRef.current.height / 2,
    };
    try {
      const prepared = imageEngineRef.current.prepareCreate({
        roomId: currentController.getSnapshot().id,
        id: createObjectId("image"),
        asset: result.asset,
        x: anchor.x - result.width / 2,
        y: anchor.y - result.height / 2,
        width: result.width,
        height: result.height,
        zIndex: nextObjectZIndex(),
        alt: result.alt,
      });
      const published = imageEngineRef.current.publish(prepared.session.token);
      if (published.status !== "published") return;
      dispatchEditEvents(published.lifecycleEvents);
      const finished = imageEngineRef.current.finish(published.session.token);
      if (finished.status === "finished") dispatchEditEvents(finished.lifecycleEvents);
      updateSelection([published.session.imageId]);
      setActiveTool("select");
    } catch (error) {
      imageEngineRef.current = new SemanticImageSessionEngine();
      reportAuthoringError(error);
      setActiveTool("select");
    }
  }

  const resizeHandleMap: Readonly<Record<string, SemanticResizeHandle>> = {
    "north-west": "nw", north: "n", "north-east": "ne", east: "e",
    "south-east": "se", south: "s", "south-west": "sw", west: "w",
  };

  function startSelectionTransform(input: SemanticTransformPointerStart) {
    const currentController = controllerRef.current;
    if (!currentController || activeTextRef.current || hasActivePointerSession()) return;
    const point = pointerPage(input);
    if (!point) return;
    onExitFollow();
    try {
      if (input.handle.kind === "connector-endpoint") {
        const objectId = input.objectIds[0];
        const object = objectId ? currentController.getSnapshot().objects[objectId] : null;
        if (!object || object.kind !== "connector") return;
        const started = connectorEngineRef.current.beginEdit({
          room: currentController.getSnapshot(),
          connectorId: object.id,
          terminal: input.handle.endpoint,
        });
        dispatchEditEvents(started.lifecycleEvents);
        activeConnectorEndpointRef.current = {
          pointerId: input.pointerId,
          gestureId: started.session.gestureId,
          objectId: object.id,
          token: started.session.token,
        };
      } else {
        const started = transformEngineRef.current.begin({
          room: currentController.getSnapshot(),
          mode: input.handle.kind === "rotate" ? "rotate" : "resize",
          handle: input.handle.kind === "resize" ? resizeHandleMap[input.handle.handle] : undefined,
          selectedObjectIds: input.objectIds,
          pointerStart: point,
        });
        if (started.superseded) dispatchEditEvents(started.superseded.lifecycleEvents);
        if (started.status === "blocked") return;
        currentController.dispatch(started.lifecycleEvent);
        activeTransformRef.current = {
          pointerId: input.pointerId,
          gestureId: started.session.gestureId,
          token: started.session.token,
        };
      }
      shellRef.current?.setPointerCapture?.(input.pointerId);
    } catch (error) {
      transformEngineRef.current = new SemanticTransformSessionEngine();
      connectorEngineRef.current = new SemanticConnectorSessionEngine();
      reportAuthoringError(error);
    }
  }

  function updateSelectionTransform(event: PointerEvent<HTMLDivElement>): boolean {
    const point = pointerPage(event);
    const activeEndpoint = activeConnectorEndpointRef.current;
    if (activeEndpoint?.pointerId === event.pointerId) {
      if (point) {
        const updated = connectorEngineRef.current.updatePointer(activeEndpoint.token, connectorTarget(point));
        if (updated.status === "updated") dispatchEditEvents(updated.lifecycleEvents);
      }
      return true;
    }
    const active = activeTransformRef.current;
    if (!active || active.pointerId !== event.pointerId) return false;
    if (point) {
      const updated = transformEngineRef.current.updatePointer(active.token, point, {
        lockAspectRatio: event.shiftKey,
      });
      if (updated.status === "updated") dispatchEditEvents(updated.lifecycleEvents);
    }
    return true;
  }

  function finishSelectionTransform(event: PointerEvent<HTMLDivElement>, reason: "pointer-up" | "pointer-cancel"): boolean {
    const activeEndpoint = activeConnectorEndpointRef.current;
    if (activeEndpoint?.pointerId === event.pointerId) {
      const point = pointerPage(event);
      const finished = reason === "pointer-cancel"
        ? connectorEngineRef.current.pointerCancel(activeEndpoint.token, point ? connectorTarget(point) : undefined)
        : connectorEngineRef.current.finish(activeEndpoint.token, point ? connectorTarget(point) : undefined);
      if (finished.status === "finished") dispatchEditEvents(finished.lifecycleEvents);
      releasePointerCapture(event.pointerId);
      activeConnectorEndpointRef.current = null;
      return true;
    }
    const active = activeTransformRef.current;
    if (!active || active.pointerId !== event.pointerId) return false;
    if (pointerPage(event)) {
      const updated = transformEngineRef.current.updatePointer(active.token, pointerPage(event)!, {
        lockAspectRatio: event.shiftKey,
      });
      if (updated.status === "updated") dispatchEditEvents(updated.lifecycleEvents);
    }
    const finished = transformEngineRef.current.finish(active.token, reason);
    if (finished.status === "finished") dispatchEditEvents(finished.lifecycleEvents);
    releasePointerCapture(event.pointerId);
    activeTransformRef.current = null;
    return true;
  }

  function currentKeyboardSelection() {
    return { objectIds: selectionRef.current } as const;
  }

  function dispatchMutation(result: Readonly<{ lifecycleEvents: readonly SemanticCanvasEditEvent[]; targetObjectIds?: readonly string[] }>) {
    dispatchEditEvents(result.lifecycleEvents);
  }

  function applyStylePatch(patch: SemanticObjectStylePatch) {
    if (hasActivePointerSession() || activeTextRef.current) return;
    try {
      dispatchMutation(applySemanticObjectStyles({
        room: controllerRef.current?.getSnapshot() ?? roomRef.current,
        gestureId: `semantic-style:${Date.now()}:${++fallbackSemanticId}`,
        objectIds: selectionRef.current,
        patch,
      }));
    } catch (error) { reportAuthoringError(error); }
  }

  function editFromStyle(request: SemanticStyleEditRequest) {
    const first = request.objectIds[0];
    if (first) beginTextEdit(first);
  }

  function runSelectionAction(action: "delete" | "group" | "ungroup" | "front" | "forward" | "backward" | "back") {
    const engine = keyboardEngineRef.current;
    const snapshot = controllerRef.current?.getSnapshot() ?? roomRef.current;
    try {
      const result = action === "delete"
        ? engine.deleteSelection({ room: snapshot, selection: currentKeyboardSelection() })
        : action === "group"
          ? engine.group({ room: snapshot, selection: currentKeyboardSelection(), groupIdFactory: () => createGroupId() })
          : action === "ungroup"
            ? engine.ungroup({ room: snapshot, selection: currentKeyboardSelection() })
            : engine.order({ room: snapshot, selection: currentKeyboardSelection(), direction: action });
      dispatchMutation(result);
      if (action === "delete") {
        const deleted = new Set(selectionRef.current);
        const currentIndex = Math.max(
          0,
          ...selectionRef.current.map((objectId) => objectNavigation.indexById.get(objectId) ?? 0),
        );
        const remaining = objectNavigation.objectIds.filter((objectId) => !deleted.has(objectId));
        updateSelection([]);
        requestObjectFocus(remaining[Math.min(currentIndex, remaining.length - 1)] ?? null);
      }
    } catch (error) { reportAuthoringError(error); }
  }

  function freshClipboardObjectId(source: string, index: number) {
    void source; void index;
    return createObjectId("shape").replace(/^shape_/, "object_");
  }

  function applyPastePayload(payload: SemanticCanvasClipboardPayload): string | null {
    const currentController = controllerRef.current;
    if (!currentController) return null;
    const result = keyboardEngineRef.current.paste({
      room: currentController.getSnapshot(),
      payload,
      objectIdFactory: freshClipboardObjectId,
      groupIdFactory: () => createGroupId(),
    });
    dispatchMutation(result);
    if (result.status === "finished") updateSelection(result.createdObjectIds);
    return result.status === "finished" ? result.createdObjectIds[0] ?? null : null;
  }

  function writeClipboard(payload: SemanticCanvasClipboardPayload) {
    const serialized = encodeSemanticCanvasClipboard(payload);
    clipboardRef.current = serialized;
    clipboardSummaryRef.current = `${payload.objects.length} Jazzboard canvas object${payload.objects.length === 1 ? "" : "s"}`;
    if (typeof globalThis.ClipboardItem === "function" && navigator.clipboard?.write) {
      try {
        const item = new ClipboardItem({
          [SEMANTIC_CANVAS_CLIPBOARD_FORMAT]: new Blob([serialized], { type: SEMANTIC_CANVAS_CLIPBOARD_FORMAT }),
        });
        void navigator.clipboard.write([item]).catch(() => undefined);
      } catch {
        // The room-fenced in-memory payload remains the safe fallback when a
        // browser rejects custom asynchronous clipboard formats.
      }
    }
  }

  function pasteClipboard(): string | null {
    const expectedRoomId = roomRef.current.id;
    const internal = clipboardRef.current;
    if (internal) {
      try { return applyPastePayload(decodeSemanticCanvasClipboard(internal, expectedRoomId)); }
      catch (error) { reportAuthoringError(error); }
    }
    return null;
  }

  function runShortcut(shortcut: ReturnType<typeof normalizeSemanticCanvasShortcut>) {
    if (!shortcut) return;
    const engine = keyboardEngineRef.current;
    const snapshot = controllerRef.current?.getSnapshot() ?? roomRef.current;
    try {
      switch (shortcut.type) {
        case "select-all":
          updateSelection(selectAllSemanticObjectIds(snapshot));
          break;
        case "escape": {
          if (activeTextRef.current) cancelTextEdit();
          const activeTransform = activeTransformRef.current;
          if (activeTransform) {
            const finished = transformEngineRef.current.finish(activeTransform.token, "pointer-cancel");
            if (finished.status === "finished") dispatchEditEvents(finished.lifecycleEvents);
            releasePointerCapture(activeTransform.pointerId);
            activeTransformRef.current = null;
          }
          const activeEndpoint = activeConnectorEndpointRef.current;
          if (activeEndpoint) {
            const finished = connectorEngineRef.current.pointerCancel(activeEndpoint.token);
            if (finished.status === "finished") dispatchEditEvents(finished.lifecycleEvents);
            releasePointerCapture(activeEndpoint.pointerId);
            activeConnectorEndpointRef.current = null;
          }
          const marquee = activeMarqueeRef.current;
          if (marquee) {
            const cancelled = marqueeEngineRef.current.cancel(marquee.token);
            if (cancelled.status === "cancelled") updateSelection(cancelled.selectedObjectIds);
            releasePointerCapture(marquee.pointerId);
            activeMarqueeRef.current = null;
            setActiveMarqueeSession(null);
          }
          const pan = panRef.current;
          if (pan) {
            releasePointerCapture(pan.pointerId);
            panRef.current = null;
            setPanning(false);
          }
          const move = activeMoveRef.current;
          if (move) {
            const finished = moveEngineRef.current.pointerCancel(move.token, moveEngineRef.current.current()?.pointerCurrent);
            if (finished.status === "finished") dispatchEditEvents(finished.lifecycleEvents);
            releasePointerCapture(move.pointerId);
            activeMoveRef.current = null;
          }
          const create = activeCreateRef.current;
          if (create) {
            const finished = createEngineRef.current.pointerCancel(create.token, createEngineRef.current.current()?.pointerCurrent);
            if (finished.status === "finished") dispatchEditEvents(finished.lifecycleEvents);
            releasePointerCapture(create.pointerId);
            activeCreateRef.current = null;
            if (create.tool !== "draw") setActiveTool("select");
          }
          const connector = activeConnectorRef.current;
          if (connector) {
            const finished = connectorEngineRef.current.pointerCancel(connector.token);
            if (finished.status === "finished") dispatchEditEvents(finished.lifecycleEvents);
            releasePointerCapture(connector.pointerId);
            activeConnectorRef.current = null;
            setActiveTool("select");
          }
          updateSelection([]);
          setMenuOpen(false);
          break;
        }
        case "edit-text": {
          const first = selectionRef.current[0];
          if (first) beginTextEdit(first);
          break;
        }
        case "delete-selection": runSelectionAction("delete"); break;
        case "group": runSelectionAction("group"); break;
        case "ungroup": runSelectionAction("ungroup"); break;
        case "order-forward": runSelectionAction("forward"); break;
        case "order-backward": runSelectionAction("backward"); break;
        case "nudge": dispatchMutation(engine.nudge({ room: snapshot, selection: currentKeyboardSelection(), delta: shortcut.delta })); break;
        case "duplicate": {
          const result = engine.duplicate({
            room: snapshot,
            selection: currentKeyboardSelection(),
            objectIdFactory: freshClipboardObjectId,
            groupIdFactory: () => createGroupId(),
          });
          dispatchMutation(result);
          if (result.status === "finished") updateSelection(result.createdObjectIds);
          return result.status === "finished" ? result.createdObjectIds[0] ?? null : null;
        }
        case "copy": {
          const result = engine.copy({ room: snapshot, selection: currentKeyboardSelection() });
          if (result.payload) writeClipboard(result.payload);
          break;
        }
        case "cut": {
          const result = engine.cut({ room: snapshot, selection: currentKeyboardSelection() });
          if (result.payload) writeClipboard(result.payload);
          dispatchMutation(result.mutation);
          if (result.status === "finished") updateSelection([]);
          break;
        }
        case "paste": return pasteClipboard();
      }
    } catch (error) { reportAuthoringError(error); }
  }

  function handleObjectSelect(objectId: string, additive: boolean) {
    if (!editingEnabled || activeToolRef.current === "select") selectAndFocusObject(objectId, additive);
  }

  function handleObjectFocus(objectId: string) {
    pendingFocusObjectIdRef.current = null;
    setTabStopObjectId(objectId);
    setFocusedObjectId(objectId);
  }

  function moveObjectFocus(
    objectId: string,
    offset: number,
    options: Readonly<{ wrap?: boolean }> = {},
  ): boolean {
    const index = objectNavigation.indexById.get(objectId);
    if (index === undefined || objectNavigation.objectIds.length < 2) return false;
    let nextIndex = index + offset;
    if (options.wrap) {
      nextIndex = (nextIndex + objectNavigation.objectIds.length) % objectNavigation.objectIds.length;
    }
    const next = objectNavigation.objectIds[nextIndex];
    if (!next) return false;
    requestObjectFocus(next);
    return true;
  }

  function handleObjectPointerStart(input: Readonly<{
    objectId: string;
    pointerId: number;
    clientX: number;
    clientY: number;
    additive: boolean;
  }>) {
    if (!editingEnabled) return;
    if (spaceHeldRef.current || activeToolRef.current === "hand") {
      startPan(input);
      return;
    }
    if (activeToolRef.current === "select") {
      startObjectMove(input);
      return;
    }
    if (activeToolRef.current === "connector") {
      startConnector({ ...input, objectId: input.objectId });
      return;
    }
    if (
      activeToolRef.current === "draw"
      || activeToolRef.current === "text"
      || activeToolRef.current === "rectangle"
      || activeToolRef.current === "ellipse"
      || activeToolRef.current === "diamond"
    ) {
      startCreate({ ...input, tool: activeToolRef.current });
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    setContextMenu(null);
    const target = event.target as Element;
    const canvasSvg = event.currentTarget.firstElementChild;
    const isCanvasBackground = target === event.currentTarget
      || Boolean(
        canvasSvg
        && (target === canvasSvg || canvasSvg.contains(target))
        && !target.closest("[data-object-id], [data-connector-interaction-id]"),
      );
    if (event.button === 1 || (event.button === 0 && spaceHeldRef.current)) {
      event.preventDefault();
      startPan(event);
      return;
    }
    if (event.button !== 0 || !isCanvasBackground) return;
    if (!editingEnabled || activeToolRef.current === "hand") {
      startPan(event);
      return;
    }
    if (activeToolRef.current === "select") {
      startMarquee(event);
      return;
    }
    if (activeToolRef.current === "connector") {
      startConnector(event);
      return;
    }
    if (
      activeToolRef.current === "draw"
      || activeToolRef.current === "text"
      || activeToolRef.current === "rectangle"
      || activeToolRef.current === "ellipse"
      || activeToolRef.current === "diamond"
    ) {
      startCreate({
        tool: activeToolRef.current,
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const point = pointerPage(event);
    pointerPageRef.current = point;
    presencePublisherRef.current?.notifyChanged();
    if (updateSelectionTransform(event)) return;
    if (updateObjectMove(event)) return;
    if (updateCreate(event)) return;
    if (updateConnector(event)) return;
    if (updateMarquee(event)) return;
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const zoom = pan.viewport.zoom;
    updateViewport({
      ...pan.viewport,
      x: pan.viewport.x - (event.clientX - pan.clientX) / zoom,
      y: pan.viewport.y - (event.clientY - pan.clientY) / zoom,
    });
  }

  function finishPan(event: PointerEvent<HTMLDivElement>): boolean {
    if (panRef.current?.pointerId !== event.pointerId) return false;
    panRef.current = null;
    releasePointerCapture(event.pointerId);
    setPanning(false);
    return true;
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (finishSelectionTransform(event, "pointer-up")) return;
    if (finishObjectMove(event, "pointer-up")) return;
    if (finishCreate(event, "pointer-up")) return;
    if (finishConnector(event, "pointer-up")) return;
    if (finishMarquee(event)) return;
    finishPan(event);
  }

  function handlePointerCancel(event: PointerEvent<HTMLDivElement>) {
    if (finishSelectionTransform(event, "pointer-cancel")) return;
    if (finishObjectMove(event, "pointer-cancel")) return;
    if (finishCreate(event, "pointer-cancel")) return;
    if (finishConnector(event, "pointer-cancel")) return;
    if (finishMarquee(event, true)) return;
    finishPan(event);
  }

  function handlePointerLeave() {
    if (hasActivePointerSession()) return;
    pointerPageRef.current = null;
    presencePublisherRef.current?.notifyChanged();
  }

  function supportedTransferredImage(files: FileList | readonly File[]): File | null {
    return Array.from(files).find((file) => /^(?:image\/jpeg|image\/png|image\/webp|image\/gif)$/i.test(file.type)) ?? null;
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    if (!editingEnabled || hasActivePointerSession() || activeTextRef.current) return;
    if (Array.from(event.clipboardData.types ?? []).includes(SEMANTIC_CANVAS_CLIPBOARD_FORMAT)) {
      try {
        const payload = decodeSemanticCanvasClipboard(
          event.clipboardData.getData(SEMANTIC_CANVAS_CLIPBOARD_FORMAT),
          roomRef.current.id,
        );
        applyPastePayload(payload);
        event.preventDefault();
      } catch (error) { reportAuthoringError(error); }
      return;
    }
    const file = supportedTransferredImage(event.clipboardData.files);
    if (file && imagePickerRef.current?.offerFile(file)) {
      event.preventDefault();
      setActiveTool("image");
      return;
    }
    // Some browsers strip custom clipboard formats. The in-memory payload is
    // still room-fenced and lets copy/paste remain useful within this mounted
    // board without ever interpreting arbitrary text/plain as canvas JSON.
    const plainText = typeof event.clipboardData.getData === "function"
      ? event.clipboardData.getData("text/plain")
      : "";
    if (
      !clipboardRef.current
      || !clipboardSummaryRef.current
      || plainText !== clipboardSummaryRef.current
    ) return;
    try {
      applyPastePayload(
        decodeSemanticCanvasClipboard(clipboardRef.current, roomRef.current.id),
      );
      event.preventDefault();
    } catch (error) { reportAuthoringError(error); }
  }

  function handleCopy(event: ClipboardEvent<HTMLDivElement>) {
    if (!editingEnabled || hasActivePointerSession() || activeTextRef.current) return;
    try {
      const copied = keyboardEngineRef.current.copy({
        room: controllerRef.current?.getSnapshot() ?? roomRef.current,
        selection: currentKeyboardSelection(),
      });
      if (!copied.payload) return;
      const serialized = encodeSemanticCanvasClipboard(copied.payload);
      clipboardRef.current = serialized;
      const summary = `${copied.capturedObjectIds.length} Jazzboard canvas object${copied.capturedObjectIds.length === 1 ? "" : "s"}`;
      clipboardSummaryRef.current = summary;
      event.clipboardData.setData(SEMANTIC_CANVAS_CLIPBOARD_FORMAT, serialized);
      event.clipboardData.setData("text/plain", summary);
      event.preventDefault();
    } catch (error) { reportAuthoringError(error); }
  }

  function handleCut(event: ClipboardEvent<HTMLDivElement>) {
    if (!editingEnabled || hasActivePointerSession() || activeTextRef.current) return;
    try {
      const cut = keyboardEngineRef.current.cut({
        room: controllerRef.current?.getSnapshot() ?? roomRef.current,
        selection: currentKeyboardSelection(),
      });
      if (!cut.payload) return;
      const serialized = encodeSemanticCanvasClipboard(cut.payload);
      clipboardRef.current = serialized;
      const summary = `${cut.mutation.targetObjectIds.length} Jazzboard canvas object${cut.mutation.targetObjectIds.length === 1 ? "" : "s"}`;
      clipboardSummaryRef.current = summary;
      event.clipboardData.setData(SEMANTIC_CANVAS_CLIPBOARD_FORMAT, serialized);
      event.clipboardData.setData("text/plain", summary);
      dispatchMutation(cut.mutation);
      updateSelection([]);
      event.preventDefault();
    } catch (error) { reportAuthoringError(error); }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!editingEnabled || hasActivePointerSession() || activeTextRef.current) return;
    const imageItem = Array.from(event.dataTransfer.items).find((item) =>
      item.kind === "file" && /^(?:image\/jpeg|image\/png|image\/webp|image\/gif)$/i.test(item.type),
    );
    if (!imageItem) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!editingEnabled || hasActivePointerSession() || activeTextRef.current) return;
    const file = supportedTransferredImage(event.dataTransfer.files);
    if (!file || !imagePickerRef.current?.offerFile(file)) return;
    pointerPageRef.current = pointerPage(event);
    event.preventDefault();
    setActiveTool("image");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const focusedCanvasObject = target.closest<SVGGElement>("[data-object-id]");
    if (event.key === "Tab" && focusedCanvasObject) {
      if (moveObjectFocus(focusedCanvasObject.dataset.objectId!, event.shiftKey ? -1 : 1)) {
        event.preventDefault();
      }
      return;
    }
    if (
      self.role === "spectator"
      && focusedCanvasObject
      && ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)
    ) {
      event.preventDefault();
      moveObjectFocus(
        focusedCanvasObject.dataset.objectId!,
        event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1,
        { wrap: true },
      );
      return;
    }
    if (event.key === "Escape" && menuOpen) {
      event.preventDefault();
      setMenuOpen(false);
      queueMicrotask(() => menuButtonRef.current?.focus());
      return;
    }
    if (
      target.closest('[data-semantic-tool-palette="true"], [data-semantic-text-editor="true"]')
      || target.matches("input, textarea, select, [contenteditable='true']")
    ) return;
    if (event.key === " ") {
      spaceHeldRef.current = true;
      event.preventDefault();
      return;
    }
    const shortcut = normalizeSemanticCanvasShortcut({ event, role: self.role });
    if (shortcut) {
      if (shortcut.type === "undo" || shortcut.type === "redo") {
        const currentController = controllerRef.current;
        if (!currentController || activeTextRef.current || hasActivePointerSession()) return;
        const history = currentController.historyState();
        const available = shortcut.type === "undo" ? history.canUndo : history.canRedo;
        if (!available || history.replayPending || history.pendingHumanTransactions > 0) return;
        event.preventDefault();
        const replay = shortcut.type === "undo" ? currentController.undo() : currentController.redo();
        void replay.catch(reportAuthoringError);
        return;
      }
      // Let the browser emit its trusted ClipboardEvent. That surface carries
      // our private MIME payload between authorized Jazzboard tabs and avoids
      // firing both a synthetic shortcut mutation and a native paste.
      if (shortcut.type === "copy" || shortcut.type === "cut" || shortcut.type === "paste") {
        return;
      }
      event.preventDefault();
      runShortcut(shortcut);
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      fitBoard();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAtCenter(1.2);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomAtCenter(1 / 1.2);
    }
  }

  function editContextLabel(object: RoomState["objects"][string]): string | null {
    if (object.revision <= 0 || object.kind === "draw" || (object.kind === "image" && object.locked)) return null;
    if (object.kind === "text") return "Edit text";
    if (object.kind === "connector") return "Edit connector label";
    if (object.kind === "image") return "Edit image description";
    return "Edit label";
  }

  function contextMenuItemsFor(state: CanvasContextMenuState): SemanticCanvasContextMenuItem[] {
    const snapshot = controllerRef.current?.getSnapshot() ?? roomRef.current;
    const items: SemanticCanvasContextMenuItem[] = [];
    if (state.objectId === null) {
      if (editingEnabled && clipboardRef.current) {
        items.push({ id: "paste", label: "Paste", shortcut: "⌘V" });
      }
      if (Object.keys(snapshot.objects).length) {
        items.push({ id: "select-all", label: "Select all", shortcut: "⌘A" });
        items.push({ id: "fit-board", label: "Fit board", shortcut: "0", dividerBefore: items.length > 0 });
      }
      return items;
    }

    const selectedObjects = selectionRef.current.flatMap((objectId) => {
      const object = snapshot.objects[objectId];
      return object ? [object] : [];
    });
    const soleObject = selectedObjects.length === 1 ? selectedObjects[0]! : null;
    const hasMutableObject = selectedObjects.some((object) => object.kind !== "image" || !object.locked);
    const editLabel = editingEnabled && soleObject ? editContextLabel(soleObject) : null;
    const selectedObjectIds = new Set(selectedObjects.map((object) => object.id));
    const connectorsCanGroup = selectedObjects.every((object) => (
      object.kind !== "connector"
      || [object.start, object.end].every((endpoint) => (
        endpoint.objectId === null || selectedObjectIds.has(endpoint.objectId)
      ))
    ));
    const selectedGroupIds = [...new Set(selectedObjects.flatMap((object) => object.groupId ? [object.groupId] : []))];
    const soleCompleteGroupId = selectedGroupIds.length === 1
      && selectedObjects.every((object) => object.groupId === selectedGroupIds[0])
      && (sceneRef.current.groupMembers[selectedGroupIds[0]!] ?? []).every((objectId) => (
        selectionRef.current.includes(objectId)
      ))
      && (sceneRef.current.groupMembers[selectedGroupIds[0]!] ?? []).length === selectedObjects.length;

    if (editLabel) items.push({ id: "edit", label: editLabel });
    if (editingEnabled && hasMutableObject) {
      items.push({ id: "cut", label: "Cut", shortcut: "⌘X", dividerBefore: Boolean(items.length) });
    }
    items.push({
      id: "copy",
      label: "Copy",
      shortcut: "⌘C",
      dividerBefore: Boolean(items.length) && !items.some((item) => item.id === "cut"),
    });
    if (editingEnabled) {
      if (hasMutableObject) items.push({ id: "duplicate", label: "Duplicate", shortcut: "⌘D" });
      if (clipboardRef.current) items.push({ id: "paste", label: "Paste", shortcut: "⌘V" });
      if (selectedObjects.length > 1 && !soleCompleteGroupId && connectorsCanGroup) {
        items.push({ id: "group", label: "Group", shortcut: "⌘G", dividerBefore: true });
      }
      if (selectedObjects.some((object) => object.groupId !== null)) {
        items.push({ id: "ungroup", label: "Ungroup", shortcut: "⇧⌘G", dividerBefore: !items.some((item) => item.id === "group") });
      }
      if (hasMutableObject) {
        items.push({ id: "bring-to-front", label: "Bring to front", dividerBefore: true });
        items.push({ id: "bring-forward", label: "Bring forward" });
        items.push({ id: "send-backward", label: "Send backward" });
        items.push({ id: "send-to-back", label: "Send to back" });
      }
    }
    if (soleObject?.kind === "image") {
      items.push({
        id: "download-original",
        label: "Download original",
        href: soleObject.url,
        download: true,
        dividerBefore: true,
      });
    }
    if (editingEnabled && hasMutableObject) {
      items.push({ id: "delete", label: "Delete", shortcut: "⌫", danger: true, dividerBefore: true });
    }
    items.push({ id: "select-all", label: "Select all", shortcut: "⌘A", dividerBefore: true });
    return items;
  }

  function restoreContextFocus(objectId: string | null) {
    if (objectId) requestObjectFocus(objectId);
    else queueMicrotask(() => shellRef.current?.focus());
  }

  function dismissContextMenu() {
    const objectId = contextMenu?.objectId ?? null;
    setContextMenu(null);
    restoreContextFocus(objectId);
  }

  function runContextMenuAction(actionId: SemanticCanvasContextMenuActionId) {
    const objectId = contextMenu?.objectId ?? null;
    setContextMenu(null);
    switch (actionId) {
      case "edit":
        if (objectId) beginTextEdit(objectId);
        return;
      case "cut":
        runShortcut({ type: "cut" });
        restoreContextFocus(null);
        return;
      case "copy":
        runShortcut({ type: "copy" });
        restoreContextFocus(objectId);
        return;
      case "paste":
        restoreContextFocus(runShortcut({ type: "paste" }) ?? selectionRef.current[0] ?? null);
        return;
      case "duplicate":
        restoreContextFocus(runShortcut({ type: "duplicate" }) ?? selectionRef.current[0] ?? null);
        return;
      case "group":
        runSelectionAction("group");
        restoreContextFocus(objectId);
        return;
      case "ungroup":
        runSelectionAction("ungroup");
        restoreContextFocus(objectId);
        return;
      case "bring-to-front":
        runSelectionAction("front");
        restoreContextFocus(objectId);
        return;
      case "bring-forward":
        runSelectionAction("forward");
        restoreContextFocus(objectId);
        return;
      case "send-backward":
        runSelectionAction("backward");
        restoreContextFocus(objectId);
        return;
      case "send-to-back":
        runSelectionAction("back");
        restoreContextFocus(objectId);
        return;
      case "delete":
        runSelectionAction("delete");
        return;
      case "select-all":
        runShortcut({ type: "select-all" });
        restoreContextFocus(selectionRef.current[0] ?? null);
        return;
      case "fit-board":
        fitBoard();
        restoreContextFocus(null);
        return;
      case "download-original":
        restoreContextFocus(objectId);
    }
  }

  function handleContextMenu(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setMenuOpen(false);
    if (activeTextRef.current || hasActivePointerSession()) {
      setContextMenu(null);
      return;
    }
    const target = event.target as Element;
    const objectElement = target.closest<SVGElement>("[data-object-id]");
    const connectorProxy = target.closest<SVGElement>("[data-connector-interaction-id]");
    const selectedObjectId = target.closest("[data-semantic-selection-controls='true']")
      ? selectionRef.current[0]
      : null;
    const objectId = objectElement?.dataset.objectId
      ?? connectorProxy?.dataset.connectorInteractionId
      ?? selectedObjectId;
    if (objectId) {
      if (!selectionRef.current.includes(objectId)) selectObject(objectId, false);
      if (editingEnabled) setActiveTool("select");
    } else {
      updateSelection([]);
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const nextContextMenu: CanvasContextMenuState = {
      objectId: objectId ?? null,
      x: Math.max(CONTEXT_MENU_MARGIN, event.clientX - rect.left),
      y: Math.max(CONTEXT_MENU_MARGIN, event.clientY - rect.top),
    };
    setContextMenu(contextMenuItemsFor(nextContextMenu).length ? nextContextMenu : null);
  }

  function handleKeyUp(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === " ") spaceHeldRef.current = false;
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      queueMicrotask(() => menuButtonRef.current?.focus());
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    else if (event.key === "ArrowUp") nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === null || !items[nextIndex]) return;
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex].focus();
  }

  function canReplayHistory(direction: "undo" | "redo"): boolean {
    const state = controllerRef.current?.historyState();
    if (!state || state.replayPending || state.pendingHumanTransactions > 0) return false;
    return direction === "undo" ? state.canUndo : state.canRedo;
  }

  function replayHistory(direction: "undo" | "redo") {
    const currentController = controllerRef.current;
    if (!currentController || !canReplayHistory(direction)) return;
    setMenuOpen(false);
    queueMicrotask(() => menuButtonRef.current?.focus());
    const replay = direction === "undo" ? currentController.undo() : currentController.redo();
    void replay.catch(reportAuthoringError);
  }

  const persistentCanvasChrome = (
    <>
      {editingEnabled ? (
        <SemanticToolPalette
          activeTool={activeTool}
          connectorRouting={connectorRouting}
          connectorDirection={connectorDirection}
          onToolChange={chooseTool}
          onConnectorRoutingChange={setConnectorRouting}
          onConnectorDirectionChange={setConnectorDirection}
        />
      ) : null}

      <div
        className={styles.roomHeaderChrome}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <Link aria-label="Back to Jazzboard home" href="/" className={styles.backButton}>
          <ArrowLeft size={20} />
        </Link>
        <div className={styles.combinedLeftPanel} data-testid="combined-left-panel">
          <button
            ref={menuButtonRef}
            className={styles.menuButton}
            data-testid="main-menu.button"
            aria-label="Board menu"
            aria-expanded={menuOpen}
            aria-controls="semantic-board-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Menu size={20} />
          </button>
          <span className={styles.headerDivider} aria-hidden="true" />
          <div className={styles.roomIdentity} data-testid="room-identity">
            <span className={styles.brandMini} aria-hidden="true">J</span>
            <div className={styles.roomIdentityText}>
              <InlineRoomTitle
                editable={self.role === "participant"}
                renameRoom={renameRoom}
                title={projectedRoom.title}
              />
              <span>Room {formatRoomCode(projectedRoom.code)}</span>
            </div>
          </div>
          {menuOpen ? (
            <div
              ref={menuRef}
              id="semantic-board-menu"
              className={styles.menu}
              role="menu"
              aria-label="Board actions"
              onKeyDown={handleMenuKeyDown}
            >
              {self.role === "participant" ? (
                <>
                  <button role="menuitem" disabled={!canUndo} title="Undo (⌘Z)" onClick={() => replayHistory("undo")}>Undo <span aria-hidden="true">⌘Z</span></button>
                  <button role="menuitem" disabled={!canRedo} title="Redo (⇧⌘Z)" onClick={() => replayHistory("redo")}>Redo <span aria-hidden="true">⇧⌘Z</span></button>
                </>
              ) : null}
              <button role="menuitem" onClick={() => { setMenuOpen(false); boardMenuActions.onCanvasOutline(); }}><ListTree size={15} /> {withCount("Canvas outline", boardMenuActions.selectionCount, "selected")}</button>
              <button role="menuitem" onClick={() => { setMenuOpen(false); boardMenuActions.onActivity(); }}><Activity size={15} /> Activity</button>
              {self.role === "participant" ? (
                <button role="menuitem" disabled={boardMenuActions.askPreparing} onClick={() => { setMenuOpen(false); boardMenuActions.onAsk(); }}><MessageCircle size={15} /> {boardMenuActions.askPreparing ? "Preparing Ask…" : withCount("Ask agent", boardMenuActions.selectionCount, "selected")}</button>
              ) : null}
              <button role="menuitem" onClick={() => { setMenuOpen(false); boardMenuActions.onExport(); }}><Download size={15} /> Export</button>
              <button role="menuitem" onClick={() => { setMenuOpen(false); boardMenuActions.onReview(); }}><ScanSearch size={15} /> {withCount("Review", boardMenuActions.pendingReviewCount, "pending")}</button>
              {self.role === "spectator" ? (
                <button role="menuitem" onClick={() => { setMenuOpen(false); boardMenuActions.onUpgradeRole(); }}><ShieldCheck size={15} /> Become a participant</button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div
        className={styles.toolbar}
        aria-label="Canvas zoom controls"
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <button aria-label="Zoom out" onClick={() => zoomAtCenter(1 / 1.2)}><Minus size={15} /></button>
        <span className={styles.zoomValue}>{Math.round(viewport.zoom * 100)}%</span>
        <button aria-label="Zoom in" onClick={() => zoomAtCenter(1.2)}><Plus size={15} /></button>
        <button aria-label="Fit board" onClick={fitBoard}><Maximize2 size={15} /></button>
      </div>
    </>
  );

  return (
    <div
      ref={shellRef}
      className={`${styles.shell} ${panning ? styles.panning : ""}`}
      data-testid="semantic-canvas"
      data-canvas-renderer="jazzboard-semantic-v1"
      data-canvas-editing={editingEnabled ? "enabled" : "disabled"}
      data-active-tool={editingEnabled ? activeTool : undefined}
      role="region"
      aria-label={`${projectedRoom.title} semantic canvas`}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerLeave}
      onContextMenu={handleContextMenu}
      onPaste={handlePaste}
      onCopy={handleCopy}
      onCut={handleCut}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={() => { spaceHeldRef.current = false; }}
    >
      <svg className={styles.viewport} width="100%" height="100%" aria-label="Board objects">
        <g transform={`translate(${-viewport.x * viewport.zoom} ${-viewport.y * viewport.zoom}) scale(${viewport.zoom})`}>
          {scene.objects.map(({ object, bounds }) => object.kind === "connector" ? (
            <SemanticCanvasObject
              key={`connector-shaft:${object.id}`}
              object={object}
              bounds={bounds}
              connectorRoute={scene.connectorRoutes[object.id]}
              connectorLayer="shaft"
              selected={selectionSet.has(object.id)}
              focused={focusedObjectId === object.id}
              tabIndex={effectiveTabStopObjectId === object.id ? 0 : -1}
              className={styles.objectHitTarget}
              onSelect={handleObjectSelect}
              onPointerStart={controller ? handleObjectPointerStart : undefined}
              onEditRequested={controller ? requestTextEdit : undefined}
              onFocus={handleObjectFocus}
              onBlur={(objectId) => setFocusedObjectId((current) => current === objectId ? null : current)}
            />
          ) : null)}
          {scene.objects.map(({ object, bounds }) => object.kind !== "connector" ? (
            <SemanticCanvasObject
              key={`object:${object.id}`}
              object={object}
              bounds={bounds}
              selected={selectionSet.has(object.id)}
              focused={focusedObjectId === object.id}
              tabIndex={effectiveTabStopObjectId === object.id ? 0 : -1}
              className={styles.objectHitTarget}
              onSelect={handleObjectSelect}
              onPointerStart={controller ? handleObjectPointerStart : undefined}
              onEditRequested={controller ? requestTextEdit : undefined}
              onFocus={handleObjectFocus}
              onBlur={(objectId) => setFocusedObjectId((current) => current === objectId ? null : current)}
            />
          ) : null)}
          {scene.objects.map(({ object, bounds }) => object.kind === "connector" ? (
            <SemanticCanvasConnectorOverlay
              key={`connector-overlay:${object.id}`}
              object={object}
              bounds={bounds}
              connectorRoute={scene.connectorRoutes[object.id]}
              focused={focusedObjectId === object.id}
              onSelect={handleObjectSelect}
              onPointerStart={controller ? handleObjectPointerStart : undefined}
            />
          ) : null)}
          {activeMarqueeSession ? (
            <rect
              className={styles.marquee}
              data-testid="semantic-marquee"
              x={activeMarqueeSession.bounds.x}
              y={activeMarqueeSession.bounds.y}
              width={activeMarqueeSession.bounds.width}
              height={activeMarqueeSession.bounds.height}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ) : null}
        </g>
      </svg>

      <AgentDraftLayer
        authoritativeObjects={projectedRoom.objects}
        drafts={agentDrafts}
        roomId={projectedRoom.id}
        viewport={viewport}
      />

      {activeTextEditor ? (() => {
        const object = scene.objectsById[activeTextEditor.objectId]?.object;
        if (!object || object.kind === "draw") return null;
        return (
          <SemanticTextEditor
            sessionId={activeTextEditor.session.token.sessionId}
            object={object}
            viewport={viewport}
            draft={activeTextEditor.mode === "create"
              ? activeTextEditor.session.draft.kind === "text"
                ? activeTextEditor.session.draft.content
                : ""
              : activeTextEditor.session.draftValue}
            onDraftChange={updateTextDraft}
            onCommit={commitTextEdit}
            onCancel={cancelTextEdit}
            commitOnEnter={activeTextEditor.mode === "create"}
          />
        );
      })() : null}

      {!scene.objects.length ? (
        <div className={styles.empty}>This board is empty. Participants can add the first semantic object.</div>
      ) : null}

      <CanvasPresenceOverlay
        agentDrafts={agentDrafts}
        runtime={runtime}
        room={projectedRoom}
        selfId={self.participantId}
      />

      {activeContextMenu ? (
        <SemanticCanvasContextMenu
          x={activeContextMenu.x}
          y={activeContextMenu.y}
          label={activeContextMenu.objectId ? "Object actions" : "Canvas actions"}
          items={contextMenuItemsFor(activeContextMenu)}
          onAction={runContextMenuAction}
          onDismiss={dismissContextMenu}
        />
      ) : null}

      <SemanticSelectionControls
        selectedObjects={selection.flatMap((objectId) => scene.objectsById[objectId] ? [scene.objectsById[objectId]!] : [])}
        viewport={viewport}
        editing={editingEnabled}
        connectorRoute={selection.length === 1 ? scene.connectorRoutes[selection[0]!] : null}
        onTransformPointerStart={startSelectionTransform}
        onDelete={() => runSelectionAction("delete")}
        onGroup={() => runSelectionAction("group")}
        onUngroup={() => runSelectionAction("ungroup")}
        onBringForward={() => runSelectionAction("forward")}
        onSendBackward={() => runSelectionAction("backward")}
        onContextMenu={handleContextMenu}
        styleControls={(
          <SemanticStyleControls
            selectedObjects={selection.flatMap((objectId) => scene.objectsById[objectId]?.object ? [scene.objectsById[objectId]!.object] : [])}
            editing={editingEnabled}
            disabled={Boolean(activeTextEditor)}
            onStylePatch={applyStylePatch}
            onEditRequest={editFromStyle}
          />
        )}
      />

      {editingEnabled ? (
        <SemanticImagePicker
          key={projectedRoom.id}
          ref={imagePickerRef}
          roomId={projectedRoom.id}
          disabled={hasActivePointerSession() || Boolean(activeTextEditor)}
          onReady={handleImageReady}
          onError={reportAuthoringError}
          onDismiss={() => setActiveTool("select")}
        />
      ) : null}
      {persistentChromeHost
        ? createPortal(persistentCanvasChrome, persistentChromeHost)
        : persistentCanvasChrome}
      <div className={styles.srOnly} aria-live="polite">
        {selection.length ? `${selection.length} canvas object${selection.length === 1 ? "" : "s"} selected.` : "Canvas selection cleared."}
      </div>
    </div>
  );
});
