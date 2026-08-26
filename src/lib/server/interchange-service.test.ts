// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/domain/errors";
import type { SemanticTransaction } from "@/lib/domain/types";
import { parseJazzboardArtifactV1, parseJazzboardTemplateV1 } from "@/lib/interchange/schemas";

import {
  exportAuthorizedRoomArtifact,
  instantiateAuthorizedRoomTemplate,
} from "./interchange-service";
import {
  runSemanticTransaction,
  setAgentEditPolicy,
} from "./room-service";
import { getRoomStore } from "./room-store";

const START = new Date("2026-08-26T18:00:00.000Z");

async function expectDomainError(
  promise: Promise<unknown>,
  code: DomainError["code"],
): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
    return error as DomainError;
  }
  throw new Error(`Expected ${code}.`);
}

async function seededRoom() {
  const store = getRoomStore();
  const created = await store.createRoom({
    participantId: "p_owner",
    displayName: "Owner",
    title: "Authorization architecture",
  });
  await store.joinRoom({
    participantId: "p_spectator",
    displayName: "Spectator",
    code: created.code,
    role: "spectator",
  });
  const transaction: SemanticTransaction = {
    commands: [
      {
        type: "create",
        object: {
          id: "node_gateway",
          kind: "shape",
          x: 10,
          y: 20,
          width: 160,
          height: 90,
          rotation: 0,
          zIndex: 1,
          groupId: "group_auth",
          shape: "rectangle",
          nodeType: "service",
          label: "Gateway",
          fill: "blue",
          stroke: "black",
        },
      },
      {
        type: "create",
        object: {
          id: "node_decision",
          kind: "shape",
          x: 350,
          y: 20,
          width: 180,
          height: 90,
          rotation: 0,
          zIndex: 2,
          groupId: "group_auth",
          shape: "diamond",
          nodeType: "decision",
          nodeMetadata: {
            kind: "decision",
            status: "accepted",
            owner: "Architecture",
            resolution: "Use signed guest authorization.",
          },
          label: "Authorize guest",
          fill: "light-violet",
          stroke: "violet",
        },
      },
      {
        type: "create",
        object: {
          id: "connector_authorizes",
          kind: "connector",
          x: 170,
          y: 64,
          width: 180,
          height: 2,
          rotation: 0,
          zIndex: 3,
          groupId: null,
          start: { x: 170, y: 65, objectId: "node_gateway" },
          end: { x: 350, y: 65, objectId: "node_decision" },
          direction: "end",
          label: "authorizes",
          color: "black",
        },
      },
    ],
    diagramCommands: [
      {
        type: "diagram.create",
        diagram: {
          id: "diagram_auth",
          title: "Authentication flow",
          description: "Shows guest authorization through the gateway.",
          diagramType: "flow",
          category: "security",
          tags: ["authorization", "guest-session"],
          memberObjectIds: ["node_gateway", "node_decision"],
          connectorIds: ["connector_authorizes"],
        },
      },
    ],
  };
  const seeded = await runSemanticTransaction({
    roomId: created.id,
    participantId: "p_owner",
    actorKind: "human",
    transaction,
    metadata: { intent: "Seed an exportable Diagram" },
  });
  return { store, room: seeded.room };
}

describe("authorized portable artifact service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.stubEnv("REDIS_URL", "");
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
  });

  afterEach(() => {
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("lets spectators export redacted semantic, Mermaid, and SVG content", async () => {
    const { room } = await seededRoom();
    const common = {
      roomId: room.id,
      participantId: "p_spectator",
      actorKind: "agent" as const,
      scope: { kind: "diagram" as const, diagramId: "diagram_auth" },
    };

    const semantic = await exportAuthorizedRoomArtifact({ ...common, format: "semantic_json" });
    const artifact = parseJazzboardArtifactV1(JSON.parse(semantic.content));
    expect(artifact).toMatchObject({
      kind: "diagram",
      source: { roomRevision: room.roomRevision, diagramId: "diagram_auth" },
      diagrams: [{ title: "Authentication flow" }],
    });
    expect(semantic.content).not.toContain('"participants"');
    expect(semantic.content).not.toContain('"code"');
    expect(semantic.content).not.toContain("p_owner");
    expect(semantic.content).not.toContain("p_spectator");

    const mermaid = await exportAuthorizedRoomArtifact({ ...common, format: "mermaid" });
    expect(mermaid.content).toContain("flowchart LR");
    expect(mermaid.content).toContain("authorizes");
    const svg = await exportAuthorizedRoomArtifact({ ...common, format: "svg" });
    expect(svg.content).toContain("<svg");
    expect(svg.content).not.toContain("<script");
    expect(svg.content).not.toMatch(/\shref\s*=/i);
  });

  it("limits template export to participants and rejects unrelated sessions", async () => {
    const { room } = await seededRoom();
    const input = {
      roomId: room.id,
      actorKind: "agent" as const,
      format: "template" as const,
      scope: { kind: "diagram" as const, diagramId: "diagram_auth" },
    };
    await expectDomainError(
      exportAuthorizedRoomArtifact({ ...input, participantId: "p_spectator" }),
      "FORBIDDEN",
    );
    await expectDomainError(
      exportAuthorizedRoomArtifact({ ...input, participantId: "p_outsider" }),
      "FORBIDDEN",
    );

    const exported = await exportAuthorizedRoomArtifact({ ...input, participantId: "p_owner" });
    const parsed = parseJazzboardTemplateV1(JSON.parse(exported.content));
    expect(parsed).toMatchObject({
      kind: "template",
      source: null,
      diagrams: [{ id: "diagram_auth" }],
    });
    expect(exported.sourceRoomRevision).toBe(room.roomRevision);
    expect(exported.sourceDiagramRevision).toBe(room.diagrams.diagram_auth.revision);
  });

  it("applies a live template atomically with fresh IDs, attribution, lifecycle state, and activity metadata", async () => {
    const { store, room } = await seededRoom();
    const exported = await exportAuthorizedRoomArtifact({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      format: "template",
      scope: { kind: "diagram", diagramId: "diagram_auth" },
    });
    const reusable = parseJazzboardTemplateV1(JSON.parse(exported.content));
    const beforeActivities = await store.listActivities(room.id);
    vi.setSystemTime(new Date(START.getTime() + 60_000));
    const result = await instantiateAuthorizedRoomTemplate(
      {
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "agent",
        expectedRoomRevision: room.roomRevision,
        template: reusable,
        origin: { x: 1_000, y: 2_000 },
        baseZIndex: 100,
        metadata: {
          intent: "Reuse the signed authorization pattern",
          summary: "Added an authorization Diagram from a portable template",
        },
      },
      { createId: (kind, sourceId) => `fresh_${kind}_${sourceId}` },
    );

    expect(result).toMatchObject({
      outcome: "applied",
      changedObjectIds: [
        "fresh_shape_node_gateway",
        "fresh_shape_node_decision",
        "fresh_connector_connector_authorizes",
      ],
      changedDiagramIds: ["fresh_diagram_diagram_auth"],
      idMap: {
        objects: {
          node_gateway: "fresh_shape_node_gateway",
          node_decision: "fresh_shape_node_decision",
          connector_authorizes: "fresh_connector_connector_authorizes",
        },
        groups: { group_auth: "fresh_group_group_auth" },
      },
      activity: {
        actor: { participantId: "p_owner", kind: "agent" },
        intent: "Reuse the signed authorization pattern",
        summary: "Added an authorization Diagram from a portable template",
      },
      proposal: null,
    });
    expect(result.room.objects.fresh_shape_node_gateway).toMatchObject({
      x: 1_000,
      y: 2_000,
      revision: 1,
      groupId: "fresh_group_group_auth",
      createdBy: { participantId: "p_owner", kind: "agent" },
    });
    expect(result.room.objects.fresh_shape_node_decision).toMatchObject({
      nodeType: "decision",
      nodeMetadata: {
        status: "accepted",
        owner: "Architecture",
        resolution: "Use signed guest authorization.",
        resolvedAt: START.getTime() + 60_000,
      },
    });
    expect(result.room.objects.fresh_connector_connector_authorizes).toMatchObject({
      start: { objectId: "fresh_shape_node_gateway" },
      end: { objectId: "fresh_shape_node_decision" },
    });
    expect(await store.listActivities(room.id)).toHaveLength(beforeActivities.length + 1);

    const objectCount = Object.keys(result.room.objects).length;
    const stale = await expectDomainError(
      instantiateAuthorizedRoomTemplate({
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "agent",
        expectedRoomRevision: room.roomRevision,
        template: reusable,
        origin: { x: 3_000, y: 4_000 },
      }),
      "REVISION_CONFLICT",
    );
    expect(stale.details).toMatchObject({
      expectedRevision: room.roomRevision,
      currentRevision: result.room.roomRevision,
    });
    const afterFailure = await store.getRoom(room.id);
    expect(Object.keys(afterFailure!.objects)).toHaveLength(objectCount);
    expect(await store.listActivities(room.id)).toHaveLength(beforeActivities.length + 1);
  });

  it("submits the exact planned transaction for human review instead of bypassing review mode", async () => {
    const { store, room } = await seededRoom();
    const exported = await exportAuthorizedRoomArtifact({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "agent",
      format: "template",
      scope: { kind: "diagram", diagramId: "diagram_auth" },
    });
    const reusable = parseJazzboardTemplateV1(JSON.parse(exported.content));
    const policy = await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      policy: "review",
    });
    const beforeActivities = await store.listActivities(room.id);
    const result = await instantiateAuthorizedRoomTemplate(
      {
        roomId: room.id,
        participantId: "p_owner",
        actorKind: "agent",
        expectedRoomRevision: policy.room.roomRevision,
        template: reusable,
        origin: { x: 800, y: 900 },
        metadata: { intent: "Propose a reusable authorization pattern" },
      },
      { createId: (kind, sourceId) => `proposed_${kind}_${sourceId}` },
    );

    expect(result).toMatchObject({
      outcome: "proposed",
      changedObjectIds: [],
      changedDiagramIds: [],
      activity: null,
      proposal: {
        status: "pending",
        author: { participantId: "p_owner", kind: "agent" },
        intent: "Propose a reusable authorization pattern",
      },
    });
    expect(result.room.objects.proposed_shape_node_gateway).toBeUndefined();
    expect(result.idMap.objects.node_gateway).toBe("proposed_shape_node_gateway");
    expect(result.room.reviewProposals[0].request).toMatchObject({
      kind: "semantic_transaction",
      transaction: {
        commands: [
          { type: "create", object: { id: "proposed_shape_node_gateway" } },
          { type: "create", object: { id: "proposed_shape_node_decision" } },
          { type: "create", object: { id: "proposed_connector_connector_authorizes" } },
        ],
      },
    });
    expect(await store.listActivities(room.id)).toHaveLength(beforeActivities.length);
  });

  it("rejects spectators and generated-ID collisions before any room mutation", async () => {
    const { store, room } = await seededRoom();
    const exported = await exportAuthorizedRoomArtifact({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      format: "template",
      scope: { kind: "diagram", diagramId: "diagram_auth" },
    });
    const reusable = parseJazzboardTemplateV1(JSON.parse(exported.content));
    const baseline = await store.getRoom(room.id);

    await expectDomainError(
      instantiateAuthorizedRoomTemplate({
        roomId: room.id,
        participantId: "p_spectator",
        actorKind: "agent",
        expectedRoomRevision: room.roomRevision,
        template: reusable,
        origin: { x: 0, y: 0 },
      }),
      "FORBIDDEN",
    );
    await expectDomainError(
      instantiateAuthorizedRoomTemplate(
        {
          roomId: room.id,
          participantId: "p_owner",
          actorKind: "human",
          expectedRoomRevision: room.roomRevision,
          template: reusable,
          origin: { x: 0, y: 0 },
        },
        { createId: () => "node_gateway" },
      ),
      "REVISION_CONFLICT",
    );
    expect(await store.getRoom(room.id)).toEqual(baseline);
  });
});
