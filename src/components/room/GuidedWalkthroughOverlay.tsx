"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import type {
  GuidedWalkthrough,
  GuidedWalkthroughDisplay,
} from "@/lib/canvas/guided-walkthrough";
import { clampCanvasZoom } from "@/lib/canvas/camera";
import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { ResolvedConnectorRoute } from "@/lib/domain/connector-routing";
import type { CanvasBounds, RoomState, Viewport } from "@/lib/domain/types";

import { AgentAvatar, agentAvatarPrimaryColor } from "./AgentAvatar";
import styles from "./guided-walkthrough-overlay.module.css";

function connectorPath(route: ResolvedConnectorRoute, runtime: CanvasRuntime): string {
  const point = (value: { x: number; y: number }) => runtime.pageToViewport(value);
  if (route.routing.kind === "curved" && route.arc) {
    const start = point(route.start);
    const end = point(route.end);
    const largeArc = Math.abs(route.arc.sweepAngle) > Math.PI ? 1 : 0;
    const sweep = route.arc.sweepAngle >= 0 ? 1 : 0;
    const radius = route.arc.radius * runtime.getViewport().zoom;
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${end.x} ${end.y}`;
  }
  return route.points.map((value, index) => {
    const projected = point(value);
    return `${index ? "L" : "M"} ${projected.x} ${projected.y}`;
  }).join(" ");
}

const WALKTHROUGH_CAMERA = Object.freeze({
  comfortableWidth: 440,
  comfortableHeight: 300,
  horizontalMargin: 48,
  verticalMargin: 32,
  panelClearance: 24,
  panelTop: 18,
  panelBottom: 92,
});

function comfortableFocusBounds(bounds: CanvasBounds): CanvasBounds {
  const width = Math.max(bounds.width, WALKTHROUGH_CAMERA.comfortableWidth);
  const height = Math.max(bounds.height, WALKTHROUGH_CAMERA.comfortableHeight);
  return {
    x: bounds.x + bounds.width / 2 - width / 2,
    y: bounds.y + bounds.height / 2 - height / 2,
    width,
    height,
  };
}

export function walkthroughCameraFrame(
  targetBounds: CanvasBounds,
  viewport: Viewport,
  panelPlacement: "top" | "bottom",
  panelHeight: number,
): { bounds: CanvasBounds; targetZoom: number } {
  const pixelWidth = viewport.width * viewport.zoom;
  const pixelHeight = viewport.height * viewport.zoom;
  const panelExtent = Number.isFinite(panelHeight) ? Math.max(0, panelHeight) : 0;
  const safeLeft = Math.min(WALKTHROUGH_CAMERA.horizontalMargin, pixelWidth / 2);
  const safeRight = Math.max(safeLeft, pixelWidth - WALKTHROUGH_CAMERA.horizontalMargin);
  const safeTop = panelPlacement === "top"
    ? Math.min(
        pixelHeight - WALKTHROUGH_CAMERA.verticalMargin,
        WALKTHROUGH_CAMERA.panelTop + panelExtent + WALKTHROUGH_CAMERA.panelClearance,
      )
    : WALKTHROUGH_CAMERA.verticalMargin;
  const safeBottom = panelPlacement === "bottom"
    ? Math.max(
        safeTop,
        pixelHeight - WALKTHROUGH_CAMERA.panelBottom - panelExtent - WALKTHROUGH_CAMERA.panelClearance,
      )
    : Math.max(safeTop, pixelHeight - WALKTHROUGH_CAMERA.verticalMargin);
  const comfortableBounds = comfortableFocusBounds(targetBounds);
  const targetZoom = clampCanvasZoom(Math.min(
    Math.max(1, safeRight - safeLeft) / comfortableBounds.width,
    Math.max(1, safeBottom - safeTop) / comfortableBounds.height,
  ));
  const targetCenter = {
    x: targetBounds.x + targetBounds.width / 2,
    y: targetBounds.y + targetBounds.height / 2,
  };
  const safeCenter = {
    x: (safeLeft + safeRight) / 2,
    y: (safeTop + safeBottom) / 2,
  };
  const frameCenter = {
    x: targetCenter.x + (pixelWidth / 2 - safeCenter.x) / targetZoom,
    y: targetCenter.y + (pixelHeight / 2 - safeCenter.y) / targetZoom,
  };
  return {
    bounds: {
      x: frameCenter.x - comfortableBounds.width / 2,
      y: frameCenter.y - comfortableBounds.height / 2,
      width: comfortableBounds.width,
      height: comfortableBounds.height,
    },
    targetZoom,
  };
}

export function GuidedWalkthroughOverlay({
  agentDisplayName,
  agentColor,
  connectorRoutes,
  localToolActivityActive = false,
  room,
  runtime,
  viewport,
  walkthrough,
  onStepChange,
  onExit,
  onDisplayed,
}: {
  agentDisplayName: string;
  agentColor: string;
  connectorRoutes: Readonly<Record<string, ResolvedConnectorRoute>>;
  localToolActivityActive?: boolean;
  room: RoomState;
  runtime: CanvasRuntime;
  viewport: Viewport;
  walkthrough: GuidedWalkthrough;
  onStepChange(index: number): void;
  onExit(): void;
  onDisplayed(display: GuidedWalkthroughDisplay): void;
}) {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [documentHidden, setDocumentHidden] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const step = walkthrough.steps[walkthrough.currentStepIndex]!;
  const objectIds = step.objectIds.filter((objectId) => {
    const object = room.objects[objectId];
    return Boolean(object && object.kind !== "connector");
  });
  const connectorIds = step.connectorIds.filter((objectId) =>
    room.objects[objectId]?.kind === "connector"
  );
  const targetIds = [...objectIds, ...connectorIds];
  const targetBounds = runtime.getVisibleBounds(targetIds);
  const targetCenter = targetBounds ? runtime.pageToViewport({
    x: targetBounds.x + targetBounds.width / 2,
    y: targetBounds.y + targetBounds.height / 2,
  }) : { x: viewport.width * viewport.zoom / 2, y: viewport.height * viewport.zoom / 2 };
  const panelPlacement = targetCenter.y < viewport.height * viewport.zoom / 2 ? "bottom" : "top";

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const update = () => setDocumentHidden(document.visibilityState === "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, [walkthrough.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onExit]);

  useEffect(() => {
    const currentTargetIds = [...step.objectIds, ...step.connectorIds].filter((objectId) =>
      runtime.hasObject(objectId)
    );
    const focusBounds = runtime.getVisibleBounds(currentTargetIds);
    if (!focusBounds) return;
    const currentViewport = runtime.getViewport();
    const frame = walkthroughCameraFrame(
      focusBounds,
      currentViewport,
      panelPlacement,
      panelRef.current?.getBoundingClientRect().height ?? 0,
    );
    runtime.zoomToBounds(frame.bounds, {
      targetZoom: frame.targetZoom,
      durationMs: reducedMotion ? 0 : 360,
      force: true,
      publishPresence: false,
    });
  }, [panelPlacement, reducedMotion, runtime, step, walkthrough.currentStepIndex, walkthrough.id]);

  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const overlay = overlayRef.current;
        if (!overlay || !overlay.isConnected) return;
        const highlightedObjects = new Set(
          [...overlay.querySelectorAll<SVGElement>("[data-walkthrough-object-id]")]
            .map((element) => element.dataset.walkthroughObjectId),
        );
        const highlightedConnectors = new Set(
          [...overlay.querySelectorAll<SVGElement>("[data-walkthrough-connector-id]")]
            .map((element) => element.dataset.walkthroughConnectorId),
        );
        if (
          !objectIds.every((objectId) => highlightedObjects.has(objectId))
          || !connectorIds.every((connectorId) => highlightedConnectors.has(connectorId))
        ) return;
        onDisplayed({
          walkthroughId: walkthrough.id,
          revision: walkthrough.revision,
          stepIndex: walkthrough.currentStepIndex,
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [connectorIds, objectIds, onDisplayed, walkthrough.currentStepIndex, walkthrough.id, walkthrough.revision]);

  const avatarStyle = {
    "--walkthrough-avatar-x": `${targetCenter.x}px`,
    "--walkthrough-avatar-y": `${targetCenter.y}px`,
    "--walkthrough-agent-color": agentAvatarPrimaryColor(agentDisplayName),
  } as CSSProperties;

  return (
    <div
      className={styles.overlay}
      data-walkthrough-id={walkthrough.id}
      data-walkthrough-revision={walkthrough.revision}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-testid="guided-walkthrough"
      ref={overlayRef}
    >
      <svg className={styles.highlights} width="100%" height="100%" aria-hidden="true">
        {objectIds.map((objectId) => {
          const bounds = runtime.getObjectBounds(objectId);
          if (!bounds) return null;
          const topLeft = runtime.pageToViewport(bounds);
          return (
            <rect
              className={styles.objectHighlight}
              data-walkthrough-object-id={objectId}
              key={objectId}
              x={topLeft.x - 8}
              y={topLeft.y - 8}
              width={bounds.width * viewport.zoom + 16}
              height={bounds.height * viewport.zoom + 16}
              rx={14}
            />
          );
        })}
        {connectorIds.map((connectorId) => {
          const route = connectorRoutes[connectorId];
          if (!route) return null;
          return (
            <path
              className={styles.connectorHighlight}
              data-walkthrough-connector-id={connectorId}
              d={connectorPath(route, runtime)}
              key={connectorId}
            />
          );
        })}
      </svg>

      <div
        className={styles.avatar}
        data-document-hidden={documentHidden ? "true" : undefined}
        data-local-tool-activity={localToolActivityActive ? "true" : "false"}
        style={avatarStyle}
        aria-hidden="true"
      >
        <span className={styles.avatarBody}>
          <AgentAvatar
            displayName={agentDisplayName}
            participantColor={agentColor}
            state={localToolActivityActive ? "working" : "idle"}
            motion={reducedMotion || documentHidden ? "none" : localToolActivityActive ? "always" : "hover"}
            size={52}
          />
        </span>
      </div>

      <section
        aria-labelledby="guided-walkthrough-title"
        aria-describedby="guided-walkthrough-caption"
        className={styles.panel}
        data-placement={panelPlacement}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") onExit();
        }}
      >
        <div className={styles.header}>
          <div>
            <span className={styles.progress}>Step {walkthrough.currentStepIndex + 1} of {walkthrough.steps.length}</span>
            <h2 id="guided-walkthrough-title">{walkthrough.title}</h2>
          </div>
          <button className={styles.exit} type="button" onClick={() => onExit()} aria-label="Exit guided walkthrough">
            <X size={16} />
          </button>
        </div>
        <p className={styles.caption} id="guided-walkthrough-caption" aria-live="polite">{step.caption}</p>
        {step.details ? (
          <details className={styles.details} key={`${walkthrough.id}:${walkthrough.currentStepIndex}`}>
            <summary>More detail</summary>
            <p>{step.details}</p>
          </details>
        ) : null}
        <div className={styles.controls}>
          <button
            type="button"
            disabled={walkthrough.currentStepIndex === 0}
            onClick={() => onStepChange(walkthrough.currentStepIndex - 1)}
          >
            <ChevronLeft size={16} /> Back
          </button>
          {walkthrough.currentStepIndex < walkthrough.steps.length - 1 ? (
            <button
              className={styles.primary}
              type="button"
              onClick={() => onStepChange(walkthrough.currentStepIndex + 1)}
            >
              Next <ChevronRight size={16} />
            </button>
          ) : (
            <button className={styles.primary} type="button" onClick={() => onExit()}>Finish</button>
          )}
        </div>
      </section>
    </div>
  );
}
