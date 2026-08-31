import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as signEd25519,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  assertCodexWebMcpAaExecutionAllowed,
  authorizeCodexWebMcpAaGate,
  codexWebMcpAaGateDraftSchema,
  codexWebMcpAaGateSchema,
  codexWebMcpSpikeEvidenceSchema,
  codexWebMcpSpikeEvidenceContentSchema,
  createCodexWebMcpAaGate,
  createPublicCodexWebMcpAaGate,
  createPublicCodexWebMcpSpikeEvidence,
  publicCodexWebMcpAaGateSchema,
  sealCodexWebMcpSpikeEvidence,
  verifyCodexWebMcpAaGateAuthority,
  verifyCodexWebMcpSpikeEvidence,
  type CodexWebMcpSpikeFreshnessContext,
} from "./codex-webmcp-spike";
import {
  EXP0001A_CODEX_AUTHORITY_KEY_ID,
  EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_DIGEST,
  EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_PEM,
  EXP0001A_CODEX_AUTHORITY_SIGNATURE_VERSION,
  exp0001aCodexAuthoritySignatureMessage,
  exp0001aCodexAuthoritySignatureSchema,
  type Exp0001aCodexAuthoritySignature,
} from "./exp0001a-codex-authority";
import { canonicalJson, hashCanonicalJson, type JsonValue } from "./provenance-crypto";
import { assertNoSecretLeakage } from "./provenance-redaction";

export const CODEX_WEBMCP_SPIKE_SEAL_REQUEST_VERSION = "codex-webmcp-spike-seal-request/v1" as const;
export const CODEX_WEBMCP_SPIKE_INPUT_FILE = "spike-input.json" as const;
export const CODEX_WEBMCP_SPIKE_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const CODEX_WEBMCP_SPIKE_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const CODEX_WEBMCP_SPIKE_MAX_ARTIFACT_SET_BYTES = 256 * 1024 * 1024;
export const CODEX_WEBMCP_SPIKE_AUTHORITY_PRIVATE_KEY_FILE = "exp0001a-authority-private.pem" as const;

const SAFE_ARTIFACT_NAMES = new Set([
  "authPreflight",
  "promptEnvelope",
  "taskCreationReceipt",
  "roomCreationReceipt",
  "platformBootstrapTrace",
  "isolationAttestation",
  "webMcpTrace",
  "terminalResult",
  "semanticState",
  "canvasImage",
]);

const safeRelativeArtifactPathSchema = z.string().min(1).max(1_024).superRefine((value, context) => {
  const normalized = path.posix.normalize(value);
  if (path.isAbsolute(value) || value.includes("\\") || normalized !== value
      || normalized === "." || normalized === ".." || normalized.startsWith("../")
      || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    context.addIssue({ code: "custom", message: "Artifact paths must be normalized relative POSIX paths." });
  }
});

export const codexWebMcpSpikeSealRequestSchema = z.object({
  schemaVersion: z.literal(CODEX_WEBMCP_SPIKE_SEAL_REQUEST_VERSION),
  evidenceContent: codexWebMcpSpikeEvidenceContentSchema,
  artifactFiles: z.record(z.string(), safeRelativeArtifactPathSchema),
}).strict().superRefine((request, context) => {
  const expectedNames = Object.keys(request.evidenceContent.artifacts).sort();
  const suppliedNames = Object.keys(request.artifactFiles).sort();
  if (suppliedNames.some((name) => !SAFE_ARTIFACT_NAMES.has(name))) {
    context.addIssue({ code: "custom", path: ["artifactFiles"], message: "Artifact map contains an unknown evidence role." });
  }
  if (canonicalJson(expectedNames) !== canonicalJson(suppliedNames)) {
    context.addIssue({ code: "custom", path: ["artifactFiles"], message: "Artifact map must exactly cover the evidence references." });
  }
  if (new Set(Object.values(request.artifactFiles)).size !== suppliedNames.length) {
    context.addIssue({ code: "custom", path: ["artifactFiles"], message: "Every evidence role requires a distinct artifact file." });
  }
});

export type CodexWebMcpSpikeSealRequest = z.infer<typeof codexWebMcpSpikeSealRequestSchema>;

export type CodexWebMcpSpikeSealErrorCode =
  | "INVALID_ARGUMENTS"
  | "INVALID_INPUT"
  | "INPUT_NOT_PLAIN"
  | "INPUT_TOO_LARGE"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_NOT_PLAIN"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_SET_TOO_LARGE"
  | "ARTIFACT_BYTE_MISMATCH"
  | "ARTIFACT_DIGEST_MISMATCH"
  | "ARTIFACT_FORMAT_INVALID"
  | "SPIKE_EVIDENCE_INVALID"
  | "AA_GATE_DRAFT_INVALID"
  | "PUBLIC_REDACTION_FAILED"
  | "AA_GATE_NOT_ALLOWED"
  | "AUTHORITY_SIGNATURE_INVALID"
  | "AUTHORITY_PRIVATE_KEY_INVALID"
  | "UNSAFE_OUTPUT_PATH"
  | "OUTPUT_CONFLICT"
  | "OUTPUT_RETENTION_FAILED"
  | "INTERNAL_ERROR";

export class CodexWebMcpSpikeSealError extends Error {
  readonly code: CodexWebMcpSpikeSealErrorCode;

  constructor(code: CodexWebMcpSpikeSealErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexWebMcpSpikeSealError";
    this.code = code;
  }
}

function fail(code: CodexWebMcpSpikeSealErrorCode, message: string, cause?: unknown): never {
  throw new CodexWebMcpSpikeSealError(code, message, cause === undefined ? undefined : { cause });
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readPlainFile(filePath: string, maximumBytes: number, kind: "input" | "artifact"): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (kind === "artifact" && code === "ENOENT") fail("ARTIFACT_MISSING", "A referenced artifact is missing.", error);
    if (kind === "input" && code === "ENOENT") fail("INVALID_INPUT", "Spike input does not exist.", error);
    fail(kind === "artifact" ? "ARTIFACT_NOT_PLAIN" : "INPUT_NOT_PLAIN", `Spike ${kind} is not a readable plain file.`, error);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) fail(kind === "artifact" ? "ARTIFACT_NOT_PLAIN" : "INPUT_NOT_PLAIN", `Spike ${kind} is not a plain file.`);
    if (metadata.size > maximumBytes) fail(kind === "artifact" ? "ARTIFACT_TOO_LARGE" : "INPUT_TOO_LARGE", `Spike ${kind} exceeds its frozen byte limit.`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) fail("INVALID_INPUT", "Spike input is not valid UTF-8.");
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof CodexWebMcpSpikeSealError) throw error;
    fail("INVALID_INPUT", "Spike input is not valid JSON.", error);
  }
}

async function resolveInput(inputPath: string): Promise<{ requestFile: string; artifactRoot: string }> {
  const absolute = path.resolve(inputPath);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    fail("INVALID_INPUT", "Spike input does not exist.", error);
  }
  if (metadata.isSymbolicLink()) fail("INPUT_NOT_PLAIN", "Spike input cannot be a symbolic link.");
  if (metadata.isDirectory()) {
    const artifactRoot = await realpath(absolute);
    return { artifactRoot, requestFile: path.join(artifactRoot, CODEX_WEBMCP_SPIKE_INPUT_FILE) };
  }
  if (!metadata.isFile()) fail("INPUT_NOT_PLAIN", "Spike input must be a JSON file or artifact directory.");
  const artifactRoot = await realpath(path.dirname(absolute));
  const requestFile = path.join(artifactRoot, path.basename(absolute));
  const resolvedFile = await realpath(requestFile).catch((error) => fail("INVALID_INPUT", "Spike input does not exist.", error));
  if (resolvedFile !== requestFile) fail("INPUT_NOT_PLAIN", "Spike input cannot traverse a symbolic link.");
  return { artifactRoot, requestFile };
}

async function resolveArtifactPath(root: string, relativePath: string, requestFile: string): Promise<string> {
  safeRelativeArtifactPathSchema.parse(relativePath);
  const candidate = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    fail("ARTIFACT_NOT_PLAIN", "Artifact path escapes the private artifact directory.");
  }
  if (candidate === requestFile) fail("ARTIFACT_NOT_PLAIN", "The seal request cannot also serve as an evidence artifact.");
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("ARTIFACT_MISSING", "A referenced artifact is missing.", error);
    fail("ARTIFACT_NOT_PLAIN", "A referenced artifact path is unsafe.", error);
  }
  if (resolved !== candidate) fail("ARTIFACT_NOT_PLAIN", "Referenced artifacts cannot traverse symbolic links.");
  return candidate;
}

function validateArtifactFormat(bytes: Buffer, mimeType: string): void {
  if (mimeType === "image/png") {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < signature.length || !bytes.subarray(0, signature.length).equals(signature)) {
      fail("ARTIFACT_FORMAT_INVALID", "PNG evidence does not have a PNG signature.");
    }
  }
  if (mimeType === "application/json" || mimeType.endsWith("+json")) {
    try {
      JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      fail("ARTIFACT_FORMAT_INVALID", "JSON evidence is not valid JSON.", error);
    }
  }
}

async function validateReferencedArtifacts(
  request: CodexWebMcpSpikeSealRequest,
  artifactRoot: string,
  requestFile: string,
): Promise<void> {
  let totalBytes = 0;
  for (const [name, reference] of Object.entries(request.evidenceContent.artifacts)) {
    const relativePath = request.artifactFiles[name];
    if (relativePath === undefined) fail("ARTIFACT_MISSING", "An evidence role has no referenced artifact file.");
    const artifactPath = await resolveArtifactPath(artifactRoot, relativePath, requestFile);
    const bytes = await readPlainFile(artifactPath, CODEX_WEBMCP_SPIKE_MAX_ARTIFACT_BYTES, "artifact");
    totalBytes += bytes.length;
    if (totalBytes > CODEX_WEBMCP_SPIKE_MAX_ARTIFACT_SET_BYTES) fail("ARTIFACT_SET_TOO_LARGE", "Referenced artifact set exceeds its frozen byte limit.");
    if (bytes.length !== reference.bytes) fail("ARTIFACT_BYTE_MISMATCH", "Referenced artifact byte count does not match its evidence commitment.");
    if (sha256(bytes) !== reference.sha256) fail("ARTIFACT_DIGEST_MISMATCH", "Referenced artifact digest does not match its evidence commitment.");
    validateArtifactFormat(bytes, reference.mimeType);
  }
}

function knownRoomSecrets(evidence: ReturnType<typeof sealCodexWebMcpSpikeEvidence>): string[] {
  if (evidence.room === null) return [];
  const inviteCode = /#join=([A-HJ-NP-Z2-9]{6})$/.exec(evidence.room.privateRoomUrl)?.[1] ?? "";
  return [evidence.room.roomId, evidence.room.privateRoomUrl, inviteCode].filter((value) => value.length > 0);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectory(directory: string, mode: number): Promise<string> {
  try {
    await mkdir(directory, { recursive: true, mode });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("UNSAFE_OUTPUT_PATH", "Output directory is not a plain directory.");
    if (mode === 0o700 && (metadata.mode & 0o077) !== 0) {
      fail("UNSAFE_OUTPUT_PATH", "Private evidence directory has group or world permissions.");
    }
    return await realpath(directory);
  } catch (error) {
    if (error instanceof CodexWebMcpSpikeSealError) throw error;
    fail("UNSAFE_OUTPUT_PATH", "Output directory cannot be prepared safely.", error);
  }
}

function descendantPath(root: string, target: string, label: string): string {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("UNSAFE_OUTPUT_PATH", `${label} must be a JSON file beneath the private evidence root.`);
  }
  if (path.extname(target) !== ".json") fail("UNSAFE_OUTPUT_PATH", `${label} must use a .json suffix.`);
  return relative;
}

async function privateOutputTarget(privateRootInput: string, outputPathInput: string, label: string): Promise<{ root: string; target: string }> {
  const privateRootAbsolute = path.resolve(privateRootInput);
  if (path.basename(privateRootAbsolute) !== ".research-private") {
    fail("UNSAFE_OUTPUT_PATH", "Private evidence root must be the ignored .research-private directory.");
  }
  const relative = descendantPath(privateRootAbsolute, path.resolve(outputPathInput), label);
  const privateRoot = await ensureDirectory(privateRootAbsolute, 0o700);
  const expectedParent = path.join(privateRoot, path.dirname(relative));
  const parent = await ensureDirectory(expectedParent, 0o700);
  if (parent !== expectedParent) fail("UNSAFE_OUTPUT_PATH", `${label} cannot traverse a symbolic-link directory.`);
  return { root: privateRoot, target: path.join(parent, path.basename(relative)) };
}

async function publicOutputTarget(publicOutputPath: string, privateRoot: string): Promise<string> {
  const absolute = path.resolve(publicOutputPath);
  if (path.extname(absolute) !== ".json") fail("UNSAFE_OUTPUT_PATH", "Public evidence output must use a .json suffix.");
  const expectedParent = path.dirname(absolute);
  const parent = await ensureDirectory(expectedParent, 0o755);
  if (parent !== expectedParent) fail("UNSAFE_OUTPUT_PATH", "Public evidence output cannot traverse a symbolic-link directory.");
  const target = path.join(parent, path.basename(absolute));
  const relativeToPrivate = path.relative(privateRoot, target);
  if (relativeToPrivate === "" || (!relativeToPrivate.startsWith("..") && !path.isAbsolute(relativeToPrivate))) {
    fail("UNSAFE_OUTPUT_PATH", "Public evidence output cannot be inside the private evidence root.");
  }
  return target;
}

async function readExistingOutput(filePath: string): Promise<Buffer | null> {
  try {
    return await readPlainFile(filePath, CODEX_WEBMCP_SPIKE_MAX_INPUT_BYTES, "input");
  } catch (error) {
    if (error instanceof CodexWebMcpSpikeSealError && error.code === "INVALID_INPUT") return null;
    throw error;
  }
}

async function retainImmutable(filePath: string, value: JsonValue, mode: number): Promise<void> {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const existing = await readExistingOutput(filePath);
  if (existing !== null) {
    if (!existing.equals(bytes)) fail("OUTPUT_CONFLICT", "Retained evidence output already exists with different bytes.");
    const metadata = await stat(filePath);
    if ((metadata.mode & 0o777) !== mode) fail("OUTPUT_CONFLICT", "Retained evidence output has unsafe permissions.");
    return;
  }

  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      mode,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await readExistingOutput(filePath);
      if (raced === null || !raced.equals(bytes)) fail("OUTPUT_CONFLICT", "Concurrent evidence retention produced different bytes.");
    }
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (error instanceof CodexWebMcpSpikeSealError) throw error;
    fail("OUTPUT_RETENTION_FAILED", "Evidence output could not be retained atomically.", error);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
  const retained = await readExistingOutput(filePath);
  if (retained === null || !retained.equals(bytes)) fail("OUTPUT_RETENTION_FAILED", "Evidence output readback differs from retained bytes.");
  if (((await stat(filePath)).mode & 0o777) !== mode) fail("OUTPUT_RETENTION_FAILED", "Evidence output readback has unsafe permissions.");
}

async function assertAbsent(filePath: string): Promise<void> {
  try {
    await lstat(filePath);
    fail("OUTPUT_CONFLICT", "A stale A/A gate exists for non-passing spike evidence.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function readCanonicalPrivateJson(
  privateRootInput: string,
  inputPath: string,
  label: string,
): Promise<unknown> {
  const privateRootAbsolute = path.resolve(privateRootInput);
  if (path.basename(privateRootAbsolute) !== ".research-private") {
    fail("UNSAFE_OUTPUT_PATH", "Private evidence root must be the ignored .research-private directory.");
  }
  const relative = descendantPath(privateRootAbsolute, path.resolve(inputPath), label);
  let privateRoot: string;
  try {
    privateRoot = await realpath(privateRootAbsolute);
  } catch (error) {
    fail("INVALID_INPUT", "Private evidence root does not exist.", error);
  }
  if (privateRoot !== privateRootAbsolute) fail("UNSAFE_OUTPUT_PATH", "Private evidence root cannot traverse a symbolic link.");
  const rootMetadata = await lstat(privateRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (rootMetadata.mode & 0o077) !== 0) {
    fail("UNSAFE_OUTPUT_PATH", "Private evidence root must be a private plain directory.");
  }
  const target = path.join(privateRoot, relative);
  const expectedParent = path.dirname(target);
  let parent: string;
  try {
    parent = await realpath(expectedParent);
  } catch (error) {
    fail("INVALID_INPUT", `${label} parent does not exist.`, error);
  }
  if (parent !== expectedParent) fail("UNSAFE_OUTPUT_PATH", `${label} cannot traverse a symbolic-link directory.`);
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    fail("INVALID_INPUT", `${label} does not exist.`, error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    fail("INPUT_NOT_PLAIN", `${label} must be a plain mode-0600 file.`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    fail("INPUT_NOT_PLAIN", `${label} must be owned by the current user.`);
  }
  const bytes = await readPlainFile(target, CODEX_WEBMCP_SPIKE_MAX_INPUT_BYTES, "input");
  const value = parseJson(bytes);
  if (!bytes.equals(Buffer.from(canonicalJson(value as JsonValue), "utf8"))) {
    fail("INVALID_INPUT", `${label} must contain canonical JSON bytes.`);
  }
  return value;
}

async function readFixedSpikeGateAuthority(privateRootInput: string) {
  const privateRoot = path.resolve(privateRootInput);
  if (path.basename(privateRoot) !== ".research-private") {
    fail("AUTHORITY_PRIVATE_KEY_INVALID", "Spike-gate authority root is not the fixed private root.");
  }
  const keyPath = path.join(privateRoot, CODEX_WEBMCP_SPIKE_AUTHORITY_PRIVATE_KEY_FILE);
  try {
    if (await realpath(privateRoot) !== privateRoot || await realpath(keyPath) !== keyPath) {
      fail("AUTHORITY_PRIVATE_KEY_INVALID", "Spike-gate authority key path is not canonical.");
    }
    const metadata = await lstat(keyPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
      fail("AUTHORITY_PRIVATE_KEY_INVALID", "Spike-gate authority private key must be a plain mode-0600 file.");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      fail("AUTHORITY_PRIVATE_KEY_INVALID", "Spike-gate authority private key must be owned by the current user.");
    }
    const keyBytes = await readPlainFile(keyPath, 64 * 1024, "input");
    const privateKey = createPrivateKey(keyBytes);
    const trustedPublicKey = createPublicKey(EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_PEM);
    const derivedPublicKey = createPublicKey(privateKey);
    const trustedDer = Buffer.from(trustedPublicKey.export({ format: "der", type: "spki" }));
    const derivedDer = Buffer.from(derivedPublicKey.export({ format: "der", type: "spki" }));
    if (privateKey.asymmetricKeyType !== "ed25519"
        || trustedPublicKey.asymmetricKeyType !== "ed25519"
        || derivedPublicKey.asymmetricKeyType !== "ed25519"
        || !trustedDer.equals(derivedDer)
        || sha256(Buffer.from(EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_PEM, "utf8"))
          !== EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_DIGEST) {
      fail("AUTHORITY_PRIVATE_KEY_INVALID", "Spike-gate authority key does not match the frozen Ed25519 trust anchor.");
    }
    return privateKey;
  } catch (error) {
    if (error instanceof CodexWebMcpSpikeSealError) throw error;
    fail("AUTHORITY_PRIVATE_KEY_INVALID", "Spike-gate authority private key could not be loaded.", error);
  }
}

export type SealCodexWebMcpSpikeOptions = Readonly<{
  inputPath: string;
  privateRoot: string;
  privateEvidenceOutputPath: string;
  publicEvidenceOutputPath: string;
  aaGateDraftOutputPath: string;
  evaluatedAt: string;
  freshness?: CodexWebMcpSpikeFreshnessContext;
}>;

export type SealCodexWebMcpSpikeResult = Readonly<{
  status: "pass" | "fail";
  privateEvidenceDigest: string;
  publicEvidenceDigest: string;
  aaGateDraftCreated: boolean;
  aaGateDraftDigest: string | null;
}>;

/**
 * Converts private exact-byte spike material into immutable private evidence,
 * a strict public projection, and (only for a verified PASS) an unsigned gate
 * draft. A separate fixed-key signer must authorize that exact retained draft.
 */
export async function sealCodexWebMcpSpikeFromDisk(
  options: SealCodexWebMcpSpikeOptions,
): Promise<SealCodexWebMcpSpikeResult> {
  const { requestFile, artifactRoot } = await resolveInput(options.inputPath);
  const requestBytes = await readPlainFile(requestFile, CODEX_WEBMCP_SPIKE_MAX_INPUT_BYTES, "input");
  let request: CodexWebMcpSpikeSealRequest;
  try {
    request = codexWebMcpSpikeSealRequestSchema.parse(parseJson(requestBytes));
  } catch (error) {
    if (error instanceof CodexWebMcpSpikeSealError) throw error;
    fail("INVALID_INPUT", "Spike seal request failed strict validation.", error);
  }
  await validateReferencedArtifacts(request, artifactRoot, requestFile);

  let privateEvidence;
  try {
    privateEvidence = sealCodexWebMcpSpikeEvidence(request.evidenceContent);
    const verification = verifyCodexWebMcpSpikeEvidence(privateEvidence, options.freshness);
    if (!verification.ok) fail("SPIKE_EVIDENCE_INVALID", "Spike evidence failed independent verification.");
    privateEvidence = verification.evidence;
  } catch (error) {
    if (error instanceof CodexWebMcpSpikeSealError) throw error;
    fail("SPIKE_EVIDENCE_INVALID", "Spike evidence cannot be sealed and verified.", error);
  }

  let publicEvidence;
  try {
    publicEvidence = createPublicCodexWebMcpSpikeEvidence(privateEvidence);
    assertNoSecretLeakage(publicEvidence, knownRoomSecrets(privateEvidence));
  } catch (error) {
    fail("PUBLIC_REDACTION_FAILED", "Spike public projection failed secret-redaction verification.", error);
  }

  const privateTarget = await privateOutputTarget(options.privateRoot, options.privateEvidenceOutputPath, "Private evidence output");
  const gateTarget = await privateOutputTarget(options.privateRoot, options.aaGateDraftOutputPath, "A/A gate draft output");
  if (gateTarget.target === privateTarget.target) fail("UNSAFE_OUTPUT_PATH", "Private evidence and A/A gate outputs must differ.");
  const publicTarget = await publicOutputTarget(options.publicEvidenceOutputPath, privateTarget.root);
  let gateDraft = null;
  if (privateEvidence.status === "pass") {
    gateDraft = createCodexWebMcpAaGate({
      evaluatedAt: options.evaluatedAt,
      spikeEvidence: privateEvidence,
      freshness: options.freshness,
    });
    if (gateDraft.decision !== "allow") fail("AA_GATE_NOT_ALLOWED", "A/A gate draft cannot be created before a verified completed PASS.");
  } else {
    await assertAbsent(gateTarget.target);
  }

  await retainImmutable(privateTarget.target, privateEvidence as unknown as JsonValue, 0o600);
  await retainImmutable(publicTarget, publicEvidence as unknown as JsonValue, 0o644);
  if (gateDraft !== null) await retainImmutable(gateTarget.target, gateDraft as unknown as JsonValue, 0o600);

  return Object.freeze({
    status: privateEvidence.status,
    privateEvidenceDigest: privateEvidence.evidenceDigest,
    publicEvidenceDigest: hashCanonicalJson(publicEvidence as unknown as JsonValue),
    aaGateDraftCreated: gateDraft !== null,
    aaGateDraftDigest: gateDraft?.gateDigest ?? null,
  });
}

export type RetainAuthorizedCodexWebMcpAaGateOptions = Readonly<{
  privateRoot: string;
  privateEvidencePath: string;
  aaGateDraftPath: string;
  signedGateOutputPath: string;
  publicGateOutputPath: string;
  authoritySignature: Exp0001aCodexAuthoritySignature;
}>;

export type AuthorizedCodexWebMcpAaGateResult = Readonly<{
  status: "authorized";
  spikeEvidenceDigest: string;
  aaGateDigest: string;
  signedGateDigest: string;
  publicGateDigest: string;
  authoritySignatureDigest: string;
}>;

async function loadVerifiedSpikeGateInputs(options: Readonly<{
  privateRoot: string;
  privateEvidencePath: string;
  aaGateDraftPath: string;
}>) {
  let evidence;
  let gateDraft;
  try {
    evidence = codexWebMcpSpikeEvidenceSchema.parse(await readCanonicalPrivateJson(
      options.privateRoot,
      options.privateEvidencePath,
      "Private spike evidence",
    ));
    const verification = verifyCodexWebMcpSpikeEvidence(evidence);
    if (!verification.ok || verification.evidence.status !== "pass") {
      fail("SPIKE_EVIDENCE_INVALID", "Only independently verified PASS spike evidence may be authorized.");
    }
    evidence = verification.evidence;
  } catch (error) {
    if (error instanceof CodexWebMcpSpikeSealError) throw error;
    fail("SPIKE_EVIDENCE_INVALID", "Retained private spike evidence is invalid.", error);
  }
  try {
    gateDraft = codexWebMcpAaGateDraftSchema.parse(await readCanonicalPrivateJson(
      options.privateRoot,
      options.aaGateDraftPath,
      "Retained A/A gate draft",
    ));
    const expectedDraft = createCodexWebMcpAaGate({
      evaluatedAt: gateDraft.evaluatedAt,
      spikeEvidence: evidence,
    });
    if (canonicalJson(gateDraft as unknown as JsonValue)
        !== canonicalJson(expectedDraft as unknown as JsonValue)
        || gateDraft.decision !== "allow") {
      fail("AA_GATE_DRAFT_INVALID", "Retained A/A gate draft is not the exact verified projection of retained spike evidence.");
    }
  } catch (error) {
    if (error instanceof CodexWebMcpSpikeSealError) throw error;
    fail("AA_GATE_DRAFT_INVALID", "Retained A/A gate draft is invalid.", error);
  }
  return { evidence, gateDraft };
}

/**
 * Retains a signed private gate and public non-secret projection only after the
 * supplied signature verifies against the frozen authority key. This accepts
 * a signature so deterministic non-secret fixtures can exercise retention;
 * the production signer command below never accepts one from its caller.
 */
export async function retainAuthorizedCodexWebMcpAaGateFromDisk(
  options: RetainAuthorizedCodexWebMcpAaGateOptions,
): Promise<AuthorizedCodexWebMcpAaGateResult> {
  const { evidence, gateDraft } = await loadVerifiedSpikeGateInputs(options);
  let signedGate;
  let publicGate;
  try {
    signedGate = authorizeCodexWebMcpAaGate({
      gate: gateDraft,
      authoritySignature: exp0001aCodexAuthoritySignatureSchema.parse(options.authoritySignature),
    });
    assertCodexWebMcpAaExecutionAllowed(signedGate, evidence);
    publicGate = createPublicCodexWebMcpAaGate(signedGate);
    assertNoSecretLeakage(publicGate, knownRoomSecrets(evidence));
  } catch (error) {
    fail("AUTHORITY_SIGNATURE_INVALID", "Spike-gate authority signature is invalid.", error);
  }

  const signedTarget = await privateOutputTarget(
    options.privateRoot,
    options.signedGateOutputPath,
    "Signed A/A gate output",
  );
  const evidencePath = path.resolve(options.privateEvidencePath);
  const draftPath = path.resolve(options.aaGateDraftPath);
  if (signedTarget.target === evidencePath || signedTarget.target === draftPath) {
    fail("UNSAFE_OUTPUT_PATH", "Signed A/A gate output must not overwrite its retained inputs.");
  }
  const publicTarget = await publicOutputTarget(options.publicGateOutputPath, signedTarget.root);
  await retainImmutable(signedTarget.target, signedGate as unknown as JsonValue, 0o600);
  await retainImmutable(publicTarget, publicGate as unknown as JsonValue, 0o644);

  try {
    const retainedSigned = codexWebMcpAaGateSchema.parse(parseJson(
      (await readExistingOutput(signedTarget.target))!,
    ));
    const retainedPublic = publicCodexWebMcpAaGateSchema.parse(parseJson(
      (await readExistingOutput(publicTarget))!,
    ));
    verifyCodexWebMcpAaGateAuthority(retainedSigned);
    assertCodexWebMcpAaExecutionAllowed(retainedSigned, evidence);
    if (canonicalJson(retainedSigned as unknown as JsonValue) !== canonicalJson(signedGate as unknown as JsonValue)
        || canonicalJson(retainedPublic as unknown as JsonValue) !== canonicalJson(publicGate as unknown as JsonValue)) {
      fail("OUTPUT_RETENTION_FAILED", "Signed spike-gate readback differs from the authorized values.");
    }
  } catch (error) {
    if (error instanceof CodexWebMcpSpikeSealError) throw error;
    fail("OUTPUT_RETENTION_FAILED", "Signed spike-gate readback failed verification.", error);
  }

  return Object.freeze({
    status: "authorized",
    spikeEvidenceDigest: evidence.evidenceDigest,
    aaGateDigest: signedGate.gateDigest,
    signedGateDigest: hashCanonicalJson(signedGate as unknown as JsonValue),
    publicGateDigest: hashCanonicalJson(publicGate as unknown as JsonValue),
    authoritySignatureDigest: hashCanonicalJson(signedGate.authoritySignature as unknown as JsonValue),
  });
}

export type SignCodexWebMcpAaGateOptions = Readonly<Omit<
  RetainAuthorizedCodexWebMcpAaGateOptions,
  "authoritySignature"
> & {
  signedAt: string;
}>;

/**
 * Production spike-gate signer. The signature is derived exclusively from the
 * fixed ignored mode-0600 authority key; no signature or key path is accepted
 * from the caller.
 */
export async function signCodexWebMcpAaGateFromDisk(
  options: SignCodexWebMcpAaGateOptions,
): Promise<AuthorizedCodexWebMcpAaGateResult> {
  const { gateDraft } = await loadVerifiedSpikeGateInputs(options);
  const signedAt = z.string().datetime({ offset: true }).parse(options.signedAt);
  if (Date.parse(signedAt) < Date.parse(gateDraft.evaluatedAt)) {
    fail("AUTHORITY_SIGNATURE_INVALID", "Spike-gate signature cannot predate gate evaluation.");
  }
  const privateKey = await readFixedSpikeGateAuthority(options.privateRoot);
  const signatureContent = {
    schemaVersion: EXP0001A_CODEX_AUTHORITY_SIGNATURE_VERSION,
    protocolId: "EXP-0001A" as const,
    kind: "codex-authority-signature" as const,
    algorithm: "Ed25519" as const,
    keyId: EXP0001A_CODEX_AUTHORITY_KEY_ID,
    publicKeyDigest: EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_DIGEST,
    signedAt,
    purpose: "spike_gate" as const,
    payloadDigest: hashCanonicalJson(gateDraft as unknown as JsonValue),
  };
  const authoritySignature = exp0001aCodexAuthoritySignatureSchema.parse({
    ...signatureContent,
    signatureBase64: signEd25519(
      null,
      exp0001aCodexAuthoritySignatureMessage(signatureContent),
      privateKey,
    ).toString("base64"),
  });
  return retainAuthorizedCodexWebMcpAaGateFromDisk({
    ...options,
    authoritySignature,
  });
}

type CliIo = Readonly<{
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
}>;

type ParsedCli = Readonly<{
  inputPath: string;
  privateEvidenceRelativePath: string;
  publicEvidencePath: string;
  aaGateDraftRelativePath: string;
  evaluatedAt: string;
}>;

function parseCliArguments(argv: readonly string[]): ParsedCli {
  const values = new Map<string, string>();
  const allowed = new Set(["--input", "--private-output", "--public-output", "--gate-draft-output", "--evaluated-at"]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name || !allowed.has(name) || !value || value.startsWith("--") || values.has(name)) {
      fail("INVALID_ARGUMENTS", "Invalid Codex/WebMCP spike sealer arguments.");
    }
    values.set(name, value);
  }
  if (values.size !== allowed.size || argv.length !== allowed.size * 2) {
    fail("INVALID_ARGUMENTS", "Codex/WebMCP spike sealer requires all five named arguments exactly once.");
  }
  const privateEvidenceRelativePath = safeRelativeArtifactPathSchema.parse(values.get("--private-output"));
  const aaGateDraftRelativePath = safeRelativeArtifactPathSchema.parse(values.get("--gate-draft-output"));
  const evaluatedAt = z.string().datetime({ offset: true }).parse(values.get("--evaluated-at"));
  return {
    inputPath: values.get("--input")!,
    privateEvidenceRelativePath,
    publicEvidencePath: values.get("--public-output")!,
    aaGateDraftRelativePath,
    evaluatedAt,
  };
}

export async function runCodexWebMcpSpikeSealCli(
  argv: readonly string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  cwd = process.cwd(),
): Promise<number> {
  try {
    const args = parseCliArguments(argv);
    const privateRoot = path.resolve(cwd, ".research-private");
    const result = await sealCodexWebMcpSpikeFromDisk({
      inputPath: path.resolve(cwd, args.inputPath),
      privateRoot,
      privateEvidenceOutputPath: path.join(privateRoot, ...args.privateEvidenceRelativePath.split("/")),
      publicEvidenceOutputPath: path.resolve(cwd, args.publicEvidencePath),
      aaGateDraftOutputPath: path.join(privateRoot, ...args.aaGateDraftRelativePath.split("/")),
      evaluatedAt: args.evaluatedAt,
    });
    io.stdout.write(`${canonicalJson({
      status: result.status,
      privateEvidenceDigest: result.privateEvidenceDigest,
      publicEvidenceDigest: result.publicEvidenceDigest,
      aaGateDraftCreated: result.aaGateDraftCreated,
      aaGateDraftDigest: result.aaGateDraftDigest,
    })}\n`);
    return result.status === "pass" ? 0 : 2;
  } catch (error) {
    const code = error instanceof CodexWebMcpSpikeSealError ? error.code : "INTERNAL_ERROR";
    io.stderr.write(`${canonicalJson({ status: "error", errorCode: code })}\n`);
    return 1;
  }
}

type ParsedSignerCli = Readonly<{
  privateEvidenceRelativePath: string;
  aaGateDraftRelativePath: string;
  signedGateRelativePath: string;
  publicGatePath: string;
  signedAt: string;
}>;

function parseSignerCliArguments(argv: readonly string[]): ParsedSignerCli {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--private-evidence",
    "--gate-draft",
    "--signed-gate-output",
    "--public-gate-output",
    "--signed-at",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name || !allowed.has(name) || !value || value.startsWith("--") || values.has(name)) {
      fail("INVALID_ARGUMENTS", "Invalid Codex/WebMCP spike-gate signer arguments.");
    }
    values.set(name, value);
  }
  if (values.size !== allowed.size || argv.length !== allowed.size * 2) {
    fail("INVALID_ARGUMENTS", "Codex/WebMCP spike-gate signer requires all five named arguments exactly once.");
  }
  return {
    privateEvidenceRelativePath: safeRelativeArtifactPathSchema.parse(values.get("--private-evidence")),
    aaGateDraftRelativePath: safeRelativeArtifactPathSchema.parse(values.get("--gate-draft")),
    signedGateRelativePath: safeRelativeArtifactPathSchema.parse(values.get("--signed-gate-output")),
    publicGatePath: values.get("--public-gate-output")!,
    signedAt: z.string().datetime({ offset: true }).parse(values.get("--signed-at")),
  };
}

export async function runCodexWebMcpSpikeGateSignerCli(
  argv: readonly string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  cwd = process.cwd(),
): Promise<number> {
  try {
    const args = parseSignerCliArguments(argv);
    const privateRoot = path.resolve(cwd, ".research-private");
    const result = await signCodexWebMcpAaGateFromDisk({
      privateRoot,
      privateEvidencePath: path.join(privateRoot, ...args.privateEvidenceRelativePath.split("/")),
      aaGateDraftPath: path.join(privateRoot, ...args.aaGateDraftRelativePath.split("/")),
      signedGateOutputPath: path.join(privateRoot, ...args.signedGateRelativePath.split("/")),
      publicGateOutputPath: path.resolve(cwd, args.publicGatePath),
      signedAt: args.signedAt,
    });
    io.stdout.write(`${canonicalJson(result as unknown as JsonValue)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof CodexWebMcpSpikeSealError ? error.code : "INTERNAL_ERROR";
    io.stderr.write(`${canonicalJson({ status: "error", errorCode: code })}\n`);
    return 1;
  }
}
