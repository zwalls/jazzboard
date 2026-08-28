import { describe, expect, it } from "vitest";

import type {
  ActorRef,
  CanvasObject,
  ConnectorObject,
  RoomState,
} from "@/lib/domain/types";

import { buildSemanticScene } from "./semantic-scene";
import {
  applySemanticSelectionIntent,
  hitTestSemanticScene,
  hitTestSemanticSceneObjects,
  normalizeSemanticSelectionBounds,
  querySemanticSceneBounds,
  selectionScreenPixelsToPageUnits,
  SemanticMarqueeSelectionSessionEngine,
  SemanticSelectionSessionError,
} from "./semantic-selection-session";

const ACTOR: ActorRef = {
  participantId: "selector",
  displayName: "Selector",
  color: "violet",
  kind: "human",
};

const BASE = {
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  rotation: 0,
  zIndex: 1,
  revision: 1,
  groupId: null,
  diagramIds: [],
  createdAt: 1,
  updatedAt: 1,
  createdBy: ACTOR,
  lastEditedBy: ACTOR,
};

function rectangle(id: string, overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    ...BASE,
    id,
    kind: "shape",
    shape: "rectangle",
    nodeType: null,
    label: id,
    fill: "white",
    stroke: "black",
    ...overrides,
  } as CanvasObject;
}

function ellipse(id: string, overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    ...rectangle(id, overrides),
    kind: "shape",
    shape: "ellipse",
  } as CanvasObject;
}

function diamond(id: string, overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    ...rectangle(id, overrides),
    kind: "shape",
    shape: "diamond",
  } as CanvasObject;
}

function text(id: string, overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    ...BASE,
    id,
    kind: "text",
    content: id,
    color: "black",
    size: "m",
    align: "middle",
    ...overrides,
  } as CanvasObject;
}

function image(id: string, locked: boolean, overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    ...BASE,
    id,
    kind: "image",
    url: `/images/${id}.png`,
    assetId: id,
    alt: id,
    mimeType: "image/png",
    sourceUrl: null,
    locked,
    ...overrides,
  } as CanvasObject;
}

function draw(id: string, overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    ...BASE,
    id,
    kind: "draw",
    width: 100,
    height: 1,
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    color: "black",
    size: "s",
    ...overrides,
  } as CanvasObject;
}

function connector(
  id: string,
  kind: "straight" | "curved" | "elbow",
  overrides: Partial<ConnectorObject> = {},
): ConnectorObject {
  return {
    ...BASE,
    id,
    kind: "connector",
    width: 120,
    height: 1,
    start: { x: 0, y: 0, objectId: null },
    end: { x: 120, y: 0, objectId: null },
    routing: {
      mode: kind,
      kind,
      bend: kind === "curved" ? 40 : 0,
      elbowMidPoint: 0.5,
      labelPosition: 0.5,
    },
    direction: "end",
    label: "",
    color: "black",
    ...overrides,
  };
}

function room(objects: readonly CanvasObject[]): RoomState {
  return {
    id: "room-selection",
    code: "SELECT",
    title: "Selection",
    stateRevision: 1,
    roomRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    participants: {},
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

describe("semantic selection hit testing", () => {
  it("returns the deterministic topmost overlap by z-index and semantic ID", () => {
    const scene = buildSemanticScene(room([
      rectangle("bottom", { zIndex: 1 }),
      rectangle("tie-a", { zIndex: 2 }),
      rectangle("tie-z", { zIndex: 2 }),
    ]));

    expect(hitTestSemanticSceneObjects(scene, { x: 20, y: 20 }, { zoom: 1 })
      .map((hit) => hit.objectId)).toEqual(["tie-z", "tie-a", "bottom"]);
    expect(hitTestSemanticScene(scene, { x: 20, y: 20 }, { zoom: 1 })?.objectId)
      .toBe("tie-z");
  });

  it("tests rotated rectangles in local space instead of their loose scene bounds", () => {
    const rotated = rectangle("rotated", {
      x: 20,
      y: 20,
      width: 120,
      height: 20,
      rotation: Math.PI / 4,
    });
    const scene = buildSemanticScene(room([rotated]));

    expect(hitTestSemanticScene(scene, { x: 80, y: 30 }, { zoom: 1, tolerancePx: 0 })?.objectId)
      .toBe("rotated");
    expect(hitTestSemanticScene(scene, { x: 35, y: 70 }, { zoom: 1, tolerancePx: 0 }))
      .toBeNull();
  });

  it("honors ellipse and diamond fills while keeping text and images rectangular", () => {
    const scene = buildSemanticScene(room([
      ellipse("oval", { x: 0, y: 0, zIndex: 1 }),
      diamond("decision", { x: 120, y: 0, zIndex: 2 }),
      text("copy", { x: 240, y: 0, zIndex: 3 }),
      image("photo", false, { x: 360, y: 0, zIndex: 4 }),
    ]));

    expect(hitTestSemanticScene(scene, { x: 3, y: 3 }, { zoom: 1, tolerancePx: 0 })).toBeNull();
    expect(hitTestSemanticScene(scene, { x: 150, y: 5 }, { zoom: 1, tolerancePx: 0 })).toBeNull();
    expect(hitTestSemanticScene(scene, { x: 245, y: 5 }, { zoom: 1, tolerancePx: 0 })?.objectId).toBe("copy");
    expect(hitTestSemanticScene(scene, { x: 365, y: 5 }, { zoom: 1, tolerancePx: 0 })?.objectId).toBe("photo");
  });

  it("converts screen tolerance by zoom for freehand stroke selection", () => {
    const scene = buildSemanticScene(room([draw("stroke")]));

    expect(hitTestSemanticScene(scene, { x: 50, y: 6 }, { zoom: 1, tolerancePx: 6 })?.objectId)
      .toBe("stroke");
    expect(hitTestSemanticScene(scene, { x: 50, y: 6 }, { zoom: 2, tolerancePx: 6 }))
      .toBeNull();
    expect(selectionScreenPixelsToPageUnits(8, 2)).toBe(4);
  });

  it("hits resolved straight, curved, and elbow connector geometry but not empty route bounds", () => {
    const scene = buildSemanticScene(room([
      connector("straight", "straight", { zIndex: 1 }),
      connector("curve", "curved", {
        zIndex: 2,
        start: { x: 0, y: 100, objectId: null },
        end: { x: 120, y: 100, objectId: null },
      }),
      connector("elbow", "elbow", {
        zIndex: 3,
        start: { x: 0, y: 200, objectId: null },
        end: { x: 120, y: 260, objectId: null },
      }),
    ]));
    const curvePoint = scene.connectorRoutes.curve.points[
      Math.floor(scene.connectorRoutes.curve.points.length / 2)
    ];
    const elbowPoint = scene.connectorRoutes.elbow.points[1];

    expect(hitTestSemanticScene(scene, { x: 40, y: 0 }, { zoom: 1, tolerancePx: 2 })?.objectId)
      .toBe("straight");
    expect(hitTestSemanticScene(scene, curvePoint, { zoom: 1, tolerancePx: 2 })?.objectId)
      .toBe("curve");
    expect(hitTestSemanticScene(scene, elbowPoint, { zoom: 1, tolerancePx: 2 })?.objectId)
      .toBe("elbow");
    const curveBounds = scene.connectorRoutes.curve.bounds;
    expect(hitTestSemanticScene(scene, {
      x: curveBounds.x + 4,
      y: curveBounds.y + curveBounds.height - 4,
    }, { zoom: 1, tolerancePx: 0 })).toBeNull();
  });

  it("treats connector labels as semantic hit regions", () => {
    const scene = buildSemanticScene(room([
      connector("labeled", "straight", { label: "calls" }),
    ]));
    const label = scene.connectorRoutes.labeled.labelBounds;
    if (!label) throw new Error("Expected connector label bounds.");

    expect(hitTestSemanticScene(scene, {
      x: label.x + label.width / 2,
      y: label.y + label.height / 2,
    }, { zoom: 1, tolerancePx: 0 })?.objectId).toBe("labeled");
  });

  it("expands a hit to its complete group in stable paint order", () => {
    const scene = buildSemanticScene(room([
      rectangle("later", { x: 200, zIndex: 3, groupId: "cluster" }),
      rectangle("first", { zIndex: 1, groupId: "cluster" }),
      connector("middle", "straight", { zIndex: 2, groupId: "cluster" }),
    ]));

    expect(hitTestSemanticScene(scene, { x: 10, y: 10 }, { zoom: 1 })?.selectionObjectIds)
      .toEqual(["first", "middle", "later"]);
    expect(hitTestSemanticScene(scene, { x: 10, y: 10 }, { zoom: 1, groupMode: "object" })?.selectionObjectIds)
      .toEqual(["first"]);
  });

  it("keeps locked images selectable unless a caller explicitly filters them", () => {
    const scene = buildSemanticScene(room([image("locked", true)]));

    expect(hitTestSemanticScene(scene, { x: 20, y: 20 }, { zoom: 1 })?.objectId).toBe("locked");
    expect(hitTestSemanticScene(scene, { x: 20, y: 20 }, {
      zoom: 1,
      lockedImages: "exclude",
    })).toBeNull();
  });
});

describe("semantic marquee geometry", () => {
  it("normalizes reverse drags and distinguishes intersect from contain", () => {
    const rotated = rectangle("rotated", {
      x: 20,
      y: 20,
      width: 100,
      height: 30,
      rotation: Math.PI / 4,
    });
    const scene = buildSemanticScene(room([rotated]));
    const bounds = normalizeSemanticSelectionBounds({ x: 90, y: 70 }, { x: 60, y: 40 });

    expect(bounds).toEqual({ x: 60, y: 40, width: 30, height: 30 });
    expect(querySemanticSceneBounds(scene, bounds, { mode: "intersect" })).toEqual(["rotated"]);
    expect(querySemanticSceneBounds(scene, bounds, { mode: "contain" })).toEqual([]);
  });

  it("selects ellipse intersections without accepting only-overlapping loose bounds", () => {
    const scene = buildSemanticScene(room([ellipse("oval", { width: 100, height: 60 })]));

    expect(querySemanticSceneBounds(scene, { x: 45, y: -5, width: 10, height: 10 }))
      .toEqual(["oval"]);
    expect(querySemanticSceneBounds(scene, { x: 0, y: 0, width: 4, height: 4 }))
      .toEqual([]);
    expect(querySemanticSceneBounds(scene, { x: -1, y: -1, width: 102, height: 62 }, { mode: "contain" }))
      .toEqual(["oval"]);
  });

  it("intersects freehand strokes and all resolved connector route kinds", () => {
    const scene = buildSemanticScene(room([
      draw("stroke", { y: 20, zIndex: 1 }),
      connector("straight", "straight", {
        zIndex: 2,
        start: { x: 0, y: 80, objectId: null },
        end: { x: 120, y: 80, objectId: null },
      }),
      connector("curve", "curved", {
        zIndex: 3,
        start: { x: 0, y: 140, objectId: null },
        end: { x: 120, y: 140, objectId: null },
      }),
      connector("elbow", "elbow", {
        zIndex: 4,
        start: { x: 0, y: 220, objectId: null },
        end: { x: 120, y: 280, objectId: null },
      }),
    ]));
    const curvePoint = scene.connectorRoutes.curve.points[
      Math.floor(scene.connectorRoutes.curve.points.length / 2)
    ];
    const elbowPoint = scene.connectorRoutes.elbow.points[1];

    expect(querySemanticSceneBounds(scene, { x: 30, y: 19, width: 5, height: 2 }, { groupMode: "object" }))
      .toEqual(["stroke"]);
    expect(querySemanticSceneBounds(scene, { x: 30, y: 79, width: 5, height: 2 }, { groupMode: "object" }))
      .toEqual(["straight"]);
    expect(querySemanticSceneBounds(scene, { x: curvePoint.x - 1, y: curvePoint.y - 1, width: 2, height: 2 }, { groupMode: "object" }))
      .toEqual(["curve"]);
    expect(querySemanticSceneBounds(scene, { x: elbowPoint.x - 1, y: elbowPoint.y - 1, width: 2, height: 2 }, { groupMode: "object" }))
      .toEqual(["elbow"]);
  });

  it("expands marquee group matches and preserves stable z-index/ID ordering", () => {
    const scene = buildSemanticScene(room([
      rectangle("solo", { x: 300, zIndex: 0 }),
      rectangle("group-b", { x: 200, zIndex: 2, groupId: "cluster" }),
      rectangle("group-a", { x: 0, zIndex: 2, groupId: "cluster" }),
    ]));

    expect(querySemanticSceneBounds(scene, { x: -10, y: -10, width: 120, height: 80 }))
      .toEqual(["group-a", "group-b"]);
    expect(querySemanticSceneBounds(scene, { x: -10, y: -10, width: 120, height: 80 }, {
      groupMode: "object",
    })).toEqual(["group-a"]);
  });

  it("does not mutate or reposition intentionally overlapping objects", () => {
    const overlapping = [rectangle("a"), rectangle("b", { zIndex: 2 })];
    const scene = buildSemanticScene(room(overlapping));
    const before = scene.objects.map(({ object }) => ({
      id: object.id,
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
    }));

    expect(querySemanticSceneBounds(scene, { x: 0, y: 0, width: 100, height: 60 }))
      .toEqual(["a", "b"]);
    expect(scene.objects.map(({ object }) => ({
      id: object.id,
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
    }))).toEqual(before);
  });
});

describe("semantic selection intent", () => {
  const scene = buildSemanticScene(room([
    rectangle("a", { zIndex: 1, groupId: "cluster" }),
    rectangle("b", { x: 150, zIndex: 2, groupId: "cluster" }),
    rectangle("c", { x: 300, zIndex: 3 }),
  ]));

  it("applies replace, additive, and atomic group-aware toggle intent", () => {
    expect(applySemanticSelectionIntent(scene, ["c"], ["a"], "replace"))
      .toEqual(["a", "b"]);
    expect(applySemanticSelectionIntent(scene, ["c"], ["a"], "add"))
      .toEqual(["a", "b", "c"]);
    expect(applySemanticSelectionIntent(scene, ["a"], ["b"], "toggle"))
      .toEqual([]);
    expect(applySemanticSelectionIntent(scene, ["c"], ["a"], "toggle"))
      .toEqual(["a", "b", "c"]);
  });
});

describe("SemanticMarqueeSelectionSessionEngine", () => {
  const scene = buildSemanticScene(room([
    rectangle("a", { x: 0, zIndex: 1, groupId: "cluster" }),
    rectangle("b", { x: 150, zIndex: 2, groupId: "cluster" }),
    image("locked", true, { x: 300, zIndex: 3 }),
  ]));

  it("produces frame-ready reverse-drag selection and finishes with the same token", () => {
    const engine = new SemanticMarqueeSelectionSessionEngine();
    const started = engine.begin(scene, {
      pointerStart: { x: 110, y: 70 },
      mode: "intersect",
      intent: "replace",
      sessionId: "marquee-a",
    });
    const updated = engine.updatePointer(started.session.token, { x: -10, y: -10 });
    expect(updated.status).toBe("updated");
    if (updated.status !== "updated") throw new Error("Expected marquee update.");
    expect(updated.session.bounds).toEqual({ x: -10, y: -10, width: 120, height: 80 });
    expect(updated.session.candidateObjectIds).toEqual(["a"]);
    expect(updated.session.targetObjectIds).toEqual(["a", "b"]);
    expect(updated.session.selectedObjectIds).toEqual(["a", "b"]);

    const finished = engine.finish(started.session.token);
    expect(finished.status).toBe("finished");
    if (finished.status !== "finished") throw new Error("Expected marquee finish.");
    expect(finished.session.phase).toBe("finished");
    expect(engine.getActiveSession()).toBeNull();
  });

  it("fences late updates and cancellation from a superseded session", () => {
    const engine = new SemanticMarqueeSelectionSessionEngine();
    const first = engine.begin(scene, { pointerStart: { x: 0, y: 0 }, sessionId: "first" });
    const second = engine.begin(scene, { pointerStart: { x: 200, y: 200 }, sessionId: "second" });

    expect(second.superseded?.session.phase).toBe("cancelled");
    expect(engine.updatePointer(first.session.token, { x: 100, y: 100 }).status).toBe("stale");
    expect(engine.cancel(first.session.token).status).toBe("stale");
    expect(engine.getActiveSession()?.token).toEqual(second.session.token);
  });

  it("restores the initial group-normalized selection on cancel", () => {
    const engine = new SemanticMarqueeSelectionSessionEngine();
    const started = engine.begin(scene, {
      pointerStart: { x: 290, y: -10 },
      selectedObjectIds: ["a"],
      intent: "replace",
    });
    engine.updatePointer(started.session.token, { x: 410, y: 70 });
    const cancelled = engine.cancel(started.session.token);

    expect(cancelled.status).toBe("cancelled");
    if (cancelled.status !== "cancelled") throw new Error("Expected cancellation.");
    expect(cancelled.selectedObjectIds).toEqual(["a", "b"]);
    expect(cancelled.session.selectedObjectIds).toEqual(["a", "b"]);
  });

  it("supports additive and toggle selection and selects locked images", () => {
    const additive = new SemanticMarqueeSelectionSessionEngine();
    const add = additive.begin(scene, {
      pointerStart: { x: 290, y: -10 },
      selectedObjectIds: ["a"],
      intent: "add",
    });
    const added = additive.finish(add.session.token, { x: 410, y: 70 });
    expect(added.status).toBe("finished");
    if (added.status !== "finished") throw new Error("Expected additive finish.");
    expect(added.session.selectedObjectIds).toEqual(["a", "b", "locked"]);

    const toggle = new SemanticMarqueeSelectionSessionEngine();
    const toggledStart = toggle.begin(scene, {
      pointerStart: { x: -10, y: -10 },
      selectedObjectIds: ["a", "locked"],
      intent: "toggle",
    });
    const toggled = toggle.finish(toggledStart.session.token, { x: 110, y: 70 });
    expect(toggled.status).toBe("finished");
    if (toggled.status !== "finished") throw new Error("Expected toggle finish.");
    expect(toggled.session.selectedObjectIds).toEqual(["locked"]);
  });

  it("keeps a zero-area marquee empty so click selection stays in the hit-test path", () => {
    const engine = new SemanticMarqueeSelectionSessionEngine();
    const started = engine.begin(scene, {
      pointerStart: { x: 20, y: 20 },
      selectedObjectIds: ["locked"],
      intent: "replace",
    });
    const finished = engine.finish(started.session.token);
    expect(finished.status).toBe("finished");
    if (finished.status !== "finished") throw new Error("Expected finish.");
    expect(finished.session.candidateObjectIds).toEqual([]);
    expect(finished.session.selectedObjectIds).toEqual([]);
  });
});

describe("semantic selection validation", () => {
  it("rejects invalid zoom, tolerance, points, and bounds", () => {
    expect(() => selectionScreenPixelsToPageUnits(8, 0)).toThrowError(
      expect.objectContaining<Partial<SemanticSelectionSessionError>>({ code: "INVALID_ZOOM" }),
    );
    expect(() => selectionScreenPixelsToPageUnits(-1, 1)).toThrowError(
      expect.objectContaining<Partial<SemanticSelectionSessionError>>({ code: "INVALID_TOLERANCE" }),
    );
    expect(() => normalizeSemanticSelectionBounds({ x: Number.NaN, y: 0 }, { x: 1, y: 1 }))
      .toThrowError(expect.objectContaining<Partial<SemanticSelectionSessionError>>({ code: "INVALID_POINT" }));
    expect(() => querySemanticSceneBounds(buildSemanticScene(room([])), {
      x: 0,
      y: 0,
      width: -1,
      height: 1,
    })).toThrowError(expect.objectContaining<Partial<SemanticSelectionSessionError>>({ code: "INVALID_BOUNDS" }));
  });
});
