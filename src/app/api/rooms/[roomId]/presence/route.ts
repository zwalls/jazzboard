import { presenceRequestSchema } from "@/lib/domain/schemas";
import { errorResponse, json } from "@/lib/server/http";
import { updatePresence } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

type Context = { params: Promise<{ roomId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = presenceRequestSchema.omit({ actorKind: true }).parse(await request.json());
    const room = await updatePresence({ ...body, roomId, participantId, actorKind: "human" });
    return json({ ok: true, room });
  } catch (error) {
    return errorResponse(error);
  }
}
