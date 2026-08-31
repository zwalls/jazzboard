import { z } from "zod";

import {
  EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
  EXP0001A_CODEX_SCHEDULER_VERSION,
  EXP0001A_CODEX_TASK_ACCOUNTING_VERSION,
  exp0001aCodexFrozenRoleSettingsSchema,
} from "./exp0001a-codex-accounting";
import {
  EXP0001A_CODEX_AUTHORITY_KEY_ID,
  EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_DIGEST,
  EXP0001A_CODEX_AUTHORITY_SIGNATURE_VERSION,
  exp0001aCodexAuthoritySignatureSchema,
  verifyExp0001aCodexAuthoritySignature,
} from "./exp0001a-codex-authority";
import { EXP0001A_CODEX_ANALYSIS_SETTINGS } from "./exp0001a-codex-analysis";
import { EXP0001A_REVOKED_SPIKE_GATE_PAYLOAD_DIGESTS } from "./codex-webmcp-spike-recovery";
import { hashCanonicalJson, SHA256_DIGEST_PATTERN, type JsonValue } from "./provenance-crypto";

export const EXP0001A_CODEX_PREBRIEF_FREEZE_VERSION = "exp-0001a-codex-prebrief-freeze/v2" as const;
export const EXP0001A_CODEX_PREBRIEF_FREEZE_PATH = "research/data/exp-0001a-codex-prebrief-freeze-v2.json" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const stableIdSchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sourceCommitmentSchema = z.object({
  path: z.string().trim().min(1).max(400),
  digest: digestSchema,
}).strict();

export const EXP0001A_ACTIVE_RUNTIME_REQUIRED_SOURCE_PATHS = Object.freeze([
  "research/scripts/codex-auth-preflight.mjs",
  "src/lib/research/codex-webmcp-spike.ts",
  "src/lib/research/codex-webmcp-spike-recovery.ts",
  "src/lib/research/exp0001a-attempt-provisioning.ts",
  "src/lib/research/exp0001a-codex-accounting.ts",
  "src/lib/research/exp0001a-codex-accounting-finalizer.ts",
  "src/lib/research/exp0001a-codex-analysis.ts",
  "src/lib/research/exp0001a-codex-artifact-packet-server.ts",
  "src/lib/research/exp0001a-codex-authority.ts",
  "src/lib/research/exp0001a-codex-coordinator.ts",
  "src/lib/research/exp0001a-codex-prebrief-freeze.ts",
  "src/lib/research/exp0001a-codex-review-runtime.ts",
  "src/lib/research/exp0001a-codex-runtime-contract.ts",
  "src/lib/research/exp0001a-codex-scientific-runtime.ts",
  "src/lib/research/exp0001a-codex-task-transport.ts",
  "src/lib/research/exp0001a-completion-attestation.ts",
  "src/lib/research/exp0001a-runtime-composition.ts",
  "src/lib/research/statistics.ts",
] as const);

export const EXP0001A_OUTER_EXECUTION_REQUIRED_SOURCE_PATHS = Object.freeze([
  "research/scripts/build-exp0001a-runtime.mjs",
  "research/scripts/codex-auth-preflight.mjs",
  "research/scripts/exp0001a-batch-command.mjs",
  "research/scripts/exp0001a-authority-journal.mjs",
  "research/scripts/exp0001a-artifact-packet-sidecar.mjs",
  "research/scripts/exp0001a-codex-launch-readiness.mjs",
  "research/scripts/exp0001a-coordinator-transaction.mjs",
  "research/scripts/exp0001a-outer-source-verifier.mjs",
  "research/scripts/generate-exp0001a-codex-freeze.mjs",
  "research/scripts/generate-exp0001a-codex-review-plan.mjs",
  "research/scripts/sign-exp0001a-codex-spike-recovery-gate.mjs",
  "research/scripts/sign-exp0001a-completion.mjs",
  "research/scripts/sign-exp0001a-coordinator-checkpoint.mjs",
  "research/scripts/sign-exp0001a-codex-prebrief-freeze.mjs",
  "research/scripts/sign-exp0001a-usage-reset-probe.mjs",
] as const);

export const EXP0001A_REVOKED_COMPLETION_PAYLOAD_DIGEST_COMMITMENTS = Object.freeze([
  "sha256:4b061142c4dffa3b6393d7966515926c343647f6cb3c40457b7382df4a03f757",
] as const);

const conditionCommitmentSchema = z.object({
  productReceiptDigest: digestSchema,
  productBuildDigest: digestSchema,
  scheduleConfigurationDigest: digestSchema,
  authorBriefCompilerDigest: digestSchema,
  toolAllowlistDigest: digestSchema,
  participantContractDigest: digestSchema,
  spectatorContractDigest: digestSchema,
}).strict();

const freezeContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_PREBRIEF_FREEZE_VERSION),
  freezeId: z.literal("exp-0001a-codex-prebrief-freeze-v2"),
  protocolId: z.literal("EXP-0001A"),
  studyKind: z.literal("aa_calibration"),
  partition: z.literal("development"),
  frozenAt: z.string().datetime({ offset: true }),
  executionStateAtFreeze: z.literal("not_started"),
  briefReleaseAuthorized: z.literal(false),
  supersedes: z.object({
    path: z.literal("research/data/exp-0001a-prebrief-freeze-v1.json"),
    freezeDigest: digestSchema,
    reason: z.literal("transport_changed_to_ChatGPT-authenticated Codex subscription tasks before any A/A brief release"),
  }).strict(),
  transport: z.object({
    kind: z.literal("chatgpt_authenticated_codex_tasks"),
    authentication: z.literal("chatgpt_only"),
    taskTransport: z.literal("codex_app"),
    directHttpRequests: z.literal(false),
    projectlessFreshTasks: z.literal(true),
    repositoryAccess: z.literal(false),
    privateApiAccess: z.literal(false),
  }).strict(),
  passedSpikeGate: z.object({
    publicEvidencePath: z.literal("research/data/exp0001a-codex-webmcp-spike-public-v2.json"),
    publicSignedGatePath: z.literal("research/data/exp0001a-codex-webmcp-spike-gate-public-v2.json"),
    publicSignedGateFileDigest: digestSchema,
    authoritySignaturePayloadDigest: digestSchema,
    authoritySignatureBase64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    spikeEvidenceDigest: digestSchema,
    gateDigest: digestSchema,
    decision: z.literal("allow"),
  }).strict(),
  authority: z.object({
    signatureSchemaVersion: z.literal(EXP0001A_CODEX_AUTHORITY_SIGNATURE_VERSION),
    algorithm: z.literal("Ed25519"),
    keyId: z.literal(EXP0001A_CODEX_AUTHORITY_KEY_ID),
    publicKeyPath: z.literal("research/data/exp0001a-execution-authority-public.pem"),
    publicKeyDigest: z.literal(EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_DIGEST),
    requiredPurposes: z.tuple([
      z.literal("spike_gate"),
      z.literal("prebrief_freeze"),
      z.literal("coordinator_checkpoint"),
      z.literal("usage_reset_probe"),
      z.literal("completion_attestation"),
    ]),
    revokedCompletionPayloadDigests: z.tuple([
      z.literal(EXP0001A_REVOKED_COMPLETION_PAYLOAD_DIGEST_COMMITMENTS[0]),
    ]),
    revokedSpikeGatePayloadDigests: z.tuple([
      z.literal(EXP0001A_REVOKED_SPIKE_GATE_PAYLOAD_DIGESTS[0]),
      z.literal(EXP0001A_REVOKED_SPIKE_GATE_PAYLOAD_DIGESTS[1]),
    ]),
    prebriefFreezeSignaturePath: z.literal("research/data/exp0001a-codex-prebrief-freeze-signature-v2.json"),
    privateKeyPublishedOrBundled: z.literal(false),
  }).strict(),
  activeRuntime: z.object({
    bundlePath: z.literal("research/runtime/exp0001a-runtime.bundle.mjs"),
    bundleDigest: digestSchema,
    buildScript: sourceCommitmentSchema.extend({
      path: z.literal("research/scripts/build-exp0001a-runtime.mjs"),
      esbuildVersion: z.literal("0.25.12"),
    }).strict(),
    requiredSourcePaths: z.array(z.enum(EXP0001A_ACTIVE_RUNTIME_REQUIRED_SOURCE_PATHS))
      .length(EXP0001A_ACTIVE_RUNTIME_REQUIRED_SOURCE_PATHS.length),
    retiredProviderArtifacts: z.literal("historical_unreachable"),
  }).strict(),
  outerExecution: z.object({
    sourceCommitments: z.array(z.object({
      path: z.enum(EXP0001A_OUTER_EXECUTION_REQUIRED_SOURCE_PATHS),
      digest: digestSchema,
    }).strict()).length(EXP0001A_OUTER_EXECUTION_REQUIRED_SOURCE_PATHS.length),
    actionBoundary: z.literal("prepare_receipt_then_durable_delivery_ack_then_single_invocation_then_authoritative_ingest"),
    directProviderApiDisabled: z.literal(true),
    privateAuthorityKeyPublishedOrBundled: z.literal(false),
  }).strict(),
  schedule: z.object({
    manifestPath: z.literal("research/data/development-execution-manifest-v1.json"),
    manifestFileDigest: digestSchema,
    manifestDigest: digestSchema,
    benchmarkBundleDigest: digestSchema,
    taskCommitmentsDigest: digestSchema,
    fixedOrderDigest: digestSchema,
    codexSchedulerDigest: digestSchema,
    treatmentDigest: digestSchema,
    opaqueLabels: z.tuple([z.literal("A0"), z.literal("A1")]),
    taskCount: z.literal(12),
    pairCount: z.literal(24),
    attemptCount: z.literal(48),
    rerunsPermitted: z.literal(false),
    taskCommitments: z.array(z.object({ taskId: stableIdSchema, taskDigest: digestSchema }).strict()).length(12),
  }).strict(),
  sources: z.object({
    benchmark: sourceCommitmentSchema,
    rubrics: sourceCommitmentSchema,
    failureTaxonomy: sourceCommitmentSchema,
    sealedSamplePlan: sourceCommitmentSchema,
  }).strict(),
  conditions: z.object({
    A0: conditionCommitmentSchema,
    A1: conditionCommitmentSchema,
  }).strict(),
  roleSettings: exp0001aCodexFrozenRoleSettingsSchema,
  reviewCommitments: z.object({
    reviewPlanManifestPath: z.literal("research/data/exp0001a-codex-review-plan-v1.json"),
    reviewPlanManifestFileDigest: digestSchema,
    reviewPlanManifestDigest: digestSchema,
    primaryReviewsPerArtifact: z.literal(2),
    primaryReviewerTaskCount: z.literal(96),
    primaryAssignmentAlgorithm: z.literal("sha256-ranked-by-registry-artifact-identity-and-purpose"),
    primaryAssignmentSeed: digestSchema,
    primaryReviewerRosterRoot: digestSchema,
    adjudicationTrigger: z.literal("binary-primary-acceptance-disagreement-only"),
    preserveOriginalReviews: z.literal(true),
    minimumDistinctReviewers: z.literal(3),
    pairwiseComparisonCount: z.literal(24),
    pairwisePromptDigest: digestSchema,
    pairwiseWorkOrderDigest: digestSchema,
    pairwiseRandomizationAlgorithm: z.literal("sha256-ranked-balanced-family-replicate-v1"),
    pairwiseLeftRightRandomizationDigest: digestSchema,
    pairwiseReviewerRosterRoot: digestSchema,
    reviewerIdentityCommitmentsSourceFreezeDigest: digestSchema,
    authorMayReview: z.literal(false),
    pairedArtifactVisibleBeforeLock: z.literal(false),
    conditionLabelVisibleBeforeLock: z.literal(false),
  }).strict(),
  accounting: z.object({
    taskRecordSchemaVersion: z.literal(EXP0001A_CODEX_TASK_ACCOUNTING_VERSION),
    schedulerSchemaVersion: z.literal(EXP0001A_CODEX_SCHEDULER_VERSION),
    exactTokensWhenObservableOtherwise: z.literal("unobservable"),
    exactResolvedModelWhenObservableOtherwise: z.literal("unobservable"),
    subscriptionUsageWhenObservableOtherwise: z.literal("unobservable"),
    estimatesPermitted: z.literal(false),
    monetaryAccounting: z.literal("not_collected"),
  }).strict(),
  analysisSettings: z.object({
    bootstrapDraws: z.literal(EXP0001A_CODEX_ANALYSIS_SETTINGS.bootstrapDraws),
    seed: z.literal(EXP0001A_CODEX_ANALYSIS_SETTINGS.seed),
    primaryInference: z.literal("exact_two_sided_complete_task_vector_sign_flip"),
    clusterCount: z.literal(12),
    replicatesPerCluster: z.literal(2),
    pairwiseUnavailablePolicy: z.literal("retain_as_unavailable_and_mark_cluster_vector_not_evaluable"),
  }).strict(),
  usageLimitPolicy: z.object({
    stopBeforeNextBrief: z.literal(true),
    preserveEveryBegunAttempt: z.literal(true),
    resumeAtNextGenuinelyUnstartedAssignment: z.literal(true),
    retainFrozenOrder: z.literal(true),
    maintainTemporalConditionBalance: z.literal(true),
  }).strict(),
  scientificControls: z.object({
    randomizedInterleavedSchedule: z.literal(true),
    artifactHashingAndProvenance: z.literal(true),
    blindedIndependentReview: z.literal(true),
    separateAdjudicationContexts: z.literal(true),
    pairwiseVisualComparison: z.literal(true),
    clusterAwareStatistics: z.literal(true),
    sealedTestProtection: z.literal(true),
  }).strict(),
}).strict().superRefine((freeze, context) => {
  if ((EXP0001A_REVOKED_SPIKE_GATE_PAYLOAD_DIGESTS as readonly string[])
    .includes(freeze.passedSpikeGate.authoritySignaturePayloadDigest)) {
    context.addIssue({
      code: "custom",
      path: ["passedSpikeGate", "authoritySignaturePayloadDigest"],
      message: "Prebrief freeze cannot authorize a revoked spike-gate payload.",
    });
  }
  if (hashCanonicalJson(freeze.conditions.A0 as unknown as JsonValue)
      !== hashCanonicalJson(freeze.conditions.A1 as unknown as JsonValue)) {
    context.addIssue({ code: "custom", path: ["conditions"], message: "A/A condition commitments must remain byte-equivalent." });
  }
  const taskIds = new Set(freeze.schedule.taskCommitments.map((task) => task.taskId));
  if (taskIds.size !== 12) context.addIssue({ code: "custom", path: ["schedule", "taskCommitments"], message: "Task commitments must be unique." });
  if (hashCanonicalJson(freeze.roleSettings as unknown as JsonValue)
      !== hashCanonicalJson(EXP0001A_CODEX_FROZEN_ROLE_SETTINGS as unknown as JsonValue)) {
    context.addIssue({ code: "custom", path: ["roleSettings"], message: "Role settings differ from the Codex-native frozen policy." });
  }
  if (hashCanonicalJson(freeze.activeRuntime.requiredSourcePaths as unknown as JsonValue)
      !== hashCanonicalJson(EXP0001A_ACTIVE_RUNTIME_REQUIRED_SOURCE_PATHS as unknown as JsonValue)) {
    context.addIssue({
      code: "custom",
      path: ["activeRuntime", "requiredSourcePaths"],
      message: "Active runtime source inventory differs from the deterministic Codex-native bundle policy.",
    });
  }
  if (hashCanonicalJson(freeze.outerExecution.sourceCommitments.map((source) => source.path) as unknown as JsonValue)
      !== hashCanonicalJson(EXP0001A_OUTER_EXECUTION_REQUIRED_SOURCE_PATHS as unknown as JsonValue)) {
    context.addIssue({
      code: "custom",
      path: ["outerExecution", "sourceCommitments"],
      message: "Outer execution source inventory differs from the frozen release policy.",
    });
  }
});

export const exp0001aCodexPrebriefFreezeSchema = freezeContentSchema.extend({
  freezeDigest: digestSchema,
}).strict();

export type Exp0001aCodexPrebriefFreeze = z.infer<typeof exp0001aCodexPrebriefFreezeSchema>;

export function computeExp0001aCodexPrebriefFreezeDigest(
  value: Omit<Exp0001aCodexPrebriefFreeze, "freezeDigest">,
): string {
  return hashCanonicalJson(value as unknown as JsonValue);
}

export function verifyExp0001aCodexPrebriefFreeze(value: unknown): Exp0001aCodexPrebriefFreeze {
  const freeze = exp0001aCodexPrebriefFreezeSchema.parse(value);
  const { freezeDigest: _freezeDigest, ...content } = freeze;
  void _freezeDigest;
  if (computeExp0001aCodexPrebriefFreezeDigest(content) !== freeze.freezeDigest) {
    throw new Error("EXP0001A_CODEX_PREBRIEF_FREEZE_DIGEST_INVALID");
  }
  return Object.freeze(freeze);
}

/** A self-hash protects accidental drift; this detached fixed-key signature is
 * the non-caller-forgeable authority that makes the no-brief v2 freeze valid. */
export function verifyExp0001aCodexPrebriefFreezeAuthority(input: Readonly<{
  freeze: unknown;
  authoritySignature: unknown;
  verifiedAt: string;
}>): Exp0001aCodexPrebriefFreeze {
  const freeze = verifyExp0001aCodexPrebriefFreeze(input.freeze);
  const signature = exp0001aCodexAuthoritySignatureSchema.parse(input.authoritySignature);
  verifyExp0001aCodexAuthoritySignature({
    payload: freeze as unknown as JsonValue,
    signature,
    purpose: "prebrief_freeze",
    notBefore: freeze.frozenAt,
  });
  if (Date.parse(signature.signedAt) > Date.parse(z.string().datetime({ offset: true }).parse(input.verifiedAt))) {
    throw new Error("EXP0001A_CODEX_PREBRIEF_FREEZE_SIGNATURE_FROM_FUTURE");
  }
  return freeze;
}
