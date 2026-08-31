import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Participant, RoomEvent, RoomState } from "@/lib/domain/types";
import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import type { RoomRealtimeOptions } from "@/lib/realtime/client";

import {
  applyTransientHumanPresence,
  reconcileRoomSnapshot,
  shouldAcceptRoomRevision,
  useRoom,
} from "./use-room";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  realtimeOptions: [] as unknown[],
  realtimeClose: vi.fn(),
  realtimeRequestSync: vi.fn(),
  realtimePublishTransient: vi.fn(() => true),
}));

vi.mock("@/lib/client/api", () => ({
  apiRequest: mocks.apiRequest,
  JazzboardApiError: class JazzboardApiError extends Error {},
}));

vi.mock("@/lib/realtime/client", () => ({
  connectRoomRealtime: vi.fn((options: unknown) => {
    mocks.realtimeOptions.push(options);
    return {
      close: mocks.realtimeClose,
      requestSync: mocks.realtimeRequestSync,
      publishTransientPresence: mocks.realtimePublishTransient,
    };
  }),
}));

function participant(participantId: string): Participant {
  return {
    participantId,
    displayName: participantId,
    color: "blue",
    role: "participant",
    joinedAt: 1,
    lastSeenAt: 1,
    connected: true,
    agentActive: false,
    human: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
    agent: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
  };
}

function room(
  id: string,
  roomRevision: number,
  participantIds: string[] = [],
  stateRevision = roomRevision,
): RoomState {
  return {
    id,
    code: id,
    title: `${id} document ${roomRevision} state ${stateRevision}`,
    stateRevision,
    roomRevision,
    createdAt: 1,
    updatedAt: roomRevision,
    participants: Object.fromEntries(participantIds.map((id) => [id, participant(id)])),
    objects: {},
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function realtimeFor(roomId: string): RoomRealtimeOptions {
  const options = mocks.realtimeOptions.find(
    (candidate) => (candidate as RoomRealtimeOptions).roomId === roomId,
  );
  if (!options) throw new Error(`No realtime connection for ${roomId}`);
  return options as RoomRealtimeOptions;
}

function compactEvent(sequence: number, roomRevision = sequence): RoomEvent {
  return {
    id: `event-${sequence}`,
    roomId: "room-a",
    sequence,
    occurredAt: sequence,
    type: "room.updated",
    actor: null,
    payload: {
      schemaVersion: 3,
      kind: "room.invalidated",
      stateRevision: sequence,
      roomRevision,
      activityId: null,
    },
  };
}

function presenceEvent(sequence: number, roomRevision: number, participantId = "participant-a"): RoomEvent {
  return {
    id: `presence-${sequence}`,
    roomId: "room-a",
    sequence,
    occurredAt: sequence,
    type: "presence.updated",
    actor: null,
    payload: {
      schemaVersion: 4,
      kind: "presence.delta",
      stateRevision: sequence,
      roomRevision,
      participantId,
      actorKind: "human",
      lastSeenAt: sequence,
      connected: true,
      agentActive: false,
      presence: {
        cursor: { x: 25, y: 35 },
        viewport: null,
        lastSeenAt: sequence,
        activity: null,
      },
    },
  };
}

function agentDraft(revision = 1): AgentCanvasDraftSnapshot {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: "draft_1",
    roomId: "room-a",
    ownerParticipantId: "participant-a",
    author: {
      participantId: "participant-a",
      displayName: "Ada",
      color: "#4F6BED",
      kind: "agent",
    },
    revision,
    baselineRoomRevision: 1,
    status: "active",
    temporaryReferences: {},
    previewObjects: [],
    previewDiagrams: [],
    metadata: null,
    createdAt: now,
    updatedAt: now + revision,
    expiresAt: now + 90_000,
    hardExpiresAt: now + 600_000,
    awaitingReview: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.apiRequest.mockReset();
  mocks.realtimeOptions.length = 0;
  mocks.realtimeClose.mockReset();
  mocks.realtimeRequestSync.mockReset();
  mocks.realtimePublishTransient.mockClear();
  vi.stubGlobal("BroadcastChannel", undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shouldAcceptRoomRevision", () => {
  it("accepts the initial authoritative room", () => {
    expect(shouldAcceptRoomRevision(null, 4)).toBe(true);
  });

  it("accepts a strictly newer room revision", () => {
    expect(shouldAcceptRoomRevision(4, 5)).toBe(true);
  });

  it("rejects an identical room revision", () => {
    expect(shouldAcceptRoomRevision(4, 4)).toBe(false);
  });

  it("rejects an older room revision", () => {
    expect(shouldAcceptRoomRevision(4, 3)).toBe(false);
  });
});

describe("reconcileRoomSnapshot", () => {
  it("accepts a newer document that arrives behind newer presence without regressing coordination", () => {
    const current = room("room-a", 1, ["participant-a"], 5);
    current.participants["participant-a"] = {
      ...current.participants["participant-a"],
      lastSeenAt: 50,
      human: {
        ...current.participants["participant-a"].human,
        cursor: { x: 90, y: 120 },
        lastSeenAt: 50,
      },
    };
    current.leases = {
      node: {
        leaseId: "lease-node",
        objectId: "node",
        actor: { participantId: "participant-a", displayName: "A", color: "blue", kind: "human" },
        operation: "move",
        objectRevision: 1,
        acquiredAt: 20,
        expiresAt: 60,
      },
    };
    const next = room("room-a", 2, ["participant-a", "participant-b"], 4);
    next.objects = {
      note: {
        id: "note",
        kind: "text",
        x: 10,
        y: 20,
        width: 120,
        height: 50,
        rotation: 0,
        zIndex: 1,
        revision: 1,
        groupId: null,
        diagramIds: [],
        createdAt: 4,
        updatedAt: 4,
        createdBy: { participantId: "participant-a", displayName: "A", color: "blue", kind: "human" },
        lastEditedBy: { participantId: "participant-a", displayName: "A", color: "blue", kind: "human" },
        content: "New durable document",
        color: "black",
        size: "m",
        align: "start",
      },
    };

    const reconciled = reconcileRoomSnapshot(current, next);

    expect(reconciled).toMatchObject({ roomRevision: 2, stateRevision: 5 });
    expect(reconciled?.objects).toBe(next.objects);
    expect(reconciled?.leases).toBe(current.leases);
    expect(reconciled?.participants["participant-a"].human.cursor).toEqual({ x: 90, y: 120 });
    expect(reconciled?.participants["participant-b"]).toBe(next.participants["participant-b"]);
  });

  it("accepts newer coordination behind a newer document without regressing the document", () => {
    const current = room("room-a", 3, ["participant-a"], 7);
    current.objects = { stable: { id: "stable", kind: "shape" } as RoomState["objects"][string] };
    const next = room("room-a", 2, ["participant-a"], 8);
    next.participants["participant-a"] = {
      ...next.participants["participant-a"],
      connected: false,
      lastSeenAt: 80,
    };

    const reconciled = reconcileRoomSnapshot(current, next);

    expect(reconciled).toMatchObject({ roomRevision: 3, stateRevision: 8 });
    expect(reconciled?.objects).toBe(current.objects);
    expect(reconciled?.participants["participant-a"]).toMatchObject({ connected: false, lastSeenAt: 80 });
  });

  it("returns the original newer snapshot when both planes advance and rejects dominated snapshots", () => {
    const current = room("room-a", 2, ["participant-a"], 5);
    const newer = room("room-a", 3, ["participant-a"], 6);

    expect(reconcileRoomSnapshot(current, newer)).toBe(newer);
    expect(reconcileRoomSnapshot(newer, current)).toBeNull();
    expect(reconcileRoomSnapshot(current, structuredClone(current))).toBeNull();
  });
});

describe("applyTransientHumanPresence", () => {
  it("structurally shares durable canvas state and untouched participants", () => {
    const current = room("room-a", 3, ["participant-a", "participant-b"]);
    const objects = current.objects;
    const diagrams = current.diagrams;
    const untouched = current.participants["participant-b"];

    const projected = applyTransientHumanPresence(
      current,
      "participant-a",
      { x: 12, y: 34 },
      { x: 1, y: 2, zoom: 1.5, width: 800, height: 600 },
    );

    expect(projected).not.toBe(current);
    expect(projected.objects).toBe(objects);
    expect(projected.diagrams).toBe(diagrams);
    expect(projected.participants["participant-b"]).toBe(untouched);
    expect(projected.participants["participant-a"]).not.toBe(
      current.participants["participant-a"],
    );
    expect(projected.participants["participant-a"].human.cursor).toEqual({ x: 12, y: 34 });
    expect(current.participants["participant-a"].human.cursor).toBeNull();
  });
});

describe("useRoom request ordering", () => {
  it("loads authorized drafts after realtime identity and removes them from compact invalidations", async () => {
    const draft = agentDraft();
    mocks.apiRequest.mockResolvedValueOnce({ ok: true, drafts: [draft], serverTime: draft.updatedAt + 10 });
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");

    await act(async () => {
      realtime.onReady?.({ connectionId: "connection-a", participantId: "participant-a", role: "participant" });
      await Promise.resolve();
    });

    expect(mocks.apiRequest).toHaveBeenCalledWith("/api/rooms/room-a/drafts");
    expect(result.current.agentDrafts).toEqual([draft]);
    expect(result.current.initialAgentDraftIds).toEqual([draft.id]);

    act(() => {
      realtime.onDraftInvalidated?.({
        schemaVersion: 1,
        id: "draft_event_removed",
        roomId: "room-a",
        occurredAt: Date.now(),
        type: "draft.removed",
        draftId: draft.id,
        revision: draft.revision,
        reason: "discarded",
      });
    });
    expect(result.current.agentDrafts).toEqual([]);
    expect(result.current.initialAgentDraftIds).toEqual([draft.id]);
  });

  it("does not classify a draft first observed after initial hydration as settled", async () => {
    mocks.apiRequest.mockResolvedValueOnce({ ok: true, drafts: [], serverTime: Date.now() });
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");

    await act(async () => {
      realtime.onReady?.({ connectionId: "connection-a", participantId: "participant-a", role: "participant" });
      await Promise.resolve();
    });
    expect(result.current.initialAgentDraftIds).toEqual([]);

    act(() => {
      result.current.acceptAgentDraft(agentDraft());
    });
    expect(result.current.agentDrafts).toHaveLength(1);
    expect(result.current.initialAgentDraftIds).toEqual([]);
  });

  it("does not settle a live draft updated during a delayed first list read", async () => {
    const visitStartedAt = Date.now();
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    const liveDraft = {
      ...agentDraft(2),
      createdAt: visitStartedAt - 10_000,
      updatedAt: Date.now(),
    };
    mocks.apiRequest.mockResolvedValueOnce({
      ok: true,
      drafts: [liveDraft],
      serverTime: liveDraft.updatedAt + 10,
    });

    await act(async () => {
      realtime.onReady?.({ connectionId: "connection-a", participantId: "participant-a", role: "participant" });
      await Promise.resolve();
    });

    expect(result.current.agentDrafts).toEqual([liveDraft]);
    expect(result.current.initialAgentDraftIds).toEqual([]);
  });

  it("keeps a committed draft visible until its authoritative room is readable", async () => {
    const draft = agentDraft();
    draft.previewObjects = [{
      id: "candidate-node",
      kind: "shape",
      shape: "rectangle",
      nodeType: "component",
      nodeMetadata: null,
      label: "Visible draft candidate",
      fill: "blue",
      stroke: "blue",
      x: 100,
      y: 100,
      width: 240,
      height: 120,
      rotation: 0,
      zIndex: 1,
      revision: 1,
      groupId: null,
      diagramIds: [],
      createdAt: 1,
      updatedAt: 1,
      createdBy: draft.author,
      lastEditedBy: draft.author,
      authority: "draft",
    }];
    const authoritative = deferred<{ ok: true; room: RoomState; participantId: string }>();
    let draftReadCount = 0;
    mocks.apiRequest.mockImplementation((url: string) => {
      if (!url.endsWith("/drafts")) return authoritative.promise;
      draftReadCount += 1;
      return Promise.resolve({
        ok: true,
        drafts: draftReadCount === 1 ? [draft] : [],
        serverTime: Date.now(),
      });
    });
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");

    await act(async () => {
      realtime.onSnapshot(room("room-a", 1, ["participant-a"]), {
        cursor: null,
        replayTruncated: false,
      });
      realtime.onReady?.({ connectionId: "connection-a", participantId: "participant-a", role: "participant" });
      await Promise.resolve();
    });

    act(() => {
      realtime.onDraftInvalidated?.({
        schemaVersion: 1,
        id: "draft_event_committed",
        roomId: "room-a",
        occurredAt: Date.now(),
        type: "draft.removed",
        draftId: draft.id,
        revision: draft.revision,
        reason: "committed",
        authoritativeRoomRevision: 2,
      });
    });
    expect(result.current.agentDrafts).toEqual([draft]);

    await act(async () => {
      // Even a list response that already omitted the committed sidecar must
      // not punch a blank frame before the corresponding room revision lands.
      realtime.onReady?.({ connectionId: "connection-a", participantId: "participant-a", role: "participant" });
      await Promise.resolve();
    });
    expect(draftReadCount).toBe(2);
    expect(result.current.agentDrafts).toEqual([draft]);

    await act(async () => {
      authoritative.resolve({
        ok: true,
        // The candidate was committed at revision 2 and then deleted before
        // this viewer refreshed. The revision fence, rather than ID presence,
        // still makes the draft-to-authority handoff gap-free and terminal.
        room: room("room-a", 2, ["participant-a"]),
        participantId: "participant-a",
      });
      await authoritative.promise;
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(result.current.agentDrafts).toEqual([]);
  });

  it("retires a locally committed draft only after authority has had a paint boundary", async () => {
    const draft = agentDraft();
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");

    act(() => {
      realtime.onSnapshot(room("room-a", 1, ["participant-a"]), {
        cursor: null,
        replayTruncated: false,
      });
      result.current.acceptAgentDraft(draft);
      result.current.retireCommittedAgentDraft("room-a", draft.id, draft.revision, 2);
    });
    expect(result.current.agentDrafts).toEqual([draft]);

    act(() => {
      result.current.acceptRoom(room("room-a", 2, ["participant-a"]));
    });
    expect(result.current.agentDrafts).toEqual([draft]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(result.current.agentDrafts).toEqual([draft]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(result.current.agentDrafts).toEqual([]);
  });

  it("ignores a committed-draft retirement that resolves after navigation", async () => {
    const draft = agentDraft();
    const { result, rerender } = renderHook(
      ({ roomId }: { roomId: string }) => useRoom(roomId),
      { initialProps: { roomId: "room-a" } },
    );
    const staleRetirement = result.current.retireCommittedAgentDraft;

    rerender({ roomId: "room-b" });
    const roomBDraft = { ...draft, roomId: "room-b" };
    act(() => {
      realtimeFor("room-b").onSnapshot(room("room-b", 5, ["participant-b"]), {
        cursor: null,
        replayTruncated: false,
      });
      result.current.acceptAgentDraft(roomBDraft);
      staleRetirement("room-a", draft.id, draft.revision, 2);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(result.current.agentDrafts).toEqual([roomBDraft]);
  });

  it("fences an empty-list-first draft disappearance behind an authoritative room read", async () => {
    const draft = agentDraft();
    const authoritative = deferred<{ ok: true; room: RoomState; participantId: string }>();
    let draftReadCount = 0;
    let roomReadCount = 0;
    mocks.apiRequest.mockImplementation((url: string) => {
      if (url.endsWith("/drafts")) {
        draftReadCount += 1;
        return Promise.resolve({
          ok: true,
          drafts: draftReadCount === 1 ? [draft] : [],
          serverTime: draft.updatedAt + 10,
        });
      }
      roomReadCount += 1;
      return authoritative.promise;
    });
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");

    await act(async () => {
      realtime.onSnapshot(room("room-a", 1, ["participant-a"]), {
        cursor: null,
        replayTruncated: false,
      });
      realtime.onReady?.({ connectionId: "connection-a", participantId: "participant-a", role: "participant" });
      await Promise.resolve();
    });
    expect(result.current.agentDrafts).toEqual([draft]);

    await act(async () => {
      // Simulate a visibility/reconnect refresh observing the deleted sidecar
      // before its compact committed invalidation reaches this client.
      realtime.onReady?.({ connectionId: "connection-a", participantId: "participant-a", role: "participant" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(draftReadCount).toBe(2);
    expect(roomReadCount).toBe(1);
    expect(result.current.agentDrafts).toEqual([draft]);

    await act(async () => {
      authoritative.resolve({
        ok: true,
        room: room("room-a", 2, ["participant-a"]),
        participantId: "participant-a",
      });
      await authoritative.promise;
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(result.current.agentDrafts).toEqual([]);
  });

  it("refetches a newer draft invalidation and ignores an older local acknowledgement", async () => {
    const first = agentDraft(1);
    const third = { ...agentDraft(3), status: "committing" as const };
    mocks.apiRequest
      .mockResolvedValueOnce({ ok: true, drafts: [first], serverTime: Date.now() })
      .mockResolvedValueOnce({ ok: true, drafts: [third], serverTime: Date.now() });
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");
    await act(async () => {
      realtime.onReady?.({ connectionId: "connection-a", participantId: "participant-a", role: "participant" });
      await Promise.resolve();
    });
    act(() => {
      realtime.onDraftInvalidated?.({
        schemaVersion: 1,
        id: "draft_event_3",
        roomId: "room-a",
        occurredAt: Date.now(),
        type: "draft.upsert",
        draftId: first.id,
        ownerParticipantId: first.ownerParticipantId,
        revision: 3,
        status: "committing",
        expiresAt: third.expiresAt,
      });
    });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.agentDrafts[0]).toMatchObject({ revision: 3, status: "committing" });

    act(() => {
      result.current.acceptAgentDraft({ ...agentDraft(2), status: "active" });
    });
    expect(result.current.agentDrafts[0]).toMatchObject({ revision: 3, status: "committing" });
  });

  it("coalesces overlapping invalidations and recovers when the trailing fetch fails", async () => {
    const revisionTwo = agentDraft(2);
    const revisionThree = { ...agentDraft(3), status: "committing" as const };
    const firstFetch = deferred<{ ok: true; drafts: AgentCanvasDraftSnapshot[]; serverTime: number }>();
    let draftReadCount = 0;
    mocks.apiRequest.mockImplementation((url: string) => {
      if (!url.endsWith("/drafts")) {
        return Promise.resolve({ ok: true, room: room("room-a", 1, ["participant-a"]), participantId: "participant-a" });
      }
      draftReadCount += 1;
      if (draftReadCount === 1) return firstFetch.promise;
      if (draftReadCount === 2) return Promise.reject(new Error("temporary draft read failure"));
      return Promise.resolve({ ok: true, drafts: [revisionThree], serverTime: Date.now() });
    });
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");

    act(() => {
      realtime.onDraftInvalidated?.({
        schemaVersion: 1,
        id: "draft_event_2",
        roomId: "room-a",
        occurredAt: Date.now(),
        type: "draft.upsert",
        draftId: revisionTwo.id,
        ownerParticipantId: revisionTwo.ownerParticipantId,
        revision: 2,
        status: "active",
        expiresAt: revisionTwo.expiresAt,
      });
      realtime.onDraftInvalidated?.({
        schemaVersion: 1,
        id: "draft_event_3_queued",
        roomId: "room-a",
        occurredAt: Date.now(),
        type: "draft.upsert",
        draftId: revisionThree.id,
        ownerParticipantId: revisionThree.ownerParticipantId,
        revision: 3,
        status: "committing",
        expiresAt: revisionThree.expiresAt,
      });
    });
    expect(draftReadCount).toBe(1);

    await act(async () => {
      firstFetch.resolve({ ok: true, drafts: [revisionTwo], serverTime: Date.now() });
      await firstFetch.promise;
      await Promise.resolve();
    });
    expect(result.current.agentDrafts[0]).toMatchObject({ revision: 2 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
      await Promise.resolve();
    });
    expect(draftReadCount).toBe(3);
    expect(result.current.agentDrafts[0]).toMatchObject({ revision: 3, status: "committing" });
  });

  it("retries one transient draft read failure while the realtime socket remains live", async () => {
    const draft = agentDraft(1);
    let draftReadCount = 0;
    mocks.apiRequest.mockImplementation((url: string) => {
      if (!url.endsWith("/drafts")) {
        return Promise.resolve({ ok: true, room: room("room-a", 1, ["participant-a"]), participantId: "participant-a" });
      }
      draftReadCount += 1;
      if (draftReadCount === 1) return Promise.reject(new Error("temporary draft read failure"));
      return Promise.resolve({ ok: true, drafts: [draft], serverTime: Date.now() });
    });
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");

    act(() => {
      realtime.onStatusChange?.("connected");
      realtime.onReady?.({ connectionId: "connection-a", participantId: "participant-a", role: "participant" });
    });
    expect(result.current.connection).toBe("live");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
      await Promise.resolve();
    });
    expect(draftReadCount).toBe(2);
    expect(result.current.agentDrafts).toEqual([draft]);
    expect(result.current.connection).toBe("live");
  });

  it("sends a title-specific compare-and-set rename and accepts the returned room", async () => {
    const current = room("room-a", 3, ["participant-a"]);
    const renamed = { ...room("room-a", 4, ["participant-a"]), title: "Architecture review" };
    mocks.apiRequest.mockResolvedValueOnce({ ok: true, room: renamed, participantId: "participant-a" });
    const { result } = renderHook(() => useRoom("room-a"));
    act(() => {
      realtimeFor("room-a").onSnapshot(current, { cursor: null, replayTruncated: false });
    });

    await act(async () => {
      await result.current.renameRoom("Architecture review", current.title);
    });

    expect(mocks.apiRequest).toHaveBeenCalledWith("/api/rooms/room-a", {
      method: "PATCH",
      body: JSON.stringify({
        action: "rename",
        title: "Architecture review",
        expectedTitle: current.title,
      }),
    });
    expect(result.current.room?.title).toBe("Architecture review");
  });

  it("projects newer transient motion without advancing state and resists older durable keyframes", () => {
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");
    act(() => {
      realtime.onSnapshot(room("room-a", 1, ["participant-a", "participant-b"], 1), {
        cursor: null,
        replayTruncated: false,
      });
      realtime.onTransientPresence?.({
        participantId: "participant-b",
        connectionId: "connection-b",
        clientSequence: 1,
        clientTime: 9,
        serverTime: 10,
        cursor: { x: 100, y: 200 },
        viewport: null,
      });
      realtime.onEvent(presenceEvent(2, 1, "participant-b"), {
        cursor: null,
        replay: false,
      });
    });

    expect(result.current.room).toMatchObject({
      stateRevision: 2,
      participants: {
        "participant-b": { human: { cursor: { x: 100, y: 200 } } },
      },
    });
    expect(result.current.transientPresence({ cursor: null, viewport: null })).toBe(true);
    expect(mocks.realtimePublishTransient).toHaveBeenCalledWith({
      cursor: null,
      viewport: null,
    });

    const durable = presenceEvent(3, 1, "participant-b");
    if ("presence" in durable.payload) {
      durable.payload.lastSeenAt = 11;
      durable.payload.presence.lastSeenAt = 11;
      durable.payload.presence.cursor = { x: 25, y: 35 };
    }
    act(() => realtime.onEvent(durable, { cursor: null, replay: false }));
    expect(result.current.room).toMatchObject({
      stateRevision: 3,
      participants: {
        "participant-b": { human: { cursor: { x: 25, y: 35 }, lastSeenAt: 11 } },
      },
    });
  });

  it("accepts awareness-only state while preserving the document revision", () => {
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");

    act(() => {
      realtime.onSnapshot(room("room-a", 4, ["participant-a"], 10), {
        cursor: "10-0",
        replayTruncated: false,
      });
      realtime.onSnapshot(room("room-a", 4, ["participant-a"], 11), {
        cursor: "11-0",
        replayTruncated: false,
      });
    });

    expect(result.current.room).toMatchObject({ roomRevision: 4, stateRevision: 11 });
  });

  it("patches realtime presence directly without fetching or replacing canvas state", () => {
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");
    const initial = room("room-a", 4, ["participant-a"], 10);
    initial.objects = {
      note: {
        id: "note",
        kind: "text",
        x: 1,
        y: 2,
        width: 100,
        height: 50,
        rotation: 0,
        zIndex: 0,
        revision: 1,
        groupId: null,
        diagramIds: [],
        createdAt: 1,
        updatedAt: 1,
        createdBy: { participantId: "participant-a", displayName: "A", color: "blue", kind: "human" },
        lastEditedBy: { participantId: "participant-a", displayName: "A", color: "blue", kind: "human" },
        content: "Stable",
        color: "black",
        size: "m",
        align: "start",
      },
    };

    act(() => {
      realtime.onSnapshot(initial, { cursor: "10-0", replayTruncated: false });
      realtime.onEvent(presenceEvent(11, 4), { cursor: "11-0", replay: false });
    });

    expect(result.current.room).toMatchObject({
      roomRevision: 4,
      stateRevision: 11,
      participants: { "participant-a": { human: { cursor: { x: 25, y: 35 } } } },
    });
    expect(result.current.room?.objects).toBe(initial.objects);
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it("uses the bounded presence response and patches it client-side", async () => {
    mocks.apiRequest.mockResolvedValueOnce({
      ok: true,
      presence: {
        roomId: "room-a",
        stateRevision: 11,
        roomRevision: 4,
        participantId: "participant-a",
        actorKind: "human",
        lastSeenAt: 11,
        connected: true,
        agentActive: false,
        presence: {
          cursor: { x: 25, y: 35 },
          viewport: null,
          lastSeenAt: 11,
          activity: null,
        },
      },
    });
    const { result } = renderHook(() => useRoom("room-a"));
    act(() => {
      realtimeFor("room-a").onSnapshot(room("room-a", 4, ["participant-a"], 10), {
        cursor: "10-0",
        replayTruncated: false,
      });
    });

    await act(async () => {
      await result.current.presence({ cursor: { x: 25, y: 35 }, viewport: null });
    });

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      "/api/rooms/room-a/presence",
      expect.objectContaining({
        method: "POST",
        headers: { "x-jazzboard-presence-protocol": "delta-v1" },
      }),
    );
    expect(result.current.room).toMatchObject({
      stateRevision: 11,
      participants: { "participant-a": { human: { cursor: { x: 25, y: 35 } } } },
    });
  });

  it("refreshes when a presence delta fences a document generation the client missed", async () => {
    const pending = deferred<{ ok: true; room: RoomState; participantId: string }>();
    mocks.apiRequest.mockImplementationOnce(() => pending.promise);
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");
    act(() => {
      realtime.onSnapshot(room("room-a", 4, ["participant-a"], 10), {
        cursor: "10-0",
        replayTruncated: false,
      });
      realtime.onEvent(presenceEvent(12, 5), { cursor: "12-0", replay: false });
    });
    expect(mocks.apiRequest).toHaveBeenCalledOnce();

    await act(async () => {
      pending.resolve({
        ok: true,
        room: room("room-a", 5, ["participant-a"], 12),
        participantId: "participant-a",
      });
      await pending.promise;
    });
    expect(result.current.room).toMatchObject({ roomRevision: 5, stateRevision: 12 });
  });

  it("refreshes once when a non-cumulative presence delta skips an awareness revision", async () => {
    const pending = deferred<{ ok: true; room: RoomState; participantId: string }>();
    mocks.apiRequest.mockImplementationOnce(() => pending.promise);
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");
    act(() => {
      realtime.onSnapshot(room("room-a", 4, ["participant-a"], 10), {
        cursor: "10-0",
        replayTruncated: false,
      });
      realtime.onEvent(presenceEvent(12, 4), { cursor: "12-0", replay: false });
    });
    expect(mocks.apiRequest).toHaveBeenCalledOnce();
    expect(result.current.room).toMatchObject({ stateRevision: 10 });

    await act(async () => {
      pending.resolve({
        ok: true,
        room: room("room-a", 4, ["participant-a"], 12),
        participantId: "participant-a",
      });
      await pending.promise;
    });
    expect(result.current.room).toMatchObject({ roomRevision: 4, stateRevision: 12 });
    expect(mocks.apiRequest).toHaveBeenCalledOnce();
  });

  it("applies exact consecutive deltas from interleaved participants without a read", () => {
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");
    act(() => {
      realtime.onSnapshot(room("room-a", 4, ["participant-a", "participant-b"], 10), {
        cursor: "10-0",
        replayTruncated: false,
      });
      realtime.onEvent(presenceEvent(11, 4, "participant-a"), { cursor: "11-0", replay: false });
      realtime.onEvent(presenceEvent(12, 4, "participant-b"), { cursor: "12-0", replay: false });
    });

    expect(result.current.room).toMatchObject({
      stateRevision: 12,
      participants: {
        "participant-a": { human: { lastSeenAt: 11 } },
        "participant-b": { human: { lastSeenAt: 12 } },
      },
    });
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it("refreshes a state-only compact invalidation without requiring a document revision", async () => {
    const pending = deferred<{ ok: true; room: RoomState; participantId: string }>();
    mocks.apiRequest.mockImplementationOnce(() => pending.promise);
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");

    act(() => {
      realtime.onSnapshot(room("room-a", 4, ["participant-a"], 10), {
        cursor: "10-0",
        replayTruncated: false,
      });
      realtime.onEvent(compactEvent(11, 4), { cursor: "11-0", replay: false });
    });

    await act(async () => {
      pending.resolve({
        ok: true,
        room: room("room-a", 4, ["participant-a"], 11),
        participantId: "participant-a",
      });
      await pending.promise;
    });

    expect(result.current.room).toMatchObject({ roomRevision: 4, stateRevision: 11 });
    expect(
      mocks.apiRequest.mock.calls.filter(([url]) => url === "/api/rooms/room-a"),
    ).toHaveLength(1);
  });

  it("coalesces compact realtime invalidations through one authoritative refresh", async () => {
    const pending = deferred<{ ok: true; room: RoomState; participantId: string }>();
    mocks.apiRequest.mockImplementationOnce(() => pending.promise);
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");

    act(() => {
      realtime.onSnapshot(room("room-a", 1, ["participant-a"]), {
        cursor: "1-0",
        replayTruncated: false,
      });
      realtime.onEvent(compactEvent(2), { cursor: "2-0", replay: false });
      realtime.onEvent(compactEvent(3), { cursor: "3-0", replay: false });
    });
    expect(
      mocks.apiRequest.mock.calls.filter(([url]) => url === "/api/rooms/room-a"),
    ).toHaveLength(1);

    await act(async () => {
      pending.resolve({
        ok: true,
        room: room("room-a", 3, ["participant-a"]),
        participantId: "participant-a",
      });
      await pending.promise;
    });

    expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
    expect(result.current.room?.roomRevision).toBe(3);
  });

  it("performs one trailing refresh when a newer invalidation races the first read", async () => {
    const first = deferred<{ ok: true; room: RoomState; participantId: string }>();
    const second = deferred<{ ok: true; room: RoomState; participantId: string }>();
    mocks.apiRequest
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");

    act(() => {
      realtime.onSnapshot(room("room-a", 1, ["participant-a"]), {
        cursor: "1-0",
        replayTruncated: false,
      });
      realtime.onEvent(compactEvent(2), { cursor: "2-0", replay: false });
      realtime.onEvent(compactEvent(3), { cursor: "3-0", replay: false });
    });

    await act(async () => {
      first.resolve({
        ok: true,
        room: room("room-a", 2, ["participant-a"]),
        participantId: "participant-a",
      });
      await first.promise;
    });
    expect(mocks.apiRequest).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({
        ok: true,
        room: room("room-a", 3, ["participant-a"]),
        participantId: "participant-a",
      });
      await second.promise;
    });
    expect(result.current.room?.roomRevision).toBe(3);
  });

  it("accepts a legacy full-state event without fetching when it covers the event revision", () => {
    const { result } = renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");
    const nextRoom = room("room-a", 2, ["participant-a"]);

    act(() => {
      realtime.onSnapshot(room("room-a", 1, ["participant-a"]), {
        cursor: "1-0",
        replayTruncated: false,
      });
      realtime.onEvent(
        { ...compactEvent(2), payload: { room: nextRoom } },
        { cursor: "2-0", replay: false },
      );
    });

    expect(result.current.room?.roomRevision).toBe(2);
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it("never exposes the previous room while navigation invalidates its pending work", async () => {
    const oldRefresh = deferred<{ ok: true; room: RoomState; participantId: string }>();
    const nextRoom = room("room-b", 1, ["participant-b"]);
    mocks.apiRequest
      .mockImplementationOnce(() => oldRefresh.promise)
      .mockResolvedValueOnce({ ok: true, room: nextRoom, participantId: "participant-b" });

    const { result, rerender } = renderHook(({ roomId }) => useRoom(roomId), {
      initialProps: { roomId: "room-a" },
    });

    let pendingOldRefresh!: Promise<RoomState>;
    act(() => {
      pendingOldRefresh = result.current.refresh();
    });

    rerender({ roomId: "room-b" });
    expect(result.current.room).toBeNull();
    expect(result.current.participantId).toBeNull();
    expect(result.current.self).toBeNull();
    expect(result.current.connection).toBe("connecting");
    expect(result.current.error).toBeNull();

    await act(async () => {
      oldRefresh.resolve({
        ok: true,
        room: room("room-a", 99, ["participant-a"]),
        participantId: "participant-a",
      });
      await pendingOldRefresh;
    });

    expect(result.current.room).toBeNull();
    expect(result.current.participantId).toBeNull();
    expect(result.current.connection).toBe("connecting");

    act(() => {
      realtimeFor("room-a").onSnapshot(room("room-a", 100), {
        cursor: null,
        replayTruncated: false,
      });
      realtimeFor("room-a").onStatusChange?.("connected");
    });
    expect(result.current.room).toBeNull();
    expect(result.current.connection).toBe("connecting");

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.room).toBe(nextRoom);
    expect(result.current.participantId).toBe("participant-b");
    expect(result.current.self?.participantId).toBe("participant-b");
    expect(result.current.connection).toBe("polling");
  });

  it("does not revive a request or realtime connection from an earlier visit to the same room", async () => {
    const firstVisit = deferred<{ ok: true; room: RoomState; participantId: string }>();
    const currentRoom = room("room-a", 2, ["participant-current"]);
    mocks.apiRequest
      .mockImplementationOnce(() => firstVisit.promise)
      .mockResolvedValueOnce({
        ok: true,
        room: currentRoom,
        participantId: "participant-current",
      });
    const { result, rerender } = renderHook(({ roomId }) => useRoom(roomId), {
      initialProps: { roomId: "room-a" },
    });
    const firstConnection = realtimeFor("room-a");

    let staleRefresh!: Promise<RoomState>;
    act(() => {
      staleRefresh = result.current.refresh();
    });
    rerender({ roomId: "room-b" });
    rerender({ roomId: "room-a" });

    await act(async () => {
      firstVisit.resolve({
        ok: true,
        room: room("room-a", 100, ["participant-stale"]),
        participantId: "participant-stale",
      });
      await staleRefresh;
      firstConnection.onSnapshot(room("room-a", 101), {
        cursor: null,
        replayTruncated: false,
      });
      firstConnection.onStatusChange?.("connected");
    });

    expect(result.current.room).toBeNull();
    expect(result.current.participantId).toBeNull();
    expect(result.current.connection).toBe("connecting");

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.room).toBe(currentRoom);
    expect(result.current.participantId).toBe("participant-current");
  });

  it("rejects a mismatched room returned by the current endpoint", async () => {
    mocks.apiRequest.mockResolvedValueOnce({
      ok: true,
      room: room("room-b", 8, ["participant-b"]),
      participantId: "participant-b",
    });
    const { result } = renderHook(() => useRoom("room-a"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.room).toBeNull();
    expect(result.current.participantId).toBeNull();
    expect(result.current.self).toBeNull();
    expect(result.current.connection).toBe("connecting");
    expect(result.current.error).toBeNull();
  });

  it("lets every matching response advance room state but only the latest refresh set identity and status", async () => {
    const first = deferred<{ ok: true; room: RoomState; participantId: string }>();
    const second = deferred<{ ok: true; room: RoomState; participantId: string }>();
    mocks.apiRequest
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result } = renderHook(() => useRoom("room-a"));

    let firstRefresh!: Promise<RoomState>;
    let secondRefresh!: Promise<RoomState>;
    act(() => {
      firstRefresh = result.current.refresh();
      secondRefresh = result.current.refresh();
    });

    await act(async () => {
      second.resolve({
        ok: true,
        room: room("room-a", 5, ["participant-new", "participant-old"]),
        participantId: "participant-new",
      });
      await secondRefresh;
    });
    expect(result.current.room?.roomRevision).toBe(5);
    expect(result.current.participantId).toBe("participant-new");
    expect(result.current.connection).toBe("polling");

    await act(async () => {
      first.resolve({
        ok: true,
        room: room("room-a", 6, ["participant-new", "participant-old"]),
        participantId: "participant-old",
      });
      await firstRefresh;
    });

    expect(result.current.room?.roomRevision).toBe(6);
    expect(result.current.participantId).toBe("participant-new");
    expect(result.current.self?.participantId).toBe("participant-new");
    expect(result.current.connection).toBe("polling");
  });

  it("keeps realtime connection status when an invalidated refresh later fails", async () => {
    const request = deferred<{ ok: true; room: RoomState; participantId: string }>();
    mocks.apiRequest.mockImplementationOnce(() => request.promise);
    const { result } = renderHook(() => useRoom("room-a"));

    let pendingRefresh!: Promise<RoomState>;
    act(() => {
      pendingRefresh = result.current.refresh();
    });
    act(() => {
      realtimeFor("room-a").onStatusChange?.("connected");
    });
    expect(result.current.connection).toBe("live");

    const staleFailure = new Error("stale poll failed");
    await act(async () => {
      request.reject(staleFailure);
      await expect(pendingRefresh).rejects.toBe(staleFailure);
    });

    expect(result.current.connection).toBe("live");
    expect(result.current.error).toBeNull();
  });

  it("coalesces delayed automatic polls and initializes identity after realtime advances status", async () => {
    const delayed = deferred<{ ok: true; room: RoomState; participantId: string }>();
    mocks.apiRequest.mockImplementationOnce(() => delayed.promise);
    const { result } = renderHook(() => useRoom("room-a"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      mocks.apiRequest.mock.calls.filter(([url]) => url === "/api/rooms/room-a"),
    ).toHaveLength(1);

    act(() => {
      realtimeFor("room-a").onStatusChange?.("connected");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_500);
    });
    expect(
      mocks.apiRequest.mock.calls.filter(([url]) => url === "/api/rooms/room-a"),
    ).toHaveLength(1);
    expect(result.current.connection).toBe("live");

    await act(async () => {
      delayed.resolve({
        ok: true,
        room: room("room-a", 7, ["participant-delayed"]),
        participantId: "participant-delayed",
      });
      await delayed.promise;
    });

    expect(result.current.room?.roomRevision).toBe(7);
    expect(result.current.participantId).toBe("participant-delayed");
    expect(result.current.self?.participantId).toBe("participant-delayed");
    expect(result.current.connection).toBe("live");
    expect(result.current.error).toBeNull();
  });

  it("waits through a sustained realtime outage before starting fallback reads", async () => {
    let roomReads = 0;
    let draftReads = 0;
    mocks.apiRequest.mockImplementation((url: string) => {
      if (url.endsWith("/drafts")) {
        draftReads += 1;
        return Promise.resolve({ ok: true, drafts: [], serverTime: Date.now() });
      }
      roomReads += 1;
      return Promise.resolve({
        ok: true,
        room: room("room-a", roomReads, ["participant-a"]),
        participantId: "participant-a",
      });
    });
    renderHook(() => useRoom("room-a"));

    act(() => {
      realtimeFor("room-a").onStatusChange?.("reconnecting");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(roomReads).toBe(1);
    expect(draftReads).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });
    expect(roomReads).toBe(2);
    expect(draftReads).toBe(1);
  });

  it("cancels fallback reads on recovery and requires a fresh outage grace period", async () => {
    let roomReads = 0;
    let draftReads = 0;
    mocks.apiRequest.mockImplementation((url: string) => {
      if (url.endsWith("/drafts")) {
        draftReads += 1;
        return Promise.resolve({ ok: true, drafts: [], serverTime: Date.now() });
      }
      roomReads += 1;
      return Promise.resolve({
        ok: true,
        room: room("room-a", roomReads, ["participant-a"]),
        participantId: "participant-a",
      });
    });
    renderHook(() => useRoom("room-a"));
    const realtime = realtimeFor("room-a");

    act(() => realtime.onStatusChange?.("reconnecting"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(4_000);
    });
    act(() => realtime.onStatusChange?.("connected"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(roomReads).toBe(1);
    expect(draftReads).toBe(1);

    act(() => realtime.onStatusChange?.("reconnecting"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(roomReads).toBe(1);
    expect(draftReads).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });
    expect(roomReads).toBeGreaterThan(1);
    expect(draftReads).toBeGreaterThanOrEqual(1);
  });

  it("polls idle drafts slowly but preserves the active-draft fallback cadence", async () => {
    let roomReads = 0;
    let draftReads = 0;
    mocks.apiRequest.mockImplementation((url: string) => {
      if (url.endsWith("/drafts")) {
        draftReads += 1;
        return Promise.resolve({ ok: true, drafts: [], serverTime: Date.now() });
      }
      roomReads += 1;
      return Promise.resolve({
        ok: true,
        room: room("room-a", roomReads, ["participant-a"]),
        participantId: "participant-a",
      });
    });
    const { result } = renderHook(() => useRoom("room-a"));
    act(() => realtimeFor("room-a").onStatusChange?.("reconnecting"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(draftReads).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(draftReads).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(draftReads).toBe(2);

    act(() => {
      result.current.acceptAgentDraft(agentDraft());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(draftReads).toBe(3);

    act(() => realtimeFor("room-a").onStatusChange?.("connected"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(draftReads).toBe(3);
  });

  it("backs off an exhausted draft refresh instead of retrying every two seconds", async () => {
    let draftReads = 0;
    mocks.apiRequest.mockImplementation((url: string) => {
      if (url.endsWith("/drafts")) {
        draftReads += 1;
        return Promise.reject(new Error("Redis temporarily unavailable"));
      }
      return Promise.resolve({
        ok: true,
        room: room("room-a", 1, ["participant-a"]),
        participantId: "participant-a",
      });
    });
    renderHook(() => useRoom("room-a"));

    act(() => {
      realtimeFor("room-a").onReady?.({
        connectionId: "connection-a",
        participantId: "participant-a",
        role: "participant",
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(480);
    });
    expect(draftReads).toBe(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_519);
    });
    expect(draftReads).toBe(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(draftReads).toBe(4);
  });
});
