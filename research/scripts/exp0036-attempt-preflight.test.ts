// @vitest-environment node

import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";

import { describe, expect, it } from "vitest";

const modulePath: string = "./exp0036-attempt-preflight.mjs";
const {
  EXP0036_ATTEMPT_PREFLIGHT_SCHEMA_VERSION,
  buildExp0036CuaPreflightProgram,
  createExp0036AttemptOrigin,
  evaluateExp0036AttemptPreflight,
  evaluateExp0036InfrastructurePreflight,
  exp0036AttemptPreflightSignatureMessage,
  hashExp0036PreflightValue,
} = await import(modulePath);

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const publicKeySha256 = `sha256:${createHash("sha256")
  .update(keys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex")}`;

function digest(character: string) {
  return `sha256:${character.repeat(64)}`;
}

function unsignedInput() {
  const origin = "http://exp0036-a01-91bd1f.localhost:3103";
  return {
    expected: {
      protocolId: "EXP-0036",
      phase: "post_creation_admission",
      attemptId: "attempt01",
      taskId: "task_fresh_01",
      browserSessionId: "browser_fresh_01",
      infrastructurePreflightPayloadSha256: digest("b"),
      origin,
      frozenBuild: {
        arm: "A1",
        commit: "a".repeat(40),
        archiveSha256: digest("1"),
        dependencyTreeSha256: digest("2"),
        launchReceiptSha256: digest("3"),
        origin,
      },
      authority: {
        keyId: "exp0036-test-authority",
        publicKeyPem,
        publicKeySha256,
      },
      prior: {
        taskIds: ["task_prior"],
        browserSessionIds: ["browser_prior"],
        sessionIdentitySha256s: [digest("4")],
        origins: ["http://exp0036-prior.localhost:3103"],
      },
    },
    evidence: {
      phase: "post_creation_admission",
      infrastructurePreflightPayloadSha256: digest("b"),
      observedAt: "2026-09-04T22:00:00.000Z",
      task: {
        taskId: "task_fresh_01",
        browserSessionId: "browser_fresh_01",
        target: "projectless",
        history: "fresh",
        priorCompletedTurnCount: 0,
      },
      isolation: {
        method: "unique_localhost_origin",
        origin,
        originFirstUse: true,
        loadedThroughCua: true,
        sourceHostname: "exp0036-a01-91bd1f.localhost",
        preJoinRecentRooms: {
          toolName: "list_recent_rooms",
          outcome: "success",
          outputComplete: true,
          sourceHostname: "exp0036-a01-91bd1f.localhost",
          roomReferences: [] as Array<{ roomId: string }>,
        },
      },
      signedSession: {
        method: "normal_webmcp_join_and_authorized_read",
        origin,
        taskId: "task_fresh_01",
        browserSessionId: "browser_fresh_01",
        joinOutcome: "success",
        authorizedReadOutcome: "success",
        joinToolOrigin: "exp0036-a01-91bd1f.localhost",
        readToolOrigin: "exp0036-a01-91bd1f.localhost",
        authorizedReadProbe: {
          requestedAt: "2026-09-04T21:59:59.000Z",
          respondedAt: "2026-09-04T22:00:00.000Z",
        },
        identitySha256: digest("5"),
        cookieProbe: {
          method: "supported_cua_cdp_network_get_cookies",
          status: "complete",
          truncated: false,
          cookieName: "jazzboard_guest",
          cookieCount: 1,
          domain: "exp0036-a01-91bd1f.localhost",
          httpOnly: true,
          requestedAt: "2026-09-04T21:59:59.000Z",
          respondedAt: "2026-09-04T22:00:00.000Z",
        },
      },
      hostUnlock: {
        status: "unlocked",
        probeStatus: "completed",
        origin,
        browserSessionId: "browser_fresh_01",
        observedAt: "2026-09-04T22:00:00.000Z",
      },
      frozenBuild: {
        arm: "A1",
        commit: "a".repeat(40),
        archiveSha256: digest("1"),
        dependencyTreeSha256: digest("2"),
        launchReceiptSha256: digest("3"),
        origin,
      },
      liveBuildProcess: {
        method: "controller_pid_cwd_and_http_probe",
        pid: 12345,
        origin,
        commit: "a".repeat(40),
        archiveSha256: digest("1"),
        launchReceiptSha256: digest("3"),
        httpStatus: 200,
        observedAt: "2026-09-04T22:00:00.000Z",
      },
      telemetryReadiness: {
        status: "armed",
        captureMode: "passive_model_context_register_tool",
        injectionMode: "main_world_before_app_module",
        collectionMode: "authenticated_loopback_collector",
        controllerOnly: true,
        authorQueryable: false,
        authorEndpointExposed: false,
        reloadInvalidatesEpoch: true,
        maxCaptureBytes: 4_000_000,
        maxInvocations: 1_000,
        expectedRegisteredToolCount: 42,
        observerSourceSha256: digest("6"),
        observerConfigSha256: digest("a"),
        calibrationReceiptSha256: digest("7"),
      },
    },
  };
}

function signedInput() {
  const input = unsignedInput();
  return signAttemptInput(input);
}

function signAttemptInput<T extends {
  expected: { authority: { keyId: string } };
  evidence: unknown;
}>(input: T): T & {
  attestation: { content: Record<string, unknown>; signatureBase64: string };
} {
  const content = {
    schemaVersion: EXP0036_ATTEMPT_PREFLIGHT_SCHEMA_VERSION,
    protocolId: "EXP-0036",
    kind: "attempt_preflight_attestation",
    keyId: input.expected.authority.keyId,
    publicKeySha256,
    payloadSha256: hashExp0036PreflightValue({
      expected: input.expected,
      evidence: input.evidence,
    }),
    signedAt: "2026-09-04T22:00:00.000Z",
  };
  return {
    ...input,
    attestation: {
      content,
      signatureBase64: sign(
        null,
        exp0036AttemptPreflightSignatureMessage(content),
        keys.privateKey,
      ).toString("base64"),
    },
  };
}

function unsignedInfrastructureInput() {
  const origin = "http://exp0036-a02-cafe01.localhost:3103";
  const probe = (label: string, identityCharacter: string) => ({
    origin: `http://exp0036-calibration-${label}.localhost:3103`,
    loadedThroughCua: true,
    sourceHostname: `exp0036-calibration-${label}.localhost`,
    preJoinCookieCount: 0,
    preJoinRecentRoomsOutcome: "success",
    preJoinRecentRoomsComplete: true,
    preJoinRoomReferences: [] as Array<{ roomId: string }>,
    postJoinCookieName: "jazzboard_guest",
    postJoinCookieCount: 1,
    postJoinCookieDomain: `exp0036-calibration-${label}.localhost`,
    postJoinCookieHttpOnly: true,
    sessionIdentitySha256: digest(identityCharacter),
    requestedAt: "2026-09-04T21:59:55.000Z",
    respondedAt: "2026-09-04T22:00:00.000Z",
  });
  return {
    expected: {
      protocolId: "EXP-0036",
      phase: "infrastructure_precreation",
      attemptId: "attempt02",
      origin,
      frozenBuild: {
        arm: "A1",
        commit: "a".repeat(40),
        archiveSha256: digest("1"),
        dependencyTreeSha256: digest("2"),
        launchReceiptSha256: digest("3"),
        origin,
      },
      authority: {
        keyId: "exp0036-test-authority",
        publicKeyPem,
        publicKeySha256,
      },
      prior: {
        origins: ["http://exp0036-prior.localhost:3103"],
      },
    },
    evidence: {
      phase: "infrastructure_precreation",
      observedAt: "2026-09-04T22:00:00.000Z",
      taskCreationStatus: "not_started",
      originReservation: {
        method: "controller_nonce_and_attempt_ledger",
        origin,
        hostname: "exp0036-a02-cafe01.localhost",
        browserFirstUse: true,
        browserNavigationCount: 0,
        collisionCheckComplete: true,
      },
      wildcardIsolationCalibration: {
        method: "supported_cua_unique_localhost_probe_pair",
        status: "passed",
        probeA: probe("a", "8"),
        probeB: probe("b", "9"),
      },
      hostUnlock: {
        method: "supported_cua_host_unlock_probe",
        status: "unlocked",
        probeStatus: "completed",
        requestedAt: "2026-09-04T21:59:58.000Z",
        respondedAt: "2026-09-04T22:00:00.000Z",
      },
      frozenBuild: {
        arm: "A1",
        commit: "a".repeat(40),
        archiveSha256: digest("1"),
        dependencyTreeSha256: digest("2"),
        launchReceiptSha256: digest("3"),
        origin,
      },
      liveBuildProcess: {
        method: "controller_pid_cwd_and_http_probe",
        pid: 12345,
        origin,
        commit: "a".repeat(40),
        archiveSha256: digest("1"),
        launchReceiptSha256: digest("3"),
        httpStatus: 200,
        requestedAt: "2026-09-04T21:59:59.000Z",
        respondedAt: "2026-09-04T22:00:00.000Z",
      },
      telemetryReadiness: {
        status: "armed",
        captureMode: "passive_model_context_register_tool",
        injectionMode: "main_world_before_app_module",
        collectionMode: "authenticated_loopback_collector",
        controllerOnly: true,
        authorQueryable: false,
        authorEndpointExposed: false,
        reloadInvalidatesEpoch: true,
        maxCaptureBytes: 4_000_000,
        maxInvocations: 1_000,
        expectedRegisteredToolCount: 42,
        observerSourceSha256: digest("6"),
        observerConfigSha256: digest("a"),
        calibrationReceiptSha256: digest("7"),
      },
    },
  };
}

describe("EXP0036 attempt preflight", () => {
  it("separates signed infrastructure readiness from author task creation authorization", () => {
    const result = evaluateExp0036InfrastructurePreflight(
      signAttemptInput(unsignedInfrastructureInput()),
      { now: "2026-09-04T22:00:20.000Z", maxAgeMs: 30_000 },
    );
    expect(result).toMatchObject({
      phase: "infrastructure_precreation",
      decision: "task_creation_ready",
      authorTaskCreationAuthorized: false,
      reasons: [],
      gates: {
        noTaskStarted: true,
        originReserved: true,
        wildcardIsolationCalibrated: true,
        hostUnlocked: true,
        frozenBuildMatches: true,
        telemetryReady: true,
        attestationValid: true,
      },
    });
  });

  it("reports slow CUA calibration honestly without making it a task-timing failure", () => {
    const input = unsignedInfrastructureInput();
    input.evidence.taskCreationStatus = "started";
    input.evidence.wildcardIsolationCalibration.probeB.requestedAt =
      "2026-09-04T21:58:00.000Z";
    const result = evaluateExp0036InfrastructurePreflight(signAttemptInput(input), {
      now: "2026-09-04T22:00:20.000Z",
    });
    expect(result.decision).toBe("task_creation_blocked");
    expect(result.reasons).toContain(
      "TASK_ALREADY_STARTED_OR_BOUND_DURING_INFRASTRUCTURE_PREFLIGHT",
    );
    expect(result.reasons).not.toContain("UNIQUE_LOCALHOST_ISOLATION_CALIBRATION_INCOMPLETE");
    expect(result.diagnostics.isolationProbeBAcquisitionMs).toBe(120_000);
  });

  it("completes post-creation admission only when every task, isolation, session, host, build, and telemetry gate is signed", () => {
    const result = evaluateExp0036AttemptPreflight(signedInput(), {
      now: "2026-09-04T22:00:20.000Z",
      maxAgeMs: 30_000,
    });
    expect(result).toMatchObject({
      decision: "post_creation_evidence_complete",
      authorTaskCreationAuthorized: false,
      reasons: [],
      gates: {
        taskUnique: true,
        isolationProven: true,
        recentRoomsEmpty: true,
        signedSessionFresh: true,
        hostUnlocked: true,
        frozenBuildMatches: true,
        telemetryReady: true,
        attestationValid: true,
      },
    });
  });

  it("rejects a new tab or port as proof of fresh browser storage", () => {
    const input = signedInput();
    input.evidence.isolation.method = "new_tab";
    input.evidence.isolation.origin = "http://127.0.0.1:3999";
    const result = evaluateExp0036AttemptPreflight(input, {
      now: "2026-09-04T22:00:20.000Z",
      maxAgeMs: 30_000,
    });
    expect(result.decision).toBe("post_creation_evidence_blocked");
    expect(result.reasons).toContain("UNIQUE_BROWSER_STORAGE_ORIGIN_NOT_PROVEN");
    expect(result.reasons).toContain("PREFLIGHT_ATTESTATION_INVALID_OR_STALE");
  });

  it("rejects visible prior rooms and reused task, browser, or signed-session identities", () => {
    const input = signedInput();
    input.expected.prior.taskIds.push(input.expected.taskId);
    input.expected.prior.browserSessionIds.push(input.expected.browserSessionId);
    input.expected.prior.sessionIdentitySha256s.push(input.evidence.signedSession.identitySha256);
    input.evidence.isolation.preJoinRecentRooms.roomReferences.push({ roomId: "prior" });
    const result = evaluateExp0036AttemptPreflight(input, {
      now: "2026-09-04T22:00:20.000Z",
    });
    expect(result.reasons).toEqual(expect.arrayContaining([
      "TASK_OR_BROWSER_SESSION_NOT_FRESH_AND_UNIQUE",
      "PREEXISTING_RECENT_ROOM_REFERENCES_NOT_EXCLUDED",
      "FRESH_SIGNED_GUEST_SESSION_NOT_PROVEN",
      "PREFLIGHT_ATTESTATION_INVALID_OR_STALE",
    ]));
  });

  it("rejects stale host evidence, build drift, and recorder readiness without calibration", () => {
    const input = signedInput();
    input.evidence.hostUnlock.observedAt = "2026-09-04T21:00:00.000Z";
    input.evidence.frozenBuild.commit = "b".repeat(40);
    input.evidence.telemetryReadiness.calibrationReceiptSha256 = "";
    const result = evaluateExp0036AttemptPreflight(input, {
      now: "2026-09-04T22:00:20.000Z",
      maxAgeMs: 30_000,
    });
    expect(result.reasons).toEqual(expect.arrayContaining([
      "HOST_UNLOCK_NOT_FRESHLY_PROVEN",
      "FROZEN_BUILD_IDENTITY_MISMATCH",
      "COMPLETE_NATIVE_TELEMETRY_NOT_ARMED",
      "PREFLIGHT_ATTESTATION_INVALID_OR_STALE",
    ]));
  });

  it("rejects unsigned and tampered evidence", () => {
    const unsigned = unsignedInput();
    expect(evaluateExp0036AttemptPreflight(unsigned, {
      now: "2026-09-04T22:00:20.000Z",
    }).reasons).toContain("PREFLIGHT_ATTESTATION_INVALID_OR_STALE");

    const tampered = signedInput();
    tampered.evidence.task.taskId = "different_task";
    const result = evaluateExp0036AttemptPreflight(tampered, {
      now: "2026-09-04T22:00:20.000Z",
    });
    expect(result.decision).toBe("post_creation_evidence_blocked");
    expect(result.reasons).toContain("PREFLIGHT_ATTESTATION_INVALID_OR_STALE");
  });

  it("builds a post-creation supported-CUA program using unique-host WebMCP only", () => {
    const source = buildExp0036CuaPreflightProgram({
      browserId: "iab",
      origin: "http://exp0036-a01-91bd1f.localhost:3103",
      browserSessionId: "browser_fresh_01",
      roomCode: "ABC234",
      expectedRoomId: "room_expected",
      displayName: "EXP-0036 author",
      preflightNonce: "nonce-01",
    });
    expect(source).toContain('cua.createBrowserTab("iab"');
    expect(source).toContain('tools.call("list_recent_rooms", {})');
    expect(source).toContain('tools.call("join_room"');
    expect(source).toContain('tools.call("read_room_state"');
    expect(source).toContain('kind: "cua_post_creation_admission_probe"');
    expect(source).toContain('status: "not_collected"');
    expect(source).not.toMatch(/fetch\(|\/api\/|localStorage|document\.cookie|playwright\.evaluate/);
  });

  it("reports a slow corroborating cookie probe while using the final native read for freshness", () => {
    const input = signedInput();
    input.evidence.signedSession.cookieProbe.requestedAt = "2026-09-04T21:57:00.000Z";
    const result = evaluateExp0036AttemptPreflight(signAttemptInput(input), {
      now: "2026-09-04T22:00:20.000Z",
    });
    expect(result.decision).toBe("post_creation_evidence_complete");
    expect(result.diagnostics.cookieProbeAcquisitionMs).toBe(180_000);
  });

  it("derives deterministic opaque localhost origins from per-attempt nonces", () => {
    const first = createExp0036AttemptOrigin({
      attemptId: "attempt 01",
      nonce: "0123456789abcdef0123456789abcdef",
      port: 3103,
    });
    const repeat = createExp0036AttemptOrigin({
      attemptId: "attempt 01",
      nonce: "0123456789abcdef0123456789abcdef",
      port: 3103,
    });
    const other = createExp0036AttemptOrigin({
      attemptId: "attempt 02",
      nonce: "fedcba9876543210fedcba9876543210",
      port: 3103,
    });
    expect(first).toEqual(repeat);
    expect(first.hostname).toMatch(/^exp0036-attempt-01-[a-f0-9]{20}\.localhost$/);
    expect(first.origin).toBe(`http://${first.hostname}:3103`);
    expect(other.hostname).not.toBe(first.hostname);
  });

  it("refuses bare localhost and IP origins for per-attempt program generation", () => {
    expect(() => buildExp0036CuaPreflightProgram({
      browserId: "iab",
      origin: "http://127.0.0.1:3103",
      roomCode: "ABC234",
      expectedRoomId: "room_expected",
      displayName: "Author",
      preflightNonce: "nonce-01",
    })).toThrow(/configuration is invalid/i);
  });
});
