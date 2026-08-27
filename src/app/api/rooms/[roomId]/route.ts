import { z } from "zod";

import { DomainError } from "@/lib/domain/errors";
import {
  CLIENT_CAPABILITIES_HEADER,
  SPLIT_STATE_CLIENT_CAPABILITY,
} from "@/lib/realtime/protocol";
import { errorResponse, json, readJsonBody, runMutationRequest } from "@/lib/server/http";
import { readAuthorizedRoom, upgradeMembership } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ roomId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const capabilities = new Set(
      (request.headers.get(CLIENT_CAPABILITIES_HEADER) ?? "")
        .split(",")
        .map((capability) => capability.trim())
        .filter(Boolean),
    );
    if (!capabilities.has(SPLIT_STATE_CLIENT_CAPABILITY)) {
      throw new DomainError(
        "CLIENT_UPGRADE_REQUIRED",
        "This Jazzboard tab must be refreshed before it can safely read live state.",
      );
    }
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
    const body = z.object({ action: z.literal("upgrade_role") }).parse(await readJsonBody(request));
    const room = await runMutationRequest({
      request,
      participantId,
      roomId,
      operation: "room.upgrade_role",
      actorKind: "human",
      parsedBody: body,
      execute: () => upgradeMembership(roomId, participantId),
    });
    return json({ ok: true, room, participantId, action: body.action });
  } catch (error) {
    return errorResponse(error);
  }
}
