import { z } from "zod";

import {
  JAZZBOARD_ARTIFACT_FORMAT,
  JAZZBOARD_ARTIFACT_SCHEMA_URL,
  JAZZBOARD_ARTIFACT_VERSION,
  LEGACY_STRAIGHT_CONNECTOR_ROUTING,
  JazzboardInterchangeError,
  type JazzboardArtifactV1,
  type JazzboardTemplateV1,
} from "./types";

const id = z.string().min(1).max(128);
const finite = z.number().finite();
const dimension = finite.positive().max(100_000);
const timestamp = z.number().int().nonnegative();
const point = z.object({ x: finite, y: finite }).strict();
const bounds = z
  .object({
    x: finite,
    y: finite,
    width: dimension,
    height: dimension,
  })
  .strict();

const attribution = z
  .object({
    displayName: z.string().min(1).max(160),
    kind: z.enum(["human", "agent"]),
  })
  .strict();

const portableBase = {
  id,
  x: finite,
  y: finite,
  width: dimension,
  height: dimension,
  rotation: finite,
  zIndex: z.number().int().min(0).max(1_000_000),
  groupId: id.nullable(),
  revision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
  createdBy: attribution,
  lastEditedBy: attribution,
};

const portableText = z
  .object({
    ...portableBase,
    kind: z.literal("text"),
    content: z.string().max(20_000),
    color: z.string().min(1).max(32),
    size: z.enum(["s", "m", "l", "xl"]),
    align: z.enum(["start", "middle", "end"]),
  })
  .strict();

const nodeMetadata = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("decision"),
      status: z.enum(["proposed", "accepted", "rejected", "superseded"]),
      owner: z.string().min(1).max(160).nullable(),
      resolution: z.string().min(1).max(10_000).nullable(),
      resolvedAt: timestamp.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("open_question"),
      status: z.enum(["open", "answered", "deferred", "closed"]),
      owner: z.string().min(1).max(160).nullable(),
      resolution: z.string().min(1).max(10_000).nullable(),
      resolvedAt: timestamp.nullable(),
    })
    .strict(),
]);

const portableShape = z
  .object({
    ...portableBase,
    kind: z.literal("shape"),
    shape: z.enum(["rectangle", "ellipse", "diamond"]),
    nodeType: z.enum(["service", "component", "requirement", "decision", "open_question"]).nullable(),
    nodeMetadata: nodeMetadata.nullable(),
    label: z.string().max(10_000),
    fill: z.string().min(1).max(32),
    stroke: z.string().min(1).max(32),
  })
  .strict()
  .superRefine((shape, context) => {
    if (shape.nodeMetadata && shape.nodeType !== shape.nodeMetadata.kind) {
      context.addIssue({
        code: "custom",
        path: ["nodeMetadata"],
        message: "nodeMetadata kind must match the explicit decision or open_question nodeType.",
      });
    }
    if (shape.nodeMetadata && !["decision", "open_question"].includes(shape.nodeType ?? "")) {
      context.addIssue({
        code: "custom",
        path: ["nodeMetadata"],
        message: "Only decision and open_question nodes may carry nodeMetadata.",
      });
    }
  });

const connectorEndpoint = point
  .extend({
    objectId: id.nullable(),
    normalizedAnchor: z
      .object({ x: finite.min(0).max(1), y: finite.min(0).max(1) })
      .strict()
      .nullable()
      .optional(),
    isPrecise: z.boolean().nullable().optional(),
    isExact: z.boolean().nullable().optional(),
    snap: z.enum(["center", "edge-point", "edge", "none"]).nullable().optional(),
  })
  .strict();

const connectorRouting = z
  .object({
    mode: z.enum(["auto", "straight", "curved", "elbow"]),
    kind: z.enum(["straight", "curved", "elbow"]),
    bend: finite.min(-10_000).max(10_000),
    elbowMidPoint: finite.min(0).max(1),
    labelPosition: finite.min(0).max(1),
    labelPositionSource: z.enum(["generated", "authored"]).optional(),
  })
  .strict()
  .superRefine((routing, context) => {
    if (routing.mode !== "auto" && routing.mode !== routing.kind) {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "Explicit connector routing mode and kind must match.",
      });
    }
    if (routing.kind !== "curved" && routing.bend !== 0) {
      context.addIssue({
        code: "custom",
        path: ["bend"],
        message: "Only curved routing may carry a non-zero bend.",
      });
    }
    if (routing.kind === "curved" && Math.abs(routing.bend) < 8) {
      context.addIssue({
        code: "custom",
        path: ["bend"],
        message: "Canonical curved routing bend must be at least 8 canvas units from zero.",
      });
    }
    if (routing.mode !== "auto" && routing.labelPositionSource !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["labelPositionSource"],
        message: "Only automatic routing may carry label-position provenance.",
      });
    }
  });

const portableConnector = z
  .object({
    ...portableBase,
    kind: z.literal("connector"),
    start: connectorEndpoint,
    end: connectorEndpoint,
    direction: z.enum(["none", "end", "both"]),
    label: z.string().max(2_000),
    color: z.string().min(1).max(32),
    // Optional only for backwards compatibility with artifacts emitted before
    // routing existed. Parse helpers canonicalize omission to legacy straight.
    routing: connectorRouting.optional(),
  })
  .strict();

const portableImage = z
  .object({
    ...portableBase,
    kind: z.literal("image"),
    alt: z.string().max(2_000),
    mimeType: z.string().max(128),
    locked: z.boolean(),
    media: z
      .object({
        availability: z.literal("placeholder"),
        reason: z.literal("private_or_external_source_omitted"),
      })
      .strict(),
  })
  .strict();

const portableDraw = z
  .object({
    ...portableBase,
    kind: z.literal("draw"),
    points: z.array(point).min(2).max(20_000),
    color: z.string().min(1).max(32),
    size: z.enum(["s", "m", "l"]),
  })
  .strict();

export const portableCanvasObjectSchema = z.discriminatedUnion("kind", [
  portableText,
  portableShape,
  portableConnector,
  portableImage,
  portableDraw,
]);

const portableDiagram = z
  .object({
    id,
    title: z.string().min(1).max(160),
    description: z.string().max(10_000),
    diagramType: z.enum(["architecture", "flow", "hierarchy", "system_context", "process", "custom"]),
    category: z.string().min(1).max(128).nullable(),
    tags: z.array(z.string().min(1).max(64)).max(32),
    memberObjectIds: z.array(id).max(500),
    connectorIds: z.array(id).max(500),
    bounds,
    revision: z.number().int().positive(),
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: attribution,
    lastEditedBy: attribution,
  })
  .strict();

const warning = z
  .object({
    code: z.enum([
      "MEDIA_NOT_EMBEDDED",
      "MISSING_OBJECT",
      "DIAGRAM_PARTIAL",
      "EXTERNAL_CONNECTOR_ENDPOINT_OMITTED",
      "MERMAID_OBJECT_OMITTED",
      "MERMAID_CONNECTOR_OMITTED",
    ]),
    message: z.string().min(1).max(2_000),
    objectId: id.nullable(),
    diagramId: id.nullable(),
  })
  .strict();

const source = z
  .object({
    roomRevision: z.number().int().positive(),
    diagramId: id.nullable(),
    diagramRevision: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.diagramId === null) !== (value.diagramRevision === null)) {
      context.addIssue({
        code: "custom",
        message: "diagramId and diagramRevision must either both be present or both be null.",
      });
    }
  });

type RefObject = {
  id: string;
  kind: string;
  start?: { objectId: string | null };
  end?: { objectId: string | null };
};

type RefDiagram = {
  id: string;
  memberObjectIds: string[];
  connectorIds: string[];
};

function validateReferences(
  objects: RefObject[],
  diagrams: RefDiagram[],
  context: z.RefinementCtx,
): void {
  const objectById = new Map<string, RefObject>();
  for (const [index, object] of objects.entries()) {
    if (objectById.has(object.id)) {
      context.addIssue({
        code: "custom",
        path: ["objects", index, "id"],
        message: `Object ID ${object.id} is duplicated.`,
      });
    }
    objectById.set(object.id, object);
  }

  const diagramIds = new Set<string>();
  for (const [diagramIndex, diagram] of diagrams.entries()) {
    if (diagramIds.has(diagram.id) || objectById.has(diagram.id)) {
      context.addIssue({
        code: "custom",
        path: ["diagrams", diagramIndex, "id"],
        message: `Diagram ID ${diagram.id} is duplicated or collides with an object ID.`,
      });
    }
    diagramIds.add(diagram.id);

    const members = new Set<string>();
    for (const [memberIndex, objectId] of diagram.memberObjectIds.entries()) {
      const object = objectById.get(objectId);
      if (!object || object.kind === "connector" || members.has(objectId)) {
        context.addIssue({
          code: "custom",
          path: ["diagrams", diagramIndex, "memberObjectIds", memberIndex],
          message: `Diagram member ${objectId} must be one unique non-connector object in the artifact.`,
        });
      }
      members.add(objectId);
    }

    const connectors = new Set<string>();
    for (const [connectorIndex, objectId] of diagram.connectorIds.entries()) {
      const object = objectById.get(objectId);
      if (!object || object.kind !== "connector" || connectors.has(objectId)) {
        context.addIssue({
          code: "custom",
          path: ["diagrams", diagramIndex, "connectorIds", connectorIndex],
          message: `Diagram connector ${objectId} must be one unique connector object in the artifact.`,
        });
      }
      connectors.add(objectId);
    }
  }

  for (const [index, object] of objects.entries()) {
    if (object.kind !== "connector") continue;
    for (const terminal of ["start", "end"] as const) {
      const endpointId = object[terminal]?.objectId;
      if (!endpointId) continue;
      const endpoint = objectById.get(endpointId);
      if (!endpoint || endpoint.kind === "connector") {
        context.addIssue({
          code: "custom",
          path: ["objects", index, terminal, "objectId"],
          message: `Connector endpoint ${endpointId} must reference a non-connector object in the artifact.`,
        });
      }
    }
  }
}

const artifactCommon = {
  $schema: z.literal(JAZZBOARD_ARTIFACT_SCHEMA_URL),
  format: z.literal(JAZZBOARD_ARTIFACT_FORMAT),
  version: z.literal(JAZZBOARD_ARTIFACT_VERSION),
  title: z.string().min(1).max(200),
  description: z.string().max(10_000),
  bounds,
  warnings: z.array(warning).max(2_000),
};

export const jazzboardSemanticArtifactV1Schema = z
  .object({
    ...artifactCommon,
    kind: z.enum(["board", "diagram", "selection", "snapshot"]),
    source,
    objects: z.array(portableCanvasObjectSchema).max(5_000),
    diagrams: z.array(portableDiagram).max(500),
  })
  .strict()
  .superRefine((artifact, context) => {
    validateReferences(artifact.objects, artifact.diagrams, context);
    if (artifact.kind === "diagram") {
      if (artifact.diagrams.length !== 1 || artifact.source.diagramId !== artifact.diagrams[0]?.id) {
        context.addIssue({
          code: "custom",
          path: ["diagrams"],
          message: "A diagram artifact must contain exactly its source Diagram.",
        });
      }
    }
  });

const templateBase = {
  id,
  x: finite,
  y: finite,
  width: dimension,
  height: dimension,
  rotation: finite,
  zIndex: z.number().int().min(0).max(1_000_000),
  groupId: id.nullable(),
};

const templateText = z
  .object({
    ...templateBase,
    kind: z.literal("text"),
    content: z.string().max(20_000),
    color: z.string().min(1).max(32),
    size: z.enum(["s", "m", "l", "xl"]),
    align: z.enum(["start", "middle", "end"]),
  })
  .strict();

const templateShape = z
  .object({
    ...templateBase,
    kind: z.literal("shape"),
    shape: z.enum(["rectangle", "ellipse", "diamond"]),
    nodeType: z.enum(["service", "component", "requirement", "decision", "open_question"]).nullable(),
    nodeMetadata: nodeMetadata.nullable(),
    label: z.string().max(10_000),
    fill: z.string().min(1).max(32),
    stroke: z.string().min(1).max(32),
  })
  .strict()
  .superRefine((shape, context) => {
    if (shape.nodeMetadata && shape.nodeType !== shape.nodeMetadata.kind) {
      context.addIssue({
        code: "custom",
        path: ["nodeMetadata"],
        message: "nodeMetadata kind must match the explicit decision or open_question nodeType.",
      });
    }
  });

const templateConnector = z
  .object({
    ...templateBase,
    kind: z.literal("connector"),
    start: connectorEndpoint,
    end: connectorEndpoint,
    direction: z.enum(["none", "end", "both"]),
    label: z.string().max(2_000),
    color: z.string().min(1).max(32),
    routing: connectorRouting.optional(),
  })
  .strict();

const templateDraw = z
  .object({
    ...templateBase,
    kind: z.literal("draw"),
    points: z.array(point).min(2).max(20_000),
    color: z.string().min(1).max(32),
    size: z.enum(["s", "m", "l"]),
  })
  .strict();

export const templateCanvasObjectSchema = z.discriminatedUnion("kind", [
  templateText,
  templateShape,
  templateConnector,
  templateDraw,
]);

const templateDiagram = z
  .object({
    id,
    title: z.string().min(1).max(160),
    description: z.string().max(10_000),
    diagramType: z.enum(["architecture", "flow", "hierarchy", "system_context", "process", "custom"]),
    category: z.string().min(1).max(128).nullable(),
    tags: z.array(z.string().min(1).max(64)).max(32),
    memberObjectIds: z.array(id).max(199),
    connectorIds: z.array(id).max(199),
  })
  .strict();

export const jazzboardTemplateV1Schema = z
  .object({
    ...artifactCommon,
    kind: z.literal("template"),
    source: z.null(),
    objects: z.array(templateCanvasObjectSchema).max(199),
    diagrams: z.array(templateDiagram).length(1),
  })
  .strict()
  .superRefine((template, context) => {
    validateReferences(template.objects, template.diagrams, context);
    if (template.objects.length + template.diagrams.length > 200) {
      context.addIssue({
        code: "custom",
        path: ["objects"],
        message: "A template may create at most 200 total objects and diagrams.",
      });
    }
    const includedIds = new Set([
      ...template.diagrams[0].memberObjectIds,
      ...template.diagrams[0].connectorIds,
    ]);
    for (const [index, object] of template.objects.entries()) {
      if (!includedIds.has(object.id)) {
        context.addIssue({
          code: "custom",
          path: ["objects", index, "id"],
          message: `Template object ${object.id} must belong to its Diagram.`,
        });
      }
    }
    const pointCount = template.objects.reduce(
      (total, object) => total + (object.kind === "draw" ? object.points.length : 0),
      0,
    );
    if (pointCount > 100_000) {
      context.addIssue({
        code: "custom",
        path: ["objects"],
        message: "A template may contain at most 100,000 total drawing points.",
      });
    }
  });

export const jazzboardArtifactV1Schema = z.union([
  jazzboardSemanticArtifactV1Schema,
  jazzboardTemplateV1Schema,
]);

function validationDetails(error: z.ZodError): Record<string, unknown> {
  return {
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

function canonicalizeLegacyConnectorRouting<T extends { objects: Array<{ kind: string; routing?: unknown }> }>(
  artifact: T,
): T {
  return {
    ...artifact,
    objects: artifact.objects.map((object) =>
      object.kind === "connector"
        ? {
            ...object,
            routing: object.routing
              ? { ...(object.routing as typeof LEGACY_STRAIGHT_CONNECTOR_ROUTING) }
              : { ...LEGACY_STRAIGHT_CONNECTOR_ROUTING },
          }
        : object,
    ),
  };
}

export function parseJazzboardArtifactV1(input: unknown): JazzboardArtifactV1 {
  const parsed = jazzboardArtifactV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new JazzboardInterchangeError(
      "ARTIFACT_INVALID",
      "The input is not a valid jazzboard.semantic v1 artifact.",
      validationDetails(parsed.error),
    );
  }
  return canonicalizeLegacyConnectorRouting(parsed.data) as JazzboardArtifactV1;
}

export function parseJazzboardTemplateV1(input: unknown): JazzboardTemplateV1 {
  const parsed = jazzboardTemplateV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new JazzboardInterchangeError(
      "TEMPLATE_INVALID",
      "The input is not a valid create-only Jazzboard v1 template.",
      validationDetails(parsed.error),
    );
  }
  return canonicalizeLegacyConnectorRouting(parsed.data) as JazzboardTemplateV1;
}
