// @vitest-environment node

import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const modulePath: string = "./exp0036-admission-v2.mjs";
const {
  deriveExp0036ImmutableIsolationCalibrationV2,
  evaluateExp0036AttemptAdmissionV2,
  evaluateExp0036InfrastructurePreflightV2,
  signExp0036AdmissionV2Input,
} = await import(modulePath);
const builderPath: string = "./exp0036-admission-v2-builder.mjs";
const { runExp0036AdmissionV2Builder } = await import(builderPath);
const preflightPath: string = "./exp0036-attempt-preflight.mjs";
const { hashExp0036PreflightValue } = await import(preflightPath);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const publicKeySha256 = `sha256:${createHash("sha256")
  .update(keys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex")}`;
const authority = { keyId: "exp0036-v2-test", publicKeyPem, publicKeySha256 };

function digest(character: string) {
  return `sha256:${character.repeat(64)}`;
}

function signInput<T extends { expected: { authority: typeof authority }; evidence: unknown }>(
  input: T,
  kind: string,
) {
  return signExp0036AdmissionV2Input(input, {
    kind,
    signedAt: "2026-09-04T22:00:00.000Z",
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
}

function receipt(label: string, origin: string, participantId: string) {
  const ledger = {
    lifecycle: { state: "sealed" },
    captureComplete: true,
    valid: true,
    calls: [
      {
        sequence: 1,
        toolName: "list_recent_rooms",
        outcome: "success",
        output: {
          status: "complete",
          json: JSON.stringify({ ok: true, data: { rooms: [] } }),
          sha256: digest("4"),
        },
      },
      {
        sequence: 2,
        toolName: "read_room_state",
        outcome: "success",
        output: {
          status: "complete",
          json: JSON.stringify({ ok: true, data: { room: { selfParticipantId: participantId } } }),
          sha256: digest("5"),
        },
      },
    ],
  };
  const value = {
    ok: true,
    receipt: {
      schemaVersion: "jazzboard-exp0036-probe-collector/v1",
      attemptId: label,
      binding: {
        appOrigin: origin,
        observerSourceSha256: digest("6"),
        observerConfigSha256: digest("7"),
      },
      seal: { complete: true, ledgerSealed: true },
      transport: { zeroDrops: true, rejectedEventCount: 0, externalRejectedRequestCount: 0 },
      retrieval: { complete: true, truncated: false, chunks: [{ jsonFragment: JSON.stringify(ledger) }] },
    },
  };
  Object.assign(value.receipt, { receiptSha256: hashExp0036PreflightValue(value.receipt) });
  return value;
}

function calibration() {
  return deriveExp0036ImmutableIsolationCalibrationV2({
    calibrationId: "immutable-calibration-01",
    verifiedAt: "2026-08-01T00:00:00.000Z",
    sourceAttestation: {
      method: "frozen_source_review",
      finding: "guest_cookie_host_only_http_only",
      commits: ["a".repeat(40), "b".repeat(40)],
      sourcePath: "src/lib/server/session.ts",
      sourceSha256: digest("a"),
      reviewedAt: "2026-08-01T00:00:00.000Z",
    },
    probeA: {
      receipt: receipt("probe-a", "http://exp0036-calibration-a.localhost:3103", "participant-a"),
      receiptFileSha256: digest("1"),
    },
    probeB: {
      receipt: receipt("probe-b", "http://exp0036-calibration-b.localhost:3103", "participant-b"),
      receiptFileSha256: digest("2"),
    },
  });
}

function frozenBuild(origin: string) {
  return {
    arm: "A1",
    commit: "a".repeat(40),
    archiveSha256: digest("1"),
    dependencyTreeSha256: digest("2"),
    launchReceiptSha256: digest("3"),
    origin,
  };
}

function telemetry() {
  return {
    status: "armed",
    captureMode: "passive_model_context_register_tool",
    collectionMode: "authenticated_loopback_collector",
    controllerOnly: true,
    authorQueryable: false,
    maxCaptureBytes: 4_000_000,
    maxInvocations: 1_000,
    observerSourceSha256: digest("6"),
    observerConfigSha256: digest("7"),
    calibrationReceiptSha256: digest("8"),
  };
}

function infrastructureInput() {
  const origin = "http://exp0036-attempt-01.localhost:3103";
  const immutable = calibration();
  const expected = {
    protocolId: "EXP-0036",
    phase: "infrastructure_precreation_v2",
    attemptId: "attempt-01",
    origin,
    isolationCalibrationPayloadSha256: immutable.payloadSha256,
    frozenBuild: frozenBuild(origin),
    authority,
    prior: { origins: ["http://exp0036-prior.localhost:3103"] },
  };
  return {
    expected,
    evidence: {
      phase: "infrastructure_precreation_v2",
      observedAt: "2026-09-04T22:00:00.000Z",
      taskCreationStatus: "not_started",
      originReservation: {
        method: "controller_nonce_and_attempt_ledger",
        origin,
        hostname: "exp0036-attempt-01.localhost",
        browserFirstUse: true,
        browserNavigationCount: 0,
        collisionCheckComplete: true,
      },
      immutableIsolationCalibration: immutable,
      hostAvailability: {
        method: "supported_cua_native_host_availability",
        status: "unlocked",
        probeStatus: "completed",
        browserId: "iab",
        nativeToolCount: 5,
        requestedAt: "2026-09-04T21:59:59.000Z",
        respondedAt: "2026-09-04T22:00:00.000Z",
      },
      frozenBuild: frozenBuild(origin),
      liveBuildProcess: {
        method: "controller_pid_cwd_and_http_probe",
        pid: 1234,
        origin,
        commit: "a".repeat(40),
        archiveSha256: digest("1"),
        httpStatus: 200,
        requestedAt: "2026-09-04T21:59:59.000Z",
        respondedAt: "2026-09-04T22:00:00.000Z",
      },
      telemetryReadiness: telemetry(),
    },
  };
}

function nativeProof(toolName: string) {
  return {
    method: "normal_cua_native_webmcp",
    origin: "http://exp0036-attempt-01.localhost:3103",
    sourceHostname: "exp0036-attempt-01.localhost",
    browserSessionId: "browser-01",
    toolName,
    invocationSequence: toolName === "list_recent_rooms" ? 1 : toolName === "join_room" ? 2 : 3,
    outcome: "success",
    outputComplete: true,
    inputSha256: digest("a"),
    outputSha256: digest("b"),
    requestedAt: "2026-09-04T21:59:59.000Z",
    respondedAt: "2026-09-04T22:00:00.000Z",
  };
}

function admissionInput() {
  const origin = "http://exp0036-attempt-01.localhost:3103";
  const identitySha256 = digest("c");
  const expected = {
    protocolId: "EXP-0036",
    phase: "post_creation_admission_v2",
    attemptId: "attempt-01",
    taskId: "task-01",
    browserSessionId: "browser-01",
    origin,
    infrastructurePreflightPayloadSha256: digest("d"),
    isolationCalibrationPayloadSha256: calibration().payloadSha256,
    roomIdentitySha256: digest("e"),
    frozenBuild: frozenBuild(origin),
    authority,
    prior: { taskIds: [], browserSessionIds: [], sessionIdentitySha256s: [] },
  };
  return {
    expected,
    evidence: {
      phase: "post_creation_admission_v2",
      infrastructurePreflightPayloadSha256: digest("d"),
      observedAt: "2026-09-04T22:00:00.000Z",
      task: {
        taskId: "task-01",
        browserSessionId: "browser-01",
        target: "projectless",
        history: "fresh",
        priorCompletedTurnCount: 0,
        startedAt: "2026-09-04T21:50:00.000Z",
      },
      isolation: {
        method: "unique_localhost_origin_from_immutable_calibration",
        origin,
        sourceHostname: "exp0036-attempt-01.localhost",
        originFirstUse: true,
        loadedThroughCua: true,
        calibrationPayloadSha256: calibration().payloadSha256,
      },
      preJoinNativeProof: {
        ...nativeProof("list_recent_rooms"),
        roomReferences: [],
        requestedAt: "2026-09-04T21:50:01.000Z",
        respondedAt: "2026-09-04T21:50:02.000Z",
      },
      joinNativeProof: {
        ...nativeProof("join_room"),
        participantIdentitySha256: identitySha256,
        requestedAt: "2026-09-04T21:50:03.000Z",
        respondedAt: "2026-09-04T21:50:04.000Z",
      },
      firstNaturalRoomToolProof: {
        ...nativeProof("query_objects"),
        promptDirected: false,
        requiredToolName: null,
      },
      participantDeltaProof: {
        method: "controller_room_snapshot_before_after_join",
        roomIdentitySha256: digest("e"),
        beforeSnapshotSha256: digest("1"),
        afterSnapshotSha256: digest("2"),
        addedParticipantCount: 1,
        addedParticipantIdentitySha256: identitySha256,
        requestedAt: "2026-09-04T21:50:04.000Z",
        respondedAt: "2026-09-04T22:00:00.000Z",
      },
      hostAvailability: {
        method: "supported_cua_native_host_availability",
        status: "unlocked",
        probeStatus: "completed",
        origin,
        browserSessionId: "browser-01",
        nativeToolCount: 5,
        requestedAt: "2026-09-04T21:59:59.000Z",
        respondedAt: "2026-09-04T22:00:00.000Z",
      },
      frozenBuild: frozenBuild(origin),
      telemetryReadiness: telemetry(),
    },
  };
}

describe("EXP0036 admission v2", () => {
  it("derives immutable isolation evidence from complete distinct native receipts", () => {
    const value = calibration();
    expect(value).toMatchObject({
      status: "passed",
      immutable: true,
      method: "sealed_native_unique_localhost_origin_pair_plus_frozen_source_review",
    });
    expect(value.payloadSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(value.probes[0].preJoinNativeRead.roomReferences).toEqual([]);
    expect(value.probes[0].participantIdentitySha256).not.toBe(value.probes[1].participantIdentitySha256);
    expect(JSON.stringify(value)).not.toContain("participant-a");
  });

  it("accepts signed fresh infrastructure with immutable older calibration", () => {
    const result = evaluateExp0036InfrastructurePreflightV2(signInput(
      infrastructureInput(), "infrastructure_preflight_v2_attestation",
    ), { now: "2026-09-04T22:00:20.000Z", maxAgeMs: 60_000 });
    expect(result).toMatchObject({
      decision: "task_creation_ready",
      reasons: [],
      gates: { immutableIsolationCalibrated: true, noFabricatedCookieEvidence: true },
    });
  });

  it("admits a fresh join, independent participant delta, and naturally chosen room tool", () => {
    const result = evaluateExp0036AttemptAdmissionV2(signInput(
      admissionInput(), "attempt_admission_v2_attestation",
    ), { now: "2026-09-04T22:00:20.000Z", maxAgeMs: 60_000 });
    expect(result).toMatchObject({
      decision: "post_creation_evidence_complete",
      reasons: [],
      gates: {
        preJoinEmpty: true,
        joinFresh: true,
        naturalRoomToolFresh: true,
        participantDeltaBound: true,
        hostFresh: true,
      },
    });
  });

  it("rejects invented cookie-probe fields and a prescribed full-room read", () => {
    const input = admissionInput();
    Object.assign(input.evidence, { cookieProbe: { postJoinCookieCount: 1 } });
    input.evidence.firstNaturalRoomToolProof.toolName = "read_room_state";
    Object.assign(input.evidence.firstNaturalRoomToolProof, {
      requiredToolName: "read_room_state",
    });
    const result = evaluateExp0036AttemptAdmissionV2(signInput(
      input, "attempt_admission_v2_attestation",
    ), { now: "2026-09-04T22:00:20.000Z" });
    expect(result.reasons).toEqual(expect.arrayContaining([
      "COOKIE_OBSERVATION_FIELDS_FORBIDDEN_V2",
      "FIRST_NATURAL_ROOM_TOOL_MISSING_V2",
    ]));
  });

  it("signs and fail-closed evaluates collected infrastructure evidence through the CLI builder", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "exp0036-v2-builder-"));
    temporaryDirectories.push(directory);
    const inputPath = path.join(directory, "input.json");
    const keyPath = path.join(directory, "authority.pem");
    const outputPath = path.join(directory, "signed.json");
    await writeFile(inputPath, JSON.stringify(infrastructureInput()));
    await writeFile(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
    const result = await runExp0036AdmissionV2Builder([
      "sign-infrastructure",
      "--input", inputPath,
      "--private-key", keyPath,
      "--output", outputPath,
      "--signed-at", "2026-09-04T22:00:00.000Z",
      "--now", "2026-09-04T22:00:20.000Z",
    ]);
    expect(result.decision).toBe("task_creation_ready");
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    expect(output).toMatchObject({
      decision: { decision: "task_creation_ready", reasons: [] },
      signed: { attestation: { content: { kind: "infrastructure_preflight_v2_attestation" } } },
    });
  });
});
