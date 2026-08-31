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
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EXP0001A_RUNTIME_OUTPUT,
  verifyExp0001aRuntimeBundle,
} from "./build-exp0001a-runtime.mjs";
import {
  appendExp0001aAuthorityJournalEntry,
  readExp0001aAuthorityJournal,
} from "./exp0001a-authority-journal.mjs";
import {
  createExp0001aStagedProvisioningCoordinator,
  persistExp0001aCoordinatorMutation,
  recoverExp0001aCoordinatorMutation,
} from "./exp0001a-coordinator-transaction.mjs";
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
const PROBE_PROMPT =
  "Availability probe only. Do not open Jazzboard, access a repository, or perform experiment work. Return exactly SUBSCRIPTION_AVAILABLE.";
const PROBE_PROMPT_DIGEST =
  "sha256:2efa901c987a4dc1083b82ca442f3478f3226206043adf7a69023b9a3ecd4713";
const PROBE_MAX_AGE_MS = 5 * 60_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const PROBE_SUFFIX_PATTERN = /^[0-9]+-[a-f0-9]{12}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OUTBOX_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;

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

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} must contain exactly ${keys.join(", ")}.`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an RFC3339 timestamp.`);
  }
  return value;
}

function id(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest.`);
  }
  return value;
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
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function readPlainJson(filePath, label, requiredMode = null) {
  const bytes = await readPlainFile(filePath, label, requiredMode);
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is not valid JSON.`); }
}

async function readPrivateDirectoryNames(directory, label) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error(`${label} must be a private plain directory.`);
  }
  return (await readdir(directory)).sort();
}

async function loadAuthority() {
  const [privatePath, publicPath] = await Promise.all([
    realpath(AUTHORITY_PRIVATE_KEY_PATH),
    realpath(AUTHORITY_PUBLIC_KEY_PATH),
  ]);
  if (privatePath !== AUTHORITY_PRIVATE_KEY_PATH || publicPath !== AUTHORITY_PUBLIC_KEY_PATH) {
    throw new Error("Usage-reset authority paths must be canonical and non-symlinked.");
  }
  const [privateBytes, publicBytes] = await Promise.all([
    readPlainFile(privatePath, "Usage-reset authority private key", 0o600),
    readPlainFile(publicPath, "Usage-reset authority public key"),
  ]);
  if (sha256Bytes(publicBytes) !== AUTHORITY_PUBLIC_KEY_DIGEST) {
    throw new Error("Usage-reset authority public key differs from the precommitted trust anchor.");
  }
  const privateKey = createPrivateKey(privateBytes);
  const publicKey = createPublicKey(publicBytes);
  const derivedPublic = createPublicKey(privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519"
      || !Buffer.from(publicKey.export({ type: "spki", format: "der" }))
        .equals(Buffer.from(derivedPublic.export({ type: "spki", format: "der" })))) {
    throw new Error("Usage-reset authority private key does not match the fixed Ed25519 public key.");
  }
  return { privateKey, publicKey };
}

export function createExp0001aUsageResetProbeSignatureForTesting(input) {
  const content = {
    schemaVersion: "exp-0001a-codex-authority-signature/v1",
    protocolId: "EXP-0001A",
    kind: "codex-authority-signature",
    algorithm: "Ed25519",
    keyId: AUTHORITY_KEY_ID,
    publicKeyDigest: AUTHORITY_PUBLIC_KEY_DIGEST,
    signedAt: input.signedAt,
    purpose: "usage_reset_probe",
    payloadDigest: sha256Canonical(input.payload),
  };
  const message = Buffer.from(`${AUTHORITY_DOMAIN}${canonicalJson(content)}`, "utf8");
  const signature = signEd25519(null, message, input.authority.privateKey);
  if (signature.length !== 64 || !verifyEd25519(null, message, input.authority.publicKey, signature)) {
    throw new Error("Usage-reset probe signature failed immediate public-key verification.");
  }
  return Object.freeze({ ...content, signatureBase64: signature.toString("base64") });
}

function retainCallToolResult(input, label) {
  const raw = canonicalize(input);
  const failed = (failureCode) => Object.freeze({
    raw,
    rawDigest: sha256Canonical(raw),
    isError: true,
    payload: null,
    failureCode,
  });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || typeof raw.isError !== "boolean" || !Array.isArray(raw.content) || raw.content.length !== 1) {
    return failed(`${label.replaceAll(" ", "_").toLowerCase()}_wrapper_invalid`);
  }
  const block = raw.content[0];
  if (block === null || typeof block !== "object" || Array.isArray(block)
      || block.type !== "text" || typeof block.text !== "string") {
    return failed(`${label.replaceAll(" ", "_").toLowerCase()}_text_block_invalid`);
  }
  let payload = null;
  try { payload = canonicalize(JSON.parse(block.text)); } catch {
    if (!raw.isError) return failed(`${label.replaceAll(" ", "_").toLowerCase()}_success_text_not_json`);
  }
  return Object.freeze({
    raw,
    rawDigest: sha256Canonical(raw),
    isError: raw.isError,
    payload,
    failureCode: raw.isError ? `${label.replaceAll(" ", "_").toLowerCase()}_tool_error` : null,
  });
}

function parseProbeEvidence(input, signedAt) {
  const evidence = exactObject(input, [
    "schemaVersion", "kind", "probeId", "accountingId", "assignmentId", "attemptId",
    "request", "create", "terminal", "subscriptionUsageBefore", "subscriptionUsageAfter",
  ], "Subscription probe evidence");
  if (evidence.schemaVersion !== "exp-0001a-subscription-probe-evidence/v1"
      || evidence.kind !== "retained-subscription-availability-probe") {
    throw new Error("Subscription probe evidence schema is invalid.");
  }
  const request = exactObject(evidence.request, [
    "prompt", "promptDigest", "accountingRole", "target", "createThreadCommand",
    "benchmarkContentIncluded", "mayReleaseExperimentBrief",
  ], "Subscription probe request");
  if (request.prompt !== PROBE_PROMPT || request.promptDigest !== PROBE_PROMPT_DIGEST
      || request.accountingRole !== "subscription_probe"
      || canonicalJson(request.target) !== canonicalJson({ type: "projectless" })
      || request.benchmarkContentIncluded !== false || request.mayReleaseExperimentBrief !== false) {
    throw new Error("Subscription probe request is not the fixed neutral no-brief request.");
  }
  const command = exactObject(request.createThreadCommand, [
    "schemaVersion", "toolName", "arguments", "commandDigest",
  ], "Subscription probe create_thread command");
  const commandArguments = exactObject(command.arguments, [
    "prompt", "title", "target", "model", "thinking",
  ], "Subscription probe create_thread arguments");
  const commandTarget = exactObject(commandArguments.target, [
    "type", "directoryName",
  ], "Subscription probe projectless target");
  const titlePrefix = "EXP0001A subscription probe ";
  const directoryPrefix = "exp0001a-subscription-probe-";
  const titleSuffix = typeof commandArguments.title === "string"
    ? commandArguments.title.slice(titlePrefix.length)
    : "";
  const directorySuffix = typeof commandTarget.directoryName === "string"
    ? commandTarget.directoryName.slice(directoryPrefix.length)
    : "";
  const commandContent = {
    schemaVersion: command.schemaVersion,
    toolName: command.toolName,
    arguments: commandArguments,
  };
  if (command.schemaVersion !== 1
      || command.toolName !== "mcp__codex_app__create_thread"
      || commandArguments.prompt !== PROBE_PROMPT
      || commandArguments.model !== "gpt-5.6-sol"
      || commandArguments.thinking !== "low"
      || commandTarget.type !== "projectless"
      || typeof commandArguments.title !== "string"
      || typeof commandTarget.directoryName !== "string"
      || !commandArguments.title.startsWith(titlePrefix)
      || !commandTarget.directoryName.startsWith(directoryPrefix)
      || titleSuffix !== directorySuffix
      || !PROBE_SUFFIX_PATTERN.test(titleSuffix)
      || command.commandDigest !== sha256Canonical(commandContent)) {
    throw new Error("Subscription probe create_thread command is not the exact isolated frozen request.");
  }
  if (evidence.subscriptionUsageBefore !== "unobservable"
      || evidence.subscriptionUsageAfter !== "unobservable") {
    throw new Error("Subscription usage is unobservable unless a future fixed raw host-result verifier is installed.");
  }
  const create = exactObject(evidence.create, ["observedAt", "rawCallResult"], "Subscription probe create");
  const terminal = exactObject(evidence.terminal, ["observedAt", "rawCallResult"], "Subscription probe terminal");
  const createAt = timestamp(create.observedAt, "Subscription probe create observedAt");
  const terminalAt = timestamp(terminal.observedAt, "Subscription probe terminal observedAt");
  const signedMs = Date.parse(signedAt);
  if (Date.parse(terminalAt) < Date.parse(createAt) || signedMs < Date.parse(terminalAt)
      || signedMs - Date.parse(terminalAt) > PROBE_MAX_AGE_MS) {
    throw new Error("Subscription probe timestamps are non-monotonic or stale.");
  }
  const createResult = retainCallToolResult(create.rawCallResult, "Subscription probe create");
  const terminalResult = retainCallToolResult(terminal.rawCallResult, "Subscription probe terminal");
  let task = null;
  let createFailureCode = createResult.failureCode;
  if (!createResult.isError && createResult.payload !== null) {
    try {
      const created = exactObject(createResult.payload, ["threadId", "hostId"], "Subscription probe create payload");
      task = { codexTaskId: id(created.threadId, "Probe threadId"), threadId: created.threadId, hostId: id(created.hostId, "Probe hostId") };
    } catch {
      createFailureCode = "probe_create_payload_invalid";
    }
  }
  let success = false;
  let failureCode = task === null ? createFailureCode ?? "probe_create_failed"
    : terminalResult.failureCode ?? "probe_terminal_failed";
  if (task !== null && !terminalResult.isError && terminalResult.payload !== null) {
    const payload = terminalResult.payload;
    const thread = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.thread : null;
    const page = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.page : null;
    const turns = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.turns : null;
    const items = Array.isArray(turns) ? turns.flatMap((turn) => (
      turn && typeof turn === "object" && !Array.isArray(turn) && Array.isArray(turn.items) ? turn.items : []
    )) : [];
    const finalMessages = items.filter((item) => item && typeof item === "object" && !Array.isArray(item)
      && item.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string");
    const forbiddenActivity = items.some((item) => item && typeof item === "object" && !Array.isArray(item)
      && ["commandExecution", "mcpToolCall"].includes(item.type));
    success = thread && typeof thread === "object" && !Array.isArray(thread)
      && thread.id === task.threadId && thread.hostId === task.hostId
      && page && typeof page === "object" && !Array.isArray(page)
      && page.hasMore === false && page.nextCursor === null
      && finalMessages.length === 1 && finalMessages[0].text === "SUBSCRIPTION_AVAILABLE"
      && !forbiddenActivity;
    if (!success) failureCode = forbiddenActivity ? "probe_forbidden_activity_observed" : "probe_terminal_result_not_exact";
  }
  return Object.freeze({
    evidence: canonicalize(evidence),
    probeId: id(evidence.probeId, "probeId"),
    accountingId: id(evidence.accountingId, "accountingId"),
    assignmentId: id(evidence.assignmentId, "assignmentId"),
    attemptId: id(evidence.attemptId, "attemptId"),
    createAt,
    terminalAt,
    createResult,
    terminalResult,
    task,
    success,
    failureCode,
    createThreadCommand: canonicalize(command),
  });
}

function probeRequestFromAction(action) {
  return {
    prompt: action.prompt,
    promptDigest: action.promptDigest,
    accountingRole: action.accountingRole,
    target: action.target,
    createThreadCommand: action.createThreadCommand,
    benchmarkContentIncluded: action.benchmarkContentIncluded,
    mayReleaseExperimentBrief: action.mayReleaseExperimentBrief,
  };
}

function verifyProbeDispatchBinding(input) {
  exactObject(input, [
    "configDigest", "coordinatorJournalDigest", "provisioningStateDigest", "evidenceRequest",
    "createObservedAt", "dispatch", "acknowledgement", "authorityJournalEntries",
  ], "Subscription probe dispatch binding input");
  const configDigest = digest(input.configDigest, "Subscription probe config digest");
  const coordinatorJournalDigest = digest(
    input.coordinatorJournalDigest,
    "Subscription probe coordinator journal digest",
  );
  const provisioningStateDigest = digest(
    input.provisioningStateDigest,
    "Subscription probe provisioning state digest",
  );
  const createObservedAt = timestamp(input.createObservedAt, "Subscription probe create observedAt");
  if (!Array.isArray(input.authorityJournalEntries)) {
    throw new Error("Subscription probe authority journal entries must be an array.");
  }

  const dispatch = exactObject(input.dispatch, [
    "schemaVersion", "protocolId", "actionDigest", "runtimePreflightReceiptDigest",
    "configDigest", "retainedAt", "actionKind", "action", "expectedIngest",
    "authorityJournalEntryDigest", "authorityJournalRoot", "externalToolInvokedByCli",
    "dispatchDigest",
  ], "Subscription probe dispatch receipt");
  if (dispatch.schemaVersion !== "exp-0001a-coordinator-dispatch/v1"
      || dispatch.protocolId !== "EXP-0001A"
      || dispatch.configDigest !== configDigest
      || dispatch.actionKind !== "run_subscription_availability_probe"
      || dispatch.externalToolInvokedByCli !== false) {
    throw new Error("Subscription probe dispatch receipt metadata is invalid.");
  }
  const action = exactObject(dispatch.action, [
    "kind", "prompt", "promptDigest", "accountingRole", "target", "createThreadCommand",
    "benchmarkContentIncluded", "mayReleaseExperimentBrief", "authorityReceiptRequiredBeforeResume",
    "expectedIngest", "coordinatorDidNotInvokeTool",
  ], "Subscription probe dispatched action");
  const expectedIngest = exactObject(action.expectedIngest, [
    "operation", "assignmentId", "planDigest", "priorStateDigest",
    "resultMustBeRetainedBeforeNextAction",
  ], "Subscription probe expected ingest");
  if (action.kind !== "run_subscription_availability_probe"
      || action.authorityReceiptRequiredBeforeResume !== true
      || action.coordinatorDidNotInvokeTool !== true
      || expectedIngest.operation !== "retainSubscriptionProbeResult"
      || expectedIngest.assignmentId !== null
      || expectedIngest.planDigest !== null
      || expectedIngest.priorStateDigest !== coordinatorJournalDigest
      || expectedIngest.resultMustBeRetainedBeforeNextAction !== true
      || canonicalJson(dispatch.expectedIngest) !== canonicalJson(expectedIngest)
      || canonicalJson(probeRequestFromAction(action)) !== canonicalJson(input.evidenceRequest)) {
    throw new Error("Subscription probe dispatch does not bind the exact current neutral request and prior state.");
  }
  const { dispatchDigest: _dispatchDigest, ...dispatchContent } = dispatch;
  void _dispatchDigest;
  const actionDigest = digest(dispatch.actionDigest, "Subscription probe action digest");
  const dispatchDigest = digest(dispatch.dispatchDigest, "Subscription probe dispatch digest");
  if (sha256Canonical(action) !== actionDigest || sha256Canonical(dispatchContent) !== dispatchDigest) {
    throw new Error("Subscription probe dispatch digest binding is invalid.");
  }
  const retainedAt = timestamp(dispatch.retainedAt, "Subscription probe dispatch retainedAt");
  const runtimePreflightReceiptDigest = digest(
    dispatch.runtimePreflightReceiptDigest,
    "Subscription probe runtime preflight receipt digest",
  );
  const authorityJournalEntryDigest = digest(
    dispatch.authorityJournalEntryDigest,
    "Subscription probe runtime preflight authority entry digest",
  );
  if (dispatch.authorityJournalRoot !== authorityJournalEntryDigest) {
    throw new Error("Subscription probe dispatch is not rooted at its runtime preflight authority entry.");
  }

  const acknowledgement = exactObject(input.acknowledgement, [
    "schemaVersion", "protocolId", "actionDigest", "dispatchDigest", "configDigest",
    "acknowledgedAt", "callerAcknowledgedReceiptBeforeInvocation",
    "blindRetryForbiddenAfterAcknowledgement", "acknowledgementDigest",
  ], "Subscription probe dispatch acknowledgement");
  const { acknowledgementDigest: _acknowledgementDigest, ...acknowledgementContent } = acknowledgement;
  void _acknowledgementDigest;
  const acknowledgementDigest = digest(
    acknowledgement.acknowledgementDigest,
    "Subscription probe dispatch acknowledgement digest",
  );
  const acknowledgedAt = timestamp(
    acknowledgement.acknowledgedAt,
    "Subscription probe dispatch acknowledgedAt",
  );
  if (acknowledgement.schemaVersion !== "exp-0001a-coordinator-dispatch-acknowledgement/v1"
      || acknowledgement.protocolId !== "EXP-0001A"
      || acknowledgement.actionDigest !== actionDigest
      || acknowledgement.dispatchDigest !== dispatchDigest
      || acknowledgement.configDigest !== configDigest
      || acknowledgement.callerAcknowledgedReceiptBeforeInvocation !== true
      || acknowledgement.blindRetryForbiddenAfterAcknowledgement !== true
      || sha256Canonical(acknowledgementContent) !== acknowledgementDigest) {
    throw new Error("Subscription probe dispatch acknowledgement binding is invalid.");
  }
  if (Date.parse(acknowledgedAt) < Date.parse(retainedAt)
      || Date.parse(createObservedAt) < Date.parse(acknowledgedAt)) {
    throw new Error("Subscription probe dispatch, acknowledgement, and result timestamps are non-monotonic.");
  }

  const matchingPreflights = input.authorityJournalEntries.filter((entry) =>
    entry?.kind === "runtime_preflight"
      && entry.entryDigest === authorityJournalEntryDigest
      && entry.payload?.receiptDigest === runtimePreflightReceiptDigest
      && entry.payload?.nextAction?.actionDigest === actionDigest
      && entry.payload?.coordinatorJournalDigest === coordinatorJournalDigest
      && entry.payload?.provisioningStateDigest === provisioningStateDigest);
  if (matchingPreflights.length !== 1) {
    throw new Error("Subscription probe dispatch has no unique current runtime-preflight authority binding.");
  }
  return Object.freeze({
    actionDigest,
    dispatchDigest,
    acknowledgementDigest,
    acknowledgedAt,
    runtimePreflightReceiptDigest,
    authorityJournalEntryDigest,
    expectedIngest: canonicalize(expectedIngest),
  });
}

/** Pure adversarial-test surface. Production additionally resolves the exact
 * private outbox/ack files by the content-addressed action name. */
export function verifyExp0001aUsageResetProbeDispatchBindingForTesting(input) {
  return verifyProbeDispatchBinding(input);
}

async function loadProbeDispatchBinding(input) {
  const outboxDirectory = path.join(input.outputRoot, "coordinator-outbox");
  const dispatchNames = await readPrivateDirectoryNames(
    outboxDirectory,
    "Subscription probe coordinator outbox",
  );
  const candidates = [];
  for (const name of dispatchNames) {
    if (!OUTBOX_FILE_PATTERN.test(name)) {
      throw new Error(`Subscription probe coordinator outbox contains an unexpected entry: ${name}.`);
    }
    const receipt = await readPlainJson(
      path.join(outboxDirectory, name),
      "Subscription probe dispatch receipt",
      0o600,
    );
    if (receipt?.actionKind === "run_subscription_availability_probe"
        && receipt.action?.expectedIngest?.priorStateDigest === input.coordinatorJournalDigest
        && canonicalJson(probeRequestFromAction(receipt.action ?? {})) === canonicalJson(input.evidenceRequest)) {
      if (receipt.actionDigest !== `sha256:${name.slice(0, 64)}`) {
        throw new Error("Subscription probe dispatch filename does not bind its action digest.");
      }
      candidates.push(receipt);
    }
  }
  if (candidates.length !== 1) {
    throw new Error("Subscription probe evidence requires exactly one matching retained coordinator dispatch.");
  }
  const dispatch = candidates[0];
  const ackDirectory = path.join(input.outputRoot, "coordinator-outbox-acks");
  const acknowledgementNames = await readPrivateDirectoryNames(
    ackDirectory,
    "Subscription probe coordinator acknowledgement outbox",
  );
  if (acknowledgementNames.some((name) => !OUTBOX_FILE_PATTERN.test(name))
      || !acknowledgementNames.includes(`${dispatch.actionDigest.slice(7)}.json`)) {
    throw new Error("Subscription probe coordinator acknowledgement outbox is incomplete or malformed.");
  }
  const acknowledgement = await readPlainJson(
    path.join(ackDirectory, `${dispatch.actionDigest.slice(7)}.json`),
    "Subscription probe dispatch acknowledgement",
    0o600,
  );
  return verifyProbeDispatchBinding({
    configDigest: input.configDigest,
    coordinatorJournalDigest: input.coordinatorJournalDigest,
    provisioningStateDigest: input.provisioningStateDigest,
    evidenceRequest: input.evidenceRequest,
    createObservedAt: input.createObservedAt,
    dispatch,
    acknowledgement,
    authorityJournalEntries: input.authorityJournalEntries,
  });
}

/** Pure parser used by portable tests. Production signing calls the same
 * function with its actual clock and does not accept a clock dependency. */
export function inspectExp0001aSubscriptionProbeEvidenceForTesting(input, signedAt) {
  return parseProbeEvidence(input, timestamp(signedAt, "Test probe signedAt"));
}

function createProbeAccounting(runtime, retained) {
  if (retained.task === null) return null;
  const succeeded = retained.success;
  return runtime.exp0001aCodexTaskAccountingSchema.parse({
    schemaVersion: "exp-0001a-codex-task-accounting/v1",
    protocolId: "EXP-0001A",
    accountingId: retained.accountingId,
    assignmentId: retained.assignmentId,
    attemptId: retained.attemptId,
    role: "subscription_probe",
    ...retained.task,
    isolation: {
      workspace: "projectless",
      repositoryAccess: false,
      privateApiAccess: false,
      sharedHistory: false,
      forkedFromAnotherTask: false,
      preparedCoordinates: false,
      evaluatorContext: false,
    },
    requestedModel: retained.createThreadCommand.arguments.model,
    requestedReasoningEffort: retained.createThreadCommand.arguments.thinking,
    resolvedModelSnapshot: "unobservable",
    inputTokens: "unobservable",
    outputTokens: "unobservable",
    totalTokens: "unobservable",
    chatGptCredits: "unobservable",
    subscriptionUsage: "unobservable",
    begunAt: retained.createAt,
    completedAt: succeeded ? retained.terminalAt : null,
    terminalAt: retained.terminalAt,
    state: "terminal",
    terminalOutcome: succeeded ? "succeeded" : "failed",
    terminalReasonCode: succeeded ? "availability_probe_succeeded" : retained.failureCode,
    wallTimeMs: Date.parse(retained.terminalAt) - Date.parse(retained.createAt),
    // The neutral probe transcript intentionally omits tool outputs. Absence
    // of an observed call is not evidence of a numeric zero.
    webMcp: { callCount: "unobservable", failureCount: "unobservable" },
    canvas: { revisionCount: "unobservable", inspectionCount: "unobservable" },
    usageLimitInterruptions: [],
  });
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function retainAttemptReceipt(outputRoot, probeId, value) {
  const directory = path.join(outputRoot, "usage-reset-probes");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || (directoryMetadata.mode & 0o077) !== 0) {
    throw new Error("Usage-reset probe receipt directory must be private.");
  }
  const filePath = path.join(directory, `${probeId}.json`);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await fsyncDirectory(directory);
  const readback = await readPlainFile(filePath, "Usage-reset probe receipt readback", 0o600);
  if (!readback.equals(bytes)) throw new Error("Usage-reset probe receipt readback differs from retained bytes.");
  return filePath;
}

export function parseExp0001aUsageResetProbeSignerArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--config" || argv[2] !== "--probe-evidence") {
    throw new Error("Usage: sign-exp0001a-usage-reset-probe.mjs --config /absolute/config.json --probe-evidence /absolute/probe.json");
  }
  for (const candidate of [argv[1], argv[3]]) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || path.normalize(candidate) !== candidate
        || candidate === path.parse(candidate).root) {
      throw new Error("Usage: sign-exp0001a-usage-reset-probe.mjs --config /absolute/config.json --probe-evidence /absolute/probe.json");
    }
  }
  return Object.freeze({ configPath: argv[1], probeEvidencePath: argv[3] });
}

async function signWithFixedAuthority(input) {
  const verifiedBundle = await verifyExp0001aRuntimeBundle();
  const runtime = await import(
    `${pathToFileURL(path.join(REPOSITORY_ROOT, EXP0001A_RUNTIME_OUTPUT)).href}?digest=${encodeURIComponent(verifiedBundle.bundleDigest)}`
  );
  const config = runtime.exp0001aCodexRuntimeConfigSchema.parse(
    await readPlainJson(input.configPath, "Usage-reset runtime config"),
  );
  const configDigest = sha256Canonical(config);
  if (config.runtimeBundleDigest !== verifiedBundle.bundleDigest) {
    throw new Error("Usage-reset signer runtime bundle differs from config.");
  }
  await recoverExp0001aCoordinatorMutation(runtime, config);
  const [freeze, freezeAuthoritySignature, schedulerRaw, ledgerRaw, provisioningRaw, coordinatorJournalRaw, evidenceRaw] = await Promise.all([
    readPlainJson(config.files.codexPrebriefFreeze, "Codex prebrief freeze"),
    readPlainJson(config.files.codexPrebriefFreezeSignature, "Codex prebrief freeze authority signature"),
    readPlainJson(config.files.schedulerState, "Paused scheduler state", 0o600),
    readPlainJson(config.files.accountingLedger, "Accounting ledger", 0o600),
    readPlainJson(config.files.provisioningCoordinatorState, "Provisioning coordinator state", 0o600),
    readPlainJson(config.files.coordinatorJournal, "Coordinator journal", 0o600),
    readPlainJson(input.probeEvidencePath, "Subscription probe evidence", 0o600),
  ]);
  const rawProbeEvidenceDigest = sha256Canonical(evidenceRaw);
  const retainedAuthorityJournal = await readExp0001aAuthorityJournal(config.outputRoot);
  const matchingPriorEntries = retainedAuthorityJournal.entries.filter((entry) =>
    entry.kind === "usage_reset_probe"
      && entry.payload?.probeId === evidenceRaw?.probeId
      && entry.payload?.rawProbeEvidenceDigest === rawProbeEvidenceDigest);
  if (matchingPriorEntries.length > 1) {
    throw new Error("Usage-reset authority journal contains duplicate retained probe evidence.");
  }
  const priorAuthorityEntry = matchingPriorEntries[0] ?? null;
  const signedAt = priorAuthorityEntry === null
    ? new Date().toISOString()
    : timestamp(priorAuthorityEntry.payload.retainedAt, "Retained usage-reset signedAt");
  const authorizedFreeze = runtime.verifyExp0001aCodexPrebriefFreezeAuthority({
    freeze,
    authoritySignature: freezeAuthoritySignature,
    verifiedAt: signedAt,
  });
  await verifyExp0001aOuterExecutionSourceCommitments({
    freeze: authorizedFreeze,
    repositoryRoot: REPOSITORY_ROOT,
  });
  const scheduler = runtime.verifyExp0001aCodexSchedulerStateAsOf({
    scheduler: runtime.exp0001aCodexSchedulerStateSchema.parse(schedulerRaw),
    accountingLedger: runtime.exp0001aCodexAccountingLedgerSchema.parse(ledgerRaw),
    checkedAt: signedAt,
  });
  if (scheduler.pause === null) throw new Error("Usage-reset signer requires an actively paused scheduler.");
  const stagedProvisioning = await createExp0001aStagedProvisioningCoordinator(
    runtime,
    config,
    provisioningRaw,
    sha256Canonical({ kind: "usage-reset-probe-staging", evidenceDigest: sha256Canonical(evidenceRaw) }),
  );
  const provisioningCoordinator = stagedProvisioning.coordinator;
  const provisioningState = await provisioningCoordinator.read();
  if (canonicalJson(provisioningState) !== canonicalJson(provisioningRaw)
      || canonicalJson(provisioningState.scheduler) !== canonicalJson(scheduler)) {
    throw new Error("Usage-reset signer provisioning state is not bound to the paused scheduler bytes.");
  }
  const priorCoordinatorJournal = runtime.exp0001aCodexCoordinatorJournalSchema.parse(coordinatorJournalRaw);
  if (priorCoordinatorJournal.provisioningStateDigest !== provisioningState.stateDigest) {
    throw new Error("Usage-reset signer coordinator journal is not bound to provisioning state.");
  }
  const retained = parseProbeEvidence(evidenceRaw, signedAt);
  const dispatchBinding = await loadProbeDispatchBinding({
    outputRoot: config.outputRoot,
    configDigest,
    coordinatorJournalDigest: priorCoordinatorJournal.journalDigest,
    provisioningStateDigest: provisioningState.stateDigest,
    evidenceRequest: retained.evidence.request,
    createObservedAt: retained.createAt,
    authorityJournalEntries: retainedAuthorityJournal.entries,
  });
  const resultEntriesForDispatch = retainedAuthorityJournal.entries.filter((entry) =>
    entry.kind === "usage_reset_probe"
      && (entry.payload?.actionDigest === dispatchBinding.actionDigest
        || entry.payload?.dispatchDigest === dispatchBinding.dispatchDigest
        || (entry.payload?.probeId === retained.probeId
          && entry.payload?.rawProbeEvidenceDigest === rawProbeEvidenceDigest)));
  if (resultEntriesForDispatch.length > 1) {
    throw new Error("Usage-reset authority journal contains duplicate results for the acknowledged dispatch.");
  }
  if (priorAuthorityEntry === null) {
    if (resultEntriesForDispatch.length !== 0
        || retainedAuthorityJournal.journalRoot !== dispatchBinding.authorityJournalEntryDigest) {
      throw new Error("Usage-reset probe is not the sole current unconsumed acknowledged dispatch.");
    }
  } else if (resultEntriesForDispatch.length !== 1
      || resultEntriesForDispatch[0].entryDigest !== priorAuthorityEntry.entryDigest
      || priorAuthorityEntry.payload?.actionDigest !== dispatchBinding.actionDigest
      || priorAuthorityEntry.payload?.dispatchDigest !== dispatchBinding.dispatchDigest
      || priorAuthorityEntry.payload?.dispatchAcknowledgementDigest !== dispatchBinding.acknowledgementDigest
      || retainedAuthorityJournal.journalRoot !== priorAuthorityEntry.entryDigest) {
    throw new Error("Retained usage-reset result is not the exact replay of this acknowledged dispatch.");
  }
  const probeAccounting = createProbeAccounting(runtime, retained);
  const priorLedger = runtime.exp0001aCodexAccountingLedgerSchema.parse(ledgerRaw);
  const reconstructedPriorLedger = runtime.deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal(
    priorCoordinatorJournal,
  );
  if (canonicalJson(priorLedger) !== canonicalJson(reconstructedPriorLedger)) {
    throw new Error("Usage-reset signer accounting ledger is not reconstructible from the coordinator journal.");
  }
  let observation = null;
  let nextScheduler = scheduler;
  if (retained.success) {
    if (probeAccounting === null) throw new Error("Successful subscription probe has no retained task identity.");
    const deterministicObservation = {
      schemaVersion: "exp-0001a-chatgpt-usage-reset-observation/v1",
      kind: "chatgpt-usage-reset-observation",
      observedAt: signedAt,
      resumedAt: signedAt,
      priorUsageWindow: scheduler.currentUsageWindow,
      nextUsageWindow: scheduler.currentUsageWindow + 1,
      source: "codex_app_host",
      resetState: "availability_probe_succeeded",
      priorInterruptionDigest: scheduler.pause.evidenceDigest,
      subscriptionUsageBefore: retained.evidence.subscriptionUsageBefore,
      subscriptionUsageAfter: retained.evidence.subscriptionUsageAfter,
      probe: {
        role: "subscription_probe",
        neutralPromptDigest: PROBE_PROMPT_DIGEST,
        benchmarkContentIncluded: false,
        accountingId: probeAccounting.accountingId,
        accountingRecordDigest: sha256Canonical(probeAccounting),
        codexTaskId: probeAccounting.codexTaskId,
        threadId: probeAccounting.threadId,
        hostId: probeAccounting.hostId,
        createThreadRawOutputDigest: retained.createResult.rawDigest,
        terminalRawOutputDigest: retained.terminalResult.rawDigest,
      },
    };
    if (priorAuthorityEntry === null) {
      const payload = {
        ...deterministicObservation,
        observationId: `usage-reset-${randomUUID()}`,
      };
      const authority = await loadAuthority();
      observation = runtime.exp0001aChatGptUsageResetObservationSchema.parse({
        ...payload,
        authoritySignature: createExp0001aUsageResetProbeSignatureForTesting({ payload, signedAt, authority }),
      });
    } else {
      observation = runtime.exp0001aChatGptUsageResetObservationSchema.parse(
        priorAuthorityEntry.payload.authorityObservation,
      );
      const { observationId: _observationId, authoritySignature: _authoritySignature, ...retainedDeterministic } = observation;
      void _observationId;
      void _authoritySignature;
      if (canonicalJson(retainedDeterministic) !== canonicalJson(deterministicObservation)) {
        throw new Error("Retained usage-reset observation does not bind the exact replayed probe and pause.");
      }
    }
    const { authoritySignature, ...signedPayload } = observation;
    runtime.verifyExp0001aCodexAuthoritySignature({
      payload: signedPayload,
      signature: authoritySignature,
      purpose: "usage_reset_probe",
      notBefore: probeAccounting.terminalAt,
    });
    nextScheduler = runtime.resumeExp0001aCodexSchedulerAfterUsageReset(scheduler, {
      observation,
      probeAccounting,
    });
  }
  const nextProvisioningState = retained.success
    ? await provisioningCoordinator.synchronizeScheduler(nextScheduler)
    : provisioningState;
  const probeEvidenceDigest = sha256Canonical(retained.evidence);
  const nextCoordinatorJournal = runtime.retainExp0001aSubscriptionProbeResultInCoordinatorJournal({
    priorJournal: priorCoordinatorJournal,
    provisioningState: nextProvisioningState,
    probeEvidenceDigest,
    probeAccounting,
  });
  const nextLedger = runtime.deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal(nextCoordinatorJournal);
  runtime.verifyExp0001aCodexSchedulerStateAsOf({
    scheduler: nextScheduler,
    accountingLedger: nextLedger,
    checkedAt: signedAt,
  });
  const journalPayload = Object.freeze({
    schemaVersion: "exp-0001a-usage-reset-probe-retention/v1",
    protocolId: "EXP-0001A",
    kind: "usage-reset-probe-retention",
    probeId: retained.probeId,
    retainedAt: signedAt,
    outcome: retained.success ? "availability_probe_succeeded" : "availability_probe_failed",
    failureCode: retained.success ? null : retained.failureCode,
    priorSchedulerDigest: sha256Canonical(scheduler),
    priorAccountingLedgerDigest: sha256Canonical(priorLedger),
    priorProvisioningStateDigest: provisioningState.stateDigest,
    priorCoordinatorJournalDigest: priorCoordinatorJournal.journalDigest,
    retainedPause: scheduler.pause,
    actionDigest: dispatchBinding.actionDigest,
    dispatchDigest: dispatchBinding.dispatchDigest,
    dispatchAcknowledgementDigest: dispatchBinding.acknowledgementDigest,
    dispatchAcknowledgedAt: dispatchBinding.acknowledgedAt,
    runtimePreflightAuthorityEntryDigest: dispatchBinding.authorityJournalEntryDigest,
    expectedIngest: dispatchBinding.expectedIngest,
    rawProbeEvidence: retained.evidence,
    rawProbeEvidenceDigest: probeEvidenceDigest,
    createThreadRawOutputDigest: retained.createResult.rawDigest,
    terminalRawOutputDigest: retained.terminalResult.rawDigest,
    probeAccounting,
    authorityObservation: observation,
    nextSchedulerDigest: sha256Canonical(nextScheduler),
    nextAccountingLedgerDigest: sha256Canonical(nextLedger),
    nextProvisioningStateDigest: nextProvisioningState.stateDigest,
    nextCoordinatorJournalDigest: nextCoordinatorJournal.journalDigest,
  });
  let journal;
  if (priorAuthorityEntry !== null) {
    if (canonicalJson(priorAuthorityEntry.payload) !== canonicalJson(journalPayload)) {
      throw new Error("Retained usage-reset authority payload differs from exact replay reconstruction.");
    }
    journal = Object.freeze({
      alreadyRetained: true,
      entry: priorAuthorityEntry,
      journalRoot: retainedAuthorityJournal.journalRoot,
    });
  } else {
    journal = await appendExp0001aAuthorityJournalEntry({
      outputRoot: config.outputRoot,
      kind: "usage_reset_probe",
      recordedAt: signedAt,
      payload: journalPayload,
    });
  }
  const retainedState = await persistExp0001aCoordinatorMutation(runtime, config, {
    provisioningState: nextProvisioningState,
    coordinatorJournal: nextCoordinatorJournal,
    retainedEvidenceDigest: probeEvidenceDigest,
  }, {
    actionDigest: sha256Canonical({
      kind: "usage-reset-probe",
      probeId: retained.probeId,
      coordinatorActionDigest: dispatchBinding.actionDigest,
      dispatchDigest: dispatchBinding.dispatchDigest,
      dispatchAcknowledgementDigest: dispatchBinding.acknowledgementDigest,
      authorityJournalEntryDigest: journal.entry.entryDigest,
    }),
    retainedAt: signedAt,
    stagingProvisioningPath: stagedProvisioning.stagingPath,
  });
  const receipt = Object.freeze({
    schemaVersion: "exp-0001a-usage-reset-probe-sign-result/v1",
    protocolId: "EXP-0001A",
    probeId: retained.probeId,
    retainedAt: signedAt,
    status: retained.success ? "resumed" : "retained_failed_probe",
    schedulerRemainsPaused: !retained.success,
    observationDigest: observation === null ? null : sha256Canonical(observation),
    probeAccountingDigest: probeAccounting === null ? null : sha256Canonical(probeAccounting),
    coordinatorJournalDigest: nextCoordinatorJournal.journalDigest,
    provisioningStateDigest: nextProvisioningState.stateDigest,
    authorityJournalEntryDigest: journal.entry.entryDigest,
    authorityJournalRoot: journal.journalRoot,
    coordinatorActionDigest: dispatchBinding.actionDigest,
    dispatchDigest: dispatchBinding.dispatchDigest,
    dispatchAcknowledgementDigest: dispatchBinding.acknowledgementDigest,
    coordinatorTransactionDigest: retainedState.transactionDigest,
  });
  const receiptPath = await retainAttemptReceipt(config.outputRoot, retained.probeId, receipt);
  return Object.freeze({ ...receipt, receiptPath });
}

/** Production signing accepts no key, signature, clock, payload, or benchmark
 * input. It reads one exact private probe evidence file and the pinned runtime
 * config, uses the actual clock and fixed mode-0600 authority key, verifies the
 * signed observation, resumes through the bundled verifier, journals the full
 * chain, and readbacks every retained file. */
export async function signExp0001aUsageResetProbeFromConfig(input) {
  exactObject(input, ["configPath", "probeEvidencePath"], "Usage-reset signer input");
  return signWithFixedAuthority(input);
}

export async function runExp0001aUsageResetProbeSignerCli(argv = process.argv.slice(2), io = {
  stdout: process.stdout,
  stderr: process.stderr,
}) {
  try {
    const result = await signExp0001aUsageResetProbeFromConfig(parseExp0001aUsageResetProbeSignerArgs(argv));
    io.stdout.write(`${canonicalJson(result)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${canonicalJson({
      status: "error",
      errorCode: "USAGE_RESET_PROBE_SIGNING_FAILED",
      message: error instanceof Error ? error.message : "Unknown failure",
    })}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = await runExp0001aUsageResetProbeSignerCli();
}
