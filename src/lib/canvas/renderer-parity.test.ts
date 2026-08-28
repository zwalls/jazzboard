import { describe, expect, it, vi } from "vitest";
import type { Editor, TLShape, TLShapeId } from "tldraw";

import type {
  ActorRef,
  CanvasObject,
  ConnectorObject,
  CreateCanvasObject,
  RoomState,
} from "@/lib/domain/types";

const tldraw = vi.hoisted(() => ({
  getArrowInfo: vi.fn(),
}));

const projection = vi.hoisted(() => ({
  jazzboardMeta: vi.fn((shape: { meta?: { jazzboardId?: string } }) => ({
    objectId: shape.meta?.jazzboardId ?? null,
    revision: null,
    createdAt: null,
  })),
  tldrawShapeId: vi.fn((objectId: string) => `shape:${objectId}`),
  tldrawShapeToSemantic: vi.fn((_editor: Editor, shape: { draft?: CreateCanvasObject }) =>
    shape.draft ?? null),
}));

vi.mock("tldraw", () => tldraw);
vi.mock("@/lib/canvas/projection", () => projection);

import {
  captureTldrawRendererParitySnapshot,
  compareRendererParity,
  type RendererParitySnapshot,
} from "./renderer-parity";
import { buildSemanticScene, type SemanticScene } from "./semantic-scene";

const actor: ActorRef = {
  participantId: "participant-parity",
  displayName: "Parity",
  color: "violet",
  kind: "agent",
};

function base(id: string, zIndex: number) {
  return {
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    zIndex,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function shape(
  id: string,
  x: number,
  zIndex: number,
  groupId: string | null = null,
): Extract<CanvasObject, { kind: "shape" }> {
  return {
    ...base(id, zIndex),
    kind: "shape",
    x,
    groupId,
    shape: "rectangle",
    nodeType: "service",
    label: id,
    fill: "light-blue",
    stroke: "blue",
  };
}

function connector(
  id: string,
  startId: string,
  endId: string,
  zIndex: number,
): ConnectorObject {
  return {
    ...base(id, zIndex),
    kind: "connector",
    x: 100,
    y: 40,
    width: 200,
    height: 1,
    start: {
      x: 100,
      y: 40,
      objectId: startId,
      normalizedAnchor: { x: 1, y: 0.5 },
      isPrecise: true,
      isExact: false,
      snap: "edge",
    },
    end: {
      x: 300,
      y: 40,
      objectId: endId,
      normalizedAnchor: { x: 0, y: 0.5 },
      isPrecise: true,
      isExact: false,
      snap: "edge",
    },
    routing: {
      mode: "straight",
      kind: "straight",
      bend: 0,
      elbowMidPoint: 0.5,
      labelPosition: 0.5,
    },
    direction: "end",
    label: "request",
    color: "black",
  };
}

function room(objects: readonly CanvasObject[]): RoomState {
  return {
    id: "room-parity",
    code: "PARITY",
    title: "Renderer parity",
    stateRevision: 4,
    roomRevision: 9,
    createdAt: 1,
    updatedAt: 2,
    participants: {},
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function sceneWithConnector(): SemanticScene {
  const left = shape("left", 0, 1, "cluster");
  const right = shape("right", 300, 2, "cluster");
  const edge = connector("edge", left.id, right.id, 3);
  return buildSemanticScene(room([edge, right, left]));
}

function matchingSnapshot(scene: SemanticScene): RendererParitySnapshot {
  return {
    rendererId: "tldraw-v3",
    objects: scene.objects.map(({ object, bounds }) => ({
      objectId: object.id,
      kind: object.kind,
      rendererKind: object.kind === "shape" ? "geo" : object.kind === "connector" ? "arrow" : object.kind,
      bounds: { ...bounds },
      groupId: object.groupId,
      connector: object.kind === "connector"
        ? {
            start: { ...scene.connectorRoutes[object.id].start },
            end: { ...scene.connectorRoutes[object.id].end },
            routing: { ...scene.connectorRoutes[object.id].routing },
            routePoints: scene.connectorRoutes[object.id].points.map((point) => ({ ...point })),
          }
        : null,
    })),
    bounds: scene.bounds ? { ...scene.bounds } : null,
  };
}

describe("renderer parity comparison", () => {
  it("accepts exact projections and deterministic differences within tolerance", () => {
    const scene = sceneWithConnector();
    const exact = compareRendererParity(scene, matchingSnapshot(scene));

    expect(exact).toMatchObject({
      rendererId: "tldraw-v3",
      roomId: "room-parity",
      roomRevision: 9,
      matches: true,
      complete: true,
      authoritativeObjectCount: 3,
      rendererObjectCount: 3,
      comparedObjectCount: 3,
      totalDiagnosticCount: 0,
      omittedDiagnosticCount: 0,
    });
    expect(exact.diagnostics).toEqual([]);
    expect(Object.values(exact.summary).every((count) => count === 0)).toBe(true);

    const source = matchingSnapshot(scene);
    const withinTolerance: RendererParitySnapshot = {
      ...source,
      objects: [...source.objects].reverse().map((object) => ({
        ...object,
        bounds: object.bounds ? { ...object.bounds, x: object.bounds.x + 0.75 } : null,
        connector: object.connector
          ? {
              ...object.connector,
              start: {
                ...object.connector.start,
                x: object.connector.start.x + 0.75,
                normalizedAnchor: {
                  x: (object.connector.start.normalizedAnchor?.x ?? 0.5) + 0.000_5,
                  y: object.connector.start.normalizedAnchor?.y ?? 0.5,
                },
              },
              routing: {
                ...object.connector.routing,
                labelPosition: object.connector.routing.labelPosition + 0.000_5,
              },
              routePoints: object.connector.routePoints.map((point) => ({
                x: point.x + 0.75,
                y: point.y,
              })),
            }
          : null,
      })),
      bounds: source.bounds ? { ...source.bounds, x: source.bounds.x + 0.75 } : null,
    };

    expect(compareRendererParity(scene, withinTolerance).matches).toBe(true);
  });

  it("returns stable, field-level diagnostics for every parity dimension", () => {
    const scene = sceneWithConnector();
    const source = matchingSnapshot(scene);
    const edge = source.objects.find((object) => object.objectId === "edge");
    const left = source.objects.find((object) => object.objectId === "left");
    if (!edge?.connector || !left?.bounds) throw new Error("Expected connector fixture.");

    const snapshot: RendererParitySnapshot = {
      rendererId: "tldraw-v3",
      objects: [
        {
          ...left,
          kind: "text",
          rendererKind: "text",
          bounds: { ...left.bounds, x: left.bounds.x + 8 },
          groupId: null,
        },
        {
          ...edge,
          connector: {
            ...edge.connector,
            start: {
              ...edge.connector.start,
              x: edge.connector.start.x + 10,
              objectId: "unexpected",
            },
            routing: {
              mode: "curved",
              kind: "curved",
              bend: 40,
              elbowMidPoint: 0.5,
              labelPosition: 0.5,
            },
            routePoints: [
              { x: 110, y: 40 },
              { x: 200, y: 100 },
              { x: 300, y: 40 },
            ],
          },
        },
        {
          objectId: "unexpected",
          kind: "shape",
          rendererKind: "geo",
          bounds: { x: 500, y: 500, width: 20, height: 20 },
          groupId: "renderer-only-group",
          connector: null,
        },
      ],
      bounds: { x: 8, y: 0, width: 512, height: 520 },
    };

    const report = compareRendererParity(scene, snapshot);

    expect(report.matches).toBe(false);
    expect(report.complete).toBe(true);
    expect(report.diagnostics.map(({ code, objectId, groupId, field }) => ({
      code,
      objectId,
      groupId,
      field,
    }))).toEqual([
      { code: "connector_endpoint_mismatch", objectId: "edge", groupId: undefined, field: "start" },
      { code: "connector_route_mismatch", objectId: "edge", groupId: undefined, field: "route" },
      { code: "kind_mismatch", objectId: "left", groupId: undefined, field: "kind" },
      { code: "bounds_mismatch", objectId: "left", groupId: undefined, field: "bounds" },
      { code: "missing_object", objectId: "right", groupId: undefined, field: undefined },
      { code: "unexpected_object", objectId: "unexpected", groupId: undefined, field: undefined },
      { code: "group_membership_mismatch", objectId: undefined, groupId: "cluster", field: "members" },
      { code: "group_membership_mismatch", objectId: undefined, groupId: "renderer-only-group", field: "members" },
      { code: "scene_bounds_mismatch", objectId: undefined, groupId: undefined, field: "bounds" },
    ]);
    expect(report.summary).toMatchObject({
      missing_object: 1,
      unexpected_object: 1,
      kind_mismatch: 1,
      bounds_mismatch: 1,
      connector_endpoint_mismatch: 1,
      connector_route_mismatch: 1,
      group_membership_mismatch: 2,
      scene_bounds_mismatch: 1,
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("caps the detailed object walk and retained diagnostic payload", () => {
    const objects = Array.from({ length: 5 }, (_, index) => shape(`object-${index}`, index * 120, index));
    const scene = buildSemanticScene(room(objects));
    const report = compareRendererParity(
      scene,
      { rendererId: "bounded-test", objects: [], bounds: scene.bounds },
      { maxComparedObjects: 3, maxDiagnostics: 2 },
    );

    expect(report).toMatchObject({
      rendererId: "bounded-test",
      matches: false,
      complete: false,
      comparedObjectCount: 0,
      totalDiagnosticCount: 4,
      omittedDiagnosticCount: 2,
      limits: { maxComparedObjects: 3, maxDiagnostics: 2 },
      summary: { comparison_truncated: 1, missing_object: 3 },
    });
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "comparison_truncated",
      "missing_object",
    ]);
  });

  it("caps the member IDs retained inside one group diagnostic", () => {
    const objects = Array.from({ length: 70 }, (_, index) => ({
      ...shape(`member-${String(index).padStart(2, "0")}`, index * 4, index),
      groupId: "large-group",
    }));
    const scene = buildSemanticScene(room(objects));
    const source = matchingSnapshot(scene);
    const report = compareRendererParity(scene, {
      ...source,
      objects: source.objects.map((object) => ({ ...object, groupId: null })),
    });
    const diagnostic = report.diagnostics.find(
      (item) => item.code === "group_membership_mismatch",
    );

    expect(diagnostic?.expected).toMatchObject({
      count: 70,
      omittedObjectCount: 6,
    });
    expect((diagnostic?.expected as { objectIds: string[] }).objectIds).toHaveLength(64);
  });
});

describe("tldraw parity snapshot", () => {
  it("flattens groups, preserves semantic IDs, and captures page-space connector routes", () => {
    const childDraft = {
      id: "child",
      kind: "shape",
      x: 10,
      y: 20,
      width: 100,
      height: 80,
      rotation: 0,
      zIndex: 0,
      groupId: "cluster",
      shape: "rectangle",
      nodeType: null,
      label: "child",
      fill: "yellow",
      stroke: "blue",
    } satisfies CreateCanvasObject;
    const edgeDraft = {
      id: "edge",
      kind: "connector",
      x: 10,
      y: 20,
      width: 100,
      height: 1,
      rotation: 0,
      zIndex: 1,
      groupId: null,
      start: { x: 10, y: 20, objectId: null },
      end: { x: 110, y: 20, objectId: null },
      routing: {
        mode: "straight",
        kind: "straight",
        bend: 0,
        elbowMidPoint: 0.5,
        labelPosition: 0.5,
      },
      direction: "end",
      label: "edge",
      color: "black",
    } satisfies CreateCanvasObject;
    const group = {
      id: "shape:visual-group" as TLShapeId,
      type: "group",
      meta: { jazzboardGroupId: "cluster" },
    } as unknown as TLShape;
    const child = {
      id: "shape:child" as TLShapeId,
      type: "geo",
      meta: { jazzboardId: "child" },
      draft: childDraft,
    } as unknown as TLShape;
    const edge = {
      id: "shape:edge" as TLShapeId,
      type: "arrow",
      meta: { jazzboardId: "edge" },
      draft: edgeDraft,
    } as unknown as TLShape;
    const shapes = new Map([group, child, edge].map((shape) => [shape.id, shape]));
    const editor = {
      getCurrentPageShapesSorted: () => [group, child, edge],
      getSortedChildIdsForParent: (shape: TLShape) => shape.id === group.id ? [child.id] : [],
      getShape: (shapeId: TLShapeId) => shapes.get(shapeId),
      getShapePageBounds: (shapeId: TLShapeId) => shapeId === child.id
        ? { x: 10, y: 20, w: 100, h: 80 }
        : { x: 10, y: 20, w: 100, h: 1 },
      getShapePageTransform: () => ({
        applyToPoint: (point: { x: number; y: number }) => ({ x: point.x + 10, y: point.y + 20 }),
      }),
    } as unknown as Editor;
    tldraw.getArrowInfo.mockReturnValue({
      type: "straight",
      start: { point: { x: 0, y: 0 } },
      end: { point: { x: 100, y: 0 } },
    });

    const snapshot = captureTldrawRendererParitySnapshot(editor);

    expect(snapshot).toEqual({
      rendererId: "tldraw-v3",
      objects: [
        {
          objectId: "child",
          kind: "shape",
          rendererKind: "geo",
          bounds: { x: 10, y: 20, width: 100, height: 80 },
          groupId: "cluster",
          connector: null,
        },
        {
          objectId: "edge",
          kind: "connector",
          rendererKind: "arrow",
          bounds: { x: 10, y: 20, width: 100, height: 1 },
          groupId: null,
          connector: {
            start: edgeDraft.start,
            end: edgeDraft.end,
            routing: edgeDraft.routing,
            routePoints: [{ x: 10, y: 20 }, { x: 110, y: 20 }],
          },
        },
      ],
      bounds: { x: 10, y: 20, width: 100, height: 80 },
    });
    expect(projection.tldrawShapeToSemantic).toHaveBeenCalledTimes(2);
  });
});
