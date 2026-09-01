/// <reference types="webmcp-types" />

import { z } from "zod";

import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import {
  DEFAULT_AUTOMATIC_LAYOUT_COLUMNS,
  DEFAULT_AUTOMATIC_LAYOUT_SLOT_HEIGHT,
  DEFAULT_AUTOMATIC_LAYOUT_SLOT_WIDTH,
  DEFAULT_AUTOMATIC_LAYOUT_VIEWPORT_PADDING,
  layoutDensityDefaults,
} from "@/lib/domain/layout";
import {
  cardinalNormalizedAnchor,
  materializeConnectorRoute,
  normalizeConnectorRouting,
} from "@/lib/domain/connector-routing";
import {
  analyzeDiagramVisualQuality,
  type DiagramVisualQualityReport,
} from "@/lib/domain/diagram-visual-quality";
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
  CreateCanvasObject,
  Diagram,
  DiagramCommand,
  DiagramNodeType,
  LayoutCommand,
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
import { CANVAS_PREVIEW_LIMITS } from "./preview-contract";

const id = z.string().min(1).max(128);
const draftId = z.string().regex(/^draft_[A-Za-z0-9_-]{1,120}$/);
const tempRef = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const finite = z.number().finite();
const dimension = finite.positive().max(100_000);
const point = z.object({ x: finite, y: finite }).strict();
const boundedDrawingPoint = z.object({
  x: finite.min(-1_000_000).max(1_000_000),
  y: finite.min(-1_000_000).max(1_000_000),
}).strict();
const vectorPathSegment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), to: boundedDrawingPoint }).strict(),
  z.object({ kind: z.literal("quadratic"), control: boundedDrawingPoint, to: boundedDrawingPoint }).strict(),
  z.object({
    kind: z.literal("cubic"),
    control1: boundedDrawingPoint,
    control2: boundedDrawingPoint,
    to: boundedDrawingPoint,
  }).strict(),
]);
const normalizedAnchor = z
  .object({ x: finite.min(0).max(1), y: finite.min(0).max(1) })
  .strict();
const normalizedPathPoint = z.object({
  x: finite.min(0).max(1),
  y: finite.min(0).max(1),
}).strict();
const normalizedVectorPathSegment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), to: normalizedPathPoint }).strict(),
  z.object({ kind: z.literal("quadratic"), control: normalizedPathPoint, to: normalizedPathPoint }).strict(),
  z.object({
    kind: z.literal("cubic"),
    control1: normalizedPathPoint,
    control2: normalizedPathPoint,
    to: normalizedPathPoint,
  }).strict(),
]);
const nodeType = z.enum(["service", "component", "requirement", "decision", "open_question"]);
const nodeStatus = z.enum(["proposed", "accepted", "rejected", "superseded", "open", "answered", "deferred", "closed"]);
const REVIEW_MODE_RESULT_NOTE =
  " Review outcome `proposed` is not applied.";
const diagramType = z.enum(["architecture", "flow", "hierarchy", "system_context", "process", "custom"]);
const objectKind = z.enum(["text", "shape", "connector", "image", "draw", "path"]);
const responseDetail = z.enum(["concise", "detailed"]);
const readDetail = z.enum(["summary", "full"]);

const placement = {
  x: finite.optional(),
  y: finite.optional(),
  width: dimension.optional(),
  height: dimension.optional(),
  rotation: finite.optional(),
  zIndex: z.number().int().min(0).max(1_000_000).optional(),
  groupId: id.nullable().optional(),
};

const semanticIdentityFields = {
  semanticName: semanticNameSchema.optional(),
  semanticRole: semanticRoleSchema.optional(),
};

function semanticNameFromTempRef(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function transactionSemanticIdentity(input: {
  tempRef: string;
  semanticName?: string;
  semanticRole?: string;
}) {
  return {
    semanticName: input.semanticName ?? semanticNameFromTempRef(input.tempRef),
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

const endpointPort = z
  .object({
    side: z.enum(["top", "right", "bottom", "left"]),
    position: z.number().finite().min(0).max(1).default(0.5),
    exact: z.boolean().default(false),
  })
  .strict();

const endpointReference = z.union([
  z.object({ objectId: id, port: endpointPort.optional() }).strict(),
  z.object({ tempRef, port: endpointPort.optional() }).strict(),
  point,
]);

const connectorEndpointPatch = point.extend({
  objectId: id.nullable(),
  normalizedAnchor: normalizedAnchor.nullable().optional(),
  isPrecise: z.boolean().nullable().optional(),
  isExact: z.boolean().nullable().optional(),
  snap: z.enum(["center", "edge-point", "edge", "none"]).nullable().optional(),
});

const objectPatch = z
  .object({
    semanticName: semanticNameSchema.nullable().optional(),
    semanticRole: semanticRoleSchema.nullable().optional(),
    x: finite.optional(),
    y: finite.optional(),
    width: dimension.optional(),
    height: dimension.optional(),
    rotation: finite.optional(),
    zIndex: z.number().int().min(0).max(1_000_000).optional(),
    groupId: id.nullable().optional(),
    content: z.string().max(20_000).optional(),
    color: semanticColorSchema.optional(),
    size: z.enum(["s", "m", "l", "xl"]).optional(),
    align: z.enum(["start", "middle", "end"]).optional(),
    shape: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
    nodeType: nodeType.nullable().optional(),
    nodeMetadata: nodeMetadataInputSchema.nullable().optional(),
    label: z.string().max(10_000).optional(),
    fill: semanticPaintSchema.optional(),
    stroke: semanticPaintSchema.optional(),
    start: z.union([connectorEndpointPatch.strict(), normalizedPathPoint]).optional(),
    end: connectorEndpointPatch.strict().optional(),
    routing: connectorRoutingInputSchema.optional(),
    direction: z.enum(["none", "end", "both"]).optional(),
    alt: z.string().max(2_000).optional(),
    locked: z.boolean().optional(),
    segments: z.array(normalizedVectorPathSegment).min(1).max(2_000).optional(),
    closed: z.boolean().optional(),
    strokeWidth: finite.min(0).max(256).optional(),
    opacity: finite.min(0).max(1).optional(),
    lineCap: z.enum(["butt", "round", "square"]).optional(),
    lineJoin: z.enum(["miter", "round", "bevel"]).optional(),
    fillRule: z.enum(["nonzero", "evenodd"]).optional(),
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
    ...semanticIdentityFields,
    ...placement,
  })
  .strict();

const createShapeOperation = z
  .object({
    op: z.literal("create_shape"),
    tempRef,
    label: z.string().max(10_000).default(""),
    shape: z.enum(["rectangle", "ellipse", "diamond"]).default("rectangle"),
    fill: semanticPaintSchema.default("blue"),
    stroke: semanticPaintSchema.default("blue"),
    ...semanticIdentityFields,
    ...placement,
  })
  .strict();

const createTextOperation = z
  .object({
    op: z.literal("create_text"),
    tempRef,
    content: z.string().min(1).max(20_000),
    color: semanticColorSchema.default("black"),
    size: z.enum(["s", "m", "l", "xl"]).default("m"),
    align: z.enum(["start", "middle", "end"]).default("start"),
    ...semanticIdentityFields,
    ...placement,
  })
  .strict();

const createDrawingOperation = z
  .object({
    op: z.literal("create_drawing"),
    tempRef,
    points: z.array(boundedDrawingPoint).min(2).max(2_000),
    color: semanticColorSchema.default("black"),
    size: z.enum(["s", "m", "l"]).default("m"),
    rotation: finite.default(0),
    zIndex: z.number().int().min(0).max(1_000_000).optional(),
    groupId: id.nullable().default(null),
    ...semanticIdentityFields,
  })
  .strict();

const pathStyle = {
  fill: semanticPaintSchema.default("none"),
  stroke: semanticPaintSchema.default("black"),
  strokeWidth: finite.min(0).max(VECTOR_PATH_LIMITS.maxStrokeWidth).default(3.5),
  opacity: finite.min(0).max(1).default(1),
  lineCap: z.enum(["butt", "round", "square"]).default("round"),
  lineJoin: z.enum(["miter", "round", "bevel"]).default("round"),
  fillRule: z.enum(["nonzero", "evenodd"]).default("nonzero"),
  rotation: finite.default(0),
  zIndex: z.number().int().min(0).max(1_000_000).optional(),
  groupId: id.nullable().default(null),
  ...semanticIdentityFields,
};

function visiblePathStyle(
  value: { fill: string; stroke: string; strokeWidth: number },
  context: z.RefinementCtx,
) {
  if (value.fill.trim().toLowerCase() === "none" && value.stroke.trim().toLowerCase() === "none") {
    context.addIssue({ code: "custom", path: ["stroke"], message: "A path requires a visible fill or stroke." });
  }
  if (value.stroke.trim().toLowerCase() !== "none" && value.strokeWidth <= 0) {
    context.addIssue({ code: "custom", path: ["strokeWidth"], message: "A visible path stroke requires positive strokeWidth." });
  }
}

const createPathOperation = z.object({
  op: z.literal("create_path"),
  tempRef,
  start: boundedDrawingPoint,
  segments: z.array(vectorPathSegment).min(1).max(VECTOR_PATH_LIMITS.maxSegments),
  closed: z.boolean().default(false),
  ...pathStyle,
}).strict().superRefine(visiblePathStyle);

const createPolygonOperation = z.object({
  op: z.literal("create_polygon"),
  tempRef,
  points: z.array(boundedDrawingPoint).min(3).max(VECTOR_PATH_LIMITS.maxSegments + 1),
  ...pathStyle,
}).strict().superRefine(visiblePathStyle);

const connectOperation = z
  .object({
    op: z.literal("connect"),
    tempRef,
    start: endpointReference,
    end: endpointReference,
    direction: z.enum(["none", "end", "both"]).default("end"),
    label: z.string().max(2_000).default(""),
    color: semanticColorSchema.default("black"),
    routing: connectorRoutingInputSchema.default({ mode: "auto" }),
    zIndex: z.number().int().min(0).max(1_000_000).optional(),
    ...semanticIdentityFields,
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
    members: z.array(objectReference).max(500).optional(),
    connectors: z.array(objectReference).max(500).optional(),
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

const autoLayoutOperation = z
  .object({
    op: z.literal("auto_layout"),
    layout: z.enum(["flow", "grid", "hierarchy"]),
    layoutDirection: z.enum(["right", "down"]).default("right"),
    density: z.enum(["comfortable", "compact"]).default("comfortable"),
    targets: z.array(tempRef).min(1).max(199),
    diagramTempRef: tempRef.optional(),
    origin: point.optional(),
    columns: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const transactionOperation = z.discriminatedUnion("op", [
  createNodeOperation,
  createShapeOperation,
  createTextOperation,
  createDrawingOperation,
  createPathOperation,
  createPolygonOperation,
  connectOperation,
  updateOperation,
  createDiagramOperation,
  editDiagramOperation,
  autoLayoutOperation,
]);

const draftDelivery = z
  .object({
    mode: z.literal("draft"),
    draftId: draftId.optional(),
    expectedDraftRevision: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.draftId === undefined) !== (value.expectedDraftRevision === undefined)) {
      context.addIssue({
        code: "custom",
        message: "draftId and expectedDraftRevision must be supplied together when replacing a draft.",
      });
    }
  });

const transactionInput = z
  .object({
    operations: z.array(transactionOperation).min(1).max(200),
    delivery: draftDelivery.optional(),
    responseDetail: responseDetail.default("concise"),
    ...activityMetadataFields,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.delivery) {
      input.operations.forEach((operation, index) => {
        if (operation.op === "update" || operation.op === "edit_diagram") {
          context.addIssue({
            code: "custom",
            path: ["operations", index],
            message:
              "Progressive drafts currently support create-only operations. Apply existing-object or existing-Diagram edits directly without delivery.",
          });
        }
      });
    }
    input.operations.forEach((operation, index) => {
      if (
        operation.op === "create_node" &&
        operation.nodeMetadata &&
        operation.nodeType !== operation.nodeMetadata.kind
      ) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "nodeMetadata"],
          message: "Node metadata kind must match nodeType.",
        });
      }
    });
    const createdDiagrams = input.operations.filter(
      (operation): operation is z.output<typeof createDiagramOperation> => operation.op === "create_diagram",
    );
    if (
      createdDiagrams.length > 1 &&
      createdDiagrams.some((operation) => operation.members === undefined || operation.connectors === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Transactions creating multiple Diagrams must provide explicit members and connectors for each Diagram.",
      });
    }
    const layouts = input.operations.flatMap((operation) => operation.op === "auto_layout" ? [operation] : []);
    if (layouts.length > 1) {
      context.addIssue({ code: "custom", path: ["operations"], message: "A transaction can contain at most one auto-layout operation." });
      return;
    }
    const layout = layouts[0];
    if (!layout) return;
    if (new Set(layout.targets).size !== layout.targets.length) {
      context.addIssue({ code: "custom", path: ["operations"], message: "Auto-layout targets must be unique." });
    }
    const temporaryTargets = new Set(layout.targets);
    const placeableReferences = new Set(
      input.operations.flatMap((operation) =>
        operation.op === "create_node" || operation.op === "create_shape" || operation.op === "create_text"
          ? [operation.tempRef]
          : [],
      ),
    );
    for (const reference of layout.targets) {
      if (!placeableReferences.has(reference)) {
        context.addIssue({
          code: "custom",
          path: ["operations"],
          message: `Auto-layout target ${reference} must reference a created node, shape, or text object.`,
        });
      }
    }
    if (
      layout.diagramTempRef &&
      !input.operations.some(
        (operation) => operation.op === "create_diagram" && operation.tempRef === layout.diagramTempRef,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "diagramTempRef must reference a Diagram created in this transaction.",
      });
    }
    input.operations.forEach((operation, index) => {
      if (
        "tempRef" in operation &&
        temporaryTargets.has(operation.tempRef) &&
        ("x" in operation && operation.x !== undefined || "y" in operation && operation.y !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["operations", index],
          message: "An auto-layout target cannot also supply explicit x or y coordinates.",
        });
      }
    });
  });

const SEMANTIC_COLOR_JSON_SCHEMA = {
  type: "string",
  pattern: `^(?:${SEMANTIC_COLOR_NAMES.join("|")}|#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{2})?)?)$`,
  description: "Named Jazzboard color or #RGB/#RRGGBB/#RRGGBBAA.",
} as const;
const SEMANTIC_PAINT_JSON_SCHEMA = {
  type: "string",
  pattern: `^(?:none|${SEMANTIC_COLOR_NAMES.join("|")}|#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{2})?)?)$`,
  description: "Color format above, or none for no paint.",
} as const;
const WORLD_PATH_SEGMENT_JSON_SCHEMA = {
  type: "object",
  description: "World coords: line={kind,to}; quadratic adds control; cubic adds control1/control2. Points are {x,y}.",
} as const;
// Zod is the authoritative op-specific validator. The registered schema keeps
// the complete field vocabulary and the coordinate/reference rules visible,
// without duplicating every discriminated-union branch in the browser budget.
const TRANSACTION_TOOL_INPUT_SCHEMA = {
  type: "object",
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: {
        type: "object",
        required: ["op"],
        properties: {
          op: { enum: ["create_node", "create_shape", "create_text", "create_drawing", "create_path", "create_polygon", "connect", "update", "create_diagram", "edit_diagram", "auto_layout"] },
          tempRef: { type: "string", description: "Request-local alias; reusable by later ops and cumulative draft replacements." },
          objectId: { type: "string" },
          expectedRevision: { type: "integer" },
          leaseId: { type: "string" },
          operation: { enum: ["move", "resize", "edit", "connect", "delete", "annotate"] },
          patch: { type: "object", description: "Object patch. Path start/segments use normalized object-local 0..1 coordinates; draw points use local canvas units." },
          semanticName: { type: "string", minLength: 1, maxLength: 160 },
          semanticRole: { type: "string", minLength: 1, maxLength: 128 },
          label: { type: "string" },
          content: { type: "string" },
          nodeType: { enum: ["service", "component", "requirement", "decision", "open_question"] },
          nodeMetadata: { type: "object" },
          shape: { enum: ["rectangle", "ellipse", "diamond"] },
          fill: { $ref: "#/$defs/paint" },
          stroke: { $ref: "#/$defs/paint" },
          color: { $ref: "#/$defs/color" },
          size: { enum: ["s", "m", "l", "xl"] },
          align: { enum: ["start", "middle", "end"] },
          points: {
            type: "array",
            description: "World {x,y} points for drawing/polygon create; normalized/local storage is derived.",
            items: { type: "object" },
          },
          segments: {
            type: "array",
            description: "World numeric segments; line={kind,to}, quadratic adds control, cubic adds control1/control2; points are {x,y}.",
            items: WORLD_PATH_SEGMENT_JSON_SCHEMA,
          },
          closed: { type: "boolean" },
          strokeWidth: { type: "number", description: "Canvas units." },
          opacity: { type: "number", description: "0..1." },
          lineCap: { enum: ["butt", "round", "square"] },
          lineJoin: { enum: ["miter", "round", "bevel"] },
          fillRule: { enum: ["nonzero", "evenodd"] },
          start: { type: "object", description: "World {x,y}, or connector {objectId|tempRef,port?}." },
          end: { type: "object", description: "Connector world point or object/temp reference." },
          routing: { type: "object" },
          direction: { enum: ["none", "end", "both"] },
          diagramId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          diagramType: {
            enum: ["architecture", "flow", "hierarchy", "system_context", "process", "custom"],
          },
          category: { type: ["string", "null"] },
          tags: { type: "array", items: { type: "string" } },
          members: { type: "array", items: { type: "object" }, description: "Exact {objectId}|{tempRef} members; omit to infer created non-connectors. [] stays empty." },
          connectors: { type: "array", items: { type: "object" }, description: "Exact {objectId}|{tempRef} connectors; omit to infer created connectors. [] stays empty." },
          x: { type: "number", description: "Canvas-unit x of the unrotated top-left." },
          y: { type: "number", description: "Canvas-unit y of the unrotated top-left." },
          width: { type: "number", description: "Unrotated canvas-unit width." },
          height: { type: "number", description: "Unrotated canvas-unit height." },
          rotation: { type: "number", description: "Clockwise radians; object/path center pivot, drawing local-origin pivot." },
          zIndex: { type: "integer", description: "Higher paints in front." },
          groupId: { type: ["string", "null"] },
          layout: { enum: ["flow", "grid", "hierarchy"] },
          layoutDirection: { enum: ["right", "down"] },
          density: { enum: ["comfortable", "compact"] },
          targets: { type: "array", items: { type: "string" } },
          diagramTempRef: { type: "string" },
          origin: { type: "object", description: "Canvas-world {x,y}." },
          columns: { type: "integer" },
        },
      },
    },
    intent: { type: "string" },
    summary: { type: "string" },
    responseDetail: { enum: ["concise", "detailed"] },
    delivery: {
      type: "object",
      description: "Preferred for user-visible new multi-object composition. Omit only for revision-checked correction, explicitly instant work, or no live audience.",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { const: "draft" },
        draftId: { type: "string" },
        expectedDraftRevision: { type: "integer" },
      },
      oneOf: [
        { required: ["draftId", "expectedDraftRevision"] },
        { not: { anyOf: [{ required: ["draftId"] }, { required: ["expectedDraftRevision"] }] } },
      ],
    },
  },
  $defs: {
    color: SEMANTIC_COLOR_JSON_SCHEMA,
    paint: SEMANTIC_PAINT_JSON_SCHEMA,
  },
} as const;

const layoutInput = z
  .object({
    layout: z.enum(["flow", "grid", "hierarchy"]),
    direction: z.enum(["right", "down"]).default("right"),
    density: z.enum(["comfortable", "compact"]).default("comfortable"),
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
    primaryGap: finite.min(0).max(10_000).optional(),
    secondaryGap: finite.min(0).max(10_000).optional(),
    columns: z.number().int().min(1).max(50).optional(),
    diagramId: id.optional(),
    expectedDiagramRevision: z.number().int().positive().optional(),
    responseDetail: responseDetail.default("concise"),
    ...activityMetadataFields,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.diagramId === undefined) !== (value.expectedDiagramRevision === undefined)) {
      context.addIssue({ code: "custom", message: "diagramId and expectedDiagramRevision must be supplied together." });
    }
  });

const LAYOUT_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["layout", "targets"],
  properties: {
    layout: { enum: ["flow", "grid", "hierarchy"] },
    direction: { enum: ["right", "down"] },
    density: { enum: ["comfortable", "compact"] },
    targets: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["objectId", "expectedRevision"],
        properties: {
          objectId: { type: "string", minLength: 1, maxLength: 128 },
          expectedRevision: { type: "integer", minimum: 1 },
          leaseId: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
    },
    origin: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y"],
      properties: { x: { type: "number" }, y: { type: "number" } },
    },
    primaryGap: { type: "number", minimum: 0, maximum: 10_000 },
    secondaryGap: { type: "number", minimum: 0, maximum: 10_000 },
    columns: { type: "integer", minimum: 1, maximum: 50 },
    diagramId: { type: "string", minLength: 1, maxLength: 128 },
    expectedDiagramRevision: { type: "integer", minimum: 1 },
    responseDetail: { enum: ["concise", "detailed"] },
    intent: { type: "string", minLength: 1, maxLength: 1_000 },
    summary: { type: "string", minLength: 1, maxLength: 500 },
  },
  dependentRequired: {
    diagramId: ["expectedDiagramRevision"],
    expectedDiagramRevision: ["diagramId"],
  },
} as const;

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
    semanticName: semanticNameSchema.optional(),
    semanticRole: semanticRoleSchema.optional(),
    kinds: z.array(objectKind).min(1).max(5).optional(),
    nodeTypes: z.array(nodeType).min(1).max(5).optional(),
    nodeStatuses: z.array(nodeStatus).min(1).max(8).optional(),
    nodeOwner: z.string().trim().min(1).max(160).optional(),
    groupId: id.nullable().optional(),
    diagramId: id.optional(),
    relationship: relationshipFilter.optional(),
    region: regionFilter.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    detail: readDetail.default("summary"),
  })
  .strict();

const QUERY_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    semanticName: { type: "string", minLength: 1, maxLength: 160 },
    semanticRole: { type: "string", minLength: 1, maxLength: 128 },
    kinds: { type: "array", items: { enum: ["text", "shape", "connector", "image", "draw", "path"] } },
    nodeTypes: { type: "array", items: { enum: ["service", "component", "requirement", "decision", "open_question"] } },
    nodeStatuses: { type: "array", items: { enum: ["proposed", "accepted", "rejected", "superseded", "open", "answered", "deferred", "closed"] } },
    nodeOwner: { type: "string" },
    groupId: { anyOf: [{ type: "string" }, { type: "null" }] },
    diagramId: { type: "string" },
    relationship: {
      type: "object",
      additionalProperties: false,
      required: ["objectId"],
      properties: {
        objectId: { type: "string" },
        direction: { enum: ["incoming", "outgoing", "both"] },
        includeConnectors: { type: "boolean" },
      },
    },
    region: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "width", "height"],
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number", exclusiveMinimum: 0 },
        height: { type: "number", exclusiveMinimum: 0 },
        mode: { enum: ["intersects", "contained"] },
      },
    },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    detail: { enum: ["summary", "full"] },
  },
} as const;

const neighborhoodInput = z
  .object({
    objectIds: z.array(id).min(1).max(50),
    depth: z.number().int().min(1).max(5).default(1),
    direction: z.enum(["incoming", "outgoing", "both"]).default("both"),
    includeDiagramPeers: z.boolean().default(false),
    maxObjects: z.number().int().min(1).max(300).default(120),
    detail: readDetail.default("summary"),
  })
  .strict();

const NEIGHBORHOOD_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["objectIds"],
  properties: {
    objectIds: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
    depth: { type: "integer", minimum: 1, maximum: 5 },
    direction: { enum: ["incoming", "outgoing", "both"] },
    includeDiagramPeers: { type: "boolean" },
    maxObjects: { type: "integer", minimum: 1, maximum: 300 },
    detail: { enum: ["summary", "full"] },
  },
} as const;

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

const FIND_DIAGRAMS_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    diagramTypes: { type: "array", items: { enum: ["architecture", "flow", "hierarchy", "system_context", "process", "custom"] } },
    category: { type: "string" },
    tags: { type: "array", maxItems: 32, items: { type: "string" } },
    containsObjectId: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

const readDiagramInput = z
  .object({
    diagramId: id,
    includeObjects: z.boolean().default(true),
    includeConnectors: z.boolean().default(true),
  })
  .strict();

const READ_DIAGRAM_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["diagramId"],
  properties: {
    diagramId: { type: "string" },
    includeObjects: { type: "boolean" },
    includeConnectors: { type: "boolean" },
  },
} as const;

const analyzeDiagramLayoutInput = z
  .object({
    diagramId: id,
    expectedDiagramRevision: z.number().int().positive(),
  })
  .strict();

const describeDiagramInput = z.object({ diagramId: id }).strict();

const DESCRIBE_DIAGRAM_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["diagramId"],
  properties: { diagramId: { type: "string" } },
} as const;

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

const DIAGRAM_FIELDS_INPUT_SCHEMA = {
  diagramId: { type: "string" },
  title: { type: "string" },
  description: { type: "string" },
  diagramType: { enum: ["architecture", "flow", "hierarchy", "system_context", "process", "custom"] },
  category: { anyOf: [{ type: "string" }, { type: "null" }] },
  tags: { type: "array", maxItems: 32, items: { type: "string" } },
  memberObjectIds: { type: "array", maxItems: 500, items: { type: "string" } },
  connectorIds: { type: "array", maxItems: 500, items: { type: "string" } },
  intent: { type: "string" },
  summary: { type: "string" },
} as const;

const CREATE_DIAGRAM_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: DIAGRAM_FIELDS_INPUT_SCHEMA,
} as const;

const EDIT_DIAGRAM_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["diagramId", "expectedRevision"],
  properties: {
    ...DIAGRAM_FIELDS_INPUT_SCHEMA,
    expectedRevision: { type: "integer", minimum: 1 },
  },
} as const;

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

type DraftResponse = {
  ok: true;
  draft: AgentCanvasDraftSnapshot;
  serverTime?: number;
};

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

function draftsUrl(roomId: string): string {
  return `${roomUrl(roomId)}/agent/drafts`;
}

function exactAgentDraftUrl(roomId: string, candidateDraftId: string): string {
  return `${draftsUrl(roomId)}/${encodeURIComponent(candidateDraftId)}`;
}

function exactReadableDraftUrl(roomId: string, candidateDraftId: string): string {
  return `${roomUrl(roomId)}/drafts/${encodeURIComponent(candidateDraftId)}`;
}

function post<T>(request: WebMcpRequest, url: string, body: unknown, signal: AbortSignal): Promise<T> {
  return request<T>(url, { method: "POST", body: JSON.stringify(body), signal });
}

function objectVisibleText(object: CanvasObject): string {
  return object.kind === "text"
    ? object.content
    : object.kind === "shape" || object.kind === "connector"
      ? object.label
      : object.kind === "image"
        ? `${object.alt} ${object.sourceUrl ?? ""}`
        : "";
}

function objectText(object: CanvasObject): string {
  return [object.semanticName, object.semanticRole, objectVisibleText(object)].filter(Boolean).join(" ");
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

function exactDiagramOrThrow(room: RoomState, diagramId: string, expectedRevision: number) {
  const diagram = diagramOrThrow(room, diagramId);
  if (diagram.revision !== expectedRevision) {
    throw new SemanticToolError(
      "REVISION_CONFLICT",
      `Diagram ${diagramId} changed from revision ${expectedRevision} to ${diagram.revision}.`,
      { diagramId, expectedRevision, currentRevision: diagram.revision },
    );
  }
  return diagram;
}

const AUTOMATIC_DIAGRAM_QUALITY_REPORT_LIMIT = 8;
const AUTOMATIC_DIAGRAM_QUALITY_OMITTED_ID_LIMIT = 64;
// A persisted Diagram can contain at most 500 connector IDs. Returning every
// resolved route for a valid Diagram keeps the analyze -> preview -> correct
// loop complete without introducing a second pagination protocol. The report
// itself remains independently bounded by DIAGRAM_VISUAL_QUALITY_LIMITS.
const ANALYZED_DIAGRAM_ROUTE_LIMIT = 500;
const ANALYZED_DIAGRAM_OMITTED_ROUTE_ID_LIMIT = 64;

function diagramQualityReports(room: RoomState, diagramIds: readonly string[]) {
  const availableDiagramIds = [...new Set(diagramIds)]
    .filter((diagramId) => Boolean(room.diagrams[diagramId]))
    .sort();
  const reportedDiagramIds = availableDiagramIds.slice(0, AUTOMATIC_DIAGRAM_QUALITY_REPORT_LIMIT);
  const omittedDiagramCount = Math.max(0, availableDiagramIds.length - reportedDiagramIds.length);
  const omittedDiagramIds = availableDiagramIds.slice(
    AUTOMATIC_DIAGRAM_QUALITY_REPORT_LIMIT,
    AUTOMATIC_DIAGRAM_QUALITY_REPORT_LIMIT + AUTOMATIC_DIAGRAM_QUALITY_OMITTED_ID_LIMIT,
  );
  return {
    reports: reportedDiagramIds.map((diagramId) => analyzeDiagramVisualQuality(room, diagramId)),
    omittedDiagramIds,
    omittedDiagramCount,
    omittedDiagramIdsTruncated: omittedDiagramIds.length < omittedDiagramCount,
  };
}

function visualVerification(
  reports: readonly DiagramVisualQualityReport[],
  omittedDiagramIds: readonly string[] = [],
  omittedDiagramCount = omittedDiagramIds.length,
  omittedDiagramIdsTruncated = false,
) {
  if (!reports.length && !omittedDiagramCount) return null;
  const partialGeometryDiagramIds = reports
    .filter((report) => report.geometryCoverage.status === "partial")
    .map((report) => report.diagramId);
  const reportedGeometryQualityStatus = reports.some((report) => report.status === "fail")
    ? "fail"
    : reports.some((report) => report.status === "warning")
      ? "warning"
      : "pass";
  const coverageIsPartial = omittedDiagramCount > 0 || partialGeometryDiagramIds.length > 0;
  const geometryQualityStatus = reportedGeometryQualityStatus === "fail"
    ? "fail" as const
    : coverageIsPartial
      ? "unknown" as const
      : reportedGeometryQualityStatus;
  return {
    geometryQualityStatus,
    coverageStatus: coverageIsPartial ? "partial" as const : "complete" as const,
    partialGeometryDiagramIds,
    omittedDiagramCount,
    omittedDiagramIdsTruncated,
    visualInspectionStatus: "not_performed" as const,
    completionStatus: "verification_required" as const,
    nextStep: omittedDiagramCount
      ? `Run analyze_diagram_layout for omitted changed Diagrams (${omittedDiagramCount} total; bounded sample: ${omittedDiagramIds.join(", ") || "none returned"}${omittedDiagramIdsTruncated ? "; additional IDs omitted" : ""}). Then resolve every finding and inspect each exact preview.`
      : partialGeometryDiagramIds.length
        ? `Deterministic geometry coverage is partial for Diagrams with unsupported freehand stroke relationships: ${partialGeometryDiagramIds.join(", ")}. Resolve every returned finding, render each exact revision, and inspect all preview pixels including those strokes; report.status alone cannot certify complete geometry quality.`
      : reportedGeometryQualityStatus === "pass"
      ? "Geometry checks pass. Render each exact Diagram revision, capture its screenshotClip, inspect the pixels, and only then report visual QA."
      : "Fix every deterministic visual-quality finding, rerun analyze_diagram_layout until it passes, then render and inspect the exact preview pixels.",
  };
}

const COMPACT_TEXT_LIMIT = 512;
const COMPACT_DIAGRAM_SUMMARY_LIMIT = 32;
const COMPACT_DIAGRAM_OMITTED_ID_LIMIT = 64;
const COMPACT_OBJECT_DIAGRAM_ID_LIMIT = 16;
const COMPACT_OBJECT_DIAGRAM_OMITTED_ID_LIMIT = 16;
const INSPECTION_PADDING = 24;

function boundsForObject(object: CanvasObject) {
  return { x: object.x, y: object.y, width: object.width, height: object.height };
}

function boundedText(value: string) {
  return {
    value: value.slice(0, COMPACT_TEXT_LIMIT),
    originalLength: value.length,
    truncated: value.length > COMPACT_TEXT_LIMIT,
  };
}

function compactMutationObject(object: CanvasObject) {
  return {
    id: object.id,
    revision: object.revision,
    kind: object.kind,
    semanticName: object.semanticName ?? null,
    semanticRole: object.semanticRole ?? null,
    bounds: boundsForObject(object),
    ...(object.kind === "connector"
      ? {
          startObjectId: object.start.objectId,
          endObjectId: object.end.objectId,
        }
      : {}),
    ...("authority" in object && object.authority === "draft" ? { authority: "draft" as const } : {}),
  };
}

function compactDiagram(diagram: Diagram) {
  return {
    id: diagram.id,
    revision: diagram.revision,
    title: diagram.title,
    diagramType: diagram.diagramType,
    bounds: diagram.bounds,
    memberObjectCount: diagram.memberObjectIds.length,
    connectorCount: diagram.connectorIds.length,
    ...("authority" in diagram && diagram.authority === "draft" ? { authority: "draft" as const } : {}),
  };
}

function compactDiagramSummaries(room: RoomState, diagramIds: readonly string[]) {
  const availableDiagramIds = uniqueStrings(diagramIds)
    .filter((diagramId) => Boolean(room.diagrams?.[diagramId]))
    .sort();
  const returnedDiagramIds = availableDiagramIds.slice(0, COMPACT_DIAGRAM_SUMMARY_LIMIT);
  const omittedDiagramCount = Math.max(0, availableDiagramIds.length - returnedDiagramIds.length);
  const omittedDiagramIds = availableDiagramIds.slice(
    COMPACT_DIAGRAM_SUMMARY_LIMIT,
    COMPACT_DIAGRAM_SUMMARY_LIMIT + COMPACT_DIAGRAM_OMITTED_ID_LIMIT,
  );
  return {
    diagrams: returnedDiagramIds.map((diagramId) => compactDiagram(room.diagrams[diagramId])),
    diagramSummaryCoverage: {
      totalDiagramCount: availableDiagramIds.length,
      returnedDiagramCount: returnedDiagramIds.length,
      limit: COMPACT_DIAGRAM_SUMMARY_LIMIT,
      truncated: omittedDiagramCount > 0,
      omittedDiagramCount,
      omittedDiagramIds,
      omittedDiagramIdsTruncated: omittedDiagramIds.length < omittedDiagramCount,
    },
  };
}

function compactDiagramMembership(diagramIds: readonly string[]) {
  const availableDiagramIds = uniqueStrings(diagramIds).sort();
  const returnedDiagramIds = availableDiagramIds.slice(0, COMPACT_OBJECT_DIAGRAM_ID_LIMIT);
  const omittedDiagramCount = Math.max(0, availableDiagramIds.length - returnedDiagramIds.length);
  const omittedDiagramIds = availableDiagramIds.slice(
    COMPACT_OBJECT_DIAGRAM_ID_LIMIT,
    COMPACT_OBJECT_DIAGRAM_ID_LIMIT + COMPACT_OBJECT_DIAGRAM_OMITTED_ID_LIMIT,
  );
  return {
    diagramIds: returnedDiagramIds,
    diagramMembershipCoverage: {
      totalDiagramCount: availableDiagramIds.length,
      returnedDiagramCount: returnedDiagramIds.length,
      limit: COMPACT_OBJECT_DIAGRAM_ID_LIMIT,
      truncated: omittedDiagramCount > 0,
      omittedDiagramCount,
      omittedDiagramIds,
      omittedDiagramIdsTruncated: omittedDiagramIds.length < omittedDiagramCount,
    },
  };
}

function compactReadObject(room: RoomState, object: CanvasObject) {
  const base = {
    ...compactMutationObject(object),
    rotation: object.rotation,
    groupId: object.groupId,
    ...compactDiagramMembership(object.diagramIds),
  };
  if (object.kind === "text") {
    const text = boundedText(object.content);
    return {
      ...base,
      content: text.value,
      contentLength: text.originalLength,
      contentTruncated: text.truncated,
    };
  }
  if (object.kind === "shape") {
    const text = boundedText(object.label);
    return {
      ...base,
      label: text.value,
      labelLength: text.originalLength,
      labelTruncated: text.truncated,
      nodeType: object.nodeType,
      nodeStatus: object.nodeMetadata?.status ?? null,
      nodeOwner: object.nodeMetadata?.owner ?? null,
    };
  }
  if (object.kind === "connector") {
    const text = boundedText(object.label);
    const route = materializeConnectorRoute(object, room);
    return {
      ...base,
      label: text.value,
      labelLength: text.originalLength,
      labelTruncated: text.truncated,
      direction: object.direction,
      start: route.start,
      end: route.end,
      routing: route.routing,
      route: {
        points: route.points,
        arc: route.arc,
        pathBounds: route.pathBounds,
        labelBounds: route.labelBounds,
        bounds: route.bounds,
      },
    };
  }
  if (object.kind === "image") {
    const text = boundedText(object.alt);
    return {
      ...base,
      alt: text.value,
      altLength: text.originalLength,
      altTruncated: text.truncated,
    };
  }
  return base;
}

function compactValidation(
  quality: ReturnType<typeof diagramQualityReports>,
  totalChangedDiagramCount: number,
) {
  const verification = visualVerification(
    quality.reports,
    quality.omittedDiagramIds,
    quality.omittedDiagramCount,
    quality.omittedDiagramIdsTruncated,
  );
  return {
    geometryQualityStatus: verification?.geometryQualityStatus ?? "not_applicable",
    coverageStatus: verification?.coverageStatus ?? "not_applicable",
    totalChangedDiagramCount,
    analyzedDiagramCount: quality.reports.length,
    omittedDiagramCount: quality.omittedDiagramCount,
    omittedDiagramIds: quality.omittedDiagramIds,
    omittedDiagramIdsTruncated: quality.omittedDiagramIdsTruncated,
    findingCount: quality.reports.reduce((total, report) => total + report.metrics.findingCount, 0),
    failCount: quality.reports.reduce((total, report) => total + report.metrics.failCount, 0),
    warningCount: quality.reports.reduce((total, report) => total + report.metrics.warningCount, 0),
    diagrams: quality.reports.map((report) => ({
      diagramId: report.diagramId,
      diagramRevision: report.diagramRevision,
      status: report.status,
      coverageStatus: report.geometryCoverage.status,
      findingCount: report.metrics.findingCount,
      failCount: report.metrics.failCount,
      warningCount: report.metrics.warningCount,
      findingsTruncated: report.metrics.findingsTruncated,
    })),
  };
}

function recommendedInspection(
  room: RoomState,
  changedObjectIds: readonly string[],
  changedDiagramIds: readonly string[],
) {
  const diagram = changedDiagramIds
    .map((diagramId) => room.diagrams?.[diagramId])
    .find((candidate) => candidate && candidate.memberObjectIds.length + candidate.connectorIds.length > 0);
  if (diagram) {
    const targetCount = uniqueStrings([...diagram.memberObjectIds, ...diagram.connectorIds]).length;
    return {
      tool: "inspect_canvas_scope" as const,
      input: {
        scope: { kind: "diagram" as const, diagramId: diagram.id, expectedRevision: diagram.revision },
        padding: INSPECTION_PADDING,
        representation: targetCount > CANVAS_PREVIEW_LIMITS.maxWorkingSetRecords
          ? "overview" as const
          : "working_set" as const,
      },
    };
  }
  const targets = uniqueStrings(changedObjectIds)
    .flatMap((objectId) => room.objects[objectId] ?? [])
    .slice(0, CANVAS_PREVIEW_LIMITS.maxTargets)
    .map((object) => ({ objectId: object.id, expectedRevision: object.revision }));
  return targets.length
    ? {
        tool: "inspect_canvas_scope" as const,
        input: {
          scope: { kind: "objects" as const, targets },
          padding: INSPECTION_PADDING,
          representation: targets.length > CANVAS_PREVIEW_LIMITS.maxWorkingSetRecords
            ? "overview" as const
            : "working_set" as const,
        },
      }
    : null;
}

function conciseMutationReceipt(
  response: SemanticResponse,
  temporaryReferences: Record<string, string> | undefined,
  quality: ReturnType<typeof diagramQualityReports>,
) {
  const objects = response.changedObjectIds.flatMap((objectId) => response.room.objects[objectId] ?? []);
  const diagrams = response.changedDiagramIds.flatMap((diagramId) => response.room.diagrams?.[diagramId] ?? []);
  return {
    outcome: response.outcome,
    roomRevision: response.room.roomRevision,
    ...(temporaryReferences ? { temporaryReferences } : {}),
    changedObjectIds: response.changedObjectIds,
    deletedObjectIds: response.changedObjectIds.filter((objectId) => !response.room.objects[objectId]),
    changedDiagramIds: response.changedDiagramIds,
    deletedDiagramIds: response.changedDiagramIds.filter((diagramId) => !response.room.diagrams?.[diagramId]),
    membershipObjectIds: response.membershipObjectIds,
    objects: objects.map(compactMutationObject),
    diagrams: diagrams.map(compactDiagram),
    validation: compactValidation(quality, response.changedDiagramIds.length),
    visualInspectionStatus: "not_performed" as const,
    recommendedInspection: response.outcome === "applied"
      ? recommendedInspection(response.room, response.changedObjectIds, response.changedDiagramIds)
      : null,
    activity: response.activity,
    proposal: response.proposal,
  };
}

function conciseDraftReceipt(
  draft: AgentCanvasDraftSnapshot,
  presentation?: ReturnType<NonNullable<JazzboardWebMcpBinding["context"]["getAgentDraftPresentation"]>>,
) {
  return {
    outcome: "drafted" as const,
    draftId: draft.id,
    draftRevision: draft.revision,
    baselineRoomRevision: draft.baselineRoomRevision,
    draftStatus: draft.status,
    temporaryReferences: draft.temporaryReferences,
    temporaryReferenceCount: Object.keys(draft.temporaryReferences).length,
    previewObjectCount: draft.previewObjects.length,
    previewDiagramCount: draft.previewDiagrams.length,
    previewObjects: draft.previewObjects.map(compactMutationObject),
    previewDiagrams: draft.previewDiagrams.map(compactDiagram),
    ...(presentation ? { presentation } : {}),
    visualInspectionStatus: "not_performed" as const,
    nextStep:
      "Submit complete cumulative operations with this draftId and expectedDraftRevision to refine the candidate. For the final candidate, poll read_canvas_drafts until presentation.state is complete for this latest exact draftRevision, then call finish_canvas_draft to commit. Discard remains immediate.",
  };
}

function nextZIndex(room: RoomState | null): number {
  return room ? Math.max(-1, ...Object.values(room.objects).map((object) => object.zIndex)) + 1 : 0;
}

function automaticBatchOrigins(
  items: Array<{ width: number; height: number }>,
  viewport: Viewport | null,
): Array<{ x: number; y: number }> {
  if (!items.length) return [];
  const layoutDefaults = layoutDensityDefaults("comfortable");
  const columns = Math.min(DEFAULT_AUTOMATIC_LAYOUT_COLUMNS, items.length);
  const rows = Math.ceil(items.length / columns);
  const columnWidths = Array.from({ length: columns }, (_, column) =>
    Math.max(
      DEFAULT_AUTOMATIC_LAYOUT_SLOT_WIDTH,
      ...items.filter((_, index) => index % columns === column).map((item) => item.width),
    ),
  );
  const rowHeights = Array.from({ length: rows }, (_, row) =>
    Math.max(
      DEFAULT_AUTOMATIC_LAYOUT_SLOT_HEIGHT,
      ...items
        .filter((_, index) => Math.floor(index / columns) === row)
        .map((item) => item.height),
    ),
  );
  const originX = viewport ? viewport.x + DEFAULT_AUTOMATIC_LAYOUT_VIEWPORT_PADDING : 0;
  const originY = viewport ? viewport.y + DEFAULT_AUTOMATIC_LAYOUT_VIEWPORT_PADDING : 0;
  const columnX = columnWidths.map((_, column) =>
    originX + columnWidths.slice(0, column).reduce(
      (sum, width) => sum + width + layoutDefaults.primaryGap,
      0,
    ),
  );
  const rowY = rowHeights.map((_, row) =>
    originY + rowHeights.slice(0, row).reduce(
      (sum, height) => sum + height + layoutDefaults.secondaryGap,
      0,
    ),
  );
  return items.map((_, index) => ({
    x: columnX[index % columns],
    y: rowY[Math.floor(index / columns)],
  }));
}

function batchPosition(
  input: { x?: number; y?: number; width?: number; height?: number },
  automaticOrigin: { x: number; y: number },
  defaults: { width: number; height: number },
) {
  const width = input.width ?? defaults.width;
  const height = input.height ?? defaults.height;
  return {
    x: input.x ?? automaticOrigin.x,
    y: input.y ?? automaticOrigin.y,
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
  "analyze_diagram_layout",
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
        "Find bounded objects by content, kind, node type, group, Diagram, relationship, or canvas region.",
      schema: queryInput,
      inputSchema: QUERY_TOOL_INPUT_SCHEMA,
      annotations: readAnnotations,
      async execute(input, signal) {
        const room = await readRoom(signal);
        const related = input.relationship ? relationshipIds(room, input.relationship) : null;
        const query = input.text?.toLocaleLowerCase();
        const semanticName = input.semanticName?.toLocaleLowerCase();
        const semanticRole = input.semanticRole?.toLocaleLowerCase();
        const matches = Object.values(room.objects)
          .filter((object) => !query || objectText(object).toLocaleLowerCase().includes(query))
          .filter((object) => !semanticName || object.semanticName?.toLocaleLowerCase().includes(semanticName))
          .filter((object) => !semanticRole || object.semanticRole?.toLocaleLowerCase().includes(semanticRole))
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
        const selected = matches.slice(0, input.limit);
        if (input.detail === "full") {
          return {
            roomRevision: room.roomRevision,
            totalMatched: matches.length,
            truncated: matches.length > input.limit,
            objects: selected,
          };
        }
        const diagramIds = selected.flatMap((object) => object.diagramIds);
        return {
          roomRevision: room.roomRevision,
          totalMatched: matches.length,
          truncated: matches.length > input.limit,
          objects: selected.map((object) => compactReadObject(room, object)),
          ...compactDiagramSummaries(room, diagramIds),
        };
      },
    }),
    defineTool({
      name: "read_neighborhood",
      title: "Read an object relationship neighborhood",
      description:
        "Read a bounded connector subgraph around exact object IDs, with optional peers from their Diagrams.",
      schema: neighborhoodInput,
      inputSchema: NEIGHBORHOOD_TOOL_INPUT_SCHEMA,
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
        if (input.detail === "full") {
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
        }
        return {
          roomRevision: room.roomRevision,
          rootObjectIds: input.objectIds,
          missingObjectIds,
          depthReached,
          truncated,
          objects: objects.map((object) => compactReadObject(room, object)),
          connectors: connectors.map((object) => compactReadObject(room, object)),
          ...compactDiagramSummaries(room, [...diagramIds]),
          boundaryObjectIds: frontier.filter((objectId) => limitedSet.has(objectId)),
        };
      },
    }),
    defineTool({
      name: "find_diagrams",
      title: "Find first-class diagrams",
      description:
        "Find Diagrams by metadata or member ID without returning unrelated canvas objects.",
      schema: findDiagramsInput,
      inputSchema: FIND_DIAGRAMS_TOOL_INPUT_SCHEMA,
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
        "Read one Diagram by stable ID, optionally with its exact members and connectors.",
      schema: readDiagramInput,
      inputSchema: READ_DIAGRAM_TOOL_INPUT_SCHEMA,
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
        "Summarize one Diagram's nodes, relationships, metadata, bounds, and revisions.",
      schema: describeDiagramInput,
      inputSchema: DESCRIBE_DIAGRAM_TOOL_INPUT_SCHEMA,
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
            semanticName: object.semanticName ?? null,
            semanticRole: object.semanticRole ?? null,
            nodeType: object.kind === "shape" ? object.nodeType : null,
            nodeMetadata: object.kind === "shape" ? object.nodeMetadata ?? null : null,
            label: objectVisibleText(object),
            revision: object.revision,
            bounds: { x: object.x, y: object.y, width: object.width, height: object.height },
          })),
          relationships: connectors.map((connector) => ({
            connectorId: connector.id,
            semanticName: connector.semanticName ?? null,
            semanticRole: connector.semanticRole ?? null,
            label: connector.label,
            direction: connector.direction,
            routing: normalizeConnectorRouting(connector.routing),
            start: connector.start,
            end: connector.end,
            startObjectId: connector.start.objectId,
            endObjectId: connector.end.objectId,
            revision: connector.revision,
          })),
        };
      },
    }),
    defineTool({
      name: "analyze_diagram_layout",
      title: "Analyze exact diagram visual quality",
      description:
        "Return passive, intent-unaware conventional geometry signals, exact routes, and partial freehand coverage for one exact Diagram; the agent decides what is intentional and must inspect pixels.",
      schema: analyzeDiagramLayoutInput,
      annotations: readAnnotations,
      async execute(input, signal) {
        const room = await readRoom(signal);
        const diagram = exactDiagramOrThrow(room, input.diagramId, input.expectedDiagramRevision);
        const report = analyzeDiagramVisualQuality(room, diagram.id);
        const connectorIds = [...diagram.connectorIds].sort();
        const routes = connectorIds.slice(0, ANALYZED_DIAGRAM_ROUTE_LIMIT).flatMap((connectorId) => {
          const connector = room.objects[connectorId];
          if (!connector || connector.kind !== "connector") return [];
          const route = materializeConnectorRoute(connector, room);
          return [{
            connectorId,
            connectorRevision: connector.revision,
            routing: route.routing,
            start: route.start,
            end: route.end,
            points: route.points,
            arc: route.arc,
            labelPoint: route.labelPoint,
            pathLength: route.pathLength,
            pathBounds: route.pathBounds,
            labelBounds: route.labelBounds,
            bounds: route.bounds,
          }];
        });
        const returnedConnectorIdSet = new Set(routes.map((route) => route.connectorId));
        const omittedConnectorCount = Math.max(0, connectorIds.length - routes.length);
        const omittedConnectorIds: string[] = [];
        for (let index = 0; index < connectorIds.length; index += 1) {
          const connectorId = connectorIds[index];
          if (index < ANALYZED_DIAGRAM_ROUTE_LIMIT && returnedConnectorIdSet.has(connectorId)) continue;
          omittedConnectorIds.push(connectorId);
          if (omittedConnectorIds.length >= ANALYZED_DIAGRAM_OMITTED_ROUTE_ID_LIMIT) break;
        }
        return {
          report,
          routes,
          routeCoverage: {
            totalConnectorCount: connectorIds.length,
            returnedConnectorCount: routes.length,
            truncated: omittedConnectorCount > 0,
            omittedConnectorCount,
            omittedConnectorIds,
            omittedConnectorIdsTruncated: omittedConnectorIds.length < omittedConnectorCount,
          },
          visualInspectionStatus: "not_performed",
          nextStep: report.geometryCoverage.status === "partial"
            ? "Compare each intent-unaware geometry finding with the user's requested composition; preserve deliberate overlap, routing, and spacing. Correct unintended problems, then call render_canvas_preview for this exact Diagram revision and inspect all captured pixels, including unsupported freehand strokes. Geometry analysis alone is not visual QA."
            : "Compare each intent-unaware geometry finding with the user's requested composition; preserve deliberate overlap, routing, and spacing, and correct only unintended problems. Then call render_canvas_preview for this exact Diagram revision and inspect the captured pixels. Geometry analysis alone is not visual QA.",
        };
      },
    }),
  ];

  if (binding.role !== "participant") return reads;

  const mutations: WebMCP.ModelContextTool[] = [
    defineTool({
      name: "apply_canvas_transaction",
      title: "Apply or draft a semantic canvas transaction",
      description:
        "For a user-visible new multi-object composition, set delivery.mode=draft so collaborators see bot-traced construction before one atomic finish. Omit delivery only for revision-checked corrections, explicitly instant work, or no live audience. Draft replacements require complete cumulative operations and the exact draft revision.",
      schema: transactionInput,
      inputSchema: TRANSACTION_TOOL_INPUT_SCHEMA,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        let currentRoom = binding.context.getRoom();
        let existingDraft: AgentCanvasDraftSnapshot | null = null;
        if (input.delivery) {
          if (!currentRoom) currentRoom = await readRoom(signal);
          if (input.delivery.draftId) {
            const response = await request<DraftResponse>(
              exactReadableDraftUrl(binding.roomId, input.delivery.draftId),
              { method: "GET", signal },
            );
            existingDraft = response.draft;
            binding.context.acceptAgentDraft?.(existingDraft);
            if (existingDraft.revision !== input.delivery.expectedDraftRevision) {
              throw new SemanticToolError(
                "DRAFT_REVISION_CONFLICT",
                `Draft ${existingDraft.id} changed from revision ${input.delivery.expectedDraftRevision} to ${existingDraft.revision}.`,
                {
                  draftId: existingDraft.id,
                  expectedDraftRevision: input.delivery.expectedDraftRevision,
                  currentDraftRevision: existingDraft.revision,
                },
              );
            }
          }
        }
        const refs = new Map<string, string>(
          Object.entries(existingDraft?.temporaryReferences ?? {}),
        );
        const requestRefs = new Set<string>();
        for (const operation of input.operations) {
          if (!("tempRef" in operation)) continue;
          if (requestRefs.has(operation.tempRef)) {
            throw new SemanticToolError("DUPLICATE_TEMP_REF", `Temporary reference ${operation.tempRef} is duplicated.`, {
              tempRef: operation.tempRef,
            });
          }
          requestRefs.add(operation.tempRef);
          const persistedId = refs.get(operation.tempRef);
          if (persistedId) {
            if (
              operation.op === "create_diagram" &&
              operation.diagramId !== undefined &&
              operation.diagramId !== persistedId
            ) {
              throw new SemanticToolError(
                "TEMP_REF_ID_CONFLICT",
                `Temporary reference ${operation.tempRef} already resolves to ${persistedId}.`,
                { tempRef: operation.tempRef, persistedId, requestedId: operation.diagramId },
              );
            }
            continue;
          }
          const prefix = {
            create_node: "node",
            create_shape: "shape",
            create_text: "text",
            create_drawing: "draw",
            create_path: "path",
            create_polygon: "path",
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

        const geometry = new Map<string, {
          id: string;
          kind: ObjectKind;
          x: number;
          y: number;
          width: number;
          height: number;
          rotation: number;
        }>();
        for (const object of Object.values(currentRoom?.objects ?? {})) geometry.set(object.id, object);
        const commands: CanvasCommand[] = [];
        const diagramCommands: DiagramCommand[] = [];
        const deferredConnections: z.output<typeof connectOperation>[] = [];
        const deferredUpdates: z.output<typeof updateOperation>[] = [];
        const deferredDiagrams: Array<z.output<typeof createDiagramOperation> | z.output<typeof editDiagramOperation>> = [];
        let deferredAutoLayout: z.output<typeof autoLayoutOperation> | undefined;
        const placeableOperations = input.operations.filter(
          (operation): operation is z.output<typeof createNodeOperation> | z.output<typeof createShapeOperation> | z.output<typeof createTextOperation> =>
            operation.op === "create_node" || operation.op === "create_shape" || operation.op === "create_text",
        );
        const automaticOrigins = automaticBatchOrigins(
          placeableOperations.map((operation) => {
            const defaults = operation.op === "create_text"
              ? { width: 320, height: 96 }
              : { width: 280, height: 152 };
            return {
              width: operation.width ?? defaults.width,
              height: operation.height ?? defaults.height,
            };
          }),
          binding.context.getViewport(),
        );
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
          if (operation.op === "auto_layout") {
            deferredAutoLayout = operation;
            continue;
          }
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
          if (operation.op === "create_drawing") {
            const drawing = normalizeWorldDrawing(operation.points);
            const object: CreateCanvasObject = {
              id: objectId,
              ...transactionSemanticIdentity(operation),
              kind: "draw",
              ...drawing,
              rotation: operation.rotation,
              zIndex: operation.zIndex ?? zIndex++,
              groupId: operation.groupId,
              color: operation.color,
              size: operation.size,
            };
            commands.push({ type: "create", object });
            geometry.set(objectId, { id: objectId, kind: "draw", ...drawing, rotation: object.rotation });
            continue;
          }
          if (operation.op === "create_path" || operation.op === "create_polygon") {
            const path = operation.op === "create_path"
              ? normalizeWorldVectorPath(operation.start, operation.segments)
              : polygonWorldVectorPath(operation.points);
            const object: CreateCanvasObject = {
              id: objectId,
              ...transactionSemanticIdentity(operation),
              kind: "path",
              ...path,
              closed: operation.op === "create_path" ? operation.closed : true,
              rotation: operation.rotation,
              zIndex: operation.zIndex ?? zIndex++,
              groupId: operation.groupId,
              fill: operation.fill,
              stroke: operation.stroke,
              strokeWidth: operation.strokeWidth,
              opacity: operation.opacity,
              lineCap: operation.lineCap,
              lineJoin: operation.lineJoin,
              fillRule: operation.fillRule,
            };
            commands.push({ type: "create", object });
            geometry.set(objectId, { id: objectId, kind: "path", x: path.x, y: path.y, width: path.width, height: path.height, rotation: object.rotation });
            continue;
          }
          const defaults = operation.op === "create_text" ? { width: 320, height: 96 } : { width: 280, height: 152 };
          const position = batchPosition(operation, automaticOrigins[createIndex]!, defaults);
          const common = {
            id: objectId,
            ...transactionSemanticIdentity(operation),
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
          geometry.set(objectId, {
            ...position,
            id: objectId,
            kind: object.kind,
            rotation: object.rotation,
          });
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
          if (!reference.port) {
            return {
              objectId,
              x: target.x + target.width / 2,
              y: target.y + target.height / 2,
            };
          }
          const normalizedAnchor = cardinalNormalizedAnchor(
            reference.port.side,
            reference.port.position,
          );
          const center = {
            x: target.x + target.width / 2,
            y: target.y + target.height / 2,
          };
          const local = {
            x: target.x + target.width * normalizedAnchor.x,
            y: target.y + target.height * normalizedAnchor.y,
          };
          const cosine = Math.cos(target.rotation);
          const sine = Math.sin(target.rotation);
          return {
            objectId,
            x: center.x + (local.x - center.x) * cosine - (local.y - center.y) * sine,
            y: center.y + (local.x - center.x) * sine + (local.y - center.y) * cosine,
            normalizedAnchor,
            isPrecise: true,
            isExact: reference.port.exact,
            snap: "edge-point" as const,
          };
        };

        for (const operation of deferredConnections) {
          const objectId = refs.get(operation.tempRef)!;
          const start = endpointFor(operation.start);
          const end = endpointFor(operation.end);
          const object: CreateCanvasObject = {
            id: objectId,
            ...transactionSemanticIdentity(operation),
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
            routing: normalizeConnectorRouting(operation.routing),
            direction: operation.direction,
            label: operation.label,
            color: operation.color,
          };
          commands.push({ type: "create", object });
          geometry.set(objectId, {
            id: objectId,
            kind: "connector",
            x: object.x,
            y: object.y,
            width: object.width,
            height: object.height,
            rotation: object.rotation,
          });
        }
        for (const operation of deferredUpdates) {
          const patch = {
            ...operation.patch,
            ...(operation.patch.routing
              ? { routing: normalizeConnectorRouting(operation.patch.routing) }
              : {}),
          } as ObjectPatch;
          commands.push({
            type: "update",
            objectId: operation.objectId,
            expectedRevision: operation.expectedRevision,
            leaseId: operation.leaseId,
            operation: operation.operation,
            patch,
          });
        }
        for (const operation of deferredDiagrams) {
          if (operation.op === "create_diagram") {
            const inferredMembers = commands.flatMap((command) =>
              command.type === "create" && command.object.kind !== "connector"
                ? [{ objectId: command.object.id }]
                : [],
            );
            const inferredConnectors = commands.flatMap((command) =>
              command.type === "create" && command.object.kind === "connector"
                ? [{ objectId: command.object.id }]
                : [],
            );
            diagramCommands.push({
              type: "diagram.create",
              diagram: {
                id: refs.get(operation.tempRef)!,
                title: operation.title,
                description: operation.description,
                diagramType: operation.diagramType,
                category: operation.category,
                tags: operation.tags,
                memberObjectIds: (operation.members ?? inferredMembers).map(idFor),
                connectorIds: (operation.connectors ?? inferredConnectors).map(idFor),
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
        const autoLayout: LayoutCommand | undefined = deferredAutoLayout
          ? (() => {
              const diagramId = deferredAutoLayout.diagramTempRef
                ? refs.get(deferredAutoLayout.diagramTempRef)
                : undefined;
              if (deferredAutoLayout.diagramTempRef && !diagramId) {
                throw new SemanticToolError(
                  "UNRESOLVED_TEMP_REF",
                  `Diagram reference ${deferredAutoLayout.diagramTempRef} is not defined in this request.`,
                  { tempRef: deferredAutoLayout.diagramTempRef },
                );
              }
              return {
                layout: deferredAutoLayout.layout,
                direction: deferredAutoLayout.layoutDirection,
                density: deferredAutoLayout.density,
                targets: deferredAutoLayout.targets.map((reference) => ({
                  objectId: idFor({ tempRef: reference }),
                  expectedRevision: 1,
                })),
                ...(deferredAutoLayout.origin ? { origin: deferredAutoLayout.origin } : {}),
                ...(deferredAutoLayout.columns !== undefined ? { columns: deferredAutoLayout.columns } : {}),
                ...(diagramId ? { diagramId, expectedDiagramRevision: 1 } : {}),
              };
            })()
          : undefined;
        const transaction = {
          commands,
          diagramCommands,
          ...(autoLayout ? { autoLayout } : {}),
        };
        if (input.delivery) {
          // Seed compilation from lifetime reservations so reintroduced
          // tempRefs retain their IDs. Send only refs active in this cumulative
          // preview; the server carries omitted reservations forward in the
          // returned draft snapshot.
          const activeTemporaryReferences = Object.fromEntries(
            [...refs].filter(([reference]) => requestRefs.has(reference)),
          );
          const stagedDraftId = existingDraft?.id ?? createId("draft");
          if (!draftId.safeParse(stagedDraftId).success) {
            throw new SemanticToolError(
              "INVALID_DRAFT_ID",
              "The generated draft ID does not satisfy Jazzboard's draft identifier contract.",
              { draftId: stagedDraftId },
            );
          }
          const response = await request<DraftResponse>(
            existingDraft
              ? exactAgentDraftUrl(binding.roomId, stagedDraftId)
              : draftsUrl(binding.roomId),
            {
              method: existingDraft ? "PUT" : "POST",
              body: JSON.stringify({
                ...(existingDraft
                  ? { expectedDraftRevision: input.delivery.expectedDraftRevision }
                  : { draftId: stagedDraftId }),
                baselineRoomRevision:
                  existingDraft?.baselineRoomRevision ?? currentRoom!.roomRevision,
                transaction,
                temporaryReferences: activeTemporaryReferences,
                metadata: activityMetadata(input),
              }),
              signal,
            },
          );
          binding.context.acceptAgentDraft?.(response.draft);
          const presentation = binding.context.getAgentDraftPresentation?.(
            response.draft.id,
            response.draft.revision,
          );
          if (input.responseDetail === "concise") {
            return conciseDraftReceipt(response.draft, presentation);
          }
          return {
            outcome: "drafted",
            draft: response.draft,
            draftId: response.draft.id,
            draftRevision: response.draft.revision,
            baselineRoomRevision: response.draft.baselineRoomRevision,
            temporaryReferences: response.draft.temporaryReferences,
            previewObjects: response.draft.previewObjects,
            previewDiagrams: response.draft.previewDiagrams,
            ...(presentation ? { presentation } : {}),
            nextStep:
              "Submit complete cumulative operations with this draftId and expectedDraftRevision to refine the candidate. For the final candidate, poll read_canvas_drafts until presentation.state is complete for this latest exact draftRevision, then call finish_canvas_draft to commit. Discard remains immediate.",
          };
        }
        const response = await mutate(
          {
            action: "transaction",
            transaction,
            metadata: activityMetadata(input),
          },
          signal,
        );
        const quality = response.outcome === "applied"
          ? diagramQualityReports(response.room, response.changedDiagramIds)
          : { reports: [], omittedDiagramIds: [], omittedDiagramCount: 0, omittedDiagramIdsTruncated: false };
        if (input.responseDetail === "concise") {
          return conciseMutationReceipt(response, Object.fromEntries(refs), quality);
        }
        return {
          outcome: response.outcome,
          roomRevision: response.room.roomRevision,
          temporaryReferences: Object.fromEntries(refs),
          changedObjectIds: response.changedObjectIds,
          changedDiagramIds: response.changedDiagramIds,
          membershipObjectIds: response.membershipObjectIds,
          ...(response.positions === undefined ? {} : { positions: response.positions }),
          objects: response.changedObjectIds.flatMap((objectId) => response.room.objects[objectId] ?? []),
          diagrams: response.changedDiagramIds.flatMap((diagramId) => response.room.diagrams?.[diagramId] ?? []),
          visualQuality: quality.reports,
          visualQualityOmittedDiagramIds: quality.omittedDiagramIds,
          visualQualityOmittedDiagramCount: quality.omittedDiagramCount,
          visualQualityOmittedDiagramIdsTruncated: quality.omittedDiagramIdsTruncated,
          verification: visualVerification(
            quality.reports,
            quality.omittedDiagramIds,
            quality.omittedDiagramCount,
            quality.omittedDiagramIdsTruncated,
          ),
          activity: response.activity,
          proposal: response.proposal,
        };
      },
    }),
    defineTool({
      name: "layout_objects",
      title: "Arrange semantic objects deterministically",
      description:
        "Arrange revision-checked objects as a flow, grid, or hierarchy; auto routes avoid nodes while explicit routes persist.",
      schema: layoutInput,
      inputSchema: LAYOUT_TOOL_INPUT_SCHEMA,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const { responseDetail: requestedResponseDetail, ...layoutWithMetadata } = input;
        const layout = stripActivityMetadata(layoutWithMetadata);
        const response = await mutate(
          { action: "layout", layout, metadata: activityMetadata(input) },
          signal,
        );
        const quality = response.outcome === "applied"
          ? diagramQualityReports(response.room, response.changedDiagramIds)
          : { reports: [], omittedDiagramIds: [], omittedDiagramCount: 0, omittedDiagramIdsTruncated: false };
        if (requestedResponseDetail === "concise") {
          return conciseMutationReceipt(response, undefined, quality);
        }
        return {
          outcome: response.outcome,
          roomRevision: response.room.roomRevision,
          ...(response.positions === undefined ? {} : { positions: response.positions }),
          changedObjectIds: response.changedObjectIds,
          changedDiagramIds: response.changedDiagramIds,
          objects: response.changedObjectIds.flatMap((objectId) => response.room.objects[objectId] ?? []),
          diagrams: response.changedDiagramIds.flatMap((diagramId) => response.room.diagrams?.[diagramId] ?? []),
          visualQuality: quality.reports,
          visualQualityOmittedDiagramIds: quality.omittedDiagramIds,
          visualQualityOmittedDiagramCount: quality.omittedDiagramCount,
          visualQualityOmittedDiagramIdsTruncated: quality.omittedDiagramIdsTruncated,
          verification: visualVerification(
            quality.reports,
            quality.omittedDiagramIds,
            quality.omittedDiagramCount,
            quality.omittedDiagramIdsTruncated,
          ),
          activity: response.activity,
          proposal: response.proposal,
        };
      },
    }),
    defineTool({
      name: "create_diagram",
      title: "Create a first-class semantic diagram",
      description:
        "Create an authoritative Diagram with a stable ID, semantic metadata, members, connectors, computed bounds, revision, and agent attribution.",
      schema: createDiagramInput,
      inputSchema: CREATE_DIAGRAM_TOOL_INPUT_SCHEMA,
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
        const quality = response.outcome === "applied"
          ? diagramQualityReports(response.room, [diagramId])
          : { reports: [], omittedDiagramIds: [], omittedDiagramCount: 0, omittedDiagramIdsTruncated: false };
        return {
          outcome: response.outcome,
          roomRevision: response.room.roomRevision,
          diagram: response.room.diagrams?.[diagramId] ?? null,
          visualQuality: quality.reports,
          visualQualityOmittedDiagramIds: quality.omittedDiagramIds,
          visualQualityOmittedDiagramCount: quality.omittedDiagramCount,
          visualQualityOmittedDiagramIdsTruncated: quality.omittedDiagramIdsTruncated,
          verification: visualVerification(
            quality.reports,
            quality.omittedDiagramIds,
            quality.omittedDiagramCount,
            quality.omittedDiagramIdsTruncated,
          ),
          activity: response.activity,
          proposal: response.proposal,
        };
      },
    }),
    defineTool({
      name: "edit_diagram",
      title: "Edit a diagram by semantic ID and revision",
      description:
        "Revision-check and atomically edit Diagram metadata or membership; stale revisions change nothing.",
      schema: editDiagramInput,
      inputSchema: EDIT_DIAGRAM_TOOL_INPUT_SCHEMA,
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
        const quality = response.outcome === "applied"
          ? diagramQualityReports(response.room, [diagramId])
          : { reports: [], omittedDiagramIds: [], omittedDiagramCount: 0, omittedDiagramIdsTruncated: false };
        return {
          outcome: response.outcome,
          roomRevision: response.room.roomRevision,
          diagram: response.room.diagrams?.[diagramId] ?? null,
          visualQuality: quality.reports,
          visualQualityOmittedDiagramIds: quality.omittedDiagramIds,
          visualQualityOmittedDiagramCount: quality.omittedDiagramCount,
          visualQualityOmittedDiagramIdsTruncated: quality.omittedDiagramIdsTruncated,
          verification: visualVerification(
            quality.reports,
            quality.omittedDiagramIds,
            quality.omittedDiagramCount,
            quality.omittedDiagramIdsTruncated,
          ),
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
