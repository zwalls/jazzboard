// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { RoomEvent } from "@/lib/domain/types";

import {
  compareStreamCursors,
  parseRealtimeClientMessage,
  parseStreamCursor,
} from "./protocol";
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
  payload: {},
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

  it("decodes room-store Stream records and rejects corrupt or mismatched entries", () => {
    const encoded = JSON.stringify(event);
    expect(
      decodeStreamEntries([["100-1", ["roomId", "room_1", "data", encoded]]]),
    ).toEqual([{ cursor: "100-1", event }]);
    expect(
      decodeXRead([["jazzboard:events", [["100-1", ["roomId", "room_1", "data", encoded]]]]]),
    ).toEqual([{ cursor: "100-1", event }]);
    expect(decodeStreamEntries([["100-1", ["roomId", "room_other", "data", encoded]]])).toEqual([]);
    expect(decodeStreamEntries([["not-a-cursor", ["data", encoded]]])).toEqual([]);
    expect(decodeStreamEntries([["100-1", ["data", "not-json"]]])).toEqual([]);
    expect(latestCursorFromStreamEntries([["101-0", ["data", "not-json"]]])).toBe("101-0");
    expect(latestCursorFromXRead([["jazzboard:events", [["102-0", ["data", "not-json"]]]]])).toBe(
      "102-0",
    );
  });
});
