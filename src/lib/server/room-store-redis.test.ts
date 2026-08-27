// @vitest-environment node

import type Redis from "ioredis";
import { describe, expect, it, vi } from "vitest";

import type { RoomEvent } from "@/lib/domain/types";

import { RedisRoomStore } from "./room-store";

describe("RedisRoomStore event persistence", () => {
  it("creates the code, authoritative room, and compact invalidation in one Redis operation", async () => {
    const redis = {
      eval: vi.fn(async () => 1),
    } as unknown as Redis;
    const store = new RedisRoomStore(redis);

    const room = await store.createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Atomic room",
    });

    expect(redis.eval).toHaveBeenCalledOnce();
    const args = vi.mocked(redis.eval).mock.calls[0];
    expect(args[1]).toBe(3);
    expect(args[2]).toBe(`jazzboard:code:${room.code}`);
    expect(args[3]).toBe(`jazzboard:room:${room.id}`);
    expect(args[4]).toBe("jazzboard:events");
    expect(args[5]).toBe(room.id);
    expect(JSON.parse(String(args[6]))).toMatchObject({ id: room.id, code: room.code, roomRevision: 1 });

    const event = JSON.parse(String(args[7])) as RoomEvent;
    expect(event).toMatchObject({
      roomId: room.id,
      sequence: 1,
      type: "room.snapshot",
      payload: {
        schemaVersion: 2,
        kind: "room.invalidated",
        roomRevision: 1,
        activityId: null,
      },
    });
    expect(event.payload).not.toHaveProperty("room");
    expect(Buffer.byteLength(String(args[7]))).toBeLessThan(512);
  });
});
