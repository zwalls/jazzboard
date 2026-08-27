export const BLOB_MAXIMUM_SIZE_IN_BYTES = 10 * 1024 * 1024;
export const REDIS_FALLBACK_MAXIMUM_SIZE_IN_BYTES = 4 * 1024 * 1024;
export const PRIVATE_BLOB_NAMESPACE_PATTERN = /^[a-f0-9]{48}$/;
export const PRIVATE_BLOB_UUID_V4_LEAF_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-.+/i;

export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type AssetStorageMode =
  | "vercel-blob"
  | "redis-fallback"
  | "local-memory"
  | "unavailable";

export function isSupportedImageMimeType(
  mimeType: string,
): mimeType is (typeof SUPPORTED_IMAGE_MIME_TYPES)[number] {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

function safeFileName(fileName: string): string {
  const leaf = fileName.split(/[\\/]/).at(-1) ?? "";
  const sanitized = leaf
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f?#]/g, "_")
    .trim()
    .slice(0, 180);
  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : "image";
}

export function blobAssetPathname(roomNamespace: string, fileName: string): string {
  if (!PRIVATE_BLOB_NAMESPACE_PATTERN.test(roomNamespace)) {
    throw new Error("A private Blob pathname requires Jazzboard's opaque room namespace.");
  }
  const leaf = safeFileName(fileName);
  if (!PRIVATE_BLOB_UUID_V4_LEAF_PATTERN.test(leaf)) {
    throw new Error("A private Blob pathname requires a UUID-v4-prefixed filename.");
  }
  return `jazzboard/${roomNamespace}/${leaf}`;
}

export function isRoomBlobPathname(roomNamespace: string, pathname: string): boolean {
  if (!PRIVATE_BLOB_NAMESPACE_PATTERN.test(roomNamespace)) return false;
  const prefix = `jazzboard/${roomNamespace}/`;
  if (!pathname.startsWith(prefix)) return false;
  const fileName = pathname.slice(prefix.length);
  return (
    fileName.length > 0 &&
    fileName.length <= 180 &&
    fileName !== "." &&
    fileName !== ".." &&
    !/[\\/\u0000-\u001f\u007f?#]/.test(fileName) &&
    PRIVATE_BLOB_UUID_V4_LEAF_PATTERN.test(fileName)
  );
}

export function isDedicatedPrivateBlobPathname(pathname: string): boolean {
  const match = /^jazzboard\/([^/]+)\/(.+)$/.exec(pathname);
  return Boolean(match && isRoomBlobPathname(match[1], pathname));
}

export type RoomAssetProxyReference = {
  roomId: string;
  pathname: string | null;
  assetId: string | null;
};

export function privateAssetProxyPath(roomId: string, pathname: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/assets?pathname=${encodeURIComponent(pathname)}`;
}

export function legacyAssetProxyPath(roomId: string, assetId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/assets?assetId=${encodeURIComponent(assetId)}`;
}

export function parseRoomAssetProxyReference(value: string): RoomAssetProxyReference | null {
  if (value.length > 8_192) return null;
  try {
    const relative = value.startsWith("/");
    const parsed = new URL(value, "https://jazzboard.invalid");
    if (
      parsed.hash ||
      (!relative && parsed.protocol !== "https:" && parsed.protocol !== "http:")
    ) {
      return null;
    }
    const match = /^\/api\/rooms\/([^/]+)\/assets$/.exec(parsed.pathname);
    if (!match) return null;
    const roomId = decodeURIComponent(match[1]);
    if (!roomId || roomId.length > 128 || /[/?#\u0000-\u001f\u007f]/.test(roomId)) return null;
    const entries = [...parsed.searchParams.entries()];
    if (entries.length !== 1) return null;
    const [key, selectedValue] = entries[0];
    if (key === "pathname" && selectedValue.length > 0 && selectedValue.length <= 320) {
      return { roomId, pathname: selectedValue, assetId: null };
    }
    if (
      key === "assetId" &&
      selectedValue.length > 0 &&
      selectedValue.length <= 512 &&
      !/[\u0000-\u001f\u007f]/.test(selectedValue)
    ) {
      return { roomId, pathname: null, assetId: selectedValue };
    }
    return null;
  } catch {
    return null;
  }
}

export function canonicalRoomAssetProxyPath(reference: RoomAssetProxyReference): string {
  if (reference.pathname !== null) {
    return privateAssetProxyPath(reference.roomId, reference.pathname);
  }
  return legacyAssetProxyPath(reference.roomId, reference.assetId!);
}

export function isCanvasImageUrl(value: string): boolean {
  if (parseRoomAssetProxyReference(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function maximumAssetSizeInBytes(mode: AssetStorageMode): number {
  if (mode === "redis-fallback") return REDIS_FALLBACK_MAXIMUM_SIZE_IN_BYTES;
  if (mode === "unavailable") return 0;
  return BLOB_MAXIMUM_SIZE_IN_BYTES;
}
