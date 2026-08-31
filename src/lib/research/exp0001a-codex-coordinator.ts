import { z } from "zod";

import {
  nextExp0001aProvisioningAction,
  projectNextExp0001aProvisioningAction,
  type BrowserWebMcpCommand,
  type Exp0001aNextProvisioningAction,
  type Exp0001aAttemptProvisioningPlanSet,
  type Exp0001aProvisioningCoordinator,
  type Exp0001aProvisioningCoordinatorState,
} from "./exp0001a-attempt-provisioning";
import type { DevelopmentExecutionManifest } from "./development-manifest";
import {
  exp0001aCodexArtifactPacketServerStartReceiptSchema,
  exp0001aCodexArtifactPacketServerStopReceiptSchema,
} from "./exp0001a-codex-artifact-packet-server";
import {
  EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
  EXP0001A_SUBSCRIPTION_PROBE_PROMPT,
  EXP0001A_SUBSCRIPTION_PROBE_PROMPT_DIGEST,
  beginNextExp0001aCodexAssignment,
  completeActiveExp0001aCodexAssignment,
  exp0001aCodexAccountingLedgerSchema,
  exp0001aCodexTaskAccountingSchema,
  exp0001aCodexSchedulerStateSchema,
  pauseExp0001aCodexSchedulerForUsageLimit,
  terminalizeActiveExp0001aCodexAssignment,
  type Exp0001aCodexAccountingLedger,
  type Exp0001aCodexTaskAccounting,
} from "./exp0001a-codex-accounting";
import {
  exp0001aCodexAccountingFinalizationReceiptSchema,
  finalizeExp0001aCodexTaskAccounting,
  verifyExp0001aCodexAccountingFinalizationReceipt,
  type Exp0001aCodexAccountingFinalizationReceipt,
} from "./exp0001a-codex-accounting-finalizer";
import {
  createExp0001aAdjudicatorTaskEnvelopeFromSubject,
  createExp0001aAuthorTaskEnvelopeFromProvisioningHandoff,
  createExp0001aPairwiseVisualJudgeTaskEnvelopeFromSubject,
  createExp0001aPrimaryReviewerTaskEnvelopeFromSubject,
  exp0001aCodexTaskEnvelopeSchema,
  exp0001aCodexArtifactPacketReadyReceiptSchema,
  exp0001aCodexReleaseInvocationReceiptSchema,
  exp0001aAuthorFinalRoomReadReceiptSchema,
  exp0001aCodexTaskLifecycleSchema,
  exp0001aCodexTaskTransportPlanSchema,
  issueExp0001aAuthorFinalEvidenceCommand,
  issueExp0001aCreateReconciliationCommand,
  issueExp0001aReadThreadCommand,
  issueExp0001aWaitThreadsCommand,
  prepareExp0001aCodexTaskTransportWithFreshAuth,
  probeExp0001aCodexArtifactPacket,
  recordExp0001aAuthorFinalEvidenceResult,
  recordExp0001aCreateReconciliationResult,
  recordExp0001aCreateThreadReleaseInvoked,
  recordExp0001aCreateThreadResult,
  recordExp0001aReadThreadResult,
  recordExp0001aWaitThreadsResult,
  type Exp0001aCodexReleaseInvocationReceipt,
  type Exp0001aAuthorFinalRoomReadReceipt,
  type Exp0001aCodexTaskLifecycle,
  type Exp0001aCodexTaskTransportPlan,
} from "./exp0001a-codex-task-transport";
import type { Exp0001aCodexPrebriefFreeze } from "./exp0001a-codex-prebrief-freeze";
import {
  createExp0001aCodexScientificState,
  exp0001aCodexScientificStateSchema,
  nextExp0001aScientificReviewWorkItem,
  performExp0001aCodexScientificTransition,
  type Exp0001aCodexScientificState,
  type Exp0001aScientificTransition,
} from "./exp0001a-codex-scientific-runtime";
import type { Exp0001aCodexReviewPlanManifest } from "./exp0001a-codex-review-runtime";
import {
  verifyExp0001aCodexCompletionAttestation,
  type Exp0001aCodexCompletionAttestation,
  type Exp0001aCodexCompletionEvidence,
} from "./exp0001a-completion-attestation";
import { hashCanonicalJson, SHA256_DIGEST_PATTERN, type JsonValue } from "./provenance-crypto";

export const EXP0001A_CODEX_COORDINATOR_VERSION = "exp-0001a-codex-coordinator/v2" as const;
export const EXP0001A_CODEX_COORDINATOR_JOURNAL_VERSION =
  "exp-0001a-codex-coordinator-journal/v1" as const;

const timestampSchema = z.string().datetime({ offset: true });
const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
export const EXP0001A_COORDINATOR_ROLE_CAPACITIES = Object.freeze({
  subscription_probe: 216,
  spike_author: 0,
  author: 48,
  primary_reviewer: 96,
  adjudicator: 48,
  pairwise_visual_judge: 24,
} as const);
export const EXP0001A_COORDINATOR_EXPERIMENTAL_TASK_CAPACITY = Object.values(EXP0001A_COORDINATOR_ROLE_CAPACITIES)
  .reduce<number>((total, count) => total + count, 0);
export const EXP0001A_COORDINATOR_PRECREATION_DISPATCH_CAPACITY = 216 as const;
export const EXP0001A_COORDINATOR_TASK_CAPACITY =
  EXP0001A_COORDINATOR_EXPERIMENTAL_TASK_CAPACITY
  + EXP0001A_COORDINATOR_PRECREATION_DISPATCH_CAPACITY;

const artifactPacketSidecarStartResultSchema = z.object({
  schemaVersion: z.literal("exp-0001a-artifact-packet-sidecar/v1"),
  packetId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  state: z.literal("active"),
  role: z.enum(["primary_reviewer", "adjudicator", "pairwise_visual_judge"]),
  subjectDigest: digestSchema,
  envelope: exp0001aCodexTaskEnvelopeSchema.refine((envelope) => envelope.role !== "author"),
  startReceipt: exp0001aCodexArtifactPacketServerStartReceiptSchema,
  readyReceipt: exp0001aCodexArtifactPacketReadyReceiptSchema,
}).strict();

const artifactPacketSidecarStoppedResultSchema = z.object({
  schemaVersion: z.literal("exp-0001a-artifact-packet-sidecar/v1"),
  packetId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  state: z.literal("stopped"),
  stopReceipt: exp0001aCodexArtifactPacketServerStopReceiptSchema,
}).strict();

const artifactPacketCrashRecoveryTaskLifecycleStateSchema = z.enum([
  "terminal",
  "not_started_usage_limited",
  "not_started_failed",
]);
type ArtifactPacketCrashRecoveryTaskLifecycleState = z.infer<
  typeof artifactPacketCrashRecoveryTaskLifecycleStateSchema
>;

const ARTIFACT_PACKET_CRASH_RECOVERY_PROVENANCE = Object.freeze({
  terminal: Object.freeze({
    kind: "artifact-packet-sidecar-terminal-crash-recovery" as const,
    reason: "task-lifecycle-terminal-before-sidecar-stop-receipt" as const,
    reviewerEvidenceDisposition: "preserved_by_terminal_coordinator_task_lifecycle" as const,
  }),
  not_started_usage_limited: Object.freeze({
    kind: "artifact-packet-sidecar-unstarted-task-crash-recovery" as const,
    reason: "reviewer-create-usage-limited-before-task-begun" as const,
    reviewerEvidenceDisposition: "same_assignment_preserved_unstarted_for_usage_reset_retry" as const,
  }),
  not_started_failed: Object.freeze({
    kind: "artifact-packet-sidecar-unstarted-task-crash-recovery" as const,
    reason: "reviewer-create-failed-before-task-begun" as const,
    reviewerEvidenceDisposition: "same_assignment_preserved_unstarted_for_create_retry" as const,
  }),
} satisfies Readonly<Record<ArtifactPacketCrashRecoveryTaskLifecycleState, Readonly<{
  kind:
    | "artifact-packet-sidecar-terminal-crash-recovery"
    | "artifact-packet-sidecar-unstarted-task-crash-recovery";
  reason:
    | "task-lifecycle-terminal-before-sidecar-stop-receipt"
    | "reviewer-create-usage-limited-before-task-begun"
    | "reviewer-create-failed-before-task-begun";
  reviewerEvidenceDisposition:
    | "preserved_by_terminal_coordinator_task_lifecycle"
    | "same_assignment_preserved_unstarted_for_usage_reset_retry"
    | "same_assignment_preserved_unstarted_for_create_retry";
}>>>);

const artifactPacketCrashRecoveryReceiptContentObjectSchema = z.object({
  schemaVersion: z.literal("exp-0001a-artifact-packet-sidecar/v1"),
  kind: z.enum([
    "artifact-packet-sidecar-terminal-crash-recovery",
    "artifact-packet-sidecar-unstarted-task-crash-recovery",
  ]),
  packetId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  recoveredAt: timestampSchema,
  taskLifecycleState: artifactPacketCrashRecoveryTaskLifecycleStateSchema,
  reason: z.enum([
    "task-lifecycle-terminal-before-sidecar-stop-receipt",
    "reviewer-create-usage-limited-before-task-begun",
    "reviewer-create-failed-before-task-begun",
  ]),
  crashReconciliationReceiptDigest: digestSchema,
  startReceiptDigest: digestSchema,
  readyReceiptDigest: digestSchema,
  reviewerEnvelopeDigest: digestSchema,
  subjectDigest: digestSchema,
  serverProcessState: z.literal("confirmed_not_running"),
  packetAccessEvidence: z.literal("readiness_receipt_retained_runtime_counters_unavailable_after_crash"),
  reviewerEvidenceDisposition: z.enum([
    "preserved_by_terminal_coordinator_task_lifecycle",
    "same_assignment_preserved_unstarted_for_usage_reset_retry",
    "same_assignment_preserved_unstarted_for_create_retry",
  ]),
}).strict();

function validateArtifactPacketCrashRecoveryProvenance(
  receipt: z.infer<typeof artifactPacketCrashRecoveryReceiptContentObjectSchema>,
  context: z.RefinementCtx,
): void {
  const expected = ARTIFACT_PACKET_CRASH_RECOVERY_PROVENANCE[receipt.taskLifecycleState];
  if (receipt.kind !== expected.kind) {
    context.addIssue({ code: "custom", path: ["kind"], message: "Artifact-packet recovery kind does not match task lifecycle state." });
  }
  if (receipt.reason !== expected.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Artifact-packet recovery reason does not match task lifecycle state." });
  }
  if (receipt.reviewerEvidenceDisposition !== expected.reviewerEvidenceDisposition) {
    context.addIssue({ code: "custom", path: ["reviewerEvidenceDisposition"],
      message: "Artifact-packet recovery disposition does not match task lifecycle state." });
  }
}

const artifactPacketCrashRecoveryReceiptSchema = artifactPacketCrashRecoveryReceiptContentObjectSchema.extend({
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest: _digest, ...content } = receipt;
  void _digest;
  validateArtifactPacketCrashRecoveryProvenance(content, context);
  if (hashCanonicalJson(content as unknown as JsonValue) !== receipt.receiptDigest) {
    context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Artifact-packet recovery receipt digest is invalid." });
  }
});
const artifactPacketSidecarRecoveredResultSchema = z.object({
  schemaVersion: z.literal("exp-0001a-artifact-packet-sidecar/v1"),
  packetId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  state: z.literal("recovered_after_crash"),
  recoveryReceipt: artifactPacketCrashRecoveryReceiptSchema,
}).strict();
const artifactPacketSidecarStopResultSchema = z.union([
  artifactPacketSidecarStoppedResultSchema,
  artifactPacketSidecarRecoveredResultSchema,
]);

const artifactPacketLifecycleContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-coordinator-artifact-packet-lifecycle/v1"),
  packetId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  assignmentId: z.string().trim().min(1).max(240),
  workItemDigest: digestSchema,
  role: z.enum(["primary_reviewer", "adjudicator", "pairwise_visual_judge"]),
  subjectDigest: digestSchema,
  envelopeDigest: digestSchema,
  startReceipt: exp0001aCodexArtifactPacketServerStartReceiptSchema,
  sidecarReadyReceipt: exp0001aCodexArtifactPacketReadyReceiptSchema,
  planReadyReceipt: exp0001aCodexArtifactPacketReadyReceiptSchema,
  planDigest: digestSchema,
  stopReceipt: exp0001aCodexArtifactPacketServerStopReceiptSchema.nullable(),
  recoveryReceipt: artifactPacketCrashRecoveryReceiptSchema.nullable(),
  terminalTaskLifecycleDigest: digestSchema.nullable(),
  state: z.enum(["active", "stopped", "recovered_after_crash"]),
}).strict();
const artifactPacketLifecycleSchema = artifactPacketLifecycleContentSchema.extend({
  lifecycleDigest: digestSchema,
}).strict().superRefine((lifecycle, context) => {
  const { lifecycleDigest: _digest, ...content } = lifecycle;
  void _digest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== lifecycle.lifecycleDigest) {
    context.addIssue({ code: "custom", path: ["lifecycleDigest"], message: "Artifact-packet lifecycle digest is invalid." });
  }
  const activeShape = lifecycle.state === "active" && lifecycle.stopReceipt === null
    && lifecycle.recoveryReceipt === null && lifecycle.terminalTaskLifecycleDigest === null;
  const stoppedShape = lifecycle.state === "stopped" && lifecycle.stopReceipt !== null
    && lifecycle.recoveryReceipt === null && lifecycle.terminalTaskLifecycleDigest !== null;
  const recoveredShape = lifecycle.state === "recovered_after_crash" && lifecycle.stopReceipt === null
    && lifecycle.recoveryReceipt !== null && lifecycle.terminalTaskLifecycleDigest !== null;
  if (!activeShape && !stoppedShape && !recoveredShape) {
    context.addIssue({ code: "custom", path: ["state"], message: "Artifact-packet terminal evidence differs from lifecycle state." });
  }
});
export type Exp0001aCoordinatorArtifactPacketLifecycle = z.infer<typeof artifactPacketLifecycleSchema>;

function sealArtifactPacketLifecycle(
  input: z.input<typeof artifactPacketLifecycleContentSchema>,
): Exp0001aCoordinatorArtifactPacketLifecycle {
  const content = artifactPacketLifecycleContentSchema.parse(input);
  return Object.freeze(artifactPacketLifecycleSchema.parse({
    ...content,
    lifecycleDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

/**
 * Projects only packet-terminal evidence. The caller retains the returned task
 * lifecycle digest in the packet lifecycle, so a crash recovery cannot detach
 * the packet from its already-terminal reviewer or cause that work to rerun.
 */
export function projectExp0001aArtifactPacketTerminalEvidence(input: Readonly<{
  packetLifecycle: Readonly<{
    packetId: string;
    startReceipt: Readonly<{ receiptDigest: string }>;
    sidecarReadyReceipt: Readonly<{ receiptDigest: string }>;
    envelopeDigest: string;
    subjectDigest: string;
  }>;
  terminalTaskLifecycle: Readonly<{
    state: Exp0001aCodexTaskLifecycle["state"];
    lifecycleDigest: string;
  }>;
  rawResult: unknown;
}>): Readonly<{
  stopReceipt: z.infer<typeof exp0001aCodexArtifactPacketServerStopReceiptSchema> | null;
  recoveryReceipt: z.infer<typeof artifactPacketCrashRecoveryReceiptSchema> | null;
  terminalTaskLifecycleDigest: string;
  state: "stopped" | "recovered_after_crash";
}> {
  if (input.terminalTaskLifecycle.state !== "terminal"
      && input.terminalTaskLifecycle.state !== "not_started_usage_limited"
      && input.terminalTaskLifecycle.state !== "not_started_failed") {
    throw new Error("EXP0001A_PACKET_STOP_REQUIRES_EXACT_TERMINAL_TASK_LIFECYCLE");
  }
  const retained = artifactPacketSidecarStopResultSchema.parse(input.rawResult);
  const packet = input.packetLifecycle;
  if (retained.packetId !== packet.packetId) {
    throw new Error("EXP0001A_PACKET_TERMINAL_RESULT_PACKET_BINDING_INVALID");
  }
  if (retained.state === "stopped") {
    if (retained.stopReceipt.startReceiptDigest !== packet.startReceipt.receiptDigest
        || retained.stopReceipt.readyReceiptDigest !== packet.sidecarReadyReceipt.receiptDigest
        || retained.stopReceipt.reviewerEnvelopeDigest !== packet.envelopeDigest
        || retained.stopReceipt.subjectDigest !== packet.subjectDigest) {
      throw new Error("EXP0001A_PACKET_STOP_RESULT_BINDING_INVALID");
    }
    return Object.freeze({
      stopReceipt: retained.stopReceipt,
      recoveryReceipt: null,
      terminalTaskLifecycleDigest: input.terminalTaskLifecycle.lifecycleDigest,
      state: retained.state,
    });
  }
  if (retained.recoveryReceipt.packetId !== packet.packetId
      || retained.recoveryReceipt.startReceiptDigest !== packet.startReceipt.receiptDigest
      || retained.recoveryReceipt.readyReceiptDigest !== packet.sidecarReadyReceipt.receiptDigest
      || retained.recoveryReceipt.reviewerEnvelopeDigest !== packet.envelopeDigest
      || retained.recoveryReceipt.subjectDigest !== packet.subjectDigest
      || retained.recoveryReceipt.taskLifecycleState !== input.terminalTaskLifecycle.state) {
    throw new Error("EXP0001A_PACKET_CRASH_RECOVERY_RESULT_BINDING_INVALID");
  }
  return Object.freeze({
    stopReceipt: null,
    recoveryReceipt: retained.recoveryReceipt,
    terminalTaskLifecycleDigest: input.terminalTaskLifecycle.lifecycleDigest,
    state: retained.state,
  });
}

const journalContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_COORDINATOR_JOURNAL_VERSION),
  protocolId: z.literal("EXP-0001A"),
  provisioningStateDigest: digestSchema,
  plans: z.array(exp0001aCodexTaskTransportPlanSchema).max(EXP0001A_COORDINATOR_TASK_CAPACITY),
  releaseInvocations: z.array(exp0001aCodexReleaseInvocationReceiptSchema).max(EXP0001A_COORDINATOR_TASK_CAPACITY),
  lifecycles: z.array(exp0001aCodexTaskLifecycleSchema).max(EXP0001A_COORDINATOR_TASK_CAPACITY),
  accountingFinalizationReceipts: z.array(exp0001aCodexAccountingFinalizationReceiptSchema)
    .max(EXP0001A_COORDINATOR_TASK_CAPACITY),
  subscriptionProbeAccountingRecords: z.array(exp0001aCodexTaskAccountingSchema)
    .max(EXP0001A_COORDINATOR_ROLE_CAPACITIES.subscription_probe),
  subscriptionProbeAttemptDigests: z.array(digestSchema)
    .max(EXP0001A_COORDINATOR_ROLE_CAPACITIES.subscription_probe),
  authorFinalEvidenceReceipts: z.array(exp0001aAuthorFinalRoomReadReceiptSchema).max(48),
  artifactPacketLifecycles: z.array(artifactPacketLifecycleSchema)
    .max(EXP0001A_COORDINATOR_TASK_CAPACITY),
  scientificState: exp0001aCodexScientificStateSchema.nullable(),
  reviewProgress: z.object({
    authorArtifactCatalogDigest: digestSchema.nullable(),
    primaryWorkOrderDigest: digestSchema.nullable(),
    primaryResultLedgerDigest: digestSchema.nullable(),
    disagreementArtifactIds: z.array(z.string().min(1).max(240)).max(48),
    adjudicationWorkOrderDigest: digestSchema.nullable(),
    adjudicationResultLedgerDigest: digestSchema.nullable(),
    classificationLockDigest: digestSchema.nullable(),
    pairwiseWorkOrderDigest: digestSchema.nullable(),
    pairwiseResultLedgerDigest: digestSchema.nullable(),
    analysisReportDigest: digestSchema.nullable(),
    signedCompletionAttestationDigest: digestSchema.nullable(),
  }).strict(),
  priorJournalDigest: digestSchema.nullable(),
}).strict();

export const exp0001aCodexCoordinatorJournalSchema = journalContentSchema.extend({
  journalDigest: digestSchema,
}).strict().superRefine((journal, context) => {
  const { journalDigest: _journalDigest, ...content } = journal;
  void _journalDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== journal.journalDigest) {
    context.addIssue({ code: "custom", path: ["journalDigest"], message: "Coordinator journal digest is invalid." });
  }
  const planByDigest = new Map(journal.plans.map((plan) => [plan.planDigest, plan]));
  const planByTransport = new Map(journal.plans.map((plan) => [plan.transportId, plan]));
  if (planByDigest.size !== journal.plans.length || planByTransport.size !== journal.plans.length) {
    context.addIssue({ code: "custom", path: ["plans"], message: "Coordinator plans must have unique plan and transport identities." });
  }
  const releaseByPlan = new Map<string, Exp0001aCodexReleaseInvocationReceipt>();
  for (const receipt of journal.releaseInvocations) {
    const plan = planByDigest.get(receipt.planDigest);
    if (!plan || plan.transportId !== receipt.transportId
        || plan.createThreadCommand.commandDigest !== receipt.commandDigest
        || releaseByPlan.has(receipt.planDigest)) {
      context.addIssue({ code: "custom", path: ["releaseInvocations"], message: "Release invocation must uniquely bind an exact retained plan." });
    }
    releaseByPlan.set(receipt.planDigest, receipt);
  }
  const lifecycleByPlan = new Map<string, Exp0001aCodexTaskLifecycle>();
  for (const lifecycle of journal.lifecycles) {
    const plan = planByDigest.get(lifecycle.planDigest);
    const release = releaseByPlan.get(lifecycle.planDigest);
    if (!plan || plan.transportId !== lifecycle.transportId || !release
        || lifecycle.releaseInvocationReceipt.receiptDigest !== release.receiptDigest
        || lifecycleByPlan.has(lifecycle.planDigest)) {
      context.addIssue({ code: "custom", path: ["lifecycles"], message: "Lifecycle must uniquely bind a retained plan and release invocation." });
    }
    lifecycleByPlan.set(lifecycle.planDigest, lifecycle);
  }
  const accountingByPlan = new Map<string, Exp0001aCodexAccountingFinalizationReceipt>();
  for (const receipt of journal.accountingFinalizationReceipts) {
    const plan = planByDigest.get(receipt.planDigest);
    const lifecycle = lifecycleByPlan.get(receipt.planDigest);
    if (!plan || !lifecycle || lifecycle.state !== "terminal" || !lifecycle.taskBegun
        || lifecycle.lifecycleDigest !== receipt.lifecycleDigest
        || accountingByPlan.has(receipt.planDigest)) {
      context.addIssue({ code: "custom", path: ["accountingFinalizationReceipts"],
        message: "Accounting finalization must uniquely bind an exact terminal begun lifecycle." });
      continue;
    }
    try {
      verifyExp0001aCodexAccountingFinalizationReceipt({ receipt, plan, lifecycle });
    } catch {
      context.addIssue({ code: "custom", path: ["accountingFinalizationReceipts"],
        message: "Accounting finalization receipt cannot be reconstructed from retained transport evidence." });
      continue;
    }
    accountingByPlan.set(receipt.planDigest, receipt);
  }
  const probeAccountingIds = new Set<string>();
  const probeTaskIds = new Set<string>();
  for (const record of journal.subscriptionProbeAccountingRecords) {
    if (record.role !== "subscription_probe" || record.state !== "terminal"
        || probeAccountingIds.has(record.accountingId) || probeTaskIds.has(record.codexTaskId)) {
      context.addIssue({ code: "custom", path: ["subscriptionProbeAccountingRecords"],
        message: "Subscription probe accounting must be terminal, role-bound, and uniquely identified." });
    }
    probeAccountingIds.add(record.accountingId);
    probeTaskIds.add(record.codexTaskId);
  }
  if (new Set(journal.subscriptionProbeAttemptDigests).size !== journal.subscriptionProbeAttemptDigests.length
      || journal.subscriptionProbeAccountingRecords.length > journal.subscriptionProbeAttemptDigests.length) {
    context.addIssue({ code: "custom", path: ["subscriptionProbeAttemptDigests"],
      message: "Subscription probe attempts must be unique and retain every terminal probe task." });
  }
  const packetIds = new Set<string>();
  let activePackets = 0;
  for (const packet of journal.artifactPacketLifecycles) {
    const plan = planByDigest.get(packet.planDigest);
    const taskLifecycle = lifecycleByPlan.get(packet.planDigest);
    if (packetIds.has(packet.packetId) || !plan || plan.role !== packet.role
        || plan.privateBinding.assignmentId !== packet.assignmentId
        || plan.envelopeDigest !== packet.envelopeDigest
        || plan.artifactPacketReadyReceipt?.receiptDigest !== packet.planReadyReceipt.receiptDigest
        || packet.startReceipt.role !== packet.role
        || packet.startReceipt.subjectDigest !== packet.subjectDigest
        || packet.startReceipt.reviewerEnvelopeDigest !== packet.envelopeDigest
        || packet.sidecarReadyReceipt.envelopeDigest !== packet.envelopeDigest
        || packet.planReadyReceipt.envelopeDigest !== packet.envelopeDigest) {
      context.addIssue({ code: "custom", path: ["artifactPacketLifecycles"],
        message: "Artifact-packet lifecycle is not bound to one exact reviewer plan and subject." });
    }
    if (packet.state === "active") {
      activePackets += 1;
    } else if (!taskLifecycle
        || (taskLifecycle.state !== "terminal"
          && taskLifecycle.state !== "not_started_usage_limited"
          && taskLifecycle.state !== "not_started_failed")
        || packet.terminalTaskLifecycleDigest !== taskLifecycle.lifecycleDigest) {
      context.addIssue({ code: "custom", path: ["artifactPacketLifecycles"],
        message: "Terminal packet must bind the exact terminal review task lifecycle." });
    } else if (packet.state === "stopped"
        && (packet.stopReceipt?.startReceiptDigest !== packet.startReceipt.receiptDigest
          || packet.stopReceipt.readyReceiptDigest !== packet.sidecarReadyReceipt.receiptDigest
          || packet.stopReceipt.reviewerEnvelopeDigest !== packet.envelopeDigest
          || packet.stopReceipt.subjectDigest !== packet.subjectDigest)) {
      context.addIssue({ code: "custom", path: ["artifactPacketLifecycles"],
        message: "Stopped packet must bind the exact sidecar receipts." });
    } else if (packet.state === "recovered_after_crash") {
      const recovery = packet.recoveryReceipt;
      if (recovery === null || recovery.packetId !== packet.packetId
          || recovery.startReceiptDigest !== packet.startReceipt.receiptDigest
          || recovery.readyReceiptDigest !== packet.sidecarReadyReceipt.receiptDigest
          || recovery.reviewerEnvelopeDigest !== packet.envelopeDigest
          || recovery.subjectDigest !== packet.subjectDigest
          || recovery.taskLifecycleState !== taskLifecycle.state) {
        context.addIssue({ code: "custom", path: ["artifactPacketLifecycles"],
          message: "Crash-recovered packet must bind the exact sidecar and reviewer task lifecycle state." });
      }
    }
    packetIds.add(packet.packetId);
  }
  if (activePackets > 1) {
    context.addIssue({ code: "custom", path: ["artifactPacketLifecycles"],
      message: "Sequential execution permits at most one active artifact-packet sidecar." });
  }
  for (const lifecycle of journal.lifecycles) {
    if (lifecycle.state === "terminal" && lifecycle.taskBegun
        && !accountingByPlan.has(lifecycle.planDigest)) {
      context.addIssue({ code: "custom", path: ["accountingFinalizationReceipts"],
        message: "Every terminal begun lifecycle requires one transport-derived accounting finalization." });
    }
  }
  const finalEvidenceByPlan = new Map<string, Exp0001aAuthorFinalRoomReadReceipt>();
  for (const receipt of journal.authorFinalEvidenceReceipts) {
    const plan = planByDigest.get(receipt.authorPlanDigest);
    const lifecycle = lifecycleByPlan.get(receipt.authorPlanDigest);
    if (!plan || plan.role !== "author" || plan.transportId !== receipt.transportId
        || !lifecycle || lifecycle.taskBegun !== true || lifecycle.codexTaskId !== receipt.codexTaskId
        || finalEvidenceByPlan.has(receipt.authorPlanDigest)) {
      context.addIssue({ code: "custom", path: ["authorFinalEvidenceReceipts"], message: "Final author evidence must uniquely bind an exact begun author lifecycle." });
    }
    finalEvidenceByPlan.set(receipt.authorPlanDigest, receipt);
  }
  for (const [role, capacity] of Object.entries(EXP0001A_COORDINATOR_ROLE_CAPACITIES)) {
    const rolePlans = journal.plans.filter((plan) => plan.role === role);
    const begun = rolePlans.filter((plan) => lifecycleByPlan.get(plan.planDigest)?.taskBegun === true);
    const precreation = rolePlans.filter((plan) => lifecycleByPlan.get(plan.planDigest)?.taskBegun === false);
    if (begun.length > capacity) {
      context.addIssue({
        code: "custom",
        path: ["plans"],
        message: `Coordinator ${role} begun-task capacity exceeded.`,
      });
    }
    if (precreation.some((plan) => {
      const lifecycle = lifecycleByPlan.get(plan.planDigest);
      return lifecycle === undefined
        || (lifecycle.state !== "not_started_usage_limited" && lifecycle.state !== "not_started_failed");
    })) {
      context.addIssue({ code: "custom", path: ["lifecycles"],
        message: `Coordinator ${role} precreation history must contain only canonical unstarted stops.` });
    }
    const begunAssignments = begun.map((plan) => plan.privateBinding.assignmentId);
    if (new Set(begunAssignments).size !== begunAssignments.length) {
      context.addIssue({
        code: "custom",
        path: ["lifecycles"],
        message: `Coordinator ${role} permits exactly one begun task per work item.`,
      });
    }
  }
  if (journal.scientificState !== null) {
    const scientific = journal.scientificState;
    const bindings = [
      ["authorArtifactCatalogDigest", scientific.authorCatalog?.catalogDigest ?? null],
      ["primaryWorkOrderDigest", scientific.primaryWorkOrder?.workOrderDigest ?? null],
      ["primaryResultLedgerDigest", scientific.primaryResults?.resultLedgerDigest ?? null],
      ["adjudicationWorkOrderDigest", scientific.adjudicationWorkOrder?.workOrderDigest ?? null],
      ["adjudicationResultLedgerDigest", scientific.adjudicationResults?.resultLedgerDigest ?? null],
      ["classificationLockDigest", scientific.classifications?.classificationBookDigest ?? null],
      ["pairwiseWorkOrderDigest", scientific.pairwiseWorkOrder?.workOrderDigest ?? null],
      ["pairwiseResultLedgerDigest", scientific.pairwiseResults?.resultLedgerDigest ?? null],
      ["analysisReportDigest", scientific.analysisReceipt?.analysisReportDigest ?? null],
    ] as const;
    for (const [field, value] of bindings) {
      if (journal.reviewProgress[field] !== value) {
        context.addIssue({ code: "custom", path: ["reviewProgress", field],
          message: "Review progress digest differs from the reconstructed scientific state." });
      }
    }
    const disagreements = scientific.adjudicationWorkOrder?.disagreementArtifactIds ?? [];
    if (JSON.stringify(journal.reviewProgress.disagreementArtifactIds) !== JSON.stringify(disagreements)) {
      context.addIssue({ code: "custom", path: ["reviewProgress", "disagreementArtifactIds"],
        message: "Disagreement list differs from the reconstructed adjudication work order." });
    }
  }
  if (journal.plans.filter((plan) => !lifecycleByPlan.has(plan.planDigest)).length > 1) {
    context.addIssue({ code: "custom", path: ["plans"], message: "Sequential execution permits at most one released plan without a lifecycle." });
  }
  const nonterminal = journal.lifecycles.filter((record) => record.state === "creation_uncertain"
    || record.state === "running" || record.state === "awaiting_terminal_read");
  if (nonterminal.length > 1) {
    context.addIssue({ code: "custom", path: ["lifecycles"], message: "Sequential execution permits at most one nonterminal task." });
  }
});
export type Exp0001aCodexCoordinatorJournal = z.infer<typeof exp0001aCodexCoordinatorJournalSchema>;

export function createExp0001aCodexCoordinatorJournal(input: Readonly<{
  provisioningState: Exp0001aProvisioningCoordinatorState;
  plans?: readonly Exp0001aCodexTaskTransportPlan[];
  releaseInvocations?: readonly Exp0001aCodexReleaseInvocationReceipt[];
  lifecycles?: readonly Exp0001aCodexTaskLifecycle[];
  accountingFinalizationReceipts?: readonly Exp0001aCodexAccountingFinalizationReceipt[];
  subscriptionProbeAccountingRecords?: readonly Exp0001aCodexTaskAccounting[];
  subscriptionProbeAttemptDigests?: readonly string[];
  authorFinalEvidenceReceipts?: readonly Exp0001aAuthorFinalRoomReadReceipt[];
  artifactPacketLifecycles?: readonly Exp0001aCoordinatorArtifactPacketLifecycle[];
  scientificState?: Exp0001aCodexScientificState | null;
  priorJournalDigest?: string | null;
  reviewProgress?: z.input<typeof journalContentSchema>["reviewProgress"];
}>): Exp0001aCodexCoordinatorJournal {
  nextExp0001aProvisioningAction(input.provisioningState);
  const content = journalContentSchema.parse({
    schemaVersion: EXP0001A_CODEX_COORDINATOR_JOURNAL_VERSION,
    protocolId: "EXP-0001A",
    provisioningStateDigest: input.provisioningState.stateDigest,
    plans: [...(input.plans ?? [])],
    releaseInvocations: [...(input.releaseInvocations ?? [])],
    lifecycles: [...(input.lifecycles ?? [])],
    accountingFinalizationReceipts: [...(input.accountingFinalizationReceipts ?? [])],
    subscriptionProbeAccountingRecords: [...(input.subscriptionProbeAccountingRecords ?? [])],
    subscriptionProbeAttemptDigests: [...(input.subscriptionProbeAttemptDigests ?? [])],
    authorFinalEvidenceReceipts: [...(input.authorFinalEvidenceReceipts ?? [])],
    artifactPacketLifecycles: [...(input.artifactPacketLifecycles ?? [])],
    scientificState: input.scientificState ?? null,
    reviewProgress: input.reviewProgress ?? {
      authorArtifactCatalogDigest: null,
      primaryWorkOrderDigest: null,
      primaryResultLedgerDigest: null,
      disagreementArtifactIds: [],
      adjudicationWorkOrderDigest: null,
      adjudicationResultLedgerDigest: null,
      classificationLockDigest: null,
      pairwiseWorkOrderDigest: null,
      pairwiseResultLedgerDigest: null,
      analysisReportDigest: null,
      signedCompletionAttestationDigest: null,
    },
    priorJournalDigest: input.priorJournalDigest ?? null,
  });
  return Object.freeze(exp0001aCodexCoordinatorJournalSchema.parse({
    ...content,
    journalDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

export type Exp0001aExpectedIngest = Readonly<{
  operation:
    | "retainCreateRoomResult"
    | "reconcileAmbiguousCreate"
    | "retainBlankBaselineRead"
    | "retainSeedResult"
    | "retainPreAuthorRead"
    | "retainInviteJoinResult"
    | "retainInviteRead"
    | "retainCoordinatorPresenceRead"
    | "recordCreateThreadResult"
    | "recordCreateReconciliationResult"
    | "recordWaitThreadsResult"
    | "recordAuthorFinalEvidenceResult"
    | "recordReadThreadResult"
    | "retainSubscriptionProbeResult"
    | "retainArtifactPacketStartResult"
    | "retainArtifactPacketStopResult";
  assignmentId: string | null;
  planDigest: string | null;
  priorStateDigest: string;
  resultMustBeRetainedBeforeNextAction: true;
}>;

type ExternalAction<TKind extends string, TCommand> = Readonly<{
  kind: TKind;
  command: TCommand;
  expectedIngest: Exp0001aExpectedIngest;
  coordinatorDidNotInvokeTool: true;
}>;

type ProvisioningLocalTransition =
  | "reserve_next_attempt"
  | "retain_invite_join_result"
  | "stop_provisioner_presence_renewals"
  | "finalize_room_receipt";

export type Exp0001aCodexCoordinatorAction =
  | (ExternalAction<"perform_provisioning_webmcp", BrowserWebMcpCommand<string, unknown>> & Readonly<{
      session: "coordinator" | "invite_verifier";
      ambiguityReconciliation: Readonly<{
        command: BrowserWebMcpCommand<string, unknown>;
        expectedIngest: Exp0001aExpectedIngest;
        createRetryAllowed: false;
      }> | null;
    }>)
  | Readonly<{
      kind: "release_reserved_create_room";
      assignmentId: string;
      reservationId: string;
      nextExternalAction: "perform_provisioning_webmcp";
      durableReleaseRequiredBeforeEmission: true;
    }>
  | Readonly<{
      kind: "perform_provisioning_local_transition";
      transition: ProvisioningLocalTransition;
      assignmentId: string;
    }>
  | Readonly<{
      kind: "prepare_author_task";
      assignmentId: string;
      requiresFreshChatGptAuth: true;
      requiresCanonicalProvisioningHandoff: true;
    }>
  | Readonly<{
      kind: "record_create_thread_release_invocation";
      plan: Exp0001aCodexTaskTransportPlan;
      requiresFreshChatGptAuth: true;
      promptMayBeReleasedAfterReceipt: true;
    }>
  | ExternalAction<"create_codex_task", Exp0001aCodexTaskTransportPlan["createThreadCommand"]>
  | (ExternalAction<"reconcile_uncertain_create", ReturnType<typeof issueExp0001aCreateReconciliationCommand>> & Readonly<{
      createRetryAllowed: false;
    }>)
  | ExternalAction<"wait_for_active_task", ReturnType<typeof issueExp0001aWaitThreadsCommand>>
  | ExternalAction<"collect_author_final_evidence", ReturnType<typeof issueExp0001aAuthorFinalEvidenceCommand>>
  | ExternalAction<"read_terminal_task", ReturnType<typeof issueExp0001aReadThreadCommand>>
  | Readonly<{
      kind: "start_artifact_packet_sidecar";
      packetId: string;
      startInput: JsonValue;
      expectedIngest: Exp0001aExpectedIngest;
      coordinatorDidNotInvokeTool: true;
    }>
  | Readonly<{
      kind: "stop_artifact_packet_sidecar";
      packetId: string;
      taskLifecycleState: ArtifactPacketCrashRecoveryTaskLifecycleState;
      expectedIngest: Exp0001aExpectedIngest;
      coordinatorDidNotInvokeTool: true;
    }>
  | Readonly<{
      kind: "run_subscription_availability_probe";
      prompt: typeof EXP0001A_SUBSCRIPTION_PROBE_PROMPT;
      promptDigest: typeof EXP0001A_SUBSCRIPTION_PROBE_PROMPT_DIGEST;
      accountingRole: "subscription_probe";
      target: Readonly<{ type: "projectless" }>;
      createThreadCommand: Readonly<{
        schemaVersion: 1;
        toolName: "mcp__codex_app__create_thread";
        arguments: Readonly<{
          prompt: typeof EXP0001A_SUBSCRIPTION_PROBE_PROMPT;
          title: string;
          target: Readonly<{ type: "projectless"; directoryName: string }>;
          model: "gpt-5.6-sol";
          thinking: "low";
        }>;
        commandDigest: string;
      }>;
      benchmarkContentIncluded: false;
      mayReleaseExperimentBrief: false;
      authorityReceiptRequiredBeforeResume: true;
      expectedIngest: Exp0001aExpectedIngest;
      coordinatorDidNotInvokeTool: true;
    }>
  | Readonly<{ kind: "await_scheduler_progress"; assignmentId: string }>
  | Readonly<{
      kind: "perform_scientific_phase_transition";
      transition:
        | "seal_author_artifact_catalog"
        | "prepare_primary_review_work_order"
        | "prepare_next_primary_reviewer_task"
        | "record_primary_review_results"
        | "derive_disagreement_adjudication_work_order"
        | "prepare_next_adjudicator_task"
        | "record_adjudication_results"
        | "lock_blinded_classifications"
        | "prepare_pairwise_visual_work_order"
        | "prepare_next_pairwise_visual_task"
        | "record_pairwise_visual_results"
        | "run_cluster_aware_analysis"
        | "create_and_sign_completion_attestation";
      requiredPriorDigest: string;
      expectedCount: number | null;
      mayReleaseTaskBrief: boolean;
    }>
  | Readonly<{ kind: "experiment_complete" }>;

function expectedIngest(input: Omit<Exp0001aExpectedIngest, "resultMustBeRetainedBeforeNextAction">): Exp0001aExpectedIngest {
  return Object.freeze({ ...input, resultMustBeRetainedBeforeNextAction: true });
}

function activeLifecycle(input: readonly Exp0001aCodexTaskLifecycle[]): Exp0001aCodexTaskLifecycle | null {
  const nonterminal = input.filter((record) => record.state === "creation_uncertain"
    || record.state === "running" || record.state === "awaiting_terminal_read");
  if (nonterminal.length > 1) throw new Error("EXP0001A_COORDINATOR_MULTIPLE_NONTERMINAL_TASKS");
  return nonterminal[0] ?? null;
}

function projectNextReviewPacketStartAction(
  journal: Exp0001aCodexCoordinatorJournal,
  role: "primary_reviewer" | "adjudicator" | "pairwise_visual_judge",
  requiredPriorDigest: string,
): Extract<Exp0001aCodexCoordinatorAction, { kind: "start_artifact_packet_sidecar" }> {
  const state = journal.scientificState;
  if (state === null) throw new Error("EXP0001A_REVIEW_PACKET_REQUIRES_SCIENTIFIC_STATE");
  const next = nextExp0001aScientificReviewWorkItem({ state, plans: journal.plans, lifecycles: journal.lifecycles });
  if (next === null || next.role !== role || next.workItem === null || Array.isArray(next.workItem)
      || typeof next.workItem !== "object") {
    throw new Error(`EXP0001A_${role.toUpperCase()}_NEXT_WORK_ITEM_INVALID`);
  }
  const assignmentId = typeof next.workItem.assignmentId === "string" ? next.workItem.assignmentId : null;
  if (assignmentId === null) throw new Error("EXP0001A_REVIEW_PACKET_ASSIGNMENT_INVALID");
  const planByDigest = new Map(journal.plans.map((plan) => [plan.planDigest, plan]));
  const lifecycleByDigest = new Map(journal.lifecycles.map((lifecycle) => [lifecycle.lifecycleDigest, lifecycle]));
  let workItemDigest: string;
  let subject: JsonValue;
  let evidence: JsonValue;
  if (role === "primary_reviewer") {
    if (state.primaryWorkOrder?.workOrderDigest !== requiredPriorDigest) {
      throw new Error("EXP0001A_PRIMARY_PACKET_WORK_ORDER_DRIFT");
    }
    const item = state.primaryWorkOrder.workItems.find((candidate) => candidate.assignmentId === assignmentId);
    if (!item) throw new Error("EXP0001A_PRIMARY_PACKET_WORK_ITEM_MISSING");
    const authorPlanDigest = item.subject.kind === "primary-review-success-subject"
      ? item.subject.authorPlanDigest : item.subject.authorFailurePacket.authorPlanDigest;
    const authorLifecycleDigest = item.subject.kind === "primary-review-success-subject"
      ? item.subject.authorLifecycleDigest : item.subject.authorFailurePacket.authorLifecycleDigest;
    const authorPlan = planByDigest.get(authorPlanDigest);
    const authorLifecycle = lifecycleByDigest.get(authorLifecycleDigest);
    if (!authorPlan || !authorLifecycle || authorPlan.role !== "author" || authorLifecycle.role !== "author") {
      throw new Error("EXP0001A_PRIMARY_PACKET_AUTHOR_TRANSPORT_MISSING");
    }
    workItemDigest = item.workItemDigest;
    subject = item.subject as unknown as JsonValue;
    evidence = { authorPlan, authorLifecycle } as unknown as JsonValue;
  } else if (role === "adjudicator") {
    if (state.adjudicationWorkOrder?.workOrderDigest !== requiredPriorDigest
        || state.primaryWorkOrder === null || state.primaryResults === null || state.authorCatalog === null) {
      throw new Error("EXP0001A_ADJUDICATION_PACKET_WORK_ORDER_DRIFT");
    }
    const item = state.adjudicationWorkOrder.workItems.find((candidate) => candidate.assignmentId === assignmentId);
    const primarySubject = state.authorCatalog.entries.find((entry) => entry.artifactId === item?.artifactId)?.reviewSubject;
    if (!item || !primarySubject) throw new Error("EXP0001A_ADJUDICATION_PACKET_WORK_ITEM_MISSING");
    const workItemById = new Map(state.primaryWorkOrder.workItems.map((candidate) => [candidate.workItemId, candidate]));
    const results = state.primaryResults.results.filter((result) => result.artifactId === item.artifactId)
      .sort((left, right) => (workItemById.get(left.workItemId)?.reviewerSlot ?? 99)
        - (workItemById.get(right.workItemId)?.reviewerSlot ?? 99));
    if (results.length !== 2) throw new Error("EXP0001A_ADJUDICATION_PACKET_PRIMARY_PAIR_MISSING");
    const primaryReviews = results.map((result, index) => {
      const plan = planByDigest.get(result.planDigest);
      const lifecycle = lifecycleByDigest.get(result.lifecycleDigest);
      if (!plan || !lifecycle || plan.role !== "primary_reviewer" || lifecycle.role !== "primary_reviewer") {
        throw new Error("EXP0001A_ADJUDICATION_PACKET_PRIMARY_TRANSPORT_MISSING");
      }
      return { slot: index === 0 ? "primary-review-1" : "primary-review-2", plan, lifecycle };
    });
    workItemDigest = item.workItemDigest;
    subject = item.subject as unknown as JsonValue;
    evidence = { primarySubject, primaryReviews } as unknown as JsonValue;
  } else {
    if (state.pairwiseWorkOrder?.workOrderDigest !== requiredPriorDigest) {
      throw new Error("EXP0001A_PAIRWISE_PACKET_WORK_ORDER_DRIFT");
    }
    const item = state.pairwiseWorkOrder.workItems.find((candidate) => candidate.assignmentId === assignmentId);
    if (!item) throw new Error("EXP0001A_PAIRWISE_PACKET_WORK_ITEM_MISSING");
    const sides = item.subject.sourceBindings.map((binding) => {
      const authorPlan = planByDigest.get(binding.authorPlanDigest);
      const authorLifecycle = lifecycleByDigest.get(binding.authorLifecycleDigest);
      if (!authorPlan || !authorLifecycle || authorPlan.role !== "author" || authorLifecycle.role !== "author") {
        throw new Error("EXP0001A_PAIRWISE_PACKET_AUTHOR_TRANSPORT_MISSING");
      }
      return { authorPlan, authorLifecycle };
    });
    workItemDigest = item.workItemDigest;
    subject = item.subject as unknown as JsonValue;
    evidence = { sides } as unknown as JsonValue;
  }
  const priorDispatches = journal.artifactPacketLifecycles.filter((packet) => packet.assignmentId === assignmentId).length;
  const packetId = `${String(next.workItem.workItemId)}-d${priorDispatches + 1}`;
  const startInput = {
    schemaVersion: "exp-0001a-artifact-packet-sidecar-start-input/v1",
    role,
    subject,
    evidence,
  } as const;
  return Object.freeze({
    kind: "start_artifact_packet_sidecar",
    packetId,
    startInput: startInput as unknown as JsonValue,
    expectedIngest: expectedIngest({
      operation: "retainArtifactPacketStartResult",
      assignmentId,
      planDigest: null,
      priorStateDigest: journal.journalDigest,
    }),
    coordinatorDidNotInvokeTool: true,
  });
}

/** Emits one exact next action. It never invokes the outer app/WebMCP tool. */
export function planNextExp0001aCodexCoordinatorAction(input: Readonly<{
  issuedAt: string;
  provisioningState: Exp0001aProvisioningCoordinatorState;
  journal: Exp0001aCodexCoordinatorJournal;
}>): Exp0001aCodexCoordinatorAction {
  const issuedAt = timestampSchema.parse(input.issuedAt);
  const provisioningAction = nextExp0001aProvisioningAction(input.provisioningState);
  const journal = exp0001aCodexCoordinatorJournalSchema.parse(input.journal);
  if (journal.provisioningStateDigest !== input.provisioningState.stateDigest) {
    throw new Error("EXP0001A_COORDINATOR_JOURNAL_PROVISIONING_STATE_DRIFT");
  }
  const planByDigest = new Map(journal.plans.map((plan) => [plan.planDigest, plan]));
  const authorFinalEvidenceByPlan = new Map(
    journal.authorFinalEvidenceReceipts.map((receipt) => [receipt.authorPlanDigest, receipt]),
  );
  const ids = journal.lifecycles.flatMap((record) => record.codexTaskId === null ? [] : [record.codexTaskId]);
  if (new Set(ids).size !== ids.length) throw new Error("EXP0001A_COORDINATOR_TASK_ID_REUSED");

  // A subscription pause is global across author and every blinded review
  // role. It precedes reconciliation, polling, pending prompt release, and all
  // scientific phase work. Only a neutral no-brief availability probe may run.
  if (provisioningAction.kind === "paused_for_usage_limit") {
    const pause = input.provisioningState.scheduler.pause;
    if (pause === null) {
      throw new Error("EXP0001A_PAUSED_PROVISIONING_ACTION_WITHOUT_SCHEDULER_PAUSE");
    }
    const probeSuffix = `${pause.usageWindow}-${pause.evidenceDigest.slice(7, 19)}`;
    const createThreadCommandContent = {
      schemaVersion: 1 as const,
      toolName: "mcp__codex_app__create_thread" as const,
      arguments: Object.freeze({
        prompt: EXP0001A_SUBSCRIPTION_PROBE_PROMPT,
        title: `EXP0001A subscription probe ${probeSuffix}`,
        target: Object.freeze({
          type: "projectless" as const,
          directoryName: `exp0001a-subscription-probe-${probeSuffix}`,
        }),
        model: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS.subscription_probe.requestedModel,
        thinking: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS.subscription_probe.requestedReasoningEffort,
      }),
    };
    return Object.freeze({
      kind: "run_subscription_availability_probe",
      prompt: EXP0001A_SUBSCRIPTION_PROBE_PROMPT,
      promptDigest: EXP0001A_SUBSCRIPTION_PROBE_PROMPT_DIGEST,
      accountingRole: "subscription_probe",
      target: Object.freeze({ type: "projectless" }),
      createThreadCommand: Object.freeze({
        ...createThreadCommandContent,
        commandDigest: hashCanonicalJson(createThreadCommandContent as unknown as JsonValue),
      }),
      benchmarkContentIncluded: false,
      mayReleaseExperimentBrief: false,
      authorityReceiptRequiredBeforeResume: true,
      expectedIngest: expectedIngest({
        operation: "retainSubscriptionProbeResult",
        assignmentId: null,
        planDigest: null,
        priorStateDigest: journal.journalDigest,
      }),
      coordinatorDidNotInvokeTool: true,
    });
  }

  const active = activeLifecycle(journal.lifecycles);
  if (active !== null) {
    const plan = planByDigest.get(active.planDigest)!;
    const base = {
      assignmentId: plan.privateBinding.assignmentId,
      planDigest: plan.planDigest,
      priorStateDigest: active.lifecycleDigest,
    };
    if (active.state === "creation_uncertain") {
      return Object.freeze({
        kind: "reconcile_uncertain_create",
        command: issueExp0001aCreateReconciliationCommand({ plan, lifecycle: active, issuedAt }),
        expectedIngest: expectedIngest({ ...base, operation: "recordCreateReconciliationResult" }),
        coordinatorDidNotInvokeTool: true,
        createRetryAllowed: false,
      });
    }
    if (active.state === "running") {
      return Object.freeze({
        kind: "wait_for_active_task",
        command: issueExp0001aWaitThreadsCommand({ lifecycle: active, issuedAt }),
        expectedIngest: expectedIngest({ ...base, operation: "recordWaitThreadsResult" }),
        coordinatorDidNotInvokeTool: true,
      });
    }
    // Only a successfully completed author turn can have an authoritative
    // canvas snapshot. Usage-limit, needs-attention, and failed waits must be
    // read and retained as canonical terminal failures before the global pause
    // is applied; attempting the canvas batch for those outcomes both violates
    // the transport contract and can accidentally mutate/inspect stale work.
    if (plan.role === "author"
        && active.waitReceipts.at(-1)?.outcome === "completed"
        && !authorFinalEvidenceByPlan.has(plan.planDigest)) {
      return Object.freeze({
        kind: "collect_author_final_evidence",
        command: issueExp0001aAuthorFinalEvidenceCommand({ plan, lifecycle: active, issuedAt }),
        expectedIngest: expectedIngest({ ...base, operation: "recordAuthorFinalEvidenceResult" }),
        coordinatorDidNotInvokeTool: true,
      });
    }
    return Object.freeze({
      kind: "read_terminal_task",
      command: issueExp0001aReadThreadCommand({ lifecycle: active, issuedAt }),
      expectedIngest: expectedIngest({ ...base, operation: "recordReadThreadResult" }),
      coordinatorDidNotInvokeTool: true,
    });
  }

  const lifecycleByPlan = new Map(journal.lifecycles.map((record) => [record.planDigest, record]));
  const releaseByPlan = new Map(journal.releaseInvocations.map((receipt) => [receipt.planDigest, receipt]));
  const activePacket = journal.artifactPacketLifecycles.find((packet) => packet.state === "active") ?? null;
  if (activePacket !== null) {
    const packetTask = lifecycleByPlan.get(activePacket.planDigest);
    if (packetTask?.state === "terminal"
        || packetTask?.state === "not_started_usage_limited"
        || packetTask?.state === "not_started_failed") {
      return Object.freeze({
        kind: "stop_artifact_packet_sidecar",
        packetId: activePacket.packetId,
        taskLifecycleState: packetTask.state,
        expectedIngest: expectedIngest({
          operation: "retainArtifactPacketStopResult",
          assignmentId: activePacket.assignmentId,
          planDigest: activePacket.planDigest,
          priorStateDigest: activePacket.lifecycleDigest,
        }),
        coordinatorDidNotInvokeTool: true,
      });
    }
  }
  const pendingPlan = journal.plans.find((plan) => !lifecycleByPlan.has(plan.planDigest));
  if (pendingPlan) {
    if (!releaseByPlan.has(pendingPlan.planDigest)) {
      return Object.freeze({
        kind: "record_create_thread_release_invocation",
        plan: pendingPlan,
        requiresFreshChatGptAuth: true,
        promptMayBeReleasedAfterReceipt: true,
      });
    }
    return Object.freeze({
      kind: "create_codex_task",
      command: pendingPlan.createThreadCommand,
      expectedIngest: expectedIngest({
        operation: "recordCreateThreadResult",
        assignmentId: pendingPlan.privateBinding.assignmentId,
        planDigest: pendingPlan.planDigest,
        priorStateDigest: journal.journalDigest,
      }),
      coordinatorDidNotInvokeTool: true,
    });
  }

  if (provisioningAction.kind === "complete") {
    const progress = journal.reviewProgress;
    const rolePlans = (role: Exp0001aCodexTaskTransportPlan["role"]) => journal.plans.filter((plan) => plan.role === role);
    const begunRolePlans = (role: Exp0001aCodexTaskTransportPlan["role"]) => rolePlans(role)
      .filter((plan) => lifecycleByPlan.get(plan.planDigest)?.taskBegun === true);
    const terminalRole = (role: Exp0001aCodexTaskTransportPlan["role"]) => {
      const digests = new Set(begunRolePlans(role).map((plan) => plan.planDigest));
      return journal.lifecycles.filter((record) => digests.has(record.planDigest)
        && record.taskBegun && record.state === "terminal");
    };
    if (begunRolePlans("author").length !== 48 || terminalRole("author").length !== 48) {
      throw new Error("EXP0001A_REVIEW_PHASE_REQUIRES_48_TERMINAL_AUTHORS");
    }
    if (progress.authorArtifactCatalogDigest === null) {
      return Object.freeze({ kind: "perform_scientific_phase_transition", transition: "seal_author_artifact_catalog",
        requiredPriorDigest: journal.journalDigest, expectedCount: 48, mayReleaseTaskBrief: false });
    }
    if (progress.primaryWorkOrderDigest === null) {
      return Object.freeze({ kind: "perform_scientific_phase_transition", transition: "prepare_primary_review_work_order",
        requiredPriorDigest: progress.authorArtifactCatalogDigest, expectedCount: 96, mayReleaseTaskBrief: false });
    }
    if (begunRolePlans("primary_reviewer").length < 96) {
      return projectNextReviewPacketStartAction(journal, "primary_reviewer", progress.primaryWorkOrderDigest);
    }
    if (terminalRole("primary_reviewer").length !== 96) {
      throw new Error("EXP0001A_PRIMARY_REVIEW_WORK_ORDER_NOT_TERMINAL");
    }
    if (progress.primaryResultLedgerDigest === null) {
      return Object.freeze({ kind: "perform_scientific_phase_transition", transition: "record_primary_review_results",
        requiredPriorDigest: progress.primaryWorkOrderDigest, expectedCount: 96, mayReleaseTaskBrief: false });
    }
    if (progress.adjudicationWorkOrderDigest === null) {
      return Object.freeze({ kind: "perform_scientific_phase_transition", transition: "derive_disagreement_adjudication_work_order",
        requiredPriorDigest: progress.primaryResultLedgerDigest, expectedCount: null, mayReleaseTaskBrief: false });
    }
    const disagreementCount = progress.disagreementArtifactIds.length;
    if (begunRolePlans("adjudicator").length < disagreementCount) {
      return projectNextReviewPacketStartAction(journal, "adjudicator", progress.adjudicationWorkOrderDigest);
    }
    if (terminalRole("adjudicator").length !== disagreementCount) {
      throw new Error("EXP0001A_ADJUDICATION_WORK_ORDER_NOT_TERMINAL");
    }
    if (progress.adjudicationResultLedgerDigest === null) {
      return Object.freeze({ kind: "perform_scientific_phase_transition", transition: "record_adjudication_results",
        requiredPriorDigest: progress.adjudicationWorkOrderDigest, expectedCount: disagreementCount, mayReleaseTaskBrief: false });
    }
    if (progress.classificationLockDigest === null) {
      return Object.freeze({ kind: "perform_scientific_phase_transition", transition: "lock_blinded_classifications",
        requiredPriorDigest: progress.adjudicationResultLedgerDigest, expectedCount: 48, mayReleaseTaskBrief: false });
    }
    if (progress.pairwiseWorkOrderDigest === null) {
      return Object.freeze({ kind: "perform_scientific_phase_transition", transition: "prepare_pairwise_visual_work_order",
        requiredPriorDigest: progress.classificationLockDigest, expectedCount: 24, mayReleaseTaskBrief: false });
    }
    if (begunRolePlans("pairwise_visual_judge").length < 24) {
      return projectNextReviewPacketStartAction(journal, "pairwise_visual_judge", progress.pairwiseWorkOrderDigest);
    }
    if (terminalRole("pairwise_visual_judge").length !== 24) {
      throw new Error("EXP0001A_PAIRWISE_WORK_ORDER_NOT_TERMINAL");
    }
    if (progress.pairwiseResultLedgerDigest === null) {
      return Object.freeze({ kind: "perform_scientific_phase_transition", transition: "record_pairwise_visual_results",
        requiredPriorDigest: progress.pairwiseWorkOrderDigest, expectedCount: 24, mayReleaseTaskBrief: false });
    }
    if (progress.analysisReportDigest === null) {
      return Object.freeze({ kind: "perform_scientific_phase_transition", transition: "run_cluster_aware_analysis",
        requiredPriorDigest: progress.pairwiseResultLedgerDigest, expectedCount: 48, mayReleaseTaskBrief: false });
    }
    if (progress.signedCompletionAttestationDigest === null) {
      return Object.freeze({ kind: "perform_scientific_phase_transition", transition: "create_and_sign_completion_attestation",
        requiredPriorDigest: progress.analysisReportDigest, expectedCount: null, mayReleaseTaskBrief: false });
    }
    return Object.freeze({ kind: "experiment_complete" });
  }
  if (provisioningAction.kind === "release_reserved_create_room") {
    return Object.freeze({
      kind: "release_reserved_create_room",
      assignmentId: provisioningAction.assignmentId,
      reservationId: provisioningAction.reservationId,
      nextExternalAction: "perform_provisioning_webmcp",
      durableReleaseRequiredBeforeEmission: true,
    });
  }
  const projected = projectNextExp0001aProvisioningAction(input.provisioningState);
  if (projected.kind === "external_webmcp_command") {
    const base = {
      assignmentId: projected.assignmentId,
      planDigest: null,
      priorStateDigest: input.provisioningState.stateDigest,
    };
    return Object.freeze({
      kind: "perform_provisioning_webmcp",
      command: projected.command,
      session: projected.session,
      expectedIngest: expectedIngest({ ...base, operation: projected.retainMethod }),
      ambiguityReconciliation: projected.ambiguityReconciliation === null ? null : Object.freeze({
        command: projected.ambiguityReconciliation.command,
        expectedIngest: expectedIngest({
          ...base,
          operation: projected.ambiguityReconciliation.retainMethod,
        }),
        createRetryAllowed: false as const,
      }),
      coordinatorDidNotInvokeTool: true,
    });
  }
  if (provisioningAction.kind === "release_author_handoff") {
    return Object.freeze({
      kind: "prepare_author_task",
      assignmentId: provisioningAction.assignmentId,
      requiresFreshChatGptAuth: true,
      requiresCanonicalProvisioningHandoff: true,
    });
  }
  if (provisioningAction.kind === "await_scheduler_progress") {
    return Object.freeze({ kind: "await_scheduler_progress", assignmentId: provisioningAction.assignmentId });
  }
  return Object.freeze({
    kind: "perform_provisioning_local_transition",
    transition: provisioningAction.kind as ProvisioningLocalTransition,
    assignmentId: "assignmentId" in provisioningAction ? provisioningAction.assignmentId : "unassigned",
  });
}

export function assertExp0001aCoordinatorSchedulerBinding(
  state: Exp0001aProvisioningCoordinatorState,
): void {
  exp0001aCodexSchedulerStateSchema.parse(state.scheduler);
  nextExp0001aProvisioningAction(state);
}

export type Exp0001aCoordinatorIngestResult = Readonly<{
  provisioningState: Exp0001aProvisioningCoordinatorState;
  coordinatorJournal: Exp0001aCodexCoordinatorJournal;
  retainedEvidenceDigest: string;
}>;

function advanceCoordinatorJournal(input: Readonly<{
  prior: Exp0001aCodexCoordinatorJournal;
  provisioningState: Exp0001aProvisioningCoordinatorState;
  plans?: readonly Exp0001aCodexTaskTransportPlan[];
  releaseInvocations?: readonly Exp0001aCodexReleaseInvocationReceipt[];
  lifecycles?: readonly Exp0001aCodexTaskLifecycle[];
  accountingFinalizationReceipts?: readonly Exp0001aCodexAccountingFinalizationReceipt[];
  subscriptionProbeAccountingRecords?: readonly Exp0001aCodexTaskAccounting[];
  subscriptionProbeAttemptDigests?: readonly string[];
  authorFinalEvidenceReceipts?: readonly Exp0001aAuthorFinalRoomReadReceipt[];
  artifactPacketLifecycles?: readonly Exp0001aCoordinatorArtifactPacketLifecycle[];
  scientificState?: Exp0001aCodexScientificState | null;
  reviewProgress?: z.input<typeof journalContentSchema>["reviewProgress"];
}>): Exp0001aCodexCoordinatorJournal {
  return createExp0001aCodexCoordinatorJournal({
    provisioningState: input.provisioningState,
    plans: input.plans ?? input.prior.plans,
    releaseInvocations: input.releaseInvocations ?? input.prior.releaseInvocations,
    lifecycles: input.lifecycles ?? input.prior.lifecycles,
    accountingFinalizationReceipts: input.accountingFinalizationReceipts
      ?? input.prior.accountingFinalizationReceipts,
    subscriptionProbeAccountingRecords: input.subscriptionProbeAccountingRecords
      ?? input.prior.subscriptionProbeAccountingRecords,
    subscriptionProbeAttemptDigests: input.subscriptionProbeAttemptDigests
      ?? input.prior.subscriptionProbeAttemptDigests,
    authorFinalEvidenceReceipts: input.authorFinalEvidenceReceipts ?? input.prior.authorFinalEvidenceReceipts,
    artifactPacketLifecycles: input.artifactPacketLifecycles ?? input.prior.artifactPacketLifecycles,
    scientificState: input.scientificState === undefined ? input.prior.scientificState : input.scientificState,
    reviewProgress: input.reviewProgress ?? input.prior.reviewProgress,
    priorJournalDigest: input.prior.journalDigest,
  });
}

/**
 * Exact external-result ingest boundary for one emitted coordinator action.
 * It validates the prior digest and expected operation, invokes only the
 * predeclared recorder, and returns the next hash-chained journal. It never
 * fabricates or normalizes Codex-app/WebMCP output.
 */
export async function ingestExp0001aCoordinatorActionResult(input: Readonly<{
  action: Exp0001aCodexCoordinatorAction;
  rawResult: unknown;
  observedAt: string;
  provisioningState: Exp0001aProvisioningCoordinatorState;
  coordinatorJournal: Exp0001aCodexCoordinatorJournal;
  provisioningCoordinator?: Exp0001aProvisioningCoordinator;
  spikeGate?: unknown;
  spikeEvidence?: unknown;
}>): Promise<Exp0001aCoordinatorIngestResult> {
  const observedAt = timestampSchema.parse(input.observedAt);
  const journal = exp0001aCodexCoordinatorJournalSchema.parse(input.coordinatorJournal);
  const action = input.action;
  if (!("expectedIngest" in action)) {
    throw new Error("EXP0001A_COORDINATOR_ACTION_HAS_NO_EXTERNAL_RESULT_INGEST");
  }
  const expected = action.expectedIngest;
  const plan = expected.planDigest === null
    ? null
    : journal.plans.find((candidate) => candidate.planDigest === expected.planDigest) ?? null;
  const lifecycleIndex = expected.planDigest === null
    ? -1
    : journal.lifecycles.findIndex((candidate) => candidate.planDigest === expected.planDigest);
  const lifecycle = lifecycleIndex < 0 ? null : journal.lifecycles[lifecycleIndex]!;
  const replaceLifecycle = (next: Exp0001aCodexTaskLifecycle): Exp0001aCodexTaskLifecycle[] => {
    if (lifecycleIndex < 0) return [...journal.lifecycles, next];
    return journal.lifecycles.map((candidate, index) => index === lifecycleIndex ? next : candidate);
  };
  let provisioningState = input.provisioningState;
  let nextJournal: Exp0001aCodexCoordinatorJournal;
  let retainedEvidence: unknown;

  if (action.kind === "perform_provisioning_webmcp") {
    const rawTool = input.rawResult !== null && !Array.isArray(input.rawResult)
        && typeof input.rawResult === "object" && typeof (input.rawResult as Record<string, unknown>).tool === "string"
      ? (input.rawResult as Record<string, unknown>).tool as string
      : null;
    const useAmbiguityReconciliation = action.ambiguityReconciliation !== null
      && rawTool === action.ambiguityReconciliation.command.toolName;
    const selectedExpected = useAmbiguityReconciliation
      ? action.ambiguityReconciliation!.expectedIngest
      : expected;
    if (rawTool !== action.command.toolName && !useAmbiguityReconciliation) {
      throw new Error("EXP0001A_PROVISIONING_INGEST_TOOL_NOT_COMMITTED_BY_ACTION");
    }
    if (selectedExpected.priorStateDigest !== input.provisioningState.stateDigest
        || selectedExpected.planDigest !== null
        || selectedExpected.assignmentId === null || input.provisioningCoordinator === undefined) {
      throw new Error("EXP0001A_PROVISIONING_INGEST_PRIOR_STATE_OR_COORDINATOR_INVALID");
    }
    const coordinator = input.provisioningCoordinator;
    const operation = selectedExpected.operation;
    if (operation === "retainCreateRoomResult") {
      provisioningState = await coordinator.retainCreateRoomResult(selectedExpected.assignmentId, input.rawResult);
    } else if (operation === "reconcileAmbiguousCreate") {
      provisioningState = await coordinator.reconcileAmbiguousCreate(selectedExpected.assignmentId, input.rawResult);
    } else if (operation === "retainBlankBaselineRead") {
      provisioningState = await coordinator.retainBlankBaselineRead(selectedExpected.assignmentId, input.rawResult);
    } else if (operation === "retainSeedResult") {
      provisioningState = await coordinator.retainSeedResult(selectedExpected.assignmentId, input.rawResult);
    } else if (operation === "retainPreAuthorRead") {
      provisioningState = await coordinator.retainPreAuthorRead(selectedExpected.assignmentId, input.rawResult);
    } else if (operation === "retainInviteJoinResult") {
      provisioningState = await coordinator.retainInviteJoinResult(selectedExpected.assignmentId, input.rawResult);
    } else if (operation === "retainInviteRead") {
      provisioningState = await coordinator.retainInviteRead(selectedExpected.assignmentId, input.rawResult);
    } else if (operation === "retainCoordinatorPresenceRead") {
      provisioningState = await coordinator.retainCoordinatorPresenceRead(selectedExpected.assignmentId, input.rawResult);
    } else {
      throw new Error(`EXP0001A_PROVISIONING_INGEST_OPERATION_INVALID:${operation}`);
    }
    nextJournal = advanceCoordinatorJournal({ prior: journal, provisioningState });
    retainedEvidence = provisioningState;
  } else if (action.kind === "start_artifact_packet_sidecar"
      && expected.operation === "retainArtifactPacketStartResult") {
    if (expected.priorStateDigest !== journal.journalDigest || expected.planDigest !== null
        || expected.assignmentId === null || input.spikeGate === undefined || input.spikeEvidence === undefined) {
      throw new Error("EXP0001A_PACKET_START_INGEST_PRIOR_STATE_OR_AUTHORITY_INVALID");
    }
    const retained = artifactPacketSidecarStartResultSchema.parse(input.rawResult);
    const startInput = action.startInput;
    if (startInput === null || Array.isArray(startInput) || typeof startInput !== "object"
        || retained.packetId !== action.packetId || retained.role !== startInput.role
        || retained.subjectDigest !== (startInput.subject as Record<string, JsonValue> | undefined)?.subjectDigest
        || retained.envelope.role !== retained.role
        || retained.startReceipt.role !== retained.role
        || retained.startReceipt.subjectDigest !== retained.subjectDigest
        || retained.startReceipt.reviewerEnvelopeDigest !== hashCanonicalJson(retained.envelope as unknown as JsonValue)
        || retained.readyReceipt.envelopeDigest !== hashCanonicalJson(retained.envelope as unknown as JsonValue)) {
      throw new Error("EXP0001A_PACKET_START_RESULT_BINDING_INVALID");
    }
    const scientific = journal.scientificState;
    if (scientific === null) throw new Error("EXP0001A_PACKET_START_REQUIRES_SCIENTIFIC_STATE");
    const next = nextExp0001aScientificReviewWorkItem({ state: scientific, plans: journal.plans, lifecycles: journal.lifecycles });
    if (next === null || next.role !== retained.role || next.workItem === null || Array.isArray(next.workItem)
        || typeof next.workItem !== "object" || next.workItem.assignmentId !== expected.assignmentId) {
      throw new Error("EXP0001A_PACKET_START_NO_LONGER_MATCHES_NEXT_WORK_ITEM");
    }
    const packet = retained.envelope.artifactPacket;
    let expectedEnvelope;
    let subjectArtifactIds: readonly string[];
    if (retained.role === "primary_reviewer") {
      const item = scientific.primaryWorkOrder?.workItems.find((candidate) => candidate.assignmentId === expected.assignmentId);
      if (!item) throw new Error("EXP0001A_PACKET_START_PRIMARY_WORK_ITEM_MISSING");
      expectedEnvelope = createExp0001aPrimaryReviewerTaskEnvelopeFromSubject({
        subject: item.subject,
        artifactPacketOrigin: packet.origin,
      });
      subjectArtifactIds = [item.artifactId];
    } else if (retained.role === "adjudicator") {
      const item = scientific.adjudicationWorkOrder?.workItems.find((candidate) => candidate.assignmentId === expected.assignmentId);
      if (!item) throw new Error("EXP0001A_PACKET_START_ADJUDICATION_WORK_ITEM_MISSING");
      expectedEnvelope = createExp0001aAdjudicatorTaskEnvelopeFromSubject({
        subject: item.subject,
        artifactPacketOrigin: packet.origin,
      });
      subjectArtifactIds = [item.artifactId];
    } else {
      const item = scientific.pairwiseWorkOrder?.workItems.find((candidate) => candidate.assignmentId === expected.assignmentId);
      if (!item) throw new Error("EXP0001A_PACKET_START_PAIRWISE_WORK_ITEM_MISSING");
      expectedEnvelope = createExp0001aPairwiseVisualJudgeTaskEnvelopeFromSubject({
        subject: item.subject,
        artifactPacketOrigin: packet.origin,
      });
      subjectArtifactIds = [item.canvas1ArtifactId, item.canvas2ArtifactId];
    }
    if (hashCanonicalJson(expectedEnvelope as unknown as JsonValue)
        !== hashCanonicalJson(retained.envelope as unknown as JsonValue)) {
      throw new Error("EXP0001A_PACKET_START_ENVELOPE_DIFFERS_FROM_FROZEN_WORK_ITEM");
    }
    const planReadyReceipt = await probeExp0001aCodexArtifactPacket({ envelope: expectedEnvelope });
    const dispatchOrdinal = journal.plans.filter((candidate) =>
      candidate.privateBinding.assignmentId === expected.assignmentId).length + 1;
    const workItemDigest = String(next.workItem.workItemDigest);
    const plan = await prepareExp0001aCodexTaskTransportWithFreshAuth({
      transportId: `review-${retained.role}-${workItemDigest.slice("sha256:".length, "sha256:".length + 20)}-d${dispatchOrdinal}`,
      preparedAt: new Date().toISOString(),
      assignmentId: expected.assignmentId,
      attemptId: String(next.workItem.attemptId),
      subjectArtifactIds,
      envelope: expectedEnvelope,
      artifactPacketReadyReceipt: planReadyReceipt,
      spikeGate: input.spikeGate,
      spikeEvidence: input.spikeEvidence,
    });
    const packetLifecycle = sealArtifactPacketLifecycle({
      schemaVersion: "exp-0001a-coordinator-artifact-packet-lifecycle/v1",
      packetId: retained.packetId,
      assignmentId: expected.assignmentId,
      workItemDigest,
      role: retained.role,
      subjectDigest: retained.subjectDigest,
      envelopeDigest: plan.envelopeDigest,
      startReceipt: retained.startReceipt,
      sidecarReadyReceipt: retained.readyReceipt,
      planReadyReceipt,
      planDigest: plan.planDigest,
      stopReceipt: null,
      recoveryReceipt: null,
      terminalTaskLifecycleDigest: null,
      state: "active",
    });
    nextJournal = advanceCoordinatorJournal({
      prior: journal,
      provisioningState,
      plans: [...journal.plans, plan],
      artifactPacketLifecycles: [...journal.artifactPacketLifecycles, packetLifecycle],
    });
    retainedEvidence = packetLifecycle;
  } else if (action.kind === "stop_artifact_packet_sidecar"
      && expected.operation === "retainArtifactPacketStopResult") {
    const packetIndex = journal.artifactPacketLifecycles.findIndex((packet) => packet.packetId === action.packetId);
    const packetLifecycle = packetIndex < 0 ? null : journal.artifactPacketLifecycles[packetIndex]!;
    if (packetLifecycle === null || packetLifecycle.state !== "active"
        || expected.priorStateDigest !== packetLifecycle.lifecycleDigest
        || expected.planDigest !== packetLifecycle.planDigest
        || expected.assignmentId !== packetLifecycle.assignmentId) {
      throw new Error("EXP0001A_PACKET_STOP_INGEST_PRIOR_STATE_INVALID");
    }
    const terminalTaskLifecycle = journal.lifecycles.find((candidate) =>
      candidate.planDigest === packetLifecycle.planDigest) ?? null;
    if (terminalTaskLifecycle === null) {
      throw new Error("EXP0001A_PACKET_STOP_REQUIRES_EXACT_TERMINAL_TASK_LIFECYCLE");
    }
    if (terminalTaskLifecycle.state !== action.taskLifecycleState) {
      throw new Error("EXP0001A_PACKET_STOP_ACTION_TASK_LIFECYCLE_STATE_DRIFT");
    }
    const terminalEvidence = projectExp0001aArtifactPacketTerminalEvidence({
      packetLifecycle,
      terminalTaskLifecycle,
      rawResult: input.rawResult,
    });
    const { lifecycleDigest: _priorPacketDigest, ...packetContent } = packetLifecycle;
    void _priorPacketDigest;
    const stopped = sealArtifactPacketLifecycle({
      ...packetContent,
      ...terminalEvidence,
    });
    nextJournal = advanceCoordinatorJournal({
      prior: journal,
      provisioningState,
      artifactPacketLifecycles: journal.artifactPacketLifecycles.map((packet, index) =>
        index === packetIndex ? stopped : packet),
    });
    retainedEvidence = stopped;
  } else {
    if (expected.priorStateDigest !== (lifecycle?.lifecycleDigest ?? journal.journalDigest)
        || plan === null || expected.assignmentId !== plan.privateBinding.assignmentId) {
      throw new Error("EXP0001A_TASK_INGEST_PRIOR_STATE_OR_PLAN_INVALID");
    }
    let nextLifecycle: Exp0001aCodexTaskLifecycle;
    if (action.kind === "create_codex_task" && expected.operation === "recordCreateThreadResult") {
      const release = journal.releaseInvocations.find((receipt) => receipt.planDigest === plan.planDigest);
      if (!release) throw new Error("EXP0001A_CREATE_RESULT_REQUIRES_RETAINED_RELEASE_INVOCATION");
      nextLifecycle = recordExp0001aCreateThreadResult({
        plan,
        releaseInvocationReceipt: release,
        observedAt,
        rawResult: input.rawResult,
        priorCodexTaskIds: new Set(journal.lifecycles.flatMap((record) => record.codexTaskId ? [record.codexTaskId] : [])),
      });
    } else if (action.kind === "reconcile_uncertain_create"
        && expected.operation === "recordCreateReconciliationResult" && lifecycle !== null) {
      nextLifecycle = recordExp0001aCreateReconciliationResult({
        plan, lifecycle, command: action.command, observedAt, rawResult: input.rawResult,
        priorCodexTaskIds: new Set(journal.lifecycles.flatMap((record) => record.codexTaskId ? [record.codexTaskId] : [])),
      });
    } else if (action.kind === "wait_for_active_task"
        && expected.operation === "recordWaitThreadsResult" && lifecycle !== null) {
      nextLifecycle = recordExp0001aWaitThreadsResult({
        lifecycle, command: action.command, observedAt, rawResult: input.rawResult,
      });
    } else if (action.kind === "collect_author_final_evidence"
        && expected.operation === "recordAuthorFinalEvidenceResult" && lifecycle !== null) {
      const receipt = recordExp0001aAuthorFinalEvidenceResult({
        plan, lifecycle, command: action.command, observedAt,
        rawResult: input.rawResult as Parameters<typeof recordExp0001aAuthorFinalEvidenceResult>[0]["rawResult"],
      });
      nextJournal = advanceCoordinatorJournal({
        prior: journal,
        provisioningState,
        authorFinalEvidenceReceipts: [...journal.authorFinalEvidenceReceipts, receipt],
      });
      retainedEvidence = receipt;
      return Object.freeze({ provisioningState, coordinatorJournal: nextJournal,
        retainedEvidenceDigest: hashCanonicalJson(retainedEvidence as unknown as JsonValue) });
    } else if (action.kind === "read_terminal_task"
        && expected.operation === "recordReadThreadResult" && lifecycle !== null) {
      const finalEvidence = journal.authorFinalEvidenceReceipts.find((receipt) => receipt.authorPlanDigest === plan.planDigest) ?? null;
      nextLifecycle = recordExp0001aReadThreadResult({
        plan, lifecycle, command: action.command, observedAt, rawResult: input.rawResult,
        finalAuthoritativeEvidenceReceipt: finalEvidence,
      });
    } else {
      throw new Error(`EXP0001A_COORDINATOR_INGEST_OPERATION_MISMATCH:${expected.operation}`);
    }
    if (plan.role === "author") {
      let scheduler = provisioningState.scheduler;
      if (nextLifecycle.state === "running" && nextLifecycle.codexTaskId !== null
          && nextLifecycle.threadId !== null) {
        const activeAssignment = scheduler.assignments.find((assignment) =>
          assignment.state === "begun" || assignment.state === "completed");
        if (activeAssignment === undefined) {
          const retainedReleaseInterruption = [...scheduler.usageLimitInterruptions].reverse().find((interruption) =>
            interruption.affectedTask?.role === "author"
              && interruption.affectedTask.planDigest === plan.planDigest
              && interruption.affectedTask.transportId === plan.transportId
              && interruption.affectedTask.taskBegun);
          scheduler = beginNextExp0001aCodexAssignment(scheduler, {
            assignmentId: plan.privateBinding.assignmentId,
            begunAt: nextLifecycle.releaseInvocationReceipt.invokedAt,
            codexTaskId: nextLifecycle.codexTaskId,
            threadId: nextLifecycle.threadId,
            usageWindow: retainedReleaseInterruption?.usageWindow,
          });
        } else if (activeAssignment.assignmentId !== plan.privateBinding.assignmentId
            || activeAssignment.codexTaskId !== nextLifecycle.codexTaskId
            || activeAssignment.threadId !== nextLifecycle.threadId) {
          throw new Error("EXP0001A_AUTHOR_LIFECYCLE_SCHEDULER_ACTIVE_TASK_DRIFT");
        }
      } else if (nextLifecycle.state === "terminal"
          && nextLifecycle.terminalOutcome !== "usage_limit_interrupted") {
        const activeAssignment = scheduler.assignments.find((assignment) =>
          assignment.state === "begun" || assignment.state === "completed");
        if (!activeAssignment || activeAssignment.assignmentId !== plan.privateBinding.assignmentId
            || activeAssignment.codexTaskId !== nextLifecycle.codexTaskId
            || activeAssignment.threadId !== nextLifecycle.threadId) {
          throw new Error("EXP0001A_AUTHOR_TERMINAL_SCHEDULER_BINDING_INVALID");
        }
        if (nextLifecycle.terminalOutcome === "succeeded") {
          const completedAt = nextLifecycle.waitReceipts.at(-1)?.terminalCompletedAt;
          if (completedAt === null || completedAt === undefined) {
            throw new Error("EXP0001A_AUTHOR_SUCCESS_SCHEDULER_COMPLETION_TIME_MISSING");
          }
          scheduler = completeActiveExp0001aCodexAssignment(scheduler, completedAt);
        }
        scheduler = terminalizeActiveExp0001aCodexAssignment(scheduler, {
          terminalAt: nextLifecycle.readReceipt?.observedAt ?? observedAt,
          outcome: nextLifecycle.terminalOutcome === "succeeded"
            ? "succeeded"
            : nextLifecycle.terminalOutcome === "policy_violation"
              ? "policy_violation"
              : nextLifecycle.terminalOutcome === "infra_failure"
                ? "infra_failure"
                : "failed",
        });
      }
      if (hashCanonicalJson(scheduler as unknown as JsonValue)
          !== hashCanonicalJson(provisioningState.scheduler as unknown as JsonValue)) {
        if (input.provisioningCoordinator === undefined) {
          throw new Error("EXP0001A_AUTHOR_SCHEDULER_PROGRESS_REQUIRES_DURABLE_COORDINATOR");
        }
        provisioningState = await input.provisioningCoordinator.synchronizeScheduler(scheduler);
      }
    }
    const createUsageLimit = action.kind === "create_codex_task"
      && (nextLifecycle.createReceipt.failureCode === "codex_usage_limit"
        || nextLifecycle.createReceipt.failureCode === "codex_usage_limit_creation_ambiguous");
    if (nextLifecycle.terminalOutcome === "usage_limit_interrupted" || createUsageLimit) {
      if (input.provisioningCoordinator === undefined) {
        throw new Error("EXP0001A_GLOBAL_USAGE_LIMIT_REQUIRES_DURABLE_SCHEDULER_COORDINATOR");
      }
      const pausedScheduler = pauseExp0001aCodexSchedulerForUsageLimit(provisioningState.scheduler, {
        observedAt,
        evidenceDigest: nextLifecycle.lifecycleDigest,
        affectedTask: {
          role: plan.role,
          assignmentId: plan.privateBinding.assignmentId,
          attemptId: plan.privateBinding.attemptId,
          planDigest: plan.planDigest,
          transportId: plan.transportId,
          taskBegun: nextLifecycle.taskBegun,
        },
      });
      provisioningState = await input.provisioningCoordinator.synchronizeScheduler(pausedScheduler);
    }
    const accountingFinalizationReceipts = nextLifecycle.state === "terminal" && nextLifecycle.taskBegun
      ? [...journal.accountingFinalizationReceipts, finalizeExp0001aCodexTaskAccounting({
        accountingId: `accounting-${plan.planDigest.slice("sha256:".length)}`,
        plan,
        lifecycle: nextLifecycle,
      })]
      : journal.accountingFinalizationReceipts;
    nextJournal = advanceCoordinatorJournal({
      prior: journal,
      provisioningState,
      lifecycles: replaceLifecycle(nextLifecycle),
      accountingFinalizationReceipts,
    });
    retainedEvidence = nextLifecycle;
  }
  return Object.freeze({
    provisioningState,
    coordinatorJournal: nextJournal,
    retainedEvidenceDigest: hashCanonicalJson(retainedEvidence as unknown as JsonValue),
  });
}

/**
 * Reconstructs the active accounting ledger exclusively from finalization
 * receipts that were produced atomically with terminal lifecycle ingestion.
 */
export function deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal(
  journalInput: Exp0001aCodexCoordinatorJournal,
): Exp0001aCodexAccountingLedger {
  const journal = exp0001aCodexCoordinatorJournalSchema.parse(journalInput);
  return Object.freeze(exp0001aCodexAccountingLedgerSchema.parse({
    schemaVersion: "exp-0001a-codex-accounting-ledger/v1",
    protocolId: "EXP-0001A",
    frozenRoleSettings: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
    tasks: [
      ...journal.accountingFinalizationReceipts.map((receipt) => receipt.accountingRecord),
      ...journal.subscriptionProbeAccountingRecords,
    ],
  }));
}

/** Retains a neutral probe's raw-derived terminal accounting in the same
 * journal transition that binds the scheduler/provisioning update. */
export function retainExp0001aSubscriptionProbeResultInCoordinatorJournal(input: Readonly<{
  priorJournal: Exp0001aCodexCoordinatorJournal;
  provisioningState: Exp0001aProvisioningCoordinatorState;
  probeEvidenceDigest: string;
  probeAccounting: Exp0001aCodexTaskAccounting | null;
}>): Exp0001aCodexCoordinatorJournal {
  const prior = exp0001aCodexCoordinatorJournalSchema.parse(input.priorJournal);
  const probeEvidenceDigest = digestSchema.parse(input.probeEvidenceDigest);
  if (prior.subscriptionProbeAttemptDigests.includes(probeEvidenceDigest)) {
    throw new Error("EXP0001A_SUBSCRIPTION_PROBE_ATTEMPT_REUSED");
  }
  const probe = input.probeAccounting === null ? null : exp0001aCodexTaskAccountingSchema.parse(input.probeAccounting);
  if (probe !== null && (probe.role !== "subscription_probe" || probe.state !== "terminal"
      || prior.subscriptionProbeAccountingRecords.some((record) => record.accountingId === probe.accountingId
        || record.codexTaskId === probe.codexTaskId || record.threadId === probe.threadId))) {
    throw new Error("EXP0001A_SUBSCRIPTION_PROBE_ACCOUNTING_INVALID_OR_REUSED");
  }
  return advanceCoordinatorJournal({
    prior,
    provisioningState: input.provisioningState,
    subscriptionProbeAccountingRecords: probe === null
      ? prior.subscriptionProbeAccountingRecords : [...prior.subscriptionProbeAccountingRecords, probe],
    subscriptionProbeAttemptDigests: [...prior.subscriptionProbeAttemptDigests, probeEvidenceDigest],
  });
}

/**
 * Executes one symbolic scientific action into exact retained artifacts and a
 * new hash-chained coordinator journal. This closes the former label-only
 * transition gap: roots are projections of reconstructed bytes, never caller
 * inputs.
 */
export function performExp0001aCoordinatorScientificTransition(input: Readonly<{
  transition: Exp0001aScientificTransition;
  transitionedAt: string;
  freeze: Exp0001aCodexPrebriefFreeze;
  executionManifest: DevelopmentExecutionManifest;
  provisioningPlan: Exp0001aAttemptProvisioningPlanSet;
  reviewPlanManifest: Exp0001aCodexReviewPlanManifest;
  provisioningState: Exp0001aProvisioningCoordinatorState;
  coordinatorJournal: Exp0001aCodexCoordinatorJournal;
}>): Exp0001aCodexCoordinatorJournal {
  const journal = exp0001aCodexCoordinatorJournalSchema.parse(input.coordinatorJournal);
  if (journal.provisioningStateDigest !== input.provisioningState.stateDigest) {
    throw new Error("EXP0001A_SCIENTIFIC_JOURNAL_PROVISIONING_DRIFT");
  }
  const priorScientific = journal.scientificState ?? createExp0001aCodexScientificState({
    executionManifest: input.executionManifest,
    reviewPlanManifest: input.reviewPlanManifest,
  });
  const scientificState = performExp0001aCodexScientificTransition({
    transition: input.transition,
    transitionedAt: input.transitionedAt,
    freeze: input.freeze,
    provisioningPlan: input.provisioningPlan,
    scheduler: input.provisioningState.scheduler,
    accountingLedger: deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal(journal),
    plans: journal.plans,
    lifecycles: journal.lifecycles,
    priorState: priorScientific,
  });
  const progress = {
    ...journal.reviewProgress,
    authorArtifactCatalogDigest: scientificState.authorCatalog?.catalogDigest ?? null,
    primaryWorkOrderDigest: scientificState.primaryWorkOrder?.workOrderDigest ?? null,
    primaryResultLedgerDigest: scientificState.primaryResults?.resultLedgerDigest ?? null,
    disagreementArtifactIds: scientificState.adjudicationWorkOrder?.disagreementArtifactIds ?? [],
    adjudicationWorkOrderDigest: scientificState.adjudicationWorkOrder?.workOrderDigest ?? null,
    adjudicationResultLedgerDigest: scientificState.adjudicationResults?.resultLedgerDigest ?? null,
    classificationLockDigest: scientificState.classifications?.classificationBookDigest ?? null,
    pairwiseWorkOrderDigest: scientificState.pairwiseWorkOrder?.workOrderDigest ?? null,
    pairwiseResultLedgerDigest: scientificState.pairwiseResults?.resultLedgerDigest ?? null,
    analysisReportDigest: scientificState.analysisReceipt?.analysisReportDigest ?? null,
  };
  return advanceCoordinatorJournal({
    prior: journal,
    provisioningState: input.provisioningState,
    scientificState,
    reviewProgress: progress,
  });
}

/**
 * Retains the fixed-authority completion only after the active completion
 * verifier independently reconstructs every scientific artifact from the
 * exact scheduler, transport, accounting, and final nine-transition state.
 * The coordinator stores only the digest of those already-verified signed
 * bytes; the full attestation remains in the append-only authority journal.
 */
export function retainExp0001aCoordinatorCompletionAttestation(input: Readonly<{
  verifiedAt: string;
  provisioningState: Exp0001aProvisioningCoordinatorState;
  coordinatorJournal: Exp0001aCodexCoordinatorJournal;
  evidence: Exp0001aCodexCompletionEvidence;
  attestation: Exp0001aCodexCompletionAttestation;
}>): Exp0001aCoordinatorLocalExecutionResult {
  const prior = exp0001aCodexCoordinatorJournalSchema.parse(input.coordinatorJournal);
  if (prior.provisioningStateDigest !== input.provisioningState.stateDigest
      || prior.scientificState === null || prior.scientificState.transitionDigests.length !== 9
      || prior.scientificState.stateDigest !== input.evidence.scientificState.stateDigest
      || hashCanonicalJson(prior.plans as unknown as JsonValue)
        !== hashCanonicalJson(input.evidence.plans as unknown as JsonValue)
      || hashCanonicalJson(prior.lifecycles as unknown as JsonValue)
        !== hashCanonicalJson(input.evidence.lifecycles as unknown as JsonValue)
      || prior.reviewProgress.analysisReportDigest !== prior.scientificState.analysisReceipt?.analysisReportDigest
      || prior.reviewProgress.signedCompletionAttestationDigest !== null) {
    throw new Error("EXP0001A_COORDINATOR_COMPLETION_PRIOR_STATE_INVALID");
  }
  const attestation = verifyExp0001aCodexCompletionAttestation({
    attestation: input.attestation,
    evidence: input.evidence,
    verifiedAt: input.verifiedAt,
  });
  const signedCompletionAttestationDigest = hashCanonicalJson(attestation as unknown as JsonValue);
  const journal = advanceCoordinatorJournal({
    prior,
    provisioningState: input.provisioningState,
    reviewProgress: {
      ...prior.reviewProgress,
      signedCompletionAttestationDigest,
    },
  });
  return Object.freeze({
    provisioningState: input.provisioningState,
    coordinatorJournal: journal,
    retainedEvidenceDigest: signedCompletionAttestationDigest,
  });
}

export type Exp0001aCoordinatorLocalExecutionResult = Readonly<{
  provisioningState: Exp0001aProvisioningCoordinatorState;
  coordinatorJournal: Exp0001aCodexCoordinatorJournal;
  retainedEvidenceDigest: string;
}>;

/** Executes exactly one provider-free coordinator action. External Codex-app,
 * WebMCP, and packet-sidecar calls remain explicit actions whose raw results
 * must enter through `ingestExp0001aCoordinatorActionResult`. */
export async function executeExp0001aCoordinatorLocalAction(input: Readonly<{
  action: Exp0001aCodexCoordinatorAction;
  provisioningState: Exp0001aProvisioningCoordinatorState;
  coordinatorJournal: Exp0001aCodexCoordinatorJournal;
  provisioningCoordinator: Exp0001aProvisioningCoordinator;
  spikeGate: unknown;
  spikeEvidence: unknown;
  scientificInputs?: Readonly<{
    freeze: Exp0001aCodexPrebriefFreeze;
    executionManifest: DevelopmentExecutionManifest;
    provisioningPlan: Exp0001aAttemptProvisioningPlanSet;
    reviewPlanManifest: Exp0001aCodexReviewPlanManifest;
  }>;
}>): Promise<Exp0001aCoordinatorLocalExecutionResult> {
  const prior = exp0001aCodexCoordinatorJournalSchema.parse(input.coordinatorJournal);
  if (prior.provisioningStateDigest !== input.provisioningState.stateDigest) {
    throw new Error("EXP0001A_LOCAL_ACTION_PRIOR_STATE_DRIFT");
  }
  let provisioningState = input.provisioningState;
  let journal = prior;
  let retainedEvidence: unknown;
  const action = input.action;
  if (action.kind === "perform_provisioning_local_transition") {
    if (action.transition === "reserve_next_attempt") {
      const retained = await input.provisioningCoordinator.reserveNextAttempt({
        spikeGate: input.spikeGate,
        spikeEvidence: input.spikeEvidence,
      });
      if (retained.attempt.assignmentId !== action.assignmentId) {
        throw new Error("EXP0001A_LOCAL_RESERVATION_ASSIGNMENT_DRIFT");
      }
      provisioningState = retained.state;
      retainedEvidence = retained;
    } else if (action.transition === "stop_provisioner_presence_renewals") {
      provisioningState = await input.provisioningCoordinator.stopProvisionerPresenceRenewals(action.assignmentId);
      retainedEvidence = provisioningState;
    } else if (action.transition === "finalize_room_receipt") {
      const retained = await input.provisioningCoordinator.finalizeRoomReceipt(action.assignmentId);
      provisioningState = retained.state;
      retainedEvidence = retained.receipt;
    } else {
      throw new Error(`EXP0001A_LOCAL_PROVISIONING_TRANSITION_NOT_EXECUTABLE:${action.transition}`);
    }
    journal = advanceCoordinatorJournal({ prior, provisioningState });
  } else if (action.kind === "release_reserved_create_room") {
    const retained = await input.provisioningCoordinator.releaseReservedCreateRoomCommand(action.assignmentId);
    provisioningState = retained.state;
    journal = advanceCoordinatorJournal({ prior, provisioningState });
    retainedEvidence = retained.createCommand;
  } else if (action.kind === "prepare_author_task") {
    const handoff = await input.provisioningCoordinator.createAuthorHandoff(action.assignmentId);
    provisioningState = await input.provisioningCoordinator.read();
    const reservation = provisioningState.reservations.find((candidate) => candidate.assignmentId === action.assignmentId);
    if (!reservation?.receipt) throw new Error("EXP0001A_AUTHOR_PREPARATION_ROOM_RECEIPT_MISSING");
    const envelope = createExp0001aAuthorTaskEnvelopeFromProvisioningHandoff(handoff, reservation.receipt);
    const dispatchOrdinal = prior.plans.filter((plan) =>
      plan.privateBinding.assignmentId === action.assignmentId).length + 1;
    const plan = await prepareExp0001aCodexTaskTransportWithFreshAuth({
      transportId: `author-${handoff.trustedBinding.plannedIndex.toString().padStart(2, "0")}-d${dispatchOrdinal}`,
      preparedAt: new Date().toISOString(),
      assignmentId: handoff.trustedBinding.assignmentId,
      attemptId: handoff.trustedBinding.attemptId,
      subjectArtifactIds: [],
      envelope,
      authorProvisioning: { handoff, roomProvisioningReceipt: reservation.receipt },
      spikeGate: input.spikeGate,
      spikeEvidence: input.spikeEvidence,
    });
    journal = advanceCoordinatorJournal({ prior, provisioningState, plans: [...prior.plans, plan] });
    retainedEvidence = plan;
  } else if (action.kind === "record_create_thread_release_invocation") {
    const receipt = await recordExp0001aCreateThreadReleaseInvoked({
      plan: action.plan,
      journalEvidenceDigest: prior.journalDigest,
    });
    journal = advanceCoordinatorJournal({
      prior,
      provisioningState,
      releaseInvocations: [...prior.releaseInvocations, receipt],
    });
    retainedEvidence = receipt;
  } else if (action.kind === "perform_scientific_phase_transition") {
    const scientificTransitions: readonly Exp0001aScientificTransition[] = [
      "seal_author_artifact_catalog",
      "prepare_primary_review_work_order",
      "record_primary_review_results",
      "derive_disagreement_adjudication_work_order",
      "record_adjudication_results",
      "lock_blinded_classifications",
      "prepare_pairwise_visual_work_order",
      "record_pairwise_visual_results",
      "run_cluster_aware_analysis",
    ];
    if (!scientificTransitions.includes(action.transition as Exp0001aScientificTransition)
        || input.scientificInputs === undefined) {
      throw new Error(`EXP0001A_LOCAL_SCIENTIFIC_TRANSITION_NOT_EXECUTABLE:${action.transition}`);
    }
    journal = performExp0001aCoordinatorScientificTransition({
      transition: action.transition as Exp0001aScientificTransition,
      transitionedAt: new Date().toISOString(),
      ...input.scientificInputs,
      provisioningState,
      coordinatorJournal: prior,
    });
    retainedEvidence = journal.scientificState;
  } else {
    throw new Error(`EXP0001A_COORDINATOR_ACTION_REQUIRES_EXTERNAL_BOUNDARY:${action.kind}`);
  }
  return Object.freeze({
    provisioningState,
    coordinatorJournal: journal,
    retainedEvidenceDigest: hashCanonicalJson(retainedEvidence as unknown as JsonValue),
  });
}
