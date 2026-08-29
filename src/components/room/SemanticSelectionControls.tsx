"use client";

import { SlidersHorizontal, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";

import { pageToViewportPoint } from "@/lib/canvas/camera";
import type { SemanticSceneObject } from "@/lib/canvas/semantic-scene";
import { semanticTransformFrameForObjects } from "@/lib/canvas/semantic-transform-session";
import type { ResolvedConnectorRoute } from "@/lib/domain/connector-routing";
import type { CanvasBounds, Point, Viewport } from "@/lib/domain/types";

import {
  announceMobileSurfaceOpen,
  subscribeToMobileSurfaceOpen,
} from "./mobile-surface-coordinator";
import styles from "./semantic-selection-controls.module.css";
import { useCanvasMobileLayout } from "./useCanvasMobileLayout";

export const SEMANTIC_RESIZE_HANDLES = [
  "north-west",
  "north",
  "north-east",
  "east",
  "south-east",
  "south",
  "south-west",
  "west",
] as const;

export type SemanticResizeHandle = (typeof SEMANTIC_RESIZE_HANDLES)[number];
export type SemanticConnectorEndpointHandle = "start" | "end";
export type SemanticTransformHandle =
  | { kind: "resize"; handle: SemanticResizeHandle }
  | { kind: "rotate" }
  | { kind: "connector-endpoint"; endpoint: SemanticConnectorEndpointHandle };

export type SemanticTransformPointerStart = Readonly<{
  objectIds: readonly string[];
  handle: SemanticTransformHandle;
  pointerId: number;
  clientX: number;
  clientY: number;
}>;

export type SemanticTransformKeyboardInput = Readonly<{
  objectIds: readonly string[];
  handle: SemanticTransformHandle;
  key: "ArrowUp" | "ArrowRight" | "ArrowDown" | "ArrowLeft";
  shiftKey: boolean;
  altKey: boolean;
}>;

export type SemanticSelectionAction = Readonly<{
  objectIds: readonly string[];
}>;

export type SemanticSelectionControlsProps = Readonly<{
  /** Selected renderer-neutral scene objects, in the host's canonical selection order. */
  selectedObjects: readonly SemanticSceneObject[];
  viewport: Viewport;
  /** Spectators pass false and receive no interactive or visual selection affordance. */
  editing: boolean;
  /** Resolved geometry for the sole selected connector, when applicable. */
  connectorRoute?: ResolvedConnectorRoute | null;
  onTransformPointerStart: (input: SemanticTransformPointerStart) => void;
  onTransformKeyboardInput?: (input: SemanticTransformKeyboardInput) => void;
  onDelete?: (input: SemanticSelectionAction) => void;
  onGroup?: (input: SemanticSelectionAction) => void;
  onUngroup?: (input: SemanticSelectionAction) => void;
  onBringForward?: (input: SemanticSelectionAction) => void;
  onSendBackward?: (input: SemanticSelectionAction) => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  /** Renderer-neutral host-provided controls, for example fill and stroke pickers. */
  styleControls?: ReactNode;
}>;

type SelectionFrame = Readonly<{
  pageBounds: CanvasBounds;
  rotation: number;
}>;

type SelectionActionBarPlacement = "above" | "below";

const ARROW_KEYS = new Set(["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"]);
const ACTION_BAR_CLEARANCE = 34;
const ACTION_BAR_ESTIMATED_HEIGHT = 48;
const TOP_CHROME_SAFE_ZONE = 112;
const DIALOG_FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function semanticSelectionActionBarPlacement(
  selectionTop: number,
  actionBarHeight: number,
): SelectionActionBarPlacement {
  const safeSelectionTop = finiteOr(selectionTop);
  const safeActionBarHeight = Math.max(0, finiteOr(actionBarHeight));
  return safeSelectionTop - ACTION_BAR_CLEARANCE - safeActionBarHeight < TOP_CHROME_SAFE_ZONE
    ? "below"
    : "above";
}

function finiteOr(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function usableZoom(viewport: Viewport): number {
  return Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
}

function unionBounds(items: readonly SemanticSceneObject[]): CanvasBounds {
  const first = items[0].bounds;
  let minX = finiteOr(first.x);
  let minY = finiteOr(first.y);
  let maxX = minX + Math.max(0, finiteOr(first.width));
  let maxY = minY + Math.max(0, finiteOr(first.height));

  for (const { bounds } of items.slice(1)) {
    const x = finiteOr(bounds.x);
    const y = finiteOr(bounds.y);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + Math.max(0, finiteOr(bounds.width)));
    maxY = Math.max(maxY, y + Math.max(0, finiteOr(bounds.height)));
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function selectionFrame(items: readonly SemanticSceneObject[]): SelectionFrame {
  const frame = semanticTransformFrameForObjects(items.map(({ object }) => object));
  if (!frame) return { pageBounds: { x: 0, y: 0, width: 1, height: 1 }, rotation: 0 };
  return { pageBounds: frame.bounds, rotation: frame.rotation };
}

function viewportBounds(bounds: CanvasBounds, viewport: Viewport): CanvasBounds {
  const topLeft = pageToViewportPoint(bounds, viewport);
  const zoom = usableZoom(viewport);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.max(1, bounds.width * zoom),
    height: Math.max(1, bounds.height * zoom),
  };
}

function actionPayload(objectIds: readonly string[]): SemanticSelectionAction {
  return { objectIds };
}

function stopCanvasEvent(event: SyntheticEvent): void {
  event.stopPropagation();
}

function handleLabel(handle: SemanticTransformHandle): string {
  if (handle.kind === "rotate") return "Rotate selection";
  if (handle.kind === "connector-endpoint") {
    return `Move connector ${handle.endpoint} endpoint`;
  }
  return `Resize selection from ${handle.handle}`;
}

function pointStyle(point: Point, viewport: Viewport): CSSProperties {
  const projected = pageToViewportPoint(point, viewport);
  return { left: projected.x, top: projected.y };
}

function SelectionActionBar({
  selectedBounds,
  children,
}: Readonly<{
  selectedBounds: CanvasBounds;
  children: ReactNode;
}>) {
  const actionBarRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<SelectionActionBarPlacement>(() =>
    semanticSelectionActionBarPlacement(selectedBounds.y, ACTION_BAR_ESTIMATED_HEIGHT),
  );

  useLayoutEffect(() => {
    const actionBar = actionBarRef.current;
    if (!actionBar) return;

    const updatePlacement = () => {
      const next = semanticSelectionActionBarPlacement(
        selectedBounds.y,
        actionBar.getBoundingClientRect().height,
      );
      setPlacement((current) => current === next ? current : next);
    };

    updatePlacement();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updatePlacement);
    observer?.observe(actionBar);
    window.addEventListener("resize", updatePlacement);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePlacement);
    };
  }, [selectedBounds.y]);

  const style: CSSProperties = {
    left: selectedBounds.x + selectedBounds.width / 2,
    top: placement === "below"
      ? selectedBounds.y + selectedBounds.height
      : selectedBounds.y,
  };

  return (
    <div
      ref={actionBarRef}
      className={styles.actionBar}
      data-selection-placement={placement}
      style={style}
      role="toolbar"
      aria-label="Selection actions"
      onKeyDown={stopCanvasEvent}
    >
      {children}
    </div>
  );
}

type MobileSelectionActionsProps = Readonly<{
  canGroup: boolean;
  canUngroup: boolean;
  objectIds: readonly string[];
  onDelete?: (input: SemanticSelectionAction) => void;
  onGroup?: (input: SemanticSelectionAction) => void;
  onUngroup?: (input: SemanticSelectionAction) => void;
  onBringForward?: (input: SemanticSelectionAction) => void;
  onSendBackward?: (input: SemanticSelectionAction) => void;
  styleControls?: ReactNode;
}>;

function MobileSelectionActions({
  canGroup,
  canUngroup,
  objectIds,
  onDelete,
  onGroup,
  onUngroup,
  onBringForward,
  onSendBackward,
  styleControls,
}: MobileSelectionActionsProps) {
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);

  useEffect(() => subscribeToMobileSurfaceOpen((surfaceId) => {
    if (surfaceId !== "selection") setOpen(false);
  }), []);

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus({ preventScroll: true });
  }, [open]);

  function setSheetOpen(next: boolean): void {
    if (next) announceMobileSurfaceOpen("selection");
    setOpen(next);
  }

  function closeSheet(restoreFocus = true): void {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  function invokeAndClose(callback: ((input: SemanticSelectionAction) => void) | undefined): void {
    callback?.(actionPayload(objectIds));
    closeSheet();
  }

  const mobileActions = (
    <div
      className={styles.mobileActionsRoot}
      data-testid="mobile-selection-actions"
      onClick={stopCanvasEvent}
      onContextMenu={stopCanvasEvent}
      onDoubleClick={stopCanvasEvent}
      onPointerCancel={stopCanvasEvent}
      onPointerDown={stopCanvasEvent}
      onPointerMove={stopCanvasEvent}
      onPointerUp={stopCanvasEvent}
      onWheel={stopCanvasEvent}
    >
      <div className={styles.mobileSelectionDock} role="toolbar" aria-label="Selection quick actions">
        <button
          ref={triggerRef}
          type="button"
          aria-controls={dialogId}
          aria-expanded={open}
          aria-haspopup="dialog"
          data-testid="mobile-selection-actions-trigger"
          onClick={() => setSheetOpen(!open)}
        >
          <SlidersHorizontal aria-hidden="true" size={18} />
          <span>Style &amp; actions</span>
        </button>
      </div>

      {open ? (
        <div
          className={styles.mobileSheetBackdrop}
          data-testid="mobile-selection-actions-backdrop"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.target === event.currentTarget) closeSheet();
          }}
          role="presentation"
        >
          <section
            ref={sheetRef}
            aria-label="Selection style and actions"
            aria-modal="true"
            className={styles.mobileSheet}
            id={dialogId}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                closeSheet();
                return;
              }
              if (event.key !== "Tab") return;
              const focusable = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE) ?? []);
              const first = focusable[0];
              const last = focusable.at(-1);
              if (!first || !last) return;
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
            role="dialog"
          >
            <div className={styles.mobileSheetHandle} aria-hidden="true" />
            <header>
              <div>
                <span>Selection</span>
                <strong>Style &amp; actions</strong>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                aria-label="Close selection actions"
                onClick={() => closeSheet()}
              >
                <X aria-hidden="true" size={21} />
              </button>
            </header>

            {styleControls ? (
              <section className={styles.mobileStyleSection} aria-label="Selection style">
                <h3>Style</h3>
                <div className={styles.mobileStyleControls}>{styleControls}</div>
              </section>
            ) : null}

            <section className={styles.mobileActionSection} aria-label="Selection actions">
              <h3>Arrange</h3>
              <div className={styles.mobileActionGrid}>
                {onGroup && canGroup ? (
                  <button type="button" onClick={() => invokeAndClose(onGroup)}>Group</button>
                ) : null}
                {onUngroup && canUngroup ? (
                  <button type="button" onClick={() => invokeAndClose(onUngroup)}>Ungroup</button>
                ) : null}
                {onBringForward ? (
                  <button type="button" onClick={() => invokeAndClose(onBringForward)}>Bring forward</button>
                ) : null}
                {onSendBackward ? (
                  <button type="button" onClick={() => invokeAndClose(onSendBackward)}>Send backward</button>
                ) : null}
                {onDelete ? (
                  <button
                    type="button"
                    className={styles.mobileDangerAction}
                    onClick={() => invokeAndClose(onDelete)}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </section>
          </section>
        </div>
      ) : null}
    </div>
  );

  return typeof document === "undefined" ? mobileActions : createPortal(mobileActions, document.body);
}

/**
 * Presentation-only controls for the first-party semantic canvas.
 *
 * The host owns selection, grouping rules, transforms, leases, persistence,
 * and rollback. This overlay only projects page geometry into viewport pixels
 * and reports synchronous, semantic user intent.
 */
export function SemanticSelectionControls({
  selectedObjects,
  viewport,
  editing,
  connectorRoute,
  onTransformPointerStart,
  onTransformKeyboardInput,
  onDelete,
  onGroup,
  onUngroup,
  onBringForward,
  onSendBackward,
  onContextMenu,
  styleControls,
}: SemanticSelectionControlsProps) {
  const mobileLayout = useCanvasMobileLayout();
  if (!editing || selectedObjects.length === 0) return null;

  const objectIds = Object.freeze(selectedObjects.map(({ object }) => object.id));
  const frame = selectionFrame(selectedObjects);
  const projectedFrame = viewportBounds(frame.pageBounds, viewport);
  const selectedBounds = viewportBounds(unionBounds(selectedObjects), viewport);
  const soleConnector = selectedObjects.length === 1 && selectedObjects[0].object.kind === "connector"
    ? selectedObjects[0].object
    : null;
  const endpointRoute = soleConnector && connectorRoute?.connectorId === soleConnector.id
    ? connectorRoute
    : null;
  const canGroup = selectedObjects.length > 1;
  const canUngroup = selectedObjects.some(({ object }) => object.groupId !== null);

  const frameStyle: CSSProperties = {
    left: projectedFrame.x,
    top: projectedFrame.y,
    width: projectedFrame.width,
    height: projectedFrame.height,
    transform: `rotate(${frame.rotation}rad)`,
    transformOrigin: "center center",
  };
  function reportPointerStart(
    event: PointerEvent<HTMLButtonElement>,
    handle: SemanticTransformHandle,
  ): void {
    if (event.button !== 0) return;
    // Transform controls own the gesture from this frame onward. Preventing
    // the button default also avoids native drag/focus behavior competing with
    // the host's pointer capture or window-level transform listeners.
    event.preventDefault();
    event.stopPropagation();
    onTransformPointerStart({
      objectIds,
      handle,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  function reportKeyboardInput(
    event: KeyboardEvent<HTMLButtonElement>,
    handle: SemanticTransformHandle,
  ): void {
    event.stopPropagation();
    if (!ARROW_KEYS.has(event.key)) return;
    event.preventDefault();
    onTransformKeyboardInput?.({
      objectIds,
      handle,
      key: event.key as SemanticTransformKeyboardInput["key"],
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    });
  }

  function invokeAction(callback: ((input: SemanticSelectionAction) => void) | undefined): void {
    callback?.(actionPayload(objectIds));
  }

  return (
    <div
      className={styles.overlay}
      data-semantic-selection-controls="true"
      data-mobile-layout={mobileLayout ? "true" : "false"}
      data-selection-object-ids={objectIds.join(" ")}
      onClick={stopCanvasEvent}
      onDoubleClick={stopCanvasEvent}
      onPointerDown={stopCanvasEvent}
      onPointerMove={stopCanvasEvent}
      onPointerUp={stopCanvasEvent}
      onPointerCancel={stopCanvasEvent}
      onContextMenu={onContextMenu}
      onWheel={stopCanvasEvent}
    >
      <div
        className={styles.frame}
        data-testid="semantic-selection-frame"
        data-selection-count={selectedObjects.length}
        style={frameStyle}
        role="group"
        aria-label={`${selectedObjects.length} selected canvas object${selectedObjects.length === 1 ? "" : "s"}`}
      >
        {!soleConnector ? SEMANTIC_RESIZE_HANDLES.map((handle) => {
          const transformHandle: SemanticTransformHandle = { kind: "resize", handle };
          return (
            <button
              key={handle}
              type="button"
              className={`${styles.handle} ${styles[`handle-${handle}`]}`}
              data-transform-handle={`resize-${handle}`}
              aria-label={handleLabel(transformHandle)}
              onPointerDown={(event) => reportPointerStart(event, transformHandle)}
              onKeyDown={(event) => reportKeyboardInput(event, transformHandle)}
            />
          );
        }) : null}
        {!soleConnector ? (
          <>
            <span className={styles.rotationStem} aria-hidden="true" />
            <button
              type="button"
              className={`${styles.handle} ${styles.rotationHandle}`}
              data-transform-handle="rotate"
              aria-label="Rotate selection"
              onPointerDown={(event) => reportPointerStart(event, { kind: "rotate" })}
              onKeyDown={(event) => reportKeyboardInput(event, { kind: "rotate" })}
            />
          </>
        ) : null}
      </div>

      {endpointRoute ? (["start", "end"] as const).map((endpoint) => {
        const transformHandle: SemanticTransformHandle = { kind: "connector-endpoint", endpoint };
        return (
          <button
            key={endpoint}
            type="button"
            className={`${styles.handle} ${styles.connectorHandle}`}
            data-transform-handle={`connector-${endpoint}`}
            aria-label={handleLabel(transformHandle)}
            style={pointStyle(endpointRoute[endpoint], viewport)}
            onPointerDown={(event) => reportPointerStart(event, transformHandle)}
            onKeyDown={(event) => reportKeyboardInput(event, transformHandle)}
          />
        );
      }) : null}

      {mobileLayout ? (
        <MobileSelectionActions
          key={objectIds.join("\u0000")}
          canGroup={canGroup}
          canUngroup={canUngroup}
          objectIds={objectIds}
          onDelete={onDelete}
          onGroup={onGroup}
          onUngroup={onUngroup}
          onBringForward={onBringForward}
          onSendBackward={onSendBackward}
          styleControls={styleControls}
        />
      ) : (
        <SelectionActionBar selectedBounds={selectedBounds}>
          {styleControls ? <div className={styles.styleControls}>{styleControls}</div> : null}
          {onGroup && canGroup ? (
            <button type="button" onClick={() => invokeAction(onGroup)}>Group</button>
          ) : null}
          {onUngroup && canUngroup ? (
            <button type="button" onClick={() => invokeAction(onUngroup)}>Ungroup</button>
          ) : null}
          {onBringForward ? (
            <button type="button" onClick={() => invokeAction(onBringForward)}>Bring forward</button>
          ) : null}
          {onSendBackward ? (
            <button type="button" onClick={() => invokeAction(onSendBackward)}>Send backward</button>
          ) : null}
          {onDelete ? (
            <button type="button" className={styles.dangerAction} onClick={() => invokeAction(onDelete)}>Delete</button>
          ) : null}
        </SelectionActionBar>
      )}
    </div>
  );
}
