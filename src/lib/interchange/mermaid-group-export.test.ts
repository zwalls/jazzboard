// @vitest-environment node

import { describe, expect, it } from "vitest";

import { parseMermaidFlowchart } from "./mermaid-import";
import { renderDiagramMermaid } from "./mermaid";
import {
  JAZZBOARD_ARTIFACT_FORMAT,
  JAZZBOARD_ARTIFACT_SCHEMA_URL,
  JAZZBOARD_ARTIFACT_VERSION,
  type JazzboardTemplateV1,
  type TemplateCanvasObject,
} from "./types";

const base = {
  x: 0,
  y: 0,
  width: 160,
  height: 80,
  rotation: 0,
  zIndex: 1,
  groupId: null,
} as const;

function shape(
  id: string,
  label: string,
  options: Partial<Extract<TemplateCanvasObject, { kind: "shape" }>> = {},
): Extract<TemplateCanvasObject, { kind: "shape" }> {
  return {
    ...base,
    id,
    kind: "shape",
    shape: "rectangle",
    nodeType: "component",
    nodeMetadata: null,
    label,
    fill: "blue",
    stroke: "black",
    ...options,
  };
}

function template(
  objects: TemplateCanvasObject[],
  memberObjectIds: string[],
  connectorIds: string[],
): JazzboardTemplateV1 {
  return {
    $schema: JAZZBOARD_ARTIFACT_SCHEMA_URL,
    format: JAZZBOARD_ARTIFACT_FORMAT,
    version: JAZZBOARD_ARTIFACT_VERSION,
    kind: "template",
    title: "Mermaid export fixture",
    description: "",
    source: null,
    bounds: { x: 0, y: 0, width: 600, height: 400 },
    objects,
    diagrams: [{
      id: "diagram",
      title: "Diagram",
      description: "",
      diagramType: "architecture",
      category: null,
      tags: [],
      memberObjectIds,
      connectorIds,
    }],
    warnings: [],
  };
}

function groupObjects(titleContent: string): TemplateCanvasObject[] {
  return [
    shape("container", "", {
      semanticRole: "diagram.group_container",
      groupId: "group-native",
      width: 520,
      height: 300,
      zIndex: 0,
    }),
    {
      ...base,
      id: "title",
      kind: "text",
      semanticRole: "diagram.group_title",
      content: titleContent,
      color: "black",
      size: "l",
      align: "start",
      groupId: "group-native",
    },
    shape("node-a", "Client", { groupId: "group-native" }),
    shape("node-b", "API", { groupId: "group-native" }),
  ];
}

describe("Mermaid native group export", () => {
  it("round-trips native group decoration as one flat subgraph without fake nodes", async () => {
    const maliciousTitle = 'Boundary "]\n%%{x}%%\n<script>';
    const objects = groupObjects(maliciousTitle);
    objects.push({
      ...base,
      id: "edge",
      kind: "connector",
      semanticRole: "diagram.dotted_relationship",
      start: { x: 160, y: 40, objectId: "node-a" },
      end: { x: 320, y: 40, objectId: "node-b" },
      direction: "end",
      label: "request",
      color: "black",
      groupId: null,
    });

    const rendered = renderDiagramMermaid(template(
      objects,
      ["container", "title", "node-a", "node-b"],
      ["edge"],
    ));
    const reparsed = await parseMermaidFlowchart(rendered.source);

    expect(rendered.source).toContain('subgraph g0["Boundary &quot;&#93; &#37;&#37;&#123;x&#125;&#37;&#37; &lt;script&gt;"]');
    expect(rendered.source).not.toContain("%%{");
    expect(rendered.source).not.toContain("<script");
    expect(reparsed.nodes).toHaveLength(2);
    expect(reparsed.edges).toHaveLength(1);
    expect(reparsed.groups).toEqual([expect.objectContaining({ id: "g0", nodeIds: ["n0", "n1"] })]);
    expect(reparsed.edges[0]).toMatchObject({ start: "n0", end: "n1", dotted: true });
    expect(rendered.warnings).toEqual([]);
  });

  it("warns and omits a connector attached to group decoration", async () => {
    const objects = groupObjects("Platform");
    objects.push({
      ...base,
      id: "edge-to-container",
      kind: "connector",
      start: { x: 0, y: 40, objectId: "container" },
      end: { x: 160, y: 40, objectId: "node-a" },
      direction: "end",
      label: "invalid attachment",
      color: "black",
      groupId: null,
    });

    const rendered = renderDiagramMermaid(template(
      objects,
      ["container", "title", "node-a", "node-b"],
      ["edge-to-container"],
    ));
    const reparsed = await parseMermaidFlowchart(rendered.source);

    expect(reparsed.nodes).toHaveLength(2);
    expect(reparsed.edges).toHaveLength(0);
    expect(rendered.warnings).toContainEqual(expect.objectContaining({
      code: "MERMAID_CONNECTOR_OMITTED",
      objectId: "edge-to-container",
      message: expect.stringContaining("targets group decoration container"),
    }));
  });

  it("keeps the existing flat output for ordinary grouped objects", () => {
    const objects: TemplateCanvasObject[] = [
      shape("a", "Alpha", { groupId: "ordinary-group" }),
      shape("b", "Beta", { groupId: "ordinary-group" }),
      {
        ...base,
        id: "edge",
        kind: "connector",
        start: { x: 160, y: 40, objectId: "a" },
        end: { x: 320, y: 40, objectId: "b" },
        direction: "end",
        label: "calls",
        color: "black",
        groupId: null,
      },
    ];

    expect(renderDiagramMermaid(template(objects, ["b", "a"], ["edge"])).source).toBe(
      'flowchart LR\n  n0["Alpha"]\n  n1["Beta"]\n  n0 -->|calls| n1\n',
    );
  });

  it("preserves dotted relationship direction variants", async () => {
    const objects: TemplateCanvasObject[] = [shape("a", "Alpha"), shape("b", "Beta")];
    (["none", "end", "both"] as const).forEach((direction, index) => {
      objects.push({
        ...base,
        id: `edge-${direction}`,
        kind: "connector",
        semanticRole: "diagram.dotted_relationship",
        start: { x: 160, y: 40 + index * 10, objectId: "a" },
        end: { x: 320, y: 40 + index * 10, objectId: "b" },
        direction,
        label: direction,
        color: "black",
        groupId: null,
      });
    });

    const rendered = renderDiagramMermaid(template(
      objects,
      ["a", "b"],
      ["edge-none", "edge-end", "edge-both"],
    ));
    const reparsed = await parseMermaidFlowchart(rendered.source);

    expect(reparsed.edges.map((edge) => [edge.direction, edge.dotted, edge.label])).toEqual([
      ["both", true, "both"],
      ["end", true, "end"],
      ["none", true, "none"],
    ]);
  });
});
