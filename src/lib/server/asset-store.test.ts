// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRedisForAssets: vi.fn(),
}));

vi.mock("./room-store", () => ({
  getRedisForAssets: mocks.getRedisForAssets,
}));

import { getRedisRoomAsset, putRedisRoomAsset } from "./asset-store";

describe("Redis room asset storage", () => {
  const values = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    }),
  };

  beforeEach(() => {
    values.clear();
    vi.clearAllMocks();
    mocks.getRedisForAssets.mockReturnValue(redis);
  });

  it("round-trips exact bytes and metadata in a room-scoped asset key", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
    const file = new File([bytes], "pixel.png", { type: "image/png" });

    const { assetId } = await putRedisRoomAsset({ roomId: "room_alpha", file });
    const stored = await getRedisRoomAsset("room_alpha", assetId);

    expect(stored).toMatchObject({ name: "pixel.png", mimeType: "image/png" });
    expect(Array.from(stored?.bytes ?? [])).toEqual(Array.from(bytes));
    expect(redis.set).toHaveBeenCalledOnce();
    expect(redis.set).toHaveBeenCalledWith(
      `jazzboard:asset:room_alpha:${assetId}`,
      expect.any(String),
      "EX",
      7 * 24 * 60 * 60,
    );
    expect(redis.set.mock.calls[0]?.[0]).not.toMatch(/^jazzboard:room:/);
  });

  it("cannot retrieve an asset through a different room key", async () => {
    const { assetId } = await putRedisRoomAsset({
      roomId: "room_alpha",
      file: new File([new Uint8Array([1, 2, 3])], "private.png", { type: "image/png" }),
    });

    await expect(getRedisRoomAsset("room_beta", assetId)).resolves.toBeNull();
    expect(redis.get).toHaveBeenCalledWith(`jazzboard:asset:room_beta:${assetId}`);
  });

  it("returns null for missing or malformed asset records", async () => {
    await expect(getRedisRoomAsset("room_alpha", "missing")).resolves.toBeNull();

    values.set("jazzboard:asset:room_alpha:malformed", "{not-json");
    await expect(getRedisRoomAsset("room_alpha", "malformed")).resolves.toBeNull();
  });
});
