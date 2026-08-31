import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./codex-webmcp-spike", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-webmcp-spike")>();
  return {
    ...actual,
    assertCodexWebMcpAaExecutionAllowed: (gate: unknown) => {
      if ((gate as { testAuthority?: boolean } | null)?.testAuthority !== true) {
        throw new Error("TEST_SPIKE_AUTHORITY_REJECTED");
      }
      return gate;
    },
  };
});
vi.mock("./codex-webmcp-spike-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-webmcp-spike-recovery")>();
  return {
    ...actual,
    verifyExp0001aCodexSpikeRecoveryGate: (gate: unknown) => {
      if ((gate as { testAuthority?: boolean } | null)?.testAuthority !== true) {
        throw new Error("TEST_SPIKE_AUTHORITY_REJECTED");
      }
      return gate;
    },
  };
});

import { createExp0001aProvisioningCoordinator } from "./exp0001a-attempt-provisioning";
import {
  EXP0001A_CODEX_COORDINATOR_VERSION,
  createExp0001aCodexCoordinatorJournal,
  executeExp0001aCoordinatorLocalAction,
  ingestExp0001aCoordinatorActionResult,
  planNextExp0001aCodexCoordinatorAction,
  projectExp0001aArtifactPacketTerminalEvidence,
} from "./exp0001a-codex-coordinator";
import { pauseExp0001aCodexSchedulerForUsageLimit } from "./exp0001a-codex-accounting";
import { hashCanonicalJson } from "./provenance-crypto";

const TEST_EVIDENCE = { retainedByTestAuthority: true } as const;
const TEST_GATE = { testAuthority: true, evidenceDigest: hashCanonicalJson(TEST_EVIDENCE) } as const;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function initialState() {
  return (await initialHarness()).state;
}

async function initialHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "exp0001a-coordinator-"));
  roots.push(root);
  const coordinator = createExp0001aProvisioningCoordinator({
    filePath: path.join(root, "provisioning.json"),
    now: () => "2026-08-31T05:00:00.000Z",
    createRoomNonce: () => "rn_0123456789abcdef0123456789abcdef",
  });
  return { coordinator, state: await coordinator.initialize() };
}

function createRoomResult(input: Readonly<{ roomId: string; roomCode: string; title: string }>) {
  return {
    ok: true,
    tool: "create_room",
    data: {
      room: { id: input.roomId, code: input.roomCode, title: input.title },
      role: "participant",
      path: `/room/${input.roomId}`,
      recentRoom: {
        roomId: input.roomId,
        code: input.roomCode,
        title: input.title,
        role: "participant",
        lastOpenedAt: Date.parse("2026-08-31T05:00:00.000Z"),
      },
      recentReferenceStored: true,
      displayNameStored: true,
    },
  } as const;
}

describe("EXP-0001A Codex coordinator next-action boundary", () => {
  it("binds crash-recovered packet terminalization to the exact terminal reviewer lifecycle", () => {
    const digest = (character: string) => `sha256:${character.repeat(64)}`;
    const packet = {
      packetId: "primary-work-001-d1",
      startReceipt: { receiptDigest: digest("1") },
      sidecarReadyReceipt: { receiptDigest: digest("2") },
      envelopeDigest: digest("3"),
      subjectDigest: digest("4"),
    };
    const recoveryContent = {
      schemaVersion: "exp-0001a-artifact-packet-sidecar/v1" as const,
      kind: "artifact-packet-sidecar-terminal-crash-recovery" as const,
      packetId: packet.packetId,
      recoveredAt: "2026-08-31T05:00:09.000Z",
      taskLifecycleState: "terminal" as const,
      reason: "task-lifecycle-terminal-before-sidecar-stop-receipt" as const,
      crashReconciliationReceiptDigest: digest("5"),
      startReceiptDigest: packet.startReceipt.receiptDigest,
      readyReceiptDigest: packet.sidecarReadyReceipt.receiptDigest,
      reviewerEnvelopeDigest: packet.envelopeDigest,
      subjectDigest: packet.subjectDigest,
      serverProcessState: "confirmed_not_running" as const,
      packetAccessEvidence: "readiness_receipt_retained_runtime_counters_unavailable_after_crash" as const,
      reviewerEvidenceDisposition: "preserved_by_terminal_coordinator_task_lifecycle" as const,
    };
    const rawResult = {
      schemaVersion: "exp-0001a-artifact-packet-sidecar/v1",
      packetId: packet.packetId,
      state: "recovered_after_crash",
      recoveryReceipt: { ...recoveryContent, receiptDigest: hashCanonicalJson(recoveryContent) },
    };
    const projected = projectExp0001aArtifactPacketTerminalEvidence({
      packetLifecycle: packet,
      terminalTaskLifecycle: { state: "terminal", lifecycleDigest: digest("6") },
      rawResult,
    });
    expect(projected).toMatchObject({
      state: "recovered_after_crash",
      stopReceipt: null,
      terminalTaskLifecycleDigest: digest("6"),
      recoveryReceipt: { receiptDigest: rawResult.recoveryReceipt.receiptDigest },
    });
    expect(() => projectExp0001aArtifactPacketTerminalEvidence({
      packetLifecycle: packet,
      terminalTaskLifecycle: { state: "running", lifecycleDigest: digest("6") },
      rawResult,
    })).toThrow(/REQUIRES_EXACT_TERMINAL_TASK_LIFECYCLE/);
    expect(() => projectExp0001aArtifactPacketTerminalEvidence({
      packetLifecycle: { ...packet, sidecarReadyReceipt: { receiptDigest: digest("7") } },
      terminalTaskLifecycle: { state: "terminal", lifecycleDigest: digest("6") },
      rawResult,
    })).toThrow(/CRASH_RECOVERY_RESULT_BINDING_INVALID/);
  });

  it("binds unstarted packet crash recovery to the exact canonical create outcome", () => {
    const digest = (character: string) => `sha256:${character.repeat(64)}`;
    const packet = {
      packetId: "primary-work-001-unstarted",
      startReceipt: { receiptDigest: digest("1") },
      sidecarReadyReceipt: { receiptDigest: digest("2") },
      envelopeDigest: digest("3"),
      subjectDigest: digest("4"),
    };
    const cases = [
      {
        state: "not_started_usage_limited" as const,
        reason: "reviewer-create-usage-limited-before-task-begun" as const,
        disposition: "same_assignment_preserved_unstarted_for_usage_reset_retry" as const,
        conflictingState: "not_started_failed" as const,
      },
      {
        state: "not_started_failed" as const,
        reason: "reviewer-create-failed-before-task-begun" as const,
        disposition: "same_assignment_preserved_unstarted_for_create_retry" as const,
        conflictingState: "terminal" as const,
      },
    ];
    for (const item of cases) {
      const recoveryContent = {
        schemaVersion: "exp-0001a-artifact-packet-sidecar/v1" as const,
        kind: "artifact-packet-sidecar-unstarted-task-crash-recovery" as const,
        packetId: packet.packetId,
        recoveredAt: "2026-08-31T05:00:09.000Z",
        taskLifecycleState: item.state,
        reason: item.reason,
        crashReconciliationReceiptDigest: digest("5"),
        startReceiptDigest: packet.startReceipt.receiptDigest,
        readyReceiptDigest: packet.sidecarReadyReceipt.receiptDigest,
        reviewerEnvelopeDigest: packet.envelopeDigest,
        subjectDigest: packet.subjectDigest,
        serverProcessState: "confirmed_not_running" as const,
        packetAccessEvidence: "readiness_receipt_retained_runtime_counters_unavailable_after_crash" as const,
        reviewerEvidenceDisposition: item.disposition,
      };
      const rawResult = {
        schemaVersion: "exp-0001a-artifact-packet-sidecar/v1",
        packetId: packet.packetId,
        state: "recovered_after_crash",
        recoveryReceipt: { ...recoveryContent, receiptDigest: hashCanonicalJson(recoveryContent) },
      };
      expect(projectExp0001aArtifactPacketTerminalEvidence({
        packetLifecycle: packet,
        terminalTaskLifecycle: { state: item.state, lifecycleDigest: digest("6") },
        rawResult,
      })).toMatchObject({
        state: "recovered_after_crash",
        recoveryReceipt: {
          taskLifecycleState: item.state,
          reason: item.reason,
          reviewerEvidenceDisposition: item.disposition,
        },
      });
      expect(() => projectExp0001aArtifactPacketTerminalEvidence({
        packetLifecycle: packet,
        terminalTaskLifecycle: { state: item.conflictingState, lifecycleDigest: digest("7") },
        rawResult,
      })).toThrow(/CRASH_RECOVERY_RESULT_BINDING_INVALID/);

      const lyingContent = {
        ...recoveryContent,
        reason: "task-lifecycle-terminal-before-sidecar-stop-receipt",
      };
      expect(() => projectExp0001aArtifactPacketTerminalEvidence({
        packetLifecycle: packet,
        terminalTaskLifecycle: { state: item.state, lifecycleDigest: digest("6") },
        rawResult: {
          ...rawResult,
          recoveryReceipt: { ...lyingContent, receiptDigest: hashCanonicalJson(lyingContent) },
        },
      })).toThrow();
    }
  });

  it("projects the first local transition without releasing a brief or invoking a tool", async () => {
    expect(EXP0001A_CODEX_COORDINATOR_VERSION).toBe("exp-0001a-codex-coordinator/v2");
    const provisioningState = await initialState();
    const journal = createExp0001aCodexCoordinatorJournal({ provisioningState });
    expect(planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-31T05:00:00.000Z",
      provisioningState,
      journal,
    })).toMatchObject({
      kind: "perform_provisioning_local_transition",
      transition: "reserve_next_attempt",
      assignmentId: provisioningState.scheduler.assignments[0]?.assignmentId,
    });
  });

  it("rejects a journal projected from a different provisioning state", async () => {
    const provisioningState = await initialState();
    const journal = createExp0001aCodexCoordinatorJournal({ provisioningState });
    expect(() => planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-31T05:00:00.000Z",
      provisioningState: { ...provisioningState, stateDigest: `sha256:${"0".repeat(64)}` },
      journal,
    })).toThrow();
  });

  it("projects only the frozen neutral probe while the global scheduler is paused", async () => {
    const initial = await initialState();
    const scheduler = pauseExp0001aCodexSchedulerForUsageLimit(initial.scheduler, {
      observedAt: "2026-08-31T05:00:01.000Z",
      evidenceDigest: `sha256:${"a".repeat(64)}`,
    });
    const { stateDigest: _priorDigest, ...priorContent } = initial;
    void _priorDigest;
    const content = { ...priorContent, scheduler };
    const provisioningState = {
      ...content,
      stateDigest: hashCanonicalJson(content as Parameters<typeof hashCanonicalJson>[0]),
    };
    const journal = createExp0001aCodexCoordinatorJournal({ provisioningState });
    expect(planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-31T05:00:02.000Z",
      provisioningState,
      journal,
    })).toMatchObject({
      kind: "run_subscription_availability_probe",
      target: { type: "projectless" },
      createThreadCommand: {
        toolName: "mcp__codex_app__create_thread",
        arguments: {
          model: "gpt-5.6-sol",
          target: { type: "projectless" },
        },
      },
      benchmarkContentIncluded: false,
      mayReleaseExperimentBrief: false,
    });
  });

  it("executes the released create_room command exactly before baseline inspection", async () => {
    const { coordinator, state: initial } = await initialHarness();
    let provisioningState = initial;
    let coordinatorJournal = createExp0001aCodexCoordinatorJournal({ provisioningState });

    const reserveAction = planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-31T05:00:00.000Z",
      provisioningState,
      journal: coordinatorJournal,
    });
    expect(reserveAction).toMatchObject({ kind: "perform_provisioning_local_transition", transition: "reserve_next_attempt" });
    ({ provisioningState, coordinatorJournal } = await executeExp0001aCoordinatorLocalAction({
      action: reserveAction,
      provisioningState,
      coordinatorJournal,
      provisioningCoordinator: coordinator,
      spikeGate: TEST_GATE,
      spikeEvidence: TEST_EVIDENCE,
    }));

    const releaseAction = planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-31T05:00:01.000Z",
      provisioningState,
      journal: coordinatorJournal,
    });
    expect(releaseAction).toMatchObject({ kind: "release_reserved_create_room" });
    ({ provisioningState, coordinatorJournal } = await executeExp0001aCoordinatorLocalAction({
      action: releaseAction,
      provisioningState,
      coordinatorJournal,
      provisioningCoordinator: coordinator,
      spikeGate: TEST_GATE,
      spikeEvidence: TEST_EVIDENCE,
    }));

    const createAction = planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-31T05:00:02.000Z",
      provisioningState,
      journal: coordinatorJournal,
    });
    expect(createAction).toMatchObject({
      kind: "perform_provisioning_webmcp",
      session: "coordinator",
      command: { toolName: "create_room" },
      expectedIngest: { operation: "retainCreateRoomResult" },
      ambiguityReconciliation: {
        command: { toolName: "list_recent_rooms", input: {} },
        expectedIngest: { operation: "reconcileAmbiguousCreate" },
        createRetryAllowed: false,
      },
    });
    if (createAction.kind !== "perform_provisioning_webmcp") throw new Error("EXPECTED_CREATE_ROOM_ACTION");
    const title = (createAction.command.input as { title: string }).title;
    ({ provisioningState, coordinatorJournal } = await ingestExp0001aCoordinatorActionResult({
      action: createAction,
      rawResult: createRoomResult({ roomId: "room_genesis-test", roomCode: "ABC234", title }),
      observedAt: "2026-08-31T05:00:03.000Z",
      provisioningState,
      coordinatorJournal,
      provisioningCoordinator: coordinator,
    }));

    expect(planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-31T05:00:04.000Z",
      provisioningState,
      journal: coordinatorJournal,
    })).toMatchObject({
      kind: "perform_provisioning_webmcp",
      command: { toolName: "read_room_state", input: {} },
      expectedIngest: { operation: "retainBlankBaselineRead" },
    });
  });

  it("accepts only the committed private recent-room fallback after an ambiguous create result", async () => {
    const { coordinator, state: initial } = await initialHarness();
    let provisioningState = initial;
    let coordinatorJournal = createExp0001aCodexCoordinatorJournal({ provisioningState });
    for (const issuedAt of ["2026-08-31T05:01:00.000Z", "2026-08-31T05:01:01.000Z"]) {
      const action = planNextExp0001aCodexCoordinatorAction({ issuedAt, provisioningState, journal: coordinatorJournal });
      ({ provisioningState, coordinatorJournal } = await executeExp0001aCoordinatorLocalAction({
        action,
        provisioningState,
        coordinatorJournal,
        provisioningCoordinator: coordinator,
        spikeGate: TEST_GATE,
        spikeEvidence: TEST_EVIDENCE,
      }));
    }
    const createAction = planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-31T05:01:02.000Z",
      provisioningState,
      journal: coordinatorJournal,
    });
    if (createAction.kind !== "perform_provisioning_webmcp" || createAction.ambiguityReconciliation === null) {
      throw new Error("EXPECTED_CREATE_ROOM_ACTION_WITH_PRIVATE_FALLBACK");
    }
    const title = (createAction.command.input as { title: string }).title;
    ({ provisioningState, coordinatorJournal } = await ingestExp0001aCoordinatorActionResult({
      action: createAction,
      rawResult: {
        ok: true,
        tool: "list_recent_rooms",
        data: {
          scope: "current_browser_and_signed_session",
          rooms: [{
            roomId: "room_reconciled-test",
            code: "DEF567",
            title,
            role: "participant",
            lastOpenedAt: Date.parse("2026-08-31T05:01:03.000Z"),
          }],
        },
      },
      observedAt: "2026-08-31T05:01:03.000Z",
      provisioningState,
      coordinatorJournal,
      provisioningCoordinator: coordinator,
    }));
    expect(planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-31T05:01:04.000Z",
      provisioningState,
      journal: coordinatorJournal,
    })).toMatchObject({
      kind: "perform_provisioning_webmcp",
      command: { toolName: "read_room_state" },
      expectedIngest: { operation: "retainBlankBaselineRead" },
    });
  });
});
