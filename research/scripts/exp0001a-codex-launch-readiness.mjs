#!/usr/bin/env node

import { createHash } from "node:crypto";

export const EXP0001A_CODEX_LAUNCH_READINESS_VERSION =
  "exp-0001a-codex-launch-readiness/v1";
export const EXP0001A_CODEX_RUNTIME_BUNDLE_PATH =
  "research/runtime/exp0001a-runtime.bundle.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
}

export function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort(compareCodeUnits))
      === canonicalJson([...keys].sort(compareCodeUnits));
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validatedPreflight(value) {
  if (!exactKeys(value, [
    "schemaVersion", "kind", "protocolId", "checkedAt", "authCheckedAt", "decision", "reasons",
    "executionAllowed", "nextAction",
    "freezeDigest", "authPreflightReceiptDigest", "spikeEvidenceDigest", "spikeGateDigest",
    "frozenScheduleDigest", "schedulerStateDigest", "accountingLedgerDigest",
    "provisioningStateDigest", "coordinatorJournalDigest", "coordinatorCheckpoint", "accounting", "isolation",
    "receiptDigest",
  ]) || value.schemaVersion !== "exp-0001a-codex-runtime-preflight/v1"
      || value.kind !== "exp-0001a-codex-runtime-preflight" || value.protocolId !== "EXP-0001A"
      || value.decision !== "ready_for_coordinator" || value.executionAllowed !== true
      || canonicalJson(value.reasons) !== canonicalJson(["SIGNED_STATE_AND_LIVE_CHATGPT_AUTH_VERIFIED"])
      || value.nextAction?.kind !== "emit_one_coordinator_action"
      || value.nextAction?.callerMustPerformAction !== true
      || value.nextAction?.runtimeInvokedExternalTool !== false) {
    throw new Error("EXP-0001A launch readiness requires the exact signed-state Codex-native runtime preflight.");
  }
  const { receiptDigest, ...content } = value;
  if (digest(receiptDigest, "Runtime preflight receipt digest") !== sha256Canonical(content)) {
    throw new Error("EXP-0001A runtime preflight digest is invalid.");
  }
  return value;
}

export function createExp0001aCodexLaunchReadinessReceipt(input) {
  const preflight = validatedPreflight(input?.runtimePreflight);
  const content = {
    schemaVersion: EXP0001A_CODEX_LAUNCH_READINESS_VERSION,
    kind: "exp-0001a-codex-launch-readiness",
    protocolId: "EXP-0001A",
    checkedAt: timestamp(input?.checkedAt, "Launch-readiness time"),
    decision: "ready_for_coordinator",
    executionAllowed: true,
    freshChatGptAuthRequiredAtEveryTaskRelease: true,
    configDigest: digest(input?.configDigest, "Runtime config digest"),
    runtime: {
      bundlePath: EXP0001A_CODEX_RUNTIME_BUNDLE_PATH,
      bundleDigest: digest(input?.runtimeBundleDigest, "Runtime bundle digest"),
      prebriefFreezeDigest: digest(preflight.freezeDigest, "Prebrief freeze digest"),
      runtimePreflightReceiptDigest: digest(preflight.receiptDigest, "Runtime preflight receipt digest"),
    },
    evidence: {
      authPreflightReceiptDigest: digest(preflight.authPreflightReceiptDigest, "Auth preflight receipt digest"),
      authCheckedAt: timestamp(preflight.authCheckedAt, "Auth preflight time"),
      spikeEvidenceDigest: digest(preflight.spikeEvidenceDigest, "Spike evidence digest"),
      spikeGateDigest: digest(preflight.spikeGateDigest, "Spike gate digest"),
      frozenScheduleDigest: digest(preflight.frozenScheduleDigest, "Frozen schedule digest"),
      schedulerStateDigest: digest(preflight.schedulerStateDigest, "Scheduler state digest"),
      accountingLedgerDigest: digest(preflight.accountingLedgerDigest, "Accounting ledger digest"),
      provisioningStateDigest: digest(preflight.provisioningStateDigest, "Provisioning state digest"),
      coordinatorJournalDigest: digest(preflight.coordinatorJournalDigest, "Coordinator journal digest"),
      coordinatorCheckpointDigest: sha256Canonical(preflight.coordinatorCheckpoint),
      authorizedActionDigest: digest(preflight.nextAction.actionDigest, "Authorized action digest"),
    },
    observability: {
      resolvedModelSnapshot: "unobservable",
      exactTokens: "unobservable",
      subscriptionUsage: "unobservable",
      chatGptCredits: "unobservable",
    },
  };
  return deepFreeze({ ...content, receiptDigest: sha256Canonical(content) });
}

export function verifyExp0001aCodexLaunchReadinessReceipt(value) {
  if (!exactKeys(value, [
    "schemaVersion", "kind", "protocolId", "checkedAt", "decision", "executionAllowed",
    "freshChatGptAuthRequiredAtEveryTaskRelease", "configDigest", "runtime", "evidence",
    "observability", "receiptDigest",
  ]) || value.schemaVersion !== EXP0001A_CODEX_LAUNCH_READINESS_VERSION
      || value.kind !== "exp-0001a-codex-launch-readiness" || value.protocolId !== "EXP-0001A"
      || value.decision !== "ready_for_coordinator" || value.executionAllowed !== true
      || value.freshChatGptAuthRequiredAtEveryTaskRelease !== true
      || !exactKeys(value.runtime, ["bundlePath", "bundleDigest", "prebriefFreezeDigest", "runtimePreflightReceiptDigest"])
      || value.runtime.bundlePath !== EXP0001A_CODEX_RUNTIME_BUNDLE_PATH
      || !exactKeys(value.evidence, ["authPreflightReceiptDigest", "authCheckedAt", "spikeEvidenceDigest", "spikeGateDigest", "frozenScheduleDigest", "schedulerStateDigest", "accountingLedgerDigest", "provisioningStateDigest", "coordinatorJournalDigest", "coordinatorCheckpointDigest", "authorizedActionDigest"])
      || !exactKeys(value.observability, ["resolvedModelSnapshot", "exactTokens", "subscriptionUsage", "chatGptCredits"])
      || Object.values(value.observability).some((item) => item !== "unobservable")) {
    throw new Error("EXP-0001A Codex launch-readiness receipt has an invalid shape or decision.");
  }
  timestamp(value.checkedAt, "Launch-readiness time");
  timestamp(value.evidence.authCheckedAt, "Auth preflight time");
  for (const [label, candidate] of Object.entries({
    configDigest: value.configDigest,
    bundleDigest: value.runtime.bundleDigest,
    prebriefFreezeDigest: value.runtime.prebriefFreezeDigest,
    runtimePreflightReceiptDigest: value.runtime.runtimePreflightReceiptDigest,
    authPreflightReceiptDigest: value.evidence.authPreflightReceiptDigest,
    spikeEvidenceDigest: value.evidence.spikeEvidenceDigest,
    spikeGateDigest: value.evidence.spikeGateDigest,
    frozenScheduleDigest: value.evidence.frozenScheduleDigest,
    schedulerStateDigest: value.evidence.schedulerStateDigest,
    accountingLedgerDigest: value.evidence.accountingLedgerDigest,
    provisioningStateDigest: value.evidence.provisioningStateDigest,
    coordinatorJournalDigest: value.evidence.coordinatorJournalDigest,
    coordinatorCheckpointDigest: value.evidence.coordinatorCheckpointDigest,
    authorizedActionDigest: value.evidence.authorizedActionDigest,
    receiptDigest: value.receiptDigest,
  })) digest(candidate, label);
  const { receiptDigest, ...content } = value;
  if (sha256Canonical(content) !== receiptDigest) throw new Error("EXP-0001A Codex launch-readiness receipt digest is invalid.");
  return deepFreeze(value);
}
