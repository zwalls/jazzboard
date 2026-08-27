// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/domain/errors";

const mocks = vi.hoisted(() => ({
  requireGuestParticipantId: vi.fn(),
  createAgentMessage: vi.fn(),
  listAgentMessages: vi.fn(),
  claimAgentMessage: vi.fn(),
  replyAgentMessage: vi.fn(),
  runMutationRequest: vi.fn(),
}));

vi.mock("@/lib/server/session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));
vi.mock("@/lib/server/agent-message-service", () => ({
  createAgentMessage: mocks.createAgentMessage,
  listAgentMessages: mocks.listAgentMessages,
  claimAgentMessage: mocks.claimAgentMessage,
  replyAgentMessage: mocks.replyAgentMessage,
}));
vi.mock("@/lib/server/http", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/http")>(),
  runMutationRequest: mocks.runMutationRequest,
}));

import { GET as listAgent } from "../agent/messages/route";
import { POST as claimAgent } from "../agent/messages/[messageId]/claim/route";
import { POST as replyAgent } from "../agent/messages/[messageId]/reply/route";
import { GET as listHuman, POST as createHuman } from "./route";

const roomContext = { params: Promise.resolve({ roomId: "room_private" }) };
const messageContext = { params: Promise.resolve({ roomId: "room_private", messageId: "message_123" }) };
const message = { id: "message_123", state: "pending" };

function request(path: string, body?: unknown): Request {
  return new Request(`https://jazzboard.example${path}`, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "jazzboard_guest=signed" },
    body: JSON.stringify(body),
  });
}

describe("private agent message routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGuestParticipantId.mockReturnValue("p_authenticated");
    mocks.createAgentMessage.mockResolvedValue(message);
    mocks.listAgentMessages.mockResolvedValue({ messages: [message], totalMatched: 1, truncated: false });
    mocks.claimAgentMessage.mockResolvedValue({ message: { ...message, state: "claimed" }, claimToken: "t".repeat(43) });
    mocks.replyAgentMessage.mockResolvedValue({ ...message, state: "answered" });
    mocks.runMutationRequest.mockImplementation((input: { execute: () => Promise<unknown> }) => input.execute());
  });

  it("uses newest-first human history and oldest-first agent cursor ordering", async () => {
    const humanResponse = await listHuman(
      request("/api/rooms/room_private/messages?status=answered&limit=40"),
      roomContext,
    );
    expect(humanResponse.status).toBe(200);
    expect(mocks.listAgentMessages).toHaveBeenLastCalledWith({
      roomId: "room_private",
      participantId: "p_authenticated",
      status: "answered",
      limit: 40,
      order: "newest",
    });
    expect(await humanResponse.json()).toEqual({ ok: true, messages: [message], totalMatched: 1, truncated: false });

    await listAgent(
      request("/api/rooms/room_private/agent/messages?limit=25&afterSequence=8"),
      roomContext,
    );
    expect(mocks.listAgentMessages).toHaveBeenLastCalledWith({
      roomId: "room_private",
      participantId: "p_authenticated",
      limit: 25,
      afterSequence: 8,
      order: "oldest",
    });
  });

  it("rejects a sequence cursor combined with mutable state filtering", async () => {
    const response = await listAgent(
      request("/api/rooms/room_private/agent/messages?status=pending&afterSequence=8"),
      roomContext,
    );
    expect(response.status).toBe(400);
    expect(mocks.listAgentMessages).not.toHaveBeenCalled();
  });

  it("accepts only the stable browser create fields and derives the participant from the session", async () => {
    const response = await createHuman(
      request("/api/rooms/room_private/messages", {
        messageId: "message_123",
        prompt: "Please inspect this",
        selectedObjectIds: ["object_1"],
      }),
      roomContext,
    );
    expect(response.status).toBe(200);
    expect(mocks.createAgentMessage).toHaveBeenCalledWith({
      roomId: "room_private",
      participantId: "p_authenticated",
      messageId: "message_123",
      prompt: "Please inspect this",
      selectedObjectIds: ["object_1"],
    });
    expect(mocks.runMutationRequest).toHaveBeenCalledWith(expect.objectContaining({
      participantId: "p_authenticated",
      roomId: "room_private",
      operation: "room.agent-message.create",
      actorKind: "human",
    }));
    expect(await response.json()).toEqual({ ok: true, message });
  });

  it("binds claim and reply to the route message and returns the claim token only from claim", async () => {
    const claimResponse = await claimAgent(
      request("/api/rooms/room_private/agent/messages/message_123/claim", { claimId: "claim_123", leaseSeconds: 60 }),
      messageContext,
    );
    expect(mocks.claimAgentMessage).toHaveBeenCalledWith({
      roomId: "room_private",
      participantId: "p_authenticated",
      messageId: "message_123",
      claimId: "claim_123",
      leaseSeconds: 60,
    });
    expect(mocks.runMutationRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: "room.agent-message.claim",
      actorKind: "agent",
      participantId: "p_authenticated",
    }));
    expect(await claimResponse.json()).toMatchObject({ ok: true, claimToken: "t".repeat(43) });

    const body = { replyId: "reply_123", claimToken: "t".repeat(43), text: "Done", outcome: "completed" };
    const replyResponse = await replyAgent(
      request("/api/rooms/room_private/agent/messages/message_123/reply", body),
      messageContext,
    );
    expect(mocks.replyAgentMessage).toHaveBeenCalledWith({
      roomId: "room_private",
      participantId: "p_authenticated",
      messageId: "message_123",
      ...body,
    });
    expect(mocks.runMutationRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: "room.agent-message.reply",
      actorKind: "agent",
      participantId: "p_authenticated",
    }));
    expect(await replyResponse.json()).toEqual({ ok: true, message: { ...message, state: "answered" } });
  });

  it("requires a selected object and rejects caller-supplied attribution fields", async () => {
    const emptySelection = await createHuman(
      request("/api/rooms/room_private/messages", { messageId: "message_123", prompt: "No selection", selectedObjectIds: [] }),
      roomContext,
    );
    expect(emptySelection.status).toBe(400);
    const spoofed = await createHuman(
      request("/api/rooms/room_private/messages", { messageId: "message_123", prompt: "Spoof", selectedObjectIds: ["object_1"], participantId: "p_victim", actorKind: "agent" }),
      roomContext,
    );
    expect(spoofed.status).toBe(400);
    expect(mocks.createAgentMessage).not.toHaveBeenCalled();
  });

  it("requires a signed participant session before any private read", async () => {
    mocks.requireGuestParticipantId.mockImplementation(() => { throw new Error("AUTH_REQUIRED"); });
    const response = await listAgent(request("/api/rooms/room_private/agent/messages?status=pending&limit=50"), roomContext);
    expect(response.status).toBe(401);
    expect(mocks.listAgentMessages).not.toHaveBeenCalled();
  });

  it("maps lifecycle conflicts from the service to structured HTTP conflicts", async () => {
    mocks.claimAgentMessage.mockRejectedValue(
      new DomainError("MESSAGE_ALREADY_CLAIMED", "Already claimed", {
        messageId: "message_123",
        claimedUntil: 42_000,
      }),
    );
    const response = await claimAgent(
      request("/api/rooms/room_private/agent/messages/message_123/claim", { claimId: "claim_123", leaseSeconds: 60 }),
      messageContext,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "MESSAGE_ALREADY_CLAIMED",
        message: "Already claimed",
        details: { messageId: "message_123", claimedUntil: 42_000 },
      },
    });
  });
});
