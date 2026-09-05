import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { connectorLabelMetrics } from "@/lib/domain/layout";
import type { CanvasBounds, ConnectorEndpoint, CreateCanvasObject, Point, SemanticTransaction } from "@/lib/domain/types";
import { parseMermaidFlowchart, MermaidFlowchartImportError } from "./mermaid-import";
import { JazzboardInterchangeError } from "./types";

export type MermaidImportPlan = {
  transaction: SemanticTransaction;
  idMap: { nodes: Record<string, string>; edges: Record<string, string>; groups: Record<string, string>; diagramId: string };
  bounds: CanvasBounds;
  warnings: string[];
};

const PALETTE = [
  ["#deedf8", "#5266df"], ["#dff0e3", "#158b68"],
  ["#f2e5f7", "#9050c8"], ["#f8eedc", "#d56d30"], ["#f7dfe0", "#d9484a"],
];
const id = (kind: string) => `${kind}_${globalThis.crypto.randomUUID()}`;

/** Project an ELK label center onto the native route's arclength parameter. */
function labelPosition(points: Point[], center?: Point): number {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (!center || !total) return 0.5;
  let bestDistance = Infinity, bestLength = total / 2, traversed = 0;
  lengths.forEach((length, i) => {
    const a = points[i], b = points[i + 1];
    const t = length ? Math.max(0, Math.min(1, ((center.x - a.x) * (b.x - a.x) + (center.y - a.y) * (b.y - a.y)) / (length * length))) : 0;
    const distance = Math.hypot(center.x - a.x - t * (b.x - a.x), center.y - a.y - t * (b.y - a.y));
    if (distance < bestDistance) { bestDistance = distance; bestLength = traversed + t * length; }
    traversed += length;
  });
  return Math.max(0.01, Math.min(0.99, bestLength / total));
}

/** Parse once and plan native editable objects; no room mutation occurs here. */
export async function planMermaidImport(source: string, options: { title?: string; origin?: Point } = {}): Promise<MermaidImportPlan> {
  const model = await parseMermaidFlowchart(source).catch((error: unknown) => {
    if (error instanceof MermaidFlowchartImportError) throw new JazzboardInterchangeError("ARTIFACT_INVALID", error.message, { ...error.details, parserCode: error.code });
    throw error;
  });
  const origin = options.origin ?? { x: 100, y: 100 };
  if (![origin.x, origin.y].every(Number.isFinite) || Math.abs(origin.x) > 100_000 || Math.abs(origin.y) > 100_000) {
    throw new JazzboardInterchangeError("ARTIFACT_INVALID", "Import origin must be finite and within 100,000 canvas units.");
  }
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": model.direction === "LR" ? "RIGHT" : "DOWN",
      "elk.edgeRouting": "ORTHOGONAL", "elk.spacing.nodeNode": "100",
      "elk.layered.spacing.nodeNodeBetweenLayers": "180", "elk.spacing.edgeNode": "40",
      "elk.layered.spacing.edgeNodeBetweenLayers": "40", "elk.spacing.edgeEdge": "28",
      "elk.layered.mergeEdges": "false", "elk.padding": "[top=40,left=40,bottom=40,right=40]",
      "elk.randomSeed": "1",
    },
    children: model.nodes.map(node => {
      const width = Math.max(240, Math.min(520, Array.from(node.label).length * 12 + 56));
      const textWidth = (width - 56) * (node.shape === "diamond" ? 0.5 : 1);
      const lines = node.label.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length * 12 / textWidth)), 0);
      return { id: node.id, width, height: Math.max(node.shape === "diamond" ? 150 : 100, lines * 30 + 48) };
    }),
    edges: model.edges.map(edge => {
      const metrics = connectorLabelMetrics(edge.label);
      return { id: edge.id, sources: [edge.start], targets: [edge.end],
        labels: edge.label ? [{ text: edge.label, width: metrics.width + 24, height: metrics.height + 20,
          layoutOptions: { "elk.edgeLabels.placement": "CENTER" } }] : [] };
    }),
  };
  let laidOut: ElkNode;
  try { laidOut = await new ELK().layout(graph); }
  catch { throw new JazzboardInterchangeError("ARTIFACT_INVALID", "Mermaid graph could not be laid out; simplify its connections or split it into smaller diagrams."); }
  const idMap: MermaidImportPlan["idMap"] = {
    nodes: Object.fromEntries(model.nodes.map(n => [n.id, id("shape")])),
    edges: Object.fromEntries(model.edges.map(e => [e.id, id("connector")])),
    groups: Object.fromEntries(model.groups.map(g => [g.id, id("group")])), diagramId: id("diagram"),
  };
  const geometry = new Map((laidOut.children ?? []).map(n => [n.id, n]));
  const objects: CreateCanvasObject[] = model.nodes.map(node => {
    const n = geometry.get(node.id)!;
    const groupIndex = model.groups.findIndex(g => g.nodeIds.includes(node.id));
    const group = model.groups[groupIndex];
    const [fill, stroke] = PALETTE[Math.max(0, groupIndex) % PALETTE.length];
    return { id: idMap.nodes[node.id], kind: "shape", semanticName: node.id, semanticRole: "diagram.component",
      x: origin.x + n.x!, y: origin.y + n.y!, width: n.width!, height: n.height!, rotation: 0, zIndex: 1,
      groupId: group ? idMap.groups[group.id] : null, shape: node.shape, label: node.label, fill, stroke };
  });
  const offset = (p: Point): Point => ({ x: p.x + origin.x, y: p.y + origin.y });
  const endpoint = (point: Point, nodeId: string): ConnectorEndpoint => {
    const n = geometry.get(nodeId)!;
    return { ...offset(point), objectId: idMap.nodes[nodeId],
      normalizedAnchor: { x: (point.x - n.x!) / n.width!, y: (point.y - n.y!) / n.height! },
      isExact: true, isPrecise: true, snap: "edge-point" };
  };
  const elkEdges = new Map((laidOut.edges ?? []).map(e => [e.id, e]));
  model.edges.forEach(edge => {
    const rendered = elkEdges.get(edge.id)!;
    if (rendered.sections?.length !== 1) throw new JazzboardInterchangeError("ARTIFACT_INVALID", "Import requires one continuous route for each connection.");
    const section = rendered.sections[0];
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    if (points.length > 32) throw new JazzboardInterchangeError("ARTIFACT_INVALID", "A connection exceeds the native route complexity limit.");
    const label = rendered.labels?.[0];
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    objects.push({ id: idMap.edges[edge.id], kind: "connector", semanticName: edge.id,
      semanticRole: edge.dotted ? "diagram.dotted_relationship" : "diagram.relationship",
      x: origin.x + Math.min(...xs), y: origin.y + Math.min(...ys),
      width: Math.max(1, Math.max(...xs) - Math.min(...xs)), height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
      rotation: 0, zIndex: 2, groupId: null, start: endpoint(section.startPoint, edge.start), end: endpoint(section.endPoint, edge.end),
      label: edge.label, direction: edge.direction, color: edge.dotted ? "#d56d30" : "#5266df",
      routing: { mode: points.length > 2 ? "elbow" : "straight", kind: points.length > 2 ? "elbow" : "straight", bend: 0, elbowMidPoint: 0.5, ...(points.length > 2 ? {waypoints: points.slice(1, -1).map(offset)} : {}),
        labelPosition: labelPosition(points, label && { x: label.x! + label.width! / 2, y: label.y! + label.height! / 2 }), labelPositionSource: "authored" },
    });
  });
  return {
    idMap, bounds: { x: origin.x, y: origin.y, width: laidOut.width!, height: laidOut.height! },
    warnings: [...model.warnings, ...(model.groups.length ? ["Subgraphs become native groups with distinct colors; enclosing boxes and subgraph titles are not drawn."] : []),
      ...(model.edges.some(e => e.dotted) ? ["Dotted Mermaid edges are orange solid native connectors; their dotted relationship classification is retained."] : []),
      "Automatic layout is not a visual quality certification; inspect the diagram before reporting completion."],
    transaction: { commands: objects.map(object => ({ type: "create", object })), diagramCommands: [{ type: "diagram.create", diagram: {
      id: idMap.diagramId, title: options.title?.trim() || "Imported Mermaid flowchart", description: "Imported from Mermaid as editable native shapes and connectors.",
      diagramType: "architecture", category: null, tags: ["mermaid"], memberObjectIds: Object.values(idMap.nodes), connectorIds: Object.values(idMap.edges),
    } }] },
  };
}
