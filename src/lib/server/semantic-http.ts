import { z } from "zod";

import { activityMutationMetadataSchema, layoutCommandSchema, semanticTransactionSchema } from "@/lib/domain/schemas";
import type { ActorKind } from "@/lib/domain/types";
import { errorResponse, json } from "@/lib/server/http";
import { runLayoutCommand, runSemanticTransaction } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

type RouteContext = { params: Promise<{ roomId: string }> };

const semanticRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("transaction"),
    transaction: semanticTransactionSchema,
    metadata: activityMutationMetadataSchema.optional(),
  }).strict(),
  z.object({
    action: z.literal("layout"),
    layout: layoutCommandSchema,
    metadata: activityMutationMetadataSchema.optional(),
  }).strict(),
]);

/** Shared handler for actor-kind-specific routes; actorKind is never accepted from request JSON. */
export async function handleSemanticRequest(
  request: Request,
  context: RouteContext,
  actorKind: ActorKind,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = semanticRequestSchema.parse(await request.json());
    const result = body.action === "transaction"
      ? await runSemanticTransaction({ roomId, participantId, actorKind, transaction: body.transaction, metadata: body.metadata })
      : await runLayoutCommand({ roomId, participantId, actorKind, layout: body.layout, metadata: body.metadata });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
