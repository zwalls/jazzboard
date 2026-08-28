import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Participant, RoomEvent, RoomState } from "@/lib/domain/types";
import type { RoomRealtimeOptions } from "@/lib/realtime/client";

import {
  applyTransientHumanPresence,
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
    expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
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
    expect(mocks.apiRequest).toHaveBeenCalledTimes(1);

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
    expect(mocks.apiRequest).toHaveBeenCalledTimes(1);

    act(() => {
      realtimeFor("room-a").onStatusChange?.("connected");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_500);
    });
    expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
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
});
