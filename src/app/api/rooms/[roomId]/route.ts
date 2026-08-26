import { z } from "zod";

import { errorResponse, json } from "@/lib/server/http";
import { readAuthorizedRoom, upgradeMembership } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ roomId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const room = await readAuthorizedRoom(roomId, participantId);
    return json({ ok: true, room, participantId });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = z.object({ action: z.literal("upgrade_role") }).parse(await request.json());
    const room = await upgradeMembership(roomId, participantId);
    return json({ ok: true, room, participantId, action: body.action });
  } catch (error) {
    return errorResponse(error);
  }
}
