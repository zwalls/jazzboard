import { presenceRequestSchema } from "@/lib/domain/schemas";
import { DomainError } from "@/lib/domain/errors";
import { errorResponse, json, readJsonBody } from "@/lib/server/http";
import { updatePresence } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

type Context = { params: Promise<{ roomId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    if (request.headers.get("x-jazzboard-presence-protocol") !== "delta-v1") {
      throw new DomainError(
        "CLIENT_UPGRADE_REQUIRED",
        "This Jazzboard tab must be refreshed before it can safely publish live presence.",
      );
    }
    const { roomId } = await context.params;
    const body = presenceRequestSchema.omit({ actorKind: true }).parse(await readJsonBody(request));
    const presence = await updatePresence({ ...body, roomId, participantId, actorKind: "human" });
    return json({ ok: true, presence });
  } catch (error) {
    return errorResponse(error);
  }
}
