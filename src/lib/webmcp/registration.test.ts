/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import type { RoomState } from "@/lib/domain/types";

import {
  JazzboardWebMcpRegistrar,
  JAZZBOARD_ROOM_PARTICIPANT_WEBMCP_TOOL_NAMES,
  JAZZBOARD_ROOM_SPECTATOR_WEBMCP_TOOL_NAMES,
} from "./registration";
import type { JazzboardWebMcpBinding, JazzboardWebMcpContext, WebMcpRequest } from "./types";

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

function context(): JazzboardWebMcpContext {
  return {
    getRoom: () => null,
    getSelection: () => [],
    getViewport: () => null,
    getFollowTarget: () => null,
    renderCanvasPreview: async () => {
      throw new Error("not executed by registration tests");
    },
    presentCanvasPreview: async () => {
      throw new Error("not executed by registration tests");
    },
    acceptRoom: () => undefined,
    setFollowTarget: () => undefined,
    setDeclinedSpotlight: () => undefined,
    leaveRoomView: () => undefined,
  };
}

function binding(roomId: string, role: "participant" | "spectator"): JazzboardWebMcpBinding {
  return { roomId, participantId: "participant-1", role, context: context() };
}

function requestMock() {
  return vi.fn(async () => ({ ok: true, room: {} as RoomState })) as unknown as WebMcpRequest;
}

function participantDependencies() {
  return {
    request: requestMock(),
    canvasPreviewTransport: { emit: vi.fn() },
  };
}

describe("JazzboardWebMcpRegistrar", () => {
  it("feature-detects browsers without document.modelContext", async () => {
    const registrar = new JazzboardWebMcpRegistrar({}, () => undefined);

    await expect(registrar.update(binding("room-1", "participant"))).resolves.toEqual({
      supported: false,
      roomId: "room-1",
      role: "participant",
      registeredToolNames: [],
    });
  });

  it("imperatively registers the participant surface with abort-signal cleanup", async () => {
    const modelContext = new FakeModelContext();
    const registrar = new JazzboardWebMcpRegistrar(
      participantDependencies(),
      () => modelContext as unknown as WebMCP.ModelContext,
    );

    const status = await registrar.update(binding("room-1", "participant"));

    expect(status).toEqual({
      supported: true,
      roomId: "room-1",
      role: "participant",
      registeredToolNames: [...JAZZBOARD_ROOM_PARTICIPANT_WEBMCP_TOOL_NAMES],
    });
    expect(modelContext.registerTool).toHaveBeenCalledTimes(JAZZBOARD_ROOM_PARTICIPANT_WEBMCP_TOOL_NAMES.length);
    expect([...modelContext.tools.keys()]).toEqual(JAZZBOARD_ROOM_PARTICIPANT_WEBMCP_TOOL_NAMES);
    expect(modelContext.registrationSignals).toHaveLength(JAZZBOARD_ROOM_PARTICIPANT_WEBMCP_TOOL_NAMES.length);
    expect(new Set(modelContext.registrationSignals).size).toBe(1);
    expect(modelContext.registrationSignals[0]?.aborted).toBe(false);

    const productionOrigin = "https://jazzboard-rho.vercel.app";
    const productionPageUrl =
      `${productionOrigin}/room/room_00000000-0000-4000-8000-000000000000`;
    const descriptors = [...modelContext.tools.values()].map(
      ({ name, title, description, inputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        annotations,
        origin: productionOrigin,
        pageUrl: productionPageUrl,
      }),
    );
    const descriptorBytes = new TextEncoder().encode(JSON.stringify(descriptors)).byteLength;
    const largestDescriptors = descriptors
      .map((tool) => ({
        name: tool.name,
        bytes: new TextEncoder().encode(JSON.stringify(tool)).byteLength,
      }))
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 8);
    expect(descriptors.length).toBeLessThanOrEqual(80);
    expect(
      descriptorBytes,
      `Production-shaped descriptors use ${descriptorBytes} bytes. Largest: ${JSON.stringify(largestDescriptors)}`,
    ).toBeLessThanOrEqual(55_000);

    const collectDescriptions = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.flatMap(collectDescriptions);
      if (!value || typeof value !== "object") return [];
      return Object.entries(value).flatMap(([key, child]) => [
        ...(key === "description" && typeof child === "string" ? [child] : []),
        ...collectDescriptions(child),
      ]);
    };
    for (const tool of descriptors) {
      expect(tool.name.length, `${tool.name} exceeds Chrome's recommended name budget`).toBeLessThanOrEqual(30);
      expect(
        tool.description.length,
        `${tool.name} exceeds Chrome's recommended description budget`,
      ).toBeLessThanOrEqual(500);
      for (const parameterDescription of collectDescriptions(tool.inputSchema)) {
        expect(
          parameterDescription.length,
          `${tool.name} has an overlong parameter description`,
        ).toBeLessThanOrEqual(150);
      }
    }

    registrar.dispose();
    expect(modelContext.registrationSignals[0]?.aborted).toBe(true);
    expect(modelContext.tools.size).toBe(0);
  });

  it("registers only read-only tools for spectators", async () => {
    const modelContext = new FakeModelContext();
    const registrar = new JazzboardWebMcpRegistrar(
      participantDependencies(),
      () => modelContext as unknown as WebMCP.ModelContext,
    );

    await expect(registrar.update(binding("room-1", "spectator"))).resolves.toEqual({
      supported: true,
      roomId: "room-1",
      role: "spectator",
      registeredToolNames: [...JAZZBOARD_ROOM_SPECTATOR_WEBMCP_TOOL_NAMES],
    });
    expect([...modelContext.tools.keys()]).toEqual(JAZZBOARD_ROOM_SPECTATOR_WEBMCP_TOOL_NAMES);
    expect([...modelContext.tools.values()].every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
  });

  it("unregisters every participant tool immediately when the role becomes spectator", async () => {
    const modelContext = new FakeModelContext();
    const registrar = new JazzboardWebMcpRegistrar(
      participantDependencies(),
      () => modelContext as unknown as WebMCP.ModelContext,
    );

    await registrar.update(binding("room-1", "participant"));
    const participantSignal = modelContext.registrationSignals[0];
    expect(modelContext.tools.size).toBe(JAZZBOARD_ROOM_PARTICIPANT_WEBMCP_TOOL_NAMES.length);

    const status = await registrar.update(binding("room-1", "spectator"));

    expect(participantSignal?.aborted).toBe(true);
    expect(modelContext.tools.size).toBe(JAZZBOARD_ROOM_SPECTATOR_WEBMCP_TOOL_NAMES.length);
    expect(status.registeredToolNames).toEqual(JAZZBOARD_ROOM_SPECTATOR_WEBMCP_TOOL_NAMES);
  });

  it("cleans up old room handlers before registering a new room", async () => {
    const modelContext = new FakeModelContext();
    const registrar = new JazzboardWebMcpRegistrar(
      participantDependencies(),
      () => modelContext as unknown as WebMCP.ModelContext,
    );

    await registrar.update(binding("room-1", "participant"));
    const firstSignal = modelContext.registrationSignals[0];
    const firstTools = [...modelContext.tools.values()];

    const status = await registrar.update(binding("room-2", "participant"));

    expect(firstSignal?.aborted).toBe(true);
    expect(firstTools.every((tool) => modelContext.tools.get(tool.name) !== tool)).toBe(true);
    expect(status.roomId).toBe("room-2");
    expect(modelContext.tools.size).toBe(JAZZBOARD_ROOM_PARTICIPANT_WEBMCP_TOOL_NAMES.length);
    const secondSignal = modelContext.registrationSignals.at(-1);
    expect(secondSignal).not.toBe(firstSignal);
    expect(secondSignal?.aborted).toBe(false);
  });

  it("aborts partial registrations if registerTool rejects", async () => {
    const modelContext = new FakeModelContext();
    modelContext.registerTool.mockImplementationOnce(async () => {
      throw new Error("registration failed");
    });
    const registrar = new JazzboardWebMcpRegistrar(
      participantDependencies(),
      () => modelContext as unknown as WebMCP.ModelContext,
    );

    await expect(registrar.update(binding("room-1", "participant"))).rejects.toThrow("registration failed");
    expect(modelContext.registrationSignals.every((signal) => signal.aborted)).toBe(true);
    expect(modelContext.tools.size).toBe(0);
  });
});
