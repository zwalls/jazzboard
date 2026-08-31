import { randomBytes } from "node:crypto";

import { z } from "zod";

import developmentBenchmarkJson from "../../../research/benchmarks/development-v2.json";
import developmentRubricsJson from "../../../research/benchmarks/development-evaluator-rubrics-v2.json";
import developmentFixtureSpecsJson from "../../../research/benchmarks/development-fixture-specs-v2.json";
import developmentManifestJson from "../../../research/data/development-execution-manifest-v2.json";
import { CURRENT_ROOM_CODE_PATTERN } from "../domain/room-code";
import {
  compileBenchmarkTaskExecution,
  parseBenchmarkExecutionBundle,
  renderPublicAuthorBrief,
  type BenchmarkCanvasOperation,
  type BenchmarkCanvasTransactionInput,
  type ConcurrentEventPlan,
  type FixtureSeedReadabilityPreflight,
  type FixtureTransactionPlan,
  type PublicAuthorPacket,
} from "./benchmark-execution";
import {
  computePrivateRoomAccessBinding,
  type CodexWebMcpSpikeFreshnessContext,
} from "./codex-webmcp-spike";
import { verifyExp0001aCodexSpikeRecoveryGate } from "./codex-webmcp-spike-recovery";
import {
  createDevelopmentExecutionManifest,
  verifyDevelopmentExecutionManifest,
  type DevelopmentExecutionManifest,
} from "./development-manifest";
import {
  createExp0001aCodexScheduler,
  exp0001aCodexSchedulerStateSchema,
  nextExp0001aCodexAssignment,
  type Exp0001aCodexSchedulerState,
  type Exp0001aFrozenCodexAssignment,
} from "./exp0001a-codex-accounting";
import { createAtomicRegistryStore } from "./atomic-registry-store";
import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

export const EXP0001A_PROVISIONING_VERSION = "exp-0001a-attempt-provisioning/v1" as const;
export const EXP0001A_ROOM_RECEIPT_VERSION = "exp-0001a-room-provisioning-receipt/v1" as const;
export const EXP0001A_AUTHOR_HANDOFF_VERSION = "exp-0001a-author-provisioning-handoff/v1" as const;
export const EXP0001A_PROVISIONING_COORDINATOR_VERSION = "exp-0001a-provisioning-coordinator/v1" as const;
export const EXP0001A_PRODUCTION_ORIGIN = "https://www.jazzboard.xyz" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const identifierSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const roomIdSchema = z.string().regex(/^room_[A-Za-z0-9-]+$/);
const roomCodeSchema = z.string().refine((value) => CURRENT_ROOM_CODE_PATTERN.test(value), "Expected a current six-character Jazzboard room code.");

const COORDINATOR_DISPLAY_NAME = "Room host" as const;
const ROOM_CREATE_TOOL = "create_room" as const;
const ROOM_READ_TOOL = "read_room_state" as const;
const ROOM_SEED_TOOL = "apply_canvas_transaction" as const;
const COLLABORATION_READ_TOOL = "read_collaboration_state" as const;
const ROOM_JOIN_TOOL = "join_room" as const;
const RECENT_ROOMS_TOOL = "list_recent_rooms" as const;
const COORDINATOR_PRESENCE_AWAY_MS = 75_000 as const;
const INVITE_VERIFIER_DISPLAY_NAME = "Invite verifier" as const;
const ROOM_NONCE_PATTERN = /^rn_[a-f0-9]{32}$/;
const ALLOWED_PROVISIONING_TOOLS = Object.freeze([
  ROOM_CREATE_TOOL,
  ROOM_READ_TOOL,
  ROOM_SEED_TOOL,
  COLLABORATION_READ_TOOL,
  ROOM_JOIN_TOOL,
  RECENT_ROOMS_TOOL,
]);
const PROHIBITED_DISCOVERY_TOOLS = Object.freeze([
  "open_recent_room",
  "remove_recent_room",
  "leave_room",
  "room_search",
  "list_rooms",
]);

type JsonObject = Record<string, unknown>;

export type BrowserWebMcpCommand<TTool extends string, TInput> = Readonly<{
  transport: "browser_exposed_webmcp";
  origin: typeof EXP0001A_PRODUCTION_ORIGIN;
  toolName: TTool;
  input: TInput;
  purpose: string;
}>;

export type ExpectedSeedRecord = Readonly<{
  tempRef: string;
  semanticRef: string | null;
  declaredIssueTags: readonly string[];
  recordKind: "object" | "diagram";
  operation: BenchmarkCanvasOperation;
  declarationDigest: string;
}>;

export type Exp0001aAttemptProvisioningPlan = Readonly<{
  plannedIndex: number;
  assignmentId: string;
  attemptId: string;
  pairId: string;
  timeBlock: number;
  orderInPair: 0 | 1;
  condition: "A0" | "A1";
  taskId: string;
  taskFamily: "architecture" | "drawing";
  stratum: "creation" | "editing" | "stress";
  taskDigest: string;
  initialState: Readonly<{ kind: "blank" }> | Readonly<{ kind: "fixture"; fixtureId: string }>;
  publicAuthorPacket: PublicAuthorPacket;
  publicAuthorPacketDigest: string;
  room: Readonly<{
    visibility: "private";
    title: string;
    create: BrowserWebMcpCommand<typeof ROOM_CREATE_TOOL, Readonly<{
      displayName: typeof COORDINATOR_DISPLAY_NAME;
      title: string;
    }>>;
    readBlankBaseline: BrowserWebMcpCommand<typeof ROOM_READ_TOOL, Readonly<Record<string, never>>>;
    seed: BrowserWebMcpCommand<typeof ROOM_SEED_TOOL, BenchmarkCanvasTransactionInput> | null;
    readPreAuthorState: BrowserWebMcpCommand<typeof ROOM_READ_TOOL, Readonly<Record<string, never>>>;
    readCoordinatorPresenceLease: BrowserWebMcpCommand<typeof COLLABORATION_READ_TOOL, Readonly<Record<string, never>>>;
    reconcileAmbiguousCreate: BrowserWebMcpCommand<typeof RECENT_ROOMS_TOOL, Readonly<Record<string, never>>>;
    verifyInviteJoin: Readonly<{
      transport: "browser_exposed_webmcp";
      origin: typeof EXP0001A_PRODUCTION_ORIGIN;
      toolName: typeof ROOM_JOIN_TOOL;
      displayName: typeof INVITE_VERIFIER_DISPLAY_NAME;
      role: "spectator";
      codeSource: "retained_create_or_reconciliation_result";
      purpose: string;
    }>;
    verifyInviteRead: BrowserWebMcpCommand<typeof ROOM_READ_TOOL, Readonly<Record<string, never>>>;
    stopCoordinatorPresenceRenewal: Readonly<{
      operation: "close_room_surface";
      retainSignedGuestMembership: true;
      callLeaveRoom: false;
    }>;
    coordinatorPresencePolicy: Readonly<{
      displayName: "Room host";
      presenceAwayMs: typeof COORDINATOR_PRESENCE_AWAY_MS;
      authorReleaseAfterExpiry: true;
    }>;
    expectedCanvasTransition: "remain_blank" | "one_atomic_declared_seed";
    seedReadabilityPreflight: FixtureSeedReadabilityPreflight | null;
    expectedSeedRecords: readonly ExpectedSeedRecord[];
    prohibitedTools: readonly string[];
  }>;
  trustedConcurrentEvent: ConcurrentEventPlan | null;
  attemptPlanDigest: string;
}>;

export type Exp0001aAttemptProvisioningPlanSet = Readonly<{
  schemaVersion: typeof EXP0001A_PROVISIONING_VERSION;
  protocolId: "EXP-0001A";
  manifestId: string;
  manifestDigest: string;
  benchmarkId: string;
  benchmarkBundleDigest: string;
  scheduleDigest: string;
  roomPolicy: Readonly<{
    freshPrivateRoomPerAttempt: true;
    browserExposedWebMcpOnly: true;
    roomEnumerationForbidden: true;
    privateRecentRoomReconciliationOnly: true;
    privateApiAccess: false;
  }>;
  assignments: readonly Exp0001aFrozenCodexAssignment[];
  attempts: readonly Exp0001aAttemptProvisioningPlan[];
  planDigest: string;
}>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as JsonObject)) deepFreeze(child);
  }
  return value;
}

function withoutDigest<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key)) as Omit<T, K>;
}

function seedRecordKind(operation: BenchmarkCanvasOperation): "object" | "diagram" | null {
  if (operation.op === "create_diagram") return "diagram";
  if (operation.op === "update") return null;
  return "object";
}

function expectedSeedRecords(seed: FixtureTransactionPlan | null): ExpectedSeedRecord[] {
  if (seed === null) return [];
  const semanticRefByTempRef = new Map(Object.entries(seed.tempRefBySemanticRef)
    .map(([semanticRef, tempRef]) => [tempRef, semanticRef] as const));
  return seed.input.operations.map((operation) => {
    const recordKind = seedRecordKind(operation);
    if (recordKind === null || !("tempRef" in operation)) {
      throw new Error(`${seed.sourceId}: pre-brief provisioning may contain only declared creates.`);
    }
    const semanticRef = semanticRefByTempRef.get(operation.tempRef) ?? null;
    return {
      tempRef: operation.tempRef,
      semanticRef,
      declaredIssueTags: semanticRef === null
        ? []
        : [...(seed.provenance.issueTagsBySemanticRef[semanticRef] ?? [])],
      recordKind,
      operation: structuredClone(operation),
      declarationDigest: hashCanonicalJson(operation),
    };
  });
}

function frozenAssignments(manifest: DevelopmentExecutionManifest): Exp0001aFrozenCodexAssignment[] {
  return [...manifest.assignments]
    .sort((left, right) => left.timeBlock - right.timeBlock)
    .flatMap((pair) => [...pair.attempts]
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((attempt) => ({
        assignmentId: `assignment-${attempt.attemptId}`,
        attemptId: attempt.attemptId,
        pairId: pair.pairId,
        condition: attempt.opaqueLabel,
        plannedIndex: pair.timeBlock * 2 + attempt.orderIndex,
        timeBlock: pair.timeBlock,
        orderInPair: attempt.orderIndex,
      })));
}

function buildProvisioningPlan(
  manifest: DevelopmentExecutionManifest,
): Exp0001aAttemptProvisioningPlanSet {
  const bundle = parseBenchmarkExecutionBundle(
    developmentBenchmarkJson,
    developmentRubricsJson,
    developmentFixtureSpecsJson,
  );
  const assignments = frozenAssignments(manifest);
  const scheduler = createExp0001aCodexScheduler(assignments);
  const pairByAttempt = new Map(manifest.assignments.flatMap((pair) => pair.attempts.map((attempt) => [attempt.attemptId, pair] as const)));
  const taskCommitmentById = new Map(manifest.tasks.map((task) => [task.taskId, task]));
  const attempts = assignments.map((assignment): Exp0001aAttemptProvisioningPlan => {
    const pair = pairByAttempt.get(assignment.attemptId);
    if (!pair) throw new Error(`Missing manifest pair for ${assignment.attemptId}.`);
    const taskCommitment = taskCommitmentById.get(pair.taskId);
    if (!taskCommitment) throw new Error(`Missing task commitment for ${pair.taskId}.`);
    const execution = compileBenchmarkTaskExecution(bundle, pair.taskId);
    const benchmarkTask = bundle.benchmark.tasks.find((task) => task.id === pair.taskId);
    if (!benchmarkTask) throw new Error(`Missing frozen benchmark task ${pair.taskId}.`);
    const seed = execution.trustedCoordinator.preBriefSetup;
    // Deliberately identical across attempts: the author-visible room title may
    // not disclose schedule position, pair identity, condition, or time block.
    const roomTitle = "Private research canvas";
    const attemptContent = {
      plannedIndex: assignment.plannedIndex,
      assignmentId: assignment.assignmentId,
      attemptId: assignment.attemptId,
      pairId: assignment.pairId,
      timeBlock: assignment.timeBlock,
      orderInPair: assignment.orderInPair,
      condition: assignment.condition,
      taskId: pair.taskId,
      taskFamily: pair.taskFamily,
      stratum: pair.stratum,
      taskDigest: pair.taskDigest,
      initialState: structuredClone(benchmarkTask.initialState),
      publicAuthorPacket: structuredClone(execution.author.packet),
      publicAuthorPacketDigest: execution.commitments.publicPacket,
      room: {
        visibility: "private" as const,
        title: roomTitle,
        create: {
          transport: "browser_exposed_webmcp" as const,
          origin: EXP0001A_PRODUCTION_ORIGIN,
          toolName: ROOM_CREATE_TOOL,
          input: { displayName: COORDINATOR_DISPLAY_NAME, title: roomTitle },
          purpose: "Create one private room for this attempt without searching or enumerating rooms.",
        },
        readBlankBaseline: {
          transport: "browser_exposed_webmcp" as const,
          origin: EXP0001A_PRODUCTION_ORIGIN,
          toolName: ROOM_READ_TOOL,
          input: {},
          purpose: "Verify that the fresh room has no canvas objects or diagrams before any declared seed.",
        },
        seed: seed === null ? null : {
          transport: "browser_exposed_webmcp" as const,
          origin: EXP0001A_PRODUCTION_ORIGIN,
          toolName: ROOM_SEED_TOOL,
          input: structuredClone(seed.input),
          purpose: "Atomically materialize only the benchmark-declared pre-brief fixture.",
        },
        readPreAuthorState: {
          transport: "browser_exposed_webmcp" as const,
          origin: EXP0001A_PRODUCTION_ORIGIN,
          toolName: ROOM_READ_TOOL,
          input: {},
          purpose: "Hash and verify authoritative canvas state before releasing the author brief.",
        },
        readCoordinatorPresenceLease: {
          transport: "browser_exposed_webmcp" as const,
          origin: EXP0001A_PRODUCTION_ORIGIN,
          toolName: COLLABORATION_READ_TOOL,
          input: {},
          purpose: "Record authoritative presence for every provisioning-session member before stopping renewals.",
        },
        reconcileAmbiguousCreate: {
          transport: "browser_exposed_webmcp" as const,
          origin: EXP0001A_PRODUCTION_ORIGIN,
          toolName: RECENT_ROOMS_TOOL,
          input: {},
          purpose: "Only after an ambiguous create result, reconcile the pre-reserved opaque room nonce against this private browser and signed session's authorized recent rooms.",
        },
        verifyInviteJoin: {
          transport: "browser_exposed_webmcp" as const,
          origin: EXP0001A_PRODUCTION_ORIGIN,
          toolName: ROOM_JOIN_TOOL,
          displayName: INVITE_VERIFIER_DISPLAY_NAME,
          role: "spectator" as const,
          codeSource: "retained_create_or_reconciliation_result" as const,
          purpose: "In a separate private signed-guest session, join the exact retained invite code without searching for a room.",
        },
        verifyInviteRead: {
          transport: "browser_exposed_webmcp" as const,
          origin: EXP0001A_PRODUCTION_ORIGIN,
          toolName: ROOM_READ_TOOL,
          input: {},
          purpose: "In the same invite-verification session, read the authoritative room and prove the invite resolved to the reserved room ID.",
        },
        stopCoordinatorPresenceRenewal: {
          operation: "close_room_surface" as const,
          retainSignedGuestMembership: true as const,
          callLeaveRoom: false as const,
        },
        coordinatorPresencePolicy: {
          displayName: COORDINATOR_DISPLAY_NAME,
          presenceAwayMs: COORDINATOR_PRESENCE_AWAY_MS,
          authorReleaseAfterExpiry: true as const,
        },
        expectedCanvasTransition: seed === null ? "remain_blank" as const : "one_atomic_declared_seed" as const,
        seedReadabilityPreflight: execution.trustedCoordinator.seedReadabilityPreflight === null
          ? null
          : structuredClone(execution.trustedCoordinator.seedReadabilityPreflight),
        expectedSeedRecords: expectedSeedRecords(seed),
        prohibitedTools: [...PROHIBITED_DISCOVERY_TOOLS],
      },
      trustedConcurrentEvent: execution.trustedCoordinator.concurrentEvent === null
        ? null
        : structuredClone(execution.trustedCoordinator.concurrentEvent),
    };
    return deepFreeze({ ...attemptContent, attemptPlanDigest: hashCanonicalJson(attemptContent) });
  });
  const content = {
    schemaVersion: EXP0001A_PROVISIONING_VERSION,
    protocolId: "EXP-0001A" as const,
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    benchmarkId: bundle.benchmark.benchmarkId,
    benchmarkBundleDigest: manifest.benchmark.bundleDigest,
    scheduleDigest: scheduler.frozenScheduleDigest,
    roomPolicy: {
      freshPrivateRoomPerAttempt: true as const,
      browserExposedWebMcpOnly: true as const,
      roomEnumerationForbidden: true as const,
      privateRecentRoomReconciliationOnly: true as const,
      privateApiAccess: false as const,
    },
    assignments,
    attempts,
  };
  return deepFreeze({ ...content, planDigest: hashCanonicalJson(content) });
}

export function createExp0001aAttemptProvisioningPlan(): Exp0001aAttemptProvisioningPlanSet {
  const manifestVerification = verifyDevelopmentExecutionManifest(developmentManifestJson, developmentBenchmarkJson);
  if (!manifestVerification.ok) {
    throw new Error(`Frozen EXP-0001A manifest is invalid: ${manifestVerification.errors.join(", ")}`);
  }
  const deterministicManifest = createDevelopmentExecutionManifest(developmentBenchmarkJson);
  if (hashCanonicalJson(deterministicManifest) !== hashCanonicalJson(manifestVerification.manifest)) {
    throw new Error("Frozen EXP-0001A manifest differs from its deterministic expectation.");
  }
  return buildProvisioningPlan(manifestVerification.manifest);
}

export type Exp0001aProvisioningPlanVerification =
  | Readonly<{ ok: true; plan: Exp0001aAttemptProvisioningPlanSet }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

export function verifyExp0001aAttemptProvisioningPlan(input: unknown): Exp0001aProvisioningPlanVerification {
  const errors: string[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["PLAN_NOT_AN_OBJECT"] };
  }
  const candidate = input as Exp0001aAttemptProvisioningPlanSet;
  let expected: Exp0001aAttemptProvisioningPlanSet;
  try {
    expected = createExp0001aAttemptProvisioningPlan();
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "PLAN_EXPECTATION_UNAVAILABLE"] };
  }
  try {
    if (candidate.planDigest !== hashCanonicalJson(withoutDigest(candidate, "planDigest"))) errors.push("PLAN_DIGEST_INVALID");
  } catch {
    errors.push("PLAN_NOT_CANONICAL_JSON");
  }
  if (candidate.planDigest !== expected.planDigest) errors.push("PLAN_NOT_FROZEN_EXPECTATION");
  if (candidate.manifestDigest !== expected.manifestDigest) errors.push("MANIFEST_DIGEST_DRIFT");
  if (candidate.scheduleDigest !== expected.scheduleDigest) errors.push("SCHEDULE_DIGEST_DRIFT");
  if (!Array.isArray(candidate.attempts) || candidate.attempts.length !== 48) errors.push("ATTEMPT_COUNT_INVALID");
  if (!Array.isArray(candidate.assignments) || candidate.assignments.length !== 48) errors.push("ASSIGNMENT_COUNT_INVALID");
  if (Array.isArray(candidate.attempts)) {
    candidate.attempts.forEach((attempt, index) => {
      if (attempt === null || typeof attempt !== "object") {
        errors.push(`ATTEMPT_NOT_AN_OBJECT:${index}`);
        return;
      }
      if (attempt.plannedIndex !== index) errors.push(`ATTEMPT_ORDER_DRIFT:${index}`);
      try {
        if (attempt.attemptPlanDigest !== hashCanonicalJson(withoutDigest(attempt, "attemptPlanDigest"))) {
          errors.push(`ATTEMPT_DIGEST_INVALID:${index}`);
        }
      } catch {
        errors.push(`ATTEMPT_NOT_CANONICAL_JSON:${index}`);
      }
      const commandTools = [attempt.room?.create?.toolName, attempt.room?.readBlankBaseline?.toolName,
        attempt.room?.seed?.toolName, attempt.room?.readPreAuthorState?.toolName,
        attempt.room?.readCoordinatorPresenceLease?.toolName,
        attempt.room?.reconcileAmbiguousCreate?.toolName,
        attempt.room?.verifyInviteJoin?.toolName,
        attempt.room?.verifyInviteRead?.toolName].filter((tool): tool is string => typeof tool === "string");
      if (commandTools.some((tool) => !ALLOWED_PROVISIONING_TOOLS.includes(tool as typeof ALLOWED_PROVISIONING_TOOLS[number]))) {
        errors.push(`PROHIBITED_PROVISIONING_TOOL:${index}`);
      }
      if (commandTools.some((tool) => PROHIBITED_DISCOVERY_TOOLS.includes(tool))) {
        errors.push(`ROOM_ENUMERATION_TOOL:${index}`);
      }
    });
  }
  try {
    if (Array.isArray(candidate.assignments)) createExp0001aCodexScheduler(candidate.assignments);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "SCHEDULE_INVALID");
  }
  try {
    if (hashCanonicalJson(candidate) !== hashCanonicalJson(expected)) errors.push("PLAN_CONTENT_DRIFT");
  } catch {
    // PLAN_NOT_CANONICAL_JSON already captures this failure mode.
  }
  return errors.length === 0
    ? { ok: true, plan: deepFreeze(candidate) }
    : { ok: false, errors: [...new Set(errors)].sort() };
}

export function createExp0001aProvisioningScheduler(
  planInput: unknown = createExp0001aAttemptProvisioningPlan(),
): Exp0001aCodexSchedulerState {
  const verification = verifyExp0001aAttemptProvisioningPlan(planInput);
  if (!verification.ok) throw new Error(`Invalid EXP-0001A provisioning plan: ${verification.errors.join(", ")}`);
  return createExp0001aCodexScheduler(verification.plan.assignments);
}

export function releaseNextExp0001aProvisioningAttempt(input: Readonly<{
  plan: unknown;
  scheduler: Exp0001aCodexSchedulerState;
  spikeGate: unknown;
  spikeEvidence: unknown;
  spikeFreshness?: CodexWebMcpSpikeFreshnessContext;
}>): Exp0001aAttemptProvisioningPlan {
  const verification = verifyExp0001aAttemptProvisioningPlan(input.plan);
  if (!verification.ok) throw new Error(`Invalid EXP-0001A provisioning plan: ${verification.errors.join(", ")}`);
  const scheduler = exp0001aCodexSchedulerStateSchema.parse(input.scheduler);
  if (scheduler.frozenScheduleDigest !== verification.plan.scheduleDigest
      || hashCanonicalJson(scheduler.assignments.map((assignment) => ({
        assignmentId: assignment.assignmentId,
        attemptId: assignment.attemptId,
        pairId: assignment.pairId,
        condition: assignment.condition,
        plannedIndex: assignment.plannedIndex,
        timeBlock: assignment.timeBlock,
        orderInPair: assignment.orderInPair,
      }))) !== hashCanonicalJson(verification.plan.assignments)) {
    throw new Error("EXP0001A_SCHEDULER_NOT_BOUND_TO_EXACT_PROVISIONING_PLAN");
  }
  const spikeGate = verifyExp0001aCodexSpikeRecoveryGate(input.spikeGate);
  if (hashCanonicalJson(input.spikeEvidence as JsonValue) !== spikeGate.evidenceDigest) {
    throw new Error("EXP0001A_SPIKE_EVIDENCE_DIFFERS_FROM_SIGNED_RECOVERY_GATE");
  }
  const next = nextExp0001aCodexAssignment(scheduler);
  if (next.kind !== "ready") {
    throw new Error(next.kind === "paused"
      ? "EXP0001A_PROVISIONING_PAUSED_FOR_USAGE_LIMIT"
      : next.kind === "awaiting_terminal"
        ? "EXP0001A_PREVIOUS_ASSIGNMENT_NOT_TERMINAL"
        : "EXP0001A_PROVISIONING_COMPLETE");
  }
  const attempt = verification.plan.attempts[next.assignment.plannedIndex];
  if (!attempt || attempt.assignmentId !== next.assignment.assignmentId
      || attempt.attemptId !== next.assignment.attemptId
      || attempt.pairId !== next.assignment.pairId
      || attempt.condition !== next.assignment.condition
      || attempt.timeBlock !== next.assignment.timeBlock
      || attempt.orderInPair !== next.assignment.orderInPair) {
    throw new Error("EXP0001A_SCHEDULER_AND_PROVISIONING_PLAN_DIVERGED");
  }
  return attempt;
}

const authoritativeRecordSchema = z.object({
  recordKind: z.enum(["object", "diagram"]),
  authoritativeId: identifierSchema,
  revision: z.number().int().positive(),
  sourceTempRef: z.string().min(1).max(128),
  observedDeclarationProjectionDigest: digestSchema,
  authoritativeRecordDigest: digestSchema,
}).strict();

export type AuthoritativeSeedRecord = z.infer<typeof authoritativeRecordSchema>;

const canvasSnapshotContentSchema = z.object({
  roomRevision: nonNegativeIntegerSchema,
  semanticStateDigest: digestSchema,
  records: z.array(authoritativeRecordSchema),
  objectSetDigest: digestSchema,
  revisionSetDigest: digestSchema,
}).strict();

const canvasSnapshotSchema = canvasSnapshotContentSchema.extend({ snapshotDigest: digestSchema }).strict();
export type Exp0001aAuthoritativeCanvasSnapshot = z.infer<typeof canvasSnapshotSchema>;

function sortedRecords(records: readonly AuthoritativeSeedRecord[]): AuthoritativeSeedRecord[] {
  return [...records].sort((left, right) => left.authoritativeId.localeCompare(right.authoritativeId));
}

export function sealExp0001aAuthoritativeCanvasSnapshot(input: Readonly<{
  roomRevision: number;
  semanticStateDigest: string;
  records: readonly AuthoritativeSeedRecord[];
}>): Exp0001aAuthoritativeCanvasSnapshot {
  const records = sortedRecords(z.array(authoritativeRecordSchema).parse(input.records));
  const content = canvasSnapshotContentSchema.parse({
    roomRevision: input.roomRevision,
    semanticStateDigest: input.semanticStateDigest,
    records,
    objectSetDigest: hashCanonicalJson(records.map((record) => ({
      recordKind: record.recordKind,
      authoritativeId: record.authoritativeId,
      authoritativeRecordDigest: record.authoritativeRecordDigest,
    }))),
    revisionSetDigest: hashCanonicalJson(records.map((record) => ({
      recordKind: record.recordKind,
      authoritativeId: record.authoritativeId,
      revision: record.revision,
    }))),
  });
  return deepFreeze(canvasSnapshotSchema.parse({ ...content, snapshotDigest: hashCanonicalJson(content) }));
}

const jsonValueSchema = z.custom<JsonValue>((value) => {
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}, "Expected a finite plain JSON value.");

const retainedToolResultSchema = z.object({
  toolName: z.enum([
    ROOM_CREATE_TOOL,
    ROOM_READ_TOOL,
    ROOM_SEED_TOOL,
    COLLABORATION_READ_TOOL,
    ROOM_JOIN_TOOL,
    RECENT_ROOMS_TOOL,
  ]),
  session: z.enum(["coordinator", "invite_verifier"]),
  observedAt: timestampSchema,
  requestDigest: digestSchema,
  resultDigest: digestSchema,
  rawResult: jsonValueSchema,
}).strict();
export type Exp0001aRetainedWebMcpToolResult = z.infer<typeof retainedToolResultSchema>;

const roomAuthoritySchema = z.object({
  reservationId: identifierSchema,
  createReleasedAt: timestampSchema,
  roomNonce: z.string().regex(ROOM_NONCE_PATTERN),
  roomTitle: z.string().min(1).max(100),
  createResolution: z.enum(["direct_result", "private_recent_room_reconciliation"]),
  createRoom: retainedToolResultSchema.nullable(),
  recentRoomsReconciliation: retainedToolResultSchema.nullable(),
  blankBaselineRead: retainedToolResultSchema,
  seedCall: retainedToolResultSchema.nullable(),
  preAuthorRead: retainedToolResultSchema,
  inviteJoin: retainedToolResultSchema,
  inviteRead: retainedToolResultSchema,
  coordinatorPresenceRead: retainedToolResultSchema,
}).strict();

const webMcpCallReceiptSchema = z.object({
  toolName: retainedToolResultSchema.shape.toolName,
  session: retainedToolResultSchema.shape.session,
  requestDigest: digestSchema,
  resultDigest: digestSchema,
}).strict();

const roomProvisioningReceiptContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_ROOM_RECEIPT_VERSION),
  protocolId: z.literal("EXP-0001A"),
  attemptId: identifierSchema,
  assignmentId: identifierSchema,
  plannedIndex: nonNegativeIntegerSchema,
  planDigest: digestSchema,
  attemptPlanDigest: digestSchema,
  provisionedAt: timestampSchema,
  coordinatorJournalDigest: digestSchema,
  room: z.object({
    roomId: roomIdSchema,
    roomCode: roomCodeSchema,
    inviteUrl: z.string().url(),
    roomPath: z.string().min(1),
    visibility: z.literal("private"),
    accessBindingDigest: digestSchema,
  }).strict(),
  createResolution: z.enum(["direct_result", "private_recent_room_reconciliation"]),
  calls: z.object({
    createRoom: webMcpCallReceiptSchema.nullable(),
    recentRoomsReconciliation: webMcpCallReceiptSchema.nullable(),
    blankBaselineRead: webMcpCallReceiptSchema,
    seedCall: webMcpCallReceiptSchema.nullable(),
    preAuthorRead: webMcpCallReceiptSchema,
    inviteJoin: webMcpCallReceiptSchema,
    inviteRead: webMcpCallReceiptSchema,
    coordinatorPresenceRead: webMcpCallReceiptSchema,
  }).strict(),
  retainedAuthority: roomAuthoritySchema,
  coordinatorPresence: z.object({
    coordinatorParticipantId: identifierSchema,
    inviteVerifierParticipantId: identifierSchema,
    lastProvisionerPresenceAtMs: nonNegativeIntegerSchema,
    presenceAwayMs: z.literal(COORDINATOR_PRESENCE_AWAY_MS),
    renewalsStoppedAt: timestampSchema,
    authorReleaseNotBefore: timestampSchema,
    membershipRetentionBasis: z.literal("retained_join_and_authorized_reads_without_leave"),
  }).strict(),
  blankBaseline: canvasSnapshotSchema,
  preAuthorState: canvasSnapshotSchema,
}).strict();

const roomProvisioningReceiptSchema = roomProvisioningReceiptContentSchema.extend({ receiptDigest: digestSchema }).strict();
export type Exp0001aRoomProvisioningReceipt = z.infer<typeof roomProvisioningReceiptSchema>;

function inviteUrlFor(code: string): string {
  return `${EXP0001A_PRODUCTION_ORIGIN}/#join=${code}`;
}

function exactJson(input: unknown): JsonValue {
  return JSON.parse(canonicalJson(input)) as JsonValue;
}

function parseToolResult(
  retainedInput: unknown,
  expected: Readonly<{
    toolName: Exp0001aRetainedWebMcpToolResult["toolName"];
    session: Exp0001aRetainedWebMcpToolResult["session"];
    request: unknown;
  }>,
): Exp0001aRetainedWebMcpToolResult & { rawResult: { ok: true; tool: string; data: unknown } } {
  const retained = retainedToolResultSchema.parse(retainedInput);
  if (retained.toolName !== expected.toolName || retained.session !== expected.session
      || retained.requestDigest !== hashCanonicalJson(expected.request)
      || retained.resultDigest !== hashCanonicalJson(retained.rawResult)) {
    throw new Error("WEBMCP_TOOL_RESULT_BINDING_INVALID");
  }
  const envelope = z.object({
    ok: z.literal(true),
    tool: z.literal(expected.toolName),
    data: z.unknown(),
  }).strict().parse(retained.rawResult);
  return { ...retained, rawResult: { ...envelope, data: exactJson(envelope.data) } };
}

const roomSummarySchema = z.object({
  id: roomIdSchema,
  code: roomCodeSchema,
  title: z.string().min(1).max(100),
}).strict();

const recentRoomSchema = z.object({
  roomId: roomIdSchema,
  code: roomCodeSchema,
  title: z.string().min(1).max(100),
  role: z.enum(["participant", "spectator"]),
  lastOpenedAt: nonNegativeIntegerSchema,
}).strict();

const landingRoomResultDataSchema = z.object({
  room: roomSummarySchema,
  role: z.enum(["participant", "spectator"]),
  path: z.string().min(1),
  recentRoom: recentRoomSchema,
  recentReferenceStored: z.boolean(),
  displayNameStored: z.boolean(),
}).strict();

const presenceTargetProjectionSchema = z.object({
  lastSeenAt: nonNegativeIntegerSchema,
}).passthrough();

const participantProjectionSchema = z.object({
  participantId: identifierSchema,
  displayName: z.string().min(1).max(48),
  role: z.enum(["participant", "spectator"]),
  connected: z.boolean(),
  agentActive: z.boolean(),
  human: presenceTargetProjectionSchema,
  agent: presenceTargetProjectionSchema,
}).passthrough();

const canvasRecordProjectionSchema = z.object({
  id: identifierSchema,
  revision: z.number().int().positive(),
}).passthrough();

const roomReadDataSchema = z.object({
  room: roomSummarySchema.extend({
    roomRevision: nonNegativeIntegerSchema,
    selfParticipantId: identifierSchema,
  }).passthrough(),
  objects: z.array(canvasRecordProjectionSchema),
  diagrams: z.array(canvasRecordProjectionSchema),
  participants: z.array(participantProjectionSchema),
  leases: z.array(z.unknown()),
  spotlight: z.unknown(),
}).strict();

const seedResultDataSchema = z.object({
  outcome: z.literal("applied"),
  roomRevision: nonNegativeIntegerSchema,
  temporaryReferences: z.record(z.string(), identifierSchema),
  changedObjectIds: z.array(identifierSchema),
  changedDiagramIds: z.array(identifierSchema),
  objects: z.array(canvasRecordProjectionSchema),
  diagrams: z.array(canvasRecordProjectionSchema),
  visualQuality: z.array(z.object({
    diagramId: identifierSchema,
    diagramRevision: z.number().int().positive(),
    roomRevision: nonNegativeIntegerSchema,
    status: z.enum(["pass", "warning", "fail"]),
    geometryCoverage: z.object({ status: z.enum(["complete", "partial"]) }).passthrough(),
    findings: z.array(z.object({
      code: z.string().min(1),
      objectIds: z.array(identifierSchema),
      connectorIds: z.array(identifierSchema),
    }).passthrough()),
    metrics: z.object({ findingsTruncated: z.boolean() }).passthrough(),
  }).passthrough()),
  visualQualityOmittedDiagramIds: z.array(identifierSchema),
  visualQualityOmittedDiagramCount: nonNegativeIntegerSchema,
  visualQualityOmittedDiagramIdsTruncated: z.boolean(),
  verification: z.object({
    visualInspectionStatus: z.literal("not_performed"),
  }).passthrough(),
  proposal: z.null(),
}).passthrough();

const VISUAL_FINDING_ALLOWED_ISSUE_TAGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ATTACHMENT_PORT_CONGESTION: ["connector_intrusion"],
  CONNECTOR_CROSSING: ["connector_intrusion"],
  CONNECTOR_LABEL_EDGE_COLLISION: ["connector_intrusion", "unreadable_label"],
  CONNECTOR_LABEL_LABEL_COLLISION: ["connector_intrusion", "unreadable_label"],
  CONNECTOR_LABEL_LIKELY_TRUNCATED: ["unreadable_label"],
  CONNECTOR_LABEL_OBJECT_COLLISION: ["connector_intrusion", "unreadable_label"],
  CONNECTOR_OBJECT_INTRUSION: ["connector_intrusion"],
  CONNECTOR_SHARED_INITIAL_CORRIDOR: ["connector_intrusion"],
  CONNECTOR_SHARED_SEGMENT: ["connector_intrusion"],
  // No fixture issue tag authorizes an empty architecture Diagram.
  DIAGRAM_EMPTY: [],
  MEMBER_OBJECT_OVERLAP: ["intentional_overlap"],
  MEMBER_SPACING_TOO_SMALL: ["intentional_overlap"],
  SHAPE_LABEL_LIKELY_TRUNCATED: ["unreadable_label"],
  TEXT_CONTENT_LIKELY_TRUNCATED: ["unreadable_label"],
});

function assertAppliedSeedReadabilityEvidence(
  attempt: Exp0001aAttemptProvisioningPlan,
  seedData: z.infer<typeof seedResultDataSchema>,
): void {
  if (attempt.room.seedReadabilityPreflight === null) {
    throw new Error("SEED_READABILITY_STATIC_PREFLIGHT_MISSING");
  }
  if (seedData.visualQualityOmittedDiagramCount !== 0
      || seedData.visualQualityOmittedDiagramIds.length !== 0
      || seedData.visualQualityOmittedDiagramIdsTruncated) {
    throw new Error("SEED_READABILITY_EVIDENCE_INCOMPLETE");
  }
  const expectedDiagramIds = attempt.room.expectedSeedRecords
    .filter((record) => record.recordKind === "diagram")
    .map((record) => seedData.temporaryReferences[record.tempRef])
    .sort();
  const reportedDiagramIds = seedData.visualQuality.map((report) => report.diagramId).sort();
  if (expectedDiagramIds.some((id) => id === undefined)
      || canonicalJson(reportedDiagramIds) !== canonicalJson(expectedDiagramIds)) {
    throw new Error("SEED_READABILITY_DIAGRAM_COVERAGE_MISMATCH");
  }
  const recordByAuthoritativeId = new Map(attempt.room.expectedSeedRecords.flatMap((record) => {
    const authoritativeId = seedData.temporaryReferences[record.tempRef];
    return authoritativeId === undefined ? [] : [[authoritativeId, record] as const];
  }));
  for (const report of seedData.visualQuality) {
    const diagram = seedData.diagrams.find((record) => record.id === report.diagramId);
    if (!diagram || report.diagramRevision !== diagram.revision || report.roomRevision !== seedData.roomRevision
        || report.metrics.findingsTruncated) {
      throw new Error("SEED_READABILITY_EVIDENCE_STALE_OR_TRUNCATED");
    }
    if ((report.status === "pass") !== (report.findings.length === 0)) {
      throw new Error("SEED_VISUAL_QUALITY_STATUS_FINDING_MISMATCH");
    }
    for (const finding of report.findings) {
      const allowedIssueTags = VISUAL_FINDING_ALLOWED_ISSUE_TAGS[finding.code];
      if (allowedIssueTags === undefined) {
        throw new Error(`SEED_VISUAL_QUALITY_UNKNOWN_FINDING:${finding.code}`);
      }
      const affectedIds = [...finding.objectIds, ...finding.connectorIds];
      const affectedRecords = affectedIds.map((id) => recordByAuthoritativeId.get(id));
      if (affectedIds.length === 0 || affectedRecords.some((record) => record === undefined)) {
        throw new Error(`SEED_VISUAL_QUALITY_UNBOUND_FINDING:${finding.code}`);
      }
      if (!affectedRecords.some((record) => record!.declaredIssueTags.some((tag) => allowedIssueTags.includes(tag)))) {
        throw new Error(`SEED_VISUAL_QUALITY_UNDECLARED_FINDING:${finding.code}`);
      }
    }
  }
}

const collaborationReadDataSchema = z.object({
  room: roomSummarySchema.extend({ roomRevision: nonNegativeIntegerSchema }).passthrough(),
  session: z.object({
    participantId: identifierSchema,
    role: z.enum(["participant", "spectator"]),
    connected: z.boolean(),
    agentActive: z.boolean(),
  }).strict(),
  participants: z.array(participantProjectionSchema),
}).passthrough();

type RoomIdentity = Readonly<{ roomId: string; roomCode: string; roomTitle: string }>;

function roomIdentityFromAuthority(
  authority: Pick<z.infer<typeof roomAuthoritySchema>,
    "roomNonce" | "roomTitle" | "createResolution" | "createRoom" | "recentRoomsReconciliation">,
  attempt: Exp0001aAttemptProvisioningPlan,
): RoomIdentity {
  const expectedCreateRequest = {
    displayName: COORDINATOR_DISPLAY_NAME,
    title: authority.roomTitle,
  };
  if (authority.roomTitle !== `${attempt.room.title} ${authority.roomNonce}`) {
    throw new Error("ROOM_RESERVATION_NONCE_TITLE_BINDING_INVALID");
  }
  if (authority.createResolution === "direct_result") {
    if (authority.createRoom === null || authority.recentRoomsReconciliation !== null) {
      throw new Error("ROOM_CREATE_RESOLUTION_EVIDENCE_INVALID");
    }
    const retained = parseToolResult(authority.createRoom, {
      toolName: ROOM_CREATE_TOOL,
      session: "coordinator",
      request: expectedCreateRequest,
    });
    const data = landingRoomResultDataSchema.parse(retained.rawResult.data);
    if (data.role !== "participant" || data.room.title !== authority.roomTitle
        || data.path !== `/room/${data.room.id}`
        || data.recentRoom.roomId !== data.room.id
        || data.recentRoom.code !== data.room.code
        || data.recentRoom.title !== data.room.title
        || data.recentRoom.role !== "participant") {
      throw new Error("CREATE_ROOM_RESULT_DOES_NOT_BIND_RESERVED_ROOM");
    }
    return { roomId: data.room.id, roomCode: data.room.code, roomTitle: data.room.title };
  }
  if (authority.createRoom !== null || authority.recentRoomsReconciliation === null) {
    throw new Error("ROOM_CREATE_RECONCILIATION_EVIDENCE_INVALID");
  }
  const retained = parseToolResult(authority.recentRoomsReconciliation, {
    toolName: RECENT_ROOMS_TOOL,
    session: "coordinator",
    request: {},
  });
  const data = z.object({
    scope: z.literal("current_browser_and_signed_session"),
    rooms: z.array(recentRoomSchema).max(8),
  }).strict().parse(retained.rawResult.data);
  const matches = data.rooms.filter((room) => room.title === authority.roomTitle);
  if (matches.length !== 1 || matches[0]!.role !== "participant") {
    throw new Error("AMBIGUOUS_CREATE_NOT_RECONCILED_TO_EXACT_PRIVATE_ROOM_NONCE");
  }
  const room = matches[0]!;
  return { roomId: room.roomId, roomCode: room.code, roomTitle: room.title };
}

function assertRoomReadIdentity(
  data: z.infer<typeof roomReadDataSchema>,
  room: RoomIdentity,
  expectedSelf: Readonly<{ displayName: string; role: "participant" | "spectator" }>,
): z.infer<typeof participantProjectionSchema> {
  if (data.room.id !== room.roomId || data.room.code !== room.roomCode || data.room.title !== room.roomTitle) {
    throw new Error("AUTHORIZED_ROOM_READ_IDENTITY_MISMATCH");
  }
  const self = data.participants.find((participant) => participant.participantId === data.room.selfParticipantId);
  if (!self || self.displayName !== expectedSelf.displayName || self.role !== expectedSelf.role) {
    throw new Error("AUTHORIZED_ROOM_READ_SESSION_MEMBERSHIP_MISMATCH");
  }
  return self;
}

function sortedJsonRecords(records: readonly z.infer<typeof canvasRecordProjectionSchema>[]): JsonValue[] {
  return [...records]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((record) => exactJson(record));
}

function canvasStateDigest(data: z.infer<typeof roomReadDataSchema>): string {
  return hashCanonicalJson({
    room: {
      id: data.room.id,
      code: data.room.code,
      title: data.room.title,
      roomRevision: data.room.roomRevision,
    },
    objects: sortedJsonRecords(data.objects),
    diagrams: sortedJsonRecords(data.diagrams),
  });
}

function derivedSnapshot(
  data: z.infer<typeof roomReadDataSchema>,
  expected: readonly ExpectedSeedRecord[],
  temporaryReferences: Readonly<Record<string, string>>,
): Exp0001aAuthoritativeCanvasSnapshot {
  const recordsById = new Map<string, { recordKind: "object" | "diagram"; value: z.infer<typeof canvasRecordProjectionSchema> }>();
  for (const value of data.objects) recordsById.set(value.id, { recordKind: "object", value });
  for (const value of data.diagrams) {
    if (recordsById.has(value.id)) throw new Error("AUTHORITATIVE_RECORD_ID_REUSED_ACROSS_KINDS");
    recordsById.set(value.id, { recordKind: "diagram", value });
  }
  const records = expected.map((declaration) => {
    const authoritativeId = temporaryReferences[declaration.tempRef];
    const observed = authoritativeId === undefined ? undefined : recordsById.get(authoritativeId);
    if (!authoritativeId || !observed || observed.recordKind !== declaration.recordKind) {
      throw new Error("SEED_RESULT_DOES_NOT_RESOLVE_DECLARED_TEMP_REFERENCE");
    }
    return {
      recordKind: declaration.recordKind,
      authoritativeId,
      revision: observed.value.revision,
      sourceTempRef: declaration.tempRef,
      observedDeclarationProjectionDigest: declaration.declarationDigest,
      authoritativeRecordDigest: hashCanonicalJson(observed.value),
    };
  });
  if (records.length !== recordsById.size) throw new Error("UNDECLARED_OR_MISSING_SEED_OBJECT");
  return sealExp0001aAuthoritativeCanvasSnapshot({
    roomRevision: data.room.roomRevision,
    semanticStateDigest: canvasStateDigest(data),
    records,
  });
}

function verifyExpectedRecords(
  expected: readonly ExpectedSeedRecord[],
  actual: readonly AuthoritativeSeedRecord[],
): void {
  if (expected.length !== actual.length) throw new Error("UNDECLARED_OR_MISSING_SEED_OBJECT");
  const expectedByTempRef = new Map(expected.map((record) => [record.tempRef, record]));
  const seenIds = new Set<string>();
  const seenTempRefs = new Set<string>();
  for (const record of actual) {
    if (seenIds.has(record.authoritativeId)) throw new Error("SEED_OBJECT_ID_REUSED");
    if (seenTempRefs.has(record.sourceTempRef)) throw new Error("SEED_TEMP_REF_REUSED");
    seenIds.add(record.authoritativeId);
    seenTempRefs.add(record.sourceTempRef);
    const declaration = expectedByTempRef.get(record.sourceTempRef);
    if (!declaration) throw new Error("UNDECLARED_SEED_OBJECT");
    if (record.recordKind !== declaration.recordKind
        || record.observedDeclarationProjectionDigest !== declaration.declarationDigest) {
      throw new Error("SEED_OBJECT_DOES_NOT_MATCH_DECLARATION");
    }
  }
  if (expected.some((record) => !seenTempRefs.has(record.tempRef))) throw new Error("DECLARED_SEED_OBJECT_MISSING");
}

function receiptCall(retained: Exp0001aRetainedWebMcpToolResult): z.infer<typeof webMcpCallReceiptSchema> {
  return {
    toolName: retained.toolName,
    session: retained.session,
    requestDigest: retained.requestDigest,
    resultDigest: retained.resultDigest,
  };
}

function deriveRoomProvisioningReceipt(
  attempt: Exp0001aAttemptProvisioningPlan,
  planDigest: string,
  input: Readonly<{
    provisionedAt: string;
    coordinatorJournalDigest: string;
    renewalsStoppedAt: string;
    authority: z.infer<typeof roomAuthoritySchema>;
  }>,
): Exp0001aRoomProvisioningReceipt {
  timestampSchema.parse(input.provisionedAt);
  timestampSchema.parse(input.renewalsStoppedAt);
  digestSchema.parse(input.coordinatorJournalDigest);
  const authority = roomAuthoritySchema.parse(input.authority);
  const room = roomIdentityFromAuthority(authority, attempt);
  const blankRetained = parseToolResult(authority.blankBaselineRead, {
    toolName: ROOM_READ_TOOL,
    session: "coordinator",
    request: attempt.room.readBlankBaseline.input,
  });
  const blankData = roomReadDataSchema.parse(blankRetained.rawResult.data);
  const coordinator = assertRoomReadIdentity(blankData, room, {
    displayName: COORDINATOR_DISPLAY_NAME,
    role: "participant",
  });
  if (blankData.objects.length !== 0 || blankData.diagrams.length !== 0) throw new Error("FRESH_ROOM_WAS_NOT_BLANK");
  const blankBaseline = derivedSnapshot(blankData, [], {});

  let seedRetained: ReturnType<typeof parseToolResult> | null = null;
  let seedData: z.infer<typeof seedResultDataSchema> | null = null;
  if (attempt.room.seed === null) {
    if (authority.seedCall !== null) throw new Error("BLANK_ATTEMPT_FORBIDS_SEED_MUTATION");
  } else {
    if (authority.seedCall === null) throw new Error("DECLARED_SEED_RESULT_MISSING");
    seedRetained = parseToolResult(authority.seedCall, {
      toolName: ROOM_SEED_TOOL,
      session: "coordinator",
      request: attempt.room.seed.input,
    });
    seedData = seedResultDataSchema.parse(seedRetained.rawResult.data);
    assertAppliedSeedReadabilityEvidence(attempt, seedData);
  }

  const preAuthorRetained = parseToolResult(authority.preAuthorRead, {
    toolName: ROOM_READ_TOOL,
    session: "coordinator",
    request: attempt.room.readPreAuthorState.input,
  });
  const preAuthorData = roomReadDataSchema.parse(preAuthorRetained.rawResult.data);
  assertRoomReadIdentity(preAuthorData, room, { displayName: COORDINATOR_DISPLAY_NAME, role: "participant" });
  let temporaryReferences: Readonly<Record<string, string>> = {};
  if (seedData === null) {
    if (preAuthorData.room.roomRevision !== blankData.room.roomRevision
        || preAuthorData.objects.length !== 0 || preAuthorData.diagrams.length !== 0) {
      throw new Error("BLANK_ATTEMPT_CONTAINS_EXTRA_CANVAS_MUTATION");
    }
  } else {
    const expectedTempRefs = attempt.room.expectedSeedRecords.map((record) => record.tempRef).sort();
    const actualTempRefs = Object.keys(seedData.temporaryReferences).sort();
    if (canonicalJson(actualTempRefs) !== canonicalJson(expectedTempRefs)
        || seedData.roomRevision !== blankData.room.roomRevision + 1
        || preAuthorData.room.roomRevision !== seedData.roomRevision) {
      throw new Error("SEED_TRANSITION_WAS_NOT_EXACTLY_ONE_ATOMIC_MUTATION");
    }
    const expectedObjectIds = attempt.room.expectedSeedRecords
      .filter((record) => record.recordKind === "object")
      .map((record) => seedData!.temporaryReferences[record.tempRef]).sort();
    const expectedDiagramIds = attempt.room.expectedSeedRecords
      .filter((record) => record.recordKind === "diagram")
      .map((record) => seedData!.temporaryReferences[record.tempRef]).sort();
    if (expectedObjectIds.some((id) => id === undefined) || expectedDiagramIds.some((id) => id === undefined)
        || canonicalJson([...seedData.changedObjectIds].sort()) !== canonicalJson(expectedObjectIds)
        || canonicalJson([...seedData.changedDiagramIds].sort()) !== canonicalJson(expectedDiagramIds)
        || canonicalJson(sortedJsonRecords(seedData.objects)) !== canonicalJson(sortedJsonRecords(preAuthorData.objects))
        || canonicalJson(sortedJsonRecords(seedData.diagrams)) !== canonicalJson(sortedJsonRecords(preAuthorData.diagrams))) {
      throw new Error("SEED_RESULT_OR_PREAUTHOR_READ_CONTAINS_EXTRA_MUTATION");
    }
    temporaryReferences = seedData.temporaryReferences;
  }
  const preAuthorState = derivedSnapshot(preAuthorData, attempt.room.expectedSeedRecords, temporaryReferences);
  verifyExpectedRecords(attempt.room.expectedSeedRecords, preAuthorState.records);

  const inviteJoinRetained = parseToolResult(authority.inviteJoin, {
    toolName: ROOM_JOIN_TOOL,
    session: "invite_verifier",
    request: { code: room.roomCode, displayName: INVITE_VERIFIER_DISPLAY_NAME, role: "spectator" },
  });
  const inviteJoinData = landingRoomResultDataSchema.parse(inviteJoinRetained.rawResult.data);
  if (inviteJoinData.role !== "spectator" || inviteJoinData.room.id !== room.roomId
      || inviteJoinData.room.code !== room.roomCode || inviteJoinData.room.title !== room.roomTitle
      || inviteJoinData.path !== `/room/${room.roomId}`
      || inviteJoinData.recentRoom.roomId !== room.roomId
      || inviteJoinData.recentRoom.code !== room.roomCode
      || inviteJoinData.recentRoom.role !== "spectator") {
    throw new Error("INVITE_JOIN_DID_NOT_RESOLVE_TO_RESERVED_ROOM");
  }
  const inviteReadRetained = parseToolResult(authority.inviteRead, {
    toolName: ROOM_READ_TOOL,
    session: "invite_verifier",
    request: attempt.room.verifyInviteRead.input,
  });
  const inviteReadData = roomReadDataSchema.parse(inviteReadRetained.rawResult.data);
  const inviteVerifier = assertRoomReadIdentity(inviteReadData, room, {
    displayName: INVITE_VERIFIER_DISPLAY_NAME,
    role: "spectator",
  });
  if (inviteReadData.room.roomRevision !== preAuthorData.room.roomRevision
      || canonicalJson(sortedJsonRecords(inviteReadData.objects)) !== canonicalJson(sortedJsonRecords(preAuthorData.objects))
      || canonicalJson(sortedJsonRecords(inviteReadData.diagrams)) !== canonicalJson(sortedJsonRecords(preAuthorData.diagrams))) {
    throw new Error("INVITE_VERIFICATION_READ_OBSERVED_EXTRA_MUTATION");
  }

  const presenceRetained = parseToolResult(authority.coordinatorPresenceRead, {
    toolName: COLLABORATION_READ_TOOL,
    session: "coordinator",
    request: attempt.room.readCoordinatorPresenceLease.input,
  });
  const presenceData = collaborationReadDataSchema.parse(presenceRetained.rawResult.data);
  if (presenceData.room.id !== room.roomId || presenceData.room.code !== room.roomCode
      || presenceData.room.title !== room.roomTitle
      || presenceData.room.roomRevision !== preAuthorData.room.roomRevision
      || presenceData.session.participantId !== coordinator.participantId
      || presenceData.session.role !== "participant") {
    throw new Error("COORDINATOR_PRESENCE_READ_ROOM_OR_SESSION_MISMATCH");
  }
  const retainedParticipants = presenceData.participants.filter((participant) => (
    participant.participantId === coordinator.participantId
      || participant.participantId === inviteVerifier.participantId
  ));
  if (retainedParticipants.length !== 2
      || new Set(presenceData.participants.map((participant) => participant.participantId)).size !== 2) {
    throw new Error("UNDECLARED_PARTICIPANT_PRESENT_BEFORE_AUTHOR_RELEASE");
  }
  const lastProvisionerPresenceAtMs = Math.max(...retainedParticipants.flatMap((participant) => [
    participant.human.lastSeenAt,
    participant.agent.lastSeenAt,
  ]));
  if (Date.parse(input.renewalsStoppedAt) < lastProvisionerPresenceAtMs) {
    throw new Error("PROVISIONER_PRESENCE_RENEWAL_STOP_PRECEDES_LAST_PRESENCE");
  }
  const authorReleaseNotBefore = new Date(lastProvisionerPresenceAtMs + COORDINATOR_PRESENCE_AWAY_MS + 1).toISOString();
  const retainedAuthority = deepFreeze(exactJson(authority) as z.infer<typeof roomAuthoritySchema>);
  const content = roomProvisioningReceiptContentSchema.parse({
    schemaVersion: EXP0001A_ROOM_RECEIPT_VERSION,
    protocolId: "EXP-0001A",
    attemptId: attempt.attemptId,
    assignmentId: attempt.assignmentId,
    plannedIndex: attempt.plannedIndex,
    planDigest,
    attemptPlanDigest: attempt.attemptPlanDigest,
    provisionedAt: input.provisionedAt,
    coordinatorJournalDigest: input.coordinatorJournalDigest,
    room: {
      roomId: room.roomId,
      roomCode: room.roomCode,
      inviteUrl: inviteUrlFor(room.roomCode),
      roomPath: `/room/${room.roomId}`,
      visibility: "private",
      accessBindingDigest: computePrivateRoomAccessBinding({
        privateRoomUrl: inviteUrlFor(room.roomCode),
        roomId: room.roomId,
      }),
    },
    createResolution: authority.createResolution,
    calls: {
      createRoom: authority.createRoom === null ? null : receiptCall(authority.createRoom),
      recentRoomsReconciliation: authority.recentRoomsReconciliation === null
        ? null : receiptCall(authority.recentRoomsReconciliation),
      blankBaselineRead: receiptCall(authority.blankBaselineRead),
      seedCall: authority.seedCall === null ? null : receiptCall(authority.seedCall),
      preAuthorRead: receiptCall(authority.preAuthorRead),
      inviteJoin: receiptCall(authority.inviteJoin),
      inviteRead: receiptCall(authority.inviteRead),
      coordinatorPresenceRead: receiptCall(authority.coordinatorPresenceRead),
    },
    retainedAuthority,
    coordinatorPresence: {
      coordinatorParticipantId: coordinator.participantId,
      inviteVerifierParticipantId: inviteVerifier.participantId,
      lastProvisionerPresenceAtMs,
      presenceAwayMs: COORDINATOR_PRESENCE_AWAY_MS,
      renewalsStoppedAt: input.renewalsStoppedAt,
      authorReleaseNotBefore,
      membershipRetentionBasis: "retained_join_and_authorized_reads_without_leave",
    },
    blankBaseline,
    preAuthorState,
  });
  return deepFreeze(roomProvisioningReceiptSchema.parse({ ...content, receiptDigest: hashCanonicalJson(content) }));
}

export function verifyExp0001aRoomProvisioningReceipt(
  input: unknown,
  attempt?: Exp0001aAttemptProvisioningPlan,
): Exp0001aRoomProvisioningReceipt {
  const receipt = roomProvisioningReceiptSchema.parse(input);
  if (receipt.receiptDigest !== hashCanonicalJson(withoutDigest(receipt, "receiptDigest"))) {
    throw new Error("ROOM_PROVISIONING_RECEIPT_DIGEST_INVALID");
  }
  const frozen = createExp0001aAttemptProvisioningPlan();
  if (receipt.planDigest !== frozen.planDigest) throw new Error("ROOM_RECEIPT_PLAN_NOT_FROZEN_EXPECTATION");
  const frozenAttempt = frozen.attempts[receipt.plannedIndex];
  if (!frozenAttempt || frozenAttempt.attemptId !== receipt.attemptId
      || frozenAttempt.assignmentId !== receipt.assignmentId
      || frozenAttempt.attemptPlanDigest !== receipt.attemptPlanDigest) {
    throw new Error("ROOM_RECEIPT_DOES_NOT_BIND_TO_FROZEN_ATTEMPT");
  }
  if (attempt !== undefined && hashCanonicalJson(attempt) !== hashCanonicalJson(frozenAttempt)) {
    throw new Error("ROOM_RECEIPT_CALLER_ATTEMPT_DIFFERS_FROM_FROZEN_ATTEMPT");
  }
  const rebuilt = deriveRoomProvisioningReceipt(frozenAttempt, frozen.planDigest, {
    provisionedAt: receipt.provisionedAt,
    coordinatorJournalDigest: receipt.coordinatorJournalDigest,
    renewalsStoppedAt: receipt.coordinatorPresence.renewalsStoppedAt,
    authority: receipt.retainedAuthority,
  });
  if (hashCanonicalJson(rebuilt) !== hashCanonicalJson(receipt)) {
    throw new Error("ROOM_PROVISIONING_RECEIPT_NOT_DERIVED_FROM_RETAINED_TOOL_RESULTS");
  }
  return deepFreeze(receipt);
}

export function assertUniqueExp0001aRoomProvisioningReceipts(
  receiptsInput: readonly unknown[],
): readonly Exp0001aRoomProvisioningReceipt[] {
  const receipts = receiptsInput.map((receipt) => verifyExp0001aRoomProvisioningReceipt(receipt));
  const fields = ["attemptId", "assignmentId"] as const;
  for (const field of fields) {
    const values = receipts.map((receipt) => receipt[field]);
    if (new Set(values).size !== values.length) throw new Error(`ROOM_PROVISIONING_REUSE:${field}`);
  }
  const privateFields = ["roomId", "roomCode", "inviteUrl", "accessBindingDigest"] as const;
  for (const field of privateFields) {
    const values = receipts.map((receipt) => receipt.room[field]);
    if (new Set(values).size !== values.length) throw new Error(`ROOM_PROVISIONING_REUSE:${field}`);
  }
  return deepFreeze(receipts);
}

const coordinatorReservationSchema = z.object({
  reservationId: identifierSchema,
  assignmentId: identifierSchema,
  attemptId: identifierSchema,
  plannedIndex: nonNegativeIntegerSchema,
  attemptPlanDigest: digestSchema,
  reservedAt: timestampSchema,
  roomNonce: z.string().regex(ROOM_NONCE_PATTERN),
  roomTitle: z.string().min(1).max(100),
  createReleasedAt: timestampSchema.nullable(),
  createRoom: retainedToolResultSchema.nullable(),
  recentRoomsReconciliation: retainedToolResultSchema.nullable(),
  blankBaselineRead: retainedToolResultSchema.nullable(),
  seedCall: retainedToolResultSchema.nullable(),
  preAuthorRead: retainedToolResultSchema.nullable(),
  inviteJoin: retainedToolResultSchema.nullable(),
  inviteRead: retainedToolResultSchema.nullable(),
  coordinatorPresenceRead: retainedToolResultSchema.nullable(),
  renewalsStoppedAt: timestampSchema.nullable(),
  receiptPredecessorStateDigest: digestSchema.nullable(),
  receipt: roomProvisioningReceiptSchema.nullable(),
}).strict();
export type Exp0001aProvisioningReservation = z.infer<typeof coordinatorReservationSchema>;

const coordinatorStateContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_PROVISIONING_COORDINATOR_VERSION),
  protocolId: z.literal("EXP-0001A"),
  planDigest: digestSchema,
  scheduleDigest: digestSchema,
  scheduler: exp0001aCodexSchedulerStateSchema,
  reservations: z.array(coordinatorReservationSchema).max(48),
}).strict();
const coordinatorStateSchema = coordinatorStateContentSchema.extend({ stateDigest: digestSchema }).strict();
export type Exp0001aProvisioningCoordinatorState = z.infer<typeof coordinatorStateSchema>;

function assertSchedulerBoundToPlan(
  schedulerInput: unknown,
  plan: Exp0001aAttemptProvisioningPlanSet,
): Exp0001aCodexSchedulerState {
  const scheduler = exp0001aCodexSchedulerStateSchema.parse(schedulerInput);
  const frozenAssignments = scheduler.assignments.map((assignment) => ({
    assignmentId: assignment.assignmentId,
    attemptId: assignment.attemptId,
    pairId: assignment.pairId,
    condition: assignment.condition,
    plannedIndex: assignment.plannedIndex,
    timeBlock: assignment.timeBlock,
    orderInPair: assignment.orderInPair,
  }));
  if (scheduler.frozenScheduleDigest !== plan.scheduleDigest
      || canonicalJson(frozenAssignments) !== canonicalJson(plan.assignments)) {
    throw new Error("EXP0001A_SCHEDULER_NOT_BOUND_TO_EXACT_PROVISIONING_PLAN");
  }
  return scheduler;
}

function verifyCoordinatorState(
  input: unknown,
  plan: Exp0001aAttemptProvisioningPlanSet,
): Exp0001aProvisioningCoordinatorState {
  const state = coordinatorStateSchema.parse(input);
  if (state.stateDigest !== hashCanonicalJson(withoutDigest(state, "stateDigest"))) {
    throw new Error("PROVISIONING_COORDINATOR_STATE_DIGEST_INVALID");
  }
  if (state.planDigest !== plan.planDigest || state.scheduleDigest !== plan.scheduleDigest) {
    throw new Error("PROVISIONING_COORDINATOR_PLAN_BINDING_INVALID");
  }
  assertSchedulerBoundToPlan(state.scheduler, plan);
  const reservationIds = new Set<string>();
  const assignmentIds = new Set<string>();
  const nonces = new Set<string>();
  const roomIds = new Set<string>();
  const roomCodes = new Set<string>();
  let unfinished = 0;
  for (const reservation of state.reservations) {
    const attempt = plan.attempts[reservation.plannedIndex];
    if (!attempt || reservation.assignmentId !== attempt.assignmentId
        || reservation.attemptId !== attempt.attemptId
        || reservation.attemptPlanDigest !== attempt.attemptPlanDigest
        || reservation.reservationId !== `reservation-${attempt.assignmentId}`
        || reservation.roomTitle !== `${attempt.room.title} ${reservation.roomNonce}`) {
      throw new Error("PROVISIONING_RESERVATION_NOT_BOUND_TO_EXACT_ATTEMPT");
    }
    if (reservationIds.has(reservation.reservationId) || assignmentIds.has(reservation.assignmentId)
        || nonces.has(reservation.roomNonce)) {
      throw new Error("PROVISIONING_RESERVATION_IDENTITY_REUSED");
    }
    reservationIds.add(reservation.reservationId);
    assignmentIds.add(reservation.assignmentId);
    nonces.add(reservation.roomNonce);
    const hasRoom = reservation.createRoom !== null || reservation.recentRoomsReconciliation !== null;
    if (reservation.createRoom !== null && reservation.recentRoomsReconciliation !== null) {
      throw new Error("CREATE_ROOM_DIRECT_AND_RECONCILED_RESULTS_ARE_MUTUALLY_EXCLUSIVE");
    }
    const ordered = [
      reservation.createReleasedAt !== null,
      hasRoom,
      reservation.blankBaselineRead !== null,
      ...(attempt.room.seed === null ? [] : [reservation.seedCall !== null]),
      reservation.preAuthorRead !== null,
      reservation.inviteJoin !== null,
      reservation.inviteRead !== null,
      reservation.coordinatorPresenceRead !== null,
      reservation.renewalsStoppedAt !== null,
      reservation.receipt !== null,
    ];
    let gap = false;
    for (const present of ordered) {
      if (!present) gap = true;
      else if (gap) throw new Error("PROVISIONING_TOOL_RESULTS_RETAINED_OUT_OF_ORDER");
    }
    if (attempt.room.seed === null && reservation.seedCall !== null) {
      throw new Error("BLANK_ATTEMPT_FORBIDS_SEED_MUTATION");
    }
    const timeline = [
      reservation.createReleasedAt,
      reservation.createRoom?.observedAt ?? reservation.recentRoomsReconciliation?.observedAt ?? null,
      reservation.blankBaselineRead?.observedAt ?? null,
      reservation.seedCall?.observedAt ?? null,
      reservation.preAuthorRead?.observedAt ?? null,
      reservation.inviteJoin?.observedAt ?? null,
      reservation.inviteRead?.observedAt ?? null,
      reservation.coordinatorPresenceRead?.observedAt ?? null,
      reservation.renewalsStoppedAt,
      reservation.receipt?.provisionedAt ?? null,
    ].filter((at): at is string => at !== null);
    let previousAt = reservation.reservedAt;
    for (const at of timeline) {
      if (Date.parse(at) < Date.parse(previousAt)) throw new Error("PROVISIONING_EVENT_TIME_REGRESSED");
      previousAt = at;
    }
    if (hasRoom) {
      const identity = roomIdentityFromAuthority({
        roomNonce: reservation.roomNonce,
        roomTitle: reservation.roomTitle,
        createResolution: reservation.createRoom === null
          ? "private_recent_room_reconciliation" : "direct_result",
        createRoom: reservation.createRoom,
        recentRoomsReconciliation: reservation.recentRoomsReconciliation,
      }, attempt);
      if (roomIds.has(identity.roomId) || roomCodes.has(identity.roomCode)) {
        throw new Error("ROOM_PROVISIONING_REUSE_ENFORCED_BY_COORDINATOR_STATE");
      }
      roomIds.add(identity.roomId);
      roomCodes.add(identity.roomCode);
    }
    if ((reservation.receipt === null) !== (reservation.receiptPredecessorStateDigest === null)) {
      throw new Error("ROOM_RECEIPT_PREDECESSOR_BINDING_PRESENCE_INVALID");
    }
    if (reservation.receipt === null) {
      unfinished += 1;
    } else {
      const receipt = verifyExp0001aRoomProvisioningReceipt(reservation.receipt, attempt);
      if (receipt.coordinatorJournalDigest !== reservation.receiptPredecessorStateDigest
          || receipt.retainedAuthority.reservationId !== reservation.reservationId
          || canonicalJson(receipt.retainedAuthority) !== canonicalJson({
            reservationId: reservation.reservationId,
            createReleasedAt: reservation.createReleasedAt,
            roomNonce: reservation.roomNonce,
            roomTitle: reservation.roomTitle,
            createResolution: reservation.createRoom === null
              ? "private_recent_room_reconciliation" : "direct_result",
            createRoom: reservation.createRoom,
            recentRoomsReconciliation: reservation.recentRoomsReconciliation,
            blankBaselineRead: reservation.blankBaselineRead,
            seedCall: reservation.seedCall,
            preAuthorRead: reservation.preAuthorRead,
            inviteJoin: reservation.inviteJoin,
            inviteRead: reservation.inviteRead,
            coordinatorPresenceRead: reservation.coordinatorPresenceRead,
          })) {
        throw new Error("ROOM_RECEIPT_NOT_BOUND_TO_PRECEDING_COORDINATOR_JOURNAL_HEAD");
      }
    }
  }
  if (unfinished > 1) throw new Error("MULTIPLE_UNFINISHED_ROOM_RESERVATIONS_FORBIDDEN");
  return deepFreeze(state);
}

function sealCoordinatorState(
  input: z.input<typeof coordinatorStateContentSchema>,
  plan: Exp0001aAttemptProvisioningPlanSet,
): Exp0001aProvisioningCoordinatorState {
  const content = coordinatorStateContentSchema.parse(input);
  return verifyCoordinatorState({ ...content, stateDigest: hashCanonicalJson(content) }, plan);
}

export type Exp0001aNextProvisioningAction =
  | Readonly<{ kind: "reserve_next_attempt"; assignmentId: string; attemptId: string; plannedIndex: number }>
  | Readonly<{ kind: "release_reserved_create_room"; assignmentId: string; reservationId: string }>
  | Readonly<{
    kind: "invoke_released_create_room";
    assignmentId: string;
    reservationId: string;
    command: BrowserWebMcpCommand<typeof ROOM_CREATE_TOOL, Readonly<{
      displayName: typeof COORDINATOR_DISPLAY_NAME;
      title: string;
    }>>;
    ambiguityReconciliationCommand: BrowserWebMcpCommand<typeof RECENT_ROOMS_TOOL, Readonly<Record<string, never>>>;
  }>
  | Readonly<{ kind: "retain_blank_baseline_read"; assignmentId: string }>
  | Readonly<{ kind: "retain_declared_seed_result"; assignmentId: string }>
  | Readonly<{ kind: "retain_pre_author_read"; assignmentId: string }>
  | Readonly<{ kind: "retain_invite_join_result"; assignmentId: string }>
  | Readonly<{ kind: "retain_invite_read"; assignmentId: string }>
  | Readonly<{ kind: "retain_coordinator_presence_read"; assignmentId: string }>
  | Readonly<{ kind: "stop_provisioner_presence_renewals"; assignmentId: string }>
  | Readonly<{ kind: "finalize_room_receipt"; assignmentId: string }>
  | Readonly<{ kind: "release_author_handoff"; assignmentId: string }>
  | Readonly<{ kind: "await_scheduler_progress"; assignmentId: string }>
  | Readonly<{ kind: "paused_for_usage_limit" }>
  | Readonly<{ kind: "complete" }>;

export function nextExp0001aProvisioningAction(
  stateInput: unknown,
): Exp0001aNextProvisioningAction {
  const plan = createExp0001aAttemptProvisioningPlan();
  const state = verifyCoordinatorState(stateInput, plan);
  const reservation = state.reservations.find((candidate) => candidate.receipt === null);
  if (!reservation) {
    const next = nextExp0001aCodexAssignment(state.scheduler);
    if (next.kind === "paused") return { kind: "paused_for_usage_limit" };
    if (next.kind === "complete") return { kind: "complete" };
    if (next.kind === "awaiting_terminal") return { kind: "await_scheduler_progress", assignmentId: next.assignment.assignmentId };
    const existing = state.reservations.find((candidate) => candidate.assignmentId === next.assignment.assignmentId);
    return existing
      ? { kind: "release_author_handoff", assignmentId: existing.assignmentId }
      : {
        kind: "reserve_next_attempt",
        assignmentId: next.assignment.assignmentId,
        attemptId: next.assignment.attemptId,
        plannedIndex: next.assignment.plannedIndex,
      };
  }
  const attempt = plan.attempts[reservation.plannedIndex]!;
  if (reservation.createReleasedAt === null) {
    return { kind: "release_reserved_create_room", assignmentId: reservation.assignmentId, reservationId: reservation.reservationId };
  }
  if (reservation.createRoom === null && reservation.recentRoomsReconciliation === null) {
    return {
      kind: "invoke_released_create_room",
      assignmentId: reservation.assignmentId,
      reservationId: reservation.reservationId,
      command: {
        ...attempt.room.create,
        input: { displayName: COORDINATOR_DISPLAY_NAME, title: reservation.roomTitle },
        purpose: "Execute this exact pre-reserved opaque room nonce once; on an ambiguous result use only the committed private-session reconciliation command.",
      },
      ambiguityReconciliationCommand: attempt.room.reconcileAmbiguousCreate,
    };
  }
  if (reservation.blankBaselineRead === null) return { kind: "retain_blank_baseline_read", assignmentId: reservation.assignmentId };
  if (attempt.room.seed !== null && reservation.seedCall === null) return { kind: "retain_declared_seed_result", assignmentId: reservation.assignmentId };
  if (reservation.preAuthorRead === null) return { kind: "retain_pre_author_read", assignmentId: reservation.assignmentId };
  if (reservation.inviteJoin === null) return { kind: "retain_invite_join_result", assignmentId: reservation.assignmentId };
  if (reservation.inviteRead === null) return { kind: "retain_invite_read", assignmentId: reservation.assignmentId };
  if (reservation.coordinatorPresenceRead === null) return { kind: "retain_coordinator_presence_read", assignmentId: reservation.assignmentId };
  if (reservation.renewalsStoppedAt === null) return { kind: "stop_provisioner_presence_renewals", assignmentId: reservation.assignmentId };
  return { kind: "finalize_room_receipt", assignmentId: reservation.assignmentId };
}

export type Exp0001aProvisioningExternalSession = "coordinator" | "invite_verifier";
export type Exp0001aProvisioningExternalCommand =
  | BrowserWebMcpCommand<typeof ROOM_CREATE_TOOL, Readonly<{
    displayName: typeof COORDINATOR_DISPLAY_NAME;
    title: string;
  }>>
  | BrowserWebMcpCommand<typeof RECENT_ROOMS_TOOL, Readonly<Record<string, never>>>
  | BrowserWebMcpCommand<typeof ROOM_READ_TOOL, Readonly<Record<string, never>>>
  | BrowserWebMcpCommand<typeof ROOM_SEED_TOOL, BenchmarkCanvasTransactionInput>
  | BrowserWebMcpCommand<typeof COLLABORATION_READ_TOOL, Readonly<Record<string, never>>>
  | BrowserWebMcpCommand<typeof ROOM_JOIN_TOOL, Readonly<{
    code: string;
    displayName: typeof INVITE_VERIFIER_DISPLAY_NAME;
    role: "spectator";
  }>>;

export type Exp0001aProjectedProvisioningAction =
  | Readonly<{
    kind: "external_webmcp_command";
    actionKind:
      | "invoke_released_create_room"
      | "retain_blank_baseline_read"
      | "retain_declared_seed_result"
      | "retain_pre_author_read"
      | "retain_invite_join_result"
      | "retain_invite_read"
      | "retain_coordinator_presence_read";
    assignmentId: string;
    session: Exp0001aProvisioningExternalSession;
    command: Exp0001aProvisioningExternalCommand;
    retainMethod:
      | "retainCreateRoomResult"
      | "reconcileAmbiguousCreate"
      | "retainBlankBaselineRead"
      | "retainSeedResult"
      | "retainPreAuthorRead"
      | "retainInviteJoinResult"
      | "retainInviteRead"
      | "retainCoordinatorPresenceRead";
    ambiguityReconciliation: Readonly<{
      command: BrowserWebMcpCommand<typeof RECENT_ROOMS_TOOL, Readonly<Record<string, never>>>;
      retainMethod: "reconcileAmbiguousCreate";
      createRetryAllowed: false;
    }> | null;
  }>
  | Readonly<{
    kind: "coordinator_transition";
    action: Exp0001aNextProvisioningAction;
    coordinatorMethod:
      | "reserveNextAttempt"
      | "releaseReservedCreateRoomCommand"
      | "stopProvisionerPresenceRenewals"
      | "finalizeRoomReceipt"
      | "createAuthorHandoff"
      | null;
  }>;

/**
 * Pure projection from durable coordinator state to the exact next external
 * command and the only method allowed to retain its raw result. `create_room`
 * is projected only after `releaseReservedCreateRoomCommand` has durably
 * recorded the one-shot release. The same action commits a private-session
 * reconciliation fallback, so an ambiguous create is reconciled without ever
 * re-emitting the mutating command.
 */
export function projectNextExp0001aProvisioningAction(
  stateInput: unknown,
): Exp0001aProjectedProvisioningAction {
  const plan = createExp0001aAttemptProvisioningPlan();
  const state = verifyCoordinatorState(stateInput, plan);
  const action = nextExp0001aProvisioningAction(state);
  if (!("assignmentId" in action)) {
    return deepFreeze({ kind: "coordinator_transition", action, coordinatorMethod: null });
  }
  const reservation = state.reservations.find((candidate) => candidate.assignmentId === action.assignmentId);
  const attempt = reservation === undefined ? undefined : plan.attempts[reservation.plannedIndex];
  const external = (
    session: Exp0001aProvisioningExternalSession,
    command: Exp0001aProvisioningExternalCommand,
    retainMethod: Extract<Exp0001aProjectedProvisioningAction, { kind: "external_webmcp_command" }>["retainMethod"],
    ambiguityReconciliation: Extract<Exp0001aProjectedProvisioningAction, { kind: "external_webmcp_command" }>["ambiguityReconciliation"] = null,
  ): Exp0001aProjectedProvisioningAction => deepFreeze({
    kind: "external_webmcp_command",
    actionKind: action.kind as Extract<Exp0001aProjectedProvisioningAction, { kind: "external_webmcp_command" }>["actionKind"],
    assignmentId: action.assignmentId,
    session,
    command,
    retainMethod,
    ambiguityReconciliation,
  });

  switch (action.kind) {
    case "invoke_released_create_room":
      return external("coordinator", action.command, "retainCreateRoomResult", {
        command: action.ambiguityReconciliationCommand,
        retainMethod: "reconcileAmbiguousCreate",
        createRetryAllowed: false,
      });
    case "retain_blank_baseline_read":
      if (!attempt) throw new Error("PROVISIONING_RESERVATION_NOT_FOUND");
      return external("coordinator", attempt.room.readBlankBaseline, "retainBlankBaselineRead");
    case "retain_declared_seed_result":
      if (!attempt?.room.seed) throw new Error("DECLARED_SEED_COMMAND_NOT_FOUND");
      return external("coordinator", attempt.room.seed, "retainSeedResult");
    case "retain_pre_author_read":
      if (!attempt) throw new Error("PROVISIONING_RESERVATION_NOT_FOUND");
      return external("coordinator", attempt.room.readPreAuthorState, "retainPreAuthorRead");
    case "retain_invite_join_result": {
      if (!attempt || !reservation || (reservation.createRoom === null && reservation.recentRoomsReconciliation === null)) {
        throw new Error("ROOM_CREATE_RESULT_OR_PRIVATE_RECONCILIATION_REQUIRED");
      }
      const room = roomIdentityFromAuthority({
        roomNonce: reservation.roomNonce,
        roomTitle: reservation.roomTitle,
        createResolution: reservation.createRoom === null
          ? "private_recent_room_reconciliation" : "direct_result",
        createRoom: reservation.createRoom,
        recentRoomsReconciliation: reservation.recentRoomsReconciliation,
      }, attempt);
      return external("invite_verifier", {
        transport: attempt.room.verifyInviteJoin.transport,
        origin: attempt.room.verifyInviteJoin.origin,
        toolName: attempt.room.verifyInviteJoin.toolName,
        input: {
          code: room.roomCode,
          displayName: attempt.room.verifyInviteJoin.displayName,
          role: attempt.room.verifyInviteJoin.role,
        },
        purpose: attempt.room.verifyInviteJoin.purpose,
      }, "retainInviteJoinResult");
    }
    case "retain_invite_read":
      if (!attempt) throw new Error("PROVISIONING_RESERVATION_NOT_FOUND");
      return external("invite_verifier", attempt.room.verifyInviteRead, "retainInviteRead");
    case "retain_coordinator_presence_read":
      if (!attempt) throw new Error("PROVISIONING_RESERVATION_NOT_FOUND");
      return external("coordinator", attempt.room.readCoordinatorPresenceLease, "retainCoordinatorPresenceRead");
    case "reserve_next_attempt":
      return deepFreeze({ kind: "coordinator_transition", action, coordinatorMethod: "reserveNextAttempt" });
    case "release_reserved_create_room":
      return deepFreeze({ kind: "coordinator_transition", action, coordinatorMethod: "releaseReservedCreateRoomCommand" });
    case "stop_provisioner_presence_renewals":
      return deepFreeze({ kind: "coordinator_transition", action, coordinatorMethod: "stopProvisionerPresenceRenewals" });
    case "finalize_room_receipt":
      return deepFreeze({ kind: "coordinator_transition", action, coordinatorMethod: "finalizeRoomReceipt" });
    case "release_author_handoff":
      return deepFreeze({ kind: "coordinator_transition", action, coordinatorMethod: "createAuthorHandoff" });
    case "await_scheduler_progress":
      return deepFreeze({ kind: "coordinator_transition", action, coordinatorMethod: null });
    default:
      throw new Error("UNREACHABLE_PROVISIONING_ACTION");
  }
}

function retainedToolResult(input: Readonly<{
  toolName: Exp0001aRetainedWebMcpToolResult["toolName"];
  session: Exp0001aRetainedWebMcpToolResult["session"];
  request: unknown;
  rawResult: unknown;
  observedAt: string;
}>): Exp0001aRetainedWebMcpToolResult {
  const rawResult = exactJson(input.rawResult);
  const envelope = z.object({ ok: z.literal(true), tool: z.literal(input.toolName), data: z.unknown() })
    .strict().parse(rawResult);
  void envelope;
  return deepFreeze(retainedToolResultSchema.parse({
    toolName: input.toolName,
    session: input.session,
    observedAt: input.observedAt,
    requestDigest: hashCanonicalJson(input.request),
    resultDigest: hashCanonicalJson(rawResult),
    rawResult,
  }));
}

function assertSchedulerProgression(
  before: Exp0001aCodexSchedulerState,
  after: Exp0001aCodexSchedulerState,
): void {
  if (after.currentUsageWindow < before.currentUsageWindow
      || after.usageLimitInterruptions.length < before.usageLimitInterruptions.length
      || after.usageResets.length < before.usageResets.length) {
    throw new Error("PROVISIONING_SCHEDULER_ROLLBACK_FORBIDDEN");
  }
  const ranks = { unstarted: 0, begun: 1, completed: 2, terminal: 3 } as const;
  before.assignments.forEach((assignment, index) => {
    const next = after.assignments[index]!;
    if (ranks[next.state] < ranks[assignment.state]) throw new Error("PROVISIONING_ASSIGNMENT_STATE_ROLLBACK_FORBIDDEN");
    for (const field of ["usageWindow", "begunAt", "completedAt", "terminalAt", "terminalOutcome", "codexTaskId", "threadId"] as const) {
      if (assignment[field] !== null && next[field] !== assignment[field]) {
        throw new Error("PROVISIONING_SCHEDULER_RETAINED_FIELD_CHANGED");
      }
    }
  });
}

export type Exp0001aProvisioningCoordinator = Readonly<{
  initialize: () => Promise<Exp0001aProvisioningCoordinatorState>;
  read: () => Promise<Exp0001aProvisioningCoordinatorState>;
  synchronizeScheduler: (scheduler: Exp0001aCodexSchedulerState) => Promise<Exp0001aProvisioningCoordinatorState>;
  reserveNextAttempt: (input: Readonly<{
    spikeGate: unknown;
    spikeEvidence: unknown;
    spikeFreshness?: CodexWebMcpSpikeFreshnessContext;
  }>) => Promise<Readonly<{
    state: Exp0001aProvisioningCoordinatorState;
    attempt: Exp0001aAttemptProvisioningPlan;
    reservationId: string;
  }>>;
  releaseReservedCreateRoomCommand: (assignmentId: string) => Promise<Readonly<{
    state: Exp0001aProvisioningCoordinatorState;
    session: "coordinator";
    createCommand: BrowserWebMcpCommand<typeof ROOM_CREATE_TOOL, Readonly<{
      displayName: typeof COORDINATOR_DISPLAY_NAME;
      title: string;
    }>>;
    retainMethod: "retainCreateRoomResult";
    ambiguousResultMethod: "reconcileAmbiguousCreate";
  }>>;
  retainCreateRoomResult: (assignmentId: string, rawResult: unknown) => Promise<Exp0001aProvisioningCoordinatorState>;
  reconcileAmbiguousCreate: (assignmentId: string, rawListRecentRoomsResult: unknown) => Promise<Exp0001aProvisioningCoordinatorState>;
  retainBlankBaselineRead: (assignmentId: string, rawResult: unknown) => Promise<Exp0001aProvisioningCoordinatorState>;
  retainSeedResult: (assignmentId: string, rawResult: unknown) => Promise<Exp0001aProvisioningCoordinatorState>;
  retainPreAuthorRead: (assignmentId: string, rawResult: unknown) => Promise<Exp0001aProvisioningCoordinatorState>;
  retainInviteJoinResult: (assignmentId: string, rawResult: unknown) => Promise<Exp0001aProvisioningCoordinatorState>;
  retainInviteRead: (assignmentId: string, rawResult: unknown) => Promise<Exp0001aProvisioningCoordinatorState>;
  retainCoordinatorPresenceRead: (assignmentId: string, rawResult: unknown) => Promise<Exp0001aProvisioningCoordinatorState>;
  stopProvisionerPresenceRenewals: (assignmentId: string) => Promise<Exp0001aProvisioningCoordinatorState>;
  finalizeRoomReceipt: (assignmentId: string) => Promise<Readonly<{
    state: Exp0001aProvisioningCoordinatorState;
    receipt: Exp0001aRoomProvisioningReceipt;
  }>>;
  createAuthorHandoff: (assignmentId: string) => Promise<Exp0001aAuthorProvisioningHandoff>;
}>;

export function createExp0001aProvisioningCoordinator(options: Readonly<{
  filePath: string;
  plan?: unknown;
  scheduler?: Exp0001aCodexSchedulerState;
  now?: () => string;
  createRoomNonce?: () => string;
}>): Exp0001aProvisioningCoordinator {
  const planVerification = verifyExp0001aAttemptProvisioningPlan(options.plan ?? createExp0001aAttemptProvisioningPlan());
  if (!planVerification.ok) throw new Error(`Invalid EXP-0001A provisioning plan: ${planVerification.errors.join(", ")}`);
  const plan = planVerification.plan;
  const initialScheduler = assertSchedulerBoundToPlan(
    options.scheduler ?? createExp0001aProvisioningScheduler(plan),
    plan,
  );
  const now = options.now ?? (() => new Date().toISOString());
  const nonce = options.createRoomNonce ?? (() => `rn_${randomBytes(16).toString("hex")}`);
  const initialState = sealCoordinatorState({
    schemaVersion: EXP0001A_PROVISIONING_COORDINATOR_VERSION,
    protocolId: "EXP-0001A",
    planDigest: plan.planDigest,
    scheduleDigest: plan.scheduleDigest,
    scheduler: initialScheduler,
    reservations: [],
  }, plan);
  const store = createAtomicRegistryStore<Exp0001aProvisioningCoordinatorState>({
    filePath: options.filePath,
    validate: (value) => verifyCoordinatorState(value, plan),
    identity: (value) => value.stateDigest,
    now,
  });

  const mutate = async (
    update: (state: Exp0001aProvisioningCoordinatorState) => Exp0001aProvisioningCoordinatorState,
  ): Promise<Exp0001aProvisioningCoordinatorState> => {
    const current = await store.read();
    const next = update(current);
    return store.persist(next, current.stateDigest);
  };
  const updateReservation = async (
    assignmentId: string,
    update: (reservation: Exp0001aProvisioningReservation, attempt: Exp0001aAttemptProvisioningPlan) => Exp0001aProvisioningReservation,
  ) => mutate((state) => {
    const reservation = state.reservations.find((candidate) => candidate.assignmentId === assignmentId);
    if (!reservation) throw new Error("PROVISIONING_RESERVATION_NOT_FOUND");
    if (reservation.receipt !== null) throw new Error("FINALIZED_PROVISIONING_RESERVATION_IS_IMMUTABLE");
    const attempt = plan.attempts[reservation.plannedIndex]!;
    const content = withoutDigest(state, "stateDigest");
    return sealCoordinatorState({
      ...content,
      reservations: state.reservations.map((candidate) => candidate.assignmentId === assignmentId
        ? update(candidate, attempt)
        : candidate),
    }, plan);
  });
  const requireRoomIdentity = (reservation: Exp0001aProvisioningReservation, attempt: Exp0001aAttemptProvisioningPlan) => {
    if (reservation.createRoom === null && reservation.recentRoomsReconciliation === null) {
      throw new Error("ROOM_CREATE_RESULT_OR_PRIVATE_RECONCILIATION_REQUIRED");
    }
    return roomIdentityFromAuthority({
      roomNonce: reservation.roomNonce,
      roomTitle: reservation.roomTitle,
      createResolution: reservation.createRoom === null
        ? "private_recent_room_reconciliation" : "direct_result",
      createRoom: reservation.createRoom,
      recentRoomsReconciliation: reservation.recentRoomsReconciliation,
    }, attempt);
  };

  return {
    initialize: () => store.initialize(initialState),
    read: () => store.read(),
    synchronizeScheduler: async (schedulerInput) => {
      const scheduler = assertSchedulerBoundToPlan(schedulerInput, plan);
      return mutate((state) => {
        assertSchedulerProgression(state.scheduler, scheduler);
        return sealCoordinatorState({ ...withoutDigest(state, "stateDigest"), scheduler }, plan);
      });
    },
    reserveNextAttempt: async (input) => {
      const current = await store.read();
      const attempt = releaseNextExp0001aProvisioningAttempt({
        plan,
        scheduler: current.scheduler,
        spikeGate: input.spikeGate,
        spikeEvidence: input.spikeEvidence,
        spikeFreshness: input.spikeFreshness,
      });
      if (current.reservations.some((reservation) => reservation.assignmentId === attempt.assignmentId)) {
        throw new Error("EXACT_NEXT_ASSIGNMENT_ALREADY_HAS_A_ROOM_RESERVATION");
      }
      if (current.reservations.some((reservation) => reservation.receipt === null)) {
        throw new Error("PREVIOUS_ROOM_RESERVATION_NOT_FINALIZED");
      }
      const roomNonce = nonce();
      if (!ROOM_NONCE_PATTERN.test(roomNonce)) throw new Error("ROOM_NONCE_FACTORY_RETURNED_INVALID_NONCE");
      const roomTitle = `${attempt.room.title} ${roomNonce}`;
      const reservation = coordinatorReservationSchema.parse({
        reservationId: `reservation-${attempt.assignmentId}`,
        assignmentId: attempt.assignmentId,
        attemptId: attempt.attemptId,
        plannedIndex: attempt.plannedIndex,
        attemptPlanDigest: attempt.attemptPlanDigest,
        reservedAt: timestampSchema.parse(now()),
        roomNonce,
        roomTitle,
        createReleasedAt: null,
        createRoom: null,
        recentRoomsReconciliation: null,
        blankBaselineRead: null,
        seedCall: null,
        preAuthorRead: null,
        inviteJoin: null,
        inviteRead: null,
        coordinatorPresenceRead: null,
        renewalsStoppedAt: null,
        receiptPredecessorStateDigest: null,
        receipt: null,
      });
      const next = sealCoordinatorState({
        ...withoutDigest(current, "stateDigest"),
        reservations: [...current.reservations, reservation],
      }, plan);
      const state = await store.persist(next, current.stateDigest);
      return deepFreeze({
        state,
        attempt,
        reservationId: reservation.reservationId,
      });
    },
    releaseReservedCreateRoomCommand: async (assignmentId) => {
      const current = await store.read();
      const reservation = current.reservations.find((candidate) => candidate.assignmentId === assignmentId);
      if (!reservation) throw new Error("PROVISIONING_RESERVATION_NOT_FOUND");
      if (reservation.createReleasedAt !== null || reservation.createRoom !== null
          || reservation.recentRoomsReconciliation !== null) {
        throw new Error("CREATE_ROOM_COMMAND_ALREADY_RELEASED_NO_RETRY_ALLOWED");
      }
      const attempt = plan.attempts[reservation.plannedIndex]!;
      const releasedAt = timestampSchema.parse(now());
      const next = sealCoordinatorState({
        ...withoutDigest(current, "stateDigest"),
        reservations: current.reservations.map((candidate) => candidate.assignmentId === assignmentId
          ? { ...candidate, createReleasedAt: releasedAt }
          : candidate),
      }, plan);
      const state = await store.persist(next, current.stateDigest);
      return deepFreeze({
        state,
        session: "coordinator" as const,
        createCommand: {
          ...attempt.room.create,
          input: { displayName: COORDINATOR_DISPLAY_NAME, title: reservation.roomTitle },
          purpose: "Execute this exact pre-reserved opaque room nonce once; on an ambiguous result use only the private-session reconciliation command.",
        },
        retainMethod: "retainCreateRoomResult" as const,
        ambiguousResultMethod: "reconcileAmbiguousCreate" as const,
      });
    },
    retainCreateRoomResult: (assignmentId, rawResult) => updateReservation(assignmentId, (reservation) => {
      if (reservation.createReleasedAt === null) throw new Error("CREATE_ROOM_COMMAND_WAS_NOT_DURABLY_RELEASED");
      if (reservation.createRoom !== null || reservation.recentRoomsReconciliation !== null) {
        throw new Error("CREATE_ROOM_RESULT_ALREADY_RESOLVED_NO_RETRY_ALLOWED");
      }
      return {
        ...reservation,
        createRoom: retainedToolResult({
          toolName: ROOM_CREATE_TOOL,
          session: "coordinator",
          request: { displayName: COORDINATOR_DISPLAY_NAME, title: reservation.roomTitle },
          rawResult,
          observedAt: timestampSchema.parse(now()),
        }),
      };
    }),
    reconcileAmbiguousCreate: (assignmentId, rawResult) => updateReservation(assignmentId, (reservation) => {
      if (reservation.createReleasedAt === null) throw new Error("CREATE_ROOM_COMMAND_WAS_NOT_DURABLY_RELEASED");
      if (reservation.createRoom !== null || reservation.recentRoomsReconciliation !== null) {
        throw new Error("CREATE_ROOM_RESULT_ALREADY_RESOLVED_NO_RETRY_ALLOWED");
      }
      return {
        ...reservation,
        recentRoomsReconciliation: retainedToolResult({
          toolName: RECENT_ROOMS_TOOL,
          session: "coordinator",
          request: {},
          rawResult,
          observedAt: timestampSchema.parse(now()),
        }),
      };
    }),
    retainBlankBaselineRead: (assignmentId, rawResult) => updateReservation(assignmentId, (reservation, attempt) => {
      requireRoomIdentity(reservation, attempt);
      if (reservation.blankBaselineRead !== null) throw new Error("BLANK_BASELINE_ALREADY_RETAINED");
      return { ...reservation, blankBaselineRead: retainedToolResult({
        toolName: ROOM_READ_TOOL,
        session: "coordinator",
        request: attempt.room.readBlankBaseline.input,
        rawResult,
        observedAt: timestampSchema.parse(now()),
      }) };
    }),
    retainSeedResult: (assignmentId, rawResult) => updateReservation(assignmentId, (reservation, attempt) => {
      if (attempt.room.seed === null) throw new Error("BLANK_ATTEMPT_FORBIDS_SEED_MUTATION");
      if (reservation.blankBaselineRead === null || reservation.seedCall !== null) {
        throw new Error("SEED_RESULT_REQUIRES_ONE_RETAINED_BLANK_BASELINE");
      }
      return { ...reservation, seedCall: retainedToolResult({
        toolName: ROOM_SEED_TOOL,
        session: "coordinator",
        request: attempt.room.seed.input,
        rawResult,
        observedAt: timestampSchema.parse(now()),
      }) };
    }),
    retainPreAuthorRead: (assignmentId, rawResult) => updateReservation(assignmentId, (reservation, attempt) => {
      if (reservation.blankBaselineRead === null
          || (attempt.room.seed !== null && reservation.seedCall === null)
          || reservation.preAuthorRead !== null) {
        throw new Error("PREAUTHOR_READ_REQUIRES_EXACT_DECLARED_CANVAS_TRANSITION");
      }
      return { ...reservation, preAuthorRead: retainedToolResult({
        toolName: ROOM_READ_TOOL,
        session: "coordinator",
        request: attempt.room.readPreAuthorState.input,
        rawResult,
        observedAt: timestampSchema.parse(now()),
      }) };
    }),
    retainInviteJoinResult: (assignmentId, rawResult) => updateReservation(assignmentId, (reservation, attempt) => {
      if (reservation.preAuthorRead === null || reservation.inviteJoin !== null) {
        throw new Error("INVITE_JOIN_REQUIRES_RETAINED_PREAUTHOR_STATE");
      }
      const room = requireRoomIdentity(reservation, attempt);
      return { ...reservation, inviteJoin: retainedToolResult({
        toolName: ROOM_JOIN_TOOL,
        session: "invite_verifier",
        request: { code: room.roomCode, displayName: INVITE_VERIFIER_DISPLAY_NAME, role: "spectator" },
        rawResult,
        observedAt: timestampSchema.parse(now()),
      }) };
    }),
    retainInviteRead: (assignmentId, rawResult) => updateReservation(assignmentId, (reservation, attempt) => {
      if (reservation.inviteJoin === null || reservation.inviteRead !== null) {
        throw new Error("INVITE_READ_REQUIRES_RETAINED_JOIN_RESULT");
      }
      return { ...reservation, inviteRead: retainedToolResult({
        toolName: ROOM_READ_TOOL,
        session: "invite_verifier",
        request: attempt.room.verifyInviteRead.input,
        rawResult,
        observedAt: timestampSchema.parse(now()),
      }) };
    }),
    retainCoordinatorPresenceRead: (assignmentId, rawResult) => updateReservation(assignmentId, (reservation, attempt) => {
      if (reservation.inviteRead === null || reservation.coordinatorPresenceRead !== null) {
        throw new Error("PRESENCE_READ_REQUIRES_RETAINED_INVITE_READ");
      }
      return { ...reservation, coordinatorPresenceRead: retainedToolResult({
        toolName: COLLABORATION_READ_TOOL,
        session: "coordinator",
        request: attempt.room.readCoordinatorPresenceLease.input,
        rawResult,
        observedAt: timestampSchema.parse(now()),
      }) };
    }),
    stopProvisionerPresenceRenewals: (assignmentId) => updateReservation(assignmentId, (reservation) => {
      if (reservation.coordinatorPresenceRead === null || reservation.renewalsStoppedAt !== null) {
        throw new Error("PRESENCE_RENEWAL_STOP_REQUIRES_EXACT_RETAINED_PRESENCE_READ");
      }
      return { ...reservation, renewalsStoppedAt: timestampSchema.parse(now()) };
    }),
    finalizeRoomReceipt: async (assignmentId) => {
      const current = await store.read();
      const reservation = current.reservations.find((candidate) => candidate.assignmentId === assignmentId);
      if (!reservation) throw new Error("PROVISIONING_RESERVATION_NOT_FOUND");
      if (reservation.receipt !== null) throw new Error("ROOM_PROVISIONING_RECEIPT_ALREADY_FINALIZED");
      if (reservation.blankBaselineRead === null || reservation.preAuthorRead === null
          || reservation.inviteJoin === null || reservation.inviteRead === null
          || reservation.coordinatorPresenceRead === null || reservation.renewalsStoppedAt === null
          || (reservation.createRoom === null && reservation.recentRoomsReconciliation === null)) {
        throw new Error("ROOM_PROVISIONING_AUTHORITY_RESULTS_INCOMPLETE");
      }
      const attempt = plan.attempts[reservation.plannedIndex]!;
      const receipt = deriveRoomProvisioningReceipt(attempt, plan.planDigest, {
        provisionedAt: timestampSchema.parse(now()),
        coordinatorJournalDigest: current.stateDigest,
        renewalsStoppedAt: reservation.renewalsStoppedAt,
        authority: {
          reservationId: reservation.reservationId,
          createReleasedAt: reservation.createReleasedAt!,
          roomNonce: reservation.roomNonce,
          roomTitle: reservation.roomTitle,
          createResolution: reservation.createRoom === null
            ? "private_recent_room_reconciliation" : "direct_result",
          createRoom: reservation.createRoom,
          recentRoomsReconciliation: reservation.recentRoomsReconciliation,
          blankBaselineRead: reservation.blankBaselineRead,
          seedCall: reservation.seedCall,
          preAuthorRead: reservation.preAuthorRead,
          inviteJoin: reservation.inviteJoin,
          inviteRead: reservation.inviteRead,
          coordinatorPresenceRead: reservation.coordinatorPresenceRead,
        },
      });
      const next = sealCoordinatorState({
        ...withoutDigest(current, "stateDigest"),
        reservations: current.reservations.map((candidate) => candidate.assignmentId === assignmentId
          ? { ...candidate, receiptPredecessorStateDigest: current.stateDigest, receipt }
          : candidate),
      }, plan);
      const state = await store.persist(next, current.stateDigest);
      return deepFreeze({ state, receipt });
    },
    createAuthorHandoff: async (assignmentId) => {
      const state = await store.read();
      const reservation = state.reservations.find((candidate) => candidate.assignmentId === assignmentId);
      if (!reservation?.receipt) throw new Error("FINALIZED_ROOM_RECEIPT_REQUIRED_BEFORE_AUTHOR_HANDOFF");
      const next = nextExp0001aCodexAssignment(state.scheduler);
      if (next.kind !== "ready" || next.assignment.assignmentId !== assignmentId
          || next.assignment.attemptId !== reservation.attemptId
          || next.assignment.plannedIndex !== reservation.plannedIndex) {
        throw new Error("AUTHOR_HANDOFF_NOT_BOUND_TO_EXACT_NEXT_SCHEDULER_ASSIGNMENT");
      }
      return createExp0001aAuthorProvisioningHandoff(
        plan.attempts[reservation.plannedIndex]!,
        reservation.receipt,
        timestampSchema.parse(now()),
      );
    },
  };
}

export type Exp0001aAuthorProvisioningHandoff = Readonly<{
  schemaVersion: typeof EXP0001A_AUTHOR_HANDOFF_VERSION;
  kind: "exp-0001a-author-provisioning-handoff";
  trustedBinding: Readonly<{
    assignmentId: string;
    attemptId: string;
    plannedIndex: number;
    planDigest: string;
    attemptPlanDigest: string;
    roomReceiptDigest: string;
    roomId: string;
    roomAccessBindingDigest: string;
    publicAuthorPacketDigest: string;
    authorReleaseAt: string;
    coordinatorPresenceExpiredBeforeRelease: true;
  }>;
  authorVisible: Readonly<{
    publicTaskPacket: PublicAuthorPacket;
    renderedPublicBrief: string;
    privateRoomInviteUrl: string;
  }>;
  handoffDigest: string;
}>;

/**
 * Private boundary consumed by the canonical Codex task transport. Only the
 * `authorVisible` member may be rendered into the author task; task identity,
 * create_thread lifecycle, and all-role isolation receipts belong to that
 * transport rather than this room-provisioning module.
 */
export function createExp0001aAuthorProvisioningHandoff(
  attempt: Exp0001aAttemptProvisioningPlan,
  roomReceiptInput: unknown,
  authorReleaseAt: string,
): Exp0001aAuthorProvisioningHandoff {
  const plan = createExp0001aAttemptProvisioningPlan();
  const frozenAttempt = plan.attempts[attempt.plannedIndex];
  if (!frozenAttempt || hashCanonicalJson(frozenAttempt) !== hashCanonicalJson(attempt)) {
    throw new Error("AUTHOR_HANDOFF_ATTEMPT_NOT_FROZEN_EXPECTATION");
  }
  const roomReceipt = verifyExp0001aRoomProvisioningReceipt(roomReceiptInput, attempt);
  if (roomReceipt.planDigest !== plan.planDigest) throw new Error("AUTHOR_HANDOFF_PLAN_BINDING_INVALID");
  timestampSchema.parse(authorReleaseAt);
  if (Date.parse(authorReleaseAt) < Date.parse(roomReceipt.coordinatorPresence.authorReleaseNotBefore)) {
    throw new Error("COORDINATOR_PRESENCE_NOT_EXPIRED_BEFORE_AUTHOR_RELEASE");
  }
  const content = {
    schemaVersion: EXP0001A_AUTHOR_HANDOFF_VERSION,
    kind: "exp-0001a-author-provisioning-handoff" as const,
    trustedBinding: {
      assignmentId: attempt.assignmentId,
      attemptId: attempt.attemptId,
      plannedIndex: attempt.plannedIndex,
      planDigest: plan.planDigest,
      attemptPlanDigest: attempt.attemptPlanDigest,
      roomReceiptDigest: roomReceipt.receiptDigest,
      roomId: roomReceipt.room.roomId,
      roomAccessBindingDigest: roomReceipt.room.accessBindingDigest,
      publicAuthorPacketDigest: attempt.publicAuthorPacketDigest,
      authorReleaseAt,
      coordinatorPresenceExpiredBeforeRelease: true,
    },
    authorVisible: {
      publicTaskPacket: structuredClone(attempt.publicAuthorPacket),
      renderedPublicBrief: renderPublicAuthorBrief(attempt.publicAuthorPacket),
      privateRoomInviteUrl: roomReceipt.room.inviteUrl,
    },
  } as const;
  return deepFreeze({ ...content, handoffDigest: hashCanonicalJson(content) });
}

export function verifyExp0001aAuthorProvisioningHandoff(
  input: unknown,
): Exp0001aAuthorProvisioningHandoff {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("AUTHOR_PROVISIONING_HANDOFF_NOT_AN_OBJECT");
  }
  const handoff = input as Exp0001aAuthorProvisioningHandoff;
  if (handoff.schemaVersion !== EXP0001A_AUTHOR_HANDOFF_VERSION
      || handoff.kind !== "exp-0001a-author-provisioning-handoff"
      || handoff.trustedBinding === null || typeof handoff.trustedBinding !== "object"
      || handoff.authorVisible === null || typeof handoff.authorVisible !== "object") {
    throw new Error("AUTHOR_PROVISIONING_HANDOFF_SHAPE_INVALID");
  }
  digestSchema.parse(handoff.handoffDigest);
  if (handoff.handoffDigest !== hashCanonicalJson(withoutDigest(handoff, "handoffDigest"))) {
    throw new Error("AUTHOR_PROVISIONING_HANDOFF_DIGEST_INVALID");
  }
  const plan = createExp0001aAttemptProvisioningPlan();
  const plannedIndex = nonNegativeIntegerSchema.parse(handoff.trustedBinding.plannedIndex);
  const attempt = plan.attempts[plannedIndex];
  if (!attempt || handoff.trustedBinding.assignmentId !== attempt.assignmentId
      || handoff.trustedBinding.attemptId !== attempt.attemptId
      || handoff.trustedBinding.planDigest !== plan.planDigest
      || handoff.trustedBinding.attemptPlanDigest !== attempt.attemptPlanDigest
      || handoff.trustedBinding.publicAuthorPacketDigest !== attempt.publicAuthorPacketDigest
      || handoff.trustedBinding.coordinatorPresenceExpiredBeforeRelease !== true) {
    throw new Error("AUTHOR_PROVISIONING_HANDOFF_FROZEN_BINDING_INVALID");
  }
  timestampSchema.parse(handoff.trustedBinding.authorReleaseAt);
  digestSchema.parse(handoff.trustedBinding.roomReceiptDigest);
  roomIdSchema.parse(handoff.trustedBinding.roomId);
  digestSchema.parse(handoff.trustedBinding.roomAccessBindingDigest);
  if (hashCanonicalJson(handoff.authorVisible.publicTaskPacket) !== attempt.publicAuthorPacketDigest
      || canonicalJson(handoff.authorVisible.publicTaskPacket) !== canonicalJson(attempt.publicAuthorPacket)
      || handoff.authorVisible.renderedPublicBrief !== renderPublicAuthorBrief(attempt.publicAuthorPacket)
      || handoff.trustedBinding.roomAccessBindingDigest !== computePrivateRoomAccessBinding({
        privateRoomUrl: handoff.authorVisible.privateRoomInviteUrl,
        roomId: handoff.trustedBinding.roomId,
      })) {
    throw new Error("AUTHOR_PROVISIONING_HANDOFF_VISIBLE_OR_ROOM_BINDING_INVALID");
  }
  assertExp0001aAuthorVisibleInputUnmodified(handoff.authorVisible, handoff);
  return deepFreeze(handoff);
}

export function assertExp0001aAuthorVisibleInputUnmodified(
  candidate: unknown,
  handoff: Exp0001aAuthorProvisioningHandoff,
): void {
  const plan = createExp0001aAttemptProvisioningPlan();
  const attempt = plan.attempts[handoff.trustedBinding.plannedIndex];
  if (!attempt || handoff.trustedBinding.assignmentId !== attempt.assignmentId
      || handoff.trustedBinding.attemptId !== attempt.attemptId
      || handoff.trustedBinding.planDigest !== plan.planDigest
      || handoff.trustedBinding.attemptPlanDigest !== attempt.attemptPlanDigest
      || hashCanonicalJson(candidate) !== hashCanonicalJson({
        publicTaskPacket: attempt.publicAuthorPacket,
        renderedPublicBrief: renderPublicAuthorBrief(attempt.publicAuthorPacket),
        privateRoomInviteUrl: handoff.authorVisible.privateRoomInviteUrl,
      })) {
    throw new Error("AUTHOR_VISIBLE_INPUT_CONTAINS_UNDECLARED_CONTEXT");
  }
  const serialized = JSON.stringify(candidate);
  if (/\b(?:A0|A1)\b|attempt-[a-z0-9-]+|pair-[a-z0-9-]+|"(?:x|y|width|height)"\s*:/i.test(serialized)) {
    throw new Error("AUTHOR_VISIBLE_INPUT_LEAKS_CONDITION_IDENTITY_OR_PREPARED_COORDINATES");
  }
}

export type Exp0001aPublicProvisioningCommitment = Readonly<{
  schemaVersion: 1;
  kind: "public-exp-0001a-provisioning-commitment";
  protocolId: "EXP-0001A";
  manifestDigest: string;
  benchmarkBundleDigest: string;
  scheduleDigest: string;
  planDigest: string;
  attemptCount: 48;
  policy: Readonly<{
    freshPrivateRoomPerAttempt: true;
    browserExposedWebMcpOnly: true;
    roomEnumerationForbidden: true;
    privateRecentRoomReconciliationOnly: true;
    privateBindingsPublished: false;
  }>;
}>;

export function createPublicExp0001aProvisioningCommitment(
  planInput: unknown = createExp0001aAttemptProvisioningPlan(),
): Exp0001aPublicProvisioningCommitment {
  const verification = verifyExp0001aAttemptProvisioningPlan(planInput);
  if (!verification.ok) throw new Error(`Invalid EXP-0001A provisioning plan: ${verification.errors.join(", ")}`);
  return deepFreeze({
    schemaVersion: 1,
    kind: "public-exp-0001a-provisioning-commitment",
    protocolId: "EXP-0001A",
    manifestDigest: verification.plan.manifestDigest,
    benchmarkBundleDigest: verification.plan.benchmarkBundleDigest,
    scheduleDigest: verification.plan.scheduleDigest,
    planDigest: verification.plan.planDigest,
    attemptCount: 48,
    policy: {
      freshPrivateRoomPerAttempt: true,
      browserExposedWebMcpOnly: true,
      roomEnumerationForbidden: true,
      privateRecentRoomReconciliationOnly: true,
      privateBindingsPublished: false,
    },
  });
}
