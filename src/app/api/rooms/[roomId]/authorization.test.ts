// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/domain/errors";

const mocks = vi.hoisted(() => ({
  requireGuestParticipantId: vi.fn(),
  runCanvasCommand: vi.fn(),
}));

vi.mock("@/lib/server/session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));
vi.mock("@/lib/server/room-service", () => ({
  runCanvasCommand: mocks.runCanvasCommand,
}));

import { POST as postAgentCommand } from "./agent/commands/route";
import { POST as postHumanCommand } from "./commands/route";

const command = {
  type: "create",
  object: {
    id: "note",
    kind: "text",
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    content: "Authenticated actor",
  },
};

const context = { params: Promise.resolve({ roomId: "room_authorized" }) };

function request(body: unknown): Request {
  return new Request("https://jazzboard.example/api/rooms/room_authorized/commands", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "jazzboard_guest=signed" },
    body: JSON.stringify(body),
  });
}

describe("canvas command route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGuestParticipantId.mockReturnValue("p_authenticated");
    mocks.runCanvasCommand.mockResolvedValue({
      room: { id: "room_authorized" },
      changedObjectIds: ["note"],
    });
  });

  it("derives the participant and human actor from the cookie and route", async () => {
    const response = await postHumanCommand(
      request({ participantId: "p_victim", actorKind: "agent", command }),
      context,
    );

    expect(response.status).toBe(200);
    expect(mocks.runCanvasCommand).toHaveBeenCalledWith({
      roomId: "room_authorized",
      participantId: "p_authenticated",
      actorKind: "human",
      command: expect.objectContaining({ type: "create" }),
    });
  });

  it("derives the participant and agent actor from the cookie and agent route", async () => {
    const response = await postAgentCommand(
      request({ participantId: "p_victim", actorKind: "human", command }),
      context,
    );

    expect(response.status).toBe(200);
    expect(mocks.runCanvasCommand).toHaveBeenCalledWith({
      roomId: "room_authorized",
      participantId: "p_authenticated",
      actorKind: "agent",
      command: expect.objectContaining({ type: "create" }),
    });
  });

  it("rejects a missing guest session before invoking the room service", async () => {
    mocks.requireGuestParticipantId.mockImplementation(() => {
      throw new Error("AUTH_REQUIRED");
    });

    const response = await postHumanCommand(request({ command }), context);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "AUTH_REQUIRED" },
    });
    expect(mocks.runCanvasCommand).not.toHaveBeenCalled();
  });

  it("returns a structured conflict when an agent targets another actor's active object", async () => {
    mocks.runCanvasCommand.mockRejectedValue(
      new DomainError("OBJECT_BUSY", "Bob is currently editing this object.", {
        objectId: "note",
        actor: {
          participantId: "p_bob",
          displayName: "Bob",
          color: "#00A68A",
          kind: "human",
        },
        operation: "edit",
        currentRevision: 4,
        expiresAt: 10_000,
      }),
    );

    const response = await postAgentCommand(request({ command }), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "OBJECT_BUSY",
        message: "Bob is currently editing this object.",
        details: {
          objectId: "note",
          actor: {
            participantId: "p_bob",
            displayName: "Bob",
            color: "#00A68A",
            kind: "human",
          },
          operation: "edit",
          currentRevision: 4,
          expiresAt: 10_000,
        },
      },
    });
  });
});
