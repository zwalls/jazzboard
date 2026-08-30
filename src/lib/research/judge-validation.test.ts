import { describe, expect, it } from "vitest";

import judgeFixture from "../../../research/fixtures/judge-calibration-v1.json";

import { hashCanonicalJson } from "./provenance-crypto";
import {
  judgeCalibrationInputSchema,
  validateAndResolveJudges,
  type BlindBinaryRating,
} from "./judge-validation";

const reviewers: [string, string] = ["reviewer_alpha", "reviewer_beta"];

function rating(input: {
  artifactId: string;
  reviewerId: string;
  accepted: boolean;
  primaryClass?: string;
  reviewerRole?: "primary" | "adjudicator";
  lockedAt?: string;
}): BlindBinaryRating {
  return {
    schemaVersion: 1,
    artifactId: input.artifactId,
    reviewerId: input.reviewerId,
    reviewerRole: input.reviewerRole ?? "primary",
    accepted: input.accepted,
    primaryClass: input.primaryClass ?? (input.accepted ? "SUCCESS" : "FAIL_SEMANTIC"),
    evidenceDigest: hashCanonicalJson({ artifactId: input.artifactId }),
    lockedAt: input.lockedAt ?? "2026-08-30T20:00:00.000Z",
    treatmentLabelKnownAtLock: false,
    pairedArtifactSeenBeforeLock: false,
  };
}

describe("judge validation", () => {
  it("replays the checked-in calibration fixture above every preregistered diagnostic threshold", () => {
    const result = validateAndResolveJudges(judgeFixture);

    expect(result).toMatchObject({
      artifactCount: 10,
      agreementCount: 9,
      rawAgreement: 0.9,
      classificationAgreementRate: 0.9,
      cohenKappa: 0.8,
      adjudicationCount: 1,
      adjudicationRate: 0.1,
      diagnosticTriggers: [],
    });
  });

  it("retains both ratings, resolves disagreements, and computes agreement diagnostics", () => {
    const primaryRatings = [
      rating({ artifactId: "artifact_1", reviewerId: reviewers[0], accepted: true }),
      rating({ artifactId: "artifact_1", reviewerId: reviewers[1], accepted: true }),
      rating({ artifactId: "artifact_2", reviewerId: reviewers[0], accepted: false }),
      rating({ artifactId: "artifact_2", reviewerId: reviewers[1], accepted: false }),
      rating({ artifactId: "artifact_3", reviewerId: reviewers[0], accepted: true }),
      rating({ artifactId: "artifact_3", reviewerId: reviewers[1], accepted: false }),
      rating({ artifactId: "artifact_4", reviewerId: reviewers[0], accepted: false }),
      rating({ artifactId: "artifact_4", reviewerId: reviewers[1], accepted: true }),
      rating({ artifactId: "artifact_5", reviewerId: reviewers[0], accepted: true }),
      rating({ artifactId: "artifact_5", reviewerId: reviewers[1], accepted: true }),
    ];
    const result = validateAndResolveJudges({
      schemaVersion: 1,
      reviewerPair: reviewers,
      primaryRatings,
      adjudications: [
        rating({ artifactId: "artifact_3", reviewerId: "reviewer_gamma", reviewerRole: "adjudicator", accepted: false }),
        rating({ artifactId: "artifact_4", reviewerId: "reviewer_gamma", reviewerRole: "adjudicator", accepted: true }),
      ],
      treatmentMappingDecodedAt: "2026-08-30T21:00:00.000Z",
    });

    expect(result.artifactCount).toBe(5);
    expect(result.confusion).toEqual({
      bothAccept: 2,
      firstOnlyAccept: 1,
      secondOnlyAccept: 1,
      bothReject: 1,
    });
    expect(result.rawAgreement).toBe(0.6);
    expect(result.classificationAgreementRate).toBe(0.6);
    expect(result.adjudicationRate).toBe(0.4);
    expect(result.cohenKappa).toBeCloseTo(1 / 6, 10);
    expect(result.diagnosticTriggers).toEqual([
      "RAW_AGREEMENT_BELOW_0_80",
      "KAPPA_BELOW_0_60",
      "ADJUDICATION_RATE_ABOVE_0_20",
    ]);
    expect(result.judgments.find((item) => item.artifactId === "artifact_3")?.accepted).toBe(false);
    expect(result.judgments.every((item) => item.primaryRatings.length === 2)).toBe(true);
  });

  it("reports binary and primary-class agreement separately while still adjudicating class disputes", () => {
    const result = validateAndResolveJudges({
      schemaVersion: 1,
      reviewerPair: reviewers,
      primaryRatings: [
        rating({ artifactId: "artifact_1", reviewerId: reviewers[0], accepted: false, primaryClass: "FAIL_SEMANTIC" }),
        rating({ artifactId: "artifact_1", reviewerId: reviewers[1], accepted: false, primaryClass: "FAIL_GEOMETRY_VISUAL" }),
      ],
      adjudications: [rating({
        artifactId: "artifact_1",
        reviewerId: "reviewer_gamma",
        reviewerRole: "adjudicator",
        accepted: false,
        primaryClass: "FAIL_SEMANTIC",
      })],
      treatmentMappingDecodedAt: null,
    });

    expect(result.rawAgreement).toBe(1);
    expect(result.classificationAgreementRate).toBe(0);
    expect(result.adjudicationRate).toBe(1);
    expect(result.judgments[0]).toMatchObject({
      binaryAgreement: true,
      classAgreement: false,
      requiresAdjudication: true,
      primaryClass: "FAIL_SEMANTIC",
    });
  });

  it("requires adjudication for disagreement and forbids outcome-selective adjudication", () => {
    const disagreeing = [
      rating({ artifactId: "artifact_1", reviewerId: reviewers[0], accepted: true }),
      rating({ artifactId: "artifact_1", reviewerId: reviewers[1], accepted: false }),
    ];
    expect(() => validateAndResolveJudges({
      schemaVersion: 1,
      reviewerPair: reviewers,
      primaryRatings: disagreeing,
      adjudications: [],
      treatmentMappingDecodedAt: null,
    })).toThrow(/requires independent adjudication/);

    const agreeing = [
      rating({ artifactId: "artifact_1", reviewerId: reviewers[0], accepted: true }),
      rating({ artifactId: "artifact_1", reviewerId: reviewers[1], accepted: true }),
    ];
    expect(() => validateAndResolveJudges({
      schemaVersion: 1,
      reviewerPair: reviewers,
      primaryRatings: agreeing,
      adjudications: [rating({
        artifactId: "artifact_1",
        reviewerId: "reviewer_gamma",
        reviewerRole: "adjudicator",
        accepted: false,
      })],
      treatmentMappingDecodedAt: null,
    })).toThrow(/must not receive outcome-selective adjudication/);
  });

  it("rejects label leakage, paired-artifact exposure, late locks, and reused adjudicators", () => {
    const leaked = {
      ...rating({ artifactId: "artifact_1", reviewerId: reviewers[0], accepted: true }),
      treatmentLabelKnownAtLock: true,
    };
    expect(judgeCalibrationInputSchema.safeParse({
      schemaVersion: 1,
      reviewerPair: reviewers,
      primaryRatings: [
        leaked,
        rating({ artifactId: "artifact_1", reviewerId: reviewers[1], accepted: true }),
      ],
      adjudications: [],
      treatmentMappingDecodedAt: null,
    }).success).toBe(false);

    expect(judgeCalibrationInputSchema.safeParse({
      schemaVersion: 1,
      reviewerPair: reviewers,
      primaryRatings: [
        rating({ artifactId: "artifact_1", reviewerId: reviewers[0], accepted: true, lockedAt: "2026-08-30T22:00:00.000Z" }),
        rating({ artifactId: "artifact_1", reviewerId: reviewers[1], accepted: true }),
      ],
      adjudications: [],
      treatmentMappingDecodedAt: "2026-08-30T21:00:00.000Z",
    }).success).toBe(false);

    expect(judgeCalibrationInputSchema.safeParse({
      schemaVersion: 1,
      reviewerPair: reviewers,
      primaryRatings: [
        rating({ artifactId: "artifact_1", reviewerId: reviewers[0], accepted: true }),
        rating({ artifactId: "artifact_1", reviewerId: reviewers[1], accepted: false }),
      ],
      adjudications: [rating({
        artifactId: "artifact_1",
        reviewerId: reviewers[0],
        reviewerRole: "adjudicator",
        accepted: true,
      })],
      treatmentMappingDecodedAt: null,
    }).success).toBe(false);
  });

  it("reports degenerate marginals without inventing a kappa value", () => {
    const result = validateAndResolveJudges({
      schemaVersion: 1,
      reviewerPair: reviewers,
      primaryRatings: [
        rating({ artifactId: "artifact_1", reviewerId: reviewers[0], accepted: true }),
        rating({ artifactId: "artifact_1", reviewerId: reviewers[1], accepted: true }),
        rating({ artifactId: "artifact_2", reviewerId: reviewers[0], accepted: true }),
        rating({ artifactId: "artifact_2", reviewerId: reviewers[1], accepted: true }),
      ],
      adjudications: [],
      treatmentMappingDecodedAt: null,
    });
    expect(result.kappaEstimable).toBe(false);
    expect(result.cohenKappa).toBeNull();
    expect(result.diagnosticTriggers).toContain("KAPPA_NOT_ESTIMABLE");
  });
});
