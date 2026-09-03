import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import type { RoomState } from "@/lib/domain/types";

import { CANVAS_PREVIEW_LIMITS } from "./preview-contract";

const INSPECTION_PADDING = 24;

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function recommendedCanvasInspection(
  room: RoomState,
  changedObjectIds: readonly string[],
  changedDiagramIds: readonly string[],
) {
  const diagrams = room.diagrams ?? {};
  const objects = room.objects ?? {};
  const diagram = changedDiagramIds
    .map((diagramId) => diagrams[diagramId])
    .find((candidate) => candidate && candidate.memberObjectIds.length + candidate.connectorIds.length > 0);
  if (diagram) {
    const targetCount = uniqueStrings([...diagram.memberObjectIds, ...diagram.connectorIds]).length;
    return {
      tool: "inspect_canvas_scope" as const,
      input: {
        scope: { kind: "diagram" as const, diagramId: diagram.id, expectedRevision: diagram.revision },
        padding: INSPECTION_PADDING,
        representation: targetCount > CANVAS_PREVIEW_LIMITS.maxWorkingSetRecords
          ? "overview" as const
          : "working_set" as const,
      },
    };
  }
  const targets = uniqueStrings(changedObjectIds)
    .flatMap((objectId) => objects[objectId] ?? [])
    .slice(0, CANVAS_PREVIEW_LIMITS.maxTargets)
    .map((object) => ({ objectId: object.id, expectedRevision: object.revision }));
  return targets.length
    ? {
        tool: "inspect_canvas_scope" as const,
        input: {
          scope: { kind: "objects" as const, targets },
          padding: INSPECTION_PADDING,
          representation: targets.length > CANVAS_PREVIEW_LIMITS.maxWorkingSetRecords
            ? "overview" as const
            : "working_set" as const,
        },
      }
    : null;
}

export function recommendedDraftInspection(draft: AgentCanvasDraftSnapshot) {
  return {
    tool: "inspect_canvas_scope" as const,
    input: {
      scope: {
        kind: "draft" as const,
        draftId: draft.id,
        expectedDraftRevision: draft.revision,
      },
      padding: INSPECTION_PADDING,
      representation: draft.previewObjects.length > CANVAS_PREVIEW_LIMITS.maxWorkingSetRecords
        ? "overview" as const
        : "working_set" as const,
    },
  };
}

export function recommendedRoomCompositionInspection(
  room: RoomState,
  changedObjectIds: readonly string[],
) {
  const roomObjectIds = Object.keys(room.objects ?? {});
  const changed = new Set(changedObjectIds);
  const hasSurroundingContent = roomObjectIds.some((objectId) => !changed.has(objectId));
  if (
    !hasSurroundingContent
    || roomObjectIds.length === 0
    || roomObjectIds.length > CANVAS_PREVIEW_LIMITS.maxTargets
  ) return null;
  return {
    tool: "inspect_canvas_scope" as const,
    input: {
      scope: { kind: "room" as const, expectedRevision: room.roomRevision },
      padding: INSPECTION_PADDING,
      representation: "overview" as const,
    },
  };
}
