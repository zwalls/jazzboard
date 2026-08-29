import { describe, expect, it } from "vitest";

import {
  AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
  type AgentCanvasDraftSnapshot,
  type AgentDraftCanvasObject,
} from "@/lib/agent-drafts/types";
import type { ActorRef, Point } from "@/lib/domain/types";

import {
  AGENT_DRAFT_CHOREOGRAPHY_LIMITS,
  AgentDraftChoreographyCoordinator,
  agentDraftObjectFingerprint,
  buildAgentDraftChoreographyPlan,
  type AgentDraftChoreographyPlan,
} from "./agent-draft-choreography";
import { projectAgentDraft } from "./agent-draft-projection";

const author: ActorRef = {
  participantId: "participant_agent",
  displayName: "Avery Builder",
  color: "#5965e8",
  kind: "agent",
};

function base(id: string, kind: AgentDraftCanvasObject["kind"], input: Partial<AgentDraftCanvasObject> = {}) {
  return {
    authority: "draft" as const,
    id,
    kind,
    x: 0,
    y: 0,
    width: 120,
    height: 70,
    rotation: 0,
    zIndex: 1,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: author,
    lastEditedBy: author,
    ...input,
  };
}

function shape(id: string, x: number, y: number, input: Partial<AgentDraftCanvasObject> = {}): AgentDraftCanvasObject {
  return {
    ...base(id, "shape", input),
    kind: "shape",
    x,
    y,
    shape: "rectangle",
    nodeType: null,
    label: id,
    fill: "light-blue",
    stroke: "blue",
  } as AgentDraftCanvasObject;
}

function draft(objects: AgentDraftCanvasObject[], input: Partial<AgentCanvasDraftSnapshot> = {}): AgentCanvasDraftSnapshot {
  return {
    schemaVersion: AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
    id: "draft_motion",
    roomId: "room_motion",
    ownerParticipantId: author.participantId,
    author,
    revision: 1,
    baselineRoomRevision: 4,
    status: "active",
    temporaryReferences: {},
    previewObjects: objects,
    previewDiagrams: [],
    metadata: null,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 50_000,
    hardExpiresAt: 100_000,
    awaitingReview: null,
    ...input,
  };
}

function build(objects: AgentDraftCanvasObject[], input: Partial<AgentCanvasDraftSnapshot> = {}) {
  return buildAgentDraftChoreographyPlan({
    authoritativeObjects: {},
    draft: draft(objects, input),
    fallbackPoint: { x: 400, y: 300 },
  });
}

function handPlan(input: {
  revision: number;
  targets: Array<{ id: string; fingerprint: string; from: Point; to: Point }>;
}): AgentDraftChoreographyPlan {
  return {
    draftId: "draft_motion",
    revision: input.revision,
    startPoint: { x: 0, y: 0 },
    targets: input.targets.map((target) => ({
      objectId: target.id,
      fingerprint: target.fingerprint,
      segments: [{
        phase: "outline",
        purpose: "work",
        objectId: target.id,
        fingerprint: target.fingerprint,
        points: [target.from, target.to],
        durationMs: 400,
      }],
    })),
    visibleObjectIds: input.targets.map((target) => target.id),
    visibleObjects: input.targets.map((target) => ({
      objectId: target.id,
      fingerprint: target.fingerprint,
    })),
    inspectionPoints: [{ x: 300, y: 160 }, { x: 320, y: 180 }],
    viewportZoom: 1,
  };
}

function frameDistance(left: Point, right: Point): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

describe("agent draft choreography planning", () => {
  it("uses stable preview order and canvas-generic geometry for shapes, text, draw, images, and connectors", () => {
    const left = shape("left", 20, 40, { rotation: Math.PI / 8 });
    const text = {
      ...base("text", "text", { x: 180, y: 50, width: 150, height: 60 }),
      kind: "text" as const,
      content: "General canvas note",
      color: "black",
      size: "m" as const,
      align: "start" as const,
    } as AgentDraftCanvasObject;
    const drawing = {
      ...base("drawing", "draw", { x: 360, y: 80, rotation: Math.PI / 2 }),
      kind: "draw" as const,
      points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 25 }],
      color: "red",
      size: "m" as const,
    } as AgentDraftCanvasObject;
    const image = {
      ...base("image", "image", { x: 500, y: 40 }),
      kind: "image" as const,
      url: "https://example.com/image.png",
      assetId: null,
      alt: "A freeform reference image",
      mimeType: "image/png",
      sourceUrl: null,
      locked: false,
    } as AgentDraftCanvasObject;
    const right = shape("right", 700, 40);
    const connector = {
      ...base("connector", "connector", { width: 1, height: 1, zIndex: 9 }),
      kind: "connector" as const,
      start: { x: 140, y: 75, objectId: "left" },
      end: { x: 700, y: 75, objectId: "right" },
      routing: { mode: "curved" as const, kind: "curved" as const, bend: 70, elbowMidPoint: 0.5, labelPosition: 0.5 },
      direction: "end" as const,
      label: "freeform relationship",
      color: "blue",
    } as AgentDraftCanvasObject;
    const source = [left, text, drawing, image, right, connector];
    const untouched = structuredClone(source);
    const plan = build(source);

    expect(plan.startPoint).toEqual({ x: 400, y: 300 });
    expect(plan.targets.map((target) => target.objectId)).toEqual(source.map((object) => object.id));
    expect(plan.targets.map((target) => target.segments.map((segment) => segment.phase))).toEqual([
      ["outline", "label"],
      ["label"],
      ["trace"],
      ["outline", "label"],
      ["outline", "label"],
      ["trace", "label"],
    ]);
    const drawTrace = plan.targets[2]!.segments[0]!;
    expect(drawTrace.points[0]).toEqual({ x: 360, y: 80 });
    expect(drawTrace.points[1]!.x).toBeCloseTo(360);
    expect(drawTrace.points[1]!.y).toBeCloseTo(110);
    expect(plan.targets.at(-1)!.segments[0]!.points.length).toBeGreaterThan(7);
    expect(source).toEqual(untouched);
  });

  it("keeps stable narrative anchors while prioritizing recent work on a maximum-sized canvas", () => {
    const objects = Array.from({ length: 200 }, (_, index) => shape(
      `shape_${index}`,
      (index % 20) * 150,
      Math.floor(index / 20) * 100,
    ));
    const plan = build(objects);

    expect(plan.targets).toHaveLength(AGENT_DRAFT_CHOREOGRAPHY_LIMITS.maxTargets);
    expect(plan.targets[0]!.objectId).toBe("shape_0");
    expect(plan.targets[11]!.objectId).toBe("shape_11");
    expect(plan.targets[12]!.objectId).toBe("shape_164");
    expect(plan.targets.at(-1)!.objectId).toBe("shape_199");
    expect(Math.max(...plan.targets.flatMap((target) => target.segments.map((segment) => segment.points.length))))
      .toBeLessThanOrEqual(AGENT_DRAFT_CHOREOGRAPHY_LIMITS.maxPointsPerPath);

    const edited = [...objects];
    edited[100] = shape("shape_100", 0, 500, { updatedAt: 50, revision: 2 });
    expect(build(edited).targets.map((target) => target.objectId)).toContain("shape_100");
  });

  it("does not build discarded target geometry beyond the animation cap", () => {
    const objects = Array.from({ length: AGENT_DRAFT_CHOREOGRAPHY_LIMITS.maxTargets + 1 }, (_, index) => shape(
      `shape_${index}`,
      (index % 10) * 150,
      Math.floor(index / 10) * 100,
    ));
    // With 49 equal-recency objects, the stable anchors retain 0-11 and the
    // recent-work budget retains 13-48, making index 12 the one overflow item.
    const overflow = objects[12]!;
    let widthReads = 0;
    Object.defineProperty(overflow, "width", {
      configurable: true,
      enumerable: true,
      get() {
        widthReads += 1;
        return 120;
      },
    });
    const candidate = draft(objects);
    const authoritativeObjects = {};
    const authoritativeDiagrams = {};
    // Warm the shared projection so the counter below isolates choreography
    // planning rather than semantic-scene bounds calculation.
    projectAgentDraft(candidate, authoritativeObjects, authoritativeDiagrams);
    const expectedFingerprint = agentDraftObjectFingerprint(overflow);
    widthReads = 0;

    const plan = buildAgentDraftChoreographyPlan({
      authoritativeDiagrams,
      authoritativeObjects,
      draft: candidate,
      fallbackPoint: { x: 400, y: 300 },
    });

    expect(plan.targets).toHaveLength(AGENT_DRAFT_CHOREOGRAPHY_LIMITS.maxTargets);
    expect(plan.targets.map((target) => target.objectId)).not.toContain(overflow.id);
    expect(plan.visibleObjects).toContainEqual({
      objectId: overflow.id,
      fingerprint: expectedFingerprint,
    });
    // One read produces the lightweight visual fingerprint. Constructing a
    // discarded outline/label target would read width several more times.
    expect(widthReads).toBe(1);
  });

  it("visits newly appended work when cumulative drafts grow past the cap", () => {
    const objects = Array.from({ length: 51 }, (_, index) => shape(
      `stable_${index}`,
      (index % 10) * 140,
      Math.floor(index / 10) * 100,
    ));
    const coordinator = new AgentDraftChoreographyCoordinator();
    const at49 = build(objects.slice(0, 49), { revision: 49 });
    coordinator.finish(at49);

    const at50 = coordinator.accept(build(objects.slice(0, 50), { revision: 50 }), 1_000);
    const at51 = coordinator.accept(build(objects, { revision: 51 }), 1_000);
    expect(at50.active).toBe(true);
    expect(at51.active).toBe(true);

    const observed = new Set<string>();
    for (let now = 1_000; now <= 9_000; now += 40) {
      const frame = coordinator.sample(now);
      if (frame.objectId) observed.add(frame.objectId);
      if (!frame.active) break;
    }
    expect(observed).toContain("stable_49");
    expect(observed).toContain("stable_50");
  });

  it("detects same-length freehand edits outside the sampled trace points", () => {
    const points = Array.from({ length: 80 }, (_, index) => ({ x: index * 3, y: index % 7 }));
    const drawing = {
      ...base("freehand", "draw", { x: 40, y: 80 }),
      kind: "draw" as const,
      points,
      color: "red",
      size: "m" as const,
    } as AgentDraftCanvasObject;
    const changed = structuredClone(drawing);
    if (changed.kind !== "draw") throw new Error("Expected draw object");
    changed.points[1] = { x: changed.points[1]!.x, y: 123 };

    const before = build([drawing]).targets[0]!;
    const after = build([changed]).targets[0]!;
    expect(after.segments[0]!.points).toEqual(before.segments[0]!.points);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("uses the live viewport zoom to keep ordinary screen-space movement readable", () => {
    const candidate = draft([shape("zoomed", 100, 100)]);
    const atOne = buildAgentDraftChoreographyPlan({
      authoritativeObjects: {},
      draft: candidate,
      fallbackPoint: { x: 0, y: 0 },
      viewportZoom: 1,
    });
    const atEight = buildAgentDraftChoreographyPlan({
      authoritativeObjects: {},
      draft: candidate,
      fallbackPoint: { x: 0, y: 0 },
      viewportZoom: 8,
    });

    expect(atEight.targets[0]!.segments[0]!.durationMs)
      .toBeGreaterThan(atOne.targets[0]!.segments[0]!.durationMs);
    expect(atEight.viewportZoom).toBe(8);
  });
});

describe("AgentDraftChoreographyCoordinator", () => {
  it("reports every skipped reveal boundary when a coarse frame drains multiple phases", () => {
    const coordinator = new AgentDraftChoreographyCoordinator();
    const plan = build([shape("labeled", 120, 140)]);
    const target = plan.targets[0]!;

    coordinator.accept(plan, 0);
    expect(coordinator.drainRevealEvents()).toEqual([]);
    expect(coordinator.sample(20_000).active).toBe(false);

    expect(coordinator.drainRevealEvents()).toEqual([
      {
        type: "phase-complete",
        objectId: "labeled",
        fingerprint: target.fingerprint,
        phase: "outline",
      },
      {
        type: "phase-complete",
        objectId: "labeled",
        fingerprint: target.fingerprint,
        phase: "label",
      },
      {
        type: "object-complete",
        objectId: "labeled",
        fingerprint: target.fingerprint,
        phase: "label",
      },
    ]);
    expect(coordinator.drainRevealEvents()).toEqual([]);
  });

  it("finishes every visible object, including work omitted from the playback target budget", () => {
    const coordinator = new AgentDraftChoreographyCoordinator();
    const plan: AgentDraftChoreographyPlan = {
      ...handPlan({
        revision: 1,
        targets: [{ id: "scheduled", fingerprint: "scheduled:1", from: { x: 0, y: 0 }, to: { x: 80, y: 0 } }],
      }),
      visibleObjectIds: ["scheduled", "unscheduled"],
      visibleObjects: [
        { objectId: "scheduled", fingerprint: "scheduled:1" },
        { objectId: "unscheduled", fingerprint: "unscheduled:1" },
      ],
    };

    coordinator.finish(plan);

    expect(coordinator.drainRevealEvents()).toEqual([
      {
        type: "object-complete",
        objectId: "scheduled",
        fingerprint: "scheduled:1",
        phase: null,
      },
      {
        type: "object-complete",
        objectId: "unscheduled",
        fingerprint: "unscheduled:1",
        phase: null,
      },
    ]);
  });

  it("bridges outline, label, travel, and inspection phases without a boundary jump", () => {
    const plan = build([shape("labeled", 120, 140)]);
    const coordinator = new AgentDraftChoreographyCoordinator();
    let previous = coordinator.accept(plan, 0);
    const observedPhases = new Set([previous.phase]);
    let maximumStep = 0;
    for (let now = 16; now <= 6_000; now += 16) {
      const current = coordinator.sample(now);
      observedPhases.add(current.phase);
      maximumStep = Math.max(maximumStep, frameDistance(previous.pagePoint, current.pagePoint));
      previous = current;
      if (!current.active) break;
    }

    expect(observedPhases).toEqual(new Set(["travel", "outline", "label", "inspect"]));
    expect(maximumStep).toBeLessThan(20);
  });

  it("moves continuously, appends only new stable IDs, and never snaps on cumulative replacement", () => {
    const coordinator = new AgentDraftChoreographyCoordinator();
    const first = handPlan({
      revision: 1,
      targets: [{ id: "a", fingerprint: "a:1", from: { x: 40, y: 20 }, to: { x: 120, y: 20 } }],
    });
    const initial = coordinator.accept(first, 0);
    const moving = coordinator.sample(100);
    expect(initial.active).toBe(true);
    expect(frameDistance(initial.pagePoint, moving.pagePoint)).toBeGreaterThan(0);

    const beforeReplacement = coordinator.sample(180);
    const second = handPlan({
      revision: 2,
      targets: [
        { id: "a", fingerprint: "a:1", from: { x: 40, y: 20 }, to: { x: 120, y: 20 } },
        { id: "b", fingerprint: "b:1", from: { x: 180, y: 80 }, to: { x: 260, y: 80 } },
      ],
    });
    const afterReplacement = coordinator.accept(second, 180);
    expect(frameDistance(beforeReplacement.pagePoint, afterReplacement.pagePoint)).toBeLessThan(0.001);

    const observedObjectIds = new Set<string>();
    for (let now = 220; now <= 8_000; now += 40) {
      const frame = coordinator.sample(now);
      if (frame.objectId) observedObjectIds.add(frame.objectId);
      if (!frame.active) break;
    }
    expect(observedObjectIds).toContain("b");

    const settled = coordinator.sample(20_000);
    const third = handPlan({
      revision: 3,
      targets: [
        { id: "a", fingerprint: "a:1", from: { x: 40, y: 20 }, to: { x: 120, y: 20 } },
        { id: "b", fingerprint: "b:1", from: { x: 180, y: 80 }, to: { x: 260, y: 80 } },
        { id: "c", fingerprint: "c:1", from: { x: 320, y: 140 }, to: { x: 380, y: 140 } },
      ],
    });
    const resumed = coordinator.accept(third, 20_000);
    expect(frameDistance(settled.pagePoint, resumed.pagePoint)).toBeLessThan(0.001);
    const replayed = new Set<string>();
    for (let now = 20_040; now <= 26_000; now += 40) {
      const frame = coordinator.sample(now);
      if (frame.objectId) replayed.add(frame.objectId);
      if (!frame.active) break;
    }
    expect(replayed).toEqual(new Set(["c"]));
  });

  it("bridges from the current pose when an existing object changes and can finish without animation", () => {
    const coordinator = new AgentDraftChoreographyCoordinator();
    const first = handPlan({
      revision: 1,
      targets: [{ id: "a", fingerprint: "a:1", from: { x: 40, y: 20 }, to: { x: 120, y: 20 } }],
    });
    coordinator.accept(first, 0);
    const before = coordinator.sample(200);
    const moved = handPlan({
      revision: 2,
      targets: [{ id: "a", fingerprint: "a:2", from: { x: 500, y: 300 }, to: { x: 600, y: 300 } }],
    });
    const accepted = coordinator.accept(moved, 200);
    expect(frameDistance(before.pagePoint, accepted.pagePoint)).toBeLessThan(0.001);
    expect(accepted.pagePoint).not.toEqual({ x: 500, y: 300 });

    const finished = coordinator.finish(moved);
    expect(finished).toMatchObject({ phase: "inspect", phaseProgress: 1, active: false });
    expect(finished.pagePoint).toEqual(moved.inspectionPoints.at(-1));
  });

  it("re-anchors retained work when the active target disappears", () => {
    const coordinator = new AgentDraftChoreographyCoordinator();
    const first = handPlan({
      revision: 1,
      targets: [
        { id: "a", fingerprint: "a:1", from: { x: 40, y: 20 }, to: { x: 120, y: 20 } },
        { id: "b", fingerprint: "b:1", from: { x: 800, y: 300 }, to: { x: 900, y: 300 } },
      ],
    });
    coordinator.accept(first, 0);
    const before = coordinator.sample(160);
    const withoutActive = handPlan({
      revision: 2,
      targets: [
        { id: "b", fingerprint: "b:1", from: { x: 800, y: 300 }, to: { x: 900, y: 300 } },
      ],
    });
    const accepted = coordinator.accept(withoutActive, 160);

    expect(frameDistance(before.pagePoint, accepted.pagePoint)).toBeLessThan(0.001);
    let previous = accepted;
    let maximumStep = 0;
    for (let now = 176; now <= 5_000; now += 16) {
      const current = coordinator.sample(now);
      maximumStep = Math.max(maximumStep, frameDistance(previous.pagePoint, current.pagePoint));
      previous = current;
      if (!current.active) break;
    }
    expect(maximumStep).toBeLessThan(30);
  });

  it("preserves the current pose when live zoom changes rescale active playback", () => {
    const coordinator = new AgentDraftChoreographyCoordinator();
    const candidate = handPlan({
      revision: 1,
      targets: [{ id: "zoom", fingerprint: "zoom:1", from: { x: 100, y: 80 }, to: { x: 500, y: 80 } }],
    });
    coordinator.accept(candidate, 0);
    const before = coordinator.sample(160);
    const accepted = coordinator.accept({ ...candidate, viewportZoom: 8 }, 160);

    expect(frameDistance(before.pagePoint, accepted.pagePoint)).toBeLessThan(0.001);
    expect(coordinator.sample(176).pagePoint).not.toEqual(candidate.startPoint);
  });

  it("keeps even extremely distant queued work inside the hard playback budget", () => {
    const coordinator = new AgentDraftChoreographyCoordinator();
    const distant = handPlan({
      revision: 1,
      targets: Array.from({ length: 60 }, (_, index) => ({
        id: `far-${index}`,
        fingerprint: `far-${index}:1`,
        from: { x: index * 1_000_000, y: index * 200_000 },
        to: { x: index * 1_000_000 + 80, y: index * 200_000 },
      })),
    });
    const firstFrame = coordinator.accept(distant, 0);

    expect(firstFrame.objectId).toBe("far-12");
    expect(coordinator.sample(AGENT_DRAFT_CHOREOGRAPHY_LIMITS.maxQueuedDurationMs + 1).active)
      .toBe(false);
  });
});
