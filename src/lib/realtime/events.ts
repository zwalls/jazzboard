import type {
  CompactRoomEventPayload,
  CompactRoomEventPayloadV2,
  LegacyRoomEventPayload,
  PresenceDeltaRoomEventPayload,
  RoomEvent,
  RoomPresenceDelta,
  RoomState,
} from "@/lib/domain/types";

type LegacyRoomState = Omit<RoomState, "stateRevision"> & {
  stateRevision?: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Rolling compatibility: pre-v3 room snapshots use roomRevision as their state watermark. */
export function roomStateRevision(room: Pick<RoomState, "roomRevision"> & { stateRevision?: number }): number {
  return validRevision(room.stateRevision) ? room.stateRevision : room.roomRevision;
}

function isRoomStateEnvelope(value: unknown): value is LegacyRoomState {
  const room = record(value);
  if (!room || !validRevision(room.roomRevision)) return false;
  if (
    room.stateRevision !== undefined &&
    (!validRevision(room.stateRevision) || room.stateRevision < room.roomRevision)
  ) {
    return false;
  }
  return Boolean(
    typeof room.id === "string" &&
      typeof room.code === "string" &&
      typeof room.title === "string" &&
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

function normalizedRoomState(room: LegacyRoomState): RoomState {
  if (validRevision(room.stateRevision)) return room as RoomState;
  return { ...room, stateRevision: room.roomRevision };
}

export function isCompactRoomEventPayloadV2(
  value: unknown,
  sequence?: number,
): value is CompactRoomEventPayloadV2 {
  const payload = record(value);
  return Boolean(
    payload &&
      payload.schemaVersion === 2 &&
      payload.kind === "room.invalidated" &&
      validRevision(payload.roomRevision) &&
      (sequence === undefined || payload.roomRevision === sequence) &&
      (payload.activityId === null ||
        (typeof payload.activityId === "string" && payload.activityId.length <= 160)),
  );
}

export function isCompactRoomEventPayloadV3(
  value: unknown,
  sequence?: number,
): value is CompactRoomEventPayload {
  const payload = record(value);
  return Boolean(
    payload &&
      payload.schemaVersion === 3 &&
      payload.kind === "room.invalidated" &&
      validRevision(payload.stateRevision) &&
      validRevision(payload.roomRevision) &&
      payload.roomRevision <= payload.stateRevision &&
      (sequence === undefined || payload.stateRevision === sequence) &&
      (payload.activityId === null ||
        (typeof payload.activityId === "string" && payload.activityId.length <= 160)),
  );
}

export function isCompactRoomEventPayload(
  value: unknown,
  sequence?: number,
): value is CompactRoomEventPayload | CompactRoomEventPayloadV2 {
  return (
    isCompactRoomEventPayloadV3(value, sequence) ||
    isCompactRoomEventPayloadV2(value, sequence)
  );
}

function isActorKind(value: unknown): value is RoomPresenceDelta["actorKind"] {
  return value === "human" || value === "agent";
}

function isPoint(value: unknown): boolean {
  const point = record(value);
  return Boolean(
    point &&
      typeof point.x === "number" &&
      Number.isFinite(point.x) &&
      typeof point.y === "number" &&
      Number.isFinite(point.y),
  );
}

function isViewport(value: unknown): boolean {
  const viewport = record(value);
  return Boolean(
    viewport &&
      isPoint(viewport) &&
      typeof viewport.zoom === "number" &&
      Number.isFinite(viewport.zoom) &&
      viewport.zoom > 0 &&
      typeof viewport.width === "number" &&
      Number.isFinite(viewport.width) &&
      viewport.width > 0 &&
      typeof viewport.height === "number" &&
      Number.isFinite(viewport.height) &&
      viewport.height > 0,
  );
}

function isAgentActivity(value: unknown): boolean {
  if (value === null) return true;
  const activity = record(value);
  return Boolean(
    activity &&
      typeof activity.id === "string" &&
      activity.id.length > 0 &&
      activity.id.length <= 128 &&
      ["reading", "creating", "typing", "drawing", "connecting", "moving", "annotating"].includes(
        String(activity.type),
      ) &&
      typeof activity.label === "string" &&
      activity.label.length > 0 &&
      activity.label.length <= 160 &&
      Array.isArray(activity.objectIds) &&
      activity.objectIds.length <= 200 &&
      activity.objectIds.every(
        (objectId) => typeof objectId === "string" && objectId.length > 0 && objectId.length <= 128,
      ) &&
      typeof activity.progress === "number" &&
      Number.isFinite(activity.progress) &&
      activity.progress >= 0 &&
      activity.progress <= 1 &&
      typeof activity.startedAt === "number" &&
      Number.isSafeInteger(activity.startedAt) &&
      activity.startedAt >= 0 &&
      (activity.durationMs === undefined ||
        (typeof activity.durationMs === "number" &&
          Number.isSafeInteger(activity.durationMs) &&
          activity.durationMs >= 100 &&
          activity.durationMs <= 10_000)) &&
      (activity.fromCursor === undefined ||
        activity.fromCursor === null ||
        isPoint(activity.fromCursor)) &&
      (activity.toCursor === undefined ||
        activity.toCursor === null ||
        isPoint(activity.toCursor)),
  );
}

export function isPresenceDeltaRoomEventPayload(
  value: unknown,
  roomId?: string,
  sequence?: number,
): value is PresenceDeltaRoomEventPayload {
  const payload = record(value);
  const presence = record(payload?.presence);
  return Boolean(
    payload &&
      payload.schemaVersion === 4 &&
      payload.kind === "presence.delta" &&
      validRevision(payload.stateRevision) &&
      validRevision(payload.roomRevision) &&
      payload.roomRevision <= payload.stateRevision &&
      (sequence === undefined || payload.stateRevision === sequence) &&
      typeof payload.participantId === "string" &&
      payload.participantId.length > 0 &&
      payload.participantId.length <= 160 &&
      isActorKind(payload.actorKind) &&
      typeof payload.lastSeenAt === "number" &&
      Number.isFinite(payload.lastSeenAt) &&
      typeof payload.connected === "boolean" &&
      typeof payload.agentActive === "boolean" &&
      presence &&
      (presence.cursor === null || isPoint(presence.cursor)) &&
      (presence.viewport === null || isViewport(presence.viewport)) &&
      presence.lastSeenAt === payload.lastSeenAt &&
      isAgentActivity(presence.activity) &&
      (roomId === undefined || roomId.length > 0),
  );
}

export function presenceDeltaFromEvent(event: RoomEvent): RoomPresenceDelta | null {
  if (!isPresenceDeltaRoomEventPayload(event.payload, event.roomId, event.sequence)) return null;
  return {
    roomId: event.roomId,
    stateRevision: event.payload.stateRevision,
    roomRevision: event.payload.roomRevision,
    participantId: event.payload.participantId,
    actorKind: event.payload.actorKind,
    lastSeenAt: event.payload.lastSeenAt,
    connected: event.payload.connected,
    agentActive: event.payload.agentActive,
    presence: event.payload.presence,
  };
}

/**
 * Applies one awareness update with structural sharing. A document mismatch is
 * intentionally not rebased: callers must fetch an authoritative snapshot.
 */
export function applyPresenceDelta(
  room: RoomState,
  delta: RoomPresenceDelta,
): RoomState | null {
  const currentStateRevision = roomStateRevision(room);
  if (
    room.id !== delta.roomId ||
    room.roomRevision !== delta.roomRevision ||
    delta.stateRevision !== currentStateRevision + 1
  ) {
    return null;
  }
  const participant = room.participants[delta.participantId];
  if (!participant) return null;
  return {
    ...room,
    stateRevision: delta.stateRevision,
    participants: {
      ...room.participants,
      [delta.participantId]: {
        ...participant,
        lastSeenAt: delta.lastSeenAt,
        connected: delta.connected,
        agentActive: delta.agentActive,
        [delta.actorKind]: structuredClone(delta.presence),
      },
    },
  };
}

/** Durable document watermark carried by every accepted event generation. */
export function roomEventDocumentRevision(event: RoomEvent): number {
  if (isPresenceDeltaRoomEventPayload(event.payload, event.roomId, event.sequence)) {
    return event.payload.roomRevision;
  }
  if (isCompactRoomEventPayloadV3(event.payload, event.sequence)) return event.payload.roomRevision;
  // Schema v2 predates split revisions, so its roomRevision is an aggregate
  // state watermark rather than a trustworthy durable-document watermark.
  if (isCompactRoomEventPayloadV2(event.payload, event.sequence)) return 0;
  const payload = record(event.payload);
  const room = payload?.room;
  if (!isRoomStateEnvelope(room)) return event.sequence;
  // A pre-plane deployment advances roomRevision for presence and lease
  // traffic too. Its full snapshot must therefore be reconciled as an
  // aggregate-state signal; the room store separately promotes a changed
  // durable fingerprint and assigns the next v3 document revision.
  return validRevision(room.stateRevision) ? room.roomRevision : 0;
}

/**
 * Aggregate state watermark when the writer knows about split room state.
 * A v2 compact event predates split revisions and uses its sequence as the
 * aggregate state watermark. The store resolves whether durable content also
 * changed by comparing the legacy document fingerprint.
 */
export function roomEventStateRevision(event: RoomEvent): number | null {
  if (isPresenceDeltaRoomEventPayload(event.payload, event.roomId, event.sequence)) {
    return event.payload.stateRevision;
  }
  if (isCompactRoomEventPayloadV3(event.payload, event.sequence)) {
    return event.payload.stateRevision;
  }
  if (isCompactRoomEventPayloadV2(event.payload, event.sequence)) return event.sequence;
  const payload = record(event.payload);
  const room = record(payload?.room);
  if (!room) return null;
  if (validRevision(room.stateRevision)) return room.stateRevision;
  // Rolling full-room events use roomRevision as their aggregate watermark.
  return isRoomStateEnvelope(room) ? room.roomRevision : null;
}

export function legacyRoomStateFromEvent(event: RoomEvent): RoomState | null {
  const payload = record(event.payload);
  const candidate = payload?.room;
  if (!isRoomStateEnvelope(candidate)) return null;
  if (candidate.id !== event.roomId || roomStateRevision(candidate) !== event.sequence) {
    return null;
  }
  return normalizedRoomState(candidate);
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
  if (sequence !== undefined && roomStateRevision(room) !== sequence) return false;
  return true;
}

/** Old full snapshots and schema-v2 invalidations need one authoritative read
 * because their single revision cannot classify document vs awareness work. */
export function requiresLegacyRoomReconciliation(event: RoomEvent): boolean {
  if (isCompactRoomEventPayloadV2(event.payload, event.sequence)) return true;
  const payload = record(event.payload);
  const room = record(payload?.room);
  return Boolean(room && isRoomStateEnvelope(room) && !validRevision(room.stateRevision));
}

export function compactRoomEvent(event: RoomEvent): RoomEvent {
  if (isPresenceDeltaRoomEventPayload(event.payload, event.roomId, event.sequence)) {
    return event;
  }
  const payload = record(event.payload);
  const activity = record(payload?.activity);
  const room = payload?.room;
  const compact = isCompactRoomEventPayload(event.payload, event.sequence)
    ? event.payload
    : null;
  const roomRevision = isRoomStateEnvelope(room)
    ? validRevision(room.stateRevision)
      ? room.roomRevision
      : 0
    : compact && isCompactRoomEventPayloadV3(compact, event.sequence)
      ? compact.roomRevision
      : 0;
  return {
    ...event,
    payload: {
      schemaVersion: 3,
      kind: "room.invalidated",
      stateRevision: event.sequence,
      roomRevision,
      activityId: typeof activity?.id === "string" ? activity.id : compact?.activityId ?? null,
    },
  };
}
