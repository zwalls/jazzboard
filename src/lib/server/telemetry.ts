import { createHash, createHmac } from "node:crypto";

import type { ActorKind } from "@/lib/domain/types";

import { DEFAULT_CAPACITY_LIMITS, type CapacityMetricName, type CapacitySummary } from "./capacity";

export type TelemetryEventName =
  | "mutation.completed"
  | "mutation.failed"
  | "capacity.warning"
  | "realtime.reconciliation"
  | "awareness.sample"
  | "server.error";

export type TelemetryLevel = "info" | "warn" | "error";

export type JazzboardTelemetryEvent = {
  event: TelemetryEventName;
  level: TelemetryLevel;
  requestId?: string;
  operation?: string;
  actorKind?: ActorKind;
  outcome?: string;
  errorCode?: string;
  errorClass?: string;
  providerCommand?: string;
  replayed?: boolean;
  durationMs?: number;
  redisAttempts?: number;
  redisDurationMs?: number;
  reconciliationAttempts?: number;
  roomRevisionBefore?: number;
  roomRevisionAfter?: number;
  snapshotBytes?: number;
  participantHash?: string;
  roomHash?: string;
  mutationHash?: string;
  capacity?: CapacitySummary;
};

type TelemetrySink = Pick<Console, "info" | "warn" | "error">;

const CONTROLLED_TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const HASH = /^[a-f0-9]{16,64}$/;

function controlled(value: string | undefined): string | undefined {
  return value && CONTROLLED_TOKEN.test(value) ? value : undefined;
}

function finiteNonnegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeHash(value: string | undefined): string | undefined {
  return value && HASH.test(value) ? value : undefined;
}

/** One-way correlation only; callers must never log the source identifier. */
export function hashTelemetryIdentifier(value: string, secret?: string): string {
  const digest = secret
    ? createHmac("sha256", secret).update(value).digest("hex")
    : createHash("sha256").update(value).digest("hex");
  return digest.slice(0, 24);
}

export function shouldSampleTelemetry(sampleKey: string, rate: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  const bucket = Number.parseInt(createHash("sha256").update(sampleKey).digest("hex").slice(0, 8), 16);
  return bucket / 0xffff_ffff < rate;
}

function safeCapacity(summary: CapacitySummary | undefined): CapacitySummary | undefined {
  if (!summary) return undefined;
  const names = Object.keys(DEFAULT_CAPACITY_LIMITS) as CapacityMetricName[];
  const metrics = Object.fromEntries(names.map((name) => {
    const source = summary.metrics[name];
    return [name, {
      used: finiteNonnegative(source?.used) ?? 0,
      limit: finiteNonnegative(source?.limit) ?? DEFAULT_CAPACITY_LIMITS[name],
      utilization: finiteNonnegative(source?.utilization) ?? 0,
    }];
  })) as CapacitySummary["metrics"];
  const known = new Set(names);
  return {
    mode: summary.mode === "enforce" ? "enforce" : "warn",
    level: summary.level === "exceeded" ? "exceeded" : summary.level === "warning" ? "warning" : "ok",
    allowed: summary.allowed === true,
    metrics,
    warningMetrics: summary.warningMetrics.filter((name) => known.has(name)),
    exceededMetrics: summary.exceededMetrics.filter((name) => known.has(name)),
  };
}

export function telemetryRecord(input: JazzboardTelemetryEvent, now = Date.now()): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      schemaVersion: 1,
      product: "jazzboard",
      occurredAt: now,
      event: input.event,
      level: input.level,
      requestId: controlled(input.requestId),
      operation: controlled(input.operation),
      actorKind: input.actorKind,
      outcome: controlled(input.outcome),
      errorCode: controlled(input.errorCode),
      errorClass: controlled(input.errorClass),
      providerCommand: controlled(input.providerCommand),
      replayed: input.replayed,
      durationMs: finiteNonnegative(input.durationMs),
      redisAttempts: finiteNonnegative(input.redisAttempts),
      redisDurationMs: finiteNonnegative(input.redisDurationMs),
      reconciliationAttempts: finiteNonnegative(input.reconciliationAttempts),
      roomRevisionBefore: finiteNonnegative(input.roomRevisionBefore),
      roomRevisionAfter: finiteNonnegative(input.roomRevisionAfter),
      snapshotBytes: finiteNonnegative(input.snapshotBytes),
      participantHash: safeHash(input.participantHash),
      roomHash: safeHash(input.roomHash),
      mutationHash: safeHash(input.mutationHash),
      capacity: safeCapacity(input.capacity),
    }).filter(([, value]) => value !== undefined),
  );
}

/**
 * Extracts only controlled diagnostics from an unknown provider/runtime error.
 * ioredis errors may carry full command arguments (including serialized room
 * state) on `error.command.args`, so callers must never log the raw object.
 */
export function unknownErrorTelemetryFields(error: unknown): Pick<
  JazzboardTelemetryEvent,
  "errorClass" | "providerCommand"
> {
  if (!error || typeof error !== "object") return {};
  const candidate = error as {
    name?: unknown;
    command?: { name?: unknown } | null;
  };
  return {
    errorClass:
      typeof candidate.name === "string" ? controlled(candidate.name) : undefined,
    providerCommand:
      typeof candidate.command?.name === "string"
        ? controlled(candidate.command.name.toLowerCase())
        : undefined,
  };
}

export function emitTelemetry(
  input: JazzboardTelemetryEvent,
  dependencies: { sink?: TelemetrySink; now?: () => number } = {},
): void {
  const sink = dependencies.sink ?? console;
  const encoded = JSON.stringify(telemetryRecord(input, (dependencies.now ?? Date.now)()));
  sink[input.level](encoded);
}
