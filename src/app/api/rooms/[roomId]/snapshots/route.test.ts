// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireGuestParticipantId: vi.fn(),
  createReadonlySnapshot: vi.fn(),
  listReadonlySnapshots: vi.fn(),
  revokeReadonlySnapshot: vi.fn(),
}));

vi.mock("@/lib/server/session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));
vi.mock("@/lib/server/snapshot-service", () => ({
  createReadonlySnapshot: mocks.createReadonlySnapshot,
  listReadonlySnapshots: mocks.listReadonlySnapshots,
  revokeReadonlySnapshot: mocks.revokeReadonlySnapshot,
  readPublicSnapshot: vi.fn(),
}));

import {
  DELETE as deleteAgentSnapshot,
  GET as getAgentSnapshots,
  POST as postAgentSnapshot,
} from "../agent/snapshots/route";
import {
  DELETE as deleteHumanSnapshot,
  GET as getHumanSnapshots,
  POST as postHumanSnapshot,
} from "./route";

const context = { params: Promise.resolve({ roomId: "room_private" }) };

function request(method: string, body?: unknown): Request {
  return new Request("https://jazzboard.example/api/rooms/room_private/snapshots", {
    method,
    headers: { "content-type": "application/json", cookie: "jazzboard_guest=signed" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("snapshot collection route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGuestParticipantId.mockReturnValue("p_authenticated");
    mocks.listReadonlySnapshots.mockResolvedValue({ snapshots: [] });
    mocks.revokeReadonlySnapshot.mockResolvedValue({ snapshotId: "snapshot_revoked", revoked: true });
  });

  it.each([
    ["human", postHumanSnapshot],
    ["agent", postAgentSnapshot],
  ] as const)("returns a stable retirement response for cached %s creation clients", async (_actorKind, handler) => {
    const response = await handler(request("POST", { expectedRoomRevision: 9 }));

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "SNAPSHOT_ISSUANCE_RETIRED",
        message: "Jazzboard no longer creates hosted snapshot links. Download a local PNG instead.",
        details: null,
      },
    });
    expect(mocks.createReadonlySnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["human", getHumanSnapshots],
    ["agent", getAgentSnapshots],
  ] as const)("derives the %s actor for creator-only listing", async (actorKind, handler) => {
    const response = await handler(request("GET"), context);

    expect(response.status).toBe(200);
    expect(mocks.listReadonlySnapshots).toHaveBeenCalledWith({
      roomId: "room_private",
      participantId: "p_authenticated",
      actorKind,
    });
  });

  it.each([
    ["human", deleteHumanSnapshot],
    ["agent", deleteAgentSnapshot],
  ] as const)("derives the %s actor for exact-ID revocation", async (actorKind, handler) => {
    const snapshotId = "snapshot_44444444-4444-4444-8444-444444444444";
    const response = await handler(request("DELETE", { snapshotId }), context);

    expect(response.status).toBe(200);
    expect(mocks.revokeReadonlySnapshot).toHaveBeenCalledWith({
      roomId: "room_private",
      participantId: "p_authenticated",
      actorKind,
      snapshotId,
    });
  });

  it("requires the signed guest session before any operation", async () => {
    mocks.requireGuestParticipantId.mockImplementation(() => {
      throw new Error("AUTH_REQUIRED");
    });

    const response = await getHumanSnapshots(request("GET"), context);

    expect(response.status).toBe(401);
    expect(mocks.listReadonlySnapshots).not.toHaveBeenCalled();
  });
});
