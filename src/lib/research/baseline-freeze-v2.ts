import { z } from "zod";

import { baselineHealthBodySchema } from "./baseline-freeze";
import {
  BASELINE_FREEZE_V2_AUTHORITY_KEY_ID,
  BASELINE_FREEZE_V2_AUTHORITY_KEY_PURPOSE,
  BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_DIGEST,
  BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_PATH,
  BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_VERSION,
  baselineFreezeV2AuthoritySignatureSchema,
  verifyBaselineFreezeV2AuthoritySignature,
} from "./baseline-freeze-v2-authority";
import {
  canonicalJson,
  hashCanonicalJson,
  sha256Digest,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";
import { findSecretLeakage } from "./provenance-redaction";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const deploymentIdSchema = z.string().regex(/^dpl_[A-Za-z0-9]+$/);
const httpsOriginSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
    context.addIssue({ code: "custom", message: "Expected a credential-free HTTPS origin." });
  }
});

const toolEntrySchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  definitionDigest: digestSchema,
}).strict();

const toolDescriptorSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  title: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.record(z.string(), z.unknown()),
}).strict();

const inventoryScopeSchema = z.object({
  toolCount: z.number().int().nonnegative(),
  inventoryDigest: digestSchema,
  contractDigest: digestSchema,
  tools: z.array(toolEntrySchema),
}).strict();

const privateInventoryScopeSchema = inventoryScopeSchema.extend({
  descriptors: z.array(toolDescriptorSchema),
}).strict();

const inventoryEnvelopeShape = {
  schemaVersion: z.literal(2),
  capturedAt: z.string().datetime({ offset: true }),
  deploymentId: deploymentIdSchema,
  origin: httpsOriginSchema,
  captureMethod: z.literal("browser-exposed-webmcp-registry"),
};

export const baselineWebMcpInventoryV2Schema = z.object({
  ...inventoryEnvelopeShape,
  landing: inventoryScopeSchema,
  participant: inventoryScopeSchema,
  spectator: inventoryScopeSchema,
}).strict();

export const baselinePrivateWebMcpInventoryV2Schema = z.object({
  ...inventoryEnvelopeShape,
  landing: privateInventoryScopeSchema,
  participant: privateInventoryScopeSchema,
  spectator: privateInventoryScopeSchema,
}).strict();

const falseAuthorizationBodySchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.literal("AUTH_REQUIRED"),
    message: z.literal("A guest session is required."),
  }).strict(),
}).strict();

const responseFingerprintSchema = <T extends z.ZodType>(body: T) => z.object({
  status: z.number().int().min(100).max(599),
  contentType: z.string().min(1),
  mediaType: z.string().min(1),
  cacheControl: z.string().min(1).nullable(),
  matchedPath: z.string().min(1).nullable(),
  byteLength: z.number().int().positive(),
  bodyDigest: digestSchema,
  canonicalBodyDigest: digestSchema.nullable(),
  body,
}).strict();

const retainedJsonSchema = z.object({
  filename: z.string().regex(/^[a-z0-9][a-z0-9.-]*\.json$/),
  byteLength: z.number().int().positive(),
  fileDigest: digestSchema,
  canonicalDigest: digestSchema,
}).strict();

const semanticExportEvidenceSchema = z.object({
  expectedRoomRevision: z.number().int().positive(),
  authoritativeState: retainedJsonSchema,
  response: z.object({
    status: z.literal(200),
    contentType: z.string().min(1),
    mediaType: z.literal("application/json"),
    cacheControl: z.literal("no-store"),
    filename: z.literal("baseline-semantic-handler-redacted-v2.json"),
    byteLength: z.number().int().positive(),
    bodyDigest: digestSchema,
    canonicalBodyDigest: digestSchema,
  }).strict(),
  tool: z.object({
    name: z.literal("export_canvas_artifact"),
    format: z.literal("semantic_json"),
    declaredMediaType: z.string().min(1),
    sourceRoomRevision: z.number().int().positive(),
    artifactSourceRoomRevision: z.number().int().positive(),
    artifactFilename: z.literal("baseline-semantic-artifact-redacted-v2.json"),
    artifactByteLength: z.number().int().positive(),
    artifactFileDigest: digestSchema,
    artifactDigest: digestSchema,
    objectCount: z.number().int().positive(),
    diagramCount: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const pngExportEvidenceSchema = z.object({
  expectedRoomRevision: z.number().int().positive(),
  expectedObjectRevision: z.number().int().positive(),
  targetCount: z.literal(1),
  tool: z.object({
    name: z.literal("export_canvas_png"),
    filename: z.string().regex(/\.png$/i),
    declaredMimeType: z.literal("image/png"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    declaredByteLength: z.number().int().positive(),
    sourceRoomRevision: z.number().int().positive(),
    sourceObjectRevisions: z.tuple([z.number().int().positive()]),
    visualContributorCount: z.literal(1),
    persistedByJazzboard: z.literal(false),
  }).strict(),
  download: z.object({
    filename: z.string().regex(/\.png$/i),
    observedMimeType: z.literal("image/png"),
    byteLength: z.number().int().positive(),
    sha256: digestSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    pngStructureValidated: z.literal(true),
  }).strict(),
}).strict();

export const baselineProductionEvidenceV2Schema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("production-browser-webmcp-baseline-evidence"),
  capturedAt: z.string().datetime({ offset: true }),
  captureCompletedAt: z.string().datetime({ offset: true }),
  deploymentId: deploymentIdSchema,
  origin: httpsOriginSchema,
  runtime: z.object({
    node: z.string().regex(/^v\d+\.\d+\.\d+$/),
    browser: z.object({
      engine: z.literal("chromium"),
      version: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/),
    }).strict(),
    viewport: z.object({ width: z.literal(1_280), height: z.literal(720), deviceScaleFactor: z.literal(1) }).strict(),
    transport: z.literal("browser-webmcp"),
    codexNativeOnly: z.literal(true),
  }).strict(),
  captureHistory: z.object({
    currentRunSequence: z.literal(5),
    priorStoppedRunCount: z.literal(3),
    priorCompletedSupersededCount: z.literal(1),
    privateCaptureHistoryByteDigest: digestSchema,
    privateCaptureHistoryCanonicalDigest: digestSchema,
    supersededRunInventoryDigest: digestSchema,
    supersededRunEvidenceDigest: digestSchema,
    supersededRunPngDigest: digestSchema,
  }).strict(),
  health: responseFingerprintSchema(baselineHealthBodySchema),
  artifactHandlers: z.object({
    human: responseFingerprintSchema(falseAuthorizationBodySchema),
    agent: responseFingerprintSchema(falseAuthorizationBodySchema),
  }).strict(),
  semanticExport: semanticExportEvidenceSchema,
  pngExport: pngExportEvidenceSchema,
  roleIsolation: z.object({
    participantCanMutate: z.literal(true),
    spectatorCanMutate: z.literal(false),
    spectatorObservedRoomRevision: z.number().int().positive(),
    artifactRoomRevision: z.number().int().positive(),
  }).strict(),
  privacy: z.object({
    roomIdentifiersPersisted: z.literal(false),
    roomCodesPersisted: z.literal(false),
    participantIdentifiersPersisted: z.literal(false),
    sessionCredentialsPersisted: z.literal(false),
    imageBytesIncludedInPublicReceipt: z.literal(false),
    privatePngBytesRetained: z.literal(true),
    privateFullDescriptorsRetained: z.literal(true),
    privateRedactedSemanticBytesRetained: z.literal(true),
  }).strict(),
}).strict();

const fileBindingSchema = z.object({
  filename: z.string().min(1),
  fileDigest: digestSchema,
  canonicalDigest: digestSchema,
}).strict();

const baselineFreezeV2ContentSchema = z.object({
  schemaVersion: z.literal("baseline-freeze/v2"),
  receiptId: z.literal("EXP-0001A-production-baseline-v2"),
  frozenAt: z.string().datetime({ offset: true }),
  supersedes: z.object({
    receiptPath: z.literal("research/data/baseline-freeze-v1.json"),
    receiptFileDigest: z.literal("sha256:399c72b595b8d06bc11a03f0d44fb99938e5e5de8dcb8f3e708700b01579d165"),
    receiptDigest: z.literal("sha256:32fddd038f6ec696f633bc5ee28ec587540282dbbd1e451e5d2debeb67069b23"),
  }).strict(),
  product: z.object({
    gitCommit: z.literal("66a546aaef9e006891a4cf619ed310fd9fc1c4cc"),
    gitTree: z.literal("071a751beadbcefc002f42d1be75a0e717bc3e4b"),
    nodeVersion: z.literal("24.x"),
    humanArtifactRouteDigest: z.literal("sha256:6a3476b2e5e822216d2f299dc9f98699184c68afa146d1bc5f8ffaf8802f9907"),
    agentArtifactRouteDigest: z.literal("sha256:0fcd0460d9fe2ba293546a4f8db8b4b2fb1bcea1d5a83ebdc191341e26c18387"),
    vercelIgnoreDigest: z.literal("sha256:74b4bbad890403917074ccc02d90c21036586876d06928c8cbd385f1ebb23c6b"),
  }).strict(),
  deployment: z.object({
    deploymentId: z.literal("dpl_46pyqWtLXGfzeU1JsqXEWQjTBfd8"),
    buildId: z.literal("bld_3t0eopcj7"),
    immutableUrl: z.literal("https://jazzboard-7d7k0x6pl-zwalls-projects.vercel.app"),
    productionUrl: z.literal("https://www.jazzboard.xyz"),
    state: z.literal("READY"),
    createdAt: z.literal(1_788_201_331_765),
    buildIdentityDigest: z.literal("sha256:a2c456842e46021ef65f299f6c816d5c0f60e545619ea4a5e62112e0f342c96a"),
  }).strict(),
  capture: z.object({
    scriptPath: z.literal("research/scripts/capture-baseline-v2.mjs"),
    scriptDigest: digestSchema,
    publicInventory: fileBindingSchema.extend({
      path: z.literal("research/data/baseline-webmcp-inventory-v2.json"),
    }).omit({ filename: true }).strict(),
    publicEvidence: fileBindingSchema.extend({
      path: z.literal("research/data/baseline-production-evidence-v2.json"),
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
    transport: z.literal("browser-webmcp"),
    codexNativeOnly: z.literal(true),
  }).strict(),
  authority: z.object({
    signaturePath: z.literal("research/data/baseline-freeze-v2-authority-signature.json"),
    signatureSchema: z.literal(BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_VERSION),
    keyPurpose: z.literal(BASELINE_FREEZE_V2_AUTHORITY_KEY_PURPOSE),
    keyId: z.literal(BASELINE_FREEZE_V2_AUTHORITY_KEY_ID),
    publicKeyPath: z.literal(BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_PATH),
    publicKeyDigest: z.literal(BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_DIGEST),
  }).strict(),
  sensitiveMaterialRedacted: z.literal(true),
}).strict();

export const baselineFreezeReceiptV2Schema = baselineFreezeV2ContentSchema.extend({
  receiptDigest: digestSchema,
}).strict();

export type BaselineWebMcpInventoryV2 = z.infer<typeof baselineWebMcpInventoryV2Schema>;
export type BaselinePrivateWebMcpInventoryV2 = z.infer<typeof baselinePrivateWebMcpInventoryV2Schema>;
export type BaselineProductionEvidenceV2 = z.infer<typeof baselineProductionEvidenceV2Schema>;
export type BaselineFreezeReceiptV2 = z.infer<typeof baselineFreezeReceiptV2Schema>;

export type BaselineV2ArtifactBytes = {
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
  authoritySignature?: unknown;
  authoritySignatureFileBytes?: string | Uint8Array;
  authorityPublicKeyFileBytes?: string | Uint8Array;
  knownSecrets?: readonly string[];
};

type VerifiedBytes = Record<
  "receiptFile" | "inventoryFile" | "evidenceFile" | "captureScript"
  | "privateInventoryFile" | "semanticArtifactFile" | "semanticHandlerFile"
  | "authoritativeStateFile" | "captureHistoryFile" | "exactRevisionPng"
  | "authoritySignatureFile" | "authorityPublicKeyFile",
  string | null
>;

export type BaselineV2Verification =
  | {
      ok: true;
      receipt: BaselineFreezeReceiptV2;
      inventory: BaselineWebMcpInventoryV2;
      evidence: BaselineProductionEvidenceV2;
      verifiedBytes: VerifiedBytes;
    }
  | { ok: false; errors: string[]; verifiedBytes: VerifiedBytes };

export const BASELINE_V2_SPECTATOR_TOOL_NAMES = Object.freeze([
  "analyze_diagram_layout", "describe_diagram", "export_canvas_artifact", "export_canvas_png",
  "find_diagrams", "get_canvas_capabilities", "inspect_canvas_scope", "list_activity",
  "list_agent_edit_proposals", "query_objects", "read_activity", "read_agent_edit_proposal",
  "read_canvas_drafts", "read_collaboration_state", "read_diagram", "read_neighborhood",
  "read_room_state", "read_selection",
] as const);

export const EXPECTED_BASELINE_V2_IDENTITY = Object.freeze({
  schemaVersion: "baseline-freeze/v2",
  receiptPath: "research/data/baseline-freeze-v2.json",
  signaturePath: "research/data/baseline-freeze-v2-authority-signature.json",
  v1ReceiptPath: "research/data/baseline-freeze-v1.json",
  v1ReceiptFileDigest: "sha256:399c72b595b8d06bc11a03f0d44fb99938e5e5de8dcb8f3e708700b01579d165",
  v1ReceiptDigest: "sha256:32fddd038f6ec696f633bc5ee28ec587540282dbbd1e451e5d2debeb67069b23",
  gitCommit: "66a546aaef9e006891a4cf619ed310fd9fc1c4cc",
  gitTree: "071a751beadbcefc002f42d1be75a0e717bc3e4b",
  deploymentId: "dpl_46pyqWtLXGfzeU1JsqXEWQjTBfd8",
  buildId: "bld_3t0eopcj7",
  immutableUrl: "https://jazzboard-7d7k0x6pl-zwalls-projects.vercel.app",
  productionUrl: "https://www.jazzboard.xyz",
  createdAt: 1_788_201_331_765,
  landingToolCount: 5,
  participantToolCount: 54,
  spectatorToolCount: 18,
} as const);

function contentOf(receipt: BaselineFreezeReceiptV2) {
  return baselineFreezeV2ContentSchema.parse(Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== "receiptDigest"),
  ));
}

export function computeBaselineFreezeReceiptV2Digest(receipt: BaselineFreezeReceiptV2): string {
  return hashCanonicalJson(contentOf(receipt));
}

function mismatch(errors: string[], label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) errors.push(`${label} does not match baseline-freeze/v2.`);
}

function formatIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => `${prefix}${issue.path.length ? `/${issue.path.join("/")}` : ""}: ${issue.message}`);
}

function utf8Json(bytes: string | Uint8Array, label: string, errors: string[]): unknown | null {
  try {
    const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (error) {
    errors.push(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const buffer = Buffer.from(bytes);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.byteLength < 45 || !buffer.subarray(0, 8).equals(signature)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawData = false;
  let sawEnd = false;
  let ordinal = 0;
  while (offset + 12 <= buffer.byteLength) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const next = offset + 12 + length;
    if (next > buffer.byteLength) return null;
    if (ordinal === 0) {
      if (type !== "IHDR" || length !== 13) return null;
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
    }
    if (type === "IDAT") sawData = true;
    if (type === "IEND") {
      if (length !== 0 || next !== buffer.byteLength) return null;
      sawEnd = true;
    }
    ordinal += 1;
    offset = next;
  }
  return width > 0 && height > 0 && sawData && sawEnd ? { width, height } : null;
}

function verifyPublicScope(errors: string[], label: string, scope: z.infer<typeof inventoryScopeSchema>, count: number): void {
  mismatch(errors, `${label} tool count`, scope.toolCount, count);
  mismatch(errors, `${label} tool length`, scope.tools.length, scope.toolCount);
  mismatch(errors, `${label} inventory digest`, hashCanonicalJson(scope.tools), scope.inventoryDigest);
  const names = scope.tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length || names.some((name, index) => index > 0 && names[index - 1]! >= name)) {
    errors.push(`${label} inventory is not uniquely code-unit sorted.`);
  }
}

function verifyPrivateScope(
  errors: string[],
  label: "landing" | "participant" | "spectator",
  privateScope: z.infer<typeof privateInventoryScopeSchema>,
  publicScope: z.infer<typeof inventoryScopeSchema>,
): void {
  mismatch(errors, `${label} private contract digest`, hashCanonicalJson(privateScope.descriptors), publicScope.contractDigest);
  const entries = privateScope.descriptors.map((descriptor) => ({
    name: descriptor.name,
    definitionDigest: hashCanonicalJson(descriptor),
  }));
  mismatch(errors, `${label} private definition projection`, canonicalJson(entries), canonicalJson(publicScope.tools));
  mismatch(errors, `${label} private compact projection`, canonicalJson({
    toolCount: privateScope.toolCount,
    inventoryDigest: privateScope.inventoryDigest,
    contractDigest: privateScope.contractDigest,
    tools: privateScope.tools,
  }), canonicalJson(publicScope));
}

function verifyJsonBytes(
  errors: string[],
  bytes: string | Uint8Array | undefined,
  value: unknown,
  binding: { fileDigest: string; canonicalDigest: string },
  label: string,
): string | null {
  if (bytes === undefined) return null;
  const digest = sha256Digest(bytes);
  mismatch(errors, `${label} byte digest`, digest, binding.fileDigest);
  const parsed = utf8Json(bytes, label, errors);
  if (parsed !== null) {
    mismatch(errors, `${label} canonical digest`, hashCanonicalJson(parsed), binding.canonicalDigest);
    mismatch(errors, `${label} supplied value`, canonicalJson(parsed), canonicalJson(value));
  }
  return digest;
}

function emptyVerifiedBytes(): VerifiedBytes {
  return {
    receiptFile: null, inventoryFile: null, evidenceFile: null, captureScript: null,
    privateInventoryFile: null, semanticArtifactFile: null, semanticHandlerFile: null,
    authoritativeStateFile: null, captureHistoryFile: null, exactRevisionPng: null,
    authoritySignatureFile: null, authorityPublicKeyFile: null,
  };
}

function findPublicBaselineLeakage(value: unknown, knownSecrets: readonly string[] = []): string[] {
  const allowedBooleanFields = new Set([
    "/health/body/checks/sessionSecret:secret-key",
    "/health/body/checks/cronSecret:secret-key",
    "/privacy/roomIdentifiersPersisted:secret-key",
    "/privacy/roomCodesPersisted:secret-key",
    "/privacy/sessionCredentialsPersisted:secret-key",
  ]);
  return findSecretLeakage(value, knownSecrets).filter((finding) => !allowedBooleanFields.has(finding));
}

export function verifyBaselineV2(
  receiptInput: unknown,
  inventoryInput: unknown,
  evidenceInput: unknown,
  artifacts: BaselineV2ArtifactBytes = {},
): BaselineV2Verification {
  const receiptResult = baselineFreezeReceiptV2Schema.safeParse(receiptInput);
  const inventoryResult = baselineWebMcpInventoryV2Schema.safeParse(inventoryInput);
  const evidenceResult = baselineProductionEvidenceV2Schema.safeParse(evidenceInput);
  const errors = [
    ...(receiptResult.success ? [] : formatIssues("receipt", receiptResult.error)),
    ...(inventoryResult.success ? [] : formatIssues("inventory", inventoryResult.error)),
    ...(evidenceResult.success ? [] : formatIssues("evidence", evidenceResult.error)),
  ];
  const verifiedBytes = emptyVerifiedBytes();
  const publicLeakage = [receiptInput, inventoryInput, evidenceInput]
    .flatMap((value) => findPublicBaselineLeakage(value, artifacts.knownSecrets));
  if (publicLeakage.length > 0) errors.push(`Public baseline contains sensitive material: ${publicLeakage.join(", ")}`);
  if (!receiptResult.success || !inventoryResult.success || !evidenceResult.success) {
    return { ok: false, errors, verifiedBytes };
  }

  const receipt = receiptResult.data;
  const inventory = inventoryResult.data;
  const evidence = evidenceResult.data;
  mismatch(errors, "receipt self digest", computeBaselineFreezeReceiptV2Digest(receipt), receipt.receiptDigest);
  mismatch(errors, "freeze time", receipt.frozenAt, evidence.captureCompletedAt);
  mismatch(errors, "inventory canonical digest", hashCanonicalJson(inventory), receipt.capture.publicInventory.canonicalDigest);
  mismatch(errors, "evidence canonical digest", hashCanonicalJson(evidence), receipt.capture.publicEvidence.canonicalDigest);
  mismatch(errors, "capture timestamp", inventory.capturedAt, evidence.capturedAt);
  mismatch(errors, "inventory deployment", inventory.deploymentId, receipt.deployment.deploymentId);
  mismatch(errors, "evidence deployment", evidence.deploymentId, receipt.deployment.deploymentId);
  mismatch(errors, "inventory origin", inventory.origin, receipt.deployment.productionUrl);
  mismatch(errors, "evidence origin", evidence.origin, receipt.deployment.productionUrl);

  verifyPublicScope(errors, "landing", inventory.landing, 5);
  verifyPublicScope(errors, "participant", inventory.participant, 54);
  verifyPublicScope(errors, "spectator", inventory.spectator, 18);
  mismatch(errors, "spectator exact allowlist", canonicalJson(inventory.spectator.tools.map((tool) => tool.name)), canonicalJson(BASELINE_V2_SPECTATOR_TOOL_NAMES));
  const participant = new Map(inventory.participant.tools.map((tool) => [tool.name, tool.definitionDigest]));
  for (const tool of inventory.spectator.tools) {
    mismatch(errors, `spectator definition ${tool.name}`, tool.definitionDigest, participant.get(tool.name));
  }

  mismatch(errors, "health status", evidence.health.status, 200);
  mismatch(errors, "health route", evidence.health.matchedPath, "/api/health");
  mismatch(errors, "health body digest", hashCanonicalJson(evidence.health.body), evidence.health.canonicalBodyDigest);
  for (const [label, handler, matchedPath] of [
    ["human", evidence.artifactHandlers.human, "/api/rooms/[roomId]/artifacts"],
    ["agent", evidence.artifactHandlers.agent, "/api/rooms/[roomId]/agent/artifacts"],
  ] as const) {
    mismatch(errors, `${label} handler status`, handler.status, 401);
    mismatch(errors, `${label} handler route`, handler.matchedPath, matchedPath);
    mismatch(errors, `${label} handler body`, hashCanonicalJson(handler.body), handler.canonicalBodyDigest);
  }

  const semantic = evidence.semanticExport;
  mismatch(errors, "semantic tool revision", semantic.tool.sourceRoomRevision, semantic.expectedRoomRevision);
  mismatch(errors, "semantic artifact revision", semantic.tool.artifactSourceRoomRevision, semantic.expectedRoomRevision);
  mismatch(errors, "semantic artifact binding", semantic.tool.artifactFileDigest, receipt.capture.semanticArtifact.fileDigest);
  mismatch(errors, "semantic artifact canonical binding", semantic.tool.artifactDigest, receipt.capture.semanticArtifact.canonicalDigest);
  mismatch(errors, "semantic handler binding", semantic.response.bodyDigest, receipt.capture.semanticHandler.fileDigest);
  mismatch(errors, "semantic handler canonical binding", semantic.response.canonicalBodyDigest, receipt.capture.semanticHandler.canonicalDigest);
  mismatch(errors, "state binding", semantic.authoritativeState.fileDigest, receipt.capture.authoritativeState.fileDigest);
  mismatch(errors, "state canonical binding", semantic.authoritativeState.canonicalDigest, receipt.capture.authoritativeState.canonicalDigest);
  mismatch(errors, "role artifact revision", evidence.roleIsolation.artifactRoomRevision, semantic.expectedRoomRevision);
  if (evidence.roleIsolation.spectatorObservedRoomRevision < semantic.expectedRoomRevision) {
    errors.push("Spectator observation is older than the exact-revision artifacts.");
  }

  const png = evidence.pngExport;
  mismatch(errors, "PNG room revision", png.tool.sourceRoomRevision, png.expectedRoomRevision);
  mismatch(errors, "PNG semantic revision", png.expectedRoomRevision, semantic.expectedRoomRevision);
  mismatch(errors, "PNG object revision", png.tool.sourceObjectRevisions[0], png.expectedObjectRevision);
  mismatch(errors, "PNG digest", png.download.sha256, receipt.capture.exactRevisionPng.fileDigest);
  mismatch(errors, "PNG width", png.download.width, receipt.capture.exactRevisionPng.width);
  mismatch(errors, "PNG height", png.download.height, receipt.capture.exactRevisionPng.height);
  mismatch(errors, "PNG byte length", png.download.byteLength, receipt.capture.exactRevisionPng.byteLength);
  mismatch(errors, "PNG declared dimensions", `${png.tool.width}x${png.tool.height}`, `${png.download.width}x${png.download.height}`);
  mismatch(errors, "PNG declared bytes", png.tool.declaredByteLength, png.download.byteLength);

  verifiedBytes.receiptFile = verifyJsonBytes(errors, artifacts.receiptFileBytes, receipt, {
    fileDigest: artifacts.receiptFileBytes === undefined ? receipt.receiptDigest : sha256Digest(artifacts.receiptFileBytes),
    canonicalDigest: hashCanonicalJson(receipt),
  }, "receipt file");
  verifiedBytes.inventoryFile = verifyJsonBytes(errors, artifacts.inventoryFileBytes, inventory, receipt.capture.publicInventory, "public inventory");
  verifiedBytes.evidenceFile = verifyJsonBytes(errors, artifacts.evidenceFileBytes, evidence, receipt.capture.publicEvidence, "public evidence");
  if (artifacts.captureScriptBytes !== undefined) {
    verifiedBytes.captureScript = sha256Digest(artifacts.captureScriptBytes);
    mismatch(errors, "capture script bytes", verifiedBytes.captureScript, receipt.capture.scriptDigest);
  }

  let privateInventory: BaselinePrivateWebMcpInventoryV2 | null = null;
  if (artifacts.privateInventoryFileBytes !== undefined) {
    const raw = utf8Json(artifacts.privateInventoryFileBytes, "private inventory", errors);
    const parsed = baselinePrivateWebMcpInventoryV2Schema.safeParse(raw);
    if (!parsed.success) errors.push(...formatIssues("private inventory", parsed.error));
    else {
      privateInventory = parsed.data;
      verifyPrivateScope(errors, "landing", privateInventory.landing, inventory.landing);
      verifyPrivateScope(errors, "participant", privateInventory.participant, inventory.participant);
      verifyPrivateScope(errors, "spectator", privateInventory.spectator, inventory.spectator);
      verifiedBytes.privateInventoryFile = verifyJsonBytes(
        errors, artifacts.privateInventoryFileBytes, privateInventory, receipt.capture.privateInventory, "private inventory",
      );
    }
  }

  const verifyRetained = (
    key: "semanticArtifactFile" | "semanticHandlerFile" | "authoritativeStateFile" | "captureHistoryFile",
    bytes: string | Uint8Array | undefined,
    binding: { fileDigest: string; canonicalDigest: string },
  ) => {
    if (bytes === undefined) return null;
    const value = utf8Json(bytes, key, errors);
    if (value === null) return null;
    verifiedBytes[key] = verifyJsonBytes(errors, bytes, value, binding, key);
    const leakage = findSecretLeakage(value, artifacts.knownSecrets)
      .filter((finding) => !finding.endsWith(":secret-key"));
    if (leakage.length > 0) errors.push(`${key} contains sensitive material: ${leakage.join(", ")}`);
    return value;
  };
  const semanticArtifact = verifyRetained("semanticArtifactFile", artifacts.semanticArtifactFileBytes, receipt.capture.semanticArtifact);
  const semanticHandler = verifyRetained("semanticHandlerFile", artifacts.semanticHandlerFileBytes, receipt.capture.semanticHandler);
  const authoritativeState = verifyRetained("authoritativeStateFile", artifacts.authoritativeStateFileBytes, receipt.capture.authoritativeState);
  verifyRetained("captureHistoryFile", artifacts.captureHistoryFileBytes, receipt.capture.captureHistory);
  if (semanticArtifact && typeof semanticArtifact === "object") {
    mismatch(errors, "retained semantic source revision", (semanticArtifact as { source?: { roomRevision?: unknown } }).source?.roomRevision, semantic.expectedRoomRevision);
  }
  if (semanticHandler && typeof semanticHandler === "object") {
    const content = (semanticHandler as { export?: { content?: unknown } }).export?.content;
    try {
      mismatch(errors, "handler retained artifact", canonicalJson(JSON.parse(String(content))), canonicalJson(semanticArtifact));
    } catch { errors.push("Retained semantic handler content is not JSON."); }
  }
  if (authoritativeState && typeof authoritativeState === "object") {
    mismatch(errors, "retained state revision", (authoritativeState as { room?: { roomRevision?: unknown } }).room?.roomRevision, semantic.expectedRoomRevision);
  }

  if (artifacts.exactRevisionPngBytes !== undefined) {
    verifiedBytes.exactRevisionPng = sha256Digest(artifacts.exactRevisionPngBytes);
    mismatch(errors, "exact PNG bytes", verifiedBytes.exactRevisionPng, receipt.capture.exactRevisionPng.fileDigest);
    mismatch(errors, "exact PNG byte length", artifacts.exactRevisionPngBytes.byteLength, receipt.capture.exactRevisionPng.byteLength);
    const dimensions = pngDimensions(artifacts.exactRevisionPngBytes);
    mismatch(errors, "exact PNG width", dimensions?.width, receipt.capture.exactRevisionPng.width);
    mismatch(errors, "exact PNG height", dimensions?.height, receipt.capture.exactRevisionPng.height);
  }

  if (artifacts.authorityPublicKeyFileBytes !== undefined) {
    verifiedBytes.authorityPublicKeyFile = sha256Digest(artifacts.authorityPublicKeyFileBytes);
    mismatch(errors, "authority public key bytes", verifiedBytes.authorityPublicKeyFile, receipt.authority.publicKeyDigest);
  }
  if (artifacts.authoritySignature !== undefined) {
    try {
      verifyBaselineFreezeV2AuthoritySignature({
        receipt: receipt as unknown as JsonValue,
        signature: artifacts.authoritySignature,
        notBefore: receipt.frozenAt,
      });
    } catch (error) {
      errors.push(`Authority signature failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (artifacts.authoritySignatureFileBytes !== undefined) {
    verifiedBytes.authoritySignatureFile = sha256Digest(artifacts.authoritySignatureFileBytes);
    const value = utf8Json(artifacts.authoritySignatureFileBytes, "authority signature file", errors);
    if (value !== null) {
      mismatch(errors, "authority signature file value", canonicalJson(value), canonicalJson(artifacts.authoritySignature));
      const parsed = baselineFreezeV2AuthoritySignatureSchema.safeParse(value);
      if (!parsed.success) errors.push(...formatIssues("authority signature", parsed.error));
    }
  }

  return errors.length === 0
    ? { ok: true, receipt, inventory, evidence, verifiedBytes }
    : { ok: false, errors, verifiedBytes };
}

export function verifyBaselineV2ExecutionReady(
  receiptInput: unknown,
  inventoryInput: unknown,
  evidenceInput: unknown,
  artifacts: BaselineV2ArtifactBytes,
): BaselineV2Verification {
  const verification = verifyBaselineV2(receiptInput, inventoryInput, evidenceInput, artifacts);
  if (!verification.ok) return verification;
  if (artifacts.authoritySignature === undefined) {
    return { ok: false, errors: ["Execution readiness requires the baseline authority signature."], verifiedBytes: verification.verifiedBytes };
  }
  const missing = Object.entries(verification.verifiedBytes)
    .filter(([, digest]) => digest === null)
    .map(([name]) => name);
  return missing.length === 0 ? verification : {
    ok: false,
    errors: [`Execution readiness requires exact bytes for: ${missing.join(", ")}.`],
    verifiedBytes: verification.verifiedBytes,
  };
}
