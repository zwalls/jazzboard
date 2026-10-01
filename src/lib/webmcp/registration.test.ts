/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import type { RoomState } from "@/lib/domain/types";
import type { GuidedWalkthrough } from "@/lib/canvas/guided-walkthrough";
import type { CanvasRuntime } from "@/lib/canvas/runtime";

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

function context(overrides: Partial<JazzboardWebMcpContext> = {}): JazzboardWebMcpContext {
  let walkthrough: GuidedWalkthrough | null = null;
  const runtime = {
    getViewport: () => ({ x: 0, y: 0, width: 800, height: 600, zoom: 1 }),
  } as CanvasRuntime;
  return {
    getRoom: () => null,
    getSelection: () => [],
    getViewport: () => null,
    getCanvasRuntime: () => runtime,
    getFollowTarget: () => null,
    getGuidedWalkthrough: () => walkthrough,
    getGuidedWalkthroughDisplay: () => null,
    presentGuidedWalkthrough: (next) => { walkthrough = next; },
    stopGuidedWalkthrough: () => { walkthrough = null; },
    waitForGuidedWalkthroughDisplay: async () => true,
    renderCanvasPreview: async () => {
      throw new Error("not executed by registration tests");
    },
    inspectCanvasScope: async () => {
      throw new Error("not executed by registration tests");
    },
    presentCanvasPreview: async () => {
      throw new Error("not executed by registration tests");
    },
    saveCanvasPng: async () => {
      throw new Error("not executed by registration tests");
    },
    acceptRoom: () => undefined,
    setFollowTarget: () => undefined,
    setDeclinedSpotlight: () => undefined,
    leaveRoomView: () => undefined,
    ...overrides,
  };
}

function binding(
  roomId: string,
  role: "participant" | "spectator",
  contextOverrides: Partial<JazzboardWebMcpContext> = {},
): JazzboardWebMcpBinding {
  return { roomId, participantId: "participant-1", role, context: context(contextOverrides) };
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
    expect(modelContext.tools.get("get_canvas_capabilities")?.annotations).toEqual({
      readOnlyHint: true,
    });
    expect(modelContext.tools.has("inspect_canvas_scope")).toBe(true);
    expect(modelContext.tools.has("control_local_viewport")).toBe(true);
    for (const retiredToolName of [
      "create_readonly_snapshot",
      "list_readonly_snapshots",
      "revoke_readonly_snapshot",
    ]) {
      expect(modelContext.tools.has(retiredToolName)).toBe(false);
    }
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
    // Draft inspection, explicit waypoint control, native Mermaid import, and
    // the bounded local walkthrough and camera surfaces remain below 64 KB.
    ).toBeLessThanOrEqual(64_000);

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

  it("wraps successful registered execution in one local activity lifecycle", async () => {
    const modelContext = new FakeModelContext();
    const release = vi.fn();
    const beginWebMcpToolActivity = vi.fn(() => release);
    const registrar = new JazzboardWebMcpRegistrar(
      participantDependencies(),
      () => modelContext as unknown as WebMCP.ModelContext,
    );
    await registrar.update(binding("room-1", "participant", { beginWebMcpToolActivity }));

    await modelContext.tools.get("get_canvas_capabilities")!.execute(
      {},
      { signal: new AbortController().signal },
    );

    expect(beginWebMcpToolActivity).toHaveBeenCalledWith("get_canvas_capabilities");
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith();
  });

  it("adds registered execution timing to a successful object result", async () => {
    const modelContext = new FakeModelContext();
    const registrar = new JazzboardWebMcpRegistrar(
      participantDependencies(),
      () => modelContext as unknown as WebMCP.ModelContext,
    );
    await registrar.update(binding("room-1", "participant"));
    const registeredTool = modelContext.tools.get("control_local_viewport")!;
    const wallClock = vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_787_946_400_000)
      .mockReturnValueOnce(1_787_946_400_009);
    const monotonicClock = vi.spyOn(performance, "now")
      .mockReturnValueOnce(40)
      .mockReturnValueOnce(41)
      .mockReturnValueOnce(44.25)
      .mockReturnValueOnce(46.5);

    const result = await registeredTool.execute(
      { action: "read" },
      { signal: new AbortController().signal },
    );

    expect(registeredTool.title).toBeUndefined();
    expect(registeredTool.inputSchema).toMatchObject({
      type: "object",
      required: ["action"],
      additionalProperties: false,
    });
    expect(result).toMatchObject({
      ok: true,
      tool: "control_local_viewport",
      data: {
        executionTiming: {
          handlerDurationMs: 3.25,
          measurement: "execute_entry_to_result_preparation",
          excludes: ["webmcp_transport", "react_paint"],
        },
      },
      transportTiming: {
        receivedAtUnixMs: 1_787_946_400_000,
        completedAtUnixMs: 1_787_946_400_009,
        durationMs: 6.5,
        measurement: "registered_execute_entry_to_result_ready",
      },
    });
    expect(wallClock).toHaveBeenCalledTimes(2);
    expect(monotonicClock).toHaveBeenCalledTimes(4);
    wallClock.mockRestore();
    monotonicClock.mockRestore();
  });

  it("adds the same compact timing envelope to a returned tool error", async () => {
    const modelContext = new FakeModelContext();
    const registrar = new JazzboardWebMcpRegistrar(
      participantDependencies(),
      () => modelContext as unknown as WebMCP.ModelContext,
    );
    await registrar.update(binding("room-1", "participant"));
    const wallClock = vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_787_946_500_000)
      .mockReturnValueOnce(1_787_946_500_002);
    const monotonicClock = vi.spyOn(performance, "now")
      .mockReturnValueOnce(80)
      .mockReturnValueOnce(81.75);

    const result = await modelContext.tools.get("get_canvas_capabilities")!.execute(
      { bundle: "unknown" },
      { signal: new AbortController().signal },
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: false,
      tool: "get_canvas_capabilities",
      error: { code: "INVALID_TOOL_INPUT" },
      transportTiming: {
        receivedAtUnixMs: 1_787_946_500_000,
        completedAtUnixMs: 1_787_946_500_002,
        durationMs: 1.75,
        measurement: "registered_execute_entry_to_result_ready",
      },
    });
    expect(new TextEncoder().encode(JSON.stringify({
      transportTiming: result.transportTiming,
    })).byteLength).toBeLessThanOrEqual(200);
    expect(wallClock).toHaveBeenCalledTimes(2);
    expect(monotonicClock).toHaveBeenCalledTimes(2);
    wallClock.mockRestore();
    monotonicClock.mockRestore();
  });

  it("keeps concurrent registered executions in separate local activity lifecycles", async () => {
    const modelContext = new FakeModelContext();
    const releases = [vi.fn(), vi.fn()];
    const beginWebMcpToolActivity = vi.fn(() => releases[beginWebMcpToolActivity.mock.calls.length - 1]!);
    const requests: Array<{
      resolve(value: unknown): void;
      reject(reason: unknown): void;
    }> = [];
    const request = vi.fn(() => new Promise((resolve, reject) => requests.push({ resolve, reject }))) as unknown as WebMcpRequest;
    const registrar = new JazzboardWebMcpRegistrar(
      { ...participantDependencies(), request },
      () => modelContext as unknown as WebMCP.ModelContext,
    );
    await registrar.update(binding("room-1", "participant", { beginWebMcpToolActivity }));
    const read = modelContext.tools.get("read_room_state")!;

    const first = read.execute({ detail: "summary" }, { signal: new AbortController().signal });
    const second = read.execute({ detail: "summary" }, { signal: new AbortController().signal });
    expect(beginWebMcpToolActivity).toHaveBeenCalledTimes(2);
    expect(releases.every((release) => release.mock.calls.length === 0)).toBe(true);

    const emptyRoom = {
      id: "room-1",
      code: "ROOM01",
      title: "Room",
      roomRevision: 1,
      createdAt: 1,
      updatedAt: 1,
      participants: {},
      objects: {},
      diagrams: {},
      leases: {},
      spotlight: null,
      agentEditPolicy: "live",
      reviewProposals: [],
    } as RoomState;
    requests[0]!.resolve({ ok: true, room: emptyRoom });
    await first;
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).not.toHaveBeenCalled();

    requests[1]!.resolve({ ok: true, room: emptyRoom });
    await second;
    expect(releases[1]).toHaveBeenCalledOnce();
  });

  it("ends local activity when registered execution fails or is aborted", async () => {
    const modelContext = new FakeModelContext();
    const releases = [vi.fn(), vi.fn()];
    const beginWebMcpToolActivity = vi.fn(() => releases[beginWebMcpToolActivity.mock.calls.length - 1]!);
    let finishAbortedRequest: ((value: unknown) => void) | null = null;
    let requestCount = 0;
    const request = vi.fn(() => {
      requestCount += 1;
      if (requestCount === 1) return Promise.reject(new Error("network failed"));
      return new Promise((resolve) => { finishAbortedRequest = resolve; });
    }) as unknown as WebMcpRequest;
    const registrar = new JazzboardWebMcpRegistrar(
      { ...participantDependencies(), request },
      () => modelContext as unknown as WebMCP.ModelContext,
    );
    await registrar.update(binding("room-1", "participant", { beginWebMcpToolActivity }));
    const read = modelContext.tools.get("read_room_state")!;

    await read.execute({}, { signal: new AbortController().signal });
    expect(releases[0]).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const aborted = read.execute({}, { signal: controller.signal });
    controller.abort();
    expect(releases[1]).toHaveBeenCalledWith(true);
    finishAbortedRequest!({
      ok: true,
      room: {
        id: "room-1",
        code: "ROOM01",
        title: "Room",
        roomRevision: 1,
        createdAt: 1,
        updatedAt: 1,
        participants: {},
        objects: {},
        diagrams: {},
        leases: {},
        spotlight: null,
        agentEditPolicy: "live",
        reviewProposals: [],
      } as RoomState,
    });
    await aborted;
    expect(releases[1]).toHaveBeenCalledOnce();
  });

  it("hard-cleans active local activity when registrations are disposed", async () => {
    const modelContext = new FakeModelContext();
    const release = vi.fn();
    const beginWebMcpToolActivity = vi.fn(() => release);
    let finishRequest: ((value: unknown) => void) | null = null;
    const request = vi.fn(() => new Promise((resolve) => { finishRequest = resolve; })) as unknown as WebMcpRequest;
    const registrar = new JazzboardWebMcpRegistrar(
      { ...participantDependencies(), request },
      () => modelContext as unknown as WebMCP.ModelContext,
    );
    await registrar.update(binding("room-1", "participant", { beginWebMcpToolActivity }));
    const pending = modelContext.tools.get("read_room_state")!.execute(
      { detail: "summary" },
      { signal: new AbortController().signal },
    );

    registrar.dispose();
    expect(release).toHaveBeenCalledWith(true);

    finishRequest!({
      ok: true,
      room: {
        id: "room-1",
        code: "ROOM01",
        title: "Room",
        roomRevision: 1,
        createdAt: 1,
        updatedAt: 1,
        participants: {},
        objects: {},
        diagrams: {},
        leases: {},
        spotlight: null,
        agentEditPolicy: "live",
        reviewProposals: [],
      } as RoomState,
    });
    await pending;
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
    expect(modelContext.tools.get("get_canvas_capabilities")?.annotations).toEqual({
      readOnlyHint: true,
    });
    expect(modelContext.tools.has("inspect_canvas_scope")).toBe(true);
    expect(modelContext.tools.has("control_local_viewport")).toBe(true);
    expect(
      [...modelContext.tools.values()]
        .filter((tool) => tool.name !== "export_canvas_png")
        .every((tool) => tool.annotations?.readOnlyHint),
    ).toBe(true);
    expect(modelContext.tools.get("export_canvas_png")?.annotations).toEqual({
      untrustedContentHint: true,
    });
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
