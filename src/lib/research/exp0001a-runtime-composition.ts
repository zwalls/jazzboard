import {
  EXP0001A_PROVISIONING_VERSION,
  createExp0001aAttemptProvisioningPlan,
  createExp0001aProvisioningCoordinator,
  createExp0001aProvisioningScheduler,
  nextExp0001aProvisioningAction,
  projectNextExp0001aProvisioningAction,
  releaseNextExp0001aProvisioningAttempt,
  verifyExp0001aAttemptProvisioningPlan,
} from "./exp0001a-attempt-provisioning";
import {
  EXP0001A_CODEX_SCHEDULER_VERSION,
  EXP0001A_CODEX_TASK_ACCOUNTING_VERSION,
  EXP0001A_SUBSCRIPTION_PROBE_PROMPT_DIGEST,
  exp0001aChatGptUsageResetObservationSchema,
  exp0001aCodexAccountingLedgerSchema,
  exp0001aCodexTaskAccountingSchema,
  exp0001aCodexSchedulerStateSchema,
  beginExp0001aCodexTask,
  recordExp0001aCodexTaskActivity,
  completeExp0001aCodexTask,
  terminateExp0001aCodexTask,
  interruptExp0001aCodexTaskForUsageLimit,
  pauseExp0001aCodexSchedulerForUsageLimit,
  resumeExp0001aCodexSchedulerAfterUsageReset,
  verifyExp0001aCodexAccountingLedgerAsOf,
  verifyExp0001aCodexSchedulerStateAsOf,
} from "./exp0001a-codex-accounting";
import {
  EXP0001A_CODEX_ACCOUNTING_FINALIZER_VERSION,
  exp0001aCodexAccountingFinalizationReceiptSchema,
  finalizeExp0001aCodexTaskAccounting,
  verifyExp0001aCodexAccountingFinalizationReceipt,
} from "./exp0001a-codex-accounting-finalizer";
import {
  EXP0001A_CODEX_AUTHORITY_SIGNATURE_VERSION,
  exp0001aCodexAuthoritySignatureSchema,
  verifyExp0001aCodexAuthoritySignature,
  verifyExp0001aCodexAuthoritySignatureEnvelope,
} from "./exp0001a-codex-authority";
import {
  createExp0001aCodexCoordinatorJournal,
  deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal,
  EXP0001A_CODEX_COORDINATOR_VERSION,
  exp0001aCodexCoordinatorJournalSchema,
  executeExp0001aCoordinatorLocalAction,
  ingestExp0001aCoordinatorActionResult,
  planNextExp0001aCodexCoordinatorAction,
  performExp0001aCoordinatorScientificTransition,
  retainExp0001aCoordinatorCompletionAttestation,
  retainExp0001aSubscriptionProbeResultInCoordinatorJournal,
  type Exp0001aCodexCoordinatorAction,
} from "./exp0001a-codex-coordinator";
import {
  EXP0001A_CODEX_ANALYSIS_VERSION,
  analyzeExp0001aCodexExperiment,
} from "./exp0001a-codex-analysis";
import {
  EXP0001A_CODEX_ARTIFACT_PACKET_SERVER_VERSION,
  exp0001aCodexArtifactPacketServerStartReceiptSchema,
  exp0001aCodexArtifactPacketServerStopReceiptSchema,
  startExp0001aCodexArtifactPacketServer,
  startExp0001aCodexAdjudicationArtifactPacketServer,
  startExp0001aCodexPairwiseArtifactPacketServer,
  startExp0001aCodexPrimaryArtifactPacketServer,
} from "./exp0001a-codex-artifact-packet-server";
import {
  EXP0001A_CODEX_REVIEW_RUNTIME_VERSION,
  EXP0001A_CODEX_REVIEW_SOURCE,
  createExp0001aCodexAdjudicationWorkOrder,
  createExp0001aCodexAnalysisReceipt,
  createExp0001aCodexPairwiseWorkOrder,
  createExp0001aCodexPrimaryReviewWorkOrder,
  createExp0001aCodexReviewPlanManifest,
  exp0001aCodexAdjudicationResultLedgerSchema,
  exp0001aCodexAdjudicationWorkOrderSchema,
  exp0001aCodexAnalysisReceiptSchema,
  exp0001aCodexAuthorArtifactCatalogSchema,
  exp0001aCodexClassificationBookSchema,
  exp0001aCodexPairwiseResultLedgerSchema,
  exp0001aCodexPairwiseWorkOrderSchema,
  exp0001aCodexPrimaryReviewResultLedgerSchema,
  exp0001aCodexPrimaryReviewWorkOrderSchema,
  exp0001aCodexReviewPlanManifestSchema,
  lockExp0001aCodexClassifications,
  recordExp0001aCodexAdjudicationResults,
  recordExp0001aCodexPairwiseResults,
  recordExp0001aCodexPrimaryReviewResults,
  sealExp0001aCodexAuthorArtifactCatalog,
  verifyExp0001aCodexReviewPlanManifest,
  verifyExp0001aCodexAdjudicationResults,
  verifyExp0001aCodexPairwiseResults,
  verifyExp0001aCodexPrimaryReviewResults,
} from "./exp0001a-codex-review-runtime";
import {
  EXP0001A_CODEX_PREBRIEF_FREEZE_VERSION,
  verifyExp0001aCodexPrebriefFreeze,
  verifyExp0001aCodexPrebriefFreezeAuthority,
} from "./exp0001a-codex-prebrief-freeze";
import {
  EXP0001A_CODEX_RUNTIME_CONTRACT_VERSION,
  createExp0001aCodexCoordinatorCheckpointDraft,
  createExp0001aCodexRuntimePreflight,
  exp0001aCodexCoordinatorCheckpointDraftSchema,
  exp0001aCodexCoordinatorCheckpointSchema,
  exp0001aCodexRuntimeConfigSchema,
  verifyExp0001aCodexRuntimePreflight,
  type Exp0001aCodexRuntimePreflightReceipt,
} from "./exp0001a-codex-runtime-contract";
import {
  EXP0001A_CODEX_SCIENTIFIC_RUNTIME_VERSION,
  createExp0001aCodexScientificState,
  exp0001aCodexScientificStateSchema,
  nextExp0001aScientificReviewWorkItem,
  performExp0001aCodexScientificTransition,
} from "./exp0001a-codex-scientific-runtime";
import type { Exp0001aProvisioningCoordinatorState } from "./exp0001a-attempt-provisioning";
import { hashCanonicalJson, type JsonValue } from "./provenance-crypto";
import {
  EXP0001A_CODEX_TASK_TRANSPORT_VERSION,
  createExp0001aAuthorTaskEnvelopeFromProvisioningHandoff,
  issueExp0001aAuthorFinalEvidenceCommand,
  prepareExp0001aCodexTaskTransportWithFreshAuth,
  probeExp0001aCodexArtifactPacket,
  assertExp0001aCodexTaskContextsSeparated,
  issueExp0001aCreateReconciliationCommand,
  issueExp0001aReadThreadCommand,
  issueExp0001aWaitThreadsCommand,
  recordExp0001aCreateReconciliationResult,
  recordExp0001aAuthorFinalEvidenceResult,
  recordExp0001aCreateThreadReleaseInvoked,
  recordExp0001aCreateThreadResult,
  recordExp0001aReadThreadResult,
  recordExp0001aWaitThreadsResult,
} from "./exp0001a-codex-task-transport";
import {
  EXP0001A_CODEX_COMPLETION_ATTESTATION_VERSION,
  authorizeExp0001aCodexCompletionAttestation,
  createExp0001aCodexCompletionAttestation,
  retainExp0001aCodexCompletionAttestation,
  verifyExp0001aCodexCompletionAttestation,
} from "./exp0001a-completion-attestation";
import {
  EXP0001A_CODEX_SPIKE_RECOVERY_GATE_VERSION,
  verifyExp0001aCodexSpikeRecoveryGate,
} from "./codex-webmcp-spike-recovery";

export const EXP0001A_RUNTIME_COMPOSITION_SOURCE_PATH =
  "src/lib/research/exp0001a-runtime-composition.ts" as const;
export const EXP0001A_RUNTIME_BUNDLE_PATH =
  "research/runtime/exp0001a-runtime.bundle.mjs" as const;
export const EXP0001A_ACTIVE_CODEX_RUNTIME_VERSIONS = Object.freeze({
  authority: EXP0001A_CODEX_AUTHORITY_SIGNATURE_VERSION,
  spikeRecoveryGate: EXP0001A_CODEX_SPIKE_RECOVERY_GATE_VERSION,
  coordinator: EXP0001A_CODEX_COORDINATOR_VERSION,
  runtimeContract: EXP0001A_CODEX_RUNTIME_CONTRACT_VERSION,
  scientificRuntime: EXP0001A_CODEX_SCIENTIFIC_RUNTIME_VERSION,
  prebriefFreeze: EXP0001A_CODEX_PREBRIEF_FREEZE_VERSION,
  taskTransport: EXP0001A_CODEX_TASK_TRANSPORT_VERSION,
  provisioning: EXP0001A_PROVISIONING_VERSION,
  taskAccounting: EXP0001A_CODEX_TASK_ACCOUNTING_VERSION,
  taskAccountingFinalizer: EXP0001A_CODEX_ACCOUNTING_FINALIZER_VERSION,
  scheduler: EXP0001A_CODEX_SCHEDULER_VERSION,
  analysis: EXP0001A_CODEX_ANALYSIS_VERSION,
  artifactPacketServer: EXP0001A_CODEX_ARTIFACT_PACKET_SERVER_VERSION,
  reviewRuntime: EXP0001A_CODEX_REVIEW_RUNTIME_VERSION,
  completionAttestation: EXP0001A_CODEX_COMPLETION_ATTESTATION_VERSION,
});

export type Exp0001aCodexRuntimeResult = Readonly<{
  mode: "dry-run" | "execute";
  status: "ready_for_coordinator";
  executionAllowed: boolean;
  action: Exp0001aCodexCoordinatorAction;
  actionDigest: string;
  externalToolInvokedByRuntime: false;
  callerMustPerformAndRetainResult: true;
  preflight: Exp0001aCodexRuntimePreflightReceipt;
  versions: typeof EXP0001A_ACTIVE_CODEX_RUNTIME_VERSIONS;
}>;

/**
 * The active deterministic bundle is subscription-only. Dry-run validates the
 * exact retained evidence without side effects. Execute emits exactly one
 * signed-state-bound coordinator action for the outer agent. The deterministic
 * runtime never invokes an app or WebMCP tool and never claims that it did.
 */
export async function runExp0001aCodexRuntime(input: Readonly<{
  mode: "dry-run" | "execute";
  executionCheckedAt: string;
  preflight: unknown;
  provisioningState: Exp0001aProvisioningCoordinatorState;
  coordinatorJournal: unknown;
}>): Promise<Exp0001aCodexRuntimeResult> {
  const preflight = verifyExp0001aCodexRuntimePreflight(input.preflight, input.executionCheckedAt);
  const coordinatorJournal = exp0001aCodexCoordinatorJournalSchema.parse(input.coordinatorJournal);
  const action = planNextExp0001aCodexCoordinatorAction({
    issuedAt: preflight.nextAction.coordinatorActionIssuedAt,
    provisioningState: input.provisioningState,
    journal: coordinatorJournal,
  });
  const actionDigest = hashCanonicalJson(action as unknown as JsonValue);
  if (actionDigest !== preflight.nextAction.actionDigest
      || input.provisioningState.stateDigest !== preflight.provisioningStateDigest
      || coordinatorJournal.journalDigest !== preflight.coordinatorJournalDigest) {
    throw new Error("EXP0001A_CODEX_RUNTIME_ACTION_DRIFT");
  }
  return Object.freeze({
    mode: input.mode,
    status: "ready_for_coordinator",
    executionAllowed: input.mode === "execute",
    action,
    actionDigest,
    externalToolInvokedByRuntime: false,
    callerMustPerformAndRetainResult: true,
    preflight,
    versions: EXP0001A_ACTIVE_CODEX_RUNTIME_VERSIONS,
  });
}

// Re-export the complete active surface so the deterministic bundle commits
// the exact transport, provisioning, accounting, analysis, and completion
// implementations rather than repository-selected dynamic modules.
export {
  EXP0001A_CODEX_REVIEW_SOURCE,
  analyzeExp0001aCodexExperiment,
  startExp0001aCodexArtifactPacketServer,
  startExp0001aCodexAdjudicationArtifactPacketServer,
  startExp0001aCodexPairwiseArtifactPacketServer,
  startExp0001aCodexPrimaryArtifactPacketServer,
  exp0001aCodexArtifactPacketServerStartReceiptSchema,
  exp0001aCodexArtifactPacketServerStopReceiptSchema,
  createExp0001aAttemptProvisioningPlan,
  createExp0001aAuthorTaskEnvelopeFromProvisioningHandoff,
  issueExp0001aAuthorFinalEvidenceCommand,
  createExp0001aProvisioningCoordinator,
  createExp0001aCodexCoordinatorJournal,
  exp0001aCodexCoordinatorJournalSchema,
  executeExp0001aCoordinatorLocalAction,
  deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal,
  createExp0001aCodexScientificState,
  exp0001aCodexScientificStateSchema,
  nextExp0001aScientificReviewWorkItem,
  performExp0001aCodexScientificTransition,
  authorizeExp0001aCodexCompletionAttestation,
  createExp0001aCodexCompletionAttestation,
  createExp0001aCodexAdjudicationWorkOrder,
  createExp0001aCodexAnalysisReceipt,
  createExp0001aCodexPairwiseWorkOrder,
  createExp0001aCodexPrimaryReviewWorkOrder,
  createExp0001aCodexReviewPlanManifest,
  createExp0001aCodexCoordinatorCheckpointDraft,
  createExp0001aCodexRuntimePreflight,
  createExp0001aProvisioningScheduler,
  nextExp0001aProvisioningAction,
  projectNextExp0001aProvisioningAction,
  exp0001aCodexAccountingLedgerSchema,
  exp0001aCodexTaskAccountingSchema,
  exp0001aCodexAccountingFinalizationReceiptSchema,
  exp0001aChatGptUsageResetObservationSchema,
  EXP0001A_SUBSCRIPTION_PROBE_PROMPT_DIGEST,
  finalizeExp0001aCodexTaskAccounting,
  verifyExp0001aCodexAccountingFinalizationReceipt,
  exp0001aCodexAdjudicationResultLedgerSchema,
  exp0001aCodexAdjudicationWorkOrderSchema,
  exp0001aCodexAnalysisReceiptSchema,
  exp0001aCodexAuthorArtifactCatalogSchema,
  exp0001aCodexClassificationBookSchema,
  exp0001aCodexPairwiseResultLedgerSchema,
  exp0001aCodexPairwiseWorkOrderSchema,
  exp0001aCodexPrimaryReviewResultLedgerSchema,
  exp0001aCodexPrimaryReviewWorkOrderSchema,
  exp0001aCodexReviewPlanManifestSchema,
  beginExp0001aCodexTask,
  recordExp0001aCodexTaskActivity,
  completeExp0001aCodexTask,
  terminateExp0001aCodexTask,
  interruptExp0001aCodexTaskForUsageLimit,
  pauseExp0001aCodexSchedulerForUsageLimit,
  resumeExp0001aCodexSchedulerAfterUsageReset,
  verifyExp0001aCodexAccountingLedgerAsOf,
  verifyExp0001aCodexSchedulerStateAsOf,
  exp0001aCodexRuntimeConfigSchema,
  exp0001aCodexCoordinatorCheckpointDraftSchema,
  exp0001aCodexCoordinatorCheckpointSchema,
  exp0001aCodexSchedulerStateSchema,
  planNextExp0001aCodexCoordinatorAction,
  ingestExp0001aCoordinatorActionResult,
  performExp0001aCoordinatorScientificTransition,
  retainExp0001aCoordinatorCompletionAttestation,
  retainExp0001aSubscriptionProbeResultInCoordinatorJournal,
  prepareExp0001aCodexTaskTransportWithFreshAuth,
  probeExp0001aCodexArtifactPacket,
  assertExp0001aCodexTaskContextsSeparated,
  issueExp0001aCreateReconciliationCommand,
  issueExp0001aReadThreadCommand,
  issueExp0001aWaitThreadsCommand,
  recordExp0001aCreateReconciliationResult,
  recordExp0001aAuthorFinalEvidenceResult,
  recordExp0001aCreateThreadReleaseInvoked,
  recordExp0001aCreateThreadResult,
  recordExp0001aReadThreadResult,
  recordExp0001aWaitThreadsResult,
  recordExp0001aCodexAdjudicationResults,
  recordExp0001aCodexPairwiseResults,
  recordExp0001aCodexPrimaryReviewResults,
  releaseNextExp0001aProvisioningAttempt,
  retainExp0001aCodexCompletionAttestation,
  lockExp0001aCodexClassifications,
  sealExp0001aCodexAuthorArtifactCatalog,
  verifyExp0001aAttemptProvisioningPlan,
  verifyExp0001aCodexCompletionAttestation,
  verifyExp0001aCodexSpikeRecoveryGate,
  exp0001aCodexAuthoritySignatureSchema,
  verifyExp0001aCodexAuthoritySignature,
  verifyExp0001aCodexAuthoritySignatureEnvelope,
  verifyExp0001aCodexPrebriefFreeze,
  verifyExp0001aCodexPrebriefFreezeAuthority,
  verifyExp0001aCodexAdjudicationResults,
  verifyExp0001aCodexPairwiseResults,
  verifyExp0001aCodexPrimaryReviewResults,
  verifyExp0001aCodexReviewPlanManifest,
};
