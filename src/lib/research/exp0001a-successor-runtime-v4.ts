import { z } from "zod";

import developmentBenchmarkJson from "../../../research/benchmarks/development-v2.json";
import developmentManifestJson from "../../../research/data/development-execution-manifest-v2.json";
import { createAtomicRegistryStore } from "./atomic-registry-store";
import {
  EXPECTED_BASELINE_V3_IDENTITY,
  baselineFreezeV3AuthoritySignatureSchema,
  verifyBaselineV3ExecutionReady,
  type BaselineV3ArtifactBytes,
} from "./baseline-freeze-v3";
import { verifyDevelopmentExecutionManifest } from "./development-manifest";
import {
  exp0001aQualificationV2AuthoritySignatureSchema,
  verifyExp0001aQualificationV2AuthoritySignature,
} from "./exp0001a-model-role-qualification-v2-authority";
import {
  qualificationV2ProductionBindingSchema,
  signedQualificationV2ResultEnvelopeSchema,
} from "./exp0001a-model-role-qualification-v2-coordinator";
import { qualificationV3ProductionBindingSchema } from "./exp0001a-model-role-qualification-v3-binding";
import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

export const EXP0001A_FULL_RUN_SUCCESSOR_RUNTIME_V4_VERSION =
  "exp-0001a-full-run-successor-runtime/v4" as const;
export const EXP0001A_FULL_RUN_SUCCESSOR_RELEASE_STATE_V4_VERSION =
  "exp-0001a-full-run-successor-release-state/v4" as const;
export const EXP0001A_FULL_RUN_QUALIFICATION_BINDING_V3_DIGEST =
  "sha256:26d644dabf67b8f9d63011fdcd6d1af0c09069e67cb6977f3ac97eaa36f15688" as const;
export const EXP0001A_FULL_RUN_BASELINE_V3_DIGEST =
  "sha256:6b0bfb2e944366f39102409c1d4a1e67cbf505b9f66587e299e6f11642ef661b" as const;
export const EXP0001A_FULL_RUN_QUALIFICATION_PLAN_DIGEST =
  "sha256:e318342431aa10f1813ea7ee9bcdd508f913096a71d0886cebde98212287188b" as const;
export const EXP0001A_FULL_RUN_QUALIFICATION_PLAN_SIGNATURE_DIGEST =
  "sha256:1aa9914f472f5fadd85027d9eb08337279ee67f08183bae93a6b40ffa57f89cb" as const;
export const EXP0001A_FULL_RUN_MANIFEST_DIGEST =
  "sha256:2fa105dae28a74f8e96c38e64b8dd0d1f4a15d177cf6301649e2bd7edc26dbb8" as const;
export const EXP0001A_FULL_RUN_BENCHMARK_BUNDLE_DIGEST =
  "sha256:27afe9d7cb85b6a447c2a1bb1841a0fa9e5119784d7f5fe2e6e30fcc4b3bd8bf" as const;
export const EXP0001A_FULL_RUN_TREATMENT_DIGEST =
  "sha256:72d801277a7ebb1dbe45427a4147b493fa825b34ca84e00a5c5453d3e983fc78" as const;
export const EXP0001A_FULL_RUN_SCHEDULE_DIGEST =
  "sha256:2640bf65f1182faf4c0f90c248275720b181d9faceed1118cc5c4f0bef95ecbd" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const conditionSchema = z.enum(["A0", "A1"]);
const terminalOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "usage_limit_interrupted",
  "infra_failure",
  "policy_violation",
]);

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

const scheduleAssignmentSchema = z.object({
  assignmentId: z.string().regex(/^assignment-attempt-dev-[a-z0-9-]+-r[12]-a[01]$/),
  attemptId: z.string().regex(/^attempt-dev-[a-z0-9-]+-r[12]-a[01]$/),
  pairId: z.string().regex(/^pair-dev-[a-z0-9-]+-r[12]$/),
  taskId: z.string().regex(/^dev-[a-z0-9-]+$/),
  taskDigest: digestSchema,
  condition: conditionSchema,
  plannedIndex: z.number().int().min(0).max(47),
  timeBlock: z.number().int().min(0).max(23),
  orderInPair: z.union([z.literal(0), z.literal(1)]),
}).strict();

type ScheduleAssignment = z.infer<typeof scheduleAssignmentSchema>;

function frozenSchedule() {
  const verification = verifyDevelopmentExecutionManifest(
    developmentManifestJson,
    developmentBenchmarkJson,
  );
  if (!verification.ok) {
    throw new Error(`SUCCESSOR_V4_FROZEN_SCHEDULE_INVALID:${verification.errors.join(",")}`);
  }
  const manifest = verification.manifest;
  const assignments = manifest.assignments
    .flatMap((pair) => pair.attempts.map((attempt) => ({
      assignmentId: `assignment-${attempt.attemptId}`,
      attemptId: attempt.attemptId,
      pairId: pair.pairId,
      taskId: pair.taskId,
      taskDigest: pair.taskDigest,
      condition: attempt.opaqueLabel,
      plannedIndex: pair.timeBlock * 2 + attempt.orderIndex,
      timeBlock: pair.timeBlock,
      orderInPair: attempt.orderIndex,
    })))
    .sort((left, right) => left.plannedIndex - right.plannedIndex)
    .map((assignment) => Object.freeze(scheduleAssignmentSchema.parse(assignment)));
  if (manifest.manifestId !== "exp-0001a-development-execution-v2"
      || manifest.manifestDigest !== EXP0001A_FULL_RUN_MANIFEST_DIGEST
      || manifest.benchmark.bundleDigest !== EXP0001A_FULL_RUN_BENCHMARK_BUNDLE_DIGEST
      || manifest.treatments.A0 !== EXP0001A_FULL_RUN_TREATMENT_DIGEST
      || manifest.attemptCount !== 48
      || assignments.length !== 48
      || assignments.some((assignment, index) => assignment.plannedIndex !== index)
      || manifest.treatments.A0 !== manifest.treatments.A1
      || hashCanonicalJson(assignments as unknown as JsonValue)
        !== EXP0001A_FULL_RUN_SCHEDULE_DIGEST) {
    throw new Error("SUCCESSOR_V4_REQUIRES_UNCHANGED_48_ASSIGNMENT_AA_SCHEDULE");
  }
  let balance = 0;
  for (const assignment of assignments) {
    balance += assignment.condition === "A1" ? 1 : -1;
    if (Math.abs(balance) > 1) {
      throw new Error("SUCCESSOR_V4_SCHEDULE_PREFIX_BALANCE_INVALID");
    }
  }
  if (balance !== 0) throw new Error("SUCCESSOR_V4_SCHEDULE_FINAL_BALANCE_INVALID");
  return Object.freeze({
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    benchmarkBundleDigest: manifest.benchmark.bundleDigest,
    frozenTreatmentDigest: manifest.treatments.A0,
    assignmentCount: 48 as const,
    scheduleDigest: hashCanonicalJson(assignments as unknown as JsonValue),
    assignments: Object.freeze(assignments),
  });
}

const launchGateContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_FULL_RUN_SUCCESSOR_RUNTIME_V4_VERSION),
  kind: z.literal("exp-0001a-full-run-successor-launch-gate"),
  protocolId: z.literal("EXP-0001A"),
  decision: z.literal("allow_full_48_sequential_assignments"),
  checkedAt: timestampSchema,
  qualification: z.object({
    schemaVersion: z.literal("exp-0001a-model-role-qualification-signed-result/v2"),
    envelopeDigest: digestSchema,
    resultDigest: digestSchema,
    planDigest: z.literal(EXP0001A_FULL_RUN_QUALIFICATION_PLAN_DIGEST),
    planAuthoritySignatureDigest: z.literal(
      EXP0001A_FULL_RUN_QUALIFICATION_PLAN_SIGNATURE_DIGEST,
    ),
    productionBindingDigest: z.literal(EXP0001A_FULL_RUN_QUALIFICATION_BINDING_V3_DIGEST),
    terminalEvidenceAttestationDigest: digestSchema,
    terminalStateDigest: digestSchema,
    retainedEvidenceInventoryRoot: digestSchema,
    retainedEvidenceFileCount: z.number().int().positive(),
    completedAt: timestampSchema,
    authoritySignatureDigest: digestSchema,
    authoritySignedAt: timestampSchema,
    decision: z.literal("pass"),
    aaExecutionStatus: z.literal("eligible_for_successor_freeze"),
    compatibleTaskIds: z.tuple([
      z.literal("dev-architecture-create-checkout"),
      z.literal("dev-architecture-edit-uncertainty"),
      z.literal("dev-drawing-create-wayfinding-icon"),
    ]),
  }).strict(),
  production: z.object({
    bindingSchemaVersion: z.literal("exp-0001a-qualification-production-binding/v3"),
    bindingDigest: z.literal(EXP0001A_FULL_RUN_QUALIFICATION_BINDING_V3_DIGEST),
    bindingAuthoritySignatureDigest: digestSchema,
    predecessorBindingDigest: digestSchema,
    predecessorBindingAuthoritySignatureDigest: digestSchema,
    baselineSchemaVersion: z.literal("baseline-freeze/v3"),
    baselineDigest: z.literal(EXP0001A_FULL_RUN_BASELINE_V3_DIGEST),
    baselineAuthoritySignatureDigest: digestSchema,
    baselineVerifiedBytesRoot: digestSchema,
    gitCommit: z.literal(EXPECTED_BASELINE_V3_IDENTITY.gitCommit),
    gitTree: z.literal(EXPECTED_BASELINE_V3_IDENTITY.gitTree),
    deploymentId: z.literal(EXPECTED_BASELINE_V3_IDENTITY.deploymentId),
    buildId: z.literal(EXPECTED_BASELINE_V3_IDENTITY.buildId),
    productionUrl: z.literal(EXPECTED_BASELINE_V3_IDENTITY.productionUrl),
    immutableUrl: z.literal(EXPECTED_BASELINE_V3_IDENTITY.immutableUrl),
    toolContractDigests: z.object({
      landing: digestSchema,
      participant: digestSchema,
      spectator: digestSchema,
    }).strict(),
  }).strict(),
  schedule: z.object({
    manifestId: z.literal("exp-0001a-development-execution-v2"),
    manifestDigest: z.literal(EXP0001A_FULL_RUN_MANIFEST_DIGEST),
    benchmarkBundleDigest: z.literal(EXP0001A_FULL_RUN_BENCHMARK_BUNDLE_DIGEST),
    frozenTreatmentDigest: z.literal(EXP0001A_FULL_RUN_TREATMENT_DIGEST),
    assignmentCount: z.literal(48),
    scheduleDigest: z.literal(EXP0001A_FULL_RUN_SCHEDULE_DIGEST),
    assignments: z.array(scheduleAssignmentSchema).length(48),
  }).strict(),
  conditions: z.object({
    A0: z.literal(EXP0001A_FULL_RUN_QUALIFICATION_BINDING_V3_DIGEST),
    A1: z.literal(EXP0001A_FULL_RUN_QUALIFICATION_BINDING_V3_DIGEST),
    byteEquivalent: z.literal(true),
  }).strict(),
  rolePolicy: rolePolicySchema,
  releasePolicy: z.object({
    assignmentReleaseCeiling: z.literal(48),
    sequentialManifestOrderRequired: z.literal(true),
    persistBeforeHandoff: z.literal(true),
    exactlyOncePerAssignment: z.literal(true),
    releaseRetryPermitted: z.literal(false),
    begunAttemptsPreserved: z.literal(true),
    usageLimitStopsBeforeNextBrief: z.literal(true),
    usageLimitResumeSameUnstartedAssignment: z.literal(true),
    maximumPrefixConditionImbalance: z.literal(1),
  }).strict(),
  transport: z.object({
    authentication: z.literal("chatgpt_subscription"),
    taskTransport: z.literal("codex_app"),
    usageAccounting: z.literal("subscription_observations_only"),
  }).strict(),
}).strict();

export const exp0001aFullRunSuccessorLaunchGateV4Schema = launchGateContentSchema.extend({
  gateDigest: digestSchema,
}).strict().superRefine((gate, context) => {
  const { gateDigest: _gateDigest, ...content } = gate;
  void _gateDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== gate.gateDigest) {
    context.addIssue({ code: "custom", path: ["gateDigest"], message: "Full-run launch gate digest is invalid." });
  }
  if (hashCanonicalJson(gate.schedule.assignments as unknown as JsonValue) !== gate.schedule.scheduleDigest) {
    context.addIssue({ code: "custom", path: ["schedule", "scheduleDigest"], message: "Full-run schedule digest is invalid." });
  }
});

const verifiedGateBrand: unique symbol = Symbol("exp0001a-full-run-successor-launch-gate-v4");
export type Exp0001aVerifiedFullRunSuccessorLaunchGateV4 =
  z.infer<typeof exp0001aFullRunSuccessorLaunchGateV4Schema> & { readonly [verifiedGateBrand]: true };

export type Exp0001aFullRunSuccessorBaselineEvidenceV4 = Readonly<{
  receipt: unknown;
  inventory: unknown;
  productionEvidence: unknown;
  artifacts: BaselineV3ArtifactBytes;
}>;

export type Exp0001aFullRunSuccessorLaunchEvidenceV4 = Readonly<{
  checkedAt: string;
  signedQualificationResult: unknown;
  productionBinding: unknown;
  productionBindingAuthoritySignature: unknown;
  predecessorProductionBinding: unknown;
  predecessorProductionBindingAuthoritySignature: unknown;
  baseline: Exp0001aFullRunSuccessorBaselineEvidenceV4;
}>;

function exactQualificationTaskOrder(ids: readonly string[]) {
  return canonicalJson(ids) === canonicalJson([
    "dev-architecture-create-checkout",
    "dev-architecture-edit-uncertainty",
    "dev-drawing-create-wayfinding-icon",
  ]);
}

export function verifyExp0001aFullRunSuccessorLaunchGateV4(
  input: Exp0001aFullRunSuccessorLaunchEvidenceV4,
): Exp0001aVerifiedFullRunSuccessorLaunchGateV4 {
  const checkedAt = timestampSchema.parse(input.checkedAt);
  const qualification = signedQualificationV2ResultEnvelopeSchema.parse(input.signedQualificationResult);
  const binding = qualificationV3ProductionBindingSchema.parse(input.productionBinding);
  const bindingSignature = exp0001aQualificationV2AuthoritySignatureSchema.parse(
    input.productionBindingAuthoritySignature,
  );
  const predecessorBinding = qualificationV2ProductionBindingSchema.parse(
    input.predecessorProductionBinding,
  );
  const predecessorBindingSignature = exp0001aQualificationV2AuthoritySignatureSchema.parse(
    input.predecessorProductionBindingAuthoritySignature,
  );
  verifyExp0001aQualificationV2AuthoritySignature({
    payload: predecessorBinding as unknown as JsonValue,
    signature: predecessorBindingSignature,
    purpose: "qualification_launch_binding",
    notBefore: predecessorBinding.verifiedAt,
  });
  verifyExp0001aQualificationV2AuthoritySignature({
    payload: binding as unknown as JsonValue,
    signature: bindingSignature,
    purpose: "qualification_launch_binding",
    notBefore: binding.verifiedAt,
  });

  if (binding.bindingDigest !== EXP0001A_FULL_RUN_QUALIFICATION_BINDING_V3_DIGEST
      || qualification.result.productionBindingDigest !== binding.bindingDigest
      || qualification.result.planDigest !== EXP0001A_FULL_RUN_QUALIFICATION_PLAN_DIGEST
      || qualification.result.planAuthoritySignatureDigest
        !== EXP0001A_FULL_RUN_QUALIFICATION_PLAN_SIGNATURE_DIGEST
      || binding.planDigest !== qualification.result.planDigest
      || predecessorBinding.planDigest !== qualification.result.planDigest
      || binding.predecessorProductionBinding.bindingDigest !== predecessorBinding.bindingDigest
      || binding.predecessorProductionBinding.authoritySignatureDigest
        !== hashCanonicalJson(predecessorBindingSignature as unknown as JsonValue)
      || binding.baselineFreezeDigest !== EXP0001A_FULL_RUN_BASELINE_V3_DIGEST
      || qualification.result.gateDecision.decision !== "pass"
      || qualification.result.aaExecutionStatus !== "eligible_for_successor_freeze"
      || qualification.result.authorPolicy.model !== "gpt-5.6-terra"
      || qualification.result.authorPolicy.reasoningEffort !== "medium"
      || qualification.result.reviewerPolicy.model !== "gpt-5.6-sol"
      || qualification.result.reviewerPolicy.reasoningEffort !== "high"
      || !exactQualificationTaskOrder(qualification.result.gateDecision.compatibleTaskIds)
      || qualification.result.gateDecision.failedTaskIds.length !== 0
      || qualification.result.gateDecision.incompleteTaskIds.length !== 0) {
    throw new Error("SUCCESSOR_V4_REQUIRES_EXACT_SIGNED_QUALIFICATION_V2_PASS");
  }

  const baseline = verifyBaselineV3ExecutionReady(
    input.baseline.receipt,
    input.baseline.inventory,
    input.baseline.productionEvidence,
    input.baseline.artifacts,
  );
  if (!baseline.ok) {
    throw new Error(`SUCCESSOR_V4_BASELINE_V3_NOT_EXECUTION_READY:${baseline.errors.join("|")}`);
  }
  const baselineSignature = baselineFreezeV3AuthoritySignatureSchema.parse(
    input.baseline.artifacts.authoritySignature,
  );
  const receipt = baseline.receipt;
  const inventory = baseline.inventory;
  const baselineVerifiedBytesRoot = hashCanonicalJson(baseline.verifiedBytes as unknown as JsonValue);
  if (receipt.receiptDigest !== EXP0001A_FULL_RUN_BASELINE_V3_DIGEST
      || binding.baselineFreezeDigest !== receipt.receiptDigest
      || binding.baselineAuthoritySignatureDigest
        !== hashCanonicalJson(baselineSignature as unknown as JsonValue)
      || receipt.product.gitCommit !== EXPECTED_BASELINE_V3_IDENTITY.gitCommit
      || receipt.product.gitTree !== EXPECTED_BASELINE_V3_IDENTITY.gitTree
      || receipt.deployment.deploymentId !== EXPECTED_BASELINE_V3_IDENTITY.deploymentId
      || receipt.deployment.buildId !== EXPECTED_BASELINE_V3_IDENTITY.buildId
      || receipt.deployment.productionUrl !== EXPECTED_BASELINE_V3_IDENTITY.productionUrl
      || receipt.deployment.immutableUrl !== EXPECTED_BASELINE_V3_IDENTITY.immutableUrl
      || binding.toolContractDigests.landing !== inventory.landing.contractDigest
      || binding.toolContractDigests.participant !== inventory.participant.contractDigest
      || binding.toolContractDigests.spectator !== inventory.spectator.contractDigest) {
    throw new Error("SUCCESSOR_V4_PRODUCTION_BINDING_BASELINE_V3_MISMATCH");
  }

  const futureEvidence = [
    qualification.result.completedAt,
    qualification.authoritySignature.signedAt,
    predecessorBinding.verifiedAt,
    predecessorBindingSignature.signedAt,
    receipt.frozenAt,
    baselineSignature.signedAt,
    binding.verifiedAt,
    bindingSignature.signedAt,
  ].some((value) => Date.parse(value) > Date.parse(checkedAt));
  if (futureEvidence) throw new Error("SUCCESSOR_V4_AUTHORITY_EVIDENCE_FROM_FUTURE");

  const schedule = frozenSchedule();
  const content = launchGateContentSchema.parse({
    schemaVersion: EXP0001A_FULL_RUN_SUCCESSOR_RUNTIME_V4_VERSION,
    kind: "exp-0001a-full-run-successor-launch-gate",
    protocolId: "EXP-0001A",
    decision: "allow_full_48_sequential_assignments",
    checkedAt,
    qualification: {
      schemaVersion: qualification.schemaVersion,
      envelopeDigest: qualification.envelopeDigest,
      resultDigest: qualification.result.resultDigest,
      planDigest: qualification.result.planDigest,
      planAuthoritySignatureDigest: qualification.result.planAuthoritySignatureDigest,
      productionBindingDigest: qualification.result.productionBindingDigest,
      terminalEvidenceAttestationDigest: qualification.result.terminalEvidenceAttestationDigest,
      terminalStateDigest: qualification.result.terminalStateDigest,
      retainedEvidenceInventoryRoot: qualification.result.retainedEvidenceInventoryRoot,
      retainedEvidenceFileCount: qualification.result.retainedEvidenceFileCount,
      completedAt: qualification.result.completedAt,
      authoritySignatureDigest: hashCanonicalJson(qualification.authoritySignature as unknown as JsonValue),
      authoritySignedAt: qualification.authoritySignature.signedAt,
      decision: "pass",
      aaExecutionStatus: "eligible_for_successor_freeze",
      compatibleTaskIds: qualification.result.gateDecision.compatibleTaskIds,
    },
    production: {
      bindingSchemaVersion: binding.schemaVersion,
      bindingDigest: binding.bindingDigest,
      bindingAuthoritySignatureDigest: hashCanonicalJson(bindingSignature as unknown as JsonValue),
      predecessorBindingDigest: predecessorBinding.bindingDigest,
      predecessorBindingAuthoritySignatureDigest: hashCanonicalJson(predecessorBindingSignature as unknown as JsonValue),
      baselineSchemaVersion: receipt.schemaVersion,
      baselineDigest: receipt.receiptDigest,
      baselineAuthoritySignatureDigest: hashCanonicalJson(baselineSignature as unknown as JsonValue),
      baselineVerifiedBytesRoot,
      gitCommit: receipt.product.gitCommit,
      gitTree: receipt.product.gitTree,
      deploymentId: receipt.deployment.deploymentId,
      buildId: receipt.deployment.buildId,
      productionUrl: receipt.deployment.productionUrl,
      immutableUrl: receipt.deployment.immutableUrl,
      toolContractDigests: binding.toolContractDigests,
    },
    schedule,
    conditions: {
      A0: binding.bindingDigest,
      A1: binding.bindingDigest,
      byteEquivalent: true,
    },
    rolePolicy: ROLE_POLICY,
    releasePolicy: {
      assignmentReleaseCeiling: 48,
      sequentialManifestOrderRequired: true,
      persistBeforeHandoff: true,
      exactlyOncePerAssignment: true,
      releaseRetryPermitted: false,
      begunAttemptsPreserved: true,
      usageLimitStopsBeforeNextBrief: true,
      usageLimitResumeSameUnstartedAssignment: true,
      maximumPrefixConditionImbalance: 1,
    },
    transport: {
      authentication: "chatgpt_subscription",
      taskTransport: "codex_app",
      usageAccounting: "subscription_observations_only",
    },
  });
  const gate = exp0001aFullRunSuccessorLaunchGateV4Schema.parse({
    ...content,
    gateDigest: hashCanonicalJson(content as unknown as JsonValue),
  });
  Object.defineProperty(gate, verifiedGateBrand, { value: true, enumerable: false });
  return Object.freeze(gate) as Exp0001aVerifiedFullRunSuccessorLaunchGateV4;
}

const releaseAuthorizationContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_FULL_RUN_SUCCESSOR_RUNTIME_V4_VERSION),
  kind: z.literal("full-run-assignment-release-authorization"),
  gateDigest: digestSchema,
  scheduleDigest: digestSchema,
  assignmentId: z.string().min(1),
  attemptId: z.string().min(1),
  plannedIndex: z.number().int().min(0).max(47),
  condition: conditionSchema,
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
  schemaVersion: z.literal(EXP0001A_FULL_RUN_SUCCESSOR_RUNTIME_V4_VERSION),
  kind: z.literal("full-run-assignment-terminal-receipt"),
  assignmentId: z.string().min(1),
  releaseAuthorizationDigest: digestSchema,
  outcome: terminalOutcomeSchema,
  terminalAt: timestampSchema,
  evidenceDigest: digestSchema,
  usageLimitObservationDigest: digestSchema.nullable(),
}).strict().superRefine((receipt, context) => {
  if ((receipt.outcome === "usage_limit_interrupted")
      !== (receipt.usageLimitObservationDigest !== null)) {
    context.addIssue({
      code: "custom",
      path: ["usageLimitObservationDigest"],
      message: "Only a usage-limit terminal outcome may retain a usage-limit observation.",
    });
  }
});

const terminalReceiptSchema = terminalReceiptContentSchema.extend({
  terminalReceiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { terminalReceiptDigest: _terminalReceiptDigest, ...content } = receipt;
  void _terminalReceiptDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== receipt.terminalReceiptDigest) {
    context.addIssue({ code: "custom", path: ["terminalReceiptDigest"], message: "Terminal receipt digest is invalid." });
  }
});

const assignmentReleaseRecordSchema = z.object({
  assignment: scheduleAssignmentSchema,
  status: z.enum(["unreleased", "reserved", "released", "terminal"]),
  reservedAt: timestampSchema.nullable(),
  releaseAuthorization: releaseAuthorizationSchema.nullable(),
  terminalReceipt: terminalReceiptSchema.nullable(),
}).strict();

const usageLimitWindowContentSchema = z.object({
  ordinal: z.number().int().positive(),
  openedAt: timestampSchema,
  observationDigest: digestSchema,
  assignmentIndex: z.number().int().min(0).max(48),
  releasedConditionCounts: z.object({ A0: z.number().int().nonnegative(), A1: z.number().int().nonnegative() }).strict(),
  closedAt: timestampSchema.nullable(),
  resumeObservationDigest: digestSchema.nullable(),
}).strict();

const usageLimitWindowSchema = usageLimitWindowContentSchema.extend({
  windowDigest: digestSchema,
}).strict().superRefine((window, context) => {
  const { windowDigest: _windowDigest, ...content } = window;
  void _windowDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== window.windowDigest) {
    context.addIssue({ code: "custom", path: ["windowDigest"], message: "Usage-limit window digest is invalid." });
  }
  if ((window.closedAt === null) !== (window.resumeObservationDigest === null)) {
    context.addIssue({ code: "custom", message: "Usage-limit close time and observation must appear together." });
  }
  if (window.closedAt !== null && Date.parse(window.closedAt) < Date.parse(window.openedAt)) {
    context.addIssue({ code: "custom", path: ["closedAt"], message: "Usage-limit window closes before it opens." });
  }
});

const releaseStateContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_FULL_RUN_SUCCESSOR_RELEASE_STATE_V4_VERSION),
  kind: z.literal("exp-0001a-full-run-successor-release-state"),
  protocolId: z.literal("EXP-0001A"),
  gateDigest: digestSchema,
  scheduleDigest: digestSchema,
  initializedAt: timestampSchema,
  updatedAt: timestampSchema,
  sequence: z.number().int().nonnegative(),
  predecessorStateDigest: digestSchema.nullable(),
  phase: z.enum(["running", "paused_for_usage_limit", "complete"]),
  currentAssignmentIndex: z.number().int().min(0).max(48),
  assignmentReleaseCount: z.number().int().min(0).max(48),
  terminalAssignmentCount: z.number().int().min(0).max(48),
  releasedConditionCounts: z.object({ A0: z.number().int().min(0).max(24), A1: z.number().int().min(0).max(24) }).strict(),
  assignments: z.array(assignmentReleaseRecordSchema).length(48),
  activeUsageLimitWindow: usageLimitWindowSchema.nullable(),
  completedUsageLimitWindows: z.array(usageLimitWindowSchema).max(100),
}).strict();

export const exp0001aFullRunSuccessorReleaseStateV4Schema = releaseStateContentSchema.extend({
  stateDigest: digestSchema,
}).strict().superRefine((state, context) => {
  const { stateDigest: _stateDigest, ...content } = state;
  void _stateDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== state.stateDigest) {
    context.addIssue({ code: "custom", path: ["stateDigest"], message: "Release state digest is invalid." });
  }
  if ((state.phase === "paused_for_usage_limit") !== (state.activeUsageLimitWindow !== null)
      || ((state.phase === "complete") !== (state.currentAssignmentIndex === 48))) {
    context.addIssue({ code: "custom", path: ["phase"], message: "Release state phase is inconsistent." });
  }
  if ((state.sequence === 0) !== (state.predecessorStateDigest === null)
      || Date.parse(state.updatedAt) < Date.parse(state.initializedAt)) {
    context.addIssue({ code: "custom", path: ["sequence"], message: "Release state chain metadata is inconsistent." });
  }
  if (state.completedUsageLimitWindows.some((window) => window.closedAt === null)
      || state.completedUsageLimitWindows.some((window, index) => window.ordinal !== index + 1)
      || (state.activeUsageLimitWindow !== null
        && (state.activeUsageLimitWindow.closedAt !== null
          || state.activeUsageLimitWindow.ordinal !== state.completedUsageLimitWindows.length + 1))) {
    context.addIssue({ code: "custom", path: ["completedUsageLimitWindows"], message: "Usage-limit window history is invalid." });
  }

  const firstNonterminal = state.assignments.findIndex((record) => record.status !== "terminal");
  const expectedCurrent = firstNonterminal === -1 ? 48 : firstNonterminal;
  const releasedRecords = state.assignments.filter((record) => ["released", "terminal"].includes(record.status));
  const terminalRecords = state.assignments.filter((record) => record.status === "terminal");
  const counts = releasedRecords.reduce((value, record) => ({
    ...value,
    [record.assignment.condition]: value[record.assignment.condition] + 1,
  }), { A0: 0, A1: 0 });
  if (state.currentAssignmentIndex !== expectedCurrent
      || state.assignmentReleaseCount !== releasedRecords.length
      || state.terminalAssignmentCount !== terminalRecords.length
      || canonicalJson(counts) !== canonicalJson(state.releasedConditionCounts)) {
    context.addIssue({ code: "custom", path: ["assignments"], message: "Assignment counters are not derived from the retained records." });
  }
  if (Math.abs(counts.A0 - counts.A1) > 1) {
    context.addIssue({ code: "custom", path: ["releasedConditionCounts"], message: "Released prefix is not condition balanced." });
  }
  for (let index = 0; index < state.assignments.length; index += 1) {
    const record = state.assignments[index]!;
    const expectedStatusRegion = index < expectedCurrent ? "terminal" : index > expectedCurrent ? "unreleased" : null;
    if (expectedStatusRegion !== null && record.status !== expectedStatusRegion) {
      context.addIssue({ code: "custom", path: ["assignments", index, "status"], message: "Assignments must advance strictly in manifest order." });
    }
    const validShape = record.status === "unreleased"
      ? record.reservedAt === null && record.releaseAuthorization === null && record.terminalReceipt === null
      : record.status === "reserved"
        ? record.reservedAt !== null && record.releaseAuthorization === null && record.terminalReceipt === null
        : record.status === "released"
          ? record.reservedAt !== null && record.releaseAuthorization !== null && record.terminalReceipt === null
          : record.reservedAt !== null && record.releaseAuthorization !== null && record.terminalReceipt !== null;
    if (!validShape) {
      context.addIssue({ code: "custom", path: ["assignments", index], message: "Assignment release record shape is invalid." });
      continue;
    }
    if (record.releaseAuthorization !== null
        && (record.releaseAuthorization.gateDigest !== state.gateDigest
          || record.releaseAuthorization.scheduleDigest !== state.scheduleDigest
          || record.releaseAuthorization.assignmentId !== record.assignment.assignmentId
          || record.releaseAuthorization.attemptId !== record.assignment.attemptId
          || record.releaseAuthorization.plannedIndex !== record.assignment.plannedIndex
          || record.releaseAuthorization.condition !== record.assignment.condition)) {
      context.addIssue({ code: "custom", path: ["assignments", index, "releaseAuthorization"], message: "Release authorization is not bound to its assignment." });
    }
    if ((record.reservedAt !== null && Date.parse(record.reservedAt) < Date.parse(state.initializedAt))
        || (record.releaseAuthorization !== null && record.reservedAt !== null
          && Date.parse(record.releaseAuthorization.authorizedAt) < Date.parse(record.reservedAt))
        || (record.terminalReceipt !== null && record.releaseAuthorization !== null
          && Date.parse(record.terminalReceipt.terminalAt)
            < Date.parse(record.releaseAuthorization.authorizedAt))) {
      context.addIssue({ code: "custom", path: ["assignments", index], message: "Assignment lifecycle timestamps are not monotonic." });
    }
    if (record.terminalReceipt !== null && record.releaseAuthorization !== null
        && (record.terminalReceipt.assignmentId !== record.assignment.assignmentId
          || record.terminalReceipt.releaseAuthorizationDigest !== record.releaseAuthorization.authorizationDigest)) {
      context.addIssue({ code: "custom", path: ["assignments", index, "terminalReceipt"], message: "Terminal receipt is not bound to its only release." });
    }
  }
});

export type Exp0001aFullRunSuccessorReleaseStateV4 = z.infer<
  typeof exp0001aFullRunSuccessorReleaseStateV4Schema
>;

function assertVerifiedGate(
  gate: Exp0001aVerifiedFullRunSuccessorLaunchGateV4,
): Exp0001aVerifiedFullRunSuccessorLaunchGateV4 {
  if (gate[verifiedGateBrand] !== true) throw new Error("SUCCESSOR_V4_UNVERIFIED_LAUNCH_GATE");
  exp0001aFullRunSuccessorLaunchGateV4Schema.parse(gate);
  return gate;
}

function sealReleaseState(
  contentInput: z.input<typeof releaseStateContentSchema>,
): Exp0001aFullRunSuccessorReleaseStateV4 {
  const content = releaseStateContentSchema.parse(contentInput);
  return Object.freeze(exp0001aFullRunSuccessorReleaseStateV4Schema.parse({
    ...content,
    stateDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

function releaseStateContent(state: Exp0001aFullRunSuccessorReleaseStateV4) {
  const { stateDigest: _stateDigest, ...content } = state;
  void _stateDigest;
  return releaseStateContentSchema.parse(content);
}

function assignmentCounters(assignments: readonly z.infer<typeof assignmentReleaseRecordSchema>[]) {
  const released = assignments.filter((record) => ["released", "terminal"].includes(record.status));
  return {
    assignmentReleaseCount: released.length,
    terminalAssignmentCount: assignments.filter((record) => record.status === "terminal").length,
    releasedConditionCounts: released.reduce((value, record) => ({
      ...value,
      [record.assignment.condition]: value[record.assignment.condition] + 1,
    }), { A0: 0, A1: 0 }),
  };
}

function initialState(gate: Exp0001aVerifiedFullRunSuccessorLaunchGateV4) {
  return sealReleaseState({
    schemaVersion: EXP0001A_FULL_RUN_SUCCESSOR_RELEASE_STATE_V4_VERSION,
    kind: "exp-0001a-full-run-successor-release-state",
    protocolId: "EXP-0001A",
    gateDigest: gate.gateDigest,
    scheduleDigest: gate.schedule.scheduleDigest,
    initializedAt: gate.checkedAt,
    updatedAt: gate.checkedAt,
    sequence: 0,
    predecessorStateDigest: null,
    phase: "running",
    currentAssignmentIndex: 0,
    assignmentReleaseCount: 0,
    terminalAssignmentCount: 0,
    releasedConditionCounts: { A0: 0, A1: 0 },
    assignments: gate.schedule.assignments.map((assignment) => ({
      assignment,
      status: "unreleased" as const,
      reservedAt: null,
      releaseAuthorization: null,
      terminalReceipt: null,
    })),
    activeUsageLimitWindow: null,
    completedUsageLimitWindows: [],
  });
}

function verifyStateForGate(
  input: unknown,
  gate: Exp0001aVerifiedFullRunSuccessorLaunchGateV4,
) {
  const state = exp0001aFullRunSuccessorReleaseStateV4Schema.parse(input);
  if (state.gateDigest !== gate.gateDigest
      || state.scheduleDigest !== gate.schedule.scheduleDigest
      || canonicalJson(state.assignments.map((record) => record.assignment))
        !== canonicalJson(gate.schedule.assignments)) {
    throw new Error("SUCCESSOR_V4_RELEASE_STATE_GATE_BINDING_INVALID");
  }
  return state;
}

export type Exp0001aFullRunSuccessorReleaseActionV4 =
  | Readonly<{ kind: "reserve_next_assignment"; assignment: ScheduleAssignment }>
  | Readonly<{ kind: "authorize_reserved_assignment_release"; assignment: ScheduleAssignment }>
  | Readonly<{
      kind: "await_assignment_terminal_or_reconciliation";
      assignment: ScheduleAssignment;
      releaseAuthorizationDigest: string;
      releaseMayBeReissued: false;
    }>
  | Readonly<{
      kind: "paused_for_usage_limit";
      assignment: ScheduleAssignment | null;
      usageLimitWindowDigest: string;
      releasePermitted: false;
    }>
  | Readonly<{ kind: "all_48_assignments_terminal"; releaseCount: 48; terminalCount: 48 }>;

export function nextExp0001aFullRunSuccessorReleaseActionV4(
  stateInput: unknown,
): Exp0001aFullRunSuccessorReleaseActionV4 {
  const state = exp0001aFullRunSuccessorReleaseStateV4Schema.parse(stateInput);
  if (state.phase === "complete") {
    return Object.freeze({ kind: "all_48_assignments_terminal", releaseCount: 48, terminalCount: 48 });
  }
  const record = state.assignments[state.currentAssignmentIndex] ?? null;
  if (state.phase === "paused_for_usage_limit") {
    return Object.freeze({
      kind: "paused_for_usage_limit",
      assignment: record?.assignment ?? null,
      usageLimitWindowDigest: state.activeUsageLimitWindow!.windowDigest,
      releasePermitted: false,
    });
  }
  if (record === null) throw new Error("SUCCESSOR_V4_RUNNING_STATE_MISSING_ASSIGNMENT");
  if (record.status === "unreleased") return Object.freeze({ kind: "reserve_next_assignment", assignment: record.assignment });
  if (record.status === "reserved") return Object.freeze({ kind: "authorize_reserved_assignment_release", assignment: record.assignment });
  if (record.status === "released") {
    return Object.freeze({
      kind: "await_assignment_terminal_or_reconciliation",
      assignment: record.assignment,
      releaseAuthorizationDigest: record.releaseAuthorization!.authorizationDigest,
      releaseMayBeReissued: false,
    });
  }
  throw new Error("SUCCESSOR_V4_CURRENT_ASSIGNMENT_ALREADY_TERMINAL");
}

function sealUsageLimitWindow(content: z.input<typeof usageLimitWindowContentSchema>) {
  const parsed = usageLimitWindowContentSchema.parse(content);
  return usageLimitWindowSchema.parse({
    ...parsed,
    windowDigest: hashCanonicalJson(parsed as unknown as JsonValue),
  });
}

export function createExp0001aFullRunSuccessorReleaseCoordinatorV4(options: Readonly<{
  filePath: string;
  gate: Exp0001aVerifiedFullRunSuccessorLaunchGateV4;
  now?: () => string;
}>) {
  const gate = assertVerifiedGate(options.gate);
  const now = options.now ?? (() => new Date().toISOString());
  const genesis = initialState(gate);
  const store = createAtomicRegistryStore<Exp0001aFullRunSuccessorReleaseStateV4>({
    filePath: options.filePath,
    validate: (input) => verifyStateForGate(input, gate),
    identity: (state) => state.stateDigest,
    now,
  });

  const updatedAt = (prior: Exp0001aFullRunSuccessorReleaseStateV4) => {
    const value = timestampSchema.parse(now());
    if (Date.parse(value) < Date.parse(prior.updatedAt)) {
      throw new Error("SUCCESSOR_V4_STATE_TIME_REGRESSION");
    }
    return value;
  };
  const persist = async (
    prior: Exp0001aFullRunSuccessorReleaseStateV4,
    patch: Partial<z.input<typeof releaseStateContentSchema>>,
  ) => store.persist(sealReleaseState({
    ...releaseStateContent(prior),
    ...patch,
    sequence: prior.sequence + 1,
    predecessorStateDigest: prior.stateDigest,
  }), prior.stateDigest);

  return Object.freeze({
    initialize: () => store.initialize(genesis),
    read: () => store.read(),
    nextAction: async () => nextExp0001aFullRunSuccessorReleaseActionV4(await store.read()),
    reserveNextAssignment: async () => {
      const prior = await store.read();
      if (prior.phase !== "running") throw new Error("SUCCESSOR_V4_RELEASES_PAUSED_OR_COMPLETE");
      const record = prior.assignments[prior.currentAssignmentIndex];
      if (record?.status !== "unreleased") throw new Error("SUCCESSOR_V4_NEXT_ASSIGNMENT_NOT_UNRELEASED");
      const reservedAt = updatedAt(prior);
      const assignments = [...prior.assignments];
      assignments[prior.currentAssignmentIndex] = { ...record, status: "reserved", reservedAt };
      return persist(prior, { assignments, updatedAt: reservedAt });
    },
    authorizeReservedAssignmentRelease: async () => {
      const prior = await store.read();
      if (prior.phase !== "running") throw new Error("SUCCESSOR_V4_RELEASES_PAUSED_OR_COMPLETE");
      const record = prior.assignments[prior.currentAssignmentIndex];
      if (record?.status !== "reserved") throw new Error("SUCCESSOR_V4_ASSIGNMENT_RELEASE_NOT_RESERVED");
      if (prior.assignmentReleaseCount >= 48) throw new Error("SUCCESSOR_V4_ASSIGNMENT_RELEASE_CEILING_REACHED");
      const authorizedAt = updatedAt(prior);
      const authorizationContent = releaseAuthorizationContentSchema.parse({
        schemaVersion: EXP0001A_FULL_RUN_SUCCESSOR_RUNTIME_V4_VERSION,
        kind: "full-run-assignment-release-authorization",
        gateDigest: gate.gateDigest,
        scheduleDigest: gate.schedule.scheduleDigest,
        assignmentId: record.assignment.assignmentId,
        attemptId: record.assignment.attemptId,
        plannedIndex: record.assignment.plannedIndex,
        condition: record.assignment.condition,
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
      const assignments = [...prior.assignments];
      assignments[prior.currentAssignmentIndex] = { ...record, status: "released", releaseAuthorization };
      const counters = assignmentCounters(assignments);
      const state = await persist(prior, { assignments, ...counters, updatedAt: authorizedAt });
      return Object.freeze({ state, releaseAuthorization });
    },
    terminalizeReleasedAssignment: async (input: Readonly<{
      releaseAuthorizationDigest: string;
      outcome: z.infer<typeof terminalOutcomeSchema>;
      evidenceDigest: string;
      usageLimitObservationDigest?: string;
    }>) => {
      const prior = await store.read();
      if (prior.phase !== "running") throw new Error("SUCCESSOR_V4_RELEASES_PAUSED_OR_COMPLETE");
      const record = prior.assignments[prior.currentAssignmentIndex];
      if (record?.status !== "released" || record.releaseAuthorization === null) {
        throw new Error("SUCCESSOR_V4_ASSIGNMENT_NOT_RELEASED");
      }
      if (digestSchema.parse(input.releaseAuthorizationDigest) !== record.releaseAuthorization.authorizationDigest) {
        throw new Error("SUCCESSOR_V4_TERMINAL_RESULT_RELEASE_BINDING_INVALID");
      }
      const outcome = terminalOutcomeSchema.parse(input.outcome);
      const isUsageLimit = outcome === "usage_limit_interrupted";
      if (isUsageLimit !== (input.usageLimitObservationDigest !== undefined)) {
        throw new Error("SUCCESSOR_V4_USAGE_LIMIT_TERMINAL_REQUIRES_EXACT_OBSERVATION");
      }
      const terminalAt = updatedAt(prior);
      const terminalContent = terminalReceiptContentSchema.parse({
        schemaVersion: EXP0001A_FULL_RUN_SUCCESSOR_RUNTIME_V4_VERSION,
        kind: "full-run-assignment-terminal-receipt",
        assignmentId: record.assignment.assignmentId,
        releaseAuthorizationDigest: input.releaseAuthorizationDigest,
        outcome,
        terminalAt,
        evidenceDigest: digestSchema.parse(input.evidenceDigest),
        usageLimitObservationDigest: isUsageLimit
          ? digestSchema.parse(input.usageLimitObservationDigest)
          : null,
      });
      const terminalReceipt = terminalReceiptSchema.parse({
        ...terminalContent,
        terminalReceiptDigest: hashCanonicalJson(terminalContent as unknown as JsonValue),
      });
      const assignments = [...prior.assignments];
      assignments[prior.currentAssignmentIndex] = { ...record, status: "terminal", terminalReceipt };
      const counters = assignmentCounters(assignments);
      const currentAssignmentIndex = counters.terminalAssignmentCount;
      let activeUsageLimitWindow = null;
      if (isUsageLimit) {
        activeUsageLimitWindow = sealUsageLimitWindow({
          ordinal: prior.completedUsageLimitWindows.length + 1,
          openedAt: terminalAt,
          observationDigest: digestSchema.parse(input.usageLimitObservationDigest),
          assignmentIndex: currentAssignmentIndex,
          releasedConditionCounts: counters.releasedConditionCounts,
          closedAt: null,
          resumeObservationDigest: null,
        });
      }
      const phase = currentAssignmentIndex === 48
        ? "complete" as const
        : isUsageLimit ? "paused_for_usage_limit" as const : "running" as const;
      const state = await persist(prior, {
        assignments,
        ...counters,
        currentAssignmentIndex,
        phase,
        activeUsageLimitWindow: phase === "complete" ? null : activeUsageLimitWindow,
        updatedAt: terminalAt,
      });
      return Object.freeze({ state, terminalReceipt });
    },
    pauseForUsageLimit: async (input: Readonly<{ observationDigest: string }>) => {
      const prior = await store.read();
      if (prior.phase !== "running") throw new Error("SUCCESSOR_V4_USAGE_LIMIT_PAUSE_NOT_RUNNING");
      const record = prior.assignments[prior.currentAssignmentIndex];
      if (record?.status === "released") {
        throw new Error("SUCCESSOR_V4_RELEASED_ASSIGNMENT_MUST_TERMINALIZE_BEFORE_PAUSE");
      }
      const openedAt = updatedAt(prior);
      const activeUsageLimitWindow = sealUsageLimitWindow({
        ordinal: prior.completedUsageLimitWindows.length + 1,
        openedAt,
        observationDigest: digestSchema.parse(input.observationDigest),
        assignmentIndex: prior.currentAssignmentIndex,
        releasedConditionCounts: prior.releasedConditionCounts,
        closedAt: null,
        resumeObservationDigest: null,
      });
      return persist(prior, {
        phase: "paused_for_usage_limit",
        activeUsageLimitWindow,
        updatedAt: openedAt,
      });
    },
    resumeAfterUsageLimit: async (input: Readonly<{ resetObservationDigest: string }>) => {
      const prior = await store.read();
      if (prior.phase !== "paused_for_usage_limit" || prior.activeUsageLimitWindow === null) {
        throw new Error("SUCCESSOR_V4_USAGE_LIMIT_WINDOW_NOT_ACTIVE");
      }
      const closedAt = updatedAt(prior);
      const { windowDigest: _windowDigest, ...activeWindowContent } = prior.activeUsageLimitWindow;
      void _windowDigest;
      const completedWindow = sealUsageLimitWindow({
        ...activeWindowContent,
        closedAt,
        resumeObservationDigest: digestSchema.parse(input.resetObservationDigest),
      });
      return persist(prior, {
        phase: "running",
        activeUsageLimitWindow: null,
        completedUsageLimitWindows: [...prior.completedUsageLimitWindows, completedWindow],
        updatedAt: closedAt,
      });
    },
  });
}
