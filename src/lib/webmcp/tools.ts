/// <reference types="webmcp-types" />

import { z } from "zod";

import { parseRoomAssetProxyReference } from "@/lib/assets/policy";
import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import {
  cardinalNormalizedAnchor,
  normalizeConnectorRouting,
} from "@/lib/domain/connector-routing";
import {
  connectorRoutingInputSchema,
  nodeMetadataInputSchema,
  SEMANTIC_COLOR_NAMES,
  semanticColorSchema,
  semanticNameSchema,
  semanticPaintSchema,
  semanticRoleSchema,
} from "@/lib/domain/schemas";
import {
  normalizeWorldDrawing,
  normalizeWorldVectorPath,
  polygonWorldVectorPath,
  VECTOR_PATH_LIMITS,
} from "@/lib/domain/vector-path";
import type {
  AgentEditProposalSummary,
  CanvasCommand,
  CanvasObject,
  ConnectorEndpoint,
  ObjectPatch,
  RoomActivitySummary,
  RoomPresenceDelta,
  RoomState,
  Viewport,
} from "@/lib/domain/types";
import { applyPresenceDelta, roomStateRevision } from "@/lib/realtime/events";

import type {
  JazzboardToolFailure,
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpDependencies,
  WebMcpRequest,
} from "./types";
import { withActionableRecovery } from "./actionable-failure";
import { CONNECTOR_ROUTING_INPUT_JSON_SCHEMA } from "./routing-schema";

const idSchema = z.string().min(1).max(128);
const finite = z.number().finite();
const positiveDimension = finite.positive().max(100_000);
const colorSchema = semanticColorSchema;
const pointSchema = z.object({ x: finite, y: finite }).strict();
const normalizedAnchorSchema = z
  .object({ x: finite.min(0).max(1), y: finite.min(0).max(1) })
  .strict();
const normalizedPathPointSchema = z.object({
  x: finite.min(0).max(1),
  y: finite.min(0).max(1),
}).strict();
const normalizedVectorPathSegmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), to: normalizedPathPointSchema }).strict(),
  z.object({ kind: z.literal("quadratic"), control: normalizedPathPointSchema, to: normalizedPathPointSchema }).strict(),
  z.object({ kind: z.literal("cubic"), control1: normalizedPathPointSchema, control2: normalizedPathPointSchema, to: normalizedPathPointSchema }).strict(),
]);
const agentImageUrlSchema = z
  .string()
  .max(8_192)
  .refine((value) => {
    if (value.startsWith("/") && parseRoomAssetProxyReference(value)) return true;
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Use an accessible HTTPS URL or an authorized Jazzboard room asset reference.");
const AGENT_IMAGE_URL_SCHEMA = {
  anyOf: [
    { type: "string", pattern: "^https://", maxLength: 8_192 },
    {
      type: "string",
      pattern: "^/api/rooms/[^/]+/assets\\?(pathname|assetId)=",
      maxLength: 8_192,
    },
  ],
} as const;
const WORLD_POINT_JSON_SCHEMA = {
  type: "object",
  description: "Canvas-world {x,y}.",
} as const;
const PATH_SEGMENT_JSON_SCHEMA = {
  type: "object",
  description: "World {kind,to}; curves add control or control1/control2.",
} as const;
const NORMALIZED_PATH_SEGMENT_JSON_SCHEMA = {
  type: "object",
  description: "Normalized 0..1 {kind,to}; curves add controls.",
} as const;
const COLOR_JSON_SCHEMA = {
  type: "string",
  pattern: `^(?:${SEMANTIC_COLOR_NAMES.join("|")}|#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{2})?)?)$`,
} as const;
const PAINT_JSON_SCHEMA = {
  type: "string",
  pattern: `^(?:none|${SEMANTIC_COLOR_NAMES.join("|")}|#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{2})?)?)$`,
} as const;
const PAINT_FROM_COLOR_JSON_SCHEMA = {
  anyOf: [{ $ref: "#/$defs/color" }, { const: "none" }],
} as const;
const REVIEW_MODE_RESULT_NOTE =
  " Review outcome `proposed` is not applied.";
const REVIEW_GATED_TOOL_NAMES = new Set([
  "create_text",
  "create_shape",
  "create_node",
  "add_image",
  "create_drawing",
  "create_path",
  "create_polygon",
  "draw_connection",
  "update_object",
  "move_objects",
  "group_objects",
  "delete_objects",
]);

const targetSchema = z
  .object({
    objectId: idSchema,
    expectedRevision: z.number().int().positive(),
    leaseId: idSchema.optional(),
  })
  .strict();

const placementFields = {
  x: finite.optional(),
  y: finite.optional(),
  width: positiveDimension.optional(),
  height: positiveDimension.optional(),
  rotation: finite.optional(),
  zIndex: z.number().int().min(0).max(1_000_000).optional(),
  groupId: idSchema.nullable().optional(),
};

const semanticIdentityFields = {
  semanticName: semanticNameSchema.optional(),
  semanticRole: semanticRoleSchema.optional(),
};

function semanticIdentity(input: { semanticName?: string; semanticRole?: string }) {
  return {
    ...(input.semanticName !== undefined ? { semanticName: input.semanticName } : {}),
    ...(input.semanticRole !== undefined ? { semanticRole: input.semanticRole } : {}),
  };
}

const activityMetadataFields = {
  intent: z.string().trim().min(1).max(1_000).optional(),
  summary: z.string().trim().min(1).max(500).optional(),
};

function activityMetadata(input: { intent?: string; summary?: string }) {
  return input.intent || input.summary ? { intent: input.intent, summary: input.summary } : undefined;
}

const createTextInputSchema = z
  .object({
    content: z.string().min(1).max(20_000),
    ...semanticIdentityFields,
    ...activityMetadataFields,
    ...placementFields,
    color: colorSchema.optional(),
    size: z.enum(["s", "m", "l", "xl"]).optional(),
    align: z.enum(["start", "middle", "end"]).optional(),
  })
  .strict();

const createShapeInputSchema = z
  .object({
    label: z.string().max(10_000).optional(),
    ...semanticIdentityFields,
    ...activityMetadataFields,
    shape: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
    ...placementFields,
    fill: semanticPaintSchema.optional(),
    stroke: semanticPaintSchema.optional(),
  })
  .strict();

const createNodeInputSchema = z
  .object({
    label: z.string().min(1).max(10_000),
    ...semanticIdentityFields,
    ...activityMetadataFields,
    nodeType: z.enum(["component", "service", "requirement", "decision", "open_question"]).optional(),
    nodeMetadata: nodeMetadataInputSchema.optional(),
    ...placementFields,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.nodeType && input.nodeMetadata && input.nodeType !== input.nodeMetadata.kind) {
      context.addIssue({ code: "custom", path: ["nodeMetadata"], message: "Node metadata kind must match nodeType." });
    }
    const type = input.nodeType ?? input.nodeMetadata?.kind;
    if (input.nodeMetadata && type !== "decision" && type !== "open_question") {
      context.addIssue({ code: "custom", path: ["nodeMetadata"], message: "Lifecycle metadata requires a decision or open_question node." });
    }
  });

const addImageInputSchema = z
  .object({
    url: agentImageUrlSchema,
    ...semanticIdentityFields,
    alt: z.string().max(2_000).optional(),
    mimeType: z.string().min(1).max(128).optional(),
    locked: z.boolean().optional(),
    ...activityMetadataFields,
    ...placementFields,
  })
  .strict();

const drawingPointSchema = z
  .object({
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
  })
  .strict();

const createDrawingInputSchema = z
  .object({
    points: z.array(drawingPointSchema).min(2).max(2_000),
    ...semanticIdentityFields,
    ...activityMetadataFields,
    color: colorSchema.optional(),
    size: z.enum(["s", "m", "l"]).optional(),
    rotation: finite.optional(),
    zIndex: z.number().int().min(0).max(1_000_000).optional(),
    groupId: idSchema.nullable().optional(),
  })
  .strict();

const vectorPathSegmentInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), to: drawingPointSchema }).strict(),
  z.object({ kind: z.literal("quadratic"), control: drawingPointSchema, to: drawingPointSchema }).strict(),
  z.object({
    kind: z.literal("cubic"),
    control1: drawingPointSchema,
    control2: drawingPointSchema,
    to: drawingPointSchema,
  }).strict(),
]);

const vectorPathStyleInputFields = {
  fill: semanticPaintSchema.optional(),
  stroke: semanticPaintSchema.optional(),
  strokeWidth: finite.min(0).max(VECTOR_PATH_LIMITS.maxStrokeWidth).optional(),
  opacity: finite.min(0).max(1).optional(),
  lineCap: z.enum(["butt", "round", "square"]).optional(),
  lineJoin: z.enum(["miter", "round", "bevel"]).optional(),
  fillRule: z.enum(["nonzero", "evenodd"]).optional(),
  rotation: finite.optional(),
  zIndex: z.number().int().min(0).max(1_000_000).optional(),
  groupId: idSchema.nullable().optional(),
};

function refineVisiblePathStyle(
  value: { fill?: string; stroke?: string; strokeWidth?: number },
  context: z.RefinementCtx,
) {
  const fill = value.fill ?? "none";
  const stroke = value.stroke ?? "black";
  const strokeWidth = value.strokeWidth ?? 3.5;
  if (fill.trim().toLowerCase() === "none" && stroke.trim().toLowerCase() === "none") {
    context.addIssue({ code: "custom", path: ["stroke"], message: "A path requires a visible fill or stroke." });
  }
  if (stroke.trim().toLowerCase() !== "none" && strokeWidth <= 0) {
    context.addIssue({ code: "custom", path: ["strokeWidth"], message: "A visible path stroke requires positive strokeWidth." });
  }
}

const createPathInputSchema = z.object({
  start: drawingPointSchema,
  segments: z.array(vectorPathSegmentInputSchema).min(1).max(VECTOR_PATH_LIMITS.maxSegments),
  closed: z.boolean().optional(),
  ...semanticIdentityFields,
  ...activityMetadataFields,
  ...vectorPathStyleInputFields,
}).strict().superRefine(refineVisiblePathStyle);

const createPolygonInputSchema = z.object({
  points: z.array(drawingPointSchema).min(3).max(VECTOR_PATH_LIMITS.maxSegments + 1),
  ...semanticIdentityFields,
  ...activityMetadataFields,
  ...vectorPathStyleInputFields,
}).strict().superRefine(refineVisiblePathStyle);

const endpointPortInputSchema = z
  .object({
    side: z.enum(["top", "right", "bottom", "left"]),
    position: z.number().finite().min(0).max(1).default(0.5),
    exact: z.boolean().default(false),
  })
  .strict();

const endpointInputSchema = z.union([
  z.object({ objectId: idSchema, port: endpointPortInputSchema.optional() }).strict(),
  pointSchema,
]);

const connectorEndpointPatchSchema = pointSchema.extend({
  objectId: idSchema.nullable(),
  normalizedAnchor: normalizedAnchorSchema.nullable().optional(),
  isPrecise: z.boolean().nullable().optional(),
  isExact: z.boolean().nullable().optional(),
  snap: z.enum(["center", "edge-point", "edge", "none"]).nullable().optional(),
});

const drawConnectionInputSchema = z
  .object({
    start: endpointInputSchema,
    end: endpointInputSchema,
    ...semanticIdentityFields,
    ...activityMetadataFields,
    direction: z.enum(["none", "end", "both"]).optional(),
    label: z.string().max(2_000).optional(),
    color: colorSchema.optional(),
    routing: connectorRoutingInputSchema.optional(),
    zIndex: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

const objectPatchSchema = z
  .object({
    semanticName: semanticNameSchema.nullable().optional(),
    semanticRole: semanticRoleSchema.nullable().optional(),
    x: finite.optional(),
    y: finite.optional(),
    width: positiveDimension.optional(),
    height: positiveDimension.optional(),
    rotation: finite.optional(),
    zIndex: z.number().int().min(0).max(1_000_000).optional(),
    groupId: idSchema.nullable().optional(),
    content: z.string().max(20_000).optional(),
    color: colorSchema.optional(),
    size: z.enum(["s", "m", "l", "xl"]).optional(),
    align: z.enum(["start", "middle", "end"]).optional(),
    shape: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
    nodeType: z
      .enum(["component", "service", "requirement", "decision", "open_question"])
      .nullable()
      .optional(),
    nodeMetadata: nodeMetadataInputSchema.nullable().optional(),
    label: z.string().max(10_000).optional(),
    fill: semanticPaintSchema.optional(),
    stroke: semanticPaintSchema.optional(),
    start: z.union([connectorEndpointPatchSchema, normalizedPathPointSchema]).optional(),
    end: connectorEndpointPatchSchema.optional(),
    routing: connectorRoutingInputSchema.optional(),
    direction: z.enum(["none", "end", "both"]).optional(),
    url: agentImageUrlSchema.optional(),
    assetId: z.string().max(512).nullable().optional(),
    alt: z.string().max(2_000).optional(),
    mimeType: z.string().max(128).optional(),
    sourceUrl: z.string().url().max(8_192).nullable().optional(),
    locked: z.boolean().optional(),
    points: z.array(pointSchema).min(2).max(20_000).optional(),
    segments: z.array(normalizedVectorPathSegmentSchema).min(1).max(2_000).optional(),
    closed: z.boolean().optional(),
    strokeWidth: finite.min(0).max(256).optional(),
    opacity: finite.min(0).max(1).optional(),
    lineCap: z.enum(["butt", "round", "square"]).optional(),
    lineJoin: z.enum(["miter", "round", "bevel"]).optional(),
    fillRule: z.enum(["nonzero", "evenodd"]).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "At least one semantic field must be updated.")
  .superRefine((patch, context) => {
    if (patch.nodeType && patch.nodeMetadata && patch.nodeType !== patch.nodeMetadata.kind) {
      context.addIssue({ code: "custom", path: ["nodeMetadata"], message: "Node metadata kind must match nodeType." });
    }
  });

const updateObjectInputSchema = z
  .object({
    objectId: idSchema,
    expectedRevision: z.number().int().positive(),
    leaseId: idSchema.optional(),
    operation: z.enum(["move", "resize", "edit", "connect", "delete", "annotate"]).optional(),
    patch: objectPatchSchema,
    ...activityMetadataFields,
  })
  .strict();

const moveObjectsInputSchema = z
  .object({
    targets: z
      .array(targetSchema.extend({ x: finite, y: finite }).strict())
      .min(1)
      .max(200),
    ...activityMetadataFields,
  })
  .strict();

const groupObjectsInputSchema = z
  .object({
    targets: z.array(targetSchema).min(1).max(200),
    groupId: idSchema.nullable().optional(),
    ...activityMetadataFields,
  })
  .strict();

const deleteObjectsInputSchema = z
  .object({ targets: z.array(targetSchema).min(1).max(200), ...activityMetadataFields })
  .strict();

const readRoomInputSchema = z
  .object({ objectIds: z.array(idSchema).max(500).optional() })
  .strict();

const readSelectionInputSchema = z.object({}).strict();

const focusViewportInputSchema = z
  .object({
    objectIds: z.array(idSchema).min(1).max(200).optional(),
    padding: finite.nonnegative().max(10_000).optional(),
    x: finite.optional(),
    y: finite.optional(),
    zoom: finite.positive().max(100).optional(),
    width: positiveDimension.optional(),
    height: positiveDimension.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasObjects = Boolean(value.objectIds?.length);
    const explicit = [value.x, value.y, value.width, value.height];
    const hasCompleteViewport = explicit.every((item) => item !== undefined);
    const hasPartialViewport = explicit.some((item) => item !== undefined);
    if (!hasObjects && !hasCompleteViewport) {
      context.addIssue({
        code: "custom",
        message: "Provide objectIds or a complete x, y, width, and height viewport.",
      });
    }
    if (hasPartialViewport && !hasCompleteViewport) {
      context.addIssue({
        code: "custom",
        message: "An explicit viewport requires x, y, width, and height.",
      });
    }
  });

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const ID = { type: "string", minLength: 1, maxLength: 128 } as const;
const REVISION = { type: "integer", minimum: 1 } as const;
const COORDINATE = { type: "number" } as const;
const DIMENSION = { type: "number", exclusiveMinimum: 0, maximum: 100_000 } as const;
const LEASE_ID = { type: "string", minLength: 1, maxLength: 128 } as const;

const PLACEMENT_PROPERTIES = {
  x: COORDINATE,
  y: COORDINATE,
  width: DIMENSION,
  height: DIMENSION,
  rotation: COORDINATE,
  zIndex: { type: "integer", minimum: 0, maximum: 1_000_000 },
  groupId: { type: ["string", "null"], minLength: 1, maxLength: 128 },
} as const;

const SEMANTIC_IDENTITY_PROPERTIES = {
  semanticName: {
    type: "string",
    minLength: 1,
    maxLength: 160,
  },
  semanticRole: {
    type: "string",
    minLength: 1,
    maxLength: 128,
  },
} as const;

const ACTIVITY_METADATA_PROPERTIES = {
  intent: { type: "string", minLength: 1, maxLength: 1_000 },
  summary: { type: "string", minLength: 1, maxLength: 500 },
} as const;

const TARGET_JSON_SCHEMA = {
  type: "object",
  properties: { objectId: ID, expectedRevision: REVISION, leaseId: LEASE_ID },
  required: ["objectId", "expectedRevision"],
  additionalProperties: false,
} as const;

type CommandResponse = {
  ok: true;
  room: RoomState;
  changedObjectIds: string[];
  outcome: "applied" | "proposed";
  activity: RoomActivitySummary | null;
  proposal: AgentEditProposalSummary | null;
};

type AuthorizedRoomResponse = {
  ok: true;
  room: RoomState;
};

type PresenceResponse = {
  ok: true;
  presence: RoomPresenceDelta;
};

class ToolInputFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolInputFailure";
  }
}

function defaultCreateId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${suffix}`;
}

function failure(tool: string, error: unknown): JazzboardToolFailure {
  if (error instanceof JazzboardApiError) {
    return { ok: false, tool, error: error.failure };
  }
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "The tool input does not match Jazzboard's semantic canvas schema.",
        details: {
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      },
    };
  }
  if (error instanceof ToolInputFailure) {
    return {
      ok: false,
      tool,
      error: { code: error.code, message: error.message, details: error.details },
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      ok: false,
      tool,
      error: { code: "TOOL_ABORTED", message: "The WebMCP tool call was cancelled." },
    };
  }
  return {
    ok: false,
    tool,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: error instanceof Error ? error.message : "Jazzboard could not execute this tool.",
    },
  };
}

function defineTool<TSchema extends z.ZodType>(input: {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  schema: TSchema;
  annotations?: WebMCP.ToolAnnotations;
  execute: (input: z.output<TSchema>, signal: AbortSignal) => Promise<unknown>;
}): WebMCP.ModelContextTool {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema,
    annotations: input.annotations,
    async execute(rawInput, options): Promise<JazzboardToolResult> {
      try {
        const parsed = input.schema.parse(rawInput);
        const signal = options?.signal ?? new AbortController().signal;
        const data = await input.execute(parsed, signal);
        return { ok: true, tool: input.name, data };
      } catch (error) {
        return withActionableRecovery(failure(input.name, error));
      }
    },
  };
}

function roomRoute(roomId: string, suffix: "commands" | "presence"): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/agent/${suffix}`;
}

function authorizedRoomRoute(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}`;
}

function post<T>(
  request: WebMcpRequest,
  url: string,
  body: unknown,
  signal: AbortSignal,
): Promise<T> {
  return request<T>(url, { method: "POST", body: JSON.stringify(body), signal });
}

function viewportCenter(viewport: Viewport | null): { x: number; y: number } {
  if (!viewport) return { x: 0, y: 0 };
  return { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 };
}

function nextZIndex(room: RoomState | null): number {
  return room ? Math.max(-1, ...Object.values(room.objects).map((object) => object.zIndex)) + 1 : 0;
}

function position(
  input: { x?: number; y?: number; width?: number; height?: number },
  viewport: Viewport | null,
  defaultWidth: number,
  defaultHeight: number,
) {
  const width = input.width ?? defaultWidth;
  const height = input.height ?? defaultHeight;
  const center = viewportCenter(viewport);
  return {
    x: input.x ?? center.x - width / 2,
    y: input.y ?? center.y - height / 2,
    width,
    height,
  };
}

function commandResult(response: CommandResponse) {
  return {
    outcome: response.outcome,
    roomRevision: response.room.roomRevision,
    changedObjectIds: response.changedObjectIds,
    objects: response.changedObjectIds.flatMap((id) => response.room.objects[id] ?? []),
    activity: response.activity,
    proposal: response.proposal,
  };
}

function endpointFromInput(
  input: z.output<typeof endpointInputSchema>,
  room: RoomState | null,
): ConnectorEndpoint {
  if ("objectId" in input) {
    const object = room?.objects[input.objectId];
    if (!object) {
      throw new ToolInputFailure("OBJECT_NOT_FOUND", `Canvas object ${input.objectId} is not in the current room.`, {
        objectId: input.objectId,
      });
    }
    if (!input.port) {
      return {
        objectId: object.id,
        x: object.x + object.width / 2,
        y: object.y + object.height / 2,
      };
    }
    const normalizedAnchor = cardinalNormalizedAnchor(input.port.side, input.port.position);
    const center = {
      x: object.x + object.width / 2,
      y: object.y + object.height / 2,
    };
    const local = {
      x: object.x + object.width * normalizedAnchor.x,
      y: object.y + object.height * normalizedAnchor.y,
    };
    const cosine = Math.cos(object.rotation);
    const sine = Math.sin(object.rotation);
    return {
      objectId: object.id,
      x: center.x + (local.x - center.x) * cosine - (local.y - center.y) * sine,
      y: center.y + (local.x - center.x) * sine + (local.y - center.y) * cosine,
      normalizedAnchor,
      isPrecise: true,
      isExact: input.port.exact,
      snap: "edge-point",
    };
  }
  return { ...input, objectId: null };
}

function focusForObjects(room: RoomState | null, objectIds: string[], padding: number, zoom?: number): Viewport {
  const objects = objectIds.map((id) => room?.objects[id]).filter((object): object is CanvasObject => Boolean(object));
  if (objects.length !== objectIds.length) {
    const missing = objectIds.filter((id) => !room?.objects[id]);
    throw new ToolInputFailure("OBJECT_NOT_FOUND", "One or more focus objects are not in the current room.", {
      objectIds: missing,
    });
  }
  const minX = Math.min(...objects.map((object) => object.x));
  const minY = Math.min(...objects.map((object) => object.y));
  const maxX = Math.max(...objects.map((object) => object.x + object.width));
  const maxY = Math.max(...objects.map((object) => object.y + object.height));
  return {
    x: minX - padding,
    y: minY - padding,
    width: Math.max(maxX - minX + padding * 2, 1),
    height: Math.max(maxY - minY + padding * 2, 1),
    zoom: zoom ?? 1,
  };
}

export const JAZZBOARD_WEBMCP_TOOL_NAMES = [
  "read_room_state",
  "read_selection",
  "create_text",
  "create_shape",
  "create_node",
  "add_image",
  "create_drawing",
  "create_path",
  "create_polygon",
  "draw_connection",
  "update_object",
  "move_objects",
  "group_objects",
  "delete_objects",
  "focus_viewport",
] as const;

export const JAZZBOARD_WEBMCP_READ_TOOL_NAMES = ["read_room_state", "read_selection"] as const;

export function createJazzboardWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies: JazzboardWebMcpDependencies = {},
): WebMCP.ModelContextTool[] {
  const request = dependencies.request ?? (apiRequest as WebMcpRequest);
  const createId = dependencies.createId ?? defaultCreateId;
  const commandUrl = roomRoute(binding.roomId, "commands");
  const presenceUrl = roomRoute(binding.roomId, "presence");

  async function dispatch(
    command: CanvasCommand,
    signal: AbortSignal,
    metadata?: { intent?: string; summary?: string },
  ) {
    const response = await post<CommandResponse>(request, commandUrl, { command, metadata }, signal);
    binding.context.acceptRoom(response.room);
    return commandResult(response);
  }

  async function readAuthorizedRoom(signal: AbortSignal): Promise<RoomState> {
    const response = await request<AuthorizedRoomResponse>(authorizedRoomRoute(binding.roomId), {
      method: "GET",
      signal,
    });
    binding.context.acceptRoom(response.room);
    return response.room;
  }

  const readTools: WebMCP.ModelContextTool[] = [
    defineTool({
      name: "read_room_state",
      title: "Read Jazzboard room state",
      description:
        "Read authoritative room objects and revisions, optionally by object ID.",
      inputSchema: {
        type: "object",
        properties: { objectIds: { type: "array", items: ID, maxItems: 500 } },
        additionalProperties: false,
      },
      schema: readRoomInputSchema,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, signal) {
        const room = await readAuthorizedRoom(signal);
        const objects = input.objectIds
          ? input.objectIds.flatMap((id) => room.objects[id] ?? [])
          : Object.values(room.objects);
        return {
          room: {
            id: room.id,
            code: room.code,
            title: room.title,
            roomRevision: room.roomRevision,
            selfParticipantId: binding.participantId,
            agentEditPolicy: room.agentEditPolicy,
            pendingAgentEditProposalCount: room.reviewProposals.filter((proposal) => proposal.status === "pending").length,
          },
          objects,
          diagrams: Object.values(room.diagrams ?? {}),
          participants: Object.values(room.participants).map((participant) => ({
            participantId: participant.participantId,
            displayName: participant.displayName,
            color: participant.color,
            role: participant.role,
            connected: participant.connected,
            agentActive: participant.agentActive,
            human: participant.human,
            agent: participant.agent,
          })),
          leases: Object.values(room.leases),
          spotlight: room.spotlight,
        };
      },
    }),
    defineTool({
      name: "read_selection",
      title: "Read the current Jazzboard selection",
      description:
        "Read this participant's selected objects and revisions.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      schema: readSelectionInputSchema,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(_input, signal) {
        const selectedIds = [...binding.context.getSelection()];
        const room = await readAuthorizedRoom(signal);
        return {
          selectedObjectIds: selectedIds,
          objects: selectedIds.flatMap((id) => room.objects[id] ?? []),
          missingObjectIds: selectedIds.filter((id) => !room.objects[id]),
          roomRevision: room.roomRevision,
        };
      },
    }),
  ];

  if (binding.role !== "participant") return readTools;

  const tools: WebMCP.ModelContextTool[] = [
    ...readTools,
    defineTool({
      name: "create_text",
      title: "Create semantic canvas text",
      description: "Create semantic text.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", minLength: 1, maxLength: 20_000 },
          ...SEMANTIC_IDENTITY_PROPERTIES,
          ...ACTIVITY_METADATA_PROPERTIES,
          ...PLACEMENT_PROPERTIES,
          color: COLOR_JSON_SCHEMA,
          size: { enum: ["s", "m", "l", "xl"] },
          align: { enum: ["start", "middle", "end"] },
        },
        required: ["content"],
        additionalProperties: false,
      },
      schema: createTextInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const room = binding.context.getRoom();
        const dimensions = position(input, binding.context.getViewport(), 320, 96);
        return dispatch(
          {
            type: "create",
            object: {
              id: createId("text"),
              ...semanticIdentity(input),
              kind: "text",
              ...dimensions,
              rotation: input.rotation ?? 0,
              zIndex: input.zIndex ?? nextZIndex(room),
              groupId: input.groupId ?? null,
              content: input.content,
              color: input.color ?? "black",
              size: input.size ?? "m",
              align: input.align ?? "start",
            },
          },
          signal,
          activityMetadata(input),
        );
      },
    }),
    defineTool({
      name: "create_shape",
      title: "Create a diagram shape",
      description: "Create a diagram shape.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string", maxLength: 10_000 },
          ...SEMANTIC_IDENTITY_PROPERTIES,
          ...ACTIVITY_METADATA_PROPERTIES,
          shape: { enum: ["rectangle", "ellipse", "diamond"] },
          ...PLACEMENT_PROPERTIES,
          fill: { $ref: "#/$defs/paint" },
          stroke: { $ref: "#/$defs/paint" },
        },
        additionalProperties: false,
        $defs: { paint: PAINT_JSON_SCHEMA },
      },
      schema: createShapeInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const room = binding.context.getRoom();
        const dimensions = position(input, binding.context.getViewport(), 260, 140);
        return dispatch(
          {
            type: "create",
            object: {
              id: createId("shape"),
              ...semanticIdentity(input),
              kind: "shape",
              ...dimensions,
              rotation: input.rotation ?? 0,
              zIndex: input.zIndex ?? nextZIndex(room),
              groupId: input.groupId ?? null,
              shape: input.shape ?? "rectangle",
              nodeType: null,
              label: input.label ?? "",
              fill: input.fill ?? "blue",
              stroke: input.stroke ?? "blue",
            },
          },
          signal,
          activityMetadata(input),
        );
      },
    }),
    defineTool({
      name: "create_node",
      title: "Create an architecture node",
      description: "Create an architecture node.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string", minLength: 1, maxLength: 10_000 },
          ...SEMANTIC_IDENTITY_PROPERTIES,
          nodeType: { enum: ["component", "service", "requirement", "decision", "open_question"] },
          nodeMetadata: {
            type: "object",
            description: "Lifecycle metadata; kind matches nodeType.",
          },
          ...ACTIVITY_METADATA_PROPERTIES,
          ...PLACEMENT_PROPERTIES,
        },
        required: ["label"],
        additionalProperties: false,
      },
      schema: createNodeInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const effectiveNodeType = input.nodeType ?? input.nodeMetadata?.kind ?? "component";
        const palette = {
          component: { fill: "blue", stroke: "blue" },
          service: { fill: "green", stroke: "green" },
          requirement: { fill: "yellow", stroke: "orange" },
          decision: { fill: "violet", stroke: "violet" },
          open_question: { fill: "light-red", stroke: "red" },
        }[effectiveNodeType];
        const room = binding.context.getRoom();
        const dimensions = position(input, binding.context.getViewport(), 280, 152);
        return dispatch(
          {
            type: "create",
            object: {
              id: createId("node"),
              ...semanticIdentity(input),
              kind: "shape",
              ...dimensions,
              rotation: input.rotation ?? 0,
              zIndex: input.zIndex ?? nextZIndex(room),
              groupId: input.groupId ?? null,
              shape: "rectangle",
              nodeType: effectiveNodeType,
              nodeMetadata: input.nodeMetadata,
              label: input.label,
              ...palette,
            },
          },
          signal,
          activityMetadata(input),
        );
      },
    }),
    defineTool({
      name: "add_image",
      title: "Add an image by HTTPS or authorized Jazzboard asset URL",
      description: "Add an authorized image.",
      inputSchema: {
        type: "object",
        properties: {
          url: AGENT_IMAGE_URL_SCHEMA,
          ...SEMANTIC_IDENTITY_PROPERTIES,
          alt: { type: "string", maxLength: 2_000 },
          mimeType: { type: "string", minLength: 1, maxLength: 128 },
          locked: { type: "boolean" },
          ...ACTIVITY_METADATA_PROPERTIES,
          ...PLACEMENT_PROPERTIES,
        },
        required: ["url"],
        additionalProperties: false,
      },
      schema: addImageInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const room = binding.context.getRoom();
        const dimensions = position(input, binding.context.getViewport(), 640, 360);
        return dispatch(
          {
            type: "create",
            object: {
              id: createId("image"),
              ...semanticIdentity(input),
              kind: "image",
              ...dimensions,
              rotation: input.rotation ?? 0,
              zIndex: input.zIndex ?? nextZIndex(room),
              groupId: input.groupId ?? null,
              url: input.url,
              sourceUrl: parseRoomAssetProxyReference(input.url) ? null : input.url,
              assetId: null,
              alt: input.alt ?? "",
              mimeType: input.mimeType ?? "image/*",
              locked: input.locked ?? false,
            },
          },
          signal,
          activityMetadata(input),
        );
      },
    }),
    defineTool({
      name: "create_drawing",
      title: "Create a freehand canvas drawing",
      description: "Create a bounded freehand stroke.",
      inputSchema: {
        type: "object",
        properties: {
          ...SEMANTIC_IDENTITY_PROPERTIES,
          points: {
            type: "array",
            minItems: 2,
            maxItems: 2_000,
            items: {
              type: "object",
              properties: {
                x: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
                y: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
              },
              required: ["x", "y"],
              additionalProperties: false,
            },
          },
          color: COLOR_JSON_SCHEMA,
          size: { enum: ["s", "m", "l"] },
          rotation: COORDINATE,
          zIndex: { type: "integer", minimum: 0, maximum: 1_000_000 },
          groupId: { type: ["string", "null"], minLength: 1, maxLength: 128 },
          ...ACTIVITY_METADATA_PROPERTIES,
        },
        required: ["points"],
        additionalProperties: false,
      },
      schema: createDrawingInputSchema,
      annotations: { untrustedContentHint: true },
      execute(input, signal) {
        const room = binding.context.getRoom();
        const drawing = normalizeWorldDrawing(input.points);
        return dispatch(
          {
            type: "create",
            object: {
              id: createId("draw"),
              ...semanticIdentity(input),
              kind: "draw",
              ...drawing,
              rotation: input.rotation ?? 0,
              zIndex: input.zIndex ?? nextZIndex(room),
              groupId: input.groupId ?? null,
              color: input.color ?? "black",
              size: input.size ?? "m",
            },
          },
          signal,
          activityMetadata(input),
        );
      },
    }),
    defineTool({
      name: "create_path",
      title: "Create a native vector path",
      description: "Create a native vector path.",
      inputSchema: {
        type: "object",
        properties: {
          ...SEMANTIC_IDENTITY_PROPERTIES,
          start: WORLD_POINT_JSON_SCHEMA,
          segments: {
            type: "array",
            minItems: 1,
            maxItems: 2_000,
            items: PATH_SEGMENT_JSON_SCHEMA,
          },
          closed: { type: "boolean" },
          fill: { $ref: "#/$defs/paint" },
          stroke: { $ref: "#/$defs/paint" },
          strokeWidth: { type: "number", minimum: 0, maximum: 256 },
          opacity: { type: "number", minimum: 0, maximum: 1 },
          lineCap: { enum: ["butt", "round", "square"] },
          lineJoin: { enum: ["miter", "round", "bevel"] },
          fillRule: { enum: ["nonzero", "evenodd"] },
          rotation: COORDINATE,
          zIndex: { type: "integer", minimum: 0, maximum: 1_000_000 },
          groupId: { type: ["string", "null"], minLength: 1, maxLength: 128 },
          ...ACTIVITY_METADATA_PROPERTIES,
        },
        required: ["start", "segments"],
        additionalProperties: false,
        $defs: { paint: PAINT_JSON_SCHEMA },
      },
      schema: createPathInputSchema,
      annotations: { untrustedContentHint: true },
      execute(input, signal) {
        const room = binding.context.getRoom();
        const path = normalizeWorldVectorPath(input.start, input.segments);
        return dispatch(
          {
            type: "create",
            object: {
              id: createId("path"),
              ...semanticIdentity(input),
              kind: "path",
              ...path,
              rotation: input.rotation ?? 0,
              zIndex: input.zIndex ?? nextZIndex(room),
              groupId: input.groupId ?? null,
              closed: input.closed ?? false,
              fill: input.fill ?? "none",
              stroke: input.stroke ?? "black",
              strokeWidth: input.strokeWidth ?? 3.5,
              opacity: input.opacity ?? 1,
              lineCap: input.lineCap ?? "round",
              lineJoin: input.lineJoin ?? "round",
              fillRule: input.fillRule ?? "nonzero",
            },
          },
          signal,
          activityMetadata(input),
        );
      },
    }),
    defineTool({
      name: "create_polygon",
      title: "Create a native polygon",
      description: "Create a native polygon.",
      inputSchema: {
        type: "object",
        properties: {
          ...SEMANTIC_IDENTITY_PROPERTIES,
          points: {
            type: "array",
            minItems: 3,
            maxItems: 2_001,
            items: WORLD_POINT_JSON_SCHEMA,
          },
          fill: { $ref: "#/$defs/paint" },
          stroke: { $ref: "#/$defs/paint" },
          strokeWidth: { type: "number", minimum: 0, maximum: 256 },
          opacity: { type: "number", minimum: 0, maximum: 1 },
          lineCap: { enum: ["butt", "round", "square"] },
          lineJoin: { enum: ["miter", "round", "bevel"] },
          fillRule: { enum: ["nonzero", "evenodd"] },
          rotation: COORDINATE,
          zIndex: { type: "integer", minimum: 0, maximum: 1_000_000 },
          groupId: { type: ["string", "null"], minLength: 1, maxLength: 128 },
          ...ACTIVITY_METADATA_PROPERTIES,
        },
        required: ["points"],
        additionalProperties: false,
        $defs: { paint: PAINT_JSON_SCHEMA },
      },
      schema: createPolygonInputSchema,
      annotations: { untrustedContentHint: true },
      execute(input, signal) {
        const room = binding.context.getRoom();
        const path = polygonWorldVectorPath(input.points);
        return dispatch(
          {
            type: "create",
            object: {
              id: createId("path"),
              ...semanticIdentity(input),
              kind: "path",
              ...path,
              rotation: input.rotation ?? 0,
              zIndex: input.zIndex ?? nextZIndex(room),
              groupId: input.groupId ?? null,
              closed: true,
              fill: input.fill ?? "none",
              stroke: input.stroke ?? "black",
              strokeWidth: input.strokeWidth ?? 3.5,
              opacity: input.opacity ?? 1,
              lineCap: input.lineCap ?? "round",
              lineJoin: input.lineJoin ?? "round",
              fillRule: input.fillRule ?? "nonzero",
            },
          },
          signal,
          activityMetadata(input),
        );
      },
    }),
    defineTool({
      name: "draw_connection",
      title: "Connect semantic canvas objects",
      description: "Connect objects or canvas points.",
      inputSchema: {
        type: "object",
        properties: {
          start: { type: "object", description: "World {x,y} or {objectId,port?}." },
          end: { type: "object", description: "World {x,y} or {objectId,port?}." },
          ...SEMANTIC_IDENTITY_PROPERTIES,
          direction: { enum: ["none", "end", "both"] },
          label: { type: "string", maxLength: 2_000 },
          color: COLOR_JSON_SCHEMA,
          routing: CONNECTOR_ROUTING_INPUT_JSON_SCHEMA,
          zIndex: { type: "integer", minimum: 0, maximum: 1_000_000 },
          ...ACTIVITY_METADATA_PROPERTIES,
        },
        required: ["start", "end"],
        additionalProperties: false,
      },
      schema: drawConnectionInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const room = binding.context.getRoom();
        const start = endpointFromInput(input.start, room);
        const end = endpointFromInput(input.end, room);
        return dispatch(
          {
            type: "create",
            object: {
              id: createId("connector"),
              ...semanticIdentity(input),
              kind: "connector",
              x: Math.min(start.x, end.x),
              y: Math.min(start.y, end.y),
              width: Math.max(Math.abs(end.x - start.x), 1),
              height: Math.max(Math.abs(end.y - start.y), 1),
              rotation: 0,
              zIndex: input.zIndex ?? nextZIndex(room),
              groupId: null,
              start,
              end,
              routing: normalizeConnectorRouting(input.routing ?? { mode: "auto" }),
              direction: input.direction ?? "end",
              label: input.label ?? "",
              color: input.color ?? "black",
            },
          },
          signal,
          activityMetadata(input),
        );
      },
    }),
    defineTool({
      name: "update_object",
      title: "Update a semantic canvas object",
      description: "Edit one revision-checked object.",
      inputSchema: {
        type: "object",
        properties: {
          objectId: ID,
          expectedRevision: REVISION,
          leaseId: LEASE_ID,
          operation: { enum: ["move", "resize", "edit", "connect", "delete", "annotate"] },
          patch: {
            type: "object",
            minProperties: 1,
            properties: {
              ...PLACEMENT_PROPERTIES,
              semanticName: {
                type: ["string", "null"],
                minLength: 1,
                maxLength: 160,
                description: "Revise or clear identity.",
              },
              semanticRole: {
                type: ["string", "null"],
                minLength: 1,
                maxLength: 128,
                description: "Revise or clear classification.",
              },
              content: { type: "string", maxLength: 20_000 },
              color: { $ref: "#/$defs/color" },
              size: { enum: ["s", "m", "l", "xl"] },
              align: { enum: ["start", "middle", "end"] },
              shape: { enum: ["rectangle", "ellipse", "diamond"] },
              nodeType: {
                enum: ["component", "service", "requirement", "decision", "open_question", null],
              },
              nodeMetadata: { type: ["object", "null"] },
              label: { type: "string", maxLength: 10_000 },
              fill: { $ref: "#/$defs/paint" },
              stroke: { $ref: "#/$defs/paint" },
              start: {
                type: "object",
                description: "Connector endpoint or normalized path {x,y}.",
              },
              end: { type: "object", description: "Connector {x,y,objectId}; attachment metadata is optional." },
              direction: { enum: ["none", "end", "both"] },
              routing: CONNECTOR_ROUTING_INPUT_JSON_SCHEMA,
              url: { type: "string" },
              assetId: { type: ["string", "null"] },
              alt: { type: "string" },
              mimeType: { type: "string" },
              sourceUrl: { type: ["string", "null"] },
              locked: { type: "boolean" },
              points: {
                type: "array",
                items: { type: "object" },
              },
              segments: {
                type: "array",
                items: NORMALIZED_PATH_SEGMENT_JSON_SCHEMA,
              },
              closed: { type: "boolean" },
              strokeWidth: { type: "number", minimum: 0, maximum: 256 },
              opacity: { type: "number", minimum: 0, maximum: 1 },
              lineCap: { enum: ["butt", "round", "square"] },
              lineJoin: { enum: ["miter", "round", "bevel"] },
              fillRule: { enum: ["nonzero", "evenodd"] },
            },
            additionalProperties: false,
          },
          ...ACTIVITY_METADATA_PROPERTIES,
        },
        required: ["objectId", "expectedRevision", "patch"],
        additionalProperties: false,
        $defs: { color: COLOR_JSON_SCHEMA, paint: PAINT_FROM_COLOR_JSON_SCHEMA },
      },
      schema: updateObjectInputSchema,
      annotations: { untrustedContentHint: true },
      execute(input, signal) {
        const patch = {
          ...input.patch,
          ...(input.patch.routing
            ? { routing: normalizeConnectorRouting(input.patch.routing) }
            : {}),
        } as ObjectPatch;
        return dispatch(
          {
            type: "update",
            objectId: input.objectId,
            expectedRevision: input.expectedRevision,
            leaseId: input.leaseId,
            operation: input.operation ?? "edit",
            patch,
          },
          signal,
          activityMetadata(input),
        );
      },
    }),
    defineTool({
      name: "move_objects",
      title: "Move semantic canvas objects",
      description: "Move revision-checked objects atomically.",
      inputSchema: {
        type: "object",
        properties: {
          targets: {
            type: "array",
            minItems: 1,
            maxItems: 200,
            items: {
              type: "object",
              properties: { ...TARGET_JSON_SCHEMA.properties, x: COORDINATE, y: COORDINATE },
              required: ["objectId", "expectedRevision", "x", "y"],
              additionalProperties: false,
            },
          },
          ...ACTIVITY_METADATA_PROPERTIES,
        },
        required: ["targets"],
        additionalProperties: false,
      },
      schema: moveObjectsInputSchema,
      annotations: { untrustedContentHint: true },
      execute(input, signal) {
        return dispatch({ type: "move", targets: input.targets }, signal, activityMetadata(input));
      },
    }),
    defineTool({
      name: "group_objects",
      title: "Group or ungroup semantic objects",
      description: "Group or ungroup objects atomically.",
      inputSchema: {
        type: "object",
        properties: {
          targets: { type: "array", minItems: 1, maxItems: 200, items: TARGET_JSON_SCHEMA },
          groupId: { type: ["string", "null"], minLength: 1, maxLength: 128 },
          ...ACTIVITY_METADATA_PROPERTIES,
        },
        required: ["targets"],
        additionalProperties: false,
      },
      schema: groupObjectsInputSchema,
      annotations: { untrustedContentHint: true },
      execute(input, signal) {
        return dispatch(
          { type: "group", targets: input.targets, groupId: input.groupId === undefined ? createId("group") : input.groupId },
          signal,
          activityMetadata(input),
        );
      },
    }),
    defineTool({
      name: "delete_objects",
      title: "Delete semantic canvas objects",
      description: "Delete revision-checked objects atomically.",
      inputSchema: {
        type: "object",
        properties: {
          targets: { type: "array", minItems: 1, maxItems: 200, items: TARGET_JSON_SCHEMA },
          ...ACTIVITY_METADATA_PROPERTIES,
        },
        required: ["targets"],
        additionalProperties: false,
      },
      schema: deleteObjectsInputSchema,
      annotations: { untrustedContentHint: true },
      execute(input, signal) {
        return dispatch({ type: "delete", targets: input.targets }, signal, activityMetadata(input));
      },
    }),
    defineTool({
      name: "focus_viewport",
      title: "Focus the agent viewport",
      description:
        "Focus the agent viewport on IDs or a region; followers track it.",
      inputSchema: {
        type: "object",
        properties: {
          objectIds: { type: "array", minItems: 1, maxItems: 200, items: ID },
          padding: { type: "number", minimum: 0, maximum: 10_000 },
          x: COORDINATE,
          y: COORDINATE,
          zoom: { type: "number", exclusiveMinimum: 0, maximum: 100 },
          width: DIMENSION,
          height: DIMENSION,
        },
        additionalProperties: false,
      },
      schema: focusViewportInputSchema,
      async execute(input, signal) {
        const viewport = input.objectIds
          ? focusForObjects(binding.context.getRoom(), input.objectIds, input.padding ?? 96, input.zoom)
          : {
              x: input.x as number,
              y: input.y as number,
              width: input.width as number,
              height: input.height as number,
              zoom: input.zoom ?? 1,
            };
        const response = await request<PresenceResponse>(presenceUrl, {
          method: "POST",
          headers: { "x-jazzboard-presence-protocol": "delta-v1" },
          body: JSON.stringify({
            cursor: { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 },
            viewport,
            activity: null,
          }),
          signal,
        });
        const currentRoom = binding.context.getRoom();
        if (currentRoom && roomStateRevision(currentRoom) < response.presence.stateRevision) {
          const patchedRoom = applyPresenceDelta(currentRoom, response.presence);
          if (patchedRoom) binding.context.acceptRoom(patchedRoom);
          else await readAuthorizedRoom(signal);
        } else if (!currentRoom) {
          await readAuthorizedRoom(signal);
        }
        return { viewport, roomRevision: response.presence.roomRevision };
      },
    }),
  ];

  return tools.map((tool) => REVIEW_GATED_TOOL_NAMES.has(tool.name)
    ? { ...tool, description: `${tool.description}${REVIEW_MODE_RESULT_NOTE}` }
    : tool);
}
