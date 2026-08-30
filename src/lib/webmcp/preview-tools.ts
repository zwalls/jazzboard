/// <reference types="webmcp-types" />

import { z } from "zod";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import type { CanvasObject, Diagram, RoomState } from "@/lib/domain/types";

import type { CanvasPreviewRenderOptions, CanvasPreviewSource } from "./canvas-preview";
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

const scopeInputShape = {
  scope: z.discriminatedUnion("kind", [objectScopeSchema, diagramScopeSchema]),
  padding: z.number().finite().min(0).max(CANVAS_PREVIEW_LIMITS.maxPadding).optional(),
};

const inspectionInputSchema = z.object(scopeInputShape).strict();

const previewInputSchema = z
  .object({
    ...scopeInputShape,
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
        message: "The preview input must identify one exact object or diagram revision scope.",
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
        ? "Return exact-revision semantic, geometry, quality/coverage evidence and a clean live screenshotClip. Pixels remain uninspected until the valid clip is examined."
        : "Validate and locally frame up to 1,000 exact object or Diagram targets on the live canvas; unavailable during Follow or Spotlight, and framing is not visual QA.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            ...(toolName === "inspect_canvas_scope" ? {
              type: "object",
              description: "Exactly {\"kind\":\"objects\",\"targets\":[{\"objectId\":\"id\",\"expectedRevision\":1}]} or {\"kind\":\"diagram\",\"diagramId\":\"id\",\"expectedRevision\":1}.",
            } : { oneOf: [
              {
                type: "object",
                properties: {
                  kind: { const: "objects" },
                  targets: {
                    type: "array",
                    minItems: 1,
                    maxItems: CANVAS_PREVIEW_LIMITS.maxTargets,
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
            ] }),
          },
          padding: { type: "number", minimum: 0, maximum: CANVAS_PREVIEW_LIMITS.maxPadding },
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
          const resolved =
            input.scope.kind === "objects"
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
              ...resolved,
              options: renderOptions(input),
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
          return failure(error, toolName);
        }
      },
    });
  if (binding.role === "spectator") return inspect ? [createTool("inspect_canvas_scope")] : [];
  return [
    ...(render ? [createTool("render_canvas_preview")] : []),
    ...(inspect ? [createTool("inspect_canvas_scope")] : []),
  ];
}
