#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EXP0001A_RUNTIME_OUTPUT,
} from "./build-exp0001a-runtime.mjs";
import {
  verifyRetainedExp0001aCodexFreezeArtifacts,
} from "./generate-exp0001a-codex-freeze.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");

export const EXP0001A_CODEX_PREBRIEF_FREEZE_PATH =
  "research/data/exp-0001a-codex-prebrief-freeze-v2.json";
export const EXP0001A_CODEX_PREBRIEF_FREEZE_SIGNATURE_PATH =
  "research/data/exp0001a-codex-prebrief-freeze-signature-v2.json";
export const EXP0001A_CODEX_PREBRIEF_PRIVATE_KEY_PATH =
  ".research-private/exp0001a-authority-private.pem";
export const EXP0001A_CODEX_PREBRIEF_PUBLIC_KEY_PATH =
  "research/data/exp0001a-execution-authority-public.pem";
export const EXP0001A_CODEX_PREBRIEF_PUBLIC_KEY_DIGEST =
  "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de";
export const EXP0001A_CODEX_PREBRIEF_KEY_ID = "exp0001a-launch-authority-2026-08-30";
export const EXP0001A_CODEX_PREBRIEF_SIGNATURE_DOMAIN =
  "Jazzboard EXP-0001A Codex authority v1\0";

const PRIVATE_KEY_PATH = path.join(REPOSITORY_ROOT, EXP0001A_CODEX_PREBRIEF_PRIVATE_KEY_PATH);
const PUBLIC_KEY_PATH = path.join(REPOSITORY_ROOT, EXP0001A_CODEX_PREBRIEF_PUBLIC_KEY_PATH);
const FREEZE_PATH = path.join(REPOSITORY_ROOT, EXP0001A_CODEX_PREBRIEF_FREEZE_PATH);
const SIGNATURE_PATH = path.join(REPOSITORY_ROOT, EXP0001A_CODEX_PREBRIEF_FREEZE_SIGNATURE_PATH);
const RELEASE_EVIDENCE_INVENTORY = Object.freeze([
  Object.freeze({ root: path.join(REPOSITORY_ROOT, "research/results/runs"), mode: "protocol_marker" }),
  Object.freeze({ root: path.join(REPOSITORY_ROOT, ".research-private"), mode: "private_inventory" }),
]);
const ALLOWED_SPIKE_PREREQUISITE_FILES = new Set([
  "aa-execution-gate.draft.json", "aa-execution-gate.json", "aa-execution-gate.signed.json",
  "auth-preflight.json", "pre-spike-auth.json", "authoritative-recovery-raw.json",
  "authoritative-recovery.png", "isolation-attestation.json", "platform-bootstrap-trace.json",
  "prompt-envelope.json", "room-creation-receipt.json", "room-provisioning-plan.json",
  "room-provisioning-raw.json", "semantic-state.json", "spike-evidence.sealed.json",
  "spike-final.png", "spike-full-viewport.png", "spike-input.json", "task-creation-call-result.json",
  "task-creation-receipt.json", "task-provisioning-plan.json", "task-read-thread-call-result.json",
  "task-read-thread-raw.json", "terminal-result.txt", "webmcp-trace.json",
]);

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isAllowedSpikeRejectionPrerequisite(relativePath, bytes) {
  const match = /^exp0001a-spike-rejections\/v([1-9][0-9]*)(-reclassification)?\.json$/.exec(relativePath);
  if (match === null || !(bytes instanceof Uint8Array)) return false;
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return false; }
  const spikeVersion = Number(match[1]);
  const common = value?.schemaVersion === 1 && value.spikeVersion === spikeVersion
    && typeof value.taskId === "string" && /^[a-f0-9-]{36}$/.test(value.taskId)
    && typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 2_000;
  if (!common) return false;
  if (match[2] === "-reclassification") {
    return hasExactKeys(value, [
      "schemaVersion", "kind", "spikeVersion", "taskId", "priorDecision",
      "reclassifiedDecision", "reason", "reclassifiedAt",
    ])
      && value.kind === "disposable-codex-webmcp-spike-gate-reclassification"
      && value.priorDecision === "failed_evidence_gate"
      && value.reclassifiedDecision === "eligible_for_reconstruction"
      && typeof value.reclassifiedAt === "string" && Number.isFinite(Date.parse(value.reclassifiedAt));
  }
  return hasExactKeys(value, [
    "schemaVersion", "kind", "spikeVersion", "taskId", "roomIdentityDigest",
    "terminalOutcome", "reason", "begunAt", "terminalAt", "retainedEvidenceDirectory",
  ])
    && value.kind === "disposable-codex-webmcp-spike-rejection"
    && /^sha256:[a-f0-9]{64}$/.test(value.roomIdentityDigest)
    && ["failed", "failed_evidence_gate", "infra_failure"].includes(value.terminalOutcome)
    && Number.isSafeInteger(value.begunAt) && Number.isSafeInteger(value.terminalAt)
    && value.terminalAt >= value.begunAt
    && value.retainedEvidenceDirectory === `../exp0001a-codex-spike-v${spikeVersion}`;
}

function isAllowedPrivatePrerequisite(relativePath, directory, bytes = null) {
  if (relativePath === "exp0001a-authority-private.pem") return true;
  const parts = relativePath.split("/");
  const spikeDirectory = /^exp0001a-codex-spike(?:-v[0-9]+)?$/.test(parts[0] ?? "");
  return (spikeDirectory && (directory || (parts.length === 2 && ALLOWED_SPIKE_PREREQUISITE_FILES.has(parts[1]))))
    || (!directory && isAllowedSpikeRejectionPrerequisite(relativePath, bytes));
}

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

export function canonicalPrebriefFreezeJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalPrebriefFreezeJson(value), "utf8"));
}

async function readPlainFile(filePath, label, requiredMode = null) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a singly linked plain file.`);
  }
  if (requiredMode !== null && (metadata.mode & 0o777) !== requiredMode) {
    throw new Error(`${label} must have mode ${requiredMode.toString(8)}.`);
  }
  if (requiredMode !== null && typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function readPlainJson(filePath, label) {
  const bytes = await readPlainFile(filePath, label);
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is not valid JSON.`); }
}

function signatureContent(freeze, signedAt) {
  return Object.freeze({
    schemaVersion: "exp-0001a-codex-authority-signature/v1",
    protocolId: "EXP-0001A",
    kind: "codex-authority-signature",
    algorithm: "Ed25519",
    keyId: EXP0001A_CODEX_PREBRIEF_KEY_ID,
    publicKeyDigest: EXP0001A_CODEX_PREBRIEF_PUBLIC_KEY_DIGEST,
    signedAt,
    purpose: "prebrief_freeze",
    payloadDigest: sha256Canonical(freeze),
  });
}

function signatureMessage(content) {
  return Buffer.from(
    `${EXP0001A_CODEX_PREBRIEF_SIGNATURE_DOMAIN}${canonicalPrebriefFreezeJson(content)}`,
    "utf8",
  );
}

/** Pure cryptographic seam for ephemeral-key tests. It cannot replace the
 * production wrapper's fixed key, exact paths, actual clock, or no-release scan. */
export function createExp0001aPrebriefFreezeSignatureForTesting(input) {
  const content = signatureContent(input.freeze, input.signedAt);
  const signature = signEd25519(null, signatureMessage(content), input.authority.privateKey);
  if (signature.length !== 64
      || !verifyEd25519(null, signatureMessage(content), input.authority.publicKey, signature)) {
    throw new Error("Prebrief freeze signature failed immediate public-key verification.");
  }
  return Object.freeze({ ...content, signatureBase64: signature.toString("base64") });
}

async function loadFixedAuthority() {
  const [privatePath, publicPath] = await Promise.all([realpath(PRIVATE_KEY_PATH), realpath(PUBLIC_KEY_PATH)]);
  if (privatePath !== PRIVATE_KEY_PATH || publicPath !== PUBLIC_KEY_PATH) {
    throw new Error("Prebrief freeze authority paths must be canonical and non-symlinked.");
  }
  const [privateBytes, publicBytes] = await Promise.all([
    readPlainFile(privatePath, "Prebrief freeze authority private key", 0o600),
    readPlainFile(publicPath, "Prebrief freeze authority public key"),
  ]);
  if (sha256Bytes(publicBytes) !== EXP0001A_CODEX_PREBRIEF_PUBLIC_KEY_DIGEST) {
    throw new Error("Prebrief freeze public key differs from the fixed trust anchor.");
  }
  const privateKey = createPrivateKey(privateBytes);
  const publicKey = createPublicKey(publicBytes);
  const derivedPublic = createPublicKey(privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519"
      || !Buffer.from(publicKey.export({ type: "spki", format: "der" }))
        .equals(Buffer.from(derivedPublic.export({ type: "spki", format: "der" })))) {
    throw new Error("Prebrief freeze private key does not match the fixed Ed25519 public key.");
  }
  return { privateKey, publicKey };
}

function containsExp0001aEvidenceMarker(relativePath, bytes) {
  if (/(?:^|[/_.-])exp[-_]?0001a(?:[/_.-]|$)/i.test(relativePath)) return true;
  if (bytes.length === 0) return false;
  // Do not sample. A protocol marker after a large image or trace prefix is
  // still release evidence and must stop immutable-freeze signing.
  const text = bytes.toString("utf8");
  return /"protocolId"\s*:\s*"EXP-0001A"|exp-0001a-(?:codex|coordinator|authority|scheduler|review|completion|accounting)/i.test(text);
}

/** Full no-release inventory. Dedicated private run state fails on any entry;
 * the shared public results root fails on any path/content carrying the exact
 * protocol marker. Spike inputs and the fixed authority key are prerequisites,
 * not A/A release evidence, and are the only private exceptions. */
export async function assertNoExp0001aReleaseEvidenceForTesting(inventory) {
  for (const descriptor of inventory) {
    const root = path.normalize(descriptor.root);
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop();
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        const relativePath = path.relative(root, candidate).split(path.sep).join("/");
        if (entry.isSymbolicLink()) {
          throw new Error(`EXP0001A_PREBRIEF_FREEZE_REFUSES_UNTRUSTED_INVENTORY_ENTRY:${relativePath}`);
        }
        if (entry.isDirectory()) {
          if (descriptor.mode === "private_inventory" && isAllowedPrivatePrerequisite(relativePath, true)) {
            pending.push(candidate);
            continue;
          }
          pending.push(candidate);
          continue;
        }
        if (!entry.isFile()) {
          throw new Error(`EXP0001A_PREBRIEF_FREEZE_REFUSES_UNTRUSTED_INVENTORY_ENTRY:${relativePath}`);
        }
        const bytes = await readPlainFile(candidate, `Release evidence inventory ${relativePath}`);
        const releaseEvidence = descriptor.mode === "private_inventory"
          ? !isAllowedPrivatePrerequisite(relativePath, false, bytes)
          : containsExp0001aEvidenceMarker(relativePath, bytes);
        if (releaseEvidence) {
          throw new Error(`EXP0001A_PREBRIEF_FREEZE_REFUSES_EXISTING_RELEASE_EVIDENCE:${relativePath}`);
        }
      }
    }
  }
}

async function assertNoExp0001aReleaseEvidence() {
  await assertNoExp0001aReleaseEvidenceForTesting(RELEASE_EVIDENCE_INVENTORY);
}

async function retainExclusivePublicSignature(value) {
  const bytes = Buffer.from(`${canonicalPrebriefFreezeJson(value)}\n`, "utf8");
  const handle = await open(
    SIGNATURE_PATH,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const directory = await open(path.dirname(SIGNATURE_PATH), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  const readback = await readPlainFile(SIGNATURE_PATH, "Signed prebrief freeze authority");
  if (!readback.equals(bytes)) throw new Error("Signed prebrief freeze readback differs from retained bytes.");
}

export function parseExp0001aPrebriefFreezeSignerArgs(argv) {
  if (argv.length !== 1 || !["--sign", "--check-readiness"].includes(argv[0])) {
    throw new Error("Usage: sign-exp0001a-codex-prebrief-freeze.mjs --sign | --check-readiness");
  }
  return Object.freeze({ mode: argv[0] === "--sign" ? "sign" : "check-readiness" });
}

async function loadVerifiedRuntimeAndFreeze() {
  const deterministic = await verifyRetainedExp0001aCodexFreezeArtifacts({ verifySignature: false });
  const verifiedBundle = Object.freeze({
    bundleDigest: deterministic.runtimeBundleDigest,
    bytes: deterministic.runtimeBytes,
  });
  const runtimePath = path.join(REPOSITORY_ROOT, EXP0001A_RUNTIME_OUTPUT);
  const runtime = await import(
    `${pathToFileURL(runtimePath).href}?digest=${encodeURIComponent(verifiedBundle.bundleDigest)}`
  );
  const freeze = runtime.verifyExp0001aCodexPrebriefFreeze(await readPlainJson(
    FREEZE_PATH,
    "Codex-native prebrief freeze",
  ));
  if (freeze.activeRuntime.bundleDigest !== verifiedBundle.bundleDigest) {
    throw new Error("Prebrief freeze runtime bundle differs from the exact built runtime.");
  }
  return { runtime, freeze, verifiedBundle };
}

export async function checkExp0001aPrebriefFreezeSignerReadiness() {
  await assertNoExp0001aReleaseEvidence();
  const { freeze, verifiedBundle } = await loadVerifiedRuntimeAndFreeze();
  await loadFixedAuthority();
  return Object.freeze({
    schemaVersion: "exp-0001a-prebrief-freeze-signer-readiness/v1",
    protocolId: "EXP-0001A",
    decision: "ready_to_sign_immutable_no_brief_freeze",
    freezeDigest: freeze.freezeDigest,
    runtimeBundleDigest: verifiedBundle.bundleDigest,
    payloadDigest: sha256Canonical(freeze),
    evidenceState: "no_release_or_task_evidence_found",
  });
}

export async function signExp0001aCodexPrebriefFreeze() {
  await assertNoExp0001aReleaseEvidence();
  const { runtime, freeze } = await loadVerifiedRuntimeAndFreeze();
  const signedAt = new Date().toISOString();
  if (Date.parse(signedAt) < Date.parse(freeze.frozenAt)) {
    throw new Error("Prebrief freeze signature cannot predate the frozen evidence.");
  }
  const authority = await loadFixedAuthority();
  const signature = runtime.exp0001aCodexAuthoritySignatureSchema.parse(
    createExp0001aPrebriefFreezeSignatureForTesting({ freeze, signedAt, authority }),
  );
  runtime.verifyExp0001aCodexPrebriefFreezeAuthority({ freeze, authoritySignature: signature, verifiedAt: signedAt });
  await retainExclusivePublicSignature(signature);
  return Object.freeze({
    schemaVersion: "exp-0001a-prebrief-freeze-sign-result/v1",
    protocolId: "EXP-0001A",
    freezeDigest: freeze.freezeDigest,
    payloadDigest: signature.payloadDigest,
    signedAt: signature.signedAt,
    purpose: signature.purpose,
    signaturePath: EXP0001A_CODEX_PREBRIEF_FREEZE_SIGNATURE_PATH,
  });
}

export async function runExp0001aPrebriefFreezeSignerCli(argv = process.argv.slice(2), io = {
  stdout: process.stdout,
  stderr: process.stderr,
}) {
  try {
    const { mode } = parseExp0001aPrebriefFreezeSignerArgs(argv);
    const result = mode === "sign"
      ? await signExp0001aCodexPrebriefFreeze()
      : await checkExp0001aPrebriefFreezeSignerReadiness();
    io.stdout.write(`${canonicalPrebriefFreezeJson(result)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${canonicalPrebriefFreezeJson({
      status: "error",
      errorCode: "PREBRIEF_FREEZE_SIGNING_FAILED",
      message: error instanceof Error ? error.message : "Unknown failure",
    })}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = await runExp0001aPrebriefFreezeSignerCli();
}
