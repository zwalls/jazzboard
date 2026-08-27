import { DomainError, isDomainError } from "@/lib/domain/errors";
import { ZodError } from "zod";

import { DEFAULT_JSON_REQUEST_BYTES } from "./capacity";
import {
  createMutationContext,
  mutationDurationMs,
  runWithMutationContext,
} from "./mutation-context";
import { emitTelemetry, unknownErrorTelemetryFields } from "./telemetry";
import type { ActorKind } from "@/lib/domain/types";

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof Error && error.message === "AUTH_REQUIRED") {
    return json({ ok: false, error: { code: "AUTH_REQUIRED", message: "A guest session is required." } }, { status: 401 });
  }
  if (isDomainError(error)) {
    const status =
      error.code === "ROOM_NOT_FOUND" ||
      error.code === "OBJECT_NOT_FOUND" ||
      error.code === "DIAGRAM_NOT_FOUND" ||
      error.code === "SNAPSHOT_NOT_FOUND" ||
      error.code === "MESSAGE_NOT_FOUND"
        ? 404
        : error.code === "AUTH_REQUIRED"
          ? 401
          : error.code === "FORBIDDEN"
            ? 403
            : error.code === "OBJECT_BUSY" ||
                error.code === "REVISION_CONFLICT" ||
                error.code === "IDEMPOTENCY_CONFLICT" ||
                error.code === "MESSAGE_ALREADY_CLAIMED" ||
                error.code === "MESSAGE_ALREADY_ANSWERED" ||
                error.code === "MESSAGE_CLAIM_REQUIRED" ||
                error.code === "MESSAGE_CLAIM_EXPIRED"
              ? 409
              : error.code === "REQUEST_TOO_LARGE" ||
                  error.code === "ROOM_CAPACITY_EXCEEDED" ||
                  error.code === "ASSET_CAPACITY_EXCEEDED"
                ? 413
              : error.code === "CLIENT_UPGRADE_REQUIRED"
                ? 426
                : error.code === "MUTATION_OUTCOME_UNKNOWN"
                  ? 503
                  : 400;
    return json(
      {
        ok: false,
        error: { code: error.code, message: error.message, details: error.details ?? null },
      },
      { status },
    );
  }
  if (error instanceof ZodError) {
    return json(
      {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "The request does not match Jazzboard's schema.",
          details: {
            issues: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        },
      },
      { status: 400 },
    );
  }
  if (error instanceof SyntaxError) {
    return json({ ok: false, error: { code: "INVALID_REQUEST", message: "Request body is not valid JSON." } }, { status: 400 });
  }
  emitTelemetry({
    event: "server.error",
    level: "error",
    errorCode: "INTERNAL_ERROR",
    ...unknownErrorTelemetryFields(error),
  });
  return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "Jazzboard could not complete that request." } }, { status: 500 });
}

export async function readJsonBody(
  request: Request,
  options: { maximumBytes?: number } = {},
): Promise<unknown> {
  const maximumBytes = options.maximumBytes ?? DEFAULT_JSON_REQUEST_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("maximumBytes must be a positive safe integer.");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
      throw new DomainError(
        "REQUEST_TOO_LARGE",
        "The JSON request exceeds Jazzboard's safe request size.",
        { maximumBytes, receivedBytes: Math.floor(declaredBytes) },
      );
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return JSON.parse("");
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DomainError(
        "REQUEST_TOO_LARGE",
        "The JSON request exceeds Jazzboard's safe request size.",
        { maximumBytes, receivedBytes },
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError("Request body is not valid UTF-8 JSON.");
  }
  return JSON.parse(text);
}

export async function runMutationRequest<T>(input: {
  request: Request;
  participantId: string;
  roomId?: string | null;
  operation: string;
  actorKind: ActorKind;
  parsedBody: unknown;
  execute: () => Promise<T>;
}): Promise<T> {
  const context = createMutationContext(input);
  try {
    const result = await runWithMutationContext(context, input.execute);
    emitTelemetry({
      event: "mutation.completed",
      level: "info",
      requestId: context.requestId,
      operation: context.operation,
      actorKind: context.actorKind,
      outcome: context.replayed ? "replayed" : "committed",
      replayed: context.replayed,
      durationMs: mutationDurationMs(context),
      participantHash: context.participantHash,
      roomHash: context.roomHash ?? undefined,
      mutationHash: context.idempotency?.scopedKeyHash,
    });
    return result;
  } catch (error) {
    emitTelemetry({
      event: "mutation.failed",
      level: error instanceof DomainError && error.code === "MUTATION_OUTCOME_UNKNOWN" ? "warn" : "error",
      requestId: context.requestId,
      operation: context.operation,
      actorKind: context.actorKind,
      errorCode: isDomainError(error) ? error.code : "INTERNAL_ERROR",
      replayed:
        context.replayed ||
        isDomainError(error) &&
        error.code === "MUTATION_OUTCOME_UNKNOWN" &&
        error.details !== undefined &&
        "replayed" in error.details &&
        error.details.replayed === true,
      durationMs: mutationDurationMs(context),
      participantHash: context.participantHash,
      roomHash: context.roomHash ?? undefined,
      mutationHash: context.idempotency?.scopedKeyHash,
    });
    throw error;
  }
}

export function requireMembership(room: { participants: Record<string, unknown> }, participantId: string): void {
  if (!room.participants[participantId]) {
    throw new DomainError("FORBIDDEN", "This guest session is not a member of the room.");
  }
}
