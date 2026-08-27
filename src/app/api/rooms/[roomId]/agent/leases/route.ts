import { objectLeaseActionSchema } from "@/lib/domain/schemas";
import { errorResponse, json, readJsonBody } from "@/lib/server/http";
import { runLeaseAction } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

type Context = { params: Promise<{ roomId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = objectLeaseActionSchema.parse(await readJsonBody(request));
    const result = await runLeaseAction({ ...body, roomId, participantId, actorKind: "agent" });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
