// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./exp0001a-model-role-qualification-v2-coordinator", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("./exp0001a-model-role-qualification-v2-coordinator")
  >();
  return {
    ...actual,
    signedQualificationV2ResultEnvelopeSchema: {
      parse: (input: unknown) => {
        const state = (input as { state?: string } | null)?.state;
        if (!state || state === "tampered") throw new Error("QUALIFICATION_SIGNATURE_INVALID");
        const decision = state === "fail" ? "fail" : "pass";
        return {
          schemaVersion: "exp-0001a-model-role-qualification-signed-result/v2",
          envelopeDigest: `sha256:${"a".repeat(64)}`,
          authoritySignature: { signedAt: "2026-09-01T20:00:00.000Z" },
          result: {
            resultDigest: `sha256:${"b".repeat(64)}`,
            planDigest: state === "wrong-plan"
              ? `sha256:${"1".repeat(64)}`
              : "sha256:e318342431aa10f1813ea7ee9bcdd508f913096a71d0886cebde98212287188b",
            planAuthoritySignatureDigest:
              "sha256:1aa9914f472f5fadd85027d9eb08337279ee67f08183bae93a6b40ffa57f89cb",
            productionBindingDigest: state === "wrong-binding"
              ? `sha256:${"2".repeat(64)}`
              : "sha256:26d644dabf67b8f9d63011fdcd6d1af0c09069e67cb6977f3ac97eaa36f15688",
            terminalEvidenceAttestationDigest: `sha256:${"3".repeat(64)}`,
            terminalStateDigest: `sha256:${"4".repeat(64)}`,
            retainedEvidenceInventoryRoot: `sha256:${"5".repeat(64)}`,
            retainedEvidenceFileCount: 99,
            completedAt: state === "future"
              ? "2026-09-03T00:00:00.000Z"
              : "2026-09-01T20:00:00.000Z",
            authorPolicy: state === "wrong-role"
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
              incompleteTaskIds: [],
            },
            aaExecutionStatus: decision === "pass" ? "eligible_for_successor_freeze" : "blocked",
          },
        };
      },
    },
  };
});

vi.mock("./baseline-freeze-v3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./baseline-freeze-v3")>();
  return {
    ...actual,
    verifyBaselineV3ExecutionReady: (
      receiptInput: unknown,
      inventoryInput: unknown,
      evidenceInput: unknown,
      artifacts: { authoritySignature?: unknown },
    ) => {
      if ((artifacts.authoritySignature as { tampered?: boolean } | undefined)?.tampered) {
        return { ok: false, errors: ["BASELINE_V3_SIGNATURE_INVALID"], verifiedBytes: {} };
      }
      const receipt = actual.baselineFreezeReceiptV3Schema.safeParse(receiptInput);
      const inventory = actual.baselineWebMcpInventoryV3Schema.safeParse(inventoryInput);
      const evidence = actual.baselineProductionEvidenceV3Schema.safeParse(evidenceInput);
      if (!receipt.success || !inventory.success || !evidence.success) {
        return { ok: false, errors: ["BASELINE_V3_INVALID"], verifiedBytes: {} };
      }
      return {
        ok: true,
        receipt: receipt.data,
        inventory: inventory.data,
        evidence: evidence.data,
        verifiedBytes: { exactSignedBaselineBytes: `sha256:${"6".repeat(64)}` },
      };
    },
  };
});

import baselineAuthoritySignatureJson from "../../../research/data/baseline-freeze-v3-authority-signature.json";
import baselineReceiptJson from "../../../research/data/baseline-freeze-v3.json";
import baselineEvidenceJson from "../../../research/data/baseline-production-evidence-v3.json";
import baselineInventoryJson from "../../../research/data/baseline-webmcp-inventory-v3.json";
import predecessorBindingSignatureJson from "../../../research/data/exp0001a-model-role-qualification-launch-binding-signature-v2.json";
import bindingSignatureJson from "../../../research/data/exp0001a-model-role-qualification-launch-binding-signature-v3.json";
import predecessorBindingJson from "../../../research/data/exp0001a-model-role-qualification-launch-binding-v2.json";
import bindingJson from "../../../research/data/exp0001a-model-role-qualification-launch-binding-v3.json";
import { hashCanonicalJson, type JsonValue } from "./provenance-crypto";
import {
  createExp0001aFullRunSuccessorReleaseCoordinatorV4,
  exp0001aFullRunSuccessorReleaseStateV4Schema,
  nextExp0001aFullRunSuccessorReleaseActionV4,
  verifyExp0001aFullRunSuccessorLaunchGateV4,
  type Exp0001aFullRunSuccessorLaunchEvidenceV4,
} from "./exp0001a-successor-runtime-v4";

const DIGEST = `sha256:${"c".repeat(64)}`;
const temporaryRoots: string[] = [];

function evidence(state = "pass"): Exp0001aFullRunSuccessorLaunchEvidenceV4 {
  return {
    checkedAt: "2026-09-02T00:00:00.000Z",
    signedQualificationResult: { state },
    productionBinding: bindingJson,
    productionBindingAuthoritySignature: bindingSignatureJson,
    predecessorProductionBinding: predecessorBindingJson,
    predecessorProductionBindingAuthoritySignature: predecessorBindingSignatureJson,
    baseline: {
      receipt: baselineReceiptJson,
      inventory: baselineInventoryJson,
      productionEvidence: baselineEvidenceJson,
      artifacts: { authoritySignature: baselineAuthoritySignatureJson },
    },
  };
}

function gate() {
  return verifyExp0001aFullRunSuccessorLaunchGateV4(evidence());
}

async function statePath() {
  const root = await mkdtemp(path.join(os.tmpdir(), "exp0001a-successor-v4-"));
  temporaryRoots.push(root);
  return path.join(root, "full-run-release-state.json");
}

function clock() {
  let value = Date.parse("2026-09-02T00:01:00.000Z");
  return () => new Date(value++).toISOString();
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("EXP-0001A full-run successor launch authority v4", () => {
  it("binds the actual qualification-v2 pass, current v3 production chain, exact roles, and frozen 48-entry schedule", () => {
    const verified = gate();
    expect(verified).toMatchObject({
      decision: "allow_full_48_sequential_assignments",
      production: {
        bindingDigest: "sha256:26d644dabf67b8f9d63011fdcd6d1af0c09069e67cb6977f3ac97eaa36f15688",
        baselineDigest: "sha256:6b0bfb2e944366f39102409c1d4a1e67cbf505b9f66587e299e6f11642ef661b",
      },
      schedule: { assignmentCount: 48 },
      rolePolicy: {
        author: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
        primaryReviewer: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        adjudicator: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        pairwiseVisualJudge: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      },
    });
    expect(verified.schedule.assignments.map((assignment) => assignment.plannedIndex))
      .toEqual([...Array(48).keys()]);
    for (let length = 1; length <= 48; length += 1) {
      const prefix = verified.schedule.assignments.slice(0, length);
      const balance = prefix.filter((item) => item.condition === "A1").length
        - prefix.filter((item) => item.condition === "A0").length;
      expect(Math.abs(balance)).toBeLessThanOrEqual(1);
    }
  });

  it("fails closed for a false/tampered qualification, wrong role/plan/binding, future evidence, and stripped gate brand", async () => {
    for (const state of ["tampered", "fail", "wrong-role", "wrong-plan", "wrong-binding", "future"]) {
      expect(() => verifyExp0001aFullRunSuccessorLaunchGateV4(evidence(state))).toThrow();
    }
    const serialized = JSON.parse(JSON.stringify(gate())) as ReturnType<typeof gate>;
    expect(() => createExp0001aFullRunSuccessorReleaseCoordinatorV4({
      filePath: path.join(os.tmpdir(), "must-not-create-successor-v4.json"),
      gate: serialized,
    })).toThrow("SUCCESSOR_V4_UNVERIFIED_LAUNCH_GATE");
  });
});

describe("EXP-0001A full-run successor release state v4", () => {
  it("persists each release exactly once, survives restart without reissue, and advances only after terminal evidence", async () => {
    const filePath = await statePath();
    const verified = gate();
    const now = clock();
    const first = createExp0001aFullRunSuccessorReleaseCoordinatorV4({ filePath, gate: verified, now });
    await first.initialize();
    const reserved = await first.reserveNextAssignment();
    expect(reserved.assignments[0]?.status).toBe("reserved");
    const release = await first.authorizeReservedAssignmentRelease();
    expect(release.state.assignmentReleaseCount).toBe(1);
    expect(await first.nextAction()).toMatchObject({
      kind: "await_assignment_terminal_or_reconciliation",
      releaseMayBeReissued: false,
    });
    await expect(first.authorizeReservedAssignmentRelease()).rejects.toThrow();

    const restarted = createExp0001aFullRunSuccessorReleaseCoordinatorV4({ filePath, gate: verified, now });
    await expect(restarted.initialize()).resolves.toMatchObject({ assignmentReleaseCount: 1 });
    await expect(restarted.nextAction()).resolves.toMatchObject({
      kind: "await_assignment_terminal_or_reconciliation",
      releaseMayBeReissued: false,
    });
    const terminal = await restarted.terminalizeReleasedAssignment({
      releaseAuthorizationDigest: release.releaseAuthorization.authorizationDigest,
      outcome: "failed",
      evidenceDigest: DIGEST,
    });
    expect(terminal.state).toMatchObject({
      currentAssignmentIndex: 1,
      assignmentReleaseCount: 1,
      terminalAssignmentCount: 1,
    });
    expect(await restarted.nextAction()).toMatchObject({
      kind: "reserve_next_assignment",
      assignment: { plannedIndex: 1 },
    });
  });

  it("pauses globally before a release, preserves the reservation, and treats an interrupted released attempt as terminal", async () => {
    const coordinator = createExp0001aFullRunSuccessorReleaseCoordinatorV4({
      filePath: await statePath(), gate: gate(), now: clock(),
    });
    await coordinator.initialize();
    await coordinator.reserveNextAssignment();
    const paused = await coordinator.pauseForUsageLimit({ observationDigest: DIGEST });
    expect(paused).toMatchObject({ phase: "paused_for_usage_limit", currentAssignmentIndex: 0 });
    expect(paused.assignments[0]?.status).toBe("reserved");
    await expect(coordinator.authorizeReservedAssignmentRelease()).rejects.toThrow();
    const resumed = await coordinator.resumeAfterUsageLimit({ resetObservationDigest: DIGEST });
    expect(resumed.assignments[0]?.status).toBe("reserved");

    const released = await coordinator.authorizeReservedAssignmentRelease();
    await expect(coordinator.pauseForUsageLimit({ observationDigest: DIGEST }))
      .rejects.toThrow("MUST_TERMINALIZE_BEFORE_PAUSE");
    const interrupted = await coordinator.terminalizeReleasedAssignment({
      releaseAuthorizationDigest: released.releaseAuthorization.authorizationDigest,
      outcome: "usage_limit_interrupted",
      evidenceDigest: DIGEST,
      usageLimitObservationDigest: DIGEST,
    });
    expect(interrupted.state).toMatchObject({
      phase: "paused_for_usage_limit",
      currentAssignmentIndex: 1,
      assignmentReleaseCount: 1,
      terminalAssignmentCount: 1,
    });
    expect(interrupted.terminalReceipt.usageLimitObservationDigest).toBe(DIGEST);
    await coordinator.resumeAfterUsageLimit({ resetObservationDigest: DIGEST });
    await expect(coordinator.nextAction()).resolves.toMatchObject({
      kind: "reserve_next_assignment",
      assignment: { plannedIndex: 1 },
    });
  });

  it("allows one concurrent release winner and reaches the immutable 48-attempt ceiling with 24/24 balance", async () => {
    const coordinator = createExp0001aFullRunSuccessorReleaseCoordinatorV4({
      filePath: await statePath(), gate: gate(), now: clock(),
    });
    await coordinator.initialize();
    await coordinator.reserveNextAssignment();
    const race = await Promise.allSettled([
      coordinator.authorizeReservedAssignmentRelease(),
      coordinator.authorizeReservedAssignmentRelease(),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const released = race.find((result) => result.status === "fulfilled")!;
    if (released.status !== "fulfilled") throw new Error("Expected one release winner.");
    let authorization = released.value.releaseAuthorization;
    for (let index = 0; index < 48; index += 1) {
      if (index > 0) {
        await coordinator.reserveNextAssignment();
        authorization = (await coordinator.authorizeReservedAssignmentRelease()).releaseAuthorization;
      }
      const terminal = await coordinator.terminalizeReleasedAssignment({
        releaseAuthorizationDigest: authorization.authorizationDigest,
        outcome: "succeeded",
        evidenceDigest: DIGEST,
      });
      expect(terminal.state.assignmentReleaseCount).toBe(index + 1);
      expect(Math.abs(
        terminal.state.releasedConditionCounts.A0 - terminal.state.releasedConditionCounts.A1,
      )).toBeLessThanOrEqual(1);
    }
    const finalState = await coordinator.read();
    expect(finalState).toMatchObject({
      phase: "complete",
      currentAssignmentIndex: 48,
      assignmentReleaseCount: 48,
      terminalAssignmentCount: 48,
      releasedConditionCounts: { A0: 24, A1: 24 },
    });
    expect(nextExp0001aFullRunSuccessorReleaseActionV4(finalState)).toEqual({
      kind: "all_48_assignments_terminal",
      releaseCount: 48,
      terminalCount: 48,
    });
    await expect(coordinator.reserveNextAssignment()).rejects.toThrow();
  }, 120_000);

  it("rejects a resealed counter forgery and an off-prefix assignment status", async () => {
    const coordinator = createExp0001aFullRunSuccessorReleaseCoordinatorV4({
      filePath: await statePath(), gate: gate(), now: clock(),
    });
    const state = await coordinator.initialize();
    const reseal = (content: Record<string, unknown>) => ({
      ...content,
      stateDigest: hashCanonicalJson(content as JsonValue),
    });
    const { stateDigest: _stateDigest, ...content } = state;
    void _stateDigest;
    expect(() => exp0001aFullRunSuccessorReleaseStateV4Schema.parse(reseal({
      ...content,
      assignmentReleaseCount: 1,
    }))).toThrow();
    const assignments = structuredClone(content.assignments);
    assignments[1]!.status = "reserved";
    assignments[1]!.reservedAt = "2026-09-02T00:02:00.000Z";
    expect(() => exp0001aFullRunSuccessorReleaseStateV4Schema.parse(reseal({
      ...content,
      assignments,
    }))).toThrow();
  });
});
