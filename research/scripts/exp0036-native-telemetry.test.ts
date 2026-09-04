// @vitest-environment node

import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";

import { describe, expect, it } from "vitest";

const recorderPath: string = "./exp0036-native-recorder.mjs";
const telemetryPath: string = "./exp0036-native-telemetry.mjs";
const preflightPath: string = "./exp0036-attempt-preflight.mjs";
const { installExp0036NativeRecorder } = await import(recorderPath);
const {
  EXP0036_NATIVE_TELEMETRY_SCHEMA_VERSION,
  exp0036NativeTelemetrySignatureMessage,
  verifyExp0036NativeTelemetry,
} = await import(telemetryPath);
const { hashExp0036PreflightValue } = await import(preflightPath);

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const publicKeySha256 = `sha256:${createHash("sha256")
  .update(keys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex")}`;

type TelemetryEvidence = {
  schemaVersion: string;
  binding: Record<string, unknown>;
  coverage: {
    captureMode: string;
    injectionMode: string;
    collectionMode: string;
    controllerOnly: boolean;
    authorQueryable: boolean;
    authorEndpointExposed: boolean;
    installedBeforeAnyToolRegistration: boolean;
    registrationSetComplete: boolean;
    noUnobservedModelContext: boolean;
    noReloadAfterArming: boolean;
    expectedRegisteredToolCount: number;
    observedRegisteredToolCount: number;
    retrieval: {
      method: string;
      complete: boolean;
      truncated: boolean;
      originHostname: string;
      maxChunkUtf8Bytes: number;
      chunkCount: number;
      completeChunkCount: number;
      jsonUtf8Bytes: number;
      jsonSha256: string;
      chunks: Array<{
        ordinal: number;
        complete: boolean;
        truncated: boolean;
        jsonFragment: string;
        utf8Bytes: number;
        sha256: string;
      }>;
      ledgerSha256: string;
    };
    collectorReceipt: Record<string, unknown>;
  };
  ledger: Record<string, unknown>;
  attestation?: {
    content: Record<string, unknown>;
    signatureBase64: string;
  };
};

function digest(character: string) {
  return `sha256:${character.repeat(64)}`;
}

class ModelContext {
  tools = new Map<string, { name: string; execute: (...args: unknown[]) => unknown }>();

  registerTool(tool: { name: string; execute: (...args: unknown[]) => unknown }) {
    this.tools.set(tool.name, tool);
  }
}

function expected() {
  return {
    attemptId: "attempt01",
    taskId: "task_fresh_01",
    browserSessionId: "browser_fresh_01",
    sessionEpoch: "epoch:attempt01",
    origin: "http://exp0036-a01-91bd1f.localhost:3103",
    originHostname: "exp0036-a01-91bd1f.localhost",
    admissionPreflightPayloadSha256: digest("1"),
    observerSourceSha256: digest("2"),
    observerConfigSha256: digest("4"),
    calibrationReceiptSha256: digest("3"),
    taskTerminalReference: "task_fresh_01:turn:1:completed",
    expectedRegisteredToolCount: 3,
    maxCaptureBytes: 100_000,
    maxInvocations: 100,
    authority: {
      keyId: "exp0036-test-authority",
      publicKeyPem,
      publicKeySha256,
    },
  };
}

function signEvidence(evidence: TelemetryEvidence) {
  const content = {
    schemaVersion: EXP0036_NATIVE_TELEMETRY_SCHEMA_VERSION,
    protocolId: "EXP-0036",
    kind: "terminal_native_telemetry_attestation",
    keyId: "exp0036-test-authority",
    publicKeySha256,
    payloadSha256: hashExp0036PreflightValue({
      schemaVersion: evidence.schemaVersion,
      binding: evidence.binding,
      coverage: evidence.coverage,
      ledger: evidence.ledger,
    }),
    signedAt: "2026-09-04T22:10:00.000Z",
  };
  evidence.attestation = {
    content,
    signatureBase64: sign(
      null,
      exp0036NativeTelemetrySignatureMessage(content),
      keys.privateKey,
    ).toString("base64"),
  };
  return evidence;
}

function evidenceFor(ledger: Record<string, unknown>, registeredToolCount = 3) {
  const contract = expected();
  const ledgerJson = JSON.stringify(ledger);
  const ledgerJsonSha256 = `sha256:${createHash("sha256").update(ledgerJson).digest("hex")}`;
  const retrieval = {
    method: "authenticated_loopback_collector",
    complete: true,
    truncated: false,
    originHostname: contract.originHostname,
    maxChunkUtf8Bytes: 32_768,
    chunkCount: 1,
    completeChunkCount: 1,
    jsonUtf8Bytes: Buffer.byteLength(ledgerJson, "utf8"),
    jsonSha256: ledgerJsonSha256,
    chunks: [{
      ordinal: 1,
      complete: true,
      truncated: false,
      jsonFragment: ledgerJson,
      utf8Bytes: Buffer.byteLength(ledgerJson, "utf8"),
      sha256: ledgerJsonSha256,
    }],
    ledgerSha256: hashExp0036PreflightValue(ledger),
  };
  const collectorContent = {
    schemaVersion: "jazzboard-exp0036-probe-collector/v1",
    attemptId: contract.attemptId,
    binding: {
      sessionEpoch: contract.sessionEpoch,
      appOrigin: contract.origin,
      observerSourceSha256: contract.observerSourceSha256,
      observerConfigSha256: contract.observerConfigSha256,
    },
    access: {
      controllerOnly: true,
      authorQueryable: false,
      authorQueryableScope: "permitted_native_webmcp_surface",
      pageJavaScriptIsolationClaimed: false,
      separateIngestAndControlSecrets: true,
      injectionWorld: "main",
      authorFacingEndpointCount: 0,
      publicWebMcpToolCountAdded: 0,
      startupFailures: [],
    },
    transport: {
      acceptedEventCount: 12,
      nextExpectedSequence: 13,
      firstSequence: 1,
      lastSequence: 12,
      duplicateEventCount: 0,
      rejectedEventCount: 0,
      rejectedAuxiliaryRequestCount: 0,
      externalRejectedRequestCount: 0,
      rejectionDiagnosticCount: 0,
      rejectionDiagnosticsCapped: false,
      rejectionDiagnostics: [],
      gapCount: 0,
      gaps: [],
      capped: false,
      maxEvents: 10_000,
      zeroDrops: true,
      events: [
        "ledger_begin",
        "tool_registered", "tool_registered", "tool_registered",
        "invocation_begin", "invocation_end",
        "invocation_begin", "invocation_end",
        "invocation_begin", "invocation_end",
        "close_requested", "ledger_end",
      ].map((eventType, index, eventTypes) => ({
        sequence: index + 1,
        eventType,
        envelopeSha256: digest("a"),
        ledgerJsonSha256: index === eventTypes.length - 1 ? retrieval.jsonSha256 : digest("b"),
      })),
    },
    close: {
      taskTerminal: true,
      terminalReference: contract.taskTerminalReference,
      requestedAt: "2026-09-04T22:10:00.000Z",
      issuedBy: "controller",
    },
    seal: {
      eventSequence: 12,
      ledgerSealed: true,
      complete: true,
    },
    retrieval,
  };
  return signEvidence({
    schemaVersion: EXP0036_NATIVE_TELEMETRY_SCHEMA_VERSION,
    binding: {
      attemptId: contract.attemptId,
      taskId: contract.taskId,
      browserSessionId: contract.browserSessionId,
      sessionEpoch: contract.sessionEpoch,
      origin: contract.origin,
      originHostname: contract.originHostname,
      admissionPreflightPayloadSha256: contract.admissionPreflightPayloadSha256,
      observerSourceSha256: contract.observerSourceSha256,
      observerConfigSha256: contract.observerConfigSha256,
      calibrationReceiptSha256: contract.calibrationReceiptSha256,
    },
    coverage: {
      captureMode: "passive_model_context_register_tool",
      injectionMode: "main_world_before_app_module",
      collectionMode: "authenticated_loopback_collector",
      controllerOnly: true,
      authorQueryable: false,
      authorEndpointExposed: false,
      installedBeforeAnyToolRegistration: true,
      registrationSetComplete: true,
      noUnobservedModelContext: true,
      noReloadAfterArming: true,
      expectedRegisteredToolCount: registeredToolCount,
      observedRegisteredToolCount: registeredToolCount,
      retrieval,
      collectorReceipt: {
        ...collectorContent,
        receiptSha256: hashExp0036PreflightValue(collectorContent),
      },
    },
    ledger,
  });
}

async function completeLedger() {
  const context = new ModelContext();
  const recorder = installExp0036NativeRecorder(context, {
    sessionEpoch: "epoch:attempt01",
    maxCaptureBytes: 100_000,
    maxInvocations: 100,
  });
  context.registerTool({
    name: "query_objects",
    execute: () => ({ ok: true, data: "café 🎷" }),
  });
  context.registerTool({
    name: "read_room_state",
    execute: () => ({ isError: true, content: [{ type: "text", text: "stale revision" }] }),
  });
  context.registerTool({
    name: "apply_canvas_transaction",
    execute: () => { throw new TypeError("transport closed"); },
  });
  context.tools.get("query_objects")!.execute({ detail: "summary" });
  context.tools.get("read_room_state")!.execute({ detail: "summary" });
  expect(() => context.tools.get("apply_canvas_transaction")!.execute({ operations: [] }))
    .toThrow("transport closed");
  return recorder.close();
}

describe("EXP0036 native telemetry contract", () => {
  it("verifies exact per-call bytes, native returned errors, and thrown error projections", async () => {
    const ledger = await completeLedger();
    const result = verifyExp0036NativeTelemetry(evidenceFor(ledger), expected());
    const firstBytes = Buffer.byteLength(JSON.stringify({ ok: true, data: "café 🎷" }), "utf8");
    const secondBytes = Buffer.byteLength(JSON.stringify({
      isError: true,
      content: [{ type: "text", text: "stale revision" }],
    }), "utf8");

    expect(result).toMatchObject({
      decision: "telemetry_complete",
      eligibleForValidRunClaim: true,
      reasons: [],
      actualInvocationCount: 3,
      successCount: 1,
      errorCount: 2,
      returnedErrorCount: 1,
      thrownOrRejectedCount: 1,
      totalReturnedOutputUtf8Bytes: firstBytes + secondBytes,
      readOutputUtf8Bytes: firstBytes + secondBytes,
      gates: {
        bindingValid: true,
        coverageValid: true,
        ledgerSealed: true,
        callsComplete: true,
        aggregateValid: true,
        attestationValid: true,
      },
    });
    expect(result.perCall).toMatchObject([
      { sequence: 1, outcome: "success", output: { completeness: "complete", utf8Bytes: firstBytes } },
      { sequence: 2, outcome: "error", kind: "returned_mcp_error", output: { completeness: "complete" } },
      {
        sequence: 3,
        outcome: "error",
        kind: "thrown",
        output: { completeness: "unavailable", utf8Bytes: null, absenceReason: "thrown" },
        error: { completeness: "complete" },
      },
    ]);
  });

  it("rejects an open or pending ledger even when host metadata reports calls", async () => {
    const context = new ModelContext();
    const recorder = installExp0036NativeRecorder(context, {
      sessionEpoch: "epoch:attempt01",
      maxCaptureBytes: 100_000,
      maxInvocations: 100,
    });
    let resolve!: (value: unknown) => void;
    context.registerTool({
      name: "query_objects",
      execute: () => new Promise((done) => { resolve = done; }),
    });
    const pending = context.tools.get("query_objects")!.execute({});
    const result = verifyExp0036NativeTelemetry(evidenceFor(recorder.getLedger(), 1), expected());
    expect(result.decision).toBe("telemetry_non_evaluable");
    expect(result.eligibleForValidRunClaim).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "NATIVE_LEDGER_NOT_SEALED_COMPLETE",
      "NATIVE_CALL_RECORD_INCOMPLETE_OR_INVALID",
    ]));
    resolve({ ok: true });
    await pending;
  });

  it("rejects truncation, dropped calls, reloads, and any recorder invalidation", async () => {
    const context = new ModelContext();
    const recorder = installExp0036NativeRecorder(context, {
      sessionEpoch: "epoch:attempt01",
      maxCaptureBytes: 12,
      maxInvocations: 1,
    });
    context.registerTool({
      name: "query_objects",
      execute: () => ({ ok: true, value: "larger than bound" }),
    });
    context.tools.get("query_objects")!.execute({ first: "larger than bound" });
    context.tools.get("query_objects")!.execute({ second: true });
    recorder.markReload({ eventType: "pagehide" });
    const result = verifyExp0036NativeTelemetry(evidenceFor(recorder.getLedger(), 1), expected());
    expect(result.eligibleForValidRunClaim).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "NATIVE_LEDGER_NOT_SEALED_COMPLETE",
      "NATIVE_CALL_RECORD_INCOMPLETE_OR_INVALID",
      "NATIVE_LEDGER_AGGREGATES_INVALID",
    ]));
  });

  it("rejects a byte/hash edit and aggregate edits even after the evidence is re-signed", async () => {
    const ledger = structuredClone(await completeLedger());
    ledger.calls[0].output.utf8Bytes += 1;
    ledger.aggregates.outputUtf8Bytes += 2;
    const result = verifyExp0036NativeTelemetry(evidenceFor(ledger), expected());
    expect(result.reasons).toEqual(expect.arrayContaining([
      "NATIVE_CALL_RECORD_INCOMPLETE_OR_INVALID",
      "NATIVE_LEDGER_AGGREGATES_INVALID",
    ]));
  });

  it("rejects incomplete retrieval or an unproven secondary model-context boundary", async () => {
    const ledger = await completeLedger();
    const evidence = evidenceFor(ledger);
    evidence.coverage.retrieval.truncated = true;
    evidence.coverage.noUnobservedModelContext = false;
    const result = verifyExp0036NativeTelemetry(signEvidence(evidence), expected());
    expect(result.reasons).toContain("RECORDER_COVERAGE_OR_RETRIEVAL_INCOMPLETE");
    expect(result.eligibleForValidRunClaim).toBe(false);
  });

  it("rejects collector access exposure, event gaps, or a close not bound to the terminal task", async () => {
    const ledger = await completeLedger();
    const evidence = evidenceFor(ledger);
    const receipt = evidence.coverage.collectorReceipt as {
      access: { authorQueryable: boolean };
      transport: { gapCount: number; gaps: Array<{ expected: number; observed: number }>; zeroDrops: boolean };
      close: { terminalReference: string };
    };
    receipt.access.authorQueryable = true;
    receipt.transport.gapCount = 1;
    receipt.transport.gaps = [{ expected: 5, observed: 6 }];
    receipt.transport.zeroDrops = false;
    receipt.close.terminalReference = "another-task:turn:1";
    const result = verifyExp0036NativeTelemetry(signEvidence(evidence), expected());
    expect(result.reasons).toContain("RECORDER_COVERAGE_OR_RETRIEVAL_INCOMPLETE");
    expect(result.eligibleForValidRunClaim).toBe(false);
  });

  it("rejects an unsigned ledger or one bound to another task/session/origin", async () => {
    const ledger = await completeLedger();
    const unsigned = evidenceFor(ledger);
    delete unsigned.attestation;
    expect(verifyExp0036NativeTelemetry(unsigned, expected()).reasons)
      .toContain("NATIVE_TELEMETRY_ATTESTATION_INVALID");

    const rebound = evidenceFor(ledger);
    rebound.binding.taskId = "different_task";
    rebound.binding.originHostname = "other.localhost";
    const result = verifyExp0036NativeTelemetry(signEvidence(rebound), expected());
    expect(result.reasons).toContain("TELEMETRY_BINDING_MISMATCH");
  });

  it("does not accept EXP0035-style host metadata in place of a complete native ledger", () => {
    const evidence = {
      schemaVersion: EXP0036_NATIVE_TELEMETRY_SCHEMA_VERSION,
      binding: {},
      coverage: {
        hostMetadata: {
          status: "observed_without_completeness_signal",
          webMcpCalls: [{ name: "query_objects", outputJson: "{}" }],
        },
      },
      ledger: null,
    };
    const result = verifyExp0036NativeTelemetry(evidence, expected());
    expect(result.decision).toBe("telemetry_non_evaluable");
    expect(result.eligibleForValidRunClaim).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "RECORDER_COVERAGE_OR_RETRIEVAL_INCOMPLETE",
      "NATIVE_LEDGER_NOT_SEALED_COMPLETE",
      "NATIVE_CALL_RECORD_INCOMPLETE_OR_INVALID",
      "NATIVE_TELEMETRY_ATTESTATION_INVALID",
    ]));
  });
});
