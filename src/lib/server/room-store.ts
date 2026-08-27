import { EventEmitter } from "node:events";
import { randomInt, randomUUID } from "node:crypto";

import Redis from "ioredis";

import { parseRoomAssetProxyReference } from "@/lib/assets/policy";
import { actorFor, normalizeRoomSemanticState } from "@/lib/domain/engine";
import { DomainError } from "@/lib/domain/errors";
import { roomActivitySummary } from "@/lib/domain/review";
import type {
  ActorKind,
  ActorRef,
  AgentActivity,
  Participant,
  Point,
  RoomActivity,
  RoomActivitySummary,
  RoomEvent,
  RoomPresenceDelta,
  RoomRole,
  RoomState,
  Viewport,
} from "@/lib/domain/types";
import {
  compactRoomEvent,
  isCompactRoomEventPayloadV3,
  presenceDeltaFromEvent,
} from "@/lib/realtime/events";

import {
  assertRedisPlaneWriteCapacity,
  assertRoomMutationCapacity,
  capacityModeFromEnvironment,
  DEFAULT_CAPACITY_LIMITS,
  DEFAULT_CAPACITY_WARNING_RATIO,
  evaluateAwarenessMutationCapacity,
  evaluateRoomCapacity,
  evaluateRoomMutationCapacity,
  REDIS_SAFE_PLANE_WRITE_BYTES,
  roomCapacityError,
  utf8JsonBytes,
} from "./capacity";
import {
  createActivityHistoryRoomCommitCommand,
  createMemoryActivityHistoryState,
  executeActivityHistoryRoomCommit,
  MemoryActivityHistoryStore,
  RedisActivityHistoryStore,
  type MemoryActivityHistoryState,
} from "./activity-history-store";
import {
  assertReceiptMatches,
  createMutationReceipt,
  IDEMPOTENCY_RECEIPT_TTL_SECONDS,
  parseMutationReceipt,
  serializeMutationReceipt,
  sha256,
  localMutationReceiptState,
  withLocalMutationReceiptLock,
  type CompactMutationReceipt,
} from "./idempotency";
import {
  currentMutationContext,
  markCurrentMutationReplayed,
} from "./mutation-context";
import {
  awarenessContentFingerprint,
  composeRoomState,
  coordinationContentFingerprint,
  documentContentFingerprint,
  planesFromLegacyRoom,
  splitRoomState,
  type DurableParticipant,
  type ParticipantAwareness,
  type PersistedRoomPlanes,
  type RoomAwarenessPlane,
  type RoomCoordinationPlane,
  type RoomDocumentPlane,
} from "./room-planes";
import { emitTelemetry, hashTelemetryIdentifier } from "./telemetry";
import {
  redisPresenceScript,
  redisPresenceScriptSha,
} from "./redis-presence-script";

const COLORS = ["#4F6BED", "#00A68A", "#9B51E0", "#E0528D", "#D9822B", "#00A2C7", "#E5484D"];
const LEGACY_ROOM_KEY_PREFIX = "jazzboard:room:";
const ROOM_DOCUMENT_KEY_PREFIX = "jazzboard:room:v3:document:";
const ROOM_AWARENESS_KEY_PREFIX = "jazzboard:room:v3:awareness:";
const ROOM_COORDINATION_KEY_PREFIX = "jazzboard:room:v3:coordination:";
const CODE_KEY_PREFIX = "jazzboard:code:";
const EVENT_STREAM = "jazzboard:events";
export const PRESENCE_AWAY_MS = 75_000;
const AWARENESS_TELEMETRY_WINDOW_MS = 60_000;
const ROOM_CREATE_OUTCOME = "room_created";
const ROOM_TRANSACTION_MAX_ATTEMPTS = 16;
const ROOM_TRANSACTION_RETRY_MAX_DELAY_MS = 80;

const loadedPresenceScripts = new WeakMap<Redis, Set<string>>();
const awarenessTelemetryWindows = new Map<string, number>();

function waitForRoomTransactionRetry(attempt: number): Promise<void> {
  // Concurrent lease, presence, and document writes can otherwise retry in
  // lockstep and repeatedly invalidate one another. Full jitter gives a
  // contending mutation a quiet commit window while keeping the common first
  // retry effectively immediate.
  const ceiling = Math.min(
    ROOM_TRANSACTION_RETRY_MAX_DELAY_MS,
    2 ** Math.min(attempt, 6),
  );
  const delay = randomInt(0, ceiling + 1);
  return delay > 0
    ? new Promise((resolve) => setTimeout(resolve, delay))
    : Promise.resolve();
}

const CREATE_REDIS_ROOM_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 1 then
  return { "code_conflict" }
end
if redis.call("EXISTS", KEYS[2]) == 1
  or redis.call("EXISTS", KEYS[3]) == 1
  or redis.call("EXISTS", KEYS[4]) == 1 then
  return { "orphan" }
end
redis.call("SET", KEYS[1], ARGV[1])
redis.call("SET", KEYS[2], ARGV[2])
redis.call("SET", KEYS[3], ARGV[3])
redis.call("SET", KEYS[4], ARGV[4])
redis.call("XADD", KEYS[5], "MAXLEN", "~", 20000, "*", "roomId", ARGV[1], "data", ARGV[5])
return { "created" }
`;

const CREATE_IDEMPOTENT_REDIS_ROOM_SCRIPT = `
local existing_receipt = redis.call("GET", KEYS[6])
if existing_receipt then
  return { "replay", existing_receipt }
end
if redis.call("EXISTS", KEYS[1]) == 1 then
  return { "code_conflict" }
end
if redis.call("EXISTS", KEYS[2]) == 1
  or redis.call("EXISTS", KEYS[3]) == 1
  or redis.call("EXISTS", KEYS[4]) == 1 then
  return { "orphan" }
end
redis.call("SET", KEYS[1], ARGV[1])
redis.call("SET", KEYS[2], ARGV[2])
redis.call("SET", KEYS[3], ARGV[3])
redis.call("SET", KEYS[4], ARGV[4])
redis.call("XADD", KEYS[5], "MAXLEN", "~", 20000, "*", "roomId", ARGV[1], "data", ARGV[5])
redis.call("SET", KEYS[6], ARGV[6], "EX", ARGV[7])
return { "created", ARGV[6] }
`;

export function roomIdFromMutationGeneration(
  scopedKeyHash: string,
  committedAt: number,
): string {
  if (
    !/^[a-f0-9]{64}$/.test(scopedKeyHash) ||
    !Number.isSafeInteger(committedAt) ||
    committedAt < 0
  ) {
    throw new Error("Room mutation generation inputs are invalid.");
  }
  const hex = sha256(
    `jazzboard:room-generation:v1\0${scopedKeyHash}\0${committedAt}`,
  ).slice(0, 32);
  return `room_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type RoomCreateGeneration = {
  receipt: CompactMutationReceipt;
  roomId: string;
};

function roomCreateGenerationFromReceipt(
  encoded: string | null,
): RoomCreateGeneration | null {
  if (!encoded) return null;
  const identity = currentMutationContext()?.idempotency;
  if (!identity) return null;
  const receipt = parseMutationReceipt(encoded);
  if (!receipt) {
    throw new DomainError(
      "MUTATION_OUTCOME_UNKNOWN",
      "Jazzboard found an unreadable room-creation receipt and will not risk creating a duplicate room.",
    );
  }
  assertReceiptMatches(receipt, identity);
  const roomId = roomIdFromMutationGeneration(
    identity.scopedKeyHash,
    receipt.committedAt,
  );
  if (
    receipt.outcome !== ROOM_CREATE_OUTCOME ||
    receipt.committedRoomRevision !== 1 ||
    receipt.resourceIdHash !== sha256(roomId)
  ) {
    throw new DomainError(
      "MUTATION_OUTCOME_UNKNOWN",
      "Jazzboard could not verify the outcome of this room creation.",
    );
  }
  return { receipt, roomId };
}

function roomCreationReceipt(room: RoomState): CompactMutationReceipt | null {
  const identity = currentMutationContext()?.idempotency;
  if (!identity) return null;
  if (
    room.id !== roomIdFromMutationGeneration(identity.scopedKeyHash, room.createdAt) ||
    room.roomRevision !== 1
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "That Idempotency-Key does not match this room creation.",
    );
  }
  return createMutationReceipt({
    identity,
    outcome: ROOM_CREATE_OUTCOME,
    committedAt: room.createdAt,
    committedRoomRevision: room.roomRevision,
    resourceId: room.id,
  });
}

function missingCreatedRoomError(): DomainError {
  return new DomainError(
    "MUTATION_OUTCOME_UNKNOWN",
    "This room creation already completed, but Jazzboard cannot verify the original room and private code mapping.",
    { replayed: true, roomAvailable: false },
  );
}

type RoomPlaneRead = {
  planes: PersistedRoomPlanes;
  persisted: boolean;
};

type RoomUpdater<T> = (room: RoomState) => {
  room: RoomState;
  result: T;
  eventActor?: ActorRef | null;
  activity?: RoomActivity;
};

export type PresenceUpdateInput = {
  roomId: string;
  participantId: string;
  actorKind: ActorKind;
  cursor: Point | null;
  viewport: Viewport | null;
  activity: AgentActivity | null;
};

export interface RoomStore {
  createRoom(input: {
    participantId: string;
    displayName: string;
    title: string;
  }): Promise<RoomState>;
  joinRoom(input: {
    participantId: string;
    displayName: string;
    code: string;
    role: RoomRole;
  }): Promise<RoomState>;
  getRoom(roomId: string): Promise<RoomState | null>;
  getRoomByCode(code: string): Promise<RoomState | null>;
  listActivities(roomId: string): Promise<RoomActivitySummary[]>;
  getActivity(roomId: string, activityId: string): Promise<RoomActivity | null>;
  updatePresence(input: PresenceUpdateInput): Promise<RoomPresenceDelta>;
  assertMutationNotReplayed(roomId: string): Promise<void>;
  transact<T>(roomId: string, updater: RoomUpdater<T>, eventType?: RoomEvent["type"]): Promise<T>;
}

type LocalState = {
  rooms: Map<string, PersistedRoomPlanes | RoomState>;
  codes: Map<string, string>;
  activityHistory: MemoryActivityHistoryState;
  /** Development hot-reload compatibility only; new writes never target it. */
  activities: Map<string, RoomActivity[]>;
  activityMigration: Promise<void> | null;
  mutationReceipts: Map<string, { expiresAt: number; encoded: string }>;
  queues: Map<string, Promise<void>>;
  bus: EventEmitter;
};

declare global {
  var __jazzboardLocalState: LocalState | undefined;
  var __jazzboardRoomStore: RoomStore | undefined;
  var __jazzboardRedis: Redis | null | undefined;
}

function localState(): LocalState {
  globalThis.__jazzboardLocalState ??= {
    rooms: new Map(),
    codes: new Map(),
    activityHistory: createMemoryActivityHistoryState(),
    activities: new Map(),
    activityMigration: null,
    mutationReceipts: localMutationReceiptState().receipts,
    queues: new Map(),
    bus: new EventEmitter(),
  };
  // Development hot reload can retain a process-local state created by an
  // earlier module version before activity persistence existed.
  globalThis.__jazzboardLocalState.activityHistory ??= createMemoryActivityHistoryState();
  globalThis.__jazzboardLocalState.activities ??= new Map();
  globalThis.__jazzboardLocalState.activityMigration ??= null;
  const sharedReceipts = localMutationReceiptState().receipts;
  if (globalThis.__jazzboardLocalState.mutationReceipts !== sharedReceipts) {
    for (const [key, receipt] of globalThis.__jazzboardLocalState.mutationReceipts ?? []) {
      if (!sharedReceipts.has(key)) sharedReceipts.set(key, receipt);
    }
    globalThis.__jazzboardLocalState.mutationReceipts = sharedReceipts;
  }
  globalThis.__jazzboardLocalState.bus.setMaxListeners(200);
  return globalThis.__jazzboardLocalState;
}

async function ensureLocalActivityHistory(state: LocalState): Promise<void> {
  if (state.activities.size === 0) return;
  state.activityMigration ??= (async () => {
    const history = new MemoryActivityHistoryStore(state.activityHistory);
    for (const activities of state.activities.values()) {
      // Legacy process-local lists are newest-first. The normalized store sorts
      // authoritatively by room revision, so importing oldest-first also keeps
      // deterministic retention when a hot-reloaded room already has 200 rows.
      for (const activity of [...activities].reverse()) {
        await history.appendActivity(activity);
      }
    }
    state.activities.clear();
  })();
  try {
    await state.activityMigration;
  } finally {
    if (state.activities.size === 0) state.activityMigration = null;
  }
}

function makeParticipant(input: {
  participantId: string;
  displayName: string;
  role: RoomRole;
  color: string;
  now: number;
}): Participant {
  const presence = { cursor: null, viewport: null, lastSeenAt: input.now, activity: null };
  return {
    participantId: input.participantId,
    displayName: input.displayName,
    color: input.color,
    role: input.role,
    joinedAt: input.now,
    lastSeenAt: input.now,
    connected: true,
    agentActive: false,
    human: { ...presence },
    agent: { ...presence },
  };
}

function availableColor(room: RoomState): string {
  const used = new Set(Object.values(room.participants).map((participant) => participant.color));
  return COLORS.find((color) => !used.has(color)) ?? COLORS[Object.keys(room.participants).length % COLORS.length];
}

function joinedParticipantMatches(
  room: RoomState | null,
  input: { participantId: string; displayName: string; role: RoomRole },
): room is RoomState {
  const participant = room?.participants[input.participantId];
  return Boolean(
    participant &&
    participant.displayName === input.displayName &&
    participant.role === input.role &&
    participant.connected,
  );
}

function verifiedCommittedRoomRevision(error: unknown): number | null {
  if (!(error instanceof DomainError) || error.code !== "MUTATION_OUTCOME_UNKNOWN") {
    return null;
  }
  const details = error.details;
  const revision = details && "committedRoomRevision" in details
    ? details.committedRoomRevision
    : null;
  return details && "replayed" in details && details.replayed === true &&
    Number.isSafeInteger(revision) &&
    Number(revision) >= 0
    ? Number(revision)
    : null;
}

function currentRoomCopy(room: RoomState): RoomState {
  const current = normalizeRoomSemanticState(structuredClone(room));
  current.stateRevision = Math.max(current.stateRevision ?? current.roomRevision, current.roomRevision);
  return current;
}

function privateBlobPathnames(room: RoomState): Set<string> {
  const pathnames = new Set<string>();
  for (const object of Object.values(room.objects)) {
    if (object.kind !== "image") continue;
    const reference = parseRoomAssetProxyReference(object.url);
    if (reference?.pathname) pathnames.add(reference.pathname);
  }
  return pathnames;
}

function introducedPrivateBlobPathnames(
  before: RoomState,
  after: RoomState,
): string[] {
  const previous = privateBlobPathnames(before);
  return [...privateBlobPathnames(after)].filter((pathname) => !previous.has(pathname));
}

async function assertLocalPrivateBlobReferences(
  roomId: string,
  pathnames: readonly string[],
): Promise<void> {
  if (!pathnames.length) return;
  const {
    getPrivateBlobAssetRegistration,
    isPrivateBlobAssetReferenceEligible,
  } = await import("./blob-asset-registry");
  for (const pathname of pathnames) {
    const registration = await getPrivateBlobAssetRegistration(pathname);
    if (
      registration?.roomId !== roomId ||
      !isPrivateBlobAssetReferenceEligible(registration)
    ) {
      throw new DomainError(
        "INVALID_OPERATION",
        "That private image is not available for a new canvas reference.",
      );
    }
  }
}

type PrivateBlobReferenceGuard = { key: string; expectedValue: string };

async function readRedisPrivateBlobReferenceGuards(
  connection: Redis,
  roomId: string,
  pathnames: readonly string[],
): Promise<PrivateBlobReferenceGuard[]> {
  if (!pathnames.length) return [];
  const {
    isPrivateBlobAssetReferenceEligible,
    parsePrivateBlobAssetRegistration,
    privateBlobAssetRegistrationRedisKey,
  } = await import("./blob-asset-registry");
  const keys = pathnames.map(privateBlobAssetRegistrationRedisKey);
  await connection.watch(...keys);
  const values = await connection.mget(...keys);
  try {
    return values.map((value, index) => {
      const registration = parsePrivateBlobAssetRegistration(value);
      if (
        !value ||
        registration?.roomId !== roomId ||
        registration.pathname !== pathnames[index] ||
        !isPrivateBlobAssetReferenceEligible(registration)
      ) {
        throw new DomainError(
          "INVALID_OPERATION",
          "That private image is not available for a new canvas reference.",
        );
      }
      return { key: keys[index], expectedValue: value };
    });
  } catch (error) {
    await connection.unwatch().catch(() => undefined);
    throw error;
  }
}

type DerivedStateReconciliation = {
  awareness: RoomAwarenessPlane;
  coordination: RoomCoordinationPlane;
  eventType: "presence.updated" | "lease.updated" | "spotlight.updated";
};

/**
 * Turns wall-clock liveness into authoritative state. The transition is
 * intentionally one aggregate revision regardless of how many participants,
 * leases, or Spotlight followers expire at the same observation boundary.
 */
function reconcileDerivedState(
  awareness: RoomAwarenessPlane,
  coordination: RoomCoordinationPlane,
  roomRevisionInput: number,
  now: number,
): DerivedStateReconciliation | null {
  let nextAwareness = awareness;
  let presenceChanged = false;
  for (const [participantId, participant] of Object.entries(awareness.participants)) {
    const connected =
      now - participant.human.lastSeenAt < PRESENCE_AWAY_MS ||
      now - participant.agent.lastSeenAt < PRESENCE_AWAY_MS;
    if (connected === participant.connected) continue;
    if (nextAwareness === awareness) nextAwareness = structuredClone(awareness);
    nextAwareness.participants[participantId].connected = connected;
    presenceChanged = true;
  }

  const nextLeases = Object.fromEntries(
    Object.entries(coordination.leases).filter(([, lease]) => lease.expiresAt > now),
  );
  const leasesChanged = Object.keys(nextLeases).length !== Object.keys(coordination.leases).length;

  let spotlightChanged = false;
  const spotlight = nextAwareness.spotlight;
  if (spotlight) {
    const presenter = nextAwareness.participants[spotlight.presenterId];
    if (!presenter?.connected) {
      if (nextAwareness === awareness) nextAwareness = structuredClone(awareness);
      nextAwareness.spotlight = null;
      spotlightChanged = true;
    } else {
      const followers = spotlight.followingParticipantIds.filter(
        (participantId) => nextAwareness.participants[participantId]?.connected,
      );
      if (
        followers.length !== spotlight.followingParticipantIds.length ||
        followers.some((participantId, index) => participantId !== spotlight.followingParticipantIds[index])
      ) {
        if (nextAwareness === awareness) nextAwareness = structuredClone(awareness);
        nextAwareness.spotlight!.followingParticipantIds = followers;
        spotlightChanged = true;
      }
    }
  }

  if (!presenceChanged && !leasesChanged && !spotlightChanged) return null;
  const roomRevision = Math.max(roomRevisionInput, coordination.roomRevision ?? roomRevisionInput);
  return {
    awareness: nextAwareness,
    coordination: {
      ...coordination,
      stateRevision: Math.max(coordination.stateRevision, roomRevision) + 1,
      roomRevision,
      leases: leasesChanged ? nextLeases : coordination.leases,
    },
    eventType: spotlightChanged
      ? "spotlight.updated"
      : leasesChanged
        ? "lease.updated"
        : "presence.updated",
  };
}

function derivedStateEvent(
  roomId: string,
  reconciliation: DerivedStateReconciliation,
  now: number,
): RoomEvent {
  return {
    id: randomUUID(),
    roomId,
    sequence: reconciliation.coordination.stateRevision,
    occurredAt: now,
    type: reconciliation.eventType,
    actor: null,
    payload: {
      schemaVersion: 3,
      kind: "room.invalidated",
      stateRevision: reconciliation.coordination.stateRevision,
      roomRevision: reconciliation.coordination.roomRevision ?? 0,
      activityId: null,
    },
  };
}

function roomEvent(
  room: RoomState,
  type: RoomEvent["type"],
  actor: ActorRef | null = null,
  activity: RoomActivity | null = null,
): RoomEvent {
  return {
    id: randomUUID(),
    roomId: room.id,
    sequence: room.stateRevision ?? room.roomRevision,
    occurredAt: Date.now(),
    type,
    actor,
    payload: { room, activity: activity ? roomActivitySummary(activity) : null },
  };
}

function presenceActor(member: DurableParticipant, kind: ActorKind): ActorRef {
  return {
    participantId: member.participantId,
    displayName: member.displayName,
    color: member.color,
    kind,
  };
}

function requirePresenceMember(
  member: DurableParticipant | undefined,
  actorKind: ActorKind,
): DurableParticipant {
  if (!member) {
    throw new DomainError("FORBIDDEN", "This guest session is not a member of the room.");
  }
  if (actorKind === "agent" && member.role !== "participant") {
    throw new DomainError("FORBIDDEN", "Spectators cannot change the canvas.", {
      role: member.role,
    });
  }
  return member;
}

function initialParticipantAwareness(
  member: DurableParticipant,
  now: number,
): ParticipantAwareness {
  const presence = { cursor: null, viewport: null, lastSeenAt: now, activity: null };
  return {
    member: structuredClone(member),
    lastSeenAt: now,
    connected: true,
    agentActive: false,
    human: { ...presence },
    agent: { ...presence },
  };
}

function applyPresenceUpdate(
  awareness: RoomAwarenessPlane,
  coordination: RoomCoordinationPlane,
  memberInput: DurableParticipant | undefined,
  roomRevisionInput: number,
  input: PresenceUpdateInput,
  now: number,
): {
  awareness: RoomAwarenessPlane;
  coordination: RoomCoordinationPlane;
  delta: RoomPresenceDelta;
  event: RoomEvent;
} {
  const previousAwareness = awareness.participants[input.participantId];
  const member = requirePresenceMember(previousAwareness?.member ?? memberInput, input.actorKind);
  const participant = structuredClone(
    previousAwareness ?? initialParticipantAwareness(member, now),
  );
  participant.member = structuredClone(member);
  participant[input.actorKind] = {
    cursor: structuredClone(input.cursor),
    viewport: structuredClone(input.viewport),
    lastSeenAt: now,
    activity: structuredClone(input.activity),
  };
  participant.connected = true;
  participant.lastSeenAt = now;
  if (input.actorKind === "agent") participant.agentActive = true;

  const roomRevision = Math.max(roomRevisionInput, coordination.roomRevision ?? roomRevisionInput);
  const stateRevision = Math.max(coordination.stateRevision, roomRevision) + 1;
  const nextAwareness: RoomAwarenessPlane = {
    ...awareness,
    participants: {
      ...awareness.participants,
      [input.participantId]: participant,
    },
  };
  const nextCoordination: RoomCoordinationPlane = {
    ...coordination,
    stateRevision,
    roomRevision,
  };
  const delta: RoomPresenceDelta = {
    roomId: input.roomId,
    stateRevision,
    roomRevision,
    participantId: input.participantId,
    actorKind: input.actorKind,
    lastSeenAt: now,
    connected: true,
    agentActive: participant.agentActive,
    presence: structuredClone(participant[input.actorKind]),
  };
  const event: RoomEvent = {
    id: randomUUID(),
    roomId: input.roomId,
    sequence: stateRevision,
    occurredAt: now,
    type: input.actorKind === "agent" ? "agent.activity" : "presence.updated",
    actor: presenceActor(member, input.actorKind),
    payload: {
      schemaVersion: 4,
      kind: "presence.delta",
      stateRevision,
      roomRevision,
      participantId: delta.participantId,
      actorKind: delta.actorKind,
      lastSeenAt: delta.lastSeenAt,
      connected: delta.connected,
      agentActive: delta.agentActive,
      presence: delta.presence,
    },
  };
  return {
    awareness: nextAwareness,
    coordination: nextCoordination,
    delta,
    event,
  };
}

function applyPresenceUpdateToPlanes(
  planes: PersistedRoomPlanes,
  input: PresenceUpdateInput,
  now: number,
): { planes: PersistedRoomPlanes; delta: RoomPresenceDelta; event: RoomEvent } {
  const updated = applyPresenceUpdate(
    planes.awareness,
    planes.coordination,
    planes.document.participants[input.participantId],
    planes.document.roomRevision,
    input,
    now,
  );
  return {
    planes: {
      document: planes.document,
      awareness: updated.awareness,
      coordination: updated.coordination,
    },
    delta: updated.delta,
    event: updated.event,
  };
}

function normalizedLocalPlanes(value: PersistedRoomPlanes | RoomState): PersistedRoomPlanes {
  return "document" in value ? structuredClone(value) : planesFromLegacyRoom(value);
}

function roomPlaneKeys(roomId: string): {
  legacy: string;
  document: string;
  awareness: string;
  coordination: string;
} {
  return {
    legacy: `${LEGACY_ROOM_KEY_PREFIX}${roomId}`,
    document: `${ROOM_DOCUMENT_KEY_PREFIX}${roomId}`,
    awareness: `${ROOM_AWARENESS_KEY_PREFIX}${roomId}`,
    coordination: `${ROOM_COORDINATION_KEY_PREFIX}${roomId}`,
  };
}

function parsePersistedPlanes(encoded: readonly (string | null)[]): PersistedRoomPlanes | null {
  if (!encoded[0]) return null;
  try {
    return {
      document: JSON.parse(encoded[0]),
      awareness: encoded[1]
        ? JSON.parse(encoded[1])
        : { schemaVersion: 1, participants: {}, spotlight: null },
      coordination: encoded[2]
        ? JSON.parse(encoded[2])
        : {
            schemaVersion: 1,
            stateRevision: JSON.parse(encoded[0]).roomRevision,
            roomRevision: JSON.parse(encoded[0]).roomRevision,
            leases: {},
          },
    } as PersistedRoomPlanes;
  } catch {
    throw new Error("Jazzboard could not decode its persisted room planes.");
  }
}

function parseAwarenessPlane(encoded: string | null): RoomAwarenessPlane | null {
  if (!encoded) return null;
  try {
    return JSON.parse(encoded) as RoomAwarenessPlane;
  } catch {
    throw new Error("Jazzboard could not decode its persisted awareness plane.");
  }
}

function parseCoordinationPlane(encoded: string | null): RoomCoordinationPlane | null {
  if (!encoded) return null;
  try {
    return JSON.parse(encoded) as RoomCoordinationPlane;
  } catch {
    throw new Error("Jazzboard could not decode its persisted coordination plane.");
  }
}

function parseDocumentPlane(encoded: string | null): RoomDocumentPlane | null {
  if (!encoded) return null;
  try {
    return JSON.parse(encoded) as RoomDocumentPlane;
  } catch {
    throw new Error("Jazzboard could not decode its persisted document plane.");
  }
}

function parseLegacyRoom(encoded: string): RoomState {
  try {
    return currentRoomCopy(JSON.parse(encoded) as RoomState);
  } catch {
    throw new Error("Jazzboard could not decode its legacy room snapshot.");
  }
}

function emitCapacitySummary(room: RoomState, summary: ReturnType<typeof evaluateRoomCapacity>): void {
  if (summary.level === "ok") return;
  emitTelemetry({
    event: "capacity.warning",
    level: summary.level === "exceeded" ? "error" : "warn",
    roomHash: hashTelemetryIdentifier(room.id),
    roomRevisionAfter: room.roomRevision,
    capacity: summary,
  });
}

function legacyPlanePersistenceSafety(
  room: RoomState,
): "within-product-capacity" | "grandfathered" | "unsafe-provider-write" {
  const summary = evaluateRoomCapacity(room, { policy: { mode: "enforce" } });
  emitCapacitySummary(room, summary);
  try {
    assertRedisPlaneWriteCapacity(room);
  } catch (error) {
    if (error instanceof DomainError && error.code === "ROOM_CAPACITY_EXCEEDED") {
      return "unsafe-provider-write";
    }
    throw error;
  }
  const planes = splitRoomState(room);
  const migrationTransactionBytes =
    utf8JsonBytes(planes.document) +
    utf8JsonBytes(planes.awareness) +
    utf8JsonBytes(planes.coordination) +
    16 * 1024;
  if (migrationTransactionBytes > REDIS_SAFE_PLANE_WRITE_BYTES) {
    return "unsafe-provider-write";
  }
  return summary.allowed ? "within-product-capacity" : "grandfathered";
}

function normalizeMutationRevisions(
  before: RoomState,
  candidate: RoomState,
): {
  room: RoomState;
  planes: PersistedRoomPlanes;
  documentChanged: boolean;
  awarenessChanged: boolean;
  coordinationChanged: boolean;
  changed: boolean;
} {
  const room = normalizeRoomSemanticState(candidate);
  room.stateRevision ??= room.roomRevision;

  const beforePlanes = splitRoomState(before);
  let nextPlanes = splitRoomState(room);
  const documentChanged =
    documentContentFingerprint(beforePlanes.document) !==
    documentContentFingerprint(nextPlanes.document);
  const awarenessChanged =
    awarenessContentFingerprint(beforePlanes.awareness) !==
    awarenessContentFingerprint(nextPlanes.awareness);
  const coordinationChanged =
    coordinationContentFingerprint(beforePlanes.coordination) !==
    coordinationContentFingerprint(nextPlanes.coordination);
  const changed = documentChanged || awarenessChanged || coordinationChanged;

  if (documentChanged) {
    room.roomRevision = Math.max(before.roomRevision + 1, room.roomRevision);
    if (room.updatedAt <= before.updatedAt) room.updatedAt = Date.now();
  } else {
    room.roomRevision = before.roomRevision;
    room.updatedAt = before.updatedAt;
  }
  room.stateRevision = changed
    ? Math.max((before.stateRevision ?? before.roomRevision) + 1, room.stateRevision)
    : before.stateRevision ?? before.roomRevision;
  nextPlanes = splitRoomState(room);
  return {
    room,
    planes: nextPlanes,
    documentChanged,
    awarenessChanged,
    coordinationChanged,
    changed,
  };
}

function checkMutationCapacity(
  before: RoomState,
  room: RoomState,
  changedPlanes: { document: boolean; awareness: boolean; coordination: boolean },
  activity?: RoomActivity,
): void {
  const input = {
    before,
    after: room,
    changedPlanes,
    activity,
    policy: { mode: capacityModeFromEnvironment() },
  } as const;
  const summary = evaluateRoomMutationCapacity(input);
  emitCapacitySummary(room, summary);
  if (!summary.allowed) assertRoomMutationCapacity(input);
}

function assertSafeChangedPlaneWrites(input: {
  room: RoomState;
  planes: PersistedRoomPlanes;
  document: boolean;
  awareness: boolean;
  coordination: boolean;
  activity?: RoomActivity;
}): void {
  if (input.document) {
    assertRedisPlaneWriteCapacity(input.room);
  } else {
    const checks = [
      ["awarenessBytes", input.awareness ? utf8JsonBytes(input.planes.awareness) : 0],
      ["coordinationBytes", input.coordination ? utf8JsonBytes(input.planes.coordination) : 0],
    ] as const;
    const oversized = checks.filter(([, used]) => used > REDIS_SAFE_PLANE_WRITE_BYTES);
    if (oversized.length) {
      throw new DomainError(
        "ROOM_CAPACITY_EXCEEDED",
        "This Jazzboard plane is too large for a safe Redis write.",
        Object.fromEntries(
          oversized.flatMap(([name, used]) => [
            [`${name}Used`, used],
            [`${name}SafeWriteLimit`, REDIS_SAFE_PLANE_WRITE_BYTES],
          ]),
        ),
      );
    }
  }
  const transactionBytes =
    (input.document ? utf8JsonBytes(input.planes.document) : 0) +
    (input.awareness ? utf8JsonBytes(input.planes.awareness) : 0) +
    (input.coordination ? utf8JsonBytes(input.planes.coordination) : 0) +
    (input.activity ? utf8JsonBytes(input.activity) : 0) +
    // Compact invalidation, receipt, Redis framing, and command names.
    16 * 1024;
  if (transactionBytes > REDIS_SAFE_PLANE_WRITE_BYTES) {
    throw new DomainError(
      "ROOM_CAPACITY_EXCEEDED",
      "This Jazzboard change is too large for one safe atomic Redis transaction.",
      {
        redisTransactionBytesUsed: transactionBytes,
        redisTransactionBytesSafeWriteLimit: REDIS_SAFE_PLANE_WRITE_BYTES,
      },
    );
  }
}

function checkAwarenessMutationCapacity(
  roomId: string,
  roomRevision: number,
  before: RoomAwarenessPlane,
  after: RoomAwarenessPlane,
): void {
  const summary = evaluateAwarenessMutationCapacity({
    before,
    after,
    policy: { mode: capacityModeFromEnvironment() },
  });
  if (
    summary.level !== "ok" &&
    shouldEmitAwarenessCapacityTelemetry(roomId, summary.level)
  ) {
    emitTelemetry({
      event: "capacity.warning",
      level: summary.level === "exceeded" ? "error" : "warn",
      roomHash: hashTelemetryIdentifier(roomId),
      roomRevisionAfter: roomRevision,
      capacity: summary,
    });
  }
  if (!summary.allowed) throw roomCapacityError(summary, summary.blockedMetrics);
  const awarenessBytes = utf8JsonBytes(after);
  if (awarenessBytes > REDIS_SAFE_PLANE_WRITE_BYTES) {
    throw new DomainError(
      "ROOM_CAPACITY_EXCEEDED",
      "This Jazzboard's live-presence state is too large for a safe Redis write.",
      {
        awarenessBytesUsed: awarenessBytes,
        awarenessBytesSafeWriteLimit: REDIS_SAFE_PLANE_WRITE_BYTES,
      },
    );
  }
}

function assertSafeHotPlaneWrites(
  roomId: string,
  roomRevision: number,
  awareness: RoomAwarenessPlane,
  coordination: RoomCoordinationPlane,
): void {
  const awarenessBytes = utf8JsonBytes(awareness);
  const coordinationBytes = utf8JsonBytes(coordination);
  const transactionBytes = awarenessBytes + coordinationBytes + 16 * 1024;
  if (
    awarenessBytes <= REDIS_SAFE_PLANE_WRITE_BYTES &&
    coordinationBytes <= REDIS_SAFE_PLANE_WRITE_BYTES &&
    transactionBytes <= REDIS_SAFE_PLANE_WRITE_BYTES
  ) {
    return;
  }
  emitTelemetry({
    event: "capacity.warning",
    level: "error",
    roomHash: hashTelemetryIdentifier(roomId),
    roomRevisionAfter: roomRevision,
  });
  throw new DomainError(
    "ROOM_CAPACITY_EXCEEDED",
    "This Jazzboard's live-state transaction is too large for a safe Redis write.",
    {
      awarenessBytesUsed: awarenessBytes,
      coordinationBytesUsed: coordinationBytes,
      redisTransactionBytesUsed: transactionBytes,
      redisTransactionBytesSafeWriteLimit: REDIS_SAFE_PLANE_WRITE_BYTES,
    },
  );
}

type RedisPresenceScriptSuccess = {
  delta: RoomPresenceDelta;
  presenceEvent: RoomEvent;
  derivedEvent: RoomEvent | null;
  awarenessBytes: number;
  capacityLevel: "ok" | "warning" | "exceeded";
  roomRevision: number;
};

function redisReplyText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
}

function redisReplyInteger(value: unknown): number | null {
  const candidate = typeof value === "number" ? value : Number(redisReplyText(value));
  return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
}

function parseRedisRoomEvent(value: unknown): RoomEvent | null {
  const encoded = redisReplyText(value);
  if (!encoded) return null;
  try {
    const event = JSON.parse(encoded) as RoomEvent;
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.id !== "string" ||
      typeof event.roomId !== "string" ||
      !Number.isSafeInteger(event.sequence) ||
      typeof event.occurredAt !== "number" ||
      !Number.isFinite(event.occurredAt)
    ) {
      return null;
    }
    return event;
  } catch {
    return null;
  }
}

function parseRedisPresenceSuccess(
  response: readonly unknown[],
  input: PresenceUpdateInput,
): RedisPresenceScriptSuccess | null {
  const presenceEvent = parseRedisRoomEvent(response[1]);
  if (!presenceEvent || presenceEvent.roomId !== input.roomId) return null;
  const delta = presenceDeltaFromEvent(presenceEvent);
  if (
    !delta ||
    delta.participantId !== input.participantId ||
    delta.actorKind !== input.actorKind ||
    delta.stateRevision !== presenceEvent.sequence
  ) {
    return null;
  }

  const derivedEncoded = redisReplyText(response[2]);
  const derivedEvent = derivedEncoded ? parseRedisRoomEvent(derivedEncoded) : null;
  if (
    (derivedEncoded && !derivedEvent) ||
    (derivedEvent &&
      (derivedEvent.roomId !== input.roomId ||
        derivedEvent.sequence + 1 !== delta.stateRevision ||
        !isCompactRoomEventPayloadV3(derivedEvent.payload, derivedEvent.sequence)))
  ) {
    return null;
  }

  const awarenessBytes = redisReplyInteger(response[3]);
  const capacityLevel = redisReplyText(response[4]);
  const roomRevision = redisReplyInteger(response[5]);
  if (
    awarenessBytes === null ||
    (capacityLevel !== "ok" && capacityLevel !== "warning" && capacityLevel !== "exceeded") ||
    roomRevision === null ||
    roomRevision !== delta.roomRevision
  ) {
    return null;
  }
  return {
    delta,
    presenceEvent,
    derivedEvent,
    awarenessBytes,
    capacityLevel,
    roomRevision,
  };
}

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("NOSCRIPT");
}

function redisUsesUpstashKeyLocking(redisUrl = process.env.REDIS_URL): boolean {
  if (!redisUrl) return false;
  try {
    const hostname = new URL(redisUrl).hostname.toLowerCase();
    return hostname === "upstash.io" || hostname.endsWith(".upstash.io");
  } catch {
    return false;
  }
}

async function executeCachedPresenceScript(
  redis: Redis,
  script: string,
  keys: readonly [string, string, string],
  args: readonly (string | number)[],
): Promise<unknown> {
  const sha = redisPresenceScriptSha(script);
  const loaded = loadedPresenceScripts.get(redis) ?? new Set<string>();
  loadedPresenceScripts.set(redis, loaded);
  if (loaded.has(sha)) {
    try {
      return await redis.evalsha(sha, keys.length, ...keys, ...args);
    } catch (error) {
      if (!isNoScriptError(error)) throw error;
      loaded.delete(sha);
    }
  }
  const result = await redis.eval(script, keys.length, ...keys, ...args);
  loaded.add(sha);
  return result;
}

function shouldEmitAwarenessCapacityTelemetry(
  roomId: string,
  level: "warning" | "exceeded",
  now = Date.now(),
): boolean {
  const key = `${roomId}:${level}`;
  const last = awarenessTelemetryWindows.get(key);
  if (last !== undefined && now - last < AWARENESS_TELEMETRY_WINDOW_MS) return false;
  awarenessTelemetryWindows.set(key, now);
  if (awarenessTelemetryWindows.size > 1_024) {
    for (const [candidate, occurredAt] of awarenessTelemetryWindows) {
      if (now - occurredAt >= AWARENESS_TELEMETRY_WINDOW_MS) {
        awarenessTelemetryWindows.delete(candidate);
      }
    }
  }
  return true;
}

function emitAwarenessByteTelemetry(input: {
  roomId: string;
  roomRevision: number;
  awarenessBytes: number;
  level: "warning" | "exceeded";
  outcome: string;
}): void {
  if (!shouldEmitAwarenessCapacityTelemetry(input.roomId, input.level)) return;
  emitTelemetry({
    event: "capacity.warning",
    level: input.level === "exceeded" ? "error" : "warn",
    operation: "presence.capacity",
    outcome: input.outcome,
    roomHash: hashTelemetryIdentifier(input.roomId),
    roomRevisionAfter: input.roomRevision,
    snapshotBytes: input.awarenessBytes,
  });
}

function mutationReceiptFor<T>(
  room: RoomState,
  result: T,
  activity?: RoomActivity,
): CompactMutationReceipt | null {
  const context = currentMutationContext();
  const identity = context?.idempotency;
  if (!identity) return null;
  const record = result !== null && typeof result === "object"
    ? (result as Record<string, unknown>)
    : null;
  const activityRecord = record?.activity && typeof record.activity === "object"
    ? (record.activity as Record<string, unknown>)
    : null;
  const proposalRecord = record?.proposal && typeof record.proposal === "object"
    ? (record.proposal as Record<string, unknown>)
    : null;
  const outcome = typeof record?.outcome === "string" ? record.outcome : "committed";
  return createMutationReceipt({
    identity,
    outcome,
    committedAt: Date.now(),
    committedRoomRevision: room.roomRevision,
    activityId:
      activity?.id ?? (typeof activityRecord?.id === "string" ? activityRecord.id : null),
    proposalId: typeof proposalRecord?.id === "string" ? proposalRecord.id : null,
    resourceId: room.id,
    changedObjectCount: Array.isArray(record?.changedObjectIds)
      ? record.changedObjectIds.length
      : 0,
    changedDiagramCount: Array.isArray(record?.changedDiagramIds)
      ? record.changedDiagramIds.length
      : 0,
  });
}

function committedMutationReplay(receipt: CompactMutationReceipt): DomainError {
  return new DomainError(
    "MUTATION_OUTCOME_UNKNOWN",
    "This mutation already committed, but Jazzboard cannot safely replay its original response. Refresh the authoritative room before deciding whether to continue.",
    {
      replayed: true,
      outcome: receipt.outcome,
      committedRoomRevision: receipt.committedRoomRevision,
    },
  );
}

function mutationVerificationUnavailable(): DomainError {
  return new DomainError(
    "MUTATION_OUTCOME_UNKNOWN",
    "Jazzboard could not verify whether the mutation committed. Refresh authoritative state before deciding whether to continue.",
    { replayed: false, verificationUnavailable: true },
  );
}

function committedMutationVerificationUnavailable(
  receipt: CompactMutationReceipt,
): DomainError {
  return new DomainError(
    "MUTATION_OUTCOME_UNKNOWN",
    "This mutation is proven committed, but Jazzboard cannot currently reconstruct its authoritative response. Refresh state before continuing.",
    {
      replayed: true,
      verificationUnavailable: true,
      outcome: receipt.outcome,
      committedRoomRevision: receipt.committedRoomRevision,
    },
  );
}

function assertRoomReceiptTarget(
  receipt: CompactMutationReceipt,
  roomId: string,
): void {
  if (receipt.resourceIdHash !== sha256(roomId)) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "That Idempotency-Key was already used for a different Jazzboard resource.",
    );
  }
}

function readLocalMutationReceipt(state: LocalState): CompactMutationReceipt | null {
  const identity = currentMutationContext()?.idempotency;
  if (!identity) return null;
  const stored = state.mutationReceipts.get(identity.receiptKey);
  if (!stored) return null;
  if (stored.expiresAt <= Date.now()) {
    state.mutationReceipts.delete(identity.receiptKey);
    return null;
  }
  const receipt = parseMutationReceipt(stored.encoded);
  if (!receipt) {
    throw new DomainError(
      "MUTATION_OUTCOME_UNKNOWN",
      "Jazzboard found an unreadable mutation receipt and will not risk applying the mutation twice.",
    );
  }
  assertReceiptMatches(receipt, identity);
  return receipt;
}

function streamRoomEvent(event: RoomEvent): RoomEvent {
  return compactRoomEvent(event);
}

export function subscribeToLocalRoomEvents(listener: (event: RoomEvent) => void): () => void {
  const bus = localState().bus;
  bus.on("room-event", listener);
  return () => bus.off("room-event", listener);
}

function publishLocal(event: RoomEvent): void {
  localState().bus.emit("room-event", event);
}

function laterPresenceTarget(
  current: Participant["human"] | undefined,
  legacy: Participant["human"] | undefined,
  fallbackAt: number,
): Participant["human"] {
  if (current && legacy) {
    return structuredClone(
      current.lastSeenAt >= legacy.lastSeenAt ? current : legacy,
    );
  }
  return structuredClone(
    current ?? legacy ?? {
      cursor: null,
      viewport: null,
      lastSeenAt: fallbackAt,
      activity: null,
    },
  );
}

function cutoverAwareness(
  document: RoomDocumentPlane,
  current: RoomAwarenessPlane,
  legacy: RoomAwarenessPlane,
  importEphemeral: boolean,
): RoomAwarenessPlane {
  return {
    schemaVersion: current.schemaVersion,
    participants: Object.fromEntries(
      Object.entries(document.participants).map(([participantId, member]) => {
        const currentParticipant = current.participants[participantId];
        const legacyParticipant = legacy.participants[participantId];
        if (!importEphemeral) {
          const retained = currentParticipant ?? legacyParticipant;
          return [
            participantId,
            retained
              ? { ...structuredClone(retained), member: structuredClone(member) }
              : initialParticipantAwareness(member, member.joinedAt),
          ];
        }
        const human = laterPresenceTarget(
          currentParticipant?.human,
          legacyParticipant?.human,
          member.joinedAt,
        );
        const agent = laterPresenceTarget(
          currentParticipant?.agent,
          legacyParticipant?.agent,
          member.joinedAt,
        );
        return [
          participantId,
          {
            member: structuredClone(member),
            lastSeenAt: Math.max(
              human.lastSeenAt,
              agent.lastSeenAt,
              currentParticipant?.lastSeenAt ?? 0,
              legacyParticipant?.lastSeenAt ?? 0,
            ),
            connected: Boolean(
              currentParticipant?.connected || legacyParticipant?.connected,
            ),
            agentActive: Boolean(
              currentParticipant?.agentActive || legacyParticipant?.agentActive,
            ),
            human,
            agent,
          } satisfies ParticipantAwareness,
        ];
      }),
    ),
    spotlight: structuredClone(
      importEphemeral ? legacy.spotlight : current.spotlight,
    ),
  };
}

function activeLeaseUnion(
  current: RoomCoordinationPlane["leases"],
  legacy: RoomCoordinationPlane["leases"],
  now: number,
): RoomCoordinationPlane["leases"] {
  const activeLegacy = Object.fromEntries(
    Object.entries(legacy).filter(([, lease]) => lease.expiresAt > now),
  );
  const activeCurrent = Object.fromEntries(
    Object.entries(current).filter(([, lease]) => lease.expiresAt > now),
  );
  // A v3 lease wins a same-object conflict. Legacy-only leases remain blocking,
  // while an expired v3 lease can never mask a still-active legacy lease.
  return structuredClone({ ...activeLegacy, ...activeCurrent });
}

type LegacyCutover = {
  planes: PersistedRoomPlanes;
  changed: boolean;
  eventType: RoomEvent["type"];
};

function mergeLegacyForRetirement(
  current: PersistedRoomPlanes | null,
  legacyRoom: RoomState,
  importEphemeral: boolean,
  now: number,
): LegacyCutover {
  const legacy = planesFromLegacyRoom(legacyRoom);
  const baseline = current ?? legacy;
  const documentChanged = Boolean(
    current &&
      importEphemeral &&
      documentContentFingerprint(legacy.document) !==
        documentContentFingerprint(current.document),
  );
  const document = documentChanged
    ? {
        ...structuredClone(legacy.document),
        roomRevision: current!.document.roomRevision + 1,
        updatedAt: Math.max(
          legacy.document.updatedAt,
          current!.document.updatedAt + 1,
        ),
      }
    : structuredClone(current?.document ?? legacy.document);
  const awareness = current
    ? cutoverAwareness(
        document,
        current.awareness,
        legacy.awareness,
        importEphemeral,
      )
    : structuredClone(legacy.awareness);
  const leases = current && importEphemeral
    ? activeLeaseUnion(current.coordination.leases, legacy.coordination.leases, now)
    : structuredClone(current?.coordination.leases ?? legacy.coordination.leases);
  const legacyStateRevision = Math.max(
    legacyRoom.stateRevision ?? legacyRoom.roomRevision,
    legacyRoom.roomRevision,
  );
  const baseStateRevision = Math.max(
    current?.coordination.stateRevision ?? legacyStateRevision,
    legacyStateRevision,
    document.roomRevision,
  );
  let planes: PersistedRoomPlanes = {
    document,
    awareness,
    coordination: {
      schemaVersion: current?.coordination.schemaVersion ?? legacy.coordination.schemaVersion,
      stateRevision: baseStateRevision,
      roomRevision: document.roomRevision,
      legacyRetired: true,
      leases,
    },
  };
  const derived = reconcileDerivedState(
    planes.awareness,
    planes.coordination,
    planes.document.roomRevision,
    now,
  );
  if (derived) {
    planes = {
      ...planes,
      awareness: derived.awareness,
      coordination: {
        ...derived.coordination,
        legacyRetired: true,
      },
    };
  }

  const awarenessChanged =
    awarenessContentFingerprint(planes.awareness) !==
    awarenessContentFingerprint(baseline.awareness);
  const coordinationChanged =
    coordinationContentFingerprint(planes.coordination) !==
    coordinationContentFingerprint(baseline.coordination);
  const changed = documentChanged || awarenessChanged || coordinationChanged;
  planes.coordination.stateRevision = changed
    ? baseStateRevision + 1
    : Math.max(
        baseline.coordination.stateRevision,
        baseline.document.roomRevision,
      );
  planes.coordination.roomRevision = planes.document.roomRevision;
  planes.coordination.legacyRetired = true;

  return {
    planes,
    changed,
    eventType: documentChanged
      ? "room.updated"
      : derived?.eventType ??
        (JSON.stringify(planes.awareness.spotlight) !==
        JSON.stringify(baseline.awareness.spotlight)
          ? "spotlight.updated"
          : coordinationChanged
            ? "lease.updated"
            : "presence.updated"),
  };
}

function cutoverInvalidationEvent(
  roomId: string,
  cutover: LegacyCutover,
  now: number,
): RoomEvent {
  return {
    id: randomUUID(),
    roomId,
    sequence: cutover.planes.coordination.stateRevision,
    occurredAt: now,
    type: cutover.eventType,
    actor: null,
    payload: {
      schemaVersion: 3,
      kind: "room.invalidated",
      stateRevision: cutover.planes.coordination.stateRevision,
      roomRevision: cutover.planes.document.roomRevision,
      activityId: null,
    },
  };
}

class MemoryRoomStore implements RoomStore {
  async createRoom(input: {
    participantId: string;
    displayName: string;
    title: string;
  }): Promise<RoomState> {
    const state = localState();
    const identity = currentMutationContext()?.idempotency ?? null;
    const storedReceipt = identity
      ? state.mutationReceipts.get(identity.receiptKey)
      : null;
    if (storedReceipt?.expiresAt !== undefined && storedReceipt.expiresAt <= Date.now()) {
      state.mutationReceipts.delete(identity!.receiptKey);
    }
    const generation = roomCreateGenerationFromReceipt(
      storedReceipt && storedReceipt.expiresAt > Date.now()
        ? storedReceipt.encoded
        : null,
    );
    if (generation) {
      const stored = state.rooms.get(generation.roomId);
      const room = stored
        ? currentRoomCopy(composeRoomState(normalizedLocalPlanes(stored)))
        : null;
      if (
        !room ||
        room.createdAt !== generation.receipt.committedAt ||
        !room.participants[input.participantId] ||
        state.codes.get(room.code) !== room.id
      ) {
        throw missingCreatedRoomError();
      }
      markCurrentMutationReplayed();
      return room;
    }
    let code = "";
    do code = randomInt(0, 10_000).toString().padStart(4, "0");
    while (state.codes.has(code));

    const now = Date.now();
    const room: RoomState = {
      id: identity
        ? roomIdFromMutationGeneration(identity.scopedKeyHash, now)
        : `room_${randomUUID()}`,
      code,
      title: input.title,
      stateRevision: 1,
      roomRevision: 1,
      createdAt: now,
      updatedAt: now,
      participants: {
        [input.participantId]: makeParticipant({
          ...input,
          role: "participant",
          color: COLORS[0],
          now,
        }),
      },
      objects: {},
      diagrams: {},
      leases: {},
      spotlight: null,
      agentEditPolicy: "live",
      reviewProposals: [],
    };
    state.rooms.set(room.id, splitRoomState(room));
    state.codes.set(code, room.id);
    const receipt = roomCreationReceipt(room);
    if (receipt) {
      const identity = currentMutationContext()!.idempotency!;
      state.mutationReceipts.set(identity.receiptKey, {
        expiresAt: Date.now() + IDEMPOTENCY_RECEIPT_TTL_SECONDS * 1_000,
        encoded: serializeMutationReceipt(receipt),
      });
    }
    publishLocal(
      roomEvent(room, "room.snapshot", actorFor(room.participants[input.participantId], "human")),
    );
    return room;
  }

  async joinRoom(input: {
    participantId: string;
    displayName: string;
    code: string;
    role: RoomRole;
  }): Promise<RoomState> {
    const roomId = localState().codes.get(input.code);
    if (!roomId) throw new DomainError("ROOM_NOT_FOUND", "No Jazzboard exists with that code.");
    return this.transact(
      roomId,
      (room) => {
        const now = Date.now();
        const existing = room.participants[input.participantId];
        room.participants[input.participantId] = existing
          ? {
              ...existing,
              displayName: input.displayName,
              role: input.role,
              connected: true,
              lastSeenAt: now,
            }
          : makeParticipant({ ...input, color: availableColor(room), now });
        room.roomRevision += 1;
        room.updatedAt = now;
        return {
          room,
          result: room,
          eventActor: actorFor(room.participants[input.participantId], "human"),
        };
      },
      "presence.updated",
    ).catch(async (error) => {
      const committedRoomRevision = verifiedCommittedRoomRevision(error);
      if (committedRoomRevision !== null) {
        let current: RoomState | null;
        try {
          current = await this.getRoom(roomId);
        } catch {
          throw error;
        }
        if (
          joinedParticipantMatches(current, input) &&
          current.roomRevision >= committedRoomRevision
        ) {
          markCurrentMutationReplayed();
          return current;
        }
      }
      throw error;
    });
  }

  async getRoom(roomId: string): Promise<RoomState | null> {
    const state = localState();
    const previous = state.queues.get(roomId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    state.queues.set(roomId, queued);
    await previous;
    try {
      const stored = state.rooms.get(roomId);
      if (!stored) return null;
      let planes = normalizedLocalPlanes(stored);
      const now = Date.now();
      const reconciliation = reconcileDerivedState(
        planes.awareness,
        planes.coordination,
        planes.document.roomRevision,
        now,
      );
      if (reconciliation) {
        planes = {
          ...planes,
          awareness: reconciliation.awareness,
          coordination: reconciliation.coordination,
        };
        state.rooms.set(roomId, planes);
        publishLocal(derivedStateEvent(roomId, reconciliation, now));
      }
      return currentRoomCopy(composeRoomState(planes));
    } finally {
      release();
      if (state.queues.get(roomId) === queued) state.queues.delete(roomId);
    }
  }

  async getRoomByCode(code: string): Promise<RoomState | null> {
    const roomId = localState().codes.get(code);
    return roomId ? this.getRoom(roomId) : null;
  }

  async listActivities(roomId: string): Promise<RoomActivitySummary[]> {
    const state = localState();
    await ensureLocalActivityHistory(state);
    return new MemoryActivityHistoryStore(state.activityHistory).listActivitySummaries(
      roomId,
      { limit: 200 },
    );
  }

  async getActivity(roomId: string, activityId: string): Promise<RoomActivity | null> {
    const state = localState();
    await ensureLocalActivityHistory(state);
    return new MemoryActivityHistoryStore(state.activityHistory).getActivity(roomId, activityId);
  }

  async updatePresence(input: PresenceUpdateInput): Promise<RoomPresenceDelta> {
    const state = localState();
    const previous = state.queues.get(input.roomId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    state.queues.set(input.roomId, queued);
    await previous;
    try {
      const stored = state.rooms.get(input.roomId);
      if (!stored) throw new DomainError("ROOM_NOT_FOUND", "This Jazzboard no longer exists.");
      let current = normalizedLocalPlanes(stored);
      const now = Date.now();
      const reconciliation = reconcileDerivedState(
        current.awareness,
        current.coordination,
        current.document.roomRevision,
        now,
      );
      if (reconciliation) {
        current = {
          ...current,
          awareness: reconciliation.awareness,
          coordination: reconciliation.coordination,
        };
        state.rooms.set(input.roomId, current);
        publishLocal(derivedStateEvent(input.roomId, reconciliation, now));
      }
      const updated = applyPresenceUpdateToPlanes(current, input, now);
      checkAwarenessMutationCapacity(
        input.roomId,
        updated.delta.roomRevision,
        current.awareness,
        updated.planes.awareness,
      );
      state.rooms.set(input.roomId, updated.planes);
      publishLocal(updated.event);
      return updated.delta;
    } finally {
      release();
      if (state.queues.get(input.roomId) === queued) state.queues.delete(input.roomId);
    }
  }

  async assertMutationNotReplayed(roomId: string): Promise<void> {
    const receipt = readLocalMutationReceipt(localState());
    if (!receipt) return;
    assertRoomReceiptTarget(receipt, roomId);
    throw committedMutationReplay(receipt);
  }

  async transact<T>(
    roomId: string,
    updater: RoomUpdater<T>,
    eventType: RoomEvent["type"] = "room.updated",
  ): Promise<T> {
    const state = localState();
    const identity = currentMutationContext()?.idempotency ?? null;
    return withLocalMutationReceiptLock(
      identity?.receiptKey ?? null,
      async () => {
    const previous = state.queues.get(roomId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    state.queues.set(roomId, queued);
    await previous;
    try {
      await ensureLocalActivityHistory(state);
      const replay = readLocalMutationReceipt(state);
      if (replay) {
        assertRoomReceiptTarget(replay, roomId);
        throw committedMutationReplay(replay);
      }
      const stored = state.rooms.get(roomId);
      if (!stored) throw new DomainError("ROOM_NOT_FOUND", "This Jazzboard no longer exists.");
      let planes = normalizedLocalPlanes(stored);
      const now = Date.now();
      const reconciliation = reconcileDerivedState(
        planes.awareness,
        planes.coordination,
        planes.document.roomRevision,
        now,
      );
      if (reconciliation) {
        planes = {
          ...planes,
          awareness: reconciliation.awareness,
          coordination: reconciliation.coordination,
        };
        state.rooms.set(roomId, planes);
        publishLocal(derivedStateEvent(roomId, reconciliation, now));
      }
      const before = currentRoomCopy(composeRoomState(planes));
      const updated = updater(structuredClone(before));
      const mutation = normalizeMutationRevisions(before, updated.room);
      await assertLocalPrivateBlobReferences(
        roomId,
        introducedPrivateBlobPathnames(before, mutation.room),
      );
      checkMutationCapacity(
        before,
        mutation.room,
        {
          document: mutation.documentChanged,
          awareness: mutation.awarenessChanged,
          coordination: mutation.coordinationChanged,
        },
        updated.activity,
      );
      const receipt = mutationReceiptFor(mutation.room, updated.result, updated.activity);
      const receiptWrite = receipt
        ? {
            key: currentMutationContext()!.idempotency!.receiptKey,
            value: {
              expiresAt: Date.now() + IDEMPOTENCY_RECEIPT_TTL_SECONDS * 1_000,
              encoded: serializeMutationReceipt(receipt),
            },
          }
        : null;
      const nextHistory = updated.activity
        ? structuredClone(state.activityHistory)
        : state.activityHistory;
      if (updated.activity) {
        await new MemoryActivityHistoryStore(nextHistory).appendActivity(updated.activity);
      }
      state.rooms.set(roomId, mutation.planes);
      if (updated.activity) state.activityHistory = nextHistory;
      if (receiptWrite) {
        state.mutationReceipts.set(receiptWrite.key, receiptWrite.value);
      }
      if (mutation.changed || updated.activity) {
        publishLocal(
          roomEvent(
            mutation.room,
            eventType,
            updated.eventActor,
            updated.activity ?? null,
          ),
        );
      }
      return updated.result;
    } finally {
      release();
      if (state.queues.get(roomId) === queued) state.queues.delete(roomId);
    }
      },
    );
  }
}

function redisClient(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) {
    if (process.env.VERCEL === "1") {
      throw new Error("REDIS_URL is required for deployed Jazzboard rooms; process-local state is development-only.");
    }
    return null;
  }
  if (globalThis.__jazzboardRedis !== undefined) return globalThis.__jazzboardRedis;
  globalThis.__jazzboardRedis = new Redis(url, {
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  return globalThis.__jazzboardRedis;
}

export class RedisRoomStore implements RoomStore {
  private readonly activityHistory: RedisActivityHistoryStore;

  constructor(private readonly redis: Redis) {
    this.activityHistory = new RedisActivityHistoryStore(redis);
  }

  private async readOrMigratePlanes(
    connection: Redis,
    roomId: string,
  ): Promise<RoomPlaneRead | null> {
    const keys = roomPlaneKeys(roomId);
    const fastEncoded = await connection.mget(
      keys.document,
      keys.awareness,
      keys.coordination,
    );
    const fastCurrent = parsePersistedPlanes(fastEncoded);
    if (
      fastEncoded.every(Boolean) &&
      fastCurrent?.coordination.legacyRetired
    ) {
      return { planes: fastCurrent, persisted: true };
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await connection.watch(keys.legacy, keys.document, keys.awareness, keys.coordination);
      const [encoded, legacyTtl] = await Promise.all([
        connection.mget(
          keys.document,
          keys.awareness,
          keys.coordination,
          keys.legacy,
        ),
        connection.ttl(keys.legacy),
      ]);
      const current = parsePersistedPlanes(encoded.slice(0, 3));
      const legacyEncoded = encoded[3];
      if (!current && !legacyEncoded) {
        await connection.unwatch();
        return null;
      }
      if (
        encoded[0] &&
        encoded[1] &&
        encoded[2] &&
        current?.coordination.legacyRetired
      ) {
        await connection.unwatch();
        return { planes: current, persisted: true };
      }

      let cutover: LegacyCutover;
      if (!legacyEncoded) {
        const planes = structuredClone(current!);
        planes.coordination.legacyRetired = true;
        cutover = { planes, changed: false, eventType: "room.updated" };
      } else if (
        current &&
        encoded[0] &&
        encoded[1] &&
        encoded[2] &&
        legacyTtl !== -1
      ) {
        // A positive TTL was the previous v3 writer's fence. Its aggregate is
        // therefore only a stale mirror; retire it without importing ephemeral
        // state or advancing the room watermark.
        const planes = structuredClone(current);
        planes.coordination.legacyRetired = true;
        cutover = { planes, changed: false, eventType: "room.updated" };
      } else {
        const legacy = parseLegacyRoom(legacyEncoded);
        if (
          legacy.id !== roomId ||
          (current && legacy.code !== current.document.code)
        ) {
          await connection.unwatch();
          throw new DomainError(
            "MUTATION_OUTCOME_UNKNOWN",
            "Jazzboard cannot safely retire an inconsistent legacy room record.",
          );
        }
        cutover = mergeLegacyForRetirement(
          current,
          legacy,
          true,
          Date.now(),
        );
      }

      const writesDocument =
        !encoded[0] ||
        !current ||
        documentContentFingerprint(current.document) !==
          documentContentFingerprint(cutover.planes.document);
      const writesAwareness =
        !encoded[1] ||
        !current ||
        awarenessContentFingerprint(current.awareness) !==
          awarenessContentFingerprint(cutover.planes.awareness);
      const writesCoordination = true;
      if (
        (!current || writesDocument) &&
        legacyPlanePersistenceSafety(composeRoomState(cutover.planes)) ===
          "unsafe-provider-write"
      ) {
        await connection.unwatch();
        throw new DomainError(
          "ROOM_CAPACITY_EXCEEDED",
          "This legacy Jazzboard is too large to retire into safe Redis planes.",
        );
      }
      assertSafeChangedPlaneWrites({
        room: composeRoomState(cutover.planes),
        planes: cutover.planes,
        document: writesDocument,
        awareness: writesAwareness,
        coordination: writesCoordination,
      });

      const event = cutover.changed
        ? cutoverInvalidationEvent(roomId, cutover, Date.now())
        : null;
      const transaction = connection.multi();
      if (writesDocument) {
        transaction.set(keys.document, JSON.stringify(cutover.planes.document));
      }
      if (writesAwareness) {
        transaction.set(keys.awareness, JSON.stringify(cutover.planes.awareness));
      }
      transaction.set(
        keys.coordination,
        JSON.stringify(cutover.planes.coordination),
      );
      if (legacyEncoded) transaction.del(keys.legacy);
      if (event) {
        transaction.xadd(
          EVENT_STREAM,
          "MAXLEN",
          "~",
          20_000,
          "*",
          "roomId",
          roomId,
          "data",
          JSON.stringify(event),
        );
      }
      const committed = await transaction.exec();
      if (committed) {
        if (event) publishLocal(event);
        return { planes: cutover.planes, persisted: true };
      }
    }
    throw new DomainError(
      "REVISION_CONFLICT",
      "The room changed too quickly while Jazzboard retired legacy storage.",
    );
  }

  /**
   * Cold repair for records written before live-plane authorization mirrors
   * were complete. The repaired fields are internal fences only, so this CAS
   * does not advance client-visible state. Every subsequent presence commit
   * remains document-free.
   */
  private async repairPresenceHotPath(
    roomId: string,
    participantId: string,
  ): Promise<void> {
    const connection = this.redis.duplicate();
    const keys = roomPlaneKeys(roomId);
    try {
      const migrated = await this.readOrMigratePlanes(connection, roomId);
      if (!migrated) {
        throw new DomainError("ROOM_NOT_FOUND", "This Jazzboard no longer exists.");
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await connection.watch(keys.document, keys.awareness, keys.coordination);
        const encoded = await connection.mget(
          keys.document,
          keys.awareness,
          keys.coordination,
        );
        const document = parseDocumentPlane(encoded[0]);
        const awareness = parseAwarenessPlane(encoded[1]);
        const coordination = parseCoordinationPlane(encoded[2]);
        if (!document || !awareness || !coordination?.legacyRetired) {
          await connection.unwatch();
          throw new DomainError(
            "MUTATION_OUTCOME_UNKNOWN",
            "Jazzboard cannot safely repair this room's live-presence index.",
          );
        }
        const member = document.participants[participantId];
        if (!member) {
          await connection.unwatch();
          throw new DomainError("FORBIDDEN", "This guest session is not a member of the room.");
        }
        if (
          coordination.roomRevision !== undefined &&
          coordination.roomRevision !== document.roomRevision
        ) {
          await connection.unwatch();
          throw new DomainError(
            "MUTATION_OUTCOME_UNKNOWN",
            "Jazzboard found an inconsistent durable-document fence for live presence.",
          );
        }

        let writesAwareness = false;
        const nextAwareness = structuredClone(awareness);
        const currentParticipant = nextAwareness.participants[participantId];
        if (!currentParticipant) {
          const seeded = initialParticipantAwareness(member, member.joinedAt);
          seeded.connected = false;
          nextAwareness.participants[participantId] = seeded;
          writesAwareness = true;
        } else if (
          JSON.stringify(currentParticipant.member) !== JSON.stringify(member)
        ) {
          currentParticipant.member = structuredClone(member);
          writesAwareness = true;
        }
        const writesCoordination = coordination.roomRevision === undefined;
        const nextCoordination = writesCoordination
          ? { ...coordination, roomRevision: document.roomRevision }
          : coordination;
        if (!writesAwareness && !writesCoordination) {
          await connection.unwatch();
          return;
        }

        if (writesAwareness) {
          checkAwarenessMutationCapacity(
            roomId,
            document.roomRevision,
            awareness,
            nextAwareness,
          );
        }
        assertSafeHotPlaneWrites(
          roomId,
          document.roomRevision,
          nextAwareness,
          nextCoordination,
        );
        const transaction = connection.multi();
        if (writesAwareness) {
          transaction.set(keys.awareness, JSON.stringify(nextAwareness));
        }
        if (writesCoordination) {
          transaction.set(keys.coordination, JSON.stringify(nextCoordination));
        }
        if (await transaction.exec()) return;
      }
      throw new DomainError(
        "REVISION_CONFLICT",
        "The room changed too quickly while Jazzboard repaired live presence.",
      );
    } finally {
      await connection.quit().catch(() => undefined);
    }
  }

  private async reconcileDerivedPlanes(
    connection: Redis,
    roomId: string,
    initial: PersistedRoomPlanes,
  ): Promise<PersistedRoomPlanes> {
    const keys = roomPlaneKeys(roomId);
    let document = initial.document;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await connection.watch(keys.awareness, keys.coordination);
      const [awarenessEncoded, coordinationEncoded] = await connection.mget(
        keys.awareness,
        keys.coordination,
      );
      const awareness = parseAwarenessPlane(awarenessEncoded);
      const coordination = parseCoordinationPlane(coordinationEncoded);
      if (!awareness || !coordination) {
        await connection.unwatch();
        const read = await this.readOrMigratePlanes(connection, roomId);
        if (!read) throw new DomainError("ROOM_NOT_FOUND", "This Jazzboard no longer exists.");
        document = read.planes.document;
        continue;
      }
      if (
        coordination.roomRevision !== undefined &&
        coordination.roomRevision !== document.roomRevision
      ) {
        await connection.unwatch();
        const read = await this.readOrMigratePlanes(connection, roomId);
        if (!read) throw new DomainError("ROOM_NOT_FOUND", "This Jazzboard no longer exists.");
        document = read.planes.document;
        continue;
      }

      const reconciliation = reconcileDerivedState(
        awareness,
        coordination,
        document.roomRevision,
        Date.now(),
      );
      if (!reconciliation) {
        await connection.unwatch();
        return { document, awareness, coordination };
      }
      checkAwarenessMutationCapacity(
        roomId,
        document.roomRevision,
        awareness,
        reconciliation.awareness,
      );
      assertSafeHotPlaneWrites(
        roomId,
        document.roomRevision,
        reconciliation.awareness,
        reconciliation.coordination,
      );
      const event = derivedStateEvent(roomId, reconciliation, Date.now());
      const committed = await connection
        .multi()
        .set(keys.awareness, JSON.stringify(reconciliation.awareness))
        .set(keys.coordination, JSON.stringify(reconciliation.coordination))
        .xadd(
          EVENT_STREAM,
          "MAXLEN",
          "~",
          20_000,
          "*",
          "roomId",
          roomId,
          "data",
          JSON.stringify(event),
        )
        .exec();
      if (!committed) continue;
      publishLocal(event);
      return {
        document,
        awareness: reconciliation.awareness,
        coordination: reconciliation.coordination,
      };
    }
    throw new DomainError(
      "REVISION_CONFLICT",
      "The room changed too quickly while Jazzboard reconciled live state.",
    );
  }

  private async replayCreatedRoom(
    encodedReceipt: string | null,
    participantId: string,
  ): Promise<RoomState | null> {
    const generation = roomCreateGenerationFromReceipt(encodedReceipt);
    if (!generation) return null;
    let room: RoomState | null;
    let mappedRoomId: string | null = null;
    try {
      room = await this.getRoom(generation.roomId);
      if (room) mappedRoomId = await this.redis.get(`${CODE_KEY_PREFIX}${room.code}`);
    } catch {
      throw committedMutationVerificationUnavailable(generation.receipt);
    }
    if (
      !room ||
      room.createdAt !== generation.receipt.committedAt ||
      !room.participants[participantId] ||
      mappedRoomId !== room.id
    ) {
      throw missingCreatedRoomError();
    }
    markCurrentMutationReplayed();
    return room;
  }

  async createRoom(input: {
    participantId: string;
    displayName: string;
    title: string;
  }): Promise<RoomState> {
    const identity = currentMutationContext()?.idempotency ?? null;
    const now = Date.now();
    if (identity) {
      let encodedReceipt: string | null;
      try {
        encodedReceipt = await this.redis.get(identity.receiptKey);
      } catch {
        throw mutationVerificationUnavailable();
      }
      const replay = await this.replayCreatedRoom(
        encodedReceipt,
        input.participantId,
      );
      if (replay) return replay;
    }
    const roomId = identity
      ? roomIdFromMutationGeneration(identity.scopedKeyHash, now)
      : `room_${randomUUID()}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = randomInt(0, 10_000).toString().padStart(4, "0");
      const room: RoomState = {
        id: roomId,
        code,
        title: input.title,
        stateRevision: 1,
        roomRevision: 1,
        createdAt: now,
        updatedAt: now,
        participants: {
          [input.participantId]: makeParticipant({
            ...input,
            role: "participant",
            color: COLORS[0],
            now,
          }),
        },
        objects: {},
        diagrams: {},
        leases: {},
        spotlight: null,
        agentEditPolicy: "live",
        reviewProposals: [],
      };
      const event = roomEvent(
        room,
        "room.snapshot",
        actorFor(room.participants[input.participantId], "human"),
      );
      const planes = splitRoomState(room);
      const receipt = roomCreationReceipt(room);
      let rawResult: unknown;
      try {
        rawResult = await this.redis.eval(
          identity ? CREATE_IDEMPOTENT_REDIS_ROOM_SCRIPT : CREATE_REDIS_ROOM_SCRIPT,
          identity ? 6 : 5,
          `${CODE_KEY_PREFIX}${code}`,
          `${ROOM_DOCUMENT_KEY_PREFIX}${room.id}`,
          `${ROOM_AWARENESS_KEY_PREFIX}${room.id}`,
          `${ROOM_COORDINATION_KEY_PREFIX}${room.id}`,
          EVENT_STREAM,
          ...(identity ? [identity.receiptKey] : []),
          roomId,
          JSON.stringify(planes.document),
          JSON.stringify(planes.awareness),
          JSON.stringify(planes.coordination),
          JSON.stringify(streamRoomEvent(event)),
          ...(identity && receipt
            ? [serializeMutationReceipt(receipt), IDEMPOTENCY_RECEIPT_TTL_SECONDS]
            : []),
        );
      } catch (error) {
        if (identity) {
          let encodedReceipt: string | null;
          try {
            encodedReceipt = await this.redis.get(identity.receiptKey);
          } catch {
            throw mutationVerificationUnavailable();
          }
          const recovered = await this.replayCreatedRoom(encodedReceipt, input.participantId);
          if (recovered) return recovered;
        }
        throw error;
      }
      const result = Array.isArray(rawResult) ? rawResult : [];
      const outcome = result[0];
      if (outcome === "replay" && identity) {
        const replay = await this.replayCreatedRoom(
          typeof result[1] === "string" ? result[1] : null,
          input.participantId,
        );
        if (replay) return replay;
        throw missingCreatedRoomError();
      }
      if (outcome === "code_conflict") continue;
      if (outcome === "orphan") throw missingCreatedRoomError();
      if (outcome !== "created") {
        if (identity) {
          let encodedReceipt: string | null;
          try {
            encodedReceipt = await this.redis.get(identity.receiptKey);
          } catch {
            throw mutationVerificationUnavailable();
          }
          const recovered = await this.replayCreatedRoom(
            encodedReceipt,
            input.participantId,
          );
          if (recovered) return recovered;
        }
        throw new DomainError(
          "MUTATION_OUTCOME_UNKNOWN",
          "Jazzboard could not verify the outcome of this room creation.",
        );
      }
      publishLocal(event);
      return room;
    }
    throw new Error("Unable to allocate a unique room code.");
  }

  async joinRoom(input: {
    participantId: string;
    displayName: string;
    code: string;
    role: RoomRole;
  }): Promise<RoomState> {
    const roomId = await this.redis.get(`${CODE_KEY_PREFIX}${input.code}`);
    if (!roomId) throw new DomainError("ROOM_NOT_FOUND", "No Jazzboard exists with that code.");
    return this.transact(
      roomId,
      (room) => {
        const now = Date.now();
        const existing = room.participants[input.participantId];
        room.participants[input.participantId] = existing
          ? {
              ...existing,
              displayName: input.displayName,
              role: input.role,
              connected: true,
              lastSeenAt: now,
            }
          : makeParticipant({ ...input, color: availableColor(room), now });
        room.roomRevision += 1;
        room.updatedAt = now;
        return {
          room,
          result: room,
          eventActor: actorFor(room.participants[input.participantId], "human"),
        };
      },
      "presence.updated",
    ).catch(async (error) => {
      const committedRoomRevision = verifiedCommittedRoomRevision(error);
      if (committedRoomRevision !== null) {
        let current: RoomState | null;
        try {
          current = await this.getRoom(roomId);
        } catch {
          throw error;
        }
        if (
          joinedParticipantMatches(current, input) &&
          current.roomRevision >= committedRoomRevision
        ) {
          markCurrentMutationReplayed();
          return current;
        }
      }
      throw error;
    });
  }

  async getRoom(roomId: string): Promise<RoomState | null> {
    const connection = this.redis.duplicate();
    try {
      const read = await this.readOrMigratePlanes(connection, roomId);
      if (!read) return null;
      const planes = read.persisted
        ? await this.reconcileDerivedPlanes(connection, roomId, read.planes)
        : read.planes;
      return currentRoomCopy(composeRoomState(planes));
    } finally {
      await connection.quit().catch(() => undefined);
    }
  }

  async getRoomByCode(code: string): Promise<RoomState | null> {
    const roomId = await this.redis.get(`${CODE_KEY_PREFIX}${code}`);
    return roomId ? this.getRoom(roomId) : null;
  }

  async listActivities(roomId: string): Promise<RoomActivitySummary[]> {
    // Each access advances at most a bounded migration batch. New mutations
    // never write the legacy list, so repeated authorized reads converge and
    // the final batch atomically retires the old key.
    await this.activityHistory.migrateLegacyActivities(roomId);
    return this.activityHistory.listActivitySummaries(roomId, { limit: 200 });
  }

  async getActivity(roomId: string, activityId: string): Promise<RoomActivity | null> {
    let activity = await this.activityHistory.getActivity(roomId, activityId);
    if (activity) return activity;
    const migration = await this.activityHistory.migrateLegacyActivities(roomId);
    activity = await this.activityHistory.getActivity(roomId, activityId);
    if (activity || migration.status === "complete") return activity;
    return null;
  }

  async updatePresence(input: PresenceUpdateInput): Promise<RoomPresenceDelta> {
    const keys = roomPlaneKeys(input.roomId);
    const script = redisPresenceScript(redisUsesUpstashKeyLocking());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const now = Date.now();
      const raw = await executeCachedPresenceScript(
        this.redis,
        script,
        [keys.awareness, keys.coordination, EVENT_STREAM],
        [
          input.roomId,
          input.participantId,
          input.actorKind,
          now,
          JSON.stringify({
            cursor: input.cursor,
            viewport: input.viewport,
            activity: input.activity,
          }),
          PRESENCE_AWAY_MS,
          capacityModeFromEnvironment(),
          DEFAULT_CAPACITY_LIMITS.awarenessBytes,
          Math.floor(
            DEFAULT_CAPACITY_LIMITS.awarenessBytes * DEFAULT_CAPACITY_WARNING_RATIO,
          ),
          REDIS_SAFE_PLANE_WRITE_BYTES,
          randomUUID(),
          randomUUID(),
        ],
      );
      if (!Array.isArray(raw) || !redisReplyText(raw[0])) {
        throw new DomainError(
          "MUTATION_OUTCOME_UNKNOWN",
          "Jazzboard received an invalid atomic presence result.",
        );
      }
      const status = redisReplyText(raw[0]);
      if (status === "ok") {
        const committed = parseRedisPresenceSuccess(raw, input);
        if (!committed) {
          throw new DomainError(
            "MUTATION_OUTCOME_UNKNOWN",
            "Jazzboard could not validate its committed presence event.",
          );
        }
        if (committed.capacityLevel !== "ok") {
          emitAwarenessByteTelemetry({
            roomId: input.roomId,
            roomRevision: committed.roomRevision,
            awarenessBytes: committed.awarenessBytes,
            level: committed.capacityLevel,
            outcome: "allowed",
          });
        }
        if (committed.derivedEvent) publishLocal(committed.derivedEvent);
        publishLocal(committed.presenceEvent);
        return committed.delta;
      }
      if (status === "not_found" || status === "repair_required") {
        if (attempt === 0) {
          await this.repairPresenceHotPath(input.roomId, input.participantId);
          continue;
        }
        throw new DomainError(
          status === "not_found" ? "ROOM_NOT_FOUND" : "MUTATION_OUTCOME_UNKNOWN",
          status === "not_found"
            ? "This Jazzboard no longer exists."
            : "Jazzboard could not establish a safe live-presence index.",
        );
      }
      if (status === "forbidden") {
        throw new DomainError(
          "FORBIDDEN",
          input.actorKind === "agent"
            ? "Spectators cannot publish agent presence."
            : "This guest session is not authorized for the room.",
        );
      }
      if (status === "capacity") {
        const awarenessBytes = redisReplyInteger(raw[3]) ?? 0;
        const roomRevision = redisReplyInteger(raw[8]) ?? 0;
        emitAwarenessByteTelemetry({
          roomId: input.roomId,
          roomRevision,
          awarenessBytes,
          level: "exceeded",
          outcome: "blocked",
        });
        throw new DomainError(
          "ROOM_CAPACITY_EXCEEDED",
          "This Jazzboard's live-presence state is too large for a safe Redis write.",
          {
            awarenessBytesBefore: redisReplyInteger(raw[2]) ?? 0,
            awarenessBytesUsed: awarenessBytes,
            awarenessBytesLimit: redisReplyInteger(raw[4]) ?? 0,
            coordinationBytesUsed: redisReplyInteger(raw[5]) ?? 0,
            redisTransactionBytesUsed: redisReplyInteger(raw[6]) ?? 0,
            redisTransactionBytesSafeWriteLimit: redisReplyInteger(raw[7]) ?? 0,
          },
        );
      }
      if (status === "corrupt" || status === "provider_error") {
        throw new DomainError(
          "MUTATION_OUTCOME_UNKNOWN",
          status === "corrupt"
            ? "Jazzboard found malformed live-presence state and did not overwrite it."
            : "Jazzboard could not safely complete its atomic presence write.",
        );
      }
      throw new DomainError(
        "MUTATION_OUTCOME_UNKNOWN",
        "Jazzboard received an unknown atomic presence result.",
      );
    }
    throw new DomainError(
      "MUTATION_OUTCOME_UNKNOWN",
      "Jazzboard could not safely update live presence.",
    );
  }

  async assertMutationNotReplayed(roomId: string): Promise<void> {
    const identity = currentMutationContext()?.idempotency ?? null;
    if (!identity) return;
    let encodedReceipt: string | null;
    try {
      encodedReceipt = await this.redis.get(identity.receiptKey);
    } catch {
      throw mutationVerificationUnavailable();
    }
    if (!encodedReceipt) return;
    const receipt = parseMutationReceipt(encodedReceipt);
    if (!receipt) {
      throw new DomainError(
        "MUTATION_OUTCOME_UNKNOWN",
        "Jazzboard found an unreadable mutation receipt and will not risk applying the mutation twice.",
      );
    }
    assertReceiptMatches(receipt, identity);
    assertRoomReceiptTarget(receipt, roomId);
    throw committedMutationReplay(receipt);
  }

  async transact<T>(
    roomId: string,
    updater: RoomUpdater<T>,
    eventType: RoomEvent["type"] = "room.updated",
  ): Promise<T> {
    const connection = this.redis.duplicate();
    const keys = roomPlaneKeys(roomId);
    const identity = currentMutationContext()?.idempotency ?? null;
    try {
      const initial = await this.readOrMigratePlanes(connection, roomId);
      if (!initial) throw new DomainError("ROOM_NOT_FOUND", "This Jazzboard no longer exists.");
      for (let attempt = 0; attempt < ROOM_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
        await connection.watch(
          keys.document,
          keys.awareness,
          keys.coordination,
          ...(identity ? [identity.receiptKey] : []),
        );
        const [encoded, encodedReceipt] = await Promise.all([
          connection.mget(keys.document, keys.awareness, keys.coordination),
          identity ? connection.get(identity.receiptKey) : Promise.resolve(null),
        ]);
        if (identity && encodedReceipt) {
          await connection.unwatch();
          const receipt = parseMutationReceipt(encodedReceipt);
          if (!receipt) {
            throw new DomainError(
              "MUTATION_OUTCOME_UNKNOWN",
              "Jazzboard found an unreadable mutation receipt and will not risk applying the mutation twice.",
            );
          }
          assertReceiptMatches(receipt, identity);
          assertRoomReceiptTarget(receipt, roomId);
          throw committedMutationReplay(receipt);
        }
        const persisted = parsePersistedPlanes(encoded);
        if (!persisted) {
          await connection.unwatch();
          throw new DomainError("ROOM_NOT_FOUND", "This Jazzboard no longer exists.");
        }
        if (!persisted.coordination.legacyRetired) {
          await connection.unwatch();
          const retired = await this.readOrMigratePlanes(connection, roomId);
          if (!retired) {
            throw new DomainError("ROOM_NOT_FOUND", "This Jazzboard no longer exists.");
          }
          continue;
        }
        const basePlanes = persisted;
        const persistedBefore = currentRoomCopy(composeRoomState(basePlanes));
        const derived = reconcileDerivedState(
          basePlanes.awareness,
          basePlanes.coordination,
          basePlanes.document.roomRevision,
          Date.now(),
        );
        const before = derived
          ? currentRoomCopy(composeRoomState({
              ...basePlanes,
              awareness: derived.awareness,
              coordination: derived.coordination,
            }))
          : persistedBefore;
        const updated = updater(structuredClone(before));
        const mutation = normalizeMutationRevisions(persistedBefore, updated.room);
        const privateBlobReferenceGuards = await readRedisPrivateBlobReferenceGuards(
          connection,
          roomId,
          introducedPrivateBlobPathnames(before, mutation.room),
        );
        const changedPlanes = {
          document: mutation.documentChanged,
          awareness: mutation.awarenessChanged,
          coordination: mutation.coordinationChanged,
        };
        checkMutationCapacity(persistedBefore, mutation.room, changedPlanes, updated.activity);
        const writesDocument = mutation.documentChanged;
        const writesAwareness = mutation.awarenessChanged;
        const writesCoordination = mutation.changed;
        if (writesDocument || writesAwareness || writesCoordination) {
          assertSafeChangedPlaneWrites({
            room: mutation.room,
            planes: mutation.planes,
            document: writesDocument,
            awareness: writesAwareness,
            coordination: writesCoordination,
            activity: updated.activity,
          });
        }
        const receipt = mutationReceiptFor(mutation.room, updated.result, updated.activity);
        if (!mutation.changed && !updated.activity) {
          if (!receipt || !identity) {
            await connection.unwatch();
            return updated.result;
          }
          let committedReceipt;
          try {
            committedReceipt = await connection
              .multi()
              .set(
                identity.receiptKey,
                serializeMutationReceipt(receipt),
                "EX",
                IDEMPOTENCY_RECEIPT_TTL_SECONDS,
              )
              .exec();
          } catch {
            let encodedReceipt: string | null;
            try {
              encodedReceipt = await connection.get(identity.receiptKey);
            } catch {
              throw mutationVerificationUnavailable();
            }
            const recovered = parseMutationReceipt(encodedReceipt);
            if (!recovered) throw mutationVerificationUnavailable();
            assertReceiptMatches(recovered, identity);
            assertRoomReceiptTarget(recovered, roomId);
            throw committedMutationReplay(recovered);
          }
          if (committedReceipt) return updated.result;
          await waitForRoomTransactionRetry(attempt);
          continue;
        }

        const shouldPublishEvent = mutation.changed || Boolean(updated.activity);
        const event = shouldPublishEvent
          ? roomEvent(
              mutation.room,
              eventType,
              updated.eventActor,
              updated.activity ?? null,
            )
          : null;

        if (updated.activity) {
          if (!event) {
            await connection.unwatch();
            throw new Error("An activity-bearing mutation must publish a compact room event.");
          }
          const serializedReceipt = receipt && identity
            ? serializeMutationReceipt(receipt)
            : null;
          const command = createActivityHistoryRoomCommitCommand(
            updated.activity,
            {
              planeKeys: {
                document: keys.document,
                awareness: keys.awareness,
                coordination: keys.coordination,
              },
              expectedPlanes: {
                document: encoded[0],
                awareness: encoded[1],
                coordination: encoded[2],
              },
              changedPlanes: {
                ...(writesDocument
                  ? { document: JSON.stringify(mutation.planes.document) }
                  : {}),
                ...(writesAwareness
                  ? { awareness: JSON.stringify(mutation.planes.awareness) }
                  : {}),
                ...(writesCoordination
                  ? { coordination: JSON.stringify(mutation.planes.coordination) }
                  : {}),
              },
              event: {
                streamKey: EVENT_STREAM,
                roomId,
                encoded: JSON.stringify(streamRoomEvent(event)),
              },
              ...(serializedReceipt && identity
                ? {
                    receipt: {
                      key: identity.receiptKey,
                      encoded: serializedReceipt,
                      ttlSeconds: IDEMPOTENCY_RECEIPT_TTL_SECONDS,
                    },
                  }
                : {}),
              guards: privateBlobReferenceGuards,
            },
          );
          await connection.unwatch();
          let committed;
          try {
            committed = await executeActivityHistoryRoomCommit(connection, command);
          } catch (error) {
            if (error instanceof DomainError) throw error;
            if (!identity) throw mutationVerificationUnavailable();
            let recoveryReceipt: string | null;
            try {
              recoveryReceipt = await connection.get(identity.receiptKey);
            } catch {
              throw mutationVerificationUnavailable();
            }
            if (!recoveryReceipt) {
              await waitForRoomTransactionRetry(attempt);
              continue;
            }
            const recovered = parseMutationReceipt(recoveryReceipt);
            if (!recovered) throw mutationVerificationUnavailable();
            assertReceiptMatches(recovered, identity);
            assertRoomReceiptTarget(recovered, roomId);
            throw committedMutationReplay(recovered);
          }
          if (committed.status === "revision_conflict") {
            await waitForRoomTransactionRetry(attempt);
            continue;
          }
          if (committed.status === "replayed") {
            if (!identity) {
              throw new DomainError(
                "MUTATION_OUTCOME_UNKNOWN",
                "Jazzboard found a mutation replay without an active idempotency scope.",
              );
            }
            const winningReceipt = parseMutationReceipt(committed.receipt);
            if (!winningReceipt) throw mutationVerificationUnavailable();
            assertReceiptMatches(winningReceipt, identity);
            assertRoomReceiptTarget(winningReceipt, roomId);
            throw committedMutationReplay(winningReceipt);
          }
          publishLocal(event);
          return updated.result;
        }

        const transaction = connection.multi();
        if (writesDocument) {
          transaction.set(keys.document, JSON.stringify(mutation.planes.document));
        }
        if (writesAwareness) {
          transaction.set(keys.awareness, JSON.stringify(mutation.planes.awareness));
        }
        if (writesCoordination) {
          transaction.set(keys.coordination, JSON.stringify(mutation.planes.coordination));
        }
        if (event) transaction.xadd(
            EVENT_STREAM,
            "MAXLEN",
            "~",
            20_000,
            "*",
            "roomId",
            roomId,
            "data",
            JSON.stringify(streamRoomEvent(event)),
          );
        if (receipt && identity) {
          transaction.set(
            identity.receiptKey,
            serializeMutationReceipt(receipt),
            "EX",
            IDEMPOTENCY_RECEIPT_TTL_SECONDS,
          );
        }
        let committed;
        try {
          committed = await transaction.exec();
        } catch (error) {
          if (identity) {
            let encodedReceipt: string | null;
            try {
              encodedReceipt = await connection.get(identity.receiptKey);
            } catch {
              throw mutationVerificationUnavailable();
            }
            const recovered = parseMutationReceipt(encodedReceipt);
            if (recovered) {
              assertReceiptMatches(recovered, identity);
              assertRoomReceiptTarget(recovered, roomId);
              throw committedMutationReplay(recovered);
            }
          }
          throw error;
        }
        if (committed) {
          if (event) publishLocal(event);
          return updated.result;
        }
        await waitForRoomTransactionRetry(attempt);
      }
      throw new DomainError("REVISION_CONFLICT", "The room changed too quickly; inspect the latest state and retry.");
    } finally {
      await connection.quit().catch(() => undefined);
    }
  }

}

export function getRoomStore(): RoomStore {
  if (globalThis.__jazzboardRoomStore) return globalThis.__jazzboardRoomStore;
  const redis = redisClient();
  globalThis.__jazzboardRoomStore = redis ? new RedisRoomStore(redis) : new MemoryRoomStore();
  return globalThis.__jazzboardRoomStore;
}

export function getRedisForRealtime(): Redis | null {
  return redisClient();
}

export function getRedisForAssets(): Redis | null {
  return redisClient();
}
