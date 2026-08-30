"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  Boxes,
  Check,
  ChevronDown,
  CircleHelp,
  Eye,
  Focus,
  LoaderCircle,
  MousePointer2,
  Network,
  PencilLine,
  Plus,
  Presentation,
  Radio,
  RefreshCw,
  Share2,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { JazzboardLogo } from "@/components/brand/JazzboardLogo";
import { downloadBlobFile } from "@/lib/client/download";
import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type {
  ActorKind,
  CanvasObject,
  Diagram,
  DiagramPatch,
  DiagramType,
  FollowTarget,
  NodeMetadataInput,
  ObjectPatch,
  RecentRoom,
  RoomState,
  RoomActivitySummary,
  SemanticTransaction,
} from "@/lib/domain/types";
import { useRoomActivity } from "@/hooks/use-room-activity";
import {
  InRoomCanvasPreviewTransport,
  JazzboardWebMcpRegistrar,
  prepareCanvasInspection,
  presentLiveCanvasPreview,
  renderCanvasPreview,
} from "@/lib/webmcp";
import type { JazzboardWebMcpContext } from "@/lib/webmcp";
import { useRoom } from "@/hooks/use-room";

import { CanvasSurface, type CanvasSurfaceHandle } from "./CanvasSurface";
import type { BoardMenuActions } from "./canvas-surface-types";
import { ActivityTimeline, type ActivityActorFilter } from "./ActivityTimeline";
import { AgentAvatar, isAgentActivityWorking } from "./AgentAvatar";
import { AskAgentPanel } from "./AskAgentPanel";
import { DurabilityPanel, type DurabilityPanelMode } from "./DurabilityPanel";
import { ReviewPanel } from "./ReviewPanel";
import {
  MobileRoomCollaboration,
  type MobileCollaborationSurface,
} from "./MobileRoomCollaboration";
import {
  announceMobileSurfaceOpen,
  subscribeToMobileSurfaceOpen,
} from "./mobile-surface-coordinator";
import { useCanvasMobileLayout } from "./useCanvasMobileLayout";
import styles from "./room.module.css";

const RECENT_ROOMS_KEY = "jazzboard:recent-rooms:v1";

const DIAGRAM_TYPE_OPTIONS: Array<{ value: DiagramType; label: string }> = [
  { value: "architecture", label: "Architecture" },
  { value: "flow", label: "Flow" },
  { value: "hierarchy", label: "Hierarchy" },
  { value: "system_context", label: "System context" },
  { value: "process", label: "Process" },
  { value: "custom", label: "Custom" },
];

type DiagramEditorState =
  | { mode: "create"; diagramId: string }
  | { mode: "edit"; diagram: Diagram };

function createDiagramId(): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replaceAll("-", "").slice(0, 16)
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `diagram_${suffix}`;
}

function humanizeDiagramType(type: string): string {
  return type.replaceAll("_", " ");
}

function saveRecent(room: RoomState, participantId: string) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_ROOMS_KEY) ?? "[]") as unknown;
    const recent = Array.isArray(parsed) ? (parsed as RecentRoom[]) : [];
    const role = room.participants[participantId]?.role ?? "participant";
    const next: RecentRoom = {
      roomId: room.id,
      code: room.code,
      title: room.title,
      role,
      lastOpenedAt: Date.now(),
    };
    window.localStorage.setItem(
      RECENT_ROOMS_KEY,
      JSON.stringify([next, ...recent.filter((entry) => entry.roomId !== room.id)].slice(0, 8)),
    );
  } catch {
    // Recent rooms are a convenience only.
  }
}

function objectLabel(room: RoomState, objectId: string): string {
  const object = room.objects[objectId];
  if (!object) return objectId;
  if (object.kind === "text") return object.content || "Untitled text";
  if (object.kind === "shape") return object.label || `${object.shape} node`;
  if (object.kind === "connector") return object.label || "Connector";
  if (object.kind === "image") return object.alt || "Image";
  return "Freehand annotation";
}

export function JazzboardRoom({ roomId }: { roomId: string }) {
  const router = useRouter();
  const controller = useRoom(roomId);
  const mobileLayout = useCanvasMobileLayout();
  const { room, self, participantId } = controller;
  const spotlightAction = controller.spotlight;
  const retireCommittedAgentDraft = controller.retireCommittedAgentDraft;
  const [followTarget, setFollowTarget] = useState<FollowTarget>(null);
  const [followOpen, setFollowOpen] = useState(false);
  const [presenceOpen, setPresenceOpen] = useState(false);
  const [statusTooltip, setStatusTooltip] = useState<"connection" | "people" | "share" | "spotlight" | null>(null);
  const [spotlightPickerOpen, setSpotlightPickerOpen] = useState(false);
  const [mobileCollaborationSurface, setMobileCollaborationSurface] =
    useState<MobileCollaborationSurface>("closed");
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [durabilityOpen, setDurabilityOpen] = useState(false);
  const [durabilityMode, setDurabilityMode] = useState<DurabilityPanelMode>("export");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [askSelection, setAskSelection] = useState<CanvasObject[] | null>(null);
  const [askPreparing, setAskPreparing] = useState(false);
  const [askPreparationError, setAskPreparationError] = useState<string | null>(null);
  const [activityFilter, setActivityFilter] = useState<ActivityActorFilter>("all");
  const [diagramEditor, setDiagramEditor] = useState<DiagramEditorState | null>(null);
  const [nodeEditorId, setNodeEditorId] = useState<string | null>(null);
  const [diagramAnnouncement, setDiagramAnnouncement] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const [canvasRuntime, setCanvasRuntime] = useState<CanvasRuntime | null>(null);
  const [cleanInspectionId, setCleanInspectionId] = useState<string | null>(null);
  const [persistentChromeHost, setPersistentChromeHost] = useState<HTMLDivElement | null>(null);
  const [toast, setToast] = useState<{ message: string; details?: unknown } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [declinedSpotlight, setDeclinedSpotlight] = useState<number | null>(null);
  const spotlightJoinRef = useRef<number | null>(null);
  const roomStateRef = useRef(room);
  const selectionRef = useRef(selection);
  const canvasRuntimeRef = useRef(canvasRuntime);
  const followTargetRef = useRef(followTarget);
  const followPopoverAnchorRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<CanvasSurfaceHandle | null>(null);
  const [previewTransport] = useState(() => new InRoomCanvasPreviewTransport());
  const [webMcpRegistrar] = useState(
    () => new JazzboardWebMcpRegistrar({ canvasPreviewTransport: previewTransport }),
  );
  const webMcpRoomId = room?.id ?? null;
  const webMcpRole = self?.role ?? null;
  const roomActivity = useRoomActivity({
    roomId,
    enabled: activityOpen,
    acceptRoom: controller.acceptRoom,
  });

  const updateFollowTarget = useCallback((target: FollowTarget) => {
    followTargetRef.current = target;
    setFollowTarget(target);
  }, []);

  const updateDeclinedSpotlight = useCallback((startedAt: number | null) => {
    setDeclinedSpotlight(startedAt);
  }, []);

  const leaveRoomView = useCallback(() => {
    router.push("/");
  }, [router]);

  const closeAskPanel = useCallback(() => {
    setAskSelection(null);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="main-menu.button"]')?.focus();
    });
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (room && participantId) saveRecent(room, participantId);
  }, [participantId, room]);

  useEffect(() => {
    if (!followOpen) return;
    const dismissOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || followPopoverAnchorRef.current?.contains(target)) return;
      setFollowOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [followOpen]);

  useEffect(() => {
    if (!mobileLayout) return;
    return subscribeToMobileSurfaceOpen((surfaceId) => {
      if (surfaceId !== "collaboration") setMobileCollaborationSurface("closed");
      if (surfaceId !== "room-share" && surfaceId !== "room-durability") setDurabilityOpen(false);
      if (surfaceId !== "room-spotlight") setSpotlightPickerOpen(false);
      if (surfaceId !== "room-outline") setOutlineOpen(false);
      if (surfaceId !== "room-activity") setActivityOpen(false);
      if (surfaceId !== "room-review") setReviewOpen(false);
      if (surfaceId !== "room-ask") setAskSelection(null);
    });
  }, [mobileLayout]);

  useEffect(() => {
    roomStateRef.current = room;
    selectionRef.current = selection;
    canvasRuntimeRef.current = canvasRuntime;
    followTargetRef.current = followTarget;
  }, [canvasRuntime, followTarget, room, selection]);

  useEffect(() => {
    const canRenderPng = canvasRuntimeRef.current?.capabilities.renderPng === true;
    const context: JazzboardWebMcpContext = {
      getRoom: () => roomStateRef.current,
      getSelection: () => selectionRef.current,
      getViewport: () => canvasRuntimeRef.current?.getViewport() ?? null,
      getFollowTarget: () => followTargetRef.current,
      inspectCanvasScope: (request, signal) =>
        prepareCanvasInspection(
          { getCanvasRuntime: () => canvasRuntimeRef.current, getRoom: () => roomStateRef.current },
          request,
          signal,
        ),
      presentCanvasPreview: (artifact, signal) => presentLiveCanvasPreview(
        {
          getCanvasRuntime: () => canvasRuntimeRef.current,
          getCanvasElement: () => canvasRef.current?.getCanvasElement() ?? null,
          getRoom: () => roomStateRef.current,
          isCameraFollowActive: () => Boolean(
            followTargetRef.current
            || (
              participantId
              && roomStateRef.current?.spotlight?.followingParticipantIds.includes(participantId)
            )
          ),
          setCleanInspection: setCleanInspectionId,
        },
        artifact,
        signal,
      ),
      ...(canRenderPng ? {
        renderCanvasPreview: (request, signal) =>
          renderCanvasPreview(
            { getCanvasRuntime: () => canvasRuntimeRef.current, getRoom: () => roomStateRef.current },
            request,
            signal,
          ),
        saveCanvasPng: async (artifact, filename, signal) => {
          if (signal.aborted) throw new DOMException("The PNG export was cancelled.", "AbortError");
          downloadBlobFile(artifact.blob, filename);
        },
      } : {}),
      acceptRoom: controller.acceptRoom,
      acceptAgentDraft: controller.acceptAgentDraft,
      removeAgentDraft: controller.removeAgentDraft,
      retireCommittedAgentDraft: (draftId, draftRevision, authoritativeRoomRevision) => {
        if (!webMcpRoomId) return;
        retireCommittedAgentDraft(
          webMcpRoomId,
          draftId,
          draftRevision,
          authoritativeRoomRevision,
        );
      },
      getAgentDraftPresentation: (draftId, revision) =>
        canvasRef.current?.getAgentDraftPresentation(draftId, revision) ?? {
          source: "client-local",
          draftId,
          requestedRevision: revision,
          observedRevision: null,
          state: "unavailable",
          complete: false,
          objectCount: 0,
          completedObjectCount: 0,
        },
      setFollowTarget: updateFollowTarget,
      setDeclinedSpotlight: updateDeclinedSpotlight,
      leaveRoomView,
    };
    const binding = webMcpRoomId && webMcpRole && participantId
      ? { roomId: webMcpRoomId, participantId, role: webMcpRole, context }
      : null;
    void webMcpRegistrar.update(binding).catch(() => undefined);
    return () => {
      webMcpRegistrar.dispose();
    };
  }, [
    controller.acceptRoom,
    controller.acceptAgentDraft,
    controller.removeAgentDraft,
    canvasRuntime?.capabilities.renderPng,
    canvasRuntime?.rendererId,
    leaveRoomView,
    participantId,
    retireCommittedAgentDraft,
    updateDeclinedSpotlight,
    updateFollowTarget,
    webMcpRegistrar,
    webMcpRole,
    webMcpRoomId,
  ]);

  useEffect(() => {
    if (!room?.spotlight || !participantId) return;
    const spotlight = room.spotlight;
    if (spotlight.presenterId === participantId) return;
    if (spotlight.followingParticipantIds.includes(participantId)) return;
    if (declinedSpotlight === spotlight.startedAt) return;
    if (spotlightJoinRef.current) window.clearTimeout(spotlightJoinRef.current);
    spotlightJoinRef.current = window.setTimeout(
      () => void spotlightAction({ action: "join" }).catch(() => undefined),
      Math.max(spotlight.autoFollowAt - Date.now(), 0),
    );
    return () => {
      if (spotlightJoinRef.current) window.clearTimeout(spotlightJoinRef.current);
    };
  }, [declinedSpotlight, participantId, room?.spotlight, spotlightAction]);

  let spotlightFollowTarget: FollowTarget = null;
  if (
    room?.spotlight &&
    participantId &&
    room.spotlight.followingParticipantIds.includes(participantId)
  ) {
    spotlightFollowTarget = { participantId: room.spotlight.presenterId, kind: room.spotlight.target };
  }
  const effectiveFollowTarget = spotlightFollowTarget ?? followTarget;
  const followedParticipant =
    room && effectiveFollowTarget ? room.participants[effectiveFollowTarget.participantId] : null;

  const showError = useCallback((message: string, details?: unknown) => {
    setToast({ message, details });
    window.setTimeout(() => setToast((current) => (current?.message === message ? null : current)), 5_000);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (statusTooltip) setStatusTooltip(null);
      if (followTarget) updateFollowTarget(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [followTarget, statusTooltip, updateFollowTarget]);

  if (!room || !self || !participantId) {
    const notAuthorized =
      controller.error &&
      "status" in controller.error &&
      typeof controller.error.status === "number" &&
      [401, 403, 404].includes(controller.error.status);
    return (
      <main className={styles.loadingPage}>
        <JazzboardLogo />
        {notAuthorized ? (
          <div className={styles.loadingCard}>
            <Eye size={26} />
            <h1>Room access needed</h1>
            <p>{controller.error?.message ?? "This browser is not a member of that Jazzboard."}</p>
            <Link href="/">Return to Jazzboard</Link>
          </div>
        ) : (
          <div className={styles.loadingCard} role="status">
            <LoaderCircle className={styles.spin} size={28} />
            <h1>Opening the room</h1>
            <p>Reconnecting to the shared canvas…</p>
          </div>
        )}
      </main>
    );
  }

  const participants = Object.values(room.participants).filter((participant) => participant.role === "participant");
  const followedAgentWorking = followedParticipant
    ? isAgentActivityWorking(followedParticipant.agent.activity, now)
    : false;
  const selfAgentWorking = isAgentActivityWorking(self.agent.activity, now);
  const spotlight = room.spotlight;
  const presenter = spotlight ? room.participants[spotlight.presenterId] : null;
  const handoffRequester = spotlight?.handoffRequest
    ? room.participants[spotlight.handoffRequest.requesterId]
    : null;
  const requestedBySelf = spotlight?.handoffRequest?.requesterId === participantId;
  const countdown = spotlight ? Math.max(0, Math.ceil((spotlight.autoFollowAt - now) / 1_000)) : 0;
  const followingSpotlight = spotlight?.followingParticipantIds.includes(participantId) ?? false;
  const declined = spotlight ? declinedSpotlight === spotlight.startedAt : false;
  const diagrams = Object.values(room.diagrams ?? {}).sort((a, b) => b.updatedAt - a.updatedAt);
  const participantCount = Object.keys(room.participants).length;
  const connectionLabel = controller.connection === "live"
    ? "Live"
    : controller.connection === "polling"
      ? "Synced"
      : controller.connection === "offline"
        ? "Offline"
        : "Connecting";
  const peopleLabel = `${participantCount} ${participantCount === 1 ? "person" : "people"} in this room · Your role: ${self.role}`;
  const spotlightButtonLabel = spotlight?.presenterId === participantId
    ? "Stop Spotlight"
    : requestedBySelf
      ? "Spotlight requested"
      : spotlight
        ? "Request Spotlight"
        : "Spotlight";

  function toggleDurability(nextMode: DurabilityPanelMode) {
    if (mobileLayout) {
      announceMobileSurfaceOpen(nextMode === "share" ? "room-share" : "room-durability");
      setMobileCollaborationSurface("closed");
      setSpotlightPickerOpen(false);
    }
    setDurabilityOpen((open) => nextMode !== durabilityMode || !open);
    setDurabilityMode(nextMode);
    setOutlineOpen(false);
    setActivityOpen(false);
    setReviewOpen(false);
    setAskSelection(null);
    setPresenceOpen(false);
    setFollowOpen(false);
  }

  function toggleCanvasOutline() {
    if (mobileLayout) announceMobileSurfaceOpen("room-outline");
    setOutlineOpen((open) => !open);
    setActivityOpen(false);
    setDurabilityOpen(false);
    setReviewOpen(false);
    setAskSelection(null);
    setPresenceOpen(false);
    setFollowOpen(false);
  }

  function toggleActivity() {
    if (mobileLayout) announceMobileSurfaceOpen("room-activity");
    setActivityOpen((open) => !open);
    setOutlineOpen(false);
    setDurabilityOpen(false);
    setReviewOpen(false);
    setAskSelection(null);
    setPresenceOpen(false);
    setFollowOpen(false);
  }

  function toggleAgentReview() {
    if (mobileLayout) announceMobileSurfaceOpen("room-review");
    setReviewOpen((open) => !open);
    setOutlineOpen(false);
    setActivityOpen(false);
    setDurabilityOpen(false);
    setAskSelection(null);
    setPresenceOpen(false);
    setFollowOpen(false);
  }

  function follow(participantIdToFollow: string, kind: ActorKind) {
    if (participantIdToFollow === participantId && kind === "human") updateFollowTarget(null);
    else updateFollowTarget({ participantId: participantIdToFollow, kind });
    setFollowOpen(false);
  }

  function focusObject(objectId: string) {
    if (!canvasRuntime) return;
    const bounds = canvasRuntime.getObjectBounds(objectId);
    canvasRuntime.selectObjects([objectId]);
    if (bounds) {
      canvasRuntime.zoomToBounds(bounds, {
        targetZoom: 1.25,
        inset: 220,
        durationMs: 180,
      });
    }
    setOutlineOpen(false);
  }

  function focusDiagram(diagram: Diagram) {
    const currentRoom = roomStateRef.current;
    if (!canvasRuntime || !currentRoom) return;
    const objectIds = [...diagram.memberObjectIds, ...diagram.connectorIds]
      .filter((objectId) => Boolean(currentRoom.objects[objectId] && canvasRuntime.hasObject(objectId)));
    if (objectIds.length) canvasRuntime.selectObjects(objectIds);
    if (diagram.bounds.width > 0 && diagram.bounds.height > 0) {
      canvasRuntime.zoomToBounds(diagram.bounds, { inset: 120, durationMs: 180 });
    }
    setOutlineOpen(false);
  }

  function focusActivity(activity: RoomActivitySummary) {
    const currentRoom = roomStateRef.current;
    if (!canvasRuntime || !currentRoom) return;
    const objectIds = activity.affectedObjectIds
      .filter((objectId) => Boolean(currentRoom.objects[objectId] && canvasRuntime.hasObject(objectId)));
    if (objectIds.length) canvasRuntime.selectObjects(objectIds);
    if (activity.affectedBounds) {
      canvasRuntime.zoomToBounds(activity.affectedBounds, { inset: 150, durationMs: 180 });
    }
  }

  function focusReviewObjects(objectIds: string[]) {
    const currentRoom = roomStateRef.current;
    if (!canvasRuntime || !currentRoom) return;
    const visibleObjectIds = objectIds
      .filter((objectId) => Boolean(currentRoom.objects[objectId] && canvasRuntime.hasObject(objectId)));
    if (!visibleObjectIds.length) {
      setDiagramAnnouncement("Those objects have not been applied to the canvas yet.");
      window.setTimeout(() => setDiagramAnnouncement(""), 4_000);
      return;
    }
    canvasRuntime.selectObjects(visibleObjectIds);
    const bounds = canvasRuntime.getVisibleBounds(visibleObjectIds);
    if (bounds) canvasRuntime.zoomToBounds(bounds, { inset: 150, durationMs: 180 });
  }

  async function saveDiagram(transaction: SemanticTransaction, title: string) {
    await controller.semanticTransaction(transaction);
    setDiagramEditor(null);
    setDiagramAnnouncement(`Diagram ${title} saved.`);
    window.setTimeout(() => setDiagramAnnouncement(""), 4_000);
  }

  async function saveNodeMetadata(
    object: Extract<CanvasObject, { kind: "shape" }>,
    patch: ObjectPatch,
  ) {
    await controller.command({
      type: "update",
      objectId: object.id,
      expectedRevision: object.revision,
      operation: "edit",
      patch,
    });
    setNodeEditorId(null);
    setDiagramAnnouncement(`Semantic metadata saved for ${object.label || object.id}.`);
    window.setTimeout(() => setDiagramAnnouncement(""), 4_000);
  }

  async function declineCurrentSpotlight() {
    if (!spotlight) return;
    updateDeclinedSpotlight(spotlight.startedAt);
    await controller.spotlight({ action: "leave" }).catch((error) => showError(String(error)));
  }

  function chooseSpotlightTarget(target: ActorKind) {
    const requestingHandoff = Boolean(spotlight && spotlight.presenterId !== participantId);
    setSpotlightPickerOpen(false);
    void spotlightAction({ action: requestingHandoff ? "request" : "start", target }).catch((error) =>
      showError(error instanceof Error ? error.message : "Spotlight could not be updated."),
    );
  }

  function openMobileCollaboration() {
    setPresenceOpen(false);
    setFollowOpen(false);
    setDurabilityOpen(false);
    setSpotlightPickerOpen(false);
  }

  function openMobileSpotlight() {
    setMobileCollaborationSurface("closed");
    setPresenceOpen(false);
    setFollowOpen(false);
    setDurabilityOpen(false);
    if (spotlight?.presenterId === participantId) {
      void spotlightAction({ action: "stop" });
      return;
    }
    announceMobileSurfaceOpen("room-spotlight");
    setSpotlightPickerOpen(true);
  }

  async function toggleAskPanel() {
    if (askSelection !== null) {
      closeAskPanel();
      return;
    }
    if (mobileLayout) announceMobileSurfaceOpen("room-ask");
    setOutlineOpen(false);
    setActivityOpen(false);
    setDurabilityOpen(false);
    setReviewOpen(false);
    setPresenceOpen(false);
    setFollowOpen(false);
    setAskPreparationError(null);
    setAskPreparing(true);
    try {
      const prepared = await canvasRef.current?.prepareSelectionForAgentMessage();
      if (!prepared) throw new Error("The canvas is still starting. Try Ask again in a moment.");
      const selectedObjects = prepared.objectIds.map((objectId) => prepared.room.objects[objectId]);
      if (selectedObjects.some((object) => !object)) {
        throw new Error("The selected canvas items changed before Ask could capture them. Try again.");
      }
      controller.acceptRoom(prepared.room);
      setAskSelection(selectedObjects.map((object) => structuredClone(object!)));
    } catch (error) {
      setAskPreparationError(
        error instanceof Error ? error.message : "The selected canvas items could not be prepared for Ask.",
      );
    } finally {
      setAskPreparing(false);
    }
  }

  const boardMenuActions: BoardMenuActions = {
    askPreparing,
    pendingReviewCount: room.reviewProposals.filter((proposal) => proposal.status === "pending").length,
    selectionCount: selection.length,
    onActivity: toggleActivity,
    onAsk: () => void toggleAskPanel(),
    onCanvasOutline: toggleCanvasOutline,
    onExport: () => toggleDurability("export"),
    onReview: toggleAgentReview,
    onUpgradeRole: () => void controller.upgradeRole(),
  };

  return (
    <main
      className={`${styles.roomPage} ${effectiveFollowTarget ? styles.following : ""}`}
      data-jazzboard-room
      data-clean-inspection={cleanInspectionId ? "true" : undefined}
      style={{ "--follow-color": followedParticipant?.color ?? "#5B5CE2" } as React.CSSProperties}
    >
      <div className={styles.viewportChromeLayer} data-testid="room-viewport-chrome">
        <header className={styles.roomHeader}>
          <div className={`${styles.floatingBar} ${styles.roomControls} ${styles.desktopRoomControls}`} data-testid="room-controls">
          <div className={styles.secondaryIndicators} aria-label="Room status">
            <span
              aria-describedby={statusTooltip === "connection" ? "connection-status-tooltip" : undefined}
              aria-label={`Connection: ${connectionLabel}`}
              className={`${styles.compactIndicator} ${styles.tooltipTrigger} ${styles.connectionIndicator} ${
                controller.connection === "offline"
                  ? styles.offline
                  : controller.connection === "connecting"
                    ? styles.connecting
                    : ""
              }`}
              data-testid="connection-status"
              onBlur={() => setStatusTooltip(null)}
              onFocus={() => setStatusTooltip("connection")}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setStatusTooltip(null);
                  event.stopPropagation();
                }
              }}
              onMouseEnter={() => setStatusTooltip("connection")}
              onMouseLeave={() => setStatusTooltip(null)}
              role="status"
              tabIndex={0}
            >
              <i className={styles.connectionDot} aria-hidden="true" />
              {statusTooltip === "connection" ? (
                <span className={styles.compactTooltip} id="connection-status-tooltip" role="tooltip">
                  {connectionLabel}
                </span>
              ) : null}
            </span>
            <div className={styles.popoverAnchor}>
              <button
                aria-describedby={statusTooltip === "people" ? "room-people-tooltip" : undefined}
                aria-label="Show people in this room"
                aria-expanded={presenceOpen}
                className={`${styles.compactIndicator} ${styles.tooltipTrigger}`}
                onBlur={() => setStatusTooltip(null)}
                onClick={() => {
                  setStatusTooltip(null);
                  setPresenceOpen((open) => !open);
                  setFollowOpen(false);
                  setDurabilityOpen(false);
                }}
                onFocus={() => {
                  if (!presenceOpen) setStatusTooltip("people");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setStatusTooltip(null);
                    event.stopPropagation();
                  }
                }}
                onMouseEnter={() => {
                  if (!presenceOpen) setStatusTooltip("people");
                }}
                onMouseLeave={() => setStatusTooltip(null)}
              >
                <Users size={15} />
                <span className={styles.indicatorCount}>{participantCount}</span>
                {statusTooltip === "people" ? (
                  <span className={styles.compactTooltip} id="room-people-tooltip" role="tooltip">
                    {peopleLabel}
                  </span>
                ) : null}
              </button>
              {presenceOpen ? <PresencePopover now={now} room={room} selfId={participantId} /> : null}
            </div>
          </div>
          <span className={styles.controlDivider} aria-hidden="true" />
          <div ref={followPopoverAnchorRef} className={styles.popoverAnchor}>
            <button
              className={styles.controlButton}
              onClick={() => {
                setFollowOpen((open) => !open);
                setPresenceOpen(false);
                setDurabilityOpen(false);
              }}
              aria-expanded={followOpen}
            >
              <Focus size={15} /> Follow <ChevronDown size={14} />
            </button>
            {followOpen ? (
              <FollowPopover
                participants={participants}
                now={now}
                selfId={participantId}
                current={followTarget}
                onFollow={follow}
              />
            ) : null}
          </div>
          {self.role === "participant" ? (
            <button
              aria-describedby={statusTooltip === "spotlight" ? "spotlight-button-tooltip" : undefined}
              aria-label={spotlightButtonLabel}
              className={`${styles.controlButton} ${styles.iconControlButton} ${styles.tooltipTrigger} ${styles.spotlightButton}`}
              onBlur={() => setStatusTooltip(null)}
              onClick={() => {
                setStatusTooltip(null);
                if (spotlight?.presenterId === participantId) void controller.spotlight({ action: "stop" });
                else setSpotlightPickerOpen(true);
              }}
              onFocus={() => setStatusTooltip("spotlight")}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setStatusTooltip(null);
                  event.stopPropagation();
                }
              }}
              onMouseEnter={() => setStatusTooltip("spotlight")}
              onMouseLeave={() => setStatusTooltip(null)}
            >
              <Presentation size={16} />
              {statusTooltip === "spotlight" ? (
                <span className={styles.compactTooltip} id="spotlight-button-tooltip" role="tooltip">
                  {spotlightButtonLabel}
                </span>
              ) : null}
            </button>
          ) : null}
          <button
            aria-describedby={statusTooltip === "share" ? "share-board-button-tooltip" : undefined}
            aria-label="Share board"
            aria-expanded={durabilityOpen && durabilityMode === "share"}
            className={`${styles.controlButton} ${styles.iconControlButton} ${styles.tooltipTrigger} ${styles.shareBoardButton}`}
            onBlur={() => setStatusTooltip(null)}
            onClick={() => {
              setStatusTooltip(null);
              toggleDurability("share");
            }}
            onFocus={() => {
              if (!(durabilityOpen && durabilityMode === "share")) setStatusTooltip("share");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setStatusTooltip(null);
                event.stopPropagation();
              }
            }}
            onMouseEnter={() => {
              if (!(durabilityOpen && durabilityMode === "share")) setStatusTooltip("share");
            }}
            onMouseLeave={() => setStatusTooltip(null)}
          >
            <Share2 size={16} />
            {statusTooltip === "share" ? (
              <span
                className={`${styles.compactTooltip} ${styles.tooltipAlignEnd}`}
                id="share-board-button-tooltip"
                role="tooltip"
              >
                Share board
              </span>
            ) : null}
          </button>
          </div>
        </header>
        {mobileLayout ? (
          <MobileRoomCollaboration
            activeSurface={mobileCollaborationSurface}
            canSpotlight={self.role === "participant"}
            connectionLabel={connectionLabel}
            connectionState={controller.connection}
            followContent={(
              <FollowPopover
                participants={participants}
                now={now}
                selfId={participantId}
                current={followTarget}
                onFollow={(targetParticipantId, kind) => {
                  follow(targetParticipantId, kind);
                  setMobileCollaborationSurface("closed");
                }}
              />
            )}
            followSummary={followedParticipant
              ? `Following ${followedParticipant.displayName}’s ${effectiveFollowTarget?.kind}`
              : "Choose a person's cursor or agent"}
            peopleContent={<PresencePopover now={now} room={room} selfId={participantId} />}
            peopleLabel={peopleLabel}
            participantCount={participantCount}
            spotlightLabel={spotlightButtonLabel}
            onOpen={openMobileCollaboration}
            onShare={() => toggleDurability("share")}
            onSpotlight={openMobileSpotlight}
            onSurfaceChange={setMobileCollaborationSurface}
          />
        ) : null}
        <div ref={setPersistentChromeHost} className={styles.canvasChromeHost} data-testid="persistent-canvas-chrome" />
      </div>

      {effectiveFollowTarget && followedParticipant ? (
        <div className={styles.followBanner} role="status">
          {effectiveFollowTarget.kind === "agent" ? (
            <AgentAvatar
              displayName={followedParticipant.displayName}
              motion={followedAgentWorking ? "always" : "hover"}
              participantColor={followedParticipant.color}
              size={21}
              state={followedAgentWorking ? "working" : "idle"}
            />
          ) : <MousePointer2 size={16} />}
          <span>
            {spotlightFollowTarget ? "Spotlight" : "Following"}: {followedParticipant.displayName}’s {effectiveFollowTarget.kind}
            {spotlight?.presenterId === participantId
              ? ` · ${Math.max(spotlight.followingParticipantIds.length - 1, 0)} following`
              : ""}
          </span>
          <button
            onClick={() => {
              if (spotlightFollowTarget) void declineCurrentSpotlight();
              else updateFollowTarget(null);
            }}
          >
            {spotlightFollowTarget ? "Leave" : "Stop"}
          </button>
        </div>
      ) : null}

      {spotlight && presenter && spotlight.presenterId !== participantId && !followingSpotlight && !declined ? (
        <div className={styles.spotlightInvite} role="status" aria-live="polite">
          <span className={styles.pulseDot} style={{ background: presenter.color }} />
          <div>
            <strong>{presenter.displayName} is spotlighting their {spotlight.target}</strong>
            <span>{countdown > 0 ? `Following in ${countdown}…` : "Joining Spotlight…"}</span>
          </div>
          <button onClick={() => void controller.spotlight({ action: "join" })}>Follow now</button>
          <button className={styles.secondaryButton} onClick={() => void declineCurrentSpotlight()}>
            Decline
          </button>
        </div>
      ) : null}

      {spotlight && presenter && declined ? (
        <button
          className={styles.rejoinSpotlight}
          onClick={() => {
            updateDeclinedSpotlight(null);
            void spotlightAction({ action: "join" });
          }}
        >
          <Radio size={14} /> Rejoin {presenter.displayName}’s Spotlight
        </button>
      ) : null}

      {spotlight && spotlight.presenterId === participantId && spotlight.handoffRequest && handoffRequester ? (
        <div className={styles.handoffRequest} role="status" aria-live="polite">
          <span style={{ background: handoffRequester.color }}>{handoffRequester.displayName.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{handoffRequester.displayName} wants the Spotlight</strong>
            <small>Presenting their {spotlight.handoffRequest.target}</small>
          </div>
          <button onClick={() => void spotlightAction({ action: "handoff" }).catch((error) => showError(String(error)))}>
            Hand off
          </button>
          <button className={styles.secondaryButton} onClick={() => void spotlightAction({ action: "dismiss_request" })}>
            Not yet
          </button>
        </div>
      ) : null}

      <CanvasSurface
        ref={canvasRef}
        boardMenuActions={boardMenuActions}
        persistentChromeHost={persistentChromeHost}
        cleanInspectionId={cleanInspectionId}
        room={room}
        agentDrafts={controller.agentDrafts}
        initialAgentDraftIds={controller.initialAgentDraftIds}
        self={self}
        followTarget={effectiveFollowTarget}
        command={controller.command}
        semanticTransaction={controller.semanticTransaction}
        lease={controller.lease}
        leaseMany={controller.leaseMany}
        refresh={controller.refresh}
        renameRoom={controller.renameRoom}
        presence={controller.presence}
        transientPresence={controller.transientPresence}
        connection={controller.connection}
        onSelectionChange={setSelection}
        onRuntimeChange={setCanvasRuntime}
        onExitFollow={() => {
          if (spotlightFollowTarget) void spotlightAction({ action: "leave" });
          else updateFollowTarget(null);
        }}
        onError={showError}
      />
      {askPreparationError ? (
        <div className={styles.askPreparationError} role="alert">
          <span>{askPreparationError}</span>
          <button onClick={() => setAskPreparationError(null)} aria-label="Dismiss Ask error"><X size={13} /></button>
        </div>
      ) : null}

      {outlineOpen ? (
        <aside className={styles.outlinePanel} aria-label="Canvas outline">
          <div className={styles.panelHeading}>
            <div>
              <span>Canvas outline</span>
              <strong>{diagrams.length} diagram{diagrams.length === 1 ? "" : "s"} · {Object.keys(room.objects).length} objects</strong>
            </div>
            <button className={styles.iconButton} onClick={() => setOutlineOpen(false)} aria-label="Close canvas outline">
              <X size={16} />
            </button>
          </div>
          <div className={styles.outlineList}>
            <section className={styles.diagramSection} aria-labelledby="diagram-outline-heading">
              <div className={styles.outlineSectionHeading}>
                <div>
                  <span id="diagram-outline-heading">Semantic diagrams</span>
                  <small>Authoritative containers, not visual groups</small>
                </div>
                {self.role === "participant" ? (
                  <button
                    className={styles.diagramAddButton}
                    onClick={() => setDiagramEditor({ mode: "create", diagramId: createDiagramId() })}
                  >
                    <Plus size={13} /> New
                  </button>
                ) : null}
              </div>
              <div className={styles.diagramList}>
                {diagrams.map((diagram) => (
                  <article className={styles.diagramCard} key={diagram.id}>
                    <button className={styles.diagramFocusButton} onClick={() => focusDiagram(diagram)}>
                      <span className={styles.diagramCardTopline}>
                        <span><Network size={12} /> {humanizeDiagramType(diagram.diagramType)}</span>
                        <small>r{diagram.revision}</small>
                      </span>
                      <strong>{diagram.title}</strong>
                      <p>{diagram.description || "No description yet."}</p>
                      {diagram.category || diagram.tags.length ? (
                        <span className={styles.diagramTags}>
                          {diagram.category ? <i>{diagram.category}</i> : null}
                          {diagram.tags.slice(0, 3).map((tag) => <i key={tag}>#{tag}</i>)}
                          {diagram.tags.length > 3 ? <i>+{diagram.tags.length - 3}</i> : null}
                        </span>
                      ) : null}
                      <span className={styles.diagramStats}>
                        <span>{diagram.memberObjectIds.length} members · {diagram.connectorIds.length} connectors</span>
                        <span>{Math.round(diagram.bounds.width)}×{Math.round(diagram.bounds.height)}</span>
                      </span>
                      <small className={styles.diagramAttribution}>Last edited by {diagram.lastEditedBy.displayName}</small>
                    </button>
                    {self.role === "participant" ? (
                      <button
                        className={styles.diagramEditButton}
                        aria-label={`Edit ${diagram.title}`}
                        title={`Edit ${diagram.title}`}
                        onClick={() => setDiagramEditor({ mode: "edit", diagram })}
                      >
                        <PencilLine size={14} />
                      </button>
                    ) : null}
                  </article>
                ))}
                {!diagrams.length ? (
                  <p className={styles.emptyDiagrams}>
                    {self.role === "participant"
                      ? "Select canvas objects, then create a Diagram to describe them as one semantic unit."
                      : "No semantic Diagrams have been created yet."}
                  </p>
                ) : null}
              </div>
            </section>
            <div className={styles.outlineSectionHeading}>
              <div>
                <span>Canvas objects</span>
                <small>{selection.length ? `${selection.length} currently selected` : "Select an object to inspect it"}</small>
              </div>
            </div>
            {Object.values(room.objects)
              .sort((a, b) => b.zIndex - a.zIndex)
              .map((object) => (
                <div className={styles.objectOutlineItem} key={object.id}>
                  <button className={styles.objectOutlineRow} onClick={() => focusObject(object.id)}>
                    <span>{object.kind === "shape" && object.nodeType ? humanizeDiagramType(object.nodeType) : object.kind}</span>
                    <strong>{objectLabel(room, object.id)}</strong>
                    <small>r{object.revision}</small>
                    {object.kind === "shape" && object.nodeMetadata ? (
                      <i>{humanizeDiagramType(object.nodeMetadata.status)}</i>
                    ) : null}
                  </button>
                  {self.role === "participant" && object.kind === "shape" ? (
                    <button
                      className={styles.objectMetadataButton}
                      aria-label={`Edit semantic metadata for ${object.label || object.id}`}
                      title="Edit node classification and lifecycle"
                      onClick={() => setNodeEditorId(object.id)}
                    >
                      {object.nodeType === "decision" ? <BadgeCheck size={13} /> : object.nodeType === "open_question" ? <CircleHelp size={13} /> : <PencilLine size={13} />}
                    </button>
                  ) : null}
                </div>
              ))}
            {!Object.keys(room.objects).length ? (
              <p>Objects will appear here as people and agents add them.</p>
            ) : null}
          </div>
        </aside>
      ) : null}

      {activityOpen ? (
        <ActivityTimeline
          activities={roomActivity.activities}
          actorFilter={activityFilter}
          canRevert={self.role === "participant"}
          loading={roomActivity.loading}
          revertingActivityId={roomActivity.revertingActivityId}
          error={roomActivity.error}
          onActorFilterChange={setActivityFilter}
          onClose={() => setActivityOpen(false)}
          onFocus={focusActivity}
          onRefresh={() => void roomActivity.refresh()}
          onRevert={(activity) => {
            void roomActivity.revert(activity).then(() => {
              setDiagramAnnouncement(`Reverted: ${activity.label}`);
              window.setTimeout(() => setDiagramAnnouncement(""), 4_000);
            }).catch(() => undefined);
          }}
        />
      ) : null}

      {durabilityOpen ? (
        <div className={styles.mobileDurabilityHost}>
          <DurabilityPanel
            key={durabilityMode}
            mode={durabilityMode}
            room={room}
            role={self.role}
            selection={selection}
            runtime={canvasRuntime}
            getImportOrigin={() => {
              const viewport = canvasRuntimeRef.current?.getViewport();
              return viewport ? { x: viewport.x + 64, y: viewport.y + 64 } : { x: 120, y: 120 };
            }}
            acceptRoom={controller.acceptRoom}
            onClose={() => setDurabilityOpen(false)}
            onAnnounce={(message) => {
              setDiagramAnnouncement(message);
              window.setTimeout(() => setDiagramAnnouncement(""), 4_000);
            }}
          />
        </div>
      ) : null}

      {reviewOpen ? (
        <ReviewPanel
          room={room}
          role={self.role}
          acceptRoom={controller.acceptRoom}
          onClose={() => setReviewOpen(false)}
          onFocus={focusReviewObjects}
          onAnnounce={(message) => {
            setDiagramAnnouncement(message);
            window.setTimeout(() => setDiagramAnnouncement(""), 4_000);
          }}
        />
      ) : null}

      {askSelection ? (
        <AskAgentPanel
          roomId={room.id}
          selection={askSelection}
          onClose={closeAskPanel}
          onFocus={focusReviewObjects}
          onAnnounce={(message) => {
            setDiagramAnnouncement(message);
            window.setTimeout(() => setDiagramAnnouncement(""), 4_000);
          }}
        />
      ) : null}

      {diagramEditor && self.role === "participant" ? (
        <DiagramEditorModal
          key={diagramEditor.mode === "create" ? diagramEditor.diagramId : `${diagramEditor.diagram.id}:${diagramEditor.diagram.revision}`}
          editor={diagramEditor}
          room={room}
          selection={selection}
          onClose={() => setDiagramEditor(null)}
          onSave={saveDiagram}
        />
      ) : null}

      {nodeEditorId && self.role === "participant" && room.objects[nodeEditorId]?.kind === "shape" ? (
        <NodeMetadataEditorModal
          key={nodeEditorId}
          object={room.objects[nodeEditorId] as Extract<CanvasObject, { kind: "shape" }>}
          onClose={() => setNodeEditorId(null)}
          onSave={saveNodeMetadata}
        />
      ) : null}

      {spotlightPickerOpen ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => setSpotlightPickerOpen(false)}>
          <section
            className={styles.spotlightPicker}
            role="dialog"
            aria-modal="true"
            aria-labelledby="spotlight-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className={styles.modalClose} onClick={() => setSpotlightPickerOpen(false)} aria-label="Close">
              <X size={17} />
            </button>
            <span className={styles.modalIcon}><Presentation size={19} /></span>
            <h2 id="spotlight-title">
              {spotlight && spotlight.presenterId !== participantId ? "Request the Spotlight" : "Choose your Spotlight"}
            </h2>
            <p>
              {spotlight && spotlight.presenterId !== participantId
                ? `${presenter?.displayName ?? "The presenter"} can hand the room to your selected target.`
                : "Everyone gets five seconds to decline, then their canvas follows your selected target."}
            </p>
            <div className={styles.spotlightChoices}>
              <button
                onClick={() => {
                  chooseSpotlightTarget("human");
                }}
              >
                <MousePointer2 size={21} />
                <span><strong>My cursor</strong><small>Present your canvas view and pointer</small></span>
              </button>
              <button
                disabled={!self.agentActive}
                onClick={() => {
                  chooseSpotlightTarget("agent");
                }}
              >
                <AgentAvatar
                  displayName={self.displayName}
                  motion={selfAgentWorking ? "always" : "hover"}
                  participantColor={self.color}
                  size={28}
                  state={selfAgentWorking ? "working" : "idle"}
                />
                <span><strong>My agent</strong><small>{self.agentActive ? "Present its live working focus" : "Available after its first site-tool call"}</small></span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {toast ? (
        <div className={styles.toast} role="alert">
          <span><RefreshCw size={16} /></span>
          <div><strong>Canvas changed elsewhere</strong><p>{toast.message}</p></div>
          <button className={styles.iconButton} onClick={() => setToast(null)} aria-label="Dismiss message"><X size={15} /></button>
        </div>
      ) : null}

      <div className={styles.liveRegion} aria-live="polite">
        {diagramAnnouncement}
      </div>
      <span className={styles.liveRegion} data-testid="canvas-selection-count">
        {selection.length} selected
      </span>
    </main>
  );
}

function DiagramEditorModal({
  editor,
  room,
  selection,
  onClose,
  onSave,
}: {
  editor: DiagramEditorState;
  room: RoomState;
  selection: string[];
  onClose: () => void;
  onSave: (transaction: SemanticTransaction, title: string) => Promise<void>;
}) {
  const existing = editor.mode === "edit" ? editor.diagram : null;
  const [diagramId, setDiagramId] = useState(editor.mode === "create" ? editor.diagramId : editor.diagram.id);
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [diagramType, setDiagramType] = useState<DiagramType>(existing?.diagramType ?? "architecture");
  const [category, setCategory] = useState(existing?.category ?? "");
  const [tags, setTags] = useState(existing?.tags.join(", ") ?? "");
  const [useSelectionForMembership, setUseSelectionForMembership] = useState(editor.mode === "create");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const selectedMembership = useMemo(() => {
    const memberObjectIds: string[] = [];
    const connectorIds: string[] = [];
    for (const objectId of selection) {
      const object = room.objects[objectId];
      if (!object) continue;
      if (object.kind === "connector") connectorIds.push(objectId);
      else memberObjectIds.push(objectId);
    }
    return { memberObjectIds, connectorIds };
  }, [room.objects, selection]);

  const membership = useSelectionForMembership
    ? selectedMembership
    : existing
      ? { memberObjectIds: existing.memberObjectIds, connectorIds: existing.connectorIds }
      : { memberObjectIds: [], connectorIds: [] };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, submitting]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const cleanId = diagramId.trim();
    const cleanTitle = title.trim();
    const cleanCategory = category.trim();
    const cleanTags = [...new Set(tags.split(",").map((tag) => tag.trim()).filter(Boolean))];

    if (!cleanId || !cleanTitle) {
      setError("Diagram ID and title are required.");
      return;
    }
    if (editor.mode === "create" && room.diagrams?.[cleanId]) {
      setError(`A Diagram with ID ${cleanId} already exists.`);
      return;
    }
    if (cleanTags.length > 32 || cleanTags.some((tag) => tag.length > 64)) {
      setError("Use at most 32 tags, with no tag longer than 64 characters.");
      return;
    }

    const metadata = {
      title: cleanTitle,
      description: description.trim(),
      diagramType,
      category: cleanCategory || null,
      tags: cleanTags,
    };
    const transaction: SemanticTransaction = editor.mode === "create"
      ? {
          commands: [],
          diagramCommands: [
            {
              type: "diagram.create",
              diagram: {
                id: cleanId,
                ...metadata,
                memberObjectIds: membership.memberObjectIds,
                connectorIds: membership.connectorIds,
              },
            },
          ],
        }
      : {
          commands: [],
          diagramCommands: [
            {
              type: "diagram.update",
              diagramId: editor.diagram.id,
              expectedRevision: editor.diagram.revision,
              patch: {
                ...metadata,
                ...(useSelectionForMembership
                  ? {
                      memberObjectIds: membership.memberObjectIds,
                      connectorIds: membership.connectorIds,
                    }
                  : {}),
              } satisfies DiagramPatch,
            },
          ],
        };

    setSubmitting(true);
    try {
      await onSave(transaction, cleanTitle);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Jazzboard could not save this Diagram.");
      setSubmitting(false);
    }
  }

  return (
    <div
      className={styles.modalBackdrop}
      role="presentation"
      onMouseDown={() => {
        if (!submitting) onClose();
      }}
    >
      <section
        className={styles.diagramEditor}
        role="dialog"
        aria-modal="true"
        aria-labelledby="diagram-editor-title"
        aria-describedby="diagram-editor-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className={styles.modalClose} onClick={onClose} disabled={submitting} aria-label="Close Diagram editor">
          <X size={17} />
        </button>
        <div className={styles.diagramEditorIntro}>
          <span className={styles.modalIcon}><Boxes size={19} /></span>
          <div>
            <span>{editor.mode === "create" ? "New semantic container" : `Revision ${existing?.revision}`}</span>
            <h2 id="diagram-editor-title">{editor.mode === "create" ? "Create a Diagram" : "Edit Diagram"}</h2>
            <p id="diagram-editor-description">
              Describe this Diagram explicitly so people and agents can find and edit it by meaning, not visual style.
            </p>
          </div>
        </div>

        <form className={styles.diagramForm} onSubmit={(event) => void submit(event)}>
          <label className={styles.diagramField}>
            <span>Stable Diagram ID</span>
            <input
              value={diagramId}
              onChange={(event) => setDiagramId(event.target.value)}
              maxLength={128}
              readOnly={editor.mode === "edit"}
              aria-readonly={editor.mode === "edit"}
              spellCheck={false}
            />
            <small>{editor.mode === "edit" ? "The semantic ID is immutable." : "You can keep the generated ID or provide your own."}</small>
          </label>

          <label className={styles.diagramField}>
            <span>Title</span>
            <input
              autoFocus
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={160}
              placeholder="Authentication request flow"
            />
          </label>

          <label className={styles.diagramField}>
            <span>Purpose and contents</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={10_000}
              rows={3}
              placeholder="Shows how the web client, room API, guest authorization, and Redis interact."
            />
          </label>

          <div className={styles.diagramFieldRow}>
            <label className={styles.diagramField}>
              <span>Diagram type</span>
              <select value={diagramType} onChange={(event) => setDiagramType(event.target.value as DiagramType)}>
                {DIAGRAM_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className={styles.diagramField}>
              <span>Category <i>optional</i></span>
              <input
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                maxLength={128}
                placeholder="Security architecture"
              />
            </label>
          </div>

          <label className={styles.diagramField}>
            <span>Tags <i>optional</i></span>
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="authentication, guest session, redis"
            />
            <small>Comma-separated keywords make this Diagram easier to retrieve semantically.</small>
          </label>

          <fieldset className={styles.membershipFieldset}>
            <legend>Diagram membership</legend>
            <label className={styles.membershipToggle}>
              <input
                type="checkbox"
                checked={useSelectionForMembership}
                onChange={(event) => setUseSelectionForMembership(event.target.checked)}
              />
              <span>
                <strong>{editor.mode === "create" ? "Include the current canvas selection" : "Replace saved membership with the current selection"}</strong>
                <small>
                  {selection.length
                    ? `${selection.length} selected object${selection.length === 1 ? "" : "s"}; connector IDs are separated from member object IDs by authoritative kind.`
                    : "Nothing is selected. Enabling this creates or saves an empty membership."}
                </small>
              </span>
            </label>
            <div className={styles.membershipSummary}>
              <MembershipIds label="Member object IDs" ids={membership.memberObjectIds} />
              <MembershipIds label="Connector IDs" ids={membership.connectorIds} />
            </div>
            <p>No node classification is inferred from shape or color; explicit node types remain authoritative canvas metadata.</p>
          </fieldset>

          {editor.mode === "edit" ? (
            <p className={styles.revisionNote}>
              This save requires Diagram <code>{editor.diagram.id}</code> at revision {editor.diagram.revision}. If it changed elsewhere, Jazzboard will reject the whole update.
            </p>
          ) : null}

          {error ? <p className={styles.diagramFormError} role="alert">{error}</p> : null}

          <div className={styles.diagramFormActions}>
            <button type="button" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" disabled={submitting || !title.trim() || !diagramId.trim()}>
              {submitting ? <LoaderCircle className={styles.spin} size={15} /> : <Check size={15} />}
              {submitting ? "Saving…" : editor.mode === "create" ? "Create Diagram" : "Save changes"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

const NODE_TYPE_OPTIONS: Array<{ value: "generic" | NonNullable<Extract<CanvasObject, { kind: "shape" }>["nodeType"]>; label: string }> = [
  { value: "generic", label: "Generic shape" },
  { value: "service", label: "Service" },
  { value: "component", label: "Component" },
  { value: "requirement", label: "Requirement" },
  { value: "decision", label: "Decision" },
  { value: "open_question", label: "Open question" },
];

const DECISION_STATUS_OPTIONS = ["proposed", "accepted", "rejected", "superseded"] as const;
const QUESTION_STATUS_OPTIONS = ["open", "answered", "deferred", "closed"] as const;

function NodeMetadataEditorModal({
  object,
  onClose,
  onSave,
}: {
  object: Extract<CanvasObject, { kind: "shape" }>;
  onClose(): void;
  onSave(object: Extract<CanvasObject, { kind: "shape" }>, patch: ObjectPatch): Promise<void>;
}) {
  const initialType = object.nodeType ?? "generic";
  const [label, setLabel] = useState(object.label);
  const [nodeType, setNodeType] = useState<typeof initialType>(initialType);
  const [status, setStatus] = useState<NodeMetadataInput["status"]>(
    object.nodeMetadata?.status ?? (initialType === "open_question" ? "open" : "proposed"),
  );
  const [owner, setOwner] = useState(object.nodeMetadata?.owner ?? "");
  const [resolution, setResolution] = useState(object.nodeMetadata?.resolution ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const lifecycleType = nodeType === "decision" || nodeType === "open_question" ? nodeType : null;
  const unresolved = lifecycleType === "decision" ? status === "proposed" : lifecycleType === "open_question" ? status === "open" : true;
  const statusOptions = lifecycleType === "decision" ? DECISION_STATUS_OPTIONS : QUESTION_STATUS_OPTIONS;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, submitting]);

  function chooseNodeType(next: typeof nodeType) {
    setNodeType(next);
    if (next === "decision") {
      const metadata = object.nodeMetadata?.kind === "decision" ? object.nodeMetadata : null;
      setStatus(metadata?.status ?? "proposed");
      setOwner(metadata?.owner ?? "");
      setResolution(metadata?.resolution ?? "");
    } else if (next === "open_question") {
      const metadata = object.nodeMetadata?.kind === "open_question" ? object.nodeMetadata : null;
      setStatus(metadata?.status ?? "open");
      setOwner(metadata?.owner ?? "");
      setResolution(metadata?.resolution ?? "");
    } else {
      setOwner("");
      setResolution("");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const cleanLabel = label.trim();
    const cleanOwner = owner.trim() || null;
    const cleanResolution = resolution.trim() || null;
    if (lifecycleType && !unresolved && !cleanResolution) {
      setError(lifecycleType === "decision" ? "A resolved decision needs a resolution." : "A non-open question needs an answer or deferral note.");
      return;
    }

    let nodeMetadata: NodeMetadataInput | null = null;
    if (lifecycleType === "decision") {
      nodeMetadata = {
        kind: "decision",
        status: status as Extract<NodeMetadataInput, { kind: "decision" }>["status"],
        owner: cleanOwner,
        resolution: unresolved ? null : cleanResolution,
      } as NodeMetadataInput;
    } else if (lifecycleType === "open_question") {
      nodeMetadata = {
        kind: "open_question",
        status: status as "open" | "answered" | "deferred" | "closed",
        owner: cleanOwner,
        resolution: unresolved ? null : cleanResolution,
      };
    }

    setSubmitting(true);
    try {
      await onSave(object, {
        label: cleanLabel,
        nodeType: nodeType === "generic" ? null : nodeType,
        nodeMetadata,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Jazzboard could not save this node.");
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => !submitting && onClose()}>
      <section
        className={styles.nodeMetadataEditor}
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-metadata-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className={styles.modalClose} onClick={onClose} disabled={submitting} aria-label="Close node metadata editor">
          <X size={17} />
        </button>
        <div className={styles.diagramEditorIntro}>
          <span className={styles.modalIcon}>{lifecycleType === "open_question" ? <CircleHelp size={19} /> : <BadgeCheck size={19} />}</span>
          <div>
            <span>Semantic node · revision {object.revision}</span>
            <h2 id="node-metadata-title">Classify and track this node</h2>
            <p>Classification and lifecycle are authoritative data for people, queries, exports, templates, and agents—not visual-style inference.</p>
          </div>
        </div>

        <form className={styles.diagramForm} onSubmit={(event) => void submit(event)}>
          <label className={styles.diagramField}>
            <span>Label</span>
            <input autoFocus value={label} onChange={(event) => setLabel(event.target.value)} maxLength={10_000} />
          </label>
          <label className={styles.diagramField}>
            <span>Explicit node classification</span>
            <select value={nodeType} onChange={(event) => chooseNodeType(event.target.value as typeof nodeType)}>
              {NODE_TYPE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
          </label>

          {lifecycleType ? (
            <fieldset className={styles.nodeLifecycleFields}>
              <legend>{lifecycleType === "decision" ? "Decision lifecycle" : "Question lifecycle"}</legend>
              <div className={styles.diagramFieldRow}>
                <label className={styles.diagramField}>
                  <span>Status</span>
                  <select
                    value={status}
                    onChange={(event) => {
                      const next = event.target.value;
                      setStatus(next as NodeMetadataInput["status"]);
                      if (next === "proposed" || next === "open") setResolution("");
                    }}
                  >
                    {statusOptions.map((option) => <option value={option} key={option}>{humanizeDiagramType(option)}</option>)}
                  </select>
                </label>
                <label className={styles.diagramField}>
                  <span>Owner <i>optional</i></span>
                  <input value={owner} onChange={(event) => setOwner(event.target.value)} maxLength={160} placeholder="Platform team" />
                </label>
              </div>
              <label className={styles.diagramField}>
                <span>{lifecycleType === "decision" ? "Resolution" : "Answer or deferral note"}{unresolved ? " · available after status changes" : ""}</span>
                <textarea
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                  disabled={unresolved}
                  required={!unresolved}
                  maxLength={10_000}
                  rows={3}
                  placeholder={lifecycleType === "decision" ? "Record why this option was chosen." : "Record the answer or why this was deferred."}
                />
              </label>
              {object.nodeMetadata?.resolvedAt ? (
                <small className={styles.nodeResolvedAt}>Current resolution recorded {new Date(object.nodeMetadata.resolvedAt).toLocaleString()}.</small>
              ) : null}
            </fieldset>
          ) : (
            <p className={styles.revisionNote}>Services, components, requirements, and generic shapes have explicit classification but no decision/question lifecycle fields.</p>
          )}

          <p className={styles.revisionNote}>Saving requires object <code>{object.id}</code> at revision {object.revision}; a concurrent change rejects the entire update.</p>
          {error ? <p className={styles.diagramFormError} role="alert">{error}</p> : null}
          <div className={styles.diagramFormActions}>
            <button type="button" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" disabled={submitting}>
              {submitting ? <LoaderCircle className={styles.spin} size={15} /> : <Check size={15} />}
              {submitting ? "Saving…" : "Save semantic metadata"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function MembershipIds({ label, ids }: { label: string; ids: string[] }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{ids.length}</strong>
      {ids.length ? (
        <p title={ids.join(", ")}>
          {ids.slice(0, 3).map((id) => <code key={id}>{id}</code>)}
          {ids.length > 3 ? <small>+{ids.length - 3} more</small> : null}
        </p>
      ) : <p><small>None</small></p>}
    </div>
  );
}

function PresencePopover({ now, room, selfId }: { now: number; room: RoomState; selfId: string }) {
  return (
    <div className={`${styles.popover} ${styles.presencePopover}`}>
      <div className={styles.panelHeading}>
        <div><span>In this room</span><strong>{Object.keys(room.participants).length} people</strong></div>
      </div>
      {Object.values(room.participants).map((participant) => {
        const working = isAgentActivityWorking(participant.agent.activity, now);
        return (
          <div className={styles.presenceRow} key={participant.participantId}>
            <i style={{ background: participant.color }}>{participant.displayName.slice(0, 1).toUpperCase()}</i>
            <div>
              <strong>{participant.displayName}{participant.participantId === selfId ? " (you)" : ""}</strong>
              <span>{participant.role} · {participant.connected ? "online" : "away"}</span>
            </div>
            {participant.agentActive ? (
              <span className={styles.agentBadge}>
                <AgentAvatar
                  displayName={participant.displayName}
                  motion={working ? "always" : "none"}
                  participantColor={participant.color}
                  size={17}
                  state={working ? "working" : "idle"}
                />
                active
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function FollowPopover({
  participants,
  now,
  selfId,
  current,
  onFollow,
}: {
  participants: RoomState["participants"][string][];
  now: number;
  selfId: string;
  current: FollowTarget;
  onFollow: (participantId: string, kind: ActorKind) => void;
}) {
  return (
    <div className={`${styles.popover} ${styles.followPopover}`}>
      <div className={styles.panelHeading}>
        <div><span>Follow</span><strong>Choose a live target</strong></div>
      </div>
      {participants.map((participant) => {
        const working = isAgentActivityWorking(participant.agent.activity, now);
        return (
          <div className={styles.followRow} key={participant.participantId}>
            <i style={{ background: participant.color }}>{participant.displayName.slice(0, 1).toUpperCase()}</i>
            <div><strong>{participant.displayName}{participant.participantId === selfId ? " (you)" : ""}</strong><span>{participant.agentActive ? "Agent active" : "Agent ready"}</span></div>
            <button
              aria-label={`Follow ${participant.displayName}'s agent`}
              disabled={!participant.agentActive}
              className={current?.participantId === participant.participantId && current.kind === "agent" ? styles.selectedTarget : ""}
              onClick={() => onFollow(participant.participantId, "agent")}
            >
              <AgentAvatar
                displayName={participant.displayName}
                motion={working ? "always" : "hover"}
                participantColor={participant.color}
                size={21}
                state={working ? "working" : "idle"}
              />
            </button>
            <button
              aria-label={`Follow ${participant.displayName}'s cursor`}
              className={current?.participantId === participant.participantId && current.kind === "human" ? styles.selectedTarget : ""}
              onClick={() => onFollow(participant.participantId, "human")}
            ><MousePointer2 size={16} /></button>
          </div>
        );
      })}
    </div>
  );
}
