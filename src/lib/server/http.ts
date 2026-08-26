import { DomainError, isDomainError } from "@/lib/domain/errors";
import { ZodError } from "zod";

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof Error && error.message === "AUTH_REQUIRED") {
    return json({ ok: false, error: { code: "AUTH_REQUIRED", message: "A guest session is required." } }, { status: 401 });
  }
  if (isDomainError(error)) {
    const status =
      error.code === "ROOM_NOT_FOUND" ||
      error.code === "OBJECT_NOT_FOUND" ||
      error.code === "DIAGRAM_NOT_FOUND" ||
      error.code === "SNAPSHOT_NOT_FOUND"
        ? 404
        : error.code === "AUTH_REQUIRED"
          ? 401
          : error.code === "FORBIDDEN"
            ? 403
            : error.code === "OBJECT_BUSY" || error.code === "REVISION_CONFLICT"
              ? 409
              : 400;
    return json(
      {
        ok: false,
        error: { code: error.code, message: error.message, details: error.details ?? null },
      },
      { status },
    );
  }
  if (error instanceof ZodError) {
    return json(
      {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "The request does not match Jazzboard's schema.",
          details: {
            issues: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        },
      },
      { status: 400 },
    );
  }
  if (error instanceof SyntaxError) {
    return json({ ok: false, error: { code: "INVALID_REQUEST", message: "Request body is not valid JSON." } }, { status: 400 });
  }
  console.error(error);
  return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "Jazzboard could not complete that request." } }, { status: 500 });
}

export function requireMembership(room: { participants: Record<string, unknown> }, participantId: string): void {
  if (!room.participants[participantId]) {
    throw new DomainError("FORBIDDEN", "This guest session is not a member of the room.");
  }
}
