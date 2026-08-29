// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";

import type { AgentCanvasDraft, AgentCanvasDraftEvent } from "@/lib/agent-drafts/types";
import { AGENT_CANVAS_DRAFT_SCHEMA_VERSION } from "@/lib/agent-drafts/types";
import { DomainError } from "@/lib/domain/errors";

import {
  AGENT_DRAFT_HARD_TTL_MS,
  AGENT_DRAFT_SLIDING_TTL_MS,
  MemoryAgentCanvasDraftStore,
  resetMemoryAgentCanvasDraftStoreForTests,
  subscribeToLocalAgentDraftEvents,
} from "./agent-draft-store";

const NOW = 1_800_000_000_000;

function draft(overrides: Partial<AgentCanvasDraft> = {}): AgentCanvasDraft {
  return {
    schemaVersion: AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
    id: "draft_alpha",
    roomId: "room_alpha",
    ownerParticipantId: "p_owner",
    author: { participantId: "p_owner", displayName: "Owner", color: "blue", kind: "agent" },
    revision: 1,
    baselineRoomRevision: 7,
    status: "active",
    transaction: {
      commands: [{
        type: "create",
        object: {
          id: "node_alpha", kind: "text", x: 0, y: 0, width: 100, height: 40,
          rotation: 0, zIndex: 0, groupId: null, content: "Alpha",
          color: "black", size: "m", align: "start",
        },
      }],
      diagramCommands: [],
    },
    temporaryReferences: { alpha: "node_alpha" },
    previewObjects: [],
    previewDiagrams: [],
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + AGENT_DRAFT_SLIDING_TTL_MS,
    hardExpiresAt: NOW + AGENT_DRAFT_HARD_TTL_MS,
    awaitingReview: null,
    committing: null,
    authoritativeCommit: null,
    ...overrides,
  };
}

async function domainError(promise: Promise<unknown>, code: DomainError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("MemoryAgentCanvasDraftStore", () => {
  beforeEach(() => resetMemoryAgentCanvasDraftStoreForTests());

  it("publishes bounded invalidations and enforces one active draft per participant", async () => {
    const store = new MemoryAgentCanvasDraftStore();
    const events: AgentCanvasDraftEvent[] = [];
    const unsubscribe = subscribeToLocalAgentDraftEvents((event) => events.push(event));
    await store.create(draft());

    await domainError(store.create(draft({ id: "draft_second" })), "REVISION_CONFLICT");
    unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "draft.upsert",
      draftId: "draft_alpha",
      revision: 1,
      status: "active",
    });
    expect(JSON.stringify(events[0])).not.toContain("transaction");
  });

  it("uses exact CAS and strictly advances revisions for every visible phase transition", async () => {
    const store = new MemoryAgentCanvasDraftStore();
    const created = await store.create(draft());
    const replaced = await store.replace({
      expectedRevision: created.revision,
      draft: draft({ revision: 2, updatedAt: NOW + 1, expiresAt: NOW + 90_001 }),
    });
    expect(replaced.revision).toBe(2);
    await domainError(store.replace({
      expectedRevision: 1,
      draft: draft({ revision: 2, updatedAt: NOW + 2 }),
    }), "REVISION_CONFLICT");

    const committing = await store.beginCommit({
      roomId: replaced.roomId,
      draftId: replaced.id,
      ownerParticipantId: replaced.ownerParticipantId,
      expectedRevision: 2,
      mutationId: "mutation_1",
      now: NOW + 3,
    });
    expect(committing).toMatchObject({ status: "committing", revision: 3 });

    const replay = await store.beginCommit({
      roomId: replaced.roomId,
      draftId: replaced.id,
      ownerParticipantId: replaced.ownerParticipantId,
      expectedRevision: 2,
      mutationId: "mutation_1",
      now: NOW + 4,
    });
    expect(replay.revision).toBe(3);

    const restored = await store.restoreActive({
      roomId: replaced.roomId,
      draftId: replaced.id,
      ownerParticipantId: replaced.ownerParticipantId,
      mutationId: "mutation_1",
      now: NOW + 5,
    });
    expect(restored).toMatchObject({ status: "active", revision: 4 });
  });

  it("retains an immutable awaiting-review snapshot and expires at the hard deadline", async () => {
    const store = new MemoryAgentCanvasDraftStore();
    await store.create(draft());
    await store.beginCommit({
      roomId: "room_alpha",
      draftId: "draft_alpha",
      ownerParticipantId: "p_owner",
      expectedRevision: 1,
      mutationId: "mutation_review",
      now: NOW + 1,
    });
    const awaiting = await store.markAwaitingReview({
      roomId: "room_alpha",
      draftId: "draft_alpha",
      ownerParticipantId: "p_owner",
      mutationId: "mutation_review",
      proposalId: "proposal_1",
      now: NOW + 2,
    });
    expect(awaiting).toMatchObject({
      status: "awaiting_review",
      revision: 3,
      expiresAt: NOW + AGENT_DRAFT_HARD_TTL_MS,
      awaitingReview: { proposalId: "proposal_1" },
    });
    await expect(store.get(
      "room_alpha",
      "draft_alpha",
      NOW + AGENT_DRAFT_SLIDING_TTL_MS + 1,
    )).resolves.toMatchObject({ status: "awaiting_review" });
    await expect(store.get(
      "room_alpha",
      "draft_alpha",
      NOW + AGENT_DRAFT_HARD_TTL_MS - 1,
    )).resolves.toMatchObject({ status: "awaiting_review" });
    await expect(store.get("room_alpha", "draft_alpha", NOW + AGENT_DRAFT_HARD_TTL_MS)).resolves.toBeNull();
  });

  it("publishes an authoritative room fence when committed work replaces a draft", async () => {
    const store = new MemoryAgentCanvasDraftStore();
    const events: AgentCanvasDraftEvent[] = [];
    const unsubscribe = subscribeToLocalAgentDraftEvents((event) => events.push(event));
    await store.create(draft());
    await store.beginCommit({
      roomId: "room_alpha",
      draftId: "draft_alpha",
      ownerParticipantId: "p_owner",
      expectedRevision: 1,
      mutationId: "mutation_committed",
      now: NOW + 1,
    });
    const committed = await store.markAuthoritativelyCommitted({
      roomId: "room_alpha",
      draftId: "draft_alpha",
      ownerParticipantId: "p_owner",
      mutationId: "mutation_committed",
      authoritativeRoomRevision: 9,
      now: NOW + 2,
    });
    expect(committed.authoritativeCommit).toEqual({
      mutationId: "mutation_committed",
      roomRevision: 9,
      committedAt: NOW + 2,
    });
    expect(events).toHaveLength(2);
    await store.remove({
      roomId: "room_alpha",
      draftId: "draft_alpha",
      ownerParticipantId: "p_owner",
      committingMutationId: "mutation_committed",
      reason: "committed",
      authoritativeRoomRevision: 9,
      now: NOW + 3,
    });
    unsubscribe();

    expect(events.at(-1)).toMatchObject({
      type: "draft.removed",
      reason: "committed",
      authoritativeRoomRevision: 9,
    });
  });

  it("enforces per-draft and room-count capacity", async () => {
    const tiny = new MemoryAgentCanvasDraftStore(undefined, { draftBytes: 128 });
    await domainError(tiny.create(draft()), "REQUEST_TOO_LARGE");

    resetMemoryAgentCanvasDraftStoreForTests();
    const one = new MemoryAgentCanvasDraftStore(undefined, { draftsPerRoom: 1 });
    await one.create(draft());
    await domainError(one.create(draft({ id: "draft_other", ownerParticipantId: "p_other" })), "ROOM_CAPACITY_EXCEEDED");
  });
});
