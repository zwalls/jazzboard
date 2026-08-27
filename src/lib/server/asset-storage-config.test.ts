// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@vercel/blob", () => ({ get: mocks.get }));

import {
  assetStorageStatus,
  probePrivateBlobStorage,
  resetPrivateBlobProbeCacheForTests,
  roomBlobNamespace,
} from "./asset-storage-config";

describe("asset storage configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    resetPrivateBlobProbeCacheForTests();
  });

  afterEach(() => {
    resetPrivateBlobProbeCacheForTests();
    vi.useRealTimers();
  });

  it("uses a stable opaque provider namespace instead of a private room ID", () => {
    const namespace = roomBlobNamespace("room_private_identifier");

    expect(namespace).toMatch(/^[a-f0-9]{48}$/);
    expect(namespace).toBe(roomBlobNamespace("room_private_identifier"));
    expect(namespace).not.toContain("room_private_identifier");
    expect(namespace).not.toBe(roomBlobNamespace("room_other"));
  });

  it("uses Blob whenever its project connection is configured", () => {
    expect(
      assetStorageStatus({
        VERCEL: "1",
        REDIS_URL: "redis://example.test",
        JAZZBOARD_PRIVATE_READ_WRITE_TOKEN: "blob-token",
        JAZZBOARD_BLOB_ACCESS: "private",
        JAZZBOARD_ALLOW_REDIS_ASSET_FALLBACK: "1",
      }),
    ).toEqual({
      mode: "vercel-blob",
      blobConfigured: true,
      blobPrivateConfigured: true,
      redisFallbackEnabled: true,
    });
  });

  it("fails closed on Vercel without Blob unless Redis fallback is explicitly enabled", () => {
    expect(assetStorageStatus({ VERCEL: "1", REDIS_URL: "redis://example.test" })).toEqual({
      mode: "unavailable",
      blobConfigured: false,
      blobPrivateConfigured: false,
      redisFallbackEnabled: false,
    });
    expect(
      assetStorageStatus({
        VERCEL: "1",
        REDIS_URL: "redis://example.test",
        JAZZBOARD_ALLOW_REDIS_ASSET_FALLBACK: "1",
      }),
    ).toEqual({
      mode: "redis-fallback",
      blobConfigured: false,
      blobPrivateConfigured: false,
      redisFallbackEnabled: true,
    });
  });

  it("preserves process-local image storage for ordinary local development", () => {
    expect(assetStorageStatus({})).toEqual({
      mode: "local-memory",
      blobConfigured: false,
      blobPrivateConfigured: false,
      redisFallbackEnabled: false,
    });
  });

  it("fails closed when a token belongs to a store not asserted private", () => {
    expect(
      assetStorageStatus({
        VERCEL: "1",
        JAZZBOARD_PRIVATE_READ_WRITE_TOKEN: "public-store-token",
      }),
    ).toEqual({
      mode: "unavailable",
      blobConfigured: false,
      blobPrivateConfigured: false,
      redisFallbackEnabled: false,
    });
  });

  it("deduplicates concurrent probes and caches a successful private-store read", async () => {
    let resolveProbe: ((value: null) => void) | undefined;
    mocks.get.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        resolveProbe = resolve;
      }),
    );
    const environment = {
      JAZZBOARD_PRIVATE_READ_WRITE_TOKEN: "private-token-one",
      JAZZBOARD_BLOB_ACCESS: "private",
    };

    const first = probePrivateBlobStorage(environment);
    const second = probePrivateBlobStorage(environment);
    expect(mocks.get).toHaveBeenCalledOnce();
    resolveProbe?.(null);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    await expect(probePrivateBlobStorage(environment)).resolves.toBe(true);
    expect(mocks.get).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_001);
    mocks.get.mockResolvedValueOnce(null);
    await expect(probePrivateBlobStorage(environment)).resolves.toBe(true);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("uses a short failure cache so provider outages cannot be amplified or hidden", async () => {
    const environment = {
      JAZZBOARD_PRIVATE_READ_WRITE_TOKEN: "private-token-two",
      JAZZBOARD_BLOB_ACCESS: "private",
    };
    mocks.get.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(probePrivateBlobStorage(environment)).resolves.toBe(false);
    await expect(probePrivateBlobStorage(environment)).resolves.toBe(false);
    expect(mocks.get).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(10_001);
    mocks.get.mockResolvedValueOnce(null);
    await expect(probePrivateBlobStorage(environment)).resolves.toBe(true);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("bounds cached credential fingerprints without retaining raw Blob tokens", async () => {
    mocks.get.mockResolvedValue(null);
    const rawTokens = Array.from({ length: 12 }, (_, index) => `private-raw-token-${index}`);
    for (const token of rawTokens) {
      await probePrivateBlobStorage({
        JAZZBOARD_PRIVATE_READ_WRITE_TOKEN: token,
        JAZZBOARD_BLOB_ACCESS: "private",
      });
    }

    const cache = globalThis.__jazzboardPrivateBlobProbeCache;
    expect(cache?.size).toBe(8);
    const serialized = JSON.stringify([...(cache?.entries() ?? [])]);
    for (const token of rawTokens) expect(serialized).not.toContain(token);
    expect([...cache!.keys()]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)]),
    );
  });
});
