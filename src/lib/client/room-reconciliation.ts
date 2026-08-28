import type { RoomState } from "@/lib/domain/types";
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
): RoomState | null {
  if (!current) return next;
  if (current.id !== next.id) return null;

  const documentOrder = Math.sign(next.roomRevision - current.roomRevision);
  const coordinationOrder = Math.sign(roomStateRevision(next) - roomStateRevision(current));
  if (documentOrder <= 0 && coordinationOrder <= 0) return null;
  if (documentOrder >= 0 && coordinationOrder >= 0) return next;

  return documentOrder > 0
    ? mergeRoomPlanes(next, current)
    : mergeRoomPlanes(current, next);
}
