import { z } from "zod";

import { attemptRegistrySchema, type AttemptAuthorOutcome, type AttemptRegistry } from "./attempt-schemas";
import {
  EXP0001A_REVISION_PACKET_SAMPLER_ID,
  blindedRevisionAssessmentPacketSchema,
  verifyBlindedRevisionAssessmentPacket,
} from "./attempt-metrics";
import { canonicalJson, hashCanonicalJson, SHA256_DIGEST_PATTERN, sha256Digest } from "./provenance-crypto";
import { verifyAttemptRegistry } from "./provenance-verification";

const stableIdSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z.string().datetime({ offset: true });
const bareSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const authorIdentityArtifactPathSchema = z.literal("author-identity-commitment.json");
const opaqueIdSchema = stableIdSchema.refine(
  (value) => !/(?:^|[._:-])(?:baseline|candidate|control|treatment|condition|pair|order)(?:$|[._:-])/i.test(value),
  "Opaque identifiers cannot encode assignment metadata.",
);

export const FROZEN_PRIMARY_FAILURE_CLASSES = [
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
] as const;

const primaryFailureClassSchema = z.enum(FROZEN_PRIMARY_FAILURE_CLASSES);

const pricingSchema = z.object({
  currency: z.literal("USD"),
  inputUsdPerMillionTokens: z.number().finite().nonnegative(),
  cachedInputUsdPerMillionTokens: z.number().finite().nonnegative(),
  cacheWriteInputUsdPerMillionTokens: z.number().finite().nonnegative(),
  outputUsdPerMillionTokens: z.number().finite().nonnegative(),
  source: stableIdSchema,
}).strict();

const evaluatorArtifactSourceBaseSchema = z.object({
  schemaVersion: z.literal(2),
  attemptId: stableIdSchema,
  attemptDirectory: z.string().trim().min(1).max(2_048),
  attemptBundleSha256: bareSha256Schema,
  artifactRootSha256: bareSha256Schema,
  evaluatorAuthorEvidenceRootSha256: bareSha256Schema,
  registryAuthorEvidenceRoot: digestSchema,
  rubricSha256: digestSchema,
  rubricCriterionIds: z.array(stableIdSchema).min(1).max(256),
  rubricCriteriaCommitment: digestSchema,
  authorIdentityCommitment: digestSchema,
  authorIdentityEvidence: z.object({
    path: authorIdentityArtifactPathSchema,
    artifactSha256: digestSchema,
    linkageCommitment: digestSchema,
  }).strict(),
}).strict();

export const evaluatorArtifactSourceSchema = evaluatorArtifactSourceBaseSchema.superRefine((source, context) => {
  if (new Set(source.rubricCriterionIds).size !== source.rubricCriterionIds.length) {
    context.addIssue({ code: "custom", path: ["rubricCriterionIds"], message: "Rubric criterion IDs must be unique." });
  }
});

export const reviewerRosterEntrySchema = z.object({
  reviewerId: opaqueIdSchema,
  identityCommitment: digestSchema,
}).strict();

const reviewerTokenBudgetSchema = z.object({
  inputTokens: z.number().int().min(1).max(1_000_000),
  outputTokens: z.number().int().min(256).max(100_000),
}).strict();

export const blindedReviewPolicySchema = z.object({
  schemaVersion: z.literal(2),
  assignmentSeed: digestSchema,
  committedSourceSetRoot: digestSchema,
  model: opaqueIdSchema,
  serviceTier: z.literal("default"),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
  tokenBudgets: z.object({
    primary: reviewerTokenBudgetSchema,
    adjudicator: reviewerTokenBudgetSchema,
  }).strict(),
  mechanismTags: z.array(stableIdSchema).min(1).max(256),
  pricing: pricingSchema,
  outputDirectory: z.string().trim().min(1).max(2_048),
  createdAt: timestampSchema,
}).strict().superRefine((policy, context) => {
  if (new Set(policy.mechanismTags).size !== policy.mechanismTags.length) {
    context.addIssue({ code: "custom", path: ["mechanismTags"], message: "Mechanism tags must be unique." });
  }
});

const adjudicationConfigSchema = z.object({
  schemaVersion: z.literal("blinded-adjudication-input/v1"),
  primaryRecords: z.tuple([z.record(z.string(), z.unknown()), z.record(z.string(), z.unknown())]),
  primaryRecordSha256s: z.tuple([bareSha256Schema, bareSha256Schema]),
}).strict();

export const evaluatorRunnerConfigSchema = z.object({
  attemptDirectory: z.string().trim().min(1),
  expectedAttemptBundleSha256: bareSha256Schema,
  expectedArtifactRoot: bareSha256Schema,
  expectedAuthorEvidenceRoot: bareSha256Schema,
  expectedAuthorIdentityCommitment: digestSchema,
  expectedAuthorIdentityArtifactSha256: digestSchema,
  taskId: stableIdSchema,
  expectedRubricSha256: digestSchema,
  committedSourceSetRoot: digestSchema,
  reviewerId: opaqueIdSchema,
  reviewerRole: z.enum(["primary", "adjudicator"]),
  model: opaqueIdSchema,
  serviceTier: z.literal("default"),
  reasoningEffort: blindedReviewPolicySchema.shape.reasoningEffort,
  inputTokenBudget: reviewerTokenBudgetSchema.shape.inputTokens,
  outputTokenBudget: reviewerTokenBudgetSchema.shape.outputTokens,
  pricing: pricingSchema,
  measurement: z.object({
    role: z.enum(["measurement", "standard"]),
    samplerId: z.literal(EXP0001A_REVISION_PACKET_SAMPLER_ID),
  }).strict(),
  adjudication: adjudicationConfigSchema.nullable().optional(),
  outputDirectory: z.string().trim().min(1),
}).strict().superRefine((config, context) => {
  if (config.reviewerRole === "primary" && config.adjudication != null) {
    context.addIssue({ code: "custom", path: ["adjudication"], message: "Primary reviewer configs cannot contain adjudication evidence." });
  }
  if (config.reviewerRole === "adjudicator" && config.measurement.role !== "standard") {
    context.addIssue({ code: "custom", path: ["measurement", "role"], message: "Adjudicators cannot be metrics measurement reviewers." });
  }
  if (config.reviewerRole === "adjudicator" && config.adjudication == null) {
    context.addIssue({ code: "custom", path: ["adjudication"], message: "Adjudicator configs require committed primary records." });
  }
  if (config.adjudication && new Set(config.adjudication.primaryRecordSha256s).size !== 2) {
    context.addIssue({ code: "custom", path: ["adjudication", "primaryRecordSha256s"], message: "Adjudication primary commitments must be distinct." });
  }
});

export const reviewerWorkItemSchema = z.object({
  schemaVersion: z.literal(1),
  workItemId: opaqueIdSchema,
  artifactId: opaqueIdSchema,
  reviewerId: opaqueIdSchema,
  reviewerRole: z.enum(["primary", "adjudicator"]),
  evaluatorConfig: evaluatorRunnerConfigSchema,
  evaluatorConfigSha256: bareSha256Schema,
}).strict();

export const trustedArtifactPlanSchema = z.object({
  artifactId: opaqueIdSchema,
  attemptId: stableIdSchema,
  taskId: stableIdSchema,
  authorOutcome: z.enum(["completed", "failed", "timeout", "infra_failure", "policy_violation"]),
  authorIdentityCommitment: digestSchema,
  evidence: evaluatorArtifactSourceBaseSchema.omit({ schemaVersion: true, attemptId: true, authorIdentityCommitment: true }),
  primaryReviewerIds: z.tuple([opaqueIdSchema, opaqueIdSchema]),
  primaryWorkItems: z.tuple([reviewerWorkItemSchema, reviewerWorkItemSchema]),
}).strict();

const blindedReviewPlanWithoutRootSchema = z.object({
  schemaVersion: z.literal(2),
  registryRoot: digestSchema,
  runSpecDigest: digestSchema,
  denominator: z.number().int().positive(),
  policy: blindedReviewPolicySchema,
  reviewerRoster: z.array(reviewerRosterEntrySchema).min(3),
  artifacts: z.array(trustedArtifactPlanSchema).min(1),
}).strict();

export const blindedReviewPlanSchema = blindedReviewPlanWithoutRootSchema.extend({
  planRoot: digestSchema,
}).strict();

const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  uncachedInputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict().superRefine((usage, context) => {
  if (usage.uncachedInputTokens + usage.cachedInputTokens + usage.cacheWriteInputTokens !== usage.inputTokens) {
    context.addIssue({ code: "custom", path: ["inputTokens"], message: "Input token classes must exactly reconcile." });
  }
  if (usage.reasoningTokens > usage.outputTokens || usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    context.addIssue({ code: "custom", path: ["totalTokens"], message: "Output reasoning and total tokens must reconcile." });
  }
});

export const EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE = Object.freeze({
  schemaVersion: "exp-0001a-evaluator-semantic-envelope/v1" as const,
  pilotTaskBasis: Object.freeze({
    benchmarkId: "jazzboard-development" as const,
    benchmarkVersion: "v1" as const,
    taskCount: 12 as const,
    maximumArchitectureEntities: 9 as const,
    maximumArchitectureRelationships: 9 as const,
    mandatoryCriteriaPerTask: 3 as const,
    benchmarkSource: Object.freeze({
      path: "research/benchmarks/development-v1.json" as const,
      fileDigest: "sha256:c463989713e2486082c47ed6dfe7cf3d9ae0e5350b6e47dc60195a2771adbbee" as const,
    }),
    rubricSource: Object.freeze({
      path: "research/benchmarks/development-evaluator-rubrics-v1.json" as const,
      fileDigest: "sha256:d29deb48689514f3b4e1bd98dcb5de309701b1ec2c479f273bff004856d98554" as const,
    }),
  }),
  limits: Object.freeze({
    visibleTextBytesPerField: 512 as const,
    aggregateVisibleTextBytes: 4 * 1024,
    semanticProjectionBytes: 64 * 1024,
  }),
  domainPolicy: Object.freeze({
    architecture: "complete_compact_objects_connectors_routes_groups_diagrams_and_visible_text_within_limits" as const,
    drawing: "complete_stable_object_geometry_path_segment_counts_and_pixels_with_visible_text_within_limits" as const,
    outsideEnvelope: "evaluator_unobservable_not_author_failure" as const,
  }),
});
export const EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE_SOURCE_PATH =
  "research/data/exp0001a-evaluator-semantic-envelope-v1.json" as const;
export const EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE_DIGEST = hashCanonicalJson(
  EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE,
);

const evaluatorInputPreflightSchema = z.object({
  algorithm: z.literal("canonical-nonimage-utf8-plus-gpt56-vision-patches-v2"),
  providerRequestSha256: bareSha256Schema,
  nonImagePayloadBytes: z.number().int().positive(),
  providerRequestBytes: z.number().int().positive(),
  aggregateRawImageBytes: z.number().int().positive(),
  aggregateBase64ImageBytes: z.number().int().positive(),
  semanticProjectionBytes: z.number().int().positive(),
  semanticEnvelope: z.object({
    envelopeDigest: digestSchema,
    observed: z.object({
      sourceVisibleTextBytes: z.number().int().nonnegative(),
      retainedVisibleTextBytes: z.number().int().nonnegative(),
      truncatedTextCount: z.number().int().nonnegative(),
      semanticObjectCount: z.number().int().nonnegative(),
      drawingObjectCount: z.number().int().nonnegative(),
      connectorCount: z.number().int().nonnegative(),
      diagramCount: z.number().int().nonnegative(),
    }).strict(),
    limits: z.object({
      visibleTextBytesPerField: z.literal(512),
      aggregateVisibleTextBytes: z.literal(4 * 1024),
      semanticProjectionBytes: z.literal(64 * 1024),
    }).strict(),
    withinEnvelope: z.boolean(),
  }).strict(),
  images: z.array(z.object({
    imageRef: z.string().regex(/^image_[0-9]{2}$/),
    bytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    pixels: z.number().int().positive(),
    detail: z.enum(["low", "high"]),
    conservativeTokenUpperBound: z.number().int().positive(),
  }).strict()).min(1),
  limits: z.object({
    imageCount: z.literal(7),
    perImageBytes: z.literal(10 * 1024 * 1024),
    aggregateRawImageBytes: z.literal(32 * 1024 * 1024),
    providerRequestBytes: z.literal(48 * 1024 * 1024),
    semanticProjectionBytes: z.literal(64 * 1024),
  }).strict(),
  requestFixedTokenOverhead: z.literal(2_048),
  conservativeInputTokenUpperBound: z.number().int().positive(),
  inputTokenBudget: z.number().int().positive(),
  withinImageLimits: z.boolean(),
  withinAggregateImageLimits: z.boolean(),
  withinProviderRequestLimit: z.boolean(),
  withinSemanticProjectionLimit: z.boolean(),
  withinSemanticEnvelope: z.boolean(),
  withinInputTokenBudget: z.boolean(),
  eligibleForRelease: z.boolean(),
}).strict().superRefine((preflight, context) => {
  const recomputed = preflight.nonImagePayloadBytes
    + preflight.images.reduce((sum, image) => sum + image.conservativeTokenUpperBound, 0)
    + preflight.requestFixedTokenOverhead;
  const hasInvalidImage = preflight.images.some((image, index) => (
    image.pixels !== image.width * image.height
      || image.imageRef !== `image_${String(index + 1).padStart(2, "0")}`
      || image.conservativeTokenUpperBound !== (image.detail === "low"
        ? 308
        : 3_000)
  ));
  const aggregateRawImageBytes = preflight.images.reduce((sum, image) => sum + image.bytes, 0);
  const aggregateBase64ImageBytes = preflight.images.reduce((sum, image) => sum + Math.ceil(image.bytes / 3) * 4, 0);
  const withinImageLimits = preflight.images.every((image) => image.bytes <= preflight.limits.perImageBytes
    && image.width <= 2_048 && image.height <= 2_048 && image.pixels <= 2_500_000);
  const withinAggregateImageLimits = preflight.images.length <= preflight.limits.imageCount
    && aggregateRawImageBytes <= preflight.limits.aggregateRawImageBytes;
  const withinProviderRequestLimit = preflight.providerRequestBytes <= preflight.limits.providerRequestBytes;
  const withinSemanticProjectionLimit = preflight.semanticProjectionBytes <= preflight.limits.semanticProjectionBytes;
  const withinSemanticEnvelope = preflight.semanticEnvelope.withinEnvelope
    && preflight.semanticEnvelope.envelopeDigest === EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE_DIGEST
    && preflight.semanticEnvelope.limits.visibleTextBytesPerField
      === EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE.limits.visibleTextBytesPerField
    && preflight.semanticEnvelope.limits.aggregateVisibleTextBytes
      === EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE.limits.aggregateVisibleTextBytes
    && preflight.semanticEnvelope.limits.semanticProjectionBytes
      === EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE.limits.semanticProjectionBytes
    && preflight.semanticEnvelope.observed.truncatedTextCount === 0
    && preflight.semanticEnvelope.observed.sourceVisibleTextBytes
      === preflight.semanticEnvelope.observed.retainedVisibleTextBytes
    && preflight.semanticEnvelope.observed.sourceVisibleTextBytes
      <= preflight.semanticEnvelope.limits.aggregateVisibleTextBytes;
  if (hasInvalidImage
      || preflight.aggregateRawImageBytes !== aggregateRawImageBytes
      || preflight.aggregateBase64ImageBytes !== aggregateBase64ImageBytes
      || preflight.withinImageLimits !== withinImageLimits
      || preflight.withinAggregateImageLimits !== withinAggregateImageLimits
      || preflight.withinProviderRequestLimit !== withinProviderRequestLimit
      || preflight.withinSemanticProjectionLimit !== withinSemanticProjectionLimit
      || preflight.withinSemanticEnvelope !== withinSemanticEnvelope
      || preflight.conservativeInputTokenUpperBound !== recomputed
      || preflight.withinInputTokenBudget !== (recomputed <= preflight.inputTokenBudget)
      || preflight.eligibleForRelease !== (preflight.withinImageLimits
        && preflight.withinAggregateImageLimits
        && preflight.withinProviderRequestLimit
        && preflight.withinSemanticProjectionLimit
        && preflight.withinSemanticEnvelope
        && preflight.withinInputTokenBudget)) {
    context.addIssue({ code: "custom", message: "Evaluator local input preflight arithmetic or image inventory is inconsistent." });
  }
});

const evaluatorEvidenceSchema = z.object({
  attemptBundleSha256: bareSha256Schema,
  artifactRoot: bareSha256Schema,
  authorEvidenceRoot: bareSha256Schema,
  authorIdentityCommitment: digestSchema,
  authorIdentityArtifactSha256: digestSchema,
  rubricSha256: bareSha256Schema.nullable(),
  finalStateSha256: bareSha256Schema,
  spectatorPngSha256: bareSha256Schema,
  spectatorRevision: z.number().int().nonnegative(),
  spectatorPngDimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  publicPacketSha256: bareSha256Schema,
  authorVisibleSpecVersion: z.literal("clean-room-author-visible-spec/v1"),
  authorVisibleSpecSha256: bareSha256Schema,
  authorExecutionContractSha256: bareSha256Schema,
  coverageComplete: z.boolean(),
}).strict();

const primaryEvidenceRefSchema = z.string().refine(
  (value) => value === "semantic_state" || value === "spectator_png"
    || /^rubric:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value),
  "Primary evidence references must use the frozen same-artifact namespace.",
);

const primaryObservationSchema = z.object({
  status: z.enum(["pass", "fail", "indeterminate", "not_observable"]),
  summary: z.string().trim().min(1).max(1_000),
  evidenceRefs: z.array(primaryEvidenceRefSchema).max(32),
}).strict().superRefine((observation, context) => {
  if (observation.status === "not_observable" && observation.evidenceRefs.length !== 0) {
    context.addIssue({ code: "custom", path: ["evidenceRefs"], message: "Not-observable process facts cannot cite nonexistent evidence." });
  }
  if (observation.status !== "not_observable" && observation.evidenceRefs.length === 0) {
    context.addIssue({ code: "custom", path: ["evidenceRefs"], message: "Observable findings require an allowed evidence reference." });
  }
});

const primaryReviewerResultStructuralSchema = z.object({
  schemaVersion: z.literal("blinded-evaluator-result/v1"),
  evidenceCoverage: z.object({
    status: z.enum(["complete", "incomplete"]),
    semanticState: z.boolean(),
    spectatorPixels: z.boolean(),
    criteriaAddressed: z.array(stableIdSchema).min(1).max(256),
    gaps: z.array(z.string().trim().min(1).max(500)).max(32),
  }).strict(),
  criteria: z.array(z.object({
    criterionId: stableIdSchema,
    decision: z.enum(["pass", "fail", "indeterminate"]),
    evidenceRefs: z.array(primaryEvidenceRefSchema).min(2).max(32),
    rationale: z.string().trim().min(1).max(1_500),
  }).strict()).min(1).max(256),
  observations: z.object({
    semantic: primaryObservationSchema,
    visual: primaryObservationSchema,
    correction: primaryObservationSchema,
    presentation: primaryObservationSchema,
    efficiency: primaryObservationSchema,
  }).strict(),
  primaryFailureClass: primaryFailureClassSchema,
  mechanismTags: z.array(z.object({
    tag: stableIdSchema,
    evidenceRefs: z.array(primaryEvidenceRefSchema).min(1).max(32),
  }).strict()).max(64),
  causalConfidence: z.enum(["high", "moderate", "uncertain"]),
  metricsAssessment: z.object({
    packetRoot: digestSchema,
    revisions: z.array(z.object({
      revisionRef: z.string().regex(/^revision_[0-9]{2}$/),
      satisfiedCriterionRefs: z.array(stableIdSchema).max(20),
      issueKeys: z.array(stableIdSchema).max(2_000),
      semanticScore: z.number().finite().min(0).max(1),
      visualUsabilityScore: z.union([
        z.literal(0), z.literal(0.25), z.literal(0.5), z.literal(0.75), z.literal(1),
      ]),
      blockingViolationCount: z.number().int().nonnegative(),
      qualityValue: z.number().finite(),
      usefulDraft: z.boolean(),
    }).strict()).max(7),
    finalState: z.object({
      revisionRef: z.string().regex(/^revision_[0-9]{2}$/),
      successfulArtifact: z.boolean(),
    }).strict(),
  }).strict().nullable(),
  accepted: z.boolean(),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();

const adjudicationEvidenceRefSchema = z.string().refine(
  (value) => value === "semantic_state" || value === "spectator_png"
    || value === "primary_review:1" || value === "primary_review:2"
    || /^rubric:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value),
  "Adjudication evidence references must use the frozen same-artifact namespace.",
);

const adjudicationResultSchema = z.object({
  schemaVersion: z.literal("blinded-adjudication-result/v1"),
  accepted: z.boolean(),
  primaryFailureClass: primaryFailureClassSchema,
  evidenceRefs: z.array(adjudicationEvidenceRefSchema).min(4).max(256),
  rationale: z.string().trim().min(1).max(2_000),
}).strict().superRefine((result, context) => {
  if (new Set(result.evidenceRefs).size !== result.evidenceRefs.length
      || !result.evidenceRefs.includes("primary_review:1") || !result.evidenceRefs.includes("primary_review:2")
      || !result.evidenceRefs.some((reference) => reference === "semantic_state" || reference === "spectator_png")
      || !result.evidenceRefs.some((reference) => reference.startsWith("rubric:"))) {
    context.addIssue({ code: "custom", path: ["evidenceRefs"], message: "Adjudication must cite both primaries plus unique artifact and rubric evidence." });
  }
  if ((result.primaryFailureClass === "SUCCESS") !== result.accepted) {
    context.addIssue({ code: "custom", path: ["primaryFailureClass"], message: "SUCCESS must exactly match adjudicated acceptance." });
  }
});

export const lockedEvaluatorRecordSchema = z.object({
  schemaVersion: z.literal("blinded-evaluator-run/v1"),
  artifactId: opaqueIdSchema,
  taskId: stableIdSchema,
  reviewer: z.object({
    id: opaqueIdSchema,
    role: z.enum(["primary", "adjudicator"]),
    invocationCount: z.literal(1),
  }).strict(),
  lockedAt: timestampSchema,
  treatmentLabelKnownAtLock: z.literal(false),
  pairedArtifactSeenBeforeLock: z.literal(false),
  committedSourceSetRoot: digestSchema,
  configSha256: bareSha256Schema,
  budgets: z.object({ inputTokens: z.number().int().positive(), outputTokens: z.number().int().positive() }).strict(),
  pricing: pricingSchema,
  measurement: z.object({
    role: z.enum(["measurement", "standard"]),
    packet: blindedRevisionAssessmentPacketSchema.nullable(),
    assessmentOutputSha256: bareSha256Schema.nullable(),
  }).strict(),
  adjudication: z.object({
    schemaVersion: z.literal("blinded-adjudication-input/v1"),
    primaryRecordSha256s: z.tuple([bareSha256Schema, bareSha256Schema]),
  }).strict().optional(),
  status: z.enum(["scored", "failed"]),
  evidence: evaluatorEvidenceSchema.nullable(),
  hashes: z.object({
    promptSha256: bareSha256Schema.nullable(),
    inputSha256: bareSha256Schema.nullable(),
    providerRequestSha256: bareSha256Schema.nullable(),
    providerOutputSha256: bareSha256Schema.nullable(),
    outputSha256: bareSha256Schema.nullable(),
  }).strict(),
  provider: z.object({
    modelRequested: stableIdSchema,
    modelObserved: stableIdSchema.nullable(),
    serviceTierRequested: z.literal("default"),
    serviceTierObserved: stableIdSchema.nullable(),
    identityStatus: z.enum(["observed", "unobservable", "falsified"]),
    providerReleaseStatus: z.enum(["not_released", "completed", "released_without_receipt"]),
    responseIdSha256: bareSha256Schema.nullable(),
    usage: usageSchema.nullable(),
    usageDetailsStatus: z.enum(["observed", "unobservable"]),
    estimatedCostUsd: z.number().finite().nonnegative().nullable(),
    inputPreflight: evaluatorInputPreflightSchema.nullable(),
  }).strict(),
  accepted: z.boolean(),
  primaryFailureClass: primaryFailureClassSchema,
  result: z.union([primaryReviewerResultStructuralSchema, adjudicationResultSchema]).nullable(),
  failure: z.object({ stage: stableIdSchema, code: stableIdSchema, message: z.string().trim().min(1).max(1_000) }).strict().nullable(),
  recordSha256: bareSha256Schema,
}).strict().superRefine((record, context) => {
  if (record.reviewer.role === "primary" && record.adjudication !== undefined) {
    context.addIssue({ code: "custom", path: ["adjudication"], message: "Primary records cannot carry adjudication bindings." });
  }
  if (record.reviewer.role === "adjudicator" && record.adjudication === undefined) {
    context.addIssue({ code: "custom", path: ["adjudication"], message: "Adjudicator records require primary commitments." });
  }
  if (record.status === "scored" && (record.result === null || record.failure !== null || record.evidence === null)) {
    context.addIssue({ code: "custom", message: "Scored records require result and evidence and cannot carry a failure." });
  }
  if (record.status === "scored" && record.evidence?.rubricSha256 === null) {
    context.addIssue({ code: "custom", message: "Scored records require a verified rubric digest." });
  }
  if (record.status === "failed" && (record.result !== null || record.failure === null || record.accepted)) {
    context.addIssue({ code: "custom", message: "Failed records require a failure, no result, and non-acceptance." });
  }
  if (record.status === "failed" && record.primaryFailureClass !== "FAIL_EVALUATOR_SCORER") {
    context.addIssue({ code: "custom", path: ["primaryFailureClass"], message: "Failed evaluator records must classify as FAIL_EVALUATOR_SCORER." });
  }
  if (record.status === "scored" && (record.provider.usage === null || record.provider.responseIdSha256 === null
      || record.provider.modelObserved === null || record.provider.serviceTierObserved !== "default"
      || record.provider.identityStatus !== "observed" || record.provider.providerReleaseStatus !== "completed"
      || record.provider.usageDetailsStatus !== "observed"
      || record.provider.inputPreflight === null || !record.provider.inputPreflight.eligibleForRelease
      || record.hashes.promptSha256 === null || record.hashes.inputSha256 === null
      || record.hashes.providerRequestSha256 === null || record.hashes.providerOutputSha256 === null
      || record.hashes.outputSha256 === null || record.evidence?.coverageComplete !== true)) {
    context.addIssue({ code: "custom", message: "Scored records require complete provider, hash, usage, and evidence commitments." });
  }
  const recomputedCost = record.provider.usage === null ? null : estimatedEvaluatorCost(record.provider.usage, record.pricing);
  if (record.provider.estimatedCostUsd !== recomputedCost) {
    context.addIssue({ code: "custom", path: ["provider", "estimatedCostUsd"], message: "Evaluator cost must be recomputed exactly from retained usage and frozen pricing." });
  }
  if ((record.primaryFailureClass === "SUCCESS") !== record.accepted) {
    context.addIssue({ code: "custom", message: "SUCCESS must exactly match acceptance." });
  }
  if (record.provider.providerReleaseStatus === "not_released"
      && (record.provider.responseIdSha256 !== null || record.provider.usage !== null
        || record.provider.modelObserved !== null || record.provider.serviceTierObserved !== null)) {
    context.addIssue({ code: "custom", path: ["provider", "providerReleaseStatus"], message: "A not-released provider call cannot carry response evidence." });
  }
  if (record.provider.providerReleaseStatus === "completed" && record.provider.responseIdSha256 === null) {
    context.addIssue({ code: "custom", path: ["provider", "responseIdSha256"], message: "A completed provider call requires a retained response identifier commitment." });
  }
  if (record.provider.inputPreflight !== null && (
    record.provider.inputPreflight.providerRequestSha256 !== record.hashes.providerRequestSha256
    || record.provider.inputPreflight.inputTokenBudget !== record.budgets.inputTokens
  )) {
    context.addIssue({ code: "custom", path: ["provider", "inputPreflight"], message: "Evaluator local input preflight is not bound to the exact provider request and frozen budget." });
  }
  if (record.provider.providerReleaseStatus !== "not_released"
      && (record.provider.inputPreflight === null || !record.provider.inputPreflight.eligibleForRelease)) {
    context.addIssue({ code: "custom", path: ["provider", "providerReleaseStatus"], message: "Provider release requires an eligible exact local input preflight." });
  }
  if (record.result) {
    if (record.result.accepted !== record.accepted || record.result.primaryFailureClass !== record.primaryFailureClass) {
      context.addIssue({ code: "custom", message: "Top-level decision must match the structured result." });
    }
  }
  if (record.reviewer.role === "adjudicator" && record.status === "scored") {
    const adjudication = adjudicationResultSchema.safeParse(record.result);
    if (!adjudication.success) {
      context.addIssue({ code: "custom", path: ["result"], message: "Adjudicator records require the strict blinded adjudication result." });
    }
  }
  if (record.reviewer.role === "primary" && record.status === "scored") {
    const primary = primaryReviewerResultStructuralSchema.safeParse(record.result);
    if (!primary.success) {
      context.addIssue({ code: "custom", path: ["result"], message: "Primary records require the full strict blinded reviewer result." });
    } else if (record.measurement.role === "measurement") {
      if (record.measurement.packet === null || primary.data.metricsAssessment === null
          || primary.data.metricsAssessment.packetRoot !== record.measurement.packet.packetRoot
          || record.measurement.assessmentOutputSha256 !== bareHash(primary.data.metricsAssessment)) {
        context.addIssue({ code: "custom", path: ["measurement"], message: "The preselected measurement primary must bind its exact packet and assessment output." });
      }
    } else if (record.measurement.packet !== null || record.measurement.assessmentOutputSha256 !== null
        || primary.data.metricsAssessment !== null) {
      context.addIssue({ code: "custom", path: ["measurement"], message: "A standard primary cannot carry metrics measurement evidence." });
    }
  }
  if (record.reviewer.role === "adjudicator"
      && (record.measurement.role !== "standard" || record.measurement.packet !== null
        || record.measurement.assessmentOutputSha256 !== null)) {
    context.addIssue({ code: "custom", path: ["measurement"], message: "Adjudicator records cannot carry metrics measurement evidence." });
  }
  if (record.status === "failed" && record.measurement.assessmentOutputSha256 !== null) {
    context.addIssue({ code: "custom", path: ["measurement", "assessmentOutputSha256"], message: "Failed reviews cannot claim a completed metrics assessment." });
  }
  if (record.measurement.role === "standard" && record.measurement.packet !== null) {
    context.addIssue({ code: "custom", path: ["measurement", "packet"], message: "Standard reviewers cannot retain a metrics measurement packet." });
  }
});

const lockedReviewSchema = z.object({
  artifactId: opaqueIdSchema,
  reviewerId: opaqueIdSchema,
  reviewerRole: z.enum(["primary", "adjudicator"]),
  recordSha256: bareSha256Schema,
  lockedAt: timestampSchema,
  accepted: z.boolean(),
  primaryFailureClass: primaryFailureClassSchema,
  record: lockedEvaluatorRecordSchema,
}).strict();

export const adjudicationAssignmentSchema = z.object({
  artifactId: opaqueIdSchema,
  reviewerId: opaqueIdSchema,
  workItem: reviewerWorkItemSchema,
  primaryRecordSha256s: z.tuple([bareSha256Schema, bareSha256Schema]),
}).strict();

const reviewLedgerWithoutRootSchema = z.object({
  schemaVersion: z.literal(1),
  planRoot: digestSchema,
  phase: z.enum(["primaries_locked", "adjudication_pending", "classifiable"]),
  primaryLocks: z.array(lockedReviewSchema),
  adjudicationAssignments: z.array(adjudicationAssignmentSchema),
  adjudicationLocks: z.array(lockedReviewSchema),
}).strict();

export const reviewLedgerSchema = reviewLedgerWithoutRootSchema.extend({ ledgerRoot: digestSchema }).strict();

export const artifactClassificationSchema = z.object({
  artifactId: opaqueIdSchema,
  attemptId: stableIdSchema,
  taskId: stableIdSchema,
  authorOutcome: z.enum(["completed", "failed", "timeout", "infra_failure", "policy_violation"]),
  accepted: z.boolean(),
  reviewAccepted: z.boolean(),
  primaryFailureClass: primaryFailureClassSchema,
  primaryFailureClasses: z.tuple([primaryFailureClassSchema, primaryFailureClassSchema]),
  primaryClassAgreement: z.boolean(),
  resolution: z.enum([
    "primary_agreement",
    "frozen_precedence_without_adjudication",
    "primary_scorer_failure",
    "binary_adjudication",
    "author_outcome_override",
  ]),
  primaryRecordSha256s: z.tuple([bareSha256Schema, bareSha256Schema]),
  adjudicationRecordSha256: bareSha256Schema.nullable(),
}).strict();

const classificationBookWithoutRootSchema = z.object({
  schemaVersion: z.literal(1),
  planRoot: digestSchema,
  ledgerRoot: digestSchema,
  registryRoot: digestSchema,
  denominator: z.number().int().positive(),
  classifications: z.array(artifactClassificationSchema),
}).strict();

export const classificationBookSchema = classificationBookWithoutRootSchema.extend({ classificationRoot: digestSchema }).strict();

export type EvaluatorArtifactSource = z.infer<typeof evaluatorArtifactSourceSchema>;
export type ReviewerRosterEntry = z.infer<typeof reviewerRosterEntrySchema>;
export type BlindedReviewPolicy = z.infer<typeof blindedReviewPolicySchema>;
export type EvaluatorRunnerConfig = z.infer<typeof evaluatorRunnerConfigSchema>;
export type ReviewerWorkItem = z.infer<typeof reviewerWorkItemSchema>;
export type BlindedReviewPlan = z.infer<typeof blindedReviewPlanSchema>;
export type LockedEvaluatorRecord = z.infer<typeof lockedEvaluatorRecordSchema>;
export type ReviewLedger = z.infer<typeof reviewLedgerSchema>;
export type ClassificationBook = z.infer<typeof classificationBookSchema>;

type EvaluatorUsage = z.infer<typeof usageSchema>;
type EvaluatorPricing = z.infer<typeof pricingSchema>;

export function estimatedEvaluatorCost(usage: EvaluatorUsage, pricing: EvaluatorPricing): number {
  const longContext = usage.inputTokens > 272_000;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  return (usage.uncachedInputTokens * pricing.inputUsdPerMillionTokens * inputMultiplier
    + usage.cachedInputTokens * pricing.cachedInputUsdPerMillionTokens * inputMultiplier
    + usage.cacheWriteInputTokens * pricing.cacheWriteInputUsdPerMillionTokens * inputMultiplier
    + usage.outputTokens * pricing.outputUsdPerMillionTokens * outputMultiplier) / 1_000_000;
}

export function computeRubricCriteriaCommitment(rubricSha256: string, criterionIds: readonly string[]): string {
  return hashCanonicalJson({
    schemaVersion: "review-rubric-criteria/v1",
    rubricSha256: digestSchema.parse(rubricSha256),
    criterionIds: z.array(stableIdSchema).min(1).max(256).parse(criterionIds),
  });
}

export function computeAuthorIdentityArtifactSha256(attemptId: string, identityCommitment: string): string {
  return sha256Digest(canonicalJson({
    schemaVersion: "author-identity-commitment/v1",
    attemptId: stableIdSchema.parse(attemptId),
    identityCommitment: digestSchema.parse(identityCommitment),
  }));
}

export function computeAuthorIdentityLinkageCommitment(input: {
  attemptId: string;
  registryAuthorEvidenceRoot: string;
  artifactSha256: string;
}): string {
  return hashCanonicalJson({
    schemaVersion: "review-author-identity-link/v1",
    attemptId: stableIdSchema.parse(input.attemptId),
    registryAuthorEvidenceRoot: digestSchema.parse(input.registryAuthorEvidenceRoot),
    authorIdentityArtifact: {
      path: authorIdentityArtifactPathSchema.parse("author-identity-commitment.json"),
      sha256: digestSchema.parse(input.artifactSha256),
    },
  });
}

function bareHash(value: unknown): string {
  return sha256Digest(canonicalJson(value)).slice("sha256:".length);
}

function safeConfigCommitment(config: EvaluatorRunnerConfig) {
  const commitment: Record<string, unknown> = {
    expectedAttemptBundleSha256: config.expectedAttemptBundleSha256,
    expectedArtifactRoot: config.expectedArtifactRoot,
    expectedAuthorEvidenceRoot: config.expectedAuthorEvidenceRoot,
    expectedAuthorIdentityCommitment: config.expectedAuthorIdentityCommitment,
    expectedAuthorIdentityArtifactSha256: config.expectedAuthorIdentityArtifactSha256,
    taskId: config.taskId,
    expectedRubricSha256: config.expectedRubricSha256,
    committedSourceSetRoot: config.committedSourceSetRoot,
    reviewerId: config.reviewerId,
    reviewerRole: config.reviewerRole,
    model: config.model,
    serviceTier: config.serviceTier,
    reasoningEffort: config.reasoningEffort,
    inputTokenBudget: config.inputTokenBudget,
    outputTokenBudget: config.outputTokenBudget,
    pricing: config.pricing,
    measurement: config.measurement,
  };
  if (config.adjudication) {
    commitment.adjudication = {
      schemaVersion: config.adjudication.schemaVersion,
      primaryRecordSha256s: config.adjudication.primaryRecordSha256s,
    };
  }
  return commitment;
}

export function computeEvaluatorConfigSha256(configInput: EvaluatorRunnerConfig): string {
  return bareHash(safeConfigCommitment(evaluatorRunnerConfigSchema.parse(configInput)));
}

function planProjection(plan: Omit<BlindedReviewPlan, "planRoot"> | BlindedReviewPlan) {
  return Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "planRoot"));
}

export function computeBlindedReviewPlanRoot(plan: Omit<BlindedReviewPlan, "planRoot"> | BlindedReviewPlan): string {
  return hashCanonicalJson(planProjection(plan));
}

function ledgerProjection(ledger: Omit<ReviewLedger, "ledgerRoot"> | ReviewLedger) {
  return Object.fromEntries(Object.entries(ledger).filter(([key]) => key !== "ledgerRoot"));
}

export function computeReviewLedgerRoot(ledger: Omit<ReviewLedger, "ledgerRoot"> | ReviewLedger): string {
  return hashCanonicalJson(ledgerProjection(ledger));
}

function classificationProjection(book: Omit<ClassificationBook, "classificationRoot"> | ClassificationBook) {
  return Object.fromEntries(Object.entries(book).filter(([key]) => key !== "classificationRoot"));
}

export function computeClassificationRoot(book: Omit<ClassificationBook, "classificationRoot"> | ClassificationBook): string {
  return hashCanonicalJson(classificationProjection(book));
}

function parseRoster(rosterInput: readonly ReviewerRosterEntry[]): ReviewerRosterEntry[] {
  const roster = z.array(reviewerRosterEntrySchema).min(3).parse(rosterInput);
  if (new Set(roster.map((entry) => entry.reviewerId)).size !== roster.length) throw new Error("Reviewer IDs must be unique.");
  if (new Set(roster.map((entry) => entry.identityCommitment)).size !== roster.length) throw new Error("Reviewer identity commitments must be unique.");
  return [...roster].sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
}

function reviewerRank(seed: string, registryRoot: string, artifactId: string, reviewer: ReviewerRosterEntry, purpose: string): string {
  return hashCanonicalJson({ seed, registryRoot, artifactId, reviewerIdentity: reviewer.identityCommitment, purpose });
}

function verifySourceCommitments(source: EvaluatorArtifactSource): void {
  if (source.rubricCriteriaCommitment !== computeRubricCriteriaCommitment(source.rubricSha256, source.rubricCriterionIds)) {
    throw new Error(`Rubric criterion commitment drift for ${source.attemptId}.`);
  }
  const expectedIdentityArtifactSha256 = computeAuthorIdentityArtifactSha256(source.attemptId, source.authorIdentityCommitment);
  if (source.authorIdentityEvidence.artifactSha256 !== expectedIdentityArtifactSha256) {
    throw new Error(`Author identity artifact commitment drift for ${source.attemptId}.`);
  }
  const expectedLinkage = computeAuthorIdentityLinkageCommitment({
    attemptId: source.attemptId,
    registryAuthorEvidenceRoot: source.registryAuthorEvidenceRoot,
    artifactSha256: source.authorIdentityEvidence.artifactSha256,
  });
  if (source.authorIdentityEvidence.linkageCommitment !== expectedLinkage) {
    throw new Error(`Author identity registry linkage drift for ${source.attemptId}.`);
  }
}

function eligibleReviewers(
  roster: readonly ReviewerRosterEntry[],
  source: EvaluatorArtifactSource,
  registryRoot: string,
  seed: string,
  purpose: string,
  excludedReviewerIds: readonly string[] = [],
): ReviewerRosterEntry[] {
  const excluded = new Set(excludedReviewerIds);
  return roster
    .filter((reviewer) => reviewer.identityCommitment !== source.authorIdentityCommitment && !excluded.has(reviewer.reviewerId))
    .map((reviewer) => ({ reviewer, rank: reviewerRank(seed, registryRoot, `artifact-${source.attemptBundleSha256.slice(0, 24)}`, reviewer, purpose) }))
    .sort((left, right) => left.rank.localeCompare(right.rank) || left.reviewer.reviewerId.localeCompare(right.reviewer.reviewerId))
    .map(({ reviewer }) => reviewer);
}

function evaluatorConfig(
  source: EvaluatorArtifactSource,
  taskId: string,
  reviewerId: string,
  reviewerRole: "primary" | "adjudicator",
  policy: BlindedReviewPolicy,
  primaryRecords: readonly [LockedEvaluatorRecord, LockedEvaluatorRecord] | null = null,
  measurementRole: "measurement" | "standard" = "standard",
): EvaluatorRunnerConfig {
  const roleBudget = policy.tokenBudgets[reviewerRole];
  const config: Record<string, unknown> = {
    attemptDirectory: source.attemptDirectory,
    expectedAttemptBundleSha256: source.attemptBundleSha256,
    expectedArtifactRoot: source.artifactRootSha256,
    expectedAuthorEvidenceRoot: source.evaluatorAuthorEvidenceRootSha256,
    expectedAuthorIdentityCommitment: source.authorIdentityCommitment,
    expectedAuthorIdentityArtifactSha256: source.authorIdentityEvidence.artifactSha256,
    taskId,
    expectedRubricSha256: source.rubricSha256,
    committedSourceSetRoot: policy.committedSourceSetRoot,
    reviewerId,
    reviewerRole,
    model: policy.model,
    serviceTier: policy.serviceTier,
    reasoningEffort: policy.reasoningEffort,
    inputTokenBudget: roleBudget.inputTokens,
    outputTokenBudget: roleBudget.outputTokens,
    pricing: policy.pricing,
    measurement: {
      role: reviewerRole === "primary" ? measurementRole : "standard",
      samplerId: EXP0001A_REVISION_PACKET_SAMPLER_ID,
    },
    outputDirectory: policy.outputDirectory,
  };
  if (reviewerRole === "adjudicator") {
    if (primaryRecords === null) throw new Error("Adjudicator work requires exactly two locked primary records.");
    config.adjudication = {
      schemaVersion: "blinded-adjudication-input/v1",
      primaryRecords,
      primaryRecordSha256s: primaryRecords.map((record) => record.recordSha256),
    };
  }
  return evaluatorRunnerConfigSchema.parse(config);
}

function workItem(
  source: EvaluatorArtifactSource,
  taskId: string,
  reviewerId: string,
  reviewerRole: "primary" | "adjudicator",
  policy: BlindedReviewPolicy,
  primaryRecords: readonly [LockedEvaluatorRecord, LockedEvaluatorRecord] | null = null,
  measurementRole: "measurement" | "standard" = "standard",
): ReviewerWorkItem {
  const config = evaluatorConfig(source, taskId, reviewerId, reviewerRole, policy, primaryRecords, measurementRole);
  const configSha256 = computeEvaluatorConfigSha256(config);
  return reviewerWorkItemSchema.parse({
    schemaVersion: 1,
    workItemId: `work-${bareHash({ artifact: source.attemptBundleSha256, reviewerId, reviewerRole, configSha256 }).slice(0, 24)}`,
    artifactId: `artifact-${source.attemptBundleSha256.slice(0, 24)}`,
    reviewerId,
    reviewerRole,
    evaluatorConfig: config,
    evaluatorConfigSha256: configSha256,
  });
}

export function createBlindedReviewPlan(input: {
  registry: AttemptRegistry;
  sources: readonly EvaluatorArtifactSource[];
  reviewerRoster: readonly ReviewerRosterEntry[];
  policy: BlindedReviewPolicy;
}): BlindedReviewPlan {
  const registry = attemptRegistrySchema.parse(input.registry);
  const verification = verifyAttemptRegistry(registry);
  if (!verification.ok) throw new Error(`Attempt registry verification failed: ${verification.errors.join(" ")}`);
  if (registry.attempts.some((attempt) => attempt.state !== "sealed" || attempt.authorOutcome === null || attempt.authorEvidenceRoot === null)) {
    throw new Error("Every all-attempt registry entry must be sealed before blinded review planning.");
  }
  const policy = blindedReviewPolicySchema.parse(input.policy);
  const roster = parseRoster(input.reviewerRoster);
  const sources = input.sources.map((source) => evaluatorArtifactSourceSchema.parse(source));
  if (new Set(sources.map((source) => source.attemptId)).size !== sources.length) throw new Error("Evaluator artifact sources must have unique attempt IDs.");
  const sourceByAttempt = new Map(sources.map((source) => [source.attemptId, source]));
  const registryIds = registry.attempts.map((attempt) => attempt.attemptId);
  const missing = registryIds.filter((attemptId) => !sourceByAttempt.has(attemptId));
  const unexpected = sources.filter((source) => !registry.attempts.some((attempt) => attempt.attemptId === source.attemptId));
  if (missing.length > 0 || unexpected.length > 0) throw new Error("Evaluator artifact sources must reconcile exactly to the all-attempt registry denominator.");

  const artifacts = registry.attempts.map((attempt) => {
    const source = sourceByAttempt.get(attempt.attemptId)!;
    if (source.registryAuthorEvidenceRoot !== attempt.authorEvidenceRoot) throw new Error(`Registry author-evidence commitment drift for ${attempt.attemptId}.`);
    verifySourceCommitments(source);
    const identityEntry = attempt.artifactIndex?.entries.find((entry) => entry.path === source.authorIdentityEvidence.path);
    if (!identityEntry || identityEntry.sha256 !== source.authorIdentityEvidence.artifactSha256) {
      throw new Error(`Author identity for ${attempt.attemptId} is not committed by the retained sealed artifact index.`);
    }
    const artifactId = `artifact-${source.attemptBundleSha256.slice(0, 24)}`;
    const eligible = eligibleReviewers(roster, source, registry.registryRoot, policy.assignmentSeed, "primary");
    if (eligible.length < 3) throw new Error(`Artifact ${artifactId} lacks two primaries plus an independent non-author adjudicator.`);
    const reviewers = eligible.slice(0, 2);
    const primaryWorkItems = reviewers.map((reviewer, index) => workItem(
      source,
      attempt.taskId,
      reviewer.reviewerId,
      "primary",
      policy,
      null,
      index === 0 ? "measurement" : "standard",
    ));
    return trustedArtifactPlanSchema.parse({
      artifactId,
      attemptId: attempt.attemptId,
      taskId: attempt.taskId,
      authorOutcome: attempt.authorOutcome,
      authorIdentityCommitment: source.authorIdentityCommitment,
      evidence: {
        attemptDirectory: source.attemptDirectory,
        attemptBundleSha256: source.attemptBundleSha256,
        artifactRootSha256: source.artifactRootSha256,
        evaluatorAuthorEvidenceRootSha256: source.evaluatorAuthorEvidenceRootSha256,
        registryAuthorEvidenceRoot: source.registryAuthorEvidenceRoot,
        rubricSha256: source.rubricSha256,
        rubricCriterionIds: source.rubricCriterionIds,
        rubricCriteriaCommitment: source.rubricCriteriaCommitment,
        authorIdentityEvidence: source.authorIdentityEvidence,
      },
      primaryReviewerIds: [reviewers[0].reviewerId, reviewers[1].reviewerId],
      primaryWorkItems,
    });
  });
  if (new Set(artifacts.map((artifact) => artifact.artifactId)).size !== artifacts.length) throw new Error("Opaque artifact IDs collide.");
  const unsigned = blindedReviewPlanWithoutRootSchema.parse({
    schemaVersion: 2,
    registryRoot: registry.registryRoot,
    runSpecDigest: registry.runSpecDigest,
    denominator: registry.attempts.length,
    policy,
    reviewerRoster: roster,
    artifacts,
  });
  return blindedReviewPlanSchema.parse({ ...unsigned, planRoot: computeBlindedReviewPlanRoot(unsigned) });
}

export function verifyBlindedReviewPlan(planInput: BlindedReviewPlan): void {
  const plan = blindedReviewPlanSchema.parse(planInput);
  if (computeBlindedReviewPlanRoot(plan) !== plan.planRoot) throw new Error("Blinded review plan root is invalid.");
  if (plan.denominator !== plan.artifacts.length) throw new Error("Blinded review plan denominator is invalid.");
  const roster = parseRoster(plan.reviewerRoster);
  for (const artifact of plan.artifacts) {
    if (new Set(artifact.primaryReviewerIds).size !== 2) throw new Error(`Artifact ${artifact.artifactId} reuses a primary reviewer.`);
    if (artifact.primaryWorkItems.some((item) => item.artifactId !== artifact.artifactId || item.reviewerRole !== "primary")) {
      throw new Error(`Artifact ${artifact.artifactId} has an invalid primary work item.`);
    }
    const source = evaluatorArtifactSourceSchema.parse({
      schemaVersion: 2,
      attemptId: artifact.attemptId,
      authorIdentityCommitment: artifact.authorIdentityCommitment,
      ...artifact.evidence,
    });
    verifySourceCommitments(source);
    const expected = eligibleReviewers(roster, source, plan.registryRoot, plan.policy.assignmentSeed, "primary").slice(0, 2).map((reviewer) => reviewer.reviewerId);
    if (canonicalJson(expected) !== canonicalJson(artifact.primaryReviewerIds)) throw new Error(`Artifact ${artifact.artifactId} reviewer assignment drifted.`);
    artifact.primaryWorkItems.forEach((item, index) => {
      const expectedItem = workItem(
        source,
        artifact.taskId,
        artifact.primaryReviewerIds[index],
        "primary",
        plan.policy,
        null,
        index === 0 ? "measurement" : "standard",
      );
      if (canonicalJson(item) !== canonicalJson(expectedItem) || computeEvaluatorConfigSha256(item.evaluatorConfig) !== item.evaluatorConfigSha256) {
        throw new Error(`Artifact ${artifact.artifactId} evaluator configuration drifted.`);
      }
    });
  }
}

function recordProjection(record: LockedEvaluatorRecord) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "recordSha256"));
}

export function computeEvaluatorRecordSha256(record: Omit<LockedEvaluatorRecord, "recordSha256"> | LockedEvaluatorRecord): string {
  return bareHash(recordProjection(record as LockedEvaluatorRecord));
}

function validatePrimaryReviewerResult(
  rawResult: unknown,
  criterionIds: readonly string[],
  mechanismTags: readonly string[],
): z.infer<typeof primaryReviewerResultStructuralSchema> {
  const result = primaryReviewerResultStructuralSchema.parse(rawResult);
  const expectedCriteria = new Set(criterionIds);
  const actualCriteria = new Set(result.criteria.map((criterion) => criterion.criterionId));
  const addressedCriteria = new Set(result.evidenceCoverage.criteriaAddressed);
  if (result.criteria.length !== criterionIds.length || actualCriteria.size !== criterionIds.length
      || criterionIds.some((criterionId) => !actualCriteria.has(criterionId))) {
    throw new Error("Every mandatory public criterion must be decided exactly once.");
  }
  if (result.evidenceCoverage.criteriaAddressed.length !== criterionIds.length
      || addressedCriteria.size !== criterionIds.length
      || criterionIds.some((criterionId) => !addressedCriteria.has(criterionId))) {
    throw new Error("Primary evidence coverage must address every mandatory public criterion exactly once.");
  }
  const allowedEvidenceRefs = new Set([
    "semantic_state",
    "spectator_png",
    ...criterionIds.map((criterionId) => `rubric:${criterionId}`),
  ]);
  const assertAllowedRefs = (references: readonly string[]) => {
    if (references.some((reference) => !allowedEvidenceRefs.has(reference))) {
      throw new Error("Primary result cites evidence outside the frozen same-artifact rubric namespace.");
    }
  };
  result.criteria.forEach((criterion) => {
    assertAllowedRefs(criterion.evidenceRefs);
    if (!expectedCriteria.has(criterion.criterionId)
        || !criterion.evidenceRefs.includes(`rubric:${criterion.criterionId}`)
        || !criterion.evidenceRefs.some((reference) => reference === "semantic_state" || reference === "spectator_png")) {
      throw new Error("Each criterion must cite its own rubric item and at least one allowed evidence view.");
    }
  });
  Object.values(result.observations).forEach((observation) => assertAllowedRefs(observation.evidenceRefs));
  const allowedMechanismTags = new Set(mechanismTags);
  if (new Set(result.mechanismTags.map((mechanism) => mechanism.tag)).size !== result.mechanismTags.length
      || result.mechanismTags.some((mechanism) => !allowedMechanismTags.has(mechanism.tag))) {
    throw new Error("Primary mechanism tags must be unique members of the frozen taxonomy.");
  }
  result.mechanismTags.forEach((mechanism) => assertAllowedRefs(mechanism.evidenceRefs));
  const complete = result.evidenceCoverage.status === "complete"
    && result.evidenceCoverage.semanticState
    && result.evidenceCoverage.spectatorPixels
    && result.evidenceCoverage.gaps.length === 0;
  const shouldAccept = complete && result.criteria.every((criterion) => criterion.decision === "pass");
  if (result.accepted !== shouldAccept || ((result.primaryFailureClass === "SUCCESS") !== result.accepted)) {
    throw new Error("Primary acceptance and failure class do not reconcile with complete criterion coverage.");
  }
  return result;
}

function validatePrimaryMeasurement(
  result: z.infer<typeof primaryReviewerResultStructuralSchema>,
  record: LockedEvaluatorRecord,
  item: ReviewerWorkItem,
): void {
  if (record.measurement.role !== item.evaluatorConfig.measurement.role) {
    throw new Error("Evaluator measurement role drifted from the pre-frozen work item.");
  }
  if (item.evaluatorConfig.measurement.role === "standard") {
    if (record.measurement.packet !== null || record.measurement.assessmentOutputSha256 !== null
        || result.metricsAssessment !== null) {
      throw new Error("The nonselected primary cannot substitute a metrics assessment.");
    }
    return;
  }
  const packet = verifyBlindedRevisionAssessmentPacket(record.measurement.packet);
  const assessment = result.metricsAssessment;
  if (!assessment || assessment.packetRoot !== packet.packetRoot
      || record.measurement.assessmentOutputSha256 !== bareHash(assessment)) {
    throw new Error("Measurement assessment does not commit the exact prepared revision packet and output.");
  }
  const expectedRefs = packet.inventory.map((entry) => entry.revisionRef);
  const actualRefs = assessment.revisions.map((entry) => entry.revisionRef);
  if (actualRefs.length !== expectedRefs.length || new Set(actualRefs).size !== expectedRefs.length
      || expectedRefs.some((revisionRef) => !actualRefs.includes(revisionRef))) {
    throw new Error("Measurement assessment must cover every sampled revision exactly once.");
  }
  const rubric = packet.measurementRubric;
  const allowedCriterionRefs = new Set(rubric.criteria.map((criterion) => criterion.criterionRef));
  const allowedIssueKeys = new Set(rubric.issueVocabulary.map((issue) => issue.key));
  const blockingIssueKeys = new Set(rubric.issueVocabulary.filter((issue) => issue.blocking).map((issue) => issue.key));
  const failureKeyByCriterionRef = new Map(rubric.issueVocabulary
    .filter((issue) => issue.kind === "criterion_failure")
    .map((issue) => [issue.criterionRef, issue.key]));
  for (const revision of assessment.revisions) {
    const satisfied = new Set(revision.satisfiedCriterionRefs);
    const issues = new Set(revision.issueKeys);
    const expectedFailureKeys = rubric.criteria.filter((criterion) => !satisfied.has(criterion.criterionRef))
      .map((criterion) => failureKeyByCriterionRef.get(criterion.criterionRef));
    const actualFailureKeys = revision.issueKeys.filter((issueKey) => issueKey.startsWith("criterion_failure:"));
    const semanticScore = satisfied.size / rubric.criteria.length;
    const blockingCount = revision.issueKeys.filter((issueKey) => blockingIssueKeys.has(issueKey)).length;
    const qualityValue = (semanticScore + revision.visualUsabilityScore) / 2;
    const usefulDraft = semanticScore >= rubric.usefulDraftRule.minimumSemanticScore
      && revision.visualUsabilityScore >= rubric.usefulDraftRule.minimumVisualUsabilityScore
      && blockingCount === 0;
    if (satisfied.size !== revision.satisfiedCriterionRefs.length
        || [...satisfied].some((criterionRef) => !allowedCriterionRefs.has(criterionRef))
        || issues.size !== revision.issueKeys.length
        || [...issues].some((issueKey) => !allowedIssueKeys.has(issueKey))
        || canonicalJson([...actualFailureKeys].sort()) !== canonicalJson([...expectedFailureKeys].sort())
        || Math.abs(revision.semanticScore - semanticScore) > 1e-12
        || revision.blockingViolationCount !== blockingCount
        || Math.abs(revision.qualityValue - qualityValue) > 1e-12
        || revision.usefulDraft !== usefulDraft) {
      throw new Error("Measurement revision does not follow the frozen treatment-neutral measurement rubric.");
    }
  }
  if (packet.finalRevisionRef === null || assessment.finalState.revisionRef !== packet.finalRevisionRef
      || assessment.finalState.successfulArtifact !== result.accepted) {
    throw new Error("Measurement final-state assessment must bind the exact final revision and primary decision.");
  }
  const finalRevision = assessment.revisions.find((revision) => revision.revisionRef === packet.finalRevisionRef);
  const passedCriterionRefs = result.criteria.filter((criterion) => criterion.decision === "pass").map((criterion) => {
    const match = rubric.criteria.find((entry) => entry.criterionId === criterion.criterionId);
    return match?.criterionRef;
  }).filter((criterionRef): criterionRef is string => criterionRef !== undefined).sort();
  if (!finalRevision
      || canonicalJson([...finalRevision.satisfiedCriterionRefs].sort()) !== canonicalJson(passedCriterionRefs)) {
    throw new Error("Final revision measurement does not match the locked primary criterion decisions.");
  }
}

function validateAdjudicationResultForCriteria(rawResult: unknown, criterionIds: readonly string[]): z.infer<typeof adjudicationResultSchema> {
  const result = adjudicationResultSchema.parse(rawResult);
  const allowed = new Set([
    "semantic_state",
    "spectator_png",
    "primary_review:1",
    "primary_review:2",
    ...criterionIds.map((criterionId) => `rubric:${criterionId}`),
  ]);
  if (result.evidenceRefs.some((reference) => !allowed.has(reference))) {
    throw new Error("Adjudication cites evidence outside the frozen same-artifact rubric namespace.");
  }
  return result;
}

function verifyRecordForWorkItem(
  rawRecord: LockedEvaluatorRecord,
  item: ReviewerWorkItem,
  validation: { criterionIds: readonly string[]; mechanismTags: readonly string[] },
): LockedEvaluatorRecord {
  const record = lockedEvaluatorRecordSchema.parse(rawRecord);
  if (computeEvaluatorRecordSha256(record) !== record.recordSha256) throw new Error("Evaluator result record hash is invalid.");
  if (record.artifactId !== item.artifactId || record.taskId !== item.evaluatorConfig.taskId
      || record.reviewer.id !== item.reviewerId || record.reviewer.role !== item.reviewerRole) {
    throw new Error("Evaluator result does not belong to its assigned blinded work item.");
  }
  if (record.configSha256 !== item.evaluatorConfigSha256) throw new Error("Evaluator result configuration commitment drifted.");
  if (record.committedSourceSetRoot !== item.evaluatorConfig.committedSourceSetRoot) {
    throw new Error("Evaluator result committed-source set drifted.");
  }
  if (record.budgets.inputTokens !== item.evaluatorConfig.inputTokenBudget
      || record.budgets.outputTokens !== item.evaluatorConfig.outputTokenBudget
      || canonicalJson(record.pricing) !== canonicalJson(item.evaluatorConfig.pricing)
      || record.provider.modelRequested !== item.evaluatorConfig.model
      || record.measurement.role !== item.evaluatorConfig.measurement.role
      || (record.measurement.packet !== null
        && record.measurement.packet.sampler.id !== item.evaluatorConfig.measurement.samplerId)) {
    throw new Error("Evaluator result configuration fields drifted.");
  }
  if (record.evidence !== null && (
    record.evidence.attemptBundleSha256 !== item.evaluatorConfig.expectedAttemptBundleSha256
    || record.evidence.artifactRoot !== item.evaluatorConfig.expectedArtifactRoot
    || record.evidence.authorEvidenceRoot !== item.evaluatorConfig.expectedAuthorEvidenceRoot
    || record.evidence.authorIdentityCommitment !== item.evaluatorConfig.expectedAuthorIdentityCommitment
    || record.evidence.authorIdentityArtifactSha256 !== item.evaluatorConfig.expectedAuthorIdentityArtifactSha256
    || (record.evidence.rubricSha256 !== null
      && `sha256:${record.evidence.rubricSha256}` !== item.evaluatorConfig.expectedRubricSha256)
  )) throw new Error("Evaluator result evidence commitments drifted.");
  if (record.status === "scored" && record.result !== null && record.hashes.outputSha256 !== bareHash(record.result)) {
    throw new Error("Evaluator structured result hash is invalid.");
  }
  if (record.status === "scored" && item.reviewerRole === "primary") {
    const result = validatePrimaryReviewerResult(record.result, validation.criterionIds, validation.mechanismTags);
    if (record.accepted !== result.accepted || record.primaryFailureClass !== result.primaryFailureClass) {
      throw new Error("Primary result decision does not match the strict structured result.");
    }
    validatePrimaryMeasurement(result, record, item);
  }
  if (record.status === "scored" && item.reviewerRole === "adjudicator") {
    validateAdjudicationResultForCriteria(record.result, validation.criterionIds);
  }
  if (item.reviewerRole === "adjudicator") {
    const adjudication = item.evaluatorConfig.adjudication;
    if (!adjudication || !record.adjudication
        || canonicalJson(record.adjudication) !== canonicalJson({
          schemaVersion: adjudication.schemaVersion,
          primaryRecordSha256s: adjudication.primaryRecordSha256s,
        })) {
      throw new Error("Adjudicator result primary-record commitments drifted.");
    }
    const primaries = adjudication.primaryRecords.map((rawPrimary) => lockedEvaluatorRecordSchema.parse(rawPrimary));
    if (primaries.some((primary, index) => primary.reviewer.role !== "primary"
        || primary.status !== "scored"
        || computeEvaluatorRecordSha256(primary) !== primary.recordSha256
        || primary.recordSha256 !== adjudication.primaryRecordSha256s[index]
        || primary.artifactId !== item.artifactId
        || primary.taskId !== item.evaluatorConfig.taskId)) {
      throw new Error("Adjudication primary records are stale, invalid, or bound to another artifact.");
    }
    const primaryReviewerIds = primaries.map((primary) => primary.reviewer.id);
    if (new Set(primaryReviewerIds).size !== 2 || primaryReviewerIds.includes(item.reviewerId)) {
      throw new Error("Adjudicator and primary reviewer identities must be distinct.");
    }
    if (primaries[0].accepted === primaries[1].accepted) {
      throw new Error("Adjudication is allowed only for a binary primary disagreement.");
    }
    if (primaries.some((primary) => primary.evidence === null
        || primary.evidence.attemptBundleSha256 !== item.evaluatorConfig.expectedAttemptBundleSha256
        || primary.evidence.artifactRoot !== item.evaluatorConfig.expectedArtifactRoot
        || primary.evidence.authorEvidenceRoot !== item.evaluatorConfig.expectedAuthorEvidenceRoot
        || primary.evidence.authorIdentityCommitment !== item.evaluatorConfig.expectedAuthorIdentityCommitment
        || primary.evidence.authorIdentityArtifactSha256 !== item.evaluatorConfig.expectedAuthorIdentityArtifactSha256)) {
      throw new Error("Adjudication primary evidence drifted from the frozen artifact.");
    }
    primaries.forEach((primary) => validatePrimaryReviewerResult(primary.result, validation.criterionIds, validation.mechanismTags));
  }
  return record;
}

function lockedReview(record: LockedEvaluatorRecord): z.infer<typeof lockedReviewSchema> {
  return lockedReviewSchema.parse({
    artifactId: record.artifactId,
    reviewerId: record.reviewer.id,
    reviewerRole: record.reviewer.role,
    recordSha256: record.recordSha256,
    lockedAt: record.lockedAt,
    accepted: record.accepted,
    primaryFailureClass: record.primaryFailureClass,
    record,
  });
}

function recordValidationForArtifact(plan: BlindedReviewPlan, artifactId: string) {
  const artifact = plan.artifacts.find((candidate) => candidate.artifactId === artifactId);
  if (!artifact) throw new Error("Evaluator record references an artifact outside the blinded review plan.");
  return { criterionIds: artifact.evidence.rubricCriterionIds, mechanismTags: plan.policy.mechanismTags };
}

export function lockPrimaryReviews(planInput: BlindedReviewPlan, recordsInput: readonly LockedEvaluatorRecord[]): ReviewLedger {
  verifyBlindedReviewPlan(planInput);
  const plan = blindedReviewPlanSchema.parse(planInput);
  const expectedItems = plan.artifacts.flatMap((artifact) => artifact.primaryWorkItems);
  if (recordsInput.length !== expectedItems.length) throw new Error("Every artifact requires exactly two locked primary reviews before orchestration can proceed.");
  const byKey = new Map<string, LockedEvaluatorRecord>();
  for (const rawRecord of recordsInput) {
    const parsed = lockedEvaluatorRecordSchema.parse(rawRecord);
    const key = `${parsed.artifactId}:${parsed.reviewer.id}`;
    if (byKey.has(key)) throw new Error("Duplicate reviewer identity within an artifact.");
    byKey.set(key, parsed);
  }
  const primaryLocks = expectedItems.map((item) => {
    const record = byKey.get(`${item.artifactId}:${item.reviewerId}`);
    if (!record) throw new Error("Primary evaluator result set does not match the deterministic assignments.");
    return lockedReview(verifyRecordForWorkItem(record, item, recordValidationForArtifact(plan, item.artifactId)));
  });
  if (byKey.size !== primaryLocks.length) throw new Error("Primary evaluator result set contains an unassigned record.");
  const unsigned = reviewLedgerWithoutRootSchema.parse({
    schemaVersion: 1,
    planRoot: plan.planRoot,
    phase: "primaries_locked",
    primaryLocks,
    adjudicationAssignments: [],
    adjudicationLocks: [],
  });
  return reviewLedgerSchema.parse({ ...unsigned, ledgerRoot: computeReviewLedgerRoot(unsigned) });
}

export function verifyReviewLedger(planInput: BlindedReviewPlan, ledgerInput: ReviewLedger): void {
  verifyBlindedReviewPlan(planInput);
  const plan = blindedReviewPlanSchema.parse(planInput);
  const ledger = reviewLedgerSchema.parse(ledgerInput);
  if (ledger.planRoot !== plan.planRoot || computeReviewLedgerRoot(ledger) !== ledger.ledgerRoot) throw new Error("Review ledger commitment is invalid.");
  const expectedPrimaryKeys = new Set(plan.artifacts.flatMap((artifact) => artifact.primaryWorkItems.map((item) => `${item.artifactId}:${item.reviewerId}`)));
  const actualPrimaryKeys = ledger.primaryLocks.map((lock) => `${lock.artifactId}:${lock.reviewerId}`);
  if (actualPrimaryKeys.length !== expectedPrimaryKeys.size || new Set(actualPrimaryKeys).size !== actualPrimaryKeys.length
      || actualPrimaryKeys.some((key) => !expectedPrimaryKeys.has(key))) throw new Error("Review ledger primary denominator is invalid.");
  for (const lock of ledger.primaryLocks) {
    const item = plan.artifacts.flatMap((artifact) => artifact.primaryWorkItems)
      .find((candidate) => candidate.artifactId === lock.artifactId && candidate.reviewerId === lock.reviewerId);
    if (!item || lock.reviewerRole !== "primary") throw new Error("Review ledger contains an invalid primary lock.");
    const record = verifyRecordForWorkItem(lock.record, item, recordValidationForArtifact(plan, item.artifactId));
    if (lock.recordSha256 !== record.recordSha256 || lock.lockedAt !== record.lockedAt
        || lock.accepted !== record.accepted || lock.primaryFailureClass !== record.primaryFailureClass
        || lock.reviewerId !== record.reviewer.id || lock.artifactId !== record.artifactId) {
      throw new Error("Review ledger contains an invalid primary lock summary.");
    }
  }
  const disagreements = new Set(plan.artifacts.flatMap((artifact) => {
    const locks = ledger.primaryLocks.filter((lock) => lock.artifactId === artifact.artifactId);
    return locks.every((lock) => lock.record.status === "scored") && locks[0].accepted !== locks[1].accepted
      ? [artifact.artifactId]
      : [];
  }));
  if (ledger.phase === "primaries_locked") {
    if (ledger.adjudicationAssignments.length > 0 || ledger.adjudicationLocks.length > 0) throw new Error("Premature adjudication is forbidden.");
    return;
  }
  if (ledger.adjudicationAssignments.length !== disagreements.size
      || ledger.adjudicationAssignments.some((assignment) => !disagreements.has(assignment.artifactId))) {
    throw new Error("Adjudication assignments must cover every and only binary disagreement.");
  }
  for (const assignment of ledger.adjudicationAssignments) {
    const artifact = plan.artifacts.find((candidate) => candidate.artifactId === assignment.artifactId)!;
    const primaryLocks = ledger.primaryLocks.filter((lock) => lock.artifactId === artifact.artifactId);
    const source = evaluatorArtifactSourceSchema.parse({
      schemaVersion: 2,
      attemptId: artifact.attemptId,
      authorIdentityCommitment: artifact.authorIdentityCommitment,
      ...artifact.evidence,
    });
    const reviewer = eligibleReviewers(
      plan.reviewerRoster,
      source,
      plan.registryRoot,
      plan.policy.assignmentSeed,
      "adjudication",
      artifact.primaryReviewerIds,
    )[0];
    if (!reviewer) throw new Error("Independent adjudicator is unavailable.");
    if (primaryLocks.length !== 2) throw new Error("Adjudication assignment requires exactly two primary locks.");
    const primaryRecords: [LockedEvaluatorRecord, LockedEvaluatorRecord] = [primaryLocks[0].record, primaryLocks[1].record];
    const expectedItem = workItem(source, artifact.taskId, reviewer.reviewerId, "adjudicator", plan.policy, primaryRecords);
    if (assignment.reviewerId !== reviewer.reviewerId || canonicalJson(assignment.workItem) !== canonicalJson(expectedItem)
        || canonicalJson(assignment.primaryRecordSha256s) !== canonicalJson(primaryLocks.map((lock) => lock.recordSha256))) {
      throw new Error("Adjudication assignment drifted.");
    }
  }
  if (ledger.phase === "adjudication_pending" && ledger.adjudicationLocks.length > 0) throw new Error("Adjudication locks cannot be partial.");
  if (ledger.phase === "classifiable" && ledger.adjudicationLocks.length !== ledger.adjudicationAssignments.length) {
    throw new Error("Classifiable ledger lacks required adjudication locks.");
  }
  for (const lock of ledger.adjudicationLocks) {
    const assignment = ledger.adjudicationAssignments.find((candidate) => candidate.artifactId === lock.artifactId);
    if (!assignment || lock.reviewerRole !== "adjudicator") throw new Error("Review ledger contains a selective adjudication lock.");
    const record = verifyRecordForWorkItem(
      lock.record,
      assignment.workItem,
      recordValidationForArtifact(plan, assignment.artifactId),
    );
    if (lock.recordSha256 !== record.recordSha256 || lock.lockedAt !== record.lockedAt
        || lock.accepted !== record.accepted || lock.primaryFailureClass !== record.primaryFailureClass
        || lock.reviewerId !== record.reviewer.id || lock.artifactId !== record.artifactId) {
      throw new Error("Review ledger contains an invalid adjudication lock summary.");
    }
  }
}

export function prepareAdjudicationWork(planInput: BlindedReviewPlan, ledgerInput: ReviewLedger): {
  ledger: ReviewLedger;
  workItems: ReviewerWorkItem[];
} {
  verifyReviewLedger(planInput, ledgerInput);
  const plan = blindedReviewPlanSchema.parse(planInput);
  const ledger = reviewLedgerSchema.parse(ledgerInput);
  if (ledger.phase !== "primaries_locked" || ledger.adjudicationAssignments.length > 0 || ledger.adjudicationLocks.length > 0) {
    throw new Error("Adjudication can be prepared exactly once after all primary reviews lock.");
  }
  const assignments = plan.artifacts.flatMap((artifact) => {
    const primaryLocks = ledger.primaryLocks.filter((lock) => lock.artifactId === artifact.artifactId);
    if (primaryLocks.length !== 2) throw new Error("Adjudication preparation requires two primary locks per artifact.");
    if (primaryLocks.some((lock) => lock.record.status === "failed")
        || primaryLocks[0].accepted === primaryLocks[1].accepted) return [];
    const source = evaluatorArtifactSourceSchema.parse({
      schemaVersion: 2,
      attemptId: artifact.attemptId,
      authorIdentityCommitment: artifact.authorIdentityCommitment,
      ...artifact.evidence,
    });
    const reviewer = eligibleReviewers(
      plan.reviewerRoster,
      source,
      plan.registryRoot,
      plan.policy.assignmentSeed,
      "adjudication",
      artifact.primaryReviewerIds,
    )[0];
    if (!reviewer) throw new Error(`Artifact ${artifact.artifactId} lacks an independent non-author adjudicator.`);
    const primaryRecords: [LockedEvaluatorRecord, LockedEvaluatorRecord] = [primaryLocks[0].record, primaryLocks[1].record];
    const item = workItem(source, artifact.taskId, reviewer.reviewerId, "adjudicator", plan.policy, primaryRecords);
    return [adjudicationAssignmentSchema.parse({
      artifactId: artifact.artifactId,
      reviewerId: reviewer.reviewerId,
      workItem: item,
      primaryRecordSha256s: primaryLocks.map((lock) => lock.recordSha256),
    })];
  });
  const unsigned = reviewLedgerWithoutRootSchema.parse({
    ...ledgerProjection(ledger),
    phase: assignments.length > 0 ? "adjudication_pending" : "classifiable",
    adjudicationAssignments: assignments,
  });
  const next = reviewLedgerSchema.parse({ ...unsigned, ledgerRoot: computeReviewLedgerRoot(unsigned) });
  return { ledger: next, workItems: assignments.map((assignment) => assignment.workItem) };
}

export function lockAdjudicationReviews(
  planInput: BlindedReviewPlan,
  ledgerInput: ReviewLedger,
  recordsInput: readonly LockedEvaluatorRecord[],
): ReviewLedger {
  verifyReviewLedger(planInput, ledgerInput);
  const plan = blindedReviewPlanSchema.parse(planInput);
  const ledger = reviewLedgerSchema.parse(ledgerInput);
  if (ledger.phase !== "adjudication_pending") {
    if (recordsInput.length > 0) throw new Error("Selective adjudication is forbidden for artifacts without binary disagreement.");
    return ledger;
  }
  if (recordsInput.length !== ledger.adjudicationAssignments.length) throw new Error("Every and only binary disagreement must receive one adjudication.");
  const byKey = new Map(recordsInput.map((record) => [`${record.artifactId}:${record.reviewer.id}`, record]));
  if (byKey.size !== recordsInput.length) throw new Error("Duplicate adjudicator identity within an artifact.");
  const locks = ledger.adjudicationAssignments.map((assignment) => {
    const record = byKey.get(`${assignment.artifactId}:${assignment.reviewerId}`);
    if (!record) throw new Error("Adjudication result set does not match deterministic assignments.");
    return lockedReview(verifyRecordForWorkItem(
      record,
      assignment.workItem,
      recordValidationForArtifact(plan, assignment.artifactId),
    ));
  });
  const unsigned = reviewLedgerWithoutRootSchema.parse({
    ...ledgerProjection(ledger),
    phase: "classifiable",
    adjudicationLocks: locks,
  });
  return reviewLedgerSchema.parse({ ...unsigned, ledgerRoot: computeReviewLedgerRoot(unsigned) });
}

function authorOutcomeFailureClass(outcome: AttemptAuthorOutcome): typeof FROZEN_PRIMARY_FAILURE_CLASSES[number] | null {
  if (outcome === "completed") return null;
  if (outcome === "infra_failure") return "FAIL_INFRASTRUCTURE";
  if (outcome === "policy_violation") return "FAIL_PROTOCOL_VIOLATION";
  return "FAIL_AUTHOR_NONCOMPLETION";
}

function primaryClassByPrecedence(classes: readonly z.infer<typeof primaryFailureClassSchema>[]) {
  return [...classes].sort((left, right) => FROZEN_PRIMARY_FAILURE_CLASSES.indexOf(left) - FROZEN_PRIMARY_FAILURE_CLASSES.indexOf(right))[0];
}

export function finalizeArtifactClassifications(planInput: BlindedReviewPlan, ledgerInput: ReviewLedger): ClassificationBook {
  verifyReviewLedger(planInput, ledgerInput);
  const plan = blindedReviewPlanSchema.parse(planInput);
  const ledger = reviewLedgerSchema.parse(ledgerInput);
  if (ledger.phase !== "classifiable") throw new Error("All required adjudications must lock before classifications can finalize.");
  if (ledger.adjudicationLocks.length !== ledger.adjudicationAssignments.length) throw new Error("Adjudication denominator is incomplete.");
  const assignmentArtifacts = new Set(ledger.adjudicationAssignments.map((assignment) => assignment.artifactId));
  if (ledger.adjudicationLocks.some((lock) => !assignmentArtifacts.has(lock.artifactId))) throw new Error("Selective adjudication is forbidden.");

  const classifications = plan.artifacts.map((artifact) => {
    const primaryLocks = ledger.primaryLocks.filter((lock) => lock.artifactId === artifact.artifactId);
    const scorerFailed = primaryLocks.some((lock) => lock.record.status === "failed");
    const disagreement = !scorerFailed && primaryLocks[0].accepted !== primaryLocks[1].accepted;
    const primaryFailureClasses = primaryLocks.map((lock) => lock.primaryFailureClass) as [
      z.infer<typeof primaryFailureClassSchema>,
      z.infer<typeof primaryFailureClassSchema>,
    ];
    const primaryClassAgreement = primaryFailureClasses[0] === primaryFailureClasses[1];
    const adjudication = ledger.adjudicationLocks.find((lock) => lock.artifactId === artifact.artifactId) ?? null;
    if (disagreement !== (adjudication !== null)) throw new Error("Binary disagreement and adjudication coverage do not reconcile.");
    const reviewAccepted = scorerFailed ? false : adjudication?.accepted ?? primaryLocks[0].accepted;
    const authorFailureClass = authorOutcomeFailureClass(artifact.authorOutcome);
    const accepted = authorFailureClass === null && reviewAccepted;
    const reviewClass = scorerFailed
      ? "FAIL_EVALUATOR_SCORER"
      : adjudication?.primaryFailureClass
        ?? primaryClassByPrecedence(primaryLocks.map((lock) => lock.primaryFailureClass));
    return artifactClassificationSchema.parse({
      artifactId: artifact.artifactId,
      attemptId: artifact.attemptId,
      taskId: artifact.taskId,
      authorOutcome: artifact.authorOutcome,
      accepted,
      reviewAccepted,
      primaryFailureClass: authorFailureClass ?? reviewClass,
      primaryFailureClasses,
      primaryClassAgreement,
      resolution: authorFailureClass !== null
        ? "author_outcome_override"
        : scorerFailed
          ? "primary_scorer_failure"
          : disagreement
            ? "binary_adjudication"
            : primaryClassAgreement
              ? "primary_agreement"
              : "frozen_precedence_without_adjudication",
      primaryRecordSha256s: primaryLocks.map((lock) => lock.recordSha256),
      adjudicationRecordSha256: adjudication?.recordSha256 ?? null,
    });
  });
  const attemptIds = classifications.map((classification) => classification.attemptId);
  if (classifications.length !== plan.denominator || new Set(attemptIds).size !== plan.denominator) {
    throw new Error("Locked classifications do not reconcile exactly to the all-attempt denominator.");
  }
  const unsigned = classificationBookWithoutRootSchema.parse({
    schemaVersion: 1,
    planRoot: plan.planRoot,
    ledgerRoot: ledger.ledgerRoot,
    registryRoot: plan.registryRoot,
    denominator: plan.denominator,
    classifications,
  });
  return classificationBookSchema.parse({ ...unsigned, classificationRoot: computeClassificationRoot(unsigned) });
}

export function authorizePairwiseView(
  bookInput: ClassificationBook,
  artifactIds: readonly [string, string],
  authorizedAt: string,
): { schemaVersion: 1; artifactIds: readonly [string, string]; classificationRoot: string; authorizedAt: string; authorizationDigest: string } {
  const book = classificationBookSchema.parse(bookInput);
  if (computeClassificationRoot(book) !== book.classificationRoot || book.classifications.length !== book.denominator) {
    throw new Error("Pairwise view is forbidden before the full individual-classification denominator locks.");
  }
  const at = timestampSchema.parse(authorizedAt);
  if (artifactIds[0] === artifactIds[1] || artifactIds.some((artifactId) => !book.classifications.some((item) => item.artifactId === artifactId))) {
    throw new Error("Pairwise view requires two distinct locked opaque artifacts.");
  }
  const payload = {
    schemaVersion: 1 as const,
    artifactIds: [opaqueIdSchema.parse(artifactIds[0]), opaqueIdSchema.parse(artifactIds[1])] as const,
    classificationRoot: book.classificationRoot,
    authorizedAt: at,
  };
  return { ...payload, authorizationDigest: hashCanonicalJson(payload) };
}
