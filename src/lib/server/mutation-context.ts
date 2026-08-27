import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import type { ActorKind } from "@/lib/domain/types";

import {
  createMutationIdentity,
  parseIdempotencyKey,
  sha256,
  type MutationIdentity,
} from "./idempotency";

export type MutationContext = {
  requestId: string;
  operation: string;
  actorKind: ActorKind;
  startedAt: number;
  participantHash: string;
  roomHash: string | null;
  idempotency: MutationIdentity | null;
  /** Set only after a stored receipt/resource has been verified and replayed. */
  replayed: boolean;
};

const mutationContextStorage = new AsyncLocalStorage<MutationContext>();

export type CreateMutationContextInput = {
  request: Pick<Request, "headers" | "method">;
  participantId: string;
  roomId?: string | null;
  operation: string;
  actorKind: ActorKind;
  parsedBody: unknown;
  now?: () => number;
  createRequestId?: () => string;
};

function scopedIdentifierHash(kind: "participant" | "room", value: string): string {
  return sha256(`jazzboard:${kind}:v1\0${value}`);
}

/**
 * Builds an internal context without retaining the raw cookie identity,
 * Idempotency-Key, room code, request body, or other user-authored content.
 */
export function createMutationContext(input: CreateMutationContextInput): MutationContext {
  const idempotencyKey = parseIdempotencyKey(input.request.headers.get("idempotency-key"));
  return {
    requestId: (input.createRequestId ?? (() => `request_${randomUUID()}`))(),
    operation: input.operation,
    actorKind: input.actorKind,
    startedAt: (input.now ?? Date.now)(),
    participantHash: scopedIdentifierHash("participant", input.participantId),
    roomHash: input.roomId ? scopedIdentifierHash("room", input.roomId) : null,
    replayed: false,
    idempotency: idempotencyKey
      ? createMutationIdentity({
          participantId: input.participantId,
          idempotencyKey,
          namespace: input.operation,
          actorKind: input.actorKind,
          method: input.request.method,
          resourceScope: input.roomId ?? null,
          body: input.parsedBody,
        })
      : null,
  };
}

export function mutationDurationMs(context: MutationContext, now = Date.now()): number {
  return Math.max(0, now - context.startedAt);
}

export function runWithMutationContext<T>(
  context: MutationContext,
  callback: () => T,
): T {
  return mutationContextStorage.run(context, callback);
}

export function currentMutationContext(): MutationContext | null {
  return mutationContextStorage.getStore() ?? null;
}

export function markCurrentMutationReplayed(): void {
  const context = currentMutationContext();
  if (context) context.replayed = true;
}
