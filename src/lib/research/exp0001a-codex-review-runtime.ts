import { z } from "zod";

import developmentRubricsJson from "../../../research/benchmarks/development-evaluator-rubrics-v1.json";
import {
  exp0001aCodexAccountingLedgerSchema,
  exp0001aCodexSchedulerStateSchema,
  type Exp0001aCodexAccountingLedger,
  type Exp0001aCodexSchedulerState,
} from "./exp0001a-codex-accounting";
import {
  analyzeExp0001aCodexExperiment,
  type Exp0001aCodexAnalysisReport,
} from "./exp0001a-codex-analysis";
import {
  verifyExp0001aCodexPrebriefFreeze,
  type Exp0001aCodexPrebriefFreeze,
} from "./exp0001a-codex-prebrief-freeze";
import {
  verifyExp0001aAttemptProvisioningPlan,
  type Exp0001aAttemptProvisioningPlanSet,
} from "./exp0001a-attempt-provisioning";
import { renderPublicAuthorBrief } from "./benchmark-execution";
import {
  createExp0001aAdjudicationReviewSubject,
  createExp0001aAdjudicatorTaskEnvelopeFromSubject,
  createExp0001aPairwiseReviewSubject,
  createExp0001aPairwiseVisualJudgeTaskEnvelopeFromSubject,
  createExp0001aPrimaryReviewSubject,
  createExp0001aPrimaryReviewerTaskEnvelopeFromSubject,
  exp0001aAdjudicationReviewSubjectSchema,
  exp0001aCodexTaskEnvelopeSchema,
  exp0001aCodexTaskLifecycleSchema,
  exp0001aPairwiseReviewSubjectSchema,
  exp0001aPrimaryReviewSubjectSchema,
  exp0001aCodexTaskTransportPlanSchema,
  validateExp0001aCodexTerminalJson,
  type Exp0001aAdjudicationReviewSubject,
  type Exp0001aCodexTaskEnvelope,
  type Exp0001aCodexTaskLifecycle,
  type Exp0001aPairwiseReviewSubject,
  type Exp0001aPrimaryReviewSubject,
  type Exp0001aCodexTaskTransportPlan,
} from "./exp0001a-codex-task-transport";
import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";
import {
  developmentExecutionManifestSchema,
  verifyDevelopmentExecutionManifest,
  type DevelopmentExecutionManifest,
} from "./development-manifest";

export const EXP0001A_CODEX_REVIEW_RUNTIME_VERSION = "exp-0001a-codex-review-runtime/v1" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const idSchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z.string().datetime({ offset: true });
const taskFamilySchema = z.enum(["architecture", "drawing"]);
const conditionSchema = z.enum(["A0", "A1"]);
const terminalOutcomeSchema = z.enum([
  "succeeded",
  "needs_attention",
  "usage_limit_interrupted",
  "infra_failure",
  "policy_violation",
  "non_evaluable",
]);
const failureClassSchema = z.enum([
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
]);

const reviewerIdentitySchema = z.object({
  reviewerId: idSchema,
  identityCommitment: digestSchema,
}).strict();
export type Exp0001aCodexReviewerIdentity = z.infer<typeof reviewerIdentitySchema>;

/**
 * Exact reviewer identity commitments retained in the sealed v1 prebrief before
 * any experiment brief was released. The Codex-native v2 transport changes how
 * work is executed, never who was prospectively assigned to review it. Keeping
 * this provider-free projection in executable source makes its root
 * reproducible without importing the retired API/provider configuration.
 */
export const EXP0001A_CODEX_REVIEW_SOURCE = Object.freeze({
  sourceFreezeDigest: "sha256:6c76eafb78fb158527dff5bf6055f2e677e070e15ae65868bbb96d1b6fd21281",
  primaryAssignmentSeed: "sha256:4ff57832530729a69f3d2b8b7f719e4a5fcfb04bc63156e1ec380c8a6063d7ba",
  pairwisePromptDigest: "sha256:be16214a6727b17085ab402bc0d1d5d6177c5f2b0b37d4d2d140f6b8ed011e69",
  primaryReviewerRoster: Object.freeze([
    { reviewerId: "rvw-aa-01", identityCommitment: "sha256:1cfb1c0df2dffc4f35358d88de0cca5c2b31d84d26c5394945c6ab5210ae7303" },
    { reviewerId: "rvw-aa-02", identityCommitment: "sha256:9db22bcb3719a9903c60883f6dd4ba0cfa711d3fc28f33566bb9e435be2ac5c2" },
    { reviewerId: "rvw-aa-03", identityCommitment: "sha256:751a017ce8ce9fb9b9084f7211b513b99979e119f77870e047c4c9af298f82d8" },
    { reviewerId: "rvw-aa-04", identityCommitment: "sha256:683e01cbb6d3655f3815411a2e61887c5836ce999d92b929f5b57af7b078adeb" },
    { reviewerId: "rvw-aa-05", identityCommitment: "sha256:01d00b16ada73bbb1ca22541efdc0f70fd8e17adf262273a5a7c29627f12ca50" },
  ]),
  pairwiseReviewerRoster: Object.freeze([
    { reviewerId: "pairwise-rvw-01", identityCommitment: "sha256:a710473c25f7a1e49d2eecabe70b8f3801acdb130e2c796c682f8a7f5fa180ce" },
    { reviewerId: "pairwise-rvw-02", identityCommitment: "sha256:819f8f159007babacc2c06390fd99edd780ad431fb6c9700a4edb0a0ad5f7aa4" },
    { reviewerId: "pairwise-rvw-03", identityCommitment: "sha256:51822e4f1f414225a4070f0197baa2902ff06ac9438958681352460215da299a" },
    { reviewerId: "pairwise-rvw-04", identityCommitment: "sha256:3da58d190c00ae56cebe0909eb43779c9d4a791c8b1797576917ce2ca05d0ec8" },
    { reviewerId: "pairwise-rvw-05", identityCommitment: "sha256:c89ea9da3a56d31aae0e8535ff568b56dedd2f8d98dad01e0c09d51910fdcdfc" },
    { reviewerId: "pairwise-rvw-06", identityCommitment: "sha256:3f137aca16f67be2a83adc34d849daf587979b4cbac7263620ff3522bda0e7f0" },
    { reviewerId: "pairwise-rvw-07", identityCommitment: "sha256:52461261d2463532e4095c0a080b8f5a2b81565393a7ede5d31e198243a63621" },
    { reviewerId: "pairwise-rvw-08", identityCommitment: "sha256:303521a5105201c4795a3efbef74bbf72a82e994e01fbf5f249c2cb46d151334" },
    { reviewerId: "pairwise-rvw-09", identityCommitment: "sha256:b37223af87142d21a86ad1008a4879d6cc24179a2a830f07249ab84fe54f8718" },
    { reviewerId: "pairwise-rvw-10", identityCommitment: "sha256:309106b7079f8d6eee1676b616e9a21fd4e30effed6ed3387f63f5ec2572fc9c" },
    { reviewerId: "pairwise-rvw-11", identityCommitment: "sha256:5b2b5670cad280aade8680874849bfe0783342be0da5867feda189ee21209fc1" },
    { reviewerId: "pairwise-rvw-12", identityCommitment: "sha256:550b49b1ea6391a5bbad80f69434808f8126c757caf5a2e6bccd13ee5ce56906" },
    { reviewerId: "pairwise-rvw-13", identityCommitment: "sha256:f2ff40cdf60f668fecc0f3f9d39ad24b51225dd72bd5c1d369223fdc62ef4bb6" },
    { reviewerId: "pairwise-rvw-14", identityCommitment: "sha256:5d659e904b69fff26260e5a03b9cf2a0ac82fee927377a532be74894162bf614" },
    { reviewerId: "pairwise-rvw-15", identityCommitment: "sha256:b603faafbc3201c383b15d37ba430979ad6ae11690a2f8e27767f7196fb26224" },
    { reviewerId: "pairwise-rvw-16", identityCommitment: "sha256:3085b1e654bc1fc8b4fe30da1cdac68861852abc9f10fb9f73e540dbf81bc0be" },
    { reviewerId: "pairwise-rvw-17", identityCommitment: "sha256:2602b702bc9eb3519c22560dadc4e2587e83a235afe0ef8728eb6fe5a38a3f8c" },
    { reviewerId: "pairwise-rvw-18", identityCommitment: "sha256:ae2fe977ab46569c3c8b6577bcfc818369e21bc3f79129b77fc2cbab9a07ffce" },
    { reviewerId: "pairwise-rvw-19", identityCommitment: "sha256:6d2cf68cba56e1848bd3811253f888555b39d232325b0f4a6931b20192cceae4" },
    { reviewerId: "pairwise-rvw-20", identityCommitment: "sha256:64ad8dfa55712812909e3a364800d9cf7448dfe19bfd9a5cf446f88210fa66a3" },
    { reviewerId: "pairwise-rvw-21", identityCommitment: "sha256:e7100a52726a94437ec0f22f75c39897abbba578b1835e53a0807ca8292b2141" },
    { reviewerId: "pairwise-rvw-22", identityCommitment: "sha256:88eba5eb05d78659b8a290d251200942dfd12068a288abb9b986ff63f7da5916" },
    { reviewerId: "pairwise-rvw-23", identityCommitment: "sha256:3621014de225cb3ff3774cc220fafb7424910cdbba320ff04d63a4d864966900" },
    { reviewerId: "pairwise-rvw-24", identityCommitment: "sha256:fba31bbfdfcf430aa23cdb3dbd2af67a9f5c1aef94e94f6917b03f1de7fb5137" },
  ]),
} as const);

function primaryEnvelope(input: unknown) {
  const envelope = exp0001aCodexTaskEnvelopeSchema.parse(input);
  if (envelope.role !== "primary_reviewer") throw new Error("EXP0001A_PRIMARY_EVIDENCE_ENVELOPE_REQUIRED");
  return envelope;
}

type PrimaryReviewerEnvelope = ReturnType<typeof primaryEnvelope>;

function successfulPrimaryEnvelope(input: unknown): Extract<PrimaryReviewerEnvelope, {
  kind: "primary-reviewer-task-envelope";
}> {
  const envelope = primaryEnvelope(input);
  if (envelope.kind !== "primary-reviewer-task-envelope") {
    throw new Error("EXP0001A_SUCCESSFUL_PRIMARY_EVIDENCE_ENVELOPE_REQUIRED");
  }
  return envelope;
}

function primarySubjectRoot(envelope: PrimaryReviewerEnvelope): string {
  return envelope.kind === "primary-reviewer-task-envelope"
    ? envelope.evidence.evidenceRoot
    : envelope.failureEvidenceRoot;
}

function reviewEnvelopeDigest(envelope: Exp0001aCodexTaskEnvelope): string {
  return hashCanonicalJson(envelope as unknown as JsonValue);
}

function contentDigest<T extends Record<string, unknown>>(content: T): string {
  return hashCanonicalJson(content as unknown as JsonValue);
}

function terminalPlanLifecycle(
  planInput: unknown,
  lifecycleInput: unknown,
  role: Exp0001aCodexTaskTransportPlan["role"],
): { plan: Exp0001aCodexTaskTransportPlan; lifecycle: Exp0001aCodexTaskLifecycle } {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(planInput);
  const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(lifecycleInput);
  if (plan.role !== role || lifecycle.role !== role || lifecycle.planDigest !== plan.planDigest
      || lifecycle.transportId !== plan.transportId || lifecycle.state !== "terminal"
      || lifecycle.readReceipt === null || lifecycle.readReceipt.outcome !== "retained"
      || lifecycle.readReceipt.tracePolicyReceipt === null
      || lifecycle.readReceipt.tracePolicyReceipt.decision !== "pass") {
    throw new Error(`EXP0001A_${role.toUpperCase()}_TERMINAL_BINDING_INVALID`);
  }
  return { plan, lifecycle };
}

const catalogEntryContentSchema = z.object({
  artifactId: idSchema,
  assignmentId: idSchema,
  attemptId: idSchema,
  pairId: idSchema,
  condition: conditionSchema,
  plannedIndex: z.number().int().min(0).max(47),
  taskId: idSchema,
  taskFamily: taskFamilySchema,
  taskCommitmentDigest: digestSchema,
  authorPlanDigest: digestSchema,
  authorLifecycleDigest: digestSchema,
  authorReadReceiptDigest: digestSchema,
  authorTracePolicyReceiptDigest: digestSchema,
  authorTerminalOutcome: terminalOutcomeSchema,
  independentAuthorArtifactRoot: digestSchema.nullable(),
  artifactComplete: z.boolean(),
  reviewSubject: exp0001aPrimaryReviewSubjectSchema,
  reviewSubjectDigest: digestSchema,
}).strict();

const catalogEntrySchema = catalogEntryContentSchema.extend({ entryDigest: digestSchema }).strict();
export type Exp0001aCodexAuthorArtifactCatalogEntry = z.infer<typeof catalogEntrySchema>;

const catalogContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-author-artifact-catalog/v1"),
  protocolId: z.literal("EXP-0001A"),
  freezeDigest: digestSchema,
  schedulerStateDigest: digestSchema,
  authorCount: z.literal(48),
  entries: z.array(catalogEntrySchema).length(48),
}).strict();

export const exp0001aCodexAuthorArtifactCatalogSchema = catalogContentSchema.extend({
  catalogDigest: digestSchema,
}).strict().superRefine((catalog, context) => {
  const { catalogDigest, ...content } = catalog;
  if (contentDigest(content) !== catalogDigest) {
    context.addIssue({ code: "custom", path: ["catalogDigest"], message: "Author catalog digest is invalid." });
  }
  const ids = new Set<string>();
  const assignments = new Set<string>();
  catalog.entries.forEach((entry, index) => {
    const { entryDigest, ...entryContent } = entry;
    if (contentDigest(entryContent) !== entryDigest) {
      context.addIssue({ code: "custom", path: ["entries", index, "entryDigest"], message: "Author catalog entry digest is invalid." });
    }
    if (ids.has(entry.artifactId) || assignments.has(entry.assignmentId)) {
      context.addIssue({ code: "custom", path: ["entries", index], message: "Author catalog identities must be unique." });
    }
    ids.add(entry.artifactId);
    assignments.add(entry.assignmentId);
    if (entry.plannedIndex !== index || entry.reviewSubject.subjectDigest !== entry.reviewSubjectDigest) {
      context.addIssue({ code: "custom", path: ["entries", index], message: "Author catalog ordering or evidence binding is invalid." });
    }
  });
});
export type Exp0001aCodexAuthorArtifactCatalog = z.infer<typeof exp0001aCodexAuthorArtifactCatalogSchema>;

const frozenRubricManifestSchema = z.object({
  schemaVersion: z.literal(1),
  rubricId: idSchema,
  benchmarkId: z.literal("jazzboard-development-v1"),
  rubrics: z.array(z.object({
    taskId: idSchema,
    domain: taskFamilySchema,
    criteria: z.array(z.object({ criterionId: idSchema }).passthrough()).min(1).max(64),
  }).passthrough()).length(12),
}).passthrough();

/** Exact prospective mechanism vocabulary from frozen failure-taxonomy-v2. */
export const EXP0001A_CODEX_FAILURE_MECHANISM_TAGS = Object.freeze([
  "AUTHOR_REFUSAL", "AUTHOR_ABANDONED", "AUTHOR_BUDGET_EXHAUSTED", "AUTHOR_WRONG_TOOL",
  "AUTHOR_INVALID_INPUT", "AUTHOR_IGNORED_RECEIPT", "AUTHOR_UNSAFE_RETRY", "AUTHOR_FALSE_COMPLETION",
  "TOOL_REGISTRY_MISSING", "TOOL_SCHEMA_MISMATCH", "TOOL_VALID_CALL_ERROR", "TOOL_INCORRECT_RECEIPT",
  "TOOL_PIXEL_UNAVAILABLE", "TOOL_HOST_INCOMPATIBLE", "TX_EXPECTED_STALE_REJECTION", "TX_AMBIGUOUS_COMMIT",
  "TX_ATOMICITY_BREACH", "TX_EXPECTED_LEASE_CONFLICT", "TX_LEASE_BUG", "TX_REVISION_NONMONOTONIC",
  "TX_IDENTITY_BINDING_CORRUPT", "TX_UNRELATED_STATE_CHANGED", "SEM_REQUIRED_ENTITY_MISSING",
  "SEM_LABEL_OR_ROLE_WRONG", "SEM_RELATIONSHIP_MISSING", "SEM_DIRECTION_OR_ENDPOINT_WRONG",
  "SEM_GROUP_OR_BOUNDARY_WRONG", "SEM_REQUIRED_SOURCE_OR_UNCERTAINTY_MISSING", "SEM_EXISTING_INTENT_NOT_PRESERVED",
  "VIS_CLIPPED_OR_OFF_CANVAS", "VIS_TEXT_OVERFLOW_OR_UNREADABLE", "VIS_UNINTENDED_OCCLUSION",
  "VIS_CONNECTOR_CROSSING_OR_ROUTE", "VIS_ALIGNMENT_SPACING_OR_CONTAINMENT", "VIS_WEAK_HIERARCHY_OR_CONTRAST",
  "VIS_RECOGNIZABILITY_OR_COMPOSITION", "VIS_INTENTIONAL_GEOMETRY_MISCATEGORIZED",
  "INSPECT_REQUIRED_SCOPE_OMITTED", "INSPECT_PIXELS_NOT_RECEIVED", "INSPECT_WRONG_OR_STALE_REVISION",
  "INSPECT_FINDING_NOT_GROUNDED", "CORRECTION_NOT_ISSUE_FOCUSED", "CORRECTION_REGRESSED_ACCEPTED_STATE",
  "CORRECTION_NOT_REINSPECTED", "CORRECTION_STAGNATION_LIMIT_BREACHED", "TEMP_DRAFT_LIFECYCLE_MISSING",
  "TEMP_REVEAL_NOT_PROGRESSIVE", "TEMP_COMMIT_BEFORE_PRESENTATION_COMPLETE", "TEMP_DRAFT_AUTHORITATIVE_OVERLAP",
  "TEMP_HANDOFF_NOT_ATOMIC", "TEMP_FINAL_REVISION_NOT_PRESENTED", "TEMP_ACTIVE_PRESENTATION_ALTERED_IN_EVIDENCE",
  "EVAL_CAPTURE_MISSING_OR_CORRUPT", "EVAL_WRONG_REVISION_SCORED", "EVAL_SCORER_NONDETERMINISTIC",
  "EVAL_RUBRIC_AMBIGUOUS", "EVAL_JUDGE_DISAGREEMENT", "EVAL_BLINDING_BREACH",
  "EVAL_ARTIFACT_HASH_MISMATCH", "EVAL_DENOMINATOR_MISMATCH", "INFRA_BROWSER_OR_HOST_CRASH",
  "INFRA_NETWORK_OR_SERVICE_OUTAGE", "INFRA_CAPACITY_OR_QUOTA", "INFRA_MODEL_SERVICE_INTERRUPTION",
  "INFRA_CAPTURE_PIPELINE_FAILURE", "INFRA_CLOCK_OR_TELEMETRY_FAILURE", "PRIV_UNAUTHORIZED_CAPABILITY_OR_ACCESS",
  "PRIV_SECRET_OR_PERSONAL_DATA_EXPOSED", "PRIV_REPOSITORY_OR_ANSWER_ACCESS", "INTEGRITY_HUMAN_WORK_OVERWRITTEN",
  "INTEGRITY_STATE_CORRUPTION_OR_DATA_LOSS", "INTEGRITY_ATTRIBUTION_WRONG", "PROTO_WRONG_COMMIT_OR_CONFIGURATION",
  "PROTO_WRONG_MODEL_HOST_OR_BUDGET", "PROTO_RANDOMIZATION_DEVIATION", "PROTO_FORBIDDEN_AUTHOR_ASSISTANCE",
  "PROTO_FORBIDDEN_MUTATION_PATH", "PROTO_SEALED_DATA_ACCESSED", "PROTO_UNREGISTERED_EXCLUSION_OR_REPLACEMENT",
  "PROTO_POST_OUTCOME_THRESHOLD_CHANGE", "PROTO_ATTEMPT_OR_ARTIFACT_OMITTED",
] as const);

function frozenReviewerRubric(taskId: string, taskFamily: "architecture" | "drawing") {
  const manifest = frozenRubricManifestSchema.parse(developmentRubricsJson);
  const rubric = manifest.rubrics.find((candidate) => candidate.taskId === taskId);
  if (!rubric || rubric.domain !== taskFamily) {
    throw new Error(`EXP0001A_FROZEN_REVIEW_RUBRIC_MISSING:${taskId}`);
  }
  const criterionIds = rubric.criteria.map((criterion) => criterion.criterionId);
  if (new Set(criterionIds).size !== criterionIds.length) {
    throw new Error(`EXP0001A_FROZEN_REVIEW_RUBRIC_CRITERIA_NOT_UNIQUE:${taskId}`);
  }
  return Object.freeze({
    rubricId: manifest.rubricId,
    criterionIds: Object.freeze(criterionIds),
    allowedMechanismTags: EXP0001A_CODEX_FAILURE_MECHANISM_TAGS,
    content: JSON.parse(canonicalJson(rubric)) as JsonValue,
  });
}

export function deriveExp0001aFrozenReviewerSubject(input: Readonly<{
  provisioningPlan: Exp0001aAttemptProvisioningPlanSet;
  assignmentId: string;
}>): Readonly<{
  taskId: string;
  taskFamily: "architecture" | "drawing";
  taskCommitmentDigest: string;
  publicRequirement: string;
  rubric: ReturnType<typeof frozenReviewerRubric>;
  publicAuthorPacketDigest: string;
  attemptPlanDigest: string;
}> {
  const verification = verifyExp0001aAttemptProvisioningPlan(input.provisioningPlan);
  if (!verification.ok) {
    throw new Error(`EXP0001A_REVIEWER_SUBJECT_PROVISIONING_PLAN_INVALID:${verification.errors.join("|")}`);
  }
  const attempt = verification.plan.attempts.find((candidate) => candidate.assignmentId === input.assignmentId);
  if (!attempt) throw new Error(`EXP0001A_REVIEWER_SUBJECT_ASSIGNMENT_MISSING:${input.assignmentId}`);
  return Object.freeze({
    taskId: attempt.taskId,
    taskFamily: attempt.taskFamily,
    taskCommitmentDigest: attempt.taskDigest,
    publicRequirement: renderPublicAuthorBrief(attempt.publicAuthorPacket),
    rubric: frozenReviewerRubric(attempt.taskId, attempt.taskFamily),
    publicAuthorPacketDigest: attempt.publicAuthorPacketDigest,
    attemptPlanDigest: attempt.attemptPlanDigest,
  });
}

/**
 * Seals the exact 48-attempt denominator from retained terminal task evidence.
 * The reviewer-facing envelope intentionally excludes condition, pair, author,
 * repository, and task transcript metadata.
 */
export function sealExp0001aCodexAuthorArtifactCatalog(input: Readonly<{
  freeze: Exp0001aCodexPrebriefFreeze;
  provisioningPlan: Exp0001aAttemptProvisioningPlanSet;
  scheduler: Exp0001aCodexSchedulerState;
  plans: readonly Exp0001aCodexTaskTransportPlan[];
  lifecycles: readonly Exp0001aCodexTaskLifecycle[];
}>): Exp0001aCodexAuthorArtifactCatalog {
  const freeze = verifyExp0001aCodexPrebriefFreeze(input.freeze);
  const planVerification = verifyExp0001aAttemptProvisioningPlan(input.provisioningPlan);
  if (!planVerification.ok) {
    throw new Error(`EXP0001A_AUTHOR_CATALOG_PROVISIONING_PLAN_INVALID:${planVerification.errors.join("|")}`);
  }
  const provisioningPlan = planVerification.plan;
  const scheduler = exp0001aCodexSchedulerStateSchema.parse(input.scheduler);
  if (provisioningPlan.manifestDigest !== freeze.schedule.manifestDigest
      || provisioningPlan.benchmarkBundleDigest !== freeze.schedule.benchmarkBundleDigest
      || provisioningPlan.scheduleDigest !== scheduler.frozenScheduleDigest
      || canonicalJson(provisioningPlan.assignments) !== canonicalJson(scheduler.assignments.map((assignment) => ({
        assignmentId: assignment.assignmentId,
        attemptId: assignment.attemptId,
        pairId: assignment.pairId,
        condition: assignment.condition,
        plannedIndex: assignment.plannedIndex,
        timeBlock: assignment.timeBlock,
        orderInPair: assignment.orderInPair,
      })))) {
    throw new Error("EXP0001A_AUTHOR_CATALOG_FROZEN_PLAN_DRIFT");
  }
  if (scheduler.assignments.length !== 48 || scheduler.assignments.some((assignment) => assignment.state !== "terminal")) {
    throw new Error("EXP0001A_AUTHOR_CATALOG_REQUIRES_48_TERMINAL_ASSIGNMENTS");
  }
  const plans = input.plans.map((plan) => exp0001aCodexTaskTransportPlanSchema.parse(plan));
  const lifecycles = input.lifecycles.map((lifecycle) => exp0001aCodexTaskLifecycleSchema.parse(lifecycle));
  const lifecycleByPlan = new Map(lifecycles.map((lifecycle) => [lifecycle.planDigest, lifecycle]));
  const begunAuthorPlans = plans.filter((plan) => plan.role === "author"
    && lifecycleByPlan.get(plan.planDigest)?.taskBegun === true);
  const planByAssignment = new Map(begunAuthorPlans.map((plan) => [plan.privateBinding.assignmentId, plan]));
  if (planByAssignment.size !== 48 || begunAuthorPlans.length !== 48) {
    throw new Error("EXP0001A_AUTHOR_CATALOG_DENOMINATOR_INVALID");
  }
  const entries = scheduler.assignments.map((assignment, index) => {
    const plan = planByAssignment.get(assignment.assignmentId);
    const lifecycle = plan === undefined ? undefined : lifecycleByPlan.get(plan.planDigest);
    const attempt = provisioningPlan.attempts[index];
    if (!plan || !lifecycle || !attempt) throw new Error(`EXP0001A_AUTHOR_CATALOG_MISSING:${assignment.assignmentId}`);
    if (lifecycle.role !== "author" || lifecycle.planDigest !== plan.planDigest
        || lifecycle.transportId !== plan.transportId || lifecycle.state !== "terminal"
        || !lifecycle.taskBegun || lifecycle.readReceipt === null) {
      throw new Error(`EXP0001A_AUTHOR_TERMINAL_BINDING_INVALID:${assignment.assignmentId}`);
    }
    const frozenSubject = deriveExp0001aFrozenReviewerSubject({
      provisioningPlan,
      assignmentId: assignment.assignmentId,
    });
    if (plan.privateBinding.attemptId !== assignment.attemptId
        || attempt.assignmentId !== assignment.assignmentId
        || attempt.attemptId !== assignment.attemptId
        || attempt.pairId !== assignment.pairId
        || attempt.condition !== assignment.condition
        || attempt.plannedIndex !== assignment.plannedIndex
        || frozenSubject.taskCommitmentDigest !== freeze.schedule.taskCommitments.find((task) => task.taskId === frozenSubject.taskId)?.taskDigest
        || plan.envelope.role !== "author"
        || plan.envelope.publicTaskBrief !== frozenSubject.publicRequirement
        || plan.envelope.provisioningBinding.publicAuthorPacketDigest !== frozenSubject.publicAuthorPacketDigest
        || plan.envelope.provisioningBinding.attemptPlanDigest !== frozenSubject.attemptPlanDigest
        || lifecycle.codexTaskId !== assignment.codexTaskId
        || lifecycle.threadId !== assignment.threadId
        || ((assignment.terminalOutcome === "succeeded") !== (lifecycle.terminalOutcome === "succeeded"))
        || ((assignment.terminalOutcome === "usage_limit_interrupted") !== (lifecycle.terminalOutcome === "usage_limit_interrupted"))) {
      throw new Error(`EXP0001A_AUTHOR_CATALOG_BINDING_INVALID:${assignment.assignmentId}`);
    }
    const subject = createExp0001aPrimaryReviewSubject({
      publicRequirement: frozenSubject.publicRequirement,
      rubric: frozenSubject.rubric,
      authorPlan: plan,
      authorLifecycle: lifecycle,
    });
    const terminalArtifact = lifecycle.readReceipt.terminalArtifact;
    const successful = lifecycle.terminalOutcome === "succeeded";
    if (successful) {
      if (lifecycle.readReceipt.outcome !== "retained"
          || lifecycle.readReceipt.tracePolicyReceipt?.decision !== "pass"
          || terminalArtifact?.kind !== "author-artifact-result"
          || subject.kind !== "primary-review-success-subject"
          || terminalArtifact.semanticStateDigest !== subject.evidence.semanticState.sha256
          || terminalArtifact.canvasImageDigest !== subject.evidence.images.at(-1)?.sha256) {
        throw new Error(`EXP0001A_AUTHOR_CATALOG_INDEPENDENT_ARTIFACT_DRIFT:${assignment.assignmentId}`);
      }
    } else if (terminalArtifact !== null) {
      throw new Error(`EXP0001A_FAILED_AUTHOR_CANNOT_CLAIM_ARTIFACT:${assignment.assignmentId}`);
    }
    const artifactRoot = terminalArtifact?.artifactRoot ?? contentDigest({
      assignmentId: assignment.assignmentId,
      lifecycleDigest: lifecycle.lifecycleDigest,
      evidenceRoot: subject.kind === "primary-review-success-subject" ? subject.evidence.evidenceRoot : subject.failureEvidenceRoot,
      terminalOutcome: lifecycle.terminalOutcome,
    });
    const artifactId = `artifact-${artifactRoot.slice("sha256:".length, "sha256:".length + 24)}`;
    const content = catalogEntryContentSchema.parse({
      artifactId,
      assignmentId: assignment.assignmentId,
      attemptId: assignment.attemptId,
      pairId: assignment.pairId,
      condition: assignment.condition,
      plannedIndex: index,
      taskId: frozenSubject.taskId,
      taskFamily: frozenSubject.taskFamily,
      taskCommitmentDigest: frozenSubject.taskCommitmentDigest,
      authorPlanDigest: plan.planDigest,
      authorLifecycleDigest: lifecycle.lifecycleDigest,
      authorReadReceiptDigest: lifecycle.readReceipt.receiptDigest,
      authorTracePolicyReceiptDigest: lifecycle.readReceipt.tracePolicyReceipt?.receiptDigest
        ?? lifecycle.readReceipt.evidenceDigest,
      authorTerminalOutcome: lifecycle.terminalOutcome,
      independentAuthorArtifactRoot: terminalArtifact?.kind === "author-artifact-result" ? terminalArtifact.artifactRoot : null,
      artifactComplete: successful,
      reviewSubject: subject,
      reviewSubjectDigest: subject.subjectDigest,
    });
    return catalogEntrySchema.parse({ ...content, entryDigest: contentDigest(content) });
  });
  const content = catalogContentSchema.parse({
    schemaVersion: "exp-0001a-codex-author-artifact-catalog/v1",
    protocolId: "EXP-0001A",
    freezeDigest: freeze.freezeDigest,
    schedulerStateDigest: contentDigest(scheduler as unknown as Record<string, unknown>),
    authorCount: 48,
    entries,
  });
  return Object.freeze(exp0001aCodexAuthorArtifactCatalogSchema.parse({
    ...content,
    catalogDigest: contentDigest(content),
  }));
}

export function computeExp0001aPrimaryReviewerRosterRoot(
  rosterInput: readonly Exp0001aCodexReviewerIdentity[],
): string {
  const reviewers = z.array(reviewerIdentitySchema).min(3).parse(rosterInput)
    .slice().sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
  if (new Set(reviewers.map((reviewer) => reviewer.reviewerId)).size !== reviewers.length
      || new Set(reviewers.map((reviewer) => reviewer.identityCommitment)).size !== reviewers.length) {
    throw new Error("EXP0001A_PRIMARY_REVIEWER_ROSTER_NOT_UNIQUE");
  }
  return contentDigest({
    schemaVersion: "exp-0001a-codex-primary-reviewer-roster/v1",
    protocolId: "EXP-0001A",
    semantics: "fresh-isolated-codex-task-identity-commitment",
    reviewers,
  });
}

export function computeExp0001aPairwiseReviewerRosterRoot(
  rosterInput: readonly Exp0001aCodexReviewerIdentity[],
): string {
  const reviewers = z.array(reviewerIdentitySchema).length(24).parse(rosterInput)
    .slice().sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
  if (new Set(reviewers.map((reviewer) => reviewer.reviewerId)).size !== reviewers.length
      || new Set(reviewers.map((reviewer) => reviewer.identityCommitment)).size !== reviewers.length) {
    throw new Error("EXP0001A_PAIRWISE_REVIEWER_ROSTER_NOT_UNIQUE");
  }
  return contentDigest({
    schemaVersion: "exp-0001a-pairwise-reviewer-roster/v1",
    protocolId: "EXP-0001A",
    semantics: "one-fresh-opaque-process-identity-per-pair-not-authentication",
    reviewers,
  });
}

function rankReviewer(seed: string, artifactRoot: string, reviewer: Exp0001aCodexReviewerIdentity, purpose: string): string {
  return contentDigest({ seed, artifactRoot, reviewerIdentity: reviewer.identityCommitment, purpose });
}

const primaryWorkItemContentSchema = z.object({
  workItemId: idSchema,
  assignmentId: idSchema,
  attemptId: idSchema,
  artifactId: idSchema,
  reviewerSlot: z.union([z.literal(0), z.literal(1)]),
  reviewerId: idSchema,
  reviewerIdentityCommitment: digestSchema,
  subjectArtifactRoot: digestSchema,
  subject: exp0001aPrimaryReviewSubjectSchema,
  subjectDigest: digestSchema,
}).strict();
const primaryWorkItemSchema = primaryWorkItemContentSchema.extend({ workItemDigest: digestSchema }).strict();

const primaryWorkOrderContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-primary-review-work-order/v1"),
  protocolId: z.literal("EXP-0001A"),
  freezeDigest: digestSchema,
  authorCatalogDigest: digestSchema,
  assignmentSeed: digestSchema,
  reviewerRosterRoot: digestSchema,
  workItemCount: z.literal(96),
  workItems: z.array(primaryWorkItemSchema).length(96),
}).strict();
export const exp0001aCodexPrimaryReviewWorkOrderSchema = primaryWorkOrderContentSchema.extend({
  workOrderDigest: digestSchema,
}).strict().superRefine((workOrder, context) => {
  const { workOrderDigest, ...content } = workOrder;
  if (contentDigest(content) !== workOrderDigest) {
    context.addIssue({ code: "custom", path: ["workOrderDigest"], message: "Primary work-order digest is invalid." });
  }
  const ids = new Set<string>();
  const byArtifact = new Map<string, number>();
  workOrder.workItems.forEach((item, index) => {
    const { workItemDigest, ...itemContent } = item;
    if (contentDigest(itemContent) !== workItemDigest || item.subject.subjectDigest !== item.subjectDigest) {
      context.addIssue({ code: "custom", path: ["workItems", index], message: "Primary work item is not content-addressed." });
    }
    if (ids.has(item.workItemId) || ids.has(item.assignmentId) || ids.has(item.attemptId)) {
      context.addIssue({ code: "custom", path: ["workItems", index], message: "Primary work identities must be unique." });
    }
    ids.add(item.workItemId); ids.add(item.assignmentId); ids.add(item.attemptId);
    byArtifact.set(item.artifactId, (byArtifact.get(item.artifactId) ?? 0) + 1);
  });
  if (byArtifact.size !== 48 || [...byArtifact.values()].some((count) => count !== 2)) {
    context.addIssue({ code: "custom", path: ["workItems"], message: "Every artifact requires exactly two primary reviews." });
  }
});
export type Exp0001aCodexPrimaryReviewWorkOrder = z.infer<typeof exp0001aCodexPrimaryReviewWorkOrderSchema>;

export function createExp0001aCodexPrimaryReviewWorkOrder(input: Readonly<{
  freeze: Exp0001aCodexPrebriefFreeze;
  catalog: Exp0001aCodexAuthorArtifactCatalog;
  reviewPlanManifest: Exp0001aCodexReviewPlanManifest;
}>): Exp0001aCodexPrimaryReviewWorkOrder {
  const freeze = verifyExp0001aCodexPrebriefFreeze(input.freeze);
  const catalog = exp0001aCodexAuthorArtifactCatalogSchema.parse(input.catalog);
  const reviewPlan = exp0001aCodexReviewPlanManifestSchema.parse(input.reviewPlanManifest);
  if (catalog.freezeDigest !== freeze.freezeDigest) throw new Error("EXP0001A_PRIMARY_WORK_ORDER_FREEZE_DRIFT");
  if (reviewPlan.manifestDigest !== freeze.reviewCommitments.reviewPlanManifestDigest
      || reviewPlan.sourceFreezeDigest !== freeze.reviewCommitments.reviewerIdentityCommitmentsSourceFreezeDigest
      || reviewPlan.primaryAssignmentSeed !== freeze.reviewCommitments.primaryAssignmentSeed) {
    throw new Error("EXP0001A_PRIMARY_REVIEW_PLAN_DRIFT");
  }
  const roster = reviewPlan.primaryReviewerRoster;
  const rosterRoot = computeExp0001aPrimaryReviewerRosterRoot(roster);
  if (rosterRoot !== freeze.reviewCommitments.primaryReviewerRosterRoot) {
    throw new Error("EXP0001A_PRIMARY_REVIEWER_ROSTER_ROOT_DRIFT");
  }
  const workItems = catalog.entries.flatMap((entry) => {
    const ranked = roster.slice().sort((left, right) => rankReviewer(
      freeze.reviewCommitments.primaryAssignmentSeed,
      entry.independentAuthorArtifactRoot ?? entry.entryDigest,
      left,
      "primary",
    ).localeCompare(rankReviewer(
      freeze.reviewCommitments.primaryAssignmentSeed,
      entry.independentAuthorArtifactRoot ?? entry.entryDigest,
      right,
      "primary",
    )) || left.reviewerId.localeCompare(right.reviewerId)).slice(0, 2);
    return ranked.map((reviewer, reviewerSlot) => {
      const suffix = contentDigest({ artifactId: entry.artifactId, reviewerSlot, reviewer: reviewer.identityCommitment })
        .slice("sha256:".length, "sha256:".length + 20);
      const content = primaryWorkItemContentSchema.parse({
        workItemId: `primary-work-${suffix}`,
        assignmentId: `primary-assignment-${suffix}`,
        attemptId: `primary-attempt-${suffix}`,
        artifactId: entry.artifactId,
        reviewerSlot,
        reviewerId: reviewer.reviewerId,
        reviewerIdentityCommitment: reviewer.identityCommitment,
        subjectArtifactRoot: entry.reviewSubject.kind === "primary-review-success-subject"
          ? entry.reviewSubject.evidence.evidenceRoot : entry.reviewSubject.failureEvidenceRoot,
        subject: entry.reviewSubject,
        subjectDigest: entry.reviewSubjectDigest,
      });
      return primaryWorkItemSchema.parse({ ...content, workItemDigest: contentDigest(content) });
    });
  });
  const content = primaryWorkOrderContentSchema.parse({
    schemaVersion: "exp-0001a-codex-primary-review-work-order/v1",
    protocolId: "EXP-0001A",
    freezeDigest: freeze.freezeDigest,
    authorCatalogDigest: catalog.catalogDigest,
    assignmentSeed: freeze.reviewCommitments.primaryAssignmentSeed,
    reviewerRosterRoot: rosterRoot,
    workItemCount: 96,
    workItems,
  });
  return Object.freeze(exp0001aCodexPrimaryReviewWorkOrderSchema.parse({
    ...content,
    workOrderDigest: contentDigest(content),
  }));
}

const reviewResultEntryContentSchema = z.object({
  workItemId: idSchema,
  workItemDigest: digestSchema,
  assignmentId: idSchema,
  attemptId: idSchema,
  artifactId: idSchema,
  reviewerId: idSchema,
  reviewerIdentityCommitment: digestSchema,
  reviewerTaskBindingDigest: digestSchema,
  planDigest: digestSchema,
  lifecycleDigest: digestSchema,
  readReceiptDigest: digestSchema,
  tracePolicyReceiptDigest: digestSchema.nullable(),
  independentResultArtifactRoot: digestSchema.nullable(),
  terminalResultDigest: digestSchema.nullable(),
  terminalOutcome: terminalOutcomeSchema,
  resultStatus: z.enum(["scored", "failed"]),
  terminalJson: z.json().nullable(),
  terminalJsonDigest: digestSchema.nullable(),
  accepted: z.boolean(),
  primaryFailureClass: failureClassSchema,
}).strict();
const reviewResultEntrySchema = reviewResultEntryContentSchema.extend({ resultEntryDigest: digestSchema }).strict();
export type Exp0001aCodexReviewResultEntry = z.infer<typeof reviewResultEntrySchema>;

const primaryResultLedgerContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-primary-review-result-ledger/v1"),
  protocolId: z.literal("EXP-0001A"),
  workOrderDigest: digestSchema,
  resultCount: z.literal(96),
  results: z.array(reviewResultEntrySchema).length(96),
}).strict();
export const exp0001aCodexPrimaryReviewResultLedgerSchema = primaryResultLedgerContentSchema.extend({
  resultLedgerDigest: digestSchema,
}).strict().superRefine((ledger, context) => {
  const { resultLedgerDigest, ...content } = ledger;
  if (contentDigest(content) !== resultLedgerDigest) {
    context.addIssue({ code: "custom", path: ["resultLedgerDigest"], message: "Primary result-ledger digest is invalid." });
  }
  const ids = new Set<string>();
  ledger.results.forEach((result, index) => {
    const { resultEntryDigest, ...entryContent } = result;
    if (contentDigest(entryContent) !== resultEntryDigest || ids.has(result.workItemId)) {
      context.addIssue({ code: "custom", path: ["results", index], message: "Primary result entry is invalid or duplicated." });
    }
    ids.add(result.workItemId);
  });
});
export type Exp0001aCodexPrimaryReviewResultLedger = z.infer<typeof exp0001aCodexPrimaryReviewResultLedgerSchema>;

function collectReviewResults(input: Readonly<{
  role: "primary_reviewer" | "adjudicator" | "pairwise_visual_judge";
  workItems: ReadonlyArray<{
    workItemId: string;
    workItemDigest: string;
    assignmentId: string;
    attemptId: string;
    artifactId: string;
    reviewerId: string;
    reviewerIdentityCommitment: string;
    envelope?: Exp0001aCodexTaskEnvelope;
    envelopeDigest?: string;
    subject?: Exp0001aPrimaryReviewSubject | Exp0001aAdjudicationReviewSubject;
    subjectDigest?: string;
  }>;
  plans: readonly Exp0001aCodexTaskTransportPlan[];
  lifecycles: readonly Exp0001aCodexTaskLifecycle[];
}>): Exp0001aCodexReviewResultEntry[] {
  const allPlans = input.plans.map((plan) => exp0001aCodexTaskTransportPlanSchema.parse(plan))
    .filter((plan) => plan.role === input.role);
  const lifecycles = input.lifecycles.map((lifecycle) => exp0001aCodexTaskLifecycleSchema.parse(lifecycle));
  const lifecycleByPlan = new Map(lifecycles.map((lifecycle) => [lifecycle.planDigest, lifecycle]));
  const begunPlans = allPlans.filter((plan) => lifecycleByPlan.get(plan.planDigest)?.taskBegun === true);
  const planByAssignment = new Map(begunPlans.map((plan) => [plan.privateBinding.assignmentId, plan]));
  if (planByAssignment.size !== input.workItems.length || begunPlans.length !== input.workItems.length) {
    throw new Error(`EXP0001A_${input.role.toUpperCase()}_RESULT_DENOMINATOR_INVALID`);
  }
  return input.workItems.map((item) => {
    const plan = planByAssignment.get(item.assignmentId);
    const lifecycle = plan === undefined ? undefined : lifecycleByPlan.get(plan.planDigest);
    if (!plan || !lifecycle) {
      throw new Error(`EXP0001A_${input.role.toUpperCase()}_RESULT_MISSING:${item.workItemId}`);
    }
    const expectedEnvelope = item.subject === undefined
      ? item.envelope
      : item.subject.kind === "adjudication-review-subject"
        ? createExp0001aAdjudicatorTaskEnvelopeFromSubject({
          subject: item.subject,
          artifactPacketOrigin: plan.envelope.role === "adjudicator" ? plan.envelope.artifactPacket.origin : "",
        })
        : createExp0001aPrimaryReviewerTaskEnvelopeFromSubject({
          subject: item.subject,
          artifactPacketOrigin: plan.envelope.role === "primary_reviewer" ? plan.envelope.artifactPacket.origin : "",
        });
    const expectedEnvelopeDigest = expectedEnvelope === undefined ? undefined : reviewEnvelopeDigest(expectedEnvelope);
    if (plan.privateBinding.attemptId !== item.attemptId
        || canonicalJson(plan.privateBinding.subjectArtifactIds) !== canonicalJson([item.artifactId])
        || expectedEnvelope === undefined
        || plan.envelopeDigest !== expectedEnvelopeDigest
        || canonicalJson(plan.envelope) !== canonicalJson(expectedEnvelope)
        || lifecycle.role !== input.role || lifecycle.planDigest !== plan.planDigest
        || lifecycle.transportId !== plan.transportId
        || lifecycle.state !== "terminal" || !lifecycle.taskBegun || lifecycle.readReceipt === null) {
      throw new Error(`EXP0001A_${input.role.toUpperCase()}_RESULT_BINDING_INVALID:${item.workItemId}`);
    }
    const rawResult = lifecycle.readReceipt.terminalJson;
    const scored = lifecycle.terminalOutcome === "succeeded";
    if (scored !== (rawResult !== null)) {
      throw new Error(`EXP0001A_${input.role.toUpperCase()}_CANONICAL_FAILURE_RECORD_INVALID:${item.workItemId}`);
    }
    const result = rawResult === null ? null : validateExp0001aCodexTerminalJson(plan, rawResult);
    const authorFailureReview = input.role === "primary_reviewer"
      && plan.envelope.role === "primary_reviewer"
      && plan.envelope.kind === "primary-reviewer-author-failure-task-envelope";
    const decision = z.object({
      role: z.enum(["primary_reviewer", "adjudicator"]),
      accepted: z.boolean(),
      primaryFailureClass: failureClassSchema,
    }).passthrough().safeParse(result);
    if (scored && (input.role === "primary_reviewer" || input.role === "adjudicator")
        && !authorFailureReview
        && (!decision.success || decision.data.role !== input.role)) {
      throw new Error(`EXP0001A_${input.role.toUpperCase()}_RESULT_ROLE_INVALID:${item.workItemId}`);
    }
    if (!scored && decision.success) {
      throw new Error(`EXP0001A_${input.role.toUpperCase()}_FAILED_RESULT_CANNOT_SCORE:${item.workItemId}`);
    }
    if (input.role === "pairwise_visual_judge") {
      throw new Error("EXP0001A_PAIRWISE_RESULTS_REQUIRE_PAIRWISE_LEDGER");
    }
    const terminalArtifact = lifecycle.readReceipt.terminalArtifact;
    const expectedKind = input.role === "primary_reviewer" ? "primary-review-result" : "adjudication-result";
    if (scored && (lifecycle.readReceipt.outcome !== "retained"
        || lifecycle.readReceipt.tracePolicyReceipt?.decision !== "pass"
        || terminalArtifact?.kind !== expectedKind
        || terminalArtifact.codexTaskId !== lifecycle.codexTaskId
        || terminalArtifact.resultDigest !== hashCanonicalJson(result as unknown as JsonValue)
        || terminalArtifact.subjectEvidenceRoot !== (plan.envelope.role === "primary_reviewer"
          ? primarySubjectRoot(plan.envelope)
          : plan.envelope.role === "adjudicator" ? plan.envelope.adjudicationSubjectRoot : ""))) {
      throw new Error(`EXP0001A_${input.role.toUpperCase()}_INDEPENDENT_RESULT_DRIFT:${item.workItemId}`);
    }
    if (!scored && terminalArtifact !== null) {
      throw new Error(`EXP0001A_${input.role.toUpperCase()}_FAILED_RESULT_CANNOT_CLAIM_ARTIFACT:${item.workItemId}`);
    }
    const failureClass = lifecycle.terminalOutcome === "policy_violation"
      ? "FAIL_PROTOCOL_VIOLATION" as const
      : lifecycle.terminalOutcome === "infra_failure" || lifecycle.terminalOutcome === "usage_limit_interrupted"
        ? "FAIL_INFRASTRUCTURE" as const
        : "FAIL_EVALUATOR_SCORER" as const;
    const content = reviewResultEntryContentSchema.parse({
      workItemId: item.workItemId,
      workItemDigest: item.workItemDigest,
      assignmentId: item.assignmentId,
      attemptId: item.attemptId,
      artifactId: item.artifactId,
      reviewerId: item.reviewerId,
      reviewerIdentityCommitment: item.reviewerIdentityCommitment,
      reviewerTaskBindingDigest: contentDigest({
        reviewerIdentityCommitment: item.reviewerIdentityCommitment,
        codexTaskId: lifecycle.codexTaskId,
        threadId: lifecycle.threadId,
        hostId: lifecycle.hostId,
        planDigest: plan.planDigest,
      }),
      planDigest: plan.planDigest,
      lifecycleDigest: lifecycle.lifecycleDigest,
      readReceiptDigest: lifecycle.readReceipt!.receiptDigest,
      tracePolicyReceiptDigest: lifecycle.readReceipt.tracePolicyReceipt?.receiptDigest ?? null,
      independentResultArtifactRoot: terminalArtifact?.artifactRoot ?? null,
      terminalResultDigest: lifecycle.readReceipt.terminalResultDigest,
      terminalOutcome: lifecycle.terminalOutcome,
      resultStatus: scored ? "scored" : "failed",
      terminalJson: result as JsonValue | null,
      terminalJsonDigest: result === null ? null : hashCanonicalJson(result as unknown as JsonValue),
      accepted: authorFailureReview ? false : decision.success ? decision.data.accepted : false,
      primaryFailureClass: authorFailureReview
        ? "FAIL_AUTHOR_NONCOMPLETION"
        : decision.success ? decision.data.primaryFailureClass : failureClass,
    });
    return reviewResultEntrySchema.parse({ ...content, resultEntryDigest: contentDigest(content) });
  });
}

export function recordExp0001aCodexPrimaryReviewResults(input: Readonly<{
  workOrder: Exp0001aCodexPrimaryReviewWorkOrder;
  plans: readonly Exp0001aCodexTaskTransportPlan[];
  lifecycles: readonly Exp0001aCodexTaskLifecycle[];
}>): Exp0001aCodexPrimaryReviewResultLedger {
  const workOrder = exp0001aCodexPrimaryReviewWorkOrderSchema.parse(input.workOrder);
  const results = collectReviewResults({
    role: "primary_reviewer",
    workItems: workOrder.workItems,
    plans: input.plans,
    lifecycles: input.lifecycles,
  });
  const content = primaryResultLedgerContentSchema.parse({
    schemaVersion: "exp-0001a-codex-primary-review-result-ledger/v1",
    protocolId: "EXP-0001A",
    workOrderDigest: workOrder.workOrderDigest,
    resultCount: 96,
    results,
  });
  return Object.freeze(exp0001aCodexPrimaryReviewResultLedgerSchema.parse({
    ...content,
    resultLedgerDigest: contentDigest(content),
  }));
}

export function verifyExp0001aCodexPrimaryReviewResults(input: Readonly<{
  workOrder: Exp0001aCodexPrimaryReviewWorkOrder;
  resultLedger: unknown;
}>): Exp0001aCodexPrimaryReviewResultLedger {
  const workOrder = exp0001aCodexPrimaryReviewWorkOrderSchema.parse(input.workOrder);
  const ledger = exp0001aCodexPrimaryReviewResultLedgerSchema.parse(input.resultLedger);
  if (ledger.workOrderDigest !== workOrder.workOrderDigest
      || ledger.results.some((result, index) => {
        const item = workOrder.workItems[index];
        return item === undefined || result.workItemId !== item.workItemId
          || result.workItemDigest !== item.workItemDigest
          || result.assignmentId !== item.assignmentId
          || result.attemptId !== item.attemptId
          || result.artifactId !== item.artifactId
          || result.reviewerId !== item.reviewerId
          || result.reviewerIdentityCommitment !== item.reviewerIdentityCommitment;
      })) {
    throw new Error("EXP0001A_PRIMARY_RESULT_WORK_ORDER_DRIFT");
  }
  return Object.freeze(ledger);
}

const adjudicationWorkItemContentSchema = z.object({
  workItemId: idSchema,
  assignmentId: idSchema,
  attemptId: idSchema,
  artifactId: idSchema,
  reviewerId: idSchema,
  reviewerIdentityCommitment: digestSchema,
  subjectArtifactRoot: digestSchema,
  primaryResultEntryDigests: z.tuple([digestSchema, digestSchema]),
  primaryTerminalJson: z.tuple([z.json().nullable(), z.json().nullable()]),
  subject: exp0001aAdjudicationReviewSubjectSchema,
  subjectDigest: digestSchema,
}).strict();
const adjudicationWorkItemSchema = adjudicationWorkItemContentSchema.extend({ workItemDigest: digestSchema }).strict();

const adjudicationWorkOrderContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-adjudication-work-order/v1"),
  protocolId: z.literal("EXP-0001A"),
  freezeDigest: digestSchema,
  authorCatalogDigest: digestSchema,
  primaryWorkOrderDigest: digestSchema,
  primaryResultLedgerDigest: digestSchema,
  trigger: z.literal("binary-primary-acceptance-disagreement-only"),
  reviewerRosterRoot: digestSchema,
  disagreementArtifactIds: z.array(idSchema).max(48),
  workItems: z.array(adjudicationWorkItemSchema).max(48),
}).strict();
export const exp0001aCodexAdjudicationWorkOrderSchema = adjudicationWorkOrderContentSchema.extend({
  workOrderDigest: digestSchema,
}).strict().superRefine((workOrder, context) => {
  const { workOrderDigest, ...content } = workOrder;
  if (contentDigest(content) !== workOrderDigest) {
    context.addIssue({ code: "custom", path: ["workOrderDigest"], message: "Adjudication work-order digest is invalid." });
  }
  const artifacts = new Set(workOrder.workItems.map((item) => item.artifactId));
  if (artifacts.size !== workOrder.workItems.length
      || canonicalJson([...artifacts]) !== canonicalJson(workOrder.disagreementArtifactIds)) {
    context.addIssue({ code: "custom", path: ["disagreementArtifactIds"], message: "Adjudication items must exactly equal binary disagreements." });
  }
  workOrder.workItems.forEach((item, index) => {
    const { workItemDigest, ...itemContent } = item;
    if (contentDigest(itemContent) !== workItemDigest || item.subject.subjectDigest !== item.subjectDigest) {
      context.addIssue({ code: "custom", path: ["workItems", index], message: "Adjudication work item is not content-addressed." });
    }
  });
});
export type Exp0001aCodexAdjudicationWorkOrder = z.infer<typeof exp0001aCodexAdjudicationWorkOrderSchema>;

export function createExp0001aCodexAdjudicationWorkOrder(input: Readonly<{
  freeze: Exp0001aCodexPrebriefFreeze;
  catalog: Exp0001aCodexAuthorArtifactCatalog;
  primaryWorkOrder: Exp0001aCodexPrimaryReviewWorkOrder;
  primaryResults: Exp0001aCodexPrimaryReviewResultLedger;
  reviewPlanManifest: Exp0001aCodexReviewPlanManifest;
  primaryPlans: readonly Exp0001aCodexTaskTransportPlan[];
  primaryLifecycles: readonly Exp0001aCodexTaskLifecycle[];
}>): Exp0001aCodexAdjudicationWorkOrder {
  const freeze = verifyExp0001aCodexPrebriefFreeze(input.freeze);
  const catalog = exp0001aCodexAuthorArtifactCatalogSchema.parse(input.catalog);
  const primaryWorkOrder = exp0001aCodexPrimaryReviewWorkOrderSchema.parse(input.primaryWorkOrder);
  const primaryResults = exp0001aCodexPrimaryReviewResultLedgerSchema.parse(input.primaryResults);
  if (primaryWorkOrder.authorCatalogDigest !== catalog.catalogDigest
      || primaryResults.workOrderDigest !== primaryWorkOrder.workOrderDigest) {
    throw new Error("EXP0001A_ADJUDICATION_PRIMARY_CHAIN_DRIFT");
  }
  const reviewPlan = exp0001aCodexReviewPlanManifestSchema.parse(input.reviewPlanManifest);
  if (reviewPlan.manifestDigest !== freeze.reviewCommitments.reviewPlanManifestDigest) {
    throw new Error("EXP0001A_ADJUDICATION_REVIEW_PLAN_DRIFT");
  }
  const roster = reviewPlan.primaryReviewerRoster;
  const rosterRoot = computeExp0001aPrimaryReviewerRosterRoot(roster);
  if (rosterRoot !== freeze.reviewCommitments.primaryReviewerRosterRoot) {
    throw new Error("EXP0001A_ADJUDICATION_REVIEWER_ROSTER_ROOT_DRIFT");
  }
  const evidenceByArtifact = new Map(catalog.entries.flatMap((entry) => {
    const subject = exp0001aPrimaryReviewSubjectSchema.parse(entry.reviewSubject);
    return subject.kind === "primary-review-success-subject" ? [[entry.artifactId, subject] as const] : [];
  }));
  const workItemById = new Map(primaryWorkOrder.workItems.map((item) => [item.workItemId, item]));
  const planByDigest = new Map(input.primaryPlans.map((plan) => {
    const parsed = exp0001aCodexTaskTransportPlanSchema.parse(plan);
    return [parsed.planDigest, parsed] as const;
  }));
  const lifecycleByDigest = new Map(input.primaryLifecycles.map((lifecycle) => {
    const parsed = exp0001aCodexTaskLifecycleSchema.parse(lifecycle);
    return [parsed.lifecycleDigest, parsed] as const;
  }));
  const resultsByArtifact = new Map<string, Exp0001aCodexReviewResultEntry[]>();
  for (const result of primaryResults.results) {
    resultsByArtifact.set(result.artifactId, [...(resultsByArtifact.get(result.artifactId) ?? []), result]);
  }
  const disagreements = catalog.entries.flatMap((entry) => {
    const results = resultsByArtifact.get(entry.artifactId)?.slice().sort((left, right) => {
      const leftSlot = workItemById.get(left.workItemId)?.reviewerSlot ?? 99;
      const rightSlot = workItemById.get(right.workItemId)?.reviewerSlot ?? 99;
      return leftSlot - rightSlot;
    });
    if (!results || results.length !== 2) throw new Error(`EXP0001A_PRIMARY_RESULT_PAIR_INVALID:${entry.artifactId}`);
    // Canonical terminal review failures are retained as accepted=false.  The
    // frozen trigger is binary acceptance disagreement, so scored=true versus
    // failed=false still requires an independent adjudicator; failed=false
    // versus scored=false is ordinary binary agreement.
    const binaryDisagreement = results[0]!.accepted !== results[1]!.accepted;
    return binaryDisagreement ? [{ entry, results: results as [Exp0001aCodexReviewResultEntry, Exp0001aCodexReviewResultEntry] }] : [];
  });
  const workItems = disagreements.map(({ entry, results }) => {
    const excluded = new Set(results.map((result) => result.reviewerId));
    const reviewer = roster.filter((candidate) => !excluded.has(candidate.reviewerId))
      .sort((left, right) => rankReviewer(
        freeze.reviewCommitments.primaryAssignmentSeed,
        entry.entryDigest,
        left,
        "adjudicator",
      ).localeCompare(rankReviewer(
        freeze.reviewCommitments.primaryAssignmentSeed,
        entry.entryDigest,
        right,
        "adjudicator",
      )) || left.reviewerId.localeCompare(right.reviewerId))[0];
    if (!reviewer) throw new Error(`EXP0001A_ADJUDICATOR_NOT_SEPARATED:${entry.artifactId}`);
    const suffix = contentDigest({ artifactId: entry.artifactId, reviewer: reviewer.identityCommitment, primaries: results.map((result) => result.resultEntryDigest) })
      .slice("sha256:".length, "sha256:".length + 20);
    const primarySubject = evidenceByArtifact.get(entry.artifactId);
    if (!primarySubject) throw new Error(`EXP0001A_ADJUDICATION_FAILURE_SUBJECT_FORBIDDEN:${entry.artifactId}`);
    const primaryBindings = results.map((result, index) => {
      const plan = planByDigest.get(result.planDigest);
      const lifecycle = lifecycleByDigest.get(result.lifecycleDigest);
      if (!plan || !lifecycle) {
        throw new Error(`EXP0001A_ADJUDICATION_PRIMARY_TRANSPORT_MISSING:${result.workItemId}`);
      }
      return {
        slot: index === 0 ? "primary-review-1" as const : "primary-review-2" as const,
        plan,
        lifecycle,
      };
    }) as [
      { slot: "primary-review-1"; plan: Exp0001aCodexTaskTransportPlan; lifecycle: Exp0001aCodexTaskLifecycle },
      { slot: "primary-review-2"; plan: Exp0001aCodexTaskTransportPlan; lifecycle: Exp0001aCodexTaskLifecycle },
    ];
    const subject = createExp0001aAdjudicationReviewSubject({
      primarySubject,
      primaryReviews: primaryBindings,
    });
    const content = adjudicationWorkItemContentSchema.parse({
      workItemId: `adjudication-work-${suffix}`,
      assignmentId: `adjudication-assignment-${suffix}`,
      attemptId: `adjudication-attempt-${suffix}`,
      artifactId: entry.artifactId,
      reviewerId: reviewer.reviewerId,
      reviewerIdentityCommitment: reviewer.identityCommitment,
      subjectArtifactRoot: subject.adjudicationSubjectRoot,
      primaryResultEntryDigests: results.map((result) => result.resultEntryDigest),
      primaryTerminalJson: results.map((result) => result.terminalJson),
      subject,
      subjectDigest: subject.subjectDigest,
    });
    return adjudicationWorkItemSchema.parse({ ...content, workItemDigest: contentDigest(content) });
  });
  const disagreementArtifactIds = workItems.map((item) => item.artifactId);
  const content = adjudicationWorkOrderContentSchema.parse({
    schemaVersion: "exp-0001a-codex-adjudication-work-order/v1",
    protocolId: "EXP-0001A",
    freezeDigest: freeze.freezeDigest,
    authorCatalogDigest: catalog.catalogDigest,
    primaryWorkOrderDigest: primaryWorkOrder.workOrderDigest,
    primaryResultLedgerDigest: primaryResults.resultLedgerDigest,
    trigger: "binary-primary-acceptance-disagreement-only",
    reviewerRosterRoot: rosterRoot,
    disagreementArtifactIds,
    workItems,
  });
  return Object.freeze(exp0001aCodexAdjudicationWorkOrderSchema.parse({
    ...content,
    workOrderDigest: contentDigest(content),
  }));
}

const adjudicationResultLedgerContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-adjudication-result-ledger/v1"),
  protocolId: z.literal("EXP-0001A"),
  workOrderDigest: digestSchema,
  resultCount: z.number().int().min(0).max(48),
  results: z.array(reviewResultEntrySchema).max(48),
}).strict();
export const exp0001aCodexAdjudicationResultLedgerSchema = adjudicationResultLedgerContentSchema.extend({
  resultLedgerDigest: digestSchema,
}).strict().superRefine((ledger, context) => {
  const { resultLedgerDigest, ...content } = ledger;
  if (contentDigest(content) !== resultLedgerDigest || ledger.resultCount !== ledger.results.length) {
    context.addIssue({ code: "custom", path: ["resultLedgerDigest"], message: "Adjudication result ledger is invalid." });
  }
  ledger.results.forEach((result, index) => {
    const { resultEntryDigest, ...entryContent } = result;
    if (contentDigest(entryContent) !== resultEntryDigest) {
      context.addIssue({ code: "custom", path: ["results", index], message: "Adjudication result entry digest is invalid." });
    }
  });
});
export type Exp0001aCodexAdjudicationResultLedger = z.infer<typeof exp0001aCodexAdjudicationResultLedgerSchema>;

export function recordExp0001aCodexAdjudicationResults(input: Readonly<{
  workOrder: Exp0001aCodexAdjudicationWorkOrder;
  plans: readonly Exp0001aCodexTaskTransportPlan[];
  lifecycles: readonly Exp0001aCodexTaskLifecycle[];
}>): Exp0001aCodexAdjudicationResultLedger {
  const workOrder = exp0001aCodexAdjudicationWorkOrderSchema.parse(input.workOrder);
  const results = collectReviewResults({
    role: "adjudicator",
    workItems: workOrder.workItems,
    plans: input.plans,
    lifecycles: input.lifecycles,
  });
  const content = adjudicationResultLedgerContentSchema.parse({
    schemaVersion: "exp-0001a-codex-adjudication-result-ledger/v1",
    protocolId: "EXP-0001A",
    workOrderDigest: workOrder.workOrderDigest,
    resultCount: results.length,
    results,
  });
  return Object.freeze(exp0001aCodexAdjudicationResultLedgerSchema.parse({
    ...content,
    resultLedgerDigest: contentDigest(content),
  }));
}

export function verifyExp0001aCodexAdjudicationResults(input: Readonly<{
  workOrder: Exp0001aCodexAdjudicationWorkOrder;
  resultLedger: unknown;
}>): Exp0001aCodexAdjudicationResultLedger {
  const workOrder = exp0001aCodexAdjudicationWorkOrderSchema.parse(input.workOrder);
  const ledger = exp0001aCodexAdjudicationResultLedgerSchema.parse(input.resultLedger);
  if (ledger.workOrderDigest !== workOrder.workOrderDigest
      || ledger.results.length !== workOrder.workItems.length
      || ledger.results.some((result, index) => {
        const item = workOrder.workItems[index];
        return item === undefined || result.workItemId !== item.workItemId
          || result.workItemDigest !== item.workItemDigest
          || result.assignmentId !== item.assignmentId
          || result.attemptId !== item.attemptId
          || result.artifactId !== item.artifactId
          || result.reviewerId !== item.reviewerId
          || result.reviewerIdentityCommitment !== item.reviewerIdentityCommitment;
      })) {
    throw new Error("EXP0001A_ADJUDICATION_RESULT_WORK_ORDER_DRIFT");
  }
  return Object.freeze(ledger);
}

const FAILURE_CLASS_PRECEDENCE = Object.freeze([
  "FAIL_PRIVACY_INTEGRITY",
  "FAIL_PROTOCOL_VIOLATION",
  "FAIL_EVALUATOR_SCORER",
  "FAIL_INFRASTRUCTURE",
  "FAIL_WEBMCP_TOOLING",
  "FAIL_TRANSACTION_REVISION_LEASE",
  "FAIL_TEMPORAL_PRESENTATION",
  "FAIL_AUTHOR_NONCOMPLETION",
  "FAIL_SEMANTIC",
  "FAIL_GEOMETRY_VISUAL",
  "FAIL_INSPECTION_CORRECTION",
  "SUCCESS",
] as const);

function precedenceFailure(values: readonly z.infer<typeof failureClassSchema>[]): z.infer<typeof failureClassSchema> {
  return FAILURE_CLASS_PRECEDENCE.find((value) => values.includes(value)) ?? "FAIL_EVALUATOR_SCORER";
}

const classificationEntryContentSchema = z.object({
  artifactId: idSchema,
  assignmentId: idSchema,
  attemptId: idSchema,
  pairId: idSchema,
  condition: conditionSchema,
  taskId: idSchema,
  taskFamily: taskFamilySchema,
  artifactComplete: z.boolean(),
  accepted: z.boolean(),
  primaryFailureClass: failureClassSchema,
  resolution: z.enum([
    "primary_binary_agreement",
    "binary_disagreement_adjudicated",
    "primary_failure_fail_closed",
  ]),
  primaryResultEntryDigests: z.tuple([digestSchema, digestSchema]),
  adjudicationResultEntryDigest: digestSchema.nullable(),
}).strict();
const classificationEntrySchema = classificationEntryContentSchema.extend({ classificationDigest: digestSchema }).strict();

const classificationBookContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-classification-lock/v1"),
  protocolId: z.literal("EXP-0001A"),
  lockedAt: timestampSchema,
  authorCatalogDigest: digestSchema,
  primaryResultLedgerDigest: digestSchema,
  adjudicationWorkOrderDigest: digestSchema,
  adjudicationResultLedgerDigest: digestSchema,
  denominator: z.literal(48),
  classifications: z.array(classificationEntrySchema).length(48),
}).strict();
export const exp0001aCodexClassificationBookSchema = classificationBookContentSchema.extend({
  classificationBookDigest: digestSchema,
}).strict().superRefine((book, context) => {
  const { classificationBookDigest, ...content } = book;
  if (contentDigest(content) !== classificationBookDigest) {
    context.addIssue({ code: "custom", path: ["classificationBookDigest"], message: "Classification-book digest is invalid." });
  }
  const ids = new Set<string>();
  book.classifications.forEach((entry, index) => {
    const { classificationDigest, ...entryContent } = entry;
    if (contentDigest(entryContent) !== classificationDigest || ids.has(entry.artifactId)
        || (!entry.artifactComplete && (entry.accepted || entry.primaryFailureClass !== "FAIL_AUTHOR_NONCOMPLETION"))) {
      context.addIssue({ code: "custom", path: ["classifications", index], message: "Classification is invalid, duplicated, or credits an incomplete artifact." });
    }
    ids.add(entry.artifactId);
  });
});
export type Exp0001aCodexClassificationBook = z.infer<typeof exp0001aCodexClassificationBookSchema>;

export function lockExp0001aCodexClassifications(input: Readonly<{
  lockedAt: string;
  catalog: Exp0001aCodexAuthorArtifactCatalog;
  primaryResults: Exp0001aCodexPrimaryReviewResultLedger;
  adjudicationWorkOrder: Exp0001aCodexAdjudicationWorkOrder;
  adjudicationResults: Exp0001aCodexAdjudicationResultLedger;
}>): Exp0001aCodexClassificationBook {
  const catalog = exp0001aCodexAuthorArtifactCatalogSchema.parse(input.catalog);
  const primaryResults = exp0001aCodexPrimaryReviewResultLedgerSchema.parse(input.primaryResults);
  const adjudicationWorkOrder = exp0001aCodexAdjudicationWorkOrderSchema.parse(input.adjudicationWorkOrder);
  const adjudicationResults = exp0001aCodexAdjudicationResultLedgerSchema.parse(input.adjudicationResults);
  timestampSchema.parse(input.lockedAt);
  if (adjudicationWorkOrder.authorCatalogDigest !== catalog.catalogDigest
      || adjudicationWorkOrder.primaryResultLedgerDigest !== primaryResults.resultLedgerDigest
      || adjudicationResults.workOrderDigest !== adjudicationWorkOrder.workOrderDigest
      || adjudicationResults.results.length !== adjudicationWorkOrder.workItems.length) {
    throw new Error("EXP0001A_CLASSIFICATION_CHAIN_DRIFT");
  }
  const primaryByArtifact = new Map<string, Exp0001aCodexReviewResultEntry[]>();
  for (const result of primaryResults.results) {
    primaryByArtifact.set(result.artifactId, [...(primaryByArtifact.get(result.artifactId) ?? []), result]);
  }
  const adjudicationByArtifact = new Map(adjudicationResults.results.map((result) => [result.artifactId, result]));
  const expectedDisagreements = new Set(adjudicationWorkOrder.disagreementArtifactIds);
  const classifications = catalog.entries.map((entry) => {
    const primaries = primaryByArtifact.get(entry.artifactId)?.slice().sort((left, right) => left.workItemId.localeCompare(right.workItemId));
    if (!primaries || primaries.length !== 2) throw new Error(`EXP0001A_CLASSIFICATION_PRIMARY_PAIR_INVALID:${entry.artifactId}`);
    const primaryFailure = primaries.some((primary) => primary.resultStatus === "failed");
    const disagreement = primaries[0]!.accepted !== primaries[1]!.accepted;
    const adjudication = adjudicationByArtifact.get(entry.artifactId) ?? null;
    if (disagreement !== expectedDisagreements.has(entry.artifactId)
        || (disagreement && adjudication === null)
        || (!disagreement && adjudication !== null)) {
      throw new Error(`EXP0001A_CLASSIFICATION_ADJUDICATION_TRIGGER_DRIFT:${entry.artifactId}`);
    }
    const reviewerAccepted = disagreement ? adjudication!.accepted : primaries[0]!.accepted;
    // Reviewer judgments over the canonical failure packet remain diagnostic;
    // they can never credit an author attempt that lacked complete independent
    // room-state and PNG evidence.
    const accepted = entry.artifactComplete && reviewerAccepted;
    const primaryFailureClass = !entry.artifactComplete
      ? "FAIL_AUTHOR_NONCOMPLETION" as const
      : accepted
        ? "SUCCESS" as const
        : disagreement
          ? adjudication!.primaryFailureClass
          : precedenceFailure(primaries.map((primary) => primary.primaryFailureClass));
    const content = classificationEntryContentSchema.parse({
      artifactId: entry.artifactId,
      assignmentId: entry.assignmentId,
      attemptId: entry.attemptId,
      pairId: entry.pairId,
      condition: entry.condition,
      taskId: entry.taskId,
      taskFamily: entry.taskFamily,
      artifactComplete: entry.artifactComplete,
      accepted,
      primaryFailureClass,
      resolution: disagreement
        ? "binary_disagreement_adjudicated"
        : primaryFailure ? "primary_failure_fail_closed" : "primary_binary_agreement",
      primaryResultEntryDigests: primaries.map((primary) => primary.resultEntryDigest),
      adjudicationResultEntryDigest: adjudication?.resultEntryDigest ?? null,
    });
    return classificationEntrySchema.parse({ ...content, classificationDigest: contentDigest(content) });
  });
  const content = classificationBookContentSchema.parse({
    schemaVersion: "exp-0001a-codex-classification-lock/v1",
    protocolId: "EXP-0001A",
    lockedAt: input.lockedAt,
    authorCatalogDigest: catalog.catalogDigest,
    primaryResultLedgerDigest: primaryResults.resultLedgerDigest,
    adjudicationWorkOrderDigest: adjudicationWorkOrder.workOrderDigest,
    adjudicationResultLedgerDigest: adjudicationResults.resultLedgerDigest,
    denominator: 48,
    classifications,
  });
  return Object.freeze(exp0001aCodexClassificationBookSchema.parse({
    ...content,
    classificationBookDigest: contentDigest(content),
  }));
}

const frozenPairwiseAssignmentSchema = z.object({
  pairIndex: z.number().int().min(0).max(23),
  pairId: idSchema,
  taskId: idSchema,
  taskFamily: taskFamilySchema,
  reviewerId: idSchema,
  reviewerIdentityCommitment: digestSchema,
  canvas1Condition: conditionSchema,
  canvas2Condition: conditionSchema,
  assignmentDigest: digestSchema,
}).strict();

const reviewPlanManifestContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-review-plan-manifest/v1"),
  protocolId: z.literal("EXP-0001A"),
  sourceExecutionManifestDigest: digestSchema,
  sourceFreezeDigest: digestSchema,
  primaryAssignmentAlgorithm: z.literal("sha256-ranked-by-registry-artifact-identity-and-purpose"),
  primaryAssignmentSeed: digestSchema,
  primaryReviewerRoster: z.array(reviewerIdentitySchema).min(3),
  primaryReviewerRosterRoot: digestSchema,
  adjudicationTrigger: z.literal("binary-primary-acceptance-disagreement-only"),
  pairwisePromptDigest: digestSchema,
  pairwiseRandomizationAlgorithm: z.literal("sha256-ranked-balanced-family-replicate-v1"),
  pairwiseReviewerRoster: z.array(reviewerIdentitySchema).length(24),
  pairwiseReviewerRosterRoot: digestSchema,
  pairwiseAssignments: z.array(frozenPairwiseAssignmentSchema).length(24),
  pairwiseAssignmentRoot: digestSchema,
  pairwiseLeftRightRoot: digestSchema,
}).strict();
export const exp0001aCodexReviewPlanManifestSchema = reviewPlanManifestContentSchema.extend({
  manifestDigest: digestSchema,
}).strict().superRefine((manifest, context) => {
  const { manifestDigest, ...content } = manifest;
  if (contentDigest(content) !== manifestDigest
      || computeExp0001aPrimaryReviewerRosterRoot(manifest.primaryReviewerRoster) !== manifest.primaryReviewerRosterRoot
      || computeExp0001aPairwiseReviewerRosterRoot(manifest.pairwiseReviewerRoster) !== manifest.pairwiseReviewerRosterRoot) {
    context.addIssue({ code: "custom", path: ["manifestDigest"], message: "Review-plan manifest or roster commitment is invalid." });
  }
  manifest.pairwiseAssignments.forEach((assignment, index) => {
    const { assignmentDigest, ...assignmentContent } = assignment;
    if (assignment.pairIndex !== index || contentDigest(assignmentContent) !== assignmentDigest
        || assignment.canvas1Condition === assignment.canvas2Condition) {
      context.addIssue({ code: "custom", path: ["pairwiseAssignments", index], message: "Frozen pairwise assignment is invalid." });
    }
  });
  if (contentDigest(manifest.pairwiseAssignments as unknown as Record<string, unknown>) !== manifest.pairwiseAssignmentRoot
      || contentDigest(manifest.pairwiseAssignments.map(({ pairId, canvas1Condition, canvas2Condition }) => ({ pairId, canvas1Condition, canvas2Condition })) as unknown as Record<string, unknown>) !== manifest.pairwiseLeftRightRoot) {
    context.addIssue({ code: "custom", path: ["pairwiseAssignmentRoot"], message: "Frozen pairwise roots are invalid." });
  }
  const expectedPrimaryRoster = [...EXP0001A_CODEX_REVIEW_SOURCE.primaryReviewerRoster]
    .sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
  const expectedPairwiseRoster = [...EXP0001A_CODEX_REVIEW_SOURCE.pairwiseReviewerRoster]
    .sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
  if (manifest.sourceFreezeDigest !== EXP0001A_CODEX_REVIEW_SOURCE.sourceFreezeDigest
      || manifest.primaryAssignmentSeed !== EXP0001A_CODEX_REVIEW_SOURCE.primaryAssignmentSeed
      || manifest.pairwisePromptDigest !== EXP0001A_CODEX_REVIEW_SOURCE.pairwisePromptDigest
      || canonicalJson(manifest.primaryReviewerRoster) !== canonicalJson(expectedPrimaryRoster)
      || canonicalJson(manifest.pairwiseReviewerRoster) !== canonicalJson(expectedPairwiseRoster)) {
    context.addIssue({
      code: "custom",
      path: ["sourceFreezeDigest"],
      message: "Review-plan source differs from the exact retained v1 reviewer projection.",
    });
  }
});
export type Exp0001aCodexReviewPlanManifest = z.infer<typeof exp0001aCodexReviewPlanManifestSchema>;

/**
 * Creates the one provider-free review-plan artifact from the exact retained
 * v1 reviewer projection and the verified development execution manifest.
 * Callers cannot substitute a roster, seed, prompt, or assignment algorithm.
 */
export function createExp0001aCodexReviewPlanManifest(input: Readonly<{
  executionManifest: DevelopmentExecutionManifest;
}>): Exp0001aCodexReviewPlanManifest {
  const verified = verifyDevelopmentExecutionManifest(input.executionManifest);
  if (!verified.ok) {
    throw new Error(`EXP0001A_REVIEW_PLAN_EXECUTION_MANIFEST_INVALID:${verified.errors.join("|")}`);
  }
  const execution = developmentExecutionManifestSchema.parse(verified.manifest);
  const primaryRoster = z.array(reviewerIdentitySchema).length(5)
    .parse(EXP0001A_CODEX_REVIEW_SOURCE.primaryReviewerRoster)
    .slice().sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
  const pairwiseRoster = z.array(reviewerIdentitySchema).length(24)
    .parse(EXP0001A_CODEX_REVIEW_SOURCE.pairwiseReviewerRoster)
    .slice().sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
  const primaryRoot = computeExp0001aPrimaryReviewerRosterRoot(primaryRoster);
  const pairwiseRoot = computeExp0001aPairwiseReviewerRosterRoot(pairwiseRoster);
  const assignments = execution.assignments.slice().sort((left, right) => left.timeBlock - right.timeBlock)
    .map((pair, pairIndex) => {
      if (pair.timeBlock !== pairIndex) throw new Error("EXP0001A_PAIRWISE_SOURCE_ORDER_DRIFT");
      const reviewer = pairwiseRoster[pairIndex]!;
      const rank = contentDigest({
        algorithm: "sha256-ranked-balanced-family-replicate-v1",
        sourceExecutionManifestDigest: execution.manifestDigest,
        pairId: pair.pairId,
        purpose: "pairwise-left-right-placement",
      });
      const sourceOrder = pair.attempts.slice().sort((left, right) => left.orderIndex - right.orderIndex);
      const canvas1Condition = Number.parseInt(rank.slice(-2), 16) % 2 === 0
        ? sourceOrder[0]!.opaqueLabel : sourceOrder[1]!.opaqueLabel;
      const canvas2Condition = canvas1Condition === "A0" ? "A1" : "A0";
      const content = {
        pairIndex,
        pairId: pair.pairId,
        taskId: pair.taskId,
        taskFamily: pair.taskFamily,
        reviewerId: reviewer.reviewerId,
        reviewerIdentityCommitment: reviewer.identityCommitment,
        canvas1Condition,
        canvas2Condition,
      };
      return frozenPairwiseAssignmentSchema.parse({ ...content, assignmentDigest: contentDigest(content) });
    });
  const pairwiseAssignmentRoot = contentDigest(assignments as unknown as Record<string, unknown>);
  const pairwiseLeftRightRoot = contentDigest(assignments.map(({ pairId, canvas1Condition, canvas2Condition }) => ({
    pairId, canvas1Condition, canvas2Condition,
  })) as unknown as Record<string, unknown>);
  const content = reviewPlanManifestContentSchema.parse({
    schemaVersion: "exp-0001a-codex-review-plan-manifest/v1",
    protocolId: "EXP-0001A",
    sourceExecutionManifestDigest: execution.manifestDigest,
    sourceFreezeDigest: EXP0001A_CODEX_REVIEW_SOURCE.sourceFreezeDigest,
    primaryAssignmentAlgorithm: "sha256-ranked-by-registry-artifact-identity-and-purpose",
    primaryAssignmentSeed: EXP0001A_CODEX_REVIEW_SOURCE.primaryAssignmentSeed,
    primaryReviewerRoster: primaryRoster,
    primaryReviewerRosterRoot: primaryRoot,
    adjudicationTrigger: "binary-primary-acceptance-disagreement-only",
    pairwisePromptDigest: EXP0001A_CODEX_REVIEW_SOURCE.pairwisePromptDigest,
    pairwiseRandomizationAlgorithm: "sha256-ranked-balanced-family-replicate-v1",
    pairwiseReviewerRoster: pairwiseRoster,
    pairwiseReviewerRosterRoot: pairwiseRoot,
    pairwiseAssignments: assignments,
    pairwiseAssignmentRoot,
    pairwiseLeftRightRoot,
  });
  return Object.freeze(exp0001aCodexReviewPlanManifestSchema.parse({
    ...content,
    manifestDigest: contentDigest(content),
  }));
}

/** Recreates the plan and compares every byte; a self-consistent forged plan is rejected. */
export function verifyExp0001aCodexReviewPlanManifest(input: Readonly<{
  manifest: unknown;
  executionManifest: DevelopmentExecutionManifest;
}>): Exp0001aCodexReviewPlanManifest {
  const retained = exp0001aCodexReviewPlanManifestSchema.parse(input.manifest);
  const expected = createExp0001aCodexReviewPlanManifest({ executionManifest: input.executionManifest });
  if (canonicalJson(retained) !== canonicalJson(expected)) {
    throw new Error("EXP0001A_CODEX_REVIEW_PLAN_MANIFEST_DRIFT");
  }
  return Object.freeze(retained);
}

const pairwiseWorkItemContentSchema = z.object({
  workItemId: idSchema,
  assignmentId: idSchema,
  attemptId: idSchema,
  pairIndex: z.number().int().min(0).max(23),
  pairId: idSchema,
  taskId: idSchema,
  taskFamily: taskFamilySchema,
  reviewerId: idSchema,
  reviewerIdentityCommitment: digestSchema,
  canvas1ArtifactId: idSchema,
  canvas2ArtifactId: idSchema,
  canvas1Condition: conditionSchema,
  canvas2Condition: conditionSchema,
  frozenAssignmentDigest: digestSchema,
  subject: exp0001aPairwiseReviewSubjectSchema,
  subjectDigest: digestSchema,
}).strict();
const pairwiseWorkItemSchema = pairwiseWorkItemContentSchema.extend({ workItemDigest: digestSchema }).strict();

const pairwiseWorkOrderContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-pairwise-work-order/v1"),
  protocolId: z.literal("EXP-0001A"),
  reviewPlanManifestDigest: digestSchema,
  authorCatalogDigest: digestSchema,
  classificationBookDigest: digestSchema,
  frozenPairwiseAssignmentRoot: digestSchema,
  frozenLeftRightRoot: digestSchema,
  workItemCount: z.literal(24),
  workItems: z.array(pairwiseWorkItemSchema).length(24),
}).strict();
export const exp0001aCodexPairwiseWorkOrderSchema = pairwiseWorkOrderContentSchema.extend({
  workOrderDigest: digestSchema,
}).strict().superRefine((workOrder, context) => {
  const { workOrderDigest, ...content } = workOrder;
  if (contentDigest(content) !== workOrderDigest) {
    context.addIssue({ code: "custom", path: ["workOrderDigest"], message: "Pairwise work-order digest is invalid." });
  }
  workOrder.workItems.forEach((item, index) => {
    const { workItemDigest, ...itemContent } = item;
    if (item.pairIndex !== index || contentDigest(itemContent) !== workItemDigest
        || item.subject.subjectDigest !== item.subjectDigest) {
      context.addIssue({ code: "custom", path: ["workItems", index], message: "Pairwise work item is not content-addressed." });
    }
  });
});
export type Exp0001aCodexPairwiseWorkOrder = z.infer<typeof exp0001aCodexPairwiseWorkOrderSchema>;

export function createExp0001aCodexPairwiseWorkOrder(input: Readonly<{
  freeze: Exp0001aCodexPrebriefFreeze;
  reviewPlanManifest: Exp0001aCodexReviewPlanManifest;
  catalog: Exp0001aCodexAuthorArtifactCatalog;
  classifications: Exp0001aCodexClassificationBook;
  authorPlans: readonly Exp0001aCodexTaskTransportPlan[];
  authorLifecycles: readonly Exp0001aCodexTaskLifecycle[];
}>): Exp0001aCodexPairwiseWorkOrder {
  const freeze = verifyExp0001aCodexPrebriefFreeze(input.freeze);
  const reviewPlan = exp0001aCodexReviewPlanManifestSchema.parse(input.reviewPlanManifest);
  const catalog = exp0001aCodexAuthorArtifactCatalogSchema.parse(input.catalog);
  const classifications = exp0001aCodexClassificationBookSchema.parse(input.classifications);
  if (catalog.freezeDigest !== freeze.freezeDigest
      || reviewPlan.manifestDigest !== freeze.reviewCommitments.reviewPlanManifestDigest
      || classifications.authorCatalogDigest !== catalog.catalogDigest
      || reviewPlan.primaryAssignmentSeed !== freeze.reviewCommitments.primaryAssignmentSeed
      || reviewPlan.primaryReviewerRosterRoot !== freeze.reviewCommitments.primaryReviewerRosterRoot
      || reviewPlan.pairwiseReviewerRosterRoot !== freeze.reviewCommitments.pairwiseReviewerRosterRoot
      || reviewPlan.pairwisePromptDigest !== freeze.reviewCommitments.pairwisePromptDigest
      || reviewPlan.pairwiseAssignmentRoot !== freeze.reviewCommitments.pairwiseWorkOrderDigest
      || reviewPlan.pairwiseLeftRightRoot !== freeze.reviewCommitments.pairwiseLeftRightRandomizationDigest) {
    throw new Error("EXP0001A_PAIRWISE_FROZEN_PLAN_DRIFT");
  }
  const authorPlanByDigest = new Map(input.authorPlans.map((planInput) => {
    const plan = exp0001aCodexTaskTransportPlanSchema.parse(planInput);
    if (plan.role !== "author") throw new Error("EXP0001A_PAIRWISE_NON_AUTHOR_PLAN_FORBIDDEN");
    return [plan.planDigest, plan] as const;
  }));
  const authorLifecycleByDigest = new Map(input.authorLifecycles.map((lifecycleInput) => {
    const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(lifecycleInput);
    if (lifecycle.role !== "author") throw new Error("EXP0001A_PAIRWISE_NON_AUTHOR_LIFECYCLE_FORBIDDEN");
    return [lifecycle.lifecycleDigest, lifecycle] as const;
  }));
  const byPair = new Map<string, Exp0001aCodexAuthorArtifactCatalogEntry[]>();
  for (const entry of catalog.entries) byPair.set(entry.pairId, [...(byPair.get(entry.pairId) ?? []), entry]);
  const workItems = reviewPlan.pairwiseAssignments.map((assignment) => {
    const pair = byPair.get(assignment.pairId);
    if (!pair || pair.length !== 2 || pair.some((entry) => entry.taskId !== assignment.taskId
        || entry.taskFamily !== assignment.taskFamily)) {
      throw new Error(`EXP0001A_PAIRWISE_ARTIFACT_PAIR_INVALID:${assignment.pairId}`);
    }
    const canvas1 = pair.find((entry) => entry.condition === assignment.canvas1Condition);
    const canvas2 = pair.find((entry) => entry.condition === assignment.canvas2Condition);
    if (!canvas1 || !canvas2) throw new Error(`EXP0001A_PAIRWISE_SIDE_BINDING_INVALID:${assignment.pairId}`);
    const subject1 = exp0001aPrimaryReviewSubjectSchema.parse(canvas1.reviewSubject);
    const subject2 = exp0001aPrimaryReviewSubjectSchema.parse(canvas2.reviewSubject);
    const rubric1 = subject1.kind === "primary-review-success-subject" ? subject1.evidence.rubric : subject1.rubric;
    const rubric2 = subject2.kind === "primary-review-success-subject" ? subject2.evidence.rubric : subject2.rubric;
    const publicRequirement1 = subject1.kind === "primary-review-success-subject"
      ? subject1.evidence.publicRequirement : subject1.publicRequirement;
    const publicRequirement2 = subject2.kind === "primary-review-success-subject"
      ? subject2.evidence.publicRequirement : subject2.publicRequirement;
    if (canonicalJson(rubric1) !== canonicalJson(rubric2)
        || publicRequirement1 !== publicRequirement2) {
      throw new Error(`EXP0001A_PAIRWISE_PUBLIC_EVIDENCE_DRIFT:${assignment.pairId}`);
    }
    const canvas1Plan = authorPlanByDigest.get(canvas1.authorPlanDigest);
    const canvas2Plan = authorPlanByDigest.get(canvas2.authorPlanDigest);
    const canvas1Lifecycle = authorLifecycleByDigest.get(canvas1.authorLifecycleDigest);
    const canvas2Lifecycle = authorLifecycleByDigest.get(canvas2.authorLifecycleDigest);
    if (!canvas1Plan || !canvas2Plan || !canvas1Lifecycle || !canvas2Lifecycle
        || canvas1Lifecycle.planDigest !== canvas1Plan.planDigest
        || canvas2Lifecycle.planDigest !== canvas2Plan.planDigest) {
      throw new Error(`EXP0001A_PAIRWISE_AUTHOR_TRANSPORT_MISSING:${assignment.pairId}`);
    }
    const suffix = assignment.assignmentDigest.slice("sha256:".length, "sha256:".length + 20);
    const subject = createExp0001aPairwiseReviewSubject({
      publicRequirement: publicRequirement1,
      rubric: {
        rubricId: rubric1.rubricId,
        criterionIds: rubric1.criterionIds,
        allowedMechanismTags: rubric1.allowedMechanismTags,
        content: rubric1.content,
      },
      sides: [
        { authorPlan: canvas1Plan, authorLifecycle: canvas1Lifecycle },
        { authorPlan: canvas2Plan, authorLifecycle: canvas2Lifecycle },
      ],
    });
    const content = pairwiseWorkItemContentSchema.parse({
      workItemId: `pairwise-work-${suffix}`,
      assignmentId: `pairwise-assignment-${suffix}`,
      attemptId: `pairwise-attempt-${suffix}`,
      pairIndex: assignment.pairIndex,
      pairId: assignment.pairId,
      taskId: assignment.taskId,
      taskFamily: assignment.taskFamily,
      reviewerId: assignment.reviewerId,
      reviewerIdentityCommitment: assignment.reviewerIdentityCommitment,
      canvas1ArtifactId: canvas1.artifactId,
      canvas2ArtifactId: canvas2.artifactId,
      canvas1Condition: assignment.canvas1Condition,
      canvas2Condition: assignment.canvas2Condition,
      frozenAssignmentDigest: assignment.assignmentDigest,
      subject,
      subjectDigest: subject.subjectDigest,
    });
    return pairwiseWorkItemSchema.parse({ ...content, workItemDigest: contentDigest(content) });
  });
  const content = pairwiseWorkOrderContentSchema.parse({
    schemaVersion: "exp-0001a-codex-pairwise-work-order/v1",
    protocolId: "EXP-0001A",
    reviewPlanManifestDigest: reviewPlan.manifestDigest,
    authorCatalogDigest: catalog.catalogDigest,
    classificationBookDigest: classifications.classificationBookDigest,
    frozenPairwiseAssignmentRoot: reviewPlan.pairwiseAssignmentRoot,
    frozenLeftRightRoot: reviewPlan.pairwiseLeftRightRoot,
    workItemCount: 24,
    workItems,
  });
  return Object.freeze(exp0001aCodexPairwiseWorkOrderSchema.parse({
    ...content,
    workOrderDigest: contentDigest(content),
  }));
}

const pairwiseResultEntryContentSchema = z.object({
  workItemId: idSchema,
  workItemDigest: digestSchema,
  assignmentId: idSchema,
  attemptId: idSchema,
  pairId: idSchema,
  reviewerId: idSchema,
  reviewerIdentityCommitment: digestSchema,
  reviewerTaskBindingDigest: digestSchema,
  planDigest: digestSchema,
  lifecycleDigest: digestSchema,
  readReceiptDigest: digestSchema,
  tracePolicyReceiptDigest: digestSchema.nullable(),
  independentResultArtifactRoot: digestSchema.nullable(),
  terminalOutcome: terminalOutcomeSchema,
  resultStatus: z.enum(["scored", "failed"]),
  preference: z.enum(["canvas-1", "canvas-2", "tie", "unavailable"]),
  preferredCondition: z.enum(["A0", "A1", "tie", "unavailable"]),
  terminalJson: z.json().nullable(),
  terminalJsonDigest: digestSchema.nullable(),
}).strict();
const pairwiseResultEntrySchema = pairwiseResultEntryContentSchema.extend({ resultEntryDigest: digestSchema }).strict();

const pairwiseResultLedgerContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-pairwise-result-ledger/v1"),
  protocolId: z.literal("EXP-0001A"),
  workOrderDigest: digestSchema,
  resultCount: z.literal(24),
  results: z.array(pairwiseResultEntrySchema).length(24),
}).strict();
export const exp0001aCodexPairwiseResultLedgerSchema = pairwiseResultLedgerContentSchema.extend({
  resultLedgerDigest: digestSchema,
}).strict().superRefine((ledger, context) => {
  const { resultLedgerDigest, ...content } = ledger;
  if (contentDigest(content) !== resultLedgerDigest) {
    context.addIssue({ code: "custom", path: ["resultLedgerDigest"], message: "Pairwise result-ledger digest is invalid." });
  }
  ledger.results.forEach((result, index) => {
    const { resultEntryDigest, ...entryContent } = result;
    if (contentDigest(entryContent) !== resultEntryDigest) {
      context.addIssue({ code: "custom", path: ["results", index], message: "Pairwise result entry digest is invalid." });
    }
  });
});
export type Exp0001aCodexPairwiseResultLedger = z.infer<typeof exp0001aCodexPairwiseResultLedgerSchema>;

export function recordExp0001aCodexPairwiseResults(input: Readonly<{
  workOrder: Exp0001aCodexPairwiseWorkOrder;
  plans: readonly Exp0001aCodexTaskTransportPlan[];
  lifecycles: readonly Exp0001aCodexTaskLifecycle[];
}>): Exp0001aCodexPairwiseResultLedger {
  const workOrder = exp0001aCodexPairwiseWorkOrderSchema.parse(input.workOrder);
  const allPlans = input.plans.map((plan) => exp0001aCodexTaskTransportPlanSchema.parse(plan))
    .filter((plan) => plan.role === "pairwise_visual_judge");
  const lifecycles = input.lifecycles.map((lifecycle) => exp0001aCodexTaskLifecycleSchema.parse(lifecycle));
  const lifecycleByPlan = new Map(lifecycles.map((lifecycle) => [lifecycle.planDigest, lifecycle]));
  const begunPlans = allPlans.filter((plan) => lifecycleByPlan.get(plan.planDigest)?.taskBegun === true);
  const planByAssignment = new Map(begunPlans.map((plan) => [plan.privateBinding.assignmentId, plan]));
  if (begunPlans.length !== 24 || planByAssignment.size !== 24) {
    throw new Error("EXP0001A_PAIRWISE_RESULT_DENOMINATOR_INVALID");
  }
  const results = workOrder.workItems.map((item) => {
    const plan = planByAssignment.get(item.assignmentId);
    const lifecycle = plan === undefined ? undefined : lifecycleByPlan.get(plan.planDigest);
    if (!plan || !lifecycle
        || plan.privateBinding.attemptId !== item.attemptId
        || canonicalJson(plan.privateBinding.subjectArtifactIds) !== canonicalJson([item.canvas1ArtifactId, item.canvas2ArtifactId])
        || lifecycle.role !== "pairwise_visual_judge" || lifecycle.planDigest !== plan.planDigest
        || lifecycle.transportId !== plan.transportId || lifecycle.state !== "terminal" || !lifecycle.taskBegun
        || lifecycle.readReceipt === null) {
      throw new Error(`EXP0001A_PAIRWISE_RESULT_BINDING_INVALID:${item.workItemId}`);
    }
    if (plan.envelope.role !== "pairwise_visual_judge") {
      throw new Error(`EXP0001A_PAIRWISE_RESULT_ENVELOPE_INVALID:${item.workItemId}`);
    }
    const expectedEnvelope = createExp0001aPairwiseVisualJudgeTaskEnvelopeFromSubject({
      subject: item.subject,
      artifactPacketOrigin: plan.envelope.artifactPacket.origin,
    });
    if (canonicalJson(plan.envelope) !== canonicalJson(expectedEnvelope)
        || plan.envelopeDigest !== reviewEnvelopeDigest(expectedEnvelope)) {
      throw new Error(`EXP0001A_PAIRWISE_RESULT_SUBJECT_DRIFT:${item.workItemId}`);
    }
    const rawResult = lifecycle.readReceipt.terminalJson;
    const subjectUnavailable = item.subject.kind === "pairwise-review-unavailable-subject";
    const transportSucceeded = lifecycle.terminalOutcome === "succeeded";
    if (transportSucceeded !== (rawResult !== null)) throw new Error(`EXP0001A_PAIRWISE_CANONICAL_FAILURE_INVALID:${item.workItemId}`);
    const terminalJson = rawResult === null ? null : validateExp0001aCodexTerminalJson(plan, rawResult);
    const decision = z.object({ role: z.literal("pairwise_visual_judge"), preference: z.enum(["canvas-1", "canvas-2", "tie"]) })
      .passthrough().safeParse(terminalJson);
    const unavailableDecision = z.object({
      role: z.literal("pairwise_visual_judge"),
      status: z.literal("non_evaluable"),
      preference: z.literal("unavailable"),
      pairRoot: z.literal(item.subject.pairRoot),
      primaryFailureClass: z.literal("FAIL_AUTHOR_NONCOMPLETION"),
    }).passthrough().safeParse(terminalJson);
    const terminalArtifact = lifecycle.readReceipt.terminalArtifact;
    if (transportSucceeded && ((!subjectUnavailable && !decision.success)
        || (subjectUnavailable && !unavailableDecision.success)
        || lifecycle.readReceipt.outcome !== "retained"
        || lifecycle.readReceipt.tracePolicyReceipt?.decision !== "pass"
        || terminalArtifact?.kind !== "pairwise-visual-result"
        || terminalArtifact.resultDigest !== hashCanonicalJson(terminalJson as JsonValue))) {
      throw new Error(`EXP0001A_PAIRWISE_INDEPENDENT_RESULT_DRIFT:${item.workItemId}`);
    }
    if (!transportSucceeded && terminalArtifact !== null) throw new Error(`EXP0001A_PAIRWISE_FAILED_RESULT_CLAIMS_ARTIFACT:${item.workItemId}`);
    const preference = !subjectUnavailable && decision.success ? decision.data.preference : "unavailable" as const;
    const preferredCondition = preference === "canvas-1" ? item.canvas1Condition
      : preference === "canvas-2" ? item.canvas2Condition : preference;
    const content = pairwiseResultEntryContentSchema.parse({
      workItemId: item.workItemId,
      workItemDigest: item.workItemDigest,
      assignmentId: item.assignmentId,
      attemptId: item.attemptId,
      pairId: item.pairId,
      reviewerId: item.reviewerId,
      reviewerIdentityCommitment: item.reviewerIdentityCommitment,
      reviewerTaskBindingDigest: contentDigest({
        reviewerIdentityCommitment: item.reviewerIdentityCommitment,
        codexTaskId: lifecycle.codexTaskId,
        threadId: lifecycle.threadId,
        hostId: lifecycle.hostId,
        planDigest: plan.planDigest,
      }),
      planDigest: plan.planDigest,
      lifecycleDigest: lifecycle.lifecycleDigest,
      readReceiptDigest: lifecycle.readReceipt.receiptDigest,
      tracePolicyReceiptDigest: lifecycle.readReceipt.tracePolicyReceipt?.receiptDigest ?? null,
      independentResultArtifactRoot: terminalArtifact?.artifactRoot ?? null,
      terminalOutcome: lifecycle.terminalOutcome,
      resultStatus: transportSucceeded && !subjectUnavailable ? "scored" : "failed",
      preference,
      preferredCondition,
      terminalJson,
      terminalJsonDigest: terminalJson === null ? null : hashCanonicalJson(terminalJson as JsonValue),
    });
    return pairwiseResultEntrySchema.parse({ ...content, resultEntryDigest: contentDigest(content) });
  });
  const content = pairwiseResultLedgerContentSchema.parse({
    schemaVersion: "exp-0001a-codex-pairwise-result-ledger/v1",
    protocolId: "EXP-0001A",
    workOrderDigest: workOrder.workOrderDigest,
    resultCount: 24,
    results,
  });
  return Object.freeze(exp0001aCodexPairwiseResultLedgerSchema.parse({ ...content, resultLedgerDigest: contentDigest(content) }));
}

export function verifyExp0001aCodexPairwiseResults(input: Readonly<{
  workOrder: Exp0001aCodexPairwiseWorkOrder;
  resultLedger: unknown;
}>): Exp0001aCodexPairwiseResultLedger {
  const workOrder = exp0001aCodexPairwiseWorkOrderSchema.parse(input.workOrder);
  const ledger = exp0001aCodexPairwiseResultLedgerSchema.parse(input.resultLedger);
  if (ledger.workOrderDigest !== workOrder.workOrderDigest
      || ledger.results.some((result, index) => {
        const item = workOrder.workItems[index];
        return item === undefined || result.workItemId !== item.workItemId
          || result.workItemDigest !== item.workItemDigest
          || result.assignmentId !== item.assignmentId
          || result.attemptId !== item.attemptId
          || result.pairId !== item.pairId
          || result.reviewerId !== item.reviewerId;
      })) {
    throw new Error("EXP0001A_PAIRWISE_RESULT_WORK_ORDER_DRIFT");
  }
  return Object.freeze(ledger);
}

const analysisReceiptContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-codex-analysis-receipt/v1"),
  protocolId: z.literal("EXP-0001A"),
  createdAt: timestampSchema,
  authorCatalogDigest: digestSchema,
  classificationBookDigest: digestSchema,
  pairwiseWorkOrderDigest: digestSchema,
  pairwiseResultLedgerDigest: digestSchema,
  accountingLedgerDigest: digestSchema,
  analysisReport: z.json(),
  analysisReportDigest: digestSchema,
  pairwiseSummary: z.object({
    A0: z.number().int().min(0).max(24),
    A1: z.number().int().min(0).max(24),
    tie: z.number().int().min(0).max(24),
    unavailable: z.number().int().min(0).max(24),
  }).strict(),
}).strict();
export const exp0001aCodexAnalysisReceiptSchema = analysisReceiptContentSchema.extend({ receiptDigest: digestSchema }).strict()
  .superRefine((receipt, context) => {
    const { receiptDigest, ...content } = receipt;
    if (contentDigest(content) !== receiptDigest
        || hashCanonicalJson(receipt.analysisReport as JsonValue) !== receipt.analysisReportDigest
        || Object.values(receipt.pairwiseSummary).reduce((sum, count) => sum + count, 0) !== 24) {
      context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Analysis receipt content address or denominator is invalid." });
    }
  });
export type Exp0001aCodexAnalysisReceipt = z.infer<typeof exp0001aCodexAnalysisReceiptSchema>;

export function createExp0001aCodexAnalysisReceipt(input: Readonly<{
  createdAt: string;
  catalog: Exp0001aCodexAuthorArtifactCatalog;
  classifications: Exp0001aCodexClassificationBook;
  pairwiseWorkOrder: Exp0001aCodexPairwiseWorkOrder;
  pairwiseResults: Exp0001aCodexPairwiseResultLedger;
  accountingLedger: Exp0001aCodexAccountingLedger;
}>): Exp0001aCodexAnalysisReceipt {
  const catalog = exp0001aCodexAuthorArtifactCatalogSchema.parse(input.catalog);
  const classifications = exp0001aCodexClassificationBookSchema.parse(input.classifications);
  const pairwiseWorkOrder = exp0001aCodexPairwiseWorkOrderSchema.parse(input.pairwiseWorkOrder);
  const pairwiseResults = verifyExp0001aCodexPairwiseResults({
    workOrder: pairwiseWorkOrder,
    resultLedger: input.pairwiseResults,
  });
  const accounting = exp0001aCodexAccountingLedgerSchema.parse(input.accountingLedger);
  timestampSchema.parse(input.createdAt);
  if (classifications.authorCatalogDigest !== catalog.catalogDigest
      || pairwiseWorkOrder.authorCatalogDigest !== catalog.catalogDigest
      || pairwiseWorkOrder.classificationBookDigest !== classifications.classificationBookDigest) {
    throw new Error("EXP0001A_ANALYSIS_CLASSIFICATION_CHAIN_DRIFT");
  }
  const accountingByAssignment = new Map(accounting.tasks.filter((task) => task.role === "author")
    .map((task) => [task.assignmentId, task]));
  const classificationByArtifact = new Map(classifications.classifications.map((entry) => [entry.artifactId, entry]));
  const attempts = catalog.entries.map((entry) => {
    const task = accountingByAssignment.get(entry.assignmentId);
    const classification = classificationByArtifact.get(entry.artifactId);
    if (!task || !classification) throw new Error(`EXP0001A_ANALYSIS_ATTEMPT_BINDING_MISSING:${entry.artifactId}`);
    return {
      assignmentId: entry.assignmentId,
      attemptId: entry.attemptId,
      accountingId: task.accountingId,
      pairId: entry.pairId,
      taskId: entry.taskId,
      taskFamily: entry.taskFamily,
      condition: entry.condition,
      accepted: classification.accepted,
      artifactComplete: entry.artifactComplete,
    };
  });
  const pairwiseWorkItemByPair = new Map(pairwiseWorkOrder.workItems.map((item) => [item.pairId, item]));
  const pairwisePreferences = pairwiseResults.results.map((result) => {
    const workItem = pairwiseWorkItemByPair.get(result.pairId);
    if (!workItem) throw new Error(`EXP0001A_ANALYSIS_PAIRWISE_WORK_ITEM_MISSING:${result.pairId}`);
    return {
      pairId: result.pairId,
      taskId: workItem.taskId,
      taskFamily: workItem.taskFamily,
      preferredCondition: result.preferredCondition,
    };
  });
  const report: Exp0001aCodexAnalysisReport = analyzeExp0001aCodexExperiment({
    attempts,
    pairwisePreferences,
    accountingLedger: accounting,
  });
  const pairwiseSummary = pairwiseResults.results.reduce((summary, result) => {
    summary[result.preferredCondition] += 1;
    return summary;
  }, { A0: 0, A1: 0, tie: 0, unavailable: 0 });
  const content = analysisReceiptContentSchema.parse({
    schemaVersion: "exp-0001a-codex-analysis-receipt/v1",
    protocolId: "EXP-0001A",
    createdAt: input.createdAt,
    authorCatalogDigest: catalog.catalogDigest,
    classificationBookDigest: classifications.classificationBookDigest,
    pairwiseWorkOrderDigest: pairwiseWorkOrder.workOrderDigest,
    pairwiseResultLedgerDigest: pairwiseResults.resultLedgerDigest,
    accountingLedgerDigest: contentDigest(accounting as unknown as Record<string, unknown>),
    analysisReport: report as unknown as JsonValue,
    analysisReportDigest: hashCanonicalJson(report as unknown as JsonValue),
    pairwiseSummary,
  });
  return Object.freeze(exp0001aCodexAnalysisReceiptSchema.parse({ ...content, receiptDigest: contentDigest(content) }));
}
