import { describe, expect, it } from "vitest";

import { normalizeConnectorRouting } from "./connector-routing";
import {
  DIAGRAM_VISUAL_QUALITY_LIMITS,
  DIAGRAM_VISUAL_QUALITY_THRESHOLDS,
  analyzeDiagramVisualQuality,
  type DiagramVisualQualityFindingCode,
} from "./diagram-visual-quality";
import type {
  ActorRef,
  CanvasObject,
  ConnectorObject,
  Diagram,
  DrawObject,
  PathObject,
  Point,
  RoomState,
  ShapeObject,
  TextObject,
} from "./types";

const actor: ActorRef = {
  participantId: "quality-agent",
  displayName: "Quality Agent",
  color: "blue",
  kind: "agent",
};

function base(id: string, createdAt = 1) {
  return {
    id,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    rotation: 0,
    zIndex: 0,
    revision: 1,
    groupId: null,
    diagramIds: ["quality-diagram"],
    createdAt,
    updatedAt: createdAt,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function node(
  id: string,
  x: number,
  y: number,
  options: {
    width?: number;
    height?: number;
    label?: string;
    groupId?: string | null;
    rotation?: number;
    semanticRole?: string | null;
    zIndex?: number;
  } = {},
): ShapeObject {
  return {
    ...base(id),
    kind: "shape",
    x,
    y,
    width: options.width ?? 120,
    height: options.height ?? 70,
    rotation: options.rotation ?? 0,
    zIndex: options.zIndex ?? 0,
    groupId: options.groupId ?? null,
    semanticRole: options.semanticRole ?? null,
    shape: "rectangle",
    nodeType: "service",
    label: options.label ?? id,
    fill: "blue",
    stroke: "blue",
  };
}

function text(
  id: string,
  x: number,
  y: number,
  content: string,
  options: { width?: number; height?: number; size?: TextObject["size"] } = {},
): TextObject {
  return {
    ...base(id),
    kind: "text",
    x,
    y,
    width: options.width ?? 80,
    height: options.height ?? 180,
    content,
    color: "black",
    size: options.size ?? "m",
    align: "start",
  };
}

function edge(
  id: string,
  start: Point & { objectId?: string | null; normalizedAnchor?: Point },
  end: Point & { objectId?: string | null; normalizedAnchor?: Point },
  options: { label?: string; routing?: "straight" | "elbow"; createdAt?: number } = {},
): ConnectorObject {
  return {
    ...base(id, options.createdAt ?? 1),
    kind: "connector",
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.max(1, Math.abs(end.x - start.x)),
    height: Math.max(1, Math.abs(end.y - start.y)),
    start: {
      x: start.x,
      y: start.y,
      objectId: start.objectId ?? null,
      ...(start.normalizedAnchor
        ? { normalizedAnchor: start.normalizedAnchor, isPrecise: true, isExact: false, snap: "edge" as const }
        : {}),
    },
    end: {
      x: end.x,
      y: end.y,
      objectId: end.objectId ?? null,
      ...(end.normalizedAnchor
        ? { normalizedAnchor: end.normalizedAnchor, isPrecise: true, isExact: false, snap: "edge" as const }
        : {}),
    },
    routing: normalizeConnectorRouting({
      mode: options.routing ?? "straight",
      elbowMidPoint: 0.5,
      labelPosition: 0.5,
    }),
    direction: "end",
    label: options.label ?? "",
    color: "black",
  };
}

function diagram(objects: readonly CanvasObject[]): Diagram {
  return {
    id: "quality-diagram",
    title: "Quality fixture",
    description: "",
    diagramType: "architecture",
    category: null,
    tags: [],
    memberObjectIds: objects.filter((object) => object.kind !== "connector").map((object) => object.id),
    connectorIds: objects.filter((object) => object.kind === "connector").map((object) => object.id),
    bounds: { x: 0, y: 0, width: 1_000, height: 1_000 },
    revision: 7,
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function room(objects: readonly CanvasObject[], sourceDiagram = diagram(objects)) {
  return {
    roomRevision: 23,
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: { [sourceDiagram.id]: sourceDiagram },
  } satisfies Pick<RoomState, "roomRevision" | "objects" | "diagrams">;
}

function codes(report: ReturnType<typeof analyzeDiagramVisualQuality>): Set<DiagramVisualQualityFindingCode> {
  return new Set(report.findings.map((finding) => finding.code));
}

function cleanTwelveNodeFixture(): CanvasObject[] {
  const nodes = Array.from({ length: 12 }, (_, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    return node(`clean-${index.toString().padStart(2, "0")}`, column * 280, row * 220);
  });
  const connectors: ConnectorObject[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const left = nodes[row * 4 + column];
      const right = nodes[row * 4 + column + 1];
      connectors.push(edge(
        `clean-edge-${row}-${column}`,
        { x: left.x + left.width, y: left.y + left.height / 2, objectId: left.id, normalizedAnchor: { x: 1, y: 0.5 } },
        { x: right.x, y: right.y + right.height / 2, objectId: right.id, normalizedAnchor: { x: 0, y: 0.5 } },
      ));
    }
  }
  return [...nodes, ...connectors];
}

function denseTwelveNodeFixture(): CanvasObject[] {
  const nodes = Array.from({ length: 12 }, (_, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    return node(`dense-${index.toString().padStart(2, "0")}`, column * 140, row * 90, {
      label: index === 0
        ? "This service label is far too long to fit inside one compact node"
        : `Service ${index}`,
    });
  });
  const [a, b, , d, , f, , , i, j, , l] = nodes;
  return [
    ...nodes,
    edge(
      "dense-diagonal-a",
      { x: a.x + a.width, y: a.y + a.height / 2, objectId: a.id, normalizedAnchor: { x: 1, y: 0.5 } },
      { x: l.x, y: l.y + l.height / 2, objectId: l.id, normalizedAnchor: { x: 0, y: 0.5 } },
      { label: "primary workflow" },
    ),
    edge(
      "dense-diagonal-b",
      { x: d.x, y: d.y + d.height / 2, objectId: d.id, normalizedAnchor: { x: 0, y: 0.5 } },
      { x: i.x + i.width, y: i.y + i.height / 2, objectId: i.id, normalizedAnchor: { x: 1, y: 0.5 } },
      { label: "secondary workflow" },
    ),
    edge(
      "dense-vertical",
      { x: b.x + b.width / 2, y: b.y + b.height, objectId: b.id, normalizedAnchor: { x: 0.5, y: 1 } },
      { x: j.x + j.width / 2, y: j.y, objectId: j.id, normalizedAnchor: { x: 0.5, y: 0 } },
      { label: "events" },
    ),
    edge(
      "dense-horizontal",
      { x: 0, y: f.y + f.height / 2 },
      { x: 540, y: f.y + f.height / 2 },
      { label: "overloaded middle lane" },
    ),
  ];
}

describe("diagram visual quality analysis", () => {
  it("passes a realistic, comfortably spaced twelve-node architecture", () => {
    const objects = cleanTwelveNodeFixture();
    const report = analyzeDiagramVisualQuality(room(objects), "quality-diagram");

    expect(report).toMatchObject({
      schemaVersion: 1,
      diagramId: "quality-diagram",
      diagramRevision: 7,
      roomRevision: 23,
      status: "pass",
      geometryCoverage: {
        status: "complete",
        analyzedMemberObjectCount: 12,
        unsupportedDrawObjectCount: 0,
        unsupportedDrawObjectIds: [],
      },
      metrics: {
        memberObjectCount: 12,
        unsupportedDrawMemberCount: 0,
        connectorCount: 9,
        findingCount: 0,
        minimumMemberSpacing: 150,
      },
    });
    expect(report.findings).toEqual([]);
  });

  it("fails a realistic dense twelve-node architecture with actionable geometry findings", () => {
    const objects = denseTwelveNodeFixture();
    const report = analyzeDiagramVisualQuality(room(objects), "quality-diagram");
    const findingCodes = codes(report);

    expect(report.status).toBe("fail");
    expect(report.metrics.memberObjectCount).toBe(12);
    expect(report.metrics.connectorCount).toBe(4);
    expect(report.metrics.failCount).toBeGreaterThan(0);
    expect(report.metrics.warningCount).toBeGreaterThan(0);
    expect(findingCodes).toEqual(expect.objectContaining(new Set([
      "MEMBER_SPACING_TOO_SMALL",
      "CONNECTOR_OBJECT_INTRUSION",
      "CONNECTOR_CROSSING",
      "CONNECTOR_LABEL_OBJECT_COLLISION",
      "SHAPE_LABEL_LIKELY_TRUNCATED",
    ])));
    expect(report.findings.every((finding) => finding.summary.length > 20)).toBe(true);
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it("reports renderer-equivalent truncation for text content and connector labels", () => {
    const longText = text(
      "long-text",
      0,
      0,
      Array.from({ length: 7 }, (_, index) => `line${index + 1}`).join("\n"),
      { height: 320 },
    );
    const anchor = node("anchor", 500, 500);
    const longConnector = edge(
      "long-connector",
      { x: 800, y: 500 },
      { x: 1_200, y: 500 },
      {
        label: Array.from({ length: 21 }, (_, index) =>
          String.fromCharCode(97 + index)).join("\n"),
      },
    );
    const report = analyzeDiagramVisualQuality(
      room([longText, anchor, longConnector]),
      "quality-diagram",
    );

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "TEXT_CONTENT_LIKELY_TRUNCATED",
      status: "warning",
      objectIds: ["long-text"],
      connectorIds: [],
      details: {
        maximumCharactersPerLine: 8,
        maximumLines: 6,
        requiredLines: 7,
      },
    }));
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "CONNECTOR_LABEL_LIKELY_TRUNCATED",
      status: "warning",
      objectIds: [],
      connectorIds: ["long-connector"],
      details: {
        maximumCharactersPerLine: 1,
        maximumLines: 20,
        requiredLines: 21,
      },
    }));
    expect(report.metrics).toMatchObject({
      truncatedTextContentCount: 1,
      truncatedConnectorLabelCount: 1,
    });
  });

  it("does not warn when text content and connector labels exactly fit renderer limits", () => {
    const exactText = text(
      "exact-text",
      0,
      0,
      Array.from({ length: 6 }, (_, index) => `line${index + 1}`).join("\n"),
      { height: 320 },
    );
    const anchor = node("anchor", 500, 500);
    const exactConnector = edge(
      "exact-connector",
      { x: 800, y: 500 },
      { x: 1_200, y: 500 },
      {
        label: Array.from({ length: 20 }, (_, index) =>
          String.fromCharCode(97 + index)).join("\n"),
      },
    );
    const report = analyzeDiagramVisualQuality(
      room([exactText, anchor, exactConnector]),
      "quality-diagram",
    );

    expect(codes(report)).not.toContain("TEXT_CONTENT_LIKELY_TRUNCATED");
    expect(codes(report)).not.toContain("CONNECTOR_LABEL_LIKELY_TRUNCATED");
    expect(report.metrics).toMatchObject({
      truncatedTextContentCount: 0,
      truncatedConnectorLabelCount: 0,
    });
  });

  it("warns when text baselines exceed object height while tall text retains the six-line cap", () => {
    const short = text("short-text", 0, 0, "one\ntwo\nthree\nfour", { height: 96 });
    const tall = text(
      "tall-text",
      500,
      0,
      Array.from({ length: 6 }, (_, index) => `line${index + 1}`).join("\n"),
      { height: 320 },
    );
    const report = analyzeDiagramVisualQuality(room([short, tall]), "quality-diagram");

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "TEXT_CONTENT_LIKELY_TRUNCATED",
      objectIds: ["short-text"],
      details: {
        maximumCharactersPerLine: 8,
        maximumLines: 3,
        requiredLines: 4,
      },
    }));
    expect(report.findings).not.toContainEqual(expect.objectContaining({
      code: "TEXT_CONTENT_LIKELY_TRUNCATED",
      objectIds: ["tall-text"],
    }));
  });

  it("detects label collisions, unrelated shared segments, and shared initial corridors", () => {
    const hub = node("hub", 0, 0);
    const targets = [
      node("target-a", 400, -180),
      node("target-b", 400, 0),
      node("target-c", 400, 180),
    ];
    const hubEdges = targets.map((target, index) => edge(
      `hub-edge-${index}`,
      { x: hub.x + hub.width, y: hub.y + hub.height / 2, objectId: hub.id, normalizedAnchor: { x: 1, y: 0.5 } },
      { x: target.x, y: target.y + target.height / 2, objectId: target.id, normalizedAnchor: { x: 0, y: 0.5 } },
      { routing: "elbow" },
    ));
    const objects: CanvasObject[] = [
      hub,
      ...targets,
      ...hubEdges,
      edge("shared-a", { x: 0, y: 500 }, { x: 300, y: 500 }),
      edge("shared-b", { x: 100, y: 500 }, { x: 400, y: 500 }),
      edge("label-horizontal", { x: 100, y: 650 }, { x: 500, y: 650 }, { label: "same center" }),
      edge("label-vertical", { x: 300, y: 450 }, { x: 300, y: 850 }, { label: "same center" }),
    ];
    const report = analyzeDiagramVisualQuality(room(objects), "quality-diagram");
    const findingCodes = codes(report);

    expect(findingCodes).toEqual(expect.objectContaining(new Set([
      "ATTACHMENT_PORT_CONGESTION",
      "CONNECTOR_SHARED_INITIAL_CORRIDOR",
      "CONNECTOR_SHARED_SEGMENT",
      "CONNECTOR_LABEL_LABEL_COLLISION",
      "CONNECTOR_LABEL_EDGE_COLLISION",
    ])));
    expect(report.metrics.congestedPortCount).toBe(1);
    expect(report.findings.find((finding) => finding.code === "ATTACHMENT_PORT_CONGESTION")).toMatchObject({
      objectIds: ["hub"],
      connectorIds: ["hub-edge-0", "hub-edge-1", "hub-edge-2"],
    });
  });

  it("ignores intentional overlap within one group but reports ungrouped overlap", () => {
    const groupedA = node("grouped-a", 0, 0, { groupId: "intentional" });
    const groupedB = node("grouped-b", 20, 20, { groupId: "intentional" });
    const ungrouped = node("ungrouped", 40, 40);
    const objects = [groupedA, groupedB, ungrouped];
    const report = analyzeDiagramVisualQuality(room(objects), "quality-diagram");
    const overlapPairs = report.findings
      .filter((finding) => finding.code === "MEMBER_OBJECT_OVERLAP")
      .map((finding) => finding.objectIds);

    expect(overlapPairs).not.toContainEqual(["grouped-a", "grouped-b"]);
    expect(overlapPairs).toContainEqual(["grouped-a", "ungrouped"]);
    expect(overlapPairs).toContainEqual(["grouped-b", "ungrouped"]);
  });

  it("treats explicit background containers as semantic context, not colliding members", () => {
    const boundary = node("commerce-boundary", 300, 80, {
      width: 820,
      height: 440,
      label: "Commerce trust boundary",
      semanticRole: "architecture.trust_boundary",
      zIndex: 0,
    });
    const shopper = node("shopper", 20, 360, { width: 180, zIndex: 1 });
    const checkout = node("checkout", 420, 360, { width: 180, zIndex: 1 });
    const payment = node("payment", 850, 340, { width: 180, zIndex: 1 });
    const fulfillment = node("fulfillment", 850, 450, { width: 180, zIndex: 1 });
    const connectors = [
      edge(
        "checkout-request",
        { x: 200, y: 395, objectId: shopper.id, normalizedAnchor: { x: 1, y: 0.5 } },
        { x: 420, y: 395, objectId: checkout.id, normalizedAnchor: { x: 0, y: 0.5 } },
        { label: "checkout request" },
      ),
      edge(
        "authorization",
        { x: 600, y: 378, objectId: checkout.id, normalizedAnchor: { x: 1, y: 0.25 } },
        { x: 850, y: 375, objectId: payment.id, normalizedAnchor: { x: 0, y: 0.5 } },
        { label: "authorization" },
      ),
      edge(
        "order-created",
        { x: 600, y: 413, objectId: checkout.id, normalizedAnchor: { x: 1, y: 0.75 } },
        { x: 850, y: 485, objectId: fulfillment.id, normalizedAnchor: { x: 0, y: 0.5 } },
        { label: "order-created" },
      ),
    ].map((connector) => ({ ...connector, zIndex: 2 }));

    const report = analyzeDiagramVisualQuality(
      room([boundary, shopper, checkout, payment, fulfillment, ...connectors]),
      "quality-diagram",
    );

    expect(report.status).toBe("pass");
    expect(report.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "MEMBER_OBJECT_OVERLAP",
        objectIds: expect.arrayContaining([boundary.id]),
      }),
      expect.objectContaining({
        code: "CONNECTOR_OBJECT_INTRUSION",
        objectIds: [boundary.id],
      }),
      expect.objectContaining({
        code: "CONNECTOR_LABEL_OBJECT_COLLISION",
        objectIds: [boundary.id],
      }),
    ]));
  });

  it("recognizes an outside-to-inside connector as a structural container crossing", () => {
    const boundary = node("zz-commerce-boundary", 300, 80, {
      width: 820,
      height: 440,
      label: "Commerce trust boundary",
      semanticRole: "architecture.trust_boundary",
      zIndex: 0,
    });
    const shopper = node("shopper", 20, 240, { width: 180, zIndex: 1 });
    const checkout = node("checkout", 420, 240, { width: 180, zIndex: 1 });
    const crossing = edge(
      "aa-checkout-request",
      { x: 200, y: 275, objectId: shopper.id, normalizedAnchor: { x: 1, y: 0.5 } },
      { x: 420, y: 275, objectId: checkout.id, normalizedAnchor: { x: 0, y: 0.5 } },
      { label: "checkout request" },
    );
    crossing.zIndex = 0;

    const report = analyzeDiagramVisualQuality(
      room([boundary, shopper, checkout, crossing]),
      "quality-diagram",
    );
    const boundaryConnectorFindings = report.findings.filter(
      (finding) => finding.objectIds.includes(boundary.id) && finding.connectorIds.includes(crossing.id),
    );

    expect(boundaryConnectorFindings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CONNECTOR_OBJECT_INTRUSION" }),
      expect.objectContaining({ code: "CONNECTOR_LABEL_OBJECT_COLLISION" }),
    ]));
  });

  it("reports a connector label that obscures its semantic container label", () => {
    const boundary = node("commerce-boundary", 300, 80, {
      width: 820,
      height: 440,
      label: "Commerce trust boundary",
      semanticRole: "architecture.trust_boundary",
      zIndex: 0,
    });
    const checkout = node("checkout", 420, 265, { width: 180, zIndex: 2 });
    const fulfillment = node("fulfillment", 850, 265, { width: 180, zIndex: 2 });
    const orderCreated = edge(
      "order-created",
      { x: 600, y: 300, objectId: checkout.id, normalizedAnchor: { x: 1, y: 0.5 } },
      { x: 850, y: 300, objectId: fulfillment.id, normalizedAnchor: { x: 0, y: 0.5 } },
      { label: "order-created" },
    );
    orderCreated.zIndex = 3;

    const report = analyzeDiagramVisualQuality(
      room([boundary, checkout, fulfillment, orderCreated]),
      "quality-diagram",
    );

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "CONNECTOR_LABEL_OBJECT_COLLISION",
        objectIds: [boundary.id],
        connectorIds: [orderCreated.id],
        details: { collisionTarget: "semantic_container_label" },
      }),
    ]));
  });

  it("reports a connector path that crosses its semantic container label", () => {
    const boundary = node("commerce-boundary", 300, 80, {
      width: 820,
      height: 440,
      label: "Commerce trust boundary",
      semanticRole: "architecture.trust_boundary",
      zIndex: 0,
    });
    const upper = node("upper-service", 650, 140, { width: 120, zIndex: 2 });
    const lower = node("lower-service", 650, 390, { width: 120, zIndex: 2 });
    const vertical = edge(
      "vertical-event",
      { x: 710, y: 210, objectId: upper.id, normalizedAnchor: { x: 0.5, y: 1 } },
      { x: 710, y: 390, objectId: lower.id, normalizedAnchor: { x: 0.5, y: 0 } },
    );
    vertical.zIndex = 3;

    const report = analyzeDiagramVisualQuality(
      room([boundary, upper, lower, vertical]),
      "quality-diagram",
    );

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "CONNECTOR_OBJECT_INTRUSION",
        objectIds: [boundary.id],
        connectorIds: [vertical.id],
        details: { collisionTarget: "semantic_container_label" },
      }),
    ]));
  });

  it("still reports a foreground container or partial boundary collision", () => {
    const boundary = node("foreground-boundary", 100, 100, {
      width: 280,
      height: 180,
      semanticRole: "architecture.trust_boundary",
      zIndex: 3,
    });
    const partiallyCovered = node("partially-covered", 330, 150, { zIndex: 1 });
    const crossing = edge(
      "crossing",
      { x: 0, y: 190 },
      { x: 500, y: 190 },
      { label: "crossing" },
    );
    crossing.zIndex = 2;

    const report = analyzeDiagramVisualQuality(
      room([boundary, partiallyCovered, crossing]),
      "quality-diagram",
    );

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "MEMBER_OBJECT_OVERLAP",
        objectIds: [boundary.id, partiallyCovered.id].sort(),
      }),
      expect.objectContaining({
        code: "CONNECTOR_OBJECT_INTRUSION",
        objectIds: [boundary.id],
      }),
    ]));
  });

  it("uses oriented member geometry instead of rotated axis-aligned envelopes", () => {
    const rotatedA = node("rotated-a", 0, 0, {
      width: 200,
      height: 20,
      rotation: Math.PI / 4,
    });
    const rotatedB = node("rotated-b", 0, 80, {
      width: 200,
      height: 20,
      rotation: Math.PI / 4,
    });
    const report = analyzeDiagramVisualQuality(room([rotatedA, rotatedB]), "quality-diagram");

    expect(report.status).toBe("pass");
    expect(codes(report)).not.toContain("MEMBER_OBJECT_OVERLAP");
    expect(report.metrics.minimumMemberSpacing).toBeGreaterThan(
      DIAGRAM_VISUAL_QUALITY_THRESHOLDS.minimumMemberSpacing,
    );
  });

  it("does not report blocking overlap for visually disjoint diamonds with overlapping bounds", () => {
    const first: ShapeObject = {
      ...node("diamond-a", 0, 0, { width: 100, height: 100, rotation: Math.PI / 6 }),
      shape: "diamond",
    };
    const second: ShapeObject = {
      ...node("diamond-b", 80, 80, { width: 100, height: 100, rotation: Math.PI / 6 }),
      shape: "diamond",
    };
    const report = analyzeDiagramVisualQuality(room([first, second]), "quality-diagram");

    expect(report.findings).not.toContainEqual(expect.objectContaining({
      code: "MEMBER_OBJECT_OVERLAP",
      objectIds: ["diamond-a", "diamond-b"],
    }));
    expect(report.metrics.failCount).toBe(0);
  });

  it("uses ellipse outlines instead of treating their corner whitespace as filled", () => {
    const first: ShapeObject = {
      ...node("ellipse-a", 0, 0, { width: 140, height: 60, rotation: Math.PI / 4 }),
      shape: "ellipse",
    };
    const second: ShapeObject = {
      ...node("ellipse-b", 50, -50, { width: 140, height: 60, rotation: Math.PI / 4 }),
      shape: "ellipse",
    };
    const report = analyzeDiagramVisualQuality(room([first, second]), "quality-diagram");

    expect(report.findings).not.toContainEqual(expect.objectContaining({
      code: "MEMBER_OBJECT_OVERLAP",
      objectIds: ["ellipse-a", "ellipse-b"],
    }));
    expect(report.metrics.failCount).toBe(0);
  });

  it("does not model an open freehand stroke as a filled bounding rectangle", () => {
    const drawing: DrawObject = {
      ...base("open-stroke"),
      kind: "draw",
      x: 0,
      y: 0,
      width: 300,
      height: 300,
      points: [{ x: 0, y: 0 }, { x: 300, y: 0 }],
      color: "black",
      size: "m",
    };
    const shape = node("inside-empty-bounds", 100, 100);
    const crossingEmptyBounds = edge(
      "inside-empty-bounds-edge",
      { x: 150, y: 100 },
      { x: 150, y: 250 },
    );
    const report = analyzeDiagramVisualQuality(
      room([drawing, shape, crossingEmptyBounds]),
      "quality-diagram",
    );

    expect(report.findings).not.toContainEqual(expect.objectContaining({
      code: "MEMBER_OBJECT_OVERLAP",
      objectIds: ["inside-empty-bounds", "open-stroke"],
    }));
    expect(report.findings).not.toContainEqual(expect.objectContaining({
      code: "CONNECTOR_OBJECT_INTRUSION",
      objectIds: ["open-stroke"],
    }));
    expect(report).toMatchObject({
      geometryCoverage: {
        status: "partial",
        analyzedMemberObjectCount: 1,
        unsupportedDrawObjectCount: 1,
        unsupportedDrawObjectIds: ["open-stroke"],
        omittedUnsupportedDrawObjectIdCount: 0,
        unsupportedDrawObjectIdsTruncated: false,
      },
      metrics: { unsupportedDrawMemberCount: 1 },
    });
    expect(report.summary).toMatch(/coverage is partial/i);
    expect(report.summary).toMatch(/status applies only to supported geometry/i);
  });

  it("bounds unsupported draw identities while keeping exact partial-coverage metrics", () => {
    const drawings: DrawObject[] = Array.from({ length: 120 }, (_, index) => ({
      ...base(`stroke-${index.toString().padStart(3, "0")}`),
      kind: "draw",
      x: index * 20,
      y: 0,
      width: 10,
      height: 10,
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: "black",
      size: "m",
    }));
    const report = analyzeDiagramVisualQuality(room(drawings), "quality-diagram");

    expect(report.status).toBe("pass");
    expect(report.geometryCoverage).toMatchObject({
      status: "partial",
      analyzedMemberObjectCount: 0,
      unsupportedDrawObjectCount: drawings.length,
      omittedUnsupportedDrawObjectIdCount:
        drawings.length - DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedUnsupportedDrawObjectIds,
      unsupportedDrawObjectIdsTruncated: true,
    });
    expect(report.geometryCoverage.unsupportedDrawObjectIds).toHaveLength(
      DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedUnsupportedDrawObjectIds,
    );
    expect(report.geometryCoverage.unsupportedDrawObjectIds[0]).toBe("stroke-000");
    expect(report.metrics.unsupportedDrawMemberCount).toBe(drawings.length);
    expect(report.summary).not.toMatch(/visual quality passed/i);
  });

  it("bounds unsupported path identities while keeping exact partial-coverage metrics", () => {
    const paths: PathObject[] = Array.from({ length: 120 }, (_, index) => ({
      ...base(`path-${index.toString().padStart(3, "0")}`),
      kind: "path",
      x: index * 20,
      y: 0,
      width: 10,
      height: 10,
      start: { x: 0, y: 0 },
      segments: [{ kind: "line", to: { x: 1, y: 1 } }],
      closed: false,
      fill: "none",
      stroke: "black",
      strokeWidth: 2,
      opacity: 1,
      lineCap: "round",
      lineJoin: "round",
      fillRule: "nonzero",
    }));
    const report = analyzeDiagramVisualQuality(room(paths), "quality-diagram");

    expect(report.geometryCoverage).toMatchObject({
      status: "partial",
      analyzedMemberObjectCount: 0,
      unsupportedPathObjectCount: paths.length,
      omittedUnsupportedPathObjectIdCount:
        paths.length - DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedUnsupportedDrawObjectIds,
      unsupportedPathObjectIdsTruncated: true,
    });
    expect(report.geometryCoverage.unsupportedPathObjectIds).toHaveLength(
      DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedUnsupportedDrawObjectIds,
    );
    expect(report.geometryCoverage.unsupportedPathObjectIds[0]).toBe("path-000");
    expect(report.metrics.unsupportedPathMemberCount).toBe(paths.length);
  });

  it("tests connector intrusion against a rotated member interior, not its AABB", () => {
    const rotated = node("rotated-member", 0, 0, {
      width: 200,
      height: 20,
      rotation: Math.PI / 4,
    });
    const envelopeOnly = edge("envelope-only", { x: 30, y: 10 }, { x: 30, y: 70 });
    const throughInterior = edge("through-interior", { x: 60, y: -30 }, { x: 140, y: 50 });

    const envelopeReport = analyzeDiagramVisualQuality(room([rotated, envelopeOnly]), "quality-diagram");
    const interiorReport = analyzeDiagramVisualQuality(room([rotated, throughInterior]), "quality-diagram");

    expect(envelopeReport.findings).not.toContainEqual(expect.objectContaining({
      code: "CONNECTOR_OBJECT_INTRUSION",
      connectorIds: ["envelope-only"],
    }));
    expect(interiorReport.findings).toContainEqual(expect.objectContaining({
      code: "CONNECTOR_OBJECT_INTRUSION",
      objectIds: ["rotated-member"],
      connectorIds: ["through-interior"],
    }));
  });

  it("reports a connector T-junction when one endpoint lands on another route interior", () => {
    const member = node("member", 500, 500);
    const horizontal = edge("horizontal", { x: 0, y: 100 }, { x: 300, y: 100 });
    const terminating = edge("terminating", { x: 150, y: 0 }, { x: 150, y: 100 });
    const report = analyzeDiagramVisualQuality(room([member, horizontal, terminating]), "quality-diagram");

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "CONNECTOR_CROSSING",
      connectorIds: ["horizontal", "terminating"],
      details: { point: [150, 100] },
    }));
  });

  it("does not report a crossing for two connectors with a legitimate shared terminal", () => {
    const member = node("member", 500, 500);
    const left = edge("left", { x: 0, y: 100 }, { x: 150, y: 100 });
    const down = edge("down", { x: 150, y: 100 }, { x: 150, y: 250 });
    const report = analyzeDiagramVisualQuality(room([member, left, down]), "quality-diagram");

    expect(report.findings).not.toContainEqual(expect.objectContaining({
      code: "CONNECTOR_CROSSING",
      connectorIds: ["down", "left"],
    }));
  });

  it("reports a long shared lane after distinct routes converge at a common bound target", () => {
    const target = node("shared-target", 500, 0);
    const upper = edge(
      "converging-upper",
      { x: 0, y: 0 },
      {
        x: 500,
        y: 35,
        objectId: target.id,
        normalizedAnchor: { x: 0, y: 0.5 },
      },
      { routing: "elbow" },
    );
    const lower = edge(
      "converging-lower",
      { x: 0, y: 100 },
      {
        x: 500,
        y: 35,
        objectId: target.id,
        normalizedAnchor: { x: 0, y: 0.5 },
      },
      { routing: "elbow" },
    );
    const report = analyzeDiagramVisualQuality(
      room([target, upper, lower]),
      "quality-diagram",
    );

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "CONNECTOR_SHARED_SEGMENT",
      connectorIds: ["converging-lower", "converging-upper"],
      details: { sharedLength: expect.any(Number) },
    }));
    const shared = report.findings.find((finding) =>
      finding.code === "CONNECTOR_SHARED_SEGMENT");
    expect(shared?.details?.sharedLength).toBeGreaterThanOrEqual(
      DIAGRAM_VISUAL_QUALITY_THRESHOLDS.connectorSharedSegmentMinimumLength,
    );
  });

  it("bounds retained findings and serialized output while preserving exact aggregate counts", () => {
    const overlapping = Array.from({ length: 80 }, (_, index) => node(
      `overlap-${index.toString().padStart(3, "0")}`,
      0,
      0,
      { label: "x" },
    ));
    const report = analyzeDiagramVisualQuality(room(overlapping), "quality-diagram");
    const expectedPairCount = overlapping.length * (overlapping.length - 1) / 2;

    expect(report.metrics.findingCount).toBe(expectedPairCount);
    expect(report.metrics.failCount).toBe(expectedPairCount);
    expect(report.metrics.findingsByCode.MEMBER_OBJECT_OVERLAP).toBe(expectedPairCount);
    expect(report.findings).toHaveLength(DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedFindingsPerCode);
    expect(report.metrics).toMatchObject({
      returnedFindingCount: DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedFindingsPerCode,
      omittedFindingCount: expectedPairCount - DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedFindingsPerCode,
      findingsTruncated: true,
    });
    expect(report.summary).toContain(`${report.metrics.omittedFindingCount} additional findings`);
    expect(JSON.stringify(report).length).toBeLessThan(25_000);
    expect(analyzeDiagramVisualQuality(room([...overlapping].reverse()), "quality-diagram")).toEqual(report);
  });

  it("caps references within a retained congestion finding without hiding the aggregate", () => {
    const hub = node("reference-hub", 0, 0);
    const connectors = Array.from({ length: 80 }, (_, index) => edge(
      `reference-edge-${index.toString().padStart(3, "0")}`,
      {
        x: hub.x + hub.width,
        y: hub.y + hub.height / 2,
        objectId: hub.id,
        normalizedAnchor: { x: 1, y: 0.5 },
      },
      { x: 500, y: index * 12 },
    ));
    const report = analyzeDiagramVisualQuality(room([hub, ...connectors]), "quality-diagram");
    const congestion = report.findings.find((finding) => finding.code === "ATTACHMENT_PORT_CONGESTION");

    expect(congestion).toMatchObject({
      objectIds: ["reference-hub"],
      details: {
        connectorCount: 80,
        connectorReferenceCount: 80,
        omittedConnectorReferenceCount: 80 - DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedConnectorIdsPerFinding,
      },
    });
    expect(congestion?.connectorIds).toHaveLength(DIAGRAM_VISUAL_QUALITY_LIMITS.maxReturnedConnectorIdsPerFinding);
    expect(JSON.stringify(report).length).toBeLessThan(100_000);
  });

  it("is stable across room map and Diagram membership insertion order", () => {
    const objects = denseTwelveNodeFixture();
    const forwardDiagram = diagram(objects);
    const reversedObjects = [...objects].reverse();
    const reversedDiagram: Diagram = {
      ...forwardDiagram,
      memberObjectIds: [...forwardDiagram.memberObjectIds].reverse(),
      connectorIds: [...forwardDiagram.connectorIds].reverse(),
    };

    const forward = analyzeDiagramVisualQuality(room(objects, forwardDiagram), "quality-diagram");
    const reversed = analyzeDiagramVisualQuality(room(reversedObjects, reversedDiagram), "quality-diagram");

    expect(reversed).toEqual(forward);
  });

  it("documents stable threshold values and rejects an unknown Diagram identity", () => {
    expect(DIAGRAM_VISUAL_QUALITY_THRESHOLDS).toMatchObject({
      minimumMemberSpacing: 32,
      attachmentPortMinimumConnectors: 3,
      connectorSharedSegmentMinimumLength: 16,
      sharedInitialCorridorMinimumLength: 24,
    });
    expect(() => analyzeDiagramVisualQuality(room([]), "missing")).toThrow("Diagram not found: missing");
  });

  it("does not certify an empty Diagram as visually complete", () => {
    const report = analyzeDiagramVisualQuality(room([]), "quality-diagram");

    expect(report).toMatchObject({
      status: "fail",
      metrics: { memberObjectCount: 0, failCount: 1 },
      findings: [{ code: "DIAGRAM_EMPTY", status: "fail" }],
    });
  });
});
