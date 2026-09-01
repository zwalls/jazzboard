import { describe, expect, it, vi } from "vitest";

import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";

import { keepAliveOwnedAgentDrafts } from "./agent-draft-keepalive";

function draft(input: Partial<AgentCanvasDraftSnapshot> = {}): AgentCanvasDraftSnapshot {
  return {
    schemaVersion: 1,
    id: "draft_owned",
    roomId: "room/a b",
    ownerParticipantId: "participant-a",
    author: {
      participantId: "participant-a",
      displayName: "Ada",
      color: "#4F6BED",
      kind: "agent",
    },
    revision: 4,
    baselineRoomRevision: 2,
    status: "active",
    temporaryReferences: {},
    previewObjects: [],
    previewDiagrams: [],
    metadata: null,
    createdAt: 10,
    updatedAt: 20,
    expiresAt: 30,
    hardExpiresAt: 40,
    awaitingReview: null,
    ...input,
  };
}

describe("keepAliveOwnedAgentDrafts", () => {
  it("renews only owned active drafts with exact revision fencing", async () => {
    const owned = draft();
    const renewed = draft({ expiresAt: 300_000 });
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return {
        ok: true as const,
        draft: renewed,
        serverTime: 100,
      };
    });
    const acceptDraft = vi.fn();
    const signal = new AbortController().signal;

    const count = await keepAliveOwnedAgentDrafts({
      roomId: "room/a b",
      participantId: "participant-a",
      drafts: [
        owned,
        draft({ id: "draft_other", ownerParticipantId: "participant-b" }),
        draft({ id: "draft_review", status: "awaiting_review" }),
        draft({ id: "draft_other_room", roomId: "room-c" }),
      ],
      signal,
      acceptDraft,
      request,
    });

    expect(count).toBe(1);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/drafts/draft_owned/keepalive",
      {
        method: "POST",
        body: JSON.stringify({ expectedDraftRevision: 4 }),
        signal,
      },
    );
    expect(acceptDraft).toHaveBeenCalledWith(renewed);
  });

  it("does no network work when there are no owned active drafts", async () => {
    const request = vi.fn();
    const count = await keepAliveOwnedAgentDrafts({
      roomId: "room-a",
      participantId: "participant-a",
      drafts: [draft({ roomId: "room-a", ownerParticipantId: "participant-b" })],
      signal: new AbortController().signal,
      acceptDraft: vi.fn(),
      request,
    });

    expect(count).toBe(0);
    expect(request).not.toHaveBeenCalled();
  });
});
