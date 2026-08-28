import { describe, expect, it } from "vitest";

import { CanvasObjectSyncCoordinator } from "./sync-coordinator";
import {
  SemanticCanvasEditLifecycleController,
} from "./semantic-edit-lifecycle";
import type {
  SemanticCanvasEditIntent,
  SemanticCanvasGestureSettleIntent,
} from "./semantic-edit-events";
import type { CreateCanvasObject } from "@/lib/domain/types";
import type { ActorRef, CanvasObject, RoomState } from "@/lib/domain/types";
import { normalizeConnectorRouting } from "@/lib/domain/connector-routing";
import { SemanticMoveSessionEngine } from "./semantic-move-session";

type ShapeDraft = Extract<CreateCanvasObject, { kind: "shape" }>;

function shapeDraft(id: string, label: string): ShapeDraft {
  return {
    id,
    kind: "shape",
    x: 10,
    y: 20,
    width: 160,
    height: 90,
    rotation: 0,
    zIndex: 1,
    groupId: null,
    shape: "rectangle",
    nodeType: null,
    label,
    fill: "white",
    stroke: "black",
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

function requestFinish(
  controller: SemanticCanvasEditLifecycleController,
  gestureId: string,
  reason: "pointer-up" | "pointer-cancel" | "text-blur",
): SemanticCanvasGestureSettleIntent {
  return intentOf(
    controller.dispatch({ type: "gesture.finish-requested", gestureId, reason }),
    "gesture.settle",
  );
}

describe("SemanticCanvasEditLifecycleController", () => {
  it("turns a real grouped move pointer-down into one immediate lease cohort", () => {
    const actor: ActorRef = {
      participantId: "participant",
      displayName: "Participant",
      color: "violet",
      kind: "human",
    };
    const common = {
      width: 100,
      height: 80,
      rotation: 0,
      zIndex: 1,
      revision: 3,
      groupId: "architecture",
      diagramIds: [],
      createdAt: 100,
      updatedAt: 100,
      createdBy: actor,
      lastEditedBy: actor,
    };
    const first: CanvasObject = {
      ...common,
      id: "first",
      kind: "shape",
      x: 0,
      y: 0,
      shape: "rectangle",
      nodeType: "service",
      label: "First",
      fill: "white",
      stroke: "black",
    };
    const second: CanvasObject = {
      ...first,
      id: "second",
      x: 300,
      revision: 5,
    };
    const edge: CanvasObject = {
      ...common,
      id: "edge",
      kind: "connector",
      x: 100,
      y: 40,
      width: 200,
      height: 1,
      revision: 7,
      start: { x: 100, y: 40, objectId: "first" },
      end: { x: 300, y: 40, objectId: "second" },
      routing: normalizeConnectorRouting({ mode: "straight" }),
      direction: "end",
      label: "calls",
      color: "black",
    };
    const room: RoomState = {
      id: "room",
      code: "ROOM01",
      title: "Room",
      stateRevision: 1,
      roomRevision: 1,
      createdAt: 1,
      updatedAt: 1,
      participants: {},
      objects: { first, second, edge },
      diagrams: {},
      leases: {},
      spotlight: null,
      agentEditPolicy: "live",
      reviewProposals: [],
    };
    const move = new SemanticMoveSessionEngine().begin({
      room,
      selectedObjectIds: ["first"],
      pointerStart: { x: 10, y: 10 },
    });
    if (move.status !== "started") throw new Error("Expected grouped move to start.");
    const coordinator = new CanvasObjectSyncCoordinator();
    const controller = new SemanticCanvasEditLifecycleController(coordinator);

    const intents = controller.dispatch(move.lifecycleEvent);

    expect(coordinator.protectedObjectIds()).toEqual(new Set(["first", "second", "edge"]));
    expect(intentOf(intents, "lease.acquire")).toEqual({
      type: "lease.acquire",
      gestureId: move.session.gestureId,
      targets: [
        { objectId: "first", expectedRevision: 3, operation: "move" },
        { objectId: "second", expectedRevision: 5, operation: "move" },
        { objectId: "edge", expectedRevision: 7, operation: "connect" },
      ],
    });
  });

  it("synchronously protects a multi-object cohort before returning lease intents", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const controller = new SemanticCanvasEditLifecycleController(coordinator);

    const intents = controller.dispatch({
      type: "gesture.started",
      gestureId: "pointer-1",
      source: "pointer",
      objects: [
        { objectId: "a", baseRevision: 2, baseCreatedAt: 100, operation: "move" },
        { objectId: "b", baseRevision: 5, baseCreatedAt: 200, operation: "connect" },
      ],
    });

    expect(coordinator.protectedObjectIds()).toEqual(new Set(["a", "b"]));
    expect(intentOf(intents, "lease.acquire")).toEqual({
      type: "lease.acquire",
      gestureId: "pointer-1",
      targets: [
        { objectId: "a", expectedRevision: 2, operation: "move" },
        { objectId: "b", expectedRevision: 5, operation: "connect" },
      ],
    });

    const scheduled = intentOf(
      controller.dispatch({
        type: "objects.changed",
        gestureId: "pointer-1",
        changes: [
          {
            kind: "update",
            draft: shapeDraft("a", "moved"),
            baseRevision: 2,
            baseCreatedAt: 100,
            operation: "move",
          },
        ],
      }),
      "sync.schedule",
    );
    expect(scheduled.objectIds).toEqual(["a", "b"]);
    expect(scheduled.edits.map((edit) => edit.objectId)).toEqual(["a"]);
  });

  it("adds frame-discovered connector dependencies before optimistic pixels without persisting no-op edits", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const controller = new SemanticCanvasEditLifecycleController(coordinator);
    controller.dispatch({
      type: "gesture.started",
      gestureId: "pointer-dependencies",
      source: "pointer",
      objects: [
        { objectId: "node", baseRevision: 4, baseCreatedAt: 100, operation: "move" },
      ],
    });

    const dependencyIntents = controller.dispatch({
      type: "gesture.dependencies-added",
      gestureId: "pointer-dependencies",
      objects: [
        { objectId: "edge", baseRevision: 9, baseCreatedAt: 200, operation: "connect" },
      ],
    });

    expect(coordinator.protectedObjectIds()).toEqual(new Set(["node", "edge"]));
    expect(intentOf(dependencyIntents, "lease.acquire")).toEqual({
      type: "lease.acquire",
      gestureId: "pointer-dependencies",
      targets: [{ objectId: "edge", expectedRevision: 9, operation: "connect" }],
    });
    expect(controller.getPendingEdit("edge")).toBeUndefined();
    expect(controller.dispatch({
      type: "gesture.dependencies-added",
      gestureId: "pointer-dependencies",
      objects: [
        { objectId: "edge", baseRevision: 9, baseCreatedAt: 200, operation: "connect" },
      ],
    })).toEqual([]);

    const scheduled = intentOf(controller.dispatch({
      type: "objects.changed",
      gestureId: "pointer-dependencies",
      changes: [{
        kind: "update",
        draft: { ...shapeDraft("node", "moved"), x: 240 },
        baseRevision: 4,
        baseCreatedAt: 100,
        operation: "move",
      }],
    }), "sync.schedule");
    expect(scheduled.objectIds).toEqual(["edge", "node"]);
    expect(scheduled.edits.map((edit) => edit.objectId)).toEqual(["node"]);
  });

  it("protects a pending create and carries its latest generation into a pointer final flush", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const controller = new SemanticCanvasEditLifecycleController(coordinator);
    controller.dispatch({
      type: "gesture.started",
      gestureId: "draw-create",
      source: "pointer",
      objects: [
        { objectId: "new-node", baseRevision: null, baseCreatedAt: null, operation: null },
      ],
    });

    expect(coordinator.protectedObjectIds()).toEqual(new Set(["new-node"]));
    const first = intentOf(
      controller.dispatch({
        type: "objects.changed",
        gestureId: "draw-create",
        changes: [
          {
            kind: "create",
            draft: shapeDraft("new-node", "draft"),
            baseRevision: null,
            baseCreatedAt: null,
          },
        ],
      }),
      "sync.schedule",
    );
    const second = intentOf(
      controller.dispatch({
        type: "objects.changed",
        gestureId: "draw-create",
        changes: [
          {
            kind: "create",
            draft: shapeDraft("new-node", "newer draft"),
            baseRevision: null,
            baseCreatedAt: null,
          },
        ],
      }),
      "sync.schedule",
    );
    expect(first.edits[0].generation).toBe(1);
    expect(second.edits[0].generation).toBe(2);
    expect(coordinator.get("new-node")).toMatchObject({
      baseRevision: null,
      baseCreatedAt: null,
      interactionActive: true,
      dirty: true,
      deleted: false,
      generation: 2,
    });

    const settle = requestFinish(controller, "draw-create", "pointer-up");
    expect(settle).toMatchObject({
      timing: "after-render-settle",
      source: "pointer",
      reason: "pointer-up",
      objectIds: ["new-node"],
    });
    expect(coordinator.get("new-node")?.interactionActive).toBe(true);

    const flushed = intentOf(
      controller.dispatch({
        type: "gesture.settled",
        token: settle.token,
        finalChanges: [
          {
            kind: "create",
            draft: shapeDraft("new-node", "final draft"),
            baseRevision: null,
            baseCreatedAt: null,
          },
        ],
      }),
      "sync.flush",
    );
    expect(flushed).toMatchObject({
      mode: "final",
      source: "pointer",
      reason: "pointer-up",
      objectIds: ["new-node"],
    });
    expect(flushed.edits[0]).toMatchObject({
      objectId: "new-node",
      kind: "create",
      generation: 3,
      operation: null,
    });
    expect(coordinator.get("new-node")).toMatchObject({
      interactionActive: false,
      dirty: true,
      generation: 3,
    });
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["new-node"]));
  });

  it("retains a delete tombstone through pointer cancellation and final flush", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const controller = new SemanticCanvasEditLifecycleController(coordinator);
    controller.dispatch({
      type: "gesture.started",
      gestureId: "delete-gesture",
      source: "pointer",
      objects: [
        { objectId: "old-node", baseRevision: 7, baseCreatedAt: 500, operation: "delete" },
      ],
    });
    const scheduled = intentOf(
      controller.dispatch({
        type: "objects.changed",
        gestureId: "delete-gesture",
        changes: [
          {
            kind: "delete",
            objectId: "old-node",
            baseRevision: 7,
            baseCreatedAt: 500,
            operation: "delete",
          },
        ],
      }),
      "sync.schedule",
    );

    expect(scheduled.edits[0]).toEqual({
      objectId: "old-node",
      kind: "delete",
      generation: 1,
      recoveryEpoch: 0,
      baseRevision: 7,
      baseCreatedAt: 500,
      gestureId: "delete-gesture",
      operation: "delete",
    });
    expect(coordinator.get("old-node")?.deleted).toBe(true);

    const settle = requestFinish(controller, "delete-gesture", "pointer-cancel");
    const flush = intentOf(
      controller.dispatch({ type: "gesture.settled", token: settle.token }),
      "sync.flush",
    );
    expect(flush.reason).toBe("pointer-cancel");
    expect(flush.edits[0].kind).toBe("delete");
    expect("draft" in flush.edits[0]).toBe(false);
    expect(coordinator.get("old-node")).toMatchObject({
      interactionActive: false,
      dirty: true,
      deleted: true,
    });
  });

  it("captures the renderer-settled text value in a text final flush", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const controller = new SemanticCanvasEditLifecycleController(coordinator);
    controller.dispatch({
      type: "gesture.started",
      gestureId: "text-edit",
      source: "text",
      objects: [
        { objectId: "label", baseRevision: 3, baseCreatedAt: 800, operation: "edit" },
      ],
    });
    controller.dispatch({
      type: "objects.changed",
      gestureId: "text-edit",
      changes: [
        {
          kind: "update",
          draft: shapeDraft("label", "typing"),
          baseRevision: 3,
          baseCreatedAt: 800,
          operation: "edit",
        },
      ],
    });

    const settle = requestFinish(controller, "text-edit", "text-blur");
    expect(coordinator.get("label")?.interactionActive).toBe(true);
    const flush = intentOf(
      controller.dispatch({
        type: "gesture.settled",
        token: settle.token,
        finalChanges: [
          {
            kind: "update",
            draft: shapeDraft("label", "settled text"),
            baseRevision: 3,
            baseCreatedAt: 800,
            operation: "edit",
          },
        ],
      }),
      "sync.flush",
    );

    expect(flush).toMatchObject({ source: "text", reason: "text-blur" });
    expect(flush.edits[0]).toMatchObject({ kind: "update", generation: 2 });
    expect((flush.edits[0] as Extract<typeof flush.edits[number], { kind: "update" }>).draft)
      .toMatchObject({ label: "settled text" });
  });

  it("treats text cancellation as authoritative recovery instead of a successful flush", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const controller = new SemanticCanvasEditLifecycleController(coordinator);
    controller.dispatch({
      type: "gesture.started",
      gestureId: "text-cancel",
      source: "text",
      objects: [
        { objectId: "label", baseRevision: 3, baseCreatedAt: 800, operation: "edit" },
      ],
    });
    controller.dispatch({
      type: "objects.changed",
      gestureId: "text-cancel",
      changes: [
        {
          kind: "update",
          draft: shapeDraft("label", "temporary"),
          baseRevision: 3,
          baseCreatedAt: 800,
          operation: "edit",
        },
      ],
    });

    const cancel = intentOf(
      controller.dispatch({
        type: "gesture.cancel-requested",
        gestureId: "text-cancel",
        reason: "text-cancel",
      }),
      "sync.cancel",
    );
    expect(cancel).toMatchObject({
      mode: "authoritative-recovery",
      source: "text",
      reason: "text-cancel",
      objectIds: ["label"],
    });
    expect(cancel.edits[0]).toMatchObject({ kind: "update", objectId: "label" });
    expect(coordinator.get("label")).toMatchObject({
      interactionActive: false,
      awaitingRecovery: true,
      dirty: true,
    });
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["label"]));
    expect(controller.getPendingEdit("label")).toBeDefined();

    expect(controller.dispatch({
      type: "gesture.cancellation-settled",
      token: cancel.token,
      authoritative: [{ objectId: "label", revision: 4, createdAt: 800 }],
    })).toEqual([]);
    expect(coordinator.get("label")).toMatchObject({
      baseRevision: 4,
      baseCreatedAt: 800,
      interactionActive: false,
      awaitingRecovery: false,
      dirty: false,
    });
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
    expect(controller.getPendingEdit("label")).toBeUndefined();
  });

  it("keeps cancellation protected until a complete, current recovery settlement arrives", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const controller = new SemanticCanvasEditLifecycleController(coordinator);
    controller.dispatch({
      type: "gesture.started",
      gestureId: "cancel-fenced",
      source: "text",
      objects: [
        { objectId: "a", baseRevision: 1, baseCreatedAt: 100, operation: "edit" },
        { objectId: "b", baseRevision: 2, baseCreatedAt: 200, operation: "edit" },
      ],
    });
    const cancel = intentOf(
      controller.dispatch({
        type: "gesture.cancel-requested",
        gestureId: "cancel-fenced",
        reason: "text-cancel",
      }),
      "sync.cancel",
    );

    expect(controller.dispatch({
      type: "gesture.cancellation-settled",
      token: { ...cancel.token, lifecycle: cancel.token.lifecycle + 1 },
      authoritative: [
        { objectId: "a", revision: 1, createdAt: 100 },
        { objectId: "b", revision: 2, createdAt: 200 },
      ],
    })).toEqual([]);
    expect(controller.dispatch({
      type: "gesture.cancellation-settled",
      token: cancel.token,
      authoritative: [{ objectId: "a", revision: 1, createdAt: 100 }],
    })).toEqual([]);
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["a", "b"]));

    controller.dispatch({
      type: "gesture.cancellation-settled",
      token: cancel.token,
      authoritative: [
        { objectId: "a", revision: 1, createdAt: 100 },
        { objectId: "b", revision: 2, createdAt: 200 },
      ],
    });
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
  });

  it("rejects stale finalization tokens without dropping synchronous protection", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const controller = new SemanticCanvasEditLifecycleController(coordinator);
    controller.dispatch({
      type: "gesture.started",
      gestureId: "pointer-stale",
      source: "pointer",
      objects: [
        { objectId: "node", baseRevision: 1, baseCreatedAt: 10, operation: "move" },
      ],
    });
    const settle = requestFinish(controller, "pointer-stale", "pointer-up");

    expect(controller.dispatch({
      type: "gesture.settled",
      token: { ...settle.token, lifecycle: settle.token.lifecycle + 1 },
    })).toEqual([]);
    expect(coordinator.get("node")?.interactionActive).toBe(true);
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["node"]));

    expect(intentOf(
      controller.dispatch({ type: "gesture.settled", token: settle.token }),
      "sync.flush",
    ).objectIds).toEqual(["node"]);
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
  });

  it("lets a newer gesture supersede an older final flush without ending the newer interaction", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const controller = new SemanticCanvasEditLifecycleController(coordinator);
    controller.dispatch({
      type: "gesture.started",
      gestureId: "older",
      source: "pointer",
      objects: [
        { objectId: "node", baseRevision: 4, baseCreatedAt: 100, operation: "move" },
      ],
    });
    controller.dispatch({
      type: "objects.changed",
      gestureId: "older",
      changes: [
        {
          kind: "update",
          draft: shapeDraft("node", "older value"),
          baseRevision: 4,
          baseCreatedAt: 100,
          operation: "move",
        },
      ],
    });
    const olderSettle = requestFinish(controller, "older", "pointer-up");

    controller.dispatch({
      type: "gesture.started",
      gestureId: "newer",
      source: "pointer",
      objects: [
        { objectId: "node", baseRevision: 4, baseCreatedAt: 100, operation: "resize" },
      ],
    });
    expect(controller.dispatch({ type: "gesture.settled", token: olderSettle.token })).toEqual([
      expect.objectContaining({
        type: "sync.flush",
        gestureId: "older",
        objectIds: [],
        edits: [],
      }),
    ]);
    expect(coordinator.get("node")?.interactionActive).toBe(true);
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["node"]));

    const scheduled = intentOf(
      controller.dispatch({
        type: "objects.changed",
        gestureId: "newer",
        changes: [
          {
            kind: "update",
            draft: shapeDraft("node", "newer value"),
            baseRevision: 4,
            baseCreatedAt: 100,
            operation: "resize",
          },
        ],
      }),
      "sync.schedule",
    );
    expect(scheduled.edits[0].generation).toBe(2);

    const newerSettle = requestFinish(controller, "newer", "pointer-up");
    const flush = intentOf(
      controller.dispatch({ type: "gesture.settled", token: newerSettle.token }),
      "sync.flush",
    );
    expect(flush.objectIds).toEqual(["node"]);
    expect(flush.edits[0]).toMatchObject({
      gestureId: "newer",
      generation: 2,
      operation: "resize",
    });
    expect(coordinator.get("node")?.interactionActive).toBe(false);
  });

  it("does not let a delayed older settlement overwrite a newer completed gesture", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const controller = new SemanticCanvasEditLifecycleController(coordinator);
    controller.dispatch({
      type: "gesture.started",
      gestureId: "old-delayed",
      source: "pointer",
      objects: [
        { objectId: "node", baseRevision: 4, baseCreatedAt: 100, operation: "move" },
      ],
    });
    controller.dispatch({
      type: "objects.changed",
      gestureId: "old-delayed",
      changes: [
        {
          kind: "update",
          draft: shapeDraft("node", "old"),
          baseRevision: 4,
          baseCreatedAt: 100,
          operation: "move",
        },
      ],
    });
    const oldSettle = requestFinish(controller, "old-delayed", "pointer-up");

    controller.dispatch({
      type: "gesture.started",
      gestureId: "new-completed",
      source: "pointer",
      objects: [
        { objectId: "node", baseRevision: 4, baseCreatedAt: 100, operation: "resize" },
      ],
    });
    controller.dispatch({
      type: "objects.changed",
      gestureId: "new-completed",
      changes: [
        {
          kind: "update",
          draft: shapeDraft("node", "new"),
          baseRevision: 4,
          baseCreatedAt: 100,
          operation: "resize",
        },
      ],
    });
    const newSettle = requestFinish(controller, "new-completed", "pointer-up");
    controller.dispatch({ type: "gesture.settled", token: newSettle.token });

    expect(controller.dispatch({
      type: "gesture.settled",
      token: oldSettle.token,
      finalChanges: [
        {
          kind: "update",
          draft: shapeDraft("node", "stale final"),
          baseRevision: 4,
          baseCreatedAt: 100,
          operation: "move",
        },
      ],
    })).toEqual([
      expect.objectContaining({
        type: "sync.flush",
        gestureId: "old-delayed",
        objectIds: [],
        edits: [],
      }),
    ]);
    expect(coordinator.get("node")?.generation).toBe(2);
    expect(controller.getPendingEdit("node")).toMatchObject({
      gestureId: "new-completed",
      generation: 2,
      operation: "resize",
    });
  });

  it("does not clear a newer semantic draft with an older generation", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const controller = new SemanticCanvasEditLifecycleController(coordinator);
    const event = (label: string) => ({
      type: "objects.changed" as const,
      gestureId: null,
      changes: [
        {
          kind: "create" as const,
          draft: shapeDraft("new-node", label),
          baseRevision: null,
          baseCreatedAt: null,
        },
      ],
    });
    const first = intentOf(controller.dispatch(event("first")), "sync.schedule");
    const second = intentOf(controller.dispatch(event("second")), "sync.schedule");

    expect(controller.clearPendingEdit("new-node", first.edits[0].generation)).toBe(false);
    expect(controller.getPendingEdit("new-node")?.generation).toBe(second.edits[0].generation);
    expect(controller.clearPendingEdit("new-node", second.edits[0].generation)).toBe(true);
    expect(controller.getPendingEdit("new-node")).toBeUndefined();
  });

  it("settles a failed gesture only after authoritative coordinator recovery", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const controller = new SemanticCanvasEditLifecycleController(coordinator);
    controller.dispatch({
      type: "gesture.started",
      gestureId: "failed-pointer",
      source: "pointer",
      objects: [
        { objectId: "node", baseRevision: 4, baseCreatedAt: 100, operation: "move" },
      ],
    });
    controller.dispatch({
      type: "objects.changed",
      gestureId: "failed-pointer",
      changes: [
        {
          kind: "update",
          draft: shapeDraft("node", "optimistic"),
          baseRevision: 4,
          baseCreatedAt: 100,
          operation: "move",
        },
      ],
    });

    const recoveryEvent = {
      type: "gesture.recovery-settled" as const,
      gestureId: "failed-pointer",
      authoritative: [{ objectId: "node", revision: 4, createdAt: 100 }],
    };
    expect(controller.dispatch(recoveryEvent)).toEqual([]);
    expect(controller.getPendingEdit("node")).toBeDefined();
    expect(controller.dispatch({
      type: "gesture.recovery-settled",
      gestureId: "unknown-gesture",
      authoritative: recoveryEvent.authoritative,
    })).toEqual([]);
    expect(controller.getPendingEdit("node")).toBeDefined();

    coordinator.beginRecovery("node");
    coordinator.completeRecovery("node", 4, 100);
    expect(controller.dispatch(recoveryEvent)).toEqual([]);
    expect(controller.getPendingEdit("node")).toBeUndefined();
    expect(controller.dispatch({
      type: "gesture.finish-requested",
      gestureId: "failed-pointer",
      reason: "pointer-up",
    })).toEqual([]);
  });
});
