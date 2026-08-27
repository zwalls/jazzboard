import type {
  AgentEditPolicy,
  AgentEditProposal,
  CanvasObject,
  Diagram,
  ObjectLease,
  Participant,
  PresenceTarget,
  RoomRole,
  RoomState,
  Spotlight,
} from "@/lib/domain/types";

export const ROOM_STORAGE_SCHEMA_VERSION = 1 as const;

export type DurableParticipant = Pick<
  Participant,
  "participantId" | "displayName" | "color" | "role" | "joinedAt"
>;

export type ParticipantAwareness = Pick<
  Participant,
  "lastSeenAt" | "connected" | "agentActive" | "human" | "agent"
> & {
  /**
   * Bounded authorization mirror for the awareness hot path. Optional only
   * while pre-mirror v3 records age through a rolling deployment.
   */
  member?: DurableParticipant;
};

export type RoomDocumentPlane = {
  schemaVersion: typeof ROOM_STORAGE_SCHEMA_VERSION;
  id: string;
  code: string;
  title: string;
  roomRevision: number;
  createdAt: number;
  updatedAt: number;
  participants: Record<string, DurableParticipant>;
  objects: Record<string, CanvasObject>;
  diagrams: Record<string, Diagram>;
  agentEditPolicy: AgentEditPolicy;
  reviewProposals: AgentEditProposal[];
};

export type RoomAwarenessPlane = {
  schemaVersion: typeof ROOM_STORAGE_SCHEMA_VERSION;
  participants: Record<string, ParticipantAwareness>;
  spotlight: Spotlight | null;
};

export type RoomCoordinationPlane = {
  schemaVersion: typeof ROOM_STORAGE_SCHEMA_VERSION;
  stateRevision: number;
  /** Durable watermark mirrored for document-fenced awareness deltas. */
  roomRevision?: number;
  /** Set once the pre-plane aggregate key has been atomically imported and deleted. */
  legacyRetired?: true;
  leases: Record<string, ObjectLease>;
};

export type PersistedRoomPlanes = {
  document: RoomDocumentPlane;
  awareness: RoomAwarenessPlane;
  coordination: RoomCoordinationPlane;
};

export type LegacyCompatibleRoomState = Omit<RoomState, "stateRevision"> & {
  stateRevision?: never;
};

export type LegacyPlaneReconciliation = {
  planes: PersistedRoomPlanes;
  legacyAdvanced: boolean;
  documentPromoted: boolean;
};

function defaultPresence(lastSeenAt: number): PresenceTarget {
  return { cursor: null, viewport: null, lastSeenAt, activity: null };
}

function durableParticipant(participant: Participant): DurableParticipant {
  return {
    participantId: participant.participantId,
    displayName: participant.displayName,
    color: participant.color,
    role: participant.role,
    joinedAt: participant.joinedAt,
  };
}

function participantAwareness(participant: Participant): ParticipantAwareness {
  return {
    member: durableParticipant(participant),
    lastSeenAt: participant.lastSeenAt,
    connected: participant.connected,
    agentActive: participant.agentActive,
    human: structuredClone(participant.human),
    agent: structuredClone(participant.agent),
  };
}

function awarenessWithDocumentMembers(
  awareness: RoomAwarenessPlane,
  participants: Record<string, DurableParticipant>,
): RoomAwarenessPlane {
  return {
    ...structuredClone(awareness),
    participants: Object.fromEntries(
      Object.entries(participants).map(([participantId, member]) => {
        const existing = awareness.participants[participantId];
        const lastSeenAt = existing?.lastSeenAt ?? member.joinedAt;
        return [
          participantId,
          existing
            ? { ...structuredClone(existing), member: structuredClone(member) }
            : {
                member: structuredClone(member),
                lastSeenAt,
                connected: false,
                agentActive: false,
                human: defaultPresence(lastSeenAt),
                agent: defaultPresence(lastSeenAt),
              },
        ];
      }),
    ),
  };
}

export function splitRoomState(room: RoomState): PersistedRoomPlanes {
  return {
    document: {
      schemaVersion: ROOM_STORAGE_SCHEMA_VERSION,
      id: room.id,
      code: room.code,
      title: room.title,
      roomRevision: room.roomRevision,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      participants: Object.fromEntries(
        Object.entries(room.participants).map(([participantId, participant]) => [
          participantId,
          durableParticipant(participant),
        ]),
      ),
      objects: structuredClone(room.objects),
      diagrams: structuredClone(room.diagrams),
      agentEditPolicy: room.agentEditPolicy,
      reviewProposals: structuredClone(room.reviewProposals),
    },
    awareness: {
      schemaVersion: ROOM_STORAGE_SCHEMA_VERSION,
      participants: Object.fromEntries(
        Object.entries(room.participants).map(([participantId, participant]) => [
          participantId,
          participantAwareness(participant),
        ]),
      ),
      spotlight: structuredClone(room.spotlight),
    },
    coordination: {
      schemaVersion: ROOM_STORAGE_SCHEMA_VERSION,
      stateRevision: room.stateRevision ?? room.roomRevision,
      roomRevision: room.roomRevision,
      legacyRetired: true,
      leases: structuredClone(room.leases),
    },
  };
}

function validRole(value: unknown): value is RoomRole {
  return value === "participant" || value === "spectator";
}

function composeParticipant(
  durable: DurableParticipant,
  awareness: ParticipantAwareness | undefined,
): Participant {
  const lastSeenAt = awareness?.lastSeenAt ?? durable.joinedAt;
  return {
    participantId: durable.participantId,
    displayName: durable.displayName,
    color: durable.color,
    role: validRole(durable.role) ? durable.role : "spectator",
    joinedAt: durable.joinedAt,
    lastSeenAt,
    connected: awareness?.connected ?? false,
    agentActive: awareness?.agentActive ?? false,
    human: structuredClone(awareness?.human ?? defaultPresence(lastSeenAt)),
    agent: structuredClone(awareness?.agent ?? defaultPresence(lastSeenAt)),
  };
}

export function composeRoomState(planes: PersistedRoomPlanes): RoomState {
  const { document, awareness, coordination } = planes;
  return {
    id: document.id,
    code: document.code,
    title: document.title,
    stateRevision: Math.max(coordination.stateRevision, document.roomRevision),
    roomRevision: document.roomRevision,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    participants: Object.fromEntries(
      Object.entries(document.participants).map(([participantId, participant]) => [
        participantId,
        composeParticipant(participant, awareness.participants[participantId]),
      ]),
    ),
    objects: structuredClone(document.objects),
    diagrams: structuredClone(document.diagrams),
    leases: structuredClone(coordination.leases),
    spotlight: structuredClone(awareness.spotlight),
    agentEditPolicy: document.agentEditPolicy,
    reviewProposals: structuredClone(document.reviewProposals),
  };
}

/** Converts pre-plane persisted RoomState JSON without allowing it to overwrite initialized planes. */
export function planesFromLegacyRoom(room: RoomState): PersistedRoomPlanes {
  const migrated = structuredClone(room) as RoomState;
  const legacyStateRevision = migrated.stateRevision;
  migrated.stateRevision =
    typeof legacyStateRevision === "number" && Number.isSafeInteger(legacyStateRevision)
      ? Math.max(legacyStateRevision, migrated.roomRevision)
      : migrated.roomRevision;
  return splitRoomState(migrated);
}

/**
 * Old Jazzboard deployments use roomRevision as their aggregate room
 * watermark. Keeping stateRevision out of the compatibility snapshot prevents
 * an old writer from producing an invalid envelope where roomRevision has
 * advanced beyond a stateRevision it does not know how to maintain.
 */
export function roomForLegacyCompatibility(room: RoomState): LegacyCompatibleRoomState {
  const clone = structuredClone(room);
  const stateRevision = Math.max(clone.stateRevision ?? clone.roomRevision, clone.roomRevision);
  delete (clone as { stateRevision?: number }).stateRevision;
  clone.roomRevision = stateRevision;
  return clone as LegacyCompatibleRoomState;
}

/**
 * Reconciles a mutation committed by a rolling pre-plane deployment. The
 * legacy snapshot is authoritative only for durable document fields. Live
 * presence, Spotlight, and leases always remain owned by the v3 planes.
 */
export function reconcileLaterLegacyRoom(
  current: PersistedRoomPlanes,
  legacyRoom: RoomState,
): LegacyPlaneReconciliation {
  const legacyStateRevision = Math.max(
    legacyRoom.stateRevision ?? legacyRoom.roomRevision,
    legacyRoom.roomRevision,
  );
  const legacy = planesFromLegacyRoom(legacyRoom);
  const documentPromoted =
    documentContentFingerprint(legacy.document) !== documentContentFingerprint(current.document);
  const stateAdvanced = legacyStateRevision > current.coordination.stateRevision;
  if (!stateAdvanced && !documentPromoted) {
    return { planes: structuredClone(current), legacyAdvanced: false, documentPromoted: false };
  }
  const document = documentPromoted
    ? {
        ...legacy.document,
        roomRevision: current.document.roomRevision + 1,
      }
    : structuredClone(current.document);

  return {
    planes: {
      document,
      awareness: documentPromoted
        ? awarenessWithDocumentMembers(current.awareness, document.participants)
        : structuredClone(current.awareness),
      coordination: {
        ...structuredClone(current.coordination),
        stateRevision: Math.max(
          legacyStateRevision,
          document.roomRevision,
          current.coordination.stateRevision + (documentPromoted ? 1 : 0),
        ),
        roomRevision: document.roomRevision,
      },
    },
    legacyAdvanced: true,
    documentPromoted,
  };
}

export function documentContentFingerprint(document: RoomDocumentPlane): string {
  const content = { ...document, roomRevision: 0, updatedAt: 0 };
  return JSON.stringify(content);
}

export function awarenessContentFingerprint(awareness: RoomAwarenessPlane): string {
  return JSON.stringify(awareness);
}

export function coordinationContentFingerprint(coordination: RoomCoordinationPlane): string {
  return JSON.stringify(coordination.leases);
}

export function encodedRoomPlaneBytes(planes: PersistedRoomPlanes): {
  document: number;
  awareness: number;
  coordination: number;
  composed: number;
} {
  return {
    document: Buffer.byteLength(JSON.stringify(planes.document)),
    awareness: Buffer.byteLength(JSON.stringify(planes.awareness)),
    coordination: Buffer.byteLength(JSON.stringify(planes.coordination)),
    composed: Buffer.byteLength(JSON.stringify(composeRoomState(planes))),
  };
}
