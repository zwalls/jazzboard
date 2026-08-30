import path from "node:path";

import { z } from "zod";

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
import { hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const rawDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z.string().datetime({ offset: true });

export const providerUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
}).strict().superRefine((usage, context) => {
  if (usage.cachedInputTokens > usage.inputTokens) {
    context.addIssue({ code: "custom", path: ["cachedInputTokens"], message: "Cached input cannot exceed total input." });
  }
});

export const providerPricingSchema = z.object({
  currency: z.literal("USD"),
  inputUsdPerMillionTokens: z.number().nonnegative(),
  cachedInputUsdPerMillionTokens: z.number().nonnegative(),
  outputUsdPerMillionTokens: z.number().nonnegative(),
  source: idSchema,
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
    artifacts: z.array(retainedArtifactSchema),
    artifactRoot: rawDigestSchema.nullable(),
    authorEvidenceRoot: rawDigestSchema.nullable(),
    attemptBundleSha256: rawDigestSchema.nullable(),
    hardIncident: z.boolean(),
    falsification: z.boolean(),
    incidentCode: idSchema.nullable(),
  }).strict(),
]);

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

const attemptRetainedEventSchema = z.object({
  ...eventMetadata,
  kind: z.literal("attempt_retained"),
  attemptId: idSchema,
  data: z.object({
    executorOutcome: z.enum(["completed", "failed", "timeout", "infra_failure", "policy_violation", "executor_threw"]),
    retainedOutcome: z.enum(["completed", "failed", "timeout", "infra_failure", "policy_violation"]),
    usage: providerUsageSchema.nullable(),
    pricing: providerPricingSchema,
    actualCostUsd: z.number().nonnegative().nullable(),
    artifacts: z.array(retainedArtifactSchema),
    artifactRoot: rawDigestSchema.nullable(),
    authorEvidenceRoot: rawDigestSchema.nullable(),
    attemptBundleSha256: rawDigestSchema.nullable(),
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
  configs: DevelopmentAttemptConfig[];
  planDigest: string;
};

const REQUIRED_BEGUN_ARTIFACTS = Object.freeze([
  "attempt-bundle.json",
  "author-brief.json",
  "author-events.jsonl",
  "author-final.json",
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

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

function eventDigest(event: Omit<BatchRegistryEvent, "eventDigest"> | BatchRegistryEvent): string {
  return hashCanonicalJson(withoutKey(event as unknown as Record<string, unknown>, "eventDigest"));
}

function registryDigest(registry: Omit<BatchRegistry, "registryDigest"> | BatchRegistry): string {
  return hashCanonicalJson(withoutKey(registry as unknown as Record<string, unknown>, "registryDigest"));
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
  const content = batchRegistryContentSchema.parse({ ...registry, events: [...registry.events, event] });
  return batchRegistrySchema.parse({ ...content, registryDigest: registryDigest(content) });
}

function orderedAssignments(manifest: DevelopmentExecutionManifest) {
  return [...manifest.assignments]
    .sort((left, right) => left.timeBlock - right.timeBlock)
    .flatMap((pair) => [...pair.attempts]
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((attempt) => ({ pair, attempt })));
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
  manifest?: unknown;
}): Exp0001aBatchPlan {
  const manifestVerification = verifyDevelopmentExecutionManifest(input.manifest ?? executionManifestJson, benchmarkJson);
  if (!manifestVerification.ok) throw new Error(`Frozen execution manifest is invalid: ${manifestVerification.errors.join(" ")}`);
  const freezeVerification = verifyExperimentFreezeReceipt(input.executionFreeze, { firstBriefDeliveredAt: null });
  if (!freezeVerification.ok) throw new Error(`Execution freeze is invalid: ${freezeVerification.errors.join(" ")}`);
  const livePreflight = aliasPreflightReceiptSchema.parse(input.livePreflight);
  const pricing = providerPricingSchema.parse(input.pricing);
  const configs = orderedAssignments(manifestVerification.manifest).map(({ attempt }) => createDevelopmentAttemptConfig({
    attemptId: attempt.attemptId,
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
    if (event.attemptId !== config.attempt.attemptId || event.data.manifestPosition !== index || event.data.configDigest !== config.configDigest) {
      throw new Error(`Registry assignment ${index} does not match manifest order.`);
    }
  });
  const hardStops = registry.events.filter((event) => event.kind === "hard_stop");
  if (hardStops.length > 1 || (hardStops.length === 1 && hardStops[0] !== registry.events.at(-1))) throw new Error("A hard stop must be unique and final.");
  let activePosition = 0;
  for (const config of plan.configs) {
    const lifecycle = registry.events.filter((event) => event.attemptId === config.attempt.attemptId && event.kind !== "assignment_registered" && event.kind !== "hard_stop");
    const briefs = lifecycle.filter((event) => event.kind === "brief_delivered");
    const retained = lifecycle.filter((event) => event.kind === "attempt_retained");
    if (briefs.length > 1 || retained.length > 1) throw new Error(`Attempt ${config.attempt.attemptId} has duplicate lifecycle records.`);
    if (retained.length && !briefs.length) throw new Error(`Attempt ${config.attempt.attemptId} was retained without brief delivery.`);
    if (lifecycle.some((event) => event.kind === "not_started") && briefs.length
      && lifecycle.findIndex((event) => event.kind === "not_started") > lifecycle.findIndex((event) => event.kind === "brief_delivered")) {
      throw new Error(`Attempt ${config.attempt.attemptId} records not_started after brief delivery.`);
    }
    const progressed = briefs.length > 0 || retained.length > 0 || lifecycle.some((event) => event.kind === "not_started");
    if (progressed && plan.configs.indexOf(config) > activePosition) throw new Error("Registry skips manifest order.");
    if (retained.length) activePosition += 1;
    else if (progressed) activePosition = plan.configs.indexOf(config);
  }
  return registry;
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
  const uncachedInput = usage.inputTokens - usage.cachedInputTokens;
  return Number(((
    uncachedInput * pricing.inputUsdPerMillionTokens
    + usage.cachedInputTokens * pricing.cachedInputUsdPerMillionTokens
    + usage.outputTokens * pricing.outputUsdPerMillionTokens
  ) / 1_000_000).toFixed(12));
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
  controls: { onBriefDelivered: (at: string) => void },
) => Promise<unknown>;

function artifactProblems(result: z.infer<typeof executorResultSchema> & { kind: "begun" }) {
  const paths = result.artifacts.map((artifact) => artifact.path);
  const duplicateArtifactPaths = [...new Set(paths.filter((value, index) => paths.indexOf(value) !== index))].sort();
  const required = result.outcome === "completed" ? REQUIRED_EVALUATOR_ARTIFACTS : REQUIRED_BEGUN_ARTIFACTS;
  const missingArtifacts = required.filter((requiredPath) => !paths.includes(requiredPath));
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
  existingArtifactPaths?: Readonly<Record<string, readonly string[]>>;
  maxAssignments?: number;
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
  if (input.executionAuthorized !== true || !input.executor) throw new Error("Live batch execution requires explicit authorization and an injected executor.");
  if (!initialResume.safe) throw new Error(`Unsafe resume refused: ${initialResume.reason}`);
  if (initialResume.complete) return { mode, registry, plannedConfigs: input.plan.configs, invokedAttemptIds: [], resume: initialResume };

  const invokedAttemptIds: string[] = [];
  const limit = input.maxAssignments ?? 48;
  if (!Number.isInteger(limit) || limit < 1 || limit > 48) throw new Error("maxAssignments must be an integer from 1 through 48.");
  for (let position = initialResume.nextManifestPosition; position < input.plan.configs.length && invokedAttemptIds.length < limit; position += 1) {
    const config = input.plan.configs[position];
    const existing = input.existingArtifactPaths?.[config.attempt.attemptId] ?? [];
    if (existing.length > 0) throw new Error(`Refusing to overwrite existing artifacts for ${config.attempt.attemptId}: ${existing.join(", ")}`);
    invokedAttemptIds.push(config.attempt.attemptId);
    let briefDelivered = false;
    let briefDeliveredAt: string | null = null;
    const onBriefDelivered = (at: string): void => {
      if (briefDelivered) throw new Error(`Brief delivery was reported twice for ${config.attempt.attemptId}.`);
      timestampSchema.parse(at);
      briefDelivered = true;
      briefDeliveredAt = at;
      registry = appendEvent(registry, {
        kind: "brief_delivered",
        attemptId: config.attempt.attemptId,
        at,
        data: { briefDigest: config.hashes.brief },
      });
    };

    let rawResult: unknown;
    try {
      rawResult = await input.executor(config, { onBriefDelivered });
    } catch (error) {
      const at = new Date(0).toISOString();
      if (!briefDelivered) {
        registry = appendEvent(registry, {
          kind: "not_started",
          attemptId: config.attempt.attemptId,
          at,
          data: {
            incidentCode: "executor_threw_before_brief",
            message: error instanceof Error ? error.message : String(error),
            hardIncident: false,
            falsification: false,
          },
        });
      } else {
        const retained = appendEvent(registry, {
          kind: "attempt_retained",
          attemptId: config.attempt.attemptId,
          at,
          data: {
            executorOutcome: "executor_threw",
            retainedOutcome: "infra_failure",
            usage: null,
            pricing: input.plan.pricing,
            actualCostUsd: null,
            artifacts: [],
            artifactRoot: null,
            authorEvidenceRoot: null,
            attemptBundleSha256: null,
            missingArtifacts: [...REQUIRED_BEGUN_ARTIFACTS],
            duplicateArtifactPaths: [],
            evidenceComplete: false,
            hardIncident: true,
            falsification: false,
            incidentCode: "executor_threw_after_brief",
          },
        });
        const source = retained.events.at(-1)!;
        registry = appendHardStop(retained, config.attempt.attemptId, at, "executor_threw_after_brief", source.eventDigest);
      }
      break;
    }

    const result = executorResultSchema.parse(rawResult);
    if (result.kind === "not_started") {
      if (briefDelivered) throw new Error("Executor reported not_started after announcing brief delivery.");
      registry = appendEvent(registry, {
        kind: "not_started",
        attemptId: config.attempt.attemptId,
        at: result.at,
        data: {
          incidentCode: result.incidentCode,
          message: result.message,
          hardIncident: result.hardIncident,
          falsification: result.falsification,
        },
      });
      if (result.hardIncident || result.falsification) {
        const source = registry.events.at(-1)!;
        registry = appendHardStop(registry, config.attempt.attemptId, result.at, result.incidentCode, source.eventDigest);
      }
      break;
    }
    if (!briefDelivered || !briefDeliveredAt) throw new Error("Executor returned a begun outcome without the brief-delivery callback.");
    if (Date.parse(result.finishedAt) < Date.parse(briefDeliveredAt)) throw new Error("Attempt finished before brief delivery.");
    const problems = artifactProblems(result);
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
        pricing: input.plan.pricing,
        actualCostUsd: computeActualProviderCost(result.usage, input.plan.pricing),
        artifacts: result.artifacts,
        artifactRoot: result.artifactRoot,
        authorEvidenceRoot: result.authorEvidenceRoot,
        attemptBundleSha256: result.attemptBundleSha256,
        missingArtifacts: problems.missingArtifacts,
        duplicateArtifactPaths: problems.duplicateArtifactPaths,
        evidenceComplete,
        hardIncident: result.hardIncident || integrityFailure,
        falsification: result.falsification,
        incidentCode: integrityFailure ? "artifact_integrity_failure" : result.incidentCode,
      },
    });
    if (result.hardIncident || result.falsification || integrityFailure) {
      const source = registry.events.at(-1)!;
      registry = appendHardStop(
        registry,
        config.attempt.attemptId,
        result.finishedAt,
        integrityFailure ? "artifact_integrity_failure" : result.incidentCode ?? "hard_incident",
        source.eventDigest,
      );
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
    || !retained.data.authorEvidenceRoot || !retained.data.attemptBundleSha256) {
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
