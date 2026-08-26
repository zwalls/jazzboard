/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import { JazzboardLandingWebMcpRegistrar } from "./landing-registration";
import { JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES } from "./landing-tools";
import type { JazzboardLandingWebMcpBinding } from "./landing-types";

class FakeModelContext extends EventTarget {
  readonly tools = new Map<string, WebMCP.ModelContextTool>();
  readonly registrationSignals: AbortSignal[] = [];
  readonly registerTool = vi.fn(
    async (tool: WebMCP.ModelContextTool, options?: WebMCP.ModelContextRegisterToolOptions) => {
      this.tools.set(tool.name, tool);
      if (options?.signal) {
        this.registrationSignals.push(options.signal);
        options.signal.addEventListener("abort", () => this.tools.delete(tool.name), { once: true });
      }
    },
  );
}

function binding(): JazzboardLandingWebMcpBinding {
  return {
    context: {
      acceptRecentRooms: () => undefined,
      navigateToRoom: () => undefined,
    },
  };
}

describe("JazzboardLandingWebMcpRegistrar", () => {
  it("feature-detects browsers without document.modelContext", async () => {
    const registrar = new JazzboardLandingWebMcpRegistrar({}, () => undefined);
    await expect(registrar.update(binding())).resolves.toEqual({
      supported: false,
      registeredToolNames: [],
    });
  });

  it("registers every landing lifecycle tool with one abortable generation", async () => {
    const modelContext = new FakeModelContext();
    const registrar = new JazzboardLandingWebMcpRegistrar(
      {},
      () => modelContext as unknown as WebMCP.ModelContext,
    );

    await expect(registrar.update(binding())).resolves.toEqual({
      supported: true,
      registeredToolNames: [...JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES],
    });
    expect([...modelContext.tools.keys()]).toEqual(JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES);
    expect(modelContext.registrationSignals).toHaveLength(JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES.length);
    expect(new Set(modelContext.registrationSignals).size).toBe(1);

    registrar.dispose();
    expect(modelContext.registrationSignals[0]?.aborted).toBe(true);
    expect(modelContext.tools.size).toBe(0);
  });

  it("aborts partial registration when the browser rejects a tool", async () => {
    const modelContext = new FakeModelContext();
    modelContext.registerTool.mockImplementationOnce(async () => {
      throw new Error("registration failed");
    });
    const registrar = new JazzboardLandingWebMcpRegistrar(
      {},
      () => modelContext as unknown as WebMCP.ModelContext,
    );

    await expect(registrar.update(binding())).rejects.toThrow("registration failed");
    expect(modelContext.registrationSignals.every((signal) => signal.aborted)).toBe(true);
    expect(modelContext.tools.size).toBe(0);
  });
});
