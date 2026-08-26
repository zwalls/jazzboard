import { spotlightRequestSchema } from "@/lib/domain/schemas";
import { errorResponse, json } from "@/lib/server/http";
import { updateSpotlight } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

type Context = { params: Promise<{ roomId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = spotlightRequestSchema.parse(await request.json());
    const room = await updateSpotlight({
      roomId,
      participantId,
      actorKind: "human",
      action: body.action,
      target: "target" in body ? body.target : undefined,
    });
    return json({ ok: true, room });
  } catch (error) {
    return errorResponse(error);
  }
}
