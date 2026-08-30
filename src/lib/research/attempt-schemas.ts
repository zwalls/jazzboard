import { z } from "zod";

import { SHA256_DIGEST_PATTERN, type JsonValue } from "./provenance-crypto";

const idSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const provenanceDigestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
export const provenanceTimestampSchema = z.string().datetime({ offset: true });

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const attemptLifecycleStateSchema = z.enum([
  "allocated",
  "provisioned",
  "started",
  "author_completed",
  "author_failed",
  "timeout",
  "infra_failure",
  "policy_violation",
  "sealed",
]);

export const attemptAuthorOutcomeSchema = z.enum([
  "completed",
  "failed",
  "timeout",
  "infra_failure",
  "policy_violation",
]);

export const attemptScoringStatusSchema = z.enum(["unscored", "scorer_failed", "scored"]);

export const researchConditionSchema = z.enum(["baseline", "candidate"]);

const productConditionSchema = z.object({
  gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
  buildDigest: provenanceDigestSchema,
  deploymentUrl: z.string().url(),
}).strict();

export const runSpecSchema = z.object({
  schemaVersion: z.literal(1),
  runId: idSchema,
  protocol: z.object({ id: idSchema, digest: provenanceDigestSchema }).strict(),
  conditions: z.object({
    baseline: productConditionSchema,
    candidate: productConditionSchema,
  }).strict(),
  runner: z.object({
    runnerDigest: provenanceDigestSchema,
  }).strict(),
  taskSet: z.object({
    id: idSchema,
    version: idSchema,
    split: z.enum(["development", "validation", "sealed-test", "replication"]),
    commitment: provenanceDigestSchema,
  }).strict(),
  model: z.object({
    provider: idSchema,
    snapshot: z.string().trim().min(1).max(200),
    reasoningEffort: z.string().trim().min(1).max(40),
    temperature: z.number().finite().min(0).max(2).nullable(),
    seed: z.number().int().safe().nullable(),
  }).strict(),
  environment: z.object({
    imageDigest: provenanceDigestSchema,
    browser: z.string().trim().min(1).max(200),
    viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), deviceScaleFactor: z.number().positive() }).strict(),
    locale: z.string().trim().min(1).max(40),
    timezone: z.string().trim().min(1).max(80),
  }).strict(),
  budgets: z.object({
    wallTimeMs: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
    maxInputTokens: z.number().int().nonnegative(),
    maxOutputTokens: z.number().int().positive(),
  }).strict(),
  createdAt: provenanceTimestampSchema,
}).strict();

export const attemptEventSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: idSchema,
  sequence: z.number().int().nonnegative(),
  at: provenanceTimestampSchema,
  kind: z.literal("lifecycle_transition"),
  from: attemptLifecycleStateSchema.nullable(),
  to: attemptLifecycleStateSchema,
  payload: z.record(z.string(), jsonValueSchema),
  previousEventHash: provenanceDigestSchema.nullable(),
  eventHash: provenanceDigestSchema,
}).strict();

const safeArtifactPathSchema = z.string().min(1).max(1_024).superRefine((path, context) => {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    context.addIssue({ code: "custom", message: "Artifact paths must be normalized relative paths." });
  }
});

export const artifactEntrySchema = z.object({
  path: safeArtifactPathSchema,
  category: z.enum(["prompt", "trace", "semantic-state", "image", "video", "telemetry", "score", "log", "other"]),
  mimeType: z.string().trim().min(1).max(160),
  bytes: z.number().int().nonnegative(),
  sha256: provenanceDigestSchema,
}).strict();

export const artifactIndexSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: idSchema,
  entries: z.array(artifactEntrySchema).max(20_000),
  merkleRoot: provenanceDigestSchema,
}).strict().superRefine((index, context) => {
  const paths = index.entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) context.addIssue({ code: "custom", path: ["entries"], message: "Artifact paths must be unique." });
  if (paths.some((path, itemIndex) => itemIndex > 0 && paths[itemIndex - 1].localeCompare(path) >= 0)) {
    context.addIssue({ code: "custom", path: ["entries"], message: "Artifact entries must be strictly sorted by path." });
  }
});

export const scoreRunSchema = z.object({
  scoreRunId: idSchema,
  scorerId: idSchema,
  scorerVersion: z.string().trim().min(1).max(160),
  configurationDigest: provenanceDigestSchema,
  startedAt: provenanceTimestampSchema,
  completedAt: provenanceTimestampSchema,
  status: z.enum(["succeeded", "failed"]),
  resultArtifactDigest: provenanceDigestSchema.nullable(),
  errorCode: idSchema.nullable(),
}).strict().superRefine((run, context) => {
  if (run.status === "succeeded" && run.resultArtifactDigest === null) context.addIssue({ code: "custom", path: ["resultArtifactDigest"], message: "Successful score runs require a result artifact." });
  if (run.status === "succeeded" && run.errorCode !== null) context.addIssue({ code: "custom", path: ["errorCode"], message: "Successful score runs cannot carry an error code." });
  if (run.status === "failed" && run.errorCode === null) context.addIssue({ code: "custom", path: ["errorCode"], message: "Failed score runs require an error code." });
  if (run.status === "failed" && run.resultArtifactDigest !== null) context.addIssue({ code: "custom", path: ["resultArtifactDigest"], message: "Failed score runs cannot claim a result artifact." });
  if (Date.parse(run.completedAt) < Date.parse(run.startedAt)) context.addIssue({ code: "custom", path: ["completedAt"], message: "Score completion cannot precede its start." });
});

export const attemptRecordSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: idSchema,
  runId: idSchema,
  taskId: idSchema,
  taskCommitment: provenanceDigestSchema,
  pairId: idSchema,
  condition: researchConditionSchema,
  replicateIndex: z.number().int().nonnegative(),
  orderIndex: z.union([z.literal(0), z.literal(1)]),
  timeBlock: z.number().int().nonnegative(),
  parentAttemptId: idSchema.nullable(),
  retryReason: z.string().trim().min(1).max(1_000).nullable(),
  state: attemptLifecycleStateSchema,
  authorOutcome: attemptAuthorOutcomeSchema.nullable(),
  events: z.array(attemptEventSchema).min(1),
  artifactIndex: artifactIndexSchema.nullable(),
  authorEvidenceRoot: provenanceDigestSchema.nullable(),
  scoringStatus: attemptScoringStatusSchema,
  scoreRuns: z.array(scoreRunSchema),
}).strict().superRefine((attempt, context) => {
  if ((attempt.parentAttemptId === null) !== (attempt.retryReason === null)) {
    context.addIssue({ code: "custom", message: "A retry requires both parentAttemptId and retryReason." });
  }
  if (attempt.parentAttemptId === attempt.attemptId) context.addIssue({ code: "custom", path: ["parentAttemptId"], message: "An attempt cannot retry itself." });
  if (attempt.events.some((event) => event.attemptId !== attempt.attemptId)) context.addIssue({ code: "custom", path: ["events"], message: "Every event must belong to the attempt." });
  if (attempt.artifactIndex !== null && attempt.artifactIndex.attemptId !== attempt.attemptId) context.addIssue({ code: "custom", path: ["artifactIndex"], message: "Artifact index attemptId does not match." });
  if (attempt.state === "sealed" && (attempt.artifactIndex === null || attempt.authorEvidenceRoot === null || attempt.authorOutcome === null)) {
    context.addIssue({ code: "custom", message: "A sealed attempt requires artifacts, outcome, and author evidence root." });
  }
  if (attempt.state !== "sealed" && (attempt.artifactIndex !== null || attempt.authorEvidenceRoot !== null)) {
    context.addIssue({ code: "custom", message: "Only a sealed attempt may carry sealed artifacts or an author evidence root." });
  }
  const expectedScoring = attempt.scoreRuns.some((run) => run.status === "succeeded")
    ? "scored"
    : attempt.scoreRuns.some((run) => run.status === "failed") ? "scorer_failed" : "unscored";
  if (attempt.scoringStatus !== expectedScoring) context.addIssue({ code: "custom", path: ["scoringStatus"], message: "Scoring status does not match score runs." });
});

export const attemptRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  runSpec: runSpecSchema,
  runSpecDigest: provenanceDigestSchema,
  attempts: z.array(attemptRecordSchema),
  registryRoot: provenanceDigestSchema,
}).strict().superRefine((registry, context) => {
  const ids = registry.attempts.map((attempt) => attempt.attemptId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["attempts"], message: "Attempt IDs must be unique." });
  const positions = new Map(ids.map((id, index) => [id, index]));
  registry.attempts.forEach((attempt, index) => {
    if (attempt.runId !== registry.runSpec.runId) context.addIssue({ code: "custom", path: ["attempts", index, "runId"], message: "Attempt runId does not match the run specification." });
    if (attempt.parentAttemptId !== null) {
      const parentPosition = positions.get(attempt.parentAttemptId);
      if (parentPosition === undefined || parentPosition >= index) context.addIssue({ code: "custom", path: ["attempts", index, "parentAttemptId"], message: "Retry parent must be an earlier retained attempt." });
    }
  });
});

export const publicAttemptManifestSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: idSchema,
  runId: idSchema,
  task: z.object({ id: idSchema, commitment: provenanceDigestSchema }).strict(),
  assignment: z.object({
    pairId: idSchema,
    condition: researchConditionSchema,
    replicateIndex: z.number().int().nonnegative(),
    orderIndex: z.union([z.literal(0), z.literal(1)]),
    timeBlock: z.number().int().nonnegative(),
  }).strict(),
  retry: z.object({ parentAttemptId: idSchema, reason: z.string().min(1).max(1_000) }).strict().nullable(),
  state: z.literal("sealed"),
  authorOutcome: attemptAuthorOutcomeSchema,
  evidence: z.object({
    authorEvidenceRoot: provenanceDigestSchema,
    eventHeadHash: provenanceDigestSchema,
    artifactMerkleRoot: provenanceDigestSchema,
    artifactCount: z.number().int().nonnegative(),
  }).strict(),
  scoring: z.object({ status: attemptScoringStatusSchema, successfulRuns: z.number().int().nonnegative(), failedRuns: z.number().int().nonnegative() }).strict(),
  sensitiveMaterialRedacted: z.literal(true),
}).strict();

export type RunSpec = z.infer<typeof runSpecSchema>;
export type AttemptLifecycleState = z.infer<typeof attemptLifecycleStateSchema>;
export type AttemptAuthorOutcome = z.infer<typeof attemptAuthorOutcomeSchema>;
export type ResearchCondition = z.infer<typeof researchConditionSchema>;
export type AttemptEvent = z.infer<typeof attemptEventSchema>;
export type ArtifactEntry = z.infer<typeof artifactEntrySchema>;
export type ArtifactIndex = z.infer<typeof artifactIndexSchema>;
export type ScoreRun = z.infer<typeof scoreRunSchema>;
export type AttemptRecord = z.infer<typeof attemptRecordSchema>;
export type AttemptRegistry = z.infer<typeof attemptRegistrySchema>;
export type PublicAttemptManifest = z.infer<typeof publicAttemptManifestSchema>;
