import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  createBlindedReviewPlan,
  finalizeArtifactClassifications,
  verifyBlindedReviewPlan,
  verifyReviewLedger,
  type BlindedReviewPlan,
} from "./blinded-review-orchestration";
import {
  computeReviewPhaseReceiptDigest,
  reviewPhaseReceiptSchema,
  type ReviewPhaseReceipt,
} from "./exp0001a-batch-command";
import {
  verifyExp0001aBatchRegistry,
  type BatchRegistry,
  type Exp0001aBatchPlan,
} from "./exp0001a-batch-coordinator";
import {
  createExp0001aReviewAggregateIndex,
  exp0001aReviewAggregateIndexSchema,
  type Exp0001aReviewAggregateIndex,
  type Exp0001aReviewAggregateSet,
} from "./exp0001a-live-review-runner";
import {
  createExp0001aAttemptMetricsRegistry,
  createExp0001aAttemptMetricsRegistryBinding,
  EXP0001A_ATTEMPT_METRICS_REGISTRY_SOURCE_PATH,
  EXP0001A_ATTEMPT_METRICS_REGISTRY_VERSION,
  verifyExp0001aAttemptMetricsRegistryBinding,
  type Exp0001aAttemptMetricsRegistryBinding,
  type Exp0001aAttemptMetricsRegistrySnapshot,
} from "./exp0001a-attempt-metrics-registry";
import {
  attemptMetricsSpecSchema,
  createEvaluatorAssessmentEnvelope,
  computeExp0001aAttemptMetricsSpecDigest,
  computeExp0001aAttemptMetricsTaskDigest,
  EXP0001A_ATTEMPT_METRICS_EXTRACTOR_SOURCE_PATH,
  EXP0001A_ATTEMPT_METRICS_EXTRACTOR_VERSION,
  EXP0001A_ATTEMPT_METRICS_SCORER_SOURCE_PATH,
  EXP0001A_ATTEMPT_METRICS_SCORER_VERSION,
  extractExp0001aAttemptMetrics,
  verifyBlindedRevisionAssessmentPacket,
  type AttemptArtifactBytes,
  type AttemptMetricsExtractionInput,
  type EvaluatorAssessmentEnvelope,
} from "./attempt-metrics";
import {
  verifyExp0001aRegistryBridge,
  type Exp0001aRegistryBridgeReceipt,
} from "./exp0001a-registry-bridge";
import { canonicalJson, hashCanonicalJson, sha256Digest, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

export const EXP0001A_METRICS_RUNTIME_SOURCE_PATH =
  "src/lib/research/exp0001a-metrics-runtime.ts" as const;
export const EXP0001A_METRICS_RUNTIME_VERSION = "exp-0001a-metrics-runtime/v1" as const;
export const EXP0001A_ATTEMPT_METRICS_SPEC_SOURCE_PATH =
  "research/data/exp0001a-attempt-metrics-spec-v1.json" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const sourceBindingSchema = z.object({
  sourcePath: z.string().min(1).max(500),
  sourceDigest: digestSchema,
  version: z.string().min(1).max(200),
}).strict();

type CommittedSourceBytes = Readonly<{
  taskCatalog: string | Uint8Array;
  metricsSpec: string | Uint8Array;
  extractor: string | Uint8Array;
  scorer: string | Uint8Array;
  registry: string | Uint8Array;
  runtime: string | Uint8Array;
}>;

export type Exp0001aMetricsBindingAuthority = Readonly<{
  authorizationReceiptDigest: string;
  verify(input: Readonly<{
    authorizationReceiptDigest: string;
    contextDigest: string;
    binding: Exp0001aAttemptMetricsRegistryBinding;
  }>): Promise<boolean> | boolean;
}>;

export type Exp0001aMetricsRuntimeOptions = Readonly<{
  runtimeDirectory: string;
  externalSealAnchorFile: string;
  attemptsRoot: string;
  plan: Exp0001aBatchPlan;
  batchRegistry: BatchRegistry;
  bridge: Readonly<{
    prebriefFreeze: unknown;
    freezeAdapterReceipt: unknown;
    sealedAttemptRegistry: unknown;
    receipt: Exp0001aRegistryBridgeReceipt;
  }>;
  reviewPlan: BlindedReviewPlan;
  reviewAggregates: Exp0001aReviewAggregateSet;
  reviewAggregateIndex: Exp0001aReviewAggregateIndex;
  reviewReceipt: ReviewPhaseReceipt;
  committedSourceBytes: CommittedSourceBytes;
  bindingAuthority: Exp0001aMetricsBindingAuthority;
  now?: () => string;
}>;

export type Exp0001aMetricsRuntimeResult = Readonly<{
  metrics: Exp0001aAttemptMetricsRegistrySnapshot;
  externalSealAnchorDigest: string;
}>;

export type Exp0001aMetricsRuntime = Readonly<{
  run(): Promise<Exp0001aMetricsRuntimeResult>;
  readComplete(): Promise<Exp0001aMetricsRuntimeResult>;
}>;

const runtimeBindingContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-metrics-runtime-binding/v1"),
  protocolId: z.literal("EXP-0001A"),
  authorizationReceiptDigest: digestSchema,
  batchPlanDigest: digestSchema,
  batchRegistryDigest: digestSchema,
  registryBridgeReceiptDigest: digestSchema,
  sealedAttemptRegistryRoot: digestSchema,
  reviewPlanRoot: digestSchema,
  reviewLedgerRoot: digestSchema,
  classificationRoot: digestSchema,
  reviewAggregateIndexRoot: digestSchema,
  reviewReceiptDigest: digestSchema,
  taskCatalog: sourceBindingSchema,
  metricsSpec: sourceBindingSchema,
  extractor: sourceBindingSchema,
  scorer: sourceBindingSchema,
  metricsRegistry: sourceBindingSchema,
  metricsRuntime: sourceBindingSchema,
  metricsRegistryBinding: z.unknown(),
}).strict();

const runtimeBindingSchema = runtimeBindingContentSchema.extend({ bindingDigest: digestSchema }).strict();
type RuntimeBinding = z.infer<typeof runtimeBindingSchema>;

const anchorContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-metrics-external-seal-anchor/v1"),
  protocolId: z.literal("EXP-0001A"),
  anchoredAt: timestampSchema,
  authorizationReceiptDigest: digestSchema,
  runtimeBindingDigest: digestSchema,
  metricsRegistryBindingRoot: digestSchema,
  completionSealDigest: digestSchema,
  registryRoot: digestSchema,
}).strict();
const anchorSchema = anchorContentSchema.extend({ anchorDigest: digestSchema }).strict();
type ExternalAnchor = z.infer<typeof anchorSchema>;

type PreparedAttempt = Readonly<{
  input: AttemptMetricsExtractionInput;
  artifactId: string;
  unassessed: ReturnType<typeof extractExp0001aAttemptMetrics>;
}>;

function asBuffer(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function parseJson(bytes: string | Uint8Array, label: string): unknown {
  try {
    return JSON.parse(asBuffer(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function withoutDigest(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

function assertAbsoluteNormalized(candidate: string, label: string): void {
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate || candidate === path.parse(candidate).root) {
    throw new Error(`${label} must be an absolute normalized non-root path.`);
  }
}

function isDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function statNoFollow(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const existing = await statNoFollow(directory);
  if (!existing) {
    const parent = path.dirname(directory);
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Metrics runtime parent must be a plain directory.");
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await syncDirectory(parent);
  }
  const stat = await lstat(directory);
  const canonical = await realpath(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== directory
      || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("Metrics runtime directory must be canonical, private, plain, and owner-controlled.");
  }
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  const canonical = await realpath(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== directory
      || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("Metrics runtime directory must be canonical, private, plain, and owner-controlled.");
  }
}

async function assertCanonicalPlainParent(filePath: string): Promise<void> {
  const parent = path.dirname(filePath);
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(parent) !== parent) {
    throw new Error("External metrics seal-anchor parent must be a canonical plain directory.");
  }
}

async function readPrivateFile(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error(`Retained metrics file is not private, singly linked, and owner-controlled: ${filePath}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeExclusiveCanonical(filePath: string, value: unknown): Promise<void> {
  const serialized = Buffer.from(canonicalJson(value), "utf8");
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(serialized);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
  if (!(await readPrivateFile(filePath)).equals(serialized)) throw new Error("Immutable metrics write failed exact readback.");
}

async function retainOrCompare(filePath: string, value: unknown): Promise<void> {
  try {
    await writeExclusiveCanonical(filePath, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readPrivateFile(filePath)).toString("utf8") !== canonicalJson(value)) {
      throw new Error(`Immutable metrics evidence collision at ${filePath}.`);
    }
  }
}

async function readJsonPrivate(filePath: string, label: string): Promise<unknown> {
  try {
    return JSON.parse((await readPrivateFile(filePath)).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`);
    throw error;
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readAttemptInventory(root: string, current = ""): Promise<Array<{
  path: string;
  bytes: number;
  sha256: string;
  contents: Buffer;
}>> {
  const directory = current ? path.join(root, current) : root;
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  const inventory: Array<{ path: string; bytes: number; sha256: string; contents: Buffer }> = [];
  for (const entry of entries) {
    if (!entry.name || entry.name === "." || entry.name === ".." || entry.name.includes("\\") || entry.name.includes("/")) {
      throw new Error("Attempt artifact has an unsafe path component.");
    }
    const relative = current ? `${current}/${entry.name}` : entry.name;
    const absolute = path.join(root, relative);
    if (!isDescendant(root, absolute)) throw new Error("Attempt artifact escaped its exact attempt root.");
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Attempt evidence contains a symbolic link: ${relative}`);
    if (stat.isDirectory()) {
      inventory.push(...await readAttemptInventory(root, relative));
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Attempt evidence is not a singly linked regular file: ${relative}`);
    const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let contents: Buffer;
    try {
      contents = await handle.readFile();
    } finally {
      await handle.close();
    }
    inventory.push({ path: relative, bytes: contents.byteLength, sha256: sha256Digest(contents).slice(7), contents });
  }
  return inventory;
}

function retainedAttemptEvent(registry: BatchRegistry, attemptId: string) {
  const matches = registry.events.filter((event) => event.kind === "attempt_retained" && event.attemptId === attemptId);
  if (matches.length !== 1 || matches[0].kind !== "attempt_retained") {
    throw new Error(`Expected one retained batch event for ${attemptId}.`);
  }
  return matches[0];
}

function createSourceBindings(input: Exp0001aMetricsRuntimeOptions) {
  const source = input.committedSourceBytes;
  return {
    taskCatalog: {
      sourcePath: input.plan.manifest.benchmark.path,
      sourceDigest: sha256Digest(asBuffer(source.taskCatalog)),
      version: input.plan.manifest.benchmark.benchmarkId,
    },
    metricsSpec: {
      sourcePath: EXP0001A_ATTEMPT_METRICS_SPEC_SOURCE_PATH,
      sourceDigest: sha256Digest(asBuffer(source.metricsSpec)),
      version: "exp-0001a-attempt-metrics-spec/v1",
    },
    extractor: {
      sourcePath: EXP0001A_ATTEMPT_METRICS_EXTRACTOR_SOURCE_PATH,
      sourceDigest: sha256Digest(asBuffer(source.extractor)),
      version: EXP0001A_ATTEMPT_METRICS_EXTRACTOR_VERSION,
    },
    scorer: {
      sourcePath: EXP0001A_ATTEMPT_METRICS_SCORER_SOURCE_PATH,
      sourceDigest: sha256Digest(asBuffer(source.scorer)),
      version: EXP0001A_ATTEMPT_METRICS_SCORER_VERSION,
    },
    metricsRegistry: {
      sourcePath: EXP0001A_ATTEMPT_METRICS_REGISTRY_SOURCE_PATH,
      sourceDigest: sha256Digest(asBuffer(source.registry)),
      version: EXP0001A_ATTEMPT_METRICS_REGISTRY_VERSION,
    },
    metricsRuntime: {
      sourcePath: EXP0001A_METRICS_RUNTIME_SOURCE_PATH,
      sourceDigest: sha256Digest(asBuffer(source.runtime)),
      version: EXP0001A_METRICS_RUNTIME_VERSION,
    },
  } as const;
}

function verifyReviewContext(input: Exp0001aMetricsRuntimeOptions, bridgeRegistryRoot: string): {
  aggregateIndex: Exp0001aReviewAggregateIndex;
  receipt: ReviewPhaseReceipt;
} {
  verifyBlindedReviewPlan(input.reviewPlan);
  if (input.reviewPlan.registryRoot !== bridgeRegistryRoot) throw new Error("Review plan is bound to another sealed attempt registry.");
  const sources = input.reviewPlan.artifacts.map((artifact) => ({
    schemaVersion: 2 as const,
    attemptId: artifact.attemptId,
    authorIdentityCommitment: artifact.authorIdentityCommitment,
    ...artifact.evidence,
  }));
  const rebuiltPlan = createBlindedReviewPlan({
    registry: input.bridge.sealedAttemptRegistry as never,
    sources,
    reviewerRoster: input.reviewPlan.reviewerRoster,
    policy: input.reviewPlan.policy,
  });
  if (!sameJson(rebuiltPlan, input.reviewPlan)) throw new Error("Review plan does not deterministically rebuild from the verified registry.");
  verifyReviewLedger(input.reviewPlan, input.reviewAggregates.reviewLedger);
  const classifications = finalizeArtifactClassifications(input.reviewPlan, input.reviewAggregates.reviewLedger);
  if (!sameJson(classifications, input.reviewAggregates.classificationBook)) {
    throw new Error("Classification book does not rebuild from the exact verified review ledger.");
  }
  const aggregateIndex = exp0001aReviewAggregateIndexSchema.parse(input.reviewAggregateIndex);
  const rebuiltIndex = createExp0001aReviewAggregateIndex(input.reviewAggregates);
  if (!sameJson(aggregateIndex, rebuiltIndex)) throw new Error("Review aggregate index does not match the exact aggregate bytes and roots.");
  const receipt = reviewPhaseReceiptSchema.parse(input.reviewReceipt);
  if (computeReviewPhaseReceiptDigest(receipt) !== receipt.receiptDigest
      || receipt.authorBatchRegistryDigest !== input.batchRegistry.registryDigest
      || receipt.sealedAttemptRegistryRoot !== bridgeRegistryRoot
      || receipt.registryBridgeReceiptDigest !== input.bridge.receipt.receiptDigest
      || receipt.reviewPlanRoot !== input.reviewPlan.planRoot
      || receipt.reviewLedgerRoot !== input.reviewAggregates.reviewLedger.ledgerRoot
      || receipt.classificationRoot !== input.reviewAggregates.classificationBook.classificationRoot
      || receipt.reviewAggregateIndexRoot !== aggregateIndex.aggregateIndexRoot
      || receipt.pairwiseExactRenderCatalogRoot !== input.reviewAggregates.pairwiseExactRenderCatalog.catalogRoot
      || receipt.pairwiseExactRenderVerificationReceiptRoot
        !== input.reviewAggregates.pairwiseExactRenderVerificationReceipt.receiptRoot
      || receipt.pairwisePlanRoot !== input.reviewAggregates.pairwisePlan.planRoot
      || receipt.pairwiseLedgerRoot !== input.reviewAggregates.pairwiseLedger.ledgerRoot
      || receipt.pairwiseLedgerSealRoot !== input.reviewAggregates.pairwiseLedgerSeal.sealRoot
      || receipt.pairwiseReportRoot !== input.reviewAggregates.pairwiseReport.reportRoot) {
    throw new Error("Review completion receipt does not commit the exact verified author and review aggregates.");
  }
  return { aggregateIndex, receipt };
}

function reviewerIdentity(plan: BlindedReviewPlan, reviewerId: string): string {
  const matches = plan.reviewerRoster.filter((reviewer) => reviewer.reviewerId === reviewerId);
  if (matches.length !== 1) throw new Error("Evaluator identity is absent or ambiguous in the frozen reviewer roster.");
  return matches[0].identityCommitment;
}

function deriveLockedMeasurementEnvelope(input: {
  options: Exp0001aMetricsRuntimeOptions;
  prepared: PreparedAttempt;
}): EvaluatorAssessmentEnvelope | undefined {
  const artifactMatches = input.options.reviewPlan.artifacts.filter(
    (artifact) => artifact.artifactId === input.prepared.artifactId,
  );
  if (artifactMatches.length !== 1) throw new Error("Metrics artifact is absent or ambiguous in the frozen review plan.");
  const artifact = artifactMatches[0];
  const measurementReviewerId = artifact.primaryReviewerIds[0];
  if (artifact.primaryWorkItems[0].reviewerId !== measurementReviewerId
      || artifact.primaryWorkItems[0].evaluatorConfig.measurement.role !== "measurement"
      || artifact.primaryWorkItems[1].evaluatorConfig.measurement.role !== "standard") {
    throw new Error("The deterministic first-primary measurement assignment drifted from the frozen plan.");
  }
  const ledger = input.options.reviewAggregates.reviewLedger;
  const locks = ledger.primaryLocks.filter((lock) => (
    lock.artifactId === input.prepared.artifactId
    && lock.reviewerId === measurementReviewerId
  ));
  if (locks.length !== 1) throw new Error("The frozen measurement primary has no unique exact review-ledger lock.");
  const selectedLock = locks[0];
  const record = selectedLock.record;
  if (record.status === "failed") return undefined;
  if (record.reviewer.role !== "primary" || record.reviewer.id !== measurementReviewerId
      || record.measurement.role !== "measurement" || record.measurement.packet === null
      || record.measurement.assessmentOutputSha256 === null
      || record.result?.schemaVersion !== "blinded-evaluator-result/v1"
      || record.result.metricsAssessment === null) {
    throw new Error("The selected scored measurement primary lacks its immutable packet or assessment output.");
  }
  const { packetDigest, ...rawPreparedPacket } = input.prepared.unassessed.finalStateEvaluatorPacket;
  const preparedPacket = verifyBlindedRevisionAssessmentPacket(rawPreparedPacket);
  const recordPacket = verifyBlindedRevisionAssessmentPacket(record.measurement.packet);
  if (packetDigest !== preparedPacket.packetRoot || !sameJson(preparedPacket, recordPacket)
      || record.result.metricsAssessment.packetRoot !== preparedPacket.packetRoot
      || `sha256:${record.measurement.assessmentOutputSha256}`
        !== hashCanonicalJson(record.result.metricsAssessment)) {
    throw new Error("The measurement primary packet or assessment digest drifted from exact attempt evidence.");
  }
  const assessmentByRef = new Map(record.result.metricsAssessment.revisions.map((assessment) => [
    assessment.revisionRef,
    assessment,
  ]));
  if (assessmentByRef.size !== preparedPacket.inventory.length) {
    throw new Error("The selected measurement assessment does not cover every packet revision exactly once.");
  }
  const revisionAssessments = preparedPacket.inventory.map((entry) => {
    const assessment = assessmentByRef.get(entry.revisionRef);
    if (!assessment) throw new Error("The selected measurement assessment omitted a packet revision.");
    return {
      revisionId: entry.revisionRef,
      roomRevision: entry.roomRevision,
      evidencePaths: [entry.pixel.path, ...(entry.semanticState ? [entry.semanticState.path] : [])],
      satisfiedCriterionRefs: assessment.satisfiedCriterionRefs,
      issueKeys: assessment.issueKeys,
      semanticScore: assessment.semanticScore,
      visualUsabilityScore: assessment.visualUsabilityScore,
      blockingViolationCount: assessment.blockingViolationCount,
      qualityValue: assessment.qualityValue,
      usefulDraft: assessment.usefulDraft,
    };
  });
  const finalEntry = preparedPacket.inventory.find((entry) => entry.revisionRef === preparedPacket.finalRevisionRef);
  if (!finalEntry || finalEntry.kind !== "final_spectator" || finalEntry.semanticState === null
      || record.result.metricsAssessment.finalState.revisionRef !== finalEntry.revisionRef
      || record.result.metricsAssessment.finalState.successfulArtifact !== record.result.accepted) {
    throw new Error("The selected measurement assessment lacks the exact final spectator result.");
  }
  const identityCommitment = reviewerIdentity(input.options.reviewPlan, measurementReviewerId);
  const policyDigest = hashCanonicalJson(input.options.reviewPlan.policy);
  const scoreArtifact = input.prepared.unassessed.scoreArtifact;
  return createEvaluatorAssessmentEnvelope({
    schemaVersion: "exp-0001a-metrics-evaluator-assessment/v1",
    protocolId: "EXP-0001A",
    evaluator: {
      evaluatorId: measurementReviewerId,
      identityCommitment,
      policyDigest,
      reviewRegistryRoot: ledger.ledgerRoot,
      recordDigest: `sha256:${record.recordSha256}`,
    },
    assessedAt: selectedLock.lockedAt,
    binding: {
      attemptId: scoreArtifact.attemptId,
      taskId: scoreArtifact.taskId,
      taskDigest: scoreArtifact.provenance.taskDigest,
      scoringSpecDigest: scoreArtifact.provenance.scoringSpecDigest,
      attemptBundleDigest: scoreArtifact.provenance.attemptBundleDigest,
      artifactRoot: scoreArtifact.provenance.artifactRoot,
      authorEvidenceRoot: scoreArtifact.provenance.authorEvidenceRoot,
      rawEvidenceRoot: scoreArtifact.provenance.rawEvidence.rawEvidenceRoot,
      evaluatorPacketDigest: preparedPacket.packetRoot,
    },
    revisionAssessments,
    finalStateResult: {
      successfulArtifact: record.result.metricsAssessment.finalState.successfulArtifact,
      evidencePaths: [finalEntry.semanticState.path, finalEntry.pixel.path],
    },
  });
}

async function prepare(input: Exp0001aMetricsRuntimeOptions): Promise<{
  runtimeBinding: RuntimeBinding;
  metricsBinding: Exp0001aAttemptMetricsRegistryBinding;
  attempts: readonly AttemptMetricsExtractionInput[];
  contextDigest: string;
}> {
  const batchRegistry = verifyExp0001aBatchRegistry(input.batchRegistry, input.plan);
  const bridge = verifyExp0001aRegistryBridge({
    plan: input.plan,
    batchRegistry,
    prebriefFreeze: input.bridge.prebriefFreeze,
    freezeAdapterReceipt: input.bridge.freezeAdapterReceipt,
    registry: input.bridge.sealedAttemptRegistry,
    receipt: input.bridge.receipt,
  });
  const review = verifyReviewContext(input, bridge.registry.registryRoot);
  const sourceBindings = createSourceBindings(input);
  const taskCatalog = parseJson(input.committedSourceBytes.taskCatalog, "Committed task catalog") as Record<string, unknown>;
  if (!Array.isArray(taskCatalog.tasks)) throw new Error("Committed task catalog does not contain tasks.");
  const taskById = new Map<string, unknown>();
  for (const task of taskCatalog.tasks) {
    const taskId = task && typeof task === "object" ? (task as Record<string, unknown>).id : null;
    if (typeof taskId !== "string" || taskById.has(taskId)) throw new Error("Committed task catalog contains invalid or duplicate task IDs.");
    taskById.set(taskId, task);
  }
  const manifestTaskIds = input.plan.manifest.tasks.map((task) => task.taskId).sort(compareCodeUnits);
  if (!sameJson([...taskById.keys()].sort(compareCodeUnits), manifestTaskIds)) {
    throw new Error("Committed task catalog does not exactly match the frozen task denominator.");
  }
  for (const manifestTask of input.plan.manifest.tasks) {
    if (computeExp0001aAttemptMetricsTaskDigest(taskById.get(manifestTask.taskId)) !== manifestTask.taskDigest) {
      throw new Error(`Committed task bytes drift for ${manifestTask.taskId}.`);
    }
  }
  const spec = attemptMetricsSpecSchema.parse(parseJson(input.committedSourceBytes.metricsSpec, "Committed metrics spec"));
  const scoringSpecDigest = computeExp0001aAttemptMetricsSpecDigest(spec);
  const evaluatorAuthority = {
    reviewRegistryRoot: input.reviewAggregates.reviewLedger.ledgerRoot,
    policyDigest: hashCanonicalJson(input.reviewPlan.policy),
    allowedIdentityCommitments: input.reviewPlan.reviewerRoster
      .map((reviewer) => reviewer.identityCommitment)
      .sort(compareCodeUnits),
  };

  const expectedAttemptNames = input.plan.configs.map((config) => config.attempt.attemptId).sort(compareCodeUnits);
  const attemptsRootStat = await lstat(input.attemptsRoot);
  if (!attemptsRootStat.isDirectory() || attemptsRootStat.isSymbolicLink() || await realpath(input.attemptsRoot) !== input.attemptsRoot) {
    throw new Error("Attempt evidence root must be a canonical plain directory.");
  }
  const actualAttemptNames = (await readdir(input.attemptsRoot)).sort(compareCodeUnits);
  if (!sameJson(actualAttemptNames, expectedAttemptNames)) {
    throw new Error("Attempt evidence root contains missing or unexpected attempt directories.");
  }

  const reviewArtifactByAttempt = new Map(input.reviewPlan.artifacts.map((artifact) => [artifact.attemptId, artifact]));
  const bridgeMappingByAttempt = new Map(bridge.receipt.mappings.map((mapping) => [mapping.attemptId, mapping]));
  const preparedAttempts: PreparedAttempt[] = [];
  for (const [manifestPosition, config] of input.plan.configs.entries()) {
    const attemptId = config.attempt.attemptId;
    const attemptDir = path.join(input.attemptsRoot, attemptId);
    if (!isDescendant(input.attemptsRoot, attemptDir)) throw new Error("Attempt directory escaped the exact evidence root.");
    const stat = await lstat(attemptDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(attemptDir) !== attemptDir) {
      throw new Error(`Attempt directory is not canonical and plain: ${attemptId}`);
    }
    const inventory = await readAttemptInventory(attemptDir);
    const retained = retainedAttemptEvent(batchRegistry, attemptId);
    if (!retained.data.evidenceComplete || !retained.data.attemptBundleSha256
        || !retained.data.artifactRoot || !retained.data.authorEvidenceRoot) {
      throw new Error(`Attempt ${attemptId} lacks complete retained metrics evidence.`);
    }
    const expectedInventory = [...retained.data.artifacts]
      .sort((left, right) => compareCodeUnits(left.path, right.path));
    const actualInventory = inventory.map(({ path: artifactPath, bytes, sha256 }) => ({
      path: artifactPath, bytes, sha256,
    }));
    if (!sameJson(actualInventory, expectedInventory)) throw new Error(`Attempt ${attemptId} bytes drift from the verified batch registry.`);
    const bundle = inventory.find((entry) => entry.path === "attempt-bundle.json");
    if (!bundle || bundle.sha256 !== retained.data.attemptBundleSha256) throw new Error(`Attempt ${attemptId} bundle digest drifted.`);
    const artifacts: Record<string, Buffer> = Object.fromEntries(
      inventory.filter((entry) => entry.path !== "attempt-bundle.json").map((entry) => [entry.path, entry.contents]),
    );
    const task = taskById.get(config.attempt.taskId);
    const frozenBindings = {
      taskDigest: computeExp0001aAttemptMetricsTaskDigest(task),
      scoringSpecDigest,
      extractor: sourceBindings.extractor,
      scorer: sourceBindings.scorer,
      evaluatorAuthority,
    };
    const extractionInput: AttemptMetricsExtractionInput = {
      attemptBundleBytes: bundle.contents,
      artifacts: artifacts as AttemptArtifactBytes,
      task,
      spec,
      frozenBindings,
    };
    const unassessed = extractExp0001aAttemptMetrics(extractionInput);
    if (unassessed.scoreArtifact.provenance.attemptBundleDigest !== `sha256:${retained.data.attemptBundleSha256}`
        || unassessed.scoreArtifact.provenance.artifactRoot !== `sha256:${retained.data.artifactRoot}`
        || unassessed.scoreArtifact.provenance.authorEvidenceRoot !== `sha256:${retained.data.authorEvidenceRoot}`) {
      throw new Error(`Attempt ${attemptId} extracted roots drift from the verified registry bridge.`);
    }
    const mapping = bridgeMappingByAttempt.get(attemptId);
    const reviewArtifact = reviewArtifactByAttempt.get(attemptId);
    if (!mapping || mapping.manifestPosition !== manifestPosition || mapping.opaqueLabel !== config.attempt.opaqueLabel
        || !reviewArtifact || reviewArtifact.taskId !== config.attempt.taskId) {
      throw new Error(`Attempt ${attemptId} does not join exactly across plan, bridge, and review membership.`);
    }
    preparedAttempts.push({ input: extractionInput, artifactId: reviewArtifact.artifactId, unassessed });
  }

  const assessedInputs: AttemptMetricsExtractionInput[] = [];
  for (const prepared of preparedAttempts) {
    const envelope = deriveLockedMeasurementEnvelope({ options: input, prepared });
    if (!envelope) assessedInputs.push(prepared.input);
    else {
      const assessedInput = { ...prepared.input, evaluatorAssessment: envelope };
      extractExp0001aAttemptMetrics(assessedInput);
      assessedInputs.push(assessedInput);
    }
  }

  const authorizationReceiptDigest = digestSchema.parse(input.bindingAuthority.authorizationReceiptDigest);
  const expectedAttempts = input.plan.configs.map((config, index) => {
    const result = extractExp0001aAttemptMetrics(assessedInputs[index]).scoreArtifact;
    const mapping = bridge.receipt.mappings[index];
    return {
      attemptId: config.attempt.attemptId,
      pairId: config.attempt.pairId,
      taskId: config.attempt.taskId,
      taskDigest: result.provenance.taskDigest,
      treatment: config.attempt.opaqueLabel,
      attemptBundleDigest: result.provenance.attemptBundleDigest,
      artifactRoot: result.provenance.artifactRoot,
      authorEvidenceRoot: result.provenance.authorEvidenceRoot,
      rawEvidenceRoot: result.provenance.rawEvidence.rawEvidenceRoot,
      evaluatorAssessmentEnvelopeDigest: result.provenance.evaluatorAssessment.status === "observed"
        ? result.provenance.evaluatorAssessment.envelope.envelopeDigest : null,
      mappingDigest: mapping.batchRetainedEventDigest,
    };
  });
  const metricsBinding = createExp0001aAttemptMetricsRegistryBinding({
    schemaVersion: 1,
    protocolId: "EXP-0001A",
    authorizationReceiptDigest,
    expectedAttempts: expectedAttempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      pairId: attempt.pairId,
      taskId: attempt.taskId,
      taskDigest: attempt.taskDigest,
      treatment: attempt.treatment,
      attemptBundleDigest: attempt.attemptBundleDigest,
      artifactRoot: attempt.artifactRoot,
      authorEvidenceRoot: attempt.authorEvidenceRoot,
      rawEvidenceRoot: attempt.rawEvidenceRoot,
      evaluatorAssessmentEnvelopeDigest: attempt.evaluatorAssessmentEnvelopeDigest,
    })),
    scoringSpecDigest,
    extractor: sourceBindings.extractor,
    scorer: sourceBindings.scorer,
    evaluatorAuthority,
    registry: sourceBindings.metricsRegistry,
  });
  const context = {
    authorizationReceiptDigest,
    batchPlanDigest: input.plan.planDigest,
    batchRegistryDigest: batchRegistry.registryDigest,
    registryBridgeReceiptDigest: bridge.receipt.receiptDigest,
    sealedAttemptRegistryRoot: bridge.registry.registryRoot,
    reviewPlanRoot: input.reviewPlan.planRoot,
    reviewLedgerRoot: input.reviewAggregates.reviewLedger.ledgerRoot,
    classificationRoot: input.reviewAggregates.classificationBook.classificationRoot,
    reviewAggregateIndexRoot: review.aggregateIndex.aggregateIndexRoot,
    reviewReceiptDigest: review.receipt.receiptDigest,
    sources: sourceBindings,
    orderedSlotCommitments: expectedAttempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      mappingDigest: attempt.mappingDigest,
      rawEvidenceRoot: attempt.rawEvidenceRoot,
      evaluatorAssessmentEnvelopeDigest: attempt.evaluatorAssessmentEnvelopeDigest,
    })),
  };
  const contextDigest = hashCanonicalJson(context);
  if (!await input.bindingAuthority.verify({ authorizationReceiptDigest, contextDigest, binding: metricsBinding })) {
    throw new Error("Independent execution authority rejected the exact metrics binding.");
  }
  const runtimeContent = runtimeBindingContentSchema.parse({
    schemaVersion: "exp-0001a-metrics-runtime-binding/v1",
    protocolId: "EXP-0001A",
    authorizationReceiptDigest,
    batchPlanDigest: input.plan.planDigest,
    batchRegistryDigest: batchRegistry.registryDigest,
    registryBridgeReceiptDigest: bridge.receipt.receiptDigest,
    sealedAttemptRegistryRoot: bridge.registry.registryRoot,
    reviewPlanRoot: input.reviewPlan.planRoot,
    reviewLedgerRoot: input.reviewAggregates.reviewLedger.ledgerRoot,
    classificationRoot: input.reviewAggregates.classificationBook.classificationRoot,
    reviewAggregateIndexRoot: review.aggregateIndex.aggregateIndexRoot,
    reviewReceiptDigest: review.receipt.receiptDigest,
    taskCatalog: sourceBindings.taskCatalog,
    metricsSpec: sourceBindings.metricsSpec,
    extractor: sourceBindings.extractor,
    scorer: sourceBindings.scorer,
    metricsRegistry: sourceBindings.metricsRegistry,
    metricsRuntime: sourceBindings.metricsRuntime,
    metricsRegistryBinding: metricsBinding,
  });
  const runtimeBinding = runtimeBindingSchema.parse({
    ...runtimeContent,
    bindingDigest: hashCanonicalJson(runtimeContent),
  });
  return { runtimeBinding, metricsBinding, attempts: assessedInputs, contextDigest };
}

function verifyRuntimeBinding(input: unknown): RuntimeBinding {
  const binding = runtimeBindingSchema.parse(input);
  if (hashCanonicalJson(withoutDigest(binding as Record<string, unknown>, "bindingDigest")) !== binding.bindingDigest) {
    throw new Error("Metrics runtime binding digest does not verify.");
  }
  verifyExp0001aAttemptMetricsRegistryBinding(binding.metricsRegistryBinding);
  return binding;
}

function createAnchor(input: {
  now: string;
  authorizationReceiptDigest: string;
  runtimeBinding: RuntimeBinding;
  metrics: Exp0001aAttemptMetricsRegistrySnapshot;
}): ExternalAnchor {
  const completion = input.metrics.completionSeal;
  if (!completion || !input.metrics.summary.denominatorComplete) throw new Error("Cannot anchor incomplete attempt metrics.");
  const content = anchorContentSchema.parse({
    schemaVersion: "exp-0001a-metrics-external-seal-anchor/v1",
    protocolId: "EXP-0001A",
    anchoredAt: input.now,
    authorizationReceiptDigest: input.authorizationReceiptDigest,
    runtimeBindingDigest: input.runtimeBinding.bindingDigest,
    metricsRegistryBindingRoot: input.metrics.summary.bindingRoot,
    completionSealDigest: completion.sealDigest,
    registryRoot: input.metrics.summary.registryRoot,
  });
  return anchorSchema.parse({ ...content, anchorDigest: hashCanonicalJson(content) });
}

function verifyAnchor(input: unknown): ExternalAnchor {
  const anchor = anchorSchema.parse(input);
  if (hashCanonicalJson(withoutDigest(anchor as Record<string, unknown>, "anchorDigest")) !== anchor.anchorDigest) {
    throw new Error("External metrics seal-anchor digest does not verify.");
  }
  return anchor;
}

export function createExp0001aMetricsRuntime(options: Exp0001aMetricsRuntimeOptions): Exp0001aMetricsRuntime {
  assertAbsoluteNormalized(options.runtimeDirectory, "Metrics runtime directory");
  assertAbsoluteNormalized(options.externalSealAnchorFile, "External metrics seal anchor");
  assertAbsoluteNormalized(options.attemptsRoot, "Attempt evidence root");
  if (isDescendant(options.runtimeDirectory, options.externalSealAnchorFile)
      || options.externalSealAnchorFile === options.runtimeDirectory) {
    throw new Error("External metrics seal anchor must live outside the metrics runtime directory.");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const bindingPath = path.join(options.runtimeDirectory, "binding.json");
  const registryBindingPath = path.join(options.runtimeDirectory, "registry-binding.json");
  const registryDirectory = path.join(options.runtimeDirectory, "registry");
  const lockPath = path.join(options.runtimeDirectory, "run.lock");

  const verifyRuntimeEntries = async (allowLock: boolean) => {
    const names = (await readdir(options.runtimeDirectory)).sort(compareCodeUnits);
    const allowed = new Set(["binding.json", "registry-binding.json", "registry", ...(allowLock ? ["run.lock"] : [])]);
    const unexpected = names.filter((name) => !allowed.has(name));
    if (unexpected.length > 0) throw new Error(`Metrics runtime contains unexpected entries: ${unexpected.join(", ")}`);
    if (!allowLock && names.includes("run.lock")) throw new Error("Metrics runtime is locked or crash recovery is required.");
  };

  const completeFromPrepared = async (prepared: Awaited<ReturnType<typeof prepare>>): Promise<Exp0001aMetricsRuntimeResult> => {
    await verifyRuntimeEntries(false);
    const retainedBinding = verifyRuntimeBinding(await readJsonPrivate(bindingPath, "Metrics runtime binding"));
    if (!sameJson(retainedBinding, prepared.runtimeBinding)) throw new Error("Retained metrics runtime binding drifted from exact source evidence.");
    const retainedRegistryBinding = verifyExp0001aAttemptMetricsRegistryBinding(
      await readJsonPrivate(registryBindingPath, "Direct attempt-metrics registry binding"),
    );
    if (!sameJson(retainedRegistryBinding, prepared.metricsBinding)
        || !sameJson(retainedRegistryBinding, retainedBinding.metricsRegistryBinding)) {
      throw new Error("Direct attempt-metrics registry binding drifted from the exact runtime binding.");
    }
    const anchor = verifyAnchor(await readJsonPrivate(options.externalSealAnchorFile, "External metrics seal anchor"));
    if (anchor.runtimeBindingDigest !== retainedBinding.bindingDigest
        || anchor.authorizationReceiptDigest !== retainedBinding.authorizationReceiptDigest
        || anchor.metricsRegistryBindingRoot !== prepared.metricsBinding.bindingRoot) {
      throw new Error("External metrics seal anchor is bound to another runtime or authorization.");
    }
    const registry = createExp0001aAttemptMetricsRegistry({
      directory: registryDirectory,
      binding: prepared.metricsBinding,
      authorizedBindingRoot: prepared.metricsBinding.bindingRoot,
      authorizationReceiptDigest: retainedBinding.authorizationReceiptDigest,
      now,
    });
    const metrics = await registry.requireComplete(anchor.completionSealDigest);
    if (metrics.summary.registryRoot !== anchor.registryRoot
        || metrics.completionSeal?.sealDigest !== anchor.completionSealDigest) {
      throw new Error("External metrics seal anchor does not match the exact complete registry.");
    }
    const expectedAnchor = createAnchor({
      now: metrics.completionSeal.sealedAt,
      authorizationReceiptDigest: retainedBinding.authorizationReceiptDigest,
      runtimeBinding: retainedBinding,
      metrics,
    });
    if (!sameJson(anchor, expectedAnchor)) {
      throw new Error("External metrics seal anchor is not the exact deterministic completion anchor.");
    }
    return Object.freeze({ metrics, externalSealAnchorDigest: anchor.anchorDigest });
  };

  return Object.freeze({
    async run() {
      await ensurePrivateDirectory(options.runtimeDirectory);
      await assertCanonicalPlainParent(options.externalSealAnchorFile);
      await verifyRuntimeEntries(true);
      let lockHandle;
      try {
        lockHandle = await open(
          lockPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("Metrics runtime is already locked; refusing concurrent or uncertain execution.");
        }
        throw error;
      }
      try {
        await lockHandle.writeFile(canonicalJson({ schemaVersion: 1, acquiredAt: now(), pid: process.pid }), "utf8");
        await lockHandle.sync();
        await syncDirectory(options.runtimeDirectory);
        const prepared = await prepare(options);
        await retainOrCompare(bindingPath, prepared.runtimeBinding);
        await retainOrCompare(registryBindingPath, prepared.metricsBinding);
        await ensurePrivateDirectory(registryDirectory);
        const registry = createExp0001aAttemptMetricsRegistry({
          directory: registryDirectory,
          binding: prepared.metricsBinding,
          authorizedBindingRoot: prepared.metricsBinding.bindingRoot,
          authorizationReceiptDigest: prepared.runtimeBinding.authorizationReceiptDigest,
          now,
        });
        const current = await registry.read();
        for (let index = current.events.length; index < prepared.attempts.length; index += 1) {
          await registry.append(prepared.attempts[index]);
        }
        const seal = await registry.seal();
        const metrics = await registry.requireComplete(seal.sealDigest);
        const anchor = createAnchor({
          // The completion seal is immutable, so reusing its time makes a
          // crash between sealing and anchoring byte-identically resumable.
          now: metrics.completionSeal!.sealedAt,
          authorizationReceiptDigest: prepared.runtimeBinding.authorizationReceiptDigest,
          runtimeBinding: prepared.runtimeBinding,
          metrics,
        });
        await retainOrCompare(options.externalSealAnchorFile, anchor);
        return Object.freeze({ metrics, externalSealAnchorDigest: anchor.anchorDigest });
      } finally {
        await lockHandle.close();
        await unlink(lockPath);
        await syncDirectory(options.runtimeDirectory);
      }
    },
    async readComplete() {
      await assertPrivateDirectory(options.runtimeDirectory);
      await assertCanonicalPlainParent(options.externalSealAnchorFile);
      const prepared = await prepare(options);
      return completeFromPrepared(prepared);
    },
  });
}
