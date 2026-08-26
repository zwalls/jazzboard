/// <reference types="webmcp-types" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecentRoom } from "@/lib/domain/types";

import {
  attachLandingWebMcpContext,
  detachLandingWebMcpContext,
  disposeLandingWebMcpBootstrap,
  ensureLandingWebMcpBootstrap,
} from "./landing-bootstrap";
import { JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES } from "./landing-tools";

class StrictFakeModelContext extends EventTarget {
  readonly tools = new Map<string, WebMCP.ModelContextTool>();
  readonly registrationStates: DocumentReadyState[] = [];
  readonly registerTool = vi.fn(
    async (tool: WebMCP.ModelContextTool, options?: WebMCP.ModelContextRegisterToolOptions) => {
      if (this.tools.has(tool.name)) {
        throw new DOMException(`Tool ${tool.name} is already registered.`, "InvalidStateError");
      }
      this.tools.set(tool.name, tool);
      this.registrationStates.push(document.readyState);
      options?.signal?.addEventListener(
        "abort",
        () => {
          if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
        },
        { once: true },
      );
    },
  );
}

function installModelContext(modelContext: StrictFakeModelContext): void {
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: modelContext,
  });
}

describe("pre-hydration landing WebMCP bootstrap", () => {
  beforeEach(() => {
    disposeLandingWebMcpBootstrap();
    delete globalThis.__jazzboardLandingWebMcpBootstrap;
    window.localStorage.clear();
  });

  afterEach(() => {
    disposeLandingWebMcpBootstrap();
    delete globalThis.__jazzboardLandingWebMcpBootstrap;
    Reflect.deleteProperty(document, "modelContext");
  });

  it("registers the five landing tools exactly once across bootstrap and hydration attachment", async () => {
    const modelContext = new StrictFakeModelContext();
    installModelContext(modelContext);

    const first = ensureLandingWebMcpBootstrap();
    const context = {
      acceptRecentRooms: vi.fn(),
      navigateToRoom: vi.fn(),
    };
    const attached = attachLandingWebMcpContext(context);

    await expect(first).resolves.toMatchObject({
      supported: true,
      registeredToolNames: [...JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES],
    });
    await expect(attached).resolves.toEqual(await first);
    expect(modelContext.registerTool).toHaveBeenCalledTimes(
      JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES.length,
    );
    expect([...modelContext.tools]).toHaveLength(JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES.length);
  });

  it("routes tool-side recent-room updates into the hydrated bridge", async () => {
    const modelContext = new StrictFakeModelContext();
    installModelContext(modelContext);
    const room: RecentRoom = {
      roomId: "room_private",
      code: "1234",
      title: "Private board",
      role: "participant",
      lastOpenedAt: 10,
    };
    window.localStorage.setItem("jazzboard:recent-rooms:v1", JSON.stringify([room]));
    const acceptRecentRooms = vi.fn();

    await attachLandingWebMcpContext({
      acceptRecentRooms,
      navigateToRoom: vi.fn(),
    });
    const removeTool = modelContext.tools.get("remove_recent_room");
    expect(removeTool).toBeDefined();
    await removeTool!.execute({ roomId: room.roomId }, { signal: new AbortController().signal });

    expect(acceptRecentRooms).toHaveBeenCalledWith([]);
  });

  it("retains the early tools when React cleans up its hydrated context", async () => {
    const modelContext = new StrictFakeModelContext();
    installModelContext(modelContext);
    const context = {
      acceptRecentRooms: vi.fn(),
      navigateToRoom: vi.fn(),
    };

    await ensureLandingWebMcpBootstrap();
    await attachLandingWebMcpContext(context);
    detachLandingWebMcpContext(context);
    await attachLandingWebMcpContext(context);

    expect(modelContext.registerTool).toHaveBeenCalledTimes(
      JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES.length,
    );
    expect([...modelContext.tools.keys()]).toEqual(JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES);
  });

  it("removes the landing surface on exit and supports a clean SPA re-entry", async () => {
    const modelContext = new StrictFakeModelContext();
    installModelContext(modelContext);
    await ensureLandingWebMcpBootstrap();
    const firstTools = [...modelContext.tools.values()];

    disposeLandingWebMcpBootstrap();
    expect(modelContext.tools.size).toBe(0);

    await ensureLandingWebMcpBootstrap();
    expect([...modelContext.tools.keys()]).toEqual(JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES);
    expect([...modelContext.tools.values()].every((tool) => !firstTools.includes(tool))).toBe(true);
  });
});
