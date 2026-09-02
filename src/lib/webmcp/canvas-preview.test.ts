import { describe, expect, it, vi } from "vitest";

import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { ActorRef, CanvasObject, Diagram, Participant, RoomState } from "@/lib/domain/types";

import {
  CANVAS_PREVIEW_LIMITS,
  prepareCanvasInspection,
  renderCanvasPreview,
  type CanvasInspectionRequest,
  type CanvasPreviewRenderRequest,
} from "./canvas-preview";
import { InRoomCanvasPreviewTransport } from "./in-room-preview-transport";

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
    semanticName: `Named ${id}`,
    semanticRole: "visual-part",
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

function inspection(
  representation: CanvasInspectionRequest["representation"] = "working_set",
  focusObjectIds: string[] = [],
  previousFindingKeys: string[] = [],
): CanvasInspectionRequest {
  return {
    representation,
    focusObjectIds,
    visualContract: null,
    previousFindingKeys,
  };
}

function request(
  objects: CanvasObject[],
  overrides: Partial<CanvasPreviewRenderRequest["options"]> = {},
  inspectionRequest: CanvasInspectionRequest = inspection(),
): CanvasPreviewRenderRequest {
  return {
    roomId: "room-1",
    authoritativeRoomRevision: 8,
    source: {
      kind: "objects",
      targets: objects.map((item) => ({ objectId: item.id, expectedRevision: item.revision })),
    },
    objects,
    diagram: null,
    inspection: inspectionRequest,
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
  boundsOverride: Readonly<Record<string, { x: number; y: number; width: number; height: number }>> = {},
) {
  const projected = new Map(objects.map((item) => [item.id, item]));
  const bounds = new Map(objects.map((item, index) => [
    item.id,
    boundsOverride[item.id] ?? (index === 0
      ? { x: 0, y: 0, width: 100, height: 50 }
      : { x: 50, y: index * 100, width: 100, height: 50 }),
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
      schemaVersion: 2,
      rendererId: "jazzboard-semantic-v1",
      representation: "working_set",
      overview: { objectCount: 2, kinds: { shape: 2 } },
      composition: { framing: { scopeKind: "objects", fullRoomContext: false } },
      workingSet: [
        expect.objectContaining({
          objectId: "a",
          revision: 1,
          semanticName: "Named a",
          semanticRole: "visual-part",
          inRequestedScope: true,
        }),
        expect.objectContaining({ objectId: "b", revision: 1, inRequestedScope: true }),
      ],
      focused: [],
    });
    expect(result.metadata.inspectionEvidence?.workingSet[0]).not.toHaveProperty("semantic");
  });

  it("reports whole-room scale and spatial context as neutral composition facts", async () => {
    const objects = [
      { ...object("small-a"), x: 0, y: 0, width: 100, height: 100 },
      { ...object("small-b"), x: 160, y: 0, width: 100, height: 100 },
      { ...object("small-c"), x: 320, y: 0, width: 100, height: 100 },
      { ...object("large-isolated"), x: 1_200, y: 0, width: 800, height: 600 },
    ];
    const bounds = Object.fromEntries(objects.map((item) => [item.id, {
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    }]));
    const currentRoom = room(objects);
    const { canvas } = canvasFor(objects, undefined, [], bounds);
    const roomRequest: CanvasPreviewRenderRequest = {
      ...request(objects, {}, inspection("overview")),
      source: { kind: "room", expectedRevision: currentRoom.roomRevision },
    };

    const result = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      roomRequest,
      new AbortController().signal,
    );
    const context = result.metadata.inspectionEvidence!;

    expect(context.scope).toMatchObject({ kind: "room", diagramId: null });
    expect(context.composition).toMatchObject({
      basis: "axis_aligned_renderer_bounds",
      interpretation: "descriptive_relative_geometry_not_quality_judgment",
      framing: {
        scopeKind: "room",
        fullRoomContext: true,
        scopeBounds: { x: 0, y: 0, width: 2_000, height: 600 },
        framedBounds: { x: -10, y: -10, width: 2_020, height: 620 },
        padding: 10,
      },
      scale: {
        measuredObjectCount: 4,
        medianBoundsArea: 10_000,
        largestObjects: expect.arrayContaining([expect.objectContaining({
          objectId: "large-isolated",
          boundsArea: 480_000,
          areaToMedianRatio: 48,
          widthToScopeRatio: 0.4,
          heightToScopeRatio: 1,
        })]),
      },
      distribution: {
        nearestNeighbor: {
          normalization: "scope_diagonal",
          farthestObjects: expect.arrayContaining([expect.objectContaining({
            objectId: "large-isolated",
            nearestObjectId: "small-c",
          })]),
        },
      },
    });
    expect(context.findingKeys).toEqual([]);
    expect(JSON.stringify(context.composition)).not.toMatch(/defect|warning|fail/i);
  });

  it("keeps heterogeneous freeform composition evidence bounded and independent of creative intent", async () => {
    const background = { ...object("background"), x: 0, y: 0, width: 1_000, height: 800 };
    const subject = { ...object("subject"), x: 380, y: 220, width: 240, height: 320 };
    const decorations = Array.from({ length: 12 }, (_, index) => ({
      ...object(`star-${index}`),
      x: 60 + index * 70,
      y: index % 2 ? 80 : 690,
      width: 10,
      height: 10,
      groupId: "portrait:stars",
    }));
    const objects = [background, subject, ...decorations];
    const bounds = Object.fromEntries(objects.map((item) => [item.id, {
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    }]));
    const currentRoom = room(objects);
    const { canvas } = canvasFor(objects, undefined, [], bounds);
    const baseRequest = request(objects, {}, inspection("overview"));
    const intentionalRequest: CanvasPreviewRenderRequest = {
      ...baseRequest,
      inspection: {
        ...inspection("overview"),
        visualContract: {
          intent: "A layered portrait with an intentionally oversized background and tiny stars.",
          criteria: ["Keep the decorative scale contrast"],
          preserveObjectIds: ["background", "subject"],
        },
      },
    };

    const base = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      baseRequest,
      new AbortController().signal,
    );
    const intentional = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      intentionalRequest,
      new AbortController().signal,
    );
    const baseContext = base.metadata.inspectionEvidence!;
    const intentionalContext = intentional.metadata.inspectionEvidence!;

    expect(intentionalContext.composition).toEqual(baseContext.composition);
    expect(intentionalContext.composition.scale).toMatchObject({
      measuredObjectCount: 14,
      medianBoundsArea: 100,
      largestObjectCoverage: { returnedCount: 8, omittedCount: 6, limit: 8, truncated: true },
      heterogeneityCaveat:
        "median_area_is_selection_sensitive_for_mixed_decorative_and_structural_parts",
    });
    expect(intentionalContext.composition.distribution.nearestNeighbor).toMatchObject({
      farthestObjectCoverage: { returnedCount: 8, omittedCount: 6, limit: 8, truncated: true },
      caveat: "center_distance_is_not_edge_clearance_or_integration_quality",
    });
    expect(intentionalContext.findingKeys).toEqual([]);
    expect(intentionalContext.composition).not.toHaveProperty("status");
    expect(intentionalContext.composition).not.toHaveProperty("recommendation");
  });

  it("returns truthful null scale and distribution summaries for connector-only scope", async () => {
    const connector: CanvasObject = {
      ...object("route-only"),
      kind: "connector",
      start: { x: 0, y: 0, objectId: null },
      end: { x: 300, y: 120, objectId: null },
      routing: { mode: "straight", kind: "straight", bend: 0, elbowMidPoint: 0.5, labelPosition: 0.5 },
      direction: "end",
      label: "",
      color: "black",
    };
    const currentRoom = room([connector]);
    const { canvas } = canvasFor([connector], undefined, [], {
      "route-only": { x: 0, y: 0, width: 300, height: 120 },
    });

    const result = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request([connector]),
      new AbortController().signal,
    );

    expect(result.metadata.inspectionEvidence!.composition).toMatchObject({
      scale: {
        measuredObjectCount: 0,
        medianBoundsArea: null,
        totalBoundsArea: 0,
        summedBoundsAreaToScopeAreaRatio: 0,
        largestObjects: [],
      },
      distribution: {
        objectCenterAverageNormalized: null,
        areaWeightedCenterNormalized: null,
        quadrantObjectCounts: { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 },
        nearestNeighbor: { medianNormalizedDistance: null, farthestObjects: [] },
      },
    });
  });

  it("bounds compact Diagram membership while reporting exact full-set coverage and a digest", async () => {
    const diagramIds = Array.from({ length: 40 }, (_, index) => `diagram-${index.toString().padStart(2, "0")}`);
    const manyMemberships = { ...object("a"), diagramIds: [...diagramIds].reverse() };
    const currentRoom = room([manyMemberships]);
    const { canvas } = canvasFor([manyMemberships]);

    const result = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request([manyMemberships]),
      new AbortController().signal,
    );
    const record = result.metadata.inspectionEvidence!.workingSet[0];

    expect(record.diagramIds).toEqual(diagramIds.slice(0, 16));
    expect(record.diagramMembershipCoverage).toEqual({
      totalDiagramCount: 40,
      returnedDiagramCount: 16,
      omittedDiagramCount: 24,
      limit: 16,
      truncated: true,
      fullSetDigest: expect.stringMatching(/^fnv1a32:/),
    });
    expect(JSON.stringify(record)).not.toContain("diagram-39");

    const changedMemberships = {
      ...manyMemberships,
      diagramIds: [...diagramIds.slice(0, -1), "diagram-replacement"],
    };
    const changedRoom = room([changedMemberships]);
    const changedCanvas = canvasFor([changedMemberships]).canvas;
    const changed = await prepareCanvasInspection(
      { getCanvasRuntime: () => changedCanvas, getRoom: () => changedRoom },
      request([changedMemberships]),
      new AbortController().signal,
    );
    expect(changed.metadata.inspectionEvidence!.workingSet[0].diagramIds).toEqual(record.diagramIds);
    expect(changed.metadata.inspectionEvidence!.workingSet[0].diagramMembershipCoverage.fullSetDigest)
      .not.toBe(record.diagramMembershipCoverage.fullSetDigest);
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
      request([path, alphaShape], {}, inspection("focus", ["a", "b"])),
      new AbortController().signal,
    );
    const evidence = result.metadata.inspectionEvidence!;

    expect(evidence.focused[0].semantic).toMatchObject({
      kind: "path",
      segmentCount: 20,
      segmentDigest: expect.stringMatching(/^fnv1a32:/),
      sample: expect.any(Array),
      sampleTruncated: true,
      fill: "none",
      opacity: 0.7,
    });
    expect(evidence.focused[0].semantic.kind).toBe("path");
    if (evidence.focused[0].semantic.kind !== "path") throw new Error("expected path evidence");
    expect(evidence.focused[0].semantic.sample).toHaveLength(16);
    expect(evidence.coverage).toMatchObject({
      geometry: "partial",
      unsupported: expect.arrayContaining([
        expect.objectContaining({ objectId: "a", analysis: "vector_path_geometry" }),
        expect.objectContaining({ objectId: "a", analysis: "context_dependent_contrast" }),
        expect.objectContaining({ objectId: "b", analysis: "context_dependent_contrast" }),
      ]),
    });
    expect(evidence.contrastFindings).toEqual([]);

    const absentKey = `${evidence.scope.identity}:diagram:connector_crossing:deadbeef`;
    const repeated = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request([path, alphaShape], {}, inspection("focus", ["a", "b"], [absentKey])),
      new AbortController().signal,
    );
    expect(repeated.metadata.inspectionEvidence).toMatchObject({
      coverage: { geometry: "partial" },
      findingComparison: {
        basis: "caller_supplied_unverified",
        currentFindingCoverageComplete: false,
        callerSuppliedSameScopeKeysNotObserved: [],
      },
    });
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
      request(objects, {}, inspection("focus", objects.map((object) => object.id))),
      new AbortController().signal,
    );
    const evidence = result.metadata.inspectionEvidence!;
    const semantics = new Map(evidence.focused.map((item) => [item.kind, item.semantic]));

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

  it("keeps path-heavy art compact in overview and exposes full semantics only for a focused stroke", async () => {
    const paths: CanvasObject[] = Array.from({ length: 40 }, (_, index) => ({
      ...object(`stroke-${index}`),
      kind: "path" as const,
      zIndex: index,
      start: { x: 0, y: 0 },
      segments: Array.from({ length: 64 }, (__, segment) => ({
        kind: "line" as const,
        to: { x: segment / 64, y: ((segment + index) % 7) / 7 },
      })),
      closed: false,
      fill: "none",
      stroke: "#3a2a20",
      strokeWidth: 2,
      opacity: 0.85,
      lineCap: "round" as const,
      lineJoin: "round" as const,
      fillRule: "nonzero" as const,
    }));
    const currentRoom = room(paths);
    const { canvas } = canvasFor(paths);

    const overviewResult = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(paths, {}, inspection("overview")),
      new AbortController().signal,
    );
    const overview = overviewResult.metadata.inspectionEvidence!;
    expect(overview).toMatchObject({
      representation: "overview",
      overview: { objectCount: 40, kinds: { path: 40 } },
      workingSet: [],
      focused: [],
      coverage: {
        allExplicitTargetsRepresented: true,
        geometry: "partial",
        resultByteLimit: CANVAS_PREVIEW_LIMITS.maxSceneContextBytes,
      },
    });
    expect(overview.coverage.resultByteLength).toBeLessThanOrEqual(overview.coverage.resultByteLimit);

    const focusResult = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(paths, {}, inspection("focus", ["stroke-20"])),
      new AbortController().signal,
    );
    const focus = focusResult.metadata.inspectionEvidence!;
    expect(focus.representation).toBe("focus");
    expect(focus.workingSet.map((record) => record.objectId)).toContain("stroke-20");
    expect(focus.focused).toHaveLength(1);
    expect(focus.focused[0].semantic).toMatchObject({
      kind: "path",
      segmentCount: 64,
      sampleTruncated: true,
    });
    expect(focusResult.metadata.renderedBounds).not.toEqual(overviewResult.metadata.renderedBounds);
    expect(focus.overview.bounds).toEqual(overview.overview.bounds);
  });

  it("handles the maximum overview without reading path segments or re-fetching bounds", async () => {
    const paths: CanvasObject[] = Array.from({ length: CANVAS_PREVIEW_LIMITS.maxTargets }, (_, index) => {
      const path = {
        ...object(`path-${index}`),
        kind: "path" as const,
        zIndex: index,
        start: { x: 0, y: 0 },
        segments: [],
        closed: false,
        fill: "#ffffff",
        stroke: "#000000",
        strokeWidth: 2,
        opacity: 1,
        lineCap: "round" as const,
        lineJoin: "round" as const,
        fillRule: "nonzero" as const,
      } satisfies CanvasObject;
      Object.defineProperty(path, "segments", {
        enumerable: true,
        get: () => {
          throw new Error("overview must not read full path geometry");
        },
      });
      return path;
    });
    const currentRoom = room(paths);
    const preparedCanvas = canvasFor(paths).canvas;
    const getObjectBounds = vi.fn(preparedCanvas.getObjectBounds.bind(preparedCanvas));
    const canvas = { ...preparedCanvas, getObjectBounds } as CanvasRuntime;

    const result = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(paths, {}, inspection("overview")),
      new AbortController().signal,
    );
    const context = result.metadata.inspectionEvidence!;

    expect(context.overview.objectCount).toBe(CANVAS_PREVIEW_LIMITS.maxTargets);
    expect(context.workingSet).toEqual([]);
    expect(context.focused).toEqual([]);
    expect(context.revisions.explicitObjectRevisionCoverage).toMatchObject({
      totalCount: CANVAS_PREVIEW_LIMITS.maxTargets,
      truncated: true,
    });
    expect(getObjectBounds).toHaveBeenCalledTimes(CANVAS_PREVIEW_LIMITS.maxTargets);
    expect(context.coverage.resultByteLength).toBeLessThanOrEqual(
      CANVAS_PREVIEW_LIMITS.maxSceneContextBytes,
    );
  });

  it("keeps a 91-object path-heavy Diagram focus bounded to exact focus plus deterministic context", async () => {
    const paths: CanvasObject[] = Array.from({ length: 91 }, (_, index) => ({
      ...object(`mona-stroke-${index}`),
      kind: "path" as const,
      zIndex: index,
      diagramIds: ["diagram-1"],
      start: { x: 0, y: 0 },
      segments: Array.from({ length: 64 }, (__, segment) => ({
        kind: "line" as const,
        to: { x: segment / 64, y: ((segment + index) % 11) / 11 },
      })),
      closed: false,
      fill: "none",
      stroke: "#3a2a20",
      strokeWidth: 2,
      opacity: 0.85,
      lineCap: "round" as const,
      lineJoin: "round" as const,
      fillRule: "nonzero" as const,
    }));
    const diagram: Diagram = {
      id: "diagram-1",
      title: "Mona",
      description: "Path-heavy portrait",
      diagramType: "custom",
      category: null,
      tags: [],
      memberObjectIds: paths.map((object) => object.id),
      connectorIds: [],
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      revision: 4,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: actor(),
      lastEditedBy: actor(),
    };
    const currentRoom = room(paths);
    currentRoom.diagrams[diagram.id] = diagram;
    const sharedBounds = Object.fromEntries(paths.map((path) => [
      path.id,
      { x: 0, y: 0, width: 100, height: 50 },
    ]));
    const { canvas } = canvasFor(paths, undefined, [], sharedBounds);
    const focusObjectIds = paths.slice(0, 13).map((object) => object.id);
    const focusRequest: CanvasPreviewRenderRequest = {
      ...request(paths, {}, inspection("focus", focusObjectIds)),
      source: { kind: "diagram", diagramId: diagram.id, expectedRevision: diagram.revision },
      diagram,
    };

    const artifact = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      focusRequest,
      new AbortController().signal,
    );
    const context = artifact.metadata.inspectionEvidence!;
    expect(context.focused.map((record) => record.objectId)).toEqual(focusObjectIds);
    expect(context.workingSet.length).toBeLessThanOrEqual(21);
    expect(context.workingSet.map((record) => record.objectId)).not.toContain("mona-stroke-90");
    expect(context.coverage).toMatchObject({
      scopeObjectCount: 91,
      visualContributorCount: 91,
      focusedRecordCount: 13,
      omittedCompactRecordCount: 70,
      findings: "partial",
    });
    expect(context.findingComparison).toMatchObject({
      basis: "caller_supplied_unverified",
      currentFindingCoverageComplete: false,
      callerSuppliedSameScopeKeysNotObserved: [],
    });

    const returned = await new InRoomCanvasPreviewTransport().emit(
      artifact,
      async () => ({
        previewId: "mona-focus",
        clip: { coordinateSpace: "viewport-css-pixels", x: 2, y: 4, width: 100, height: 50 },
        expiresAt: 90_000,
        validation: {
          token: "mona-focus",
          activeSelector: '[data-canvas-inspection-token="mona-focus"]',
          status: "valid_until_invalidated",
        },
      }),
      new AbortController().signal,
      "inspect_canvas_scope",
    ) as {
      data: {
        sceneContext: { coverage: { resultByteLength: number; resultByteLimit: number } };
        resultSerialization: { byteLength: number; byteLimit: number };
      };
    };
    const actualByteLength = new TextEncoder().encode(JSON.stringify(returned.data.sceneContext)).byteLength;
    expect(returned.data.sceneContext.coverage.resultByteLength).toBe(actualByteLength);
    expect(actualByteLength).toBeLessThanOrEqual(returned.data.sceneContext.coverage.resultByteLimit);
    const actualResultByteLength = new TextEncoder().encode(JSON.stringify(returned)).byteLength;
    expect(returned.data.resultSerialization.byteLength).toBe(actualResultByteLength);
    expect(actualResultByteLength).toBeLessThanOrEqual(
      returned.data.resultSerialization.byteLimit,
    );
  });

  it("rejects a scene context whose host-capture metadata creates a hidden byte overage", async () => {
    const objects = [object("a")];
    const currentRoom = room(objects);
    const { canvas } = canvasFor(objects);
    const artifact = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(objects),
      new AbortController().signal,
    );
    const evidence = artifact.metadata.inspectionEvidence!;
    const oversizedArtifact = {
      metadata: {
        ...artifact.metadata,
        inspectionEvidence: {
          ...evidence,
          visualContract: {
            intent: "x".repeat(CANVAS_PREVIEW_LIMITS.maxSceneContextBytes),
            criteria: [],
            preserveObjectIds: [],
          },
        },
      },
    };

    await expect(new InRoomCanvasPreviewTransport().emit(
      oversizedArtifact,
      async () => ({
        previewId: "oversized-focus",
        clip: { coordinateSpace: "viewport-css-pixels", x: 0, y: 0, width: 100, height: 50 },
        expiresAt: 90_000,
      }),
      new AbortController().signal,
      "inspect_canvas_scope",
    )).rejects.toMatchObject({
      code: "PREVIEW_SCENE_CONTEXT_TOO_LARGE",
      details: {
        byteLength: expect.any(Number),
        maxBytes: CANVAS_PREVIEW_LIMITS.maxSceneContextBytes,
      },
    });
  });

  it("rejects a complete inspection result that exceeds the reserved WebMCP envelope", async () => {
    const objects = [object("a")];
    const currentRoom = room(objects);
    const { canvas } = canvasFor(objects);
    const artifact = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(objects),
      new AbortController().signal,
    );
    const oversizedEnvelopeField = "x".repeat(40_000);

    await expect(new InRoomCanvasPreviewTransport().emit(
      artifact,
      async () => ({
        previewId: "oversized-envelope",
        clip: { coordinateSpace: "viewport-css-pixels", x: 0, y: 0, width: 100, height: 50 },
        expiresAt: 90_000,
        validation: {
          token: oversizedEnvelopeField,
          activeSelector: oversizedEnvelopeField,
          status: "valid_until_invalidated",
        },
      }),
      new AbortController().signal,
      "inspect_canvas_scope",
    )).rejects.toMatchObject({
      code: "PREVIEW_INSPECTION_RESULT_TOO_LARGE",
      details: {
        byteLength: expect.any(Number),
        maxBytes: CANVAS_PREVIEW_LIMITS.maxInspectionResultBytes,
      },
    });
  });

  it("does not turn intentionally unlabeled illustration parts into correction findings", async () => {
    const decorativeShape: CanvasObject = {
      ...object("face-oval"),
      label: "",
      nodeType: null,
      semanticName: "Warm face oval",
      semanticRole: "illustration.subject.face",
    };
    const unlabeledConnector: CanvasObject = {
      ...object("smile-guide"),
      kind: "connector",
      label: "",
      start: { x: 20, y: 20, objectId: null },
      end: { x: 80, y: 20, objectId: null },
      routing: { mode: "curved", kind: "curved", bend: 32, elbowMidPoint: 0.5, labelPosition: 0.5 },
      direction: "none",
      color: "black",
    };
    const emptyArchitectureNode: CanvasObject = {
      ...object("service-node"),
      label: "",
      nodeType: "service",
      semanticName: "Playback session service",
      semanticRole: "architecture.service.playback-session",
    };
    const objects = [decorativeShape, unlabeledConnector, emptyArchitectureNode];
    const currentRoom = room(objects);
    const { canvas } = canvasFor(objects);

    const result = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(objects),
      new AbortController().signal,
    );
    const findings = result.metadata.inspectionEvidence!.textFindings;

    expect(findings).toEqual([
      expect.objectContaining({ objectId: "service-node", code: "TEXT_EMPTY" }),
    ]);
  });

  it("requires overview or a smaller scope for dense architecture working sets", async () => {
    const architecture = Array.from({ length: 121 }, (_, index): CanvasObject => ({
      ...object(`service-${index}`),
      zIndex: index,
      nodeType: index % 2 ? "service" : "component",
      label: `Architecture service ${index}`,
      semanticRole: "architecture-node",
    }));
    const currentRoom = room(architecture);
    const { canvas } = canvasFor(architecture);

    await expect(prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(architecture, {}, inspection("working_set")),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "PREVIEW_WORKING_SET_TOO_LARGE",
      details: { recordCount: 121, maxWorkingSetRecords: 120 },
    });

    const result = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(architecture, {}, inspection("overview")),
      new AbortController().signal,
    );
    const context = result.metadata.inspectionEvidence!;
    expect(context.overview).toMatchObject({ objectCount: 121, kinds: { shape: 121 } });
    expect(context.overview.spatialClusters.length).toBeLessThanOrEqual(16);
    expect(context.revisions.explicitObjectRevisions).toHaveLength(
      CANVAS_PREVIEW_LIMITS.maxExplicitRevisionRecords,
    );
    expect(context.revisions.explicitObjectRevisionCoverage).toMatchObject({
      totalCount: 121,
      returnedCount: CANVAS_PREVIEW_LIMITS.maxExplicitRevisionRecords,
      omittedCount: 121 - CANVAS_PREVIEW_LIMITS.maxExplicitRevisionRecords,
      truncated: true,
      fullSetDigest: expect.stringMatching(/^fnv1a32:/),
    });
    expect(context.coverage).toMatchObject({
      compactRecordCount: 0,
      allExplicitTargetsRepresented: true,
    });
    expect(context.coverage.resultByteLength).toBeLessThanOrEqual(context.coverage.resultByteLimit);
  });

  it("fails rather than silently omitting an explicit working-set target", async () => {
    const objects = [object("a"), object("b")];
    const currentRoom = room(objects);
    const prepared = canvasFor(objects).canvas;
    const canvas = {
      ...prepared,
      getObjectBounds: (objectId: string) => objectId === "b"
        ? null
        : prepared.getObjectBounds(objectId),
    } as CanvasRuntime;

    await expect(prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(objects),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "PREVIEW_EXPLICIT_TARGET_UNREPRESENTED",
      details: { objectIds: ["a", "b"] },
    });
  });

  it("reports AABB overlap only as a stable bounds fact, never as occlusion or a correction defect", async () => {
    const objects = [object("a"), object("b")];
    const currentRoom = room(objects);
    const { canvas } = canvasFor(objects, undefined, [], {
      a: { x: 0, y: 0, width: 100, height: 50 },
      b: { x: 50, y: 0, width: 100, height: 50 },
    });
    const result = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(objects),
      new AbortController().signal,
    );
    const context = result.metadata.inspectionEvidence!;

    expect(context.boundsOverlaps).toMatchObject({
      totalCount: 1,
      truncated: false,
      items: [{
        factKey: expect.stringMatching(/^bounds_overlap:/),
        method: "axis_aligned_renderer_bounds",
        objectIds: ["a", "b"],
        bounds: { x: 50, y: 0, width: 50, height: 50 },
        interpretation: "bounds_overlap_only_not_proof_of_painted_intersection_or_occlusion",
      }],
    });
    expect(context).not.toHaveProperty("occlusions");
    expect(context.findingKeys.some((key) => key.startsWith("bounds_overlap:"))).toBe(false);
    expect(
      context.findingComparison.observedFindingKeysNotSupplied
        .some((key) => key.startsWith("bounds_overlap:")),
    ).toBe(false);
  });

  it("reports a higher opaque rectangle covering a lower shape label even outside Diagram membership", async () => {
    const boundary = {
      ...object("trust-boundary", 4),
      x: 440,
      y: 150,
      width: 850,
      height: 500,
      zIndex: 0,
      label: "Commerce trust boundary",
      semanticName: "Commerce trust boundary",
      semanticRole: "architecture.trust_boundary",
    };
    const checkout = {
      ...object("checkout-api", 7),
      x: 580,
      y: 340,
      width: 180,
      height: 88,
      zIndex: 2,
      label: "Checkout API",
      semanticName: "Checkout API",
      semanticRole: "architecture.checkout_api",
      nodeType: "service" as const,
    };
    const objects = [boundary, checkout];
    const bounds = Object.fromEntries(objects.map((item) => [item.id, {
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    }]));
    const currentRoom = room(objects);
    const { canvas } = canvasFor(objects, undefined, [], bounds);

    const result = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request([checkout]),
      new AbortController().signal,
    );
    const context = result.metadata.inspectionEvidence!;

    expect(context.textOcclusionRisks).toEqual([
      expect.objectContaining({
        findingKey: expect.stringMatching(/^scope:v2:[a-f0-9]{8}:text:text_occlusion_risk:[a-f0-9]{8}$/),
        labelObjectId: "trust-boundary",
        labelObjectRevision: 4,
        occludingObjectId: "checkout-api",
        occludingObjectRevision: 7,
        source: "shape_label",
        method: "shared_text_layout_bounds_and_exact_rectangle_paint_order",
        status: "likely",
        summary: expect.stringMatching(/checkout-api.*trust-boundary.*Inspect the exact pixels/i),
      }),
    ]);
    expect(context.textOcclusionRisks[0].overlapBounds.width).toBeGreaterThan(0);
    expect(context.textOcclusionRisks[0].overlapBounds.height).toBeGreaterThan(0);
    expect(context.findingKeys).toContain(context.textOcclusionRisks[0].findingKey);
  });

  it("preserves deliberate unlabeled overlap without inventing a text-occlusion finding", async () => {
    const background = {
      ...object("portrait-background"),
      width: 600,
      height: 600,
      zIndex: 0,
      label: "",
      semanticRole: "drawing.background",
    };
    const face = {
      ...object("portrait-face"),
      x: 180,
      y: 120,
      width: 240,
      height: 320,
      zIndex: 2,
      label: "",
      shape: "ellipse" as const,
      semanticRole: "drawing.face",
    };
    const objects = [background, face];
    const bounds = Object.fromEntries(objects.map((item) => [item.id, {
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    }]));
    const currentRoom = room(objects);
    const { canvas } = canvasFor(objects, undefined, [], bounds);

    const result = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(objects),
      new AbortController().signal,
    );

    expect(result.metadata.inspectionEvidence!.boundsOverlaps.totalCount).toBe(1);
    expect(result.metadata.inspectionEvidence!.textOcclusionRisks).toEqual([]);
  });

  it("compares stable findings against caller-supplied unverified keys without claiming resolution", async () => {
    const text: CanvasObject = {
      ...object("portrait-caption"),
      kind: "text",
      content: "A".repeat(400),
      color: "#111111",
      size: "m",
      align: "middle",
    };
    const currentRoom = room([text]);
    const { canvas } = canvasFor([text]);
    const first = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request([text]),
      new AbortController().signal,
    );
    const firstContext = first.metadata.inspectionEvidence!;
    const findingKey = firstContext.findingKeys[0];
    expect(findingKey).toMatch(/^scope:v2:[a-f0-9]{8}:text:text_likely_clipped:/);

    const removedFindingKey = `${firstContext.scope.identity}:diagram:connector_crossing:deadbeef`;
    const second = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request([text], {}, inspection("working_set", [], [findingKey, removedFindingKey])),
      new AbortController().signal,
    );
    expect(second.metadata.inspectionEvidence!.findingComparison).toEqual({
      basis: "caller_supplied_unverified",
      suppliedKeyCount: 2,
      sameScopeSuppliedKeyCount: 2,
      ignoredDifferentScopeSuppliedKeyCount: 0,
      currentFindingCoverageComplete: true,
      observedFindingKeysNotSupplied: [],
      callerSuppliedFindingKeysObservedAgain: [findingKey],
      callerSuppliedSameScopeKeysNotObserved: [removedFindingKey],
      interpretation: "not_observed_does_not_prove_resolved",
    });
    expect(second.metadata.inspectionEvidence).not.toHaveProperty("correction");
  });

  it("never resolves prior findings after a focus switch or across a different exact scope", async () => {
    const clipped = (id: string): CanvasObject => ({
      ...object(id),
      kind: "text",
      content: "A".repeat(400),
      color: "#111111",
      size: "m",
      align: "middle",
    });
    const objects = [clipped("caption-a"), clipped("caption-b")];
    const currentRoom = room(objects);
    const { canvas } = canvasFor(objects);
    const first = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(objects, {}, inspection("focus", ["caption-a"])),
      new AbortController().signal,
    );
    const firstContext = first.metadata.inspectionEvidence!;
    const priorKey = firstContext.findingKeys[0];

    const switched = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(objects, {}, inspection("focus", ["caption-b"], [priorKey])),
      new AbortController().signal,
    );
    const switchedContext = switched.metadata.inspectionEvidence!;
    expect(switchedContext.scope.identity).not.toBe(firstContext.scope.identity);
    expect(switchedContext.findingComparison).toMatchObject({
      sameScopeSuppliedKeyCount: 0,
      ignoredDifferentScopeSuppliedKeyCount: 1,
      callerSuppliedFindingKeysObservedAgain: [],
      callerSuppliedSameScopeKeysNotObserved: [],
    });

    const narrower = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request([objects[0]], {}, inspection("focus", ["caption-a"], [priorKey])),
      new AbortController().signal,
    );
    const narrowerContext = narrower.metadata.inspectionEvidence!;
    expect(narrowerContext.scope.identity).not.toBe(firstContext.scope.identity);
    expect(narrowerContext.findingComparison).toMatchObject({
      sameScopeSuppliedKeyCount: 0,
      ignoredDifferentScopeSuppliedKeyCount: 1,
      callerSuppliedFindingKeysObservedAgain: [],
      callerSuppliedSameScopeKeysNotObserved: [],
    });
  });

  it("changes finding scope across object, Diagram, and room delete-recreate incarnations", async () => {
    const clipped = (createdAt: number): CanvasObject => ({
      ...object("caption"),
      createdAt,
      kind: "text",
      content: "A".repeat(400),
      color: "#111111",
      size: "m",
      align: "middle",
    });
    const originalObject = clipped(NOW);
    const originalRoom = room([originalObject]);
    const originalCanvas = canvasFor([originalObject]).canvas;
    const original = await prepareCanvasInspection(
      { getCanvasRuntime: () => originalCanvas, getRoom: () => originalRoom },
      request([originalObject]),
      new AbortController().signal,
    );
    const originalContext = original.metadata.inspectionEvidence!;
    const priorKey = originalContext.findingKeys[0];

    const revisedObject = { ...originalObject, revision: 2, updatedAt: NOW + 1 };
    const revisedRoom = room([revisedObject]);
    const revisedCanvas = canvasFor([revisedObject]).canvas;
    const afterMutableRevision = await prepareCanvasInspection(
      { getCanvasRuntime: () => revisedCanvas, getRoom: () => revisedRoom },
      request([revisedObject], {}, inspection("working_set", [], [priorKey])),
      new AbortController().signal,
    );
    expect(afterMutableRevision.metadata.inspectionEvidence!.scope.identity)
      .toBe(originalContext.scope.identity);
    expect(afterMutableRevision.metadata.inspectionEvidence!.findingComparison).toMatchObject({
      sameScopeSuppliedKeyCount: 1,
      callerSuppliedFindingKeysObservedAgain: [priorKey],
      callerSuppliedSameScopeKeysNotObserved: [],
    });

    const replacementObject = clipped(NOW + 1);
    const objectReplacementRoom = room([replacementObject]);
    const objectReplacementCanvas = canvasFor([replacementObject]).canvas;
    const afterObjectReplacement = await prepareCanvasInspection(
      { getCanvasRuntime: () => objectReplacementCanvas, getRoom: () => objectReplacementRoom },
      request([replacementObject], {}, inspection("working_set", [], [priorKey])),
      new AbortController().signal,
    );
    expect(afterObjectReplacement.metadata.inspectionEvidence!.scope.identity)
      .not.toBe(originalContext.scope.identity);
    expect(afterObjectReplacement.metadata.inspectionEvidence!.findingComparison).toMatchObject({
      sameScopeSuppliedKeyCount: 0,
      ignoredDifferentScopeSuppliedKeyCount: 1,
      callerSuppliedSameScopeKeysNotObserved: [],
    });

    const recreatedRoom = { ...originalRoom, createdAt: NOW + 2 };
    const afterRoomReplacement = await prepareCanvasInspection(
      { getCanvasRuntime: () => originalCanvas, getRoom: () => recreatedRoom },
      request([originalObject], {}, inspection("working_set", [], [priorKey])),
      new AbortController().signal,
    );
    expect(afterRoomReplacement.metadata.inspectionEvidence!.scope.identity)
      .not.toBe(originalContext.scope.identity);
    expect(afterRoomReplacement.metadata.inspectionEvidence!.findingComparison).toMatchObject({
      sameScopeSuppliedKeyCount: 0,
      ignoredDifferentScopeSuppliedKeyCount: 1,
    });

    const diagram = {
      id: "diagram-1",
      title: "Caption",
      description: "",
      diagramType: "custom" as const,
      category: null,
      tags: [],
      memberObjectIds: [originalObject.id],
      connectorIds: [],
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: actor(),
      lastEditedBy: actor(),
    } satisfies Diagram;
    const diagramRoom = room([originalObject]);
    diagramRoom.diagrams[diagram.id] = diagram;
    const diagramRequest: CanvasPreviewRenderRequest = {
      ...request([originalObject]),
      source: { kind: "diagram", diagramId: diagram.id, expectedRevision: diagram.revision },
      diagram,
    };
    const firstDiagram = await prepareCanvasInspection(
      { getCanvasRuntime: () => originalCanvas, getRoom: () => diagramRoom },
      diagramRequest,
      new AbortController().signal,
    );
    const diagramPriorKey = firstDiagram.metadata.inspectionEvidence!.findingKeys[0];
    const recreatedDiagram = { ...diagram, createdAt: NOW + 3 };
    const recreatedDiagramRoom = room([originalObject]);
    recreatedDiagramRoom.diagrams[diagram.id] = recreatedDiagram;
    const afterDiagramReplacement = await prepareCanvasInspection(
      { getCanvasRuntime: () => originalCanvas, getRoom: () => recreatedDiagramRoom },
      {
        ...diagramRequest,
        diagram: recreatedDiagram,
        inspection: inspection("working_set", [], [diagramPriorKey]),
      },
      new AbortController().signal,
    );
    expect(afterDiagramReplacement.metadata.inspectionEvidence!.scope.identity)
      .not.toBe(firstDiagram.metadata.inspectionEvidence!.scope.identity);
    expect(afterDiagramReplacement.metadata.inspectionEvidence!.findingComparison).toMatchObject({
      sameScopeSuppliedKeyCount: 0,
      ignoredDifferentScopeSuppliedKeyCount: 1,
      callerSuppliedSameScopeKeysNotObserved: [],
    });
  });

  it("does not list caller-supplied keys as absent when current finding coverage is incomplete", async () => {
    const objects: CanvasObject[] = Array.from({ length: 129 }, (_, index) => ({
      ...object(`caption-${index}`),
      kind: "text" as const,
      content: "A".repeat(400),
      color: "#111111",
      size: "m" as const,
      align: "middle" as const,
    }));
    const currentRoom = room(objects);
    const { canvas } = canvasFor(objects);
    const first = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(objects, {}, inspection("overview")),
      new AbortController().signal,
    );
    const firstContext = first.metadata.inspectionEvidence!;
    const absentKey = `${firstContext.scope.identity}:diagram:connector_crossing:deadbeef`;
    const second = await prepareCanvasInspection(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      request(objects, {}, inspection("overview", [], [absentKey])),
      new AbortController().signal,
    );
    expect(second.metadata.inspectionEvidence).toMatchObject({
      coverage: { findings: "partial" },
      findingKeysTruncated: true,
      findingComparison: {
        currentFindingCoverageComplete: false,
        callerSuppliedSameScopeKeysNotObserved: [],
      },
    });
  });

  it("keeps legacy render_canvas_preview semantic evidence populated without duplicating scene context", async () => {
    const objects = [object("a"), object("b")];
    const currentRoom = room(objects);
    const { canvas } = canvasFor(objects);
    const legacyRequest = request(objects);
    delete legacyRequest.inspection;
    const artifact = await renderCanvasPreview(
      { getCanvasRuntime: () => canvas, getRoom: () => currentRoom },
      legacyRequest,
      new AbortController().signal,
    );
    expect(artifact.metadata.inspectionEvidence).toMatchObject({
      schemaVersion: 2,
      representation: "working_set",
      workingSet: [
        expect.objectContaining({ objectId: "a", revision: 1 }),
        expect.objectContaining({ objectId: "b", revision: 1 }),
      ],
    });

    const returned = await new InRoomCanvasPreviewTransport().emit(
      artifact,
      async () => ({
        previewId: "legacy-preview",
        clip: { coordinateSpace: "viewport-css-pixels", x: 0, y: 0, width: 100, height: 100 },
        expiresAt: 90_000,
      }),
      new AbortController().signal,
      "render_canvas_preview",
    ) as { data: Record<string, unknown> };
    expect(returned.data.semanticEvidence).toMatchObject({
      workingSet: expect.arrayContaining([expect.objectContaining({ objectId: "a" })]),
    });
    expect(returned.data).not.toHaveProperty("sceneContext");
    expect(returned.data).not.toHaveProperty("inspectionEvidence");
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
