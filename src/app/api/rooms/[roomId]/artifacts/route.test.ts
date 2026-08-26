// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  JAZZBOARD_ARTIFACT_FORMAT,
  JAZZBOARD_ARTIFACT_SCHEMA_URL,
  JAZZBOARD_ARTIFACT_VERSION,
  type JazzboardTemplateV1,
} from "@/lib/interchange/types";

const mocks = vi.hoisted(() => ({
  requireGuestParticipantId: vi.fn(),
  exportAuthorizedRoomArtifact: vi.fn(),
  instantiateAuthorizedRoomTemplate: vi.fn(),
}));

vi.mock("@/lib/server/session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));
vi.mock("@/lib/server/interchange-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/interchange-service")>()),
  exportAuthorizedRoomArtifact: mocks.exportAuthorizedRoomArtifact,
  instantiateAuthorizedRoomTemplate: mocks.instantiateAuthorizedRoomTemplate,
}));

import { GET as getAgentArtifact, POST as postAgentArtifact } from "../agent/artifacts/route";
import { GET as getHumanArtifact, POST as postHumanArtifact } from "./route";

const context = { params: Promise.resolve({ roomId: "room_private" }) };

function template(): JazzboardTemplateV1 {
  return {
    $schema: JAZZBOARD_ARTIFACT_SCHEMA_URL,
    format: JAZZBOARD_ARTIFACT_FORMAT,
    version: JAZZBOARD_ARTIFACT_VERSION,
    kind: "template",
    title: "Authorization flow",
    description: "Reusable authorization flow.",
    source: null,
    bounds: { x: 0, y: 0, width: 200, height: 100 },
    objects: [
      {
        id: "node_gateway",
        kind: "shape",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        rotation: 0,
        zIndex: 0,
        groupId: null,
        shape: "rectangle",
        nodeType: "service",
        nodeMetadata: null,
        label: "Gateway",
        fill: "blue",
        stroke: "black",
      },
    ],
    diagrams: [
      {
        id: "diagram_auth",
        title: "Authorization flow",
        description: "Reusable authorization flow.",
        diagramType: "flow",
        category: "security",
        tags: ["authorization"],
        memberObjectIds: ["node_gateway"],
        connectorIds: [],
      },
    ],
    warnings: [],
  };
}

function getRequest(query: string): Request {
  return new Request(`https://jazzboard.example/api/rooms/room_private/artifacts?${query}`, {
    headers: { cookie: "jazzboard_guest=signed" },
  });
}

function postRequest(body: unknown): Request {
  return new Request("https://jazzboard.example/api/rooms/room_private/artifacts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "jazzboard_guest=signed" },
    body: JSON.stringify(body),
  });
}

describe("authorized room artifact routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGuestParticipantId.mockReturnValue("p_authenticated");
    mocks.exportAuthorizedRoomArtifact.mockResolvedValue({
      format: "semantic_json",
      mediaType: "application/vnd.jazzboard.semantic+json; charset=utf-8",
      filename: "board.jazzboard.json",
      content: "{}\n",
      warnings: [],
      sourceRoomRevision: 8,
      sourceDiagramRevision: null,
    });
    mocks.instantiateAuthorizedRoomTemplate.mockResolvedValue({
      room: { id: "room_private", roomRevision: 9 },
      changedObjectIds: ["node_new"],
      changedDiagramIds: ["diagram_new"],
      membershipObjectIds: ["node_new"],
      idMap: { objects: {}, diagrams: {}, groups: {} },
      bounds: { x: 10, y: 20, width: 200, height: 100 },
      warnings: [],
      activity: { id: "activity_new" },
    });
  });

  it.each([
    ["human", getHumanArtifact],
    ["agent", getAgentArtifact],
  ] as const)("derives the signed participant and fixed %s actor for exports", async (actorKind, handler) => {
    const response = await handler(
      getRequest("format=svg&scope=selection&objectId=node_a&objectId=connector_ab"),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mocks.exportAuthorizedRoomArtifact).toHaveBeenCalledWith({
      roomId: "room_private",
      participantId: "p_authenticated",
      actorKind,
      format: "svg",
      scope: { kind: "selection", objectIds: ["node_a", "connector_ab"] },
    });
  });

  it.each([
    ["human", postHumanArtifact],
    ["agent", postAgentArtifact],
  ] as const)("derives the fixed %s actor for exact-revision instantiation", async (actorKind, handler) => {
    const body = {
      expectedRoomRevision: 8,
      template: template(),
      origin: { x: 500, y: 700 },
      baseZIndex: 40,
      intent: "Reuse the approved authorization pattern",
      summary: "Added one reusable Diagram",
    };
    const response = await handler(postRequest(body), context);

    expect(response.status).toBe(201);
    expect(mocks.instantiateAuthorizedRoomTemplate).toHaveBeenCalledWith({
      roomId: "room_private",
      participantId: "p_authenticated",
      actorKind,
      expectedRoomRevision: 8,
      template: body.template,
      origin: body.origin,
      baseZIndex: 40,
      metadata: {
        intent: "Reuse the approved authorization pattern",
        summary: "Added one reusable Diagram",
      },
    });
  });

  it("rejects ambiguous queries, unsupported PNG, and caller-supplied actor identity", async () => {
    for (const request of [
      getRequest("format=semantic_json&scope=selection"),
      getRequest("format=png&scope=room"),
      getRequest("format=svg&scope=room&diagramId=unexpected"),
    ]) {
      const response = await getHumanArtifact(request, context);
      expect(response.status).toBe(400);
    }
    const response = await postAgentArtifact(
      postRequest({
        expectedRoomRevision: 8,
        template: template(),
        origin: { x: 0, y: 0 },
        actorKind: "human",
        participantId: "p_spoofed",
      }),
      context,
    );
    expect(response.status).toBe(400);
    expect(mocks.exportAuthorizedRoomArtifact).not.toHaveBeenCalled();
    expect(mocks.instantiateAuthorizedRoomTemplate).not.toHaveBeenCalled();
  });

  it("requires a signed guest session before parsing or serving content", async () => {
    mocks.requireGuestParticipantId.mockImplementation(() => {
      throw new Error("AUTH_REQUIRED");
    });

    const response = await getHumanArtifact(getRequest("format=semantic_json&scope=room"), context);

    expect(response.status).toBe(401);
    expect(mocks.exportAuthorizedRoomArtifact).not.toHaveBeenCalled();
  });
});
