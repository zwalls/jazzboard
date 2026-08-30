import { z } from "zod";

import {
  baselineFreezeReceiptSchema,
  baselineWebMcpInventorySchema,
  verifyBaselineFreezeReceipt,
  type BaselineFreezeReceipt,
  type BaselineWebMcpInventory,
} from "./baseline-freeze";
import { canonicalJson, sha256Digest, SHA256_DIGEST_PATTERN } from "./provenance-crypto";
import { findSecretLeakage } from "./provenance-redaction";

const sha256Schema = z.string().regex(SHA256_DIGEST_PATTERN);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40}$/);
const deploymentIdSchema = z.string().regex(/^dpl_[A-Za-z0-9]+$/);
const buildIdSchema = z.string().regex(/^bld_[A-Za-z0-9]+$/);
const httpsOriginSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    context.addIssue({ code: "custom", message: "Expected a credential-free HTTPS origin." });
  }
});

export const BASELINE_SPECTATOR_TOOL_NAMES = Object.freeze([
  "analyze_diagram_layout",
  "describe_diagram",
  "export_canvas_artifact",
  "export_canvas_png",
  "find_diagrams",
  "get_canvas_capabilities",
  "inspect_canvas_scope",
  "list_activity",
  "list_agent_edit_proposals",
  "query_objects",
  "read_activity",
  "read_agent_edit_proposal",
  "read_canvas_drafts",
  "read_collaboration_state",
  "read_diagram",
  "read_neighborhood",
  "read_room_state",
  "read_selection",
] as const);

const immutableFallbackDisclosure =
  "The public alias must be re-resolved through the authenticated Vercel CLI before every execution batch because the immutable deployment URL is protected.";
const scopeDisclosure =
  "This verifies live registration, schemas, role isolation, redaction, and browser-context separation; it is not an autonomous authoring result or product-quality score.";

/** Pins values that cannot be recomputed from the freeze or inventory alone. */
export const EXPECTED_BASELINE_LIVE_CONTRACT = Object.freeze({
  capturedAt: "2026-08-30T20:56:29.576Z",
  attemptId: "contract-prod-baseline-v6",
  scriptDigest: "sha256:c2cbeaf5b216a5699b7e7fcc88326ff78763988d33943256f8eb193112426c24",
  attemptBundleDigest: "sha256:b2a5ee97e285ac6ee6cd99d3912e3a73f4f3acc8f1f56ec8e03ae66cec7c7dff",
  artifactRoot: "sha256:9f4676e385dbc0b40b72a4216f2d4183fa87a74839bf76e6545f2849fb63fd26",
  participantContractDigest: "sha256:d64cf3d25b9e275003438597b3b01c35419063d71613082d45aaf2f97c388b8e",
  participantContractArtifactDigest: "sha256:2d30a59151eca6a0764256d82694b463a4111c84699ac5ad221581b1b846f62a",
  spectatorContractDigest: "sha256:1760c6b1ec8cc4d8814b3de6a8f4516b3f4c215da69069c50072f23128541be2",
  spectatorContractArtifactDigest: "sha256:1fdd0cfcfe657f94921946cebd5aa085cbd5a63cf5685becd783318d15b11149",
  receiptFileArtifactDigest: "sha256:d71dc2052428ac644ad09361358c65d4832823c2cc98ddb04773732f190716fd",
  elapsedMs: 8_203,
  node: "v22.22.0",
  browserEngine: "chromium",
  browserVersion: "151.0.7922.34",
  viewport: Object.freeze({ width: 1_280, height: 720, deviceScaleFactor: 1 }),
  immutableFallbackDisclosure,
  scopeDisclosure,
} as const);

const liveContractDigestPairSchema = z.object({
  toolCount: z.number().int().positive(),
  contractDigest: sha256Schema,
  contractArtifactDigest: sha256Schema,
}).strict();

export const baselineLiveContractReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("public-production-webmcp-contract-verification"),
  capturedAt: z.string().datetime({ offset: true }),
  baseline: z.object({
    gitCommit: gitObjectSchema,
    gitTree: gitObjectSchema,
    deploymentId: deploymentIdSchema,
    buildId: buildIdSchema,
    immutableDeploymentUrl: httpsOriginSchema,
    executionUrl: httpsOriginSchema,
    executionUrlVerifiedDeploymentId: deploymentIdSchema,
    aliasPreflight: z.literal("authenticated_vercel_cli_immediately_before_contract"),
    immutableUrlAccess: z.literal("deployment_protection_requires_authenticated_bypass"),
  }).strict(),
  runner: z.object({
    attemptId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
    mode: z.literal("contract"),
    status: z.literal("contract_verified"),
    scriptDigest: sha256Schema,
    attemptBundleDigest: sha256Schema,
    artifactRoot: sha256Schema,
    elapsedMs: z.number().int().positive(),
    node: z.string().regex(/^v\d+\.\d+\.\d+$/),
    browser: z.object({
      engine: z.literal("chromium"),
      version: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/),
    }).strict(),
    viewport: z.object({
      width: z.literal(1_280),
      height: z.literal(720),
      deviceScaleFactor: z.literal(1),
    }).strict(),
    responsesApiInvoked: z.literal(false),
    authorContextClosedBeforeEvaluation: z.literal(true),
  }).strict(),
  participant: liveContractDigestPairSchema,
  spectator: liveContractDigestPairSchema.extend({
    toolCount: z.literal(18),
    toolNames: z.tuple(BASELINE_SPECTATOR_TOOL_NAMES.map((name) => z.literal(name)) as [
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[0]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[1]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[2]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[3]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[4]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[5]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[6]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[7]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[8]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[9]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[10]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[11]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[12]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[13]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[14]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[15]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[16]>,
      z.ZodLiteral<(typeof BASELINE_SPECTATOR_TOOL_NAMES)[17]>,
    ]),
  }).strict(),
  privacy: z.object({
    roomIdentifiersPersisted: z.literal(false),
    sessionCredentialsPersisted: z.literal(false),
    apiCredentialsPersisted: z.literal(false),
    responsesApiInvoked: z.literal(false),
  }).strict(),
  limitations: z.tuple([
    z.literal(immutableFallbackDisclosure),
    z.literal(scopeDisclosure),
  ]),
}).strict().superRefine((receipt, context) => {
  for (const [role, pair] of [
    ["participant", receipt.participant],
    ["spectator", receipt.spectator],
  ] as const) {
    if (pair.contractDigest === pair.contractArtifactDigest) {
      context.addIssue({
        code: "custom",
        path: [role, "contractArtifactDigest"],
        message: "A live normalized contract digest is not its serialized artifact-byte digest.",
      });
    }
  }
});

export type BaselineLiveContractReceipt = z.infer<typeof baselineLiveContractReceiptSchema>;

export type LiveContractReceiptArtifactInput = {
  runnerScriptBytes?: string | Uint8Array;
  receiptFileBytes?: string | Uint8Array;
  knownSecrets?: readonly string[];
};

export type LiveContractDigestEvidence = {
  participant: string;
  spectator: string;
};

export type DeclaredArtifactDigestEvidence = {
  runnerScriptFile: string;
  attemptBundleFile: string;
  participantContractFile: string;
  spectatorContractFile: string;
  artifactSetRoot: string;
};

export type VerifiedFileByteDigestEvidence = {
  runnerScript: string | null;
  receiptFile: string | null;
};

export type BaselineLiveContractVerification =
  | {
      ok: true;
      receipt: BaselineLiveContractReceipt;
      freeze: BaselineFreezeReceipt;
      inventory: BaselineWebMcpInventory;
      liveContractDigests: LiveContractDigestEvidence;
      declaredArtifactDigests: DeclaredArtifactDigestEvidence;
      verifiedFileByteDigests: VerifiedFileByteDigestEvidence;
    }
  | {
      ok: false;
      errors: string[];
      liveContractDigests: LiveContractDigestEvidence | null;
      declaredArtifactDigests: DeclaredArtifactDigestEvidence | null;
      verifiedFileByteDigests: VerifiedFileByteDigestEvidence;
    };

function bytesOf(value: string | Uint8Array): string | Uint8Array {
  return typeof value === "string" ? value : value;
}

function textOf(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function schemaErrors(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => `${prefix}${issue.path.length ? `/${issue.path.join("/")}` : ""}: ${issue.message}`);
}

function mismatch(errors: string[], label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) errors.push(`${label} does not match the frozen baseline live contract.`);
}

/** Allows only the publishable boolean assertion about persisted session credentials. */
export function findLiveContractSensitiveFields(value: unknown, knownSecrets: readonly string[] = []): string[] {
  const privacy = value !== null && typeof value === "object"
    ? (value as { privacy?: Record<string, unknown> }).privacy
    : undefined;
  const allowed = new Set([
    ...(typeof privacy?.roomIdentifiersPersisted === "boolean"
      ? ["/privacy/roomIdentifiersPersisted:secret-key"]
      : []),
    ...(typeof privacy?.sessionCredentialsPersisted === "boolean"
      ? ["/privacy/sessionCredentialsPersisted:secret-key"]
      : []),
  ]);
  return findSecretLeakage(value, knownSecrets).filter((finding) => !allowed.has(finding));
}

function liveDigestEvidence(receipt: BaselineLiveContractReceipt): LiveContractDigestEvidence {
  return {
    participant: receipt.participant.contractDigest,
    spectator: receipt.spectator.contractDigest,
  };
}

function declaredArtifactDigestEvidence(receipt: BaselineLiveContractReceipt): DeclaredArtifactDigestEvidence {
  return {
    runnerScriptFile: receipt.runner.scriptDigest,
    attemptBundleFile: receipt.runner.attemptBundleDigest,
    participantContractFile: receipt.participant.contractArtifactDigest,
    spectatorContractFile: receipt.spectator.contractArtifactDigest,
    artifactSetRoot: receipt.runner.artifactRoot,
  };
}

function verifyPinnedLiveValues(errors: string[], receipt: BaselineLiveContractReceipt): void {
  const expected = EXPECTED_BASELINE_LIVE_CONTRACT;
  mismatch(errors, "capture timestamp", receipt.capturedAt, expected.capturedAt);
  mismatch(errors, "attempt ID", receipt.runner.attemptId, expected.attemptId);
  mismatch(errors, "runner script digest", receipt.runner.scriptDigest, expected.scriptDigest);
  mismatch(errors, "attempt-bundle artifact digest", receipt.runner.attemptBundleDigest, expected.attemptBundleDigest);
  mismatch(errors, "attempt artifact root", receipt.runner.artifactRoot, expected.artifactRoot);
  mismatch(errors, "participant normalized contract digest", receipt.participant.contractDigest, expected.participantContractDigest);
  mismatch(errors, "participant contract artifact digest", receipt.participant.contractArtifactDigest, expected.participantContractArtifactDigest);
  mismatch(errors, "spectator normalized contract digest", receipt.spectator.contractDigest, expected.spectatorContractDigest);
  mismatch(errors, "spectator contract artifact digest", receipt.spectator.contractArtifactDigest, expected.spectatorContractArtifactDigest);
  mismatch(errors, "contract elapsed time", receipt.runner.elapsedMs, expected.elapsedMs);
  mismatch(errors, "runner Node version", receipt.runner.node, expected.node);
  mismatch(errors, "browser engine", receipt.runner.browser.engine, expected.browserEngine);
  mismatch(errors, "browser version", receipt.runner.browser.version, expected.browserVersion);
  mismatch(errors, "viewport width", receipt.runner.viewport.width, expected.viewport.width);
  mismatch(errors, "viewport height", receipt.runner.viewport.height, expected.viewport.height);
  mismatch(errors, "viewport scale", receipt.runner.viewport.deviceScaleFactor, expected.viewport.deviceScaleFactor);
}

function verifyArtifactBytes(
  errors: string[],
  receiptInput: unknown,
  parsedReceipt: BaselineLiveContractReceipt | null,
  artifacts: LiveContractReceiptArtifactInput,
): VerifiedFileByteDigestEvidence {
  let runnerScript: string | null = null;
  let receiptFile: string | null = null;
  if (artifacts.runnerScriptBytes !== undefined) {
    runnerScript = sha256Digest(bytesOf(artifacts.runnerScriptBytes));
    if (!parsedReceipt || runnerScript !== parsedReceipt.runner.scriptDigest) {
      errors.push("Runner script artifact bytes do not match runner.scriptDigest.");
    }
  }
  if (artifacts.receiptFileBytes !== undefined) {
    receiptFile = sha256Digest(bytesOf(artifacts.receiptFileBytes));
    if (receiptFile !== EXPECTED_BASELINE_LIVE_CONTRACT.receiptFileArtifactDigest) {
      errors.push("Receipt file artifact bytes do not match the checked-in receipt-file digest.");
    }
    try {
      const parsedBytes = JSON.parse(textOf(artifacts.receiptFileBytes)) as unknown;
      if (canonicalJson(parsedBytes) !== canonicalJson(receiptInput)) {
        errors.push("Receipt file bytes do not encode the supplied receipt value.");
      }
    } catch (error) {
      errors.push(`Receipt file bytes are not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { runnerScript, receiptFile };
}

export function verifyBaselineLiveContractReceipt(
  receiptInput: unknown,
  freezeInput: unknown,
  inventoryInput: unknown,
  artifacts: LiveContractReceiptArtifactInput = {},
): BaselineLiveContractVerification {
  const receiptResult = baselineLiveContractReceiptSchema.safeParse(receiptInput);
  const freezeResult = baselineFreezeReceiptSchema.safeParse(freezeInput);
  const inventoryResult = baselineWebMcpInventorySchema.safeParse(inventoryInput);
  const errors = [
    ...(receiptResult.success ? [] : schemaErrors("receipt", receiptResult.error)),
    ...(freezeResult.success ? [] : schemaErrors("freeze", freezeResult.error)),
    ...(inventoryResult.success ? [] : schemaErrors("inventory", inventoryResult.error)),
  ];
  const receipt = receiptResult.success ? receiptResult.data : null;
  const verifiedFileByteDigests = verifyArtifactBytes(errors, receiptInput, receipt, artifacts);
  const sensitive = findLiveContractSensitiveFields(receiptInput, artifacts.knownSecrets);
  if (sensitive.length) errors.push(`Sensitive material is not publishable: ${sensitive.join(", ")}`);

  if (!receipt || !freezeResult.success || !inventoryResult.success) {
    return {
      ok: false,
      errors,
      liveContractDigests: receipt ? liveDigestEvidence(receipt) : null,
      declaredArtifactDigests: receipt ? declaredArtifactDigestEvidence(receipt) : null,
      verifiedFileByteDigests,
    };
  }

  const freezeVerification = verifyBaselineFreezeReceipt(freezeResult.data, inventoryResult.data);
  if (!freezeVerification.ok) {
    errors.push(...freezeVerification.errors.map((error) => `Frozen baseline prerequisite: ${error}`));
  }
  const freeze = freezeResult.data;
  const inventory = inventoryResult.data;
  verifyPinnedLiveValues(errors, receipt);

  mismatch(errors, "Git commit", receipt.baseline.gitCommit, freeze.product.gitCommit);
  mismatch(errors, "Git tree", receipt.baseline.gitTree, freeze.product.gitTree);
  mismatch(errors, "deployment ID", receipt.baseline.deploymentId, freeze.deployment.deploymentId);
  mismatch(errors, "build ID", receipt.baseline.buildId, freeze.deployment.buildId);
  mismatch(errors, "immutable deployment URL", receipt.baseline.immutableDeploymentUrl, freeze.deployment.immutableUrl);
  mismatch(errors, "public execution alias", receipt.baseline.executionUrl, freeze.deployment.productionUrl);
  mismatch(
    errors,
    "public alias verified deployment ID",
    receipt.baseline.executionUrlVerifiedDeploymentId,
    freeze.deployment.deploymentId,
  );
  if (receipt.baseline.executionUrl === receipt.baseline.immutableDeploymentUrl) {
    errors.push("Public execution alias and immutable deployment URL must retain distinct roles.");
  }

  mismatch(errors, "participant tool count", receipt.participant.toolCount, inventory.participant.toolCount);
  const participantNames = new Set(inventory.participant.tools.map((tool) => tool.name));
  const missingSpectatorTools = receipt.spectator.toolNames.filter((name) => !participantNames.has(name));
  if (missingSpectatorTools.length) {
    errors.push(`Spectator allowlist contains tools absent from the participant inventory: ${missingSpectatorTools.join(", ")}.`);
  }
  if (receipt.spectator.toolNames.some((name) => /^(?:add|apply|approve|claim|create|delete|dismiss|draw|edit|enable|finish|focus|follow|group|instantiate|join|leave|move|remove|reply|request|revert|start|stop|update)_/.test(name))) {
    errors.push("Spectator allowlist contains a mutation or collaboration-control tool.");
  }

  const liveContractDigests = liveDigestEvidence(receipt);
  const declaredArtifactDigests = declaredArtifactDigestEvidence(receipt);
  return errors.length === 0
    ? {
        ok: true,
        receipt,
        freeze,
        inventory,
        liveContractDigests,
        declaredArtifactDigests,
        verifiedFileByteDigests,
      }
    : { ok: false, errors, liveContractDigests, declaredArtifactDigests, verifiedFileByteDigests };
}

export function assertBaselineLiveContractReceipt(
  receiptInput: unknown,
  freezeInput: unknown,
  inventoryInput: unknown,
  artifacts: LiveContractReceiptArtifactInput = {},
): BaselineLiveContractReceipt {
  const verification = verifyBaselineLiveContractReceipt(receiptInput, freezeInput, inventoryInput, artifacts);
  if (!verification.ok) throw new Error(`Invalid baseline live-contract receipt: ${verification.errors.join(" ")}`);
  return verification.receipt;
}
