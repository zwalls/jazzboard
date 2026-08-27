import { spotlightRequestSchema } from "@/lib/domain/schemas";
import { errorResponse, json, readJsonBody, runMutationRequest } from "@/lib/server/http";
import { updateSpotlight } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

type Context = { params: Promise<{ roomId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = spotlightRequestSchema.parse(await readJsonBody(request));
    const room = await runMutationRequest({
      request,
      participantId,
      roomId,
      operation: "room.spotlight.update",
      actorKind: "human",
      parsedBody: body,
      execute: () => updateSpotlight({
        roomId,
        participantId,
        actorKind: "human",
        action: body.action,
        target: "target" in body ? body.target : undefined,
      }),
    });
    return json({ ok: true, room });
  } catch (error) {
    return errorResponse(error);
  }
}
