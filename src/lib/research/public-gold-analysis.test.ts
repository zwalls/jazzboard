import { describe, expect, it } from "vitest";

import expectedInfrastructurePreflight from "../../../research/data/public-gold-infrastructure-preflight-v1.json";
import {
  publicGoldInfrastructureManifestV1,
  publicGoldInfrastructurePlanV1,
  publicGoldInfrastructureReviewRecordsV1,
} from "../../../research/fixtures/public-gold-infrastructure-v1.fixture";
import {
  analyzePublicGoldReviews,
  buildPublicGoldInfrastructurePreflight,
  publicGoldPreflightReportSchema,
  wilsonRate95,
} from "./public-gold-analysis";
import {
  computePublicGoldManifestDigest,
  computePublicGoldPlanDigest,
  computePublicGoldReviewRecordDigest,
  computePublicGoldThresholdsDigest,
} from "./public-gold-schemas";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function perfectInfrastructureRecords(): Array<Record<string, unknown>> {
  const resultsByEvaluation: Record<string, Record<string, unknown>> = {
    "evaluation-001": {
      resultKind: "primary",
      accepted: false,
      criteria: [
        { criterionId: "criterion-semantic", decision: "pass" },
        { criterionId: "criterion-visual", decision: "fail" },
      ],
      primaryClass: "FAIL_GEOMETRY_VISUAL",
      mechanismTags: ["VIS_RECOGNIZABILITY_OR_COMPOSITION"],
      criticalIntegrityIncident: false,
      evidenceCoverageComplete: true,
    },
    "evaluation-002": {
      resultKind: "primary",
      accepted: true,
      criteria: [
        { criterionId: "criterion-semantic", decision: "pass" },
        { criterionId: "criterion-visual", decision: "pass" },
      ],
      primaryClass: "SUCCESS",
      mechanismTags: [],
      criticalIntegrityIncident: false,
      evidenceCoverageComplete: true,
    },
    "evaluation-003": {
      resultKind: "primary",
      accepted: true,
      criteria: [
        { criterionId: "criterion-semantic", decision: "pass" },
        { criterionId: "criterion-visual", decision: "pass" },
      ],
      primaryClass: "SUCCESS",
      mechanismTags: [],
      criticalIntegrityIncident: false,
      evidenceCoverageComplete: true,
    },
    "evaluation-004": {
      resultKind: "primary",
      accepted: false,
      criteria: [
        { criterionId: "criterion-semantic", decision: "fail" },
        { criterionId: "criterion-visual", decision: "pass" },
      ],
      primaryClass: "FAIL_SEMANTIC",
      mechanismTags: ["SEM_RELATIONSHIP_MISSING"],
      criticalIntegrityIncident: false,
      evidenceCoverageComplete: true,
    },
  };
  const records = structuredClone(publicGoldInfrastructureReviewRecordsV1)
    .filter((record) => record.reviewerRole !== "adjudicator") as unknown as Array<Record<string, unknown>>;
  records.forEach((record) => {
    record.providerIdentityVerification = { status: "verified", evidenceDigest: digest("e") };
    record.provenanceVerification = { status: "verified", evidenceDigest: digest("f") };
    delete record.failurePreserved;
    delete record.providerCallMayHaveOccurred;
    delete record.failureCode;
    delete record.reasonCode;
    record.status = "completed";
    record.responseDigest = digest("a");
    const result = structuredClone(resultsByEvaluation[String(record.evaluationId)]);
    record.result = result;
    record.lockedEvaluatorProjection = {
      status: "scored",
      reviewerRole: "primary",
      accepted: result.accepted,
      primaryFailureClass: result.primaryClass,
      result,
    };
    record.recordDigest = computePublicGoldReviewRecordDigest(record);
  });
  return records;
}

describe("public rendered-gold analysis", () => {
  it("reports pooled and domain confusion with failed calls retained in denominators", () => {
    const report = analyzePublicGoldReviews(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      publicGoldInfrastructureReviewRecordsV1,
    );
    const pooled = report.binary.find((scope) => scope.scope === "pooled");
    const architecture = report.binary.find((scope) => scope.scope === "architecture");
    const drawing = report.binary.find((scope) => scope.scope === "drawing");

    expect(pooled?.confusion).toEqual({
      goldRejectDetected: 1,
      goldRejectFalseAccepted: 0,
      goldRejectNonEvaluable: 1,
      goldRejectTotal: 2,
      goldAcceptConfirmed: 1,
      goldAcceptFalseRejected: 1,
      goldAcceptNonEvaluable: 0,
      goldAcceptTotal: 2,
    });
    expect(pooled?.sensitivity).toMatchObject({ numerator: 1, denominator: 2, estimate: 0.5 });
    expect(pooled?.specificity).toMatchObject({ numerator: 1, denominator: 2, estimate: 0.5 });
    expect(pooled?.nonEvaluableRate).toMatchObject({ numerator: 1, denominator: 4, estimate: 0.25 });
    expect(architecture?.nonEvaluableRate).toMatchObject({ numerator: 0, denominator: 2, estimate: 0 });
    expect(drawing?.nonEvaluableRate).toMatchObject({ numerator: 1, denominator: 2, estimate: 0.5 });
    expect(drawing?.sensitivity).toMatchObject({ numerator: 0, denominator: 1, estimate: 0 });
    expect(drawing?.specificity).toMatchObject({ numerator: 0, denominator: 1, estimate: 0 });
    expect(report.terminalCoverage).toEqual({
      artifactAnalysisCaseCount: 4,
      begunCallCount: 9,
      plannedPrimaryCallCount: 8,
      requiredAdjudicationCallCount: 1,
      begunPrimaryCallCount: 8,
      begunAdjudicationCallCount: 1,
      completedEvaluable: 8,
      completedWithoutEvidenceCoverage: 0,
      failed: 1,
      nonEvaluable: 0,
    });
    expect(report.primaryClassConfusion).toContainEqual({
      goldPrimaryClass: "FAIL_GEOMETRY_VISUAL",
      modelPrimaryClass: "FAIL_EVALUATOR_SCORER",
      count: 1,
    });
    expect(report.reviewerRoleDiagnostics).toMatchObject([
      { reviewerRole: "primary_measurement", begunCallCount: 4, completedEvaluableCallCount: 3, failedCallCount: 1 },
      { reviewerRole: "primary_standard", begunCallCount: 4, completedEvaluableCallCount: 4, failedCallCount: 0 },
      { reviewerRole: "adjudicator", begunCallCount: 1, completedEvaluableCallCount: 1, failedCallCount: 0 },
    ]);
  });

  it("reports criterion denominators and does not turn non-evaluable output into a pass", () => {
    const report = analyzePublicGoldReviews(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      publicGoldInfrastructureReviewRecordsV1,
    );
    const measurementDrawingVisual = report.criteria.find((entry) => entry.scope === "drawing"
      && entry.reviewerRole === "primary_measurement" && entry.criterionId === "criterion-visual");
    const standardDrawingVisual = report.criteria.find((entry) => entry.scope === "drawing"
      && entry.reviewerRole === "primary_standard" && entry.criterionId === "criterion-visual");
    expect(measurementDrawingVisual?.goldFailDetected).toMatchObject({ numerator: 0, denominator: 1, estimate: 0 });
    expect(measurementDrawingVisual?.goldPassConfirmed).toMatchObject({ numerator: 0, denominator: 1, estimate: 0 });
    expect(measurementDrawingVisual?.nonEvaluableRate).toMatchObject({ numerator: 1, denominator: 2, estimate: 0.5 });
    expect(standardDrawingVisual?.goldFailDetected).toMatchObject({ numerator: 1, denominator: 1, estimate: 1 });
    expect(standardDrawingVisual?.goldPassConfirmed).toMatchObject({ numerator: 1, denominator: 1, estimate: 1 });
  });

  it("keeps an explicit non-evaluable primary in every artifact and call denominator", () => {
    const records = structuredClone(publicGoldInfrastructureReviewRecordsV1) as unknown as Array<Record<string, unknown>>;
    const nonEvaluable = records[0];
    delete nonEvaluable.providerCallMayHaveOccurred;
    delete nonEvaluable.failureCode;
    nonEvaluable.status = "non_evaluable";
    nonEvaluable.reasonCode = "synthetic-incomplete-evidence";
    nonEvaluable.recordDigest = computePublicGoldReviewRecordDigest(nonEvaluable);
    const report = analyzePublicGoldReviews(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      records,
    );
    expect(report.binary.find((entry) => entry.scope === "pooled")?.nonEvaluableRate)
      .toMatchObject({ numerator: 1, denominator: 4, estimate: 0.25 });
    expect(report.binary.find((entry) => entry.scope === "drawing")?.nonEvaluableRate)
      .toMatchObject({ numerator: 1, denominator: 2, estimate: 0.5 });
    expect(report.terminalCoverage).toMatchObject({
      artifactAnalysisCaseCount: 4,
      begunCallCount: 9,
      failed: 0,
      nonEvaluable: 1,
    });
    expect(report.reviewerRoleDiagnostics[0]).toMatchObject({
      reviewerRole: "primary_measurement",
      begunCallCount: 4,
      completedEvaluableCallCount: 3,
      nonEvaluableCallCount: 1,
    });
  });

  it("preserves a scored production projection while withholding non-evaluable gold credit", () => {
    const records = structuredClone(publicGoldInfrastructureReviewRecordsV1) as unknown as Array<Record<string, unknown>>;
    const scoredButNonEvaluable = records.find((record) => record.callId === "call-002-measurement") as Record<string, unknown>;
    scoredButNonEvaluable.status = "non_evaluable";
    scoredButNonEvaluable.failurePreserved = true;
    scoredButNonEvaluable.reasonCode = "synthetic-projection-evidence-unverified";
    scoredButNonEvaluable.result = null;
    scoredButNonEvaluable.recordDigest = computePublicGoldReviewRecordDigest(scoredButNonEvaluable);
    const report = analyzePublicGoldReviews(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      records,
    );
    expect(report.resolvedClassifications.find((entry) => entry.artifactId === "artifact-arch-source"))
      .toMatchObject({
        resolution: "primary_agreement",
        reviewAccepted: true,
        analysisAccepted: null,
        primaryFailureClass: "SUCCESS",
      });
    expect(report.binary.find((entry) => entry.scope === "architecture")?.confusion)
      .toMatchObject({ goldAcceptConfirmed: 0, goldAcceptNonEvaluable: 1, goldAcceptTotal: 1 });
  });

  it("projects the valid production resolver while keeping one analysis case per artifact", () => {
    const report = analyzePublicGoldReviews(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      publicGoldInfrastructureReviewRecordsV1,
    );
    expect(report.resolvedClassifications).toHaveLength(4);
    expect(report.resolvedClassifications.find((entry) => entry.artifactId === "artifact-drawing-corrupt")).toMatchObject({
      resolution: "primary_scorer_failure",
      reviewAccepted: false,
      analysisAccepted: null,
      primaryFailureClass: "FAIL_EVALUATOR_SCORER",
      adjudicationRecordDigest: null,
    });
    expect(report.resolvedClassifications.find((entry) => entry.artifactId === "artifact-drawing-source")).toMatchObject({
      primaryFailureClasses: ["FAIL_GEOMETRY_VISUAL", "FAIL_SEMANTIC"],
      primaryClassAgreement: false,
      resolution: "frozen_precedence_without_adjudication",
      reviewAccepted: false,
      analysisAccepted: false,
      primaryFailureClass: "FAIL_SEMANTIC",
      adjudicationRecordDigest: null,
    });
    expect(report.resolvedClassifications.find((entry) => entry.artifactId === "artifact-arch-corrupt")).toMatchObject({
      resolution: "binary_adjudication",
      reviewAccepted: false,
      analysisAccepted: false,
      primaryFailureClass: "FAIL_SEMANTIC",
    });
  });

  it("uses exact Wilson counts and a simultaneous-component interval for balanced accuracy", () => {
    const rate = wilsonRate95(1, 2);
    expect(rate.numerator).toBe(1);
    expect(rate.denominator).toBe(2);
    expect(rate.interval95.lower).toBeCloseTo(0.0945312057, 9);
    expect(rate.interval95.upper).toBeCloseTo(0.9054687943, 9);
    const report = analyzePublicGoldReviews(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      publicGoldInfrastructureReviewRecordsV1,
    );
    expect(report.binary[0].balancedAccuracy).toMatchObject({
      estimate: 0.5,
      components: {
        sensitivityNumerator: 1,
        sensitivityDenominator: 2,
        specificityNumerator: 1,
        specificityDenominator: 2,
      },
      interval95: { method: "bonferroni_mean_of_component_wilson_score_97_5" },
    });
  });

  it("produces deterministic source-exemplar-cluster bootstrap intervals", () => {
    const first = analyzePublicGoldReviews(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      publicGoldInfrastructureReviewRecordsV1,
    );
    const second = analyzePublicGoldReviews(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      publicGoldInfrastructureReviewRecordsV1,
    );
    expect(first.clusterBootstrap).toEqual(second.clusterBootstrap);
    expect(first.clusterBootstrap).toMatchObject({ seed: 1_592_639_215, drawCount: 1_000 });
    expect(first.clusterBootstrap.scopes.map((scope) => ({
      scope: scope.scope,
      sourceClusterCount: scope.sourceClusterCount,
      unit: scope.unit,
    }))).toEqual([
      { scope: "pooled", sourceClusterCount: 2, unit: "source_exemplar_cluster" },
      { scope: "architecture", sourceClusterCount: 1, unit: "source_exemplar_cluster" },
      { scope: "drawing", sourceClusterCount: 1, unit: "source_exemplar_cluster" },
    ]);
  });

  it("makes graduation impossible for infrastructure fixtures regardless of apparent rates", () => {
    const report = analyzePublicGoldReviews(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      perfectInfrastructureRecords(),
    );
    expect(report.graduation.status).toBe("infrastructure_fixture_only");
    expect(report.graduation.passed).toBe(false);
    expect(report.graduation.blockers).toContain("infrastructure_fixtures_are_not_empirical_validation");
  });

  it("prevents a tiny perfect live-candidate corpus from passing the independent-cluster minimum", () => {
    const manifest = structuredClone(publicGoldInfrastructureManifestV1) as unknown as {
      corpusKind: string;
      manifestDigest: string;
      graduationThresholds: Record<string, unknown>;
    };
    manifest.corpusKind = "public_gold_candidate";
    manifest.graduationThresholds.minimumArchitectureSensitivityWilsonLower95 = 0;
    manifest.graduationThresholds.minimumArchitectureSpecificityWilsonLower95 = 0;
    manifest.graduationThresholds.minimumDrawingSensitivityWilsonLower95 = 0;
    manifest.graduationThresholds.minimumDrawingSpecificityWilsonLower95 = 0;
    manifest.graduationThresholds.maximumNonEvaluableRate = 1;
    manifest.graduationThresholds.maximumDomainFalseAcceptRateGap = 1;
    manifest.graduationThresholds.thresholdsDigest = computePublicGoldThresholdsDigest(manifest.graduationThresholds);
    manifest.manifestDigest = computePublicGoldManifestDigest(manifest);
    const plan = structuredClone(publicGoldInfrastructurePlanV1) as unknown as Record<string, unknown>;
    plan.corpusManifestDigest = manifest.manifestDigest;
    plan.planDigest = computePublicGoldPlanDigest(plan);
    const records = perfectInfrastructureRecords().map((source) => {
      const record: Record<string, unknown> = {
        ...source,
        corpusManifestDigest: manifest.manifestDigest,
        planDigest: plan.planDigest,
      };
      record.recordDigest = computePublicGoldReviewRecordDigest(record);
      return record;
    });
    const report = analyzePublicGoldReviews(manifest, plan, records);
    expect(report.graduation.status).toBe("failed");
    expect(report.graduation.passed).toBe(false);
    expect(report.graduation.blockers).toEqual([
      "architecture_source_cluster_count_below_threshold",
      "drawing_source_cluster_count_below_threshold",
    ]);
  });

  it("emits the checked-in machine preflight and keeps live validity pending", () => {
    const report = buildPublicGoldInfrastructurePreflight(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      publicGoldInfrastructureReviewRecordsV1,
    );
    expect(report).toEqual(expectedInfrastructurePreflight);
    expect(report.providerCallCount).toBe(0);
    expect(report.sealedDataAccessCount).toBe(0);
    expect(report.empiricalValidationClaimAllowed).toBe(false);
    expect(report.liveValidityStatus).toBe("pending_live_public_corpus_and_authorized_provider_run");
    expect(() => publicGoldPreflightReportSchema.parse({ ...report, empiricalAccuracy: 1 })).toThrow();
  });
});
