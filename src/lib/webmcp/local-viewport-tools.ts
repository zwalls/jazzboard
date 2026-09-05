/// <reference types="webmcp-types" />

import { z } from "zod";

import type { CanvasRuntime } from "@/lib/canvas/runtime";
import { JazzboardApiError } from "@/lib/client/api";
import type { CanvasBounds, RoomState, Viewport } from "@/lib/domain/types";

import { withActionableRecovery } from "./actionable-failure";
import type {
  JazzboardToolFailure,
  JazzboardToolResult,
  JazzboardWebMcpBinding,
} from "./types";

export const LOCAL_VIEWPORT_LIMITS = Object.freeze({
  defaultZoomFactor: 1.2,
  minZoomFactor: 1.01,
  maxZoomFactor: 2,
  defaultInset: 96,
  maxInset: 320,
  maxObjectIds: 64,
});

const id = z.string().trim().min(1).max(128);
const inputSchema = z.object({
  action: z.enum(["read", "zoom_in", "zoom_out", "fit_room", "fit_diagram", "fit_objects"]),
  factor: z.number().min(LOCAL_VIEWPORT_LIMITS.minZoomFactor).max(LOCAL_VIEWPORT_LIMITS.maxZoomFactor).optional(),
  inset: z.number().min(0).max(LOCAL_VIEWPORT_LIMITS.maxInset).optional(),
  diagramId: id.optional(),
  objectIds: z.array(id).min(1).max(LOCAL_VIEWPORT_LIMITS.maxObjectIds)
    .refine((ids) => new Set(ids).size === ids.length, "Object IDs must be unique.")
    .optional(),
  dismissWalkthrough: z.boolean().optional(),
}).strict().superRefine((input, context) => {
  const isZoom = input.action === "zoom_in" || input.action === "zoom_out";
  if (!isZoom && input.factor !== undefined) {
    context.addIssue({ code: "custom", path: ["factor"], message: "factor is valid only for zoom_in or zoom_out." });
  }
  const isFit = input.action === "fit_room" || input.action === "fit_diagram" || input.action === "fit_objects";
  if (!isFit && input.inset !== undefined) {
    context.addIssue({ code: "custom", path: ["inset"], message: "inset is valid only for fit actions." });
  }
  if (!isFit && input.dismissWalkthrough !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["dismissWalkthrough"],
      message: "dismissWalkthrough is valid only for fit actions.",
    });
  }
  if ((input.action === "fit_diagram") !== (input.diagramId !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["diagramId"],
      message: input.action === "fit_diagram"
        ? "fit_diagram requires one exact diagramId."
        : "diagramId is valid only with fit_diagram.",
    });
  }
  if ((input.action === "fit_objects") !== (input.objectIds !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["objectIds"],
      message: input.action === "fit_objects"
        ? "fit_objects requires exact objectIds."
        : "objectIds is valid only with fit_objects.",
    });
  }
});

type LocalViewportInput = z.output<typeof inputSchema>;

class LocalViewportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function failure(tool: string, error: unknown): JazzboardToolFailure {
  if (error instanceof JazzboardApiError) return { ok: false, tool, error: error.failure };
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "The local viewport input is invalid or exceeds its camera limits.",
        details: {
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      },
    };
  }
  if (error instanceof LocalViewportError) {
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
      message: error instanceof Error ? error.message : "Jazzboard could not change the local viewport.",
    },
  };
}

function sameViewport(left: Viewport, right: Viewport): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width
    && left.height === right.height && left.zoom === right.zoom;
}

function currentRuntime(binding: JazzboardWebMcpBinding): CanvasRuntime {
  const runtime = binding.context.getCanvasRuntime?.();
  if (!runtime) {
    throw new LocalViewportError(
      "CANVAS_UNAVAILABLE",
      "The live Jazzboard canvas is not ready for local viewport control.",
    );
  }
  return runtime;
}

function currentRoom(binding: JazzboardWebMcpBinding): RoomState {
  const room = binding.context.getRoom();
  if (!room || room.id !== binding.roomId) {
    throw new LocalViewportError("ROOM_UNAVAILABLE", "The authorized Jazzboard room is not loaded.");
  }
  return room;
}

function renderedBounds(runtime: CanvasRuntime, room: RoomState, objectIds: readonly string[]): CanvasBounds {
  const missingObjectIds = objectIds.filter((objectId) => !room.objects[objectId]);
  if (missingObjectIds.length) {
    throw new LocalViewportError(
      "OBJECT_NOT_FOUND",
      "One or more viewport targets are not in the current room.",
      { objectIds: missingObjectIds },
    );
  }
  const unavailableObjectIds = objectIds.filter((objectId) => !runtime.hasObject(objectId));
  if (unavailableObjectIds.length) {
    throw new LocalViewportError(
      "CANVAS_UNAVAILABLE",
      "One or more current room objects are not rendered yet.",
      { objectIds: unavailableObjectIds },
    );
  }
  const bounds = runtime.getVisibleBounds(objectIds);
  if (!bounds) {
    throw new LocalViewportError(
      "CANVAS_UNAVAILABLE",
      "Jazzboard could not resolve rendered bounds for the requested viewport targets.",
      { objectIds },
    );
  }
  return bounds;
}

function scopeAndBounds(
  binding: JazzboardWebMcpBinding,
  runtime: CanvasRuntime,
  input: LocalViewportInput,
): { scope: Record<string, unknown>; bounds: CanvasBounds } {
  const room = currentRoom(binding);
  if (input.action === "fit_diagram") {
    const diagram = room.diagrams[input.diagramId!];
    if (!diagram) {
      throw new LocalViewportError(
        "DIAGRAM_NOT_FOUND",
        "The requested Diagram is not in the current room.",
        { diagramId: input.diagramId },
      );
    }
    return {
      scope: { type: "diagram", diagramId: diagram.id, diagramRevision: diagram.revision },
      bounds: diagram.bounds,
    };
  }
  const objectIds = input.action === "fit_objects"
    ? input.objectIds!
    : Object.keys(room.objects).filter((objectId) => runtime.hasObject(objectId));
  if (!objectIds.length) {
    throw new LocalViewportError(
      input.action === "fit_room" && Object.keys(room.objects).length ? "CANVAS_UNAVAILABLE" : "EMPTY_CANVAS",
      input.action === "fit_room" && Object.keys(room.objects).length
        ? "The current room objects are not rendered yet."
        : "The current room has no objects to fit.",
    );
  }
  return {
    scope: input.action === "fit_objects"
      ? { type: "objects", objectIds }
      : { type: "room", objectCount: objectIds.length, roomRevision: room.roomRevision },
    bounds: renderedBounds(runtime, room, objectIds),
  };
}

function dismissActiveWalkthrough(binding: JazzboardWebMcpBinding): {
  stopped: boolean;
  walkthroughId: string | null;
} {
  const getWalkthrough = binding.context.getGuidedWalkthrough;
  const stopWalkthrough = binding.context.stopGuidedWalkthrough;
  if (!getWalkthrough || !stopWalkthrough) {
    throw new LocalViewportError(
      "WALKTHROUGH_UNAVAILABLE",
      "The live Jazzboard walkthrough controls are not ready.",
    );
  }
  const active = getWalkthrough();
  if (!active) return { stopped: false, walkthroughId: null };

  stopWalkthrough(active.id);
  if (getWalkthrough()?.id === active.id) {
    throw new LocalViewportError(
      "WALKTHROUGH_DISMISSAL_FAILED",
      "The active guided walkthrough could not be dismissed.",
      { walkthroughId: active.id },
    );
  }
  return { stopped: true, walkthroughId: active.id };
}

export const JAZZBOARD_LOCAL_VIEWPORT_TOOL_NAMES = ["control_local_viewport"] as const;

/** Reversible camera control local to this browser for participants and spectators. */
export function createJazzboardLocalViewportWebMcpTools(
  binding: JazzboardWebMcpBinding,
): WebMCP.ModelContextTool[] {
  return [{
    name: "control_local_viewport",
    title: "Control the local Jazzboard viewport",
    description:
      "Read or change only this browser's canvas camera. Zoom keeps its center; fit uses the room, one exact Diagram ID, or 1–64 exact object IDs. Fits preserve the guided walkthrough unless dismissWalkthrough is true; then the fit target is validated before the active local tour is stopped. Selection stays intact. No document or presence data changes. Use focus_viewport when followers should track the agent.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          enum: ["read", "zoom_in", "zoom_out", "fit_room", "fit_diagram", "fit_objects"],
          description: "Camera operation; read makes no change.",
        },
        factor: {
          type: "number",
          minimum: LOCAL_VIEWPORT_LIMITS.minZoomFactor,
          maximum: LOCAL_VIEWPORT_LIMITS.maxZoomFactor,
          description: "Zoom multiplier; defaults to 1.2.",
        },
        inset: {
          type: "number",
          minimum: 0,
          maximum: LOCAL_VIEWPORT_LIMITS.maxInset,
          description: "Fit inset in CSS pixels; defaults to 96.",
        },
        diagramId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Exact Diagram ID for fit_diagram.",
        },
        objectIds: {
          type: "array",
          minItems: 1,
          maxItems: LOCAL_VIEWPORT_LIMITS.maxObjectIds,
          items: { type: "string", minLength: 1, maxLength: 128 },
          description: "Unique exact object IDs for fit_objects.",
        },
        dismissWalkthrough: {
          type: "boolean",
          description: "Fit actions only. Set true to stop the active local guided walkthrough after validating the fit target and before framing it. Defaults to false.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(rawInput, options): Promise<JazzboardToolResult> {
      const executionStartedAt = performance.now();
      try {
        const input = inputSchema.parse(rawInput);
        const signal = options?.signal ?? new AbortController().signal;
        if (signal.aborted) throw new DOMException("The viewport operation was cancelled.", "AbortError");
        const runtime = currentRuntime(binding);
        const before = runtime.getViewport();
        let scope: Record<string, unknown> = { type: "current_viewport" };
        let walkthroughDismissal = {
          requested: false,
          stopped: false,
          walkthroughId: null as string | null,
        };

        if (input.action === "zoom_in" || input.action === "zoom_out") {
          const factor = input.factor ?? LOCAL_VIEWPORT_LIMITS.defaultZoomFactor;
          runtime.zoomToBounds(before, {
            targetZoom: input.action === "zoom_in" ? before.zoom * factor : before.zoom / factor,
            durationMs: 120,
            force: true,
            publishPresence: false,
          });
          scope = { type: "viewport_center", factor };
        } else if (input.action !== "read") {
          const target = scopeAndBounds(binding, runtime, input);
          if (input.dismissWalkthrough) {
            walkthroughDismissal = {
              requested: true,
              ...dismissActiveWalkthrough(binding),
            };
          }
          runtime.zoomToBounds(target.bounds, {
            inset: input.inset ?? LOCAL_VIEWPORT_LIMITS.defaultInset,
            durationMs: 180,
            force: true,
            publishPresence: false,
          });
          scope = target.scope;
        }

        const viewport = runtime.getViewport();
        const handlerDurationMs = performance.now() - executionStartedAt;
        return {
          ok: true,
          tool: "control_local_viewport",
          data: {
            action: input.action,
            viewport,
            changed: !sameViewport(before, viewport),
            scope,
            localOnly: true,
            presencePublished: false,
            walkthroughDismissal,
            executionTiming: {
              handlerDurationMs,
              measurement: "execute_entry_to_result_preparation",
              excludes: ["webmcp_transport", "react_paint"],
            },
          },
        };
      } catch (error) {
        return withActionableRecovery(failure("control_local_viewport", error));
      }
    },
  }];
}
