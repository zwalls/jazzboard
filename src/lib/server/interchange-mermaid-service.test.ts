// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/domain/errors";
import type { SemanticTransaction } from "@/lib/domain/types";
import { planMermaidImport } from "@/lib/interchange/mermaid-plan";

import { handleAuthorizedTemplateInstantiation } from "./interchange-http";
import { importAuthorizedRoomMermaidFlowchart } from "./interchange-service";
import { createMutationContext, runWithMutationContext } from "./mutation-context";
import { setAgentEditPolicy } from "./room-service";
import { getRoomStore } from "./room-store";
import { getOrCreateGuestSession } from "./session";

vi.mock("@/lib/interchange/mermaid-plan", () => ({
  planMermaidImport: vi.fn(),
}));

const SOURCE = "flowchart LR\n  api[API] -->|queries| db[(Database)]";

function plannedImport() {
  const transaction: SemanticTransaction = {
    commands: [
      {
        type: "create",
        object: {
          id: "import_node_api",
          kind: "shape",
          x: 500,
          y: 700,
          width: 200,
          height: 100,
          rotation: 0,
          zIndex: 1,
          groupId: null,
          shape: "rectangle",
          nodeType: "service",
          label: "API",
          fill: "blue",
          stroke: "black",
        },
      },
      {
        type: "create",
        object: {
          id: "import_node_db",
          kind: "shape",
          x: 900,
          y: 700,
          width: 200,
          height: 100,
          rotation: 0,
          zIndex: 2,
          groupId: null,
          shape: "rectangle",
          nodeType: "service",
          label: "Database",
          fill: "green",
          stroke: "black",
        },
      },
      {
        type: "create",
        object: {
          id: "import_edge_0",
          kind: "connector",
          x: 700,
          y: 750,
          width: 200,
          height: 2,
          rotation: 0,
          zIndex: 3,
          groupId: null,
          start: { x: 700, y: 750, objectId: "import_node_api" },
          end: { x: 900, y: 750, objectId: "import_node_db" },
          direction: "end",
          label: "queries",
          color: "black",
        },
      },
    ],
    diagramCommands: [
      {
        type: "diagram.create",
        diagram: {
          id: "import_diagram",
          title: "Service path",
          description: "Imported from Mermaid flowchart source.",
          diagramType: "flow",
          category: "architecture",
          tags: ["mermaid-import"],
          memberObjectIds: ["import_node_api", "import_node_db"],
          connectorIds: ["import_edge_0"],
        },
      },
    ],
  };
  return {
    transaction,
    idMap: {
      nodes: { api: "import_node_api", db: "import_node_db" },
      edges: { "edge-0": "import_edge_0" },
      groups: {},
      diagramId: "import_diagram",
    },
    warnings: ["Geometry must be inspected after import."],
    bounds: { x: 500, y: 700, width: 600, height: 100 },
  };
}

async function expectDomainError(promise: Promise<unknown>, code: DomainError["code"]) {
  await expect(promise).rejects.toMatchObject({ code });
}

async function seededRoom() {
  const store = getRoomStore();
  const created = await store.createRoom({
    participantId: "p_owner",
    displayName: "Owner",
    title: "Import room",
  });
  await store.joinRoom({
    participantId: "p_spectator",
    displayName: "Spectator",
    code: created.code,
    role: "spectator",
  });
  return { store, room: (await store.getRoom(created.id))! };
}

describe("authorized Mermaid import service", () => {
  beforeEach(() => {
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-enough-entropy");
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    vi.mocked(planMermaidImport).mockReset();
    vi.mocked(planMermaidImport).mockResolvedValue(plannedImport() as never);
  });

  afterEach(() => {
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    vi.unstubAllEnvs();
  });

  it("applies the complete native plan atomically with exact revision and attribution", async () => {
    const { store, room } = await seededRoom();
    const result = await importAuthorizedRoomMermaidFlowchart({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      expectedRoomRevision: room.roomRevision,
      source: SOURCE,
      title: "Service path",
      grouping: "boxed",
      origin: { x: 500, y: 700 },
      metadata: { intent: "Import the supplied Mermaid architecture" },
    });

    expect(planMermaidImport).toHaveBeenCalledWith(SOURCE, {
      title: "Service path",
      grouping: "boxed",
      origin: { x: 500, y: 700 },
    });
    expect(result).toMatchObject({
      outcome: "applied",
      changedObjectIds: ["import_node_api", "import_node_db", "import_edge_0"],
      changedDiagramIds: ["import_diagram"],
      idMap: {
        nodes: { api: "import_node_api", db: "import_node_db" },
        edges: { "edge-0": "import_edge_0" },
        diagramId: "import_diagram",
      },
      counts: { nodes: 2, edges: 1, groups: 0, diagrams: 1 },
      bounds: { x: 500, y: 700, width: 600, height: 100 },
      activity: { actor: { participantId: "p_owner", kind: "agent" } },
    });
    expect(result.room.objects.import_edge_0).toMatchObject({
      start: { objectId: "import_node_api" },
      end: { objectId: "import_node_db" },
    });
    expect((await store.getRoom(room.id))?.diagrams.import_diagram).toBeTruthy();

    await expectDomainError(importAuthorizedRoomMermaidFlowchart({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      expectedRoomRevision: room.roomRevision,
      source: SOURCE,
    }), "REVISION_CONFLICT");
  });

  it("preserves review mode and rejects spectator imports without changing canvas authority", async () => {
    const { store, room } = await seededRoom();
    await expectDomainError(importAuthorizedRoomMermaidFlowchart({
      roomId: room.id,
      participantId: "p_spectator",
      actorKind: "agent",
      expectedRoomRevision: room.roomRevision,
      source: SOURCE,
    }), "FORBIDDEN");
    expect(planMermaidImport).not.toHaveBeenCalled();

    const policy = await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      policy: "review",
    });
    const result = await importAuthorizedRoomMermaidFlowchart({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      expectedRoomRevision: policy.room.roomRevision,
      source: SOURCE,
      metadata: { summary: "Imported service path" },
    });

    expect(result).toMatchObject({
      outcome: "proposed",
      changedObjectIds: [],
      changedDiagramIds: [],
      proposal: { status: "pending", summary: "Imported service path" },
    });
    expect(result.room.objects.import_node_api).toBeUndefined();
    expect(result.room.reviewProposals[0].request).toMatchObject({
      kind: "semantic_transaction",
      transaction: { diagramCommands: [{ diagram: { id: "import_diagram" } }] },
    });
    expect((await store.getRoom(room.id))?.objects.import_node_api).toBeUndefined();
  });

  it("checks a verified mutation receipt before reparsing or replanning", async () => {
    const { store, room } = await seededRoom();
    const body = {
      action: "import_mermaid_flowchart",
      expectedRoomRevision: room.roomRevision,
      source: SOURCE,
      origin: { x: 500, y: 700 },
    };
    const context = () => createMutationContext({
      request: new Request(`https://jazzboard.test/api/rooms/${room.id}/agent/artifacts`, {
        method: "POST",
        headers: { "idempotency-key": "mermaid-import-replay-0001" },
      }),
      participantId: "p_owner",
      roomId: room.id,
      operation: "room.mermaid.import",
      actorKind: "agent",
      parsedBody: body,
    });
    const run = () => runWithMutationContext(context(), () =>
      importAuthorizedRoomMermaidFlowchart({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "agent",
        expectedRoomRevision: room.roomRevision,
        source: SOURCE,
        origin: body.origin,
      }),
    );

    const first = await run();
    await expect(run()).rejects.toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
      details: { replayed: true, committedRoomRevision: first.room.roomRevision },
    });
    expect(planMermaidImport).toHaveBeenCalledTimes(1);
    expect(Object.keys((await store.getRoom(room.id))!.objects)).toHaveLength(3);
  });

  it("dispatches the authenticated Mermaid action through the artifact HTTP mutation route", async () => {
    const session = getOrCreateGuestSession(new Request("https://jazzboard.test/"));
    const cookie = session.setCookie!.split(";", 1)[0];
    const room = await getRoomStore().createRoom({
      participantId: session.participantId,
      displayName: "Owner",
      title: "HTTP import room",
    });
    const body = {
      action: "import_mermaid_flowchart",
      expectedRoomRevision: room.roomRevision,
      source: SOURCE,
      title: "Service path",
      grouping: "boxed",
      origin: { x: 500, y: 700 },
      summary: "Imported Mermaid service path",
    };
    const response = await handleAuthorizedTemplateInstantiation(
      new Request(`https://jazzboard.test/api/rooms/${room.id}/agent/artifacts`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": "mermaid-http-import-0001",
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ roomId: room.id }) },
      "agent",
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      outcome: "applied",
      idMap: { diagramId: "import_diagram" },
      counts: { nodes: 2, edges: 1, groups: 0, diagrams: 1 },
      bounds: { x: 500, y: 700, width: 600, height: 100 },
      activity: { summary: "Imported Mermaid service path" },
    });
  });
});
