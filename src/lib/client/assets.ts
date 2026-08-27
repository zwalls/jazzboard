import { upload } from "@vercel/blob/client";
import type { TLAssetStore } from "tldraw";

import {
  blobAssetPathname,
  isSupportedImageMimeType,
  privateAssetProxyPath,
  type AssetStorageMode,
} from "@/lib/assets/policy";

import { apiRequest } from "./api";

export function createJazzboardAssetStore(
  roomId: string,
  onProgress?: (percentage: number) => void,
): TLAssetStore {
  return {
    async upload(_asset, file, abortSignal) {
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
        onProgress?.(15);
        const formData = new FormData();
        formData.set("file", file);
        const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/assets`, {
          method: "POST",
          body: formData,
          signal: abortSignal,
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
        onProgress?.(100);
        return { src: result.url, meta: { storage: config.mode, assetId: result.assetId } };
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
          abortSignal,
          onUploadProgress: ({ percentage }) => onProgress?.(percentage),
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
          signal: abortSignal,
        },
      );
      onProgress?.(100);
      return {
        // Persist an origin-neutral, room-scoped proxy reference so guests on
        // every Jazzboard alias resolve it against their own authorized origin.
        src: privateAssetProxyPath(roomId, blob.pathname),
        meta: { storage: "vercel-blob-private", pathname: blob.pathname },
      };
    },
    resolve(asset) {
      return "src" in asset.props ? asset.props.src : null;
    },
  };
}
