import type { CanvasObject, RoomState } from "@/lib/domain/types";

const OVERVIEW_LIMIT = 20;

/** A bounded orientation packet; full geometry stays in the authorized client. */
export function roomOverview(
  room: RoomState,
  objects: readonly CanvasObject[],
  selection: readonly string[],
  requestedObjectIds?: readonly string[],
) {
  const scopedIds = requestedObjectIds ? new Set(objects.map((object) => object.id)) : null;
  const diagrams = Object.values(room.diagrams ?? {})
    .filter((diagram) => !scopedIds || [...diagram.memberObjectIds, ...diagram.connectorIds].some((id) => scopedIds.has(id)))
    .sort((left, right) => left.id.localeCompare(right.id));
  const objectKinds: Record<CanvasObject["kind"], number> = {
    text: 0, shape: 0, connector: 0, image: 0, draw: 0, path: 0,
  };
  for (const object of objects) objectKinds[object.kind] += 1;
  const selectedIds = [...new Set(selection)].filter((id) => Boolean(room.objects[id]));
  const missingIds = [...new Set(requestedObjectIds ?? [])].filter((id) => !room.objects[id]);
  const participants = Object.values(room.participants);
  return {
    detail: "summary" as const,
    scope: requestedObjectIds ? "objects" as const : "room" as const,
    objectCount: objects.length,
    objectKinds,
    unassignedObjectCount: objects.filter((object) => object.diagramIds.length === 0).length,
    missingObjectIds: missingIds.slice(0, OVERVIEW_LIMIT),
    missingObjectCount: missingIds.length,
    missingObjectIdsTruncated: missingIds.length > OVERVIEW_LIMIT,
    diagramCount: diagrams.length,
    diagrams: diagrams.slice(0, OVERVIEW_LIMIT).map((diagram) => ({
      id: diagram.id,
      revision: diagram.revision,
      title: diagram.title.slice(0, 160),
      titleTruncated: diagram.title.length > 160,
      diagramType: diagram.diagramType,
      bounds: diagram.bounds,
      memberObjectCount: diagram.memberObjectIds.length,
      connectorCount: diagram.connectorIds.length,
    })),
    diagramsTruncated: diagrams.length > OVERVIEW_LIMIT,
    selection: {
      objectIds: selectedIds.slice(0, OVERVIEW_LIMIT),
      count: selectedIds.length,
      truncated: selectedIds.length > OVERVIEW_LIMIT,
    },
    collaboration: {
      participantCount: participants.length,
      connectedParticipantCount: participants.filter((participant) => participant.connected).length,
      activeAgentCount: participants.filter((participant) => participant.agentActive).length,
      leasedObjectCount: Object.values(room.leases).length,
    },
    nextReads: {
      objects: { tool: "query_objects", input: { limit: 50, expectedRoomRevision: room.roomRevision } },
      diagrams: { tool: "find_diagrams", input: { limit: 30, expectedRoomRevision: room.roomRevision } },
      ownedDrafts: { tool: "read_canvas_drafts", input: { detail: "summary", owner: "self" } },
    },
  };
}
