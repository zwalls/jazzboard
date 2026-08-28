import { describe, expect, it, vi } from "vitest";

import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { ActorRef, CanvasObject, Participant, RoomState } from "@/lib/domain/types";

import {
  renderCanvasPreview,
  type CanvasPreviewRenderRequest,
} from "./canvas-preview";

const NOW = 10_000;

function actor(): ActorRef {
  return { participantId: "alice", displayName: "Alice", color: "#ef476f", kind: "agent" };
}

function participant(): Participant {
  const presence = { cursor: null, viewport: null, lastSeenAt: NOW, activity: null };
  return {
    participantId: "alice",
    displayName: "Alice",
    color: "#ef476f",
    role: "participant",
    joinedAt: NOW,
    lastSeenAt: NOW,
    connected: true,
    agentActive: true,
    human: structuredClone(presence),
    agent: structuredClone(presence),
  };
}

function object(id: string, revision = 1): CanvasObject {
  return {
    id,
    kind: "shape",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    zIndex: id === "a" ? 1 : 2,
    revision,
    groupId: null,
    diagramIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(),
    lastEditedBy: actor(),
    shape: "rectangle",
    nodeType: null,
    label: id,
    fill: "blue",
    stroke: "blue",
  };
}

function room(objects: CanvasObject[]): RoomState {
  return {
    id: "room-1",
    code: "1234",
    title: "Room",
    roomRevision: 8,
    createdAt: NOW,
    updatedAt: NOW,
    participants: { alice: participant() },
    objects: Object.fromEntries(objects.map((item) => [item.id, item])),
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function request(objects: CanvasObject[], overrides: Partial<CanvasPreviewRenderRequest["options"]> = {}): CanvasPreviewRenderRequest {
  return {
    roomId: "room-1",
    authoritativeRoomRevision: 8,
    source: {
      kind: "objects",
      targets: objects.map((item) => ({ objectId: item.id, expectedRevision: item.revision })),
    },
    objects,
    diagram: null,
    options: {
      padding: 10,
      maxWidth: 100,
      maxHeight: 200,
      pixelRatio: 1,
      maxBytes: 1_000,
      ...overrides,
    },
  };
}

function canvasFor(
  objects: CanvasObject[],
  blob = new Blob(["png"], { type: "image/png" }),
  warnings: readonly string[] = [],
) {
  const projected = new Map(objects.map((item) => [item.id, item]));
  const bounds = new Map([
    ["a", { x: 0, y: 0, width: 100, height: 50 }],
    ["b", { x: 50, y: 100, width: 100, height: 50 }],
  ]);
  const renderPng = vi.fn(async () => ({ blob, logicalWidth: 100, logicalHeight: 100, warnings }));
  const canvas = {
    rendererId: "tldraw-v3",
    capabilities: { renderPng: true },
    isObjectProjectionExact: (candidate: CanvasObject) => projected.get(candidate.id) === candidate,
    getVisibleBounds: (objectIds: readonly string[]) => {
      const selected = objectIds.flatMap((id) => bounds.get(id) ?? []);
      if (!selected.length) return null;
      const x = Math.min(...selected.map((item) => item.x));
      const y = Math.min(...selected.map((item) => item.y));
      const maxX = Math.max(...selected.map((item) => item.x + item.width));
      const maxY = Math.max(...selected.map((item) => item.y + item.height));
      return { x, y, width: maxX - x, height: maxY - y };
    },
    renderPng,
  } as unknown as CanvasRuntime;
  return { canvas, renderPng };
}

describe("exact canvas preview renderer", () => {
  it("exports only exact target shape IDs with a tight crop and bounded scale", async () => {
    const objects = [object("a"), object("b")];
    const currentRoom = room(objects);
    const { canvas, renderPng } = canvasFor(objects, undefined, ["One image used a placeholder."]);

    const result = await renderCanvasPreview(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(objects),
      new AbortController().signal,
    );

    expect(renderPng).toHaveBeenCalledWith(["a", "b"], {
      background: true,
      darkMode: false,
      padding: 10,
      pixelRatio: 1,
      scale: 100 / 170,
      signal: expect.any(AbortSignal),
    });
    expect(result.metadata).toMatchObject({
      width: 100,
      height: 100,
      byteLength: 3,
      renderedBounds: { x: -10, y: -10, width: 170, height: 170 },
      source: {
        objectRevisions: [
          { objectId: "a", revision: 1 },
          { objectId: "b", revision: 1 },
        ],
      },
      warnings: [
        "One image used a placeholder.",
        "The preview was downscaled to fit the requested dimensions.",
      ],
    });
  });

  it("fails rather than rendering a newer local scope under an old revision target", async () => {
    const expected = object("a", 1);
    const newer = object("a", 2);
    const { canvas, renderPng } = canvasFor([expected]);

    await expect(
      renderCanvasPreview(
        { getCanvasRuntime: () => canvas, getRoom: () => room([newer]) },
        request([expected]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "OBJECT_REVISION_CONFLICT" });
    expect(renderPng).not.toHaveBeenCalled();
  });

  it("fails immediately when an exact object identity was deleted or replaced", async () => {
    const expected = object("a", 1);
    const replacement = { ...object("a", 1), createdAt: NOW + 1 };
    const { canvas, renderPng } = canvasFor([expected]);

    await expect(
      renderCanvasPreview(
        { getCanvasRuntime: () => canvas, getRoom: () => room([replacement]) },
        request([expected]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "PREVIEW_SCOPE_CHANGED" });
    expect(renderPng).not.toHaveBeenCalled();
  });

  it("times out truthfully when the exact authoritative projection never arrives", async () => {
    const expected = object("a");
    let now = 0;
    await expect(
      renderCanvasPreview(
        {
          getCanvasRuntime: () => null,
          getRoom: () => room([expected]),
          now: () => now,
          wait: async () => {
            now += 1_000;
          },
        },
        request([expected]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "PREVIEW_PROJECTION_TIMEOUT" });
  });

  it("discards a render that exceeds the exact byte budget", async () => {
    const expected = object("a");
    const currentRoom = room([expected]);
    const { canvas } = canvasFor([expected], new Blob(["0123456789"]));

    await expect(
      renderCanvasPreview(
        { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
        request([expected], { maxBytes: 4 }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "PREVIEW_BYTE_BUDGET_EXCEEDED" });
  });
});
