import { createHash } from "node:crypto";

import type { ActorKind } from "@/lib/domain/types";
import { DomainError } from "@/lib/domain/errors";

export const IDEMPOTENCY_RECEIPT_VERSION = 1 as const;
export const IDEMPOTENCY_RECEIPT_TTL_SECONDS = 24 * 60 * 60;
export const MAX_IDEMPOTENCY_RECEIPT_BYTES = 2 * 1024;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const NAMESPACE_PATTERN = /^[a-z][a-z0-9_.:-]{0,79}$/;
const OUTCOME_PATTERN = /^[a-z][a-z0-9_.:-]{0,47}$/;
const RECEIPT_KEY_PREFIX = "jazzboard:mutation:v1:";

export type MutationIdentity = {
  namespace: string;
  actorKind: ActorKind;
  requestDigest: string;
  scopedKeyHash: string;
  receiptKey: string;
};

export type LocalMutationReceipt = {
  encoded: string;
  expiresAt: number;
};

type LocalMutationReceiptState = {
  receipts: Map<string, LocalMutationReceipt>;
  queues: Map<string, Promise<void>>;
};

declare global {
  var __jazzboardLocalMutationReceiptState: LocalMutationReceiptState | undefined;
}

export function localMutationReceiptState(): LocalMutationReceiptState {
  globalThis.__jazzboardLocalMutationReceiptState ??= {
    receipts: new Map(),
    queues: new Map(),
  };
  return globalThis.__jazzboardLocalMutationReceiptState;
}

export async function withLocalMutationReceiptLock<T>(
  receiptKey: string | null,
  callback: () => Promise<T>,
): Promise<T> {
  if (!receiptKey) return callback();
  const queues = localMutationReceiptState().queues;
  const previous = queues.get(receiptKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  queues.set(receiptKey, queued);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (queues.get(receiptKey) === queued) queues.delete(receiptKey);
  }
}

/** Test-only reset for process-local parity coverage. */
export function resetLocalMutationReceiptStateForTests(): void {
  globalThis.__jazzboardLocalMutationReceiptState = undefined;
}

export type MutationReceiptInput = {
  identity: MutationIdentity;
  outcome: string;
  committedAt: number;
  committedRoomRevision: number | null;
  activityId?: string | null;
  proposalId?: string | null;
  resourceId?: string | null;
  changedObjectCount?: number;
  changedDiagramCount?: number;
};

/**
 * Compact, content-free proof that one logical mutation committed. Resource
 * references are one-way hashes so receipts do not become another private-data
 * store or an enumeration surface.
 */
export type CompactMutationReceipt = {
  v: typeof IDEMPOTENCY_RECEIPT_VERSION;
  namespace: string;
  actorKind: ActorKind;
  requestDigest: string;
  outcome: string;
  committedAt: number;
  committedRoomRevision: number | null;
  activityIdHash: string | null;
  proposalIdHash: string | null;
  resourceIdHash: string | null;
  changedObjectCount: number;
  changedDiagramCount: number;
};

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseIdempotencyKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new DomainError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must contain 8–128 ASCII letters, digits, periods, underscores, colons, or hyphens.",
    );
  }
  return value;
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Mutation inputs must contain finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalJsonValue(record[key])]),
    );
  }
  throw new Error("Mutation inputs must be JSON-serializable.");
}

export function canonicalMutationJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function requireControlledToken(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`${label} is not a valid controlled token.`);
  return value;
}

export function mutationRequestDigest(input: {
  method: string;
  namespace: string;
  actorKind: ActorKind;
  resourceScope?: string | null;
  body: unknown;
}): string {
  const namespace = requireControlledToken(input.namespace, NAMESPACE_PATTERN, "Mutation namespace");
  return sha256(canonicalMutationJson({
    actorKind: input.actorKind,
    body: input.body,
    method: input.method.toUpperCase(),
    namespace,
    resourceScope: input.resourceScope ?? null,
  }));
}

export function createMutationIdentity(input: {
  participantId: string;
  idempotencyKey: string;
  namespace: string;
  actorKind: ActorKind;
  method: string;
  resourceScope?: string | null;
  body: unknown;
}): MutationIdentity {
  const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
  if (!idempotencyKey) throw new Error("An idempotency key is required to create a mutation identity.");
  const namespace = requireControlledToken(input.namespace, NAMESPACE_PATTERN, "Mutation namespace");
  const scopedKeyHash = sha256(
    `${IDEMPOTENCY_RECEIPT_VERSION}\0${input.participantId}\0${idempotencyKey}`,
  );
  return {
    namespace,
    actorKind: input.actorKind,
    requestDigest: mutationRequestDigest({ ...input, namespace }),
    scopedKeyHash,
    receiptKey: `${RECEIPT_KEY_PREFIX}${scopedKeyHash}`,
  };
}

function optionalIdentifierHash(value: string | null | undefined): string | null {
  return value ? sha256(value) : null;
}

function nonnegativeInteger(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Receipt counts must be nonnegative safe integers.");
  return value;
}

export function createMutationReceipt(input: MutationReceiptInput): CompactMutationReceipt {
  requireControlledToken(input.identity.namespace, NAMESPACE_PATTERN, "Mutation namespace");
  if (!HASH_PATTERN.test(input.identity.requestDigest)) {
    throw new Error("Mutation requestDigest must be a SHA-256 digest.");
  }
  requireControlledToken(input.outcome, OUTCOME_PATTERN, "Mutation outcome");
  if (!Number.isSafeInteger(input.committedAt) || input.committedAt < 0) {
    throw new Error("Receipt committedAt must be a nonnegative safe integer.");
  }
  if (
    input.committedRoomRevision !== null &&
    (!Number.isSafeInteger(input.committedRoomRevision) || input.committedRoomRevision < 0)
  ) {
    throw new Error("Receipt room revision must be null or a nonnegative safe integer.");
  }
  return {
    v: IDEMPOTENCY_RECEIPT_VERSION,
    namespace: input.identity.namespace,
    actorKind: input.identity.actorKind,
    requestDigest: input.identity.requestDigest,
    outcome: input.outcome,
    committedAt: input.committedAt,
    committedRoomRevision: input.committedRoomRevision,
    activityIdHash: optionalIdentifierHash(input.activityId),
    proposalIdHash: optionalIdentifierHash(input.proposalId),
    resourceIdHash: optionalIdentifierHash(input.resourceId),
    changedObjectCount: nonnegativeInteger(input.changedObjectCount),
    changedDiagramCount: nonnegativeInteger(input.changedDiagramCount),
  };
}

export function serializeMutationReceipt(receipt: CompactMutationReceipt): string {
  const serialized = JSON.stringify({
    v: receipt.v,
    namespace: receipt.namespace,
    actorKind: receipt.actorKind,
    requestDigest: receipt.requestDigest,
    outcome: receipt.outcome,
    committedAt: receipt.committedAt,
    committedRoomRevision: receipt.committedRoomRevision,
    activityIdHash: receipt.activityIdHash,
    proposalIdHash: receipt.proposalIdHash,
    resourceIdHash: receipt.resourceIdHash,
    changedObjectCount: receipt.changedObjectCount,
    changedDiagramCount: receipt.changedDiagramCount,
  } satisfies CompactMutationReceipt);
  if (Buffer.byteLength(serialized, "utf8") > MAX_IDEMPOTENCY_RECEIPT_BYTES) {
    throw new Error("The compact mutation receipt exceeds its storage budget.");
  }
  return serialized;
}

function isNullableHash(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && HASH_PATTERN.test(value));
}

export function parseMutationReceipt(value: string | null): CompactMutationReceipt | null {
  if (!value || Buffer.byteLength(value, "utf8") > MAX_IDEMPOTENCY_RECEIPT_BYTES) return null;
  try {
    const receipt = JSON.parse(value) as Partial<CompactMutationReceipt>;
    if (
      receipt.v !== IDEMPOTENCY_RECEIPT_VERSION ||
      typeof receipt.namespace !== "string" ||
      !NAMESPACE_PATTERN.test(receipt.namespace) ||
      (receipt.actorKind !== "human" && receipt.actorKind !== "agent") ||
      typeof receipt.requestDigest !== "string" ||
      !HASH_PATTERN.test(receipt.requestDigest) ||
      typeof receipt.outcome !== "string" ||
      !OUTCOME_PATTERN.test(receipt.outcome) ||
      !Number.isSafeInteger(receipt.committedAt) ||
      Number(receipt.committedAt) < 0 ||
      !(
        receipt.committedRoomRevision === null ||
        (Number.isSafeInteger(receipt.committedRoomRevision) && Number(receipt.committedRoomRevision) >= 0)
      ) ||
      !isNullableHash(receipt.activityIdHash) ||
      !isNullableHash(receipt.proposalIdHash) ||
      !isNullableHash(receipt.resourceIdHash) ||
      !Number.isSafeInteger(receipt.changedObjectCount) ||
      Number(receipt.changedObjectCount) < 0 ||
      !Number.isSafeInteger(receipt.changedDiagramCount) ||
      Number(receipt.changedDiagramCount) < 0
    ) {
      return null;
    }
    return {
      v: IDEMPOTENCY_RECEIPT_VERSION,
      namespace: receipt.namespace,
      actorKind: receipt.actorKind,
      requestDigest: receipt.requestDigest,
      outcome: receipt.outcome,
      committedAt: receipt.committedAt,
      committedRoomRevision: receipt.committedRoomRevision,
      activityIdHash: receipt.activityIdHash,
      proposalIdHash: receipt.proposalIdHash,
      resourceIdHash: receipt.resourceIdHash,
      changedObjectCount: receipt.changedObjectCount,
      changedDiagramCount: receipt.changedDiagramCount,
    } as CompactMutationReceipt;
  } catch {
    return null;
  }
}

export function assertReceiptMatches(
  receipt: CompactMutationReceipt,
  identity: MutationIdentity,
): void {
  if (
    receipt.namespace !== identity.namespace ||
    receipt.actorKind !== identity.actorKind ||
    receipt.requestDigest !== identity.requestDigest
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "That Idempotency-Key was already used for a different mutation.",
    );
  }
}
