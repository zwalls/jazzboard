/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import { JazzboardApiError } from "@/lib/client/api";
import {
  DISPLAY_NAME_KEY,
  RECENT_ROOMS_KEY,
  type BrowserStorage,
} from "@/lib/client/recent-rooms";
import type { RecentRoom, RoomRole, RoomState } from "@/lib/domain/types";

import {
  createJazzboardLandingWebMcpTools,
  JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES,
} from "./landing-tools";
import type { JazzboardLandingWebMcpBinding } from "./landing-types";
import type { JazzboardToolSuccess, WebMcpRequest } from "./types";

class MemoryStorage implements BrowserStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function roomResponse(role: RoomRole = "participant", title = "Private architecture") {
  return {
    ok: true as const,
    participantId: "participant-1",
    room: {
      id: "room-1",
      code: "4242",
      title,
      participants: {
        "participant-1": { participantId: "participant-1", role },
      },
    } as unknown as RoomState,
  };
}

function recent(overrides: Partial<RecentRoom> = {}): RecentRoom {
  return {
    roomId: "room-1",
    code: "4242",
    title: "Stored title",
    role: "participant",
    lastOpenedAt: 10,
    ...overrides,
  };
}

function harness(options: { storage?: MemoryStorage; request?: ReturnType<typeof vi.fn> } = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const acceptRecentRooms = vi.fn();
  const navigateToRoom = vi.fn();
  const binding: JazzboardLandingWebMcpBinding = {
    context: { acceptRecentRooms, navigateToRoom },
  };
  const request = options.request ?? vi.fn(async () => roomResponse());
  const tools = createJazzboardLandingWebMcpTools(binding, {
    request: request as unknown as WebMcpRequest,
    storage,
    now: () => 1_000,
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const execute = (name: string, input: Record<string, unknown>) =>
    byName.get(name)!.execute(input, { signal: new AbortController().signal });
  return { storage, acceptRecentRooms, navigateToRoom, request, tools, byName, execute };
}

describe("landing WebMCP tools", () => {
  it("publishes the complete lifecycle surface with truthful annotations", () => {
    const { tools, byName } = harness();

    expect(tools.map((tool) => tool.name)).toEqual(JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES);
    expect(byName.get("list_recent_rooms")?.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(byName.get("create_room")?.annotations?.untrustedContentHint).toBe(true);
    expect(byName.get("create_room")?.annotations?.readOnlyHint).not.toBe(true);
    expect(byName.get("join_room")?.annotations?.readOnlyHint).not.toBe(true);
    expect(byName.get("open_recent_room")?.annotations?.readOnlyHint).not.toBe(true);
    expect(byName.get("remove_recent_room")?.annotations?.readOnlyHint).not.toBe(true);
    expect(byName.get("join_room")?.description).toContain("never searches or enumerates rooms");
  });

  it("creates a room, persists only the local shortcut and display name, then navigates", async () => {
    const { execute, request, storage, acceptRecentRooms, navigateToRoom } = harness();

    const result = (await execute("create_room", {
      displayName: "  Maya  ",
      title: "  Systems map  ",
    })) as JazzboardToolSuccess<{
      role: RoomRole;
      path: string;
      recentReferenceStored: boolean;
    }>;

    expect(request).toHaveBeenCalledWith("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ action: "create", displayName: "Maya", title: "Systems map" }),
      signal: expect.any(AbortSignal),
    });
    expect(result).toMatchObject({
      ok: true,
      tool: "create_room",
      data: { role: "participant", path: "/room/room-1", recentReferenceStored: true },
    });
    expect(JSON.parse(storage.values.get(RECENT_ROOMS_KEY)!)).toEqual([
      expect.objectContaining({ roomId: "room-1", role: "participant", lastOpenedAt: 1_000 }),
    ]);
    expect(storage.values.get(DISPLAY_NAME_KEY)).toBe("Maya");
    expect(acceptRecentRooms).toHaveBeenCalledTimes(1);
    expect(navigateToRoom).toHaveBeenCalledWith("room-1");
  });

  it("requires an exact four-digit join code before any network call", async () => {
    const { execute, request, navigateToRoom } = harness();

    await expect(execute("join_room", { code: "42", displayName: "Maya" })).resolves.toMatchObject({
      ok: false,
      tool: "join_room",
      error: { code: "INVALID_TOOL_INPUT" },
    });
    await expect(
      execute("join_room", { code: "4242 ", displayName: "Maya" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();
    expect(navigateToRoom).not.toHaveBeenCalled();
  });

  it("joins only the exact supplied code with the requested role", async () => {
    const request = vi.fn(async () => roomResponse("spectator"));
    const { execute, storage, navigateToRoom } = harness({ request });

    await expect(
      execute("join_room", { code: "4242", displayName: "Observer", role: "spectator" }),
    ).resolves.toMatchObject({ ok: true, data: { role: "spectator" } });
    expect(request).toHaveBeenCalledWith("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ action: "join", code: "4242", displayName: "Observer", role: "spectator" }),
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(storage.values.get(RECENT_ROOMS_KEY)!)[0].role).toBe("spectator");
    expect(navigateToRoom).toHaveBeenCalledWith("room-1");
  });

  it("lists only sanitized local references still authorized to the current signed session", async () => {
    const storage = new MemoryStorage();
    storage.values.set(
      RECENT_ROOMS_KEY,
      JSON.stringify([
        recent(),
        recent({ roomId: "room-stale", code: "3131", title: "Prior session room", lastOpenedAt: 9 }),
        { roomId: "invalid-local-entry", code: "wrong" },
      ]),
    );
    const request = vi.fn(async (url: string) => {
      if (url === "/api/rooms/room-1") return roomResponse("spectator", "Current authorized title");
      throw new JazzboardApiError(403, { code: "ROOM_ACCESS_DENIED", message: "Access denied." });
    });
    const { execute } = harness({ storage, request });

    await expect(execute("list_recent_rooms", {})).resolves.toEqual({
      ok: true,
      tool: "list_recent_rooms",
      data: {
        scope: "current_browser_and_signed_session",
        rooms: [recent({ title: "Current authorized title", role: "spectator" })],
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("/api/rooms/room-1", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(request).toHaveBeenCalledWith("/api/rooms/room-stale", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
  });

  it("supports native WebMCP invokers that omit callback options", async () => {
    const { byName } = harness();
    const result = await byName.get("create_room")!.execute(
      { displayName: "Maya", title: "Native runtime" },
      undefined as never,
    );

    expect(result).toMatchObject({ ok: true, tool: "create_room" });
  });

  it("refuses to probe a room that is not already in private recents", async () => {
    const { execute, request, navigateToRoom } = harness();

    await expect(execute("open_recent_room", { roomId: "someone-elses-room" })).resolves.toMatchObject({
      ok: false,
      error: { code: "RECENT_ROOM_NOT_FOUND" },
    });
    expect(request).not.toHaveBeenCalled();
    expect(navigateToRoom).not.toHaveBeenCalled();
  });

  it("server-verifies an authorized recent room before refreshing and navigating", async () => {
    const storage = new MemoryStorage();
    storage.values.set(RECENT_ROOMS_KEY, JSON.stringify([recent()]));
    const request = vi.fn(async () => roomResponse("spectator", "Authoritative title"));
    const { execute, acceptRecentRooms, navigateToRoom } = harness({ storage, request });

    await expect(execute("open_recent_room", { roomId: "room-1" })).resolves.toMatchObject({
      ok: true,
      tool: "open_recent_room",
      data: {
        authorizationVerified: true,
        role: "spectator",
        room: { id: "room-1", code: "4242", title: "Authoritative title" },
      },
    });
    expect(request).toHaveBeenCalledWith("/api/rooms/room-1", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(acceptRecentRooms).toHaveBeenCalledWith([
      expect.objectContaining({ title: "Authoritative title", role: "spectator", lastOpenedAt: 1_000 }),
    ]);
    expect(navigateToRoom).toHaveBeenCalledWith("room-1");
  });

  it("does not navigate or rewrite recents when server authorization fails", async () => {
    const storage = new MemoryStorage();
    storage.values.set(RECENT_ROOMS_KEY, JSON.stringify([recent()]));
    const original = storage.values.get(RECENT_ROOMS_KEY);
    const request = vi.fn(async () => {
      throw new JazzboardApiError(403, { code: "ROOM_ACCESS_DENIED", message: "Access denied." });
    });
    const { execute, navigateToRoom, acceptRecentRooms } = harness({ storage, request });

    await expect(execute("open_recent_room", { roomId: "room-1" })).resolves.toMatchObject({
      ok: false,
      error: { code: "ROOM_ACCESS_DENIED" },
    });
    expect(storage.values.get(RECENT_ROOMS_KEY)).toBe(original);
    expect(acceptRecentRooms).not.toHaveBeenCalled();
    expect(navigateToRoom).not.toHaveBeenCalled();
  });

  it("removes only a browser-local shortcut and never calls the room service", async () => {
    const storage = new MemoryStorage();
    storage.values.set(RECENT_ROOMS_KEY, JSON.stringify([recent()]));
    const { execute, request, acceptRecentRooms } = harness({ storage });

    await expect(execute("remove_recent_room", { roomId: "room-1" })).resolves.toMatchObject({
      ok: true,
      data: {
        localReferenceRemoved: true,
        sharedRoomDeleted: false,
        remainingCount: 0,
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(acceptRecentRooms).toHaveBeenCalledWith([]);
    expect(JSON.parse(storage.values.get(RECENT_ROOMS_KEY)!)).toEqual([]);
  });
});
