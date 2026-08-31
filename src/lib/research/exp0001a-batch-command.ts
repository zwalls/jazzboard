import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { createAtomicRegistryStore, type AtomicRegistryStore } from "./atomic-registry-store";
import { attemptRegistrySchema, type AttemptRegistry } from "./attempt-schemas";
import { retainedAttemptResult } from "./clean-room-batch-executor";
import {
  blindedReviewPlanSchema,
  verifyBlindedReviewPlan,
  type BlindedReviewPlan,
} from "./blinded-review-orchestration";
import {
  batchRegistrySchema,
  computeExp0001aEffectiveAliasVerificationRoot,
  computeActualProviderTurnCost,
  determineSafeResume,
  runExp0001aBatch,
  summarizeBatchDenominator,
  verifyExp0001aBatchRegistry,
  type BatchAttemptExecutor,
  type BatchRegistry,
  type BatchRegistryEvent,
  type Exp0001aBatchPlan,
} from "./exp0001a-batch-coordinator";
import {
  EXP0001A_AUTHOR_SESSION_IDENTITIES,
  exp0001aAuthorIdentityCommitments,
} from "./exp0001a-author-identities";
import {
  EXP0001A_EXPERIMENT_FREEZE_ADAPTER_SOURCE_PATH,
  verifyExp0001aAdapterPrebriefSource,
  verifyExp0001aExecutionFreezeAdapterReceipt,
  type Exp0001aAdapterPrebriefSource,
  type Exp0001aExperimentFreezeAdapterReceipt,
} from "./exp0001a-experiment-freeze-adapter";
import {
  computeNoBriefEvidenceDigest,
  verifyExp0001aExecutionReadyReceipt,
  exp0001aNoBriefEvidenceSchema,
  type Exp0001aExecutionReadyReceipt,
  type Exp0001aNoBriefEvidence,
} from "./exp0001a-execution-gate";
import {
  EXP0001A_REGISTRY_BRIDGE_SOURCE_PATH,
  bridgeExp0001aBatchRegistry,
  verifyExp0001aRegistryBridge,
  type Exp0001aRegistryBridgeReceipt,
} from "./exp0001a-registry-bridge";
import type { Exp0001aPerAttemptAliasVerifier } from "./exp0001a-per-attempt-alias-verifier";
import {
  createExp0001aSpendLedger,
  type Exp0001aSpendLedger,
  type Exp0001aSpendReservation,
  type Exp0001aSpendSummary,
} from "./exp0001a-spend-ledger";
import { canonicalJson, hashCanonicalJson, sha256Digest, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const idSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z.string().datetime({ offset: true });
const safeRelativePathSchema = z.string().min(1).max(1_024).superRefine((value, context) => {
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    context.addIssue({ code: "custom", message: "Expected a normalized repository-relative path." });
  }
});

export const EXP0001A_BATCH_COMMAND_SOURCE_PATH = "src/lib/research/exp0001a-batch-command.ts" as const;
export const EXP0001A_BATCH_CLI_SOURCE_PATH = "research/scripts/exp0001a-batch-command.mjs" as const;
export const EXP0001A_LIVE_REVIEW_RUNNER_SOURCE_PATH = "src/lib/research/exp0001a-live-review-runner.ts" as const;

const exactAuthorizationSchema = z.object({
  executionReadyReceiptDigest: digestSchema,
  spendAuthorizationReceiptDigest: digestSchema,
  authorizationId: idSchema,
  releaseLockToken: z.string().min(32).max(4_096),
}).strict();

export type ExactBatchAuthorization = z.infer<typeof exactAuthorizationSchema>;

const committedRuntimeFileSchema = z.object({
  path: safeRelativePathSchema,
  bytes: z.union([z.string(), z.instanceof(Uint8Array)]),
}).strict();

export type CommittedRuntimeFile = z.infer<typeof committedRuntimeFileSchema>;

const reviewPhaseReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("exp-0001a-review-phase-complete"),
  protocolId: z.literal("EXP-0001A"),
  completedAt: timestampSchema,
  authorBatchRegistryDigest: digestSchema,
  effectiveAliasVerificationRoot: digestSchema,
  sealedAttemptRegistryRoot: digestSchema,
  registryBridgeReceiptDigest: digestSchema,
  denominator: z.literal(48),
  primaryReviewRecords: z.literal(96),
  primaryReviewRecordRoot: digestSchema,
  adjudicationReviewRecords: z.number().int().min(0).max(48),
  adjudicationReviewRecordRoot: digestSchema,
  classificationCount: z.literal(48),
  reviewPlanRoot: digestSchema,
  reviewLedgerRoot: digestSchema,
  classificationRoot: digestSchema,
  reviewAggregateIndexRoot: digestSchema,
  pairwiseExactRenderCatalogRoot: digestSchema,
  pairwiseExactRenderVerificationReceiptRoot: digestSchema,
  pairwisePreferenceDenominator: z.literal(24),
  pairwisePlanRoot: digestSchema,
  pairwisePreferenceRecords: z.literal(24),
  pairwisePreferenceRecordRoot: digestSchema,
  pairwiseLedgerRoot: digestSchema,
  pairwiseLedgerSealRoot: digestSchema,
  pairwiseReportRoot: digestSchema,
  reviewProgressRoot: digestSchema,
  spendLedgerRoot: digestSchema,
  spendExternalAnchorRoot: digestSchema,
  spendExternalAnchorCount: z.number().int().nonnegative(),
  spendAuthorizationReceiptDigest: digestSchema,
  authorizedMaximumUsd: z.number().finite().positive(),
  userAuthorizedMaximumUsd: z.number().finite().positive(),
  frozenProtocolMaximumUsd: z.number().finite().positive(),
  observedProviderCostUsd: z.number().finite().nonnegative(),
  unobservableProviderExposureUsd: z.number().finite().nonnegative(),
  totalChargedExposureUsd: z.number().finite().nonnegative(),
}).strict();

export const reviewPhaseReceiptSchema = reviewPhaseReceiptContentSchema.extend({ receiptDigest: digestSchema }).strict();
export type ReviewPhaseReceipt = z.infer<typeof reviewPhaseReceiptSchema>;

const reviewPhaseBegunSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("exp-0001a-review-phase-begun"),
  protocolId: z.literal("EXP-0001A"),
  begunAt: timestampSchema,
  authorBatchRegistryDigest: digestSchema,
  sealedAttemptRegistryRoot: digestSchema,
  registryBridgeReceiptDigest: digestSchema,
  reviewPlanRoot: digestSchema,
}).strict();

const reviewStageSchema = z.enum(["primary", "adjudication", "pairwise"]);
export type ReviewStage = z.infer<typeof reviewStageSchema>;

const reviewAmbiguousFailureRecordContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-ambiguous-review-failure/v1"),
  protocolId: z.literal("EXP-0001A"),
  stage: reviewStageSchema,
  workItemId: idSchema,
  originalBegunEventDigest: digestSchema,
  recordedAt: timestampSchema,
  status: z.literal("failed"),
  decision: z.null(),
  preference: z.null(),
  failure: z.object({
    stage: z.literal("resume_recovery"),
    code: z.literal("AMBIGUOUS_AFTER_BEGIN"),
    message: z.literal("Reviewer work began but no immutable result lock was retained; the work item is failed closed and is never invoked again."),
  }).strict(),
  usage: z.object({
    source: z.literal("unobservable_after_provider_release"),
    inputTokens: z.null(),
    outputTokens: z.null(),
    reasoningTokens: z.null(),
    totalTokens: z.null(),
    estimatedCostUsd: z.null(),
    conservativeReservedCostUsd: z.number().finite().positive(),
    spendReservationEventDigest: digestSchema,
  }).strict(),
}).strict();

export const reviewAmbiguousFailureRecordSchema = reviewAmbiguousFailureRecordContentSchema.extend({
  recordRoot: digestSchema,
}).strict();
export type ReviewAmbiguousFailureRecord = z.infer<typeof reviewAmbiguousFailureRecordSchema>;

const reviewPhaseEventContentSchema = z.discriminatedUnion("kind", [
  z.object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("EXP-0001A"),
    sequence: z.number().int().nonnegative(),
    previousEventDigest: digestSchema.nullable(),
    kind: z.literal("phase_begun"),
    at: timestampSchema,
    authorBatchRegistryDigest: digestSchema,
    sealedAttemptRegistryRoot: digestSchema,
    registryBridgeReceiptDigest: digestSchema,
    reviewPlanRoot: digestSchema,
    primaryWorkItemIds: z.array(idSchema).length(96),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("EXP-0001A"),
    sequence: z.number().int().nonnegative(),
    previousEventDigest: digestSchema.nullable(),
    kind: z.literal("stage_planned"),
    at: timestampSchema,
    stage: z.enum(["adjudication", "pairwise"]),
    planRoot: digestSchema,
    workItemIds: z.array(idSchema).max(48),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("EXP-0001A"),
    sequence: z.number().int().nonnegative(),
    previousEventDigest: digestSchema.nullable(),
    kind: z.literal("work_item_begun"),
    at: timestampSchema,
    stage: reviewStageSchema,
    workItemId: idSchema,
    spendReservationEventDigest: digestSchema,
    maximumCostUsd: z.number().finite().positive(),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("EXP-0001A"),
    sequence: z.number().int().nonnegative(),
    previousEventDigest: digestSchema.nullable(),
    kind: z.literal("work_item_locked"),
    at: timestampSchema,
    stage: reviewStageSchema,
    workItemId: idSchema,
    recordRoot: digestSchema,
    status: z.enum(["scored", "failed"]),
    spendSettlementEventDigest: digestSchema.nullable(),
    costObservability: z.enum(["observed", "attested_no_provider_call", "unobservable"]),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("EXP-0001A"),
    sequence: z.number().int().nonnegative(),
    previousEventDigest: digestSchema.nullable(),
    kind: z.literal("work_item_ambiguous_failed"),
    at: timestampSchema,
    stage: reviewStageSchema,
    workItemId: idSchema,
    failureRecord: reviewAmbiguousFailureRecordSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("EXP-0001A"),
    sequence: z.number().int().nonnegative(),
    previousEventDigest: digestSchema.nullable(),
    kind: z.literal("classifications_locked"),
    at: timestampSchema,
    count: z.literal(48),
    reviewLedgerRoot: digestSchema,
    classificationRoot: digestSchema,
  }).strict(),
]);

type ReviewPhaseEventContent = z.infer<typeof reviewPhaseEventContentSchema>;
type WithEventDigest<T> = T extends unknown ? T & { eventDigest: string } : never;
export type ReviewPhaseEvent = WithEventDigest<ReviewPhaseEventContent>;

export const reviewPhaseEventSchema: z.ZodType<ReviewPhaseEvent> = z.intersection(
  reviewPhaseEventContentSchema,
  z.object({ eventDigest: digestSchema }).strict(),
) as z.ZodType<ReviewPhaseEvent>;

export type ReviewPhaseResumeState = {
  phaseBegun: boolean;
  reviewPlanRoot: string | null;
  progressRoot: string;
  plannedStages: ReviewStage[];
  expectedWorkItemIds: Record<ReviewStage, string[]>;
  pendingWorkItemIds: Record<ReviewStage, string[]>;
  resolvedWorkItems: Array<{
    stage: ReviewStage;
    workItemId: string;
    recordRoot: string;
    status: "scored" | "failed";
    ambiguousAfterBegin: boolean;
  }>;
  classification: { reviewLedgerRoot: string; classificationRoot: string } | null;
};

export type ReviewPhaseControls = {
  readSpendSummary(): Promise<BatchSpendSummary>;
  onReviewPhaseBegun(input: { at: string; reviewPlan: BlindedReviewPlan }): Promise<ReviewPhaseResumeState>;
  onReviewStagePlanned(input: {
    at: string;
    stage: "adjudication" | "pairwise";
    planRoot: string;
    workItemIds: string[];
  }): Promise<ReviewPhaseResumeState>;
  onReviewWorkItemBegun(input: {
    at: string;
    stage: ReviewStage;
    workItemId: string;
    maximumCostUsd: number;
    budgetDigest: string;
    pricingDigest: string;
  }): Promise<ReviewPhaseResumeState>;
  onReviewWorkItemLocked(input: {
    at: string;
    stage: ReviewStage;
    workItemId: string;
    recordRoot: string;
    status: "scored" | "failed";
    spend: {
      observability: "observed";
      actualCostUsd: number;
      usageDigest: string;
      providerReceiptDigest: string;
    } | {
      observability: "unobservable";
    } | {
      observability: "attested_no_provider_call";
    };
  }): Promise<ReviewPhaseResumeState>;
  onClassificationsLocked(input: {
    at: string;
    reviewLedgerRoot: string;
    classificationRoot: string;
    count: 48;
  }): Promise<ReviewPhaseResumeState>;
};

export type ReviewWorkItemSpend = Parameters<ReviewPhaseControls["onReviewWorkItemLocked"]>[0]["spend"];

export type ReviewPhaseRunnerInput = {
  plan: Exp0001aBatchPlan;
  authorBatchRegistry: BatchRegistry;
  sealedAttemptRegistry: AttemptRegistry;
  registryBridgeReceipt: Exp0001aRegistryBridgeReceipt;
  spendAuthorizationReceiptDigest: string;
  resume: ReviewPhaseResumeState;
  retainedAmbiguousFailures: ReviewAmbiguousFailureRecord[];
};

export type ActiveReviewWorkItem = {
  stage: ReviewStage;
  workItemId: string;
  begunAt: string;
  begunEventDigest: string;
  spendReservationEventDigest: string;
  maximumCostUsd: number;
};

export type RecoveredReviewWorkItem = {
  lockedAt: string;
  recordRoot: string;
  status: "scored" | "failed";
  spend: ReviewWorkItemSpend;
};

export type ReviewPhaseRunner = ((
  input: ReviewPhaseRunnerInput,
  controls: ReviewPhaseControls,
) => Promise<unknown>) & {
  /** Read-only crash reconciliation. It must never invoke a provider. */
  recoverActiveWorkItem?: (
    input: ReviewPhaseRunnerInput & { active: ActiveReviewWorkItem },
  ) => Promise<RecoveredReviewWorkItem | null>;
};

export type ExclusiveExecutionLock = <T>(metadata: Record<string, unknown>, operation: () => Promise<T>) => Promise<T>;

/** Separately trusted policy verifier; self-hashed receipts are not execution authority. */
export type BatchExecutionAuthorityVerifier = {
  policyDigest: string;
  verify(input: {
    ready: Exp0001aExecutionReadyReceipt;
    noBrief: Exp0001aNoBriefEvidence;
    exactAuthorization: ExactBatchAuthorization;
  }): Promise<boolean>;
};

export type BatchCommandPaths = {
  registryFile: string;
  outputRoot: string;
  prebriefIncidentRoot: string;
  executionLockFile: string;
  sealedAttemptRegistryFile: string;
  registryBridgeReceiptFile: string;
  reviewPlanFile: string;
  reviewProgressRoot: string;
  spendProgressRoot: string;
  reviewPhaseBegunFile: string;
  reviewReceiptFile: string;
};

export type Exp0001aBatchCommandOptions = {
  mode?: "dry-run" | "execute";
  plan: Exp0001aBatchPlan;
  initialRegistry: BatchRegistry;
  initialRegistryFileBytes: string | Uint8Array;
  prebriefFreeze: unknown;
  executionFreezeAdapterReceipt: unknown;
  executionReadyReceipt: unknown;
  noBriefEvidence: unknown;
  committedRuntimeFiles: readonly CommittedRuntimeFile[];
  exactAuthorization?: ExactBatchAuthorization;
  paths: BatchCommandPaths;
  executor?: BatchAttemptExecutor;
  aliasVerifier?: Exp0001aPerAttemptAliasVerifier;
  reviewRunner?: ReviewPhaseRunner;
  executionAuthority?: BatchExecutionAuthorityVerifier;
  now?: () => string;
  registryStore?: AtomicRegistryStore<BatchRegistry>;
  withExecutionLock?: ExclusiveExecutionLock;
};

export type BatchCommandPreflight = {
  ok: boolean;
  errors: string[];
  executionReadyDigest: string | null;
  sourcePrebriefFreezeDigest: string | null;
  freezeAdapterReceiptDigest: string | null;
  initialRegistryDigest: string;
  manifestAttemptIds: string[];
  authorIdentityManifestRoot: string;
};

export type Exp0001aBatchCommandResult = {
  mode: "dry-run" | "execute";
  status: "dry_run" | "awaiting_resume" | "awaiting_analysis" | "hard_stopped";
  preflight: BatchCommandPreflight;
  registry: BatchRegistry;
  invokedAttemptIds: string[];
  archivedPrebriefIncident: string | null;
  registryBridgeReceipt: Exp0001aRegistryBridgeReceipt | null;
  reviewReceipt: ReviewPhaseReceipt | null;
  spend: BatchSpendSummary | null;
};

export type BatchSpendSummary = Exp0001aSpendSummary & {
  userAuthorizedMaximumUsd: number;
  frozenProtocolMaximumUsd: number;
};

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

export function computeReviewPhaseReceiptDigest(receipt: ReviewPhaseReceipt): string {
  return hashCanonicalJson(withoutKey(receipt as unknown as Record<string, unknown>, "receiptDigest"));
}

export function computeReviewPhaseEventDigest(event: ReviewPhaseEvent): string {
  return hashCanonicalJson(withoutKey(event as unknown as Record<string, unknown>, "eventDigest"));
}

export function computeReviewProgressRoot(events: readonly ReviewPhaseEvent[]): string {
  return hashCanonicalJson({
    schemaVersion: 1,
    protocolId: "EXP-0001A",
    eventDigests: events.map((event) => event.eventDigest),
  });
}

function primaryWorkItemIds(plan: BlindedReviewPlan): string[] {
  verifyBlindedReviewPlan(plan);
  const ids = plan.artifacts.flatMap((artifact) => artifact.primaryWorkItems.map((item) => item.workItemId));
  if (plan.denominator !== 48 || ids.length !== 96 || new Set(ids).size !== ids.length) {
    throw new Error("EXP-0001A review plan must commit exactly two unique primary work items for all 48 artifacts.");
  }
  return ids;
}

type ReviewProgressAnalysis = {
  state: ReviewPhaseResumeState;
  active: Extract<ReviewPhaseEvent, { kind: "work_item_begun" }> | null;
  events: ReviewPhaseEvent[];
  ambiguousFailures: ReviewAmbiguousFailureRecord[];
};

function resolvedRecordRoot(input: {
  stage: ReviewStage;
  workItemId: string;
  recordRoot: string;
  status: "scored" | "failed";
  ambiguousAfterBegin: boolean;
}): string {
  return hashCanonicalJson(input);
}

function analyzeReviewProgress(rawEvents: readonly ReviewPhaseEvent[]): ReviewProgressAnalysis {
  const events = rawEvents.map((event) => reviewPhaseEventSchema.parse(event));
  let previous: string | null = null;
  let phase: Extract<ReviewPhaseEvent, { kind: "phase_begun" }> | null = null;
  let active: Extract<ReviewPhaseEvent, { kind: "work_item_begun" }> | null = null;
  let classification: ReviewPhaseResumeState["classification"] = null;
  const expected: Record<ReviewStage, string[]> = { primary: [], adjudication: [], pairwise: [] };
  const resolved = new Map<string, ReviewPhaseResumeState["resolvedWorkItems"][number]>();
  const ambiguousFailures: ReviewAmbiguousFailureRecord[] = [];
  const plannedStages = new Set<ReviewStage>();

  events.forEach((event, sequence) => {
    if (event.sequence !== sequence || event.previousEventDigest !== previous
        || computeReviewPhaseEventDigest(event) !== event.eventDigest) {
      throw new Error("Review progress event sequence, hash chain, or digest is invalid.");
    }
    previous = event.eventDigest;
    if (event.kind === "phase_begun") {
      if (sequence !== 0 || phase !== null || new Set(event.primaryWorkItemIds).size !== 96) {
        throw new Error("Review progress must begin exactly once with the fixed 96-primary denominator.");
      }
      phase = event;
      expected.primary = [...event.primaryWorkItemIds];
      plannedStages.add("primary");
      return;
    }
    if (phase === null) throw new Error("Review work cannot precede the durable phase-begun event.");
    if (event.kind === "stage_planned") {
      if (plannedStages.has(event.stage) || active !== null || new Set(event.workItemIds).size !== event.workItemIds.length) {
        throw new Error(`Review stage ${event.stage} is duplicated, ambiguous, or contains duplicate work items.`);
      }
      const existingIds = new Set(Object.values(expected).flat());
      if (event.workItemIds.some((id) => existingIds.has(id))) throw new Error("Review work-item identities must be unique across stages.");
      if (event.stage === "adjudication") {
        if (event.workItemIds.length > 48 || expected.primary.some((id) => !resolved.has(`primary:${id}`))) {
          throw new Error("Adjudication planning requires the complete fixed primary denominator first.");
        }
      } else if (event.workItemIds.length !== 24 || classification === null) {
        throw new Error("Pairwise planning requires 24 fixed pairs after all individual classifications lock.");
      }
      expected[event.stage] = [...event.workItemIds];
      plannedStages.add(event.stage);
      return;
    }
    if (event.kind === "work_item_begun") {
      const key = `${event.stage}:${event.workItemId}`;
      if (!plannedStages.has(event.stage) || !expected[event.stage].includes(event.workItemId)
          || resolved.has(key) || active !== null) {
        throw new Error("Reviewer invocation is duplicated, out of manifest, or overlaps unresolved work.");
      }
      active = event;
      return;
    }
    if (event.kind === "work_item_locked") {
      if (!active || active.stage !== event.stage || active.workItemId !== event.workItemId) {
        throw new Error("A reviewer result lock lacks its unique durable begun event.");
      }
      const key = `${event.stage}:${event.workItemId}`;
      resolved.set(key, {
        stage: event.stage,
        workItemId: event.workItemId,
        recordRoot: event.recordRoot,
        status: event.status,
        ambiguousAfterBegin: false,
      });
      active = null;
      return;
    }
    if (event.kind === "work_item_ambiguous_failed") {
      if (!active || active.stage !== event.stage || active.workItemId !== event.workItemId) {
        throw new Error("An ambiguity failure must resolve the one outstanding begun reviewer item.");
      }
      const failure = reviewAmbiguousFailureRecordSchema.parse(event.failureRecord);
      if (failure.stage !== event.stage || failure.workItemId !== event.workItemId
          || failure.originalBegunEventDigest !== active.eventDigest
          || hashCanonicalJson(withoutKey(failure as unknown as Record<string, unknown>, "recordRoot")) !== failure.recordRoot) {
        throw new Error("Ambiguous reviewer failure record is not bound to its original begun event.");
      }
      const key = `${event.stage}:${event.workItemId}`;
      resolved.set(key, {
        stage: event.stage,
        workItemId: event.workItemId,
        recordRoot: failure.recordRoot,
        status: "failed",
        ambiguousAfterBegin: true,
      });
      ambiguousFailures.push(failure);
      active = null;
      return;
    }
    if (event.kind === "classifications_locked") {
      if (classification !== null || active !== null || !plannedStages.has("adjudication")
          || expected.primary.some((id) => !resolved.has(`primary:${id}`))
          || expected.adjudication.some((id) => !resolved.has(`adjudication:${id}`))) {
        throw new Error("Individual classifications require all fixed primary and planned adjudication records first.");
      }
      classification = { reviewLedgerRoot: event.reviewLedgerRoot, classificationRoot: event.classificationRoot };
    }
  });

  const resolvedWorkItems = [...resolved.values()];
  const pending = (stage: ReviewStage) => expected[stage].filter((id) => !resolved.has(`${stage}:${id}`)
    && !(active?.stage === stage && active.workItemId === id));
  const retainedPhase = events.find((event): event is Extract<ReviewPhaseEvent, { kind: "phase_begun" }> => event.kind === "phase_begun") ?? null;
  return {
    events,
    active,
    ambiguousFailures,
    state: {
      phaseBegun: retainedPhase !== null,
      reviewPlanRoot: retainedPhase?.reviewPlanRoot ?? null,
      progressRoot: computeReviewProgressRoot(events),
      plannedStages: [...plannedStages],
      expectedWorkItemIds: expected,
      pendingWorkItemIds: {
        primary: pending("primary"),
        adjudication: pending("adjudication"),
        pairwise: pending("pairwise"),
      },
      resolvedWorkItems,
      classification,
    },
  };
}

function parseJsonBytes(bytes: string | Uint8Array): unknown {
  const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function validateAuthorIdentities(plan: Exp0001aBatchPlan, prebrief: Exp0001aAdapterPrebriefSource): string[] {
  const errors: string[] = [];
  const identities = exp0001aAuthorIdentityCommitments();
  const ordered = plan.configs.map((config) => ({
    attemptId: config.attempt.attemptId,
    identityCommitment: identities[config.attempt.attemptId],
  }));
  if (hashCanonicalJson(ordered) !== plan.authorIdentityCommitmentsDigest) errors.push("AUTHOR_IDENTITY_PLAN_DIGEST_MISMATCH");
  if (prebrief.frozenSources.authorSessionIdentityManifest.manifestRoot !== EXP0001A_AUTHOR_SESSION_IDENTITIES.manifestRoot) {
    errors.push("AUTHOR_IDENTITY_MANIFEST_ROOT_MISMATCH");
  }
  plan.configs.forEach((config, position) => {
    const expected = identities[config.attempt.attemptId];
    if (!expected || config.runnerConfig.authorIdentityCommitment !== expected) errors.push(`AUTHOR_IDENTITY_RUNNER_CONFIG_MISMATCH:${position}`);
    if (expected && (config.runnerConfig.brief.includes(expected)
      || /authorIdentityCommitment|author identity commitment/i.test(config.runnerConfig.brief))) {
      errors.push(`AUTHOR_IDENTITY_LEAKED_TO_BRIEF:${position}`);
    }
  });
  return errors;
}

function validateRuntimeSourceBindings(rawFiles: readonly CommittedRuntimeFile[], ready: Exp0001aExecutionReadyReceipt): string[] {
  const parsed = z.array(committedRuntimeFileSchema).min(1).safeParse(rawFiles);
  if (!parsed.success) return ["RUNTIME_SOURCE_BINDINGS_SCHEMA_INVALID"];
  const files = parsed.data;
  const errors: string[] = [];
  const bindings = ready.committedCode.sourceBindings;
  const expectedPaths = bindings.map((binding) => binding.path).sort();
  const actualPaths = files.map((file) => file.path).sort();
  if (new Set(actualPaths).size !== actualPaths.length) errors.push("RUNTIME_SOURCE_BINDINGS_DUPLICATED");
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) errors.push("RUNTIME_SOURCE_FILE_SET_MISMATCH");
  const required = [
    ["batchCli", EXP0001A_BATCH_CLI_SOURCE_PATH],
    ["batchCommandLibrary", EXP0001A_BATCH_COMMAND_SOURCE_PATH],
    ["liveReviewRunner", EXP0001A_LIVE_REVIEW_RUNNER_SOURCE_PATH],
    ["experimentFreezeAdapter", EXP0001A_EXPERIMENT_FREEZE_ADAPTER_SOURCE_PATH],
    ["batchRegistryBridge", EXP0001A_REGISTRY_BRIDGE_SOURCE_PATH],
  ] as const;
  for (const [role, expectedPath] of required) {
    const binding = bindings.find((candidate) => candidate.role === role);
    if (!binding || binding.path !== expectedPath) errors.push(`RUNTIME_ROLE_BINDING_MISMATCH:${role}`);
  }
  for (const file of files) {
    const binding = bindings.find((source) => source.path === file.path);
    if (!binding) errors.push(`RUNTIME_SOURCE_NOT_COMMITTED:${file.path}`);
    else if (binding.fileDigest !== sha256Digest(file.bytes)) errors.push(`RUNTIME_SOURCE_DIGEST_MISMATCH:${file.path}`);
  }
  return errors;
}

function validateCommandGate(options: Exp0001aBatchCommandOptions, now: string, requireExactAuthorization: boolean): {
  preflight: BatchCommandPreflight;
  ready: Exp0001aExecutionReadyReceipt | null;
  noBrief: Exp0001aNoBriefEvidence | null;
  prebrief: Exp0001aAdapterPrebriefSource | null;
  adapter: Exp0001aExperimentFreezeAdapterReceipt | null;
} {
  const errors: string[] = [];
  const readyVerification = verifyExp0001aExecutionReadyReceipt(options.executionReadyReceipt, now);
  const ready = readyVerification.ok ? readyVerification.receipt : null;
  if (!readyVerification.ok) errors.push(...readyVerification.errors.map((error) => `EXECUTION_GATE:${error}`));
  let prebrief: Exp0001aAdapterPrebriefSource | null = null;
  try {
    prebrief = verifyExp0001aAdapterPrebriefSource(options.prebriefFreeze);
  } catch (error) {
    errors.push(`PREBRIEF_FREEZE:${error instanceof Error ? error.message : String(error)}`);
  }
  let adapter: Exp0001aExperimentFreezeAdapterReceipt | null = null;
  if (ready && prebrief) {
    try {
      adapter = verifyExp0001aExecutionFreezeAdapterReceipt({
        receipt: options.executionFreezeAdapterReceipt,
        prebriefFreeze: prebrief,
        executionReadyReceipt: ready,
        now,
      });
      if (hashCanonicalJson(adapter.legacyExecutionFreeze) !== hashCanonicalJson(options.plan.executionFreeze)) {
        errors.push("PLAN_NOT_COMPILED_FROM_FREEZE_ADAPTER");
      }
    } catch (error) {
      errors.push(`FREEZE_ADAPTER:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const noBriefResult = exp0001aNoBriefEvidenceSchema.safeParse(options.noBriefEvidence);
  const noBrief = noBriefResult.success ? noBriefResult.data : null;
  if (!noBriefResult.success) errors.push("NO_BRIEF_EVIDENCE_SCHEMA_INVALID");
  if (ready) {
    if (prebrief && ready.freezeDigest !== prebrief.freezeDigest) errors.push("EXECUTION_GATE_FREEZE_MISMATCH");
    if (ready.baseline.deploymentId !== options.plan.livePreflight.resolvedDeploymentId) errors.push("EXECUTION_GATE_DEPLOYMENT_MISMATCH");
    if (ready.committedCode.authorSessionIdentityManifestRoot !== EXP0001A_AUTHOR_SESSION_IDENTITIES.manifestRoot) {
      errors.push("EXECUTION_GATE_AUTHOR_IDENTITY_MANIFEST_ROOT_MISMATCH");
    }
    errors.push(...validateRuntimeSourceBindings(options.committedRuntimeFiles, ready));
  }
  if (prebrief) errors.push(...validateAuthorIdentities(options.plan, prebrief));
  if (noBrief) {
    if (computeNoBriefEvidenceDigest(noBrief) !== noBrief.receiptDigest) errors.push("NO_BRIEF_EVIDENCE_DIGEST_MISMATCH");
    if (noBrief.registryDigest !== options.initialRegistry.registryDigest) errors.push("NO_BRIEF_INITIAL_REGISTRY_MISMATCH");
    try {
      if (sha256Digest(options.initialRegistryFileBytes) !== noBrief.registryFileDigest) errors.push("NO_BRIEF_REGISTRY_FILE_DIGEST_MISMATCH");
      if (canonicalJson(batchRegistrySchema.parse(parseJsonBytes(options.initialRegistryFileBytes))) !== canonicalJson(options.initialRegistry)) {
        errors.push("NO_BRIEF_REGISTRY_FILE_VALUE_MISMATCH");
      }
    } catch {
      errors.push("NO_BRIEF_REGISTRY_FILE_INVALID");
    }
    if (Date.parse(noBrief.releaseLock.expiresAt) <= Date.parse(now)) errors.push("NO_BRIEF_RELEASE_LOCK_EXPIRED");
    if (ready && noBrief.receiptDigest !== ready.noBriefEvidenceDigest) errors.push("NO_BRIEF_EXECUTION_GATE_MISMATCH");
  }
  if (requireExactAuthorization) {
    const authorization = exactAuthorizationSchema.safeParse(options.exactAuthorization);
    if (!authorization.success) errors.push("EXACT_AUTHORIZATION_MISSING_OR_INVALID");
    else if (ready && noBrief) {
      if (authorization.data.executionReadyReceiptDigest !== ready.receiptDigest) errors.push("EXACT_EXECUTION_READY_DIGEST_MISMATCH");
      if (authorization.data.spendAuthorizationReceiptDigest !== ready.spendAuthorization.receiptDigest) errors.push("EXACT_SPEND_AUTHORIZATION_DIGEST_MISMATCH");
      if (authorization.data.authorizationId !== ready.spendAuthorization.authorizationId) errors.push("EXACT_AUTHORIZATION_ID_MISMATCH");
      if (sha256Digest(authorization.data.releaseLockToken) !== noBrief.releaseLock.tokenDigest) errors.push("EXACT_RELEASE_LOCK_TOKEN_MISMATCH");
    }
  }
  return {
    preflight: {
      ok: errors.length === 0,
      errors,
      executionReadyDigest: ready?.receiptDigest ?? null,
      sourcePrebriefFreezeDigest: prebrief?.freezeDigest ?? null,
      freezeAdapterReceiptDigest: adapter?.receiptDigest ?? null,
      initialRegistryDigest: options.initialRegistry.registryDigest,
      manifestAttemptIds: options.plan.configs.map((config) => config.attempt.attemptId),
      authorIdentityManifestRoot: EXP0001A_AUTHOR_SESSION_IDENTITIES.manifestRoot,
    },
    ready,
    noBrief,
    prebrief,
    adapter,
  };
}

async function statNoFollow(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function requirePlainDirectory(directory: string, label: string): Promise<void> {
  const stat = await statNoFollow(directory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must already exist as a non-symbolic-link directory.`);
}

async function ensureIncidentAttemptDirectory(root: string, attemptId: string): Promise<string> {
  await requirePlainDirectory(root, "Pre-brief incident root");
  const directory = path.join(root, attemptId);
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  await requirePlainDirectory(directory, "Pre-brief incident attempt directory");
  return directory;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Moves pre-brief evidence append-only; no retained byte is deleted or rewritten. */
export async function archiveRecoverablePrebriefEvidence(input: {
  plan: Exp0001aBatchPlan;
  registry: BatchRegistry;
  outputRoot: string;
  incidentRoot: string;
}): Promise<string | null> {
  const registry = verifyExp0001aBatchRegistry(input.registry, input.plan);
  const resume = determineSafeResume(registry, input.plan);
  if (!resume.safe || resume.complete || resume.attemptId === null) return null;
  const incidents = registry.events.filter((event): event is Extract<BatchRegistryEvent, { kind: "not_started" }> => (
    event.kind === "not_started" && event.attemptId === resume.attemptId
  ));
  if (incidents.length === 0) return null;
  if (incidents.some((event) => event.data.hardIncident || event.data.falsification)) {
    throw new Error("Hard or falsification incidents cannot be normalized into a resumable pre-brief archive.");
  }
  await requirePlainDirectory(input.outputRoot, "Attempt output root");
  const incidentAttemptDirectory = await ensureIncidentAttemptDirectory(input.incidentRoot, resume.attemptId);
  const source = path.join(input.outputRoot, resume.attemptId);
  let archivedLatest: string | null = null;
  for (const [index, incident] of incidents.entries()) {
    const target = path.join(incidentAttemptDirectory, `prebrief-${incident.eventDigest.slice("sha256:".length)}`);
    const sourceStat = await statNoFollow(source);
    const targetStat = await statNoFollow(target);
    const isLatest = index === incidents.length - 1;
    if (!isLatest) {
      if (!targetStat || !targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        throw new Error(`Earlier pre-brief evidence is missing for ${resume.attemptId}; refusing an ambiguous resume.`);
      }
      continue;
    }
    if (sourceStat && targetStat) throw new Error("Both active and archived pre-brief evidence exist; refusing an ambiguous resume.");
    if (targetStat) {
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error("Archived pre-brief evidence is not a plain directory.");
      archivedLatest = target;
      continue;
    }
    if (!sourceStat || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error("Retained pre-brief evidence is missing or unsafe; refusing to reuse the fixed attempt ID.");
    }
    await rename(source, target);
    await syncDirectory(input.outputRoot);
    await syncDirectory(incidentAttemptDirectory);
    archivedLatest = target;
  }
  return archivedLatest;
}

async function assertAttemptOutputState(input: { plan: Exp0001aBatchPlan; registry: BatchRegistry; outputRoot: string }): Promise<void> {
  await requirePlainDirectory(input.outputRoot, "Attempt output root");
  const retained = new Set(input.registry.events.filter((event) => event.kind === "attempt_retained").map((event) => event.attemptId));
  for (const config of input.plan.configs) {
    const attemptPath = path.join(input.outputRoot, config.attempt.attemptId);
    const stat = await statNoFollow(attemptPath);
    if (retained.has(config.attempt.attemptId)) {
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Retained attempt evidence is missing or unsafe for ${config.attempt.attemptId}.`);
    } else if (stat) {
      throw new Error(`Unbegun attempt path already exists for ${config.attempt.attemptId}; refusing overwrite or ambiguous resume.`);
    }
  }
}

/**
 * Re-derives every retained author result from the immutable terminal bundle and
 * the exact retained artifact bytes. This is intentionally performed again on
 * resume and immediately before measurement release: the append-only registry
 * is a commitment to those bytes, not a substitute for their continued
 * existence or integrity.
 */
export async function verifyRetainedAttemptEvidence(input: {
  plan: Exp0001aBatchPlan;
  registry: BatchRegistry;
  outputRoot: string;
}): Promise<void> {
  const registry = verifyExp0001aBatchRegistry(input.registry, input.plan);
  const retainedEvents = registry.events.filter((event): event is Extract<BatchRegistryEvent, { kind: "attempt_retained" }> => (
    event.kind === "attempt_retained"
  ));
  for (const event of retainedEvents) {
    const config = input.plan.configs.find((candidate) => candidate.attempt.attemptId === event.attemptId);
    if (!config) throw new Error(`Retained attempt is not present in the frozen plan: ${event.attemptId}.`);
    const briefEvents = registry.events.filter((candidate): candidate is Extract<BatchRegistryEvent, { kind: "brief_delivered" }> => (
      candidate.kind === "brief_delivered" && candidate.attemptId === event.attemptId
    ));
    if (briefEvents.length !== 1) {
      throw new Error(`Retained attempt must have exactly one durable brief event: ${event.attemptId}.`);
    }
    const derived = await retainedAttemptResult(
      path.join(input.outputRoot, event.attemptId),
      event.attemptId,
      config.runnerConfig.authorIdentityCommitment,
      {
        requestedModelIdentifier: config.runnerConfig.model,
        requestedServiceTier: config.runnerConfig.serviceTier,
      },
      briefEvents[0].at,
    );
    const expectedData: Extract<BatchRegistryEvent, { kind: "attempt_retained" }>["data"] = {
      executorOutcome: derived.outcome,
      retainedOutcome: derived.outcome,
      usage: derived.usage,
      usageByTurn: derived.usageByTurn,
      pricing: input.plan.pricing,
      actualCostUsd: computeActualProviderTurnCost(derived.usageByTurn, input.plan.pricing),
      costObservability: derived.costObservability,
      providerEvidenceDigest: derived.providerEvidenceDigest,
      providerIdentity: derived.providerIdentity,
      artifacts: derived.artifacts,
      artifactRoot: derived.artifactRoot,
      authorEvidenceRoot: derived.authorEvidenceRoot,
      attemptBundleSha256: derived.attemptBundleSha256,
      authorIdentityCommitment: config.runnerConfig.authorIdentityCommitment,
      authorIdentityArtifactSha256: derived.authorIdentityArtifactSha256,
      missingArtifacts: [],
      duplicateArtifactPaths: [],
      evidenceComplete: true,
      hardIncident: derived.hardIncident,
      falsification: derived.falsification,
      incidentCode: derived.incidentCode,
    };
    if (canonicalJson(event.data) !== canonicalJson(expectedData)) {
      throw new Error(`Retained attempt registry binding differs from the re-derived terminal evidence: ${event.attemptId}.`);
    }
  }
}

export function createFileExclusiveExecutionLock(lockFile: string, now: () => string = () => new Date().toISOString()): ExclusiveExecutionLock {
  if (!path.isAbsolute(lockFile)) throw new Error("Execution lock path must be absolute.");
  return async (metadata, operation) => {
    let handle;
    try {
      handle = await open(lockFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("EXP-0001A execution lock already exists; refusing concurrent or uncertain execution.");
      throw error;
    }
    try {
      await handle.writeFile(`${canonicalJson({ schemaVersion: 1, acquiredAt: now(), pid: process.pid, ...metadata })}\n`);
      await handle.sync();
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      await unlink(lockFile).catch(() => {});
      await syncDirectory(path.dirname(lockFile)).catch(() => {});
    }
  };
}

async function readAttestedRegistry(input: {
  filePath: string;
  initialRegistry: BatchRegistry;
  initialRegistryFileBytes: string | Uint8Array;
  store: AtomicRegistryStore<BatchRegistry>;
}): Promise<BatchRegistry> {
  const snapshotStat = await statNoFollow(input.filePath);
  if (!snapshotStat) {
    throw new Error("The no-brief-attested registry file is absent; refusing to recreate execution authority.");
  }
  if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink()) {
    throw new Error("The no-brief-attested registry path must be a non-symbolic-link regular file.");
  }

  // The execution gate attests the exact initial snapshot bytes, while the
  // append-only journal is created only after execution authority is verified.
  // On first launch, prove the on-disk seed is byte-for-byte that attested
  // snapshot before allowing the store to create its journal genesis. On a
  // resume, the existing journal proves the immutable genesis and the current
  // snapshot is expected to have advanced.
  if (!await statNoFollow(`${input.filePath}.journal`)) {
    const handle = await open(input.filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let actualBytes: Buffer;
    try {
      actualBytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (!actualBytes.equals(Buffer.from(input.initialRegistryFileBytes))) {
      throw new Error("The no-brief-attested registry file bytes differ from the execution-ready evidence.");
    }
  }

  try {
    return await input.store.initialize(input.initialRegistry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("The no-brief-attested registry evidence is incomplete; refusing to recreate execution authority.");
    }
    throw error;
  }
}

async function retainJsonExclusive(filePath: string, value: unknown): Promise<void> {
  await requirePlainDirectory(path.dirname(filePath), `Parent directory for ${path.basename(filePath)}`);
  const handle = await open(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(canonicalJson(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
}

async function ensurePlainDirectory(directory: string, label: string): Promise<void> {
  await requirePlainDirectory(path.dirname(directory), `Parent directory for ${label}`);
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  await requirePlainDirectory(directory, label);
}

function reviewEventFileName(event: Pick<ReviewPhaseEvent, "sequence" | "kind">): string {
  return `${event.sequence.toString().padStart(6, "0")}-${event.kind}.json`;
}

async function loadReviewProgress(progressRoot: string): Promise<ReviewProgressAnalysis> {
  const stat = await statNoFollow(progressRoot);
  if (!stat) return analyzeReviewProgress([]);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Review progress root must be a plain append-only directory.");
  const names = (await readdir(progressRoot)).sort();
  const events: ReviewPhaseEvent[] = [];
  for (const name of names) {
    if (!/^\d{6}-[a-z_]+\.json$/.test(name)) throw new Error(`Unexpected entry in append-only review progress: ${name}`);
    const file = path.join(progressRoot, name);
    const stat = await statNoFollow(file);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe review progress event: ${name}`);
    const event = reviewPhaseEventSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (name !== reviewEventFileName(event)) throw new Error(`Review progress filename does not match its event: ${name}`);
    events.push(event);
  }
  return analyzeReviewProgress(events);
}

async function appendReviewProgressEvent(
  progressRoot: string,
  contentInput: Record<string, unknown>,
): Promise<ReviewProgressAnalysis> {
  await ensurePlainDirectory(progressRoot, "Review progress root");
  const current = await loadReviewProgress(progressRoot);
  const content = reviewPhaseEventContentSchema.parse({
    ...contentInput,
    schemaVersion: 1,
    protocolId: "EXP-0001A",
    sequence: current.events.length,
    previousEventDigest: current.events.at(-1)?.eventDigest ?? null,
  });
  const event = reviewPhaseEventSchema.parse({ ...content, eventDigest: hashCanonicalJson(content) });
  await retainJsonExclusive(path.join(progressRoot, reviewEventFileName(event)), event);
  return loadReviewProgress(progressRoot);
}

async function retainOrVerifyJson(filePath: string, expected: unknown, label: string): Promise<void> {
  const stat = await statNoFollow(filePath);
  if (!stat) {
    await retainJsonExclusive(filePath, expected);
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a plain retained file.`);
  const retained = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (canonicalJson(retained) !== canonicalJson(expected)) throw new Error(`${label} differs from the committed review evidence.`);
}

async function retainOrVerifyReviewPlan(filePath: string, planInput: BlindedReviewPlan, registryRoot: string): Promise<BlindedReviewPlan> {
  const plan = blindedReviewPlanSchema.parse(planInput);
  verifyBlindedReviewPlan(plan);
  if (plan.registryRoot !== registryRoot || plan.denominator !== 48) throw new Error("Review plan is bound to another registry or denominator.");
  primaryWorkItemIds(plan);
  await retainOrVerifyJson(filePath, plan, "Blinded review plan");
  return plan;
}

async function readRetainedReviewPlan(filePath: string, registryRoot: string): Promise<BlindedReviewPlan> {
  const stat = await statNoFollow(filePath);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error("Durable review progress lacks its retained blinded review plan.");
  return retainOrVerifyReviewPlan(filePath, blindedReviewPlanSchema.parse(JSON.parse(await readFile(filePath, "utf8"))), registryRoot);
}

async function retainOrVerifyBridge(input: {
  paths: BatchCommandPaths;
  plan: Exp0001aBatchPlan;
  batchRegistry: BatchRegistry;
  prebriefFreeze: Exp0001aAdapterPrebriefSource;
  adapter: Exp0001aExperimentFreezeAdapterReceipt;
}): Promise<{ registry: AttemptRegistry; receipt: Exp0001aRegistryBridgeReceipt }> {
  const expected = bridgeExp0001aBatchRegistry({
    plan: input.plan,
    batchRegistry: input.batchRegistry,
    prebriefFreeze: input.prebriefFreeze,
    freezeAdapterReceipt: input.adapter,
  });
  const registryStat = await statNoFollow(input.paths.sealedAttemptRegistryFile);
  const receiptStat = await statNoFollow(input.paths.registryBridgeReceiptFile);
  if (!registryStat && !receiptStat) {
    await retainJsonExclusive(input.paths.sealedAttemptRegistryFile, expected.registry);
    await retainJsonExclusive(input.paths.registryBridgeReceiptFile, expected.receipt);
    return expected;
  }
  if (!registryStat || !receiptStat || !registryStat.isFile() || registryStat.isSymbolicLink()
      || !receiptStat.isFile() || receiptStat.isSymbolicLink()) {
    throw new Error("Registry bridge is partial or unsafe; refusing an ambiguous review resume.");
  }
  return verifyExp0001aRegistryBridge({
    plan: input.plan,
    batchRegistry: input.batchRegistry,
    prebriefFreeze: input.prebriefFreeze,
    freezeAdapterReceipt: input.adapter,
    registry: attemptRegistrySchema.parse(JSON.parse(await readFile(input.paths.sealedAttemptRegistryFile, "utf8"))),
    receipt: JSON.parse(await readFile(input.paths.registryBridgeReceiptFile, "utf8")),
  });
}

function makeAmbiguousFailure(
  active: Extract<ReviewPhaseEvent, { kind: "work_item_begun" }>,
  reservation: Exp0001aSpendReservation,
  at: string,
): ReviewAmbiguousFailureRecord {
  if (reservation.eventDigest !== active.spendReservationEventDigest
      || reservation.callId !== `${active.stage}:${active.workItemId}`
      || reservation.phase !== active.stage
      || reservation.maximumCostUsd !== active.maximumCostUsd) {
    throw new Error("Ambiguous reviewer work is not bound to its exact spend reservation.");
  }
  const content = reviewAmbiguousFailureRecordContentSchema.parse({
    schemaVersion: "exp-0001a-ambiguous-review-failure/v1",
    protocolId: "EXP-0001A",
    stage: active.stage,
    workItemId: active.workItemId,
    originalBegunEventDigest: active.eventDigest,
    recordedAt: at,
    status: "failed",
    decision: null,
    preference: null,
    failure: {
      stage: "resume_recovery",
      code: "AMBIGUOUS_AFTER_BEGIN",
      message: "Reviewer work began but no immutable result lock was retained; the work item is failed closed and is never invoked again.",
    },
    usage: {
      source: "unobservable_after_provider_release",
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
      conservativeReservedCostUsd: reservation.maximumCostUsd,
      spendReservationEventDigest: reservation.eventDigest,
    },
  });
  return reviewAmbiguousFailureRecordSchema.parse({ ...content, recordRoot: hashCanonicalJson(content) });
}

async function failClosedUnresolvedReviewerWork(
  progressRoot: string,
  spendLedger: Exp0001aSpendLedger,
  at: string,
): Promise<ReviewProgressAnalysis> {
  let progress = await loadReviewProgress(progressRoot);
  if (!progress.active) return progress;
  const spend = await spendLedger.read();
  const reservation = spend.events.find((event): event is Exp0001aSpendReservation => (
    event.kind === "reservation" && event.eventDigest === progress.active!.spendReservationEventDigest
  ));
  if (!reservation || !spend.summary.pendingCallIds.includes(reservation.callId)) {
    throw new Error("Unresolved reviewer work lacks its pending conservative spend reservation.");
  }
  const failureRecord = makeAmbiguousFailure(progress.active, reservation, at);
  progress = await appendReviewProgressEvent(progressRoot, {
    kind: "work_item_ambiguous_failed",
    at,
    stage: progress.active.stage,
    workItemId: progress.active.workItemId,
    failureRecord,
  });
  return progress;
}

async function settleReviewWorkItemSpend(input: {
  spendLedger: Exp0001aSpendLedger;
  at: string;
  stage: ReviewStage;
  workItemId: string;
  spend: ReviewWorkItemSpend;
}) {
  return input.spend.observability === "observed"
    ? await input.spendLedger.settle({
      at: input.at,
      callId: `${input.stage}:${input.workItemId}`,
      phase: input.stage,
      observability: "observed",
      actualCostUsd: input.spend.actualCostUsd,
      usageDigest: input.spend.usageDigest,
      providerReceiptDigest: input.spend.providerReceiptDigest,
    })
    : input.spend.observability === "attested_no_provider_call"
      ? await input.spendLedger.settle({
        at: input.at,
        callId: `${input.stage}:${input.workItemId}`,
        phase: input.stage,
        observability: "attested_no_provider_call",
        actualCostUsd: 0,
        usageDigest: null,
        providerReceiptDigest: null,
      })
      : null;
}

export function computeReviewStageRecordRoot(state: ReviewPhaseResumeState, stage: ReviewStage): string {
  const byId = new Map(state.resolvedWorkItems.filter((item) => item.stage === stage).map((item) => [item.workItemId, item]));
  const records = state.expectedWorkItemIds[stage].map((workItemId) => {
    const item = byId.get(workItemId);
    if (!item) throw new Error(`Review stage ${stage} is incomplete.`);
    return {
      workItemId,
      recordRoot: item.recordRoot,
      status: item.status,
      ambiguousAfterBegin: item.ambiguousAfterBegin,
      resolvedRecordRoot: resolvedRecordRoot(item),
    };
  });
  return hashCanonicalJson({ schemaVersion: 1, stage, records });
}

async function retainReviewReceipt(filePath: string, rawReceipt: unknown, expected: {
  batchRegistryDigest: string;
  registryRoot: string;
  bridgeReceiptDigest: string;
  effectiveAliasVerificationRoot: string;
  progress: ReviewProgressAnalysis;
  spend: BatchSpendSummary;
  spendAuthorizationReceiptDigest: string;
}): Promise<ReviewPhaseReceipt> {
  const receipt = reviewPhaseReceiptSchema.parse(rawReceipt);
  if (computeReviewPhaseReceiptDigest(receipt) !== receipt.receiptDigest) throw new Error("Review-phase receipt digest is invalid.");
  if (receipt.authorBatchRegistryDigest !== expected.batchRegistryDigest
      || receipt.sealedAttemptRegistryRoot !== expected.registryRoot
      || receipt.registryBridgeReceiptDigest !== expected.bridgeReceiptDigest
      || receipt.effectiveAliasVerificationRoot !== expected.effectiveAliasVerificationRoot) {
    throw new Error("Review-phase receipt is bound to another author evidence set.");
  }
  const state = expected.progress.state;
  const adjudicationCount = state.expectedWorkItemIds.adjudication.length;
  if (!state.phaseBegun || state.reviewPlanRoot === null || state.classification === null
      || state.pendingWorkItemIds.primary.length !== 0
      || state.pendingWorkItemIds.adjudication.length !== 0
      || state.pendingWorkItemIds.pairwise.length !== 0
      || expected.progress.active !== null
      || state.expectedWorkItemIds.pairwise.length !== 24) {
    throw new Error("Review completion requires every fixed primary, planned adjudication, classification, and pairwise record to lock.");
  }
  const pairwisePlanEvent = expected.progress.events.find((event): event is Extract<ReviewPhaseEvent, { kind: "stage_planned" }> => (
    event.kind === "stage_planned" && event.stage === "pairwise"
  ));
  if (!pairwisePlanEvent
      || receipt.reviewPlanRoot !== state.reviewPlanRoot
      || receipt.reviewLedgerRoot !== state.classification.reviewLedgerRoot
      || receipt.classificationRoot !== state.classification.classificationRoot
      || receipt.reviewProgressRoot !== state.progressRoot
      || receipt.primaryReviewRecordRoot !== computeReviewStageRecordRoot(state, "primary")
      || receipt.adjudicationReviewRecords !== adjudicationCount
      || receipt.adjudicationReviewRecordRoot !== computeReviewStageRecordRoot(state, "adjudication")
      || receipt.pairwisePlanRoot !== pairwisePlanEvent.planRoot
      || receipt.pairwisePreferenceRecordRoot !== computeReviewStageRecordRoot(state, "pairwise")
      || receipt.spendLedgerRoot !== expected.spend.ledgerRoot
      || receipt.spendExternalAnchorRoot !== expected.spend.externalAnchorRoot
      || receipt.spendExternalAnchorCount !== expected.spend.externalAnchorCount
      || receipt.spendAuthorizationReceiptDigest !== expected.spendAuthorizationReceiptDigest
      || receipt.authorizedMaximumUsd !== expected.spend.authorizedMaximumUsd
      || receipt.userAuthorizedMaximumUsd !== expected.spend.userAuthorizedMaximumUsd
      || receipt.frozenProtocolMaximumUsd !== expected.spend.frozenProtocolMaximumUsd
      || receipt.observedProviderCostUsd !== expected.spend.observedSettledUsd
      || receipt.unobservableProviderExposureUsd !== expected.spend.unobservableReservedExposureUsd
      || receipt.totalChargedExposureUsd !== expected.spend.totalChargedExposureUsd) {
    throw new Error("Review completion roots or fixed denominators do not reconcile to the append-only progress ledger.");
  }
  await retainOrVerifyJson(filePath, receipt, "Review-phase completion receipt");
  const retained = reviewPhaseReceiptSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
  if (retained.receiptDigest !== receipt.receiptDigest) throw new Error("Review-phase receipt readback differs from the retained receipt.");
  return retained;
}

function absolutePaths(paths: BatchCommandPaths): BatchCommandPaths {
  for (const [key, value] of Object.entries(paths)) if (!path.isAbsolute(value)) throw new Error(`${key} must be an absolute path.`);
  return paths;
}

function maximumTokenCallCost(input: {
  inputTokenBudget: number;
  outputTokenBudget: number;
  pricing: Exp0001aBatchPlan["pricing"];
}): number {
  const maximumInputRate = Math.max(
    input.pricing.inputUsdPerMillionTokens,
    input.pricing.cachedInputUsdPerMillionTokens,
    input.pricing.cacheWriteInputUsdPerMillionTokens,
  );
  return Number(((input.inputTokenBudget * maximumInputRate * 2
    + input.outputTokenBudget * input.pricing.outputUsdPerMillionTokens * 1.5) / 1_000_000).toFixed(12));
}

export async function runExp0001aBatchCommand(options: Exp0001aBatchCommandOptions): Promise<Exp0001aBatchCommandResult> {
  const mode = options.mode ?? "dry-run";
  const now = options.now ?? (() => new Date().toISOString());
  const initialRegistry = verifyExp0001aBatchRegistry(options.initialRegistry, options.plan);
  const dryPreflight = validateCommandGate(options, now(), false);
  if (mode === "dry-run") {
    return { mode, status: "dry_run", preflight: dryPreflight.preflight, registry: initialRegistry, invokedAttemptIds: [], archivedPrebriefIncident: null, registryBridgeReceipt: null, reviewReceipt: null, spend: null };
  }
  const executor = options.executor;
  const aliasVerifier = options.aliasVerifier;
  const reviewRunner = options.reviewRunner;
  const executionAuthority = options.executionAuthority;
  if (!executor || !aliasVerifier || !reviewRunner || !executionAuthority) {
    throw new Error("Execute mode requires author/review runners, per-attempt deployment verification, and a separately trusted execution-authority verifier before any brief may be released.");
  }
  const paths = absolutePaths(options.paths);
  const store = options.registryStore ?? createAtomicRegistryStore<BatchRegistry>({
    filePath: paths.registryFile,
    validate: (value) => verifyExp0001aBatchRegistry(value, options.plan),
    identity: (value) => value.registryDigest,
  });
  const withLock = options.withExecutionLock ?? createFileExclusiveExecutionLock(paths.executionLockFile, now);
  return withLock({ protocolId: "EXP-0001A", planDigest: options.plan.planDigest }, async () => {
    const gated = validateCommandGate(options, now(), true);
    if (!gated.preflight.ok || !gated.prebrief || !gated.adapter || !gated.ready || !gated.noBrief || !options.exactAuthorization) {
      throw new Error(`EXP-0001A command gate refused execution: ${gated.preflight.errors.join(", ")}`);
    }
    if (executionAuthority.policyDigest !== gated.ready.attestationPolicyDigest
        || !await executionAuthority.verify({
          ready: gated.ready,
          noBrief: gated.noBrief,
          exactAuthorization: exactAuthorizationSchema.parse(options.exactAuthorization),
        })) {
      throw new Error("The separately trusted execution-authority policy refused this exact ready/no-brief/authorization tuple.");
    }
    const userAuthorizedMaximumUsd = gated.ready.spendAuthorization.maximumUsd;
    const frozenProtocolMaximumUsd = gated.ready.spendAuthorization.frozenCapTotalUsd;
    const spendLedger = createExp0001aSpendLedger({
      directory: paths.spendProgressRoot,
      authorizedMaximumUsd: Math.min(userAuthorizedMaximumUsd, frozenProtocolMaximumUsd),
      authorizationReceiptDigest: gated.ready.spendAuthorization.receiptDigest,
    });
    const spendSnapshot = async (): Promise<BatchSpendSummary> => ({
      ...(await spendLedger.read()).summary,
      userAuthorizedMaximumUsd,
      frozenProtocolMaximumUsd,
    });
    let durableRegistry = verifyExp0001aBatchRegistry(await readAttestedRegistry({
      filePath: paths.registryFile,
      initialRegistry,
      initialRegistryFileBytes: options.initialRegistryFileBytes,
      store,
    }), options.plan);
    await verifyRetainedAttemptEvidence({
      plan: options.plan,
      registry: durableRegistry,
      outputRoot: paths.outputRoot,
    });
    const retainedSpend = await spendLedger.read();
    for (const event of durableRegistry.events) {
      if (event.kind !== "attempt_retained" || event.data.usage === null || event.data.actualCostUsd === null) continue;
      const callId = `author:${event.attemptId}`;
      const reservation = retainedSpend.events.find((candidate) => candidate.kind === "reservation" && candidate.callId === callId);
      if (!reservation) throw new Error(`Retained author provider evidence lacks its pre-call spend reservation: ${event.attemptId}`);
      const settlement = retainedSpend.events.find((candidate) => candidate.kind === "settlement" && candidate.callId === callId);
      if (!settlement && event.data.costObservability === "observed") {
        await spendLedger.settle({
          at: event.at,
          callId,
          phase: "author",
          observability: "observed",
          actualCostUsd: event.data.actualCostUsd,
          usageDigest: hashCanonicalJson(event.data.usage),
          providerReceiptDigest: event.eventDigest,
        });
      } else if (!settlement && event.data.costObservability === "attested_no_provider_call") {
        await spendLedger.settle({
          at: event.at,
          callId,
          phase: "author",
          observability: "attested_no_provider_call",
          actualCostUsd: 0,
          usageDigest: null,
          providerReceiptDigest: null,
        });
      }
    }
    const resume = determineSafeResume(durableRegistry, options.plan);
    if (!resume.safe) throw new Error(`Unsafe or ambiguous EXP-0001A resume refused: ${resume.reason}`);
    if (!resume.complete) {
      for (const reviewPath of [
        paths.sealedAttemptRegistryFile,
        paths.registryBridgeReceiptFile,
        paths.reviewPlanFile,
        paths.reviewProgressRoot,
        paths.reviewPhaseBegunFile,
        paths.reviewReceiptFile,
      ]) {
        if (await statNoFollow(reviewPath)) throw new Error(`Review evidence exists before the author denominator completed: ${reviewPath}`);
      }
    }
    let archivedPrebriefIncident = await archiveRecoverablePrebriefEvidence({ plan: options.plan, registry: durableRegistry, outputRoot: paths.outputRoot, incidentRoot: paths.prebriefIncidentRoot });
    await assertAttemptOutputState({ plan: options.plan, registry: durableRegistry, outputRoot: paths.outputRoot });

    const startPosition = resume.complete ? options.plan.configs.length : resume.nextManifestPosition;
    const expectedOrder = options.plan.configs.slice(startPosition).map((config) => config.attempt.attemptId);
    const spendingExecutor: BatchAttemptExecutor = async (config, controls) => executor(config, {
      onBriefDelivered: async (at) => {
        const reservation = await spendLedger.reserve({
          at,
          callId: `author:${config.attempt.attemptId}`,
          phase: "author",
          maximumCostUsd: maximumTokenCallCost({
            inputTokenBudget: config.runnerConfig.inputTokenBudget,
            outputTokenBudget: config.runnerConfig.outputTokenBudget,
            pricing: options.plan.pricing,
          }),
          budgetDigest: hashCanonicalJson({
            inputTokens: config.runnerConfig.inputTokenBudget,
            outputTokens: config.runnerConfig.outputTokenBudget,
          }),
          pricingDigest: hashCanonicalJson(options.plan.pricing),
        });
        try {
          return await controls.onBriefDelivered(at);
        } catch (error) {
          // The committed runner is blocked on this callback and therefore
          // cannot release a provider request. Only this exact pre-provider
          // persistence failure is eligible for a zero-cost attestation.
          try {
            await spendLedger.settle({
              at,
              callId: reservation.callId,
              phase: "author",
              observability: "attested_no_provider_call",
              actualCostUsd: 0,
              usageDigest: null,
              providerReceiptDigest: null,
            });
          } catch (settlementError) {
            throw new Error("Brief persistence and its no-provider-call spend settlement both failed; conservative reservation exposure remains charged.", {
              cause: settlementError,
            });
          }
          throw error;
        }
      },
    });
    const batch = await runExp0001aBatch({
      plan: options.plan,
      registry: durableRegistry,
      mode: "execute",
      executionAuthorized: true,
      executor: spendingExecutor,
      verifyAliasBeforeAttempt: aliasVerifier,
      maxAssignments: 48,
      registryStore: store,
      afterRegistryPersisted: async (nextRegistry) => {
        durableRegistry = nextRegistry;
        const latest = durableRegistry.events.at(-1);
        if (latest?.kind === "attempt_retained" && latest.data.usage !== null && latest.data.actualCostUsd !== null
            && latest.data.costObservability === "observed") {
          await spendLedger.settle({
            at: latest.at,
            callId: `author:${latest.attemptId}`,
            phase: "author",
            observability: "observed",
            actualCostUsd: latest.data.actualCostUsd,
            usageDigest: hashCanonicalJson(latest.data.usage),
            providerReceiptDigest: latest.eventDigest,
          });
        } else if (latest?.kind === "attempt_retained" && latest.data.costObservability === "attested_no_provider_call") {
          await spendLedger.settle({
            at: latest.at,
            callId: `author:${latest.attemptId}`,
            phase: "author",
            observability: "attested_no_provider_call",
            actualCostUsd: 0,
            usageDigest: null,
            providerReceiptDigest: null,
          });
        }
      },
    });
    if (canonicalJson(batch.invokedAttemptIds) !== canonicalJson(expectedOrder.slice(0, batch.invokedAttemptIds.length))) throw new Error("Batch coordinator departed from fixed manifest order.");
    if (batch.registry.registryDigest !== durableRegistry.registryDigest) throw new Error("In-memory and durable batch registries diverged.");
    const fullyVerifiedRegistry = verifyExp0001aBatchRegistry(await store.read(), options.plan);
    if (fullyVerifiedRegistry.registryDigest !== durableRegistry.registryDigest) {
      throw new Error("Append-only registry readback differs from the in-memory batch registry.");
    }
    durableRegistry = fullyVerifiedRegistry;
    await verifyRetainedAttemptEvidence({
      plan: options.plan,
      registry: durableRegistry,
      outputRoot: paths.outputRoot,
    });
    const finalResume = determineSafeResume(durableRegistry, options.plan);
    if (!finalResume.safe) {
      return { mode, status: "hard_stopped", preflight: gated.preflight, registry: durableRegistry, invokedAttemptIds: batch.invokedAttemptIds, archivedPrebriefIncident, registryBridgeReceipt: null, reviewReceipt: null, spend: await spendSnapshot() };
    }
    if (!finalResume.complete) {
      archivedPrebriefIncident = await archiveRecoverablePrebriefEvidence({ plan: options.plan, registry: durableRegistry, outputRoot: paths.outputRoot, incidentRoot: paths.prebriefIncidentRoot });
      return { mode, status: "awaiting_resume", preflight: gated.preflight, registry: durableRegistry, invokedAttemptIds: batch.invokedAttemptIds, archivedPrebriefIncident, registryBridgeReceipt: null, reviewReceipt: null, spend: await spendSnapshot() };
    }
    const denominator = summarizeBatchDenominator(durableRegistry, options.plan);
    if (denominator.retainedAuthorAttempts !== 48 || denominator.unresolvedBegunAttempts !== 0) throw new Error("Review release requires all 48 author attempts to be durably retained first.");
    const bridge = await retainOrVerifyBridge({
      paths,
      plan: options.plan,
      batchRegistry: durableRegistry,
      prebriefFreeze: gated.prebrief,
      adapter: gated.adapter,
    });
    const effectiveAliasVerificationRoot = computeExp0001aEffectiveAliasVerificationRoot(durableRegistry, options.plan);

    let progress = await loadReviewProgress(paths.reviewProgressRoot);
    const markerStat = await statNoFollow(paths.reviewPhaseBegunFile);
    if (progress.state.phaseBegun) {
      const retainedPlan = await readRetainedReviewPlan(paths.reviewPlanFile, bridge.registry.registryRoot);
      if (retainedPlan.planRoot !== progress.state.reviewPlanRoot) throw new Error("Review plan file differs from the append-only phase event.");
      const phaseEvent = progress.events[0] as Extract<ReviewPhaseEvent, { kind: "phase_begun" }>;
      const marker = reviewPhaseBegunSchema.parse({
        schemaVersion: 1,
        kind: "exp-0001a-review-phase-begun",
        protocolId: "EXP-0001A",
        begunAt: phaseEvent.at,
        authorBatchRegistryDigest: phaseEvent.authorBatchRegistryDigest,
        sealedAttemptRegistryRoot: phaseEvent.sealedAttemptRegistryRoot,
        registryBridgeReceiptDigest: phaseEvent.registryBridgeReceiptDigest,
        reviewPlanRoot: phaseEvent.reviewPlanRoot,
      });
      await retainOrVerifyJson(paths.reviewPhaseBegunFile, marker, "Review phase-begun marker");
    } else if (markerStat) {
      throw new Error("Review phase-begun marker exists without its append-only progress event.");
    }

    if (progress.active && reviewRunner.recoverActiveWorkItem) {
      const active = progress.active;
      const recovered = await reviewRunner.recoverActiveWorkItem({
        plan: options.plan,
        authorBatchRegistry: durableRegistry,
        sealedAttemptRegistry: bridge.registry,
        registryBridgeReceipt: bridge.receipt,
        spendAuthorizationReceiptDigest: gated.ready.spendAuthorization.receiptDigest,
        resume: progress.state,
        retainedAmbiguousFailures: progress.ambiguousFailures,
        active: {
          stage: active.stage,
          workItemId: active.workItemId,
          begunAt: active.at,
          begunEventDigest: active.eventDigest,
          spendReservationEventDigest: active.spendReservationEventDigest,
          maximumCostUsd: active.maximumCostUsd,
        },
      });
      if (recovered) {
        const settlement = await settleReviewWorkItemSpend({
          spendLedger,
          at: recovered.lockedAt,
          stage: active.stage,
          workItemId: active.workItemId,
          spend: recovered.spend,
        });
        progress = await appendReviewProgressEvent(paths.reviewProgressRoot, {
          kind: "work_item_locked",
          at: recovered.lockedAt,
          stage: active.stage,
          workItemId: active.workItemId,
          recordRoot: recovered.recordRoot,
          status: recovered.status,
          spendSettlementEventDigest: settlement?.eventDigest ?? null,
          costObservability: recovered.spend.observability,
        });
      }
    }
    progress = await failClosedUnresolvedReviewerWork(paths.reviewProgressRoot, spendLedger, now());

    const existingReceiptStat = await statNoFollow(paths.reviewReceiptFile);
    if (existingReceiptStat) {
      if (!existingReceiptStat.isFile() || existingReceiptStat.isSymbolicLink()) throw new Error("Review receipt path is unsafe.");
      const retainedRaw = JSON.parse(await readFile(paths.reviewReceiptFile, "utf8"));
      const spend = await spendSnapshot();
      const reviewReceipt = await retainReviewReceipt(paths.reviewReceiptFile, retainedRaw, {
        batchRegistryDigest: durableRegistry.registryDigest,
        registryRoot: bridge.registry.registryRoot,
        bridgeReceiptDigest: bridge.receipt.receiptDigest,
        effectiveAliasVerificationRoot,
        progress,
        spend,
        spendAuthorizationReceiptDigest: gated.ready.spendAuthorization.receiptDigest,
      });
      return { mode, status: "awaiting_analysis", preflight: gated.preflight, registry: durableRegistry, invokedAttemptIds: batch.invokedAttemptIds, archivedPrebriefIncident, registryBridgeReceipt: bridge.receipt, reviewReceipt, spend };
    }

    const controls: ReviewPhaseControls = {
      readSpendSummary: spendSnapshot,
      onReviewPhaseBegun: async ({ at, reviewPlan }) => {
        const current = await loadReviewProgress(paths.reviewProgressRoot);
        if (current.state.phaseBegun || current.events.length !== 0) throw new Error("Review phase was reported begun twice.");
        const plan = await retainOrVerifyReviewPlan(paths.reviewPlanFile, reviewPlan, bridge.registry.registryRoot);
        const next = await appendReviewProgressEvent(paths.reviewProgressRoot, {
          kind: "phase_begun",
          at,
          authorBatchRegistryDigest: durableRegistry.registryDigest,
          sealedAttemptRegistryRoot: bridge.registry.registryRoot,
          registryBridgeReceiptDigest: bridge.receipt.receiptDigest,
          reviewPlanRoot: plan.planRoot,
          primaryWorkItemIds: primaryWorkItemIds(plan),
        });
        const marker = reviewPhaseBegunSchema.parse({
          schemaVersion: 1,
          kind: "exp-0001a-review-phase-begun",
          protocolId: "EXP-0001A",
          begunAt: at,
          authorBatchRegistryDigest: durableRegistry.registryDigest,
          sealedAttemptRegistryRoot: bridge.registry.registryRoot,
          registryBridgeReceiptDigest: bridge.receipt.receiptDigest,
          reviewPlanRoot: plan.planRoot,
        });
        await retainOrVerifyJson(paths.reviewPhaseBegunFile, marker, "Review phase-begun marker");
        return next.state;
      },
      onReviewStagePlanned: async ({ at, stage, planRoot, workItemIds }) => (
        await appendReviewProgressEvent(paths.reviewProgressRoot, { kind: "stage_planned", at, stage, planRoot, workItemIds })
      ).state,
      onReviewWorkItemBegun: async ({ at, stage, workItemId, maximumCostUsd, budgetDigest, pricingDigest }) => {
        const reservation = await spendLedger.reserve({
          at,
          callId: `${stage}:${workItemId}`,
          phase: stage,
          maximumCostUsd,
          budgetDigest,
          pricingDigest,
        });
        return (await appendReviewProgressEvent(paths.reviewProgressRoot, {
          kind: "work_item_begun",
          at,
          stage,
          workItemId,
          spendReservationEventDigest: reservation.eventDigest,
          maximumCostUsd: reservation.maximumCostUsd,
        })).state;
      },
      onReviewWorkItemLocked: async ({ at, stage, workItemId, recordRoot, status, spend }) => {
        const settlement = await settleReviewWorkItemSpend({ spendLedger, at, stage, workItemId, spend });
        return (await appendReviewProgressEvent(paths.reviewProgressRoot, {
          kind: "work_item_locked",
          at,
          stage,
          workItemId,
          recordRoot,
          status,
          spendSettlementEventDigest: settlement?.eventDigest ?? null,
          costObservability: spend.observability,
        })).state;
      },
      onClassificationsLocked: async ({ at, reviewLedgerRoot, classificationRoot, count }) => (
        await appendReviewProgressEvent(paths.reviewProgressRoot, { kind: "classifications_locked", at, reviewLedgerRoot, classificationRoot, count })
      ).state,
    };

    const rawReviewReceipt = await reviewRunner({
      plan: options.plan,
      authorBatchRegistry: durableRegistry,
      sealedAttemptRegistry: bridge.registry,
      registryBridgeReceipt: bridge.receipt,
      spendAuthorizationReceiptDigest: gated.ready.spendAuthorization.receiptDigest,
      resume: progress.state,
      retainedAmbiguousFailures: progress.ambiguousFailures,
    }, controls);
    progress = await loadReviewProgress(paths.reviewProgressRoot);
    if (!progress.state.phaseBegun) throw new Error("Review runner returned without durably announcing review-phase start.");
    const spend = await spendSnapshot();
    const reviewReceipt = await retainReviewReceipt(paths.reviewReceiptFile, rawReviewReceipt, {
      batchRegistryDigest: durableRegistry.registryDigest,
      registryRoot: bridge.registry.registryRoot,
      bridgeReceiptDigest: bridge.receipt.receiptDigest,
      effectiveAliasVerificationRoot,
      progress,
      spend,
      spendAuthorizationReceiptDigest: gated.ready.spendAuthorization.receiptDigest,
    });
    return { mode, status: "awaiting_analysis", preflight: gated.preflight, registry: durableRegistry, invokedAttemptIds: batch.invokedAttemptIds, archivedPrebriefIncident, registryBridgeReceipt: bridge.receipt, reviewReceipt, spend };
  });
}
