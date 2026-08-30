import { z } from "zod";

export const RESEARCH_SCORING_SCHEMA_VERSION = 1 as const;

const unitInterval = z.number().finite().min(0).max(1);
const nonNegative = z.number().finite().min(0);
const nonNegativeInteger = z.number().int().min(0);
const positive = z.number().finite().positive();
const stableId = z.string().trim().min(1).max(160);

export const evidenceCoverageSchema = z.object({
  status: z.enum(["complete", "partial", "unavailable"]),
  analyzedOpportunities: nonNegativeInteger,
  totalOpportunities: nonNegativeInteger,
  reasons: z.array(z.string().trim().min(1).max(500)).max(32),
}).strict().superRefine((coverage, context) => {
  if (coverage.analyzedOpportunities > coverage.totalOpportunities) {
    context.addIssue({ code: "custom", message: "Analyzed opportunities cannot exceed total opportunities." });
  }
  if (coverage.status === "complete" && coverage.analyzedOpportunities !== coverage.totalOpportunities) {
    context.addIssue({ code: "custom", message: "Complete coverage must analyze every opportunity." });
  }
  if (coverage.status === "unavailable" && coverage.analyzedOpportunities !== 0) {
    context.addIssue({ code: "custom", message: "Unavailable coverage cannot contain analyzed opportunities." });
  }
});

export type EvidenceCoverage = z.infer<typeof evidenceCoverageSchema>;
export type CoverageAwareStatus = "pass" | "warning" | "fail" | "indeterminate";

export function coverageAwareStatus(
  nominalStatus: Exclude<CoverageAwareStatus, "indeterminate">,
  coverage: EvidenceCoverage,
): CoverageAwareStatus {
  return coverage.status === "complete" ? nominalStatus : "indeterminate";
}

type Prf = {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
};

function ratio(numerator: number, denominator: number, emptyValue: number): number {
  return denominator === 0 ? emptyValue : numerator / denominator;
}

function prf(truePositive: number, falsePositive: number, falseNegative: number): Prf {
  const precision = ratio(
    truePositive,
    truePositive + falsePositive,
    truePositive + falseNegative === 0 ? 1 : 0,
  );
  const recall = ratio(truePositive, truePositive + falseNegative, 1);
  return {
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall),
  };
}

export const semanticVisibilityThresholdsSchema = z.object({
  minimumVisibleFraction: unitInterval,
  minimumRenderedAreaPx: positive,
  minimumOpacity: unitInterval,
}).strict();

export const DEFAULT_SEMANTIC_VISIBILITY_THRESHOLDS = Object.freeze({
  minimumVisibleFraction: 0.5,
  minimumRenderedAreaPx: 64,
  minimumOpacity: 0.1,
});

const visibleEvidenceSchema = z.object({
  inFrame: z.boolean(),
  visibleFraction: unitInterval,
  renderedAreaPx: nonNegative,
  opacity: unitInterval,
}).strict();

function isEligibleEvidence(
  evidence: z.infer<typeof visibleEvidenceSchema>,
  thresholds: z.infer<typeof semanticVisibilityThresholdsSchema>,
): boolean {
  return evidence.inFrame
    && evidence.visibleFraction >= thresholds.minimumVisibleFraction
    && evidence.renderedAreaPx >= thresholds.minimumRenderedAreaPx
    && evidence.opacity >= thresholds.minimumOpacity;
}

const architectureReferenceEntitySchema = z.object({
  id: stableId,
  critical: z.boolean(),
}).strict();

const architectureReferenceRelationshipSchema = z.object({
  id: stableId,
  fromEntityId: stableId,
  toEntityId: stableId,
  relationshipType: stableId,
  critical: z.boolean(),
}).strict();

const architectureEntityObservationSchema = visibleEvidenceSchema.extend({
  candidateId: stableId,
  matchedReferenceEntityId: stableId.nullable(),
}).strict();

const architectureRelationshipObservationSchema = visibleEvidenceSchema.extend({
  candidateId: stableId,
  matchedReferenceRelationshipId: stableId.nullable(),
  fromCandidateEntityId: stableId,
  toCandidateEntityId: stableId,
  relationshipType: stableId,
}).strict();

export const architectureSemanticScoringInputSchema = z.object({
  schemaVersion: z.literal(RESEARCH_SCORING_SCHEMA_VERSION),
  reference: z.object({
    entities: z.array(architectureReferenceEntitySchema).min(1).max(1_000),
    relationships: z.array(architectureReferenceRelationshipSchema).max(2_000),
  }).strict(),
  candidate: z.object({
    entities: z.array(architectureEntityObservationSchema).max(2_000),
    relationships: z.array(architectureRelationshipObservationSchema).max(4_000),
  }).strict(),
  visibilityThresholds: semanticVisibilityThresholdsSchema,
  coverage: evidenceCoverageSchema,
}).strict().superRefine((input, context) => {
  const entityIds = input.reference.entities.map((entity) => entity.id);
  const relationshipIds = input.reference.relationships.map((relationship) => relationship.id);
  const candidateEntityIds = input.candidate.entities.map((entity) => entity.candidateId);
  const candidateRelationshipIds = input.candidate.relationships.map((relationship) => relationship.candidateId);
  for (const [path, ids] of [
    [["reference", "entities"], entityIds],
    [["reference", "relationships"], relationshipIds],
    [["candidate", "entities"], candidateEntityIds],
    [["candidate", "relationships"], candidateRelationshipIds],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: [...path], message: "IDs must be unique." });
    }
  }
  const references = new Set(entityIds);
  input.reference.relationships.forEach((relationship, index) => {
    if (!references.has(relationship.fromEntityId) || !references.has(relationship.toEntityId)) {
      context.addIssue({
        code: "custom",
        path: ["reference", "relationships", index],
        message: "Relationship endpoints must reference declared entities.",
      });
    }
  });
});

export type ArchitectureSemanticScoringInput = z.infer<typeof architectureSemanticScoringInputSchema>;

export type ArchitectureSemanticScore = {
  schemaVersion: 1;
  status: "scored" | "indeterminate";
  coverage: EvidenceCoverage;
  entities: Prf;
  relationships: Prf & { directionOrTypeErrorCount: number };
  combined: Prf;
  criticalRecall: number;
  matchedCriticalCount: number;
  requiredCriticalCount: number;
  disqualifiedCandidateIds: string[];
  duplicateMatchCandidateIds: string[];
};

export function scoreArchitectureSemantics(raw: ArchitectureSemanticScoringInput): ArchitectureSemanticScore {
  const input = architectureSemanticScoringInputSchema.parse(raw);
  const referenceEntities = new Map(input.reference.entities.map((entity) => [entity.id, entity]));
  const eligibleEntities = input.candidate.entities.filter((entity) =>
    isEligibleEvidence(entity, input.visibilityThresholds));
  const disqualifiedCandidateIds = input.candidate.entities
    .filter((entity) => !isEligibleEvidence(entity, input.visibilityThresholds))
    .map((entity) => entity.candidateId);
  const matchedReferences = new Set<string>();
  const candidateEntityMatches = new Map<string, string>();
  const duplicateMatchCandidateIds: string[] = [];
  let entityFalsePositive = 0;
  for (const candidate of eligibleEntities) {
    const referenceId = candidate.matchedReferenceEntityId;
    if (!referenceId || !referenceEntities.has(referenceId)) {
      entityFalsePositive += 1;
      continue;
    }
    if (matchedReferences.has(referenceId)) {
      entityFalsePositive += 1;
      duplicateMatchCandidateIds.push(candidate.candidateId);
      continue;
    }
    matchedReferences.add(referenceId);
    candidateEntityMatches.set(candidate.candidateId, referenceId);
  }
  const entityScore = prf(
    matchedReferences.size,
    entityFalsePositive,
    referenceEntities.size - matchedReferences.size,
  );

  const referencesByRelationship = new Map(
    input.reference.relationships.map((relationship) => [relationship.id, relationship]),
  );
  const matchedRelationships = new Set<string>();
  let relationshipFalsePositive = 0;
  let directionOrTypeErrorCount = 0;
  for (const candidate of input.candidate.relationships) {
    if (!isEligibleEvidence(candidate, input.visibilityThresholds)) {
      disqualifiedCandidateIds.push(candidate.candidateId);
      continue;
    }
    const reference = candidate.matchedReferenceRelationshipId
      ? referencesByRelationship.get(candidate.matchedReferenceRelationshipId)
      : undefined;
    const fromReference = candidateEntityMatches.get(candidate.fromCandidateEntityId);
    const toReference = candidateEntityMatches.get(candidate.toCandidateEntityId);
    const structurallyCorrect = reference
      && fromReference === reference.fromEntityId
      && toReference === reference.toEntityId
      && candidate.relationshipType === reference.relationshipType;
    if (!reference || !structurallyCorrect) {
      relationshipFalsePositive += 1;
      if (reference) directionOrTypeErrorCount += 1;
      continue;
    }
    if (matchedRelationships.has(reference.id)) {
      relationshipFalsePositive += 1;
      duplicateMatchCandidateIds.push(candidate.candidateId);
      continue;
    }
    matchedRelationships.add(reference.id);
  }
  const relationshipScore = {
    ...prf(
      matchedRelationships.size,
      relationshipFalsePositive,
      referencesByRelationship.size - matchedRelationships.size,
    ),
    directionOrTypeErrorCount,
  };
  const criticalEntities = input.reference.entities.filter((entity) => entity.critical);
  const criticalRelationships = input.reference.relationships.filter((relationship) => relationship.critical);
  const matchedCriticalCount = criticalEntities.filter((entity) => matchedReferences.has(entity.id)).length
    + criticalRelationships.filter((relationship) => matchedRelationships.has(relationship.id)).length;
  const requiredCriticalCount = criticalEntities.length + criticalRelationships.length;
  return {
    schemaVersion: RESEARCH_SCORING_SCHEMA_VERSION,
    status: input.coverage.status === "complete" ? "scored" : "indeterminate",
    coverage: input.coverage,
    entities: entityScore,
    relationships: relationshipScore,
    combined: prf(
      entityScore.truePositive + relationshipScore.truePositive,
      entityScore.falsePositive + relationshipScore.falsePositive,
      entityScore.falseNegative + relationshipScore.falseNegative,
    ),
    criticalRecall: ratio(matchedCriticalCount, requiredCriticalCount, 1),
    matchedCriticalCount,
    requiredCriticalCount,
    disqualifiedCandidateIds: [...new Set(disqualifiedCandidateIds)].sort(),
    duplicateMatchCandidateIds: [...new Set(duplicateMatchCandidateIds)].sort(),
  };
}

const drawingPartObservationSchema = visibleEvidenceSchema.extend({
  candidateId: stableId,
  matchedRequiredPartId: stableId.nullable(),
}).strict();

export const drawingScoringInputSchema = z.object({
  schemaVersion: z.literal(RESEARCH_SCORING_SCHEMA_VERSION),
  requiredPartIds: z.array(stableId).min(1).max(1_000),
  observedParts: z.array(drawingPartObservationSchema).max(2_000),
  constraints: z.array(z.object({
    id: stableId,
    expectation: z.enum(["present", "absent"]),
    observed: z.enum(["present", "absent", "not_assessed"]),
  }).strict()).max(500),
  visibilityThresholds: semanticVisibilityThresholdsSchema,
  coverage: evidenceCoverageSchema,
}).strict().superRefine((input, context) => {
  for (const [path, ids] of [
    [["requiredPartIds"], input.requiredPartIds],
    [["observedParts"], input.observedParts.map((part) => part.candidateId)],
    [["constraints"], input.constraints.map((constraint) => constraint.id)],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: [...path], message: "IDs must be unique." });
    }
  }
});

export type DrawingScoringInput = z.infer<typeof drawingScoringInputSchema>;

export type DrawingScore = {
  schemaVersion: 1;
  status: "scored" | "indeterminate";
  coverage: EvidenceCoverage;
  partRecall: number;
  matchedPartCount: number;
  requiredPartCount: number;
  constraintSatisfaction: number;
  passedConstraintCount: number;
  constraintCount: number;
  failedConstraintIds: string[];
  unassessedConstraintIds: string[];
  disqualifiedCandidateIds: string[];
  duplicatePartCandidateIds: string[];
};

export function scoreDrawing(raw: DrawingScoringInput): DrawingScore {
  const input = drawingScoringInputSchema.parse(raw);
  const requiredParts = new Set(input.requiredPartIds);
  const matched = new Set<string>();
  const duplicates: string[] = [];
  const disqualified: string[] = [];
  for (const part of input.observedParts) {
    if (!isEligibleEvidence(part, input.visibilityThresholds)) {
      disqualified.push(part.candidateId);
      continue;
    }
    if (!part.matchedRequiredPartId || !requiredParts.has(part.matchedRequiredPartId)) continue;
    if (matched.has(part.matchedRequiredPartId)) duplicates.push(part.candidateId);
    else matched.add(part.matchedRequiredPartId);
  }
  const failedConstraintIds: string[] = [];
  const unassessedConstraintIds: string[] = [];
  let passedConstraintCount = 0;
  for (const constraint of input.constraints) {
    if (constraint.observed === "not_assessed") {
      unassessedConstraintIds.push(constraint.id);
    } else if (constraint.observed === constraint.expectation) {
      passedConstraintCount += 1;
    } else {
      failedConstraintIds.push(constraint.id);
    }
  }
  const determinate = input.coverage.status === "complete" && unassessedConstraintIds.length === 0;
  return {
    schemaVersion: RESEARCH_SCORING_SCHEMA_VERSION,
    status: determinate ? "scored" : "indeterminate",
    coverage: input.coverage,
    partRecall: matched.size / requiredParts.size,
    matchedPartCount: matched.size,
    requiredPartCount: requiredParts.size,
    constraintSatisfaction: ratio(passedConstraintCount, input.constraints.length, 1),
    passedConstraintCount,
    constraintCount: input.constraints.length,
    failedConstraintIds,
    unassessedConstraintIds,
    disqualifiedCandidateIds: disqualified.sort(),
    duplicatePartCandidateIds: duplicates.sort(),
  };
}

export const geometryFindingCodeSchema = z.enum([
  "UNINTENDED_OFF_FRAME",
  "MICROSCOPIC_ESSENTIAL_ELEMENT",
  "TRANSPARENT_ESSENTIAL_ELEMENT",
  "TEXT_UNREADABLE",
  "LOW_CONTRAST",
  "UNINTENDED_OCCLUSION",
  "MEMBER_OBJECT_OVERLAP",
  "CONNECTOR_OBJECT_INTRUSION",
  "CONNECTOR_CROSSING",
  "CONNECTOR_LABEL_COLLISION",
  "MEMBER_SPACING",
  "INTENTIONAL_OVERLAP_DAMAGED",
]);

export const geometryScoringInputSchema = z.object({
  schemaVersion: z.literal(RESEARCH_SCORING_SCHEMA_VERSION),
  domain: z.enum(["architecture", "drawing"]),
  findings: z.array(z.object({
    code: geometryFindingCodeSchema,
    appliesTo: z.enum(["universal", "architecture", "drawing"]),
    severity: z.enum(["warning", "blocking"]),
    violations: nonNegativeInteger,
    opportunities: nonNegativeInteger,
  }).strict()).max(100),
  coverage: evidenceCoverageSchema,
}).strict().superRefine((input, context) => {
  const codes = input.findings.map((finding) => finding.code);
  if (new Set(codes).size !== codes.length) {
    context.addIssue({ code: "custom", path: ["findings"], message: "Finding codes must be unique." });
  }
  input.findings.forEach((finding, index) => {
    if (finding.violations > finding.opportunities) {
      context.addIssue({
        code: "custom",
        path: ["findings", index, "violations"],
        message: "Violations cannot exceed defined opportunities.",
      });
    }
  });
});

export type GeometryScoringInput = z.infer<typeof geometryScoringInputSchema>;

export function scoreGeometryReadability(raw: GeometryScoringInput) {
  const input = geometryScoringInputSchema.parse(raw);
  const applicable = input.findings.filter((finding) =>
    finding.appliesTo === "universal" || finding.appliesTo === input.domain);
  const blockingViolations = applicable
    .filter((finding) => finding.severity === "blocking")
    .reduce((total, finding) => total + finding.violations, 0);
  const warningViolations = applicable
    .filter((finding) => finding.severity === "warning")
    .reduce((total, finding) => total + finding.violations, 0);
  const violations = blockingViolations + warningViolations;
  const opportunities = applicable.reduce((total, finding) => total + finding.opportunities, 0);
  const nominalStatus = blockingViolations > 0 ? "fail" : warningViolations > 0 ? "warning" : "pass";
  return {
    schemaVersion: RESEARCH_SCORING_SCHEMA_VERSION,
    status: coverageAwareStatus(nominalStatus, input.coverage),
    nominalStatus,
    coverage: input.coverage,
    domain: input.domain,
    blockingViolations,
    warningViolations,
    violations,
    opportunities,
    violationRate: ratio(violations, opportunities, 0),
    byCode: Object.fromEntries(applicable.map((finding) => [finding.code, {
      severity: finding.severity,
      violations: finding.violations,
      opportunities: finding.opportunities,
      violationRate: ratio(finding.violations, finding.opportunities, 0),
    }])),
    excludedArchitectureOnlyCodes: input.domain === "drawing"
      ? input.findings.filter((finding) => finding.appliesTo === "architecture").map((finding) => finding.code)
      : [],
  };
}

const correctionRevisionSchema = z.object({
  revisionId: stableId,
  issueKeys: z.array(stableId).max(2_000),
  semanticScore: unitInterval,
  blockingViolationCount: nonNegativeInteger,
  qualityValue: z.number().finite(),
}).strict();

export const correctionScoringInputSchema = z.object({
  schemaVersion: z.literal(RESEARCH_SCORING_SCHEMA_VERSION),
  evidenceBasis: z.literal("evaluator_recomputed"),
  qualityScaleId: stableId,
  possibleIssueOpportunityCount: nonNegativeInteger,
  revisions: z.array(correctionRevisionSchema).min(2).max(32),
  coverage: evidenceCoverageSchema,
}).strict().superRefine((input, context) => {
  const ids = input.revisions.map((revision) => revision.revisionId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["revisions"], message: "Revision IDs must be unique." });
  }
  input.revisions.forEach((revision, index) => {
    if (new Set(revision.issueKeys).size !== revision.issueKeys.length) {
      context.addIssue({ code: "custom", path: ["revisions", index, "issueKeys"], message: "Issue keys must be unique." });
    }
  });
});

export type CorrectionScoringInput = z.infer<typeof correctionScoringInputSchema>;

export function scoreCorrection(raw: CorrectionScoringInput) {
  const input = correctionScoringInputSchema.parse(raw);
  const first = input.revisions[0];
  const final = input.revisions[input.revisions.length - 1];
  const firstIssues = new Set(first.issueKeys);
  const finalIssues = new Set(final.issueKeys);
  const resolvedIssueKeys = [...firstIssues].filter((key) => !finalIssues.has(key)).sort();
  const introducedIssueKeys = [...finalIssues].filter((key) => !firstIssues.has(key)).sort();
  const bestQualityValue = Math.max(...input.revisions.map((revision) => revision.qualityValue));
  const bestRevisionIds = input.revisions
    .filter((revision) => revision.qualityValue === bestQualityValue)
    .map((revision) => revision.revisionId);
  const transitions = input.revisions.slice(1).map((current, index) => {
    const previous = input.revisions[index];
    const delta = current.qualityValue - previous.qualityValue;
    return {
      fromRevisionId: previous.revisionId,
      toRevisionId: current.revisionId,
      qualityPointDelta: delta,
      outcome: delta > 0 ? "improved" as const : delta < 0 ? "degraded" as const : "held" as const,
    };
  });
  return {
    schemaVersion: RESEARCH_SCORING_SCHEMA_VERSION,
    status: input.coverage.status === "complete" ? "scored" as const : "indeterminate" as const,
    coverage: input.coverage,
    qualityScaleId: input.qualityScaleId,
    firstRevisionId: first.revisionId,
    finalRevisionId: final.revisionId,
    qualityPointDelta: final.qualityValue - first.qualityValue,
    semanticDelta: final.semanticScore - first.semanticScore,
    blockingViolationDelta: final.blockingViolationCount - first.blockingViolationCount,
    resolvedIssueKeys,
    introducedIssueKeys,
    issueResolutionRate: ratio(resolvedIssueKeys.length, firstIssues.size, 1),
    newDefectRate: ratio(introducedIssueKeys.length, input.possibleIssueOpportunityCount, 0),
    bestQualityValue,
    bestRevisionIds,
    bestStateRetained: final.qualityValue === bestQualityValue,
    finalRegressedFromFirst: final.qualityValue < first.qualityValue
      || final.semanticScore < first.semanticScore
      || final.blockingViolationCount > first.blockingViolationCount,
    degradedTransitionCount: transitions.filter((transition) => transition.outcome === "degraded").length,
    transitions,
  };
}

export const presentationScoringInputSchema = z.object({
  schemaVersion: z.literal(RESEARCH_SCORING_SCHEMA_VERSION),
  observed: z.object({
    totalDurationMs: positive,
    timeToFirstVisibleObjectMs: nonNegative,
    visibleActivityMs: nonNegative,
    revealEventCount: nonNegativeInteger,
    semanticallyOrderedRevealCount: nonNegativeInteger,
    flickerCount: nonNegativeInteger,
    duplicatePresentationFrameCount: nonNegativeInteger,
    viewportInstabilityCount: nonNegativeInteger,
    draftAuthoritativeOverlapFrameCount: nonNegativeInteger,
    handoffGapMs: nonNegative,
    artificialAuthorDelayMs: nonNegative,
    activePresentationAcceleratedOrSkipped: z.boolean(),
  }).strict(),
  criteria: z.object({
    maximumTimeToFirstVisibleObjectMs: positive,
    minimumVisibleActivityRatio: unitInterval,
    minimumRevealEventCount: z.number().int().positive(),
    minimumSemanticRevealOrderRate: unitInterval,
    maximumFlickerCount: nonNegativeInteger,
    maximumDuplicatePresentationFrameCount: nonNegativeInteger,
    maximumViewportInstabilityCount: nonNegativeInteger,
    maximumHandoffGapMs: nonNegative,
  }).strict(),
  coverage: evidenceCoverageSchema,
}).strict().superRefine((input, context) => {
  if (input.observed.visibleActivityMs > input.observed.totalDurationMs) {
    context.addIssue({ code: "custom", path: ["observed", "visibleActivityMs"], message: "Visible activity cannot exceed total duration." });
  }
  if (input.observed.timeToFirstVisibleObjectMs > input.observed.totalDurationMs) {
    context.addIssue({ code: "custom", path: ["observed", "timeToFirstVisibleObjectMs"], message: "Time to first visible object cannot exceed total duration." });
  }
  if (input.observed.semanticallyOrderedRevealCount > input.observed.revealEventCount) {
    context.addIssue({ code: "custom", path: ["observed", "semanticallyOrderedRevealCount"], message: "Ordered reveals cannot exceed reveal events." });
  }
});

export type PresentationScoringInput = z.infer<typeof presentationScoringInputSchema>;

export function scorePresentationUx(raw: PresentationScoringInput) {
  const input = presentationScoringInputSchema.parse(raw);
  const observed = input.observed;
  const criteria = input.criteria;
  const visibleActivityRatio = observed.visibleActivityMs / observed.totalDurationMs;
  const semanticRevealOrderRate = ratio(
    observed.semanticallyOrderedRevealCount,
    observed.revealEventCount,
    1,
  );
  const failedCriteria = [
    observed.timeToFirstVisibleObjectMs > criteria.maximumTimeToFirstVisibleObjectMs && "time_to_first_visible_object",
    visibleActivityRatio < criteria.minimumVisibleActivityRatio && "visible_activity_ratio",
    observed.revealEventCount < criteria.minimumRevealEventCount && "reveal_event_count",
    semanticRevealOrderRate < criteria.minimumSemanticRevealOrderRate && "semantic_reveal_order",
    observed.flickerCount > criteria.maximumFlickerCount && "flicker",
    observed.duplicatePresentationFrameCount > criteria.maximumDuplicatePresentationFrameCount && "duplicate_frames",
    observed.viewportInstabilityCount > criteria.maximumViewportInstabilityCount && "viewport_instability",
    observed.draftAuthoritativeOverlapFrameCount > 0 && "draft_authoritative_overlap",
    observed.handoffGapMs > criteria.maximumHandoffGapMs && "handoff_gap",
    observed.artificialAuthorDelayMs > 0 && "artificial_author_delay",
    observed.activePresentationAcceleratedOrSkipped && "accelerated_or_skipped",
  ].filter((value): value is string => Boolean(value));
  const nominalStatus = failedCriteria.length ? "fail" as const : "pass" as const;
  return {
    schemaVersion: RESEARCH_SCORING_SCHEMA_VERSION,
    status: coverageAwareStatus(nominalStatus, input.coverage),
    nominalStatus,
    coverage: input.coverage,
    visibleActivityRatio,
    semanticRevealOrderRate,
    failedCriteria,
  };
}

const efficiencyValuesSchema = z.object({
  toolCalls: nonNegativeInteger,
  failedToolCalls: nonNegativeInteger,
  retries: nonNegativeInteger,
  roundTrips: nonNegativeInteger,
  inputTokens: nonNegativeInteger,
  outputTokens: nonNegativeInteger,
  contextBytes: nonNegativeInteger,
  receiptBytes: nonNegativeInteger,
  wallTimeMs: nonNegative,
  timeToUsefulDraftMs: nonNegative,
  costUsd: nonNegative,
}).strict();

const efficiencyBudgetsSchema = z.object({
  toolCalls: positive,
  roundTrips: positive,
  inputTokens: positive,
  outputTokens: positive,
  contextBytes: positive,
  receiptBytes: positive,
  wallTimeMs: positive,
  timeToUsefulDraftMs: positive,
  costUsd: positive,
}).strict();

export const efficiencyScoringInputSchema = z.object({
  schemaVersion: z.literal(RESEARCH_SCORING_SCHEMA_VERSION),
  observed: efficiencyValuesSchema,
  budgets: efficiencyBudgetsSchema,
  successfulArtifact: z.boolean(),
  coverage: evidenceCoverageSchema,
}).strict().superRefine((input, context) => {
  if (input.observed.failedToolCalls > input.observed.toolCalls) {
    context.addIssue({ code: "custom", path: ["observed", "failedToolCalls"], message: "Failed calls cannot exceed tool calls." });
  }
  if (input.observed.retries > input.observed.toolCalls) {
    context.addIssue({ code: "custom", path: ["observed", "retries"], message: "Retries cannot exceed tool calls." });
  }
});

export type EfficiencyScoringInput = z.infer<typeof efficiencyScoringInputSchema>;

export function scoreEfficiency(raw: EfficiencyScoringInput) {
  const input = efficiencyScoringInputSchema.parse(raw);
  const budgetKeys = Object.keys(input.budgets) as Array<keyof typeof input.budgets>;
  const utilization = Object.fromEntries(budgetKeys.map((key) => [key, input.observed[key] / input.budgets[key]]));
  const exceededBudgetKeys = budgetKeys.filter((key) => input.observed[key] > input.budgets[key]);
  const nominalStatus = exceededBudgetKeys.length ? "fail" as const : "pass" as const;
  return {
    schemaVersion: RESEARCH_SCORING_SCHEMA_VERSION,
    status: coverageAwareStatus(nominalStatus, input.coverage),
    nominalStatus,
    coverage: input.coverage,
    successfulArtifact: input.successfulArtifact,
    basis: input.successfulArtifact ? "success_conditioned" as const : "all_attempt" as const,
    failureRate: ratio(input.observed.failedToolCalls, input.observed.toolCalls, 0),
    retryRate: ratio(input.observed.retries, input.observed.toolCalls, 0),
    totalTokens: input.observed.inputTokens + input.observed.outputTokens,
    utilization,
    maximumBudgetUtilization: Math.max(...Object.values(utilization)),
    exceededBudgetKeys,
  };
}

const acceptedGateSchema = z.object({
  passed: z.boolean(),
  coverage: evidenceCoverageSchema,
  supplementalReview: z.enum(["not_needed", "passed", "failed", "not_performed"]),
}).strict();

export const acceptedArtifactScoringInputSchema = z.object({
  schemaVersion: z.literal(RESEARCH_SCORING_SCHEMA_VERSION),
  semantic: z.object({ score: unitInterval, threshold: unitInterval }).merge(acceptedGateSchema),
  geometry: z.object({ blockingViolationCount: nonNegativeInteger }).merge(acceptedGateSchema),
  documentIntegrity: acceptedGateSchema,
  humanQuality: acceptedGateSchema,
  budget: acceptedGateSchema,
}).strict();

export type AcceptedArtifactScoringInput = z.infer<typeof acceptedArtifactScoringInputSchema>;

export function scoreAcceptedArtifact(raw: AcceptedArtifactScoringInput) {
  const input = acceptedArtifactScoringInputSchema.parse(raw);
  const gates = {
    semantic: {
      ...input.semantic,
      passed: input.semantic.passed && input.semantic.score >= input.semantic.threshold,
    },
    geometry: {
      ...input.geometry,
      passed: input.geometry.passed && input.geometry.blockingViolationCount === 0,
    },
    documentIntegrity: input.documentIntegrity,
    humanQuality: input.humanQuality,
    budget: input.budget,
  };
  const failedGates: string[] = [];
  const indeterminateGates: string[] = [];
  for (const [name, gate] of Object.entries(gates)) {
    const coverageResolved = gate.coverage.status === "complete"
      || (gate.coverage.status === "partial" && gate.supplementalReview === "passed");
    if (!gate.passed || gate.supplementalReview === "failed") failedGates.push(name);
    else if (!coverageResolved) indeterminateGates.push(name);
  }
  const outcome = failedGates.length
    ? "rejected" as const
    : indeterminateGates.length
      ? "indeterminate" as const
      : "accepted" as const;
  return {
    schemaVersion: RESEARCH_SCORING_SCHEMA_VERSION,
    outcome,
    accepted: outcome === "accepted",
    failedGates,
    indeterminateGates,
  };
}

const publicAcceptanceCriterionSchema = z.object({
  id: z.string().regex(/^criterion-[a-z0-9-]{3,120}$/),
  text: z.string().trim().min(10).max(600),
}).strict();

const requiredCapabilityCategorySchema = z.enum([
  "capability_discovery",
  "authoritative_state_read",
  "staged_authoring",
  "semantic_mutation",
  "diagram_management",
  "visual_inspection",
  "targeted_correction",
  "conflict_reconciliation",
]);

const initialStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blank") }).strict(),
  z.object({
    kind: z.literal("fixture"),
    fixtureId: z.string().regex(/^fixture-[a-z0-9-]{3,120}$/),
  }).strict(),
]);

const publicSourceMaterialSchema = z.object({
  id: z.string().regex(/^source-[a-z0-9-]{3,120}$/),
  title: z.string().trim().min(3).max(200),
  sourceKind: z.enum(["task_authoritative_synthetic", "public_reference"]),
  content: z.string().trim().min(20).max(4_000),
  url: z.string().url().optional(),
}).strict().superRefine((source, context) => {
  if (source.sourceKind === "public_reference" && source.url === undefined) {
    context.addIssue({ code: "custom", path: ["url"], message: "Public references require a URL." });
  }
});

const publicArchitecturePacketSchema = z.object({
  kind: z.literal("architecture"),
  materials: z.array(publicSourceMaterialSchema).min(1).max(8),
  entities: z.array(z.object({
    id: stableId,
    label: z.string().trim().min(1).max(160),
    description: z.string().trim().min(10).max(500),
  }).strict()).min(2).max(100),
  relationships: z.array(z.object({
    id: stableId,
    fromEntityId: stableId,
    toEntityId: stableId,
    relationshipType: stableId,
    description: z.string().trim().min(10).max(500),
  }).strict()).min(1).max(200),
  uncertaintyConstraints: z.array(z.object({
    id: stableId,
    text: z.string().trim().min(10).max(500),
  }).strict()).min(1).max(20),
}).strict().superRefine((packet, context) => {
  const entityIds = packet.entities.map((entity) => entity.id);
  const entitySet = new Set(entityIds);
  for (const [path, ids] of [
    [["materials"], packet.materials.map((source) => source.id)],
    [["entities"], entityIds],
    [["relationships"], packet.relationships.map((relationship) => relationship.id)],
    [["uncertaintyConstraints"], packet.uncertaintyConstraints.map((constraint) => constraint.id)],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: [...path], message: "Packet IDs must be unique within their collection." });
    }
  }
  packet.relationships.forEach((relationship, index) => {
    if (!entitySet.has(relationship.fromEntityId) || !entitySet.has(relationship.toEntityId)) {
      context.addIssue({
        code: "custom",
        path: ["relationships", index],
        message: "Public relationship endpoints must reference public entities.",
      });
    }
  });
});

const publicDrawingPacketSchema = z.object({
  kind: z.literal("drawing"),
  materials: z.array(publicSourceMaterialSchema).min(1).max(8),
  recognizableParts: z.array(z.object({
    id: stableId,
    label: z.string().trim().min(1).max(160),
    description: z.string().trim().min(10).max(500),
  }).strict()).min(1).max(100),
  styleDirections: z.array(z.object({
    id: stableId,
    text: z.string().trim().min(10).max(500),
  }).strict()).min(1).max(20),
  layeringConstraints: z.array(z.object({
    id: stableId,
    text: z.string().trim().min(10).max(500),
  }).strict()).min(1).max(20),
  creativeFreedom: z.array(z.string().trim().min(10).max(500)).min(1).max(20),
}).strict().superRefine((packet, context) => {
  for (const [path, ids] of [
    [["materials"], packet.materials.map((source) => source.id)],
    [["recognizableParts"], packet.recognizableParts.map((part) => part.id)],
    [["styleDirections"], packet.styleDirections.map((direction) => direction.id)],
    [["layeringConstraints"], packet.layeringConstraints.map((constraint) => constraint.id)],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: [...path], message: "Packet IDs must be unique within their collection." });
    }
  }
});

export const benchmarkTaskSchema = z.object({
  id: z.string().regex(/^dev-[a-z0-9-]{3,100}$/),
  title: z.string().trim().min(1).max(160),
  domain: z.enum(["architecture", "drawing"]),
  stratum: z.enum(["creation", "editing", "stress"]),
  operation: z.enum(["create", "edit", "diagnose"]),
  complexity: z.enum(["small", "medium", "large", "dense"]),
  brief: z.string().trim().min(20).max(2_000),
  stressors: z.array(z.enum([
    "dense_layout",
    "source_ambiguity",
    "stale_state",
    "concurrent_human_edit",
    "viewport_pressure",
    "style_preservation",
    "intentional_overlap",
    "negative_constraints",
  ])).max(8),
  antiGamingCases: z.array(z.enum([
    "off_frame",
    "microscopic",
    "transparent",
    "duplicate_keyword",
    "intentional_overlap",
    "canvas_judge_injection",
  ])).max(6),
  publicEvaluationDimensions: z.array(z.enum([
    "semantic_correctness",
    "geometry_readability",
    "perceptual_quality",
    "self_correction",
    "presentation_ux",
    "efficiency",
    "document_integrity",
  ])).min(1),
  acceptanceCriteria: z.array(publicAcceptanceCriterionSchema).min(2).max(20),
  requiredCapabilities: z.array(requiredCapabilityCategorySchema).min(1).max(8),
  initialState: initialStateSchema,
  concurrentEventFixtureId: z.string().regex(/^event-[a-z0-9-]{3,120}$/).optional(),
  publicTaskPacket: z.discriminatedUnion("kind", [
    publicArchitecturePacketSchema,
    publicDrawingPacketSchema,
  ]),
}).strict().superRefine((task, context) => {
  if (task.domain !== task.publicTaskPacket.kind) {
    context.addIssue({ code: "custom", path: ["publicTaskPacket", "kind"], message: "Task domain must match its public packet kind." });
  }
  if ((task.stratum === "editing" || task.stratum === "stress") && task.initialState.kind !== "fixture") {
    context.addIssue({ code: "custom", path: ["initialState"], message: "Editing and stress tasks require a frozen fixture." });
  }
  const criteriaIds = task.acceptanceCriteria.map((criterion) => criterion.id);
  if (new Set(criteriaIds).size !== criteriaIds.length) {
    context.addIssue({ code: "custom", path: ["acceptanceCriteria"], message: "Acceptance criterion IDs must be unique." });
  }
  if (new Set(task.requiredCapabilities).size !== task.requiredCapabilities.length) {
    context.addIssue({ code: "custom", path: ["requiredCapabilities"], message: "Capability categories must be unique." });
  }
});

export const developmentBenchmarkManifestSchema = z.object({
  schemaVersion: z.literal(RESEARCH_SCORING_SCHEMA_VERSION),
  benchmarkId: z.literal("jazzboard-development-v1"),
  split: z.literal("development"),
  description: z.string().trim().min(20).max(1_000),
  answerPolicy: z.literal("public-prompts-only-no-reference-answers-or-judge-rubrics"),
  tasks: z.array(benchmarkTaskSchema).length(12),
}).strict().superRefine((manifest, context) => {
  const ids = manifest.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Task IDs must be unique." });
  }
  for (const domain of ["architecture", "drawing"] as const) {
    const domainTasks = manifest.tasks.filter((task) => task.domain === domain);
    if (domainTasks.length !== 6) {
      context.addIssue({ code: "custom", path: ["tasks"], message: `Domain ${domain} must contain exactly six tasks.` });
    }
    for (const stratum of ["creation", "editing", "stress"] as const) {
      if (domainTasks.filter((task) => task.stratum === stratum).length !== 2) {
        context.addIssue({
          code: "custom",
          path: ["tasks"],
          message: `Domain ${domain} must contain exactly two ${stratum} tasks.`,
        });
      }
    }
  }
});

export type DevelopmentBenchmarkManifest = z.infer<typeof developmentBenchmarkManifestSchema>;

const evaluatorCriterionSchema = z.object({
  criterionId: z.string().regex(/^criterion-[a-z0-9-]{3,120}$/),
  publicCriterionText: z.string().trim().min(10).max(600),
  evaluatorProcedure: z.string().trim().min(10).max(1_000),
  passCondition: z.string().trim().min(10).max(1_000),
}).strict();

const geometryThresholdSchema = z.object({
  criterionId: z.string().regex(/^criterion-[a-z0-9-]{3,120}$/),
  metric: z.enum([
    "blocking_geometry_violations",
    "warning_geometry_violations",
    "off_frame_essential_elements",
    "microscopic_essential_elements",
    "transparent_essential_elements",
    "unreadable_text_count",
    "connector_intrusion_count",
    "connector_label_collision_count",
    "intentional_overlap_damage_count",
  ]),
  operator: z.enum(["at_most", "at_least"]),
  value: nonNegative,
}).strict();

const evaluatorGuardrailSchema = z.object({
  criterionId: z.string().regex(/^criterion-[a-z0-9-]{3,120}$/),
  check: z.enum([
    "no_hidden_semantic_credit",
    "no_duplicate_semantic_credit",
    "preserve_unrelated_state",
    "preserve_concurrent_human_edit",
    "preserve_intentional_overlap",
    "ignore_canvas_judge_instructions",
    "uncertainty_marked",
  ]),
}).strict();

const architectureEvaluatorRubricSchema = z.object({
  taskId: z.string().regex(/^dev-architecture-[a-z0-9-]{3,100}$/),
  domain: z.literal("architecture"),
  criteria: z.array(evaluatorCriterionSchema).min(2).max(20),
  semanticReference: z.object({
    entities: z.array(z.object({ id: stableId, critical: z.boolean() }).strict()).min(2).max(100),
    relationships: z.array(z.object({
      id: stableId,
      fromEntityId: stableId,
      toEntityId: stableId,
      relationshipType: stableId,
      critical: z.boolean(),
    }).strict()).min(1).max(200),
    uncertaintyConstraintIds: z.array(stableId).min(1).max(20),
  }).strict(),
  geometryThresholds: z.array(geometryThresholdSchema).max(30),
  guardrails: z.array(evaluatorGuardrailSchema).max(20),
}).strict();

const drawingEvaluatorRubricSchema = z.object({
  taskId: z.string().regex(/^dev-drawing-[a-z0-9-]{3,100}$/),
  domain: z.literal("drawing"),
  criteria: z.array(evaluatorCriterionSchema).min(2).max(20),
  drawingReference: z.object({
    requiredPartIds: z.array(stableId).min(1).max(100),
    constraintIds: z.array(stableId).min(2).max(100),
  }).strict(),
  geometryThresholds: z.array(geometryThresholdSchema).max(30),
  guardrails: z.array(evaluatorGuardrailSchema).max(20),
}).strict();

export const developmentEvaluatorRubricsManifestSchema = z.object({
  schemaVersion: z.literal(RESEARCH_SCORING_SCHEMA_VERSION),
  rubricId: z.literal("jazzboard-development-evaluator-rubrics-v1"),
  benchmarkId: z.literal("jazzboard-development-v1"),
  scope: z.literal("development-only-public-criteria-operationalization"),
  rubrics: z.array(z.discriminatedUnion("domain", [
    architectureEvaluatorRubricSchema,
    drawingEvaluatorRubricSchema,
  ])).length(12),
}).strict().superRefine((manifest, context) => {
  const taskIds = manifest.rubrics.map((rubric) => rubric.taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    context.addIssue({ code: "custom", path: ["rubrics"], message: "Evaluator rubric task IDs must be unique." });
  }
  manifest.rubrics.forEach((rubric, index) => {
    const criterionIds = rubric.criteria.map((criterion) => criterion.criterionId);
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({ code: "custom", path: ["rubrics", index, "criteria"], message: "Evaluator criterion IDs must be unique." });
    }
  });
});

const fixtureBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: positive,
  height: positive,
  zIndex: z.number().int(),
  opacity: unitInterval,
}).strict();

const fixtureOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_object"),
    objectRef: stableId,
    objectKind: z.enum(["shape", "text", "path", "draw"]),
    nodeType: z.enum(["service", "component", "requirement", "decision", "open_question"]).nullable(),
    semanticName: z.string().trim().min(1).max(160),
    semanticRole: z.string().trim().min(1).max(160),
    content: z.string().max(1_000),
    bounds: fixtureBoundsSchema,
    style: z.object({ fill: z.string().min(1).max(64), stroke: z.string().min(1).max(64) }).strict(),
    pathGeometry: z.object({
      closed: z.boolean(),
      normalizedPoints: z.array(z.object({
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
      }).strict()).min(2).max(500),
    }).strict().optional(),
    issueTags: z.array(z.enum([
      "none",
      "off_frame",
      "unreadable_label",
      "connector_intrusion",
      "unsupported_certainty",
      "cropped_essential_part",
      "intentional_overlap",
      "judge_injection_text",
    ])).min(1).max(6),
  }).strict().superRefine((operation, context) => {
    if ((operation.objectKind === "path" || operation.objectKind === "draw") && !operation.pathGeometry) {
      context.addIssue({ code: "custom", path: ["pathGeometry"], message: "Path and draw fixture objects require explicit normalized geometry." });
    }
    if (operation.objectKind === "path" && operation.pathGeometry
      && operation.pathGeometry.closed && operation.pathGeometry.normalizedPoints.length < 3) {
      context.addIssue({ code: "custom", path: ["pathGeometry", "normalizedPoints"], message: "Closed paths require at least three points." });
    }
    if (operation.objectKind !== "path" && operation.objectKind !== "draw" && operation.pathGeometry) {
      context.addIssue({ code: "custom", path: ["pathGeometry"], message: "Only path and draw fixtures may declare path geometry." });
    }
  }),
  z.object({
    type: z.literal("create_relationship"),
    relationshipRef: stableId,
    fromObjectRef: stableId,
    toObjectRef: stableId,
    label: z.string().max(500),
    direction: z.enum(["none", "end", "both"]),
    routing: z.enum(["straight", "elbow", "curved"]),
    issueTags: z.array(z.enum(["none", "unreadable_label", "connector_intrusion"])).min(1).max(3),
  }).strict(),
  z.object({
    type: z.literal("update_object"),
    objectRef: stableId,
    expectedFixtureRevision: z.number().int().positive(),
    changes: z.object({
      content: z.string().max(1_000).optional(),
      semanticName: z.string().trim().min(1).max(160).optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      zIndex: z.number().int().optional(),
    }).strict().refine((changes) => Object.keys(changes).length > 0, "Fixture update must change at least one field."),
  }).strict(),
]);

const developmentFixtureSchema = z.object({
  fixtureId: z.string().regex(/^fixture-[a-z0-9-]{3,120}$/),
  domain: z.enum(["architecture", "drawing"]),
  description: z.string().trim().min(10).max(500),
  frozenVersion: z.literal(1),
  preBriefSetup: z.object({
    operations: z.array(fixtureOperationSchema).min(1).max(200),
  }).strict(),
}).strict().superRefine((fixture, context) => {
  const createdRefs = fixture.preBriefSetup.operations.flatMap((operation) =>
    operation.type === "create_object" ? [operation.objectRef] : []);
  if (new Set(createdRefs).size !== createdRefs.length) {
    context.addIssue({ code: "custom", path: ["preBriefSetup", "operations"], message: "Created fixture object refs must be unique." });
  }
  const created = new Set(createdRefs);
  fixture.preBriefSetup.operations.forEach((operation, index) => {
    if (fixture.domain === "architecture" && operation.type === "create_object"
      && operation.objectKind === "shape" && operation.semanticRole !== "layout_scaffold"
      && operation.nodeType === null) {
      context.addIssue({
        code: "custom",
        path: ["preBriefSetup", "operations", index, "nodeType"],
        message: "Architecture fixture shapes require an explicit node classification.",
      });
    }
    if (operation.type === "create_relationship"
      && (!created.has(operation.fromObjectRef) || !created.has(operation.toObjectRef))) {
      context.addIssue({
        code: "custom",
        path: ["preBriefSetup", "operations", index],
        message: "Fixture relationships must reference created fixture objects.",
      });
    }
  });
});

const concurrentEventFixtureSchema = z.object({
  eventFixtureId: z.string().regex(/^event-[a-z0-9-]{3,120}$/),
  domain: z.enum(["architecture", "drawing"]),
  description: z.string().trim().min(10).max(500),
  observableTrigger: z.object({
    kind: z.literal("after_observable"),
    observable: z.enum(["first_author_mutation", "first_visual_inspection", "first_draft_staged"]),
    occurrence: z.literal(1),
  }).strict(),
  operations: z.array(fixtureOperationSchema).min(1).max(50),
}).strict();

export const developmentFixtureSpecsManifestSchema = z.object({
  schemaVersion: z.literal(RESEARCH_SCORING_SCHEMA_VERSION),
  fixtureSpecId: z.literal("jazzboard-development-fixture-specs-v1"),
  benchmarkId: z.literal("jazzboard-development-v1"),
  coordinatorContract: z.literal("trusted-pre-brief-semantic-setup-with-observable-trigger-events"),
  fixtures: z.array(developmentFixtureSchema).min(1).max(50),
  concurrentEvents: z.array(concurrentEventFixtureSchema).max(20),
}).strict().superRefine((manifest, context) => {
  for (const [path, ids] of [
    [["fixtures"], manifest.fixtures.map((fixture) => fixture.fixtureId)],
    [["concurrentEvents"], manifest.concurrentEvents.map((event) => event.eventFixtureId)],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: [...path], message: "Fixture IDs must be unique." });
    }
  }
});

export type DevelopmentEvaluatorRubricsManifest = z.infer<typeof developmentEvaluatorRubricsManifestSchema>;
export type DevelopmentFixtureSpecsManifest = z.infer<typeof developmentFixtureSpecsManifestSchema>;

function equalStringSets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

/** Cross-file validation keeps public task packets authoritative and fixtures resolvable. */
export function validateDevelopmentBenchmarkBundle(
  rawBenchmark: unknown,
  rawRubrics: unknown,
  rawFixtureSpecs: unknown,
) {
  const benchmark = developmentBenchmarkManifestSchema.parse(rawBenchmark);
  const rubrics = developmentEvaluatorRubricsManifestSchema.parse(rawRubrics);
  const fixtureSpecs = developmentFixtureSpecsManifestSchema.parse(rawFixtureSpecs);
  const rubricByTaskId = new Map(rubrics.rubrics.map((rubric) => [rubric.taskId, rubric]));
  const fixtureById = new Map(fixtureSpecs.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const eventById = new Map(fixtureSpecs.concurrentEvents.map((event) => [event.eventFixtureId, event]));
  const failures: string[] = [];
  for (const task of benchmark.tasks) {
    const rubric = rubricByTaskId.get(task.id);
    if (!rubric) {
      failures.push(`${task.id}: missing evaluator rubric`);
      continue;
    }
    const publicCriteria = new Map(task.acceptanceCriteria.map((criterion) => [criterion.id, criterion.text]));
    const rubricCriteria = new Map(rubric.criteria.map((criterion) => [criterion.criterionId, criterion.publicCriterionText]));
    if (publicCriteria.size !== rubricCriteria.size || [...publicCriteria].some(
      ([id, text]) => rubricCriteria.get(id) !== text,
    )) failures.push(`${task.id}: evaluator criteria do not exactly mirror public criteria`);
    for (const criterion of rubric.criteria) {
      const publicText = publicCriteria.get(criterion.criterionId);
      if (publicText && (
        criterion.evaluatorProcedure !== `Inspect the exact final semantic state and clean render only for the public requirement: ${publicText}`
        || criterion.passCondition !== `Pass only when the public requirement is visibly and semantically satisfied: ${publicText}`
      )) failures.push(`${task.id}: evaluator procedure adds content beyond the public criterion`);
    }
    for (const threshold of rubric.geometryThresholds) {
      if (!publicCriteria.has(threshold.criterionId)) failures.push(`${task.id}: geometry threshold adds a surprise criterion`);
    }
    for (const guardrail of rubric.guardrails) {
      if (!publicCriteria.has(guardrail.criterionId)) failures.push(`${task.id}: guardrail adds a surprise criterion`);
    }
    if (task.publicTaskPacket.kind === "architecture" && rubric.domain === "architecture") {
      const publicEntities = task.publicTaskPacket.entities.map((entity) => entity.id);
      const publicRelationships = task.publicTaskPacket.relationships.map((relationship) => relationship.id);
      const publicUncertainty = task.publicTaskPacket.uncertaintyConstraints.map((constraint) => constraint.id);
      if (!equalStringSets(publicEntities, rubric.semanticReference.entities.map((entity) => entity.id))) {
        failures.push(`${task.id}: semantic entity reference differs from public packet`);
      }
      if (!equalStringSets(publicRelationships, rubric.semanticReference.relationships.map((relationship) => relationship.id))) {
        failures.push(`${task.id}: semantic relationship reference differs from public packet`);
      }
      if (!equalStringSets(publicUncertainty, rubric.semanticReference.uncertaintyConstraintIds)) {
        failures.push(`${task.id}: uncertainty reference differs from public packet`);
      }
      for (const publicRelationship of task.publicTaskPacket.relationships) {
        const reference = rubric.semanticReference.relationships.find((item) => item.id === publicRelationship.id);
        if (!reference
          || reference.fromEntityId !== publicRelationship.fromEntityId
          || reference.toEntityId !== publicRelationship.toEntityId
          || reference.relationshipType !== publicRelationship.relationshipType) {
          failures.push(`${task.id}: relationship ${publicRelationship.id} changes a public fact`);
        }
      }
    } else if (task.publicTaskPacket.kind === "drawing" && rubric.domain === "drawing") {
      const publicParts = task.publicTaskPacket.recognizableParts.map((part) => part.id);
      const publicConstraints = [
        ...task.publicTaskPacket.styleDirections.map((direction) => direction.id),
        ...task.publicTaskPacket.layeringConstraints.map((constraint) => constraint.id),
      ];
      if (!equalStringSets(publicParts, rubric.drawingReference.requiredPartIds)) {
        failures.push(`${task.id}: drawing part reference differs from public packet`);
      }
      if (!equalStringSets(publicConstraints, rubric.drawingReference.constraintIds)) {
        failures.push(`${task.id}: drawing constraints differ from public packet`);
      }
    } else {
      failures.push(`${task.id}: rubric domain differs from task packet`);
    }
    if (task.initialState.kind === "fixture") {
      const fixture = fixtureById.get(task.initialState.fixtureId);
      if (!fixture) failures.push(`${task.id}: initial fixture does not resolve`);
      else if (fixture.domain !== task.domain) failures.push(`${task.id}: initial fixture domain differs`);
    }
    if (task.concurrentEventFixtureId) {
      const event = eventById.get(task.concurrentEventFixtureId);
      if (!event) failures.push(`${task.id}: concurrent event fixture does not resolve`);
      else if (event.domain !== task.domain) failures.push(`${task.id}: concurrent event fixture domain differs`);
    }
  }
  for (const rubric of rubrics.rubrics) {
    if (!benchmark.tasks.some((task) => task.id === rubric.taskId)) failures.push(`${rubric.taskId}: rubric has no public task`);
  }
  if (failures.length) throw new Error(`Invalid development benchmark bundle:\n${failures.join("\n")}`);
  return { benchmark, rubrics, fixtureSpecs };
}
