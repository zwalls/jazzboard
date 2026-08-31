#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EXP0001A_RUNTIME_OUTPUT,
  verifyExp0001aRuntimeBundle,
} from "./build-exp0001a-runtime.mjs";
import { runCodexAuthPreflight } from "./codex-auth-preflight.mjs";
import {
  canonicalJson,
  createExp0001aCodexLaunchReadinessReceipt,
  sha256Canonical,
  verifyExp0001aCodexLaunchReadinessReceipt,
} from "./exp0001a-codex-launch-readiness.mjs";
import {
  appendExp0001aAuthorityJournalEntry,
  readExp0001aAuthorityJournal,
} from "./exp0001a-authority-journal.mjs";
import {
  createExp0001aStagedProvisioningCoordinator,
  persistExp0001aCoordinatorMutation as persistCoordinatorTransaction,
  recoverExp0001aCoordinatorMutation as recoverCoordinatorTransaction,
} from "./exp0001a-coordinator-transaction.mjs";
import { verifyExp0001aOuterExecutionSourceCommitments } from "./exp0001a-outer-source-verifier.mjs";
import {
  startExp0001aArtifactPacketSidecar,
  stopExp0001aArtifactPacketSidecar,
} from "./exp0001a-artifact-packet-sidecar.mjs";
import {
  COMPLETION_ATTESTATION_FILE_NAME,
  COMPLETION_DRAFT_FILE_NAME,
  COMPLETION_EVIDENCE_FILE_NAME,
} from "./sign-exp0001a-completion.mjs";
import { signExp0001aUsageResetProbeFromConfig } from "./sign-exp0001a-usage-reset-probe.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function parseArguments(argv) {
  const executeCount = argv.filter((value) => value === "--execute").length;
  const ingestIndexes = argv.flatMap((value, index) => value === "--ingest-result" ? [index] : []);
  const acknowledgeIndexes = argv.flatMap((value, index) => value === "--ack-dispatch" ? [index] : []);
  const dispatchIndexes = argv.flatMap((value, index) => value === "--dispatch-action" ? [index] : []);
  if (executeCount > 1 || ingestIndexes.length > 1 || acknowledgeIndexes.length > 1 || dispatchIndexes.length > 1
      || [executeCount === 1, ingestIndexes.length === 1, acknowledgeIndexes.length === 1].filter(Boolean).length > 1) {
    throw new Error("Usage: node research/scripts/exp0001a-batch-command.mjs [--execute | --ack-dispatch sha256:... | --ingest-result /absolute/result.json --dispatch-action sha256:...] --config /absolute/path/to/config.json");
  }
  const ingestIndex = ingestIndexes[0] ?? -1;
  const acknowledgeIndex = acknowledgeIndexes[0] ?? -1;
  const dispatchIndex = dispatchIndexes[0] ?? -1;
  const ingestResultPath = ingestIndex < 0 ? null : argv[ingestIndex + 1];
  const acknowledgedActionDigest = acknowledgeIndex < 0 ? null : argv[acknowledgeIndex + 1];
  const dispatchedActionDigest = dispatchIndex < 0 ? null : argv[dispatchIndex + 1];
  const positional = argv.filter((value, index) => value !== "--execute"
    && value !== "--ingest-result" && (ingestIndex < 0 || index !== ingestIndex + 1)
    && value !== "--ack-dispatch" && (acknowledgeIndex < 0 || index !== acknowledgeIndex + 1)
    && value !== "--dispatch-action" && (dispatchIndex < 0 || index !== dispatchIndex + 1));
  if (positional.length !== 2 || positional[0] !== "--config" || typeof positional[1] !== "string"
      || (ingestIndex >= 0 && typeof ingestResultPath !== "string")
      || (acknowledgeIndex >= 0 && !SHA256.test(acknowledgedActionDigest ?? ""))
      || (dispatchIndex >= 0 && !SHA256.test(dispatchedActionDigest ?? ""))
      || (ingestIndex >= 0) !== (dispatchIndex >= 0)
      || (acknowledgeIndex >= 0 && dispatchIndex >= 0)) {
    throw new Error("Usage: node research/scripts/exp0001a-batch-command.mjs [--execute | --ack-dispatch sha256:... | --ingest-result /absolute/result.json --dispatch-action sha256:...] --config /absolute/path/to/config.json");
  }
  const configPath = path.normalize(positional[1]);
  if (!path.isAbsolute(configPath) || configPath === path.parse(configPath).root) {
    throw new Error("EXP-0001A Codex-native config path must be absolute and non-root.");
  }
  if (ingestResultPath !== null && (!path.isAbsolute(ingestResultPath)
      || path.normalize(ingestResultPath) !== ingestResultPath
      || ingestResultPath === path.parse(ingestResultPath).root)) {
    throw new Error("EXP-0001A external result path must be absolute, normalized, and non-root.");
  }
  return Object.freeze({
    configPath,
    mode: executeCount === 1 ? "execute" : acknowledgeIndex >= 0 ? "acknowledge" : ingestResultPath === null ? "dry-run" : "ingest",
    ingestResultPath,
    acknowledgedActionDigest,
    dispatchedActionDigest,
  });
}

async function readPlainJson(filePath) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`EXP-0001A input must be a plain file: ${filePath}`);
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function readPlainBytes(filePath) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`EXP-0001A input must be a plain file: ${filePath}`);
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function loadCommittedRuntime() {
  return import(pathToFileURL(path.join(REPO_ROOT, EXP0001A_RUNTIME_OUTPUT)).href);
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

let exclusivePublicationOrdinal = 0;
async function retainExclusiveOrExact(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(path.dirname(filePath),
    `.exclusive-publish-${process.pid}-${Date.now()}-${exclusivePublicationOrdinal++}.tmp`);
  let published = false;
  try {
    const handle = await open(temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await link(temporaryPath, filePath);
    published = true;
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  const retained = await readPlainBytes(filePath);
  if (!retained.equals(bytes)) throw new Error("EXP0001A_SIDECAR_INPUT_REPLAY_DRIFT");
  return Object.freeze({ filePath, published });
}

async function executePacketSidecarAction(input) {
  const runRoot = path.join(input.config.outputRoot, "packet-sidecar-runtime");
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const inputPath = path.join(runRoot, "inputs", `${input.action.packetId}.json`);
  const runtimePath = path.join(runRoot, "runtime", `${input.verifiedBundle.bundleDigest.slice(7)}.mjs`);
  await retainExclusiveOrExact(inputPath, Buffer.from(`${canonicalJson(input.action.startInput)}\n`, "utf8"));
  await retainExclusiveOrExact(runtimePath, Buffer.from(input.verifiedBundle.bytes));
  return (input.startSidecar ?? startExp0001aArtifactPacketSidecar)({
    runRoot,
    packetId: input.action.packetId,
    inputPath,
    runtimeBundlePath: runtimePath,
  });
}

async function retainDispatchBeforeHandoff(input) {
  const outboxRoot = path.join(input.outputRoot, "coordinator-outbox");
  await mkdir(outboxRoot, { recursive: true, mode: 0o700 });
  const filePath = path.join(outboxRoot, `${input.actionDigest.replace(/^sha256:/, "")}.json`);
  const content = Object.freeze({
    schemaVersion: "exp-0001a-coordinator-dispatch/v1",
    protocolId: "EXP-0001A",
    actionDigest: input.actionDigest,
    runtimePreflightReceiptDigest: input.preflightReceiptDigest,
    configDigest: input.configDigest,
    retainedAt: input.retainedAt,
    actionKind: input.action.kind,
    action: input.action,
    expectedIngest: input.action.expectedIngest ?? null,
    authorityJournalEntryDigest: input.authorityJournalEntryDigest,
    authorityJournalRoot: input.authorityJournalRoot,
    externalToolInvokedByCli: false,
  });
  const receipt = Object.freeze({ ...content, dispatchDigest: sha256Canonical(content) });
  const publication = await retainExclusiveOrExact(filePath, Buffer.from(canonicalJson(receipt), "utf8"));
  const existing = await readPlainJson(filePath);
  const { dispatchDigest: _retainedDispatchDigest, ...retainedContent } = existing;
  void _retainedDispatchDigest;
  if (existing.actionDigest !== input.actionDigest
      || canonicalJson(existing.action) !== canonicalJson(input.action)
      || existing.runtimePreflightReceiptDigest !== input.preflightReceiptDigest
      || existing.configDigest !== input.configDigest
      || existing.authorityJournalEntryDigest !== input.authorityJournalEntryDigest
      || existing.authorityJournalRoot !== input.authorityJournalRoot
      || existing.dispatchDigest !== sha256Canonical(retainedContent)) {
    throw new Error("EXP0001A_COORDINATOR_OUTBOX_COLLISION_OR_TAMPERING");
  }
  return Object.freeze({ alreadyDispatched: !publication.published, filePath, receipt: existing });
}

async function readRetainedDispatch(input) {
  const outboxRoot = path.join(input.outputRoot, "coordinator-outbox");
  const filePath = path.join(outboxRoot, `${input.actionDigest.replace(/^sha256:/, "")}.json`);
  const existing = await readPlainJson(filePath).catch((error) => {
    if (error?.code === "ENOENT") throw new Error("EXP0001A_COORDINATOR_RESULT_HAS_NO_DURABLE_DISPATCH");
    throw error;
  });
  const { dispatchDigest: _dispatchDigest, ...content } = existing;
  void _dispatchDigest;
  if (existing.actionDigest !== input.actionDigest
      || existing.configDigest !== input.configDigest
      || existing.actionKind !== input.action.kind
      || canonicalJson(existing.action) !== canonicalJson(input.action)
      || canonicalJson(existing.expectedIngest) !== canonicalJson(input.action.expectedIngest ?? null)
      || existing.dispatchDigest !== sha256Canonical(content)) {
    throw new Error("EXP0001A_COORDINATOR_RESULT_DISPATCH_BINDING_INVALID");
  }
  return Object.freeze({ filePath, receipt: existing });
}

async function readRetainedDispatchByActionDigest(input) {
  const filePath = path.join(input.outputRoot, "coordinator-outbox",
    `${input.actionDigest.replace(/^sha256:/, "")}.json`);
  const receipt = await readPlainJson(filePath).catch((error) => {
    if (error?.code === "ENOENT") throw new Error("EXP0001A_ACKNOWLEDGEMENT_HAS_NO_DURABLE_DISPATCH");
    throw error;
  });
  const { dispatchDigest: _dispatchDigest, ...content } = receipt;
  void _dispatchDigest;
  if (receipt.actionDigest !== input.actionDigest
      || receipt.configDigest !== input.configDigest
      || sha256Canonical(receipt.action) !== input.actionDigest
      || receipt.actionKind !== receipt.action?.kind
      || canonicalJson(receipt.expectedIngest) !== canonicalJson(receipt.action?.expectedIngest ?? null)
      || receipt.dispatchDigest !== sha256Canonical(content)) {
    throw new Error("EXP0001A_RETAINED_DISPATCH_BINDING_INVALID");
  }
  return Object.freeze({ filePath, receipt });
}

async function readDispatchAcknowledgement(input) {
  const filePath = path.join(input.outputRoot, "coordinator-outbox-acks",
    `${input.actionDigest.replace(/^sha256:/, "")}.json`);
  const acknowledgement = await readPlainJson(filePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (acknowledgement === null) return null;
  const { acknowledgementDigest: _digest, ...content } = acknowledgement;
  void _digest;
  if (acknowledgement.actionDigest !== input.actionDigest
      || acknowledgement.dispatchDigest !== input.dispatchDigest
      || acknowledgement.configDigest !== input.configDigest
      || acknowledgement.callerAcknowledgedReceiptBeforeInvocation !== true
      || acknowledgement.blindRetryForbiddenAfterAcknowledgement !== true
      || acknowledgement.acknowledgementDigest !== sha256Canonical(content)) {
    throw new Error("EXP0001A_DISPATCH_ACKNOWLEDGEMENT_INVALID");
  }
  return Object.freeze({ filePath, acknowledgement });
}

async function retainDispatchAcknowledgement(input) {
  const prior = await readDispatchAcknowledgement(input);
  if (prior !== null) return Object.freeze({ alreadyRetained: true, ...prior });
  const content = Object.freeze({
    schemaVersion: "exp-0001a-coordinator-dispatch-acknowledgement/v1",
    protocolId: "EXP-0001A",
    actionDigest: input.actionDigest,
    dispatchDigest: input.dispatchDigest,
    configDigest: input.configDigest,
    acknowledgedAt: input.acknowledgedAt,
    callerAcknowledgedReceiptBeforeInvocation: true,
    blindRetryForbiddenAfterAcknowledgement: true,
  });
  const acknowledgement = Object.freeze({
    ...content,
    acknowledgementDigest: sha256Canonical(content),
  });
  const filePath = path.join(input.outputRoot, "coordinator-outbox-acks",
    `${input.actionDigest.replace(/^sha256:/, "")}.json`);
  const publication = await retainExclusiveOrExact(filePath, Buffer.from(canonicalJson(acknowledgement), "utf8"));
  const retained = await readDispatchAcknowledgement(input);
  if (retained === null || canonicalJson(retained.acknowledgement) !== canonicalJson(acknowledgement)) {
    throw new Error("EXP0001A_DISPATCH_ACKNOWLEDGEMENT_READBACK_DRIFT");
  }
  return Object.freeze({ alreadyRetained: !publication.published, ...retained });
}

async function readRetainedDispatchInventory(outputRoot, configDigest) {
  const directory = path.join(outputRoot, "coordinator-outbox");
  const names = await readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const receipts = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) {
      throw new Error(`EXP0001A_COORDINATOR_OUTBOX_UNEXPECTED_ENTRY:${name}`);
    }
    const receipt = await readPlainJson(path.join(directory, name));
    const { dispatchDigest: _digest, ...content } = receipt;
    void _digest;
    if (receipt.configDigest !== configDigest
        || receipt.actionDigest !== `sha256:${name.slice(0, 64)}`
        || sha256Canonical(receipt.action) !== receipt.actionDigest
        || receipt.actionKind !== receipt.action?.kind
        || canonicalJson(receipt.expectedIngest) !== canonicalJson(receipt.action?.expectedIngest ?? null)
        || receipt.dispatchDigest !== sha256Canonical(content)) {
      throw new Error(`EXP0001A_COORDINATOR_OUTBOX_INVENTORY_INVALID:${name}`);
    }
    receipts.push(receipt);
  }
  return Object.freeze(receipts);
}

function exactCompletionRuntimeChain(entries, dispatchReceipts) {
  const checkpoints = entries.filter((entry) => entry.kind === "coordinator_checkpoint");
  const preflights = entries.filter((entry) => entry.kind === "runtime_preflight");
  if (checkpoints.length === 0 || dispatchReceipts.length === 0) {
    throw new Error("EXP0001A_COMPLETION_AUTHORITY_RUNTIME_CHAIN_DENOMINATOR_INVALID");
  }
  const consumedPreflightEntries = new Set();
  const dispatchBoundPreflights = dispatchReceipts.map((dispatch) => {
    const matching = preflights.filter((entry) =>
      entry.entryDigest === dispatch.authorityJournalEntryDigest
        && entry.payload?.receiptDigest === dispatch.runtimePreflightReceiptDigest
        && entry.payload?.nextAction?.actionDigest === dispatch.actionDigest);
    if (matching.length !== 1 || consumedPreflightEntries.has(matching[0].entryDigest)) {
      throw new Error("EXP0001A_COMPLETION_DISPATCH_PREFLIGHT_BINDING_INVALID");
    }
    consumedPreflightEntries.add(matching[0].entryDigest);
    return matching[0];
  }).sort((left, right) => left.sequence - right.sequence);
  const consumedCheckpointDigests = new Set();
  const coordinatorCheckpoints = dispatchBoundPreflights.map((entry) => {
    const checkpoint = entry.payload?.coordinatorCheckpoint;
    const checkpointDigest = sha256Canonical(checkpoint);
    const matching = checkpoints.filter((candidate) => candidate.payloadDigest === checkpointDigest
      && canonicalJson(candidate.payload) === canonicalJson(checkpoint)
      && candidate.sequence < entry.sequence);
    if (matching.length !== 1 || consumedCheckpointDigests.has(checkpointDigest)) {
      throw new Error("EXP0001A_COMPLETION_AUTHORITY_PREFLIGHT_CHECKPOINT_BINDING_INVALID");
    }
    consumedCheckpointDigests.add(checkpointDigest);
    return checkpoint;
  });
  return Object.freeze({
    runtimePreflightReceipts: Object.freeze(dispatchBoundPreflights.map((entry) => entry.payload)),
    coordinatorCheckpoints: Object.freeze(coordinatorCheckpoints),
  });
}

export function deriveExp0001aDispatchBoundRuntimeChainForTesting(entries, dispatchReceipts) {
  return exactCompletionRuntimeChain(entries, dispatchReceipts);
}

async function writeExp0001aCompletionDraft(input) {
  const scientificState = input.coordinatorJournal.scientificState;
  if (scientificState === null || scientificState.transitionDigests?.length !== 9) {
    throw new Error("EXP0001A_COMPLETION_WRITER_REQUIRES_FINAL_NINE_TRANSITION_STATE");
  }
  const authority = await input.readAuthorityJournal(input.config.outputRoot);
  const dispatchReceipts = await readRetainedDispatchInventory(
    input.config.outputRoot,
    sha256Canonical(input.config),
  );
  const runtimeChain = exactCompletionRuntimeChain(authority.entries, dispatchReceipts);
  const provisioningPlan = input.runtime.createExp0001aAttemptProvisioningPlan();
  const evidence = Object.freeze({
    completedAt: input.completedAt,
    freeze: input.freeze,
    executionManifest: input.executionManifest,
    runtimePreflightReceipts: runtimeChain.runtimePreflightReceipts,
    coordinatorCheckpoints: runtimeChain.coordinatorCheckpoints,
    scheduler: input.provisioningState.scheduler,
    accountingLedger: input.runtime.deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal(
      input.coordinatorJournal,
    ),
    provisioningPlan,
    plans: input.coordinatorJournal.plans,
    lifecycles: input.coordinatorJournal.lifecycles,
    scientificState,
  });
  // The bundled creator is the authority boundary: it independently rebuilds
  // catalog/work orders/results/classifications/analysis from the minimal
  // evidence above. None of those caller-duplicated derived fields are stored.
  const draft = input.runtime.createExp0001aCodexCompletionAttestation(evidence);
  const retained = await retainExp0001aCompletionMaterializationPrefixForTesting({
    outputRoot: input.config.outputRoot,
    completedAt: input.completedAt,
    evidence,
    draft,
    scientificStateDigest: scientificState.stateDigest,
    provisioningPlanDigest: provisioningPlan.planDigest,
    appendAuthorityJournalEntry: input.appendAuthorityJournalEntry,
  });
  return Object.freeze({ evidence, draft, ...retained });
}

export async function retainExp0001aCompletionMaterializationPrefixForTesting(input) {
  const evidencePath = path.join(input.outputRoot, COMPLETION_EVIDENCE_FILE_NAME);
  const draftPath = path.join(input.outputRoot, COMPLETION_DRAFT_FILE_NAME);
  await retainExclusiveOrExact(evidencePath, Buffer.from(`${canonicalJson(input.evidence)}\n`, "utf8"));
  await input.afterEvidencePublished?.();
  await retainExclusiveOrExact(draftPath, Buffer.from(`${canonicalJson(input.draft)}\n`, "utf8"));
  await input.afterDraftPublished?.();
  const retained = await input.appendAuthorityJournalEntry({
    outputRoot: input.outputRoot,
    kind: "completion_draft",
    recordedAt: input.completedAt,
    payload: {
      schemaVersion: "exp-0001a-completion-draft-retention/v1",
      protocolId: "EXP-0001A",
      evidenceDigest: sha256Canonical(input.evidence),
      completionDigest: input.draft.completionDigest,
      scientificStateDigest: input.scientificStateDigest,
      provisioningPlanDigest: input.provisioningPlanDigest,
    },
  });
  return Object.freeze({ evidencePath, draftPath, authorityJournalEntry: retained.entry });
}

/**
 * Validate the committed subscription-only inputs. Execute handles one exact
 * signed-state-bound coordinator action. It may run deterministic local state
 * transitions or the loopback packet sidecar, but never invokes a Codex-app or
 * Jazzboard WebMCP action itself.
 */
export async function runExp0001aBatchCommand(argv, dependencies = {}) {
  const { configPath, mode, ingestResultPath, acknowledgedActionDigest, dispatchedActionDigest } = parseArguments(argv);
  const readJson = dependencies.readJson ?? readPlainJson;
  const verifyBundle = dependencies.verifyRuntimeBundle ?? verifyExp0001aRuntimeBundle;
  const loadRuntime = dependencies.loadRuntime ?? loadCommittedRuntime;
  const authPreflight = dependencies.runAuthPreflight ?? runCodexAuthPreflight;
  const verifyOuterSources = dependencies.verifyOuterSources ?? verifyExp0001aOuterExecutionSourceCommitments;
  const now = dependencies.now ?? (() => new Date());

  const verifiedBundle = await verifyBundle();
  const runtime = await loadRuntime();
  const rawConfig = await readJson(configPath);
  const config = runtime.exp0001aCodexRuntimeConfigSchema.parse(rawConfig);
  if (config.files.codexPrebriefFreeze !== path.join(
    REPO_ROOT, "research/data/exp-0001a-codex-prebrief-freeze-v2.json",
  ) || config.files.codexPrebriefFreezeSignature !== path.join(
    REPO_ROOT, "research/data/exp0001a-codex-prebrief-freeze-signature-v2.json",
  )) {
    throw new Error("EXP0001A_CODEX_PREBRIEF_FREEZE_AUTHORITY_PATH_NOT_PINNED");
  }
  if (config.runtimeBundleDigest !== verifiedBundle.bundleDigest) {
    throw new Error("EXP0001A_CODEX_RUNTIME_BUNDLE_DIGEST_DRIFT");
  }

  // A durable transaction is the canonical state. Repair any projections
  // left between atomic renames before validating a new checkpoint/action.
  await (dependencies.recoverCoordinatorMutation ?? recoverCoordinatorTransaction)(runtime, config);

  // This fresh subprocess result is the only auth authority used by the
  // dry-run preflight. A retained receipt is never accepted from config.
  const authReceipt = await authPreflight({ checkedAt: now().toISOString() });
  const [freeze, freezeAuthoritySignature, spikeGate, spikeEvidence, coordinatorCheckpoint, scheduler, accountingLedger,
    provisioningState, coordinatorJournal] = await Promise.all([
    readJson(config.files.codexPrebriefFreeze),
    readJson(config.files.codexPrebriefFreezeSignature),
    readJson(config.files.spikeGate),
    readJson(config.files.spikeEvidence),
    readJson(config.files.coordinatorCheckpoint),
    readJson(config.files.schedulerState),
    readJson(config.files.accountingLedger),
    readJson(config.files.provisioningCoordinatorState),
    readJson(config.files.coordinatorJournal),
  ]);
  const configDigest = sha256Canonical(config);
  const readAuthorityJournal = dependencies.readAuthorityJournal ?? readExp0001aAuthorityJournal;
  const appendAuthorityJournalEntry = dependencies.appendAuthorityJournalEntry ?? appendExp0001aAuthorityJournalEntry;
  let checkedAt = now().toISOString();
  const authorizedFreeze = runtime.verifyExp0001aCodexPrebriefFreezeAuthority({
    freeze,
    authoritySignature: freezeAuthoritySignature,
    verifiedAt: checkedAt,
  });
  await verifyOuterSources({ freeze: authorizedFreeze, repositoryRoot: REPO_ROOT });
  let preflight;
  let result;
  let historicalPendingDispatch = null;
  try {
    preflight = runtime.createExp0001aCodexRuntimePreflight({
      checkedAt,
      runtimeBundleDigest: verifiedBundle.bundleDigest,
      authorizedPrebriefFreezePayloadDigest: config.authorizedPrebriefFreezePayloadDigest,
      authorizedPrebriefFreezeSignatureDigest: config.authorizedPrebriefFreezeSignatureDigest,
      freeze,
      freezeAuthoritySignature,
      authPreflightReceipt: authReceipt,
      spikeGate,
      spikeEvidence,
      scheduler,
      accountingLedger,
      provisioningState,
      coordinatorJournal,
      coordinatorCheckpoint,
    });
    result = await runtime.runExp0001aCodexRuntime({
      mode: mode === "dry-run" ? "dry-run" : "execute",
      executionCheckedAt: now().toISOString(),
      preflight,
      provisioningState,
      coordinatorJournal,
    });
  } catch (error) {
    const stale = /CHECKPOINT_STALE|PREFLIGHT_AUTHORITY_STALE/.test(error instanceof Error ? error.message : "");
    if (mode !== "ingest" || dispatchedActionDigest === null || !stale) throw error;
    historicalPendingDispatch = await readRetainedDispatchByActionDigest({
      outputRoot: config.outputRoot,
      actionDigest: dispatchedActionDigest,
      configDigest,
    });
    const acknowledgement = await readDispatchAcknowledgement({
      outputRoot: config.outputRoot,
      actionDigest: dispatchedActionDigest,
      dispatchDigest: historicalPendingDispatch.receipt.dispatchDigest,
      configDigest,
    });
    if (acknowledgement === null) {
      throw new Error("EXP0001A_PENDING_DISPATCH_RESULT_REQUIRES_PRIOR_DELIVERY_ACKNOWLEDGEMENT");
    }
    const authority = await readAuthorityJournal(config.outputRoot);
    const matchingPreflights = authority.entries.filter((entry) =>
      entry.kind === "runtime_preflight"
        && entry.entryDigest === historicalPendingDispatch.receipt.authorityJournalEntryDigest
        && entry.payload?.receiptDigest === historicalPendingDispatch.receipt.runtimePreflightReceiptDigest);
    if (matchingPreflights.length !== 1) {
      throw new Error("EXP0001A_PENDING_DISPATCH_HISTORICAL_PREFLIGHT_BINDING_INVALID");
    }
    preflight = runtime.verifyExp0001aCodexRuntimePreflight(
      matchingPreflights[0].payload,
      matchingPreflights[0].payload.checkedAt,
    );
    if (preflight.provisioningStateDigest !== provisioningState.stateDigest
        || preflight.coordinatorJournalDigest !== coordinatorJournal.journalDigest
        || preflight.nextAction.actionDigest !== dispatchedActionDigest) {
      throw new Error("EXP0001A_PENDING_DISPATCH_PRIOR_STATE_DRIFT");
    }
    checkedAt = preflight.checkedAt;
    result = Object.freeze({
      mode: "execute",
      status: "ready_for_coordinator",
      executionAllowed: true,
      action: historicalPendingDispatch.receipt.action,
      actionDigest: dispatchedActionDigest,
      externalToolInvokedByRuntime: false,
      callerMustPerformAndRetainResult: true,
      preflight,
      versions: {},
    });
  }
  const readiness = verifyExp0001aCodexLaunchReadinessReceipt(
    createExp0001aCodexLaunchReadinessReceipt({
      checkedAt,
      configDigest: sha256Canonical(config),
      runtimeBundleDigest: verifiedBundle.bundleDigest,
      runtimePreflight: preflight,
    }),
  );
  let preexistingDispatch = null;
  if (mode !== "dry-run" && result.action.kind !== "experiment_complete") {
    try {
      preexistingDispatch = {
        alreadyDispatched: true,
        ...await readRetainedDispatch({
          outputRoot: config.outputRoot,
          actionDigest: result.actionDigest,
          action: result.action,
          configDigest,
        }),
      };
    } catch (error) {
      if (mode === "ingest" || error?.message !== "EXP0001A_COORDINATOR_RESULT_HAS_NO_DURABLE_DISPATCH") {
        throw error;
      }
    }
  }
  let authorityJournal = null;
  let retainedAuthoritySnapshot = null;
  if (mode !== "dry-run") {
    const retainedAuthority = await readAuthorityJournal(config.outputRoot);
    retainedAuthoritySnapshot = retainedAuthority;
    const checkpointDigest = sha256Canonical(preflight.coordinatorCheckpoint);
    if (!retainedAuthority.entries.some((entry) => entry.kind === "coordinator_checkpoint"
        && entry.payloadDigest === checkpointDigest
        && canonicalJson(entry.payload) === canonicalJson(preflight.coordinatorCheckpoint))) {
      throw new Error("EXP0001A_SIGNED_CHECKPOINT_NOT_IN_APPEND_ONLY_AUTHORITY_JOURNAL");
    }
    if (preexistingDispatch === null) {
      authorityJournal = await appendAuthorityJournalEntry({
        outputRoot: config.outputRoot,
        kind: "runtime_preflight",
        recordedAt: preflight.checkedAt,
        payload: preflight,
      });
    } else {
      const matching = retainedAuthority.entries.filter((entry) =>
        entry.kind === "runtime_preflight"
          && entry.entryDigest === preexistingDispatch.receipt.authorityJournalEntryDigest
          && entry.payload?.receiptDigest === preexistingDispatch.receipt.runtimePreflightReceiptDigest);
      if (matching.length !== 1) {
        throw new Error("EXP0001A_DISPATCH_RUNTIME_PREFLIGHT_AUTHORITY_BINDING_INVALID");
      }
      authorityJournal = Object.freeze({
        alreadyRetained: true,
        entry: matching[0],
        journalRoot: retainedAuthority.journalRoot,
      });
    }
  }
  if (mode === "execute" && result.action.kind === "experiment_complete") {
    const [evidence, attestation, retainedAuthority] = await Promise.all([
      readJson(path.join(config.outputRoot, COMPLETION_EVIDENCE_FILE_NAME)),
      readJson(path.join(config.outputRoot, COMPLETION_ATTESTATION_FILE_NAME)),
      readAuthorityJournal(config.outputRoot),
    ]);
    const verified = runtime.verifyExp0001aCodexCompletionAttestation({
      attestation,
      evidence,
      verifiedAt: now().toISOString(),
    });
    const signedDigest = sha256Canonical(verified);
    if (coordinatorJournal.reviewProgress.signedCompletionAttestationDigest !== signedDigest
        || !retainedAuthority.entries.some((entry) => entry.kind === "completion_attestation"
          && entry.payload?.signedCompletionAttestationDigest === signedDigest
          && canonicalJson(entry.payload?.attestation) === canonicalJson(verified))) {
      throw new Error("EXP0001A_EXPERIMENT_COMPLETE_AUTHORITY_CHAIN_INVALID");
    }
    return Object.freeze({
      mode,
      status: "experiment_complete",
      executionAllowed: false,
      externalToolInvokedByCli: false,
      actionReemitted: false,
      configPath,
      readiness,
      authorityJournalEntry: authorityJournal?.entry ?? null,
      signedCompletionAttestationDigest: signedDigest,
    });
  }
  const dispatch = mode === "execute"
    ? preexistingDispatch ?? await retainDispatchBeforeHandoff({
      outputRoot: config.outputRoot,
      actionDigest: result.actionDigest,
      action: result.action,
      preflightReceiptDigest: preflight.receiptDigest,
      configDigest,
      retainedAt: now().toISOString(),
      authorityJournalEntryDigest: authorityJournal.entry.entryDigest,
      authorityJournalRoot: authorityJournal.journalRoot,
    })
    : mode === "ingest" || mode === "acknowledge"
      ? preexistingDispatch
      : null;
  const isCompletionAction = result.action.kind === "perform_scientific_phase_transition"
    && result.action.transition === "create_and_sign_completion_attestation";
  const replayableLocalAction = [
    "perform_provisioning_local_transition",
    "release_reserved_create_room",
    "prepare_author_task",
    "record_create_thread_release_invocation",
    "perform_scientific_phase_transition",
    "start_artifact_packet_sidecar",
    "stop_artifact_packet_sidecar",
  ].includes(result.action.kind);
  const externalDispatchRequiresAcknowledgement = !replayableLocalAction && !isCompletionAction
    && result.action.kind !== "experiment_complete";
  let dispatchAcknowledgement = null;
  if (dispatch !== null && externalDispatchRequiresAcknowledgement) {
    dispatchAcknowledgement = await readDispatchAcknowledgement({
      outputRoot: config.outputRoot,
      actionDigest: result.actionDigest,
      dispatchDigest: dispatch.receipt.dispatchDigest,
      configDigest,
    });
  }
  if (mode === "acknowledge") {
    if (dispatch === null || acknowledgedActionDigest !== result.actionDigest
        || !externalDispatchRequiresAcknowledgement) {
      throw new Error("EXP0001A_DISPATCH_ACKNOWLEDGEMENT_ACTION_NOT_CURRENT_EXTERNAL_DISPATCH");
    }
    const retainedAcknowledgement = await retainDispatchAcknowledgement({
      outputRoot: config.outputRoot,
      actionDigest: result.actionDigest,
      dispatchDigest: dispatch.receipt.dispatchDigest,
      configDigest,
      acknowledgedAt: now().toISOString(),
    });
    return Object.freeze({
      mode,
      status: "dispatch_delivery_acknowledged",
      executionAllowed: true,
      externalToolInvokedByCli: false,
      actionReemitted: false,
      callerMayInvokePreviouslyRetainedActionExactlyOnce: true,
      callerMustRetainRawResultBeforeNextAction: true,
      configPath,
      readiness,
      dispatchReceipt: dispatch.receipt,
      dispatchAcknowledgement: retainedAcknowledgement.acknowledgement,
      actionReference: Object.freeze({ actionDigest: result.actionDigest, actionKind: result.action.kind }),
    });
  }
  if (mode === "execute" && dispatch !== null && externalDispatchRequiresAcknowledgement
      && dispatchAcknowledgement === null) {
    return Object.freeze({
      mode,
      status: "dispatch_prepared_requires_delivery_acknowledgement",
      executionAllowed: false,
      externalToolInvokedByCli: false,
      actionReemitted: dispatch.alreadyDispatched,
      callerMustNotInvokeBeforeAcknowledgement: true,
      configPath,
      readiness,
      dispatchReceipt: dispatch.receipt,
      authorityJournalEntry: authorityJournal?.entry ?? null,
      acknowledgementCommand: Object.freeze({
        command: "node",
        arguments: Object.freeze([
          "research/scripts/exp0001a-batch-command.mjs",
          "--ack-dispatch",
          result.actionDigest,
          "--config",
          configPath,
        ]),
      }),
      result,
    });
  }
  if (mode === "ingest" && externalDispatchRequiresAcknowledgement) {
    if (dispatch === null || dispatchedActionDigest !== result.actionDigest || dispatchAcknowledgement === null) {
      throw new Error("EXP0001A_EXTERNAL_RESULT_REQUIRES_EXACT_ACKNOWLEDGED_DISPATCH");
    }
  }
  if (mode === "execute" && dispatch !== null && isCompletionAction) {
    const writeCompletion = async () => (dependencies.writeCompletionDraft ?? writeExp0001aCompletionDraft)({
        runtime,
        config,
        freeze,
        executionManifest: await readJson(
          path.join(REPO_ROOT, "research/data/development-execution-manifest-v1.json"),
        ),
        provisioningState,
        coordinatorJournal,
        // The immutable dispatch timestamp is the completion materialization
        // timestamp. Replays after a crash must reconstruct byte-identical
        // evidence rather than mint a new timestamped completion candidate.
        completedAt: dispatch.receipt.retainedAt,
        readAuthorityJournal,
        appendAuthorityJournalEntry,
      });
    // This exact-byte materializer is intentionally replayed for every prefix:
    // dispatch-only, evidence-only, evidence+draft, or missing authority entry.
    // Exclusive-or-exact publication plus idempotent authority append repairs
    // the prefix without changing the approved digest.
    const written = await writeCompletion();
    const reconstructed = runtime.createExp0001aCodexCompletionAttestation(written.evidence);
    if (canonicalJson(reconstructed) !== canonicalJson(written.draft)) {
      throw new Error("EXP0001A_RETAINED_COMPLETION_DRAFT_RECONSTRUCTION_DRIFT");
    }
    return Object.freeze({
      mode,
      status: "awaiting_completion_digest_approval",
      executionAllowed: false,
      externalToolInvokedByCli: false,
      actionReemitted: false,
      configPath,
      readiness,
      dispatchReceipt: dispatch.receipt,
      authorityJournalEntry: written.authorityJournalEntry,
      completionDigest: written.draft.completionDigest,
      evidenceDigest: sha256Canonical(written.evidence),
      completionEvidencePath: written.evidencePath,
      completionDraftPath: written.draftPath,
      signerCommand: Object.freeze({
        command: "node",
        arguments: Object.freeze([
          "research/scripts/sign-exp0001a-completion.mjs",
          "--run-root",
          config.outputRoot,
          "--approved-completion-digest",
          written.draft.completionDigest,
        ]),
      }),
      nextCheckpointRequired: false,
    });
  }
  if (dispatch?.alreadyDispatched && mode === "execute" && !replayableLocalAction) {
    return Object.freeze({
      mode,
      status: "acknowledged_dispatch_delivery_ambiguous_requires_result_or_reconciliation",
      executionAllowed: false,
      externalToolInvokedByCli: false,
      actionReemitted: false,
      configPath,
      readiness,
      dispatchReceipt: dispatch.receipt,
      authorityJournalEntry: authorityJournal?.entry ?? null,
      reconciliation: {
        kind: result.action.ambiguityReconciliation === undefined
          ? "retain_raw_result_or_fail_closed_manual_reconciliation"
          : "perform_exact_ambiguity_reconciliation",
        expectedIngest: dispatch.receipt.expectedIngest,
        command: result.action.ambiguityReconciliation ?? null,
        blindRetryOfMutatingCommandForbidden: true,
      },
    });
  }
  if (mode === "ingest" && dispatch !== null) {
    const action = result.action;
    if (ingestResultPath === null) throw new Error("EXP0001A_COORDINATOR_INGEST_RESULT_PATH_MISSING");
    if (isCompletionAction) {
      const [evidence, attestation] = await Promise.all([
        readJson(path.join(config.outputRoot, COMPLETION_EVIDENCE_FILE_NAME)),
        readJson(ingestResultPath),
      ]);
      const observedAt = now().toISOString();
      const mutation = runtime.retainExp0001aCoordinatorCompletionAttestation({
        verifiedAt: observedAt,
        provisioningState,
        coordinatorJournal,
        evidence,
        attestation,
      });
      const signedCompletionAttestationDigest = mutation.retainedEvidenceDigest;
      const resultRetention = await appendAuthorityJournalEntry({
        outputRoot: config.outputRoot,
        kind: "completion_attestation",
        recordedAt: observedAt,
        payload: {
          schemaVersion: "exp-0001a-completion-attestation-retention/v1",
          protocolId: "EXP-0001A",
          actionDigest: result.actionDigest,
          dispatchDigest: dispatch.receipt.dispatchDigest,
          evidenceDigest: sha256Canonical(evidence),
          signedCompletionAttestationDigest,
          attestation,
        },
      });
      const retainedState = dependencies.persistCoordinatorMutation
        ? await dependencies.persistCoordinatorMutation(runtime, config, mutation)
        : await persistCoordinatorTransaction(runtime, config, mutation, {
          actionDigest: result.actionDigest,
          retainedAt: observedAt,
        });
      return Object.freeze({
        mode,
        status: "completion_attestation_ingested",
        executionAllowed: false,
        externalToolInvokedByCli: false,
        actionReemitted: false,
        configPath,
        readiness,
        dispatchReceipt: dispatch.receipt,
        authorityJournalEntry: resultRetention.entry,
        signedCompletionAttestationDigest,
        retainedState,
        nextCheckpointRequired: true,
      });
    }
    if (action.kind === "run_subscription_availability_probe") {
      const probeEvidence = await readJson(ingestResultPath);
      const expectedProbeRequest = {
        prompt: action.prompt,
        promptDigest: action.promptDigest,
        accountingRole: action.accountingRole,
        target: action.target,
        createThreadCommand: action.createThreadCommand,
        benchmarkContentIncluded: action.benchmarkContentIncluded,
        mayReleaseExperimentBrief: action.mayReleaseExperimentBrief,
      };
      if (canonicalJson(probeEvidence?.request) !== canonicalJson(expectedProbeRequest)) {
        throw new Error("EXP0001A_SUBSCRIPTION_PROBE_EVIDENCE_DOES_NOT_BIND_DISPATCHED_COMMAND");
      }
      const signed = await (dependencies.signUsageResetProbe ?? signExp0001aUsageResetProbeFromConfig)({
        configPath,
        probeEvidencePath: ingestResultPath,
      });
      return Object.freeze({
        mode,
        status: "subscription_probe_result_retained",
        executionAllowed: false,
        externalToolInvokedByCli: false,
        actionReemitted: false,
        configPath,
        readiness,
        dispatchReceipt: dispatch.receipt,
        authorityJournalEntry: authorityJournal?.entry ?? null,
        retainedProbeResult: signed,
        nextCheckpointRequired: true,
      });
    }
    if (!("expectedIngest" in action)
        || action.kind === "start_artifact_packet_sidecar"
        || action.kind === "stop_artifact_packet_sidecar") {
      throw new Error(`EXP0001A_COORDINATOR_ACTION_DOES_NOT_ACCEPT_EXTERNAL_RESULT:${action.kind}`);
    }
    const rawResult = await readJson(ingestResultPath);
    const priorResultEntries = retainedAuthoritySnapshot.entries.filter((entry) =>
      entry.kind === "coordinator_action_result"
        && entry.payload?.actionDigest === result.actionDigest
        && entry.payload?.dispatchDigest === dispatch.receipt.dispatchDigest);
    if (priorResultEntries.length > 1) {
      throw new Error("EXP0001A_COORDINATOR_ACTION_RESULT_AUTHORITY_DUPLICATED");
    }
    const priorResultEntry = priorResultEntries[0] ?? null;
    if (priorResultEntry !== null
        && (priorResultEntry.payload?.rawResultDigest !== sha256Canonical(rawResult)
          || canonicalJson(priorResultEntry.payload?.rawResult) !== canonicalJson(rawResult)
          || canonicalJson(priorResultEntry.payload?.expectedIngest) !== canonicalJson(action.expectedIngest))) {
      throw new Error("EXP0001A_COORDINATOR_ACTION_RESULT_REPLAY_DRIFT");
    }
    const stagedProvisioning = await createExp0001aStagedProvisioningCoordinator(
      runtime,
      config,
      provisioningState,
      result.actionDigest,
    );
    const provisioningCoordinator = stagedProvisioning.coordinator;
    const observedAt = priorResultEntry?.payload?.observedAt ?? now().toISOString();
    const mutation = await runtime.ingestExp0001aCoordinatorActionResult({
      action,
      rawResult,
      observedAt,
      provisioningState,
      coordinatorJournal,
      provisioningCoordinator,
      spikeGate,
      spikeEvidence,
    });
    const resultPayload = {
        schemaVersion: "exp-0001a-coordinator-action-result-retention/v1",
        protocolId: "EXP-0001A",
        actionDigest: result.actionDigest,
        dispatchDigest: dispatch.receipt.dispatchDigest,
        expectedIngest: action.expectedIngest,
        observedAt,
        rawResult,
        rawResultDigest: sha256Canonical(rawResult),
        priorProvisioningStateDigest: provisioningState.stateDigest,
        priorCoordinatorJournalDigest: coordinatorJournal.journalDigest,
        nextProvisioningStateDigest: mutation.provisioningState.stateDigest,
        nextCoordinatorJournalDigest: mutation.coordinatorJournal.journalDigest,
        retainedEvidenceDigest: mutation.retainedEvidenceDigest,
      };
    if (priorResultEntry !== null
        && canonicalJson(priorResultEntry.payload) !== canonicalJson(resultPayload)) {
      throw new Error("EXP0001A_COORDINATOR_ACTION_RESULT_RECONSTRUCTION_DRIFT");
    }
    const resultRetention = priorResultEntry === null
      ? await appendAuthorityJournalEntry({
        outputRoot: config.outputRoot,
        kind: "coordinator_action_result",
        recordedAt: observedAt,
        payload: resultPayload,
      })
      : Object.freeze({ alreadyRetained: true, entry: priorResultEntry,
        journalRoot: retainedAuthoritySnapshot.journalRoot });
    const retainedState = dependencies.persistCoordinatorMutation
      ? await dependencies.persistCoordinatorMutation(runtime, config, mutation)
      : await persistCoordinatorTransaction(runtime, config, mutation, {
        actionDigest: result.actionDigest,
        retainedAt: observedAt,
        stagingProvisioningPath: stagedProvisioning.stagingPath,
      });
    return Object.freeze({
      mode,
      status: "coordinator_action_result_ingested",
      executionAllowed: false,
      externalToolInvokedByCli: false,
      actionReemitted: false,
      configPath,
      readiness,
      dispatchReceipt: dispatch.receipt,
      authorityJournalEntry: resultRetention.entry,
      completedActionKind: action.kind,
      retainedState,
      nextCheckpointRequired: true,
    });
  }
  if (mode === "execute" && dispatch !== null) {
    const action = result.action;
    let stagedProvisioning = null;
    const getProvisioningCoordinator = async () => {
      stagedProvisioning ??= await createExp0001aStagedProvisioningCoordinator(
        runtime,
        config,
        provisioningState,
        result.actionDigest,
      );
      return stagedProvisioning.coordinator;
    };
    let mutation = null;
    let packetSidecarInvokedByCli = false;
    if (action.kind === "start_artifact_packet_sidecar") {
      const rawResult = await (dependencies.executePacketSidecarAction ?? executePacketSidecarAction)({
        config,
        action,
        verifiedBundle,
        startSidecar: dependencies.startArtifactPacketSidecar,
      });
      mutation = await runtime.ingestExp0001aCoordinatorActionResult({
        action,
        rawResult,
        observedAt: now().toISOString(),
        provisioningState,
        coordinatorJournal,
        provisioningCoordinator: await getProvisioningCoordinator(),
        spikeGate,
        spikeEvidence,
      });
      packetSidecarInvokedByCli = true;
    } else if (action.kind === "stop_artifact_packet_sidecar") {
      const rawResult = await (dependencies.stopArtifactPacketSidecar ?? stopExp0001aArtifactPacketSidecar)({
        runRoot: path.join(config.outputRoot, "packet-sidecar-runtime"),
        packetId: action.packetId,
        taskLifecycleState: action.taskLifecycleState,
      });
      mutation = await runtime.ingestExp0001aCoordinatorActionResult({
        action,
        rawResult,
        observedAt: now().toISOString(),
        provisioningState,
        coordinatorJournal,
        provisioningCoordinator: await getProvisioningCoordinator(),
      });
      packetSidecarInvokedByCli = true;
    } else if ([
      "perform_provisioning_local_transition",
      "release_reserved_create_room",
      "prepare_author_task",
      "record_create_thread_release_invocation",
      "perform_scientific_phase_transition",
    ].includes(action.kind)) {
      const [executionManifest, reviewPlanManifest] = await Promise.all([
        readJson(path.join(REPO_ROOT, "research/data/development-execution-manifest-v1.json")),
        readJson(path.join(REPO_ROOT, "research/data/exp0001a-codex-review-plan-v1.json")),
      ]);
      mutation = await runtime.executeExp0001aCoordinatorLocalAction({
        action,
        provisioningState,
        coordinatorJournal,
        provisioningCoordinator: await getProvisioningCoordinator(),
        spikeGate,
        spikeEvidence,
        scientificInputs: {
          freeze,
          executionManifest,
          provisioningPlan: runtime.createExp0001aAttemptProvisioningPlan(),
          reviewPlanManifest,
        },
      });
    }
    if (mutation !== null) {
      const retainedState = dependencies.persistCoordinatorMutation
        ? await dependencies.persistCoordinatorMutation(runtime, config, mutation)
        : await persistCoordinatorTransaction(runtime, config, mutation, {
          actionDigest: result.actionDigest,
          retainedAt: dispatch.receipt.retainedAt,
          stagingProvisioningPath: stagedProvisioning?.stagingPath,
        });
      return Object.freeze({
        mode,
        status: "coordinator_action_completed",
        executionAllowed: false,
        externalToolInvokedByCli: false,
        packetSidecarInvokedByCli,
        actionReemitted: false,
        configPath,
        readiness,
        dispatchReceipt: dispatch.receipt,
        authorityJournalEntry: authorityJournal?.entry ?? null,
        completedActionKind: action.kind,
        retainedState,
        nextCheckpointRequired: true,
      });
    }
  }
  return Object.freeze({
    mode,
    status: "ready_for_coordinator",
    executionAllowed: mode === "execute",
    externalToolInvokedByCli: false,
    callerMustPerformAndRetainResult: true,
    actionReemitted: false,
    configPath,
    readiness,
    dispatchReceipt: dispatch?.receipt ?? null,
    authorityJournalEntry: authorityJournal?.entry ?? null,
    result,
  });
}

async function main() {
  const result = await runExp0001aBatchCommand(process.argv.slice(2));
  process.stdout.write(`${canonicalJson(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
