/// <reference types="webmcp-types" />

import { z } from "zod";

import {
  GUIDED_WALKTHROUGH_LIMITS,
  guidedWalkthroughStatus,
  type GuidedWalkthrough,
} from "@/lib/canvas/guided-walkthrough";
import { JazzboardApiError } from "@/lib/client/api";

import type {
  JazzboardToolFailure,
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpDependencies,
} from "./types";
import { withActionableRecovery } from "./actionable-failure";

const id = z.string().trim().min(1).max(128);
const uniqueIds = z.array(id).max(GUIDED_WALKTHROUGH_LIMITS.maxTargetsPerKind).default([])
  .refine((ids) => new Set(ids).size === ids.length, "Target IDs must be unique.");
const stepInput = z.object({
  caption: z.string().trim().min(1).max(GUIDED_WALKTHROUGH_LIMITS.maxCaptionLength),
  details: z.string().trim().min(1).max(GUIDED_WALKTHROUGH_LIMITS.maxDetailsLength).optional(),
  objectIds: uniqueIds,
  connectorIds: uniqueIds,
}).strict().refine(
  (step) => step.objectIds.length + step.connectorIds.length > 0,
  "Each walkthrough step needs at least one object or connector target.",
);
const startInput = z.object({
  title: z.string().trim().min(1).max(GUIDED_WALKTHROUGH_LIMITS.maxTitleLength).default("Guided walkthrough"),
  steps: z.array(stepInput).min(1).max(GUIDED_WALKTHROUGH_LIMITS.maxSteps),
}).strict();
const statusInput = z.object({}).strict();
const stopInput = z.object({ walkthroughId: id.optional() }).strict();
const navigateInput = z.object({
  walkthroughId: id,
  expectedRevision: z.number().int().positive(),
  expectedStep: z.number().int().min(1).max(GUIDED_WALKTHROUGH_LIMITS.maxSteps),
  action: z.enum(["next", "back", "go_to"]),
  step: z.number().int().min(1).max(GUIDED_WALKTHROUGH_LIMITS.maxSteps).optional(),
}).strict().superRefine((input, context) => {
  if (input.action === "go_to" && input.step === undefined) {
    context.addIssue({ code: "custom", path: ["step"], message: "go_to requires a 1-based step." });
  }
  if (input.action !== "go_to" && input.step !== undefined) {
    context.addIssue({ code: "custom", path: ["step"], message: "step is valid only with go_to." });
  }
});

class GuidedWalkthroughError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function failure(tool: string, error: unknown): JazzboardToolFailure {
  if (error instanceof JazzboardApiError) return { ok: false, tool, error: error.failure };
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "The guided walkthrough input is invalid or exceeds its presentation limits.",
        details: { issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
      },
    };
  }
  if (error instanceof GuidedWalkthroughError) {
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
      message: error instanceof Error ? error.message : "Jazzboard could not present this guided walkthrough.",
    },
  };
}

function compactInputSchema(schema: z.ZodType): WebMCP.ModelContextTool["inputSchema"] {
  const generated = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  const compact = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(compact);
      return;
    }
    const record = value as Record<string, unknown>;
    delete record.$schema;
    if (record.maximum === Number.MAX_SAFE_INTEGER) delete record.maximum;
    if (record.const !== undefined || Array.isArray(record.enum)) delete record.type;
    Object.values(record).forEach(compact);
  };
  compact(generated);
  return generated;
}

function defineTool<TSchema extends z.ZodType>(input: {
  name: string;
  title: string;
  description: string;
  schema: TSchema;
  execute: (value: z.output<TSchema>, signal: AbortSignal, executionStartedAt: number) => unknown;
}): WebMCP.ModelContextTool {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema: compactInputSchema(input.schema),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(rawInput, options): Promise<JazzboardToolResult> {
      const executionStartedAt = performance.now();
      try {
        const parsed = input.schema.parse(rawInput);
        const signal = options?.signal ?? new AbortController().signal;
        if (signal.aborted) throw new DOMException("The walkthrough was cancelled.", "AbortError");
        return { ok: true, tool: input.name, data: await input.execute(parsed, signal, executionStartedAt) };
      } catch (error) {
        return withActionableRecovery(failure(input.name, error));
      }
    },
  };
}

function displayedExecutionTiming(executionStartedAt: number) {
  return {
    handlerDurationMs: performance.now() - executionStartedAt,
    measurement: "execute_entry_to_result_preparation",
    includes: ["awaited_walkthrough_display"],
    excludes: ["webmcp_transport"],
  };
}

export const JAZZBOARD_GUIDED_WALKTHROUGH_TOOL_NAMES = [
  "start_guided_walkthrough",
  "get_guided_walkthrough_status",
  "navigate_guided_walkthrough",
  "stop_guided_walkthrough",
] as const;

/** Local presentation tools shared by participants and spectators. */
export function createJazzboardGuidedWalkthroughWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies: JazzboardWebMcpDependencies = {},
): WebMCP.ModelContextTool[] {
  const present = binding.context.presentGuidedWalkthrough;
  const get = binding.context.getGuidedWalkthrough;
  const getDisplay = binding.context.getGuidedWalkthroughDisplay;
  const stop = binding.context.stopGuidedWalkthrough;
  const waitForDisplay = binding.context.waitForGuidedWalkthroughDisplay;
  if (!present || !get || !getDisplay || !stop || !waitForDisplay) return [];
  const createId = dependencies.createId ?? defaultCreateId;

  const status = (walkthrough = get()) => guidedWalkthroughStatus(
    walkthrough,
    binding.context.getRoom(),
    getDisplay(),
  );

  return [
    defineTool({
      name: "start_guided_walkthrough",
      title: "Start a guided canvas walkthrough",
      description:
        "Use when the user asks to explain or trace a diagram path. Supply the complete step sequence once; the user advances locally with Next or Back and may open caption details. Success waits for the first overlay, highlights, and readable local camera frame. The tour does not select, edit, publish shared board data, or synchronize spoken narration.",
      schema: startInput,
      async execute(input, signal, executionStartedAt) {
        const room = binding.context.getRoom();
        if (!room) {
          throw new GuidedWalkthroughError("ROOM_UNAVAILABLE", "The authorized Jazzboard room is not loaded.");
        }
        const missingObjectIds = new Set<string>();
        const wrongObjectIds = new Set<string>();
        const missingConnectorIds = new Set<string>();
        const wrongConnectorIds = new Set<string>();
        for (const step of input.steps) {
          for (const objectId of step.objectIds) {
            const object = room.objects[objectId];
            if (!object) missingObjectIds.add(objectId);
            else if (object.kind === "connector") wrongObjectIds.add(objectId);
          }
          for (const connectorId of step.connectorIds) {
            const object = room.objects[connectorId];
            if (!object) missingConnectorIds.add(connectorId);
            else if (object.kind !== "connector") wrongConnectorIds.add(connectorId);
          }
        }
        if (
          missingObjectIds.size || wrongObjectIds.size
          || missingConnectorIds.size || wrongConnectorIds.size
        ) {
          throw new GuidedWalkthroughError(
            "WALKTHROUGH_TARGET_INVALID",
            "Every walkthrough target must exist in the current room and match its object or connector target kind.",
            {
              missingObjectIds: [...missingObjectIds],
              connectorIdsSuppliedAsObjects: [...wrongObjectIds],
              missingConnectorIds: [...missingConnectorIds],
              objectIdsSuppliedAsConnectors: [...wrongConnectorIds],
            },
          );
        }
        const walkthrough: GuidedWalkthrough = {
          id: createId("walkthrough"),
          roomId: binding.roomId,
          revision: 1,
          title: input.title,
          steps: input.steps,
          currentStepIndex: 0,
          startedAt: Date.now(),
        };
        present(walkthrough);
        await waitForDisplay(walkthrough.id, walkthrough.revision, signal);
        const current = get();
        return {
          ...status(current?.id === walkthrough.id ? current : null),
          executionTiming: displayedExecutionTiming(executionStartedAt),
        };
      },
    }),
    defineTool({
      name: "get_guided_walkthrough_status",
      title: "Get guided walkthrough status",
      description:
        "Read the active local walkthrough and current step without changing the canvas, tour, or shared room.",
      schema: statusInput,
      execute() {
        return status();
      },
    }),
    defineTool({
      name: "navigate_guided_walkthrough",
      title: "Navigate a displayed walkthrough step",
      description:
        "Advance, go back, or jump from the last displayed step. Reuse the previous receipt fences: normal Next/Back is one call; skip a status read. Explain the returned step in text or voice; refresh status only for missing context or conflict. Required ID, revision, and 1-based step fences reject stale commands after manual controls or replacement. Success waits for the next overlay, highlights, and local camera projection; it does not prove pixel inspection or completed avatar animation.",
      schema: navigateInput,
      async execute(input, signal, executionStartedAt) {
        const current = get();
        if (
          !current
          || current.id !== input.walkthroughId
          || current.revision !== input.expectedRevision
          || current.currentStepIndex + 1 !== input.expectedStep
        ) {
          throw new GuidedWalkthroughError(
            "WALKTHROUGH_REVISION_CONFLICT",
            "The walkthrough changed or exited before this navigation command.",
            {
              expectedWalkthroughId: input.walkthroughId,
              expectedRevision: input.expectedRevision,
              expectedStep: input.expectedStep,
              actualWalkthroughId: current?.id ?? null,
              actualRevision: current?.revision ?? null,
              actualStep: current ? current.currentStepIndex + 1 : null,
            },
          );
        }
        const currentDisplay = getDisplay();
        if (
          currentDisplay?.walkthroughId !== current.id
          || currentDisplay.revision !== current.revision
          || currentDisplay.stepIndex !== current.currentStepIndex
        ) {
          throw new GuidedWalkthroughError(
            "WALKTHROUGH_NOT_DISPLAYED",
            "The expected walkthrough step is still pending and cannot be handed off yet.",
            { walkthroughId: current.id, revision: current.revision, step: current.currentStepIndex + 1 },
          );
        }
        const destination = input.action === "next"
          ? current.currentStepIndex + 1
          : input.action === "back"
            ? current.currentStepIndex - 1
            : input.step! - 1;
        if (destination < 0 || destination >= current.steps.length) {
          throw new GuidedWalkthroughError(
            "WALKTHROUGH_STEP_OUT_OF_RANGE",
            "The requested walkthrough step is outside the current tour.",
            { requestedStep: destination + 1, stepCount: current.steps.length },
          );
        }
        const next: GuidedWalkthrough = {
          ...current,
          currentStepIndex: destination,
          revision: current.revision + 1,
        };
        present(next);
        const displayed = await waitForDisplay(next.id, next.revision, signal);
        const latest = get();
        if (
          !latest
          || latest.id !== next.id
          || latest.revision !== next.revision
          || latest.currentStepIndex !== next.currentStepIndex
        ) {
          throw new GuidedWalkthroughError(
            "WALKTHROUGH_STATE_CHANGED",
            "The walkthrough changed, exited, or lost its targets while the next step was being displayed.",
            {
              requestedRevision: next.revision,
              actualWalkthroughId: latest?.id ?? null,
              actualRevision: latest?.revision ?? null,
              actualStep: latest ? latest.currentStepIndex + 1 : null,
            },
          );
        }
        if (!displayed) {
          throw new GuidedWalkthroughError(
            "WALKTHROUGH_DISPLAY_TIMEOUT",
            "Jazzboard did not confirm the requested overlay and local camera projection within the bounded display window.",
            { walkthroughId: next.id, revision: next.revision, step: next.currentStepIndex + 1 },
          );
        }
        return {
          ...status(latest),
          executionTiming: displayedExecutionTiming(executionStartedAt),
        };
      },
    }),
    defineTool({
      name: "stop_guided_walkthrough",
      title: "Stop a guided canvas walkthrough",
      description:
        "Dismiss the temporary local walkthrough. Optionally fence the request to the active walkthrough ID so an older request cannot close a newer tour.",
      schema: stopInput,
      execute(input) {
        const current = get();
        if (input.walkthroughId && current?.id !== input.walkthroughId) {
          throw new GuidedWalkthroughError(
            "WALKTHROUGH_ID_CONFLICT",
            "The active walkthrough does not match the requested walkthrough ID.",
            { expectedWalkthroughId: input.walkthroughId, actualWalkthroughId: current?.id ?? null },
          );
        }
        stop(input.walkthroughId);
        return { stopped: Boolean(current), walkthroughId: current?.id ?? null };
      },
    }),
  ];
}
