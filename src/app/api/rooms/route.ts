import { createRoomRequestSchema, joinRoomRequestSchema } from "@/lib/domain/schemas";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import { errorResponse, json, readJsonBody, runMutationRequest } from "@/lib/server/http";
import { mutationRequestDigest, parseIdempotencyKey } from "@/lib/server/idempotency";
import { consumeJoinAttempt, type JoinAttemptLimit } from "@/lib/server/join-attempt-limiter";
import { getRoomStore } from "@/lib/server/room-store";
import { getOrCreateGuestSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

function withGuestCookie(response: Response, setCookie: string | null): Response {
  if (setCookie) response.headers.set("set-cookie", setCookie);
  return response;
}

function rateLimitedResponse(limit: JoinAttemptLimit): Response {
  return json(
    {
      ok: false,
      error: {
        code: "JOIN_RATE_LIMITED",
        message: `Too many room-code attempts. Try again in ${limit.retryAfterSeconds} seconds.`,
        details: {
          limit: limit.limit,
          remaining: limit.remaining,
          retryAfterSeconds: limit.retryAfterSeconds,
        },
      },
    },
    {
      status: 429,
      headers: { "retry-after": limit.retryAfterSeconds.toString() },
    },
  );
}

function joinUnavailableResponse(): Response {
  return json(
    {
      ok: false,
      error: {
        code: "JOIN_UNAVAILABLE",
        message: "Jazzboard could not complete that join right now. Try again shortly.",
      },
    },
    { status: 503 },
  );
}

export async function POST(request: Request): Promise<Response> {
  let setCookie: string | null = null;
  try {
    const session = getOrCreateGuestSession(request);
    setCookie = session.setCookie;
    const body = await readJsonBody(request);
    const action = typeof body === "object" && body !== null && "action" in body
      ? body.action
      : undefined;
    const store = getRoomStore();
    let room;

    if (action === "join") {
      const parsed = joinRoomRequestSchema.safeParse(body);
      if (!parsed.success) {
        return withGuestCookie(
          json(
            {
              ok: false,
              error: {
                code: "INVALID_REQUEST",
                message: "Joining requires one valid private room code, a display name, and a role.",
              },
            },
            { status: 400 },
          ),
          setCookie,
        );
      }

      const idempotencyKey = parseIdempotencyKey(request.headers.get("idempotency-key"));
      let limit: JoinAttemptLimit;
      try {
        limit = await consumeJoinAttempt(
          session.participantId,
          request,
          idempotencyKey
            ? {
                idempotencyKey,
                requestDigest: mutationRequestDigest({
                  method: request.method,
                  namespace: "room.join",
                  actorKind: "human",
                  body: parsed.data,
                }),
              }
            : null,
        );
      } catch {
        return withGuestCookie(joinUnavailableResponse(), setCookie);
      }
      if (!limit.allowed) {
        return withGuestCookie(rateLimitedResponse(limit), setCookie);
      }
      try {
        room = await runMutationRequest({
          request,
          participantId: session.participantId,
          operation: "room.join",
          actorKind: "human",
          parsedBody: parsed.data,
          execute: () => store.joinRoom({ participantId: session.participantId, ...parsed.data }),
        });
      } catch (error) {
        if (isDomainError(error) && error.code === "ROOM_NOT_FOUND") {
          throw new DomainError("ROOM_NOT_FOUND", "Jazzboard could not join with that code.");
        }
        throw error;
      }
    } else if (action === "create") {
      const parsed = createRoomRequestSchema.parse(body);
      room = await runMutationRequest({
        request,
        participantId: session.participantId,
        operation: "room.create",
        actorKind: "human",
        parsedBody: parsed,
        execute: () => store.createRoom({
          participantId: session.participantId,
          ...parsed,
        }),
      });
    } else {
      return withGuestCookie(
        json(
          {
            ok: false,
            error: {
              code: "INVALID_REQUEST",
              message: 'Room requests require an action of exactly "create" or "join".',
            },
          },
          { status: 400 },
        ),
        setCookie,
      );
    }

    return withGuestCookie(
      json({ ok: true, room, participantId: session.participantId }),
      setCookie,
    );
  } catch (error) {
    return withGuestCookie(errorResponse(error), setCookie);
  }
}
