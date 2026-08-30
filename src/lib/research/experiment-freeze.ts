import { z } from "zod";

import { hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";
import { findSecretLeakage } from "./provenance-redaction";

const sha256Schema = z.string().regex(SHA256_DIGEST_PATTERN);
const identifierSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40}$/);

const commitmentSchema = z.object({
  id: identifierSchema,
  digest: sha256Schema,
}).strict();

const samplingSchema = z.object({
  temperature: z.number().min(0).max(2).nullable(),
  topP: z.number().min(0).max(1).nullable(),
  seed: z.number().int().safe().nullable(),
}).strict();

const modelContentSchema = z.object({
  provider: z.string().min(1).max(100),
  snapshot: z.string().min(1).max(200),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
  sampling: samplingSchema,
}).strict();

const modelFreezeSchema = modelContentSchema.extend({
  configurationDigest: sha256Schema,
}).strict();

const environmentContentSchema = z.object({
  browser: z.object({
    name: z.string().min(1).max(100),
    version: z.string().min(1).max(200),
    buildDigest: sha256Schema,
  }).strict(),
  host: z.object({
    name: z.string().min(1).max(100),
    version: z.string().min(1).max(200),
    capabilityDigest: sha256Schema,
  }).strict(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
  }).strict(),
  runtime: z.object({
    nodeVersion: z.string().min(1).max(100),
    operatingSystem: z.string().min(1).max(200),
    imageDigest: sha256Schema,
  }).strict(),
  locale: z.string().min(1).max(100),
  timezone: z.string().min(1).max(100),
}).strict();

const environmentFreezeSchema = environmentContentSchema.extend({
  configurationDigest: sha256Schema,
}).strict();

const treatmentContentSchema = z.object({
  baselineReceiptDigest: sha256Schema,
  buildDigest: sha256Schema,
  harnessDigest: sha256Schema,
  systemInstructionsDigest: sha256Schema,
  toolConfigurationDigest: sha256Schema,
}).strict();

const conditionFreezeSchema = treatmentContentSchema.extend({
  opaqueLabel: z.string().min(1).max(80),
  treatmentDigest: sha256Schema,
}).strict();

export const baselineReceiptIdentitySchema = z.object({
  receiptId: z.literal("baseline-freeze-v1"),
  receiptDigest: sha256Schema,
  gitCommit: gitObjectSchema,
  gitTree: gitObjectSchema,
  deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
  buildIdentityDigest: sha256Schema,
}).strict();

export const experimentFreezeContentSchema = z.object({
  schemaVersion: z.literal(1),
  freezeId: identifierSchema,
  studyKind: z.enum(["aa_calibration", "ab_pilot"]),
  partition: z.enum(["development", "validation", "sealed-test-A", "replication-B"]),
  frozenAt: z.string().datetime({ offset: true }),
  executionStateAtFreeze: z.literal("not_started"),
  baselineReceipt: baselineReceiptIdentitySchema,
  commitments: z.object({
    protocol: commitmentSchema,
    taskManifest: commitmentSchema,
    randomizationSchedule: commitmentSchema,
    runner: commitmentSchema,
    scorerConfiguration: commitmentSchema,
    evaluatorInstructions: commitmentSchema,
    artifactSchemas: z.array(commitmentSchema).min(1),
    toolInventory: commitmentSchema,
  }).strict(),
  model: modelFreezeSchema,
  environment: environmentFreezeSchema,
  budgets: z.object({
    wallTimeMs: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
    maxCorrectionRounds: z.number().int().nonnegative(),
  }).strict(),
  conditions: z.object({
    first: conditionFreezeSchema,
    second: conditionFreezeSchema,
  }).strict(),
  sensitiveMaterialRedacted: z.literal(true),
}).strict();

export const experimentFreezeReceiptSchema = experimentFreezeContentSchema.extend({
  freezeDigest: sha256Schema,
}).strict();

export type ExperimentFreezeContent = z.infer<typeof experimentFreezeContentSchema>;
export type ExperimentFreezeReceipt = z.infer<typeof experimentFreezeReceiptSchema>;
export type ModelFreeze = z.infer<typeof modelFreezeSchema>;
export type EnvironmentFreeze = z.infer<typeof environmentFreezeSchema>;
export type ConditionFreeze = z.infer<typeof conditionFreezeSchema>;

export type ExperimentFreezeVerificationContext = {
  firstBriefDeliveredAt?: string | null;
  knownSecrets?: readonly string[];
};

export type ExperimentFreezeVerification =
  | { ok: true; receipt: ExperimentFreezeReceipt }
  | { ok: false; falsified: boolean; errors: string[] };

export const FROZEN_BASELINE_RECEIPT_IDENTITY = Object.freeze({
  receiptId: "baseline-freeze-v1",
  receiptDigest: "sha256:32fddd038f6ec696f633bc5ee28ec587540282dbbd1e451e5d2debeb67069b23",
  gitCommit: "48a52e0837144ea0db8a09e43217397226759f83",
  gitTree: "a25e8ec9f8fcc08b227d710a8517333af90f491e",
  deploymentId: "dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD",
  buildIdentityDigest: "sha256:0342169d87c8c5b4aa770745222488fe934e83940a01e296872daa096e6465d4",
} as const);

function omitKey<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

export function computeModelFreezeDigest(model: ModelFreeze | z.infer<typeof modelContentSchema>): string {
  return hashCanonicalJson(omitKey(model, "configurationDigest"));
}

export function computeEnvironmentFreezeDigest(
  environment: EnvironmentFreeze | z.infer<typeof environmentContentSchema>,
): string {
  return hashCanonicalJson(omitKey(environment, "configurationDigest"));
}

export function computeTreatmentDigest(
  condition: ConditionFreeze | z.infer<typeof treatmentContentSchema>,
): string {
  return hashCanonicalJson(omitKey(omitKey(condition, "opaqueLabel"), "treatmentDigest"));
}

export function computeExperimentFreezeDigest(
  receipt: ExperimentFreezeReceipt | ExperimentFreezeContent,
): string {
  return hashCanonicalJson(omitKey(receipt, "freezeDigest"));
}

export function createExperimentFreezeReceipt(contentInput: ExperimentFreezeContent): ExperimentFreezeReceipt {
  const content = experimentFreezeContentSchema.parse(contentInput);
  return experimentFreezeReceiptSchema.parse({
    ...content,
    freezeDigest: hashCanonicalJson(content),
  });
}

function formatSchemaIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.length ? `/${issue.path.join("/")}` : "/"}: ${issue.message}`);
}

function isZeroDigest(value: string): boolean {
  return value === `sha256:${"0".repeat(64)}`;
}

function verifyCommitment(errors: string[], label: string, commitment: z.infer<typeof commitmentSchema>): void {
  if (isZeroDigest(commitment.digest)) errors.push(`${label} uses a zero placeholder digest.`);
}

function sameTreatment(first: ConditionFreeze, second: ConditionFreeze): boolean {
  return computeTreatmentDigest(first) === computeTreatmentDigest(second);
}

function opaqueAaLabel(value: string): boolean {
  return !/(?:baseline|candidate|control|treatment|current|new|old)/i.test(value);
}

function findExperimentFreezeSensitiveFields(
  receipt: ExperimentFreezeReceipt,
  knownSecrets: readonly string[] = [],
): string[] {
  const permittedNumericBudgetKeys = new Set([
    "/budgets/maxInputTokens:secret-key",
    "/budgets/maxOutputTokens:secret-key",
  ]);
  return findSecretLeakage(receipt, knownSecrets).filter((finding) => !permittedNumericBudgetKeys.has(finding));
}

export function verifyExperimentFreezeReceipt(
  receiptInput: unknown,
  context: ExperimentFreezeVerificationContext = {},
): ExperimentFreezeVerification {
  const parsed = experimentFreezeReceiptSchema.safeParse(receiptInput);
  if (!parsed.success) return { ok: false, falsified: true, errors: formatSchemaIssues(parsed.error) };

  const receipt = parsed.data;
  const errors: string[] = [];
  let falsified = false;
  const fail = (message: string, isFalsification = false): void => {
    errors.push(message);
    falsified ||= isFalsification;
  };

  if (computeExperimentFreezeDigest(receipt) !== receipt.freezeDigest) fail("Canonical freeze digest is invalid.", true);
  if (receipt.partition !== "development") fail("Execution freezes may use only the development partition.", true);
  if (/sealed|replication/i.test(receipt.commitments.taskManifest.id)) {
    fail("Task manifest identifier refers to a sealed or replication partition.", true);
  }

  const expectedBaseline = FROZEN_BASELINE_RECEIPT_IDENTITY;
  for (const key of Object.keys(expectedBaseline) as Array<keyof typeof expectedBaseline>) {
    if (receipt.baselineReceipt[key] !== expectedBaseline[key]) fail(`Baseline receipt ${key} is not the exact frozen identity.`, true);
  }

  const fixedCommitments = receipt.commitments;
  verifyCommitment(errors, "protocol", fixedCommitments.protocol);
  verifyCommitment(errors, "task manifest", fixedCommitments.taskManifest);
  verifyCommitment(errors, "randomization schedule", fixedCommitments.randomizationSchedule);
  verifyCommitment(errors, "runner", fixedCommitments.runner);
  verifyCommitment(errors, "scorer configuration", fixedCommitments.scorerConfiguration);
  verifyCommitment(errors, "evaluator instructions", fixedCommitments.evaluatorInstructions);
  verifyCommitment(errors, "tool inventory", fixedCommitments.toolInventory);
  fixedCommitments.artifactSchemas.forEach((commitment, index) => verifyCommitment(errors, `artifact schema ${index}`, commitment));

  const commitmentIds = [
    fixedCommitments.protocol.id,
    fixedCommitments.taskManifest.id,
    fixedCommitments.randomizationSchedule.id,
    fixedCommitments.runner.id,
    fixedCommitments.scorerConfiguration.id,
    fixedCommitments.evaluatorInstructions.id,
    fixedCommitments.toolInventory.id,
    ...fixedCommitments.artifactSchemas.map((commitment) => commitment.id),
  ];
  if (new Set(commitmentIds).size !== commitmentIds.length) fail("Prerequisite commitment identifiers must be unique.");

  if (computeModelFreezeDigest(receipt.model) !== receipt.model.configurationDigest) fail("Model configuration digest is invalid.", true);
  if (computeEnvironmentFreezeDigest(receipt.environment) !== receipt.environment.configurationDigest) {
    fail("Environment configuration digest is invalid.", true);
  }

  const { first, second } = receipt.conditions;
  if (first.opaqueLabel === second.opaqueLabel) fail("Condition labels must be distinct.", true);
  for (const [label, condition] of [["first", first], ["second", second]] as const) {
    if (condition.baselineReceiptDigest !== expectedBaseline.receiptDigest) {
      fail(`${label} condition does not reference the exact frozen baseline receipt.`, true);
    }
    if (computeTreatmentDigest(condition) !== condition.treatmentDigest) fail(`${label} treatment digest is invalid.`, true);
    if ([condition.buildDigest, condition.harnessDigest, condition.systemInstructionsDigest, condition.toolConfigurationDigest]
      .some(isZeroDigest)) fail(`${label} condition contains a zero placeholder digest.`);
  }

  if (receipt.studyKind === "aa_calibration") {
    if (!opaqueAaLabel(first.opaqueLabel) || !opaqueAaLabel(second.opaqueLabel)) {
      fail("A/A condition labels disclose treatment meaning.", true);
    }
    if (!sameTreatment(first, second)) fail("A/A treatment-relevant configurations are not byte-identical.", true);
    if (first.buildDigest !== expectedBaseline.buildIdentityDigest || second.buildDigest !== expectedBaseline.buildIdentityDigest) {
      fail("A/A conditions do not both resolve to the exact frozen baseline build.", true);
    }
  } else {
    if (sameTreatment(first, second)) fail("A/B pilot conditions must differ in treatment-relevant configuration.", true);
    if (first.buildDigest !== expectedBaseline.buildIdentityDigest && second.buildDigest !== expectedBaseline.buildIdentityDigest) {
      fail("A/B pilot lacks a condition resolved to the frozen baseline build.", true);
    }
  }

  if (context.firstBriefDeliveredAt !== undefined && context.firstBriefDeliveredAt !== null) {
    const briefTime = Date.parse(context.firstBriefDeliveredAt);
    if (!Number.isFinite(briefTime)) fail("First brief delivery time is invalid.", true);
    else if (Date.parse(receipt.frozenAt) >= briefTime) fail("Execution freeze was not locked before first brief delivery.", true);
  }

  const sensitive = findExperimentFreezeSensitiveFields(receipt, context.knownSecrets);
  if (sensitive.length > 0) fail(`Execution freeze contains sensitive material: ${sensitive.join(", ")}`, true);

  return errors.length === 0 ? { ok: true, receipt } : { ok: false, falsified, errors };
}

export function assertExperimentFreezeReceipt(
  receiptInput: unknown,
  context: ExperimentFreezeVerificationContext = {},
): ExperimentFreezeReceipt {
  const result = verifyExperimentFreezeReceipt(receiptInput, context);
  if (!result.ok) throw new Error(`Invalid execution freeze: ${result.errors.join(" ")}`);
  return result.receipt;
}
