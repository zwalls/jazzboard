// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/domain/errors";

const mocks = vi.hoisted(() => ({
  upgrade: vi.fn(),
  readAuthorizedRoom: vi.fn(),
  requireGuestParticipantId: vi.fn(),
  attach: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({
  experimental_upgradeWebSocket: mocks.upgrade,
}));
vi.mock("@/lib/server/room-service", () => ({
  readAuthorizedRoom: mocks.readAuthorizedRoom,
}));
vi.mock("@/lib/server/realtime-hub", () => ({
  getRealtimeHub: () => ({ attach: mocks.attach }),
}));
vi.mock("@/lib/server/session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));

import { GET } from "./route";

describe("GET /api/ws", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGuestParticipantId.mockReturnValue("p_1");
    mocks.readAuthorizedRoom.mockResolvedValue({});
    mocks.upgrade.mockImplementation(async (handler: (socket: object) => unknown) => {
      const result = handler({});
      expect(result).toBeUndefined();
      return new Response(null, { status: 204 });
    });
  });

  it("authorizes cookie membership before upgrade and synchronously attaches the socket", async () => {
    const request = new Request("https://jazzboard.example/api/ws?roomId=room_1&cursor=50-2&capabilities=presence-delta-v1,agent-draft-v1", {
      headers: { cookie: "jazzboard_guest=signed", origin: "https://jazzboard.example" },
    });

    const response = await GET(request);

    expect(response.status).toBe(204);
    expect(mocks.readAuthorizedRoom).toHaveBeenCalledWith("room_1", "p_1");
    expect(mocks.readAuthorizedRoom.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.upgrade.mock.invocationCallOrder[0],
    );
    expect(mocks.attach).toHaveBeenCalledWith(
      {},
      {
        roomId: "room_1",
        participantId: "p_1",
        cursor: "50-2",
        supportsPresenceDelta: true,
        supportsAgentDrafts: true,
      },
    );
    expect(mocks.upgrade).toHaveBeenCalledWith(expect.any(Function), { maxPayload: 32 * 1024 });
  });

  it("fails closed before upgrade when a stale client does not negotiate split-state deltas", async () => {
    const response = await GET(
      new Request("https://jazzboard.example/api/ws?roomId=room_1", {
        headers: { origin: "https://jazzboard.example" },
      }),
    );

    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "CLIENT_UPGRADE_REQUIRED" },
    });
    expect(mocks.readAuthorizedRoom).not.toHaveBeenCalled();
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it("rejects a missing guest cookie without attempting an upgrade", async () => {
    mocks.requireGuestParticipantId.mockImplementation(() => {
      throw new Error("AUTH_REQUIRED");
    });

    const response = await GET(new Request("https://jazzboard.example/api/ws?roomId=room_1"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(mocks.readAuthorizedRoom).not.toHaveBeenCalled();
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it("rejects cross-origin cookie-bearing upgrade attempts", async () => {
    const response = await GET(
      new Request("https://jazzboard.example/api/ws?roomId=room_1&capabilities=presence-delta-v1", {
        headers: { origin: "https://malicious.example" },
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.readAuthorizedRoom).not.toHaveBeenCalled();
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it("rejects non-members and malformed resume cursors before upgrading", async () => {
    mocks.readAuthorizedRoom.mockRejectedValueOnce(
      new DomainError("FORBIDDEN", "This guest session is not a member of the room."),
    );
    const forbidden = await GET(
      new Request("https://jazzboard.example/api/ws?roomId=room_1&capabilities=presence-delta-v1", {
        headers: { origin: "https://jazzboard.example" },
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(mocks.upgrade).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.requireGuestParticipantId.mockReturnValue("p_1");
    const invalidCursor = await GET(
      new Request("https://jazzboard.example/api/ws?roomId=room_1&cursor=not-a-stream-id", {
        headers: { origin: "https://jazzboard.example" },
      }),
    );
    expect(invalidCursor.status).toBe(400);
    expect(mocks.readAuthorizedRoom).not.toHaveBeenCalled();
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });
});
