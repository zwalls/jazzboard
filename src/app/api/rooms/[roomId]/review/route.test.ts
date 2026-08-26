// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireGuestParticipantId: vi.fn(),
  listAgentEditProposals: vi.fn(),
  readAgentEditProposal: vi.fn(),
  reviewAgentEditProposal: vi.fn(),
  setAgentEditPolicy: vi.fn(),
}));

vi.mock("@/lib/server/session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));
vi.mock("@/lib/server/room-service", () => ({
  listAgentEditProposals: mocks.listAgentEditProposals,
  readAgentEditProposal: mocks.readAgentEditProposal,
  reviewAgentEditProposal: mocks.reviewAgentEditProposal,
  setAgentEditPolicy: mocks.setAgentEditPolicy,
}));

import { POST as postAgentPolicy } from "../agent/review/policy/route";
import { GET as readProposal, POST as decideProposal } from "./[proposalId]/route";
import { POST as postHumanPolicy } from "./policy/route";
import { GET as listProposals } from "./route";

const collectionContext = { params: Promise.resolve({ roomId: "room-review" }) };
const proposalContext = { params: Promise.resolve({ roomId: "room-review", proposalId: "proposal/7" }) };

function request(url: string, body?: unknown): Request {
  return new Request(url, body === undefined ? {
    headers: { cookie: "jazzboard_guest=signed" },
  } : {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "jazzboard_guest=signed" },
    body: JSON.stringify(body),
  });
}

describe("agent edit review routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGuestParticipantId.mockReturnValue("p_authenticated");
    mocks.listAgentEditProposals.mockResolvedValue({
      policy: "review",
      proposals: [],
      totalMatched: 0,
      truncated: false,
    });
    mocks.readAgentEditProposal.mockResolvedValue({ id: "proposal/7" });
    mocks.setAgentEditPolicy.mockResolvedValue({
      room: { id: "room-review", roomRevision: 4 },
      policy: "review",
      changed: true,
    });
    mocks.reviewAgentEditProposal.mockResolvedValue({
      outcome: "rejected",
      room: { id: "room-review", roomRevision: 5 },
      proposal: { id: "proposal/7", status: "rejected" },
    });
  });

  it("lists authorized summaries with bounded filters", async () => {
    const response = await listProposals(
      request("https://jazzboard.example/api/rooms/room-review/review?limit=25&status=pending&authorParticipantId=p_agent"),
      collectionContext,
    );

    expect(response.status).toBe(200);
    expect(mocks.listAgentEditProposals).toHaveBeenCalledWith({
      roomId: "room-review",
      participantId: "p_authenticated",
      limit: 25,
      status: "pending",
      authorParticipantId: "p_agent",
    });
  });

  it("reads one exact proposal by its route-bound stable ID", async () => {
    const response = await readProposal(
      request("https://jazzboard.example/api/rooms/room-review/review/proposal%2F7"),
      proposalContext,
    );

    expect(response.status).toBe(200);
    expect(mocks.readAgentEditProposal).toHaveBeenCalledWith({
      roomId: "room-review",
      participantId: "p_authenticated",
      proposalId: "proposal/7",
    });
  });

  it.each([
    ["human", postHumanPolicy],
    ["agent", postAgentPolicy],
  ] as const)("fixes %s policy attribution at the route", async (actorKind, handler) => {
    const response = await handler(
      request("https://jazzboard.example/api/rooms/room-review/review/policy", { policy: "review" }),
      collectionContext,
    );

    expect(response.status).toBe(200);
    expect(mocks.setAgentEditPolicy).toHaveBeenCalledWith({
      roomId: "room-review",
      participantId: "p_authenticated",
      actorKind,
      policy: "review",
    });
  });

  it("fixes review decisions to the human route actor and validates the exact proposal revision", async () => {
    const response = await decideProposal(
      request("https://jazzboard.example/api/rooms/room-review/review/proposal%2F7", {
        action: "reject",
        expectedProposalRevision: 3,
        note: "Not in scope",
      }),
      proposalContext,
    );

    expect(response.status).toBe(200);
    expect(mocks.reviewAgentEditProposal).toHaveBeenCalledWith({
      roomId: "room-review",
      participantId: "p_authenticated",
      actorKind: "human",
      proposalId: "proposal/7",
      action: "reject",
      expectedProposalRevision: 3,
      note: "Not in scope",
    });
  });

  it("rejects malformed policy and decisions before services run", async () => {
    const policyResponse = await postAgentPolicy(
      request("https://jazzboard.example/api/rooms/room-review/agent/review/policy", { policy: "disabled" }),
      collectionContext,
    );
    const decisionResponse = await decideProposal(
      request("https://jazzboard.example/api/rooms/room-review/review/proposal%2F7", {
        action: "approve",
        expectedProposalRevision: 0,
      }),
      proposalContext,
    );

    expect(policyResponse.status).toBe(400);
    expect(decisionResponse.status).toBe(400);
    expect(mocks.setAgentEditPolicy).not.toHaveBeenCalled();
    expect(mocks.reviewAgentEditProposal).not.toHaveBeenCalled();
  });

  it("requires the signed guest session for review reads", async () => {
    mocks.requireGuestParticipantId.mockImplementation(() => {
      throw new Error("AUTH_REQUIRED");
    });

    const response = await listProposals(
      request("https://jazzboard.example/api/rooms/room-review/review"),
      collectionContext,
    );
    expect(response.status).toBe(401);
    expect(mocks.listAgentEditProposals).not.toHaveBeenCalled();
  });
});
