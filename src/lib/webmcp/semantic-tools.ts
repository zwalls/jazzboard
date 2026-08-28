/// <reference types="webmcp-types" />

import { z } from "zod";

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
import { connectorRoutingInputSchema, nodeMetadataInputSchema } from "@/lib/domain/schemas";
import type {
  AgentEditProposalSummary,
  CanvasCommand,
  CanvasObject,
  CreateCanvasObject,
  DiagramCommand,
  DiagramNodeType,
  LayoutCommand,
  ObjectKind,
  ObjectPatch,
  RoomState,
  RoomActivitySummary,
  Viewport,
} from "@/lib/domain/types";

import { CONNECTOR_ROUTING_INPUT_JSON_SCHEMA } from "./routing-schema";
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
const normalizedAnchor = z
  .object({ x: finite.min(0).max(1), y: finite.min(0).max(1) })
  .strict();
const nodeType = z.enum(["service", "component", "requirement", "decision", "open_question"]);
const nodeStatus = z.enum(["proposed", "accepted", "rejected", "superseded", "open", "answered", "deferred", "closed"]);
const REVIEW_MODE_RESULT_NOTE =
  " Review outcome `proposed` is not applied.";
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
    start: connectorEndpointPatch.strict().optional(),
    end: connectorEndpointPatch.strict().optional(),
    routing: connectorRoutingInputSchema.optional(),
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
    routing: connectorRoutingInputSchema.default({ mode: "auto" }),
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
  connectOperation,
  updateOperation,
  createDiagramOperation,
  editDiagramOperation,
  autoLayoutOperation,
]);

const transactionInput = z
  .object({
    operations: z.array(transactionOperation).min(1).max(200),
    ...activityMetadataFields,
  })
  .strict()
  .superRefine((input, context) => {
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

const TRANSACTION_PATCH_INPUT_SCHEMA = {
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
    routing: { $ref: "#/$defs/routing" },
    direction: { enum: ["none", "end", "both"] },
    alt: { type: "string", maxLength: 2_000 },
    locked: { type: "boolean" },
  },
} as const;

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
          routing: { $ref: "#/$defs/routing" },
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
          layout: { enum: ["flow", "grid", "hierarchy"] },
          layoutDirection: { enum: ["right", "down"] },
          density: { enum: ["comfortable", "compact"] },
          targets: { type: "array", minItems: 1, maxItems: 199, items: { $ref: "#/$defs/tempRef" } },
          diagramTempRef: { $ref: "#/$defs/tempRef" },
          origin: { $ref: "#/$defs/point" },
          columns: { type: "integer", minimum: 1, maximum: 50 },
        },
        oneOf: [
          {
            properties: { op: { const: "create_node" } },
            required: ["tempRef", "label", "nodeType"],
            propertyNames: {
              pattern: "^(?:op|tempRef|label|nodeType|nodeMetadata|x|y|width|height|rotation|zIndex|groupId)$",
            },
            allOf: [
              { properties: { label: { minLength: 1 } } },
              {
                anyOf: [
                  { not: { required: ["nodeMetadata"] } },
                  {
                    properties: {
                      nodeType: { const: "decision" },
                      nodeMetadata: { properties: { kind: { const: "decision" } } },
                    },
                    required: ["nodeMetadata"],
                  },
                  {
                    properties: {
                      nodeType: { const: "open_question" },
                      nodeMetadata: { properties: { kind: { const: "open_question" } } },
                    },
                    required: ["nodeMetadata"],
                  },
                ],
              },
            ],
          },
          {
            properties: { op: { const: "create_shape" } },
            required: ["tempRef"],
            propertyNames: {
              pattern: "^(?:op|tempRef|label|shape|fill|stroke|x|y|width|height|rotation|zIndex|groupId)$",
            },
          },
          {
            properties: { op: { const: "create_text" } },
            required: ["tempRef", "content"],
            propertyNames: {
              pattern: "^(?:op|tempRef|content|color|size|align|x|y|width|height|rotation|zIndex|groupId)$",
            },
          },
          {
            properties: { op: { const: "connect" } },
            required: ["tempRef", "start", "end"],
            propertyNames: {
              pattern: "^(?:op|tempRef|start|end|direction|label|color|routing|zIndex)$",
            },
            allOf: [{ properties: { label: { maxLength: 2_000 } } }],
          },
          {
            properties: { op: { const: "update" } },
            required: ["objectId", "expectedRevision", "patch"],
            propertyNames: {
              pattern: "^(?:op|objectId|expectedRevision|leaseId|operation|patch)$",
            },
          },
          {
            properties: { op: { const: "create_diagram" } },
            required: ["tempRef", "title"],
            propertyNames: {
              pattern: "^(?:op|tempRef|diagramId|title|description|diagramType|category|tags|members|connectors)$",
            },
          },
          {
            properties: { op: { const: "edit_diagram" } },
            required: ["diagramId", "expectedRevision"],
            propertyNames: {
              pattern: "^(?:op|diagramId|expectedRevision|title|description|diagramType|category|tags|members|connectors)$",
            },
            anyOf: [
              { required: ["title"] },
              { required: ["description"] },
              { required: ["diagramType"] },
              { required: ["category"] },
              { required: ["tags"] },
              { required: ["members"] },
              { required: ["connectors"] },
            ],
          },
          {
            properties: { op: { const: "auto_layout" } },
            required: ["layout", "targets"],
            propertyNames: {
              pattern: "^(?:op|layout|layoutDirection|density|targets|diagramTempRef|origin|columns)$",
            },
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
        {
          type: "object",
          additionalProperties: false,
          required: ["objectId"],
          properties: {
            objectId: { $ref: "#/$defs/id" },
            port: { $ref: "#/$defs/port" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["tempRef"],
          properties: {
            tempRef: { $ref: "#/$defs/tempRef" },
            port: { $ref: "#/$defs/port" },
          },
        },
        { $ref: "#/$defs/point" },
      ],
    },
    port: {
      type: "object",
      additionalProperties: false,
      required: ["side"],
      properties: {
        side: { enum: ["top", "right", "bottom", "left"] },
        position: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0.5,
        },
        exact: {
          type: "boolean",
          default: false,
        },
      },
    },
    routing: CONNECTOR_ROUTING_INPUT_JSON_SCHEMA,
    nodeType: {
      enum: ["service", "component", "requirement", "decision", "open_question"],
    },
    nodeMetadata: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: {},
        status: {},
        owner: { $ref: "#/$defs/nodeOwner" },
        resolution: {},
      },
      oneOf: [
        {
          properties: {
            kind: { const: "decision" },
            status: { const: "proposed" },
            resolution: { type: "null" },
          },
        },
        {
          properties: {
            kind: { const: "decision" },
            status: { enum: ["accepted", "rejected", "superseded"] },
            resolution: { $ref: "#/$defs/nodeResolutionText" },
          },
          required: ["status", "resolution"],
        },
        {
          properties: {
            kind: { const: "open_question" },
            status: { const: "open" },
            resolution: { type: "null" },
          },
        },
        {
          properties: {
            kind: { const: "open_question" },
            status: { enum: ["answered", "deferred", "closed"] },
            resolution: { $ref: "#/$defs/nodeResolutionText" },
          },
          required: ["status", "resolution"],
        },
      ],
    },
    nodeOwner: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 160 },
        { type: "null" },
      ],
    },
    nodeResolutionText: { type: "string", minLength: 1, maxLength: 10_000 },
    connectorEndpoint: {
      type: "object",
      additionalProperties: false,
      required: ["objectId", "x", "y"],
      properties: {
        objectId: { anyOf: [{ $ref: "#/$defs/id" }, { type: "null" }] },
        x: { type: "number" },
        y: { type: "number" },
        normalizedAnchor: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["x", "y"],
              properties: {
                x: { type: "number", minimum: 0, maximum: 1 },
                y: { type: "number", minimum: 0, maximum: 1 },
              },
            },
            { type: "null" },
          ],
        },
        isPrecise: { anyOf: [{ type: "boolean" }, { type: "null" }] },
        isExact: { anyOf: [{ type: "boolean" }, { type: "null" }] },
        snap: {
          anyOf: [
            { enum: ["center", "edge-point", "edge", "none"] },
            { type: "null" },
          ],
        },
      },
    },
    patch: TRANSACTION_PATCH_INPUT_SCHEMA,
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

const analyzeDiagramLayoutInput = z
  .object({
    diagramId: id,
    expectedDiagramRevision: z.number().int().positive(),
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
        "Read a bounded connector subgraph around exact object IDs, with optional peers from their Diagrams.",
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
        "Find Diagrams by metadata or member ID without returning unrelated canvas objects.",
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
        "Read one Diagram by stable ID, optionally with its exact members and connectors.",
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
        "Summarize one Diagram's nodes, relationships, metadata, bounds, and revisions.",
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
      title: "Apply an atomic semantic canvas transaction",
      description:
        "Atomically create or update objects and Diagrams with temporary refs. Connectors default to auto; routing and optional layout remain all-or-nothing.",
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
          const defaults = operation.op === "create_text" ? { width: 320, height: 96 } : { width: 280, height: 152 };
          const position = batchPosition(operation, automaticOrigins[createIndex]!, defaults);
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
        const response = await mutate(
          {
            action: "transaction",
            transaction: { commands, diagramCommands, ...(autoLayout ? { autoLayout } : {}) },
            metadata: activityMetadata(input),
          },
          signal,
        );
        const quality = response.outcome === "applied"
          ? diagramQualityReports(response.room, response.changedDiagramIds)
          : { reports: [], omittedDiagramIds: [], omittedDiagramCount: 0, omittedDiagramIdsTruncated: false };
        return {
          outcome: response.outcome,
          roomRevision: response.room.roomRevision,
          temporaryReferences: Object.fromEntries(refs),
          changedObjectIds: response.changedObjectIds,
          changedDiagramIds: response.changedDiagramIds,
          membershipObjectIds: response.membershipObjectIds,
          positions: response.positions,
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
        const layout = stripActivityMetadata(input);
        const response = await mutate(
          { action: "layout", layout, metadata: activityMetadata(input) },
          signal,
        );
        const quality = response.outcome === "applied"
          ? diagramQualityReports(response.room, response.changedDiagramIds)
          : { reports: [], omittedDiagramIds: [], omittedDiagramCount: 0, omittedDiagramIdsTruncated: false };
        return {
          outcome: response.outcome,
          roomRevision: response.room.roomRevision,
          positions: response.positions,
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
