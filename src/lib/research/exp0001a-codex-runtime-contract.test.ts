import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import freezeJson from "../../../research/data/exp-0001a-codex-prebrief-freeze-v2.json";
import manifestJson from "../../../research/data/development-execution-manifest-v1.json";
// @ts-expect-error committed ESM preflight intentionally has no declaration file
import { createCodexAuthPreflightReceipt } from "../../../research/scripts/codex-auth-preflight.mjs";
import { createExp0001aProvisioningCoordinator } from "./exp0001a-attempt-provisioning";
import {
  EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
  createExp0001aCodexScheduler,
  exp0001aCodexAccountingLedgerSchema,
  type Exp0001aFrozenCodexAssignment,
} from "./exp0001a-codex-accounting";
import { createExp0001aCodexCoordinatorJournal, planNextExp0001aCodexCoordinatorAction } from "./exp0001a-codex-coordinator";
import {
  createExp0001aCodexRuntimePreflight,
  exp0001aCodexRuntimeConfigSchema,
  verifyExp0001aCodexRuntimePreflight,
} from "./exp0001a-codex-runtime-contract";
import {
  computeExp0001aCodexPrebriefFreezeDigest,
  verifyExp0001aCodexPrebriefFreeze,
  type Exp0001aCodexPrebriefFreeze,
} from "./exp0001a-codex-prebrief-freeze";
import { hashCanonicalJson, type JsonValue } from "./provenance-crypto";

vi.mock("./codex-webmcp-spike", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-webmcp-spike")>();
  return { ...actual, assertCodexWebMcpAaExecutionAllowed: (gate: unknown) => gate };
});
vi.mock("./codex-webmcp-spike-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-webmcp-spike-recovery")>();
  return { ...actual, verifyExp0001aCodexSpikeRecoveryGate: (gate: unknown) => gate };
});

vi.mock("./exp0001a-codex-authority", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exp0001a-codex-authority")>();
  return {
    ...actual,
    verifyExp0001aCodexAuthoritySignature: ({ payload, signature, purpose }: {
      payload: JsonValue;
      signature: { payloadDigest: string; purpose: string };
      purpose: string;
    }) => {
      if (signature.purpose !== purpose || signature.payloadDigest !== hashCanonicalJson(payload)) {
        throw new Error("EXP0001A_CODEX_AUTHORITY_PAYLOAD_BINDING_INVALID");
      }
      return signature;
    },
  };
});

const roots: string[] = [];
const TEST_SPIKE_EVIDENCE = { fixture: "codex-native-v2-spike-evidence" } as const;
const TEST_SPIKE_EVIDENCE_DIGEST = hashCanonicalJson(TEST_SPIKE_EVIDENCE);
const TEST_SPIKE_GATE_DIGEST = hashCanonicalJson({ fixture: "codex-native-v2-spike-gate" });
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function frozenAssignments(): Exp0001aFrozenCodexAssignment[] {
  return manifestJson.assignments.flatMap((pair) => pair.attempts.map((attempt) => ({ pair, attempt })))
    .sort((left, right) => left.pair.timeBlock - right.pair.timeBlock || left.attempt.orderIndex - right.attempt.orderIndex)
    .map(({ pair, attempt }, plannedIndex) => ({ assignmentId: `assignment-${attempt.attemptId}`, attemptId: attempt.attemptId,
      pairId: pair.pairId, condition: attempt.opaqueLabel as "A0" | "A1", plannedIndex,
      timeBlock: pair.timeBlock, orderInPair: attempt.orderIndex as 0 | 1 }));
}

function currentFreeze(): Exp0001aCodexPrebriefFreeze {
  const { freezeDigest: _old, ...content } = freezeJson;
  void _old;
  const adjusted = {
    ...content,
    passedSpikeGate: {
      ...content.passedSpikeGate,
      spikeEvidenceDigest: TEST_SPIKE_EVIDENCE_DIGEST,
      gateDigest: TEST_SPIKE_GATE_DIGEST,
      authoritySignaturePayloadDigest: hashCanonicalJson({ fixture: "non-revoked-v2-spike-gate" }),
    },
  };
  return verifyExp0001aCodexPrebriefFreeze({ ...adjusted,
    freezeDigest: computeExp0001aCodexPrebriefFreezeDigest(adjusted as never) });
}

async function validInput() {
  const freeze = currentFreeze();
  const scheduler = createExp0001aCodexScheduler(frozenAssignments());
  const accountingLedger = exp0001aCodexAccountingLedgerSchema.parse({
    schemaVersion: "exp-0001a-codex-accounting-ledger/v1", protocolId: "EXP-0001A",
    frozenRoleSettings: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS, tasks: [],
  });
  const root = await mkdtemp(path.join(tmpdir(), "exp0001a-runtime-contract-"));
  roots.push(root);
  const provisioningState = await createExp0001aProvisioningCoordinator({
    filePath: path.join(root, "provisioning.json"), scheduler,
    now: () => "2026-08-31T03:31:00.000Z", createRoomNonce: () => "rn_0123456789abcdef0123456789abcdef",
  }).initialize();
  const coordinatorJournal = createExp0001aCodexCoordinatorJournal({ provisioningState });
  const recordedAt = "2026-08-31T03:31:30.000Z";
  const action = planNextExp0001aCodexCoordinatorAction({ issuedAt: recordedAt, provisioningState, journal: coordinatorJournal });
  const freezeAuthoritySignature = {
    schemaVersion: "exp-0001a-codex-authority-signature/v1" as const, protocolId: "EXP-0001A" as const,
    kind: "codex-authority-signature" as const, algorithm: "Ed25519" as const,
    keyId: "exp0001a-launch-authority-2026-08-30" as const,
    publicKeyDigest: "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de" as const,
    signedAt: recordedAt, purpose: "prebrief_freeze" as const,
    payloadDigest: hashCanonicalJson(freeze as unknown as JsonValue),
    signatureBase64: "MjEQ/Pg8kWPVqThM7QptWE9gtMqN0Gb77HWHnmR9aNc83T48jEuGh7J2SfJY6/WzkFeSqf2/qzFreO7VSS/oCw==",
  };
  const checkpointPayload = {
    schemaVersion: "exp-0001a-codex-coordinator-checkpoint/v1" as const, kind: "codex-coordinator-checkpoint" as const,
    protocolId: "EXP-0001A" as const, checkpointId: "checkpoint-runtime-contract-fixture", recordedAt,
    expiresAt: "2026-08-31T03:36:30.000Z", decision: "authorize_next_action" as const,
    freezeDigest: freeze.freezeDigest,
    prebriefFreezeAuthorityPayloadDigest: hashCanonicalJson(freeze as unknown as JsonValue),
    prebriefFreezeAuthoritySignatureDigest: hashCanonicalJson(freezeAuthoritySignature as unknown as JsonValue),
    runtimeBundleDigest: freeze.activeRuntime.bundleDigest,
    spikeEvidenceDigest: freeze.passedSpikeGate.spikeEvidenceDigest, spikeGateDigest: freeze.passedSpikeGate.gateDigest,
    frozenScheduleDigest: scheduler.frozenScheduleDigest,
    schedulerStateDigest: hashCanonicalJson(scheduler as unknown as JsonValue),
    accountingLedgerDigest: hashCanonicalJson(accountingLedger as unknown as JsonValue),
    provisioningStateDigest: provisioningState.stateDigest, coordinatorJournalDigest: coordinatorJournal.journalDigest,
    authorizedActionDigest: hashCanonicalJson(action as unknown as JsonValue), journalPreviousEntryDigest: null,
  };
  return {
    checkedAt: "2026-08-31T03:32:00.000Z", runtimeBundleDigest: freeze.activeRuntime.bundleDigest, freeze,
    authorizedPrebriefFreezePayloadDigest: freezeAuthoritySignature.payloadDigest,
    authorizedPrebriefFreezeSignatureDigest: hashCanonicalJson(freezeAuthoritySignature as unknown as JsonValue),
    freezeAuthoritySignature,
    authPreflightReceipt: createCodexAuthPreflightReceipt({ stdout: "Logged in using ChatGPT\n", stderr: "", exitCode: 0,
      signal: null, invocationError: false, outputLimitExceeded: false }, { checkedAt: "2026-08-31T03:31:00.000Z" }),
    spikeGate: { schemaVersion: "exp-0001a-codex-webmcp-spike-recovery-gate/v2", protocolId: "EXP-0001A",
      kind: "codex-webmcp-spike-recovery-gate", evaluatedAt: "2026-08-31T03:16:47.000Z", evidence: TEST_SPIKE_EVIDENCE,
      evidenceDigest: freeze.passedSpikeGate.spikeEvidenceDigest, decision: "allow", reasons: ["VERIFIED_CODEX_NATIVE_PROJECTLESS_WEBMCP_SPIKE"],
      gateDigest: freeze.passedSpikeGate.gateDigest, authoritySignature: {
        schemaVersion: "exp-0001a-codex-authority-signature/v1", protocolId: "EXP-0001A",
        kind: "codex-authority-signature", algorithm: "Ed25519", keyId: "exp0001a-launch-authority-2026-08-30",
        publicKeyDigest: "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de",
        signedAt: "2026-08-31T04:35:56.000Z", purpose: "spike_gate",
        payloadDigest: freeze.passedSpikeGate.authoritySignaturePayloadDigest,
        signatureBase64: freeze.passedSpikeGate.authoritySignatureBase64,
      } },
    spikeEvidence: TEST_SPIKE_EVIDENCE, scheduler, accountingLedger, provisioningState, coordinatorJournal,
    coordinatorCheckpoint: { ...checkpointPayload, authoritySignature: {
      schemaVersion: "exp-0001a-codex-authority-signature/v1" as const, protocolId: "EXP-0001A" as const,
      kind: "codex-authority-signature" as const, algorithm: "Ed25519" as const,
      keyId: "exp0001a-launch-authority-2026-08-30" as const,
      publicKeyDigest: "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de" as const,
      signedAt: recordedAt, purpose: "coordinator_checkpoint" as const,
      payloadDigest: hashCanonicalJson(checkpointPayload as unknown as JsonValue),
      signatureBase64: "MjEQ/Pg8kWPVqThM7QptWE9gtMqN0Gb77HWHnmR9aNc83T48jEuGh7J2SfJY6/WzkFeSqf2/qzFreO7VSS/oCw==",
    } },
    checkpointPayload,
  };
}

describe("EXP-0001A Codex-native runtime contract", () => {
  it("validates live auth, signed exact state, and the one authorized action", async () => {
    const input = await validInput();
    const receipt = createExp0001aCodexRuntimePreflight(input as never);
    expect(receipt).toMatchObject({ decision: "ready_for_coordinator", executionAllowed: true,
      reasons: ["SIGNED_STATE_AND_LIVE_CHATGPT_AUTH_VERIFIED"],
      nextAction: { kind: "emit_one_coordinator_action", callerMustPerformAction: true, runtimeInvokedExternalTool: false },
      provisioningStateDigest: input.provisioningState.stateDigest, coordinatorJournalDigest: input.coordinatorJournal.journalDigest });
    expect(verifyExp0001aCodexRuntimePreflight(receipt, "2026-08-31T03:32:01.000Z")).toEqual(receipt);
    const forged = structuredClone(receipt);
    forged.coordinatorCheckpoint.authorizedActionDigest = `sha256:${"f".repeat(64)}`;
    const { receiptDigest: _digest, ...forgedContent } = forged;
    void _digest;
    forged.receiptDigest = hashCanonicalJson(forgedContent as unknown as JsonValue);
    expect(() => verifyExp0001aCodexRuntimePreflight(forged, "2026-08-31T03:32:01.000Z"))
      .toThrow(/authority|signature|CHECKPOINT/i);
  });

  it("rejects stale/non-ChatGPT auth before signed-state release", async () => {
    const input = await validInput();
    expect(() => createExp0001aCodexRuntimePreflight({ ...input, checkedAt: "2026-08-31T03:40:00.000Z" } as never))
      .toThrow(/AUTH_PREFLIGHT_STALE/);
    const apiKeyReceipt = createCodexAuthPreflightReceipt({ stdout: "Logged in using an API key\n", stderr: "", exitCode: 0,
      signal: null, invocationError: false, outputLimitExceeded: false }, { checkedAt: "2026-08-31T03:31:00.000Z" });
    expect(() => createExp0001aCodexRuntimePreflight({ ...input, authPreflightReceipt: apiKeyReceipt } as never))
      .toThrow(/CHATGPT_AUTH_REQUIRED/);
  });

  it("accepts only the compact provider-free config", () => {
    const config = exp0001aCodexRuntimeConfigSchema.parse({ schemaVersion: "exp-0001a-codex-runtime-contract/v1",
      protocolId: "EXP-0001A", files: { codexPrebriefFreeze: "/tmp/freeze.json", spikeGate: "/tmp/gate.json",
        codexPrebriefFreezeSignature: "/tmp/freeze-signature.json",
        spikeEvidence: "/tmp/spike.json", coordinatorCheckpoint: "/tmp/checkpoint.json", schedulerState: "/tmp/scheduler.json",
        accountingLedger: "/tmp/accounting.json", provisioningCoordinatorState: "/tmp/provisioning.json",
        coordinatorJournal: "/tmp/journal.json" }, outputRoot: "/tmp/exp0001a-output",
      runtimeBundleDigest: `sha256:${"a".repeat(64)}`,
      authorizedPrebriefFreezePayloadDigest: `sha256:${"b".repeat(64)}`,
      authorizedPrebriefFreezeSignatureDigest: `sha256:${"c".repeat(64)}` });
    expect(JSON.stringify(config)).not.toMatch(/tokenBudget|pricing|cost|spend|secret|serviceTier/i);
  });
});
