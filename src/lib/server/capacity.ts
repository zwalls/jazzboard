import { DomainError } from "@/lib/domain/errors";
import type { RoomActivity, RoomState } from "@/lib/domain/types";

import {
  encodedRoomPlaneBytes,
  splitRoomState,
  type RoomAwarenessPlane,
} from "./room-planes";

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;

/**
 * Deliberately leaves headroom below both the HTTP response envelope and the
 * Redis command/value ceilings. These are first-demo safety budgets, not a
 * promise that a room should routinely approach them.
 */
export const DEFAULT_CAPACITY_LIMITS = {
  durableDocumentBytes: 3 * MEBIBYTE,
  awarenessBytes: 384 * KIBIBYTE,
  coordinationBytes: 128 * KIBIBYTE,
  persistedRoomBytes: Math.floor(3.75 * MEBIBYTE),
  retainedProposalBytes: 768 * KIBIBYTE,
  activityBytes: 1 * MEBIBYTE,
  objects: 5_000,
  diagrams: 500,
  participants: 128,
  drawingPoints: 250_000,
} as const;

export const DEFAULT_JSON_REQUEST_BYTES = 1 * MEBIBYTE;
export const DEFAULT_CAPACITY_WARNING_RATIO = 0.7;
/** Leaves command-envelope headroom below Upstash's 10 MiB request ceiling. */
export const REDIS_SAFE_PLANE_WRITE_BYTES = 8 * MEBIBYTE;

export type CapacityMode = "warn" | "enforce";
export type CapacityMetricName = keyof typeof DEFAULT_CAPACITY_LIMITS;
export type CapacityLimits = Record<CapacityMetricName, number>;

export type CapacityPolicy = {
  mode: CapacityMode;
  warningRatio: number;
  limits: CapacityLimits;
};

export type CapacityMetric = {
  used: number;
  limit: number;
  utilization: number;
};

/** Contains only controlled metric names and finite numbers; safe for logs and errors. */
export type CapacitySummary = {
  mode: CapacityMode;
  level: "ok" | "warning" | "exceeded";
  allowed: boolean;
  metrics: Record<CapacityMetricName, CapacityMetric>;
  warningMetrics: CapacityMetricName[];
  exceededMetrics: CapacityMetricName[];
};

export type CapacityEvaluationOptions = {
  activity?: RoomActivity | null;
  policy?: Partial<Omit<CapacityPolicy, "limits">> & {
    limits?: Partial<CapacityLimits>;
  };
};

export type ChangedRoomPlanes = {
  document: boolean;
  awareness: boolean;
  coordination: boolean;
};

export type MutationCapacitySummary = CapacitySummary & {
  blockedMetrics: CapacityMetricName[];
  grandfatheredMetrics: CapacityMetricName[];
};

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

export function resolveCapacityPolicy(
  input: CapacityEvaluationOptions["policy"] = {},
): CapacityPolicy {
  const warningRatio = input.warningRatio ?? DEFAULT_CAPACITY_WARNING_RATIO;
  if (!Number.isFinite(warningRatio) || warningRatio <= 0 || warningRatio >= 1) {
    throw new Error("Capacity warningRatio must be greater than zero and less than one.");
  }

  const limits = Object.fromEntries(
    Object.entries(DEFAULT_CAPACITY_LIMITS).map(([name, defaultValue]) => [
      name,
      positiveInteger(
        input.limits?.[name as CapacityMetricName] ?? defaultValue,
        `Capacity limit ${name}`,
      ),
    ]),
  ) as CapacityLimits;

  return {
    mode: input.mode ?? "warn",
    warningRatio,
    limits,
  };
}

export function capacityModeFromEnvironment(
  environment?: { JAZZBOARD_CAPACITY_MODE?: string },
): CapacityMode {
  return (environment ?? process.env).JAZZBOARD_CAPACITY_MODE === "enforce" ? "enforce" : "warn";
}

export function utf8JsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return 0;
  return Buffer.byteLength(serialized, "utf8");
}

function drawingPointCount(room: RoomState): number {
  return Object.values(room.objects).reduce(
    (total, object) => total + (object.kind === "draw" ? object.points.length : 0),
    0,
  );
}

function metric(used: number, limit: number): CapacityMetric {
  return {
    used,
    limit,
    utilization: used / limit,
  };
}

function capacitySummary(
  used: Record<CapacityMetricName, number>,
  policy: CapacityPolicy,
): CapacitySummary {
  const metrics = Object.fromEntries(
    (Object.keys(policy.limits) as CapacityMetricName[]).map((name) => [
      name,
      metric(used[name], policy.limits[name]),
    ]),
  ) as Record<CapacityMetricName, CapacityMetric>;
  const exceededMetrics = (Object.keys(metrics) as CapacityMetricName[]).filter(
    (name) => metrics[name].used > metrics[name].limit,
  );
  const warningMetrics = (Object.keys(metrics) as CapacityMetricName[]).filter(
    (name) => metrics[name].utilization >= policy.warningRatio,
  );

  return {
    mode: policy.mode,
    level: exceededMetrics.length ? "exceeded" : warningMetrics.length ? "warning" : "ok",
    allowed: policy.mode === "warn" || exceededMetrics.length === 0,
    metrics,
    warningMetrics,
    exceededMetrics,
  };
}

export function evaluateRoomCapacity(
  room: RoomState,
  options: CapacityEvaluationOptions = {},
): CapacitySummary {
  const policy = resolveCapacityPolicy(options.policy);
  const planeBytes = encodedRoomPlaneBytes(splitRoomState(room));
  const used: Record<CapacityMetricName, number> = {
    durableDocumentBytes: planeBytes.document,
    awarenessBytes: planeBytes.awareness,
    coordinationBytes: planeBytes.coordination,
    persistedRoomBytes: planeBytes.composed,
    retainedProposalBytes: utf8JsonBytes(room.reviewProposals),
    activityBytes: options.activity ? utf8JsonBytes(options.activity) : 0,
    objects: Object.keys(room.objects).length,
    diagrams: Object.keys(room.diagrams).length,
    participants: Object.keys(room.participants).length,
    drawingPoints: drawingPointCount(room),
  };
  return capacitySummary(used, policy);
}

/**
 * Evaluates only the bounded state touched by high-frequency presence. Other
 * metrics were already enforced when their owning planes were committed.
 */
export function evaluateAwarenessCapacity(
  awareness: RoomAwarenessPlane,
  options: CapacityEvaluationOptions = {},
): CapacitySummary {
  const policy = resolveCapacityPolicy(options.policy);
  const used = Object.fromEntries(
    (Object.keys(policy.limits) as CapacityMetricName[]).map((name) => [name, 0]),
  ) as Record<CapacityMetricName, number>;
  used.awarenessBytes = utf8JsonBytes(awareness);
  used.participants = Object.keys(awareness.participants).length;
  return capacitySummary(used, policy);
}

export function evaluateAwarenessMutationCapacity(input: {
  before: RoomAwarenessPlane;
  after: RoomAwarenessPlane;
  policy?: CapacityEvaluationOptions["policy"];
}): MutationCapacitySummary {
  const before = evaluateAwarenessCapacity(input.before, { policy: input.policy });
  const after = evaluateAwarenessCapacity(input.after, { policy: input.policy });
  const blockedMetrics: CapacityMetricName[] = [];
  const grandfatheredMetrics: CapacityMetricName[] = [];
  for (const name of after.exceededMetrics) {
    const previous = before.metrics[name];
    const next = after.metrics[name];
    if (previous.used > previous.limit && next.used <= previous.used) {
      grandfatheredMetrics.push(name);
    } else {
      blockedMetrics.push(name);
    }
  }
  return {
    ...after,
    allowed: after.mode === "warn" || blockedMetrics.length === 0,
    blockedMetrics,
    grandfatheredMetrics,
  };
}

export function capacityErrorDetails(summary: CapacitySummary): Record<string, number> {
  const details: Record<string, number> = {};
  for (const name of summary.exceededMetrics) {
    details[`${name}Used`] = summary.metrics[name].used;
    details[`${name}Limit`] = summary.metrics[name].limit;
  }
  return details;
}

export function roomCapacityError(
  summary: CapacitySummary,
  metrics: CapacityMetricName[] = summary.exceededMetrics,
): DomainError {
  return new DomainError(
    "ROOM_CAPACITY_EXCEEDED",
    "This Jazzboard has reached its safe collaboration capacity. Remove or simplify content before adding more.",
    capacityErrorDetails({ ...summary, exceededMetrics: metrics }),
  );
}

const DOCUMENT_METRICS = new Set<CapacityMetricName>([
  "durableDocumentBytes",
  "retainedProposalBytes",
  "objects",
  "diagrams",
  "drawingPoints",
]);

function mutationTouchesMetric(
  name: CapacityMetricName,
  changedPlanes: ChangedRoomPlanes,
  hasActivity: boolean,
): boolean {
  if (DOCUMENT_METRICS.has(name)) return changedPlanes.document;
  if (name === "awarenessBytes") return changedPlanes.awareness;
  if (name === "coordinationBytes") return changedPlanes.coordination;
  if (name === "participants") return changedPlanes.document || changedPlanes.awareness;
  if (name === "activityBytes") return hasActivity;
  return changedPlanes.document || changedPlanes.awareness || changedPlanes.coordination;
}

/**
 * Enforces only the planes a mutation changes and permits an already-oversized
 * metric to stay equal or shrink. This keeps presence and cleanup available to
 * grandfathered rooms without allowing a mutation to make its own overage
 * worse. The composed-size metric is informational for grandfathered rooms:
 * Redis persists individual planes, whose byte limits remain enforced.
 */
export function evaluateRoomMutationCapacity(input: {
  before: RoomState;
  after: RoomState;
  changedPlanes: ChangedRoomPlanes;
  activity?: RoomActivity | null;
  policy?: CapacityEvaluationOptions["policy"];
}): MutationCapacitySummary {
  const before = evaluateRoomCapacity(input.before, { policy: input.policy });
  const after = evaluateRoomCapacity(input.after, {
    activity: input.activity,
    policy: input.policy,
  });
  const blockedMetrics: CapacityMetricName[] = [];
  const grandfatheredMetrics: CapacityMetricName[] = [];

  for (const name of after.exceededMetrics) {
    const touched = mutationTouchesMetric(name, input.changedPlanes, Boolean(input.activity));
    const previous = before.metrics[name];
    const next = after.metrics[name];
    const alreadyExceeded = previous.used > previous.limit;
    const composedGrandfather = name === "persistedRoomBytes" && alreadyExceeded;
    if (!touched || composedGrandfather || (alreadyExceeded && next.used <= previous.used)) {
      grandfatheredMetrics.push(name);
    } else {
      blockedMetrics.push(name);
    }
  }

  return {
    ...after,
    allowed: after.mode === "warn" || blockedMetrics.length === 0,
    blockedMetrics,
    grandfatheredMetrics,
  };
}

export function assertRoomMutationCapacity(input: {
  before: RoomState;
  after: RoomState;
  changedPlanes: ChangedRoomPlanes;
  activity?: RoomActivity | null;
  policy?: CapacityEvaluationOptions["policy"];
}): MutationCapacitySummary {
  const summary = evaluateRoomMutationCapacity(input);
  if (!summary.allowed) {
    throw roomCapacityError(summary, summary.blockedMetrics);
  }
  return summary;
}

/** Hard provider guard used even during warn-mode rollout and lazy migration. */
export function assertRedisPlaneWriteCapacity(room: RoomState): void {
  const bytes = encodedRoomPlaneBytes(splitRoomState(room));
  const oversized = (Object.entries({
    durableDocumentBytes: bytes.document,
    awarenessBytes: bytes.awareness,
    coordinationBytes: bytes.coordination,
  }) as Array<["durableDocumentBytes" | "awarenessBytes" | "coordinationBytes", number]>)
    .filter(([, used]) => used > REDIS_SAFE_PLANE_WRITE_BYTES);
  if (!oversized.length) return;
  throw new DomainError(
    "ROOM_CAPACITY_EXCEEDED",
    "This legacy Jazzboard is too large for a safe Redis write. Remove enough content in one operation to migrate it safely.",
    Object.fromEntries(
      oversized.flatMap(([name, used]) => [
        [`${name}Used`, used],
        [`${name}SafeWriteLimit`, REDIS_SAFE_PLANE_WRITE_BYTES],
      ]),
    ),
  );
}

/**
 * Warn mode measures and reports without rejecting. Enforce mode rejects only
 * before persistence, so callers can preserve all-or-nothing mutation behavior.
 */
export function assertRoomCapacity(
  room: RoomState,
  options: CapacityEvaluationOptions = {},
): CapacitySummary {
  const summary = evaluateRoomCapacity(room, options);
  if (!summary.allowed) {
    throw roomCapacityError(summary);
  }
  return summary;
}

export function assertAwarenessCapacity(
  awareness: RoomAwarenessPlane,
  options: CapacityEvaluationOptions = {},
): CapacitySummary {
  const summary = evaluateAwarenessCapacity(awareness, options);
  if (!summary.allowed) {
    throw new DomainError(
      "ROOM_CAPACITY_EXCEEDED",
      "This Jazzboard has reached its safe live-presence capacity.",
      capacityErrorDetails(summary),
    );
  }
  return summary;
}
