/// <reference types="webmcp-types" />

import { z } from "zod";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import type { CanvasObject, Diagram, RoomState } from "@/lib/domain/types";

import type {
  CanvasInspectionRequest,
  CanvasPreviewRenderOptions,
  CanvasPreviewSource,
} from "./canvas-preview";
import {
  CANVAS_PREVIEW_DEFAULTS,
  CANVAS_PREVIEW_LIMITS,
  CanvasPreviewError,
} from "./preview-contract";
import type {
  JazzboardToolFailure,
  JazzboardWebMcpBinding,
  JazzboardWebMcpDependencies,
  WebMcpRequest,
} from "./types";
import { withActionableRecovery } from "./actionable-failure";

const idSchema = z.string().min(1).max(128);
const revisionSchema = z.number().int().positive();
const objectTargetSchema = z
  .object({ objectId: idSchema, expectedRevision: revisionSchema })
  .strict();

const objectScopeSchema = z
  .object({
    kind: z.literal("objects"),
    targets: z.array(objectTargetSchema).min(1).max(CANVAS_PREVIEW_LIMITS.maxTargets),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.targets.forEach((target, index) => {
      if (seen.has(target.objectId)) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "objectId"],
          message: "Each preview object target must be unique.",
        });
      }
      seen.add(target.objectId);
    });
  });

const diagramScopeSchema = z
  .object({
    kind: z.literal("diagram"),
    diagramId: idSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

const roomScopeSchema = z
  .object({
    kind: z.literal("room"),
    expectedRevision: revisionSchema,
  })
  .strict();

function uniqueBoundedIds(max: number, label: string) {
  return z.array(idSchema).max(max).superRefine((values, context) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `${label} must be unique.`,
        });
      }
      seen.add(value);
    });
  });
}

const representationSchema = z.enum(["overview", "working_set", "focus"]).default("working_set");
const visualContractSchema = z
  .object({
    intent: z.string().trim().min(1).max(CANVAS_PREVIEW_LIMITS.maxContractIntentLength),
    criteria: z
      .array(z.string().trim().min(1).max(CANVAS_PREVIEW_LIMITS.maxContractCriterionLength))
      .max(CANVAS_PREVIEW_LIMITS.maxContractCriteria)
      .default([]),
    preserveObjectIds: uniqueBoundedIds(
      CANVAS_PREVIEW_LIMITS.maxContractPreserveObjectIds,
      "Visual-contract preserveObjectIds",
    ).optional(),
  })
  .strict();

const previewScopeInputShape = {
  scope: z.discriminatedUnion("kind", [objectScopeSchema, diagramScopeSchema]),
  padding: z.number().finite().min(0).max(CANVAS_PREVIEW_LIMITS.maxPadding).optional(),
};

const inspectionScopeInputShape = {
  scope: z.discriminatedUnion("kind", [roomScopeSchema, objectScopeSchema, diagramScopeSchema]),
  padding: z.number().finite().min(0).max(CANVAS_PREVIEW_LIMITS.maxPadding).optional(),
};

const inspectionInputSchema = z
  .object({
    ...inspectionScopeInputShape,
    representation: representationSchema,
    focusObjectIds: uniqueBoundedIds(CANVAS_PREVIEW_LIMITS.maxFocusedRecords, "focusObjectIds").optional(),
    visualContract: visualContractSchema.optional(),
    previousFindingKeys: uniqueBoundedIds(
      CANVAS_PREVIEW_LIMITS.maxFindingKeys,
      "previousFindingKeys",
    ).optional(),
  })
  .strict();

const previewInputSchema = z
  .object({
    ...previewScopeInputShape,
    maxWidth: z
      .number()
      .int()
      .min(CANVAS_PREVIEW_LIMITS.minDimension)
      .max(CANVAS_PREVIEW_LIMITS.maxDimension)
      .optional(),
    maxHeight: z
      .number()
      .int()
      .min(CANVAS_PREVIEW_LIMITS.minDimension)
      .max(CANVAS_PREVIEW_LIMITS.maxDimension)
      .optional(),
    pixelRatio: z.number().finite().min(1).max(CANVAS_PREVIEW_LIMITS.maxPixelRatio).optional(),
    maxBytes: z
      .number()
      .int()
      .min(CANVAS_PREVIEW_LIMITS.minBytes)
      .max(CANVAS_PREVIEW_LIMITS.maxBytes)
      .optional(),
  })
  .strict();

type AuthorizedRoomResponse = { ok: true; room: RoomState };

export {
  JAZZBOARD_PREVIEW_READ_TOOL_NAMES,
  JAZZBOARD_PREVIEW_TOOL_NAMES,
} from "./preview-contract";

function authorizedRoomRoute(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}`;
}

function failure(
  error: unknown,
  tool: "render_canvas_preview" | "inspect_canvas_scope",
): JazzboardToolFailure {
  if (error instanceof JazzboardApiError) {
    return { ok: false, tool, error: error.failure };
  }
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_TOOL_INPUT",
        message: tool === "inspect_canvas_scope"
          ? "The inspection input must identify one exact room, object, or Diagram revision scope."
          : "The preview input must identify one exact object or Diagram revision scope.",
        details: {
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      },
    };
  }
  if (error instanceof CanvasPreviewError) {
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
      message: error instanceof Error ? error.message : "Jazzboard could not render this canvas preview.",
    },
  };
}

function renderOptions(
  input: z.output<typeof previewInputSchema> | z.output<typeof inspectionInputSchema>,
): CanvasPreviewRenderOptions {
  return {
    padding: input.padding ?? CANVAS_PREVIEW_DEFAULTS.padding,
    maxWidth: "maxWidth" in input
      ? input.maxWidth ?? CANVAS_PREVIEW_DEFAULTS.maxWidth
      : CANVAS_PREVIEW_DEFAULTS.maxWidth,
    maxHeight: "maxHeight" in input
      ? input.maxHeight ?? CANVAS_PREVIEW_DEFAULTS.maxHeight
      : CANVAS_PREVIEW_DEFAULTS.maxHeight,
    pixelRatio: "pixelRatio" in input
      ? input.pixelRatio ?? CANVAS_PREVIEW_DEFAULTS.pixelRatio
      : CANVAS_PREVIEW_DEFAULTS.pixelRatio,
    maxBytes: "maxBytes" in input
      ? input.maxBytes ?? CANVAS_PREVIEW_DEFAULTS.maxBytes
      : CANVAS_PREVIEW_DEFAULTS.maxBytes,
  };
}

function resolveObjectScope(
  room: RoomState,
  scope: z.output<typeof objectScopeSchema>,
): { source: CanvasPreviewSource; objects: CanvasObject[]; diagram: null } {
  const objects = scope.targets.map((target) => {
    const object = room.objects[target.objectId];
    if (!object) {
      throw new CanvasPreviewError(
        "OBJECT_NOT_FOUND",
        `Canvas object ${target.objectId} is not in the authoritative room.`,
        { objectId: target.objectId },
      );
    }
    if (object.revision !== target.expectedRevision) {
      throw new CanvasPreviewError(
        "OBJECT_REVISION_CONFLICT",
        `Canvas object ${target.objectId} is not at the requested revision.`,
        {
          objectId: target.objectId,
          expectedRevision: target.expectedRevision,
          actualRevision: object.revision,
        },
      );
    }
    return object;
  });
  return { source: scope, objects, diagram: null };
}

function resolveDiagramScope(
  room: RoomState,
  scope: z.output<typeof diagramScopeSchema>,
): { source: CanvasPreviewSource; objects: CanvasObject[]; diagram: Diagram } {
  const diagram = room.diagrams[scope.diagramId];
  if (!diagram) {
    throw new CanvasPreviewError(
      "DIAGRAM_NOT_FOUND",
      `Diagram ${scope.diagramId} is not in the authoritative room.`,
      { diagramId: scope.diagramId },
    );
  }
  if (diagram.revision !== scope.expectedRevision) {
    throw new CanvasPreviewError(
      "DIAGRAM_REVISION_CONFLICT",
      `Diagram ${scope.diagramId} is not at the requested revision.`,
      {
        diagramId: scope.diagramId,
        expectedRevision: scope.expectedRevision,
        actualRevision: diagram.revision,
      },
    );
  }

  const objectIds = [...new Set([...diagram.memberObjectIds, ...diagram.connectorIds])];
  if (!objectIds.length) {
    throw new CanvasPreviewError("PREVIEW_SCOPE_EMPTY", `Diagram ${scope.diagramId} has no objects to render.`, {
      diagramId: scope.diagramId,
    });
  }
  if (objectIds.length > CANVAS_PREVIEW_LIMITS.maxTargets) {
    throw new CanvasPreviewError(
      "PREVIEW_SCOPE_TOO_LARGE",
      `Diagram ${scope.diagramId} exceeds the bounded preview target count.`,
      { diagramId: scope.diagramId, targetCount: objectIds.length, maxTargets: CANVAS_PREVIEW_LIMITS.maxTargets },
    );
  }
  const missingObjectIds = objectIds.filter((objectId) => !room.objects[objectId]);
  if (missingObjectIds.length) {
    throw new CanvasPreviewError(
      "DIAGRAM_MEMBERSHIP_INVALID",
      `Diagram ${scope.diagramId} references objects that are not in the authoritative room.`,
      { diagramId: scope.diagramId, objectIds: missingObjectIds },
    );
  }
  return {
    source: scope,
    objects: objectIds.map((objectId) => room.objects[objectId]),
    diagram,
  };
}

function resolveRoomScope(
  room: RoomState,
  scope: z.output<typeof roomScopeSchema>,
): { source: CanvasPreviewSource; objects: CanvasObject[]; diagram: null } {
  if (room.roomRevision !== scope.expectedRevision) {
    throw new CanvasPreviewError(
      "ROOM_REVISION_CONFLICT",
      "The Jazzboard room is not at the requested revision.",
      {
        expectedRevision: scope.expectedRevision,
        actualRevision: room.roomRevision,
      },
    );
  }
  const objects = Object.values(room.objects)
    .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
  if (objects.length > CANVAS_PREVIEW_LIMITS.maxTargets) {
    throw new CanvasPreviewError(
      "PREVIEW_SCOPE_TOO_LARGE",
      "The room exceeds the bounded inspection target count; inspect a Diagram or exact object scope.",
      { targetCount: objects.length, maxTargets: CANVAS_PREVIEW_LIMITS.maxTargets },
    );
  }
  return { source: scope, objects, diagram: null };
}

function inspectionRequest(
  input: z.output<typeof inspectionInputSchema>,
  resolved: { objects: CanvasObject[] },
): CanvasInspectionRequest {
  const scopeIds = new Set(resolved.objects.map((object) => object.id));
  const requestedFocusIds = input.focusObjectIds ?? [];
  const missingFocusObjectIds = requestedFocusIds.filter((objectId) => !scopeIds.has(objectId));
  if (missingFocusObjectIds.length) {
    throw new CanvasPreviewError(
      "PREVIEW_FOCUS_OUTSIDE_SCOPE",
      "Every focusObjectId must belong to the exact object or Diagram scope.",
      { objectIds: missingFocusObjectIds },
    );
  }
  const missingPreserveObjectIds = (input.visualContract?.preserveObjectIds ?? [])
    .filter((objectId) => !scopeIds.has(objectId));
  if (missingPreserveObjectIds.length) {
    throw new CanvasPreviewError(
      "PREVIEW_CONTRACT_OUTSIDE_SCOPE",
      "Every visual-contract preserveObjectId must belong to the exact inspection scope.",
      { objectIds: missingPreserveObjectIds },
    );
  }
  let focusObjectIds = requestedFocusIds;
  if (input.representation === "focus" && !focusObjectIds.length) {
    if (resolved.objects.length > CANVAS_PREVIEW_LIMITS.maxFocusedRecords) {
      throw new CanvasPreviewError(
        "PREVIEW_FOCUS_REQUIRED",
        "This scope is too large to infer a focus safely; provide up to 16 focusObjectIds or inspect overview/working_set.",
        { scopeObjectCount: resolved.objects.length, maxFocusedRecords: CANVAS_PREVIEW_LIMITS.maxFocusedRecords },
      );
    }
    focusObjectIds = resolved.objects.map((object) => object.id);
  }
  return {
    representation: input.representation,
    focusObjectIds,
    visualContract: input.visualContract
      ? {
          intent: input.visualContract.intent,
          criteria: input.visualContract.criteria,
          preserveObjectIds: input.visualContract.preserveObjectIds ?? [],
        }
      : null,
    previousFindingKeys: input.previousFindingKeys ?? [],
  };
}

const previewScopeInputJsonSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "objects" },
        targets: {
          type: "array",
          minItems: 1,
          maxItems: CANVAS_PREVIEW_LIMITS.maxTargets,
          uniqueItems: true,
          items: {
            type: "object",
            properties: {
              objectId: { type: "string", minLength: 1, maxLength: 128 },
              expectedRevision: { type: "integer", minimum: 1 },
            },
            required: ["objectId", "expectedRevision"],
            additionalProperties: false,
          },
        },
      },
      required: ["kind", "targets"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "diagram" },
        diagramId: { type: "string", minLength: 1, maxLength: 128 },
        expectedRevision: { type: "integer", minimum: 1 },
      },
      required: ["kind", "diagramId", "expectedRevision"],
      additionalProperties: false,
    },
  ],
};

const inspectionScopeInputJsonSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "room" },
        expectedRevision: { type: "integer", minimum: 1 },
      },
      required: ["kind", "expectedRevision"],
      additionalProperties: false,
    },
    ...previewScopeInputJsonSchema.oneOf,
  ],
};

export function createJazzboardPreviewWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies: JazzboardWebMcpDependencies = {},
): WebMCP.ModelContextTool[] {
  const transport = dependencies.canvasPreviewTransport;
  const render = binding.context.renderCanvasPreview;
  const inspect = binding.context.inspectCanvasScope;
  const present = binding.context.presentCanvasPreview;
  if (!transport || !present || (!inspect && !render)) return [];
  const request = dependencies.request ?? (apiRequest as WebMcpRequest);
  const createTool = (
    toolName: "render_canvas_preview" | "inspect_canvas_scope",
  ): WebMCP.ModelContextTool => ({
      name: toolName,
      title: toolName === "inspect_canvas_scope"
        ? "Inspect exact canvas evidence"
        : "Inspect an exact Jazzboard canvas region",
      description: toolName === "inspect_canvas_scope"
        ? "Return bounded exact room, Diagram, or object evidence plus a live inspection clip. Exact room scope exposes descriptive whole-board scale and distribution context; it never makes composition choices or quality verdicts. Prior finding keys are unverified caller comparison input."
        : "Frame an exact live canvas inspection scope.",
      inputSchema: {
        type: "object",
        properties: {
          scope: toolName === "inspect_canvas_scope"
            ? inspectionScopeInputJsonSchema
            : previewScopeInputJsonSchema,
          padding: { type: "number", minimum: 0, maximum: CANVAS_PREVIEW_LIMITS.maxPadding },
          ...(toolName === "inspect_canvas_scope" ? {
            representation: {
              enum: ["overview", "working_set", "focus"],
              default: "working_set",
              description:
                "overview, working_set, or focusObjectIds. Use room + overview after adding to existing content so relative composition is visible.",
            },
            focusObjectIds: {
              type: "array",
              maxItems: CANVAS_PREVIEW_LIMITS.maxFocusedRecords,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 128 },
            },
            visualContract: {
              type: "object",
              properties: {
                intent: {
                  type: "string",
                  minLength: 1,
                  maxLength: CANVAS_PREVIEW_LIMITS.maxContractIntentLength,
                },
                criteria: {
                  type: "array",
                  maxItems: CANVAS_PREVIEW_LIMITS.maxContractCriteria,
                  items: {
                    type: "string",
                    minLength: 1,
                    maxLength: CANVAS_PREVIEW_LIMITS.maxContractCriterionLength,
                  },
                },
                preserveObjectIds: {
                  type: "array",
                  maxItems: CANVAS_PREVIEW_LIMITS.maxContractPreserveObjectIds,
                  uniqueItems: true,
                  items: { type: "string", minLength: 1, maxLength: 128 },
                },
              },
              required: ["intent"],
              additionalProperties: false,
            },
            previousFindingKeys: {
              type: "array",
              maxItems: CANVAS_PREVIEW_LIMITS.maxFindingKeys,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 128 },
              description: "Caller-supplied, unverified keys from a prior result; comparison never proves resolution.",
            },
          } : {}),
          ...(toolName === "render_canvas_preview"
            ? {
                maxWidth: {
                  type: "integer",
                  minimum: CANVAS_PREVIEW_LIMITS.minDimension,
                  maximum: CANVAS_PREVIEW_LIMITS.maxDimension,
                },
                maxHeight: {
                  type: "integer",
                  minimum: CANVAS_PREVIEW_LIMITS.minDimension,
                  maximum: CANVAS_PREVIEW_LIMITS.maxDimension,
                },
                pixelRatio: {
                  type: "number",
                  minimum: 1,
                  maximum: CANVAS_PREVIEW_LIMITS.maxPixelRatio,
                },
                maxBytes: {
                  type: "integer",
                  minimum: CANVAS_PREVIEW_LIMITS.minBytes,
                  maximum: CANVAS_PREVIEW_LIMITS.maxBytes,
                },
              }
            : {}),
        },
        required: ["scope"],
        additionalProperties: false,
      },
      // Local camera/UI presentation is temporary and never mutates shared state.
      annotations: toolName === "inspect_canvas_scope"
        ? { readOnlyHint: true, untrustedContentHint: true }
        : { untrustedContentHint: true },
      async execute(rawInput, options) {
        try {
          const input = toolName === "inspect_canvas_scope"
            ? inspectionInputSchema.parse(rawInput)
            : previewInputSchema.parse(rawInput);
          const signal = options?.signal ?? new AbortController().signal;
          const response = await request<AuthorizedRoomResponse>(authorizedRoomRoute(binding.roomId), {
            method: "GET",
            signal,
          });
          const resolved = input.scope.kind === "room"
            ? resolveRoomScope(response.room, input.scope)
            : input.scope.kind === "objects"
              ? resolveObjectScope(response.room, input.scope)
              : resolveDiagramScope(response.room, input.scope);
          binding.context.acceptRoom(response.room);
          const prepare = toolName === "inspect_canvas_scope" ? inspect : render;
          if (!prepare) {
            throw new CanvasPreviewError(
              "PREVIEW_RENDERER_UNAVAILABLE",
              "The active canvas renderer cannot prepare this inspection surface.",
            );
          }
          const artifact = await prepare.call(
            binding.context,
            {
              roomId: binding.roomId,
              authoritativeRoomRevision: response.room.roomRevision,
              ...(toolName === "inspect_canvas_scope"
                ? { authoritativeRoomCreatedAt: response.room.createdAt }
                : {}),
              ...resolved,
              options: renderOptions(input),
              ...(toolName === "inspect_canvas_scope"
                ? { inspection: inspectionRequest(input as z.output<typeof inspectionInputSchema>, resolved) }
                : {}),
            },
            signal,
          );
          return await transport.emit(
            artifact,
            present.bind(binding.context),
            signal,
            toolName,
          );
        } catch (error) {
          return withActionableRecovery(failure(error, toolName));
        }
      },
    });
  if (binding.role === "spectator") return inspect ? [createTool("inspect_canvas_scope")] : [];
  return [
    ...(render ? [createTool("render_canvas_preview")] : []),
    ...(inspect ? [createTool("inspect_canvas_scope")] : []),
  ];
}
