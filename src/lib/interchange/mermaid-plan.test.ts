import { describe, expect, it } from "vitest";
import { createCanvasObjectSchema } from "@/lib/domain/schemas";
import { planMermaidImport } from "./mermaid-plan";

describe("Mermaid native planning", () => {
  it("preserves relationships, groups and editable native routes with fresh IDs", async () => {
    const source = 'flowchart LR\nsubgraph frontend[Frontend]\na[Client]\nend\nsubgraph backend[Backend]\nb[API]\nc[(Store)]\nend\na -->|request| b\nb -.->|write| c';
    // Use a rectangle because database cylinders are outside the initial subset.
    const supported = source.replace('c[(Store)]', 'c[Store]');
    const first = await planMermaidImport(supported, { title: "System", origin: { x: 20, y: 40 } });
    const second = await planMermaidImport(supported);
    expect(first.idMap.nodes.a).not.toBe(second.idMap.nodes.a);
    expect(first.transaction.commands).toHaveLength(5);
    const objects = first.transaction.commands.flatMap(c => c.type === "create" ? [c.object] : []);
    for (const object of objects) expect(() => createCanvasObjectSchema.parse(object)).not.toThrow();
    const edges = objects.filter(o => o.kind === "connector");
    expect(edges.map(e => [e.start.objectId, e.end.objectId, e.label])).toEqual([
      [first.idMap.nodes.a, first.idMap.nodes.b, "request"], [first.idMap.nodes.b, first.idMap.nodes.c, "write"],
    ]);
    expect(edges.every(e => ["elbow", "straight"].includes(e.routing!.mode) && e.start.isExact)).toBe(true);
    expect(objects.find(o => o.id === first.idMap.nodes.a)?.groupId).toBe(first.idMap.groups.frontend);
    expect(first.transaction.diagramCommands[0]).toMatchObject({ type: "diagram.create", diagram: { title: "System", connectorIds: Object.values(first.idMap.edges) } });
    expect(first.bounds.width).toBeGreaterThan(0);
    expect(first.warnings.some(w => w.includes("orange"))).toBe(true);
  });
  it("supports cycles and self loops without losing edge direction", async () => {
    const result = await planMermaidImport('flowchart TB\na[A] --> b[B]\nb --> a\na --> a');
    expect(Object.keys(result.idMap.edges)).toHaveLength(3);
    for (const command of result.transaction.commands) {
      if (command.type === "create") expect([command.object.x, command.object.y, command.object.width, command.object.height].every(Number.isFinite)).toBe(true);
    }
  });
  it("rejects invalid origins before planning objects", async () => {
    await expect(planMermaidImport('flowchart LR\na[A]', {origin:{x:NaN,y:0}})).rejects.toThrow("origin");
  });
});
