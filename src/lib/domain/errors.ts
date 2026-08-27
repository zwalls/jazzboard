import type { ObjectBusyDetails } from "./types";

export type DomainErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "ROOM_NOT_FOUND"
  | "OBJECT_NOT_FOUND"
  | "DIAGRAM_NOT_FOUND"
  | "SNAPSHOT_NOT_FOUND"
  | "OBJECT_BUSY"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_IDEMPOTENCY_KEY"
  | "INVALID_GUEST_BOOTSTRAP"
  | "MUTATION_OUTCOME_UNKNOWN"
  | "REQUEST_TOO_LARGE"
  | "ROOM_CAPACITY_EXCEEDED"
  | "ASSET_CAPACITY_EXCEEDED"
  | "CLIENT_UPGRADE_REQUIRED"
  | "LEASE_NOT_FOUND"
  | "INVALID_OPERATION";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details?: Record<string, unknown> | ObjectBusyDetails,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
