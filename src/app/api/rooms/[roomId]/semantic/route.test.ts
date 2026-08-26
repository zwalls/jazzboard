// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireGuestParticipantId: vi.fn(),
  runSemanticTransaction: vi.fn(),
  runLayoutCommand: vi.fn(),
}));

vi.mock("@/lib/server/session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));
vi.mock("@/lib/server/room-service", () => ({
  runSemanticTransaction: mocks.runSemanticTransaction,
  runLayoutCommand: mocks.runLayoutCommand,
}));

import { POST as postAgentSemantic } from "../agent/semantic/route";
import { POST as postHumanSemantic } from "./route";

const context = { params: Promise.resolve({ roomId: "room_semantic" }) };

function request(body: unknown): Request {
  return new Request("https://jazzboard.example/api/rooms/room_semantic/semantic", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "jazzboard_guest=signed" },
    body: JSON.stringify(body),
  });
}

const transaction = {
  commands: [
    {
      type: "create",
      object: {
        id: "note",
        kind: "text",
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        content: "Semantic transaction",
      },
    },
  ],
  diagramCommands: [],
};

describe("semantic mutation route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGuestParticipantId.mockReturnValue("p_authenticated");
    mocks.runSemanticTransaction.mockResolvedValue({ room: { id: "room_semantic" }, changedObjectIds: ["note"] });
    mocks.runLayoutCommand.mockResolvedValue({ room: { id: "room_semantic" }, changedObjectIds: ["note"] });
  });

  it("derives a human actor from the human semantic route", async () => {
    const response = await postHumanSemantic(request({ action: "transaction", transaction }), context);

    expect(response.status).toBe(200);
    expect(mocks.runSemanticTransaction).toHaveBeenCalledWith({
      roomId: "room_semantic",
      participantId: "p_authenticated",
      actorKind: "human",
      transaction: expect.objectContaining({ commands: [expect.objectContaining({ type: "create" })] }),
    });
  });

  it("derives an agent actor from the agent semantic route", async () => {
    const layout = {
      layout: "flow",
      targets: [{ objectId: "note", expectedRevision: 1 }],
    };
    const response = await postAgentSemantic(request({ action: "layout", layout }), context);

    expect(response.status).toBe(200);
    expect(mocks.runLayoutCommand).toHaveBeenCalledWith({
      roomId: "room_semantic",
      participantId: "p_authenticated",
      actorKind: "agent",
      layout: expect.objectContaining({
        layout: "flow",
        direction: "right",
        primaryGap: 160,
        secondaryGap: 100,
      }),
    });
  });

  it("requires the signed guest session before either service can run", async () => {
    mocks.requireGuestParticipantId.mockImplementation(() => {
      throw new Error("AUTH_REQUIRED");
    });

    const response = await postAgentSemantic(request({ action: "transaction", transaction }), context);

    expect(response.status).toBe(401);
    expect(mocks.runSemanticTransaction).not.toHaveBeenCalled();
    expect(mocks.runLayoutCommand).not.toHaveBeenCalled();
  });
});
