import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  evaluateExp0001aModelRoleQualification,
  EXP0001A_CANDIDATE_MODEL_ROLE_POLICY,
  EXP0001A_MODEL_ROLE_QUALIFICATION_VERSION,
  EXP0001A_QUALIFICATION_TASK_IDS,
  exp0001aModelRoleQualificationPlanSchema,
  exp0001aModelRoleQualificationResultSchema,
  sealExp0001aModelRoleQualificationPlan,
} from "./exp0001a-model-role-qualification";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function planInput() {
  return {
    schemaVersion: EXP0001A_MODEL_ROLE_QUALIFICATION_VERSION,
    protocolId: "EXP-0001A-MODEL-ROLE-QUALIFICATION" as const,
    frozenAt: "2026-08-31T19:00:00.000Z",
    classification: "public-development-preexecution-qualification" as const,
    benchmark: {
      path: "research/benchmarks/development-v1.json" as const,
      bundleDigest: "sha256:067802ba59f921b361442fd27d234063f7c30476b58aeb1801da1202c0a27136" as const,
      split: "development" as const,
      sealedMaterialAccessed: false as const,
    },
    rolePolicy: EXP0001A_CANDIDATE_MODEL_ROLE_POLICY,
    tasks: [
      { taskId: EXP0001A_QUALIFICATION_TASK_IDS[0], roleCoverage: "architecture_creation" as const, observationTiming: "observed_before_gate_freeze" as const },
      { taskId: EXP0001A_QUALIFICATION_TASK_IDS[1], roleCoverage: "architecture_editing" as const, observationTiming: "prospective_after_gate_freeze" as const },
      { taskId: EXP0001A_QUALIFICATION_TASK_IDS[2], roleCoverage: "drawing_creation" as const, observationTiming: "prospective_after_gate_freeze" as const },
    ] as const,
    authorIsolation: {
      freshProjectlessTaskPerAttempt: true as const,
      repositoryAccess: false as const,
      privateApiAccess: false as const,
      sharedHistory: false as const,
      forks: false as const,
      preparedCoordinates: false as const,
      evaluatorContext: false as const,
      permittedInputs: ["public_task_brief", "private_room_url", "browser_exposed_webmcp"] as const,
    },
    review: {
      primaryReviewersPerArtifact: 2 as const,
      authorReviewerSeparation: true as const,
      conditionAndAuthorIdentityBlinded: true as const,
      permittedInputs: ["public_requirement", "frozen_rubric", "sanitized_semantic_state", "revision_matched_final_png"] as const,
      adjudicationTrigger: "binary-primary-acceptance-disagreement-only" as const,
    },
    stoppingRule: {
      allThreeTasksMustPass: true as const,
      everyFrozenCriterionMustPass: true as const,
      reviewerAgreementRequiredWithoutAdjudication: true as const,
      rerunsPermitted: false as const,
      replacementAttemptsPermitted: false as const,
      setupFailuresRetainedButNotScoredAgainstModel: true as const,
    },
    interpretation: {
      firstObservationNonProspective: true as const,
      statisticalImprovementClaimPermitted: false as const,
      aaExecutionStatusUntilPass: "blocked" as const,
      activeFrozen48RunMutatedByThisPlan: false as const,
    },
  };
}

function acceptedAttempt(taskId: typeof EXP0001A_QUALIFICATION_TASK_IDS[number], accepted = true) {
  return {
    taskId,
    authorTaskId: `author-${taskId}`,
    authorOutcome: "completed",
    qualificationValidity: "valid",
    invalidReasonCode: null,
    artifactEvidenceRoot: digest("a"),
    primaryReviews: [
      { reviewerTaskId: `review-1-${taskId}`, artifactAccepted: accepted, criterionPasses: { criterion: accepted }, evidenceRoot: digest("b") },
      { reviewerTaskId: `review-2-${taskId}`, artifactAccepted: accepted, criterionPasses: { criterion: accepted }, evidenceRoot: digest("c") },
    ],
    adjudication: null,
  };
}

describe("EXP-0001A model-role qualification", () => {
  it("verifies the committed machine-readable plan", () => {
    const plan = JSON.parse(readFileSync(
      "research/data/exp0001a-model-role-qualification-plan-v1.json",
      "utf8",
    ));
    expect(exp0001aModelRoleQualificationPlanSchema.parse(plan).planDigest)
      .toBe("sha256:7ef8289fe13fe928f18b922dd84bfe1b9bae8a9b15e47027c308ce3933c8935d");
  });

  it("seals the exact role policy, task order, and non-prospective disclosure", () => {
    const plan = sealExp0001aModelRoleQualificationPlan(planInput());
    expect(exp0001aModelRoleQualificationPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.tasks[0].observationTiming).toBe("observed_before_gate_freeze");
    expect(plan.rolePolicy.ecologicalAuthor).toMatchObject({ model: "gpt-5.6-terra", reasoningEffort: "medium" });
    expect(plan.rolePolicy.platformDefaultValidationAuthor).toMatchObject({ model: "gpt-5.6-sol", reasoningEffort: "medium" });
    expect(plan.rolePolicy.blindedReviewer).toMatchObject({ model: "gpt-5.6-sol", reasoningEffort: "high" });
  });

  it("rejects policy drift and digest tampering", () => {
    const plan = sealExp0001aModelRoleQualificationPlan(planInput());
    expect(() => exp0001aModelRoleQualificationPlanSchema.parse({
      ...plan,
      rolePolicy: { ...plan.rolePolicy, ecologicalAuthor: { ...plan.rolePolicy.ecologicalAuthor, model: "gpt-5.6-sol" } },
    })).toThrow();
    expect(() => exp0001aModelRoleQualificationPlanSchema.parse({ ...plan, frozenAt: "2026-09-01T00:00:00.000Z" })).toThrow();
  });

  it("requires all three distinct tasks to pass", () => {
    const passing = EXP0001A_QUALIFICATION_TASK_IDS.map((taskId) => acceptedAttempt(taskId));
    expect(evaluateExp0001aModelRoleQualification(passing).decision).toBe("pass");
    expect(evaluateExp0001aModelRoleQualification(passing.slice(0, 2)).decision).toBe("incomplete");
    expect(evaluateExp0001aModelRoleQualification([
      passing[0],
      acceptedAttempt(EXP0001A_QUALIFICATION_TASK_IDS[1], false),
      passing[2],
    ])).toMatchObject({ decision: "fail", failedTaskIds: [EXP0001A_QUALIFICATION_TASK_IDS[1]] });
    expect(() => evaluateExp0001aModelRoleQualification([passing[0], passing[0]])).toThrow("QUALIFICATION_ATTEMPT_TASK_DUPLICATE");
  });

  it("retains invalid setup evidence but does not score it against the model", () => {
    const invalid = {
      ...acceptedAttempt(EXP0001A_QUALIFICATION_TASK_IDS[1]),
      qualificationValidity: "invalid_setup",
      invalidReasonCode: "BASELINE_FIXTURE_INVALID",
    };
    expect(evaluateExp0001aModelRoleQualification([
      acceptedAttempt(EXP0001A_QUALIFICATION_TASK_IDS[0], false),
      invalid,
      acceptedAttempt(EXP0001A_QUALIFICATION_TASK_IDS[2]),
    ])).toMatchObject({
      decision: "fail",
      failedTaskIds: [EXP0001A_QUALIFICATION_TASK_IDS[0]],
      incompleteTaskIds: [EXP0001A_QUALIFICATION_TASK_IDS[1]],
    });
  });

  it("requires adjudication exactly when primary decisions disagree", () => {
    const attempt = acceptedAttempt(EXP0001A_QUALIFICATION_TASK_IDS[0]);
    const disagreement = {
      ...attempt,
      primaryReviews: [attempt.primaryReviews[0], { ...attempt.primaryReviews[1], artifactAccepted: false }],
    };
    expect(() => evaluateExp0001aModelRoleQualification([disagreement])).toThrow();
  });

  it("verifies the retained qualification result and derived gate", () => {
    const result = JSON.parse(readFileSync(
      "research/results/exp0001a-terra-medium-qualification-v1.json",
      "utf8",
    ));
    const verified = exp0001aModelRoleQualificationResultSchema.parse(result);
    expect(verified.gateDecision).toEqual({
      decision: "fail",
      passedTaskIds: ["dev-drawing-create-layered-portrait"],
      failedTaskIds: ["dev-architecture-create-observability"],
      incompleteTaskIds: ["dev-architecture-edit-primary-path"],
    });
    expect(verified.interpretation.ecologicalAuthorQualified).toBe(false);
  });
});
