import { describe, expect, it } from "vitest";

import type {
  ActorRef,
  CanvasObject,
  ShapeObject,
  TextObject,
} from "@/lib/domain/types";

import { SemanticCanvasEditLifecycleController } from "./semantic-edit-lifecycle";
import type { SemanticCanvasEditIntent } from "./semantic-edit-events";
import {
  SEMANTIC_TEXT_EDIT_LIMITS,
  SemanticTextEditSessionEngine,
  SemanticTextEditSessionError,
} from "./semantic-text-edit-session";
import { CanvasObjectSyncCoordinator } from "./sync-coordinator";

const AUTHOR: ActorRef = {
  participantId: "author",
  displayName: "Author",
  color: "blue",
  kind: "human",
};

function base(id: string, revision = 3, createdAt = 1_000) {
  return {
    id,
    x: 10,
    y: 20,
    width: 180,
    height: 100,
    rotation: 0,
    zIndex: 2,
    revision,
    groupId: null,
    diagramIds: [] as string[],
    createdAt,
    updatedAt: createdAt + 100,
    createdBy: AUTHOR,
    lastEditedBy: AUTHOR,
  };
}

function textObject(overrides: Partial<TextObject> = {}): TextObject {
  return {
    ...base("text-1"),
    kind: "text",
    content: "Authoritative text",
    color: "black",
    size: "m",
    align: "start",
    ...overrides,
  };
}

function shapeObject(overrides: Partial<ShapeObject> = {}): ShapeObject {
  return {
    ...base("node-1", 7, 2_000),
    kind: "shape",
    shape: "rectangle",
    nodeType: "decision",
    nodeMetadata: {
      kind: "decision",
      status: "accepted",
      owner: "Architecture",
      resolution: "Keep the first-party renderer.",
      resolvedAt: 2_500,
    },
    label: "Semantic node",
    fill: "white",
    stroke: "blue",
    ...overrides,
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

describe("SemanticTextEditSessionEngine", () => {
  it("captures immutable concurrency bases and maps start to a protected text lifecycle", () => {
    const object = textObject();
    const engine = new SemanticTextEditSessionEngine();
    const started = engine.begin(object);

    expect(started.session).toMatchObject({
      objectId: "text-1",
      objectKind: "text",
      field: "content",
      baseRevision: 3,
      baseCreatedAt: 1_000,
      initialValue: "Authoritative text",
      draftValue: "Authoritative text",
      dirty: false,
    });
    expect(started.lifecycleEvent).toEqual({
      type: "gesture.started",
      gestureId: started.session.gestureId,
      source: "text",
      objects: [{
        objectId: "text-1",
        baseRevision: 3,
        baseCreatedAt: 1_000,
        operation: "edit",
      }],
    });
    expect(Object.isFrozen(started.session)).toBe(true);
    expect(Object.isFrozen(started.session.token)).toBe(true);

    object.revision = 99;
    object.createdAt = 99_000;
    object.content = "Later authoritative projection";
    const updated = engine.updateDraft(started.session.token, "Local value");
    expect(updated.status).toBe("updated");
    if (updated.status !== "updated") throw new Error("Expected an active session.");
    expect(updated.session).toMatchObject({
      baseRevision: 3,
      baseCreatedAt: 1_000,
      initialValue: "Authoritative text",
      draftValue: "Local value",
    });
  });

  it("publishes draft values synchronously and feeds the shared persistence debounce", () => {
    const engine = new SemanticTextEditSessionEngine();
    const started = engine.begin(textObject());

    const updated = engine.updateDraft(started.session.token, "Visible this frame");

    expect(updated).toMatchObject({ status: "updated", session: {
      draftValue: "Visible this frame",
      dirty: true,
    } });
    expect(updated.status === "updated" ? updated.lifecycleEvents : []).toMatchObject([{
      type: "objects.changed",
      gestureId: started.session.gestureId,
      changes: [{
        kind: "update",
        baseRevision: 3,
        baseCreatedAt: 1_000,
        operation: "edit",
        draft: { id: "text-1", kind: "text", content: "Visible this frame" },
      }],
    }]);
    expect(engine.current()).toBe(updated.status === "updated" ? updated.session : null);

    const duplicate = engine.updateDraft(started.session.token, "Visible this frame");
    expect(duplicate.status === "updated" ? duplicate.lifecycleEvents : []).toEqual([]);
  });

  it("lets typing and commit remain immediate while lease acquisition is still pending", () => {
    const engine = new SemanticTextEditSessionEngine();
    const started = engine.begin(textObject());
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);

    expect(intentOf(lifecycle.dispatch(started.lifecycleEvent), "lease.acquire")).toMatchObject({
      targets: [{ objectId: "text-1", expectedRevision: 3, operation: "edit" }],
    });
    const updated = engine.updateDraft(started.session.token, "Local while the lease is pending");
    if (updated.status !== "updated") throw new Error("Expected an active session.");
    const schedule = intentOf(lifecycle.dispatch(updated.lifecycleEvents[0]!), "sync.schedule");
    expect(schedule.edits).toMatchObject([{
      objectId: "text-1",
      generation: 1,
      draft: { content: "Local while the lease is pending" },
    }]);

    const committed = engine.commit(started.session.token);
    expect(committed).toMatchObject({ status: "committed", command: null });
    if (committed.status !== "committed") throw new Error("Expected a commit.");
    expect(intentOf(lifecycle.dispatch(committed.lifecycleEvents[0]!), "gesture.settle"))
      .toMatchObject({
        source: "text",
        reason: "text-commit",
        objectIds: ["text-1"],
      });
    expect(coordinator.get("text-1")).toMatchObject({
      interactionActive: true,
      generation: 1,
    });
  });

  it("emits exact absolute drafts while commit only requests the shared final flush", () => {
    const engine = new SemanticTextEditSessionEngine();
    const started = engine.begin(textObject({ color: "red" }));
    const updated = engine.updateDraft(started.session.token, "Committed text");
    if (updated.status !== "updated") throw new Error("Expected an update.");

    const committed = engine.commit(started.session.token);

    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") throw new Error("Expected a commit.");
    expect(committed.command).toBeNull();
    expect(engine.current()).toBeNull();

    expect(updated.lifecycleEvents).toHaveLength(1);
    expect(updated.lifecycleEvents[0]).toMatchObject({
      type: "objects.changed",
      gestureId: started.session.gestureId,
      changes: [{
        kind: "update",
        baseRevision: 3,
        baseCreatedAt: 1_000,
        operation: "edit",
        draft: {
          id: "text-1",
          kind: "text",
          content: "Committed text",
          color: "red",
        },
      }],
    });
    expect(committed.lifecycleEvents).toEqual([{
      type: "gesture.finish-requested",
      gestureId: started.session.gestureId,
      reason: "text-commit",
    }]);
    const draft = updated.lifecycleEvents[0]?.type === "objects.changed"
      ? updated.lifecycleEvents[0].changes[0]?.kind === "update"
        ? updated.lifecycleEvents[0].changes[0].draft
        : null
      : null;
    expect(draft).not.toHaveProperty("revision");
    expect(draft).not.toHaveProperty("createdAt");
    expect(draft).not.toHaveProperty("diagramIds");
  });

  it("maps a committed node label through the existing semantic edit controller", () => {
    const engine = new SemanticTextEditSessionEngine();
    const started = engine.begin(shapeObject());
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);

    expect(intentOf(lifecycle.dispatch(started.lifecycleEvent), "lease.acquire")).toEqual({
      type: "lease.acquire",
      gestureId: started.session.gestureId,
      targets: [{ objectId: "node-1", expectedRevision: 7, operation: "edit" }],
    });
    const updated = engine.updateDraft(started.session.token, "Accepted platform boundary");
    if (updated.status !== "updated") throw new Error("Expected an update.");
    const committed = engine.commit(started.session.token);
    if (committed.status !== "committed") throw new Error("Expected a commit.");
    expect(committed.command).toBeNull();

    const changed = updated.lifecycleEvents[0];
    if (changed.type !== "objects.changed") throw new Error("Expected a semantic change.");
    const schedule = intentOf(lifecycle.dispatch(changed), "sync.schedule");
    expect(schedule.edits[0]).toMatchObject({
      objectId: "node-1",
      kind: "update",
      baseRevision: 7,
      baseCreatedAt: 2_000,
      operation: "edit",
      draft: {
        kind: "shape",
        label: "Accepted platform boundary",
        nodeType: "decision",
        nodeMetadata: {
          kind: "decision",
          status: "accepted",
          owner: "Architecture",
          resolution: "Keep the first-party renderer.",
        },
      },
    });
    const pendingDraft = schedule.edits[0]?.kind === "update" ? schedule.edits[0].draft : null;
    expect(pendingDraft?.kind === "shape" ? pendingDraft.nodeMetadata : null)
      .not.toHaveProperty("resolvedAt");

    const finish = committed.lifecycleEvents[0];
    if (finish.type !== "gesture.finish-requested") throw new Error("Expected a finish event.");
    expect(intentOf(lifecycle.dispatch(finish), "gesture.settle")).toMatchObject({
      source: "text",
      reason: "text-commit",
      objectIds: ["node-1"],
    });
  });

  it("treats empty text and labels as valid commits exactly like the domain schemas", () => {
    for (const [object, field] of [
      [textObject(), "content"],
      [shapeObject(), "label"],
    ] as const) {
      const engine = new SemanticTextEditSessionEngine();
      const started = engine.begin(object);
      const updated = engine.updateDraft(started.session.token, "");
      expect(updated).toMatchObject({ status: "updated", session: { draftValue: "", dirty: true } });
      expect(updated.status === "updated" ? updated.lifecycleEvents : []).toMatchObject([{
        changes: [{ draft: { [field]: "" } }],
      }]);
      const committed = engine.commit(started.session.token);
      expect(committed.status).toBe("committed");
      if (committed.status !== "committed") throw new Error("Expected a commit.");
      expect(committed.command).toBeNull();
    }
  });

  it("uses the exact domain maximums without trimming or inventing a non-empty rule", () => {
    const textEngine = new SemanticTextEditSessionEngine();
    const text = textEngine.begin(textObject());
    const maxText = "t".repeat(SEMANTIC_TEXT_EDIT_LIMITS.content);
    expect(textEngine.updateDraft(text.session.token, maxText)).toMatchObject({ status: "updated" });
    expect(() => textEngine.updateDraft(text.session.token, `${maxText}t`)).toThrowError(
      expect.objectContaining({ code: "INVALID_VALUE" }),
    );

    const shapeEngine = new SemanticTextEditSessionEngine();
    const shape = shapeEngine.begin(shapeObject());
    const maxLabel = "l".repeat(SEMANTIC_TEXT_EDIT_LIMITS.label);
    expect(shapeEngine.updateDraft(shape.session.token, maxLabel)).toMatchObject({ status: "updated" });
    expect(() => shapeEngine.updateDraft(shape.session.token, `${maxLabel}l`)).toThrowError(
      expect.objectContaining({ code: "INVALID_VALUE" }),
    );

    const whitespaceEngine = new SemanticTextEditSessionEngine();
    const whitespace = whitespaceEngine.begin(textObject());
    const whitespaceUpdated = whitespaceEngine.updateDraft(whitespace.session.token, "  \n  ");
    const committed = whitespaceEngine.commit(whitespace.session.token);
    expect(whitespaceUpdated.status === "updated" ? whitespaceUpdated.lifecycleEvents : [])
      .toMatchObject([{ changes: [{ draft: { content: "  \n  " } }] }]);
    expect(committed.status === "committed" ? committed.command : undefined).toBeNull();
  });

  it("cancels explicitly, restores authority, and uses the dedicated recovery lifecycle", () => {
    const engine = new SemanticTextEditSessionEngine();
    const started = engine.begin(shapeObject());
    engine.updateDraft(started.session.token, "Discard me");

    const cancelled = engine.cancel(started.session.token);

    expect(cancelled).toEqual({
      status: "cancelled",
      session: {
        ...started.session,
        draftValue: "Semantic node",
        dirty: false,
      },
      signal: {
        type: "text-session.cancelled",
        gestureId: started.session.gestureId,
        objectId: "node-1",
        baseRevision: 7,
        baseCreatedAt: 2_000,
        restore: { field: "label", value: "Semantic node" },
      },
      command: null,
      lifecycleEvents: [{
        type: "gesture.cancel-requested",
        gestureId: started.session.gestureId,
        reason: "text-cancel",
      }],
    });
    expect(engine.current()).toBeNull();
  });

  it("fences superseded and terminal sessions without disturbing the active draft", () => {
    const engine = new SemanticTextEditSessionEngine();
    const older = engine.begin(textObject({ id: "older" }));
    engine.updateDraft(older.session.token, "Older local draft");

    const newer = engine.begin(shapeObject({ id: "newer" }));
    expect(newer.superseded).toMatchObject({
      status: "cancelled",
      session: { objectId: "older", draftValue: "Authoritative text", dirty: false },
      signal: { objectId: "older" },
    });
    expect(newer.session.token.fence).toBeGreaterThan(older.session.token.fence);

    expect(engine.updateDraft(older.session.token, "Late callback")).toEqual({
      status: "stale",
      token: older.session.token,
    });
    expect(engine.commit(older.session.token)).toEqual({ status: "stale", token: older.session.token });
    expect(engine.cancel(older.session.token)).toEqual({ status: "stale", token: older.session.token });
    expect(engine.current()).toBe(newer.session);

    engine.updateDraft(newer.session.token, "Newer local draft");
    expect(engine.commit(newer.session.token)).toMatchObject({ status: "committed" });
    expect(engine.commit(newer.session.token)).toEqual({ status: "stale", token: newer.session.token });
  });

  it("closes an unchanged explicit commit without creating a revision-bumping command", () => {
    const engine = new SemanticTextEditSessionEngine();
    const started = engine.begin(textObject());

    const committed = engine.commit(started.session.token);

    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") throw new Error("Expected a commit.");
    expect(committed.command).toBeNull();
    expect(committed.lifecycleEvents).toEqual([{
      type: "gesture.finish-requested",
      gestureId: started.session.gestureId,
      reason: "text-commit",
    }]);
  });

  it("edits connector labels and rejects drawings without a text field", () => {
    const engine = new SemanticTextEditSessionEngine();
    const connector = {
      ...base("connector"),
      kind: "connector",
      start: { x: 0, y: 0, objectId: null },
      end: { x: 100, y: 100, objectId: null },
      direction: "end",
      label: "Request",
      color: "black",
    } satisfies CanvasObject;

    const started = engine.begin(connector);
    const updated = engine.updateDraft(started.session.token, "Response");
    expect(updated).toMatchObject({
      status: "updated",
      session: { field: "label", draftValue: "Response" },
      lifecycleEvents: [{ changes: [{ draft: { kind: "connector", label: "Response" } }] }],
    });
    engine.commit(started.session.token);

    const draw = {
      ...base("draw-1"),
      kind: "draw",
      points: [{ x: 0, y: 0 }, { x: 20, y: 20 }],
      color: "black",
      size: "m",
    } satisfies CanvasObject;
    expect(() => engine.begin(draw)).toThrowError(
      expect.objectContaining<Partial<SemanticTextEditSessionError>>({ code: "NON_EDITABLE_OBJECT" }),
    );
  });

  it("edits image alt text but protects a directly locked image", () => {
    const engine = new SemanticTextEditSessionEngine();
    const image = {
      ...base("image-1"), kind: "image", url: "/api/rooms/room-1/assets/file.png",
      assetId: "asset-1", alt: "Before", mimeType: "image/png", sourceUrl: null, locked: false,
    } satisfies CanvasObject;
    const started = engine.begin(image);
    expect(engine.updateDraft(started.session.token, "After")).toMatchObject({
      status: "updated", session: { field: "alt", draftValue: "After" },
    });
    engine.commit(started.session.token);
    expect(() => engine.begin({ ...image, locked: true })).toThrowError(
      expect.objectContaining<Partial<SemanticTextEditSessionError>>({ code: "NON_EDITABLE_OBJECT" }),
    );
  });
});
