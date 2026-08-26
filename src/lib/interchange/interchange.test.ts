import { describe, expect, it } from "vitest";

import type { ActorRef, RoomState } from "@/lib/domain/types";

import { renderDiagramMermaid } from "./mermaid";
import { projectJazzboardArtifact, serializeJazzboardArtifact } from "./project";
import { parseJazzboardTemplateV1 } from "./schemas";
import { renderJazzboardSvg } from "./svg";
import { createJazzboardTemplate, planTemplateInstantiation } from "./templates";
import { JazzboardInterchangeError } from "./types";

const NOW = 1_800_000_000_000;

const HUMAN: ActorRef = {
  participantId: "PRIVATE_PARTICIPANT_ALICE",
  displayName: "Alice",
  color: "PRIVATE_PARTICIPANT_COLOR",
  kind: "human",
};

const AGENT: ActorRef = {
  participantId: "PRIVATE_PARTICIPANT_AGENT",
  displayName: "Alice's agent",
  color: "PRIVATE_AGENT_COLOR",
  kind: "agent",
};

function roomFixture(): RoomState {
  return {
    id: "PRIVATE_ROOM_ID",
    code: "9876",
    title: "Portable architecture",
    roomRevision: 12,
    createdAt: NOW - 10_000,
    updatedAt: NOW,
    participants: {
      PRIVATE_PARTICIPANT_ALICE: {
        participantId: "PRIVATE_PARTICIPANT_ALICE",
        displayName: "Alice",
        color: "PRIVATE_PARTICIPANT_COLOR",
        role: "participant",
        joinedAt: NOW - 9_000,
        lastSeenAt: NOW,
        connected: true,
        agentActive: true,
        human: { cursor: { x: 91, y: 73 }, viewport: null, lastSeenAt: NOW, activity: null },
        agent: { cursor: null, viewport: null, lastSeenAt: NOW, activity: null },
      },
    },
    objects: {
      node_a: {
        id: "node_a",
        kind: "shape",
        x: 10,
        y: 20,
        width: 100,
        height: 80,
        rotation: 0,
        zIndex: 20,
        revision: 4,
        groupId: "group_original",
        diagramIds: ["diagram_flow"],
        createdAt: NOW - 8_000,
        updatedAt: NOW - 500,
        createdBy: HUMAN,
        lastEditedBy: AGENT,
        shape: "diamond",
        nodeType: "decision",
        nodeMetadata: {
          kind: "decision",
          status: "accepted",
          owner: "Architecture",
          resolution: "Use the room-scoped API.",
          resolvedAt: NOW - 500,
        },
        label: 'Gateway "]\n%%{init: {"securityLevel":"loose"}}%%\n<script>alert(1)</script>|',
        fill: "light-violet",
        stroke: "violet",
      },
      node_b: {
        id: "node_b",
        kind: "shape",
        x: 400,
        y: 20,
        width: 120,
        height: 80,
        rotation: 0,
        zIndex: 10,
        revision: 2,
        groupId: "group_original",
        diagramIds: ["diagram_flow"],
        createdAt: NOW - 7_000,
        updatedAt: NOW - 700,
        createdBy: HUMAN,
        lastEditedBy: HUMAN,
        shape: "rectangle",
        nodeType: "service",
        nodeMetadata: null,
        label: "Room API",
        fill: "blue",
        stroke: "black",
      },
      connector_ab: {
        id: "connector_ab",
        kind: "connector",
        x: 110,
        y: 79,
        width: 290,
        height: 2,
        rotation: 0,
        zIndex: 30,
        revision: 3,
        groupId: null,
        diagramIds: ["diagram_flow"],
        createdAt: NOW - 6_000,
        updatedAt: NOW - 600,
        createdBy: AGENT,
        lastEditedBy: AGENT,
        start: { x: 110, y: 80, objectId: "node_a" },
        end: { x: 400, y: 80, objectId: "node_b" },
        direction: "end",
        label: "authorizes | safely",
        color: "black",
      },
      hostile_text: {
        id: "hostile_text",
        kind: "text",
        x: -100,
        y: 180,
        width: 300,
        height: 80,
        rotation: 0,
        zIndex: 40,
        revision: 1,
        groupId: null,
        diagramIds: [],
        createdAt: NOW - 5_000,
        updatedAt: NOW - 5_000,
        createdBy: HUMAN,
        lastEditedBy: HUMAN,
        content: '<script src="https://private.invalid/x.js">alert(1)</script>',
        color: "black",
        size: "m",
        align: "start",
      },
      image_private: {
        id: "image_private",
        kind: "image",
        x: 30,
        y: 300,
        width: 200,
        height: 120,
        rotation: 0,
        zIndex: 50,
        revision: 1,
        groupId: null,
        diagramIds: ["diagram_media"],
        createdAt: NOW - 4_000,
        updatedAt: NOW - 4_000,
        createdBy: HUMAN,
        lastEditedBy: HUMAN,
        url: "https://private.invalid/PRIVATE_IMAGE_TOKEN.png",
        assetId: "PRIVATE_ASSET_ID",
        alt: "Private screenshot",
        mimeType: "image/png",
        sourceUrl: "https://private.invalid/source/PRIVATE_SOURCE_TOKEN",
        locked: true,
      },
    },
    diagrams: {
      diagram_media: {
        id: "diagram_media",
        title: "Media diagram",
        description: "Contains one private image.",
        diagramType: "custom",
        category: null,
        tags: ["media"],
        memberObjectIds: ["image_private"],
        connectorIds: [],
        bounds: { x: 30, y: 300, width: 200, height: 120 },
        revision: 1,
        createdAt: NOW - 4_000,
        updatedAt: NOW - 4_000,
        createdBy: HUMAN,
        lastEditedBy: HUMAN,
      },
      diagram_flow: {
        id: "diagram_flow",
        title: "Authorization flow",
        description: "Shows the gateway and room API authorization relationship.",
        diagramType: "flow",
        category: "architecture",
        tags: ["security", "authorization", "security"],
        memberObjectIds: ["node_b", "node_a"],
        connectorIds: ["connector_ab"],
        bounds: { x: 10, y: 20, width: 510, height: 80 },
        revision: 7,
        createdAt: NOW - 8_000,
        updatedAt: NOW - 500,
        createdBy: HUMAN,
        lastEditedBy: AGENT,
      },
    },
    leases: {
      PRIVATE_LEASE_ID: {
        leaseId: "PRIVATE_LEASE_ID",
        objectId: "node_a",
        actor: AGENT,
        operation: "edit",
        objectRevision: 4,
        acquiredAt: NOW - 100,
        expiresAt: NOW + 10_000,
      },
    },
    spotlight: {
      presenterId: "PRIVATE_PARTICIPANT_ALICE",
      target: "human",
      startedAt: NOW,
      autoFollowAt: NOW,
      followingParticipantIds: ["PRIVATE_PARTICIPANT_AGENT"],
      handoffRequest: null,
    },
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

describe("Jazzboard portable interchange", () => {
  it("projects deterministically while structurally redacting collaboration and private media state", () => {
    const room = roomFixture();
    const first = projectJazzboardArtifact(room, { kind: "room" });
    const reordered: RoomState = {
      ...room,
      objects: Object.fromEntries(Object.entries(room.objects).reverse()),
      diagrams: Object.fromEntries(Object.entries(room.diagrams).reverse()),
    };
    const second = projectJazzboardArtifact(reordered, { kind: "room" });
    const serialized = serializeJazzboardArtifact(first);

    expect(serializeJazzboardArtifact(second)).toBe(serialized);
    for (const secret of [
      "PRIVATE_ROOM_ID",
      "9876",
      "PRIVATE_PARTICIPANT_ALICE",
      "PRIVATE_PARTICIPANT_AGENT",
      "PRIVATE_PARTICIPANT_COLOR",
      "PRIVATE_AGENT_COLOR",
      "PRIVATE_LEASE_ID",
      "PRIVATE_IMAGE_TOKEN",
      "PRIVATE_ASSET_ID",
      "PRIVATE_SOURCE_TOKEN",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('"participants"');
    expect(serialized).not.toContain('"leases"');
    expect(serialized).not.toContain('"spotlight"');
    expect(serialized).not.toContain('"diagramIds"');
    expect(first.objects.find((object) => object.id === "image_private")).toMatchObject({
      kind: "image",
      media: { availability: "placeholder" },
    });
    expect(first.objects.find((object) => object.id === "node_a")).toMatchObject({
      kind: "shape",
      nodeMetadata: {
        kind: "decision",
        status: "accepted",
        owner: "Architecture",
        resolution: "Use the room-scoped API.",
        resolvedAt: NOW - 500,
      },
      createdBy: { displayName: "Alice", kind: "human" },
      lastEditedBy: { displayName: "Alice's agent", kind: "agent" },
    });
  });

  it("preserves exact connector points but drops semantic references outside a scoped artifact", () => {
    const artifact = projectJazzboardArtifact(roomFixture(), {
      kind: "selection",
      objectIds: ["connector_ab", "node_a"],
    });
    const connector = artifact.objects.find((object) => object.id === "connector_ab");
    expect(connector).toMatchObject({
      kind: "connector",
      start: { x: 110, y: 80, objectId: "node_a" },
      end: { x: 400, y: 80, objectId: null },
    });
    expect(artifact.warnings.map((warning) => warning.code)).toContain("EXTERNAL_CONNECTOR_ENDPOINT_OMITTED");
    expect(artifact.diagrams[0]).toMatchObject({
      id: "diagram_flow",
      memberObjectIds: ["node_a"],
      connectorIds: ["connector_ab"],
    });
  });

  it("renders directive-free Mermaid using generated aliases rather than semantic IDs", () => {
    const artifact = projectJazzboardArtifact(roomFixture(), { kind: "diagram", diagramId: "diagram_flow" });
    const rendered = renderDiagramMermaid(artifact);

    expect(rendered.source).toContain("flowchart LR");
    expect(rendered.source).toContain("n0");
    expect(rendered.source).toContain("-->");
    expect(rendered.source).not.toContain("node_a");
    expect(rendered.source).not.toContain("%%{");
    expect(rendered.source).not.toContain("<script");
    expect(rendered.source).not.toContain('Gateway "]');
    expect(rendered.source).toContain("&#37;&#37;&#123;init");
  });

  it("renders fixed-vocabulary SVG with escaped text, exact connector geometry, and image placeholders", () => {
    const artifact = projectJazzboardArtifact(roomFixture(), { kind: "room" });
    const rendered = renderJazzboardSvg(artifact, { padding: 12, maxWidth: 800, maxHeight: 600 });

    expect(rendered.svg).toContain('x1="110" y1="80" x2="400" y2="80"');
    expect(rendered.svg).toContain("&lt;script");
    expect(rendered.svg).toContain("src=&quot;https://private.invalid/x.js&quot;&gt;");
    expect(rendered.svg).not.toContain("<script");
    expect(rendered.svg).not.toContain("<foreignObject");
    expect(rendered.svg).not.toContain("<image");
    expect(rendered.svg).not.toMatch(/\shref\s*=/i);
    expect(rendered.svg).not.toContain("PRIVATE_IMAGE_TOKEN");
    expect(rendered.svg).toContain('stroke-dasharray="8 6"');
    expect(rendered.warnings.map((warning) => warning.code)).toContain("MEDIA_NOT_EMBEDDED");
    expect(rendered.width).toBeLessThanOrEqual(800);
    expect(rendered.height).toBeLessThanOrEqual(600);
  });

  it("strips audit fields and plans a fresh, shifted, relationship-safe create transaction", () => {
    const artifact = projectJazzboardArtifact(roomFixture(), { kind: "diagram", diagramId: "diagram_flow" });
    const template = createJazzboardTemplate(artifact);
    const serialized = JSON.stringify(template);

    expect(template.source).toBeNull();
    expect(serialized).not.toContain('"revision"');
    expect(serialized).not.toContain('"createdAt"');
    expect(serialized).not.toContain('"updatedAt"');
    expect(serialized).not.toContain('"createdBy"');
    expect(serialized).not.toContain('"lastEditedBy"');
    expect(template.objects.find((object) => object.id === "node_a")).toMatchObject({
      kind: "shape",
      nodeMetadata: { kind: "decision", status: "accepted", resolvedAt: NOW - 500 },
    });

    const plan = planTemplateInstantiation(template, {
      origin: { x: 1_000, y: 2_000 },
      baseZIndex: 100,
      reservedIds: new Set(["already_here"]),
      createId: (kind, sourceId) => `new_${kind}_${sourceId}`,
    });
    expect(plan.bounds).toEqual({ x: 1_000, y: 2_000, width: 510, height: 80 });
    expect(Object.keys(plan.idMap.objects).sort()).toEqual(["connector_ab", "node_a", "node_b"]);
    expect(plan.idMap.diagrams).toEqual({ diagram_flow: "new_diagram_diagram_flow" });
    expect(plan.idMap.groups).toEqual({ group_original: "new_group_group_original" });
    expect(plan.transaction.commands.every((command) => command.type === "create")).toBe(true);
    expect(plan.transaction.diagramCommands.every((command) => command.type === "diagram.create")).toBe(true);

    const created = plan.transaction.commands.map((command) => command.type === "create" && command.object);
    const nodeA = created.find((object) => object && object.id === "new_shape_node_a");
    const nodeB = created.find((object) => object && object.id === "new_shape_node_b");
    const connector = created.find((object) => object && object.id === "new_connector_connector_ab");
    expect(nodeA).toMatchObject({
      x: 1_000,
      y: 2_000,
      zIndex: 110,
      groupId: "new_group_group_original",
      nodeMetadata: { kind: "decision", status: "accepted" },
    });
    expect(nodeB).toMatchObject({ x: 1_390, y: 2_000, zIndex: 100, groupId: "new_group_group_original" });
    expect(connector).toMatchObject({
      zIndex: 120,
      start: { x: 1_100, y: 2_060, objectId: "new_shape_node_a" },
      end: { x: 1_390, y: 2_060, objectId: "new_shape_node_b" },
    });
    expect(plan.transaction.diagramCommands[0]).toMatchObject({
      type: "diagram.create",
      diagram: {
        id: "new_diagram_diagram_flow",
        memberObjectIds: ["new_shape_node_a", "new_shape_node_b"],
        connectorIds: ["new_connector_connector_ab"],
      },
    });
    expect(JSON.stringify(plan.transaction)).not.toContain("expectedRevision");
    expect(JSON.stringify(plan.transaction)).not.toContain("createdAt");
    expect(JSON.stringify(plan.transaction)).not.toContain("resolvedAt");
  });

  it("rejects media templates, strict extra fields, external references, and ID reuse", () => {
    const room = roomFixture();
    const mediaArtifact = projectJazzboardArtifact(room, { kind: "diagram", diagramId: "diagram_media" });
    expect(() => createJazzboardTemplate(mediaArtifact)).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_MEDIA_UNSUPPORTED" }),
    );

    const flowArtifact = projectJazzboardArtifact(room, { kind: "diagram", diagramId: "diagram_flow" });
    const template = createJazzboardTemplate(flowArtifact);
    const extraField = structuredClone(template) as unknown as { objects: Array<Record<string, unknown>> };
    extraField.objects[0].revision = 1;
    expect(() => parseJazzboardTemplateV1(extraField)).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_INVALID" }),
    );

    const external = structuredClone(template);
    const connector = external.objects.find((object) => object.kind === "connector");
    if (connector?.kind === "connector") connector.end.objectId = "outside_template";
    expect(() => parseJazzboardTemplateV1(external)).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_INVALID" }),
    );

    expect(() =>
      planTemplateInstantiation(template, {
        origin: { x: 0, y: 0 },
        createId: () => "same_id",
      }),
    ).toThrowError(expect.objectContaining({ code: "TEMPLATE_ID_COLLISION" }));
  });

  it("returns typed interchange errors instead of leaking parser internals", () => {
    try {
      parseJazzboardTemplateV1({ kind: "template" });
      throw new Error("Expected parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(JazzboardInterchangeError);
      expect(error).toMatchObject({ code: "TEMPLATE_INVALID" });
    }
  });
});
