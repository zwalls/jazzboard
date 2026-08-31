// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
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

import {
  assertExp0001aAuthorVisibleInputUnmodified,
  createExp0001aAttemptProvisioningPlan,
  createExp0001aProvisioningCoordinator,
  createExp0001aProvisioningScheduler,
  nextExp0001aProvisioningAction,
  projectNextExp0001aProvisioningAction,
  releaseNextExp0001aProvisioningAttempt,
  verifyExp0001aAuthorProvisioningHandoff,
  verifyExp0001aAttemptProvisioningPlan,
  verifyExp0001aRoomProvisioningReceipt,
  type Exp0001aAttemptProvisioningPlan,
  type Exp0001aAttemptProvisioningPlanSet,
  type Exp0001aProvisioningCoordinator,
  type Exp0001aRoomProvisioningReceipt,
} from "./exp0001a-attempt-provisioning";
import {
  beginNextExp0001aCodexAssignment,
  completeActiveExp0001aCodexAssignment,
  computeExp0001aCodexScheduleDigest,
  createExp0001aCodexScheduler,
  terminalizeActiveExp0001aCodexAssignment,
  type Exp0001aCodexSchedulerState,
} from "./exp0001a-codex-accounting";
import { hashCanonicalJson } from "./provenance-crypto";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const TEST_EVIDENCE = { retainedByTestAuthority: true } as const;
const TEST_GATE = { testAuthority: true, evidenceDigest: hashCanonicalJson(TEST_EVIDENCE) } as const;
const HOST_LAST_SEEN_MS = Date.parse("2026-08-30T22:00:00.000Z");

function schedulerAt(plan: Exp0001aAttemptProvisioningPlanSet, plannedIndex: number): Exp0001aCodexSchedulerState {
  let scheduler = createExp0001aCodexScheduler(plan.assignments);
  for (let index = 0; index < plannedIndex; index += 1) {
    const at = new Date(Date.parse("2026-08-30T20:00:00.000Z") + index * 3_000).toISOString();
    scheduler = beginNextExp0001aCodexAssignment(scheduler, {
      assignmentId: plan.assignments[index]!.assignmentId,
      begunAt: at,
      codexTaskId: `codex-${index}`,
      threadId: `thread-${index}`,
    });
    scheduler = completeActiveExp0001aCodexAssignment(scheduler, new Date(Date.parse(at) + 1_000).toISOString());
    scheduler = terminalizeActiveExp0001aCodexAssignment(scheduler, {
      terminalAt: new Date(Date.parse(at) + 2_000).toISOString(),
      outcome: "succeeded",
    });
  }
  return scheduler;
}

type Harness = {
  root: string;
  clock: { value: string };
  plan: Exp0001aAttemptProvisioningPlanSet;
  attempt: Exp0001aAttemptProvisioningPlan;
  coordinator: Exp0001aProvisioningCoordinator;
};

async function harness(
  kind?: "blank" | "fixture",
  nonce: string | (() => string) = "rn_0123456789abcdef0123456789abcdef",
): Promise<Harness> {
  const plan = createExp0001aAttemptProvisioningPlan();
  const attempt = kind === undefined
    ? plan.attempts[0]!
    : plan.attempts.find((candidate) => candidate.initialState.kind === kind)!;
  const root = await mkdtemp(path.join(os.tmpdir(), "exp0001a-provisioning-"));
  roots.push(root);
  const clock = { value: "2026-08-30T22:00:01.000Z" };
  const coordinator = createExp0001aProvisioningCoordinator({
    filePath: path.join(root, "coordinator.json"),
    plan,
    scheduler: schedulerAt(plan, attempt.plannedIndex),
    now: () => clock.value,
    createRoomNonce: typeof nonce === "string" ? () => nonce : nonce,
  });
  await coordinator.initialize();
  return { root, clock, plan, attempt, coordinator };
}

function presence(participantId: string, displayName: string, role: "participant" | "spectator") {
  return {
    participantId,
    displayName,
    color: "#123456",
    role,
    connected: true,
    agentActive: false,
    human: { cursor: null, viewport: null, lastSeenAt: HOST_LAST_SEEN_MS, activity: null },
    agent: { cursor: null, viewport: null, lastSeenAt: HOST_LAST_SEEN_MS, activity: null },
  };
}

function landingResult(
  tool: "create_room" | "join_room",
  input: { roomId: string; roomCode: string; title: string; role: "participant" | "spectator" },
) {
  return {
    ok: true,
    tool,
    data: {
      room: { id: input.roomId, code: input.roomCode, title: input.title },
      role: input.role,
      path: `/room/${input.roomId}`,
      recentRoom: {
        roomId: input.roomId,
        code: input.roomCode,
        title: input.title,
        role: input.role,
        lastOpenedAt: HOST_LAST_SEEN_MS,
      },
      recentReferenceStored: true,
      displayNameStored: true,
    },
  };
}

function roomRead(input: {
  roomId: string;
  roomCode: string;
  title: string;
  roomRevision: number;
  selfParticipantId: string;
  participants: ReturnType<typeof presence>[];
  objects?: Array<Record<string, unknown>>;
  diagrams?: Array<Record<string, unknown>>;
}) {
  return {
    ok: true,
    tool: "read_room_state",
    data: {
      room: {
        id: input.roomId,
        code: input.roomCode,
        title: input.title,
        roomRevision: input.roomRevision,
        selfParticipantId: input.selfParticipantId,
        agentEditPolicy: "direct",
        pendingAgentEditProposalCount: 0,
      },
      objects: input.objects ?? [],
      diagrams: input.diagrams ?? [],
      participants: input.participants,
      leases: [],
      spotlight: null,
    },
  };
}

function recordsFor(attempt: Exp0001aAttemptProvisioningPlan) {
  const temporaryReferences = Object.fromEntries(attempt.room.expectedSeedRecords.map((record, index) => [
    record.tempRef,
    `${record.recordKind}_${attempt.plannedIndex}_${index}`,
  ]));
  const objects = attempt.room.expectedSeedRecords
    .filter((record) => record.recordKind === "object")
    .map((record) => ({ id: temporaryReferences[record.tempRef]!, revision: 1 }));
  const diagrams = attempt.room.expectedSeedRecords
    .filter((record) => record.recordKind === "diagram")
    .map((record) => ({ id: temporaryReferences[record.tempRef]!, revision: 1 }));
  return { temporaryReferences, objects, diagrams };
}

async function driveToReceipt(
  h: Harness,
  options: {
    reconciliation?: boolean;
    preAuthorRevisionDelta?: number;
    extraPreAuthorObject?: boolean;
    inviteRoomId?: string;
    roomId?: string;
    roomCode?: string;
  } = {},
): Promise<Exp0001aRoomProvisioningReceipt> {
  const { attempt, coordinator } = h;
  const roomId = options.roomId ?? `room_attempt-${attempt.plannedIndex}`;
  const roomCode = options.roomCode ?? "ABC234";
  await coordinator.reserveNextAttempt({ spikeGate: TEST_GATE, spikeEvidence: TEST_EVIDENCE });
  const released = await coordinator.releaseReservedCreateRoomCommand(attempt.assignmentId);
  const title = released.createCommand.input.title;
  if (options.reconciliation) {
    await coordinator.reconcileAmbiguousCreate(attempt.assignmentId, {
      ok: true,
      tool: "list_recent_rooms",
      data: {
        scope: "current_browser_and_signed_session",
        rooms: [{ roomId, code: roomCode, title, role: "participant", lastOpenedAt: HOST_LAST_SEEN_MS }],
      },
    });
  } else {
    await coordinator.retainCreateRoomResult(attempt.assignmentId, landingResult("create_room", {
      roomId,
      roomCode,
      title,
      role: "participant",
    }));
  }
  const host = presence(`host_${attempt.plannedIndex}`, "Room host", "participant");
  const verifier = presence(`verifier_${attempt.plannedIndex}`, "Invite verifier", "spectator");
  const baselineRevision = 7;
  await coordinator.retainBlankBaselineRead(attempt.assignmentId, roomRead({
    roomId,
    roomCode,
    title,
    roomRevision: baselineRevision,
    selfParticipantId: host.participantId,
    participants: [host],
  }));
  const records = recordsFor(attempt);
  const seededRevision = attempt.room.seed === null ? baselineRevision : baselineRevision + 1;
  if (attempt.room.seed !== null) {
    await coordinator.retainSeedResult(attempt.assignmentId, {
      ok: true,
      tool: "apply_canvas_transaction",
      data: {
        outcome: "applied",
        roomRevision: seededRevision,
        temporaryReferences: records.temporaryReferences,
        changedObjectIds: records.objects.map((record) => record.id),
        changedDiagramIds: records.diagrams.map((record) => record.id),
        membershipObjectIds: [],
        positions: [],
        objects: records.objects,
        diagrams: records.diagrams,
        visualQuality: [],
        visualQualityOmittedDiagramIds: [],
        visualQualityOmittedDiagramCount: 0,
        visualQualityOmittedDiagramIdsTruncated: false,
        verification: { visualInspectionStatus: "not_performed" },
        activity: null,
        proposal: null,
      },
    });
  }
  const extra = options.extraPreAuthorObject ? [{ id: "object_extra", revision: 1 }] : [];
  const preAuthorRevision = seededRevision + (options.preAuthorRevisionDelta ?? 0);
  await coordinator.retainPreAuthorRead(attempt.assignmentId, roomRead({
    roomId,
    roomCode,
    title,
    roomRevision: preAuthorRevision,
    selfParticipantId: host.participantId,
    participants: [host],
    objects: [...records.objects, ...extra],
    diagrams: records.diagrams,
  }));
  const inviteRoomId = options.inviteRoomId ?? roomId;
  await coordinator.retainInviteJoinResult(attempt.assignmentId, landingResult("join_room", {
    roomId: inviteRoomId,
    roomCode,
    title,
    role: "spectator",
  }));
  await coordinator.retainInviteRead(attempt.assignmentId, roomRead({
    roomId,
    roomCode,
    title,
    roomRevision: preAuthorRevision,
    selfParticipantId: verifier.participantId,
    participants: [host, verifier],
    objects: [...records.objects, ...extra],
    diagrams: records.diagrams,
  }));
  await coordinator.retainCoordinatorPresenceRead(attempt.assignmentId, {
    ok: true,
    tool: "read_collaboration_state",
    data: {
      room: { id: roomId, code: roomCode, title, roomRevision: preAuthorRevision },
      session: { participantId: host.participantId, role: "participant", connected: true, agentActive: false },
      participants: [host, verifier],
      follow: { mode: "none", target: null, localTarget: null },
      spotlight: null,
    },
  });
  await coordinator.stopProvisionerPresenceRenewals(attempt.assignmentId);
  return (await coordinator.finalizeRoomReceipt(attempt.assignmentId)).receipt;
}

describe("EXP-0001A frozen provisioning plan and scheduler binding", () => {
  it("retains the exact 48-attempt schedule and only the scoped private reconciliation path", () => {
    const plan = createExp0001aAttemptProvisioningPlan();
    expect(plan.attempts).toHaveLength(48);
    expect(plan.scheduleDigest).toBe(computeExp0001aCodexScheduleDigest(plan.assignments));
    expect(createExp0001aProvisioningScheduler(plan).frozenScheduleDigest).toBe(plan.scheduleDigest);
    expect(verifyExp0001aAttemptProvisioningPlan(plan)).toMatchObject({ ok: true });
    for (const attempt of plan.attempts) {
      expect(attempt.room.readBlankBaseline.input).toEqual({});
      expect(attempt.room.reconcileAmbiguousCreate.toolName).toBe("list_recent_rooms");
      expect(attempt.room.verifyInviteJoin).toMatchObject({ toolName: "join_room", role: "spectator" });
      expect(attempt.room.prohibitedTools).toEqual(expect.arrayContaining(["list_rooms", "room_search"]));
      expect(attempt.room.prohibitedTools).not.toContain("list_recent_rooms");
    }
  });

  it("rejects a valid scheduler for any schedule other than the exact frozen plan", () => {
    const plan = createExp0001aAttemptProvisioningPlan();
    const assignments = plan.assignments.map((assignment, index) => index === 0
      ? { ...assignment, assignmentId: `${assignment.assignmentId}-other` }
      : assignment);
    const scheduler = createExp0001aCodexScheduler(assignments);
    expect(() => releaseNextExp0001aProvisioningAttempt({
      plan,
      scheduler,
      spikeGate: TEST_GATE,
      spikeEvidence: TEST_EVIDENCE,
    })).toThrow(/NOT_BOUND_TO_EXACT_PROVISIONING_PLAN/);
  });
});

describe("durable create reservation and raw WebMCP authority", () => {
  it("durably reserves before projecting create once with only a private-session ambiguity fallback", async () => {
    const h = await harness();
    const reserved = await h.coordinator.reserveNextAttempt({ spikeGate: TEST_GATE, spikeEvidence: TEST_EVIDENCE });
    expect(reserved.state.reservations[0]).toMatchObject({
      assignmentId: h.attempt.assignmentId,
      createReleasedAt: null,
      createRoom: null,
    });
    expect(nextExp0001aProvisioningAction(reserved.state)).toMatchObject({ kind: "release_reserved_create_room" });
    const released = await h.coordinator.releaseReservedCreateRoomCommand(h.attempt.assignmentId);
    expect(released).toMatchObject({
      session: "coordinator",
      retainMethod: "retainCreateRoomResult",
      ambiguousResultMethod: "reconcileAmbiguousCreate",
    });
    expect(released.createCommand.input.title).toContain("rn_0123456789abcdef0123456789abcdef");
    expect(nextExp0001aProvisioningAction(released.state)).toMatchObject({
      kind: "invoke_released_create_room",
      command: { toolName: "create_room", input: { title: released.createCommand.input.title } },
      ambiguityReconciliationCommand: { toolName: "list_recent_rooms", input: {} },
    });
    await expect(h.coordinator.releaseReservedCreateRoomCommand(h.attempt.assignmentId))
      .rejects.toThrow(/ALREADY_RELEASED_NO_RETRY/);
    await expect(h.coordinator.reconcileAmbiguousCreate(h.attempt.assignmentId, {
      ok: true,
      tool: "list_rooms",
      data: { rooms: [] },
    })).rejects.toThrow();
  });

  it("projects exact sessions, commands, and raw-result retention methods without bypassing one-shot create release", async () => {
    const h = await harness("blank");
    const initial = await h.coordinator.read();
    expect(projectNextExp0001aProvisioningAction(initial)).toMatchObject({
      kind: "coordinator_transition",
      coordinatorMethod: "reserveNextAttempt",
    });
    const reserved = await h.coordinator.reserveNextAttempt({ spikeGate: TEST_GATE, spikeEvidence: TEST_EVIDENCE });
    expect(projectNextExp0001aProvisioningAction(reserved.state)).toMatchObject({
      kind: "coordinator_transition",
      coordinatorMethod: "releaseReservedCreateRoomCommand",
    });
    const released = await h.coordinator.releaseReservedCreateRoomCommand(h.attempt.assignmentId);
    expect(projectNextExp0001aProvisioningAction(released.state)).toMatchObject({
      kind: "external_webmcp_command",
      actionKind: "invoke_released_create_room",
      session: "coordinator",
      command: { toolName: "create_room", input: { title: released.createCommand.input.title } },
      retainMethod: "retainCreateRoomResult",
      ambiguityReconciliation: {
        command: { toolName: "list_recent_rooms", input: {} },
        retainMethod: "reconcileAmbiguousCreate",
        createRetryAllowed: false,
      },
    });

    const roomId = "room_projected-1";
    const roomCode = "ABC234";
    const title = released.createCommand.input.title;
    await h.coordinator.retainCreateRoomResult(h.attempt.assignmentId, landingResult("create_room", {
      roomId, roomCode, title, role: "participant",
    }));
    let state = await h.coordinator.read();
    expect(projectNextExp0001aProvisioningAction(state)).toMatchObject({
      kind: "external_webmcp_command",
      actionKind: "retain_blank_baseline_read",
      session: "coordinator",
      command: { toolName: "read_room_state", input: {} },
      retainMethod: "retainBlankBaselineRead",
    });
    const host = presence("host_projected", "Room host", "participant");
    await h.coordinator.retainBlankBaselineRead(h.attempt.assignmentId, roomRead({
      roomId, roomCode, title, roomRevision: 0, selfParticipantId: host.participantId, participants: [host],
    }));
    await h.coordinator.retainPreAuthorRead(h.attempt.assignmentId, roomRead({
      roomId, roomCode, title, roomRevision: 0, selfParticipantId: host.participantId, participants: [host],
    }));
    state = await h.coordinator.read();
    expect(projectNextExp0001aProvisioningAction(state)).toMatchObject({
      kind: "external_webmcp_command",
      actionKind: "retain_invite_join_result",
      session: "invite_verifier",
      command: {
        toolName: "join_room",
        input: { code: roomCode, displayName: "Invite verifier", role: "spectator" },
      },
      retainMethod: "retainInviteJoinResult",
    });
  });

  it("reconciles an ambiguous create only to one exact opaque nonce in the private recent list", async () => {
    const h = await harness();
    await h.coordinator.reserveNextAttempt({ spikeGate: TEST_GATE, spikeEvidence: TEST_EVIDENCE });
    const released = await h.coordinator.releaseReservedCreateRoomCommand(h.attempt.assignmentId);
    const room = { roomId: "room_one", code: "ABC234", title: released.createCommand.input.title, role: "participant" as const, lastOpenedAt: HOST_LAST_SEEN_MS };
    await expect(h.coordinator.reconcileAmbiguousCreate(h.attempt.assignmentId, {
      ok: true,
      tool: "list_recent_rooms",
      data: { scope: "current_browser_and_signed_session", rooms: [room, { ...room, roomId: "room_two", code: "DEF567" }] },
    })).rejects.toThrow(/EXACT_PRIVATE_ROOM_NONCE/);
  });
});

describe("derived room receipt and exact canvas transition", () => {
  it.each(["blank", "fixture"] as const)("derives a %s receipt only from journaled exact tool results", async (kind) => {
    const h = await harness(kind);
    const receipt = await driveToReceipt(h, { reconciliation: kind === "blank" });
    expect(verifyExp0001aRoomProvisioningReceipt(receipt, h.attempt)).toEqual(receipt);
    expect(receipt.coordinatorJournalDigest).toMatch(/^sha256:/);
    expect(receipt.retainedAuthority.createResolution).toBe(kind === "blank"
      ? "private_recent_room_reconciliation" : "direct_result");
    expect(receipt.calls.inviteJoin).toMatchObject({ toolName: "join_room", session: "invite_verifier" });
    expect(receipt.blankBaseline.records).toEqual([]);
    expect(receipt.preAuthorState.records).toHaveLength(h.attempt.room.expectedSeedRecords.length);

    const restarted = createExp0001aProvisioningCoordinator({
      filePath: path.join(h.root, "coordinator.json"),
      plan: h.plan,
      scheduler: schedulerAt(h.plan, h.attempt.plannedIndex),
      now: () => h.clock.value,
      createRoomNonce: () => "rn_0123456789abcdef0123456789abcdef",
    });
    const recovered = await restarted.initialize();
    expect(recovered.reservations[0]?.receipt?.receiptDigest).toBe(receipt.receiptDigest);
  });

  it("rejects any extra mutation in a nominally blank transition", async () => {
    const h = await harness("blank");
    await expect(driveToReceipt(h, { preAuthorRevisionDelta: 1, extraPreAuthorObject: true }))
      .rejects.toThrow(/BLANK_ATTEMPT_CONTAINS_EXTRA_CANVAS_MUTATION/);
  });

  it("rejects any post-seed revision even when the declared records remain present", async () => {
    const h = await harness("fixture");
    await expect(driveToReceipt(h, { preAuthorRevisionDelta: 1 }))
      .rejects.toThrow(/SEED_TRANSITION_WAS_NOT_EXACTLY_ONE_ATOMIC_MUTATION/);
  });

  it("rejects a join result whose invite resolves to another room", async () => {
    const h = await harness("blank");
    await expect(driveToReceipt(h, { inviteRoomId: "room_wrong" }))
      .rejects.toThrow(/INVITE_JOIN_DID_NOT_RESOLVE_TO_RESERVED_ROOM/);
  });

  it("enforces room identity uniqueness in durable coordinator state", async () => {
    let nonceIndex = 0;
    const h = await harness(undefined, () => {
      nonceIndex += 1;
      return nonceIndex === 1
        ? "rn_0123456789abcdef0123456789abcdef"
        : "rn_fedcba9876543210fedcba9876543210";
    });
    await driveToReceipt(h, { roomId: "room_reused-room", roomCode: "ABC234" });
    const nextScheduler = schedulerAt(h.plan, h.attempt.plannedIndex + 1);
    await h.coordinator.synchronizeScheduler(nextScheduler);
    const second = h.plan.attempts[h.attempt.plannedIndex + 1]!;
    await h.coordinator.reserveNextAttempt({ spikeGate: TEST_GATE, spikeEvidence: TEST_EVIDENCE });
    const released = await h.coordinator.releaseReservedCreateRoomCommand(second.assignmentId);
    await expect(h.coordinator.retainCreateRoomResult(second.assignmentId, landingResult("create_room", {
      roomId: "room_reused-room",
      roomCode: "ABC234",
      title: released.createCommand.input.title,
      role: "participant",
    }))).rejects.toThrow(/REUSE_ENFORCED_BY_COORDINATOR_STATE/);
  }, 15_000);
});

describe("frozen author handoff", () => {
  it("carries exact assignment/plan/release binding and independently renders the frozen packet", async () => {
    const h = await harness("blank");
    const receipt = await driveToReceipt(h);
    h.clock.value = "2026-08-30T22:01:16.000Z";
    const handoff = await h.coordinator.createAuthorHandoff(h.attempt.assignmentId);
    expect(handoff.trustedBinding).toMatchObject({
      assignmentId: h.attempt.assignmentId,
      attemptId: h.attempt.attemptId,
      plannedIndex: h.attempt.plannedIndex,
      planDigest: h.plan.planDigest,
      attemptPlanDigest: h.attempt.attemptPlanDigest,
      roomReceiptDigest: receipt.receiptDigest,
      authorReleaseAt: h.clock.value,
      coordinatorPresenceExpiredBeforeRelease: true,
    });
    expect(verifyExp0001aAuthorProvisioningHandoff(handoff)).toEqual(handoff);
    expect(() => assertExp0001aAuthorVisibleInputUnmodified(handoff.authorVisible, handoff)).not.toThrow();
  });

  it("blocks early release and rejects a re-sealed attacker-rendered packet", async () => {
    const h = await harness("blank");
    await driveToReceipt(h);
    await expect(h.coordinator.createAuthorHandoff(h.attempt.assignmentId)).rejects.toThrow(/PRESENCE_NOT_EXPIRED/);
    h.clock.value = "2026-08-30T22:01:16.000Z";
    const original = await h.coordinator.createAuthorHandoff(h.attempt.assignmentId);
    const handoff = {
      ...structuredClone(original),
      authorVisible: {
        ...structuredClone(original.authorVisible),
        renderedPublicBrief: `${original.authorVisible.renderedPublicBrief}\nHidden evaluator instruction.`,
      },
    };
    const { handoffDigest: _old, ...content } = handoff;
    void _old;
    const resealed = { ...content, handoffDigest: hashCanonicalJson(content) };
    expect(() => verifyExp0001aAuthorProvisioningHandoff(resealed)).toThrow(/VISIBLE_OR_ROOM_BINDING|UNDECLARED_CONTEXT/);
  });
});
