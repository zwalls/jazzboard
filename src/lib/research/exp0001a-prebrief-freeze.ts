import { z } from "zod";

import executionManifestJson from "../../../research/data/development-execution-manifest-v1.json";
import runnerProfileJson from "../../../research/data/development-runner-profile-v1.json";
import freezeReceiptJson from "../../../research/data/exp-0001a-prebrief-freeze-v1.json";
import { verifyDevelopmentExecutionManifest } from "./development-manifest";
import { verifyDevelopmentRunnerProfile } from "./development-attempt-config";
import { EXP0001A_AUTHOR_SESSION_IDENTITIES } from "./exp0001a-author-identities";
import {
  computePairwiseReviewerRosterRoot,
  pairwiseReviewerRosterSchema,
} from "./pairwise-visual-preference";
import { hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

const sha256Schema = z.string().regex(SHA256_DIGEST_PATTERN);
const opaqueIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const fileCommitmentSchema = z.object({
  path: z.string().min(1),
  fileDigest: sha256Schema,
}).strict();

const pendingCodeCommitmentSchema = z.object({
  status: z.literal("pending"),
  path: z.string().min(1),
  candidateObservedDigest: sha256Schema,
  committedDigest: z.null(),
  committedGitCommit: z.null(),
}).strict();

const pendingLiveReceiptSchema = z.object({
  status: z.literal("pending"),
  receiptDigest: z.null(),
  committedGitCommit: z.null(),
  verifiedAt: z.null(),
  mustPostdateFrozenAt: z.literal(true),
}).strict();

const budgetSchema = z.object({
  wallMs: z.number().int().positive(),
  toolCalls: z.number().int().positive(),
  perToolTimeoutMs: z.number().int().positive(),
  inputTokens: z.number().int().positive(),
  outputTokens: z.number().int().positive(),
  perResponseOutputTokens: z.number().int().positive(),
  correctionRounds: z.number().int().nonnegative(),
}).strict();

const reviewerBudgetSchema = z.object({
  inputTokens: z.number().int().positive(),
  outputTokens: z.number().int().positive(),
  requests: z.literal(1),
}).strict();

const pricingSchema = z.object({
  currency: z.literal("USD"),
  perMillionTokens: z.object({
    uncachedInput: z.literal(4),
    cachedInput: z.literal(0.4),
    cacheWriteInput: z.literal(5),
    output: z.literal(20),
  }).strict(),
  reasoningAccounting: z.literal("nested-in-output-not-double-counted"),
}).strict();

const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  uncachedInputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().finite().nonnegative(),
}).strict();

const treatmentConfigurationSchema = z.object({
  productReceiptDigest: sha256Schema,
  productBuildDigest: sha256Schema,
  authorRunnerDigest: sha256Schema,
  runnerProfileDigest: sha256Schema,
  scheduleConfigurationDigest: sha256Schema,
  authorBriefCompilerDigest: sha256Schema,
  toolAllowlistDigest: sha256Schema,
  participantContractDigest: sha256Schema,
  spectatorContractDigest: sha256Schema,
  model: z.object({
    id: z.literal("gpt-5.6-sol"),
    reasoningEffort: z.literal("max"),
    serviceTier: z.literal("default"),
  }).strict(),
  browser: z.object({
    engine: z.literal("chromium"),
    product: z.literal("Google Chrome for Testing"),
    version: z.literal("151.0.7922.34"),
    playwrightVersion: z.literal("1.62.1"),
    headless: z.literal(true),
  }).strict(),
  viewport: z.object({
    width: z.literal(1280),
    height: z.literal(720),
    deviceScaleFactor: z.literal(1),
    locale: z.literal("en-US"),
    timezone: z.literal("UTC"),
  }).strict(),
  authorBudgets: budgetSchema,
}).strict();

const taskCommitmentSchema = z.object({
  taskId: opaqueIdSchema,
  taskDigest: sha256Schema,
}).strict();

const freezeContentSchema = z.object({
  schemaVersion: z.literal(1),
  freezeId: z.literal("exp-0001a-prebrief-freeze-v1"),
  protocolId: z.literal("EXP-0001A"),
  studyKind: z.literal("aa_calibration"),
  partition: z.literal("development"),
  status: z.literal("blocked_pending_prerequisites"),
  frozenAt: z.string().datetime({ offset: true }),
  executionStateAtFreeze: z.literal("not_started"),
  briefReleaseAuthorized: z.literal(false),
  baseline: z.object({
    gitCommit: z.literal("48a52e0837144ea0db8a09e43217397226759f83"),
    gitTree: z.literal("a25e8ec9f8fcc08b227d710a8517333af90f491e"),
    deploymentId: z.literal("dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD"),
    buildId: z.literal("bld_crjsfx08s"),
    immutableUrl: z.literal("https://jazzboard-noy5qxxfd-zwalls-projects.vercel.app"),
    productionUrl: z.literal("https://www.jazzboard.xyz"),
    deploymentState: z.literal("READY"),
    deploymentCreatedAt: z.literal(1788119806714),
    nodeVersion: z.literal("24.x"),
    roomRouteDigest: z.literal("sha256:8a2e7309dc54e2ad70de749525d2c3b41c8bb68c1ece5cd9a55e565a971e8b55"),
    receiptDigest: z.literal("sha256:32fddd038f6ec696f633bc5ee28ec587540282dbbd1e451e5d2debeb67069b23"),
    buildIdentityDigest: z.literal("sha256:0342169d87c8c5b4aa770745222488fe934e83940a01e296872daa096e6465d4"),
    healthBodyDigest: z.literal("sha256:865fdd40a151c3f9e95d675d2d10b20b211e2734bae94f20b7b1dcfc4a91cc61"),
    webMcpInventory: z.object({
      landingToolCount: z.literal(5),
      landingDigest: z.literal("sha256:37369b1b3bec8fa9f0c591c479a8852e5ea52254b4ab9da8239d4a66eba2b376"),
      participantToolCount: z.literal(54),
      participantDigest: z.literal("sha256:dd0a654798c27dc7a4cef64408fe583f1a3fdf51b097f1cac21c5534af436997"),
    }).strict(),
  }).strict(),
  executionHost: z.object({
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
  }).strict(),
  schedule: z.object({
    manifestId: z.literal("exp-0001a-development-execution-v1"),
    manifestFileDigest: sha256Schema,
    manifestDigest: sha256Schema,
    benchmarkBundleDigest: sha256Schema,
    taskCommitmentsDigest: sha256Schema,
    fixedOrderDigest: sha256Schema,
    treatmentDigest: sha256Schema,
    opaqueLabels: z.tuple([z.literal("A0"), z.literal("A1")]),
    taskCount: z.literal(12),
    pairCount: z.literal(24),
    attemptCount: z.literal(48),
    rerunsPermitted: z.literal(false),
    taskCommitments: z.array(taskCommitmentSchema).length(12),
  }).strict(),
  frozenSources: z.object({
    protocol: fileCommitmentSchema,
    benchmark: fileCommitmentSchema,
    rubrics: fileCommitmentSchema,
    fixtures: fileCommitmentSchema,
    benchmarkCompiler: fileCommitmentSchema,
    scoring: fileCommitmentSchema,
    artifactSchemas: fileCommitmentSchema,
    statistics: fileCommitmentSchema,
    reportCompiler: fileCommitmentSchema,
    evaluatorInstructions: fileCommitmentSchema,
    failureTaxonomy: fileCommitmentSchema,
    packageManifest: fileCommitmentSchema,
    packageLock: fileCommitmentSchema,
    perAttemptAliasVerifier: fileCommitmentSchema,
    authorRunner: fileCommitmentSchema,
    runnerProfile: fileCommitmentSchema.extend({ canonicalDigest: sha256Schema }).strict(),
    attemptCompiler: fileCommitmentSchema,
    batchCoordinator: fileCommitmentSchema,
    batchCli: fileCommitmentSchema,
    batchCommandLibrary: fileCommitmentSchema,
    batchRegistryBridge: fileCommitmentSchema,
    cleanRoomBatchAdapter: fileCommitmentSchema,
    completionAttestation: fileCommitmentSchema,
    completionSignerCli: fileCommitmentSchema,
    atomicRegistryStore: fileCommitmentSchema,
    evaluatorRunner: fileCommitmentSchema,
    evaluatorSemanticEnvelopeReceipt: fileCommitmentSchema,
    executionAuthorityTrustAnchor: fileCommitmentSchema,
    launchAuthorityVerifier: fileCommitmentSchema,
    launchSignerCli: fileCommitmentSchema,
    liveReviewRunner: fileCommitmentSchema,
    adjudicationOrchestration: fileCommitmentSchema,
    analysisRuntime: fileCommitmentSchema,
    attemptMetrics: fileCommitmentSchema,
    attemptMetricsRegistry: fileCommitmentSchema,
    attemptMetricsSpec: fileCommitmentSchema,
    metricsRuntime: fileCommitmentSchema,
    pairwisePreference: fileCommitmentSchema,
    pairwisePreferenceInstructions: fileCommitmentSchema,
    pairwiseRuntime: fileCommitmentSchema,
    spendLedger: fileCommitmentSchema,
    runtimeComposition: fileCommitmentSchema,
    runtimeBuilder: fileCommitmentSchema,
    runtimeBundle: fileCommitmentSchema,
    runtimeDependencyReceipt: fileCommitmentSchema,
    runtimeDependencyVerifier: fileCommitmentSchema,
    experimentFreezeAdapter: fileCommitmentSchema,
    executionGate: fileCommitmentSchema,
    authorSessionIdentityManifest: fileCommitmentSchema.extend({ manifestRoot: sha256Schema }).strict(),
  }).strict(),
  pendingPrerequisites: z.object({
    batchCoordinator: pendingCodeCommitmentSchema,
    batchCli: pendingCodeCommitmentSchema,
    batchCommandLibrary: pendingCodeCommitmentSchema,
    batchRegistryBridge: pendingCodeCommitmentSchema,
    cleanRoomBatchAdapter: pendingCodeCommitmentSchema,
    completionAttestation: pendingCodeCommitmentSchema,
    completionSignerCli: pendingCodeCommitmentSchema,
    atomicRegistryStore: pendingCodeCommitmentSchema,
    evaluatorRunner: pendingCodeCommitmentSchema,
    evaluatorSemanticEnvelopeReceipt: pendingCodeCommitmentSchema,
    executionAuthorityTrustAnchor: pendingCodeCommitmentSchema,
    launchAuthorityVerifier: pendingCodeCommitmentSchema,
    launchSignerCli: pendingCodeCommitmentSchema,
    liveReviewRunner: pendingCodeCommitmentSchema,
    adjudicationOrchestration: pendingCodeCommitmentSchema,
    analysisRuntime: pendingCodeCommitmentSchema,
    attemptMetrics: pendingCodeCommitmentSchema,
    attemptMetricsRegistry: pendingCodeCommitmentSchema,
    attemptMetricsSpec: pendingCodeCommitmentSchema,
    metricsRuntime: pendingCodeCommitmentSchema,
    perAttemptAliasVerifier: pendingCodeCommitmentSchema,
    pairwisePreference: pendingCodeCommitmentSchema,
    pairwisePreferenceInstructions: pendingCodeCommitmentSchema,
    pairwiseRuntime: pendingCodeCommitmentSchema,
    spendLedger: pendingCodeCommitmentSchema,
    runtimeComposition: pendingCodeCommitmentSchema,
    runtimeBuilder: pendingCodeCommitmentSchema,
    runtimeBundle: pendingCodeCommitmentSchema,
    runtimeDependencyReceipt: pendingCodeCommitmentSchema,
    runtimeDependencyVerifier: pendingCodeCommitmentSchema,
    reportCompiler: pendingCodeCommitmentSchema,
    experimentFreezeAdapter: pendingCodeCommitmentSchema,
    executionGate: pendingCodeCommitmentSchema,
    authorSessionIdentityManifest: pendingCodeCommitmentSchema,
    freshLiveReceipt: pendingLiveReceiptSchema,
  }).strict(),
  providerModelIdentityPolicy: z.object({
    requestedModelIdFrozen: z.literal(true),
    immutableWeightSnapshotAsserted: z.literal(false),
    responseModelRetainedAndDriftChecked: z.literal(true),
    serviceTierRetainedAndDriftChecked: z.literal(true),
    rollingProviderRiskMitigation: z.literal("aa-interleaving-paired-order-balance-and-time-block-diagnostics"),
    confirmatoryPreference: z.literal("use-an-immutable-dated-weight-snapshot-when-the-provider-exposes-one"),
  }).strict(),
  deploymentContinuityPolicy: z.object({
    executionOrigin: z.literal("https://www.jazzboard.xyz"),
    frozenDeploymentId: z.literal("dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD"),
    verifierSourceRole: z.literal("perAttemptAliasVerifier"),
    verificationTiming: z.literal("authenticated-vercel-api-immediately-before-each-brief"),
    requiredReceiptCountAtCompletion: z.literal(48),
    receiptsHashChainedInBatchRegistry: z.literal(true),
    driftDisposition: z.literal("not_started-hard-stop-before-brief"),
    immutableDeploymentAlternative: z.literal("protected-immutable-url-requires-authenticated-bypass"),
  }).strict(),
  conditions: z.object({
    A0: treatmentConfigurationSchema,
    A1: treatmentConfigurationSchema,
    configurationDigest: sha256Schema,
  }).strict(),
  reviewerPlan: z.object({
    model: z.object({ id: z.literal("gpt-5.6-sol"), reasoningEffort: z.literal("high") }).strict(),
    serviceTier: z.literal("default"),
    primaryBudget: reviewerBudgetSchema,
    adjudicatorBudget: reviewerBudgetSchema,
    primaryReviewsPerArtifact: z.literal(2),
    adjudicationTrigger: z.literal("binary-primary-acceptance-disagreement-only"),
    preserveOriginalReviews: z.literal(true),
    minimumDistinctReviewers: z.literal(3),
    rosterAssignmentSeed: sha256Schema,
    roster: z.array(z.object({ reviewerId: opaqueIdSchema, identityCommitment: sha256Schema }).strict()).length(5),
    separationPolicy: z.object({
      authorMayReview: z.literal(false),
      primaryReviewersDistinct: z.literal(true),
      adjudicatorDistinctFromPrimaries: z.literal(true),
      pairedArtifactVisibleBeforeLock: z.literal(false),
      conditionLabelVisibleBeforeLock: z.literal(false),
    }).strict(),
    pairwisePreference: z.object({
      pairCount: z.literal(24),
      model: z.object({ id: z.literal("gpt-5.6-sol"), reasoningEffort: z.literal("high") }).strict(),
      serviceTier: z.literal("default"),
      budget: z.object({
        inputTokens: z.literal(60000),
        outputTokens: z.literal(8000),
        requests: z.literal(1),
      }).strict(),
      promptDigest: sha256Schema,
      promptDistinctFromIndividualEvaluatorInstructions: z.literal(true),
      individualReviewerOverlap: z.literal("forbid"),
      identitySemantics: z.literal("one-fresh-opaque-process-identity-per-pair-not-authentication"),
      roster: pairwiseReviewerRosterSchema,
      rosterRoot: sha256Schema,
      separationPolicy: z.object({
        distinctFromIndividualRoster: z.literal(true),
        distinctFromAuthors: z.literal(true),
        oneProcessIdentityPerPair: z.literal(true),
        freshOpaqueContextPerPair: z.literal(true),
      }).strict(),
    }).strict(),
  }).strict(),
  budgetRationale: z.object({
    profileChangePermittedBeforeFirstBrief: z.literal(true),
    briefsDeliveredBeforeFreeze: z.literal(0),
    observedAuthorTaskId: z.literal("dev-architecture-create-checkout"),
    observedAuthorInputTokens: z.literal(332150),
    authorInputBudget: z.literal(600000),
    higherComplexityTaskCount: z.literal(7),
    observedPrimaryReviewerInputTokens: z.literal(6531),
    observedPrimaryReviewerOutputTokens: z.literal(878),
    primaryReviewerInputBudget: z.literal(60000),
    primaryReviewerOutputBudget: z.literal(8000),
    rationale: z.literal("Fixed pre-brief caps retain material headroom over the successful medium-task diagnostic while recognizing that seven of twelve public tasks are large or dense; caps remain finite and all budget exits remain retained outcomes."),
  }).strict(),
  pricing: pricingSchema,
  pricingProvenance: z.object({
    serviceTier: z.literal("default"),
    modelDocumentationUrl: z.literal("https://developers.openai.com/api/docs/models/gpt-5.6-sol"),
    fastModeGuideUrl: z.literal("https://developers.openai.com/api/docs/guides/fast-mode"),
    capturedOn: z.literal("2026-08-30"),
    promotionalPricingValidAtLeastThrough: z.literal("2026-11-21"),
    revalidationRequiredBefore: z.literal("2026-11-22T00:00:00.000Z"),
  }).strict(),
  evidenceBasis: z.object({
    source: z.literal("EXP-0000 v3 retained diagnostic"),
    sourceAuthorRunnerDigest: z.literal("sha256:699d803722f6425547246c9a70c7ec96e56ff525043638a6c21f48f94ca5ec12"),
    author: usageSchema,
    primaryReviewer: usageSchema,
  }).strict(),
  costProjection: z.object({
    longContextThresholdInputTokensPerRequest: z.literal(272000),
    longContextInputRateMultiplier: z.literal(2),
    longContextOutputRateMultiplier: z.literal(1.5),
    diagnosticMaximumAuthorTurnInputTokens: z.literal(56291),
    diagnosticLongContextSurchargeObserved: z.literal(false),
    expectedAuthorPerAttemptUsd: z.literal(0.6220848),
    expectedAuthor48Usd: z.literal(29.8600704),
    expectedPrimaryReviews96Usd: z.literal(4.193664),
    expectedWithoutAdjudicationUsd: z.literal(34.0537344),
    planningAdjudications: z.literal(10),
    expectedWithPlanningAdjudicationsUsd: z.literal(34.4905744),
    expectedPairwisePreferencePerCallUsd: z.literal(0.069808),
    expectedPairwisePreferences24Usd: z.literal(1.675392),
    expectedTotalUsd: z.literal(36.1659664),
    sensitivityOnePointFiveXTotalUsd: z.literal(54.2489496),
    configuredCapAuthor48Usd: z.literal(403.2),
    configuredCapPrimaryReviews96Usd: z.literal(44.16),
    configuredCapAdjudication48Usd: z.literal(28.8),
    configuredCapPairwisePreferences24Usd: z.literal(11.04),
    configuredCapTotalUsd: z.literal(487.2),
    configuredCapAssumption: z.literal("author calls use the over-272K long-context ceiling of USD 10 per million input and USD 30 per million output; scorer calls remain below threshold at the highest standard input category rate of USD 5 per million"),
    preProviderCumulativeInputHardCapEnforced: z.literal(true),
    interpretation: z.literal("non-statistical planning range, not a confidence interval"),
  }).strict(),
  stopRules: z.object({
    retainAllBegunAttempts: z.literal(true),
    resumeOnlyAtUnbegunAssignments: z.literal(true),
    hardStops: z.array(z.enum([
      "condition-identity-mismatch",
      "baseline-or-contract-drift",
      "manifest-order-or-uniqueness-violation",
      "author-evaluator-separation-breach",
      "privacy-or-integrity-incident",
      "missing-or-tampered-required-artifact",
      "unapproved-cost-envelope-change",
    ])).length(7),
  }).strict(),
  executionGate: z.object({
    executable: z.literal(false),
    blockers: z.tuple([
      z.literal("batch-coordinator-not-committed"),
      z.literal("batch-cli-not-committed"),
      z.literal("batch-command-library-not-committed"),
      z.literal("batch-registry-bridge-not-committed"),
      z.literal("clean-room-batch-adapter-not-committed"),
      z.literal("completion-attestation-not-committed"),
      z.literal("completion-signer-cli-not-committed"),
      z.literal("atomic-registry-store-not-committed"),
      z.literal("evaluator-runner-not-committed"),
      z.literal("execution-authority-trust-anchor-not-committed"),
      z.literal("launch-authority-verifier-not-committed"),
      z.literal("launch-signer-cli-not-committed"),
      z.literal("live-review-runner-not-committed"),
      z.literal("adjudication-orchestration-not-committed"),
      z.literal("analysis-runtime-not-committed"),
      z.literal("attempt-metrics-not-committed"),
      z.literal("attempt-metrics-registry-not-committed"),
      z.literal("attempt-metrics-spec-not-committed"),
      z.literal("metrics-runtime-not-committed"),
      z.literal("per-attempt-alias-verifier-not-committed"),
      z.literal("pairwise-preference-not-committed"),
      z.literal("pairwise-preference-instructions-not-committed"),
      z.literal("pairwise-runtime-not-committed"),
      z.literal("spend-ledger-not-committed"),
      z.literal("runtime-composition-not-committed"),
      z.literal("runtime-builder-not-committed"),
      z.literal("runtime-bundle-not-committed"),
      z.literal("runtime-dependency-receipt-not-committed"),
      z.literal("runtime-dependency-verifier-not-committed"),
      z.literal("report-compiler-not-committed"),
      z.literal("experiment-freeze-adapter-not-committed"),
      z.literal("execution-gate-not-committed"),
      z.literal("author-session-identity-manifest-not-committed"),
      z.literal("fresh-live-receipt-not-committed"),
    ]),
  }).strict(),
  sensitiveMaterialRedacted: z.literal(true),
}).strict();

export const exp0001aPrebriefFreezeSchema = freezeContentSchema.extend({
  freezeDigest: sha256Schema,
}).strict();

export type Exp0001aPrebriefFreeze = z.infer<typeof exp0001aPrebriefFreezeSchema>;

function withoutDigest(receipt: Exp0001aPrebriefFreeze): Omit<Exp0001aPrebriefFreeze, "freezeDigest"> {
  return Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "freezeDigest")) as Omit<Exp0001aPrebriefFreeze, "freezeDigest">;
}

function orderedAttemptIds(): string[] {
  const verification = verifyDevelopmentExecutionManifest(executionManifestJson);
  if (!verification.ok) throw new Error(`Frozen development manifest is invalid: ${verification.errors.join(", ")}`);
  return [...verification.manifest.assignments]
    .sort((left, right) => left.timeBlock - right.timeBlock)
    .flatMap((pair) => [...pair.attempts]
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((attempt) => attempt.attemptId));
}

export function computeExp0001aPrebriefFreezeDigest(receipt: Exp0001aPrebriefFreeze): string {
  return hashCanonicalJson(withoutDigest(receipt));
}

export function priceUsage(usage: z.infer<typeof usageSchema>, pricing: z.infer<typeof pricingSchema>): number {
  const rates = pricing.perMillionTokens;
  return (
    usage.uncachedInputTokens * rates.uncachedInput
    + usage.cachedInputTokens * rates.cachedInput
    + usage.cacheWriteInputTokens * rates.cacheWriteInput
    + usage.outputTokens * rates.output
  ) / 1_000_000;
}

export type Exp0001aPrebriefVerification =
  | { ok: true; receipt: Exp0001aPrebriefFreeze; executable: false }
  | { ok: false; errors: string[]; executable: false };

export function verifyExp0001aPrebriefFreeze(input: unknown): Exp0001aPrebriefVerification {
  const parsed = exp0001aPrebriefFreezeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, executable: false, errors: parsed.error.issues.map((issue) => `${issue.path.join("/")}: ${issue.message}`) };
  }
  const receipt = parsed.data;
  const errors: string[] = [];
  const manifestVerification = verifyDevelopmentExecutionManifest(executionManifestJson);
  if (!manifestVerification.ok) errors.push(...manifestVerification.errors.map((error) => `manifest:${error}`));
  const profile = verifyDevelopmentRunnerProfile(runnerProfileJson);

  if (computeExp0001aPrebriefFreezeDigest(receipt) !== receipt.freezeDigest) errors.push("FREEZE_DIGEST_MISMATCH");
  if (receipt.schedule.manifestDigest !== executionManifestJson.manifestDigest) errors.push("MANIFEST_DIGEST_MISMATCH");
  if (receipt.schedule.benchmarkBundleDigest !== executionManifestJson.benchmark.bundleDigest) errors.push("BENCHMARK_DIGEST_MISMATCH");
  if (receipt.schedule.taskCommitmentsDigest !== hashCanonicalJson(executionManifestJson.tasks)) errors.push("TASK_COMMITMENTS_DIGEST_MISMATCH");
  if (receipt.schedule.fixedOrderDigest !== hashCanonicalJson(orderedAttemptIds())) errors.push("FIXED_ORDER_DIGEST_MISMATCH");
  if (receipt.schedule.treatmentDigest !== executionManifestJson.treatments.A0
      || receipt.schedule.treatmentDigest !== executionManifestJson.treatments.A1) errors.push("MANIFEST_TREATMENT_MISMATCH");
  const attemptIds = orderedAttemptIds();
  if (attemptIds.length !== 48 || new Set(attemptIds).size !== 48) errors.push("ATTEMPT_ORDER_NOT_EXACTLY_48_UNIQUE");

  if (hashCanonicalJson(receipt.conditions.A0) !== hashCanonicalJson(receipt.conditions.A1)) errors.push("AA_CONDITIONS_NOT_BYTE_IDENTICAL");
  if (receipt.conditions.configurationDigest !== hashCanonicalJson(receipt.conditions.A0)) errors.push("CONDITION_DIGEST_MISMATCH");
  const conditionText = JSON.stringify(receipt.conditions);
  if (/(?:baseline|candidate|control|treatment|conditionLabel|opaqueLabel|taskId|pairId)/i.test(conditionText)) {
    errors.push("CONDITION_LEAKAGE");
  }

  const expectedBudgets = {
    wallMs: profile.budgets.wallBudgetMs,
    toolCalls: profile.budgets.toolCallBudget,
    perToolTimeoutMs: profile.budgets.perToolTimeoutMs,
    inputTokens: profile.budgets.inputTokenBudget,
    outputTokens: profile.budgets.outputTokenBudget,
    perResponseOutputTokens: profile.budgets.perResponseMaxOutputTokens,
    correctionRounds: profile.budgets.maxCorrectionRounds,
  };
  if (hashCanonicalJson(receipt.conditions.A0.authorBudgets) !== hashCanonicalJson(expectedBudgets)) errors.push("AUTHOR_BUDGET_PROFILE_DRIFT");
  if (receipt.conditions.A0.runnerProfileDigest !== profile.profileDigest) errors.push("RUNNER_PROFILE_DIGEST_MISMATCH");
  if (receipt.conditions.A0.toolAllowlistDigest !== hashCanonicalJson(profile.allowedToolNames)) errors.push("TOOL_ALLOWLIST_DIGEST_MISMATCH");
  if (receipt.executionHost.dependencyResolution.packageManifestDigest !== receipt.frozenSources.packageManifest.fileDigest) {
    errors.push("PACKAGE_MANIFEST_DIGEST_MISMATCH");
  }
  if (receipt.executionHost.dependencyResolution.packageLockDigest !== receipt.frozenSources.packageLock.fileDigest) {
    errors.push("PACKAGE_LOCK_DIGEST_MISMATCH");
  }

  for (const [label, usage] of [
    ["author", receipt.evidenceBasis.author],
    ["primaryReviewer", receipt.evidenceBasis.primaryReviewer],
  ] as const) {
    if (usage.inputTokens !== usage.uncachedInputTokens + usage.cachedInputTokens + usage.cacheWriteInputTokens) {
      errors.push(`${label.toUpperCase()}_INPUT_USAGE_PARTITION_MISMATCH`);
    }
    if (usage.reasoningTokens > usage.outputTokens) errors.push(`${label.toUpperCase()}_REASONING_EXCEEDS_OUTPUT`);
    if (Math.abs(priceUsage(usage, receipt.pricing) - usage.estimatedCostUsd) > 1e-9) errors.push(`${label.toUpperCase()}_COST_MISMATCH`);
  }

  const roster = receipt.reviewerPlan.roster;
  if (new Set(roster.map((entry) => entry.reviewerId)).size !== roster.length
      || new Set(roster.map((entry) => entry.identityCommitment)).size !== roster.length) errors.push("REVIEWER_ROSTER_NOT_UNIQUE");
  const pairwisePlan = receipt.reviewerPlan.pairwisePreference;
  if (pairwisePlan.promptDigest === receipt.frozenSources.evaluatorInstructions.fileDigest) {
    errors.push("PAIRWISE_PROMPT_NOT_DISTINCT_FROM_INDIVIDUAL_EVALUATOR_INSTRUCTIONS");
  }
  if (pairwisePlan.promptDigest !== receipt.frozenSources.pairwisePreferenceInstructions.fileDigest) {
    errors.push("PAIRWISE_PROMPT_SOURCE_DIGEST_MISMATCH");
  }
  if (computePairwiseReviewerRosterRoot(pairwisePlan.roster) !== pairwisePlan.rosterRoot) {
    errors.push("PAIRWISE_REVIEWER_ROSTER_ROOT_MISMATCH");
  }
  const individualReviewerIds = new Set(roster.map((entry) => entry.reviewerId));
  const individualReviewerCommitments = new Set(roster.map((entry) => entry.identityCommitment));
  if (pairwisePlan.roster.some((entry) => (
    individualReviewerIds.has(entry.reviewerId) || individualReviewerCommitments.has(entry.identityCommitment)
  ))) errors.push("PAIRWISE_REVIEWER_ROSTER_OVERLAPS_INDIVIDUAL_ROSTER");
  const costs = receipt.costProjection;
  if (costs.diagnosticMaximumAuthorTurnInputTokens >= costs.longContextThresholdInputTokensPerRequest
      || costs.diagnosticLongContextSurchargeObserved) {
    errors.push("DIAGNOSTIC_LONG_CONTEXT_EVIDENCE_MISMATCH");
  }
  if (Math.abs(costs.expectedAuthorPerAttemptUsd * 48 - costs.expectedAuthor48Usd) > 1e-12) {
    errors.push("AUTHOR_EXPECTED_COST_MISMATCH");
  }
  if (Math.abs(costs.expectedPairwisePreferencePerCallUsd * 24 - costs.expectedPairwisePreferences24Usd) > 1e-12) {
    errors.push("PAIRWISE_EXPECTED_COST_MISMATCH");
  }
  if (Math.abs(costs.expectedWithPlanningAdjudicationsUsd + costs.expectedPairwisePreferences24Usd - costs.expectedTotalUsd) > 1e-12) {
    errors.push("EXPECTED_TOTAL_COST_MISMATCH");
  }
  if (Math.abs(costs.expectedTotalUsd * 1.5 - costs.sensitivityOnePointFiveXTotalUsd) > 1e-12) {
    errors.push("SENSITIVITY_TOTAL_COST_MISMATCH");
  }
  if (Math.abs(
    costs.configuredCapAuthor48Usd
      + costs.configuredCapPrimaryReviews96Usd
      + costs.configuredCapAdjudication48Usd
      + costs.configuredCapPairwisePreferences24Usd
      - costs.configuredCapTotalUsd,
  ) > 1e-12) errors.push("CONFIGURED_CAP_TOTAL_MISMATCH");

  const pending = receipt.pendingPrerequisites;
  if (pending.batchCoordinator.status !== "pending"
      || pending.batchCli.status !== "pending"
      || pending.batchCommandLibrary.status !== "pending"
      || pending.batchRegistryBridge.status !== "pending"
      || pending.cleanRoomBatchAdapter.status !== "pending"
      || pending.completionAttestation.status !== "pending"
      || pending.completionSignerCli.status !== "pending"
      || pending.atomicRegistryStore.status !== "pending"
      || pending.evaluatorRunner.status !== "pending"
      || pending.evaluatorSemanticEnvelopeReceipt.status !== "pending"
      || pending.executionAuthorityTrustAnchor.status !== "pending"
      || pending.launchAuthorityVerifier.status !== "pending"
      || pending.launchSignerCli.status !== "pending"
      || pending.liveReviewRunner.status !== "pending"
      || pending.adjudicationOrchestration.status !== "pending"
      || pending.analysisRuntime.status !== "pending"
      || pending.attemptMetrics.status !== "pending"
      || pending.attemptMetricsRegistry.status !== "pending"
      || pending.attemptMetricsSpec.status !== "pending"
      || pending.metricsRuntime.status !== "pending"
      || pending.perAttemptAliasVerifier.status !== "pending"
      || pending.pairwisePreference.status !== "pending"
      || pending.pairwisePreferenceInstructions.status !== "pending"
      || pending.pairwiseRuntime.status !== "pending"
      || pending.spendLedger.status !== "pending"
      || pending.runtimeComposition.status !== "pending"
      || pending.runtimeBuilder.status !== "pending"
      || pending.runtimeBundle.status !== "pending"
      || pending.runtimeDependencyReceipt.status !== "pending"
      || pending.runtimeDependencyVerifier.status !== "pending"
      || pending.reportCompiler.status !== "pending"
      || pending.experimentFreezeAdapter.status !== "pending"
      || pending.executionGate.status !== "pending"
      || pending.authorSessionIdentityManifest.status !== "pending"
      || pending.freshLiveReceipt.status !== "pending") errors.push("PREBRIEF_PREREQUISITE_NOT_PENDING");
  for (const role of [
    "batchCoordinator",
    "batchCli",
    "batchCommandLibrary",
    "batchRegistryBridge",
    "cleanRoomBatchAdapter",
    "completionAttestation",
    "completionSignerCli",
    "atomicRegistryStore",
    "evaluatorRunner",
    "evaluatorSemanticEnvelopeReceipt",
    "executionAuthorityTrustAnchor",
    "launchAuthorityVerifier",
    "launchSignerCli",
    "liveReviewRunner",
    "adjudicationOrchestration",
    "analysisRuntime",
    "attemptMetrics",
    "attemptMetricsRegistry",
    "attemptMetricsSpec",
    "metricsRuntime",
    "perAttemptAliasVerifier",
    "pairwisePreference",
    "pairwisePreferenceInstructions",
    "pairwiseRuntime",
    "spendLedger",
    "runtimeComposition",
    "runtimeBuilder",
    "runtimeBundle",
    "runtimeDependencyReceipt",
    "runtimeDependencyVerifier",
    "reportCompiler",
    "experimentFreezeAdapter",
    "executionGate",
    "authorSessionIdentityManifest",
  ] as const) {
    if (pending[role].path !== receipt.frozenSources[role].path) errors.push(`${role.toUpperCase()}_PENDING_PATH_MISMATCH`);
    if (pending[role].candidateObservedDigest !== receipt.frozenSources[role].fileDigest) {
      errors.push(`${role.toUpperCase()}_PENDING_DIGEST_MISMATCH`);
    }
  }
  if (receipt.frozenSources.authorSessionIdentityManifest.manifestRoot !== EXP0001A_AUTHOR_SESSION_IDENTITIES.manifestRoot) {
    errors.push("AUTHOR_SESSION_IDENTITY_MANIFEST_ROOT_MISMATCH");
  }
  if (receipt.executionGate.executable || receipt.briefReleaseAuthorized) errors.push("PREBRIEF_MUST_REMAIN_BLOCKED");

  const serialized = JSON.stringify(receipt);
  if (/sealed-test|replication-B|"(?:roomId|roomCode|sessionId|authorization|cookie|password|secret)"\s*:/i.test(serialized)) {
    errors.push("SENSITIVE_OR_NONDEVELOPMENT_MATERIAL_PRESENT");
  }

  return errors.length === 0
    ? { ok: true, receipt, executable: false }
    : { ok: false, errors, executable: false };
}

export function assertExp0001aExecutionReady(input: unknown): never {
  void input;
  throw new Error("EXP-0001A execution is blocked: commit every frozen execution-critical source and the author-session identity manifest, then commit a fresh post-freeze live receipt before releasing any brief.");
}

export const EXP0001A_PREBRIEF_FREEZE = (() => {
  const verification = verifyExp0001aPrebriefFreeze(freezeReceiptJson);
  if (!verification.ok) throw new Error(`Invalid EXP-0001A pre-brief freeze: ${verification.errors.join(", ")}`);
  return verification.receipt;
})();
