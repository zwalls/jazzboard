import {
  analyzeDiagramVisualQuality,
  type DiagramVisualQualityFinding,
  type DiagramVisualQualityReport,
} from "@/lib/domain/diagram-visual-quality";
import { diagramVisualQualityFindingKey } from "@/lib/domain/diagram-visual-quality-key";
import type { RoomState } from "@/lib/domain/types";

import type { AgentCanvasDraftSnapshot } from "./types";

export type AgentDraftFailFinding = {
  findingKey: string;
  diagramId: string;
  diagramRevision: number;
  code: DiagramVisualQualityFinding["code"];
  summary: string;
  objectIds: string[];
  connectorIds: string[];
};

export type AgentDraftVisualQualityGate = {
  status: "pass" | "fail";
  reports: DiagramVisualQualityReport[];
  failFindingCount: number;
  returnedFailFindingCount: number;
  omittedFailFindingCount: number;
  failFindings: AgentDraftFailFinding[];
};

export const AGENT_DRAFT_QUALITY_GATE_RETURNED_FINDING_LIMIT = 24;

/** Reconstruct the exact current-room + unpublished-candidate view. */
export function agentDraftPreviewRoom(
  room: RoomState,
  draft: AgentCanvasDraftSnapshot,
): RoomState {
  const objects = { ...room.objects };
  for (const object of draft.previewObjects) objects[object.id] = object;
  const diagrams = { ...room.diagrams };
  for (const diagram of draft.previewDiagrams) diagrams[diagram.id] = diagram;
  return { ...room, objects, diagrams };
}

/**
 * Return exact, bounded fail evidence for commit-time agent deliberation.
 * This never moves objects, selects routes, or interprets user intent.
 */
export function agentDraftVisualQualityGate(
  room: RoomState,
  draft: AgentCanvasDraftSnapshot,
): AgentDraftVisualQualityGate {
  const previewRoom = agentDraftPreviewRoom(room, draft);
  const reports = [...draft.previewDiagrams]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((diagram) => analyzeDiagramVisualQuality(previewRoom, diagram.id));
  const allReturnedFailFindings = reports.flatMap((report) =>
    report.findings
      .filter((finding) => finding.status === "fail")
      .map((finding) => ({
        findingKey: diagramVisualQualityFindingKey(finding),
        diagramId: report.diagramId,
        diagramRevision: report.diagramRevision,
        code: finding.code,
        summary: finding.summary,
        objectIds: finding.objectIds,
        connectorIds: finding.connectorIds,
      })),
  );
  const failFindingCount = reports.reduce((total, report) => total + report.metrics.failCount, 0);
  const failFindings = allReturnedFailFindings.slice(
    0,
    AGENT_DRAFT_QUALITY_GATE_RETURNED_FINDING_LIMIT,
  );
  const omittedFailFindingCount = Math.max(0, failFindingCount - failFindings.length);
  return {
    status: failFindingCount ? "fail" : "pass",
    reports,
    failFindingCount,
    returnedFailFindingCount: failFindings.length,
    omittedFailFindingCount,
    failFindings,
  };
}
