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

function namedTool(tools: WebMCP.ModelContextTool[], name: string) {
  const result = tools.find((tool) => tool.name === name);
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}

describe("get_canvas_capabilities WebMCP tool", () => {
  it("registers one compact read-only quickstart and bundle selector", () => {
    for (const role of ["participant", "spectator"] as const) {
      const tools = createJazzboardCanvasCapabilityWebMcpTools(binding(role));
      expect(tools.map(({ name }) => name)).toEqual(
        JAZZBOARD_CANVAS_CAPABILITY_TOOL_NAMES,
      );
      const capabilityTool = namedTool(tools, "get_canvas_capabilities");
      expect(capabilityTool.annotations).toEqual({ readOnlyHint: true });
      expect(capabilityTool.description).toMatch(/start.*one quickstart.*do not preload/i);
      expect(capabilityTool.description).toMatch(/guidance never grants permissions/i);
      expect(capabilityTool.inputSchema).toEqual({
        type: "object",
        properties: {
          bundle: {
            type: "string",
            enum: JAZZBOARD_CANVAS_CAPABILITY_BUNDLES,
            description: "Prefer one quickstart; omission defaults to core.",
          },
        },
        additionalProperties: false,
      });

      expect(jsonBytes(capabilityTool)).toBeLessThan(1_000);
    }
  });

  it("returns a self-contained fast path without taking creative control", async () => {
    for (const role of ["participant", "spectator"] as const) {
      const tool = namedTool(
        createJazzboardCanvasCapabilityWebMcpTools(binding(role)),
        "get_canvas_capabilities",
      );
      const result = await execute(tool, { bundle: "quickstart_architecture" });
      expect(result).toMatchObject({
        ok: true,
        tool: "get_canvas_capabilities",
        data: {
          schemaVersion: 2,
          bundle: "quickstart_architecture",
          role,
          authority: { roleCanMutateCanvas: role === "participant" },
          data: {
            schemaVersion: 1,
            task: "architecture",
            role,
            roleCanMutateCanvas: role === "participant",
            fastPath: expect.arrayContaining([
              expect.stringMatching(/adapt canonicalDraftJson.*one coherent/i),
              expect.stringMatching(/schema rejection.*fix all paths.*preserve Diagram\/membership/i),
              expect.stringMatching(/draftValidation/i),
              expect.stringMatching(/recommendedRouteComparison.*all routes fail.*node spacing\/routes.*retry/i),
              expect.stringMatching(/failCount=0.*task-relevant warnings/i),
              expect.stringMatching(/finish_canvas_draft.*no confirmation/i),
              expect.stringMatching(/inspect_canvas_scope/i),
            ]),
            transactionContract: {
              tool: "apply_canvas_transaction",
              delivery: { mode: "draft" },
              responseDetail: "concise",
              operationLimit: 200,
              metadataPlacement: expect.stringMatching(/root.*intent.*summary.*no expectedRoomRevision/i),
              schemaAuthority: expect.stringMatching(/schema is final.*fix every path.*never retry unchanged/i),
            },
            draftPreflight: {
              field: "draftValidation",
              losslessCorrectionField: "canonicalDraftCorrectionJson",
              routeComparisonField: "recommendedRouteComparison",
              authority: expect.stringMatching(/intent-unaware.*never override/i),
              correction: expect.stringMatching(/canonicalDraftCorrectionJson.*recommendedRouteComparison.*author 2-8.*analyze_diagram_layout.*read-only.*all fail.*node spacing\/routes.*compare again.*choose\/apply.*inspect pixels.*chooses no geometry/i),
            },
            canonicalDraftJson: expect.any(String),
            canonicalDirectCorrection: {
              update: {
                operations: [{
                  op: "update_object",
                  objectId: "authoritative_object_id",
                  expectedRevision: 1,
                  patch: { width: 240 },
                }],
                responseDetail: "concise",
              },
            },
            readabilityHeuristics: expect.arrayContaining([
              expect.stringMatching(/first draft.*draftId.*needs expectedDraftRevision/i),
              expect.stringMatching(/new create_diagram.*no spatial\/semantic identity.*diagramTempRef.*only.*edit_diagram.*never object creates.*keep semantic structure/i),
              expect.stringMatching(/ports are.*side:left.*not strings/i),
              expect.stringMatching(/relationshipAssertions.*endpoint.*direction.*label.*before mutation.*without choosing facts.*relationshipReview.*actual start->end.*task facts.*prose never overrides endpoints/i),
              expect.stringMatching(/node floors.*180x88.*260x132.*12\*longest visible line characters\+48.*deliberate exceptions/i),
              expect.stringMatching(/straight labeled edge.*max\(160.*12\*visible label characters\+48\).*keep necessary meaning/i),
              expect.stringMatching(/one row.*overview microscopic.*multiple rows\/ranks.*never imposed layout or creative authority/i),
              expect.stringMatching(/hubs.*distinct ports.*empty lanes.*layout is not imposed/i),
              expect.stringMatching(/container\/plane.*semanticRole.*inset title.*72-unit clear header/i),
              expect.stringMatching(/draft Diagram.*edit_diagram.*diagramTempRef/i),
              expect.stringMatching(/patch unintended failures.*update_draft_connector.*geometryQualityStatus=fail.*blocks/i),
            ]),
            completion: {
              tool: "finish_canvas_draft",
              action: "commit",
              confirmationRequired: false,
              finalInspection: "inspect_canvas_scope",
              blockingState: expect.stringMatching(/geometryQualityStatus=fail.*not complete/i),
            },
            escalation: {
              capabilityTool: "get_canvas_capabilities",
              useOnlyWhen: expect.stringMatching(/at most.*architecture.*do not preload multiple/i),
            },
          },
        },
      });
      const quickstart = (result as {
        data: { data: { canonicalDraftJson: string } };
      }).data.data;
      expect(quickstart.canonicalDraftJson).not.toContain("[Object]");
      expect(JSON.parse(quickstart.canonicalDraftJson)).toMatchObject({
        operations: expect.arrayContaining([
          expect.objectContaining({
            op: "connect",
            start: {
              tempRef: "source",
              port: { side: "right", position: 0.5, exact: true },
            },
            end: {
              tempRef: "target",
              port: { side: "left", position: 0.5, exact: true },
            },
          }),
        ]),
        relationshipAssertions: [{
          connectorTempRef: "source_to_target",
          fromTempRef: "source",
          toTempRef: "target",
          direction: "end",
          exactLabel: "request",
        }],
        delivery: { mode: "draft" },
        responseDetail: "concise",
      });
      expect(jsonBytes(result)).toBeLessThan(6_000);
    }
  });

  it("rejects invalid quickstart bundle names and fields", async () => {
    const tool = namedTool(
      createJazzboardCanvasCapabilityWebMcpTools(binding("participant")),
      "get_canvas_capabilities",
    );
    for (const input of [{ bundle: "quickstart_drawing" }, { bundle: "quickstart_architecture", extra: true }, null]) {
      await expect(execute(tool, input)).resolves.toMatchObject({
        ok: false,
        tool: "get_canvas_capabilities",
        error: {
          code: "INVALID_TOOL_INPUT",
          message: expect.stringMatching(/listed quickstart or capability bundle/i),
        },
      });
    }
  });

  it("defaults to a compact schema-v2 core with universal authority and mechanics", async () => {
    const tool = namedTool(
      createJazzboardCanvasCapabilityWebMcpTools(binding("participant")),
      "get_canvas_capabilities",
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
            { bundle: "quickstart_architecture", call: { bundle: "quickstart_architecture" } },
            { bundle: "quickstart_illustration", call: { bundle: "quickstart_illustration" } },
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
            connectorWaypointSpace: "absolute-canvas",
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
            maximumConnectorWaypoints: 30,
            maximumProgressiveDraftRequestBytes: 256 * 1024,
            maximumRetainedProgressiveDraftBytes: 192 * 1024,
            recommendedRetainedDraftHeadroomBytes: 16 * 1024,
          },
          visualInspection: {
            preferredTool: "inspect_canvas_scope",
            visualInspectionRequiresPixelCapture: true,
            framingOrGeometryAloneIsVisualInspection: false,
            exactScopes: ["room", "diagram", "objects"],
            roomScopePurpose: expect.stringMatching(/relative scale.*surrounding content/i),
            compositionEvidenceAuthority: expect.stringMatching(/descriptive evidence only/i),
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
    const tool = namedTool(
      createJazzboardCanvasCapabilityWebMcpTools(binding("participant")),
      "get_canvas_capabilities",
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
            connector: {
              authoredWaypoints: {
                field: "routing.waypoints",
                mode: "elbow-only",
                pointSpace: "absolute-canvas",
                generatedAutomatically: false,
              },
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
            explicitRouting: expect.stringMatching(/waypoints/),
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
            expect.stringMatching(/cleanViewport.*inspectionRegion/i),
            expect.stringMatching(/exact room revision.*relative scale.*surrounding-content integration/i),
            expect.stringMatching(/patch only/i),
          ]),
          compositionEvidence: {
            fields: ["framing", "scale", "distribution"],
            wholeRoomRequires: "scope.kind=room-with-exact-room-revision",
            authority: expect.stringMatching(/never-an-automatic-quality-verdict-or-layout-trigger/i),
            caveats: expect.arrayContaining([
              "median-area-ratios-are-selection-sensitive-in-heterogeneous-scenes",
              "nearest-neighbor-center-distance-is-not-edge-clearance",
            ]),
          },
          canonicalExamples: {
            diagramScope: { tool: "inspect_canvas_scope" },
            objectScope: { tool: "inspect_canvas_scope" },
            roomCompositionScope: {
              tool: "inspect_canvas_scope",
              input: {
                scope: { kind: "room", expectedRevision: 12 },
                representation: "overview",
              },
            },
            pixelCapture: expect.stringMatching(
              /JSON result alone.*not visual QA/i,
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
      const tool = namedTool(
        createJazzboardCanvasCapabilityWebMcpTools(binding(role)),
        "get_canvas_capabilities",
      );
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
    const tool = namedTool(
      createJazzboardCanvasCapabilityWebMcpTools(binding("participant")),
      "get_canvas_capabilities",
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
          message: expect.stringMatching(/listed quickstart or capability bundle/i),
        },
      });
    }
  });
});
