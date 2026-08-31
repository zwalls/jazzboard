import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";

import { z } from "zod";

import {
  canonicalJson,
  hashCanonicalJson,
  sha256Digest,
  SHA256_DIGEST_PATTERN,
} from "./provenance-crypto";

const sha256Schema = z.string().regex(SHA256_DIGEST_PATTERN);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40}$/);
const gitFileModeSchema = z.enum(["100644", "100755"]);
const relativePathSchema = z.string().min(1).superRefine((value, context) => {
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    context.addIssue({ code: "custom", message: "Expected a normalized repository-relative path." });
  }
});
const httpsOriginSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    context.addIssue({ code: "custom", message: "Expected a credential-free HTTPS origin." });
  }
});

const gitFileBindingSchema = z.object({
  path: relativePathSchema,
  mode: gitFileModeSchema,
  blobOid: gitObjectSchema,
  fileDigest: sha256Schema,
}).strict();

const sourceRoleSchema = z.string().regex(/^[a-z][A-Za-z0-9]{1,79}$/);
const sourceBindingSchema = gitFileBindingSchema.extend({ role: sourceRoleSchema }).strict();
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const sourceBindingsSchema = z.array(sourceBindingSchema).min(1).superRefine((bindings, context) => {
  const roles = bindings.map((binding) => binding.role);
  const paths = bindings.map((binding) => binding.path);
  if (new Set(roles).size !== roles.length) context.addIssue({ code: "custom", message: "Source roles must be unique." });
  if (new Set(paths).size !== paths.length) context.addIssue({ code: "custom", message: "Source paths must be unique." });
  if (bindings.some((binding, index) => index > 0 && compareCodeUnits(bindings[index - 1].role, binding.role) >= 0)) {
    context.addIssue({ code: "custom", message: "Source bindings must be uniquely sorted by role." });
  }
});

export const exp0001aCommittedCodeReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("exp-0001a-committed-code"),
  protocolId: z.literal("EXP-0001A"),
  freezeDigest: sha256Schema,
  capturedAt: z.string().datetime({ offset: true }),
  gitCommit: gitObjectSchema,
  gitTree: gitObjectSchema,
  prebriefFreeze: gitFileBindingSchema,
  sourceBindings: sourceBindingsSchema,
  receiptDigest: sha256Schema,
}).strict();

export type Exp0001aCommittedCodeReceipt = z.infer<typeof exp0001aCommittedCodeReceiptSchema>;
export type GitFileBinding = z.infer<typeof gitFileBindingSchema>;
export type SourceBinding = z.infer<typeof sourceBindingSchema>;

export const REQUIRED_EXECUTION_CRITICAL_SOURCE_ROLES = Object.freeze([
  "adjudicationOrchestration",
  "analysisRuntime",
  "atomicRegistryStore",
  "attemptMetrics",
  "attemptMetricsRegistry",
  "attemptMetricsSpec",
  "authorRunner",
  "authorSessionIdentityManifest",
  "batchCoordinator",
  "batchCli",
  "batchCommandLibrary",
  "batchRegistryBridge",
  "cleanRoomBatchAdapter",
  "completionAttestation",
  "completionSignerCli",
  "evaluatorRunner",
  "evaluatorSemanticEnvelopeReceipt",
  "executionAuthorityTrustAnchor",
  "experimentFreezeAdapter",
  "executionGate",
  "launchAuthorityVerifier",
  "launchSignerCli",
  "liveReviewRunner",
  "metricsRuntime",
  "packageLock",
  "packageManifest",
  "perAttemptAliasVerifier",
  "pairwisePreference",
  "pairwisePreferenceInstructions",
  "pairwiseRuntime",
  "reportCompiler",
  "runtimeBuilder",
  "runtimeBundle",
  "runtimeComposition",
  "runtimeDependencyReceipt",
  "runtimeDependencyVerifier",
  "scoring",
  "spendLedger",
  "statistics",
] as const);

export const EXP0001A_EXECUTION_CRITICAL_SOURCE_PATHS = Object.freeze({
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
  experimentFreezeAdapter: "src/lib/research/exp0001a-experiment-freeze-adapter.ts",
  executionGate: "src/lib/research/exp0001a-execution-gate.ts",
  launchAuthorityVerifier: "research/scripts/exp0001a-launch-authority.mjs",
  launchSignerCli: "research/scripts/sign-exp0001a-launch.mjs",
  liveReviewRunner: "src/lib/research/exp0001a-live-review-runner.ts",
  metricsRuntime: "src/lib/research/exp0001a-metrics-runtime.ts",
  packageLock: "package-lock.json",
  packageManifest: "package.json",
  perAttemptAliasVerifier: "src/lib/research/exp0001a-per-attempt-alias-verifier.ts",
  pairwisePreference: "src/lib/research/pairwise-visual-preference.ts",
  pairwisePreferenceInstructions: "research/protocols/pairwise-visual-preference-instructions-v1.md",
  pairwiseRuntime: "src/lib/research/exp0001a-pairwise-runtime.ts",
  reportCompiler: "src/lib/research/exp0001a-analysis.ts",
  runtimeBuilder: "research/scripts/build-exp0001a-runtime.mjs",
  runtimeBundle: "research/runtime/exp0001a-runtime.bundle.mjs",
  runtimeComposition: "src/lib/research/exp0001a-runtime-composition.ts",
  runtimeDependencyReceipt: "research/data/exp0001a-runtime-dependencies-v1.json",
  runtimeDependencyVerifier: "research/scripts/exp0001a-runtime-dependencies.mjs",
  scoring: "src/lib/research/scoring.ts",
  spendLedger: "src/lib/research/exp0001a-spend-ledger.ts",
  statistics: "src/lib/research/statistics.ts",
} satisfies Record<typeof REQUIRED_EXECUTION_CRITICAL_SOURCE_ROLES[number], string>);

const frozenSourceProjectionSchema = z.object({
  path: relativePathSchema,
  fileDigest: sha256Schema,
}).passthrough();

const frozenSourcesProjectionSchema = z.record(sourceRoleSchema, frozenSourceProjectionSchema).superRefine((sources, context) => {
  for (const role of REQUIRED_EXECUTION_CRITICAL_SOURCE_ROLES) {
    const source = sources[role];
    if (source === undefined) {
      context.addIssue({ code: "custom", path: [role], message: "Required execution-critical source is absent." });
    } else if (source.path !== EXP0001A_EXECUTION_CRITICAL_SOURCE_PATHS[role]) {
      context.addIssue({
        code: "custom",
        path: [role, "path"],
        message: `Expected the frozen execution-critical path ${EXP0001A_EXECUTION_CRITICAL_SOURCE_PATHS[role]}.`,
      });
    }
  }
  const paths = Object.values(sources).map((source) => source.path);
  if (new Set(paths).size !== paths.length) context.addIssue({ code: "custom", message: "Frozen source paths must be unique." });
  const identityManifestRoot = sources.authorSessionIdentityManifest?.manifestRoot;
  if (!sha256Schema.safeParse(identityManifestRoot).success) {
    context.addIssue({
      code: "custom",
      path: ["authorSessionIdentityManifest", "manifestRoot"],
      message: "The coordinator-issued author identity manifest root must be frozen.",
    });
  }
});

const treatmentProjectionSchema = z.object({
  authorRunnerDigest: sha256Schema,
  participantContractDigest: sha256Schema,
  spectatorContractDigest: sha256Schema,
  model: z.object({
    id: z.literal("gpt-5.6-sol"),
    reasoningEffort: z.literal("max"),
    serviceTier: z.literal("default"),
  }).strict(),
}).passthrough();

const executionHostProjectionSchema = z.object({
  status: z.literal("recorded-covariate-requires-fresh-attestation"),
  nodeVersion: z.literal("22.22.0"),
  platform: z.literal("darwin"),
  architecture: z.literal("arm64"),
  operatingSystem: z.object({
    name: z.literal("macOS"),
    version: z.literal("26.6.2"),
    build: z.literal("25G83"),
  }).strict(),
  browser: z.object({
    product: z.literal("Google Chrome for Testing"),
    version: z.literal("151.0.7922.34"),
    playwrightVersion: z.literal("1.62.1"),
  }).strict(),
  dependencyResolution: z.object({
    layout: z.literal("npm-package-lock"),
    lockfileVersion: z.literal(3),
    packageManifestDigest: sha256Schema,
    packageLockDigest: sha256Schema,
  }).strict(),
  runtimeDependencies: z.object({
    receiptPath: z.literal("research/data/exp0001a-runtime-dependencies-v1.json"),
    receiptDigest: sha256Schema,
    componentSetRoot: sha256Schema,
    captureVerificationDurationMs: z.number().int().nonnegative(),
    absolutePathsPublished: z.literal(false),
    fullTreeVerification: z.literal("two-identical-captures-before-runtime-import"),
    criticalVerification: z.literal("two-identical-captures-before-each-attempt-before-browser-or-brief"),
  }).strict(),
}).strict();

const runtimeDependencyReceiptProjectionSchema = z.object({
  schemaVersion: z.literal("exp-0001a-runtime-dependencies/v1"),
  protocolId: z.literal("EXP-0001A"),
  capturedAt: z.string().datetime({ offset: true }),
  captureVerificationDurationMs: z.number().int().nonnegative(),
  policy: z.object({
    absolutePathsPublished: z.literal(false),
    fullTreeVerification: z.literal("two-identical-captures-before-runtime-import"),
    criticalVerification: z.literal("two-identical-captures-before-each-attempt-before-browser-or-brief"),
  }).passthrough(),
  components: z.array(z.object({
    id: z.string().min(1),
    treeRoot: sha256Schema,
    criticalRoot: sha256Schema,
  }).passthrough()).length(9),
  componentSetRoot: sha256Schema,
  receiptDigest: sha256Schema,
}).passthrough();

const evaluatorSemanticEnvelopeReceiptProjectionSchema = z.object({
  schemaVersion: z.literal("exp-0001a-evaluator-semantic-envelope/v1"),
  pilotTaskBasis: z.object({
    benchmarkSource: z.object({
      path: z.literal("research/benchmarks/development-v1.json"),
      fileDigest: sha256Schema,
    }).strict(),
    rubricSource: z.object({
      path: z.literal("research/benchmarks/development-evaluator-rubrics-v1.json"),
      fileDigest: sha256Schema,
    }).strict(),
  }).passthrough(),
  envelopeDigest: sha256Schema,
}).passthrough();

export const exp0001aBlockedPrebriefFreezeGateSchema = z.object({
  schemaVersion: z.literal(1),
  freezeId: z.string().min(1),
  protocolId: z.literal("EXP-0001A"),
  status: z.literal("blocked_pending_prerequisites"),
  frozenAt: z.string().datetime({ offset: true }),
  executionStateAtFreeze: z.literal("not_started"),
  briefReleaseAuthorized: z.literal(false),
  baseline: z.object({
    gitCommit: gitObjectSchema,
    gitTree: gitObjectSchema,
    deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
    buildId: z.string().regex(/^bld_[A-Za-z0-9]+$/),
    immutableUrl: httpsOriginSchema,
    productionUrl: httpsOriginSchema,
  }).passthrough(),
  executionHost: executionHostProjectionSchema,
  frozenSources: frozenSourcesProjectionSchema,
  conditions: z.object({
    A0: treatmentProjectionSchema,
    A1: treatmentProjectionSchema,
    configurationDigest: sha256Schema,
  }).passthrough(),
  budgetRationale: z.object({
    briefsDeliveredBeforeFreeze: z.literal(0),
  }).passthrough(),
  providerModelIdentityPolicy: z.object({
    requestedModelIdFrozen: z.literal(true),
    immutableWeightSnapshotAsserted: z.literal(false),
    responseModelRetainedAndDriftChecked: z.literal(true),
    serviceTierRetainedAndDriftChecked: z.literal(true),
    rollingProviderRiskMitigation: z.literal("aa-interleaving-paired-order-balance-and-time-block-diagnostics"),
    confirmatoryPreference: z.literal("use-an-immutable-dated-weight-snapshot-when-the-provider-exposes-one"),
  }).strict(),
  deploymentContinuityPolicy: z.object({
    executionOrigin: httpsOriginSchema,
    frozenDeploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
    verifierSourceRole: z.literal("perAttemptAliasVerifier"),
    verificationTiming: z.literal("authenticated-vercel-api-immediately-before-each-brief"),
    requiredReceiptCountAtCompletion: z.literal(48),
    receiptsHashChainedInBatchRegistry: z.literal(true),
    driftDisposition: z.literal("not_started-hard-stop-before-brief"),
    immutableDeploymentAlternative: z.literal("protected-immutable-url-requires-authenticated-bypass"),
  }).strict(),
  pricingProvenance: z.object({
    serviceTier: z.literal("default"),
    modelDocumentationUrl: z.literal("https://developers.openai.com/api/docs/models/gpt-5.6-sol"),
    fastModeGuideUrl: z.literal("https://developers.openai.com/api/docs/guides/fast-mode"),
    capturedOn: z.literal("2026-08-30"),
    promotionalPricingValidAtLeastThrough: z.literal("2026-11-21"),
    revalidationRequiredBefore: z.literal("2026-11-22T00:00:00.000Z"),
  }).strict(),
  reviewerPlan: z.object({
    serviceTier: z.literal("default"),
    pairwisePreference: z.object({ serviceTier: z.literal("default") }).passthrough(),
  }).passthrough(),
  costProjection: z.object({
    expectedPairwisePreferences24Usd: z.literal(1.675392),
    expectedTotalUsd: z.literal(36.1659664),
    sensitivityOnePointFiveXTotalUsd: z.literal(54.2489496),
    configuredCapPairwisePreferences24Usd: z.literal(11.04),
    configuredCapTotalUsd: z.literal(487.2),
    preProviderCumulativeInputHardCapEnforced: z.literal(true),
  }).passthrough(),
  pendingPrerequisites: z.record(sourceRoleSchema, z.object({
    path: relativePathSchema.optional(),
    candidateObservedDigest: sha256Schema.optional(),
  }).passthrough()),
  executionGate: z.object({ executable: z.literal(false) }).passthrough(),
  sensitiveMaterialRedacted: z.literal(true),
  freezeDigest: sha256Schema,
}).passthrough();

export type BlockedPrebriefFreeze = z.infer<typeof exp0001aBlockedPrebriefFreezeGateSchema>;

const liveContractReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("public-production-webmcp-contract-verification"),
  capturedAt: z.string().datetime({ offset: true }),
  baseline: z.object({
    gitCommit: gitObjectSchema,
    gitTree: gitObjectSchema,
    deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
    buildId: z.string().regex(/^bld_[A-Za-z0-9]+$/),
    immutableDeploymentUrl: httpsOriginSchema,
    executionUrl: httpsOriginSchema,
    executionUrlVerifiedDeploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
    aliasPreflight: z.literal("authenticated_vercel_cli_immediately_before_contract"),
    immutableUrlAccess: z.literal("deployment_protection_requires_authenticated_bypass"),
  }).passthrough(),
  runner: z.object({
    mode: z.literal("contract"),
    status: z.literal("contract_verified"),
    scriptDigest: sha256Schema,
    responsesApiInvoked: z.literal(false),
    authorContextClosedBeforeEvaluation: z.literal(true),
  }).passthrough(),
  participant: z.object({
    toolCount: z.number().int().positive(),
    contractDigest: sha256Schema,
  }).passthrough(),
  spectator: z.object({
    toolCount: z.number().int().positive(),
    contractDigest: sha256Schema,
  }).passthrough(),
  privacy: z.object({
    roomIdentifiersPersisted: z.literal(false),
    sessionCredentialsPersisted: z.literal(false),
    apiCredentialsPersisted: z.literal(false),
    responsesApiInvoked: z.literal(false),
  }).passthrough(),
}).passthrough();

export const exp0001aFreshLiveContractEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("exp-0001a-fresh-live-contract"),
  protocolId: z.literal("EXP-0001A"),
  freezeDigest: sha256Schema,
  receipt: liveContractReceiptSchema,
  receiptDigest: sha256Schema,
  gitCommit: gitObjectSchema,
  gitTree: gitObjectSchema,
  receiptFile: gitFileBindingSchema,
  envelopeDigest: sha256Schema,
}).strict();

export type Exp0001aFreshLiveContractEnvelope = z.infer<typeof exp0001aFreshLiveContractEnvelopeSchema>;

export const exp0001aAliasPreflightSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("exp-0001a-alias-preflight"),
  protocolId: z.literal("EXP-0001A"),
  freezeDigest: sha256Schema,
  observedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  method: z.literal("authenticated-vercel-cli"),
  productionUrl: httpsOriginSchema,
  resolvedDeploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
  resolvedBuildId: z.string().regex(/^bld_[A-Za-z0-9]+$/),
  resolvedImmutableUrl: httpsOriginSchema,
  resolvedState: z.literal("READY"),
  receiptDigest: sha256Schema,
}).strict();

export type Exp0001aAliasPreflight = z.infer<typeof exp0001aAliasPreflightSchema>;

export const exp0001aNoBriefEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("exp-0001a-no-brief-evidence"),
  protocolId: z.literal("EXP-0001A"),
  freezeDigest: sha256Schema,
  observedAt: z.string().datetime({ offset: true }),
  briefsDelivered: z.literal(0),
  begunAttempts: z.literal(0),
  registryDigest: sha256Schema,
  registryFileDigest: sha256Schema,
  releaseLock: z.object({
    held: z.literal(true),
    tokenDigest: sha256Schema,
    expiresAt: z.string().datetime({ offset: true }),
  }).strict(),
  receiptDigest: sha256Schema,
}).strict();

export type Exp0001aNoBriefEvidence = z.infer<typeof exp0001aNoBriefEvidenceSchema>;

export const exp0001aSpendAuthorizationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("exp-0001a-explicit-spend-authorization"),
  protocolId: z.literal("EXP-0001A"),
  freezeDigest: sha256Schema,
  authorizationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
  authorizedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  authorizedBy: z.object({
    kind: z.literal("user"),
    principal: z.string().min(1).max(200),
  }).strict(),
  authorizationMethod: z.literal("explicit-user-confirmation"),
  authorizationEvidenceDigest: sha256Schema,
  currency: z.literal("USD"),
  maximumUsd: z.number().finite().positive(),
  scope: z.object({
    attempts: z.literal(48),
    primaryReviews: z.literal(96),
    maximumAdjudications: z.literal(48),
    pairwisePreferences: z.literal(24),
  }).strict(),
  receiptDigest: sha256Schema,
}).strict();

export type Exp0001aSpendAuthorization = z.infer<typeof exp0001aSpendAuthorizationSchema>;

export const exp0001aExecutionHostAttestationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("exp-0001a-execution-host-attestation"),
  protocolId: z.literal("EXP-0001A"),
  freezeDigest: sha256Schema,
  capturedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  host: executionHostProjectionSchema.omit({ status: true }),
  receiptDigest: sha256Schema,
}).strict();

export type Exp0001aExecutionHostAttestation = z.infer<typeof exp0001aExecutionHostAttestationSchema>;

const sourceDigestSummarySchema = z.object({
  role: sourceRoleSchema,
  path: relativePathSchema,
  mode: gitFileModeSchema,
  fileDigest: sha256Schema,
  blobOid: gitObjectSchema,
}).strict();

const executionReadyContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("exp-0001a-execution-ready"),
  protocolId: z.literal("EXP-0001A"),
  createdAt: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }),
  freezeDigest: sha256Schema,
  baseline: z.object({
    gitCommit: gitObjectSchema,
    gitTree: gitObjectSchema,
    deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
    buildId: z.string().regex(/^bld_[A-Za-z0-9]+$/),
    immutableUrl: httpsOriginSchema,
    productionUrl: httpsOriginSchema,
  }).strict(),
  conditionsDigest: sha256Schema,
  committedCode: z.object({
    receiptDigest: sha256Schema,
    gitCommit: gitObjectSchema,
    gitTree: gitObjectSchema,
    authorSessionIdentityManifestRoot: sha256Schema,
    sourceBindings: z.array(sourceDigestSummarySchema).min(1),
  }).strict(),
  liveContract: z.object({
    envelopeDigest: sha256Schema,
    receiptDigest: sha256Schema,
    gitCommit: gitObjectSchema,
    gitTree: gitObjectSchema,
    capturedAt: z.string().datetime({ offset: true }),
    participantContractDigest: sha256Schema,
    spectatorContractDigest: sha256Schema,
  }).strict(),
  aliasPreflightDigest: sha256Schema,
  deploymentContinuity: z.object({
    verifierSourceRole: z.literal("perAttemptAliasVerifier"),
    verifierSourceDigest: sha256Schema,
    verificationTiming: z.literal("authenticated-vercel-api-immediately-before-each-brief"),
    requiredReceiptCountAtCompletion: z.literal(48),
    receiptsHashChainedInBatchRegistry: z.literal(true),
    driftDisposition: z.literal("not_started-hard-stop-before-brief"),
  }).strict(),
  noBriefEvidenceDigest: sha256Schema,
  executionHost: z.object({
    attestationDigest: sha256Schema,
    capturedAt: z.string().datetime({ offset: true }),
    nodeVersion: z.literal("22.22.0"),
    platform: z.literal("darwin"),
    architecture: z.literal("arm64"),
    operatingSystemBuild: z.literal("25G83"),
    packageManifestDigest: sha256Schema,
    packageLockDigest: sha256Schema,
    runtimeDependencyReceiptDigest: sha256Schema,
    runtimeDependencyComponentSetRoot: sha256Schema,
    runtimeDependencyReceiptCaptureVerificationDurationMs: z.number().int().nonnegative(),
  }).strict(),
  attestationPolicyDigest: sha256Schema,
  spendAuthorization: z.object({
    receiptDigest: sha256Schema,
    authorizationId: z.string().min(1),
    maximumUsd: z.number().finite().positive(),
    frozenCapTotalUsd: z.literal(487.2),
    scope: z.object({
      attempts: z.literal(48),
      primaryReviews: z.literal(96),
      maximumAdjudications: z.literal(48),
      pairwisePreferences: z.literal(24),
    }).strict(),
    expiresAt: z.string().datetime({ offset: true }),
    pricingRevalidationRequiredBefore: z.literal("2026-11-22T00:00:00.000Z"),
  }).strict(),
  assertions: z.object({
    blockedFreezeVerified: z.literal(true),
    currentBytesEqualCommittedBytes: z.literal(true),
    gitCommitAndTreeVerified: z.literal(true),
    liveReceiptCommittedAfterFreeze: z.literal(true),
    baselineDeploymentExact: z.literal(true),
    aliasExecutionScientificallyBoundToProtectedImmutableBaseline: z.literal(true),
    perAttemptDeploymentVerificationRequiredBeforeBrief: z.literal(true),
    contractsExact: z.literal(true),
    executionHostExact: z.literal(true),
    noBriefsDeliveredUnderExclusiveLock: z.literal(true),
    spendExplicitAndUnexpired: z.literal(true),
    spendAuthorizationWithinFrozenProtocolCeiling: z.literal(true),
    spendAuthorizationExpiresBeforePricingRevalidation: z.literal(true),
    preProviderCumulativeInputHardCapVerified: z.literal(true),
    aaConditionsIdentical: z.literal(true),
  }).strict(),
}).strict();

export const exp0001aExecutionReadyReceiptSchema = executionReadyContentSchema.extend({
  receiptDigest: sha256Schema,
}).strict();

export type Exp0001aExecutionReadyReceipt = z.infer<typeof exp0001aExecutionReadyReceiptSchema>;

export type GitCommitEvidence = {
  objectType: "commit";
  tree: string;
};

export type GitFileEvidence = {
  objectType: "blob";
  mode: "100644" | "100755";
  blobOid: string;
  bytes: Uint8Array;
};

/**
 * A trusted implementation must resolve objects from the repository itself;
 * accepting caller-declared booleans would not prove that an object exists.
 */
export type GitObjectReader = {
  readCommit(commit: string): Promise<GitCommitEvidence>;
  readFileAtCommit(commit: string, path: string): Promise<GitFileEvidence>;
  isAncestor(ancestorCommit: string, descendantCommit: string): Promise<boolean>;
};

/**
 * Dynamic operational receipts are not made authentic by a self-hash. The
 * caller must provide a separately trusted verifier (for example, a pinned
 * signature policy or a local approval/lock service) and bind that policy in
 * the ready receipt.
 */
export type ExecutionGateAttestationVerifier = {
  policyDigest: string;
  verifyAuthoritativePrebriefFreeze(freeze: BlockedPrebriefFreeze, freezeFileBytes: string | Uint8Array): Promise<boolean>;
  verifyAliasPreflight(preflight: Exp0001aAliasPreflight): Promise<boolean>;
  verifyNoBriefEvidence(evidence: Exp0001aNoBriefEvidence, registryFileBytes: string | Uint8Array): Promise<boolean>;
  verifySpendAuthorization(authorization: Exp0001aSpendAuthorization): Promise<boolean>;
  verifyExecutionHostAttestation(attestation: Exp0001aExecutionHostAttestation): Promise<boolean>;
};

export type Exp0001aExecutionGateInput = {
  now: string;
  prebriefFreeze: unknown;
  prebriefFreezeFileBytes: string | Uint8Array;
  committedCodeReceipt: unknown;
  currentCodeFileBytes: Readonly<Record<string, string | Uint8Array>>;
  freshLiveContractEnvelope: unknown;
  freshLiveContractFileBytes: string | Uint8Array;
  aliasPreflight: unknown;
  noBriefEvidence: unknown;
  registryFileBytes: string | Uint8Array;
  spendAuthorization?: unknown;
  executionHostAttestation?: unknown;
  git: GitObjectReader;
  attestations?: ExecutionGateAttestationVerifier;
};

export type Exp0001aExecutionGateResult =
  | { ok: true; receipt: Exp0001aExecutionReadyReceipt }
  | { ok: false; errors: string[] };

type ErrorCollector = {
  errors: string[];
  add(code: string): void;
  equal(actual: unknown, expected: unknown, code: string): void;
};

function collector(): ErrorCollector {
  const errors: string[] = [];
  return {
    errors,
    add(code) {
      if (!errors.includes(code)) errors.push(code);
    },
    equal(actual, expected, code) {
      if (actual !== expected && !errors.includes(code)) errors.push(code);
    },
  };
}

function sourceSummaries(bindings: readonly SourceBinding[]): z.infer<typeof sourceDigestSummarySchema>[] {
  return bindings.map(({ role, path, mode, fileDigest, blobOid }) => ({ role, path, mode, fileDigest, blobOid }));
}

function omitKey<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key));
}

function computeSelfDigest(value: Record<string, unknown>, key: string): string {
  return hashCanonicalJson(omitKey(value, key));
}

export function computeCommittedCodeReceiptDigest(receipt: Exp0001aCommittedCodeReceipt): string {
  return computeSelfDigest(receipt, "receiptDigest");
}

export function computeFreshLiveContractEnvelopeDigest(envelope: Exp0001aFreshLiveContractEnvelope): string {
  return computeSelfDigest(envelope, "envelopeDigest");
}

export function computeAliasPreflightDigest(preflight: Exp0001aAliasPreflight): string {
  return computeSelfDigest(preflight, "receiptDigest");
}

export function computeNoBriefEvidenceDigest(evidence: Exp0001aNoBriefEvidence): string {
  return computeSelfDigest(evidence, "receiptDigest");
}

export function computeSpendAuthorizationDigest(authorization: Exp0001aSpendAuthorization): string {
  return computeSelfDigest(authorization, "receiptDigest");
}

export function computeExecutionHostAttestationDigest(attestation: Exp0001aExecutionHostAttestation): string {
  return computeSelfDigest(attestation, "receiptDigest");
}

export function computeExecutionReadyReceiptDigest(receipt: Exp0001aExecutionReadyReceipt): string {
  return computeSelfDigest(receipt, "receiptDigest");
}

export type BlockedPrebriefGateVerification =
  | { ok: true; freeze: BlockedPrebriefFreeze }
  | { ok: false; errors: string[] };

/** Gate-specific compatibility check; the full prebrief verifier remains authoritative for the study freeze. */
export function verifyBlockedPrebriefFreezeForExecutionGate(input: unknown): BlockedPrebriefGateVerification {
  const parsed = exp0001aBlockedPrebriefFreezeGateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: schemaErrors("PREBRIEF_FREEZE", parsed.error) };
  const freeze = parsed.data;
  const errors: string[] = [];
  if (computeSelfDigest(freeze as Record<string, unknown>, "freezeDigest") !== freeze.freezeDigest) {
    errors.push("PREBRIEF_FREEZE_DIGEST_MISMATCH");
  }
  if (canonicalJson(freeze.conditions.A0) !== canonicalJson(freeze.conditions.A1)) errors.push("AA_CONDITIONS_NOT_IDENTICAL");
  if (hashCanonicalJson(freeze.conditions.A0) !== freeze.conditions.configurationDigest) errors.push("AA_CONDITIONS_DIGEST_MISMATCH");
  for (const [role, pending] of Object.entries(freeze.pendingPrerequisites)) {
    if (role === "freshLiveReceipt" || pending.path === undefined) continue;
    const source = freeze.frozenSources[role];
    if (source === undefined) {
      errors.push(`PENDING_SOURCE_${role}_NOT_FROZEN`);
      continue;
    }
    if (pending.path !== source.path) errors.push(`PENDING_SOURCE_${role}_PATH_MISMATCH`);
    if (pending.candidateObservedDigest !== undefined && pending.candidateObservedDigest !== source.fileDigest) {
      errors.push(`PENDING_SOURCE_${role}_DIGEST_MISMATCH`);
    }
  }
  return errors.length === 0 ? { ok: true, freeze } : { ok: false, errors };
}

function schemaErrors(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => `${prefix}_SCHEMA:${issue.path.join("/")}:${issue.message}`);
}

function parseJsonBytes(bytes: string | Uint8Array, code: string, errors: ErrorCollector): unknown | null {
  try {
    const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    errors.add(code);
    return null;
  }
}

function dateMs(value: string): number {
  return new Date(value).getTime();
}

function originOf(value: string): string {
  return new URL(value).origin;
}

async function verifyGitBinding(
  binding: GitFileBinding,
  commit: string,
  reader: GitObjectReader,
  currentBytes: string | Uint8Array | undefined,
  errors: ErrorCollector,
  prefix: string,
): Promise<void> {
  if (currentBytes === undefined) {
    errors.add(`${prefix}_CURRENT_BYTES_MISSING`);
  } else {
    errors.equal(sha256Digest(currentBytes), binding.fileDigest, `${prefix}_CURRENT_DIGEST_MISMATCH`);
  }
  try {
    const evidence = await reader.readFileAtCommit(commit, binding.path);
    errors.equal(evidence.objectType, "blob", `${prefix}_NOT_GIT_BLOB`);
    errors.equal(evidence.mode, binding.mode, `${prefix}_GIT_MODE_MISMATCH`);
    errors.equal(evidence.blobOid, binding.blobOid, `${prefix}_GIT_BLOB_OID_MISMATCH`);
    errors.equal(sha256Digest(evidence.bytes), binding.fileDigest, `${prefix}_COMMITTED_DIGEST_MISMATCH`);
  } catch {
    errors.add(`${prefix}_GIT_FILE_UNRESOLVED`);
  }
}

async function verifyGitCommit(
  commit: string,
  expectedTree: string,
  reader: GitObjectReader,
  errors: ErrorCollector,
  prefix: string,
): Promise<void> {
  try {
    const evidence = await reader.readCommit(commit);
    errors.equal(evidence.objectType, "commit", `${prefix}_NOT_GIT_COMMIT`);
    errors.equal(evidence.tree, expectedTree, `${prefix}_GIT_TREE_MISMATCH`);
  } catch {
    errors.add(`${prefix}_GIT_COMMIT_UNRESOLVED`);
  }
}

function checkParsedSelfDigest<T extends Record<string, unknown>>(
  value: T,
  digestKey: keyof T & string,
  compute: (input: never) => string,
  errors: ErrorCollector,
  code: string,
): void {
  errors.equal(compute(value as never), value[digestKey], code);
}

export async function evaluateExp0001aExecutionGate(
  input: Exp0001aExecutionGateInput,
): Promise<Exp0001aExecutionGateResult> {
  const errors = collector();
  const nowResult = z.string().datetime({ offset: true }).safeParse(input.now);
  if (!nowResult.success) errors.add("NOW_INVALID");

  const freezeResult = exp0001aBlockedPrebriefFreezeGateSchema.safeParse(input.prebriefFreeze);
  const codeResult = exp0001aCommittedCodeReceiptSchema.safeParse(input.committedCodeReceipt);
  const liveResult = exp0001aFreshLiveContractEnvelopeSchema.safeParse(input.freshLiveContractEnvelope);
  const aliasResult = exp0001aAliasPreflightSchema.safeParse(input.aliasPreflight);
  const noBriefResult = exp0001aNoBriefEvidenceSchema.safeParse(input.noBriefEvidence);
  const spendResult = input.spendAuthorization === undefined
    ? null
    : exp0001aSpendAuthorizationSchema.safeParse(input.spendAuthorization);
  const executionHostResult = input.executionHostAttestation === undefined
    ? null
    : exp0001aExecutionHostAttestationSchema.safeParse(input.executionHostAttestation);
  const attestationPolicyResult = sha256Schema.safeParse(input.attestations?.policyDigest);

  if (!freezeResult.success) errors.errors.push(...schemaErrors("PREBRIEF_FREEZE", freezeResult.error));
  if (!codeResult.success) errors.errors.push(...schemaErrors("COMMITTED_CODE", codeResult.error));
  if (!liveResult.success) errors.errors.push(...schemaErrors("LIVE_CONTRACT", liveResult.error));
  if (!aliasResult.success) errors.errors.push(...schemaErrors("ALIAS_PREFLIGHT", aliasResult.error));
  if (!noBriefResult.success) errors.errors.push(...schemaErrors("NO_BRIEF", noBriefResult.error));
  if (spendResult === null) errors.add("SPEND_AUTHORIZATION_MISSING");
  else if (!spendResult.success) errors.errors.push(...schemaErrors("SPEND_AUTHORIZATION", spendResult.error));
  if (executionHostResult === null) errors.add("EXECUTION_HOST_ATTESTATION_MISSING");
  else if (!executionHostResult.success) errors.errors.push(...schemaErrors("EXECUTION_HOST_ATTESTATION", executionHostResult.error));
  if (input.attestations === undefined) errors.add("ATTESTATION_VERIFIER_MISSING");
  else if (!attestationPolicyResult.success) errors.add("ATTESTATION_POLICY_DIGEST_INVALID");

  if (!freezeResult.success || !codeResult.success || !liveResult.success || !aliasResult.success || !noBriefResult.success
      || spendResult === null || !spendResult.success || executionHostResult === null || !executionHostResult.success
      || !nowResult.success || input.attestations === undefined
      || !attestationPolicyResult.success) {
    return { ok: false, errors: errors.errors };
  }

  const freeze = freezeResult.data;
  const code = codeResult.data;
  const live = liveResult.data;
  const alias = aliasResult.data;
  const noBrief = noBriefResult.data;
  const spend = spendResult.data;
  const executionHost = executionHostResult.data;
  const nowMs = dateMs(nowResult.data);
  const frozenAtMs = dateMs(freeze.frozenAt);
  const liveCapturedAtMs = dateMs(live.receipt.capturedAt);
  const authorSessionIdentityManifestRoot = sha256Schema.parse(
    freeze.frozenSources.authorSessionIdentityManifest.manifestRoot,
  );

  const canonicalFreezeDigest = computeSelfDigest(freeze as Record<string, unknown>, "freezeDigest");
  errors.equal(canonicalFreezeDigest, freeze.freezeDigest, "PREBRIEF_FREEZE_DIGEST_MISMATCH");
  const parsedFreezeBytes = parseJsonBytes(input.prebriefFreezeFileBytes, "PREBRIEF_FREEZE_BYTES_INVALID_JSON", errors);
  if (parsedFreezeBytes !== null) {
    errors.equal(canonicalJson(parsedFreezeBytes), canonicalJson(freeze), "PREBRIEF_FREEZE_BYTES_VALUE_MISMATCH");
  }

  errors.equal(canonicalJson(freeze.conditions.A0), canonicalJson(freeze.conditions.A1), "AA_CONDITIONS_NOT_IDENTICAL");
  errors.equal(hashCanonicalJson(freeze.conditions.A0), freeze.conditions.configurationDigest, "AA_CONDITIONS_DIGEST_MISMATCH");

  checkParsedSelfDigest(code, "receiptDigest", computeCommittedCodeReceiptDigest, errors, "COMMITTED_CODE_RECEIPT_DIGEST_MISMATCH");
  errors.equal(code.freezeDigest, freeze.freezeDigest, "COMMITTED_CODE_FREEZE_MISMATCH");
  if (dateMs(code.capturedAt) < frozenAtMs) errors.add("COMMITTED_CODE_PREDATES_FREEZE");
  errors.equal(code.prebriefFreeze.fileDigest, sha256Digest(input.prebriefFreezeFileBytes), "PREBRIEF_FREEZE_FILE_DIGEST_MISMATCH");
  const frozenSourceEntries = Object.entries(freeze.frozenSources)
    .map(([role, source]) => ({ role, path: source.path, fileDigest: source.fileDigest }))
    .sort((left, right) => compareCodeUnits(left.role, right.role));
  const declaredSourceEntries = code.sourceBindings
    .map(({ role, path, fileDigest }) => ({ role, path, fileDigest }));
  errors.equal(canonicalJson(declaredSourceEntries), canonicalJson(frozenSourceEntries), "COMMITTED_CODE_SOURCE_CATALOG_MISMATCH");
  const authorRunner = code.sourceBindings.find((binding) => binding.role === "authorRunner");
  const executionAuthorityTrustAnchor = code.sourceBindings.find((binding) => binding.role === "executionAuthorityTrustAnchor");
  const perAttemptAliasVerifier = code.sourceBindings.find((binding) => binding.role === "perAttemptAliasVerifier");
  const perAttemptAliasVerifierDigest = perAttemptAliasVerifier?.fileDigest;
  errors.equal(authorRunner?.fileDigest, freeze.conditions.A0.authorRunnerDigest, "AUTHOR_RUNNER_FREEZE_DIGEST_MISMATCH");
  errors.equal(
    freeze.deploymentContinuityPolicy.frozenDeploymentId,
    freeze.baseline.deploymentId,
    "DEPLOYMENT_CONTINUITY_BASELINE_MISMATCH",
  );
  errors.equal(
    originOf(freeze.deploymentContinuityPolicy.executionOrigin),
    originOf(freeze.baseline.productionUrl),
    "DEPLOYMENT_CONTINUITY_ORIGIN_MISMATCH",
  );
  if (perAttemptAliasVerifier === undefined) errors.add("PER_ATTEMPT_ALIAS_VERIFIER_BINDING_MISSING");
  errors.equal(
    attestationPolicyResult.data,
    executionAuthorityTrustAnchor?.fileDigest,
    "ATTESTATION_POLICY_NOT_FROZEN_TRUST_ANCHOR",
  );
  for (const [role, pending] of Object.entries(freeze.pendingPrerequisites)) {
    if (role === "freshLiveReceipt" || pending.path === undefined) continue;
    const frozen = freeze.frozenSources[role];
    if (frozen === undefined) {
      errors.add(`PENDING_SOURCE_${role}_NOT_FROZEN`);
      continue;
    }
    errors.equal(pending.path, frozen.path, `PENDING_SOURCE_${role}_PATH_MISMATCH`);
    if (pending.candidateObservedDigest !== undefined) {
      errors.equal(pending.candidateObservedDigest, frozen.fileDigest, `PENDING_SOURCE_${role}_DIGEST_MISMATCH`);
    }
  }

  await verifyGitCommit(code.gitCommit, code.gitTree, input.git, errors, "COMMITTED_CODE");
  await verifyGitBinding(code.prebriefFreeze, code.gitCommit, input.git, input.prebriefFreezeFileBytes, errors, "PREBRIEF_FREEZE");
  const sourceBindings = code.sourceBindings;
  const expectedCurrentPaths = sourceBindings.map((binding) => binding.path).sort();
  const suppliedCurrentPaths = Object.keys(input.currentCodeFileBytes).sort();
  errors.equal(canonicalJson(suppliedCurrentPaths), canonicalJson(expectedCurrentPaths), "CURRENT_CODE_FILE_SET_MISMATCH");
  await Promise.all(sourceBindings.map((binding, index) => verifyGitBinding(
    binding,
    code.gitCommit,
    input.git,
    input.currentCodeFileBytes[binding.path],
    errors,
    `SOURCE_${index}`,
  )));
  const runtimeDependencyBinding = sourceBindings.find((binding) => binding.role === "runtimeDependencyReceipt");
  if (runtimeDependencyBinding === undefined) {
    errors.add("RUNTIME_DEPENDENCY_RECEIPT_BINDING_MISSING");
  } else {
    const dependencyBytes = input.currentCodeFileBytes[runtimeDependencyBinding.path];
    if (dependencyBytes === undefined) {
      errors.add("RUNTIME_DEPENDENCY_RECEIPT_BYTES_MISSING");
    } else {
      const dependencyValue = parseJsonBytes(
        dependencyBytes,
        "RUNTIME_DEPENDENCY_RECEIPT_BYTES_INVALID_JSON",
        errors,
      );
      if (dependencyValue !== null) {
        const dependencyResult = runtimeDependencyReceiptProjectionSchema.safeParse(dependencyValue);
        if (!dependencyResult.success) {
          errors.errors.push(...schemaErrors("RUNTIME_DEPENDENCY_RECEIPT", dependencyResult.error));
        } else {
          const dependencyReceipt = dependencyResult.data;
          errors.equal(
            canonicalJson(dependencyReceipt.components.map((component) => component.id)),
            canonicalJson([
              "chromiumRuntime", "detectLibcPackage", "nodeExecutable", "playwrightCorePackage",
              "playwrightPackage", "sharpColourPackage", "sharpLibvipsPackage",
              "sharpNativePackage", "sharpPackage",
            ]),
            "RUNTIME_DEPENDENCY_COMPONENT_DENOMINATOR_MISMATCH",
          );
          errors.equal(
            hashCanonicalJson(dependencyReceipt.components),
            dependencyReceipt.componentSetRoot,
            "RUNTIME_DEPENDENCY_COMPONENT_SET_ROOT_MISMATCH",
          );
          errors.equal(
            computeSelfDigest(dependencyReceipt as Record<string, unknown>, "receiptDigest"),
            dependencyReceipt.receiptDigest,
            "RUNTIME_DEPENDENCY_RECEIPT_DIGEST_MISMATCH",
          );
          errors.equal(
            dependencyReceipt.receiptDigest,
            freeze.executionHost.runtimeDependencies.receiptDigest,
            "RUNTIME_DEPENDENCY_RECEIPT_NOT_FROZEN",
          );
          errors.equal(
            dependencyReceipt.componentSetRoot,
            freeze.executionHost.runtimeDependencies.componentSetRoot,
            "RUNTIME_DEPENDENCY_COMPONENT_SET_NOT_FROZEN",
          );
          errors.equal(
            dependencyReceipt.captureVerificationDurationMs,
            freeze.executionHost.runtimeDependencies.captureVerificationDurationMs,
            "RUNTIME_DEPENDENCY_CAPTURE_DURATION_NOT_FROZEN",
          );
        }
      }
    }
  }
  const evaluatorEnvelopeBinding = sourceBindings.find(
    (binding) => binding.role === "evaluatorSemanticEnvelopeReceipt",
  );
  if (evaluatorEnvelopeBinding === undefined) {
    errors.add("EVALUATOR_SEMANTIC_ENVELOPE_BINDING_MISSING");
  } else {
    const envelopeBytes = input.currentCodeFileBytes[evaluatorEnvelopeBinding.path];
    if (envelopeBytes === undefined) {
      errors.add("EVALUATOR_SEMANTIC_ENVELOPE_BYTES_MISSING");
    } else {
      const envelopeValue = parseJsonBytes(
        envelopeBytes,
        "EVALUATOR_SEMANTIC_ENVELOPE_BYTES_INVALID_JSON",
        errors,
      );
      if (envelopeValue !== null) {
        const envelopeResult = evaluatorSemanticEnvelopeReceiptProjectionSchema.safeParse(envelopeValue);
        if (!envelopeResult.success) {
          errors.errors.push(...schemaErrors("EVALUATOR_SEMANTIC_ENVELOPE", envelopeResult.error));
        } else {
          const envelope = envelopeResult.data;
          errors.equal(
            computeSelfDigest(envelope as Record<string, unknown>, "envelopeDigest"),
            envelope.envelopeDigest,
            "EVALUATOR_SEMANTIC_ENVELOPE_DIGEST_MISMATCH",
          );
          for (const [role, source] of [
            ["benchmark", envelope.pilotTaskBasis.benchmarkSource],
            ["rubrics", envelope.pilotTaskBasis.rubricSource],
          ] as const) {
            const committedSource = sourceBindings.find((binding) => binding.role === role);
            if (committedSource === undefined) {
              errors.add(`EVALUATOR_SEMANTIC_ENVELOPE_${role.toUpperCase()}_BINDING_MISSING`);
              continue;
            }
            errors.equal(source.path, committedSource.path, `EVALUATOR_SEMANTIC_ENVELOPE_${role.toUpperCase()}_PATH_MISMATCH`);
            errors.equal(source.fileDigest, committedSource.fileDigest, `EVALUATOR_SEMANTIC_ENVELOPE_${role.toUpperCase()}_DIGEST_MISMATCH`);
          }
        }
      }
    }
  }

  checkParsedSelfDigest(live, "envelopeDigest", computeFreshLiveContractEnvelopeDigest, errors, "LIVE_CONTRACT_ENVELOPE_DIGEST_MISMATCH");
  errors.equal(live.freezeDigest, freeze.freezeDigest, "LIVE_CONTRACT_FREEZE_MISMATCH");
  errors.equal(hashCanonicalJson(live.receipt), live.receiptDigest, "LIVE_CONTRACT_RECEIPT_DIGEST_MISMATCH");
  if (liveCapturedAtMs <= frozenAtMs) errors.add("LIVE_CONTRACT_NOT_POST_FREEZE");
  const parsedLiveBytes = parseJsonBytes(input.freshLiveContractFileBytes, "LIVE_CONTRACT_BYTES_INVALID_JSON", errors);
  if (parsedLiveBytes !== null) {
    errors.equal(canonicalJson(parsedLiveBytes), canonicalJson(live.receipt), "LIVE_CONTRACT_BYTES_VALUE_MISMATCH");
  }
  errors.equal(live.receiptFile.fileDigest, sha256Digest(input.freshLiveContractFileBytes), "LIVE_CONTRACT_FILE_DIGEST_MISMATCH");
  await verifyGitCommit(live.gitCommit, live.gitTree, input.git, errors, "LIVE_CONTRACT");
  await verifyGitBinding(live.receiptFile, live.gitCommit, input.git, input.freshLiveContractFileBytes, errors, "LIVE_CONTRACT_RECEIPT");
  try {
    if (!(await input.git.isAncestor(code.gitCommit, live.gitCommit))) errors.add("COMMITTED_CODE_NOT_ANCESTOR_OF_LIVE_RECEIPT");
  } catch {
    errors.add("GIT_ANCESTRY_UNRESOLVED");
  }

  for (const [actual, expected, codeValue] of [
    [live.receipt.baseline.gitCommit, freeze.baseline.gitCommit, "LIVE_BASELINE_GIT_COMMIT_MISMATCH"],
    [live.receipt.baseline.gitTree, freeze.baseline.gitTree, "LIVE_BASELINE_GIT_TREE_MISMATCH"],
    [live.receipt.baseline.deploymentId, freeze.baseline.deploymentId, "LIVE_BASELINE_DEPLOYMENT_MISMATCH"],
    [live.receipt.baseline.buildId, freeze.baseline.buildId, "LIVE_BASELINE_BUILD_MISMATCH"],
    [originOf(live.receipt.baseline.immutableDeploymentUrl), originOf(freeze.baseline.immutableUrl), "LIVE_BASELINE_IMMUTABLE_URL_MISMATCH"],
    [originOf(live.receipt.baseline.executionUrl), originOf(freeze.baseline.productionUrl), "LIVE_EXECUTION_URL_MISMATCH"],
    [live.receipt.baseline.executionUrlVerifiedDeploymentId, freeze.baseline.deploymentId, "LIVE_EXECUTION_DEPLOYMENT_MISMATCH"],
    [live.receipt.runner.scriptDigest, authorRunner?.fileDigest, "LIVE_AUTHOR_RUNNER_DIGEST_MISMATCH"],
    [live.receipt.participant.contractDigest, freeze.conditions.A0.participantContractDigest, "PARTICIPANT_CONTRACT_MISMATCH"],
    [live.receipt.spectator.contractDigest, freeze.conditions.A0.spectatorContractDigest, "SPECTATOR_CONTRACT_MISMATCH"],
  ] as const) errors.equal(actual, expected, codeValue);

  checkParsedSelfDigest(alias, "receiptDigest", computeAliasPreflightDigest, errors, "ALIAS_PREFLIGHT_DIGEST_MISMATCH");
  errors.equal(alias.freezeDigest, freeze.freezeDigest, "ALIAS_PREFLIGHT_FREEZE_MISMATCH");
  errors.equal(originOf(alias.productionUrl), originOf(freeze.baseline.productionUrl), "ALIAS_PRODUCTION_URL_MISMATCH");
  errors.equal(alias.resolvedDeploymentId, freeze.baseline.deploymentId, "ALIAS_DEPLOYMENT_MISMATCH");
  errors.equal(alias.resolvedBuildId, freeze.baseline.buildId, "ALIAS_BUILD_MISMATCH");
  errors.equal(originOf(alias.resolvedImmutableUrl), originOf(freeze.baseline.immutableUrl), "ALIAS_IMMUTABLE_URL_MISMATCH");
  const aliasObservedAtMs = dateMs(alias.observedAt);
  if (aliasObservedAtMs <= frozenAtMs) errors.add("ALIAS_PREFLIGHT_NOT_POST_FREEZE");
  if (aliasObservedAtMs > liveCapturedAtMs) errors.add("ALIAS_PREFLIGHT_NOT_BEFORE_CONTRACT");
  if (dateMs(alias.expiresAt) <= nowMs) errors.add("ALIAS_PREFLIGHT_EXPIRED");

  checkParsedSelfDigest(noBrief, "receiptDigest", computeNoBriefEvidenceDigest, errors, "NO_BRIEF_EVIDENCE_DIGEST_MISMATCH");
  errors.equal(noBrief.freezeDigest, freeze.freezeDigest, "NO_BRIEF_FREEZE_MISMATCH");
  if (dateMs(noBrief.observedAt) < liveCapturedAtMs) errors.add("NO_BRIEF_EVIDENCE_PREDATES_LIVE_CONTRACT");
  if (dateMs(noBrief.observedAt) > nowMs) errors.add("NO_BRIEF_EVIDENCE_FROM_FUTURE");
  if (dateMs(noBrief.releaseLock.expiresAt) <= nowMs) errors.add("NO_BRIEF_RELEASE_LOCK_EXPIRED");
  errors.equal(sha256Digest(input.registryFileBytes), noBrief.registryFileDigest, "NO_BRIEF_REGISTRY_FILE_DIGEST_MISMATCH");
  const registryValue = parseJsonBytes(input.registryFileBytes, "NO_BRIEF_REGISTRY_BYTES_INVALID_JSON", errors);
  if (registryValue !== null) {
    const registryResult = z.object({
      registryDigest: sha256Schema,
      events: z.array(z.object({ kind: z.string().min(1) }).passthrough()),
    }).passthrough().safeParse(registryValue);
    if (!registryResult.success) {
      errors.add("NO_BRIEF_REGISTRY_SCHEMA_INVALID");
    } else {
      errors.equal(registryResult.data.registryDigest, noBrief.registryDigest, "NO_BRIEF_REGISTRY_IDENTITY_MISMATCH");
      if (registryResult.data.events.some((event) => event.kind === "brief_delivered")) errors.add("NO_BRIEF_REGISTRY_CONTAINS_DELIVERY");
    }
  }

  checkParsedSelfDigest(spend, "receiptDigest", computeSpendAuthorizationDigest, errors, "SPEND_AUTHORIZATION_DIGEST_MISMATCH");
  errors.equal(spend.freezeDigest, freeze.freezeDigest, "SPEND_AUTHORIZATION_FREEZE_MISMATCH");
  if (dateMs(spend.authorizedAt) < frozenAtMs) errors.add("SPEND_AUTHORIZATION_PREDATES_FREEZE");
  if (dateMs(spend.authorizedAt) > nowMs) errors.add("SPEND_AUTHORIZATION_FROM_FUTURE");
  if (dateMs(spend.expiresAt) <= nowMs) errors.add("SPEND_AUTHORIZATION_EXPIRED");
  if (spend.maximumUsd > freeze.costProjection.configuredCapTotalUsd) {
    errors.add("SPEND_AUTHORIZATION_EXCEEDS_FROZEN_CAP");
  }
  if (dateMs(spend.expiresAt) > dateMs(freeze.pricingProvenance.revalidationRequiredBefore)) {
    errors.add("SPEND_AUTHORIZATION_OUTLIVES_PRICING_VALIDITY");
  }

  checkParsedSelfDigest(
    executionHost,
    "receiptDigest",
    computeExecutionHostAttestationDigest,
    errors,
    "EXECUTION_HOST_ATTESTATION_DIGEST_MISMATCH",
  );
  errors.equal(executionHost.freezeDigest, freeze.freezeDigest, "EXECUTION_HOST_FREEZE_MISMATCH");
  if (dateMs(executionHost.capturedAt) <= frozenAtMs) errors.add("EXECUTION_HOST_ATTESTATION_NOT_POST_FREEZE");
  if (dateMs(executionHost.capturedAt) > nowMs) errors.add("EXECUTION_HOST_ATTESTATION_FROM_FUTURE");
  if (dateMs(executionHost.expiresAt) <= nowMs) errors.add("EXECUTION_HOST_ATTESTATION_EXPIRED");
  const frozenExecutionHost = { ...freeze.executionHost };
  delete (frozenExecutionHost as { status?: unknown }).status;
  errors.equal(canonicalJson(executionHost.host), canonicalJson(frozenExecutionHost), "EXECUTION_HOST_COVARIATE_MISMATCH");
  errors.equal(
    executionHost.host.dependencyResolution.packageManifestDigest,
    freeze.frozenSources.packageManifest.fileDigest,
    "EXECUTION_HOST_PACKAGE_MANIFEST_DIGEST_MISMATCH",
  );
  errors.equal(
    executionHost.host.dependencyResolution.packageLockDigest,
    freeze.frozenSources.packageLock.fileDigest,
    "EXECUTION_HOST_PACKAGE_LOCK_DIGEST_MISMATCH",
  );

  try {
    if (!(await input.attestations.verifyAuthoritativePrebriefFreeze(freeze, input.prebriefFreezeFileBytes))) {
      errors.add("AUTHORITATIVE_PREBRIEF_ATTESTATION_REJECTED");
    }
  } catch {
    errors.add("AUTHORITATIVE_PREBRIEF_ATTESTATION_FAILED");
  }
  try {
    if (!(await input.attestations.verifyAliasPreflight(alias))) errors.add("ALIAS_PREFLIGHT_ATTESTATION_REJECTED");
  } catch {
    errors.add("ALIAS_PREFLIGHT_ATTESTATION_FAILED");
  }
  try {
    if (!(await input.attestations.verifyNoBriefEvidence(noBrief, input.registryFileBytes))) errors.add("NO_BRIEF_ATTESTATION_REJECTED");
  } catch {
    errors.add("NO_BRIEF_ATTESTATION_FAILED");
  }
  try {
    if (!(await input.attestations.verifySpendAuthorization(spend))) errors.add("SPEND_AUTHORIZATION_ATTESTATION_REJECTED");
  } catch {
    errors.add("SPEND_AUTHORIZATION_ATTESTATION_FAILED");
  }
  try {
    if (!(await input.attestations.verifyExecutionHostAttestation(executionHost))) {
      errors.add("EXECUTION_HOST_ATTESTATION_REJECTED");
    }
  } catch {
    errors.add("EXECUTION_HOST_ATTESTATION_FAILED");
  }

  if (errors.errors.length > 0) return { ok: false, errors: errors.errors };

  const validUntilMs = Math.min(
    dateMs(alias.expiresAt),
    dateMs(noBrief.releaseLock.expiresAt),
    dateMs(spend.expiresAt),
    dateMs(executionHost.expiresAt),
    dateMs(freeze.pricingProvenance.revalidationRequiredBefore),
  );
  const content: z.infer<typeof executionReadyContentSchema> = {
    schemaVersion: 1,
    kind: "exp-0001a-execution-ready",
    protocolId: "EXP-0001A",
    createdAt: nowResult.data,
    validUntil: new Date(validUntilMs).toISOString(),
    freezeDigest: freeze.freezeDigest,
    baseline: {
      gitCommit: freeze.baseline.gitCommit,
      gitTree: freeze.baseline.gitTree,
      deploymentId: freeze.baseline.deploymentId,
      buildId: freeze.baseline.buildId,
      immutableUrl: freeze.baseline.immutableUrl,
      productionUrl: freeze.baseline.productionUrl,
    },
    conditionsDigest: freeze.conditions.configurationDigest,
    committedCode: {
      receiptDigest: code.receiptDigest,
      gitCommit: code.gitCommit,
      gitTree: code.gitTree,
      authorSessionIdentityManifestRoot,
      sourceBindings: sourceSummaries(code.sourceBindings),
    },
    liveContract: {
      envelopeDigest: live.envelopeDigest,
      receiptDigest: live.receiptDigest,
      gitCommit: live.gitCommit,
      gitTree: live.gitTree,
      capturedAt: live.receipt.capturedAt,
      participantContractDigest: live.receipt.participant.contractDigest,
      spectatorContractDigest: live.receipt.spectator.contractDigest,
    },
    aliasPreflightDigest: alias.receiptDigest,
    deploymentContinuity: {
      verifierSourceRole: "perAttemptAliasVerifier",
      verifierSourceDigest: sha256Schema.parse(perAttemptAliasVerifierDigest),
      verificationTiming: freeze.deploymentContinuityPolicy.verificationTiming,
      requiredReceiptCountAtCompletion: freeze.deploymentContinuityPolicy.requiredReceiptCountAtCompletion,
      receiptsHashChainedInBatchRegistry: freeze.deploymentContinuityPolicy.receiptsHashChainedInBatchRegistry,
      driftDisposition: freeze.deploymentContinuityPolicy.driftDisposition,
    },
    noBriefEvidenceDigest: noBrief.receiptDigest,
    executionHost: {
      attestationDigest: executionHost.receiptDigest,
      capturedAt: executionHost.capturedAt,
      nodeVersion: executionHost.host.nodeVersion,
      platform: executionHost.host.platform,
      architecture: executionHost.host.architecture,
      operatingSystemBuild: executionHost.host.operatingSystem.build,
      packageManifestDigest: executionHost.host.dependencyResolution.packageManifestDigest,
      packageLockDigest: executionHost.host.dependencyResolution.packageLockDigest,
      runtimeDependencyReceiptDigest: executionHost.host.runtimeDependencies.receiptDigest,
      runtimeDependencyComponentSetRoot: executionHost.host.runtimeDependencies.componentSetRoot,
      runtimeDependencyReceiptCaptureVerificationDurationMs:
        executionHost.host.runtimeDependencies.captureVerificationDurationMs,
    },
    attestationPolicyDigest: attestationPolicyResult.data,
    spendAuthorization: {
      receiptDigest: spend.receiptDigest,
      authorizationId: spend.authorizationId,
      maximumUsd: spend.maximumUsd,
      frozenCapTotalUsd: freeze.costProjection.configuredCapTotalUsd,
      scope: spend.scope,
      expiresAt: spend.expiresAt,
      pricingRevalidationRequiredBefore: freeze.pricingProvenance.revalidationRequiredBefore,
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
      executionHostExact: true,
      noBriefsDeliveredUnderExclusiveLock: true,
      spendExplicitAndUnexpired: true,
      spendAuthorizationWithinFrozenProtocolCeiling: true,
      spendAuthorizationExpiresBeforePricingRevalidation: true,
      preProviderCumulativeInputHardCapVerified: true,
      aaConditionsIdentical: true,
    },
  };
  const receipt = exp0001aExecutionReadyReceiptSchema.parse({
    ...content,
    receiptDigest: hashCanonicalJson(content),
  });
  return { ok: true, receipt };
}

export type ExecutionReadyVerification =
  | { ok: true; receipt: Exp0001aExecutionReadyReceipt }
  | { ok: false; errors: string[] };

export function verifyExp0001aExecutionReadyReceipt(input: unknown, now: string): ExecutionReadyVerification {
  const parsed = exp0001aExecutionReadyReceiptSchema.safeParse(input);
  const parsedNow = z.string().datetime({ offset: true }).safeParse(now);
  const errors: string[] = [];
  if (!parsed.success) errors.push(...schemaErrors("EXECUTION_READY", parsed.error));
  if (!parsedNow.success) errors.push("NOW_INVALID");
  if (!parsed.success || !parsedNow.success) return { ok: false, errors };
  if (computeExecutionReadyReceiptDigest(parsed.data) !== parsed.data.receiptDigest) errors.push("EXECUTION_READY_RECEIPT_DIGEST_MISMATCH");
  if (dateMs(parsed.data.createdAt) > dateMs(parsedNow.data)) errors.push("EXECUTION_READY_RECEIPT_FROM_FUTURE");
  if (dateMs(parsed.data.validUntil) <= dateMs(parsed.data.createdAt)) errors.push("EXECUTION_READY_VALIDITY_INTERVAL_INVALID");
  if (dateMs(parsed.data.validUntil) <= dateMs(parsedNow.data)) errors.push("EXECUTION_READY_RECEIPT_EXPIRED");
  const bindings = parsed.data.committedCode.sourceBindings;
  const paths = bindings.map((source) => source.path);
  const roles = bindings.map((source) => source.role);
  if (new Set(paths).size !== paths.length) errors.push("EXECUTION_READY_SOURCE_PATHS_NOT_UNIQUE");
  if (new Set(roles).size !== roles.length) errors.push("EXECUTION_READY_SOURCE_ROLES_NOT_UNIQUE");
  if (bindings.some((binding, index) => index > 0 && compareCodeUnits(bindings[index - 1].role, binding.role) >= 0)) {
    errors.push("EXECUTION_READY_SOURCE_BINDINGS_NOT_SORTED");
  }
  for (const role of REQUIRED_EXECUTION_CRITICAL_SOURCE_ROLES) {
    if (bindings.filter((source) => source.role === role).length !== 1) {
      errors.push(`EXECUTION_READY_${role.toUpperCase()}_CARDINALITY_INVALID`);
    }
  }
  const aliasVerifierBinding = bindings.find((source) => source.role === "perAttemptAliasVerifier");
  if (aliasVerifierBinding?.fileDigest !== parsed.data.deploymentContinuity.verifierSourceDigest) {
    errors.push("EXECUTION_READY_ALIAS_VERIFIER_DIGEST_MISMATCH");
  }
  const trustAnchorBinding = bindings.find((source) => source.role === "executionAuthorityTrustAnchor");
  if (trustAnchorBinding?.fileDigest !== parsed.data.attestationPolicyDigest) {
    errors.push("EXECUTION_READY_TRUST_ANCHOR_DIGEST_MISMATCH");
  }
  return errors.length === 0 ? { ok: true, receipt: parsed.data } : { ok: false, errors };
}

function runGit(repositoryPath: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], {
      cwd: repositoryPath,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr);
        reject(new Error(`git ${args[0]} failed: ${detail.trim()}`));
      } else {
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      }
    });
  });
}

/** Local-only verifier. It never contacts a remote and resolves only Git objects already present on disk. */
export function createGitCliObjectReader(repositoryPath: string): GitObjectReader {
  return {
    async readCommit(commit) {
      const type = (await runGit(repositoryPath, ["cat-file", "-t", commit])).toString("utf8").trim();
      if (type !== "commit") throw new Error("Object is not a commit.");
      const tree = (await runGit(repositoryPath, ["show", "-s", "--format=%T", commit])).toString("utf8").trim();
      if (!gitObjectSchema.safeParse(tree).success) throw new Error("Commit tree is invalid.");
      return { objectType: "commit", tree };
    },
    async readFileAtCommit(commit, path) {
      relativePathSchema.parse(path);
      const listing = (await runGit(repositoryPath, ["ls-tree", "-z", commit, "--", path])).toString("utf8");
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(listing);
      if (!match || match[3] !== path) throw new Error("Path is absent, ambiguous, or not a regular file.");
      const bytes = await runGit(repositoryPath, ["show", `${commit}:${path}`]);
      return { objectType: "blob", mode: match[1] as "100644" | "100755", blobOid: match[2], bytes };
    },
    async isAncestor(ancestorCommit, descendantCommit) {
      try {
        await runGit(repositoryPath, ["merge-base", "--is-ancestor", ancestorCommit, descendantCommit]);
        return true;
      } catch {
        return false;
      }
    },
  };
}
