import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import type { ResolvedConnectorRoute } from "@/lib/domain/connector-routing";
import type {
  CanvasObject,
  Diagram,
  DrawObject,
  Point,
} from "@/lib/domain/types";
import { flattenVectorPath } from "@/lib/domain/vector-path";

import { projectAgentDraft } from "./agent-draft-projection";
import { CANVAS_ZOOM_LIMITS } from "./camera";

export const AGENT_DRAFT_CHOREOGRAPHY_LIMITS = {
  // A semantic transaction accepts at most 200 operations, so retaining 200
  // presentation targets guarantees that every object in one accepted draft
  // candidate can receive construction choreography. This remains bounded by
  // the same product-level transaction ceiling rather than an unrelated,
  // smaller animation cap.
  maxTargets: 200,
  maxPointsPerPath: 20,
  maxQueuedDurationMs: 7_000,
  minimumSegmentDurationMs: 40,
  travelSpeed: 760,
  traceSpeed: 520,
} as const;

export type AgentDraftChoreographyPhase =
  | "travel"
  | "outline"
  | "trace"
  | "label"
  | "inspect";

export type AgentDraftChoreographySegment = Readonly<{
  phase: AgentDraftChoreographyPhase;
  purpose: "work" | "inspection";
  objectId: string | null;
  fingerprint: string | null;
  points: readonly Point[];
  durationMs: number;
}>;

export type AgentDraftChoreographyTarget = Readonly<{
  objectId: string;
  fingerprint: string;
  segments: readonly AgentDraftChoreographySegment[];
}>;

export type AgentDraftChoreographyPlan = Readonly<{
  draftId: string;
  revision: number;
  startPoint: Point;
  targets: readonly AgentDraftChoreographyTarget[];
  visibleObjectIds: readonly string[];
  visibleObjects?: readonly Readonly<{ objectId: string; fingerprint: string }>[];
  inspectionPoints: readonly Point[];
  viewportZoom: number;
}>;

export type AgentDraftChoreographyFrame = Readonly<{
  pagePoint: Point;
  phase: AgentDraftChoreographyPhase;
  objectId: string | null;
  fingerprint: string | null;
  phaseProgress: number;
  active: boolean;
}>;

export type AgentDraftRevealEvent = Readonly<{
  type: "phase-complete" | "object-complete";
  objectId: string;
  fingerprint: string | null;
  phase: Exclude<AgentDraftChoreographyPhase, "travel" | "inspect"> | null;
}>;

type ActiveSegment = {
  segment: AgentDraftChoreographySegment;
  startedAt: number;
};

const EPSILON = 0.001;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function safeViewportZoom(value: number | undefined): number {
  return clamp(
    Number.isFinite(value) ? value! : 1,
    CANVAS_ZOOM_LIMITS.min,
    CANVAS_ZOOM_LIMITS.max,
  );
}

function distance(left: Point, right: Point): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1]!, points[index]!);
  }
  return total;
}

function pointAlongPath(points: readonly Point[], progress: number): Point {
  if (!points.length) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0]! };
  const total = pathLength(points);
  if (total <= EPSILON) return { ...points.at(-1)! };
  let remaining = clamp(progress, 0, 1) * total;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    const length = distance(from, to);
    if (remaining <= length || index === points.length - 1) {
      const ratio = length <= EPSILON ? 1 : remaining / length;
      return {
        x: from.x + (to.x - from.x) * ratio,
        y: from.y + (to.y - from.y) * ratio,
      };
    }
    remaining -= length;
  }
  return { ...points.at(-1)! };
}

function easeInOutSine(progress: number): number {
  const value = clamp(progress, 0, 1);
  return -(Math.cos(Math.PI * value) - 1) / 2;
}

function rotateAround(point: Point, origin: Point, rotation: number): Point {
  if (!rotation) return { ...point };
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return {
    x: origin.x + dx * cosine - dy * sine,
    y: origin.y + dx * sine + dy * cosine,
  };
}

function rotateObjectPoint(object: CanvasObject, point: Point): Point {
  return rotateAround(point, {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2,
  }, object.rotation);
}

function drawWorldPoint(object: DrawObject, point: Point): Point {
  const rotated = rotateAround(point, { x: 0, y: 0 }, object.rotation);
  return { x: object.x + rotated.x, y: object.y + rotated.y };
}

function downsample(points: readonly Point[], maximum = AGENT_DRAFT_CHOREOGRAPHY_LIMITS.maxPointsPerPath): Point[] {
  if (points.length <= maximum) return points.map((point) => ({ ...point }));
  const selected: Point[] = [];
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round(index * (points.length - 1) / (maximum - 1));
    selected.push({ ...points[sourceIndex]! });
  }
  return selected;
}

function pointStreamFingerprint(points: readonly Point[]): string {
  // Scan every point so same-length edits between sampled points are observable,
  // while retaining constant memory and avoiding a full serialized point array.
  let hash = 0x811c9dc5;
  const mix = (value: number) => {
    hash ^= Math.round(value * 1_000) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const point of points) {
    mix(point.x);
    mix(point.y);
  }
  mix(points.length);
  return hash.toString(36);
}

function rectanglePath(object: CanvasObject): Point[] {
  return [
    { x: object.x, y: object.y },
    { x: object.x + object.width, y: object.y },
    { x: object.x + object.width, y: object.y + object.height },
    { x: object.x, y: object.y + object.height },
    { x: object.x, y: object.y },
  ].map((point) => rotateObjectPoint(object, point));
}

function shapeOutline(object: Extract<CanvasObject, { kind: "shape" }>): Point[] {
  if (object.shape === "ellipse") {
    const center = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
    return Array.from({ length: 13 }, (_, index) => {
      const angle = -Math.PI / 2 + index / 12 * Math.PI * 2;
      return rotateAround({
        x: center.x + Math.cos(angle) * object.width / 2,
        y: center.y + Math.sin(angle) * object.height / 2,
      }, center, object.rotation);
    });
  }
  if (object.shape === "diamond") {
    return [
      { x: object.x + object.width / 2, y: object.y },
      { x: object.x + object.width, y: object.y + object.height / 2 },
      { x: object.x + object.width / 2, y: object.y + object.height },
      { x: object.x, y: object.y + object.height / 2 },
      { x: object.x + object.width / 2, y: object.y },
    ].map((point) => rotateObjectPoint(object, point));
  }
  return rectanglePath(object);
}

function labelSweep(object: CanvasObject): Point[] {
  const inset = Math.min(18, Math.max(5, object.width * 0.08));
  const y = object.y + object.height / 2;
  return [
    { x: object.x + inset, y },
    { x: object.x + object.width - inset, y },
  ].map((point) => rotateObjectPoint(object, point));
}

function curvedRoutePoints(route: ResolvedConnectorRoute): Point[] {
  if (!route.arc) return downsample(route.points);
  const sampleCount = Math.min(
    AGENT_DRAFT_CHOREOGRAPHY_LIMITS.maxPointsPerPath,
    Math.max(8, Math.ceil(Math.abs(route.arc.sweepAngle) / (Math.PI / 12)) + 1),
  );
  return Array.from({ length: sampleCount }, (_, index) => {
    const angle = route.arc!.startAngle + route.arc!.sweepAngle * index / (sampleCount - 1);
    return {
      x: route.arc!.center.x + Math.cos(angle) * route.arc!.radius,
      y: route.arc!.center.y + Math.sin(angle) * route.arc!.radius,
    };
  });
}

function labelSegment(
  object: CanvasObject,
  points: readonly Point[],
  fingerprint: string,
  viewportZoom: number,
): AgentDraftChoreographySegment {
  return {
    phase: "label",
    purpose: "work",
    objectId: object.id,
    fingerprint,
    points,
    durationMs: clamp(pathLength(points) * viewportZoom / 360 * 1_000, 180, 1_200),
  };
}

function segment(
  phase: Exclude<AgentDraftChoreographyPhase, "travel" | "inspect">,
  object: CanvasObject,
  points: readonly Point[],
  fingerprint: string,
  viewportZoom: number,
): AgentDraftChoreographySegment {
  return {
    phase,
    purpose: "work",
    objectId: object.id,
    fingerprint,
    points,
    durationMs: clamp(
      pathLength(points) * viewportZoom / AGENT_DRAFT_CHOREOGRAPHY_LIMITS.traceSpeed * 1_000,
      240,
      4_000,
    ),
  };
}

export function agentDraftObjectFingerprint(
  object: CanvasObject,
  route?: ResolvedConnectorRoute,
): string {
  const kindState = object.kind === "shape"
    ? [object.shape, object.label, object.fill, object.stroke]
    : object.kind === "text"
      ? [object.content, object.color, object.size, object.align]
      : object.kind === "connector"
        ? [object.start, object.end, object.routing, object.direction, object.label, object.color]
      : object.kind === "image"
          ? [object.assetId, object.url, object.alt, object.locked]
          : object.kind === "path"
            ? [object.start, object.segments, object.closed, object.fill, object.stroke, object.strokeWidth, object.opacity, object.lineCap, object.lineJoin, object.fillRule]
          : [
              object.points.length,
              object.revision,
              object.color,
              object.size,
              pointStreamFingerprint(object.points),
            ];
  return JSON.stringify([
    object.id,
    object.kind,
    object.x,
    object.y,
    object.width,
    object.height,
    object.rotation,
    kindState,
    object.kind === "connector"
      ? [
          route?.routing.kind ?? null,
          route?.points.map((point) => [
            Math.round(point.x * 100) / 100,
            Math.round(point.y * 100) / 100,
          ]) ?? null,
        ]
      : null,
  ]);
}

function targetForObject(
  object: CanvasObject,
  route: ResolvedConnectorRoute | undefined,
  viewportZoom: number,
): AgentDraftChoreographyTarget | null {
  let primaryPoints: Point[];
  let phase: "outline" | "trace" | "label";
  if (object.kind === "connector") {
    if (!route) return null;
    primaryPoints = curvedRoutePoints(route);
    phase = "trace";
  } else if (object.kind === "draw") {
    primaryPoints = downsample(object.points).map((point) => drawWorldPoint(object, point));
    phase = "trace";
  } else if (object.kind === "path") {
    primaryPoints = downsample(flattenVectorPath(object));
    phase = "trace";
  } else if (object.kind === "shape") {
    primaryPoints = shapeOutline(object);
    phase = "outline";
  } else if (object.kind === "image") {
    primaryPoints = rectanglePath(object);
    phase = "outline";
  } else {
    primaryPoints = labelSweep(object);
    phase = "label";
  }
  if (!primaryPoints.length) return null;
  const fingerprint = agentDraftObjectFingerprint(object, route);
  const segments: AgentDraftChoreographySegment[] = phase === "label"
    ? [labelSegment(object, primaryPoints, fingerprint, viewportZoom)]
    : [segment(phase, object, primaryPoints, fingerprint, viewportZoom)];

  const label = object.kind === "shape"
    ? object.label
    : object.kind === "connector"
      ? object.label
      : object.kind === "image"
        ? object.alt
        : "";
  if (label.trim()) {
    const points = object.kind === "connector" && route?.labelBounds
      ? [
          { x: route.labelBounds.x + 4, y: route.labelPoint.y },
          { x: route.labelBounds.x + route.labelBounds.width - 4, y: route.labelPoint.y },
        ]
      : labelSweep(object);
    segments.push(labelSegment(object, points, fingerprint, viewportZoom));
  }
  return { objectId: object.id, fingerprint, segments };
}

function prioritizedObjects(objects: readonly CanvasObject[]): CanvasObject[] {
  const maximum = AGENT_DRAFT_CHOREOGRAPHY_LIMITS.maxTargets;
  if (objects.length <= maximum) return [...objects];

  // Keep the beginning of the authored sequence as a stable narrative anchor,
  // then spend the remaining budget on the newest or most recently edited work.
  // Sorting the chosen set back into canvas order preserves natural traversal.
  const anchorCount = Math.min(12, maximum);
  const indexed = objects.map((object, index) => ({ object, index }));
  const anchors = indexed.slice(0, anchorCount);
  const recent = indexed
    .slice(anchorCount)
    .sort((left, right) =>
      right.object.updatedAt - left.object.updatedAt ||
      right.object.revision - left.object.revision ||
      right.index - left.index,
    )
    .slice(0, maximum - anchorCount);
  return [...anchors, ...recent]
    .sort((left, right) => left.index - right.index)
    .map(({ object }) => object);
}

export function buildAgentDraftChoreographyPlan(input: {
  draft: AgentCanvasDraftSnapshot;
  authoritativeObjects: Readonly<Record<string, CanvasObject>>;
  authoritativeDiagrams?: Readonly<Record<string, Diagram>>;
  fallbackPoint: Point;
  viewportZoom?: number;
}): AgentDraftChoreographyPlan {
  const viewportZoom = safeViewportZoom(input.viewportZoom);
  const projection = projectAgentDraft(
    input.draft,
    input.authoritativeObjects,
    input.authoritativeDiagrams,
  );
  const visibleObjects = projection?.visibleObjects ?? [];
  const targets = prioritizedObjects(visibleObjects).flatMap((object) => {
    const target = targetForObject(object, projection?.connectorRoutes[object.id], viewportZoom);
    return target ? [target] : [];
  });
  const targetFingerprints = new Map(
    targets.map((target) => [target.objectId, target.fingerprint]),
  );
  const bounds = projection?.bounds ?? null;
  const startPoint = { ...input.fallbackPoint };
  const inspectionPoints = bounds
    ? [
        { x: bounds.x + bounds.width + 22, y: bounds.y + Math.min(32, bounds.height * 0.25) },
        { x: bounds.x + bounds.width + 22, y: bounds.y + Math.max(32, bounds.height * 0.72) },
      ]
    : [{ ...input.fallbackPoint }];
  return {
    draftId: input.draft.id,
    revision: input.draft.revision,
    startPoint,
    targets,
    visibleObjectIds: visibleObjects.map((object) => object.id),
    visibleObjects: visibleObjects.map((object) => ({
      objectId: object.id,
      fingerprint: targetFingerprints.get(object.id) ?? agentDraftObjectFingerprint(
        object,
        projection?.connectorRoutes[object.id],
      ),
    })),
    inspectionPoints,
    viewportZoom,
  };
}

function travelPoints(from: Point, to: Point, seed: string): Point[] {
  const length = distance(from, to);
  if (length <= EPSILON) return [{ ...to }];
  const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const direction = seed.split("").reduce((sum, character) => sum + character.charCodeAt(0), 0) % 2 ? 1 : -1;
  const offset = Math.min(34, length * 0.12) * direction;
  return [
    { ...from },
    {
      x: midpoint.x - (to.y - from.y) / length * offset,
      y: midpoint.y + (to.x - from.x) / length * offset,
    },
    { ...to },
  ];
}

function travelSegment(
  from: Point,
  to: Point,
  seed: string,
  viewportZoom: number,
  input: Pick<AgentDraftChoreographySegment, "purpose" | "objectId" | "fingerprint">,
): AgentDraftChoreographySegment | null {
  const length = distance(from, to);
  if (length <= EPSILON) return null;
  return {
    phase: "travel",
    ...input,
    points: travelPoints(from, to, seed),
    durationMs: clamp(
      length * viewportZoom / AGENT_DRAFT_CHOREOGRAPHY_LIMITS.travelSpeed * 1_000,
      120,
      1_600,
    ),
  };
}

/**
 * Disposable, presentation-only playback state. It accepts already-authorized
 * snapshots, never mutates them, and has no timers, React state, or I/O.
 */
export class AgentDraftChoreographyCoordinator {
  private acceptedFingerprints = new Map<string, string>();
  private active: ActiveSegment | null = null;
  private currentPoint: Point | null = null;
  private lastFrame: AgentDraftChoreographyFrame | null = null;
  private queue: AgentDraftChoreographySegment[] = [];
  private remainingWork = new Map<string, { fingerprint: string; count: number }>();
  private revealEvents: AgentDraftRevealEvent[] = [];
  private viewportZoom = 1;

  accept(plan: AgentDraftChoreographyPlan, now: number): AgentDraftChoreographyFrame {
    const sampled = this.sample(now, plan.startPoint);
    this.currentPoint = sampled.pagePoint;
    this.rescaleForViewportZoom(plan.viewportZoom, now);
    const currentFingerprints = new Map(plan.targets.map((target) => [target.objectId, target.fingerprint]));
    const visibleObjectIds = new Set(plan.visibleObjectIds);

    const activeObjectId = this.active?.segment.objectId;
    const activeFingerprint = this.active?.segment.fingerprint;
    if (
      this.active?.segment.purpose === "inspection" ||
      (activeObjectId && (
        !visibleObjectIds.has(activeObjectId) ||
        !currentFingerprints.has(activeObjectId) ||
        currentFingerprints.get(activeObjectId) !== activeFingerprint
      ))
    ) {
      if (activeObjectId) this.remainingWork.delete(activeObjectId);
      this.active = null;
    }
    this.queue = this.queue.filter((candidate) => {
      if (candidate.purpose === "inspection") return false;
      if (!candidate.objectId) return true;
      if (!visibleObjectIds.has(candidate.objectId)) return false;
      return currentFingerprints.get(candidate.objectId) === candidate.fingerprint;
    });
    this.rebuildQueuedTravel();
    for (const [objectId, pending] of this.remainingWork) {
      if (currentFingerprints.get(objectId) === pending.fingerprint) continue;
      this.remainingWork.delete(objectId);
      if (visibleObjectIds.has(objectId)) {
        this.revealEvents.push({
          type: "object-complete",
          objectId,
          fingerprint: pending.fingerprint,
          phase: null,
        });
      }
    }
    for (const objectId of this.acceptedFingerprints.keys()) {
      if (!visibleObjectIds.has(objectId)) {
        this.acceptedFingerprints.delete(objectId);
        this.remainingWork.delete(objectId);
      }
    }

    const changedTargets = plan.targets.filter((target) => {
      if (this.acceptedFingerprints.get(target.objectId) === target.fingerprint) return false;
      this.acceptedFingerprints.set(target.objectId, target.fingerprint);
      return true;
    });
    for (const target of changedTargets) {
      this.remainingWork.set(target.objectId, {
        fingerprint: target.fingerprint,
        count: target.segments.length,
      });
      this.appendTarget(target);
    }
    this.trimQueuedTargets();
    if (changedTargets.length || this.queue.length || this.active) this.appendInspection(plan);
    this.compressQueue();
    return this.sample(now, plan.startPoint);
  }

  sample(now: number, fallbackPoint: Point = { x: 0, y: 0 }): AgentDraftChoreographyFrame {
    if (!this.currentPoint) this.currentPoint = { ...fallbackPoint };
    let nextStartedAt = now;
    while (true) {
      if (!this.active) {
        const next = this.queue.shift();
        if (!next) {
          return this.lastFrame
            ? { ...this.lastFrame, pagePoint: { ...this.currentPoint }, active: false }
            : {
                pagePoint: { ...this.currentPoint },
                phase: "inspect",
                objectId: null,
                fingerprint: null,
                phaseProgress: 1,
                active: false,
              };
        }
        this.active = { segment: next, startedAt: nextStartedAt };
      }
      const elapsed = Math.max(0, now - this.active.startedAt);
      const duration = Math.max(this.active.segment.durationMs, 1);
      if (elapsed >= duration) {
        this.completeSegment(this.active.segment);
        this.currentPoint = { ...this.active.segment.points.at(-1)! };
        this.lastFrame = {
          pagePoint: { ...this.currentPoint },
          phase: this.active.segment.phase,
          objectId: this.active.segment.objectId,
          fingerprint: this.active.segment.fingerprint,
          phaseProgress: 1,
          active: false,
        };
        nextStartedAt = this.active.startedAt + duration;
        this.active = null;
        continue;
      }
      const rawProgress = elapsed / duration;
      const pathProgress = this.active.segment.phase === "trace" || this.active.segment.phase === "outline"
        ? rawProgress
        : easeInOutSine(rawProgress);
      const pagePoint = pointAlongPath(this.active.segment.points, pathProgress);
      this.currentPoint = pagePoint;
      this.lastFrame = {
        pagePoint: { ...pagePoint },
        phase: this.active.segment.phase,
        objectId: this.active.segment.objectId,
        fingerprint: this.active.segment.fingerprint,
        phaseProgress: rawProgress,
        active: true,
      };
      return this.lastFrame;
    }
  }

  finish(plan: AgentDraftChoreographyPlan): AgentDraftChoreographyFrame {
    for (const target of plan.targets) {
      this.acceptedFingerprints.set(target.objectId, target.fingerprint);
    }
    for (const visible of plan.visibleObjects ?? plan.targets) {
      this.revealEvents.push({
        type: "object-complete",
        objectId: visible.objectId,
        fingerprint: visible.fingerprint,
        phase: null,
      });
      this.remainingWork.delete(visible.objectId);
    }
    this.active = null;
    this.queue = [];
    this.currentPoint = { ...(plan.inspectionPoints.at(-1) ?? plan.startPoint) };
    this.lastFrame = {
      pagePoint: { ...this.currentPoint },
      phase: "inspect",
      objectId: null,
      fingerprint: null,
      phaseProgress: 1,
      active: false,
    };
    return this.lastFrame;
  }

  drainRevealEvents(): AgentDraftRevealEvent[] {
    return this.revealEvents.splice(0);
  }

  private completeSegment(segment: AgentDraftChoreographySegment): void {
    if (
      segment.purpose !== "work" ||
      segment.phase === "travel" ||
      segment.phase === "inspect" ||
      !segment.objectId
    ) return;
    this.revealEvents.push({
      type: "phase-complete",
      objectId: segment.objectId,
      fingerprint: segment.fingerprint,
      phase: segment.phase,
    });
    const remaining = this.remainingWork.get(segment.objectId);
    if (!remaining || remaining.fingerprint !== segment.fingerprint) return;
    remaining.count -= 1;
    if (remaining.count > 0) return;
    this.remainingWork.delete(segment.objectId);
    this.revealEvents.push({
      type: "object-complete",
      objectId: segment.objectId,
      fingerprint: segment.fingerprint,
      phase: segment.phase,
    });
  }

  private appendTarget(target: AgentDraftChoreographyTarget): void {
    for (const work of target.segments) {
      this.appendWorkSegment(work, target.objectId);
    }
  }

  private appendWorkSegment(work: AgentDraftChoreographySegment, seed: string): void {
    const entry = work.points[0];
    if (!entry) return;
    const travel = travelSegment(this.tailPoint(), entry, seed, this.viewportZoom, {
      purpose: "work",
      objectId: work.objectId,
      fingerprint: work.fingerprint,
    });
    if (travel) this.queue.push(travel);
    this.queue.push(work);
  }

  private rebuildQueuedTravel(): void {
    const work = this.queue.filter(
      (candidate) => candidate.purpose === "work" && candidate.phase !== "travel",
    );
    this.queue = [];
    for (const candidate of work) {
      this.appendWorkSegment(candidate, `${candidate.objectId ?? "work"}:${candidate.phase}`);
    }
  }

  private trimQueuedTargets(): void {
    const activeObjectId = this.active?.segment.purpose === "work"
      ? this.active.segment.objectId
      : null;
    const available = Math.max(
      0,
      AGENT_DRAFT_CHOREOGRAPHY_LIMITS.maxTargets - (activeObjectId ? 1 : 0),
    );
    const queuedObjectIds: string[] = [];
    const seenObjectIds = new Set<string>();
    for (const candidate of this.queue) {
      if (
        candidate.purpose !== "work" ||
        candidate.phase === "travel" ||
        !candidate.objectId ||
        candidate.objectId === activeObjectId ||
        seenObjectIds.has(candidate.objectId)
      ) continue;
      queuedObjectIds.push(candidate.objectId);
      seenObjectIds.add(candidate.objectId);
    }
    if (queuedObjectIds.length <= available) return;

    // The tail contains the newest accepted work, so discard older unstarted
    // presentation paths first. Semantic draft state remains fully visible.
    const retained = new Set(available ? queuedObjectIds.slice(-available) : []);
    for (const objectId of queuedObjectIds) {
      if (retained.has(objectId)) continue;
      const pending = this.remainingWork.get(objectId);
      if (!pending) continue;
      this.remainingWork.delete(objectId);
      this.revealEvents.push({
        type: "object-complete",
        objectId,
        fingerprint: pending.fingerprint,
        phase: null,
      });
    }
    this.queue = this.queue.filter((candidate) =>
      candidate.purpose !== "work" ||
      !candidate.objectId ||
      candidate.objectId === activeObjectId ||
      retained.has(candidate.objectId),
    );
    this.rebuildQueuedTravel();
  }

  private appendInspection(plan: AgentDraftChoreographyPlan): void {
    this.queue = this.queue.filter((candidate) => candidate.purpose !== "inspection");
    const first = plan.inspectionPoints[0];
    if (!first) return;
    const travel = travelSegment(this.tailPoint(), first, `${plan.draftId}:inspect`, this.viewportZoom, {
      purpose: "inspection",
      objectId: null,
      fingerprint: null,
    });
    if (travel) this.queue.push(travel);
    this.queue.push({
      phase: "inspect",
      purpose: "inspection",
      objectId: null,
      fingerprint: null,
      points: plan.inspectionPoints,
      durationMs: clamp(
        pathLength(plan.inspectionPoints) * this.viewportZoom / 300 * 1_000,
        260,
        1_200,
      ),
    });
  }

  private tailPoint(): Point {
    return {
      ...(this.queue.at(-1)?.points.at(-1) ??
        this.active?.segment.points.at(-1) ??
        this.currentPoint ??
        { x: 0, y: 0 }),
    };
  }

  private rescaleForViewportZoom(nextZoom: number, now: number): void {
    const safeNextZoom = safeViewportZoom(nextZoom);
    if (Math.abs(safeNextZoom - this.viewportZoom) <= EPSILON) return;
    const ratio = safeNextZoom / this.viewportZoom;
    const rescaleDuration = (candidate: AgentDraftChoreographySegment) => {
      const maximum = candidate.phase === "travel"
        ? 1_600
        : candidate.phase === "outline" || candidate.phase === "trace"
          ? 4_000
          : 1_200;
      return clamp(
        candidate.durationMs * ratio,
        AGENT_DRAFT_CHOREOGRAPHY_LIMITS.minimumSegmentDurationMs,
        maximum,
      );
    };
    if (this.active) {
      const elapsed = Math.max(0, now - this.active.startedAt);
      const progress = clamp(elapsed / Math.max(this.active.segment.durationMs, 1), 0, 1);
      const durationMs = rescaleDuration(this.active.segment);
      this.active = {
        segment: { ...this.active.segment, durationMs },
        startedAt: now - durationMs * progress,
      };
    }
    this.queue = this.queue.map((candidate) => ({
      ...candidate,
      durationMs: rescaleDuration(candidate),
    }));
    this.viewportZoom = safeNextZoom;
  }

  private compressQueue(): void {
    const total = this.queue.reduce((sum, candidate) => sum + candidate.durationMs, 0);
    const budget = AGENT_DRAFT_CHOREOGRAPHY_LIMITS.maxQueuedDurationMs;
    if (total <= budget || !this.queue.length) return;
    const floors = this.queue.map((candidate) => Math.min(
      candidate.durationMs,
      AGENT_DRAFT_CHOREOGRAPHY_LIMITS.minimumSegmentDurationMs,
    ));
    const floorTotal = floors.reduce((sum, duration) => sum + duration, 0);
    if (floorTotal >= budget) {
      const scale = budget / total;
      this.queue = this.queue.map((candidate) => ({
        ...candidate,
        durationMs: candidate.durationMs * scale,
      }));
      return;
    }

    let lower = 0;
    let upper = 1;
    for (let iteration = 0; iteration < 32; iteration += 1) {
      const scale = (lower + upper) / 2;
      const scaledTotal = this.queue.reduce(
        (sum, candidate, index) => sum + Math.max(floors[index]!, candidate.durationMs * scale),
        0,
      );
      if (scaledTotal > budget) upper = scale;
      else lower = scale;
    }
    this.queue = this.queue.map((candidate, index) => ({
      ...candidate,
      durationMs: Math.max(floors[index]!, candidate.durationMs * lower),
    }));
  }
}
