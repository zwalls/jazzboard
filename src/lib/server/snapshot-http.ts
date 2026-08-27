import type { ActorKind } from "@/lib/domain/types";

import { errorResponse, json, readJsonBody, runMutationRequest } from "./http";
import {
  revokeReadonlySnapshotRequestSchema,
} from "./snapshot-schemas";
import {
  listReadonlySnapshots,
  readPublicSnapshot,
  revokeReadonlySnapshot,
} from "./snapshot-service";
import { requireGuestParticipantId } from "./session";

type RoomRouteContext = { params: Promise<{ roomId: string }> };
type PublicRouteContext = { params: Promise<{ token: string }> };

export async function handleListReadonlySnapshots(
  request: Request,
  context: RoomRouteContext,
  actorKind: ActorKind,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const result = await listReadonlySnapshots({ roomId, participantId, actorKind });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Stable retirement response for tabs or clients that cached the old
 * snapshot-creation surface. This intentionally performs no snapshot work.
 */
export function handleRetiredReadonlySnapshotCreation(request: Request): Response {
  try {
    requireGuestParticipantId(request);
    return json(
      {
        ok: false,
        error: {
          code: "SNAPSHOT_ISSUANCE_RETIRED",
          message: "Jazzboard no longer creates hosted snapshot links. Download a local PNG instead.",
          details: null,
        },
      },
      { status: 410 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleRevokeReadonlySnapshot(
  request: Request,
  context: RoomRouteContext,
  actorKind: ActorKind,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = revokeReadonlySnapshotRequestSchema.parse(await readJsonBody(request));
    const result = await runMutationRequest({
      request,
      participantId,
      roomId,
      operation: "room.snapshot.revoke",
      actorKind,
      parsedBody: body,
      execute: () => revokeReadonlySnapshot({
        roomId,
        participantId,
        actorKind,
        snapshotId: body.snapshotId,
      }),
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleReadPublicSnapshot(
  _request: Request,
  context: PublicRouteContext,
): Promise<Response> {
  try {
    const { token } = await context.params;
    const snapshot = await readPublicSnapshot(token);
    return json(
      { ok: true, snapshot },
      {
        headers: {
          "cache-control": "private, no-store, max-age=0",
          "x-robots-tag": "noindex, nofollow, noarchive",
        },
      },
    );
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    return response;
  }
}
