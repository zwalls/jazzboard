// @vitest-environment node

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  evaluateExp0001aModelRoleQualificationV2,
  EXP0001A_QUALIFICATION_V2_AUTHOR,
  EXP0001A_QUALIFICATION_V2_TASK_IDS,
  exp0001aModelRoleQualificationV2PlanSchema,
} from "./exp0001a-model-role-qualification-v2";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function compatibleAttempt(
  taskId: typeof EXP0001A_QUALIFICATION_V2_TASK_IDS[number],
  quality: "accepted" | "rejected" = "accepted",
) {
  return {
    taskId,
    authorTaskId: `author-${taskId}`,
    requestedModel: EXP0001A_QUALIFICATION_V2_AUTHOR.model,
    requestedReasoningEffort: EXP0001A_QUALIFICATION_V2_AUTHOR.reasoningEffort,
    authorOutcome: "completed",
    qualificationValidity: "valid",
    invalidReasonCode: null,
    isolationVerified: true,
    criticalBoundaryViolations: [],
    evidence: {
      webMcpDiscovered: true,
      successfulAuthoritativeMutationCount: 1,
      visualInspectionCount: 1,
      finalAuthoritativeRoomRevision: 2,
      revisionMatchedPngDigest: digest("a"),
      sanitizedSemanticStateDigest: digest("b"),
      terminalResultDigest: digest("c"),
      evidenceRoot: digest("d"),
    },
    blindedQualityDecision: quality,
  } as const;
}

describe("EXP-0001A Terra/medium compatibility qualification v2", () => {
  it("verifies the prospective checked-in plan and binds the disclosed v1 failure", () => {
    const plan = exp0001aModelRoleQualificationV2PlanSchema.parse(JSON.parse(readFileSync(
      "research/data/exp0001a-model-role-qualification-plan-v2.json",
      "utf8",
    )));

    expect(plan.planDigest).toBe("sha256:e318342431aa10f1813ea7ee9bcdd508f913096a71d0886cebde98212287188b");
    expect(plan.supersedes).toMatchObject({ priorDecision: "fail", priorDecisionRetained: true });
    expect(plan.rolePolicy.ecologicalAuthor).toMatchObject({ model: "gpt-5.6-terra", reasoningEffort: "medium" });
    expect(plan.compatibilityGate.artifactQualityControlsAdmission).toBe(false);
  });

  it("passes operational compatibility even when blinded quality rejects an artifact", () => {
    const attempts = EXP0001A_QUALIFICATION_V2_TASK_IDS.map((taskId, index) => (
      compatibleAttempt(taskId, index === 0 ? "rejected" : "accepted")
    ));

    expect(evaluateExp0001aModelRoleQualificationV2(attempts)).toMatchObject({
      decision: "pass",
      compatibleTaskIds: EXP0001A_QUALIFICATION_V2_TASK_IDS,
      diagnosticQuality: { "dev-architecture-create-checkout": "rejected" },
    });
  });

  it("fails closed for missing evidence or a boundary violation", () => {
    const attempts = EXP0001A_QUALIFICATION_V2_TASK_IDS.map((taskId) => compatibleAttempt(taskId));
    const missingPng = {
      ...attempts[0],
      evidence: { ...attempts[0].evidence, revisionMatchedPngDigest: null },
    };
    const boundaryViolation = {
      ...attempts[1],
      criticalBoundaryViolations: ["REPOSITORY_ACCESS"],
    };

    expect(evaluateExp0001aModelRoleQualificationV2([
      missingPng,
      boundaryViolation,
      attempts[2],
    ])).toMatchObject({
      decision: "fail",
      failedTaskIds: [
        "dev-architecture-create-checkout",
        "dev-architecture-edit-uncertainty",
      ],
    });
  });

  it("retains invalid setup and usage-limit interruption as incomplete without replacement", () => {
    const attempts = EXP0001A_QUALIFICATION_V2_TASK_IDS.map((taskId) => compatibleAttempt(taskId));
    const invalidSetup = {
      ...attempts[1],
      authorOutcome: "invalid_setup",
      qualificationValidity: "invalid_setup",
      invalidReasonCode: "BASELINE_FIXTURE_INVALID",
    };
    const paused = { ...attempts[2], authorOutcome: "usage_limit_interrupted" };

    expect(evaluateExp0001aModelRoleQualificationV2([
      attempts[0],
      invalidSetup,
      paused,
    ])).toMatchObject({
      decision: "incomplete",
      compatibleTaskIds: ["dev-architecture-create-checkout"],
      incompleteTaskIds: [
        "dev-architecture-edit-uncertainty",
        "dev-drawing-create-wayfinding-icon",
      ],
    });
  });

  it("rejects model drift and duplicate task evidence", () => {
    const attempts = EXP0001A_QUALIFICATION_V2_TASK_IDS.map((taskId) => compatibleAttempt(taskId));
    expect(() => evaluateExp0001aModelRoleQualificationV2([
      { ...attempts[0], requestedModel: "gpt-5.6-sol" },
    ])).toThrow();
    expect(() => evaluateExp0001aModelRoleQualificationV2([
      attempts[0],
      attempts[0],
    ])).toThrow("QUALIFICATION_V2_ATTEMPT_TASK_DUPLICATE");
  });
});
