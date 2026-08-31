import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

// @ts-expect-error committed executable ESM intentionally has no ambient typings
import { FIXED_EXECUTION_CRITICAL_SOURCE_PATHS as LAUNCHER_SOURCE_PATHS } from "../../../research/scripts/exp0001a-launch-authority.mjs";
// @ts-expect-error committed executable ESM intentionally has no ambient typings
import { FIXED_FROZEN_SOURCE_PATHS as LAUNCHER_FROZEN_SOURCE_PATHS } from "../../../research/scripts/exp0001a-launch-authority.mjs";
import actualFreezeJson from "../../../research/data/exp-0001a-prebrief-freeze-v1.json";
import {
  computeAliasPreflightDigest,
  computeCommittedCodeReceiptDigest,
  computeExecutionReadyReceiptDigest,
  computeFreshLiveContractEnvelopeDigest,
  computeNoBriefEvidenceDigest,
  computeSpendAuthorizationDigest,
  computeExecutionHostAttestationDigest,
  createGitCliObjectReader,
  EXP0001A_EXECUTION_CRITICAL_SOURCE_PATHS,
  evaluateExp0001aExecutionGate,
  exp0001aAliasPreflightSchema,
  exp0001aCommittedCodeReceiptSchema,
  exp0001aFreshLiveContractEnvelopeSchema,
  exp0001aExecutionHostAttestationSchema,
  exp0001aNoBriefEvidenceSchema,
  exp0001aSpendAuthorizationSchema,
  verifyBlockedPrebriefFreezeForExecutionGate,
  verifyExp0001aExecutionReadyReceipt,
  type Exp0001aAliasPreflight,
  type Exp0001aCommittedCodeReceipt,
  type Exp0001aFreshLiveContractEnvelope,
  type Exp0001aExecutionHostAttestation,
  type Exp0001aNoBriefEvidence,
  type Exp0001aSpendAuthorization,
  type BlockedPrebriefFreeze,
  type GitFileBinding,
  type SourceBinding,
} from "./exp0001a-execution-gate";
import { hashCanonicalJson, sha256Digest } from "./provenance-crypto";

const execFileAsync = promisify(execFile);
const zeroDigest = `sha256:${"0".repeat(64)}`;

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

function withDigest<T extends Record<string, unknown>, K extends string>(value: T, key: K): T & Record<K, string> {
  const candidate = { ...value, [key]: zeroDigest } as T & Record<K, string>;
  return { ...candidate, [key]: hashCanonicalJson(Object.fromEntries(Object.entries(candidate).filter(([entryKey]) => entryKey !== key))) };
}

async function binding(cwd: string, commit: string, path: string): Promise<GitFileBinding> {
  const line = await git(cwd, "ls-tree", commit, "--", path);
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
  if (!match) throw new Error(`Missing fixture binding for ${path}.`);
  const bytes = await readFile(join(cwd, path));
  return { path, mode: match[1] as "100644" | "100755", blobOid: match[2], fileDigest: sha256Digest(bytes) };
}

async function fixture(options: { evaluatorBenchmarkDigestOverride?: string } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "jazzboard-exp0001a-gate-"));
  await git(cwd, "init", "-q");
  await git(cwd, "config", "user.name", "Jazzboard Research");
  await git(cwd, "config", "user.email", "research@example.invalid");

  const sourcePathsByRole = LAUNCHER_FROZEN_SOURCE_PATHS as Record<string, string>;
  const sourcePaths = Object.values(sourcePathsByRole);
  for (const [index, path] of sourcePaths.entries()) {
    await execFileAsync("mkdir", ["-p", join(cwd, path.slice(0, path.lastIndexOf("/")))]);
    await writeFile(join(cwd, path), `export const fixture${index} = ${index};\n`);
  }
  const runtimeDependencyComponents = [
    "chromiumRuntime", "detectLibcPackage", "nodeExecutable", "playwrightCorePackage",
    "playwrightPackage", "sharpColourPackage", "sharpLibvipsPackage",
    "sharpNativePackage", "sharpPackage",
  ].map((id) => ({ id, treeRoot: sha256Digest(`tree:${id}`), criticalRoot: sha256Digest(`critical:${id}`) }));
  const runtimeDependencyContent = {
    schemaVersion: "exp-0001a-runtime-dependencies/v1",
    protocolId: "EXP-0001A",
    capturedAt: "2026-08-30T21:31:00.000Z",
    captureVerificationDurationMs: 11,
    host: { nodeVersion: "22.22.0", platform: "darwin", architecture: "arm64", operatingSystemBuild: "25G83" },
    policy: {
      absolutePathsPublished: false,
      fullTreeVerification: "two-identical-captures-before-runtime-import",
      criticalVerification: "two-identical-captures-before-each-attempt-before-browser-or-brief",
    },
    components: runtimeDependencyComponents,
    componentSetRoot: hashCanonicalJson(runtimeDependencyComponents),
  };
  const runtimeDependencyReceipt = withDigest(runtimeDependencyContent, "receiptDigest");
  await writeFile(
    join(cwd, sourcePathsByRole.runtimeDependencyReceipt),
    `${JSON.stringify(runtimeDependencyReceipt)}\n`,
  );
  const evaluatorEnvelopeReceipt = withDigest({
    schemaVersion: "exp-0001a-evaluator-semantic-envelope/v1",
    pilotTaskBasis: {
      benchmarkSource: {
        path: sourcePathsByRole.benchmark,
        fileDigest: options.evaluatorBenchmarkDigestOverride
          ?? sha256Digest(await readFile(join(cwd, sourcePathsByRole.benchmark))),
      },
      rubricSource: {
        path: sourcePathsByRole.rubrics,
        fileDigest: sha256Digest(await readFile(join(cwd, sourcePathsByRole.rubrics))),
      },
    },
  }, "envelopeDigest");
  await writeFile(
    join(cwd, sourcePathsByRole.evaluatorSemanticEnvelopeReceipt),
    `${JSON.stringify(evaluatorEnvelopeReceipt)}\n`,
  );

  const sourceDigests = Object.fromEntries(await Promise.all(Object.entries(sourcePathsByRole).map(async ([role, path]) => [
    role,
    { path, fileDigest: sha256Digest(await readFile(join(cwd, path))) },
  ])));
  const frozenSources = {
    ...sourceDigests,
    authorSessionIdentityManifest: {
      ...sourceDigests.authorSessionIdentityManifest,
      manifestRoot: sha256Digest("coordinator-issued-author-identity-manifest"),
    },
  };
  const authorDigest = sourceDigests.authorRunner.fileDigest;
  const treatment = {
    authorRunnerDigest: authorDigest,
    participantContractDigest: sha256Digest("participant-contract"),
    spectatorContractDigest: sha256Digest("spectator-contract"),
    model: { id: "gpt-5.6-sol", reasoningEffort: "max", serviceTier: "default" },
  };
  const freezeContent = {
    schemaVersion: 1,
    freezeId: "exp-0001a-prebrief-freeze-v1",
    protocolId: "EXP-0001A",
    status: "blocked_pending_prerequisites",
    frozenAt: "2026-08-30T21:32:00.000Z",
    executionStateAtFreeze: "not_started",
    briefReleaseAuthorized: false,
    baseline: {
      gitCommit: "1".repeat(40),
      gitTree: "2".repeat(40),
      deploymentId: "dpl_baseline",
      buildId: "bld_baseline",
      immutableUrl: "https://immutable.example.com",
      productionUrl: "https://www.example.com",
    },
    executionHost: {
      status: "recorded-covariate-requires-fresh-attestation",
      nodeVersion: "22.22.0",
      platform: "darwin",
      architecture: "arm64",
      operatingSystem: { name: "macOS", version: "26.6.2", build: "25G83" },
      browser: {
        product: "Google Chrome for Testing",
        version: "151.0.7922.34",
        playwrightVersion: "1.62.1",
      },
      dependencyResolution: {
        layout: "npm-package-lock",
        lockfileVersion: 3,
        packageManifestDigest: sourceDigests.packageManifest.fileDigest,
        packageLockDigest: sourceDigests.packageLock.fileDigest,
      },
      runtimeDependencies: {
        receiptPath: sourcePathsByRole.runtimeDependencyReceipt,
        receiptDigest: runtimeDependencyReceipt.receiptDigest,
        componentSetRoot: runtimeDependencyReceipt.componentSetRoot,
        captureVerificationDurationMs: runtimeDependencyReceipt.captureVerificationDurationMs,
        absolutePathsPublished: false,
        fullTreeVerification: "two-identical-captures-before-runtime-import",
        criticalVerification: "two-identical-captures-before-each-attempt-before-browser-or-brief",
      },
    },
    frozenSources,
    conditions: { A0: treatment, A1: structuredClone(treatment), configurationDigest: hashCanonicalJson(treatment) },
    budgetRationale: { briefsDeliveredBeforeFreeze: 0 },
    providerModelIdentityPolicy: {
      requestedModelIdFrozen: true,
      immutableWeightSnapshotAsserted: false,
      responseModelRetainedAndDriftChecked: true,
      serviceTierRetainedAndDriftChecked: true,
      rollingProviderRiskMitigation: "aa-interleaving-paired-order-balance-and-time-block-diagnostics",
      confirmatoryPreference: "use-an-immutable-dated-weight-snapshot-when-the-provider-exposes-one",
    },
    deploymentContinuityPolicy: {
      executionOrigin: "https://www.example.com",
      frozenDeploymentId: "dpl_baseline",
      verifierSourceRole: "perAttemptAliasVerifier",
      verificationTiming: "authenticated-vercel-api-immediately-before-each-brief",
      requiredReceiptCountAtCompletion: 48,
      receiptsHashChainedInBatchRegistry: true,
      driftDisposition: "not_started-hard-stop-before-brief",
      immutableDeploymentAlternative: "protected-immutable-url-requires-authenticated-bypass",
    },
    pricingProvenance: {
      serviceTier: "default",
      modelDocumentationUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
      fastModeGuideUrl: "https://developers.openai.com/api/docs/guides/fast-mode",
      capturedOn: "2026-08-30",
      promotionalPricingValidAtLeastThrough: "2026-11-21",
      revalidationRequiredBefore: "2026-11-22T00:00:00.000Z",
    },
    reviewerPlan: { serviceTier: "default", pairwisePreference: { serviceTier: "default" } },
    costProjection: {
      expectedPairwisePreferences24Usd: 1.675392,
      expectedTotalUsd: 36.1659664,
      sensitivityOnePointFiveXTotalUsd: 54.2489496,
      configuredCapPairwisePreferences24Usd: 11.04,
      configuredCapTotalUsd: 487.2,
      preProviderCumulativeInputHardCapEnforced: true,
    },
    pendingPrerequisites: {
      batchCoordinator: { path: sourceDigests.batchCoordinator.path, candidateObservedDigest: sourceDigests.batchCoordinator.fileDigest },
      batchCli: { path: sourceDigests.batchCli.path, candidateObservedDigest: sourceDigests.batchCli.fileDigest },
      batchCommandLibrary: { path: sourceDigests.batchCommandLibrary.path, candidateObservedDigest: sourceDigests.batchCommandLibrary.fileDigest },
      batchRegistryBridge: { path: sourceDigests.batchRegistryBridge.path, candidateObservedDigest: sourceDigests.batchRegistryBridge.fileDigest },
      cleanRoomBatchAdapter: { path: sourceDigests.cleanRoomBatchAdapter.path, candidateObservedDigest: sourceDigests.cleanRoomBatchAdapter.fileDigest },
      atomicRegistryStore: { path: sourceDigests.atomicRegistryStore.path, candidateObservedDigest: sourceDigests.atomicRegistryStore.fileDigest },
      evaluatorRunner: { path: sourceDigests.evaluatorRunner.path, candidateObservedDigest: sourceDigests.evaluatorRunner.fileDigest },
      evaluatorSemanticEnvelopeReceipt: { path: sourceDigests.evaluatorSemanticEnvelopeReceipt.path, candidateObservedDigest: sourceDigests.evaluatorSemanticEnvelopeReceipt.fileDigest },
      executionAuthorityTrustAnchor: { path: sourceDigests.executionAuthorityTrustAnchor.path, candidateObservedDigest: sourceDigests.executionAuthorityTrustAnchor.fileDigest },
      liveReviewRunner: { path: sourceDigests.liveReviewRunner.path, candidateObservedDigest: sourceDigests.liveReviewRunner.fileDigest },
      adjudicationOrchestration: { path: sourceDigests.adjudicationOrchestration.path, candidateObservedDigest: sourceDigests.adjudicationOrchestration.fileDigest },
      attemptMetrics: { path: sourceDigests.attemptMetrics.path, candidateObservedDigest: sourceDigests.attemptMetrics.fileDigest },
      perAttemptAliasVerifier: { path: sourceDigests.perAttemptAliasVerifier.path, candidateObservedDigest: sourceDigests.perAttemptAliasVerifier.fileDigest },
      pairwisePreference: { path: sourceDigests.pairwisePreference.path, candidateObservedDigest: sourceDigests.pairwisePreference.fileDigest },
      pairwisePreferenceInstructions: { path: sourceDigests.pairwisePreferenceInstructions.path, candidateObservedDigest: sourceDigests.pairwisePreferenceInstructions.fileDigest },
      spendLedger: { path: sourceDigests.spendLedger.path, candidateObservedDigest: sourceDigests.spendLedger.fileDigest },
      runtimeComposition: { path: sourceDigests.runtimeComposition.path, candidateObservedDigest: sourceDigests.runtimeComposition.fileDigest },
      runtimeBundle: { path: sourceDigests.runtimeBundle.path, candidateObservedDigest: sourceDigests.runtimeBundle.fileDigest },
      runtimeDependencyReceipt: { path: sourceDigests.runtimeDependencyReceipt.path, candidateObservedDigest: sourceDigests.runtimeDependencyReceipt.fileDigest },
      runtimeDependencyVerifier: { path: sourceDigests.runtimeDependencyVerifier.path, candidateObservedDigest: sourceDigests.runtimeDependencyVerifier.fileDigest },
      launchAuthorityVerifier: { path: sourceDigests.launchAuthorityVerifier.path, candidateObservedDigest: sourceDigests.launchAuthorityVerifier.fileDigest },
      reportCompiler: { path: sourceDigests.reportCompiler.path, candidateObservedDigest: sourceDigests.reportCompiler.fileDigest },
      experimentFreezeAdapter: { path: sourceDigests.experimentFreezeAdapter.path, candidateObservedDigest: sourceDigests.experimentFreezeAdapter.fileDigest },
      executionGate: { path: sourceDigests.executionGate.path, candidateObservedDigest: sourceDigests.executionGate.fileDigest },
      authorSessionIdentityManifest: { path: sourceDigests.authorSessionIdentityManifest.path, candidateObservedDigest: sourceDigests.authorSessionIdentityManifest.fileDigest },
    },
    executionGate: { executable: false },
    sensitiveMaterialRedacted: true,
  };
  const freeze = { ...freezeContent, freezeDigest: hashCanonicalJson(freezeContent) };
  await execFileAsync("mkdir", ["-p", join(cwd, "research/data")]);
  const freezePath = "research/data/prebrief.json";
  const freezeBytes = `${JSON.stringify(freeze, null, 2)}\n`;
  await writeFile(join(cwd, freezePath), freezeBytes);
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "freeze code");
  const codeCommit = await git(cwd, "rev-parse", "HEAD");
  const codeTree = await git(cwd, "rev-parse", "HEAD^{tree}");

  const bindings = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, await binding(cwd, codeCommit, path)])));
  const prebriefBinding = await binding(cwd, codeCommit, freezePath);
  const codeContent = {
    schemaVersion: 1,
    kind: "exp-0001a-committed-code",
    protocolId: "EXP-0001A",
    freezeDigest: freeze.freezeDigest,
    capturedAt: "2026-08-30T21:40:00.000Z",
    gitCommit: codeCommit,
    gitTree: codeTree,
    prebriefFreeze: prebriefBinding,
    sourceBindings: Object.entries(sourcePathsByRole)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([role, path]) => ({ role, ...bindings[path] })) as SourceBinding[],
  };
  const committedCode = exp0001aCommittedCodeReceiptSchema.parse(withDigest(codeContent, "receiptDigest"));

  const liveReceipt = {
    schemaVersion: 1,
    kind: "public-production-webmcp-contract-verification",
    capturedAt: "2026-08-30T21:50:00.000Z",
    baseline: {
      gitCommit: freeze.baseline.gitCommit,
      gitTree: freeze.baseline.gitTree,
      deploymentId: freeze.baseline.deploymentId,
      buildId: freeze.baseline.buildId,
      immutableDeploymentUrl: freeze.baseline.immutableUrl,
      executionUrl: freeze.baseline.productionUrl,
      executionUrlVerifiedDeploymentId: freeze.baseline.deploymentId,
      aliasPreflight: "authenticated_vercel_cli_immediately_before_contract",
      immutableUrlAccess: "deployment_protection_requires_authenticated_bypass",
    },
    runner: {
      mode: "contract",
      status: "contract_verified",
      scriptDigest: bindings[sourcePathsByRole.authorRunner].fileDigest,
      responsesApiInvoked: false,
      authorContextClosedBeforeEvaluation: true,
    },
    participant: { toolCount: 54, contractDigest: treatment.participantContractDigest },
    spectator: { toolCount: 18, contractDigest: treatment.spectatorContractDigest },
    privacy: {
      roomIdentifiersPersisted: false,
      sessionCredentialsPersisted: false,
      apiCredentialsPersisted: false,
      responsesApiInvoked: false,
    },
  };
  const livePath = "research/data/fresh-live-contract.json";
  const liveBytes = `${JSON.stringify(liveReceipt, null, 2)}\n`;
  await writeFile(join(cwd, livePath), liveBytes);
  await git(cwd, "add", livePath);
  await git(cwd, "commit", "-qm", "commit live receipt");
  const liveCommit = await git(cwd, "rev-parse", "HEAD");
  const liveTree = await git(cwd, "rev-parse", "HEAD^{tree}");
  const liveBinding = await binding(cwd, liveCommit, livePath);
  const envelopeContent = {
    schemaVersion: 1,
    kind: "exp-0001a-fresh-live-contract",
    protocolId: "EXP-0001A",
    freezeDigest: freeze.freezeDigest,
    receipt: liveReceipt,
    receiptDigest: hashCanonicalJson(liveReceipt),
    gitCommit: liveCommit,
    gitTree: liveTree,
    receiptFile: liveBinding,
  };
  const liveEnvelope = exp0001aFreshLiveContractEnvelopeSchema.parse(withDigest(envelopeContent, "envelopeDigest"));

  const alias = exp0001aAliasPreflightSchema.parse(withDigest({
    schemaVersion: 1,
    kind: "exp-0001a-alias-preflight",
    protocolId: "EXP-0001A",
    freezeDigest: freeze.freezeDigest,
    observedAt: "2026-08-30T21:49:00.000Z",
    expiresAt: "2026-08-30T22:20:00.000Z",
    method: "authenticated-vercel-cli",
    productionUrl: freeze.baseline.productionUrl,
    resolvedDeploymentId: freeze.baseline.deploymentId,
    resolvedBuildId: freeze.baseline.buildId,
    resolvedImmutableUrl: freeze.baseline.immutableUrl,
    resolvedState: "READY",
  }, "receiptDigest"));

  const registryValue = { schemaVersion: 1, events: [], registryDigest: sha256Digest("empty-registry") };
  const registryFileBytes = `${JSON.stringify(registryValue, null, 2)}\n`;
  const noBrief = exp0001aNoBriefEvidenceSchema.parse(withDigest({
    schemaVersion: 1,
    kind: "exp-0001a-no-brief-evidence",
    protocolId: "EXP-0001A",
    freezeDigest: freeze.freezeDigest,
    observedAt: "2026-08-30T21:51:00.000Z",
    briefsDelivered: 0,
    begunAttempts: 0,
    registryDigest: registryValue.registryDigest,
    registryFileDigest: sha256Digest(registryFileBytes),
    releaseLock: { held: true, tokenDigest: sha256Digest("lock-token"), expiresAt: "2026-08-30T22:10:00.000Z" },
  }, "receiptDigest"));

  const spend = exp0001aSpendAuthorizationSchema.parse(withDigest({
    schemaVersion: 1,
    kind: "exp-0001a-explicit-spend-authorization",
    protocolId: "EXP-0001A",
    freezeDigest: freeze.freezeDigest,
    authorizationId: "user-approval-1",
    authorizedAt: "2026-08-30T21:45:00.000Z",
    expiresAt: "2026-08-31T21:45:00.000Z",
    authorizedBy: { kind: "user", principal: "fixture-user" },
    authorizationMethod: "explicit-user-confirmation",
    authorizationEvidenceDigest: sha256Digest("explicit approval evidence"),
    currency: "USD",
    maximumUsd: 487.2,
    scope: { attempts: 48, primaryReviews: 96, maximumAdjudications: 48, pairwisePreferences: 24 },
  }, "receiptDigest"));

  const executionHost = exp0001aExecutionHostAttestationSchema.parse(withDigest({
    schemaVersion: 1,
    kind: "exp-0001a-execution-host-attestation",
    protocolId: "EXP-0001A",
    freezeDigest: freeze.freezeDigest,
    capturedAt: "2026-08-30T21:51:30.000Z",
    expiresAt: "2026-08-30T22:12:00.000Z",
    host: {
      nodeVersion: freeze.executionHost.nodeVersion,
      platform: freeze.executionHost.platform,
      architecture: freeze.executionHost.architecture,
      operatingSystem: freeze.executionHost.operatingSystem,
      browser: freeze.executionHost.browser,
      dependencyResolution: freeze.executionHost.dependencyResolution,
      runtimeDependencies: freeze.executionHost.runtimeDependencies,
    },
  }, "receiptDigest"));

  const currentCodeFileBytes = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, await readFile(join(cwd, path))])));
  const attestationPolicyDigest = sourceDigests.executionAuthorityTrustAnchor.fileDigest;
  const attestations = {
    policyDigest: attestationPolicyDigest,
    verifyAuthoritativePrebriefFreeze: async (candidate: BlockedPrebriefFreeze, bytes: string | Uint8Array) => (
      candidate.freezeDigest === freeze.freezeDigest && sha256Digest(bytes) === sha256Digest(freezeBytes)
    ),
    verifyAliasPreflight: async (candidate: Exp0001aAliasPreflight) => candidate.receiptDigest === alias.receiptDigest,
    verifyNoBriefEvidence: async (candidate: Exp0001aNoBriefEvidence, bytes: string | Uint8Array) => (
      candidate.receiptDigest === noBrief.receiptDigest && sha256Digest(bytes) === noBrief.registryFileDigest
    ),
    verifySpendAuthorization: async (candidate: Exp0001aSpendAuthorization) => candidate.receiptDigest === spend.receiptDigest,
    verifyExecutionHostAttestation: async (candidate: Exp0001aExecutionHostAttestation) => (
      candidate.receiptDigest === executionHost.receiptDigest
    ),
  };
  return {
    cwd,
    sourcePaths,
    freeze,
    freezeBytes,
    committedCode,
    liveEnvelope,
    liveBytes,
    alias,
    noBrief,
    registryFileBytes,
    spend,
    executionHost,
    attestations,
    currentCodeFileBytes,
    now: "2026-08-30T21:52:00.000Z",
    git: createGitCliObjectReader(cwd),
  };
}

function inputOf(value: Fixture) {
  return {
    now: value.now,
    prebriefFreeze: value.freeze,
    prebriefFreezeFileBytes: value.freezeBytes,
    committedCodeReceipt: value.committedCode,
    currentCodeFileBytes: value.currentCodeFileBytes,
    freshLiveContractEnvelope: value.liveEnvelope,
    freshLiveContractFileBytes: value.liveBytes,
    aliasPreflight: value.alias,
    noBriefEvidence: value.noBrief,
    registryFileBytes: value.registryFileBytes,
    spendAuthorization: value.spend,
    executionHostAttestation: value.executionHost,
    git: value.git,
    attestations: value.attestations,
  };
}

function redigestCode(value: Exp0001aCommittedCodeReceipt): Exp0001aCommittedCodeReceipt {
  return { ...value, receiptDigest: computeCommittedCodeReceiptDigest(value) };
}

function redigestLive(value: Exp0001aFreshLiveContractEnvelope): Exp0001aFreshLiveContractEnvelope {
  return { ...value, envelopeDigest: computeFreshLiveContractEnvelopeDigest(value) };
}

function redigestAlias(value: Exp0001aAliasPreflight): Exp0001aAliasPreflight {
  return { ...value, receiptDigest: computeAliasPreflightDigest(value) };
}

function redigestNoBrief(value: Exp0001aNoBriefEvidence): Exp0001aNoBriefEvidence {
  return { ...value, receiptDigest: computeNoBriefEvidenceDigest(value) };
}

function redigestSpend(value: Exp0001aSpendAuthorization): Exp0001aSpendAuthorization {
  return { ...value, receiptDigest: computeSpendAuthorizationDigest(value) };
}

function redigestExecutionHost(value: Exp0001aExecutionHostAttestation): Exp0001aExecutionHostAttestation {
  return { ...value, receiptDigest: computeExecutionHostAttestationDigest(value) };
}

describe("EXP-0001A execution gate", () => {
  it("keeps the gate and outer launcher on one exact execution-critical source catalog", () => {
    expect(LAUNCHER_SOURCE_PATHS).toEqual(EXP0001A_EXECUTION_CRITICAL_SOURCE_PATHS);
  });

  it("accepts the actual checked-in-shape blocked freeze at the gate boundary", () => {
    expect(verifyBlockedPrebriefFreezeForExecutionGate(actualFreezeJson)).toMatchObject({ ok: true });
  });

  it("produces and verifies a canonical self-hashed receipt only from real committed objects", async () => {
    const value = await fixture();
    const result = await evaluateExp0001aExecutionGate(inputOf(value));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.receiptDigest).toBe(computeExecutionReadyReceiptDigest(result.receipt));
    expect(result.receipt.committedCode.sourceBindings)
      .toHaveLength(Object.keys(LAUNCHER_FROZEN_SOURCE_PATHS).length);
    expect(result.receipt.committedCode.authorSessionIdentityManifestRoot)
      .toBe(value.freeze.frozenSources.authorSessionIdentityManifest.manifestRoot);
    expect(verifyExp0001aExecutionReadyReceipt(result.receipt, value.now)).toEqual({ ok: true, receipt: result.receipt });
  });

  it("rejects an evaluator envelope whose benchmark commitment is self-consistent but not the committed benchmark bytes", async () => {
    const value = await fixture({ evaluatorBenchmarkDigestOverride: sha256Digest("forged-benchmark") });
    const result = await evaluateExp0001aExecutionGate(inputOf(value));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors).toContain("EVALUATOR_SEMANTIC_ENVELOPE_BENCHMARK_DIGEST_MISMATCH");
    }
  });

  it("fails closed for tampered current bytes even when the receipt is internally re-hashed", async () => {
    const value = await fixture();
    const current = {
      ...value.currentCodeFileBytes,
      [EXP0001A_EXECUTION_CRITICAL_SOURCE_PATHS.attemptMetrics]: Buffer.from("tampered\n"),
    };
    const result = await evaluateExp0001aExecutionGate({ ...inputOf(value), currentCodeFileBytes: current });
    expect(result).toMatchObject({ ok: false });
    const attemptMetricsIndex = Object.keys(LAUNCHER_FROZEN_SOURCE_PATHS)
      .sort()
      .indexOf("attemptMetrics");
    if (!result.ok) expect(result.errors).toContain(`SOURCE_${attemptMetricsIndex}_CURRENT_DIGEST_MISMATCH`);
  });

  it("fails closed if the single source-bound launch-authority implementation changes", async () => {
    const value = await fixture();
    const role = "launchAuthorityVerifier";
    const sourcePath = EXP0001A_EXECUTION_CRITICAL_SOURCE_PATHS[role];
    const result = await evaluateExp0001aExecutionGate({
      ...inputOf(value),
      currentCodeFileBytes: {
        ...value.currentCodeFileBytes,
        [sourcePath]: Buffer.from("export const forgedAuthority = true;\n"),
      },
    });
    expect(result).toMatchObject({ ok: false });
    const sourceIndex = Object.keys(LAUNCHER_FROZEN_SOURCE_PATHS).sort().indexOf(role);
    if (!result.ok) expect(result.errors).toContain(`SOURCE_${sourceIndex}_CURRENT_DIGEST_MISMATCH`);
  });

  it("rejects a wrong committed digest even when the code receipt self-hash is repaired", async () => {
    const value = await fixture();
    const changed = structuredClone(value.committedCode);
    const batch = changed.sourceBindings.find((source) => source.role === "batchCoordinator");
    if (!batch) throw new Error("Fixture batch binding missing.");
    batch.fileDigest = sha256Digest("invented bytes");
    const result = await evaluateExp0001aExecutionGate({ ...inputOf(value), committedCodeReceipt: redigestCode(changed) });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors).toContain("COMMITTED_CODE_SOURCE_CATALOG_MISMATCH");
      const batchCoordinatorIndex = Object.keys(LAUNCHER_FROZEN_SOURCE_PATHS)
        .sort()
        .indexOf("batchCoordinator");
      expect(result.errors).toContain(`SOURCE_${batchCoordinatorIndex}_CURRENT_DIGEST_MISMATCH`);
      expect(result.errors).toContain(`SOURCE_${batchCoordinatorIndex}_COMMITTED_DIGEST_MISMATCH`);
    }
  });

  it("rejects a wrong production deployment despite repaired live and alias hashes", async () => {
    const value = await fixture();
    const live = structuredClone(value.liveEnvelope);
    live.receipt.baseline.deploymentId = "dpl_wrong";
    live.receipt.baseline.executionUrlVerifiedDeploymentId = "dpl_wrong";
    live.receiptDigest = hashCanonicalJson(live.receipt);
    const alias = redigestAlias({ ...value.alias, resolvedDeploymentId: "dpl_wrong" });
    const result = await evaluateExp0001aExecutionGate({
      ...inputOf(value),
      freshLiveContractEnvelope: redigestLive(live),
      aliasPreflight: alias,
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors).toContain("LIVE_BASELINE_DEPLOYMENT_MISMATCH");
      expect(result.errors).toContain("ALIAS_DEPLOYMENT_MISMATCH");
    }
  });

  it("rejects a rewritten per-attempt deployment-continuity baseline", async () => {
    const value = await fixture();
    const freeze = structuredClone(value.freeze);
    freeze.deploymentContinuityPolicy.frozenDeploymentId = "dpl_wrong";
    freeze.freezeDigest = hashCanonicalJson(Object.fromEntries(
      Object.entries(freeze).filter(([key]) => key !== "freezeDigest"),
    ));
    const bytes = `${JSON.stringify(freeze, null, 2)}\n`;
    const code = structuredClone(value.committedCode);
    code.freezeDigest = freeze.freezeDigest;
    code.prebriefFreeze.fileDigest = sha256Digest(bytes);
    const result = await evaluateExp0001aExecutionGate({
      ...inputOf(value),
      prebriefFreeze: freeze,
      prebriefFreezeFileBytes: bytes,
      committedCodeReceipt: redigestCode(code),
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.errors).toContain("DEPLOYMENT_CONTINUITY_BASELINE_MISMATCH");
  });

  it("rejects expired preflight, lock, spend authorization, and ready receipts", async () => {
    const value = await fixture();
    const expiredAlias = redigestAlias({ ...value.alias, expiresAt: "2026-08-30T21:51:30.000Z" });
    const expiredNoBrief = redigestNoBrief({
      ...value.noBrief,
      releaseLock: { ...value.noBrief.releaseLock, expiresAt: "2026-08-30T21:51:30.000Z" },
    });
    const expiredSpend = redigestSpend({ ...value.spend, expiresAt: "2026-08-30T21:51:30.000Z" });
    const expiredHost = redigestExecutionHost({ ...value.executionHost, expiresAt: "2026-08-30T21:51:30.000Z" });
    const result = await evaluateExp0001aExecutionGate({
      ...inputOf(value),
      aliasPreflight: expiredAlias,
      noBriefEvidence: expiredNoBrief,
      spendAuthorization: expiredSpend,
      executionHostAttestation: expiredHost,
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        "ALIAS_PREFLIGHT_EXPIRED",
        "NO_BRIEF_RELEASE_LOCK_EXPIRED",
        "SPEND_AUTHORIZATION_EXPIRED",
        "EXECUTION_HOST_ATTESTATION_EXPIRED",
      ]));
    }

    const valid = await evaluateExp0001aExecutionGate(inputOf(value));
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(verifyExp0001aExecutionReadyReceipt(valid.receipt, "2026-08-30T22:10:00.000Z")).toMatchObject({
        ok: false,
        errors: expect.arrayContaining(["EXECUTION_READY_RECEIPT_EXPIRED"]),
      });
    }
  });

  it("requires a fresh exact local host and dependency-lock attestation", async () => {
    const value = await fixture();
    const wrong = structuredClone(value.executionHost);
    wrong.host.dependencyResolution.packageLockDigest = sha256Digest("different package lock");
    const result = await evaluateExp0001aExecutionGate({
      ...inputOf(value),
      executionHostAttestation: redigestExecutionHost(wrong),
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        "EXECUTION_HOST_COVARIATE_MISMATCH",
        "EXECUTION_HOST_PACKAGE_LOCK_DIGEST_MISMATCH",
        "EXECUTION_HOST_ATTESTATION_REJECTED",
      ]));
    }
  });

  it("requires explicit spend authority within the frozen maximum envelope", async () => {
    const value = await fixture();
    const missing = inputOf(value);
    delete (missing as { spendAuthorization?: unknown }).spendAuthorization;
    const missingResult = await evaluateExp0001aExecutionGate(missing);
    expect(missingResult).toEqual({ ok: false, errors: ["SPEND_AUTHORIZATION_MISSING"] });

    const prudent = redigestSpend({ ...value.spend, maximumUsd: 400 });
    const prudentResult = await evaluateExp0001aExecutionGate({
      ...inputOf(value),
      spendAuthorization: prudent,
      attestations: {
        ...value.attestations,
        verifySpendAuthorization: async (candidate) => candidate.receiptDigest === prudent.receiptDigest,
      },
    });
    expect(prudentResult).toMatchObject({ ok: true });
    if (prudentResult.ok) {
      expect(prudentResult.receipt.spendAuthorization).toMatchObject({ maximumUsd: 400, frozenCapTotalUsd: 487.2 });
    }

    const high = redigestSpend({ ...value.spend, maximumUsd: 488 });
    const highResult = await evaluateExp0001aExecutionGate({ ...inputOf(value), spendAuthorization: high });
    expect(highResult).toMatchObject({ ok: false });
    if (!highResult.ok) expect(highResult.errors).toContain("SPEND_AUTHORIZATION_EXCEEDS_FROZEN_CAP");

    const stalePricing = redigestSpend({ ...value.spend, expiresAt: "2026-11-22T00:00:00.001Z" });
    const stalePricingResult = await evaluateExp0001aExecutionGate({
      ...inputOf(value),
      spendAuthorization: stalePricing,
      attestations: {
        ...value.attestations,
        verifySpendAuthorization: async (candidate) => candidate.receiptDigest === stalePricing.receiptDigest,
      },
    });
    expect(stalePricingResult).toMatchObject({ ok: false });
    if (!stalePricingResult.ok) {
      expect(stalePricingResult.errors).toContain("SPEND_AUTHORIZATION_OUTLIVES_PRICING_VALIDITY");
    }
  });

  it("requires a zero-brief registry under a live exclusive release lock", async () => {
    const value = await fixture();
    const begun = {
      ...value.noBrief,
      briefsDelivered: 1,
      begunAttempts: 1,
      receiptDigest: zeroDigest,
    };
    const result = await evaluateExp0001aExecutionGate({ ...inputOf(value), noBriefEvidence: begun });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.errors.some((error) => error.startsWith("NO_BRIEF_SCHEMA:"))).toBe(true);

    const deliveredRegistry = `${JSON.stringify({
      schemaVersion: 1,
      events: [{ kind: "brief_delivered", attemptId: "attempt-001" }],
      registryDigest: value.noBrief.registryDigest,
    }, null, 2)}\n`;
    const deliveredEvidence = redigestNoBrief({
      ...value.noBrief,
      registryFileDigest: sha256Digest(deliveredRegistry),
    });
    const deliveredResult = await evaluateExp0001aExecutionGate({
      ...inputOf(value),
      noBriefEvidence: deliveredEvidence,
      registryFileBytes: deliveredRegistry,
      attestations: {
        ...value.attestations,
        verifyNoBriefEvidence: async (candidate, bytes) => (
          candidate.receiptDigest === deliveredEvidence.receiptDigest
          && sha256Digest(bytes) === deliveredEvidence.registryFileDigest
        ),
      },
    });
    expect(deliveredResult).toMatchObject({ ok: false });
    if (!deliveredResult.ok) expect(deliveredResult.errors).toContain("NO_BRIEF_REGISTRY_CONTAINS_DELIVERY");
  });

  it("rejects omitted and duplicated execution-critical source bindings", async () => {
    const value = await fixture();
    const omitted = structuredClone(value.committedCode);
    omitted.sourceBindings = omitted.sourceBindings.filter((binding) => binding.role !== "atomicRegistryStore");
    const omittedResult = await evaluateExp0001aExecutionGate({
      ...inputOf(value),
      committedCodeReceipt: redigestCode(omitted),
      currentCodeFileBytes: Object.fromEntries(
        Object.entries(value.currentCodeFileBytes).filter(([path]) => (
          path !== EXP0001A_EXECUTION_CRITICAL_SOURCE_PATHS.atomicRegistryStore
        )),
      ) as Record<string, string | Uint8Array>,
    });
    expect(omittedResult).toMatchObject({ ok: false });
    if (!omittedResult.ok) expect(omittedResult.errors).toContain("COMMITTED_CODE_SOURCE_CATALOG_MISMATCH");

    const duplicated = structuredClone(value.committedCode);
    duplicated.sourceBindings.push(structuredClone(duplicated.sourceBindings[0]));
    const duplicatedResult = await evaluateExp0001aExecutionGate({
      ...inputOf(value),
      committedCodeReceipt: { ...duplicated, receiptDigest: computeCommittedCodeReceiptDigest(duplicated as Exp0001aCommittedCodeReceipt) },
    });
    expect(duplicatedResult).toMatchObject({ ok: false });
    if (!duplicatedResult.ok) expect(duplicatedResult.errors.some((error) => error.startsWith("COMMITTED_CODE_SCHEMA:"))).toBe(true);
  });

  it("rejects semantically valid but unattested forged operational receipts", async () => {
    const value = await fixture();
    const forgedAlias = redigestAlias({ ...value.alias, expiresAt: "2026-08-30T22:25:00.000Z" });
    const aliasResult = await evaluateExp0001aExecutionGate({ ...inputOf(value), aliasPreflight: forgedAlias });
    expect(aliasResult).toMatchObject({ ok: false });
    if (!aliasResult.ok) expect(aliasResult.errors).toContain("ALIAS_PREFLIGHT_ATTESTATION_REJECTED");

    const forgedSpend = redigestSpend({ ...value.spend, authorizationEvidenceDigest: sha256Digest("forged approval") });
    const spendResult = await evaluateExp0001aExecutionGate({ ...inputOf(value), spendAuthorization: forgedSpend });
    expect(spendResult).toMatchObject({ ok: false });
    if (!spendResult.ok) expect(spendResult.errors).toContain("SPEND_AUTHORIZATION_ATTESTATION_REJECTED");
  });

  it("requires a separately trusted attestation policy and rejects forged Git provenance", async () => {
    const value = await fixture();
    const withoutTrust = inputOf(value);
    delete (withoutTrust as { attestations?: unknown }).attestations;
    const trustResult = await evaluateExp0001aExecutionGate(withoutTrust);
    expect(trustResult).toMatchObject({ ok: false, errors: expect.arrayContaining(["ATTESTATION_VERIFIER_MISSING"]) });

    const callerChosenPolicy = {
      ...value.attestations,
      policyDigest: sha256Digest("caller-chosen-policy"),
    };
    const callerChosenResult = await evaluateExp0001aExecutionGate({
      ...inputOf(value),
      attestations: callerChosenPolicy,
    });
    expect(callerChosenResult).toMatchObject({ ok: false });
    if (!callerChosenResult.ok) {
      expect(callerChosenResult.errors).toContain("ATTESTATION_POLICY_NOT_FROZEN_TRUST_ANCHOR");
    }

    const forged = structuredClone(value.committedCode);
    forged.gitCommit = "f".repeat(40);
    const gitResult = await evaluateExp0001aExecutionGate({ ...inputOf(value), committedCodeReceipt: redigestCode(forged) });
    expect(gitResult).toMatchObject({ ok: false });
    if (!gitResult.ok) expect(gitResult.errors).toEqual(expect.arrayContaining([
      "COMMITTED_CODE_GIT_COMMIT_UNRESOLVED",
      "PREBRIEF_FREEZE_GIT_FILE_UNRESOLVED",
    ]));
  });

  it("treats trailing slashes as equivalent origins while keeping alias and immutable deployment roles distinct", async () => {
    const value = await fixture();
    const alias = redigestAlias({
      ...value.alias,
      productionUrl: `${value.alias.productionUrl}/`,
      resolvedImmutableUrl: `${value.alias.resolvedImmutableUrl}/`,
    });
    const live = structuredClone(value.liveEnvelope);
    live.receipt.baseline.executionUrl = `${live.receipt.baseline.executionUrl}/`;
    live.receipt.baseline.immutableDeploymentUrl = `${live.receipt.baseline.immutableDeploymentUrl}/`;
    live.receiptDigest = hashCanonicalJson(live.receipt);
    const liveEnvelope = redigestLive(live);
    const result = await evaluateExp0001aExecutionGate({
      ...inputOf(value),
      aliasPreflight: alias,
      freshLiveContractEnvelope: liveEnvelope,
      attestations: {
        ...value.attestations,
        verifyAliasPreflight: async (candidate) => candidate.receiptDigest === alias.receiptDigest,
      },
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors).not.toContain("ALIAS_PRODUCTION_URL_MISMATCH");
      expect(result.errors).not.toContain("ALIAS_IMMUTABLE_URL_MISMATCH");
      expect(result.errors).not.toContain("LIVE_EXECUTION_URL_MISMATCH");
      expect(result.errors).not.toContain("LIVE_BASELINE_IMMUTABLE_URL_MISMATCH");
      expect(result.errors).toContain("LIVE_CONTRACT_BYTES_VALUE_MISMATCH");
    }
  });

  it("rejects A/A condition differences even when the freeze self-hash is repaired", async () => {
    const value = await fixture();
    const freeze = structuredClone(value.freeze);
    freeze.conditions.A1 = { ...freeze.conditions.A1, participantContractDigest: sha256Digest("different") };
    freeze.freezeDigest = hashCanonicalJson(Object.fromEntries(Object.entries(freeze).filter(([key]) => key !== "freezeDigest")));
    const bytes = `${JSON.stringify(freeze, null, 2)}\n`;
    const code = structuredClone(value.committedCode);
    code.freezeDigest = freeze.freezeDigest;
    code.prebriefFreeze.fileDigest = sha256Digest(bytes);
    const result = await evaluateExp0001aExecutionGate({
      ...inputOf(value),
      prebriefFreeze: freeze,
      prebriefFreezeFileBytes: bytes,
      committedCodeReceipt: redigestCode(code),
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.errors).toContain("AA_CONDITIONS_NOT_IDENTICAL");
  });

  it("detects tampering in the final receipt's canonical self-hash", async () => {
    const value = await fixture();
    const result = await evaluateExp0001aExecutionGate(inputOf(value));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tampered = { ...result.receipt, conditionsDigest: sha256Digest("tampered") };
    expect(verifyExp0001aExecutionReadyReceipt(tampered, value.now)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["EXECUTION_READY_RECEIPT_DIGEST_MISMATCH"]),
    });
  });
});
