import path from "node:path";

import { z } from "zod";

// @ts-expect-error committed ESM preflight intentionally has no declaration file
import { assertCodexNativeExperimentAuthorized, verifyCodexAuthPreflightReceipt } from "../../../research/scripts/codex-auth-preflight.mjs";
import {
  exp0001aCodexAuthoritySignatureSchema,
  verifyExp0001aCodexAuthoritySignature,
} from "./exp0001a-codex-authority";
import {
  verifyExp0001aCodexSpikeRecoveryGate,
  type Exp0001aCodexSpikeRecoveryGate,
} from "./codex-webmcp-spike-recovery";
import {
  deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal,
  exp0001aCodexCoordinatorJournalSchema,
  planNextExp0001aCodexCoordinatorAction,
  type Exp0001aCodexCoordinatorJournal,
} from "./exp0001a-codex-coordinator";
import {
  nextExp0001aProvisioningAction,
  type Exp0001aProvisioningCoordinatorState,
} from "./exp0001a-attempt-provisioning";
import {
  EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
  exp0001aCodexAccountingLedgerSchema,
  exp0001aCodexSchedulerStateSchema,
  verifyExp0001aCodexAccountingLedgerAsOf,
  verifyExp0001aCodexSchedulerStateAsOf,
  summarizeExp0001aCodexAccounting,
  type Exp0001aCodexAccountingLedger,
  type Exp0001aCodexSchedulerState,
} from "./exp0001a-codex-accounting";
import {
  verifyExp0001aCodexPrebriefFreeze,
  verifyExp0001aCodexPrebriefFreezeAuthority,
  type Exp0001aCodexPrebriefFreeze,
} from "./exp0001a-codex-prebrief-freeze";
import { hashCanonicalJson, SHA256_DIGEST_PATTERN, type JsonValue } from "./provenance-crypto";

export const EXP0001A_CODEX_RUNTIME_CONTRACT_VERSION = "exp-0001a-codex-runtime-contract/v1" as const;
export const EXP0001A_CODEX_RUNTIME_PREFLIGHT_VERSION = "exp-0001a-codex-runtime-preflight/v1" as const;
export const EXP0001A_CODEX_AUTH_MAX_AGE_MS = 5 * 60_000;
export const EXP0001A_CODEX_CHECKPOINT_MAX_AGE_MS = 15 * 60_000;
export const EXP0001A_CODEX_CHECKPOINT_VALIDITY_MS = 5 * 60_000;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const absolutePathSchema = z.string().min(1).superRefine((value, context) => {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value === path.parse(value).root) {
    context.addIssue({ code: "custom", message: "Expected a normalized absolute non-root path." });
  }
});

export const exp0001aCodexRuntimeConfigSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_RUNTIME_CONTRACT_VERSION),
  protocolId: z.literal("EXP-0001A"),
  files: z.object({
    codexPrebriefFreeze: absolutePathSchema,
    codexPrebriefFreezeSignature: absolutePathSchema,
    spikeGate: absolutePathSchema,
    coordinatorCheckpoint: absolutePathSchema,
    schedulerState: absolutePathSchema,
    accountingLedger: absolutePathSchema,
    provisioningCoordinatorState: absolutePathSchema,
    coordinatorJournal: absolutePathSchema,
    spikeEvidence: absolutePathSchema,
  }).strict(),
  outputRoot: absolutePathSchema,
  runtimeBundleDigest: digestSchema,
  authorizedPrebriefFreezePayloadDigest: digestSchema,
  authorizedPrebriefFreezeSignatureDigest: digestSchema,
}).strict();

export type Exp0001aCodexRuntimeConfig = z.infer<typeof exp0001aCodexRuntimeConfigSchema>;

export const exp0001aCodexCoordinatorCheckpointDraftSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-coordinator-checkpoint/v1"),
  kind: z.literal("codex-coordinator-checkpoint"),
  protocolId: z.literal("EXP-0001A"),
  checkpointId: z.string().trim().min(1).max(240),
  recordedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  decision: z.literal("authorize_next_action"),
  freezeDigest: digestSchema,
  prebriefFreezeAuthorityPayloadDigest: digestSchema,
  prebriefFreezeAuthoritySignatureDigest: digestSchema,
  runtimeBundleDigest: digestSchema,
  spikeEvidenceDigest: digestSchema,
  spikeGateDigest: digestSchema,
  frozenScheduleDigest: digestSchema,
  schedulerStateDigest: digestSchema,
  accountingLedgerDigest: digestSchema,
  provisioningStateDigest: digestSchema,
  coordinatorJournalDigest: digestSchema,
  authorizedActionDigest: digestSchema,
  journalPreviousEntryDigest: digestSchema.nullable(),
}).strict();

export const exp0001aCodexCoordinatorCheckpointSchema = exp0001aCodexCoordinatorCheckpointDraftSchema.extend({
  authoritySignature: exp0001aCodexAuthoritySignatureSchema,
}).strict();
export type Exp0001aCodexCoordinatorCheckpoint = z.infer<typeof exp0001aCodexCoordinatorCheckpointSchema>;
export type Exp0001aCodexCoordinatorCheckpointDraft = z.infer<typeof exp0001aCodexCoordinatorCheckpointDraftSchema>;

const observableAggregateSchema = z.object({
  observedTotal: z.number().int().nonnegative(),
  observedTaskCount: z.number().int().nonnegative(),
  unobservableTaskCount: z.number().int().nonnegative(),
}).strict();

const accountingSummarySchema = z.object({
  codexTaskCount: z.number().int().nonnegative(),
  begunTaskCount: z.number().int().nonnegative(),
  completedTaskCount: z.number().int().nonnegative(),
  terminalTaskCount: z.number().int().nonnegative(),
  totalWallTimeMs: z.number().int().nonnegative(),
  webMcpCallCount: observableAggregateSchema,
  webMcpFailureCount: observableAggregateSchema,
  revisionCount: observableAggregateSchema,
  inspectionCount: observableAggregateSchema,
  usageLimitInterruptionCount: z.number().int().nonnegative(),
  unobservableResolvedModelCount: z.number().int().nonnegative(),
  unobservableInputTokenCount: z.number().int().nonnegative(),
  unobservableOutputTokenCount: z.number().int().nonnegative(),
  unobservableTotalTokenCount: z.number().int().nonnegative(),
  unobservableCreditCount: z.number().int().nonnegative(),
  unobservableSubscriptionUsageCount: z.number().int().nonnegative(),
  roleTaskCounts: z.object({
    subscription_probe: z.number().int().nonnegative(),
    spike_author: z.number().int().nonnegative(),
    author: z.number().int().nonnegative(),
    primary_reviewer: z.number().int().nonnegative(),
    adjudicator: z.number().int().nonnegative(),
    pairwise_visual_judge: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const preflightContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_RUNTIME_PREFLIGHT_VERSION),
  kind: z.literal("exp-0001a-codex-runtime-preflight"),
  protocolId: z.literal("EXP-0001A"),
  checkedAt: z.string().datetime({ offset: true }),
  authCheckedAt: z.string().datetime({ offset: true }),
  decision: z.literal("ready_for_coordinator"),
  reasons: z.tuple([z.literal("SIGNED_STATE_AND_LIVE_CHATGPT_AUTH_VERIFIED")]),
  executionAllowed: z.literal(true),
  nextAction: z.object({
    kind: z.literal("emit_one_coordinator_action"),
    actionDigest: digestSchema,
    coordinatorActionIssuedAt: z.string().datetime({ offset: true }),
    callerMustPerformAction: z.literal(true),
    runtimeInvokedExternalTool: z.literal(false),
  }).strict(),
  freezeDigest: digestSchema,
  prebriefFreezeAuthorityPayloadDigest: digestSchema,
  prebriefFreezeAuthoritySignatureDigest: digestSchema,
  authPreflightReceiptDigest: digestSchema,
  spikeEvidenceDigest: digestSchema,
  spikeGateDigest: digestSchema,
  frozenScheduleDigest: digestSchema,
  schedulerStateDigest: digestSchema,
  accountingLedgerDigest: digestSchema,
  provisioningStateDigest: digestSchema,
  coordinatorJournalDigest: digestSchema,
  /** Exact Ed25519 authority retained; a self-hash is never execution authority. */
  coordinatorCheckpoint: exp0001aCodexCoordinatorCheckpointSchema,
  accounting: accountingSummarySchema,
  isolation: z.object({
    taskWorkspace: z.literal("projectless"),
    repositoryAccess: z.literal(false),
    privateApiAccess: z.literal(false),
    sharedHistory: z.literal(false),
  }).strict(),
}).strict();

export const exp0001aCodexRuntimePreflightReceiptSchema = preflightContentSchema.extend({
  receiptDigest: digestSchema,
}).strict();

export type Exp0001aCodexRuntimePreflightReceipt = z.infer<typeof exp0001aCodexRuntimePreflightReceiptSchema>;

function verifyGate(gateInput: unknown, spikeEvidence: unknown, freeze: Exp0001aCodexPrebriefFreeze): Exp0001aCodexSpikeRecoveryGate {
  const gate = verifyExp0001aCodexSpikeRecoveryGate(gateInput);
  if (gate.decision !== "allow"
      || gate.reasons.length !== 1
      || gate.reasons[0] !== "VERIFIED_CODEX_NATIVE_PROJECTLESS_WEBMCP_SPIKE"
      || gate.gateDigest !== freeze.passedSpikeGate.gateDigest
      || gate.evidenceDigest !== freeze.passedSpikeGate.spikeEvidenceDigest
      || hashCanonicalJson(gate.evidence as unknown as JsonValue) !== gate.evidenceDigest
      || hashCanonicalJson(spikeEvidence as JsonValue) !== gate.evidenceDigest
      || gate.authoritySignature.payloadDigest !== freeze.passedSpikeGate.authoritySignaturePayloadDigest
      || gate.authoritySignature.signatureBase64 !== freeze.passedSpikeGate.authoritySignatureBase64) {
    throw new Error("EXP0001A_CODEX_SPIKE_GATE_NOT_FROZEN_PASS");
  }
  return gate;
}

function verifySchedulerAccountingBinding(
  scheduler: Exp0001aCodexSchedulerState,
  ledger: Exp0001aCodexAccountingLedger,
): void {
  const begunAssignments = scheduler.assignments.filter((assignment) => assignment.state !== "unstarted");
  const authorTasks = ledger.tasks.filter((task) => task.role === "author");
  if (authorTasks.length !== begunAssignments.length) {
    throw new Error("EXP0001A_CODEX_SCHEDULER_ACCOUNTING_DENOMINATOR_DRIFT");
  }
  const authors = new Map(authorTasks.map((task) => [task.assignmentId, task]));
  for (const assignment of begunAssignments) {
    const task = authors.get(assignment.assignmentId);
    if (!task || task.attemptId !== assignment.attemptId
        || task.codexTaskId !== assignment.codexTaskId
        || task.threadId !== assignment.threadId
        || task.state !== assignment.state
        || task.terminalOutcome !== assignment.terminalOutcome) {
      throw new Error(`EXP0001A_CODEX_SCHEDULER_ACCOUNTING_DRIFT:${assignment.assignmentId}`);
    }
  }
  const probeTasks = ledger.tasks.filter((task) => task.role === "subscription_probe");
  const probesByAccountingId = new Map(probeTasks.map((task) => [task.accountingId, task]));
  for (const reset of scheduler.usageResets) {
    const task = probesByAccountingId.get(reset.probe.accountingId);
    if (!task || task.state !== "terminal" || task.terminalOutcome !== "succeeded"
        || task.codexTaskId !== reset.probe.codexTaskId || task.threadId !== reset.probe.threadId
        || task.hostId === "unobservable" || task.hostId !== reset.probe.hostId
        || hashCanonicalJson(task as unknown as JsonValue) !== reset.probe.accountingRecordDigest) {
      throw new Error(`EXP0001A_CODEX_USAGE_PROBE_ACCOUNTING_DRIFT:${reset.observationId}`);
    }
  }
}

/**
 * Derives the only checkpoint payload the fixed execution authority may sign.
 * Production signers call this from exact retained state; they do not accept a
 * caller-authored checkpoint body.
 */
export function createExp0001aCodexCoordinatorCheckpointDraft(input: Readonly<{
  checkpointId: string;
  recordedAt: string;
  runtimeBundleDigest: string;
  authorizedPrebriefFreezePayloadDigest: string;
  authorizedPrebriefFreezeSignatureDigest: string;
  freeze: Exp0001aCodexPrebriefFreeze;
  freezeAuthoritySignature: unknown;
  spikeGate: unknown;
  spikeEvidence: unknown;
  scheduler: Exp0001aCodexSchedulerState;
  accountingLedger: Exp0001aCodexAccountingLedger;
  provisioningState: Exp0001aProvisioningCoordinatorState;
  coordinatorJournal: Exp0001aCodexCoordinatorJournal;
}>): Exp0001aCodexCoordinatorCheckpointDraft {
  const recordedAt = z.string().datetime({ offset: true }).parse(input.recordedAt);
  const runtimeBundleDigest = digestSchema.parse(input.runtimeBundleDigest);
  const freezeAuthoritySignature = exp0001aCodexAuthoritySignatureSchema.parse(input.freezeAuthoritySignature);
  if (freezeAuthoritySignature.payloadDigest !== digestSchema.parse(input.authorizedPrebriefFreezePayloadDigest)
      || hashCanonicalJson(freezeAuthoritySignature as unknown as JsonValue)
        !== digestSchema.parse(input.authorizedPrebriefFreezeSignatureDigest)) {
    throw new Error("EXP0001A_CODEX_PREBRIEF_FREEZE_AUTHORITY_NOT_PINNED");
  }
  const freeze = verifyExp0001aCodexPrebriefFreezeAuthority({
    freeze: input.freeze,
    authoritySignature: freezeAuthoritySignature,
    verifiedAt: recordedAt,
  });
  if (freeze.activeRuntime.bundleDigest !== runtimeBundleDigest) {
    throw new Error("EXP0001A_CODEX_CHECKPOINT_RUNTIME_BUNDLE_DRIFT");
  }
  const gate = verifyGate(input.spikeGate, input.spikeEvidence, freeze);
  const accountingLedger = verifyExp0001aCodexAccountingLedgerAsOf(
    exp0001aCodexAccountingLedgerSchema.parse(input.accountingLedger),
    recordedAt,
  );
  const scheduler = verifyExp0001aCodexSchedulerStateAsOf({
    scheduler: exp0001aCodexSchedulerStateSchema.parse(input.scheduler),
    accountingLedger,
    checkedAt: recordedAt,
  });
  if (scheduler.frozenScheduleDigest !== freeze.schedule.codexSchedulerDigest) {
    throw new Error("EXP0001A_CODEX_CHECKPOINT_SCHEDULE_DRIFT");
  }
  if (hashCanonicalJson(accountingLedger.frozenRoleSettings as unknown as JsonValue)
      !== hashCanonicalJson(EXP0001A_CODEX_FROZEN_ROLE_SETTINGS as unknown as JsonValue)
      || hashCanonicalJson(accountingLedger.frozenRoleSettings as unknown as JsonValue)
      !== hashCanonicalJson(freeze.roleSettings as unknown as JsonValue)) {
    throw new Error("EXP0001A_CODEX_CHECKPOINT_ROLE_SETTINGS_DRIFT");
  }
  verifySchedulerAccountingBinding(scheduler, accountingLedger);
  nextExp0001aProvisioningAction(input.provisioningState);
  if (input.provisioningState.scheduler.frozenScheduleDigest !== scheduler.frozenScheduleDigest
      || hashCanonicalJson(input.provisioningState.scheduler as unknown as JsonValue)
        !== hashCanonicalJson(scheduler as unknown as JsonValue)) {
    throw new Error("EXP0001A_CODEX_CHECKPOINT_PROVISIONING_SCHEDULER_DRIFT");
  }
  const coordinatorJournal = exp0001aCodexCoordinatorJournalSchema.parse(input.coordinatorJournal);
  if (hashCanonicalJson(
    deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal(coordinatorJournal) as unknown as JsonValue,
  ) !== hashCanonicalJson(accountingLedger as unknown as JsonValue)) {
    throw new Error("EXP0001A_CODEX_ACCOUNTING_LEDGER_NOT_DERIVED_FROM_COORDINATOR_JOURNAL");
  }
  if (coordinatorJournal.provisioningStateDigest !== input.provisioningState.stateDigest) {
    throw new Error("EXP0001A_CODEX_CHECKPOINT_JOURNAL_PROVISIONING_DRIFT");
  }
  const action = planNextExp0001aCodexCoordinatorAction({
    issuedAt: recordedAt,
    provisioningState: input.provisioningState,
    journal: coordinatorJournal,
  });
  return Object.freeze(exp0001aCodexCoordinatorCheckpointDraftSchema.parse({
    schemaVersion: "exp-0001a-codex-coordinator-checkpoint/v1",
    kind: "codex-coordinator-checkpoint",
    protocolId: "EXP-0001A",
    checkpointId: input.checkpointId,
    recordedAt,
    expiresAt: new Date(Date.parse(recordedAt) + EXP0001A_CODEX_CHECKPOINT_VALIDITY_MS).toISOString(),
    decision: "authorize_next_action",
    freezeDigest: freeze.freezeDigest,
    prebriefFreezeAuthorityPayloadDigest: freezeAuthoritySignature.payloadDigest,
    prebriefFreezeAuthoritySignatureDigest: hashCanonicalJson(freezeAuthoritySignature as unknown as JsonValue),
    runtimeBundleDigest,
    spikeEvidenceDigest: gate.evidenceDigest,
    spikeGateDigest: gate.gateDigest,
    frozenScheduleDigest: scheduler.frozenScheduleDigest,
    schedulerStateDigest: hashCanonicalJson(scheduler as unknown as JsonValue),
    accountingLedgerDigest: hashCanonicalJson(accountingLedger as unknown as JsonValue),
    provisioningStateDigest: input.provisioningState.stateDigest,
    coordinatorJournalDigest: coordinatorJournal.journalDigest,
    authorizedActionDigest: hashCanonicalJson(action as unknown as JsonValue),
    journalPreviousEntryDigest: coordinatorJournal.priorJournalDigest,
  }));
}

/**
 * Validates the subscription-only evidence boundary and the one exact action
 * authorized by a short-lived, authority-signed coordinator checkpoint.
 */
export function createExp0001aCodexRuntimePreflight(input: Readonly<{
  checkedAt: string;
  runtimeBundleDigest: string;
  authorizedPrebriefFreezePayloadDigest: string;
  authorizedPrebriefFreezeSignatureDigest: string;
  freeze: Exp0001aCodexPrebriefFreeze;
  freezeAuthoritySignature: unknown;
  authPreflightReceipt: unknown;
  spikeGate: unknown;
  spikeEvidence: unknown;
  scheduler: Exp0001aCodexSchedulerState;
  accountingLedger: Exp0001aCodexAccountingLedger;
  provisioningState: Exp0001aProvisioningCoordinatorState;
  coordinatorJournal: Exp0001aCodexCoordinatorJournal;
  coordinatorCheckpoint: Exp0001aCodexCoordinatorCheckpoint;
}>): Exp0001aCodexRuntimePreflightReceipt {
  const freezeAuthoritySignature = exp0001aCodexAuthoritySignatureSchema.parse(input.freezeAuthoritySignature);
  if (freezeAuthoritySignature.payloadDigest !== digestSchema.parse(input.authorizedPrebriefFreezePayloadDigest)
      || hashCanonicalJson(freezeAuthoritySignature as unknown as JsonValue)
        !== digestSchema.parse(input.authorizedPrebriefFreezeSignatureDigest)) {
    throw new Error("EXP0001A_CODEX_PREBRIEF_FREEZE_AUTHORITY_NOT_PINNED");
  }
  const freeze = verifyExp0001aCodexPrebriefFreezeAuthority({
    freeze: input.freeze,
    authoritySignature: freezeAuthoritySignature,
    verifiedAt: input.checkedAt,
  });
  const authReceipt = assertCodexNativeExperimentAuthorized(
    verifyCodexAuthPreflightReceipt(input.authPreflightReceipt),
  );
  const authAgeMs = Date.parse(input.checkedAt) - Date.parse(authReceipt.checkedAt);
  if (!Number.isFinite(authAgeMs) || authAgeMs < 0 || authAgeMs > EXP0001A_CODEX_AUTH_MAX_AGE_MS) {
    throw new Error("EXP0001A_CODEX_AUTH_PREFLIGHT_STALE");
  }
  const gate = verifyGate(input.spikeGate, input.spikeEvidence, freeze);
  const accountingLedger = verifyExp0001aCodexAccountingLedgerAsOf(
    exp0001aCodexAccountingLedgerSchema.parse(input.accountingLedger),
    input.checkedAt,
  );
  const scheduler = verifyExp0001aCodexSchedulerStateAsOf({
    scheduler: exp0001aCodexSchedulerStateSchema.parse(input.scheduler),
    accountingLedger,
    checkedAt: input.checkedAt,
  });
  if (scheduler.frozenScheduleDigest !== freeze.schedule.codexSchedulerDigest) {
    throw new Error("EXP0001A_CODEX_FROZEN_SCHEDULE_DRIFT");
  }
  if (hashCanonicalJson(accountingLedger.frozenRoleSettings as unknown as JsonValue)
      !== hashCanonicalJson(EXP0001A_CODEX_FROZEN_ROLE_SETTINGS as unknown as JsonValue)
      || hashCanonicalJson(accountingLedger.frozenRoleSettings as unknown as JsonValue)
      !== hashCanonicalJson(freeze.roleSettings as unknown as JsonValue)) {
    throw new Error("EXP0001A_CODEX_ROLE_SETTINGS_DRIFT");
  }
  verifySchedulerAccountingBinding(scheduler, accountingLedger);
  nextExp0001aProvisioningAction(input.provisioningState);
  const coordinatorJournal = exp0001aCodexCoordinatorJournalSchema.parse(input.coordinatorJournal);
  if (hashCanonicalJson(
    deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal(coordinatorJournal) as unknown as JsonValue,
  ) !== hashCanonicalJson(accountingLedger as unknown as JsonValue)) {
    throw new Error("EXP0001A_CODEX_ACCOUNTING_LEDGER_NOT_DERIVED_FROM_COORDINATOR_JOURNAL");
  }
  if (input.provisioningState.scheduler.frozenScheduleDigest !== scheduler.frozenScheduleDigest
      || hashCanonicalJson(input.provisioningState.scheduler as unknown as JsonValue)
        !== hashCanonicalJson(scheduler as unknown as JsonValue)) {
    throw new Error("EXP0001A_CODEX_PROVISIONING_SCHEDULER_DRIFT");
  }
  if (coordinatorJournal.provisioningStateDigest !== input.provisioningState.stateDigest) {
    throw new Error("EXP0001A_CODEX_COORDINATOR_JOURNAL_PROVISIONING_DRIFT");
  }
  const checkpoint = exp0001aCodexCoordinatorCheckpointSchema.parse(input.coordinatorCheckpoint);
  const { authoritySignature: _authoritySignature, ...checkpointPayload } = checkpoint;
  void _authoritySignature;
  const expectedCheckpointBindings = {
    freezeDigest: freeze.freezeDigest,
    prebriefFreezeAuthorityPayloadDigest: freezeAuthoritySignature.payloadDigest,
    prebriefFreezeAuthoritySignatureDigest: hashCanonicalJson(freezeAuthoritySignature as unknown as JsonValue),
    runtimeBundleDigest: input.runtimeBundleDigest,
    spikeEvidenceDigest: gate.evidenceDigest,
    spikeGateDigest: gate.gateDigest,
    frozenScheduleDigest: scheduler.frozenScheduleDigest,
    schedulerStateDigest: hashCanonicalJson(scheduler as unknown as JsonValue),
    accountingLedgerDigest: hashCanonicalJson(accountingLedger as unknown as JsonValue),
    provisioningStateDigest: input.provisioningState.stateDigest,
    coordinatorJournalDigest: coordinatorJournal.journalDigest,
  };
  for (const [field, expected] of Object.entries(expectedCheckpointBindings)) {
    if (checkpointPayload[field as keyof typeof expectedCheckpointBindings] !== expected) {
      throw new Error(`EXP0001A_CODEX_COORDINATOR_CHECKPOINT_DRIFT:${field}`);
    }
  }
  if (checkpoint.journalPreviousEntryDigest !== coordinatorJournal.priorJournalDigest) {
    throw new Error("EXP0001A_CODEX_COORDINATOR_CHECKPOINT_JOURNAL_LINEAGE_DRIFT");
  }
  verifyExp0001aCodexAuthoritySignature({
    payload: checkpointPayload as unknown as JsonValue,
    signature: checkpoint.authoritySignature,
    purpose: "coordinator_checkpoint",
    notBefore: checkpoint.recordedAt,
  });
  if (Date.parse(checkpoint.authoritySignature.signedAt) > Date.parse(input.checkedAt)
      || Date.parse(checkpoint.authoritySignature.signedAt) > Date.parse(checkpoint.expiresAt)) {
    throw new Error("EXP0001A_CODEX_COORDINATOR_CHECKPOINT_SIGNATURE_TIME_INVALID");
  }
  const checkpointAgeMs = Date.parse(input.checkedAt) - Date.parse(checkpoint.recordedAt);
  const checkpointLifetimeMs = Date.parse(checkpoint.expiresAt) - Date.parse(checkpoint.recordedAt);
  if (!Number.isFinite(checkpointAgeMs) || !Number.isFinite(checkpointLifetimeMs)
      || checkpointAgeMs < 0 || checkpointLifetimeMs <= 0
      || checkpointAgeMs > EXP0001A_CODEX_CHECKPOINT_MAX_AGE_MS
      || checkpointLifetimeMs > EXP0001A_CODEX_CHECKPOINT_MAX_AGE_MS
      || Date.parse(input.checkedAt) > Date.parse(checkpoint.expiresAt)) {
    throw new Error("EXP0001A_CODEX_COORDINATOR_CHECKPOINT_STALE");
  }
  const authorizedAction = planNextExp0001aCodexCoordinatorAction({
    issuedAt: checkpoint.recordedAt,
    provisioningState: input.provisioningState,
    journal: coordinatorJournal,
  });
  const authorizedActionDigest = hashCanonicalJson(authorizedAction as unknown as JsonValue);
  if (checkpoint.authorizedActionDigest !== authorizedActionDigest) {
    throw new Error("EXP0001A_CODEX_COORDINATOR_ACTION_NOT_AUTHORIZED");
  }
  const content = preflightContentSchema.parse({
    schemaVersion: EXP0001A_CODEX_RUNTIME_PREFLIGHT_VERSION,
    kind: "exp-0001a-codex-runtime-preflight",
    protocolId: "EXP-0001A",
    checkedAt: input.checkedAt,
    authCheckedAt: authReceipt.checkedAt,
    decision: "ready_for_coordinator",
    reasons: ["SIGNED_STATE_AND_LIVE_CHATGPT_AUTH_VERIFIED"],
    executionAllowed: true,
    nextAction: {
      kind: "emit_one_coordinator_action",
      actionDigest: authorizedActionDigest,
      coordinatorActionIssuedAt: checkpoint.recordedAt,
      callerMustPerformAction: true,
      runtimeInvokedExternalTool: false,
    },
    freezeDigest: freeze.freezeDigest,
    prebriefFreezeAuthorityPayloadDigest: freezeAuthoritySignature.payloadDigest,
    prebriefFreezeAuthoritySignatureDigest: hashCanonicalJson(freezeAuthoritySignature as unknown as JsonValue),
    authPreflightReceiptDigest: authReceipt.receiptSha256,
    spikeEvidenceDigest: gate.evidenceDigest,
    spikeGateDigest: gate.gateDigest,
    frozenScheduleDigest: scheduler.frozenScheduleDigest,
    schedulerStateDigest: hashCanonicalJson(scheduler as unknown as JsonValue),
    accountingLedgerDigest: hashCanonicalJson(accountingLedger as unknown as JsonValue),
    provisioningStateDigest: input.provisioningState.stateDigest,
    coordinatorJournalDigest: coordinatorJournal.journalDigest,
    coordinatorCheckpoint: checkpoint,
    accounting: summarizeExp0001aCodexAccounting(accountingLedger),
    isolation: {
      taskWorkspace: "projectless",
      repositoryAccess: false,
      privateApiAccess: false,
      sharedHistory: false,
    },
  });
  return Object.freeze(exp0001aCodexRuntimePreflightReceiptSchema.parse({
    ...content,
    receiptDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

export function verifyExp0001aCodexRuntimePreflight(
  receiptInput: unknown,
  executionCheckedAtInput?: string,
): Exp0001aCodexRuntimePreflightReceipt {
  const receipt = exp0001aCodexRuntimePreflightReceiptSchema.parse(receiptInput);
  const { receiptDigest: _digest, ...content } = receipt;
  void _digest;
  if (hashCanonicalJson(preflightContentSchema.parse(content) as unknown as JsonValue) !== receipt.receiptDigest) {
    throw new Error("EXP0001A_CODEX_RUNTIME_PREFLIGHT_DIGEST_INVALID");
  }
  const executionCheckedAt = z.string().datetime({ offset: true }).parse(
    executionCheckedAtInput ?? new Date().toISOString(),
  );
  const checkpoint = receipt.coordinatorCheckpoint;
  const { authoritySignature: _authoritySignature, ...checkpointPayload } = checkpoint;
  void _authoritySignature;
  verifyExp0001aCodexAuthoritySignature({
    payload: checkpointPayload as unknown as JsonValue,
    signature: checkpoint.authoritySignature,
    purpose: "coordinator_checkpoint",
    notBefore: checkpoint.recordedAt,
  });
  const exactBindings = {
    freezeDigest: receipt.freezeDigest,
    prebriefFreezeAuthorityPayloadDigest: receipt.prebriefFreezeAuthorityPayloadDigest,
    prebriefFreezeAuthoritySignatureDigest: receipt.prebriefFreezeAuthoritySignatureDigest,
    spikeEvidenceDigest: receipt.spikeEvidenceDigest,
    spikeGateDigest: receipt.spikeGateDigest,
    frozenScheduleDigest: receipt.frozenScheduleDigest,
    schedulerStateDigest: receipt.schedulerStateDigest,
    accountingLedgerDigest: receipt.accountingLedgerDigest,
    provisioningStateDigest: receipt.provisioningStateDigest,
    coordinatorJournalDigest: receipt.coordinatorJournalDigest,
    authorizedActionDigest: receipt.nextAction.actionDigest,
  } as const;
  for (const [field, expected] of Object.entries(exactBindings)) {
    if (checkpoint[field as keyof typeof exactBindings] !== expected) {
      throw new Error(`EXP0001A_CODEX_RUNTIME_PREFLIGHT_CHECKPOINT_DRIFT:${field}`);
    }
  }
  if (receipt.nextAction.coordinatorActionIssuedAt !== checkpoint.recordedAt) {
    throw new Error("EXP0001A_CODEX_RUNTIME_PREFLIGHT_CHECKPOINT_ACTION_TIME_DRIFT");
  }
  const executionMs = Date.parse(executionCheckedAt);
  const preflightMs = Date.parse(receipt.checkedAt);
  const authMs = Date.parse(receipt.authCheckedAt);
  const checkpointMs = Date.parse(checkpoint.recordedAt);
  const expiryMs = Date.parse(checkpoint.expiresAt);
  const signedMs = Date.parse(checkpoint.authoritySignature.signedAt);
  if (![executionMs, preflightMs, authMs, checkpointMs, expiryMs, signedMs].every(Number.isFinite)
      || authMs > preflightMs || preflightMs < checkpointMs || preflightMs > expiryMs
      || signedMs < checkpointMs || signedMs > preflightMs || signedMs > expiryMs
      || executionMs < preflightMs || executionMs > expiryMs
      || executionMs - authMs > EXP0001A_CODEX_AUTH_MAX_AGE_MS
      || executionMs - checkpointMs > EXP0001A_CODEX_CHECKPOINT_MAX_AGE_MS) {
    throw new Error("EXP0001A_CODEX_RUNTIME_PREFLIGHT_AUTHORITY_STALE");
  }
  return Object.freeze(receipt);
}
