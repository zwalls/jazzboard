// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_CAPABILITIES_HEADER,
  SPLIT_STATE_CLIENT_CAPABILITY,
} from "@/lib/realtime/protocol";

const mocks = vi.hoisted(() => ({
  readAuthorizedRoom: vi.fn(),
  renameRoom: vi.fn(),
  requireGuestParticipantId: vi.fn(() => "p_session"),
  upgradeMembership: vi.fn(),
}));

vi.mock("@/lib/server/room-service", () => ({
  readAuthorizedRoom: mocks.readAuthorizedRoom,
  renameRoom: mocks.renameRoom,
  upgradeMembership: mocks.upgradeMembership,
}));
vi.mock("@/lib/server/session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));

import { GET, PATCH } from "./route";

describe("GET /api/rooms/[roomId] client capability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGuestParticipantId.mockReturnValue("p_session");
    mocks.readAuthorizedRoom.mockResolvedValue({
      id: "room_1",
      roomRevision: 4,
      stateRevision: 10,
    });
  });

  it("returns split-revision room state to a negotiated current client", async () => {
    const response = await GET(
      new Request("https://jazzboard.test/api/rooms/room_1", {
        headers: { [CLIENT_CAPABILITIES_HEADER]: SPLIT_STATE_CLIENT_CAPABILITY },
      }),
      { params: Promise.resolve({ roomId: "room_1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      participantId: "p_session",
      room: { roomRevision: 4, stateRevision: 10 },
    });
  });

  it("fails closed without reading the room when a stale client omits the capability", async () => {
    const response = await GET(
      new Request("https://jazzboard.test/api/rooms/room_1"),
      { params: Promise.resolve({ roomId: "room_1" }) },
    );

    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "CLIENT_UPGRADE_REQUIRED" },
    });
    expect(mocks.readAuthorizedRoom).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/rooms/[roomId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGuestParticipantId.mockReturnValue("p_session");
    mocks.renameRoom.mockResolvedValue({ id: "room_1", title: "Architecture review" });
  });

  it("normalizes and dispatches a participant room rename", async () => {
    const response = await PATCH(
      new Request("https://jazzboard.test/api/rooms/room_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "rename",
          title: "  Architecture review  ",
          expectedTitle: "Untitled Jazzboard",
        }),
      }),
      { params: Promise.resolve({ roomId: "room_1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.renameRoom).toHaveBeenCalledWith(
      "room_1",
      "p_session",
      "Architecture review",
      "Untitled Jazzboard",
    );
    expect(await response.json()).toMatchObject({
      ok: true,
      action: "rename",
      room: { title: "Architecture review" },
    });
  });

  it("rejects a blank room title before calling the service", async () => {
    const response = await PATCH(
      new Request("https://jazzboard.test/api/rooms/room_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "rename",
          title: "   ",
          expectedTitle: "Untitled Jazzboard",
        }),
      }),
      { params: Promise.resolve({ roomId: "room_1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.renameRoom).not.toHaveBeenCalled();
  });
});
