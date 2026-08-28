import { upload } from "@vercel/blob/client";

import {
  blobAssetPathname,
  isSupportedImageMimeType,
  privateAssetProxyPath,
  type AssetStorageMode,
} from "@/lib/assets/policy";

import { apiRequest } from "./api";

export type JazzboardRoomImageUpload = Readonly<{
  /** Origin-neutral, authenticated room asset reference safe to persist. */
  url: string;
  assetId: string | null;
  mimeType: string;
  sourceUrl: string | null;
  storage: Exclude<AssetStorageMode, "unavailable" | "vercel-blob"> | "vercel-blob-private";
  pathname: string | null;
}>;

export type JazzboardImageUploadOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
  /** Optional HTTP(S) provenance. Upload bytes always come from `file`. */
  sourceUrl?: string | null;
}>;

function validatedSourceUrl(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.length > 8_192) throw new Error("Image source provenance is too long.");
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error("Image source provenance must be an HTTP(S) URL.");
  }
  return value;
}

/**
 * Renderer-neutral authorized image upload used by both canvas adapters.
 *
 * It returns only a room-scoped proxy reference after server finalization;
 * callers never persist a public Blob URL or renderer asset record.
 */
export async function uploadJazzboardRoomImage(
  roomId: string,
  file: File,
  options: JazzboardImageUploadOptions = {},
): Promise<JazzboardRoomImageUpload> {
  const sourceUrl = validatedSourceUrl(options.sourceUrl);
  const config = await apiRequest<{
    ok: true;
    mode: AssetStorageMode;
    maximumSizeInBytes: number;
    uploadNamespace?: string;
  }>(`/api/rooms/${encodeURIComponent(roomId)}/assets`);
  if (config.mode === "unavailable") {
    throw new Error("Image uploads are temporarily unavailable.");
  }
  if (file.size > config.maximumSizeInBytes) {
    throw new Error(`Images must be smaller than ${Math.round(config.maximumSizeInBytes / 1024 / 1024)} MB.`);
  }
  if (!isSupportedImageMimeType(file.type)) {
    throw new Error("Jazzboard accepts JPEG, PNG, WebP, and GIF images only.");
  }

  if (config.mode !== "vercel-blob") {
    options.onProgress?.(15);
    const formData = new FormData();
    formData.set("file", file);
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/assets`, {
      method: "POST",
      body: formData,
      signal: options.signal,
    });
    const result = (await response.json()) as {
      ok: boolean;
      url?: string;
      assetId?: string;
      error?: { message?: string };
    };
    if (!response.ok || !result.ok || !result.url) {
      throw new Error(result.error?.message ?? "The local demo image could not be stored.");
    }
    options.onProgress?.(100);
    return Object.freeze({
      url: result.url,
      assetId: result.assetId ?? null,
      mimeType: file.type,
      sourceUrl,
      storage: config.mode,
      pathname: null,
    });
  }

  if (!config.uploadNamespace) {
    throw new Error("Private image storage is not configured for this room.");
  }
  const blob = await upload(
    blobAssetPathname(config.uploadNamespace, `${crypto.randomUUID()}-${file.name}`),
    file,
    {
      access: "private",
      contentType: file.type,
      handleUploadUrl: `/api/rooms/${encodeURIComponent(roomId)}/assets`,
      multipart: file.size > 5 * 1024 * 1024,
      abortSignal: options.signal,
      onUploadProgress: ({ percentage }) => options.onProgress?.(percentage),
    },
  );
  await apiRequest<{ ok: true }>(
    `/api/rooms/${encodeURIComponent(roomId)}/assets`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "jazzboard.asset-finalize",
        payload: { pathname: blob.pathname },
      }),
      signal: options.signal,
    },
  );
  options.onProgress?.(100);
  return Object.freeze({
    // Persist an origin-neutral, room-scoped proxy reference so guests on
    // every Jazzboard alias resolve it against their own authorized origin.
    url: privateAssetProxyPath(roomId, blob.pathname),
    assetId: null,
    mimeType: file.type,
    sourceUrl,
    storage: "vercel-blob-private",
    pathname: blob.pathname,
  });
}

type LegacyCanvasAsset = Readonly<{
  props?: Readonly<Record<string, unknown>>;
}>;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue | undefined };

/** Structural legacy-adapter contract; no tldraw type crosses this module. */
export type JazzboardLegacyCanvasAssetStore = Readonly<{
  upload: (
    asset: unknown,
    file: File,
    abortSignal?: AbortSignal,
  ) => Promise<{ src: string; meta?: JsonObject }>;
  resolve: (asset: LegacyCanvasAsset) => string | null;
}>;

export function createJazzboardAssetStore(
  roomId: string,
  onProgress?: (percentage: number) => void,
): JazzboardLegacyCanvasAssetStore {
  return {
    async upload(_asset, file, abortSignal) {
      const result = await uploadJazzboardRoomImage(roomId, file, {
        signal: abortSignal,
        onProgress,
      });
      return {
        src: result.url,
        meta: result.pathname
          ? { storage: result.storage, pathname: result.pathname }
          : { storage: result.storage, assetId: result.assetId ?? undefined },
      };
    },
    resolve(asset) {
      const src = asset.props?.src;
      return typeof src === "string" ? src : null;
    },
  };
}
