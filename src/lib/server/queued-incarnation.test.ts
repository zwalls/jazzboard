// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/domain/errors";
import type { CanvasCommand } from "@/lib/domain/types";

import {
  reviewAgentEditProposal,
  runActivityRevert,
  runCanvasCommand,
  runLayoutCommand,
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

describe("queued edit incarnation guards", () => {
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

  it.each(["update", "delete", "layout", "semantic"] as const)("rejects stale %s proposal against a recreated revision-one object", async (kind) => {
    const { store, room } = await seededRoom();
    const base = { roomId: room.id, participantId: "p_owner" };
    await runCanvasCommand({ ...base, actorKind: "human", command: createTextCommand("reused", "Original") });
    await setAgentEditPolicy({ ...base, actorKind: "human", policy: "review" });
    const target = { objectId: "reused", expectedRevision: 1 };
    const proposed = kind === "layout"
      ? await runLayoutCommand({ ...base, actorKind: "agent", layout: { layout: "grid", direction: "right", targets: [target] } })
      : kind === "semantic"
        ? await runSemanticTransaction({ ...base, actorKind: "agent", transaction: { commands: [updateTextCommand("reused", 1, "Agent intended original")], diagramCommands: [] } })
        : await runCanvasCommand({ ...base, actorKind: "agent", command: kind === "delete" ? { type: "delete", targets: [target] } : updateTextCommand("reused", 1, "Agent intended original") });
    if (proposed.outcome !== "proposed") throw new Error("Expected a proposal");
    await runCanvasCommand({ ...base, actorKind: "human", command: { type: "delete", targets: [target] } });
    await runCanvasCommand({ ...base, actorKind: "human", command: createTextCommand("reused", "Replacement") });
    const before = await store.getRoom(room.id);
    const history = await store.listActivities(room.id);
    await expectDomainError(reviewAgentEditProposal({ ...base, actorKind: "human", proposalId: proposed.proposal.id, expectedProposalRevision: 1, action: "approve" }), "REVISION_CONFLICT");
    expect(await store.getRoom(room.id)).toEqual(before);
    expect(await store.listActivities(room.id)).toEqual(history);
    expect(before?.reviewProposals[0]).toMatchObject({ status: "pending", revision: 1, review: null });
  });
  it("protects a recreated Diagram from a queued metadata update", async () => {
    const { store, room } = await seededRoom();
    const base = { roomId: room.id, participantId: "p_owner" };
    const createDiagram = (title: string) => runSemanticTransaction({ ...base, actorKind: "human", transaction: {
      commands: [], diagramCommands: [{ type: "diagram.create", diagram: { id: "reused-diagram", title,
        description: "Synthetic metadata", diagramType: "flow", category: null, tags: [], memberObjectIds: [], connectorIds: [] } }],
    } });
    const original = await createDiagram("Original");
    if (original.outcome !== "applied") throw new Error("Expected a diagram");
    await setAgentEditPolicy({ ...base, actorKind: "human", policy: "review" });
    const proposed = await runSemanticTransaction({ ...base, actorKind: "agent", transaction: {
      commands: [], diagramCommands: [{ type: "diagram.update", diagramId: "reused-diagram", expectedRevision: 1, patch: { title: "Agent intended original" } }],
    } });
    if (proposed.outcome !== "proposed") throw new Error("Expected a proposal");
    await runActivityRevert({ ...base, actorKind: "human", revert: { activityId: original.activity.id,
      objectExpectations: [], diagramExpectations: [{ diagramId: "reused-diagram", state: "present", expectedRevision: 1 }] } });
    await createDiagram("Replacement");
    const before = await store.getRoom(room.id);
    const history = await store.listActivities(room.id);
    await expectDomainError(reviewAgentEditProposal({ ...base, actorKind: "human", proposalId: proposed.proposal.id, expectedProposalRevision: 1, action: "approve" }), "REVISION_CONFLICT");
    expect(await store.getRoom(room.id)).toEqual(before);
    expect(await store.listActivities(room.id)).toEqual(history);
  });

  it("allows unrelated edits and other proposals while preserving the reviewed target", async () => {
    const { room } = await seededRoom();
    const base = { roomId: room.id, participantId: "p_owner" };
    await runCanvasCommand({ ...base, actorKind: "human", command: createTextCommand("target", "Original") });
    await setAgentEditPolicy({ ...base, actorKind: "human", policy: "review" });
    const proposed = await runCanvasCommand({ ...base, actorKind: "agent", command: updateTextCommand("target", 1, "Approved") });
    if (proposed.outcome !== "proposed") throw new Error("Expected a proposal");
    await runCanvasCommand({ ...base, actorKind: "human", command: createTextCommand("unrelated", "Keep me") });
    const other = await runCanvasCommand({ ...base, actorKind: "agent", command: createTextCommand("other-proposal", "Still pending") });
    if (other.outcome !== "proposed") throw new Error("Expected the other proposal");
    const applied = await reviewAgentEditProposal({ ...base, actorKind: "human", proposalId: proposed.proposal.id, expectedProposalRevision: 1, action: "approve" });
    expect(applied.room.objects.target).toMatchObject({ content: "Approved", revision: 2 });
    expect(applied.room.objects.unrelated).toMatchObject({ content: "Keep me", revision: 1 });
    expect(applied.room.reviewProposals.find((item) => item.id === other.proposal.id)).toMatchObject({ status: "pending", revision: 1 });
    expect(proposed.proposal).not.toHaveProperty("targetGuards");
  });

  it("retains later unrelated Diagram membership when approving an unchanged label target", async () => {
    const { room } = await seededRoom();
    const base = { roomId: room.id, participantId: "p_owner" };
    await runCanvasCommand({ ...base, actorKind: "human", command: createTextCommand("target", "Original") });
    await setAgentEditPolicy({ ...base, actorKind: "human", policy: "review" });
    const proposed = await runCanvasCommand({ ...base, actorKind: "agent", command: updateTextCommand("target", 1, "Approved") });
    if (proposed.outcome !== "proposed") throw new Error("Expected a proposal");
    await runSemanticTransaction({ ...base, actorKind: "human", transaction: { commands: [], diagramCommands: [{ type: "diagram.create", diagram: {
      id: "unrelated-membership", title: "Keep membership", description: "Synthetic metadata", diagramType: "flow", category: null, tags: [], memberObjectIds: ["target"], connectorIds: [],
    } }] } });
    const applied = await reviewAgentEditProposal({ ...base, actorKind: "human", proposalId: proposed.proposal.id, expectedProposalRevision: 1, action: "approve" });
    expect(applied.room.objects.target).toMatchObject({ content: "Approved", revision: 2, diagramIds: ["unrelated-membership"] });
    expect(applied.room.diagrams["unrelated-membership"].memberObjectIds).toEqual(["target"]);
  });
  it("keeps legacy unguarded proposals pending and available to reject", async () => {
    const { store, room } = await seededRoom();
    const base = { roomId: room.id, participantId: "p_owner" };
    await runCanvasCommand({ ...base, actorKind: "human", command: createTextCommand("legacy", "Original") });
    await setAgentEditPolicy({ ...base, actorKind: "human", policy: "review" });
    const proposed = await runCanvasCommand({ ...base, actorKind: "agent", command: updateTextCommand("legacy", 1, "Old request") });
    if (proposed.outcome !== "proposed") throw new Error("Expected a proposal");
    await store.transact(room.id, (stored) => {
      delete stored.reviewProposals[0].targetGuards;
      return { room: stored, result: null };
    });
    const before = await store.getRoom(room.id);
    await expectDomainError(reviewAgentEditProposal({ ...base, actorKind: "human", proposalId: proposed.proposal.id, expectedProposalRevision: 1, action: "approve" }), "REVISION_CONFLICT");
    expect(await store.getRoom(room.id)).toEqual(before);
    const rejected = await reviewAgentEditProposal({ ...base, actorKind: "human", proposalId: proposed.proposal.id, expectedProposalRevision: 1, action: "reject" });
    expect(rejected.outcome).toBe("rejected");
    expect(rejected.room.objects.legacy).toMatchObject({ content: "Original", revision: 1 });
  });
});
