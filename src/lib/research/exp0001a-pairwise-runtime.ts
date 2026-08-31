import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  type BlindedReviewPlan,
  type ClassificationBook,
  type ReviewerRosterEntry,
  type ReviewLedger,
} from "./blinded-review-orchestration";
import type { DevelopmentExecutionManifest } from "./development-manifest";
import {
  buildPairwiseExactRenderCatalogFromSealedAttempts,
  computePairwiseExecutionBeginRoot,
  computePairwiseInputTokenPreflightRoot,
  computePairwisePreferenceRecordRoot,
  computePairwiseProviderReleaseRoot,
  createPairwiseVisualPreferencePlan,
  executePairwiseVisualPreference,
  lockPairwisePreferenceRecords,
  maximumPairwisePreferenceCallCost,
  pairwiseExactRenderCatalogSchema,
  pairwiseExactRenderVerificationReceiptSchema,
  pairwiseExecutionBeginReceiptSchema,
  pairwiseInputTokenPreflightReceiptSchema,
  pairwisePreferenceLedgerSchema,
  pairwisePreferenceLedgerSealSchema,
  pairwisePreferenceRecordSchema,
  pairwiseProviderReleaseReceiptSchema,
  pairwiseReviewerRosterSchema,
  pairwiseScoringPolicySchema,
  pairwiseVisualPreferencePlanSchema,
  unblindedPairwiseReportSchema,
  unblindPairwiseVisualPreferences,
  verifyPairwisePreferenceLedger,
  verifyPairwiseExecutionCheckpoints,
  verifyPairwiseVisualPreferencePlan,
  type PairwiseExecutionBeginReceipt,
  type PairwiseExecutionDependencies,
  type PairwiseExecutionState,
  type PairwiseInputTokenPreflightReceipt,
  type PairwisePlanContext,
  type PairwisePreferenceLedger,
  type PairwisePreferenceLedgerSeal,
  type PairwisePreferenceRecord,
  type PairwiseProviderResponse,
  type PairwiseProviderReleaseReceipt,
  type PairwiseResponsesRequest,
  type PairwiseReviewerRoster,
  type PairwiseScoringPolicy,
  type PairwiseVisualPreferencePlan,
  type UnblindedPairwiseReport,
} from "./pairwise-visual-preference";
import { canonicalJson, hashCanonicalJson, SHA256_DIGEST_PATTERN, sha256Digest } from "./provenance-crypto";

export const EXP0001A_PAIRWISE_RUNTIME_SOURCE_PATH =
  "src/lib/research/exp0001a-pairwise-runtime.ts" as const;
const CODEX_NATIVE_TRANSPORT_REQUIRED =
  "CODEX_NATIVE_TRANSPORT_REQUIRED: pairwise judges must run as fresh ChatGPT-authenticated Codex tasks.";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });

const aggregateBeginContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-pairwise-aggregate-begin/v1"),
  planRoot: digestSchema,
  orderedRecordRoots: z.array(digestSchema).length(24),
  sealedAt: timestampSchema,
}).strict();

const aggregateBeginSchema = aggregateBeginContentSchema.extend({ beginRoot: digestSchema }).strict();
type AggregateBegin = z.infer<typeof aggregateBeginSchema>;

const ARTIFACT_FILES = Object.freeze({
  catalog: "00-exact-render-catalog.json",
  verification: "01-exact-render-verification.json",
  plan: "02-pairwise-plan.json",
  aggregateBegin: "03-aggregate-begin.json",
  ledger: "04-pairwise-ledger.json",
  seal: "05-pairwise-ledger-seal.json",
  report: "06-unblinded-report.json",
  executions: "executions",
});

const AGGREGATE_SEQUENCE = [
  ARTIFACT_FILES.catalog,
  ARTIFACT_FILES.verification,
  ARTIFACT_FILES.plan,
  ARTIFACT_FILES.aggregateBegin,
  ARTIFACT_FILES.ledger,
  ARTIFACT_FILES.seal,
  ARTIFACT_FILES.report,
] as const;

type RuntimeContextInput = {
  reviewPlan: BlindedReviewPlan;
  reviewLedger: ReviewLedger;
  classificationBook: ClassificationBook;
};

export type Exp0001aPairwiseRuntimeOptions = {
  outputRoot: string;
  manifest: DevelopmentExecutionManifest;
  reviewerRoster: PairwiseReviewerRoster | readonly ReviewerRosterEntry[];
  scorerPolicy: PairwiseScoringPolicy;
  prompt: string;
  /** Test/controlled-clock override used only for the first byte verification. Production should omit it. */
  verifiedAt?: string;
  authorizedAt: string;
  now?: () => string;
};

export type Exp0001aPairwiseAggregateArtifacts = {
  aggregateIndexRoot: string;
  exactRenderCatalogRoot: string;
  exactRenderVerificationReceiptRoot: string;
  planRoot: string;
  ledger: PairwisePreferenceLedger;
  seal: PairwisePreferenceLedgerSeal;
  report: UnblindedPairwiseReport;
};

export type Exp0001aConcretePairwiseRuntime = {
  context(input: RuntimeContextInput): Promise<PairwisePlanContext>;
  run(input: {
    plan: PairwiseVisualPreferencePlan;
    context: PairwisePlanContext;
    workItemId: string;
  }): Promise<PairwisePreferenceRecord>;
  /**
   * Crash reconciliation. Prepared/preflighted work resumes the exact retained
   * bytes; released work is failed closed without another provider call.
   */
  recover(input: {
    plan: PairwiseVisualPreferencePlan;
    context: PairwisePlanContext;
    workItemId: string;
  }): Promise<PairwisePreferenceRecord>;
  load(input: {
    plan: PairwiseVisualPreferencePlan;
    context: PairwisePlanContext;
    workItemId: string;
  }): Promise<PairwisePreferenceRecord | null>;
  sealedAt(): string;
  readAggregate(): Promise<Exp0001aPairwiseAggregateArtifacts | null>;
  artifactPaths: Readonly<Record<keyof typeof ARTIFACT_FILES, string>>;
};

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

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePlainDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error("Pairwise runtime output root must be absolute.");
  const existing = await statNoFollow(directory);
  if (!existing) {
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await syncDirectory(path.dirname(directory));
  }
  const retained = await lstat(directory);
  if (!retained.isDirectory() || retained.isSymbolicLink()) {
    throw new Error("Pairwise runtime output root must be a plain non-symbolic-link directory.");
  }
  return realpath(directory);
}

async function readPlainBytes(filePath: string): Promise<Buffer> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Pairwise retained path is not a plain file: ${filePath}`);
  return readFile(filePath);
}

async function retainJsonExclusive(filePath: string, value: unknown): Promise<void> {
  const bytes = canonicalJson(value);
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") throw error;
    throw new Error(`Immutable pairwise artifact already exists: ${path.basename(filePath)}`);
  }
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
  if ((await readPlainBytes(filePath)).toString("utf8") !== bytes) {
    throw new Error(`Immutable pairwise artifact readback failed: ${path.basename(filePath)}`);
  }
}

async function retainOrVerifyJson(filePath: string, value: unknown): Promise<void> {
  const expected = canonicalJson(value);
  const stat = await statNoFollow(filePath);
  if (!stat) {
    try {
      await retainJsonExclusive(filePath, value);
      return;
    } catch (error) {
      if (!String(error).includes("already exists")) throw error;
    }
  }
  const actual = (await readPlainBytes(filePath)).toString("utf8");
  if (actual !== expected) throw new Error(`Retained pairwise artifact was tampered or belongs to another run: ${path.basename(filePath)}`);
}

async function parseRetained<T>(filePath: string, schema: z.ZodType<T>): Promise<T> {
  const bytes = await readPlainBytes(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Retained pairwise artifact is not JSON: ${path.basename(filePath)}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success || canonicalJson(result.data) !== bytes.toString("utf8")) {
    throw new Error(`Retained pairwise artifact is non-canonical or invalid: ${path.basename(filePath)}`);
  }
  return result.data;
}

function executionFileName(
  plan: PairwiseVisualPreferencePlan,
  index: number,
  kind: "begin" | "preflight" | "release" | "record",
): string {
  const workItemId = plan.assignments[index].workItem.workItemId;
  return `${index.toString().padStart(3, "0")}-${workItemId}-${kind}.json`;
}

async function assertRootInventory(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  const allowed = new Set<string>([...AGGREGATE_SEQUENCE, ARTIFACT_FILES.executions]);
  for (const entry of entries) {
    if (!allowed.has(entry.name) || entry.isSymbolicLink()
        || (entry.name === ARTIFACT_FILES.executions ? !entry.isDirectory() : !entry.isFile())) {
      throw new Error(`Unexpected pairwise runtime artifact: ${entry.name}`);
    }
  }
  const names = new Set(entries.map((entry) => entry.name));
  let missingSeen = false;
  for (const name of AGGREGATE_SEQUENCE) {
    if (!names.has(name)) missingSeen = true;
    else if (missingSeen) throw new Error(`Pairwise aggregate artifact sequence has a gap before ${name}.`);
  }
  if (names.has(ARTIFACT_FILES.executions) && !names.has(ARTIFACT_FILES.plan)) {
    throw new Error("Pairwise execution evidence exists before the immutable plan.");
  }
}

function validateBegin(begin: PairwiseExecutionBeginReceipt): PairwiseExecutionBeginReceipt {
  const parsed = pairwiseExecutionBeginReceiptSchema.parse(begin);
  if (computePairwiseExecutionBeginRoot(parsed) !== parsed.beginRoot
      || sha256Digest(parsed.providerPayloadJson) !== parsed.providerPayloadSha256
      || Buffer.byteLength(parsed.providerPayloadJson, "utf8") !== parsed.providerPayloadBytes) {
    throw new Error("Retained pairwise begin receipt root or provider payload hash is invalid.");
  }
  return parsed;
}

function validateInputPreflight(
  preflight: PairwiseInputTokenPreflightReceipt,
): PairwiseInputTokenPreflightReceipt {
  const parsed = pairwiseInputTokenPreflightReceiptSchema.parse(preflight);
  if (computePairwiseInputTokenPreflightRoot(parsed) !== parsed.preflightRoot) {
    throw new Error("Retained pairwise input-token preflight root is invalid.");
  }
  return parsed;
}

function validateProviderRelease(release: PairwiseProviderReleaseReceipt): PairwiseProviderReleaseReceipt {
  const parsed = pairwiseProviderReleaseReceiptSchema.parse(release);
  if (computePairwiseProviderReleaseRoot(parsed) !== parsed.releaseRoot) {
    throw new Error("Retained pairwise provider-release root is invalid.");
  }
  return parsed;
}

function validateRecordRoot(record: PairwisePreferenceRecord): PairwisePreferenceRecord {
  const parsed = pairwisePreferenceRecordSchema.parse(record);
  if (computePairwisePreferenceRecordRoot(parsed) !== parsed.recordRoot) {
    throw new Error("Retained pairwise record root is invalid.");
  }
  return parsed;
}

export type DurablePairwiseExecutionStore = Pick<
  PairwiseExecutionDependencies,
  "load" | "begin" | "retainInputPreflight" | "releaseProvider" | "lock"
> & {
  audit(): Promise<ReadonlyMap<string, PairwiseExecutionState>>;
};

export async function createDurablePairwiseExecutionStore(input: {
  root: string;
  plan: PairwiseVisualPreferencePlan;
}): Promise<DurablePairwiseExecutionStore> {
  const plan = pairwiseVisualPreferencePlanSchema.parse(input.plan);
  const root = await ensurePlainDirectory(input.root);

  const audit = async (): Promise<Map<string, PairwiseExecutionState>> => {
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      throw new Error("Pairwise execution store contains a non-plain file.");
    }
    const actual = new Set(entries.map((entry) => entry.name));
    const allowed = new Set(plan.assignments.flatMap((_, index) => [
      executionFileName(plan, index, "begin"),
      executionFileName(plan, index, "preflight"),
      executionFileName(plan, index, "release"),
      executionFileName(plan, index, "record"),
    ]));
    const unexpected = [...actual].find((name) => !allowed.has(name));
    if (unexpected) throw new Error(`Unexpected pairwise execution artifact: ${unexpected}`);

    const states = new Map<string, PairwiseExecutionState>();
    let incompleteSeen = false;
    for (let index = 0; index < plan.assignments.length; index += 1) {
      const assignment = plan.assignments[index];
      const beginName = executionFileName(plan, index, "begin");
      const preflightName = executionFileName(plan, index, "preflight");
      const releaseName = executionFileName(plan, index, "release");
      const recordName = executionFileName(plan, index, "record");
      const hasBegin = actual.has(beginName);
      const hasPreflight = actual.has(preflightName);
      const hasRelease = actual.has(releaseName);
      const hasRecord = actual.has(recordName);
      if (!hasBegin && (hasPreflight || hasRelease || hasRecord)) {
        throw new Error(`Pairwise evidence exists without its durable begin: ${assignment.workItem.workItemId}`);
      }
      if (hasRelease && !hasPreflight) {
        throw new Error(`Pairwise provider release exists without an input preflight: ${assignment.workItem.workItemId}`);
      }
      if (!hasBegin) {
        incompleteSeen = true;
        continue;
      }
      if (incompleteSeen) throw new Error(`Pairwise execution sequence has a gap before ${assignment.workItem.workItemId}.`);
      const begin = validateBegin(await parseRetained(path.join(root, beginName), pairwiseExecutionBeginReceiptSchema));
      if (begin.planRoot !== plan.planRoot || begin.workItemId !== assignment.workItem.workItemId
          || begin.reviewContextId !== assignment.workItem.reviewContextId) {
        throw new Error("Retained pairwise begin receipt belongs to another plan or work item.");
      }
      const preflight = hasPreflight
        ? validateInputPreflight(await parseRetained(
          path.join(root, preflightName),
          pairwiseInputTokenPreflightReceiptSchema,
        ))
        : null;
      if (preflight && (preflight.beginRoot !== begin.beginRoot
          || Date.parse(preflight.measuredAt) < Date.parse(begin.begunAt)
          || preflight.providerPayloadSha256 !== begin.providerPayloadSha256
          || preflight.providerPayloadBytes !== begin.providerPayloadBytes
          || preflight.inputTokenBudget !== plan.scorerPolicy.tokenBudget.inputTokens
          || preflight.maximumCostUsdReserved !== maximumPairwisePreferenceCallCost(plan.scorerPolicy))) {
        throw new Error("Retained pairwise input preflight does not reconcile to its durable begin.");
      }
      const release = hasRelease
        ? validateProviderRelease(await parseRetained(
          path.join(root, releaseName),
          pairwiseProviderReleaseReceiptSchema,
        ))
        : null;
      if (release && (!preflight || !preflight.eligibleForRelease
          || release.beginRoot !== begin.beginRoot
          || release.preflightRoot !== preflight.preflightRoot
          || release.providerPayloadSha256 !== begin.providerPayloadSha256
          || release.providerPayloadBytes !== begin.providerPayloadBytes
          || Date.parse(release.releasedAt) < Date.parse(preflight.measuredAt))) {
        throw new Error("Retained pairwise provider release does not reconcile to its passing input preflight.");
      }
      verifyPairwiseExecutionCheckpoints({
        plan,
        workItemId: begin.workItemId,
        begin,
        preflight,
        release,
      });
      if (!hasRecord) {
        states.set(begin.workItemId, release
          ? { status: "released", begin, preflight: preflight!, release }
          : preflight
            ? { status: "preflighted", begin, preflight }
            : { status: "prepared", begin });
        incompleteSeen = true;
        continue;
      }
      const record = validateRecordRoot(await parseRetained(path.join(root, recordName), pairwisePreferenceRecordSchema));
      const lastCheckpointAt = release?.releasedAt ?? preflight?.measuredAt ?? begin.begunAt;
      if (record.workItemId !== begin.workItemId || record.reviewContextId !== begin.reviewContextId
          || Date.parse(record.lockedAt) < Date.parse(lastCheckpointAt)) {
        throw new Error("Retained pairwise record does not reconcile to its durable execution checkpoints.");
      }
      states.set(begin.workItemId, { status: "locked", begin, preflight, release, record });
    }
    return states;
  };

  return {
    audit,
    load: async (workItemId) => {
      const index = plan.assignments.findIndex((assignment) => assignment.workItem.workItemId === workItemId);
      if (index < 0) throw new Error("Unknown pairwise execution work item.");
      const states = await audit();
      const prior = plan.assignments.slice(0, index);
      if (prior.some((assignment) => states.get(assignment.workItem.workItemId)?.status !== "locked")) {
        throw new Error("Pairwise execution cannot skip an earlier fixed work item.");
      }
      return states.get(workItemId) ?? null;
    },
    begin: async (beginInput) => {
      const begin = validateBegin(beginInput);
      const index = plan.assignments.findIndex((assignment) => assignment.workItem.workItemId === begin.workItemId);
      if (index < 0) throw new Error("Unknown pairwise execution work item.");
      const states = await audit();
      if (states.has(begin.workItemId)) throw new Error("Pairwise work item already has a durable begin.");
      if (plan.assignments.slice(0, index).some((assignment) => states.get(assignment.workItem.workItemId)?.status !== "locked")) {
        throw new Error("Pairwise begin would create a gap in the fixed execution order.");
      }
      await retainJsonExclusive(path.join(root, executionFileName(plan, index, "begin")), begin);
      const retained = await audit();
      if (retained.get(begin.workItemId)?.status !== "prepared") throw new Error("Pairwise begin readback failed.");
    },
    retainInputPreflight: async (preflightInput) => {
      const preflight = validateInputPreflight(preflightInput);
      const states = await audit();
      const state = [...states.values()].find((candidate) => candidate.begin.beginRoot === preflight.beginRoot);
      if (state?.status !== "prepared") {
        throw new Error("Pairwise input preflight lacks its exact prepared begin receipt.");
      }
      const index = plan.assignments.findIndex((assignment) => assignment.workItem.workItemId === state.begin.workItemId);
      await retainJsonExclusive(path.join(root, executionFileName(plan, index, "preflight")), preflight);
      const retained = await audit();
      if (retained.get(state.begin.workItemId)?.status !== "preflighted") {
        throw new Error("Pairwise input preflight readback failed.");
      }
    },
    releaseProvider: async (releaseInput) => {
      const release = validateProviderRelease(releaseInput);
      const states = await audit();
      const state = [...states.values()].find((candidate) => candidate.begin.beginRoot === release.beginRoot);
      if (state?.status !== "preflighted" || !state.preflight.eligibleForRelease
          || release.preflightRoot !== state.preflight.preflightRoot) {
        throw new Error("Pairwise provider release lacks its exact passing input preflight.");
      }
      const index = plan.assignments.findIndex((assignment) => assignment.workItem.workItemId === state.begin.workItemId);
      await retainJsonExclusive(path.join(root, executionFileName(plan, index, "release")), release);
      const retained = await audit();
      if (retained.get(state.begin.workItemId)?.status !== "released") {
        throw new Error("Pairwise provider-release readback failed.");
      }
    },
    lock: async ({ begin: beginInput, preflight: preflightInput, release: releaseInput, record: recordInput }) => {
      const begin = validateBegin(beginInput);
      const preflight = preflightInput === null ? null : validateInputPreflight(preflightInput);
      const release = releaseInput === null ? null : validateProviderRelease(releaseInput);
      const record = validateRecordRoot(recordInput);
      const index = plan.assignments.findIndex((assignment) => assignment.workItem.workItemId === begin.workItemId);
      if (index < 0) throw new Error("Unknown pairwise execution work item.");
      const states = await audit();
      const state = states.get(begin.workItemId);
      const stateMatches = state?.status === "prepared"
        ? preflight === null && release === null
        : state?.status === "preflighted"
          ? preflight !== null && release === null && canonicalJson(state.preflight) === canonicalJson(preflight)
          : state?.status === "released"
            ? preflight !== null && release !== null
              && canonicalJson(state.preflight) === canonicalJson(preflight)
              && canonicalJson(state.release) === canonicalJson(release)
            : false;
      if (!stateMatches || !state || canonicalJson(state.begin) !== canonicalJson(begin)) {
        throw new Error("Pairwise record lock lacks its exact retained execution checkpoints.");
      }
      await retainJsonExclusive(path.join(root, executionFileName(plan, index, "record")), record);
      const retained = await audit();
      if (retained.get(begin.workItemId)?.status !== "locked") throw new Error("Pairwise record readback failed.");
    },
  };
}

/** Tombstone for the removed direct-provider transport. */
export async function invokeExp0001aPairwiseResponses(input: {
  request: PairwiseResponsesRequest;
}): Promise<PairwiseProviderResponse> {
  void input;
  throw new Error(CODEX_NATIVE_TRANSPORT_REQUIRED);
}

async function stageExactImages(
  plan: PairwiseVisualPreferencePlan,
  context: PairwisePlanContext,
  workItemId: string,
) {
  const assignment = plan.assignments.find((candidate) => candidate.workItem.workItemId === workItemId);
  if (!assignment) throw new Error("Unknown pairwise work item.");
  const loadSide = async (side: "left" | "right") => {
    const artifactId = assignment.bindings[side].artifactId;
    const artifact = context.blindedReviewPlan.artifacts.find((candidate) => candidate.artifactId === artifactId);
    if (!artifact) throw new Error("Pairwise private binding references an unknown sealed artifact.");
    const configuredStat = await lstat(artifact.evidence.attemptDirectory);
    if (!configuredStat.isDirectory() || configuredStat.isSymbolicLink()) {
      throw new Error("Pairwise sealed-attempt directory is no longer a plain directory.");
    }
    const attemptDirectory = await realpath(artifact.evidence.attemptDirectory);
    const pngPath = path.join(
      attemptDirectory,
      `spectator-final-r${assignment.workItem[side].render.spectatorRevision}.png`,
    );
    const stat = await lstat(pngPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Pairwise exact render is not a plain PNG file.");
    return {
      opaqueViewId: assignment.workItem[side].opaqueViewId,
      bytes: await readFile(pngPath),
    };
  };
  return { left: await loadSide("left"), right: await loadSide("right") };
}

function aggregateBeginRoot(begin: Omit<AggregateBegin, "beginRoot"> | AggregateBegin): string {
  return hashCanonicalJson(Object.fromEntries(Object.entries(begin).filter(([key]) => key !== "beginRoot")));
}

/**
 * Concrete factory contract for runtime composition. It is structurally
 * compatible with Exp0001aPairwiseReviewRuntime and adds readAggregate().
 */
export async function createExp0001aConcretePairwiseRuntime(
  optionsInput: Exp0001aPairwiseRuntimeOptions,
): Promise<Exp0001aConcretePairwiseRuntime> {
  const root = await ensurePlainDirectory(optionsInput.outputRoot);
  const paths = Object.fromEntries(Object.entries(ARTIFACT_FILES).map(([key, name]) => [key, path.join(root, name)])) as
    Record<keyof typeof ARTIFACT_FILES, string>;
  const reviewerRoster = pairwiseReviewerRosterSchema.parse(optionsInput.reviewerRoster);
  const scorerPolicy = pairwiseScoringPolicySchema.parse(optionsInput.scorerPolicy);
  const firstVerificationTime = optionsInput.verifiedAt === undefined
    ? null
    : timestampSchema.parse(optionsInput.verifiedAt);
  const authorizedAt = timestampSchema.parse(optionsInput.authorizedAt);
  if (sha256Digest(optionsInput.prompt) !== scorerPolicy.promptSha256) {
    throw new Error("Pairwise runtime prompt bytes differ from the frozen scorer-policy commitment.");
  }
  const now = optionsInput.now ?? (() => new Date().toISOString());
  await assertRootInventory(root);

  let retainedContext: PairwisePlanContext | null = null;
  let retainedPlan: PairwiseVisualPreferencePlan | null = null;
  let executionStore: DurablePairwiseExecutionStore | null = null;
  let retainedSealedAt: string | null = null;

  const assertSameRuntime = (planInput: PairwiseVisualPreferencePlan, contextInput: PairwisePlanContext): void => {
    if (!retainedPlan || !retainedContext || planInput.planRoot !== retainedPlan.planRoot) {
      throw new Error("Pairwise runtime was invoked before its exact context and plan were retained.");
    }
    verifyPairwiseVisualPreferencePlan(planInput, contextInput);
    if (canonicalJson(planInput) !== canonicalJson(retainedPlan)
        || contextInput.exactRenderVerificationReceipt.receiptRoot
          !== retainedContext.exactRenderVerificationReceipt.receiptRoot) {
      throw new Error("Pairwise runtime invocation drifted from its retained exact context.");
    }
  };

  const readAggregate = async (): Promise<Exp0001aPairwiseAggregateArtifacts | null> => {
    await assertRootInventory(root);
    const ledgerStat = await statNoFollow(paths.ledger);
    const sealStat = await statNoFollow(paths.seal);
    const reportStat = await statNoFollow(paths.report);
    if (!ledgerStat && !sealStat && !reportStat) return null;
    if (!ledgerStat || !sealStat || !reportStat) throw new Error("Pairwise aggregate artifacts are only partially retained.");
    const begin = await parseRetained(paths.aggregateBegin, aggregateBeginSchema);
    const catalog = await parseRetained(paths.catalog, pairwiseExactRenderCatalogSchema);
    const verification = await parseRetained(paths.verification, pairwiseExactRenderVerificationReceiptSchema);
    const plan = await parseRetained(paths.plan, pairwiseVisualPreferencePlanSchema);
    const aggregate = {
      aggregateIndexRoot: begin.beginRoot,
      exactRenderCatalogRoot: catalog.catalogRoot,
      exactRenderVerificationReceiptRoot: verification.receiptRoot,
      planRoot: plan.planRoot,
      ledger: await parseRetained(paths.ledger, pairwisePreferenceLedgerSchema),
      seal: await parseRetained(paths.seal, pairwisePreferenceLedgerSealSchema),
      report: await parseRetained(paths.report, unblindedPairwiseReportSchema),
    };
    if (retainedPlan && retainedContext) {
      if (aggregateBeginRoot(begin) !== begin.beginRoot || begin.planRoot !== retainedPlan.planRoot
          || aggregate.planRoot !== retainedPlan.planRoot
          || aggregate.exactRenderCatalogRoot !== retainedContext.exactRenderCatalog.catalogRoot
          || aggregate.exactRenderVerificationReceiptRoot !== retainedContext.exactRenderVerificationReceipt.receiptRoot
          || canonicalJson(begin.orderedRecordRoots) !== canonicalJson(aggregate.ledger.records.map((record) => record.recordRoot))) {
        throw new Error("Retained pairwise aggregate index or exact-render roots drifted from the frozen context.");
      }
      verifyPairwisePreferenceLedger(retainedPlan, aggregate.ledger, aggregate.seal);
      const expectedReport = unblindPairwiseVisualPreferences({
        context: retainedContext,
        plan: retainedPlan,
        ledger: aggregate.ledger,
        seal: aggregate.seal,
      });
      if (canonicalJson(expectedReport) !== canonicalJson(aggregate.report)) {
        throw new Error("Retained unblinded pairwise report differs from its immutable ledger and seal.");
      }
    }
    return aggregate;
  };

  const maybeFinalize = async (): Promise<Exp0001aPairwiseAggregateArtifacts | null> => {
    if (!retainedPlan || !retainedContext || !executionStore) return null;
    const completeAggregate = await statNoFollow(paths.report);
    if (completeAggregate) {
      const existing = await readAggregate();
      if (!existing) throw new Error("Pairwise aggregate report exists without a complete aggregate.");
      const begin = await parseRetained(paths.aggregateBegin, aggregateBeginSchema);
      if (aggregateBeginRoot(begin) !== begin.beginRoot
          || canonicalJson(begin.orderedRecordRoots) !== canonicalJson(existing.ledger.records.map((record) => record.recordRoot))) {
        throw new Error("Pairwise aggregate begin root or ordered record commitment is invalid.");
      }
      retainedSealedAt = begin.sealedAt;
      return existing;
    }
    const states = await executionStore.audit();
    const records = retainedPlan.assignments.map((assignment) => {
      const state = states.get(assignment.workItem.workItemId);
      return state?.status === "locked" ? state.record : null;
    });
    const beginStat = await statNoFollow(paths.aggregateBegin);
    if (records.some((record) => record === null)) {
      if (beginStat) {
        throw new Error("Pairwise aggregate begin exists before all 24 immutable records are retained.");
      }
      return null;
    }
    const exactRecords = records as PairwisePreferenceRecord[];
    const orderedRecordRoots = exactRecords.map((record) => record.recordRoot);
    let begin: AggregateBegin;
    if (beginStat) {
      begin = await parseRetained(paths.aggregateBegin, aggregateBeginSchema);
      if (aggregateBeginRoot(begin) !== begin.beginRoot || begin.planRoot !== retainedPlan.planRoot
          || canonicalJson(begin.orderedRecordRoots) !== canonicalJson(orderedRecordRoots)) {
        throw new Error("Retained pairwise aggregate begin differs from the complete immutable record set.");
      }
    } else {
      const content = aggregateBeginContentSchema.parse({
        schemaVersion: "exp-0001a-pairwise-aggregate-begin/v1",
        planRoot: retainedPlan.planRoot,
        orderedRecordRoots,
        sealedAt: timestampSchema.parse(now()),
      });
      begin = aggregateBeginSchema.parse({ ...content, beginRoot: aggregateBeginRoot(content) });
      await retainJsonExclusive(paths.aggregateBegin, begin);
    }
    retainedSealedAt = begin.sealedAt;
    const locked = lockPairwisePreferenceRecords(retainedPlan, retainedContext, exactRecords, begin.sealedAt);
    const report = unblindPairwiseVisualPreferences({
      context: retainedContext,
      plan: retainedPlan,
      ledger: locked.ledger,
      seal: locked.seal,
    });
    await retainOrVerifyJson(paths.ledger, locked.ledger);
    await retainOrVerifyJson(paths.seal, locked.seal);
    await retainOrVerifyJson(paths.report, report);
    return {
      aggregateIndexRoot: begin.beginRoot,
      exactRenderCatalogRoot: retainedContext.exactRenderCatalog.catalogRoot,
      exactRenderVerificationReceiptRoot: retainedContext.exactRenderVerificationReceipt.receiptRoot,
      planRoot: retainedPlan.planRoot,
      ledger: locked.ledger,
      seal: locked.seal,
      report,
    };
  };

  const executeOne = async (input: {
    plan: PairwiseVisualPreferencePlan;
    context: PairwisePlanContext;
    workItemId: string;
  }): Promise<PairwisePreferenceRecord> => {
    assertSameRuntime(input.plan, input.context);
    if (!executionStore) throw new Error("Pairwise execution store is unavailable.");
    const staged = await stageExactImages(input.plan, input.context, input.workItemId);
    const record = await executePairwiseVisualPreference({
      context: input.context,
      plan: input.plan,
      workItemId: input.workItemId,
      prompt: optionsInput.prompt,
      staged,
      dependencies: {
        load: executionStore.load,
        begin: executionStore.begin,
        retainInputPreflight: executionStore.retainInputPreflight,
        releaseProvider: executionStore.releaseProvider,
        lock: executionStore.lock,
        invokeProvider: (request) => invokeExp0001aPairwiseResponses({ request }),
        now,
      },
    });
    await maybeFinalize();
    return record;
  };

  const runtime: Exp0001aConcretePairwiseRuntime = {
    artifactPaths: Object.freeze(paths),
    context: async ({ reviewPlan, reviewLedger, classificationBook }) => {
      const retainedVerificationStat = await statNoFollow(paths.verification);
      const verificationTime = retainedVerificationStat
        ? (await parseRetained(paths.verification, pairwiseExactRenderVerificationReceiptSchema)).verifiedAt
        : (firstVerificationTime ?? timestampSchema.parse(now()));
      const verified = await buildPairwiseExactRenderCatalogFromSealedAttempts({
        blindedReviewPlan: reviewPlan,
        verifiedAt: verificationTime,
      });
      const context: PairwisePlanContext = {
        manifest: optionsInput.manifest,
        blindedReviewPlan: reviewPlan,
        reviewLedger,
        classificationBook,
        exactRenderCatalog: verified.catalog,
        exactRenderVerificationReceipt: verified.receipt,
        reviewerRoster,
        scorerPolicy,
        authorizedAt,
      };
      const plan = createPairwiseVisualPreferencePlan(context);
      await assertRootInventory(root);
      await retainOrVerifyJson(paths.catalog, pairwiseExactRenderCatalogSchema.parse(verified.catalog));
      await retainOrVerifyJson(paths.verification, pairwiseExactRenderVerificationReceiptSchema.parse(verified.receipt));
      await retainOrVerifyJson(paths.plan, plan);
      await assertRootInventory(root);
      if (!(await statNoFollow(paths.executions))) {
        await mkdir(paths.executions, { recursive: false, mode: 0o700 });
        await syncDirectory(root);
      }
      retainedContext = context;
      retainedPlan = plan;
      executionStore = await createDurablePairwiseExecutionStore({ root: paths.executions, plan });
      const aggregateBeginStat = await statNoFollow(paths.aggregateBegin);
      if (aggregateBeginStat) {
        const begin = await parseRetained(paths.aggregateBegin, aggregateBeginSchema);
        if (aggregateBeginRoot(begin) !== begin.beginRoot) throw new Error("Pairwise aggregate begin root is invalid.");
        retainedSealedAt = begin.sealedAt;
      }
      await maybeFinalize();
      return context;
    },
    run: executeOne,
    recover: executeOne,
    load: async ({ plan, context, workItemId }) => {
      assertSameRuntime(plan, context);
      if (!executionStore) throw new Error("Pairwise execution store is unavailable.");
      const state = await executionStore.load(workItemId);
      await maybeFinalize();
      return state?.status === "locked" ? state.record : null;
    },
    sealedAt: () => {
      if (!retainedSealedAt) throw new Error("Pairwise aggregate is not completely locked and cannot expose a seal time.");
      return retainedSealedAt;
    },
    readAggregate,
  };
  return runtime;
}
