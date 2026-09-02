/// <reference types="webmcp-types" />

import { describe, expect, it } from "vitest";

import type { JazzboardWebMcpBinding } from "./types";
import {
  createJazzboardCanvasCapabilityWebMcpTools,
  JAZZBOARD_CANVAS_CAPABILITY_BUNDLES,
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

async function execute(tool: WebMCP.ModelContextTool, input: unknown) {
  return await tool.execute(input as Record<string, unknown>, {
    signal: new AbortController().signal,
  });
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe("get_canvas_capabilities WebMCP tool", () => {
  it("is one compact read-only bundle selector for participants and spectators", () => {
    for (const role of ["participant", "spectator"] as const) {
      const tools = createJazzboardCanvasCapabilityWebMcpTools(binding(role));
      expect(tools.map(({ name }) => name)).toEqual(
        JAZZBOARD_CANVAS_CAPABILITY_TOOL_NAMES,
      );
      expect(tools[0]?.annotations).toEqual({ readOnlyHint: true });
      expect(tools[0]?.description).toMatch(/guidance.*never grant permissions/i);
      expect(tools[0]?.inputSchema).toEqual({
        type: "object",
        properties: {
          bundle: {
            type: "string",
            enum: JAZZBOARD_CANVAS_CAPABILITY_BUNDLES,
            description: "Defaults to core; request one task bundle only when relevant.",
          },
        },
        additionalProperties: false,
      });

      expect(jsonBytes(tools[0])).toBeLessThan(1_000);
    }
  });

  it("defaults to a compact schema-v2 core with universal authority and mechanics", async () => {
    const [tool] = createJazzboardCanvasCapabilityWebMcpTools(
      binding("participant"),
    );
    const result = await execute(tool!, {});

    expect(result).toMatchObject({
      ok: true,
      tool: "get_canvas_capabilities",
      data: {
        schemaVersion: 2,
        bundle: "core",
        role: "participant",
        authority: {
          currentPageToolRegistryIsAuthoritative: true,
          serverAuthorizationAndValidationRemainAuthoritative: true,
          bundlesAreGuidanceNotPermissions: true,
          roleCanMutateCanvas: true,
          exactRevisionsGuardExistingEntityEdits: true,
        },
        data: {
          bundleIndex: [
            { bundle: "authoring", call: { bundle: "authoring" } },
            { bundle: "architecture", call: { bundle: "architecture" } },
            { bundle: "illustration", call: { bundle: "illustration" } },
            { bundle: "inspection", call: { bundle: "inspection" } },
          ],
          universalAgentPrinciples: expect.arrayContaining([
            expect.stringMatching(/user's requested meaning/i),
            expect.stringMatching(/preserve deliberate|deliberate.*geometry/i),
            expect.stringMatching(/pixels/i),
            expect.stringMatching(/retrying blindly/i),
            expect.stringMatching(/progressive draft.*by default/i),
            expect.stringMatching(/full speed/i),
          ]),
          coordinateSystem: {
            space: "canvas",
            unit: "canvas-unit",
            xDirection: "right",
            yDirection: "down",
            objectBoundsOrigin: "unrotated-top-left",
            createPointSpace: "absolute-canvas",
            persistedDrawingPointSpace: "object-local-canvas-units",
            persistedPathAndPolygonPointSpace:
              "normalized-object-local-0-to-1",
            rotation: {
              unit: "radian",
              positiveDirectionOnScreen: "clockwise",
            },
          },
          paintOrder: {
            field: "zIndex",
            higherValue: "front",
            equalValuePaintOrder: "object-id-ascending",
          },
          limits: {
            maximumTransactionOperations: 200,
            maximumDrawingPointsPerStroke: 2_000,
            maximumPathSegments: 2_000,
            maximumPolygonPoints: 2_001,
            maximumProgressiveDraftRequestBytes: 256 * 1024,
            maximumRetainedProgressiveDraftBytes: 192 * 1024,
            recommendedRetainedDraftHeadroomBytes: 16 * 1024,
          },
          visualInspection: {
            preferredTool: "inspect_canvas_scope",
            visualInspectionRequiresPixelCapture: true,
            framingOrGeometryAloneIsVisualInspection: false,
          },
        },
      },
    });

    const authoring = await execute(tool, { bundle: "authoring" });
    expect(authoring).toMatchObject({
      ok: true,
      data: {
        data: {
          transactions: {
            progressiveDraftSizing: expect.stringMatching(/16 KiB.*192 KiB/i),
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("canonicalExamples");
    expect(jsonBytes(result)).toBeLessThan(5_000);
  });

  it("progressively discloses task-scoped guidance and canonical examples", async () => {
    const [tool] = createJazzboardCanvasCapabilityWebMcpTools(
      binding("participant"),
    );

    const authoring = await execute(tool!, { bundle: "authoring" });
    expect(authoring).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 2,
        bundle: "authoring",
        data: {
          colors: {
            acceptedCustomFormats: ["#RGB", "#RRGGBB", "#RRGGBBAA"],
          },
          primitives: {
            path: {
              segments: ["line", "quadratic", "cubic"],
              persistedPointSpace: "normalized-object-local-0-to-1",
            },
          },
          transactions: {
            atomic: true,
            progressiveDrafts: "create-only-cumulative-replacement",
            preferredVisibleCompositionDelivery: "delivery.mode=draft",
            directDeliveryUse:
              "existing-object-corrections-explicitly-instant-work-or-no-live-audience",
            authoringPace: "full-speed-no-animation-driven-chunking-or-pauses",
            presentationPace: "client-local-queued-from-rapid-cumulative-revisions",
            progressiveDraftAuthority: expect.stringMatching(
              /not human review.*finish_canvas_draft.*without requesting user confirmation/i,
            ),
          },
          canonicalExamples: {
            structuredPath: {
              tool: "apply_canvas_transaction",
            },
            normalizedPathUpdate: {
              tool: "update_object",
              patchPointSpace: "normalized-object-local-0-to-1",
            },
          },
        },
      },
    });

    const architecture = await execute(tool!, { bundle: "architecture" });
    expect(architecture).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 2,
        bundle: "architecture",
        data: {
          toolChoices: {
            coherentCreate: "apply_canvas_transaction-with-delivery.mode=draft",
            directCorrection: "apply_canvas_transaction-without-delivery",
            finishProgressiveCreate: "finish_canvas_draft",
            preferredInspection: "inspect_canvas_scope",
          },
          judgment: {
            automaticLayout:
              "opt-in-only-when-flow-grid-or-hierarchy-matches-intent",
            geometryFindings:
              "intent-unaware-evidence-not-redesign-permission",
          },
          canonicalExamples: {
            progressiveSystemDiagram: {
              tool: "apply_canvas_transaction",
              input: { delivery: { mode: "draft" } },
              semantics: expect.stringMatching(/call finish_canvas_draft.*no user confirmation/i),
            },
            optionalHierarchyLayout: {
              useOnlyWhen: expect.stringMatching(/user's requested architecture/i),
            },
          },
        },
      },
    });

    const illustration = await execute(tool!, { bundle: "illustration" });
    expect(illustration).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 2,
        bundle: "illustration",
        data: {
          compositionConvention: {
            container: "custom-Diagram",
            groupId: "namespaced-named-part-or-layer",
            zIndex: "authoritative-layer-order",
          },
          judgment: {
            deliberateGeometry:
              "preserve-overlap-asymmetry-cropping-and-layering",
            deterministicAnalysis: "optional-evidence-for-art",
            creativeControl:
              "agent-chooses-form-style-and-correction-from-user-intent",
          },
          canonicalExamples: {
            layeredPortraitFragment: {
              tool: "apply_canvas_transaction",
              next: expect.stringMatching(/pixel inspection/i),
            },
          },
        },
      },
    });

    const inspection = await execute(tool!, { bundle: "inspection" });
    expect(inspection).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 2,
        bundle: "inspection",
        data: {
          preferredTool: "inspect_canvas_scope",
          correctionLoop: expect.arrayContaining([
            expect.stringMatching(/exact revision/i),
            expect.stringMatching(/crop.*screenshotClip/i),
            expect.stringMatching(/patch only/i),
          ]),
          canonicalExamples: {
            diagramScope: { tool: "inspect_canvas_scope" },
            objectScope: { tool: "inspect_canvas_scope" },
            pixelCapture: expect.stringMatching(
              /JSON result alone is not visual QA/i,
            ),
          },
        },
      },
    });

    for (const result of [authoring, architecture, illustration, inspection]) {
      expect(jsonBytes(result)).toBeLessThan(10_000);
    }
  });

  it("keeps bundle guidance separate from role and server authority", async () => {
    for (const role of ["participant", "spectator"] as const) {
      const [tool] = createJazzboardCanvasCapabilityWebMcpTools(binding(role));
      const result = await execute(tool!, { bundle: "illustration" });
      expect(result).toMatchObject({
        ok: true,
        data: {
          role,
          authority: {
            currentPageToolRegistryIsAuthoritative: true,
            serverAuthorizationAndValidationRemainAuthoritative: true,
            bundlesAreGuidanceNotPermissions: true,
            roleCanMutateCanvas: role === "participant",
          },
        },
      });
    }
  });

  it("rejects unknown fields, invalid bundles, and non-object inputs", async () => {
    const [tool] = createJazzboardCanvasCapabilityWebMcpTools(
      binding("participant"),
    );

    for (const input of [
      { unexpected: true },
      { bundle: "drawing" },
      { bundle: null },
      null,
      [],
    ]) {
      await expect(execute(tool!, input)).resolves.toMatchObject({
        ok: false,
        tool: "get_canvas_capabilities",
        error: {
          code: "INVALID_TOOL_INPUT",
          message: expect.stringMatching(/optional.*bundle/i),
        },
      });
    }
  });
});
