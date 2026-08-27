import type {
  CompactRoomEventPayload,
  LegacyRoomEventPayload,
  RoomEvent,
  RoomState,
} from "@/lib/domain/types";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRoomStateEnvelope(value: unknown): value is RoomState {
  const room = record(value);
  return Boolean(
    room &&
      typeof room.id === "string" &&
      typeof room.code === "string" &&
      typeof room.title === "string" &&
      typeof room.roomRevision === "number" &&
      Number.isSafeInteger(room.roomRevision) &&
      typeof room.createdAt === "number" &&
      Number.isFinite(room.createdAt) &&
      typeof room.updatedAt === "number" &&
      Number.isFinite(room.updatedAt) &&
      record(room.participants) &&
      record(room.objects) &&
      record(room.diagrams) &&
      record(room.leases) &&
      (room.spotlight === null || record(room.spotlight)) &&
      (room.agentEditPolicy === "live" || room.agentEditPolicy === "review") &&
      Array.isArray(room.reviewProposals),
  );
}

export function isCompactRoomEventPayload(
  value: unknown,
  sequence?: number,
): value is CompactRoomEventPayload {
  const payload = record(value);
  return Boolean(
    payload &&
      payload.schemaVersion === 2 &&
      payload.kind === "room.invalidated" &&
      typeof payload.roomRevision === "number" &&
      Number.isSafeInteger(payload.roomRevision) &&
      Number(payload.roomRevision) >= 0 &&
      (sequence === undefined || payload.roomRevision === sequence) &&
      (payload.activityId === null ||
        (typeof payload.activityId === "string" && payload.activityId.length <= 160)),
  );
}

export function legacyRoomStateFromEvent(event: RoomEvent): RoomState | null {
  const payload = record(event.payload);
  const candidate = payload?.room;
  if (!isRoomStateEnvelope(candidate)) return null;
  if (
    candidate.id !== event.roomId ||
    candidate.roomRevision !== event.sequence ||
    !Number.isSafeInteger(candidate.roomRevision)
  ) {
    return null;
  }
  return candidate as RoomState;
}

export function isLegacyRoomEventPayload(
  value: unknown,
  roomId?: string,
  sequence?: number,
): value is LegacyRoomEventPayload {
  const payload = record(value);
  const room = payload?.room;
  if (!isRoomStateEnvelope(room)) return false;
  if (roomId !== undefined && room.id !== roomId) return false;
  if (sequence !== undefined && room.roomRevision !== sequence) return false;
  return true;
}

export function compactRoomEvent(event: RoomEvent): RoomEvent {
  const payload = record(event.payload);
  const activity = record(payload?.activity);
  return {
    ...event,
    payload: {
      schemaVersion: 2,
      kind: "room.invalidated",
      roomRevision: event.sequence,
      activityId: typeof activity?.id === "string" ? activity.id : null,
    },
  };
}
