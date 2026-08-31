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
  computeAuthorIdentityArtifactSha256,
  computeAuthorIdentityLinkageCommitment,
  computeBlindedReviewPlanRoot,
  computeClassificationRoot,
  computeEvaluatorConfigSha256,
  computeEvaluatorRecordSha256,
  computeReviewLedgerRoot,
  computeRubricCriteriaCommitment,
  createBlindedReviewPlan,
  estimatedEvaluatorCost,
  EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE,
  EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE_DIGEST,
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
import {
  EXP0001A_REVISION_PACKET_SAMPLER_ID,
  computeBlindedRevisionAssessmentPacketRoot,
  type BlindedRevisionAssessmentPacket,
} from "./attempt-metrics";
import { canonicalJson, hashCanonicalJson, sha256Digest } from "./provenance-crypto";

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
  const identityCommitment = authorIdentity(attemptId);
  const identityPayload = canonicalJson({
    schemaVersion: "author-identity-commitment/v1",
    attemptId,
    identityCommitment,
  });
  return sealAttempt(next, attemptId, times[4], createArtifactIndex(attemptId, [{
    path: "author-identity-commitment.json",
    category: "other",
    mimeType: "application/json",
    bytes: Buffer.byteLength(identityPayload),
    sha256: computeAuthorIdentityArtifactSha256(attemptId, identityCommitment),
  }]));
}

function authorIdentity(attemptId: string): string {
  return attemptId === "attempt-internal-a" ? digest("identity:reviewer-a1") : digest("author:1");
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
  schemaVersion: 2,
  assignmentSeed: digest("review-seed"),
  committedSourceSetRoot: digest("evaluator-committed-source-set"),
  model: "gpt-test-snapshot",
  serviceTier: "default",
  reasoningEffort: "low",
  tokenBudgets: {
    primary: { inputTokens: 10_000, outputTokens: 2_000 },
    adjudicator: { inputTokens: 25_000, outputTokens: 5_000 },
  },
  mechanismTags: ["MECHANISM_SEMANTIC", "MECHANISM_VISUAL"],
  pricing: {
    currency: "USD",
    inputUsdPerMillionTokens: 1,
    cachedInputUsdPerMillionTokens: 0.1,
    cacheWriteInputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 5,
    source: "frozen-test-pricing",
  },
  outputDirectory: "/sealed/reviews",
  createdAt: times[0],
};

function sources(registry: AttemptRegistry): EvaluatorArtifactSource[] {
  return registry.attempts.map((attempt, index) => ({
    schemaVersion: 2,
    attemptId: attempt.attemptId,
    attemptDirectory: `/sealed/artifact-${index + 1}`,
    attemptBundleSha256: bare(`bundle:${attempt.attemptId}`),
    artifactRootSha256: bare(`artifacts:${attempt.attemptId}`),
    evaluatorAuthorEvidenceRootSha256: bare(`author-seal:${attempt.attemptId}`),
    registryAuthorEvidenceRoot: attempt.authorEvidenceRoot!,
    rubricSha256: digest("rubric-a"),
    rubricCriterionIds: ["criterion-a", "criterion-b"],
    rubricCriteriaCommitment: computeRubricCriteriaCommitment(digest("rubric-a"), ["criterion-a", "criterion-b"]),
    authorIdentityCommitment: authorIdentity(attempt.attemptId),
    authorIdentityEvidence: {
      path: "author-identity-commitment.json",
      artifactSha256: computeAuthorIdentityArtifactSha256(attempt.attemptId, authorIdentity(attempt.attemptId)),
      linkageCommitment: computeAuthorIdentityLinkageCommitment({
        attemptId: attempt.attemptId,
        registryAuthorEvidenceRoot: attempt.authorEvidenceRoot!,
        artifactSha256: computeAuthorIdentityArtifactSha256(attempt.attemptId, authorIdentity(attempt.attemptId)),
      }),
    },
  }));
}

function planFixture() {
  const registry = registryFixture();
  const artifactSources = sources(registry);
  const plan = createBlindedReviewPlan({ registry, sources: artifactSources, reviewerRoster: roster, policy });
  return { registry, artifactSources, plan };
}

function measurementPacket(): BlindedRevisionAssessmentPacket {
  const measurementRubricContent = {
    schemaVersion: "exp-0001a-revision-measurement-rubric/v1" as const,
    criteria: [
      { criterionRef: "criterion_01", criterionId: "criterion-a" },
      { criterionRef: "criterion_02", criterionId: "criterion-b" },
    ],
    issueVocabulary: [
      { key: "criterion_failure:criterion_01", kind: "criterion_failure" as const, criterionRef: "criterion_01", blocking: false },
      { key: "criterion_failure:criterion_02", kind: "criterion_failure" as const, criterionRef: "criterion_02", blocking: false },
      { key: "blocking:illegible", kind: "blocking_visual" as const, criterionRef: null, blocking: true },
      { key: "blocking:off_frame", kind: "blocking_visual" as const, criterionRef: null, blocking: true },
      { key: "blocking:relationship_corruption", kind: "blocking_visual" as const, criterionRef: null, blocking: true },
      { key: "blocking:privacy_integrity", kind: "blocking_integrity" as const, criterionRef: null, blocking: true },
      { key: "blocking:protocol_violation", kind: "blocking_integrity" as const, criterionRef: null, blocking: true },
    ],
    semanticScoreDefinition: "count(satisfiedCriterionRefs) / count(criteria); indeterminate or unobservable criteria are not satisfied" as const,
    visualUsabilityScale: [
      { score: 0 as const, definition: "unreadable or unusable" as const },
      { score: 0.25 as const, definition: "major visual barriers prevent practical use" as const },
      { score: 0.5 as const, definition: "usable with material visual friction" as const },
      { score: 0.75 as const, definition: "clear and practically usable with minor defects" as const },
      { score: 1 as const, definition: "clear, coherent, and immediately usable" as const },
    ] as BlindedRevisionAssessmentPacket["measurementRubric"]["visualUsabilityScale"],
    qualityValueDefinition: "(semanticScore + visualUsabilityScore) / 2" as const,
    usefulDraftRule: { minimumSemanticScore: 0.5 as const, minimumVisualUsabilityScore: 0.5 as const, requiresZeroBlockingViolations: true as const },
  };
  const measurementRubric = {
    ...structuredClone(measurementRubricContent),
    rubricDigest: hashCanonicalJson(measurementRubricContent),
  };
  const content = {
    schemaVersion: "exp-0001a-blinded-revision-assessment-packet/v1" as const,
    audience: "preselected_blinded_primary_measurement_reviewer" as const,
    binding: { taskDigest: digest("task-a") },
    measurementRubric,
    sampler: {
      id: EXP0001A_REVISION_PACKET_SAMPLER_ID,
      eligibleAuthorRevisionCount: 0,
      selectedAuthorRevisionCount: 0,
      omittedAuthorRevisionCount: 0,
      omittedRevisionsRoot: digest("omitted:none"),
      deduplicatedAuthorCaptureCount: 0,
      deduplicatedAuthorCapturesRoot: digest("deduplicated:none"),
      finalRevisionDeduplicated: false,
    },
    inventory: [{
      revisionRef: "revision_01",
      chronologyIndex: 1,
      roomRevision: 7,
      kind: "final_spectator" as const,
      pixel: { path: "spectator-final-r7.png", digest: digest("pixels:final"), bytes: 100 },
      semanticState: { path: "spectator-final-state.json" as const, digest: digest("state:final"), bytes: 200 },
    }],
    finalRevisionRef: "revision_01",
  };
  return { ...content, packetRoot: computeBlindedRevisionAssessmentPacketRoot(content) };
}

function evaluatorRecord(item: ReviewerWorkItem, accepted: boolean, lockedAt = times[5]): LockedEvaluatorRecord {
  const primaryFailureClass = accepted ? "SUCCESS" as const : "FAIL_SEMANTIC" as const;
  const packet = item.evaluatorConfig.measurement.role === "measurement" ? measurementPacket() : null;
  const metricsAssessment = packet ? {
    packetRoot: packet.packetRoot,
    revisions: packet.inventory.map((revision) => ({
      revisionRef: revision.revisionRef,
      satisfiedCriterionRefs: accepted ? ["criterion_01", "criterion_02"] : ["criterion_02"],
      issueKeys: accepted ? [] : ["criterion_failure:criterion_01"],
      semanticScore: accepted ? 1 : 0.5,
      visualUsabilityScore: 1 as const,
      blockingViolationCount: 0,
      qualityValue: accepted ? 1 : 0.75,
      usefulDraft: true,
    })),
    finalState: { revisionRef: packet.finalRevisionRef!, successfulArtifact: accepted },
  } : null;
  const result = item.reviewerRole === "adjudicator" ? {
    schemaVersion: "blinded-adjudication-result/v1" as const,
    accepted,
    primaryFailureClass,
    evidenceRefs: ["primary_review:1", "primary_review:2", "semantic_state", "rubric:criterion-a"],
    rationale: "The locked primary findings and frozen artifact evidence support this final decision.",
  } : {
    schemaVersion: "blinded-evaluator-result/v1" as const,
    evidenceCoverage: {
      status: "complete" as const,
      semanticState: true,
      spectatorPixels: true,
      criteriaAddressed: ["criterion-a", "criterion-b"],
      gaps: [],
    },
    criteria: ["criterion-a", "criterion-b"].map((criterionId, index) => ({
      criterionId,
      decision: accepted || index > 0 ? "pass" as const : "fail" as const,
      evidenceRefs: ["semantic_state", "spectator_png", `rubric:${criterionId}`],
      rationale: accepted || index > 0 ? "The criterion passes both frozen views." : "The first criterion fails in frozen evidence.",
    })),
    observations: {
      semantic: { status: accepted ? "pass" as const : "fail" as const, summary: "Semantic evidence was inspected.", evidenceRefs: ["semantic_state"] },
      visual: { status: "pass" as const, summary: "Spectator pixels were inspected.", evidenceRefs: ["spectator_png"] },
      correction: { status: "not_observable" as const, summary: "Author trace is withheld.", evidenceRefs: [] },
      presentation: { status: "not_observable" as const, summary: "Temporal trace is withheld.", evidenceRefs: [] },
      efficiency: { status: "not_observable" as const, summary: "Resource trace is withheld.", evidenceRefs: [] },
    },
    primaryFailureClass,
    mechanismTags: accepted ? [] : [{ tag: "MECHANISM_SEMANTIC", evidenceRefs: ["semantic_state", "rubric:criterion-a"] }],
    causalConfidence: "high" as const,
    metricsAssessment,
    accepted,
    rationale: accepted ? "All mandatory criteria pass." : "A mandatory semantic criterion fails.",
  };
  const usage = {
    inputTokens: 100,
    uncachedInputTokens: 90,
    cachedInputTokens: 5,
    cacheWriteInputTokens: 5,
    outputTokens: 50,
    reasoningTokens: 10,
    totalTokens: 150,
  };
  const unsigned: Omit<LockedEvaluatorRecord, "recordSha256"> = {
    schemaVersion: "blinded-evaluator-run/v1",
    artifactId: item.artifactId,
    taskId: item.evaluatorConfig.taskId,
    reviewer: { id: item.reviewerId, role: item.reviewerRole, invocationCount: 1 },
    lockedAt,
    treatmentLabelKnownAtLock: false,
    pairedArtifactSeenBeforeLock: false,
    committedSourceSetRoot: item.evaluatorConfig.committedSourceSetRoot,
    configSha256: computeEvaluatorConfigSha256(item.evaluatorConfig),
    budgets: {
      inputTokens: item.evaluatorConfig.inputTokenBudget,
      outputTokens: item.evaluatorConfig.outputTokenBudget,
    },
    pricing: item.evaluatorConfig.pricing,
    measurement: {
      role: item.evaluatorConfig.measurement.role,
      packet,
      assessmentOutputSha256: metricsAssessment ? bare(canonicalJson(metricsAssessment)) : null,
    },
    ...(item.evaluatorConfig.adjudication ? {
      adjudication: {
        schemaVersion: item.evaluatorConfig.adjudication.schemaVersion,
        primaryRecordSha256s: item.evaluatorConfig.adjudication.primaryRecordSha256s,
      },
    } : {}),
    status: "scored",
    evidence: {
      attemptBundleSha256: item.evaluatorConfig.expectedAttemptBundleSha256,
      artifactRoot: item.evaluatorConfig.expectedArtifactRoot,
      authorEvidenceRoot: item.evaluatorConfig.expectedAuthorEvidenceRoot,
      authorIdentityCommitment: item.evaluatorConfig.expectedAuthorIdentityCommitment,
      authorIdentityArtifactSha256: item.evaluatorConfig.expectedAuthorIdentityArtifactSha256,
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
      modelObserved: item.evaluatorConfig.model,
      serviceTierRequested: "default",
      serviceTierObserved: "default",
      identityStatus: "observed",
      providerReleaseStatus: "completed",
      responseIdSha256: bare(`response:${item.workItemId}`),
      usage,
      usageDetailsStatus: "observed",
      estimatedCostUsd: estimatedEvaluatorCost(usage, item.evaluatorConfig.pricing),
      inputPreflight: {
        algorithm: "canonical-nonimage-utf8-plus-gpt56-vision-patches-v2",
        providerRequestSha256: bare(`request:${item.workItemId}`),
        nonImagePayloadBytes: 100,
        providerRequestBytes: 500,
        aggregateRawImageBytes: 100,
        aggregateBase64ImageBytes: 136,
        semanticProjectionBytes: 500,
        semanticEnvelope: {
          envelopeDigest: EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE_DIGEST,
          observed: {
            sourceVisibleTextBytes: 0,
            retainedVisibleTextBytes: 0,
            truncatedTextCount: 0,
            semanticObjectCount: 1,
            drawingObjectCount: 0,
            connectorCount: 0,
            diagramCount: 1,
          },
          limits: EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE.limits,
          withinEnvelope: true,
        },
        images: [{ imageRef: "image_01", bytes: 100, width: 10, height: 10, pixels: 100, detail: "high", conservativeTokenUpperBound: 3_000 }],
        limits: { imageCount: 7, perImageBytes: 10 * 1024 * 1024, aggregateRawImageBytes: 32 * 1024 * 1024, providerRequestBytes: 48 * 1024 * 1024, semanticProjectionBytes: 64 * 1024 },
        requestFixedTokenOverhead: 2_048,
        conservativeInputTokenUpperBound: 5_148,
        inputTokenBudget: item.evaluatorConfig.inputTokenBudget,
        withinImageLimits: true,
        withinAggregateImageLimits: true,
        withinProviderRequestLimit: true,
        withinSemanticProjectionLimit: true,
        withinSemanticEnvelope: true,
        withinInputTokenBudget: true,
        eligibleForRelease: true,
      },
    },
    accepted,
    primaryFailureClass,
    result,
    failure: null,
  };
  return { ...unsigned, recordSha256: computeEvaluatorRecordSha256(unsigned as LockedEvaluatorRecord) };
}

function failedEvaluatorRecord(item: ReviewerWorkItem, lockedAt = times[5]): LockedEvaluatorRecord {
  const unsigned: Omit<LockedEvaluatorRecord, "recordSha256"> = {
    schemaVersion: "blinded-evaluator-run/v1",
    artifactId: item.artifactId,
    taskId: item.evaluatorConfig.taskId,
    reviewer: { id: item.reviewerId, role: item.reviewerRole, invocationCount: 1 },
    lockedAt,
    treatmentLabelKnownAtLock: false,
    pairedArtifactSeenBeforeLock: false,
    committedSourceSetRoot: item.evaluatorConfig.committedSourceSetRoot,
    configSha256: computeEvaluatorConfigSha256(item.evaluatorConfig),
    budgets: { inputTokens: item.evaluatorConfig.inputTokenBudget, outputTokens: item.evaluatorConfig.outputTokenBudget },
    pricing: item.evaluatorConfig.pricing,
    measurement: { role: item.evaluatorConfig.measurement.role, packet: null, assessmentOutputSha256: null },
    status: "failed",
    evidence: null,
    hashes: { promptSha256: null, inputSha256: null, providerRequestSha256: null, providerOutputSha256: null, outputSha256: null },
    provider: {
      modelRequested: item.evaluatorConfig.model,
      modelObserved: null,
      serviceTierRequested: "default",
      serviceTierObserved: null,
      identityStatus: "unobservable",
      providerReleaseStatus: "not_released",
      responseIdSha256: null,
      usage: null,
      usageDetailsStatus: "unobservable",
      estimatedCostUsd: null,
      inputPreflight: null,
    },
    accepted: false,
    primaryFailureClass: "FAIL_EVALUATOR_SCORER",
    result: null,
    failure: { stage: "provider_response", code: "SCORER_FAILED", message: "The evaluator failed and its immutable record was retained." },
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
      expect(artifact.primaryWorkItems.map((item) => item.evaluatorConfig.measurement.role))
        .toEqual(["measurement", "standard"]);
      expect(artifact.primaryWorkItems.map((item) => item.reviewerId)).toEqual(artifact.primaryReviewerIds);
      for (const item of artifact.primaryWorkItems) {
        expect(item).not.toHaveProperty("attemptId");
        expect(item.evaluatorConfig).not.toHaveProperty("condition");
        expect(item.evaluatorConfig).not.toHaveProperty("pairId");
        expect(item.evaluatorConfig).not.toHaveProperty("orderIndex");
        expect(item.evaluatorConfigSha256).toBe(computeEvaluatorConfigSha256(item.evaluatorConfig));
        expect(item.evaluatorConfig.inputTokenBudget).toBe(policy.tokenBudgets.primary.inputTokens);
        expect(item.evaluatorConfig.outputTokenBudget).toBe(policy.tokenBudgets.primary.outputTokens);
        expect(item.evaluatorConfig.expectedAuthorIdentityCommitment).toBe(artifact.authorIdentityCommitment);
        expect(item.evaluatorConfig.expectedAuthorIdentityArtifactSha256).toBe(artifact.evidence.authorIdentityEvidence.artifactSha256);
      }
    }
  });

  it("prices evaluator usage at base rates through 272K input and surcharges the full longer request", () => {
    const pricing = policy.pricing;
    const usageAt = {
      inputTokens: 272_000,
      uncachedInputTokens: 272_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
      reasoningTokens: 20,
      totalTokens: 272_100,
    };
    const usageAbove = { ...usageAt, inputTokens: 272_001, uncachedInputTokens: 272_001, totalTokens: 272_101 };
    expect(estimatedEvaluatorCost(usageAt, pricing)).toBe((
      272_000 * pricing.inputUsdPerMillionTokens + 100 * pricing.outputUsdPerMillionTokens
    ) / 1_000_000);
    expect(estimatedEvaluatorCost(usageAbove, pricing)).toBe((
      272_001 * pricing.inputUsdPerMillionTokens * 2 + 100 * pricing.outputUsdPerMillionTokens * 1.5
    ) / 1_000_000);
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

  it("rejects caller-forged author identity exclusion unless the identity is committed by the sealed registry evidence", () => {
    const registry = registryFixture();
    const forgedSources = structuredClone(sources(registry));
    const source = forgedSources[0];
    source.authorIdentityCommitment = digest("forged-non-reviewer");
    source.authorIdentityEvidence.artifactSha256 = computeAuthorIdentityArtifactSha256(source.attemptId, source.authorIdentityCommitment);
    source.authorIdentityEvidence.linkageCommitment = computeAuthorIdentityLinkageCommitment({
      attemptId: source.attemptId,
      registryAuthorEvidenceRoot: source.registryAuthorEvidenceRoot,
      artifactSha256: source.authorIdentityEvidence.artifactSha256,
    });
    expect(() => createBlindedReviewPlan({ registry, sources: forgedSources, reviewerRoster: roster, policy }))
      .toThrow(/not committed by the retained sealed artifact index/);
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
    expect(prepared.workItems[0].evaluatorConfig.adjudication?.primaryRecordSha256s)
      .toEqual(prepared.ledger.primaryLocks.filter((lock) => lock.artifactId === prepared.workItems[0].artifactId).map((lock) => lock.recordSha256));
    expect(prepared.workItems[0].evaluatorConfig.adjudication?.primaryRecords)
      .toEqual(prepared.ledger.primaryLocks.filter((lock) => lock.artifactId === prepared.workItems[0].artifactId).map((lock) => lock.record));
    expect(plan.artifacts[1].primaryReviewerIds).not.toContain(prepared.workItems[0].reviewerId);
    const source = plan.artifacts[1];
    const authorReviewer = roster.find((entry) => entry.identityCommitment === source.authorIdentityCommitment);
    expect(prepared.workItems[0].reviewerId).not.toBe(authorReviewer?.reviewerId);
    expect(prepared.workItems[0].evaluatorConfig.inputTokenBudget).toBe(policy.tokenBudgets.adjudicator.inputTokens);
    expect(prepared.workItems[0].evaluatorConfig.outputTokenBudget).toBe(policy.tokenBudgets.adjudicator.outputTokens);
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
    Object.assign(outputTampered[0], { result: { accepted: true, primaryFailureClass: "SUCCESS", injected: true } });
    outputTampered[0].recordSha256 = computeEvaluatorRecordSha256(outputTampered[0]);
    expect(() => lockPrimaryReviews(plan, outputTampered)).toThrow();

    const ledger = lockPrimaryReviews(plan, records);
    const ledgerTampered = structuredClone(ledger);
    ledgerTampered.primaryLocks[0].accepted = false;
    expect(() => verifyReviewLedger(plan, ledgerTampered)).toThrow(/ledger commitment/);
    ledgerTampered.ledgerRoot = computeReviewLedgerRoot(ledgerTampered);
    expect(() => verifyReviewLedger(plan, ledgerTampered)).toThrow(/invalid primary lock|result/);
  });

  it("rejects records that rewrite the frozen author-identity evidence", () => {
    const { plan } = planFixture();
    const records = primaryRecords(plan);
    if (!records[0].evidence) throw new Error("Expected scored identity evidence.");
    records[0].evidence.authorIdentityCommitment = digest("forged-author-identity");
    records[0].evidence.authorIdentityArtifactSha256 = computeAuthorIdentityArtifactSha256(
      plan.artifacts[0].attemptId,
      records[0].evidence.authorIdentityCommitment,
    );
    records[0].recordSha256 = computeEvaluatorRecordSha256(records[0]);

    expect(() => lockPrimaryReviews(plan, records)).toThrow(/evidence commitments drifted/);
  });

  it("rejects a forged minimal agreeing vote and a recomputed but dishonest cost", () => {
    const { plan } = planFixture();
    const records = primaryRecords(plan);
    Object.assign(records[0], { result: { accepted: true, primaryFailureClass: "SUCCESS" } });
    records[0].hashes.outputSha256 = bare(canonicalJson(records[0].result));
    records[0].recordSha256 = computeEvaluatorRecordSha256(records[0]);
    expect(() => lockPrimaryReviews(plan, records)).toThrow();

    const incompleteCoverage = primaryRecords(plan);
    const incompleteResult = incompleteCoverage[0].result;
    if (!incompleteResult || incompleteResult.schemaVersion !== "blinded-evaluator-result/v1") throw new Error("Expected a primary result fixture.");
    incompleteResult.criteria = incompleteResult.criteria.slice(0, 1);
    incompleteResult.evidenceCoverage.criteriaAddressed = incompleteResult.evidenceCoverage.criteriaAddressed.slice(0, 1);
    incompleteCoverage[0].hashes.outputSha256 = bare(canonicalJson(incompleteResult));
    incompleteCoverage[0].recordSha256 = computeEvaluatorRecordSha256(incompleteCoverage[0]);
    expect(() => lockPrimaryReviews(plan, incompleteCoverage)).toThrow(/Every mandatory public criterion/);

    const costTampered = primaryRecords(plan);
    if (costTampered[0].provider.estimatedCostUsd === null) throw new Error("Expected observed evaluator cost.");
    costTampered[0].provider.estimatedCostUsd += 0.000001;
    costTampered[0].recordSha256 = computeEvaluatorRecordSha256(costTampered[0]);
    expect(() => lockPrimaryReviews(plan, costTampered)).toThrow(/cost must be recomputed exactly/);
  });

  it.each(["one", "both"] as const)("retains %s failed primary record(s), fixes the denominator as unsuccessful, and never creates impossible adjudication", (failureMode) => {
    const { plan } = planFixture();
    const records = primaryRecords(plan);
    const artifact = plan.artifacts[0];
    const firstIndex = records.findIndex((record) => record.artifactId === artifact.artifactId);
    records[firstIndex] = failedEvaluatorRecord(artifact.primaryWorkItems[0]);
    if (failureMode === "both") records[firstIndex + 1] = failedEvaluatorRecord(artifact.primaryWorkItems[1]);
    const primaryLedger = lockPrimaryReviews(plan, records);
    expect(primaryLedger.primaryLocks.filter((lock) => lock.artifactId === artifact.artifactId && lock.record.status === "failed"))
      .toHaveLength(failureMode === "both" ? 2 : 1);
    const prepared = prepareAdjudicationWork(plan, primaryLedger);
    expect(prepared.workItems).toHaveLength(1);
    expect(prepared.workItems[0].artifactId).toBe(plan.artifacts[1].artifactId);
    const finalLedger = lockAdjudicationReviews(plan, prepared.ledger, [evaluatorRecord(prepared.workItems[0], true)]);
    const book = finalizeArtifactClassifications(plan, finalLedger);
    expect(book.denominator).toBe(2);
    expect(book.classifications.find((classification) => classification.artifactId === artifact.artifactId)).toMatchObject({
      accepted: false,
      reviewAccepted: false,
      primaryFailureClass: "FAIL_EVALUATOR_SCORER",
      resolution: "primary_scorer_failure",
    });
    expect(finalLedger.adjudicationAssignments.map((assignment) => assignment.artifactId)).not.toContain(artifact.artifactId);
  });

  it("preserves class-only disagreement and resolves it by frozen precedence without adjudication", () => {
    const { plan } = planFixture();
    const records = primaryRecords(plan);
    const artifact = plan.artifacts[0];
    const indexes = records
      .map((record, index) => record.artifactId === artifact.artifactId ? index : -1)
      .filter((index) => index >= 0);
    records[indexes[0]] = evaluatorRecord(artifact.primaryWorkItems[0], false);
    records[indexes[1]] = evaluatorRecord(artifact.primaryWorkItems[1], false);
    const second = records[indexes[1]];
    if (!second.result || second.result.schemaVersion !== "blinded-evaluator-result/v1") throw new Error("Expected primary result.");
    second.primaryFailureClass = "FAIL_GEOMETRY_VISUAL";
    second.result.primaryFailureClass = "FAIL_GEOMETRY_VISUAL";
    second.hashes.outputSha256 = bare(canonicalJson(second.result));
    second.recordSha256 = computeEvaluatorRecordSha256(second);

    const prepared = prepareAdjudicationWork(plan, lockPrimaryReviews(plan, records));
    expect(prepared.workItems.map((item) => item.artifactId)).not.toContain(artifact.artifactId);
    const finalLedger = lockAdjudicationReviews(plan, prepared.ledger, [evaluatorRecord(prepared.workItems[0], true)]);
    const classification = finalizeArtifactClassifications(plan, finalLedger).classifications
      .find((candidate) => candidate.artifactId === artifact.artifactId);
    expect(classification).toMatchObject({
      accepted: false,
      reviewAccepted: false,
      primaryFailureClasses: ["FAIL_SEMANTIC", "FAIL_GEOMETRY_VISUAL"],
      primaryClassAgreement: false,
      primaryFailureClass: "FAIL_SEMANTIC",
      resolution: "frozen_precedence_without_adjudication",
      adjudicationRecordSha256: null,
    });
  });

  it("rejects stale adjudication commitments and evidence references outside the frozen artifact", () => {
    const { plan } = planFixture();
    const prepared = prepareAdjudicationWork(plan, lockPrimaryReviews(plan, primaryRecords(plan)));
    const stale = structuredClone(prepared.ledger);
    const assignment = stale.adjudicationAssignments[0];
    assignment.workItem.evaluatorConfig.adjudication!.primaryRecordSha256s[0] = "0".repeat(64);
    assignment.workItem.evaluatorConfigSha256 = computeEvaluatorConfigSha256(assignment.workItem.evaluatorConfig);
    assignment.primaryRecordSha256s[0] = "0".repeat(64);
    stale.ledgerRoot = computeReviewLedgerRoot(stale);
    expect(() => verifyReviewLedger(plan, stale)).toThrow(/assignment drifted/);

    const invalidRefs = evaluatorRecord(prepared.workItems[0], true);
    invalidRefs.result = {
      schemaVersion: "blinded-adjudication-result/v1",
      accepted: true,
      primaryFailureClass: "SUCCESS",
      evidenceRefs: ["primary_review:1", "semantic_state", "pair:other-artifact"],
      rationale: "Invalid cross-artifact reference.",
    };
    invalidRefs.hashes.outputSha256 = bare(canonicalJson(invalidRefs.result));
    invalidRefs.recordSha256 = computeEvaluatorRecordSha256(invalidRefs);
    expect(() => lockAdjudicationReviews(plan, prepared.ledger, [invalidRefs])).toThrow();
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
