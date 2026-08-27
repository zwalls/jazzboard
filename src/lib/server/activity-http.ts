import { z } from "zod";

import {
  activityListQuerySchema,
  revertActivityBodySchema,
} from "@/lib/domain/schemas";
import type { ActorKind } from "@/lib/domain/types";
import { errorResponse, json, readJsonBody, runMutationRequest } from "@/lib/server/http";
import {
  listRoomActivities,
  readRoomActivity,
  runActivityRevert,
} from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

type RouteContext = { params: Promise<{ roomId: string }> };
type ActivityRouteContext = { params: Promise<{ roomId: string; activityId: string }> };
const activityPathIdSchema = z.string().min(1).max(128);

function activityErrorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return json(
      {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "The activity request does not match Jazzboard's review schema.",
          details: { issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
        },
      },
      { status: 400 },
    );
  }
  return errorResponse(error);
}

export async function handleActivityGet(request: Request, context: RouteContext): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const entries = Object.fromEntries(new URL(request.url).searchParams);
    const query = activityListQuerySchema.parse(entries);
    return json({ ok: true, ...(await listRoomActivities({ roomId, participantId, ...query })) });
  } catch (error) {
    return activityErrorResponse(error);
  }
}

export async function handleActivityRead(request: Request, context: ActivityRouteContext): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId, activityId: rawActivityId } = await context.params;
    const activityId = activityPathIdSchema.parse(rawActivityId);
    const activity = await readRoomActivity({ roomId, participantId, activityId });
    return json({ ok: true, activity });
  } catch (error) {
    return activityErrorResponse(error);
  }
}

/** Actor kind is selected by the route and is never accepted from request JSON. */
export async function handleActivityMutation(
  request: Request,
  context: ActivityRouteContext,
  actorKind: ActorKind,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId, activityId: rawActivityId } = await context.params;
    const activityId = activityPathIdSchema.parse(rawActivityId);
    const body = revertActivityBodySchema.parse(await readJsonBody(request));
    const result = await runMutationRequest({
      request,
      participantId,
      roomId,
      operation: "room.activity.revert",
      actorKind,
      parsedBody: { activityId, ...body },
      execute: () => runActivityRevert({
        roomId,
        participantId,
        actorKind,
        revert: { activityId, ...body },
      }),
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return activityErrorResponse(error);
  }
}
