import { z } from "zod";

import { requireMutationRole, requireParticipant } from "@/lib/domain/engine";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import { errorResponse, json, readJsonBody } from "@/lib/server/http";
import {
  createRemoteMcpGrant,
  listRemoteMcpGrants,
  remoteGrantAccessSchema,
  remoteGrantIdSchema,
  remoteRoomIdSchema,
  revokeRemoteMcpGrant,
} from "@/lib/server/remote-mcp-auth";
import { loadRemoteMcpConfiguration } from "@/lib/server/remote-mcp-config";
import { readAuthorizedRoom } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ roomId: string }> };

const actionInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), label: z.string().trim().min(1).max(64), access: remoteGrantAccessSchema }),
  z.strictObject({ action: z.literal("revoke"), id: remoteGrantIdSchema }),
]);

async function manage(request: Request, context: RouteContext): Promise<Response> {
  const config = loadRemoteMcpConfiguration();
  if (!config || new URL(request.url).origin !== config.resource.origin) {
    return json({ error: "Not found." }, { status: 404 });
  }
  try {
    if (request.method === "POST" && request.headers.get("origin") !== config.resource.origin) {
      throw new DomainError("FORBIDDEN", "Open the room in Jazzboard to manage its connections.");
    }
    const participantId = requireGuestParticipantId(request);
    const roomId = remoteRoomIdSchema.parse((await context.params).roomId);
    const room = await readAuthorizedRoom(roomId, participantId);
    const participant = requireParticipant(room, participantId);

    if (request.method === "GET") {
      return json({
        ok: true,
        endpoint: config.resource.href,
        canEdit: participant.role === "participant",
        connections: await listRemoteMcpGrants(config.resource, roomId, participantId),
      });
    }

    const input = actionInput.parse(await readJsonBody(request, { maximumBytes: 4096 }));
    if (input.action === "create") {
      if (input.access === "write") requireMutationRole(participant, "agent");
      const connection = await createRemoteMcpGrant(config.resource, {
        roomId, participantId, label: input.label, access: input.access,
      });
      return json({ ok: true, connection }, { status: 201 });
    }
    if (!await revokeRemoteMcpGrant(config.resource, roomId, participantId, input.id)) {
      throw new DomainError("FORBIDDEN", "This connection is unavailable to this guest session.");
    }
    return json({ ok: true });
  } catch (error) {
    return errorResponse(isDomainError(error) && error.code === "ROOM_NOT_FOUND"
      ? new DomainError("FORBIDDEN", "This guest session is not a member of the room.")
      : error);
  }
}

export { manage as GET, manage as POST };
