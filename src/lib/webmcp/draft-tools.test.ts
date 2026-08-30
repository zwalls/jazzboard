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
  const retiredCommittedDrafts: Array<{
    draftId: string;
    draftRevision: number;
    authoritativeRoomRevision: number;
  }> = [];
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
      retireCommittedAgentDraft: (draftId, draftRevision, authoritativeRoomRevision) => {
        retiredCommittedDrafts.push({ draftId, draftRevision, authoritativeRoomRevision });
      },
      setFollowTarget: () => undefined,
      setDeclinedSpotlight: () => undefined,
      leaveRoomView: () => undefined,
    },
  };
  return { binding, acceptedRooms, acceptedDrafts, removedDrafts, retiredCommittedDrafts };
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
    expect(tool(participantTools, "finish_canvas_draft").description).toMatch(
      /only after read_canvas_drafts reports.*presentation\.state=complete/i,
    );
    expect(tool(participantTools, "finish_canvas_draft").description).toMatch(
      /earlier commit returns not_applied without a server mutation/i,
    );
  });

  it("reads the bounded room collection or one exact draft through signed-session GETs", async () => {
    const state = fixture();
    const candidateDraft = draft();
    const getPresentation = vi.fn((draftId: string, revision: number) => ({
      source: "client-local" as const,
      draftId,
      requestedRevision: revision,
      observedRevision: revision,
      state: "complete" as const,
      complete: true,
      objectCount: 0,
      completedObjectCount: 0,
    }));
    state.binding.context.getAgentDraftPresentation = getPresentation;
    const request = vi.fn(async (url: string) =>
      url.endsWith(candidateDraft.id)
        ? { ok: true, draft: candidateDraft, serverTime: 50 }
        : { ok: true, drafts: [candidateDraft], serverTime: 50 },
    ) as unknown as WebMcpRequest;
    const tools = createJazzboardDraftWebMcpTools(state.binding, { request });

    await expect(execute(tool(tools, "read_canvas_drafts"), {})).resolves.toMatchObject({
      ok: true,
      data: {
        drafts: [{ id: candidateDraft.id }],
        serverTime: 50,
        presentations: [{
          source: "client-local",
          requestedRevision: candidateDraft.revision,
          observedRevision: candidateDraft.revision,
          state: "complete",
          complete: true,
        }],
      },
    });
    await expect(execute(tool(tools, "read_canvas_drafts"), {
      draftId: candidateDraft.id,
    })).resolves.toMatchObject({
      ok: true,
      data: {
        draft: { id: candidateDraft.id },
        serverTime: 50,
        presentation: {
          source: "client-local",
          requestedRevision: candidateDraft.revision,
          observedRevision: candidateDraft.revision,
          state: "complete",
          complete: true,
        },
      },
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
    expect(getPresentation).toHaveBeenCalledTimes(2);
  });

  it("commits with compare-and-swap, accepts authority, and retires the preview after paint", async () => {
    const state = fixture();
    const getPresentation = vi.fn((draftId: string, revision: number) => ({
      source: "client-local" as const,
      draftId,
      requestedRevision: revision,
      observedRevision: revision,
      state: "complete" as const,
      complete: true,
      objectCount: 1,
      completedObjectCount: 1,
    }));
    state.binding.context.getAgentDraftPresentation = getPresentation;
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
    expect(state.retiredCommittedDrafts).toEqual([{
      draftId: "draft_architecture",
      draftRevision: 2,
      authoritativeRoomRevision: 8,
    }]);
    expect(state.removedDrafts).toEqual([]);
    expect(getPresentation).toHaveBeenCalledOnce();
  });

  it("keeps an early commit local and non-applied until the exact presentation completes", async () => {
    const state = fixture();
    const getPresentation = vi.fn((draftId: string, revision: number) => ({
      source: "client-local" as const,
      draftId,
      requestedRevision: revision,
      observedRevision: revision,
      state: "pending" as const,
      complete: false,
      objectCount: 12,
      completedObjectCount: 5,
    }));
    state.binding.context.getAgentDraftPresentation = getPresentation;
    const request = vi.fn() as unknown as WebMcpRequest;
    const tools = createJazzboardDraftWebMcpTools(state.binding, { request });

    const result = await execute(tool(tools, "finish_canvas_draft"), {
      draftId: "draft_architecture",
      expectedDraftRevision: 2,
      action: "commit",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        draftId: "draft_architecture",
        draftRevision: 2,
        action: "commit",
        outcome: "not_applied",
        reasonCode: "PRESENTATION_NOT_COMPLETE",
        authoritativeMutationApplied: false,
        serverRequestSent: false,
        presentation: {
          source: "client-local",
          requestedRevision: 2,
          observedRevision: 2,
          state: "pending",
          complete: false,
        },
        nextStep: expect.stringMatching(/poll read_canvas_drafts.*latest exact draft revision/i),
      },
    });
    expect(getPresentation).toHaveBeenCalledWith("draft_architecture", 2);
    expect(request).not.toHaveBeenCalled();
    expect(state.acceptedRooms).toEqual([]);
    expect(state.acceptedDrafts).toEqual([]);
    expect(state.removedDrafts).toEqual([]);
    expect(state.retiredCommittedDrafts).toEqual([]);
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
    state.binding.context.getAgentDraftPresentation = (draftId, revision) => ({
      source: "client-local",
      draftId,
      requestedRevision: revision,
      observedRevision: revision,
      state: "complete",
      complete: true,
      objectCount: 1,
      completedObjectCount: 1,
    });
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
    expect(state.retiredCommittedDrafts).toEqual([]);
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
