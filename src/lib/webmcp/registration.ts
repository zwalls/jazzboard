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
  createJazzboardActivityWebMcpTools,
  JAZZBOARD_ACTIVITY_READ_TOOL_NAMES,
  JAZZBOARD_ACTIVITY_TOOL_NAMES,
} from "./activity-tools";
import {
  createJazzboardSnapshotRoomWebMcpTools,
  JAZZBOARD_SNAPSHOT_ROOM_TOOL_NAMES,
} from "./snapshot-room-tools";
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
  JAZZBOARD_PREVIEW_TOOL_NAMES,
} from "./preview-tools";
import {
  createJazzboardMessageWebMcpTools,
  JAZZBOARD_MESSAGE_TOOL_NAMES,
} from "./message-tools";
import type {
  JazzboardWebMcpBinding,
  JazzboardWebMcpDependencies,
  JazzboardWebMcpRegistrationStatus,
  ModelContextProvider,
} from "./types";

function documentModelContext(): WebMCP.ModelContext | undefined {
  return typeof document === "undefined" ? undefined : document.modelContext;
}

export const JAZZBOARD_ROOM_PARTICIPANT_WEBMCP_TOOL_NAMES = [
  ...JAZZBOARD_WEBMCP_TOOL_NAMES,
  ...JAZZBOARD_LIFECYCLE_TOOL_NAMES,
  ...JAZZBOARD_SEMANTIC_TOOL_NAMES,
  ...JAZZBOARD_ACTIVITY_TOOL_NAMES,
  ...JAZZBOARD_SNAPSHOT_ROOM_TOOL_NAMES,
  ...JAZZBOARD_INTERCHANGE_PARTICIPANT_TOOL_NAMES,
  ...JAZZBOARD_REVIEW_TOOL_NAMES,
  ...JAZZBOARD_PREVIEW_TOOL_NAMES,
  ...JAZZBOARD_MESSAGE_TOOL_NAMES,
] as const;

export const JAZZBOARD_ROOM_SPECTATOR_WEBMCP_TOOL_NAMES = [
  ...JAZZBOARD_WEBMCP_READ_TOOL_NAMES,
  ...JAZZBOARD_LIFECYCLE_READ_TOOL_NAMES,
  ...JAZZBOARD_SEMANTIC_READ_TOOL_NAMES,
  ...JAZZBOARD_ACTIVITY_READ_TOOL_NAMES,
  ...JAZZBOARD_INTERCHANGE_SPECTATOR_TOOL_NAMES,
  ...JAZZBOARD_REVIEW_READ_TOOL_NAMES,
] as const;

/** Single composition point for all role-scoped tools registered inside a room. */
export function createJazzboardRoomWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies: JazzboardWebMcpDependencies = {},
): WebMCP.ModelContextTool[] {
  return [
    ...createJazzboardWebMcpTools(binding, dependencies),
    ...createJazzboardLifecycleWebMcpTools(binding, dependencies),
    ...createJazzboardSemanticWebMcpTools(binding, dependencies),
    ...createJazzboardActivityWebMcpTools(binding, dependencies),
    ...createJazzboardSnapshotRoomWebMcpTools(binding, dependencies),
    ...createJazzboardInterchangeWebMcpTools(binding, dependencies),
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
    const tools = createJazzboardRoomWebMcpTools(binding, this.dependencies);

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
    this.dependencies.canvasPreviewTransport?.dispose?.();
  }
}
