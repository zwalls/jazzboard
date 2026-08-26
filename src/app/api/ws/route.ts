import { experimental_upgradeWebSocket } from "@vercel/functions";

import { DomainError } from "@/lib/domain/errors";
import { REALTIME_MAX_CLIENT_PAYLOAD_BYTES, parseStreamCursor } from "@/lib/realtime/protocol";
import { errorResponse } from "@/lib/server/http";
import { readAuthorizedRoom } from "@/lib/server/room-service";
import { getRealtimeHub } from "@/lib/server/realtime-hub";
import { requireGuestParticipantId } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROOM_ID_PATTERN = /^room_[A-Za-z0-9_-]{1,128}$/;

function requestPublicOrigin(request: Request, url: URL): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host") || url.host;
  const protocol = forwardedProtocol || url.protocol.replace(":", "");
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return url.origin;
  }
}

function requireSameOrigin(request: Request, url: URL): void {
  const suppliedOrigin = request.headers.get("origin");
  let origin: string;
  try {
    origin = suppliedOrigin ? new URL(suppliedOrigin).origin : "";
  } catch {
    origin = "";
  }
  if (!origin || origin !== requestPublicOrigin(request, url)) {
    throw new DomainError("FORBIDDEN", "Realtime connections must originate from this Jazzboard site.");
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const url = new URL(request.url);
    requireSameOrigin(request, url);
    const roomId = url.searchParams.get("roomId") ?? "";
    if (!ROOM_ID_PATTERN.test(roomId)) {
      throw new DomainError("INVALID_OPERATION", "A valid roomId is required for realtime connection.");
    }

    const suppliedCursor = url.searchParams.get("cursor");
    const cursor = parseStreamCursor(suppliedCursor);
    if (suppliedCursor && !cursor) {
      throw new DomainError("INVALID_OPERATION", "The realtime resume cursor is invalid.");
    }

    // Reject unauthenticated/non-member requests before upgrading the HTTP socket.
    await readAuthorizedRoom(roomId, participantId);

    return experimental_upgradeWebSocket(
      (socket) => {
        // This callback intentionally remains synchronous. RealtimeHub attaches
        // message/close/error handlers before it starts any asynchronous work.
        getRealtimeHub().attach(socket, { roomId, participantId, cursor });
      },
      { maxPayload: REALTIME_MAX_CLIENT_PAYLOAD_BYTES },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
