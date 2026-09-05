// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MermaidFlowchartImportError,
  parseMermaidFlowchart,
} from "./mermaid-import";

function quoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "&quot;");
}

describe("Mermaid flowchart import parser", () => {
  it("normalizes native nodes, flat subgraphs, labels, directions, and dotted edges", async () => {
    expect(globalThis).not.toHaveProperty("window");
    const parsed = await parseMermaidFlowchart(`
      flowchart LR
      subgraph edge[Edge Layer]
        client((Client))
        gateway[API Gateway]
      end
      service{Authorized?}
      client request@-->|request| gateway
      gateway event@-. order created .-> service
      service <--> client
    `);

    expect(parsed).toEqual({
      direction: "LR",
      nodes: [
        {
          id: "client",
          label: "Client",
          shape: "ellipse",
          sourceShape: "circle",
          groupId: "edge",
        },
        {
          id: "gateway",
          label: "API Gateway",
          shape: "rectangle",
          sourceShape: "square",
          groupId: "edge",
        },
        {
          id: "service",
          label: "Authorized?",
          shape: "diamond",
          sourceShape: "diamond",
          groupId: null,
        },
      ],
      edges: [
        {
          id: "request",
          start: "client",
          end: "gateway",
          label: "request",
          direction: "end",
          dotted: false,
          isUserDefinedId: true,
        },
        {
          id: "event",
          start: "gateway",
          end: "service",
          label: "order created",
          direction: "end",
          dotted: true,
          isUserDefinedId: true,
        },
        {
          id: "L_service_client_0",
          start: "service",
          end: "client",
          label: "",
          direction: "both",
          dotted: false,
          isUserDefinedId: false,
        },
      ],
      groups: [{ id: "edge", label: "Edge Layer", nodeIds: ["client", "gateway"] }],
      warnings: [],
    });
    expect(globalThis).not.toHaveProperty("window");
  });

  it("parses every node, edge, group, label, and async marker in the fictional architecture fixture", async () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), ".research-private/mermaid-netflix/architecture.json"), "utf8"),
    ) as {
      groups: Record<string, string[]>;
      nodes: Record<string, string>;
      edges: Array<[string, string, string, "sync" | "async"]>;
    };
    const lines = ["flowchart TB"];
    for (const [groupId, nodeIds] of Object.entries(fixture.groups)) {
      lines.push(`subgraph ${groupId}["${quoted(groupId)}"]`);
      for (const nodeId of nodeIds) {
        lines.push(`${nodeId}["${quoted(fixture.nodes[nodeId])}"]`);
      }
      lines.push("end");
    }
    fixture.edges.forEach(([start, end, label, kind], index) => {
      lines.push(
        kind === "async"
          ? `${start} edge${index}@-. ${quoted(label)} .-> ${end}`
          : `${start} edge${index}@-->|${quoted(label)}| ${end}`,
      );
    });

    const parsed = await parseMermaidFlowchart(lines.join("\n"));

    expect(parsed.direction).toBe("TB");
    expect(parsed.nodes).toHaveLength(23);
    expect(parsed.edges).toHaveLength(29);
    expect(parsed.groups).toHaveLength(5);
    expect(Object.fromEntries(parsed.nodes.map((node) => [node.id, node.label])))
      .toEqual(fixture.nodes);
    expect(Object.fromEntries(parsed.groups.map((group) => [group.id, group.nodeIds])))
      .toEqual(fixture.groups);
    expect(parsed.edges.map((edge) => [edge.start, edge.end, edge.label, edge.dotted ? "async" : "sync"]))
      .toEqual(fixture.edges);
  });

  it("uses Mermaid syntax errors and rejects unsupported configuration or diagram features", async () => {
    await expect(parseMermaidFlowchart("flowchart LR\na -->"))
      .rejects.toMatchObject({ code: "MERMAID_PARSE_ERROR" });
    await expect(parseMermaidFlowchart("sequenceDiagram\nAlice->>Bob: hello"))
      .rejects.toMatchObject({ code: "MERMAID_UNSUPPORTED" });
    await expect(parseMermaidFlowchart("%%{init: { 'theme': 'dark' }}%%\nflowchart LR\na-->b"))
      .rejects.toMatchObject({ code: "MERMAID_UNSUPPORTED", details: { feature: "directive" } });
    await expect(parseMermaidFlowchart("flowchart RL\na-->b"))
      .rejects.toMatchObject({ code: "MERMAID_UNSUPPORTED", details: { feature: "direction" } });
    await expect(parseMermaidFlowchart(`
      flowchart TB
      subgraph outer[Outer]
        subgraph inner[Inner]
          a[A]
        end
      end
    `)).rejects.toMatchObject({ code: "MERMAID_UNSUPPORTED" });
    await expect(parseMermaidFlowchart("flowchart LR\na[A]-->b[B]\nstyle a fill:#fff"))
      .rejects.toMatchObject({ code: "MERMAID_UNSUPPORTED" });
  });

  it("enforces caller limits and serializes concurrent parses around Mermaid's shared database", async () => {
    await expect(parseMermaidFlowchart("flowchart LR\na-->b", { maxElements: 1 }))
      .rejects.toMatchObject({ code: "MERMAID_LIMIT_EXCEEDED" });

    const [left, right] = await Promise.all([
      parseMermaidFlowchart("flowchart LR\nleft[Left]-->done[Done]"),
      parseMermaidFlowchart("flowchart TB\ntop[Top]-.->bottom[Bottom]"),
    ]);
    expect(left).toMatchObject({ direction: "LR", nodes: [{ id: "left" }, { id: "done" }] });
    expect(right).toMatchObject({
      direction: "TB",
      nodes: [{ id: "top" }, { id: "bottom" }],
      edges: [{ dotted: true }],
    });
  });

  it("returns a stable typed import error", () => {
    const error = new MermaidFlowchartImportError("MERMAID_UNSUPPORTED", "Unsupported", {
      feature: "test",
    });
    expect(error).toMatchObject({
      name: "MermaidFlowchartImportError",
      code: "MERMAID_UNSUPPORTED",
      details: { feature: "test" },
    });
  });
});
