// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import { currentMutationContext } from "./mutation-context";

const mocks = vi.hoisted(() => ({
  requireGuestParticipantId: vi.fn(),
  listAgentCanvasDrafts: vi.fn(),
  readAgentCanvasDraft: vi.fn(),
  stageAgentCanvasDraft: vi.fn(),
  replaceAgentCanvasDraft: vi.fn(),
  discardAgentCanvasDraft: vi.fn(),
  commitAgentCanvasDraft: vi.fn(),
}));

vi.mock("./session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));
vi.mock("./agent-draft-service", () => ({
  listAgentCanvasDrafts: mocks.listAgentCanvasDrafts,
  readAgentCanvasDraft: mocks.readAgentCanvasDraft,
  stageAgentCanvasDraft: mocks.stageAgentCanvasDraft,
  replaceAgentCanvasDraft: mocks.replaceAgentCanvasDraft,
  discardAgentCanvasDraft: mocks.discardAgentCanvasDraft,
  commitAgentCanvasDraft: mocks.commitAgentCanvasDraft,
}));

import { POST as stage } from "../../app/api/rooms/[roomId]/agent/drafts/route";
import { DELETE as discard, PUT as replace } from "../../app/api/rooms/[roomId]/agent/drafts/[draftId]/route";
import { POST as commit } from "../../app/api/rooms/[roomId]/agent/drafts/[draftId]/commit/route";
import { GET as list } from "../../app/api/rooms/[roomId]/drafts/route";
import { GET as read } from "../../app/api/rooms/[roomId]/drafts/[draftId]/route";

const roomContext = { params: Promise.resolve({ roomId: "room_http" }) };
const draftContext = { params: Promise.resolve({ roomId: "room_http", draftId: "draft_http" }) };

function request(method: string, body?: unknown, headers: HeadersInit = {}): Request {
  return new Request("https://jazzboard.example/api/rooms/room_http/drafts", {
    method,
    headers: {
      cookie: "jazzboard_guest=signed",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const transaction = {
  commands: [{
    type: "create",
    object: {
      id: "node_http",
      kind: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      content: "HTTP draft",
    },
  }],
  diagramCommands: [],
};

describe("agent canvas draft routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGuestParticipantId.mockReturnValue("p_session");
    mocks.listAgentCanvasDrafts.mockResolvedValue({ drafts: [], serverTime: 10 });
    mocks.readAgentCanvasDraft.mockResolvedValue({ draft: { id: "draft_http" }, serverTime: 10 });
    mocks.stageAgentCanvasDraft.mockResolvedValue({ id: "draft_http", revision: 1 });
    mocks.replaceAgentCanvasDraft.mockResolvedValue({ id: "draft_http", revision: 2 });
    mocks.discardAgentCanvasDraft.mockResolvedValue({ discarded: true, draftId: "draft_http" });
    mocks.commitAgentCanvasDraft.mockResolvedValue({ outcome: "applied", draft: null, mutation: {} });
  });

  it("exposes session-authorized list and exact-read routes without requiring mutation context", async () => {
    const listed = await list(request("GET"), roomContext);
    const exact = await read(request("GET"), draftContext);

    expect(listed.status).toBe(200);
    expect(exact.status).toBe(200);
    expect(mocks.listAgentCanvasDrafts).toHaveBeenCalledWith({ roomId: "room_http", participantId: "p_session" });
    expect(mocks.readAgentCanvasDraft).toHaveBeenCalledWith({
      roomId: "room_http",
      draftId: "draft_http",
      participantId: "p_session",
    });
  });

  it("derives the agent actor and private mutation identity for staging", async () => {
    let observed = null as ReturnType<typeof currentMutationContext>;
    mocks.stageAgentCanvasDraft.mockImplementation(async () => {
      observed = currentMutationContext();
      return { id: "draft_http", revision: 1 };
    });
    const response = await stage(request("POST", {
      draftId: "draft_http",
      baselineRoomRevision: 4,
      transaction,
      temporaryReferences: { node: "node_http" },
    }, { "idempotency-key": "draft-stage-0001" }), roomContext);

    expect(response.status).toBe(201);
    expect(observed).toMatchObject({
      operation: "room.agent.draft.stage",
      actorKind: "agent",
      idempotency: { namespace: "room.agent.draft.stage" },
    });
    expect(mocks.stageAgentCanvasDraft).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room_http",
      participantId: "p_session",
      request: expect.objectContaining({ temporaryReferences: { node: "node_http" } }),
    }));
  });

  it("routes replace, discard, and exact-revision commit under the agent surface", async () => {
    const replaced = await replace(request("PUT", {
      expectedDraftRevision: 1,
      baselineRoomRevision: 4,
      transaction,
      temporaryReferences: { node: "node_http" },
    }), draftContext);
    const discarded = await discard(request("DELETE", { expectedDraftRevision: 2 }), draftContext);
    const committed = await commit(request("POST", { expectedDraftRevision: 2 }), draftContext);

    expect([replaced.status, discarded.status, committed.status]).toEqual([200, 200, 200]);
    expect(mocks.replaceAgentCanvasDraft).toHaveBeenCalledWith(expect.objectContaining({ draftId: "draft_http" }));
    expect(mocks.discardAgentCanvasDraft).toHaveBeenCalledWith(expect.objectContaining({
      draftId: "draft_http",
      request: { expectedDraftRevision: 2 },
    }));
    expect(mocks.commitAgentCanvasDraft).toHaveBeenCalledWith(expect.objectContaining({
      draftId: "draft_http",
      request: { expectedDraftRevision: 2 },
    }));
  });

  it("requires a signed session and rejects oversized staging bodies before service execution", async () => {
    mocks.requireGuestParticipantId.mockImplementationOnce(() => { throw new Error("AUTH_REQUIRED"); });
    expect((await list(request("GET"), roomContext)).status).toBe(401);

    const oversized = "x".repeat(257 * 1024);
    const response = await stage(request("POST", { oversized }), roomContext);
    expect(response.status).toBe(413);
    expect(mocks.stageAgentCanvasDraft).not.toHaveBeenCalled();
  });
});
