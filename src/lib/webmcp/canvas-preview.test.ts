import { describe, expect, it, vi } from "vitest";

import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { ActorRef, CanvasObject, Participant, RoomState } from "@/lib/domain/types";

import {
  prepareCanvasInspection,
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

function object(id: string, revision = 1): Extract<CanvasObject, { kind: "shape" }> {
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
  const bounds = new Map(objects.map((item, index) => [
    item.id,
    index === 0
      ? { x: 0, y: 0, width: 100, height: 50 }
      : { x: 50, y: index * 100, width: 100, height: 50 },
  ]));
  const renderPng = vi.fn(async () => ({ blob, logicalWidth: 100, logicalHeight: 100, warnings }));
  const canvas = {
    rendererId: "jazzboard-semantic-v1",
    capabilities: { renderPng: true },
    isObjectProjectionExact: (candidate: CanvasObject) => projected.get(candidate.id) === candidate,
    getDocumentObjectIds: () => objects.map((item) => item.id),
    getObjectBounds: (objectId: string) => bounds.get(objectId) ?? null,
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
  it("prepares semantic evidence without creating a duplicate PNG surface", async () => {
    const objects = [object("a"), object("b")];
    const currentRoom = room(objects);
    const { canvas, renderPng } = canvasFor(objects);

    const result = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(objects),
      new AbortController().signal,
    );

    expect(result).not.toHaveProperty("blob");
    expect(renderPng).not.toHaveBeenCalled();
    expect(result.metadata).not.toHaveProperty("width");
    expect(result.metadata).not.toHaveProperty("height");
    expect(result.metadata).not.toHaveProperty("byteLength");
    expect(result.metadata.inspectionEvidence).toMatchObject({
      schemaVersion: 1,
      rendererId: "jazzboard-semantic-v1",
      objects: [
        expect.objectContaining({ objectId: "a", revision: 1, inRequestedScope: true }),
        expect.objectContaining({ objectId: "b", revision: 1, inRequestedScope: true }),
      ],
    });
  });

  it("returns bounded path evidence and discloses unsupported path and transparent contrast analysis", async () => {
    const path: CanvasObject = {
      ...object("a"),
      kind: "path",
      start: { x: 0, y: 0 },
      segments: Array.from({ length: 20 }, (_, index) => ({
        kind: "line" as const,
        to: { x: index + 1, y: index % 3 },
      })),
      closed: false,
      fill: "none",
      stroke: "black",
      strokeWidth: 3,
      opacity: 0.7,
      lineCap: "round",
      lineJoin: "round",
      fillRule: "nonzero",
    };
    const alphaShape: CanvasObject = {
      ...object("b"),
      fill: "#ffffff80",
      stroke: "#000000",
    };
    const currentRoom = room([path, alphaShape]);
    const { canvas } = canvasFor([path, alphaShape]);

    const result = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request([path, alphaShape]),
      new AbortController().signal,
    );
    const evidence = result.metadata.inspectionEvidence!;

    expect(evidence.objects[0].semantic).toMatchObject({
      kind: "path",
      segmentCount: 20,
      segmentDigest: expect.stringMatching(/^fnv1a32:/),
      sample: expect.any(Array),
      sampleTruncated: true,
      fill: "none",
      opacity: 0.7,
    });
    expect(evidence.objects[0].semantic.kind).toBe("path");
    if (evidence.objects[0].semantic.kind !== "path") throw new Error("expected path evidence");
    expect(evidence.objects[0].semantic.sample).toHaveLength(16);
    expect(evidence.coverage).toMatchObject({
      geometry: "partial",
      unsupported: expect.arrayContaining([
        expect.objectContaining({ objectId: "a", analysis: "vector_path_geometry" }),
        expect.objectContaining({ objectId: "a", analysis: "context_dependent_contrast" }),
        expect.objectContaining({ objectId: "b", analysis: "context_dependent_contrast" }),
      ]),
    });
    expect(evidence.contrastFindings).toEqual([]);
  });

  it("returns bounded per-kind semantics and neutral contrast measurements", async () => {
    const longText = "x".repeat(400);
    const points = Array.from({ length: 20 }, (_, index) => ({ x: index, y: index % 4 }));
    const objects: CanvasObject[] = [
      {
        ...object("text"),
        kind: "text",
        content: longText,
        color: "#111111",
        size: "m",
        align: "middle",
      },
      {
        ...object("shape"),
        kind: "shape",
        shape: "diamond",
        nodeType: "service",
        label: longText,
        fill: "#ffffff",
        stroke: "#000000",
      },
      {
        ...object("connector"),
        kind: "connector",
        start: { x: 1, y: 2, objectId: "shape", isPrecise: true },
        end: { x: 3, y: 4, objectId: null },
        direction: "end",
        label: longText,
        color: "#222222",
      },
      {
        ...object("image"),
        kind: "image",
        url: `https://example.test/${"u".repeat(500)}`,
        sourceUrl: `https://example.test/${"s".repeat(500)}`,
        assetId: "asset-1",
        alt: longText,
        mimeType: "image/png",
        locked: true,
      },
      {
        ...object("draw"),
        kind: "draw",
        points,
        color: "#333333",
        size: "l",
      },
      {
        ...object("path"),
        kind: "path",
        start: { x: 0, y: 0 },
        segments: [{ kind: "line", to: { x: 1, y: 1 } }],
        closed: true,
        fill: "#ffffff",
        stroke: "#000000",
        strokeWidth: 2,
        opacity: 1,
        lineCap: "round",
        lineJoin: "bevel",
        fillRule: "evenodd",
      },
    ];
    const currentRoom = room(objects);
    const { canvas } = canvasFor(objects);
    const result = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(objects),
      new AbortController().signal,
    );
    const evidence = result.metadata.inspectionEvidence!;
    const semantics = new Map(evidence.objects.map((item) => [item.kind, item.semantic]));

    expect(semantics.get("text")).toMatchObject({
      kind: "text",
      content: {
        value: "x".repeat(256),
        originalLength: 400,
        truncated: true,
        digest: expect.stringMatching(/^fnv1a32:/),
      },
      color: "#111111",
      size: "m",
      align: "middle",
    });
    expect(semantics.get("shape")).toMatchObject({
      kind: "shape",
      shape: "diamond",
      nodeType: "service",
      label: { originalLength: 400, truncated: true },
      fill: "#ffffff",
      stroke: "#000000",
    });
    expect(semantics.get("connector")).toMatchObject({
      kind: "connector",
      direction: "end",
      color: "#222222",
      start: { objectId: "shape", isPrecise: true },
      end: { objectId: null },
      label: { originalLength: 400, truncated: true },
    });
    expect(semantics.get("image")).toMatchObject({
      kind: "image",
      alt: { originalLength: 400, truncated: true },
      mimeType: "image/png",
      locked: true,
      omittedFields: ["url", "sourceUrl"],
    });
    expect(semantics.get("draw")).toMatchObject({
      kind: "draw",
      pointCount: 20,
      pointDigest: expect.stringMatching(/^fnv1a32:/),
      sampleTruncated: true,
    });
    const drawSemantic = semantics.get("draw");
    if (drawSemantic?.kind !== "draw") throw new Error("expected draw evidence");
    expect(drawSemantic.sample).toHaveLength(16);
    expect(semantics.get("path")).toMatchObject({
      kind: "path",
      start: { x: 0, y: 0 },
      segmentCount: 1,
      fillRule: "evenodd",
    });
    expect(evidence.relationships[0]?.label).toMatchObject({ originalLength: 400, truncated: true });
    expect(JSON.stringify(evidence)).not.toContain("u".repeat(500));
    expect(JSON.stringify(evidence)).not.toContain("s".repeat(500));
    expect(evidence.textFindings).toContainEqual(expect.objectContaining({
      objectId: "text",
      code: "TEXT_LIKELY_CLIPPED",
      status: "likely",
    }));
    const contrast = evidence.contrastFindings.find((item) => item.objectId === "shape")!;
    expect(contrast).toMatchObject({ ratio: 21, context: "stroke_vs_fill", caveat: expect.any(String) });
    expect(contrast).not.toHaveProperty("status");
  });

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
