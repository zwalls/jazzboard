import { randomInt } from "node:crypto";

import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "@/lib/domain/room-code";

export const ROOM_CODE_ALLOCATION_MAX_ATTEMPTS = 100;

/** Creates one cryptographically random current-format room-code candidate. */
export function generateRoomCode(): string {
  return Array.from(
    { length: ROOM_CODE_LENGTH },
    () => ROOM_CODE_ALPHABET[randomInt(0, ROOM_CODE_ALPHABET.length)],
  ).join("");
}

/**
 * Claims a unique code against the synchronous process-local room index.
 * Distributed Redis allocation remains an atomic Lua operation in room-store.
 */
export function allocateLocalRoomCode(
  isAllocated: (code: string) => boolean,
  createCandidate: () => string = generateRoomCode,
): string {
  for (let attempt = 0; attempt < ROOM_CODE_ALLOCATION_MAX_ATTEMPTS; attempt += 1) {
    const code = createCandidate();
    if (!isAllocated(code)) return code;
  }
  throw new Error("Unable to allocate a unique room code.");
}
