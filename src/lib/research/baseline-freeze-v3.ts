import { z } from "zod";

import predecessorReceiptJson from "../../../research/data/baseline-freeze-v2.json";
import predecessorSignatureJson from "../../../research/data/baseline-freeze-v2-authority-signature.json";
import {
  BASELINE_V2_SPECTATOR_TOOL_NAMES,
  baselinePrivateWebMcpInventoryV2Schema,
  baselineProductionEvidenceV2Schema,
  baselineWebMcpInventoryV2Schema,
  baselineFreezeReceiptV2Schema,
} from "./baseline-freeze-v2";
import {
  verifyBaselineFreezeV2AuthoritySignature,
  baselineFreezeV2AuthoritySignatureSchema,
} from "./baseline-freeze-v2-authority";
import {
  BASELINE_FREEZE_V3_AUTHORITY_KEY_ID,
  BASELINE_FREEZE_V3_AUTHORITY_KEY_PURPOSE,
  BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_DIGEST,
  BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_PATH,
  BASELINE_FREEZE_V3_AUTHORITY_SIGNATURE_VERSION,
  baselineFreezeV3AuthoritySignatureSchema,
  verifyBaselineFreezeV3AuthoritySignature,
} from "./baseline-freeze-v3-authority";
import {
  canonicalJson,
  hashCanonicalJson,
  sha256Digest,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";
import { findSecretLeakage } from "./provenance-redaction";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const fileBindingSchema = z.object({
  filename: z.string().min(1),
  fileDigest: digestSchema,
  canonicalDigest: digestSchema,
}).strict();

export const baselineWebMcpInventoryV3Schema = baselineWebMcpInventoryV2Schema.extend({
  schemaVersion: z.literal(3),
  deploymentId: z.literal("dpl_CePet5gs1u52rMvQUGye92qByJAQ"),
}).strict();

export const baselinePrivateWebMcpInventoryV3Schema = baselinePrivateWebMcpInventoryV2Schema.extend({
  deploymentId: z.literal("dpl_CePet5gs1u52rMvQUGye92qByJAQ"),
}).strict();

const progressiveDraftFinishSchema = z.object({
  stageTool: z.literal("apply_canvas_transaction"),
  finishTool: z.literal("finish_canvas_draft"),
  stageOutcome: z.literal("drafted"),
  finishOutcome: z.literal("applied"),
  stageCallResultDigest: digestSchema,
  finishCallResultDigest: digestSchema,
  directFallbackUsed: z.literal(false),
  finishInvocationCount: z.literal(1),
}).strict();

export const baselineProductionEvidenceV3Schema = baselineProductionEvidenceV2Schema.extend({
  schemaVersion: z.literal(3),
  deploymentId: z.literal("dpl_CePet5gs1u52rMvQUGye92qByJAQ"),
  progressiveDraftFinish: progressiveDraftFinishSchema,
}).strict();

const baselineFreezeV3ContentSchema = z.object({
  schemaVersion: z.literal("baseline-freeze/v3"),
  receiptId: z.literal("EXP-0001A-production-baseline-v3"),
  frozenAt: z.string().datetime({ offset: true }),
  supersedes: z.object({
    receiptPath: z.literal("research/data/baseline-freeze-v2.json"),
    receiptFileDigest: z.literal("sha256:db6431ea6f553f479d2eac3c6d58c996ff0cfc4778676e917c2d3bf704375b48"),
    receiptDigest: z.literal("sha256:e5568148fa6175bfb59692422da3785920b2beebc127bbab4da804e1362cbd68"),
    authoritySignaturePath: z.literal("research/data/baseline-freeze-v2-authority-signature.json"),
    authoritySignatureFileDigest: z.literal("sha256:f9bddd094f5d14b51783f808b4bb83bb97fed2f7b5887cba8199dbd7d83d3a19"),
    authoritySignatureDigest: z.literal("sha256:e008c03aa3353a4fd0c838de28406be97e2fdcf20a50a7b1e43be117a3301368"),
    predecessorBytesMutated: z.literal(false),
  }).strict(),
  product: z.object({
    gitCommit: z.literal("4eb6d9862cd1e805906a338d524529b6b7019639"),
    gitTree: z.literal("100447743f672f103d9cbe7c8c3d6d48e2bca4eb"),
    nodeVersion: z.literal("24.x"),
    humanArtifactRouteDigest: z.literal("sha256:6a3476b2e5e822216d2f299dc9f98699184c68afa146d1bc5f8ffaf8802f9907"),
    agentArtifactRouteDigest: z.literal("sha256:0fcd0460d9fe2ba293546a4f8db8b4b2fb1bcea1d5a83ebdc191341e26c18387"),
    vercelIgnoreDigest: z.literal("sha256:74b4bbad890403917074ccc02d90c21036586876d06928c8cbd385f1ebb23c6b"),
  }).strict(),
  deployment: z.object({
    deploymentId: z.literal("dpl_CePet5gs1u52rMvQUGye92qByJAQ"),
    buildId: z.literal("bld_nuf9lecj0"),
    immutableUrl: z.literal("https://jazzboard-bbjdgxi13-zwalls-projects.vercel.app"),
    productionUrl: z.literal("https://www.jazzboard.xyz"),
    state: z.literal("READY"),
    createdAt: z.literal(1_788_295_092_399),
    buildIdentityDigest: z.literal("sha256:16ffa0595484a70bfaf4395a092401cf1c3437200a65bbd1de246b99d60c0234"),
  }).strict(),
  capture: z.object({
    scriptPath: z.literal("research/scripts/capture-baseline-v3.mjs"),
    scriptDigest: digestSchema,
    publicInventory: fileBindingSchema.extend({
      path: z.literal("research/data/baseline-webmcp-inventory-v3.json"),
    }).omit({ filename: true }).strict(),
    publicEvidence: fileBindingSchema.extend({
      path: z.literal("research/data/baseline-production-evidence-v3.json"),
    }).omit({ filename: true }).strict(),
    privateInventory: fileBindingSchema.extend({
      filename: z.literal("baseline-webmcp-inventory-private-v2.json"),
    }).strict(),
    semanticArtifact: fileBindingSchema.extend({
      filename: z.literal("baseline-semantic-artifact-redacted-v2.json"),
    }).strict(),
    semanticHandler: fileBindingSchema.extend({
      filename: z.literal("baseline-semantic-handler-redacted-v2.json"),
    }).strict(),
    authoritativeState: fileBindingSchema.extend({
      filename: z.literal("baseline-authoritative-state-redacted-v2.json"),
    }).strict(),
    captureHistory: fileBindingSchema.extend({
      filename: z.literal("exp0001a-baseline-v2-capture-history-run5.json"),
    }).strict(),
    exactRevisionPng: z.object({
      filename: z.literal("baseline-exact-revision-v2.png"),
      fileDigest: digestSchema,
      byteLength: z.number().int().positive(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }).strict(),
    progressiveDraftStage: fileBindingSchema.extend({
      filename: z.literal("baseline-progressive-draft-stage-call-result-v3.json"),
    }).strict(),
    progressiveDraftFinish: fileBindingSchema.extend({
      filename: z.literal("baseline-progressive-draft-finish-call-result-v3.json"),
    }).strict(),
    transport: z.literal("browser-webmcp"),
    codexNativeOnly: z.literal(true),
  }).strict(),
  adaptationDisclosure: z.object({
    trigger: z.literal("progressive_draft_expiry_observed_in_transport_only_spike"),
    transportSpikePath: z.literal("research/data/exp0001a-browser-attached-transport-spike-public-v1.json"),
    transportSpikeDigest: digestSchema,
    priorAdmissibleQualificationResults: z.literal(0),
    priorBlindedReviewerArtifacts: z.literal(0),
    qualityImprovementInferencePermitted: z.literal(false),
  }).strict(),
  authority: z.object({
    signaturePath: z.literal("research/data/baseline-freeze-v3-authority-signature.json"),
    signatureSchema: z.literal(BASELINE_FREEZE_V3_AUTHORITY_SIGNATURE_VERSION),
    keyPurpose: z.literal(BASELINE_FREEZE_V3_AUTHORITY_KEY_PURPOSE),
    keyId: z.literal(BASELINE_FREEZE_V3_AUTHORITY_KEY_ID),
    publicKeyPath: z.literal(BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_PATH),
    publicKeyDigest: z.literal(BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_DIGEST),
  }).strict(),
  sensitiveMaterialRedacted: z.literal(true),
}).strict();

export const baselineFreezeReceiptV3Schema = baselineFreezeV3ContentSchema.extend({
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest: _receiptDigest, ...content } = receipt;
  void _receiptDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== receipt.receiptDigest) {
    context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Baseline-v3 receipt digest is invalid." });
  }
});

export type BaselineFreezeReceiptV3 = z.infer<typeof baselineFreezeReceiptV3Schema>;
export type BaselineWebMcpInventoryV3 = z.infer<typeof baselineWebMcpInventoryV3Schema>;
export type BaselineProductionEvidenceV3 = z.infer<typeof baselineProductionEvidenceV3Schema>;

function contentOf(receipt: BaselineFreezeReceiptV3) {
  return baselineFreezeV3ContentSchema.parse(Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== "receiptDigest"),
  ));
}

export function computeBaselineFreezeReceiptV3Digest(receipt: BaselineFreezeReceiptV3): string {
  return hashCanonicalJson(contentOf(receipt));
}

export type BaselineV3ArtifactBytes = Readonly<{
  receiptFileBytes?: string | Uint8Array;
  inventoryFileBytes?: string | Uint8Array;
  evidenceFileBytes?: string | Uint8Array;
  captureScriptBytes?: string | Uint8Array;
  privateInventoryFileBytes?: string | Uint8Array;
  semanticArtifactFileBytes?: string | Uint8Array;
  semanticHandlerFileBytes?: string | Uint8Array;
  authoritativeStateFileBytes?: string | Uint8Array;
  captureHistoryFileBytes?: string | Uint8Array;
  exactRevisionPngBytes?: Uint8Array;
  progressiveDraftStageFileBytes?: string | Uint8Array;
  progressiveDraftFinishFileBytes?: string | Uint8Array;
  authoritySignature?: unknown;
  authoritySignatureFileBytes?: string | Uint8Array;
  authorityPublicKeyFileBytes?: string | Uint8Array;
  predecessorReceiptFileBytes?: string | Uint8Array;
  predecessorAuthoritySignatureFileBytes?: string | Uint8Array;
  transportSpikeFileBytes?: string | Uint8Array;
  knownSecrets?: readonly string[];
}>;

const VERIFIED_KEYS = [
  "receiptFile", "inventoryFile", "evidenceFile", "captureScript", "privateInventoryFile",
  "semanticArtifactFile", "semanticHandlerFile", "authoritativeStateFile", "captureHistoryFile",
  "exactRevisionPng", "progressiveDraftStageFile", "progressiveDraftFinishFile",
  "authoritySignatureFile", "authorityPublicKeyFile", "predecessorReceiptFile",
  "predecessorAuthoritySignatureFile", "transportSpikeFile",
] as const;
type VerifiedBytes = Record<typeof VERIFIED_KEYS[number], string | null>;

export type BaselineV3Verification =
  | { ok: true; receipt: BaselineFreezeReceiptV3; inventory: BaselineWebMcpInventoryV3; evidence: BaselineProductionEvidenceV3; verifiedBytes: VerifiedBytes }
  | { ok: false; errors: string[]; verifiedBytes: VerifiedBytes };

export const EXPECTED_BASELINE_V3_IDENTITY = Object.freeze({
  schemaVersion: "baseline-freeze/v3",
  receiptPath: "research/data/baseline-freeze-v3.json",
  signaturePath: "research/data/baseline-freeze-v3-authority-signature.json",
  gitCommit: "4eb6d9862cd1e805906a338d524529b6b7019639",
  gitTree: "100447743f672f103d9cbe7c8c3d6d48e2bca4eb",
  deploymentId: "dpl_CePet5gs1u52rMvQUGye92qByJAQ",
  buildId: "bld_nuf9lecj0",
  immutableUrl: "https://jazzboard-bbjdgxi13-zwalls-projects.vercel.app",
  productionUrl: "https://www.jazzboard.xyz",
  createdAt: 1_788_295_092_399,
  landingToolCount: 5,
  participantToolCount: 54,
  spectatorToolCount: 18,
} as const);

function emptyVerifiedBytes(): VerifiedBytes {
  return Object.fromEntries(VERIFIED_KEYS.map((key) => [key, null])) as VerifiedBytes;
}

function parseJsonBytes(bytes: string | Uint8Array | undefined, label: string, errors: string[]) {
  if (bytes === undefined) return null;
  try {
    return JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    errors.push(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function comparable(value: unknown): string {
  return value === undefined ? "__undefined__" : canonicalJson(value as JsonValue);
}

function mismatch(errors: string[], label: string, actual: unknown, expected: unknown) {
  if (comparable(actual) !== comparable(expected)) errors.push(`${label} mismatch.`);
}

function verifyJsonBinding(
  errors: string[],
  bytes: string | Uint8Array | undefined,
  binding: { fileDigest: string; canonicalDigest: string },
  label: string,
) {
  if (bytes === undefined) return { digest: null, value: null };
  const digest = sha256Digest(bytes);
  mismatch(errors, `${label} byte digest`, digest, binding.fileDigest);
  const value = parseJsonBytes(bytes, label, errors);
  if (value !== null) mismatch(errors, `${label} canonical digest`, hashCanonicalJson(value as JsonValue), binding.canonicalDigest);
  return { digest, value };
}

function pngDimensions(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function verifyBaselineV3ExecutionReady(
  receiptInput: unknown,
  inventoryInput: unknown,
  evidenceInput: unknown,
  artifacts: BaselineV3ArtifactBytes,
): BaselineV3Verification {
  const receiptResult = baselineFreezeReceiptV3Schema.safeParse(receiptInput);
  const inventoryResult = baselineWebMcpInventoryV3Schema.safeParse(inventoryInput);
  const evidenceResult = baselineProductionEvidenceV3Schema.safeParse(evidenceInput);
  const errors = [
    ...(receiptResult.success ? [] : receiptResult.error.issues.map((issue) => `receipt/${issue.path.join("/")}: ${issue.message}`)),
    ...(inventoryResult.success ? [] : inventoryResult.error.issues.map((issue) => `inventory/${issue.path.join("/")}: ${issue.message}`)),
    ...(evidenceResult.success ? [] : evidenceResult.error.issues.map((issue) => `evidence/${issue.path.join("/")}: ${issue.message}`)),
  ];
  const verifiedBytes = emptyVerifiedBytes();
  if (!receiptResult.success || !inventoryResult.success || !evidenceResult.success) return { ok: false, errors, verifiedBytes };
  const receipt = receiptResult.data;
  const inventory = inventoryResult.data;
  const evidence = evidenceResult.data;

  const allowedBooleanFields = new Set([
    "/health/body/checks/sessionSecret:secret-key",
    "/health/body/checks/cronSecret:secret-key",
    "/privacy/roomIdentifiersPersisted:secret-key",
    "/privacy/roomCodesPersisted:secret-key",
    "/privacy/sessionCredentialsPersisted:secret-key",
  ]);
  for (const publicValue of [receipt, inventory, evidence]) {
    const leakage = findSecretLeakage(publicValue, artifacts.knownSecrets)
      .filter((finding) => !allowedBooleanFields.has(finding));
    if (leakage.length > 0) errors.push(`Public baseline-v3 secret leakage: ${leakage.join(", ")}`);
  }
  mismatch(errors, "freeze time", receipt.frozenAt, evidence.captureCompletedAt);
  mismatch(errors, "inventory capture time", inventory.capturedAt, evidence.capturedAt);
  mismatch(errors, "inventory deployment", inventory.deploymentId, receipt.deployment.deploymentId);
  mismatch(errors, "evidence deployment", evidence.deploymentId, receipt.deployment.deploymentId);
  mismatch(errors, "inventory origin", inventory.origin, receipt.deployment.productionUrl);
  mismatch(errors, "evidence origin", evidence.origin, receipt.deployment.productionUrl);
  mismatch(errors, "receipt self digest", computeBaselineFreezeReceiptV3Digest(receipt), receipt.receiptDigest);

  mismatch(errors, "health status", evidence.health.status, 200);
  mismatch(errors, "health route", evidence.health.matchedPath, "/api/health");
  mismatch(errors, "health body digest", hashCanonicalJson(evidence.health.body as unknown as JsonValue), evidence.health.canonicalBodyDigest);
  for (const [label, handler, matchedPath] of [
    ["human", evidence.artifactHandlers.human, "/api/rooms/[roomId]/artifacts"],
    ["agent", evidence.artifactHandlers.agent, "/api/rooms/[roomId]/agent/artifacts"],
  ] as const) {
    mismatch(errors, `${label} handler status`, handler.status, 401);
    mismatch(errors, `${label} handler route`, handler.matchedPath, matchedPath);
    mismatch(errors, `${label} handler body`, hashCanonicalJson(handler.body as unknown as JsonValue), handler.canonicalBodyDigest);
  }

  for (const [label, scope, expectedCount] of [
    ["landing", inventory.landing, 5],
    ["participant", inventory.participant, 54],
    ["spectator", inventory.spectator, 18],
  ] as const) {
    mismatch(errors, `${label} count`, scope.toolCount, expectedCount);
    mismatch(errors, `${label} length`, scope.tools.length, expectedCount);
    mismatch(errors, `${label} inventory digest`, scope.inventoryDigest, hashCanonicalJson(scope.tools as unknown as JsonValue));
    const names = scope.tools.map((tool) => tool.name);
    if (new Set(names).size !== names.length || names.some((name, index) => index > 0 && names[index - 1]! >= name)) {
      errors.push(`${label} inventory is not uniquely sorted.`);
    }
  }
  mismatch(errors, "spectator allowlist", inventory.spectator.tools.map((tool) => tool.name), BASELINE_V2_SPECTATOR_TOOL_NAMES);
  const participantDefinitions = new Map(inventory.participant.tools.map((tool) => [tool.name, tool.definitionDigest]));
  for (const tool of inventory.spectator.tools) mismatch(errors, `spectator definition ${tool.name}`, tool.definitionDigest, participantDefinitions.get(tool.name));

  verifiedBytes.receiptFile = artifacts.receiptFileBytes === undefined ? null : sha256Digest(artifacts.receiptFileBytes);
  if (artifacts.receiptFileBytes !== undefined) {
    mismatch(errors, "receipt file value", parseJsonBytes(artifacts.receiptFileBytes, "receipt", errors), receipt);
  }
  const publicInventory = verifyJsonBinding(errors, artifacts.inventoryFileBytes, receipt.capture.publicInventory, "public inventory");
  verifiedBytes.inventoryFile = publicInventory.digest;
  mismatch(errors, "public inventory value", publicInventory.value, inventory);
  const publicEvidence = verifyJsonBinding(errors, artifacts.evidenceFileBytes, receipt.capture.publicEvidence, "public evidence");
  verifiedBytes.evidenceFile = publicEvidence.digest;
  mismatch(errors, "public evidence value", publicEvidence.value, evidence);
  if (artifacts.captureScriptBytes !== undefined) {
    verifiedBytes.captureScript = sha256Digest(artifacts.captureScriptBytes);
    mismatch(errors, "capture script", verifiedBytes.captureScript, receipt.capture.scriptDigest);
  }

  const privateInventory = verifyJsonBinding(errors, artifacts.privateInventoryFileBytes, receipt.capture.privateInventory, "private inventory");
  verifiedBytes.privateInventoryFile = privateInventory.digest;
  if (privateInventory.value !== null) {
    const parsed = baselinePrivateWebMcpInventoryV3Schema.safeParse(privateInventory.value);
    if (!parsed.success) errors.push(...parsed.error.issues.map((issue) => `private inventory/${issue.path.join("/")}: ${issue.message}`));
    else for (const label of ["landing", "participant", "spectator"] as const) {
      const descriptors = parsed.data[label].descriptors;
      mismatch(errors, `${label} private contract`, hashCanonicalJson(descriptors as unknown as JsonValue), inventory[label].contractDigest);
      mismatch(errors, `${label} private projection`, descriptors.map((descriptor) => ({ name: descriptor.name, definitionDigest: hashCanonicalJson(descriptor as unknown as JsonValue) })), inventory[label].tools);
    }
  }

  for (const [key, bytes, binding] of [
    ["semanticArtifactFile", artifacts.semanticArtifactFileBytes, receipt.capture.semanticArtifact],
    ["semanticHandlerFile", artifacts.semanticHandlerFileBytes, receipt.capture.semanticHandler],
    ["authoritativeStateFile", artifacts.authoritativeStateFileBytes, receipt.capture.authoritativeState],
    ["captureHistoryFile", artifacts.captureHistoryFileBytes, receipt.capture.captureHistory],
    ["progressiveDraftStageFile", artifacts.progressiveDraftStageFileBytes, receipt.capture.progressiveDraftStage],
    ["progressiveDraftFinishFile", artifacts.progressiveDraftFinishFileBytes, receipt.capture.progressiveDraftFinish],
  ] as const) {
    verifiedBytes[key] = verifyJsonBinding(errors, bytes, binding, key).digest;
  }
  const stage = parseJsonBytes(artifacts.progressiveDraftStageFileBytes, "draft stage", errors);
  const finish = parseJsonBytes(artifacts.progressiveDraftFinishFileBytes, "draft finish", errors);
  if (stage !== null) {
    mismatch(errors, "stage evidence digest", hashCanonicalJson(stage as JsonValue), evidence.progressiveDraftFinish.stageCallResultDigest);
    const parsed = z.object({ ok: z.literal(true), tool: z.literal("apply_canvas_transaction"), data: z.object({ outcome: z.literal("drafted") }).passthrough() }).passthrough().safeParse(stage);
    if (!parsed.success) errors.push("Progressive draft stage raw result is not a successful drafted result.");
  }
  if (finish !== null) {
    mismatch(errors, "finish evidence digest", hashCanonicalJson(finish as JsonValue), evidence.progressiveDraftFinish.finishCallResultDigest);
    const parsed = z.object({ ok: z.literal(true), tool: z.literal("finish_canvas_draft"), data: z.object({ outcome: z.literal("applied") }).passthrough() }).passthrough().safeParse(finish);
    if (!parsed.success) errors.push("Progressive draft finish raw result is not a successful applied result.");
  }

  mismatch(errors, "semantic revision", evidence.semanticExport.expectedRoomRevision, evidence.pngExport.expectedRoomRevision);
  mismatch(errors, "semantic artifact digest", evidence.semanticExport.tool.artifactFileDigest, receipt.capture.semanticArtifact.fileDigest);
  mismatch(errors, "semantic handler digest", evidence.semanticExport.response.bodyDigest, receipt.capture.semanticHandler.fileDigest);
  mismatch(errors, "authoritative state digest", evidence.semanticExport.authoritativeState.fileDigest, receipt.capture.authoritativeState.fileDigest);
  mismatch(errors, "PNG digest", evidence.pngExport.download.sha256, receipt.capture.exactRevisionPng.fileDigest);
  if (artifacts.exactRevisionPngBytes !== undefined) {
    verifiedBytes.exactRevisionPng = sha256Digest(artifacts.exactRevisionPngBytes);
    mismatch(errors, "PNG bytes", verifiedBytes.exactRevisionPng, receipt.capture.exactRevisionPng.fileDigest);
    mismatch(errors, "PNG byte length", artifacts.exactRevisionPngBytes.byteLength, receipt.capture.exactRevisionPng.byteLength);
    mismatch(errors, "PNG dimensions", pngDimensions(artifacts.exactRevisionPngBytes), { width: receipt.capture.exactRevisionPng.width, height: receipt.capture.exactRevisionPng.height });
  }

  const predecessorReceiptBytes = artifacts.predecessorReceiptFileBytes;
  const predecessorSignatureBytes = artifacts.predecessorAuthoritySignatureFileBytes;
  if (predecessorReceiptBytes !== undefined) {
    verifiedBytes.predecessorReceiptFile = sha256Digest(predecessorReceiptBytes);
    mismatch(errors, "predecessor receipt bytes", verifiedBytes.predecessorReceiptFile, receipt.supersedes.receiptFileDigest);
    mismatch(errors, "predecessor receipt value", parseJsonBytes(predecessorReceiptBytes, "predecessor receipt", errors), predecessorReceiptJson);
  }
  if (predecessorSignatureBytes !== undefined) {
    verifiedBytes.predecessorAuthoritySignatureFile = sha256Digest(predecessorSignatureBytes);
    mismatch(errors, "predecessor signature bytes", verifiedBytes.predecessorAuthoritySignatureFile, receipt.supersedes.authoritySignatureFileDigest);
    mismatch(errors, "predecessor signature value", parseJsonBytes(predecessorSignatureBytes, "predecessor signature", errors), predecessorSignatureJson);
  }
  try {
    const predecessorReceipt = baselineFreezeReceiptV2Schema.parse(predecessorReceiptJson);
    const predecessorSignature = baselineFreezeV2AuthoritySignatureSchema.parse(predecessorSignatureJson);
    verifyBaselineFreezeV2AuthoritySignature({ receipt: predecessorReceipt as unknown as JsonValue, signature: predecessorSignature, notBefore: predecessorReceipt.frozenAt });
    mismatch(errors, "predecessor receipt digest", predecessorReceipt.receiptDigest, receipt.supersedes.receiptDigest);
    mismatch(errors, "predecessor signature digest", hashCanonicalJson(predecessorSignature as unknown as JsonValue), receipt.supersedes.authoritySignatureDigest);
  } catch (error) {
    errors.push(`Predecessor authority chain failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (artifacts.transportSpikeFileBytes !== undefined) {
    verifiedBytes.transportSpikeFile = sha256Digest(artifacts.transportSpikeFileBytes);
    mismatch(errors, "transport spike bytes", verifiedBytes.transportSpikeFile, receipt.adaptationDisclosure.transportSpikeDigest);
  }
  if (artifacts.authorityPublicKeyFileBytes !== undefined) {
    verifiedBytes.authorityPublicKeyFile = sha256Digest(artifacts.authorityPublicKeyFileBytes);
    mismatch(errors, "authority public key", verifiedBytes.authorityPublicKeyFile, receipt.authority.publicKeyDigest);
  }
  if (artifacts.authoritySignature !== undefined) {
    try {
      verifyBaselineFreezeV3AuthoritySignature({ receipt: receipt as unknown as JsonValue, signature: baselineFreezeV3AuthoritySignatureSchema.parse(artifacts.authoritySignature), notBefore: receipt.frozenAt });
    } catch (error) {
      errors.push(`Baseline-v3 authority signature failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (artifacts.authoritySignatureFileBytes !== undefined) {
    verifiedBytes.authoritySignatureFile = sha256Digest(artifacts.authoritySignatureFileBytes);
    mismatch(errors, "authority signature file value", parseJsonBytes(artifacts.authoritySignatureFileBytes, "authority signature", errors), artifacts.authoritySignature);
  }

  const missing = VERIFIED_KEYS.filter((key) => verifiedBytes[key] === null);
  if (artifacts.authoritySignature === undefined) errors.push("Execution readiness requires the baseline-v3 authority signature.");
  if (missing.length > 0) errors.push(`Execution readiness requires exact bytes for: ${missing.join(", ")}.`);
  return errors.length === 0
    ? { ok: true, receipt, inventory, evidence, verifiedBytes }
    : { ok: false, errors, verifiedBytes };
}

export { baselineFreezeV3AuthoritySignatureSchema } from "./baseline-freeze-v3-authority";
