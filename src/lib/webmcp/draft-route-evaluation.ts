import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import {
  cardinalNormalizedAnchor,
  normalizeConnectorRouting,
} from "@/lib/domain/connector-routing";
import { analyzeDiagramVisualQuality } from "@/lib/domain/diagram-visual-quality";
import { diagramVisualQualityFindingKey } from "@/lib/domain/diagram-visual-quality-key";
import type {
  CanvasObject,
  ConnectorEndpoint,
  ConnectorObject,
  ConnectorRoutingInput,
  Point,
  RoomState,
} from "@/lib/domain/types";

export type DraftRouteEndpointReference =
  | Point
  | {
    tempRef: string;
    port?: {
      side: "top" | "right" | "bottom" | "left";
      position?: number;
      exact?: boolean;
    };
  }
  | {
    objectId: string;
    port?: {
      side: "top" | "right" | "bottom" | "left";
      position?: number;
      exact?: boolean;
    };
  };

export type DraftRoutePatch = {
  tempRef: string;
  start?: DraftRouteEndpointReference;
  end?: DraftRouteEndpointReference;
  routing?: ConnectorRoutingInput;
  label?: string;
};

export type DraftRouteCandidate = {
  candidateId: string;
  patches: DraftRoutePatch[];
};

type QualitySummary = {
  geometryQualityStatus: "pass" | "warning" | "fail";
  failCount: number;
  warningCount: number;
  findingCount: number;
  connectorCrossingPairCount: number;
  sharedSegmentPairCount: number;
  endpointReentryCount: number;
  routeAmbiguityClusterCount: number;
  findings: Array<{
    findingKey: string;
    diagramId: string;
    code: string;
    status: "warning" | "fail";
    summary: string;
    objectTempRefs: string[];
    connectorTempRefs: string[];
  }>;
};

function pointFromAnchor(object: CanvasObject, anchor: Point): Point {
  const center = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  const local = {
    x: object.x + object.width * anchor.x,
    y: object.y + object.height * anchor.y,
  };
  const cosine = Math.cos(object.rotation);
  const sine = Math.sin(object.rotation);
  return {
    x: center.x + (local.x - center.x) * cosine - (local.y - center.y) * sine,
    y: center.y + (local.x - center.x) * sine + (local.y - center.y) * cosine,
  };
}

function endpointFor(
  reference: DraftRouteEndpointReference,
  objects: Readonly<Record<string, CanvasObject>>,
  references: Readonly<Record<string, string>>,
): ConnectorEndpoint | null {
  if ("x" in reference) return { ...reference, objectId: null };
  const objectId = "objectId" in reference
    ? reference.objectId
    : references[reference.tempRef];
  const target = objectId ? objects[objectId] : undefined;
  if (!objectId || !target || target.kind === "connector") return null;
  if (!reference.port) {
    return {
      objectId,
      x: target.x + target.width / 2,
      y: target.y + target.height / 2,
      normalizedAnchor: null,
      isPrecise: false,
      isExact: false,
      snap: "center",
    };
  }
  const normalizedAnchor = cardinalNormalizedAnchor(
    reference.port.side,
    reference.port.position ?? 0.5,
  );
  return {
    objectId,
    ...pointFromAnchor(target, normalizedAnchor),
    normalizedAnchor,
    isPrecise: true,
    isExact: reference.port.exact ?? true,
    snap: "edge-point",
  };
}

function qualitySummary(
  room: RoomState,
  draft: AgentCanvasDraftSnapshot,
  reverseReferences: ReadonlyMap<string, string>,
): QualitySummary {
  const reports = draft.previewDiagrams.map((diagram) => analyzeDiagramVisualQuality(room, diagram.id));
  const findings = reports.flatMap((report) => report.findings.map((finding) => ({
    findingKey: diagramVisualQualityFindingKey(finding),
    diagramId: report.diagramId,
    code: finding.code,
    status: finding.status,
    summary: finding.summary,
    objectTempRefs: finding.objectIds.flatMap((id) => {
      const reference = reverseReferences.get(id);
      return reference ? [reference] : [];
    }),
    connectorTempRefs: finding.connectorIds.flatMap((id) => {
      const reference = reverseReferences.get(id);
      return reference ? [reference] : [];
    }),
  })));
  const failCount = reports.reduce((total, report) => total + report.metrics.failCount, 0);
  const warningCount = reports.reduce((total, report) => total + report.metrics.warningCount, 0);
  return {
    geometryQualityStatus: failCount ? "fail" : warningCount ? "warning" : "pass",
    failCount,
    warningCount,
    findingCount: reports.reduce((total, report) => total + report.metrics.findingCount, 0),
    connectorCrossingPairCount: reports.reduce(
      (total, report) => total + report.metrics.crossingPairCount,
      0,
    ),
    sharedSegmentPairCount: reports.reduce(
      (total, report) => total + report.metrics.sharedSegmentPairCount,
      0,
    ),
    endpointReentryCount: reports.reduce(
      (total, report) => total + report.metrics.endpointReentryCount,
      0,
    ),
    routeAmbiguityClusterCount: reports.reduce(
      (total, report) => total + report.metrics.routeAmbiguityClusterCount,
      0,
    ),
    findings: findings.slice(0, 32),
  };
}

function previewRoom(room: RoomState, draft: AgentCanvasDraftSnapshot): RoomState {
  return {
    ...room,
    objects: {
      ...room.objects,
      ...Object.fromEntries(draft.previewObjects.map((object) => [object.id, object])),
    },
    diagrams: {
      ...room.diagrams,
      ...Object.fromEntries(draft.previewDiagrams.map((diagram) => [diagram.id, diagram])),
    },
  };
}

export function evaluateDraftRouteCandidates(input: {
  room: RoomState;
  draft: AgentCanvasDraftSnapshot;
  candidates: readonly DraftRouteCandidate[];
}) {
  const references = input.draft.temporaryReferences;
  const reverseReferences = new Map(
    Object.entries(references).map(([reference, id]) => [id, reference]),
  );
  const baselineRoom = previewRoom(input.room, input.draft);
  const baseline = qualitySummary(baselineRoom, input.draft, reverseReferences);

  const candidates = input.candidates.map((candidate) => {
    const objects = structuredClone(baselineRoom.objects);
    const patchedConnectorTempRefs: string[] = [];
    for (const patch of candidate.patches) {
      const connectorId = references[patch.tempRef];
      const existing = connectorId ? objects[connectorId] : undefined;
      if (!connectorId || !existing || existing.kind !== "connector") {
        return {
          candidateId: candidate.candidateId,
          outcome: "invalid" as const,
          error: `Draft reference ${patch.tempRef} is not a connector in this exact draft.`,
        };
      }
      const start = patch.start ? endpointFor(patch.start, objects, references) : existing.start;
      const end = patch.end ? endpointFor(patch.end, objects, references) : existing.end;
      if (!start || !end) {
        return {
          candidateId: candidate.candidateId,
          outcome: "invalid" as const,
          error: `A route endpoint in ${patch.tempRef} does not resolve to a current draft object.`,
        };
      }
      const connector: ConnectorObject = {
        ...existing,
        start,
        end,
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.max(Math.abs(end.x - start.x), 1),
        height: Math.max(Math.abs(end.y - start.y), 1),
        routing: normalizeConnectorRouting(patch.routing ?? existing.routing),
        label: patch.label ?? existing.label,
      };
      objects[connectorId] = connector;
      patchedConnectorTempRefs.push(patch.tempRef);
    }
    const candidateDraft = {
      ...input.draft,
      previewObjects: input.draft.previewObjects.map((object) => objects[object.id] as typeof object),
    };
    const summary = qualitySummary({ ...baselineRoom, objects }, candidateDraft, reverseReferences);
    return {
      candidateId: candidate.candidateId,
      outcome: "evaluated" as const,
      patchedConnectorTempRefs,
      summary,
      deltaFromBaseline: {
        failCount: summary.failCount - baseline.failCount,
        warningCount: summary.warningCount - baseline.warningCount,
        findingCount: summary.findingCount - baseline.findingCount,
        connectorCrossingPairCount:
          summary.connectorCrossingPairCount - baseline.connectorCrossingPairCount,
        sharedSegmentPairCount:
          summary.sharedSegmentPairCount - baseline.sharedSegmentPairCount,
        endpointReentryCount: summary.endpointReentryCount - baseline.endpointReentryCount,
        routeAmbiguityClusterCount:
          summary.routeAmbiguityClusterCount - baseline.routeAmbiguityClusterCount,
      },
    };
  });

  return {
    draftId: input.draft.id,
    draftRevision: input.draft.revision,
    stateChanged: false as const,
    baseline,
    candidates,
    nextStep:
      "Compare these consequences with the user's intent, choose a route yourself, and apply only your selected patches through apply_canvas_transaction on this same exact draft revision. Jazzboard did not rank, select, apply, or render any candidate.",
  };
}
