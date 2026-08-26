/// <reference types="webmcp-types" />

import { createJazzboardLandingWebMcpTools } from "./landing-tools";
import type {
  JazzboardLandingWebMcpBinding,
  JazzboardLandingWebMcpDependencies,
  JazzboardLandingWebMcpRegistrationStatus,
  LandingModelContextProvider,
} from "./landing-types";

function documentModelContext(): WebMCP.ModelContext | undefined {
  return typeof document === "undefined" ? undefined : document.modelContext;
}

/** Owns the landing page's room-lifecycle WebMCP registration set. */
export class JazzboardLandingWebMcpRegistrar {
  private registrationController: AbortController | null = null;
  private generation = 0;

  constructor(
    private readonly dependencies: JazzboardLandingWebMcpDependencies = {},
    private readonly getModelContext: LandingModelContextProvider = documentModelContext,
  ) {}

  async update(
    binding: JazzboardLandingWebMcpBinding | null,
  ): Promise<JazzboardLandingWebMcpRegistrationStatus> {
    this.clearRegistration();
    const generation = this.generation;
    const modelContext = this.getModelContext();

    if (!modelContext) return { supported: false, registeredToolNames: [] };
    if (!binding) return { supported: true, registeredToolNames: [] };

    const controller = new AbortController();
    this.registrationController = controller;
    const tools = createJazzboardLandingWebMcpTools(binding, this.dependencies);

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

    return { supported: true, registeredToolNames: tools.map((tool) => tool.name) };
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
