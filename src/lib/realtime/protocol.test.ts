// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { RoomEvent, RoomState } from "@/lib/domain/types";

import {
  compareStreamCursors,
  isRoomEvent,
  parseRealtimeClientMessage,
  parseStreamCursor,
} from "./protocol";
import { compactRoomEvent } from "./events";
import {
  decodeStreamEntries,
  decodeXRead,
  latestCursorFromStreamEntries,
  latestCursorFromXRead,
} from "./redis-stream";

const event: RoomEvent = {
  id: "event_1",
  roomId: "room_1",
  sequence: 4,
  occurredAt: 1_000,
  type: "room.updated",
  actor: null,
  payload: {
    schemaVersion: 2,
    kind: "room.invalidated",
    roomRevision: 4,
    activityId: null,
  },
};

const legacyRoom: RoomState = {
  id: "room_1",
  code: "1234",
  title: "Legacy room snapshot",
  roomRevision: 4,
  createdAt: 1,
  updatedAt: 4,
  participants: {},
  objects: {},
  diagrams: {},
  leases: {},
  spotlight: null,
  agentEditPolicy: "live",
  reviewProposals: [],
};

describe("realtime protocol", () => {
  it("validates resumable Redis Stream cursors without losing 64-bit precision", () => {
    expect(parseStreamCursor("1720000000000-42")).toBe("1720000000000-42");
    expect(parseStreamCursor("$")).toBeNull();
    expect(parseStreamCursor("1")).toBeNull();
    expect(compareStreamCursors("9999999999999999999-1", "9999999999999999998-999")).toBe(1);
  });

  it("accepts only the small client control-message surface", () => {
    expect(parseRealtimeClientMessage({ type: "ping", clientTime: 123 })).toEqual({
      type: "ping",
      clientTime: 123,
    });
    expect(parseRealtimeClientMessage({ type: "sync.request", cursor: "10-2" })).toEqual({
      type: "sync.request",
      cursor: "10-2",
    });
    expect(parseRealtimeClientMessage({ type: "sync.request", cursor: "$" })).toBeNull();
    expect(parseRealtimeClientMessage({ type: "canvas.mutate", command: {} })).toBeNull();
  });

  it("accepts compact and legacy event payloads while rejecting inconsistent revisions", () => {
    const legacyEvent: RoomEvent = { ...event, payload: { room: legacyRoom, activity: null } };
    expect(isRoomEvent(event)).toBe(true);
    expect(isRoomEvent(legacyEvent)).toBe(true);
    expect(
      isRoomEvent({
        ...event,
        payload: { ...event.payload, roomRevision: event.sequence + 1 },
      }),
    ).toBe(false);
    expect(
      isRoomEvent({
        ...legacyEvent,
        payload: { room: { ...legacyRoom, id: "room_other" } },
      }),
    ).toBe(false);
    expect(
      isRoomEvent({
        ...legacyEvent,
        payload: { room: { id: "room_1", roomRevision: 4 } },
      }),
    ).toBe(false);

    const compact = compactRoomEvent(legacyEvent);
    expect(compact.payload).toEqual({
      schemaVersion: 2,
      kind: "room.invalidated",
      roomRevision: 4,
      activityId: null,
    });
    expect(compact.payload).not.toHaveProperty("room");
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(512);
  });

  it("decodes room-store Stream records and rejects corrupt or mismatched entries", () => {
    const encoded = JSON.stringify(event);
    const legacyEvent: RoomEvent = { ...event, payload: { room: legacyRoom } };
    expect(
      decodeStreamEntries([["100-1", ["roomId", "room_1", "data", encoded]]]),
    ).toEqual([{ cursor: "100-1", event }]);
    expect(
      decodeXRead([["jazzboard:events", [["100-1", ["roomId", "room_1", "data", encoded]]]]]),
    ).toEqual([{ cursor: "100-1", event }]);
    expect(
      decodeStreamEntries([
        ["100-1", ["roomId", "room_1", "data", encoded]],
        ["100-2", ["roomId", "room_1", "data", JSON.stringify(legacyEvent)]],
      ]),
    ).toEqual([
      { cursor: "100-1", event },
      { cursor: "100-2", event: legacyEvent },
    ]);
    expect(decodeStreamEntries([["100-1", ["roomId", "room_other", "data", encoded]]])).toEqual([]);
    expect(decodeStreamEntries([["not-a-cursor", ["data", encoded]]])).toEqual([]);
    expect(decodeStreamEntries([["100-1", ["data", "not-json"]]])).toEqual([]);
    expect(latestCursorFromStreamEntries([["101-0", ["data", "not-json"]]])).toBe("101-0");
    expect(latestCursorFromXRead([["jazzboard:events", [["102-0", ["data", "not-json"]]]]])).toBe(
      "102-0",
    );
  });
});
