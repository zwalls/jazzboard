import type { Point, Viewport } from "@/lib/domain/types";

import { clampCanvasZoom, type CanvasZoomLimits } from "./camera";

/** Screen-pixel travel required before a touch tap becomes a drag. */
export const DEFAULT_TOUCH_DRAG_HYSTERESIS_PX = 8;

export type CanvasPointerDevice = "mouse" | "pen" | "touch";
export type CanvasPointerTarget = "blank" | "object";

/**
 * Explicit host mode supplied for every pointer-down. Create, draw, connector,
 * and selection-transform gestures begin synchronously on the first touch; a
 * second touch yields them through an ordered host cancellation before the
 * camera gesture begins.
 */
export type CanvasPointerMode =
  | Readonly<{ kind: "select"; touchBlankGesture?: "pan" | "marquee" }>
  | Readonly<{ kind: "hand" | "readonly" | "create" | "draw" | "connector" | "transform" }>;

export type CanvasHostGesture = "object" | "marquee" | "create" | "draw" | "connector" | "transform";
export type CanvasPendingGesture = CanvasHostGesture | "pan";

export type CanvasPointerSample = Readonly<{
  pointerId: number;
  pointerType: string;
  point: Point;
}>;

export type CanvasPointerDown = CanvasPointerSample & Readonly<{
  /** The current authoritative camera at pointer-down. */
  viewport: Viewport;
  mode: CanvasPointerMode;
  target: CanvasPointerTarget;
  /** Optional semantic object ID carried back on tap/host intents. */
  targetId?: string;
  button?: number;
}>;

export type CanvasGestureFinishReason = "pointer-up" | "pointer-cancel" | "second-touch";

/**
 * Renderer-neutral commands. A host applies these synchronously in order and
 * keeps its existing semantic gesture engines as the source of edit truth.
 */
export type CanvasGestureIntent =
  | Readonly<{ type: "pointer.capture"; pointerId: number }>
  | Readonly<{ type: "pointer.release"; pointerId: number }>
  | Readonly<{
      type: "gesture.pending";
      pointerId: number;
      gesture: CanvasPendingGesture;
      point: Point;
      targetId?: string;
    }>
  | Readonly<{
      type: "gesture.cancel-pending";
      pointerId: number;
      gesture: CanvasPendingGesture;
      reason: CanvasGestureFinishReason;
    }>
  | Readonly<{
      type: "host.begin";
      pointerId: number;
      gesture: CanvasHostGesture;
      point: Point;
      targetId?: string;
    }>
  | Readonly<{
      type: "host.update";
      pointerId: number;
      gesture: CanvasHostGesture;
      point: Point;
    }>
  | Readonly<{
      type: "host.finish";
      pointerId: number;
      gesture: CanvasHostGesture;
      point: Point;
      reason: "pointer-up";
    }>
  | Readonly<{
      type: "host.cancel";
      pointerId: number;
      gesture: CanvasHostGesture;
      point: Point;
      reason: "pointer-cancel" | "second-touch";
    }>
  | Readonly<{
      type: "tap";
      pointerId: number;
      point: Point;
      target: CanvasPointerTarget;
      targetId?: string;
    }>
  | Readonly<{ type: "pan.begin"; pointerId: number }>
  | Readonly<{ type: "pan.end"; pointerId: number; reason: "pointer-up" | "pointer-cancel" | "second-touch" }>
  | Readonly<{
      type: "camera.update";
      source: "pan" | "pinch";
      viewport: Viewport;
    }>
  | Readonly<{ type: "pinch.begin"; pointerIds: readonly [number, number] }>
  | Readonly<{
      type: "pinch.end";
      pointerIds: readonly [number, number];
      reason: "pointer-up" | "pointer-cancel";
    }>;

export type CanvasGesturePhase = "idle" | "pending" | "host" | "pan" | "pinch";

export type RegisteredCanvasPointer = Readonly<{
  pointerId: number;
  pointerType: CanvasPointerDevice;
  start: Readonly<Point>;
  current: Readonly<Point>;
  target: CanvasPointerTarget;
  targetId?: string;
}>;

export type CanvasGestureSnapshot = Readonly<{
  phase: CanvasGesturePhase;
  pointers: readonly RegisteredCanvasPointer[];
}>;

export type CanvasGestureResult = Readonly<{
  intents: readonly CanvasGestureIntent[];
  snapshot: CanvasGestureSnapshot;
}>;

export type TouchGestureCoordinatorOptions = CanvasZoomLimits & Readonly<{
  dragHysteresisPx?: number;
}>;

type TrackedPointer = {
  pointerId: number;
  pointerType: CanvasPointerDevice;
  start: Point;
  current: Point;
  mode: CanvasPointerMode;
  target: CanvasPointerTarget;
  targetId?: string;
};

type PendingInteraction = {
  phase: "pending";
  pointerId: number;
  gesture: CanvasPendingGesture;
  viewport: Viewport;
};

type HostInteraction = {
  phase: "host";
  pointerId: number;
  gesture: CanvasHostGesture;
};

type PanInteraction = {
  phase: "pan";
  pointerId: number;
  start: Point;
  viewport: Viewport;
};

type PinchInteraction = {
  phase: "pinch";
  pointerIds: [number, number];
  viewport: Viewport;
  midpoint: Point;
  distance: number;
};

type Interaction = PendingInteraction | HostInteraction | PanInteraction | PinchInteraction | null;

function device(pointerType: string): CanvasPointerDevice {
  if (pointerType === "touch" || pointerType === "pen") return pointerType;
  return "mouse";
}

function point(value: Point): Point {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new TypeError("Canvas pointer coordinates must be finite CSS pixels.");
  }
  return { x: value.x, y: value.y };
}

function viewport(value: Viewport): Viewport {
  if (
    !Number.isFinite(value.x)
    || !Number.isFinite(value.y)
    || !Number.isFinite(value.zoom)
    || value.zoom <= 0
    || !Number.isFinite(value.width)
    || value.width < 0
    || !Number.isFinite(value.height)
    || value.height < 0
  ) {
    throw new TypeError("Canvas viewport must contain finite coordinates, positive zoom, and non-negative dimensions.");
  }
  return { ...value };
}

function distance(left: Point, right: Point): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function midpoint(left: Point, right: Point): Point {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

function hostGesture(mode: CanvasPointerMode, target: CanvasPointerTarget): CanvasHostGesture | "pan" {
  if (mode.kind === "hand" || mode.kind === "readonly") return "pan";
  if (
    mode.kind === "create"
    || mode.kind === "draw"
    || mode.kind === "connector"
    || mode.kind === "transform"
  ) return mode.kind;
  return target === "object" ? "object" : "marquee";
}

function frozenPoint(value: Point): Readonly<Point> {
  return Object.freeze({ ...value });
}

function freezeViewport(value: Viewport): Viewport {
  return Object.freeze({ ...value });
}

/**
 * Coordinates touch camera gestures without importing React or browser event
 * classes. Pointer coordinates are relative to the canvas in CSS pixels.
 */
export class TouchCanvasGestureCoordinator {
  private readonly pointers = new Map<number, TrackedPointer>();
  private readonly hysteresis: number;
  private readonly zoomLimits: CanvasZoomLimits;
  private interaction: Interaction = null;

  constructor(options: TouchGestureCoordinatorOptions = {}) {
    const hysteresis = options.dragHysteresisPx ?? DEFAULT_TOUCH_DRAG_HYSTERESIS_PX;
    if (!Number.isFinite(hysteresis) || hysteresis < 0) {
      throw new TypeError("Touch drag hysteresis must be a finite, non-negative number of CSS pixels.");
    }
    this.hysteresis = hysteresis;
    this.zoomLimits = { minZoom: options.minZoom, maxZoom: options.maxZoom };
  }

  snapshot(): CanvasGestureSnapshot {
    const pointers = [...this.pointers.values()]
      .sort((left, right) => left.pointerId - right.pointerId)
      .map((entry): RegisteredCanvasPointer => Object.freeze({
        pointerId: entry.pointerId,
        pointerType: entry.pointerType,
        start: frozenPoint(entry.start),
        current: frozenPoint(entry.current),
        target: entry.target,
        ...(entry.targetId === undefined ? {} : { targetId: entry.targetId }),
      }));
    return Object.freeze({
      phase: this.interaction?.phase ?? "idle",
      pointers: Object.freeze(pointers),
    });
  }

  pointerDown(input: CanvasPointerDown): CanvasGestureResult {
    const start = point(input.point);
    const currentViewport = viewport(input.viewport);
    if (!Number.isInteger(input.pointerId) || input.pointerId < 0) {
      throw new TypeError("Canvas pointerId must be a non-negative integer.");
    }
    if (this.pointers.has(input.pointerId)) return this.result([]);

    const tracked: TrackedPointer = {
      pointerId: input.pointerId,
      pointerType: device(input.pointerType),
      start,
      current: start,
      mode: input.mode,
      target: input.target,
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
    };
    this.pointers.set(input.pointerId, tracked);

    const touchPointers = this.touchPointers();
    if (tracked.pointerType === "touch" && touchPointers.length === 2) {
      return this.beginPinch(touchPointers[0], touchPointers[1], currentViewport);
    }
    if (this.interaction || (input.button ?? 0) !== 0) return this.result([]);

    const gesture = hostGesture(input.mode, input.target);
    if (tracked.pointerType !== "touch") {
      if (gesture === "pan") {
        this.interaction = { phase: "pan", pointerId: input.pointerId, start, viewport: currentViewport };
        return this.result([
          { type: "pointer.capture", pointerId: input.pointerId },
          { type: "pan.begin", pointerId: input.pointerId },
        ]);
      }
      this.interaction = { phase: "host", pointerId: input.pointerId, gesture };
      return this.result([
        { type: "host.begin", pointerId: input.pointerId, gesture, point: start, ...this.targetId(tracked) },
      ]);
    }

    // Explicit authoring modes start synchronously so pressure/freehand and
    // create-session semantics remain exactly under the host's ownership.
    if (gesture === "create" || gesture === "draw" || gesture === "connector" || gesture === "transform") {
      this.interaction = { phase: "host", pointerId: input.pointerId, gesture };
      return this.result([
        { type: "pointer.capture", pointerId: input.pointerId },
        { type: "host.begin", pointerId: input.pointerId, gesture, point: start, ...this.targetId(tracked) },
      ]);
    }

    const pendingGesture = gesture === "marquee"
      ? input.mode.kind === "select" && input.mode.touchBlankGesture === "marquee"
        ? "marquee"
        : "pan"
      : gesture;
    this.interaction = {
      phase: "pending",
      pointerId: input.pointerId,
      gesture: pendingGesture,
      viewport: currentViewport,
    };
    return this.result([
      { type: "pointer.capture", pointerId: input.pointerId },
      {
        type: "gesture.pending",
        pointerId: input.pointerId,
        gesture: pendingGesture,
        point: start,
        ...this.targetId(tracked),
      },
    ]);
  }

  pointerMove(input: CanvasPointerSample): CanvasGestureResult {
    const tracked = this.pointers.get(input.pointerId);
    if (!tracked) return this.result([]);
    tracked.current = point(input.point);
    const interaction = this.interaction;
    if (!interaction) return this.result([]);

    if (interaction.phase === "pinch") {
      if (!interaction.pointerIds.includes(input.pointerId)) return this.result([]);
      return this.result([this.pinchViewportIntent(interaction)]);
    }
    if (interaction.pointerId !== input.pointerId) return this.result([]);
    if (interaction.phase === "host") {
      return this.result([{
        type: "host.update",
        pointerId: input.pointerId,
        gesture: interaction.gesture,
        point: tracked.current,
      }]);
    }
    if (interaction.phase === "pan") {
      return this.result([this.panViewportIntent(interaction, tracked.current)]);
    }

    if (distance(tracked.start, tracked.current) < this.hysteresis) return this.result([]);
    if (interaction.gesture === "pan") {
      const pan: PanInteraction = {
        phase: "pan",
        pointerId: tracked.pointerId,
        start: tracked.start,
        viewport: interaction.viewport,
      };
      this.interaction = pan;
      return this.result([
        { type: "pan.begin", pointerId: tracked.pointerId },
        this.panViewportIntent(pan, tracked.current),
      ]);
    }

    const gesture = interaction.gesture;
    this.interaction = { phase: "host", pointerId: tracked.pointerId, gesture };
    return this.result([
      { type: "host.begin", pointerId: tracked.pointerId, gesture, point: tracked.start, ...this.targetId(tracked) },
      { type: "host.update", pointerId: tracked.pointerId, gesture, point: tracked.current },
    ]);
  }

  pointerUp(input: CanvasPointerSample): CanvasGestureResult {
    return this.finishPointer(input, "pointer-up");
  }

  pointerCancel(input: CanvasPointerSample): CanvasGestureResult {
    return this.finishPointer(input, "pointer-cancel");
  }

  /** Cancels every tracked stream, useful on unmount or lost browser focus. */
  cancel(): CanvasGestureResult {
    const intents: CanvasGestureIntent[] = [];
    const interaction = this.interaction;
    if (interaction?.phase === "pending") {
      intents.push({
        type: "gesture.cancel-pending",
        pointerId: interaction.pointerId,
        gesture: interaction.gesture,
        reason: "pointer-cancel",
      });
    } else if (interaction?.phase === "host") {
      const tracked = this.pointers.get(interaction.pointerId);
      if (tracked) intents.push({
        type: "host.cancel",
        pointerId: interaction.pointerId,
        gesture: interaction.gesture,
        point: tracked.current,
        reason: "pointer-cancel",
      });
    } else if (interaction?.phase === "pan") {
      intents.push({ type: "pan.end", pointerId: interaction.pointerId, reason: "pointer-cancel" });
    } else if (interaction?.phase === "pinch") {
      intents.push({ type: "pinch.end", pointerIds: interaction.pointerIds, reason: "pointer-cancel" });
    }
    for (const pointerId of this.pointers.keys()) intents.push({ type: "pointer.release", pointerId });
    this.interaction = null;
    this.pointers.clear();
    return this.result(intents);
  }

  private finishPointer(
    input: CanvasPointerSample,
    reason: "pointer-up" | "pointer-cancel",
  ): CanvasGestureResult {
    const tracked = this.pointers.get(input.pointerId);
    if (!tracked) return this.result([]);
    tracked.current = point(input.point);
    const interaction = this.interaction;
    const intents: CanvasGestureIntent[] = [];

    if (interaction?.phase === "pinch" && interaction.pointerIds.includes(input.pointerId)) {
      // Apply the lifted pointer's final coordinate before rebasing the
      // remaining finger; this makes up/cancel independent of event batching.
      const finalCamera = this.pinchViewportIntent(interaction);
      intents.push(finalCamera, {
        type: "pinch.end",
        pointerIds: interaction.pointerIds,
        reason,
      });
      this.pointers.delete(input.pointerId);
      intents.push({ type: "pointer.release", pointerId: input.pointerId });
      const remaining = this.pointers.get(
        interaction.pointerIds[0] === input.pointerId
          ? interaction.pointerIds[1]
          : interaction.pointerIds[0],
      );
      if (remaining) {
        this.interaction = {
          phase: "pan",
          pointerId: remaining.pointerId,
          start: { ...remaining.current },
          viewport: { ...finalCamera.viewport },
        };
        intents.push({ type: "pan.begin", pointerId: remaining.pointerId });
      } else {
        this.interaction = null;
      }
      return this.result(intents);
    }

    if (interaction && interaction.phase !== "pinch" && interaction.pointerId === input.pointerId) {
      if (interaction.phase === "pending") {
        if (reason === "pointer-up") {
          intents.push({
            type: "tap",
            pointerId: tracked.pointerId,
            point: tracked.current,
            target: tracked.target,
            ...this.targetId(tracked),
          });
        } else {
          intents.push({
            type: "gesture.cancel-pending",
            pointerId: tracked.pointerId,
            gesture: interaction.gesture,
            reason,
          });
        }
      } else if (interaction.phase === "host") {
        intents.push(reason === "pointer-up"
          ? {
              type: "host.finish",
              pointerId: tracked.pointerId,
              gesture: interaction.gesture,
              point: tracked.current,
              reason,
            }
          : {
              type: "host.cancel",
              pointerId: tracked.pointerId,
              gesture: interaction.gesture,
              point: tracked.current,
              reason,
            });
      } else {
        intents.push(this.panViewportIntent(interaction, tracked.current));
        intents.push({ type: "pan.end", pointerId: tracked.pointerId, reason });
      }
      this.interaction = null;
    }
    this.pointers.delete(input.pointerId);
    intents.push({ type: "pointer.release", pointerId: input.pointerId });
    return this.result(intents);
  }

  private beginPinch(
    first: TrackedPointer,
    second: TrackedPointer,
    currentViewport: Viewport,
  ): CanvasGestureResult {
    const intents: CanvasGestureIntent[] = [];
    const current = this.interaction;
    if (current?.phase === "pending") {
      intents.push({
        type: "gesture.cancel-pending",
        pointerId: current.pointerId,
        gesture: current.gesture,
        reason: "second-touch",
      });
    } else if (current?.phase === "host") {
      const tracked = this.pointers.get(current.pointerId);
      if (tracked) intents.push({
        type: "host.cancel",
        pointerId: current.pointerId,
        gesture: current.gesture,
        point: tracked.current,
        reason: "second-touch",
      });
    } else if (current?.phase === "pan") {
      intents.push({ type: "pan.end", pointerId: current.pointerId, reason: "second-touch" });
    }

    const pointerIds: [number, number] = first.pointerId < second.pointerId
      ? [first.pointerId, second.pointerId]
      : [second.pointerId, first.pointerId];
    const left = this.pointers.get(pointerIds[0])!;
    const right = this.pointers.get(pointerIds[1])!;
    this.interaction = {
      phase: "pinch",
      pointerIds,
      viewport: currentViewport,
      midpoint: midpoint(left.current, right.current),
      distance: Math.max(distance(left.current, right.current), Number.EPSILON),
    };
    // Host cancellation may release the first pointer's capture before the
    // pinch begins. Reassert capture for both streams so either finger can
    // leave the original SVG/handle without starving the camera gesture.
    intents.push(
      { type: "pointer.capture", pointerId: pointerIds[0] },
      { type: "pointer.capture", pointerId: pointerIds[1] },
      { type: "pinch.begin", pointerIds },
    );
    return this.result(intents);
  }

  private panViewportIntent(interaction: PanInteraction, current: Point): CanvasGestureIntent {
    const zoom = interaction.viewport.zoom;
    return {
      type: "camera.update",
      source: "pan",
      viewport: freezeViewport({
        ...interaction.viewport,
        x: interaction.viewport.x - (current.x - interaction.start.x) / zoom,
        y: interaction.viewport.y - (current.y - interaction.start.y) / zoom,
      }),
    };
  }

  private pinchViewportIntent(interaction: PinchInteraction): Extract<CanvasGestureIntent, { type: "camera.update" }> {
    const first = this.pointers.get(interaction.pointerIds[0]);
    const second = this.pointers.get(interaction.pointerIds[1]);
    if (!first || !second) {
      return { type: "camera.update", source: "pinch", viewport: freezeViewport(interaction.viewport) };
    }
    const currentMidpoint = midpoint(first.current, second.current);
    const scale = distance(first.current, second.current) / interaction.distance;
    const zoom = clampCanvasZoom(interaction.viewport.zoom * scale, this.zoomLimits);
    const physicalWidth = interaction.viewport.width * interaction.viewport.zoom;
    const physicalHeight = interaction.viewport.height * interaction.viewport.zoom;
    const anchor = {
      x: interaction.viewport.x + interaction.midpoint.x / interaction.viewport.zoom,
      y: interaction.viewport.y + interaction.midpoint.y / interaction.viewport.zoom,
    };
    return {
      type: "camera.update",
      source: "pinch",
      viewport: freezeViewport({
        x: anchor.x - currentMidpoint.x / zoom,
        y: anchor.y - currentMidpoint.y / zoom,
        width: physicalWidth / zoom,
        height: physicalHeight / zoom,
        zoom,
      }),
    };
  }

  private touchPointers(): TrackedPointer[] {
    return [...this.pointers.values()]
      .filter((entry) => entry.pointerType === "touch")
      .sort((left, right) => left.pointerId - right.pointerId);
  }

  private targetId(pointer: TrackedPointer): { targetId?: string } {
    return pointer.targetId === undefined ? {} : { targetId: pointer.targetId };
  }

  private result(intents: CanvasGestureIntent[]): CanvasGestureResult {
    return Object.freeze({
      intents: Object.freeze(intents.map((intent) => Object.freeze(intent))),
      snapshot: this.snapshot(),
    });
  }
}
