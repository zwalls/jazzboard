/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import type { ActorRef, CanvasObject, Diagram, Participant, RoomState } from "@/lib/domain/types";

import { InRoomCanvasPreviewTransport } from "./in-room-preview-transport";
import { createJazzboardPreviewWebMcpTools } from "./preview-tools";
import type {
  CanvasPreviewArtifact,
  CanvasInspectionArtifact,
  CanvasPreviewRenderRequest,
  CanvasPreviewTransportAdapter,
} from "./canvas-preview";
import type {
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpContext,
  WebMcpRequest,
} from "./types";

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

function object(id: string, revision: number): CanvasObject {
  return {
    id,
    kind: "shape",
    x: revision * 10,
    y: 20,
    width: 200,
    height: 100,
    rotation: 0,
    zIndex: revision,
    revision,
    groupId: null,
    diagramIds: ["diagram-1"],
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

function connectorObject(id: string, index: number, startObjectId: string, endObjectId: string): CanvasObject {
  return {
    id,
    kind: "connector",
    x: index * 240 + 200,
    y: 70,
    width: 40,
    height: 1,
    rotation: 0,
    zIndex: index,
    revision: 1,
    groupId: null,
    diagramIds: ["diagram-1"],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(),
    lastEditedBy: actor(),
    start: { x: index * 240 + 200, y: 70, objectId: startObjectId },
    end: { x: index * 240 + 240, y: 70, objectId: endObjectId },
    direction: "end",
    label: `route ${index}`,
    color: "black",
  };
}

function maximumDiagramRoom(extraMemberCount = 0): RoomState {
  const memberIds = Array.from({ length: 500 + extraMemberCount }, (_, index) => `member-${index}`);
  const connectorIds = Array.from({ length: 500 }, (_, index) => `connector-${index}`);
  const members = memberIds.map((objectId, index) => ({
    ...object(objectId, 1),
    x: index * 240,
    diagramIds: ["diagram-1"],
  }));
  const connectors = connectorIds.map((connectorId, index) =>
    connectorObject(
      connectorId,
      index,
      memberIds[index % memberIds.length],
      memberIds[(index + 1) % memberIds.length],
    ));
  const current = room();
  current.objects = Object.fromEntries([...members, ...connectors].map((item) => [item.id, item]));
  current.diagrams["diagram-1"] = {
    ...diagram(),
    memberObjectIds: memberIds,
    connectorIds,
  };
  return current;
}

function diagram(revision = 4): Diagram {
  return {
    id: "diagram-1",
    title: "System",
    description: "",
    diagramType: "architecture",
    category: null,
    tags: [],
    memberObjectIds: ["object-a"],
    connectorIds: ["connector-a"],
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    revision,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(),
    lastEditedBy: actor(),
  };
}

function room(): RoomState {
  return {
    id: "room/a b",
    code: "1234",
    title: "Preview room",
    roomRevision: 12,
    createdAt: NOW,
    updatedAt: NOW,
    participants: { alice: participant() },
    objects: {
      "object-a": object("object-a", 3),
      "connector-a": { ...object("connector-a", 7), diagramIds: ["diagram-1"] },
    },
    diagrams: { "diagram-1": diagram() },
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function draft(currentRoom = room(), revision = 2): AgentCanvasDraftSnapshot {
  const previewObject = {
    ...object("draft-object", 1),
    x: 260,
    diagramIds: ["draft-diagram"],
    authority: "draft" as const,
  };
  const previewDiagram = {
    ...diagram(1),
    id: "draft-diagram",
    memberObjectIds: [previewObject.id],
    connectorIds: [],
    authority: "draft" as const,
  };
  return {
    schemaVersion: 1,
    id: "draft_architecture",
    roomId: currentRoom.id,
    ownerParticipantId: "alice",
    author: actor(),
    revision,
    baselineRoomRevision: currentRoom.roomRevision,
    status: "active",
    temporaryReferences: { node: previewObject.id, diagram: previewDiagram.id },
    previewObjects: [previewObject],
    previewDiagrams: [previewDiagram],
    metadata: null,
    createdAt: NOW - 100,
    updatedAt: NOW,
    expiresAt: NOW + 60_000,
    hardExpiresAt: NOW + 120_000,
  };
}

function artifact(
  visualQuality: CanvasPreviewArtifact["metadata"]["visualQuality"] = null,
): CanvasPreviewArtifact {
  return {
    blob: new Blob(["png"], { type: "image/png" }),
    metadata: {
      mimeType: "image/png",
      width: 320,
      height: 180,
      logicalWidth: 320,
      logicalHeight: 180,
      byteLength: 3,
      renderedBounds: { x: 10, y: 20, width: 320, height: 180 },
      padding: 32,
      pixelRatio: 1,
      source: {
        kind: "objects",
        targets: [{ objectId: "object-a", expectedRevision: 3 }],
        roomRevision: 12,
        objectRevisions: [{ objectId: "object-a", revision: 3 }],
      },
      warnings: [],
      visualQuality,
    },
  };
}

function inspectionArtifact(): CanvasInspectionArtifact {
  const preview = artifact().metadata;
  const inspectionEvidence = {
    schemaVersion: 2,
    rendererId: "jazzboard-semantic-v1",
    representation: "working_set",
    scope: {
      identity: "scope:v2:fixture",
      kind: "objects",
      diagramId: null,
      draftId: null,
      focusObjectIds: [],
      identityBasis: "created_at_incarnations",
    },
    visualContract: null,
    revisions: {
      roomRevision: 12,
      diagramRevision: null,
      draftRevision: null,
      explicitObjectRevisions: [{ objectId: "object-a", revision: 3 }],
      explicitObjectRevisionCoverage: {
        totalCount: 1,
        returnedCount: 1,
        omittedCount: 0,
        limit: 64,
        truncated: false,
        fullSetDigest: "fnv1a32:fixture",
      },
    },
    coverage: {
      scopeObjectCount: 1,
      visualContributorCount: 1,
      compactRecordCount: 0,
      focusedRecordCount: 0,
      omittedCompactRecordCount: 1,
      allExplicitTargetsRepresented: true,
      resultByteLength: 1,
      resultByteLimit: 88_000,
      findings: "complete",
      geometry: "complete",
      unsupported: [],
      omittedUnsupportedCount: 0,
    },
    overview: {
      bounds: preview.renderedBounds,
      objectCount: 1,
      kinds: { text: 0, shape: 1, connector: 0, image: 0, draw: 0, path: 0 },
      spatialClusters: [],
    },
    composition: {
      basis: "axis_aligned_renderer_bounds",
      interpretation: "descriptive_relative_geometry_not_quality_judgment",
      framing: {
        scopeKind: "objects",
        fullRoomContext: false,
        scopeBounds: preview.renderedBounds,
        framedBounds: preview.renderedBounds,
        padding: preview.padding,
        aspectRatio: 1.7778,
      },
      scale: {
        measurement: "positive_area_non_connector_bounds",
        measuredObjectCount: 1,
        medianBoundsArea: 57_600,
        totalBoundsArea: 57_600,
        scopeBoundsArea: 57_600,
        summedBoundsAreaToScopeAreaRatio: 1,
        largestObjects: [],
        largestObjectCoverage: { returnedCount: 0, omittedCount: 0, limit: 8, truncated: false },
        caveat: "summed_bounds_area_can_exceed_scope_area_when_objects_overlap",
        heterogeneityCaveat:
          "median_area_is_selection_sensitive_for_mixed_decorative_and_structural_parts",
      },
      distribution: {
        objectCenterAverageNormalized: { x: 0.5, y: 0.5 },
        areaWeightedCenterNormalized: { x: 0.5, y: 0.5 },
        quadrantObjectCounts: { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 1 },
        nearestNeighbor: {
          normalization: "scope_diagonal",
          medianNormalizedDistance: null,
          farthestObjects: [],
          farthestObjectCoverage: { returnedCount: 0, omittedCount: 0, limit: 8, truncated: false },
          caveat: "center_distance_is_not_edge_clearance_or_integration_quality",
        },
        caveat: "centers_and_quadrants_do_not_measure_visual_weight_or_user_intent",
      },
    },
    workingSet: [],
    focused: [],
    routes: [],
    relationships: [],
    boundsOverlaps: { totalCount: 0, truncated: false, items: [] },
    textOcclusionRisks: [],
    textFindings: [],
    contrastFindings: [],
    findingKeys: [],
    findingKeysTruncated: false,
    findingComparison: {
      basis: "caller_supplied_unverified",
      suppliedKeyCount: 0,
      sameScopeSuppliedKeyCount: 0,
      ignoredDifferentScopeSuppliedKeyCount: 0,
      currentFindingCoverageComplete: true,
      observedFindingKeysNotSupplied: [],
      callerSuppliedFindingKeysObservedAgain: [],
      callerSuppliedSameScopeKeysNotObserved: [],
      interpretation: "not_observed_does_not_prove_resolved",
    },
  } as NonNullable<CanvasInspectionArtifact["metadata"]["inspectionEvidence"]>;
  return {
    metadata: {
      renderedBounds: preview.renderedBounds,
      padding: preview.padding,
      source: preview.source,
      warnings: preview.warnings,
      visualQuality: preview.visualQuality,
      inspectionEvidence,
    },
  };
}

function fixture(options: {
  role?: "participant" | "spectator";
  withPresenter?: boolean;
  withRenderer?: boolean;
  withInspector?: boolean;
} = {}) {
  let accepted: RoomState | null = null;
  const acceptedDrafts: AgentCanvasDraftSnapshot[] = [];
  const renderCanvasPreview = vi.fn(async () => artifact());
  const inspectCanvasScope = vi.fn(async () => inspectionArtifact());
  const presentCanvasPreview = vi.fn(async () => ({
    previewId: "preview-1",
    clip: { coordinateSpace: "viewport-css-pixels" as const, x: 12, y: 24, width: 320, height: 180 },
    expiresAt: 70_000,
    validation: {
      token: "preview-1",
      activeSelector: '[data-canvas-inspection-token="preview-1"]',
      status: "valid_until_invalidated" as const,
    },
  }));
  const context: JazzboardWebMcpContext = {
    getRoom: () => accepted,
    getSelection: () => [],
    getViewport: () => null,
    getFollowTarget: () => null,
    ...(options.withRenderer === false ? {} : { renderCanvasPreview }),
    ...(options.withInspector === false ? {} : { inspectCanvasScope }),
    ...(options.withPresenter === false ? {} : { presentCanvasPreview }),
    acceptRoom: (next) => {
      accepted = next;
    },
    acceptAgentDraft: (next) => acceptedDrafts.push(next),
    setFollowTarget: () => undefined,
    setDeclinedSpotlight: () => undefined,
    leaveRoomView: () => undefined,
  };
  const binding: JazzboardWebMcpBinding = {
    roomId: "room/a b",
    participantId: "alice",
    role: options.role ?? "participant",
    context,
  };
  return {
    binding,
    renderCanvasPreview,
    inspectCanvasScope,
    presentCanvasPreview,
    accepted: () => accepted,
    acceptedDrafts,
  };
}

function requestMock(authoritative = room()) {
  return vi.fn(async () => ({ ok: true, room: authoritative })) as unknown as WebMcpRequest;
}

async function execute(tool: WebMCP.ModelContextTool, input: Record<string, unknown>) {
  return tool.execute(input, { signal: new AbortController().signal });
}

describe("render_canvas_preview WebMCP tool", () => {
  it("keeps blank-capture recovery on the same exact draft scope", async () => {
    const currentDraft = draft();
    const candidateArtifact = inspectionArtifact();
    candidateArtifact.metadata.source = {
      kind: "draft",
      draftId: currentDraft.id,
      expectedDraftRevision: currentDraft.revision,
      roomRevision: 12,
      objectRevisions: currentDraft.previewObjects.map((item) => ({
        objectId: item.id,
        revision: item.revision,
      })),
    };
    candidateArtifact.metadata.inspectionEvidence = {
      ...candidateArtifact.metadata.inspectionEvidence!,
      scope: {
        ...candidateArtifact.metadata.inspectionEvidence!.scope,
        kind: "draft",
        diagramId: null,
        draftId: currentDraft.id,
      },
      revisions: {
        ...candidateArtifact.metadata.inspectionEvidence!.revisions,
        diagramRevision: null,
        draftRevision: currentDraft.revision,
      },
    };

    const result = await new InRoomCanvasPreviewTransport().emit(
      candidateArtifact,
      async () => ({
        previewId: "preview-draft",
        clip: { coordinateSpace: "viewport-css-pixels", x: 1, y: 2, width: 3, height: 4 },
        expiresAt: 20_000,
      }),
      new AbortController().signal,
      "inspect_canvas_scope",
    ) as JazzboardToolResult<Record<string, unknown>>;

    expect(result).toMatchObject({
      ok: true,
      data: {
        pixelCaptureProtocol: {
          onBlankCapture: {
            steps: [
              expect.objectContaining({
                tool: "inspect_canvas_scope",
                arguments: {
                  scope: {
                    kind: "draft",
                    draftId: currentDraft.id,
                    expectedDraftRevision: currentDraft.revision,
                  },
                },
              }),
              expect.any(Object),
              expect.any(Object),
            ],
          },
        },
      },
    });
  });

  it("reports deterministic Diagram geometry without claiming that pixels were inspected", async () => {
    const transport = new InRoomCanvasPreviewTransport();
    const visualQuality: NonNullable<CanvasPreviewArtifact["metadata"]["visualQuality"]> = {
      schemaVersion: 1,
      diagramId: "diagram-1",
      diagramRevision: 4,
      roomRevision: 12,
      status: "pass",
      summary: "Deterministic geometry checks passed.",
      geometryCoverage: {
        status: "complete",
        analyzedMemberObjectCount: 1,
        unsupportedDrawObjectCount: 0,
        unsupportedDrawObjectIds: [],
        omittedUnsupportedDrawObjectIdCount: 0,
        unsupportedDrawObjectIdsTruncated: false,
        unsupportedPathObjectCount: 0,
        unsupportedPathObjectIds: [],
        omittedUnsupportedPathObjectIdCount: 0,
        unsupportedPathObjectIdsTruncated: false,
      },
      findings: [],
      metrics: {
        memberObjectCount: 1,
        unsupportedDrawMemberCount: 0,
        unsupportedPathMemberCount: 0,
        connectorCount: 0,
        outsideLayoutScaffoldConnectorCount: 0,
        findingCount: 0,
        returnedFindingCount: 0,
        omittedFindingCount: 0,
        findingsTruncated: false,
        failCount: 0,
        warningCount: 0,
        minimumMemberSpacing: null,
        crossingPairCount: 0,
        endpointReentryCount: 0,
        ambiguousSharedRouteGroupCount: 0,
        routeAmbiguityClusterCount: 0,
        sharedSegmentPairCount: 0,
        congestedPortCount: 0,
        truncatedConnectorLabelCount: 0,
        truncatedShapeLabelCount: 0,
        truncatedTextContentCount: 0,
        findingsByCode: {},
      },
    };

    const result = await transport.emit(
      artifact(visualQuality),
      async () => ({
        previewId: "preview-quality",
        clip: { coordinateSpace: "viewport-css-pixels", x: 1, y: 2, width: 3, height: 4 },
        expiresAt: 90_000,
      }),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      data: {
        geometryQualityStatus: "pass",
        geometryCoverageStatus: "complete",
        visualQuality,
        visualInspectionStatus: "not_performed",
      },
    });

    const failedResult = await transport.emit(
      artifact({ ...visualQuality, status: "fail", summary: "A node overlap remains." }),
      async () => ({
        previewId: "preview-quality-fail",
        clip: { coordinateSpace: "viewport-css-pixels", x: 1, y: 2, width: 3, height: 4 },
        expiresAt: 90_000,
      }),
      new AbortController().signal,
    );
    expect(failedResult).toMatchObject({
      data: {
        geometryQualityStatus: "fail",
        geometryCoverageStatus: "complete",
        visualInspectionStatus: "not_performed",
        nextStep: expect.stringMatching(/known deterministic geometry failures remain[^]*do not claim completion[^]*reinspect the newest exact revisions/i),
      },
    });
  });

  it("does not promote partial freehand or vector-path geometry to a quality pass", async () => {
    const transport = new InRoomCanvasPreviewTransport();
    const visualQuality: NonNullable<CanvasPreviewArtifact["metadata"]["visualQuality"]> = {
      schemaVersion: 1,
      diagramId: "diagram-1",
      diagramRevision: 4,
      roomRevision: 12,
      status: "pass",
      summary: "Supported deterministic geometry has no findings; coverage is partial.",
      geometryCoverage: {
        status: "partial",
        analyzedMemberObjectCount: 1,
        unsupportedDrawObjectCount: 1,
        unsupportedDrawObjectIds: ["draw-1"],
        omittedUnsupportedDrawObjectIdCount: 0,
        unsupportedDrawObjectIdsTruncated: false,
        unsupportedPathObjectCount: 0,
        unsupportedPathObjectIds: [],
        omittedUnsupportedPathObjectIdCount: 0,
        unsupportedPathObjectIdsTruncated: false,
      },
      findings: [],
      metrics: {
        memberObjectCount: 2,
        unsupportedDrawMemberCount: 1,
        unsupportedPathMemberCount: 0,
        connectorCount: 0,
        outsideLayoutScaffoldConnectorCount: 0,
        findingCount: 0,
        returnedFindingCount: 0,
        omittedFindingCount: 0,
        findingsTruncated: false,
        failCount: 0,
        warningCount: 0,
        minimumMemberSpacing: null,
        crossingPairCount: 0,
        endpointReentryCount: 0,
        ambiguousSharedRouteGroupCount: 0,
        routeAmbiguityClusterCount: 0,
        sharedSegmentPairCount: 0,
        congestedPortCount: 0,
        truncatedConnectorLabelCount: 0,
        truncatedShapeLabelCount: 0,
        truncatedTextContentCount: 0,
        findingsByCode: {},
      },
    };

    const result = await transport.emit(
      artifact(visualQuality),
      async () => ({
        previewId: "preview-partial-quality",
        clip: { coordinateSpace: "viewport-css-pixels", x: 1, y: 2, width: 3, height: 4 },
        expiresAt: 90_000,
      }),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      data: {
        geometryQualityStatus: "unknown",
        geometryCoverageStatus: "partial",
        visualInspectionStatus: "not_performed",
        nextStep: expect.stringMatching(/freehand strokes require pixel inspection/i),
      },
    });

    const failedResult = await transport.emit(
      artifact({
        ...visualQuality,
        status: "fail",
        summary: "Supported deterministic geometry has a blocking finding; coverage is partial.",
      }),
      async () => ({
        previewId: "preview-partial-failure",
        clip: { coordinateSpace: "viewport-css-pixels", x: 1, y: 2, width: 3, height: 4 },
        expiresAt: 90_000,
      }),
      new AbortController().signal,
    );
    expect(failedResult).toMatchObject({
      data: {
        geometryQualityStatus: "fail",
        geometryCoverageStatus: "partial",
        visualInspectionStatus: "not_performed",
        nextStep: expect.stringMatching(/known failure[^]*fix every finding/i),
      },
    });

    const pathOnlyResult = await transport.emit(
      artifact({
        ...visualQuality,
        geometryCoverage: {
          ...visualQuality.geometryCoverage,
          unsupportedDrawObjectCount: 0,
          unsupportedDrawObjectIds: [],
          unsupportedPathObjectCount: 1,
          unsupportedPathObjectIds: ["path-1"],
        },
        metrics: {
          ...visualQuality.metrics,
          unsupportedDrawMemberCount: 0,
          unsupportedPathMemberCount: 1,
        },
      }),
      async () => ({
        previewId: "preview-partial-path",
        clip: { coordinateSpace: "viewport-css-pixels", x: 1, y: 2, width: 3, height: 4 },
        expiresAt: 90_000,
      }),
      new AbortController().signal,
    );
    expect(pathOnlyResult).toMatchObject({
      data: {
        geometryQualityStatus: "unknown",
        geometryCoverageStatus: "partial",
        nextStep: expect.stringMatching(/vector paths require pixel inspection/i),
      },
    });
  });

  it("registers inspection for both roles and keeps legacy preview participant-only", () => {
    const ready = fixture();
    const transport = new InRoomCanvasPreviewTransport();
    expect(
      createJazzboardPreviewWebMcpTools(ready.binding, { request: requestMock(), canvasPreviewTransport: transport }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["render_canvas_preview", "inspect_canvas_scope"]);
    expect(
      createJazzboardPreviewWebMcpTools(ready.binding, {
        request: requestMock(),
        canvasPreviewTransport: transport,
      })[0].annotations,
    ).toEqual({ untrustedContentHint: true });
    expect(
      createJazzboardPreviewWebMcpTools(
        fixture({ role: "spectator" }).binding,
        { canvasPreviewTransport: transport },
      ).map((tool) => tool.name),
    ).toEqual(["inspect_canvas_scope"]);
    expect(
      createJazzboardPreviewWebMcpTools(
        fixture({ role: "spectator" }).binding,
        { canvasPreviewTransport: transport },
      )[0].annotations,
    ).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    expect(
      createJazzboardPreviewWebMcpTools(
        ready.binding,
        { canvasPreviewTransport: transport },
      ).find((tool) => tool.name === "inspect_canvas_scope")?.annotations,
    ).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    expect(createJazzboardPreviewWebMcpTools(ready.binding, {})).toEqual([]);
    expect(
      createJazzboardPreviewWebMcpTools(fixture({ withPresenter: false }).binding, {
        canvasPreviewTransport: transport,
      }),
    ).toEqual([]);
  });

  it("keeps inspection available when PNG rendering is unavailable", () => {
    const transport = new InRoomCanvasPreviewTransport();
    const participant = fixture({ withRenderer: false });
    const spectator = fixture({ role: "spectator", withRenderer: false });

    expect(
      createJazzboardPreviewWebMcpTools(participant.binding, { canvasPreviewTransport: transport })
        .map((tool) => tool.name),
    ).toEqual(["inspect_canvas_scope"]);
    expect(
      createJazzboardPreviewWebMcpTools(spectator.binding, { canvasPreviewTransport: transport })
        .map((tool) => tool.name),
    ).toEqual(["inspect_canvas_scope"]);
  });

  it("allows a spectator to read exact whole-room composition without gaining legacy rendering", async () => {
    const state = fixture({ role: "spectator", withRenderer: false });
    const [inspect] = createJazzboardPreviewWebMcpTools(state.binding, {
      request: requestMock(room()),
      canvasPreviewTransport: new InRoomCanvasPreviewTransport(),
    });

    const result = await execute(inspect, {
      scope: { kind: "room", expectedRevision: 12 },
      representation: "overview",
    });

    expect(result).toMatchObject({
      ok: true,
      tool: "inspect_canvas_scope",
      data: {
        pixelCaptureProtocol: {
          schemaVersion: 5,
          onBlankCapture: {
            retryLimit: 1,
            steps: [
              expect.objectContaining({
                action: "call_webmcp_tool",
                tool: "render_canvas_preview",
                arguments: {
                  scope: {
                    kind: "objects",
                    targets: [{ objectId: "object-a", expectedRevision: 3 }],
                  },
                },
              }),
              expect.objectContaining({ action: "browser_screenshot" }),
              expect.objectContaining({ action: "inspect_image_pixels" }),
            ],
          },
        },
      },
    });
    expect(state.inspectCanvasScope).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "room", expectedRevision: 12 },
        inspection: expect.objectContaining({ representation: "overview" }),
      }),
      expect.any(AbortSignal),
    );
    expect(state.renderCanvasPreview).not.toHaveBeenCalled();
  });

  it.each(["participant", "spectator"] as const)(
    "authorizes and resolves an exact participant-visible draft for a %s without mutation",
    async (role) => {
      const currentRoom = room();
      const currentDraft = draft(currentRoom);
      const state = fixture({ role, withRenderer: false });
      const request = vi.fn(async (url: string) => {
        if (url.endsWith(`/drafts/${currentDraft.id}`)) {
          return { ok: true, draft: currentDraft, serverTime: NOW };
        }
        return { ok: true, room: currentRoom };
      }) as unknown as WebMcpRequest;
      const [inspect] = createJazzboardPreviewWebMcpTools(state.binding, {
        request,
        canvasPreviewTransport: new InRoomCanvasPreviewTransport(),
      });

      const result = await execute(inspect, {
        scope: {
          kind: "draft",
          draftId: currentDraft.id,
          expectedDraftRevision: currentDraft.revision,
        },
        representation: "working_set",
      });

      expect(result).toMatchObject({ ok: true, tool: "inspect_canvas_scope" });
      expect(request).toHaveBeenNthCalledWith(1, "/api/rooms/room%2Fa%20b", {
        method: "GET",
        signal: expect.any(AbortSignal),
      });
      expect(request).toHaveBeenNthCalledWith(
        2,
        `/api/rooms/room%2Fa%20b/drafts/${currentDraft.id}`,
        { method: "GET", signal: expect.any(AbortSignal) },
      );
      expect(request).not.toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        method: expect.stringMatching(/POST|PUT|PATCH|DELETE/),
      }));
      expect(state.accepted()).toBe(currentRoom);
      expect(state.acceptedDrafts).toEqual([currentDraft]);
      expect(state.inspectCanvasScope).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: currentRoom.id,
          authoritativeRoomRevision: currentRoom.roomRevision,
          source: {
            kind: "draft",
            draftId: currentDraft.id,
            expectedDraftRevision: currentDraft.revision,
          },
          draft: currentDraft,
          diagram: currentDraft.previewDiagrams[0],
          objects: currentDraft.previewObjects,
        }),
        expect.any(AbortSignal),
      );
      expect(state.renderCanvasPreview).not.toHaveBeenCalled();
    },
  );

  it("rejects stale or malformed draft inspection scopes before presentation", async () => {
    const currentRoom = room();
    const currentDraft = draft(currentRoom, 3);
    const state = fixture({ withRenderer: false });
    const request = vi.fn(async (url: string) => url.includes("/drafts/")
      ? { ok: true, draft: currentDraft, serverTime: NOW }
      : { ok: true, room: currentRoom }) as unknown as WebMcpRequest;
    const [inspect] = createJazzboardPreviewWebMcpTools(state.binding, {
      request,
      canvasPreviewTransport: new InRoomCanvasPreviewTransport(),
    });

    await expect(execute(inspect, {
      scope: { kind: "draft", draftId: currentDraft.id, expectedDraftRevision: 2 },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "DRAFT_REVISION_CONFLICT",
        details: { expectedDraftRevision: 2, actualDraftRevision: 3 },
      },
    });
    expect(state.inspectCanvasScope).not.toHaveBeenCalled();

    (request as unknown as ReturnType<typeof vi.fn>).mockClear();
    await expect(execute(inspect, {
      scope: { kind: "draft", draftId: "not-a-draft", expectedDraftRevision: 3 },
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("advertises exact whole-room inspection without adding room scope to legacy rendering", async () => {
    const state = fixture({ withRenderer: false });
    const [inspect] = createJazzboardPreviewWebMcpTools(state.binding, {
      request: requestMock(room()),
      canvasPreviewTransport: new InRoomCanvasPreviewTransport(),
    });
    const inputSchema = inspect.inputSchema as { properties: Record<string, unknown> };

    expect(Object.keys(inputSchema.properties)).toEqual([
      "scope",
      "padding",
      "representation",
      "focusObjectIds",
      "visualContract",
      "previousFindingKeys",
    ]);
    const registeredScope = inputSchema.properties.scope as {
      oneOf: Array<{ properties: Record<string, unknown>; additionalProperties: boolean }>;
    };
    expect(registeredScope.oneOf).toHaveLength(4);
    expect(registeredScope.oneOf[0]).toMatchObject({
      properties: { kind: { const: "room" }, expectedRevision: { minimum: 1 } },
      additionalProperties: false,
    });
    expect(registeredScope.oneOf[1]).toMatchObject({
      properties: {
        kind: { const: "draft" },
        draftId: { pattern: "^draft_[A-Za-z0-9_-]{1,120}$" },
        expectedDraftRevision: { minimum: 1 },
      },
      additionalProperties: false,
    });
    expect(registeredScope.oneOf[2]).toMatchObject({
      properties: { kind: { const: "objects" }, targets: { type: "array", minItems: 1, maxItems: 1_000 } },
      additionalProperties: false,
    });
    expect(registeredScope.oneOf[3]).toMatchObject({
      properties: { kind: { const: "diagram" }, diagramId: { type: "string" }, expectedRevision: { minimum: 1 } },
      additionalProperties: false,
    });
    expect(inputSchema.properties.previousFindingKeys).toMatchObject({
      description: expect.stringMatching(/caller-supplied, unverified.*never proves resolution/i),
    });
    const renderState = fixture();
    const render = createJazzboardPreviewWebMcpTools(renderState.binding, {
      canvasPreviewTransport: new InRoomCanvasPreviewTransport(),
    }).find((tool) => tool.name === "render_canvas_preview")!;
    expect(Object.keys((render.inputSchema as { properties: Record<string, unknown> }).properties))
      .toEqual(["scope", "padding", "maxWidth", "maxHeight", "pixelRatio", "maxBytes"]);
    const renderScope = (render.inputSchema as { properties: { scope: { oneOf: unknown[] } } })
      .properties.scope;
    expect(renderScope.oneOf).toHaveLength(2);

    const roomInspection = await execute(inspect, {
      scope: { kind: "room", expectedRevision: 12 },
      representation: "overview",
    });
    expect(roomInspection).toMatchObject({ ok: true, tool: "inspect_canvas_scope" });
    expect(state.inspectCanvasScope).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "room", expectedRevision: 12 },
        objects: expect.arrayContaining([
          expect.objectContaining({ id: "object-a" }),
          expect.objectContaining({ id: "connector-a" }),
        ]),
        inspection: expect.objectContaining({ representation: "overview" }),
      }),
      expect.any(AbortSignal),
    );
    state.inspectCanvasScope.mockClear();

    const staleRoomInspection = await execute(inspect, {
      scope: { kind: "room", expectedRevision: 11 },
      representation: "overview",
    });
    expect(staleRoomInspection).toMatchObject({
      ok: false,
      error: { code: "ROOM_REVISION_CONFLICT" },
    });
    expect(state.inspectCanvasScope).not.toHaveBeenCalled();

    const result = await execute(inspect, {
      scope: { kind: "objects", targets: [{ objectId: "object-a", expectedRevision: 3 }] },
      maxWidth: 1024,
    });

    expect(result).toMatchObject({
      ok: false,
      tool: "inspect_canvas_scope",
      error: { code: "INVALID_TOOL_INPUT" },
    });
    expect(state.inspectCanvasScope).not.toHaveBeenCalled();

    const oversizedFocus = await execute(inspect, {
      scope: { kind: "objects", targets: [{ objectId: "object-a", expectedRevision: 3 }] },
      focusObjectIds: Array.from({ length: 17 }, (_, index) => `focus-${index}`),
    });
    expect(oversizedFocus).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
  });

  it("resolves exact authoritative object revisions and returns the painted screenshot handoff", async () => {
    const current = room();
    const state = fixture();
    const request = requestMock(current);
    const transport = new InRoomCanvasPreviewTransport();
    const [tool] = createJazzboardPreviewWebMcpTools(state.binding, {
      request,
      canvasPreviewTransport: transport,
    });

    const result = await execute(tool, {
      scope: { kind: "objects", targets: [{ objectId: "object-a", expectedRevision: 3 }] },
      padding: 20,
      maxWidth: 1024,
      maxHeight: 768,
      pixelRatio: 1.5,
      maxBytes: 1_000_000,
    });

    expect(request).toHaveBeenCalledWith("/api/rooms/room%2Fa%20b", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(state.accepted()).toBe(current);
    expect(state.renderCanvasPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room/a b",
        authoritativeRoomRevision: 12,
        source: { kind: "objects", targets: [{ objectId: "object-a", expectedRevision: 3 }] },
        objects: [current.objects["object-a"]],
        options: { padding: 20, maxWidth: 1024, maxHeight: 768, pixelRatio: 1.5, maxBytes: 1_000_000 },
      }),
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({
      ok: true,
      tool: "render_canvas_preview",
      data: {
        previewId: "preview-1",
        screenshotClip: {
          coordinateSpace: "viewport-css-pixels",
          x: 12,
          y: 24,
          width: 320,
          height: 180,
        },
        pixelCaptureProtocol: {
          schemaVersion: 5,
          capture: "stable_clean_viewport_while_validation_is_active",
          crop: "screenshotClip_is_the_scoped_inspection_region_within_clean_viewport_pixels",
          copyReady: {
            preferredPath: "cleanViewport",
            cleanViewport: {
              precondition: "validation_active_and_clean_canvas_presentation",
              action: "browser_screenshot",
              arguments: { fullPage: false },
              resultReference: "inspectionPixels",
              inspectionRegion: {
                coordinateSpace: "viewport-css-pixels",
                x: 12,
                y: 24,
                width: 320,
                height: 180,
              },
            },
            compatibilityPath: "directClip",
            directClip: {
              precondition: "browser_screenshot_clip_is_documented_as_non_mutating",
              action: "browser_screenshot",
              arguments: { clip: { x: 12, y: 24, width: 320, height: 180 } },
              resultReference: "inspectionPixels",
            },
            fallbackPath: "fullViewportCrop",
            browserCapture: {
              action: "browser_screenshot",
              arguments: { fullPage: false },
              resultReference: "fullViewportPixels",
            },
            crop: {
              action: "crop_image_in_memory",
              sourceReference: "fullViewportPixels",
              rectangle: {
                coordinateSpace: "viewport-css-pixels",
                x: 12,
                y: 24,
                width: 320,
                height: 180,
              },
              resultReference: "inspectionPixels",
            },
            inspect: {
              action: "inspect_image_pixels",
              sourceReference: "inspectionPixels",
            },
          },
          completionGate: "inspect_clean_viewport_pixels_and_scoped_region_before_claiming_visual_qa",
          onBlankCapture: {
            classification: "invalid_or_stale_capture_not_successful_inspection",
            retryLimit: 1,
            steps: [
              {
                step: "reframe_exact_scope",
                action: "call_webmcp_tool",
                tool: "render_canvas_preview",
                arguments: {
                  scope: {
                    kind: "objects",
                    targets: [{ objectId: "object-a", expectedRevision: 3 }],
                  },
                },
                resultReference: "reframedInspection",
              },
              expect.objectContaining({
                step: "capture_new_clean_viewport_immediately",
                argumentsPath: "reframedInspection.data.pixelCaptureProtocol.copyReady.cleanViewport.arguments",
              }),
              expect.objectContaining({ step: "inspect_recovered_pixels" }),
            ],
          },
        },
        canonicalPixelCaptureJson: expect.any(String),
        sourceRevisions: { roomRevision: 12, objects: [{ objectId: "object-a", revision: 3 }] },
        visualInspectionStatus: "not_performed",
        geometryQualityStatus: "unknown",
        nextStep: expect.stringMatching(/Framing is not visual QA.*cleanViewport.*inspectionRegion/i),
      },
    });
    expect((result as { data: Record<string, unknown> }).data).not.toHaveProperty("previewUrl");
    const canonicalPixelCapture = JSON.parse(
      (result as { data: { canonicalPixelCaptureJson: string } }).data.canonicalPixelCaptureJson,
    );
    expect(canonicalPixelCapture).toMatchObject({
      schemaVersion: 1,
      executeBeforeExpiresAt: 70_000,
      validationSelector: '[data-canvas-inspection-token="preview-1"]',
      capture: {
        action: "browser_screenshot",
        arguments: { fullPage: false },
        resultReference: "inspectionPixels",
        inspectionRegion: { x: 12, y: 24, width: 320, height: 180 },
      },
      inspect: { action: "inspect_image_pixels", sourceReference: "inspectionPixels" },
      onBlankCapture: { retryLimit: 1 },
    });
    expect(new TextEncoder().encode(JSON.stringify(canonicalPixelCapture)).byteLength).toBeLessThan(4_096);
  });

  it("returns metadata-only unified inspection evidence without describing a discarded PNG", async () => {
    const state = fixture();
    const tools = createJazzboardPreviewWebMcpTools(state.binding, {
      request: requestMock(room()),
      canvasPreviewTransport: new InRoomCanvasPreviewTransport(),
    });
    const inspect = tools.find((candidate) => candidate.name === "inspect_canvas_scope")!;

    const result = await execute(inspect, {
      scope: { kind: "objects", targets: [{ objectId: "object-a", expectedRevision: 3 }] },
      representation: "focus",
      focusObjectIds: ["object-a"],
      visualContract: {
        intent: "Keep the portrait expression recognizable.",
        criteria: ["Eyes and mouth remain legible"],
        preserveObjectIds: ["object-a"],
      },
      previousFindingKeys: ["text:text_likely_clipped:deadbeef"],
    }) as JazzboardToolResult<Record<string, unknown>>;

    expect(inspect.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    expect(state.inspectCanvasScope).toHaveBeenCalledOnce();
    expect(state.renderCanvasPreview).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      tool: "inspect_canvas_scope",
      data: {
        presentation: "live_canvas",
        visualInspectionStatus: "not_performed",
        sceneContext: {
          schemaVersion: 2,
          pixels: {
            delivery: "host_capture_required",
            nativeImageResultSupported: false,
            clip: { coordinateSpace: "viewport-css-pixels", x: 12, y: 24, width: 320, height: 180 },
            validationSelector: '[data-canvas-inspection-token="preview-1"]',
            expiresAt: 70_000,
            action: {
              required: true,
              protocolPath: "data.pixelCaptureProtocol",
              completionGate: "inspect_clean_viewport_pixels_and_scoped_region_before_claiming_visual_qa",
            },
            visualInspectionStatus: "not_performed",
          },
        },
      },
    });
    expect(state.inspectCanvasScope).toHaveBeenCalledWith(
      expect.objectContaining({
        inspection: {
          representation: "focus",
          focusObjectIds: ["object-a"],
          visualContract: {
            intent: "Keep the portrait expression recognizable.",
            criteria: ["Eyes and mouth remain legible"],
            preserveObjectIds: ["object-a"],
          },
          previousFindingKeys: ["text:text_likely_clipped:deadbeef"],
        },
      }),
      expect.any(AbortSignal),
    );
    if (!result.ok) throw new Error("inspection unexpectedly failed");
    const serializedResultByteLength = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    expect(result.data).toMatchObject({
      canonicalPixelCaptureJson: expect.any(String),
      pixelCaptureProtocol: {
        schemaVersion: 5,
        copyReady: {
          preferredPath: "cleanViewport",
          cleanViewport: {
            action: "browser_screenshot",
            arguments: { fullPage: false },
            resultReference: "inspectionPixels",
            inspectionRegion: { coordinateSpace: "viewport-css-pixels", x: 12, y: 24, width: 320, height: 180 },
          },
          compatibilityPath: "directClip",
          directClip: {
            action: "browser_screenshot",
            arguments: { clip: { x: 12, y: 24, width: 320, height: 180 } },
            resultReference: "inspectionPixels",
          },
          fallbackPath: "fullViewportCrop",
          browserCapture: { action: "browser_screenshot", arguments: { fullPage: false } },
          crop: {
            action: "crop_image_in_memory",
            rectangle: { coordinateSpace: "viewport-css-pixels", x: 12, y: 24, width: 320, height: 180 },
          },
          inspect: { action: "inspect_image_pixels", sourceReference: "inspectionPixels" },
        },
        completionGate: "inspect_clean_viewport_pixels_and_scoped_region_before_claiming_visual_qa",
        forbiddenSubstitutions: expect.arrayContaining(["ordinary_unclean_or_invalidated_full_viewport"]),
        onBlankCapture: {
          retryLimit: 1,
          steps: [
            expect.objectContaining({
              tool: "render_canvas_preview",
              arguments: {
                scope: {
                  kind: "objects",
                  targets: [{ objectId: "object-a", expectedRevision: 3 }],
                },
              },
            }),
            expect.objectContaining({ action: "browser_screenshot" }),
            expect.objectContaining({ action: "inspect_image_pixels" }),
          ],
        },
      },
      resultSerialization: {
        byteLength: serializedResultByteLength,
        byteLimit: 96_000,
      },
    });
    expect(serializedResultByteLength).toBeLessThanOrEqual(96_000);
    const canonicalPixelCapture = JSON.parse(result.data.canonicalPixelCaptureJson as string);
    expect(canonicalPixelCapture.capture).toEqual(
      (result.data.pixelCaptureProtocol as {
        copyReady: { cleanViewport: unknown };
      }).copyReady.cleanViewport,
    );
    expect(canonicalPixelCapture.onBlankCapture).toEqual(
      (result.data.pixelCaptureProtocol as { onBlankCapture: unknown }).onBlankCapture,
    );
    expect(new TextEncoder().encode(result.data.canonicalPixelCaptureJson as string).byteLength).toBeLessThan(4_096);
    expect(result.data).not.toHaveProperty("width");
    expect(result.data).not.toHaveProperty("height");
    expect(result.data).not.toHaveProperty("byteLength");
    expect(result.data).not.toHaveProperty("mimeType");
    expect(result.data).not.toHaveProperty("inspectionEvidence");
    expect(result.data).not.toHaveProperty("sourceRevisions");
    expect(result.data).not.toHaveProperty("targets");
    expect(result.data).not.toHaveProperty("visualQuality");
    expect(result.data).not.toHaveProperty("warnings");
    expect(result.data).not.toHaveProperty("pageBounds");
  });

  it("expands an exact Diagram revision to only its declared members and connectors", async () => {
    const current = room();
    const state = fixture();
    const [tool] = createJazzboardPreviewWebMcpTools(state.binding, {
      request: requestMock(current),
      canvasPreviewTransport: new InRoomCanvasPreviewTransport(),
    });

    await execute(tool, { scope: { kind: "diagram", diagramId: "diagram-1", expectedRevision: 4 } });

    expect(state.renderCanvasPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "diagram", diagramId: "diagram-1", expectedRevision: 4 },
        diagram: current.diagrams["diagram-1"],
        objects: [current.objects["object-a"], current.objects["connector-a"]],
      }),
      expect.any(AbortSignal),
    );
  });

  it("previews the schema-maximum 500-member and 500-connector Diagram without truncation", async () => {
    const current = maximumDiagramRoom();
    const state = fixture();
    const [tool] = createJazzboardPreviewWebMcpTools(state.binding, {
      request: requestMock(current),
      canvasPreviewTransport: new InRoomCanvasPreviewTransport(),
    });

    const result = await execute(tool, {
      scope: { kind: "diagram", diagramId: "diagram-1", expectedRevision: 4 },
    });

    expect(result).toMatchObject({ ok: true });
    const renderCalls = state.renderCanvasPreview.mock.calls as unknown as CanvasPreviewRenderRequest[][];
    const renderRequest = renderCalls[0]?.[0];
    expect(renderRequest?.objects).toHaveLength(1_000);
    expect(renderRequest?.objects.slice(0, 500).every((item) => item.kind === "shape")).toBe(true);
    expect(renderRequest?.objects.slice(500).every((item) => item.kind === "connector")).toBe(true);
  });

  it("rejects a defensive 1,001-target Diagram before invoking the renderer", async () => {
    const current = maximumDiagramRoom(1);
    const state = fixture();
    const [tool] = createJazzboardPreviewWebMcpTools(state.binding, {
      request: requestMock(current),
      canvasPreviewTransport: new InRoomCanvasPreviewTransport(),
    });

    const result = await execute(tool, {
      scope: { kind: "diagram", diagramId: "diagram-1", expectedRevision: 4 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PREVIEW_SCOPE_TOO_LARGE",
        details: { targetCount: 1_001, maxTargets: 1_000 },
      },
    });
    expect(state.renderCanvasPreview).not.toHaveBeenCalled();
  });

  it("fails truthfully before rendering when an object revision is stale", async () => {
    const state = fixture();
    const transport: CanvasPreviewTransportAdapter = { emit: vi.fn() };
    const [tool] = createJazzboardPreviewWebMcpTools(state.binding, {
      request: requestMock(),
      canvasPreviewTransport: transport,
    });

    const result = (await execute(tool, {
      scope: { kind: "objects", targets: [{ objectId: "object-a", expectedRevision: 2 }] },
    })) as JazzboardToolResult;

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "OBJECT_REVISION_CONFLICT",
        details: { objectId: "object-a", expectedRevision: 2, actualRevision: 3 },
      },
    });
    expect(state.renderCanvasPreview).not.toHaveBeenCalled();
    expect(transport.emit).not.toHaveBeenCalled();
  });

  it("rejects implicit room, viewport, selection, and last-created scopes", async () => {
    const state = fixture();
    const [tool] = createJazzboardPreviewWebMcpTools(state.binding, {
      request: requestMock(),
      canvasPreviewTransport: new InRoomCanvasPreviewTransport(),
    });

    for (const input of [{}, { scope: { kind: "room" } }, { lastCreated: true }, { scope: { kind: "objects", targets: [] } }]) {
      const result = (await execute(tool, input)) as JazzboardToolResult;
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    }
    expect(state.renderCanvasPreview).not.toHaveBeenCalled();
  });
});
