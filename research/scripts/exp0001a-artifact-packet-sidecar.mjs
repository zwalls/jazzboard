#!/usr/bin/env node

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, openSync, closeSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION =
  "exp-0001a-artifact-packet-sidecar/v1";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PACKET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const START_TIMEOUT_MS = 15_000;
const CONTROL_TIMEOUT_MS = 5_000;
const CRASH_RECOVERY_PROVENANCE_BY_TASK_LIFECYCLE_STATE = Object.freeze({
  terminal: Object.freeze({
    kind: "artifact-packet-sidecar-terminal-crash-recovery",
    reason: "task-lifecycle-terminal-before-sidecar-stop-receipt",
    reviewerEvidenceDisposition: "preserved_by_terminal_coordinator_task_lifecycle",
  }),
  not_started_usage_limited: Object.freeze({
    kind: "artifact-packet-sidecar-unstarted-task-crash-recovery",
    reason: "reviewer-create-usage-limited-before-task-begun",
    reviewerEvidenceDisposition: "same_assignment_preserved_unstarted_for_usage_reset_retry",
  }),
  not_started_failed: Object.freeze({
    kind: "artifact-packet-sidecar-unstarted-task-crash-recovery",
    reason: "reviewer-create-failed-before-task-begun",
    reviewerEvidenceDisposition: "same_assignment_preserved_unstarted_for_create_retry",
  }),
});

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestJson(value) {
  return digestBytes(Buffer.from(canonicalJson(value), "utf8"));
}

function contentReceipt(content, digestField = "receiptDigest") {
  return Object.freeze({ ...content, [digestField]: digestJson(content) });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function inside(root, candidate) {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

function validateId(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`EXP0001A_ARTIFACT_PACKET_SIDECAR_${label}_INVALID`);
  }
  return value;
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensurePrivateRunRoot(inputRoot) {
  if (typeof inputRoot !== "string" || !path.isAbsolute(inputRoot)) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_RUN_ROOT_MUST_BE_ABSOLUTE");
  }
  const normalized = path.normalize(inputRoot);
  if (normalized !== inputRoot || normalized === path.parse(normalized).root) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_RUN_ROOT_INVALID");
  }
  await mkdir(normalized, { recursive: true, mode: 0o700 });
  const stat = await lstat(normalized);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_RUN_ROOT_NOT_PLAIN_DIRECTORY");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_RUN_ROOT_NOT_PRIVATE");
  }
  return await realpath(normalized);
}

async function ensurePrivateDirectory(directory, root, create = true) {
  if (!inside(root, directory)) throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_PATH_ESCAPED_RUN_ROOT");
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_STATE_DIRECTORY_INVALID");
  }
  if ((stat.mode & 0o077) !== 0) await chmod(directory, 0o700);
}

async function resolveUnderRoot(root, suppliedPath, label) {
  if (typeof suppliedPath !== "string" || !path.isAbsolute(suppliedPath)) {
    throw new Error(`EXP0001A_ARTIFACT_PACKET_SIDECAR_${label}_MUST_BE_ABSOLUTE`);
  }
  const normalized = path.normalize(suppliedPath);
  if (normalized !== suppliedPath) {
    throw new Error(`EXP0001A_ARTIFACT_PACKET_SIDECAR_${label}_OUTSIDE_RUN_ROOT`);
  }
  const resolved = await realpath(normalized);
  if (!inside(root, resolved)) {
    throw new Error(`EXP0001A_ARTIFACT_PACKET_SIDECAR_${label}_OUTSIDE_RUN_ROOT`);
  }
  return resolved;
}

async function readPlainFile(filePath) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`EXP0001A_ARTIFACT_PACKET_SIDECAR_NOT_PLAIN_FILE:${path.basename(filePath)}`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) {
      throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_FILE_CHANGED_DURING_READ");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readJson(filePath) {
  return JSON.parse((await readPlainFile(filePath)).toString("utf8"));
}

async function writeExclusiveJson(filePath, value) {
  const parent = path.dirname(filePath);
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
  const retained = await readPlainFile(filePath);
  if (retained.toString("utf8") !== `${canonicalJson(value)}\n`) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_EXCLUSIVE_READBACK_MISMATCH");
  }
  await syncDirectory(parent);
}

async function writeIdempotentJson(filePath, value) {
  try {
    await writeExclusiveJson(filePath, value);
    return Object.freeze({ created: true, value });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readJson(filePath);
    if (canonicalJson(existing) !== canonicalJson(value)) {
      throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_REPLAY_COLLISION_OR_TAMPERING");
    }
    return Object.freeze({ created: false, value: existing });
  }
}

function pathsFor(runRoot, packetId) {
  const sidecarsRoot = path.join(runRoot, "artifact-packet-sidecars");
  const packetRoot = path.join(sidecarsRoot, packetId);
  const requestsRoot = path.join(packetRoot, "status-requests");
  const responsesRoot = path.join(packetRoot, "status-responses");
  const restartHistoryRoot = path.join(packetRoot, "restart-history");
  return Object.freeze({
    sidecarsRoot, packetRoot, requestsRoot, responsesRoot, restartHistoryRoot,
    bootstrap: path.join(packetRoot, "bootstrap.json"),
    control: path.join(packetRoot, "control-secret.json"),
    spawn: path.join(packetRoot, "spawn-receipt.json"),
    process: path.join(packetRoot, "process-receipt.json"),
    serverStart: path.join(packetRoot, "server-start-receipt.json"),
    readiness: path.join(packetRoot, "packet-readiness-receipt.json"),
    publicSurface: path.join(packetRoot, "public-task-surface.json"),
    stopCommand: path.join(packetRoot, "stop-command.json"),
    stopReceipt: path.join(packetRoot, "server-stop-receipt.json"),
    stopped: path.join(packetRoot, "sidecar-stopped-receipt.json"),
    failure: path.join(packetRoot, "daemon-failure-receipt.json"),
    crash: path.join(packetRoot, "crash-reconciliation-receipt.json"),
    terminalRecovery: path.join(packetRoot, "terminal-crash-recovery-receipt.json"),
    stdout: path.join(packetRoot, "daemon.stdout.log"),
    stderr: path.join(packetRoot, "daemon.stderr.log"),
  });
}

async function optionalJson(filePath) {
  try { return await readJson(filePath); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`EXP0001A_ARTIFACT_PACKET_SIDECAR_${label}_DIGEST_INVALID`);
  }
}

function verifyReceipt(receipt, digestField = "receiptDigest") {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_RECEIPT_INVALID");
  }
  const { [digestField]: retainedDigest, ...content } = receipt;
  assertDigest(retainedDigest, "RECEIPT");
  if (digestJson(content) !== retainedDigest) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_RECEIPT_TAMPERED");
  }
  return receipt;
}

function recoveryProvenanceForTaskLifecycleState(taskLifecycleState) {
  const provenance = CRASH_RECOVERY_PROVENANCE_BY_TASK_LIFECYCLE_STATE[taskLifecycleState];
  if (provenance === undefined) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_RECOVERY_TASK_LIFECYCLE_STATE_INVALID");
  }
  return provenance;
}

function verifyCrashRecoveryTaskLifecycleBinding(receipt, taskLifecycleState) {
  const retained = verifyReceipt(receipt);
  const expected = recoveryProvenanceForTaskLifecycleState(taskLifecycleState);
  if (retained.taskLifecycleState !== taskLifecycleState
      || retained.kind !== expected.kind
      || retained.reason !== expected.reason
      || retained.reviewerEvidenceDisposition !== expected.reviewerEvidenceDisposition) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_RECOVERY_TASK_LIFECYCLE_STATE_DRIFT");
  }
  return retained;
}

function parseStartInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)
      || input.schemaVersion !== "exp-0001a-artifact-packet-sidecar-start-input/v1"
      || !["primary_reviewer", "adjudicator", "pairwise_visual_judge"].includes(input.role)
      || input.subject === null || typeof input.subject !== "object" || Array.isArray(input.subject)
      || input.evidence === null || typeof input.evidence !== "object" || Array.isArray(input.evidence)) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_START_INPUT_INVALID");
  }
  const forbidden = ["origin", "manifestUrl", "artifactPacketOrigin"];
  const serializedSubject = canonicalJson(input.subject);
  if (forbidden.some((field) => new RegExp(`\\"${field}\\"\\s*:`).test(serializedSubject))) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_SUBJECT_MUST_BE_ORIGIN_FREE");
  }
  const expected = input.role === "primary_reviewer"
    ? ["authorPlan", "authorLifecycle"]
    : input.role === "adjudicator"
      ? ["primarySubject", "primaryReviews"]
      : ["sides"];
  const actual = Object.keys(input.evidence).sort(compareCodeUnits);
  if (canonicalJson(actual) !== canonicalJson([...expected].sort(compareCodeUnits))) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_EVIDENCE_FIELDS_INVALID");
  }
  return input;
}

function stableBootstrapBinding(value) {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    packetId: value.packetId,
    inputPath: value.inputPath,
    inputDigest: value.inputDigest,
    runtimeBundlePath: value.runtimeBundlePath,
    runtimeBundleDigest: value.runtimeBundleDigest,
  };
}

function redactedPublicResult(surface, state) {
  verifyReceipt(surface);
  return Object.freeze({
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    packetId: surface.packetId,
    state,
    role: surface.role,
    subjectDigest: surface.subjectDigest,
    envelope: surface.envelope,
    startReceipt: surface.startReceipt,
    readyReceipt: surface.readyReceipt,
  });
}

async function loadContext(runRootInput, packetIdInput, create = false) {
  const runRoot = await ensurePrivateRunRoot(runRootInput);
  const packetId = validateId(packetIdInput, PACKET_ID, "PACKET_ID");
  const paths = pathsFor(runRoot, packetId);
  if (create) {
    await ensurePrivateDirectory(paths.sidecarsRoot, runRoot, true);
    try {
      await mkdir(paths.packetRoot, { mode: 0o700 });
      await syncDirectory(paths.sidecarsRoot);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    await ensurePrivateDirectory(paths.packetRoot, runRoot, false);
    await ensurePrivateDirectory(paths.requestsRoot, runRoot, true);
    await ensurePrivateDirectory(paths.responsesRoot, runRoot, true);
  } else {
    await ensurePrivateDirectory(paths.packetRoot, runRoot, false);
    await ensurePrivateDirectory(paths.requestsRoot, runRoot, false);
    await ensurePrivateDirectory(paths.responsesRoot, runRoot, false);
  }
  return Object.freeze({ runRoot, packetId, paths });
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function statusAuthenticator(secret, content) {
  return `sha256:${createHmac("sha256", secret).update(canonicalJson(content)).digest("hex")}`;
}

function secretMatches(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

async function reconcileCrash(context, _trigger, observedAt = new Date().toISOString()) {
  void _trigger;
  const stopped = await optionalJson(context.paths.stopped);
  if (stopped !== null) return Object.freeze({ state: "stopped", receipt: verifyReceipt(stopped) });
  const existing = await optionalJson(context.paths.crash);
  if (existing !== null) return Object.freeze({ state: "crashed", receipt: verifyReceipt(existing) });
  const processReceipt = await optionalJson(context.paths.process);
  const spawnReceipt = await optionalJson(context.paths.spawn);
  const stopCommand = await optionalJson(context.paths.stopCommand);
  const serverStopReceipt = await optionalJson(context.paths.stopReceipt);
  const content = {
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    kind: "artifact-packet-sidecar-crash-reconciliation",
    packetId: context.packetId,
    observedAt,
    reason: "daemon-process-not-running-without-stop-receipt",
    processReceiptDigest: processReceipt?.receiptDigest ?? null,
    spawnReceiptDigest: spawnReceipt?.receiptDigest ?? null,
    serverStartReceiptDigest: (await optionalJson(context.paths.serverStart))?.receiptDigest ?? null,
    packetReadinessReceiptDigest: (await optionalJson(context.paths.readiness))?.receiptDigest ?? null,
    serverStopReceiptPresent: serverStopReceipt !== null,
    // `start` is only emitted before the coordinator has retained a packet and
    // prepared/released its reviewer task. A crash without a stop intent can
    // therefore be recovered by replaying that exact start action. `stop`
    // never takes this branch; it finalizes the already-begun reviewer packet.
    safeToRestartSamePacketId: stopCommand === null && serverStopReceipt === null,
  };
  const receipt = contentReceipt(content);
  try {
    await writeExclusiveJson(context.paths.crash, receipt);
    return Object.freeze({ state: "crashed", receipt });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const retained = verifyReceipt(await readJson(context.paths.crash));
    const stable = (value) => ({
      schemaVersion: value.schemaVersion,
      kind: value.kind,
      packetId: value.packetId,
      reason: value.reason,
      processReceiptDigest: value.processReceiptDigest,
      spawnReceiptDigest: value.spawnReceiptDigest,
      serverStartReceiptDigest: value.serverStartReceiptDigest,
      packetReadinessReceiptDigest: value.packetReadinessReceiptDigest,
      serverStopReceiptPresent: value.serverStopReceiptPresent,
      safeToRestartSamePacketId: value.safeToRestartSamePacketId,
    });
    if (canonicalJson(stable(retained)) !== canonicalJson(stable(receipt))) {
      throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_CRASH_RECONCILIATION_COLLISION");
    }
    return Object.freeze({ state: "crashed", receipt: retained });
  }
}

async function pathExists(filePath) {
  try { await lstat(filePath); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function archiveRestartableGeneration(context, crashReceipt, observedAt = new Date().toISOString()) {
  verifyReceipt(crashReceipt);
  if (crashReceipt.packetId !== context.packetId || crashReceipt.safeToRestartSamePacketId !== true) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_CRASH_NOT_SAFE_TO_RESTART");
  }
  const processReceipt = await optionalJson(context.paths.process);
  const spawnReceipt = await optionalJson(context.paths.spawn);
  const pid = processReceipt?.pid ?? spawnReceipt?.spawnedPid ?? null;
  if (processExists(pid)) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_RESTART_PROCESS_STILL_RUNNING");
  }
  await ensurePrivateDirectory(context.paths.restartHistoryRoot, context.runRoot, true);
  const generations = (await readdir(context.paths.restartHistoryRoot))
    .filter((name) => /^generation-[0-9]{4}$/.test(name)).sort(compareCodeUnits);
  const ordinal = generations.length + 1;
  if (ordinal > 9999) throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_RESTART_LIMIT_EXCEEDED");
  const generationName = `generation-${String(ordinal).padStart(4, "0")}`;
  const archiveRoot = path.join(context.paths.restartHistoryRoot, generationName);
  await mkdir(archiveRoot, { mode: 0o700 });
  const volatilePaths = [
    context.paths.control, context.paths.spawn, context.paths.process,
    context.paths.serverStart, context.paths.readiness, context.paths.publicSurface,
    context.paths.stopCommand, context.paths.stopReceipt, context.paths.stopped,
    context.paths.failure, context.paths.crash, context.paths.terminalRecovery,
    context.paths.stdout, context.paths.stderr,
    context.paths.requestsRoot, context.paths.responsesRoot,
  ];
  const archivedEntries = [];
  for (const source of volatilePaths) {
    if (!await pathExists(source)) continue;
    const name = path.basename(source);
    await rename(source, path.join(archiveRoot, name));
    archivedEntries.push(name);
  }
  const restartContent = {
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    kind: "artifact-packet-sidecar-restart-generation",
    packetId: context.packetId,
    generation: ordinal,
    archivedAt: observedAt,
    crashReconciliationReceiptDigest: crashReceipt.receiptDigest,
    archivedEntries: archivedEntries.sort(compareCodeUnits),
    reviewerTaskReleasedBySidecar: false,
  };
  await writeExclusiveJson(path.join(archiveRoot, "restart-generation-receipt.json"), contentReceipt(restartContent));
  await syncDirectory(archiveRoot);
  await syncDirectory(context.paths.restartHistoryRoot);
  await ensurePrivateDirectory(context.paths.requestsRoot, context.runRoot, true);
  await ensurePrivateDirectory(context.paths.responsesRoot, context.runRoot, true);
  await syncDirectory(context.paths.packetRoot);
  return contentReceipt(restartContent);
}

async function recoverTerminalPacketAfterCrash(
  context,
  crashReceipt,
  taskLifecycleState,
  observedAt = new Date().toISOString(),
) {
  const provenance = recoveryProvenanceForTaskLifecycleState(taskLifecycleState);
  const existing = await optionalJson(context.paths.terminalRecovery);
  if (existing !== null) return verifyCrashRecoveryTaskLifecycleBinding(existing, taskLifecycleState);
  const retainedCrash = verifyReceipt(crashReceipt);
  const surface = verifyReceipt(await readJson(context.paths.publicSurface));
  const reviewerEnvelopeDigest = digestJson(surface.envelope);
  if (surface.startReceipt?.reviewerEnvelopeDigest !== reviewerEnvelopeDigest
      || surface.readyReceipt?.envelopeDigest !== reviewerEnvelopeDigest) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_TERMINAL_RECOVERY_ENVELOPE_BINDING_INVALID");
  }
  const processReceipt = await optionalJson(context.paths.process);
  const spawnReceipt = await optionalJson(context.paths.spawn);
  const pid = processReceipt?.pid ?? spawnReceipt?.spawnedPid ?? null;
  if (processExists(pid)) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_TERMINAL_RECOVERY_PROCESS_STILL_RUNNING");
  }
  const content = {
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    kind: provenance.kind,
    packetId: context.packetId,
    recoveredAt: observedAt,
    taskLifecycleState,
    reason: provenance.reason,
    crashReconciliationReceiptDigest: retainedCrash.receiptDigest,
    startReceiptDigest: surface.startReceipt.receiptDigest,
    readyReceiptDigest: surface.readyReceipt.receiptDigest,
    reviewerEnvelopeDigest,
    subjectDigest: surface.subjectDigest,
    serverProcessState: "confirmed_not_running",
    packetAccessEvidence: "readiness_receipt_retained_runtime_counters_unavailable_after_crash",
    reviewerEvidenceDisposition: provenance.reviewerEvidenceDisposition,
  };
  const receipt = contentReceipt(content);
  await writeIdempotentJson(context.paths.terminalRecovery, receipt);
  return receipt;
}

async function readControl(context) {
  const control = await readJson(context.paths.control);
  if (control?.schemaVersion !== EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION
      || control.kind !== "artifact-packet-sidecar-private-control"
      || control.packetId !== context.packetId
      || typeof control.processNonce !== "string" || typeof control.controlSecret !== "string"
      || digestBytes(Buffer.from(control.processNonce)) !== control.processNonceDigest
      || digestBytes(Buffer.from(control.controlSecret)) !== control.controlSecretDigest) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_PRIVATE_CONTROL_INVALID");
  }
  return control;
}

async function waitForFile(filePath, timeoutMs, livePid = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await optionalJson(filePath);
    if (value !== null) return value;
    if (livePid !== null && !processExists(livePid)) return null;
    await sleep(40);
  }
  return null;
}

async function requestLiveStatus(context, requestIdInput = randomUUID(), timeoutMs = CONTROL_TIMEOUT_MS) {
  const requestId = validateId(requestIdInput, REQUEST_ID, "REQUEST_ID");
  const control = await readControl(context);
  const requestContent = {
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    kind: "artifact-packet-sidecar-status-request",
    packetId: context.packetId,
    requestId,
    processNonce: control.processNonce,
    controlSecret: control.controlSecret,
  };
  const request = contentReceipt(requestContent, "commandDigest");
  const requestPath = path.join(context.paths.requestsRoot, `${requestId}.json`);
  const responsePath = path.join(context.paths.responsesRoot, `${requestId}.json`);
  await writeIdempotentJson(requestPath, request);
  const processReceipt = await optionalJson(context.paths.process);
  if (processReceipt !== null) verifyReceipt(processReceipt);
  const spawnReceipt = await optionalJson(context.paths.spawn);
  if (spawnReceipt !== null) verifyReceipt(spawnReceipt);
  const pid = processReceipt?.pid ?? spawnReceipt?.spawnedPid ?? null;
  const response = await waitForFile(responsePath, timeoutMs, pid);
  if (response === null) return Object.freeze({ state: processExists(pid) ? "unresponsive" : "dead", pid });
  const { authenticator, ...content } = response;
  if (content.schemaVersion !== EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION
      || content.kind !== "artifact-packet-sidecar-status-response"
      || content.packetId !== context.packetId || content.requestId !== requestId
      || content.processNonceDigest !== control.processNonceDigest
      || !secretMatches(authenticator, statusAuthenticator(control.controlSecret, content))) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_STATUS_RESPONSE_INVALID");
  }
  return Object.freeze({ state: content.state, response });
}

export async function statusExp0001aArtifactPacketSidecar(input) {
  const context = await loadContext(input.runRoot, input.packetId, false);
  const stopped = await optionalJson(context.paths.stopped);
  if (stopped !== null) return Object.freeze({
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    packetId: context.packetId, state: "stopped", stopReceipt: verifyReceipt(stopped).serverStopReceipt,
  });
  const terminalRecovery = await optionalJson(context.paths.terminalRecovery);
  if (terminalRecovery !== null) return Object.freeze({
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    packetId: context.packetId, state: "recovered_after_crash",
    recoveryReceipt: verifyReceipt(terminalRecovery),
  });
  const crash = await optionalJson(context.paths.crash);
  if (crash !== null) return Object.freeze({
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    packetId: context.packetId, state: "crashed", reconciliationReceipt: verifyReceipt(crash),
  });
  const failure = await optionalJson(context.paths.failure);
  if (failure !== null) return Object.freeze({
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    packetId: context.packetId, state: "failed", failureReceipt: verifyReceipt(failure),
  });
  const retainedControl = await optionalJson(context.paths.control);
  if (retainedControl === null) {
    const bootstrap = verifyReceipt(await readJson(context.paths.bootstrap));
    if (processExists(bootstrap.launcherPid)) return Object.freeze({
      schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
      packetId: context.packetId, state: "starting",
    });
    const reconciled = await reconcileCrash(context, "launcher-exited-before-private-control");
    return Object.freeze({
      schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
      packetId: context.packetId, state: reconciled.state, reconciliationReceipt: reconciled.receipt,
    });
  }
  const live = await requestLiveStatus(context, input.requestId, input.timeoutMs);
  if (live.state === "dead") {
    const reconciled = await reconcileCrash(context, "daemon-process-not-running");
    return Object.freeze({
      schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
      packetId: context.packetId, state: reconciled.state, reconciliationReceipt: reconciled.receipt,
    });
  }
  if (live.state === "unresponsive") return Object.freeze({
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    packetId: context.packetId, state: "unresponsive",
  });
  const surface = await optionalJson(context.paths.publicSurface);
  return surface === null
    ? Object.freeze({ schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION, packetId: context.packetId, state: "starting" })
    : redactedPublicResult(surface, live.state);
}

async function launchFreshGeneration(context, bootstrap, timeoutMs) {
  const processNonce = randomBytes(32).toString("base64url");
  const controlSecret = randomBytes(32).toString("base64url");
  const control = Object.freeze({
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    kind: "artifact-packet-sidecar-private-control",
    packetId: context.packetId,
    processNonce,
    processNonceDigest: digestBytes(Buffer.from(processNonce)),
    controlSecret,
    controlSecretDigest: digestBytes(Buffer.from(controlSecret)),
  });
  await writeExclusiveJson(context.paths.control, control);

  const stdoutFd = openSync(context.paths.stdout,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  const stderrFd = openSync(context.paths.stderr,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  let child;
  try {
    child = spawn(process.execPath, [SCRIPT_PATH, "daemon", "--run-root", context.runRoot, "--packet-id", context.packetId], {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: { PATH: process.env.PATH ?? "" },
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally {
    closeSync(stdoutFd); closeSync(stderrFd);
  }
  child.unref();
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_CHILD_PID_INVALID");
  }
  const spawnContent = {
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    kind: "artifact-packet-sidecar-spawn",
    packetId: context.packetId,
    spawnedAt: new Date().toISOString(),
    spawnedPid: child.pid,
    bootstrapDigest: bootstrap.receiptDigest,
    processNonceDigest: control.processNonceDigest,
  };
  await writeExclusiveJson(context.paths.spawn, contentReceipt(spawnContent));

  const surface = await waitForFile(context.paths.publicSurface, timeoutMs, child.pid);
  if (surface !== null) return redactedPublicResult(surface, "active");
  const failure = await optionalJson(context.paths.failure);
  if (failure !== null) throw new Error(`EXP0001A_ARTIFACT_PACKET_SIDECAR_DAEMON_FAILED:${failure.errorCode}`);
  if (!processExists(child.pid)) {
    await reconcileCrash(context, "daemon-exited-before-readiness");
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_DAEMON_EXITED_BEFORE_READINESS");
  }
  throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_READINESS_TIMEOUT");
}

async function replayExistingStart(context, bootstrap, timeoutMs) {
  const controlReady = await waitForFile(context.paths.control, timeoutMs, bootstrap.launcherPid ?? null);
  if (controlReady === null) {
    await reconcileCrash(context, "launcher-exited-before-private-control");
  }
  const status = await statusExp0001aArtifactPacketSidecar({
    runRoot: context.runRoot, packetId: context.packetId, timeoutMs,
  });
  if (status.state === "active" || status.state === "starting" || status.state === "stopped") return status;
  if (status.state === "crashed" && status.reconciliationReceipt.safeToRestartSamePacketId === true) {
    await archiveRestartableGeneration(context, status.reconciliationReceipt);
    return launchFreshGeneration(context, bootstrap, timeoutMs);
  }
  throw new Error(`EXP0001A_ARTIFACT_PACKET_SIDECAR_NOT_RESTARTABLE:${status.state}`);
}

export async function startExp0001aArtifactPacketSidecar(input) {
  const context = await loadContext(input.runRoot, input.packetId, true);
  const inputPath = await resolveUnderRoot(context.runRoot, input.inputPath, "INPUT_PATH");
  const runtimeBundlePath = await resolveUnderRoot(context.runRoot, input.runtimeBundlePath, "RUNTIME_BUNDLE_PATH");
  const inputBytes = await readPlainFile(inputPath);
  const runtimeBytes = await readPlainFile(runtimeBundlePath);
  parseStartInput(JSON.parse(inputBytes.toString("utf8")));
  const bootstrapContent = {
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    kind: "artifact-packet-sidecar-bootstrap",
    packetId: context.packetId,
    inputPath: path.relative(context.runRoot, inputPath),
    inputDigest: digestBytes(inputBytes),
    runtimeBundlePath: path.relative(context.runRoot, runtimeBundlePath),
    runtimeBundleDigest: digestBytes(runtimeBytes),
    createdAt: input.startedAt ?? new Date().toISOString(),
    launcherPid: process.pid,
  };
  const bootstrap = contentReceipt(bootstrapContent);
  const existingBootstrap = await optionalJson(context.paths.bootstrap);
  if (existingBootstrap !== null) {
    verifyReceipt(existingBootstrap);
    if (canonicalJson(existingBootstrap) !== canonicalJson(bootstrap)) {
      // createdAt is deliberately not part of replay equivalence.
      if (canonicalJson(stableBootstrapBinding(existingBootstrap))
          !== canonicalJson(stableBootstrapBinding(bootstrap))) {
        throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_START_REPLAY_INPUT_DRIFT");
      }
    }
    return replayExistingStart(context, existingBootstrap, input.timeoutMs ?? START_TIMEOUT_MS);
  }
  try {
    await writeExclusiveJson(context.paths.bootstrap, bootstrap);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const retained = verifyReceipt(await readJson(context.paths.bootstrap));
    if (canonicalJson(stableBootstrapBinding(retained))
        !== canonicalJson(stableBootstrapBinding(bootstrap))) {
      throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_START_REPLAY_INPUT_DRIFT");
    }
    return replayExistingStart(context, retained, input.timeoutMs ?? START_TIMEOUT_MS);
  }
  return launchFreshGeneration(context, bootstrap, input.timeoutMs ?? START_TIMEOUT_MS);
}

export async function stopExp0001aArtifactPacketSidecar(input) {
  recoveryProvenanceForTaskLifecycleState(input.taskLifecycleState);
  const context = await loadContext(input.runRoot, input.packetId, false);
  const alreadyStopped = await optionalJson(context.paths.stopped);
  if (alreadyStopped !== null) return Object.freeze({
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    packetId: context.packetId, state: "stopped", stopReceipt: verifyReceipt(alreadyStopped).serverStopReceipt,
  });
  const existingRecovery = await optionalJson(context.paths.terminalRecovery);
  if (existingRecovery !== null) return Object.freeze({
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    packetId: context.packetId, state: "recovered_after_crash",
    recoveryReceipt: verifyCrashRecoveryTaskLifecycleBinding(existingRecovery, input.taskLifecycleState),
  });
  const crash = await optionalJson(context.paths.crash);
  if (crash !== null) {
    const recoveryReceipt = await recoverTerminalPacketAfterCrash(context, crash, input.taskLifecycleState);
    return Object.freeze({
      schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
      packetId: context.packetId, state: "recovered_after_crash", recoveryReceipt,
    });
  }
  const control = await readControl(context);
  const commandContent = {
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    kind: "artifact-packet-sidecar-stop-command",
    packetId: context.packetId,
    processNonce: control.processNonce,
    controlSecret: control.controlSecret,
  };
  const command = contentReceipt(commandContent, "commandDigest");
  await writeIdempotentJson(context.paths.stopCommand, command);
  const processReceipt = await optionalJson(context.paths.process);
  const pid = processReceipt?.pid ?? (await optionalJson(context.paths.spawn))?.spawnedPid ?? null;
  const stopped = await waitForFile(context.paths.stopped, input.timeoutMs ?? CONTROL_TIMEOUT_MS, pid);
  if (stopped !== null) return Object.freeze({
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    packetId: context.packetId, state: "stopped", stopReceipt: verifyReceipt(stopped).serverStopReceipt,
  });
  if (!processExists(pid)) {
    const reconciled = await reconcileCrash(context, "daemon-exited-without-stop-receipt");
    const recoveryReceipt = await recoverTerminalPacketAfterCrash(
      context,
      reconciled.receipt,
      input.taskLifecycleState,
    );
    return Object.freeze({
      schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
      packetId: context.packetId, state: "recovered_after_crash", recoveryReceipt,
    });
  }
  throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_STOP_TIMEOUT");
}

async function startRuntimePacketServer(runtime, input) {
  if (input.role === "primary_reviewer") {
    return runtime.startExp0001aCodexPrimaryArtifactPacketServer({
      subject: input.subject,
      authorPlan: input.evidence.authorPlan,
      authorLifecycle: input.evidence.authorLifecycle,
    });
  }
  if (input.role === "adjudicator") {
    return runtime.startExp0001aCodexAdjudicationArtifactPacketServer({
      subject: input.subject,
      primarySubject: input.evidence.primarySubject,
      primaryReviews: input.evidence.primaryReviews,
    });
  }
  return runtime.startExp0001aCodexPairwiseArtifactPacketServer({
    subject: input.subject,
    sides: input.evidence.sides,
  });
}

async function daemonStatusResponse(context, control, processReceipt, request) {
  if (request.schemaVersion !== EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION
      || request.kind !== "artifact-packet-sidecar-status-request"
      || request.packetId !== context.packetId
      || !REQUEST_ID.test(request.requestId ?? "")
      || request.processNonce !== control.processNonce
      || !secretMatches(request.controlSecret, control.controlSecret)) return;
  const { commandDigest, ...commandContent } = request;
  if (digestJson(commandContent) !== commandDigest) return;
  const responseContent = {
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    kind: "artifact-packet-sidecar-status-response",
    packetId: context.packetId,
    requestId: request.requestId,
    state: "active",
    pid: process.pid,
    processNonceDigest: control.processNonceDigest,
    processReceiptDigest: processReceipt.receiptDigest,
    serverStartReceiptDigest: (await readJson(context.paths.serverStart)).receiptDigest,
    packetReadinessReceiptDigest: (await readJson(context.paths.readiness)).receiptDigest,
  };
  const response = { ...responseContent, authenticator: statusAuthenticator(control.controlSecret, responseContent) };
  await writeIdempotentJson(path.join(context.paths.responsesRoot, `${request.requestId}.json`), response);
}

async function runDaemon(runRootInput, packetIdInput) {
  const context = await loadContext(runRootInput, packetIdInput, false);
  const bootstrap = verifyReceipt(await readJson(context.paths.bootstrap));
  const control = await readControl(context);
  const spawnReceipt = await waitForFile(context.paths.spawn, START_TIMEOUT_MS);
  if (spawnReceipt === null || spawnReceipt.spawnedPid !== process.pid
      || spawnReceipt.bootstrapDigest !== bootstrap.receiptDigest
      || spawnReceipt.processNonceDigest !== control.processNonceDigest) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_SPAWN_BINDING_INVALID");
  }
  verifyReceipt(spawnReceipt);
  const inputPath = await resolveUnderRoot(context.runRoot, path.join(context.runRoot, bootstrap.inputPath), "INPUT_PATH");
  const runtimePath = await resolveUnderRoot(context.runRoot, path.join(context.runRoot, bootstrap.runtimeBundlePath), "RUNTIME_BUNDLE_PATH");
  const inputBytes = await readPlainFile(inputPath);
  const runtimeBytes = await readPlainFile(runtimePath);
  if (digestBytes(inputBytes) !== bootstrap.inputDigest || digestBytes(runtimeBytes) !== bootstrap.runtimeBundleDigest) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_BOOTSTRAP_BYTES_DRIFT");
  }
  const startInput = parseStartInput(JSON.parse(inputBytes.toString("utf8")));
  const runtime = await import(`${pathToFileURL(runtimePath).href}?sha256=${bootstrap.runtimeBundleDigest.slice(7)}`);
  let packetServer = null;
  try {
    packetServer = await startRuntimePacketServer(runtime, startInput);
  const startReceipt = runtime.exp0001aCodexArtifactPacketServerStartReceiptSchema?.parse
    ? runtime.exp0001aCodexArtifactPacketServerStartReceiptSchema.parse(packetServer.startReceipt)
    : packetServer.startReceipt;
  const readyReceipt = packetServer.readyReceipt;
  if (!startReceipt || !readyReceipt || startReceipt.role !== startInput.role
      || startReceipt.subjectDigest !== startInput.subject.subjectDigest
      || readyReceipt.envelopeDigest !== startReceipt.reviewerEnvelopeDigest) {
    await packetServer.stop().catch(() => undefined);
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_RUNTIME_RECEIPTS_INVALID");
  }
  const processContent = {
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    kind: "artifact-packet-sidecar-process",
    packetId: context.packetId,
    pid: process.pid,
    processNonceDigest: control.processNonceDigest,
    controlSecretDigest: control.controlSecretDigest,
    bootstrapDigest: bootstrap.receiptDigest,
    spawnReceiptDigest: spawnReceipt.receiptDigest,
    startedAt: new Date().toISOString(),
  };
  const processReceipt = contentReceipt(processContent);
  await writeExclusiveJson(context.paths.process, processReceipt);
  await writeExclusiveJson(context.paths.serverStart, startReceipt);
  await writeExclusiveJson(context.paths.readiness, readyReceipt);
  const publicContent = {
    schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
    kind: "artifact-packet-sidecar-public-task-surface",
    packetId: context.packetId,
    role: startInput.role,
    subjectDigest: startInput.subject.subjectDigest,
    envelope: packetServer.envelope,
    startReceipt,
    readyReceipt,
  };
  await writeExclusiveJson(context.paths.publicSurface, contentReceipt(publicContent));

  let shuttingDown = false;
  const stopAndRetain = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const rawServerStopReceipt = await packetServer.stop();
    const serverStopReceipt = runtime.exp0001aCodexArtifactPacketServerStopReceiptSchema?.parse
      ? runtime.exp0001aCodexArtifactPacketServerStopReceiptSchema.parse(rawServerStopReceipt)
      : rawServerStopReceipt;
    await writeExclusiveJson(context.paths.stopReceipt, serverStopReceipt);
    const stoppedContent = {
      schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
      kind: "artifact-packet-sidecar-stopped",
      packetId: context.packetId,
      stoppedAt: new Date().toISOString(),
      reason,
      processReceiptDigest: processReceipt.receiptDigest,
      serverStartReceiptDigest: startReceipt.receiptDigest,
      packetReadinessReceiptDigest: readyReceipt.receiptDigest,
      serverStopReceipt,
    };
    await writeExclusiveJson(context.paths.stopped, contentReceipt(stoppedContent));
  };
  let signalReason = null;
  process.once("SIGTERM", () => { signalReason = "SIGTERM"; });
  process.once("SIGINT", () => { signalReason = "SIGINT"; });
  while (!shuttingDown) {
    if (signalReason !== null) {
      await stopAndRetain(signalReason); break;
    }
    const stopCommand = await optionalJson(context.paths.stopCommand);
    if (stopCommand !== null) {
      const { commandDigest, ...commandContent } = stopCommand;
      if (digestJson(commandContent) !== commandDigest
          || stopCommand.packetId !== context.packetId
          || stopCommand.processNonce !== control.processNonce
          || !secretMatches(stopCommand.controlSecret, control.controlSecret)) {
        throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_STOP_COMMAND_INVALID");
      }
      await stopAndRetain("one-shot-stop-command"); break;
    }
    const names = await readdir(context.paths.requestsRoot);
    for (const name of names.sort(compareCodeUnits)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}\.json$/.test(name)) continue;
      const request = await readJson(path.join(context.paths.requestsRoot, name));
      await daemonStatusResponse(context, control, processReceipt, request);
    }
    await sleep(40);
  }
  } catch (error) {
    if (packetServer !== null) await packetServer.stop().catch(() => undefined);
    throw error;
  }
}

async function retainDaemonFailure(runRoot, packetId, error) {
  try {
    const context = await loadContext(runRoot, packetId, false);
    const content = {
      schemaVersion: EXP0001A_ARTIFACT_PACKET_SIDECAR_VERSION,
      kind: "artifact-packet-sidecar-daemon-failure",
      packetId,
      failedAt: new Date().toISOString(),
      errorCode: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    };
    await writeIdempotentJson(context.paths.failure, contentReceipt(content));
  } catch { /* The launcher will reconcile a process that cannot retain its own failure. */ }
}

function parseCli(argv) {
  if (argv.length < 1 || !["start", "status", "stop", "daemon"].includes(argv[0])) {
    throw new Error("Usage: node research/scripts/exp0001a-artifact-packet-sidecar.mjs <start|status|stop> --run-root ABS --packet-id ID [--input ABS --runtime-bundle ABS] [--task-lifecycle-state STATE]");
  }
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || values[flag] !== undefined) {
      throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_ARGUMENTS_INVALID");
    }
    values[flag] = value;
  }
  const allowed = command === "start"
    ? ["--run-root", "--packet-id", "--input", "--runtime-bundle"]
    : command === "status"
      ? ["--run-root", "--packet-id", "--request-id"]
      : command === "stop"
        ? ["--run-root", "--packet-id", "--task-lifecycle-state"]
        : ["--run-root", "--packet-id"];
  if (Object.keys(values).some((key) => !allowed.includes(key))
      || values["--run-root"] === undefined || values["--packet-id"] === undefined
      || (command === "start" && (values["--input"] === undefined || values["--runtime-bundle"] === undefined))
      || (command === "stop" && values["--task-lifecycle-state"] === undefined)) {
    throw new Error("EXP0001A_ARTIFACT_PACKET_SIDECAR_ARGUMENTS_INVALID");
  }
  return { command, values };
}

export async function runExp0001aArtifactPacketSidecarCli(argv) {
  const parsed = parseCli(argv);
  const common = { runRoot: parsed.values["--run-root"], packetId: parsed.values["--packet-id"] };
  if (parsed.command === "start") return startExp0001aArtifactPacketSidecar({
    ...common,
    inputPath: parsed.values["--input"],
    runtimeBundlePath: parsed.values["--runtime-bundle"],
  });
  if (parsed.command === "status") return statusExp0001aArtifactPacketSidecar({
    ...common, requestId: parsed.values["--request-id"],
  });
  if (parsed.command === "stop") return stopExp0001aArtifactPacketSidecar({
    ...common,
    taskLifecycleState: parsed.values["--task-lifecycle-state"],
  });
  await runDaemon(common.runRoot, common.packetId);
  return null;
}

async function main() {
  const parsed = parseCli(process.argv.slice(2));
  try {
    const result = await runExp0001aArtifactPacketSidecarCli(process.argv.slice(2));
    if (parsed.command !== "daemon") process.stdout.write(`${canonicalJson(result)}\n`);
  } catch (error) {
    if (parsed.command === "daemon") {
      await retainDaemonFailure(parsed.values["--run-root"], parsed.values["--packet-id"], error);
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
