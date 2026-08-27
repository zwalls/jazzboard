import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Participant, RoomState } from "@/lib/domain/types";
import type { RoomRealtimeOptions } from "@/lib/realtime/client";

import { shouldAcceptRoomRevision, useRoom } from "./use-room";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  realtimeOptions: [] as unknown[],
  realtimeClose: vi.fn(),
}));

vi.mock("@/lib/client/api", () => ({
  apiRequest: mocks.apiRequest,
  JazzboardApiError: class JazzboardApiError extends Error {},
}));

vi.mock("@/lib/realtime/client", () => ({
  connectRoomRealtime: vi.fn((options: unknown) => {
    mocks.realtimeOptions.push(options);
    return { close: mocks.realtimeClose };
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

function room(id: string, roomRevision: number, participantIds: string[] = []): RoomState {
  return {
    id,
    code: id,
    title: `${id} revision ${roomRevision}`,
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

beforeEach(() => {
  vi.useFakeTimers();
  mocks.apiRequest.mockReset();
  mocks.realtimeOptions.length = 0;
  mocks.realtimeClose.mockReset();
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

describe("useRoom request ordering", () => {
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
      await vi.advanceTimersByTimeAsync(2_500);
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
