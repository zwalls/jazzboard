// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./exp0001a-model-role-qualification-v2-coordinator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exp0001a-model-role-qualification-v2-coordinator")>();
  return {
    ...actual,
    signedQualificationV2ResultEnvelopeSchema: {
      parse: (input: unknown) => {
        const marker = input as { state?: string } | null;
        if (marker === null || marker?.state === "absent") {
          throw new Error("QUALIFICATION_V2_AUTHORITY_SIGNATURE_REQUIRED");
        }
        if (marker?.state === "tampered") {
          throw new Error("QUALIFICATION_V2_AUTHORITY_SIGNATURE_INVALID");
        }
        if (!marker?.state || ![
          "pass",
          "fail",
          "incomplete",
          "sol-max",
          "wrong-plan",
          "wrong-plan-signature",
          "wrong-binding",
        ].includes(marker.state)) {
          throw new Error("QUALIFICATION_V2_SIGNED_RESULT_ENVELOPE_INVALID");
        }
        const decision = marker.state === "fail" || marker.state === "incomplete"
          ? marker.state
          : "pass";
        return {
          schemaVersion: "exp-0001a-model-role-qualification-signed-result/v2",
          envelopeDigest: `sha256:${"a".repeat(64)}`,
          authoritySignature: {
            signedAt: "2026-08-31T22:00:00.000Z",
            proof: "authority-verified-by-mocked-fixed-key-parser",
          },
          result: {
            resultDigest: `sha256:${"b".repeat(64)}`,
            planDigest: marker.state === "wrong-plan"
              ? `sha256:${"1".repeat(64)}`
              : "sha256:e318342431aa10f1813ea7ee9bcdd508f913096a71d0886cebde98212287188b",
            planAuthoritySignatureDigest: marker.state === "wrong-plan-signature"
              ? `sha256:${"2".repeat(64)}`
              : "sha256:1aa9914f472f5fadd85027d9eb08337279ee67f08183bae93a6b40ffa57f89cb",
            productionBindingDigest: marker.state === "wrong-binding"
              ? `sha256:${"3".repeat(64)}`
              : "sha256:4efb96a5bb2a0e49f6e6c17782a4b5b290b3ff540e8ea6f9fc8cd34afd546272",
            terminalEvidenceAttestationDigest: `sha256:${"4".repeat(64)}`,
            terminalStateDigest: `sha256:${"5".repeat(64)}`,
            retainedEvidenceInventoryRoot: `sha256:${"6".repeat(64)}`,
            retainedEvidenceFileCount: 42,
            completedAt: "2026-08-31T22:00:00.000Z",
            authorPolicy: marker.state === "sol-max"
              ? { model: "gpt-5.6-sol", reasoningEffort: "max" }
              : { model: "gpt-5.6-terra", reasoningEffort: "medium" },
            reviewerPolicy: { model: "gpt-5.6-sol", reasoningEffort: "high" },
            gateDecision: {
              decision,
              compatibleTaskIds: decision === "pass" ? [
                "dev-architecture-create-checkout",
                "dev-architecture-edit-uncertainty",
                "dev-drawing-create-wayfinding-icon",
              ] : [],
              failedTaskIds: decision === "fail" ? ["dev-architecture-create-checkout"] : [],
              incompleteTaskIds: decision === "incomplete" ? ["dev-architecture-create-checkout"] : [],
            },
            aaExecutionStatus: decision === "pass" ? "eligible_for_successor_freeze" : "blocked",
          },
        };
      },
    },
  };
});

vi.mock("./baseline-freeze-v2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./baseline-freeze-v2")>();
  return {
    ...actual,
    verifyBaselineV2ExecutionReady: (
      receiptInput: unknown,
      _inventoryInput: unknown,
      _evidenceInput: unknown,
      artifacts: { authoritySignature?: unknown },
    ) => {
      if ((artifacts.authoritySignature as { tampered?: boolean } | undefined)?.tampered) {
        return { ok: false, errors: ["BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_INVALID"], verifiedBytes: {} };
      }
      const receipt = actual.baselineFreezeReceiptV2Schema.safeParse(receiptInput);
      if (!receipt.success) return { ok: false, errors: ["BASELINE_V2_IDENTITY_INVALID"], verifiedBytes: {} };
      return {
        ok: true,
        receipt: receipt.data,
        inventory: {},
        evidence: {},
        verifiedBytes: { exactEvidenceBytes: `sha256:${"c".repeat(64)}` },
      };
    },
  };
});

import baselineReceiptJson from "../../../research/data/baseline-freeze-v2.json";
import historicalSolFreezeJson from "../../../research/data/exp-0001a-codex-prebrief-freeze-v2.json";
import { baselineFreezeReceiptV2Schema } from "./baseline-freeze-v2";
import {
  createExp0001aSuccessorReleaseCoordinatorV3,
  EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID,
  nextExp0001aSuccessorReleaseActionV3,
  verifyExp0001aSuccessorLaunchGateV3,
  type Exp0001aSuccessorLaunchEvidenceV3,
} from "./exp0001a-successor-runtime-v3";

const DIGEST_C = `sha256:${"c".repeat(64)}`;
const CHECKED_AT = "2026-09-01T00:00:00.000Z";
const baselineReceipt = baselineFreezeReceiptV2Schema.parse(baselineReceiptJson);
const temporaryRoots: string[] = [];

const syntacticallyValidBaselineSignature = Object.freeze({
  schemaVersion: "baseline-freeze-v2-authority-signature/v1",
  protocolId: "EXP-0001A",
  kind: "baseline-freeze-authority-signature",
  algorithm: "Ed25519",
  keyId: "exp0001a-launch-authority-2026-08-30",
  keyPurpose: "baseline_freeze_v2",
  publicKeyPath: "research/data/exp0001a-execution-authority-public.pem",
  publicKeyDigest: "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de",
  signedAt: "2026-08-31T20:00:00.000Z",
  payloadSchema: "baseline-freeze/v2",
  payloadDigest: `sha256:${"d".repeat(64)}`,
  signatureBase64: `${"A".repeat(86)}==`,
});

function evidence(
  qualificationState = "pass",
  baselineState = "pass",
): Exp0001aSuccessorLaunchEvidenceV3 {
  const receipt = baselineState === "wrong" ? {
    ...baselineReceipt,
    deployment: { ...baselineReceipt.deployment, buildId: "bld_wrong" },
  } : baselineReceipt;
  return {
    checkedAt: CHECKED_AT,
    signedQualificationResult: { state: qualificationState },
    baseline: {
      receipt,
      inventory: {},
      productionEvidence: {},
      artifacts: {
        authoritySignature: baselineState === "tampered"
          ? { tampered: true }
          : syntacticallyValidBaselineSignature,
      },
    },
  };
}

function verifiedGate() {
  return verifyExp0001aSuccessorLaunchGateV3(evidence());
}

async function temporaryStatePath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "exp0001a-successor-v3-"));
  temporaryRoots.push(root);
  return path.join(root, "single-assignment-release-state.json");
}

function clock() {
  const values = [
    "2026-09-01T00:01:00.000Z",
    "2026-09-01T00:02:00.000Z",
    "2026-09-01T00:03:00.000Z",
    "2026-09-01T00:04:00.000Z",
    "2026-09-01T00:05:00.000Z",
  ];
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("EXP-0001A successor-runtime/v3 launch authority", () => {
  it("fails closed for absent or tampered qualification authority", () => {
    expect(() => verifyExp0001aSuccessorLaunchGateV3(
      { ...evidence(), signedQualificationResult: null },
    )).toThrow("QUALIFICATION_V2_AUTHORITY_SIGNATURE_REQUIRED");
    expect(() => verifyExp0001aSuccessorLaunchGateV3(
      evidence("tampered"),
    )).toThrow("QUALIFICATION_V2_AUTHORITY_SIGNATURE_INVALID");

    // The production path invokes the fixed-key signed-envelope parser. A
    // pass-looking object without a valid authority envelope is never enough.
    expect(() => verifyExp0001aSuccessorLaunchGateV3({
      ...evidence(),
      signedQualificationResult: {
        schemaVersion: "exp-0001a-model-role-qualification-signed-result/v2",
        result: { gateDecision: { decision: "pass" } },
      },
    })).toThrow();
  });

  it("rejects authority-verified fail and incomplete qualification outcomes", () => {
    expect(() => verifyExp0001aSuccessorLaunchGateV3(
      evidence("fail"),
    )).toThrow("REQUIRES_EXACT_SIGNED_QUALIFICATION_V2_PASS");
    expect(() => verifyExp0001aSuccessorLaunchGateV3(
      evidence("incomplete"),
    )).toThrow("REQUIRES_EXACT_SIGNED_QUALIFICATION_V2_PASS");
  });

  it("rejects a signed pass tied to any other plan, plan signature, or production binding", () => {
    expect(() => verifyExp0001aSuccessorLaunchGateV3(evidence("wrong-plan")))
      .toThrow("REQUIRES_EXACT_SIGNED_QUALIFICATION_V2_PASS");
    expect(() => verifyExp0001aSuccessorLaunchGateV3(evidence("wrong-plan-signature")))
      .toThrow("REQUIRES_EXACT_SIGNED_QUALIFICATION_V2_PASS");
    expect(() => verifyExp0001aSuccessorLaunchGateV3(evidence("wrong-binding")))
      .toThrow("REQUIRES_EXACT_SIGNED_QUALIFICATION_V2_PASS");
  });

  it("rejects tampered or wrong production baseline evidence", () => {
    expect(() => verifyExp0001aSuccessorLaunchGateV3(
      evidence("pass", "tampered"),
    )).toThrow("BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_INVALID");
    expect(() => verifyExp0001aSuccessorLaunchGateV3(
      evidence("pass", "wrong"),
    )).toThrow("BASELINE_V2_NOT_EXECUTION_READY");
  });

  it("cannot substitute the historical unsigned Sol/max v2 prebrief path", () => {
    expect(() => verifyExp0001aSuccessorLaunchGateV3({
      ...evidence(),
      signedQualificationResult: historicalSolFreezeJson,
    })).toThrow();
    expect(() => verifyExp0001aSuccessorLaunchGateV3(evidence("sol-max")))
      .toThrow("REQUIRES_EXACT_SIGNED_QUALIFICATION_V2_PASS");
  });

  it("binds Terra/medium and only the first assignment while retaining the unchanged 48-attempt schedule", () => {
    const gate = verifiedGate();
    expect(gate).toMatchObject({
      decision: "allow_exactly_one_fixed_assignment",
      rolePolicy: {
        author: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
        primaryReviewer: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      },
      schedule: {
        manifestId: "exp-0001a-development-execution-v2",
        assignmentCount: 48,
        firstAssignment: {
          assignmentId: EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID,
          condition: "A1",
          plannedIndex: 0,
        },
      },
      releasePolicy: {
        authorizedAssignmentIds: [EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID],
        maximumAssignmentReleases: 1,
        terminalizedAssignmentDoesNotReopenCeiling: true,
        restartDoesNotReopenCeiling: true,
        releaseRetryPermitted: false,
      },
    });
    expect(JSON.stringify(gate)).not.toMatch(/OPENAI_API_KEY|api\.openai\.com|cost(?:Usd)?/i);
  });

  it("does not accept a self-hashed gate after its in-process authority proof is stripped", async () => {
    const gate = verifiedGate();
    const serializedCopy = JSON.parse(JSON.stringify(gate)) as typeof gate;
    const filePath = await temporaryStatePath();
    expect(() => createExp0001aSuccessorReleaseCoordinatorV3({
      filePath,
      gate: serializedCopy,
    })).toThrow("SUCCESSOR_V3_UNVERIFIED_LAUNCH_GATE");
  });
});

describe("EXP-0001A successor-runtime/v3 durable one-assignment ceiling", () => {
  it("persists release before handoff and rejects every repeated release invocation", async () => {
    const coordinator = createExp0001aSuccessorReleaseCoordinatorV3({
      filePath: await temporaryStatePath(),
      gate: verifiedGate(),
      now: clock(),
    });
    await coordinator.initialize();
    expect(await coordinator.nextAction()).toEqual({
      kind: "reserve_first_assignment",
      assignmentId: EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID,
    });
    await coordinator.reserveFirstAssignment();
    const released = await coordinator.authorizeReservedFirstAssignmentRelease();
    expect(released.state).toMatchObject({ phase: "released", assignmentReleaseCount: 1 });
    expect(await coordinator.nextAction()).toMatchObject({
      kind: "await_first_assignment_terminal_or_reconciliation",
      releaseMayBeReissued: false,
    });
    await expect(coordinator.authorizeReservedFirstAssignmentRelease())
      .rejects.toThrow("RELEASE_NOT_RESERVED");
  });

  it("survives a crash/restart without re-emitting the first release", async () => {
    const filePath = await temporaryStatePath();
    const gate = verifiedGate();
    const first = createExp0001aSuccessorReleaseCoordinatorV3({ filePath, gate, now: clock() });
    await first.initialize();
    await first.reserveFirstAssignment();
    const released = await first.authorizeReservedFirstAssignmentRelease();

    const restarted = createExp0001aSuccessorReleaseCoordinatorV3({ filePath, gate, now: clock() });
    await expect(restarted.initialize()).resolves.toMatchObject({
      stateDigest: released.state.stateDigest,
      phase: "released",
      assignmentReleaseCount: 1,
    });
    await expect(restarted.nextAction()).resolves.toMatchObject({
      kind: "await_first_assignment_terminal_or_reconciliation",
      releaseMayBeReissued: false,
    });
    await expect(restarted.authorizeReservedFirstAssignmentRelease())
      .rejects.toThrow("RELEASE_NOT_RESERVED");
  });

  it("permanently stops after the first assignment terminalizes", async () => {
    const filePath = await temporaryStatePath();
    const gate = verifiedGate();
    const coordinator = createExp0001aSuccessorReleaseCoordinatorV3({
      filePath,
      gate,
      now: clock(),
    });
    await coordinator.initialize();
    await coordinator.reserveFirstAssignment();
    const { releaseAuthorization } = await coordinator.authorizeReservedFirstAssignmentRelease();
    const terminal = await coordinator.terminalizeFirstAssignment({
      releaseAuthorizationDigest: releaseAuthorization.authorizationDigest,
      outcome: "succeeded",
      evidenceDigest: DIGEST_C,
    });
    expect(terminal).toMatchObject({
      phase: "permanently_stopped",
      assignmentReleaseCount: 1,
      stopReason: "single_assignment_ceiling_reached",
    });
    expect(nextExp0001aSuccessorReleaseActionV3(terminal)).toEqual({
      kind: "single_assignment_ceiling_reached",
      assignmentId: EXP0001A_SUCCESSOR_FIRST_ASSIGNMENT_ID,
      releaseCount: 1,
      permanentlyStopped: true,
    });
    await expect(coordinator.reserveFirstAssignment()).rejects.toThrow("NOT_READY_FOR_RESERVATION");
    await expect(coordinator.authorizeReservedFirstAssignmentRelease()).rejects.toThrow("RELEASE_NOT_RESERVED");

    const restarted = createExp0001aSuccessorReleaseCoordinatorV3({ filePath, gate, now: clock() });
    await expect(restarted.initialize()).resolves.toMatchObject({
      phase: "permanently_stopped",
      stateDigest: terminal.stateDigest,
    });
    await expect(restarted.nextAction()).resolves.toMatchObject({
      kind: "single_assignment_ceiling_reached",
      releaseCount: 1,
      permanentlyStopped: true,
    });
  });

  it("allows exactly one winner under concurrent double-release pressure", async () => {
    const coordinator = createExp0001aSuccessorReleaseCoordinatorV3({
      filePath: await temporaryStatePath(),
      gate: verifiedGate(),
      now: clock(),
    });
    await coordinator.initialize();
    await coordinator.reserveFirstAssignment();
    const results = await Promise.allSettled([
      coordinator.authorizeReservedFirstAssignmentRelease(),
      coordinator.authorizeReservedFirstAssignmentRelease(),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(coordinator.read()).resolves.toMatchObject({
      phase: "released",
      assignmentReleaseCount: 1,
    });
  });
});
