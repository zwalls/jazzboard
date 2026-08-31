/**
 * Public, synthetic infrastructure fixture for the rendered-gold rater gate.
 *
 * These records are deliberately small and fabricated. They exercise schema,
 * blinding, retention, and analysis code; they are not empirical evidence of
 * reviewer validity and can never satisfy graduation.
 */

import {
  computePublicGoldManifestDigest,
  computePublicGoldPlanDigest,
  computePublicGoldReviewRecordDigest,
  computePublicGoldThresholdsDigest,
} from "../../src/lib/research/public-gold-schemas";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const rubricDigest = digest("9");
const failureTaxonomyDigest = digest("0");
const criterionIds = ["criterion-semantic", "criterion-visual"] as const;

type ArtifactEvidence = {
  artifactId: string;
  artifactDigest: string;
  renderDigest: string;
  semanticStateDigest: string;
};

function rating(
  evidence: ArtifactEvidence,
  ratingId: string,
  raterIdentityId: string,
  role: "primary" | "adjudicator",
  decisions: readonly ["pass" | "fail", "pass" | "fail"],
  primaryClass: string,
  mechanismTags: string[],
  lockedAt: string,
  criticalIntegrityIncident = false,
) {
  return {
    ratingId,
    artifactId: evidence.artifactId,
    raterIdentityId,
    role,
    accepted: decisions.every((decision) => decision === "pass"),
    criteria: criterionIds.map((criterionId, index) => ({
      criterionId,
      decision: decisions[index],
      evidenceDigests: [index === 0 ? evidence.semanticStateDigest : evidence.renderDigest],
    })),
    primaryClass,
    mechanismTags,
    criticalIntegrityIncident,
    artifactDigest: evidence.artifactDigest,
    renderDigest: evidence.renderDigest,
    semanticStateDigest: evidence.semanticStateDigest,
    rubricDigest,
    failureTaxonomyDigest,
    lockedAt,
  };
}

const archSourceEvidence = {
  artifactId: "artifact-arch-source",
  artifactDigest: digest("a"),
  renderDigest: digest("b"),
  semanticStateDigest: digest("c"),
};
const archCorruptEvidence = {
  artifactId: "artifact-arch-corrupt",
  artifactDigest: digest("d"),
  renderDigest: digest("e"),
  semanticStateDigest: digest("f"),
};
const drawingSourceEvidence = {
  artifactId: "artifact-drawing-source",
  artifactDigest: digest("1"),
  renderDigest: digest("2"),
  semanticStateDigest: digest("3"),
};
const drawingCorruptEvidence = {
  artifactId: "artifact-drawing-corrupt",
  artifactDigest: digest("4"),
  renderDigest: digest("5"),
  semanticStateDigest: digest("6"),
};

const publicGoldInfrastructureManifestMutable = {
  schemaVersion: 1,
  corpusId: "public-gold-infrastructure-v1",
  corpusVersion: "version-1",
  corpusKind: "infrastructure_fixture",
  partition: "public_development",
  containsSealedMaterial: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  goldLockedAt: "2026-08-03T12:00:00.000Z",
  evaluationOpenedAt: "2026-08-04T00:00:00.000Z",
  goldLockedWithoutEvaluatedOutputs: true,
  manifestDigest: digest("8"),
  identities: [
    { identityId: "author-architecture", role: "corpus_author", qualificationDigest: digest("a") },
    { identityId: "author-drawing", role: "corpus_author", qualificationDigest: digest("b") },
    { identityId: "gold-adjudicator", role: "gold_adjudicator", qualificationDigest: digest("c") },
    { identityId: "gold-rater-one", role: "gold_primary_rater", qualificationDigest: digest("d") },
    { identityId: "gold-rater-two", role: "gold_primary_rater", qualificationDigest: digest("e") },
    { identityId: "model-adjudicator", role: "evaluated_reviewer", qualificationDigest: digest("1"), reviewerCapabilities: ["adjudicator"] },
    { identityId: "model-primary-measurement", role: "evaluated_reviewer", qualificationDigest: digest("2"), reviewerCapabilities: ["primary_measurement"] },
    { identityId: "model-primary-standard", role: "evaluated_reviewer", qualificationDigest: digest("3"), reviewerCapabilities: ["primary_standard"] },
  ],
  rubric: {
    rubricId: "public-gold-rubric-v1",
    rubricDigest,
    criteria: [
      { criterionId: "criterion-semantic", criterionDigest: digest("7") },
      { criterionId: "criterion-visual", criterionDigest: digest("8") },
    ],
  },
  failureTaxonomy: {
    taxonomyId: "public-gold-infrastructure-taxonomy-v1",
    taxonomyDigest: failureTaxonomyDigest,
    primaryClasses: [
      "SUCCESS",
      "FAIL_PROTOCOL_VIOLATION",
      "FAIL_PRIVACY_INTEGRITY",
      "FAIL_EVALUATOR_SCORER",
      "FAIL_INFRASTRUCTURE",
      "FAIL_WEBMCP_TOOLING",
      "FAIL_TRANSACTION_REVISION_LEASE",
      "FAIL_TEMPORAL_PRESENTATION",
      "FAIL_AUTHOR_NONCOMPLETION",
      "FAIL_SEMANTIC",
      "FAIL_GEOMETRY_VISUAL",
      "FAIL_INSPECTION_CORRECTION",
    ],
    mechanismTags: ["SEM_RELATIONSHIP_MISSING", "VIS_RECOGNIZABILITY_OR_COMPOSITION", "VIS_WEAK_HIERARCHY_OR_CONTRAST"],
  },
  corruptionOperators: [
    {
      operatorId: "remove-relationship",
      operatorVersion: "version-1",
      family: "semantic",
      implementationDigest: digest("1"),
      frozenAt: "2026-07-31T00:00:00.000Z",
    },
    {
      operatorId: "remove-defining-feature",
      operatorVersion: "version-1",
      family: "drawing_specific",
      implementationDigest: digest("2"),
      frozenAt: "2026-07-31T00:00:00.000Z",
    },
  ],
  sourceClusters: [
    {
      sourceClusterId: "cluster-architecture-one",
      domain: "architecture",
      sourceExemplarArtifactId: "artifact-arch-source",
      artifactIds: ["artifact-arch-corrupt", "artifact-arch-source"],
      sourceProvenanceDigest: digest("3"),
      authorIdentityId: "author-architecture",
    },
    {
      sourceClusterId: "cluster-drawing-one",
      domain: "drawing",
      sourceExemplarArtifactId: "artifact-drawing-source",
      artifactIds: ["artifact-drawing-corrupt", "artifact-drawing-source"],
      sourceProvenanceDigest: digest("4"),
      authorIdentityId: "author-drawing",
    },
  ],
  artifacts: [
    {
      ...archSourceEvidence,
      sourceClusterId: "cluster-architecture-one",
      domain: "architecture",
      artifactKind: "source_exemplar",
      creatorIdentityId: "author-architecture",
      rubricDigest,
      integrityEvidenceDigest: digest("a"),
      createdAt: "2026-08-01T01:00:00.000Z",
      corruption: null,
      gold: {
        primaryRatings: [
          rating(archSourceEvidence, "rating-arch-source-one", "gold-rater-one", "primary", ["pass", "pass"], "SUCCESS", [], "2026-08-03T09:00:00.000Z"),
          rating(archSourceEvidence, "rating-arch-source-two", "gold-rater-two", "primary", ["pass", "pass"], "SUCCESS", [], "2026-08-03T09:01:00.000Z"),
        ],
        adjudication: null,
      },
    },
    {
      ...archCorruptEvidence,
      sourceClusterId: "cluster-architecture-one",
      domain: "architecture",
      artifactKind: "corruption_variant",
      creatorIdentityId: "author-architecture",
      rubricDigest,
      integrityEvidenceDigest: digest("b"),
      createdAt: "2026-08-02T01:00:00.000Z",
      corruption: {
        operatorId: "remove-relationship",
        operatorVersion: "version-1",
        family: "semantic",
        parentArtifactId: "artifact-arch-source",
        parentArtifactDigest: archSourceEvidence.artifactDigest,
        mutationDigest: digest("c"),
        targetCriterionIds: ["criterion-semantic"],
        generatorIdentityId: "author-architecture",
        generatedAt: "2026-08-02T01:00:00.000Z",
        establishesAcceptance: false,
      },
      gold: {
        primaryRatings: [
          rating(archCorruptEvidence, "rating-arch-corrupt-one", "gold-rater-one", "primary", ["fail", "pass"], "FAIL_SEMANTIC", ["SEM_RELATIONSHIP_MISSING"], "2026-08-03T09:10:00.000Z"),
          rating(archCorruptEvidence, "rating-arch-corrupt-two", "gold-rater-two", "primary", ["pass", "pass"], "SUCCESS", [], "2026-08-03T09:11:00.000Z"),
        ],
        adjudication: rating(archCorruptEvidence, "rating-arch-corrupt-adjudicated", "gold-adjudicator", "adjudicator", ["fail", "pass"], "FAIL_SEMANTIC", ["SEM_RELATIONSHIP_MISSING"], "2026-08-03T10:00:00.000Z"),
      },
    },
    {
      ...drawingSourceEvidence,
      sourceClusterId: "cluster-drawing-one",
      domain: "drawing",
      artifactKind: "source_exemplar",
      creatorIdentityId: "author-drawing",
      rubricDigest,
      integrityEvidenceDigest: null,
      createdAt: "2026-08-01T02:00:00.000Z",
      corruption: null,
      gold: {
        primaryRatings: [
          rating(drawingSourceEvidence, "rating-drawing-source-one", "gold-rater-one", "primary", ["pass", "pass"], "SUCCESS", [], "2026-08-03T09:20:00.000Z"),
          rating(drawingSourceEvidence, "rating-drawing-source-two", "gold-rater-two", "primary", ["pass", "pass"], "SUCCESS", [], "2026-08-03T09:21:00.000Z"),
        ],
        adjudication: null,
      },
    },
    {
      ...drawingCorruptEvidence,
      sourceClusterId: "cluster-drawing-one",
      domain: "drawing",
      artifactKind: "corruption_variant",
      creatorIdentityId: "author-drawing",
      rubricDigest,
      integrityEvidenceDigest: null,
      createdAt: "2026-08-02T02:00:00.000Z",
      corruption: {
        operatorId: "remove-defining-feature",
        operatorVersion: "version-1",
        family: "drawing_specific",
        parentArtifactId: "artifact-drawing-source",
        parentArtifactDigest: drawingSourceEvidence.artifactDigest,
        mutationDigest: digest("d"),
        targetCriterionIds: ["criterion-visual"],
        generatorIdentityId: "author-drawing",
        generatedAt: "2026-08-02T02:00:00.000Z",
        establishesAcceptance: false,
      },
      gold: {
        primaryRatings: [
          rating(drawingCorruptEvidence, "rating-drawing-corrupt-one", "gold-rater-one", "primary", ["pass", "fail"], "FAIL_GEOMETRY_VISUAL", ["VIS_RECOGNIZABILITY_OR_COMPOSITION"], "2026-08-03T09:30:00.000Z"),
          rating(drawingCorruptEvidence, "rating-drawing-corrupt-two", "gold-rater-two", "primary", ["pass", "fail"], "FAIL_GEOMETRY_VISUAL", ["VIS_RECOGNIZABILITY_OR_COMPOSITION"], "2026-08-03T09:31:00.000Z"),
        ],
        adjudication: null,
      },
    },
  ],
  graduationThresholds: {
    thresholdsId: "public-gold-thresholds-v1",
    thresholdsDigest: digest("7"),
    frozenAt: "2026-07-31T12:00:00.000Z",
    selectedWithoutEvaluatedOutputs: true,
    minimumArchitectureSensitivityWilsonLower95: 0.8,
    minimumArchitectureSpecificityWilsonLower95: 0.8,
    minimumDrawingSensitivityWilsonLower95: 0.8,
    minimumDrawingSpecificityWilsonLower95: 0.8,
    maximumNonEvaluableRate: 0.05,
    maximumDomainFalseAcceptRateGap: 0.1,
    criticalIntegrityFalseAcceptMaximum: 0,
    minimumSourceClustersPerDomain: 2,
    clusterBootstrapSeed: 1_592_639_215,
    clusterBootstrapDrawCount: 1_000,
  },
};
publicGoldInfrastructureManifestMutable.graduationThresholds.thresholdsDigest = computePublicGoldThresholdsDigest(
  publicGoldInfrastructureManifestMutable.graduationThresholds,
);
publicGoldInfrastructureManifestMutable.manifestDigest = computePublicGoldManifestDigest(publicGoldInfrastructureManifestMutable);
export const publicGoldInfrastructureManifestV1 = publicGoldInfrastructureManifestMutable;

const publicGoldInfrastructurePlanMutable = {
  schemaVersion: 1,
  planId: "public-gold-infrastructure-plan-v1",
  planDigest: digest("0"),
  corpusId: "public-gold-infrastructure-v1",
  corpusManifestDigest: publicGoldInfrastructureManifestV1.manifestDigest,
  frozenAt: "2026-08-03T11:00:00.000Z",
  randomizedOrderSeedDigest: digest("0"),
  entries: [
    { evaluationId: "evaluation-001", caseId: "case-001", artifactId: "artifact-drawing-corrupt", contextId: "context-001", order: 0, primaryReviewerIdentityIds: ["model-primary-measurement", "model-primary-standard"], adjudicatorReviewerIdentityId: "model-adjudicator" },
    { evaluationId: "evaluation-002", caseId: "case-002", artifactId: "artifact-arch-source", contextId: "context-002", order: 1, primaryReviewerIdentityIds: ["model-primary-measurement", "model-primary-standard"], adjudicatorReviewerIdentityId: "model-adjudicator" },
    { evaluationId: "evaluation-003", caseId: "case-003", artifactId: "artifact-drawing-source", contextId: "context-003", order: 2, primaryReviewerIdentityIds: ["model-primary-measurement", "model-primary-standard"], adjudicatorReviewerIdentityId: "model-adjudicator" },
    { evaluationId: "evaluation-004", caseId: "case-004", artifactId: "artifact-arch-corrupt", contextId: "context-004", order: 3, primaryReviewerIdentityIds: ["model-primary-measurement", "model-primary-standard"], adjudicatorReviewerIdentityId: "model-adjudicator" },
  ],
  contexts: [
    { contextId: "context-001", caseIds: ["case-001"] },
    { contextId: "context-002", caseIds: ["case-002"] },
    { contextId: "context-003", caseIds: ["case-003"] },
    { contextId: "context-004", caseIds: ["case-004"] },
  ],
  blinding: {
    referenceLabelsVisible: false,
    corruptionProvenanceVisible: false,
    sourceClusterVisible: false,
    relatedArtifactsVisible: false,
  },
  reviewPolicy: {
    primaryRoleOrder: ["measurement", "standard"],
    requiredPrimaryCount: 2,
    adjudicationTrigger: "binary_acceptance_disagreement_only",
    classOnlyDisagreementResolution: "frozen_taxonomy_precedence_without_adjudication",
    adjudicatorCapabilityRequired: true,
  },
  analysisConfig: {
    clusterBootstrapSeed: 1_592_639_215,
    clusterBootstrapDrawCount: 1_000,
    confidenceLevel: 0.95,
  },
};
publicGoldInfrastructurePlanMutable.planDigest = computePublicGoldPlanDigest(publicGoldInfrastructurePlanMutable);
export const publicGoldInfrastructurePlanV1 = publicGoldInfrastructurePlanMutable;

function recordEvidence(evidence: ArtifactEvidence) {
  return {
    artifactDigest: evidence.artifactDigest,
    renderDigest: evidence.renderDigest,
    semanticStateDigest: evidence.semanticStateDigest,
    rubricDigest,
    failureTaxonomyDigest,
    corpusManifestDigest: publicGoldInfrastructureManifestV1.manifestDigest,
    planDigest: publicGoldInfrastructurePlanV1.planDigest,
  };
}

function primaryResult(
  decisions: readonly ["pass" | "fail", "pass" | "fail"],
  primaryClass: string,
  mechanismTags: string[],
) {
  return {
    resultKind: "primary",
    accepted: decisions.every((decision) => decision === "pass"),
    criteria: criterionIds.map((criterionId, index) => ({ criterionId, decision: decisions[index] })),
    primaryClass,
    mechanismTags,
    criticalIntegrityIncident: false,
    evidenceCoverageComplete: true,
  };
}

function retainedRecord(input: {
  callId: string;
  evaluationId: string;
  caseId: string;
  evidence: ArtifactEvidence;
  reviewerRole: "primary_measurement" | "primary_standard" | "adjudicator";
  evaluatorIdentityId: string;
  minute: number;
  primaryLockedEvaluatorRecordDigests?: [string, string];
  terminal: Record<string, unknown>;
}) {
  const minute = String(input.minute).padStart(2, "0");
  const terminalResult = input.terminal.result as Record<string, unknown> | null;
  const lockedReviewerRole = input.reviewerRole === "adjudicator" ? "adjudicator" : "primary";
  const lockedEvaluatorProjection = input.terminal.status === "completed" && terminalResult !== null
    ? {
        status: "scored",
        reviewerRole: lockedReviewerRole,
        accepted: terminalResult.accepted,
        primaryFailureClass: terminalResult.primaryClass,
        result: terminalResult,
      }
    : {
        status: "failed",
        reviewerRole: lockedReviewerRole,
        accepted: false,
        primaryFailureClass: "FAIL_EVALUATOR_SCORER",
        result: null,
      };
  const content = {
    schemaVersion: 1,
    recordDigest: digest("0"),
    lockedEvaluatorRecordDigest: digest(String((input.minute % 9) + 1)),
    lockedEvaluatorProjection,
    callId: input.callId,
    evaluationId: input.evaluationId,
    caseId: input.caseId,
    evaluatorIdentityId: input.evaluatorIdentityId,
    reviewerRole: input.reviewerRole,
    providerModelId: "synthetic-infrastructure-reviewer",
    begunAt: `2026-08-04T00:${minute}:00.000Z`,
    finishedAt: `2026-08-04T00:${minute}:01.000Z`,
    requestDigest: digest(String((input.minute % 9) + 1)),
    ...recordEvidence(input.evidence),
    primaryLockedEvaluatorRecordDigests: input.primaryLockedEvaluatorRecordDigests ?? null,
    providerIdentityVerification: { status: "unverified", evidenceDigest: null, reasonCode: "synthetic-no-provider-call" },
    provenanceVerification: { status: "verified", evidenceDigest: digest(String(((input.minute + 1) % 9) + 1)) },
    referenceLabelKnown: false,
    siblingVariantSeen: false,
    ...input.terminal,
  };
  content.recordDigest = computePublicGoldReviewRecordDigest(content);
  return content;
}

const retainedPrimaryRecords = [
  retainedRecord({
    callId: "call-001-measurement", evaluationId: "evaluation-001", caseId: "case-001", evidence: drawingCorruptEvidence,
    reviewerRole: "primary_measurement", evaluatorIdentityId: "model-primary-measurement", minute: 0,
    terminal: { responseDigest: null, status: "failed", failurePreserved: true, providerCallMayHaveOccurred: false, failureCode: "synthetic-failure", result: null },
  }),
  retainedRecord({
    callId: "call-001-standard", evaluationId: "evaluation-001", caseId: "case-001", evidence: drawingCorruptEvidence,
    reviewerRole: "primary_standard", evaluatorIdentityId: "model-primary-standard", minute: 1,
    terminal: { responseDigest: digest("1"), status: "completed", result: primaryResult(["pass", "fail"], "FAIL_GEOMETRY_VISUAL", ["VIS_RECOGNIZABILITY_OR_COMPOSITION"]) },
  }),
  retainedRecord({
    callId: "call-002-measurement", evaluationId: "evaluation-002", caseId: "case-002", evidence: archSourceEvidence,
    reviewerRole: "primary_measurement", evaluatorIdentityId: "model-primary-measurement", minute: 2,
    terminal: { responseDigest: digest("2"), status: "completed", result: primaryResult(["pass", "pass"], "SUCCESS", []) },
  }),
  retainedRecord({
    callId: "call-002-standard", evaluationId: "evaluation-002", caseId: "case-002", evidence: archSourceEvidence,
    reviewerRole: "primary_standard", evaluatorIdentityId: "model-primary-standard", minute: 3,
    terminal: { responseDigest: digest("3"), status: "completed", result: primaryResult(["pass", "pass"], "SUCCESS", []) },
  }),
  retainedRecord({
    callId: "call-003-measurement", evaluationId: "evaluation-003", caseId: "case-003", evidence: drawingSourceEvidence,
    reviewerRole: "primary_measurement", evaluatorIdentityId: "model-primary-measurement", minute: 4,
    terminal: { responseDigest: digest("4"), status: "completed", result: primaryResult(["pass", "fail"], "FAIL_GEOMETRY_VISUAL", ["VIS_WEAK_HIERARCHY_OR_CONTRAST"]) },
  }),
  retainedRecord({
    callId: "call-003-standard", evaluationId: "evaluation-003", caseId: "case-003", evidence: drawingSourceEvidence,
    reviewerRole: "primary_standard", evaluatorIdentityId: "model-primary-standard", minute: 5,
    terminal: { responseDigest: digest("5"), status: "completed", result: primaryResult(["fail", "pass"], "FAIL_SEMANTIC", ["SEM_RELATIONSHIP_MISSING"]) },
  }),
  retainedRecord({
    callId: "call-004-measurement", evaluationId: "evaluation-004", caseId: "case-004", evidence: archCorruptEvidence,
    reviewerRole: "primary_measurement", evaluatorIdentityId: "model-primary-measurement", minute: 6,
    terminal: { responseDigest: digest("6"), status: "completed", result: primaryResult(["fail", "pass"], "FAIL_SEMANTIC", ["SEM_RELATIONSHIP_MISSING"]) },
  }),
  retainedRecord({
    callId: "call-004-standard", evaluationId: "evaluation-004", caseId: "case-004", evidence: archCorruptEvidence,
    reviewerRole: "primary_standard", evaluatorIdentityId: "model-primary-standard", minute: 7,
    terminal: { responseDigest: digest("7"), status: "completed", result: primaryResult(["pass", "pass"], "SUCCESS", []) },
  }),
];

const fourthCasePrimaries = retainedPrimaryRecords.filter((record) => record.evaluationId === "evaluation-004");
const retainedAdjudicationRecord = retainedRecord({
  callId: "call-004-adjudication", evaluationId: "evaluation-004", caseId: "case-004", evidence: archCorruptEvidence,
  reviewerRole: "adjudicator", evaluatorIdentityId: "model-adjudicator", minute: 8,
  primaryLockedEvaluatorRecordDigests: [
    fourthCasePrimaries[0].lockedEvaluatorRecordDigest,
    fourthCasePrimaries[1].lockedEvaluatorRecordDigest,
  ],
  terminal: {
    responseDigest: digest("8"),
    status: "completed",
    result: {
      resultKind: "adjudication",
      accepted: false,
      primaryClass: "FAIL_SEMANTIC",
      mechanismTags: ["SEM_RELATIONSHIP_MISSING"],
      criticalIntegrityIncident: false,
      evidenceCoverageComplete: true,
    },
  },
});

export const publicGoldInfrastructureReviewRecordsV1 = [
  ...retainedPrimaryRecords,
  retainedAdjudicationRecord,
];
