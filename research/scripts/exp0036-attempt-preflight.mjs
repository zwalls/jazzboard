#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

export const EXP0036_ATTEMPT_PREFLIGHT_SCHEMA_VERSION =
  "jazzboard-exp0036-attempt-preflight/v1";
export const EXP0036_ATTEMPT_PREFLIGHT_SIGNATURE_DOMAIN =
  "Jazzboard EXP-0036 attempt preflight v1\0";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const UNIQUE_LOCALHOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.localhost$/;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
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
      if (item === undefined || typeof item === "function" || typeof item === "symbol"
          || typeof item === "bigint") {
        throw new TypeError(`Non-JSON value at ${at}/${key}.`);
      }
      output[key] = canonicalize(item, `${at}/${key}`);
    }
    return output;
  }
  throw new TypeError(`Non-JSON value at ${at}.`);
}

export function canonicalExp0036PreflightJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashExp0036PreflightValue(value) {
  return `sha256:${createHash("sha256")
    .update(Buffer.from(canonicalExp0036PreflightJson(value), "utf8"))
    .digest("hex")}`;
}

function publicKeyDigest(publicKeyPem) {
  try {
    const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
    return `sha256:${createHash("sha256").update(der).digest("hex")}`;
  } catch {
    return null;
  }
}

function exact(left, right) {
  try {
    return canonicalExp0036PreflightJson(left) === canonicalExp0036PreflightJson(right);
  } catch {
    return false;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function origin(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password
        || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

function stringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString) ? value : null;
}

function freshEnough(value, nowMs, maxAgeMs) {
  const observedMs = timestamp(value);
  return observedMs !== null && observedMs <= nowMs && nowMs - observedMs <= maxAgeMs;
}

function completedAcquisition(value, nowMs, maxAgeMs) {
  const probe = record(value);
  const requestedMs = timestamp(probe?.requestedAt);
  const respondedMs = timestamp(probe?.respondedAt);
  return requestedMs !== null
    && respondedMs !== null
    && respondedMs >= requestedMs
    && freshEnough(probe.respondedAt, nowMs, maxAgeMs);
}

function acquisitionDurationMs(value) {
  const requestedMs = timestamp(record(value)?.requestedAt);
  const respondedMs = timestamp(record(value)?.respondedAt);
  return requestedMs !== null && respondedMs !== null && respondedMs >= requestedMs
    ? respondedMs - requestedMs : null;
}

function gate(condition, code, failures) {
  if (!condition) failures.push(code);
  return condition;
}

function validFrozenBuild(value, expectedOrigin) {
  const build = record(value);
  return build !== null
    && ["A0", "A1"].includes(build.arm)
    && COMMIT_PATTERN.test(build.commit ?? "")
    && SHA256_PATTERN.test(build.archiveSha256 ?? "")
    && SHA256_PATTERN.test(build.dependencyTreeSha256 ?? "")
    && SHA256_PATTERN.test(build.launchReceiptSha256 ?? "")
    && build.origin === expectedOrigin;
}

function signedContent(input) {
  return {
    expected: input.expected,
    evidence: input.evidence,
  };
}

/**
 * Message signed by the trusted experiment controller after it has collected
 * the task/browser evidence. The application guest cookie stays HttpOnly and
 * is never copied into this statement.
 */
export function exp0036AttemptPreflightSignatureMessage(content) {
  return Buffer.from(
    `${EXP0036_ATTEMPT_PREFLIGHT_SIGNATURE_DOMAIN}${canonicalExp0036PreflightJson(content)}`,
    "utf8",
  );
}

function validAttestation(input) {
  const expected = record(input?.expected);
  const authority = record(expected?.authority);
  const attestation = record(input?.attestation);
  const content = record(attestation?.content);
  if (!authority || !attestation || !content || typeof attestation.signatureBase64 !== "string") {
    return false;
  }
  const actualPublicKeyDigest = publicKeyDigest(authority.publicKeyPem);
  const expectedPayloadSha256 = hashExp0036PreflightValue(signedContent(input));
  if (content.schemaVersion !== EXP0036_ATTEMPT_PREFLIGHT_SCHEMA_VERSION
      || content.protocolId !== "EXP-0036"
      || content.kind !== "attempt_preflight_attestation"
      || content.keyId !== authority.keyId
      || content.publicKeySha256 !== authority.publicKeySha256
      || content.payloadSha256 !== expectedPayloadSha256
      || actualPublicKeyDigest !== authority.publicKeySha256
      || timestamp(content.signedAt) === null) return false;
  let signature;
  try {
    signature = Buffer.from(attestation.signatureBase64, "base64");
    if (signature.length !== 64) return false;
    return verifySignature(
      null,
      exp0036AttemptPreflightSignatureMessage(content),
      createPublicKey(authority.publicKeyPem),
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * Fail-closed post-creation admission decision. This verifies evidence
 * collected through the normal CUA/WebMCP surface; it never reads a guest
 * cookie or a private author API. A separate sealed native-ledger verifier
 * determines post-run validity.
 */
export function evaluateExp0036AttemptPreflight(input, options = {}) {
  const expected = record(input?.expected) ?? {};
  const evidence = record(input?.evidence) ?? {};
  const nowMs = timestamp(options.now ?? new Date().toISOString());
  if (nowMs === null) throw new Error("EXP0036 preflight requires a valid current timestamp.");
  const maxAgeMs = Number.isSafeInteger(options.maxAgeMs) && options.maxAgeMs > 0
    ? options.maxAgeMs : 60_000;
  const failures = [];

  const expectedOrigin = origin(expected.origin);
  const prior = record(expected.prior) ?? {};
  const task = record(evidence.task) ?? {};
  const isolation = record(evidence.isolation) ?? {};
  const recent = record(isolation.preJoinRecentRooms) ?? {};
  const signedSession = record(evidence.signedSession) ?? {};
  const cookieProbe = record(signedSession.cookieProbe) ?? {};
  const hostUnlock = record(evidence.hostUnlock) ?? {};
  const telemetry = record(evidence.telemetryReadiness) ?? {};
  const observedBuild = record(evidence.frozenBuild) ?? {};
  const liveProcess = record(evidence.liveBuildProcess) ?? {};
  const priorTaskIds = stringArray(prior.taskIds) ?? [];
  const priorBrowserSessionIds = stringArray(prior.browserSessionIds) ?? [];
  const priorSessionIdentitySha256s = stringArray(prior.sessionIdentitySha256s) ?? [];
  const priorOrigins = stringArray(prior.origins) ?? [];

  const expectedShape = gate(
    expected.protocolId === "EXP-0036"
      && expected.phase === "post_creation_admission"
      && evidence.phase === "post_creation_admission"
      && nonEmptyString(expected.attemptId)
      && nonEmptyString(expected.taskId)
      && nonEmptyString(expected.browserSessionId)
      && SHA256_PATTERN.test(expected.infrastructurePreflightPayloadSha256 ?? "")
      && evidence.infrastructurePreflightPayloadSha256
        === expected.infrastructurePreflightPayloadSha256
      && expectedOrigin !== null
      && validFrozenBuild(expected.frozenBuild, expected.origin)
      && record(expected.authority) !== null
      && nonEmptyString(expected.authority?.keyId)
      && nonEmptyString(expected.authority?.publicKeyPem)
      && SHA256_PATTERN.test(expected.authority?.publicKeySha256 ?? "")
      && stringArray(prior.taskIds) !== null
      && stringArray(prior.browserSessionIds) !== null
      && stringArray(prior.sessionIdentitySha256s) !== null
      && stringArray(prior.origins) !== null,
    "PREFLIGHT_EXPECTATION_INVALID",
    failures,
  );

  const taskUnique = gate(
    task.taskId === expected.taskId
      && task.browserSessionId === expected.browserSessionId
      && task.target === "projectless"
      && task.history === "fresh"
      && task.priorCompletedTurnCount === 0
      && !priorTaskIds.includes(task.taskId)
      && !priorBrowserSessionIds.includes(task.browserSessionId),
    "TASK_OR_BROWSER_SESSION_NOT_FRESH_AND_UNIQUE",
    failures,
  );

  const expectedHostname = expectedOrigin?.hostname ?? null;
  const isolationProven = gate(
    isolation.method === "unique_localhost_origin"
      && isolation.origin === expected.origin
      && isolation.originFirstUse === true
      && isolation.loadedThroughCua === true
      && isolation.sourceHostname === expectedHostname
      && expectedHostname !== null
      && UNIQUE_LOCALHOST_PATTERN.test(expectedHostname)
      && !priorOrigins.includes(expected.origin),
    "UNIQUE_BROWSER_STORAGE_ORIGIN_NOT_PROVEN",
    failures,
  );

  const recentRoomsEmpty = gate(
    recent.toolName === "list_recent_rooms"
      && recent.outcome === "success"
      && recent.outputComplete === true
      && recent.sourceHostname === expectedHostname
      && Array.isArray(recent.roomReferences)
      && recent.roomReferences.length === 0,
    "PREEXISTING_RECENT_ROOM_REFERENCES_NOT_EXCLUDED",
    failures,
  );

  const signedSessionFresh = gate(
    signedSession.method === "normal_webmcp_join_and_authorized_read"
      && signedSession.origin === expected.origin
      && signedSession.taskId === expected.taskId
      && signedSession.browserSessionId === expected.browserSessionId
      && signedSession.joinOutcome === "success"
      && signedSession.authorizedReadOutcome === "success"
      && signedSession.joinToolOrigin === expectedHostname
      && signedSession.readToolOrigin === expectedHostname
      && completedAcquisition(signedSession.authorizedReadProbe, nowMs, maxAgeMs)
      && SHA256_PATTERN.test(signedSession.identitySha256 ?? "")
      && !priorSessionIdentitySha256s.includes(signedSession.identitySha256),
    "FRESH_SIGNED_GUEST_SESSION_NOT_PROVEN",
    failures,
  );

  const hostUnlocked = gate(
    hostUnlock.status === "unlocked"
      && hostUnlock.probeStatus === "completed"
      && hostUnlock.origin === expected.origin
      && hostUnlock.browserSessionId === expected.browserSessionId
      && freshEnough(hostUnlock.observedAt, nowMs, maxAgeMs),
    "HOST_UNLOCK_NOT_FRESHLY_PROVEN",
    failures,
  );

  const frozenBuildMatches = gate(
    validFrozenBuild(observedBuild, expected.origin)
      && exact(observedBuild, expected.frozenBuild)
      && liveProcess.method === "controller_pid_cwd_and_http_probe"
      && Number.isSafeInteger(liveProcess.pid)
      && liveProcess.pid > 0
      && liveProcess.origin === expected.origin
      && liveProcess.commit === expected.frozenBuild?.commit
      && liveProcess.archiveSha256 === expected.frozenBuild?.archiveSha256
      && liveProcess.launchReceiptSha256 === expected.frozenBuild?.launchReceiptSha256
      && liveProcess.httpStatus === 200
      && freshEnough(liveProcess.observedAt, nowMs, maxAgeMs),
    "FROZEN_BUILD_IDENTITY_MISMATCH",
    failures,
  );

  const telemetryReady = gate(
    telemetry.status === "armed"
      && telemetry.captureMode === "passive_model_context_register_tool"
      && telemetry.injectionMode === "main_world_before_app_module"
      && telemetry.collectionMode === "authenticated_loopback_collector"
      && telemetry.controllerOnly === true
      && telemetry.authorQueryable === false
      && telemetry.authorEndpointExposed === false
      && telemetry.reloadInvalidatesEpoch === true
      && telemetry.maxCaptureBytes > 0
      && telemetry.maxInvocations > 0
      && Number.isSafeInteger(telemetry.expectedRegisteredToolCount)
      && telemetry.expectedRegisteredToolCount > 0
      && SHA256_PATTERN.test(telemetry.observerSourceSha256 ?? "")
      && SHA256_PATTERN.test(telemetry.observerConfigSha256 ?? "")
      && SHA256_PATTERN.test(telemetry.calibrationReceiptSha256 ?? ""),
    "COMPLETE_NATIVE_TELEMETRY_NOT_ARMED",
    failures,
  );

  const evidenceFresh = gate(
    freshEnough(evidence.observedAt, nowMs, maxAgeMs),
    "PREFLIGHT_EVIDENCE_STALE_OR_INVALID",
    failures,
  );

  const attestationValid = gate(
    validAttestation(input)
      && freshEnough(input?.attestation?.content?.signedAt, nowMs, maxAgeMs),
    "PREFLIGHT_ATTESTATION_INVALID_OR_STALE",
    failures,
  );

  const gates = {
    expectedShape,
    taskUnique,
    isolationProven,
    recentRoomsEmpty,
    signedSessionFresh,
    hostUnlocked,
    frozenBuildMatches,
    telemetryReady,
    evidenceFresh,
    attestationValid,
  };
  return {
    schemaVersion: EXP0036_ATTEMPT_PREFLIGHT_SCHEMA_VERSION,
    protocolId: "EXP-0036",
    attemptId: nonEmptyString(expected.attemptId) ? expected.attemptId : null,
    phase: "post_creation_admission",
    decision: failures.length === 0
      ? "post_creation_evidence_complete" : "post_creation_evidence_blocked",
    authorTaskCreationAuthorized: false,
    reasons: failures,
    gates,
    checkedAt: new Date(nowMs).toISOString(),
    payloadSha256: hashExp0036PreflightValue(signedContent(input)),
    diagnostics: {
      cookieProbeMethod: cookieProbe.method ?? null,
      cookieProbeStatus: cookieProbe.status ?? "not_collected",
      cookieProbeAcquisitionMs: acquisitionDurationMs(cookieProbe),
      authorizedReadAcquisitionMs: acquisitionDurationMs(signedSession.authorizedReadProbe),
    },
    caveat: "Codex task creation starts the first prompt immediately. This post-creation evidence check cannot authorize that release; a frozen timing/bootstrap procedure and a separately sealed terminal native ledger are still required.",
  };
}

/**
 * Check the controller-owned infrastructure before task creation. The result
 * records technical readiness only. It never authorizes create_thread, which
 * is a user-owned external action and immediately starts the task's first turn.
 */
export function evaluateExp0036InfrastructurePreflight(input, options = {}) {
  const expected = record(input?.expected) ?? {};
  const evidence = record(input?.evidence) ?? {};
  const nowMs = timestamp(options.now ?? new Date().toISOString());
  if (nowMs === null) throw new Error("EXP0036 preflight requires a valid current timestamp.");
  const maxAgeMs = Number.isSafeInteger(options.maxAgeMs) && options.maxAgeMs > 0
    ? options.maxAgeMs : 60_000;
  const failures = [];

  const expectedOrigin = origin(expected.origin);
  const expectedHostname = expectedOrigin?.hostname ?? null;
  const prior = record(expected.prior) ?? {};
  const reservation = record(evidence.originReservation) ?? {};
  const calibration = record(evidence.wildcardIsolationCalibration) ?? {};
  const probeA = record(calibration.probeA) ?? {};
  const probeB = record(calibration.probeB) ?? {};
  const probeAOrigin = origin(probeA.origin);
  const probeBOrigin = origin(probeB.origin);
  const hostUnlock = record(evidence.hostUnlock) ?? {};
  const telemetry = record(evidence.telemetryReadiness) ?? {};
  const observedBuild = record(evidence.frozenBuild) ?? {};
  const liveProcess = record(evidence.liveBuildProcess) ?? {};
  const priorOrigins = stringArray(prior.origins) ?? [];

  const expectedShape = gate(
    expected.protocolId === "EXP-0036"
      && expected.phase === "infrastructure_precreation"
      && evidence.phase === "infrastructure_precreation"
      && nonEmptyString(expected.attemptId)
      && expectedOrigin !== null
      && expectedHostname !== null
      && UNIQUE_LOCALHOST_PATTERN.test(expectedHostname)
      && validFrozenBuild(expected.frozenBuild, expected.origin)
      && record(expected.authority) !== null
      && nonEmptyString(expected.authority?.keyId)
      && nonEmptyString(expected.authority?.publicKeyPem)
      && SHA256_PATTERN.test(expected.authority?.publicKeySha256 ?? "")
      && stringArray(prior.origins) !== null,
    "INFRASTRUCTURE_EXPECTATION_INVALID",
    failures,
  );

  const noTaskStarted = gate(
    evidence.taskCreationStatus === "not_started"
      && evidence.taskId === undefined
      && evidence.browserSessionId === undefined,
    "TASK_ALREADY_STARTED_OR_BOUND_DURING_INFRASTRUCTURE_PREFLIGHT",
    failures,
  );

  const originReserved = gate(
    reservation.method === "controller_nonce_and_attempt_ledger"
      && reservation.origin === expected.origin
      && reservation.hostname === expectedHostname
      && reservation.browserFirstUse === true
      && reservation.browserNavigationCount === 0
      && reservation.collisionCheckComplete === true
      && !priorOrigins.includes(expected.origin),
    "ATTEMPT_ORIGIN_NOT_FRESHLY_RESERVED",
    failures,
  );

  const validIsolationProbe = (probe, parsedOrigin) => parsedOrigin !== null
    && UNIQUE_LOCALHOST_PATTERN.test(parsedOrigin.hostname)
    && probe.loadedThroughCua === true
    && probe.sourceHostname === parsedOrigin.hostname
    && probe.preJoinCookieCount === 0
    && probe.preJoinRecentRoomsOutcome === "success"
    && probe.preJoinRecentRoomsComplete === true
    && Array.isArray(probe.preJoinRoomReferences)
    && probe.preJoinRoomReferences.length === 0
    && probe.postJoinCookieName === "jazzboard_guest"
    && probe.postJoinCookieCount === 1
    && probe.postJoinCookieDomain === parsedOrigin.hostname
    && probe.postJoinCookieHttpOnly === true
    && SHA256_PATTERN.test(probe.sessionIdentitySha256 ?? "")
    && completedAcquisition(probe, nowMs, maxAgeMs);

  const wildcardIsolationCalibrated = gate(
    calibration.method === "supported_cua_unique_localhost_probe_pair"
      && calibration.status === "passed"
      && probeAOrigin !== null
      && probeBOrigin !== null
      && probeA.origin !== probeB.origin
      && probeA.origin !== expected.origin
      && probeB.origin !== expected.origin
      && probeA.sessionIdentitySha256 !== probeB.sessionIdentitySha256
      && validIsolationProbe(probeA, probeAOrigin)
      && validIsolationProbe(probeB, probeBOrigin),
    "UNIQUE_LOCALHOST_ISOLATION_CALIBRATION_INCOMPLETE",
    failures,
  );

  const hostUnlocked = gate(
    hostUnlock.method === "supported_cua_host_unlock_probe"
      && hostUnlock.status === "unlocked"
      && hostUnlock.probeStatus === "completed"
      && completedAcquisition(hostUnlock, nowMs, maxAgeMs),
    "HOST_UNLOCK_NOT_FRESHLY_PROVEN",
    failures,
  );

  const frozenBuildMatches = gate(
    validFrozenBuild(observedBuild, expected.origin)
      && exact(observedBuild, expected.frozenBuild)
      && liveProcess.method === "controller_pid_cwd_and_http_probe"
      && Number.isSafeInteger(liveProcess.pid)
      && liveProcess.pid > 0
      && liveProcess.origin === expected.origin
      && liveProcess.commit === expected.frozenBuild?.commit
      && liveProcess.archiveSha256 === expected.frozenBuild?.archiveSha256
      && liveProcess.launchReceiptSha256 === expected.frozenBuild?.launchReceiptSha256
      && liveProcess.httpStatus === 200
      && completedAcquisition(liveProcess, nowMs, maxAgeMs),
    "FROZEN_BUILD_IDENTITY_MISMATCH",
    failures,
  );

  const telemetryReady = gate(
    telemetry.status === "armed"
      && telemetry.captureMode === "passive_model_context_register_tool"
      && telemetry.injectionMode === "main_world_before_app_module"
      && telemetry.collectionMode === "authenticated_loopback_collector"
      && telemetry.controllerOnly === true
      && telemetry.authorQueryable === false
      && telemetry.authorEndpointExposed === false
      && telemetry.reloadInvalidatesEpoch === true
      && Number.isSafeInteger(telemetry.maxCaptureBytes)
      && telemetry.maxCaptureBytes > 0
      && Number.isSafeInteger(telemetry.maxInvocations)
      && telemetry.maxInvocations > 0
      && Number.isSafeInteger(telemetry.expectedRegisteredToolCount)
      && telemetry.expectedRegisteredToolCount > 0
      && SHA256_PATTERN.test(telemetry.observerSourceSha256 ?? "")
      && SHA256_PATTERN.test(telemetry.observerConfigSha256 ?? "")
      && SHA256_PATTERN.test(telemetry.calibrationReceiptSha256 ?? ""),
    "COMPLETE_NATIVE_TELEMETRY_NOT_ARMED",
    failures,
  );

  const evidenceFresh = gate(
    freshEnough(evidence.observedAt, nowMs, maxAgeMs),
    "PREFLIGHT_EVIDENCE_STALE_OR_INVALID",
    failures,
  );
  const attestationValid = gate(
    validAttestation(input)
      && freshEnough(input?.attestation?.content?.signedAt, nowMs, maxAgeMs),
    "PREFLIGHT_ATTESTATION_INVALID_OR_STALE",
    failures,
  );

  return {
    schemaVersion: EXP0036_ATTEMPT_PREFLIGHT_SCHEMA_VERSION,
    protocolId: "EXP-0036",
    attemptId: nonEmptyString(expected.attemptId) ? expected.attemptId : null,
    phase: "infrastructure_precreation",
    decision: failures.length === 0 ? "task_creation_ready" : "task_creation_blocked",
    authorTaskCreationAuthorized: false,
    reasons: failures,
    gates: {
      expectedShape,
      noTaskStarted,
      originReserved,
      wildcardIsolationCalibrated,
      hostUnlocked,
      frozenBuildMatches,
      telemetryReady,
      evidenceFresh,
      attestationValid,
    },
    checkedAt: new Date(nowMs).toISOString(),
    payloadSha256: hashExp0036PreflightValue(signedContent(input)),
    diagnostics: {
      isolationProbeAAcquisitionMs: acquisitionDurationMs(probeA),
      isolationProbeBAcquisitionMs: acquisitionDurationMs(probeB),
      hostUnlockAcquisitionMs: acquisitionDurationMs(hostUnlock),
      liveBuildProbeAcquisitionMs: acquisitionDurationMs(liveProcess),
    },
    caveat: "This infrastructure result establishes technical readiness only. Codex create_thread immediately starts the first turn, so the actual task, browser session, signed guest session, and terminal recorder epoch can only be admitted after creation under a frozen timing/bootstrap procedure.",
  };
}

function quoted(value) {
  return JSON.stringify(value);
}

/** Derive an opaque per-attempt localhost label from a controller nonce. */
export function createExp0036AttemptOrigin({ attemptId, nonce, port, protocol = "http:" }) {
  if (!nonEmptyString(attemptId) || !nonEmptyString(nonce) || nonce.length < 16
      || !Number.isSafeInteger(port) || port < 1 || port > 65_535
      || !["http:", "https:"].includes(protocol)) {
    throw new Error("EXP0036 attempt-origin configuration is invalid.");
  }
  const attemptLabel = attemptId.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 20) || "attempt";
  const nonceDigest = createHash("sha256")
    .update(Buffer.from(`${attemptId}\0${nonce}`, "utf8"))
    .digest("hex").slice(0, 20);
  const hostname = `exp0036-${attemptLabel}-${nonceDigest}.localhost`;
  return { hostname, origin: `${protocol}//${hostname}:${port}` };
}

/**
 * Produce the post-creation admission CUA program for a unique *.localhost
 * origin. It cannot serve as a task-release gate because create_thread begins
 * the task's first turn immediately.
 * The caller must first initialize CUA with its required one-call bootstrap.
 * The returned program uses only documented browser/WebMCP APIs.
 */
export function buildExp0036CuaPreflightProgram(config) {
  const browserId = config?.browserId;
  const expectedOrigin = origin(config?.origin);
  if (!nonEmptyString(browserId) || !expectedOrigin
      || !UNIQUE_LOCALHOST_PATTERN.test(expectedOrigin.hostname)
      || !nonEmptyString(config?.roomCode)
      || !nonEmptyString(config?.expectedRoomId)
      || !nonEmptyString(config?.displayName)
      || !nonEmptyString(config?.preflightNonce)) {
    throw new Error("EXP0036 CUA preflight program configuration is invalid.");
  }
  return `await (async () => {\n`
    + `  const expectedOrigin = ${quoted(expectedOrigin.origin)};\n`
    + `  const expectedHostname = ${quoted(expectedOrigin.hostname)};\n`
    + `  const expectedRoomId = ${quoted(config.expectedRoomId)};\n`
    + `  const preflightNonce = ${quoted(config.preflightNonce)};\n`
    + `  const unwrap = (value) => value && typeof value === "object" && value.result && typeof value.result === "object" ? value.result : value;\n`
    + `  const activeTab = await cua.createBrowserTab(${quoted(browserId)}, expectedOrigin + "/", { visible: false });\n`
    + `  const loadedUrl = new URL(await activeTab.url());\n`
    + `  if (loadedUrl.origin !== expectedOrigin) throw new Error("EXP0036_PREFLIGHT_ORIGIN_MISMATCH");\n`
    + `  const webmcp = await activeTab.capabilities.get("webmcp");\n`
    + `  let tools = await webmcp.fetchTools();\n`
    + `  const recentEnvelope = unwrap(await tools.call("list_recent_rooms", {}));\n`
    + `  if (!recentEnvelope || recentEnvelope.ok !== true || !Array.isArray(recentEnvelope.data?.rooms) || recentEnvelope.data.rooms.length !== 0) throw new Error("EXP0036_PREFLIGHT_RECENT_ROOMS_NOT_EMPTY");\n`
    + `  const joinedEnvelope = unwrap(await tools.call("join_room", { code: ${quoted(config.roomCode)}, displayName: ${quoted(config.displayName)}, role: "participant" }));\n`
    + `  if (!joinedEnvelope || joinedEnvelope.ok !== true || joinedEnvelope.data?.room?.id !== expectedRoomId || joinedEnvelope.data?.role !== "participant") throw new Error("EXP0036_PREFLIGHT_JOIN_FAILED");\n`
    + `  await activeTab.goto(new URL(joinedEnvelope.data.path, expectedOrigin).href);\n`
    + `  tools = await webmcp.fetchTools();\n`
    + `  const readRequestedAt = new Date().toISOString();\n`
    + `  const stateEnvelope = unwrap(await tools.call("read_room_state", { detail: "summary" }));\n`
    + `  const readRespondedAt = new Date().toISOString();\n`
    + `  const participantId = stateEnvelope?.data?.room?.selfParticipantId;\n`
    + `  if (!stateEnvelope || stateEnvelope.ok !== true || stateEnvelope.data?.room?.id !== expectedRoomId || typeof participantId !== "string" || !participantId.startsWith("p_")) throw new Error("EXP0036_PREFLIGHT_SIGNED_SESSION_READ_FAILED");\n`
    + `  nodeRepl.write(JSON.stringify({ schemaVersion: ${quoted(EXP0036_ATTEMPT_PREFLIGHT_SCHEMA_VERSION)}, kind: "cua_post_creation_admission_probe", preflightNonce, origin: expectedOrigin, sourceHostnameExpected: expectedHostname, browserSessionId: ${quoted(config.browserSessionId ?? "")}, tabId: activeTab.id, unlocked: true, recentRoomCountBeforeJoin: 0, joinSucceeded: true, signedSessionAuthorizedReadSucceeded: true, authorizedReadProbe: { requestedAt: readRequestedAt, respondedAt: readRespondedAt }, cookieProbe: { status: "not_collected", reason: "post_creation_cdp_target_access_not_required" }, participantId, roomId: expectedRoomId, observedAt: readRespondedAt }));\n`
    + `})()`;
}
