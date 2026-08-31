import { z } from "zod";

import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const idSchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const EXP0001A_MODEL_ROLE_QUALIFICATION_VERSION =
  "exp-0001a-model-role-qualification/v1" as const;

export const EXP0001A_QUALIFICATION_TASK_IDS = Object.freeze([
  "dev-architecture-create-observability",
  "dev-architecture-edit-primary-path",
  "dev-drawing-create-layered-portrait",
] as const);

export const EXP0001A_CANDIDATE_MODEL_ROLE_POLICY = Object.freeze({
  ecologicalAuthor: Object.freeze({
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    purpose: "primary author population representing balanced everyday use",
  }),
  platformDefaultValidationAuthor: Object.freeze({
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    purpose: "secondary validation against the current Codex default Power setting",
  }),
  lowerBoundAuthor: Object.freeze({
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
    purpose: "diagnostic lower-bound robustness check, not the primary estimand",
  }),
  blindedReviewer: Object.freeze({
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    purpose: "independent primary review, adjudication, and pairwise visual judgment",
  }),
} as const);

const exactRolePolicySchema = z.object({
  ecologicalAuthor: z.object({
    model: z.literal(EXP0001A_CANDIDATE_MODEL_ROLE_POLICY.ecologicalAuthor.model),
    reasoningEffort: z.literal(EXP0001A_CANDIDATE_MODEL_ROLE_POLICY.ecologicalAuthor.reasoningEffort),
    purpose: z.literal(EXP0001A_CANDIDATE_MODEL_ROLE_POLICY.ecologicalAuthor.purpose),
  }).strict(),
  platformDefaultValidationAuthor: z.object({
    model: z.literal(EXP0001A_CANDIDATE_MODEL_ROLE_POLICY.platformDefaultValidationAuthor.model),
    reasoningEffort: z.literal(EXP0001A_CANDIDATE_MODEL_ROLE_POLICY.platformDefaultValidationAuthor.reasoningEffort),
    purpose: z.literal(EXP0001A_CANDIDATE_MODEL_ROLE_POLICY.platformDefaultValidationAuthor.purpose),
  }).strict(),
  lowerBoundAuthor: z.object({
    model: z.literal(EXP0001A_CANDIDATE_MODEL_ROLE_POLICY.lowerBoundAuthor.model),
    reasoningEffort: z.literal(EXP0001A_CANDIDATE_MODEL_ROLE_POLICY.lowerBoundAuthor.reasoningEffort),
    purpose: z.literal(EXP0001A_CANDIDATE_MODEL_ROLE_POLICY.lowerBoundAuthor.purpose),
  }).strict(),
  blindedReviewer: z.object({
    model: z.literal(EXP0001A_CANDIDATE_MODEL_ROLE_POLICY.blindedReviewer.model),
    reasoningEffort: z.literal(EXP0001A_CANDIDATE_MODEL_ROLE_POLICY.blindedReviewer.reasoningEffort),
    purpose: z.literal(EXP0001A_CANDIDATE_MODEL_ROLE_POLICY.blindedReviewer.purpose),
  }).strict(),
}).strict();

const qualificationTaskSchema = z.object({
  taskId: z.enum(EXP0001A_QUALIFICATION_TASK_IDS),
  roleCoverage: z.enum(["architecture_creation", "architecture_editing", "drawing_creation"]),
  observationTiming: z.enum(["observed_before_gate_freeze", "prospective_after_gate_freeze"]),
}).strict();

const qualificationPlanContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_MODEL_ROLE_QUALIFICATION_VERSION),
  protocolId: z.literal("EXP-0001A-MODEL-ROLE-QUALIFICATION"),
  frozenAt: timestampSchema,
  classification: z.literal("public-development-preexecution-qualification"),
  benchmark: z.object({
    path: z.literal("research/benchmarks/development-v1.json"),
    bundleDigest: z.literal("sha256:067802ba59f921b361442fd27d234063f7c30476b58aeb1801da1202c0a27136"),
    split: z.literal("development"),
    sealedMaterialAccessed: z.literal(false),
  }).strict(),
  rolePolicy: exactRolePolicySchema,
  tasks: z.tuple([
    qualificationTaskSchema.extend({
      taskId: z.literal(EXP0001A_QUALIFICATION_TASK_IDS[0]),
      roleCoverage: z.literal("architecture_creation"),
      observationTiming: z.literal("observed_before_gate_freeze"),
    }).strict(),
    qualificationTaskSchema.extend({
      taskId: z.literal(EXP0001A_QUALIFICATION_TASK_IDS[1]),
      roleCoverage: z.literal("architecture_editing"),
      observationTiming: z.literal("prospective_after_gate_freeze"),
    }).strict(),
    qualificationTaskSchema.extend({
      taskId: z.literal(EXP0001A_QUALIFICATION_TASK_IDS[2]),
      roleCoverage: z.literal("drawing_creation"),
      observationTiming: z.literal("prospective_after_gate_freeze"),
    }).strict(),
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
  review: z.object({
    primaryReviewersPerArtifact: z.literal(2),
    authorReviewerSeparation: z.literal(true),
    conditionAndAuthorIdentityBlinded: z.literal(true),
    permittedInputs: z.tuple([
      z.literal("public_requirement"),
      z.literal("frozen_rubric"),
      z.literal("sanitized_semantic_state"),
      z.literal("revision_matched_final_png"),
    ]),
    adjudicationTrigger: z.literal("binary-primary-acceptance-disagreement-only"),
  }).strict(),
  stoppingRule: z.object({
    allThreeTasksMustPass: z.literal(true),
    everyFrozenCriterionMustPass: z.literal(true),
    reviewerAgreementRequiredWithoutAdjudication: z.literal(true),
    rerunsPermitted: z.literal(false),
    replacementAttemptsPermitted: z.literal(false),
    setupFailuresRetainedButNotScoredAgainstModel: z.literal(true),
  }).strict(),
  interpretation: z.object({
    firstObservationNonProspective: z.literal(true),
    statisticalImprovementClaimPermitted: z.literal(false),
    aaExecutionStatusUntilPass: z.literal("blocked"),
    activeFrozen48RunMutatedByThisPlan: z.literal(false),
  }).strict(),
}).strict().superRefine((plan, context) => {
  if (canonicalJson(plan.rolePolicy as unknown as JsonValue)
      !== canonicalJson(EXP0001A_CANDIDATE_MODEL_ROLE_POLICY as unknown as JsonValue)) {
    context.addIssue({ code: "custom", path: ["rolePolicy"], message: "Candidate role policy drifted." });
  }
  const taskIds = plan.tasks.map((task) => task.taskId);
  if (canonicalJson(taskIds as unknown as JsonValue)
      !== canonicalJson(EXP0001A_QUALIFICATION_TASK_IDS as unknown as JsonValue)) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Qualification task order drifted." });
  }
});

export const exp0001aModelRoleQualificationPlanSchema = qualificationPlanContentSchema.extend({
  planDigest: digestSchema,
}).strict().superRefine((plan, context) => {
  const { planDigest: _planDigest, ...content } = plan;
  void _planDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== plan.planDigest) {
    context.addIssue({ code: "custom", path: ["planDigest"], message: "Qualification plan digest is invalid." });
  }
});

export type Exp0001aModelRoleQualificationPlan = z.infer<
  typeof exp0001aModelRoleQualificationPlanSchema
>;

export function sealExp0001aModelRoleQualificationPlan(
  input: unknown,
): Exp0001aModelRoleQualificationPlan {
  const content = qualificationPlanContentSchema.parse(input);
  return Object.freeze(exp0001aModelRoleQualificationPlanSchema.parse({
    ...content,
    planDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

export const qualificationReviewDecisionSchema = z.object({
  reviewerTaskId: idSchema,
  artifactAccepted: z.boolean(),
  criterionPasses: z.record(idSchema, z.boolean()),
  evidenceRoot: digestSchema,
}).strict();

export const qualificationAttemptResultSchema = z.object({
  taskId: z.enum(EXP0001A_QUALIFICATION_TASK_IDS),
  authorTaskId: idSchema,
  authorOutcome: z.enum(["completed", "failed", "usage_limit_interrupted", "invalid_setup"]),
  qualificationValidity: z.enum(["valid", "invalid_setup"]),
  invalidReasonCode: idSchema.nullable(),
  artifactEvidenceRoot: digestSchema.nullable(),
  primaryReviews: z.array(qualificationReviewDecisionSchema).max(2),
  adjudication: qualificationReviewDecisionSchema.nullable(),
}).strict().superRefine((attempt, context) => {
  if ((attempt.qualificationValidity === "invalid_setup") !== (attempt.invalidReasonCode !== null)) {
    context.addIssue({
      code: "custom",
      path: ["invalidReasonCode"],
      message: "Invalid setup results require one reason code; valid results cannot carry one.",
    });
  }
  if (attempt.authorOutcome === "completed") {
    if (attempt.artifactEvidenceRoot === null || attempt.primaryReviews.length !== 2) {
      context.addIssue({
        code: "custom",
        path: ["primaryReviews"],
        message: "Completed attempts require an artifact root and exactly two primary reviews.",
      });
    }
  } else if (attempt.artifactEvidenceRoot !== null || attempt.primaryReviews.length !== 0 || attempt.adjudication !== null) {
    context.addIssue({
      code: "custom",
      path: ["artifactEvidenceRoot"],
      message: "Noncompleted attempts cannot carry artifact-review evidence.",
    });
  }
  if (attempt.primaryReviews.length === 2) {
    const [left, right] = attempt.primaryReviews;
    const disagreed = left.artifactAccepted !== right.artifactAccepted;
    if (disagreed !== (attempt.adjudication !== null)) {
      context.addIssue({
        code: "custom",
        path: ["adjudication"],
        message: "Adjudication is required exactly when primary binary decisions disagree.",
      });
    }
  }
});

export type QualificationAttemptResult = z.infer<typeof qualificationAttemptResultSchema>;

export type Exp0001aQualificationGateDecision = Readonly<{
  decision: "pass" | "fail" | "incomplete";
  passedTaskIds: readonly string[];
  failedTaskIds: readonly string[];
  incompleteTaskIds: readonly string[];
}>;

export function evaluateExp0001aModelRoleQualification(
  attemptsInput: readonly unknown[],
): Exp0001aQualificationGateDecision {
  const attempts = attemptsInput.map((attempt) => qualificationAttemptResultSchema.parse(attempt));
  const byTask = new Map(attempts.map((attempt) => [attempt.taskId, attempt]));
  if (byTask.size !== attempts.length) throw new Error("QUALIFICATION_ATTEMPT_TASK_DUPLICATE");
  const unexpected = attempts.find((attempt) => !EXP0001A_QUALIFICATION_TASK_IDS.includes(attempt.taskId));
  if (unexpected) throw new Error("QUALIFICATION_ATTEMPT_TASK_UNEXPECTED");

  const passedTaskIds: string[] = [];
  const failedTaskIds: string[] = [];
  const incompleteTaskIds: string[] = [];

  for (const taskId of EXP0001A_QUALIFICATION_TASK_IDS) {
    const attempt = byTask.get(taskId);
    if (!attempt || attempt.authorOutcome === "usage_limit_interrupted" || attempt.qualificationValidity === "invalid_setup") {
      incompleteTaskIds.push(taskId);
      continue;
    }
    if (attempt.authorOutcome !== "completed") {
      failedTaskIds.push(taskId);
      continue;
    }
    const accepted = attempt.primaryReviews[0].artifactAccepted === attempt.primaryReviews[1].artifactAccepted
      ? attempt.primaryReviews[0].artifactAccepted
      : attempt.adjudication?.artifactAccepted ?? false;
    (accepted ? passedTaskIds : failedTaskIds).push(taskId);
  }

  return Object.freeze({
    decision: failedTaskIds.length > 0 ? "fail" : incompleteTaskIds.length > 0 ? "incomplete" : "pass",
    passedTaskIds: Object.freeze(passedTaskIds),
    failedTaskIds: Object.freeze(failedTaskIds),
    incompleteTaskIds: Object.freeze(incompleteTaskIds),
  });
}

const observableCountSchema = z.union([z.number().int().nonnegative(), z.literal("unobservable")]);

const qualificationResultContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-model-role-qualification-result/v1"),
  protocolId: z.literal("EXP-0001A-MODEL-ROLE-QUALIFICATION"),
  planDigest: digestSchema,
  completedAt: timestampSchema,
  candidate: exactRolePolicySchema.shape.ecologicalAuthor,
  retainedInvalidSetupAttempts: z.array(z.object({
    authorTaskId: idSchema,
    reasonCode: idSchema,
    countedAgainstModel: z.literal(false),
    modelAttemptBegan: z.literal(false),
    nextGenuinelyUnstartedAssignmentReleased: z.literal(true),
  }).strict()),
  gateAttempts: z.tuple([
    qualificationAttemptResultSchema,
    qualificationAttemptResultSchema,
    qualificationAttemptResultSchema,
  ]),
  metrics: z.tuple([
    z.object({
      taskId: z.literal(EXP0001A_QUALIFICATION_TASK_IDS[0]),
      observationTiming: z.literal("observed_before_gate_freeze"),
      wallTimeMs: observableCountSchema,
      webMcpCallCount: observableCountSchema,
      webMcpFailureCount: observableCountSchema,
      inspectionCount: observableCountSchema,
      correctionCount: observableCountSchema,
      finalRoomRevision: z.number().int().positive(),
      finalObjectCount: z.number().int().nonnegative(),
      finalDiagramCount: z.number().int().nonnegative(),
      semanticStateSha256: digestSchema,
      rubricSha256: digestSchema,
      finalPngSha256: digestSchema,
      resolvedModelSnapshot: z.literal("unobservable"),
      exactTokens: z.literal("unobservable"),
      subscriptionUsage: z.literal("unobservable"),
      reviewerFormatRepairTurns: z.number().int().nonnegative(),
    }).strict(),
    z.object({
      taskId: z.literal(EXP0001A_QUALIFICATION_TASK_IDS[1]),
      observationTiming: z.literal("prospective_after_gate_freeze"),
      wallTimeMs: observableCountSchema,
      webMcpCallCount: observableCountSchema,
      webMcpFailureCount: observableCountSchema,
      inspectionCount: observableCountSchema,
      correctionCount: observableCountSchema,
      finalRoomRevision: z.number().int().positive(),
      finalObjectCount: z.number().int().nonnegative(),
      finalDiagramCount: z.number().int().nonnegative(),
      semanticStateSha256: digestSchema,
      rubricSha256: digestSchema,
      finalPngSha256: digestSchema,
      resolvedModelSnapshot: z.literal("unobservable"),
      exactTokens: z.literal("unobservable"),
      subscriptionUsage: z.literal("unobservable"),
      reviewerFormatRepairTurns: z.number().int().nonnegative(),
    }).strict(),
    z.object({
      taskId: z.literal(EXP0001A_QUALIFICATION_TASK_IDS[2]),
      observationTiming: z.literal("prospective_after_gate_freeze"),
      wallTimeMs: observableCountSchema,
      webMcpCallCount: observableCountSchema,
      webMcpFailureCount: observableCountSchema,
      inspectionCount: observableCountSchema,
      correctionCount: observableCountSchema,
      finalRoomRevision: z.number().int().positive(),
      finalObjectCount: z.number().int().nonnegative(),
      finalDiagramCount: z.number().int().nonnegative(),
      semanticStateSha256: digestSchema,
      rubricSha256: digestSchema,
      finalPngSha256: digestSchema,
      resolvedModelSnapshot: z.literal("unobservable"),
      exactTokens: z.literal("unobservable"),
      subscriptionUsage: z.literal("unobservable"),
      reviewerFormatRepairTurns: z.number().int().nonnegative(),
    }).strict(),
  ]),
  gateDecision: z.object({
    decision: z.enum(["pass", "fail", "incomplete"]),
    passedTaskIds: z.array(z.enum(EXP0001A_QUALIFICATION_TASK_IDS)),
    failedTaskIds: z.array(z.enum(EXP0001A_QUALIFICATION_TASK_IDS)),
    incompleteTaskIds: z.array(z.enum(EXP0001A_QUALIFICATION_TASK_IDS)),
  }).strict(),
  interpretation: z.object({
    ecologicalAuthorQualified: z.boolean(),
    primary48ExecutionStatus: z.literal("blocked"),
    statisticalImprovementClaimPermitted: z.literal(false),
    nextAction: z.enum([
      "prepare_v3_freeze",
      "diagnose_and_predeclare_new_qualification_or_choose_another_author_policy",
      "resume_after_usage_limit",
    ]),
  }).strict(),
}).strict().superRefine((result, context) => {
  const taskIds = result.gateAttempts.map((attempt) => attempt.taskId);
  if (canonicalJson(taskIds as unknown as JsonValue)
      !== canonicalJson(EXP0001A_QUALIFICATION_TASK_IDS as unknown as JsonValue)) {
    context.addIssue({ code: "custom", path: ["gateAttempts"], message: "Result task order drifted." });
  }
  const evaluated = evaluateExp0001aModelRoleQualification(result.gateAttempts);
  if (canonicalJson(evaluated as unknown as JsonValue)
      !== canonicalJson(result.gateDecision as unknown as JsonValue)) {
    context.addIssue({ code: "custom", path: ["gateDecision"], message: "Stored gate decision does not match attempts." });
  }
  if (result.interpretation.ecologicalAuthorQualified !== (evaluated.decision === "pass")) {
    context.addIssue({ code: "custom", path: ["interpretation", "ecologicalAuthorQualified"], message: "Qualification interpretation contradicts the gate." });
  }
});

export const exp0001aModelRoleQualificationResultSchema = qualificationResultContentSchema.extend({
  resultDigest: digestSchema,
}).strict().superRefine((result, context) => {
  const { resultDigest: _resultDigest, ...content } = result;
  void _resultDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== result.resultDigest) {
    context.addIssue({ code: "custom", path: ["resultDigest"], message: "Qualification result digest is invalid." });
  }
});

export type Exp0001aModelRoleQualificationResult = z.infer<
  typeof exp0001aModelRoleQualificationResultSchema
>;

export function sealExp0001aModelRoleQualificationResult(
  input: unknown,
): Exp0001aModelRoleQualificationResult {
  const content = qualificationResultContentSchema.parse(input);
  return Object.freeze(exp0001aModelRoleQualificationResultSchema.parse({
    ...content,
    resultDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}
