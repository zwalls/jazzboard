import { describe, expect, it } from "vitest";

import { connectorLabelMetrics } from "@/lib/domain/layout";
import type { ActorRef, RoomState } from "@/lib/domain/types";

import { renderDiagramMermaid } from "./mermaid";
import { projectJazzboardArtifact, serializeJazzboardArtifact } from "./project";
import { parseJazzboardArtifactV1, parseJazzboardTemplateV1 } from "./schemas";
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

  it("preserves canonical routing and exact endpoint attachment metadata through templates", () => {
    const room = roomFixture();
    const source = room.objects.connector_ab;
    if (source.kind !== "connector") throw new Error("Missing connector fixture.");
    source.routing = {
      mode: "auto",
      kind: "elbow",
      bend: 0,
      elbowMidPoint: 0.35,
      labelPosition: 0.7,
      labelPositionSource: "generated",
    };
    source.start = {
      ...source.start,
      normalizedAnchor: { x: 1, y: 0.25 },
      isPrecise: true,
      isExact: false,
      snap: "edge",
    };
    source.end = {
      ...source.end,
      normalizedAnchor: { x: 0, y: 0.75 },
      isPrecise: true,
      isExact: true,
      snap: "edge-point",
    };

    const artifact = projectJazzboardArtifact(room, { kind: "diagram", diagramId: "diagram_flow" });
    const projected = artifact.objects.find((object) => object.id === "connector_ab");
    expect(projected).toMatchObject({
      kind: "connector",
      routing: source.routing,
      start: {
        normalizedAnchor: { x: 1, y: 0.25 },
        isPrecise: true,
        isExact: false,
        snap: "edge",
      },
      end: {
        normalizedAnchor: { x: 0, y: 0.75 },
        isPrecise: true,
        isExact: true,
        snap: "edge-point",
      },
    });

    const template = createJazzboardTemplate(artifact);
    const planned = planTemplateInstantiation(template, {
      origin: { x: 1_000, y: 2_000 },
      createId: (kind, sourceId) => `routed_${kind}_${sourceId}`,
    });
    const instantiated = planned.transaction.commands.find(
      (command) => command.type === "create" && command.object.kind === "connector",
    );
    expect(instantiated).toMatchObject({
      type: "create",
      object: {
        routing: source.routing,
        start: {
          normalizedAnchor: { x: 1, y: 0.25 },
          isPrecise: true,
          isExact: false,
          snap: "edge",
        },
        end: {
          normalizedAnchor: { x: 0, y: 0.75 },
          isPrecise: true,
          isExact: true,
          snap: "edge-point",
        },
      },
    });
  });

  it("canonicalizes pre-routing v1 artifacts and templates to legacy straight connectors", () => {
    const artifact = projectJazzboardArtifact(roomFixture(), {
      kind: "diagram",
      diagramId: "diagram_flow",
    });
    const legacyArtifact = structuredClone(artifact) as unknown as {
      objects: Array<{ kind: string; routing?: unknown }>;
    };
    for (const object of legacyArtifact.objects) {
      if (object.kind === "connector") delete object.routing;
    }

    const parsedArtifact = parseJazzboardArtifactV1(legacyArtifact);
    expect(parsedArtifact.objects.find((object) => object.kind === "connector")).toMatchObject({
      routing: {
        mode: "straight",
        kind: "straight",
        bend: 0,
        elbowMidPoint: 0.5,
        labelPosition: 0.5,
      },
    });

    const template = createJazzboardTemplate(artifact);
    const legacyTemplate = structuredClone(template) as unknown as {
      objects: Array<{ kind: string; routing?: unknown }>;
    };
    for (const object of legacyTemplate.objects) {
      if (object.kind === "connector") delete object.routing;
    }
    expect(parseJazzboardTemplateV1(legacyTemplate).objects.find((object) => object.kind === "connector"))
      .toMatchObject({ routing: { mode: "straight", kind: "straight" } });
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
    expect(rendered.svg).toContain('fill="#f9fafb"');
    expect(rendered.svg).toContain(
      'fill="#f5eafa" stroke="#ae3ec9" stroke-width="3.5"',
    );
    expect(rendered.svg).toContain(
      'fill="#dce1f8" stroke="#1d1d1d" stroke-width="3.5"',
    );
    expect(rendered.svg).toContain(
      'font-family="Shantell Sans,Comic Sans MS,Comic Sans,cursive"',
    );
    expect(rendered.svg).toContain('font-size="22" font-weight="400"');
    expect(rendered.svg).toContain('stroke-width="5" stroke-linejoin="round" paint-order="stroke fill"');
    expect(rendered.svg).toContain('font-size="24" font-weight="400"');
    expect(rendered.svg).toContain(
      '<polygon points="400,80 388,86.96 388,73.04" fill="#1d1d1d"/>',
    );
    expect(rendered.svg).toContain("&lt;script");
    expect(rendered.svg).toContain("src=&quot;https://private.invalid/x.js&quot;&gt;");
    expect(rendered.svg).not.toContain("<script");
    expect(rendered.svg).not.toContain("<style");
    expect(rendered.svg).not.toContain("<foreignObject");
    expect(rendered.svg).not.toContain("<image");
    expect(rendered.svg).not.toContain("<marker");
    expect(rendered.svg).not.toMatch(/\shref\s*=/i);
    expect(rendered.svg).not.toContain("PRIVATE_IMAGE_TOKEN");
    expect(rendered.svg).toContain('stroke-dasharray="8 6"');
    expect(rendered.warnings.map((warning) => warning.code)).toContain("MEDIA_NOT_EMBEDDED");
    expect(rendered.width).toBeLessThanOrEqual(800);
    expect(rendered.height).toBeLessThanOrEqual(600);
  });

  it("renders straight, curved, and elbow routes with labels and bounds resolved along each path", () => {
    const artifact = projectJazzboardArtifact(roomFixture(), {
      kind: "diagram",
      diagramId: "diagram_flow",
    });
    const connector = artifact.objects.find((object) => object.id === "connector_ab");
    if (!connector || connector.kind !== "connector") throw new Error("Missing connector fixture.");
    connector.x = 0;
    connector.y = 0;
    connector.width = 200;
    connector.height = 1;
    connector.start = { x: 0, y: 0, objectId: null };
    connector.end = { x: 200, y: 0, objectId: null };
    connector.label = "route label";
    artifact.objects = [connector];
    artifact.diagrams[0].memberObjectIds = [];
    artifact.diagrams[0].connectorIds = [connector.id];
    artifact.diagrams[0].bounds = { x: 0, y: 0, width: 200, height: 1 };
    artifact.bounds = { x: 0, y: 0, width: 200, height: 1 };

    connector.routing = {
      mode: "straight",
      kind: "straight",
      bend: 0,
      elbowMidPoint: 0.5,
      labelPosition: 0.5,
    };
    const straight = renderJazzboardSvg(artifact, { padding: 0, maxWidth: 8_192, maxHeight: 8_192 });
    expect(straight.svg).toContain('<line x1="0" y1="0" x2="200" y2="0"');

    connector.routing = {
      mode: "curved",
      kind: "curved",
      bend: 60,
      elbowMidPoint: 0.5,
      labelPosition: 0.5,
    };
    const curved = renderJazzboardSvg(artifact, { padding: 0, maxWidth: 8_192, maxHeight: 8_192 });
    expect(curved.svg).toMatch(/<path d="M 0 0 A [^"]+ 200 0" fill="none"/);

    connector.end = { x: 200, y: 100, objectId: null };
    connector.height = 100;
    connector.routing = {
      mode: "elbow",
      kind: "elbow",
      bend: 0,
      elbowMidPoint: 0.25,
      labelPosition: 0.75,
    };
    artifact.bounds = { x: 0, y: 0, width: 200, height: 100 };
    const elbow = renderJazzboardSvg(artifact, { padding: 0, maxWidth: 8_192, maxHeight: 8_192 });
    expect(elbow.svg).toMatch(/<path d="M 0 0 L [^"]+ L 200 100" fill="none"/);

    const labelBox = elbow.svg.match(
      /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" rx="4"/,
    );
    const labelText = elbow.svg.match(/<text[^>]+ x="([^"]+)" y="([^"]+)"[^>]+font-size="20"/);
    const viewBox = elbow.svg.match(/viewBox="([^"]+)"/);
    expect(labelBox).not.toBeNull();
    expect(labelText).not.toBeNull();
    expect(viewBox).not.toBeNull();
    if (!labelBox || !labelText || !viewBox) throw new Error("Missing routed label or view bounds.");
    expect(Number(labelText[1])).not.toBe(100);
    expect(Number(labelText[2])).toBeGreaterThan(50);
    const [viewX, viewY, viewWidth, viewHeight] = viewBox[1].split(" ").map(Number);
    const [, rawX, rawY, rawWidth, rawHeight] = labelBox;
    expect(viewX).toBeLessThanOrEqual(Number(rawX));
    expect(viewY).toBeLessThanOrEqual(Number(rawY));
    expect(viewX + viewWidth).toBeGreaterThanOrEqual(Number(rawX) + Number(rawWidth));
    expect(viewY + viewHeight).toBeGreaterThanOrEqual(Number(rawY) + Number(rawHeight));
  });

  it("wraps connector labels on a readable background and includes the full label box in view bounds", () => {
    const artifact = projectJazzboardArtifact(roomFixture(), { kind: "room" });
    const connector = artifact.objects.find((object) => object.id === "connector_ab");
    expect(connector?.kind).toBe("connector");
    if (!connector || connector.kind !== "connector") throw new Error("Missing connector fixture.");

    connector.x = 100;
    connector.y = 100;
    connector.width = 20;
    connector.height = 1;
    connector.start = { x: 100, y: 100, objectId: null };
    connector.end = { x: 120, y: 100, objectId: null };
    connector.label =
      "authorizes requests across a private guest session boundary and validates active-object leases\n<script>alert(1)</script>";
    artifact.objects = [connector];
    artifact.diagrams = [];
    artifact.bounds = { x: 100, y: 100, width: 20, height: 1 };

    const metrics = connectorLabelMetrics(connector.label);
    const rendered = renderJazzboardSvg(artifact, { padding: 0, maxWidth: 8_192, maxHeight: 8_192 });
    const labelBox = rendered.svg.match(
      /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" rx="4"/,
    );
    const viewBox = rendered.svg.match(/viewBox="([^"]+)"/);
    expect(labelBox).not.toBeNull();
    expect(viewBox).not.toBeNull();
    if (!labelBox || !viewBox) throw new Error("Missing SVG label or view bounds.");

    const [, rawLabelX, rawLabelY, rawLabelWidth, rawLabelHeight] = labelBox;
    const [viewX, viewY, viewWidth, viewHeight] = viewBox[1].split(" ").map(Number);
    const labelX = Number(rawLabelX);
    const labelY = Number(rawLabelY);
    const labelWidth = Number(rawLabelWidth);
    const labelHeight = Number(rawLabelHeight);
    expect(labelWidth).toBe(metrics.width);
    expect(labelHeight).toBe(metrics.height);
    expect(viewX).toBeLessThanOrEqual(labelX);
    expect(viewY).toBeLessThanOrEqual(labelY);
    expect(viewX + viewWidth).toBeGreaterThanOrEqual(labelX + labelWidth);
    expect(viewY + viewHeight).toBeGreaterThanOrEqual(labelY + labelHeight);
    expect(rendered.svg.match(/<tspan /g)?.length).toBeGreaterThan(2);
    expect(rendered.svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered.svg).not.toContain("<script");
    expect(rendered.svg).not.toContain("<style");
    expect(rendered.svg).not.toContain("<foreignObject");
    expect(rendered.svg).not.toContain("<image");
    expect(rendered.svg).not.toMatch(/\shref\s*=/i);
  });

  it("renders connector arrowheads and draw widths with the shared semantic visual contract", () => {
    const artifact = projectJazzboardArtifact(roomFixture(), { kind: "room" });
    const connector = artifact.objects.find((object) => object.id === "connector_ab");
    if (!connector || connector.kind !== "connector") throw new Error("Missing connector fixture.");
    connector.color = "blue";
    connector.direction = "both";
    connector.label = "";
    connector.start = { ...connector.start, objectId: null };
    connector.end = { ...connector.end, objectId: null };
    artifact.objects = [connector];
    artifact.diagrams = [];
    artifact.bounds = { x: 110, y: 80, width: 290, height: 1 };

    const connectorSvg = renderJazzboardSvg(artifact, {
      padding: 0,
      maxWidth: 8_192,
      maxHeight: 8_192,
    }).svg;
    expect(connectorSvg).toContain('stroke="#4465e9" stroke-width="3.5"');
    expect(connectorSvg).toContain(
      '<polygon points="110,80 122,73.04 122,86.96" fill="#4465e9"/>',
    );
    expect(connectorSvg).toContain(
      '<polygon points="400,80 388,86.96 388,73.04" fill="#4465e9"/>',
    );
    expect(connectorSvg).not.toContain("marker-");

    const attribution = { displayName: "Alice", kind: "human" as const };
    artifact.objects = [
      {
        id: "draw_s",
        kind: "draw",
        x: 0,
        y: 0,
        width: 20,
        height: 10,
        rotation: 0,
        zIndex: 1,
        groupId: null,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: attribution,
        lastEditedBy: attribution,
        points: [{ x: 0, y: 0 }, { x: 20, y: 10 }],
        color: "red",
        size: "s",
      },
      {
        id: "draw_m",
        kind: "draw",
        x: 30,
        y: 0,
        width: 20,
        height: 10,
        rotation: 0,
        zIndex: 2,
        groupId: null,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: attribution,
        lastEditedBy: attribution,
        points: [{ x: 0, y: 0 }, { x: 20, y: 10 }],
        color: "red",
        size: "m",
      },
      {
        id: "draw_l",
        kind: "draw",
        x: 60,
        y: 0,
        width: 20,
        height: 10,
        rotation: 0,
        zIndex: 3,
        groupId: null,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: attribution,
        lastEditedBy: attribution,
        points: [{ x: 0, y: 0 }, { x: 20, y: 10 }],
        color: "red",
        size: "l",
      },
    ];
    artifact.bounds = { x: 0, y: 0, width: 80, height: 10 };
    const drawSvg = renderJazzboardSvg(artifact, {
      padding: 0,
      maxWidth: 8_192,
      maxHeight: 8_192,
    }).svg;
    expect(drawSvg).toContain('stroke="#e03131" stroke-width="3"');
    expect(drawSvg).toContain('stroke="#e03131" stroke-width="4.5"');
    expect(drawSvg).toContain('stroke="#e03131" stroke-width="6"');
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

    const invalidRouting = structuredClone(template);
    const routedConnector = invalidRouting.objects.find((object) => object.kind === "connector");
    if (routedConnector?.kind === "connector") {
      routedConnector.routing = {
        mode: "curved",
        kind: "straight",
        bend: 25,
        elbowMidPoint: 0.5,
        labelPosition: 0.5,
      };
    }
    expect(() => parseJazzboardTemplateV1(invalidRouting)).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_INVALID" }),
    );

    const subMinimumCurve = structuredClone(template);
    const subMinimumConnector = subMinimumCurve.objects.find((object) => object.kind === "connector");
    if (subMinimumConnector?.kind === "connector") {
      subMinimumConnector.routing = {
        mode: "curved",
        kind: "curved",
        bend: 4,
        elbowMidPoint: 0.5,
        labelPosition: 0.5,
      };
    }
    expect(() => parseJazzboardTemplateV1(subMinimumCurve)).toThrowError(
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
