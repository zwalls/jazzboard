// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class BlobNotFoundError extends Error {}
  return {
    BlobNotFoundError,
    del: vi.fn(),
    finalizeRegistration: vi.fn(),
    get: vi.fn(),
    head: vi.fn(),
    list: vi.fn(),
  };
});

vi.mock("@vercel/blob", () => ({
  BlobNotFoundError: mocks.BlobNotFoundError,
  del: mocks.del,
  get: mocks.get,
  head: mocks.head,
  list: mocks.list,
}));
vi.mock("./blob-asset-registry", () => ({
  finalizePrivateBlobAssetRegistration: mocks.finalizeRegistration,
}));

import { blobAssetPathname } from "@/lib/assets/policy";
import { roomBlobNamespace } from "@/lib/assets/private";

import {
  deletePrivateBlob,
  finalizePrivateBlobAsset,
  getPrivateBlob,
  headPrivateBlob,
  listPrivateBlobAssets,
} from "./private-blob-assets";

const PATHNAME = blobAssetPathname(
  roomBlobNamespace("room_a"),
  "550e8400-e29b-41d4-a716-446655440000-image.png",
);

function metadata() {
  return {
    size: 123,
    uploadedAt: new Date("2026-08-26T00:00:00.000Z"),
    pathname: PATHNAME,
    contentType: "image/png",
    contentDisposition: "inline",
    url: "https://private.example/image",
    downloadUrl: "https://private.example/image?download=1",
    cacheControl: "max-age=0",
    etag: '"etag-a"',
  };
}

describe("explicit-token private Blob provider boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "jazzboard-private-token");
    vi.stubEnv("JAZZBOARD_BLOB_ACCESS", "private");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "implicit-token-must-not-be-used");
    mocks.head.mockResolvedValue(metadata());
    mocks.list.mockResolvedValue({ blobs: [], hasMore: false });
    mocks.finalizeRegistration.mockImplementation(async (input) => ({
      version: 1,
      status: "committed",
      ...input,
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes the dedicated private token on every get, head, list, and delete call", async () => {
    mocks.get.mockResolvedValue(null);
    await getPrivateBlob(PATHNAME, { ifNoneMatch: '"etag-a"' });
    await headPrivateBlob(PATHNAME);
    await listPrivateBlobAssets({ limit: 17, cursor: "cursor-a" });
    await deletePrivateBlob({ pathname: PATHNAME, ifMatch: '"etag-a"' });

    expect(mocks.get).toHaveBeenCalledWith(PATHNAME, {
      access: "private",
      token: "jazzboard-private-token",
      ifNoneMatch: '"etag-a"',
    });
    expect(mocks.head).toHaveBeenCalledWith(PATHNAME, {
      token: "jazzboard-private-token",
    });
    expect(mocks.list).toHaveBeenCalledWith({
      prefix: "jazzboard/",
      limit: 17,
      cursor: "cursor-a",
      token: "jazzboard-private-token",
    });
    expect(mocks.del).toHaveBeenCalledWith(PATHNAME, {
      token: "jazzboard-private-token",
      ifMatch: '"etag-a"',
    });
  });

  it("finalizes provider metadata idempotently when client and callback both follow up", async () => {
    const first = await finalizePrivateBlobAsset({ pathname: PATHNAME, roomId: "room_a", now: 10 });
    const retry = await finalizePrivateBlobAsset({ pathname: PATHNAME, roomId: "room_a", now: 20 });

    expect(first).toMatchObject({ status: "committed", pathname: PATHNAME });
    expect(retry).toMatchObject({ status: "committed", pathname: PATHNAME });
    expect(mocks.head).toHaveBeenCalledTimes(2);
    expect(mocks.finalizeRegistration).toHaveBeenNthCalledWith(1, {
      pathname: PATHNAME,
      roomId: "room_a",
      size: 123,
      contentType: "image/png",
      etag: '"etag-a"',
      now: 10,
    });
    expect(mocks.finalizeRegistration).toHaveBeenNthCalledWith(2, {
      pathname: PATHNAME,
      roomId: "room_a",
      size: 123,
      contentType: "image/png",
      etag: '"etag-a"',
      now: 20,
    });
  });

  it("returns null only for a provider not-found result and rejects foreign paths before SDK use", async () => {
    mocks.head.mockRejectedValue(new mocks.BlobNotFoundError());
    await expect(headPrivateBlob(PATHNAME)).resolves.toBeNull();
    await expect(headPrivateBlob("foreign/path.png")).rejects.toThrow("pathname is invalid");
    expect(mocks.head).toHaveBeenCalledOnce();
  });

  it("fails closed instead of falling back to the SDK's implicit token", async () => {
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "");
    await expect(headPrivateBlob(PATHNAME)).rejects.toThrow("storage is unavailable");
    expect(mocks.head).not.toHaveBeenCalled();
  });
});
