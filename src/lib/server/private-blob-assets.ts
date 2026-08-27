import {
  BlobNotFoundError,
  del,
  get,
  head,
  list,
  type GetBlobResult,
  type HeadBlobResult,
  type ListBlobResultBlob,
} from "@vercel/blob";

import {
  isDedicatedPrivateBlobPathname,
  isSupportedImageMimeType,
} from "@/lib/assets/policy";
import { DomainError } from "@/lib/domain/errors";

import { assetStorageStatus, privateBlobToken } from "./asset-storage-config";
import { finalizePrivateBlobAssetRegistration } from "./blob-asset-registry";

function configuredPrivateBlobToken(): string {
  const token = privateBlobToken();
  if (!token || assetStorageStatus().mode !== "vercel-blob") {
    throw new DomainError(
      "INVALID_OPERATION",
      "Private image storage is unavailable.",
    );
  }
  return token;
}

function assertDedicatedPathname(pathname: string): void {
  if (!isDedicatedPrivateBlobPathname(pathname)) {
    throw new DomainError("INVALID_OPERATION", "The private image pathname is invalid.");
  }
}

export async function getPrivateBlob(
  pathname: string,
  options: { ifNoneMatch?: string } = {},
): Promise<GetBlobResult | null> {
  assertDedicatedPathname(pathname);
  return get(pathname, {
    access: "private",
    token: configuredPrivateBlobToken(),
    ifNoneMatch: options.ifNoneMatch,
  });
}

export async function headPrivateBlob(
  pathname: string,
): Promise<HeadBlobResult | null> {
  assertDedicatedPathname(pathname);
  try {
    return await head(pathname, { token: configuredPrivateBlobToken() });
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null;
    throw error;
  }
}

export async function finalizePrivateBlobAsset(input: {
  pathname: string;
  roomId?: string;
  now?: number;
}) {
  const metadata = await headPrivateBlob(input.pathname);
  if (!metadata || metadata.pathname !== input.pathname) {
    throw new DomainError("INVALID_OPERATION", "That private image upload is unavailable.");
  }
  if (!isSupportedImageMimeType(metadata.contentType)) {
    throw new DomainError("INVALID_OPERATION", "That private upload is not a supported image.");
  }
  return finalizePrivateBlobAssetRegistration({
    pathname: input.pathname,
    roomId: input.roomId,
    size: metadata.size,
    contentType: metadata.contentType,
    etag: metadata.etag,
    now: input.now,
  });
}

export async function listPrivateBlobAssets(input: {
  limit?: number;
  cursor?: string;
} = {}): Promise<{
  blobs: ListBlobResultBlob[];
  cursor?: string;
  hasMore: boolean;
}> {
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 1_000), 1_000));
  const result = await list({
    prefix: "jazzboard/",
    limit,
    cursor: input.cursor,
    token: configuredPrivateBlobToken(),
  });
  return {
    blobs: result.blobs,
    cursor: result.cursor,
    hasMore: result.hasMore,
  };
}

export async function deletePrivateBlob(input: {
  pathname: string;
  ifMatch?: string;
}): Promise<void> {
  assertDedicatedPathname(input.pathname);
  await del(input.pathname, {
    token: configuredPrivateBlobToken(),
    ifMatch: input.ifMatch,
  });
}
