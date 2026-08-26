import { upload } from "@vercel/blob/client";
import type { TLAssetStore } from "tldraw";

import { apiRequest } from "./api";

export function createJazzboardAssetStore(
  roomId: string,
  onProgress?: (percentage: number) => void,
): TLAssetStore {
  return {
    async upload(_asset, file, abortSignal) {
      const config = await apiRequest<{
        ok: true;
        mode: "vercel-blob" | "redis-fallback" | "local-memory";
        maximumSizeInBytes: number;
      }>(`/api/rooms/${roomId}/assets`);
      if (file.size > config.maximumSizeInBytes) {
        throw new Error(`Images must be smaller than ${Math.round(config.maximumSizeInBytes / 1024 / 1024)} MB.`);
      }
      if (!file.type.startsWith("image/")) throw new Error("Jazzboard accepts image files only.");

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

      const blob = await upload(`jazzboard/${roomId}/${file.name}`, file, {
        access: "public",
        handleUploadUrl: `/api/rooms/${roomId}/assets`,
        multipart: file.size > 5 * 1024 * 1024,
        abortSignal,
        onUploadProgress: ({ percentage }) => onProgress?.(percentage),
      });
      return { src: blob.url, meta: { storage: "vercel-blob", pathname: blob.pathname } };
    },
    resolve(asset) {
      return "src" in asset.props ? asset.props.src : null;
    },
  };
}
