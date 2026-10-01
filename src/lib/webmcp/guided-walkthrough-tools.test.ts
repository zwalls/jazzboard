/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import {
  reconcileGuidedWalkthrough,
  type GuidedWalkthrough,
} from "@/lib/canvas/guided-walkthrough";
import type { RoomState } from "@/lib/domain/types";

import { createJazzboardGuidedWalkthroughWebMcpTools } from "./guided-walkthrough-tools";
import type { JazzboardWebMcpBinding, JazzboardWebMcpContext } from "./types";

const actor = {
  participantId: "participant-1",
  displayName: "Loop",
  color: "#5965e8",
  kind: "agent" as const,
};

function room(): RoomState {
  return {
    id: "room-1",
    code: "ABC234",
    title: "Avatar cache miss",
    roomRevision: 3,
    createdAt: 1,
    updatedAt: 2,
    participants: {},
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
    objects: {
      client: {
        id: "client",
        kind: "shape",
        x: 10,
        y: 20,
        width: 160,
        height: 80,
        rotation: 0,
        zIndex: 1,
        revision: 1,
        groupId: null,
        diagramIds: [],
        createdAt: 1,
        updatedAt: 1,
        createdBy: actor,
        lastEditedBy: actor,
        shape: "rectangle",
        nodeType: null,
        label: "Client",
        fill: "light-violet",
        stroke: "blue",
      },
      request: {
        id: "request",
        kind: "connector",
        x: 170,
        y: 60,
        width: 120,
        height: 0,
        rotation: 0,
        zIndex: 2,
        revision: 1,
        groupId: null,
        diagramIds: [],
        createdAt: 1,
        updatedAt: 1,
        createdBy: actor,
        lastEditedBy: actor,
        start: { x: 170, y: 60, objectId: null },
        end: { x: 290, y: 60, objectId: null },
        color: "blue",
        label: "GET avatar",
        direction: "end",
      },
    },
  };
}

function fixture() {
  let active: GuidedWalkthrough | null = null;
  let display = null as { walkthroughId: string; revision: number; stepIndex: number } | null;
  let waitBehavior: "ack" | "pending" | "exit" | "disappear" = "ack";
  let currentRoom = room();
  const context: JazzboardWebMcpContext = {
    getRoom: () => currentRoom,
    getSelection: () => [],
    getViewport: () => null,
    getFollowTarget: () => null,
    getGuidedWalkthrough: () => active ? reconcileGuidedWalkthrough(active, currentRoom) : null,
    getGuidedWalkthroughDisplay: () => display,
    presentGuidedWalkthrough: (walkthrough) => { active = walkthrough; display = null; },
    stopGuidedWalkthrough: () => { active = null; display = null; },
    waitForGuidedWalkthroughDisplay: async (walkthroughId, revision) => {
      if (!active || active.id !== walkthroughId || active.revision !== revision) return false;
      if (waitBehavior === "exit") {
        active = null;
        display = null;
        return false;
      }
      if (waitBehavior === "disappear") {
        const nextObjects = { ...currentRoom.objects };
        delete nextObjects.request;
        currentRoom = { ...currentRoom, objects: nextObjects };
        return false;
      }
      if (waitBehavior === "pending") return false;
      display = { walkthroughId, revision, stepIndex: active.currentStepIndex };
      return true;
    },
    acceptRoom: () => undefined,
    setFollowTarget: () => undefined,
    setDeclinedSpotlight: () => undefined,
    leaveRoomView: () => undefined,
  };
  const binding: JazzboardWebMcpBinding = {
    roomId: "room-1",
    participantId: "participant-1",
    role: "participant",
    context,
  };
  const tools = createJazzboardGuidedWalkthroughWebMcpTools(binding, {
    createId: () => "walkthrough-demo",
  });
  const execute = async (name: string, input: Record<string, unknown>) => {
    const candidate = tools.find((tool) => tool.name === name);
    if (!candidate) throw new Error(`Missing tool ${name}`);
    return candidate.execute(input, { signal: new AbortController().signal });
  };
  return {
    execute,
    getActive: () => active,
    setActive: (next: GuidedWalkthrough | null) => { active = next; },
    setDisplay: (next: typeof display) => { display = next; },
    setWaitBehavior: (next: typeof waitBehavior) => { waitBehavior = next; },
    manualStep: (stepIndex: number) => {
      if (!active) return;
      active = { ...active, currentStepIndex: stepIndex, revision: active.revision + 1 };
      display = { walkthroughId: active.id, revision: active.revision, stepIndex };
    },
    tools,
  };
}

describe("guided walkthrough WebMCP tools", () => {
  it("accepts the complete tour once and exposes local status and stop controls", async () => {
    const { execute, getActive, tools } = fixture();
    expect(tools.map((tool) => tool.name)).toEqual([
      "start_guided_walkthrough",
      "get_guided_walkthrough_status",
      "navigate_guided_walkthrough",
      "stop_guided_walkthrough",
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);

    await expect(execute("start_guided_walkthrough", {
      title: "Avatar cache miss",
      steps: [{
        caption: "The client requests an avatar.",
        details: "The edge is highlighted without changing its semantic selection.",
        objectIds: ["client"],
        connectorIds: ["request"],
      }],
    })).resolves.toMatchObject({
      ok: true,
      data: {
        active: true,
        walkthroughId: "walkthrough-demo",
        stepCount: 1,
        presentation: "displayed",
        revision: 1,
        currentStep: {
          index: 1,
          details: "The edge is highlighted without changing its semantic selection.",
          targets: [
            { id: "client", kind: "shape", label: "Client" },
            { id: "request", kind: "connector", label: "GET avatar" },
          ],
        },
      },
    });
    expect(getActive()?.steps).toHaveLength(1);

    await expect(execute("get_guided_walkthrough_status", {})).resolves.toMatchObject({
      ok: true,
      data: { active: true, walkthroughId: "walkthrough-demo" },
    });
    await expect(execute("stop_guided_walkthrough", { walkthroughId: "walkthrough-demo" })).resolves.toMatchObject({
      ok: true,
      data: { stopped: true, walkthroughId: "walkthrough-demo" },
    });
    expect(getActive()).toBeNull();
  });

  it("hands off displayed next and back steps with revision fences and semantic narration data", async () => {
    const { execute } = fixture();
    await execute("start_guided_walkthrough", {
      title: "Cache path",
      steps: [
        { caption: "Client request", objectIds: ["client"] },
        { caption: "Request edge", details: "The cache lookup begins.", connectorIds: ["request"] },
      ],
    });
    await expect(execute("navigate_guided_walkthrough", {
      walkthroughId: "walkthrough-demo",
      expectedRevision: 1,
      expectedStep: 1,
      action: "next",
    })).resolves.toMatchObject({
      ok: true,
      data: {
        presentation: "displayed",
        revision: 2,
        currentStep: {
          index: 2,
          caption: "Request edge",
          details: "The cache lookup begins.",
          targets: [{ id: "request", kind: "connector", label: "GET avatar" }],
        },
      },
    });
    await expect(execute("navigate_guided_walkthrough", {
      walkthroughId: "walkthrough-demo",
      expectedRevision: 2,
      expectedStep: 2,
      action: "back",
    })).resolves.toMatchObject({
      ok: true,
      data: { presentation: "displayed", revision: 3, currentStep: { index: 1 } },
    });
  });

  it("reports start and navigation handler time including display confirmation but excluding transport", async () => {
    const now = vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(112.5)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(219.75);
    const { execute } = fixture();

    await expect(execute("start_guided_walkthrough", {
      steps: [
        { caption: "Client", objectIds: ["client"] },
        { caption: "Request", connectorIds: ["request"] },
      ],
    })).resolves.toMatchObject({
      ok: true,
      data: {
        executionTiming: {
          handlerDurationMs: 12.5,
          measurement: "execute_entry_to_result_preparation",
          includes: ["awaited_walkthrough_display"],
          excludes: ["webmcp_transport"],
        },
      },
    });
    await expect(execute("navigate_guided_walkthrough", {
      walkthroughId: "walkthrough-demo",
      expectedRevision: 1,
      expectedStep: 1,
      action: "next",
    })).resolves.toMatchObject({
      ok: true,
      data: {
        executionTiming: {
          handlerDurationMs: 19.75,
          measurement: "execute_entry_to_result_preparation",
          includes: ["awaited_walkthrough_display"],
          excludes: ["webmcp_transport"],
        },
      },
    });
    expect(now).toHaveBeenCalledTimes(4);
  });

  it("rejects stale agent navigation after manual Next and rejects a pending current step", async () => {
    const { execute, manualStep, setDisplay } = fixture();
    await execute("start_guided_walkthrough", {
      steps: [
        { caption: "Client", objectIds: ["client"] },
        { caption: "Request", connectorIds: ["request"] },
      ],
    });
    manualStep(1);
    await expect(execute("navigate_guided_walkthrough", {
      walkthroughId: "walkthrough-demo",
      expectedRevision: 1,
      expectedStep: 1,
      action: "next",
    })).resolves.toMatchObject({ ok: false, error: { code: "WALKTHROUGH_REVISION_CONFLICT" } });

    setDisplay(null);
    await expect(execute("navigate_guided_walkthrough", {
      walkthroughId: "walkthrough-demo",
      expectedRevision: 2,
      expectedStep: 2,
      action: "back",
    })).resolves.toMatchObject({ ok: false, error: { code: "WALKTHROUGH_NOT_DISPLAYED" } });
  });

  it("does not report a step when the tour exits or loses all targets during pending display", async () => {
    const { execute, setWaitBehavior } = fixture();
    await execute("start_guided_walkthrough", {
      steps: [
        { caption: "Client", objectIds: ["client"] },
        { caption: "Request", connectorIds: ["request"] },
      ],
    });
    setWaitBehavior("exit");
    await expect(execute("navigate_guided_walkthrough", {
      walkthroughId: "walkthrough-demo",
      expectedRevision: 1,
      expectedStep: 1,
      action: "next",
    })).resolves.toMatchObject({ ok: false, error: { code: "WALKTHROUGH_STATE_CHANGED" } });

    const disappeared = fixture();
    await disappeared.execute("start_guided_walkthrough", {
      steps: [
        { caption: "Client", objectIds: ["client"] },
        { caption: "Request", connectorIds: ["request"] },
      ],
    });
    disappeared.setWaitBehavior("disappear");
    await expect(disappeared.execute("navigate_guided_walkthrough", {
      walkthroughId: "walkthrough-demo",
      expectedRevision: 1,
      expectedStep: 1,
      action: "next",
    })).resolves.toMatchObject({ ok: false, error: { code: "WALKTHROUGH_STATE_CHANGED" } });
  });

  it("returns honest pending state when start has not received the render acknowledgment", async () => {
    const { execute, setWaitBehavior } = fixture();
    setWaitBehavior("pending");
    await expect(execute("start_guided_walkthrough", {
      steps: [{ caption: "Client", objectIds: ["client"] }],
    })).resolves.toMatchObject({
      ok: true,
      data: { active: true, presentation: "pending", revision: 1 },
    });
  });

  it("rejects missing and kind-mismatched targets without replacing the active tour", async () => {
    const { execute, getActive } = fixture();
    const result = await execute("start_guided_walkthrough", {
      steps: [{ caption: "Invalid", objectIds: ["request"], connectorIds: ["missing"] }],
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "WALKTHROUGH_TARGET_INVALID",
        details: {
          connectorIdsSuppliedAsObjects: ["request"],
          missingConnectorIds: ["missing"],
        },
      },
    });
    expect(getActive()).toBeNull();
  });

  it("bounds step inputs and fences stale stop requests", async () => {
    const { execute, getActive } = fixture();
    await execute("start_guided_walkthrough", {
      steps: [{ caption: "Valid", objectIds: ["client"] }],
    });
    await expect(execute("stop_guided_walkthrough", { walkthroughId: "walkthrough-old" })).resolves.toMatchObject({
      ok: false,
      error: { code: "WALKTHROUGH_ID_CONFLICT" },
    });
    expect(getActive()?.id).toBe("walkthrough-demo");

    await expect(execute("start_guided_walkthrough", {
      steps: Array.from({ length: 21 }, () => ({ caption: "Too many", objectIds: ["client"] })),
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
  });
});
