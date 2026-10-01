#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  sign as signMessage,
  verify as verifySignature,
} from "node:crypto";

import {
  canonicalExp0036PreflightJson,
  hashExp0036PreflightValue,
} from "./exp0036-attempt-preflight.mjs";

export const EXP0036_ADMISSION_V2_SCHEMA_VERSION = "jazzboard-exp0036-admission/v2";
export const EXP0036_ADMISSION_V2_SIGNATURE_DOMAIN = "Jazzboard EXP-0036 admission supplement v2\0";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const UNIQUE_LOCALHOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.localhost$/;
const FORBIDDEN_COOKIE_OBSERVATION_KEYS = new Set([
  "cookieProbe",
  "preJoinCookieCount",
  "postJoinCookieName",
  "postJoinCookieCount",
  "postJoinCookieDomain",
  "postJoinCookieHttpOnly",
]);
const LANDING_TOOL_NAMES = new Set([
  "create_room", "join_room", "list_recent_rooms", "open_recent_room", "remove_recent_room",
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fresh(value, nowMs, maxAgeMs) {
  const parsed = timestamp(value);
  return parsed !== null && parsed <= nowMs && nowMs - parsed <= maxAgeMs;
}

function completedFresh(value, nowMs, maxAgeMs) {
  const item = record(value);
  const requested = timestamp(item?.requestedAt);
  const responded = timestamp(item?.respondedAt);
  return requested !== null && responded !== null && responded >= requested
    && fresh(item.respondedAt, nowMs, maxAgeMs);
}

function completedWithinWindow(value, startMs, endMs, windowMs) {
  const item = record(value);
  const requested = timestamp(item?.requestedAt);
  const responded = timestamp(item?.respondedAt);
  return requested !== null && responded !== null && startMs !== null && endMs !== null
    && requested >= startMs && responded >= requested && responded <= endMs
    && responded - startMs <= windowMs;
}

function localhostOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/"
        || parsed.search || parsed.hash || !UNIQUE_LOCALHOST.test(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function publicKeySha256(publicKeyPem) {
  try {
    const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
    return `sha256:${createHash("sha256").update(der).digest("hex")}`;
  } catch {
    return null;
  }
}

export function hashExp0036ParticipantIdentityV2(participantId) {
  if (!nonEmpty(participantId)) throw new Error("EXP0036 v2 participant identity is invalid.");
  return `sha256:${createHash("sha256")
    .update(Buffer.from(`EXP0036 isolated participant identity v2\0${participantId}`, "utf8"))
    .digest("hex")}`;
}

function contentPayload(input) {
  return { expected: input.expected, evidence: input.evidence };
}

function withoutPayloadSha256(value) {
  const copy = { ...value };
  delete copy.payloadSha256;
  return copy;
}

function withoutReceiptSha256(value) {
  const copy = { ...value };
  delete copy.receiptSha256;
  return copy;
}

function hasForbiddenCookieObservations(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenCookieObservations);
  const item = record(value);
  if (!item) return false;
  return Object.entries(item).some(([key, child]) => (
    FORBIDDEN_COOKIE_OBSERVATION_KEYS.has(key) || hasForbiddenCookieObservations(child)
  ));
}

export function exp0036AdmissionV2SignatureMessage(content) {
  return Buffer.from(
    `${EXP0036_ADMISSION_V2_SIGNATURE_DOMAIN}${canonicalExp0036PreflightJson(content)}`,
    "utf8",
  );
}

/** Sign already collected controller evidence; the private key is never retained. */
export function signExp0036AdmissionV2Input(input, options) {
  const kind = options?.kind;
  const signedAt = options?.signedAt;
  const authority = record(input?.expected?.authority);
  if (!["infrastructure_preflight_v2_attestation", "attempt_admission_v2_attestation"].includes(kind)
      || timestamp(signedAt) === null || !nonEmpty(options?.privateKeyPem) || !authority) {
    throw new Error("EXP0036 v2 signing configuration is invalid.");
  }
  let signingKeySha256;
  try {
    const der = createPublicKey(options.privateKeyPem).export({ type: "spki", format: "der" });
    signingKeySha256 = `sha256:${createHash("sha256").update(der).digest("hex")}`;
  } catch {
    throw new Error("EXP0036 v2 signing key is invalid.");
  }
  if (signingKeySha256 !== authority.publicKeySha256
      || publicKeySha256(authority.publicKeyPem) !== authority.publicKeySha256) {
    throw new Error("EXP0036 v2 signing key does not match the expected authority.");
  }
  const content = {
    schemaVersion: EXP0036_ADMISSION_V2_SCHEMA_VERSION,
    protocolId: "EXP-0036",
    kind,
    keyId: authority.keyId,
    publicKeySha256: authority.publicKeySha256,
    payloadSha256: hashExp0036PreflightValue(contentPayload(input)),
    signedAt,
  };
  return {
    ...input,
    attestation: {
      content,
      signatureBase64: signMessage(
        null,
        exp0036AdmissionV2SignatureMessage(content),
        options.privateKeyPem,
      ).toString("base64"),
    },
  };
}

function validAttestation(input, expectedKind, nowMs, maxAgeMs) {
  const authority = record(input?.expected?.authority);
  const attestation = record(input?.attestation);
  const content = record(attestation?.content);
  if (!authority || !attestation || !content || typeof attestation.signatureBase64 !== "string") return false;
  if (content.schemaVersion !== EXP0036_ADMISSION_V2_SCHEMA_VERSION
      || content.protocolId !== "EXP-0036"
      || content.kind !== expectedKind
      || content.keyId !== authority.keyId
      || content.publicKeySha256 !== authority.publicKeySha256
      || content.payloadSha256 !== hashExp0036PreflightValue(contentPayload(input))
      || publicKeySha256(authority.publicKeyPem) !== authority.publicKeySha256
      || !fresh(content.signedAt, nowMs, maxAgeMs)) return false;
  try {
    const signature = Buffer.from(attestation.signatureBase64, "base64");
    return signature.length === 64 && verifySignature(
      null,
      exp0036AdmissionV2SignatureMessage(content),
      createPublicKey(authority.publicKeyPem),
      signature,
    );
  } catch {
    return false;
  }
}

function unwrapReceipt(value) {
  const envelope = record(value);
  return record(envelope?.receipt) ?? envelope;
}

function parseLedger(receipt) {
  const retrieval = record(receipt?.retrieval);
  if (!retrieval || !Array.isArray(retrieval.chunks)) return null;
  try {
    return JSON.parse(retrieval.chunks.map((chunk) => chunk.jsonFragment).join(""));
  } catch {
    return null;
  }
}

function deriveCalibrationProbe(input) {
  const receipt = unwrapReceipt(input?.receipt);
  const ledger = parseLedger(receipt);
  const binding = record(receipt?.binding) ?? {};
  const parsedOrigin = localhostOrigin(binding.appOrigin);
  const calls = Array.isArray(ledger?.calls) ? ledger.calls : [];
  const recent = calls[0];
  const identityCall = calls.find((call) => {
    if (call?.toolName !== "read_room_state" || call?.output?.status !== "complete") return false;
    try { return nonEmpty(JSON.parse(call.output.json)?.data?.room?.selfParticipantId); } catch { return false; }
  });
  let recentOutput = null;
  let participantId = null;
  try { recentOutput = JSON.parse(recent?.output?.json); } catch { /* invalid below */ }
  try { participantId = JSON.parse(identityCall?.output?.json)?.data?.room?.selfParticipantId ?? null; } catch { /* invalid below */ }
  if (receipt?.schemaVersion !== "jazzboard-exp0036-probe-collector/v1"
      || !parsedOrigin
      || receipt?.seal?.complete !== true
      || receipt?.seal?.ledgerSealed !== true
      || receipt?.transport?.zeroDrops !== true
      || receipt?.transport?.rejectedEventCount !== 0
      || receipt?.transport?.externalRejectedRequestCount !== 0
      || receipt?.retrieval?.complete !== true
      || receipt?.retrieval?.truncated !== false
      || ledger?.lifecycle?.state !== "sealed"
      || ledger?.captureComplete !== true
      || ledger?.valid !== true
      || recent?.sequence !== 1
      || recent?.toolName !== "list_recent_rooms"
      || recent?.outcome !== "success"
      || recent?.output?.status !== "complete"
      || recentOutput?.ok !== true
      || !Array.isArray(recentOutput?.data?.rooms)
      || recentOutput.data.rooms.length !== 0
      || !nonEmpty(participantId)
      || !SHA256.test(input?.receiptFileSha256 ?? "")
      || !SHA256.test(receipt?.receiptSha256 ?? "")
      || receipt.receiptSha256 !== hashExp0036PreflightValue(withoutReceiptSha256(receipt))) {
    throw new Error("EXP0036 v2 isolation calibration receipt is incomplete or incompatible.");
  }
  return {
    attemptId: receipt.attemptId,
    origin: binding.appOrigin,
    sourceHostname: parsedOrigin.hostname,
    receiptFileSha256: input.receiptFileSha256,
    receiptSha256: receipt.receiptSha256,
    observerSourceSha256: binding.observerSourceSha256,
    observerConfigSha256: binding.observerConfigSha256,
    collectorSealComplete: true,
    ledgerValid: true,
    preJoinNativeRead: {
      toolName: "list_recent_rooms",
      sequence: 1,
      outcome: "success",
      outputComplete: true,
      outputSha256: recent.output.sha256,
      roomReferences: [],
    },
    participantIdentitySha256: hashExp0036ParticipantIdentityV2(participantId),
  };
}

/** Derive immutable calibration evidence from two already sealed native receipts. */
export function deriveExp0036ImmutableIsolationCalibrationV2(input) {
  const source = record(input?.sourceAttestation);
  if (source?.method !== "frozen_source_review"
      || source?.finding !== "guest_cookie_host_only_http_only"
      || !Array.isArray(source?.commits) || source.commits.length !== 2
      || !source.commits.every((commit) => COMMIT.test(commit))
      || source.commits[0] === source.commits[1]
      || !nonEmpty(source?.sourcePath)
      || !SHA256.test(source?.sourceSha256 ?? "")
      || timestamp(source?.reviewedAt) === null) {
    throw new Error("EXP0036 v2 frozen-source isolation attestation is invalid.");
  }
  const probeA = deriveCalibrationProbe(input.probeA);
  const probeB = deriveCalibrationProbe(input.probeB);
  if (probeA.origin === probeB.origin
      || probeA.participantIdentitySha256 === probeB.participantIdentitySha256) {
    throw new Error("EXP0036 v2 isolation calibration did not produce distinct origins and identities.");
  }
  const evidence = {
    schemaVersion: EXP0036_ADMISSION_V2_SCHEMA_VERSION,
    calibrationId: input.calibrationId,
    method: "sealed_native_unique_localhost_origin_pair_plus_frozen_source_review",
    status: "passed",
    immutable: true,
    verifiedAt: input.verifiedAt,
    sourceAttestation: source,
    probes: [probeA, probeB],
  };
  if (!nonEmpty(evidence.calibrationId) || timestamp(evidence.verifiedAt) === null) {
    throw new Error("EXP0036 v2 isolation calibration identity or timestamp is invalid.");
  }
  return { ...evidence, payloadSha256: hashExp0036PreflightValue(evidence) };
}

function gate(condition, code, failures) {
  if (!condition) failures.push(code);
  return condition;
}

function validAuthority(expected) {
  const authority = record(expected.authority);
  return authority && nonEmpty(authority.keyId) && nonEmpty(authority.publicKeyPem)
    && SHA256.test(authority.publicKeySha256 ?? "")
    && publicKeySha256(authority.publicKeyPem) === authority.publicKeySha256;
}

function validBuild(build, expectedOrigin) {
  return record(build) && ["A0", "A1"].includes(build.arm) && COMMIT.test(build.commit ?? "")
    && SHA256.test(build.archiveSha256 ?? "") && SHA256.test(build.dependencyTreeSha256 ?? "")
    && SHA256.test(build.launchReceiptSha256 ?? "") && build.origin === expectedOrigin;
}

function validTelemetry(value) {
  const item = record(value);
  return item?.status === "armed"
    && item.captureMode === "passive_model_context_register_tool"
    && item.collectionMode === "authenticated_loopback_collector"
    && item.controllerOnly === true && item.authorQueryable === false
    && Number.isSafeInteger(item.maxCaptureBytes) && item.maxCaptureBytes > 0
    && Number.isSafeInteger(item.maxInvocations) && item.maxInvocations > 0
    && SHA256.test(item.observerSourceSha256 ?? "")
    && SHA256.test(item.observerConfigSha256 ?? "")
    && SHA256.test(item.calibrationReceiptSha256 ?? "");
}

function validImmutableCalibration(value, expectedSha256) {
  const item = record(value);
  const probes = Array.isArray(item?.probes) ? item.probes : [];
  return item?.schemaVersion === EXP0036_ADMISSION_V2_SCHEMA_VERSION
    && item.method === "sealed_native_unique_localhost_origin_pair_plus_frozen_source_review"
    && item.status === "passed" && item.immutable === true && timestamp(item.verifiedAt) !== null
    && item.payloadSha256 === expectedSha256
    && item.payloadSha256 === hashExp0036PreflightValue(withoutPayloadSha256(item))
    && item.sourceAttestation?.method === "frozen_source_review"
    && item.sourceAttestation?.finding === "guest_cookie_host_only_http_only"
    && Array.isArray(item.sourceAttestation?.commits)
    && item.sourceAttestation.commits.length === 2
    && item.sourceAttestation.commits.every((commit) => COMMIT.test(commit))
    && item.sourceAttestation.commits[0] !== item.sourceAttestation.commits[1]
    && nonEmpty(item.sourceAttestation?.sourcePath)
    && SHA256.test(item.sourceAttestation?.sourceSha256 ?? "")
    && timestamp(item.sourceAttestation?.reviewedAt) !== null
    && probes.length === 2
    && probes.every((probe) => localhostOrigin(probe?.origin)
      && probe.collectorSealComplete === true && probe.ledgerValid === true
      && SHA256.test(probe.receiptFileSha256 ?? "") && SHA256.test(probe.receiptSha256 ?? "")
      && probe.preJoinNativeRead?.toolName === "list_recent_rooms"
      && probe.preJoinNativeRead?.outcome === "success"
      && probe.preJoinNativeRead?.outputComplete === true
      && Array.isArray(probe.preJoinNativeRead?.roomReferences)
      && probe.preJoinNativeRead.roomReferences.length === 0
      && SHA256.test(probe.participantIdentitySha256 ?? ""))
    && probes[0].origin !== probes[1].origin
    && probes[0].participantIdentitySha256 !== probes[1].participantIdentitySha256
    && !hasForbiddenCookieObservations(item);
}

/** Infrastructure gate that permits immutable calibration and avoids repeated CDP probes. */
export function evaluateExp0036InfrastructurePreflightV2(input, options = {}) {
  const expected = record(input?.expected) ?? {};
  const evidence = record(input?.evidence) ?? {};
  const nowMs = timestamp(options.now ?? new Date().toISOString());
  if (nowMs === null) throw new Error("EXP0036 v2 infrastructure preflight requires a valid current timestamp.");
  const maxAgeMs = Number.isSafeInteger(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : 60_000;
  const failures = [];
  const expectedOrigin = localhostOrigin(expected.origin);
  const reservation = record(evidence.originReservation) ?? {};
  const host = record(evidence.hostAvailability) ?? {};
  const priorOrigins = Array.isArray(expected?.prior?.origins) ? expected.prior.origins : null;
  const live = record(evidence.liveBuildProcess) ?? {};
  const expectedShape = gate(expected.protocolId === "EXP-0036"
    && expected.phase === "infrastructure_precreation_v2"
    && evidence.phase === "infrastructure_precreation_v2"
    && nonEmpty(expected.attemptId) && expectedOrigin
    && SHA256.test(expected.isolationCalibrationPayloadSha256 ?? "")
    && validBuild(expected.frozenBuild, expected.origin) && validAuthority(expected)
    && priorOrigins !== null && priorOrigins.every(nonEmpty),
  "INFRASTRUCTURE_V2_EXPECTATION_INVALID", failures);
  const noTaskStarted = gate(evidence.taskCreationStatus === "not_started"
    && evidence.taskId === undefined && evidence.browserSessionId === undefined,
  "TASK_ALREADY_STARTED_DURING_INFRASTRUCTURE_V2", failures);
  const originReserved = gate(reservation.method === "controller_nonce_and_attempt_ledger"
    && reservation.origin === expected.origin && reservation.hostname === expectedOrigin?.hostname
    && reservation.browserFirstUse === true && reservation.browserNavigationCount === 0
    && reservation.collisionCheckComplete === true && !priorOrigins?.includes(expected.origin),
  "ATTEMPT_ORIGIN_NOT_RESERVED_V2", failures);
  const immutableIsolationCalibrated = gate(validImmutableCalibration(
    evidence.immutableIsolationCalibration,
    expected.isolationCalibrationPayloadSha256,
  ), "IMMUTABLE_ISOLATION_CALIBRATION_INVALID", failures);
  const hostFresh = gate(host.method === "supported_cua_native_host_availability"
    && host.status === "unlocked" && host.probeStatus === "completed"
    && nonEmpty(host.browserId) && Number.isSafeInteger(host.nativeToolCount) && host.nativeToolCount > 0
    && completedFresh(host, nowMs, maxAgeMs), "NATIVE_HOST_AVAILABILITY_NOT_FRESH_V2", failures);
  const frozenBuildMatches = gate(validBuild(evidence.frozenBuild, expected.origin)
    && canonicalExp0036PreflightJson(evidence.frozenBuild) === canonicalExp0036PreflightJson(expected.frozenBuild)
    && live.method === "controller_pid_cwd_and_http_probe" && Number.isSafeInteger(live.pid) && live.pid > 0
    && live.origin === expected.origin && live.commit === expected.frozenBuild?.commit
    && live.archiveSha256 === expected.frozenBuild?.archiveSha256 && live.httpStatus === 200
    && completedFresh(live, nowMs, maxAgeMs), "FROZEN_BUILD_IDENTITY_MISMATCH_V2", failures);
  const telemetryReady = gate(validTelemetry(evidence.telemetryReadiness), "NATIVE_TELEMETRY_NOT_ARMED_V2", failures);
  const evidenceFresh = gate(fresh(evidence.observedAt, nowMs, maxAgeMs), "INFRASTRUCTURE_V2_EVIDENCE_STALE", failures);
  const noFabricatedCookieEvidence = gate(!hasForbiddenCookieObservations(evidence), "COOKIE_OBSERVATION_FIELDS_FORBIDDEN_V2", failures);
  const attestationValid = gate(validAttestation(
    input, "infrastructure_preflight_v2_attestation", nowMs, maxAgeMs,
  ), "INFRASTRUCTURE_V2_ATTESTATION_INVALID", failures);
  return {
    schemaVersion: EXP0036_ADMISSION_V2_SCHEMA_VERSION,
    protocolId: "EXP-0036",
    phase: "infrastructure_precreation_v2",
    decision: failures.length === 0 ? "task_creation_ready" : "task_creation_blocked",
    authorTaskCreationAuthorized: false,
    reasons: failures,
    gates: { expectedShape, noTaskStarted, originReserved, immutableIsolationCalibrated, hostFresh,
      frozenBuildMatches, telemetryReady, evidenceFresh, noFabricatedCookieEvidence, attestationValid },
    checkedAt: new Date(nowMs).toISOString(),
    payloadSha256: hashExp0036PreflightValue(contentPayload(input)),
  };
}

function validNativeProof(proof, expected, hostname) {
  return record(proof) && proof.method === "normal_cua_native_webmcp"
    && proof.origin === expected.origin && proof.sourceHostname === hostname
    && proof.browserSessionId === expected.browserSessionId
    && nonEmpty(proof.toolName) && ["success", "error"].includes(proof.outcome)
    && Number.isSafeInteger(proof.invocationSequence) && proof.invocationSequence > 0
    && proof.outputComplete === true && SHA256.test(proof.inputSha256 ?? "")
    && SHA256.test(proof.outputSha256 ?? "");
}

/** Post-creation admission using fresh native calls plus independent participant delta. */
export function evaluateExp0036AttemptAdmissionV2(input, options = {}) {
  const expected = record(input?.expected) ?? {};
  const evidence = record(input?.evidence) ?? {};
  const nowMs = timestamp(options.now ?? new Date().toISOString());
  if (nowMs === null) throw new Error("EXP0036 v2 admission requires a valid current timestamp.");
  const maxAgeMs = Number.isSafeInteger(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : 60_000;
  const taskWindowMs = Number.isSafeInteger(options.taskWindowMs) && options.taskWindowMs > 0
    ? options.taskWindowMs : 15 * 60_000;
  const failures = [];
  const parsedOrigin = localhostOrigin(expected.origin);
  const hostname = parsedOrigin?.hostname ?? null;
  const task = record(evidence.task) ?? {};
  const isolation = record(evidence.isolation) ?? {};
  const preJoin = record(evidence.preJoinNativeProof) ?? {};
  const join = record(evidence.joinNativeProof) ?? {};
  const firstRoomTool = record(evidence.firstNaturalRoomToolProof) ?? {};
  const delta = record(evidence.participantDeltaProof) ?? {};
  const host = record(evidence.hostAvailability) ?? {};
  const prior = record(expected.prior) ?? {};
  const priorTaskIds = Array.isArray(prior.taskIds) ? prior.taskIds : null;
  const priorBrowserSessionIds = Array.isArray(prior.browserSessionIds) ? prior.browserSessionIds : null;
  const priorSessionIdentitySha256s = Array.isArray(prior.sessionIdentitySha256s)
    ? prior.sessionIdentitySha256s : null;
  const taskStartedMs = timestamp(task.startedAt);
  const observedMs = timestamp(evidence.observedAt);
  const expectedShape = gate(expected.protocolId === "EXP-0036"
    && expected.phase === "post_creation_admission_v2" && evidence.phase === "post_creation_admission_v2"
    && nonEmpty(expected.attemptId) && nonEmpty(expected.taskId) && nonEmpty(expected.browserSessionId)
    && parsedOrigin && SHA256.test(expected.infrastructurePreflightPayloadSha256 ?? "")
    && SHA256.test(expected.isolationCalibrationPayloadSha256 ?? "")
    && SHA256.test(expected.roomIdentitySha256 ?? "")
    && evidence.infrastructurePreflightPayloadSha256 === expected.infrastructurePreflightPayloadSha256
    && validBuild(expected.frozenBuild, expected.origin) && validAuthority(expected)
    && priorTaskIds !== null && priorTaskIds.every(nonEmpty)
    && priorBrowserSessionIds !== null && priorBrowserSessionIds.every(nonEmpty)
    && priorSessionIdentitySha256s !== null
    && priorSessionIdentitySha256s.every((value) => SHA256.test(value)),
  "ADMISSION_V2_EXPECTATION_INVALID", failures);
  const taskUnique = gate(task.taskId === expected.taskId && task.browserSessionId === expected.browserSessionId
    && task.target === "projectless" && task.history === "fresh" && task.priorCompletedTurnCount === 0
    && taskStartedMs !== null && observedMs !== null && observedMs >= taskStartedMs
    && observedMs - taskStartedMs <= taskWindowMs
    && !priorTaskIds?.includes(task.taskId) && !priorBrowserSessionIds?.includes(task.browserSessionId),
  "TASK_OR_BROWSER_SESSION_NOT_FRESH_V2", failures);
  const isolationBound = gate(isolation.method === "unique_localhost_origin_from_immutable_calibration"
    && isolation.origin === expected.origin && isolation.sourceHostname === hostname
    && isolation.originFirstUse === true && isolation.loadedThroughCua === true
    && isolation.calibrationPayloadSha256 === expected.isolationCalibrationPayloadSha256,
  "ATTEMPT_ORIGIN_NOT_BOUND_TO_CALIBRATION_V2", failures);
  const preJoinEmpty = gate(validNativeProof(preJoin, expected, hostname)
    && preJoin.toolName === "list_recent_rooms" && preJoin.outcome === "success"
    && completedWithinWindow(preJoin, taskStartedMs, observedMs, taskWindowMs)
    && Array.isArray(preJoin.roomReferences) && preJoin.roomReferences.length === 0,
  "FRESH_NATIVE_PREJOIN_EMPTY_READ_MISSING_V2", failures);
  const joinFresh = gate(validNativeProof(join, expected, hostname)
    && join.toolName === "join_room" && join.outcome === "success"
    && join.invocationSequence > preJoin.invocationSequence
    && completedWithinWindow(join, taskStartedMs, observedMs, taskWindowMs)
    && SHA256.test(join.participantIdentitySha256 ?? "")
    && join.identityBindingMethod === "controller_delta_bracketing_native_join"
    && join.outputContainsParticipantIdentity === false
    && !priorSessionIdentitySha256s?.includes(join.participantIdentitySha256),
  "FRESH_NATIVE_JOIN_MISSING_V2", failures);
  const naturalRoomToolFresh = gate(validNativeProof(firstRoomTool, expected, hostname)
    && !LANDING_TOOL_NAMES.has(firstRoomTool.toolName)
    && firstRoomTool.outcome === "success"
    && firstRoomTool.invocationSequence > join.invocationSequence
    && completedWithinWindow(firstRoomTool, taskStartedMs, observedMs, taskWindowMs)
    && firstRoomTool.firstRoomScopedInvocationAfterJoin === true
    && firstRoomTool.promptDirected === false && firstRoomTool.requiredToolName === null,
  "FIRST_NATURAL_ROOM_TOOL_MISSING_V2", failures);
  const participantDeltaBound = gate(delta.method === "controller_room_snapshot_before_after_join"
    && delta.roomIdentitySha256 === expected.roomIdentitySha256
    && delta.addedParticipantCount === 1 && SHA256.test(delta.beforeSnapshotSha256 ?? "")
    && SHA256.test(delta.afterSnapshotSha256 ?? "")
    && SHA256.test(delta.addedParticipantIdentitySha256 ?? "")
    && delta.addedParticipantIdentitySha256 === join.participantIdentitySha256
    && timestamp(delta.requestedAt) >= timestamp(join.respondedAt)
    && completedWithinWindow(delta, taskStartedMs, observedMs, taskWindowMs),
  "INDEPENDENT_PARTICIPANT_DELTA_NOT_BOUND_V2", failures);
  const hostFresh = gate(host.method === "supported_cua_native_host_availability"
    && host.status === "unlocked" && host.probeStatus === "completed"
    && host.origin === expected.origin && host.browserSessionId === expected.browserSessionId
    && Number.isSafeInteger(host.nativeToolCount) && host.nativeToolCount > 0
    && completedFresh(host, nowMs, maxAgeMs), "NATIVE_HOST_AVAILABILITY_NOT_FRESH_V2", failures);
  const frozenBuildMatches = gate(validBuild(evidence.frozenBuild, expected.origin)
    && canonicalExp0036PreflightJson(evidence.frozenBuild) === canonicalExp0036PreflightJson(expected.frozenBuild),
  "FROZEN_BUILD_IDENTITY_MISMATCH_V2", failures);
  const telemetryReady = gate(validTelemetry(evidence.telemetryReadiness), "NATIVE_TELEMETRY_NOT_ARMED_V2", failures);
  const evidenceFresh = gate(fresh(evidence.observedAt, nowMs, maxAgeMs), "ADMISSION_V2_EVIDENCE_STALE", failures);
  const noFabricatedCookieEvidence = gate(!hasForbiddenCookieObservations(evidence), "COOKIE_OBSERVATION_FIELDS_FORBIDDEN_V2", failures);
  const attestationValid = gate(validAttestation(
    input, "attempt_admission_v2_attestation", nowMs, maxAgeMs,
  ), "ADMISSION_V2_ATTESTATION_INVALID", failures);
  return {
    schemaVersion: EXP0036_ADMISSION_V2_SCHEMA_VERSION,
    protocolId: "EXP-0036",
    phase: "post_creation_admission_v2",
    decision: failures.length === 0 ? "post_creation_evidence_complete" : "post_creation_evidence_blocked",
    authorTaskCreationAuthorized: false,
    reasons: failures,
    gates: { expectedShape, taskUnique, isolationBound, preJoinEmpty, joinFresh,
      naturalRoomToolFresh, participantDeltaBound, hostFresh, frozenBuildMatches, telemetryReady,
      evidenceFresh, noFabricatedCookieEvidence, attestationValid },
    checkedAt: new Date(nowMs).toISOString(),
    payloadSha256: hashExp0036PreflightValue(contentPayload(input)),
    caveat: "The first room tool is observed, not prescribed. A separately sealed terminal native ledger remains required.",
  };
}
