#!/usr/bin/env node

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import path from "node:path";

export const FIXED_RUNTIME_BUNDLE_PATH = "research/runtime/exp0001a-runtime.bundle.mjs";
export const FIXED_TRUST_ANCHOR_PATH = "research/data/exp0001a-execution-authority-public.pem";
export const FIXED_TRUST_ANCHOR_SHA256 = "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de";
export const FIXED_TRUST_ANCHOR_KEY_ID = "exp0001a-launch-authority-2026-08-30";
export const EXP0001A_LAUNCH_SIGNATURE_DOMAIN = "Jazzboard EXP-0001A launch authorization v1\0";
export const FIXED_EXECUTION_CRITICAL_SOURCE_PATHS = Object.freeze({
  adjudicationOrchestration: "src/lib/research/blinded-review-orchestration.ts",
  analysisRuntime: "src/lib/research/exp0001a-analysis-runtime.ts",
  atomicRegistryStore: "src/lib/research/atomic-registry-store.ts",
  attemptMetrics: "src/lib/research/attempt-metrics.ts",
  attemptMetricsRegistry: "src/lib/research/exp0001a-attempt-metrics-registry.ts",
  attemptMetricsSpec: "research/data/exp0001a-attempt-metrics-spec-v1.json",
  authorRunner: "research/scripts/clean-room-live-runner.mjs",
  authorSessionIdentityManifest: "src/lib/research/exp0001a-author-identities.ts",
  batchCoordinator: "src/lib/research/exp0001a-batch-coordinator.ts",
  batchCli: "research/scripts/exp0001a-batch-command.mjs",
  batchCommandLibrary: "src/lib/research/exp0001a-batch-command.ts",
  batchRegistryBridge: "src/lib/research/exp0001a-registry-bridge.ts",
  cleanRoomBatchAdapter: "src/lib/research/clean-room-batch-executor.ts",
  completionAttestation: "src/lib/research/exp0001a-completion-attestation.ts",
  completionSignerCli: "research/scripts/sign-exp0001a-completion.mjs",
  evaluatorRunner: "research/scripts/blinded-evaluator-runner.mjs",
  evaluatorSemanticEnvelopeReceipt: "research/data/exp0001a-evaluator-semantic-envelope-v1.json",
  executionAuthorityTrustAnchor: "research/data/exp0001a-execution-authority-public.pem",
  executionGate: "src/lib/research/exp0001a-execution-gate.ts",
  experimentFreezeAdapter: "src/lib/research/exp0001a-experiment-freeze-adapter.ts",
  launchAuthorityVerifier: "research/scripts/exp0001a-launch-authority.mjs",
  launchSignerCli: "research/scripts/sign-exp0001a-launch.mjs",
  liveReviewRunner: "src/lib/research/exp0001a-live-review-runner.ts",
  metricsRuntime: "src/lib/research/exp0001a-metrics-runtime.ts",
  packageLock: "package-lock.json",
  packageManifest: "package.json",
  pairwisePreference: "src/lib/research/pairwise-visual-preference.ts",
  pairwisePreferenceInstructions: "research/protocols/pairwise-visual-preference-instructions-v1.md",
  pairwiseRuntime: "src/lib/research/exp0001a-pairwise-runtime.ts",
  perAttemptAliasVerifier: "src/lib/research/exp0001a-per-attempt-alias-verifier.ts",
  reportCompiler: "src/lib/research/exp0001a-analysis.ts",
  runtimeBuilder: "research/scripts/build-exp0001a-runtime.mjs",
  runtimeBundle: "research/runtime/exp0001a-runtime.bundle.mjs",
  runtimeComposition: "src/lib/research/exp0001a-runtime-composition.ts",
  runtimeDependencyReceipt: "research/data/exp0001a-runtime-dependencies-v1.json",
  runtimeDependencyVerifier: "research/scripts/exp0001a-runtime-dependencies.mjs",
  scoring: "src/lib/research/scoring.ts",
  spendLedger: "src/lib/research/exp0001a-spend-ledger.ts",
  statistics: "src/lib/research/statistics.ts",
});
export const FIXED_FROZEN_SOURCE_PATHS = Object.freeze({
  protocol: "research/protocols/exp-0001a-aa-calibration.md",
  benchmark: "research/benchmarks/development-v1.json",
  rubrics: "research/benchmarks/development-evaluator-rubrics-v1.json",
  fixtures: "research/benchmarks/development-fixture-specs-v1.json",
  benchmarkCompiler: "src/lib/research/benchmark-execution.ts",
  artifactSchemas: "src/lib/research/attempt-schemas.ts",
  failureTaxonomy: "research/protocols/failure-taxonomy-v2.md",
  evaluatorInstructions: "research/protocols/blinded-evaluator-instructions-v1.md",
  runnerProfile: "research/data/development-runner-profile-v1.json",
  attemptCompiler: "src/lib/research/development-attempt-config.ts",
  ...FIXED_EXECUTION_CRITICAL_SOURCE_PATHS,
});
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const SAFE_RELATIVE_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))(?!\/)(?!.*\\)[\x20-\x7e]+$/;

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function parseConfig(raw) {
  const absoluteFileKeys = [
    "prebriefFreeze", "executionReadyReceipt", "noBriefEvidence",
    "aliasPreflight", "initialRegistry", "authoritySignature",
  ];
  const absolutePathKeys = ["root", "registryFile", "outputRoot", "prebriefIncidentRoot"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || !hasExactKeys(raw, raw.execution === undefined
        ? ["schemaVersion", "protocolId", "files", "paths"]
        : ["schemaVersion", "protocolId", "files", "paths", "execution"])
      || raw.schemaVersion !== 2 || raw.protocolId !== "EXP-0001A"
      || !hasExactKeys(raw.files, absoluteFileKeys)
      || absoluteFileKeys.some((key) => typeof raw.files[key] !== "string" || !path.isAbsolute(raw.files[key]))
      || !hasExactKeys(raw.paths, absolutePathKeys)
      || absolutePathKeys.some((key) => typeof raw.paths[key] !== "string" || !path.isAbsolute(raw.paths[key]))) {
    throw new Error("EXP-0001A CLI config must use schema v2 and cannot select a runtime module.");
  }
  if (raw.execution !== undefined && (!raw.execution || typeof raw.execution !== "object"
      || !hasExactKeys(raw.execution, [
        "authorized", "executionReadyReceiptDigest", "spendAuthorizationReceiptDigest",
        "authorizationId", "releaseLockToken",
      ])
      || raw.execution.authorized !== true
      || typeof raw.execution.executionReadyReceiptDigest !== "string" || !SHA256.test(raw.execution.executionReadyReceiptDigest)
      || typeof raw.execution.spendAuthorizationReceiptDigest !== "string" || !SHA256.test(raw.execution.spendAuthorizationReceiptDigest)
      || typeof raw.execution.authorizationId !== "string" || !raw.execution.authorizationId.trim()
      || typeof raw.execution.releaseLockToken !== "string" || raw.execution.releaseLockToken.length < 32)) {
    throw new Error("EXP-0001A execute stanza is invalid.");
  }
  return raw;
}


function futureTimestamp(value, now, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} timestamp is invalid.`);
  }
  if (Date.parse(value) <= Date.parse(now)) throw new Error(`${label} is expired.`);
  return value;
}

export function parseReadyReceipt(
  raw,
  now = new Date().toISOString(),
  expectedTrustAnchorDigest = FIXED_TRUST_ANCHOR_SHA256,
) {
  const readyKeys = [
    "schemaVersion", "kind", "protocolId", "createdAt", "validUntil", "freezeDigest",
    "baseline", "conditionsDigest", "committedCode", "liveContract", "aliasPreflightDigest",
    "deploymentContinuity", "noBriefEvidenceDigest", "executionHost", "attestationPolicyDigest",
    "spendAuthorization", "assertions", "receiptDigest",
  ];
  if (!hasExactKeys(raw, readyKeys)
      || raw.schemaVersion !== 1 || raw.kind !== "exp-0001a-execution-ready"
      || raw.protocolId !== "EXP-0001A"
      || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))
      || typeof raw.receiptDigest !== "string" || !SHA256.test(raw.receiptDigest)
      || typeof raw.freezeDigest !== "string" || !SHA256.test(raw.freezeDigest)
      || typeof raw.noBriefEvidenceDigest !== "string" || !SHA256.test(raw.noBriefEvidenceDigest)
      || typeof raw.attestationPolicyDigest !== "string" || !SHA256.test(raw.attestationPolicyDigest)
      || !hasExactKeys(raw.baseline, ["gitCommit", "gitTree", "deploymentId", "buildId", "immutableUrl", "productionUrl"])
      || !GIT_OBJECT.test(raw.baseline.gitCommit) || !GIT_OBJECT.test(raw.baseline.gitTree)
      || typeof raw.baseline.deploymentId !== "string" || !/^dpl_[A-Za-z0-9]+$/.test(raw.baseline.deploymentId)
      || typeof raw.baseline.buildId !== "string" || !/^bld_[A-Za-z0-9]+$/.test(raw.baseline.buildId)
      || typeof raw.baseline.immutableUrl !== "string" || !raw.baseline.immutableUrl.startsWith("https://")
      || typeof raw.baseline.productionUrl !== "string" || !raw.baseline.productionUrl.startsWith("https://")
      || typeof raw.conditionsDigest !== "string" || !SHA256.test(raw.conditionsDigest)
      || !hasExactKeys(raw.committedCode, [
        "receiptDigest", "gitCommit", "gitTree", "authorSessionIdentityManifestRoot", "sourceBindings",
      ])
      || !SHA256.test(raw.committedCode.receiptDigest)
      || !GIT_OBJECT.test(raw.committedCode.gitCommit) || !GIT_OBJECT.test(raw.committedCode.gitTree)
      || !SHA256.test(raw.committedCode.authorSessionIdentityManifestRoot)
      || !hasExactKeys(raw.liveContract, [
        "envelopeDigest", "receiptDigest", "gitCommit", "gitTree", "capturedAt",
        "participantContractDigest", "spectatorContractDigest",
      ])
      || !SHA256.test(raw.liveContract.envelopeDigest) || !SHA256.test(raw.liveContract.receiptDigest)
      || !GIT_OBJECT.test(raw.liveContract.gitCommit) || !GIT_OBJECT.test(raw.liveContract.gitTree)
      || typeof raw.liveContract.capturedAt !== "string" || !Number.isFinite(Date.parse(raw.liveContract.capturedAt))
      || !SHA256.test(raw.liveContract.participantContractDigest) || !SHA256.test(raw.liveContract.spectatorContractDigest)
      || !SHA256.test(raw.aliasPreflightDigest)
      || !hasExactKeys(raw.deploymentContinuity, [
        "verifierSourceRole", "verifierSourceDigest", "verificationTiming",
        "requiredReceiptCountAtCompletion", "receiptsHashChainedInBatchRegistry", "driftDisposition",
      ])
      || raw.deploymentContinuity.verifierSourceRole !== "perAttemptAliasVerifier"
      || !SHA256.test(raw.deploymentContinuity.verifierSourceDigest)
      || raw.deploymentContinuity.verificationTiming !== "authenticated-vercel-api-immediately-before-each-brief"
      || raw.deploymentContinuity.requiredReceiptCountAtCompletion !== 48
      || raw.deploymentContinuity.receiptsHashChainedInBatchRegistry !== true
      || raw.deploymentContinuity.driftDisposition !== "not_started-hard-stop-before-brief"
      || !hasExactKeys(raw.executionHost, [
        "attestationDigest", "capturedAt", "nodeVersion", "platform", "architecture",
        "operatingSystemBuild", "packageManifestDigest", "packageLockDigest",
        "runtimeDependencyReceiptDigest", "runtimeDependencyComponentSetRoot",
        "runtimeDependencyReceiptCaptureVerificationDurationMs",
      ])
      || !SHA256.test(raw.executionHost.attestationDigest)
      || typeof raw.executionHost.capturedAt !== "string" || !Number.isFinite(Date.parse(raw.executionHost.capturedAt))
      || raw.executionHost.nodeVersion !== "22.22.0" || raw.executionHost.platform !== "darwin"
      || raw.executionHost.architecture !== "arm64" || raw.executionHost.operatingSystemBuild !== "25G83"
      || !SHA256.test(raw.executionHost.packageManifestDigest) || !SHA256.test(raw.executionHost.packageLockDigest)
      || !SHA256.test(raw.executionHost.runtimeDependencyReceiptDigest)
      || !SHA256.test(raw.executionHost.runtimeDependencyComponentSetRoot)
      || !Number.isSafeInteger(raw.executionHost.runtimeDependencyReceiptCaptureVerificationDurationMs)
      || raw.executionHost.runtimeDependencyReceiptCaptureVerificationDurationMs < 0
      || !raw.spendAuthorization || typeof raw.spendAuthorization !== "object"
      || !hasExactKeys(raw.spendAuthorization, [
        "receiptDigest", "authorizationId", "maximumUsd", "frozenCapTotalUsd", "scope",
        "expiresAt", "pricingRevalidationRequiredBefore",
      ])
      || typeof raw.spendAuthorization.receiptDigest !== "string" || !SHA256.test(raw.spendAuthorization.receiptDigest)
      || typeof raw.spendAuthorization.authorizationId !== "string" || !raw.spendAuthorization.authorizationId.trim()
      || typeof raw.spendAuthorization.maximumUsd !== "number" || !(raw.spendAuthorization.maximumUsd > 0)
      || raw.spendAuthorization.frozenCapTotalUsd !== 487.2
      || raw.spendAuthorization.maximumUsd > raw.spendAuthorization.frozenCapTotalUsd
      || !hasExactKeys(raw.spendAuthorization.scope, [
        "attempts", "primaryReviews", "maximumAdjudications", "pairwisePreferences",
      ])
      || raw.spendAuthorization.scope.attempts !== 48 || raw.spendAuthorization.scope.primaryReviews !== 96
      || raw.spendAuthorization.scope.maximumAdjudications !== 48
      || raw.spendAuthorization.scope.pairwisePreferences !== 24
      || raw.spendAuthorization.pricingRevalidationRequiredBefore !== "2026-11-22T00:00:00.000Z"
      || !hasExactKeys(raw.assertions, [
        "blockedFreezeVerified", "currentBytesEqualCommittedBytes", "gitCommitAndTreeVerified",
        "liveReceiptCommittedAfterFreeze", "baselineDeploymentExact",
        "aliasExecutionScientificallyBoundToProtectedImmutableBaseline",
        "perAttemptDeploymentVerificationRequiredBeforeBrief", "contractsExact", "executionHostExact",
        "noBriefsDeliveredUnderExclusiveLock", "spendExplicitAndUnexpired",
        "spendAuthorizationWithinFrozenProtocolCeiling",
        "spendAuthorizationExpiresBeforePricingRevalidation", "preProviderCumulativeInputHardCapVerified",
        "aaConditionsIdentical",
      ])
      || Object.values(raw.assertions).some((value) => value !== true)
      || !Array.isArray(raw.committedCode.sourceBindings)) {
    throw new Error("Execution-ready receipt lacks exact committed source bindings.");
  }
  const bindings = raw.committedCode.sourceBindings;
  for (const binding of bindings) {
    if (!hasExactKeys(binding, ["role", "path", "mode", "fileDigest", "blobOid"])
        || typeof binding.role !== "string"
        || typeof binding.path !== "string" || !SAFE_RELATIVE_PATH.test(binding.path)
        || !["100644", "100755"].includes(binding.mode)
        || typeof binding.fileDigest !== "string" || !SHA256.test(binding.fileDigest)
        || typeof binding.blobOid !== "string" || !GIT_OBJECT.test(binding.blobOid)) {
      throw new Error("Execution-ready source binding is invalid.");
    }
  }
  if (new Set(bindings.map((binding) => binding.role)).size !== bindings.length
      || new Set(bindings.map((binding) => binding.path)).size !== bindings.length) {
    throw new Error("Execution-ready source roles and paths must be unique.");
  }
  const expectedBindings = Object.entries(FIXED_FROZEN_SOURCE_PATHS);
  if (bindings.length !== expectedBindings.length
      || expectedBindings.some(([role, expectedPath]) => (
        bindings.filter((binding) => binding.role === role && binding.path === expectedPath).length !== 1
      ))) {
    throw new Error("Execution-ready receipt must bind the complete frozen source universe and each exact fixed path once.");
  }
  for (const [role, expectedPath] of Object.entries(FIXED_EXECUTION_CRITICAL_SOURCE_PATHS)) {
    if (bindings.filter((binding) => binding.role === role && binding.path === expectedPath).length !== 1) {
      throw new Error("Execution-ready receipt lacks an execution-critical source role from the complete frozen universe.");
    }
  }
  const trustAnchor = bindings.find((binding) => binding.role === "executionAuthorityTrustAnchor");
  if (!trustAnchor || trustAnchor.path !== FIXED_TRUST_ANCHOR_PATH
      || trustAnchor.fileDigest !== expectedTrustAnchorDigest
      || raw.attestationPolicyDigest !== expectedTrustAnchorDigest) {
    throw new Error("Execution-ready receipt does not bind the fixed launch trust anchor.");
  }
  const { receiptDigest, ...content } = raw;
  if (sha256(canonicalJson(content)) !== receiptDigest) {
    throw new Error("Execution-ready receipt self-digest is invalid.");
  }
  futureTimestamp(raw.validUntil, now, "Execution-ready receipt");
  futureTimestamp(raw.spendAuthorization.expiresAt, now, "Spend authorization");
  if (Date.parse(raw.createdAt) > Date.parse(now)
      || Date.parse(raw.createdAt) >= Date.parse(raw.validUntil)
      || Date.parse(raw.validUntil) > Date.parse(raw.spendAuthorization.expiresAt)
      || Date.parse(raw.validUntil) > Date.parse(raw.spendAuthorization.pricingRevalidationRequiredBefore)) {
    throw new Error("Execution-ready receipt validity interval is inconsistent.");
  }
  return raw;
}

function parseNoBriefEvidence(raw, now = new Date().toISOString()) {
  if (!hasExactKeys(raw, [
    "schemaVersion", "kind", "protocolId", "freezeDigest", "observedAt", "briefsDelivered",
    "begunAttempts", "registryDigest", "registryFileDigest", "releaseLock", "receiptDigest",
  ])
      || raw.schemaVersion !== 1 || raw.kind !== "exp-0001a-no-brief-evidence"
      || raw.protocolId !== "EXP-0001A"
      || typeof raw.freezeDigest !== "string" || !SHA256.test(raw.freezeDigest)
      || typeof raw.receiptDigest !== "string" || !SHA256.test(raw.receiptDigest)
      || typeof raw.observedAt !== "string" || !Number.isFinite(Date.parse(raw.observedAt))
      || raw.briefsDelivered !== 0 || raw.begunAttempts !== 0
      || typeof raw.registryDigest !== "string" || !SHA256.test(raw.registryDigest)
      || typeof raw.registryFileDigest !== "string" || !SHA256.test(raw.registryFileDigest)
      || !hasExactKeys(raw.releaseLock, ["held", "tokenDigest", "expiresAt"])
      || raw.releaseLock.held !== true
      || typeof raw.releaseLock.tokenDigest !== "string" || !SHA256.test(raw.releaseLock.tokenDigest)) {
    throw new Error("No-brief evidence is invalid or does not retain an exclusive zero-brief lock.");
  }
  const { receiptDigest, ...content } = raw;
  if (sha256(canonicalJson(content)) !== receiptDigest) throw new Error("No-brief evidence self-digest is invalid.");
  futureTimestamp(raw.releaseLock.expiresAt, now, "No-brief release lock");
  if (Date.parse(raw.observedAt) > Date.parse(now)) throw new Error("No-brief evidence is from the future.");
  return raw;
}

function parseLaunchEnvelope(raw) {
  if (!hasExactKeys(raw, [
    "schemaVersion", "keyId", "mode", "readyReceiptDigest", "runtimeBundlePath",
    "runtimeBundleDigest", "trustAnchorDigest", "cliConfigDigest", "noBriefEvidenceDigest",
    "spendAuthorizationReceiptDigest", "authorizationId", "releaseLockTokenDigest",
    "exactAuthorizationDigest", "signedAt", "expiresAt", "signatureBase64",
  ])
      || raw.schemaVersion !== "exp-0001a-launch-authorization/v1"
      || raw.keyId !== FIXED_TRUST_ANCHOR_KEY_ID
      || !["dry-run", "execute"].includes(raw.mode)
      || typeof raw.readyReceiptDigest !== "string" || !SHA256.test(raw.readyReceiptDigest)
      || raw.runtimeBundlePath !== FIXED_RUNTIME_BUNDLE_PATH
      || typeof raw.runtimeBundleDigest !== "string" || !SHA256.test(raw.runtimeBundleDigest)
      || typeof raw.trustAnchorDigest !== "string" || !SHA256.test(raw.trustAnchorDigest)
      || typeof raw.cliConfigDigest !== "string" || !SHA256.test(raw.cliConfigDigest)
      || typeof raw.noBriefEvidenceDigest !== "string" || !SHA256.test(raw.noBriefEvidenceDigest)
      || typeof raw.spendAuthorizationReceiptDigest !== "string" || !SHA256.test(raw.spendAuthorizationReceiptDigest)
      || typeof raw.authorizationId !== "string" || !raw.authorizationId.trim()
      || !(raw.releaseLockTokenDigest === null
        || (typeof raw.releaseLockTokenDigest === "string" && SHA256.test(raw.releaseLockTokenDigest)))
      || !(raw.exactAuthorizationDigest === null
        || (typeof raw.exactAuthorizationDigest === "string" && SHA256.test(raw.exactAuthorizationDigest)))
      || typeof raw.signedAt !== "string" || !Number.isFinite(Date.parse(raw.signedAt))
      || typeof raw.expiresAt !== "string" || !Number.isFinite(Date.parse(raw.expiresAt))
      || typeof raw.signatureBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.signatureBase64)) {
    throw new Error("Launch authorization envelope is invalid.");
  }
  return raw;
}

function launchEnvelopeMessage(envelope) {
  const content = Object.fromEntries(
    Object.entries(envelope).filter(([key]) => key !== "signatureBase64"),
  );
  return Buffer.from(`${EXP0001A_LAUNCH_SIGNATURE_DOMAIN}${canonicalJson(content)}`, "utf8");
}

/** Pure verifier used by attacks/tests; the production caller below supplies
 * only the fixed repository trust anchor whose digest is embedded above. */
export function verifyExp0001aPreImportLaunchAuthorization(input) {
  const envelope = parseLaunchEnvelope(input.envelope);
  const now = typeof input.now === "string" ? input.now : new Date().toISOString();
  if (!(input.configBytes instanceof Uint8Array)) throw new Error("Exact CLI config bytes are required.");
  let config;
  try { config = parseConfig(JSON.parse(Buffer.from(input.configBytes).toString("utf8"))); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("CLI config is not valid JSON.");
    throw error;
  }
  if (typeof input.expectedPublicKeyDigest !== "string" || !SHA256.test(input.expectedPublicKeyDigest)) {
    throw new Error("A precommitted launch trust-anchor digest is required.");
  }
  if (!['dry-run', 'execute'].includes(input.mode)) throw new Error("Launch mode is invalid.");
  if (input.mode === "execute" && !config.execution) {
    throw new Error("--execute requires an explicit exact execution stanza in the retained config.");
  }
  if (!(input.runtimeBundleBytes instanceof Uint8Array) || !(input.publicKeyBytes instanceof Uint8Array)) {
    throw new Error("Exact runtime and trust-anchor bytes are required.");
  }
  const ready = parseReadyReceipt(input.ready, now, input.expectedPublicKeyDigest);
  const noBrief = parseNoBriefEvidence(input.noBrief, now);
  if (sha256(input.publicKeyBytes) !== input.expectedPublicKeyDigest) {
    throw new Error("Launch trust-anchor bytes differ from the precommitted digest.");
  }
  const expectedAuthorizationDigest = input.mode === "execute"
    ? sha256(canonicalJson(config.execution))
    : null;
  const expectedReleaseLockTokenDigest = input.mode === "execute"
    ? sha256(Buffer.from(config.execution.releaseLockToken, "utf8"))
    : null;
  const configDigest = sha256(input.configBytes);
  const runtimeBinding = ready.committedCode.sourceBindings.find((binding) => binding.role === "runtimeBundle");
  if (!runtimeBinding || runtimeBinding.fileDigest !== sha256(input.runtimeBundleBytes)) {
    throw new Error("Runtime bundle bytes differ from the runtime digest in the signed execution-ready receipt.");
  }
  if (noBrief.freezeDigest !== ready.freezeDigest
      || noBrief.receiptDigest !== ready.noBriefEvidenceDigest) {
    throw new Error("No-brief evidence does not belong to the signed execution-ready receipt.");
  }
  if (input.mode === "execute" && noBrief.releaseLock.tokenDigest !== expectedReleaseLockTokenDigest) {
    throw new Error("The exact release-lock token does not match the retained no-brief lock.");
  }
  if (input.mode === "execute" && (!config.execution
      || config.execution.executionReadyReceiptDigest !== ready.receiptDigest
      || config.execution.spendAuthorizationReceiptDigest !== ready.spendAuthorization.receiptDigest
      || config.execution.authorizationId !== ready.spendAuthorization.authorizationId)) {
    throw new Error("The exact CLI authorization does not match the retained execution-ready receipt.");
  }
  futureTimestamp(envelope.expiresAt, now, "Launch authorization");
  if (Date.parse(envelope.signedAt) > Date.parse(now)
      || Date.parse(envelope.expiresAt) <= Date.parse(envelope.signedAt)
      || Date.parse(envelope.expiresAt) > Date.parse(ready.validUntil)
      || Date.parse(envelope.expiresAt) > Date.parse(ready.spendAuthorization.expiresAt)
      || Date.parse(envelope.expiresAt) > Date.parse(noBrief.releaseLock.expiresAt)) {
    throw new Error("Launch authorization validity interval exceeds its signed evidence.");
  }
  if (envelope.mode !== input.mode
      || envelope.readyReceiptDigest !== ready.receiptDigest
      || envelope.runtimeBundleDigest !== sha256(input.runtimeBundleBytes)
      || envelope.trustAnchorDigest !== input.expectedPublicKeyDigest
      || envelope.cliConfigDigest !== configDigest
      || envelope.noBriefEvidenceDigest !== noBrief.receiptDigest
      || envelope.spendAuthorizationReceiptDigest !== ready.spendAuthorization.receiptDigest
      || envelope.authorizationId !== ready.spendAuthorization.authorizationId
      || envelope.releaseLockTokenDigest !== expectedReleaseLockTokenDigest
      || envelope.exactAuthorizationDigest !== expectedAuthorizationDigest) {
    throw new Error("Launch authorization does not bind this exact ready receipt, no-brief lock, spend authorization, runtime bundle, config, mode, and authorization.");
  }
  let signature;
  try { signature = Buffer.from(envelope.signatureBase64, "base64"); } catch { throw new Error("Launch signature is not valid base64."); }
  let signatureValid = false;
  try {
    signatureValid = verifySignature(null, launchEnvelopeMessage(envelope), createPublicKey(input.publicKeyBytes), signature);
  } catch {
    throw new Error("Launch trust anchor is not a valid public key.");
  }
  if (!signatureValid) {
    throw new Error("Launch authorization signature is invalid for the precommitted trust anchor.");
  }
  return Object.freeze({
    schemaVersion: "exp-0001a-verified-launch-capability/v1",
    envelopeDigest: sha256(canonicalJson(envelope)),
    readyReceiptDigest: envelope.readyReceiptDigest,
    noBriefEvidenceDigest: envelope.noBriefEvidenceDigest,
    spendAuthorizationReceiptDigest: envelope.spendAuthorizationReceiptDigest,
    authorizationId: envelope.authorizationId,
    releaseLockTokenDigest: envelope.releaseLockTokenDigest,
    runtimeBundleDigest: envelope.runtimeBundleDigest,
    cliConfigDigest: configDigest,
    mode: envelope.mode,
    exactAuthorizationDigest: envelope.exactAuthorizationDigest,
  });
}
