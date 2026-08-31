#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import {
  runCodexAuthPreflight,
  verifyCodexAuthPreflightReceipt,
} from "./codex-auth-preflight.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const PRIVATE_ROOT = path.join(REPOSITORY_ROOT, ".research-private");
const SPIKE_ROOT = path.join(PRIVATE_ROOT, "exp0001a-codex-spike-v10");
const ENTRY_PATH = path.join(REPOSITORY_ROOT, "src/lib/research/codex-webmcp-spike-recovery.ts");
const OUTPUT_PATH = path.join(
  REPOSITORY_ROOT,
  "research/data/exp0001a-codex-webmcp-spike-gate-public-v2.json",
);
const EVIDENCE_OUTPUT_PATH = path.join(
  REPOSITORY_ROOT,
  "research/data/exp0001a-codex-webmcp-spike-public-v2.json",
);
const AUTHORITY_PRIVATE_KEY_PATH = path.join(PRIVATE_ROOT, "exp0001a-authority-private.pem");
const AUTHORITY_PUBLIC_KEY_PATH = path.join(
  REPOSITORY_ROOT,
  "research/data/exp0001a-execution-authority-public.pem",
);
const AUTHORITY_PUBLIC_KEY_DIGEST =
  "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de";
const AUTHORITY_KEY_ID = "exp0001a-launch-authority-2026-08-30";
const AUTHORITY_DOMAIN = "Jazzboard EXP-0001A Codex authority v1\0";
const MAX_JSON_BYTES = 16 * 1024 * 1024;

const INPUT_PATHS = Object.freeze({
  preSpikeAuthEvidence: path.join(SPIKE_ROOT, "pre-spike-auth.json"),
  roomProvisioningPlan: path.join(SPIKE_ROOT, "room-provisioning-plan.json"),
  roomProvisioningReceipt: path.join(SPIKE_ROOT, "room-provisioning-raw.json"),
  taskProvisioningPlan: path.join(SPIKE_ROOT, "task-provisioning-plan.json"),
  taskCreationCallResult: path.join(SPIKE_ROOT, "task-creation-call-result.json"),
  rawTaskCallResult: path.join(SPIKE_ROOT, "task-read-thread-call-result.json"),
  authoritativeJazzboardRecovery: path.join(SPIKE_ROOT, "authoritative-recovery-raw.json"),
});

function canonicalize(value, at = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${at}.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${at}/${index}`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Non-plain object at ${at}.`);
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key], `${at}/${key}`);
    return output;
  }
  throw new TypeError(`Non-JSON value at ${at}.`);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Canonical(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

async function readPlainFile(filePath, label, maximumBytes, requiredMode = null) {
  const canonical = await realpath(filePath).catch((error) => {
    throw new Error(`${label} does not exist.`, { cause: error });
  });
  if (canonical !== filePath) throw new Error(`${label} path is not canonical.`);
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
  if (metadata.size > maximumBytes) throw new Error(`${label} exceeds its byte limit.`);
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function readPrivateJson(filePath, label) {
  const bytes = await readPlainFile(filePath, label, MAX_JSON_BYTES, 0o600);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  return { bytes, value };
}

function parseSingleTextCallResult(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.isError !== false || !Array.isArray(value.content) || value.content.length !== 1
      || value.content[0]?.type !== "text" || typeof value.content[0]?.text !== "string") {
    throw new Error(`${label} is not one exact successful text CallToolResult.`);
  }
  try { return JSON.parse(value.content[0].text); } catch (error) {
    throw new Error(`${label} text is not exact JSON.`, { cause: error });
  }
}

let runtimePromise;
async function loadRuntime() {
  runtimePromise ??= build({
    absWorkingDir: REPOSITORY_ROOT,
    entryPoints: [ENTRY_PATH],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node22"],
    write: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  }).then((result) => {
    if (result.outputFiles?.length !== 1) throw new Error("SPIKE_RECOVERY_RUNTIME_BUILD_FAILED");
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
  });
  return runtimePromise;
}

async function loadFixedAuthority() {
  const [privateBytes, publicBytes] = await Promise.all([
    readPlainFile(AUTHORITY_PRIVATE_KEY_PATH, "Spike authority private key", 64 * 1024, 0o600),
    readPlainFile(AUTHORITY_PUBLIC_KEY_PATH, "Spike authority public key", 64 * 1024),
  ]);
  if (sha256(publicBytes) !== AUTHORITY_PUBLIC_KEY_DIGEST) throw new Error("Spike public key differs from its trust anchor.");
  const privateKey = createPrivateKey(privateBytes);
  const publicKey = createPublicKey(publicBytes);
  const derived = createPublicKey(privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519"
      || !Buffer.from(publicKey.export({ type: "spki", format: "der" }))
        .equals(Buffer.from(derived.export({ type: "spki", format: "der" })))) {
    throw new Error("Spike authority private key does not match its fixed public key.");
  }
  return { privateKey, publicKey };
}

function authoritySignatureContent(draft, signedAt) {
  return Object.freeze({
    schemaVersion: "exp-0001a-codex-authority-signature/v1",
    protocolId: "EXP-0001A",
    kind: "codex-authority-signature",
    algorithm: "Ed25519",
    keyId: AUTHORITY_KEY_ID,
    publicKeyDigest: AUTHORITY_PUBLIC_KEY_DIGEST,
    signedAt,
    purpose: "spike_gate",
    payloadDigest: sha256Canonical(draft),
  });
}

function signatureMessage(content) {
  return Buffer.from(`${AUTHORITY_DOMAIN}${canonicalJson(content)}`, "utf8");
}

async function assertNoExperimentReleaseEvidence() {
  const privateRuns = path.join(PRIVATE_ROOT, "exp0001a-runs");
  const privateEntries = await readdir(privateRuns).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  if (privateEntries.length > 0) throw new Error("Spike gate refuses existing private EXP-0001A run evidence.");

  const publicRuns = path.join(REPOSITORY_ROOT, "research/results/runs");
  const pending = [publicRuns];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(directory, entry.name);
      const bytes = await readPlainFile(filePath, "Public run evidence", MAX_JSON_BYTES);
      try {
        const value = JSON.parse(bytes.toString("utf8"));
        if (value?.protocolId === "EXP-0001A" || value?.experimentId === "EXP-0001A") {
          throw new Error("Spike gate refuses existing public EXP-0001A run evidence.");
        }
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error("Public run evidence is malformed JSON.", { cause: error });
        throw error;
      }
    }
  }
}

async function loadRecoveryInput(evaluatedAt, signingAuthReceipt) {
  const [
    preAuth,
    roomPlan,
    roomReceipt,
    taskPlan,
    taskCreation,
    taskRead,
    recovery,
  ] = await Promise.all([
    readPrivateJson(INPUT_PATHS.preSpikeAuthEvidence, "Pre-spike auth receipt"),
    readPrivateJson(INPUT_PATHS.roomProvisioningPlan, "Room provisioning plan"),
    readPrivateJson(INPUT_PATHS.roomProvisioningReceipt, "Raw create_room result"),
    readPrivateJson(INPUT_PATHS.taskProvisioningPlan, "Task provisioning plan"),
    readPrivateJson(INPUT_PATHS.taskCreationCallResult, "Raw create_thread result"),
    readPrivateJson(INPUT_PATHS.rawTaskCallResult, "Raw read_thread result"),
    readPrivateJson(INPUT_PATHS.authoritativeJazzboardRecovery, "Raw Jazzboard recovery"),
  ]);
  const rawTaskRecord = parseSingleTextCallResult(taskRead.value, "Raw read_thread result");
  return {
    evaluatedAt,
    preSpikeAuthEvidence: preAuth.value,
    signingAuthReceipt,
    roomProvisioningPlan: roomPlan.value,
    roomProvisioningReceipt: roomReceipt.value,
    taskProvisioningPlan: taskPlan.value,
    taskCreationCallResult: taskCreation.value,
    rawTaskRecord,
    authoritativeJazzboardRecovery: recovery.value,
    rawDigests: {
      preSpikeAuthReceiptDigest: sha256(preAuth.bytes),
      roomProvisioningPlanDigest: sha256(roomPlan.bytes),
      roomProvisioningReceiptDigest: sha256(roomReceipt.bytes),
      taskProvisioningPlanDigest: sha256(taskPlan.bytes),
      taskCreationCallResultDigest: sha256(taskCreation.bytes),
      rawTaskRecordDigest: sha256(taskRead.bytes),
      authoritativeJazzboardRecoveryDigest: sha256(recovery.bytes),
    },
  };
}

async function deriveVerifiedDraft() {
  await assertNoExperimentReleaseEvidence();
  const authReceipt = verifyCodexAuthPreflightReceipt(await runCodexAuthPreflight());
  if (authReceipt.authentication.method !== "chatgpt"
      || authReceipt.decision.allowCodexNativeExperiment !== true) {
    throw new Error("EXP0001A_REQUIRES_CHATGPT_AUTHENTICATED_CODEX");
  }
  const evaluatedAt = new Date().toISOString();
  const runtime = await loadRuntime();
  const draft = runtime.createExp0001aCodexSpikeRecoveryGateDraft(
    await loadRecoveryInput(evaluatedAt, authReceipt),
  );
  if (Date.now() - Date.parse(evaluatedAt) > 30_000) {
    throw new Error("Spike recovery reconstruction exceeded its trusted signing window.");
  }
  return { authReceipt, draft, evaluatedAt, runtime };
}

async function retainExclusiveGate(gate) {
  const serialized = canonicalJson(gate);
  const serializedEvidence = canonicalJson(gate.evidence);
  const knownPrivateInputs = await Promise.all([
    readPrivateJson(INPUT_PATHS.roomProvisioningReceipt, "Raw create_room result"),
    readPrivateJson(INPUT_PATHS.taskProvisioningPlan, "Task provisioning plan"),
  ]);
  const room = knownPrivateInputs[0].value?.data?.room;
  const taskPrompt = knownPrivateInputs[1].value?.arguments?.prompt ?? "";
  const secrets = [room?.id, room?.code, room?.title]
    .filter((value) => typeof value === "string" && value.length > 0);
  const privateUrls = typeof taskPrompt === "string"
    ? (taskPrompt.match(/https:\/\/www\.jazzboard\.xyz[^\s]+/g) ?? [])
    : [];
  if ([...secrets, ...privateUrls].some((secret) => serialized.includes(secret)
      || serializedEvidence.includes(secret))) {
    throw new Error("Public spike gate leaks private room material.");
  }
  const bytes = Buffer.from(`${serialized}\n`, "utf8");
  const evidenceBytes = Buffer.from(`${serializedEvidence}\n`, "utf8");
  const evidenceHandle = await open(
    EVIDENCE_OUTPUT_PATH,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try { await evidenceHandle.writeFile(evidenceBytes); await evidenceHandle.sync(); } finally { await evidenceHandle.close(); }
  try {
    const handle = await open(
      OUTPUT_PATH,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o644,
    );
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    await unlink(EVIDENCE_OUTPUT_PATH).catch(() => {});
    throw error;
  }
  const directory = await open(path.dirname(OUTPUT_PATH), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  const readback = await readPlainFile(OUTPUT_PATH, "Retained public spike gate", MAX_JSON_BYTES);
  if (!readback.equals(bytes)) throw new Error("Retained public spike gate differs from signed bytes.");
  const evidenceReadback = await readPlainFile(EVIDENCE_OUTPUT_PATH, "Retained public spike evidence", MAX_JSON_BYTES);
  if (!evidenceReadback.equals(evidenceBytes)) throw new Error("Retained public spike evidence differs from signed bytes.");
}

export async function checkExp0001aCodexSpikeRecoveryReadiness() {
  const { draft } = await deriveVerifiedDraft();
  await loadFixedAuthority();
  return Object.freeze({
    schemaVersion: "exp-0001a-codex-spike-recovery-readiness/v2",
    protocolId: "EXP-0001A",
    decision: "ready_to_sign",
    evidenceDigest: draft.evidenceDigest,
    gateDigest: draft.gateDigest,
    taskIdentityDigest: draft.evidence.task.taskIdentityDigest,
    finalRoomRevision: draft.evidence.room.finalRoomRevision,
    model: draft.evidence.task.requestedModel,
  });
}

export async function signExp0001aCodexSpikeRecoveryGate() {
  const { draft, evaluatedAt, runtime } = await deriveVerifiedDraft();
  const authority = await loadFixedAuthority();
  const signatureContent = authoritySignatureContent(draft, evaluatedAt);
  const signatureBytes = signEd25519(null, signatureMessage(signatureContent), authority.privateKey);
  if (signatureBytes.length !== 64
      || !verifyEd25519(null, signatureMessage(signatureContent), authority.publicKey, signatureBytes)) {
    throw new Error("Spike recovery signature failed immediate verification.");
  }
  const authoritySignature = {
    ...signatureContent,
    signatureBase64: signatureBytes.toString("base64"),
  };
  const gate = runtime.authorizeExp0001aCodexSpikeRecoveryGate({ draft, authoritySignature });
  runtime.verifyExp0001aCodexSpikeRecoveryGate(gate);
  await retainExclusiveGate(gate);
  return Object.freeze({
    schemaVersion: "exp-0001a-codex-spike-recovery-sign-result/v2",
    protocolId: "EXP-0001A",
    decision: gate.decision,
    evidenceDigest: gate.evidenceDigest,
    gateDigest: gate.gateDigest,
    signedAt: gate.authoritySignature.signedAt,
    outputPath: path.relative(REPOSITORY_ROOT, OUTPUT_PATH),
    evidenceOutputPath: path.relative(REPOSITORY_ROOT, EVIDENCE_OUTPUT_PATH),
  });
}

export function parseExp0001aCodexSpikeRecoverySignerArgs(argv) {
  if (argv.length !== 1 || !["--check-readiness", "--sign"].includes(argv[0])) {
    throw new Error("Usage: sign-exp0001a-codex-spike-recovery-gate.mjs --check-readiness | --sign");
  }
  return Object.freeze({ mode: argv[0] === "--sign" ? "sign" : "check-readiness" });
}

export async function runExp0001aCodexSpikeRecoverySignerCli(argv = process.argv.slice(2), io = {
  stdout: process.stdout,
  stderr: process.stderr,
}) {
  try {
    const { mode } = parseExp0001aCodexSpikeRecoverySignerArgs(argv);
    const result = mode === "sign"
      ? await signExp0001aCodexSpikeRecoveryGate()
      : await checkExp0001aCodexSpikeRecoveryReadiness();
    io.stdout.write(`${canonicalJson(result)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${canonicalJson({
      status: "error",
      errorCode: "CODEX_SPIKE_RECOVERY_GATE_FAILED",
      message: error instanceof Error ? error.message : "Unknown failure",
    })}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = await runExp0001aCodexSpikeRecoverySignerCli();
}
