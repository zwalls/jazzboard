import { z } from "zod";

import { attemptRegistrySchema, type AttemptAuthorOutcome, type AttemptRegistry } from "./attempt-schemas";
import { canonicalJson, hashCanonicalJson, SHA256_DIGEST_PATTERN, sha256Digest } from "./provenance-crypto";
import { verifyAttemptRegistry } from "./provenance-verification";

const stableIdSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z.string().datetime({ offset: true });
const bareSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
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
  outputUsdPerMillionTokens: z.number().finite().nonnegative(),
  source: stableIdSchema,
}).strict();

export const evaluatorArtifactSourceSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: stableIdSchema,
  attemptDirectory: z.string().trim().min(1).max(2_048),
  attemptBundleSha256: bareSha256Schema,
  artifactRootSha256: bareSha256Schema,
  evaluatorAuthorEvidenceRootSha256: bareSha256Schema,
  registryAuthorEvidenceRoot: digestSchema,
  rubricSha256: digestSchema,
  authorIdentityCommitment: digestSchema,
}).strict();

export const reviewerRosterEntrySchema = z.object({
  reviewerId: opaqueIdSchema,
  identityCommitment: digestSchema,
}).strict();

export const blindedReviewPolicySchema = z.object({
  schemaVersion: z.literal(1),
  assignmentSeed: digestSchema,
  model: opaqueIdSchema,
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
  inputTokenBudget: z.number().int().min(1).max(1_000_000),
  outputTokenBudget: z.number().int().min(256).max(100_000),
  pricing: pricingSchema,
  outputDirectory: z.string().trim().min(1).max(2_048),
  createdAt: timestampSchema,
}).strict();

export const evaluatorRunnerConfigSchema = z.object({
  attemptDirectory: z.string().trim().min(1),
  expectedAttemptBundleSha256: bareSha256Schema,
  expectedArtifactRoot: bareSha256Schema,
  expectedAuthorEvidenceRoot: bareSha256Schema,
  taskId: stableIdSchema,
  expectedRubricSha256: digestSchema,
  reviewerId: opaqueIdSchema,
  reviewerRole: z.enum(["primary", "adjudicator"]),
  model: opaqueIdSchema,
  reasoningEffort: blindedReviewPolicySchema.shape.reasoningEffort,
  inputTokenBudget: blindedReviewPolicySchema.shape.inputTokenBudget,
  outputTokenBudget: blindedReviewPolicySchema.shape.outputTokenBudget,
  pricing: pricingSchema,
  outputDirectory: z.string().trim().min(1),
}).strict();

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
  evidence: evaluatorArtifactSourceSchema.omit({ schemaVersion: true, attemptId: true, authorIdentityCommitment: true }),
  primaryReviewerIds: z.tuple([opaqueIdSchema, opaqueIdSchema]),
  primaryWorkItems: z.tuple([reviewerWorkItemSchema, reviewerWorkItemSchema]),
}).strict();

const blindedReviewPlanWithoutRootSchema = z.object({
  schemaVersion: z.literal(1),
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
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict();

const evaluatorEvidenceSchema = z.object({
  attemptBundleSha256: bareSha256Schema,
  artifactRoot: bareSha256Schema,
  authorEvidenceRoot: bareSha256Schema,
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
  configSha256: bareSha256Schema,
  budgets: z.object({ inputTokens: z.number().int().positive(), outputTokens: z.number().int().positive() }).strict(),
  pricing: pricingSchema,
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
    responseIdSha256: bareSha256Schema.nullable(),
    usage: usageSchema.nullable(),
    estimatedCostUsd: z.number().finite().nonnegative(),
  }).strict(),
  accepted: z.boolean(),
  primaryFailureClass: primaryFailureClassSchema,
  result: z.object({
    accepted: z.boolean(),
    primaryFailureClass: primaryFailureClassSchema,
  }).passthrough().nullable(),
  failure: z.object({ stage: stableIdSchema, code: stableIdSchema, message: z.string().trim().min(1).max(1_000) }).strict().nullable(),
  recordSha256: bareSha256Schema,
}).strict().superRefine((record, context) => {
  if (record.status === "scored" && (record.result === null || record.failure !== null || record.evidence === null)) {
    context.addIssue({ code: "custom", message: "Scored records require result and evidence and cannot carry a failure." });
  }
  if (record.status === "scored" && record.evidence?.rubricSha256 === null) {
    context.addIssue({ code: "custom", message: "Scored records require a verified rubric digest." });
  }
  if (record.status === "failed" && (record.result !== null || record.failure === null || record.accepted)) {
    context.addIssue({ code: "custom", message: "Failed records require a failure, no result, and non-acceptance." });
  }
  if ((record.primaryFailureClass === "SUCCESS") !== record.accepted) {
    context.addIssue({ code: "custom", message: "SUCCESS must exactly match acceptance." });
  }
  if (record.result) {
    if (record.result.accepted !== record.accepted || record.result.primaryFailureClass !== record.primaryFailureClass) {
      context.addIssue({ code: "custom", message: "Top-level decision must match the structured result." });
    }
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
  resolution: z.enum(["primary_agreement", "binary_adjudication", "author_outcome_override"]),
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

function bareHash(value: unknown): string {
  return sha256Digest(canonicalJson(value)).slice("sha256:".length);
}

function safeConfigCommitment(config: EvaluatorRunnerConfig) {
  return {
    expectedAttemptBundleSha256: config.expectedAttemptBundleSha256,
    expectedArtifactRoot: config.expectedArtifactRoot,
    expectedAuthorEvidenceRoot: config.expectedAuthorEvidenceRoot,
    taskId: config.taskId,
    expectedRubricSha256: config.expectedRubricSha256,
    reviewerId: config.reviewerId,
    reviewerRole: config.reviewerRole,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    inputTokenBudget: config.inputTokenBudget,
    outputTokenBudget: config.outputTokenBudget,
    pricing: config.pricing,
  };
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
): EvaluatorRunnerConfig {
  return evaluatorRunnerConfigSchema.parse({
    attemptDirectory: source.attemptDirectory,
    expectedAttemptBundleSha256: source.attemptBundleSha256,
    expectedArtifactRoot: source.artifactRootSha256,
    expectedAuthorEvidenceRoot: source.evaluatorAuthorEvidenceRootSha256,
    taskId,
    expectedRubricSha256: source.rubricSha256,
    reviewerId,
    reviewerRole,
    model: policy.model,
    reasoningEffort: policy.reasoningEffort,
    inputTokenBudget: policy.inputTokenBudget,
    outputTokenBudget: policy.outputTokenBudget,
    pricing: policy.pricing,
    outputDirectory: policy.outputDirectory,
  });
}

function workItem(
  source: EvaluatorArtifactSource,
  taskId: string,
  reviewerId: string,
  reviewerRole: "primary" | "adjudicator",
  policy: BlindedReviewPolicy,
): ReviewerWorkItem {
  const config = evaluatorConfig(source, taskId, reviewerId, reviewerRole, policy);
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
    const artifactId = `artifact-${source.attemptBundleSha256.slice(0, 24)}`;
    const eligible = eligibleReviewers(roster, source, registry.registryRoot, policy.assignmentSeed, "primary");
    if (eligible.length < 3) throw new Error(`Artifact ${artifactId} lacks two primaries plus an independent non-author adjudicator.`);
    const reviewers = eligible.slice(0, 2);
    const primaryWorkItems = reviewers.map((reviewer) => workItem(source, attempt.taskId, reviewer.reviewerId, "primary", policy));
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
      },
      primaryReviewerIds: [reviewers[0].reviewerId, reviewers[1].reviewerId],
      primaryWorkItems,
    });
  });
  if (new Set(artifacts.map((artifact) => artifact.artifactId)).size !== artifacts.length) throw new Error("Opaque artifact IDs collide.");
  const unsigned = blindedReviewPlanWithoutRootSchema.parse({
    schemaVersion: 1,
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
      schemaVersion: 1,
      attemptId: artifact.attemptId,
      authorIdentityCommitment: artifact.authorIdentityCommitment,
      ...artifact.evidence,
    });
    const expected = eligibleReviewers(roster, source, plan.registryRoot, plan.policy.assignmentSeed, "primary").slice(0, 2).map((reviewer) => reviewer.reviewerId);
    if (canonicalJson(expected) !== canonicalJson(artifact.primaryReviewerIds)) throw new Error(`Artifact ${artifact.artifactId} reviewer assignment drifted.`);
    artifact.primaryWorkItems.forEach((item, index) => {
      const expectedItem = workItem(source, artifact.taskId, artifact.primaryReviewerIds[index], "primary", plan.policy);
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

function verifyRecordForWorkItem(rawRecord: LockedEvaluatorRecord, item: ReviewerWorkItem): LockedEvaluatorRecord {
  const record = lockedEvaluatorRecordSchema.parse(rawRecord);
  if (computeEvaluatorRecordSha256(record) !== record.recordSha256) throw new Error("Evaluator result record hash is invalid.");
  if (record.artifactId !== item.artifactId || record.taskId !== item.evaluatorConfig.taskId
      || record.reviewer.id !== item.reviewerId || record.reviewer.role !== item.reviewerRole) {
    throw new Error("Evaluator result does not belong to its assigned blinded work item.");
  }
  if (record.configSha256 !== item.evaluatorConfigSha256) throw new Error("Evaluator result configuration commitment drifted.");
  if (record.budgets.inputTokens !== item.evaluatorConfig.inputTokenBudget
      || record.budgets.outputTokens !== item.evaluatorConfig.outputTokenBudget
      || canonicalJson(record.pricing) !== canonicalJson(item.evaluatorConfig.pricing)
      || record.provider.modelRequested !== item.evaluatorConfig.model) {
    throw new Error("Evaluator result configuration fields drifted.");
  }
  if (record.evidence !== null && (
    record.evidence.attemptBundleSha256 !== item.evaluatorConfig.expectedAttemptBundleSha256
    || record.evidence.artifactRoot !== item.evaluatorConfig.expectedArtifactRoot
    || record.evidence.authorEvidenceRoot !== item.evaluatorConfig.expectedAuthorEvidenceRoot
    || (record.evidence.rubricSha256 !== null
      && `sha256:${record.evidence.rubricSha256}` !== item.evaluatorConfig.expectedRubricSha256)
  )) throw new Error("Evaluator result evidence commitments drifted.");
  if (record.status === "scored" && record.result !== null && record.hashes.outputSha256 !== bareHash(record.result)) {
    throw new Error("Evaluator structured result hash is invalid.");
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
    return lockedReview(verifyRecordForWorkItem(record, item));
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
    const record = verifyRecordForWorkItem(lock.record, item);
    if (lock.recordSha256 !== record.recordSha256 || lock.lockedAt !== record.lockedAt
        || lock.accepted !== record.accepted || lock.primaryFailureClass !== record.primaryFailureClass
        || lock.reviewerId !== record.reviewer.id || lock.artifactId !== record.artifactId) {
      throw new Error("Review ledger contains an invalid primary lock summary.");
    }
  }
  const disagreements = new Set(plan.artifacts.flatMap((artifact) => {
    const locks = ledger.primaryLocks.filter((lock) => lock.artifactId === artifact.artifactId);
    return locks[0].accepted === locks[1].accepted ? [] : [artifact.artifactId];
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
      schemaVersion: 1,
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
    const expectedItem = workItem(source, artifact.taskId, reviewer.reviewerId, "adjudicator", plan.policy);
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
    const record = verifyRecordForWorkItem(lock.record, assignment.workItem);
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
    if (primaryLocks[0].accepted === primaryLocks[1].accepted) return [];
    const source = evaluatorArtifactSourceSchema.parse({
      schemaVersion: 1,
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
    const item = workItem(source, artifact.taskId, reviewer.reviewerId, "adjudicator", plan.policy);
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
    return lockedReview(verifyRecordForWorkItem(record, assignment.workItem));
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
    const disagreement = primaryLocks[0].accepted !== primaryLocks[1].accepted;
    const adjudication = ledger.adjudicationLocks.find((lock) => lock.artifactId === artifact.artifactId) ?? null;
    if (disagreement !== (adjudication !== null)) throw new Error("Binary disagreement and adjudication coverage do not reconcile.");
    const reviewAccepted = adjudication?.accepted ?? primaryLocks[0].accepted;
    const authorFailureClass = authorOutcomeFailureClass(artifact.authorOutcome);
    const accepted = authorFailureClass === null && reviewAccepted;
    const reviewClass = adjudication?.primaryFailureClass
      ?? primaryClassByPrecedence(primaryLocks.map((lock) => lock.primaryFailureClass));
    return artifactClassificationSchema.parse({
      artifactId: artifact.artifactId,
      attemptId: artifact.attemptId,
      taskId: artifact.taskId,
      authorOutcome: artifact.authorOutcome,
      accepted,
      reviewAccepted,
      primaryFailureClass: authorFailureClass ?? reviewClass,
      resolution: authorFailureClass !== null ? "author_outcome_override" : disagreement ? "binary_adjudication" : "primary_agreement",
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
