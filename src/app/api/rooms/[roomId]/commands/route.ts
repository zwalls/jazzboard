import { z } from "zod";

import { activityMutationMetadataSchema, canvasCommandSchema } from "@/lib/domain/schemas";
import { errorResponse, json } from "@/lib/server/http";
import { runCanvasCommand } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

type Context = { params: Promise<{ roomId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const { command, metadata } = z
      .object({ command: canvasCommandSchema, metadata: activityMutationMetadataSchema.optional() })
      .parse(await request.json());
    const result = await runCanvasCommand({ roomId, participantId, actorKind: "human", command, metadata });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
