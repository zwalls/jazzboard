import { describe, expect, it } from "vitest";

import {
  allocateAttempt,
  createArtifactIndex,
  createAttemptRegistry,
  sealAttempt,
  transitionAttempt,
} from "./attempt-ledger";
import type { AttemptRegistry, RunSpec } from "./attempt-schemas";
import {
  authorizePairwiseView,
  computeBlindedReviewPlanRoot,
  computeClassificationRoot,
  computeEvaluatorConfigSha256,
  computeEvaluatorRecordSha256,
  computeReviewLedgerRoot,
  createBlindedReviewPlan,
  finalizeArtifactClassifications,
  lockAdjudicationReviews,
  lockPrimaryReviews,
  prepareAdjudicationWork,
  verifyBlindedReviewPlan,
  verifyReviewLedger,
  type BlindedReviewPlan,
  type BlindedReviewPolicy,
  type ClassificationBook,
  type EvaluatorArtifactSource,
  type LockedEvaluatorRecord,
  type ReviewerRosterEntry,
  type ReviewerWorkItem,
} from "./blinded-review-orchestration";
import { canonicalJson, sha256Digest } from "./provenance-crypto";

const times = [
  "2026-08-30T20:00:00.000Z",
  "2026-08-30T20:00:01.000Z",
  "2026-08-30T20:00:02.000Z",
  "2026-08-30T20:00:03.000Z",
  "2026-08-30T20:00:04.000Z",
  "2026-08-30T20:00:05.000Z",
];
const digest = (value: string) => sha256Digest(value);
const bare = (value: string) => digest(value).slice("sha256:".length);

function runSpec(): RunSpec {
  return {
    schemaVersion: 1,
    runId: "run-review-test",
    protocol: { id: "EXP-REVIEW", digest: digest("protocol") },
    conditions: {
      baseline: { gitCommit: "a".repeat(40), buildDigest: digest("build-a"), deploymentUrl: "https://a.test" },
      candidate: { gitCommit: "b".repeat(40), buildDigest: digest("build-b"), deploymentUrl: "https://b.test" },
    },
    runner: { runnerDigest: digest("runner") },
    taskSet: { id: "development", version: "v1", split: "development", commitment: digest("tasks") },
    model: { provider: "openai", snapshot: "author-model", reasoningEffort: "high", temperature: null, seed: null },
    environment: {
      imageDigest: digest("image"),
      browser: "Chromium test",
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      locale: "en-US",
      timezone: "UTC",
    },
    budgets: { wallTimeMs: 600_000, maxToolCalls: 200, maxInputTokens: 100_000, maxOutputTokens: 20_000 },
    createdAt: times[0],
  };
}

function finish(registry: AttemptRegistry, attemptId: string, terminal: "author_completed" | "timeout"): AttemptRegistry {
  let next = transitionAttempt(registry, attemptId, "provisioned", times[1]);
  next = transitionAttempt(next, attemptId, "started", times[2]);
  next = transitionAttempt(next, attemptId, terminal, times[3]);
  return sealAttempt(next, attemptId, times[4], createArtifactIndex(attemptId, []));
}

function registryFixture(): AttemptRegistry {
  let registry = createAttemptRegistry(runSpec());
  registry = allocateAttempt(registry, {
    attemptId: "attempt-internal-a",
    taskId: "dev-architecture-create-checkout",
    taskCommitment: digest("task-a"),
    pairId: "pair-internal",
    condition: "baseline",
    replicateIndex: 0,
    orderIndex: 0,
    timeBlock: 0,
    at: times[0],
  });
  registry = allocateAttempt(registry, {
    attemptId: "attempt-internal-b",
    taskId: "dev-architecture-create-checkout",
    taskCommitment: digest("task-a"),
    pairId: "pair-internal",
    condition: "candidate",
    replicateIndex: 0,
    orderIndex: 1,
    timeBlock: 0,
    at: times[0],
  });
  registry = finish(registry, "attempt-internal-a", "author_completed");
  return finish(registry, "attempt-internal-b", "timeout");
}

const roster: ReviewerRosterEntry[] = ["reviewer-a1", "reviewer-b2", "reviewer-c3", "reviewer-d4", "reviewer-e5"].map((reviewerId) => ({
  reviewerId,
  identityCommitment: digest(`identity:${reviewerId}`),
}));

const policy: BlindedReviewPolicy = {
  schemaVersion: 1,
  assignmentSeed: digest("review-seed"),
  model: "gpt-test-snapshot",
  reasoningEffort: "low",
  inputTokenBudget: 10_000,
  outputTokenBudget: 2_000,
  pricing: {
    currency: "USD",
    inputUsdPerMillionTokens: 1,
    cachedInputUsdPerMillionTokens: 0.1,
    outputUsdPerMillionTokens: 5,
    source: "frozen-test-pricing",
  },
  outputDirectory: "/sealed/reviews",
  createdAt: times[0],
};

function sources(registry: AttemptRegistry): EvaluatorArtifactSource[] {
  return registry.attempts.map((attempt, index) => ({
    schemaVersion: 1,
    attemptId: attempt.attemptId,
    attemptDirectory: `/sealed/artifact-${index + 1}`,
    attemptBundleSha256: bare(`bundle:${attempt.attemptId}`),
    artifactRootSha256: bare(`artifacts:${attempt.attemptId}`),
    evaluatorAuthorEvidenceRootSha256: bare(`author-seal:${attempt.attemptId}`),
    registryAuthorEvidenceRoot: attempt.authorEvidenceRoot!,
    rubricSha256: digest("rubric-a"),
    authorIdentityCommitment: index === 0 ? roster[0].identityCommitment : digest(`author:${index}`),
  }));
}

function planFixture() {
  const registry = registryFixture();
  const artifactSources = sources(registry);
  const plan = createBlindedReviewPlan({ registry, sources: artifactSources, reviewerRoster: roster, policy });
  return { registry, artifactSources, plan };
}

function evaluatorRecord(item: ReviewerWorkItem, accepted: boolean, lockedAt = times[5]): LockedEvaluatorRecord {
  const primaryFailureClass = accepted ? "SUCCESS" as const : "FAIL_SEMANTIC" as const;
  const result = { accepted, primaryFailureClass };
  const unsigned: Omit<LockedEvaluatorRecord, "recordSha256"> = {
    schemaVersion: "blinded-evaluator-run/v1",
    artifactId: item.artifactId,
    taskId: item.evaluatorConfig.taskId,
    reviewer: { id: item.reviewerId, role: item.reviewerRole, invocationCount: 1 },
    lockedAt,
    treatmentLabelKnownAtLock: false,
    pairedArtifactSeenBeforeLock: false,
    configSha256: computeEvaluatorConfigSha256(item.evaluatorConfig),
    budgets: {
      inputTokens: item.evaluatorConfig.inputTokenBudget,
      outputTokens: item.evaluatorConfig.outputTokenBudget,
    },
    pricing: item.evaluatorConfig.pricing,
    status: "scored",
    evidence: {
      attemptBundleSha256: item.evaluatorConfig.expectedAttemptBundleSha256,
      artifactRoot: item.evaluatorConfig.expectedArtifactRoot,
      authorEvidenceRoot: item.evaluatorConfig.expectedAuthorEvidenceRoot,
      rubricSha256: item.evaluatorConfig.expectedRubricSha256.slice("sha256:".length),
      finalStateSha256: bare(`state:${item.artifactId}`),
      spectatorPngSha256: bare(`pixels:${item.artifactId}`),
      spectatorRevision: 7,
      spectatorPngDimensions: { width: 100, height: 80 },
      publicPacketSha256: bare(`packet:${item.artifactId}`),
      authorVisibleSpecVersion: "clean-room-author-visible-spec/v1",
      authorVisibleSpecSha256: bare(`author-spec:${item.artifactId}`),
      authorExecutionContractSha256: bare(`author-contract:${item.artifactId}`),
      coverageComplete: true,
    },
    hashes: {
      promptSha256: bare("prompt"),
      inputSha256: bare(`input:${item.workItemId}`),
      providerRequestSha256: bare(`request:${item.workItemId}`),
      providerOutputSha256: bare(`provider:${item.workItemId}`),
      outputSha256: bare(canonicalJson(result)),
    },
    provider: {
      modelRequested: item.evaluatorConfig.model,
      responseIdSha256: bare(`response:${item.workItemId}`),
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, reasoningTokens: 10, totalTokens: 150 },
      estimatedCostUsd: 0.00035,
    },
    accepted,
    primaryFailureClass,
    result,
    failure: null,
  };
  return { ...unsigned, recordSha256: computeEvaluatorRecordSha256(unsigned as LockedEvaluatorRecord) };
}

function primaryRecords(plan: BlindedReviewPlan) {
  return plan.artifacts.flatMap((artifact, artifactIndex) => artifact.primaryWorkItems.map((item, reviewerIndex) => {
    if (artifactIndex === 1) return evaluatorRecord(item, reviewerIndex === 0);
    return evaluatorRecord(item, true);
  }));
}

describe("trusted blinded review planning", () => {
  it("deterministically assigns two distinct opaque non-author primaries and materializes leakage-free work items", () => {
    const fixture = planFixture();
    const repeated = createBlindedReviewPlan({
      registry: fixture.registry,
      sources: fixture.artifactSources,
      reviewerRoster: [...roster].reverse(),
      policy,
    });
    expect(repeated).toEqual(fixture.plan);
    expect(fixture.plan.denominator).toBe(fixture.registry.attempts.length);
    for (const artifact of fixture.plan.artifacts) {
      expect(new Set(artifact.primaryReviewerIds).size).toBe(2);
      const authorReviewer = roster.find((entry) => entry.identityCommitment === artifact.authorIdentityCommitment);
      expect(artifact.primaryReviewerIds).not.toContain(authorReviewer?.reviewerId);
      for (const item of artifact.primaryWorkItems) {
        expect(item).not.toHaveProperty("attemptId");
        expect(item.evaluatorConfig).not.toHaveProperty("condition");
        expect(item.evaluatorConfig).not.toHaveProperty("pairId");
        expect(item.evaluatorConfig).not.toHaveProperty("orderIndex");
        expect(item.evaluatorConfigSha256).toBe(computeEvaluatorConfigSha256(item.evaluatorConfig));
      }
    }
  });

  it("fails closed on duplicate identities, author-as-reviewer scarcity, and denominator mismatch", () => {
    const registry = registryFixture();
    const artifactSources = sources(registry);
    expect(() => createBlindedReviewPlan({
      registry,
      sources: artifactSources,
      reviewerRoster: [...roster, { ...roster[0], reviewerId: "reviewer-z9" }],
      policy,
    })).toThrow(/identity commitments must be unique/);
    expect(() => createBlindedReviewPlan({
      registry,
      sources: artifactSources,
      reviewerRoster: roster.slice(0, 3),
      policy,
    })).toThrow(/two primaries plus/);
    expect(() => createBlindedReviewPlan({
      registry,
      sources: artifactSources.slice(0, 1),
      reviewerRoster: roster,
      policy,
    })).toThrow(/reconcile exactly/);
  });

  it("detects plan hash drift and config drift even after an attacker re-roots the plan", () => {
    const { plan } = planFixture();
    const tampered = structuredClone(plan);
    tampered.artifacts[0].primaryWorkItems[0].evaluatorConfig.model = "gpt-drifted-snapshot";
    expect(() => verifyBlindedReviewPlan(tampered)).toThrow(/plan root/);
    tampered.planRoot = computeBlindedReviewPlanRoot(tampered);
    expect(() => verifyBlindedReviewPlan(tampered)).toThrow(/configuration drifted/);
  });
});

describe("trusted review locking and adjudication", () => {
  it("rejects missing, duplicate, and tampered primary results", () => {
    const { plan } = planFixture();
    const records = primaryRecords(plan);
    expect(() => lockPrimaryReviews(plan, records.slice(1))).toThrow(/exactly two/);
    expect(() => lockPrimaryReviews(plan, [records[0], records[0], ...records.slice(2)])).toThrow(/Duplicate reviewer identity/);
    const tampered = structuredClone(records);
    tampered[0].recordSha256 = "0".repeat(64);
    expect(() => lockPrimaryReviews(plan, tampered)).toThrow(/record hash/);
  });

  it("retains immutable primary decisions and prepares one distinct adjudicator only for binary disagreement", () => {
    const { plan } = planFixture();
    const records = primaryRecords(plan);
    const primaryLedger = lockPrimaryReviews(plan, records);
    const prepared = prepareAdjudicationWork(plan, primaryLedger);
    expect(prepared.workItems).toHaveLength(1);
    expect(prepared.workItems[0].artifactId).toBe(plan.artifacts[1].artifactId);
    expect(prepared.workItems[0].reviewerRole).toBe("adjudicator");
    expect(plan.artifacts[1].primaryReviewerIds).not.toContain(prepared.workItems[0].reviewerId);
    const source = plan.artifacts[1];
    const authorReviewer = roster.find((entry) => entry.identityCommitment === source.authorIdentityCommitment);
    expect(prepared.workItems[0].reviewerId).not.toBe(authorReviewer?.reviewerId);
    expect(prepared.ledger.primaryLocks.map((lock) => lock.recordSha256)).toEqual(records.map((record) => record.recordSha256));

    const agreedItem = plan.artifacts[0].primaryWorkItems[0];
    const selective = evaluatorRecord({ ...agreedItem, reviewerRole: "adjudicator", reviewerId: "reviewer-z9" }, false);
    expect(() => lockAdjudicationReviews(plan, prepared.ledger, [selective, evaluatorRecord(prepared.workItems[0], true)]))
      .toThrow(/Every and only binary disagreement/);
  });

  it("detects result and immutable-ledger tampering", () => {
    const { plan } = planFixture();
    const records = primaryRecords(plan);
    const outputTampered = structuredClone(records);
    outputTampered[0].result = { accepted: true, primaryFailureClass: "SUCCESS", injected: true };
    outputTampered[0].recordSha256 = computeEvaluatorRecordSha256(outputTampered[0]);
    expect(() => lockPrimaryReviews(plan, outputTampered)).toThrow(/structured result hash/);

    const ledger = lockPrimaryReviews(plan, records);
    const ledgerTampered = structuredClone(ledger);
    ledgerTampered.primaryLocks[0].accepted = false;
    expect(() => verifyReviewLedger(plan, ledgerTampered)).toThrow(/ledger commitment/);
    ledgerTampered.ledgerRoot = computeReviewLedgerRoot(ledgerTampered);
    expect(() => verifyReviewLedger(plan, ledgerTampered)).toThrow(/invalid primary lock|result/);
  });

  it("locks adjudication, reconciles the exact denominator, and applies retained author-outcome failure", () => {
    const { plan } = planFixture();
    const primaryLedger = lockPrimaryReviews(plan, primaryRecords(plan));
    const prepared = prepareAdjudicationWork(plan, primaryLedger);
    expect(() => finalizeArtifactClassifications(plan, prepared.ledger)).toThrow(/adjudications must lock/);
    const adjudicated = lockAdjudicationReviews(plan, prepared.ledger, [evaluatorRecord(prepared.workItems[0], true)]);
    const book = finalizeArtifactClassifications(plan, adjudicated);
    expect(book.denominator).toBe(2);
    expect(book.classifications).toHaveLength(2);
    expect(new Set(book.classifications.map((item) => item.attemptId)).size).toBe(2);
    expect(book.classifications[0]).toMatchObject({ accepted: true, resolution: "primary_agreement" });
    expect(book.classifications[1]).toMatchObject({
      reviewAccepted: true,
      accepted: false,
      primaryFailureClass: "FAIL_AUTHOR_NONCOMPLETION",
      resolution: "author_outcome_override",
    });
  });

  it("forbids pairwise exposure until the full individual denominator is locked", () => {
    const { plan } = planFixture();
    const prepared = prepareAdjudicationWork(plan, lockPrimaryReviews(plan, primaryRecords(plan)));
    const ledger = lockAdjudicationReviews(plan, prepared.ledger, [evaluatorRecord(prepared.workItems[0], false)]);
    const book = finalizeArtifactClassifications(plan, ledger);
    const incomplete = structuredClone(book) as ClassificationBook;
    incomplete.classifications.pop();
    incomplete.classificationRoot = computeClassificationRoot(incomplete);
    expect(() => authorizePairwiseView(incomplete, [book.classifications[0].artifactId, book.classifications[1].artifactId], times[5]))
      .toThrow(/full individual-classification denominator/);
    expect(authorizePairwiseView(book, [book.classifications[0].artifactId, book.classifications[1].artifactId], times[5]))
      .toMatchObject({ classificationRoot: book.classificationRoot, authorizedAt: times[5] });
  });
});
