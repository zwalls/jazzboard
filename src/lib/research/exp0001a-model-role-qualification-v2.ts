import { z } from "zod";

import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const idSchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const EXP0001A_MODEL_ROLE_QUALIFICATION_V2_VERSION =
  "exp-0001a-model-role-qualification/v2" as const;

export const EXP0001A_QUALIFICATION_V2_TASK_IDS = Object.freeze([
  "dev-architecture-create-checkout",
  "dev-architecture-edit-uncertainty",
  "dev-drawing-create-wayfinding-icon",
] as const);

export const EXP0001A_QUALIFICATION_V2_AUTHOR = Object.freeze({
  model: "gpt-5.6-terra",
  reasoningEffort: "medium",
} as const);

const taskIdSchema = z.enum(EXP0001A_QUALIFICATION_V2_TASK_IDS);

const planContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_MODEL_ROLE_QUALIFICATION_V2_VERSION),
  protocolId: z.literal("EXP-0001A-MODEL-ROLE-QUALIFICATION-V2"),
  frozenAt: z.string().datetime({ offset: true }),
  classification: z.literal("public-development-prospective-operational-qualification"),
  supersedes: z.object({
    planPath: z.literal("research/data/exp0001a-model-role-qualification-plan-v1.json"),
    planDigest: z.literal("sha256:7ef8289fe13fe928f18b922dd84bfe1b9bae8a9b15e47027c308ce3933c8935d"),
    resultPath: z.literal("research/results/exp0001a-terra-medium-qualification-v1.json"),
    resultDigest: z.literal("sha256:e4cc8465d3c9847c7705bddc1a4719dcc265976e6f43f6b74d752f7529f97d84"),
    priorDecision: z.literal("fail"),
    priorDecisionRetained: z.literal(true),
  }).strict(),
  benchmark: z.object({
    path: z.literal("research/benchmarks/development-v2.json"),
    bundleDigest: z.literal("sha256:f0a12f0ff38b4dbcf1c6b32449207341634f042f75714af74b711ccbcc3a52b0"),
    split: z.literal("development"),
    sealedMaterialAccessed: z.literal(false),
  }).strict(),
  productionPrerequisite: z.object({
    requiredReceiptSchema: z.literal("baseline-freeze/v2"),
    successorToCommit: z.literal("88919b8e0070fbd1b2be4f3e4121cfdcf50638a6"),
    exactReceiptDigestBoundAtLaunch: z.literal(true),
    aliasAndContractDriftPermitted: z.literal(false),
    status: z.literal("blocked_pending_successor_freeze"),
  }).strict(),
  rolePolicy: z.object({
    ecologicalAuthor: z.object({
      model: z.literal(EXP0001A_QUALIFICATION_V2_AUTHOR.model),
      reasoningEffort: z.literal(EXP0001A_QUALIFICATION_V2_AUTHOR.reasoningEffort),
      selectionBasis: z.literal("balanced everyday-user author population, fixed independently of artifact quality"),
    }).strict(),
    blindedReviewer: z.object({
      model: z.literal("gpt-5.6-sol"),
      reasoningEffort: z.literal("high"),
      selectionBasis: z.literal("independent evidence review"),
    }).strict(),
  }).strict(),
  tasks: z.tuple([
    z.object({ taskId: z.literal(EXP0001A_QUALIFICATION_V2_TASK_IDS[0]), roleCoverage: z.literal("architecture_creation"), observationTiming: z.literal("prospective_after_gate_freeze") }).strict(),
    z.object({ taskId: z.literal(EXP0001A_QUALIFICATION_V2_TASK_IDS[1]), roleCoverage: z.literal("architecture_editing"), observationTiming: z.literal("prospective_after_gate_freeze") }).strict(),
    z.object({ taskId: z.literal(EXP0001A_QUALIFICATION_V2_TASK_IDS[2]), roleCoverage: z.literal("drawing_creation"), observationTiming: z.literal("prospective_after_gate_freeze") }).strict(),
  ]),
  authorIsolation: z.object({
    freshProjectlessTaskPerAttempt: z.literal(true),
    repositoryAccess: z.literal(false),
    privateApiAccess: z.literal(false),
    sharedHistory: z.literal(false),
    forks: z.literal(false),
    preparedCoordinates: z.literal(false),
    evaluatorContext: z.literal(false),
    permittedInputs: z.tuple([
      z.literal("public_task_brief"),
      z.literal("private_room_url"),
      z.literal("browser_exposed_webmcp"),
    ]),
  }).strict(),
  compatibilityGate: z.object({
    allThreeAttemptsMustBeValidAndCompatible: z.literal(true),
    artifactQualityControlsAdmission: z.literal(false),
    successfulAuthoritativeMutationRequired: z.literal(true),
    visualInspectionRequired: z.literal(true),
    closingAuthoritativeReadRequired: z.literal(true),
    revisionMatchedPngRequired: z.literal(true),
    sanitizedSemanticStateRequired: z.literal(true),
    terminalResultRequired: z.literal(true),
    criticalBoundaryViolationsPermitted: z.literal(false),
    rerunsPermitted: z.literal(false),
    replacementAttemptsPermitted: z.literal(false),
    invalidSetupBlocksWithoutScoringModel: z.literal(true),
  }).strict(),
  qualityEvidence: z.object({
    primaryReviewersPerArtifact: z.literal(2),
    authorReviewerSeparation: z.literal(true),
    conditionAndAuthorIdentityBlinded: z.literal(true),
    adjudicationTrigger: z.literal("binary-primary-acceptance-disagreement-only"),
    qualityDecisionAffectsCompatibility: z.literal(false),
    statisticalImprovementClaimPermitted: z.literal(false),
  }).strict(),
  interpretation: z.object({
    ecologicalModelChoiceFixedAfterDisclosedV1Failure: z.literal(true),
    v1FailureReclassified: z.literal(false),
    activeFrozen48RunMutatedByThisPlan: z.literal(false),
    aaExecutionStatusUntilCompatibilityAndSuccessorFreezePass: z.literal("blocked"),
  }).strict(),
}).strict();

export const exp0001aModelRoleQualificationV2PlanSchema = planContentSchema.extend({
  planDigest: digestSchema,
}).strict().superRefine((plan, context) => {
  const { planDigest: _planDigest, ...content } = plan;
  void _planDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== plan.planDigest) {
    context.addIssue({ code: "custom", path: ["planDigest"], message: "Qualification-v2 plan digest is invalid." });
  }
  if (canonicalJson(plan.tasks.map((task) => task.taskId) as unknown as JsonValue)
      !== canonicalJson(EXP0001A_QUALIFICATION_V2_TASK_IDS as unknown as JsonValue)) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Qualification-v2 task order drifted." });
  }
});

const evidenceSchema = z.object({
  webMcpDiscovered: z.boolean(),
  successfulAuthoritativeMutationCount: z.number().int().nonnegative(),
  visualInspectionCount: z.number().int().nonnegative(),
  finalAuthoritativeRoomRevision: z.number().int().positive().nullable(),
  revisionMatchedPngDigest: digestSchema.nullable(),
  sanitizedSemanticStateDigest: digestSchema.nullable(),
  terminalResultDigest: digestSchema.nullable(),
  evidenceRoot: digestSchema.nullable(),
}).strict();

export const exp0001aModelRoleQualificationV2AttemptSchema = z.object({
  taskId: taskIdSchema,
  authorTaskId: idSchema,
  requestedModel: z.literal(EXP0001A_QUALIFICATION_V2_AUTHOR.model),
  requestedReasoningEffort: z.literal(EXP0001A_QUALIFICATION_V2_AUTHOR.reasoningEffort),
  authorOutcome: z.enum(["completed", "failed", "usage_limit_interrupted", "invalid_setup"]),
  qualificationValidity: z.enum(["valid", "invalid_setup"]),
  invalidReasonCode: idSchema.nullable(),
  isolationVerified: z.boolean(),
  criticalBoundaryViolations: z.array(idSchema).max(100),
  evidence: evidenceSchema,
  blindedQualityDecision: z.enum(["accepted", "rejected", "unobservable"]),
}).strict().superRefine((attempt, context) => {
  if ((attempt.qualificationValidity === "invalid_setup") !== (attempt.invalidReasonCode !== null)) {
    context.addIssue({ code: "custom", path: ["invalidReasonCode"], message: "Invalid setup and reason code must agree." });
  }
});

export type Exp0001aModelRoleQualificationV2Attempt = z.infer<
  typeof exp0001aModelRoleQualificationV2AttemptSchema
>;

export type Exp0001aModelRoleQualificationV2Decision = Readonly<{
  decision: "pass" | "fail" | "incomplete";
  compatibleTaskIds: readonly string[];
  failedTaskIds: readonly string[];
  incompleteTaskIds: readonly string[];
  diagnosticQuality: Readonly<Record<string, "accepted" | "rejected" | "unobservable">>;
}>;

function attemptIsCompatible(attempt: Exp0001aModelRoleQualificationV2Attempt): boolean {
  return attempt.authorOutcome === "completed"
    && attempt.qualificationValidity === "valid"
    && attempt.isolationVerified
    && attempt.criticalBoundaryViolations.length === 0
    && attempt.evidence.webMcpDiscovered
    && attempt.evidence.successfulAuthoritativeMutationCount > 0
    && attempt.evidence.visualInspectionCount > 0
    && attempt.evidence.finalAuthoritativeRoomRevision !== null
    && attempt.evidence.revisionMatchedPngDigest !== null
    && attempt.evidence.sanitizedSemanticStateDigest !== null
    && attempt.evidence.terminalResultDigest !== null
    && attempt.evidence.evidenceRoot !== null;
}

export function evaluateExp0001aModelRoleQualificationV2(
  attemptsInput: readonly unknown[],
): Exp0001aModelRoleQualificationV2Decision {
  const attempts = attemptsInput.map((attempt) => exp0001aModelRoleQualificationV2AttemptSchema.parse(attempt));
  const byTask = new Map(attempts.map((attempt) => [attempt.taskId, attempt]));
  if (byTask.size !== attempts.length) throw new Error("QUALIFICATION_V2_ATTEMPT_TASK_DUPLICATE");

  const compatibleTaskIds: string[] = [];
  const failedTaskIds: string[] = [];
  const incompleteTaskIds: string[] = [];
  const diagnosticQuality: Record<string, "accepted" | "rejected" | "unobservable"> = {};

  for (const taskId of EXP0001A_QUALIFICATION_V2_TASK_IDS) {
    const attempt = byTask.get(taskId);
    if (!attempt || attempt.authorOutcome === "usage_limit_interrupted"
        || attempt.qualificationValidity === "invalid_setup") {
      incompleteTaskIds.push(taskId);
      continue;
    }
    diagnosticQuality[taskId] = attempt.blindedQualityDecision;
    (attemptIsCompatible(attempt) ? compatibleTaskIds : failedTaskIds).push(taskId);
  }

  return Object.freeze({
    decision: failedTaskIds.length > 0 ? "fail" : incompleteTaskIds.length > 0 ? "incomplete" : "pass",
    compatibleTaskIds: Object.freeze(compatibleTaskIds),
    failedTaskIds: Object.freeze(failedTaskIds),
    incompleteTaskIds: Object.freeze(incompleteTaskIds),
    diagnosticQuality: Object.freeze(diagnosticQuality),
  });
}
