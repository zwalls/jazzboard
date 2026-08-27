// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRedisForRealtime: vi.fn() }));

vi.mock("./room-store", () => ({
  getRedisForRealtime: mocks.getRedisForRealtime,
}));

import { blobAssetPathname } from "@/lib/assets/policy";
import { roomBlobNamespace } from "@/lib/assets/private";

import {
  claimCommittedPrivateBlobAssetForCleanup,
  deletePrivateBlobAssetRegistration,
  finalizePrivateBlobAssetRegistration,
  getCommittedPrivateBlobAsset,
  getPrivateBlobAssetRegistration,
  isPrivateBlobAssetReadable,
  isPrivateBlobAssetReferenceEligible,
  parsePrivateBlobAssetRegistration,
  privateBlobAssetRegistrationRedisKey,
  releasePrivateBlobAssetCleanupClaim,
  reservePrivateBlobAsset,
  resetPrivateBlobAssetRegistryForTests,
  type BlobAssetCapacityLimits,
} from "./blob-asset-registry";

const UUIDS = [
  "550e8400-e29b-41d4-a716-446655440000",
  "550e8400-e29b-41d4-a716-446655440001",
  "550e8400-e29b-41d4-a716-446655440002",
  "550e8400-e29b-41d4-a716-446655440003",
];

function pathname(roomId: string, index: number): string {
  return blobAssetPathname(roomBlobNamespace(roomId), `${UUIDS[index]}-image.png`);
}

const limits: BlobAssetCapacityLimits = {
  globalBytes: 20,
  roomBytes: 20,
  globalAssets: 2,
  roomAssets: 2,
  reservationBytes: 10,
  participantPendingReservations: 2,
};

describe("private Blob asset capacity registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.getRedisForRealtime.mockReturnValue(null);
    resetPrivateBlobAssetRegistryForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetPrivateBlobAssetRegistryForTests();
  });

  it("enforces one aggregate global budget across rooms", async () => {
    await reservePrivateBlobAsset({
      pathname: pathname("room_a", 0),
      roomId: "room_a",
      participantId: "participant_a",
      limits,
    });
    await reservePrivateBlobAsset({
      pathname: pathname("room_b", 1),
      roomId: "room_b",
      participantId: "participant_b",
      limits,
    });

    await expect(
      reservePrivateBlobAsset({
        pathname: pathname("room_c", 2),
        roomId: "room_c",
        participantId: "participant_c",
        limits,
      }),
    ).rejects.toMatchObject({
      code: "ASSET_CAPACITY_EXCEEDED",
      details: { dimension: "globalBytes", used: 20, limit: 20 },
    });
  });

  it("enforces per-room quotas without allowing another room to consume them", async () => {
    const roomLimited = { ...limits, globalBytes: 40, globalAssets: 4, roomBytes: 10, roomAssets: 1 };
    await reservePrivateBlobAsset({
      pathname: pathname("room_a", 0),
      roomId: "room_a",
      participantId: "participant_a",
      limits: roomLimited,
    });
    await expect(
      reservePrivateBlobAsset({
        pathname: pathname("room_a", 1),
        roomId: "room_a",
        participantId: "participant_a",
        limits: roomLimited,
      }),
    ).rejects.toMatchObject({
      code: "ASSET_CAPACITY_EXCEEDED",
      details: { dimension: "roomBytes", used: 10, limit: 10 },
    });
    await expect(
      reservePrivateBlobAsset({
        pathname: pathname("room_b", 2),
        roomId: "room_b",
        participantId: "participant_a",
        limits: roomLimited,
      }),
    ).resolves.toMatchObject({ status: "reserved", roomId: "room_b" });
  });

  it("deduplicates reservation and finalization retries and releases capacity on deletion", async () => {
    const selectedPath = pathname("room_a", 0);
    const first = await reservePrivateBlobAsset({
      pathname: selectedPath,
      roomId: "room_a",
      participantId: "participant_a",
      limits,
    });
    const retry = await reservePrivateBlobAsset({
      pathname: selectedPath,
      roomId: "room_a",
      participantId: "participant_a",
      limits,
    });
    expect(retry).toEqual(first);

    const committed = await finalizePrivateBlobAssetRegistration({
      pathname: selectedPath,
      roomId: "room_a",
      size: 4,
      contentType: "image/png",
      etag: '"etag-a"',
      now: 200,
    });
    await expect(
      finalizePrivateBlobAssetRegistration({
        pathname: selectedPath,
        roomId: "room_a",
        size: 4,
        contentType: "image/png",
        etag: '"etag-a"',
        now: 300,
      }),
    ).resolves.toEqual(committed);
    await expect(getCommittedPrivateBlobAsset("room_a", selectedPath)).resolves.toEqual(committed);

    await deletePrivateBlobAssetRegistration({
      pathname: selectedPath,
      expectedEtag: '"etag-a"',
    });
    await expect(
      reservePrivateBlobAsset({
        pathname: pathname("room_a", 1),
        roomId: "room_a",
        participantId: "participant_a",
        limits,
      }),
    ).resolves.toMatchObject({ status: "reserved" });
  });

  it("bounds each participant's outstanding reservations across rooms", async () => {
    const participantLimited = {
      ...limits,
      globalBytes: 40,
      globalAssets: 4,
      roomBytes: 20,
      roomAssets: 2,
    };
    await reservePrivateBlobAsset({
      pathname: pathname("room_a", 0),
      roomId: "room_a",
      participantId: "participant_a",
      limits: participantLimited,
    });
    await reservePrivateBlobAsset({
      pathname: pathname("room_b", 1),
      roomId: "room_b",
      participantId: "participant_a",
      limits: participantLimited,
    });

    await expect(
      reservePrivateBlobAsset({
        pathname: pathname("room_c", 2),
        roomId: "room_c",
        participantId: "participant_a",
        limits: participantLimited,
      }),
    ).rejects.toMatchObject({
      code: "ASSET_CAPACITY_EXCEEDED",
      details: { dimension: "participantPendingReservations", used: 2, limit: 2 },
    });
  });

  it("opportunistically reclaims expired reservations before capacity checks", async () => {
    const selectedPath = pathname("room_a", 0);
    const oneAsset = {
      ...limits,
      globalBytes: 10,
      globalAssets: 1,
      roomBytes: 10,
      roomAssets: 1,
    };
    await reservePrivateBlobAsset({
      pathname: selectedPath,
      roomId: "room_a",
      participantId: "participant_a",
      limits: oneAsset,
      now: 1_000,
    });

    await expect(
      reservePrivateBlobAsset({
        pathname: pathname("room_b", 1),
        roomId: "room_b",
        participantId: "participant_b",
        limits: oneAsset,
        now: 15 * 60_000 + 1_001,
      }),
    ).resolves.toMatchObject({ status: "reserved", roomId: "room_b" });
    await expect(getPrivateBlobAssetRegistration(selectedPath)).resolves.toBeNull();
  });

  it("uses a generation-safe cleanup claim while preserving existing reads", async () => {
    const selectedPath = pathname("room_a", 0);
    await reservePrivateBlobAsset({
      pathname: selectedPath,
      roomId: "room_a",
      participantId: "participant_a",
      limits,
      now: 1_000,
    });
    const committed = await finalizePrivateBlobAssetRegistration({
      pathname: selectedPath,
      roomId: "room_a",
      size: 4,
      contentType: "image/png",
      etag: '"etag-claim"',
      now: 2_000,
    });
    expect(isPrivateBlobAssetReferenceEligible(committed)).toBe(true);

    const first = await claimCommittedPrivateBlobAssetForCleanup({
      pathname: selectedPath,
      roomId: "room_a",
      expectedEtag: '"etag-claim"',
      claimId: "claim-a",
      now: 3_000,
      leaseMs: 100,
    });
    expect(first).toMatchObject({
      outcome: "claimed",
      claim: {
        claimId: "claim-a",
        disposition: "fresh",
        registration: { status: "cleanup-claimed", cleanupClaimedAt: 3_000 },
      },
    });
    if (first.outcome !== "claimed") throw new Error("Expected cleanup claim.");
    expect(isPrivateBlobAssetReferenceEligible(first.claim.registration)).toBe(false);
    expect(isPrivateBlobAssetReadable(first.claim.registration)).toBe(true);
    await expect(getCommittedPrivateBlobAsset("room_a", selectedPath)).resolves.toMatchObject({
      status: "cleanup-claimed",
      cleanupClaimId: "claim-a",
    });

    await expect(
      claimCommittedPrivateBlobAssetForCleanup({
        pathname: selectedPath,
        roomId: "room_a",
        expectedEtag: '"etag-claim"',
        claimId: "claim-b",
        now: 3_050,
        leaseMs: 100,
      }),
    ).resolves.toEqual({ outcome: "busy" });
    await expect(
      claimCommittedPrivateBlobAssetForCleanup({
        pathname: selectedPath,
        roomId: "room_a",
        expectedEtag: '"etag-claim"',
        claimId: "claim-a",
        now: 3_050,
        leaseMs: 100,
      }),
    ).resolves.toMatchObject({
      outcome: "claimed",
      claim: { disposition: "resumed", registration: { cleanupClaimedAt: 3_050 } },
    });
    await expect(
      claimCommittedPrivateBlobAssetForCleanup({
        pathname: selectedPath,
        roomId: "room_a",
        expectedEtag: '"etag-claim"',
        claimId: "claim-b",
        now: 3_151,
        leaseMs: 100,
      }),
    ).resolves.toMatchObject({
      outcome: "claimed",
      claim: { claimId: "claim-b", disposition: "recovered" },
    });

    await expect(
      releasePrivateBlobAssetCleanupClaim({
        pathname: selectedPath,
        roomId: "room_a",
        claimId: "claim-a",
        nextCheckAt: 4_000,
      }),
    ).rejects.toThrow("claim changed");
    await expect(
      deletePrivateBlobAssetRegistration({
        pathname: selectedPath,
        expectedEtag: '"etag-claim"',
        expectedStatus: "cleanup-claimed",
        expectedCleanupClaimId: "claim-a",
      }),
    ).rejects.toThrow("changed during cleanup");
    await expect(getPrivateBlobAssetRegistration(selectedPath)).resolves.toMatchObject({
      status: "cleanup-claimed",
      cleanupClaimId: "claim-b",
    });
    const released = await releasePrivateBlobAssetCleanupClaim({
      pathname: selectedPath,
      roomId: "room_a",
      claimId: "claim-b",
      nextCheckAt: 4_000,
    });
    expect(released).toMatchObject({
      status: "committed",
      cleanupClaimId: null,
      cleanupClaimedAt: null,
    });
    expect(isPrivateBlobAssetReferenceEligible(released)).toBe(true);
  });

  it("exports a stable WATCH key and normalizes legacy committed records", async () => {
    const selectedPath = pathname("room_a", 0);
    await reservePrivateBlobAsset({
      pathname: selectedPath,
      roomId: "room_a",
      participantId: "participant_a",
      limits,
      now: 1_000,
    });
    const committed = await finalizePrivateBlobAssetRegistration({
      pathname: selectedPath,
      roomId: "room_a",
      size: 4,
      contentType: "image/png",
      etag: '"etag-watch"',
      now: 2_000,
    });
    const legacy = { ...committed } as Partial<typeof committed>;
    delete legacy.cleanupClaimId;
    delete legacy.cleanupClaimedAt;

    expect(parsePrivateBlobAssetRegistration(JSON.stringify(legacy))).toMatchObject({
      status: "committed",
      cleanupClaimId: null,
      cleanupClaimedAt: null,
    });
    expect(privateBlobAssetRegistrationRedisKey(selectedPath)).toMatch(
      /^jazzboard:blob-assets:v1:path:[a-f0-9]{64}$/,
    );
    expect(privateBlobAssetRegistrationRedisKey(selectedPath)).not.toContain("room_a");
  });

  it("fails closed in production when the atomic Redis registry is unavailable", async () => {
    vi.stubEnv("VERCEL", "1");
    await expect(
      reservePrivateBlobAsset({
        pathname: pathname("room_a", 0),
        roomId: "room_a",
        participantId: "participant_a",
      }),
    ).rejects.toThrow("capacity storage is unavailable");
    await expect(getCommittedPrivateBlobAsset("room_a", pathname("room_a", 0))).rejects.toThrow(
      "capacity storage is unavailable",
    );
  });

  it("uses one Redis script with global, room, and participant capacity keys", async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue([
        0,
        "globalBytes",
        "524288000",
        "536870912",
      ]),
      zrangebyscore: vi.fn().mockResolvedValue([]),
    };
    mocks.getRedisForRealtime.mockReturnValue(redis);
    await expect(
      reservePrivateBlobAsset({
        pathname: pathname("room_a", 0),
        roomId: "room_a",
        participantId: "participant_a",
      }),
    ).rejects.toMatchObject({ code: "ASSET_CAPACITY_EXCEEDED" });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("HINCRBY", KEYS[2], "reservedBytes", reservation_bytes)'),
      6,
      expect.stringMatching(/^jazzboard:blob-assets:v1:path:[a-f0-9]{64}$/),
      "jazzboard:blob-assets:v1:capacity:global",
      expect.stringMatching(/^jazzboard:blob-assets:v1:capacity:room:[a-f0-9]{64}$/),
      "jazzboard:blob-assets:v1:cleanup",
      expect.stringMatching(/^jazzboard:blob-assets:v1:reservations:participant:[a-f0-9]{64}$/),
      "jazzboard:blob-assets:v1:reservations",
      expect.any(String),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(String),
      expect.any(String),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });
});
