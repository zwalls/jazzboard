import type { FlowDB } from "mermaid/dist/diagrams/flowchart/flowDb.js";
import type {
  FlowEdge,
  FlowSubGraph,
  FlowVertex,
} from "mermaid/dist/diagrams/flowchart/types.js";

export type MermaidFlowchartDirection = "LR" | "TB";
export type MermaidFlowchartNodeShape = "rectangle" | "ellipse" | "diamond";

export type NormalizedMermaidFlowchartNode = {
  /** The exact Mermaid node ID. */
  id: string;
  label: string;
  shape: MermaidFlowchartNodeShape;
  /** Mermaid's parsed shape name, retained when Jazzboard uses a coarser native shape. */
  sourceShape: string;
  /** The exact Mermaid subgraph ID, or null when the node is not grouped. */
  groupId: string | null;
};

export type NormalizedMermaidFlowchartEdge = {
  /** The explicit Mermaid edge ID, or Mermaid's deterministic generated edge ID. */
  id: string;
  start: string;
  end: string;
  label: string;
  direction: "none" | "end" | "both";
  /** Preserves Mermaid's dotted stroke without assigning application semantics to it. */
  dotted: boolean;
  isUserDefinedId: boolean;
};

export type NormalizedMermaidFlowchartGroup = {
  /** The exact Mermaid subgraph ID. */
  id: string;
  label: string;
  nodeIds: string[];
};

export type NormalizedMermaidFlowchart = {
  direction: MermaidFlowchartDirection;
  nodes: NormalizedMermaidFlowchartNode[];
  edges: NormalizedMermaidFlowchartEdge[];
  groups: NormalizedMermaidFlowchartGroup[];
  warnings: string[];
};

export type MermaidFlowchartParseOptions = {
  maxSourceLength?: number;
  maxNodes?: number;
  maxEdges?: number;
  maxGroups?: number;
  maxElements?: number;
};

export type MermaidFlowchartImportErrorCode =
  | "MERMAID_PARSE_ERROR"
  | "MERMAID_UNSUPPORTED"
  | "MERMAID_LIMIT_EXCEEDED";

export class MermaidFlowchartImportError extends Error {
  constructor(
    public readonly code: MermaidFlowchartImportErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MermaidFlowchartImportError";
  }
}

const DEFAULT_LIMITS = {
  maxSourceLength: 64 * 1024,
  maxNodes: 198,
  maxEdges: 198,
  maxGroups: 64,
  maxElements: 198,
} as const;

const MAX_NODE_LABEL_LENGTH = 10_000;
const MAX_EDGE_LABEL_LENGTH = 2_000;
const MAX_SOURCE_ID_LENGTH = 160;
const MAX_GROUP_LABEL_LENGTH = 160;

type MermaidModule = typeof import("mermaid");

let mermaidModulePromise: Promise<MermaidModule> | null = null;
let parserGate: Promise<void> = Promise.resolve();

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new MermaidFlowchartImportError(
      "MERMAID_LIMIT_EXCEEDED",
      `${name} must be a positive integer.`,
      { name, value: resolved },
    );
  }
  return resolved;
}

function limits(options: MermaidFlowchartParseOptions) {
  return {
    maxSourceLength: positiveInteger(
      options.maxSourceLength,
      DEFAULT_LIMITS.maxSourceLength,
      "maxSourceLength",
    ),
    maxNodes: positiveInteger(options.maxNodes, DEFAULT_LIMITS.maxNodes, "maxNodes"),
    maxEdges: positiveInteger(options.maxEdges, DEFAULT_LIMITS.maxEdges, "maxEdges"),
    maxGroups: positiveInteger(options.maxGroups, DEFAULT_LIMITS.maxGroups, "maxGroups"),
    maxElements: positiveInteger(
      options.maxElements,
      DEFAULT_LIMITS.maxElements,
      "maxElements",
    ),
  };
}

function sourcePreview(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || "Mermaid could not parse the flowchart.";
}

async function loadMermaidModule(): Promise<MermaidModule> {
  if (mermaidModulePromise) return mermaidModulePromise;
  mermaidModulePromise = (async () => {
    // Mermaid's parser sanitizes labels through DOMPurify. The DOMPurify ESM
    // default is an uninitialized factory in plain Node, so initialize that
    // shared factory with a private JSDOM window before Mermaid imports it.
    // This avoids publishing a temporary `window` on globalThis where another
    // concurrent Next.js request could observe it. Jazzboard never renders SVG.
    const hasWindow = typeof globalThis.window !== "undefined" && Boolean(globalThis.window.document);
    if (!hasWindow) {
      const { JSDOM } = await import("jsdom");
      const { default: createDOMPurify } = await import("dompurify");
      const dom = new JSDOM("<!doctype html><html><body></body></html>");
      const purifier = createDOMPurify(
        dom.window as unknown as Parameters<typeof createDOMPurify>[0],
      );
      Object.assign(createDOMPurify, purifier);
    }
    const loadedMermaid = await import("mermaid");
    loadedMermaid.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      maxTextSize: DEFAULT_LIMITS.maxSourceLength,
      maxEdges: DEFAULT_LIMITS.maxEdges,
      flowchart: { htmlLabels: false },
    });
    return loadedMermaid;
  })();
  return mermaidModulePromise;
}

async function withParserLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = parserGate;
  let release!: () => void;
  parserGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function rejectConfigurationSyntax(source: string): void {
  if (/^\s*---(?:\r?\n|$)/.test(source)) {
    throw new MermaidFlowchartImportError(
      "MERMAID_UNSUPPORTED",
      "Mermaid frontmatter is not supported by the flowchart importer.",
      { feature: "frontmatter" },
    );
  }
  if (/%%\s*\{/.test(source)) {
    throw new MermaidFlowchartImportError(
      "MERMAID_UNSUPPORTED",
      "Mermaid directives are not supported by the flowchart importer.",
      { feature: "directive" },
    );
  }
}

function requireBoundedText(
  value: string,
  maximum: number,
  field: string,
  entityId: string,
): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length > maximum) {
    throw new MermaidFlowchartImportError(
      "MERMAID_LIMIT_EXCEEDED",
      `Mermaid ${field} exceeds Jazzboard's supported length.`,
      { field, entityId, maximum, actual: normalized.length },
    );
  }
  return normalized;
}

function requireSourceId(id: string, kind: "node" | "edge" | "subgraph"): string {
  if (!id || id.length > MAX_SOURCE_ID_LENGTH) {
    throw new MermaidFlowchartImportError(
      "MERMAID_LIMIT_EXCEEDED",
      `Mermaid ${kind} ID must contain 1-${MAX_SOURCE_ID_LENGTH} characters.`,
      { kind, id: id.slice(0, MAX_SOURCE_ID_LENGTH), actualLength: id.length },
    );
  }
  return id;
}

function normalizedNodeShape(vertex: FlowVertex): {
  shape: MermaidFlowchartNodeShape;
  sourceShape: string;
  warning?: string;
} {
  const sourceShape = vertex.type ?? "square";
  if (["square", "rect"].includes(sourceShape)) {
    return { shape: "rectangle", sourceShape };
  }
  if (sourceShape === "round") {
    return {
      shape: "rectangle",
      sourceShape,
      warning: `Node ${vertex.id} uses Mermaid's rounded rectangle; Jazzboard imports it as a native rectangle.`,
    };
  }
  if (["circle", "ellipse"].includes(sourceShape)) {
    return { shape: "ellipse", sourceShape };
  }
  if (sourceShape === "diamond") {
    return { shape: "diamond", sourceShape };
  }
  throw new MermaidFlowchartImportError(
    "MERMAID_UNSUPPORTED",
    `Mermaid node ${vertex.id} uses unsupported shape ${sourceShape}.`,
    { feature: "node_shape", nodeId: vertex.id, sourceShape },
  );
}

function rejectVertexFeatures(vertex: FlowVertex): void {
  const features = [
    vertex.styles.length ? "inline_style" : null,
    vertex.classes.length ? "class" : null,
    vertex.haveCallback ? "callback" : null,
    vertex.link ? "link" : null,
    vertex.icon ? "icon" : null,
    vertex.img ? "image" : null,
    vertex.dir ? "node_direction" : null,
    vertex.constraint ? "constraint" : null,
    vertex.props && Object.keys(vertex.props).length ? "metadata" : null,
  ].filter((feature): feature is string => feature !== null);
  if (features.length) {
    throw new MermaidFlowchartImportError(
      "MERMAID_UNSUPPORTED",
      `Mermaid node ${vertex.id} uses unsupported features.`,
      { nodeId: vertex.id, features },
    );
  }
  if (vertex.labelType === "markdown") {
    throw new MermaidFlowchartImportError(
      "MERMAID_UNSUPPORTED",
      `Mermaid node ${vertex.id} uses a Markdown label.`,
      { nodeId: vertex.id, feature: "markdown_label" },
    );
  }
}

function normalizedEdgeDirection(edge: FlowEdge): "none" | "end" | "both" {
  if (edge.type === "arrow_open") return "none";
  if (edge.type === "arrow_point") return "end";
  if (edge.type === "double_arrow_point") return "both";
  throw new MermaidFlowchartImportError(
    "MERMAID_UNSUPPORTED",
    `Mermaid edge ${edge.id ?? `${edge.start}-${edge.end}`} uses an unsupported arrow type.`,
    { feature: "edge_arrow", edgeId: edge.id ?? null, arrowType: edge.type ?? null },
  );
}

function rejectEdgeFeatures(edge: FlowEdge): void {
  const features = [
    edge.stroke === "thick" ? "thick_edge" : null,
    edge.stroke === "invisible" ? "invisible_edge" : null,
    edge.style?.length ? "edge_style" : null,
    edge.classes.length ? "edge_class" : null,
    edge.animate ? "edge_animation" : null,
    edge.animation ? "edge_animation" : null,
    edge.interpolate ? "edge_curve" : null,
    edge.labelType === "markdown" ? "markdown_label" : null,
    edge.length !== undefined && edge.length !== 1 ? "minimum_length" : null,
  ].filter((feature): feature is string => feature !== null);
  if (features.length) {
    throw new MermaidFlowchartImportError(
      "MERMAID_UNSUPPORTED",
      `Mermaid edge ${edge.id ?? `${edge.start}-${edge.end}`} uses unsupported features.`,
      { edgeId: edge.id ?? null, features },
    );
  }
}

function normalizeGroups(
  subgraphs: readonly FlowSubGraph[],
  nodeIds: ReadonlySet<string>,
): { groups: NormalizedMermaidFlowchartGroup[]; groupByNodeId: Map<string, string> } {
  const groupIds = new Set(subgraphs.map((group) => group.id));
  const groupByNodeId = new Map<string, string>();
  const groups = subgraphs.map((group) => {
    requireSourceId(group.id, "subgraph");
    if (group.classes.length || group.dir || group.metadata) {
      throw new MermaidFlowchartImportError(
        "MERMAID_UNSUPPORTED",
        `Mermaid subgraph ${group.id} uses unsupported features.`,
        {
          groupId: group.id,
          features: [
            group.classes.length ? "class" : null,
            group.dir ? "direction" : null,
            group.metadata ? "metadata" : null,
          ].filter(Boolean),
        },
      );
    }
    if (group.labelType === "markdown") {
      throw new MermaidFlowchartImportError(
        "MERMAID_UNSUPPORTED",
        `Mermaid subgraph ${group.id} uses a Markdown label.`,
        { groupId: group.id, feature: "markdown_label" },
      );
    }
    const nestedGroupId = group.nodes.find((nodeId) => groupIds.has(nodeId));
    if (nestedGroupId) {
      throw new MermaidFlowchartImportError(
        "MERMAID_UNSUPPORTED",
        "Nested Mermaid subgraphs are not supported by the flowchart importer.",
        { groupId: group.id, nestedGroupId },
      );
    }
    const unknownNodeId = group.nodes.find((nodeId) => !nodeIds.has(nodeId));
    if (unknownNodeId) {
      throw new MermaidFlowchartImportError(
        "MERMAID_UNSUPPORTED",
        `Mermaid subgraph ${group.id} contains an unsupported member.`,
        { groupId: group.id, memberId: unknownNodeId },
      );
    }
    for (const nodeId of group.nodes) {
      const existing = groupByNodeId.get(nodeId);
      if (existing && existing !== group.id) {
        throw new MermaidFlowchartImportError(
          "MERMAID_UNSUPPORTED",
          `Mermaid node ${nodeId} belongs to more than one subgraph.`,
          { nodeId, groupIds: [existing, group.id] },
        );
      }
      groupByNodeId.set(nodeId, group.id);
    }
    return {
      id: group.id,
      label: requireBoundedText(group.title || group.id, MAX_GROUP_LABEL_LENGTH, "subgraph label", group.id),
      nodeIds: [...group.nodes],
    };
  });
  return { groups, groupByNodeId };
}

function normalizeParsedFlowchart(
  db: FlowDB,
  parseLimits: ReturnType<typeof limits>,
): NormalizedMermaidFlowchart {
  const direction = db.getDirection();
  if (direction !== undefined && direction !== "LR" && direction !== "TB" && direction !== "TD") {
    throw new MermaidFlowchartImportError(
      "MERMAID_UNSUPPORTED",
      `Mermaid flowchart direction ${direction} is not supported. Use LR or TB.`,
      { feature: "direction", direction },
    );
  }

  if (db.getClasses().size > 0) {
    throw new MermaidFlowchartImportError(
      "MERMAID_UNSUPPORTED",
      "Mermaid class definitions are not supported by the flowchart importer.",
      { feature: "class_definition" },
    );
  }

  const vertices = [...db.getVertices().values()];
  const parsedEdges = [...db.getEdges()];
  const subgraphs = [...db.getSubGraphs()];
  const counts = {
    nodes: vertices.length,
    edges: parsedEdges.length,
    groups: subgraphs.length,
    elements: vertices.length + parsedEdges.length,
  };
  if (
    counts.nodes > parseLimits.maxNodes ||
    counts.edges > parseLimits.maxEdges ||
    counts.groups > parseLimits.maxGroups ||
    counts.elements > parseLimits.maxElements
  ) {
    throw new MermaidFlowchartImportError(
      "MERMAID_LIMIT_EXCEEDED",
      "Mermaid flowchart exceeds the supported import size.",
      { counts, limits: parseLimits },
    );
  }
  if (!vertices.length) {
    throw new MermaidFlowchartImportError(
      "MERMAID_UNSUPPORTED",
      "Mermaid flowchart import requires at least one node.",
      { feature: "empty_flowchart" },
    );
  }

  const nodeIds = new Set(vertices.map((vertex) => vertex.id));
  const { groups, groupByNodeId } = normalizeGroups(subgraphs, nodeIds);
  const warnings: string[] = [];
  const nodes = vertices.map((vertex): NormalizedMermaidFlowchartNode => {
    requireSourceId(vertex.id, "node");
    rejectVertexFeatures(vertex);
    const normalizedShape = normalizedNodeShape(vertex);
    if (normalizedShape.warning) warnings.push(normalizedShape.warning);
    return {
      id: vertex.id,
      label: requireBoundedText(vertex.text ?? vertex.id, MAX_NODE_LABEL_LENGTH, "node label", vertex.id),
      shape: normalizedShape.shape,
      sourceShape: normalizedShape.sourceShape,
      groupId: groupByNodeId.get(vertex.id) ?? null,
    };
  });

  const edges = parsedEdges.map((edge): NormalizedMermaidFlowchartEdge => {
    rejectEdgeFeatures(edge);
    const edgeId = requireSourceId(edge.id ?? `L_${edge.start}_${edge.end}`, "edge");
    if (!nodeIds.has(edge.start) || !nodeIds.has(edge.end)) {
      throw new MermaidFlowchartImportError(
        "MERMAID_UNSUPPORTED",
        `Mermaid edge ${edgeId} must connect two nodes, not a subgraph or unknown target.`,
        { edgeId, start: edge.start, end: edge.end, feature: "subgraph_endpoint" },
      );
    }
    return {
      id: edgeId,
      start: edge.start,
      end: edge.end,
      label: requireBoundedText(edge.text, MAX_EDGE_LABEL_LENGTH, "edge label", edgeId),
      direction: normalizedEdgeDirection(edge),
      dotted: edge.stroke === "dotted",
      isUserDefinedId: edge.isUserDefinedId,
    };
  });

  return {
    direction: direction === "LR" ? "LR" : "TB",
    nodes,
    edges,
    groups,
    warnings,
  };
}

/**
 * Parse a bounded, non-interactive Mermaid flowchart into renderer-independent
 * graph data. This uses Mermaid's own grammar and never renders or reads SVG.
 */
export async function parseMermaidFlowchart(
  source: string,
  options: MermaidFlowchartParseOptions = {},
): Promise<NormalizedMermaidFlowchart> {
  const parseLimits = limits(options);
  if (typeof source !== "string" || source.length === 0) {
    throw new MermaidFlowchartImportError(
      "MERMAID_PARSE_ERROR",
      "Mermaid source must be a non-empty string.",
    );
  }
  if (source.length > parseLimits.maxSourceLength) {
    throw new MermaidFlowchartImportError(
      "MERMAID_LIMIT_EXCEEDED",
      "Mermaid source exceeds the supported import length.",
      { maximum: parseLimits.maxSourceLength, actual: source.length },
    );
  }
  rejectConfigurationSyntax(source);

  return withParserLock(async () => {
    try {
      const loadedMermaid = await loadMermaidModule();
      const diagram = await loadedMermaid.default.mermaidAPI.getDiagramFromText(source);
      if (diagram.type !== "flowchart-v2") {
        throw new MermaidFlowchartImportError(
          "MERMAID_UNSUPPORTED",
          `Mermaid diagram type ${diagram.type} is not supported. Import a flowchart or graph.`,
          { diagramType: diagram.type },
        );
      }
      return normalizeParsedFlowchart(diagram.db as FlowDB, parseLimits);
    } catch (error) {
      if (error instanceof MermaidFlowchartImportError) throw error;
      throw new MermaidFlowchartImportError(
        "MERMAID_PARSE_ERROR",
        "Mermaid could not parse the flowchart.",
        { parserMessage: sourcePreview(error) },
      );
    }
  });
}
