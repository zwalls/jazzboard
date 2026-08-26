import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiRequest } from "@/lib/client/api";
import type { AgentEditProposal, AgentEditProposalSummary, RoomState } from "@/lib/domain/types";

import { ReviewPanel } from "./ReviewPanel";

vi.mock("@/lib/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client/api")>();
  return { ...actual, apiRequest: vi.fn() };
});

const agent = {
  participantId: "person_1",
  displayName: "Ari",
  color: "#5965e8",
  kind: "agent" as const,
};

const proposal: AgentEditProposal = {
  id: "proposal_1",
  roomId: "room/a b",
  revision: 2,
  status: "pending",
  createdAt: 1_000,
  updatedAt: 1_000,
  baselineRoomRevision: 8,
  author: agent,
  intent: "Add the authorization boundary",
  summary: "Propose the session service and Redis relationship.",
  purpose: {
    kind: "semantic_transaction",
    label: "Apply 3 semantic operations",
    operationCount: 3,
    objectIds: ["session-service", "redis"],
    diagramIds: ["auth-flow"],
    layout: null,
  },
  request: {
    kind: "semantic_transaction",
    transaction: { commands: [], diagramCommands: [] },
  },
  review: null,
};

const room: RoomState = {
  id: "room/a b",
  code: "1234",
  title: "Architecture",
  roomRevision: 9,
  createdAt: 1,
  updatedAt: 2,
  participants: {},
  objects: {},
  diagrams: {},
  leases: {},
  spotlight: null,
  agentEditPolicy: "review",
  reviewProposals: [proposal],
};

function listResponse(proposals: AgentEditProposalSummary[] = [proposal]) {
  return { ok: true, policy: "review", proposals, totalMatched: proposals.length, truncated: false };
}

function renderPanel(role: "participant" | "spectator", acceptRoom = vi.fn()) {
  return render(
    <ReviewPanel
      room={room}
      role={role}
      acceptRoom={acceptRoom}
      onClose={vi.fn()}
      onFocus={vi.fn()}
      onAnnounce={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("ReviewPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiRequest).mockResolvedValue(listResponse());
  });

  it("lets spectators inspect attributed proposals but not decide or change policy", async () => {
    renderPanel("spectator");

    expect(await screen.findByText("Ari’s agent")).toBeInTheDocument();
    expect(screen.getByText("Add the authorization boundary")).toBeInTheDocument();
    expect(screen.getByText(/based on room r8/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve & apply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Live" })).not.toBeInTheDocument();
  });

  it("submits an exact proposal revision when a human approves", async () => {
    const accepted = vi.fn();
    vi.mocked(apiRequest).mockImplementation(async (url, init) => {
      if (String(url).includes("proposal_1") && init?.method === "POST") {
        return {
          ok: true,
          outcome: "applied",
          room: { ...room, roomRevision: 10 },
          proposal: { ...proposal, status: "applied" },
        };
      }
      return listResponse();
    });
    renderPanel("participant", accepted);
    fireEvent.click(await screen.findByRole("button", { name: "Approve & apply" }));

    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/review/proposal_1",
      {
        method: "POST",
        body: JSON.stringify({ action: "approve", expectedProposalRevision: 2 }),
      },
    ));
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ roomRevision: 10 }));
  });
});
