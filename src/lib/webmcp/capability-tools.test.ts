/// <reference types="webmcp-types" />

import { describe, expect, it } from "vitest";

import type { JazzboardWebMcpBinding } from "./types";
import {
  createJazzboardCanvasCapabilityWebMcpTools,
  JAZZBOARD_CANVAS_CAPABILITY_TOOL_NAMES,
} from "./capability-tools";

function binding(role: "participant" | "spectator"): JazzboardWebMcpBinding {
  return {
    roomId: "room-capabilities",
    participantId: "participant-capabilities",
    role,
    context: {
      getRoom: () => null,
      getSelection: () => [],
      getViewport: () => null,
      getFollowTarget: () => null,
      acceptRoom: () => undefined,
      setFollowTarget: () => undefined,
      setDeclinedSpotlight: () => undefined,
      leaveRoomView: () => undefined,
    },
  };
}

async function execute(tool: WebMCP.ModelContextTool, input: Record<string, unknown>) {
  return await tool.execute(input, {
    signal: new AbortController().signal,
  });
}

describe("get_canvas_capabilities WebMCP tool", () => {
  it("is one strict read-only tool for participants and spectators", () => {
    for (const role of ["participant", "spectator"] as const) {
      const tools = createJazzboardCanvasCapabilityWebMcpTools(binding(role));
      expect(tools.map(({ name }) => name)).toEqual(JAZZBOARD_CANVAS_CAPABILITY_TOOL_NAMES);
      expect(tools[0]?.annotations).toEqual({ readOnlyHint: true });
      expect(tools[0]?.inputSchema).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
    }
  });

  it("returns the exact geometry, color, paint-order, and authoring conventions", async () => {
    const [tool] = createJazzboardCanvasCapabilityWebMcpTools(binding("participant"));
    await expect(execute(tool!, {})).resolves.toMatchObject({
      ok: true,
      tool: "get_canvas_capabilities",
      data: {
        schemaVersion: 1,
        role: "participant",
        coordinateSystem: {
          space: "canvas",
          xDirection: "right",
          yDirection: "down",
          objectBoundsOrigin: "unrotated-top-left",
          rotation: {
            unit: "radian",
            positiveDirectionOnScreen: "clockwise",
            quarterTurnExample: Math.PI / 2,
            freehandDrawingPivot: "object-local-origin",
            pathAndPolygonPivot: "object-center",
          },
          authoredPointSpaces: {
            createDrawingPathAndPolygonInput: "absolute-canvas",
            persistedAndPatchDrawingPoints: "object-local-canvas-units",
            persistedAndPatchPathAndPolygonPoints: "normalized-object-local-0-to-1",
          },
        },
        paintOrder: {
          higherValue: "front",
          equalValuePaintOrder: "object-id-ascending",
          equalValueFrontmost: "lexicographically-later-object-id",
        },
        colors: {
          acceptedCustomFormats: ["#RGB", "#RRGGBB", "#RRGGBBAA"],
          namedColorBehavior: "solid-for-ink-pastel-for-fill",
          invalidValues: "rejected",
          transparency: {
            transparentShapeOrPathFill: "none",
            alphaHexSupported: true,
            pathOpacityRange: [0, 1],
          },
          namedColors: {
            blue: { solid: "#5266df", semi: "#dfe3f7" },
          },
        },
        primitives: {
          drawing: { transactionCreateOperation: "create_drawing" },
          path: {
            transactionCreateOperation: "create_path",
            segments: ["line", "quadratic", "cubic"],
            maximumSegments: 2_000,
            maximumStrokeWidth: 256,
          },
          polygon: {
            transactionCreateOperation: "create_polygon",
            representation: "closed-path",
            minimumPoints: 3,
            maximumPoints: 2_001,
          },
        },
        transactions: {
          diagramMembership: "omitted-infers-created-objects-explicit-arrays-are-exact",
        },
        canonicalExamples: {
          createNodeLifecycle: {
            tool: "create_node",
            inputExamples: [
              {
                nodeType: "decision",
                nodeMetadata: {
                  kind: "decision",
                  status: "accepted",
                  owner: "Platform team",
                  resolution: "Adopt active-passive failover for the first release.",
                },
              },
              {
                nodeType: "open_question",
                nodeMetadata: {
                  kind: "open_question",
                  status: "open",
                  owner: "Reliability lead",
                  resolution: null,
                },
              },
            ],
            lifecycleContracts: {
              decisionStatuses: ["proposed", "accepted", "rejected", "superseded"],
              openQuestionStatuses: ["open", "answered", "deferred", "closed"],
              unresolved: "proposed-decision-or-open-status-question-requires-null-resolution",
              resolved: "all-other-statuses-require-nonempty-resolution",
              owner: "nonempty-string-or-null",
            },
          },
          createDrawing: {
            tool: "create_drawing",
            input: { points: [{ x: 120, y: 160 }, { x: 180, y: 120 }, { x: 240, y: 180 }] },
          },
          createPath: {
            tool: "create_path",
            input: {
              start: { x: 100, y: 240 },
              segments: [
                { kind: "line", to: { x: 180, y: 240 } },
                { kind: "quadratic", control: { x: 230, y: 160 }, to: { x: 280, y: 240 } },
                {
                  kind: "cubic",
                  control1: { x: 330, y: 320 },
                  control2: { x: 380, y: 160 },
                  to: { x: 440, y: 240 },
                },
              ],
            },
          },
          createPolygon: {
            tool: "create_polygon",
            input: {
              points: [
                { x: 520, y: 180 },
                { x: 660, y: 180 },
                { x: 700, y: 300 },
                { x: 560, y: 330 },
              ],
            },
          },
          drawConnection: {
            tool: "draw_connection",
            input: {
              start: {
                objectId: "node_client",
                port: { side: "right", position: 0.5, exact: true },
              },
              end: {
                objectId: "node_api",
                port: { side: "left", position: 0.5, exact: true },
              },
              routing: { mode: "elbow", elbowMidPoint: 0.5, labelPosition: 0.5 },
            },
            endpointContract: "objectId-with-optional-port-or-absolute-canvas-point",
            routingExamples: [
              { mode: "auto" },
              { mode: "straight", labelPosition: 0.5 },
              { mode: "curved", bend: 48, labelPosition: 0.5 },
              { mode: "elbow", elbowMidPoint: 0.5, labelPosition: 0.5 },
            ],
          },
          applyCanvasTransaction: {
            tool: "apply_canvas_transaction",
            input: {
              operations: expect.arrayContaining([
                expect.objectContaining({ op: "create_node", tempRef: "client" }),
                expect.objectContaining({ op: "connect", tempRef: "request" }),
                expect.objectContaining({ op: "create_diagram", tempRef: "system" }),
              ]),
            },
            expectedSemantics: expect.stringMatching(/omitted.*infers.*tempRef.*atomically/),
          },
          updateObjectPath: {
            tool: "update_object",
            input: {
              objectId: "path_example",
              expectedRevision: 3,
              patch: {
                start: { x: 0, y: 0.5 },
                segments: expect.arrayContaining([
                  expect.objectContaining({ kind: "quadratic", control: { x: 0.65, y: 0 } }),
                ]),
              },
            },
            pointSpace: "normalized-object-local-0-to-1",
          },
        },
        inspection: {
          preferredTool: "inspect_canvas_scope",
          visualInspectionRequiresPixelCapture: true,
          framingOrGeometryAloneIsVisualInspection: false,
          recommendedPixelCapture: "full-viewport-then-crop-screenshotClip",
          freehandGeometryCoverage: "partial",
          vectorPathGeometryCoverage: "partial",
        },
      },
    });
  });

  it("reports the current spectator role without inventing mutation authority", async () => {
    const [tool] = createJazzboardCanvasCapabilityWebMcpTools(binding("spectator"));
    await expect(execute(tool!, {})).resolves.toMatchObject({
      ok: true,
      data: {
        role: "spectator",
        authority: { roleCanMutateCanvas: false },
      },
    });
  });

  it("rejects arguments instead of silently ignoring them", async () => {
    const [tool] = createJazzboardCanvasCapabilityWebMcpTools(binding("participant"));
    await expect(execute(tool!, { unexpected: true })).resolves.toEqual({
      ok: false,
      tool: "get_canvas_capabilities",
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "get_canvas_capabilities accepts no arguments.",
      },
    });
  });
});
