import { describe, expect, it } from "vitest";

import type {
  ActorRef,
  CanvasObject,
  RoomState,
} from "@/lib/domain/types";

import { SemanticCanvasEditLifecycleController } from "./semantic-edit-lifecycle";
import type { SemanticCanvasEditIntent } from "./semantic-edit-events";
import {
  SEMANTIC_CREATE_LIMITS,
  SemanticCreateSessionEngine,
  SemanticCreateSessionError,
  type SemanticShapeCreateInput,
} from "./semantic-create-session";
import { CanvasObjectSyncCoordinator } from "./sync-coordinator";

const AUTHOR: ActorRef = {
  participantId: "creator",
  displayName: "Creator",
  color: "violet",
  kind: "human",
};

function shapeInput(
  overrides: Partial<SemanticShapeCreateInput> = {},
): SemanticShapeCreateInput {
  return {
    id: "shape-new",
    pointerStart: { x: 100, y: 100 },
    zIndex: 17,
    groupId: null,
    rotation: 0,
    shape: "rectangle",
    nodeType: "service",
    label: "API service",
    fill: "white",
    stroke: "blue",
    ...overrides,
  };
}

function persistedShape(
  id: string,
  groupId: string | null = null,
  revision = 1,
): Extract<CanvasObject, { kind: "shape" }> {
  return {
    id,
    kind: "shape",
    x: revision * 10,
    y: revision * 20,
    width: 120,
    height: 80,
    rotation: 0,
    zIndex: revision,
    revision,
    groupId,
    diagramIds: [],
    createdAt: 1_000 + revision,
    updatedAt: 2_000 + revision,
    createdBy: AUTHOR,
    lastEditedBy: AUTHOR,
    shape: "rectangle",
    nodeType: null,
    label: id,
    fill: "white",
    stroke: "black",
  };
}

function persistedConnector(
  id: string,
  groupId: string | null,
): Extract<CanvasObject, { kind: "connector" }> {
  return {
    id,
    kind: "connector",
    x: 0,
    y: 0,
    width: 100,
    height: 1,
    rotation: 0,
    zIndex: 3,
    revision: 3,
    groupId,
    diagramIds: [],
    createdAt: 1_003,
    updatedAt: 2_003,
    createdBy: AUTHOR,
    lastEditedBy: AUTHOR,
    start: { x: 0, y: 0, objectId: null },
    end: { x: 100, y: 0, objectId: null },
    direction: "end",
    label: id,
    color: "black",
  };
}

function room(objects: readonly CanvasObject[]): RoomState {
  return {
    id: "room-create",
    code: "CREATE",
    title: "Creation engine",
    stateRevision: 20,
    roomRevision: 10,
    createdAt: 100,
    updatedAt: 200,
    participants: {},
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function intentOf<Type extends SemanticCanvasEditIntent["type"]>(
  intents: readonly SemanticCanvasEditIntent[],
  type: Type,
): Extract<SemanticCanvasEditIntent, { type: Type }> {
  const intent = intents.find((candidate) => candidate.type === type);
  if (!intent) throw new Error(`Expected a ${type} intent.`);
  return intent as Extract<SemanticCanvasEditIntent, { type: Type }>;
}

function publishedShape(engine: SemanticCreateSessionEngine) {
  const prepared = engine.prepareShape(shapeInput());
  const published = engine.publish(prepared.session.token);
  if (published.status !== "published") throw new Error("Expected publish.");
  return published;
}

describe("SemanticCreateSessionEngine", () => {
  it("protects a pending semantic create before publishing its absolute draft", () => {
    const engine = new SemanticCreateSessionEngine();
    const prepared = engine.prepareShape(shapeInput());

    expect(prepared).toMatchObject({
      status: "prepared",
      command: null,
      lifecycleEvents: [],
      session: {
        tool: "shape",
        phase: "prepared",
        objectId: "shape-new",
        dirty: false,
        draft: {
          id: "shape-new",
          kind: "shape",
          x: 100,
          y: 100,
          width: 1,
          height: 1,
          zIndex: 17,
          shape: "rectangle",
          nodeType: "service",
          label: "API service",
          fill: "white",
          stroke: "blue",
        },
      },
    });
    expect(Object.isFrozen(prepared.session)).toBe(true);
    expect(Object.isFrozen(prepared.session.draft)).toBe(true);

    const published = engine.publish(prepared.session.token);
    expect(published.status).toBe("published");
    if (published.status !== "published") throw new Error("Expected publish.");
    expect(published.command).toBeNull();
    expect(published.lifecycleEvents.map((event) => event.type)).toEqual([
      "gesture.started",
      "objects.changed",
    ]);
    expect(published.lifecycleEvents[0]).toEqual({
      type: "gesture.started",
      gestureId: published.session.gestureId,
      source: "pointer",
      objects: [{
        objectId: "shape-new",
        baseRevision: null,
        baseCreatedAt: null,
        operation: null,
      }],
    });
    expect(published.lifecycleEvents[1]).toMatchObject({
      type: "objects.changed",
      gestureId: published.session.gestureId,
      changes: [{
        kind: "create",
        baseRevision: null,
        baseCreatedAt: null,
        draft: { id: "shape-new", x: 100, y: 100 },
      }],
    });

    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    expect(lifecycle.dispatch(published.lifecycleEvents[0])).toEqual([]);
    expect(coordinator.get("shape-new")).toMatchObject({
      interactionActive: true,
      baseRevision: null,
      baseCreatedAt: null,
    });
    const schedule = intentOf(
      lifecycle.dispatch(published.lifecycleEvents[1]),
      "sync.schedule",
    );
    expect(schedule.edits).toMatchObject([{
      objectId: "shape-new",
      kind: "create",
      baseRevision: null,
      baseCreatedAt: null,
      draft: { id: "shape-new", kind: "shape" },
    }]);
  });

  it("normalizes rectangle, ellipse, and diamond bounds for reverse drags", () => {
    for (const shape of ["rectangle", "ellipse", "diamond"] as const) {
      const engine = new SemanticCreateSessionEngine();
      const prepared = engine.prepareShape(shapeInput({ id: `new-${shape}`, shape }));
      engine.publish(prepared.session.token);

      const updated = engine.updatePointer(prepared.session.token, { x: 20, y: 40 });

      expect(updated.status).toBe("updated");
      if (updated.status !== "updated") throw new Error("Expected update.");
      expect(updated.session.draft).toMatchObject({
        id: `new-${shape}`,
        kind: "shape",
        shape,
        x: 20,
        y: 40,
        width: 80,
        height: 60,
      });
      expect(updated.lifecycleEvents).toHaveLength(1);
      expect(updated.lifecycleEvents[0]).toMatchObject({
        changes: [{ draft: { x: 20, y: 40, width: 80, height: 60 } }],
      });
    }
  });

  it("creates a centered default-size shape on click and never applies collision spacing", () => {
    const first = new SemanticCreateSessionEngine();
    const firstPrepared = first.prepareShape(shapeInput({
      id: "overlap-a",
      defaultSize: { width: 200, height: 120 },
    }));
    first.publish(firstPrepared.session.token);
    const firstFinished = first.finish(firstPrepared.session.token);
    if (firstFinished.status !== "finished") throw new Error("Expected finish.");

    const second = new SemanticCreateSessionEngine();
    const secondPrepared = second.prepareShape(shapeInput({
      id: "overlap-b",
      defaultSize: { width: 200, height: 120 },
    }));
    second.publish(secondPrepared.session.token);
    const secondFinished = second.finish(secondPrepared.session.token);
    if (secondFinished.status !== "finished") throw new Error("Expected finish.");

    expect(firstFinished.session.draft).toMatchObject({
      x: 0,
      y: 40,
      width: 200,
      height: 120,
    });
    expect(secondFinished.session.draft).toMatchObject({
      x: 0,
      y: 40,
      width: 200,
      height: 120,
    });
    expect(firstFinished.lifecycleEvents.map((event) => event.type)).toEqual([
      "objects.changed",
      "gesture.finish-requested",
    ]);
  });

  it("suppresses duplicate shape frames while retaining complete absolute drafts", () => {
    const engine = new SemanticCreateSessionEngine();
    const published = publishedShape(engine);
    const first = engine.updatePointer(published.session.token, { x: 240, y: 170 });
    const duplicate = engine.updatePointer(published.session.token, { x: 240, y: 170 });

    expect(first.status === "updated" ? first.lifecycleEvents : []).toHaveLength(1);
    expect(duplicate.status === "updated" ? duplicate.lifecycleEvents : []).toEqual([]);
    expect(duplicate.status === "updated" ? duplicate.session.draft : null).toMatchObject({
      id: "shape-new",
      kind: "shape",
      x: 100,
      y: 100,
      width: 140,
      height: 70,
      nodeType: "service",
      label: "API service",
    });
  });

  it("samples bounded freehand points and re-normalizes them into local coordinates", () => {
    const engine = new SemanticCreateSessionEngine();
    const prepared = engine.prepareDraw({
      id: "draw-new",
      pointerStart: { x: 10, y: 10 },
      zIndex: 9,
      color: "red",
      size: "m",
      minSampleDistance: 5,
      maxPoints: 3,
    });
    engine.publish(prepared.session.token);

    const coalesced = engine.updatePointer(prepared.session.token, { x: 12, y: 12 });
    expect(coalesced.status === "updated" ? coalesced.lifecycleEvents : []).toEqual([]);

    const leftDown = engine.updatePointer(prepared.session.token, { x: 5, y: 20 });
    const rightUp = engine.updatePointer(prepared.session.token, { x: 20, y: 5 });
    if (leftDown.status !== "updated" || rightUp.status !== "updated") {
      throw new Error("Expected draw updates.");
    }
    expect(rightUp.session.draft).toMatchObject({
      id: "draw-new",
      kind: "draw",
      x: 5,
      y: 5,
      width: 15,
      height: 15,
      points: [
        { x: 5, y: 5 },
        { x: 0, y: 15 },
        { x: 15, y: 0 },
      ],
    });

    const capped = engine.updatePointer(prepared.session.token, { x: 30, y: 30 });
    if (capped.status !== "updated") throw new Error("Expected capped draw update.");
    expect(capped.session.draft).toMatchObject({
      x: 5,
      y: 10,
      width: 25,
      height: 20,
      points: [
        { x: 5, y: 0 },
        { x: 0, y: 10 },
        { x: 25, y: 20 },
      ],
    });
    expect((capped.session.draft.kind === "draw" ? capped.session.draft.points : []))
      .toHaveLength(3);
    expect(Object.isFrozen(capped.session.draft.kind === "draw" ? capped.session.draft.points : []))
      .toBe(true);
  });

  it("always keeps a draw schema-valid with two points and enforces the 20,000 domain cap", () => {
    const engine = new SemanticCreateSessionEngine();
    const prepared = engine.prepareDraw({
      id: "dot-draw",
      pointerStart: { x: -5, y: -7 },
      zIndex: 0,
      color: "blue",
      size: "s",
      maxPoints: SEMANTIC_CREATE_LIMITS.maxDrawPoints,
    });
    expect(prepared.session.draft).toMatchObject({
      x: -5,
      y: -7,
      width: 1,
      height: 1,
      points: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
    });
    expect(() => new SemanticCreateSessionEngine().prepareDraw({
      id: "too-many",
      pointerStart: { x: 0, y: 0 },
      zIndex: 0,
      color: "blue",
      size: "s",
      maxPoints: SEMANTIC_CREATE_LIMITS.maxDrawPoints + 1,
    })).toThrowError(expect.objectContaining({ code: "INVALID_SAMPLING" }));
  });

  it("forces the last coalesced draw pointer into the successful final flush", () => {
    const engine = new SemanticCreateSessionEngine();
    const prepared = engine.prepareDraw({
      id: "precise-endpoint",
      pointerStart: { x: 0, y: 0 },
      zIndex: 0,
      color: "black",
      size: "s",
      minSampleDistance: 10,
    });
    engine.publish(prepared.session.token);
    const coalesced = engine.updatePointer(prepared.session.token, { x: 3, y: 4 });
    expect(coalesced.status === "updated" ? coalesced.lifecycleEvents : []).toEqual([]);

    const finished = engine.finish(prepared.session.token);

    expect(finished.status).toBe("finished");
    if (finished.status !== "finished") throw new Error("Expected finish.");
    expect(finished.session.draft).toMatchObject({
      x: 0,
      y: 0,
      width: 3,
      height: 4,
      points: [{ x: 0, y: 0 }, { x: 3, y: 4 }],
    });
    expect(finished.lifecycleEvents.map((event) => event.type)).toEqual([
      "objects.changed",
      "gesture.finish-requested",
    ]);
  });

  it("creates click text with explicit identity, style, and default bounds", () => {
    const engine = new SemanticCreateSessionEngine();
    const prepared = engine.prepareText({
      id: "text-new",
      point: { x: 200, y: 100 },
      zIndex: 22,
      content: "Human and agent presence",
      color: "violet",
      size: "l",
      align: "middle",
      defaultSize: { width: 300, height: 80 },
    });
    const published = engine.publish(prepared.session.token);
    const finished = engine.finish(prepared.session.token);

    expect(prepared.session.draft).toEqual({
      id: "text-new",
      kind: "text",
      x: 50,
      y: 60,
      width: 300,
      height: 80,
      rotation: 0,
      zIndex: 22,
      groupId: null,
      content: "Human and agent presence",
      color: "violet",
      size: "l",
      align: "middle",
    });
    expect(published.status === "published" ? published.lifecycleEvents.map((event) => event.type) : [])
      .toEqual(["gesture.started", "objects.changed"]);
    expect(finished.status === "finished" ? finished.lifecycleEvents : []).toMatchObject([{
      type: "gesture.finish-requested",
      reason: "pointer-up",
    }]);
  });

  it("keeps provisional text renderer-local and publishes one final atomic create", () => {
    const engine = new SemanticCreateSessionEngine();
    const prepared = engine.prepareText({
      id: "text-immediate",
      point: { x: 200, y: 100 },
      zIndex: 22,
      content: "",
      color: "black",
      size: "m",
      align: "start",
    });

    const started = engine.startProvisionalText(prepared.session.token);
    expect(started.status).toBe("started");
    if (started.status !== "started") throw new Error("Expected provisional text start.");
    expect(started.lifecycleEvents).toEqual([{
      type: "gesture.started",
      gestureId: started.session.gestureId,
      source: "text",
      objects: [{
        objectId: "text-immediate",
        baseRevision: null,
        baseCreatedAt: null,
        operation: null,
      }],
    }]);

    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    expect(lifecycle.dispatch(started.lifecycleEvents[0])).toEqual([]);
    expect(coordinator.get("text-immediate")).toMatchObject({
      interactionActive: true,
      dirty: false,
      baseRevision: null,
    });

    const first = engine.updateProvisionalText(started.session.token, "Auth");
    const final = engine.updateProvisionalText(started.session.token, "Authentication flow");
    expect(first.status === "updated" ? first.lifecycleEvents : null).toEqual([]);
    expect(final.status === "updated" ? final.lifecycleEvents : null).toEqual([]);
    expect(final.status === "updated" ? final.session.draft : null).toMatchObject({
      kind: "text",
      content: "Authentication flow",
    });

    const committed = engine.commitProvisionalText(started.session.token);
    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") throw new Error("Expected provisional text commit.");
    expect(committed.lifecycleEvents).toMatchObject([
      {
        type: "objects.changed",
        changes: [{
          kind: "create",
          draft: { id: "text-immediate", content: "Authentication flow" },
        }],
      },
      { type: "gesture.finish-requested", reason: "text-commit" },
    ]);
    const scheduled = lifecycle.dispatch(committed.lifecycleEvents[0]);
    expect(scheduled).toMatchObject([{
      type: "sync.schedule",
      edits: [{ kind: "create", draft: { content: "Authentication flow" } }],
    }]);
    expect(lifecycle.dispatch(committed.lifecycleEvents[1])).toMatchObject([{
      type: "gesture.settle",
      reason: "text-commit",
    }]);
    expect(engine.current()).toBeNull();
  });

  it("cancels pristine or edited provisional text without ever scheduling a mutation", () => {
    for (const value of ["", "discard me"]) {
      const engine = new SemanticCreateSessionEngine();
      const prepared = engine.prepareText({
        id: `cancel-${value || "pristine"}`,
        point: { x: 0, y: 0 },
        zIndex: 1,
        content: "",
        color: "black",
        size: "m",
        align: "start",
      });
      const started = engine.startProvisionalText(prepared.session.token);
      if (started.status !== "started") throw new Error("Expected provisional text start.");
      if (value) engine.updateProvisionalText(started.session.token, value);

      const cancelled = engine.cancelProvisionalText(started.session.token);

      expect(cancelled).toMatchObject({
        status: "cancelled",
        objectId: prepared.session.objectId,
        clearObjectIds: [prepared.session.objectId],
        lifecycleEvents: [{
          type: "gesture.cancel-requested",
          gestureId: started.session.gestureId,
          reason: "text-cancel",
        }],
      });
      expect(engine.current()).toBeNull();
      expect(engine.commitProvisionalText(started.session.token)).toEqual({
        status: "stale",
        token: started.session.token,
      });
    }
  });

  it("treats pointer-cancel as a successful final flush, not rollback or abandon", () => {
    const engine = new SemanticCreateSessionEngine();
    const published = publishedShape(engine);

    const finished = engine.pointerCancel(published.session.token, { x: 260, y: 220 });

    expect(finished).toMatchObject({
      status: "finished",
      command: null,
      session: { phase: "finished", draft: { width: 160, height: 120 } },
    });
    if (finished.status !== "finished") throw new Error("Expected finish.");
    expect(finished.lifecycleEvents.map((event) => event.type)).toEqual([
      "objects.changed",
      "gesture.finish-requested",
    ]);
    expect(finished.lifecycleEvents.at(-1)).toEqual({
      type: "gesture.finish-requested",
      gestureId: finished.session.gestureId,
      reason: "pointer-cancel",
    });
    expect(engine.current()).toBeNull();
  });

  it("offers a lifecycle-free abandon only before publish and fences stale tokens", () => {
    const engine = new SemanticCreateSessionEngine();
    const prepared = engine.prepareShape(shapeInput());
    const abandoned = engine.abandon(prepared.session.token);

    expect(abandoned).toEqual({
      status: "abandoned",
      token: prepared.session.token,
      objectId: "shape-new",
      clearObjectIds: ["shape-new"],
      command: null,
      lifecycleEvents: [],
    });
    expect(engine.current()).toBeNull();
    expect(engine.publish(prepared.session.token)).toEqual({
      status: "stale",
      token: prepared.session.token,
    });
    expect(engine.updatePointer(prepared.session.token, { x: 20, y: 20 })).toEqual({
      status: "stale",
      token: prepared.session.token,
    });

    const next = engine.prepareShape(shapeInput({ id: "next" }));
    engine.publish(next.session.token);
    expect(() => engine.abandon(next.session.token)).toThrowError(
      expect.objectContaining({ code: "INVALID_PHASE" }),
    );
    expect(engine.finish(prepared.session.token)).toEqual({
      status: "stale",
      token: prepared.session.token,
    });
  });

  it("expands group membership and emits delete protection, tombstones, and final boundary in order", () => {
    const first = persistedShape("first", "group-a", 4);
    const second = persistedShape("second", "group-a", 7);
    const groupedEdge = persistedConnector("edge", "group-a");
    const outside = persistedShape("outside", null, 9);
    const engine = new SemanticCreateSessionEngine();

    const result = engine.deleteSelection({
      room: room([outside, second, groupedEdge, first]),
      selectedObjectIds: ["first", "missing", "first"],
      selectedGroupIds: ["missing-group"],
    });

    expect(result.status).toBe("finished");
    if (result.status !== "finished") throw new Error("Expected delete.");
    expect(result.command).toBeNull();
    expect(result.targetObjectIds).toEqual(["edge", "first", "second"]);
    expect(result.selectionReport).toEqual({
      missingObjectIds: ["missing"],
      missingGroupIds: ["missing-group"],
      resolvedGroupIds: ["group-a"],
    });
    expect(result.lifecycleEvents.map((event) => event.type)).toEqual([
      "gesture.started",
      "objects.changed",
      "gesture.finish-requested",
    ]);
    expect(result.lifecycleEvents[0]).toEqual({
      type: "gesture.started",
      gestureId: result.gestureId,
      source: "keyboard",
      objects: [
        { objectId: "edge", baseRevision: 3, baseCreatedAt: 1_003, operation: "delete" },
        { objectId: "first", baseRevision: 4, baseCreatedAt: 1_004, operation: "delete" },
        { objectId: "second", baseRevision: 7, baseCreatedAt: 1_007, operation: "delete" },
      ],
    });
    expect(result.lifecycleEvents[1]).toMatchObject({
      type: "objects.changed",
      changes: [
        { kind: "delete", objectId: "edge", operation: "delete" },
        { kind: "delete", objectId: "first", operation: "delete" },
        { kind: "delete", objectId: "second", operation: "delete" },
      ],
    });
    expect(result.lifecycleEvents[2]).toEqual({
      type: "gesture.finish-requested",
      gestureId: result.gestureId,
      reason: "keyboard-idle",
    });

    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    expect(intentOf(lifecycle.dispatch(result.lifecycleEvents[0]), "lease.acquire")).toEqual({
      type: "lease.acquire",
      gestureId: result.gestureId,
      targets: [
        { objectId: "edge", expectedRevision: 3, operation: "delete" },
        { objectId: "first", expectedRevision: 4, operation: "delete" },
        { objectId: "second", expectedRevision: 7, operation: "delete" },
      ],
    });
    const schedule = intentOf(lifecycle.dispatch(result.lifecycleEvents[1]), "sync.schedule");
    expect(schedule.edits).toMatchObject([
      { objectId: "edge", kind: "delete", baseRevision: 3 },
      { objectId: "first", kind: "delete", baseRevision: 4 },
      { objectId: "second", kind: "delete", baseRevision: 7 },
    ]);
    expect(intentOf(lifecycle.dispatch(result.lifecycleEvents[2]), "gesture.settle"))
      .toMatchObject({ source: "keyboard", reason: "keyboard-idle" });
  });

  it("returns a deterministic no-op when no selected semantic object exists", () => {
    const engine = new SemanticCreateSessionEngine();
    expect(engine.deleteSelection({
      room: room([persistedShape("outside")]),
      selectedObjectIds: ["missing"],
      selectedGroupIds: ["also-missing"],
    })).toEqual({
      status: "noop",
      targetObjectIds: [],
      selectionReport: {
        missingObjectIds: ["missing"],
        missingGroupIds: ["also-missing"],
        resolvedGroupIds: [],
      },
      command: null,
      lifecycleEvents: [],
    });
  });

  it("validates complete drafts with domain semantics without server code", () => {
    const engine = new SemanticCreateSessionEngine();
    expect(() => engine.prepareShape(shapeInput({ fill: "" }))).toThrowError(
      expect.objectContaining({ code: "INVALID_DRAFT" }),
    );
    expect(() => engine.prepareShape(shapeInput({
      nodeType: "decision",
      nodeMetadata: {
        kind: "open_question",
        status: "open",
        owner: null,
        resolution: null,
      },
    }))).toThrowError(expect.objectContaining({ code: "INVALID_DRAFT" }));
    expect(() => engine.prepareText({
      id: "too-long",
      point: { x: 0, y: 0 },
      zIndex: 0,
      content: "x".repeat(20_001),
      color: "black",
      size: "m",
      align: "start",
    })).toThrowError(SemanticCreateSessionError);
  });
});
