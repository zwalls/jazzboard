/// <reference types="webmcp-types" />

import { z } from "zod";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import { nodeMetadataInputSchema } from "@/lib/domain/schemas";
import type {
  AgentEditProposalSummary,
  CanvasCommand,
  CanvasObject,
  CreateCanvasObject,
  DiagramCommand,
  DiagramNodeType,
  ObjectKind,
  ObjectPatch,
  RoomState,
  RoomActivitySummary,
  Viewport,
} from "@/lib/domain/types";

import type {
  JazzboardToolFailure,
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  WebMcpRequest,
} from "./types";

const id = z.string().min(1).max(128);
const tempRef = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const finite = z.number().finite();
const dimension = finite.positive().max(100_000);
const point = z.object({ x: finite, y: finite }).strict();
const nodeType = z.enum(["service", "component", "requirement", "decision", "open_question"]);
const nodeStatus = z.enum(["proposed", "accepted", "rejected", "superseded", "open", "answered", "deferred", "closed"]);
const REVIEW_MODE_RESULT_NOTE =
  " If the room requires review, Jazzboard queues the exact all-or-nothing request and returns outcome `proposed` plus its proposal; shared canvas state remains unchanged until a human approves it.";
const diagramType = z.enum(["architecture", "flow", "hierarchy", "system_context", "process", "custom"]);
const objectKind = z.enum(["text", "shape", "connector", "image", "draw"]);

const placement = {
  x: finite.optional(),
  y: finite.optional(),
  width: dimension.optional(),
  height: dimension.optional(),
  rotation: finite.optional(),
  zIndex: z.number().int().min(0).max(1_000_000).optional(),
  groupId: id.nullable().optional(),
};

const activityMetadataFields = {
  intent: z.string().trim().min(1).max(1_000).optional(),
  summary: z.string().trim().min(1).max(500).optional(),
};

function activityMetadata(input: { intent?: string; summary?: string }) {
  return input.intent || input.summary ? { intent: input.intent, summary: input.summary } : undefined;
}

function stripActivityMetadata<T extends { intent?: string; summary?: string }>(input: T): Omit<T, "intent" | "summary"> {
  const result = { ...input };
  delete result.intent;
  delete result.summary;
  return result;
}

const objectReference = z.union([
  z.object({ objectId: id }).strict(),
  z.object({ tempRef }).strict(),
]);

const endpointReference = z.union([objectReference, point]);

const objectPatch = z
  .object({
    x: finite.optional(),
    y: finite.optional(),
    width: dimension.optional(),
    height: dimension.optional(),
    rotation: finite.optional(),
    zIndex: z.number().int().min(0).max(1_000_000).optional(),
    groupId: id.nullable().optional(),
    content: z.string().max(20_000).optional(),
    color: z.string().min(1).max(32).optional(),
    size: z.enum(["s", "m", "l", "xl"]).optional(),
    align: z.enum(["start", "middle", "end"]).optional(),
    shape: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
    nodeType: nodeType.nullable().optional(),
    nodeMetadata: nodeMetadataInputSchema.nullable().optional(),
    label: z.string().max(10_000).optional(),
    fill: z.string().min(1).max(32).optional(),
    stroke: z.string().min(1).max(32).optional(),
    start: point.extend({ objectId: id.nullable() }).strict().optional(),
    end: point.extend({ objectId: id.nullable() }).strict().optional(),
    direction: z.enum(["none", "end", "both"]).optional(),
    alt: z.string().max(2_000).optional(),
    locked: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one semantic field must be updated.");

const createNodeOperation = z
  .object({
    op: z.literal("create_node"),
    tempRef,
    label: z.string().min(1).max(10_000),
    nodeType,
    nodeMetadata: nodeMetadataInputSchema.optional(),
    ...placement,
  })
  .strict();

const createShapeOperation = z
  .object({
    op: z.literal("create_shape"),
    tempRef,
    label: z.string().max(10_000).default(""),
    shape: z.enum(["rectangle", "ellipse", "diamond"]).default("rectangle"),
    fill: z.string().min(1).max(32).default("blue"),
    stroke: z.string().min(1).max(32).default("blue"),
    ...placement,
  })
  .strict();

const createTextOperation = z
  .object({
    op: z.literal("create_text"),
    tempRef,
    content: z.string().min(1).max(20_000),
    color: z.string().min(1).max(32).default("black"),
    size: z.enum(["s", "m", "l", "xl"]).default("m"),
    align: z.enum(["start", "middle", "end"]).default("start"),
    ...placement,
  })
  .strict();

const connectOperation = z
  .object({
    op: z.literal("connect"),
    tempRef,
    start: endpointReference,
    end: endpointReference,
    direction: z.enum(["none", "end", "both"]).default("end"),
    label: z.string().max(2_000).default(""),
    color: z.string().min(1).max(32).default("black"),
    zIndex: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

const updateOperation = z
  .object({
    op: z.literal("update"),
    objectId: id,
    expectedRevision: z.number().int().positive(),
    leaseId: id.optional(),
    operation: z.enum(["move", "resize", "edit", "connect", "delete", "annotate"]).default("edit"),
    patch: objectPatch,
  })
  .strict();

const createDiagramOperation = z
  .object({
    op: z.literal("create_diagram"),
    tempRef,
    diagramId: id.optional(),
    title: z.string().trim().min(1).max(160),
    description: z.string().max(10_000).default(""),
    diagramType: diagramType.default("architecture"),
    category: z.string().trim().min(1).max(128).nullable().default(null),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
    members: z.array(objectReference).max(500).default([]),
    connectors: z.array(objectReference).max(500).default([]),
  })
  .strict();

const editDiagramOperation = z
  .object({
    op: z.literal("edit_diagram"),
    diagramId: id,
    expectedRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(10_000).optional(),
    diagramType: diagramType.optional(),
    category: z.string().trim().min(1).max(128).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
    members: z.array(objectReference).max(500).optional(),
    connectors: z.array(objectReference).max(500).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => !["op", "diagramId", "expectedRevision"].includes(key)),
    "At least one diagram field must be updated.",
  );

const transactionOperation = z.discriminatedUnion("op", [
  createNodeOperation,
  createShapeOperation,
  createTextOperation,
  connectOperation,
  updateOperation,
  createDiagramOperation,
  editDiagramOperation,
]);

const transactionInput = z
  .object({ operations: z.array(transactionOperation).min(1).max(200), ...activityMetadataFields })
  .strict();

// Zod remains the authoritative execution validator. This equivalent WebMCP
// descriptor uses shared definitions plus conditional required fields instead
// of repeating the full placement and reference schema in every operation.
// Keeping the browser-facing representation compact matters because native
// hosts budget the aggregate descriptors for every tool on the page.
const TRANSACTION_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op"],
        properties: {
          op: {
            enum: [
              "create_node",
              "create_shape",
              "create_text",
              "connect",
              "update",
              "create_diagram",
              "edit_diagram",
            ],
          },
          tempRef: { $ref: "#/$defs/tempRef" },
          objectId: { $ref: "#/$defs/id" },
          expectedRevision: { type: "integer", minimum: 1 },
          leaseId: { $ref: "#/$defs/id" },
          operation: { enum: ["move", "resize", "edit", "connect", "delete", "annotate"] },
          patch: { $ref: "#/$defs/patch" },
          label: { type: "string", maxLength: 10_000 },
          content: { type: "string", minLength: 1, maxLength: 20_000 },
          nodeType: { $ref: "#/$defs/nodeType" },
          nodeMetadata: { $ref: "#/$defs/nodeMetadata" },
          shape: { enum: ["rectangle", "ellipse", "diamond"] },
          fill: { type: "string", minLength: 1, maxLength: 32 },
          stroke: { type: "string", minLength: 1, maxLength: 32 },
          color: { type: "string", minLength: 1, maxLength: 32 },
          size: { enum: ["s", "m", "l", "xl"] },
          align: { enum: ["start", "middle", "end"] },
          start: { $ref: "#/$defs/endpoint" },
          end: { $ref: "#/$defs/endpoint" },
          direction: { enum: ["none", "end", "both"] },
          diagramId: { $ref: "#/$defs/id" },
          title: { type: "string", minLength: 1, maxLength: 160 },
          description: { type: "string", maxLength: 10_000 },
          diagramType: {
            enum: ["architecture", "flow", "hierarchy", "system_context", "process", "custom"],
          },
          category: {
            anyOf: [
              { type: "string", minLength: 1, maxLength: 128 },
              { type: "null" },
            ],
          },
          tags: {
            type: "array",
            maxItems: 32,
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
          members: { type: "array", maxItems: 500, items: { $ref: "#/$defs/objectRef" } },
          connectors: { type: "array", maxItems: 500, items: { $ref: "#/$defs/objectRef" } },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number", exclusiveMinimum: 0, maximum: 100_000 },
          height: { type: "number", exclusiveMinimum: 0, maximum: 100_000 },
          rotation: { type: "number" },
          zIndex: { type: "integer", minimum: 0, maximum: 1_000_000 },
          groupId: {
            anyOf: [{ $ref: "#/$defs/id" }, { type: "null" }],
          },
        },
        allOf: [
          {
            if: { properties: { op: { const: "create_node" } }, required: ["op"] },
            then: { required: ["tempRef", "label", "nodeType"] },
          },
          {
            if: { properties: { op: { const: "create_shape" } }, required: ["op"] },
            then: { required: ["tempRef"] },
          },
          {
            if: { properties: { op: { const: "create_text" } }, required: ["op"] },
            then: { required: ["tempRef", "content"] },
          },
          {
            if: { properties: { op: { const: "connect" } }, required: ["op"] },
            then: { required: ["tempRef", "start", "end"] },
          },
          {
            if: { properties: { op: { const: "update" } }, required: ["op"] },
            then: { required: ["objectId", "expectedRevision", "patch"] },
          },
          {
            if: { properties: { op: { const: "create_diagram" } }, required: ["op"] },
            then: { required: ["tempRef", "title"] },
          },
          {
            if: { properties: { op: { const: "edit_diagram" } }, required: ["op"] },
            then: { required: ["diagramId", "expectedRevision"] },
          },
        ],
      },
    },
    intent: { type: "string", minLength: 1, maxLength: 1_000 },
    summary: { type: "string", minLength: 1, maxLength: 500 },
  },
  $defs: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    tempRef: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
    point: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y"],
      properties: { x: { type: "number" }, y: { type: "number" } },
    },
    objectRef: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["objectId"],
          properties: { objectId: { $ref: "#/$defs/id" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["tempRef"],
          properties: { tempRef: { $ref: "#/$defs/tempRef" } },
        },
      ],
    },
    endpoint: {
      oneOf: [
        { $ref: "#/$defs/objectRef" },
        { $ref: "#/$defs/point" },
      ],
    },
    nodeType: {
      enum: ["service", "component", "requirement", "decision", "open_question"],
    },
    nodeMetadata: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "status"],
      properties: {
        kind: { enum: ["decision", "open_question"] },
        status: {
          enum: [
            "proposed",
            "accepted",
            "rejected",
            "superseded",
            "open",
            "answered",
            "deferred",
            "closed",
          ],
        },
        owner: { type: "string", minLength: 1, maxLength: 160 },
        resolution: { type: "string", minLength: 1, maxLength: 4_000 },
      },
    },
    connectorEndpoint: {
      type: "object",
      additionalProperties: false,
      required: ["objectId", "x", "y"],
      properties: {
        objectId: { anyOf: [{ $ref: "#/$defs/id" }, { type: "null" }] },
        x: { type: "number" },
        y: { type: "number" },
      },
    },
    patch: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number", exclusiveMinimum: 0, maximum: 100_000 },
        height: { type: "number", exclusiveMinimum: 0, maximum: 100_000 },
        rotation: { type: "number" },
        zIndex: { type: "integer", minimum: 0, maximum: 1_000_000 },
        groupId: { anyOf: [{ $ref: "#/$defs/id" }, { type: "null" }] },
        content: { type: "string", maxLength: 20_000 },
        color: { type: "string", minLength: 1, maxLength: 32 },
        size: { enum: ["s", "m", "l", "xl"] },
        align: { enum: ["start", "middle", "end"] },
        shape: { enum: ["rectangle", "ellipse", "diamond"] },
        nodeType: { anyOf: [{ $ref: "#/$defs/nodeType" }, { type: "null" }] },
        nodeMetadata: { anyOf: [{ $ref: "#/$defs/nodeMetadata" }, { type: "null" }] },
        label: { type: "string", maxLength: 10_000 },
        fill: { type: "string", minLength: 1, maxLength: 32 },
        stroke: { type: "string", minLength: 1, maxLength: 32 },
        start: { $ref: "#/$defs/connectorEndpoint" },
        end: { $ref: "#/$defs/connectorEndpoint" },
        direction: { enum: ["none", "end", "both"] },
        alt: { type: "string", maxLength: 2_000 },
        locked: { type: "boolean" },
      },
    },
  },
} as const;

const layoutInput = z
  .object({
    layout: z.enum(["flow", "grid", "hierarchy"]),
    direction: z.enum(["right", "down"]).default("right"),
    targets: z
      .array(
        z
          .object({
            objectId: id,
            expectedRevision: z.number().int().positive(),
            leaseId: id.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    origin: point.optional(),
    primaryGap: finite.min(0).max(10_000).default(160),
    secondaryGap: finite.min(0).max(10_000).default(100),
    columns: z.number().int().min(1).max(50).optional(),
    diagramId: id.optional(),
    expectedDiagramRevision: z.number().int().positive().optional(),
    ...activityMetadataFields,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.diagramId === undefined) !== (value.expectedDiagramRevision === undefined)) {
      context.addIssue({ code: "custom", message: "diagramId and expectedDiagramRevision must be supplied together." });
    }
  });

const relationshipFilter = z
  .object({
    objectId: id,
    direction: z.enum(["incoming", "outgoing", "both"]).default("both"),
    includeConnectors: z.boolean().default(false),
  })
  .strict();

const regionFilter = z
  .object({
    x: finite,
    y: finite,
    width: dimension,
    height: dimension,
    mode: z.enum(["intersects", "contained"]).default("intersects"),
  })
  .strict();

const queryInput = z
  .object({
    text: z.string().trim().min(1).max(500).optional(),
    kinds: z.array(objectKind).min(1).max(5).optional(),
    nodeTypes: z.array(nodeType).min(1).max(5).optional(),
    nodeStatuses: z.array(nodeStatus).min(1).max(8).optional(),
    nodeOwner: z.string().trim().min(1).max(160).optional(),
    groupId: id.nullable().optional(),
    diagramId: id.optional(),
    relationship: relationshipFilter.optional(),
    region: regionFilter.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();

const neighborhoodInput = z
  .object({
    objectIds: z.array(id).min(1).max(50),
    depth: z.number().int().min(1).max(5).default(1),
    direction: z.enum(["incoming", "outgoing", "both"]).default("both"),
    includeDiagramPeers: z.boolean().default(false),
    maxObjects: z.number().int().min(1).max(300).default(120),
  })
  .strict();

const findDiagramsInput = z
  .object({
    text: z.string().trim().min(1).max(500).optional(),
    diagramTypes: z.array(diagramType).min(1).max(6).optional(),
    category: z.string().trim().min(1).max(128).optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
    containsObjectId: id.optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();

const readDiagramInput = z
  .object({
    diagramId: id,
    includeObjects: z.boolean().default(true),
    includeConnectors: z.boolean().default(true),
  })
  .strict();

const describeDiagramInput = z.object({ diagramId: id }).strict();

const createDiagramInput = createDiagramOperation.omit({ op: true, tempRef: true }).extend({
  memberObjectIds: z.array(id).max(500).default([]),
  connectorIds: z.array(id).max(500).default([]),
  ...activityMetadataFields,
}).omit({ members: true, connectors: true }).strict();

const editDiagramInput = z
  .object({
    diagramId: id,
    expectedRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(10_000).optional(),
    diagramType: diagramType.optional(),
    category: z.string().trim().min(1).max(128).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
    memberObjectIds: z.array(id).max(500).optional(),
    connectorIds: z.array(id).max(500).optional(),
    ...activityMetadataFields,
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => !["diagramId", "expectedRevision"].includes(key)),
    "At least one diagram field must be updated.",
  );

type SemanticResponse = {
  ok: true;
  room: RoomState;
  changedObjectIds: string[];
  changedDiagramIds: string[];
  membershipObjectIds: string[];
  positions?: Array<{ objectId: string; x: number; y: number }>;
  outcome: "applied" | "proposed";
  activity: RoomActivitySummary | null;
  proposal: AgentEditProposalSummary | null;
};

type RoomResponse = { ok: true; room: RoomState };

export type JazzboardSemanticWebMcpDependencies = {
  request?: WebMcpRequest;
  createId?: (prefix: string) => string;
};

class SemanticToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SemanticToolError";
  }
}

function defaultCreateId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${suffix}`;
}

function toolFailure(tool: string, error: unknown): JazzboardToolFailure {
  if (error instanceof JazzboardApiError) return { ok: false, tool, error: error.failure };
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "The tool input does not match Jazzboard's semantic schema.",
        details: { issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
      },
    };
  }
  if (error instanceof SemanticToolError) {
    return { ok: false, tool, error: { code: error.code, message: error.message, details: error.details } };
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return { ok: false, tool, error: { code: "TOOL_ABORTED", message: "The WebMCP tool call was cancelled." } };
  }
  return {
    ok: false,
    tool,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: error instanceof Error ? error.message : "Jazzboard could not execute this semantic tool.",
    },
  };
}

function defineTool<TSchema extends z.ZodType>(input: {
  name: string;
  title: string;
  description: string;
  schema: TSchema;
  inputSchema?: WebMCP.ModelContextTool["inputSchema"];
  annotations?: WebMCP.ToolAnnotations;
  execute: (value: z.output<TSchema>, signal: AbortSignal) => Promise<unknown>;
}): WebMCP.ModelContextTool {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    // WebMCP describes caller input. Zod's default output-mode schema marks
    // fields with defaults as required even though callers may omit them.
    inputSchema:
      input.inputSchema ??
      (z.toJSONSchema(input.schema, {
        io: "input",
        reused: "ref",
      }) as WebMCP.ModelContextTool["inputSchema"]),
    annotations: input.annotations,
    async execute(rawInput, options): Promise<JazzboardToolResult> {
      try {
        const parsed = input.schema.parse(rawInput);
        const signal = options?.signal ?? new AbortController().signal;
        return { ok: true, tool: input.name, data: await input.execute(parsed, signal) };
      } catch (error) {
        return toolFailure(input.name, error);
      }
    },
  };
}

function roomUrl(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}`;
}

function semanticUrl(roomId: string): string {
  return `${roomUrl(roomId)}/agent/semantic`;
}

function post<T>(request: WebMcpRequest, url: string, body: unknown, signal: AbortSignal): Promise<T> {
  return request<T>(url, { method: "POST", body: JSON.stringify(body), signal });
}

function objectText(object: CanvasObject): string {
  if (object.kind === "text") return object.content;
  if (object.kind === "shape") return object.label;
  if (object.kind === "connector") return object.label;
  if (object.kind === "image") return `${object.alt} ${object.sourceUrl ?? ""}`;
  return "";
}

function intersects(
  object: CanvasObject,
  region: z.output<typeof regionFilter>,
): boolean {
  if (region.mode === "contained") {
    return (
      object.x >= region.x &&
      object.y >= region.y &&
      object.x + object.width <= region.x + region.width &&
      object.y + object.height <= region.y + region.height
    );
  }
  return !(
    object.x + object.width < region.x ||
    object.y + object.height < region.y ||
    object.x > region.x + region.width ||
    object.y > region.y + region.height
  );
}

function relationshipIds(room: RoomState, filter: z.output<typeof relationshipFilter>): Set<string> {
  const result = new Set<string>();
  for (const connector of Object.values(room.objects)) {
    if (connector.kind !== "connector") continue;
    const incoming = connector.end.objectId === filter.objectId;
    const outgoing = connector.start.objectId === filter.objectId;
    if ((filter.direction === "incoming" || filter.direction === "both") && incoming) {
      if (connector.start.objectId) result.add(connector.start.objectId);
      if (filter.includeConnectors) result.add(connector.id);
    }
    if ((filter.direction === "outgoing" || filter.direction === "both") && outgoing) {
      if (connector.end.objectId) result.add(connector.end.objectId);
      if (filter.includeConnectors) result.add(connector.id);
    }
  }
  return result;
}

function diagramOrThrow(room: RoomState, diagramId: string) {
  const diagram = room.diagrams?.[diagramId];
  if (!diagram) throw new SemanticToolError("DIAGRAM_NOT_FOUND", `Diagram ${diagramId} is not in this room.`, { diagramId });
  return diagram;
}

function nextZIndex(room: RoomState | null): number {
  return room ? Math.max(-1, ...Object.values(room.objects).map((object) => object.zIndex)) + 1 : 0;
}

function batchPosition(
  input: { x?: number; y?: number; width?: number; height?: number },
  viewport: Viewport | null,
  index: number,
  defaults: { width: number; height: number },
) {
  const width = input.width ?? defaults.width;
  const height = input.height ?? defaults.height;
  const originX = viewport ? viewport.x + 80 : 0;
  const originY = viewport ? viewport.y + 80 : 0;
  return {
    x: input.x ?? originX + (index % 4) * 360,
    y: input.y ?? originY + Math.floor(index / 4) * 240,
    width,
    height,
  };
}

function palette(type: DiagramNodeType) {
  return {
    component: { fill: "blue", stroke: "blue" },
    service: { fill: "green", stroke: "green" },
    requirement: { fill: "yellow", stroke: "orange" },
    decision: { fill: "violet", stroke: "violet" },
    open_question: { fill: "light-red", stroke: "red" },
  }[type];
}

export const JAZZBOARD_SEMANTIC_READ_TOOL_NAMES = [
  "query_objects",
  "read_neighborhood",
  "find_diagrams",
  "read_diagram",
  "describe_diagram",
] as const;

export const JAZZBOARD_SEMANTIC_MUTATION_TOOL_NAMES = [
  "apply_canvas_transaction",
  "layout_objects",
  "create_diagram",
  "edit_diagram",
] as const;

export const JAZZBOARD_SEMANTIC_TOOL_NAMES = [
  ...JAZZBOARD_SEMANTIC_READ_TOOL_NAMES,
  ...JAZZBOARD_SEMANTIC_MUTATION_TOOL_NAMES,
] as const;

export function createJazzboardSemanticWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies: JazzboardSemanticWebMcpDependencies = {},
): WebMCP.ModelContextTool[] {
  const request = dependencies.request ?? (apiRequest as WebMcpRequest);
  const createId = dependencies.createId ?? defaultCreateId;

  async function readRoom(signal: AbortSignal): Promise<RoomState> {
    const response = await request<RoomResponse>(roomUrl(binding.roomId), { method: "GET", signal });
    binding.context.acceptRoom(response.room);
    return response.room;
  }

  async function mutate(body: unknown, signal: AbortSignal) {
    const response = await post<SemanticResponse>(request, semanticUrl(binding.roomId), body, signal);
    binding.context.acceptRoom(response.room);
    return response;
  }

  const readAnnotations: WebMCP.ToolAnnotations = { readOnlyHint: true, untrustedContentHint: true };
  const reads: WebMCP.ModelContextTool[] = [
    defineTool({
      name: "query_objects",
      title: "Query semantic canvas objects",
      description:
        "Find a bounded subset of authoritative canvas objects by content, kind, explicit node classification, group, diagram, relationship, or canvas-world region without returning unrelated room content.",
      schema: queryInput,
      annotations: readAnnotations,
      async execute(input, signal) {
        const room = await readRoom(signal);
        const related = input.relationship ? relationshipIds(room, input.relationship) : null;
        const query = input.text?.toLocaleLowerCase();
        const matches = Object.values(room.objects)
          .filter((object) => !query || objectText(object).toLocaleLowerCase().includes(query))
          .filter((object) => !input.kinds || input.kinds.includes(object.kind))
          .filter(
            (object) =>
              !input.nodeTypes || (object.kind === "shape" && object.nodeType !== null && input.nodeTypes.includes(object.nodeType)),
          )
          .filter(
            (object) =>
              !input.nodeStatuses ||
              (object.kind === "shape" &&
                object.nodeMetadata !== null &&
                object.nodeMetadata !== undefined &&
                input.nodeStatuses.includes(object.nodeMetadata.status)),
          )
          .filter(
            (object) =>
              !input.nodeOwner ||
              (object.kind === "shape" &&
                object.nodeMetadata?.owner?.toLocaleLowerCase().includes(input.nodeOwner.toLocaleLowerCase())),
          )
          .filter((object) => input.groupId === undefined || object.groupId === input.groupId)
          .filter((object) => !input.diagramId || object.diagramIds.includes(input.diagramId))
          .filter((object) => !related || related.has(object.id))
          .filter((object) => !input.region || intersects(object, input.region))
          .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
        return {
          roomRevision: room.roomRevision,
          totalMatched: matches.length,
          truncated: matches.length > input.limit,
          objects: matches.slice(0, input.limit),
        };
      },
    }),
    defineTool({
      name: "read_neighborhood",
      title: "Read an object relationship neighborhood",
      description:
        "Read a bounded semantic subgraph around exact object IDs, traversing authoritative connector relationships for a limited number of hops and optionally adding peers from the same first-class Diagram containers.",
      schema: neighborhoodInput,
      annotations: readAnnotations,
      async execute(input, signal) {
        const room = await readRoom(signal);
        const missingObjectIds = input.objectIds.filter((objectId) => !room.objects[objectId]);
        const visited = new Set(input.objectIds.filter((objectId) => room.objects[objectId]));
        const connectorIds = new Set<string>();
        let frontier = [...visited];
        let depthReached = 0;
        let truncated = false;
        for (let depth = 0; depth < input.depth && frontier.length; depth += 1) {
          const next = new Set<string>();
          for (const current of frontier) {
            const currentObject = room.objects[current];
            if (currentObject?.kind === "connector") {
              connectorIds.add(current);
              for (const endpointId of [currentObject.start.objectId, currentObject.end.objectId]) {
                if (endpointId && !visited.has(endpointId)) next.add(endpointId);
              }
              continue;
            }
            for (const connector of Object.values(room.objects)) {
              if (connector.kind !== "connector") continue;
              const incoming = connector.end.objectId === current;
              const outgoing = connector.start.objectId === current;
              if ((input.direction === "incoming" || input.direction === "both") && incoming) {
                connectorIds.add(connector.id);
                if (connector.start.objectId && !visited.has(connector.start.objectId)) next.add(connector.start.objectId);
              }
              if ((input.direction === "outgoing" || input.direction === "both") && outgoing) {
                connectorIds.add(connector.id);
                if (connector.end.objectId && !visited.has(connector.end.objectId)) next.add(connector.end.objectId);
              }
            }
          }
          for (const objectId of next) visited.add(objectId);
          frontier = [...next];
          depthReached = depth + 1;
          if (visited.size + connectorIds.size >= input.maxObjects) {
            truncated = true;
            break;
          }
        }
        if (input.includeDiagramPeers) {
          const diagramIds = new Set([...visited].flatMap((objectId) => room.objects[objectId]?.diagramIds ?? []));
          for (const diagramId of diagramIds) {
            const diagram = room.diagrams?.[diagramId];
            if (!diagram) continue;
            for (const objectId of diagram.memberObjectIds) visited.add(objectId);
            for (const connectorId of diagram.connectorIds) connectorIds.add(connectorId);
          }
        }
        const combinedIds = uniqueStrings([...visited, ...connectorIds]);
        if (combinedIds.length > input.maxObjects) truncated = true;
        const limitedIds = combinedIds.slice(0, input.maxObjects);
        const limitedSet = new Set(limitedIds);
        const objects = limitedIds.flatMap((objectId) => {
          const object = room.objects[objectId];
          return object && object.kind !== "connector" ? [object] : [];
        });
        const connectors = limitedIds.flatMap((objectId) => {
          const object = room.objects[objectId];
          return object?.kind === "connector" ? [object] : [];
        });
        const diagramIds = new Set(limitedIds.flatMap((objectId) => room.objects[objectId]?.diagramIds ?? []));
        return {
          roomRevision: room.roomRevision,
          rootObjectIds: input.objectIds,
          missingObjectIds,
          depthReached,
          truncated,
          objects,
          connectors,
          diagrams: [...diagramIds].flatMap((diagramId) => room.diagrams?.[diagramId] ?? []),
          boundaryObjectIds: frontier.filter((objectId) => limitedSet.has(objectId)),
        };
      },
    }),
    defineTool({
      name: "find_diagrams",
      title: "Find first-class diagrams",
      description:
        "Find authoritative Diagram containers by title, description, explicit type, category, tags, or member object ID. Results contain metadata and bounds, not unrelated canvas objects.",
      schema: findDiagramsInput,
      annotations: readAnnotations,
      async execute(input, signal) {
        const room = await readRoom(signal);
        const query = input.text?.toLocaleLowerCase();
        const diagrams = Object.values(room.diagrams ?? {})
          .filter(
            (diagram) =>
              !query || `${diagram.title}\n${diagram.description}`.toLocaleLowerCase().includes(query),
          )
          .filter((diagram) => !input.diagramTypes || input.diagramTypes.includes(diagram.diagramType))
          .filter((diagram) => !input.category || diagram.category?.toLocaleLowerCase() === input.category.toLocaleLowerCase())
          .filter((diagram) => !input.tags || input.tags.every((tag) => diagram.tags.includes(tag)))
          .filter(
            (diagram) =>
              !input.containsObjectId ||
              diagram.memberObjectIds.includes(input.containsObjectId) ||
              diagram.connectorIds.includes(input.containsObjectId),
          )
          .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
        return {
          roomRevision: room.roomRevision,
          totalMatched: diagrams.length,
          truncated: diagrams.length > input.limit,
          diagrams: diagrams.slice(0, input.limit),
        };
      },
    }),
    defineTool({
      name: "read_diagram",
      title: "Read a diagram by semantic ID",
      description:
        "Read one authoritative Diagram record by stable ID and optionally include exactly its member objects and semantic connectors with current revisions and server-computed bounds.",
      schema: readDiagramInput,
      annotations: readAnnotations,
      async execute(input, signal) {
        const room = await readRoom(signal);
        const diagram = diagramOrThrow(room, input.diagramId);
        return {
          roomRevision: room.roomRevision,
          diagram,
          objects: input.includeObjects ? diagram.memberObjectIds.flatMap((objectId) => room.objects[objectId] ?? []) : [],
          connectors: input.includeConnectors ? diagram.connectorIds.flatMap((objectId) => room.objects[objectId] ?? []) : [],
        };
      },
    }),
    defineTool({
      name: "describe_diagram",
      title: "Describe a diagram's semantic structure",
      description:
        "Return a compact structural description of one Diagram: classified node counts, member summaries, relationship endpoints, metadata, bounds, and current revisions.",
      schema: describeDiagramInput,
      annotations: readAnnotations,
      async execute(input, signal) {
        const room = await readRoom(signal);
        const diagram = diagramOrThrow(room, input.diagramId);
        const members = diagram.memberObjectIds.flatMap((objectId) => room.objects[objectId] ?? []);
        const connectors = diagram.connectorIds.flatMap((objectId) => room.objects[objectId] ?? []).filter(
          (object): object is Extract<CanvasObject, { kind: "connector" }> => object.kind === "connector",
        );
        const nodeTypeCounts = Object.fromEntries(
          (["service", "component", "requirement", "decision", "open_question"] as const).map((type) => [
            type,
            members.filter((object) => object.kind === "shape" && object.nodeType === type).length,
          ]),
        );
        const nodeStatusCounts = Object.fromEntries(
          nodeStatus.options.map((status) => [
            status,
            members.filter((object) => object.kind === "shape" && object.nodeMetadata?.status === status).length,
          ]),
        );
        return {
          roomRevision: room.roomRevision,
          diagram,
          counts: {
            members: members.length,
            connectors: connectors.length,
            nodeTypes: nodeTypeCounts,
            nodeStatuses: nodeStatusCounts,
          },
          members: members.map((object) => ({
            id: object.id,
            kind: object.kind,
            nodeType: object.kind === "shape" ? object.nodeType : null,
            nodeMetadata: object.kind === "shape" ? object.nodeMetadata ?? null : null,
            label: objectText(object),
            revision: object.revision,
            bounds: { x: object.x, y: object.y, width: object.width, height: object.height },
          })),
          relationships: connectors.map((connector) => ({
            connectorId: connector.id,
            label: connector.label,
            direction: connector.direction,
            startObjectId: connector.start.objectId,
            endObjectId: connector.end.objectId,
            revision: connector.revision,
          })),
        };
      },
    }),
  ];

  if (binding.role !== "participant") return reads;

  const mutations: WebMCP.ModelContextTool[] = [
    defineTool({
      name: "apply_canvas_transaction",
      title: "Apply an atomic semantic canvas transaction",
      description:
        "Create multiple classified nodes, shapes, text objects, connectors, and Diagram containers plus revision-checked updates in one all-or-nothing operation. Request-local temporary references let connectors and diagrams target objects created in the same call.",
      schema: transactionInput,
      inputSchema: TRANSACTION_TOOL_INPUT_SCHEMA,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const currentRoom = binding.context.getRoom();
        const refs = new Map<string, string>();
        for (const operation of input.operations) {
          if (!("tempRef" in operation)) continue;
          if (refs.has(operation.tempRef)) {
            throw new SemanticToolError("DUPLICATE_TEMP_REF", `Temporary reference ${operation.tempRef} is duplicated.`, {
              tempRef: operation.tempRef,
            });
          }
          const prefix = {
            create_node: "node",
            create_shape: "shape",
            create_text: "text",
            connect: "connector",
            create_diagram: "diagram",
          }[operation.op];
          const value = operation.op === "create_diagram" && operation.diagramId
            ? operation.diagramId
            : createId(prefix);
          if ([...refs.values()].includes(value) || currentRoom?.objects[value] || currentRoom?.diagrams?.[value]) {
            throw new SemanticToolError(
              "DUPLICATE_SEMANTIC_ID",
              `Semantic ID ${value} already belongs to an object, Diagram, or temporary reference in this request.`,
              { id: value },
            );
          }
          refs.set(operation.tempRef, value);
        }

        const geometry = new Map<string, { id: string; kind: ObjectKind; x: number; y: number; width: number; height: number }>();
        for (const object of Object.values(currentRoom?.objects ?? {})) geometry.set(object.id, object);
        const commands: CanvasCommand[] = [];
        const diagramCommands: DiagramCommand[] = [];
        const deferredConnections: z.output<typeof connectOperation>[] = [];
        const deferredUpdates: z.output<typeof updateOperation>[] = [];
        const deferredDiagrams: Array<z.output<typeof createDiagramOperation> | z.output<typeof editDiagramOperation>> = [];
        let createIndex = 0;
        let zIndex = nextZIndex(currentRoom);

        const idFor = (reference: z.output<typeof objectReference>): string => {
          if ("objectId" in reference) return reference.objectId;
          const resolved = refs.get(reference.tempRef);
          if (!resolved) {
            throw new SemanticToolError("UNRESOLVED_TEMP_REF", `Temporary reference ${reference.tempRef} is not defined in this request.`, {
              tempRef: reference.tempRef,
            });
          }
          return resolved;
        };

        for (const operation of input.operations) {
          if (operation.op === "connect") {
            deferredConnections.push(operation);
            continue;
          }
          if (operation.op === "update") {
            deferredUpdates.push(operation);
            continue;
          }
          if (operation.op === "create_diagram" || operation.op === "edit_diagram") {
            deferredDiagrams.push(operation);
            continue;
          }
          const objectId = refs.get(operation.tempRef)!;
          const defaults = operation.op === "create_text" ? { width: 320, height: 96 } : { width: 280, height: 152 };
          const position = batchPosition(operation, binding.context.getViewport(), createIndex, defaults);
          const common = {
            id: objectId,
            ...position,
            rotation: operation.rotation ?? 0,
            zIndex: operation.zIndex ?? zIndex++,
            groupId: operation.groupId ?? null,
          };
          let object: CreateCanvasObject;
          if (operation.op === "create_node") {
            object = {
              ...common,
              kind: "shape",
              shape: "rectangle",
              nodeType: operation.nodeType,
              nodeMetadata: operation.nodeMetadata,
              label: operation.label,
              ...palette(operation.nodeType),
            };
          } else if (operation.op === "create_shape") {
            object = {
              ...common,
              kind: "shape",
              shape: operation.shape,
              nodeType: null,
              label: operation.label,
              fill: operation.fill,
              stroke: operation.stroke,
            };
          } else {
            object = {
              ...common,
              kind: "text",
              content: operation.content,
              color: operation.color,
              size: operation.size,
              align: operation.align,
            };
          }
          commands.push({ type: "create", object });
          geometry.set(objectId, { ...position, id: objectId, kind: object.kind });
          createIndex += 1;
        }

        const endpointFor = (reference: z.output<typeof endpointReference>) => {
          if ("x" in reference) return { ...reference, objectId: null };
          const objectId = idFor(reference);
          const target = geometry.get(objectId);
          if (!target) {
            throw new SemanticToolError("OBJECT_NOT_FOUND", `Connector target ${objectId} is not in the current room or this request.`, {
              objectId,
            });
          }
          if (target.kind === "connector") {
            throw new SemanticToolError("INVALID_OPERATION", "Connectors cannot target another connector.", { objectId });
          }
          return { objectId, x: target.x + target.width / 2, y: target.y + target.height / 2 };
        };

        for (const operation of deferredConnections) {
          const objectId = refs.get(operation.tempRef)!;
          const start = endpointFor(operation.start);
          const end = endpointFor(operation.end);
          const object: CreateCanvasObject = {
            id: objectId,
            kind: "connector",
            x: Math.min(start.x, end.x),
            y: Math.min(start.y, end.y),
            width: Math.max(Math.abs(end.x - start.x), 1),
            height: Math.max(Math.abs(end.y - start.y), 1),
            rotation: 0,
            zIndex: operation.zIndex ?? zIndex++,
            groupId: null,
            start,
            end,
            direction: operation.direction,
            label: operation.label,
            color: operation.color,
          };
          commands.push({ type: "create", object });
          geometry.set(objectId, { id: objectId, kind: "connector", x: object.x, y: object.y, width: object.width, height: object.height });
        }
        for (const operation of deferredUpdates) {
          commands.push({
            type: "update",
            objectId: operation.objectId,
            expectedRevision: operation.expectedRevision,
            leaseId: operation.leaseId,
            operation: operation.operation,
            patch: operation.patch as ObjectPatch,
          });
        }
        for (const operation of deferredDiagrams) {
          if (operation.op === "create_diagram") {
            diagramCommands.push({
              type: "diagram.create",
              diagram: {
                id: refs.get(operation.tempRef)!,
                title: operation.title,
                description: operation.description,
                diagramType: operation.diagramType,
                category: operation.category,
                tags: operation.tags,
                memberObjectIds: operation.members.map(idFor),
                connectorIds: operation.connectors.map(idFor),
              },
            });
          } else {
            const patch: Record<string, unknown> = {};
            for (const field of ["title", "description", "diagramType", "category", "tags"] as const) {
              if (operation[field] !== undefined) patch[field] = operation[field];
            }
            if (operation.members !== undefined) patch.memberObjectIds = operation.members.map(idFor);
            if (operation.connectors !== undefined) patch.connectorIds = operation.connectors.map(idFor);
            diagramCommands.push({
              type: "diagram.update",
              diagramId: operation.diagramId,
              expectedRevision: operation.expectedRevision,
              patch,
            });
          }
        }
        const response = await mutate(
          {
            action: "transaction",
            transaction: { commands, diagramCommands },
            metadata: activityMetadata(input),
          },
          signal,
        );
        return {
          outcome: response.outcome,
          roomRevision: response.room.roomRevision,
          temporaryReferences: Object.fromEntries(refs),
          changedObjectIds: response.changedObjectIds,
          changedDiagramIds: response.changedDiagramIds,
          membershipObjectIds: response.membershipObjectIds,
          objects: response.changedObjectIds.flatMap((objectId) => response.room.objects[objectId] ?? []),
          diagrams: response.changedDiagramIds.flatMap((diagramId) => response.room.diagrams?.[diagramId] ?? []),
          activity: response.activity,
          proposal: response.proposal,
        };
      },
    }),
    defineTool({
      name: "layout_objects",
      title: "Arrange semantic objects deterministically",
      description:
        "Atomically arrange revision-checked objects as a flow, grid, or connector-derived acyclic hierarchy. Active leases are honored, bound connector geometry is recomputed, and affected Diagram bounds and revisions stay authoritative.",
      schema: layoutInput,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const layout = stripActivityMetadata(input);
        const response = await mutate(
          { action: "layout", layout, metadata: activityMetadata(input) },
          signal,
        );
        return {
          outcome: response.outcome,
          roomRevision: response.room.roomRevision,
          positions: response.positions,
          changedObjectIds: response.changedObjectIds,
          changedDiagramIds: response.changedDiagramIds,
          objects: response.changedObjectIds.flatMap((objectId) => response.room.objects[objectId] ?? []),
          diagrams: response.changedDiagramIds.flatMap((diagramId) => response.room.diagrams?.[diagramId] ?? []),
          activity: response.activity,
          proposal: response.proposal,
        };
      },
    }),
    defineTool({
      name: "create_diagram",
      title: "Create a first-class semantic diagram",
      description:
        "Create an authoritative Diagram container with a stable ID, title, description, explicit type and category, tags, member object IDs, connector IDs, computed bounds, revision, and agent attribution.",
      schema: createDiagramInput,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const { diagramId: requestedDiagramId, ...diagramInput } = stripActivityMetadata(input);
        const diagramId = requestedDiagramId ?? createId("diagram");
        const currentRoom = binding.context.getRoom();
        if (currentRoom?.objects[diagramId] || currentRoom?.diagrams[diagramId]) {
          throw new SemanticToolError(
            "DUPLICATE_SEMANTIC_ID",
            `Semantic ID ${diagramId} already belongs to an object or Diagram in this room.`,
            { id: diagramId },
          );
        }
        const response = await mutate(
          {
            action: "transaction",
            transaction: {
              commands: [],
              diagramCommands: [{ type: "diagram.create", diagram: { id: diagramId, ...diagramInput } }],
            },
            metadata: activityMetadata(input),
          },
          signal,
        );
        return {
          outcome: response.outcome,
          roomRevision: response.room.roomRevision,
          diagram: response.room.diagrams?.[diagramId] ?? null,
          activity: response.activity,
          proposal: response.proposal,
        };
      },
    }),
    defineTool({
      name: "edit_diagram",
      title: "Edit a diagram by semantic ID and revision",
      description:
        "Revision-check and atomically edit one Diagram's metadata, tags, members, or connectors. Server validation maintains reverse memberships and recomputes bounds; stale revisions fail without partial changes.",
      schema: editDiagramInput,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const { diagramId, expectedRevision, ...patch } = stripActivityMetadata(input);
        const response = await mutate(
          {
            action: "transaction",
            transaction: {
              commands: [],
              diagramCommands: [{ type: "diagram.update", diagramId, expectedRevision, patch }],
            },
            metadata: activityMetadata(input),
          },
          signal,
        );
        return {
          outcome: response.outcome,
          roomRevision: response.room.roomRevision,
          diagram: response.room.diagrams?.[diagramId] ?? null,
          activity: response.activity,
          proposal: response.proposal,
        };
      },
    }),
  ];

  return [
    ...reads,
    ...mutations.map((tool) => ({ ...tool, description: `${tool.description}${REVIEW_MODE_RESULT_NOTE}` })),
  ];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
