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
const MAX_TRANSACTION_OPERATIONS = 200;
const GROUP_SIDE_PADDING = 40;
const GROUP_TITLE_INSET = 24;
const id = (kind: string) => `${kind}_${globalThis.crypto.randomUUID()}`;

function nodeGeometry(label: string, shape: "rectangle" | "ellipse" | "diamond") {
  const width = Math.max(240, Math.min(520, Array.from(label).length * 12 + 56));
  const textWidth = (width - 56) * (shape === "diamond" ? 0.5 : 1);
  const lines = label.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length * 12 / textWidth)), 0);
  return { width, height: Math.max(shape === "diamond" ? 150 : 100, lines * 30 + 48) };
}

function groupTitleGeometry(label: string) {
  const width = Math.max(180, Math.min(520, Math.max(...label.split("\n").map(line => Array.from(line).length), 1) * 11));
  const lines = label.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length * 11 / width)), 0);
  return { width, height: Math.max(32, lines * 24) };
}

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
export async function planMermaidImport(source: string, options: { title?: string; origin?: Point; grouping?: "compact" | "boxed" } = {}): Promise<MermaidImportPlan> {
  const model = await parseMermaidFlowchart(source).catch((error: unknown) => {
    if (error instanceof MermaidFlowchartImportError) throw new JazzboardInterchangeError("ARTIFACT_INVALID", error.message, { ...error.details, parserCode: error.code });
    throw error;
  });
  const origin = options.origin ?? { x: 100, y: 100 };
  const boxedGrouping = options.grouping === "boxed";
  if (![origin.x, origin.y].every(Number.isFinite) || Math.abs(origin.x) > 100_000 || Math.abs(origin.y) > 100_000) {
    throw new JazzboardInterchangeError("ARTIFACT_INVALID", "Import origin must be finite and within 100,000 canvas units.");
  }
  const canvasCommandCount = model.nodes.length + model.edges.length + (boxedGrouping ? model.groups.length * 2 : 0);
  const transactionOperationCount = canvasCommandCount + 1;
  if (transactionOperationCount > MAX_TRANSACTION_OPERATIONS) {
    throw new JazzboardInterchangeError(
      "ARTIFACT_INVALID",
      `Mermaid flowchart requires ${transactionOperationCount} transaction operations after adding two visible objects for each subgraph; the limit is ${MAX_TRANSACTION_OPERATIONS}.`,
      {
        nodes: model.nodes.length,
        edges: model.edges.length,
        groups: model.groups.length,
        groupObjects: boxedGrouping ? model.groups.length * 2 : 0,
        diagramCommands: 1,
        transactionOperationCount,
        limit: MAX_TRANSACTION_OPERATIONS,
      },
    );
  }

  const elkNodeIds = new Map(model.nodes.map((node, index) => [node.id, `jazzboard-node-${index}`]));
  const elkGroupIds = new Map(model.groups.map((group, index) => [group.id, `jazzboard-group-${index}`]));
  const elkEdgeIds = new Map(model.edges.map((edge, index) => [edge.id, `jazzboard-edge-${index}`]));
  const groupedNodeIds = new Set(model.groups.flatMap(group => group.nodeIds));
  const elkNodes = new Map(model.nodes.map(node => [node.id, { id: elkNodeIds.get(node.id)!, ...nodeGeometry(node.label, node.shape) }]));
  const groupLayout = new Map(model.groups.map(group => {
    const title = groupTitleGeometry(group.label);
    return [group.id, { title, topPadding: title.height + 52 }];
  }));
  const graph: ElkNode = {
    id: "jazzboard-root",
    layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": model.direction === "LR" ? "RIGHT" : "DOWN",
      ...(boxedGrouping ? { "elk.hierarchyHandling": "INCLUDE_CHILDREN" } : {}),
      "elk.edgeRouting": "ORTHOGONAL", "elk.spacing.nodeNode": "100",
      "elk.layered.spacing.nodeNodeBetweenLayers": "180", "elk.spacing.edgeNode": "40",
      "elk.layered.spacing.edgeNodeBetweenLayers": "40", "elk.spacing.edgeEdge": "28",
      "elk.layered.mergeEdges": "false", "elk.padding": "[top=40,left=40,bottom=40,right=40]",
      "elk.randomSeed": "1",
    },
    children: boxedGrouping ? [
      ...model.groups.map(group => {
        const layout = groupLayout.get(group.id)!;
        return {
          id: elkGroupIds.get(group.id)!,
          ...(group.nodeIds.length ? {} : { width: layout.title.width + GROUP_SIDE_PADDING * 2, height: layout.topPadding + 60 }),
          layoutOptions: {
            "elk.padding": `[top=${layout.topPadding},left=${GROUP_SIDE_PADDING},bottom=${GROUP_SIDE_PADDING},right=${GROUP_SIDE_PADDING}]`,
            "elk.nodeSize.constraints": "[MINIMUM_SIZE]",
            "elk.nodeSize.minimum": `(${layout.title.width + GROUP_SIDE_PADDING * 2}, ${layout.topPadding + 60})`,
          },
          children: group.nodeIds.map(nodeId => elkNodes.get(nodeId)!),
        };
      }),
      ...model.nodes.filter(node => !groupedNodeIds.has(node.id)).map(node => elkNodes.get(node.id)!),
    ] : model.nodes.map(node => elkNodes.get(node.id)!),
    edges: model.edges.map(edge => {
      const metrics = connectorLabelMetrics(edge.label);
      return { id: elkEdgeIds.get(edge.id)!, sources: [elkNodeIds.get(edge.start)!], targets: [elkNodeIds.get(edge.end)!],
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
  type AbsoluteGeometry = ElkNode & { absoluteX: number; absoluteY: number };
  const geometry = new Map<string, AbsoluteGeometry>();
  const collectGeometry = (nodes: ElkNode[], parentX = 0, parentY = 0) => {
    for (const node of nodes) {
      const absoluteX = parentX + (node.x ?? 0), absoluteY = parentY + (node.y ?? 0);
      geometry.set(node.id, { ...node, absoluteX, absoluteY });
      collectGeometry(node.children ?? [], absoluteX, absoluteY);
    }
  };
  collectGeometry(laidOut.children ?? []);
  const groupGeometry = new Map(boxedGrouping
    ? model.groups.map(group => [group.id, geometry.get(elkGroupIds.get(group.id)!)!])
    : []);
  const objects: CreateCanvasObject[] = model.nodes.map(node => {
    const n = geometry.get(elkNodeIds.get(node.id)!)!;
    const groupIndex = model.groups.findIndex(g => g.nodeIds.includes(node.id));
    const group = model.groups[groupIndex];
    const [fill, stroke] = PALETTE[Math.max(0, groupIndex) % PALETTE.length];
    return { id: idMap.nodes[node.id], kind: "shape", semanticName: node.id, semanticRole: "diagram.component",
      x: origin.x + n.absoluteX, y: origin.y + n.absoluteY, width: n.width!, height: n.height!, rotation: 0, zIndex: 1,
      groupId: group ? idMap.groups[group.id] : null, shape: node.shape, label: node.label, fill, stroke };
  });
  const groupObjectIds: string[] = [];
  if (boxedGrouping) model.groups.forEach((group, groupIndex) => {
    const n = groupGeometry.get(group.id)!;
    const layout = groupLayout.get(group.id)!;
    const [, stroke] = PALETTE[groupIndex % PALETTE.length];
    const containerId = id("shape"), titleId = id("text");
    groupObjectIds.push(containerId, titleId);
    objects.push({ id: containerId, kind: "shape", semanticName: group.id, semanticRole: "diagram.group_container",
      x: origin.x + n.absoluteX, y: origin.y + n.absoluteY, width: n.width!, height: n.height!, rotation: 0, zIndex: 0,
      groupId: idMap.groups[group.id], shape: "rectangle", label: "", fill: "none", stroke });
    objects.push({ id: titleId, kind: "text", semanticName: group.id, semanticRole: "diagram.group_title",
      x: origin.x + n.absoluteX + GROUP_TITLE_INSET, y: origin.y + n.absoluteY + 18,
      width: Math.max(1, n.width! - GROUP_TITLE_INSET * 2), height: layout.title.height,
      rotation: 0, zIndex: 1, groupId: idMap.groups[group.id], content: group.label, color: stroke, size: "m", align: "start" });
  });
  const edgeOffset = (startNodeId: string, endNodeId: string): Point => {
    if (!boxedGrouping) return { x: 0, y: 0 };
    const startGroupId = model.nodes.find(node => node.id === startNodeId)?.groupId;
    const endGroupId = model.nodes.find(node => node.id === endNodeId)?.groupId;
    if (startGroupId && startGroupId === endGroupId) {
      const group = groupGeometry.get(startGroupId)!;
      return { x: group.absoluteX, y: group.absoluteY };
    }
    return { x: 0, y: 0 };
  };
  const endpoint = (point: Point, nodeId: string): ConnectorEndpoint => {
    const n = geometry.get(elkNodeIds.get(nodeId)!)!;
    return { x: origin.x + point.x, y: origin.y + point.y, objectId: idMap.nodes[nodeId],
      normalizedAnchor: { x: (point.x - n.absoluteX) / n.width!, y: (point.y - n.absoluteY) / n.height! },
      isExact: true, isPrecise: true, snap: "edge-point" };
  };
  const elkEdges = new Map((laidOut.edges ?? []).map(e => [e.id, e]));
  model.edges.forEach(edge => {
    const rendered = elkEdges.get(elkEdgeIds.get(edge.id)!)!;
    if (rendered.sections?.length !== 1) throw new JazzboardInterchangeError("ARTIFACT_INVALID", "Import requires one continuous route for each connection.");
    const section = rendered.sections[0];
    const hierarchyOffset = edgeOffset(edge.start, edge.end);
    const absolute = (point: Point): Point => ({ x: point.x + hierarchyOffset.x, y: point.y + hierarchyOffset.y });
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(absolute);
    if (points.length > 32) throw new JazzboardInterchangeError("ARTIFACT_INVALID", "A connection exceeds the native route complexity limit.");
    const label = rendered.labels?.[0];
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    objects.push({ id: idMap.edges[edge.id], kind: "connector", semanticName: edge.id,
      semanticRole: edge.dotted ? "diagram.dotted_relationship" : "diagram.relationship",
      x: origin.x + Math.min(...xs), y: origin.y + Math.min(...ys),
      width: Math.max(1, Math.max(...xs) - Math.min(...xs)), height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
      rotation: 0, zIndex: 2, groupId: null, start: endpoint(points[0], edge.start), end: endpoint(points[points.length - 1], edge.end),
      label: edge.label, direction: edge.direction, color: edge.dotted ? "#d56d30" : "#5266df",
      routing: { mode: points.length > 2 ? "elbow" : "straight", kind: points.length > 2 ? "elbow" : "straight", bend: 0, elbowMidPoint: 0.5,
        ...(points.length > 2 ? {waypoints: points.slice(1, -1).map(point => ({ x: point.x + origin.x, y: point.y + origin.y }))} : {}),
        labelPosition: labelPosition(points, label && absolute({ x: label.x! + label.width! / 2, y: label.y! + label.height! / 2 })), labelPositionSource: "authored" },
    });
  });
  return {
    idMap, bounds: { x: origin.x, y: origin.y, width: laidOut.width!, height: laidOut.height! },
    warnings: [...model.warnings, ...(model.groups.length ? [boxedGrouping
      ? "Subgraphs become native groups with visible editable containers and titles."
      : "Subgraphs become native groups with distinct colors; enclosing boxes and subgraph titles are not drawn."] : []),
      ...(model.edges.some(e => e.dotted) ? ["Dotted Mermaid edges are orange solid native connectors; their dotted relationship classification is retained."] : []),
      "Automatic layout is not a visual quality certification; inspect the diagram before reporting completion."],
    transaction: { commands: objects.map(object => ({ type: "create", object })), diagramCommands: [{ type: "diagram.create", diagram: {
      id: idMap.diagramId, title: options.title?.trim() || "Imported Mermaid flowchart", description: "Imported from Mermaid as editable native shapes and connectors.",
      diagramType: "architecture", category: null, tags: ["mermaid"], memberObjectIds: [...Object.values(idMap.nodes), ...groupObjectIds], connectorIds: Object.values(idMap.edges),
    } }] },
  };
}
