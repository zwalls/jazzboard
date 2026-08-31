import path from "node:path";

import { z } from "zod";

import type { AtomicRegistryStore } from "./atomic-registry-store";
import benchmarkJson from "../../../research/benchmarks/development-v1.json";
import fixtureSpecsJson from "../../../research/benchmarks/development-fixture-specs-v1.json";
import rubricsJson from "../../../research/benchmarks/development-evaluator-rubrics-v1.json";
import executionManifestJson from "../../../research/data/development-execution-manifest-v1.json";
import runnerProfileJson from "../../../research/data/development-runner-profile-v1.json";
import {
  aliasPreflightReceiptSchema,
  createDevelopmentAttemptConfig,
  type AliasPreflightReceipt,
  type DevelopmentAttemptConfig,
} from "./development-attempt-config";
import {
  developmentExecutionManifestSchema,
  verifyDevelopmentExecutionManifest,
  type DevelopmentExecutionManifest,
} from "./development-manifest";
import {
  experimentFreezeReceiptSchema,
  verifyExperimentFreezeReceipt,
  type ExperimentFreezeReceipt,
} from "./experiment-freeze";
import { compileBenchmarkTaskExecution, parseBenchmarkExecutionBundle } from "./benchmark-execution";
import {
  exp0001aPerAttemptAliasReceiptSchema,
  verifyExp0001aPerAttemptAliasReceipt,
  type Exp0001aPerAttemptAliasVerifier,
} from "./exp0001a-per-attempt-alias-verifier";
import { hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const rawDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z.string().datetime({ offset: true });
const PER_ATTEMPT_ALIAS_MAX_AGE_MS = 60_000;

export const providerUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  uncachedInputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict().superRefine((usage, context) => {
  if (usage.uncachedInputTokens + usage.cachedInputTokens + usage.cacheWriteInputTokens !== usage.inputTokens) {
    context.addIssue({ code: "custom", path: ["inputTokens"], message: "Input token classes must exactly reconcile to total input." });
  }
  if (usage.reasoningOutputTokens > usage.outputTokens) {
    context.addIssue({ code: "custom", path: ["reasoningOutputTokens"], message: "Reasoning output is already included in output tokens." });
  }
  if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    context.addIssue({ code: "custom", path: ["totalTokens"], message: "Total tokens must equal input plus output." });
  }
});

export const providerPricingSchema = z.object({
  currency: z.literal("USD"),
  inputUsdPerMillionTokens: z.number().nonnegative(),
  cachedInputUsdPerMillionTokens: z.number().nonnegative(),
  cacheWriteInputUsdPerMillionTokens: z.number().nonnegative(),
  outputUsdPerMillionTokens: z.number().nonnegative(),
  source: idSchema,
}).strict();

export const providerIdentityObservationSchema = z.object({
  provider: z.literal("openai_responses"),
  requestedModelIdentifier: idSchema,
  requestedServiceTier: z.literal("default"),
  immutableModelSnapshotVerified: z.literal(false),
  completedTurns: z.number().int().nonnegative(),
  status: z.enum(["observed", "unobservable", "falsified"]),
  observedModelIdentifiers: z.array(idSchema),
  observedServiceTiers: z.array(idSchema),
  requestedAliasExactMatch: z.boolean(),
}).strict();

const retainedArtifactSchema = z.object({
  path: z.string().min(1).max(1_024).refine((value) => (
    !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part && part !== "." && part !== "..")
  ), "Artifact paths must be safe and relative."),
  bytes: z.number().int().nonnegative(),
  sha256: rawDigestSchema,
}).strict();

export const executorResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("not_started"),
    at: timestampSchema,
    incidentCode: idSchema,
    message: z.string().min(1).max(2_000),
    hardIncident: z.boolean(),
    falsification: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("begun"),
    finishedAt: timestampSchema,
    outcome: z.enum(["completed", "failed", "timeout", "infra_failure", "policy_violation"]),
    usage: providerUsageSchema,
    usageByTurn: z.array(providerUsageSchema).max(10_000),
    artifacts: z.array(retainedArtifactSchema),
    artifactRoot: rawDigestSchema.nullable(),
    authorEvidenceRoot: rawDigestSchema.nullable(),
    attemptBundleSha256: rawDigestSchema.nullable(),
    authorIdentityCommitment: digestSchema,
    authorIdentityArtifactSha256: digestSchema,
    costObservability: z.enum(["observed", "attested_no_provider_call", "unobservable"]),
    providerEvidenceDigest: digestSchema,
    providerIdentity: providerIdentityObservationSchema,
    hardIncident: z.boolean(),
    falsification: z.boolean(),
    incidentCode: idSchema.nullable(),
  }).strict(),
]).superRefine((result, context) => {
  if (result.kind !== "begun") return;
  const summed = result.usageByTurn.reduce<ProviderUsage>((total, turn) => ({
    inputTokens: total.inputTokens + turn.inputTokens,
    uncachedInputTokens: total.uncachedInputTokens + turn.uncachedInputTokens,
    cachedInputTokens: total.cachedInputTokens + turn.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens + turn.cacheWriteInputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens + turn.reasoningOutputTokens,
    totalTokens: total.totalTokens + turn.totalTokens,
  }), {
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  });
  for (const field of Object.keys(summed) as Array<keyof ProviderUsage>) {
    if (summed[field] !== result.usage[field]) {
      context.addIssue({
        code: "custom",
        path: ["usageByTurn"],
        message: `Per-turn ${field} must exactly reconcile to aggregate usage.`,
      });
    }
  }
  if (result.usageByTurn.length !== result.providerIdentity.completedTurns) {
    context.addIssue({
      code: "custom",
      path: ["usageByTurn"],
      message: "Per-turn usage count must equal providerIdentity.completedTurns.",
    });
  }
  if (result.costObservability === "attested_no_provider_call"
      && (result.usageByTurn.length !== 0 || result.usage.totalTokens !== 0)) {
    context.addIssue({
      code: "custom",
      path: ["costObservability"],
      message: "A no-provider-call attestation cannot contain provider usage.",
    });
  }
});

export type ProviderUsage = z.infer<typeof providerUsageSchema>;
export type ProviderPricing = z.infer<typeof providerPricingSchema>;
export type BatchExecutorResult = z.infer<typeof executorResultSchema>;

const eventMetadata = {
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  at: timestampSchema,
  previousEventDigest: digestSchema.nullable(),
  eventDigest: digestSchema,
};

const assignmentRegisteredEventSchema = z.object({
  ...eventMetadata,
  kind: z.literal("assignment_registered"),
  attemptId: idSchema,
  data: z.object({
    manifestPosition: z.number().int().min(0).max(47),
    pairId: idSchema,
    taskId: idSchema,
    replicateIndex: z.union([z.literal(0), z.literal(1)]),
    timeBlock: z.number().int().min(0).max(23),
    orderIndex: z.union([z.literal(0), z.literal(1)]),
    opaqueLabel: z.enum(["A0", "A1"]),
    configDigest: digestSchema,
  }).strict(),
}).strict();

const notStartedEventSchema = z.object({
  ...eventMetadata,
  kind: z.literal("not_started"),
  attemptId: idSchema,
  data: z.object({
    incidentCode: idSchema,
    message: z.string().min(1).max(2_000),
    hardIncident: z.boolean(),
    falsification: z.boolean(),
  }).strict(),
}).strict();

const briefDeliveredEventSchema = z.object({
  ...eventMetadata,
  kind: z.literal("brief_delivered"),
  attemptId: idSchema,
  data: z.object({ briefDigest: digestSchema }).strict(),
}).strict();

const aliasVerifiedEventSchema = z.object({
  ...eventMetadata,
  kind: z.literal("alias_verified"),
  attemptId: idSchema,
  data: z.object({ receipt: exp0001aPerAttemptAliasReceiptSchema }).strict(),
}).strict();

const attemptRetainedEventSchema = z.object({
  ...eventMetadata,
  kind: z.literal("attempt_retained"),
  attemptId: idSchema,
  data: z.object({
    executorOutcome: z.enum(["completed", "failed", "timeout", "infra_failure", "policy_violation", "executor_threw"]),
    retainedOutcome: z.enum(["completed", "failed", "timeout", "infra_failure", "policy_violation"]),
    usage: providerUsageSchema.nullable(),
    usageByTurn: z.array(providerUsageSchema).nullable(),
    pricing: providerPricingSchema,
    actualCostUsd: z.number().nonnegative().nullable(),
    costObservability: z.enum(["observed", "attested_no_provider_call", "unobservable"]),
    providerEvidenceDigest: digestSchema.nullable(),
    providerIdentity: providerIdentityObservationSchema.nullable(),
    artifacts: z.array(retainedArtifactSchema),
    artifactRoot: rawDigestSchema.nullable(),
    authorEvidenceRoot: rawDigestSchema.nullable(),
    attemptBundleSha256: rawDigestSchema.nullable(),
    authorIdentityCommitment: digestSchema,
    authorIdentityArtifactSha256: digestSchema.nullable(),
    missingArtifacts: z.array(z.string()),
    duplicateArtifactPaths: z.array(z.string()),
    evidenceComplete: z.boolean(),
    hardIncident: z.boolean(),
    falsification: z.boolean(),
    incidentCode: idSchema.nullable(),
  }).strict(),
}).strict();

const hardStopEventSchema = z.object({
  ...eventMetadata,
  kind: z.literal("hard_stop"),
  attemptId: idSchema,
  data: z.object({
    reason: idSchema,
    sourceEventDigest: digestSchema,
  }).strict(),
}).strict();

export const batchRegistryEventSchema = z.discriminatedUnion("kind", [
  assignmentRegisteredEventSchema,
  notStartedEventSchema,
  aliasVerifiedEventSchema,
  briefDeliveredEventSchema,
  attemptRetainedEventSchema,
  hardStopEventSchema,
]);

const batchRegistryContentSchema = z.object({
  schemaVersion: z.literal(1),
  registryId: idSchema,
  createdAt: timestampSchema,
  manifestDigest: digestSchema,
  runnerProfileDigest: digestSchema,
  executionFreezeDigest: digestSchema,
  livePreflightDigest: digestSchema,
  planDigest: digestSchema,
  pricing: providerPricingSchema,
  events: z.array(batchRegistryEventSchema).min(48),
}).strict();

export const batchRegistrySchema = batchRegistryContentSchema.extend({
  registryDigest: digestSchema,
}).strict();

export type BatchRegistryEvent = z.infer<typeof batchRegistryEventSchema>;
export type BatchRegistry = z.infer<typeof batchRegistrySchema>;

export type Exp0001aBatchPlan = {
  manifest: DevelopmentExecutionManifest;
  executionFreeze: ExperimentFreezeReceipt;
  livePreflight: AliasPreflightReceipt;
  pricing: ProviderPricing;
  authorIdentityCommitmentsDigest: string;
  configs: DevelopmentAttemptConfig[];
  planDigest: string;
};

export type AuthorIdentityCommitmentManifest = Readonly<Record<string, string>>;

const REQUIRED_BEGUN_ARTIFACTS = Object.freeze([
  "attempt-bundle.json",
  "author-brief.json",
  "author-events.jsonl",
  "author-final.json",
  "author-identity-commitment.json",
  "coordinator-events.jsonl",
]);

const REQUIRED_EVALUATOR_ARTIFACTS = Object.freeze([
  ...REQUIRED_BEGUN_ARTIFACTS,
  "author-evidence-seal.json",
  "participant-tool-contract.json",
  "spectator-final-state.json",
  "spectator-inspection.json",
  "spectator-tool-contract.json",
]);
const SPECTATOR_FINAL_PIXEL = /^spectator-final-r\d+\.png$/;

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

function eventDigest(event: Omit<BatchRegistryEvent, "eventDigest"> | BatchRegistryEvent): string {
  return hashCanonicalJson(withoutKey(event as unknown as Record<string, unknown>, "eventDigest"));
}

function registryDigest(registry: Omit<BatchRegistry, "registryDigest"> | BatchRegistry): string {
  return hashCanonicalJson(withoutKey(registry as unknown as Record<string, unknown>, "registryDigest"));
}

function registryDigestBeforeEvent(registry: BatchRegistry, sequence: number): string {
  const content = batchRegistryContentSchema.parse({
    ...withoutKey(registry as unknown as Record<string, unknown>, "registryDigest"),
    events: registry.events.slice(0, sequence),
  });
  return registryDigest(content);
}

function appendEvent(
  registryInput: BatchRegistry,
  eventInput: Omit<BatchRegistryEvent, "schemaVersion" | "sequence" | "previousEventDigest" | "eventDigest">,
): BatchRegistry {
  const registry = batchRegistrySchema.parse(registryInput);
  const unsigned = {
    schemaVersion: 1 as const,
    sequence: registry.events.length,
    ...eventInput,
    previousEventDigest: registry.events.at(-1)?.eventDigest ?? null,
  };
  const event = batchRegistryEventSchema.parse({ ...unsigned, eventDigest: eventDigest(unsigned as Omit<BatchRegistryEvent, "eventDigest">) });
  const content = batchRegistryContentSchema.parse({
    ...withoutKey(registry as unknown as Record<string, unknown>, "registryDigest"),
    events: [...registry.events, event],
  });
  return batchRegistrySchema.parse({ ...content, registryDigest: registryDigest(content) });
}

function orderedAssignments(manifest: DevelopmentExecutionManifest) {
  return [...manifest.assignments]
    .sort((left, right) => left.timeBlock - right.timeBlock)
    .flatMap((pair) => [...pair.attempts]
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((attempt) => ({ pair, attempt })));
}

function validateAuthorIdentityCommitments(
  input: AuthorIdentityCommitmentManifest,
  attemptIds: readonly string[],
): Readonly<Record<string, string>> {
  const parsed = z.record(z.string(), digestSchema).parse(input);
  const actualIds = Object.keys(parsed);
  const expectedSet = new Set(attemptIds);
  const missing = attemptIds.filter((attemptId) => !(attemptId in parsed));
  const extra = actualIds.filter((attemptId) => !expectedSet.has(attemptId));
  if (missing.length > 0 || extra.length > 0 || actualIds.length !== attemptIds.length) {
    throw new Error(`Author identity manifest must cover the exact frozen attempt set (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`);
  }
  const ordered = Object.fromEntries(attemptIds.map((attemptId) => [attemptId, parsed[attemptId]]));
  if (new Set(Object.values(ordered)).size !== attemptIds.length) {
    throw new Error("Author identity manifest must assign one unique commitment to every frozen attempt.");
  }
  return Object.freeze(ordered);
}

function assertFreezeMatchesFrozenPlan(
  freeze: ExperimentFreezeReceipt,
  manifest: DevelopmentExecutionManifest,
  configs: readonly DevelopmentAttemptConfig[],
): void {
  const profile = runnerProfileJson;
  const fail = (message: string): never => { throw new Error(`Execution freeze does not match EXP-0001A: ${message}`); };
  if (freeze.studyKind !== "aa_calibration" || freeze.partition !== "development") fail("study kind or partition drifted.");
  if (freeze.commitments.randomizationSchedule.digest !== manifest.manifestDigest) fail("randomization schedule digest drifted.");
  if (freeze.commitments.taskManifest.digest !== manifest.benchmark.bundleDigest) fail("task manifest digest drifted.");
  if (freeze.model.snapshot !== profile.model.id || freeze.model.reasoningEffort !== profile.model.reasoningEffort) fail("model condition drifted.");
  if (freeze.model.sampling.temperature !== null || freeze.model.sampling.topP !== null || freeze.model.sampling.seed !== null) {
    fail("sampling must remain at the frozen provider defaults.");
  }
  if (freeze.budgets.wallTimeMs !== profile.budgets.wallBudgetMs
    || freeze.budgets.maxInputTokens !== profile.budgets.inputTokenBudget
    || freeze.budgets.maxOutputTokens !== profile.budgets.outputTokenBudget
    || freeze.budgets.maxToolCalls !== profile.budgets.toolCallBudget
    || freeze.budgets.maxCorrectionRounds !== profile.budgets.maxCorrectionRounds) fail("budget condition drifted.");
  if (freeze.environment.viewport.width !== profile.viewport.width
    || freeze.environment.viewport.height !== profile.viewport.height
    || freeze.environment.viewport.deviceScaleFactor !== profile.viewport.deviceScaleFactor
    || freeze.environment.locale !== profile.viewport.locale
    || freeze.environment.timezone !== profile.viewport.timezone
    || freeze.environment.browser.version !== profile.browser.version) fail("browser or viewport condition drifted.");
  const labels = new Set([freeze.conditions.first.opaqueLabel, freeze.conditions.second.opaqueLabel]);
  if (labels.size !== 2 || !labels.has("A0") || !labels.has("A1")) fail("opaque condition labels drifted.");
  if (new Set(configs.map((config) => config.treatmentConfigurationDigest)).size !== 1) fail("A/A configs are not treatment-identical.");
}

export function createExp0001aBatchPlan(input: {
  executionFreeze: unknown;
  livePreflight: unknown;
  pricing: unknown;
  authorIdentityCommitments: AuthorIdentityCommitmentManifest;
  manifest?: unknown;
}): Exp0001aBatchPlan {
  const manifestVerification = verifyDevelopmentExecutionManifest(input.manifest ?? executionManifestJson, benchmarkJson);
  if (!manifestVerification.ok) throw new Error(`Frozen execution manifest is invalid: ${manifestVerification.errors.join(" ")}`);
  const freezeVerification = verifyExperimentFreezeReceipt(input.executionFreeze, { firstBriefDeliveredAt: null });
  if (!freezeVerification.ok) throw new Error(`Execution freeze is invalid: ${freezeVerification.errors.join(" ")}`);
  const livePreflight = aliasPreflightReceiptSchema.parse(input.livePreflight);
  const pricing = providerPricingSchema.parse(input.pricing);
  const assignments = orderedAssignments(manifestVerification.manifest);
  const authorIdentityCommitments = validateAuthorIdentityCommitments(
    input.authorIdentityCommitments,
    assignments.map(({ attempt }) => attempt.attemptId),
  );
  const authorIdentityCommitmentsDigest = hashCanonicalJson(assignments.map(({ attempt }) => ({
    attemptId: attempt.attemptId,
    identityCommitment: authorIdentityCommitments[attempt.attemptId],
  })));
  const configs = assignments.map(({ attempt }) => createDevelopmentAttemptConfig({
    attemptId: attempt.attemptId,
    authorIdentityCommitment: authorIdentityCommitments[attempt.attemptId],
    aliasPreflight: livePreflight,
    manifest: input.manifest ?? executionManifestJson,
    runnerProfile: runnerProfileJson,
  }));
  assertFreezeMatchesFrozenPlan(freezeVerification.receipt, manifestVerification.manifest, configs);
  const planContent = {
    manifestDigest: manifestVerification.manifest.manifestDigest,
    runnerProfileDigest: runnerProfileJson.profileDigest,
    executionFreezeDigest: freezeVerification.receipt.freezeDigest,
    livePreflightDigest: hashCanonicalJson(livePreflight),
    authorIdentityCommitmentsDigest,
    pricing,
    assignments: configs.map((config, manifestPosition) => ({
      manifestPosition,
      attemptId: config.attempt.attemptId,
      configDigest: config.configDigest,
    })),
  };
  return {
    manifest: manifestVerification.manifest,
    executionFreeze: freezeVerification.receipt,
    livePreflight,
    pricing,
    authorIdentityCommitmentsDigest,
    configs,
    planDigest: hashCanonicalJson(planContent),
  };
}

export function initializeExp0001aBatchRegistry(plan: Exp0001aBatchPlan, createdAt: string): BatchRegistry {
  timestampSchema.parse(createdAt);
  let events: BatchRegistryEvent[] = [];
  for (const [manifestPosition, config] of plan.configs.entries()) {
    const unsigned = {
      schemaVersion: 1 as const,
      sequence: manifestPosition,
      at: createdAt,
      kind: "assignment_registered" as const,
      attemptId: config.attempt.attemptId,
      data: {
        manifestPosition,
        pairId: config.attempt.pairId,
        taskId: config.attempt.taskId,
        replicateIndex: config.attempt.replicateIndex,
        timeBlock: config.attempt.timeBlock,
        orderIndex: config.attempt.orderIndex,
        opaqueLabel: config.attempt.opaqueLabel,
        configDigest: config.configDigest,
      },
      previousEventDigest: events.at(-1)?.eventDigest ?? null,
    };
    events = [...events, batchRegistryEventSchema.parse({ ...unsigned, eventDigest: eventDigest(unsigned) })];
  }
  const content = batchRegistryContentSchema.parse({
    schemaVersion: 1,
    registryId: `registry-${plan.livePreflight.batchId}`,
    createdAt,
    manifestDigest: plan.manifest.manifestDigest,
    runnerProfileDigest: runnerProfileJson.profileDigest,
    executionFreezeDigest: plan.executionFreeze.freezeDigest,
    livePreflightDigest: hashCanonicalJson(plan.livePreflight),
    planDigest: plan.planDigest,
    pricing: plan.pricing,
    events,
  });
  return batchRegistrySchema.parse({ ...content, registryDigest: registryDigest(content) });
}

export function verifyExp0001aBatchRegistry(registryInput: unknown, plan: Exp0001aBatchPlan): BatchRegistry {
  const registry = batchRegistrySchema.parse(registryInput);
  if (registry.registryDigest !== registryDigest(registry)) throw new Error("Batch registry digest is invalid.");
  if (registry.manifestDigest !== plan.manifest.manifestDigest
    || registry.runnerProfileDigest !== runnerProfileJson.profileDigest
    || registry.executionFreezeDigest !== plan.executionFreeze.freezeDigest
    || registry.livePreflightDigest !== hashCanonicalJson(plan.livePreflight)
    || registry.planDigest !== plan.planDigest
    || hashCanonicalJson(registry.pricing) !== hashCanonicalJson(plan.pricing)) throw new Error("Batch registry identity does not match the frozen plan.");
  registry.events.forEach((event, index) => {
    if (event.sequence !== index) throw new Error(`Registry event ${index} has a non-append sequence.`);
    if (event.previousEventDigest !== (registry.events[index - 1]?.eventDigest ?? null)) throw new Error(`Registry event ${index} breaks the hash chain.`);
    if (event.eventDigest !== eventDigest(event)) throw new Error(`Registry event ${index} digest is invalid.`);
  });
  const registered = registry.events.filter((event): event is z.infer<typeof assignmentRegisteredEventSchema> => event.kind === "assignment_registered");
  if (registered.length !== 48) throw new Error("Registry must retain exactly 48 frozen assignment registrations.");
  registered.forEach((event, index) => {
    const config = plan.configs[index];
    if (registry.events[index] !== event
      || event.attemptId !== config.attempt.attemptId
      || event.data.manifestPosition !== index
      || event.data.configDigest !== config.configDigest) {
      throw new Error(`Registry assignment ${index} does not match manifest order.`);
    }
  });
  const manifestPositionByAttemptId = new Map(plan.configs.map((config, index) => [config.attempt.attemptId, index]));
  let lastLifecyclePosition = 0;
  for (const event of registry.events.slice(48)) {
    const manifestPosition = manifestPositionByAttemptId.get(event.attemptId);
    if (manifestPosition === undefined) throw new Error(`Registry contains lifecycle evidence for unknown attempt ${event.attemptId}.`);
    if (manifestPosition < lastLifecyclePosition) throw new Error("Registry lifecycle events do not follow frozen manifest order.");
    lastLifecyclePosition = manifestPosition;
  }
  const hardStops = registry.events.filter((event) => event.kind === "hard_stop");
  if (hardStops.length > 1 || (hardStops.length === 1 && hardStops[0] !== registry.events.at(-1))) throw new Error("A hard stop must be unique and final.");
  if (hardStops.length === 1) {
    const hardStop = hardStops[0];
    const source = registry.events.at(-2);
    if (!source
      || source.eventDigest !== hardStop.data.sourceEventDigest
      || source.attemptId !== hardStop.attemptId
      || Date.parse(hardStop.at) < Date.parse(source.at)) {
      throw new Error("A hard stop must immediately and monotonically bind its same-attempt source event.");
    }
  }
  let activePosition = 0;
  for (const config of plan.configs) {
    const lifecycle = registry.events.filter((event) => event.attemptId === config.attempt.attemptId && event.kind !== "assignment_registered" && event.kind !== "hard_stop");
    const briefs = lifecycle.filter((event) => event.kind === "brief_delivered");
    const retained = lifecycle.filter((event) => event.kind === "attempt_retained");
    const aliasReceipts = lifecycle.filter((event) => event.kind === "alias_verified");
    if (briefs.length > 1 || retained.length > 1) throw new Error(`Attempt ${config.attempt.attemptId} has duplicate lifecycle records.`);
    if (retained.length && !briefs.length) throw new Error(`Attempt ${config.attempt.attemptId} was retained without brief delivery.`);
    for (const event of retained) {
      if (event.kind !== "attempt_retained") continue;
      const identityArtifact = event.data.artifacts.find((artifact) => artifact.path === "author-identity-commitment.json");
      if (event.data.authorIdentityCommitment !== config.runnerConfig.authorIdentityCommitment
          || (event.data.authorIdentityArtifactSha256 !== null
            && (!identityArtifact || `sha256:${identityArtifact.sha256}` !== event.data.authorIdentityArtifactSha256))) {
        throw new Error(`Attempt ${config.attempt.attemptId} author identity differs from its frozen runner configuration.`);
      }
    }
    for (const aliasEvent of aliasReceipts) {
      if (aliasEvent.kind !== "alias_verified") continue;
      verifyExp0001aPerAttemptAliasReceipt(aliasEvent.data.receipt, {
        attemptId: config.attempt.attemptId,
        manifestPosition: plan.configs.indexOf(config),
        deploymentId: plan.livePreflight.resolvedDeploymentId,
        releaseGateRequestedAt: aliasEvent.data.receipt.releaseGateRequestedAt,
        releaseGateRegistryDigest: registryDigestBeforeEvent(registry, aliasEvent.sequence),
      });
      if (aliasEvent.at !== aliasEvent.data.receipt.verifiedAt) {
        throw new Error(`Attempt ${config.attempt.attemptId} alias event timestamp differs from its signed receipt.`);
      }
    }

    // Exact frozen author lifecycle grammar:
    //   (not_started | alias_verified, not_started)*, then either
    //   nothing | alias_verified | alias_verified, brief_delivered |
    //   alias_verified, brief_delivered, attempt_retained.
    // A standalone not_started is provider-free runner/setup or release-gate
    // evidence produced before any effective alias receipt. This rejects
    // self-hashed reordering, duplicate/extra events, and post-brief incidents.
    let lifecycleIndex = 0;
    while (lifecycleIndex < lifecycle.length) {
      if (lifecycle[lifecycleIndex]?.kind === "not_started") {
        lifecycleIndex += 1;
        continue;
      }
      if (lifecycle[lifecycleIndex]?.kind === "alias_verified"
          && lifecycle[lifecycleIndex + 1]?.kind === "not_started") {
        lifecycleIndex += 2;
        continue;
      }
      break;
    }
    const remaining = lifecycle.slice(lifecycleIndex);
    const isTransientAliasTail = remaining.length === 1
      && remaining[0].kind === "alias_verified"
      && registry.events.at(-1)?.eventDigest === remaining[0].eventDigest;
    const isUnresolvedBegun = remaining.length === 2
      && remaining[0].kind === "alias_verified"
      && remaining[1].kind === "brief_delivered";
    const isRetained = remaining.length === 3
      && remaining[0].kind === "alias_verified"
      && remaining[1].kind === "brief_delivered"
      && remaining[2].kind === "attempt_retained";
    if (remaining.length !== 0
      && !isTransientAliasTail
      && !isUnresolvedBegun
      && !isRetained) {
      throw new Error(`Attempt ${config.attempt.attemptId} violates the frozen alias-before-brief-before-retained lifecycle.`);
    }
    if (briefs.length) {
      const brief = briefs[0];
      const briefIndex = lifecycle.indexOf(brief);
      const effectiveAlias = lifecycle[briefIndex - 1];
      if (!effectiveAlias || effectiveAlias.kind !== "alias_verified") {
        throw new Error(`Attempt ${config.attempt.attemptId} lacks exactly one immediate pre-brief alias verification.`);
      }
      const ageMs = Date.parse(brief.at) - Date.parse(effectiveAlias.data.receipt.verifiedAt);
      if (ageMs < 0 || ageMs > PER_ATTEMPT_ALIAS_MAX_AGE_MS) {
        throw new Error(`Attempt ${config.attempt.attemptId} alias verification was not fresh at brief delivery.`);
      }
      if (brief.data.briefDigest !== config.hashes.brief) {
        throw new Error(`Attempt ${config.attempt.attemptId} brief digest differs from its frozen author brief.`);
      }
      if (retained.length && Date.parse(retained[0].at) < Date.parse(brief.at)) {
        throw new Error(`Attempt ${config.attempt.attemptId} was retained before its author brief was delivered.`);
      }
    }
    const progressed = briefs.length > 0 || retained.length > 0 || lifecycle.some((event) => event.kind === "not_started");
    if (progressed && plan.configs.indexOf(config) > activePosition) throw new Error("Registry skips manifest order.");
    if (retained.length) activePosition += 1;
    else if (progressed) activePosition = plan.configs.indexOf(config);
  }
  return registry;
}

/** Dedicated commitment over the one fresh alias receipt that immediately
 * precedes each of the 48 delivered author briefs. Earlier no-brief incident
 * receipts remain append-only evidence but are deliberately outside this root. */
export function computeExp0001aEffectiveAliasVerificationRoot(
  registryInput: BatchRegistry,
  plan: Exp0001aBatchPlan,
): string {
  const registry = verifyExp0001aBatchRegistry(registryInput, plan);
  const receiptDigests = plan.configs.map((config) => {
    const lifecycle = registry.events.filter((event) => (
      event.attemptId === config.attempt.attemptId
      && event.kind !== "assignment_registered"
      && event.kind !== "hard_stop"
    ));
    const briefIndex = lifecycle.findIndex((event) => event.kind === "brief_delivered");
    if (briefIndex < 1 || lifecycle[briefIndex - 1]?.kind !== "alias_verified") {
      throw new Error(`Attempt ${config.attempt.attemptId} lacks a committed effective alias receipt.`);
    }
    const aliasEvent = lifecycle[briefIndex - 1];
    if (aliasEvent.kind !== "alias_verified") throw new Error("Alias receipt narrowing failed.");
    return aliasEvent.data.receipt.receiptDigest;
  });
  if (receiptDigests.length !== 48 || new Set(receiptDigests).size !== 48) {
    throw new Error("EXP-0001A requires 48 unique effective per-attempt alias receipts.");
  }
  return hashCanonicalJson({
    schemaVersion: "exp-0001a-effective-alias-verification-root/v1",
    protocolId: "EXP-0001A",
    manifestDigest: plan.manifest.manifestDigest,
    receiptDigests,
  });
}

export type BatchDenominator = {
  plannedAssignments: 48;
  begunAttempts: number;
  retainedAuthorAttempts: number;
  completedAttempts: number;
  failedAttempts: number;
  unresolvedBegunAttempts: number;
  remainingUnbegunAssignments: number;
  notStartedIncidentEvents: number;
  knownCostAttempts: number;
  actualCostUsd: number;
};

export function summarizeBatchDenominator(registryInput: BatchRegistry, plan: Exp0001aBatchPlan): BatchDenominator {
  const registry = verifyExp0001aBatchRegistry(registryInput, plan);
  const begun = new Set(registry.events.filter((event) => event.kind === "brief_delivered").map((event) => event.attemptId));
  const retained = registry.events.filter((event): event is z.infer<typeof attemptRetainedEventSchema> => event.kind === "attempt_retained");
  const knownCosts = retained.filter((event) => event.data.actualCostUsd !== null);
  return {
    plannedAssignments: 48,
    begunAttempts: begun.size,
    retainedAuthorAttempts: retained.length,
    completedAttempts: retained.filter((event) => event.data.retainedOutcome === "completed").length,
    failedAttempts: retained.filter((event) => event.data.retainedOutcome !== "completed").length,
    unresolvedBegunAttempts: [...begun].filter((attemptId) => !retained.some((event) => event.attemptId === attemptId)).length,
    remainingUnbegunAssignments: 48 - begun.size,
    notStartedIncidentEvents: registry.events.filter((event) => event.kind === "not_started").length,
    knownCostAttempts: knownCosts.length,
    actualCostUsd: Number(knownCosts.reduce((total, event) => total + event.data.actualCostUsd!, 0).toFixed(12)),
  };
}

export function computeActualProviderCost(usageInput: unknown, pricingInput: unknown): number {
  const usage = providerUsageSchema.parse(usageInput);
  const pricing = providerPricingSchema.parse(pricingInput);
  return Number(((
    usage.uncachedInputTokens * pricing.inputUsdPerMillionTokens
    + usage.cachedInputTokens * pricing.cachedInputUsdPerMillionTokens
    + usage.cacheWriteInputTokens * pricing.cacheWriteInputUsdPerMillionTokens
    + usage.outputTokens * pricing.outputUsdPerMillionTokens
  ) / 1_000_000).toFixed(12));
}

/** Price each Responses request independently because GPT-5.6 long-context
 * rates apply to the whole request once that turn exceeds 272K input tokens. */
export function computeActualProviderTurnCost(turnsInput: readonly unknown[], pricingInput: unknown): number {
  const pricing = providerPricingSchema.parse(pricingInput);
  const turns = turnsInput.map((turn) => providerUsageSchema.parse(turn));
  return Number(turns.reduce((total, usage) => {
    const longContext = usage.inputTokens > 272_000;
    const inputMultiplier = longContext ? 2 : 1;
    const outputMultiplier = longContext ? 1.5 : 1;
    return total + (
      usage.uncachedInputTokens * pricing.inputUsdPerMillionTokens * inputMultiplier
      + usage.cachedInputTokens * pricing.cachedInputUsdPerMillionTokens * inputMultiplier
      + usage.cacheWriteInputTokens * pricing.cacheWriteInputUsdPerMillionTokens * inputMultiplier
      + usage.outputTokens * pricing.outputUsdPerMillionTokens * outputMultiplier
    ) / 1_000_000;
  }, 0).toFixed(12));
}

export type ResumeDecision =
  | { safe: true; complete: false; nextManifestPosition: number; attemptId: string }
  | { safe: true; complete: true; nextManifestPosition: null; attemptId: null }
  | { safe: false; complete: false; nextManifestPosition: number | null; attemptId: string | null; reason: string };

export function determineSafeResume(registryInput: BatchRegistry, plan: Exp0001aBatchPlan): ResumeDecision {
  const registry = verifyExp0001aBatchRegistry(registryInput, plan);
  if (registry.events.some((event) => event.kind === "hard_stop")) {
    return { safe: false, complete: false, nextManifestPosition: null, attemptId: null, reason: "BATCH_HARD_STOPPED" };
  }
  for (const [position, config] of plan.configs.entries()) {
    const events = registry.events.filter((event) => event.attemptId === config.attempt.attemptId);
    if (events.some((event) => event.kind === "attempt_retained")) continue;
    if (events.some((event) => event.kind === "brief_delivered")) {
      return { safe: false, complete: false, nextManifestPosition: position, attemptId: config.attempt.attemptId, reason: "BEGUN_ATTEMPT_NOT_RETAINED" };
    }
    return { safe: true, complete: false, nextManifestPosition: position, attemptId: config.attempt.attemptId };
  }
  return { safe: true, complete: true, nextManifestPosition: null, attemptId: null };
}

export type BatchAttemptExecutor = (
  config: DevelopmentAttemptConfig,
  controls: { onBriefDelivered: (at: string) => Promise<string> },
) => Promise<unknown>;

function artifactProblems(
  result: z.infer<typeof executorResultSchema> & { kind: "begun" },
  expectedAuthorIdentityCommitment: string,
) {
  const paths = result.artifacts.map((artifact) => artifact.path);
  const duplicateArtifactPaths = [...new Set(paths.filter((value, index) => paths.indexOf(value) !== index))].sort();
  const required = result.outcome === "completed" ? REQUIRED_EVALUATOR_ARTIFACTS : REQUIRED_BEGUN_ARTIFACTS;
  const missingArtifacts = required.filter((requiredPath) => !paths.includes(requiredPath));
  const identityArtifacts = result.artifacts.filter((artifact) => artifact.path === "author-identity-commitment.json");
  if (result.authorIdentityCommitment !== expectedAuthorIdentityCommitment
      || identityArtifacts.length !== 1
      || `sha256:${identityArtifacts[0].sha256}` !== result.authorIdentityArtifactSha256) {
    missingArtifacts.push("author-identity-commitment-integrity");
  }
  if (result.outcome === "completed" && paths.filter((candidate) => SPECTATOR_FINAL_PIXEL.test(candidate)).length !== 1) {
    missingArtifacts.push("spectator-final-r<revision>.png");
  }
  if (result.outcome === "completed" && result.artifacts.length > 0
    && (!result.artifactRoot || !result.authorEvidenceRoot || !result.attemptBundleSha256)) {
    missingArtifacts.push("evidence-root-commitments");
  }
  return { duplicateArtifactPaths, missingArtifacts: [...new Set(missingArtifacts)].sort() };
}

function appendHardStop(registry: BatchRegistry, attemptId: string, at: string, reason: string, sourceEventDigest: string): BatchRegistry {
  return appendEvent(registry, {
    kind: "hard_stop",
    attemptId,
    at,
    data: { reason, sourceEventDigest },
  });
}

export async function runExp0001aBatch(input: {
  plan: Exp0001aBatchPlan;
  registry: BatchRegistry;
  mode?: "dry-run" | "execute";
  executionAuthorized?: boolean;
  executor?: BatchAttemptExecutor;
  verifyAliasBeforeAttempt?: Exp0001aPerAttemptAliasVerifier;
  existingArtifactPaths?: Readonly<Record<string, readonly string[]>>;
  maxAssignments?: number;
  registryStore?: AtomicRegistryStore<BatchRegistry>;
  afterRegistryPersisted?: (registry: BatchRegistry, cause: string) => Promise<void>;
}): Promise<{
  mode: "dry-run" | "execute";
  registry: BatchRegistry;
  plannedConfigs: DevelopmentAttemptConfig[];
  invokedAttemptIds: string[];
  resume: ResumeDecision;
}> {
  const mode = input.mode ?? "dry-run";
  let registry = verifyExp0001aBatchRegistry(input.registry, input.plan);
  const initialResume = determineSafeResume(registry, input.plan);
  if (mode === "dry-run") {
    return { mode, registry, plannedConfigs: input.plan.configs, invokedAttemptIds: [], resume: initialResume };
  }
  if (input.executionAuthorized !== true || !input.executor || !input.verifyAliasBeforeAttempt || !input.registryStore) {
    throw new Error("Live batch execution requires explicit authorization, an executor, per-attempt alias verification, and a durable atomic registry store.");
  }
  if (!initialResume.safe) throw new Error(`Unsafe resume refused: ${initialResume.reason}`);
  if (initialResume.complete) return { mode, registry, plannedConfigs: input.plan.configs, invokedAttemptIds: [], resume: initialResume };

  const invokedAttemptIds: string[] = [];
  let durableRegistryDigest = registry.registryDigest;
  const persistCandidate = async (candidate: BatchRegistry, cause: string): Promise<void> => {
    const retained = verifyExp0001aBatchRegistry(
      await input.registryStore!.persist(candidate, durableRegistryDigest),
      input.plan,
    );
    if (retained.registryDigest !== candidate.registryDigest) {
      throw new Error(`Durable batch registry readback differs after ${cause}.`);
    }
    registry = retained;
    durableRegistryDigest = retained.registryDigest;
    await input.afterRegistryPersisted?.(retained, cause);
  };
  const persistRegistry = async (cause: string): Promise<void> => persistCandidate(registry, cause);
  const limit = input.maxAssignments ?? 48;
  if (!Number.isInteger(limit) || limit < 1 || limit > 48) throw new Error("maxAssignments must be an integer from 1 through 48.");
  for (let position = initialResume.nextManifestPosition; position < input.plan.configs.length && invokedAttemptIds.length < limit; position += 1) {
    const config = input.plan.configs[position];
    const existing = input.existingArtifactPaths?.[config.attempt.attemptId] ?? [];
    if (existing.length > 0) throw new Error(`Refusing to overwrite existing artifacts for ${config.attempt.attemptId}: ${existing.join(", ")}`);
    invokedAttemptIds.push(config.attempt.attemptId);
    let briefDelivered = false;
    let briefDeliveredAt: string | null = null;
    let releaseGateFailure: {
      incidentCode: string;
      hardIncident: boolean;
      falsification: boolean;
      message: string;
    } | null = null;
    // The release callback mutates this state across an awaited executor call.
    // Reading through a function prevents TypeScript from incorrectly treating
    // the pre-await null initializer as a permanent control-flow fact.
    const currentReleaseGateFailure = () => releaseGateFailure;
    const onBriefDelivered = async (requestedAt: string): Promise<string> => {
      if (briefDelivered) throw new Error(`Brief delivery was reported twice for ${config.attempt.attemptId}.`);
      timestampSchema.parse(requestedAt);
      let releaseGateStage: "verification" | "alias_persistence" | "brief_persistence" = "verification";
      try {
        const danglingAlias = registry.events.at(-1);
        if (danglingAlias?.kind === "alias_verified" && danglingAlias.attemptId === config.attempt.attemptId) {
          const interrupted = appendEvent(registry, {
            kind: "not_started",
            attemptId: config.attempt.attemptId,
            at: requestedAt,
            data: {
              incidentCode: "interrupted_after_alias_verification_before_brief",
              message: "A prior process retained alias verification without delivering the author brief; the provider was not invoked and the alias was reverified at the new release gate.",
              hardIncident: false,
              falsification: false,
            },
          });
          await persistCandidate(interrupted, `not_started:${config.attempt.attemptId}`);
        }
        const releaseGateRegistryDigest = registry.registryDigest;
        const receipt = verifyExp0001aPerAttemptAliasReceipt(await input.verifyAliasBeforeAttempt!({
          attemptId: config.attempt.attemptId,
          manifestPosition: position,
          expectedDeploymentId: input.plan.livePreflight.resolvedDeploymentId,
          releaseGateRequestedAt: requestedAt,
          releaseGateRegistryDigest,
        }), {
          attemptId: config.attempt.attemptId,
          manifestPosition: position,
          deploymentId: input.plan.livePreflight.resolvedDeploymentId,
          releaseGateRequestedAt: requestedAt,
          releaseGateRegistryDigest,
        });
        const aliasCandidate = appendEvent(registry, {
          kind: "alias_verified",
          attemptId: config.attempt.attemptId,
          at: receipt.verifiedAt,
          data: { receipt },
        });
        releaseGateStage = "alias_persistence";
        await persistCandidate(aliasCandidate, `alias_verified:${config.attempt.attemptId}`);
        const briefCandidate = appendEvent(registry, {
          kind: "brief_delivered",
          attemptId: config.attempt.attemptId,
          at: receipt.verifiedAt,
          data: { briefDigest: config.hashes.brief },
        });
        releaseGateStage = "brief_persistence";
        await persistCandidate(briefCandidate, `brief_delivered:${config.attempt.attemptId}`);
        briefDelivered = true;
        briefDeliveredAt = receipt.verifiedAt;
        return receipt.verifiedAt;
      } catch (error) {
        releaseGateFailure = {
          incidentCode: releaseGateStage === "verification"
            ? "per_attempt_alias_verification_failed"
            : "brief_registry_persistence_failure",
          hardIncident: true,
          falsification: releaseGateStage === "verification",
          message: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }
    };

    let rawResult: unknown;
    try {
      rawResult = await input.executor(config, { onBriefDelivered });
    } catch (error) {
      const at = new Date().toISOString();
      const gateFailure = currentReleaseGateFailure();
      if (!briefDelivered) {
        const incidentCode = gateFailure?.incidentCode ?? "executor_threw_before_brief";
        const hardIncident = gateFailure?.hardIncident ?? false;
        const falsification = gateFailure?.falsification ?? false;
        registry = appendEvent(registry, {
          kind: "not_started",
          attemptId: config.attempt.attemptId,
          at,
          data: {
            incidentCode,
            message: gateFailure?.message ?? (error instanceof Error ? error.message : String(error)),
            hardIncident,
            falsification,
          },
        });
        await persistRegistry(`not_started:${config.attempt.attemptId}`);
        if (hardIncident || falsification) {
          const source = registry.events.at(-1)!;
          registry = appendHardStop(registry, config.attempt.attemptId, at, incidentCode, source.eventDigest);
          await persistRegistry(`hard_stop:${config.attempt.attemptId}`);
        }
      } else {
        registry = appendEvent(registry, {
          kind: "attempt_retained",
          attemptId: config.attempt.attemptId,
          at,
          data: {
            executorOutcome: "executor_threw",
            retainedOutcome: "infra_failure",
            usage: null,
            usageByTurn: null,
            pricing: input.plan.pricing,
            actualCostUsd: null,
            costObservability: "unobservable",
            providerEvidenceDigest: null,
            providerIdentity: null,
            artifacts: [],
            artifactRoot: null,
            authorEvidenceRoot: null,
            attemptBundleSha256: null,
            authorIdentityCommitment: config.runnerConfig.authorIdentityCommitment,
            authorIdentityArtifactSha256: null,
            missingArtifacts: [...REQUIRED_BEGUN_ARTIFACTS],
            duplicateArtifactPaths: [],
            evidenceComplete: false,
            hardIncident: true,
            falsification: false,
            incidentCode: "executor_threw_after_brief",
          },
        });
        await persistRegistry(`attempt_retained:${config.attempt.attemptId}`);
        const source = registry.events.at(-1)!;
        registry = appendHardStop(registry, config.attempt.attemptId, at, "executor_threw_after_brief", source.eventDigest);
        await persistRegistry(`hard_stop:${config.attempt.attemptId}`);
      }
      break;
    }

    const result = executorResultSchema.parse(rawResult);
    if (result.kind === "not_started") {
      if (briefDelivered) throw new Error("Executor reported not_started after announcing brief delivery.");
      const gateFailure = currentReleaseGateFailure();
      const incidentCode = gateFailure?.incidentCode ?? result.incidentCode;
      const message = gateFailure?.message ?? result.message;
      const hardIncident = gateFailure?.hardIncident ?? result.hardIncident;
      const falsification = gateFailure?.falsification ?? result.falsification;
      registry = appendEvent(registry, {
        kind: "not_started",
        attemptId: config.attempt.attemptId,
        at: result.at,
        data: {
          incidentCode,
          message,
          hardIncident,
          falsification,
        },
      });
      await persistRegistry(`not_started:${config.attempt.attemptId}`);
      if (hardIncident || falsification) {
        const source = registry.events.at(-1)!;
        registry = appendHardStop(registry, config.attempt.attemptId, result.at, incidentCode, source.eventDigest);
        await persistRegistry(`hard_stop:${config.attempt.attemptId}`);
      }
      break;
    }
    if (!briefDelivered || !briefDeliveredAt) throw new Error("Executor returned a begun outcome without the brief-delivery callback.");
    if (Date.parse(result.finishedAt) < Date.parse(briefDeliveredAt)) throw new Error("Attempt finished before brief delivery.");
    const problems = artifactProblems(result, config.runnerConfig.authorIdentityCommitment);
    const evidenceComplete = problems.missingArtifacts.length === 0 && problems.duplicateArtifactPaths.length === 0;
    const integrityFailure = !evidenceComplete;
    registry = appendEvent(registry, {
      kind: "attempt_retained",
      attemptId: config.attempt.attemptId,
      at: result.finishedAt,
      data: {
        executorOutcome: result.outcome,
        retainedOutcome: integrityFailure ? "infra_failure" : result.outcome,
        usage: result.usage,
        usageByTurn: result.usageByTurn,
        pricing: input.plan.pricing,
        actualCostUsd: computeActualProviderTurnCost(result.usageByTurn, input.plan.pricing),
        costObservability: result.costObservability,
        providerEvidenceDigest: result.providerEvidenceDigest,
        providerIdentity: result.providerIdentity,
        artifacts: result.artifacts,
        artifactRoot: result.artifactRoot,
        authorEvidenceRoot: result.authorEvidenceRoot,
        attemptBundleSha256: result.attemptBundleSha256,
        authorIdentityCommitment: config.runnerConfig.authorIdentityCommitment,
        authorIdentityArtifactSha256: result.authorIdentityArtifactSha256,
        missingArtifacts: problems.missingArtifacts,
        duplicateArtifactPaths: problems.duplicateArtifactPaths,
        evidenceComplete,
        hardIncident: result.hardIncident || integrityFailure,
        falsification: result.falsification,
        incidentCode: integrityFailure ? "artifact_integrity_failure" : result.incidentCode,
      },
    });
    await persistRegistry(`attempt_retained:${config.attempt.attemptId}`);
    if (result.hardIncident || result.falsification || integrityFailure) {
      const source = registry.events.at(-1)!;
      registry = appendHardStop(
        registry,
        config.attempt.attemptId,
        result.finishedAt,
        integrityFailure ? "artifact_integrity_failure" : result.incidentCode ?? "hard_incident",
        source.eventDigest,
      );
      await persistRegistry(`hard_stop:${config.attempt.attemptId}`);
      break;
    }
  }
  return {
    mode,
    registry,
    plannedConfigs: input.plan.configs,
    invokedAttemptIds,
    resume: determineSafeResume(registry, input.plan),
  };
}

const evaluatorOptionsSchema = z.object({
  stagingRoot: z.string().min(1),
  reviewerId: idSchema,
  reviewerRole: z.enum(["primary", "adjudicator"]),
  model: z.string().min(1).max(200),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
  inputTokenBudget: z.number().int().positive(),
  outputTokenBudget: z.number().int().positive(),
  pricing: providerPricingSchema,
}).strict();

export function createOpaqueEvaluatorWorkItem(
  registryInput: BatchRegistry,
  plan: Exp0001aBatchPlan,
  attemptId: string,
  optionsInput: unknown,
) {
  const registry = verifyExp0001aBatchRegistry(registryInput, plan);
  const options = evaluatorOptionsSchema.parse(optionsInput);
  if (!path.isAbsolute(options.stagingRoot)) throw new Error("Evaluator staging root must be absolute.");
  const retained = registry.events.find((event): event is z.infer<typeof attemptRetainedEventSchema> => (
    event.kind === "attempt_retained" && event.attemptId === attemptId
  ));
  if (!retained || !retained.data.evidenceComplete || !retained.data.artifactRoot
    || !retained.data.authorEvidenceRoot || !retained.data.attemptBundleSha256
    || !retained.data.authorIdentityArtifactSha256) {
    throw new Error("Evaluator work requires complete retained evidence.");
  }
  const registration = registry.events.find((event): event is z.infer<typeof assignmentRegisteredEventSchema> => (
    event.kind === "assignment_registered" && event.attemptId === attemptId
  ));
  if (!registration) throw new Error("Evaluator work has no frozen assignment.");
  const bundle = parseBenchmarkExecutionBundle(benchmarkJson, rubricsJson, fixtureSpecsJson);
  const compiled = compileBenchmarkTaskExecution(bundle, registration.data.taskId);
  const opaqueArtifactId = `artifact-${hashCanonicalJson({
    registryDigest: registry.registryDigest,
    retainedEventDigest: retained.eventDigest,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
  const evaluatorConfig = {
    attemptDirectory: path.join(options.stagingRoot, opaqueArtifactId),
    expectedAttemptBundleSha256: retained.data.attemptBundleSha256,
    expectedArtifactRoot: retained.data.artifactRoot,
    expectedAuthorEvidenceRoot: retained.data.authorEvidenceRoot,
    expectedAuthorIdentityCommitment: retained.data.authorIdentityCommitment,
    expectedAuthorIdentityArtifactSha256: retained.data.authorIdentityArtifactSha256,
    taskId: registration.data.taskId,
    expectedRubricSha256: compiled.commitments.rubric,
    reviewerId: options.reviewerId,
    reviewerRole: options.reviewerRole,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    inputTokenBudget: options.inputTokenBudget,
    outputTokenBudget: options.outputTokenBudget,
    pricing: options.pricing,
  };
  const content = {
    schemaVersion: 1 as const,
    workItemId: `work-${opaqueArtifactId}`,
    opaqueArtifactId,
    sourceEventDigest: retained.eventDigest,
    stagingRequired: true as const,
    evaluatorConfig,
  };
  const serializedConfig = JSON.stringify(evaluatorConfig);
  if (serializedConfig.includes(attemptId)
    || serializedConfig.includes(registration.data.opaqueLabel)
    || /(?:opaqueLabel|pairId|orderIndex|timeBlock|condition)/i.test(serializedConfig)) {
    throw new Error("Evaluator configuration leaks assignment information.");
  }
  return { ...content, workItemDigest: hashCanonicalJson(content) };
}

export const CHECKED_IN_EXP0001A_MANIFEST = developmentExecutionManifestSchema.parse(executionManifestJson);
export const CHECKED_IN_EXP0001A_PROFILE_DIGEST = runnerProfileJson.profileDigest;
export const EXP0001A_EXECUTION_FREEZE_SCHEMA = experimentFreezeReceiptSchema;
