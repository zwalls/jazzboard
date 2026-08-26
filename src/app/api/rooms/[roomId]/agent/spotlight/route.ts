import { spotlightRequestSchema } from "@/lib/domain/schemas";
import { errorResponse, json } from "@/lib/server/http";
import { updateSpotlight } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

type Context = { params: Promise<{ roomId: string }> };

/**
 * Agent-owned Spotlight lifecycle route. Actor identity is selected by the
 * route, never caller JSON, and the signed guest session still supplies room
 * membership and role authorization.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = spotlightRequestSchema.parse(await request.json());
    const room = await updateSpotlight({
      roomId,
      participantId,
      actorKind: "agent",
      action: body.action,
      target: "target" in body ? body.target : undefined,
    });
    return json({ ok: true, room });
  } catch (error) {
    return errorResponse(error);
  }
}
