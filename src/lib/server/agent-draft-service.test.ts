// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StageAgentCanvasDraftRequest } from "@/lib/agent-drafts/types";
import { DomainError } from "@/lib/domain/errors";

import {
  type AgentCanvasDraftStore,
  MemoryAgentCanvasDraftStore,
  resetMemoryAgentCanvasDraftStoreForTests,
  setAgentCanvasDraftStoreForTests,
} from "./agent-draft-store";
import {
  commitAgentCanvasDraft,
  discardAgentCanvasDraft,
  listAgentCanvasDrafts,
  readAgentCanvasDraft,
  replaceAgentCanvasDraft,
  stageAgentCanvasDraft,
} from "./agent-draft-service";
import { getRoomStore } from "./room-store";
import {
  renameRoom,
  reviewAgentEditProposal,
  runCanvasCommand,
  setAgentEditPolicy,
} from "./room-service";

const NOW = new Date("2027-01-12T10:00:00.000Z").getTime();

function stageRequest(roomRevision: number): StageAgentCanvasDraftRequest {
  return {
    draftId: "draft_service",
    baselineRoomRevision: roomRevision,
    transaction: {
      commands: [{
        type: "create",
        object: {
          id: "draft_note",
          kind: "text",
          x: 20,
          y: 30,
          width: 220,
          height: 80,
          rotation: 0,
          zIndex: 0,
          groupId: null,
          content: "Progressive draft",
          color: "black",
          size: "m",
          align: "start",
        },
      }],
      diagramCommands: [],
    },
    temporaryReferences: { note: "draft_note" },
    metadata: { intent: "Show work progressively" },
  };
}

async function seedRoom() {
  const store = getRoomStore();
  const created = await store.createRoom({
    participantId: "p_owner",
    displayName: "Owner",
    title: "Draft room",
  });
  const room = await store.joinRoom({
    participantId: "p_spectator",
    displayName: "Viewer",
    code: created.code,
    role: "spectator",
  });
  return { store, room };
}

function faultInjectingStore(
  delegate: AgentCanvasDraftStore,
  failures: { remove?: number; markAwaitingReview?: number },
): AgentCanvasDraftStore {
  let removeFailures = failures.remove ?? 0;
  let markFailures = failures.markAwaitingReview ?? 0;
  return new Proxy(delegate, {
    get(target, property) {
      if (property === "remove") {
        return async (...args: Parameters<AgentCanvasDraftStore["remove"]>) => {
          if (removeFailures > 0) {
            removeFailures -= 1;
            throw new Error("Injected draft removal failure");
          }
          return target.remove(...args);
        };
      }
      if (property === "markAwaitingReview") {
        return async (...args: Parameters<AgentCanvasDraftStore["markAwaitingReview"]>) => {
          if (markFailures > 0) {
            markFailures -= 1;
            throw new Error("Injected awaiting-review transition failure");
          }
          return target.markAwaitingReview(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("agent canvas draft service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("REDIS_URL", "");
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    resetMemoryAgentCanvasDraftStoreForTests();
  });

  afterEach(() => {
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    resetMemoryAgentCanvasDraftStoreForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("previews create-only work without changing room planes, leases, or history", async () => {
    const { store, room } = await seedRoom();
    const before = await store.getRoom(room.id);
    const beforeActivities = await store.listActivities(room.id);

    const draft = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(room.roomRevision),
      now: NOW + 1,
    });
    const after = await store.getRoom(room.id);

    expect(draft).toMatchObject({
      id: "draft_service",
      revision: 1,
      status: "active",
      temporaryReferences: { note: "draft_note" },
      previewObjects: [{ id: "draft_note", authority: "draft", revision: 1 }],
    });
    expect(draft).not.toHaveProperty("transaction");
    expect(draft).not.toHaveProperty("committing");
    expect(draft).not.toHaveProperty("authoritativeCommit");
    expect(after?.roomRevision).toBe(before?.roomRevision);
    expect(after?.stateRevision).toBe(before?.stateRevision);
    expect(after?.objects).toEqual(before?.objects);
    expect(after?.leases).toEqual(before?.leases);
    expect(await store.listActivities(room.id)).toEqual(beforeActivities);
  });

  it("allows authorized spectators to list and read, while denying spectator writes", async () => {
    const { room } = await seedRoom();
    await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(room.roomRevision),
    });

    await expect(listAgentCanvasDrafts({ roomId: room.id, participantId: "p_spectator" }))
      .resolves.toMatchObject({ drafts: [{ id: "draft_service" }] });
    await expect(readAgentCanvasDraft({
      roomId: room.id,
      draftId: "draft_service",
      participantId: "p_spectator",
    })).resolves.toMatchObject({ draft: { id: "draft_service" } });
    await expect(stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_spectator",
      request: { ...stageRequest(room.roomRevision), draftId: "draft_spectator" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects non-create operations and invalid temp-ref candidate identities", async () => {
    const { room } = await seedRoom();
    const invalidUpdate = stageRequest(room.roomRevision);
    invalidUpdate.transaction = {
      commands: [{
        type: "update",
        objectId: "existing",
        expectedRevision: 1,
        operation: "edit",
        patch: { color: "red" },
      }],
      diagramCommands: [],
    };
    await expect(stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: invalidUpdate,
    })).rejects.toMatchObject({ code: "INVALID_OPERATION" });

    await expect(stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: { ...stageRequest(room.roomRevision), temporaryReferences: { missing: "not_created" } },
    })).rejects.toMatchObject({ code: "INVALID_OPERATION" });
  });

  it("re-previews with exact CAS and commits once through the authoritative transaction", async () => {
    const { store, room } = await seedRoom();
    const first = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(room.roomRevision),
    });
    const replacement = stageRequest(room.roomRevision);
    replacement.transaction.commands[0] = {
      ...replacement.transaction.commands[0],
      object: {
        ...(replacement.transaction.commands[0] as { type: "create"; object: Record<string, unknown> }).object,
        content: "Refined draft",
      },
    } as typeof replacement.transaction.commands[number];
    const second = await replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: first.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: first.revision,
        baselineRoomRevision: room.roomRevision,
        transaction: replacement.transaction,
        temporaryReferences: replacement.temporaryReferences,
      },
    });
    expect(second).toMatchObject({ revision: 2, previewObjects: [{ content: "Refined draft" }] });

    const committed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: first.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: second.revision },
    });
    expect(committed).toMatchObject({ outcome: "applied", draft: null });
    expect((await store.getRoom(room.id))?.objects.draft_note).toMatchObject({ content: "Refined draft" });
    expect((await listAgentCanvasDrafts({ roomId: room.id, participantId: "p_owner" })).drafts).toEqual([]);
  });

  it("reserves temporary-reference identities across omitted and reintroduced candidates", async () => {
    const { room } = await seedRoom();
    const initial = stageRequest(room.roomRevision);
    initial.transaction.commands.push({
      type: "create",
      object: {
        id: "draft_second",
        kind: "text",
        x: 300,
        y: 30,
        width: 220,
        height: 80,
        rotation: 0,
        zIndex: 1,
        groupId: null,
        content: "Second candidate",
        color: "black",
        size: "m",
        align: "start",
      },
    });
    initial.temporaryReferences.second = "draft_second";
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: initial,
    });

    const omitted = await replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: staged.revision,
        baselineRoomRevision: room.roomRevision,
        transaction: stageRequest(room.roomRevision).transaction,
        temporaryReferences: { note: "draft_note" },
      },
    });
    expect(omitted.temporaryReferences).toEqual({ note: "draft_note", second: "draft_second" });
    expect(omitted.previewObjects.map((object) => object.id)).toEqual(["draft_note"]);

    const reintroduced = await replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: omitted.revision,
        baselineRoomRevision: room.roomRevision,
        transaction: initial.transaction,
        temporaryReferences: { second: "draft_second" },
      },
    });
    expect(reintroduced.temporaryReferences).toEqual({ note: "draft_note", second: "draft_second" });
    expect(reintroduced.previewObjects.map((object) => object.id)).toEqual(["draft_note", "draft_second"]);

    const remapped = structuredClone(initial.transaction);
    const second = remapped.commands[1];
    if (second?.type !== "create") throw new Error("Expected the second create command.");
    second.object.id = "draft_remapped";
    await expect(replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: reintroduced.revision,
        baselineRoomRevision: room.roomRevision,
        transaction: remapped,
        temporaryReferences: { second: "draft_remapped" },
      },
    })).rejects.toMatchObject({ code: "INVALID_OPERATION" });
  });

  it("restores an editable draft at a newer revision after an authoritative conflict", async () => {
    const { room } = await seedRoom();
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(room.roomRevision),
    });
    await renameRoom(room.id, "p_owner", "Changed room", room.title);

    await expect(commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const restored = await readAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
    });
    expect(restored.draft).toMatchObject({ status: "active", revision: 3 });
  });

  it("uses persisted commit evidence after cleanup failure even when the canonical object is deleted", async () => {
    const { store, room } = await seedRoom();
    const sidecar = new MemoryAgentCanvasDraftStore();
    setAgentCanvasDraftStoreForTests(faultInjectingStore(sidecar, { remove: 1 }));
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(room.roomRevision),
    });

    const committed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
    });
    expect(committed).toMatchObject({
      outcome: "applied",
      draft: null,
      sidecarStatus: "cleanup_pending",
    });
    expect((await store.getRoom(room.id))?.objects.draft_note).toBeDefined();
    await expect(sidecar.get(room.id, staged.id)).resolves.toMatchObject({
      status: "committing",
      authoritativeCommit: {
        roomRevision: committed.mutation.room.roomRevision,
      },
    });

    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: {
        type: "delete",
        targets: [{ objectId: "draft_note", expectedRevision: 1 }],
      },
    });
    expect((await store.getRoom(room.id))?.objects.draft_note).toBeUndefined();

    await expect(listAgentCanvasDrafts({ roomId: room.id, participantId: "p_owner" }))
      .resolves.toMatchObject({ drafts: [] });
    await expect(sidecar.get(room.id, staged.id)).resolves.toBeNull();

    const currentRoom = await store.getRoom(room.id);
    if (!currentRoom) throw new Error("Expected the reconciled room.");
    const next = stageRequest(currentRoom.roomRevision);
    next.draftId = "draft_after_cleanup";
    const create = next.transaction.commands[0];
    if (create?.type !== "create") throw new Error("Expected a create command.");
    create.object.id = "draft_note_after_cleanup";
    next.temporaryReferences = { note: "draft_note_after_cleanup" };
    await expect(stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: next,
    })).resolves.toMatchObject({ id: "draft_after_cleanup" });
  });

  it("returns canonical proposed success and heals a failed awaiting-review transition", async () => {
    const { room } = await seedRoom();
    const review = await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      policy: "review",
    });
    const sidecar = new MemoryAgentCanvasDraftStore();
    setAgentCanvasDraftStoreForTests(faultInjectingStore(sidecar, { markAwaitingReview: 1 }));
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(review.room.roomRevision),
    });

    const committed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
    });
    expect(committed).toMatchObject({
      outcome: "proposed",
      sidecarStatus: "cleanup_pending",
      draft: {
        status: "awaiting_review",
        revision: 3,
        expiresAt: staged.hardExpiresAt,
      },
    });
    if (committed.mutation.outcome !== "proposed") throw new Error("Expected a proposal.");
    await expect(sidecar.get(room.id, staged.id)).resolves.toMatchObject({ status: "committing", revision: 2 });

    const reconciled = await listAgentCanvasDrafts({ roomId: room.id, participantId: "p_owner" });
    expect(reconciled.drafts).toMatchObject([{
      status: "awaiting_review",
      revision: 3,
      awaitingReview: { proposalId: committed.mutation.proposal.id },
    }]);
    await expect(sidecar.get(room.id, staged.id)).resolves.toMatchObject({
      status: "awaiting_review",
      revision: 3,
      awaitingReview: { proposalId: committed.mutation.proposal.id },
    });
  });

  it("keeps a proposed draft visible and immutable while it awaits review", async () => {
    const { room } = await seedRoom();
    const review = await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      policy: "review",
    });
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(review.room.roomRevision),
    });
    const committed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
    });

    expect(committed).toMatchObject({
      outcome: "proposed",
      draft: {
        status: "awaiting_review",
        revision: 3,
        awaitingReview: { proposalId: expect.stringMatching(/^proposal_/) },
      },
    });
    await expect(replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: 3,
        baselineRoomRevision: committed.mutation.room.roomRevision,
        transaction: stageRequest(1).transaction,
        temporaryReferences: { note: "draft_note" },
      },
    })).rejects.toBeInstanceOf(DomainError);
    await expect(discardAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: 3 },
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it.each([
    ["approve", "applied"],
    ["reject", "rejected"],
  ] as const)("passively removes an awaiting draft after review is %s", async (action, expectedOutcome) => {
    const { room } = await seedRoom();
    const review = await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      policy: "review",
    });
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(review.room.roomRevision),
    });
    const proposed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
    });
    if (proposed.mutation.outcome !== "proposed") throw new Error("Expected a review proposal.");

    const reviewed = await reviewAgentEditProposal({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      proposalId: proposed.mutation.proposal.id,
      expectedProposalRevision: proposed.mutation.proposal.revision,
      action,
    });
    expect(reviewed.outcome).toBe(expectedOutcome);

    await expect(listAgentCanvasDrafts({ roomId: room.id, participantId: "p_owner" }))
      .resolves.toMatchObject({ drafts: [] });
    await expect(readAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
    })).rejects.toMatchObject({ code: "INVALID_OPERATION" });
  });
});
