import { z } from "zod";

import { isCanvasImageUrl } from "@/lib/assets/policy";

export const roomRoleSchema = z.enum(["participant", "spectator"]);
export const actorKindSchema = z.enum(["human", "agent"]);
export const diagramNodeTypeSchema = z.enum(["service", "component", "requirement", "decision", "open_question"]);
export const diagramTypeSchema = z.enum(["architecture", "flow", "hierarchy", "system_context", "process", "custom"]);
export const decisionStatusSchema = z.enum(["proposed", "accepted", "rejected", "superseded"]);
export const openQuestionStatusSchema = z.enum(["open", "answered", "deferred", "closed"]);

const nodeOwnerSchema = z.string().trim().min(1).max(160).nullable().default(null);
const nodeResolutionSchema = z.string().trim().min(1).max(10_000).nullable().default(null);

export const nodeMetadataInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("decision"),
      status: decisionStatusSchema.default("proposed"),
      owner: nodeOwnerSchema,
      resolution: nodeResolutionSchema,
    })
    .strict()
    .superRefine((metadata, context) => {
      if (metadata.status === "proposed" && metadata.resolution !== null) {
        context.addIssue({ code: "custom", path: ["resolution"], message: "A proposed decision cannot have a resolution yet." });
      }
      if (metadata.status !== "proposed" && metadata.resolution === null) {
        context.addIssue({ code: "custom", path: ["resolution"], message: "A resolved decision requires a resolution." });
      }
    }),
  z
    .object({
      kind: z.literal("open_question"),
      status: openQuestionStatusSchema.default("open"),
      owner: nodeOwnerSchema,
      resolution: nodeResolutionSchema,
    })
    .strict()
    .superRefine((metadata, context) => {
      if (metadata.status === "open" && metadata.resolution !== null) {
        context.addIssue({ code: "custom", path: ["resolution"], message: "An open question cannot have a resolution yet." });
      }
      if (metadata.status !== "open" && metadata.resolution === null) {
        context.addIssue({ code: "custom", path: ["resolution"], message: "A non-open question requires a resolution or deferral note." });
      }
    }),
]);
export const leaseOperationSchema = z.enum([
  "move",
  "resize",
  "edit",
  "connect",
  "delete",
  "annotate",
]);

const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });

const baseObjectSchema = z.object({
  id: z.string().min(1).max(128),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive().max(100_000),
  height: z.number().finite().positive().max(100_000),
  rotation: z.number().finite().default(0),
  zIndex: z.number().int().min(0).max(1_000_000).default(0),
  groupId: z.string().min(1).max(128).nullable().default(null),
});

export const createCanvasObjectSchema = z.discriminatedUnion("kind", [
  baseObjectSchema.extend({
    kind: z.literal("text"),
    content: z.string().max(20_000),
    color: z.string().min(1).max(32).default("black"),
    size: z.enum(["s", "m", "l", "xl"]).default("m"),
    align: z.enum(["start", "middle", "end"]).default("start"),
  }),
  baseObjectSchema.extend({
    kind: z.literal("shape"),
    shape: z.enum(["rectangle", "ellipse", "diamond"]).default("rectangle"),
    nodeType: diagramNodeTypeSchema.nullable().default(null),
    nodeMetadata: nodeMetadataInputSchema.nullable().optional(),
    label: z.string().max(10_000).default(""),
    fill: z.string().min(1).max(32).default("blue"),
    stroke: z.string().min(1).max(32).default("blue"),
  }),
  baseObjectSchema.extend({
    kind: z.literal("connector"),
    start: pointSchema.extend({ objectId: z.string().min(1).max(128).nullable().default(null) }),
    end: pointSchema.extend({ objectId: z.string().min(1).max(128).nullable().default(null) }),
    direction: z.enum(["none", "end", "both"]).default("end"),
    label: z.string().max(2_000).default(""),
    color: z.string().min(1).max(32).default("black"),
  }),
  baseObjectSchema.extend({
    kind: z.literal("image"),
    url: z.string().max(8_192).refine(isCanvasImageUrl, "Use an HTTP(S) URL or a Jazzboard room asset reference."),
    assetId: z.string().max(512).nullable().default(null),
    alt: z.string().max(2_000).default(""),
    mimeType: z.string().max(128).default("image/*"),
    sourceUrl: z.string().url().max(8_192).nullable().default(null),
    locked: z.boolean().default(false),
  }),
  baseObjectSchema.extend({
    kind: z.literal("draw"),
    points: z.array(pointSchema).min(2).max(20_000),
    color: z.string().min(1).max(32).default("red"),
    size: z.enum(["s", "m", "l"]).default("m"),
  }),
]).superRefine((object, context) => {
  if (object.kind !== "shape") return;
  if (object.nodeType === "decision" || object.nodeType === "open_question") {
    if (object.nodeMetadata && object.nodeMetadata.kind !== object.nodeType) {
      context.addIssue({ code: "custom", path: ["nodeMetadata"], message: "Node metadata kind must match the explicit node type." });
    }
  } else if (object.nodeMetadata !== undefined && object.nodeMetadata !== null) {
    context.addIssue({ code: "custom", path: ["nodeMetadata"], message: "Only decision and open-question nodes can carry lifecycle metadata." });
  }
});

const patchSchema = z
  .object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: z.number().finite().positive().max(100_000).optional(),
    height: z.number().finite().positive().max(100_000).optional(),
    rotation: z.number().finite().optional(),
    zIndex: z.number().int().min(0).max(1_000_000).optional(),
    groupId: z.string().min(1).max(128).nullable().optional(),
    content: z.string().max(20_000).optional(),
    color: z.string().min(1).max(32).optional(),
    size: z.enum(["s", "m", "l", "xl"]).optional(),
    align: z.enum(["start", "middle", "end"]).optional(),
    shape: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
    nodeType: diagramNodeTypeSchema.nullable().optional(),
    nodeMetadata: nodeMetadataInputSchema.nullable().optional(),
    label: z.string().max(10_000).optional(),
    fill: z.string().min(1).max(32).optional(),
    stroke: z.string().min(1).max(32).optional(),
    start: pointSchema.extend({ objectId: z.string().nullable() }).optional(),
    end: pointSchema.extend({ objectId: z.string().nullable() }).optional(),
    direction: z.enum(["none", "end", "both"]).optional(),
    url: z.string().max(8_192).refine(isCanvasImageUrl, "Use an HTTP(S) URL or a Jazzboard room asset reference.").optional(),
    assetId: z.string().max(512).nullable().optional(),
    alt: z.string().max(2_000).optional(),
    mimeType: z.string().max(128).optional(),
    sourceUrl: z.string().url().max(8_192).nullable().optional(),
    locked: z.boolean().optional(),
    points: z.array(pointSchema).min(2).max(20_000).optional(),
  })
  .strict()
  .superRefine((patch, context) => {
    if (patch.nodeMetadata && patch.nodeType !== undefined && patch.nodeMetadata.kind !== patch.nodeType) {
      context.addIssue({ code: "custom", path: ["nodeMetadata"], message: "Node metadata kind must match the explicit node type." });
    }
    if (
      patch.nodeMetadata !== undefined &&
      patch.nodeMetadata !== null &&
      patch.nodeType !== undefined &&
      patch.nodeType !== "decision" &&
      patch.nodeType !== "open_question"
    ) {
      context.addIssue({ code: "custom", path: ["nodeMetadata"], message: "Only decision and open-question nodes can carry lifecycle metadata." });
    }
  });

const targetSchema = z.object({
  objectId: z.string().min(1).max(128),
  expectedRevision: z.number().int().positive(),
  leaseId: z.string().min(1).max(128).optional(),
});

export const canvasCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), object: createCanvasObjectSchema }),
  z.object({
    type: z.literal("update"),
    objectId: z.string().min(1).max(128),
    expectedRevision: z.number().int().positive(),
    patch: patchSchema,
    leaseId: z.string().min(1).max(128).optional(),
    operation: leaseOperationSchema,
  }),
  z.object({ type: z.literal("delete"), targets: z.array(targetSchema).min(1).max(200) }),
  z.object({
    type: z.literal("move"),
    targets: z
      .array(targetSchema.extend({ x: z.number().finite(), y: z.number().finite() }))
      .min(1)
      .max(200),
  }),
  z.object({
    type: z.literal("group"),
    targets: z.array(targetSchema).min(1).max(200),
    groupId: z.string().min(1).max(128).nullable(),
  }),
]);

export const createRoomRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(48),
  title: z.string().trim().min(1).max(100).default("Untitled Jazzboard"),
});

export const joinRoomRequestSchema = z.object({
  code: z.string().regex(/^\d{4}$/),
  displayName: z.string().trim().min(1).max(48),
  role: roomRoleSchema,
});

export const mutationRequestSchema = z.object({
  actorKind: actorKindSchema,
  command: canvasCommandSchema,
});

const diagramMembersSchema = z.array(z.string().min(1).max(128)).max(500);
const tagsSchema = z.array(z.string().trim().min(1).max(64)).max(32);

export const createDiagramSchema = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().trim().min(1).max(160),
    description: z.string().max(10_000).default(""),
    diagramType: diagramTypeSchema.default("architecture"),
    category: z.string().trim().min(1).max(128).nullable().default(null),
    tags: tagsSchema.default([]),
    memberObjectIds: diagramMembersSchema.default([]),
    connectorIds: diagramMembersSchema.default([]),
  })
  .strict();

const diagramPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(10_000).optional(),
    diagramType: diagramTypeSchema.optional(),
    category: z.string().trim().min(1).max(128).nullable().optional(),
    tags: tagsSchema.optional(),
    memberObjectIds: diagramMembersSchema.optional(),
    connectorIds: diagramMembersSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "At least one diagram field must be updated.");

export const diagramCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("diagram.create"), diagram: createDiagramSchema }).strict(),
  z
    .object({
      type: z.literal("diagram.update"),
      diagramId: z.string().min(1).max(128),
      expectedRevision: z.number().int().positive(),
      patch: diagramPatchSchema,
    })
    .strict(),
]);

export const semanticTransactionSchema = z
  .object({
    commands: z.array(canvasCommandSchema).max(200).default([]),
    diagramCommands: z.array(diagramCommandSchema).max(100).default([]),
  })
  .strict()
  .refine(
    (transaction) => transaction.commands.length + transaction.diagramCommands.length > 0,
    "A semantic transaction requires at least one object or diagram operation.",
  )
  .refine(
    (transaction) => transaction.commands.length + transaction.diagramCommands.length <= 200,
    "A semantic transaction supports at most 200 total operations.",
  );

export const activityMutationMetadataSchema = z
  .object({
    intent: z.string().trim().min(1).max(1_000).optional(),
    summary: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const agentEditPolicySchema = z.enum(["live", "review"]);
export const agentEditProposalStatusSchema = z.enum(["pending", "applied", "rejected"]);

export const agentEditPolicyRequestSchema = z
  .object({ policy: agentEditPolicySchema })
  .strict();

export const reviewProposalDecisionSchema = z
  .object({
    action: z.enum(["approve", "reject"]),
    expectedProposalRevision: z.number().int().positive(),
    note: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export const reviewProposalListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: agentEditProposalStatusSchema.optional(),
    authorParticipantId: z.string().min(1).max(128).optional(),
  })
  .strict();

const revertObjectExpectationSchema = z.discriminatedUnion("state", [
  z
    .object({
      objectId: z.string().min(1).max(128),
      state: z.literal("present"),
      expectedRevision: z.number().int().positive(),
      leaseId: z.string().min(1).max(128).optional(),
    })
    .strict(),
  z.object({ objectId: z.string().min(1).max(128), state: z.literal("absent") }).strict(),
]);

const revertDiagramExpectationSchema = z.discriminatedUnion("state", [
  z
    .object({
      diagramId: z.string().min(1).max(128),
      state: z.literal("present"),
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z.object({ diagramId: z.string().min(1).max(128), state: z.literal("absent") }).strict(),
]);

function validateUniqueRevertExpectations(
  request: {
    objectExpectations: Array<{ objectId: string }>;
    diagramExpectations: Array<{ diagramId: string }>;
  },
  context: z.RefinementCtx,
): void {
  const objectIds = request.objectExpectations.map((item) => item.objectId);
  if (new Set(objectIds).size !== objectIds.length) {
    context.addIssue({ code: "custom", message: "Object revert expectations must be unique." });
  }
  const diagramIds = request.diagramExpectations.map((item) => item.diagramId);
  if (new Set(diagramIds).size !== diagramIds.length) {
    context.addIssue({ code: "custom", message: "Diagram revert expectations must be unique." });
  }
}

const revertActivityFields = {
  objectExpectations: z.array(revertObjectExpectationSchema).max(500),
  diagramExpectations: z.array(revertDiagramExpectationSchema).max(200),
  metadata: activityMutationMetadataSchema.optional(),
};

export const revertActivityBodySchema = z
  .object(revertActivityFields)
  .strict()
  .superRefine(validateUniqueRevertExpectations);

export const revertActivityRequestSchema = z
  .object({
    activityId: z.string().min(1).max(128),
    ...revertActivityFields,
  })
  .strict()
  .superRefine(validateUniqueRevertExpectations);

export const activityListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    beforeRoomRevision: z.coerce.number().int().positive().optional(),
    actorKind: actorKindSchema.optional(),
    objectId: z.string().min(1).max(128).optional(),
    diagramId: z.string().min(1).max(128).optional(),
  })
  .strict();

const layoutTargetSchema = z
  .object({
    objectId: z.string().min(1).max(128),
    expectedRevision: z.number().int().positive(),
    leaseId: z.string().min(1).max(128).optional(),
  })
  .strict();

export const layoutCommandSchema = z
  .object({
    layout: z.enum(["flow", "grid", "hierarchy"]),
    direction: z.enum(["right", "down"]).default("right"),
    targets: z.array(layoutTargetSchema).min(1).max(200),
    origin: pointSchema.optional(),
    primaryGap: z.number().finite().min(0).max(10_000).default(160),
    secondaryGap: z.number().finite().min(0).max(10_000).default(100),
    columns: z.number().int().min(1).max(50).optional(),
    diagramId: z.string().min(1).max(128).optional(),
    expectedDiagramRevision: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((layout, context) => {
    if ((layout.diagramId === undefined) !== (layout.expectedDiagramRevision === undefined)) {
      context.addIssue({
        code: "custom",
        message: "diagramId and expectedDiagramRevision must be provided together.",
      });
    }
    const ids = layout.targets.map((target) => target.objectId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Layout targets must be unique." });
    }
  });

export const leaseRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("acquire"),
    actorKind: actorKindSchema,
    objectId: z.string().min(1).max(128),
    expectedRevision: z.number().int().positive(),
    operation: leaseOperationSchema,
  }),
  z.object({
    action: z.literal("renew"),
    actorKind: actorKindSchema,
    objectId: z.string().min(1).max(128),
    leaseId: z.string().min(1).max(128),
  }),
  z.object({
    action: z.literal("release"),
    actorKind: actorKindSchema,
    objectId: z.string().min(1).max(128),
    leaseId: z.string().min(1).max(128),
  }),
]);

export const presenceRequestSchema = z.object({
  actorKind: actorKindSchema,
  cursor: pointSchema.nullable(),
  viewport: pointSchema
    .extend({
      zoom: z.number().finite().positive(),
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
    })
    .nullable(),
  activity: z
    .object({
      id: z.string().min(1).max(128),
      type: z.enum(["reading", "creating", "typing", "drawing", "connecting", "moving", "annotating"]),
      label: z.string().min(1).max(160),
      objectIds: z.array(z.string().min(1).max(128)).max(200),
      progress: z.number().min(0).max(1),
      startedAt: z.number().int().nonnegative(),
      durationMs: z.number().int().min(100).max(10_000).optional(),
      fromCursor: pointSchema.nullable().optional(),
      toCursor: pointSchema.nullable().optional(),
    })
    .nullable()
    .default(null),
});

export const spotlightRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), target: actorKindSchema }),
  z.object({ action: z.literal("request"), target: actorKindSchema }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("handoff") }),
  z.object({ action: z.literal("dismiss_request") }),
  z.object({ action: z.literal("join") }),
  z.object({ action: z.literal("leave") }),
]);
