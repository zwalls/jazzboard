// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RoomPresenceDelta } from "@/lib/domain/types";

const mocks = vi.hoisted(() => ({
  readAuthorizedRoom: vi.fn(),
  requireGuestParticipantId: vi.fn(() => "p_session"),
  updatePresence: vi.fn(),
}));

vi.mock("@/lib/server/room-service", () => ({
  readAuthorizedRoom: mocks.readAuthorizedRoom,
  updatePresence: mocks.updatePresence,
}));
vi.mock("@/lib/server/session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));

import { POST } from "./route";

const delta: RoomPresenceDelta = {
  roomId: "room_1",
  stateRevision: 9,
  roomRevision: 4,
  participantId: "p_session",
  actorKind: "human",
  lastSeenAt: 9,
  connected: true,
  agentActive: false,
  presence: {
    cursor: { x: 10, y: 20 },
    viewport: null,
    lastSeenAt: 9,
    activity: null,
  },
};

function request(deltaProtocol = true): Request {
  return new Request("https://jazzboard.test/api/rooms/room_1/presence", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(deltaProtocol ? { "x-jazzboard-presence-protocol": "delta-v1" } : {}),
    },
    body: JSON.stringify({ cursor: { x: 10, y: 20 }, viewport: null, activity: null }),
  });
}

describe("human presence route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updatePresence.mockResolvedValue(delta);
  });

  it("returns only the negotiated bounded delta without reading the full room", async () => {
    const response = await POST(request(), { params: Promise.resolve({ roomId: "room_1" }) });

    expect(response.status).toBe(200);
    const encoded = await response.text();
    expect(JSON.parse(encoded)).toEqual({ ok: true, presence: delta });
    expect(Buffer.byteLength(encoded)).toBeLessThan(1_024);
    expect(mocks.readAuthorizedRoom).not.toHaveBeenCalled();
    expect(mocks.updatePresence).toHaveBeenCalledWith({
      roomId: "room_1",
      participantId: "p_session",
      actorKind: "human",
      cursor: { x: 10, y: 20 },
      viewport: null,
      activity: null,
    });
  });

  it("fails closed before mutation when a stale client omits delta negotiation", async () => {
    const response = await POST(request(false), {
      params: Promise.resolve({ roomId: "room_1" }),
    });

    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "CLIENT_UPGRADE_REQUIRED" },
    });
    expect(mocks.updatePresence).not.toHaveBeenCalled();
  });
});
