#!/usr/bin/env node

import { createHash, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  evaluateExp0036AttemptAdmissionV2,
  hashExp0036ParticipantIdentityV2,
  signExp0036AdmissionV2Input,
} from "./exp0036-admission-v2.mjs";
import {
  EXP0036_NATIVE_TELEMETRY_SCHEMA_VERSION,
  exp0036NativeTelemetrySignatureMessage,
  verifyExp0036NativeTelemetry,
} from "./exp0036-native-telemetry.mjs";
import { hashExp0036PreflightValue } from "./exp0036-attempt-preflight.mjs";

const LANDING_TOOLS = new Set([
  "create_room", "join_room", "list_recent_rooms", "open_recent_room", "remove_recent_room",
]);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || rest[index + 1] === undefined) {
      throw new Error(`Invalid EXP0036 run-evidence argument ${rest[index] ?? ""}.`);
    }
    values[rest[index].slice(2)] = rest[index + 1];
  }
  return { command, values };
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function readArtifact(filePath) {
  const absolutePath = path.resolve(filePath);
  const bytes = await readFile(absolutePath);
  return { path: absolutePath, bytes, sha256: sha256Bytes(bytes), value: JSON.parse(bytes.toString("utf8")) };
}

async function readBytesArtifact(filePath) {
  const absolutePath = path.resolve(filePath);
  const bytes = await readFile(absolutePath);
  return { path: absolutePath, bytes, sha256: sha256Bytes(bytes) };
}

function receiptFrom(value) {
  return value?.body?.receipt ?? value?.receipt ?? value;
}

function ledgerFromReceipt(receipt) {
  if (!Array.isArray(receipt?.retrieval?.chunks)) throw new Error("Collector receipt has no ledger chunks.");
  return JSON.parse(receipt.retrieval.chunks.map((chunk) => chunk.jsonFragment).join(""));
}

function iso(epochMs) {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) throw new Error("Native call timestamp is missing.");
  return new Date(epochMs).toISOString();
}

function parseCapture(capture, label) {
  if (capture?.status !== "complete" || typeof capture.json !== "string") {
    throw new Error(`${label} is not an exact complete capture.`);
  }
  return JSON.parse(capture.json);
}

function nativeProof(call, task, assignment) {
  return {
    method: "normal_cua_native_webmcp",
    origin: assignment.origin,
    sourceHostname: new URL(assignment.origin).hostname,
    browserSessionId: task.browserSessionId,
    toolName: call.toolName,
    invocationSequence: call.sequence,
    outcome: call.outcome,
    outputComplete: call.output?.status === "complete",
    inputSha256: call.input?.sha256,
    outputSha256: call.output?.sha256,
    requestedAt: iso(call.begun?.epochMs),
    respondedAt: iso(call.completed?.epochMs),
  };
}

function participants(room) {
  const values = Array.isArray(room?.participants)
    ? room.participants : Object.values(room?.participants ?? {});
  return new Map(values.map((participant) => [participant.participantId, participant]));
}

function sortedParticipantProjection(room) {
  return [...participants(room).values()].map((participant) => ({
    participantId: participant.participantId,
    displayName: participant.displayName,
    role: participant.role,
    joinedAt: participant.joinedAt ?? null,
  })).sort((left, right) => left.participantId.localeCompare(right.participantId));
}

function sourceDigestMap(artifacts) {
  return Object.fromEntries(Object.entries(artifacts).filter(([, artifact]) => artifact).map(([key, artifact]) => [key, {
    path: artifact.path,
    sha256: artifact.sha256,
  }]));
}

async function writeNew(filePath, value) {
  await writeFile(path.resolve(filePath), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8", mode: 0o600, flag: "wx",
  });
}

function assignmentFor(run, attemptId) {
  const assignment = run.assignments?.find((candidate) => candidate.attemptId === attemptId);
  if (!assignment) throw new Error(`Run ledger has no assignment ${attemptId}.`);
  return assignment;
}

export async function assembleExp0036AdmissionEvidence(config) {
  const artifacts = {
    run: await readArtifact(config.runPath),
    launch: await readArtifact(config.launchPath),
    infrastructure: await readArtifact(config.infrastructurePath),
    task: await readArtifact(config.taskReceiptPath),
    host: config.hostAvailabilityPath ? await readArtifact(config.hostAvailabilityPath) : null,
    collector: await readArtifact(config.collectorReceiptPath),
    controller: await readArtifact(config.controllerPrivatePath),
    afterRoom: await readArtifact(config.afterRoomPath),
    snapshot: await readArtifact(config.snapshotReceiptPath),
    authority: await readArtifact(config.authorityPath),
  };
  const assignment = assignmentFor(artifacts.run.value, config.attemptId);
  const infrastructure = artifacts.infrastructure.value;
  const task = artifacts.task.value;
  const receipt = receiptFrom(artifacts.collector.value);
  const ledger = ledgerFromReceipt(receipt);
  const calls = ledger.calls ?? [];
  const preJoin = calls.find((call) => call.toolName === "list_recent_rooms");
  const join = calls.find((call) => call.toolName === "join_room" && call.sequence > preJoin?.sequence);
  const firstRoomTool = calls.find((call) => call.sequence > join?.sequence && !LANDING_TOOLS.has(call.toolName));
  if (!preJoin || !join || !firstRoomTool || preJoin.sequence !== 1 || join.outcome !== "success"
      || firstRoomTool.outcome !== "success") {
    throw new Error("Native ledger lacks the ordered prejoin, join, and first successful room-tool proof.");
  }
  const recentOutput = parseCapture(preJoin.output, "list_recent_rooms output");
  const joinOutput = parseCapture(join.output, "join_room output");
  const provisionedRoomId = assignment.roomId ?? artifacts.controller.value.beforeRoom?.id;
  if (recentOutput?.ok !== true || !Array.isArray(recentOutput?.data?.rooms)
      || recentOutput.data.rooms.length !== 0 || joinOutput?.ok !== true
      || joinOutput?.data?.room?.id !== provisionedRoomId) {
    throw new Error("Native prejoin or exact-room join output is incompatible with admission.");
  }
  const beforeRoom = artifacts.controller.value.beforeRoom;
  const afterRoom = artifacts.afterRoom.value;
  const roomId = provisionedRoomId;
  const beforeParticipants = participants(beforeRoom);
  const afterParticipants = participants(afterRoom);
  const added = [...afterParticipants.values()].filter((participant) => !beforeParticipants.has(participant.participantId));
  if (beforeRoom.id !== roomId || afterRoom.id !== roomId || added.length !== 1
      || added[0].displayName !== "Board author" || added[0].role !== "participant") {
    throw new Error("Controller snapshots do not contain exactly one expected author participant delta.");
  }
  const participantIdentitySha256 = hashExp0036ParticipantIdentityV2(added[0].participantId);
  const beforeProjection = sortedParticipantProjection(beforeRoom);
  const afterProjection = sortedParticipantProjection(afterRoom);
  const taskStartedAt = task.startedAt;
  const snapshotReceipt = artifacts.snapshot.value;
  const host = artifacts.host?.value ?? {
    method: "supported_cua_native_host_availability",
    status: "unlocked",
    probeStatus: "completed",
    nativeToolCount: ledger.aggregates?.registrations,
    requestedAt: iso(preJoin.begun?.epochMs),
    respondedAt: iso(firstRoomTool.completed?.epochMs),
    evidenceSource: "normal_cua_native_webmcp_invocations",
  };
  const observedAt = new Date(Math.max(
    Date.parse(host.respondedAt), Date.parse(snapshotReceipt.respondedAt),
  )).toISOString();
  const infrastructurePayloadSha256 = infrastructure.decision?.payloadSha256;
  const frozenBuild = infrastructure.signed?.expected?.frozenBuild;
  const telemetryReadiness = infrastructure.signed?.evidence?.telemetryReadiness;
  const calibrationPayloadSha256 = infrastructure.signed?.expected?.isolationCalibrationPayloadSha256;
  const roomIdentitySha256 = hashExp0036PreflightValue({ roomId });
  const expected = {
    protocolId: "EXP-0036",
    phase: "post_creation_admission_v2",
    attemptId: assignment.attemptId,
    taskId: task.taskId,
    browserSessionId: task.browserSessionId,
    origin: assignment.origin,
    infrastructurePreflightPayloadSha256: infrastructurePayloadSha256,
    isolationCalibrationPayloadSha256: calibrationPayloadSha256,
    roomIdentitySha256,
    frozenBuild,
    authority: artifacts.authority.value,
    prior: {
      taskIds: task.priorTaskIds ?? [],
      browserSessionIds: task.priorBrowserSessionIds ?? [],
      sessionIdentitySha256s: task.priorSessionIdentitySha256s ?? [],
    },
  };
  const proof = nativeProof(firstRoomTool, task, assignment);
  const evidence = {
    phase: "post_creation_admission_v2",
    infrastructurePreflightPayloadSha256: infrastructurePayloadSha256,
    observedAt,
    task: {
      taskId: task.taskId,
      browserSessionId: task.browserSessionId,
      target: task.target,
      history: task.history,
      priorCompletedTurnCount: task.priorCompletedTurnCount,
      startedAt: taskStartedAt,
    },
    isolation: {
      method: "unique_localhost_origin_from_immutable_calibration",
      origin: assignment.origin,
      sourceHostname: new URL(assignment.origin).hostname,
      originFirstUse: task.originFirstUse,
      loadedThroughCua: task.loadedThroughCua,
      calibrationPayloadSha256,
    },
    preJoinNativeProof: {
      ...nativeProof(preJoin, task, assignment),
      roomReferences: [],
    },
    joinNativeProof: {
      ...nativeProof(join, task, assignment),
      participantIdentitySha256,
      identityBindingMethod: "controller_delta_bracketing_native_join",
      outputContainsParticipantIdentity: false,
    },
    firstNaturalRoomToolProof: {
      ...proof,
      firstRoomScopedInvocationAfterJoin: true,
      promptDirected: false,
      requiredToolName: null,
    },
    participantDeltaProof: {
      method: "controller_room_snapshot_before_after_join",
      roomIdentitySha256,
      beforeSnapshotSha256: hashExp0036PreflightValue(beforeProjection),
      afterSnapshotSha256: hashExp0036PreflightValue(afterProjection),
      addedParticipantCount: 1,
      addedParticipantIdentitySha256: participantIdentitySha256,
      requestedAt: snapshotReceipt.requestedAt,
      respondedAt: snapshotReceipt.respondedAt,
    },
    hostAvailability: {
      method: host.method,
      status: host.status,
      probeStatus: host.probeStatus,
      origin: assignment.origin,
      browserSessionId: task.browserSessionId,
      nativeToolCount: host.nativeToolCount,
      requestedAt: host.requestedAt,
      respondedAt: host.respondedAt,
    },
    frozenBuild,
    telemetryReadiness,
  };
  const unsigned = { expected, evidence };
  const privateKeyPem = await readFile(config.privateKeyPath, "utf8");
  const signed = signExp0036AdmissionV2Input(unsigned, {
    kind: "attempt_admission_v2_attestation",
    signedAt: observedAt,
    privateKeyPem,
  });
  const decision = evaluateExp0036AttemptAdmissionV2(signed, {
    now: observedAt,
    maxAgeMs: config.maxAgeMs ?? 60_000,
    taskWindowMs: config.taskWindowMs ?? 15 * 60_000,
  });
  if (decision.decision !== "post_creation_evidence_complete") {
    throw new Error(`Admission evidence blocked: ${decision.reasons.join(", ")}`);
  }
  return { signed, decision, sourceArtifacts: sourceDigestMap(artifacts) };
}

export async function assembleExp0036TerminalEvidence(config) {
  const artifacts = {
    admission: await readArtifact(config.admissionPath),
    collector: await readArtifact(config.collectorReceiptPath),
    launch: await readArtifact(config.launchPath),
    authority: await readArtifact(config.authorityPath),
  };
  const admission = artifacts.admission.value;
  const receipt = receiptFrom(artifacts.collector.value);
  const ledger = ledgerFromReceipt(receipt);
  const contract = admission.signed.expected;
  const telemetry = admission.signed.evidence.telemetryReadiness;
  const expected = {
    attemptId: contract.attemptId,
    taskId: contract.taskId,
    browserSessionId: contract.browserSessionId,
    sessionEpoch: artifacts.launch.value.sessionEpoch,
    origin: contract.origin,
    originHostname: new URL(contract.origin).hostname,
    admissionPreflightPayloadSha256: admission.decision.payloadSha256,
    observerSourceSha256: artifacts.launch.value.observerSourceSha256,
    observerConfigSha256: artifacts.launch.value.observerConfigSha256,
    calibrationReceiptSha256: telemetry.calibrationReceiptSha256,
    taskTerminalReference: receipt.close?.terminalReference,
    expectedRegisteredToolCount: ledger.aggregates?.registrations,
    maxCaptureBytes: ledger.capturePolicy?.maxCaptureBytes,
    maxInvocations: ledger.capturePolicy?.maxInvocations,
    authority: artifacts.authority.value,
  };
  const evidence = {
    schemaVersion: EXP0036_NATIVE_TELEMETRY_SCHEMA_VERSION,
    binding: {
      attemptId: expected.attemptId,
      taskId: expected.taskId,
      browserSessionId: expected.browserSessionId,
      sessionEpoch: expected.sessionEpoch,
      origin: expected.origin,
      originHostname: expected.originHostname,
      admissionPreflightPayloadSha256: expected.admissionPreflightPayloadSha256,
      observerSourceSha256: expected.observerSourceSha256,
      observerConfigSha256: expected.observerConfigSha256,
      calibrationReceiptSha256: expected.calibrationReceiptSha256,
    },
    coverage: {
      captureMode: "passive_model_context_register_tool",
      injectionMode: "main_world_before_app_module",
      collectionMode: "authenticated_loopback_collector",
      controllerOnly: true,
      authorQueryable: false,
      authorEndpointExposed: false,
      installedBeforeAnyToolRegistration: receipt.transport?.events?.[0]?.eventType === "ledger_begin",
      registrationSetComplete: receipt.transport?.events?.filter((event) => event.eventType === "tool_registered").length
        === ledger.aggregates?.registrations,
      noUnobservedModelContext: artifacts.launch.value.registrationAdapterRelativePaths?.length === 3,
      noReloadAfterArming: receipt.transport?.zeroDrops === true
        && receipt.transport?.events?.filter((event) => event.eventType === "ledger_begin").length === 1,
      expectedRegisteredToolCount: expected.expectedRegisteredToolCount,
      observedRegisteredToolCount: ledger.aggregates?.registrations,
      retrieval: receipt.retrieval,
      collectorReceipt: receipt,
    },
    ledger,
  };
  const content = {
    schemaVersion: EXP0036_NATIVE_TELEMETRY_SCHEMA_VERSION,
    protocolId: "EXP-0036",
    kind: "terminal_native_telemetry_attestation",
    keyId: expected.authority.keyId,
    publicKeySha256: expected.authority.publicKeySha256,
    payloadSha256: hashExp0036PreflightValue({
      schemaVersion: evidence.schemaVersion,
      binding: evidence.binding,
      coverage: evidence.coverage,
      ledger: evidence.ledger,
    }),
    signedAt: new Date().toISOString(),
  };
  const privateKeyPem = await readFile(config.privateKeyPath, "utf8");
  evidence.attestation = {
    content,
    signatureBase64: sign(null, exp0036NativeTelemetrySignatureMessage(content), privateKeyPem).toString("base64"),
  };
  const verification = verifyExp0036NativeTelemetry(evidence, expected);
  if (verification.decision !== "telemetry_complete") {
    throw new Error(`Terminal telemetry blocked: ${verification.reasons.join(", ")}`);
  }
  return { expected, evidence, verification, sourceArtifacts: sourceDigestMap(artifacts) };
}

export async function assembleExp0036IncompleteEvidence(config) {
  const artifacts = {
    session: await readBytesArtifact(config.sessionLogPath),
    collector: await readArtifact(config.collectorReceiptPath),
    launch: await readArtifact(config.launchPath),
  };
  const sessionRecords = artifacts.session.bytes.toString("utf8").split("\n")
    .filter(Boolean).map((line) => JSON.parse(line));
  const session = sessionRecords.find((record) => record.type === "session_meta")?.payload;
  const terminal = [...sessionRecords].reverse().find((record) => record.type === "event_msg"
    && record.payload?.type === "task_complete");
  const receipt = receiptFrom(artifacts.collector.value);
  const ledger = ledgerFromReceipt(receipt);
  const eventTypes = receipt.transport?.events?.map((event) => event.eventType ?? event.event?.type) ?? [];
  const reasons = [];
  if (receipt.seal?.complete !== true) reasons.push("COLLECTOR_RECEIPT_NOT_SEALED");
  if (receipt.seal?.ledgerSealed !== true || ledger.lifecycle?.state !== "sealed") {
    reasons.push("NATIVE_LEDGER_NOT_SEALED");
  }
  if (ledger.captureComplete !== true || ledger.valid !== true) reasons.push("NATIVE_CAPTURE_NOT_COMPLETE");
  if (!eventTypes.includes("ledger_end")) reasons.push("LEDGER_END_EVENT_ABSENT");
  if (!terminal) reasons.push("TASK_TERMINAL_EVENT_ABSENT");
  if (reasons.length === 0) throw new Error("Incomplete-evidence command cannot classify a complete receipt.");
  const evidence = {
    schemaVersion: "jazzboard-exp0036-incomplete-evidence/v1",
    protocolId: "EXP-0036",
    attemptId: artifacts.launch.value.attemptId,
    taskId: session?.session_id ?? null,
    decision: "telemetry_non_evaluable",
    eligibleForValidRunClaim: false,
    reasons,
    taskTerminal: terminal ? {
      turnId: terminal.payload.turn_id,
      recordedAt: terminal.timestamp,
      durationMs: terminal.payload.duration_ms,
    } : null,
    collector: {
      close: receipt.close,
      seal: receipt.seal,
      acceptedEventCount: receipt.transport?.acceptedEventCount,
      rejectedEventCount: receipt.transport?.rejectedEventCount,
      gapCount: receipt.transport?.gapCount,
      zeroDrops: receipt.transport?.zeroDrops,
      ledgerEndEventPresent: eventTypes.includes("ledger_end"),
    },
    ledger: {
      sessionEpoch: ledger.sessionEpoch,
      lifecycle: ledger.lifecycle,
      captureComplete: ledger.captureComplete,
      valid: ledger.valid,
      pendingCount: ledger.pendingCount,
      invalidationReasons: ledger.invalidationReasons,
      invocationCount: ledger.calls?.length,
      startedCount: ledger.aggregates?.started,
      completedCount: ledger.aggregates?.completed,
      sha256: hashExp0036PreflightValue(ledger),
    },
    interpretation: {
      completedInvocationRecordsRetainedForDiagnostics: Array.isArray(ledger.calls)
        && ledger.calls.length > 0 && ledger.calls.length === ledger.aggregates?.completed,
      invocationBytesEligibleForComparativeClaim: false,
      limitation: "Completed call records remain descriptive only because terminal ledger completeness was not established.",
    },
    sourceArtifacts: sourceDigestMap(artifacts),
  };
  return { ...evidence, payloadSha256: hashExp0036PreflightValue(evidence) };
}

export async function runExp0036RunEvidenceCli(argv) {
  const { command, values } = parseArgs(argv);
  if (!["admission", "terminal", "incomplete"].includes(command) || !values.config || !values.output) {
    throw new Error("Usage: exp0036-run-evidence.mjs admission|terminal|incomplete --config /abs/config.json --output /abs/output.json");
  }
  const config = JSON.parse(await readFile(path.resolve(values.config), "utf8"));
  const result = command === "admission"
    ? await assembleExp0036AdmissionEvidence(config)
    : command === "terminal"
      ? await assembleExp0036TerminalEvidence(config)
      : await assembleExp0036IncompleteEvidence(config);
  await writeNew(values.output, result);
  return { command, output: path.resolve(values.output), decision: command === "admission"
    ? result.decision.decision : command === "terminal" ? result.verification.decision : result.decision };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runExp0036RunEvidenceCli(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
