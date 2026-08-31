import { describe, expect, it } from "vitest";

import executionManifestJson from "../../../research/data/development-execution-manifest-v1.json";
import committedReviewPlanJson from "../../../research/data/exp0001a-codex-review-plan-v1.json";
import retainedFreezeV1Json from "../../../research/data/exp-0001a-prebrief-freeze-v1.json";
import { developmentExecutionManifestSchema } from "./development-manifest";
import { createExp0001aAttemptProvisioningPlan } from "./exp0001a-attempt-provisioning";
import {
  EXP0001A_CODEX_REVIEW_SOURCE,
  computeExp0001aPairwiseReviewerRosterRoot,
  computeExp0001aPrimaryReviewerRosterRoot,
  createExp0001aCodexReviewPlanManifest,
  deriveExp0001aFrozenReviewerSubject,
  exp0001aCodexReviewPlanManifestSchema,
  verifyExp0001aCodexReviewPlanManifest,
} from "./exp0001a-codex-review-runtime";

describe("EXP-0001A provider-free Codex review plan", () => {
  const executionManifest = developmentExecutionManifestSchema.parse(executionManifestJson);

  it("reproduces the exact retained v1 reviewer identities without provider-era fields", () => {
    expect(EXP0001A_CODEX_REVIEW_SOURCE.sourceFreezeDigest).toBe(retainedFreezeV1Json.freezeDigest);
    expect(EXP0001A_CODEX_REVIEW_SOURCE.primaryAssignmentSeed)
      .toBe(retainedFreezeV1Json.reviewerPlan.rosterAssignmentSeed);
    expect(EXP0001A_CODEX_REVIEW_SOURCE.pairwisePromptDigest)
      .toBe(retainedFreezeV1Json.reviewerPlan.pairwisePreference.promptDigest);
    expect(EXP0001A_CODEX_REVIEW_SOURCE.primaryReviewerRoster)
      .toEqual(retainedFreezeV1Json.reviewerPlan.roster);
    expect(EXP0001A_CODEX_REVIEW_SOURCE.pairwiseReviewerRoster)
      .toEqual(retainedFreezeV1Json.reviewerPlan.pairwisePreference.roster);
    expect(computeExp0001aPairwiseReviewerRosterRoot(EXP0001A_CODEX_REVIEW_SOURCE.pairwiseReviewerRoster))
      .toBe(retainedFreezeV1Json.reviewerPlan.pairwisePreference.rosterRoot);
  });

  it("creates one deterministic manifest and is insensitive to caller object identity", () => {
    const first = createExp0001aCodexReviewPlanManifest({ executionManifest });
    const second = createExp0001aCodexReviewPlanManifest({
      executionManifest: structuredClone(executionManifest),
    });
    expect(second).toEqual(first);
    expect(first).toEqual(committedReviewPlanJson);
    expect(first.primaryReviewerRosterRoot).toBe("sha256:c2eeef52a25099d95110aa6dc524f914e3e32f35804982969245d0fadfacf818");
    expect(first.primaryReviewerRosterRoot)
      .toBe(computeExp0001aPrimaryReviewerRosterRoot(retainedFreezeV1Json.reviewerPlan.roster));
    expect(first.pairwiseAssignmentRoot).toBe("sha256:b5eb1a2e805879876ad12fb0f85e74f9c68512290cec4655c88d03ce6d72a62e");
    expect(first.pairwiseLeftRightRoot).toBe("sha256:ac99d7ca1fe67c4a73ababc1733c8681356e691602853da6b8502c691bf2e11b");
    expect(first.manifestDigest).toBe("sha256:595509ee99142d4c7e78a42a7034f4f28dfdba70b870819f59f74f8e88995e6c");
    expect(new Set(first.pairwiseAssignments.map((entry) => entry.reviewerId)).size).toBe(24);
    expect(first.pairwiseAssignments.map((entry) => entry.pairIndex)).toEqual([...Array(24).keys()]);
  });

  it("rejects a self-consistent caller-substituted roster or pair side", () => {
    const manifest = createExp0001aCodexReviewPlanManifest({ executionManifest });
    const substitutedRoster = structuredClone(manifest);
    substitutedRoster.primaryReviewerRoster[0]!.identityCommitment = `sha256:${"f".repeat(64)}`;
    expect(() => exp0001aCodexReviewPlanManifestSchema.parse(substitutedRoster)).toThrow();

    const substitutedSide = structuredClone(manifest);
    substitutedSide.pairwiseAssignments[0]!.canvas1Condition =
      substitutedSide.pairwiseAssignments[0]!.canvas1Condition === "A0" ? "A1" : "A0";
    expect(() => verifyExp0001aCodexReviewPlanManifest({
      manifest: substitutedSide,
      executionManifest,
    })).toThrow();
  });

  it("derives reviewer task, public requirement, and rubric only from the exact frozen attempt", () => {
    const provisioningPlan = createExp0001aAttemptProvisioningPlan();
    const attempt = provisioningPlan.attempts[0]!;
    const subject = deriveExp0001aFrozenReviewerSubject({
      provisioningPlan,
      assignmentId: attempt.assignmentId,
    });
    expect(subject).toMatchObject({
      taskId: attempt.taskId,
      taskFamily: attempt.taskFamily,
      taskCommitmentDigest: attempt.taskDigest,
      publicAuthorPacketDigest: attempt.publicAuthorPacketDigest,
      attemptPlanDigest: attempt.attemptPlanDigest,
    });
    expect(subject.publicRequirement).toContain("Create a readable service diagram");
    expect(subject.rubric.criterionIds).toEqual([
      "criterion-checkout-facts",
      "criterion-checkout-boundary",
      "criterion-checkout-readable",
    ]);
    expect(subject.rubric.allowedMechanismTags).toContain("SEM_RELATIONSHIP_MISSING");

    const substituted = structuredClone(provisioningPlan);
    substituted.attempts[0]!.publicAuthorPacket.publicTaskPacket.materials[0]!.content = "Substituted requirement";
    expect(() => deriveExp0001aFrozenReviewerSubject({
      provisioningPlan: substituted,
      assignmentId: attempt.assignmentId,
    })).toThrow(/PLAN_/);
  });
});
