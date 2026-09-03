/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import type { CanvasRuntime } from "@/lib/canvas/runtime";
import { buildSemanticScene } from "@/lib/canvas/semantic-scene";
import {
  applyLayoutCommand,
  applySemanticTransaction,
  normalizeRoomSemanticState,
} from "@/lib/domain/engine";
import type {
  CanvasBounds,
  CanvasObject,
  Participant,
  RoomState,
  Viewport,
} from "@/lib/domain/types";

import { renderCanvasPreview } from "./canvas-preview";
import { InRoomCanvasPreviewTransport } from "./in-room-preview-transport";
import { createJazzboardPreviewWebMcpTools } from "./preview-tools";
import { createJazzboardSemanticWebMcpTools } from "./semantic-tools";
import type {
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpContext,
  WebMcpRequest,
} from "./types";

const NOW = 20_000_000;
const DIAGRAM_ID = "playprint-production-architecture";

function participant(): Participant {
  const presence = { cursor: null, viewport: null, lastSeenAt: NOW, activity: null };
  return {
    participantId: "agent-owner",
    displayName: "Architecture agent",
    color: "violet",
    role: "participant",
    joinedAt: NOW,
    lastSeenAt: NOW,
    connected: true,
    agentActive: true,
    human: { ...presence },
    agent: { ...presence },
  };
}

function emptyRoom(): RoomState {
  return normalizeRoomSemanticState({
    id: "room/dense architecture",
    code: "4729",
    title: "PlayPrint production architecture",
    roomRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    participants: { "agent-owner": participant() },
    objects: {},
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  });
}

function webMcpTool(tools: WebMCP.ModelContextTool[], name: string): WebMCP.ModelContextTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing WebMCP tool ${name}`);
  return found;
}

async function execute(
  tools: WebMCP.ModelContextTool[],
  name: string,
  input: Record<string, unknown>,
): Promise<JazzboardToolResult> {
  return await webMcpTool(tools, name).execute(
    input,
    { signal: new AbortController().signal },
  ) as JazzboardToolResult;
}

function successData<T>(result: JazzboardToolResult): T {
  if (!result.ok) {
    throw new Error(`Expected WebMCP success, received ${result.error.code}: ${result.error.message}`);
  }
  return result.data as T;
}

function unionBounds(left: CanvasBounds | null, right: CanvasBounds): CanvasBounds {
  if (!left) return { ...right };
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

function endpointReference(
  tempRef: string,
  side: "left" | "right",
  position: number,
  exact = false,
) {
  return { tempRef, port: { side, position, exact } };
}

/**
 * A realistic architecture graph with fan-out, converging dependencies, and
 * parallel paths. It is intentionally larger than a hand-picked three-node
 * fixture while remaining a DAG so hierarchy layout has one correct answer.
 */
const NODES = [
  ["customers", "Customers & operators", "component"],
  ["web", "Next.js web", "service"],
  ["api", "Next.js APIs", "service"],
  ["identity", "Identity & access", "service"],
  ["domain", "Book & order domain", "component"],
  ["jobs", "Scheduled jobs", "service"],
  ["database", "PostgreSQL · Prisma", "component"],
  ["payments", "Stripe payments", "service"],
  ["pdf", "PDF builder", "service"],
  ["ai", "Google AI", "service"],
  ["storage", "Asset storage", "component"],
  ["print", "Lulu print", "service"],
] as const;

const CONNECTIONS = [
  ["opens", "customers", "web", "opens", 0.5, 0.5],
  ["calls", "web", "api", "HTTPS / JSON", 0.5, 0.5],
  ["sessions", "api", "identity", "sessions", 0.18, 0.5],
  ["commands", "api", "domain", "commands", 0.5, 0.32],
  ["schedules", "api", "jobs", "schedules", 0.82, 0.5],
  ["identity-store", "identity", "database", "identity state", 0.5, 0.18],
  ["pay", "domain", "payments", "pay", 0.38, 0.5],
  ["assemble", "domain", "pdf", "assemble", 0.62, 0.35],
  ["prompt", "domain", "ai", "prompt", 0.82, 0.5],
  ["recover", "jobs", "print", "recover", 0.78, 0.3],
  ["assets", "pdf", "storage", "assets", 0.38, 0.32],
] as const;

describe("dense AI-native diagram WebMCP workflow", () => {
  it("creates, graph-lays out, analyzes, and previews a readable multi-service architecture", async () => {
    let authoritative = emptyRoom();
    let projected = authoritative;
    let mutationTime = NOW + 1;
    const idCounts = new Map<string, number>();
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === "GET") {
        return { ok: true, room: structuredClone(authoritative) };
      }
      const body = JSON.parse(String(init.body)) as
        | {
            action: "transaction";
            transaction: Parameters<typeof applySemanticTransaction>[3];
          }
        | {
            action: "layout";
            layout: Parameters<typeof applyLayoutCommand>[3];
          };
      const result = body.action === "transaction"
        ? applySemanticTransaction(
            authoritative,
            "agent-owner",
            "agent",
            body.transaction,
            mutationTime++,
          )
        : applyLayoutCommand(
            authoritative,
            "agent-owner",
            "agent",
            body.layout,
            mutationTime++,
          );
      authoritative = result.room;
      return { ok: true, outcome: "applied", ...result };
    }) as unknown as WebMcpRequest;

    const renderedObjectIds: string[][] = [];
    const renderPng = vi.fn(async (
      objectIds: readonly string[],
      options: Parameters<CanvasRuntime["renderPng"]>[1],
    ) => {
      const scene = buildSemanticScene(projected);
      const bounds = objectIds.reduce<CanvasBounds | null>((current, objectId) => {
        const next = scene.objectsById[objectId]?.bounds;
        return next ? unionBounds(current, next) : current;
      }, null);
      if (!bounds) throw new Error("No preview bounds");
      renderedObjectIds.push([...objectIds]);
      return {
        blob: new Blob(["dense-diagram-png"], { type: "image/png" }),
        logicalWidth: (bounds.width + options.padding * 2) * options.scale,
        logicalHeight: (bounds.height + options.padding * 2) * options.scale,
        warnings: [],
      };
    });
    const viewport: Viewport = { x: 0, y: 0, width: 1_600, height: 1_000, zoom: 1 };
    const runtime: CanvasRuntime = {
      rendererId: "jazzboard-semantic-v1",
      capabilities: { renderPng: true },
      getViewport: () => viewport,
      pageToViewport: (point) => point,
      viewportToPage: (point) => point,
      getDocumentObjectIds: () => Object.keys(projected.objects),
      getSelectedObjectIds: () => [],
      hasObject: (objectId) => Boolean(projected.objects[objectId]),
      getObjectBounds: (objectId) => buildSemanticScene(projected).objectsById[objectId]?.bounds ?? null,
      getVisibleBounds: (objectIds) => objectIds.reduce<CanvasBounds | null>((current, objectId) => {
        const next = buildSemanticScene(projected).objectsById[objectId]?.bounds;
        return next ? unionBounds(current, next) : current;
      }, null),
      onDocumentChange: () => () => undefined,
      selectObjects: () => undefined,
      zoomToBounds: () => undefined,
      isObjectRenderedExact: (object: CanvasObject) => {
        const current = projected.objects[object.id];
        return Boolean(
          current &&
          current.kind === object.kind &&
          current.revision === object.revision &&
          current.createdAt === object.createdAt,
        );
      },
      isObjectProjectionExact: (object: CanvasObject) => {
        const current = projected.objects[object.id];
        return Boolean(
          current &&
          current.kind === object.kind &&
          current.revision === object.revision &&
          current.createdAt === object.createdAt,
        );
      },
      renderPng,
    };
    const presentCanvasPreview = vi.fn(async (artifact: Awaited<ReturnType<typeof renderCanvasPreview>>) => ({
      previewId: "dense-preview",
      clip: {
        coordinateSpace: "viewport-css-pixels" as const,
        x: 24,
        y: 36,
        width: artifact.metadata.width,
        height: artifact.metadata.height,
      },
      expiresAt: NOW + 60_000,
    }));
    const context: JazzboardWebMcpContext = {
      getRoom: () => projected,
      getSelection: () => [],
      getViewport: () => viewport,
      getFollowTarget: () => null,
      acceptRoom(next) {
        projected = next;
      },
      setFollowTarget: () => undefined,
      setDeclinedSpotlight: () => undefined,
      leaveRoomView: () => undefined,
      renderCanvasPreview: (previewRequest, signal) => renderCanvasPreview(
        { getCanvasRuntime: () => runtime, getRoom: () => projected },
        previewRequest,
        signal,
      ),
      presentCanvasPreview,
    };
    const binding: JazzboardWebMcpBinding = {
      roomId: authoritative.id,
      participantId: "agent-owner",
      role: "participant",
      context,
    };
    const semanticTools = createJazzboardSemanticWebMcpTools(binding, {
      request,
      createId(prefix) {
        const next = (idCounts.get(prefix) ?? 0) + 1;
        idCounts.set(prefix, next);
        return `${prefix}_${next}`;
      },
    });

    const createResult = await execute(semanticTools, "apply_canvas_transaction", {
      intent: "Model the production request, data, generation, and fulfillment paths",
      summary: "Create a first-class PlayPrint architecture diagram with bound semantic connectors",
      operations: [
        ...NODES.map(([tempRef, label, nodeType]) => ({
          op: "create_node",
          tempRef,
          label,
          nodeType,
          width: 260,
          height: 128,
        })),
        ...CONNECTIONS.map(([
          tempRef,
          start,
          end,
          label,
          startPosition,
          endPosition,
        ], index) => ({
          op: "connect",
          tempRef,
          start: index === 0
            ? endpointReference(start, "right", startPosition, true)
            : { tempRef: start },
          end: index === 0
            ? endpointReference(end, "left", endPosition)
            : { tempRef: end },
          label,
          routing: index === 0
            ? { mode: "elbow", elbowMidPoint: 0.42, labelPosition: 0.32 }
            : { mode: "auto" },
        })),
        {
          op: "create_diagram",
          tempRef: "architecture",
          diagramId: DIAGRAM_ID,
          title: "PlayPrint production architecture",
          description:
            "Shows the web request path, identity, domain data, payments, content generation, storage, and print fulfillment services.",
          diagramType: "architecture",
          category: "production-system",
          tags: ["playprint", "production", "request-flow", "fulfillment"],
          members: NODES.map(([tempRef]) => ({ tempRef })),
          connectors: CONNECTIONS.map(([tempRef]) => ({ tempRef })),
        },
      ],
    });

    expect(createResult).toMatchObject({
      ok: true,
      data: {
        outcome: "applied",
        temporaryReferences: expect.objectContaining({ architecture: DIAGRAM_ID }),
      },
    });
    const createData = successData<{
      temporaryReferences: Record<string, string>;
    }>(createResult);
    expect(authoritative.diagrams[DIAGRAM_ID]).toMatchObject({
      title: "PlayPrint production architecture",
      memberObjectIds: expect.any(Array),
      connectorIds: expect.any(Array),
    });
    expect(authoritative.diagrams[DIAGRAM_ID].memberObjectIds).toHaveLength(NODES.length);
    expect(authoritative.diagrams[DIAGRAM_ID].connectorIds).toHaveLength(CONNECTIONS.length);

    const diagramBeforeLayout = authoritative.diagrams[DIAGRAM_ID];
    const layoutResult = await execute(semanticTools, "layout_objects", {
      responseDetail: "detailed",
      layout: "hierarchy",
      direction: "right",
      density: "comfortable",
      primaryGap: 360,
      secondaryGap: 180,
      origin: { x: 120, y: 100 },
      targets: diagramBeforeLayout.memberObjectIds.map((objectId) => ({
        objectId,
        expectedRevision: authoritative.objects[objectId].revision,
      })),
      diagramId: DIAGRAM_ID,
      expectedDiagramRevision: diagramBeforeLayout.revision,
      intent: "Give each rank and relationship enough whitespace for visual inspection",
    });

    expect(layoutResult).toMatchObject({
      ok: true,
      data: {
        outcome: "applied",
        changedDiagramIds: [DIAGRAM_ID],
        positions: expect.any(Array),
      },
    });
    const diagramAfterLayout = authoritative.diagrams[DIAGRAM_ID];
    expect(successData<{ positions: unknown[] }>(layoutResult).positions).toHaveLength(NODES.length);

    const analyzeResult = await execute(semanticTools, "analyze_diagram_layout", {
      diagramId: DIAGRAM_ID,
      expectedDiagramRevision: diagramAfterLayout.revision,
    });
    expect(analyzeResult).toMatchObject({
      ok: true,
      data: {
        report: {
          diagramId: DIAGRAM_ID,
          metrics: {
            memberObjectCount: NODES.length,
            connectorCount: CONNECTIONS.length,
            failCount: 0,
          },
        },
        routes: expect.any(Array),
        visualInspectionStatus: "not_performed",
      },
    });
    const analysis = successData<{
      report: {
        status: "pass" | "warning" | "fail";
        findings: Array<{ code: string }>;
        metrics: Record<string, number | null | Record<string, number>>;
      };
      routes: Array<{
        connectorId: string;
        routing: { mode: string; kind: string; labelPosition: number };
        points: Array<{ x: number; y: number }>;
        labelBounds: CanvasBounds | null;
      }>;
    }>(analyzeResult);
    expect(analysis.report.status).toBe("pass");
    expect(analysis.report.findings).toEqual([]);
    expect(analysis.report.findings.map((finding) => finding.code)).not.toEqual(expect.arrayContaining([
      "MEMBER_OBJECT_OVERLAP",
      "CONNECTOR_OBJECT_INTRUSION",
      "SHAPE_LABEL_LIKELY_TRUNCATED",
    ]));
    expect(analysis.routes).toHaveLength(CONNECTIONS.length);
    expect(analysis.routes.every((route) => route.points.length >= 2)).toBe(true);
    expect(analysis.routes.every((route) => route.labelBounds !== null)).toBe(true);
    expect(analysis.routes[0]).toMatchObject({
      routing: { mode: "elbow", kind: "elbow", labelPosition: 0.32 },
    });

    for (const [index, [tempRef, startRef, endRef]] of CONNECTIONS.entries()) {
      const connectorId = createData.temporaryReferences[tempRef];
      const startId = createData.temporaryReferences[startRef];
      const endId = createData.temporaryReferences[endRef];
      const connector = authoritative.objects[connectorId];
      expect(connector).toMatchObject({
        kind: "connector",
        start: { objectId: startId },
        end: { objectId: endId },
      });
      if (index === 0) {
        expect(connector).toMatchObject({
          start: {
            normalizedAnchor: { x: 1 },
            isPrecise: true,
            isExact: true,
            snap: "edge-point",
          },
          end: {
            normalizedAnchor: { x: 0 },
            isPrecise: true,
            snap: "edge-point",
          },
        });
      }
    }

    const previewTools = createJazzboardPreviewWebMcpTools(binding, {
      request,
      canvasPreviewTransport: new InRoomCanvasPreviewTransport(),
    });
    const previewResult = await execute(previewTools, "render_canvas_preview", {
      scope: {
        kind: "diagram",
        diagramId: DIAGRAM_ID,
        expectedRevision: diagramAfterLayout.revision,
      },
      padding: 48,
      maxWidth: 1_600,
      maxHeight: 1_000,
      pixelRatio: 1,
      maxBytes: 1_000_000,
    });

    expect(previewResult).toMatchObject({
      ok: true,
      data: {
        previewId: "dense-preview",
        screenshotClip: {
          coordinateSpace: "viewport-css-pixels",
          width: expect.any(Number),
          height: expect.any(Number),
        },
        pixelCaptureProtocol: {
          schemaVersion: 5,
          capture: "stable_clean_viewport_while_validation_is_active",
          crop: "screenshotClip_is_the_scoped_inspection_region_within_clean_viewport_pixels",
          copyReady: {
            preferredPath: "cleanViewport",
            cleanViewport: {
              action: "browser_screenshot",
              arguments: { fullPage: false },
              resultReference: "inspectionPixels",
            },
          },
          completionGate: "inspect_clean_viewport_pixels_and_scoped_region_before_claiming_visual_qa",
          onBlankCapture: {
            retryLimit: 1,
            steps: [
              expect.objectContaining({
                action: "call_webmcp_tool",
                tool: "render_canvas_preview",
              }),
              expect.objectContaining({
                action: "browser_screenshot",
              }),
              expect.objectContaining({
                action: "inspect_image_pixels",
              }),
            ],
          },
        },
        canonicalPixelCaptureJson: expect.any(String),
        sourceRevisions: {
          roomRevision: authoritative.roomRevision,
          diagramRevision: diagramAfterLayout.revision,
        },
        visualInspectionStatus: "not_performed",
        geometryQualityStatus: analysis.report.status,
        visualQuality: {
          diagramId: DIAGRAM_ID,
          metrics: { failCount: 0 },
        },
        nextStep: expect.stringMatching(/cleanViewport.*inspectionPixels.*inspectionRegion/i),
      },
    });
    expect(renderPng).toHaveBeenCalledOnce();
    expect(renderedObjectIds[0]).toHaveLength(NODES.length + CONNECTIONS.length);
    expect(new Set(renderedObjectIds[0])).toEqual(new Set([
      ...diagramAfterLayout.memberObjectIds,
      ...diagramAfterLayout.connectorIds,
    ]));
    expect(presentCanvasPreview).toHaveBeenCalledOnce();
  });
});
