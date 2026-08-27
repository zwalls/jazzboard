// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRedisForRealtime: vi.fn() }));

vi.mock("./room-store", () => ({
  getRedisForRealtime: mocks.getRedisForRealtime,
}));

import {
  ASSET_UPLOAD_GRANT_LIMIT,
  ASSET_UPLOAD_GRANT_WINDOW_SECONDS,
  consumeAssetUploadGrant,
} from "./asset-upload-limiter";

describe("asset upload grant limiter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    mocks.getRedisForRealtime.mockReturnValue(null);
    globalThis.__jazzboardLocalAssetUploadGrantWindows = undefined;
  });

  afterEach(() => {
    globalThis.__jazzboardLocalAssetUploadGrantWindows = undefined;
    vi.useRealTimers();
  });

  it("allows a bounded number of unique grants and deduplicates a retry", async () => {
    for (let index = 0; index < ASSET_UPLOAD_GRANT_LIMIT; index += 1) {
      await expect(
        consumeAssetUploadGrant("room_a", "participant_a", `jazzboard/ns/${index}.png`),
      ).resolves.toMatchObject({ allowed: true, remaining: ASSET_UPLOAD_GRANT_LIMIT - index - 1 });
    }

    await expect(
      consumeAssetUploadGrant("room_a", "participant_a", "jazzboard/ns/0.png"),
    ).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(
      consumeAssetUploadGrant("room_a", "participant_a", "jazzboard/ns/overflow.png"),
    ).resolves.toEqual({
      allowed: false,
      limit: ASSET_UPLOAD_GRANT_LIMIT,
      remaining: 0,
      retryAfterSeconds: ASSET_UPLOAD_GRANT_WINDOW_SECONDS,
    });
  });

  it("cannot be bypassed with another room, isolates participants, and resets after the window", async () => {
    for (let index = 0; index < ASSET_UPLOAD_GRANT_LIMIT; index += 1) {
      await consumeAssetUploadGrant("room_a", "participant_a", `jazzboard/ns/${index}.png`);
    }
    await expect(
      consumeAssetUploadGrant("room_b", "participant_a", "jazzboard/ns/new.png"),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      consumeAssetUploadGrant("room_a", "participant_b", "jazzboard/ns/new.png"),
    ).resolves.toMatchObject({ allowed: true });

    vi.advanceTimersByTime(ASSET_UPLOAD_GRANT_WINDOW_SECONDS * 1_000);
    await expect(
      consumeAssetUploadGrant("room_a", "participant_a", "jazzboard/ns/new.png"),
    ).resolves.toMatchObject({ allowed: true, remaining: ASSET_UPLOAD_GRANT_LIMIT - 1 });
  });

  it("uses one bounded atomic Redis window", async () => {
    const redis = { eval: vi.fn().mockResolvedValue([ASSET_UPLOAD_GRANT_LIMIT, 17, 0]) };
    mocks.getRedisForRealtime.mockReturnValue(redis);

    await expect(
      consumeAssetUploadGrant("room_a", "participant_a", "jazzboard/ns/new.png"),
    ).resolves.toMatchObject({ allowed: false, retryAfterSeconds: 17 });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('elseif count < tonumber(ARGV[2]) then'),
      1,
      expect.stringMatching(/^jazzboard:asset-upload-grants:v1:[a-f0-9]{64}$/),
      ASSET_UPLOAD_GRANT_WINDOW_SECONDS.toString(),
      ASSET_UPLOAD_GRANT_LIMIT.toString(),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  });
});
