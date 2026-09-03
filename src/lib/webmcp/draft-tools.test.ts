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
      /keeps the draft alive.*waits inside this call/i,
    );
    expect(tool(participantTools, "finish_canvas_draft").description).toMatch(
      /sends no authoritative canvas mutation.*recoverable/i,
    );
    expect(tool(participantTools, "finish_canvas_draft").description).toMatch(
      /commit is autonomous.*needs no extra user confirmation/i,
    );
    expect(tool(participantTools, "finish_canvas_draft").description).toMatch(
      /resolve fail findings.*deliberate geometry.*findingKey-to-rationale/i,
    );
  });

  it("surfaces authoritative success when draft-sidecar cleanup remains pending", async () => {
    const state = fixture();
    state.binding.context.getAgentDraftPresentation = () => ({
      source: "client-local",
      draftId: "draft_architecture",
      requestedRevision: 2,
      observedRevision: 2,
      state: "complete",
      complete: true,
      objectCount: 1,
      completedObjectCount: 1,
    });
    const authoritativeRoom = { id: "room/a b", roomRevision: 8 } as RoomState;
    const request = vi.fn(async (url: string) => url.endsWith("/keepalive")
      ? { ok: true, draft: draft({ expiresAt: 300_000 }), serverTime: 100 }
      : {
          ok: true,
          outcome: "applied",
          sidecarStatus: "cleanup_pending",
          mutation: {
            outcome: "applied",
            room: authoritativeRoom,
            changedObjectIds: ["node_stable"],
            changedDiagramIds: [],
            membershipObjectIds: [],
            activity: null,
            proposal: null,
          },
        }) as unknown as WebMcpRequest;
    const result = await execute(
      tool(createJazzboardDraftWebMcpTools(state.binding, { request }), "finish_canvas_draft"),
      { draftId: "draft_architecture", expectedDraftRevision: 2, action: "commit" },
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "applied",
        sidecarStatus: "cleanup_pending",
        nextStep: expect.stringMatching(/authoritative canvas mutation applied.*do not replay/i),
      },
    });
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
    const renewedDraft = draft({ expiresAt: 300_000 });
    const authoritativeRoom = { id: "room/a b", roomRevision: 8 } as RoomState;
    const request = vi.fn(async (url: string) => url.endsWith("/keepalive")
      ? { ok: true, draft: renewedDraft, serverTime: 100 }
      : {
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
        }) as unknown as WebMcpRequest;
    const tools = createJazzboardDraftWebMcpTools(state.binding, { request });

    const result = await execute(tool(tools, "finish_canvas_draft"), {
      draftId: "draft_architecture",
      expectedDraftRevision: 2,
      action: "commit",
      intentionalFindingAcknowledgements: {
        "diagram:member_object_overlap:12345678": "The user requested this deliberate visual layering.",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      data: { outcome: "applied", action: "commit", draftId: "draft_architecture" },
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/rooms/room%2Fa%20b/agent/drafts/draft_architecture/keepalive",
      {
        method: "POST",
        body: JSON.stringify({ expectedDraftRevision: 2 }),
        signal: expect.any(AbortSignal),
      },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/rooms/room%2Fa%20b/agent/drafts/draft_architecture/commit",
      {
        method: "POST",
        body: JSON.stringify({
          expectedDraftRevision: 2,
          intentionalFindingAcknowledgements: {
            "diagram:member_object_overlap:12345678": "The user requested this deliberate visual layering.",
          },
        }),
        signal: expect.any(AbortSignal),
      },
    );
    expect(state.acceptedDrafts).toEqual([renewedDraft]);
    expect(state.acceptedRooms).toEqual([authoritativeRoom]);
    expect(state.retiredCommittedDrafts).toEqual([{
      draftId: "draft_architecture",
      draftRevision: 2,
      authoritativeRoomRevision: 8,
    }]);
    expect(state.removedDrafts).toEqual([]);
    expect(getPresentation).toHaveBeenCalledOnce();
  });

  it("returns exact artifact and whole-room inspections after an applied progressive commit", async () => {
    const state = fixture();
    state.binding.context.getAgentDraftPresentation = () => ({
      source: "client-local",
      draftId: "draft_architecture",
      requestedRevision: 2,
      observedRevision: 2,
      state: "complete",
      complete: true,
      objectCount: 1,
      completedObjectCount: 1,
    });
    const createdObject = { id: "node_stable", revision: 1, zIndex: 2 };
    const surroundingObject = { id: "existing_note", revision: 3, zIndex: 1 };
    const authoritativeRoom = {
      id: "room/a b",
      roomRevision: 8,
      objects: {
        node_stable: createdObject,
        existing_note: surroundingObject,
      },
      diagrams: {
        diagram_architecture: {
          id: "diagram_architecture",
          revision: 1,
          memberObjectIds: ["node_stable"],
          connectorIds: [],
        },
      },
    } as unknown as RoomState;
    const request = vi.fn(async (url: string) => url.endsWith("/keepalive")
      ? { ok: true, draft: draft({ expiresAt: 300_000 }), serverTime: 100 }
      : {
          ok: true,
          outcome: "applied",
          room: authoritativeRoom,
          changedObjectIds: ["node_stable"],
          changedDiagramIds: ["diagram_architecture"],
          membershipObjectIds: ["node_stable"],
        }) as unknown as WebMcpRequest;

    const result = await execute(
      tool(createJazzboardDraftWebMcpTools(state.binding, { request }), "finish_canvas_draft"),
      { draftId: "draft_architecture", expectedDraftRevision: 2, action: "commit" },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "applied",
        recommendedInspection: {
          tool: "inspect_canvas_scope",
          input: {
            scope: {
              kind: "diagram",
              diagramId: "diagram_architecture",
              expectedRevision: 1,
            },
          },
        },
        recommendedCompositionInspection: {
          tool: "inspect_canvas_scope",
          input: {
            scope: { kind: "room", expectedRevision: 8 },
            representation: "overview",
          },
        },
        nextStep: expect.stringMatching(
          /recommendedInspection.*recommendedCompositionInspection.*direct revision-checked.*only then report completion/i,
        ),
      },
    });
  });

  it("keeps the draft alive and waits inside one finish call for exact presentation completion", async () => {
    const state = fixture();
    const completedPresentation = {
      source: "client-local" as const,
      draftId: "draft_architecture",
      requestedRevision: 2,
      observedRevision: 2,
      state: "complete" as const,
      complete: true,
      objectCount: 12,
      completedObjectCount: 12,
    };
    const waitForDraftPresentation = vi.fn(async () => completedPresentation);
    const renewedDraft = draft({ expiresAt: 300_000 });
    const authoritativeRoom = { id: "room/a b", roomRevision: 8 } as RoomState;
    const request = vi.fn(async (url: string) => url.endsWith("/keepalive")
      ? { ok: true, draft: renewedDraft, serverTime: 100 }
      : {
          ok: true,
          outcome: "applied",
          draft: null,
          room: authoritativeRoom,
          draftRevision: 2,
          changedObjectIds: ["node_stable"],
          changedDiagramIds: [],
          membershipObjectIds: [],
        }) as unknown as WebMcpRequest;
    const tools = createJazzboardDraftWebMcpTools(state.binding, {
      request,
      waitForDraftPresentation,
    });

    const result = await execute(tool(tools, "finish_canvas_draft"), {
      draftId: "draft_architecture",
      expectedDraftRevision: 2,
      action: "commit",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { action: "commit", outcome: "applied" },
    });
    expect(waitForDraftPresentation).toHaveBeenCalledWith(
      "draft_architecture",
      2,
      expect.any(AbortSignal),
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.acceptedRooms).toEqual([authoritativeRoom]);
    expect(state.acceptedDrafts).toEqual([renewedDraft]);
    expect(state.removedDrafts).toEqual([]);
    expect(state.retiredCommittedDrafts).toEqual([{
      draftId: "draft_architecture",
      draftRevision: 2,
      authoritativeRoomRevision: 8,
    }]);
  });

  it("polls browser-local presentation internally instead of requiring agent round trips", async () => {
    vi.useFakeTimers();
    try {
      const state = fixture();
      let presentationReads = 0;
      state.binding.context.getAgentDraftPresentation = (draftId, revision) => {
        presentationReads += 1;
        const complete = presentationReads >= 2;
        return {
          source: "client-local",
          draftId,
          requestedRevision: revision,
          observedRevision: revision,
          state: complete ? "complete" : "pending",
          complete,
          objectCount: 4,
          completedObjectCount: complete ? 4 : 2,
        };
      };
      const renewedDraft = draft({ expiresAt: 300_000 });
      const authoritativeRoom = { id: "room/a b", roomRevision: 8 } as RoomState;
      const request = vi.fn(async (url: string) => url.endsWith("/keepalive")
        ? { ok: true, draft: renewedDraft, serverTime: 100 }
        : {
            ok: true,
            outcome: "applied",
            room: authoritativeRoom,
            draftRevision: 2,
          }) as unknown as WebMcpRequest;
      const tools = createJazzboardDraftWebMcpTools(state.binding, { request });

      const pendingResult = execute(tool(tools, "finish_canvas_draft"), {
        draftId: "draft_architecture",
        expectedDraftRevision: 2,
        action: "commit",
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(80);

      await expect(pendingResult).resolves.toMatchObject({
        ok: true,
        data: { outcome: "applied", action: "commit" },
      });
      expect(presentationReads).toBe(2);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out without an authoritative mutation and tells the agent to retry the draft path", async () => {
    const state = fixture();
    const renewedDraft = draft({ expiresAt: 300_000 });
    const requestMock = vi.fn(async (url: string) => {
      void url;
      return {
        ok: true,
        draft: renewedDraft,
        serverTime: 100,
      };
    });
    const request = requestMock as unknown as WebMcpRequest;
    const tools = createJazzboardDraftWebMcpTools(state.binding, {
      request,
      waitForDraftPresentation: async () => ({
        source: "client-local",
        draftId: "draft_architecture",
        requestedRevision: 2,
        observedRevision: 2,
        state: "pending",
        complete: false,
        objectCount: 12,
        completedObjectCount: 5,
      }),
    });

    const result = await execute(tool(tools, "finish_canvas_draft"), {
      draftId: "draft_architecture",
      expectedDraftRevision: 2,
      action: "commit",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "not_applied",
        reasonCode: "PRESENTATION_TIMEOUT",
        authoritativeMutationApplied: false,
        authoritativeMutationRequestSent: false,
        keepaliveSent: true,
        nextStep: expect.stringMatching(/retry finish_canvas_draft.*do not bypass progressive delivery/i),
      },
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(String(requestMock.mock.calls[0]?.[0])).toMatch(/\/keepalive$/);
    expect(state.acceptedRooms).toEqual([]);
    expect(state.acceptedDrafts).toEqual([renewedDraft]);
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
    const renewedDraft = draft({ expiresAt: 300_000 });
    const proposedDraft = draft({ revision: 3, status: "awaiting_review" });
    const request = vi.fn(async (url: string) => url.endsWith("/keepalive")
      ? { ok: true, draft: renewedDraft, serverTime: 100 }
      : {
          ok: true,
          outcome: "proposed",
          draft: proposedDraft,
          activity: null,
          proposal: { proposalId: "proposal_1" },
        }) as unknown as WebMcpRequest;
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
    expect(state.acceptedDrafts).toEqual([renewedDraft, proposedDraft]);
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
