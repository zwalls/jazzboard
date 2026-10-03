import type { RoomState } from "@/lib/domain/types";
import { shareDocumentRecords } from "@/lib/domain/document-sharing";
import { roomStateRevision } from "@/lib/realtime/events";

function mergeParticipantPlanes(
  durableParticipants: RoomState["participants"],
  coordinationParticipants: RoomState["participants"],
): RoomState["participants"] {
  return Object.fromEntries(
    Object.entries(durableParticipants).map(([participantId, durable]) => {
      const coordination = coordinationParticipants[participantId];
      if (!coordination) return [participantId, durable];
      return [participantId, {
        ...durable,
        lastSeenAt: coordination.lastSeenAt,
        connected: coordination.connected,
        agentActive: coordination.agentActive,
        human: coordination.human,
        agent: coordination.agent,
      }];
    }),
  );
}

function mergeRoomPlanes(durable: RoomState, coordination: RoomState): RoomState {
  return {
    ...durable,
    stateRevision: roomStateRevision(coordination),
    participants: mergeParticipantPlanes(durable.participants, coordination.participants),
    leases: coordination.leases,
    spotlight: coordination.spotlight,
  };
}

/**
 * Join independently ordered document and coordination snapshots without
 * regressing either plane. A presence response may outrun an in-flight canvas
 * command, so aggregate stateRevision alone is not sufficient ordering.
 */
export function reconcileRoomSnapshot(
  current: RoomState | null,
  next: RoomState,
  options: Readonly<{ shareDocumentRecords?: boolean }> = {},
): RoomState | null {
  if (!current) return next;
  if (current.id !== next.id) return null;

  const documentOrder = Math.sign(next.roomRevision - current.roomRevision);
  const coordinationOrder = Math.sign(roomStateRevision(next) - roomStateRevision(current));
  if (documentOrder <= 0 && coordinationOrder <= 0) return null;
  const reconciled = documentOrder >= 0 && coordinationOrder >= 0
    ? next
    : documentOrder > 0
      ? mergeRoomPlanes(next, current)
      : mergeRoomPlanes(current, next);
  // A canonical hook ingress already selected its shared records. Preserve
  // that ownership only after the independent plane ordering above succeeds.
  if (options.shareDocumentRecords === false) return reconciled;
  // Ordering and the equal-watermark trust boundary are decided first. An
  // object revision alone is insufficient: normalized membership and local
  // draft geometry can change without changing that revision.
  const objects = shareDocumentRecords(current.objects, reconciled.objects);
  const diagrams = shareDocumentRecords(current.diagrams, reconciled.diagrams);
  return objects === reconciled.objects && diagrams === reconciled.diagrams
    ? reconciled
    : { ...reconciled, objects, diagrams };
}
