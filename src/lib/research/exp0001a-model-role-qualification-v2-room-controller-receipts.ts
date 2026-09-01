import { z } from "zod";
import path from "node:path";

import baselineReceiptJson from "../../../research/data/baseline-freeze-v2.json";
import baselineInventoryJson from "../../../research/data/baseline-webmcp-inventory-v2.json";
import {
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

const taskIdSchema = z.enum([
  "dev-architecture-create-checkout",
  "dev-architecture-edit-uncertainty",
  "dev-drawing-create-wayfinding-icon",
]);
const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const absolutePathSchema = z.string().refine((value) => (
  path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root
), "Path must be absolute, normalized, and non-root.");
const runtimeIdentitySchema = z.object({
  node: z.string().min(1),
  platform: z.string().min(1),
  architecture: z.string().min(1),
}).strict();
export const qualificationV2HarnessRuntimeProvenanceSchema = z.object({
  controllerBundleDigest: digestSchema,
  wrapperSourceDigest: digestSchema,
  dependencyLockfileDigest: digestSchema,
  gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
  gitTree: z.string().regex(/^[a-f0-9]{40}$/),
  worktreeClean: z.literal(true),
}).strict();

export const qualificationV2CaptureRequestBasisSchema = z.object({
  operation: z.literal("capture_author_evidence"),
  roomReceiptPath: absolutePathSchema,
  provisionControllerReceiptPath: absolutePathSchema,
  storageStatePath: absolutePathSchema,
  outputDirectory: absolutePathSchema,
  at: timestampSchema,
}).strict();

export const qualificationV2CaptureAuthorizationContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-capture-authorization/v2"),
  taskId: taskIdSchema,
  roomReceiptDigest: digestSchema,
  provisionControllerReceiptDigest: digestSchema,
  storageStateDigest: digestSchema,
  captureNonce: digestSchema,
  request: qualificationV2CaptureRequestBasisSchema,
  requestBindingDigest: digestSchema,
  preparedAt: timestampSchema,
}).strict();

export const qualificationV2CaptureAuthorizationSchema =
  qualificationV2CaptureAuthorizationContentSchema.extend({ actionDigest: digestSchema }).strict();

export const qualificationV2CaptureReleaseJournalContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-capture-release-journal/v2"),
  captureActionDigest: digestSchema,
  captureNonce: digestSchema,
  requestBindingDigest: digestSchema,
  invokedAt: timestampSchema,
  invocationOrdinal: z.literal(1),
  retryPermitted: z.literal(false),
}).strict();

export const qualificationV2CaptureReleaseJournalSchema =
  qualificationV2CaptureReleaseJournalContentSchema.extend({ journalDigest: digestSchema }).strict();

const qualificationV2CaptureTerminalReceiptContentBaseSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-capture-terminal/v2"),
  taskId: taskIdSchema,
  captureActionDigest: digestSchema,
  captureNonce: digestSchema,
  requestBindingDigest: digestSchema,
  releaseJournalDigest: digestSchema,
  outcome: z.enum(["succeeded", "failed", "indeterminate"]),
  captureControllerReceiptDigest: digestSchema.nullable(),
  failureCode: z.enum([
    "QUALIFICATION_V2_CAPTURE_FAILED",
    "QUALIFICATION_V2_CAPTURE_INDETERMINATE",
  ]).nullable(),
  retainedAt: timestampSchema,
}).strict();

function refineCaptureTerminalOutcome(
  receipt: z.infer<typeof qualificationV2CaptureTerminalReceiptContentBaseSchema>,
  context: z.RefinementCtx,
) {
  const expectedFailureCode = receipt.outcome === "failed"
    ? "QUALIFICATION_V2_CAPTURE_FAILED"
    : receipt.outcome === "indeterminate"
      ? "QUALIFICATION_V2_CAPTURE_INDETERMINATE"
      : null;
  if ((receipt.outcome === "succeeded") !== (receipt.captureControllerReceiptDigest !== null)
      || receipt.failureCode !== expectedFailureCode) {
    context.addIssue({ code: "custom", message: "Capture terminal outcome is inconsistent." });
  }
}

export const qualificationV2CaptureTerminalReceiptContentSchema =
  qualificationV2CaptureTerminalReceiptContentBaseSchema.superRefine(refineCaptureTerminalOutcome);

export const qualificationV2CaptureTerminalReceiptSchema =
  qualificationV2CaptureTerminalReceiptContentBaseSchema.extend({ receiptDigest: digestSchema }).strict()
    .superRefine(refineCaptureTerminalOutcome);
const deploymentObservationsSchema = z.tuple([
  z.literal(baselineReceiptJson.deployment.deploymentId),
  z.literal(baselineReceiptJson.deployment.deploymentId),
]);

export const qualificationV2ProvisionControllerReceiptContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-room-controller-provision/v2"),
  taskId: taskIdSchema,
  roomReceiptDigest: digestSchema,
  storageStateDigest: digestSchema,
  deploymentId: z.literal(baselineReceiptJson.deployment.deploymentId),
  deploymentObservations: deploymentObservationsSchema,
  landingToolContractDigest: z.literal(baselineInventoryJson.landing.contractDigest),
  participantToolContractDigest: z.literal(baselineInventoryJson.participant.contractDigest),
  playwrightVersion: z.string().min(1),
  chromiumVersion: z.string().min(1),
  runtime: runtimeIdentitySchema,
  harnessRuntimeProvenance: qualificationV2HarnessRuntimeProvenanceSchema,
  createRoomCallResultDigest: digestSchema,
  blankReadCallResultDigest: digestSchema,
  fixtureTransactionCallResultDigest: digestSchema.nullable(),
  preAuthorReadCallResultDigest: digestSchema,
  frozenFixtureDeclarationDigest: digestSchema.nullable(),
  authoritativeInitialStateDigest: digestSchema,
  initialRoomRevision: z.number().int().nonnegative(),
  initialObjectCount: z.number().int().nonnegative(),
  retainedAt: timestampSchema,
}).strict();

export const qualificationV2ProvisionControllerReceiptSchema =
  qualificationV2ProvisionControllerReceiptContentSchema.extend({ receiptDigest: digestSchema }).strict();

export const qualificationV2CaptureControllerReceiptContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-room-controller-capture/v2"),
  taskId: taskIdSchema,
  roomReceiptDigest: digestSchema,
  provisionControllerReceiptDigest: digestSchema,
  storageStateDigest: digestSchema,
  deploymentId: z.literal(baselineReceiptJson.deployment.deploymentId),
  deploymentObservations: deploymentObservationsSchema,
  participantToolContractDigest: z.literal(baselineInventoryJson.participant.contractDigest),
  playwrightVersion: z.string().min(1),
  chromiumVersion: z.string().min(1),
  runtime: runtimeIdentitySchema,
  harnessRuntimeProvenance: qualificationV2HarnessRuntimeProvenanceSchema,
  roomRevision: z.number().int().positive(),
  objectCount: z.number().int().positive(),
  diagramCount: z.number().int().nonnegative(),
  closingReadCallResultDigest: digestSchema,
  inspectionCallResultDigest: digestSchema,
  pngCallResultDigest: digestSchema,
  pngByteDigest: digestSchema,
  pngByteLength: z.number().int().positive(),
  persistedByJazzboard: z.literal(false),
  retainedAt: timestampSchema,
}).strict();

export const qualificationV2CaptureControllerReceiptSchema =
  qualificationV2CaptureControllerReceiptContentSchema.extend({ receiptDigest: digestSchema }).strict();

function sealControllerReceipt<T extends Record<string, unknown>>(content: T) {
  return Object.freeze({ ...content, receiptDigest: hashCanonicalJson(content as unknown as JsonValue) });
}

export function sealQualificationV2CaptureAuthorization(
  content: z.input<typeof qualificationV2CaptureAuthorizationContentSchema>,
) {
  const parsed = qualificationV2CaptureAuthorizationContentSchema.parse(content);
  return qualificationV2CaptureAuthorizationSchema.parse(Object.freeze({
    ...parsed,
    actionDigest: hashCanonicalJson(parsed as unknown as JsonValue),
  }));
}

export function parseQualificationV2CaptureAuthorization(value: unknown) {
  const parsed = qualificationV2CaptureAuthorizationSchema.parse(value);
  const { actionDigest, ...content } = parsed;
  if (hashCanonicalJson(content as unknown as JsonValue) !== actionDigest
      || hashCanonicalJson(parsed.request as unknown as JsonValue) !== parsed.requestBindingDigest) {
    throw new Error("QUALIFICATION_V2_CAPTURE_AUTHORIZATION_DIGEST_INVALID");
  }
  return parsed;
}

export function sealQualificationV2CaptureReleaseJournal(
  content: z.input<typeof qualificationV2CaptureReleaseJournalContentSchema>,
) {
  const parsed = qualificationV2CaptureReleaseJournalContentSchema.parse(content);
  return qualificationV2CaptureReleaseJournalSchema.parse(Object.freeze({
    ...parsed,
    journalDigest: hashCanonicalJson(parsed as unknown as JsonValue),
  }));
}

export function parseQualificationV2CaptureReleaseJournal(value: unknown) {
  const parsed = qualificationV2CaptureReleaseJournalSchema.parse(value);
  const { journalDigest, ...content } = parsed;
  if (hashCanonicalJson(content as unknown as JsonValue) !== journalDigest) {
    throw new Error("QUALIFICATION_V2_CAPTURE_RELEASE_JOURNAL_DIGEST_INVALID");
  }
  return parsed;
}

export function sealQualificationV2CaptureTerminalReceipt(
  content: z.input<typeof qualificationV2CaptureTerminalReceiptContentSchema>,
) {
  const parsed = qualificationV2CaptureTerminalReceiptContentSchema.parse(content);
  return qualificationV2CaptureTerminalReceiptSchema.parse(Object.freeze({
    ...parsed,
    receiptDigest: hashCanonicalJson(parsed as unknown as JsonValue),
  }));
}

export function parseQualificationV2CaptureTerminalReceipt(value: unknown) {
  const parsed = qualificationV2CaptureTerminalReceiptSchema.parse(value);
  const { receiptDigest, ...content } = parsed;
  if (hashCanonicalJson(content as unknown as JsonValue) !== receiptDigest) {
    throw new Error("QUALIFICATION_V2_CAPTURE_TERMINAL_RECEIPT_DIGEST_INVALID");
  }
  return parsed;
}

export function sealQualificationV2ProvisionControllerReceipt(
  content: z.input<typeof qualificationV2ProvisionControllerReceiptContentSchema>,
) {
  const parsed = qualificationV2ProvisionControllerReceiptContentSchema.parse(content);
  return qualificationV2ProvisionControllerReceiptSchema.parse(sealControllerReceipt(parsed));
}

export function sealQualificationV2CaptureControllerReceipt(
  content: z.input<typeof qualificationV2CaptureControllerReceiptContentSchema>,
) {
  const parsed = qualificationV2CaptureControllerReceiptContentSchema.parse(content);
  return qualificationV2CaptureControllerReceiptSchema.parse(sealControllerReceipt(parsed));
}

export function parseQualificationV2ProvisionControllerReceipt(value: unknown) {
  const parsed = qualificationV2ProvisionControllerReceiptSchema.parse(value);
  const { receiptDigest, ...content } = parsed;
  if (hashCanonicalJson(content as unknown as JsonValue) !== receiptDigest) {
    throw new Error("QUALIFICATION_V2_PROVISION_CONTROLLER_RECEIPT_DIGEST_INVALID");
  }
  return parsed;
}

export function parseQualificationV2CaptureControllerReceipt(value: unknown) {
  const parsed = qualificationV2CaptureControllerReceiptSchema.parse(value);
  const { receiptDigest, ...content } = parsed;
  if (hashCanonicalJson(content as unknown as JsonValue) !== receiptDigest) {
    throw new Error("QUALIFICATION_V2_CAPTURE_CONTROLLER_RECEIPT_DIGEST_INVALID");
  }
  return parsed;
}
