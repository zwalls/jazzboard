/// <reference types="webmcp-types" />

import { z } from "zod";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import type { CanvasObject, Diagram, RoomState } from "@/lib/domain/types";
import { safeDownloadStem } from "@/lib/export-filename";

import type {
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
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpDependencies,
  WebMcpRequest,
} from "./types";

const id = z.string().min(1).max(128);
const revision = z.number().int().positive();
const objectTarget = z.object({ objectId: id, expectedRevision: revision }).strict();
const objectScope = z
  .object({
    kind: z.literal("objects"),
    targets: z.array(objectTarget).min(1).max(CANVAS_PREVIEW_LIMITS.maxTargets),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.targets.forEach((target, index) => {
      if (seen.has(target.objectId)) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "objectId"],
          message: "Each PNG target must be unique.",
        });
      }
      seen.add(target.objectId);
    });
  });
const pngExportInput = z
  .object({
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("room"), expectedRevision: revision }).strict(),
      z.object({ kind: z.literal("diagram"), diagramId: id, expectedRevision: revision }).strict(),
      objectScope,
    ]),
    filename: z.string().trim().min(1).max(160).optional(),
    padding: z.number().finite().min(0).max(CANVAS_PREVIEW_LIMITS.maxPadding).optional(),
    pixelRatio: z.number().finite().min(1).max(CANVAS_PREVIEW_LIMITS.maxPixelRatio).optional(),
  })
  .strict();

type AuthorizedRoomResponse = { ok: true; room: RoomState };
type PngExportInput = z.output<typeof pngExportInput>;

function authorizedRoomRoute(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}`;
}

function renderOptions(input: PngExportInput): CanvasPreviewRenderOptions {
  return {
    padding: input.padding ?? CANVAS_PREVIEW_DEFAULTS.padding,
    maxWidth: CANVAS_PREVIEW_LIMITS.maxDimension,
    maxHeight: CANVAS_PREVIEW_LIMITS.maxDimension,
    pixelRatio: input.pixelRatio ?? CANVAS_PREVIEW_LIMITS.maxPixelRatio,
    maxBytes: CANVAS_PREVIEW_LIMITS.maxBytes,
  };
}

function exactObject(room: RoomState, objectId: string, expectedRevision: number): CanvasObject {
  const object = room.objects[objectId];
  if (!object) {
    throw new CanvasPreviewError("OBJECT_NOT_FOUND", `Canvas object ${objectId} is not in this room.`, {
      objectId,
    });
  }
  if (object.revision !== expectedRevision) {
    throw new CanvasPreviewError(
      "OBJECT_REVISION_CONFLICT",
      `Canvas object ${objectId} is not at the requested revision.`,
      { objectId, expectedRevision, actualRevision: object.revision },
    );
  }
  return object;
}

function diagramObjects(room: RoomState, diagram: Diagram): CanvasObject[] {
  const objectIds = [...new Set([...diagram.memberObjectIds, ...diagram.connectorIds])];
  const missingObjectIds = objectIds.filter((objectId) => !room.objects[objectId]);
  if (missingObjectIds.length) {
    throw new CanvasPreviewError(
      "DIAGRAM_MEMBERSHIP_INVALID",
      `Diagram ${diagram.id} references unavailable canvas objects.`,
      { diagramId: diagram.id, objectIds: missingObjectIds },
    );
  }
  return objectIds.map((objectId) => room.objects[objectId]);
}

function resolveScope(room: RoomState, input: PngExportInput): {
  source: CanvasPreviewSource;
  objects: CanvasObject[];
  diagram: Diagram | null;
  defaultName: string;
} {
  if (input.scope.kind === "room") {
    if (room.roomRevision !== input.scope.expectedRevision) {
      throw new CanvasPreviewError(
        "ROOM_REVISION_CONFLICT",
        "The room is not at the requested revision.",
        {
          expectedRevision: input.scope.expectedRevision,
          actualRevision: room.roomRevision,
        },
      );
    }
    return {
      source: input.scope,
      objects: Object.values(room.objects),
      diagram: null,
      defaultName: room.title,
    };
  }

  if (input.scope.kind === "diagram") {
    const diagram = room.diagrams[input.scope.diagramId];
    if (!diagram) {
      throw new CanvasPreviewError(
        "DIAGRAM_NOT_FOUND",
        `Diagram ${input.scope.diagramId} is not in this room.`,
        { diagramId: input.scope.diagramId },
      );
    }
    if (diagram.revision !== input.scope.expectedRevision) {
      throw new CanvasPreviewError(
        "DIAGRAM_REVISION_CONFLICT",
        `Diagram ${diagram.id} is not at the requested revision.`,
        {
          diagramId: diagram.id,
          expectedRevision: input.scope.expectedRevision,
          actualRevision: diagram.revision,
        },
      );
    }
    return {
      source: input.scope,
      objects: diagramObjects(room, diagram),
      diagram,
      defaultName: diagram.title,
    };
  }

  return {
    source: input.scope,
    objects: input.scope.targets.map((target) =>
      exactObject(room, target.objectId, target.expectedRevision)),
    diagram: null,
    defaultName: `${room.title} selection`,
  };
}

function failure(error: unknown): JazzboardToolFailure {
  if (error instanceof JazzboardApiError) {
    return { ok: false, tool: "export_canvas_png", error: error.failure };
  }
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      tool: "export_canvas_png",
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "PNG export requires one exact room, Diagram, or object-revision scope.",
        details: {
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      },
    };
  }
  if (error instanceof CanvasPreviewError) {
    return {
      ok: false,
      tool: "export_canvas_png",
      error: { code: error.code, message: error.message, details: error.details },
    };
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return {
      ok: false,
      tool: "export_canvas_png",
      error: { code: "TOOL_ABORTED", message: "The PNG export was cancelled." },
    };
  }
  return {
    ok: false,
    tool: "export_canvas_png",
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: error instanceof Error ? error.message : "Jazzboard could not export this PNG.",
    },
  };
}

export const JAZZBOARD_PNG_EXPORT_TOOL_NAMES = ["export_canvas_png"] as const;

/** Downloads a faithful local PNG; it never uploads or persists the rendered bytes. */
export function createJazzboardPngExportWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies: JazzboardWebMcpDependencies = {},
): WebMCP.ModelContextTool[] {
  const render = binding.context.renderCanvasPreview;
  const save = binding.context.saveCanvasPng;
  if (!render || !save) return [];
  const request = dependencies.request ?? (apiRequest as WebMcpRequest);

  return [{
    name: "export_canvas_png",
    title: "Download a faithful canvas PNG",
    description:
      "Render an exact authorized board, Diagram, or object set through the live tldraw canvas and download a flattened PNG with images. The file stays in this browser and is never uploaded or persisted by Jazzboard.",
    inputSchema: z.toJSONSchema(pngExportInput, { io: "input", reused: "ref" }) as WebMCP.ModelContextTool["inputSchema"],
    // The download is a local browser side effect, so readOnlyHint would be
    // misleading even though shared Jazzboard state is never mutated.
    annotations: { untrustedContentHint: true },
    async execute(rawInput, options): Promise<JazzboardToolResult> {
      try {
        const input = pngExportInput.parse(rawInput);
        const signal = options?.signal ?? new AbortController().signal;
        const response = await request<AuthorizedRoomResponse>(authorizedRoomRoute(binding.roomId), {
          method: "GET",
          signal,
        });
        const resolved = resolveScope(response.room, input);
        if (!resolved.objects.length) {
          throw new CanvasPreviewError("PREVIEW_SCOPE_EMPTY", "This PNG scope contains no canvas objects.");
        }
        binding.context.acceptRoom(response.room);
        const artifact = await render.call(binding.context, {
          roomId: binding.roomId,
          authoritativeRoomRevision: response.room.roomRevision,
          source: resolved.source,
          objects: resolved.objects,
          diagram: resolved.diagram,
          options: renderOptions(input),
        }, signal);
        const requestedName = (input.filename ?? resolved.defaultName).replace(/\.png$/i, "");
        const filename = `${safeDownloadStem(requestedName, "jazzboard")}.png`;
        await save.call(binding.context, artifact, filename, signal);
        return {
          ok: true,
          tool: "export_canvas_png",
          data: {
            filename,
            mimeType: artifact.metadata.mimeType,
            width: artifact.metadata.width,
            height: artifact.metadata.height,
            byteLength: artifact.metadata.byteLength,
            sourceRevisions: artifact.metadata.source,
            warnings: artifact.metadata.warnings,
            persistedByJazzboard: false,
          },
        };
      } catch (error) {
        return failure(error);
      }
    },
  }];
}
