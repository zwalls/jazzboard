// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/domain/errors";
import type { CanvasCommand, SemanticTransaction } from "@/lib/domain/types";

import {
  listAgentEditProposals,
  readAgentEditProposal,
  reviewAgentEditProposal,
  runActivityRevert,
  runCanvasCommand,
  runLayoutCommand,
  runLeaseAction,
  runSemanticTransaction,
  setAgentEditPolicy,
} from "./room-service";
import { getRoomStore } from "./room-store";

const START = new Date("2026-08-26T12:00:00.000Z");

function createTextCommand(id: string, content = id, x = 10): CanvasCommand {
  return {
    type: "create",
    object: {
      id,
      kind: "text",
      x,
      y: 20,
      width: 240,
      height: 80,
      rotation: 0,
      zIndex: 0,
      groupId: null,
      content,
      color: "black",
      size: "m",
      align: "start",
    },
  };
}

function updateTextCommand(id: string, expectedRevision: number, content: string): CanvasCommand {
  return {
    type: "update",
    objectId: id,
    expectedRevision,
    operation: "edit",
    patch: { content },
  };
}

async function seededRoom() {
  const store = getRoomStore();
  const created = await store.createRoom({
    participantId: "p_owner",
    displayName: "Owner",
    title: "Review policy room",
  });
  const room = await store.joinRoom({
    participantId: "p_spectator",
    displayName: "Sam",
    code: created.code,
    role: "spectator",
  });
  return { store, room };
}

async function expectDomainError(promise: Promise<unknown>, code: DomainError["code"]): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
    return error as DomainError;
  }
  throw new Error(`Expected ${code} to be thrown.`);
}

describe("server-authoritative agent edit review", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.stubEnv("REDIS_URL", "");
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
  });

  afterEach(() => {
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("defaults to live, lets an agent only tighten policy, and preserves spectator boundaries", async () => {
    const { room } = await seededRoom();
    expect(room).toMatchObject({ agentEditPolicy: "live", reviewProposals: [] });

    await expectDomainError(
      setAgentEditPolicy({
        roomId: room.id,
        participantId: "p_spectator",
        actorKind: "human",
        policy: "review",
      }),
      "FORBIDDEN",
    );

    const enabled = await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      policy: "review",
    });
    expect(enabled).toMatchObject({ policy: "review", changed: true });
    expect(enabled.room.participants.p_owner).toMatchObject({ agentActive: true, connected: true });

    await expectDomainError(
      setAgentEditPolicy({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "agent",
        policy: "live",
      }),
      "FORBIDDEN",
    );
    await expectDomainError(
      reviewAgentEditProposal({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "agent",
        proposalId: "missing",
        expectedProposalRevision: 1,
        action: "approve",
      }),
      "FORBIDDEN",
    );

    const disabled = await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      policy: "live",
    });
    expect(disabled).toMatchObject({ policy: "live", changed: true });
  });

  it("stores an exact agent request without mutating canvas, then applies it once with original attribution", async () => {
    const { store, room } = await seededRoom();
    await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      policy: "review",
    });
    const before = await store.getRoom(room.id);
    const command = createTextCommand("agent-note", "Original proposal");

    const proposed = await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      command,
      metadata: { intent: "Capture the API constraint", summary: "Add one review note" },
    });

    expect(proposed).toMatchObject({
      outcome: "proposed",
      changedObjectIds: [],
      changedDiagramIds: [],
      activity: null,
      proposal: {
        revision: 1,
        status: "pending",
        baselineRoomRevision: before?.roomRevision,
        author: { participantId: "p_owner", displayName: "Owner", kind: "agent" },
        intent: "Capture the API constraint",
        summary: "Add one review note",
        purpose: { kind: "canvas_command", objectIds: ["agent-note"] },
      },
    });
    if (proposed.outcome !== "proposed") throw new Error("Expected an agent proposal.");
    expect(proposed.room.objects).not.toHaveProperty("agent-note");
    expect(await store.listActivities(room.id)).toEqual([]);

    const spectatorList = await listAgentEditProposals({
      roomId: room.id,
      participantId: "p_spectator",
      status: "pending",
    });
    expect(spectatorList.proposals).toHaveLength(1);
    expect(spectatorList.proposals[0]).not.toHaveProperty("request");
    const exact = await readAgentEditProposal({
      roomId: room.id,
      participantId: "p_spectator",
      proposalId: proposed.proposal.id,
    });
    expect(exact.request).toEqual({ kind: "canvas_command", command });

    await store.joinRoom({
      participantId: "p_owner",
      displayName: "Renamed Owner",
      code: room.code,
      role: "participant",
    });
    const applied = await reviewAgentEditProposal({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      proposalId: proposed.proposal.id,
      expectedProposalRevision: 1,
      action: "approve",
      note: "Approved after checking scope",
    });
    if (applied.outcome !== "applied") throw new Error("Expected an approved edit.");

    expect(applied.room.objects["agent-note"]).toMatchObject({
      content: "Original proposal",
      revision: 1,
      createdBy: { participantId: "p_owner", displayName: "Owner", kind: "agent" },
      lastEditedBy: { participantId: "p_owner", displayName: "Owner", kind: "agent" },
    });
    expect(applied.activity).toMatchObject({
      actor: { participantId: "p_owner", displayName: "Owner", kind: "agent" },
      intent: "Capture the API constraint",
      summary: "Add one review note",
    });
    expect(applied.proposal).toMatchObject({
      status: "applied",
      revision: 2,
      review: {
        decision: "approved",
        reviewer: { participantId: "p_owner", displayName: "Renamed Owner", kind: "human" },
        note: "Approved after checking scope",
        activityId: applied.activity.id,
        appliedRoomRevision: applied.room.roomRevision,
      },
    });
    expect((await store.getActivity(room.id, applied.activity.id))?.actor).toMatchObject({
      displayName: "Owner",
      kind: "agent",
    });

    const humanLive = await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("human-note"),
    });
    expect(humanLive).toMatchObject({ outcome: "applied", proposal: null });
    expect(humanLive.room.objects).toHaveProperty("human-note");
  });

  it("gates semantic transactions and layouts behind the same exact proposal path", async () => {
    const { room } = await seededRoom();
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("left", "Left", 10),
    });
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("right", "Right", 500),
    });
    const policy = await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      policy: "review",
    });
    const transaction: SemanticTransaction = {
      commands: [createTextCommand("semantic", "From a template")],
      diagramCommands: [],
    };

    const semantic = await runSemanticTransaction({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      transaction,
      metadata: { intent: "Instantiate template" },
      expectedRoomRevision: policy.room.roomRevision,
    });
    expect(semantic).toMatchObject({
      outcome: "proposed",
      activity: null,
      proposal: { purpose: { kind: "semantic_transaction", objectIds: ["semantic"] } },
    });
    expect(semantic.room.objects).not.toHaveProperty("semantic");
    await expectDomainError(
      runSemanticTransaction({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "agent",
        transaction,
        expectedRoomRevision: policy.room.roomRevision,
      }),
      "REVISION_CONFLICT",
    );

    const layout = await runLayoutCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      layout: {
        layout: "flow",
        direction: "right",
        targets: [
          { objectId: "left", expectedRevision: 1 },
          { objectId: "right", expectedRevision: 1 },
        ],
        origin: { x: 100, y: 100 },
        primaryGap: 160,
        secondaryGap: 100,
      },
      metadata: { summary: "Arrange the approved nodes" },
    });
    expect(layout).toMatchObject({
      outcome: "proposed",
      positions: [],
      proposal: { purpose: { kind: "layout", layout: "flow", objectIds: ["left", "right"] } },
    });
    expect(layout.room.objects.left).toMatchObject({ x: 10, y: 20, revision: 1 });
    expect(layout.room.objects.right).toMatchObject({ x: 500, y: 20, revision: 1 });
  });

  it("keeps a proposal pending and commits nothing when approval finds a stale revision", async () => {
    const { store, room } = await seededRoom();
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("shared", "Version one"),
    });
    await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      policy: "review",
    });
    const proposed = await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      command: updateTextCommand("shared", 1, "Agent version"),
    });
    if (proposed.outcome !== "proposed") throw new Error("Expected a proposal.");
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: updateTextCommand("shared", 1, "Human version"),
    });
    const beforeRoom = await store.getRoom(room.id);
    const beforeActivities = await store.listActivities(room.id);

    await expectDomainError(
      reviewAgentEditProposal({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "human",
        proposalId: proposed.proposal.id,
        expectedProposalRevision: 1,
        action: "approve",
      }),
      "REVISION_CONFLICT",
    );

    const afterRoom = await store.getRoom(room.id);
    expect(afterRoom).toEqual(beforeRoom);
    expect(afterRoom?.objects.shared).toMatchObject({ content: "Human version", revision: 2 });
    expect(afterRoom?.reviewProposals[0]).toMatchObject({ status: "pending", revision: 1, review: null });
    expect(await store.listActivities(room.id)).toEqual(beforeActivities);
  });

  it("re-runs active-object lease validation during approval", async () => {
    const { store, room } = await seededRoom();
    await store.joinRoom({
      participantId: "p_editor",
      displayName: "Editor",
      code: room.code,
      role: "participant",
    });
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("leased", "Original"),
    });
    await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      policy: "review",
    });
    const proposed = await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      command: updateTextCommand("leased", 1, "Agent edit"),
    });
    if (proposed.outcome !== "proposed") throw new Error("Expected a proposal.");
    await runLeaseAction({
      action: "acquire",
      roomId: room.id,
      participantId: "p_editor",
      actorKind: "human",
      objectId: "leased",
      expectedRevision: 1,
      operation: "edit",
    });

    await expectDomainError(
      reviewAgentEditProposal({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "human",
        proposalId: proposed.proposal.id,
        expectedProposalRevision: 1,
        action: "approve",
      }),
      "OBJECT_BUSY",
    );
    expect((await store.getRoom(room.id))?.reviewProposals[0]).toMatchObject({ status: "pending", revision: 1 });
  });

  it("makes rejection human-attributable and rejects spectator or repeated decisions", async () => {
    const { store, room } = await seededRoom();
    await setAgentEditPolicy({ roomId: room.id, participantId: "p_owner", actorKind: "human", policy: "review" });
    const proposed = await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      command: createTextCommand("declined"),
    });
    if (proposed.outcome !== "proposed") throw new Error("Expected a proposal.");

    await expectDomainError(
      reviewAgentEditProposal({
        roomId: room.id,
        participantId: "p_spectator",
        actorKind: "human",
        proposalId: proposed.proposal.id,
        expectedProposalRevision: 1,
        action: "reject",
      }),
      "FORBIDDEN",
    );
    const rejected = await reviewAgentEditProposal({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      proposalId: proposed.proposal.id,
      expectedProposalRevision: 1,
      action: "reject",
      note: "Outside this diagram's scope",
    });
    expect(rejected).toMatchObject({
      outcome: "rejected",
      proposal: {
        status: "rejected",
        revision: 2,
        review: {
          decision: "rejected",
          reviewer: { participantId: "p_owner", kind: "human" },
          note: "Outside this diagram's scope",
          activityId: null,
          appliedRoomRevision: null,
        },
      },
    });
    expect(await store.listActivities(room.id)).toEqual([]);
    await expectDomainError(
      reviewAgentEditProposal({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "human",
        proposalId: proposed.proposal.id,
        expectedProposalRevision: 1,
        action: "approve",
      }),
      "REVISION_CONFLICT",
    );
  });

  it("queues agent compensating reverts and applies them forward only after approval", async () => {
    const { room } = await seededRoom();
    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: createTextCommand("revert-me", "Before"),
    });
    const updated = await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: updateTextCommand("revert-me", 1, "After"),
    });
    if (updated.outcome !== "applied") throw new Error("Expected a live update.");
    await setAgentEditPolicy({ roomId: room.id, participantId: "p_owner", actorKind: "human", policy: "review" });

    const proposed = await runActivityRevert({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      revert: {
        activityId: updated.activity.id,
        objectExpectations: [{ objectId: "revert-me", state: "present", expectedRevision: 2 }],
        diagramExpectations: [],
        metadata: { intent: "Restore approved wording" },
      },
    });
    if (proposed.outcome !== "proposed") throw new Error("Expected a revert proposal.");
    expect(proposed.room.objects["revert-me"]).toMatchObject({ content: "After", revision: 2 });
    expect(proposed.proposal.purpose.kind).toBe("activity_revert");

    const applied = await reviewAgentEditProposal({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      proposalId: proposed.proposal.id,
      expectedProposalRevision: 1,
      action: "approve",
    });
    if (applied.outcome !== "applied") throw new Error("Expected an approved revert.");
    expect(applied.room.objects["revert-me"]).toMatchObject({
      content: "Before",
      revision: 3,
      lastEditedBy: { participantId: "p_owner", kind: "agent" },
    });
    expect(applied.activity).toMatchObject({
      action: "canvas.revert",
      revertsActivityId: updated.activity.id,
      actor: { participantId: "p_owner", kind: "agent" },
    });
  });

  it("bounds an all-pending queue and leaves room state unchanged when it is full", async () => {
    const { store, room } = await seededRoom();
    await setAgentEditPolicy({ roomId: room.id, participantId: "p_owner", actorKind: "human", policy: "review" });
    for (let index = 0; index < 100; index += 1) {
      const proposed = await runCanvasCommand({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "agent",
        command: createTextCommand(`pending-${index}`),
      });
      expect(proposed.outcome).toBe("proposed");
    }
    const before = await store.getRoom(room.id);
    expect(before?.reviewProposals).toHaveLength(100);

    await expectDomainError(
      runCanvasCommand({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "agent",
        command: createTextCommand("overflow"),
      }),
      "INVALID_OPERATION",
    );
    expect(await store.getRoom(room.id)).toEqual(before);
  });
});
