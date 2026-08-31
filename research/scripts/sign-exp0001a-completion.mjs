#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { verifyExp0001aOuterExecutionSourceCommitments } from "./exp0001a-outer-source-verifier.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");

export const FIXED_COMPLETION_PUBLIC_KEY_PATH = "research/data/exp0001a-execution-authority-public.pem";
export const FIXED_COMPLETION_PRIVATE_KEY_PATH = ".research-private/exp0001a-authority-private.pem";
export const FIXED_COMPLETION_PUBLIC_KEY_DIGEST =
  "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de";
export const FIXED_COMPLETION_KEY_ID = "exp0001a-launch-authority-2026-08-30";
export const COMPLETION_EVIDENCE_FILE_NAME = "codex-completion-evidence.json";
export const COMPLETION_DRAFT_FILE_NAME = "codex-completion-attestation-draft.json";
export const COMPLETION_ATTESTATION_FILE_NAME = "codex-completion-attestation.json";
export const RUNTIME_BUNDLE_PATH = "research/runtime/exp0001a-runtime.bundle.mjs";
export const COMPLETION_SIGNATURE_DOMAIN = "Jazzboard EXP-0001A Codex authority v1\0";
export const COMPLETION_SIGNATURE_MAX_DELAY_MS = 15 * 60_000;
export const REVOKED_COMPLETION_PAYLOAD_DIGESTS = Object.freeze([
  "sha256:4b061142c4dffa3b6393d7966515926c343647f6cb3c40457b7382df4a03f757",
]);

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMPLETION_TEMPORARY_SUFFIX = /-[0-9]+-[a-f0-9-]{36}\.tmp$/;

function canonicalize(value, at = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${at}.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${at}/${index}`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Only plain JSON objects are supported at ${at}.`);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new TypeError(`Non-JSON value at ${at}/${key}.`);
      }
      result[key] = canonicalize(item, `${at}/${key}`);
    }
    return result;
  }
  throw new TypeError(`Non-JSON value at ${at}.`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function parseTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is not a valid timestamp.`);
  return value;
}

export function parseExp0001aCompletionDraft(value) {
  if (!hasExactKeys(value, [
    "schemaVersion", "kind", "protocolId", "completedAt", "lineage", "schedule", "transport",
    "review", "accounting", "scientificControls", "completionDigest",
  ]) || value.schemaVersion !== "exp-0001a-codex-completion-attestation/v2"
      || value.kind !== "exp-0001a-codex-experiment-complete" || value.protocolId !== "EXP-0001A"
      || !SHA256.test(value.completionDigest)) {
    throw new Error("Completion draft has an invalid v2 schema.");
  }
  parseTimestamp(value.completedAt, "Completion time");
  const forbidden = /(?:api\.openai\.com|OPENAI_API_KEY|authorizedMaximumUsd|costUsd|spendAuthorization|providerToken)/i;
  if (forbidden.test(canonicalJson(value))) throw new Error("Completion draft contains forbidden provider-billing evidence.");
  const { completionDigest, ...content } = value;
  if (sha256(canonicalJson(content)) !== completionDigest) throw new Error("Completion draft digest is invalid.");
  return value;
}

function signatureContent(draft, signedAt, keyId, publicKeyDigest) {
  return {
    schemaVersion: "exp-0001a-codex-authority-signature/v1",
    protocolId: "EXP-0001A",
    kind: "codex-authority-signature",
    algorithm: "Ed25519",
    keyId,
    publicKeyDigest,
    signedAt,
    purpose: "completion_attestation",
    payloadDigest: sha256(canonicalJson(draft)),
  };
}

function signatureMessage(content) {
  return Buffer.from(`${COMPLETION_SIGNATURE_DOMAIN}${canonicalJson(content)}`, "utf8");
}

/** Pure signer for tests. Production always supplies the fixed ignored private
 * key and committed public-key digest through signExp0001aCompletionRun. */
export function createExp0001aCompletionSignature(input) {
  const draft = parseExp0001aCompletionDraft(input.draft);
  const signedAt = parseTimestamp(input.signedAt, "Completion signature time");
  const delayMs = Date.parse(signedAt) - Date.parse(draft.completedAt);
  if (delayMs < 0 || delayMs > COMPLETION_SIGNATURE_MAX_DELAY_MS) {
    throw new Error("Completion signature is outside the fixed post-evidence signing window.");
  }
  if (!SHA256.test(input.expectedPublicKeyDigest) || sha256(input.publicKeyBytes) !== input.expectedPublicKeyDigest) {
    throw new Error("Completion public key does not match the expected trust anchor.");
  }
  const privateKey = createPrivateKey(input.privateKeyBytes);
  const publicKey = createPublicKey(input.publicKeyBytes);
  const derivedPublicKey = createPublicKey(privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519"
      || derivedPublicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Completion authority keys must be Ed25519.");
  }
  const expectedDer = publicKey.export({ type: "spki", format: "der" });
  const derivedDer = derivedPublicKey.export({ type: "spki", format: "der" });
  if (!Buffer.from(expectedDer).equals(Buffer.from(derivedDer))) {
    throw new Error("Completion private key does not match the precommitted public key.");
  }
  const content = signatureContent(draft, signedAt, input.expectedKeyId, input.expectedPublicKeyDigest);
  if (REVOKED_COMPLETION_PAYLOAD_DIGESTS.includes(content.payloadDigest)) {
    throw new Error("Completion payload has been explicitly revoked.");
  }
  const signature = signEd25519(null, signatureMessage(content), privateKey);
  if (signature.length !== 64 || !verifyEd25519(null, signatureMessage(content), publicKey, signature)) {
    throw new Error("Completion signature failed immediate public-key verification.");
  }
  return Object.freeze({
    ...draft,
    authoritySignature: { ...content, signatureBase64: signature.toString("base64") },
  });
}

async function requirePlainFile(filePath, label, requiredMode = null) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be a singly linked plain file.`);
  if (requiredMode !== null && (stat.mode & 0o777) !== requiredMode) throw new Error(`${label} must have mode ${requiredMode.toString(8)}.`);
  if (requiredMode !== null && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function loadCanonicalJson(filePath, label, requiredMode = 0o600) {
  const bytes = await requirePlainFile(filePath, label, requiredMode);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is not valid JSON.`); }
  if (!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`, "utf8"))) throw new Error(`${label} bytes are not canonical JSON plus one newline.`);
  return value;
}

async function fsyncDirectory(directory) {
  const parent = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}

async function writeFsyncedTemporaryFile(filePath, bytes) {
  const handle = await open(filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

function isRecognizedCompletionTemporaryName(outputPath, name) {
  return name.startsWith(`.${path.basename(outputPath)}-`) && COMPLETION_TEMPORARY_SUFFIX.test(name);
}

async function readPublishedCompletionBytes(filePath) {
  let metadata;
  try { metadata = await lstat(filePath); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("Signed completion attestation must be an owned private plain file.");
  }
  let publicationTemporaryPath = null;
  if (metadata.nlink !== 1) {
    if (metadata.nlink !== 2) {
      throw new Error("Signed completion attestation has an invalid link count.");
    }
    const matching = [];
    for (const name of await readdir(path.dirname(filePath))) {
      if (!isRecognizedCompletionTemporaryName(filePath, name)) continue;
      const temporaryPath = path.join(path.dirname(filePath), name);
      const temporaryMetadata = await lstat(temporaryPath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (temporaryMetadata !== null && temporaryMetadata.dev === metadata.dev
          && temporaryMetadata.ino === metadata.ino) matching.push(temporaryPath);
    }
    if (matching.length !== 1) {
      // A live publisher may have removed its temporary hard link while this
      // reader scanned the directory. Re-read once before failing closed.
      const refreshed = await lstat(filePath);
      if (refreshed.dev !== metadata.dev || refreshed.ino !== metadata.ino || refreshed.nlink !== 1) {
        throw new Error("Signed completion attestation has an unrecognized publication link.");
      }
      metadata = refreshed;
    } else {
      publicationTemporaryPath = matching[0];
    }
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  return Object.freeze({ bytes, publicationTemporaryPath, device: metadata.dev, inode: metadata.ino });
}

export function verifyExp0001aRetainedCompletionAttestation(input) {
  const retained = input.attestation;
  const draft = parseExp0001aCompletionDraft(input.draft);
  if (!hasExactKeys(retained, [...Object.keys(draft), "authoritySignature"])) {
    throw new Error("Signed completion attestation has an invalid envelope schema.");
  }
  const { authoritySignature, ...retainedDraftValue } = retained;
  const retainedDraft = parseExp0001aCompletionDraft(retainedDraftValue);
  if (canonicalJson(retainedDraft) !== canonicalJson(draft)) {
    throw new Error("Signed completion attestation conflicts with the exact reconstructed draft.");
  }
  if (!hasExactKeys(authoritySignature, [
    "schemaVersion", "protocolId", "kind", "algorithm", "keyId", "publicKeyDigest",
    "signedAt", "purpose", "payloadDigest", "signatureBase64",
  ])) throw new Error("Signed completion authority signature has an invalid schema.");
  const signedAt = parseTimestamp(authoritySignature.signedAt, "Completion signature time");
  const expectedContent = signatureContent(
    retainedDraft,
    signedAt,
    input.expectedKeyId,
    input.expectedPublicKeyDigest,
  );
  const { signatureBase64, ...retainedContent } = authoritySignature;
  if (canonicalJson(retainedContent) !== canonicalJson(expectedContent)) {
    throw new Error("Signed completion authority signature conflicts with the fixed authority metadata.");
  }
  const delayMs = Date.parse(signedAt) - Date.parse(retainedDraft.completedAt);
  if (delayMs < 0 || delayMs > COMPLETION_SIGNATURE_MAX_DELAY_MS) {
    throw new Error("Signed completion authority signature is outside the fixed post-evidence signing window.");
  }
  if (REVOKED_COMPLETION_PAYLOAD_DIGESTS.includes(expectedContent.payloadDigest)) {
    throw new Error("Completion payload has been explicitly revoked.");
  }
  if (!SHA256.test(input.expectedPublicKeyDigest)
      || sha256(input.publicKeyBytes) !== input.expectedPublicKeyDigest) {
    throw new Error("Completion public key does not match the expected trust anchor.");
  }
  const publicKey = createPublicKey(input.publicKeyBytes);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Completion authority key must be Ed25519.");
  if (typeof signatureBase64 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signatureBase64)) {
    throw new Error("Signed completion authority signature is not canonical Ed25519 base64.");
  }
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== signatureBase64
      || !verifyEd25519(null, signatureMessage(expectedContent), publicKey, signature)) {
    throw new Error("Signed completion authority signature failed public-key verification.");
  }
  return Object.freeze(retained);
}

async function loadRetainedCompletionAttestation(filePath, verification) {
  const publication = await readPublishedCompletionBytes(filePath);
  if (publication === null) return null;
  let value;
  try { value = JSON.parse(publication.bytes.toString("utf8")); } catch {
    throw new Error("Signed completion attestation is not valid JSON; refusing to overwrite it.");
  }
  if (!publication.bytes.equals(Buffer.from(`${canonicalJson(value)}\n`, "utf8"))) {
    throw new Error("Signed completion attestation bytes are not canonical JSON plus one newline; refusing to overwrite them.");
  }
  const retained = verifyExp0001aRetainedCompletionAttestation({ ...verification, attestation: value });
  if (publication.publicationTemporaryPath !== null) {
    const currentCanonical = await lstat(filePath);
    const currentTemporary = await lstat(publication.publicationTemporaryPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (currentTemporary !== null && currentCanonical.dev === publication.device
        && currentCanonical.ino === publication.inode && currentTemporary.dev === publication.device
        && currentTemporary.ino === publication.inode) {
      await unlink(publication.publicationTemporaryPath);
      await fsyncDirectory(path.dirname(filePath));
    }
  }
  return retained;
}

export async function publishExp0001aCompletionAttestation(input) {
  const verification = {
    draft: input.draft,
    publicKeyBytes: input.publicKeyBytes,
    expectedPublicKeyDigest: input.expectedPublicKeyDigest,
    expectedKeyId: input.expectedKeyId,
  };
  const existing = await loadRetainedCompletionAttestation(input.outputPath, verification);
  if (existing !== null) return Object.freeze({ attestation: existing, reused: true });
  const attestation = verifyExp0001aRetainedCompletionAttestation({
    ...verification,
    attestation: input.attestation,
  });
  const bytes = Buffer.from(`${canonicalJson(attestation)}\n`, "utf8");
  const directory = path.dirname(input.outputPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(input.outputPath)}-${process.pid}-${randomUUID()}.tmp`,
  );
  await writeFsyncedTemporaryFile(temporaryPath, bytes);
  await fsyncDirectory(directory);
  let published = false;
  try {
    try {
      await link(temporaryPath, input.outputPath);
      published = true;
      await fsyncDirectory(directory);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const retained = await loadRetainedCompletionAttestation(input.outputPath, verification);
    if (retained === null) throw new Error("Signed completion publication disappeared before readback.");
    return Object.freeze({ attestation: retained, reused: !published });
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await fsyncDirectory(directory).catch(() => undefined);
  }
}

async function loadFixedCompletionPublicAuthority() {
  const publicPath = path.join(REPO_ROOT, FIXED_COMPLETION_PUBLIC_KEY_PATH);
  if (await realpath(publicPath) !== publicPath) throw new Error("Completion public authority path must be canonical and non-symlinked.");
  const publicKeyBytes = await requirePlainFile(publicPath, "Completion public key");
  if (sha256(publicKeyBytes) !== FIXED_COMPLETION_PUBLIC_KEY_DIGEST) {
    throw new Error("Completion public key differs from the precommitted trust anchor.");
  }
  return { publicKeyBytes };
}

async function loadFixedCompletionAuthority() {
  const privatePath = path.join(REPO_ROOT, FIXED_COMPLETION_PRIVATE_KEY_PATH);
  if (await realpath(privatePath) !== privatePath) throw new Error("Completion private authority path must be canonical and non-symlinked.");
  const [{ publicKeyBytes }, privateKeyBytes] = await Promise.all([
    loadFixedCompletionPublicAuthority(),
    requirePlainFile(privatePath, "Completion private key", 0o600),
  ]);
  return { privateKeyBytes, publicKeyBytes };
}

export function parseExp0001aCompletionSignerArgs(argv) {
  if (argv.length === 1 && argv[0] === "--check-readiness") return Object.freeze({ mode: "check-readiness" });
  const args = { runRoot: null, approvedCompletionDigest: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--run-root" && argv[index + 1]) args.runRoot = argv[++index];
    else if (flag === "--approved-completion-digest" && argv[index + 1]) args.approvedCompletionDigest = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  if (!args.runRoot || !args.approvedCompletionDigest || !SHA256.test(args.approvedCompletionDigest)) {
    throw new Error("Usage: sign-exp0001a-completion.mjs --run-root <absolute-run-root> --approved-completion-digest <sha256> | --check-readiness");
  }
  return Object.freeze({ mode: "sign", ...args });
}

export async function checkExp0001aCompletionSignerReadiness() {
  await loadFixedCompletionAuthority();
  return Object.freeze({
    schemaVersion: "exp-0001a-completion-signer-readiness/v2",
    protocolId: "EXP-0001A",
    keyId: FIXED_COMPLETION_KEY_ID,
    publicKeyDigest: FIXED_COMPLETION_PUBLIC_KEY_DIGEST,
    authenticationBillingModel: "chatgpt_subscription",
    privateKeyPath: FIXED_COMPLETION_PRIVATE_KEY_PATH,
    privateKeyMode: "0600",
  });
}

export async function signExp0001aCompletionRun(input) {
  if (!path.isAbsolute(input.runRoot) || path.normalize(input.runRoot) !== input.runRoot
      || input.runRoot === path.parse(input.runRoot).root) throw new Error("Run root must be an absolute normalized non-root path.");
  const allowedRunsRoot = path.join(REPO_ROOT, "research", "results", "runs");
  const [realRunsRoot, realRunRoot] = await Promise.all([realpath(allowedRunsRoot), realpath(input.runRoot)]);
  const relative = path.relative(realRunsRoot, realRunRoot);
  if (realRunsRoot !== allowedRunsRoot || realRunRoot !== input.runRoot || relative.length === 0
      || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Completion signing is restricted to a canonical run beneath research/results/runs.");
  }
  const evidence = await loadCanonicalJson(path.join(realRunRoot, COMPLETION_EVIDENCE_FILE_NAME), "Completion evidence");
  const candidate = parseExp0001aCompletionDraft(
    await loadCanonicalJson(path.join(realRunRoot, COMPLETION_DRAFT_FILE_NAME), "Completion draft"),
  );
  const runtimeBundlePath = path.join(REPO_ROOT, RUNTIME_BUNDLE_PATH);
  const runtimeBytes = await requirePlainFile(runtimeBundlePath, "Codex runtime bundle");
  if (evidence?.freeze?.activeRuntime?.bundleDigest !== sha256(runtimeBytes)) {
    throw new Error("Completion evidence does not bind the exact active runtime bundle bytes.");
  }
  const runtime = await import(`${pathToFileURL(runtimeBundlePath).href}?digest=${encodeURIComponent(sha256(runtimeBytes))}`);
  if (typeof runtime.createExp0001aCodexCompletionAttestation !== "function") {
    throw new Error("Active runtime bundle lacks the completion-evidence verifier.");
  }
  const expected = runtime.createExp0001aCodexCompletionAttestation(evidence);
  await verifyExp0001aOuterExecutionSourceCommitments({
    freeze: evidence.freeze,
    repositoryRoot: REPO_ROOT,
  });
  if (canonicalJson(expected) !== canonicalJson(candidate)) {
    throw new Error("Completion draft differs from the active runtime's exact evidence reconstruction.");
  }
  if (input.approvedCompletionDigest !== candidate.completionDigest) {
    throw new Error("Explicitly approved completion digest does not match the exact reconstructed candidate.");
  }
  const outputPath = path.join(realRunRoot, COMPLETION_ATTESTATION_FILE_NAME);
  const publicAuthority = await loadFixedCompletionPublicAuthority();
  const verification = {
    draft: candidate,
    publicKeyBytes: publicAuthority.publicKeyBytes,
    expectedPublicKeyDigest: FIXED_COMPLETION_PUBLIC_KEY_DIGEST,
    expectedKeyId: FIXED_COMPLETION_KEY_ID,
  };
  const priorAttestation = await loadRetainedCompletionAttestation(outputPath, verification);
  if (priorAttestation !== null) {
    return Object.freeze({ outputPath, completionDigest: candidate.completionDigest,
      signaturePayloadDigest: priorAttestation.authoritySignature.payloadDigest });
  }
  // Only load the private key and mint signedAt after proving that no exact
  // valid prior publication exists. Replay therefore preserves the original
  // authority timestamp and signature bytes.
  const authority = await loadFixedCompletionAuthority();
  const attestation = createExp0001aCompletionSignature({
    draft: candidate,
    privateKeyBytes: authority.privateKeyBytes,
    publicKeyBytes: authority.publicKeyBytes,
    expectedPublicKeyDigest: FIXED_COMPLETION_PUBLIC_KEY_DIGEST,
    expectedKeyId: FIXED_COMPLETION_KEY_ID,
    signedAt: new Date().toISOString(),
  });
  const publication = await publishExp0001aCompletionAttestation({
    outputPath,
    draft: candidate,
    attestation,
    publicKeyBytes: authority.publicKeyBytes,
    expectedPublicKeyDigest: FIXED_COMPLETION_PUBLIC_KEY_DIGEST,
    expectedKeyId: FIXED_COMPLETION_KEY_ID,
  });
  return Object.freeze({ outputPath, completionDigest: candidate.completionDigest,
    signaturePayloadDigest: publication.attestation.authoritySignature.payloadDigest });
}

async function main() {
  const args = parseExp0001aCompletionSignerArgs(process.argv.slice(2));
  const result = args.mode === "check-readiness"
    ? await checkExp0001aCompletionSignerReadiness()
    : await signExp0001aCompletionRun(args);
  process.stdout.write(`${canonicalJson(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
