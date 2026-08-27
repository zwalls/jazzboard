// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_CAPABILITIES_HEADER,
  SPLIT_STATE_CLIENT_CAPABILITY,
} from "@/lib/realtime/protocol";

const mocks = vi.hoisted(() => ({
  readAuthorizedRoom: vi.fn(),
  requireGuestParticipantId: vi.fn(() => "p_session"),
}));

vi.mock("@/lib/server/room-service", () => ({
  readAuthorizedRoom: mocks.readAuthorizedRoom,
  upgradeMembership: vi.fn(),
}));
vi.mock("@/lib/server/session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));

import { GET } from "./route";

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
