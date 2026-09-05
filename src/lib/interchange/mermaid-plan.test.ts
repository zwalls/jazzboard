import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createCanvasObjectSchema, semanticTransactionSchema } from "@/lib/domain/schemas";
import type { CreateCanvasObject } from "@/lib/domain/types";
import { planMermaidImport } from "./mermaid-plan";

const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

function streamingArchitectureSource(): string {
  const fixture = JSON.parse(
    readFileSync(resolve(process.cwd(), "src/test/fixtures/streaming-architecture.json"), "utf8"),
  ) as {
    groups: Record<string, string[]>;
    nodes: Record<string, string>;
    edges: Array<[string, string, string, "sync" | "async"]>;
  };
  const lines = ["flowchart TB"];
  for (const [groupId, nodeIds] of Object.entries(fixture.groups)) {
    lines.push(`subgraph ${groupId}[${quoted(groupId)}]`);
    for (const nodeId of nodeIds) lines.push(`${nodeId}[${quoted(fixture.nodes[nodeId])}]`);
    lines.push("end");
  }
  fixture.edges.forEach(([start, end, label, kind], index) => {
    lines.push(kind === "async"
      ? `${start} edge${index}@-. ${quoted(label)} .-> ${end}`
      : `${start} edge${index}@-->|${quoted(label)}| ${end}`);
  });
  return lines.join("\n");
}

describe("Mermaid native planning", () => {
  it("lays out visible nonoverlapping groups while preserving inter-group and intra-group routes", async () => {
    const source = 'flowchart LR\nsubgraph frontend[Frontend]\na[Client]\nend\nsubgraph backend[Backend]\nb[API]\nc[(Store)]\nend\na -->|request| b\nb -.->|write| c';
    // Use a rectangle because database cylinders are outside the initial subset.
    const supported = source.replace('c[(Store)]', 'c[Store]');
    const first = await planMermaidImport(supported, { title: "System", origin: { x: 20, y: 40 }, grouping: "boxed" });
    const second = await planMermaidImport(supported, { grouping: "boxed" });
    expect(first.idMap.nodes.a).not.toBe(second.idMap.nodes.a);
    expect(Object.keys(first.idMap.nodes)).toEqual(["a", "b", "c"]);
    expect(Object.keys(first.idMap.edges)).toHaveLength(2);
    expect(first.transaction.commands).toHaveLength(9);
    expect(() => semanticTransactionSchema.parse(first.transaction)).not.toThrow();
    const objects = first.transaction.commands.flatMap(c => c.type === "create" ? [c.object] : []);
    for (const object of objects) expect(() => createCanvasObjectSchema.parse(object)).not.toThrow();
    const edges = objects.filter(o => o.kind === "connector");
    expect(edges.map(e => [e.start.objectId, e.end.objectId, e.label])).toEqual([
      [first.idMap.nodes.a, first.idMap.nodes.b, "request"], [first.idMap.nodes.b, first.idMap.nodes.c, "write"],
    ]);
    expect(edges.every(e => ["elbow", "straight"].includes(e.routing!.mode) && e.start.isExact)).toBe(true);
    expect(edges.every(edge =>
      edge.routing!.labelPosition > 0 && edge.routing!.labelPosition < 1 &&
      edge.start.normalizedAnchor!.x >= 0 && edge.start.normalizedAnchor!.x <= 1 &&
      edge.start.normalizedAnchor!.y >= 0 && edge.start.normalizedAnchor!.y <= 1 &&
      edge.end.normalizedAnchor!.x >= 0 && edge.end.normalizedAnchor!.x <= 1 &&
      edge.end.normalizedAnchor!.y >= 0 && edge.end.normalizedAnchor!.y <= 1
    )).toBe(true);

    const containers = objects.filter((o): o is Extract<CreateCanvasObject, { kind: "shape" }> =>
      o.kind === "shape" && o.semanticRole === "diagram.group_container");
    const titles = objects.filter((o): o is Extract<CreateCanvasObject, { kind: "text" }> =>
      o.kind === "text" && o.semanticRole === "diagram.group_title");
    expect(containers).toHaveLength(2);
    expect(titles.map(title => title.content)).toEqual(expect.arrayContaining(["Frontend", "Backend"]));
    expect(containers.every(container => container.label === "" && container.fill === "none" && container.zIndex === 0)).toBe(true);
    expect(
      containers[0].x + containers[0].width <= containers[1].x ||
      containers[1].x + containers[1].width <= containers[0].x ||
      containers[0].y + containers[0].height <= containers[1].y ||
      containers[1].y + containers[1].height <= containers[0].y,
    ).toBe(true);
    for (const groupId of Object.values(first.idMap.groups)) {
      const container = containers.find(object => object.groupId === groupId)!;
      const title = titles.find(object => object.groupId === groupId)!;
      const children = objects.filter(object => object.semanticRole === "diagram.component" && object.groupId === groupId);
      expect(children.length).toBeGreaterThan(0);
      expect(title.x).toBeGreaterThanOrEqual(container.x);
      expect(title.y).toBeGreaterThanOrEqual(container.y);
      for (const child of children) {
        expect(child.x).toBeGreaterThanOrEqual(container.x);
        expect(child.y).toBeGreaterThanOrEqual(container.y + title.height);
        expect(child.x + child.width).toBeLessThanOrEqual(container.x + container.width);
        expect(child.y + child.height).toBeLessThanOrEqual(container.y + container.height);
      }
    }

    const diagramMembers = first.transaction.diagramCommands[0].type === "diagram.create"
      ? first.transaction.diagramCommands[0].diagram.memberObjectIds
      : [];
    expect(new Set(diagramMembers)).toEqual(new Set(objects.filter(object => object.kind !== "connector").map(object => object.id)));
    expect(first.transaction.diagramCommands[0]).toMatchObject({ type: "diagram.create", diagram: { title: "System", connectorIds: Object.values(first.idMap.edges) } });
    expect(first.bounds.width).toBeGreaterThan(0);
    expect(first.warnings.some(w => w.includes("orange"))).toBe(true);
  });
  it("supports ungrouped cycles, self loops, and source IDs that resemble internal layout IDs", async () => {
    const result = await planMermaidImport('flowchart TB\nroot[Root] --> jazzboard-node-0[Peer]\njazzboard-node-0 --> root\nroot --> root');
    expect(Object.keys(result.idMap.edges)).toHaveLength(3);
    expect(() => semanticTransactionSchema.parse(result.transaction)).not.toThrow();
    for (const command of result.transaction.commands) {
      if (command.type === "create") expect([command.object.x, command.object.y, command.object.width, command.object.height].every(Number.isFinite)).toBe(true);
    }
  });
  it("rejects plans whose visible group objects would exceed the transaction operation limit", async () => {
    const nodes = Array.from({ length: 198 }, (_, index) => `n${index}[Node ${index}]`).join("\n");
    await expect(planMermaidImport(`flowchart LR\nsubgraph many[Many]\n${nodes}\nend`, { grouping: "boxed" })).rejects.toMatchObject({
      message: expect.stringMatching(/requires 201 transaction operations.*limit is 200/i),
      details: expect.objectContaining({ nodes: 198, groups: 1, groupObjects: 2, transactionOperationCount: 201, limit: 200 }),
    });
  });
  it("plans the full fictional streaming architecture with compound groups", async () => {
    const result = await planMermaidImport(streamingArchitectureSource(), { grouping: "boxed" });
    const objects = result.transaction.commands.flatMap(command => command.type === "create" ? [command.object] : []);
    expect(result.transaction.commands).toHaveLength(62);
    expect(Object.keys(result.idMap.nodes)).toHaveLength(23);
    expect(Object.keys(result.idMap.edges)).toHaveLength(29);
    expect(objects.filter(object => object.semanticRole === "diagram.group_container")).toHaveLength(5);
    expect(() => semanticTransactionSchema.parse(result.transaction)).not.toThrow();
    expect(result.bounds.width).toBeLessThan(5_000);
    expect(result.bounds.height).toBeLessThan(5_000);
  });
  it("keeps compact flat grouping as the default without extra group objects", async () => {
    const source = streamingArchitectureSource();
    const result = await planMermaidImport(source);
    const explicit = await planMermaidImport(source, { grouping: "compact" });
    const objects = result.transaction.commands.flatMap(command => command.type === "create" ? [command.object] : []);
    expect(result.bounds).toEqual(explicit.bounds);
    expect(result.transaction.commands).toHaveLength(52);
    expect(Object.keys(result.idMap.nodes)).toHaveLength(23);
    expect(Object.keys(result.idMap.edges)).toHaveLength(29);
    expect(Object.keys(result.idMap.groups)).toHaveLength(5);
    expect(objects.filter(object => object.semanticRole === "diagram.group_container" || object.semanticRole === "diagram.group_title")).toHaveLength(0);
    expect(objects.filter(object => object.semanticRole === "diagram.component").every(object => object.groupId !== null)).toBe(true);
    expect(() => semanticTransactionSchema.parse(result.transaction)).not.toThrow();
  });
  it("rejects invalid origins before planning objects", async () => {
    await expect(planMermaidImport('flowchart LR\na[A]', {origin:{x:NaN,y:0}})).rejects.toThrow("origin");
  });
});
