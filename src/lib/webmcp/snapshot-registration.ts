/// <reference types="webmcp-types" />

import type { PublicReadonlySnapshot } from "@/lib/server/snapshot-service";

import {
  createJazzboardSnapshotWebMcpTools,
  JAZZBOARD_SNAPSHOT_WEBMCP_TOOL_NAMES,
} from "./snapshot-tools";

function documentModelContext(): WebMCP.ModelContext | undefined {
  return typeof document === "undefined" ? undefined : document.modelContext;
}

export type JazzboardSnapshotWebMcpRegistrationStatus = {
  supported: boolean;
  registeredToolNames: string[];
};

/** Owns the exact read-only WebMCP tool set for one public frozen snapshot page. */
export class JazzboardSnapshotWebMcpRegistrar {
  private registrationController: AbortController | null = null;
  private generation = 0;

  constructor(
    private readonly getModelContext: () => WebMCP.ModelContext | undefined = documentModelContext,
  ) {}

  async update(
    snapshot: PublicReadonlySnapshot | null,
  ): Promise<JazzboardSnapshotWebMcpRegistrationStatus> {
    this.clearRegistration();
    const generation = this.generation;
    const modelContext = this.getModelContext();
    if (!modelContext) return { supported: false, registeredToolNames: [] };
    if (!snapshot) return { supported: true, registeredToolNames: [] };

    const controller = new AbortController();
    this.registrationController = controller;
    const tools = createJazzboardSnapshotWebMcpTools({ snapshot });
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
      return { supported: true, registeredToolNames: [] };
    }
    return {
      supported: true,
      registeredToolNames: [...JAZZBOARD_SNAPSHOT_WEBMCP_TOOL_NAMES],
    };
  }

  dispose(): void {
    this.clearRegistration();
  }

  private clearRegistration(): void {
    this.generation += 1;
    this.registrationController?.abort();
    this.registrationController = null;
  }
}
