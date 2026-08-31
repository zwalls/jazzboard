// @vitest-environment node

import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import benchmark from "../../../research/benchmarks/development-v1.json";
import manifest from "../../../research/data/development-execution-manifest-v1.json";
import productionMetricsSpec from "../../../research/data/exp0001a-attempt-metrics-spec-v1.json";
import {
  createExp0001aReviewAggregateIndex,
  type Exp0001aReviewAggregateSet,
} from "./exp0001a-live-review-runner";
import {
  createExp0001aMetricsRuntime,
  type Exp0001aMetricsRuntimeOptions,
} from "./exp0001a-metrics-runtime";
import { attemptMetricsSpecSchema, computeExp0001aAttemptMetricsSpecDigest } from "./attempt-metrics";
import { canonicalJson, hashCanonicalJson, sha256Digest } from "./provenance-crypto";

vi.mock("./exp0001a-batch-coordinator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exp0001a-batch-coordinator")>();
  return { ...actual, verifyExp0001aBatchRegistry: vi.fn((registry) => registry) };
});

vi.mock("./exp0001a-registry-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exp0001a-registry-bridge")>();
  return {
    ...actual,
    verifyExp0001aRegistryBridge: vi.fn((input: Record<string, unknown>) => ({
      registry: input.registry,
      receipt: input.receipt,
    })),
  };
});

vi.mock("./blinded-review-orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./blinded-review-orchestration")>();
  return {
    ...actual,
    verifyBlindedReviewPlan: vi.fn(),
    verifyReviewLedger: vi.fn(),
    createBlindedReviewPlan: vi.fn((input: { registry: { fixtureReviewPlan: unknown } }) => input.registry.fixtureReviewPlan),
    finalizeArtifactClassifications: vi.fn((_plan: unknown, ledger: { fixtureClassificationBook: unknown }) => ledger.fixtureClassificationBook),
  };
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
  vi.restoreAllMocks();
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactSet(artifacts: Record<string, Buffer>) {
  const leaves = Object.entries(artifacts).map(([artifactPath, contents]) => ({
    path: artifactPath,
    bytes: contents.byteLength,
    sha256: sha256(contents),
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { algorithm: "sha256" as const, leaves, root: sha256(canonicalJson(leaves)) };
}

const attempts = manifest.assignments.flatMap((assignment) => assignment.attempts.map((attempt) => ({
  attemptId: attempt.attemptId,
  pairId: assignment.pairId,
  taskId: assignment.taskId,
  opaqueLabel: attempt.opaqueLabel,
  replicateIndex: assignment.replicateIndex,
  timeBlock: assignment.timeBlock,
  orderIndex: attempt.orderIndex,
})));

function authorResult() {
  return {
    termination: "runner_failed",
    finalText: "",
    toolCalls: 0,
    usage: {
      totals: {
        inputTokens: 0,
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      byTurn: [],
      costInputs: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
      },
    },
  };
}

async function retainAttempt(attemptsRoot: string, attempt: typeof attempts[number]) {
  const directory = path.join(attemptsRoot, attempt.attemptId);
  await mkdir(directory, { mode: 0o700 });
  const authorArtifacts: Record<string, Buffer> = {
    "author-brief.json": Buffer.from(JSON.stringify({ taskId: attempt.taskId, brief: "Exact isolated author brief." })),
    "author-events.jsonl": Buffer.alloc(0),
    "author-final-state.json": Buffer.from(JSON.stringify({ ok: false })),
    "author-final.json": Buffer.from(JSON.stringify(authorResult())),
    "author-identity-commitment.json": Buffer.from(JSON.stringify({ attemptId: attempt.attemptId })),
  };
  const authorEvidenceRoot = artifactSet(authorArtifacts);
  const artifacts: Record<string, Buffer> = {
    ...authorArtifacts,
    "author-evidence-seal.json": Buffer.from(JSON.stringify(authorEvidenceRoot)),
    "coordinator-events.jsonl": Buffer.alloc(0),
  };
  const artifactIndex = artifactSet(artifacts);
  const bundle = {
    schemaVersion: "clean-room-live-attempt/v1",
    attemptId: attempt.attemptId,
    mode: "live",
    status: "runner_failed",
    failure: { message: "fixture interruption" },
    startedAt: "2026-08-30T00:00:00.000Z",
    elapsedMs: 0,
    attemptStartedAt: null,
    author: authorResult(),
    providerIntent: {
      provider: "openai_responses",
      requestedModelIdentifier: "gpt-5.6-sol",
      requestedServiceTier: "default",
      immutableModelSnapshotVerified: false,
    },
    authorEvidenceRoot,
    artifactIndex,
    isolation: {
      authorContextClosedBeforeEvaluation: true,
      evaluatorRole: "spectator",
      apiTransport: "raw_fetch",
    },
  };
  const bundleBytes = Buffer.from(JSON.stringify(bundle));
  const inventory = {
    "attempt-bundle.json": bundleBytes,
    ...artifacts,
  };
  for (const [artifactPath, contents] of Object.entries(inventory)) {
    await writeFile(path.join(directory, artifactPath), contents);
  }
  return {
    artifacts: Object.entries(inventory).map(([artifactPath, contents]) => ({
      path: artifactPath,
      bytes: contents.byteLength,
      sha256: sha256(contents),
    })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    artifactRoot: artifactIndex.root,
    authorEvidenceRoot: authorEvidenceRoot.root,
    attemptBundleSha256: sha256(bundleBytes),
  };
}

function aggregateFixtures(reviewPlan: {
  artifacts: Array<{
    artifactId: string;
    primaryReviewerIds: [string, string];
  }>;
}) {
  const classificationBook = {
    classificationRoot: sha256Digest("classification"),
  };
  const reviewLedger = {
    ledgerRoot: sha256Digest("review-ledger"),
    primaryLocks: reviewPlan.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      reviewerId: artifact.primaryReviewerIds[0],
      recordSha256: sha256("failed-measurement-record"),
      lockedAt: "2026-08-30T00:30:00.000Z",
      record: { status: "failed" },
    })),
    adjudicationLocks: [],
    fixtureClassificationBook: classificationBook,
  };
  const aggregates = {
    reviewLedger,
    classificationBook,
    pairwiseExactRenderCatalog: { catalogRoot: sha256Digest("render-catalog") },
    pairwiseExactRenderVerificationReceipt: { receiptRoot: sha256Digest("render-verification") },
    pairwisePlan: { planRoot: sha256Digest("pairwise-plan") },
    pairwiseLedger: { ledgerRoot: sha256Digest("pairwise-ledger") },
    pairwiseLedgerSeal: { sealRoot: sha256Digest("pairwise-seal") },
    pairwiseReport: { reportRoot: sha256Digest("pairwise-report") },
  } as unknown as Exp0001aReviewAggregateSet;
  return { aggregates, classificationBook, reviewLedger };
}

async function fixture(overrides: Partial<Exp0001aMetricsRuntimeOptions> = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "exp0001a-metrics-runtime-")));
  roots.push(root);
  await chmod(root, 0o700);
  const attemptsRoot = path.join(root, "attempts");
  await mkdir(attemptsRoot, { mode: 0o700 });
  const retained = await Promise.all(attempts.map((attempt) => retainAttempt(attemptsRoot, attempt)));
  const batchRegistry = {
    registryDigest: sha256Digest("batch-registry"),
    events: attempts.map((attempt, index) => ({
      kind: "attempt_retained",
      attemptId: attempt.attemptId,
      data: {
        evidenceComplete: true,
        artifacts: retained[index].artifacts,
        artifactRoot: retained[index].artifactRoot,
        authorEvidenceRoot: retained[index].authorEvidenceRoot,
        attemptBundleSha256: retained[index].attemptBundleSha256,
      },
    })),
  };
  const plan = {
    manifest,
    planDigest: sha256Digest("batch-plan"),
    configs: attempts.map((attempt) => ({ attempt })),
  };
  const sealedAttemptRegistry = {
    registryRoot: sha256Digest("sealed-attempt-registry"),
    runSpecDigest: sha256Digest("sealed-run-spec"),
  };
  const mappings = attempts.map((attempt, manifestPosition) => ({
    manifestPosition,
    attemptId: attempt.attemptId,
    opaqueLabel: attempt.opaqueLabel,
    batchRetainedEventDigest: sha256Digest(`retained:${attempt.attemptId}`),
  }));
  const bridgeReceipt = {
    receiptDigest: sha256Digest("registry-bridge"),
    mappings,
  };
  const roster = Array.from({ length: 3 }, (_, index) => ({
    reviewerId: `reviewer-${index + 1}`,
    identityCommitment: sha256Digest(`reviewer-${index + 1}`),
  }));
  const reviewPlan = {
    schemaVersion: 2,
    registryRoot: sealedAttemptRegistry.registryRoot,
    runSpecDigest: sealedAttemptRegistry.runSpecDigest,
    denominator: 48,
    policy: { assignmentSeed: sha256Digest("assignment"), model: "review-model", serviceTier: "default" },
    reviewerRoster: roster,
    artifacts: attempts.map((attempt) => ({
      artifactId: `artifact-${attempt.attemptId}`,
      attemptId: attempt.attemptId,
      taskId: attempt.taskId,
      authorIdentityCommitment: sha256Digest(`author:${attempt.attemptId}`),
      evidence: { taskId: attempt.taskId },
      primaryReviewerIds: ["reviewer-1", "reviewer-2"] as [string, string],
      primaryWorkItems: [{
        reviewerId: "reviewer-1",
        evaluatorConfig: { measurement: { role: "measurement" } },
      }, {
        reviewerId: "reviewer-2",
        evaluatorConfig: { measurement: { role: "standard" } },
      }],
    })),
    planRoot: sha256Digest("review-plan"),
  };
  Object.assign(sealedAttemptRegistry, { fixtureReviewPlan: reviewPlan });
  const { aggregates, classificationBook, reviewLedger } = aggregateFixtures(reviewPlan);
  const reviewAggregateIndex = createExp0001aReviewAggregateIndex(aggregates);
  const receiptContent = {
    schemaVersion: 1 as const,
    kind: "exp-0001a-review-phase-complete" as const,
    protocolId: "EXP-0001A" as const,
    completedAt: "2026-08-30T01:00:00.000Z",
    authorBatchRegistryDigest: batchRegistry.registryDigest,
    effectiveAliasVerificationRoot: sha256Digest("aliases"),
    sealedAttemptRegistryRoot: sealedAttemptRegistry.registryRoot,
    registryBridgeReceiptDigest: bridgeReceipt.receiptDigest,
    denominator: 48 as const,
    primaryReviewRecords: 96 as const,
    primaryReviewRecordRoot: sha256Digest("primaries"),
    adjudicationReviewRecords: 0,
    adjudicationReviewRecordRoot: sha256Digest("adjudication"),
    classificationCount: 48 as const,
    reviewPlanRoot: reviewPlan.planRoot,
    reviewLedgerRoot: reviewLedger.ledgerRoot,
    classificationRoot: classificationBook.classificationRoot,
    reviewAggregateIndexRoot: reviewAggregateIndex.aggregateIndexRoot,
    pairwiseExactRenderCatalogRoot: sha256Digest("render-catalog"),
    pairwiseExactRenderVerificationReceiptRoot: sha256Digest("render-verification"),
    pairwisePreferenceDenominator: 24 as const,
    pairwisePlanRoot: sha256Digest("pairwise-plan"),
    pairwisePreferenceRecords: 24 as const,
    pairwisePreferenceRecordRoot: sha256Digest("pairwise-records"),
    pairwiseLedgerRoot: sha256Digest("pairwise-ledger"),
    pairwiseLedgerSealRoot: sha256Digest("pairwise-seal"),
    pairwiseReportRoot: sha256Digest("pairwise-report"),
    reviewProgressRoot: sha256Digest("review-progress"),
    spendLedgerRoot: sha256Digest("spend-ledger"),
    spendExternalAnchorRoot: sha256Digest("spend-external-anchor"),
    spendExternalAnchorCount: 196,
    spendAuthorizationReceiptDigest: sha256Digest("spend-authorization"),
    authorizedMaximumUsd: 400,
    userAuthorizedMaximumUsd: 400,
    frozenProtocolMaximumUsd: 487.2 as const,
    observedProviderCostUsd: 100,
    unobservableProviderExposureUsd: 0,
    totalChargedExposureUsd: 100,
  };
  const reviewReceipt = { ...receiptContent, receiptDigest: hashCanonicalJson(receiptContent) };
  const authorizationReceiptDigest = sha256Digest("execution-authorization");
  const options = {
    runtimeDirectory: path.join(root, "metrics"),
    externalSealAnchorFile: path.join(root, "metrics-seal-anchor.json"),
    attemptsRoot,
    plan,
    batchRegistry,
    bridge: {
      prebriefFreeze: {},
      freezeAdapterReceipt: {},
      sealedAttemptRegistry,
      receipt: bridgeReceipt,
    },
    reviewPlan,
    reviewAggregates: aggregates,
    reviewAggregateIndex,
    reviewReceipt,
    committedSourceBytes: {
      taskCatalog: JSON.stringify(benchmark),
      metricsSpec: JSON.stringify(productionMetricsSpec),
      extractor: "committed extractor bytes",
      scorer: "committed scorer bytes",
      registry: "committed registry bytes",
      runtime: "committed runtime bytes",
    },
    bindingAuthority: {
      authorizationReceiptDigest,
      verify: vi.fn(() => true),
    },
    now: () => "2026-08-30T02:00:00.000Z",
    ...overrides,
  } as unknown as Exp0001aMetricsRuntimeOptions;
  return { root, options };
}

describe("EXP-0001A concrete metrics runtime", () => {
  it("parses the exact public production metrics spec and freezes its byte and semantic digests", async () => {
    const bytes = await readFile(path.join(process.cwd(), "research/data/exp0001a-attempt-metrics-spec-v1.json"));
    const parsed = attemptMetricsSpecSchema.parse(JSON.parse(bytes.toString("utf8")));
    expect(sha256Digest(bytes)).toBe("sha256:59d6780af06732e23a8debff8eda170cc72c24d031ad5ff832789d7dec03c358");
    expect(computeExp0001aAttemptMetricsSpecDigest(parsed))
      .toBe("sha256:67082cc589b33567aec6e339e0e828050bc3060a7d72866f62420bdc149b77a2");
    expect(JSON.stringify(parsed)).not.toMatch(/sealed|attemptId|treatment|answer/i);
  });

  it("derives, retains, seals, externally anchors, and byte-identically resumes all 48 attempts", async () => {
    const item = await fixture();
    const runtime = createExp0001aMetricsRuntime(item.options);
    const first = await runtime.run();
    expect(first.metrics.summary).toMatchObject({ retainedAttemptCount: 48, denominatorComplete: true });
    expect(first.metrics.events.every((event) => event.metricsArtifact.scores.correction === null)).toBe(true);
    const anchorBefore = await readFile(item.options.externalSealAnchorFile);

    const resumed = await runtime.run();
    const anchorAfter = await readFile(item.options.externalSealAnchorFile);
    expect(anchorAfter.equals(anchorBefore)).toBe(true);
    expect(resumed.externalSealAnchorDigest).toBe(first.externalSealAnchorDigest);
    expect((await runtime.readComplete()).metrics.summary.registryRoot).toBe(first.metrics.summary.registryRoot);
    expect(item.options.bindingAuthority.verify).toHaveBeenCalled();

    const interrupted = await fixture();
    await mkdir(interrupted.options.runtimeDirectory, { mode: 0o700 });
    for (const fileName of ["binding.json", "registry-binding.json"]) {
      await writeFile(
        path.join(interrupted.options.runtimeDirectory, fileName),
        await readFile(path.join(item.options.runtimeDirectory, fileName)),
        { mode: 0o600 },
      );
    }
    const recovered = await createExp0001aMetricsRuntime(interrupted.options).run();
    expect(recovered.metrics.summary).toMatchObject({ retainedAttemptCount: 48, denominatorComplete: true });
  }, 30_000);

  it("rejects tampered attempt bytes, unexpected runtime evidence, and a missing external anchor", async () => {
    const tampered = await fixture();
    const tamperedRuntime = createExp0001aMetricsRuntime(tampered.options);
    await tamperedRuntime.run();
    const attemptPath = path.join(tampered.options.attemptsRoot, attempts[0].attemptId, "author-final-state.json");
    await writeFile(attemptPath, "tampered");
    await expect(tamperedRuntime.readComplete()).rejects.toThrow(/bytes drift/);

    const unexpected = await fixture();
    const unexpectedRuntime = createExp0001aMetricsRuntime(unexpected.options);
    await unexpectedRuntime.run();
    await writeFile(path.join(unexpected.options.runtimeDirectory, "attacker.json"), "{}");
    await expect(unexpectedRuntime.readComplete()).rejects.toThrow(/unexpected entries/);

    const directBindingTamper = await fixture();
    const directBindingRuntime = createExp0001aMetricsRuntime(directBindingTamper.options);
    await directBindingRuntime.run();
    const registryBindingPath = path.join(directBindingTamper.options.runtimeDirectory, "registry-binding.json");
    const registryBinding = JSON.parse(await readFile(registryBindingPath, "utf8"));
    registryBinding.bindingRoot = sha256Digest("forged-direct-registry-binding");
    await writeFile(registryBindingPath, canonicalJson(registryBinding));
    await expect(directBindingRuntime.readComplete()).rejects.toThrow(/binding root|registry binding/i);

    const missingAnchor = await fixture();
    const missingAnchorRuntime = createExp0001aMetricsRuntime(missingAnchor.options);
    await missingAnchorRuntime.run();
    await unlink(missingAnchor.options.externalSealAnchorFile);
    await expect(missingAnchorRuntime.readComplete()).rejects.toThrow();
  }, 30_000);

  it("rejects source/binding authority failure, symlink evidence, and second-reviewer substitution", async () => {
    const denied = await fixture();
    const deniedAuthority = { ...denied.options.bindingAuthority, verify: vi.fn(() => false) };
    await expect(createExp0001aMetricsRuntime({ ...denied.options, bindingAuthority: deniedAuthority }).run())
      .rejects.toThrow(/authority rejected/);

    const linked = await fixture();
    const victim = path.join(linked.options.attemptsRoot, attempts[0].attemptId, "author-final-state.json");
    await unlink(victim);
    await symlink("author-final.json", victim);
    await expect(createExp0001aMetricsRuntime(linked.options).run()).rejects.toThrow(/symbolic link/);

    const forged = await fixture();
    const firstArtifactId = forged.options.reviewPlan.artifacts[0].artifactId;
    const forgedLocks = forged.options.reviewAggregates.reviewLedger.primaryLocks.map((lock) => (
      lock.artifactId === firstArtifactId
        ? { ...lock, reviewerId: "reviewer-2" }
        : lock
    ));
    const reviewAggregates = {
      ...forged.options.reviewAggregates,
      reviewLedger: { ...forged.options.reviewAggregates.reviewLedger, primaryLocks: forgedLocks },
    };
    const reviewAggregateIndex = createExp0001aReviewAggregateIndex(reviewAggregates);
    const { receiptDigest: _priorReceiptDigest, ...reviewReceiptContent } = forged.options.reviewReceipt;
    void _priorReceiptDigest;
    const nextReceiptContent = {
      ...reviewReceiptContent,
      reviewAggregateIndexRoot: reviewAggregateIndex.aggregateIndexRoot,
    };
    const reviewReceipt = { ...nextReceiptContent, receiptDigest: hashCanonicalJson(nextReceiptContent) };
    await expect(createExp0001aMetricsRuntime({
      ...forged.options,
      reviewAggregates,
      reviewAggregateIndex,
      reviewReceipt,
    }).run()).rejects.toThrow(/measurement primary has no unique exact review-ledger lock/);
  }, 30_000);

  it("fails on a registry tail gap even when the retained completion seal and anchor still exist", async () => {
    const item = await fixture();
    const runtime = createExp0001aMetricsRuntime(item.options);
    await runtime.run();
    const registryDirectory = path.join(item.options.runtimeDirectory, "registry");
    const eventNames = (await readdir(registryDirectory)).filter((name) => /^\d{6}-/.test(name)).sort();
    await unlink(path.join(registryDirectory, eventNames[47]));
    await expect(runtime.readComplete()).rejects.toThrow(/completion seal|denominator|incomplete/i);
  }, 30_000);
});
