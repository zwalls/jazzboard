import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

import { EXP0036_NATIVE_RECORDER_SCHEMA_VERSION } from "./exp0036-native-recorder.mjs";
import {
  canonicalExp0036PreflightJson,
  hashExp0036PreflightValue,
} from "./exp0036-attempt-preflight.mjs";

export const EXP0036_NATIVE_TELEMETRY_SCHEMA_VERSION =
  "jazzboard-exp0036-native-telemetry/v1";
export const EXP0036_NATIVE_TELEMETRY_SIGNATURE_DOMAIN =
  "Jazzboard EXP-0036 native telemetry v1\0";
const EXP0036_PROBE_COLLECTOR_SCHEMA_VERSION =
  "jazzboard-exp0036-probe-collector/v1";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UNIQUE_LOCALHOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.localhost$/;
const RETURNED_KINDS = new Set([
  "returned_success",
  "returned_structured_error",
  "returned_mcp_error",
]);
const ERROR_KINDS = new Set([
  "returned_structured_error",
  "returned_mcp_error",
  "thrown",
  "rejected",
]);
const THROWN_KINDS = new Set(["thrown", "rejected"]);
const READ_TOOLS = new Set([
  "find_diagrams",
  "query_objects",
  "read_canvas_drafts",
  "read_collaboration_state",
  "read_diagram",
  "read_neighborhood",
  "read_room_state",
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function exact(left, right) {
  try {
    return canonicalExp0036PreflightJson(left) === canonicalExp0036PreflightJson(right);
  } catch {
    return false;
  }
}

function exactLocalhostOrigin(value, hostname) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:"
      && parsed.origin === value
      && parsed.hostname === hostname
      && UNIQUE_LOCALHOST_PATTERN.test(hostname)
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function sha256Utf8(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`;
}

function publicKeyDigest(publicKeyPem) {
  try {
    const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
    return `sha256:${createHash("sha256").update(der).digest("hex")}`;
  } catch {
    return null;
  }
}

function captureComplete(capture) {
  const value = record(capture);
  if (!value || value.status !== "complete" || typeof value.json !== "string"
      || !Number.isSafeInteger(value.utf8Bytes) || value.utf8Bytes < 0
      || !SHA256_PATTERN.test(value.sha256 ?? "")) return false;
  try {
    JSON.parse(value.json);
  } catch {
    return false;
  }
  return Buffer.byteLength(value.json, "utf8") === value.utf8Bytes
    && sha256Utf8(value.json) === value.sha256;
}

function unavailableReturnedOutput(capture, reason) {
  return record(capture) !== null
    && capture.status === "unavailable"
    && capture.json === null
    && capture.utf8Bytes === null
    && capture.sha256 === null
    && capture.reason === reason;
}

function validTimePoint(value) {
  const point = record(value);
  return point !== null
    && typeof point.epochMs === "number" && Number.isFinite(point.epochMs)
    && typeof point.monotonicMs === "number" && Number.isFinite(point.monotonicMs);
}

function expectedOutcome(kind) {
  return kind === "returned_success" ? "success" : ERROR_KINDS.has(kind) ? "error" : null;
}

function validCall(call, index, sessionEpoch) {
  const value = record(call);
  if (!value || value.sequence !== index + 1 || value.sessionEpoch !== sessionEpoch
      || typeof value.toolName !== "string" || !value.toolName
      || value.retained !== true || !validTimePoint(value.begun) || !validTimePoint(value.completed)
      || typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs)
      || value.durationMs < 0 || !captureComplete(value.input)
      || ![true, false].includes(value.abortedAtBegin)
      || ![true, false].includes(value.abortedAtCompletion)
      || value.outcome !== expectedOutcome(value.kind)) return false;
  if (value.completed.epochMs < value.begun.epochMs
      || value.completed.monotonicMs < value.begun.monotonicMs
      || value.durationMs !== Math.max(0, value.completed.monotonicMs - value.begun.monotonicMs)) {
    return false;
  }
  if (RETURNED_KINDS.has(value.kind)) {
    if (!captureComplete(value.output) || value.error !== null) return false;
    let output;
    try {
      output = JSON.parse(value.output.json);
    } catch {
      return false;
    }
    if (value.kind === "returned_mcp_error" && output?.isError !== true) return false;
    if (value.kind === "returned_structured_error" && output?.ok !== false) return false;
    if (value.kind === "returned_success" && (output?.isError === true || output?.ok === false)) return false;
    return true;
  }
  if (THROWN_KINDS.has(value.kind)) {
    if (!unavailableReturnedOutput(value.output, value.kind) || !captureComplete(value.error)) return false;
    let error;
    try {
      error = JSON.parse(value.error.json);
    } catch {
      return false;
    }
    return record(error) !== null && typeof error.type === "string";
  }
  return false;
}

function recomputeAggregates(ledger) {
  const calls = ledger.calls;
  const kinds = {
    returnedSuccess: 0,
    returnedStructuredError: 0,
    returnedMcpError: 0,
    thrown: 0,
    rejected: 0,
  };
  let success = 0;
  let error = 0;
  let inputUtf8Bytes = 0;
  let outputUtf8Bytes = 0;
  let errorUtf8Bytes = 0;
  let completeInputCount = 0;
  let completeOutputCount = 0;
  for (const call of calls) {
    if (call.outcome === "success") success += 1;
    if (call.outcome === "error") error += 1;
    if (call.kind === "returned_success") kinds.returnedSuccess += 1;
    if (call.kind === "returned_structured_error") kinds.returnedStructuredError += 1;
    if (call.kind === "returned_mcp_error") kinds.returnedMcpError += 1;
    if (call.kind === "thrown") kinds.thrown += 1;
    if (call.kind === "rejected") kinds.rejected += 1;
    if (call.input?.status === "complete") {
      completeInputCount += 1;
      inputUtf8Bytes += call.input.utf8Bytes;
    }
    if (call.output?.status === "complete") {
      completeOutputCount += 1;
      outputUtf8Bytes += call.output.utf8Bytes;
    }
    if (call.error?.status === "complete") errorUtf8Bytes += call.error.utf8Bytes;
  }
  return {
    started: calls.length,
    completed: calls.length,
    pending: 0,
    success,
    error,
    droppedInvocations: 0,
    ...kinds,
    inputUtf8Bytes,
    outputUtf8Bytes,
    errorUtf8Bytes,
    completeInputCount,
    completeOutputCount,
  };
}

function aggregatesMatch(ledger, coverage) {
  const aggregate = record(ledger.aggregates);
  if (!aggregate) return false;
  const calculated = recomputeAggregates(ledger);
  return aggregate.registrations === coverage.expectedRegisteredToolCount
    && Object.entries(calculated).every(([key, value]) => aggregate[key] === value);
}

function validBinding(evidence, expected) {
  const binding = record(evidence.binding);
  return binding !== null
    && binding.attemptId === expected.attemptId
    && binding.taskId === expected.taskId
    && binding.browserSessionId === expected.browserSessionId
    && binding.sessionEpoch === expected.sessionEpoch
    && binding.origin === expected.origin
    && binding.originHostname === expected.originHostname
    && binding.admissionPreflightPayloadSha256 === expected.admissionPreflightPayloadSha256
    && binding.observerSourceSha256 === expected.observerSourceSha256
    && binding.observerConfigSha256 === expected.observerConfigSha256
    && binding.calibrationReceiptSha256 === expected.calibrationReceiptSha256;
}

function validCollectorReceipt(receiptInput, retrieval, expected, registeredToolCount, callCount) {
  const receipt = record(receiptInput);
  const binding = record(receipt?.binding);
  const access = record(receipt?.access);
  const transport = record(receipt?.transport);
  const close = record(receipt?.close);
  const seal = record(receipt?.seal);
  const events = Array.isArray(transport?.events) ? transport.events : [];
  const rejectionDiagnostics = Array.isArray(transport?.rejectionDiagnostics)
    ? transport.rejectionDiagnostics : [];
  const eventTypeCount = (type) => events.filter((event) => event?.eventType === type).length;
  if (!receipt || !binding || !access || !transport || !close || !seal) return false;
  const { receiptSha256, ...receiptContent } = receipt;
  return receipt.schemaVersion === EXP0036_PROBE_COLLECTOR_SCHEMA_VERSION
    && receipt.attemptId === expected.attemptId
    && binding.sessionEpoch === expected.sessionEpoch
    && binding.appOrigin === expected.origin
    && binding.observerSourceSha256 === expected.observerSourceSha256
    && binding.observerConfigSha256 === expected.observerConfigSha256
    && access.controllerOnly === true
    && access.authorQueryable === false
    && access.authorQueryableScope === "permitted_native_webmcp_surface"
    && access.pageJavaScriptIsolationClaimed === false
    && access.separateIngestAndControlSecrets === true
    && access.injectionWorld === "main"
    && access.authorFacingEndpointCount === 0
    && access.publicWebMcpToolCountAdded === 0
    && Array.isArray(access.startupFailures)
    && access.startupFailures.length === 0
    && Number.isSafeInteger(transport.acceptedEventCount)
    && transport.acceptedEventCount > 0
    && transport.acceptedEventCount === 3 + registeredToolCount + (2 * callCount)
    && transport.nextExpectedSequence === transport.acceptedEventCount + 1
    && transport.firstSequence === 1
    && transport.lastSequence === transport.acceptedEventCount
    && Number.isSafeInteger(transport.duplicateEventCount)
    && transport.duplicateEventCount >= 0
    && transport.rejectedEventCount === 0
    && Number.isSafeInteger(transport.rejectedAuxiliaryRequestCount)
    && transport.rejectedAuxiliaryRequestCount >= 0
    && Number.isSafeInteger(transport.externalRejectedRequestCount)
    && transport.externalRejectedRequestCount >= 0
    && transport.rejectionDiagnosticCount === rejectionDiagnostics.length
    && rejectionDiagnostics.length <= 64
    && typeof transport.rejectionDiagnosticsCapped === "boolean"
    && (transport.rejectionDiagnosticsCapped
      ? rejectionDiagnostics.length === 64
      : rejectionDiagnostics.length === transport.rejectedEventCount
        + transport.rejectedAuxiliaryRequestCount + transport.externalRejectedRequestCount)
    && rejectionDiagnostics.every((diagnostic, index) => record(diagnostic) !== null
      && diagnostic.ordinal === index + 1
      && ["external_untrusted", "authenticated_event", "authenticated_auxiliary"]
        .includes(diagnostic.classification)
      && typeof diagnostic.code === "string"
      && typeof diagnostic.method === "string"
      && typeof diagnostic.path === "string"
      && (diagnostic.origin === null || typeof diagnostic.origin === "string")
      && ["tokenPresent", "hostMatches", "originMatches", "ingestTokenMatches", "controlTokenMatches"]
        .every((key) => typeof diagnostic[key] === "boolean"))
    && transport.gapCount === 0
    && Array.isArray(transport.gaps)
    && transport.gaps.length === 0
    && transport.capped === false
    && Number.isSafeInteger(transport.maxEvents)
    && transport.maxEvents >= transport.acceptedEventCount
    && transport.zeroDrops === true
    && events.length === transport.acceptedEventCount
    && events.every((event, index) => record(event) !== null
      && event.sequence === index + 1
      && typeof event.eventType === "string"
      && event.eventType.length > 0
      && SHA256_PATTERN.test(event.envelopeSha256 ?? "")
      && SHA256_PATTERN.test(event.ledgerJsonSha256 ?? ""))
    && events[0]?.eventType === "ledger_begin"
    && eventTypeCount("ledger_begin") === 1
    && eventTypeCount("tool_registered") === registeredToolCount
    && eventTypeCount("invocation_begin") === callCount
    && eventTypeCount("invocation_end") === callCount
    && eventTypeCount("close_requested") === 1
    && eventTypeCount("ledger_end") === 1
    && close.taskTerminal === true
    && close.terminalReference === expected.taskTerminalReference
    && timestamp(close.requestedAt) !== null
    && close.issuedBy === "controller"
    && seal.eventSequence === transport.lastSequence
    && events.at(-1)?.sequence === seal.eventSequence
    && events.at(-1)?.eventType === "ledger_end"
    && events.at(-1)?.ledgerJsonSha256 === retrieval.jsonSha256
    && seal.ledgerSealed === true
    && seal.complete === true
    && exact(receipt.retrieval, retrieval)
    && receiptSha256 === hashExp0036PreflightValue(receiptContent);
}

function signedPayload(evidence) {
  return {
    schemaVersion: evidence.schemaVersion,
    binding: evidence.binding,
    coverage: evidence.coverage,
    ledger: evidence.ledger,
  };
}

export function exp0036NativeTelemetrySignatureMessage(content) {
  return Buffer.from(
    `${EXP0036_NATIVE_TELEMETRY_SIGNATURE_DOMAIN}${canonicalExp0036PreflightJson(content)}`,
    "utf8",
  );
}

function validAttestation(evidence, expected) {
  const authority = record(expected.authority);
  const attestation = record(evidence.attestation);
  const content = record(attestation?.content);
  if (!authority || !attestation || !content || typeof attestation.signatureBase64 !== "string") {
    return false;
  }
  const signedAtMs = timestamp(content.signedAt);
  const closeRequestedAtMs = timestamp(evidence.coverage?.collectorReceipt?.close?.requestedAt);
  if (content.schemaVersion !== EXP0036_NATIVE_TELEMETRY_SCHEMA_VERSION
      || content.protocolId !== "EXP-0036"
      || content.kind !== "terminal_native_telemetry_attestation"
      || content.keyId !== authority.keyId
      || content.publicKeySha256 !== authority.publicKeySha256
      || content.payloadSha256 !== hashExp0036PreflightValue(signedPayload(evidence))
      || signedAtMs === null
      || closeRequestedAtMs === null
      || signedAtMs < closeRequestedAtMs
      || publicKeyDigest(authority.publicKeyPem) !== authority.publicKeySha256) return false;
  let signature;
  try {
    signature = Buffer.from(attestation.signatureBase64, "base64");
    return signature.length === 64 && verifySignature(
      null,
      exp0036NativeTelemetrySignatureMessage(content),
      createPublicKey(authority.publicKeyPem),
      signature,
    );
  } catch {
    return false;
  }
}

function gate(condition, code, failures) {
  if (!condition) failures.push(code);
  return condition;
}

/**
 * Validate a terminal passive-recorder ledger. Host session metadata may be
 * retained beside this evidence, but it cannot substitute for this contract:
 * EXP-0035 metadata had no attempt-level completeness or capping signal.
 */
export function verifyExp0036NativeTelemetry(evidenceInput, expectedInput) {
  const evidence = record(evidenceInput) ?? {};
  const expected = record(expectedInput) ?? {};
  const ledger = record(evidence.ledger) ?? {};
  const lifecycle = record(ledger.lifecycle) ?? {};
  const end = record(lifecycle.end) ?? {};
  const coverage = record(evidence.coverage) ?? {};
  const retrieval = record(coverage.retrieval) ?? {};
  const collectorReceipt = record(coverage.collectorReceipt) ?? {};
  const retrievalChunks = Array.isArray(retrieval.chunks) ? retrieval.chunks : [];
  const calls = Array.isArray(ledger.calls) ? ledger.calls : [];
  const failures = [];
  const rawLedgerJson = JSON.stringify(ledger);
  const rawLedgerUtf8Bytes = Buffer.byteLength(rawLedgerJson, "utf8");
  const rawLedgerSha256 = sha256Utf8(rawLedgerJson);
  const retrievalChunksValid = retrievalChunks.length > 0
    && retrievalChunks.every((chunk, index) => {
      const value = record(chunk);
      return value !== null
        && value.ordinal === index + 1
        && value.complete === true
        && value.truncated === false
        && typeof value.jsonFragment === "string"
        && Number.isSafeInteger(value.utf8Bytes)
        && value.utf8Bytes === Buffer.byteLength(value.jsonFragment, "utf8")
        && value.utf8Bytes <= retrieval.maxChunkUtf8Bytes
        && value.sha256 === sha256Utf8(value.jsonFragment);
    })
    && retrievalChunks.map((chunk) => chunk.jsonFragment).join("") === rawLedgerJson;

  const expectationValid = gate(
    typeof expected.attemptId === "string" && expected.attemptId.length > 0
      && typeof expected.taskId === "string" && expected.taskId.length > 0
      && typeof expected.browserSessionId === "string" && expected.browserSessionId.length > 0
      && typeof expected.sessionEpoch === "string" && expected.sessionEpoch.length > 0
      && typeof expected.origin === "string" && expected.origin.length > 0
      && typeof expected.originHostname === "string" && expected.originHostname.length > 0
      && exactLocalhostOrigin(expected.origin, expected.originHostname)
      && SHA256_PATTERN.test(expected.admissionPreflightPayloadSha256 ?? "")
      && SHA256_PATTERN.test(expected.observerSourceSha256 ?? "")
      && SHA256_PATTERN.test(expected.observerConfigSha256 ?? "")
      && SHA256_PATTERN.test(expected.calibrationReceiptSha256 ?? "")
      && typeof expected.taskTerminalReference === "string"
      && expected.taskTerminalReference.length > 0
      && Number.isSafeInteger(expected.expectedRegisteredToolCount)
      && expected.expectedRegisteredToolCount > 0
      && Number.isSafeInteger(expected.maxCaptureBytes)
      && expected.maxCaptureBytes > 0
      && Number.isSafeInteger(expected.maxInvocations)
      && expected.maxInvocations > 0
      && record(expected.authority) !== null,
    "TELEMETRY_EXPECTATION_INVALID",
    failures,
  );

  const bindingValid = gate(
    evidence.schemaVersion === EXP0036_NATIVE_TELEMETRY_SCHEMA_VERSION
      && validBinding(evidence, expected),
    "TELEMETRY_BINDING_MISMATCH",
    failures,
  );

  const coverageValid = gate(
    coverage.captureMode === "passive_model_context_register_tool"
      && coverage.injectionMode === "main_world_before_app_module"
      && coverage.collectionMode === "authenticated_loopback_collector"
      && coverage.controllerOnly === true
      && coverage.authorQueryable === false
      && coverage.authorEndpointExposed === false
      && coverage.installedBeforeAnyToolRegistration === true
      && coverage.registrationSetComplete === true
      && coverage.noUnobservedModelContext === true
      && coverage.noReloadAfterArming === true
      && Number.isSafeInteger(coverage.expectedRegisteredToolCount)
      && coverage.expectedRegisteredToolCount > 0
      && coverage.expectedRegisteredToolCount === expected.expectedRegisteredToolCount
      && coverage.observedRegisteredToolCount === coverage.expectedRegisteredToolCount
      && retrieval.method === "authenticated_loopback_collector"
      && retrieval.complete === true
      && retrieval.truncated === false
      && retrieval.originHostname === expected.originHostname
      && Number.isSafeInteger(retrieval.maxChunkUtf8Bytes)
      && retrieval.maxChunkUtf8Bytes === 32_768
      && retrieval.chunkCount === retrievalChunks.length
      && retrieval.completeChunkCount === retrievalChunks.length
      && retrieval.jsonUtf8Bytes === rawLedgerUtf8Bytes
      && retrieval.jsonSha256 === rawLedgerSha256
      && retrievalChunksValid
      && retrieval.ledgerSha256 === hashExp0036PreflightValue(ledger)
      && validCollectorReceipt(
        collectorReceipt,
        retrieval,
        expected,
        coverage.expectedRegisteredToolCount,
        calls.length,
      ),
    "RECORDER_COVERAGE_OR_RETRIEVAL_INCOMPLETE",
    failures,
  );

  const ledgerSealed = gate(
    ledger.schemaVersion === EXP0036_NATIVE_RECORDER_SCHEMA_VERSION
      && ledger.sessionEpoch === expected.sessionEpoch
      && ledger.captureComplete === true
      && ledger.valid === true
      && ledger.pendingCount === 0
      && lifecycle.state === "sealed"
      && lifecycle.closeRequested === true
      && validTimePoint(lifecycle.begin)
      && validTimePoint(end)
      && end.epochMs >= lifecycle.begin.epochMs
      && end.monotonicMs >= lifecycle.begin.monotonicMs
      && end.captureComplete === true
      && Array.isArray(ledger.invalidationReasons)
      && ledger.invalidationReasons.length === 0
      && calls.length > 0,
    "NATIVE_LEDGER_NOT_SEALED_COMPLETE",
    failures,
  );

  const callsComplete = gate(
    calls.length > 0
      && calls.every((call, index) => validCall(call, index, expected.sessionEpoch)),
    "NATIVE_CALL_RECORD_INCOMPLETE_OR_INVALID",
    failures,
  );

  const aggregateValid = gate(
    Array.isArray(ledger.calls)
      && record(ledger.capturePolicy) !== null
      && Number.isSafeInteger(ledger.capturePolicy.maxCaptureBytes)
      && ledger.capturePolicy.maxCaptureBytes > 0
      && ledger.capturePolicy.maxCaptureBytes === expected.maxCaptureBytes
      && Number.isSafeInteger(ledger.capturePolicy.maxInvocations)
      && ledger.capturePolicy.maxInvocations >= calls.length
      && ledger.capturePolicy.maxInvocations === expected.maxInvocations
      && ledger.capturePolicy.truncationInvalidates === true
      && coverageValid
      && aggregatesMatch(ledger, coverage),
    "NATIVE_LEDGER_AGGREGATES_INVALID",
    failures,
  );

  const attestationValid = gate(
    validAttestation(evidence, expected),
    "NATIVE_TELEMETRY_ATTESTATION_INVALID",
    failures,
  );

  const totalReturnedOutputUtf8Bytes = calls.reduce(
    (total, call) => total + (call.output?.status === "complete" ? call.output.utf8Bytes : 0),
    0,
  );
  const totalThrownErrorUtf8Bytes = calls.reduce(
    (total, call) => total + (call.error?.status === "complete" ? call.error.utf8Bytes : 0),
    0,
  );
  const readOutputUtf8Bytes = calls.reduce(
    (total, call) => total + (READ_TOOLS.has(call.toolName) && call.output?.status === "complete"
      ? call.output.utf8Bytes : 0),
    0,
  );
  const perCall = calls.map((call) => ({
    sequence: call.sequence,
    toolName: call.toolName,
    outcome: call.outcome,
    kind: call.kind,
    input: {
      completeness: call.input?.status ?? "unavailable",
      utf8Bytes: call.input?.utf8Bytes ?? null,
      sha256: call.input?.sha256 ?? null,
    },
    output: {
      completeness: call.output?.status ?? "unavailable",
      utf8Bytes: call.output?.utf8Bytes ?? null,
      sha256: call.output?.sha256 ?? null,
      absenceReason: call.output?.status === "unavailable" ? call.output.reason ?? null : null,
    },
    error: call.error ? {
      completeness: call.error.status,
      utf8Bytes: call.error.utf8Bytes,
      sha256: call.error.sha256,
    } : null,
  }));

  return {
    schemaVersion: EXP0036_NATIVE_TELEMETRY_SCHEMA_VERSION,
    attemptId: typeof expected.attemptId === "string" ? expected.attemptId : null,
    decision: failures.length === 0 ? "telemetry_complete" : "telemetry_non_evaluable",
    eligibleForValidRunClaim: failures.length === 0,
    reasons: failures,
    gates: {
      expectationValid,
      bindingValid,
      coverageValid,
      ledgerSealed,
      callsComplete,
      aggregateValid,
      attestationValid,
    },
    actualInvocationCount: calls.length,
    successCount: calls.filter((call) => call.outcome === "success").length,
    errorCount: calls.filter((call) => call.outcome === "error").length,
    returnedErrorCount: calls.filter((call) => [
      "returned_structured_error", "returned_mcp_error",
    ].includes(call.kind)).length,
    thrownOrRejectedCount: calls.filter((call) => THROWN_KINDS.has(call.kind)).length,
    totalReturnedOutputUtf8Bytes: calls.length > 0 ? totalReturnedOutputUtf8Bytes : null,
    totalThrownErrorUtf8Bytes: calls.length > 0 ? totalThrownErrorUtf8Bytes : null,
    readOutputUtf8Bytes: calls.length > 0 ? readOutputUtf8Bytes : null,
    perCall,
    ledgerSha256: Array.isArray(ledger.calls) ? hashExp0036PreflightValue(ledger) : null,
    observability: {
      returnedOutputBytes: "Exact UTF-8 bytes of JSON.stringify output captured inside each returned native tool executor.",
      thrownErrors: "A throw or rejection has no returned native output; its exact retained error projection is counted separately and the output absence is explicit.",
      completeness: "Requires a bounded recorder injected in the main world before every tool registration, an authenticated controller-only collector with a contiguous zero-drop event stream, a controller-issued terminal close, a sealed zero-pending epoch, no reload or truncation, independently hashed retrieval chunks of at most 32768 UTF-8 bytes, recomputed records and aggregates, and a trusted terminal attestation.",
      hostMetadata: "Host-session WebMCP metadata is corroborating evidence only because it does not advertise complete attempt coverage.",
    },
  };
}
