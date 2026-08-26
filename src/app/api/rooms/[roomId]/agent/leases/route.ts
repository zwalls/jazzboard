import { z } from "zod";

import { leaseOperationSchema } from "@/lib/domain/schemas";
import { errorResponse, json } from "@/lib/server/http";
import { runLeaseAction } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

const agentLeaseSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("acquire"),
    objectId: z.string().min(1).max(128),
    expectedRevision: z.number().int().positive(),
    operation: leaseOperationSchema,
  }),
  z.object({
    action: z.enum(["renew", "release"]),
    objectId: z.string().min(1).max(128),
    leaseId: z.string().min(1).max(128),
  }),
]);

type Context = { params: Promise<{ roomId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = agentLeaseSchema.parse(await request.json());
    const result = await runLeaseAction({ ...body, roomId, participantId, actorKind: "agent" });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
