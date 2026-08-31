import { z } from "zod";

import {
  FROZEN_DEVELOPMENT_RUNNER_PROFILE,
} from "./development-attempt-config";
import {
  computeEnvironmentFreezeDigest,
  computeModelFreezeDigest,
  computeTreatmentDigest,
  createExperimentFreezeReceipt,
  experimentFreezeReceiptSchema,
  type ExperimentFreezeReceipt,
} from "./experiment-freeze";
import {
  exp0001aExecutionReadyReceiptSchema,
  verifyExp0001aExecutionReadyReceipt,
  type Exp0001aExecutionReadyReceipt,
} from "./exp0001a-execution-gate";
import { hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);

const sourceBindingSchema = z.object({ path: z.string().min(1), fileDigest: digestSchema }).passthrough();
const authorBudgetsSchema = z.object({
  wallMs: z.number().int().positive(),
  toolCalls: z.number().int().positive(),
  perToolTimeoutMs: z.number().int().positive(),
  inputTokens: z.number().int().positive(),
  outputTokens: z.number().int().positive(),
  perResponseOutputTokens: z.number().int().positive(),
  correctionRounds: z.number().int().nonnegative(),
}).strict();
const sourceTreatmentSchema = z.object({
  productBuildDigest: digestSchema,
  authorRunnerDigest: digestSchema,
  authorBriefCompilerDigest: digestSchema,
  toolAllowlistDigest: digestSchema,
  participantContractDigest: digestSchema,
  spectatorContractDigest: digestSchema,
  model: z.object({
    id: z.literal("gpt-5.6-sol"),
    reasoningEffort: z.literal("max"),
    serviceTier: z.literal("default"),
  }).strict(),
  browser: z.object({
    engine: z.string().min(1),
    product: z.string().min(1),
    version: z.string().min(1),
    playwrightVersion: z.string().min(1),
    headless: z.literal(true),
  }).strict(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
    locale: z.string().min(1),
    timezone: z.string().min(1),
  }).strict(),
  authorBudgets: authorBudgetsSchema,
}).passthrough();

/** Exact source subset used by the compatibility derivation; unknown frozen fields remain hash-bound. */
export const exp0001aAdapterPrebriefSourceSchema = z.object({
  schemaVersion: z.literal(1),
  protocolId: z.literal("EXP-0001A"),
  status: z.literal("blocked_pending_prerequisites"),
  frozenAt: z.string().datetime({ offset: true }),
  executionStateAtFreeze: z.literal("not_started"),
  briefReleaseAuthorized: z.literal(false),
  baseline: z.object({
    gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
    gitTree: z.string().regex(/^[a-f0-9]{40}$/),
    deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
    immutableUrl: z.string().url(),
    productionUrl: z.string().url(),
    receiptDigest: digestSchema,
    buildIdentityDigest: digestSchema,
    nodeVersion: z.string().min(1),
  }).passthrough(),
  schedule: z.object({
    manifestId: z.string().min(1),
    manifestDigest: digestSchema,
    benchmarkBundleDigest: digestSchema,
  }).passthrough(),
  frozenSources: z.object({
    protocol: sourceBindingSchema,
    scoring: sourceBindingSchema,
    artifactSchemas: sourceBindingSchema,
    evaluatorInstructions: sourceBindingSchema,
    authorRunner: sourceBindingSchema,
    authorSessionIdentityManifest: sourceBindingSchema.extend({ manifestRoot: digestSchema }),
  }).passthrough(),
  conditions: z.object({
    A0: sourceTreatmentSchema,
    A1: sourceTreatmentSchema,
    configurationDigest: digestSchema,
  }).strict(),
  sensitiveMaterialRedacted: z.literal(true),
  freezeDigest: digestSchema,
}).passthrough();

export type Exp0001aAdapterPrebriefSource = z.infer<typeof exp0001aAdapterPrebriefSourceSchema>;

export const EXP0001A_EXPERIMENT_FREEZE_ADAPTER_SOURCE_PATH =
  "src/lib/research/exp0001a-experiment-freeze-adapter.ts" as const;

const adapterContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("exp-0001a-experiment-freeze-compatibility-adapter"),
  protocolId: z.literal("EXP-0001A"),
  derivation: z.literal("verified-prebrief-plus-execution-ready-to-legacy-plan-view-v1"),
  sourcePrebriefFreezeDigest: digestSchema,
  executionReadyReceiptDigest: digestSchema,
  committedCodeReceiptDigest: digestSchema,
  legacyExecutionFreeze: experimentFreezeReceiptSchema,
}).strict();

export const exp0001aExperimentFreezeAdapterReceiptSchema = adapterContentSchema.extend({
  receiptDigest: digestSchema,
}).strict();

export type Exp0001aExperimentFreezeAdapterReceipt = z.infer<
  typeof exp0001aExperimentFreezeAdapterReceiptSchema
>;

function withoutReceiptDigest(
  receipt: Exp0001aExperimentFreezeAdapterReceipt,
): z.infer<typeof adapterContentSchema> {
  const { receiptDigest: _ignored, ...content } = receipt;
  void _ignored;
  return content;
}

export function computeExp0001aExperimentFreezeAdapterReceiptDigest(
  receipt: Exp0001aExperimentFreezeAdapterReceipt,
): string {
  return hashCanonicalJson(withoutReceiptDigest(receipt));
}

function deriveLegacyExecutionFreeze(
  prebrief: Exp0001aAdapterPrebriefSource,
  ready: Exp0001aExecutionReadyReceipt,
): ExperimentFreezeReceipt {
  const profile = FROZEN_DEVELOPMENT_RUNNER_PROFILE;
  const modelContent = {
    provider: "openai",
    snapshot: profile.model.id,
    reasoningEffort: profile.model.reasoningEffort,
    sampling: { temperature: null, topP: null, seed: null },
  } as const;
  const environmentContent = {
    browser: {
      name: profile.browser.product,
      version: profile.browser.version,
      buildDigest: hashCanonicalJson(profile.browser),
    },
    host: {
      name: "exp-0001a-committed-harness",
      version: ready.baseline.gitCommit,
      capabilityDigest: hashCanonicalJson({
        committedCodeReceiptDigest: ready.committedCode.receiptDigest,
        responsesServiceTier: profile.model.serviceTier,
      }),
    },
    viewport: {
      width: profile.viewport.width,
      height: profile.viewport.height,
      deviceScaleFactor: profile.viewport.deviceScaleFactor,
    },
    runtime: {
      nodeVersion: prebrief.baseline.nodeVersion,
      operatingSystem: "execution-ready-committed-runtime",
      imageDigest: hashCanonicalJson({
        gitCommit: ready.baseline.gitCommit,
        gitTree: ready.baseline.gitTree,
        committedCodeReceiptDigest: ready.committedCode.receiptDigest,
      }),
    },
    locale: profile.viewport.locale,
    timezone: profile.viewport.timezone,
  } as const;
  const treatmentContent = {
    baselineReceiptDigest: prebrief.baseline.receiptDigest,
    buildDigest: prebrief.conditions.A0.productBuildDigest,
    harnessDigest: prebrief.conditions.A0.authorRunnerDigest,
    systemInstructionsDigest: prebrief.conditions.A0.authorBriefCompilerDigest,
    toolConfigurationDigest: hashCanonicalJson({
      toolAllowlistDigest: prebrief.conditions.A0.toolAllowlistDigest,
      participantContractDigest: prebrief.conditions.A0.participantContractDigest,
      spectatorContractDigest: prebrief.conditions.A0.spectatorContractDigest,
    }),
  } as const;
  const condition = (opaqueLabel: "A0" | "A1") => ({
    ...treatmentContent,
    opaqueLabel,
    treatmentDigest: computeTreatmentDigest(treatmentContent),
  });

  return createExperimentFreezeReceipt({
    schemaVersion: 1,
    freezeId: "exp-0001a-execution-ready-compatibility-v1",
    studyKind: "aa_calibration",
    partition: "development",
    frozenAt: prebrief.frozenAt,
    executionStateAtFreeze: "not_started",
    baselineReceipt: {
      receiptId: "baseline-freeze-v1",
      receiptDigest: prebrief.baseline.receiptDigest,
      gitCommit: prebrief.baseline.gitCommit,
      gitTree: prebrief.baseline.gitTree,
      deploymentId: prebrief.baseline.deploymentId,
      buildIdentityDigest: prebrief.baseline.buildIdentityDigest,
    },
    commitments: {
      protocol: { id: "EXP-0001A", digest: prebrief.frozenSources.protocol.fileDigest },
      taskManifest: { id: "jazzboard-development-v1", digest: prebrief.schedule.benchmarkBundleDigest },
      randomizationSchedule: { id: prebrief.schedule.manifestId, digest: prebrief.schedule.manifestDigest },
      runner: { id: "clean-room-live-runner-v1", digest: prebrief.frozenSources.authorRunner.fileDigest },
      scorerConfiguration: { id: "development-scoring-v1", digest: prebrief.frozenSources.scoring.fileDigest },
      evaluatorInstructions: {
        id: "blinded-evaluator-instructions-v1",
        digest: prebrief.frozenSources.evaluatorInstructions.fileDigest,
      },
      artifactSchemas: [{ id: "research-artifact-schemas-v1", digest: prebrief.frozenSources.artifactSchemas.fileDigest }],
      toolInventory: { id: "participant-tool-allowlist-v1", digest: prebrief.conditions.A0.toolAllowlistDigest },
    },
    model: { ...modelContent, configurationDigest: computeModelFreezeDigest(modelContent) },
    environment: {
      ...environmentContent,
      configurationDigest: computeEnvironmentFreezeDigest(environmentContent),
    },
    budgets: {
      wallTimeMs: prebrief.conditions.A0.authorBudgets.wallMs,
      maxInputTokens: prebrief.conditions.A0.authorBudgets.inputTokens,
      maxOutputTokens: prebrief.conditions.A0.authorBudgets.outputTokens,
      maxToolCalls: prebrief.conditions.A0.authorBudgets.toolCalls,
      maxCorrectionRounds: prebrief.conditions.A0.authorBudgets.correctionRounds,
    },
    conditions: { first: condition("A0"), second: condition("A1") },
    sensitiveMaterialRedacted: true,
  });
}

export function verifyExp0001aAdapterPrebriefSource(input: unknown): Exp0001aAdapterPrebriefSource {
  const prebrief = exp0001aAdapterPrebriefSourceSchema.parse(input);
  const canonicalContent = Object.fromEntries(Object.entries(prebrief).filter(([key]) => key !== "freezeDigest"));
  if (hashCanonicalJson(canonicalContent) !== prebrief.freezeDigest) {
    throw new Error("EXP-0001A pre-brief source digest is invalid.");
  }
  if (hashCanonicalJson(prebrief.conditions.A0) !== hashCanonicalJson(prebrief.conditions.A1)
      || hashCanonicalJson(prebrief.conditions.A0) !== prebrief.conditions.configurationDigest) {
    throw new Error("EXP-0001A pre-brief source does not retain byte-identical A/A conditions.");
  }
  return prebrief;
}

function parseVerifiedInputs(
  prebriefInput: unknown,
  readyInput: unknown,
  now: string,
): { prebrief: Exp0001aAdapterPrebriefSource; ready: Exp0001aExecutionReadyReceipt } {
  const prebrief = verifyExp0001aAdapterPrebriefSource(prebriefInput);
  const readyResult = verifyExp0001aExecutionReadyReceipt(readyInput, now);
  if (!readyResult.ok) {
    throw new Error(`EXP-0001A execution-ready receipt is invalid: ${readyResult.errors.join(", ")}`);
  }
  if (readyResult.receipt.freezeDigest !== prebrief.freezeDigest) {
    throw new Error("Execution-ready receipt is bound to another pre-brief freeze.");
  }
  if (readyResult.receipt.conditionsDigest !== prebrief.conditions.configurationDigest) {
    throw new Error("Execution-ready receipt is bound to another frozen A/A condition.");
  }
  if (readyResult.receipt.committedCode.authorSessionIdentityManifestRoot
      !== prebrief.frozenSources.authorSessionIdentityManifest.manifestRoot) {
    throw new Error("Execution-ready receipt is bound to another author identity manifest.");
  }
  return { prebrief, ready: readyResult.receipt };
}

/**
 * Produces a deterministic compatibility view for the legacy batch compiler.
 * This is not an independent freeze and must never be accepted without its
 * verified pre-brief and execution-ready sources.
 */
export function createExp0001aExecutionFreezeAdapterReceipt(input: {
  prebriefFreeze: unknown;
  executionReadyReceipt: unknown;
  now: string;
}): Exp0001aExperimentFreezeAdapterReceipt {
  const { prebrief, ready } = parseVerifiedInputs(
    input.prebriefFreeze,
    input.executionReadyReceipt,
    input.now,
  );
  const content = adapterContentSchema.parse({
    schemaVersion: 1,
    kind: "exp-0001a-experiment-freeze-compatibility-adapter",
    protocolId: "EXP-0001A",
    derivation: "verified-prebrief-plus-execution-ready-to-legacy-plan-view-v1",
    sourcePrebriefFreezeDigest: prebrief.freezeDigest,
    executionReadyReceiptDigest: ready.receiptDigest,
    committedCodeReceiptDigest: ready.committedCode.receiptDigest,
    legacyExecutionFreeze: deriveLegacyExecutionFreeze(prebrief, ready),
  });
  return exp0001aExperimentFreezeAdapterReceiptSchema.parse({
    ...content,
    receiptDigest: hashCanonicalJson(content),
  });
}

export function verifyExp0001aExecutionFreezeAdapterReceipt(input: {
  receipt: unknown;
  prebriefFreeze: unknown;
  executionReadyReceipt: unknown;
  now: string;
}): Exp0001aExperimentFreezeAdapterReceipt {
  const parsed = exp0001aExperimentFreezeAdapterReceiptSchema.parse(input.receipt);
  if (computeExp0001aExperimentFreezeAdapterReceiptDigest(parsed) !== parsed.receiptDigest) {
    throw new Error("EXP-0001A experiment-freeze adapter receipt digest is invalid.");
  }
  const expected = createExp0001aExecutionFreezeAdapterReceipt(input);
  if (hashCanonicalJson(parsed) !== hashCanonicalJson(expected)) {
    throw new Error("EXP-0001A experiment-freeze adapter output drifted from its verified sources.");
  }
  exp0001aExecutionReadyReceiptSchema.parse(input.executionReadyReceipt);
  return parsed;
}
