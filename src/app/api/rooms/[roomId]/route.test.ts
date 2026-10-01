// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_CAPABILITIES_HEADER,
  SPLIT_STATE_CLIENT_CAPABILITY,
} from "@/lib/realtime/protocol";

const mocks = vi.hoisted(() => ({
  readAuthorizedRoom: vi.fn(),
  listAgentCanvasDrafts: vi.fn(),
  renameRoom: vi.fn(),
  requireGuestParticipantId: vi.fn(() => "p_session"),
  upgradeMembership: vi.fn(),
}));

vi.mock("@/lib/server/room-service", () => ({
  readAuthorizedRoom: mocks.readAuthorizedRoom,
  renameRoom: mocks.renameRoom,
  upgradeMembership: mocks.upgradeMembership,
}));
vi.mock("@/lib/server/agent-draft-store", () => ({
  getAgentCanvasDraftStore: () => ({ list: mocks.listAgentCanvasDrafts }),
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
    mocks.listAgentCanvasDrafts.mockResolvedValue([]);
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
      presentations: [],
      serverTime: expect.any(Number),
    });
  });

  it("returns only presentations fenced by the room and strips private commit data", async () => {
    mocks.listAgentCanvasDrafts.mockResolvedValue([
      {
        id: "draft_reveal",
        roomId: "room_1",
        status: "presenting",
        authoritativeCommit: { roomRevision: 4 },
        transaction: { commands: [{ secret: true }] },
        committing: null,
      },
      {
        id: "draft_future",
        roomId: "room_1",
        status: "presenting",
        authoritativeCommit: { roomRevision: 5 },
      },
      { id: "draft_authoring", roomId: "room_1", status: "active" },
    ]);
    const response = await GET(
      new Request("https://jazzboard.test/api/rooms/room_1", {
        headers: { [CLIENT_CAPABILITIES_HEADER]: SPLIT_STATE_CLIENT_CAPABILITY },
      }),
      { params: Promise.resolve({ roomId: "room_1" }) },
    );
    const body = await response.json();

    expect(body.presentations).toEqual([expect.objectContaining({ id: "draft_reveal" })]);
    expect(JSON.stringify(body.presentations)).not.toContain("transaction");
    expect(JSON.stringify(body.presentations)).not.toContain("authoritativeCommit");
  });

  it("keeps authoritative room reads available when presentation storage fails", async () => {
    mocks.listAgentCanvasDrafts.mockRejectedValueOnce(new Error("sidecar unavailable"));
    const response = await GET(
      new Request("https://jazzboard.test/api/rooms/room_1", {
        headers: { [CLIENT_CAPABILITIES_HEADER]: SPLIT_STATE_CLIENT_CAPABILITY },
      }),
      { params: Promise.resolve({ roomId: "room_1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      room: { roomRevision: 4 },
      presentations: [],
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
