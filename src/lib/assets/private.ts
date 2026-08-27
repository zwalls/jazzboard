import { createHash } from "node:crypto";

/**
 * Stable one-way namespace for private Blob paths. Provider paths and logs do
 * not reveal Jazzboard's internal room identifier.
 */
export function roomBlobNamespace(roomId: string): string {
  return createHash("sha256")
    .update(`jazzboard:blob-room:v1\0${roomId}`)
    .digest("hex")
    .slice(0, 48);
}
