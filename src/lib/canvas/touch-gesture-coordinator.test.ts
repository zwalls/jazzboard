import { describe, expect, it } from "vitest";

import type { Viewport } from "@/lib/domain/types";

import {
  CANVAS_ZOOM_LIMITS,
  viewportToPagePoint,
} from "./camera";
import {
  DEFAULT_TOUCH_DRAG_HYSTERESIS_PX,
  TouchCanvasGestureCoordinator,
  type CanvasGestureIntent,
  type CanvasPointerMode,
} from "./touch-gesture-coordinator";

const INITIAL_VIEWPORT: Viewport = {
  x: 100,
  y: 50,
  width: 400,
  height: 300,
  zoom: 2,
};

const SELECT: CanvasPointerMode = { kind: "select" };

function down(
  coordinator: TouchCanvasGestureCoordinator,
  input: Partial<Parameters<TouchCanvasGestureCoordinator["pointerDown"]>[0]> = {},
) {
  return coordinator.pointerDown({
    pointerId: 1,
    pointerType: "touch",
    point: { x: 40, y: 60 },
    viewport: INITIAL_VIEWPORT,
    mode: SELECT,
    target: "blank",
    ...input,
  });
}

function camera(intents: readonly CanvasGestureIntent[]): Viewport {
  const intent = intents.findLast((candidate) => candidate.type === "camera.update");
  if (!intent || intent.type !== "camera.update") throw new Error("Expected a camera update.");
  return intent.viewport;
}

describe("TouchCanvasGestureCoordinator", () => {
  it("tracks normalized mouse, pen, and touch pointers independently", () => {
    const coordinator = new TouchCanvasGestureCoordinator();

    down(coordinator, { pointerId: 7, pointerType: "" });
    down(coordinator, { pointerId: 3, pointerType: "pen" });
    down(coordinator, { pointerId: 9, pointerType: "touch" });

    expect(coordinator.snapshot().pointers.map(({ pointerId, pointerType }) => ({ pointerId, pointerType }))).toEqual([
      { pointerId: 3, pointerType: "pen" },
      { pointerId: 7, pointerType: "mouse" },
      { pointerId: 9, pointerType: "touch" },
    ]);
  });

  it("keeps a blank-canvas touch pending until the default 8px hysteresis is crossed", () => {
    const coordinator = new TouchCanvasGestureCoordinator();
    const started = down(coordinator);

    expect(DEFAULT_TOUCH_DRAG_HYSTERESIS_PX).toBe(8);
    expect(started.snapshot.phase).toBe("pending");
    expect(started.intents).toEqual([
      { type: "pointer.capture", pointerId: 1 },
      { type: "gesture.pending", pointerId: 1, gesture: "pan", point: { x: 40, y: 60 } },
    ]);

    expect(coordinator.pointerMove({
      pointerId: 1,
      pointerType: "touch",
      point: { x: 47.9, y: 60 },
    }).intents).toEqual([]);

    const dragged = coordinator.pointerMove({
      pointerId: 1,
      pointerType: "touch",
      point: { x: 48, y: 60 },
    });
    expect(dragged.snapshot.phase).toBe("pan");
    expect(dragged.intents[0]).toEqual({ type: "pan.begin", pointerId: 1 });
    expect(camera(dragged.intents)).toEqual({
      ...INITIAL_VIEWPORT,
      x: 96,
    });
  });

  it("resolves a sub-hysteresis touch as a tap instead of a drag", () => {
    const coordinator = new TouchCanvasGestureCoordinator();
    down(coordinator, { target: "object", targetId: "shape-1" });
    coordinator.pointerMove({ pointerId: 1, pointerType: "touch", point: { x: 43, y: 64 } });

    const finished = coordinator.pointerUp({
      pointerId: 1,
      pointerType: "touch",
      point: { x: 43, y: 64 },
    });

    expect(finished.intents).toEqual([
      {
        type: "tap",
        pointerId: 1,
        point: { x: 43, y: 64 },
        target: "object",
        targetId: "shape-1",
      },
      { type: "pointer.release", pointerId: 1 },
    ]);
    expect(finished.snapshot).toEqual({ phase: "idle", pointers: [] });
  });

  it("begins an object move at the original point only after hysteresis", () => {
    const coordinator = new TouchCanvasGestureCoordinator();
    down(coordinator, { target: "object", targetId: "shape-1" });

    const dragged = coordinator.pointerMove({
      pointerId: 1,
      pointerType: "touch",
      point: { x: 50, y: 60 },
    });

    expect(dragged.intents).toEqual([
      {
        type: "host.begin",
        pointerId: 1,
        gesture: "object",
        point: { x: 40, y: 60 },
        targetId: "shape-1",
      },
      {
        type: "host.update",
        pointerId: 1,
        gesture: "object",
        point: { x: 50, y: 60 },
      },
    ]);
    expect(dragged.snapshot.phase).toBe("host");
  });

  it("cancels a pending object gesture when the second touch starts a pinch", () => {
    const coordinator = new TouchCanvasGestureCoordinator();
    down(coordinator, { target: "object", targetId: "shape-1" });

    const second = down(coordinator, {
      pointerId: 2,
      point: { x: 140, y: 60 },
      target: "blank",
    });

    expect(second.intents).toEqual([
      {
        type: "gesture.cancel-pending",
        pointerId: 1,
        gesture: "object",
        reason: "second-touch",
      },
      { type: "pointer.capture", pointerId: 1 },
      { type: "pointer.capture", pointerId: 2 },
      { type: "pinch.begin", pointerIds: [1, 2] },
    ]);
    expect(second.snapshot.phase).toBe("pinch");
  });

  it("cancels an already-started object move before beginning a pinch", () => {
    const coordinator = new TouchCanvasGestureCoordinator();
    down(coordinator, { target: "object", targetId: "shape-1" });
    coordinator.pointerMove({ pointerId: 1, pointerType: "touch", point: { x: 50, y: 60 } });

    const second = down(coordinator, {
      pointerId: 2,
      point: { x: 140, y: 60 },
      target: "blank",
    });

    expect(second.intents[0]).toEqual({
      type: "host.cancel",
      pointerId: 1,
      gesture: "object",
      point: { x: 50, y: 60 },
      reason: "second-touch",
    });
    expect(second.intents.slice(1, 3)).toEqual([
      { type: "pointer.capture", pointerId: 1 },
      { type: "pointer.capture", pointerId: 2 },
    ]);
    expect(second.intents.at(-1)).toEqual({ type: "pinch.begin", pointerIds: [1, 2] });
  });

  it("cancels an active selection transform before a fully captured pinch", () => {
    const coordinator = new TouchCanvasGestureCoordinator();
    const started = down(coordinator, { mode: { kind: "transform" } });
    expect(started.intents).toEqual([
      { type: "pointer.capture", pointerId: 1 },
      {
        type: "host.begin",
        pointerId: 1,
        gesture: "transform",
        point: { x: 40, y: 60 },
      },
    ]);

    const second = down(coordinator, {
      pointerId: 2,
      point: { x: 140, y: 60 },
      target: "blank",
    });
    expect(second.intents).toEqual([
      {
        type: "host.cancel",
        pointerId: 1,
        gesture: "transform",
        point: { x: 40, y: 60 },
        reason: "second-touch",
      },
      { type: "pointer.capture", pointerId: 1 },
      { type: "pointer.capture", pointerId: 2 },
      { type: "pinch.begin", pointerIds: [1, 2] },
    ]);
    expect(second.snapshot.phase).toBe("pinch");
  });

  it("can explicitly suspend a touch marquee when a host opts into one", () => {
    const coordinator = new TouchCanvasGestureCoordinator();
    down(coordinator, {
      mode: { kind: "select", touchBlankGesture: "marquee" },
    });

    const second = down(coordinator, {
      pointerId: 2,
      point: { x: 140, y: 60 },
    });

    expect(second.intents[0]).toEqual({
      type: "gesture.cancel-pending",
      pointerId: 1,
      gesture: "marquee",
      reason: "second-touch",
    });
  });

  it("computes deterministic two-finger pan and pinch around the moving midpoint", () => {
    const coordinator = new TouchCanvasGestureCoordinator();
    down(coordinator, { point: { x: 100, y: 100 } });
    down(coordinator, { pointerId: 2, point: { x: 200, y: 100 } });
    const originalAnchor = viewportToPagePoint({ x: 150, y: 100 }, INITIAL_VIEWPORT);

    coordinator.pointerMove({ pointerId: 1, pointerType: "touch", point: { x: 60, y: 120 } });
    const moved = coordinator.pointerMove({
      pointerId: 2,
      pointerType: "touch",
      point: { x: 260, y: 120 },
    });
    const next = camera(moved.intents);

    expect(next).toEqual({
      x: 135,
      y: 70,
      width: 200,
      height: 150,
      zoom: 4,
    });
    expect(viewportToPagePoint({ x: 160, y: 120 }, next)).toEqual(originalAnchor);

    // Results are always derived from the gesture baseline, never compounded
    // from the order in which the two PointerEvents happened to arrive.
    const repeated = coordinator.pointerMove({
      pointerId: 2,
      pointerType: "touch",
      point: { x: 260, y: 120 },
    });
    expect(camera(repeated.intents)).toEqual(next);
  });

  it("clamps pinch zoom to the shared camera bounds while preserving physical size", () => {
    const coordinator = new TouchCanvasGestureCoordinator();
    down(coordinator, { point: { x: 100, y: 100 } });
    down(coordinator, { pointerId: 2, point: { x: 200, y: 100 } });

    const moved = coordinator.pointerMove({
      pointerId: 2,
      pointerType: "touch",
      point: { x: 10_000, y: 100 },
    });
    const next = camera(moved.intents);

    expect(next.zoom).toBe(CANVAS_ZOOM_LIMITS.max);
    expect(next.width * next.zoom).toBe(INITIAL_VIEWPORT.width * INITIAL_VIEWPORT.zoom);
    expect(next.height * next.zoom).toBe(INITIAL_VIEWPORT.height * INITIAL_VIEWPORT.zoom);
  });

  it("rebases the remaining finger as a one-finger pan after pinch-up", () => {
    const coordinator = new TouchCanvasGestureCoordinator();
    down(coordinator, { point: { x: 100, y: 100 } });
    down(coordinator, { pointerId: 2, point: { x: 200, y: 100 } });
    coordinator.pointerMove({ pointerId: 2, pointerType: "touch", point: { x: 300, y: 100 } });

    const lifted = coordinator.pointerUp({
      pointerId: 2,
      pointerType: "touch",
      point: { x: 300, y: 100 },
    });
    const rebasedViewport = camera(lifted.intents);
    expect(lifted.intents.at(-1)).toEqual({ type: "pan.begin", pointerId: 1 });
    expect(lifted.snapshot.phase).toBe("pan");

    const continued = coordinator.pointerMove({
      pointerId: 1,
      pointerType: "touch",
      point: { x: 120, y: 100 },
    });
    expect(camera(continued.intents)).toEqual({
      ...rebasedViewport,
      x: rebasedViewport.x - 20 / rebasedViewport.zoom,
    });
  });

  it.each(["create", "draw", "connector"] as const)("starts %s explicitly, then yields it to a two-finger camera gesture", (kind) => {
    const coordinator = new TouchCanvasGestureCoordinator();
    const started = down(coordinator, { mode: { kind } });

    expect(started.intents).toContainEqual({
      type: "host.begin",
      pointerId: 1,
      gesture: kind,
      point: { x: 40, y: 60 },
    });
    const second = down(coordinator, { pointerId: 2, point: { x: 140, y: 60 } });
    expect(second.intents).toEqual([
      {
        type: "host.cancel",
        pointerId: 1,
        gesture: kind,
        point: { x: 40, y: 60 },
        reason: "second-touch",
      },
      { type: "pointer.capture", pointerId: 1 },
      { type: "pointer.capture", pointerId: 2 },
      { type: "pinch.begin", pointerIds: [1, 2] },
    ]);
    expect(second.snapshot.phase).toBe("pinch");
  });

  it("passes mouse and pen selection gestures through without touch hysteresis", () => {
    const mouse = new TouchCanvasGestureCoordinator();
    expect(down(mouse, { pointerType: "mouse", target: "blank" }).intents).toEqual([{
      type: "host.begin",
      pointerId: 1,
      gesture: "marquee",
      point: { x: 40, y: 60 },
    }]);

    const pen = new TouchCanvasGestureCoordinator();
    expect(down(pen, { pointerType: "pen", target: "object", targetId: "shape-1" }).intents).toEqual([{
      type: "host.begin",
      pointerId: 1,
      gesture: "object",
      point: { x: 40, y: 60 },
      targetId: "shape-1",
    }]);
  });

  it("cleans pending and active streams on pointer-cancel and ignores stale events", () => {
    const coordinator = new TouchCanvasGestureCoordinator();
    down(coordinator, { target: "object", targetId: "shape-1" });

    const cancelled = coordinator.pointerCancel({
      pointerId: 1,
      pointerType: "touch",
      point: { x: 40, y: 60 },
    });
    expect(cancelled.intents).toEqual([
      {
        type: "gesture.cancel-pending",
        pointerId: 1,
        gesture: "object",
        reason: "pointer-cancel",
      },
      { type: "pointer.release", pointerId: 1 },
    ]);
    expect(cancelled.snapshot).toEqual({ phase: "idle", pointers: [] });
    expect(coordinator.pointerUp({
      pointerId: 1,
      pointerType: "touch",
      point: { x: 40, y: 60 },
    }).intents).toEqual([]);
  });

  it("can atomically cancel all captured streams", () => {
    const coordinator = new TouchCanvasGestureCoordinator();
    down(coordinator, { mode: { kind: "draw" } });
    down(coordinator, { pointerId: 2, point: { x: 140, y: 60 } });

    expect(coordinator.cancel().intents).toEqual([
      {
        type: "pinch.end",
        pointerIds: [1, 2],
        reason: "pointer-cancel",
      },
      { type: "pointer.release", pointerId: 1 },
      { type: "pointer.release", pointerId: 2 },
    ]);
    expect(coordinator.snapshot()).toEqual({ phase: "idle", pointers: [] });
  });
});
