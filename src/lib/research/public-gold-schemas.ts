import { z } from "zod";

import { FROZEN_PRIMARY_FAILURE_CLASSES } from "./blinded-review-orchestration";
import { hashCanonicalJson } from "./provenance-crypto";

const compareCodeUnits = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const stableIdSchema = z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const sortedUniqueIdsSchema = z.array(stableIdSchema).max(256).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Identifiers must be unique." });
  }
  if (values.some((value, index) => index > 0 && compareCodeUnits(values[index - 1], value) >= 0)) {
    context.addIssue({ code: "custom", message: "Identifiers must be in strict lexical order." });
  }
});

export const publicGoldDomainSchema = z.enum(["architecture", "drawing"]);
export const publicGoldCorruptionFamilySchema = z.enum([
  "semantic",
  "visual",
  "integrity",
  "correction",
  "drawing_specific",
  "architecture_specific",
]);

const evaluatedReviewerCapabilitySchema = z.enum(["primary_measurement", "primary_standard", "adjudicator"]);

const identitySchema = z.discriminatedUnion("role", [
  z.object({
    identityId: stableIdSchema,
    role: z.enum(["corpus_author", "gold_primary_rater", "gold_adjudicator"]),
    qualificationDigest: sha256Schema,
  }).strict(),
  z.object({
    identityId: stableIdSchema,
    role: z.literal("evaluated_reviewer"),
    qualificationDigest: sha256Schema,
    reviewerCapabilities: z.array(evaluatedReviewerCapabilitySchema).min(1).max(3).superRefine((values, context) => {
      if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "Evaluated-reviewer capabilities must be unique." });
      if (values.some((value, index) => index > 0 && compareCodeUnits(values[index - 1], value) >= 0)) {
        context.addIssue({ code: "custom", message: "Evaluated-reviewer capabilities must be in strict lexical order." });
      }
    }),
  }).strict(),
]);

const rubricCriterionSchema = z.object({
  criterionId: stableIdSchema,
  criterionDigest: sha256Schema,
}).strict();

const criterionLabelSchema = z.object({
  criterionId: stableIdSchema,
  decision: z.enum(["pass", "fail"]),
  evidenceDigests: z.array(sha256Schema).min(1).max(16),
}).strict();

const goldRatingSchema = z.object({
  ratingId: stableIdSchema,
  artifactId: stableIdSchema,
  raterIdentityId: stableIdSchema,
  role: z.enum(["primary", "adjudicator"]),
  accepted: z.boolean(),
  criteria: z.array(criterionLabelSchema).min(1).max(256),
  primaryClass: stableIdSchema,
  mechanismTags: sortedUniqueIdsSchema,
  criticalIntegrityIncident: z.boolean(),
  artifactDigest: sha256Schema,
  renderDigest: sha256Schema,
  semanticStateDigest: sha256Schema,
  rubricDigest: sha256Schema,
  failureTaxonomyDigest: sha256Schema,
  lockedAt: timestampSchema,
}).strict();

const corruptionProvenanceSchema = z.object({
  operatorId: stableIdSchema,
  operatorVersion: stableIdSchema,
  family: publicGoldCorruptionFamilySchema,
  parentArtifactId: stableIdSchema,
  parentArtifactDigest: sha256Schema,
  mutationDigest: sha256Schema,
  targetCriterionIds: sortedUniqueIdsSchema,
  generatorIdentityId: stableIdSchema,
  generatedAt: timestampSchema,
  establishesAcceptance: z.literal(false),
}).strict();

const artifactSchema = z.object({
  artifactId: stableIdSchema,
  sourceClusterId: stableIdSchema,
  domain: publicGoldDomainSchema,
  artifactKind: z.enum(["source_exemplar", "corruption_variant"]),
  creatorIdentityId: stableIdSchema,
  artifactDigest: sha256Schema,
  renderDigest: sha256Schema,
  semanticStateDigest: sha256Schema,
  rubricDigest: sha256Schema,
  integrityEvidenceDigest: sha256Schema.nullable(),
  createdAt: timestampSchema,
  corruption: corruptionProvenanceSchema.nullable(),
  gold: z.object({
    primaryRatings: z.array(goldRatingSchema).length(2),
    adjudication: goldRatingSchema.nullable(),
  }).strict(),
}).strict();

const sourceClusterSchema = z.object({
  sourceClusterId: stableIdSchema,
  domain: publicGoldDomainSchema,
  sourceExemplarArtifactId: stableIdSchema,
  artifactIds: sortedUniqueIdsSchema,
  sourceProvenanceDigest: sha256Schema,
  authorIdentityId: stableIdSchema,
}).strict();

const corruptionOperatorSchema = z.object({
  operatorId: stableIdSchema,
  operatorVersion: stableIdSchema,
  family: publicGoldCorruptionFamilySchema,
  implementationDigest: sha256Schema,
  frozenAt: timestampSchema,
}).strict();

const graduationThresholdsSchema = z.object({
  thresholdsId: stableIdSchema,
  thresholdsDigest: sha256Schema,
  frozenAt: timestampSchema,
  selectedWithoutEvaluatedOutputs: z.literal(true),
  minimumArchitectureSensitivityWilsonLower95: z.number().finite().min(0).max(1),
  minimumArchitectureSpecificityWilsonLower95: z.number().finite().min(0).max(1),
  minimumDrawingSensitivityWilsonLower95: z.number().finite().min(0).max(1),
  minimumDrawingSpecificityWilsonLower95: z.number().finite().min(0).max(1),
  maximumNonEvaluableRate: z.number().finite().min(0).max(1),
  maximumDomainFalseAcceptRateGap: z.number().finite().min(0).max(1),
  criticalIntegrityFalseAcceptMaximum: z.literal(0),
  minimumSourceClustersPerDomain: z.number().int().min(2).max(10_000),
  clusterBootstrapSeed: z.number().int().min(0).max(0xffff_ffff),
  clusterBootstrapDrawCount: z.number().int().min(1_000).max(100_000),
}).strict();

function omitSelfDigest(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Digest commitments require a plain object.");
  const result = { ...(value as Record<string, unknown>) };
  delete result[field];
  return result;
}

export function computePublicGoldThresholdsDigest(value: unknown): string {
  return hashCanonicalJson(omitSelfDigest(value, "thresholdsDigest"));
}

export function computePublicGoldManifestDigest(value: unknown): string {
  return hashCanonicalJson(omitSelfDigest(value, "manifestDigest"));
}

export function computePublicGoldPlanDigest(value: unknown): string {
  return hashCanonicalJson(omitSelfDigest(value, "planDigest"));
}

export function computePublicGoldReviewRecordDigest(value: unknown): string {
  return hashCanonicalJson(omitSelfDigest(value, "recordDigest"));
}

export const publicGoldCorpusManifestSchema = z.object({
  schemaVersion: z.literal(1),
  corpusId: stableIdSchema,
  corpusVersion: stableIdSchema,
  corpusKind: z.enum(["infrastructure_fixture", "public_gold_candidate"]),
  partition: z.literal("public_development"),
  containsSealedMaterial: z.literal(false),
  createdAt: timestampSchema,
  goldLockedAt: timestampSchema,
  evaluationOpenedAt: timestampSchema,
  goldLockedWithoutEvaluatedOutputs: z.literal(true),
  manifestDigest: sha256Schema,
  identities: z.array(identitySchema).min(5).max(10_000),
  rubric: z.object({
    rubricId: stableIdSchema,
    rubricDigest: sha256Schema,
    criteria: z.array(rubricCriterionSchema).min(1).max(256),
  }).strict(),
  failureTaxonomy: z.object({
    taxonomyId: stableIdSchema,
    taxonomyDigest: sha256Schema,
    primaryClasses: z.array(stableIdSchema).min(2).max(64),
    mechanismTags: sortedUniqueIdsSchema,
  }).strict(),
  corruptionOperators: z.array(corruptionOperatorSchema).min(1).max(256),
  sourceClusters: z.array(sourceClusterSchema).min(2).max(10_000),
  artifacts: z.array(artifactSchema).min(4).max(100_000),
  graduationThresholds: graduationThresholdsSchema,
}).strict().superRefine((manifest, context) => {
  const identityById = new Map(manifest.identities.map((identity) => [identity.identityId, identity]));
  const artifactById = new Map(manifest.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const clusterById = new Map(manifest.sourceClusters.map((cluster) => [cluster.sourceClusterId, cluster]));
  const criteria = new Set(manifest.rubric.criteria.map((criterion) => criterion.criterionId));
  const primaryClasses = new Set(manifest.failureTaxonomy.primaryClasses);
  const mechanismTags = new Set(manifest.failureTaxonomy.mechanismTags);
  const operatorByKey = new Map(manifest.corruptionOperators.map((operator) => [
    `${operator.operatorId}:${operator.operatorVersion}`,
    operator,
  ]));

  if (manifest.graduationThresholds.thresholdsDigest !== computePublicGoldThresholdsDigest(manifest.graduationThresholds)) {
    context.addIssue({ code: "custom", path: ["graduationThresholds", "thresholdsDigest"], message: "Graduation-threshold digest does not match the canonical threshold bytes." });
  }
  if (manifest.manifestDigest !== computePublicGoldManifestDigest(manifest)) {
    context.addIssue({ code: "custom", path: ["manifestDigest"], message: "Corpus manifest digest does not match the canonical manifest bytes." });
  }

  function requireUnique(values: readonly string[], path: (string | number)[], message: string) {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", path, message });
  }

  requireUnique(manifest.identities.map((identity) => identity.identityId), ["identities"], "Identity IDs must be globally unique; one identity may not hold multiple study roles.");
  requireUnique(manifest.rubric.criteria.map((criterion) => criterion.criterionId), ["rubric", "criteria"], "Rubric criterion IDs must be unique.");
  requireUnique(manifest.failureTaxonomy.primaryClasses, ["failureTaxonomy", "primaryClasses"], "Primary failure classes must be unique and preserve frozen precedence order.");
  if (JSON.stringify(manifest.failureTaxonomy.primaryClasses) !== JSON.stringify(FROZEN_PRIMARY_FAILURE_CLASSES)) {
    context.addIssue({ code: "custom", path: ["failureTaxonomy", "primaryClasses"], message: "Public-gold evaluation must use the exact production primary-class set and frozen precedence order." });
  }
  requireUnique(manifest.sourceClusters.map((cluster) => cluster.sourceClusterId), ["sourceClusters"], "Source-cluster IDs must be unique.");
  requireUnique(manifest.artifacts.map((artifact) => artifact.artifactId), ["artifacts"], "Artifact IDs must be unique.");
  requireUnique(manifest.artifacts.map((artifact) => artifact.artifactDigest), ["artifacts"], "Artifact byte digests must be unique across corpus entries.");
  requireUnique(manifest.corruptionOperators.map((operator) => `${operator.operatorId}:${operator.operatorVersion}`), ["corruptionOperators"], "Corruption operator ID/version pairs must be unique.");

  const roles = new Map<string, number>();
  manifest.identities.forEach((identity) => roles.set(identity.role, (roles.get(identity.role) ?? 0) + 1));
  if ((roles.get("gold_primary_rater") ?? 0) < 2) context.addIssue({ code: "custom", path: ["identities"], message: "At least two independent primary gold raters are required." });
  if ((roles.get("gold_adjudicator") ?? 0) < 1) context.addIssue({ code: "custom", path: ["identities"], message: "At least one independent gold adjudicator is required." });
  if ((roles.get("evaluated_reviewer") ?? 0) < 3) context.addIssue({ code: "custom", path: ["identities"], message: "Two independent evaluated primaries plus an independent adjudicator identity are required." });

  const createdAt = Date.parse(manifest.createdAt);
  const goldLockedAt = Date.parse(manifest.goldLockedAt);
  const evaluationOpenedAt = Date.parse(manifest.evaluationOpenedAt);
  if (!(createdAt <= goldLockedAt && goldLockedAt < evaluationOpenedAt)) {
    context.addIssue({ code: "custom", path: ["goldLockedAt"], message: "Gold must lock after corpus creation and strictly before evaluation opens." });
  }
  if (Date.parse(manifest.graduationThresholds.frozenAt) > goldLockedAt) {
    context.addIssue({ code: "custom", path: ["graduationThresholds", "frozenAt"], message: "Graduation thresholds must freeze no later than the gold lock." });
  }

  const ratingIds: string[] = [];
  manifest.artifacts.forEach((artifact, artifactIndex) => {
    const cluster = clusterById.get(artifact.sourceClusterId);
    const creator = identityById.get(artifact.creatorIdentityId);
    if (!cluster) context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "sourceClusterId"], message: "Artifact references an unknown source cluster." });
    if (cluster && cluster.domain !== artifact.domain) context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "domain"], message: "Artifact domain must match its source cluster." });
    if (!creator || creator.role !== "corpus_author") context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "creatorIdentityId"], message: "Artifact creators must be declared corpus authors." });
    if (artifact.rubricDigest !== manifest.rubric.rubricDigest) context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "rubricDigest"], message: "Artifact rubric digest must match the frozen corpus rubric." });
    if (Date.parse(artifact.createdAt) > goldLockedAt) context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "createdAt"], message: "Artifacts may not be created after the gold lock." });

    if (artifact.artifactKind === "source_exemplar" && artifact.corruption !== null) {
      context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "corruption"], message: "Source exemplars may not carry corruption provenance." });
    }
    if (artifact.artifactKind === "corruption_variant" && artifact.corruption === null) {
      context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "corruption"], message: "Every corruption variant requires frozen provenance." });
    }
    if (artifact.corruption) {
      const parent = artifactById.get(artifact.corruption.parentArtifactId);
      const generator = identityById.get(artifact.corruption.generatorIdentityId);
      const operator = operatorByKey.get(`${artifact.corruption.operatorId}:${artifact.corruption.operatorVersion}`);
      if (!parent || parent.artifactKind !== "source_exemplar") context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "corruption", "parentArtifactId"], message: "Corruption parent must be an existing source exemplar." });
      if (parent && (parent.sourceClusterId !== artifact.sourceClusterId || parent.artifactDigest !== artifact.corruption.parentArtifactDigest)) {
        context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "corruption"], message: "Corruption provenance must bind the exact parent in the same source cluster." });
      }
      if (!generator || generator.role !== "corpus_author") context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "corruption", "generatorIdentityId"], message: "Corruption generators must be declared corpus authors." });
      if (!operator || operator.family !== artifact.corruption.family) context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "corruption", "operatorId"], message: "Corruption provenance must reference the matching frozen operator." });
      if (operator && Date.parse(operator.frozenAt) > Date.parse(artifact.corruption.generatedAt)) context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "corruption", "generatedAt"], message: "A corruption operator must freeze before it generates a variant." });
      if (artifact.corruption.targetCriterionIds.length === 0 || artifact.corruption.targetCriterionIds.some((criterionId) => !criteria.has(criterionId))) {
        context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "corruption", "targetCriterionIds"], message: "Corruption targets must name at least one frozen rubric criterion." });
      }
      if (Date.parse(artifact.corruption.generatedAt) > goldLockedAt) context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "corruption", "generatedAt"], message: "Corruption variants must be generated before the gold lock." });
    }

    const ratings = [...artifact.gold.primaryRatings, ...(artifact.gold.adjudication ? [artifact.gold.adjudication] : [])];
    ratings.forEach((rating, ratingIndex) => {
      ratingIds.push(rating.ratingId);
      const rater = identityById.get(rating.raterIdentityId);
      const expectedRole = rating.role === "primary" ? "gold_primary_rater" : "gold_adjudicator";
      if (!rater || rater.role !== expectedRole) context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "gold", ratingIndex], message: "Gold labels must use an independently declared rater for their role." });
      if (rating.artifactId !== artifact.artifactId
        || rating.artifactDigest !== artifact.artifactDigest
        || rating.renderDigest !== artifact.renderDigest
        || rating.semanticStateDigest !== artifact.semanticStateDigest
        || rating.rubricDigest !== artifact.rubricDigest
        || rating.failureTaxonomyDigest !== manifest.failureTaxonomy.taxonomyDigest) {
        context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "gold", ratingIndex], message: "Every gold label must bind the exact artifact, render, semantic state, and rubric digests." });
      }
      const ratingCriterionIds = rating.criteria.map((criterion) => criterion.criterionId);
      if (ratingCriterionIds.length !== criteria.size || new Set(ratingCriterionIds).size !== criteria.size || ratingCriterionIds.some((criterionId) => !criteria.has(criterionId))) {
        context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "gold", ratingIndex, "criteria"], message: "Every gold label must decide every rubric criterion exactly once." });
      }
      const allPass = rating.criteria.every((criterion) => criterion.decision === "pass");
      if (!primaryClasses.has(rating.primaryClass) || rating.mechanismTags.some((tag) => !mechanismTags.has(tag))) {
        context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "gold", ratingIndex], message: "Gold classes and mechanism tags must come from the frozen failure taxonomy." });
      }
      if (rating.accepted !== allPass || (rating.accepted ? rating.primaryClass !== "SUCCESS" : rating.primaryClass === "SUCCESS")) {
        context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "gold", ratingIndex], message: "Gold acceptance, criteria, and primary class must reconcile." });
      }
      if (Date.parse(rating.lockedAt) > goldLockedAt || Date.parse(rating.lockedAt) >= evaluationOpenedAt) {
        context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "gold", ratingIndex, "lockedAt"], message: "Gold labels must lock before evaluation opens and no later than the corpus gold lock." });
      }
    });

    const [first, second] = artifact.gold.primaryRatings;
    if (first.role !== "primary" || second.role !== "primary" || first.raterIdentityId === second.raterIdentityId) {
      context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "gold", "primaryRatings"], message: "Exactly two distinct independent primary raters are required." });
    }
    const signature = (rating: z.infer<typeof goldRatingSchema>) => JSON.stringify({
      accepted: rating.accepted,
      criteria: [...rating.criteria].sort((a, b) => compareCodeUnits(a.criterionId, b.criterionId)).map(({ criterionId, decision }) => ({ criterionId, decision })),
      primaryClass: rating.primaryClass,
      mechanismTags: rating.mechanismTags,
      criticalIntegrityIncident: rating.criticalIntegrityIncident,
    });
    const disagreement = signature(first) !== signature(second);
    if (disagreement !== (artifact.gold.adjudication !== null)) {
      context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "gold", "adjudication"], message: disagreement
        ? "Every material primary-label disagreement requires independent adjudication."
        : "Agreed primary labels must not receive outcome-selective adjudication." });
    }
    if (artifact.gold.adjudication && artifact.gold.adjudication.role !== "adjudicator") {
      context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "gold", "adjudication", "role"], message: "Gold adjudication must use the adjudicator role." });
    }
    if (artifact.artifactKind === "source_exemplar" && !resolvePublicGoldLabel(artifact).accepted) {
      context.addIssue({ code: "custom", path: ["artifacts", artifactIndex, "gold"], message: "Each source exemplar must be independently gold-labeled as accepted." });
    }
  });
  requireUnique(ratingIds, ["artifacts"], "Gold rating IDs must be globally unique.");

  manifest.sourceClusters.forEach((cluster, clusterIndex) => {
    const author = identityById.get(cluster.authorIdentityId);
    if (!author || author.role !== "corpus_author") context.addIssue({ code: "custom", path: ["sourceClusters", clusterIndex, "authorIdentityId"], message: "Source-cluster authors must be declared corpus authors." });
    const source = artifactById.get(cluster.sourceExemplarArtifactId);
    if (!source || source.artifactKind !== "source_exemplar" || source.sourceClusterId !== cluster.sourceClusterId) {
      context.addIssue({ code: "custom", path: ["sourceClusters", clusterIndex, "sourceExemplarArtifactId"], message: "Each cluster must identify its source exemplar." });
    }
    const actualIds = manifest.artifacts.filter((artifact) => artifact.sourceClusterId === cluster.sourceClusterId).map((artifact) => artifact.artifactId).sort(compareCodeUnits);
    if (JSON.stringify(cluster.artifactIds) !== JSON.stringify(actualIds)) {
      context.addIssue({ code: "custom", path: ["sourceClusters", clusterIndex, "artifactIds"], message: "Cluster membership must include every and only the artifacts in that cluster." });
    }
    if (cluster.artifactIds.length < 2) context.addIssue({ code: "custom", path: ["sourceClusters", clusterIndex, "artifactIds"], message: "Every source exemplar cluster requires at least one independently tracked variant." });
  });

  manifest.corruptionOperators.forEach((operator, operatorIndex) => {
    if (Date.parse(operator.frozenAt) > goldLockedAt) context.addIssue({ code: "custom", path: ["corruptionOperators", operatorIndex, "frozenAt"], message: "Corruption operators must freeze before the corpus gold lock." });
    const used = manifest.artifacts.some((artifact) => artifact.corruption?.operatorId === operator.operatorId
      && artifact.corruption.operatorVersion === operator.operatorVersion);
    if (!used) context.addIssue({ code: "custom", path: ["corruptionOperators", operatorIndex], message: "Frozen corruption-operator registry entries may not be orphaned from the corpus." });
  });

  for (const domain of publicGoldDomainSchema.options) {
    const artifacts = manifest.artifacts.filter((artifact) => artifact.domain === domain);
    const resolved = artifacts.map(resolvePublicGoldLabel);
    if (!resolved.some((label) => label.accepted) || !resolved.some((label) => !label.accepted)) {
      context.addIssue({ code: "custom", path: ["artifacts"], message: `Domain ${domain} requires at least one gold accept and one gold reject so binary denominators are complete.` });
    }
  }
});

export type PublicGoldCorpusManifest = z.infer<typeof publicGoldCorpusManifestSchema>;
export type PublicGoldArtifact = PublicGoldCorpusManifest["artifacts"][number];
export type PublicGoldResolvedLabel = {
  accepted: boolean;
  criteria: PublicGoldArtifact["gold"]["primaryRatings"][number]["criteria"];
  primaryClass: string;
  mechanismTags: string[];
  criticalIntegrityIncident: boolean;
  resolution: "primary_agreement" | "gold_adjudication";
};

export function resolvePublicGoldLabel(artifact: PublicGoldArtifact): PublicGoldResolvedLabel {
  const rating = artifact.gold.adjudication ?? artifact.gold.primaryRatings[0];
  return {
    accepted: rating.accepted,
    criteria: [...rating.criteria].sort((a, b) => compareCodeUnits(a.criterionId, b.criterionId)),
    primaryClass: rating.primaryClass,
    mechanismTags: [...rating.mechanismTags],
    criticalIntegrityIncident: rating.criticalIntegrityIncident,
    resolution: artifact.gold.adjudication ? "gold_adjudication" : "primary_agreement",
  };
}

const evaluationPlanEntrySchema = z.object({
  evaluationId: stableIdSchema,
  caseId: stableIdSchema,
  artifactId: stableIdSchema,
  contextId: stableIdSchema,
  order: z.number().int().min(0).max(1_000_000),
  primaryReviewerIdentityIds: z.tuple([stableIdSchema, stableIdSchema]),
  adjudicatorReviewerIdentityId: stableIdSchema,
}).strict();

export const publicGoldEvaluationPlanSchema = z.object({
  schemaVersion: z.literal(1),
  planId: stableIdSchema,
  planDigest: sha256Schema,
  corpusId: stableIdSchema,
  corpusManifestDigest: sha256Schema,
  frozenAt: timestampSchema,
  randomizedOrderSeedDigest: sha256Schema,
  entries: z.array(evaluationPlanEntrySchema).min(4).max(100_000),
  contexts: z.array(z.object({
    contextId: stableIdSchema,
    caseIds: sortedUniqueIdsSchema,
  }).strict()).min(1).max(100_000),
  blinding: z.object({
    referenceLabelsVisible: z.literal(false),
    corruptionProvenanceVisible: z.literal(false),
    sourceClusterVisible: z.literal(false),
    relatedArtifactsVisible: z.literal(false),
  }).strict(),
  reviewPolicy: z.object({
    primaryRoleOrder: z.tuple([z.literal("measurement"), z.literal("standard")]),
    requiredPrimaryCount: z.literal(2),
    adjudicationTrigger: z.literal("binary_acceptance_disagreement_only"),
    classOnlyDisagreementResolution: z.literal("frozen_taxonomy_precedence_without_adjudication"),
    adjudicatorCapabilityRequired: z.literal(true),
  }).strict(),
  analysisConfig: z.object({
    clusterBootstrapSeed: z.number().int().min(0).max(0xffff_ffff),
    clusterBootstrapDrawCount: z.number().int().min(1_000).max(100_000),
    confidenceLevel: z.literal(0.95),
  }).strict(),
}).strict().superRefine((plan, context) => {
  if (plan.planDigest !== computePublicGoldPlanDigest(plan)) context.addIssue({ code: "custom", path: ["planDigest"], message: "Evaluation-plan digest does not match the canonical plan bytes." });
  const unique = (values: string[], path: (string | number)[], message: string) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", path, message });
  };
  unique(plan.entries.map((entry) => entry.evaluationId), ["entries"], "Evaluation IDs must be unique.");
  unique(plan.entries.map((entry) => entry.caseId), ["entries"], "Blinded case IDs must be unique.");
  unique(plan.entries.map((entry) => entry.artifactId), ["entries"], "Each artifact must be evaluated exactly once.");
  unique(plan.entries.map((entry) => String(entry.order)), ["entries"], "Evaluation order positions must be unique.");
  unique(plan.contexts.map((entry) => entry.contextId), ["contexts"], "Context IDs must be unique.");
  const contextCaseIds = plan.contexts.flatMap((entry) => entry.caseIds);
  unique(contextCaseIds, ["contexts"], "A blinded case may appear in only one evaluation context.");
  const plannedCaseIds = plan.entries.map((entry) => entry.caseId).sort(compareCodeUnits);
  if (JSON.stringify([...contextCaseIds].sort(compareCodeUnits)) !== JSON.stringify(plannedCaseIds)) {
    context.addIssue({ code: "custom", path: ["contexts"], message: "Contexts must cover every and only the planned blinded cases." });
  }
  if (plan.contexts.some((entry) => entry.caseIds.length === 0)) context.addIssue({ code: "custom", path: ["contexts"], message: "Evaluation contexts may not be empty." });
  const orders = plan.entries.map((entry) => entry.order).sort((a, b) => a - b);
  if (orders.some((order, index) => order !== index)) context.addIssue({ code: "custom", path: ["entries"], message: "Evaluation order must be a contiguous zero-based sequence." });
  plan.entries.forEach((entry, index) => {
    const containing = plan.contexts.find((item) => item.contextId === entry.contextId);
    if (!containing?.caseIds.includes(entry.caseId)) context.addIssue({ code: "custom", path: ["entries", index, "contextId"], message: "Plan entry context must contain its blinded case." });
    if (new Set([...entry.primaryReviewerIdentityIds, entry.adjudicatorReviewerIdentityId]).size !== 3) {
      context.addIssue({ code: "custom", path: ["entries", index], message: "Each case requires two distinct primaries and an independent adjudicator assignment." });
    }
  });
});

export type PublicGoldEvaluationPlan = z.infer<typeof publicGoldEvaluationPlanSchema>;

const forbiddenEvaluatorPacketKeys = new Set([
  "artifactId",
  "sourceClusterId",
  "sourceExemplarArtifactId",
  "parentArtifactId",
  "corruption",
  "corruptionFamily",
  "expectedDecision",
  "expectedLabel",
  "gold",
  "goldAccepted",
  "goldCriteria",
  "siblingArtifactIds",
]);

function assertNoLeakageKeys(value: unknown, path = "packet"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoLeakageKeys(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    if (forbiddenEvaluatorPacketKeys.has(key)) throw new Error(`Evaluator packet contains forbidden leakage field ${path}.${key}.`);
    assertNoLeakageKeys(entry, `${path}.${key}`);
  });
}

export const blindedPublicGoldPacketSchema = z.object({
  schemaVersion: z.literal(1),
  evaluationId: stableIdSchema,
  caseId: stableIdSchema,
  domain: publicGoldDomainSchema,
  evidence: z.object({
    artifactDigest: sha256Schema,
    renderDigest: sha256Schema,
    semanticStateDigest: sha256Schema,
    rubricDigest: sha256Schema,
    integrityEvidenceDigest: sha256Schema.nullable(),
    failureTaxonomyDigest: sha256Schema,
  }).strict(),
  rubricCriterionIds: sortedUniqueIdsSchema,
  evidenceCoverage: z.object({
    artifactPresent: z.literal(true),
    renderPresent: z.literal(true),
    semanticStatePresent: z.literal(true),
    integrityEvidencePresent: z.boolean(),
  }).strict(),
}).strict();

export type BlindedPublicGoldPacket = z.infer<typeof blindedPublicGoldPacketSchema>;

export function parseBlindedPublicGoldPacket(raw: unknown): BlindedPublicGoldPacket {
  assertNoLeakageKeys(raw);
  return blindedPublicGoldPacketSchema.parse(raw);
}

const modelCriterionDecisionSchema = z.object({
  criterionId: stableIdSchema,
  decision: z.enum(["pass", "fail"]),
}).strict();

const primaryModelResultSchema = z.object({
  resultKind: z.literal("primary"),
  accepted: z.boolean(),
  criteria: z.array(modelCriterionDecisionSchema).min(1).max(256),
  primaryClass: stableIdSchema,
  mechanismTags: sortedUniqueIdsSchema,
  criticalIntegrityIncident: z.boolean(),
  evidenceCoverageComplete: z.boolean(),
}).strict();

const adjudicationModelResultSchema = z.object({
  resultKind: z.literal("adjudication"),
  accepted: z.boolean(),
  primaryClass: stableIdSchema,
  mechanismTags: sortedUniqueIdsSchema,
  criticalIntegrityIncident: z.boolean(),
  evidenceCoverageComplete: z.boolean(),
}).strict();

const modelResultSchema = z.discriminatedUnion("resultKind", [primaryModelResultSchema, adjudicationModelResultSchema]);

const lockedEvaluatorProjectionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("scored"),
    reviewerRole: z.enum(["primary", "adjudicator"]),
    accepted: z.boolean(),
    primaryFailureClass: stableIdSchema,
    result: modelResultSchema,
  }).strict(),
  z.object({
    status: z.literal("failed"),
    reviewerRole: z.enum(["primary", "adjudicator"]),
    accepted: z.literal(false),
    primaryFailureClass: z.literal("FAIL_EVALUATOR_SCORER"),
    result: z.null(),
  }).strict(),
]).superRefine((projection, context) => {
  if (projection.status === "scored") {
    if ((projection.reviewerRole === "adjudicator") !== (projection.result.resultKind === "adjudication")) {
      context.addIssue({ code: "custom", path: ["result", "resultKind"], message: "Locked result kind must match the production reviewer role." });
    }
    if (projection.accepted !== projection.result.accepted
      || projection.primaryFailureClass !== projection.result.primaryClass) {
      context.addIssue({ code: "custom", message: "Locked result projection must preserve exact acceptance and primary-class fields." });
    }
  }
});

const verificationEvidenceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("verified"), evidenceDigest: sha256Schema }).strict(),
  z.object({ status: z.literal("unverified"), evidenceDigest: z.null(), reasonCode: stableIdSchema }).strict(),
]);

const reviewRecordBase = {
  schemaVersion: z.literal(1),
  recordDigest: sha256Schema,
  lockedEvaluatorRecordDigest: sha256Schema,
  lockedEvaluatorProjection: lockedEvaluatorProjectionSchema,
  callId: stableIdSchema,
  evaluationId: stableIdSchema,
  caseId: stableIdSchema,
  evaluatorIdentityId: stableIdSchema,
  reviewerRole: z.enum(["primary_measurement", "primary_standard", "adjudicator"]),
  providerModelId: stableIdSchema,
  begunAt: timestampSchema,
  finishedAt: timestampSchema,
  requestDigest: sha256Schema,
  responseDigest: sha256Schema.nullable(),
  artifactDigest: sha256Schema,
  renderDigest: sha256Schema,
  semanticStateDigest: sha256Schema,
  rubricDigest: sha256Schema,
  failureTaxonomyDigest: sha256Schema,
  corpusManifestDigest: sha256Schema,
  planDigest: sha256Schema,
  primaryLockedEvaluatorRecordDigests: z.tuple([sha256Schema, sha256Schema]).nullable(),
  providerIdentityVerification: verificationEvidenceSchema,
  provenanceVerification: verificationEvidenceSchema,
  referenceLabelKnown: z.literal(false),
  siblingVariantSeen: z.literal(false),
};

export const publicGoldReviewRecordSchema = z.discriminatedUnion("status", [
  z.object({
    ...reviewRecordBase,
    status: z.literal("completed"),
    responseDigest: sha256Schema,
    result: modelResultSchema,
  }).strict(),
  z.object({
    ...reviewRecordBase,
    status: z.literal("failed"),
    failurePreserved: z.literal(true),
    providerCallMayHaveOccurred: z.boolean(),
    failureCode: stableIdSchema,
    result: z.null(),
  }).strict(),
  z.object({
    ...reviewRecordBase,
    status: z.literal("non_evaluable"),
    failurePreserved: z.literal(true),
    reasonCode: stableIdSchema,
    result: z.null(),
  }).strict(),
]).superRefine((record, context) => {
  if (record.recordDigest !== computePublicGoldReviewRecordDigest(record)) {
    context.addIssue({ code: "custom", path: ["recordDigest"], message: "Terminal review-record digest does not match the canonical record bytes." });
  }
  if (Date.parse(record.finishedAt) < Date.parse(record.begunAt)) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: "Review completion may not precede its begun time." });
  }
  if ((record.reviewerRole === "adjudicator") !== (record.primaryLockedEvaluatorRecordDigests !== null)) {
    context.addIssue({ code: "custom", path: ["primaryLockedEvaluatorRecordDigests"], message: "Only adjudicator calls bind the ordered pair of locked primary record commitments, and every adjudicator call must bind them." });
  }
  const lockedRole = record.reviewerRole === "adjudicator" ? "adjudicator" : "primary";
  if (record.lockedEvaluatorProjection.reviewerRole !== lockedRole) {
    context.addIssue({ code: "custom", path: ["lockedEvaluatorProjection", "reviewerRole"], message: "Public reviewer role must match the retained LockedEvaluatorRecord projection." });
  }
  if (record.status === "completed") {
    if (record.lockedEvaluatorProjection.status !== "scored"
      || hashCanonicalJson(record.lockedEvaluatorProjection.result) !== hashCanonicalJson(record.result)) {
      context.addIssue({ code: "custom", path: ["lockedEvaluatorProjection"], message: "Completed public result must exactly project the scored LockedEvaluatorRecord." });
    }
    if ((record.reviewerRole === "adjudicator") !== (record.result.resultKind === "adjudication")) {
      context.addIssue({ code: "custom", path: ["result", "resultKind"], message: "Terminal result kind must match the assigned production reviewer role." });
    }
    if (!record.result.evidenceCoverageComplete) {
      context.addIssue({ code: "custom", path: ["result", "evidenceCoverageComplete"], message: "Incomplete evidence must be retained as non-evaluable, never as a completed public-gold result." });
    }
    if (record.result.resultKind === "primary") {
      const allPass = record.result.criteria.every((criterion) => criterion.decision === "pass");
      if (record.result.accepted !== allPass) context.addIssue({ code: "custom", path: ["result"], message: "Primary acceptance must exactly match complete criterion decisions." });
    }
    if ((record.result.accepted ? record.result.primaryClass !== "SUCCESS" : record.result.primaryClass === "SUCCESS")) {
      context.addIssue({ code: "custom", path: ["result"], message: "Model acceptance and primary class must reconcile." });
    }
  } else if (record.status === "failed" && record.lockedEvaluatorProjection.status !== "failed") {
    context.addIssue({ code: "custom", path: ["lockedEvaluatorProjection", "status"], message: "A failed public terminal must preserve a failed LockedEvaluatorRecord projection." });
  }
});

export type PublicGoldReviewRecord = z.infer<typeof publicGoldReviewRecordSchema>;

export function validatePublicGoldPlan(
  rawManifest: unknown,
  rawPlan: unknown,
): { manifest: PublicGoldCorpusManifest; plan: PublicGoldEvaluationPlan } {
  const manifest = publicGoldCorpusManifestSchema.parse(rawManifest);
  const plan = publicGoldEvaluationPlanSchema.parse(rawPlan);
  if (plan.corpusId !== manifest.corpusId || plan.corpusManifestDigest !== manifest.manifestDigest) {
    throw new Error("Evaluation plan must bind the exact public corpus manifest.");
  }
  const evaluatedReviewerById = new Map(manifest.identities
    .filter((identity) => identity.role === "evaluated_reviewer")
    .map((identity) => [identity.identityId, identity]));
  plan.entries.forEach((entry) => {
    const assigned = [...entry.primaryReviewerIdentityIds, entry.adjudicatorReviewerIdentityId];
    if (assigned.some((identityId) => !evaluatedReviewerById.has(identityId))) {
      throw new Error("Every assigned production reviewer must be declared only as an evaluated reviewer, never as a gold rater.");
    }
    if (new Set(assigned).size !== 3) throw new Error(`Case ${entry.caseId} reuses a primary reviewer or lacks an independent adjudicator.`);
    const capabilityAssignments = [
      [entry.primaryReviewerIdentityIds[0], "primary_measurement"],
      [entry.primaryReviewerIdentityIds[1], "primary_standard"],
      [entry.adjudicatorReviewerIdentityId, "adjudicator"],
    ] as const;
    if (capabilityAssignments.some(([identityId, capability]) =>
      !evaluatedReviewerById.get(identityId)?.reviewerCapabilities.includes(capability))) {
      throw new Error(`Case ${entry.caseId} assigns a reviewer without the frozen capability for that production role.`);
    }
  });
  if (Date.parse(plan.frozenAt) > Date.parse(manifest.goldLockedAt)
    || Date.parse(plan.frozenAt) >= Date.parse(manifest.evaluationOpenedAt)) {
    throw new Error("Evaluation plan must freeze before evaluation opens and no later than the gold lock.");
  }
  if (plan.analysisConfig.clusterBootstrapSeed !== manifest.graduationThresholds.clusterBootstrapSeed
    || plan.analysisConfig.clusterBootstrapDrawCount !== manifest.graduationThresholds.clusterBootstrapDrawCount) {
    throw new Error("Analysis configuration must match the frozen graduation thresholds.");
  }
  const manifestArtifactIds = manifest.artifacts.map((artifact) => artifact.artifactId).sort(compareCodeUnits);
  const planArtifactIds = plan.entries.map((entry) => entry.artifactId).sort(compareCodeUnits);
  if (JSON.stringify(manifestArtifactIds) !== JSON.stringify(planArtifactIds)) {
    throw new Error("Evaluation plan must cover every and only the corpus artifacts exactly once.");
  }
  const artifactById = new Map(manifest.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const entryByCaseId = new Map(plan.entries.map((entry) => [entry.caseId, entry]));
  plan.contexts.forEach((context) => {
    const clusterIds = context.caseIds.map((caseId) => {
      const entry = entryByCaseId.get(caseId);
      return entry ? artifactById.get(entry.artifactId)?.sourceClusterId : undefined;
    });
    if (clusterIds.some((clusterId) => clusterId === undefined) || new Set(clusterIds).size !== clusterIds.length) {
      throw new Error(`Evaluation context ${context.contextId} contains sibling variants or an orphan case.`);
    }
  });
  return { manifest, plan };
}

export function buildBlindedPublicGoldPackets(rawManifest: unknown, rawPlan: unknown): BlindedPublicGoldPacket[] {
  const { manifest, plan } = validatePublicGoldPlan(rawManifest, rawPlan);
  const artifactById = new Map(manifest.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const criterionIds = manifest.rubric.criteria.map((criterion) => criterion.criterionId).sort(compareCodeUnits);
  return [...plan.entries].sort((a, b) => a.order - b.order).map((entry) => {
    const artifact = artifactById.get(entry.artifactId);
    if (!artifact) throw new Error(`Plan references orphan artifact ${entry.artifactId}.`);
    return parseBlindedPublicGoldPacket({
      schemaVersion: 1,
      evaluationId: entry.evaluationId,
      caseId: entry.caseId,
      domain: artifact.domain,
      evidence: {
        artifactDigest: artifact.artifactDigest,
        renderDigest: artifact.renderDigest,
        semanticStateDigest: artifact.semanticStateDigest,
        rubricDigest: artifact.rubricDigest,
        failureTaxonomyDigest: manifest.failureTaxonomy.taxonomyDigest,
        integrityEvidenceDigest: artifact.integrityEvidenceDigest,
      },
      rubricCriterionIds: criterionIds,
      evidenceCoverage: {
        artifactPresent: true,
        renderPresent: true,
        semanticStatePresent: true,
        integrityEvidencePresent: artifact.integrityEvidenceDigest !== null,
      },
    });
  });
}

export function validatePublicGoldRecords(
  rawManifest: unknown,
  rawPlan: unknown,
  rawRecords: unknown,
): { manifest: PublicGoldCorpusManifest; plan: PublicGoldEvaluationPlan; records: PublicGoldReviewRecord[] } {
  const { manifest, plan } = validatePublicGoldPlan(rawManifest, rawPlan);
  const records = z.array(publicGoldReviewRecordSchema).parse(rawRecords);
  const callIds = records.map((record) => record.callId);
  if (new Set(callIds).size !== callIds.length) throw new Error("Every begun reviewer call must have exactly one retained terminal record.");
  const lockedRecordDigests = records.map((record) => record.lockedEvaluatorRecordDigest);
  if (new Set(lockedRecordDigests).size !== lockedRecordDigests.length) throw new Error("Each production LockedEvaluatorRecord may project into the public-gold call ledger exactly once.");
  const artifactById = new Map(manifest.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const entryByEvaluationId = new Map(plan.entries.map((entry) => [entry.evaluationId, entry]));
  const criterionIds = manifest.rubric.criteria.map((criterion) => criterion.criterionId);
  records.forEach((record) => {
    const entry = entryByEvaluationId.get(record.evaluationId);
    const artifact = entry ? artifactById.get(entry.artifactId) : undefined;
    const expectedIdentity = entry === undefined ? undefined
      : record.reviewerRole === "primary_measurement" ? entry.primaryReviewerIdentityIds[0]
        : record.reviewerRole === "primary_standard" ? entry.primaryReviewerIdentityIds[1]
          : entry.adjudicatorReviewerIdentityId;
    if (!entry || !artifact || record.caseId !== entry.caseId || record.evaluatorIdentityId !== expectedIdentity) {
      throw new Error(`Review record ${record.evaluationId} does not bind its frozen plan entry.`);
    }
    if (record.corpusManifestDigest !== manifest.manifestDigest || record.planDigest !== plan.planDigest) {
      throw new Error(`Review record ${record.evaluationId} was replayed under a different corpus or evaluation plan.`);
    }
    if (Date.parse(record.begunAt) < Date.parse(manifest.evaluationOpenedAt)) {
      throw new Error(`Review record ${record.evaluationId} began before the frozen evaluation opening time.`);
    }
    if (record.artifactDigest !== artifact.artifactDigest
      || record.renderDigest !== artifact.renderDigest
      || record.semanticStateDigest !== artifact.semanticStateDigest
      || record.rubricDigest !== artifact.rubricDigest
      || record.failureTaxonomyDigest !== manifest.failureTaxonomy.taxonomyDigest) {
      throw new Error(`Review record ${record.evaluationId} does not bind the frozen artifact evidence.`);
    }
    if (record.lockedEvaluatorProjection.status === "scored") {
      const lockedResult = record.lockedEvaluatorProjection.result;
      if (lockedResult.resultKind === "primary") {
        const decided = lockedResult.criteria.map((criterion) => criterion.criterionId);
        if (decided.length !== criterionIds.length || new Set(decided).size !== criterionIds.length || decided.some((criterionId) => !criterionIds.includes(criterionId))) {
          throw new Error(`Completed primary review ${record.callId} must decide every criterion exactly once.`);
        }
      }
      if (!manifest.failureTaxonomy.primaryClasses.includes(lockedResult.primaryClass)
        || lockedResult.mechanismTags.some((tag) => !manifest.failureTaxonomy.mechanismTags.includes(tag))) {
        throw new Error(`Completed review ${record.evaluationId} must use only frozen failure-taxonomy classes and mechanism tags.`);
      }
    }
  });

  plan.entries.forEach((entry) => {
    const caseRecords = records.filter((record) => record.evaluationId === entry.evaluationId);
    const measurement = caseRecords.filter((record) => record.reviewerRole === "primary_measurement");
    const standard = caseRecords.filter((record) => record.reviewerRole === "primary_standard");
    const adjudications = caseRecords.filter((record) => record.reviewerRole === "adjudicator");
    if (measurement.length !== 1 || standard.length !== 1) {
      throw new Error(`Case ${entry.caseId} requires exactly two ordered retained primary projections.`);
    }
    const primaryOutcome = (record: PublicGoldReviewRecord): boolean | null => record.lockedEvaluatorProjection.status === "scored"
      && record.lockedEvaluatorProjection.result.resultKind === "primary"
      ? record.lockedEvaluatorProjection.accepted
      : null;
    const firstAccepted = primaryOutcome(measurement[0]);
    const secondAccepted = primaryOutcome(standard[0]);
    const binaryDisagreement = firstAccepted !== null && secondAccepted !== null && firstAccepted !== secondAccepted;
    if (binaryDisagreement && adjudications.length !== 1) {
      throw new Error(`Case ${entry.caseId} has a binary primary disagreement and requires exactly one retained adjudication.`);
    }
    if (!binaryDisagreement && adjudications.length !== 0) {
      throw new Error(`Case ${entry.caseId} received illegal adjudication without a binary primary disagreement; class-only disagreement uses frozen precedence.`);
    }
    const adjudication = adjudications[0];
    if (adjudication
      && JSON.stringify(adjudication.primaryLockedEvaluatorRecordDigests) !== JSON.stringify([
        measurement[0].lockedEvaluatorRecordDigest,
        standard[0].lockedEvaluatorRecordDigest,
      ])) {
      throw new Error(`Case ${entry.caseId} adjudication is not bound to the ordered locked primary record commitments.`);
    }
    if (caseRecords.length !== 2 + (binaryDisagreement ? 1 : 0)) {
      throw new Error(`Case ${entry.caseId} contains an unassigned or duplicated reviewer call.`);
    }
  });
  const plannedEvaluationIds = new Set(plan.entries.map((entry) => entry.evaluationId));
  if (records.some((record) => !plannedEvaluationIds.has(record.evaluationId))) {
    throw new Error("Terminal reviewer call set contains a case outside the frozen analysis denominator.");
  }
  return { manifest, plan, records };
}
