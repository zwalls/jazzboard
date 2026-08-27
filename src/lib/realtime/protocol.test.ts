// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { RoomEvent, RoomState } from "@/lib/domain/types";

import {
  compareStreamCursors,
  isRoomEvent,
  parseRealtimeClientMessage,
  parseRealtimeServerMessage,
  parseStreamCursor,
} from "./protocol";
import {
  applyPresenceDelta,
  compactRoomEvent,
  legacyRoomStateFromEvent,
  presenceDeltaFromEvent,
  roomEventDocumentRevision,
  roomEventStateRevision,
  roomStateRevision,
} from "./events";
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
    expect(parseRealtimeClientMessage({
      type: "presence.transient",
      clientSequence: 4,
      clientTime: 123,
      cursor: { x: 10, y: 20 },
      viewport: { x: 0, y: 0, zoom: 1, width: 800, height: 600 },
    })).toMatchObject({ type: "presence.transient", clientSequence: 4 });
    expect(parseRealtimeClientMessage({
      type: "presence.transient",
      clientSequence: -1,
      clientTime: 123,
      cursor: null,
      viewport: null,
    })).toBeNull();
    expect(parseRealtimeClientMessage({ type: "canvas.mutate", command: {} })).toBeNull();
  });

  it("validates bounded transient presence without assigning a room revision", () => {
    const transient = {
      type: "presence.transient" as const,
      roomId: "room_1",
      participantId: "p_1",
      connectionId: "connection_1",
      clientSequence: 8,
      clientTime: 1_000,
      serverTime: 1_005,
      cursor: { x: 12, y: 13 },
      viewport: { x: 0, y: 0, zoom: 1.5, width: 1_200, height: 800 },
    };
    expect(parseRealtimeServerMessage(transient)).toEqual(transient);
    expect(transient).not.toHaveProperty("stateRevision");
    expect(parseRealtimeServerMessage({ ...transient, viewport: { ...transient.viewport, zoom: 0 } }))
      .toBeNull();
  });

  it("accepts compact and legacy event payloads while rejecting inconsistent revisions", () => {
    const legacyEvent: RoomEvent = { ...event, payload: { room: legacyRoom, activity: null } };
    const stateEvent: RoomEvent = {
      ...event,
      sequence: 7,
      payload: {
        schemaVersion: 3,
        kind: "room.invalidated",
        stateRevision: 7,
        roomRevision: 4,
        activityId: null,
      },
    };
    expect(isRoomEvent(event)).toBe(true);
    expect(roomEventDocumentRevision(event)).toBe(0);
    expect(roomEventStateRevision(event)).toBe(4);
    expect(isRoomEvent(stateEvent)).toBe(true);
    expect(isRoomEvent(legacyEvent)).toBe(true);
    expect(
      isRoomEvent({
        ...event,
        payload: { ...event.payload, roomRevision: event.sequence + 1 },
      }),
    ).toBe(false);
    expect(
      isRoomEvent({
        ...stateEvent,
        payload: { ...stateEvent.payload, stateRevision: stateEvent.sequence + 1 },
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
      schemaVersion: 3,
      kind: "room.invalidated",
      stateRevision: 4,
      roomRevision: 0,
      activityId: null,
    });
    expect(compact.payload).not.toHaveProperty("room");
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(512);
  });

  it("validates and directly applies a bounded document-fenced presence delta", () => {
    const source: RoomState = {
      ...legacyRoom,
      stateRevision: 10,
      participants: {
        p_1: {
          participantId: "p_1",
          displayName: "Ada",
          color: "blue",
          role: "participant",
          joinedAt: 1,
          lastSeenAt: 1,
          connected: true,
          agentActive: false,
          human: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
          agent: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
        },
      },
    };
    const deltaEvent: RoomEvent = {
      id: "presence_11",
      roomId: source.id,
      sequence: 11,
      occurredAt: 11,
      type: "presence.updated",
      actor: null,
      payload: {
        schemaVersion: 4,
        kind: "presence.delta",
        stateRevision: 11,
        roomRevision: 4,
        participantId: "p_1",
        actorKind: "human",
        lastSeenAt: 11,
        connected: true,
        agentActive: false,
        presence: {
          cursor: { x: 10, y: 20 },
          viewport: null,
          lastSeenAt: 11,
          activity: null,
        },
      },
    };

    expect(isRoomEvent(deltaEvent)).toBe(true);
    const delta = presenceDeltaFromEvent(deltaEvent)!;
    expect(Buffer.byteLength(JSON.stringify(deltaEvent))).toBeLessThan(1_024);
    expect(applyPresenceDelta(source, delta)).toMatchObject({
      roomRevision: 4,
      stateRevision: 11,
      participants: { p_1: { human: { cursor: { x: 10, y: 20 } } } },
    });
    expect(applyPresenceDelta({ ...source, roomRevision: 5 }, delta)).toBeNull();
    expect(applyPresenceDelta({ ...source, stateRevision: 9 }, delta)).toBeNull();
    expect(applyPresenceDelta({ ...source, stateRevision: 11 }, delta)).toBeNull();
    expect(isRoomEvent({
      ...deltaEvent,
      payload: { ...deltaEvent.payload, stateRevision: 12 },
    })).toBe(false);
  });

  it("normalizes legacy rooms and keeps document and state revisions distinct", () => {
    const legacyEvent: RoomEvent = { ...event, payload: { room: legacyRoom } };
    const normalized = legacyRoomStateFromEvent(legacyEvent);
    expect(normalized).toMatchObject({ roomRevision: 4, stateRevision: 4 });
    expect(roomEventDocumentRevision(legacyEvent)).toBe(0);
    expect(roomEventStateRevision(legacyEvent)).toBe(4);

    const statefulRoom: RoomState = { ...legacyRoom, stateRevision: 9 };
    const statefulEvent: RoomEvent = {
      ...event,
      sequence: 9,
      payload: { room: statefulRoom },
    };
    expect(isRoomEvent(statefulEvent)).toBe(true);
    expect(legacyRoomStateFromEvent(statefulEvent)).toBe(statefulRoom);
    expect(roomEventDocumentRevision(statefulEvent)).toBe(4);
    expect(roomEventStateRevision(statefulEvent)).toBe(9);
    expect(roomStateRevision(statefulRoom)).toBe(9);
    expect(roomStateRevision(legacyRoom)).toBe(4);
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
