import type { ActorKind } from "@/lib/domain/types";

import { errorResponse, json } from "./http";
import {
  createReadonlySnapshotRequestSchema,
  revokeReadonlySnapshotRequestSchema,
} from "./snapshot-schemas";
import {
  createReadonlySnapshot,
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

export async function handleCreateReadonlySnapshot(
  request: Request,
  context: RoomRouteContext,
  actorKind: ActorKind,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = createReadonlySnapshotRequestSchema.parse(await request.json());
    const result = await createReadonlySnapshot({
      roomId,
      participantId,
      actorKind,
      ...body,
    });
    return json({ ok: true, ...result }, { status: 201 });
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
    const body = revokeReadonlySnapshotRequestSchema.parse(await request.json());
    const result = await revokeReadonlySnapshot({
      roomId,
      participantId,
      actorKind,
      snapshotId: body.snapshotId,
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
