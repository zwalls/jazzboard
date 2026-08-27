import { describe, expect, it } from "vitest";

import {
  blobAssetPathname,
  canonicalRoomAssetProxyPath,
  isDedicatedPrivateBlobPathname,
  isCanvasImageUrl,
  isRoomBlobPathname,
  isSupportedImageMimeType,
  maximumAssetSizeInBytes,
  parseRoomAssetProxyReference,
  privateAssetProxyPath,
} from "./policy";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("image asset policy", () => {
  it("uses one safe room namespace for client and server Blob paths", () => {
    const namespace = "a".repeat(48);
    const pathname = blobAssetPathname(namespace, `../${UUID}-my\u0000photo?#.png`);

    expect(pathname).toBe(`jazzboard/${namespace}/${UUID}-my_photo__.png`);
    expect(pathname).not.toContain("room_alpha");
    expect(isRoomBlobPathname(namespace, pathname)).toBe(true);
    expect(isRoomBlobPathname("b".repeat(48), pathname)).toBe(false);
    expect(isRoomBlobPathname(namespace, `jazzboard/${namespace}/nested/photo.png`)).toBe(false);
    expect(isDedicatedPrivateBlobPathname(pathname)).toBe(true);
    expect(() => blobAssetPathname(namespace, "not-a-uuid.png")).toThrow("UUID-v4");
    expect(isRoomBlobPathname(namespace, `jazzboard/${namespace}/not-a-uuid.png`)).toBe(false);
  });

  it("accepts only the non-scriptable image formats granted by Blob tokens", () => {
    expect(isSupportedImageMimeType("image/jpeg")).toBe(true);
    expect(isSupportedImageMimeType("image/png")).toBe(true);
    expect(isSupportedImageMimeType("image/webp")).toBe(true);
    expect(isSupportedImageMimeType("image/gif")).toBe(true);
    expect(isSupportedImageMimeType("image/svg+xml")).toBe(false);
    expect(isSupportedImageMimeType("image/avif")).toBe(false);
  });

  it("builds and parses an origin-neutral authenticated proxy reference", () => {
    const url = privateAssetProxyPath(
      "room /private",
      "jazzboard/opaque namespace/image name.png",
    );

    expect(url).toBe(
      "/api/rooms/room%20%2Fprivate/assets?pathname=jazzboard%2Fopaque%20namespace%2Fimage%20name.png",
    );
    // Encoded path separators are deliberately rejected as ambiguous room IDs.
    expect(parseRoomAssetProxyReference(url)).toBeNull();
    const safeUrl = privateAssetProxyPath("room_private", "jazzboard/opaque/image.png");
    expect(parseRoomAssetProxyReference(safeUrl)).toEqual({
      roomId: "room_private",
      pathname: "jazzboard/opaque/image.png",
      assetId: null,
    });
    expect(isCanvasImageUrl(safeUrl)).toBe(true);
    expect(isCanvasImageUrl("https://images.example/diagram.png")).toBe(true);
    expect(isCanvasImageUrl("javascript:alert(1)")).toBe(false);
    expect(isCanvasImageUrl("/api/rooms/room_private/assets?pathname=a&assetId=b")).toBe(false);
  });

  it("recognizes alias-bound asset URLs and canonicalizes them to one relative reference", () => {
    const pathname = `jazzboard/${"a".repeat(48)}/${UUID}-image.png`;
    const relative = privateAssetProxyPath("room_private", pathname);
    const absolute = `https://jazzboard.example${relative}`;

    expect(parseRoomAssetProxyReference(absolute)).toEqual(
      parseRoomAssetProxyReference(relative),
    );
    expect(canonicalRoomAssetProxyPath(parseRoomAssetProxyReference(absolute)!)).toBe(relative);
  });

  it("advertises no upload budget while deployed storage is unavailable", () => {
    expect(maximumAssetSizeInBytes("vercel-blob")).toBe(10 * 1024 * 1024);
    expect(maximumAssetSizeInBytes("redis-fallback")).toBe(4 * 1024 * 1024);
    expect(maximumAssetSizeInBytes("local-memory")).toBe(10 * 1024 * 1024);
    expect(maximumAssetSizeInBytes("unavailable")).toBe(0);
  });
});
