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
import { lstat, open, realpath, rename } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EXP0001A_RUNTIME_OUTPUT,
  verifyExp0001aRuntimeBundle,
} from "./build-exp0001a-runtime.mjs";
import { appendExp0001aAuthorityJournalEntry } from "./exp0001a-authority-journal.mjs";
import { verifyExp0001aOuterExecutionSourceCommitments } from "./exp0001a-outer-source-verifier.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const AUTHORITY_PRIVATE_KEY_PATH = path.join(
  REPOSITORY_ROOT,
  ".research-private",
  "exp0001a-authority-private.pem",
);
const AUTHORITY_PUBLIC_KEY_PATH = path.join(
  REPOSITORY_ROOT,
  "research",
  "data",
  "exp0001a-execution-authority-public.pem",
);
const AUTHORITY_PUBLIC_KEY_DIGEST =
  "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de";
const AUTHORITY_KEY_ID = "exp0001a-launch-authority-2026-08-30";
const AUTHORITY_DOMAIN = "Jazzboard EXP-0001A Codex authority v1\0";

function canonicalize(value, at = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${at}.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${at}/${index}`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Only plain JSON objects are supported at ${at}.`);
    }
    const output = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new TypeError(`Non-JSON value at ${at}/${key}.`);
      }
      output[key] = canonicalize(item, `${at}/${key}`);
    }
    return output;
  }
  throw new TypeError(`Non-JSON value at ${at}.`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

async function readPlainFile(filePath, label, requiredMode = null) {
  const canonicalPath = path.normalize(filePath);
  if (!path.isAbsolute(canonicalPath) || canonicalPath === path.parse(canonicalPath).root) {
    throw new Error(`${label} path must be absolute, normalized, and non-root.`);
  }
  const metadata = await lstat(canonicalPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a singly linked plain file.`);
  }
  if (requiredMode !== null && (metadata.mode & 0o777) !== requiredMode) {
    throw new Error(`${label} must have mode ${requiredMode.toString(8)}.`);
  }
  if (requiredMode !== null && typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
  const handle = await open(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readPlainJson(filePath, label) {
  const bytes = await readPlainFile(filePath, label);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  return value;
}

async function loadAuthority() {
  const [privatePath, publicPath] = await Promise.all([
    realpath(AUTHORITY_PRIVATE_KEY_PATH),
    realpath(AUTHORITY_PUBLIC_KEY_PATH),
  ]);
  if (privatePath !== AUTHORITY_PRIVATE_KEY_PATH || publicPath !== AUTHORITY_PUBLIC_KEY_PATH) {
    throw new Error("Coordinator authority paths must be canonical and non-symlinked.");
  }
  const [privateBytes, publicBytes] = await Promise.all([
    readPlainFile(privatePath, "Coordinator authority private key", 0o600),
    readPlainFile(publicPath, "Coordinator authority public key"),
  ]);
  if (sha256Bytes(publicBytes) !== AUTHORITY_PUBLIC_KEY_DIGEST) {
    throw new Error("Coordinator authority public key differs from the precommitted trust anchor.");
  }
  const privateKey = createPrivateKey(privateBytes);
  const publicKey = createPublicKey(publicBytes);
  const derivedPublic = createPublicKey(privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519"
      || !Buffer.from(publicKey.export({ type: "spki", format: "der" }))
        .equals(Buffer.from(derivedPublic.export({ type: "spki", format: "der" })))) {
    throw new Error("Coordinator authority private key does not match the fixed Ed25519 public key.");
  }
  return { privateKey, publicKey };
}

export function createExp0001aCoordinatorCheckpointSignatureForTesting(input) {
  const { draft, signedAt, authority } = input;
  const content = {
    schemaVersion: "exp-0001a-codex-authority-signature/v1",
    protocolId: "EXP-0001A",
    kind: "codex-authority-signature",
    algorithm: "Ed25519",
    keyId: AUTHORITY_KEY_ID,
    publicKeyDigest: AUTHORITY_PUBLIC_KEY_DIGEST,
    signedAt,
    purpose: "coordinator_checkpoint",
    payloadDigest: sha256Canonical(draft),
  };
  const message = Buffer.from(`${AUTHORITY_DOMAIN}${canonicalJson(content)}`, "utf8");
  const signature = signEd25519(null, message, authority.privateKey);
  if (signature.length !== 64 || !verifyEd25519(null, message, authority.publicKey, signature)) {
    throw new Error("Coordinator checkpoint signature failed immediate public-key verification.");
  }
  return Object.freeze({ ...content, signatureBase64: signature.toString("base64") });
}

async function retainAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  const existing = await lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1
      || (existing.mode & 0o777) !== 0o600)) {
    throw new Error("Existing coordinator checkpoint is not a private singly linked plain file.");
  }
  const temporaryPath = path.join(directory, `.coordinator-checkpoint-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
  const parent = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
  const readback = await readPlainFile(filePath, "Coordinator checkpoint readback", 0o600);
  if (!readback.equals(bytes)) throw new Error("Coordinator checkpoint readback differs from retained bytes.");
}

export function parseExp0001aCoordinatorCheckpointSignerArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--config" || typeof argv[1] !== "string"
      || !path.isAbsolute(argv[1]) || path.normalize(argv[1]) !== argv[1]
      || argv[1] === path.parse(argv[1]).root) {
    throw new Error("Usage: sign-exp0001a-coordinator-checkpoint.mjs --config /absolute/path/to/config.json");
  }
  return Object.freeze({ configPath: argv[1] });
}

async function signExp0001aCoordinatorCheckpointWithFixedAuthority(input) {
  const verifiedBundle = await verifyExp0001aRuntimeBundle();
  const runtimePath = path.join(REPOSITORY_ROOT, EXP0001A_RUNTIME_OUTPUT);
  const runtime = await import(
    `${pathToFileURL(runtimePath).href}?digest=${encodeURIComponent(verifiedBundle.bundleDigest)}`
  );
  const rawConfig = await readPlainJson(input.configPath, "Coordinator runtime config");
  const config = runtime.exp0001aCodexRuntimeConfigSchema.parse(rawConfig);
  if (config.files.codexPrebriefFreeze !== path.join(
    REPOSITORY_ROOT, "research/data/exp-0001a-codex-prebrief-freeze-v2.json",
  ) || config.files.codexPrebriefFreezeSignature !== path.join(
    REPOSITORY_ROOT, "research/data/exp0001a-codex-prebrief-freeze-signature-v2.json",
  )) {
    throw new Error("Coordinator signer requires the exact committed immutable Codex prebrief freeze authority files.");
  }
  if (config.runtimeBundleDigest !== verifiedBundle.bundleDigest) {
    throw new Error("Coordinator signer runtime bundle differs from config.");
  }
  const [freeze, freezeAuthoritySignature, spikeGate, spikeEvidence, scheduler, accountingLedger, provisioningState, coordinatorJournal] =
    await Promise.all([
      readPlainJson(config.files.codexPrebriefFreeze, "Codex prebrief freeze"),
      readPlainJson(config.files.codexPrebriefFreezeSignature, "Codex prebrief freeze authority signature"),
      readPlainJson(config.files.spikeGate, "Signed spike gate"),
      readPlainJson(config.files.spikeEvidence, "Spike evidence"),
      readPlainJson(config.files.schedulerState, "Scheduler state"),
      readPlainJson(config.files.accountingLedger, "Accounting ledger"),
      readPlainJson(config.files.provisioningCoordinatorState, "Provisioning coordinator state"),
      readPlainJson(config.files.coordinatorJournal, "Coordinator journal"),
    ]);
  const recordedAt = new Date().toISOString();
  const authorizedFreeze = runtime.verifyExp0001aCodexPrebriefFreezeAuthority({
    freeze,
    authoritySignature: freezeAuthoritySignature,
    verifiedAt: recordedAt,
  });
  await verifyExp0001aOuterExecutionSourceCommitments({
    freeze: authorizedFreeze,
    repositoryRoot: REPOSITORY_ROOT,
  });
  const draft = runtime.createExp0001aCodexCoordinatorCheckpointDraft({
    checkpointId: `checkpoint-${randomUUID()}`,
    recordedAt,
    runtimeBundleDigest: verifiedBundle.bundleDigest,
    authorizedPrebriefFreezePayloadDigest: config.authorizedPrebriefFreezePayloadDigest,
    authorizedPrebriefFreezeSignatureDigest: config.authorizedPrebriefFreezeSignatureDigest,
    freeze,
    freezeAuthoritySignature,
    spikeGate,
    spikeEvidence,
    scheduler,
    accountingLedger,
    provisioningState,
    coordinatorJournal,
  });
  const signedAt = new Date().toISOString();
  if (Date.parse(signedAt) < Date.parse(draft.recordedAt) || Date.parse(signedAt) > Date.parse(draft.expiresAt)) {
    throw new Error("Coordinator checkpoint signature time is outside its fixed validity window.");
  }
  const authority = await loadAuthority();
  const checkpoint = runtime.exp0001aCodexCoordinatorCheckpointSchema.parse({
    ...draft,
    authoritySignature: createExp0001aCoordinatorCheckpointSignatureForTesting({ draft, signedAt, authority }),
  });
  runtime.verifyExp0001aCodexAuthoritySignature({
    payload: draft,
    signature: checkpoint.authoritySignature,
    purpose: "coordinator_checkpoint",
    notBefore: draft.recordedAt,
  });
  const authorityJournal = await appendExp0001aAuthorityJournalEntry({
    outputRoot: config.outputRoot,
    kind: "coordinator_checkpoint",
    recordedAt: checkpoint.authoritySignature.signedAt,
    payload: checkpoint,
  });
  await retainAtomic(config.files.coordinatorCheckpoint, checkpoint);
  return Object.freeze({
    schemaVersion: "exp-0001a-coordinator-checkpoint-sign-result/v1",
    protocolId: "EXP-0001A",
    checkpointId: checkpoint.checkpointId,
    checkpointDigest: sha256Canonical(checkpoint),
    recordedAt: checkpoint.recordedAt,
    expiresAt: checkpoint.expiresAt,
    authorizedActionDigest: checkpoint.authorizedActionDigest,
    authorityPurpose: checkpoint.authoritySignature.purpose,
    authorityJournalEntryDigest: authorityJournal.entry.entryDigest,
    authorityJournalRoot: authorityJournal.journalRoot,
  });
}

/** Production checkpoint signing always uses the actual wall clock, fixed
 * ignored private key, deterministic runtime verifier, and append-only journal.
 * No dependency or time injection is accepted at this authority boundary. */
export async function signExp0001aCoordinatorCheckpointFromConfig(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).sort().join("\0") !== "configPath"
      || typeof input.configPath !== "string") {
    throw new Error("Coordinator checkpoint signer accepts only an exact config path.");
  }
  return signExp0001aCoordinatorCheckpointWithFixedAuthority({ configPath: input.configPath });
}

export async function runExp0001aCoordinatorCheckpointSignerCli(argv = process.argv.slice(2), io = {
  stdout: process.stdout,
  stderr: process.stderr,
}) {
  try {
    const args = parseExp0001aCoordinatorCheckpointSignerArgs(argv);
    const result = await signExp0001aCoordinatorCheckpointFromConfig(args);
    io.stdout.write(`${canonicalJson(result)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${canonicalJson({
      status: "error",
      errorCode: "COORDINATOR_CHECKPOINT_SIGNING_FAILED",
      message: error instanceof Error ? error.message : "Unknown failure",
    })}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = await runExp0001aCoordinatorCheckpointSignerCli();
}
