// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { ActorRef, CanvasObject } from "@/lib/domain/types";

import { buildSemanticScene, type SemanticScene } from "./semantic-scene";
import {
  SemanticPngRenderError,
  renderSemanticSceneSvg,
} from "./semantic-png-svg";

const actor: ActorRef = {
  participantId: "participant-1",
  displayName: "Ada",
  color: "#5965e8",
  kind: "human",
};

function base(id: string, zIndex: number, x: number, y: number, width: number, height: number) {
  return {
    id,
    x,
    y,
    width,
    height,
    rotation: 0,
    zIndex,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function scene(): SemanticScene {
  const objects: CanvasObject[] = [
    {
      ...base("outside", 0, -500, -500, 100, 30),
      kind: "text",
      content: "OUTSIDE_SECRET",
      color: "black",
      size: "s",
      align: "start",
    },
    {
      ...base("text", 1, 10, 100, 180, 320),
      kind: "text",
      content: 'Hello </text><script>alert("x")</script> & friends',
      color: "black",
      size: "m",
      align: "start",
    },
    {
      ...base("rectangle", 2, 0, 0, 120, 70),
      kind: "shape",
      rotation: Math.PI / 8,
      shape: "rectangle",
      nodeType: null,
      label: "Rectangle <safe>",
      fill: "light-violet",
      stroke: "blue",
    },
    {
      ...base("ellipse", 3, 160, 0, 100, 70),
      kind: "shape",
      shape: "ellipse",
      nodeType: null,
      label: "Ellipse",
      fill: "white",
      stroke: "green",
    },
    {
      ...base("diamond", 4, 300, 0, 100, 70),
      kind: "shape",
      shape: "diamond",
      nodeType: null,
      label: "Diamond",
      fill: "yellow",
      stroke: "orange",
    },
    {
      ...base("connector", 5, 120, 15, 180, 40),
      kind: "connector",
      start: { x: 120, y: 35, objectId: null },
      end: { x: 300, y: 35, objectId: null },
      routing: {
        mode: "straight",
        kind: "straight",
        bend: 0,
        elbowMidPoint: 0.5,
        labelPosition: 0.5,
      },
      direction: "both",
      label: "safe route",
      color: "violet",
    },
    {
      ...base("draw", 6, 250, 110, 50, 30),
      kind: "draw",
      rotation: Math.PI / 4,
      points: [{ x: 0, y: 0 }, { x: 25, y: 20 }, { x: 50, y: 0 }],
      color: "red",
      size: "m",
    },
    {
      ...base("image", 7, 400, 100, 80, 60),
      kind: "image",
      url: "https://private.example/secret.png?token=do-not-leak",
      assetId: "private",
      alt: "Private <screen>",
      mimeType: "image/png",
      sourceUrl: null,
      locked: false,
    },
    {
      ...base("path", 8, 500, 100, 100, 80),
      kind: "path",
      rotation: Math.PI / 6,
      start: { x: 0, y: 0.5 },
      segments: [{
        kind: "cubic",
        control1: { x: 0.25, y: 0 },
        control2: { x: 0.75, y: 1 },
        to: { x: 1, y: 0.5 },
      }],
      closed: true,
      fill: "light-blue",
      stroke: "#123456",
      strokeWidth: 6,
      opacity: 0.5,
      lineCap: "square",
      lineJoin: "bevel",
      fillRule: "evenodd",
    },
  ];
  return buildSemanticScene({
    id: "room-1",
    roomRevision: 9,
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
  });
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected rendering to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(SemanticPngRenderError);
    expect((error as SemanticPngRenderError).code).toBe(code);
  }
}

function objectMarkup(
  svg: string,
  objectId: string,
  layer: "object" | "connector-shaft" | "connector-overlay" = "object",
): string {
  const identity = layer === "connector-overlay"
    ? `data-semantic-connector-overlay-id="${objectId}"`
    : `data-semantic-object-id="${objectId}"`;
  const marker = `<g ${identity} data-semantic-layer="${layer}">`;
  const start = svg.indexOf(marker);
  if (start < 0) return "";
  const boundaries = [
    svg.indexOf('<g data-semantic-object-id="', start + marker.length),
    svg.indexOf('<g data-semantic-connector-overlay-id="', start + marker.length),
  ].filter((index) => index >= 0);
  const end = boundaries.length ? Math.min(...boundaries) : svg.lastIndexOf("</svg>");
  return svg.slice(start, end);
}

function withoutMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

describe("semantic PNG SVG generation", () => {
  it("renders only the exact ID scope in deterministic paint order with escaped text", () => {
    const current = scene();
    const result = renderSemanticSceneSvg(
      current,
      ["path", "image", "connector", "draw", "diamond", "ellipse", "rectangle", "text"],
      {
        padding: 12,
        images: {
          image: { kind: "embedded", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
        },
      },
    );

    expect(result.objectIds).toEqual([
      "text",
      "rectangle",
      "ellipse",
      "diamond",
      "connector",
      "draw",
      "image",
      "path",
    ]);
    const connectorIndex = result.svg.indexOf(
      'data-semantic-object-id="connector" data-semantic-layer="object"',
    );
    const basePaintOrder = result.objectIds.map((id) => result.svg.indexOf(
      `data-semantic-object-id="${id}" data-semantic-layer="object"`,
    ));
    expect(connectorIndex).toBeGreaterThanOrEqual(0);
    expect(basePaintOrder).toEqual([...basePaintOrder].sort((left, right) => left - right));
    expect(connectorIndex).toBeGreaterThan(basePaintOrder[result.objectIds.indexOf("diamond")]!);
    expect(connectorIndex).toBeLessThan(basePaintOrder[result.objectIds.indexOf("draw")]!);
    expect(result.svg).not.toContain("OUTSIDE_SECRET");
    expect(result.svg).not.toContain("<script");
    expect(withoutMarkup(objectMarkup(result.svg, "text"))).toContain(
      'Hello&lt;/text&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp;friends',
    );
    expect(withoutMarkup(objectMarkup(result.svg, "rectangle"))).toMatch(/^Rectang/);
    expect(result.svg).not.toContain("<safe>");
    expect(result.svg).toContain("<ellipse");
    expect(result.svg).toContain("<polygon");
    expect(result.svg).toContain("<path d=\"M 120 35 L 300 35\"");
    expect(result.svg).toContain("<polyline");
    expect(result.svg).toContain("rotate(22.5 60 35)");
    expect(result.svg).toContain('href="data:image/png;base64,iVBORw0KGgo="');
    expect(result.svg).not.toContain("private.example");
    expect(result.svg).not.toContain("do-not-leak");
    expect(result.svg).not.toMatch(/<(?:script|style|foreignObject|use)\b/i);
    expect(result.svg).not.toMatch(/href="(?:https?:|\/)/i);
    expect(result.warnings).toEqual([]);

    const rectangle = objectMarkup(result.svg, "rectangle");
    expect(rectangle).toContain(
      'rx="7" fill="#f2e5f7" stroke="#5266df" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"',
    );
    expect(rectangle).toContain(
      'font-family="Shantell Sans,Comic Sans MS,Comic Sans,cursive" font-size="22" font-weight="400"',
    );
    expect(rectangle).toContain(
      'stroke="#f2e5f7" stroke-width="5" stroke-linejoin="round" paint-order="stroke fill"',
    );
    const connector = objectMarkup(result.svg, "connector");
    expect(connector).toContain(
      'stroke="#9050c8" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"',
    );
    expect(connector).toContain("<polygon");
    expect(connector).toContain('rx="4" fill="#ffffff" stroke="none"');
    expect(objectMarkup(result.svg, "draw")).toContain(
      'stroke="#d9484a" stroke-width="4.5"',
    );
    expect(objectMarkup(result.svg, "path")).toContain(
      '<path d="M 500 140 C 525 100 575 180 600 140 Z" transform="rotate(30 550 140)" fill="#deedf8" stroke="#123456" stroke-width="6" opacity="0.5" stroke-linecap="square" stroke-linejoin="bevel" fill-rule="evenodd"/>',
    );
  });

  it("matches the live renderer's six-line text and twenty-line connector-label limits", () => {
    const longText: CanvasObject = {
      ...base("png-long-text", 0, 0, 0, 160, 320),
      kind: "text",
      content: Array.from({ length: 7 }, (_, index) => `line${index + 1}`).join("\n"),
      color: "black",
      size: "m",
      align: "start",
    };
    const longConnector: CanvasObject = {
      ...base("png-long-connector", 1, 0, 250, 400, 1),
      kind: "connector",
      start: { x: 0, y: 250, objectId: null },
      end: { x: 400, y: 250, objectId: null },
      routing: { mode: "straight", kind: "straight", bend: 0, elbowMidPoint: 0.5, labelPosition: 0.5 },
      direction: "end",
      label: Array.from({ length: 21 }, (_, index) =>
        String.fromCharCode(97 + index)).join("\n"),
      color: "black",
    };
    const current = buildSemanticScene({
      id: "room-text-limits",
      roomRevision: 1,
      objects: {
        [longText.id]: longText,
        [longConnector.id]: longConnector,
      },
      diagrams: {},
    });
    const result = renderSemanticSceneSvg(
      current,
      [longText.id, longConnector.id],
      { padding: 0 },
    );
    const textMarkup = objectMarkup(result.svg, longText.id);
    const connectorLabelMarkup = objectMarkup(result.svg, longConnector.id);

    expect(textMarkup.match(/<tspan\b/g)).toHaveLength(6);
    expect(withoutMarkup(textMarkup)).toContain("line6...");
    expect(connectorLabelMarkup.match(/<tspan\b/g)).toHaveLength(20);
    expect(withoutMarkup(connectorLabelMarkup)).toContain("t...");
  });

  it("ellipsizes PNG text at the height-aware baseline limit", () => {
    const shortText: CanvasObject = {
      ...base("png-short-text", 0, 0, 0, 160, 96),
      kind: "text",
      content: "one\ntwo\nthree\nfour",
      color: "black",
      size: "m",
      align: "start",
    };
    const current = buildSemanticScene({
      id: "room-short-text",
      roomRevision: 1,
      objects: { [shortText.id]: shortText },
      diagrams: {},
    });
    const result = renderSemanticSceneSvg(current, [shortText.id], { padding: 0 });
    const textMarkup = objectMarkup(result.svg, shortText.id);

    expect(textMarkup.match(/<tspan\b/g)).toHaveLength(3);
    expect(withoutMarkup(textMarkup)).toContain("three...");
    expect(withoutMarkup(textMarkup)).not.toContain("four");
  });

  it("embeds only a bounded font data URL in the ephemeral SVG", () => {
    const fontDataUrl = `data:font/woff2;base64,${Buffer.from([0x77, 0x4f, 0x46, 0x32]).toString("base64")}`;
    const result = renderSemanticSceneSvg(scene(), ["text"], {
      padding: 0,
      fontDataUrl,
    });

    expect(result.svg).toContain(
      `<style>@font-face{font-family:'Shantell Sans';font-style:normal;font-weight:400;src:url('${fontDataUrl}') format('woff2')}</style>`,
    );
    expect(result.svg).not.toMatch(/src:url\(['"]https?:/i);
    expectCode(
      () => renderSemanticSceneSvg(scene(), ["text"], {
        fontDataUrl: "data:text/html;base64,PHNjcmlwdD4=",
      }),
      "RENDER_OPTIONS_INVALID",
    );
  });

  it("derives exact scoped bounds and applies padding, scale, and pixel ratio", () => {
    const result = renderSemanticSceneSvg(scene(), ["image"], {
      padding: 10,
      scale: 0.5,
      pixelRatio: 2,
    });

    expect(result.bounds).toEqual({ x: 390, y: 90, width: 100, height: 80 });
    expect(result.logicalWidth).toBe(50);
    expect(result.logicalHeight).toBe(40);
    expect(result.pixelWidth).toBe(100);
    expect(result.pixelHeight).toBe(80);
    expect(result.svg).toContain('width="100" height="80" viewBox="390 90 100 80"');
    expect(result.warnings).toMatchObject([
      { code: "IMAGE_NOT_PROVIDED", objectId: "image" },
    ]);
  });

  it("turns unsafe or mislabeled image data into a warning and placeholder", () => {
    const maliciousSvg = Buffer.from('<svg><image href="https://attacker.test/pixel"/></svg>').toString("base64");
    const result = renderSemanticSceneSvg(scene(), ["image"], {
      padding: 0,
      images: {
        image: { kind: "embedded", dataUrl: `data:image/png;base64,${maliciousSvg}` },
      },
    });

    expect(result.warnings).toMatchObject([
      { code: "IMAGE_EMBED_REJECTED", objectId: "image" },
    ]);
    expect(result.svg).not.toContain("attacker.test");
    expect(result.svg).not.toContain("<image");
    expect(result.svg).toContain('stroke-dasharray="8 6"');
    expect(result.svg).toContain("Private</tspan>");
    expect(result.svg).toContain("&lt;screen&gt;</tspan>");
  });

  it("rejects empty, duplicate, missing, and oversized exact scopes", () => {
    const current = scene();
    expectCode(() => renderSemanticSceneSvg(current, []), "SCOPE_EMPTY");
    expectCode(
      () => renderSemanticSceneSvg(current, ["text", "text"]),
      "SCOPE_DUPLICATE_OBJECT_ID",
    );
    expectCode(
      () => renderSemanticSceneSvg(current, ["missing"]),
      "SCOPE_OBJECT_NOT_FOUND",
    );
    expectCode(
      () => renderSemanticSceneSvg(current, ["toString"]),
      "SCOPE_OBJECT_NOT_FOUND",
    );
    expectCode(
      () => renderSemanticSceneSvg(current, Array.from({ length: 1_001 }, (_, index) => `id-${index}`)),
      "SCOPE_TOO_LARGE",
    );
  });

  it("fails deterministically before emitting approximate connector geometry", () => {
    const current = scene();
    const missingRoute = { ...current, connectorRoutes: {} };
    expectCode(
      () => renderSemanticSceneSvg(missingRoute, ["connector"]),
      "CONNECTOR_ROUTE_UNAVAILABLE",
    );
  });

  it("enforces dimension and in-memory SVG byte budgets", () => {
    const current = scene();
    expectCode(
      () => renderSemanticSceneSvg(current, ["image"], { pixelRatio: 2, maxWidth: 100 }),
      "DIMENSION_BUDGET_EXCEEDED",
    );
    expectCode(
      () => renderSemanticSceneSvg(current, ["text"], { maxSvgBytes: 64 }),
      "SVG_BYTE_BUDGET_EXCEEDED",
    );
  });
});
