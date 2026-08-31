import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  FROZEN_PRIMARY_FAILURE_CLASSES,
  blindedReviewPlanSchema,
  classificationBookSchema,
  reviewLedgerSchema,
  type BlindedReviewPlan,
  type ClassificationBook,
  type ReviewLedger,
} from "./blinded-review-orchestration";
import {
  buildExp0001aAnalysisInput,
  compileExp0001aAnalysis,
  computeExp0001aAnalysisReportDigest,
  exp0001aAnalysisInputSchema,
  verifyExp0001aAnalysisReport,
  type Exp0001aAnalysisInput,
  type Exp0001aAnalysisReport,
  type Exp0001aAnalysisSourceContext,
} from "./exp0001a-analysis";
import {
  computeExp0001aEffectiveAliasVerificationRoot,
  type Exp0001aBatchPlan,
  batchRegistrySchema,
} from "./exp0001a-batch-coordinator";
import {
  computeReviewPhaseReceiptDigest,
  reviewPhaseReceiptSchema,
  type ReviewPhaseReceipt,
} from "./exp0001a-batch-command";
import {
  createExp0001aAttemptMetricsRegistry,
  exp0001aAttemptMetricsRegistryBindingSchema,
  verifyExp0001aAttemptMetricsRegistryBinding,
  type Exp0001aAttemptMetricsRegistrySnapshot,
} from "./exp0001a-attempt-metrics-registry";
import {
  createExp0001aReviewAggregateIndex,
  exp0001aReviewAggregateIndexSchema,
  type Exp0001aReviewAggregateIndex,
  type Exp0001aReviewAggregateSet,
} from "./exp0001a-live-review-runner";
import {
  exp0001aRegistryBridgeReceiptSchema,
} from "./exp0001a-registry-bridge";
import {
  readExp0001aSpendLedger,
  type Exp0001aSpendSummary,
} from "./exp0001a-spend-ledger";
import {
  pairwiseExactRenderCatalogSchema,
  pairwiseExactRenderVerificationReceiptSchema,
  pairwisePreferenceLedgerSchema,
  pairwisePreferenceLedgerSealSchema,
  pairwiseVisualPreferencePlanSchema,
  unblindedPairwiseReportSchema,
} from "./pairwise-visual-preference";
import { attemptRegistrySchema } from "./attempt-schemas";
import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  sha256Digest,
} from "./provenance-crypto";

export const EXP0001A_ANALYSIS_RUNTIME_SOURCE_PATH =
  "src/lib/research/exp0001a-analysis-runtime.ts" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const stableIdSchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const REVIEW_AGGREGATE_FILES = Object.freeze([
  "review-ledger.json",
  "classification-book.json",
  "pairwise-exact-render-catalog.json",
  "pairwise-exact-render-verification.json",
  "pairwise-plan.json",
  "pairwise-ledger.json",
  "pairwise-ledger-seal.json",
  "pairwise-report.json",
] as const);

const OUTPUT_FILES = Object.freeze([
  "00-analysis-input.json",
  "01-analysis-report.json",
  "02-failure-taxonomy.json",
  "03-scorer-judge-validation.json",
  "04-sealed-sample-plan.json",
  "05-analysis-completion-seal.json",
] as const);

const sourceRootsSchema = z.object({
  manifestDigest: digestSchema,
  batchPlanDigest: digestSchema,
  batchRegistryDigest: digestSchema,
  perAttemptAliasVerificationRoot: digestSchema,
  registryBridgeReceiptDigest: digestSchema,
  attemptRegistryRoot: digestSchema,
  reviewPlanRoot: digestSchema,
  reviewLedgerRoot: digestSchema,
  classificationRoot: digestSchema,
  pairwisePlanRoot: digestSchema,
  pairwisePreferenceRoot: digestSchema,
  pairwisePreferenceSealRoot: digestSchema,
  unblindedPairwiseReportRoot: digestSchema,
  attemptMetricsRoot: digestSchema,
  spendLedgerRoot: digestSchema,
  spendExternalAnchorRoot: digestSchema,
  artifactCompletenessRoot: digestSchema,
  failureTaxonomyDigest: digestSchema,
}).strict();

export const exp0001aAnalysisExternalCommitmentsSchema = z.object({
  batchPlanDigest: digestSchema,
  reviewPhaseReceiptDigest: digestSchema,
  attemptMetricsBindingRoot: digestSchema,
  attemptMetricsAuthorizationReceiptDigest: digestSchema,
  attemptMetricsRegistryRoot: digestSchema,
  attemptMetricsCompletionSealDigest: digestSchema,
  runtimeDependencyReceiptDigest: digestSchema,
  runtimeDependencyComponentSetRoot: digestSchema,
  runtimeDependencyLaunchVerificationDurationMs: z.number().int().nonnegative(),
}).strict();

export type Exp0001aAnalysisExternalCommitments = z.infer<
  typeof exp0001aAnalysisExternalCommitmentsSchema
>;

export type Exp0001aAnalysisEvidencePaths = {
  batchRegistryFile: string;
  sealedAttemptRegistryFile: string;
  registryBridgeReceiptFile: string;
  reviewPlanFile: string;
  reviewReceiptFile: string;
  reviewAggregateDirectory: string;
  spendLedgerDirectory: string;
  attemptMetricsBindingFile: string;
  attemptMetricsRegistryDirectory: string;
};

export type Exp0001aAnalysisRuntimeOptions = {
  outputRoot: string;
  batchPlan: Exp0001aBatchPlan;
  evidence: Exp0001aAnalysisEvidencePaths;
  externalCommitments: Exp0001aAnalysisExternalCommitments;
  now?: () => string;
};

const sourceEvidenceSchema = z.object({
  batchPlanDigest: digestSchema,
  batchRegistryDigest: digestSchema,
  batchRegistryFileDigest: digestSchema,
  authorIdentityCommitmentsDigest: digestSchema,
  effectiveAliasVerificationRoot: digestSchema,
  perAttemptAliasVerificationRoot: digestSchema,
  sealedAttemptRegistryRoot: digestSchema,
  sealedAttemptRegistryFileDigest: digestSchema,
  registryBridgeReceiptDigest: digestSchema,
  registryBridgeReceiptFileDigest: digestSchema,
  reviewPhaseReceiptDigest: digestSchema,
  reviewReceiptFileDigest: digestSchema,
  reviewAggregateIndexRoot: digestSchema,
  reviewAggregateIndexFileDigest: digestSchema,
  reviewPlanRoot: digestSchema,
  reviewPlanFileDigest: digestSchema,
  reviewArtifacts: z.array(z.object({
    fileName: z.enum(REVIEW_AGGREGATE_FILES),
    bytesDigest: digestSchema,
    semanticRoot: digestSchema,
  }).strict()).length(8),
  attemptMetricsBindingRoot: digestSchema,
  attemptMetricsBindingFileDigest: digestSchema,
  attemptMetricsRegistryRoot: digestSchema,
  attemptMetricsCompletionSealDigest: digestSchema,
  attemptMetricsArtifactRoot: digestSchema,
  spendLedgerRoot: digestSchema,
  spendExternalAnchorRoot: digestSchema,
  spendExternalAnchorCount: z.number().int().nonnegative(),
  spendAuthorizationReceiptDigest: digestSchema,
  runtimeDependencyReceiptDigest: digestSchema,
  runtimeDependencyComponentSetRoot: digestSchema,
  runtimeDependencyLaunchVerificationDurationMs: z.number().int().nonnegative(),
}).strict();

export const exp0001aVerifiedAnalysisInputSchema = z.object({
  schemaVersion: z.literal("exp-0001a-verified-analysis-input/v1"),
  protocolId: z.literal("EXP-0001A"),
  kind: z.literal("verified_analysis_input"),
  sourceEvidence: sourceEvidenceSchema,
  normalizedInput: exp0001aAnalysisInputSchema,
  normalizedInputDigest: digestSchema,
  inputRoot: digestSchema,
}).strict();

export type Exp0001aVerifiedAnalysisInput = z.infer<typeof exp0001aVerifiedAnalysisInputSchema>;

const failureTaxonomyContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-retained-failure-taxonomy/v1"),
  protocolId: z.literal("EXP-0001A"),
  analysisReportDigest: digestSchema,
  sourceFailureTaxonomyDigest: digestSchema,
  frozenPrimaryFailureClasses: z.array(stableIdSchema),
  frozenMechanismTags: z.array(stableIdSchema),
  observedTaxonomy: z.unknown(),
  triggeredAlarmCodes: z.array(stableIdSchema),
}).strict();

export const exp0001aRetainedFailureTaxonomySchema = failureTaxonomyContentSchema.extend({
  taxonomyRoot: digestSchema,
}).strict();
export type Exp0001aRetainedFailureTaxonomy = z.infer<typeof exp0001aRetainedFailureTaxonomySchema>;

const identitySummarySchema = z.object({
  expectedRecords: z.number().int().nonnegative(),
  retainedRecords: z.number().int().nonnegative(),
  observedResponses: z.number().int().nonnegative(),
  unobservableResponses: z.number().int().nonnegative(),
  requestedAliasExactMatches: z.number().int().nonnegative(),
  requestedAliasMismatches: z.number().int().nonnegative(),
  requestedModelCounts: z.record(z.string().min(1), z.number().int().positive()),
  observedModelCounts: z.record(z.string().min(1), z.number().int().positive()),
  observedServiceTierCounts: z.record(z.string().min(1), z.number().int().positive()),
  responseIdentityRoot: digestSchema,
}).strict();

const scorerJudgeValidationContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-scorer-judge-validation/v1"),
  protocolId: z.literal("EXP-0001A"),
  reviewPlanRoot: digestSchema,
  reviewLedgerRoot: digestSchema,
  pairwisePlanRoot: digestSchema,
  pairwiseLedgerRoot: digestSchema,
  individualReviewerRosterRoot: digestSchema,
  pairwiseReviewerRosterRoot: digestSchema,
  authorProviders: identitySummarySchema,
  individualScorers: identitySummarySchema,
  pairwiseJudges: identitySummarySchema,
  metricsEvaluatorAssessmentCoverage: z.object({
    expectedAttempts: z.literal(48),
    observedEnvelopes: z.number().int().min(0).max(48),
    unobservableEnvelopes: z.number().int().min(0).max(48),
    coverageStatus: z.enum(["complete", "partial", "unobservable"]),
    interpretation: z.string().min(1),
    assessmentProvenanceRoot: digestSchema,
  }).strict(),
  stablePairwiseObservedModel: stableIdSchema.nullable(),
  stablePairwiseObservedServiceTier: stableIdSchema.nullable(),
  retainedDiagnosticCodes: z.array(stableIdSchema),
  validationStatus: z.enum(["verified", "verified_with_retained_diagnostics"]),
}).strict();

export const exp0001aScorerJudgeValidationSchema = scorerJudgeValidationContentSchema.extend({
  validationRoot: digestSchema,
}).strict();
export type Exp0001aScorerJudgeValidation = z.infer<typeof exp0001aScorerJudgeValidationSchema>;

const sealedSamplePlanContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-sealed-sample-plan/v1"),
  protocolId: z.literal("EXP-0001A"),
  analysisReportDigest: digestSchema,
  sourceAnalysisInputDigest: digestSchema,
  sealedTaskDataAccessed: z.literal(false),
  plan: z.unknown(),
}).strict();

export const exp0001aSealedSamplePlanSchema = sealedSamplePlanContentSchema.extend({
  samplePlanRoot: digestSchema,
}).strict();
export type Exp0001aSealedSamplePlan = z.infer<typeof exp0001aSealedSamplePlanSchema>;

const completionSealContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-analysis-completion/v1"),
  protocolId: z.literal("EXP-0001A"),
  kind: z.literal("analysis_complete"),
  analysisCompletedAt: timestampSchema,
  reviewCompletedAt: timestampSchema,
  attemptMetricsSealedAt: timestampSchema,
  reviewCompletionDistinct: z.literal(true),
  analysisInputRoot: digestSchema,
  analysisInputFileDigest: digestSchema,
  analysisReportDigest: digestSchema,
  analysisReportFileDigest: digestSchema,
  failureTaxonomyRoot: digestSchema,
  failureTaxonomyFileDigest: digestSchema,
  scorerJudgeValidationRoot: digestSchema,
  scorerJudgeValidationFileDigest: digestSchema,
  sealedSamplePlanRoot: digestSchema,
  sealedSamplePlanFileDigest: digestSchema,
  sourceRoots: sourceRootsSchema,
  sourceEvidence: sourceEvidenceSchema,
  costs: z.object({
    authorizedMaximumUsd: z.number().finite().positive(),
    userAuthorizedMaximumUsd: z.number().finite().positive(),
    frozenProtocolMaximumUsd: z.number().finite().positive(),
    observedProviderCostUsd: z.number().finite().nonnegative(),
    unobservableProviderExposureUsd: z.number().finite().nonnegative(),
    totalChargedExposureUsd: z.number().finite().nonnegative(),
    remainingAuthorizedExposureUsd: z.number().finite().nonnegative(),
  }).strict(),
}).strict();

export const exp0001aAnalysisCompletionSealSchema = completionSealContentSchema.extend({
  completionSealDigest: digestSchema,
}).strict();
export type Exp0001aAnalysisCompletionSeal = z.infer<typeof exp0001aAnalysisCompletionSealSchema>;

export type Exp0001aAnalysisCompletionSealVerification =
  | { ok: true; seal: Exp0001aAnalysisCompletionSeal }
  | { ok: false; errors: string[] };

export function verifyExp0001aAnalysisCompletionSeal(
  raw: unknown,
): Exp0001aAnalysisCompletionSealVerification {
  const parsed = exp0001aAnalysisCompletionSealSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `COMPLETION_SEAL_SCHEMA:${issue.path.join("/")}:${issue.message}`),
    };
  }
  const seal = parsed.data;
  const expectedDigest = hashCanonicalJson(withoutKey(
    seal as unknown as Record<string, unknown>,
    "completionSealDigest",
  ));
  return expectedDigest === seal.completionSealDigest
    ? { ok: true, seal }
    : { ok: false, errors: ["COMPLETION_SEAL_DIGEST_MISMATCH"] };
}

export type Exp0001aAnalysisRuntimeSnapshot = {
  status: "empty" | "in_progress" | "analysis_complete";
  retainedArtifacts: readonly string[];
  completionSeal: Exp0001aAnalysisCompletionSeal | null;
};

export type Exp0001aAnalysisRuntime = {
  /** Re-verifies all source evidence and writes at most one next immutable artifact. */
  advance(): Promise<Exp0001aAnalysisRuntimeSnapshot>;
  /** Advances until the distinct analysis-complete seal is durably retained. */
  run(): Promise<Exp0001aAnalysisCompletionSeal>;
  /** Read-only full source replay plus retained-prefix verification. */
  read(): Promise<Exp0001aAnalysisRuntimeSnapshot>;
  artifactPaths: Readonly<Record<"analysisInput" | "analysisReport" | "failureTaxonomy" | "scorerJudgeValidation" | "sealedSamplePlan" | "completionSeal", string>>;
};

type JsonFile<T> = { value: T; bytesDigest: string };

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

function rooted<T extends Record<string, unknown>, K extends string>(
  content: T,
  key: K,
): T & Record<K, string> {
  return { ...content, [key]: hashCanonicalJson(content) } as T & Record<K, string>;
}

function nodeErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function statNoFollow(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function assertNoSealedTestPath(filePath: string): void {
  const segments = path.resolve(filePath).split(path.sep);
  if (segments.some((segment) => /^(?:sealed[-_]?tests?|test[-_]?set)$/i.test(segment))) {
    throw new Error("EXP-0001A analysis runtime is forbidden from accessing sealed-test data.");
  }
}

function assertAbsoluteEvidencePaths(paths: Exp0001aAnalysisEvidencePaths, outputRoot: string): void {
  const all = [outputRoot, ...Object.values(paths)];
  for (const candidate of all) {
    if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) {
      throw new Error("Every EXP-0001A analysis runtime path must be absolute and normalized.");
    }
    assertNoSealedTestPath(candidate);
  }
  const resolvedOutput = path.resolve(outputRoot);
  if (Object.values(paths).some((candidate) => path.resolve(candidate) === resolvedOutput
      || path.resolve(candidate).startsWith(`${resolvedOutput}${path.sep}`))) {
    throw new Error("Analysis output cannot contain or overwrite immutable source evidence.");
  }
}

async function ensurePrivateDirectory(directory: string): Promise<string> {
  const existing = await statNoFollow(directory);
  if (!existing) {
    await mkdir(directory, { recursive: false, mode: 0o700 });
    const parent = await open(path.dirname(directory), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("Analysis output must be a private owner-controlled plain directory.");
  }
  const canonical = await realpath(directory);
  return canonical;
}

async function readPlainBytes(filePath: string, requirePrivate = false): Promise<Buffer> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (typeof process.getuid === "function" && stat.uid !== process.getuid())
        || (requirePrivate && (stat.mode & 0o777) !== 0o600)) {
      throw new Error(`Evidence is not a private, singly-linked, owner-controlled file: ${path.basename(filePath)}`);
    }
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readCanonicalJson<T>(filePath: string, schema: z.ZodType<T>, requirePrivate = false): Promise<JsonFile<T>> {
  const bytes = await readPlainBytes(filePath, requirePrivate);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Evidence is not JSON: ${path.basename(filePath)}`);
  }
  const value = schema.parse(raw);
  if (canonicalJson(value) !== bytes.toString("utf8")) {
    throw new Error(`Evidence is non-canonical or contains unrecognized fields: ${path.basename(filePath)}`);
  }
  return { value, bytesDigest: sha256Digest(bytes) };
}

async function readCanonicalUnknown(filePath: string, requirePrivate = false): Promise<JsonFile<unknown>> {
  const bytes = await readPlainBytes(filePath, requirePrivate);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch {
    throw new Error(`Evidence is not JSON: ${path.basename(filePath)}`);
  }
  if (canonicalJson(value) !== bytes.toString("utf8")) {
    throw new Error(`Evidence is not canonical JSON: ${path.basename(filePath)}`);
  }
  return { value, bytesDigest: sha256Digest(bytes) };
}

async function retainExclusive(filePath: string, value: unknown): Promise<void> {
  const bytes = canonicalJson(value);
  const handle = await open(
    filePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(path.dirname(filePath), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  if ((await readPlainBytes(filePath, true)).toString("utf8") !== bytes) {
    throw new Error(`Analysis artifact durable readback failed: ${path.basename(filePath)}`);
  }
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

async function loadReviewAggregates(directory: string): Promise<{
  index: Exp0001aReviewAggregateIndex;
  indexFileDigest: string;
  aggregates: Exp0001aReviewAggregateSet;
}> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("Review aggregate evidence must be a private plain directory.");
  }
  const names = (await readdir(directory)).sort();
  const expectedNames = [...REVIEW_AGGREGATE_FILES, "aggregate-index.json"].sort();
  if (canonicalJson(names) !== canonicalJson(expectedNames)) {
    throw new Error("Review aggregate directory has missing or unexpected evidence files.");
  }
  const indexFile = await readCanonicalJson(
    path.join(directory, "aggregate-index.json"),
    exp0001aReviewAggregateIndexSchema,
    true,
  );
  const values = new Map<string, JsonFile<unknown>>();
  for (const fileName of REVIEW_AGGREGATE_FILES) {
    values.set(fileName, await readCanonicalUnknown(path.join(directory, fileName), true));
  }
  const aggregates: Exp0001aReviewAggregateSet = {
    reviewLedger: reviewLedgerSchema.parse(values.get("review-ledger.json")!.value),
    classificationBook: classificationBookSchema.parse(values.get("classification-book.json")!.value),
    pairwiseExactRenderCatalog: pairwiseExactRenderCatalogSchema.parse(values.get("pairwise-exact-render-catalog.json")!.value),
    pairwiseExactRenderVerificationReceipt: pairwiseExactRenderVerificationReceiptSchema.parse(values.get("pairwise-exact-render-verification.json")!.value),
    pairwisePlan: pairwiseVisualPreferencePlanSchema.parse(values.get("pairwise-plan.json")!.value),
    pairwiseLedger: pairwisePreferenceLedgerSchema.parse(values.get("pairwise-ledger.json")!.value),
    pairwiseLedgerSeal: pairwisePreferenceLedgerSealSchema.parse(values.get("pairwise-ledger-seal.json")!.value),
    pairwiseReport: unblindedPairwiseReportSchema.parse(values.get("pairwise-report.json")!.value),
  };
  const expectedIndex = createExp0001aReviewAggregateIndex(aggregates);
  if (canonicalJson(indexFile.value) !== canonicalJson(expectedIndex)) {
    throw new Error("Review aggregate index does not verify the exact eight retained files and semantic roots.");
  }
  for (const artifact of indexFile.value.artifacts) {
    if (values.get(artifact.fileName)?.bytesDigest !== artifact.bytesDigest) {
      throw new Error(`Review aggregate bytes digest is invalid for ${artifact.fileName}.`);
    }
  }
  return { index: indexFile.value, indexFileDigest: indexFile.bytesDigest, aggregates };
}

async function auditCanonicalEvidenceDirectory(input: {
  directory: string;
  allowed: (name: string) => boolean;
  label: string;
}): Promise<void> {
  const directoryStat = await lstat(input.directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())) {
    throw new Error(`${input.label} must be a private owner-controlled plain directory.`);
  }
  const names = await readdir(input.directory);
  const unexpected = names.filter((name) => !input.allowed(name));
  if (unexpected.length > 0) {
    throw new Error(`${input.label} contains unexpected evidence: ${unexpected.sort().join(", ")}`);
  }
  for (const name of names) await readCanonicalUnknown(path.join(input.directory, name), true);
}

type LoadedProductionEvidence = {
  sourceContext: Exp0001aAnalysisSourceContext;
  normalizedInput: Exp0001aAnalysisInput;
  report: Exp0001aAnalysisReport;
  reviewPlan: BlindedReviewPlan;
  reviewLedger: ReviewLedger;
  classificationBook: ClassificationBook;
  reviewReceipt: ReviewPhaseReceipt;
  metricsSnapshot: Exp0001aAttemptMetricsRegistrySnapshot;
  spendSummary: Exp0001aSpendSummary;
  sourceEvidence: z.infer<typeof sourceEvidenceSchema>;
};

function assertReviewReceipt(input: {
  receipt: ReviewPhaseReceipt;
  batchPlan: Exp0001aBatchPlan;
  batchRegistryDigest: string;
  effectiveAliasVerificationRoot: string;
  sealedAttemptRegistryRoot: string;
  bridgeReceiptDigest: string;
  reviewPlan: BlindedReviewPlan;
  aggregates: Exp0001aReviewAggregateSet;
  aggregateIndex: Exp0001aReviewAggregateIndex;
  spend: Exp0001aSpendSummary;
}): void {
  const { receipt, aggregates } = input;
  if (receipt.authorBatchRegistryDigest !== input.batchRegistryDigest
      || receipt.effectiveAliasVerificationRoot !== input.effectiveAliasVerificationRoot
      || receipt.sealedAttemptRegistryRoot !== input.sealedAttemptRegistryRoot
      || receipt.registryBridgeReceiptDigest !== input.bridgeReceiptDigest
      || receipt.denominator !== 48 || receipt.primaryReviewRecords !== 96
      || receipt.adjudicationReviewRecords !== aggregates.reviewLedger.adjudicationLocks.length
      || receipt.classificationCount !== 48
      || receipt.reviewPlanRoot !== input.reviewPlan.planRoot
      || receipt.reviewLedgerRoot !== aggregates.reviewLedger.ledgerRoot
      || receipt.classificationRoot !== aggregates.classificationBook.classificationRoot
      || receipt.reviewAggregateIndexRoot !== input.aggregateIndex.aggregateIndexRoot
      || receipt.pairwiseExactRenderCatalogRoot !== aggregates.pairwiseExactRenderCatalog.catalogRoot
      || receipt.pairwiseExactRenderVerificationReceiptRoot !== aggregates.pairwiseExactRenderVerificationReceipt.receiptRoot
      || receipt.pairwisePreferenceDenominator !== 24 || receipt.pairwisePreferenceRecords !== 24
      || receipt.pairwisePlanRoot !== aggregates.pairwisePlan.planRoot
      || receipt.pairwiseLedgerRoot !== aggregates.pairwiseLedger.ledgerRoot
      || receipt.pairwiseLedgerSealRoot !== aggregates.pairwiseLedgerSeal.sealRoot
      || receipt.pairwiseReportRoot !== aggregates.pairwiseReport.reportRoot
      || receipt.spendLedgerRoot !== input.spend.ledgerRoot
      || receipt.spendExternalAnchorRoot !== input.spend.externalAnchorRoot
      || receipt.spendExternalAnchorCount !== input.spend.externalAnchorCount
      || receipt.authorizedMaximumUsd !== input.spend.authorizedMaximumUsd
      || receipt.observedProviderCostUsd !== input.spend.observedSettledUsd
      || receipt.unobservableProviderExposureUsd !== input.spend.unobservableReservedExposureUsd
      || receipt.totalChargedExposureUsd !== input.spend.totalChargedExposureUsd) {
    throw new Error("Review-phase completion receipt does not reconcile to the exact batch, review, pairwise, and spend evidence.");
  }
}

async function loadProductionEvidence(options: Exp0001aAnalysisRuntimeOptions): Promise<LoadedProductionEvidence> {
  const external = exp0001aAnalysisExternalCommitmentsSchema.parse(options.externalCommitments);
  if (options.batchPlan.planDigest !== external.batchPlanDigest) {
    throw new Error("Frozen batch plan differs from the externally committed analysis source.");
  }
  const batchRegistryFile = await readCanonicalJson(options.evidence.batchRegistryFile, batchRegistrySchema, true);
  const sealedRegistryFile = await readCanonicalJson(options.evidence.sealedAttemptRegistryFile, attemptRegistrySchema, true);
  const bridgeFile = await readCanonicalJson(options.evidence.registryBridgeReceiptFile, exp0001aRegistryBridgeReceiptSchema, true);
  const reviewPlanFile = await readCanonicalJson(options.evidence.reviewPlanFile, blindedReviewPlanSchema, true);
  const reviewReceiptFile = await readCanonicalJson(options.evidence.reviewReceiptFile, reviewPhaseReceiptSchema, true);
  if (computeReviewPhaseReceiptDigest(reviewReceiptFile.value) !== reviewReceiptFile.value.receiptDigest
      || reviewReceiptFile.value.receiptDigest !== external.reviewPhaseReceiptDigest) {
    throw new Error("Review-phase completion receipt digest is invalid or not externally committed.");
  }
  const review = await loadReviewAggregates(options.evidence.reviewAggregateDirectory);
  const bindingFile = await readCanonicalJson(
    options.evidence.attemptMetricsBindingFile,
    exp0001aAttemptMetricsRegistryBindingSchema,
    true,
  );
  const binding = verifyExp0001aAttemptMetricsRegistryBinding(bindingFile.value);
  if (binding.bindingRoot !== external.attemptMetricsBindingRoot
      || binding.authorizationReceiptDigest !== external.attemptMetricsAuthorizationReceiptDigest) {
    throw new Error("Attempt-metrics registry binding differs from its external authorization.");
  }
  const metricsDirectoryStat = await lstat(options.evidence.attemptMetricsRegistryDirectory);
  if (!metricsDirectoryStat.isDirectory() || metricsDirectoryStat.isSymbolicLink()) {
    throw new Error("Attempt-metrics registry directory is missing or unsafe.");
  }
  await auditCanonicalEvidenceDirectory({
    directory: options.evidence.attemptMetricsRegistryDirectory,
    allowed: (name) => /^\d{6}-[a-f0-9]{16}\.json$/.test(name) || name === "completion.json",
    label: "Attempt-metrics registry",
  });
  const metricsRegistry = createExp0001aAttemptMetricsRegistry({
    directory: options.evidence.attemptMetricsRegistryDirectory,
    binding,
    authorizedBindingRoot: external.attemptMetricsBindingRoot,
    authorizationReceiptDigest: external.attemptMetricsAuthorizationReceiptDigest,
  });
  const metricsSnapshot = await metricsRegistry.requireComplete(external.attemptMetricsCompletionSealDigest);
  if (metricsSnapshot.summary.registryRoot !== external.attemptMetricsRegistryRoot) {
    throw new Error("Attempt-metrics registry root differs from the externally sealed exact-48 root.");
  }
  await auditCanonicalEvidenceDirectory({
    directory: options.evidence.spendLedgerDirectory,
    allowed: (name) => /^\d{6}-[a-f0-9]{16}\.json$/.test(name),
    label: "Spend ledger",
  });
  const spend = await readExp0001aSpendLedger(
    options.evidence.spendLedgerDirectory,
    reviewReceiptFile.value.authorizedMaximumUsd,
    reviewReceiptFile.value.spendAuthorizationReceiptDigest,
    { expectedExternalAnchorRoot: reviewReceiptFile.value.spendExternalAnchorRoot },
  );
  const effectiveAliasVerificationRoot = computeExp0001aEffectiveAliasVerificationRoot(
    batchRegistryFile.value,
    options.batchPlan,
  );
  assertReviewReceipt({
    receipt: reviewReceiptFile.value,
    batchPlan: options.batchPlan,
    batchRegistryDigest: batchRegistryFile.value.registryDigest,
    effectiveAliasVerificationRoot,
    sealedAttemptRegistryRoot: sealedRegistryFile.value.registryRoot,
    bridgeReceiptDigest: bridgeFile.value.receiptDigest,
    reviewPlan: reviewPlanFile.value,
    aggregates: review.aggregates,
    aggregateIndex: review.index,
    spend: spend.summary,
  });
  const pairwisePlan = review.aggregates.pairwisePlan;
  const sourceContext: Exp0001aAnalysisSourceContext = {
    batchPlan: options.batchPlan,
    batchRegistry: batchRegistryFile.value,
    registryBridge: { registry: sealedRegistryFile.value, receipt: bridgeFile.value },
    individualReview: {
      plan: reviewPlanFile.value,
      ledger: review.aggregates.reviewLedger,
      classifications: review.aggregates.classificationBook,
    },
    pairwiseReview: {
      context: {
        manifest: options.batchPlan.manifest,
        blindedReviewPlan: reviewPlanFile.value,
        reviewLedger: review.aggregates.reviewLedger,
        classificationBook: review.aggregates.classificationBook,
        exactRenderCatalog: review.aggregates.pairwiseExactRenderCatalog,
        exactRenderVerificationReceipt: review.aggregates.pairwiseExactRenderVerificationReceipt,
        reviewerRoster: pairwisePlan.reviewerRoster,
        scorerPolicy: pairwisePlan.scorerPolicy,
        authorizedAt: pairwisePlan.authorizedAt,
      },
      plan: pairwisePlan,
      ledger: review.aggregates.pairwiseLedger,
      seal: review.aggregates.pairwiseLedgerSeal,
      unblindedReport: review.aggregates.pairwiseReport,
    },
    attemptMetricsArtifacts: metricsSnapshot.events.map((event) => event.metricsArtifact),
    spendLedger: {
      events: spend.events,
      authorizedMaximumUsd: reviewReceiptFile.value.authorizedMaximumUsd,
      authorizationReceiptDigest: reviewReceiptFile.value.spendAuthorizationReceiptDigest,
      externalAnchorRoot: spend.summary.externalAnchorRoot,
      externalAnchorCount: spend.summary.externalAnchorCount,
    },
  };
  const normalizedInput = buildExp0001aAnalysisInput(sourceContext);
  if (metricsSnapshot.events.length !== 48
      || normalizedInput.attempts.length !== 48
      || normalizedInput.preferences.length !== 24) {
    throw new Error("Analysis source denominators are not exact 48 attempts and 24 fixed pairs.");
  }
  const report = compileExp0001aAnalysis(sourceContext);
  const replay = verifyExp0001aAnalysisReport(report, sourceContext);
  if (!replay.ok || computeExp0001aAnalysisReportDigest(report) !== report.reportDigest
      || report.provenance.analysisInputDigest !== hashCanonicalJson(normalizedInput)) {
    throw new Error(`Independent A/A report replay failed: ${replay.ok ? "digest mismatch" : replay.errors.join(",")}`);
  }
  const sourceEvidence = sourceEvidenceSchema.parse({
    batchPlanDigest: options.batchPlan.planDigest,
    batchRegistryDigest: batchRegistryFile.value.registryDigest,
    batchRegistryFileDigest: batchRegistryFile.bytesDigest,
    authorIdentityCommitmentsDigest: options.batchPlan.authorIdentityCommitmentsDigest,
    effectiveAliasVerificationRoot,
    perAttemptAliasVerificationRoot: normalizedInput.sourceRoots.perAttemptAliasVerificationRoot,
    sealedAttemptRegistryRoot: sealedRegistryFile.value.registryRoot,
    sealedAttemptRegistryFileDigest: sealedRegistryFile.bytesDigest,
    registryBridgeReceiptDigest: bridgeFile.value.receiptDigest,
    registryBridgeReceiptFileDigest: bridgeFile.bytesDigest,
    reviewPhaseReceiptDigest: reviewReceiptFile.value.receiptDigest,
    reviewReceiptFileDigest: reviewReceiptFile.bytesDigest,
    reviewAggregateIndexRoot: review.index.aggregateIndexRoot,
    reviewAggregateIndexFileDigest: review.indexFileDigest,
    reviewPlanRoot: reviewPlanFile.value.planRoot,
    reviewPlanFileDigest: reviewPlanFile.bytesDigest,
    reviewArtifacts: review.index.artifacts,
    attemptMetricsBindingRoot: binding.bindingRoot,
    attemptMetricsBindingFileDigest: bindingFile.bytesDigest,
    attemptMetricsRegistryRoot: metricsSnapshot.summary.registryRoot,
    attemptMetricsCompletionSealDigest: metricsSnapshot.completionSeal!.sealDigest,
    attemptMetricsArtifactRoot: normalizedInput.sourceRoots.attemptMetricsRoot,
    spendLedgerRoot: spend.summary.ledgerRoot,
    spendExternalAnchorRoot: spend.summary.externalAnchorRoot,
    spendExternalAnchorCount: spend.summary.externalAnchorCount,
    spendAuthorizationReceiptDigest: reviewReceiptFile.value.spendAuthorizationReceiptDigest,
    runtimeDependencyReceiptDigest: external.runtimeDependencyReceiptDigest,
    runtimeDependencyComponentSetRoot: external.runtimeDependencyComponentSetRoot,
    runtimeDependencyLaunchVerificationDurationMs: external.runtimeDependencyLaunchVerificationDurationMs,
  });
  return {
    sourceContext,
    normalizedInput,
    report,
    reviewPlan: reviewPlanFile.value,
    reviewLedger: review.aggregates.reviewLedger,
    classificationBook: review.aggregates.classificationBook,
    reviewReceipt: reviewReceiptFile.value,
    metricsSnapshot,
    spendSummary: spend.summary,
    sourceEvidence,
  };
}

type IdentityObservation = {
  requestedModels: readonly string[];
  observedModels: readonly string[];
  observedTiers: readonly string[];
  observed: boolean;
  aliasExactMatch: boolean;
  commitment: unknown;
};

function identitySummary(
  expectedRecords: number,
  observations: readonly IdentityObservation[],
): z.infer<typeof identitySummarySchema> {
  if (observations.length !== expectedRecords) {
    throw new Error(`Scorer/judge identity denominator is ${observations.length}/${expectedRecords}.`);
  }
  const observedResponses = observations.filter((observation) => observation.observed).length;
  const requestedAliasExactMatches = observations.filter((observation) => (
    observation.observed && observation.aliasExactMatch
  )).length;
  return identitySummarySchema.parse({
    expectedRecords,
    retainedRecords: observations.length,
    observedResponses,
    unobservableResponses: observations.length - observedResponses,
    requestedAliasExactMatches,
    requestedAliasMismatches: observedResponses - requestedAliasExactMatches,
    requestedModelCounts: countBy(observations.flatMap((observation) => observation.requestedModels)),
    observedModelCounts: countBy(observations.flatMap((observation) => observation.observedModels)),
    observedServiceTierCounts: countBy(observations.flatMap((observation) => observation.observedTiers)),
    responseIdentityRoot: hashCanonicalJson(observations.map((observation) => observation.commitment)),
  });
}

function scorerJudgeValidation(loaded: LoadedProductionEvidence): Exp0001aScorerJudgeValidation {
  const authorRecords: IdentityObservation[] = [];
  for (const event of loaded.sourceContext.batchRegistry.events) {
    if (event.kind !== "attempt_retained") continue;
    const identity = event.data.providerIdentity;
    if (identity === null) {
      authorRecords.push({
        requestedModels: [],
        observedModels: [],
        observedTiers: [],
        observed: false,
        aliasExactMatch: false,
        commitment: {
          attemptId: event.attemptId,
          retainedEventDigest: event.eventDigest,
          providerIdentity: null,
        },
      });
      continue;
    }
    authorRecords.push({
      requestedModels: [identity.requestedModelIdentifier],
      observedModels: identity.observedModelIdentifiers,
      observedTiers: identity.observedServiceTiers,
      observed: identity.status === "observed",
      aliasExactMatch: identity.requestedAliasExactMatch,
      commitment: {
        attemptId: event.attemptId,
        retainedEventDigest: event.eventDigest,
        providerIdentity: identity,
      },
    });
  }
  const evaluatorRecords = [
    ...loaded.reviewLedger.primaryLocks.map((lock) => lock.record),
    ...loaded.reviewLedger.adjudicationLocks.map((lock) => lock.record),
  ];
  const evaluatorIdentities = evaluatorRecords.map((record): IdentityObservation => ({
    requestedModels: [record.provider.modelRequested],
    observedModels: record.provider.modelObserved === null ? [] : [record.provider.modelObserved],
    observedTiers: record.provider.serviceTierObserved === null ? [] : [record.provider.serviceTierObserved],
    observed: record.provider.identityStatus === "observed",
    aliasExactMatch: record.provider.modelObserved === record.provider.modelRequested,
    commitment: {
      recordSha256: record.recordSha256,
      reviewer: record.reviewer,
      provider: record.provider,
    },
  }));
  const pairwiseRecords = loaded.sourceContext.pairwiseReview.ledger.records.map(({ record }) => record);
  const pairwiseIdentities = pairwiseRecords.map((record): IdentityObservation => ({
    requestedModels: [record.provider.modelRequested],
    observedModels: record.provider.responseId === null ? [] : [record.provider.modelObserved],
    observedTiers: record.provider.responseId === null ? [] : [record.provider.serviceTierObserved],
    observed: record.provider.responseId !== null,
    aliasExactMatch: record.provider.responseId !== null && record.provider.requestedAliasExactMatch,
    commitment: { recordRoot: record.recordRoot, provider: record.provider },
  }));
  const assessmentCommitments = loaded.metricsSnapshot.events.map((event) => ({
    attemptId: event.metricsArtifact.attemptId,
    artifactDigest: event.metricsArtifact.artifactDigest,
    evaluatorAssessment: event.metricsArtifact.provenance.evaluatorAssessment,
  }));
  const observedAssessments = assessmentCommitments.filter((entry) => (
    entry.evaluatorAssessment.status === "observed"
  )).length;
  const unobservableAssessments = assessmentCommitments.length - observedAssessments;
  const observedPairwiseModels = [...new Set(pairwiseIdentities.flatMap((identity) => identity.observedModels))];
  const observedPairwiseTiers = [...new Set(pairwiseIdentities.flatMap((identity) => identity.observedTiers))];
  const diagnostics = new Set<string>();
  if (authorRecords.some((record) => record.observedTiers.some((tier) => tier !== "default"))) {
    diagnostics.add("AUTHOR_NON_DEFAULT_SERVICE_TIER");
  }
  if (evaluatorIdentities.some((record) => record.observedTiers.some((tier) => tier !== "default"))) {
    diagnostics.add("INDIVIDUAL_SCORER_NON_DEFAULT_SERVICE_TIER");
  }
  if (pairwiseIdentities.some((record) => record.observedTiers.some((tier) => tier !== "default"))) {
    diagnostics.add("PAIRWISE_JUDGE_NON_DEFAULT_SERVICE_TIER");
  }
  if ([...authorRecords, ...evaluatorIdentities, ...pairwiseIdentities]
    .some((record) => record.observed && !record.aliasExactMatch)) {
    diagnostics.add("REQUESTED_ALIAS_RESOLVED_MODEL_DIFFERENCE");
  }
  if (unobservableAssessments > 0) diagnostics.add("EVALUATOR_ASSESSMENT_ENVELOPE_UNOBSERVABLE");
  const content = scorerJudgeValidationContentSchema.parse({
    schemaVersion: "exp-0001a-scorer-judge-validation/v1",
    protocolId: "EXP-0001A",
    reviewPlanRoot: loaded.reviewPlan.planRoot,
    reviewLedgerRoot: loaded.reviewLedger.ledgerRoot,
    pairwisePlanRoot: loaded.sourceContext.pairwiseReview.plan.planRoot,
    pairwiseLedgerRoot: loaded.sourceContext.pairwiseReview.ledger.ledgerRoot,
    individualReviewerRosterRoot: hashCanonicalJson(loaded.reviewPlan.reviewerRoster),
    pairwiseReviewerRosterRoot: loaded.sourceContext.pairwiseReview.plan.reviewerRosterRoot,
    authorProviders: identitySummary(48, authorRecords),
    individualScorers: identitySummary(96 + loaded.reviewLedger.adjudicationLocks.length, evaluatorIdentities),
    pairwiseJudges: identitySummary(24, pairwiseIdentities),
    metricsEvaluatorAssessmentCoverage: {
      expectedAttempts: 48,
      observedEnvelopes: observedAssessments,
      unobservableEnvelopes: unobservableAssessments,
      coverageStatus: observedAssessments === 48 ? "complete" : observedAssessments === 0 ? "unobservable" : "partial",
      interpretation: unobservableAssessments === 0
        ? "Every retained attempt metric has an authoritative evaluator-assessment envelope."
        : "Missing evaluator-assessment envelopes are retained as an explicit coverage limitation; they are never interpreted as zero, pass, or correction quality.",
      assessmentProvenanceRoot: hashCanonicalJson(assessmentCommitments),
    },
    stablePairwiseObservedModel: observedPairwiseModels.length === 1 ? observedPairwiseModels[0] : null,
    stablePairwiseObservedServiceTier: observedPairwiseTiers.length === 1 ? observedPairwiseTiers[0] : null,
    retainedDiagnosticCodes: [...diagnostics].sort(),
    validationStatus: diagnostics.size === 0 ? "verified" : "verified_with_retained_diagnostics",
  });
  return exp0001aScorerJudgeValidationSchema.parse(rooted(content, "validationRoot"));
}

function retainedFailureTaxonomy(
  report: Exp0001aAnalysisReport,
  input: Exp0001aAnalysisInput,
  reviewPlan: BlindedReviewPlan,
): Exp0001aRetainedFailureTaxonomy {
  const content = failureTaxonomyContentSchema.parse({
    schemaVersion: "exp-0001a-retained-failure-taxonomy/v1",
    protocolId: "EXP-0001A",
    analysisReportDigest: report.reportDigest,
    sourceFailureTaxonomyDigest: input.sourceRoots.failureTaxonomyDigest,
    frozenPrimaryFailureClasses: [...FROZEN_PRIMARY_FAILURE_CLASSES],
    frozenMechanismTags: [...reviewPlan.policy.mechanismTags],
    observedTaxonomy: report.taxonomy,
    triggeredAlarmCodes: report.alarms.triggeredCodes,
  });
  return exp0001aRetainedFailureTaxonomySchema.parse(rooted(content, "taxonomyRoot"));
}

function retainedSealedSamplePlan(
  report: Exp0001aAnalysisReport,
  input: Exp0001aAnalysisInput,
): Exp0001aSealedSamplePlan {
  if (report.sealedSampleSensitivity.sealedTaskDataAccessed !== false
      || report.sealedSampleSensitivity.observedAaCalibrated.sealedTaskDataAccessed !== false) {
    throw new Error("Analysis sample planning attempted to access sealed-test data.");
  }
  const content = sealedSamplePlanContentSchema.parse({
    schemaVersion: "exp-0001a-sealed-sample-plan/v1",
    protocolId: "EXP-0001A",
    analysisReportDigest: report.reportDigest,
    sourceAnalysisInputDigest: hashCanonicalJson(input),
    sealedTaskDataAccessed: false,
    plan: report.sealedSampleSensitivity,
  });
  return exp0001aSealedSamplePlanSchema.parse(rooted(content, "samplePlanRoot"));
}

type RuntimeMaterial = {
  analysisInput: Exp0001aVerifiedAnalysisInput;
  report: Exp0001aAnalysisReport;
  failureTaxonomy: Exp0001aRetainedFailureTaxonomy;
  scorerJudgeValidation: Exp0001aScorerJudgeValidation;
  sealedSamplePlan: Exp0001aSealedSamplePlan;
  completionSeal: Exp0001aAnalysisCompletionSeal;
};

function verifiedInput(
  input: Exp0001aAnalysisInput,
  sourceEvidence: z.infer<typeof sourceEvidenceSchema>,
): Exp0001aVerifiedAnalysisInput {
  const content = {
    schemaVersion: "exp-0001a-verified-analysis-input/v1" as const,
    protocolId: "EXP-0001A" as const,
    kind: "verified_analysis_input" as const,
    sourceEvidence,
    normalizedInput: input,
    normalizedInputDigest: hashCanonicalJson(input),
  };
  return exp0001aVerifiedAnalysisInputSchema.parse(rooted(content, "inputRoot"));
}

function completionSeal(input: {
  completedAt: string;
  reviewCompletedAt: string;
  metricsSealedAt: string;
  analysisInput: Exp0001aVerifiedAnalysisInput;
  report: Exp0001aAnalysisReport;
  failureTaxonomy: Exp0001aRetainedFailureTaxonomy;
  scorerJudgeValidation: Exp0001aScorerJudgeValidation;
  sealedSamplePlan: Exp0001aSealedSamplePlan;
  costs: {
    authorizedMaximumUsd: number;
    userAuthorizedMaximumUsd: number;
    frozenProtocolMaximumUsd: number;
    observedProviderCostUsd: number;
    unobservableProviderExposureUsd: number;
    totalChargedExposureUsd: number;
    remainingAuthorizedExposureUsd: number;
  };
}): Exp0001aAnalysisCompletionSeal {
  const analysisCompletedAt = timestampSchema.parse(input.completedAt);
  if (Date.parse(analysisCompletedAt) < Math.max(
    Date.parse(input.reviewCompletedAt),
    Date.parse(input.metricsSealedAt),
  )) {
    throw new Error("Analysis completion cannot predate review completion or the exact-48 metrics seal.");
  }
  const content = completionSealContentSchema.parse({
    schemaVersion: "exp-0001a-analysis-completion/v1",
    protocolId: "EXP-0001A",
    kind: "analysis_complete",
    analysisCompletedAt,
    reviewCompletedAt: input.reviewCompletedAt,
    attemptMetricsSealedAt: input.metricsSealedAt,
    reviewCompletionDistinct: true,
    analysisInputRoot: input.analysisInput.inputRoot,
    analysisInputFileDigest: hashCanonicalJson(input.analysisInput),
    analysisReportDigest: input.report.reportDigest,
    analysisReportFileDigest: hashCanonicalJson(input.report),
    failureTaxonomyRoot: input.failureTaxonomy.taxonomyRoot,
    failureTaxonomyFileDigest: hashCanonicalJson(input.failureTaxonomy),
    scorerJudgeValidationRoot: input.scorerJudgeValidation.validationRoot,
    scorerJudgeValidationFileDigest: hashCanonicalJson(input.scorerJudgeValidation),
    sealedSamplePlanRoot: input.sealedSamplePlan.samplePlanRoot,
    sealedSamplePlanFileDigest: hashCanonicalJson(input.sealedSamplePlan),
    sourceRoots: input.analysisInput.normalizedInput.sourceRoots,
    sourceEvidence: input.analysisInput.sourceEvidence,
    costs: input.costs,
  });
  return exp0001aAnalysisCompletionSealSchema.parse(rooted(content, "completionSealDigest"));
}

async function buildProductionMaterial(
  options: Exp0001aAnalysisRuntimeOptions,
  completedAt: string,
): Promise<RuntimeMaterial> {
  const loaded = await loadProductionEvidence(options);
  const input = verifiedInput(loaded.normalizedInput, loaded.sourceEvidence);
  const taxonomy = retainedFailureTaxonomy(loaded.report, loaded.normalizedInput, loaded.reviewPlan);
  const validation = scorerJudgeValidation(loaded);
  const samplePlan = retainedSealedSamplePlan(loaded.report, loaded.normalizedInput);
  return {
    analysisInput: input,
    report: loaded.report,
    failureTaxonomy: taxonomy,
    scorerJudgeValidation: validation,
    sealedSamplePlan: samplePlan,
    completionSeal: completionSeal({
      completedAt,
      reviewCompletedAt: loaded.reviewReceipt.completedAt,
      metricsSealedAt: loaded.metricsSnapshot.completionSeal!.sealedAt,
      analysisInput: input,
      report: loaded.report,
      failureTaxonomy: taxonomy,
      scorerJudgeValidation: validation,
      sealedSamplePlan: samplePlan,
      costs: {
        authorizedMaximumUsd: loaded.reviewReceipt.authorizedMaximumUsd,
        userAuthorizedMaximumUsd: loaded.reviewReceipt.userAuthorizedMaximumUsd,
        frozenProtocolMaximumUsd: loaded.reviewReceipt.frozenProtocolMaximumUsd,
        observedProviderCostUsd: loaded.spendSummary.observedSettledUsd,
        unobservableProviderExposureUsd: loaded.spendSummary.unobservableReservedExposureUsd,
        totalChargedExposureUsd: loaded.spendSummary.totalChargedExposureUsd,
        remainingAuthorizedExposureUsd: loaded.spendSummary.remainingAuthorizedExposureUsd,
      },
    }),
  };
}

function materialValues(material: RuntimeMaterial): readonly unknown[] {
  return [
    material.analysisInput,
    material.report,
    material.failureTaxonomy,
    material.scorerJudgeValidation,
    material.sealedSamplePlan,
    material.completionSeal,
  ];
}

async function outputInventory(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  const unexpected = entries.find((entry) => !OUTPUT_FILES.includes(entry.name as typeof OUTPUT_FILES[number])
    || !entry.isFile() || entry.isSymbolicLink());
  if (unexpected) throw new Error(`Unexpected analysis finalization artifact: ${unexpected.name}`);
  let missingSeen = false;
  for (const name of OUTPUT_FILES) {
    if (!names.includes(name)) missingSeen = true;
    else if (missingSeen) throw new Error(`Analysis finalization artifact sequence has a gap before ${name}.`);
  }
  return names;
}

async function retainedCompletionTime(root: string, names: readonly string[]): Promise<string | null> {
  if (!names.includes(OUTPUT_FILES[5])) return null;
  const retained = await readCanonicalJson(
    path.join(root, OUTPUT_FILES[5]),
    exp0001aAnalysisCompletionSealSchema,
    true,
  );
  if (hashCanonicalJson(withoutKey(retained.value as unknown as Record<string, unknown>, "completionSealDigest"))
      !== retained.value.completionSealDigest) {
    throw new Error("Retained analysis completion seal digest is invalid.");
  }
  return retained.value.analysisCompletedAt;
}

async function verifyRetainedPrefix(
  root: string,
  names: readonly string[],
  material: RuntimeMaterial,
): Promise<void> {
  const values = materialValues(material);
  for (let index = 0; index < names.length; index += 1) {
    const expectedName = OUTPUT_FILES[index];
    if (names[index] !== expectedName) throw new Error("Analysis finalization artifact prefix is not canonical.");
    const bytes = await readPlainBytes(path.join(root, expectedName), true);
    if (bytes.toString("utf8") !== canonicalJson(values[index])) {
      throw new Error(`Retained analysis artifact was tampered or rewritten: ${expectedName}`);
    }
  }
}

function artifactPaths(root: string): Exp0001aAnalysisRuntime["artifactPaths"] {
  return Object.freeze({
    analysisInput: path.join(root, OUTPUT_FILES[0]),
    analysisReport: path.join(root, OUTPUT_FILES[1]),
    failureTaxonomy: path.join(root, OUTPUT_FILES[2]),
    scorerJudgeValidation: path.join(root, OUTPUT_FILES[3]),
    sealedSamplePlan: path.join(root, OUTPUT_FILES[4]),
    completionSeal: path.join(root, OUTPUT_FILES[5]),
  });
}

function createStateMachine(input: {
  outputRoot: string;
  now: () => string;
  build: (completedAt: string) => Promise<RuntimeMaterial>;
}): Exp0001aAnalysisRuntime {
  const paths = artifactPaths(input.outputRoot);
  const evaluate = async (writeNext: boolean): Promise<Exp0001aAnalysisRuntimeSnapshot> => {
    const existingRoot = await statNoFollow(input.outputRoot);
    if (!existingRoot && !writeNext) {
      await input.build(timestampSchema.parse(input.now()));
      return { status: "empty", retainedArtifacts: [], completionSeal: null };
    }
    const root = existingRoot ? await ensurePrivateDirectory(input.outputRoot) : await ensurePrivateDirectory(input.outputRoot);
    const names = await outputInventory(root);
    const completedAt = await retainedCompletionTime(root, names) ?? timestampSchema.parse(input.now());
    const material = await input.build(completedAt);
    await verifyRetainedPrefix(root, names, material);
    if (writeNext && names.length < OUTPUT_FILES.length) {
      await retainExclusive(path.join(root, OUTPUT_FILES[names.length]), materialValues(material)[names.length]);
      const after = await outputInventory(root);
      await verifyRetainedPrefix(root, after, material);
      return {
        status: after.length === OUTPUT_FILES.length ? "analysis_complete" : "in_progress",
        retainedArtifacts: after,
        completionSeal: after.length === OUTPUT_FILES.length ? material.completionSeal : null,
      };
    }
    return {
      status: names.length === 0 ? "empty" : names.length === OUTPUT_FILES.length ? "analysis_complete" : "in_progress",
      retainedArtifacts: names,
      completionSeal: names.length === OUTPUT_FILES.length ? material.completionSeal : null,
    };
  };
  return Object.freeze({
    artifactPaths: paths,
    advance: () => evaluate(true),
    read: () => evaluate(false),
    async run() {
      for (let index = 0; index <= OUTPUT_FILES.length; index += 1) {
        const snapshot = await evaluate(true);
        if (snapshot.status === "analysis_complete" && snapshot.completionSeal) return snapshot.completionSeal;
      }
      throw new Error("Analysis finalization did not reach its immutable completion seal.");
    },
  });
}

/**
 * Standalone production finalizer. It has no provider, fetch, or arbitrary
 * callback dependency; its only effects are strict reads and immutable output.
 */
export function createExp0001aAnalysisRuntime(
  options: Exp0001aAnalysisRuntimeOptions,
): Exp0001aAnalysisRuntime {
  assertAbsoluteEvidencePaths(options.evidence, options.outputRoot);
  exp0001aAnalysisExternalCommitmentsSchema.parse(options.externalCommitments);
  const now = options.now ?? (() => new Date().toISOString());
  return createStateMachine({
    outputRoot: options.outputRoot,
    now,
    build: (completedAt) => buildProductionMaterial(options, completedAt),
  });
}
