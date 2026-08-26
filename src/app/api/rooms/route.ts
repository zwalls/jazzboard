import { createRoomRequestSchema, joinRoomRequestSchema } from "@/lib/domain/schemas";
import { errorResponse, json } from "@/lib/server/http";
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

export async function POST(request: Request): Promise<Response> {
  let setCookie: string | null = null;
  try {
    const session = getOrCreateGuestSession(request);
    setCookie = session.setCookie;
    const body = (await request.json()) as unknown;
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
                message: "Joining requires one exact four-digit room code, a display name, and a role.",
              },
            },
            { status: 400 },
          ),
          setCookie,
        );
      }

      const limit = await consumeJoinAttempt(session.participantId);
      if (!limit.allowed) {
        return withGuestCookie(rateLimitedResponse(limit), setCookie);
      }
      room = await store.joinRoom({ participantId: session.participantId, ...parsed.data });
    } else if (action === "create") {
      room = await store.createRoom({
        participantId: session.participantId,
        ...createRoomRequestSchema.parse(body),
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
