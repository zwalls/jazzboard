// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireGuestParticipantId: vi.fn(),
  runLeaseAction: vi.fn(),
}));

vi.mock("@/lib/server/session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));
vi.mock("@/lib/server/room-service", () => ({
  runLeaseAction: mocks.runLeaseAction,
}));

import { POST as postAgentLease } from "../agent/leases/route";
import { POST as postHumanLease } from "./route";

const context = { params: Promise.resolve({ roomId: "room_leases" }) };

function request(body: unknown): Request {
  return new Request("https://jazzboard.example/api/rooms/room_leases/leases", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "jazzboard_guest=signed" },
    body: JSON.stringify(body),
  });
}

describe("lease batch routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGuestParticipantId.mockReturnValue("p_authenticated");
    mocks.runLeaseAction.mockResolvedValue({ room: { id: "room_leases" }, leases: [] });
  });

  it("forwards an acquire-many request with a route-selected human actor", async () => {
    const targets = [
      { objectId: "a", expectedRevision: 1, operation: "move" },
      { objectId: "b", expectedRevision: 2, operation: "resize" },
    ];
    const response = await postHumanLease(request({ action: "acquire-many", targets }), context);

    expect(response.status).toBe(200);
    expect(mocks.runLeaseAction).toHaveBeenCalledWith({
      action: "acquire-many",
      targets,
      roomId: "room_leases",
      participantId: "p_authenticated",
      actorKind: "human",
    });
    expect(await response.json()).toMatchObject({ ok: true, leases: [] });
  });

  it("forwards renew-many and release-many requests with a route-selected agent actor", async () => {
    const targets = [
      { objectId: "a", leaseId: "lease-a" },
      { objectId: "b", leaseId: "lease-b" },
    ];

    for (const action of ["renew-many", "release-many"] as const) {
      const response = await postAgentLease(request({ action, targets }), context);
      expect(response.status).toBe(200);
      expect(mocks.runLeaseAction).toHaveBeenCalledWith({
        action,
        targets,
        roomId: "room_leases",
        participantId: "p_authenticated",
        actorKind: "agent",
      });
    }
  });

  it("rejects empty and duplicate batches before invoking the service", async () => {
    const empty = await postHumanLease(request({ action: "acquire-many", targets: [] }), context);
    const duplicate = await postHumanLease(
      request({
        action: "release-many",
        targets: [
          { objectId: "a", leaseId: "lease-a" },
          { objectId: "a", leaseId: "lease-b" },
        ],
      }),
      context,
    );

    expect(empty.status).toBe(400);
    expect(duplicate.status).toBe(400);
    expect(mocks.runLeaseAction).not.toHaveBeenCalled();
  });
});
