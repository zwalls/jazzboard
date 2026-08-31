import { createHash } from "node:crypto";

import { z } from "zod";

import {
  benchmarkTaskSchema,
  correctionScoringInputSchema,
  efficiencyScoringInputSchema,
  presentationScoringInputSchema,
  RESEARCH_SCORING_SCHEMA_VERSION,
  scoreCorrection,
  scoreEfficiency,
  scorePresentationUx,
} from "./scoring";
import { canonicalJson, hashCanonicalJson } from "./provenance-crypto";

export const EXP0001A_ATTEMPT_METRICS_SCHEMA_VERSION = "exp-0001a-attempt-metrics/v1" as const;
export const EXP0001A_ATTEMPT_METRICS_EXTRACTOR_VERSION = "exp-0001a-attempt-metrics-extractor/v1" as const;
export const EXP0001A_ATTEMPT_METRICS_EXTRACTOR_SOURCE_PATH = "src/lib/research/attempt-metrics.ts" as const;
export const EXP0001A_ATTEMPT_METRICS_SCORER_VERSION = `research-scoring/v${RESEARCH_SCORING_SCHEMA_VERSION}` as const;
export const EXP0001A_ATTEMPT_METRICS_SCORER_SOURCE_PATH = "src/lib/research/scoring.ts" as const;

const nonNegativeInteger = z.number().int().nonnegative();
const positive = z.number().finite().positive();
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const sha256Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const stableId = z.string().trim().min(1).max(200);

const artifactLeafSchema = z.object({
  path: z.string().min(1).max(500),
  bytes: nonNegativeInteger,
  sha256: sha256Hex,
}).strict();

const artifactSetSchema = z.object({
  algorithm: z.literal("sha256"),
  leaves: z.array(artifactLeafSchema),
  root: sha256Hex,
}).strict();

const tokenUsageSchema = z.object({
  inputTokens: nonNegativeInteger,
  uncachedInputTokens: nonNegativeInteger.optional(),
  cachedInputTokens: nonNegativeInteger.optional(),
  cacheWriteInputTokens: nonNegativeInteger.optional(),
  outputTokens: nonNegativeInteger,
  reasoningOutputTokens: nonNegativeInteger.optional(),
  totalTokens: nonNegativeInteger,
}).strict();

const authorResultSchema = z.object({
  termination: z.string().min(1),
  finalText: z.string(),
  toolCalls: nonNegativeInteger,
  usage: z.object({
    totals: tokenUsageSchema,
    byTurn: z.array(tokenUsageSchema.extend({ turn: z.number().int().positive() }).strict()),
    costInputs: z.object({
      uncachedInputTokens: nonNegativeInteger,
      cachedInputTokens: nonNegativeInteger,
      cacheWriteInputTokens: nonNegativeInteger,
      outputTokens: nonNegativeInteger,
    }).strict().optional(),
  }).strict(),
}).passthrough();

const attemptBundleSchema = z.object({
  schemaVersion: z.literal("clean-room-live-attempt/v1"),
  attemptId: stableId,
  mode: z.enum(["contract", "live"]),
  status: z.string().min(1),
  failure: z.unknown().nullable(),
  startedAt: z.string().datetime({ offset: true }),
  elapsedMs: nonNegativeInteger,
  attemptStartedAt: z.string().datetime({ offset: true }).nullable(),
  author: authorResultSchema,
  providerIntent: z.object({
    provider: z.literal("openai_responses"),
    requestedModelIdentifier: stableId,
    requestedServiceTier: z.literal("default"),
    immutableModelSnapshotVerified: z.literal(false),
  }).strict(),
  authorEvidenceRoot: artifactSetSchema.nullable(),
  artifactIndex: artifactSetSchema,
  isolation: z.object({
    authorContextClosedBeforeEvaluation: z.boolean(),
    evaluatorRole: z.string(),
    apiTransport: z.string(),
  }).passthrough(),
}).passthrough();

const eventSchema = z.object({
  sequence: nonNegativeInteger,
  elapsedMs: nonNegativeInteger,
  type: z.string().min(1).max(160),
  data: z.record(z.string(), z.unknown()),
}).strict();

const presentationCriteriaSchema = z.object({
  maximumTimeToFirstVisibleObjectMs: positive,
  minimumVisibleActivityRatio: z.number().finite().min(0).max(1),
  minimumRevealEventCount: z.number().int().positive(),
  minimumSemanticRevealOrderRate: z.number().finite().min(0).max(1),
  maximumFlickerCount: nonNegativeInteger,
  maximumDuplicatePresentationFrameCount: nonNegativeInteger,
  maximumViewportInstabilityCount: nonNegativeInteger,
  maximumHandoffGapMs: nonNegativeInteger,
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

export const attemptMetricsSpecSchema = z.object({
  costRatesUsdPerMillion: z.object({
    uncachedInput: z.number().finite().nonnegative(),
    cachedInput: z.number().finite().nonnegative(),
    cacheWriteInput: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
  }).strict(),
  presentationCriteria: presentationCriteriaSchema,
  efficiencyBudgets: efficiencyBudgetsSchema,
  qualityScaleId: stableId,
  possibleIssueOpportunityCount: nonNegativeInteger,
}).strict();

export const revisionAssessmentSchema = z.object({
  revisionId: stableId,
  roomRevision: z.number().int().nonnegative(),
  evidencePaths: z.array(z.string().min(1).max(500)).min(1).max(4),
  satisfiedCriterionRefs: z.array(stableId).max(20),
  issueKeys: z.array(stableId).max(2_000),
  semanticScore: z.number().finite().min(0).max(1),
  visualUsabilityScore: z.union([
    z.literal(0), z.literal(0.25), z.literal(0.5), z.literal(0.75), z.literal(1),
  ]),
  blockingViolationCount: nonNegativeInteger,
  qualityValue: z.number().finite(),
  usefulDraft: z.boolean(),
}).strict();

export const finalStateResultSchema = z.object({
  successfulArtifact: z.boolean(),
  evidencePaths: z.array(z.string().min(1).max(500)).min(1).max(4),
}).strict();

export const EXP0001A_REVISION_PACKET_SAMPLER_ID =
  "unique-author-revisions-first3-last3-plus-final/v1" as const;
export const EXP0001A_MEASUREMENT_RUBRIC_VERSION =
  "exp-0001a-revision-measurement-rubric/v1" as const;
export const EXP0001A_LONG_CONTEXT_INPUT_THRESHOLD_PER_REQUEST = 272_000 as const;
export const EXP0001A_LONG_CONTEXT_INPUT_RATE_MULTIPLIER = 2 as const;
export const EXP0001A_LONG_CONTEXT_OUTPUT_RATE_MULTIPLIER = 1.5 as const;

const measurementRubricContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_MEASUREMENT_RUBRIC_VERSION),
  criteria: z.array(z.object({
    criterionRef: z.string().regex(/^criterion_[0-9]{2}$/),
    criterionId: stableId,
  }).strict()).min(1).max(20),
  issueVocabulary: z.array(z.object({
    key: stableId,
    kind: z.enum(["criterion_failure", "blocking_visual", "blocking_integrity"]),
    criterionRef: z.string().regex(/^criterion_[0-9]{2}$/).nullable(),
    blocking: z.boolean(),
  }).strict()).min(1).max(32),
  semanticScoreDefinition: z.literal("count(satisfiedCriterionRefs) / count(criteria); indeterminate or unobservable criteria are not satisfied"),
  visualUsabilityScale: z.tuple([
    z.object({ score: z.literal(0), definition: z.literal("unreadable or unusable") }).strict(),
    z.object({ score: z.literal(0.25), definition: z.literal("major visual barriers prevent practical use") }).strict(),
    z.object({ score: z.literal(0.5), definition: z.literal("usable with material visual friction") }).strict(),
    z.object({ score: z.literal(0.75), definition: z.literal("clear and practically usable with minor defects") }).strict(),
    z.object({ score: z.literal(1), definition: z.literal("clear, coherent, and immediately usable") }).strict(),
  ]),
  qualityValueDefinition: z.literal("(semanticScore + visualUsabilityScore) / 2"),
  usefulDraftRule: z.object({
    minimumSemanticScore: z.literal(0.5),
    minimumVisualUsabilityScore: z.literal(0.5),
    requiresZeroBlockingViolations: z.literal(true),
  }).strict(),
}).strict();

export const revisionMeasurementRubricSchema = measurementRubricContentSchema.extend({
  rubricDigest: sha256Digest,
}).strict();
export type RevisionMeasurementRubric = z.infer<typeof revisionMeasurementRubricSchema>;

function createRevisionMeasurementRubric(task: z.infer<typeof benchmarkTaskSchema>): RevisionMeasurementRubric {
  const criteria = task.acceptanceCriteria.map((criterion, index) => ({
    criterionRef: `criterion_${String(index + 1).padStart(2, "0")}`,
    criterionId: criterion.id,
  }));
  const issueVocabulary = [
    ...criteria.map((criterion) => ({
      key: `criterion_failure:${criterion.criterionRef}`,
      kind: "criterion_failure" as const,
      criterionRef: criterion.criterionRef,
      blocking: false,
    })),
    { key: "blocking:illegible", kind: "blocking_visual" as const, criterionRef: null, blocking: true },
    { key: "blocking:off_frame", kind: "blocking_visual" as const, criterionRef: null, blocking: true },
    { key: "blocking:relationship_corruption", kind: "blocking_visual" as const, criterionRef: null, blocking: true },
    { key: "blocking:privacy_integrity", kind: "blocking_integrity" as const, criterionRef: null, blocking: true },
    { key: "blocking:protocol_violation", kind: "blocking_integrity" as const, criterionRef: null, blocking: true },
  ];
  const content = measurementRubricContentSchema.parse({
    schemaVersion: EXP0001A_MEASUREMENT_RUBRIC_VERSION,
    criteria,
    issueVocabulary,
    semanticScoreDefinition: "count(satisfiedCriterionRefs) / count(criteria); indeterminate or unobservable criteria are not satisfied",
    visualUsabilityScale: [
      { score: 0, definition: "unreadable or unusable" },
      { score: 0.25, definition: "major visual barriers prevent practical use" },
      { score: 0.5, definition: "usable with material visual friction" },
      { score: 0.75, definition: "clear and practically usable with minor defects" },
      { score: 1, definition: "clear, coherent, and immediately usable" },
    ],
    qualityValueDefinition: "(semanticScore + visualUsabilityScore) / 2",
    usefulDraftRule: {
      minimumSemanticScore: 0.5,
      minimumVisualUsabilityScore: 0.5,
      requiresZeroBlockingViolations: true,
    },
  });
  return revisionMeasurementRubricSchema.parse({ ...content, rubricDigest: hashCanonicalJson(content) });
}

export const blindedRevisionPacketInventoryItemSchema = z.object({
  revisionRef: z.string().regex(/^revision_[0-9]{2}$/),
  chronologyIndex: z.number().int().positive(),
  roomRevision: z.number().int().nonnegative(),
  kind: z.enum(["author_inspection", "final_spectator"]),
  pixel: z.object({
    path: z.string().min(1).max(500),
    digest: sha256Digest,
    bytes: nonNegativeInteger,
  }).strict(),
  semanticState: z.object({
    path: z.literal("spectator-final-state.json"),
    digest: sha256Digest,
    bytes: nonNegativeInteger,
  }).strict().nullable(),
}).strict();

const blindedRevisionAssessmentPacketContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-blinded-revision-assessment-packet/v1"),
  audience: z.literal("preselected_blinded_primary_measurement_reviewer"),
  binding: z.object({ taskDigest: sha256Digest }).strict(),
  measurementRubric: revisionMeasurementRubricSchema,
  sampler: z.object({
    id: z.literal(EXP0001A_REVISION_PACKET_SAMPLER_ID),
    eligibleAuthorRevisionCount: nonNegativeInteger,
    selectedAuthorRevisionCount: nonNegativeInteger.max(6),
    omittedAuthorRevisionCount: nonNegativeInteger,
    omittedRevisionsRoot: sha256Digest,
    deduplicatedAuthorCaptureCount: nonNegativeInteger,
    deduplicatedAuthorCapturesRoot: sha256Digest,
    finalRevisionDeduplicated: z.boolean(),
  }).strict(),
  inventory: z.array(blindedRevisionPacketInventoryItemSchema).max(7),
  finalRevisionRef: z.string().regex(/^revision_[0-9]{2}$/).nullable(),
}).strict();

export const blindedRevisionAssessmentPacketSchema = blindedRevisionAssessmentPacketContentSchema.extend({
  packetRoot: sha256Digest,
}).strict();

export type BlindedRevisionAssessmentPacket = z.infer<typeof blindedRevisionAssessmentPacketSchema>;

export function computeBlindedRevisionAssessmentPacketRoot(
  packetInput: Omit<BlindedRevisionAssessmentPacket, "packetRoot"> | BlindedRevisionAssessmentPacket,
): string {
  const { packetRoot: _packetRoot, ...content } = packetInput as BlindedRevisionAssessmentPacket;
  void _packetRoot;
  return hashCanonicalJson(blindedRevisionAssessmentPacketContentSchema.parse(content));
}

export function verifyBlindedRevisionAssessmentPacket(input: unknown): BlindedRevisionAssessmentPacket {
  const packet = blindedRevisionAssessmentPacketSchema.parse(input);
  const authorEntries = packet.inventory.filter((entry) => entry.kind === "author_inspection");
  const finalEntries = packet.inventory.filter((entry) => entry.kind === "final_spectator");
  const { rubricDigest, ...rubricContent } = packet.measurementRubric;
  const criterionRefs = packet.measurementRubric.criteria.map((criterion) => criterion.criterionRef);
  const issueKeys = packet.measurementRubric.issueVocabulary.map((issue) => issue.key);
  if (computeBlindedRevisionAssessmentPacketRoot(packet) !== packet.packetRoot) {
    throw new Error("Blinded revision assessment packet root is invalid.");
  }
  if (hashCanonicalJson(measurementRubricContentSchema.parse(rubricContent)) !== rubricDigest
      || new Set(criterionRefs).size !== criterionRefs.length
      || new Set(packet.measurementRubric.criteria.map((criterion) => criterion.criterionId)).size !== criterionRefs.length
      || new Set(issueKeys).size !== issueKeys.length
      || packet.measurementRubric.issueVocabulary.filter((issue) => issue.kind === "criterion_failure").some(
        (issue) => issue.criterionRef === null || !criterionRefs.includes(issue.criterionRef) || issue.blocking,
      )
      || new Set(packet.inventory.map((entry) => entry.revisionRef)).size !== packet.inventory.length
      || new Set(packet.inventory.map((entry) => entry.roomRevision)).size !== packet.inventory.length
      || packet.inventory.some((entry, index) => entry.chronologyIndex !== index + 1)
      || authorEntries.some((entry) => entry.semanticState !== null)
      || packet.sampler.selectedAuthorRevisionCount !== authorEntries.length
      || packet.sampler.eligibleAuthorRevisionCount
        !== packet.sampler.selectedAuthorRevisionCount + packet.sampler.omittedAuthorRevisionCount
      || (packet.finalRevisionRef === null ? finalEntries.length !== 0
        : finalEntries.length !== 1 || finalEntries[0].revisionRef !== packet.finalRevisionRef
          || finalEntries[0].semanticState === null)) {
    throw new Error("Blinded revision assessment packet inventory is inconsistent.");
  }
  return packet;
}

const frozenSourceBindingSchema = z.object({
  sourcePath: z.string().min(1).max(500),
  sourceDigest: sha256Digest,
  version: stableId,
}).strict();

export const attemptMetricsEvaluatorAuthoritySchema = z.object({
  reviewRegistryRoot: sha256Digest,
  policyDigest: sha256Digest,
  allowedIdentityCommitments: z.array(sha256Digest).min(1).max(32),
}).strict().superRefine((authority, context) => {
  const identities = authority.allowedIdentityCommitments;
  if (new Set(identities).size !== identities.length
      || identities.some((identity, index) => index > 0 && identities[index - 1] >= identity)) {
    context.addIssue({
      code: "custom",
      path: ["allowedIdentityCommitments"],
      message: "Evaluator identities must be unique and sorted.",
    });
  }
});

export const attemptMetricsFrozenBindingsSchema = z.object({
  taskDigest: sha256Digest,
  scoringSpecDigest: sha256Digest,
  extractor: frozenSourceBindingSchema.extend({
    sourcePath: z.literal(EXP0001A_ATTEMPT_METRICS_EXTRACTOR_SOURCE_PATH),
    version: z.literal(EXP0001A_ATTEMPT_METRICS_EXTRACTOR_VERSION),
  }).strict(),
  scorer: frozenSourceBindingSchema.extend({
    sourcePath: z.literal(EXP0001A_ATTEMPT_METRICS_SCORER_SOURCE_PATH),
    version: z.literal(EXP0001A_ATTEMPT_METRICS_SCORER_VERSION),
  }).strict(),
  evaluatorAuthority: attemptMetricsEvaluatorAuthoritySchema,
}).strict();

export type AttemptMetricsFrozenBindings = z.infer<typeof attemptMetricsFrozenBindingsSchema>;

const evaluatorAssessmentBindingSchema = z.object({
  attemptId: stableId,
  taskId: stableId,
  taskDigest: sha256Digest,
  scoringSpecDigest: sha256Digest,
  attemptBundleDigest: sha256Digest,
  artifactRoot: sha256Digest,
  authorEvidenceRoot: sha256Digest.nullable(),
  rawEvidenceRoot: sha256Digest,
  evaluatorPacketDigest: sha256Digest,
}).strict();

const evaluatorAssessmentContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-metrics-evaluator-assessment/v1"),
  protocolId: z.literal("EXP-0001A"),
  evaluator: z.object({
    evaluatorId: stableId,
    identityCommitment: sha256Digest,
    policyDigest: sha256Digest,
    reviewRegistryRoot: sha256Digest,
    recordDigest: sha256Digest,
  }).strict(),
  assessedAt: z.string().datetime({ offset: true }),
  binding: evaluatorAssessmentBindingSchema,
  revisionAssessments: z.array(revisionAssessmentSchema).max(32),
  finalStateResult: finalStateResultSchema.nullable(),
}).strict();

export const evaluatorAssessmentEnvelopeSchema = evaluatorAssessmentContentSchema.extend({
  envelopeDigest: sha256Digest,
}).strict();

export type EvaluatorAssessmentEnvelope = z.infer<typeof evaluatorAssessmentEnvelopeSchema>;

const revealObservationSchema = z.object({
  objectId: stableId,
  revealOrdinal: z.number().int().positive(),
  elapsedMs: nonNegativeInteger,
  semanticallyOrdered: z.boolean(),
}).strict();

export type AttemptArtifactBytes = Readonly<Record<string, string | Uint8Array>>;

export type AttemptMetricsExtractionInput = {
  attemptBundleBytes: string | Uint8Array;
  artifacts: AttemptArtifactBytes;
  task: unknown;
  spec: unknown;
  frozenBindings: unknown;
  /** Independently retained evaluator output. Raw assessment arrays are not accepted. */
  evaluatorAssessment?: unknown;
};

type Event = z.infer<typeof eventSchema>;
type TokenUsage = z.infer<typeof tokenUsageSchema>;

type Observable<T> = Readonly<{
  status: "observed";
  value: T;
  evidencePaths: readonly string[];
}> | Readonly<{
  status: "unobservable";
  reason: string;
  evidencePaths: readonly string[];
}>;

function observed<T>(value: T, ...evidencePaths: string[]): Observable<T> {
  return { status: "observed", value, evidencePaths };
}

function unobservable<T>(reason: string): Observable<T> {
  return { status: "unobservable", reason, evidencePaths: [] };
}

function bytes(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function bareSha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function computeExp0001aAttemptMetricsTaskDigest(taskInput: unknown): string {
  return hashCanonicalJson(benchmarkTaskSchema.parse(taskInput));
}

export function computeExp0001aAttemptMetricsSpecDigest(specInput: unknown): string {
  return hashCanonicalJson(attemptMetricsSpecSchema.parse(specInput));
}

export function computeEvaluatorAssessmentEnvelopeDigest(
  envelopeInput: Omit<EvaluatorAssessmentEnvelope, "envelopeDigest">,
): string {
  return hashCanonicalJson(evaluatorAssessmentContentSchema.parse(envelopeInput));
}

export function createEvaluatorAssessmentEnvelope(
  input: Omit<EvaluatorAssessmentEnvelope, "envelopeDigest">,
): EvaluatorAssessmentEnvelope {
  const content = evaluatorAssessmentContentSchema.parse(input);
  return evaluatorAssessmentEnvelopeSchema.parse({
    ...content,
    envelopeDigest: hashCanonicalJson(content),
  });
}

function hashArtifactSet(artifacts: AttemptArtifactBytes) {
  const leaves = Object.entries(artifacts).map(([artifactPath, contents]) => {
    const content = bytes(contents);
    return { path: artifactPath, bytes: content.byteLength, sha256: bareSha256(content) };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { algorithm: "sha256" as const, leaves, root: bareSha256(canonicalJson(leaves)) };
}

function exactJson(value: string | Uint8Array, label: string): unknown {
  try {
    return JSON.parse(bytes(value).toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateEvaluatorMeasurementsAgainstPacket(
  envelope: EvaluatorAssessmentEnvelope,
  packet: BlindedRevisionAssessmentPacket,
): void {
  const assessments = envelope.revisionAssessments;
  if (assessments.length !== packet.inventory.length) {
    throw new Error("Evaluator assessment must cover every bounded revision-packet item exactly once.");
  }
  const byRevisionId = new Map(assessments.map((assessment) => [assessment.revisionId, assessment]));
  if (byRevisionId.size !== assessments.length) {
    throw new Error("Evaluator assessment contains duplicate revision identifiers.");
  }
  const criterionRefs = packet.measurementRubric.criteria.map((criterion) => criterion.criterionRef);
  const criterionRefSet = new Set(criterionRefs);
  const allowedIssues = new Map(packet.measurementRubric.issueVocabulary.map((issue) => [issue.key, issue]));
  const failureKeyByCriterion = new Map(packet.measurementRubric.issueVocabulary
    .filter((issue) => issue.kind === "criterion_failure" && issue.criterionRef !== null)
    .map((issue) => [issue.criterionRef as string, issue.key]));
  for (const item of packet.inventory) {
    const assessment = byRevisionId.get(item.revisionRef);
    if (!assessment || assessment.roomRevision !== item.roomRevision) {
      throw new Error("Evaluator assessment revision identity or room revision drifted from the bounded packet.");
    }
    const expectedEvidencePaths = [item.pixel.path, ...(item.semanticState ? [item.semanticState.path] : [])].sort();
    if (!sameJson([...assessment.evidencePaths].sort(), expectedEvidencePaths)) {
      throw new Error("Evaluator assessment evidence paths drifted from the exact bounded packet item.");
    }
    const satisfied = new Set(assessment.satisfiedCriterionRefs);
    const issues = new Set(assessment.issueKeys);
    const expectedFailureIssues = criterionRefs.filter((criterionRef) => !satisfied.has(criterionRef))
      .map((criterionRef) => failureKeyByCriterion.get(criterionRef));
    const actualFailureIssues = assessment.issueKeys.filter((issueKey) =>
      allowedIssues.get(issueKey)?.kind === "criterion_failure");
    const blockingCount = assessment.issueKeys.filter((issueKey) => allowedIssues.get(issueKey)?.blocking).length;
    const semanticScore = satisfied.size / criterionRefs.length;
    const qualityValue = (semanticScore + assessment.visualUsabilityScore) / 2;
    const usefulDraft = semanticScore >= packet.measurementRubric.usefulDraftRule.minimumSemanticScore
      && assessment.visualUsabilityScore >= packet.measurementRubric.usefulDraftRule.minimumVisualUsabilityScore
      && blockingCount === 0;
    if (satisfied.size !== assessment.satisfiedCriterionRefs.length
        || [...satisfied].some((criterionRef) => !criterionRefSet.has(criterionRef))
        || issues.size !== assessment.issueKeys.length
        || [...issues].some((issueKey) => !allowedIssues.has(issueKey))
        || !sameJson([...actualFailureIssues].sort(), [...expectedFailureIssues].sort())
        || Math.abs(assessment.semanticScore - semanticScore) > 1e-12
        || assessment.blockingViolationCount !== blockingCount
        || Math.abs(assessment.qualityValue - qualityValue) > 1e-12
        || assessment.usefulDraft !== usefulDraft) {
      throw new Error("Evaluator assessment does not follow the frozen revision measurement rubric.");
    }
  }
  if (packet.finalRevisionRef === null) {
    if (envelope.finalStateResult !== null) {
      throw new Error("Evaluator final-state result exists without final spectator evidence.");
    }
    return;
  }
  const finalItem = packet.inventory.find((item) => item.revisionRef === packet.finalRevisionRef);
  if (!finalItem || finalItem.semanticState === null || envelope.finalStateResult === null
      || !sameJson([...envelope.finalStateResult.evidencePaths].sort(), [finalItem.pixel.path, finalItem.semanticState.path].sort())) {
    throw new Error("Evaluator final-state result is not bound to the exact final spectator evidence.");
  }
}

function validateArtifactEvidence(bundle: z.infer<typeof attemptBundleSchema>, artifacts: AttemptArtifactBytes) {
  const expectedPaths = bundle.artifactIndex.leaves.map((leaf) => leaf.path).sort();
  const suppliedPaths = Object.keys(artifacts).sort();
  if (!sameJson(expectedPaths, suppliedPaths)) {
    throw new Error("Supplied artifact paths do not exactly match the frozen attempt artifact index.");
  }
  const actual = hashArtifactSet(artifacts);
  if (!sameJson(actual, bundle.artifactIndex)) throw new Error("Attempt artifact hashes or artifact root do not verify.");

  if (bundle.authorEvidenceRoot) {
    const authorArtifacts: Record<string, string | Uint8Array> = {};
    for (const leaf of bundle.authorEvidenceRoot.leaves) {
      if (!(leaf.path in artifacts)) throw new Error(`Author evidence is missing ${leaf.path}.`);
      authorArtifacts[leaf.path] = artifacts[leaf.path];
    }
    const authorActual = hashArtifactSet(authorArtifacts);
    if (!sameJson(authorActual, bundle.authorEvidenceRoot)) throw new Error("Author evidence root does not verify.");
    const seal = exactJson(artifacts["author-evidence-seal.json"], "author-evidence-seal.json");
    if (!sameJson(seal, bundle.authorEvidenceRoot)) throw new Error("Author evidence seal disagrees with the attempt bundle.");
  }

  const authorFinal = authorResultSchema.parse(exactJson(artifacts["author-final.json"], "author-final.json"));
  if (!sameJson(authorFinal, bundle.author)) throw new Error("author-final.json disagrees with the attempt bundle.");
  return actual;
}

function parseEventLog(contents: string | Uint8Array, label: string): { events: Event[]; lineBytes: number[] } {
  const text = bytes(contents).toString("utf8");
  const rawLines = text.split("\n");
  if (rawLines.at(-1) === "") rawLines.pop();
  const events = rawLines.map((line, index) => {
    try {
      return eventSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  let priorElapsed = -1;
  events.forEach((event, index) => {
    if (event.sequence !== index) throw new Error(`${label} event sequence is not contiguous at index ${index}.`);
    if (event.elapsedMs < priorElapsed) throw new Error(`${label} elapsed times are out of order at index ${index}.`);
    priorElapsed = event.elapsedMs;
  });
  return { events, lineBytes: rawLines.map((line) => Buffer.byteLength(`${line}\n`)) };
}

function integerData(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function stringData(data: Record<string, unknown>, key: string): string | null {
  return typeof data[key] === "string" ? data[key] : null;
}

function validateEventPairs(events: readonly Event[], author: z.infer<typeof authorResultSchema>) {
  let responseTurn = 0;
  let openResponse: number | null = null;
  let toolOrdinal = 0;
  let openTool: { ordinal: number; name: string } | null = null;
  const completedUsage: Array<TokenUsage & { turn: number }> = [];
  let cumulative = {
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  for (const event of events) {
    if (event.type === "responses_request_started") {
      const turn = integerData(event.data, "turn");
      if (openResponse !== null || turn !== responseTurn + 1) throw new Error("Responses events are malformed or out of order.");
      openResponse = turn;
      responseTurn = turn;
    } else if (event.type === "responses_request_completed") {
      const turn = integerData(event.data, "turn");
      if (turn === null || turn !== openResponse) throw new Error("Responses completion has no matching start.");
      const turnUsage = tokenUsageSchema.extend({ turn: z.number().int().positive() }).strict().parse({
        turn,
        ...(event.data.usage as object),
      });
      completedUsage.push(turnUsage);
      cumulative = {
        inputTokens: cumulative.inputTokens + turnUsage.inputTokens,
        uncachedInputTokens: cumulative.uncachedInputTokens + (turnUsage.uncachedInputTokens ?? 0),
        cachedInputTokens: cumulative.cachedInputTokens + (turnUsage.cachedInputTokens ?? 0),
        cacheWriteInputTokens: cumulative.cacheWriteInputTokens + (turnUsage.cacheWriteInputTokens ?? 0),
        outputTokens: cumulative.outputTokens + turnUsage.outputTokens,
        reasoningOutputTokens: cumulative.reasoningOutputTokens + (turnUsage.reasoningOutputTokens ?? 0),
        totalTokens: cumulative.totalTokens + turnUsage.totalTokens,
      };
      const declaredCumulative = tokenUsageSchema.parse(event.data.cumulativeUsage);
      if (!sameJson(cumulative, declaredCumulative)) throw new Error("Cumulative response usage is inconsistent.");
      openResponse = null;
    } else if (event.type === "responses_request_failed") {
      const turn = integerData(event.data, "turn");
      if (turn === null || turn !== openResponse) throw new Error("Responses failure has no matching start.");
      openResponse = null;
    } else if (event.type === "author_tool_started") {
      const ordinal = integerData(event.data, "ordinal");
      const name = stringData(event.data, "name");
      if (openTool || ordinal !== toolOrdinal + 1 || !name) throw new Error("Author tool events are malformed or out of order.");
      toolOrdinal = ordinal;
      openTool = { ordinal, name };
    } else if (event.type === "author_pixel_captured") {
      const ordinal = integerData(event.data, "ordinal");
      const name = stringData(event.data, "name");
      if (!openTool || ordinal !== openTool.ordinal || name !== openTool.name) {
        throw new Error("Pixel capture has no matching active author tool call.");
      }
    } else if (event.type === "author_tool_completed" || event.type === "author_tool_failed") {
      const ordinal = integerData(event.data, "ordinal");
      const name = stringData(event.data, "name");
      if (!openTool || ordinal !== openTool.ordinal || name !== openTool.name) {
        throw new Error("Author tool completion has no matching start.");
      }
      openTool = null;
    }
  }
  if (openTool) throw new Error("Author event log ends with an unmatched tool call.");
  if (openResponse !== null && author.termination !== "runner_failed") {
    throw new Error("Completed attempt ends with an unmatched Responses request.");
  }
  if (toolOrdinal !== author.toolCalls) throw new Error("Author tool-call total disagrees with the event log.");
  if (!sameJson(completedUsage, author.usage.byTurn)) throw new Error("Author per-turn usage disagrees with completed response events.");
}

function validateTokenUsage(author: z.infer<typeof authorResultSchema>) {
  const totals = author.usage.totals;
  if (totals.totalTokens !== totals.inputTokens + totals.outputTokens) throw new Error("Author totalTokens is inconsistent.");
  if ((totals.reasoningOutputTokens ?? 0) > totals.outputTokens) throw new Error("Reasoning output exceeds total output.");
  const detailed = [totals.uncachedInputTokens, totals.cachedInputTokens, totals.cacheWriteInputTokens]
    .every((value) => value !== undefined);
  if (detailed && totals.inputTokens !== (totals.uncachedInputTokens ?? 0)
      + (totals.cachedInputTokens ?? 0) + (totals.cacheWriteInputTokens ?? 0)) {
    throw new Error("Detailed input token categories do not sum to inputTokens.");
  }
  const fields: Array<keyof TokenUsage> = [
    "inputTokens", "uncachedInputTokens", "cachedInputTokens", "cacheWriteInputTokens",
    "outputTokens", "reasoningOutputTokens", "totalTokens",
  ];
  for (const field of fields) {
    if (totals[field] === undefined) continue;
    const values = author.usage.byTurn.map((turn) => turn[field]);
    if (values.some((value) => value === undefined)) {
      throw new Error(`Author ${field} is present in totals but missing from one or more retained turns.`);
    }
    const sum = values.reduce<number>((total, value) => total + (value as number), 0);
    if (sum !== totals[field]) throw new Error(`Author ${field} total disagrees with per-turn usage.`);
  }
  if (author.usage.costInputs) {
    const expected = {
      uncachedInputTokens: totals.uncachedInputTokens ?? totals.inputTokens,
      cachedInputTokens: totals.cachedInputTokens ?? 0,
      cacheWriteInputTokens: totals.cacheWriteInputTokens ?? 0,
      outputTokens: totals.outputTokens,
    };
    if (!sameJson(expected, author.usage.costInputs)) throw new Error("Author cost inputs disagree with token totals.");
  }
  return detailed;
}

function resultData(event: Event): Record<string, unknown> | null {
  const result = event.data.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const data = (result as Record<string, unknown>).data;
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
}

function successfulMutation(event: Event): boolean {
  if (event.type !== "author_tool_completed") return false;
  const result = event.data.result as Record<string, unknown> | undefined;
  if (result?.ok !== true) return false;
  const data = resultData(event);
  const outcome = data?.outcome;
  const changed = [data?.changedObjectIds, data?.changedDiagramIds]
    .some((value) => Array.isArray(value) && value.length > 0);
  return outcome === "drafted" || outcome === "applied" || changed;
}

function artifactDigest(artifacts: AttemptArtifactBytes, artifactPath: string): string {
  if (!(artifactPath in artifacts)) throw new Error(`Assessment references missing artifact ${artifactPath}.`);
  return `sha256:${bareSha256(bytes(artifacts[artifactPath]))}`;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function assertStructurallyValidPng(artifacts: AttemptArtifactBytes, artifactPath: string): void {
  if (!(artifactPath in artifacts)) throw new Error(`PNG evidence is missing ${artifactPath}.`);
  const content = bytes(artifacts[artifactPath]);
  if (content.byteLength < 45 || !content.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error(`Pixel evidence ${artifactPath} is not a structurally valid PNG.`);
  }
  let offset = PNG_SIGNATURE.byteLength;
  let chunkOrdinal = 0;
  let sawIdat = false;
  let sawIend = false;
  while (offset < content.byteLength) {
    if (offset + 12 > content.byteLength) throw new Error(`Pixel evidence ${artifactPath} has a truncated PNG chunk.`);
    const chunkLength = content.readUInt32BE(offset);
    const chunkType = content.subarray(offset + 4, offset + 8).toString("ascii");
    const nextOffset = offset + 12 + chunkLength;
    if (nextOffset > content.byteLength) throw new Error(`Pixel evidence ${artifactPath} has an invalid PNG chunk length.`);
    if (chunkOrdinal === 0) {
      if (chunkType !== "IHDR" || chunkLength !== 13) throw new Error(`Pixel evidence ${artifactPath} lacks a valid PNG IHDR.`);
      const width = content.readUInt32BE(offset + 8);
      const height = content.readUInt32BE(offset + 12);
      if (width === 0 || height === 0) throw new Error(`Pixel evidence ${artifactPath} has invalid PNG dimensions.`);
    }
    if (chunkType === "IDAT") sawIdat = true;
    if (chunkType === "IEND") {
      if (chunkLength !== 0 || nextOffset !== content.byteLength) {
        throw new Error(`Pixel evidence ${artifactPath} has an invalid PNG terminator.`);
      }
      sawIend = true;
    }
    offset = nextOffset;
    chunkOrdinal += 1;
  }
  if (!sawIdat || !sawIend) throw new Error(`Pixel evidence ${artifactPath} lacks PNG image data or terminator.`);
}

function rawEvidenceProvenance(input: {
  bundleBytes: Uint8Array;
  bundle: z.infer<typeof attemptBundleSchema>;
  artifacts: AttemptArtifactBytes;
  verifiedArtifactRoot: string;
}) {
  const spectatorPixelPaths = Object.keys(input.artifacts)
    .filter((artifactPath) => /^spectator-final-r\d+\.png$/.test(artifactPath))
    .sort();
  const content = {
    attemptBundleDigest: `sha256:${bareSha256(input.bundleBytes)}`,
    artifactRoot: `sha256:${input.verifiedArtifactRoot}`,
    authorEvidenceRoot: input.bundle.authorEvidenceRoot ? `sha256:${input.bundle.authorEvidenceRoot.root}` : null,
    authorEventsDigest: artifactDigest(input.artifacts, "author-events.jsonl"),
    coordinatorEventsDigest: artifactDigest(input.artifacts, "coordinator-events.jsonl"),
    authorFinalDigest: artifactDigest(input.artifacts, "author-final.json"),
    spectatorFinalStateDigest: "spectator-final-state.json" in input.artifacts
      ? artifactDigest(input.artifacts, "spectator-final-state.json") : null,
    spectatorFinalPixelDigests: spectatorPixelPaths.map((artifactPath) => ({
      path: artifactPath,
      digest: artifactDigest(input.artifacts, artifactPath),
    })),
  };
  return freezeDeep({ ...content, rawEvidenceRoot: hashCanonicalJson(content) });
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

/** Builds the exact treatment-neutral visual packet seen by the preselected
 * measurement primary. Selection depends only on committed pixel chronology:
 * after the final spectator revision is deduplicated, retain every unique
 * author-inspection revision when there are at most six; otherwise retain the
 * first three and last three. The exact final spectator state/PNG is appended
 * once and is never selected based on quality or reviewer output. */
export function createBlindedRevisionAssessmentPacket(input: {
  artifacts: AttemptArtifactBytes;
  task: unknown;
}): BlindedRevisionAssessmentPacket {
  const task = benchmarkTaskSchema.parse(input.task);
  const taskDigest = computeExp0001aAttemptMetricsTaskDigest(task);
  const measurementRubric = createRevisionMeasurementRubric(task);
  const finalStatePath = "spectator-final-state.json";
  const finalState = finalStatePath in input.artifacts
    ? exactJson(input.artifacts[finalStatePath], finalStatePath) as Record<string, unknown>
    : null;
  const finalData = finalState?.data && typeof finalState.data === "object"
    ? finalState.data as Record<string, unknown> : null;
  const finalRoom = finalData?.room && typeof finalData.room === "object"
    ? finalData.room as Record<string, unknown> : null;
  const finalRoomRevision = Number.isSafeInteger(finalRoom?.roomRevision)
    ? Number(finalRoom?.roomRevision)
    : Number.isSafeInteger(finalData?.roomRevision) ? Number(finalData?.roomRevision) : null;
  const finalPixelPath = finalRoomRevision === null ? null : `spectator-final-r${finalRoomRevision}.png`;
  if (finalPixelPath && finalPixelPath in input.artifacts) assertStructurallyValidPng(input.artifacts, finalPixelPath);

  const authorLog = parseEventLog(input.artifacts["author-events.jsonl"], "author-events.jsonl").events;
  const pixelEvents = authorLog.filter((event) => event.type === "author_pixel_captured");
  const indexedPixelPaths = Object.keys(input.artifacts)
    .filter((artifactPath) => /^author-pixels\/call-[0-9]{4}-r[0-9]+\.png$/.test(artifactPath))
    .sort();
  const authorCandidates = pixelEvents.map((event) => {
    const toolOrdinal = integerData(event.data, "ordinal");
    const toolName = stringData(event.data, "name");
    const roomRevision = integerData(event.data, "roomRevision");
    const artifactPath = stringData(event.data, "artifactPath");
    const declaredSha256 = stringData(event.data, "sha256");
    if (toolOrdinal === null || !["inspect_canvas_scope", "render_canvas_preview"].includes(toolName ?? "")
        || roomRevision === null || artifactPath === null || declaredSha256 === null
        || artifactPath !== `author-pixels/call-${String(toolOrdinal).padStart(4, "0")}-r${roomRevision}.png`) {
      throw new Error("Revision assessment packet contains malformed or non-inspection pixel provenance.");
    }
    const starts = authorLog.filter((candidate) => candidate.type === "author_tool_started"
      && candidate.sequence < event.sequence && integerData(candidate.data, "ordinal") === toolOrdinal
      && stringData(candidate.data, "name") === toolName);
    const completions = authorLog.filter((candidate) => candidate.type === "author_tool_completed"
      && candidate.sequence > event.sequence && integerData(candidate.data, "ordinal") === toolOrdinal
      && stringData(candidate.data, "name") === toolName);
    const completionData = completions.length === 1 ? resultData(completions[0]) : null;
    const completionResult = completions.length === 1 ? completions[0].data.result as Record<string, unknown> : null;
    const scene = completionData?.sceneContext && typeof completionData.sceneContext === "object"
      ? completionData.sceneContext as Record<string, unknown> : null;
    const revisions = scene?.revisions && typeof scene.revisions === "object"
      ? scene.revisions as Record<string, unknown> : null;
    if (starts.length !== 1 || completions.length !== 1 || completionResult?.ok !== true || completionData === null
        || integerData(revisions ?? {}, "roomRevision") !== roomRevision) {
      throw new Error("Revision packet pixel lacks one matching completed inspection at the same room revision.");
    }
    assertStructurallyValidPng(input.artifacts, artifactPath);
    const digest = artifactDigest(input.artifacts, artifactPath);
    if (digest !== `sha256:${declaredSha256}`) {
      throw new Error("Revision packet pixel digest does not match its author capture event.");
    }
    return {
      artifactPath,
      toolOrdinal,
      eventSequence: event.sequence,
      roomRevision,
      digest,
      bytes: bytes(input.artifacts[artifactPath]).byteLength,
    };
  }).sort((left, right) => left.eventSequence - right.eventSequence);
  const eventPaths = authorCandidates.map((candidate) => candidate.artifactPath).sort();
  if (!sameJson(eventPaths, indexedPixelPaths)) {
    throw new Error("Author pixel artifacts do not reconcile exactly to verified capture events.");
  }
  const uniqueByRevision = new Map<number, typeof authorCandidates[number]>();
  const duplicateCaptures: Array<{
    roomRevision: number;
    retainedEventSequence: number;
    retainedPixelDigest: string;
    duplicateEventSequence: number;
    duplicateToolOrdinal: number;
    duplicatePixelDigest: string;
  }> = [];
  for (const candidate of authorCandidates) {
    const retained = uniqueByRevision.get(candidate.roomRevision);
    if (retained) {
      duplicateCaptures.push({
        roomRevision: candidate.roomRevision,
        retainedEventSequence: retained.eventSequence,
        retainedPixelDigest: retained.digest,
        duplicateEventSequence: candidate.eventSequence,
        duplicateToolOrdinal: candidate.toolOrdinal,
        duplicatePixelDigest: candidate.digest,
      });
      continue;
    }
    uniqueByRevision.set(candidate.roomRevision, candidate);
  }
  const deduplicatedAuthorCapturesRoot = hashCanonicalJson({
    schemaVersion: "exp-0001a-deduplicated-author-captures/v1",
    samplerId: EXP0001A_REVISION_PACKET_SAMPLER_ID,
    rule: "earliest-valid-capture-per-room-revision",
    duplicates: duplicateCaptures,
  });
  const finalRevisionDeduplicated = finalRoomRevision !== null && uniqueByRevision.delete(finalRoomRevision);
  const eligible = [...uniqueByRevision.values()];
  const selected = eligible.length <= 6 ? eligible : [...eligible.slice(0, 3), ...eligible.slice(-3)];
  const selectedPaths = new Set(selected.map((candidate) => candidate.artifactPath));
  const omitted = eligible.filter((candidate) => !selectedPaths.has(candidate.artifactPath));
  const omittedRevisionsRoot = hashCanonicalJson({
    schemaVersion: "exp-0001a-omitted-revision-root/v1",
    samplerId: EXP0001A_REVISION_PACKET_SAMPLER_ID,
    revisions: omitted.map((candidate, index) => ({
      chronologyIndex: eligible.indexOf(candidate) + 1,
      omittedIndex: index + 1,
      roomRevision: candidate.roomRevision,
      pixelDigest: candidate.digest,
    })),
  });
  const inventory: z.infer<typeof blindedRevisionPacketInventoryItemSchema>[] = selected.map((candidate, index) => ({
    revisionRef: `revision_${String(index + 1).padStart(2, "0")}`,
    chronologyIndex: index + 1,
    roomRevision: candidate.roomRevision,
    kind: "author_inspection",
    pixel: { path: candidate.artifactPath, digest: candidate.digest, bytes: candidate.bytes },
    semanticState: null,
  }));
  let finalRevisionRef: string | null = null;
  if (finalRoomRevision !== null && finalPixelPath && finalPixelPath in input.artifacts && finalState) {
    finalRevisionRef = `revision_${String(inventory.length + 1).padStart(2, "0")}`;
    inventory.push({
      revisionRef: finalRevisionRef,
      chronologyIndex: inventory.length + 1,
      roomRevision: finalRoomRevision,
      kind: "final_spectator",
      pixel: {
        path: finalPixelPath,
        digest: artifactDigest(input.artifacts, finalPixelPath),
        bytes: bytes(input.artifacts[finalPixelPath]).byteLength,
      },
      semanticState: {
        path: finalStatePath,
        digest: artifactDigest(input.artifacts, finalStatePath),
        bytes: bytes(input.artifacts[finalStatePath]).byteLength,
      },
    });
  }
  const content = blindedRevisionAssessmentPacketContentSchema.parse({
    schemaVersion: "exp-0001a-blinded-revision-assessment-packet/v1",
    audience: "preselected_blinded_primary_measurement_reviewer",
    binding: { taskDigest },
    measurementRubric,
    sampler: {
      id: EXP0001A_REVISION_PACKET_SAMPLER_ID,
      eligibleAuthorRevisionCount: eligible.length,
      selectedAuthorRevisionCount: selected.length,
      omittedAuthorRevisionCount: omitted.length,
      omittedRevisionsRoot,
      deduplicatedAuthorCaptureCount: duplicateCaptures.length,
      deduplicatedAuthorCapturesRoot,
      finalRevisionDeduplicated,
    },
    inventory,
    finalRevisionRef,
  });
  return freezeDeep(blindedRevisionAssessmentPacketSchema.parse({
    ...content,
    packetRoot: hashCanonicalJson(content),
  }));
}

function roundedCost(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function actualAuthorTurnCost(
  turns: readonly (TokenUsage & { turn: number })[],
  rates: z.infer<typeof attemptMetricsSpecSchema>["costRatesUsdPerMillion"],
): number {
  return roundedCost(turns.reduce((total, turn) => {
    if (turn.uncachedInputTokens === undefined || turn.cachedInputTokens === undefined
        || turn.cacheWriteInputTokens === undefined) {
      throw new Error("Per-turn token classes are required for exact long-context cost accounting.");
    }
    const longContext = turn.inputTokens > EXP0001A_LONG_CONTEXT_INPUT_THRESHOLD_PER_REQUEST;
    const inputMultiplier = longContext ? EXP0001A_LONG_CONTEXT_INPUT_RATE_MULTIPLIER : 1;
    const outputMultiplier = longContext ? EXP0001A_LONG_CONTEXT_OUTPUT_RATE_MULTIPLIER : 1;
    return total + (
      turn.uncachedInputTokens * rates.uncachedInput * inputMultiplier
      + turn.cachedInputTokens * rates.cachedInput * inputMultiplier
      + turn.cacheWriteInputTokens * rates.cacheWriteInput * inputMultiplier
      + turn.outputTokens * rates.output * outputMultiplier
    ) / 1_000_000;
  }, 0));
}

export function identifyBoundedSampleFirstUsefulRevision(input: {
  omittedAuthorRevisionCount: number;
  selectedRoomRevisions: readonly number[];
  usefulRoomRevisions: readonly number[];
}): Readonly<
  | { status: "identified"; roomRevision: number }
  | { status: "not_reached"; reason: string }
  | { status: "left_censored"; reason: string }
> {
  const omitted = z.number().int().nonnegative().parse(input.omittedAuthorRevisionCount);
  const selected = z.array(z.number().int().nonnegative()).max(7).parse(input.selectedRoomRevisions);
  const useful = new Set(z.array(z.number().int().nonnegative()).parse(input.usefulRoomRevisions));
  if (new Set(selected).size !== selected.length || [...useful].some((revision) => !selected.includes(revision))) {
    throw new Error("Useful-draft identification input must reference unique selected author revisions only.");
  }
  const firstUseful = selected.find((revision) => useful.has(revision));
  if (omitted === 0) {
    return firstUseful === undefined
      ? { status: "not_reached", reason: "No fully observed revision is useful." }
      : { status: "identified", roomRevision: firstUseful };
  }
  const observedPrefix = new Set(selected.slice(0, 3));
  if (firstUseful !== undefined && observedPrefix.has(firstUseful)) {
    return { status: "identified", roomRevision: firstUseful };
  }
  return {
    status: "left_censored",
    reason: firstUseful === undefined
      ? "No sampled revision is useful, but omitted middle revisions may contain an earlier useful state."
      : "The first sampled useful revision occurs after omitted middle revisions that may have become useful earlier.",
  };
}

export function extractExp0001aAttemptMetrics(input: AttemptMetricsExtractionInput) {
  const legacyInput = input as unknown as Record<string, unknown>;
  if (Object.hasOwn(legacyInput, "revisionAssessments") || Object.hasOwn(legacyInput, "finalStateResult")) {
    throw new Error(
      "Unbound revisionAssessments/finalStateResult are forbidden; supply a provenance-bound evaluatorAssessment envelope.",
    );
  }
  const bundleBytes = bytes(input.attemptBundleBytes);
  const bundle = attemptBundleSchema.parse(exactJson(bundleBytes, "attempt-bundle.json"));
  const task = benchmarkTaskSchema.parse(input.task);
  const spec = attemptMetricsSpecSchema.parse(input.spec);
  const frozenBindings = attemptMetricsFrozenBindingsSchema.parse(input.frozenBindings);
  const taskDigest = computeExp0001aAttemptMetricsTaskDigest(task);
  const scoringSpecDigest = computeExp0001aAttemptMetricsSpecDigest(spec);
  if (taskDigest !== frozenBindings.taskDigest) {
    throw new Error("Task bytes do not match the execution-authorized frozen task digest.");
  }
  if (scoringSpecDigest !== frozenBindings.scoringSpecDigest) {
    throw new Error("Scoring spec bytes do not match the execution-authorized frozen scoring-spec digest.");
  }
  const verifiedArtifactSet = validateArtifactEvidence(bundle, input.artifacts);
  const rawEvidence = rawEvidenceProvenance({
    bundleBytes,
    bundle,
    artifacts: input.artifacts,
    verifiedArtifactRoot: verifiedArtifactSet.root,
  });
  const authorLog = parseEventLog(input.artifacts["author-events.jsonl"], "author-events.jsonl");
  const coordinatorLog = parseEventLog(input.artifacts["coordinator-events.jsonl"], "coordinator-events.jsonl");
  const authorBrief = exactJson(input.artifacts["author-brief.json"], "author-brief.json");
  if (!authorBrief || typeof authorBrief !== "object"
      || typeof (authorBrief as Record<string, unknown>).brief !== "string") {
    throw new Error("author-brief.json must retain the exact delivered brief bytes.");
  }
  const deliveredBriefEvents = authorLog.events.filter((event) => event.type === "brief_delivered");
  if (authorLog.events.length > 0 && deliveredBriefEvents.length !== 1) {
    throw new Error("A non-empty author log must retain exactly one brief_delivered event.");
  }
  if (deliveredBriefEvents.length === 1) {
    const retainedBriefHash = stringData(deliveredBriefEvents[0].data, "briefHash");
    const actualBriefHash = bareSha256((authorBrief as Record<string, unknown>).brief as string);
    if (retainedBriefHash !== actualBriefHash) {
      throw new Error("brief_delivered does not match the exact retained author brief.");
    }
  }
  validateEventPairs(authorLog.events, bundle.author);
  const detailedUsage = validateTokenUsage(bundle.author);
  if (authorLog.events.some((event) => event.elapsedMs > bundle.elapsedMs)
      || coordinatorLog.events.some((event) => event.elapsedMs > bundle.elapsedMs)) {
    throw new Error("Event elapsed time exceeds the attempt wall time.");
  }

  const firstDraft = authorLog.events.find((event) => resultData(event)?.outcome === "drafted");
  const firstMutation = authorLog.events.find(successfulMutation);
  const pixelEvents = authorLog.events.filter((event) => event.type === "author_pixel_captured");
  const authorWallMs = authorLog.events.at(-1)?.elapsedMs ?? null;
  const failedToolOrdinals = new Set(authorLog.events.flatMap((event) => {
    if (event.type === "author_tool_failed" || event.type === "author_tool_returned_failure") {
      const ordinal = integerData(event.data, "ordinal");
      return ordinal === null ? [] : [ordinal];
    }
    if (event.type === "author_tool_completed") {
      const result = event.data.result as Record<string, unknown> | undefined;
      const ordinal = integerData(event.data, "ordinal");
      return result?.ok === false && ordinal !== null ? [ordinal] : [];
    }
    return [];
  }));
  const toolStarts = authorLog.events.filter((event) => event.type === "author_tool_started");
  const retryAfterFailureCount = [...failedToolOrdinals].filter((ordinal) => {
    const failed = toolStarts.find((event) => integerData(event.data, "ordinal") === ordinal);
    const name = failed ? stringData(failed.data, "name") : null;
    return Boolean(name && toolStarts.some((event) => (
      integerData(event.data, "ordinal") !== null
        && (integerData(event.data, "ordinal") as number) > ordinal
        && stringData(event.data, "name") === name
    )));
  }).length;
  const receiptEventTypes = new Set(["author_tool_completed", "author_tool_failed"]);
  const receiptBytes = authorLog.events.reduce((total, event, index) =>
    total + (receiptEventTypes.has(event.type) ? authorLog.lineBytes[index] : 0), 0);

  const responseStarts = authorLog.events.filter((event) => event.type === "responses_request_started");
  const responseEvents = authorLog.events.filter((event) => event.type === "responses_request_completed");
  const providerModels = [...new Set(responseEvents.flatMap((event) => {
    const provider = event.data.provider;
    return provider && typeof provider === "object" && typeof (provider as Record<string, unknown>).model === "string"
      ? [(provider as Record<string, unknown>).model as string] : [];
  }))].sort();
  const providerServiceTiers = [...new Set(responseEvents.flatMap((event) => {
    const provider = event.data.provider;
    return provider && typeof provider === "object" && typeof (provider as Record<string, unknown>).serviceTier === "string"
      ? [(provider as Record<string, unknown>).serviceTier as string] : [];
  }))].sort();
  const providerIdentityStatus = responseEvents.length === 0 || responseEvents.length !== responseStarts.length
    ? "unobservable" as const
    : providerModels.length === 1 && providerServiceTiers.length === 1 && providerServiceTiers[0] === "default"
      && responseEvents.every((event) => {
        const provider = event.data.provider;
        return provider && typeof provider === "object"
          && typeof (provider as Record<string, unknown>).model === "string"
          && (provider as Record<string, unknown>).serviceTier === "default";
      }) ? "observed" as const : "falsified" as const;
  const contextByteValues = responseEvents.map((event) => integerData(event.data, "requestContextBytes"));
  const contextBytes: Observable<number> = responseStarts.length > 0 && responseEvents.length === responseStarts.length
    && contextByteValues.every((value) => value !== null)
    ? observed(contextByteValues.reduce((total, value) => total + (value as number), 0), "author-events.jsonl")
    : unobservable("Responses request context byte counts are not retained for every completed turn.");

  const draftRecords = authorLog.events.filter((event) => resultData(event)?.outcome === "drafted").map((event) => {
    const data = resultData(event) ?? {};
    const presentation = data.presentation && typeof data.presentation === "object"
      ? data.presentation as Record<string, unknown>
      : {};
    const draft = data.draft && typeof data.draft === "object" ? data.draft as Record<string, unknown> : {};
    return {
      toolOrdinal: integerData(event.data, "ordinal"),
      elapsedMs: event.elapsedMs,
      draftId: typeof data.draftId === "string" ? data.draftId : typeof draft.id === "string" ? draft.id : null,
      draftRevision: Number.isSafeInteger(data.draftRevision) ? Number(data.draftRevision)
        : Number.isSafeInteger(draft.revision) ? Number(draft.revision) : null,
      plannedObjectCount: Array.isArray(data.previewObjects) ? data.previewObjects.length
        : Array.isArray(draft.previewObjects) ? draft.previewObjects.length : null,
      presentation: {
        state: typeof presentation.state === "string" ? presentation.state : "unobservable",
        requestedRevision: Number.isSafeInteger(presentation.requestedRevision) ? Number(presentation.requestedRevision) : null,
        observedRevision: Number.isSafeInteger(presentation.observedRevision) ? Number(presentation.observedRevision) : null,
        objectCount: Number.isSafeInteger(presentation.objectCount) ? Number(presentation.objectCount) : null,
        completedObjectCount: Number.isSafeInteger(presentation.completedObjectCount)
          ? Number(presentation.completedObjectCount) : null,
        complete: presentation.complete === true,
      },
    };
  });

  if (authorLog.events.some((event) => event.type === "draft_presentation_measured")) {
    throw new Error("Progressive-presentation measurements must be retained by the independent coordinator, not the author log.");
  }
  const presentationMeasurementEvents = coordinatorLog.events
    .filter((event) => event.type === "draft_presentation_measured");
  if (presentationMeasurementEvents.length > 1) throw new Error("Multiple final presentation measurements are ambiguous.");
  const presentationMeasurement = presentationMeasurementEvents[0];
  let revealObservations: z.infer<typeof revealObservationSchema>[] = [];
  let presentationInput: z.infer<typeof presentationScoringInputSchema> | null = null;
  let presentationScore: ReturnType<typeof scorePresentationUx> | null = null;
  if (presentationMeasurement) {
    presentationInput = presentationScoringInputSchema.parse({
      schemaVersion: 1,
      observed: presentationMeasurement.data.observed,
      criteria: spec.presentationCriteria,
      coverage: { status: "complete", analyzedOpportunities: 1, totalOpportunities: 1, reasons: [] },
    });
    revealObservations = z.array(revealObservationSchema).parse(presentationMeasurement.data.reveals);
    revealObservations.forEach((reveal, index) => {
      if (reveal.revealOrdinal !== index + 1) throw new Error("Draft reveal observations are out of order.");
    });
    if (revealObservations.length !== presentationInput.observed.revealEventCount
        || revealObservations.filter((reveal) => reveal.semanticallyOrdered).length
          !== presentationInput.observed.semanticallyOrderedRevealCount) {
      throw new Error("Draft reveal observations disagree with the presentation summary.");
    }
    presentationScore = scorePresentationUx(presentationInput);
  }

  const inspectionRecords = authorLog.events.filter((event) =>
    event.type === "author_tool_completed"
      && ["inspect_canvas_scope", "render_canvas_preview"].includes(stringData(event.data, "name") ?? ""))
    .map((event) => {
      const ordinal = integerData(event.data, "ordinal");
      const data = resultData(event) ?? {};
      const scene = data.sceneContext && typeof data.sceneContext === "object"
        ? data.sceneContext as Record<string, unknown> : {};
      const revisions = scene.revisions && typeof scene.revisions === "object"
        ? scene.revisions as Record<string, unknown> : {};
      const roomRevision = Number.isSafeInteger(revisions.roomRevision) ? Number(revisions.roomRevision) : null;
      const matchingPixels = pixelEvents.filter((candidate) => integerData(candidate.data, "ordinal") === ordinal);
      if (matchingPixels.length > 1) throw new Error(`Inspection tool ${ordinal} retained multiple ambiguous pixel captures.`);
      const pixel = matchingPixels[0];
      const artifactPath = pixel ? stringData(pixel.data, "artifactPath") : null;
      if (pixel && artifactPath) {
        const pixelRoomRevision = integerData(pixel.data, "roomRevision");
        const expectedPath = ordinal === null || roomRevision === null
          ? null
          : `author-pixels/call-${String(ordinal).padStart(4, "0")}-r${roomRevision}.png`;
        if (pixelRoomRevision !== roomRevision || artifactPath !== expectedPath) {
          throw new Error(`Inspection pixel ${artifactPath} is not bound to its exact tool ordinal and room revision.`);
        }
        assertStructurallyValidPng(input.artifacts, artifactPath);
        const declaredDigest = stringData(pixel.data, "sha256");
        const actualDigest = artifactDigest(input.artifacts, artifactPath).slice("sha256:".length);
        if (declaredDigest !== actualDigest) throw new Error(`Pixel event digest does not verify for ${artifactPath}.`);
      }
      return {
        toolOrdinal: ordinal,
        elapsedMs: event.elapsedMs,
        roomRevision,
        findingKeys: Array.isArray(scene.findingKeys)
          ? scene.findingKeys.filter((value): value is string => typeof value === "string").sort() : [],
        findingCoverage: (scene.coverage as Record<string, unknown> | undefined)?.findings ?? "unavailable",
        pixelElapsedMs: pixel?.elapsedMs ?? null,
        pixelArtifactPath: artifactPath,
        pixelDigest: artifactPath ? artifactDigest(input.artifacts, artifactPath) : null,
        evaluatorInterpretation: "required_independent_assessment",
      };
    });
  const validatedPixelCount = inspectionRecords.filter((record) => record.pixelArtifactPath !== null).length;
  if (validatedPixelCount !== pixelEvents.length) {
    throw new Error("A retained author pixel is not attached to one exact completed inspection tool call.");
  }
  const firstInspection = inspectionRecords
    .filter((record): record is typeof record & { pixelElapsedMs: number } => record.pixelElapsedMs !== null)
    .sort((left, right) => left.pixelElapsedMs - right.pixelElapsedMs)[0];

  const finalStatePath = "spectator-final-state.json";
  const finalState = finalStatePath in input.artifacts
    ? exactJson(input.artifacts[finalStatePath], finalStatePath) as Record<string, unknown>
    : null;
  const finalStateData = finalState?.data && typeof finalState.data === "object"
    ? finalState.data as Record<string, unknown> : null;
  const room = finalStateData?.room && typeof finalStateData.room === "object"
    ? finalStateData.room as Record<string, unknown> : null;
  const finalRoomRevision = Number.isSafeInteger(room?.roomRevision) ? Number(room?.roomRevision) : null;
  const finalPixelPath = finalRoomRevision === null ? null : `spectator-final-r${finalRoomRevision}.png`;
  if (finalPixelPath && finalPixelPath in input.artifacts) assertStructurallyValidPng(input.artifacts, finalPixelPath);
  const revisionAssessmentPacket = createBlindedRevisionAssessmentPacket({
    artifacts: input.artifacts,
    task,
  });
  // Backward-facing artifact property name retained for analysis schema
  // compatibility; its contents are now the exact bounded revision packet.
  const finalStateEvaluatorPacket = freezeDeep({
    ...revisionAssessmentPacket,
    packetDigest: revisionAssessmentPacket.packetRoot,
  });

  let evaluatorAssessment: EvaluatorAssessmentEnvelope | null = null;
  if (input.evaluatorAssessment !== undefined) {
    evaluatorAssessment = evaluatorAssessmentEnvelopeSchema.parse(input.evaluatorAssessment);
    const { envelopeDigest, ...assessmentContent } = evaluatorAssessment;
    if (hashCanonicalJson(assessmentContent) !== envelopeDigest) {
      throw new Error("Evaluator assessment envelope digest does not verify.");
    }
    const expectedBinding: z.infer<typeof evaluatorAssessmentBindingSchema> = {
      attemptId: bundle.attemptId,
      taskId: task.id,
      taskDigest,
      scoringSpecDigest,
      attemptBundleDigest: rawEvidence.attemptBundleDigest,
      artifactRoot: rawEvidence.artifactRoot,
      authorEvidenceRoot: rawEvidence.authorEvidenceRoot,
      rawEvidenceRoot: rawEvidence.rawEvidenceRoot,
      evaluatorPacketDigest: finalStateEvaluatorPacket.packetDigest,
    };
    if (!sameJson(evaluatorAssessment.binding, expectedBinding)) {
      throw new Error("Evaluator assessment is not bound to this exact task, spec, attempt, evidence, and evaluator packet.");
    }
    if (evaluatorAssessment.evaluator.policyDigest !== frozenBindings.evaluatorAuthority.policyDigest
        || evaluatorAssessment.evaluator.reviewRegistryRoot !== frozenBindings.evaluatorAuthority.reviewRegistryRoot
        || !frozenBindings.evaluatorAuthority.allowedIdentityCommitments.includes(
          evaluatorAssessment.evaluator.identityCommitment,
        )) {
      throw new Error("Evaluator assessment does not come from the frozen evaluator policy and authorized identity roster.");
    }
    validateEvaluatorMeasurementsAgainstPacket(evaluatorAssessment, revisionAssessmentPacket);
  }
  const assessments = evaluatorAssessment?.revisionAssessments ?? [];
  const finalStateResult = evaluatorAssessment?.finalStateResult ?? null;
  const rawCandidates = [
    ...inspectionRecords.flatMap((record) => record.roomRevision !== null && record.pixelArtifactPath
      ? [{
          roomRevision: record.roomRevision,
          elapsedMs: record.pixelElapsedMs as number,
          evidencePaths: [record.pixelArtifactPath],
        }]
      : []),
    ...(finalRoomRevision !== null && finalState
      ? [{
          roomRevision: finalRoomRevision,
          elapsedMs: bundle.elapsedMs,
          evidencePaths: [finalStatePath, ...(finalPixelPath && finalPixelPath in input.artifacts ? [finalPixelPath] : [])],
        }]
      : []),
  ];
  const candidatesByRevision = new Map<number, { roomRevision: number; elapsedMs: number; evidencePaths: string[] }>();
  for (const candidate of rawCandidates) {
    const prior = candidatesByRevision.get(candidate.roomRevision);
    if (!prior) candidatesByRevision.set(candidate.roomRevision, candidate);
    else candidatesByRevision.set(candidate.roomRevision, {
      roomRevision: candidate.roomRevision,
      elapsedMs: Math.min(prior.elapsedMs, candidate.elapsedMs),
      evidencePaths: [...new Set([...prior.evidencePaths, ...candidate.evidencePaths])].sort(),
    });
  }
  const candidates = [...candidatesByRevision.values()].sort((left, right) => left.elapsedMs - right.elapsedMs);
  const candidateByRevision = new Map(candidates.map((candidate) => [candidate.roomRevision, candidate]));
  const assessmentIds = new Set<string>();
  const assessedRevisions = new Set<number>();
  for (const assessment of assessments) {
    if (assessmentIds.has(assessment.revisionId) || assessedRevisions.has(assessment.roomRevision)) {
      throw new Error("Revision assessments must have unique IDs and room revisions.");
    }
    assessmentIds.add(assessment.revisionId);
    assessedRevisions.add(assessment.roomRevision);
    const candidate = candidateByRevision.get(assessment.roomRevision);
    if (!candidate) throw new Error(`Revision ${assessment.roomRevision} has no exact retained pixel/final-state evidence.`);
    for (const evidencePath of assessment.evidencePaths) {
      if (!candidate.evidencePaths.includes(evidencePath)) {
        throw new Error(`Assessment ${assessment.revisionId} cites evidence outside its exact revision.`);
      }
      artifactDigest(input.artifacts, evidencePath);
    }
  }
  const sortedAssessments = [...assessments].sort((left, right) =>
    (candidateByRevision.get(left.roomRevision) as { elapsedMs: number }).elapsedMs
      - (candidateByRevision.get(right.roomRevision) as { elapsedMs: number }).elapsedMs);
  const correctionCoverage = {
    status: sortedAssessments.length === candidates.length && candidates.length >= 2 ? "complete" as const
      : sortedAssessments.length > 0 ? "partial" as const : "unavailable" as const,
    analyzedOpportunities: sortedAssessments.length,
    totalOpportunities: candidates.length,
    reasons: [
      ...(revisionAssessmentPacket.sampler.omittedAuthorRevisionCount > 0
        ? [`The frozen chronology-only sampler omitted ${revisionAssessmentPacket.sampler.omittedAuthorRevisionCount} author revision(s); correction metrics describe the sampled trajectory, not exhaustive revision coverage.`]
        : []),
      ...(sortedAssessments.length === candidates.length
        ? []
        : ["One or more exact revision evidence states lacks an independent evaluator-recomputed assessment."]),
    ],
  };
  const correctionInput = sortedAssessments.length >= 2 ? correctionScoringInputSchema.parse({
    schemaVersion: 1,
    evidenceBasis: "evaluator_recomputed",
    qualityScaleId: spec.qualityScaleId,
    possibleIssueOpportunityCount: spec.possibleIssueOpportunityCount,
    revisions: sortedAssessments.map((assessment) => ({
      revisionId: assessment.revisionId,
      issueKeys: assessment.issueKeys,
      semanticScore: assessment.semanticScore,
      blockingViolationCount: assessment.blockingViolationCount,
      qualityValue: assessment.qualityValue,
    })),
    coverage: correctionCoverage,
  }) : null;
  const correctionScore = correctionInput ? scoreCorrection(correctionInput) : null;
  const usefulAssessment = sortedAssessments.find((assessment) => assessment.usefulDraft);
  const selectedRoomRevisions = revisionAssessmentPacket.inventory.map((item) => item.roomRevision);
  const firstUsefulIdentification = identifyBoundedSampleFirstUsefulRevision({
    omittedAuthorRevisionCount: revisionAssessmentPacket.sampler.omittedAuthorRevisionCount,
    selectedRoomRevisions,
    usefulRoomRevisions: sortedAssessments.filter((assessment) => assessment.usefulDraft)
      .map((assessment) => assessment.roomRevision)
      .filter((revision) => selectedRoomRevisions.includes(revision)),
  });
  let timeToUsefulDraft: Observable<number>;
  if (firstUsefulIdentification.status === "identified") {
    const identifiedUsefulAssessment = sortedAssessments.find(
      (assessment) => assessment.roomRevision === firstUsefulIdentification.roomRevision,
    );
    if (!identifiedUsefulAssessment) throw new Error("Identified useful revision is absent from the locked assessment inventory.");
    timeToUsefulDraft = observed(
      (candidateByRevision.get(identifiedUsefulAssessment.roomRevision) as { elapsedMs: number }).elapsedMs,
      ...identifiedUsefulAssessment.evidencePaths,
    );
  } else {
    timeToUsefulDraft = unobservable(firstUsefulIdentification.reason);
  }

  if (finalStateResult) {
    for (const evidencePath of finalStateResult.evidencePaths) {
      if (evidencePath !== finalStatePath && evidencePath !== finalPixelPath) {
        throw new Error("Final-state result cites non-final or process evidence.");
      }
      artifactDigest(input.artifacts, evidencePath);
    }
  }
  const successfulArtifact: Observable<boolean> = finalStateResult
    ? observed(finalStateResult.successfulArtifact, ...finalStateResult.evidencePaths)
    : unobservable("No independent final-state success result was supplied.");

  const completeUsageCoverage = detailedUsage && responseEvents.length === responseStarts.length;
  const costInputs = completeUsageCoverage ? {
    uncachedInputTokens: bundle.author.usage.totals.uncachedInputTokens as number,
    cachedInputTokens: bundle.author.usage.totals.cachedInputTokens as number,
    cacheWriteInputTokens: bundle.author.usage.totals.cacheWriteInputTokens as number,
    outputTokens: bundle.author.usage.totals.outputTokens,
  } : null;
  const costUsd = costInputs
    ? actualAuthorTurnCost(bundle.author.usage.byTurn, spec.costRatesUsdPerMillion)
    : null;

  const efficiencyKnown = contextBytes.status === "observed"
    && timeToUsefulDraft.status === "observed"
    && successfulArtifact.status === "observed"
    && authorWallMs !== null
    && costUsd !== null;
  const efficiencyInput = efficiencyKnown ? efficiencyScoringInputSchema.parse({
    schemaVersion: 1,
    observed: {
      toolCalls: toolStarts.length,
      failedToolCalls: failedToolOrdinals.size,
      retries: retryAfterFailureCount,
      roundTrips: responseStarts.length,
      inputTokens: bundle.author.usage.totals.inputTokens,
      outputTokens: bundle.author.usage.totals.outputTokens,
      contextBytes: (contextBytes as Extract<typeof contextBytes, { status: "observed" }>).value,
      receiptBytes,
      wallTimeMs: authorWallMs as number,
      timeToUsefulDraftMs: (timeToUsefulDraft as Extract<typeof timeToUsefulDraft, { status: "observed" }>).value,
      costUsd: costUsd as number,
    },
    budgets: spec.efficiencyBudgets,
    successfulArtifact: successfulArtifact.status === "observed" && successfulArtifact.value,
    coverage: { status: "complete", analyzedOpportunities: 11, totalOpportunities: 11, reasons: [] },
  }) : null;
  const efficiencyScore = efficiencyInput ? scoreEfficiency(efficiencyInput) : null;

  let correctionRounds = 0;
  let inspectionSeen = false;
  let correctionRoundOpen = false;
  for (const event of authorLog.events) {
    if (event.type === "author_pixel_captured") {
      inspectionSeen = true;
      correctionRoundOpen = false;
    } else if (inspectionSeen && successfulMutation(event) && !correctionRoundOpen) {
      correctionRounds += 1;
      correctionRoundOpen = true;
    }
  }
  const finishStart = toolStarts.find((event) => stringData(event.data, "name") === "finish_canvas_draft");
  const finishComplete = finishStart ? authorLog.events.find((event) =>
    event.type === "author_tool_completed"
      && integerData(event.data, "ordinal") === integerData(finishStart.data, "ordinal")) : undefined;

  const unobservablePresentationFields = presentationMeasurement ? [] : [
    "timeToFirstVisibleObjectMs", "visibleActivityMs", "revealEventCount",
    "semanticallyOrderedRevealCount", "flickerCount", "duplicatePresentationFrameCount",
    "viewportInstabilityCount", "draftAuthoritativeOverlapFrameCount", "handoffGapMs",
    "artificialAuthorDelayMs", "activePresentationAcceleratedOrSkipped",
  ];
  const unobservableEfficiencyFields = [
    ...(authorWallMs === null ? ["authorObservedWallMs"] : []),
    ...(contextBytes.status === "unobservable" ? ["contextBytes"] : []),
    ...(timeToUsefulDraft.status === "unobservable" ? ["timeToUsefulDraftMs"] : []),
    ...(successfulArtifact.status === "unobservable" ? ["successfulArtifact"] : []),
    ...(!completeUsageCoverage ? ["completeTokenUsage", "detailedTokenCostInputs", "costUsd"] : []),
  ];

  const metricsWithoutDigest = {
    schemaVersion: EXP0001A_ATTEMPT_METRICS_SCHEMA_VERSION,
    audience: "process_scorer_only_not_final_state_evaluator",
    attemptId: bundle.attemptId,
    taskId: task.id,
    domain: task.domain,
    provenance: {
      taskDigest,
      scoringSpecDigest,
      extractor: frozenBindings.extractor,
      scorer: frozenBindings.scorer,
      evaluatorAuthority: frozenBindings.evaluatorAuthority,
      attemptBundleDigest: rawEvidence.attemptBundleDigest,
      artifactRoot: rawEvidence.artifactRoot,
      authorEvidenceRoot: rawEvidence.authorEvidenceRoot,
      rawEvidence,
      evaluatorAssessment: evaluatorAssessment ? {
        status: "observed" as const,
        envelope: evaluatorAssessment,
      } : {
        status: "unobservable" as const,
        reason: "No provenance-bound independent evaluator assessment envelope was supplied.",
      },
      verifiedArtifactCount: verifiedArtifactSet.leaves.length,
    },
    completion: {
      status: bundle.status,
      termination: bundle.author.termination,
      authorContextClosedBeforeEvaluation: bundle.isolation.authorContextClosedBeforeEvaluation,
    },
    providerIdentity: {
      provider: bundle.providerIntent.provider,
      requestedModelIdentifier: bundle.providerIntent.requestedModelIdentifier,
      requestedServiceTier: bundle.providerIntent.requestedServiceTier,
      immutableModelSnapshotVerified: bundle.providerIntent.immutableModelSnapshotVerified,
      completedTurns: responseEvents.length,
      attemptedTurns: responseStarts.length,
      status: providerIdentityStatus,
      observedModelIdentifiers: providerModels,
      observedServiceTiers: providerServiceTiers,
      requestedAliasExactMatch: providerModels.length === 1
        && providerModels[0] === bundle.providerIntent.requestedModelIdentifier,
      interpretation: "provider_identifier_only_not_an_immutable_weight_snapshot",
      evidencePaths: ["attempt-bundle.json", "author-events.jsonl"],
    },
    timing: {
      totalAttemptWallMs: observed(bundle.elapsedMs, "attempt-bundle.json"),
      authorObservedWallMs: authorWallMs === null
        ? unobservable<number>("No author event was retained; author-observed wall time cannot be derived.")
        : observed(authorWallMs, "author-events.jsonl"),
      timeToFirstDraftMs: firstDraft ? observed(firstDraft.elapsedMs, "author-events.jsonl")
        : unobservable<number>("No successful drafted outcome was retained."),
      timeToFirstMutationMs: firstMutation ? observed(firstMutation.elapsedMs, "author-events.jsonl")
        : unobservable<number>("No successful mutation receipt was retained."),
      timeToFirstInspectionMs: firstInspection ? observed(firstInspection.pixelElapsedMs, "author-events.jsonl")
        : unobservable<number>("No revision-bound author pixel was retained."),
      draftToAuthoritativeHandoffMs: firstDraft && finishComplete
        ? observed(finishComplete.elapsedMs - firstDraft.elapsedMs, "author-events.jsonl")
        : unobservable<number>("A drafted state and successful finish receipt are both required."),
      finishToAuthoritativeHandoffMs: finishStart && finishComplete
        ? observed(finishComplete.elapsedMs - finishStart.elapsedMs, "author-events.jsonl")
        : unobservable<number>("No matched finish_canvas_draft start/authoritative completion was retained."),
      finishRequestDurationMs: finishStart && finishComplete
        ? observed(finishComplete.elapsedMs - finishStart.elapsedMs, "author-events.jsonl")
        : unobservable<number>("No matched finish_canvas_draft start/completion was retained."),
      timeToUsefulDraftMs: timeToUsefulDraft,
    },
    efficiency: {
      costPolicy: {
        pricingBasis: "per_responses_request" as const,
        longContextInputThresholdTokensExclusive: EXP0001A_LONG_CONTEXT_INPUT_THRESHOLD_PER_REQUEST,
        longContextInputRateMultiplier: EXP0001A_LONG_CONTEXT_INPUT_RATE_MULTIPLIER,
        longContextOutputRateMultiplier: EXP0001A_LONG_CONTEXT_OUTPUT_RATE_MULTIPLIER,
        reasoningTokensNestedWithinOutputTokens: true,
      },
      toolCalls: observed(toolStarts.length, "author-events.jsonl"),
      failedToolCalls: observed(failedToolOrdinals.size, "author-events.jsonl"),
      retryAfterFailureCount: observed(retryAfterFailureCount, "author-events.jsonl"),
      responsesTurns: observed(responseStarts.length, "author-events.jsonl"),
      tokens: responseEvents.length === responseStarts.length
        ? observed(bundle.author.usage.totals, "author-final.json", "author-events.jsonl")
        : unobservable("One or more attempted provider round trips lacks a retained usage receipt."),
      costInputs: costInputs ? observed(costInputs, "author-final.json")
        : unobservable("Detailed token categories or complete per-round-trip usage receipts are absent."),
      costUsd: costUsd === null
        ? unobservable("Detailed token categories or complete per-round-trip usage receipts are absent.")
        : observed(costUsd, "author-final.json"),
      contextBytes,
      receiptBytes: observed(receiptBytes, "author-events.jsonl"),
      successfulArtifact,
      unobservableFields: unobservableEfficiencyFields,
    },
    presentation: {
      drafts: draftRecords,
      revealCount: presentationInput
        ? observed(presentationInput.observed.revealEventCount, "coordinator-events.jsonl")
        : unobservable<number>("No trusted progressive-frame measurement event was retained."),
      revealOrder: presentationMeasurement
        ? observed(revealObservations.map((reveal) => reveal.objectId), "coordinator-events.jsonl")
        : unobservable<readonly string[]>(
            "No revision-bound ordered reveal-frame sequence is retained; transaction object order is not observed display order.",
          ),
      completion: draftRecords.length
        ? observed(draftRecords.map((draft) => ({ draftRevision: draft.draftRevision, ...draft.presentation })), "author-events.jsonl")
        : unobservable("No draft presentation receipt was retained."),
      inspectionAttempts: inspectionRecords.length,
      revisionBoundPixelCount: validatedPixelCount,
      missingPixelInspectionOrdinals: inspectionRecords.filter((record) => !record.pixelArtifactPath)
        .map((record) => record.toolOrdinal),
      unobservableFields: unobservablePresentationFields,
    },
    correction: {
      correctionRounds: observed(correctionRounds, "author-events.jsonl"),
      inspections: inspectionRecords,
      independentlyAssessedRevisions: sortedAssessments.map((assessment) => ({
        ...assessment,
        evidenceDigests: Object.fromEntries(assessment.evidencePaths.map((artifactPath) =>
          [artifactPath, artifactDigest(input.artifacts, artifactPath)])),
      })),
      coverage: correctionCoverage,
      rawInspectionFindingPolicy: task.domain === "drawing" && task.stressors.includes("intentional_overlap")
        ? "tool_findings_are_not_evaluator_issues_and_intentional_overlap_is_neutral"
        : "tool_findings_are_not_evaluator_issues_without_independent_recomputation",
    },
    scorerInputs: { presentation: presentationInput, efficiency: efficiencyInput, correction: correctionInput },
    scores: { presentation: presentationScore, efficiency: efficiencyScore, correction: correctionScore },
    limitations: [...new Set([
      ...unobservablePresentationFields.map((field) => `presentation.${field} is unobservable`),
      ...unobservableEfficiencyFields.map((field) => `efficiency.${field} is unobservable`),
      ...(correctionInput ? [] : ["Correction scoring requires at least two independently assessed exact revisions."]),
      ...(revisionAssessmentPacket.sampler.omittedAuthorRevisionCount > 0
        ? ["Correction metrics cover the frozen first-three/last-three sampled trajectory, not every retained author revision."]
        : []),
    ])].sort(),
  };
  const scoreArtifact = freezeDeep({
    ...metricsWithoutDigest,
    artifactDigest: hashCanonicalJson(metricsWithoutDigest),
  });

  return freezeDeep({ scoreArtifact, finalStateEvaluatorPacket });
}

export const attemptMetricsArtifactDigestSchema = sha256Digest;

const rawEvidenceProvenanceSchema = z.object({
  attemptBundleDigest: sha256Digest,
  artifactRoot: sha256Digest,
  authorEvidenceRoot: sha256Digest.nullable(),
  authorEventsDigest: sha256Digest,
  coordinatorEventsDigest: sha256Digest,
  authorFinalDigest: sha256Digest,
  spectatorFinalStateDigest: sha256Digest.nullable(),
  spectatorFinalPixelDigests: z.array(z.object({
    path: z.string().min(1).max(500),
    digest: sha256Digest,
  }).strict()),
  rawEvidenceRoot: sha256Digest,
}).strict().superRefine((rawEvidence, context) => {
  const paths = rawEvidence.spectatorFinalPixelDigests.map((pixel) => pixel.path);
  if (new Set(paths).size !== paths.length
      || paths.some((artifactPath, index) => index > 0 && paths[index - 1] >= artifactPath)) {
    context.addIssue({ code: "custom", path: ["spectatorFinalPixelDigests"], message: "Pixel evidence must be unique and sorted." });
  }
});

const evaluatorAssessmentProvenanceSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("observed"),
    envelope: evaluatorAssessmentEnvelopeSchema,
  }).strict(),
  z.object({
    status: z.literal("unobservable"),
    reason: z.string().min(1),
  }).strict(),
]);

export const attemptMetricsArtifactSchema = z.object({
  schemaVersion: z.literal(EXP0001A_ATTEMPT_METRICS_SCHEMA_VERSION),
  audience: z.literal("process_scorer_only_not_final_state_evaluator"),
  attemptId: stableId,
  taskId: stableId,
  domain: stableId,
  provenance: z.object({
    taskDigest: sha256Digest,
    scoringSpecDigest: sha256Digest,
    extractor: attemptMetricsFrozenBindingsSchema.shape.extractor,
    scorer: attemptMetricsFrozenBindingsSchema.shape.scorer,
    evaluatorAuthority: attemptMetricsEvaluatorAuthoritySchema,
    attemptBundleDigest: sha256Digest,
    artifactRoot: sha256Digest,
    authorEvidenceRoot: sha256Digest.nullable(),
    rawEvidence: rawEvidenceProvenanceSchema,
    evaluatorAssessment: evaluatorAssessmentProvenanceSchema,
    verifiedArtifactCount: nonNegativeInteger,
  }).strict(),
  completion: z.record(z.string(), z.unknown()),
  providerIdentity: z.record(z.string(), z.unknown()),
  timing: z.record(z.string(), z.unknown()),
  efficiency: z.record(z.string(), z.unknown()),
  presentation: z.record(z.string(), z.unknown()),
  correction: z.record(z.string(), z.unknown()),
  scorerInputs: z.record(z.string(), z.unknown()),
  scores: z.record(z.string(), z.unknown()),
  limitations: z.array(z.string()),
  artifactDigest: sha256Digest,
}).strict();

export type Exp0001aAttemptMetricsArtifact = z.infer<typeof attemptMetricsArtifactSchema>;

export function computeExp0001aAttemptMetricsArtifactDigest(
  artifactInput: Omit<Exp0001aAttemptMetricsArtifact, "artifactDigest">,
): string {
  return hashCanonicalJson(artifactInput);
}

export function verifyExp0001aAttemptMetricsArtifact(
  artifactInput: unknown,
): Readonly<Exp0001aAttemptMetricsArtifact> {
  const artifact = attemptMetricsArtifactSchema.parse(artifactInput);
  const { artifactDigest: declaredDigest, ...content } = artifact;
  const actualDigest = computeExp0001aAttemptMetricsArtifactDigest(content);
  if (actualDigest !== declaredDigest) throw new Error("Attempt metrics artifact digest does not verify.");
  if (artifact.provenance.rawEvidence.attemptBundleDigest !== artifact.provenance.attemptBundleDigest
      || artifact.provenance.rawEvidence.artifactRoot !== artifact.provenance.artifactRoot
      || artifact.provenance.rawEvidence.authorEvidenceRoot !== artifact.provenance.authorEvidenceRoot) {
    throw new Error("Attempt metrics raw-evidence roots disagree with top-level provenance.");
  }
  const { rawEvidenceRoot: declaredRawRoot, ...rawEvidenceContent } = artifact.provenance.rawEvidence;
  if (hashCanonicalJson(rawEvidenceContent) !== declaredRawRoot) {
    throw new Error("Attempt metrics raw-evidence root does not verify.");
  }
  if (artifact.provenance.evaluatorAssessment.status === "observed") {
    const envelope = evaluatorAssessmentEnvelopeSchema.parse(artifact.provenance.evaluatorAssessment.envelope);
    const { envelopeDigest, ...envelopeContent } = envelope;
    if (hashCanonicalJson(envelopeContent) !== envelopeDigest) {
      throw new Error("Attempt metrics evaluator-assessment envelope digest does not verify.");
    }
    const binding = envelope.binding;
    if (binding.attemptId !== artifact.attemptId || binding.taskId !== artifact.taskId
        || binding.taskDigest !== artifact.provenance.taskDigest
        || binding.scoringSpecDigest !== artifact.provenance.scoringSpecDigest
        || binding.attemptBundleDigest !== artifact.provenance.attemptBundleDigest
        || binding.artifactRoot !== artifact.provenance.artifactRoot
        || binding.authorEvidenceRoot !== artifact.provenance.authorEvidenceRoot
        || binding.rawEvidenceRoot !== artifact.provenance.rawEvidence.rawEvidenceRoot) {
      throw new Error("Attempt metrics evaluator-assessment provenance disagrees with the metrics artifact.");
    }
    if (envelope.evaluator.policyDigest !== artifact.provenance.evaluatorAuthority.policyDigest
        || envelope.evaluator.reviewRegistryRoot !== artifact.provenance.evaluatorAuthority.reviewRegistryRoot
        || !artifact.provenance.evaluatorAuthority.allowedIdentityCommitments.includes(
          envelope.evaluator.identityCommitment,
        )) {
      throw new Error("Attempt metrics evaluator authority does not authorize the retained assessment.");
    }
  }
  return freezeDeep(artifact);
}
