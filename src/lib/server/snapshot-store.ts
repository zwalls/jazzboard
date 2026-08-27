import { randomUUID } from "node:crypto";

import type { Redis } from "ioredis";

import type { ActorRef } from "@/lib/domain/types";
import { DomainError } from "@/lib/domain/errors";
import type { JazzboardSemanticArtifactV1 } from "@/lib/interchange/types";

import {
  assertReceiptMatches,
  createMutationReceipt,
  IDEMPOTENCY_RECEIPT_TTL_SECONDS,
  parseMutationReceipt,
  serializeMutationReceipt,
  sha256,
  localMutationReceiptState,
  resetLocalMutationReceiptStateForTests,
  withLocalMutationReceiptLock,
  type CompactMutationReceipt,
} from "./idempotency";
import { currentMutationContext, markCurrentMutationReplayed } from "./mutation-context";
import { getRedisForAssets } from "./room-store";
import {
  CREATE_AND_PRUNE_REDIS_SNAPSHOTS_SCRIPT,
  LIST_REDIS_SNAPSHOTS_SCRIPT,
  READ_REDIS_SNAPSHOT_BY_TOKEN_SCRIPT,
  REVOKE_IDEMPOTENT_REDIS_SNAPSHOT_SCRIPT,
} from "./snapshot-retention-scripts";

const SNAPSHOT_KEY_PREFIX = "jazzboard:snapshot:";
const SNAPSHOT_TOKEN_KEY_PREFIX = "jazzboard:snapshot-token:";
const SNAPSHOT_METADATA_KEY_PREFIX = "jazzboard:snapshot-metadata:";
const SNAPSHOT_CREATOR_KEY_PREFIX = "jazzboard:snapshots-by-creator:";
const SNAPSHOT_ROOM_KEY_PREFIX = "jazzboard:snapshots-by-room:";
const SNAPSHOT_CREATOR_BYTES_KEY_PREFIX = "jazzboard:snapshot-bytes-by-creator:";
const SNAPSHOT_ROOM_BYTES_KEY_PREFIX = "jazzboard:snapshot-bytes-by-room:";
const SNAPSHOT_GLOBAL_INDEX_KEY = "jazzboard:snapshots:global";
const SNAPSHOT_GLOBAL_BYTES_KEY = "jazzboard:snapshot-bytes:global";
export const MAX_CREATOR_SNAPSHOTS = 8;
export const MAX_ROOM_SNAPSHOTS = 64;
export const MAX_DEPLOYMENT_SNAPSHOTS = 128;
export const MAX_SNAPSHOT_RECORD_BYTES = Math.floor(3.5 * 1024 * 1024);
export const MAX_CREATOR_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_ROOM_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_DEPLOYMENT_SNAPSHOT_BYTES = 48 * 1024 * 1024;
const MAX_SNAPSHOT_METADATA_BYTES = 16 * 1024;
const MAX_SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;
const SNAPSHOT_CREATE_OUTCOME = "snapshot_created";

export type SnapshotScope =
  | { kind: "room" }
  | { kind: "diagram"; diagramId: string; expectedDiagramRevision: number };

export type ReadonlySnapshotRecord = {
  id: string;
  tokenHash: string;
  sourceRoomId: string;
  sourceRoomRevision: number;
  creatorParticipantId: string;
  /** Internal request digest used only to distinguish a safe same-key replay. */
  idempotencyRequestDigest?: string | null;
  creator: ActorRef;
  scope: SnapshotScope;
  title: string;
  createdAt: number;
  expiresAt: number;
  artifact: JazzboardSemanticArtifactV1;
};

export type ReadonlySnapshotSummary = Pick<
  ReadonlySnapshotRecord,
  "id" | "sourceRoomRevision" | "scope" | "title" | "createdAt" | "expiresAt"
>;

type SnapshotRetentionMetadata = ReadonlySnapshotSummary & {
  v: 1;
  tokenHash: string;
  sourceRoomId: string;
  creatorParticipantId: string;
  idempotencyRequestDigest: string | null;
  recordBytes: number;
};

type SnapshotCreateReplay = Omit<SnapshotRetentionMetadata, "v" | "recordBytes">;

export function snapshotIdFromMutationGeneration(
  scopedKeyHash: string,
  committedAt: number,
): string {
  if (!/^[a-f0-9]{64}$/.test(scopedKeyHash) || !Number.isSafeInteger(committedAt) || committedAt < 0) {
    throw new Error("Snapshot mutation generation inputs are invalid.");
  }
  const hex = sha256(`jazzboard:snapshot-generation:v1\0${scopedKeyHash}\0${committedAt}`).slice(0, 32);
  return `snapshot_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type MemorySnapshotState = {
  records: Map<string, ReadonlySnapshotRecord>;
  tokenIndex: Map<string, string>;
  metadata: Map<string, SnapshotRetentionMetadata>;
  creatorIndexes: Map<string, Map<string, number>>;
  roomIndexes: Map<string, Map<string, number>>;
  globalIndex: Map<string, number>;
  creatorBytes: Map<string, number>;
  roomBytes: Map<string, number>;
  deploymentBytes: number;
  mutationReceipts: Map<string, { encoded: string; expiresAt: number }>;
};

declare global {
  var __jazzboardSnapshotState: MemorySnapshotState | undefined;
}

function memoryState(): MemorySnapshotState {
  globalThis.__jazzboardSnapshotState ??= {
    records: new Map(),
    tokenIndex: new Map(),
    metadata: new Map(),
    creatorIndexes: new Map(),
    roomIndexes: new Map(),
    globalIndex: new Map(),
    creatorBytes: new Map(),
    roomBytes: new Map(),
    deploymentBytes: 0,
    mutationReceipts: localMutationReceiptState().receipts,
  };
  const state = globalThis.__jazzboardSnapshotState;
  // Development hot reload can retain an older process-local state. Rebuild
  // compact accounting once rather than preserving an unverifiable mix.
  const sharedReceipts = localMutationReceiptState().receipts;
  if (state.mutationReceipts !== sharedReceipts) {
    for (const [key, receipt] of state.mutationReceipts ?? []) {
      if (!sharedReceipts.has(key)) sharedReceipts.set(key, receipt);
    }
    state.mutationReceipts = sharedReceipts;
  }
  if (
    !state.metadata ||
    !state.creatorIndexes ||
    !state.roomIndexes ||
    !state.globalIndex ||
    !state.creatorBytes ||
    !state.roomBytes ||
    !Number.isSafeInteger(state.deploymentBytes)
  ) {
    state.metadata = new Map();
    state.creatorIndexes = new Map();
    state.roomIndexes = new Map();
    state.globalIndex = new Map();
    state.creatorBytes = new Map();
    state.roomBytes = new Map();
    state.deploymentBytes = 0;
    for (const record of state.records.values()) {
      const encoded = JSON.stringify(record);
      addMemoryMetadata(state, metadataFor(record, Buffer.byteLength(encoded, "utf8")));
    }
  }
  return state;
}

function snapshotKey(snapshotId: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${snapshotId}`;
}

function tokenKey(tokenHash: string): string {
  return `${SNAPSHOT_TOKEN_KEY_PREFIX}${tokenHash}`;
}

function metadataKey(snapshotId: string): string {
  return `${SNAPSHOT_METADATA_KEY_PREFIX}${snapshotId}`;
}

function creatorKey(roomId: string, participantId: string): string {
  return `${SNAPSHOT_CREATOR_KEY_PREFIX}${roomId}:${participantId}`;
}

function roomKey(roomId: string): string {
  return `${SNAPSHOT_ROOM_KEY_PREFIX}${roomId}`;
}

function creatorBytesKey(roomId: string, participantId: string): string {
  return `${SNAPSHOT_CREATOR_BYTES_KEY_PREFIX}${roomId}:${participantId}`;
}

function roomBytesKey(roomId: string): string {
  return `${SNAPSHOT_ROOM_BYTES_KEY_PREFIX}${roomId}`;
}

function creatorScopeKey(roomId: string, participantId: string): string {
  return `${roomId}:${participantId}`;
}

function encodedRecord(record: ReadonlySnapshotRecord): { encoded: string; bytes: number } {
  const encoded = JSON.stringify(record);
  return { encoded, bytes: Buffer.byteLength(encoded, "utf8") };
}

function metadataFor(record: ReadonlySnapshotRecord, recordBytes: number): SnapshotRetentionMetadata {
  return {
    v: 1,
    id: record.id,
    tokenHash: record.tokenHash,
    sourceRoomId: record.sourceRoomId,
    sourceRoomRevision: record.sourceRoomRevision,
    creatorParticipantId: record.creatorParticipantId,
    idempotencyRequestDigest: record.idempotencyRequestDigest ?? null,
    scope: structuredClone(record.scope),
    title: record.title,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    recordBytes,
  };
}

function serializeMetadata(metadata: SnapshotRetentionMetadata): string {
  const encoded = JSON.stringify(metadata);
  if (Buffer.byteLength(encoded, "utf8") > MAX_SNAPSHOT_METADATA_BYTES) {
    throw new DomainError(
      "ROOM_CAPACITY_EXCEEDED",
      "This snapshot's private history metadata exceeds Jazzboard's safe storage budget.",
      { snapshotMetadataBytesLimit: MAX_SNAPSHOT_METADATA_BYTES },
    );
  }
  return encoded;
}

function isSnapshotScope(value: unknown): value is SnapshotScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Partial<SnapshotScope>;
  return scope.kind === "room" || (
    scope.kind === "diagram" &&
    typeof scope.diagramId === "string" &&
    Number.isSafeInteger(scope.expectedDiagramRevision) &&
    Number(scope.expectedDiagramRevision) > 0
  );
}

function parseMetadata(value: string | null): SnapshotRetentionMetadata | null {
  if (!value || Buffer.byteLength(value, "utf8") > MAX_SNAPSHOT_METADATA_BYTES) return null;
  try {
    const metadata = JSON.parse(value) as Partial<SnapshotRetentionMetadata>;
    if (
      metadata.v !== 1 ||
      typeof metadata.id !== "string" ||
      typeof metadata.tokenHash !== "string" ||
      typeof metadata.sourceRoomId !== "string" ||
      !Number.isSafeInteger(metadata.sourceRoomRevision) ||
      Number(metadata.sourceRoomRevision) < 0 ||
      typeof metadata.creatorParticipantId !== "string" ||
      !(
        metadata.idempotencyRequestDigest === null ||
        typeof metadata.idempotencyRequestDigest === "string"
      ) ||
      !isSnapshotScope(metadata.scope) ||
      typeof metadata.title !== "string" ||
      !Number.isSafeInteger(metadata.createdAt) ||
      Number(metadata.createdAt) < 0 ||
      !Number.isSafeInteger(metadata.expiresAt) ||
      Number(metadata.expiresAt) <= Number(metadata.createdAt) ||
      !Number.isSafeInteger(metadata.recordBytes) ||
      Number(metadata.recordBytes) < 1 ||
      Number(metadata.recordBytes) > MAX_SNAPSHOT_RECORD_BYTES
    ) {
      return null;
    }
    return metadata as SnapshotRetentionMetadata;
  } catch {
    return null;
  }
}

function retentionIntegrityError(): DomainError {
  return new DomainError(
    "MUTATION_OUTCOME_UNKNOWN",
    "Jazzboard found inconsistent snapshot retention metadata and will not risk a partial history update.",
    { snapshotRetentionIntegrity: false },
  );
}

function snapshotVerificationUnavailable(): DomainError {
  return new DomainError(
    "MUTATION_OUTCOME_UNKNOWN",
    "Jazzboard could not verify whether the snapshot mutation committed. Refresh authoritative state before deciding whether to continue.",
    { replayed: false, verificationUnavailable: true },
  );
}

function committedSnapshotVerificationUnavailable(
  receipt: CompactMutationReceipt,
): DomainError {
  return new DomainError(
    "MUTATION_OUTCOME_UNKNOWN",
    "This snapshot mutation is proven committed, but Jazzboard cannot currently reconstruct its private response.",
    {
      replayed: true,
      verificationUnavailable: true,
      committedRoomRevision: receipt.committedRoomRevision,
    },
  );
}

function assertRecordSize(bytes: number): void {
  if (bytes > MAX_SNAPSHOT_RECORD_BYTES) {
    throw new DomainError(
      "ROOM_CAPACITY_EXCEEDED",
      "This snapshot exceeds Jazzboard's safe 3.5 MiB artifact budget.",
      { snapshotBytesUsed: bytes, snapshotBytesLimit: MAX_SNAPSHOT_RECORD_BYTES },
    );
  }
}

function currentRecord(record: ReadonlySnapshotRecord | null, now = Date.now()): ReadonlySnapshotRecord | null {
  return record && record.expiresAt > now ? record : null;
}

function addIndex(indexes: Map<string, Map<string, number>>, key: string, metadata: SnapshotRetentionMetadata): void {
  const index = indexes.get(key) ?? new Map<string, number>();
  index.set(metadata.id, metadata.createdAt);
  indexes.set(key, index);
}

function addMemoryMetadata(state: MemorySnapshotState, metadata: SnapshotRetentionMetadata): void {
  const creatorScope = creatorScopeKey(metadata.sourceRoomId, metadata.creatorParticipantId);
  state.metadata.set(metadata.id, structuredClone(metadata));
  addIndex(state.creatorIndexes, creatorScope, metadata);
  addIndex(state.roomIndexes, metadata.sourceRoomId, metadata);
  state.globalIndex.set(metadata.id, metadata.createdAt);
  state.creatorBytes.set(
    creatorScope,
    (state.creatorBytes.get(creatorScope) ?? 0) + metadata.recordBytes,
  );
  state.roomBytes.set(
    metadata.sourceRoomId,
    (state.roomBytes.get(metadata.sourceRoomId) ?? 0) + metadata.recordBytes,
  );
  state.deploymentBytes += metadata.recordBytes;
}

function subtractMemoryBytes(map: Map<string, number>, key: string, bytes: number): void {
  const next = (map.get(key) ?? 0) - bytes;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

function deleteMemoryRecord(state: MemorySnapshotState, record: ReadonlySnapshotRecord): void {
  const metadata = state.metadata.get(record.id);
  if (!metadata) throw retentionIntegrityError();
  const creatorScope = creatorScopeKey(metadata.sourceRoomId, metadata.creatorParticipantId);
  state.records.delete(record.id);
  state.tokenIndex.delete(record.tokenHash);
  state.metadata.delete(record.id);
  state.creatorIndexes.get(creatorScope)?.delete(record.id);
  state.roomIndexes.get(metadata.sourceRoomId)?.delete(record.id);
  state.globalIndex.delete(record.id);
  subtractMemoryBytes(state.creatorBytes, creatorScope, metadata.recordBytes);
  subtractMemoryBytes(state.roomBytes, metadata.sourceRoomId, metadata.recordBytes);
  state.deploymentBytes -= metadata.recordBytes;
}

function assertMemoryRetentionIntegrity(state: MemorySnapshotState): void {
  const creatorSums = new Map<string, number>();
  const roomSums = new Map<string, number>();
  let deploymentBytes = 0;
  const creatorIndexSize = [...state.creatorIndexes.values()].reduce(
    (total, index) => total + index.size,
    0,
  );
  const roomIndexSize = [...state.roomIndexes.values()].reduce(
    (total, index) => total + index.size,
    0,
  );
  if (
    state.records.size !== state.metadata.size ||
    state.tokenIndex.size !== state.metadata.size ||
    state.globalIndex.size !== state.metadata.size ||
    creatorIndexSize !== state.metadata.size ||
    roomIndexSize !== state.metadata.size
  ) {
    throw retentionIntegrityError();
  }
  for (const metadata of state.metadata.values()) {
    const record = state.records.get(metadata.id);
    const creatorScope = creatorScopeKey(metadata.sourceRoomId, metadata.creatorParticipantId);
    if (
      !record ||
      state.tokenIndex.get(metadata.tokenHash) !== metadata.id ||
      state.globalIndex.get(metadata.id) !== metadata.createdAt ||
      state.creatorIndexes.get(creatorScope)?.get(metadata.id) !== metadata.createdAt ||
      state.roomIndexes.get(metadata.sourceRoomId)?.get(metadata.id) !== metadata.createdAt ||
      encodedRecord(record).bytes !== metadata.recordBytes
    ) {
      throw retentionIntegrityError();
    }
    creatorSums.set(creatorScope, (creatorSums.get(creatorScope) ?? 0) + metadata.recordBytes);
    roomSums.set(
      metadata.sourceRoomId,
      (roomSums.get(metadata.sourceRoomId) ?? 0) + metadata.recordBytes,
    );
    deploymentBytes += metadata.recordBytes;
  }
  const sameCounters = (expected: Map<string, number>, actual: Map<string, number>) =>
    expected.size === actual.size &&
    [...expected].every(([key, value]) => actual.get(key) === value);
  if (
    !sameCounters(creatorSums, state.creatorBytes) ||
    !sameCounters(roomSums, state.roomBytes) ||
    deploymentBytes !== state.deploymentBytes
  ) {
    throw retentionIntegrityError();
  }
}

function pruneMemoryState(state: MemorySnapshotState, now = Date.now()): void {
  assertMemoryRetentionIntegrity(state);
  for (const record of state.records.values()) {
    if (record.expiresAt <= now) deleteMemoryRecord(state, record);
  }
  for (const [receiptKey, receipt] of state.mutationReceipts) {
    if (receipt.expiresAt <= now) state.mutationReceipts.delete(receiptKey);
  }
}

function revokeReceipt(snapshotId: string): CompactMutationReceipt | null {
  const identity = currentMutationContext()?.idempotency;
  if (!identity) return null;
  return createMutationReceipt({
    identity,
    outcome: "revoked",
    committedAt: Date.now(),
    committedRoomRevision: null,
    resourceId: snapshotId,
  });
}

function createReceipt(record: ReadonlySnapshotRecord): CompactMutationReceipt | null {
  const identity = currentMutationContext()?.idempotency;
  if (!identity) return null;
  const generatedSnapshotId = snapshotIdFromMutationGeneration(
    identity.scopedKeyHash,
    record.createdAt,
  );
  if (
    record.idempotencyRequestDigest !== identity.requestDigest ||
    record.id !== generatedSnapshotId
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "That Idempotency-Key does not match this snapshot mutation.",
    );
  }
  return createMutationReceipt({
    identity,
    outcome: SNAPSHOT_CREATE_OUTCOME,
    // This timestamp is the creation generation. Keeping it identical to the
    // record timestamp lets every contender derive the winning private record
    // without storing its raw identifier in the compact receipt.
    committedAt: record.createdAt,
    committedRoomRevision: record.sourceRoomRevision,
    resourceId: record.id,
  });
}

function missingCreateRecordError(): DomainError {
  return new DomainError(
    "MUTATION_OUTCOME_UNKNOWN",
    "This snapshot creation already completed, but its private artifact is no longer live. Jazzboard will not recreate the expired, evicted, or revoked capability.",
    { replayed: true, snapshotAvailable: false },
  );
}

type SnapshotCreateGeneration = {
  receipt: CompactMutationReceipt;
  snapshotId: string;
};

function createGenerationFromReceipt(
  encoded: string | null,
  expectedSourceRoomRevision: number,
): SnapshotCreateGeneration | null {
  if (!encoded) return null;
  const identity = currentMutationContext()?.idempotency;
  if (!identity) return null;
  const receipt = parseMutationReceipt(encoded);
  if (!receipt) {
    throw new DomainError(
      "MUTATION_OUTCOME_UNKNOWN",
      "Jazzboard found an unreadable snapshot-creation receipt and will not risk recreating a private capability.",
    );
  }
  assertReceiptMatches(receipt, identity);
  const snapshotId = snapshotIdFromMutationGeneration(
    identity.scopedKeyHash,
    receipt.committedAt,
  );
  if (
    receipt.outcome !== SNAPSHOT_CREATE_OUTCOME ||
    receipt.resourceIdHash !== sha256(snapshotId) ||
    receipt.committedRoomRevision !== expectedSourceRoomRevision
  ) {
    throw new DomainError(
      "MUTATION_OUTCOME_UNKNOWN",
      "Jazzboard could not verify the outcome of this snapshot creation.",
    );
  }
  return { receipt, snapshotId };
}

function assertRevokeReceipt(
  encoded: string | null,
  snapshotId: string,
): CompactMutationReceipt | null {
  if (!encoded) return null;
  const identity = currentMutationContext()?.idempotency;
  if (!identity) return null;
  const receipt = parseMutationReceipt(encoded);
  if (!receipt) {
    throw new DomainError(
      "MUTATION_OUTCOME_UNKNOWN",
      "Jazzboard found an unreadable snapshot-revocation receipt and will not risk an inconsistent retry.",
    );
  }
  assertReceiptMatches(receipt, identity);
  if (receipt.outcome !== "revoked" || receipt.resourceIdHash !== sha256(snapshotId)) {
    throw new DomainError(
      "MUTATION_OUTCOME_UNKNOWN",
      "Jazzboard could not verify the outcome of this snapshot revocation.",
    );
  }
  return receipt;
}

function oldestMetadata(
  metadata: SnapshotRetentionMetadata[],
  removed: Set<string>,
  newestRecordId: string,
  predicate: (item: SnapshotRetentionMetadata) => boolean,
): SnapshotRetentionMetadata | null {
  return metadata
    .filter((item) => item.id !== newestRecordId && !removed.has(item.id) && predicate(item))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0] ?? null;
}

function memoryRetentionEvictions(
  state: MemorySnapshotState,
  newest: SnapshotRetentionMetadata,
): string[] {
  const all = [...state.metadata.values(), newest];
  const removed = new Set<string>();
  const live = (predicate: (item: SnapshotRetentionMetadata) => boolean) =>
    all.filter((item) => !removed.has(item.id) && predicate(item));
  const evictUntil = (
    predicate: (item: SnapshotRetentionMetadata) => boolean,
    withinBudget: (items: SnapshotRetentionMetadata[]) => boolean,
  ) => {
    while (!withinBudget(live(predicate))) {
      const victim = oldestMetadata(all, removed, newest.id, predicate);
      if (!victim) {
        throw new DomainError(
          "ROOM_CAPACITY_EXCEEDED",
          "Jazzboard cannot fit this snapshot inside its retained-history budget.",
        );
      }
      removed.add(victim.id);
    }
  };

  const creator = (item: SnapshotRetentionMetadata) =>
    item.sourceRoomId === newest.sourceRoomId &&
    item.creatorParticipantId === newest.creatorParticipantId;
  evictUntil(creator, (items) =>
    items.length <= MAX_CREATOR_SNAPSHOTS &&
    items.reduce((total, item) => total + item.recordBytes, 0) <= MAX_CREATOR_SNAPSHOT_BYTES,
  );
  const room = (item: SnapshotRetentionMetadata) => item.sourceRoomId === newest.sourceRoomId;
  evictUntil(room, (items) =>
    items.length <= MAX_ROOM_SNAPSHOTS &&
    items.reduce((total, item) => total + item.recordBytes, 0) <= MAX_ROOM_SNAPSHOT_BYTES,
  );
  evictUntil(() => true, (items) =>
    items.length <= MAX_DEPLOYMENT_SNAPSHOTS &&
    items.reduce((total, item) => total + item.recordBytes, 0) <= MAX_DEPLOYMENT_SNAPSHOT_BYTES,
  );
  return [...removed];
}

function parseRecord(value: string | null): ReadonlySnapshotRecord | null {
  if (!value) return null;
  try {
    const record = JSON.parse(value) as Partial<ReadonlySnapshotRecord>;
    return typeof record.id === "string" &&
      typeof record.tokenHash === "string" &&
      typeof record.sourceRoomId === "string" &&
      typeof record.creatorParticipantId === "string" &&
      typeof record.expiresAt === "number" &&
      record.artifact !== undefined
      ? (record as ReadonlySnapshotRecord)
      : null;
  } catch {
    return null;
  }
}

type SnapshotCreateReplayInput = {
  sourceRoomId: string;
  sourceRoomRevision: number;
  creatorParticipantId: string;
};

function verifyCreateGenerationRecord(
  record: ReadonlySnapshotRecord,
  generation: SnapshotCreateGeneration,
  input: SnapshotCreateReplayInput,
): ReadonlySnapshotRecord {
  const identity = currentMutationContext()?.idempotency;
  if (!identity) {
    throw new DomainError(
      "MUTATION_OUTCOME_UNKNOWN",
      "Jazzboard could not verify the identity of this snapshot creation.",
    );
  }
  return replayedSnapshot(record, {
    id: generation.snapshotId,
    sourceRoomId: input.sourceRoomId,
    sourceRoomRevision: input.sourceRoomRevision,
    creatorParticipantId: input.creatorParticipantId,
    idempotencyRequestDigest: identity.requestDigest,
    createdAt: generation.receipt.committedAt,
  });
}

function verifyCreateGenerationMetadata(
  metadata: SnapshotRetentionMetadata,
  generation: SnapshotCreateGeneration,
  input: SnapshotCreateReplayInput,
): SnapshotCreateReplay {
  const identity = currentMutationContext()?.idempotency;
  if (
    !identity ||
    metadata.id !== generation.snapshotId ||
    metadata.idempotencyRequestDigest !== identity.requestDigest ||
    metadata.sourceRoomId !== input.sourceRoomId ||
    metadata.sourceRoomRevision !== input.sourceRoomRevision ||
    metadata.creatorParticipantId !== input.creatorParticipantId ||
    metadata.createdAt !== generation.receipt.committedAt ||
    metadata.expiresAt <= Date.now()
  ) {
    throw missingCreateRecordError();
  }
  return structuredClone({
    id: metadata.id,
    tokenHash: metadata.tokenHash,
    sourceRoomId: metadata.sourceRoomId,
    sourceRoomRevision: metadata.sourceRoomRevision,
    creatorParticipantId: metadata.creatorParticipantId,
    idempotencyRequestDigest: metadata.idempotencyRequestDigest,
    scope: metadata.scope,
    title: metadata.title,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
  });
}

function replayedSnapshotFromMetadata(
  requested: ReadonlySnapshotRecord,
  replay: SnapshotCreateReplay,
): ReadonlySnapshotRecord {
  if (
    !requested.idempotencyRequestDigest ||
    requested.idempotencyRequestDigest !== replay.idempotencyRequestDigest ||
    requested.sourceRoomId !== replay.sourceRoomId ||
    requested.sourceRoomRevision !== replay.sourceRoomRevision ||
    requested.creatorParticipantId !== replay.creatorParticipantId
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "That Idempotency-Key was already used for a different snapshot mutation.",
    );
  }
  return structuredClone({
    ...requested,
    id: replay.id,
    tokenHash: replay.tokenHash,
    scope: replay.scope,
    title: replay.title,
    createdAt: replay.createdAt,
    expiresAt: replay.expiresAt,
  });
}

export class SnapshotStore {
  constructor(private readonly redis: Redis | null = getRedisForAssets()) {}

  private createReplayFromMemoryReceipt(
    encodedReceipt: string | null,
    input: SnapshotCreateReplayInput,
  ): SnapshotCreateReplay | null {
    const generation = createGenerationFromReceipt(
      encodedReceipt,
      input.sourceRoomRevision,
    );
    if (!generation) return null;
    const state = memoryState();
    pruneMemoryState(state);
    const record = currentRecord(state.records.get(generation.snapshotId) ?? null);
    if (!record) throw missingCreateRecordError();
    const verified = verifyCreateGenerationRecord(record, generation, input);
    const metadata = state.metadata.get(verified.id);
    if (!metadata) throw retentionIntegrityError();
    return verifyCreateGenerationMetadata(metadata, generation, input);
  }

  private async createReplayFromReceipt(
    encodedReceipt: string | null,
    input: SnapshotCreateReplayInput,
  ): Promise<SnapshotCreateReplay | null> {
    if (!this.redis) {
      return this.createReplayFromMemoryReceipt(encodedReceipt, input);
    }
    const generation = createGenerationFromReceipt(
      encodedReceipt,
      input.sourceRoomRevision,
    );
    if (!generation) return null;
    let encodedMetadata: string | null;
    let actualBytes: number;
    try {
      [encodedMetadata, actualBytes] = await Promise.all([
        this.redis.get(metadataKey(generation.snapshotId)),
        this.redis.strlen(snapshotKey(generation.snapshotId)),
      ]);
    } catch {
      throw committedSnapshotVerificationUnavailable(generation.receipt);
    }
    const metadata = parseMetadata(encodedMetadata);
    if (!metadata) throw missingCreateRecordError();
    const replay = verifyCreateGenerationMetadata(metadata, generation, input);
    let indexedSnapshotId: string | null;
    try {
      indexedSnapshotId = await this.redis.get(tokenKey(metadata.tokenHash));
    } catch {
      throw committedSnapshotVerificationUnavailable(generation.receipt);
    }
    if (
      actualBytes !== metadata.recordBytes ||
      indexedSnapshotId !== metadata.id
    ) {
      throw missingCreateRecordError();
    }
    return replay;
  }

  async replayCreate(
    input: SnapshotCreateReplayInput,
  ): Promise<SnapshotCreateReplay | null> {
    const identity = currentMutationContext()?.idempotency ?? null;
    if (!identity) return null;

    let encodedReceipt: string | null;
    if (!this.redis) {
      const state = memoryState();
      pruneMemoryState(state);
      encodedReceipt = state.mutationReceipts.get(identity.receiptKey)?.encoded ?? null;
    } else {
      // The receipt determines the winning creation generation. Reading a
      // caller-derived candidate record first would be unsafe when concurrent
      // first attempts chose different timestamps.
      try {
        encodedReceipt = await this.redis.get(identity.receiptKey);
      } catch {
        throw snapshotVerificationUnavailable();
      }
    }
    const replay = await this.createReplayFromReceipt(encodedReceipt, input);
    if (replay) markCurrentMutationReplayed();
    return replay;
  }

  async create(
    input: Omit<ReadonlySnapshotRecord, "id"> & { id?: string },
  ): Promise<ReadonlySnapshotRecord> {
    const { id, ...recordInput } = input;
    const record: ReadonlySnapshotRecord = {
      ...recordInput,
      id: id ?? `snapshot_${randomUUID()}`,
    };
    const identity = currentMutationContext()?.idempotency ?? null;
    const receipt = createReceipt(record);
    const serializedReceipt = receipt ? serializeMutationReceipt(receipt) : "";
    const serializedRecord = encodedRecord(record);
    assertRecordSize(serializedRecord.bytes);
    const metadata = metadataFor(record, serializedRecord.bytes);
    const serializedMetadata = serializeMetadata(metadata);
    const ttlSeconds = Math.min(
      MAX_SNAPSHOT_TTL_SECONDS,
      Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1_000)),
    );
    if (!this.redis) {
      return withLocalMutationReceiptLock(identity?.receiptKey ?? null, async () => {
      const state = memoryState();
      pruneMemoryState(state);
      if (identity) {
        // Keep receipt check + first write in one synchronous turn so two
        // process-local contenders cannot both create different generations.
        const replay = this.createReplayFromMemoryReceipt(
          state.mutationReceipts.get(identity.receiptKey)?.encoded ?? null,
          record,
        );
        if (replay) {
          const verified = replayedSnapshotFromMetadata(record, replay);
          markCurrentMutationReplayed();
          return verified;
        }
      }
      const existing = currentRecord(state.records.get(record.id) ?? null);
      if (existing) {
        // An idempotent deterministic identity without its receipt is outside
        // the replay window. Never extend that window by silently minting a new
        // receipt around an older private capability.
        if (identity) {
          replayedSnapshot(existing, record);
          throw missingCreateRecordError();
        }
        return replayedSnapshot(existing, record);
      }
      const evictedIds = memoryRetentionEvictions(state, metadata);
      for (const evictedId of evictedIds) {
        const evicted = state.records.get(evictedId);
        if (!evicted) throw retentionIntegrityError();
        deleteMemoryRecord(state, evicted);
      }
      state.records.set(record.id, structuredClone(record));
      state.tokenIndex.set(record.tokenHash, record.id);
      addMemoryMetadata(state, metadata);
      if (identity && receipt) {
        state.mutationReceipts.set(identity.receiptKey, {
          encoded: serializedReceipt,
          expiresAt: Date.now() + IDEMPOTENCY_RECEIPT_TTL_SECONDS * 1_000,
        });
      }
      return structuredClone(record);
      });
    }

    const recoverCreate = async (): Promise<ReadonlySnapshotRecord | null> => {
      if (!identity) return null;
      let encodedReceipt: string | null;
      try {
        encodedReceipt = await this.redis!.get(identity.receiptKey);
      } catch {
        throw snapshotVerificationUnavailable();
      }
      const replay = await this.createReplayFromReceipt(
        encodedReceipt,
        record,
      );
      if (!replay) return null;
      const verified = replayedSnapshotFromMetadata(record, replay);
      markCurrentMutationReplayed();
      return verified;
    };
    let rawResult: unknown;
    try {
      rawResult = await this.redis.eval(
        CREATE_AND_PRUNE_REDIS_SNAPSHOTS_SCRIPT,
        10,
        snapshotKey(record.id),
        tokenKey(record.tokenHash),
        metadataKey(record.id),
        creatorKey(record.sourceRoomId, record.creatorParticipantId),
        roomKey(record.sourceRoomId),
        SNAPSHOT_GLOBAL_INDEX_KEY,
        creatorBytesKey(record.sourceRoomId, record.creatorParticipantId),
        roomBytesKey(record.sourceRoomId),
        SNAPSHOT_GLOBAL_BYTES_KEY,
        identity?.receiptKey ?? metadataKey(record.id),
        serializedRecord.encoded,
        serializedMetadata,
        serializedRecord.bytes.toString(),
        ttlSeconds.toString(),
        record.id,
        record.createdAt.toString(),
        Date.now().toString(),
        record.sourceRoomId,
        record.creatorParticipantId,
        MAX_SNAPSHOT_RECORD_BYTES.toString(),
        MAX_CREATOR_SNAPSHOT_BYTES.toString(),
        MAX_ROOM_SNAPSHOT_BYTES.toString(),
        MAX_DEPLOYMENT_SNAPSHOT_BYTES.toString(),
        MAX_CREATOR_SNAPSHOTS.toString(),
        SNAPSHOT_KEY_PREFIX,
        SNAPSHOT_TOKEN_KEY_PREFIX,
        SNAPSHOT_METADATA_KEY_PREFIX,
        SNAPSHOT_CREATOR_KEY_PREFIX,
        SNAPSHOT_ROOM_KEY_PREFIX,
        SNAPSHOT_CREATOR_BYTES_KEY_PREFIX,
        SNAPSHOT_ROOM_BYTES_KEY_PREFIX,
        serializedReceipt,
        receipt ? IDEMPOTENCY_RECEIPT_TTL_SECONDS.toString() : "0",
        MAX_ROOM_SNAPSHOTS.toString(),
        MAX_DEPLOYMENT_SNAPSHOTS.toString(),
      );
    } catch (error) {
      const recovered = await recoverCreate();
      if (recovered) return recovered;
      if (error instanceof DomainError) throw error;
      throw snapshotVerificationUnavailable();
    }

    const result = Array.isArray(rawResult) ? rawResult : [];
    const outcome = result[0];
    const resultReceipt = typeof result[1] === "string" ? result[1] : null;
    if (outcome === "created") {
      const resultMetadata = parseMetadata(
        typeof result[2] === "string" ? result[2] : null,
      );
      if (!resultMetadata || result[2] !== serializedMetadata) {
        throw retentionIntegrityError();
      }
      if (identity) {
        const generation = createGenerationFromReceipt(
          resultReceipt,
          record.sourceRoomRevision,
        );
        if (!generation) throw missingCreateRecordError();
        verifyCreateGenerationMetadata(resultMetadata, generation, record);
      }
      return structuredClone(record);
    }
    if (outcome === "replay") {
      const replay = await this.createReplayFromReceipt(resultReceipt, record);
      if (replay) {
        const verified = replayedSnapshotFromMetadata(record, replay);
        markCurrentMutationReplayed();
        return verified;
      }
      throw new DomainError(
        "MUTATION_OUTCOME_UNKNOWN",
        "Jazzboard could not verify the stored snapshot-creation receipt.",
      );
    }
    if (outcome === "orphan") {
      throw missingCreateRecordError();
    }
    if (outcome === "record_too_large" || outcome === "capacity_error") {
      throw new DomainError(
        "ROOM_CAPACITY_EXCEEDED",
        "This snapshot cannot fit inside Jazzboard's safe retained-history budget.",
      );
    }
    if (outcome === "integrity_error") throw retentionIntegrityError();
    const recovered = await recoverCreate();
    if (recovered) return recovered;
    throw new DomainError(
      "MUTATION_OUTCOME_UNKNOWN",
      "Jazzboard could not verify the outcome of this snapshot creation.",
    );
  }

  async getByTokenHash(tokenHash: string): Promise<ReadonlySnapshotRecord | null> {
    if (!this.redis) {
      const state = memoryState();
      pruneMemoryState(state);
      const snapshotId = state.tokenIndex.get(tokenHash);
      const record = snapshotId ? currentRecord(state.records.get(snapshotId) ?? null) : null;
      if (!record && snapshotId) {
        const expired = state.records.get(snapshotId);
        if (expired) deleteMemoryRecord(state, expired);
        else throw retentionIntegrityError();
      }
      return record ? structuredClone(record) : null;
    }
    const rawResult = await this.redis.eval(
      READ_REDIS_SNAPSHOT_BY_TOKEN_SCRIPT,
      3,
      tokenKey(tokenHash),
      SNAPSHOT_GLOBAL_INDEX_KEY,
      SNAPSHOT_GLOBAL_BYTES_KEY,
      tokenHash,
      Date.now().toString(),
      SNAPSHOT_KEY_PREFIX,
      SNAPSHOT_METADATA_KEY_PREFIX,
      SNAPSHOT_CREATOR_KEY_PREFIX,
      SNAPSHOT_ROOM_KEY_PREFIX,
      SNAPSHOT_CREATOR_BYTES_KEY_PREFIX,
      SNAPSHOT_ROOM_BYTES_KEY_PREFIX,
    );
    const result = Array.isArray(rawResult) ? rawResult : [];
    if (result[0] === "not_found") return null;
    if (result[0] === "integrity_error") throw retentionIntegrityError();
    if (result[0] !== "found" || typeof result[1] !== "string") {
      throw retentionIntegrityError();
    }
    const record = currentRecord(parseRecord(result[1]));
    if (!record || record.tokenHash !== tokenHash) throw retentionIntegrityError();
    return record;
  }

  async listForCreator(roomId: string, participantId: string): Promise<ReadonlySnapshotSummary[]> {
    if (!this.redis) {
      const state = memoryState();
      pruneMemoryState(state);
      const index = state.creatorIndexes.get(creatorScopeKey(roomId, participantId));
      return [...(index?.entries() ?? [])]
        .sort(([leftId, leftScore], [rightId, rightScore]) =>
          rightScore - leftScore || rightId.localeCompare(leftId),
        )
        .map(([snapshotId]) => {
          const metadata = state.metadata.get(snapshotId);
          if (!metadata) throw retentionIntegrityError();
          return metadata;
        })
        .slice(0, MAX_CREATOR_SNAPSHOTS)
        .map(summaryFor);
    }
    const rawResult = await this.redis.eval(
      LIST_REDIS_SNAPSHOTS_SCRIPT,
      6,
      creatorKey(roomId, participantId),
      creatorBytesKey(roomId, participantId),
      roomKey(roomId),
      roomBytesKey(roomId),
      SNAPSHOT_GLOBAL_INDEX_KEY,
      SNAPSHOT_GLOBAL_BYTES_KEY,
      roomId,
      participantId,
      Date.now().toString(),
      MAX_CREATOR_SNAPSHOTS.toString(),
      MAX_CREATOR_SNAPSHOT_BYTES.toString(),
      SNAPSHOT_KEY_PREFIX,
      SNAPSHOT_TOKEN_KEY_PREFIX,
      SNAPSHOT_METADATA_KEY_PREFIX,
      SNAPSHOT_ROOM_KEY_PREFIX,
    );
    const result = Array.isArray(rawResult) ? rawResult : [];
    if (result[0] === "integrity_error") throw retentionIntegrityError();
    if (result[0] !== "ok") throw retentionIntegrityError();
    return result.slice(1).map((encoded) => {
      const metadata = parseMetadata(typeof encoded === "string" ? encoded : null);
      if (
        !metadata ||
        metadata.sourceRoomId !== roomId ||
        metadata.creatorParticipantId !== participantId ||
        metadata.expiresAt <= Date.now()
      ) {
        throw retentionIntegrityError();
      }
      return summaryFor(metadata);
    });
  }

  async revoke(roomId: string, participantId: string, snapshotId: string): Promise<boolean> {
    const identity = currentMutationContext()?.idempotency ?? null;
    const receipt = revokeReceipt(snapshotId);
    if (!this.redis) {
      return withLocalMutationReceiptLock(identity?.receiptKey ?? null, async () => {
      const state = memoryState();
      pruneMemoryState(state);
      if (identity) {
        const replay = state.mutationReceipts.get(identity.receiptKey);
        if (assertRevokeReceipt(replay?.encoded ?? null, snapshotId)) {
          markCurrentMutationReplayed();
          return true;
        }
      }
      const record = state.records.get(snapshotId);
      if (!record || record.sourceRoomId !== roomId || record.creatorParticipantId !== participantId) {
        return false;
      }
      deleteMemoryRecord(state, record);
      if (identity && receipt) {
        state.mutationReceipts.set(identity.receiptKey, {
          encoded: serializeMutationReceipt(receipt),
          expiresAt: Date.now() + IDEMPOTENCY_RECEIPT_TTL_SECONDS * 1_000,
        });
      }
      return true;
      });
    }
    const encodedReceipt = receipt ? serializeMutationReceipt(receipt) : "";
    let rawResult: unknown;
    try {
      rawResult = await this.redis.eval(
        REVOKE_IDEMPOTENT_REDIS_SNAPSHOT_SCRIPT,
        9,
        identity?.receiptKey ?? metadataKey(snapshotId),
        snapshotKey(snapshotId),
        metadataKey(snapshotId),
        creatorKey(roomId, participantId),
        roomKey(roomId),
        SNAPSHOT_GLOBAL_INDEX_KEY,
        creatorBytesKey(roomId, participantId),
        roomBytesKey(roomId),
        SNAPSHOT_GLOBAL_BYTES_KEY,
        encodedReceipt,
        receipt ? IDEMPOTENCY_RECEIPT_TTL_SECONDS.toString() : "0",
        roomId,
        participantId,
        snapshotId,
        SNAPSHOT_TOKEN_KEY_PREFIX,
        Date.now().toString(),
      );
    } catch {
      if (identity) {
        let recovered: string | null;
        try {
          recovered = await this.redis.get(identity.receiptKey);
        } catch {
          throw snapshotVerificationUnavailable();
        }
        if (assertRevokeReceipt(recovered, snapshotId)) {
          markCurrentMutationReplayed();
          return true;
        }
      }
      throw snapshotVerificationUnavailable();
    }
    const result = Array.isArray(rawResult) ? rawResult : [];
    const outcome = result[0];
    if (outcome === "replay") {
      const replay = assertRevokeReceipt(
        typeof result[1] === "string" ? result[1] : null,
        snapshotId,
      );
      if (!replay) return false;
      markCurrentMutationReplayed();
      return true;
    }
    if (outcome === "revoked") {
      if (identity) {
        assertRevokeReceipt(typeof result[1] === "string" ? result[1] : null, snapshotId);
      }
      return true;
    }
    if (outcome === "not_found") return false;
    if (outcome === "integrity_error") throw retentionIntegrityError();
    throw new DomainError(
      "MUTATION_OUTCOME_UNKNOWN",
      "Jazzboard could not verify the outcome of this snapshot revocation.",
    );
  }
}

function replayedSnapshot(
  persisted: ReadonlySnapshotRecord,
  requested: Pick<
    ReadonlySnapshotRecord,
    | "id"
    | "sourceRoomId"
    | "sourceRoomRevision"
    | "creatorParticipantId"
    | "idempotencyRequestDigest"
    | "createdAt"
  >,
): ReadonlySnapshotRecord {
  if (
    !requested.idempotencyRequestDigest ||
    persisted.id !== requested.id ||
    persisted.idempotencyRequestDigest !== requested.idempotencyRequestDigest ||
    persisted.sourceRoomId !== requested.sourceRoomId ||
    persisted.sourceRoomRevision !== requested.sourceRoomRevision ||
    persisted.creatorParticipantId !== requested.creatorParticipantId ||
    persisted.createdAt !== requested.createdAt
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "That Idempotency-Key was already used for a different snapshot mutation.",
    );
  }
  return structuredClone(persisted);
}

function summaryFor(record: ReadonlySnapshotSummary): ReadonlySnapshotSummary {
  return {
    id: record.id,
    sourceRoomRevision: record.sourceRoomRevision,
    scope: record.scope,
    title: record.title,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

let defaultSnapshotStore: SnapshotStore | null = null;

export function getSnapshotStore(): SnapshotStore {
  defaultSnapshotStore ??= new SnapshotStore();
  return defaultSnapshotStore;
}

/** Test-only reset for deterministic process-local service coverage. */
export function resetSnapshotStoreForTests(): SnapshotStore {
  globalThis.__jazzboardSnapshotState = undefined;
  resetLocalMutationReceiptStateForTests();
  defaultSnapshotStore = new SnapshotStore(null);
  return defaultSnapshotStore;
}
