// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireGuestParticipantId: vi.fn(),
  listRoomActivities: vi.fn(),
  readRoomActivity: vi.fn(),
  runActivityRevert: vi.fn(),
}));

vi.mock("@/lib/server/session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));
vi.mock("@/lib/server/room-service", () => ({
  listRoomActivities: mocks.listRoomActivities,
  readRoomActivity: mocks.readRoomActivity,
  runActivityRevert: mocks.runActivityRevert,
}));

import { POST as postAgentRevert } from "../agent/activity/[activityId]/revert/route";
import { GET as readActivity } from "./[activityId]/route";
import { POST as postHumanRevert } from "./[activityId]/revert/route";
import { GET as listActivity } from "./route";

const collectionContext = { params: Promise.resolve({ roomId: "room-review" }) };
const activityContext = { params: Promise.resolve({ roomId: "room-review", activityId: "activity-7" }) };

function request(url: string, body?: unknown): Request {
  return new Request(url, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "jazzboard_guest=signed" },
    body: JSON.stringify(body),
  });
}

const revertBody = {
  objectExpectations: [{ objectId: "api", state: "present", expectedRevision: 3 }],
  diagramExpectations: [{ diagramId: "system", state: "absent" }],
  metadata: { intent: "Undo an incorrect change", summary: "Restored the prior API node" },
};

describe("activity review route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGuestParticipantId.mockReturnValue("p_authenticated");
    mocks.listRoomActivities.mockResolvedValue({ activities: [], hasMore: false, nextBeforeRoomRevision: null });
    mocks.readRoomActivity.mockResolvedValue({ id: "activity-7" });
    mocks.runActivityRevert.mockResolvedValue({ room: { id: "room-review" }, activity: { id: "activity-revert" } });
  });

  it("lists authorized summaries with bounded semantic filters", async () => {
    const response = await listActivity(
      request("https://jazzboard.example/api/rooms/room-review/activity?limit=25&actorKind=agent&objectId=api&diagramId=system&beforeRoomRevision=12"),
      collectionContext,
    );

    expect(response.status).toBe(200);
    expect(mocks.listRoomActivities).toHaveBeenCalledWith({
      roomId: "room-review",
      participantId: "p_authenticated",
      limit: 25,
      actorKind: "agent",
      objectId: "api",
      diagramId: "system",
      beforeRoomRevision: 12,
    });
  });

  it("reads one activity by the route-bound stable ID", async () => {
    const response = await readActivity(
      request("https://jazzboard.example/api/rooms/room-review/activity/activity-7"),
      activityContext,
    );

    expect(response.status).toBe(200);
    expect(mocks.readRoomActivity).toHaveBeenCalledWith({
      roomId: "room-review",
      participantId: "p_authenticated",
      activityId: "activity-7",
    });
  });

  it.each([
    ["human", postHumanRevert],
    ["agent", postAgentRevert],
  ] as const)("fixes %s attribution at the route and combines the path ID with exact guards", async (actorKind, handler) => {
    const response = await handler(
      request("https://jazzboard.example/api/rooms/room-review/activity/activity-7/revert", revertBody),
      activityContext,
    );

    expect(response.status).toBe(200);
    expect(mocks.runActivityRevert).toHaveBeenCalledWith({
      roomId: "room-review",
      participantId: "p_authenticated",
      actorKind,
      revert: { activityId: "activity-7", ...revertBody },
    });
  });

  it("rejects malformed or duplicate guards before the mutation service runs", async () => {
    const response = await postAgentRevert(
      request("https://jazzboard.example/api/rooms/room-review/agent/activity/activity-7/revert", {
        objectExpectations: [
          { objectId: "api", state: "present", expectedRevision: 3 },
          { objectId: "api", state: "present", expectedRevision: 3 },
        ],
        diagramExpectations: [],
      }),
      activityContext,
    );

    expect(response.status).toBe(400);
    expect(mocks.runActivityRevert).not.toHaveBeenCalled();
  });

  it("requires the signed guest session for all activity reads", async () => {
    mocks.requireGuestParticipantId.mockImplementation(() => {
      throw new Error("AUTH_REQUIRED");
    });

    const response = await listActivity(
      request("https://jazzboard.example/api/rooms/room-review/activity"),
      collectionContext,
    );
    expect(response.status).toBe(401);
    expect(mocks.listRoomActivities).not.toHaveBeenCalled();
  });
});
