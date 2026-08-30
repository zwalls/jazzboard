import { z } from "zod";

import { hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";
import { findSecretLeakage } from "./provenance-redaction";

const sha256Schema = z.string().regex(SHA256_DIGEST_PATTERN);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40}$/);
const httpsUrlSchema = z.string().url().refine((value) => new URL(value).protocol === "https:", {
  message: "Expected an HTTPS URL.",
});

export const baselineHealthBodySchema = z.object({
  ok: z.boolean(),
  environment: z.string().min(1),
  realtime: z.string().min(1),
  assets: z.string().min(1),
  assetPrivacy: z.string().min(1).nullable(),
  synchronization: z.object({
    storage: z.string().min(1),
    documentRevision: z.string().min(1),
    aggregateRevision: z.string().min(1),
    mutationIdempotency: z.string().min(1),
  }).strict(),
  capacity: z.object({
    mode: z.string().min(1),
    limits: z.object({
      durableDocumentBytes: z.number().int().nonnegative(),
      awarenessBytes: z.number().int().nonnegative(),
      coordinationBytes: z.number().int().nonnegative(),
      persistedRoomBytes: z.number().int().nonnegative(),
      retainedProposalBytes: z.number().int().nonnegative(),
      activityBytes: z.number().int().nonnegative(),
      objects: z.number().int().nonnegative(),
      diagrams: z.number().int().nonnegative(),
      participants: z.number().int().nonnegative(),
      drawingPoints: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  canvasRenderer: z.object({
    id: z.string().min(1),
    ownership: z.string().min(1),
  }).strict(),
  checks: z.object({
    redis: z.boolean(),
    blob: z.boolean(),
    blobConfigured: z.boolean(),
    blobPrivate: z.boolean(),
    sessionSecret: z.boolean(),
    cronSecret: z.boolean(),
    assetStorage: z.boolean(),
  }).strict(),
  missing: z.array(z.string()),
  warnings: z.array(z.string()),
}).strict();

const inventoryToolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  definitionDigest: sha256Schema,
}).strict();

const inventoryScopeSchema = z.object({
  toolCount: z.number().int().nonnegative(),
  inventoryDigest: sha256Schema,
  tools: z.array(inventoryToolSchema),
}).strict();

export const baselineWebMcpInventorySchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.string().datetime({ offset: true }),
  deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
  origin: httpsUrlSchema,
  landing: inventoryScopeSchema,
  participant: inventoryScopeSchema,
}).strict();

const baselineFreezeContentSchema = z.object({
  schemaVersion: z.literal(1),
  receiptId: z.literal("baseline-freeze-v1"),
  frozenAt: z.string().datetime({ offset: true }),
  product: z.object({
    gitCommit: gitObjectSchema,
    gitTree: gitObjectSchema,
    nodeVersion: z.string().min(1),
    roomRouteDigest: sha256Schema,
  }).strict(),
  deployment: z.object({
    deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
    buildId: z.string().regex(/^bld_[A-Za-z0-9]+$/),
    immutableUrl: httpsUrlSchema,
    productionUrl: httpsUrlSchema,
    state: z.string().min(1),
    createdAt: z.number().int().safe().nonnegative(),
    buildIdentityDigest: sha256Schema,
  }).strict(),
  health: z.object({
    url: httpsUrlSchema,
    status: z.number().int().min(100).max(599),
    body: baselineHealthBodySchema,
    bodyDigest: sha256Schema,
  }).strict(),
  webMcpInventory: z.object({
    path: z.literal("research/data/baseline-webmcp-inventory-v1.json"),
    fileDigest: sha256Schema,
    landing: z.object({
      toolCount: z.number().int().nonnegative(),
      inventoryDigest: sha256Schema,
    }).strict(),
    participant: z.object({
      toolCount: z.number().int().nonnegative(),
      inventoryDigest: sha256Schema,
    }).strict(),
  }).strict(),
  sensitiveMaterialRedacted: z.literal(true),
}).strict();

export const baselineFreezeReceiptSchema = baselineFreezeContentSchema.extend({
  receiptDigest: sha256Schema,
}).strict();

export type BaselineHealthBody = z.infer<typeof baselineHealthBodySchema>;
export type BaselineWebMcpInventory = z.infer<typeof baselineWebMcpInventorySchema>;
export type BaselineFreezeReceipt = z.infer<typeof baselineFreezeReceiptSchema>;

export type BaselineFreezeVerification =
  | { ok: true; receipt: BaselineFreezeReceipt; inventory: BaselineWebMcpInventory }
  | { ok: false; errors: string[] };

export const EXPECTED_BASELINE_FREEZE = Object.freeze({
  gitCommit: "48a52e0837144ea0db8a09e43217397226759f83",
  gitTree: "a25e8ec9f8fcc08b227d710a8517333af90f491e",
  deploymentId: "dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD",
  buildId: "bld_crjsfx08s",
  immutableUrl: "https://jazzboard-noy5qxxfd-zwalls-projects.vercel.app",
  productionUrl: "https://www.jazzboard.xyz",
  state: "READY",
  createdAt: 1_788_119_806_714,
  nodeVersion: "24.x",
  roomRouteDigest: "sha256:8a2e7309dc54e2ad70de749525d2c3b41c8bb68c1ece5cd9a55e565a971e8b55",
  buildIdentityDigest: "sha256:0342169d87c8c5b4aa770745222488fe934e83940a01e296872daa096e6465d4",
  healthDigest: "sha256:865fdd40a151c3f9e95d675d2d10b20b211e2734bae94f20b7b1dcfc4a91cc61",
  inventoryFileDigest: "sha256:e9c82b98c02fd747bc3d6015bdf2235e6249099c3e2124ef2770f818eb37f5da",
  landingToolCount: 5,
  landingInventoryDigest: "sha256:37369b1b3bec8fa9f0c591c479a8852e5ea52254b4ab9da8239d4a66eba2b376",
  participantToolCount: 54,
  participantInventoryDigest: "sha256:dd0a654798c27dc7a4cef64408fe583f1a3fdf51b097f1cac21c5534af436997",
} as const);

function formatSchemaIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => `${prefix}${issue.path.length ? `/${issue.path.join("/")}` : ""}: ${issue.message}`);
}

function pushMismatch(errors: string[], label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) errors.push(`${label} does not match the frozen baseline.`);
}

function contentOf(receipt: BaselineFreezeReceipt): z.infer<typeof baselineFreezeContentSchema> {
  return baselineFreezeContentSchema.parse(Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== "receiptDigest"),
  ));
}

/** Canonical digest of every receipt field except the self-referential digest. */
export function computeBaselineFreezeReceiptDigest(receipt: BaselineFreezeReceipt): string {
  return hashCanonicalJson(contentOf(receipt));
}

/**
 * Finds publishability violations while allowing only boolean health assertions
 * named sessionSecret and cronSecret. The receipt never contains their values.
 */
export function findBaselineFreezeSensitiveFields(value: unknown): string[] {
  const healthChecks = value !== null && typeof value === "object"
    ? (value as { health?: { body?: { checks?: Record<string, unknown> } } }).health?.body?.checks
    : undefined;
  const allowedBooleanAssertions = new Set([
    ...(typeof healthChecks?.sessionSecret === "boolean" ? ["/health/body/checks/sessionSecret:secret-key"] : []),
    ...(typeof healthChecks?.cronSecret === "boolean" ? ["/health/body/checks/cronSecret:secret-key"] : []),
  ]);
  return findSecretLeakage(value).filter((finding) => (
    !allowedBooleanAssertions.has(finding)
  ));
}

function verifyInventoryScope(
  errors: string[],
  label: "landing" | "participant",
  scope: BaselineWebMcpInventory["landing"],
  expectedCount: number,
  expectedDigest: string,
): void {
  pushMismatch(errors, `${label} inventory count`, scope.toolCount, expectedCount);
  pushMismatch(errors, `${label} inventory digest`, scope.inventoryDigest, expectedDigest);
  if (scope.tools.length !== scope.toolCount) errors.push(`${label} tool array length does not match its count.`);
  if (new Set(scope.tools.map((tool) => tool.name)).size !== scope.tools.length) errors.push(`${label} inventory contains duplicate tool names.`);
  if (scope.tools.some((tool, index) => index > 0 && scope.tools[index - 1].name.localeCompare(tool.name) >= 0)) {
    errors.push(`${label} inventory tools are not uniquely sorted by name.`);
  }
}

export function verifyBaselineFreezeReceipt(
  receiptInput: unknown,
  inventoryInput: unknown,
): BaselineFreezeVerification {
  const receiptResult = baselineFreezeReceiptSchema.safeParse(receiptInput);
  const inventoryResult = baselineWebMcpInventorySchema.safeParse(inventoryInput);
  const schemaErrors = [
    ...(receiptResult.success ? [] : formatSchemaIssues("receipt", receiptResult.error)),
    ...(inventoryResult.success ? [] : formatSchemaIssues("inventory", inventoryResult.error)),
  ];
  if (!receiptResult.success || !inventoryResult.success) return { ok: false, errors: schemaErrors };

  const receipt = receiptResult.data;
  const inventory = inventoryResult.data;
  const expected = EXPECTED_BASELINE_FREEZE;
  const errors: string[] = [];

  pushMismatch(errors, "receipt digest", computeBaselineFreezeReceiptDigest(receipt), receipt.receiptDigest);
  pushMismatch(errors, "Git commit", receipt.product.gitCommit, expected.gitCommit);
  pushMismatch(errors, "Git tree", receipt.product.gitTree, expected.gitTree);
  pushMismatch(errors, "Node version", receipt.product.nodeVersion, expected.nodeVersion);
  pushMismatch(errors, "room route digest", receipt.product.roomRouteDigest, expected.roomRouteDigest);
  pushMismatch(errors, "deployment ID", receipt.deployment.deploymentId, expected.deploymentId);
  pushMismatch(errors, "build ID", receipt.deployment.buildId, expected.buildId);
  pushMismatch(errors, "immutable deployment URL", receipt.deployment.immutableUrl, expected.immutableUrl);
  pushMismatch(errors, "production URL", receipt.deployment.productionUrl, expected.productionUrl);
  pushMismatch(errors, "deployment state", receipt.deployment.state, expected.state);
  pushMismatch(errors, "deployment creation time", receipt.deployment.createdAt, expected.createdAt);
  pushMismatch(errors, "build identity digest", receipt.deployment.buildIdentityDigest, expected.buildIdentityDigest);

  pushMismatch(errors, "health URL", receipt.health.url, `${expected.productionUrl}/api/health`);
  pushMismatch(errors, "health status", receipt.health.status, 200);
  pushMismatch(errors, "canonical health digest", hashCanonicalJson(receipt.health.body), receipt.health.bodyDigest);
  pushMismatch(errors, "captured health digest", receipt.health.bodyDigest, expected.healthDigest);

  pushMismatch(errors, "inventory deployment ID", inventory.deploymentId, expected.deploymentId);
  pushMismatch(errors, "inventory origin", inventory.origin, expected.productionUrl);
  pushMismatch(errors, "receipt and inventory capture time", receipt.frozenAt, inventory.capturedAt);
  pushMismatch(errors, "canonical inventory file digest", hashCanonicalJson(inventory), receipt.webMcpInventory.fileDigest);
  pushMismatch(errors, "captured inventory file digest", receipt.webMcpInventory.fileDigest, expected.inventoryFileDigest);
  verifyInventoryScope(errors, "landing", inventory.landing, expected.landingToolCount, expected.landingInventoryDigest);
  verifyInventoryScope(errors, "participant", inventory.participant, expected.participantToolCount, expected.participantInventoryDigest);
  pushMismatch(errors, "receipt landing tool count", receipt.webMcpInventory.landing.toolCount, inventory.landing.toolCount);
  pushMismatch(errors, "receipt landing inventory digest", receipt.webMcpInventory.landing.inventoryDigest, inventory.landing.inventoryDigest);
  pushMismatch(errors, "receipt participant tool count", receipt.webMcpInventory.participant.toolCount, inventory.participant.toolCount);
  pushMismatch(errors, "receipt participant inventory digest", receipt.webMcpInventory.participant.inventoryDigest, inventory.participant.inventoryDigest);

  const sensitiveFindings = [
    ...findBaselineFreezeSensitiveFields(receipt),
    ...findSecretLeakage(inventory).map((finding) => `/inventory${finding}`),
  ];
  if (sensitiveFindings.length > 0) errors.push(`Sensitive material is not publishable: ${sensitiveFindings.join(", ")}`);

  return errors.length === 0 ? { ok: true, receipt, inventory } : { ok: false, errors };
}

export function assertBaselineFreezeReceipt(receiptInput: unknown, inventoryInput: unknown): BaselineFreezeReceipt {
  const verification = verifyBaselineFreezeReceipt(receiptInput, inventoryInput);
  if (!verification.ok) throw new Error(`Invalid baseline freeze receipt: ${verification.errors.join(" ")}`);
  return verification.receipt;
}
