import { z } from "zod";

import developmentBenchmarkJson from "../../../research/benchmarks/development-v1.json";
import developmentRubricsJson from "../../../research/benchmarks/development-evaluator-rubrics-v1.json";
import developmentFixtureSpecsJson from "../../../research/benchmarks/development-fixture-specs-v1.json";
import baselineFreezeJson from "../../../research/data/baseline-freeze-v1.json";
import baselineInventoryJson from "../../../research/data/baseline-webmcp-inventory-v1.json";
import developmentExecutionManifestJson from "../../../research/data/development-execution-manifest-v1.json";
import developmentRunnerProfileJson from "../../../research/data/development-runner-profile-v1.json";
import {
  EXPECTED_BASELINE_FREEZE,
  verifyBaselineFreezeReceipt,
} from "./baseline-freeze";
import {
  compileBenchmarkTaskExecution,
  parseBenchmarkExecutionBundle,
} from "./benchmark-execution";
import {
  DEVELOPMENT_AA_TREATMENT_DIGEST,
  type DevelopmentExecutionManifest,
  verifyDevelopmentExecutionManifest,
} from "./development-manifest";
import { hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";
import { findSecretLeakage } from "./provenance-redaction";

const PUBLIC_BASE_URL = "https://www.jazzboard.xyz/" as const;
const EXPECTED_PARTICIPANT_CONTRACT_HASH = "d64cf3d25b9e275003438597b3b01c35419063d71613082d45aaf2f97c388b8e" as const;
const EXPECTED_SPECTATOR_CONTRACT_HASH = "1760c6b1ec8cc4d8814b3de6a8f4516b3f4c215da69069c50072f23128541be2" as const;
const EXPECTED_PROFILE_DIGEST = "sha256:a19cce624843cee156f38b5514e2e1b1590f2ad05752e8f70f520ab5d6d34ba4" as const;
const sha256Schema = z.string().regex(SHA256_DIGEST_PATTERN);
const safeIdSchema = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const toolNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);

const runnerProfileContentSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: z.literal("exp-0001a-sol-max-production-v1"),
  baseUrl: z.literal(PUBLIC_BASE_URL),
  expectedDeployment: z.object({
    deploymentId: z.literal(EXPECTED_BASELINE_FREEZE.deploymentId),
    buildId: z.literal(EXPECTED_BASELINE_FREEZE.buildId),
    gitCommit: z.literal(EXPECTED_BASELINE_FREEZE.gitCommit),
    gitTree: z.literal(EXPECTED_BASELINE_FREEZE.gitTree),
    baselineReceiptDigest: z.literal("sha256:32fddd038f6ec696f633bc5ee28ec587540282dbbd1e451e5d2debeb67069b23"),
    buildIdentityDigest: z.literal(EXPECTED_BASELINE_FREEZE.buildIdentityDigest),
  }).strict(),
  aliasPreflight: z.object({
    required: z.literal(true),
    method: z.literal("authenticated-vercel-cli-or-api"),
    immutableUrlProtected: z.literal(true),
  }).strict(),
  model: z.object({
    id: z.literal("gpt-5.6-sol"),
    reasoningEffort: z.literal("max"),
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
  budgets: z.object({
    wallBudgetMs: z.number().int().min(10_000).max(3_600_000),
    toolCallBudget: z.number().int().min(1).max(500),
    perToolTimeoutMs: z.number().int().min(1_000).max(120_000),
    inputTokenBudget: z.number().int().min(1).max(10_000_000),
    outputTokenBudget: z.number().int().min(1).max(10_000_000),
    perResponseMaxOutputTokens: z.number().int().min(1).max(10_000_000),
    maxCorrectionRounds: z.number().int().min(0).max(20),
  }).strict(),
  allowedToolNames: z.array(toolNameSchema).min(1),
  participantToolContractHash: z.literal(EXPECTED_PARTICIPANT_CONTRACT_HASH),
  spectatorToolContractHash: z.literal(EXPECTED_SPECTATOR_CONTRACT_HASH),
  sensitiveMaterialRedacted: z.literal(true),
}).strict();

export const developmentRunnerProfileSchema = runnerProfileContentSchema.extend({
  profileDigest: sha256Schema,
}).strict();

export const aliasPreflightReceiptSchema = z.object({
  batchId: safeIdSchema,
  method: z.literal("authenticated-vercel-cli-or-api"),
  authenticated: z.literal(true),
  alias: z.literal("https://www.jazzboard.xyz"),
  resolvedDeploymentId: z.literal(EXPECTED_BASELINE_FREEZE.deploymentId),
  verifiedAt: z.string().datetime({ offset: true }),
}).strict();

const runnerOperationSchema = z.object({
  tool: z.literal("apply_canvas_transaction"),
  input: z.record(z.string(), z.unknown()),
}).strict();

const runnerConcurrentEventSchema = z.object({
  id: safeIdSchema,
  observableTrigger: z.object({
    kind: z.literal("after_observable"),
    observable: z.enum(["first_author_mutation", "first_visual_inspection", "first_draft_staged"]),
    occurrence: z.number().int().positive(),
  }).strict(),
  operations: z.array(runnerOperationSchema).min(1),
}).strict();

export const cleanRoomRunnerConfigSchema = z.object({
  attemptId: safeIdSchema,
  baseUrl: z.literal(PUBLIC_BASE_URL),
  brief: z.string().min(1),
  model: z.literal("gpt-5.6-sol"),
  reasoningEffort: z.literal("max"),
  allowedToolNames: z.array(toolNameSchema).min(1),
  participantToolContractHash: z.literal(EXPECTED_PARTICIPANT_CONTRACT_HASH),
  spectatorToolContractHash: z.literal(EXPECTED_SPECTATOR_CONTRACT_HASH),
  wallBudgetMs: z.number().int(),
  toolCallBudget: z.number().int(),
  perToolTimeoutMs: z.number().int(),
  inputTokenBudget: z.number().int(),
  outputTokenBudget: z.number().int(),
  perResponseMaxOutputTokens: z.number().int(),
  allowedBrowserOrigins: z.tuple([z.literal("https://www.jazzboard.xyz")]),
  displayName: z.literal("Research Author"),
  roomTitle: z.string().min(1).max(100),
  spectatorDisplayName: z.literal("Research Evaluator"),
  setupActorDisplayName: z.literal("Research Fixture"),
  eventActorDisplayName: z.literal("Research Collaborator"),
  setupOperations: z.array(runnerOperationSchema),
  setupCallbackHash: z.null(),
  concurrentEvents: z.array(runnerConcurrentEventSchema),
  concurrentEventCallbackHash: z.null(),
  headless: z.literal(true),
}).strict();

const sourceCommitmentsSchema = z.object({
  executionManifestDigest: sha256Schema,
  taskDigest: sha256Schema,
  publicPacketDigest: sha256Schema,
  setupDigest: sha256Schema,
  eventDigest: sha256Schema,
  runnerProfileDigest: sha256Schema,
}).strict();

const treatmentConfigurationSchema = z.object({
  treatmentDigest: z.literal(DEVELOPMENT_AA_TREATMENT_DIGEST),
  baseUrl: z.literal(PUBLIC_BASE_URL),
  deploymentId: z.literal(EXPECTED_BASELINE_FREEZE.deploymentId),
  buildId: z.literal(EXPECTED_BASELINE_FREEZE.buildId),
  gitCommit: z.literal(EXPECTED_BASELINE_FREEZE.gitCommit),
  gitTree: z.literal(EXPECTED_BASELINE_FREEZE.gitTree),
  baselineReceiptDigest: z.literal("sha256:32fddd038f6ec696f633bc5ee28ec587540282dbbd1e451e5d2debeb67069b23"),
  buildIdentityDigest: z.literal(EXPECTED_BASELINE_FREEZE.buildIdentityDigest),
  participantToolContractHash: z.literal(EXPECTED_PARTICIPANT_CONTRACT_HASH),
  spectatorToolContractHash: z.literal(EXPECTED_SPECTATOR_CONTRACT_HASH),
  model: z.object({ id: z.literal("gpt-5.6-sol"), reasoningEffort: z.literal("max") }).strict(),
  browser: runnerProfileContentSchema.shape.browser,
  viewport: runnerProfileContentSchema.shape.viewport,
  budgets: runnerProfileContentSchema.shape.budgets,
  allowedToolNames: z.array(toolNameSchema).min(1),
}).strict();

const attemptMetadataSchema = z.object({
  attemptId: safeIdSchema,
  pairId: safeIdSchema,
  taskId: safeIdSchema,
  taskFamily: z.enum(["architecture", "drawing"]),
  replicateIndex: z.union([z.literal(0), z.literal(1)]),
  timeBlock: z.number().int().min(0).max(23),
  orderIndex: z.union([z.literal(0), z.literal(1)]),
  opaqueLabel: z.enum(["A0", "A1"]),
  freshAuthorContext: z.literal(true),
  freshRoom: z.literal(true),
}).strict();

const bridgeContentSchema = z.object({
  schemaVersion: z.literal(1),
  configId: z.string().regex(/^config-attempt-[a-zA-Z0-9._-]+$/).max(96),
  protocolId: z.literal("EXP-0001A"),
  studyKind: z.literal("aa_calibration"),
  partition: z.literal("development"),
  attempt: attemptMetadataSchema,
  aliasPreflight: aliasPreflightReceiptSchema,
  sourceCommitments: sourceCommitmentsSchema,
  treatmentConfiguration: treatmentConfigurationSchema,
  treatmentConfigurationDigest: sha256Schema,
  runnerConfig: cleanRoomRunnerConfigSchema,
  hashes: z.object({
    brief: sha256Schema,
    setup: sha256Schema,
    event: sha256Schema,
  }).strict(),
  sensitiveMaterialRedacted: z.literal(true),
}).strict();

export const developmentAttemptConfigSchema = bridgeContentSchema.extend({
  configDigest: sha256Schema,
}).strict();

export type DevelopmentRunnerProfile = z.infer<typeof developmentRunnerProfileSchema>;
export type AliasPreflightReceipt = z.infer<typeof aliasPreflightReceiptSchema>;
export type DevelopmentAttemptConfig = z.infer<typeof developmentAttemptConfigSchema>;

function contentWithoutDigest<T extends Record<string, unknown>>(value: T, key: keyof T): Omit<T, keyof T> & Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key)) as Omit<T, keyof T> & Record<string, unknown>;
}

function permittedBudgetTokenFinding(finding: string): boolean {
  return /\/(?:budgets\/)?(?:inputTokenBudget|outputTokenBudget|perResponseMaxOutputTokens):secret-key$/.test(finding);
}

function assertPublishable(value: unknown, label: string): void {
  const leakage = findSecretLeakage(value).filter((finding) => !permittedBudgetTokenFinding(finding));
  const serialized = JSON.stringify(value);
  if (/sealed/i.test(serialized)) leakage.push("sealed-material");
  if (leakage.length > 0) throw new Error(`${label} contains sensitive or sealed material: ${[...new Set(leakage)].join(", ")}`);
}

export function verifyDevelopmentRunnerProfile(input: unknown): DevelopmentRunnerProfile {
  const profile = developmentRunnerProfileSchema.parse(input);
  const digest = hashCanonicalJson(contentWithoutDigest(profile, "profileDigest"));
  if (digest !== profile.profileDigest || profile.profileDigest !== EXPECTED_PROFILE_DIGEST) {
    throw new Error("Runner profile digest does not match the frozen EXP-0001A profile.");
  }
  if (profile.budgets.perResponseMaxOutputTokens > profile.budgets.outputTokenBudget) {
    throw new Error("Runner profile per-response output budget exceeds the cumulative output budget.");
  }
  const toolNames = profile.allowedToolNames;
  if (new Set(toolNames).size !== toolNames.length) throw new Error("Runner profile tool allowlist contains duplicates.");
  if (!toolNames.includes("apply_canvas_transaction")) throw new Error("Runner profile cannot execute frozen transaction plans.");
  const inventory = baselineInventoryJson.participant.tools.map((tool) => tool.name);
  const absent = toolNames.filter((name) => !inventory.includes(name));
  if (absent.length > 0) throw new Error(`Runner profile includes tools absent from the frozen participant inventory: ${absent.join(", ")}`);
  assertPublishable(profile, "Runner profile");
  return profile;
}

function verifyFrozenSources(
  manifestInput: unknown,
  profileInput: unknown,
): { manifest: DevelopmentExecutionManifest; profile: DevelopmentRunnerProfile } {
  const baseline = verifyBaselineFreezeReceipt(baselineFreezeJson, baselineInventoryJson);
  if (!baseline.ok) throw new Error(`Frozen baseline verification failed: ${baseline.errors.join(" ")}`);
  const execution = verifyDevelopmentExecutionManifest(manifestInput, developmentBenchmarkJson);
  if (!execution.ok) throw new Error(`Execution manifest verification failed: ${execution.errors.join(" ")}`);
  return { manifest: execution.manifest, profile: verifyDevelopmentRunnerProfile(profileInput) };
}

function selectAttempt(manifest: DevelopmentExecutionManifest, attemptId: string) {
  const matches = manifest.assignments.flatMap((pair) => pair.attempts
    .filter((attempt) => attempt.attemptId === attemptId)
    .map((attempt) => ({ pair, attempt })));
  if (matches.length !== 1) throw new Error(`Expected exactly one frozen assignment for attempt ${attemptId}; found ${matches.length}.`);
  return matches[0];
}

function operation(plan: { toolName: "apply_canvas_transaction"; input: Record<string, unknown> }) {
  return { tool: plan.toolName, input: structuredClone(plan.input) } as const;
}

export type CreateDevelopmentAttemptConfigOptions = {
  attemptId: string;
  aliasPreflight: unknown;
  manifest?: unknown;
  runnerProfile?: unknown;
};

/**
 * Pure bridge from frozen research inputs to a single executable runner config.
 * It performs no network access, does not create a room, and never invokes a model.
 */
export function createDevelopmentAttemptConfig(
  options: CreateDevelopmentAttemptConfigOptions,
): DevelopmentAttemptConfig {
  const { manifest, profile } = verifyFrozenSources(
    options.manifest ?? developmentExecutionManifestJson,
    options.runnerProfile ?? developmentRunnerProfileJson,
  );
  const preflight = aliasPreflightReceiptSchema.parse(options.aliasPreflight);
  const { pair, attempt } = selectAttempt(manifest, options.attemptId);
  if (!attempt.freshAuthorContext || !attempt.freshRoom) throw new Error("Every EXP-0001A attempt requires a fresh author context and room.");

  const bundle = parseBenchmarkExecutionBundle(
    developmentBenchmarkJson,
    developmentRubricsJson,
    developmentFixtureSpecsJson,
  );
  const compiled = compileBenchmarkTaskExecution(bundle, pair.taskId);
  const taskCommitment = manifest.tasks.find((task) => task.taskId === pair.taskId);
  if (!taskCommitment || taskCommitment.taskDigest !== compiled.commitments.task || pair.taskDigest !== compiled.commitments.task) {
    throw new Error(`Benchmark task commitment drift for ${pair.taskId}.`);
  }
  if (attempt.treatmentDigest !== DEVELOPMENT_AA_TREATMENT_DIGEST) throw new Error("Attempt does not resolve to the frozen A/A baseline treatment.");

  const setupOperations = compiled.trustedCoordinator.preBriefSetup
    ? [operation(compiled.trustedCoordinator.preBriefSetup)]
    : [];
  const concurrentEvents = compiled.trustedCoordinator.concurrentEvent
    ? [{
        id: compiled.trustedCoordinator.concurrentEvent.sourceId,
        observableTrigger: structuredClone(compiled.trustedCoordinator.concurrentEvent.observableTrigger),
        operations: [operation(compiled.trustedCoordinator.concurrentEvent)],
      }]
    : [];
  const runnerConfig = cleanRoomRunnerConfigSchema.parse({
    attemptId: attempt.attemptId,
    baseUrl: profile.baseUrl,
    brief: compiled.author.renderedBrief,
    model: profile.model.id,
    reasoningEffort: profile.model.reasoningEffort,
    allowedToolNames: profile.allowedToolNames,
    participantToolContractHash: profile.participantToolContractHash,
    spectatorToolContractHash: profile.spectatorToolContractHash,
    wallBudgetMs: profile.budgets.wallBudgetMs,
    toolCallBudget: profile.budgets.toolCallBudget,
    perToolTimeoutMs: profile.budgets.perToolTimeoutMs,
    inputTokenBudget: profile.budgets.inputTokenBudget,
    outputTokenBudget: profile.budgets.outputTokenBudget,
    perResponseMaxOutputTokens: profile.budgets.perResponseMaxOutputTokens,
    allowedBrowserOrigins: ["https://www.jazzboard.xyz"],
    displayName: "Research Author",
    roomTitle: `EXP-0001A ${attempt.attemptId}`,
    spectatorDisplayName: "Research Evaluator",
    setupActorDisplayName: "Research Fixture",
    eventActorDisplayName: "Research Collaborator",
    setupOperations,
    setupCallbackHash: null,
    concurrentEvents,
    concurrentEventCallbackHash: null,
    headless: profile.browser.headless,
  });
  const treatmentConfiguration = treatmentConfigurationSchema.parse({
    treatmentDigest: attempt.treatmentDigest,
    baseUrl: profile.baseUrl,
    ...profile.expectedDeployment,
    participantToolContractHash: profile.participantToolContractHash,
    spectatorToolContractHash: profile.spectatorToolContractHash,
    model: profile.model,
    browser: profile.browser,
    viewport: profile.viewport,
    budgets: profile.budgets,
    allowedToolNames: profile.allowedToolNames,
  });
  const content = bridgeContentSchema.parse({
    schemaVersion: 1,
    configId: `config-${attempt.attemptId}`,
    protocolId: manifest.protocolId,
    studyKind: manifest.studyKind,
    partition: manifest.partition,
    attempt: {
      attemptId: attempt.attemptId,
      pairId: pair.pairId,
      taskId: pair.taskId,
      taskFamily: pair.taskFamily,
      replicateIndex: pair.replicateIndex,
      timeBlock: pair.timeBlock,
      orderIndex: attempt.orderIndex,
      opaqueLabel: attempt.opaqueLabel,
      freshAuthorContext: attempt.freshAuthorContext,
      freshRoom: attempt.freshRoom,
    },
    aliasPreflight: preflight,
    sourceCommitments: {
      executionManifestDigest: manifest.manifestDigest,
      taskDigest: compiled.commitments.task,
      publicPacketDigest: compiled.commitments.publicPacket,
      setupDigest: compiled.commitments.setup,
      eventDigest: compiled.commitments.event,
      runnerProfileDigest: profile.profileDigest,
    },
    treatmentConfiguration,
    treatmentConfigurationDigest: hashCanonicalJson(treatmentConfiguration),
    runnerConfig,
    hashes: {
      brief: hashCanonicalJson(runnerConfig.brief),
      setup: hashCanonicalJson(runnerConfig.setupOperations),
      event: hashCanonicalJson(runnerConfig.concurrentEvents),
    },
    sensitiveMaterialRedacted: true,
  });
  assertPublishable(content, "Attempt config");
  return developmentAttemptConfigSchema.parse({ ...content, configDigest: hashCanonicalJson(content) });
}

export function verifyDevelopmentAttemptConfig(input: unknown): DevelopmentAttemptConfig {
  const parsed = developmentAttemptConfigSchema.parse(input);
  const expected = createDevelopmentAttemptConfig({
    attemptId: parsed.attempt.attemptId,
    aliasPreflight: parsed.aliasPreflight,
  });
  if (hashCanonicalJson(parsed) !== hashCanonicalJson(expected)) throw new Error("Attempt config differs from the deterministic frozen bridge output.");
  return parsed;
}

export function listDevelopmentAttemptIds(): string[] {
  const { manifest } = verifyFrozenSources(developmentExecutionManifestJson, developmentRunnerProfileJson);
  return manifest.assignments.flatMap((pair) => pair.attempts.map((attempt) => attempt.attemptId));
}

export const FROZEN_DEVELOPMENT_RUNNER_PROFILE = verifyDevelopmentRunnerProfile(developmentRunnerProfileJson);
