// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn(), upload: vi.fn() }));

vi.mock("@vercel/blob/client", () => ({ upload: mocks.upload }));
vi.mock("./api", () => ({ apiRequest: mocks.apiRequest }));

import { createJazzboardAssetStore } from "./assets";

describe("Jazzboard private Blob client upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiRequest
      .mockResolvedValueOnce({
        ok: true,
        mode: "vercel-blob",
        maximumSizeInBytes: 10 * 1024 * 1024,
        uploadNamespace: "a".repeat(48),
      })
      .mockResolvedValueOnce({ ok: true });
    mocks.upload.mockImplementation(async (pathname: string) => ({ pathname }));
  });

  it("uses a UUID-v4 leaf and authenticates finalization before returning the canvas URL", async () => {
    const progress: number[] = [];
    const store = createJazzboardAssetStore("room_a", (percentage) => progress.push(percentage));
    const file = new File([new Uint8Array([1, 2, 3])], "diagram.png", {
      type: "image/png",
    });

    const result = await store.upload({} as never, file, new AbortController().signal);
    const pathname = mocks.upload.mock.calls[0]?.[0] as string;

    expect(pathname).toMatch(
      /^jazzboard\/a{48}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-diagram\.png$/i,
    );
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      2,
      "/api/rooms/room_a/assets",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          type: "jazzboard.asset-finalize",
          payload: { pathname },
        }),
      }),
    );
    expect(mocks.upload.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.apiRequest.mock.invocationCallOrder[1],
    );
    expect(result).toEqual({
      src: `/api/rooms/room_a/assets?pathname=${encodeURIComponent(pathname)}`,
      meta: { storage: "vercel-blob-private", pathname },
    });
    expect(progress.at(-1)).toBe(100);
  });
});
