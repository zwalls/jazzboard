import { z } from "zod";

import developmentBenchmarkJson from "../../../research/benchmarks/development-v2.json";
import developmentManifestJson from "../../../research/data/development-execution-manifest-v2.json";
import { createAtomicRegistryStore } from "./atomic-registry-store";
import {
  EXPECTED_BASELINE_V2_IDENTITY,
  verifyBaselineV2ExecutionReady,
  type BaselineFreezeReceiptV2,
  type BaselineV2ArtifactBytes,
} from "./baseline-freeze-v2";
import { baselineFreezeV2AuthoritySignatureSchema } from "./baseline-freeze-v2-authority";
import { verifyDevelopmentExecutionManifest } from "./development-manifest";
import { signedQualificationV2ResultEnvelopeSchema } from "./exp0001a-model-role-qualification-v2-coordinator";
import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

export const EXP0001A_SUCCESSOR_RUNTIME_V3_VERSION =
  "exp-0001a-successor-runtime/v3" as const;
export const EXP0001A_SUCCESSOR_RELEASE_STATE_V3_VERSION =
  "exp-0001a-successor-release-state/v3" as const;
export const EXP0001A_SUCCESSOR_BASELINE_V2_RECEIPT_DIGEST =
  "sha256:e5568148fa6175bfb59692422da3785920b2beebc127bbab4da804e1362cbd68" as const;
export const EXP0001A_SUCCESSOR_QUALIFICATION_V2_PLAN_DIGEST =
  "sha256:e318342431aa10f1813ea7ee9bcdd508f913096a71d0886cebde98212287188b" as const;
export const EXP0001A_SUCCESSOR_QUALIFICATION_V2_PLAN_SIGNATURE_DIGEST =
  "sha256:1aa9914f472f5fadd85027d9eb08337279ee67f08183bae93a6b40ffa57f89cb" as const;
export const EXP0001A_SUCCESSOR_QUALIFICATION_V2_PRODUCTION_BINDING_DIGEST =
  "sha256:4efb96a5bb2a0e49f6e6c17782a4b5b290b3ff540e8ea6f9fc8cd34afd546272" as const;
export const EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID =
  "assignment-attempt-dev-architecture-create-checkout-r1-a1" as const;
export const EXP0001A_SUCCESSOR_FIRST_ATTEMPT_ID =
  "attempt-dev-architecture-create-checkout-r1-a1" as const;
export const EXP0001A_SUCCESSOR_FIRST_PAIR_ID =
  "pair-dev-architecture-create-checkout-r1" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });

const firstAssignmentSchema = z.object({
  assignmentId: z.literal(EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID),
  attemptId: z.literal(EXP0001A_SUCCESSOR_FIRST_ATTEMPT_ID),
  pairId: z.literal(EXP0001A_SUCCESSOR_FIRST_PAIR_ID),
  taskId: z.literal("dev-architecture-create-checkout"),
  taskDigest: z.literal("sha256:d666c417b583d3dba6ee2a92e8f8c97198b7983277da11aa2c501e3f2dd5e7b0"),
  condition: z.literal("A1"),
  plannedIndex: z.literal(0),
  timeBlock: z.literal(0),
  orderInPair: z.literal(0),
}).strict();

const rolePolicySchema = z.object({
  author: z.object({
    model: z.literal("gpt-5.6-terra"),
    reasoningEffort: z.literal("medium"),
    workspace: z.literal("projectless"),
    sharedHistory: z.literal(false),
    repositoryAccess: z.literal(false),
  }).strict(),
  primaryReviewer: z.object({
    model: z.literal("gpt-5.6-sol"),
    reasoningEffort: z.literal("high"),
    workspace: z.literal("projectless"),
    sharedHistory: z.literal(false),
    repositoryAccess: z.literal(false),
  }).strict(),
  adjudicator: z.object({
    model: z.literal("gpt-5.6-sol"),
    reasoningEffort: z.literal("high"),
    workspace: z.literal("projectless"),
    sharedHistory: z.literal(false),
    repositoryAccess: z.literal(false),
  }).strict(),
  pairwiseVisualJudge: z.object({
    model: z.literal("gpt-5.6-sol"),
    reasoningEffort: z.literal("high"),
    workspace: z.literal("projectless"),
    sharedHistory: z.literal(false),
    repositoryAccess: z.literal(false),
  }).strict(),
}).strict();

const ROLE_POLICY = Object.freeze({
  author: Object.freeze({
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    workspace: "projectless",
    sharedHistory: false,
    repositoryAccess: false,
  }),
  primaryReviewer: Object.freeze({
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    workspace: "projectless",
    sharedHistory: false,
    repositoryAccess: false,
  }),
  adjudicator: Object.freeze({
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    workspace: "projectless",
    sharedHistory: false,
    repositoryAccess: false,
  }),
  pairwiseVisualJudge: Object.freeze({
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    workspace: "projectless",
    sharedHistory: false,
    repositoryAccess: false,
  }),
} as const);

type FrozenSchedule = Readonly<{
  manifestId: "exp-0001a-development-execution-v2";
  manifestDigest: string;
  benchmarkBundleDigest: string;
  treatmentDigest: string;
  assignmentCount: 48;
  scheduleDigest: string;
  firstAssignment: z.infer<typeof firstAssignmentSchema>;
}>;

function frozenSchedule(): FrozenSchedule {
  const verification = verifyDevelopmentExecutionManifest(
    developmentManifestJson,
    developmentBenchmarkJson,
  );
  if (!verification.ok) {
    throw new Error(`SUCCESSOR_V3_FROZEN_SCHEDULE_INVALID:${verification.errors.join(",")}`);
  }
  const manifest = verification.manifest;
  const assignments = [...manifest.assignments]
    .sort((left, right) => left.timeBlock - right.timeBlock)
    .flatMap((pair) => [...pair.attempts]
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((attempt) => ({
        assignmentId: `assignment-${attempt.attemptId}`,
        attemptId: attempt.attemptId,
        pairId: pair.pairId,
        taskId: pair.taskId,
        taskDigest: pair.taskDigest,
        condition: attempt.opaqueLabel,
        plannedIndex: pair.timeBlock * 2 + attempt.orderIndex,
        timeBlock: pair.timeBlock,
        orderInPair: attempt.orderIndex,
      })));
  if (manifest.manifestId !== "exp-0001a-development-execution-v2"
      || manifest.attemptCount !== 48 || assignments.length !== 48
      || manifest.treatments.A0 !== manifest.treatments.A1) {
    throw new Error("SUCCESSOR_V3_REQUIRES_UNCHANGED_48_ASSIGNMENT_AA_SCHEDULE");
  }
  const firstAssignment = firstAssignmentSchema.parse(assignments[0]);
  return Object.freeze({
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    benchmarkBundleDigest: manifest.benchmark.bundleDigest,
    treatmentDigest: manifest.treatments.A0,
    assignmentCount: 48,
    scheduleDigest: hashCanonicalJson(assignments),
    firstAssignment: Object.freeze(firstAssignment),
  });
}

type VerifiedQualification = Readonly<{
  envelopeDigest: string;
  resultDigest: string;
  planDigest: string;
  planAuthoritySignatureDigest: string;
  productionBindingDigest: string;
  terminalEvidenceAttestationDigest: string;
  terminalStateDigest: string;
  retainedEvidenceInventoryRoot: string;
  retainedEvidenceFileCount: number;
  completedAt: string;
  signatureDigest: string;
  signatureSignedAt: string;
  decision: "pass" | "fail" | "incomplete";
  aaExecutionStatus: "eligible_for_successor_freeze" | "blocked";
  authorPolicy: Readonly<{ model: string; reasoningEffort: string }>;
  reviewerPolicy: Readonly<{ model: string; reasoningEffort: string }>;
  compatibleTaskIds: readonly string[];
  failedTaskIds: readonly string[];
  incompleteTaskIds: readonly string[];
}>;

type VerifiedBaseline = Readonly<{
  receipt: BaselineFreezeReceiptV2;
  signatureDigest: string;
  signatureSignedAt: string;
  verifiedBytesRoot: string;
}>;

type SuccessorAuthorityAdapters = Readonly<{
  verifyQualification: (input: unknown) => VerifiedQualification;
  verifyBaseline: (input: Exp0001aSuccessorBaselineEvidenceV3) => VerifiedBaseline;
}>;

export type Exp0001aSuccessorBaselineEvidenceV3 = Readonly<{
  receipt: unknown;
  inventory: unknown;
  productionEvidence: unknown;
  artifacts: BaselineV2ArtifactBytes;
}>;

export type Exp0001aSuccessorLaunchEvidenceV3 = Readonly<{
  checkedAt: string;
  signedQualificationResult: unknown;
  baseline: Exp0001aSuccessorBaselineEvidenceV3;
}>;

const PRODUCTION_AUTHORITY_ADAPTERS: SuccessorAuthorityAdapters = Object.freeze({
  verifyQualification: (input) => {
    const envelope = signedQualificationV2ResultEnvelopeSchema.parse(input);
    return Object.freeze({
      envelopeDigest: envelope.envelopeDigest,
      resultDigest: envelope.result.resultDigest,
      planDigest: envelope.result.planDigest,
      planAuthoritySignatureDigest: envelope.result.planAuthoritySignatureDigest,
      productionBindingDigest: envelope.result.productionBindingDigest,
      terminalEvidenceAttestationDigest: envelope.result.terminalEvidenceAttestationDigest,
      terminalStateDigest: envelope.result.terminalStateDigest,
      retainedEvidenceInventoryRoot: envelope.result.retainedEvidenceInventoryRoot,
      retainedEvidenceFileCount: envelope.result.retainedEvidenceFileCount,
      completedAt: envelope.result.completedAt,
      signatureDigest: hashCanonicalJson(envelope.authoritySignature as unknown as JsonValue),
      signatureSignedAt: envelope.authoritySignature.signedAt,
      decision: envelope.result.gateDecision.decision,
      aaExecutionStatus: envelope.result.aaExecutionStatus,
      authorPolicy: Object.freeze({ ...envelope.result.authorPolicy }),
      reviewerPolicy: Object.freeze({ ...envelope.result.reviewerPolicy }),
      compatibleTaskIds: Object.freeze([...envelope.result.gateDecision.compatibleTaskIds]),
      failedTaskIds: Object.freeze([...envelope.result.gateDecision.failedTaskIds]),
      incompleteTaskIds: Object.freeze([...envelope.result.gateDecision.incompleteTaskIds]),
    });
  },
  verifyBaseline: (input) => {
    const verification = verifyBaselineV2ExecutionReady(
      input.receipt,
      input.inventory,
      input.productionEvidence,
      input.artifacts,
    );
    if (!verification.ok) {
      throw new Error(`SUCCESSOR_V3_BASELINE_V2_NOT_EXECUTION_READY:${verification.errors.join("|")}`);
    }
    const signature = baselineFreezeV2AuthoritySignatureSchema.parse(input.artifacts.authoritySignature);
    return Object.freeze({
      receipt: verification.receipt,
      signatureDigest: hashCanonicalJson(signature as unknown as JsonValue),
      signatureSignedAt: signature.signedAt,
      verifiedBytesRoot: hashCanonicalJson(verification.verifiedBytes),
    });
  },
});

const launchGateContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_SUCCESSOR_RUNTIME_V3_VERSION),
  kind: z.literal("exp-0001a-successor-single-assignment-launch-gate"),
  protocolId: z.literal("EXP-0001A"),
  decision: z.literal("allow_exactly_one_fixed_assignment"),
  qualification: z.object({
    schemaVersion: z.literal("exp-0001a-model-role-qualification-signed-result/v2"),
    envelopeDigest: digestSchema,
    resultDigest: digestSchema,
    planDigest: z.literal(EXP0001A_SUCCESSOR_QUALIFICATION_V2_PLAN_DIGEST),
    planAuthoritySignatureDigest: z.literal(EXP0001A_SUCCESSOR_QUALIFICATION_V2_PLAN_SIGNATURE_DIGEST),
    productionBindingDigest: z.literal(EXP0001A_SUCCESSOR_QUALIFICATION_V2_PRODUCTION_BINDING_DIGEST),
    terminalEvidenceAttestationDigest: digestSchema,
    terminalStateDigest: digestSchema,
    retainedEvidenceInventoryRoot: digestSchema,
    retainedEvidenceFileCount: z.number().int().positive(),
    completedAt: timestampSchema,
    authoritySignatureDigest: digestSchema,
    decision: z.literal("pass"),
    aaExecutionStatus: z.literal("eligible_for_successor_freeze"),
    compatibleTaskIds: z.tuple([
      z.literal("dev-architecture-create-checkout"),
      z.literal("dev-architecture-edit-uncertainty"),
      z.literal("dev-drawing-create-wayfinding-icon"),
    ]),
  }).strict(),
  baseline: z.object({
    schemaVersion: z.literal("baseline-freeze/v2"),
    receiptDigest: z.literal(EXP0001A_SUCCESSOR_BASELINE_V2_RECEIPT_DIGEST),
    authoritySignatureDigest: digestSchema,
    verifiedBytesRoot: digestSchema,
    gitCommit: z.literal(EXPECTED_BASELINE_V2_IDENTITY.gitCommit),
    gitTree: z.literal(EXPECTED_BASELINE_V2_IDENTITY.gitTree),
    deploymentId: z.literal(EXPECTED_BASELINE_V2_IDENTITY.deploymentId),
    buildId: z.literal(EXPECTED_BASELINE_V2_IDENTITY.buildId),
    productionUrl: z.literal(EXPECTED_BASELINE_V2_IDENTITY.productionUrl),
    immutableUrl: z.literal(EXPECTED_BASELINE_V2_IDENTITY.immutableUrl),
    publicInventoryDigest: digestSchema,
    publicEvidenceDigest: digestSchema,
  }).strict(),
  schedule: z.object({
    manifestId: z.literal("exp-0001a-development-execution-v2"),
    manifestDigest: digestSchema,
    benchmarkBundleDigest: digestSchema,
    treatmentDigest: digestSchema,
    assignmentCount: z.literal(48),
    scheduleDigest: digestSchema,
    firstAssignment: firstAssignmentSchema,
  }).strict(),
  rolePolicy: rolePolicySchema,
  releasePolicy: z.object({
    authorizedAssignmentIds: z.tuple([z.literal(EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID)]),
    maximumAssignmentReleases: z.literal(1),
    terminalizedAssignmentDoesNotReopenCeiling: z.literal(true),
    restartDoesNotReopenCeiling: z.literal(true),
    releaseRetryPermitted: z.literal(false),
  }).strict(),
  transport: z.object({
    authentication: z.literal("chatgpt_subscription"),
    taskTransport: z.literal("codex_app"),
    usageAccounting: z.literal("subscription_observations_only"),
  }).strict(),
}).strict();

export const exp0001aSuccessorLaunchGateV3Schema = launchGateContentSchema.extend({
  gateDigest: digestSchema,
}).strict().superRefine((gate, context) => {
  const { gateDigest: _gateDigest, ...content } = gate;
  void _gateDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== gate.gateDigest) {
    context.addIssue({ code: "custom", path: ["gateDigest"], message: "Successor launch gate digest is invalid." });
  }
});

const verifiedGateBrand: unique symbol = Symbol("exp0001a-successor-launch-gate-v3");
export type Exp0001aVerifiedSuccessorLaunchGateV3 = z.infer<typeof exp0001aSuccessorLaunchGateV3Schema> & {
  readonly [verifiedGateBrand]: true;
};

function exactQualificationTaskOrder(ids: readonly string[]): boolean {
  return canonicalJson(ids) === canonicalJson([
    "dev-architecture-create-checkout",
    "dev-architecture-edit-uncertainty",
    "dev-drawing-create-wayfinding-icon",
  ]);
}

function verifyWithAuthorities(
  input: Exp0001aSuccessorLaunchEvidenceV3,
  authorities: SuccessorAuthorityAdapters,
): Exp0001aVerifiedSuccessorLaunchGateV3 {
  const checkedAt = timestampSchema.parse(input.checkedAt);
  const qualification = authorities.verifyQualification(input.signedQualificationResult);
  if (qualification.decision !== "pass"
      || qualification.aaExecutionStatus !== "eligible_for_successor_freeze"
      || qualification.planDigest !== EXP0001A_SUCCESSOR_QUALIFICATION_V2_PLAN_DIGEST
      || qualification.planAuthoritySignatureDigest !== EXP0001A_SUCCESSOR_QUALIFICATION_V2_PLAN_SIGNATURE_DIGEST
      || qualification.productionBindingDigest !== EXP0001A_SUCCESSOR_QUALIFICATION_V2_PRODUCTION_BINDING_DIGEST
      || qualification.authorPolicy.model !== "gpt-5.6-terra"
      || qualification.authorPolicy.reasoningEffort !== "medium"
      || qualification.reviewerPolicy.model !== "gpt-5.6-sol"
      || qualification.reviewerPolicy.reasoningEffort !== "high"
      || !exactQualificationTaskOrder(qualification.compatibleTaskIds)
      || qualification.failedTaskIds.length !== 0
      || qualification.incompleteTaskIds.length !== 0) {
    throw new Error("SUCCESSOR_V3_REQUIRES_EXACT_SIGNED_QUALIFICATION_V2_PASS");
  }
  if ([qualification.completedAt, qualification.signatureSignedAt]
    .some((value) => Date.parse(value) > Date.parse(checkedAt))) {
    throw new Error("SUCCESSOR_V3_QUALIFICATION_EVIDENCE_FROM_FUTURE");
  }

  const baseline = authorities.verifyBaseline(input.baseline);
  const receipt = baseline.receipt;
  if (receipt.receiptDigest !== EXP0001A_SUCCESSOR_BASELINE_V2_RECEIPT_DIGEST
      || receipt.product.gitCommit !== EXPECTED_BASELINE_V2_IDENTITY.gitCommit
      || receipt.product.gitTree !== EXPECTED_BASELINE_V2_IDENTITY.gitTree
      || receipt.deployment.deploymentId !== EXPECTED_BASELINE_V2_IDENTITY.deploymentId
      || receipt.deployment.buildId !== EXPECTED_BASELINE_V2_IDENTITY.buildId
      || receipt.deployment.productionUrl !== EXPECTED_BASELINE_V2_IDENTITY.productionUrl
      || receipt.deployment.immutableUrl !== EXPECTED_BASELINE_V2_IDENTITY.immutableUrl) {
    throw new Error("SUCCESSOR_V3_BASELINE_V2_IDENTITY_MISMATCH");
  }
  if (Date.parse(receipt.frozenAt) > Date.parse(checkedAt)
      || Date.parse(baseline.signatureSignedAt) > Date.parse(checkedAt)) {
    throw new Error("SUCCESSOR_V3_BASELINE_EVIDENCE_FROM_FUTURE");
  }

  const schedule = frozenSchedule();
  const content = launchGateContentSchema.parse({
    schemaVersion: EXP0001A_SUCCESSOR_RUNTIME_V3_VERSION,
    kind: "exp-0001a-successor-single-assignment-launch-gate",
    protocolId: "EXP-0001A",
    decision: "allow_exactly_one_fixed_assignment",
    qualification: {
      schemaVersion: "exp-0001a-model-role-qualification-signed-result/v2",
      envelopeDigest: qualification.envelopeDigest,
      resultDigest: qualification.resultDigest,
      planDigest: qualification.planDigest,
      planAuthoritySignatureDigest: qualification.planAuthoritySignatureDigest,
      productionBindingDigest: qualification.productionBindingDigest,
      terminalEvidenceAttestationDigest: qualification.terminalEvidenceAttestationDigest,
      terminalStateDigest: qualification.terminalStateDigest,
      retainedEvidenceInventoryRoot: qualification.retainedEvidenceInventoryRoot,
      retainedEvidenceFileCount: qualification.retainedEvidenceFileCount,
      completedAt: qualification.completedAt,
      authoritySignatureDigest: qualification.signatureDigest,
      decision: "pass",
      aaExecutionStatus: "eligible_for_successor_freeze",
      compatibleTaskIds: qualification.compatibleTaskIds,
    },
    baseline: {
      schemaVersion: "baseline-freeze/v2",
      receiptDigest: receipt.receiptDigest,
      authoritySignatureDigest: baseline.signatureDigest,
      verifiedBytesRoot: baseline.verifiedBytesRoot,
      gitCommit: receipt.product.gitCommit,
      gitTree: receipt.product.gitTree,
      deploymentId: receipt.deployment.deploymentId,
      buildId: receipt.deployment.buildId,
      productionUrl: receipt.deployment.productionUrl,
      immutableUrl: receipt.deployment.immutableUrl,
      publicInventoryDigest: receipt.capture.publicInventory.canonicalDigest,
      publicEvidenceDigest: receipt.capture.publicEvidence.canonicalDigest,
    },
    schedule,
    rolePolicy: ROLE_POLICY,
    releasePolicy: {
      authorizedAssignmentIds: [EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID],
      maximumAssignmentReleases: 1,
      terminalizedAssignmentDoesNotReopenCeiling: true,
      restartDoesNotReopenCeiling: true,
      releaseRetryPermitted: false,
    },
    transport: {
      authentication: "chatgpt_subscription",
      taskTransport: "codex_app",
      usageAccounting: "subscription_observations_only",
    },
  });
  const parsed = exp0001aSuccessorLaunchGateV3Schema.parse({
    ...content,
    gateDigest: hashCanonicalJson(content as unknown as JsonValue),
  });
  Object.defineProperty(parsed, verifiedGateBrand, { value: true, enumerable: false });
  return Object.freeze(parsed) as Exp0001aVerifiedSuccessorLaunchGateV3;
}

/** Production entry point. Both evidence families are verified by their fixed Ed25519 trust anchors. */
export function verifyExp0001aSuccessorLaunchGateV3(
  input: Exp0001aSuccessorLaunchEvidenceV3,
): Exp0001aVerifiedSuccessorLaunchGateV3 {
  return verifyWithAuthorities(input, PRODUCTION_AUTHORITY_ADAPTERS);
}

const releaseAuthorizationContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_SUCCESSOR_RUNTIME_V3_VERSION),
  kind: z.literal("single-assignment-release-authorization"),
  gateDigest: digestSchema,
  assignmentId: z.literal(EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID),
  attemptId: z.literal(EXP0001A_SUCCESSOR_FIRST_ATTEMPT_ID),
  plannedIndex: z.literal(0),
  authorizedAt: timestampSchema,
  predecessorStateDigest: digestSchema,
  promptMayHaveBeenReleased: z.literal(true),
  callerMayInvokeExactlyOnce: z.literal(true),
  retryPermitted: z.literal(false),
}).strict();

const releaseAuthorizationSchema = releaseAuthorizationContentSchema.extend({
  authorizationDigest: digestSchema,
}).strict().superRefine((authorization, context) => {
  const { authorizationDigest: _authorizationDigest, ...content } = authorization;
  void _authorizationDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== authorization.authorizationDigest) {
    context.addIssue({ code: "custom", path: ["authorizationDigest"], message: "Release authorization digest is invalid." });
  }
});

const terminalReceiptContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_SUCCESSOR_RUNTIME_V3_VERSION),
  kind: z.literal("single-assignment-terminal-receipt"),
  assignmentId: z.literal(EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID),
  releaseAuthorizationDigest: digestSchema,
  outcome: z.enum(["succeeded", "failed", "usage_limit_interrupted", "infra_failure"]),
  terminalAt: timestampSchema,
  evidenceDigest: digestSchema,
}).strict();

const terminalReceiptSchema = terminalReceiptContentSchema.extend({
  terminalReceiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { terminalReceiptDigest: _terminalReceiptDigest, ...content } = receipt;
  void _terminalReceiptDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== receipt.terminalReceiptDigest) {
    context.addIssue({ code: "custom", path: ["terminalReceiptDigest"], message: "Terminal receipt digest is invalid." });
  }
});

const releaseStateContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_SUCCESSOR_RELEASE_STATE_V3_VERSION),
  kind: z.literal("exp-0001a-successor-single-assignment-release-state"),
  protocolId: z.literal("EXP-0001A"),
  gateDigest: digestSchema,
  scheduleDigest: digestSchema,
  initializedAt: timestampSchema,
  sequence: z.number().int().min(0).max(3),
  predecessorStateDigest: digestSchema.nullable(),
  phase: z.enum(["ready", "reserved", "released", "permanently_stopped"]),
  assignment: firstAssignmentSchema,
  assignmentReleaseCount: z.union([z.literal(0), z.literal(1)]),
  reservedAt: timestampSchema.nullable(),
  releaseAuthorization: releaseAuthorizationSchema.nullable(),
  terminalReceipt: terminalReceiptSchema.nullable(),
  stopReason: z.literal("single_assignment_ceiling_reached").nullable(),
}).strict();

export const exp0001aSuccessorReleaseStateV3Schema = releaseStateContentSchema.extend({
  stateDigest: digestSchema,
}).strict().superRefine((state, context) => {
  const { stateDigest: _stateDigest, ...content } = state;
  void _stateDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== state.stateDigest) {
    context.addIssue({ code: "custom", path: ["stateDigest"], message: "Release state digest is invalid." });
  }
  const validShape = state.phase === "ready"
    ? state.sequence === 0 && state.predecessorStateDigest === null && state.assignmentReleaseCount === 0
      && state.reservedAt === null && state.releaseAuthorization === null && state.terminalReceipt === null && state.stopReason === null
    : state.phase === "reserved"
      ? state.sequence === 1 && state.predecessorStateDigest !== null && state.assignmentReleaseCount === 0
        && state.reservedAt !== null && state.releaseAuthorization === null && state.terminalReceipt === null && state.stopReason === null
      : state.phase === "released"
        ? state.sequence === 2 && state.predecessorStateDigest !== null && state.assignmentReleaseCount === 1
          && state.reservedAt !== null && state.releaseAuthorization !== null && state.terminalReceipt === null && state.stopReason === null
        : state.sequence === 3 && state.predecessorStateDigest !== null && state.assignmentReleaseCount === 1
          && state.reservedAt !== null && state.releaseAuthorization !== null && state.terminalReceipt !== null
          && state.stopReason === "single_assignment_ceiling_reached";
  if (!validShape) {
    context.addIssue({ code: "custom", message: "Release-state phase shape violates the permanent one-assignment ceiling." });
  }
  if (state.releaseAuthorization !== null
      && (state.releaseAuthorization.gateDigest !== state.gateDigest
        || (state.phase === "released"
          && state.releaseAuthorization.predecessorStateDigest !== state.predecessorStateDigest))) {
    context.addIssue({ code: "custom", path: ["releaseAuthorization"], message: "Release authorization is not bound to this gate and predecessor." });
  }
  if (state.terminalReceipt !== null && state.releaseAuthorization !== null
      && state.terminalReceipt.releaseAuthorizationDigest !== state.releaseAuthorization.authorizationDigest) {
    context.addIssue({ code: "custom", path: ["terminalReceipt"], message: "Terminal receipt is not bound to the only release." });
  }
  if (state.reservedAt !== null && Date.parse(state.reservedAt) < Date.parse(state.initializedAt)) {
    context.addIssue({ code: "custom", path: ["reservedAt"], message: "Reservation cannot predate initialization." });
  }
  if (state.releaseAuthorization !== null && state.reservedAt !== null
      && Date.parse(state.releaseAuthorization.authorizedAt) < Date.parse(state.reservedAt)) {
    context.addIssue({ code: "custom", path: ["releaseAuthorization", "authorizedAt"], message: "Release cannot predate reservation." });
  }
  if (state.terminalReceipt !== null && state.releaseAuthorization !== null
      && Date.parse(state.terminalReceipt.terminalAt) < Date.parse(state.releaseAuthorization.authorizedAt)) {
    context.addIssue({ code: "custom", path: ["terminalReceipt", "terminalAt"], message: "Terminal receipt cannot predate release." });
  }
});

export type Exp0001aSuccessorReleaseStateV3 = z.infer<typeof exp0001aSuccessorReleaseStateV3Schema>;

function assertVerifiedGate(
  gate: Exp0001aVerifiedSuccessorLaunchGateV3,
): Exp0001aVerifiedSuccessorLaunchGateV3 {
  if (gate[verifiedGateBrand] !== true) throw new Error("SUCCESSOR_V3_UNVERIFIED_LAUNCH_GATE");
  exp0001aSuccessorLaunchGateV3Schema.parse(gate);
  return gate;
}

function sealReleaseState(
  content: z.input<typeof releaseStateContentSchema>,
): Exp0001aSuccessorReleaseStateV3 {
  const parsed = releaseStateContentSchema.parse(content);
  return Object.freeze(exp0001aSuccessorReleaseStateV3Schema.parse({
    ...parsed,
    stateDigest: hashCanonicalJson(parsed as unknown as JsonValue),
  }));
}

function releaseStateContent(
  state: Exp0001aSuccessorReleaseStateV3,
): z.output<typeof releaseStateContentSchema> {
  const { stateDigest: _stateDigest, ...content } = state;
  void _stateDigest;
  return releaseStateContentSchema.parse(content);
}

function createInitialReleaseState(
  gate: Exp0001aVerifiedSuccessorLaunchGateV3,
): Exp0001aSuccessorReleaseStateV3 {
  return sealReleaseState({
    schemaVersion: EXP0001A_SUCCESSOR_RELEASE_STATE_V3_VERSION,
    kind: "exp-0001a-successor-single-assignment-release-state",
    protocolId: "EXP-0001A",
    gateDigest: gate.gateDigest,
    scheduleDigest: gate.schedule.scheduleDigest,
    initializedAt: gate.qualification.completedAt,
    sequence: 0,
    predecessorStateDigest: null,
    phase: "ready",
    assignment: gate.schedule.firstAssignment,
    assignmentReleaseCount: 0,
    reservedAt: null,
    releaseAuthorization: null,
    terminalReceipt: null,
    stopReason: null,
  });
}

function verifyStateForGate(
  input: unknown,
  gate: Exp0001aVerifiedSuccessorLaunchGateV3,
): Exp0001aSuccessorReleaseStateV3 {
  const state = exp0001aSuccessorReleaseStateV3Schema.parse(input);
  if (state.gateDigest !== gate.gateDigest
      || state.scheduleDigest !== gate.schedule.scheduleDigest
      || canonicalJson(state.assignment) !== canonicalJson(gate.schedule.firstAssignment)) {
    throw new Error("SUCCESSOR_V3_RELEASE_STATE_GATE_BINDING_INVALID");
  }
  return state;
}

export type Exp0001aSuccessorReleaseActionV3 =
  | Readonly<{ kind: "reserve_first_assignment"; assignmentId: typeof EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID }>
  | Readonly<{ kind: "authorize_first_assignment_release"; assignmentId: typeof EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID }>
  | Readonly<{
      kind: "await_first_assignment_terminal_or_reconciliation";
      assignmentId: typeof EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID;
      releaseAuthorizationDigest: string;
      releaseMayBeReissued: false;
    }>
  | Readonly<{
      kind: "single_assignment_ceiling_reached";
      assignmentId: typeof EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID;
      releaseCount: 1;
      permanentlyStopped: true;
    }>;

export function nextExp0001aSuccessorReleaseActionV3(
  stateInput: unknown,
): Exp0001aSuccessorReleaseActionV3 {
  const state = exp0001aSuccessorReleaseStateV3Schema.parse(stateInput);
  if (state.phase === "ready") {
    return Object.freeze({ kind: "reserve_first_assignment", assignmentId: state.assignment.assignmentId });
  }
  if (state.phase === "reserved") {
    return Object.freeze({ kind: "authorize_first_assignment_release", assignmentId: state.assignment.assignmentId });
  }
  if (state.phase === "released") {
    return Object.freeze({
      kind: "await_first_assignment_terminal_or_reconciliation",
      assignmentId: state.assignment.assignmentId,
      releaseAuthorizationDigest: state.releaseAuthorization!.authorizationDigest,
      releaseMayBeReissued: false,
    });
  }
  return Object.freeze({
    kind: "single_assignment_ceiling_reached",
    assignmentId: state.assignment.assignmentId,
    releaseCount: 1,
    permanentlyStopped: true,
  });
}

export function createExp0001aSuccessorReleaseCoordinatorV3(options: Readonly<{
  filePath: string;
  gate: Exp0001aVerifiedSuccessorLaunchGateV3;
  now?: () => string;
}>) {
  const gate = assertVerifiedGate(options.gate);
  const now = options.now ?? (() => new Date().toISOString());
  const initial = createInitialReleaseState(gate);
  const store = createAtomicRegistryStore<Exp0001aSuccessorReleaseStateV3>({
    filePath: options.filePath,
    validate: (input) => verifyStateForGate(input, gate),
    identity: (state) => state.stateDigest,
    now,
  });

  return Object.freeze({
    initialize: () => store.initialize(initial),
    read: () => store.read(),
    nextAction: async () => nextExp0001aSuccessorReleaseActionV3(await store.read()),
    reserveFirstAssignment: async () => {
      const prior = await store.read();
      if (prior.phase !== "ready") throw new Error("SUCCESSOR_V3_FIRST_ASSIGNMENT_NOT_READY_FOR_RESERVATION");
      const reservedAt = timestampSchema.parse(now());
      const next = sealReleaseState({
        ...releaseStateContent(prior),
        sequence: 1,
        predecessorStateDigest: prior.stateDigest,
        phase: "reserved",
        reservedAt,
      });
      return store.persist(next, prior.stateDigest);
    },
    authorizeReservedFirstAssignmentRelease: async () => {
      const prior = await store.read();
      if (prior.phase !== "reserved") throw new Error("SUCCESSOR_V3_FIRST_ASSIGNMENT_RELEASE_NOT_RESERVED");
      const authorizedAt = timestampSchema.parse(now());
      const authorizationContent = releaseAuthorizationContentSchema.parse({
        schemaVersion: EXP0001A_SUCCESSOR_RUNTIME_V3_VERSION,
        kind: "single-assignment-release-authorization",
        gateDigest: gate.gateDigest,
        assignmentId: prior.assignment.assignmentId,
        attemptId: prior.assignment.attemptId,
        plannedIndex: prior.assignment.plannedIndex,
        authorizedAt,
        predecessorStateDigest: prior.stateDigest,
        promptMayHaveBeenReleased: true,
        callerMayInvokeExactlyOnce: true,
        retryPermitted: false,
      });
      const releaseAuthorization = releaseAuthorizationSchema.parse({
        ...authorizationContent,
        authorizationDigest: hashCanonicalJson(authorizationContent as unknown as JsonValue),
      });
      const next = sealReleaseState({
        ...releaseStateContent(prior),
        sequence: 2,
        predecessorStateDigest: prior.stateDigest,
        phase: "released",
        assignmentReleaseCount: 1,
        releaseAuthorization,
      });
      const state = await store.persist(next, prior.stateDigest);
      return Object.freeze({ state, releaseAuthorization });
    },
    terminalizeFirstAssignment: async (input: Readonly<{
      releaseAuthorizationDigest: string;
      outcome: "succeeded" | "failed" | "usage_limit_interrupted" | "infra_failure";
      evidenceDigest: string;
    }>) => {
      const prior = await store.read();
      if (prior.phase !== "released" || prior.releaseAuthorization === null) {
        throw new Error("SUCCESSOR_V3_FIRST_ASSIGNMENT_NOT_RELEASED");
      }
      if (digestSchema.parse(input.releaseAuthorizationDigest) !== prior.releaseAuthorization.authorizationDigest) {
        throw new Error("SUCCESSOR_V3_TERMINAL_RESULT_RELEASE_BINDING_INVALID");
      }
      const terminalContent = terminalReceiptContentSchema.parse({
        schemaVersion: EXP0001A_SUCCESSOR_RUNTIME_V3_VERSION,
        kind: "single-assignment-terminal-receipt",
        assignmentId: prior.assignment.assignmentId,
        releaseAuthorizationDigest: input.releaseAuthorizationDigest,
        outcome: input.outcome,
        terminalAt: timestampSchema.parse(now()),
        evidenceDigest: digestSchema.parse(input.evidenceDigest),
      });
      const terminalReceipt = terminalReceiptSchema.parse({
        ...terminalContent,
        terminalReceiptDigest: hashCanonicalJson(terminalContent as unknown as JsonValue),
      });
      const next = sealReleaseState({
        ...releaseStateContent(prior),
        sequence: 3,
        predecessorStateDigest: prior.stateDigest,
        phase: "permanently_stopped",
        terminalReceipt,
        stopReason: "single_assignment_ceiling_reached",
      });
      return store.persist(next, prior.stateDigest);
    },
  });
}
