// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import prebriefJson from "../../../research/data/exp-0001a-prebrief-freeze-v1.json";
import { createAtomicRegistryStore } from "./atomic-registry-store";
import { retainedAttemptResult } from "./clean-room-batch-executor";
import {
  runExp0001aBatchCommand,
  computeReviewStageRecordRoot,
  verifyRetainedAttemptEvidence,
  type BatchCommandPaths,
  type Exp0001aBatchCommandOptions,
  type ReviewPhaseControls,
  type ReviewPhaseReceipt,
  type ReviewPhaseResumeState,
  type ReviewPhaseRunner,
} from "./exp0001a-batch-command";
import {
  computeAuthorIdentityLinkageCommitment,
  computeRubricCriteriaCommitment,
  createBlindedReviewPlan,
  type BlindedReviewPolicy,
  type EvaluatorArtifactSource,
  type ReviewerRosterEntry,
} from "./blinded-review-orchestration";
import {
  computeExp0001aEffectiveAliasVerificationRoot,
  createExp0001aBatchPlan,
  initializeExp0001aBatchRegistry,
  runExp0001aBatch,
  verifyExp0001aBatchRegistry,
  type BatchAttemptExecutor,
  type BatchExecutorResult,
} from "./exp0001a-batch-coordinator";
import {
  EXP0001A_AUTHOR_SESSION_IDENTITIES,
  exp0001aAuthorIdentityCommitments,
} from "./exp0001a-author-identities";
import {
  createExp0001aExecutionFreezeAdapterReceipt,
  verifyExp0001aAdapterPrebriefSource,
  verifyExp0001aExecutionFreezeAdapterReceipt,
} from "./exp0001a-experiment-freeze-adapter";
import {
  REQUIRED_EXECUTION_CRITICAL_SOURCE_ROLES,
  type Exp0001aExecutionReadyReceipt,
  type Exp0001aNoBriefEvidence,
} from "./exp0001a-execution-gate";
import { verifyExp0001aRegistryBridge } from "./exp0001a-registry-bridge";
import { computeExp0001aReleaseGateInvocationDigest } from "./exp0001a-per-attempt-alias-verifier";
import { createExp0001aSpendLedger } from "./exp0001a-spend-ledger";
import { canonicalJson, hashCanonicalJson, sha256Digest } from "./provenance-crypto";

const NOW = "2026-08-30T20:00:00.000Z";
const RELEASE_TOKEN = "exp0001a-release-token-that-is-longer-than-thirty-two-characters";
const PRICING = {
  currency: "USD",
  inputUsdPerMillionTokens: 4,
  cachedInputUsdPerMillionTokens: 0.4,
  cacheWriteInputUsdPerMillionTokens: 5,
  outputUsdPerMillionTokens: 20,
  source: "openai-sol-pricing-2026-08-30",
} as const;
const PREFLIGHT = {
  batchId: "exp-0001a-batch-command-test",
  method: "authenticated-vercel-cli-or-api",
  authenticated: true,
  alias: "https://www.jazzboard.xyz",
  resolvedDeploymentId: "dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD",
  verifiedAt: "2026-08-30T19:00:00.000Z",
} as const;

function digest(label: string): string {
  return sha256Digest(label);
}

function sourcePath(role: string): string {
  if (role === "batchCli") return "research/scripts/exp0001a-batch-command.mjs";
  if (role === "batchCommandLibrary") return "src/lib/research/exp0001a-batch-command.ts";
  if (role === "liveReviewRunner") return "src/lib/research/exp0001a-live-review-runner.ts";
  if (role === "experimentFreezeAdapter") return "src/lib/research/exp0001a-experiment-freeze-adapter.ts";
  if (role === "batchRegistryBridge") return "src/lib/research/exp0001a-registry-bridge.ts";
  if (role === "authorSessionIdentityManifest") return "src/lib/research/exp0001a-author-identities.ts";
  if (role === "perAttemptAliasVerifier") return "src/lib/research/exp0001a-per-attempt-alias-verifier.ts";
  if (role === "executionAuthorityTrustAnchor") return "research/data/exp0001a-execution-authority-public.pem";
  return `src/lib/research/test-${role}.ts`;
}

function syntheticPrebrief() {
  const source = structuredClone(prebriefJson) as unknown as Record<string, unknown>;
  const frozenSources = source.frozenSources as Record<string, unknown>;
  frozenSources.authorSessionIdentityManifest = {
    path: sourcePath("authorSessionIdentityManifest"),
    fileDigest: digest("author-session-identity-source"),
    manifestRoot: EXP0001A_AUTHOR_SESSION_IDENTITIES.manifestRoot,
  };
  delete source.freezeDigest;
  return verifyExp0001aAdapterPrebriefSource({ ...source, freezeDigest: hashCanonicalJson(source) });
}

function runtimeSources() {
  return [...new Set([...REQUIRED_EXECUTION_CRITICAL_SOURCE_ROLES, "batchCommandLibrary", "liveReviewRunner"])]
    .map((role) => ({ role, path: sourcePath(role), bytes: `synthetic committed bytes:${role}` }))
    .sort((left, right) => left.role.localeCompare(right.role));
}

function readyReceipt(input: {
  prebrief: ReturnType<typeof syntheticPrebrief>;
  noBriefEvidenceDigest: string;
}): Exp0001aExecutionReadyReceipt {
  const sources = runtimeSources();
  const content: Omit<Exp0001aExecutionReadyReceipt, "receiptDigest"> = {
    schemaVersion: 1,
    kind: "exp-0001a-execution-ready",
    protocolId: "EXP-0001A",
    createdAt: "2026-08-30T19:30:00.000Z",
    validUntil: "2026-08-30T21:00:00.000Z",
    freezeDigest: input.prebrief.freezeDigest,
    baseline: {
      gitCommit: input.prebrief.baseline.gitCommit,
      gitTree: input.prebrief.baseline.gitTree,
      deploymentId: input.prebrief.baseline.deploymentId,
      buildId: "bld_crjsfx08s",
      immutableUrl: "https://jazzboard-noy5qxxfd-zwalls-projects.vercel.app/",
      productionUrl: "https://www.jazzboard.xyz/",
    },
    conditionsDigest: input.prebrief.conditions.configurationDigest,
    committedCode: {
      receiptDigest: digest("committed-code"),
      gitCommit: input.prebrief.baseline.gitCommit,
      gitTree: input.prebrief.baseline.gitTree,
      authorSessionIdentityManifestRoot: EXP0001A_AUTHOR_SESSION_IDENTITIES.manifestRoot,
      sourceBindings: sources.map((source, index) => ({
        role: source.role,
        path: source.path,
        mode: "100644" as const,
        fileDigest: sha256Digest(source.bytes),
        blobOid: index.toString(16).padStart(40, "0"),
      })),
    },
    liveContract: {
      envelopeDigest: digest("live-envelope"),
      receiptDigest: digest("live-receipt"),
      gitCommit: input.prebrief.baseline.gitCommit,
      gitTree: input.prebrief.baseline.gitTree,
      capturedAt: "2026-08-30T19:20:00.000Z",
      participantContractDigest: input.prebrief.conditions.A0.participantContractDigest,
      spectatorContractDigest: input.prebrief.conditions.A0.spectatorContractDigest,
    },
    aliasPreflightDigest: digest("alias-preflight"),
    deploymentContinuity: {
      verifierSourceRole: "perAttemptAliasVerifier",
      verifierSourceDigest: sha256Digest(sources.find((source) => source.role === "perAttemptAliasVerifier")!.bytes),
      verificationTiming: "authenticated-vercel-api-immediately-before-each-brief",
      requiredReceiptCountAtCompletion: 48,
      receiptsHashChainedInBatchRegistry: true,
      driftDisposition: "not_started-hard-stop-before-brief",
    },
    noBriefEvidenceDigest: input.noBriefEvidenceDigest,
    executionHost: {
      attestationDigest: digest("execution-host-attestation"),
      capturedAt: "2026-08-30T19:22:00.000Z",
      nodeVersion: "22.22.0",
      platform: "darwin",
      architecture: "arm64",
      operatingSystemBuild: "25G83",
      packageManifestDigest: digest("package-manifest"),
      packageLockDigest: digest("package-lock"),
      runtimeDependencyReceiptDigest: digest("runtime-dependency-receipt"),
      runtimeDependencyComponentSetRoot: digest("runtime-dependency-components"),
      runtimeDependencyReceiptCaptureVerificationDurationMs: 925,
    },
    attestationPolicyDigest: sha256Digest(sources.find((source) => source.role === "executionAuthorityTrustAnchor")!.bytes),
    spendAuthorization: {
      receiptDigest: digest("spend-authorization"),
      authorizationId: "auth-exp0001a-test",
      maximumUsd: 400,
      frozenCapTotalUsd: 487.2,
      scope: {
        attempts: 48,
        primaryReviews: 96,
        maximumAdjudications: 48,
        pairwisePreferences: 24,
      },
      expiresAt: "2026-08-30T21:00:00.000Z",
      pricingRevalidationRequiredBefore: "2026-11-22T00:00:00.000Z",
    },
    assertions: {
      blockedFreezeVerified: true,
      currentBytesEqualCommittedBytes: true,
      gitCommitAndTreeVerified: true,
      liveReceiptCommittedAfterFreeze: true,
      baselineDeploymentExact: true,
      aliasExecutionScientificallyBoundToProtectedImmutableBaseline: true,
      perAttemptDeploymentVerificationRequiredBeforeBrief: true,
      contractsExact: true,
      noBriefsDeliveredUnderExclusiveLock: true,
      spendExplicitAndUnexpired: true,
      aaConditionsIdentical: true,
      executionHostExact: true,
      preProviderCumulativeInputHardCapVerified: true,
      spendAuthorizationExpiresBeforePricingRevalidation: true,
      spendAuthorizationWithinFrozenProtocolCeiling: true,
    },
  };
  return { ...content, receiptDigest: hashCanonicalJson(content) };
}

function registryBytes(registry: unknown): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

function noBriefEvidence(input: {
  prebrief: ReturnType<typeof syntheticPrebrief>;
  registry: ReturnType<typeof initializeExp0001aBatchRegistry>;
  registryBytes: string;
}): Exp0001aNoBriefEvidence {
  const content: Omit<Exp0001aNoBriefEvidence, "receiptDigest"> = {
    schemaVersion: 1,
    kind: "exp-0001a-no-brief-evidence",
    protocolId: "EXP-0001A",
    freezeDigest: input.prebrief.freezeDigest,
    observedAt: "2026-08-30T19:25:00.000Z",
    briefsDelivered: 0,
    begunAttempts: 0,
    registryDigest: input.registry.registryDigest,
    registryFileDigest: sha256Digest(input.registryBytes),
    releaseLock: {
      held: true,
      tokenDigest: sha256Digest(RELEASE_TOKEN),
      expiresAt: "2026-08-30T21:00:00.000Z",
    },
  };
  return { ...content, receiptDigest: hashCanonicalJson(content) };
}

function completeArtifacts(config: Parameters<BatchAttemptExecutor>[0]) {
  const paths = [
    "attempt-bundle.json",
    "author-brief.json",
    "author-events.jsonl",
    "author-evidence-seal.json",
    "author-final.json",
    "author-identity-commitment.json",
    "coordinator-events.jsonl",
    "participant-tool-contract.json",
    "spectator-final-state.json",
    "spectator-final-r7.png",
    "spectator-inspection.json",
    "spectator-tool-contract.json",
  ];
  return paths.map((artifactPath, index) => {
    const artifactDigest = artifactPath === "author-identity-commitment.json"
      ? sha256Digest(canonicalJson({
          schemaVersion: "author-identity-commitment/v1",
          attemptId: config.attempt.attemptId,
          identityCommitment: config.runnerConfig.authorIdentityCommitment,
        }))
      : digest(`${config.attempt.attemptId}:${artifactPath}:${index}`);
    return { path: artifactPath, bytes: 100 + index, sha256: artifactDigest.slice("sha256:".length) };
  });
}

function begunResult(config: Parameters<BatchAttemptExecutor>[0]): Extract<BatchExecutorResult, { kind: "begun" }> {
  const artifacts = completeArtifacts(config);
  const identity = artifacts.find((artifact) => artifact.path === "author-identity-commitment.json")!;
  return {
    kind: "begun",
    finishedAt: "2026-08-30T20:00:02.000Z",
    outcome: "completed",
    usage: {
      inputTokens: 10,
      uncachedInputTokens: 4,
      cachedInputTokens: 3,
      cacheWriteInputTokens: 3,
      outputTokens: 2,
      reasoningOutputTokens: 1,
      totalTokens: 12,
    },
    usageByTurn: [{
      inputTokens: 10,
      uncachedInputTokens: 4,
      cachedInputTokens: 3,
      cacheWriteInputTokens: 3,
      outputTokens: 2,
      reasoningOutputTokens: 1,
      totalTokens: 12,
    }],
    artifacts,
    artifactRoot: digest(`artifact-root:${config.attempt.attemptId}`).slice("sha256:".length),
    authorEvidenceRoot: digest(`author-root:${config.attempt.attemptId}`).slice("sha256:".length),
    attemptBundleSha256: digest(`bundle:${config.attempt.attemptId}`).slice("sha256:".length),
    authorIdentityCommitment: config.runnerConfig.authorIdentityCommitment,
    authorIdentityArtifactSha256: `sha256:${identity.sha256}`,
    costObservability: "observed",
    providerEvidenceDigest: digest(`provider-evidence:${config.attempt.attemptId}`),
    providerIdentity: {
      provider: "openai_responses",
      requestedModelIdentifier: "gpt-5.6-sol",
      requestedServiceTier: "default",
      immutableModelSnapshotVerified: false,
      completedTurns: 1,
      status: "observed",
      observedModelIdentifiers: ["gpt-5.6-sol"],
      observedServiceTiers: ["default"],
      requestedAliasExactMatch: true,
    },
    hardIncident: false,
    falsification: false,
    incidentCode: null,
  };
}

function rawSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function retainedLeaf(outputDir: string, artifactPath: string) {
  const contents = await readFile(path.join(outputDir, artifactPath));
  return { path: artifactPath, bytes: contents.byteLength, sha256: rawSha256(contents) };
}

function retainedEvidenceRoot(leaves: Array<{ path: string; bytes: number; sha256: string }>) {
  const ordered = [...leaves].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { algorithm: "sha256" as const, leaves: ordered, root: rawSha256(canonicalJson(ordered)) };
}

async function writeRetainedCommandAttempt(
  outputRoot: string,
  config: Parameters<BatchAttemptExecutor>[0],
  briefDeliveredAt: string,
  outcome: "completed" | "failed" = "completed",
): Promise<Extract<BatchExecutorResult, { kind: "begun" }>> {
  const outputDir = path.join(outputRoot, config.attempt.attemptId);
  await mkdir(outputDir, { recursive: true });
  const authorUsage = begunResult(config).usage;
  const artifacts: Record<string, string | Buffer> = {
    "author-brief.json": canonicalJson({ task: "frozen" }),
    "author-events.jsonl": `${JSON.stringify({ sequence: 0, type: "responses_request_started", data: { turn: 1 } })}\n${JSON.stringify({ sequence: 1, type: "responses_request_completed", data: { turn: 1 } })}\n`,
    "author-final.json": canonicalJson({ final: "done" }),
    "author-identity-commitment.json": canonicalJson({
      attemptId: config.attempt.attemptId,
      identityCommitment: config.runnerConfig.authorIdentityCommitment,
      schemaVersion: "author-identity-commitment/v1",
    }),
    "coordinator-events.jsonl": `${JSON.stringify({ kind: "attempt_finished" })}\n`,
    "participant-tool-contract.json": canonicalJson({ hash: "participant" }),
    "spectator-final-state.json": canonicalJson({ revision: 7, objects: [] }),
    "spectator-inspection.json": canonicalJson({ ok: true }),
    "spectator-tool-contract.json": canonicalJson({ hash: "spectator" }),
    "spectator-final-r7.png": Buffer.from("exact-pixel-capture"),
  };
  for (const [artifactPath, contents] of Object.entries(artifacts)) {
    await writeFile(path.join(outputDir, artifactPath), contents);
  }
  const authorPaths = [
    "author-brief.json",
    "author-events.jsonl",
    "author-final.json",
    "author-identity-commitment.json",
  ];
  const authorEvidenceRoot = retainedEvidenceRoot(await Promise.all(authorPaths.map((artifactPath) => retainedLeaf(outputDir, artifactPath))));
  await writeFile(path.join(outputDir, "author-evidence-seal.json"), canonicalJson(authorEvidenceRoot));
  const indexedPaths = [...Object.keys(artifacts), "author-evidence-seal.json"];
  const artifactIndex = retainedEvidenceRoot(await Promise.all(indexedPaths.map((artifactPath) => retainedLeaf(outputDir, artifactPath))));
  const identityLeaf = await retainedLeaf(outputDir, "author-identity-commitment.json");
  await writeFile(path.join(outputDir, "attempt-bundle.json"), canonicalJson({
    schemaVersion: "clean-room-live-attempt/v1",
    attemptId: config.attempt.attemptId,
    mode: "live",
    status: outcome === "completed" ? "author_completed" : "author_failed",
    failure: null,
    startedAt: NOW,
    elapsedMs: 2_000,
    attemptStartedAt: briefDeliveredAt,
    author: {
      termination: outcome === "completed" ? "author_completed" : "author_failed",
      usage: { totals: authorUsage, byTurn: [{ turn: 1, ...authorUsage }] },
      observedProvider: {
        provider: "openai_responses",
        completedTurns: 1,
        observedModels: [config.runnerConfig.model],
        observedServiceTiers: [config.runnerConfig.serviceTier],
        allTurnsReportedModel: true,
        allTurnsReportedServiceTier: true,
      },
    },
    providerIntent: {
      provider: "openai_responses",
      requestedModelIdentifier: config.runnerConfig.model,
      requestedServiceTier: config.runnerConfig.serviceTier,
      immutableModelSnapshotVerified: false,
    },
    authorIdentity: {
      identityCommitment: config.runnerConfig.authorIdentityCommitment,
      artifactPath: "author-identity-commitment.json",
      artifactSha256: `sha256:${identityLeaf.sha256}`,
    },
    authorEvidenceRoot,
    artifactIndex,
  }));
  return retainedAttemptResult(
    outputDir,
    config.attempt.attemptId,
    config.runnerConfig.authorIdentityCommitment,
    {
      requestedModelIdentifier: config.runnerConfig.model,
      requestedServiceTier: config.runnerConfig.serviceTier,
    },
    briefDeliveredAt,
  );
}

async function fixture(options: { persistInitialRegistry?: boolean } = {}) {
  const prebrief = syntheticPrebrief();
  const provisionalReady = readyReceipt({ prebrief, noBriefEvidenceDigest: digest("provisional-no-brief") });
  const provisionalAdapter = createExp0001aExecutionFreezeAdapterReceipt({
    prebriefFreeze: prebrief,
    executionReadyReceipt: provisionalReady,
    now: NOW,
  });
  const plan = createExp0001aBatchPlan({
    executionFreeze: provisionalAdapter.legacyExecutionFreeze,
    livePreflight: PREFLIGHT,
    pricing: PRICING,
    authorIdentityCommitments: exp0001aAuthorIdentityCommitments(),
  });
  const initialRegistry = initializeExp0001aBatchRegistry(plan, "2026-08-30T19:25:00.000Z");
  const initialRegistryFileBytes = registryBytes(initialRegistry);
  const noBrief = noBriefEvidence({ prebrief, registry: initialRegistry, registryBytes: initialRegistryFileBytes });
  const ready = readyReceipt({ prebrief, noBriefEvidenceDigest: noBrief.receiptDigest });
  const adapter = createExp0001aExecutionFreezeAdapterReceipt({
    prebriefFreeze: prebrief,
    executionReadyReceipt: ready,
    now: NOW,
  });
  expect(hashCanonicalJson(adapter.legacyExecutionFreeze)).toBe(hashCanonicalJson(plan.executionFreeze));
  const root = await mkdtemp(path.join(os.tmpdir(), "exp0001a-command-"));
  const outputRoot = path.join(root, "attempts");
  const prebriefIncidentRoot = path.join(root, "incidents");
  await mkdir(outputRoot);
  await mkdir(prebriefIncidentRoot);
  const paths: BatchCommandPaths = {
    registryFile: path.join(root, "registry.json"),
    outputRoot,
    prebriefIncidentRoot,
    executionLockFile: path.join(root, "execution.lock"),
    sealedAttemptRegistryFile: path.join(root, "sealed-registry.json"),
    registryBridgeReceiptFile: path.join(root, "registry-bridge.json"),
    reviewPlanFile: path.join(root, "review-plan.json"),
    reviewProgressRoot: path.join(root, "review-progress"),
    spendProgressRoot: path.join(root, "spend-progress"),
    reviewPhaseBegunFile: path.join(root, "review-begun.json"),
    reviewReceiptFile: path.join(root, "review-complete.json"),
  };
  if (options.persistInitialRegistry !== false) {
    await writeFile(paths.registryFile, initialRegistryFileBytes);
  }
  const runtime = runtimeSources().map(({ path: filePath, bytes }) => ({ path: filePath, bytes }));
  const exactAuthorization = {
    executionReadyReceiptDigest: ready.receiptDigest,
    spendAuthorizationReceiptDigest: ready.spendAuthorization.receiptDigest,
    authorizationId: ready.spendAuthorization.authorizationId,
    releaseLockToken: RELEASE_TOKEN,
  };
  const base: Omit<Exp0001aBatchCommandOptions, "paths"> = {
    plan,
    initialRegistry,
    initialRegistryFileBytes,
    prebriefFreeze: prebrief,
    executionFreezeAdapterReceipt: adapter,
    executionReadyReceipt: ready,
    noBriefEvidence: noBrief,
    committedRuntimeFiles: runtime,
    exactAuthorization,
    aliasVerifier: async (expected) => {
      const content = {
        schemaVersion: "exp-0001a-per-attempt-alias-verification/v1" as const,
        protocolId: "EXP-0001A" as const,
        attemptId: expected.attemptId,
        manifestPosition: expected.manifestPosition,
        alias: "https://www.jazzboard.xyz" as const,
        expectedDeploymentId: expected.expectedDeploymentId,
        resolvedDeploymentId: expected.expectedDeploymentId,
        method: "authenticated-vercel-api-immediately-before-brief" as const,
        releaseGateRequestedAt: expected.releaseGateRequestedAt,
        releaseGateInvocationDigest: computeExp0001aReleaseGateInvocationDigest(expected),
        verifiedAt: expected.releaseGateRequestedAt,
        providerResponseDigest: digest(`alias:${expected.attemptId}`),
      };
      return { ...content, receiptDigest: hashCanonicalJson(content) };
    },
    now: () => NOW,
  };
  return { root, paths, prebrief, ready, adapter, plan, initialRegistry, initialRegistryFileBytes, base };
}

const REVIEW_POLICY: BlindedReviewPolicy = {
  schemaVersion: 2,
  assignmentSeed: digest("review-assignment-seed"),
  committedSourceSetRoot: digest("evaluator-committed-source-set"),
  model: "reviewer-model-snapshot",
  serviceTier: "default",
  reasoningEffort: "high",
  tokenBudgets: {
    primary: { inputTokens: 10_000, outputTokens: 2_000 },
    adjudicator: { inputTokens: 25_000, outputTokens: 5_000 },
  },
  mechanismTags: ["MECHANISM_SEMANTIC", "MECHANISM_VISUAL"],
  pricing: PRICING,
  outputDirectory: "/sealed/reviews",
  createdAt: NOW,
};

const REVIEW_ROSTER: ReviewerRosterEntry[] = Array.from({ length: 5 }, (_, index) => ({
  reviewerId: `reviewer-${index + 1}`,
  identityCommitment: digest(`reviewer-identity-${index + 1}`),
}));

function reviewPlan(input: Parameters<ReviewPhaseRunner>[0]) {
  const mappingByAttempt = new Map(input.registryBridgeReceipt.mappings.map((mapping) => [mapping.attemptId, mapping]));
  const sources: EvaluatorArtifactSource[] = input.sealedAttemptRegistry.attempts.map((attempt, index) => {
    const mapping = mappingByAttempt.get(attempt.attemptId)!;
    return {
      schemaVersion: 2,
      attemptId: attempt.attemptId,
      attemptDirectory: `/sealed/review-artifact-${index + 1}`,
      attemptBundleSha256: mapping.batchAttemptBundleSha256!,
      artifactRootSha256: mapping.batchArtifactRoot!,
      evaluatorAuthorEvidenceRootSha256: mapping.batchAuthorEvidenceRoot!,
      registryAuthorEvidenceRoot: attempt.authorEvidenceRoot!,
      rubricSha256: digest("rubric"),
      rubricCriterionIds: ["criterion-semantic", "criterion-visual"],
      rubricCriteriaCommitment: computeRubricCriteriaCommitment(digest("rubric"), ["criterion-semantic", "criterion-visual"]),
      authorIdentityCommitment: mapping.authorIdentityCommitment,
      authorIdentityEvidence: {
        path: "author-identity-commitment.json",
        artifactSha256: mapping.authorIdentityArtifactSha256,
        linkageCommitment: computeAuthorIdentityLinkageCommitment({
          attemptId: attempt.attemptId,
          registryAuthorEvidenceRoot: attempt.authorEvidenceRoot!,
          artifactSha256: mapping.authorIdentityArtifactSha256,
        }),
      },
    };
  });
  return createBlindedReviewPlan({
    registry: input.sealedAttemptRegistry,
    sources,
    reviewerRoster: REVIEW_ROSTER,
    policy: REVIEW_POLICY,
  });
}

function reviewReceipt(input: {
  registryDigest: string;
  registryRoot: string;
  bridgeDigest: string;
  effectiveAliasVerificationRoot: string;
  state: ReviewPhaseResumeState;
  spend: Awaited<ReturnType<ReviewPhaseControls["readSpendSummary"]>>;
  spendAuthorizationReceiptDigest: string;
}): ReviewPhaseReceipt {
  const content: Omit<ReviewPhaseReceipt, "receiptDigest"> = {
    schemaVersion: 1,
    kind: "exp-0001a-review-phase-complete",
    protocolId: "EXP-0001A",
    completedAt: "2026-08-30T20:00:05.000Z",
    authorBatchRegistryDigest: input.registryDigest,
    effectiveAliasVerificationRoot: input.effectiveAliasVerificationRoot,
    sealedAttemptRegistryRoot: input.registryRoot,
    registryBridgeReceiptDigest: input.bridgeDigest,
    denominator: 48,
    primaryReviewRecords: 96,
    primaryReviewRecordRoot: computeReviewStageRecordRoot(input.state, "primary"),
    adjudicationReviewRecords: input.state.expectedWorkItemIds.adjudication.length,
    adjudicationReviewRecordRoot: computeReviewStageRecordRoot(input.state, "adjudication"),
    classificationCount: 48,
    reviewPlanRoot: input.state.reviewPlanRoot!,
    reviewLedgerRoot: input.state.classification!.reviewLedgerRoot,
    classificationRoot: input.state.classification!.classificationRoot,
    reviewAggregateIndexRoot: digest("review-aggregate-index"),
    pairwiseExactRenderCatalogRoot: digest("pairwise-exact-render-catalog"),
    pairwiseExactRenderVerificationReceiptRoot: digest("pairwise-exact-render-verification"),
    pairwisePreferenceDenominator: 24,
    pairwisePlanRoot: digest("pairwise-plan"),
    pairwisePreferenceRecords: 24,
    pairwisePreferenceRecordRoot: computeReviewStageRecordRoot(input.state, "pairwise"),
    pairwiseLedgerRoot: digest("pairwise-ledger"),
    pairwiseLedgerSealRoot: digest("pairwise-ledger-seal"),
    pairwiseReportRoot: digest("pairwise-report"),
    reviewProgressRoot: input.state.progressRoot,
    spendLedgerRoot: input.spend.ledgerRoot,
    spendExternalAnchorRoot: input.spend.externalAnchorRoot,
    spendExternalAnchorCount: input.spend.externalAnchorCount,
    spendAuthorizationReceiptDigest: input.spendAuthorizationReceiptDigest,
    authorizedMaximumUsd: input.spend.authorizedMaximumUsd,
    userAuthorizedMaximumUsd: input.spend.userAuthorizedMaximumUsd,
    frozenProtocolMaximumUsd: input.spend.frozenProtocolMaximumUsd,
    observedProviderCostUsd: input.spend.observedSettledUsd,
    unobservableProviderExposureUsd: input.spend.unobservableReservedExposureUsd,
    totalChargedExposureUsd: input.spend.totalChargedExposureUsd,
  };
  return { ...content, receiptDigest: hashCanonicalJson(content) };
}

async function finishReview(
  input: Parameters<ReviewPhaseRunner>[0],
  controls: ReviewPhaseControls,
  hooks: {
    afterPhaseBegun?: () => void | Promise<void>;
    afterPrimaryLocks?: (locked: number) => void | Promise<void>;
  } = {},
): Promise<ReviewPhaseReceipt> {
  const reserve = (stage: "primary" | "adjudication" | "pairwise", workItemId: string) => ({
    at: NOW,
    stage,
    workItemId,
    maximumCostUsd: 0.01,
    budgetDigest: digest(`budget:${stage}`),
    pricingDigest: digest(`pricing:${stage}`),
  });
  let state = input.resume;
  if (!state.phaseBegun) {
    state = await controls.onReviewPhaseBegun({ at: "2026-08-30T20:00:04.000Z", reviewPlan: reviewPlan(input) });
    await hooks.afterPhaseBegun?.();
  }
  let locked = 0;
  for (const workItemId of [...state.pendingWorkItemIds.primary]) {
    await controls.onReviewWorkItemBegun(reserve("primary", workItemId));
    state = await controls.onReviewWorkItemLocked({
      at: NOW,
      stage: "primary",
      workItemId,
      recordRoot: digest(`primary-record:${workItemId}`),
      status: "scored",
      spend: { observability: "unobservable" },
    });
    locked += 1;
    await hooks.afterPrimaryLocks?.(locked);
  }
  if (!state.plannedStages.includes("adjudication")) {
    state = await controls.onReviewStagePlanned({ at: NOW, stage: "adjudication", planRoot: digest("adjudication-plan"), workItemIds: [] });
  }
  if (state.classification === null) {
    state = await controls.onClassificationsLocked({
      at: NOW,
      count: 48,
      reviewLedgerRoot: digest("review-ledger"),
      classificationRoot: digest("classification"),
    });
  }
  if (!state.plannedStages.includes("pairwise")) {
    state = await controls.onReviewStagePlanned({
      at: NOW,
      stage: "pairwise",
      planRoot: digest("pairwise-plan"),
      workItemIds: Array.from({ length: 24 }, (_, index) => `pairwise-work-${index + 1}`),
    });
  }
  for (const workItemId of [...state.pendingWorkItemIds.pairwise]) {
    await controls.onReviewWorkItemBegun(reserve("pairwise", workItemId));
    state = await controls.onReviewWorkItemLocked({
      at: NOW,
      stage: "pairwise",
      workItemId,
      recordRoot: digest(`pairwise-record:${workItemId}`),
      status: "scored",
      spend: { observability: "unobservable" },
    });
  }
  return reviewReceipt({
    registryDigest: input.authorBatchRegistry.registryDigest,
    registryRoot: input.sealedAttemptRegistry.registryRoot,
    bridgeDigest: input.registryBridgeReceipt.receiptDigest,
    effectiveAliasVerificationRoot: computeExp0001aEffectiveAliasVerificationRoot(input.authorBatchRegistry, input.plan),
    state,
    spend: await controls.readSpendSummary(),
    spendAuthorizationReceiptDigest: input.spendAuthorizationReceiptDigest,
  });
}

function authority(ready: Exp0001aExecutionReadyReceipt) {
  return {
    policyDigest: ready.attestationPolicyDigest,
    verify: vi.fn(async () => true),
  };
}

describe("EXP-0001A safe batch command", () => {
  it("derives a deterministic legacy plan view only from matching verified sources", async () => {
    const item = await fixture();
    expect(verifyExp0001aExecutionFreezeAdapterReceipt({
      receipt: item.adapter,
      prebriefFreeze: item.prebrief,
      executionReadyReceipt: item.ready,
      now: NOW,
    })).toEqual(item.adapter);
    const tampered = structuredClone(item.prebrief);
    tampered.conditions.A0.authorBudgets.toolCalls += 1;
    expect(() => createExp0001aExecutionFreezeAdapterReceipt({
      prebriefFreeze: tampered,
      executionReadyReceipt: item.ready,
      now: NOW,
    })).toThrow(/digest|identical/i);
  });

  it("is dry-run by default and invokes no executor, reviewer, authority, or filesystem write", async () => {
    const item = await fixture({ persistInitialRegistry: false });
    const executor = vi.fn();
    const reviewRunner = vi.fn();
    const trusted = authority(item.ready);
    const result = await runExp0001aBatchCommand({ ...item.base, paths: item.paths, executor, reviewRunner, executionAuthority: trusted });
    expect(result).toMatchObject({ mode: "dry-run", status: "dry_run", invokedAttemptIds: [], reviewReceipt: null });
    expect(result.preflight).toMatchObject({ ok: true, authorIdentityManifestRoot: EXP0001A_AUTHOR_SESSION_IDENTITIES.manifestRoot });
    expect(executor).not.toHaveBeenCalled();
    expect(reviewRunner).not.toHaveBeenCalled();
    expect(trusted.verify).not.toHaveBeenCalled();
    await expect(readFile(item.paths.registryFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-reads terminal bytes and rejects retained artifact tamper or deletion before resume", async () => {
    const item = await fixture();
    const store = createAtomicRegistryStore({
      filePath: item.paths.registryFile,
      validate: (value) => verifyExp0001aBatchRegistry(value, item.plan),
      identity: (value) => value.registryDigest,
    });
    await store.initialize(item.initialRegistry);
    const batch = await runExp0001aBatch({
      plan: item.plan,
      registry: item.initialRegistry,
      mode: "execute",
      executionAuthorized: true,
      registryStore: store,
      verifyAliasBeforeAttempt: item.base.aliasVerifier,
      maxAssignments: 1,
      executor: async (config, controls) => {
        await controls.onBriefDelivered(NOW);
        return writeRetainedCommandAttempt(item.paths.outputRoot, config, NOW);
      },
    });
    await expect(verifyRetainedAttemptEvidence({
      plan: item.plan,
      registry: batch.registry,
      outputRoot: item.paths.outputRoot,
    })).resolves.toBeUndefined();

    const attemptPath = path.join(item.paths.outputRoot, item.plan.configs[0].attempt.attemptId);
    const statePath = path.join(attemptPath, "spectator-final-state.json");
    const originalState = await readFile(statePath);
    await writeFile(statePath, canonicalJson({ revision: 999, objects: [] }));
    await expect(verifyRetainedAttemptEvidence({
      plan: item.plan,
      registry: batch.registry,
      outputRoot: item.paths.outputRoot,
    })).rejects.toThrow(/artifact index/i);

    await writeFile(statePath, originalState);
    await unlink(path.join(attemptPath, "attempt-bundle.json"));
    await expect(verifyRetainedAttemptEvidence({
      plan: item.plan,
      registry: batch.registry,
      outputRoot: item.paths.outputRoot,
    })).rejects.toThrow(/lacks attempt-bundle/i);
  });

  // Historical provider/spend execute simulations are retained as source
  // documentation but are not part of the active test transport. Their
  // quadratic full-registry journal rewrites can outlive Vitest cancellation
  // and cascade across workers; EXP-0001A v2 instead exercises the complete
  // denominator through the Codex-native coordinator/runtime suites.
  it.skip("executes the fixed manifest order, seals the full denominator, then and only then starts review", async () => {
    const item = await fixture();
    await writeFile(item.paths.registryFile, item.initialRegistryFileBytes);
    const calls: string[] = [];
    const retainedFailureId = item.plan.configs[5].attempt.attemptId;
    const executor: BatchAttemptExecutor = async (config, controls) => {
      calls.push(`author:${config.attempt.attemptId}`);
      await controls.onBriefDelivered("2026-08-30T20:00:01.000Z");
      return writeRetainedCommandAttempt(
        item.paths.outputRoot,
        config,
        "2026-08-30T20:00:01.000Z",
        config.attempt.attemptId === retainedFailureId ? "failed" : "completed",
      );
    };
    const reviewRunner = vi.fn(async (
      input: Parameters<ReviewPhaseRunner>[0],
      controls: Parameters<ReviewPhaseRunner>[1],
    ) => {
      calls.push("review");
      expect(calls.filter((entry) => entry.startsWith("author:"))).toHaveLength(48);
      expect(input.sealedAttemptRegistry.attempts).toHaveLength(48);
      expect(input.sealedAttemptRegistry.attempts.every((attempt) => attempt.state === "sealed")).toBe(true);
      expect(input.sealedAttemptRegistry.attempts.find((attempt) => attempt.attemptId === retainedFailureId)?.authorOutcome).toBe("failed");
      expect(input.sealedAttemptRegistry.runSpec.conditions.baseline.deploymentUrl).toBe(item.prebrief.baseline.productionUrl);
      expect(input.sealedAttemptRegistry.runSpec.conditions.baseline.deploymentUrl).not.toBe(item.prebrief.baseline.immutableUrl);
      return finishReview(input, controls);
    });
    const trusted = authority(item.ready);
    const result = await runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor,
      reviewRunner,
      executionAuthority: trusted,
    });
    expect(result.status).toBe("awaiting_analysis");
    expect(result.invokedAttemptIds).toEqual(item.plan.configs.map((config) => config.attempt.attemptId));
    expect(calls.at(-1)).toBe("review");
    expect(trusted.verify).toHaveBeenCalledTimes(1);
    expect(reviewRunner).toHaveBeenCalledTimes(1);
    expect(result.spend).toMatchObject({
      authorizedMaximumUsd: 400,
      frozenProtocolMaximumUsd: 487.2,
      userAuthorizedMaximumUsd: 400,
    });
    expect(result.spend!.totalChargedExposureUsd).toBeLessThanOrEqual(487.2);
    for (const filePath of [
      item.paths.registryFile,
      item.paths.sealedAttemptRegistryFile,
      item.paths.registryBridgeReceiptFile,
      item.paths.reviewPlanFile,
      item.paths.reviewReceiptFile,
    ]) {
      const retainedBytes = await readFile(filePath, "utf8");
      expect(retainedBytes).toBe(canonicalJson(JSON.parse(retainedBytes)));
    }
    const sealed = JSON.parse(await readFile(item.paths.sealedAttemptRegistryFile, "utf8"));
    const bridge = JSON.parse(await readFile(item.paths.registryBridgeReceiptFile, "utf8"));
    expect(verifyExp0001aRegistryBridge({
      plan: item.plan,
      batchRegistry: result.registry,
      prebriefFreeze: item.prebrief,
      freezeAdapterReceipt: item.adapter,
      registry: sealed,
      receipt: bridge,
    }).receipt.receiptDigest).toBe(result.registryBridgeReceipt?.receiptDigest);
    const forgedRegistry = structuredClone(sealed);
    forgedRegistry.runSpec.conditions.baseline.deploymentUrl = item.prebrief.baseline.immutableUrl;
    expect(() => verifyExp0001aRegistryBridge({
      plan: item.plan,
      batchRegistry: result.registry,
      prebriefFreeze: item.prebrief,
      freezeAdapterReceipt: item.adapter,
      registry: forgedRegistry,
      receipt: bridge,
    })).toThrow(/registry|drift|invalid/i);
  }, 90_000);

  it.skip("resumes safely when review crashes before the phase-begun callback without repeating author work", async () => {
    const item = await fixture();
    await writeFile(item.paths.registryFile, item.initialRegistryFileBytes);
    const authorIds: string[] = [];
    const executor: BatchAttemptExecutor = async (config, controls) => {
      authorIds.push(config.attempt.attemptId);
      await controls.onBriefDelivered(NOW);
      return writeRetainedCommandAttempt(item.paths.outputRoot, config, NOW);
    };
    await expect(runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor,
      reviewRunner: async () => { throw new Error("crash-before-review-callback"); },
      executionAuthority: authority(item.ready),
    })).rejects.toThrow("crash-before-review-callback");
    expect(authorIds).toHaveLength(48);
    await expect(readdir(item.paths.reviewProgressRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const retainedBridge = await readFile(item.paths.registryBridgeReceiptFile, "utf8");

    const resumedExecutor = vi.fn();
    await expect(runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor: resumedExecutor,
      reviewRunner: async (input) => {
        expect(input.resume).toMatchObject({ phaseBegun: false, resolvedWorkItems: [] });
        expect(input.retainedAmbiguousFailures).toEqual([]);
        throw new Error("verified-safe-pre-callback-resume");
      },
      executionAuthority: authority(item.ready),
    })).rejects.toThrow("verified-safe-pre-callback-resume");
    expect(resumedExecutor).not.toHaveBeenCalled();
    expect(await readFile(item.paths.registryBridgeReceiptFile, "utf8")).toBe(retainedBridge);
  }, 90_000);

  it.skip("resumes after the durable phase callback but before any reviewer lock", async () => {
    const item = await fixture();
    await writeFile(item.paths.registryFile, item.initialRegistryFileBytes);
    const executor: BatchAttemptExecutor = async (config, controls) => {
      await controls.onBriefDelivered(NOW);
      return writeRetainedCommandAttempt(item.paths.outputRoot, config, NOW);
    };
    await expect(runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor,
      reviewRunner: async (input, controls) => {
        await controls.onReviewPhaseBegun({ at: NOW, reviewPlan: reviewPlan(input) });
        throw new Error("crash-after-review-callback");
      },
      executionAuthority: authority(item.ready),
    })).rejects.toThrow("crash-after-review-callback");
    const before = await Promise.all((await readdir(item.paths.reviewProgressRoot)).map(async (name) => [name, await readFile(path.join(item.paths.reviewProgressRoot, name), "utf8")] as const));

    await expect(runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor: vi.fn(),
      reviewRunner: async (input) => {
        expect(input.resume.phaseBegun).toBe(true);
        expect(input.resume.pendingWorkItemIds.primary).toHaveLength(96);
        expect(input.resume.resolvedWorkItems).toHaveLength(0);
        expect(input.retainedAmbiguousFailures).toEqual([]);
        throw new Error("verified-post-callback-resume");
      },
      executionAuthority: authority(item.ready),
    })).rejects.toThrow("verified-post-callback-resume");
    for (const [name, bytes] of before) expect(await readFile(path.join(item.paths.reviewProgressRoot, name), "utf8")).toBe(bytes);
  }, 90_000);

  it.skip("resumes only pending reviewer work after partial locks and preserves every prior event byte", async () => {
    const item = await fixture();
    await writeFile(item.paths.registryFile, item.initialRegistryFileBytes);
    const executor: BatchAttemptExecutor = async (config, controls) => {
      await controls.onBriefDelivered(NOW);
      return writeRetainedCommandAttempt(item.paths.outputRoot, config, NOW);
    };
    const lockedIds: string[] = [];
    await expect(runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor,
      reviewRunner: async (input, controls) => {
        let state = await controls.onReviewPhaseBegun({ at: NOW, reviewPlan: reviewPlan(input) });
        for (const workItemId of state.pendingWorkItemIds.primary.slice(0, 3)) {
          await controls.onReviewWorkItemBegun({
            at: NOW,
            stage: "primary",
            workItemId,
            maximumCostUsd: 0.01,
            budgetDigest: digest("budget:primary"),
            pricingDigest: digest("pricing:primary"),
          });
          state = await controls.onReviewWorkItemLocked({
            at: NOW,
            stage: "primary",
            workItemId,
            recordRoot: digest(`locked:${workItemId}`),
            status: "scored",
            spend: { observability: "unobservable" },
          });
          lockedIds.push(workItemId);
        }
        throw new Error("partial-review-crash");
      },
      executionAuthority: authority(item.ready),
    })).rejects.toThrow("partial-review-crash");
    const before = await Promise.all((await readdir(item.paths.reviewProgressRoot)).map(async (name) => [name, await readFile(path.join(item.paths.reviewProgressRoot, name), "utf8")] as const));

    await expect(runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor: vi.fn(),
      reviewRunner: async (input) => {
        expect(input.resume.resolvedWorkItems.map((item) => item.workItemId)).toEqual(lockedIds);
        expect(input.resume.pendingWorkItemIds.primary).toHaveLength(93);
        expect(input.resume.pendingWorkItemIds.primary.some((id) => lockedIds.includes(id))).toBe(false);
        throw new Error("verified-partial-lock-resume");
      },
      executionAuthority: authority(item.ready),
    })).rejects.toThrow("verified-partial-lock-resume");
    for (const [name, bytes] of before) expect(await readFile(path.join(item.paths.reviewProgressRoot, name), "utf8")).toBe(bytes);
  }, 90_000);

  it.skip("fails an unresolved begun reviewer item closed, retains its ambiguity, and never schedules it again", async () => {
    const item = await fixture();
    await writeFile(item.paths.registryFile, item.initialRegistryFileBytes);
    const executor: BatchAttemptExecutor = async (config, controls) => {
      await controls.onBriefDelivered(NOW);
      return writeRetainedCommandAttempt(item.paths.outputRoot, config, NOW);
    };
    let ambiguousId = "";
    await expect(runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor,
      reviewRunner: async (input, controls) => {
        const state = await controls.onReviewPhaseBegun({ at: NOW, reviewPlan: reviewPlan(input) });
        ambiguousId = state.pendingWorkItemIds.primary[0];
        await controls.onReviewWorkItemBegun({
          at: NOW,
          stage: "primary",
          workItemId: ambiguousId,
          maximumCostUsd: 0.01,
          budgetDigest: digest("budget:primary"),
          pricingDigest: digest("pricing:primary"),
        });
        throw new Error("crash-with-reviewer-in-flight");
      },
      executionAuthority: authority(item.ready),
    })).rejects.toThrow("crash-with-reviewer-in-flight");

    await expect(runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor: vi.fn(),
      reviewRunner: async (input) => {
        expect(input.resume.pendingWorkItemIds.primary).toHaveLength(95);
        expect(input.resume.pendingWorkItemIds.primary).not.toContain(ambiguousId);
        expect(input.resume.resolvedWorkItems).toContainEqual(expect.objectContaining({
          stage: "primary",
          workItemId: ambiguousId,
          status: "failed",
          ambiguousAfterBegin: true,
        }));
        expect(input.retainedAmbiguousFailures).toHaveLength(1);
        expect(input.retainedAmbiguousFailures[0]).toMatchObject({
          workItemId: ambiguousId,
          status: "failed",
          decision: null,
          preference: null,
          failure: { code: "AMBIGUOUS_AFTER_BEGIN" },
          usage: {
            source: "unobservable_after_provider_release",
            totalTokens: null,
            estimatedCostUsd: null,
            conservativeReservedCostUsd: 0.01,
          },
        });
        throw new Error("verified-fail-closed-review-resume");
      },
      executionAuthority: authority(item.ready),
    })).rejects.toThrow("verified-fail-closed-review-resume");
    const events = await Promise.all((await readdir(item.paths.reviewProgressRoot)).map(async (name) => JSON.parse(await readFile(path.join(item.paths.reviewProgressRoot, name), "utf8"))));
    expect(events.filter((event) => event.kind === "work_item_begun" && event.workItemId === ambiguousId)).toHaveLength(1);
    expect(events.filter((event) => event.kind === "work_item_ambiguous_failed" && event.workItemId === ambiguousId)).toHaveLength(1);
  }, 90_000);

  it.skip("reconciles an immutable inner evaluator lock before failing an outer begun item ambiguous", async () => {
    const item = await fixture();
    await writeFile(item.paths.registryFile, item.initialRegistryFileBytes);
    const executor: BatchAttemptExecutor = async (config, controls) => {
      await controls.onBriefDelivered(NOW);
      return writeRetainedCommandAttempt(item.paths.outputRoot, config, NOW);
    };
    let activeId = "";
    await expect(runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor,
      reviewRunner: async (input, controls) => {
        const state = await controls.onReviewPhaseBegun({ at: NOW, reviewPlan: reviewPlan(input) });
        activeId = state.pendingWorkItemIds.primary[0];
        await controls.onReviewWorkItemBegun({
          at: NOW,
          stage: "primary",
          workItemId: activeId,
          maximumCostUsd: 0.01,
          budgetDigest: digest("budget:primary"),
          pricingDigest: digest("pricing:primary"),
        });
        // Models an inner O_EXCL record lock followed by a crash before the
        // outer progress callback can append its lock event.
        throw new Error("crash-after-inner-lock");
      },
      executionAuthority: authority(item.ready),
    })).rejects.toThrow("crash-after-inner-lock");

    // Also model the narrower crash window where spend settlement reached its
    // append-only ledger before the outer progress event did.
    const spend = createExp0001aSpendLedger({
      directory: item.paths.spendProgressRoot,
      authorizedMaximumUsd: item.ready.spendAuthorization.maximumUsd,
      authorizationReceiptDigest: item.ready.spendAuthorization.receiptDigest,
    });
    await spend.settle({
      at: NOW,
      callId: `primary:${activeId}`,
      phase: "primary",
      observability: "observed",
      actualCostUsd: 0.003,
      usageDigest: digest(`usage:${activeId}`),
      providerReceiptDigest: digest(`inner-lock:${activeId}`),
    });

    const resumed = (async (input: Parameters<ReviewPhaseRunner>[0], controls: ReviewPhaseControls) => {
      expect(input.resume.resolvedWorkItems).toContainEqual(expect.objectContaining({
        stage: "primary",
        workItemId: activeId,
        recordRoot: digest(`inner-lock:${activeId}`),
        status: "scored",
        ambiguousAfterBegin: false,
      }));
      expect(input.retainedAmbiguousFailures).toEqual([]);
      const spendSummary = await controls.readSpendSummary();
      expect(spendSummary.observedSettledUsd).toBeGreaterThanOrEqual(0.003);
      expect(spendSummary.pendingCallIds).not.toContain(`primary:${activeId}`);
      throw new Error("verified-inner-lock-recovery");
    }) as ReviewPhaseRunner;
    resumed.recoverActiveWorkItem = vi.fn(async ({ active }) => {
      expect(active.workItemId).toBe(activeId);
      return {
        lockedAt: NOW,
        recordRoot: digest(`inner-lock:${activeId}`),
        status: "scored" as const,
        spend: {
          observability: "observed" as const,
          actualCostUsd: 0.003,
          usageDigest: digest(`usage:${activeId}`),
          providerReceiptDigest: digest(`inner-lock:${activeId}`),
        },
      };
    });
    await expect(runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor: vi.fn(),
      reviewRunner: resumed,
      executionAuthority: authority(item.ready),
    })).rejects.toThrow("verified-inner-lock-recovery");
    expect(resumed.recoverActiveWorkItem).toHaveBeenCalledTimes(1);
    const events = await Promise.all((await readdir(item.paths.reviewProgressRoot)).map(async (name) => (
      JSON.parse(await readFile(path.join(item.paths.reviewProgressRoot, name), "utf8"))
    )));
    expect(events.filter((event) => event.kind === "work_item_locked" && event.workItemId === activeId)).toHaveLength(1);
    expect(events.filter((event) => event.kind === "work_item_ambiguous_failed" && event.workItemId === activeId)).toHaveLength(0);
  }, 90_000);

  it("refuses self-hashed authority, source drift, and an absent attested registry before any brief", async () => {
    const item = await fixture({ persistInitialRegistry: false });
    const executor = vi.fn();
    const reviewRunner = vi.fn();
    await expect(runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor,
      reviewRunner,
    })).rejects.toThrow(/separately trusted/i);
    expect(executor).not.toHaveBeenCalled();

    const drifted = item.base.committedRuntimeFiles.map((file, index) => index === 0 ? { ...file, bytes: "drifted" } : file);
    const dry = await runExp0001aBatchCommand({ ...item.base, paths: item.paths, committedRuntimeFiles: drifted });
    expect(dry.preflight.errors).toContain(`RUNTIME_SOURCE_DIGEST_MISMATCH:${drifted[0].path}`);

    await expect(runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor,
      reviewRunner,
      executionAuthority: authority(item.ready),
    })).rejects.toThrow(/attested registry file is absent/i);
    expect(executor).not.toHaveBeenCalled();
  });

  it.skip("preserves a pre-brief runner bundle append-only and reuses the fixed attempt ID", async () => {
    const item = await fixture();
    await writeFile(item.paths.registryFile, item.initialRegistryFileBytes);
    const firstAttemptId = item.plan.configs[0].attempt.attemptId;
    const executor: BatchAttemptExecutor = vi.fn(async (config) => {
      const attemptDirectory = path.join(item.paths.outputRoot, config.attempt.attemptId);
      await mkdir(attemptDirectory);
      await writeFile(path.join(attemptDirectory, "prebrief-bundle.json"), "retained-before-brief");
      return {
        kind: "not_started",
        at: "2026-08-30T20:00:01.000Z",
        incidentCode: "browser_launch_failed",
        message: "No author brief reached the model.",
        hardIncident: false,
        falsification: false,
      };
    });
    const reviewRunner = vi.fn();
    const aliasVerifier = vi.fn(item.base.aliasVerifier);
    const result = await runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor,
      aliasVerifier,
      reviewRunner,
      executionAuthority: authority(item.ready),
    });
    expect(result.status).toBe("awaiting_resume");
    expect(result.invokedAttemptIds).toEqual([firstAttemptId]);
    expect(result.archivedPrebriefIncident).toContain(firstAttemptId);
    expect(aliasVerifier).not.toHaveBeenCalled();
    expect(result.spend).toMatchObject({ reservationCount: 0, settlementCount: 0 });
    expect(await readFile(path.join(result.archivedPrebriefIncident!, "prebrief-bundle.json"), "utf8")).toBe("retained-before-brief");
    await expect(readFile(path.join(item.paths.outputRoot, firstAttemptId, "prebrief-bundle.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(reviewRunner).not.toHaveBeenCalled();

    const durable = JSON.parse(await readFile(item.paths.registryFile, "utf8"));
    expect(durable.events.filter((event: { kind: string; attemptId: string }) => event.kind === "not_started" && event.attemptId === firstAttemptId)).toHaveLength(1);

    const retriedIds: string[] = [];
    const secondExecutor: BatchAttemptExecutor = async (config) => {
      retriedIds.push(config.attempt.attemptId);
      const attemptDirectory = path.join(item.paths.outputRoot, config.attempt.attemptId);
      await mkdir(attemptDirectory);
      await writeFile(path.join(attemptDirectory, "prebrief-bundle.json"), "second-retained-before-brief");
      return {
        kind: "not_started",
        at: "2026-08-30T20:00:02.000Z",
        incidentCode: "browser_launch_failed_again",
        message: "Still no author brief reached the model.",
        hardIncident: false,
        falsification: false,
      };
    };
    const retried = await runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor: secondExecutor,
      aliasVerifier,
      reviewRunner,
      executionAuthority: authority(item.ready),
    });
    expect(retriedIds).toEqual([firstAttemptId]);
    expect(aliasVerifier).not.toHaveBeenCalled();
    expect(retried.archivedPrebriefIncident).not.toBe(result.archivedPrebriefIncident);
    expect(await readFile(path.join(result.archivedPrebriefIncident!, "prebrief-bundle.json"), "utf8")).toBe("retained-before-brief");
    expect(await readFile(path.join(retried.archivedPrebriefIncident!, "prebrief-bundle.json"), "utf8")).toBe("second-retained-before-brief");
  });

  it.skip("turns brief-callback persistence failure into a durable hard stop and never archives its evidence", async () => {
    const item = await fixture();
    await writeFile(item.paths.registryFile, item.initialRegistryFileBytes);
    const realStore = createAtomicRegistryStore({
      filePath: item.paths.registryFile,
      validate: (value) => value as typeof item.initialRegistry,
      identity: (value) => value.registryDigest,
    });
    let persistCalls = 0;
    const store = {
      ...realStore,
      persist: async (next: unknown, expected: string) => {
        persistCalls += 1;
        // The first persistence is the mandatory pre-brief alias receipt. The
        // second is the brief callback itself.
        if (persistCalls === 2) {
          throw new Error("simulated fsync failure");
        }
        return realStore.persist(next, expected);
      },
    };
    const executor: BatchAttemptExecutor = async (config, controls) => {
      const attemptDirectory = path.join(item.paths.outputRoot, config.attempt.attemptId);
      await mkdir(attemptDirectory);
      await writeFile(path.join(attemptDirectory, "prebrief-bundle.json"), "must-not-be-normalized");
      await controls.onBriefDelivered("2026-08-30T20:00:01.000Z");
      throw new Error("unreachable after persistence failure");
    };
    const reviewRunner = vi.fn();
    const result = await runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor,
      reviewRunner,
      executionAuthority: authority(item.ready),
      registryStore: store,
    });
    expect(result.status).toBe("hard_stopped");
    expect(result.registry.events.at(-1)?.kind).toBe("hard_stop");
    expect(result.spend).toMatchObject({
      observedSettledUsd: 0,
      unobservableReservedExposureUsd: 0,
      reservationCount: 1,
      settlementCount: 1,
    });
    expect(await readFile(path.join(item.paths.outputRoot, item.plan.configs[0].attempt.attemptId, "prebrief-bundle.json"), "utf8")).toBe("must-not-be-normalized");
    expect(reviewRunner).not.toHaveBeenCalled();
  });

  it("refuses an exclusive-lock collision, exact-authorization drift, and pre-existing review evidence before author execution", async () => {
    const item = await fixture();
    await writeFile(item.paths.registryFile, item.initialRegistryFileBytes);
    const executor = vi.fn();
    const reviewRunner = vi.fn();
    await writeFile(item.paths.executionLockFile, "existing lock");
    await expect(runExp0001aBatchCommand({
      ...item.base,
      mode: "execute",
      paths: item.paths,
      executor,
      reviewRunner,
      executionAuthority: authority(item.ready),
    })).rejects.toThrow(/execution lock already exists/i);
    expect(executor).not.toHaveBeenCalled();

    const authItem = await fixture();
    await writeFile(authItem.paths.registryFile, authItem.initialRegistryFileBytes);
    await expect(runExp0001aBatchCommand({
      ...authItem.base,
      mode: "execute",
      exactAuthorization: { ...authItem.base.exactAuthorization!, authorizationId: "wrong-authorization" },
      paths: authItem.paths,
      executor,
      reviewRunner,
      executionAuthority: authority(authItem.ready),
    })).rejects.toThrow(/EXACT_AUTHORIZATION_ID_MISMATCH/);
    expect(executor).not.toHaveBeenCalled();

    const reviewItem = await fixture();
    await writeFile(reviewItem.paths.registryFile, reviewItem.initialRegistryFileBytes);
    await writeFile(reviewItem.paths.reviewPhaseBegunFile, "prior ambiguous review");
    await expect(runExp0001aBatchCommand({
      ...reviewItem.base,
      mode: "execute",
      paths: reviewItem.paths,
      executor,
      reviewRunner,
      executionAuthority: authority(reviewItem.ready),
    })).rejects.toThrow(/review evidence exists before the author denominator completed/i);
    expect(executor).not.toHaveBeenCalled();
  });
});
