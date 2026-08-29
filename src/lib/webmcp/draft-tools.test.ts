/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import type { RoomState } from "@/lib/domain/types";

import {
  createJazzboardDraftWebMcpTools,
  JAZZBOARD_DRAFT_READ_TOOL_NAMES,
  JAZZBOARD_DRAFT_TOOL_NAMES,
} from "./draft-tools";
import type {
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  WebMcpRequest,
} from "./types";

function draft(overrides: Partial<AgentCanvasDraftSnapshot> = {}): AgentCanvasDraftSnapshot {
  return {
    schemaVersion: 1,
    id: "draft_architecture",
    roomId: "room/a b",
    ownerParticipantId: "alice",
    author: {
      participantId: "alice",
      displayName: "Alice's agent",
      color: "#4466ee",
      kind: "agent",
    },
    revision: 2,
    baselineRoomRevision: 7,
    status: "active",
    temporaryReferences: { api: "node_stable" },
    previewObjects: [],
    previewDiagrams: [],
    metadata: null,
    createdAt: 10,
    updatedAt: 20,
    expiresAt: 30,
    hardExpiresAt: 40,
    ...overrides,
  };
}

function fixture(role: "participant" | "spectator" = "participant") {
  const acceptedRooms: RoomState[] = [];
  const acceptedDrafts: AgentCanvasDraftSnapshot[] = [];
  const removedDrafts: Array<{ draftId: string; revision?: number }> = [];
  const binding: JazzboardWebMcpBinding = {
    roomId: "room/a b",
    participantId: "alice",
    role,
    context: {
      getRoom: () => null,
      getSelection: () => [],
      getViewport: () => null,
      getFollowTarget: () => null,
      acceptRoom: (room) => acceptedRooms.push(room),
      acceptAgentDraft: (candidate) => acceptedDrafts.push(candidate),
      removeAgentDraft: (draftId, revision) => removedDrafts.push({ draftId, revision }),
      setFollowTarget: () => undefined,
      setDeclinedSpotlight: () => undefined,
      leaveRoomView: () => undefined,
    },
  };
  return { binding, acceptedRooms, acceptedDrafts, removedDrafts };
}

function tool(tools: WebMCP.ModelContextTool[], name: string): WebMCP.ModelContextTool {
  const match = tools.find((candidate) => candidate.name === name);
  if (!match) throw new Error(`Missing ${name}`);
  return match;
}

async function execute(candidate: WebMCP.ModelContextTool, input: Record<string, unknown>) {
  return await candidate.execute(input, {
    signal: new AbortController().signal,
  }) as JazzboardToolResult;
}

describe("canvas draft WebMCP tools", () => {
  it("registers read and finish tools for participants but only truthful reads for spectators", () => {
    const participantTools = createJazzboardDraftWebMcpTools(fixture().binding);
    const spectatorTools = createJazzboardDraftWebMcpTools(fixture("spectator").binding);

    expect(participantTools.map(({ name }) => name)).toEqual(JAZZBOARD_DRAFT_TOOL_NAMES);
    expect(spectatorTools.map(({ name }) => name)).toEqual(JAZZBOARD_DRAFT_READ_TOOL_NAMES);
    expect(tool(participantTools, "read_canvas_drafts").annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(tool(participantTools, "finish_canvas_draft").annotations).toEqual({
      untrustedContentHint: true,
    });
  });

  it("reads the bounded room collection or one exact draft through signed-session GETs", async () => {
    const state = fixture();
    const candidateDraft = draft();
    const request = vi.fn(async (url: string) =>
      url.endsWith(candidateDraft.id)
        ? { ok: true, draft: candidateDraft, serverTime: 50 }
        : { ok: true, drafts: [candidateDraft], serverTime: 50 },
    ) as unknown as WebMcpRequest;
    const tools = createJazzboardDraftWebMcpTools(state.binding, { request });

    await expect(execute(tool(tools, "read_canvas_drafts"), {})).resolves.toMatchObject({
      ok: true,
      data: { drafts: [{ id: candidateDraft.id }], serverTime: 50 },
    });
    await expect(execute(tool(tools, "read_canvas_drafts"), {
      draftId: candidateDraft.id,
    })).resolves.toMatchObject({
      ok: true,
      data: { draft: { id: candidateDraft.id }, serverTime: 50 },
    });
    expect(request).toHaveBeenNthCalledWith(1, "/api/rooms/room%2Fa%20b/drafts", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/rooms/room%2Fa%20b/drafts/draft_architecture",
      { method: "GET", signal: expect.any(AbortSignal) },
    );
    expect(state.acceptedDrafts).toEqual([candidateDraft, candidateDraft]);
  });

  it("commits with compare-and-swap, accepts the authoritative room, and removes the preview", async () => {
    const state = fixture();
    const authoritativeRoom = { id: "room/a b", roomRevision: 8 } as RoomState;
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      draft: null,
      mutation: {
        outcome: "applied",
        room: authoritativeRoom,
        changedObjectIds: ["node_stable"],
        changedDiagramIds: [],
        membershipObjectIds: [],
        activity: null,
        proposal: null,
      },
    })) as unknown as WebMcpRequest;
    const tools = createJazzboardDraftWebMcpTools(state.binding, { request });

    const result = await execute(tool(tools, "finish_canvas_draft"), {
      draftId: "draft_architecture",
      expectedDraftRevision: 2,
      action: "commit",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { outcome: "applied", action: "commit", draftId: "draft_architecture" },
    });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/drafts/draft_architecture/commit",
      {
        method: "POST",
        body: JSON.stringify({ expectedDraftRevision: 2 }),
        signal: expect.any(AbortSignal),
      },
    );
    expect(state.acceptedRooms).toEqual([authoritativeRoom]);
    expect(state.removedDrafts).toEqual([{ draftId: "draft_architecture", revision: undefined }]);
  });

  it("discards with compare-and-swap and never accepts a fabricated room", async () => {
    const state = fixture();
    const request = vi.fn(async () => ({
      ok: true,
      draftId: "draft_architecture",
      discarded: true,
    })) as unknown as WebMcpRequest;
    const tools = createJazzboardDraftWebMcpTools(state.binding, { request });

    const result = await execute(tool(tools, "finish_canvas_draft"), {
      draftId: "draft_architecture",
      expectedDraftRevision: 2,
      action: "discard",
    });

    expect(result).toMatchObject({ ok: true, data: { action: "discard" } });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/drafts/draft_architecture",
      {
        method: "DELETE",
        body: JSON.stringify({ expectedDraftRevision: 2 }),
        signal: expect.any(AbortSignal),
      },
    );
    expect(state.acceptedRooms).toEqual([]);
    expect(state.removedDrafts).toEqual([{ draftId: "draft_architecture", revision: undefined }]);
  });

  it("keeps a review-mode proposed draft visible instead of removing it", async () => {
    const state = fixture();
    const proposedDraft = draft({ revision: 3, status: "awaiting_review" });
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "proposed",
      draft: proposedDraft,
      activity: null,
      proposal: { proposalId: "proposal_1" },
    })) as unknown as WebMcpRequest;
    const tools = createJazzboardDraftWebMcpTools(state.binding, { request });

    const result = await execute(tool(tools, "finish_canvas_draft"), {
      draftId: "draft_architecture",
      expectedDraftRevision: 2,
      action: "commit",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { outcome: "proposed", action: "commit" },
    });
    expect(state.acceptedDrafts).toEqual([proposedDraft]);
    expect(state.removedDrafts).toEqual([]);
  });

  it("rejects incomplete revision pairs and invalid draft IDs before network access", async () => {
    const request = vi.fn() as unknown as WebMcpRequest;
    const tools = createJazzboardDraftWebMcpTools(fixture().binding, { request });

    await expect(execute(tool(tools, "finish_canvas_draft"), {
      draftId: "not-a-draft",
      action: "commit",
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });
});
