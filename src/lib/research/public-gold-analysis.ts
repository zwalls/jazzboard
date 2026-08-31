import { z } from "zod";

import {
  buildBlindedPublicGoldPackets,
  publicGoldDomainSchema,
  resolvePublicGoldLabel,
  validatePublicGoldPlan,
  validatePublicGoldRecords,
  type PublicGoldCorpusManifest,
  type PublicGoldEvaluationPlan,
  type PublicGoldReviewRecord,
} from "./public-gold-schemas";
import { hashCanonicalJson } from "./provenance-crypto";

const compareCodeUnits = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export type WilsonRate = {
  numerator: number;
  denominator: number;
  estimate: number | null;
  interval95: {
    lower: number | null;
    upper: number | null;
    method: "two_sided_wilson_score_95";
  };
};

function wilsonRateAt(
  numerator: number,
  denominator: number,
  zValue: number,
): { estimate: number | null; lower: number | null; upper: number | null } {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)
    || numerator < 0 || denominator < 0 || numerator > denominator) {
    throw new Error("Wilson inputs must be integer counts with 0 <= numerator <= denominator.");
  }
  if (denominator === 0) {
    return { estimate: null, lower: null, upper: null };
  }
  const proportion = numerator / denominator;
  const zSquared = zValue * zValue;
  const scale = 1 + zSquared / denominator;
  const center = (proportion + zSquared / (2 * denominator)) / scale;
  const margin = zValue * Math.sqrt(
    (proportion * (1 - proportion) + zSquared / (4 * denominator)) / denominator,
  ) / scale;
  return { estimate: proportion, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

export function wilsonRate95(numerator: number, denominator: number): WilsonRate {
  const interval = wilsonRateAt(numerator, denominator, 1.959963984540054);
  return {
    numerator,
    denominator,
    estimate: interval.estimate,
    interval95: { lower: interval.lower, upper: interval.upper, method: "two_sided_wilson_score_95" },
  };
}

type EvaluationRow = {
  artifactId: string;
  sourceClusterId: string;
  domain: "architecture" | "drawing";
  goldAccepted: boolean;
  goldCriteria: Map<string, "pass" | "fail">;
  goldPrimaryClass: string;
  goldCriticalIntegrityIncident: boolean;
  modelAccepted: boolean | null;
  reviewAccepted: boolean;
  classificationPrimaryClass: string;
  resolution: "primary_agreement" | "frozen_precedence_without_adjudication" | "primary_scorer_failure" | "binary_adjudication";
  productionPrimaryClasses: [string, string];
  primaryRecordDigests: [string, string];
  adjudicationRecordDigest: string | null;
  primaryCalls: {
    measurement: { accepted: boolean | null; criteria: Map<string, "pass" | "fail"> | null; primaryClass: string | null };
    standard: { accepted: boolean | null; criteria: Map<string, "pass" | "fail"> | null; primaryClass: string | null };
  };
};

type PrimaryCallProjection = EvaluationRow["primaryCalls"]["measurement"];

export type BinaryScopeReport = {
  scope: "pooled" | "architecture" | "drawing";
  artifactCount: number;
  sourceClusterCount: number;
  confusion: {
    goldRejectDetected: number;
    goldRejectFalseAccepted: number;
    goldRejectNonEvaluable: number;
    goldRejectTotal: number;
    goldAcceptConfirmed: number;
    goldAcceptFalseRejected: number;
    goldAcceptNonEvaluable: number;
    goldAcceptTotal: number;
  };
  sensitivity: WilsonRate;
  specificity: WilsonRate;
  falseAcceptRate: WilsonRate;
  falseRejectRate: WilsonRate;
  nonEvaluableRate: WilsonRate;
  balancedAccuracy: {
    estimate: number | null;
    components: {
      sensitivityNumerator: number;
      sensitivityDenominator: number;
      specificityNumerator: number;
      specificityDenominator: number;
    };
    interval95: {
      lower: number | null;
      upper: number | null;
      method: "bonferroni_mean_of_component_wilson_score_97_5";
    };
  };
};

function scopeBinaryReport(
  scope: BinaryScopeReport["scope"],
  rows: readonly EvaluationRow[],
): BinaryScopeReport {
  const goldRejectRows = rows.filter((row) => !row.goldAccepted);
  const goldAcceptRows = rows.filter((row) => row.goldAccepted);
  const goldRejectDetected = goldRejectRows.filter((row) => row.modelAccepted === false).length;
  const goldRejectFalseAccepted = goldRejectRows.filter((row) => row.modelAccepted === true).length;
  const goldRejectNonEvaluable = goldRejectRows.filter((row) => row.modelAccepted === null).length;
  const goldAcceptConfirmed = goldAcceptRows.filter((row) => row.modelAccepted === true).length;
  const goldAcceptFalseRejected = goldAcceptRows.filter((row) => row.modelAccepted === false).length;
  const goldAcceptNonEvaluable = goldAcceptRows.filter((row) => row.modelAccepted === null).length;
  const sensitivity = wilsonRate95(goldRejectDetected, goldRejectRows.length);
  const specificity = wilsonRate95(goldAcceptConfirmed, goldAcceptRows.length);
  // Two simultaneous 97.5% component intervals give at least 95% joint
  // coverage by Bonferroni; averaging their endpoints therefore yields a
  // conservative 95% interval for the balanced-accuracy average.
  const sensitivitySimultaneous = wilsonRateAt(goldRejectDetected, goldRejectRows.length, 2.241402727604947);
  const specificitySimultaneous = wilsonRateAt(goldAcceptConfirmed, goldAcceptRows.length, 2.241402727604947);
  const balancedEstimate = sensitivity.estimate === null || specificity.estimate === null
    ? null
    : (sensitivity.estimate + specificity.estimate) / 2;
  const balancedLower = sensitivitySimultaneous.lower === null || specificitySimultaneous.lower === null
    ? null
    : (sensitivitySimultaneous.lower + specificitySimultaneous.lower) / 2;
  const balancedUpper = sensitivitySimultaneous.upper === null || specificitySimultaneous.upper === null
    ? null
    : (sensitivitySimultaneous.upper + specificitySimultaneous.upper) / 2;
  return {
    scope,
    artifactCount: rows.length,
    sourceClusterCount: new Set(rows.map((row) => row.sourceClusterId)).size,
    confusion: {
      goldRejectDetected,
      goldRejectFalseAccepted,
      goldRejectNonEvaluable,
      goldRejectTotal: goldRejectRows.length,
      goldAcceptConfirmed,
      goldAcceptFalseRejected,
      goldAcceptNonEvaluable,
      goldAcceptTotal: goldAcceptRows.length,
    },
    sensitivity,
    specificity,
    falseAcceptRate: wilsonRate95(goldRejectFalseAccepted, goldRejectRows.length),
    falseRejectRate: wilsonRate95(goldAcceptFalseRejected, goldAcceptRows.length),
    nonEvaluableRate: wilsonRate95(rows.filter((row) => row.modelAccepted === null).length, rows.length),
    balancedAccuracy: {
      estimate: balancedEstimate,
      components: {
        sensitivityNumerator: goldRejectDetected,
        sensitivityDenominator: goldRejectRows.length,
        specificityNumerator: goldAcceptConfirmed,
        specificityDenominator: goldAcceptRows.length,
      },
      interval95: {
        lower: balancedLower,
        upper: balancedUpper,
        method: "bonferroni_mean_of_component_wilson_score_97_5",
      },
    },
  };
}

type CriterionDiagnostic = {
  scope: "pooled" | "architecture" | "drawing";
  reviewerRole: "primary_measurement" | "primary_standard";
  criterionId: string;
  goldFailDetected: WilsonRate;
  goldPassConfirmed: WilsonRate;
  falsePassRate: WilsonRate;
  falseFailRate: WilsonRate;
  nonEvaluableRate: WilsonRate;
};

function criterionDiagnostics(
  scope: CriterionDiagnostic["scope"],
  rows: readonly EvaluationRow[],
  criterionIds: readonly string[],
  reviewerRole: CriterionDiagnostic["reviewerRole"],
): CriterionDiagnostic[] {
  const role = reviewerRole === "primary_measurement" ? "measurement" : "standard";
  return criterionIds.map((criterionId) => {
    const goldFail = rows.filter((row) => row.goldCriteria.get(criterionId) === "fail");
    const goldPass = rows.filter((row) => row.goldCriteria.get(criterionId) === "pass");
    const modelDecision = (row: EvaluationRow) => row.primaryCalls[role].criteria?.get(criterionId) ?? null;
    return {
      scope,
      reviewerRole,
      criterionId,
      goldFailDetected: wilsonRate95(goldFail.filter((row) => modelDecision(row) === "fail").length, goldFail.length),
      goldPassConfirmed: wilsonRate95(goldPass.filter((row) => modelDecision(row) === "pass").length, goldPass.length),
      falsePassRate: wilsonRate95(goldFail.filter((row) => modelDecision(row) === "pass").length, goldFail.length),
      falseFailRate: wilsonRate95(goldPass.filter((row) => modelDecision(row) === "fail").length, goldPass.length),
      nonEvaluableRate: wilsonRate95(rows.filter((row) => modelDecision(row) === null).length, rows.length),
    };
  });
}

function hashScope(scope: string): number {
  let hash = 2166136261;
  for (const character of scope) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function percentile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * probability)];
}

type BootstrapMetricName = "sensitivity" | "specificity" | "falseAcceptRate" | "falseRejectRate" | "nonEvaluableRate" | "balancedAccuracy";

type ClusterBootstrapScope = {
  scope: "pooled" | "architecture" | "drawing";
  sourceClusterCount: number;
  drawCount: number;
  minimumRequiredSourceClusters: number;
  inferenceStatus: "descriptive_cluster_interval" | "feasibility_only_insufficient_independent_clusters";
  unit: "source_exemplar_cluster";
  intervalMethod: "deterministic_cluster_percentile_95";
  metrics: Record<BootstrapMetricName, {
    lower: number | null;
    upper: number | null;
    usableDraws: number;
  }>;
};

function clusterBootstrap(
  scope: ClusterBootstrapScope["scope"],
  rows: readonly EvaluationRow[],
  seed: number,
  drawCount: number,
  minimumRequiredSourceClusters: number,
): ClusterBootstrapScope {
  const byCluster = new Map<string, EvaluationRow[]>();
  rows.forEach((row) => byCluster.set(row.sourceClusterId, [...(byCluster.get(row.sourceClusterId) ?? []), row]));
  const clusterIds = [...byCluster.keys()].sort(compareCodeUnits);
  const random = mulberry32((seed ^ hashScope(scope)) >>> 0);
  const samples = new Map<BootstrapMetricName, number[]>();
  const metricNames: BootstrapMetricName[] = ["sensitivity", "specificity", "falseAcceptRate", "falseRejectRate", "nonEvaluableRate", "balancedAccuracy"];
  metricNames.forEach((metric) => samples.set(metric, []));
  for (let draw = 0; draw < drawCount; draw += 1) {
    const sampledRows: EvaluationRow[] = [];
    for (let index = 0; index < clusterIds.length; index += 1) {
      const clusterId = clusterIds[Math.floor(random() * clusterIds.length)];
      sampledRows.push(...(byCluster.get(clusterId) ?? []));
    }
    const report = scopeBinaryReport(scope, sampledRows);
    const values: Record<BootstrapMetricName, number | null> = {
      sensitivity: report.sensitivity.estimate,
      specificity: report.specificity.estimate,
      falseAcceptRate: report.falseAcceptRate.estimate,
      falseRejectRate: report.falseRejectRate.estimate,
      nonEvaluableRate: report.nonEvaluableRate.estimate,
      balancedAccuracy: report.balancedAccuracy.estimate,
    };
    metricNames.forEach((metric) => {
      const value = values[metric];
      if (value !== null) samples.get(metric)?.push(value);
    });
  }
  return {
    scope,
    sourceClusterCount: clusterIds.length,
    drawCount,
    minimumRequiredSourceClusters,
    inferenceStatus: clusterIds.length >= minimumRequiredSourceClusters
      ? "descriptive_cluster_interval"
      : "feasibility_only_insufficient_independent_clusters",
    unit: "source_exemplar_cluster",
    intervalMethod: "deterministic_cluster_percentile_95",
    metrics: Object.fromEntries(metricNames.map((metric) => {
      const values = samples.get(metric) ?? [];
      return [metric, { lower: percentile(values, 0.025), upper: percentile(values, 0.975), usableDraws: values.length }];
    })) as ClusterBootstrapScope["metrics"],
  };
}

export type PublicGoldAnalysisReport = {
  schemaVersion: 1;
  corpusId: string;
  planId: string;
  classificationPolicy: "failed_or_incomplete_reviews_remain_in_denominator_as_non_evaluable";
  binary: BinaryScopeReport[];
  criteria: CriterionDiagnostic[];
  resolvedClassifications: Array<{
    artifactId: string;
    primaryFailureClasses: [string, string];
    primaryClassAgreement: boolean;
    resolution: EvaluationRow["resolution"];
    reviewAccepted: boolean;
    analysisAccepted: boolean | null;
    primaryFailureClass: string;
    primaryRecordDigests: [string, string];
    adjudicationRecordDigest: string | null;
  }>;
  reviewerRoleDiagnostics: Array<{
    reviewerRole: "primary_measurement" | "primary_standard" | "adjudicator";
    selection: "all_artifacts" | "binary_primary_disagreements_only";
    begunCallCount: number;
    completedEvaluableCallCount: number;
    failedCallCount: number;
    nonEvaluableCallCount: number;
    sensitivity: WilsonRate;
    specificity: WilsonRate;
    nonEvaluableRate: WilsonRate;
  }>;
  terminalCoverage: {
    artifactAnalysisCaseCount: number;
    begunCallCount: number;
    plannedPrimaryCallCount: number;
    requiredAdjudicationCallCount: number;
    begunPrimaryCallCount: number;
    begunAdjudicationCallCount: number;
    completedEvaluable: number;
    completedWithoutEvidenceCoverage: number;
    failed: number;
    nonEvaluable: number;
  };
  primaryClassConfusion: Array<{ goldPrimaryClass: string; modelPrimaryClass: string; count: number }>;
  criticalIntegrityFalseAcceptCount: number;
  providerIdentityVerified: WilsonRate;
  provenanceVerified: WilsonRate;
  clusterBootstrap: {
    seed: number;
    drawCount: number;
    scopes: ClusterBootstrapScope[];
  };
  graduation: {
    status: "infrastructure_fixture_only" | "passed" | "failed";
    passed: boolean;
    blockers: string[];
  };
};

function reviewerRoleDiagnostics(
  reviewerRole: PublicGoldAnalysisReport["reviewerRoleDiagnostics"][number]["reviewerRole"],
  records: readonly PublicGoldReviewRecord[],
  goldByEvaluation: ReadonlyMap<string, boolean>,
): PublicGoldAnalysisReport["reviewerRoleDiagnostics"][number] {
  const selected = records.filter((record) => record.reviewerRole === reviewerRole);
  const callRows = selected.map((record) => {
    const result = record.status === "completed" && record.result.evidenceCoverageComplete ? record.result : null;
    return { record, modelAccepted: result?.accepted ?? null };
  });
  const rejects = callRows.filter(({ record }) => goldByEvaluation.get(record.evaluationId) === false);
  const accepts = callRows.filter(({ record }) => goldByEvaluation.get(record.evaluationId) === true);
  return {
    reviewerRole,
    selection: reviewerRole === "adjudicator" ? "binary_primary_disagreements_only" : "all_artifacts",
    begunCallCount: selected.length,
    completedEvaluableCallCount: callRows.filter((entry) => entry.modelAccepted !== null).length,
    failedCallCount: selected.filter((record) => record.status === "failed").length,
    nonEvaluableCallCount: callRows.filter((entry) => entry.modelAccepted === null).length,
    sensitivity: wilsonRate95(rejects.filter((entry) => entry.modelAccepted === false).length, rejects.length),
    specificity: wilsonRate95(accepts.filter((entry) => entry.modelAccepted === true).length, accepts.length),
    nonEvaluableRate: wilsonRate95(callRows.filter((entry) => entry.modelAccepted === null).length, callRows.length),
  };
}

function buildRows(
  manifest: PublicGoldCorpusManifest,
  plan: PublicGoldEvaluationPlan,
  records: readonly PublicGoldReviewRecord[],
): EvaluationRow[] {
  const artifactById = new Map(manifest.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  return [...plan.entries].sort((a, b) => a.order - b.order).map((entry) => {
    const artifact = artifactById.get(entry.artifactId);
    const caseRecords = records.filter((record) => record.evaluationId === entry.evaluationId);
    const measurementRecord = caseRecords.find((record) => record.reviewerRole === "primary_measurement");
    const standardRecord = caseRecords.find((record) => record.reviewerRole === "primary_standard");
    const adjudicationRecord = caseRecords.find((record) => record.reviewerRole === "adjudicator") ?? null;
    if (!artifact || !measurementRecord || !standardRecord) throw new Error("Validated public-gold inputs lost a production review-plan binding.");
    const gold = resolvePublicGoldLabel(artifact);
    const primaryProjection = (record: PublicGoldReviewRecord): PrimaryCallProjection => {
      if (record.status !== "completed"
        || record.result.resultKind !== "primary"
        || !record.result.evidenceCoverageComplete) {
        return { accepted: null, criteria: null, primaryClass: null };
      }
      return {
        accepted: record.result.accepted,
        criteria: new Map<string, "pass" | "fail">(
          record.result.criteria.map((criterion) => [criterion.criterionId, criterion.decision]),
        ),
        primaryClass: record.result.primaryClass,
      };
    };
    const measurement = primaryProjection(measurementRecord);
    const standard = primaryProjection(standardRecord);
    const lockedPrimaryProjection = (record: PublicGoldReviewRecord) => {
      const projection = record.lockedEvaluatorProjection;
      if (projection.status === "failed") {
        return { accepted: null, primaryClass: projection.primaryFailureClass };
      }
      if (projection.result.resultKind !== "primary") {
        throw new Error("Validated public-gold primary call lost its LockedEvaluatorRecord role.");
      }
      return { accepted: projection.accepted, primaryClass: projection.primaryFailureClass };
    };
    const lockedMeasurement = lockedPrimaryProjection(measurementRecord);
    const lockedStandard = lockedPrimaryProjection(standardRecord);
    const primaryScorerFailed = lockedMeasurement.accepted === null || lockedStandard.accepted === null;
    const binaryDisagreement = !primaryScorerFailed && lockedMeasurement.accepted !== lockedStandard.accepted;
    const analysisPrimaryNonEvaluable = measurement.accepted === null || standard.accepted === null;
    const adjudicationEvaluable = adjudicationRecord?.status === "completed"
      && adjudicationRecord.result.resultKind === "adjudication"
      && adjudicationRecord.result.evidenceCoverageComplete;
    const adjudicationResult = adjudicationEvaluable && adjudicationRecord?.status === "completed"
      && adjudicationRecord.result.resultKind === "adjudication"
      ? adjudicationRecord.result
      : null;
    const lockedAdjudicationResult = adjudicationRecord?.lockedEvaluatorProjection.status === "scored"
      && adjudicationRecord.lockedEvaluatorProjection.result.resultKind === "adjudication"
      ? adjudicationRecord.lockedEvaluatorProjection.result
      : null;
    let modelAccepted: boolean | null = analysisPrimaryNonEvaluable ? null : measurement.accepted;
    let reviewAccepted: boolean;
    let classificationPrimaryClass: string;
    let resolution: EvaluationRow["resolution"];
    if (primaryScorerFailed) {
      modelAccepted = null;
      reviewAccepted = false;
      classificationPrimaryClass = "FAIL_EVALUATOR_SCORER";
      resolution = "primary_scorer_failure";
    } else if (binaryDisagreement) {
      modelAccepted = analysisPrimaryNonEvaluable ? null : adjudicationResult?.accepted ?? null;
      reviewAccepted = lockedAdjudicationResult?.accepted ?? false;
      classificationPrimaryClass = lockedAdjudicationResult?.primaryClass ?? "FAIL_EVALUATOR_SCORER";
      resolution = "binary_adjudication";
    } else {
      reviewAccepted = lockedMeasurement.accepted as boolean;
      const classes = [lockedMeasurement.primaryClass, lockedStandard.primaryClass];
      const primaryClassAgreement = classes[0] === classes[1];
      const precedence = new Map(manifest.failureTaxonomy.primaryClasses.map((primaryClass, index) => [primaryClass, index]));
      classificationPrimaryClass = primaryClassAgreement ? classes[0] : [...classes].sort((left, right) =>
        (precedence.get(left) ?? Number.MAX_SAFE_INTEGER) - (precedence.get(right) ?? Number.MAX_SAFE_INTEGER)
        || compareCodeUnits(left, right))[0];
      resolution = primaryClassAgreement ? "primary_agreement" : "frozen_precedence_without_adjudication";
    }
    return {
      artifactId: artifact.artifactId,
      sourceClusterId: artifact.sourceClusterId,
      domain: artifact.domain,
      goldAccepted: gold.accepted,
      goldCriteria: new Map(gold.criteria.map((criterion) => [criterion.criterionId, criterion.decision])),
      goldPrimaryClass: gold.primaryClass,
      goldCriticalIntegrityIncident: gold.criticalIntegrityIncident,
      modelAccepted,
      reviewAccepted,
      classificationPrimaryClass,
      resolution,
      productionPrimaryClasses: [lockedMeasurement.primaryClass, lockedStandard.primaryClass],
      primaryRecordDigests: [
        measurementRecord.lockedEvaluatorRecordDigest,
        standardRecord.lockedEvaluatorRecordDigest,
      ],
      adjudicationRecordDigest: adjudicationRecord?.lockedEvaluatorRecordDigest ?? null,
      primaryCalls: { measurement, standard },
    };
  });
}

export function analyzePublicGoldReviews(
  rawManifest: unknown,
  rawPlan: unknown,
  rawRecords: unknown,
): PublicGoldAnalysisReport {
  const { manifest, plan, records } = validatePublicGoldRecords(rawManifest, rawPlan, rawRecords);
  const rows = buildRows(manifest, plan, records);
  const scopes = [
    ["pooled", rows],
    ["architecture", rows.filter((row) => row.domain === "architecture")],
    ["drawing", rows.filter((row) => row.domain === "drawing")],
  ] as const;
  const binary = scopes.map(([scope, scopedRows]) => scopeBinaryReport(scope, scopedRows));
  const criterionIds = manifest.rubric.criteria.map((criterion) => criterion.criterionId).sort(compareCodeUnits);
  const criteria = scopes.flatMap(([scope, scopedRows]) => (["primary_measurement", "primary_standard"] as const)
    .flatMap((reviewerRole) => criterionDiagnostics(scope, scopedRows, criterionIds, reviewerRole)));
  const goldByEvaluation = new Map([...plan.entries].sort((a, b) => a.order - b.order)
    .map((entry, index) => [entry.evaluationId, rows[index].goldAccepted] as const));

  const confusion = new Map<string, number>();
  rows.forEach((row) => {
    const modelClass = row.classificationPrimaryClass;
    const key = `${row.goldPrimaryClass}\u0000${modelClass}`;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);
  });
  const primaryClassConfusion = [...confusion.entries()].map(([key, count]) => {
    const [goldPrimaryClass, modelPrimaryClass] = key.split("\u0000");
    return { goldPrimaryClass, modelPrimaryClass, count };
  }).sort((a, b) => compareCodeUnits(a.goldPrimaryClass, b.goldPrimaryClass) || compareCodeUnits(a.modelPrimaryClass, b.modelPrimaryClass));

  const criticalIntegrityFalseAcceptCount = rows.filter((row) => row.goldCriticalIntegrityIncident && row.modelAccepted === true).length;
  const thresholds = manifest.graduationThresholds;
  const architecture = binary.find((report) => report.scope === "architecture") as BinaryScopeReport;
  const drawing = binary.find((report) => report.scope === "drawing") as BinaryScopeReport;
  const providerIdentityVerified = wilsonRate95(records.filter((record) => record.providerIdentityVerification.status === "verified").length, records.length);
  const provenanceVerified = wilsonRate95(records.filter((record) => record.provenanceVerification.status === "verified").length, records.length);
  const blockers: string[] = [];
  const requireLower = (rate: WilsonRate, minimum: number, code: string) => {
    if (rate.interval95.lower === null || rate.interval95.lower < minimum) blockers.push(code);
  };
  requireLower(architecture.sensitivity, thresholds.minimumArchitectureSensitivityWilsonLower95, "architecture_sensitivity_lower_bound_below_threshold");
  requireLower(architecture.specificity, thresholds.minimumArchitectureSpecificityWilsonLower95, "architecture_specificity_lower_bound_below_threshold");
  requireLower(drawing.sensitivity, thresholds.minimumDrawingSensitivityWilsonLower95, "drawing_sensitivity_lower_bound_below_threshold");
  requireLower(drawing.specificity, thresholds.minimumDrawingSpecificityWilsonLower95, "drawing_specificity_lower_bound_below_threshold");
  if ((architecture.nonEvaluableRate.estimate ?? 1) > thresholds.maximumNonEvaluableRate) blockers.push("architecture_non_evaluable_rate_above_threshold");
  if ((drawing.nonEvaluableRate.estimate ?? 1) > thresholds.maximumNonEvaluableRate) blockers.push("drawing_non_evaluable_rate_above_threshold");
  const domainFalseAcceptGap = Math.abs((architecture.falseAcceptRate.estimate ?? 1) - (drawing.falseAcceptRate.estimate ?? 1));
  if (domainFalseAcceptGap > thresholds.maximumDomainFalseAcceptRateGap) blockers.push("domain_false_accept_rate_gap_above_threshold");
  if (criticalIntegrityFalseAcceptCount > thresholds.criticalIntegrityFalseAcceptMaximum) blockers.push("critical_integrity_false_accept_observed");
  for (const domain of publicGoldDomainSchema.options) {
    const clusterCount = new Set(rows.filter((row) => row.domain === domain).map((row) => row.sourceClusterId)).size;
    if (clusterCount < thresholds.minimumSourceClustersPerDomain) blockers.push(`${domain}_source_cluster_count_below_threshold`);
  }
  if (providerIdentityVerified.numerator !== providerIdentityVerified.denominator) blockers.push("provider_identity_incomplete");
  if (provenanceVerified.numerator !== provenanceVerified.denominator) blockers.push("artifact_provenance_incomplete");
  const infrastructureOnly = manifest.corpusKind === "infrastructure_fixture";
  if (infrastructureOnly) blockers.push("infrastructure_fixtures_are_not_empirical_validation");

  return {
    schemaVersion: 1,
    corpusId: manifest.corpusId,
    planId: plan.planId,
    classificationPolicy: "failed_or_incomplete_reviews_remain_in_denominator_as_non_evaluable",
    binary,
    criteria,
    resolvedClassifications: rows.map((row) => ({
      artifactId: row.artifactId,
      primaryFailureClasses: [
        row.productionPrimaryClasses[0],
        row.productionPrimaryClasses[1],
      ],
      primaryClassAgreement: row.productionPrimaryClasses[0] === row.productionPrimaryClasses[1],
      resolution: row.resolution,
      reviewAccepted: row.reviewAccepted,
      analysisAccepted: row.modelAccepted,
      primaryFailureClass: row.classificationPrimaryClass,
      primaryRecordDigests: row.primaryRecordDigests,
      adjudicationRecordDigest: row.adjudicationRecordDigest,
    })),
    reviewerRoleDiagnostics: (["primary_measurement", "primary_standard", "adjudicator"] as const)
      .map((reviewerRole) => reviewerRoleDiagnostics(reviewerRole, records, goldByEvaluation)),
    terminalCoverage: {
      artifactAnalysisCaseCount: plan.entries.length,
      begunCallCount: records.length,
      plannedPrimaryCallCount: plan.entries.length * 2,
      requiredAdjudicationCallCount: records.filter((record) => record.reviewerRole === "adjudicator").length,
      begunPrimaryCallCount: records.filter((record) => record.reviewerRole !== "adjudicator").length,
      begunAdjudicationCallCount: records.filter((record) => record.reviewerRole === "adjudicator").length,
      completedEvaluable: records.filter((record) => record.status === "completed" && record.result.evidenceCoverageComplete).length,
      completedWithoutEvidenceCoverage: records.filter((record) => record.status === "completed" && !record.result.evidenceCoverageComplete).length,
      failed: records.filter((record) => record.status === "failed").length,
      nonEvaluable: records.filter((record) => record.status === "non_evaluable").length,
    },
    primaryClassConfusion,
    criticalIntegrityFalseAcceptCount,
    providerIdentityVerified,
    provenanceVerified,
    clusterBootstrap: {
      seed: plan.analysisConfig.clusterBootstrapSeed,
      drawCount: plan.analysisConfig.clusterBootstrapDrawCount,
      scopes: scopes.map(([scope, scopedRows]) => clusterBootstrap(
        scope,
        scopedRows,
        plan.analysisConfig.clusterBootstrapSeed,
        plan.analysisConfig.clusterBootstrapDrawCount,
        manifest.graduationThresholds.minimumSourceClustersPerDomain,
      )),
    },
    graduation: {
      status: infrastructureOnly ? "infrastructure_fixture_only" : blockers.length === 0 ? "passed" : "failed",
      passed: !infrastructureOnly && blockers.length === 0,
      blockers: [...new Set(blockers)].sort(compareCodeUnits),
    },
  };
}

export const publicGoldPreflightReportSchema = z.object({
  schemaVersion: z.literal(1),
  reportId: z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/),
  corpusId: z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/),
  planId: z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/),
  corpusKind: z.literal("infrastructure_fixture"),
  partition: z.literal("public_development"),
  sealedDataAccessCount: z.literal(0),
  providerCallCount: z.literal(0),
  executable: z.literal(true),
  schemaAndProvenanceChecksPassed: z.literal(true),
  corpusManifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  planDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  thresholdsDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  syntheticAnalysisDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  blindedPacketCount: z.number().int().positive(),
  syntheticAnalysisCaseCount: z.number().int().positive(),
  syntheticTerminalRecordCount: z.number().int().positive(),
  syntheticPlannedPrimaryCallCount: z.number().int().positive(),
  syntheticBegunPrimaryCallCount: z.number().int().positive(),
  syntheticRequiredAdjudicationCallCount: z.number().int().nonnegative(),
  syntheticBegunAdjudicationCallCount: z.number().int().nonnegative(),
  syntheticAnalysisExecuted: z.literal(true),
  artifactCount: z.number().int().positive(),
  sourceClusterCount: z.number().int().positive(),
  domainCounts: z.object({ architecture: z.number().int().positive(), drawing: z.number().int().positive() }).strict(),
  checks: z.array(z.enum([
    "strict_schema_validation",
    "provenance_graph_validation",
    "blinded_packet_leakage_validation",
    "sibling_context_separation_validation",
    "complete_denominator_validation",
    "production_two_primary_resolution_validation",
    "binary_only_adjudication_validation",
    "locked_record_projection_contract_validation",
    "deterministic_cluster_bootstrap_validation",
  ])).length(9),
  liveValidityStatus: z.literal("pending_live_public_corpus_and_authorized_provider_run"),
  empiricalValidationClaimAllowed: z.literal(false),
  note: z.literal("Synthetic infrastructure fixtures prove executability only; they are not empirical evaluator validation."),
}).strict();

export type PublicGoldPreflightReport = z.infer<typeof publicGoldPreflightReportSchema>;

export function buildPublicGoldInfrastructurePreflight(
  rawManifest: unknown,
  rawPlan: unknown,
  rawRecords: unknown,
): PublicGoldPreflightReport {
  const { manifest, plan } = validatePublicGoldPlan(rawManifest, rawPlan);
  if (manifest.corpusKind !== "infrastructure_fixture") throw new Error("Infrastructure preflight may only use explicitly labeled synthetic fixtures.");
  const packets = buildBlindedPublicGoldPackets(manifest, plan);
  const firstAnalysis = analyzePublicGoldReviews(manifest, plan, rawRecords);
  const secondAnalysis = analyzePublicGoldReviews(manifest, plan, rawRecords);
  if (JSON.stringify(firstAnalysis.clusterBootstrap) !== JSON.stringify(secondAnalysis.clusterBootstrap)) {
    throw new Error("Synthetic preflight did not reproduce the frozen cluster bootstrap exactly.");
  }
  if (firstAnalysis.graduation.status !== "infrastructure_fixture_only") {
    throw new Error("Synthetic infrastructure fixtures must be structurally incapable of graduation.");
  }
  return publicGoldPreflightReportSchema.parse({
    schemaVersion: 1,
    reportId: "public-gold-infrastructure-preflight-v1",
    corpusId: manifest.corpusId,
    planId: plan.planId,
    corpusKind: "infrastructure_fixture",
    partition: "public_development",
    sealedDataAccessCount: 0,
    providerCallCount: 0,
    executable: true,
    schemaAndProvenanceChecksPassed: true,
    corpusManifestDigest: manifest.manifestDigest,
    planDigest: plan.planDigest,
    thresholdsDigest: manifest.graduationThresholds.thresholdsDigest,
    syntheticAnalysisDigest: hashCanonicalJson(firstAnalysis),
    blindedPacketCount: packets.length,
    syntheticAnalysisCaseCount: firstAnalysis.terminalCoverage.artifactAnalysisCaseCount,
    syntheticTerminalRecordCount: firstAnalysis.terminalCoverage.begunCallCount,
    syntheticPlannedPrimaryCallCount: firstAnalysis.terminalCoverage.plannedPrimaryCallCount,
    syntheticBegunPrimaryCallCount: firstAnalysis.terminalCoverage.begunPrimaryCallCount,
    syntheticRequiredAdjudicationCallCount: firstAnalysis.terminalCoverage.requiredAdjudicationCallCount,
    syntheticBegunAdjudicationCallCount: firstAnalysis.terminalCoverage.begunAdjudicationCallCount,
    syntheticAnalysisExecuted: true,
    artifactCount: manifest.artifacts.length,
    sourceClusterCount: manifest.sourceClusters.length,
    domainCounts: {
      architecture: manifest.artifacts.filter((artifact) => artifact.domain === "architecture").length,
      drawing: manifest.artifacts.filter((artifact) => artifact.domain === "drawing").length,
    },
    checks: [
      "strict_schema_validation",
      "provenance_graph_validation",
      "blinded_packet_leakage_validation",
      "sibling_context_separation_validation",
      "complete_denominator_validation",
      "production_two_primary_resolution_validation",
      "binary_only_adjudication_validation",
      "locked_record_projection_contract_validation",
      "deterministic_cluster_bootstrap_validation",
    ],
    liveValidityStatus: "pending_live_public_corpus_and_authorized_provider_run",
    empiricalValidationClaimAllowed: false,
    note: "Synthetic infrastructure fixtures prove executability only; they are not empirical evaluator validation.",
  });
}
