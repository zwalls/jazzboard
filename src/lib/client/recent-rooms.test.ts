import { describe, expect, it } from "vitest";

import type { RecentRoom } from "@/lib/domain/types";

import {
  DISPLAY_NAME_KEY,
  MAX_RECENT_ROOMS,
  RECENT_ROOMS_KEY,
  normalizeRecentRooms,
  persistDisplayName,
  readDisplayName,
  readRecentRooms,
  removeRecentRoom,
  touchRecentRoom,
  upsertRecentRoom,
  type BrowserStorage,
} from "./recent-rooms";

class MemoryStorage implements BrowserStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function room(index: number, overrides: Partial<RecentRoom> = {}): RecentRoom {
  const symbol = "23456789"[index % 8];
  return {
    roomId: `room-${index}`,
    code: `ABC${symbol.repeat(3)}`,
    title: `Room ${index}`,
    role: "participant",
    lastOpenedAt: index,
    ...overrides,
  };
}

describe("browser-private recent rooms", () => {
  it("validates, de-duplicates, orders, and bounds local references", () => {
    const values: unknown[] = [
      { ...room(2), lastOpenedAt: 2 },
      { ...room(2), title: "Newest duplicate", lastOpenedAt: 20 },
      { ...room(3), code: "room" },
      ...Array.from({ length: 12 }, (_, index) => room(index + 10)),
    ];

    const normalized = normalizeRecentRooms(values);

    expect(normalized).toHaveLength(MAX_RECENT_ROOMS);
    expect(normalized.map((entry) => entry.lastOpenedAt)).toEqual([21, 20, 20, 19, 18, 17, 16, 15]);
    expect(normalized.find((entry) => entry.roomId === "room-2")?.title).toBe("Newest duplicate");
    expect(normalized.some((entry) => entry.roomId === "room-3")).toBe(false);
  });

  it("retains current canonical codes and exact legacy four-digit recents", () => {
    expect(normalizeRecentRooms([
      room(1, { roomId: "current", code: "ABC234" }),
      room(2, { roomId: "legacy", code: "1234" }),
      room(3, { roomId: "formatted", code: "ABC-234" }),
    ]).map((entry) => entry.roomId)).toEqual(["legacy", "current"]);
  });

  it("returns an empty list for malformed or inaccessible browser storage", () => {
    const malformed = new MemoryStorage();
    malformed.values.set(RECENT_ROOMS_KEY, "not-json");
    expect(readRecentRooms(malformed)).toEqual([]);

    const inaccessible: BrowserStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    expect(readRecentRooms(inaccessible)).toEqual([]);
  });

  it("upserts, touches, and removes only the named local reference", () => {
    const storage = new MemoryStorage();
    upsertRecentRoom(room(1), storage);
    upsertRecentRoom(room(2), storage);

    const touched = touchRecentRoom("room-1", 100, storage);
    expect(touched?.rooms.map((entry) => entry.roomId)).toEqual(["room-1", "room-2"]);
    expect(touched?.room.lastOpenedAt).toBe(100);

    const removed = removeRecentRoom("room-1", storage);
    expect(removed.removed?.roomId).toBe("room-1");
    expect(readRecentRooms(storage).map((entry) => entry.roomId)).toEqual(["room-2"]);
  });

  it("persists the display-name convenience independently", () => {
    const storage = new MemoryStorage();
    expect(persistDisplayName("Maya", storage)).toBe(true);
    expect(storage.values.get(DISPLAY_NAME_KEY)).toBe("Maya");
    expect(readDisplayName(storage)).toBe("Maya");
  });
});
