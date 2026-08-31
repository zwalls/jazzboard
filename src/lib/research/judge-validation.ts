import { z } from "zod";

import { FROZEN_PRIMARY_FAILURE_CLASSES } from "./blinded-review-orchestration";

const stableId = z.string().trim().min(1).max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestamp = z.string().datetime({ offset: true });

export const blindBinaryRatingSchema = z.object({
  schemaVersion: z.literal(1),
  artifactId: stableId,
  reviewerId: stableId,
  reviewerRole: z.enum(["primary", "adjudicator"]),
  accepted: z.boolean(),
  primaryClass: stableId,
  evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  lockedAt: timestamp,
  treatmentLabelKnownAtLock: z.literal(false),
  pairedArtifactSeenBeforeLock: z.literal(false),
}).strict();

export type BlindBinaryRating = z.infer<typeof blindBinaryRatingSchema>;

export const judgeCalibrationInputSchema = z.object({
  schemaVersion: z.literal(1),
  reviewerPair: z.tuple([stableId, stableId]),
  primaryRatings: z.array(blindBinaryRatingSchema).min(2),
  adjudications: z.array(blindBinaryRatingSchema),
  treatmentMappingDecodedAt: timestamp.nullable(),
}).strict().superRefine((input, context) => {
  const [firstReviewer, secondReviewer] = input.reviewerPair;
  if (firstReviewer === secondReviewer) {
    context.addIssue({ code: "custom", path: ["reviewerPair"], message: "Primary reviewer identities must differ." });
  }

  const seen = new Set<string>();
  input.primaryRatings.forEach((rating, index) => {
    if (rating.reviewerRole !== "primary") {
      context.addIssue({ code: "custom", path: ["primaryRatings", index, "reviewerRole"], message: "Primary ratings must use the primary reviewer role." });
    }
    if (!input.reviewerPair.includes(rating.reviewerId)) {
      context.addIssue({ code: "custom", path: ["primaryRatings", index, "reviewerId"], message: "Primary rating came from an undeclared reviewer." });
    }
    const key = `${rating.artifactId}:${rating.reviewerId}`;
    if (seen.has(key)) {
      context.addIssue({ code: "custom", path: ["primaryRatings", index], message: "A reviewer may lock only one primary rating per artifact." });
    }
    seen.add(key);
  });

  input.adjudications.forEach((rating, index) => {
    if (rating.reviewerRole !== "adjudicator") {
      context.addIssue({ code: "custom", path: ["adjudications", index, "reviewerRole"], message: "Adjudications must use the adjudicator reviewer role." });
    }
    if (input.reviewerPair.includes(rating.reviewerId)) {
      context.addIssue({ code: "custom", path: ["adjudications", index, "reviewerId"], message: "An adjudicator must be independent of both primary reviewers." });
    }
  });

  const allRatings = [...input.primaryRatings, ...input.adjudications];
  if (input.treatmentMappingDecodedAt !== null) {
    const decodedAt = Date.parse(input.treatmentMappingDecodedAt);
    allRatings.forEach((rating, index) => {
      if (Date.parse(rating.lockedAt) >= decodedAt) {
        context.addIssue({
          code: "custom",
          path: [index < input.primaryRatings.length ? "primaryRatings" : "adjudications"],
          message: "Every blinded judgment must lock before treatment mapping is decoded.",
        });
      }
    });
  }
});

export type JudgeCalibrationInput = z.infer<typeof judgeCalibrationInputSchema>;

export type ArtifactJudgment = {
  artifactId: string;
  primaryRatings: readonly [BlindBinaryRating, BlindBinaryRating];
  binaryAgreement: boolean;
  classAgreement: boolean;
  requiresAdjudication: boolean;
  adjudication: BlindBinaryRating | null;
  accepted: boolean;
  /** Class-only disagreement is resolved by frozen precedence without a third review. */
  primaryClass: string;
  classResolution: "primary_class_agreement" | "frozen_precedence" | "binary_adjudication";
};

function resolveClassByFrozenPrecedence(left: string, right: string): string {
  return [left, right].sort((a, b) => {
    const leftRank = FROZEN_PRIMARY_FAILURE_CLASSES.indexOf(a as typeof FROZEN_PRIMARY_FAILURE_CLASSES[number]);
    const rightRank = FROZEN_PRIMARY_FAILURE_CLASSES.indexOf(b as typeof FROZEN_PRIMARY_FAILURE_CLASSES[number]);
    const normalizedLeft = leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank;
    const normalizedRight = rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank;
    return normalizedLeft - normalizedRight || a.localeCompare(b);
  })[0];
}

export type JudgeCalibrationResult = {
  schemaVersion: 1;
  artifactCount: number;
  agreementCount: number;
  disagreementCount: number;
  rawAgreement: number;
  classificationAgreementCount: number;
  classificationAgreementRate: number;
  positiveAgreement: number | null;
  negativeAgreement: number | null;
  cohenKappa: number | null;
  kappaEstimable: boolean;
  adjudicationCount: number;
  adjudicationRate: number;
  confusion: {
    bothAccept: number;
    firstOnlyAccept: number;
    secondOnlyAccept: number;
    bothReject: number;
  };
  thresholds: {
    minimumRawAgreement: number;
    minimumKappa: number;
    maximumAdjudicationRate: number;
  };
  diagnosticTriggers: string[];
  judgments: ArtifactJudgment[];
};

function safeAgreement(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Validates independent locked ratings and resolves only genuine disagreement
 * through a third reviewer. The original ratings remain part of every result.
 */
export function validateAndResolveJudges(raw: unknown): JudgeCalibrationResult {
  const input = judgeCalibrationInputSchema.parse(raw);
  const [firstReviewer, secondReviewer] = input.reviewerPair;
  const byArtifact = new Map<string, BlindBinaryRating[]>();
  for (const rating of input.primaryRatings) {
    const ratings = byArtifact.get(rating.artifactId) ?? [];
    ratings.push(rating);
    byArtifact.set(rating.artifactId, ratings);
  }

  const adjudicationsByArtifact = new Map<string, BlindBinaryRating>();
  for (const rating of input.adjudications) {
    if (adjudicationsByArtifact.has(rating.artifactId)) {
      throw new Error(`Artifact ${rating.artifactId} has multiple adjudications.`);
    }
    adjudicationsByArtifact.set(rating.artifactId, rating);
  }

  let bothAccept = 0;
  let firstOnlyAccept = 0;
  let secondOnlyAccept = 0;
  let bothReject = 0;
  const judgments: ArtifactJudgment[] = [];

  for (const artifactId of [...byArtifact.keys()].sort()) {
    const ratings = byArtifact.get(artifactId) ?? [];
    const first = ratings.find((rating) => rating.reviewerId === firstReviewer);
    const second = ratings.find((rating) => rating.reviewerId === secondReviewer);
    if (ratings.length !== 2 || !first || !second) {
      throw new Error(`Artifact ${artifactId} requires exactly one locked rating from each primary reviewer.`);
    }

    const binaryAgreement = first.accepted === second.accepted;
    const classAgreement = first.primaryClass === second.primaryClass;
    const requiresAdjudication = !binaryAgreement;
    const adjudication = adjudicationsByArtifact.get(artifactId) ?? null;
    if (requiresAdjudication && adjudication === null) {
      throw new Error(`Artifact ${artifactId} requires independent adjudication.`);
    }
    if (!requiresAdjudication && adjudication !== null) {
      throw new Error(`Artifact ${artifactId} agreed and must not receive outcome-selective adjudication.`);
    }

    if (first.accepted && second.accepted) bothAccept += 1;
    else if (first.accepted) firstOnlyAccept += 1;
    else if (second.accepted) secondOnlyAccept += 1;
    else bothReject += 1;

    judgments.push({
      artifactId,
      primaryRatings: [first, second],
      binaryAgreement,
      classAgreement,
      requiresAdjudication,
      adjudication,
      accepted: requiresAdjudication ? (adjudication as BlindBinaryRating).accepted : first.accepted,
      primaryClass: requiresAdjudication
        ? (adjudication as BlindBinaryRating).primaryClass
        : classAgreement ? first.primaryClass : resolveClassByFrozenPrecedence(first.primaryClass, second.primaryClass),
      classResolution: requiresAdjudication
        ? "binary_adjudication"
        : classAgreement ? "primary_class_agreement" : "frozen_precedence",
    });
  }

  const orphanAdjudications = [...adjudicationsByArtifact.keys()]
    .filter((artifactId) => !byArtifact.has(artifactId));
  if (orphanAdjudications.length > 0) {
    throw new Error(`Adjudications reference unknown artifacts: ${orphanAdjudications.sort().join(", ")}`);
  }

  const artifactCount = judgments.length;
  const binaryAgreementCount = bothAccept + bothReject;
  const acceptanceByFirst = (bothAccept + firstOnlyAccept) / artifactCount;
  const acceptanceBySecond = (bothAccept + secondOnlyAccept) / artifactCount;
  const observedBinaryAgreement = binaryAgreementCount / artifactCount;
  const expectedAgreement = acceptanceByFirst * acceptanceBySecond
    + (1 - acceptanceByFirst) * (1 - acceptanceBySecond);
  const kappaEstimable = expectedAgreement < 1;
  const cohenKappa = kappaEstimable
    ? (observedBinaryAgreement - expectedAgreement) / (1 - expectedAgreement)
    : null;

  const agreementCount = binaryAgreementCount;
  const classificationAgreementCount = judgments.filter((judgment) => judgment.classAgreement).length;
  const adjudicationCount = judgments.filter((judgment) => judgment.adjudication !== null).length;
  const rawAgreement = agreementCount / artifactCount;
  const adjudicationRate = adjudicationCount / artifactCount;
  const thresholds = {
    minimumRawAgreement: 0.8,
    minimumKappa: 0.6,
    maximumAdjudicationRate: 0.2,
  };
  const diagnosticTriggers = [
    rawAgreement < thresholds.minimumRawAgreement && "RAW_AGREEMENT_BELOW_0_80",
    !kappaEstimable && "KAPPA_NOT_ESTIMABLE",
    kappaEstimable && (cohenKappa as number) < thresholds.minimumKappa && "KAPPA_BELOW_0_60",
    adjudicationRate > thresholds.maximumAdjudicationRate && "ADJUDICATION_RATE_ABOVE_0_20",
  ].filter((trigger): trigger is string => Boolean(trigger));

  return {
    schemaVersion: 1,
    artifactCount,
    agreementCount,
    disagreementCount: artifactCount - agreementCount,
    rawAgreement,
    classificationAgreementCount,
    classificationAgreementRate: classificationAgreementCount / artifactCount,
    positiveAgreement: safeAgreement(2 * bothAccept, 2 * bothAccept + firstOnlyAccept + secondOnlyAccept),
    negativeAgreement: safeAgreement(2 * bothReject, 2 * bothReject + firstOnlyAccept + secondOnlyAccept),
    cohenKappa,
    kappaEstimable,
    adjudicationCount,
    adjudicationRate,
    confusion: { bothAccept, firstOnlyAccept, secondOnlyAccept, bothReject },
    thresholds,
    diagnosticTriggers,
    judgments,
  };
}
