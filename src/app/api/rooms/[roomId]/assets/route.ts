import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { randomUUID } from "node:crypto";

import {
  BLOB_MAXIMUM_SIZE_IN_BYTES,
  isRoomBlobPathname,
  isSupportedImageMimeType,
  maximumAssetSizeInBytes,
  SUPPORTED_IMAGE_MIME_TYPES,
} from "@/lib/assets/policy";
import { requireMutationRole } from "@/lib/domain/engine";
import { DomainError } from "@/lib/domain/errors";
import { getRedisRoomAsset, putRedisRoomAsset } from "@/lib/server/asset-store";
import {
  consumeAssetUploadGrant,
  type AssetUploadGrantLimit,
} from "@/lib/server/asset-upload-limiter";
import {
  deletePrivateBlobAssetRegistration,
  getCommittedPrivateBlobAsset,
  reservePrivateBlobAssetWithOutcome,
} from "@/lib/server/blob-asset-registry";
import {
  assetStorageStatus,
  privateBlobToken,
  roomBlobNamespace,
} from "@/lib/server/asset-storage-config";
import { errorResponse, json, readJsonBody } from "@/lib/server/http";
import {
  finalizePrivateBlobAsset,
  getPrivateBlob,
} from "@/lib/server/private-blob-assets";
import { readAuthorizedRoom } from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

type Context = { params: Promise<{ roomId: string }> };

type LocalAsset = { roomId: string; bytes: ArrayBuffer; mimeType: string; name: string };

const MULTIPART_FRAMING_ALLOWANCE_IN_BYTES = 64 * 1024;

declare global {
  var __jazzboardLocalAssets: Map<string, LocalAsset> | undefined;
}

function localAssets(): Map<string, LocalAsset> {
  globalThis.__jazzboardLocalAssets ??= new Map();
  return globalThis.__jazzboardLocalAssets;
}

function inlineContentDisposition(name: string): string {
  const normalized = name.normalize("NFKC").slice(0, 180) || "image";
  const asciiFallback = normalized
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .trim() || "image";
  const encoded = encodeURIComponent(normalized).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function assetResponse(asset: { bytes: ArrayBuffer | Uint8Array; mimeType: string; name: string }): Response {
  const bytes = asset.bytes instanceof ArrayBuffer ? asset.bytes : Uint8Array.from(asset.bytes).buffer;
  return new Response(bytes, {
    headers: {
      "cache-control": "private, no-cache",
      "content-disposition": inlineContentDisposition(asset.name),
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": asset.mimeType,
      "x-robots-tag": "noindex, nofollow, noarchive",
      "x-content-type-options": "nosniff",
    },
  });
}

function privateBlobHeaders(input: {
  contentType?: string | null;
  etag: string;
  pathname: string;
}): Headers {
  const headers = new Headers({
    "cache-control": "private, no-cache",
    "content-disposition": inlineContentDisposition(input.pathname.split("/").at(-1) ?? "image"),
    "content-security-policy": "default-src 'none'; sandbox",
    etag: input.etag,
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
  });
  if (input.contentType) headers.set("content-type", input.contentType);
  return headers;
}

function uploadGrantRateLimitedResponse(limit: AssetUploadGrantLimit): Response {
  return json(
    {
      ok: false,
      error: {
        code: "ASSET_UPLOAD_RATE_LIMITED",
        message: `Too many image upload requests. Try again in ${limit.retryAfterSeconds} seconds.`,
        details: {
          limit: limit.limit,
          remaining: limit.remaining,
          retryAfterSeconds: limit.retryAfterSeconds,
        },
      },
    },
    {
      status: 429,
      headers: { "retry-after": limit.retryAfterSeconds.toString() },
    },
  );
}

async function readBoundedMultipartFormData(
  request: Request,
  maximumFileBytes: number,
): Promise<FormData> {
  const maximumBodyBytes = maximumFileBytes + MULTIPART_FRAMING_ALLOWANCE_IN_BYTES;
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;\s*boundary=/i.test(contentType)) {
    throw new DomainError("INVALID_OPERATION", "The image upload must use multipart form data.");
  }
  const contentLength = request.headers.get("content-length");
  let declaredBytes: number | null = null;
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new DomainError("INVALID_OPERATION", "The image upload size is invalid.");
    }
    declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBodyBytes) {
      throw new DomainError(
        "REQUEST_TOO_LARGE",
        "The multipart image request exceeds Jazzboard's safe request size.",
        { maximumBytes: maximumBodyBytes, receivedBytes: declaredBytes },
      );
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw new DomainError("INVALID_OPERATION", "The image upload body is missing.");
  }
  let bytes = new Uint8Array(
    Math.min(
      maximumBodyBytes,
      Math.max(16 * 1024, declaredBytes ?? 64 * 1024),
    ),
  );
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (receivedBytes + value.byteLength > maximumBodyBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DomainError(
        "REQUEST_TOO_LARGE",
        "The multipart image request exceeds Jazzboard's safe request size.",
        {
          maximumBytes: maximumBodyBytes,
          receivedBytes: receivedBytes + value.byteLength,
        },
      );
    }
    const requiredBytes = receivedBytes + value.byteLength;
    if (requiredBytes > bytes.byteLength) {
      const expanded = new Uint8Array(
        Math.min(
          maximumBodyBytes,
          Math.max(requiredBytes, bytes.byteLength * 2),
        ),
      );
      expanded.set(bytes.subarray(0, receivedBytes));
      bytes = expanded;
    }
    bytes.set(value, receivedBytes);
    receivedBytes += value.byteLength;
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const boundedRequest = new Request(request.url, {
    method: "POST",
    headers,
    body: bytes.slice(0, receivedBytes),
  });
  return boundedRequest.formData();
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

function invalidUploadRequest(): DomainError {
  return new DomainError("INVALID_OPERATION", "The private image upload request is invalid.");
}

function generateClientTokenPathname(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as {
    type?: unknown;
    payload?: { pathname?: unknown; multipart?: unknown; clientPayload?: unknown };
  };
  if (
    candidate.type !== "blob.generate-client-token" ||
    !candidate.payload ||
    typeof candidate.payload.pathname !== "string" ||
    typeof candidate.payload.multipart !== "boolean" ||
    (candidate.payload.clientPayload !== null &&
      typeof candidate.payload.clientPayload !== "string")
  ) {
    return null;
  }
  return candidate.payload.pathname;
}

function finalizePathname(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as { type?: unknown; payload?: { pathname?: unknown } };
  if (
    candidate.type !== "jazzboard.asset-finalize" ||
    !candidate.payload ||
    typeof candidate.payload.pathname !== "string"
  ) {
    return null;
  }
  return candidate.payload.pathname;
}

function isUploadCompletedCallback(body: unknown): body is HandleUploadBody {
  return Boolean(
    body &&
      typeof body === "object" &&
      (body as { type?: unknown }).type === "blob.upload-completed",
  );
}

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { roomId } = await authorizeRead(request, context);
    const searchParams = new URL(request.url).searchParams;
    const pathname = searchParams.get("pathname");
    const assetId = searchParams.get("assetId");
    if (pathname) {
      if (
        pathname.length > 320 ||
        !isRoomBlobPathname(roomBlobNamespace(roomId), pathname) ||
        assetStorageStatus().mode !== "vercel-blob"
      ) {
        return json(
          { ok: false, error: { code: "ASSET_NOT_FOUND", message: "That image is unavailable." } },
          { status: 404 },
        );
      }
      const registration = await getCommittedPrivateBlobAsset(roomId, pathname);
      if (!registration) {
        return json(
          { ok: false, error: { code: "ASSET_NOT_FOUND", message: "That image is unavailable." } },
          { status: 404 },
        );
      }
      const result = await getPrivateBlob(pathname, {
        ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
      });
      if (!result) {
        return json(
          { ok: false, error: { code: "ASSET_NOT_FOUND", message: "That image is unavailable." } },
          { status: 404 },
        );
      }
      if (result.statusCode === 304) {
        return new Response(null, {
          status: 304,
          headers: privateBlobHeaders({
            contentType: null,
            etag: result.blob.etag,
            pathname: result.blob.pathname,
          }),
        });
      }
      if (!isSupportedImageMimeType(result.blob.contentType)) {
        return json(
          { ok: false, error: { code: "ASSET_NOT_FOUND", message: "That image is unavailable." } },
          { status: 404 },
        );
      }
      return new Response(result.stream, {
        headers: privateBlobHeaders({
          contentType: result.blob.contentType,
          etag: result.blob.etag,
          pathname: result.blob.pathname,
        }),
      });
    }
    if (assetId) {
      // Redis-backed URLs issued before Blob provisioning remain readable in
      // every environment for the lifetime of their room-scoped record.
      const redisAsset = await getRedisRoomAsset(roomId, assetId);
      if (redisAsset) return assetResponse(redisAsset);

      const localAsset = localAssets().get(assetId);
      if (!localAsset || localAsset.roomId !== roomId) {
        return json({ ok: false, error: { code: "ASSET_NOT_FOUND", message: "That image is unavailable." } }, { status: 404 });
      }
      return assetResponse(localAsset);
    }

    const { mode } = assetStorageStatus();
    return json({
      ok: true,
      mode,
      maximumSizeInBytes: maximumAssetSizeInBytes(mode),
      ...(mode === "vercel-blob" ? { uploadNamespace: roomBlobNamespace(roomId) } : {}),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const { roomId } = await context.params;
    const { mode } = assetStorageStatus();
    if (mode === "unavailable") {
      return json(
        {
          ok: false,
          error: {
            code: "ASSET_STORAGE_UNAVAILABLE",
            message: "Image uploads are temporarily unavailable.",
          },
        },
        { status: 503 },
      );
    }

    if (mode !== "vercel-blob") {
      await authorizeUpload(request, context);
      const maximumFileBytes = maximumAssetSizeInBytes(mode);
      const formData = await readBoundedMultipartFormData(request, maximumFileBytes);
      const file = formData.get("file");
      if (
        !(file instanceof File) ||
        !isSupportedImageMimeType(file.type) ||
        file.size > maximumFileBytes
      ) {
        return json(
          {
            ok: false,
            error: {
              code: "INVALID_ASSET",
              message: `Choose a JPEG, PNG, WebP, or GIF smaller than ${Math.round(maximumFileBytes / 1024 / 1024)} MB.`,
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
          url: `/api/rooms/${encodeURIComponent(roomId)}/assets?assetId=${encodeURIComponent(assetId)}`,
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
        url: `/api/rooms/${encodeURIComponent(roomId)}/assets?assetId=${encodeURIComponent(assetId)}`,
      });
    }

    const body = await readJsonBody(request);
    if (isUploadCompletedCallback(body)) {
      const result = await handleUpload({
        body,
        request,
        token: privateBlobToken(),
        onBeforeGenerateToken: async () => {
          throw invalidUploadRequest();
        },
        onUploadCompleted: async ({ blob }) => {
          await finalizePrivateBlobAsset({ pathname: blob.pathname });
        },
      });
      return json(result);
    }

    const authorized = await authorizeUpload(request, context);
    const pathnameToFinalize = finalizePathname(body);
    if (pathnameToFinalize !== null) {
      if (!isRoomBlobPathname(roomBlobNamespace(roomId), pathnameToFinalize)) {
        throw invalidUploadRequest();
      }
      const registration = await finalizePrivateBlobAsset({
        pathname: pathnameToFinalize,
        roomId,
      });
      return json({ ok: true, asset: registration });
    }

    const pathname = generateClientTokenPathname(body);
    if (!pathname || !isRoomBlobPathname(roomBlobNamespace(roomId), pathname)) {
      throw invalidUploadRequest();
    }
    const limit = await consumeAssetUploadGrant(roomId, authorized.participantId, pathname);
    if (!limit.allowed) return uploadGrantRateLimitedResponse(limit);
    const reservation = await reservePrivateBlobAssetWithOutcome({
      pathname,
      roomId,
      participantId: authorized.participantId,
    });
    let result: Awaited<ReturnType<typeof handleUpload>>;
    try {
      result = await handleUpload({
        body: body as HandleUploadBody,
        request,
        token: privateBlobToken(),
        onBeforeGenerateToken: async (pathname) => {
          if (!isRoomBlobPathname(roomBlobNamespace(roomId), pathname)) {
            throw new DomainError("INVALID_OPERATION", "The image upload path is invalid.");
          }
          return {
            allowedContentTypes: [...SUPPORTED_IMAGE_MIME_TYPES],
            maximumSizeInBytes: BLOB_MAXIMUM_SIZE_IN_BYTES,
            addRandomSuffix: false,
            allowOverwrite: false,
            validUntil: Date.now() + 5 * 60_000,
          };
        },
        onUploadCompleted: async ({ blob }) => {
          await finalizePrivateBlobAsset({ pathname: blob.pathname });
        },
      });
    } catch (error) {
      if (reservation.created) {
        await deletePrivateBlobAssetRegistration({
          pathname,
          expectedStatus: "reserved",
          expectedCreatedAt: reservation.registration.createdAt,
        }).catch(() => undefined);
      }
      throw error;
    }
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
