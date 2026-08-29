import type { RecentRoom } from "@/lib/domain/types";
import { isSupportedRoomCode } from "@/lib/domain/room-code";

export const RECENT_ROOMS_KEY = "jazzboard:recent-rooms:v1";
export const DISPLAY_NAME_KEY = "jazzboard:display-name:v1";
export const MAX_RECENT_ROOMS = 8;

export type BrowserStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): BrowserStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function isRecentRoom(value: unknown): value is RecentRoom {
  if (!value || typeof value !== "object") return false;
  const room = value as Partial<RecentRoom>;
  return (
    typeof room.roomId === "string" &&
    room.roomId.length > 0 &&
    room.roomId.length <= 512 &&
    typeof room.code === "string" &&
    isSupportedRoomCode(room.code) &&
    typeof room.title === "string" &&
    room.title.length > 0 &&
    room.title.length <= 100 &&
    (room.role === "participant" || room.role === "spectator") &&
    typeof room.lastOpenedAt === "number" &&
    Number.isFinite(room.lastOpenedAt) &&
    room.lastOpenedAt >= 0
  );
}

export function normalizeRecentRooms(values: readonly unknown[]): RecentRoom[] {
  const byRoomId = new Map<string, RecentRoom>();
  for (const value of values) {
    if (!isRecentRoom(value)) continue;
    const current = byRoomId.get(value.roomId);
    if (!current || value.lastOpenedAt > current.lastOpenedAt) byRoomId.set(value.roomId, value);
  }
  return [...byRoomId.values()]
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
    .slice(0, MAX_RECENT_ROOMS);
}

/**
 * Reads only this origin's browser-local access history. It never calls the
 * room service and therefore cannot enumerate rooms belonging to anyone else.
 */
export function readRecentRooms(storage: BrowserStorage | null = defaultStorage()): RecentRoom[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_ROOMS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeRecentRooms(parsed) : [];
  } catch {
    return [];
  }
}

export function persistRecentRooms(
  rooms: readonly RecentRoom[],
  storage: BrowserStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(RECENT_ROOMS_KEY, JSON.stringify(normalizeRecentRooms(rooms)));
    return true;
  } catch {
    // A disabled or full local store should never prevent entering a room.
    return false;
  }
}

export function upsertRecentRoom(
  room: RecentRoom,
  storage: BrowserStorage | null = defaultStorage(),
): { rooms: RecentRoom[]; stored: boolean } {
  const rooms = normalizeRecentRooms([room, ...readRecentRooms(storage)]);
  return { rooms, stored: persistRecentRooms(rooms, storage) };
}

export function touchRecentRoom(
  roomId: string,
  lastOpenedAt: number,
  storage: BrowserStorage | null = defaultStorage(),
): { room: RecentRoom; rooms: RecentRoom[]; stored: boolean } | null {
  const current = readRecentRooms(storage);
  const room = current.find((entry) => entry.roomId === roomId);
  if (!room) return null;
  const touched = { ...room, lastOpenedAt };
  const rooms = normalizeRecentRooms([touched, ...current.filter((entry) => entry.roomId !== roomId)]);
  return { room: touched, rooms, stored: persistRecentRooms(rooms, storage) };
}

export function removeRecentRoom(
  roomId: string,
  storage: BrowserStorage | null = defaultStorage(),
): { removed: RecentRoom | null; rooms: RecentRoom[]; stored: boolean } {
  const current = readRecentRooms(storage);
  const removed = current.find((entry) => entry.roomId === roomId) ?? null;
  const rooms = current.filter((entry) => entry.roomId !== roomId);
  return { removed, rooms, stored: persistRecentRooms(rooms, storage) };
}

export function readDisplayName(storage: BrowserStorage | null = defaultStorage()): string {
  if (!storage) return "";
  try {
    return storage.getItem(DISPLAY_NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function persistDisplayName(
  displayName: string,
  storage: BrowserStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(DISPLAY_NAME_KEY, displayName);
    return true;
  } catch {
    return false;
  }
}
