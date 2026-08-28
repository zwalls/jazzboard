import { describe, expect, it } from "vitest";

import type { ActorRef, CanvasObject, ConnectorObject, DrawObject, RoomState } from "@/lib/domain/types";

import {
  applySemanticObjectStyles,
  groupSemanticObjects,
  orderSemanticObjects,
  semanticTransformFrameForObjects,
  SemanticTransformSessionEngine,
  SemanticTransformSessionError,
  ungroupSemanticObjects,
} from "./semantic-transform-session";

const actor: ActorRef = {
  participantId: "human-1",
  displayName: "Human",
  color: "blue",
  kind: "human",
};

function common(id: string, x: number, y: number, revision = 1) {
  return {
    id,
    x,
    y,
    width: 100,
    height: 50,
    rotation: 0,
    zIndex: 1,
    revision,
    groupId: null,
    diagramIds: [],
    createdAt: 100 + revision,
    updatedAt: 200 + revision,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function shape(id: string, x: number, y: number, revision = 1): CanvasObject {
  return {
    ...common(id, x, y, revision),
    kind: "shape",
    shape: "rectangle",
    nodeType: "service",
    nodeMetadata: null,
    label: id,
    fill: "blue",
    stroke: "black",
  };
}

function text(id: string, x: number, y: number): CanvasObject {
  return { ...common(id, x, y, 3), kind: "text", content: id, color: "black", size: "m", align: "start" };
}

function image(id: string, locked: boolean, groupId: string | null = null): CanvasObject {
  return { ...common(id, 0, 0), kind: "image", url: "https://example.com/image.png", assetId: null, alt: "old", mimeType: "image/png", sourceUrl: null, locked, groupId };
}

function connector(id: string): ConnectorObject {
  return {
    ...common(id, 0, 0, 4),
    kind: "connector",
    width: 100,
    height: 1,
    start: { x: 0, y: 25, objectId: null },
    end: { x: 100, y: 25, objectId: null },
    routing: { mode: "straight", kind: "straight", bend: 0, elbowMidPoint: 0.5, labelPosition: 0.5 },
    direction: "end",
    label: "edge",
    color: "black",
  };
}

function draw(id: string): DrawObject {
  return { ...common(id, 0, 0), kind: "draw", points: [{ x: 0, y: 0 }, { x: 100, y: 50 }], color: "red", size: "m" };
}

function room(objects: readonly CanvasObject[]): RoomState {
  return {
    id: "room-1",
    code: "1234",
    title: "Test",
    roomRevision: 9,
    stateRevision: 9,
    createdAt: 1,
    updatedAt: 2,
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
    participants: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function changed(result: { lifecycleEvents: readonly unknown[] }) {
  return result.lifecycleEvents.find((event) => (event as { type?: string }).type === "objects.changed") as {
    changes: Array<{ draft: CanvasObject; baseRevision: number; baseCreatedAt: number; operation: string }>;
  };
}

describe("SemanticTransformSessionEngine", () => {
  it("starts from the exact canonical frame exposed to selection controls", () => {
    const rotated = { ...shape("node", 10, 20), rotation: Math.PI / 3 };
    const frame = semanticTransformFrameForObjects([rotated]);
    const started = new SemanticTransformSessionEngine().begin({
      room: room([rotated]),
      mode: "resize",
      handle: "se",
      selectedObjectIds: ["node"],
      pointerStart: { x: 80.801270189, y: 100.801270189 },
    });
    if (started.status !== "started") throw new Error("not started");
    expect(frame).toEqual({ bounds: started.session.baseBounds, rotation: Math.PI / 3, localAxes: true });
    const unchanged = started.session.drafts.node!;
    expect(unchanged).toMatchObject({ x: 10, y: 20, width: 100, height: 50, rotation: Math.PI / 3 });
  });

  it("starts by synchronously protecting exact immutable identities", () => {
    const source = shape("node", 10, 20, 7);
    const result = new SemanticTransformSessionEngine().begin({ room: room([source]), mode: "resize", handle: "se", selectedObjectIds: ["node"], pointerStart: { x: 110, y: 70 } });
    expect(result.status).toBe("started");
    if (result.status !== "started") return;
    expect(result.lifecycleEvent).toEqual({ type: "gesture.started", gestureId: result.session.gestureId, source: "pointer", objects: [{ objectId: "node", baseRevision: 7, baseCreatedAt: 107, operation: "resize" }] });
  });

  it.each([
    ["nw", { x: -10, y: -5 }, { x: -10, y: -5, width: 120, height: 75 }],
    ["n", { x: 110, y: 5 }, { x: 10, y: 5, width: 100, height: 65 }],
    ["ne", { x: 130, y: 5 }, { x: 10, y: 5, width: 120, height: 65 }],
    ["e", { x: 130, y: 70 }, { x: 10, y: 20, width: 120, height: 50 }],
    ["se", { x: 130, y: 90 }, { x: 10, y: 20, width: 120, height: 70 }],
    ["s", { x: 110, y: 90 }, { x: 10, y: 20, width: 100, height: 70 }],
    ["sw", { x: 0, y: 90 }, { x: 0, y: 20, width: 110, height: 70 }],
    ["w", { x: 0, y: 70 }, { x: 0, y: 20, width: 110, height: 50 }],
  ] as const)("resizes from the %s handle using absolute page-space geometry", (handle, pointer, expected) => {
    const engine = new SemanticTransformSessionEngine();
    const started = engine.begin({ room: room([shape("node", 10, 20)]), mode: "resize", handle, selectedObjectIds: ["node"], pointerStart: handle.includes("w") ? { x: 10, y: handle.includes("n") ? 20 : 70 } : { x: 110, y: handle.includes("n") ? 20 : 70 } });
    if (started.status !== "started") throw new Error("not started");
    const updated = engine.updatePointer(started.session.token, pointer);
    if (updated.status !== "updated") throw new Error("not updated");
    expect(updated.session.bounds).toEqual(expected);
    expect(changed(updated).changes[0]!.draft).toMatchObject(expected);
  });

  it.each([
    ["nw", { x: -20, y: -10 }, "se"],
    ["n", { x: 0, y: -10 }, "s"],
    ["ne", { x: 20, y: -10 }, "sw"],
    ["e", { x: 20, y: 0 }, "w"],
    ["se", { x: 20, y: 10 }, "nw"],
    ["s", { x: 0, y: 10 }, "n"],
    ["sw", { x: -20, y: 10 }, "ne"],
    ["w", { x: -20, y: 0 }, "e"],
  ] as const)("resizes a rotated object from %s in local axes while preserving the opposite %s anchor", (handle, localDelta, opposite) => {
    const source = { ...shape("node", 10, 20), rotation: Math.PI / 2 };
    const localHandlePoint = (object: CanvasObject, value: string) => {
      const horizontal = value.includes("w") ? -object.width / 2 : value.includes("e") ? object.width / 2 : 0;
      const vertical = value.includes("n") ? -object.height / 2 : value.includes("s") ? object.height / 2 : 0;
      const cosine = Math.cos(object.rotation);
      const sine = Math.sin(object.rotation);
      return {
        x: object.x + object.width / 2 + horizontal * cosine - vertical * sine,
        y: object.y + object.height / 2 + horizontal * sine + vertical * cosine,
      };
    };
    const start = localHandlePoint(source, handle);
    const pageDelta = { x: -localDelta.y, y: localDelta.x };
    const engine = new SemanticTransformSessionEngine();
    const started = engine.begin({ room: room([source]), mode: "resize", handle, selectedObjectIds: ["node"], pointerStart: start });
    if (started.status !== "started") throw new Error("not started");
    const updated = engine.updatePointer(started.session.token, { x: start.x + pageDelta.x, y: start.y + pageDelta.y });
    if (updated.status !== "updated") throw new Error("not updated");
    const draft = updated.session.drafts.node! as CanvasObject;
    expect(draft.rotation).toBeCloseTo(source.rotation, 12);
    expect(localHandlePoint(draft, opposite).x).toBeCloseTo(localHandlePoint(source, opposite).x, 8);
    expect(localHandlePoint(draft, opposite).y).toBeCloseTo(localHandlePoint(source, opposite).y, 8);
    expect(draft.width).toBeCloseTo(source.width + (handle.includes("w") || handle.includes("e") ? 20 : 0));
    expect(draft.height).toBeCloseTo(source.height + (handle.includes("n") || handle.includes("s") ? 10 : 0));
  });

  it("optionally locks aspect ratio without moving the opposite corner", () => {
    const source = shape("node", 0, 0);
    const engine = new SemanticTransformSessionEngine();
    const started = engine.begin({ room: room([source]), mode: "resize", handle: "se", selectedObjectIds: ["node"], pointerStart: { x: 100, y: 50 } });
    if (started.status !== "started") throw new Error("not started");
    const updated = engine.updatePointer(started.session.token, { x: 130, y: 55 }, { lockAspectRatio: true });
    if (updated.status !== "updated") throw new Error("not updated");
    expect(updated.session.drafts.node).toMatchObject({ x: 0, y: 0, width: 130, height: 65 });
  });

  it("scales a multi-selection, drawing points, and connector endpoints as one cohort", () => {
    const engine = new SemanticTransformSessionEngine();
    const started = engine.begin({ room: room([shape("a", 0, 0), draw("ink"), connector("edge")]), mode: "resize", handle: "se", selectedObjectIds: ["a", "ink", "edge"], pointerStart: { x: 100, y: 50 } });
    if (started.status !== "started") throw new Error("not started");
    const updated = engine.updatePointer(started.session.token, { x: 200, y: 100 });
    if (updated.status !== "updated") throw new Error("not updated");
    expect(updated.session.drafts.ink).toMatchObject({ width: 200, height: 100, points: [{ x: 0, y: 0 }, { x: 200, y: 100 }] });
    expect(updated.session.drafts.edge).toMatchObject({ start: { x: 0, y: 50 }, end: { x: 200, y: 50 } });
  });

  it("resizes and rotates a drawing by its exact rendered points", () => {
    const ink = { ...draw("ink"), rotation: Math.PI / 2 };
    const resizeEngine = new SemanticTransformSessionEngine();
    const resize = resizeEngine.begin({ room: room([ink]), mode: "resize", handle: "se", selectedObjectIds: ["ink"], pointerStart: { x: 0, y: 100 } });
    if (resize.status !== "started") throw new Error("not started");
    expect(resize.session.baseBounds).toEqual({ x: -50, y: 0, width: 50, height: 100 });
    const resized = resizeEngine.updatePointer(resize.session.token, { x: 50, y: 200 });
    if (resized.status !== "updated") throw new Error("not updated");
    const resizedDraft = resized.session.drafts.ink! as Extract<CanvasObject, { kind: "draw" }>;
    const rendered = resizedDraft.points.map((point) => ({
      x: resizedDraft.x + point.x * Math.cos(resizedDraft.rotation) - point.y * Math.sin(resizedDraft.rotation),
      y: resizedDraft.y + point.x * Math.sin(resizedDraft.rotation) + point.y * Math.cos(resizedDraft.rotation),
    }));
    expect(rendered[0]!.x).toBeCloseTo(50, 8);
    expect(rendered[0]!.y).toBeCloseTo(0, 8);
    expect(rendered[1]!.x).toBeCloseTo(-50, 8);
    expect(rendered[1]!.y).toBeCloseTo(200, 8);

    const rotateEngine = new SemanticTransformSessionEngine();
    const rotate = rotateEngine.begin({ room: room([ink]), mode: "rotate", selectedObjectIds: ["ink"], pointerStart: { x: 0, y: 50 } });
    if (rotate.status !== "started") throw new Error("not started");
    const rotated = rotateEngine.updatePointer(rotate.session.token, { x: -25, y: 75 });
    if (rotated.status !== "updated") throw new Error("not updated");
    expect(rotated.session.drafts.ink).toMatchObject({ x: 25, y: 75, rotation: Math.PI });
  });

  it("protects newly affected semantic connectors before painting resized pixels", () => {
    const node = shape("node", 0, 0, 6);
    const edge = {
      ...connector("edge"),
      start: { x: 100, y: 25, objectId: "node", normalizedAnchor: { x: 1, y: 0.5 }, isPrecise: true },
      end: { x: 250, y: 25, objectId: null },
    };
    const engine = new SemanticTransformSessionEngine();
    const started = engine.begin({ room: room([node, edge]), mode: "resize", handle: "e", selectedObjectIds: ["node"], pointerStart: { x: 100, y: 25 } });
    if (started.status !== "started") throw new Error("not started");
    const first = engine.updatePointer(started.session.token, { x: 150, y: 25 });
    if (first.status !== "updated") throw new Error("not updated");
    expect(first.lifecycleEvents.map((event) => event.type)).toEqual(["gesture.dependencies-added", "objects.changed"]);
    expect(first.lifecycleEvents[0]).toMatchObject({ objects: [{ objectId: "edge", baseRevision: 4, baseCreatedAt: 104, operation: "connect" }] });
    const second = engine.updatePointer(started.session.token, { x: 175, y: 25 });
    if (second.status !== "updated") throw new Error("not updated");
    expect(second.lifecycleEvents.map((event) => event.type)).toEqual(["objects.changed"]);
  });

  it("keeps positive finite dimensions when a handle crosses the opposite edge", () => {
    const engine = new SemanticTransformSessionEngine();
    const started = engine.begin({ room: room([shape("a", 0, 0)]), mode: "resize", handle: "w", selectedObjectIds: ["a"], pointerStart: { x: 0, y: 25 } });
    if (started.status !== "started") throw new Error("not started");
    const updated = engine.updatePointer(started.session.token, { x: 500, y: 25 });
    if (updated.status !== "updated") throw new Error("not updated");
    expect(updated.session.bounds).toMatchObject({ x: 99, width: 1 });
    expect(updated.session.drafts.a!.width).toBe(1);
  });

  it("rotates object centers around the selection center and preserves relative rotations", () => {
    const a = shape("a", 0, 0);
    const b = shape("b", 200, 0);
    b.rotation = Math.PI / 6;
    const engine = new SemanticTransformSessionEngine();
    const started = engine.begin({ room: room([a, b]), mode: "rotate", selectedObjectIds: ["a", "b"], pointerStart: { x: 300, y: 25 } });
    if (started.status !== "started") throw new Error("not started");
    const center = { x: started.session.baseBounds.x + started.session.baseBounds.width / 2, y: started.session.baseBounds.y + started.session.baseBounds.height / 2 };
    const updated = engine.updatePointer(started.session.token, { x: center.x, y: center.y + 200 });
    if (updated.status !== "updated") throw new Error("not updated");
    expect(updated.session.rotationDelta).toBeCloseTo(Math.PI / 2);
    expect(updated.session.drafts.a!.rotation).toBeCloseTo(Math.PI / 2);
    expect(updated.session.drafts.b!.rotation).toBeCloseTo(Math.PI / 2 + Math.PI / 6);
  });

  it("treats pointer-cancel as a successful final flush and fences stale tokens", () => {
    const engine = new SemanticTransformSessionEngine();
    const first = engine.begin({ room: room([shape("a", 0, 0)]), mode: "resize", selectedObjectIds: ["a"], pointerStart: { x: 100, y: 50 } });
    if (first.status !== "started") throw new Error("not started");
    engine.updatePointer(first.session.token, { x: 120, y: 60 });
    const finished = engine.finish(first.session.token, "pointer-cancel");
    expect(finished.status).toBe("finished");
    if (finished.status === "finished") expect(finished.lifecycleEvents.at(-1)).toMatchObject({ type: "gesture.finish-requested", reason: "pointer-cancel" });
    expect(engine.updatePointer(first.session.token, { x: 130, y: 70 }).status).toBe("stale");
  });

  it("aborts renderer-local work without finish/change events and fences the session", () => {
    const engine = new SemanticTransformSessionEngine();
    const started = engine.begin({ room: room([shape("a", 0, 0)]), mode: "resize", selectedObjectIds: ["a"], pointerStart: { x: 100, y: 50 } });
    if (started.status !== "started") throw new Error("not started");
    engine.updatePointer(started.session.token, { x: 140, y: 80 });
    const aborted = engine.abort(started.session.token);
    expect(aborted).toMatchObject({ status: "aborted", session: { phase: "aborted" }, lifecycleEvents: [] });
    expect(engine.current()).toBeNull();
    expect(engine.finish(started.session.token, "pointer-up")).toEqual({ status: "stale", token: started.session.token });
  });

  it("blocks direct locked images while expanding a selected group atomically", () => {
    const locked = image("locked", true);
    const direct = new SemanticTransformSessionEngine().begin({ room: room([locked]), mode: "resize", selectedObjectIds: ["locked"], pointerStart: { x: 0, y: 0 } });
    expect(direct).toMatchObject({ status: "blocked", selectionReport: { lockedImageObjectIds: ["locked"] } });
    const groupedRoom = room([{ ...locked, groupId: "g" }, { ...shape("node", 120, 0), groupId: "g" }]);
    const grouped = new SemanticTransformSessionEngine().begin({ room: groupedRoom, mode: "resize", selectedObjectIds: ["node"], pointerStart: { x: 220, y: 50 } });
    expect(grouped.status === "started" && grouped.session.objectIds).toEqual(["locked", "node"]);
  });
});

describe("semantic transform one-shot operations", () => {
  it("updates only matching object kinds with full valid drafts and exact authority", () => {
    const source = text("text", 0, 0);
    const result = applySemanticObjectStyles({ room: room([source, shape("shape", 100, 0)]), gestureId: "style-1", objectIds: ["shape", "text"], patch: { kind: "text", color: "red", size: "xl", align: "middle" } });
    expect(result.targetObjectIds).toEqual(["text"]);
    expect(changed(result).changes[0]).toMatchObject({ baseRevision: 3, baseCreatedAt: 103, operation: "edit", draft: { id: "text", content: "text", color: "red", size: "xl", align: "middle" } });
    expect(result.lifecycleEvents.map((event) => (event as { type: string }).type)).toEqual(["gesture.started", "objects.changed", "gesture.finish-requested"]);
  });

  it("supports authoritative classification metadata and image alt/lock fields", () => {
    const classified = applySemanticObjectStyles({ room: room([shape("decision", 0, 0)]), gestureId: "classify", objectIds: ["decision"], patch: { kind: "shape", nodeType: "decision", nodeMetadata: { kind: "decision", status: "proposed", owner: "Ada", resolution: null } } });
    expect(changed(classified).changes[0]!.draft).toMatchObject({ nodeType: "decision", nodeMetadata: { kind: "decision", owner: "Ada" } });
    const picture = applySemanticObjectStyles({ room: room([image("photo", false)]), gestureId: "image", objectIds: ["photo"], patch: { kind: "image", alt: "A system map", locked: true } });
    expect(changed(picture).changes[0]!.draft).toMatchObject({ alt: "A system map", locked: true, url: "https://example.com/image.png" });
  });

  it("clears incompatible workflow metadata, preserves matching metadata, and supplies valid transition defaults", () => {
    const decision = {
      ...shape("node", 0, 0),
      nodeType: "decision" as const,
      nodeMetadata: { kind: "decision" as const, status: "accepted" as const, owner: "Ada", resolution: "Ship it", resolvedAt: 400 },
    };
    const preserve = applySemanticObjectStyles({ room: room([decision]), gestureId: "preserve", objectIds: ["node"], patch: { kind: "shape", fill: "green" } });
    expect(changed(preserve).changes[0]!.draft).toMatchObject({ nodeType: "decision", nodeMetadata: { kind: "decision", status: "accepted", owner: "Ada", resolution: "Ship it" } });
    expect((changed(preserve).changes[0]!.draft as Extract<CanvasObject, { kind: "shape" }>).nodeMetadata).not.toHaveProperty("resolvedAt");

    const toService = applySemanticObjectStyles({ room: room([decision]), gestureId: "service", objectIds: ["node"], patch: { kind: "shape", nodeType: "service" } });
    expect(changed(toService).changes[0]!.draft).toMatchObject({ nodeType: "service", nodeMetadata: null });

    const toQuestion = applySemanticObjectStyles({ room: room([decision]), gestureId: "question", objectIds: ["node"], patch: { kind: "shape", nodeType: "open_question" } });
    expect(changed(toQuestion).changes[0]!.draft).toMatchObject({ nodeType: "open_question", nodeMetadata: { kind: "open_question", status: "open", owner: null, resolution: null } });

    const explicit = applySemanticObjectStyles({ room: room([shape("fresh", 0, 0)]), gestureId: "explicit", objectIds: ["fresh"], patch: { kind: "shape", nodeType: "decision", nodeMetadata: { kind: "decision", status: "rejected", owner: null, resolution: "Too risky" } } });
    expect(changed(explicit).changes[0]!.draft).toMatchObject({ nodeType: "decision", nodeMetadata: { kind: "decision", status: "rejected", resolution: "Too risky" } });
  });

  it("styles connectors and drawings without changing their semantic geometry", () => {
    const edge = connector("edge");
    const ink = draw("ink");
    const edgeResult = applySemanticObjectStyles({ room: room([edge]), gestureId: "edge-style", objectIds: ["edge"], patch: { kind: "connector", color: "blue", direction: "both", routing: { mode: "elbow", elbowMidPoint: 0.25, labelPosition: 0.7 } } });
    expect(changed(edgeResult).changes[0]!.draft).toMatchObject({ color: "blue", direction: "both", start: edge.start, end: edge.end, routing: { mode: "elbow", kind: "elbow" } });
    const drawResult = applySemanticObjectStyles({ room: room([ink]), gestureId: "ink-style", objectIds: ["ink"], patch: { kind: "draw", color: "green", size: "l" } });
    expect(changed(drawResult).changes[0]!.draft).toMatchObject({ color: "green", size: "l", points: ink.points });
  });

  it("groups with caller-supplied stable identity and ungroups the complete resolved group", () => {
    const source = room([shape("b", 100, 0, 2), shape("a", 0, 0, 1), shape("outside", 300, 0)]);
    const grouped = groupSemanticObjects({ room: source, gestureId: "group", objectIds: ["b", "a"], groupId: "group_auth" });
    expect(grouped.targetObjectIds).toEqual(["a", "b"]);
    expect(changed(grouped).changes.map(({ draft }) => draft.groupId)).toEqual(["group_auth", "group_auth"]);
    const groupedObjects = Object.values(source.objects).map((object) => object.id === "outside" ? object : { ...object, groupId: "group_auth" });
    const ungrouped = ungroupSemanticObjects({ room: room(groupedObjects), gestureId: "ungroup", objectIds: ["a"] });
    expect(ungrouped.targetObjectIds).toEqual(["a", "b"]);
    expect(changed(ungrouped).changes.every(({ draft }) => draft.groupId === null)).toBe(true);
  });

  it("supports deterministic adjacent and exact z ordering with quiet boundary no-ops", () => {
    const source = room([
      { ...shape("a", 0, 0), zIndex: 5 },
      { ...shape("b", 100, 0), zIndex: 5 },
      { ...shape("c", 200, 0), zIndex: 6 },
    ]);
    const forward = orderSemanticObjects({ room: source, gestureId: "up", objectIds: ["a"], mode: "forward" });
    expect([...forward.targetObjectIds].sort()).toEqual(["a", "b"]);
    expect(changed(forward).changes.map(({ draft }) => ({ id: draft.id, zIndex: draft.zIndex }))).toEqual([
      { id: "b", zIndex: 5 },
      { id: "a", zIndex: 6 },
    ]);
    expect(changed(orderSemanticObjects({ room: source, gestureId: "exact", objectIds: ["a"], mode: "explicit", zIndexById: { a: 42 } })).changes[0]!.draft.zIndex).toBe(42);
    expect(orderSemanticObjects({ room: room([{ ...shape("a", 0, 0), zIndex: 0 }]), gestureId: "down", objectIds: ["a"], mode: "backward" })).toMatchObject({ status: "noop", lifecycleEvents: [] });
  });

  it("returns a quiet noop for absent IDs or identical style values", () => {
    const source = text("text", 0, 0);
    expect(applySemanticObjectStyles({ room: room([source]), gestureId: "same", objectIds: ["missing", "text"], patch: { kind: "text", color: "black" } })).toMatchObject({ status: "noop", targetObjectIds: [], lifecycleEvents: [] });
  });

  it("rejects invalid group identities and invalid kind-specific metadata", () => {
    expect(() => groupSemanticObjects({ room: room([shape("a", 0, 0)]), gestureId: "group", objectIds: ["a"], groupId: "" })).toThrow(SemanticTransformSessionError);
    expect(() => applySemanticObjectStyles({ room: room([shape("a", 0, 0)]), gestureId: "bad", objectIds: ["a"], patch: { kind: "shape", nodeType: "service", nodeMetadata: { kind: "decision", status: "proposed", owner: null, resolution: null } } })).toThrow(SemanticTransformSessionError);
  });
});
