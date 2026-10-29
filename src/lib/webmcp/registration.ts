/// <reference types="webmcp-types" />

import {
  createJazzboardLifecycleWebMcpTools,
  JAZZBOARD_LIFECYCLE_READ_TOOL_NAMES,
  JAZZBOARD_LIFECYCLE_TOOL_NAMES,
} from "./lifecycle-tools";
import {
  createJazzboardWebMcpTools,
  JAZZBOARD_WEBMCP_READ_TOOL_NAMES,
  JAZZBOARD_WEBMCP_TOOL_NAMES,
} from "./tools";
import {
  createJazzboardSemanticWebMcpTools,
  JAZZBOARD_SEMANTIC_READ_TOOL_NAMES,
  JAZZBOARD_SEMANTIC_TOOL_NAMES,
} from "./semantic-tools";
import {
  createJazzboardDraftWebMcpTools,
  JAZZBOARD_DRAFT_READ_TOOL_NAMES,
  JAZZBOARD_DRAFT_TOOL_NAMES,
} from "./draft-tools";
import {
  createJazzboardActivityWebMcpTools,
  JAZZBOARD_ACTIVITY_READ_TOOL_NAMES,
  JAZZBOARD_ACTIVITY_TOOL_NAMES,
} from "./activity-tools";
import {
  createJazzboardInterchangeWebMcpTools,
  JAZZBOARD_INTERCHANGE_PARTICIPANT_TOOL_NAMES,
  JAZZBOARD_INTERCHANGE_SPECTATOR_TOOL_NAMES,
} from "./interchange-tools";
import {
  createJazzboardReviewWebMcpTools,
  JAZZBOARD_REVIEW_READ_TOOL_NAMES,
  JAZZBOARD_REVIEW_TOOL_NAMES,
} from "./review-tools";
import {
  createJazzboardPreviewWebMcpTools,
  JAZZBOARD_PREVIEW_READ_TOOL_NAMES,
  JAZZBOARD_PREVIEW_TOOL_NAMES,
} from "./preview-tools";
import {
  createJazzboardMessageWebMcpTools,
  JAZZBOARD_MESSAGE_TOOL_NAMES,
} from "./message-tools";
import {
  createJazzboardPngExportWebMcpTools,
  JAZZBOARD_PNG_EXPORT_TOOL_NAMES,
} from "./png-export-tools";
import {
  createJazzboardCanvasCapabilityWebMcpTools,
  JAZZBOARD_CANVAS_CAPABILITY_TOOL_NAMES,
} from "./capability-tools";
import {
  createJazzboardGuidedWalkthroughWebMcpTools,
  JAZZBOARD_GUIDED_WALKTHROUGH_TOOL_NAMES,
} from "./guided-walkthrough-tools";
import {
  createJazzboardLocalViewportWebMcpTools,
  JAZZBOARD_LOCAL_VIEWPORT_TOOL_NAMES,
} from "./local-viewport-tools";
import type {
  JazzboardWebMcpBinding,
  JazzboardWebMcpDependencies,
  JazzboardWebMcpRegistrationStatus,
  ModelContextProvider,
} from "./types";

function documentModelContext(): WebMCP.ModelContext | undefined {
  return typeof document === "undefined" ? undefined : document.modelContext;
}

/** Compact redundant validation syntax while retaining every input description. */
export function compactRegisteredInputSchema(
  inputSchema: WebMCP.ModelContextTool["inputSchema"],
): WebMCP.ModelContextTool["inputSchema"] {
  if (!inputSchema) return inputSchema;
  const compacted = structuredClone(inputSchema);
  delete (compacted as Record<string, unknown>).$schema;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const schema = value as Record<string, unknown>;
    if (schema.type === "string" && (
      typeof schema.const === "string"
      || (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((entry) => typeof entry === "string"))
    )) delete schema.type;
    if (schema.type === "integer" && schema.exclusiveMinimum === 0 && !Object.hasOwn(schema, "minimum")) {
      delete schema.exclusiveMinimum;
      schema.minimum = 1;
    }
    // A closed object with no declared or patterned keys accepts only {}.
    if (
      schema.type === "object" && schema.additionalProperties === false
      && schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      && Object.keys(schema.properties).length === 0 && !Object.hasOwn(schema, "patternProperties")
      && (!Object.hasOwn(schema, "maxProperties") || (typeof schema.maxProperties === "number" && Number.isInteger(schema.maxProperties) && schema.maxProperties >= 0))
    ) {
      delete schema.properties;
      delete schema.additionalProperties;
      schema.maxProperties = 0;
    }
    // anyOf(type A, type B) is exactly a type union; oneOf is deliberately left alone.
    if (!Object.hasOwn(schema, "type") && Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
      const types = schema.anyOf.map((branch) => (
        branch && typeof branch === "object" && !Array.isArray(branch) && Object.keys(branch).length === 1
          ? (branch as Record<string, unknown>).type
          : undefined
      ));
      if (types.every((type) => typeof type === "string" && ["null", "boolean", "object", "array", "number", "integer", "string"].includes(type))) {
        schema.type = [...new Set(types)];
        delete schema.anyOf;
      }
    }
    for (const keyword of ["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"]) {
      const children = schema[keyword];
      if (children && typeof children === "object") Object.values(children).forEach(visit);
    }
    for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      const children = schema[keyword];
      if (Array.isArray(children)) children.forEach(visit);
    }
    for (const keyword of ["items", "additionalProperties", "unevaluatedProperties", "contains", "propertyNames", "not", "if", "then", "else"]) {
      visit(schema[keyword]);
    }
  };
  visit(compacted);
  return compacted as WebMCP.ModelContextTool["inputSchema"];
}

export const JAZZBOARD_ROOM_PARTICIPANT_WEBMCP_TOOL_NAMES = [
  ...JAZZBOARD_CANVAS_CAPABILITY_TOOL_NAMES,
  ...JAZZBOARD_GUIDED_WALKTHROUGH_TOOL_NAMES,
  ...JAZZBOARD_LOCAL_VIEWPORT_TOOL_NAMES,
  ...JAZZBOARD_WEBMCP_TOOL_NAMES,
  ...JAZZBOARD_LIFECYCLE_TOOL_NAMES,
  ...JAZZBOARD_SEMANTIC_TOOL_NAMES,
  ...JAZZBOARD_DRAFT_TOOL_NAMES,
  ...JAZZBOARD_ACTIVITY_TOOL_NAMES,
  ...JAZZBOARD_INTERCHANGE_PARTICIPANT_TOOL_NAMES,
  ...JAZZBOARD_PNG_EXPORT_TOOL_NAMES,
  ...JAZZBOARD_REVIEW_TOOL_NAMES,
  ...JAZZBOARD_PREVIEW_TOOL_NAMES,
  ...JAZZBOARD_MESSAGE_TOOL_NAMES,
] as const;

export const JAZZBOARD_ROOM_SPECTATOR_WEBMCP_TOOL_NAMES = [
  ...JAZZBOARD_CANVAS_CAPABILITY_TOOL_NAMES,
  ...JAZZBOARD_GUIDED_WALKTHROUGH_TOOL_NAMES,
  ...JAZZBOARD_LOCAL_VIEWPORT_TOOL_NAMES,
  ...JAZZBOARD_WEBMCP_READ_TOOL_NAMES,
  ...JAZZBOARD_LIFECYCLE_READ_TOOL_NAMES,
  ...JAZZBOARD_SEMANTIC_READ_TOOL_NAMES,
  ...JAZZBOARD_DRAFT_READ_TOOL_NAMES,
  ...JAZZBOARD_ACTIVITY_READ_TOOL_NAMES,
  ...JAZZBOARD_INTERCHANGE_SPECTATOR_TOOL_NAMES,
  ...JAZZBOARD_PNG_EXPORT_TOOL_NAMES,
  ...JAZZBOARD_REVIEW_READ_TOOL_NAMES,
  ...JAZZBOARD_PREVIEW_READ_TOOL_NAMES,
] as const;

/** Single composition point for all role-scoped tools registered inside a room. */
export function createJazzboardRoomWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies: JazzboardWebMcpDependencies = {},
): WebMCP.ModelContextTool[] {
  return [
    ...createJazzboardCanvasCapabilityWebMcpTools(binding),
    ...createJazzboardGuidedWalkthroughWebMcpTools(binding, dependencies),
    ...createJazzboardLocalViewportWebMcpTools(binding),
    ...createJazzboardWebMcpTools(binding, dependencies),
    ...createJazzboardLifecycleWebMcpTools(binding, dependencies),
    ...createJazzboardSemanticWebMcpTools(binding, dependencies),
    ...createJazzboardDraftWebMcpTools(binding, dependencies),
    ...createJazzboardActivityWebMcpTools(binding, dependencies),
    ...createJazzboardInterchangeWebMcpTools(binding, dependencies),
    ...createJazzboardPngExportWebMcpTools(binding, dependencies),
    ...createJazzboardReviewWebMcpTools(binding, dependencies),
    ...createJazzboardPreviewWebMcpTools(binding, dependencies),
    ...createJazzboardMessageWebMcpTools(binding, dependencies),
  ];
}

/**
 * Owns one imperative WebMCP registration set. Call update from the room's
 * room/role lifecycle and dispose on unmount. AbortSignal is the current API's
 * unregistration mechanism.
 */
export class JazzboardWebMcpRegistrar {
  private registrationController: AbortController | null = null;
  private readonly activeToolActivityReleases = new Set<(immediate?: boolean) => void>();
  private generation = 0;

  constructor(
    private readonly dependencies: JazzboardWebMcpDependencies = {},
    private readonly getModelContext: ModelContextProvider = documentModelContext,
  ) {}

  async update(binding: JazzboardWebMcpBinding | null): Promise<JazzboardWebMcpRegistrationStatus> {
    this.clearRegistration();
    const generation = this.generation;
    const modelContext = this.getModelContext();

    if (!modelContext) {
      return {
        supported: false,
        roomId: binding?.roomId ?? null,
        role: binding?.role ?? null,
        registeredToolNames: [],
      };
    }

    if (!binding) {
      return {
        supported: true,
        roomId: null,
        role: null,
        registeredToolNames: [],
      };
    }

    const controller = new AbortController();
    this.registrationController = controller;
    // Tool names and descriptions already carry the model-facing semantics.
    // Omit optional display titles from the registered production descriptor.
    const tools = createJazzboardRoomWebMcpTools(binding, this.dependencies).map((tool) => {
      const execute = tool.execute;
      const registeredTool: WebMCP.ModelContextTool = {
        ...tool,
        inputSchema: compactRegisteredInputSchema(tool.inputSchema),
        execute: async (input, options) => {
          const receivedAtUnixMs = Date.now();
          const executionStartedAt = performance.now();
          const release = binding.context.beginWebMcpToolActivity?.(tool.name);
          if (release) this.activeToolActivityReleases.add(release);
          let activityReleased = false;
          const finishActivity = (immediate = false) => {
            if (!release || activityReleased) return;
            activityReleased = true;
            this.activeToolActivityReleases.delete(release);
            if (immediate) release(true);
            else release();
          };
          const handleAbort = () => finishActivity(true);
          const executionSignal = options?.signal;
          executionSignal?.addEventListener("abort", handleAbort, { once: true });
          if (executionSignal?.aborted) handleAbort();
          try {
            const result = await execute(input, options);
            const completedAtUnixMs = Date.now();
            const durationMs = performance.now() - executionStartedAt;
            if (result === null || typeof result !== "object" || Array.isArray(result)) {
              return result;
            }
            return {
              ...result,
              transportTiming: {
                receivedAtUnixMs,
                completedAtUnixMs,
                durationMs,
                measurement: "registered_execute_entry_to_result_ready",
              },
            };
          } finally {
            executionSignal?.removeEventListener("abort", handleAbort);
            finishActivity();
          }
        },
      };
      delete registeredTool.title;
      return registeredTool;
    });

    try {
      await Promise.all(
        tools.map((tool) => modelContext.registerTool(tool, { signal: controller.signal })),
      );
    } catch (error) {
      controller.abort();
      if (this.registrationController === controller) this.registrationController = null;
      throw error;
    }

    if (generation !== this.generation || controller.signal.aborted) {
      controller.abort();
      return {
        supported: true,
        roomId: binding.roomId,
        role: binding.role,
        registeredToolNames: [],
      };
    }

    return {
      supported: true,
      roomId: binding.roomId,
      role: binding.role,
      registeredToolNames: tools.map((tool) => tool.name),
    };
  }

  dispose(): void {
    this.clearRegistration();
  }

  private clearRegistration(): void {
    this.generation += 1;
    this.registrationController?.abort();
    this.registrationController = null;
    for (const release of this.activeToolActivityReleases) release(true);
    this.activeToolActivityReleases.clear();
    this.dependencies.canvasPreviewTransport?.dispose?.();
  }
}
