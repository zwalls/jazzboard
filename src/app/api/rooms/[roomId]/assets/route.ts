import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { randomUUID } from "node:crypto";

import { requireMutationRole } from "@/lib/domain/engine";
import { getRedisRoomAsset, putRedisRoomAsset } from "@/lib/server/asset-store";
import { errorResponse, json } from "@/lib/server/http";
import { readAuthorizedRoom } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

type Context = { params: Promise<{ roomId: string }> };

type LocalAsset = { roomId: string; bytes: ArrayBuffer; mimeType: string; name: string };

const BLOB_MAXIMUM_SIZE_IN_BYTES = 10 * 1024 * 1024;
const REDIS_FALLBACK_MAXIMUM_SIZE_IN_BYTES = 4 * 1024 * 1024;

declare global {
  var __jazzboardLocalAssets: Map<string, LocalAsset> | undefined;
}

function localAssets(): Map<string, LocalAsset> {
  globalThis.__jazzboardLocalAssets ??= new Map();
  return globalThis.__jazzboardLocalAssets;
}

function storageMode(): "vercel-blob" | "redis-fallback" | "local-memory" {
  if (process.env.BLOB_READ_WRITE_TOKEN) return "vercel-blob";
  return process.env.VERCEL === "1" ? "redis-fallback" : "local-memory";
}

function maximumSizeInBytes(mode: ReturnType<typeof storageMode>): number {
  return mode === "redis-fallback"
    ? REDIS_FALLBACK_MAXIMUM_SIZE_IN_BYTES
    : BLOB_MAXIMUM_SIZE_IN_BYTES;
}

function assetResponse(asset: { bytes: ArrayBuffer | Uint8Array; mimeType: string; name: string }): Response {
  const bytes = asset.bytes instanceof ArrayBuffer ? asset.bytes : Uint8Array.from(asset.bytes).buffer;
  return new Response(bytes, {
    headers: {
      "cache-control": "private, max-age=3600",
      "content-disposition": `inline; filename="${asset.name.replace(/["\\]/g, "_")}"`,
      "content-type": asset.mimeType,
    },
  });
}

async function authorizeRead(request: Request, context: Context) {
  const participantId = requireGuestParticipantId(request);
  const { roomId } = await context.params;
  const room = await readAuthorizedRoom(roomId, participantId);
  return { participantId, room, roomId };
}

async function authorizeUpload(request: Request, context: Context) {
  const authorized = await authorizeRead(request, context);
  const { participantId, room } = authorized;
  requireMutationRole(room.participants[participantId], "human");
  return authorized;
}

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { roomId } = await authorizeRead(request, context);
    const assetId = new URL(request.url).searchParams.get("assetId");
    if (assetId) {
      if (process.env.VERCEL === "1") {
        const asset = await getRedisRoomAsset(roomId, assetId);
        if (!asset) {
          return json({ ok: false, error: { code: "ASSET_NOT_FOUND", message: "That image is unavailable." } }, { status: 404 });
        }
        return assetResponse(asset);
      }

      const localAsset = localAssets().get(assetId);
      if (!localAsset || localAsset.roomId !== roomId) {
        return json({ ok: false, error: { code: "ASSET_NOT_FOUND", message: "That local demo asset is unavailable." } }, { status: 404 });
      }
      return assetResponse(localAsset);
    }

    const mode = storageMode();
    return json({
      ok: true,
      mode,
      maximumSizeInBytes: maximumSizeInBytes(mode),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const { participantId, roomId } = await authorizeUpload(request, context);
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      const mode = storageMode();
      const formData = await request.formData();
      const file = formData.get("file");
      if (
        !(file instanceof File) ||
        !file.type.startsWith("image/") ||
        file.size > maximumSizeInBytes(mode)
      ) {
        return json(
          {
            ok: false,
            error: {
              code: "INVALID_ASSET",
              message: `Choose an image smaller than ${Math.round(maximumSizeInBytes(mode) / 1024 / 1024)} MB.`,
            },
          },
          { status: 400 },
        );
      }

      if (mode === "redis-fallback") {
        const { assetId } = await putRedisRoomAsset({ roomId, file });
        return json({
          ok: true,
          assetId,
          url: `${new URL(request.url).origin}/api/rooms/${encodeURIComponent(roomId)}/assets?assetId=${encodeURIComponent(assetId)}`,
        });
      }

      const assetId = randomUUID();
      localAssets().set(assetId, {
        roomId,
        bytes: await file.arrayBuffer(),
        mimeType: file.type,
        name: file.name,
      });
      return json({
        ok: true,
        assetId,
        url: `${new URL(request.url).origin}/api/rooms/${encodeURIComponent(roomId)}/assets?assetId=${encodeURIComponent(assetId)}`,
      });
    }
    const body = (await request.json()) as HandleUploadBody;
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => ({
        allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
        maximumSizeInBytes: BLOB_MAXIMUM_SIZE_IN_BYTES,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ roomId, participantId, pathname }),
      }),
    });
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
