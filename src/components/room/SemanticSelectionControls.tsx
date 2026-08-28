"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";

import { pageToViewportPoint } from "@/lib/canvas/camera";
import type { SemanticSceneObject } from "@/lib/canvas/semantic-scene";
import { semanticTransformFrameForObjects } from "@/lib/canvas/semantic-transform-session";
import type { ResolvedConnectorRoute } from "@/lib/domain/connector-routing";
import type { CanvasBounds, Point, Viewport } from "@/lib/domain/types";

import styles from "./semantic-selection-controls.module.css";

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

const ARROW_KEYS = new Set(["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"]);

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
  const actionBarStyle: CSSProperties = {
    left: selectedBounds.x + selectedBounds.width / 2,
    top: selectedBounds.y,
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

      <div
        className={styles.actionBar}
        style={actionBarStyle}
        role="toolbar"
        aria-label="Selection actions"
        onKeyDown={stopCanvasEvent}
      >
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
      </div>
    </div>
  );
}
