import { z } from "zod";

import { activityMutationMetadataSchema, layoutCommandSchema, semanticTransactionSchema } from "@/lib/domain/schemas";
import type { ActorKind } from "@/lib/domain/types";
import { errorResponse, json, readJsonBody, runMutationRequest } from "@/lib/server/http";
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
    const body = semanticRequestSchema.parse(await readJsonBody(request));
    const result = await runMutationRequest({
      request,
      participantId,
      roomId,
      operation: body.action === "transaction" ? "room.semantic.transaction" : "room.semantic.layout",
      actorKind,
      parsedBody: body,
      execute: () => body.action === "transaction"
        ? runSemanticTransaction({ roomId, participantId, actorKind, transaction: body.transaction, metadata: body.metadata })
        : runLayoutCommand({ roomId, participantId, actorKind, layout: body.layout, metadata: body.metadata }),
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
