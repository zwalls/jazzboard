import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type Redis from "ioredis";

import {
  AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
  type AgentCanvasDraft,
  type AgentCanvasDraftEvent,
  type AgentCanvasDraftStatus,
} from "@/lib/agent-drafts/types";
import { DomainError } from "@/lib/domain/errors";
import { REALTIME_EVENT_STREAM } from "@/lib/realtime/protocol";

import { currentMutationContext } from "./mutation-context";
import { getRedisForRealtime } from "./room-store";

export const AGENT_DRAFT_SLIDING_TTL_MS = 5 * 60_000;
export const AGENT_DRAFT_HARD_TTL_MS = 30 * 60_000;
export const DEFAULT_AGENT_DRAFT_LIMITS = Object.freeze({
  draftBytes: 192 * 1024,
  roomBytes: 768 * 1024,
  draftsPerRoom: 16,
});

export type AgentDraftLimits = {
  draftBytes: number;
  roomBytes: number;
  draftsPerRoom: number;
};

type AgentCanvasDraftRemovalBase = {
  roomId: string;
  draftId: string;
  ownerParticipantId: string;
  expectedRevision?: number;
  committingMutationId?: string;
  requiredStatus?: AgentCanvasDraftStatus;
  now: number;
};

export type AgentCanvasDraftRemovalInput = AgentCanvasDraftRemovalBase & (
  | { reason: "committed"; authoritativeRoomRevision: number }
  | { reason: "discarded" | "proposed"; authoritativeRoomRevision?: never }
);

type MutationMarker = {
  id: string;
  fingerprint: string;
};

type StoredAgentCanvasDraft = {
  draft: AgentCanvasDraft;
  lastWrite: MutationMarker;
};

type MemoryAgentDraftState = {
  rooms: Map<string, Map<string, StoredAgentCanvasDraft>>;
  queues: Map<string, Promise<void>>;
  bus: EventEmitter;
};

export interface AgentCanvasDraftStore {
  list(roomId: string, now?: number): Promise<AgentCanvasDraft[]>;
  get(roomId: string, draftId: string, now?: number): Promise<AgentCanvasDraft | null>;
  create(draft: AgentCanvasDraft): Promise<AgentCanvasDraft>;
  replace(input: {
    draft: AgentCanvasDraft;
    expectedRevision: number;
  }): Promise<AgentCanvasDraft>;
  touch(input: {
    roomId: string;
    draftId: string;
    ownerParticipantId: string;
    expectedRevision: number;
    now: number;
  }): Promise<AgentCanvasDraft>;
  beginCommit(input: {
    roomId: string;
    draftId: string;
    ownerParticipantId: string;
    expectedRevision: number;
    mutationId: string;
    now: number;
  }): Promise<AgentCanvasDraft>;
  restoreActive(input: {
    roomId: string;
    draftId: string;
    ownerParticipantId: string;
    mutationId: string;
    now: number;
  }): Promise<AgentCanvasDraft>;
  markAwaitingReview(input: {
    roomId: string;
    draftId: string;
    ownerParticipantId: string;
    mutationId: string;
    proposalId: string;
    now: number;
  }): Promise<AgentCanvasDraft>;
  markAuthoritativelyCommitted(input: {
    roomId: string;
    draftId: string;
    ownerParticipantId: string;
    mutationId: string;
    authoritativeRoomRevision: number;
    now: number;
  }): Promise<AgentCanvasDraft>;
  remove(input: AgentCanvasDraftRemovalInput): Promise<AgentCanvasDraft | null>;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function safeKeyPart(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) {
    throw new DomainError("INVALID_OPERATION", `${label} is invalid.`);
  }
  return value;
}

function redisKey(roomId: string): string {
  return `jazzboard:{agent-drafts:${safeKeyPart(roomId, "Room ID")}}:v1`;
}

function mutationMarker(): MutationMarker {
  const context = currentMutationContext();
  return context?.idempotency
    ? { id: context.idempotency.scopedKeyHash, fingerprint: context.idempotency.requestDigest }
    : { id: context?.requestId ?? `draft_write_${randomUUID()}`, fingerprint: context?.requestId ?? randomUUID() };
}

function sameMarker(left: MutationMarker, right: MutationMarker): boolean {
  if (left.id !== right.id) return false;
  if (left.fingerprint !== right.fingerprint) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "That Idempotency-Key was already used for a different draft mutation.",
    );
  }
  return true;
}

function draftNotFound(): DomainError {
  return new DomainError("INVALID_OPERATION", "That agent canvas draft is unavailable or expired.");
}

function revisionConflict(expectedRevision: number, currentRevision: number): DomainError {
  return new DomainError(
    "REVISION_CONFLICT",
    `Draft revision changed from ${expectedRevision} to ${currentRevision}.`,
    { expectedRevision, currentRevision },
  );
}

function requireOwner(draft: AgentCanvasDraft, participantId: string): void {
  if (draft.ownerParticipantId !== participantId) {
    throw new DomainError("FORBIDDEN", "Only the participant that owns this draft may change it.");
  }
}

function activeUntil(draft: AgentCanvasDraft, now: number): number {
  return Math.min(draft.hardExpiresAt, now + AGENT_DRAFT_SLIDING_TTL_MS);
}

function isExpired(draft: AgentCanvasDraft, now: number): boolean {
  return draft.hardExpiresAt <= now ||
    (draft.status === "active" && draft.expiresAt <= now);
}

function parseStored(value: string): StoredAgentCanvasDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DomainError("MUTATION_OUTCOME_UNKNOWN", "Jazzboard found malformed agent draft state.");
  }
  const record = parsed as Partial<StoredAgentCanvasDraft> | null;
  if (
    !record ||
    typeof record !== "object" ||
    !record.draft ||
    record.draft.schemaVersion !== AGENT_CANVAS_DRAFT_SCHEMA_VERSION ||
    typeof record.draft.id !== "string" ||
    typeof record.draft.roomId !== "string" ||
    !record.lastWrite ||
    typeof record.lastWrite.id !== "string" ||
    typeof record.lastWrite.fingerprint !== "string"
  ) {
    throw new DomainError("MUTATION_OUTCOME_UNKNOWN", "Jazzboard found malformed agent draft state.");
  }
  return record as StoredAgentCanvasDraft;
}

function assertDraftCapacity(
  records: Iterable<StoredAgentCanvasDraft>,
  candidate: StoredAgentCanvasDraft,
  limits: AgentDraftLimits,
): void {
  const candidateBytes = byteLength(candidate);
  if (candidateBytes > limits.draftBytes) {
    throw new DomainError(
      "REQUEST_TOO_LARGE",
      "The staged canvas draft exceeds Jazzboard's safe draft size.",
      { maximumBytes: limits.draftBytes, receivedBytes: candidateBytes },
    );
  }
  let retainedBytes = candidateBytes;
  for (const record of records) {
    if (record.draft.id !== candidate.draft.id) retainedBytes += byteLength(record);
  }
  if (retainedBytes > limits.roomBytes) {
    throw new DomainError(
      "ROOM_CAPACITY_EXCEEDED",
      "This room has reached its temporary agent-draft capacity.",
      { maximumBytes: limits.roomBytes, retainedBytes },
    );
  }
}

function upsertEvent(draft: AgentCanvasDraft, now: number): AgentCanvasDraftEvent {
  return {
    schemaVersion: AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
    id: `draft_event_${randomUUID()}`,
    roomId: draft.roomId,
    occurredAt: now,
    type: "draft.upsert",
    draftId: draft.id,
    ownerParticipantId: draft.ownerParticipantId,
    revision: draft.revision,
    status: draft.status,
    expiresAt: draft.expiresAt,
  };
}

function removedEvent(
  draft: AgentCanvasDraft,
  input: AgentCanvasDraftRemovalInput,
): AgentCanvasDraftEvent {
  if (
    input.reason === "committed" &&
    (!Number.isSafeInteger(input.authoritativeRoomRevision) || input.authoritativeRoomRevision < 0)
  ) {
    throw new DomainError("INVALID_OPERATION", "Committed draft removal requires a valid room revision fence.");
  }
  const base = {
    schemaVersion: AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
    id: `draft_event_${randomUUID()}`,
    roomId: draft.roomId,
    occurredAt: input.now,
    type: "draft.removed" as const,
    draftId: draft.id,
    revision: draft.revision,
  };
  return input.reason === "committed"
    ? { ...base, reason: input.reason, authoritativeRoomRevision: input.authoritativeRoomRevision }
    : { ...base, reason: input.reason };
}

declare global {
  var __jazzboardAgentDraftState: MemoryAgentDraftState | undefined;
  var __jazzboardAgentDraftStore: AgentCanvasDraftStore | undefined;
}

function localState(): MemoryAgentDraftState {
  globalThis.__jazzboardAgentDraftState ??= {
    rooms: new Map(),
    queues: new Map(),
    bus: new EventEmitter(),
  };
  globalThis.__jazzboardAgentDraftState.bus.setMaxListeners(200);
  return globalThis.__jazzboardAgentDraftState;
}

export function subscribeToLocalAgentDraftEvents(
  listener: (event: AgentCanvasDraftEvent) => void,
): () => void {
  const bus = localState().bus;
  bus.on("draft-event", listener);
  return () => bus.off("draft-event", listener);
}

function publishLocal(event: AgentCanvasDraftEvent): void {
  localState().bus.emit("draft-event", event);
}

function pruneRoom(
  room: Map<string, StoredAgentCanvasDraft>,
  now: number,
): void {
  for (const [id, record] of room) {
    if (isExpired(record.draft, now)) room.delete(id);
  }
}

export class MemoryAgentCanvasDraftStore implements AgentCanvasDraftStore {
  private readonly state: MemoryAgentDraftState;
  private readonly limits: AgentDraftLimits;

  constructor(
    state: MemoryAgentDraftState = localState(),
    limits: Partial<AgentDraftLimits> = {},
  ) {
    this.state = state;
    this.limits = { ...DEFAULT_AGENT_DRAFT_LIMITS, ...limits };
  }

  private async locked<T>(roomId: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.state.queues.get(roomId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.state.queues.set(roomId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.state.queues.get(roomId) === queued) this.state.queues.delete(roomId);
    }
  }

  async list(roomId: string, now = Date.now()): Promise<AgentCanvasDraft[]> {
    return this.locked(roomId, () => {
      const room = this.state.rooms.get(roomId);
      if (!room) return [];
      pruneRoom(room, now);
      return [...room.values()]
        .map(({ draft }) => structuredClone(draft))
        .sort((left, right) => left.createdAt - right.createdAt);
    });
  }

  async get(roomId: string, draftId: string, now = Date.now()): Promise<AgentCanvasDraft | null> {
    return this.locked(roomId, () => {
      const room = this.state.rooms.get(roomId);
      if (!room) return null;
      pruneRoom(room, now);
      return structuredClone(room.get(draftId)?.draft ?? null);
    });
  }

  async create(draft: AgentCanvasDraft): Promise<AgentCanvasDraft> {
    const marker = mutationMarker();
    return this.locked(draft.roomId, () => {
      const room = this.state.rooms.get(draft.roomId) ?? new Map<string, StoredAgentCanvasDraft>();
      this.state.rooms.set(draft.roomId, room);
      pruneRoom(room, draft.updatedAt);
      const sameId = room.get(draft.id);
      if (sameId && sameMarker(sameId.lastWrite, marker)) return structuredClone(sameId.draft);
      if (sameId) {
        throw new DomainError("REVISION_CONFLICT", "That draft ID is already in use in this room.");
      }
      if ([...room.values()].some((record) => record.draft.ownerParticipantId === draft.ownerParticipantId)) {
        throw new DomainError("REVISION_CONFLICT", "This participant already has an active canvas draft.");
      }
      if (room.size >= this.limits.draftsPerRoom) {
        throw new DomainError("ROOM_CAPACITY_EXCEEDED", "This room has reached its active agent-draft limit.");
      }
      const record = { draft: structuredClone(draft), lastWrite: marker };
      assertDraftCapacity(room.values(), record, this.limits);
      room.set(draft.id, record);
      publishLocal(upsertEvent(draft, draft.updatedAt));
      return structuredClone(draft);
    });
  }

  async replace(input: { draft: AgentCanvasDraft; expectedRevision: number }): Promise<AgentCanvasDraft> {
    const marker = mutationMarker();
    return this.locked(input.draft.roomId, () => {
      const room = this.state.rooms.get(input.draft.roomId);
      const current = room?.get(input.draft.id);
      if (!room || !current || isExpired(current.draft, input.draft.updatedAt)) throw draftNotFound();
      requireOwner(current.draft, input.draft.ownerParticipantId);
      if (current.draft.revision === input.expectedRevision + 1 && sameMarker(current.lastWrite, marker)) {
        return structuredClone(current.draft);
      }
      if (current.draft.revision !== input.expectedRevision) {
        throw revisionConflict(input.expectedRevision, current.draft.revision);
      }
      if (current.draft.status !== "active") {
        throw new DomainError("REVISION_CONFLICT", "This draft is not editable in its current state.");
      }
      const record = { draft: structuredClone(input.draft), lastWrite: marker };
      assertDraftCapacity(room.values(), record, this.limits);
      room.set(input.draft.id, record);
      publishLocal(upsertEvent(input.draft, input.draft.updatedAt));
      return structuredClone(input.draft);
    });
  }

  async touch(input: {
    roomId: string; draftId: string; ownerParticipantId: string; expectedRevision: number; now: number;
  }): Promise<AgentCanvasDraft> {
    return this.locked(input.roomId, () => {
      const record = this.state.rooms.get(input.roomId)?.get(input.draftId);
      if (!record || isExpired(record.draft, input.now)) throw draftNotFound();
      requireOwner(record.draft, input.ownerParticipantId);
      if (record.draft.revision !== input.expectedRevision) {
        throw revisionConflict(input.expectedRevision, record.draft.revision);
      }
      if (record.draft.status !== "active") {
        throw new DomainError("REVISION_CONFLICT", "This draft cannot be kept alive in its current state.");
      }
      record.draft.expiresAt = activeUntil(record.draft, input.now);
      publishLocal(upsertEvent(record.draft, input.now));
      return structuredClone(record.draft);
    });
  }

  async beginCommit(input: {
    roomId: string; draftId: string; ownerParticipantId: string; expectedRevision: number;
    mutationId: string; now: number;
  }): Promise<AgentCanvasDraft> {
    return this.locked(input.roomId, () => {
      const room = this.state.rooms.get(input.roomId);
      const record = room?.get(input.draftId);
      if (!record || isExpired(record.draft, input.now)) throw draftNotFound();
      requireOwner(record.draft, input.ownerParticipantId);
      if (record.draft.status === "committing" && record.draft.committing?.mutationId === input.mutationId) {
        return structuredClone(record.draft);
      }
      if (record.draft.revision !== input.expectedRevision) {
        throw revisionConflict(input.expectedRevision, record.draft.revision);
      }
      if (record.draft.status !== "active") {
        throw new DomainError("REVISION_CONFLICT", "This draft cannot be committed in its current state.");
      }
      record.draft.status = "committing";
      record.draft.revision += 1;
      record.draft.committing = { mutationId: input.mutationId, startedAt: input.now };
      record.draft.authoritativeCommit = null;
      record.draft.updatedAt = input.now;
      record.draft.expiresAt = record.draft.hardExpiresAt;
      publishLocal(upsertEvent(record.draft, input.now));
      return structuredClone(record.draft);
    });
  }

  async restoreActive(input: {
    roomId: string; draftId: string; ownerParticipantId: string; mutationId: string; now: number;
  }): Promise<AgentCanvasDraft> {
    return this.locked(input.roomId, () => {
      const record = this.state.rooms.get(input.roomId)?.get(input.draftId);
      if (!record || isExpired(record.draft, input.now)) throw draftNotFound();
      requireOwner(record.draft, input.ownerParticipantId);
      if (record.draft.status !== "committing" || record.draft.committing?.mutationId !== input.mutationId) {
        return structuredClone(record.draft);
      }
      record.draft.status = "active";
      record.draft.revision += 1;
      record.draft.committing = null;
      record.draft.authoritativeCommit = null;
      record.draft.updatedAt = input.now;
      record.draft.expiresAt = activeUntil(record.draft, input.now);
      publishLocal(upsertEvent(record.draft, input.now));
      return structuredClone(record.draft);
    });
  }

  async markAwaitingReview(input: {
    roomId: string; draftId: string; ownerParticipantId: string; mutationId: string;
    proposalId: string; now: number;
  }): Promise<AgentCanvasDraft> {
    return this.locked(input.roomId, () => {
      const record = this.state.rooms.get(input.roomId)?.get(input.draftId);
      if (!record || isExpired(record.draft, input.now)) throw draftNotFound();
      requireOwner(record.draft, input.ownerParticipantId);
      if (
        record.draft.status === "awaiting_review" &&
        record.draft.awaitingReview?.proposalId === input.proposalId
      ) {
        return structuredClone(record.draft);
      }
      if (record.draft.status !== "committing" || record.draft.committing?.mutationId !== input.mutationId) {
        throw new DomainError("REVISION_CONFLICT", "This draft is no longer committing that mutation.");
      }
      record.draft.status = "awaiting_review";
      record.draft.revision += 1;
      record.draft.committing = null;
      record.draft.awaitingReview = { proposalId: input.proposalId, proposedAt: input.now };
      record.draft.updatedAt = input.now;
      record.draft.expiresAt = record.draft.hardExpiresAt;
      publishLocal(upsertEvent(record.draft, input.now));
      return structuredClone(record.draft);
    });
  }

  async markAuthoritativelyCommitted(input: {
    roomId: string; draftId: string; ownerParticipantId: string; mutationId: string;
    authoritativeRoomRevision: number; now: number;
  }): Promise<AgentCanvasDraft> {
    return this.locked(input.roomId, () => {
      const record = this.state.rooms.get(input.roomId)?.get(input.draftId);
      if (!record || isExpired(record.draft, input.now)) throw draftNotFound();
      requireOwner(record.draft, input.ownerParticipantId);
      const existing = record.draft.authoritativeCommit;
      if (existing) {
        if (
          existing.mutationId !== input.mutationId ||
          existing.roomRevision !== input.authoritativeRoomRevision
        ) {
          throw new DomainError(
            "MUTATION_OUTCOME_UNKNOWN",
            "This draft already records a different authoritative commit outcome.",
          );
        }
        return structuredClone(record.draft);
      }
      if (record.draft.status !== "committing" || record.draft.committing?.mutationId !== input.mutationId) {
        throw new DomainError("REVISION_CONFLICT", "This draft is no longer committing that mutation.");
      }
      const draft = structuredClone(record.draft);
      draft.authoritativeCommit = {
        mutationId: input.mutationId,
        roomRevision: input.authoritativeRoomRevision,
        committedAt: input.now,
      };
      const write = { draft, lastWrite: record.lastWrite };
      const room = this.state.rooms.get(input.roomId);
      if (!room) throw draftNotFound();
      assertDraftCapacity(room.values(), write, this.limits);
      room.set(input.draftId, write);
      return structuredClone(draft);
    });
  }

  async remove(input: AgentCanvasDraftRemovalInput): Promise<AgentCanvasDraft | null> {
    return this.locked(input.roomId, () => {
      const room = this.state.rooms.get(input.roomId);
      const record = room?.get(input.draftId);
      if (!room || !record || isExpired(record.draft, input.now)) return null;
      requireOwner(record.draft, input.ownerParticipantId);
      if (input.expectedRevision !== undefined && record.draft.revision !== input.expectedRevision) {
        throw revisionConflict(input.expectedRevision, record.draft.revision);
      }
      if (input.requiredStatus && record.draft.status !== input.requiredStatus) {
        throw new DomainError("REVISION_CONFLICT", "This draft cannot be removed in its current state.", {
          expectedStatus: input.requiredStatus,
          currentStatus: record.draft.status,
        });
      }
      if (input.committingMutationId && record.draft.committing?.mutationId !== input.committingMutationId) {
        throw new DomainError("REVISION_CONFLICT", "This draft is no longer committing that mutation.");
      }
      const event = removedEvent(record.draft, input);
      room.delete(input.draftId);
      publishLocal(event);
      return structuredClone(record.draft);
    });
  }
}

/** Redis parity store. One bounded hash per room keeps writes draft-sized. */
export class RedisAgentCanvasDraftStore implements AgentCanvasDraftStore {
  private readonly limits: AgentDraftLimits;

  constructor(private readonly redis: Redis, limits: Partial<AgentDraftLimits> = {}) {
    this.limits = { ...DEFAULT_AGENT_DRAFT_LIMITS, ...limits };
  }

  private async read(
    connection: Redis,
    roomId: string,
    now: number,
    prune = true,
  ): Promise<{ records: Map<string, StoredAgentCanvasDraft>; expired: string[] }> {
    const values = await connection.hgetall(redisKey(roomId));
    const records = new Map<string, StoredAgentCanvasDraft>();
    const expired: string[] = [];
    for (const [field, encoded] of Object.entries(values)) {
      const record = parseStored(encoded);
      if (record.draft.id !== field || record.draft.roomId !== roomId) {
        throw new DomainError("MUTATION_OUTCOME_UNKNOWN", "Jazzboard found mismatched agent draft state.");
      }
      if (isExpired(record.draft, now)) expired.push(field);
      else records.set(field, record);
    }
    if (prune && expired.length > 0) await connection.hdel(redisKey(roomId), ...expired);
    return { records, expired };
  }

  private async mutate<T>(input: {
    roomId: string;
    now: number;
    update: (records: Map<string, StoredAgentCanvasDraft>) => {
      result: T;
      write?: StoredAgentCanvasDraft;
      remove?: AgentCanvasDraft;
      event?: AgentCanvasDraftEvent;
    };
  }): Promise<T> {
    const connection = this.redis.duplicate();
    const key = redisKey(input.roomId);
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await connection.watch(key);
        const { records, expired } = await this.read(connection, input.roomId, input.now, false);
        const mutation = input.update(records);
        if (!mutation.write && !mutation.remove && expired.length === 0) {
          await connection.unwatch();
          return mutation.result;
        }
        if (mutation.write) assertDraftCapacity(records.values(), mutation.write, this.limits);
        const transaction = connection.multi();
        if (expired.length > 0) transaction.hdel(key, ...expired);
        if (mutation.write) {
          transaction.hset(key, mutation.write.draft.id, JSON.stringify(mutation.write));
        }
        if (mutation.remove) transaction.hdel(key, mutation.remove.id);
        const retained = [...records.values()]
          .filter((record) => record.draft.id !== mutation.remove?.id && record.draft.id !== mutation.write?.draft.id)
          .map((record) => record.draft.hardExpiresAt);
        if (mutation.write) retained.push(mutation.write.draft.hardExpiresAt);
        if (retained.length > 0) transaction.pexpire(key, Math.max(1, Math.max(...retained) - input.now));
        if (mutation.event) {
          transaction.xadd(
            REALTIME_EVENT_STREAM,
            "MAXLEN", "~", 20_000, "*",
            "roomId", input.roomId,
            "data", JSON.stringify(mutation.event),
          );
        }
        const committed = await transaction.exec();
        if (!committed) continue;
        if (mutation.event) publishLocal(mutation.event);
        return mutation.result;
      }
      throw new DomainError("REVISION_CONFLICT", "The draft changed too quickly; inspect it and retry.");
    } finally {
      await connection.quit().catch(() => undefined);
    }
  }

  async list(roomId: string, now = Date.now()): Promise<AgentCanvasDraft[]> {
    const connection = this.redis.duplicate();
    try {
      const { records } = await this.read(connection, roomId, now);
      return [...records.values()]
        .map(({ draft }) => structuredClone(draft))
        .sort((left, right) => left.createdAt - right.createdAt);
    } finally {
      await connection.quit().catch(() => undefined);
    }
  }

  async get(roomId: string, draftId: string, now = Date.now()): Promise<AgentCanvasDraft | null> {
    const connection = this.redis.duplicate();
    try {
      const { records } = await this.read(connection, roomId, now);
      return structuredClone(records.get(draftId)?.draft ?? null);
    } finally {
      await connection.quit().catch(() => undefined);
    }
  }

  async create(draft: AgentCanvasDraft): Promise<AgentCanvasDraft> {
    const marker = mutationMarker();
    return this.mutate({
      roomId: draft.roomId,
      now: draft.updatedAt,
      update: (records) => {
        const sameId = records.get(draft.id);
        if (sameId && sameMarker(sameId.lastWrite, marker)) return { result: structuredClone(sameId.draft) };
        if (sameId) {
          throw new DomainError("REVISION_CONFLICT", "That draft ID is already in use in this room.");
        }
        if ([...records.values()].some((record) => record.draft.ownerParticipantId === draft.ownerParticipantId)) {
          throw new DomainError("REVISION_CONFLICT", "This participant already has an active canvas draft.");
        }
        if (records.size >= this.limits.draftsPerRoom) {
          throw new DomainError("ROOM_CAPACITY_EXCEEDED", "This room has reached its active agent-draft limit.");
        }
        const write = { draft: structuredClone(draft), lastWrite: marker };
        return { result: structuredClone(draft), write, event: upsertEvent(draft, draft.updatedAt) };
      },
    });
  }

  async replace(input: { draft: AgentCanvasDraft; expectedRevision: number }): Promise<AgentCanvasDraft> {
    const marker = mutationMarker();
    return this.mutate({
      roomId: input.draft.roomId,
      now: input.draft.updatedAt,
      update: (records) => {
        const current = records.get(input.draft.id);
        if (!current) throw draftNotFound();
        requireOwner(current.draft, input.draft.ownerParticipantId);
        if (current.draft.revision === input.expectedRevision + 1 && sameMarker(current.lastWrite, marker)) {
          return { result: structuredClone(current.draft) };
        }
        if (current.draft.revision !== input.expectedRevision) {
          throw revisionConflict(input.expectedRevision, current.draft.revision);
        }
        if (current.draft.status !== "active") {
          throw new DomainError("REVISION_CONFLICT", "This draft is not editable in its current state.");
        }
        const write = { draft: structuredClone(input.draft), lastWrite: marker };
        return { result: structuredClone(input.draft), write, event: upsertEvent(input.draft, input.draft.updatedAt) };
      },
    });
  }

  async touch(input: {
    roomId: string; draftId: string; ownerParticipantId: string; expectedRevision: number; now: number;
  }): Promise<AgentCanvasDraft> {
    const connection = this.redis.duplicate();
    const key = redisKey(input.roomId);
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await connection.watch(key);
        const encoded = await connection.hget(key, input.draftId);
        if (!encoded) throw draftNotFound();
        const current = parseStored(encoded);
        if (
          current.draft.id !== input.draftId ||
          current.draft.roomId !== input.roomId ||
          isExpired(current.draft, input.now)
        ) {
          throw draftNotFound();
        }
        requireOwner(current.draft, input.ownerParticipantId);
        if (current.draft.revision !== input.expectedRevision) {
          throw revisionConflict(input.expectedRevision, current.draft.revision);
        }
        if (current.draft.status !== "active") {
          throw new DomainError("REVISION_CONFLICT", "This draft cannot be kept alive in its current state.");
        }
        const draft = structuredClone(current.draft);
        draft.expiresAt = activeUntil(draft, input.now);
        const event = upsertEvent(draft, input.now);
        const transaction = connection.multi();
        transaction.hset(key, draft.id, JSON.stringify({ draft, lastWrite: current.lastWrite }));
        transaction.xadd(
          REALTIME_EVENT_STREAM,
          "MAXLEN", "~", 20_000, "*",
          "roomId", input.roomId,
          "data", JSON.stringify(event),
        );
        const committed = await transaction.exec();
        if (!committed) continue;
        publishLocal(event);
        return structuredClone(draft);
      }
      throw new DomainError("REVISION_CONFLICT", "The draft changed too quickly; inspect it and retry.");
    } finally {
      await connection.quit().catch(() => undefined);
    }
  }

  async beginCommit(input: {
    roomId: string; draftId: string; ownerParticipantId: string; expectedRevision: number;
    mutationId: string; now: number;
  }): Promise<AgentCanvasDraft> {
    return this.mutate({
      roomId: input.roomId,
      now: input.now,
      update: (records) => {
        const current = records.get(input.draftId);
        if (!current) throw draftNotFound();
        requireOwner(current.draft, input.ownerParticipantId);
        if (current.draft.status === "committing" && current.draft.committing?.mutationId === input.mutationId) {
          return { result: structuredClone(current.draft) };
        }
        if (current.draft.revision !== input.expectedRevision) {
          throw revisionConflict(input.expectedRevision, current.draft.revision);
        }
        if (current.draft.status !== "active") {
          throw new DomainError("REVISION_CONFLICT", "This draft cannot be committed in its current state.");
        }
        const draft = structuredClone(current.draft);
        draft.status = "committing";
        draft.revision += 1;
        draft.committing = { mutationId: input.mutationId, startedAt: input.now };
        draft.authoritativeCommit = null;
        draft.updatedAt = input.now;
        draft.expiresAt = draft.hardExpiresAt;
        const write = { draft, lastWrite: { id: input.mutationId, fingerprint: input.mutationId } };
        return { result: structuredClone(draft), write, event: upsertEvent(draft, input.now) };
      },
    });
  }

  async restoreActive(input: {
    roomId: string; draftId: string; ownerParticipantId: string; mutationId: string; now: number;
  }): Promise<AgentCanvasDraft> {
    return this.mutate({
      roomId: input.roomId,
      now: input.now,
      update: (records) => {
        const current = records.get(input.draftId);
        if (!current) throw draftNotFound();
        requireOwner(current.draft, input.ownerParticipantId);
        if (current.draft.status !== "committing" || current.draft.committing?.mutationId !== input.mutationId) {
          return { result: structuredClone(current.draft) };
        }
        const draft = structuredClone(current.draft);
        draft.status = "active";
        draft.revision += 1;
        draft.committing = null;
        draft.authoritativeCommit = null;
        draft.updatedAt = input.now;
        draft.expiresAt = activeUntil(draft, input.now);
        const write = { draft, lastWrite: current.lastWrite };
        return { result: structuredClone(draft), write, event: upsertEvent(draft, input.now) };
      },
    });
  }

  async markAuthoritativelyCommitted(input: {
    roomId: string; draftId: string; ownerParticipantId: string; mutationId: string;
    authoritativeRoomRevision: number; now: number;
  }): Promise<AgentCanvasDraft> {
    return this.mutate({
      roomId: input.roomId,
      now: input.now,
      update: (records) => {
        const current = records.get(input.draftId);
        if (!current) throw draftNotFound();
        requireOwner(current.draft, input.ownerParticipantId);
        const existing = current.draft.authoritativeCommit;
        if (existing) {
          if (
            existing.mutationId !== input.mutationId ||
            existing.roomRevision !== input.authoritativeRoomRevision
          ) {
            throw new DomainError(
              "MUTATION_OUTCOME_UNKNOWN",
              "This draft already records a different authoritative commit outcome.",
            );
          }
          return { result: structuredClone(current.draft) };
        }
        if (current.draft.status !== "committing" || current.draft.committing?.mutationId !== input.mutationId) {
          throw new DomainError("REVISION_CONFLICT", "This draft is no longer committing that mutation.");
        }
        const draft = structuredClone(current.draft);
        draft.authoritativeCommit = {
          mutationId: input.mutationId,
          roomRevision: input.authoritativeRoomRevision,
          committedAt: input.now,
        };
        const write = { draft, lastWrite: current.lastWrite };
        // This evidence is server-private and does not change the public draft
        // revision or emit a render invalidation.
        return { result: structuredClone(draft), write };
      },
    });
  }

  async markAwaitingReview(input: {
    roomId: string; draftId: string; ownerParticipantId: string; mutationId: string;
    proposalId: string; now: number;
  }): Promise<AgentCanvasDraft> {
    return this.mutate({
      roomId: input.roomId,
      now: input.now,
      update: (records) => {
        const current = records.get(input.draftId);
        if (!current) throw draftNotFound();
        requireOwner(current.draft, input.ownerParticipantId);
        if (
          current.draft.status === "awaiting_review" &&
          current.draft.awaitingReview?.proposalId === input.proposalId
        ) {
          return { result: structuredClone(current.draft) };
        }
        if (current.draft.status !== "committing" || current.draft.committing?.mutationId !== input.mutationId) {
          throw new DomainError("REVISION_CONFLICT", "This draft is no longer committing that mutation.");
        }
        const draft = structuredClone(current.draft);
        draft.status = "awaiting_review";
        draft.revision += 1;
        draft.committing = null;
        draft.awaitingReview = { proposalId: input.proposalId, proposedAt: input.now };
        draft.updatedAt = input.now;
        draft.expiresAt = draft.hardExpiresAt;
        const write = { draft, lastWrite: current.lastWrite };
        return { result: structuredClone(draft), write, event: upsertEvent(draft, input.now) };
      },
    });
  }

  async remove(input: AgentCanvasDraftRemovalInput): Promise<AgentCanvasDraft | null> {
    return this.mutate({
      roomId: input.roomId,
      now: input.now,
      update: (records) => {
        const current = records.get(input.draftId);
        if (!current) return { result: null };
        requireOwner(current.draft, input.ownerParticipantId);
        if (input.expectedRevision !== undefined && current.draft.revision !== input.expectedRevision) {
          throw revisionConflict(input.expectedRevision, current.draft.revision);
        }
        if (input.requiredStatus && current.draft.status !== input.requiredStatus) {
          throw new DomainError("REVISION_CONFLICT", "This draft cannot be removed in its current state.", {
            expectedStatus: input.requiredStatus,
            currentStatus: current.draft.status,
          });
        }
        if (input.committingMutationId && current.draft.committing?.mutationId !== input.committingMutationId) {
          throw new DomainError("REVISION_CONFLICT", "This draft is no longer committing that mutation.");
        }
        return {
          result: structuredClone(current.draft),
          remove: current.draft,
          event: removedEvent(current.draft, input),
        };
      },
    });
  }
}

export function getAgentCanvasDraftStore(): AgentCanvasDraftStore {
  if (globalThis.__jazzboardAgentDraftStore) return globalThis.__jazzboardAgentDraftStore;
  const redis = getRedisForRealtime();
  globalThis.__jazzboardAgentDraftStore = redis
    ? new RedisAgentCanvasDraftStore(redis)
    : new MemoryAgentCanvasDraftStore();
  return globalThis.__jazzboardAgentDraftStore;
}

export function setAgentCanvasDraftStoreForTests(store: AgentCanvasDraftStore | undefined): void {
  globalThis.__jazzboardAgentDraftStore = store;
}

export function resetMemoryAgentCanvasDraftStoreForTests(): void {
  globalThis.__jazzboardAgentDraftState = undefined;
  globalThis.__jazzboardAgentDraftStore = undefined;
}
