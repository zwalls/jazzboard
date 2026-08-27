// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { blobAssetPathname, privateAssetProxyPath } from "@/lib/assets/policy";
import { roomBlobNamespace } from "@/lib/assets/private";
import type { RoomState } from "@/lib/domain/types";

import {
  cleanupPrivateBlobAssets,
  type BlobAssetCleanupDependencies,
} from "./blob-asset-cleanup";
import type {
  BlobAssetCleanupClaim,
  BlobAssetRegistration,
} from "./blob-asset-registry";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;
const UUIDS = [
  "550e8400-e29b-41d4-a716-446655440000",
  "550e8400-e29b-41d4-a716-446655440001",
  "550e8400-e29b-41d4-a716-446655440002",
  "550e8400-e29b-41d4-a716-446655440003",
  "550e8400-e29b-41d4-a716-446655440004",
  "550e8400-e29b-41d4-a716-446655440005",
];

function path(roomId: string, index: number): string {
  return blobAssetPathname(roomBlobNamespace(roomId), `${UUIDS[index]}-image.png`);
}

function registration(input: {
  pathname: string;
  roomId: string;
  status: BlobAssetRegistration["status"];
}): BlobAssetRegistration {
  const committed = input.status !== "reserved";
  return {
    version: 1,
    pathname: input.pathname,
    pathnameHash: `path-${input.pathname}`,
    roomId: input.roomId,
    roomHash: `room-${input.roomId}`,
    participantHash: "participant",
    status: input.status,
    reservationBytes: 10 * 1024 * 1024,
    size: committed ? 100 : null,
    contentType: committed ? "image/png" : null,
    etag: committed ? `"etag-${input.pathname}"` : null,
    createdAt: NOW - DAY * 2,
    finalizedAt: committed ? NOW - DAY * 2 : null,
    cleanupClaimId: input.status === "cleanup-claimed" ? "prior-cleanup-claim" : null,
    cleanupClaimedAt: input.status === "cleanup-claimed" ? NOW - 10 * 60_000 : null,
  };
}

function room(roomId: string, referenced: string[]): RoomState {
  return {
    id: roomId,
    objects: Object.fromEntries(
      referenced.map((pathname, index) => [
        `image_${index}`,
        {
          id: `image_${index}`,
          kind: "image",
          url: privateAssetProxyPath(roomId, pathname),
        },
      ]),
    ),
  } as unknown as RoomState;
}

function providerMetadata(pathname: string) {
  return {
    pathname,
    size: 100,
    contentType: "image/png",
    etag: `"etag-${pathname}"`,
    uploadedAt: new Date(NOW - DAY * 2),
    contentDisposition: "inline",
    url: "https://private.example/image",
    downloadUrl: "https://private.example/image?download=1",
    cacheControl: "max-age=0",
  };
}

function claimRegistrationMock(registrations: BlobAssetRegistration[]) {
  return vi.fn(async (input: { pathname: string; claimId?: string }) => {
    const index = registrations.findIndex((registration) => registration.pathname === input.pathname);
    if (index < 0) return { outcome: "missing" as const };
    const existing = registrations[index];
    const claimId = input.claimId ?? `cleanup-claim-${index}`;
    const claim: BlobAssetCleanupClaim = {
      claimId,
      disposition: input.claimId
        ? "resumed"
        : existing.status === "cleanup-claimed"
          ? "recovered"
          : "fresh",
      registration: {
        ...existing,
        status: "cleanup-claimed",
        cleanupClaimId: claimId,
        cleanupClaimedAt: NOW,
      },
    };
    return { outcome: "claimed" as const, claim };
  });
}

function releaseCleanupClaimMock(registrations: BlobAssetRegistration[]) {
  return vi.fn(async (input: { pathname: string }) => {
    const existing = registrations.find((registration) => registration.pathname === input.pathname);
    return existing
      ? {
          ...existing,
          status: "committed" as const,
          cleanupClaimId: null,
          cleanupClaimedAt: null,
        }
      : null;
  });
}

describe("bounded private Blob cleanup", () => {
  it("deletes only stale exact Jazzboard paths proven unreferenced", async () => {
    const referencedCommitted = registration({
      pathname: path("room_a", 0),
      roomId: "room_a",
      status: "committed",
    });
    const unreferencedCommitted = registration({
      pathname: path("room_a", 1),
      roomId: "room_a",
      status: "committed",
    });
    const missingReservation = registration({
      pathname: path("room_b", 2),
      roomId: "room_b",
      status: "reserved",
    });
    const referencedReservation = registration({
      pathname: path("room_a", 3),
      roomId: "room_a",
      status: "reserved",
    });
    const staleUnregistered = path("room_c", 4);
    const recentUnregistered = path("room_c", 5);
    const registered = [
      referencedCommitted,
      unreferencedCommitted,
      missingReservation,
      referencedReservation,
    ];
    const claimRegistration = claimRegistrationMock(registered);
    const releaseCleanupClaim = releaseCleanupClaimMock(registered);
    const getRoom = vi.fn().mockImplementation(async (roomId: string) =>
      roomId === "room_a"
        ? room("room_a", [referencedCommitted.pathname, referencedReservation.pathname])
        : null,
    );
    const deleteBlob = vi.fn();

    const dependencies = {
      listCandidates: vi.fn().mockResolvedValue(registered),
      getRegistrations: vi.fn().mockImplementation(async (pathnames: string[]) =>
        new Map(
          pathnames
            .filter((pathname) => pathname === referencedCommitted.pathname)
            .map((pathname) => [pathname, referencedCommitted]),
        ),
      ),
      getRoom,
      headBlob: vi.fn().mockImplementation(async (pathname: string) =>
        pathname === referencedReservation.pathname ? providerMetadata(pathname) : null,
      ),
      listBlobs: vi.fn().mockResolvedValue({
        blobs: [
          {
            ...providerMetadata(referencedCommitted.pathname),
            uploadedAt: new Date(NOW - DAY * 2),
          },
          {
            ...providerMetadata(staleUnregistered),
            uploadedAt: new Date(NOW - DAY * 2),
          },
          {
            ...providerMetadata(recentUnregistered),
            uploadedAt: new Date(NOW - 1_000),
          },
          {
            ...providerMetadata("jazzboard/__health__/private-store-probe-do-not-create"),
            uploadedAt: new Date(NOW - DAY * 10),
          },
        ],
        hasMore: true,
      }),
      deleteBlob,
      finalizeRegistration: vi.fn(),
      deleteRegistration: vi.fn(),
      deferCleanup: vi.fn(),
      claimRegistration,
      releaseCleanupClaim,
    } as unknown as BlobAssetCleanupDependencies;

    const summary = await cleanupPrivateBlobAssets({ now: NOW, dependencies });

    expect(summary).toEqual({
      registryCandidates: 4,
      deletedRegistered: 2,
      finalizedReferenced: 1,
      deferredReferenced: 1,
      deferredRetention: 0,
      cleanupClaimsBusy: 0,
      recoveredCleanupClaims: 0,
      deletedUnregistered: 1,
      unsafeProviderEntriesSkipped: 1,
      errors: 0,
      providerListTruncated: true,
    });
    expect(dependencies.deleteBlob).toHaveBeenCalledTimes(2);
    expect(dependencies.deleteBlob).toHaveBeenCalledWith({
      pathname: unreferencedCommitted.pathname,
      ifMatch: unreferencedCommitted.etag,
    });
    expect(dependencies.deleteBlob).toHaveBeenCalledWith({
      pathname: staleUnregistered,
      ifMatch: `"etag-${staleUnregistered}"`,
    });
    expect(dependencies.deleteBlob).not.toHaveBeenCalledWith(
      expect.objectContaining({ pathname: recentUnregistered }),
    );
    expect(dependencies.deleteBlob).not.toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "jazzboard/__health__/private-store-probe-do-not-create" }),
    );
    expect(dependencies.finalizeRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: referencedReservation.pathname,
        roomId: "room_a",
        size: 100,
      }),
    );
    expect(claimRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: referencedCommitted.pathname }),
    );
    expect(claimRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: unreferencedCommitted.pathname,
        claimId: "cleanup-claim-1",
      }),
    );
    expect(releaseCleanupClaim).toHaveBeenCalledWith({
      pathname: referencedCommitted.pathname,
      roomId: "room_a",
      claimId: "cleanup-claim-0",
      nextCheckAt: NOW + DAY,
    });
    expect(claimRegistration.mock.invocationCallOrder[0]).toBeLessThan(
      getRoom.mock.invocationCallOrder.at(-1)!,
    );
    expect(getRoom.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      deleteBlob.mock.invocationCallOrder[0],
    );
  });

  it("retains an asset when authoritative room state is temporarily unavailable", async () => {
    const candidate = registration({
      pathname: path("room_a", 0),
      roomId: "room_a",
      status: "committed",
    });
    const claimRegistration = claimRegistrationMock([candidate]);
    const releaseCleanupClaim = releaseCleanupClaimMock([candidate]);
    const dependencies = {
      listCandidates: vi.fn().mockResolvedValue([candidate]),
      getRegistrations: vi.fn().mockResolvedValue(new Map()),
      getRoom: vi.fn().mockRejectedValue(new Error("Redis unavailable")),
      headBlob: vi.fn(),
      listBlobs: vi.fn().mockResolvedValue({ blobs: [], hasMore: false }),
      deleteBlob: vi.fn(),
      finalizeRegistration: vi.fn(),
      deleteRegistration: vi.fn(),
      deferCleanup: vi.fn(),
      claimRegistration,
      releaseCleanupClaim,
    } as unknown as BlobAssetCleanupDependencies;

    await expect(cleanupPrivateBlobAssets({ now: NOW, dependencies })).resolves.toMatchObject({
      errors: 1,
      deletedRegistered: 0,
    });
    expect(dependencies.deleteBlob).not.toHaveBeenCalled();
    expect(dependencies.deleteRegistration).not.toHaveBeenCalled();
    expect(claimRegistration).toHaveBeenCalledOnce();
    expect(releaseCleanupClaim).toHaveBeenCalledWith({
      pathname: candidate.pathname,
      roomId: "room_a",
      claimId: "cleanup-claim-0",
      nextCheckAt: NOW + 5 * 60_000,
    });
  });

  it("claims before the room re-read and releases when a concurrent reference wins", async () => {
    const candidate = registration({
      pathname: path("room_a", 0),
      roomId: "room_a",
      status: "committed",
    });
    const claimRegistration = claimRegistrationMock([candidate]);
    const releaseCleanupClaim = releaseCleanupClaimMock([candidate]);
    const getRoom = vi.fn().mockResolvedValue(room("room_a", [candidate.pathname]));
    const deleteBlob = vi.fn();
    const dependencies = {
      listCandidates: vi.fn().mockResolvedValue([candidate]),
      getRegistrations: vi.fn().mockResolvedValue(new Map()),
      getRoom,
      headBlob: vi.fn(),
      listBlobs: vi.fn().mockResolvedValue({ blobs: [], hasMore: false }),
      deleteBlob,
      finalizeRegistration: vi.fn(),
      deleteRegistration: vi.fn(),
      deferCleanup: vi.fn(),
      claimRegistration,
      releaseCleanupClaim,
    } as unknown as BlobAssetCleanupDependencies;

    const summary = await cleanupPrivateBlobAssets({ now: NOW, dependencies });

    expect(claimRegistration.mock.invocationCallOrder[0]).toBeLessThan(
      getRoom.mock.invocationCallOrder[0],
    );
    expect(getRoom.mock.invocationCallOrder[0]).toBeLessThan(
      releaseCleanupClaim.mock.invocationCallOrder[0],
    );
    expect(deleteBlob).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ deferredReferenced: 1, errors: 0 });
  });

  it("bounds active cleanup claims by reconciling one room before claiming the next", async () => {
    const firstCandidate = registration({
      pathname: path("room_a", 0),
      roomId: "room_a",
      status: "committed",
    });
    const secondCandidate = registration({
      pathname: path("room_b", 1),
      roomId: "room_b",
      status: "committed",
    });
    const registered = [firstCandidate, secondCandidate];
    const claimRegistration = claimRegistrationMock(registered);
    const releaseCleanupClaim = releaseCleanupClaimMock(registered);
    const getRoom = vi.fn().mockImplementation(async (roomId: string) =>
      room(
        roomId,
        roomId === "room_a" ? [firstCandidate.pathname] : [secondCandidate.pathname],
      ),
    );
    const dependencies = {
      listCandidates: vi.fn().mockResolvedValue(registered),
      getRegistrations: vi.fn().mockResolvedValue(new Map()),
      getRoom,
      headBlob: vi.fn(),
      listBlobs: vi.fn().mockResolvedValue({ blobs: [], hasMore: false }),
      deleteBlob: vi.fn(),
      finalizeRegistration: vi.fn(),
      deleteRegistration: vi.fn(),
      deferCleanup: vi.fn(),
      claimRegistration,
      releaseCleanupClaim,
    } as unknown as BlobAssetCleanupDependencies;

    await cleanupPrivateBlobAssets({ now: NOW, dependencies });

    expect(claimRegistration.mock.invocationCallOrder[0]).toBeLessThan(
      getRoom.mock.invocationCallOrder[0],
    );
    expect(getRoom.mock.invocationCallOrder[0]).toBeLessThan(
      releaseCleanupClaim.mock.invocationCallOrder[0],
    );
    expect(releaseCleanupClaim.mock.invocationCallOrder[0]).toBeLessThan(
      claimRegistration.mock.invocationCallOrder[1],
    );
  });

  it("keeps the durable claim when provider deletion is ambiguous", async () => {
    const candidate = registration({
      pathname: path("room_a", 0),
      roomId: "room_a",
      status: "committed",
    });
    const claimRegistration = claimRegistrationMock([candidate]);
    const releaseCleanupClaim = releaseCleanupClaimMock([candidate]);
    const deleteRegistration = vi.fn();
    const dependencies = {
      listCandidates: vi.fn().mockResolvedValue([candidate]),
      getRegistrations: vi.fn().mockResolvedValue(new Map()),
      getRoom: vi.fn().mockResolvedValue(null),
      headBlob: vi.fn(),
      listBlobs: vi.fn().mockResolvedValue({ blobs: [], hasMore: false }),
      deleteBlob: vi.fn().mockRejectedValue(new Error("provider outcome unknown")),
      finalizeRegistration: vi.fn(),
      deleteRegistration,
      deferCleanup: vi.fn(),
      claimRegistration,
      releaseCleanupClaim,
    } as unknown as BlobAssetCleanupDependencies;

    const summary = await cleanupPrivateBlobAssets({ now: NOW, dependencies });

    expect(claimRegistration).toHaveBeenCalledTimes(2);
    expect(claimRegistration).toHaveBeenLastCalledWith(
      expect.objectContaining({ claimId: "cleanup-claim-0" }),
    );
    expect(releaseCleanupClaim).not.toHaveBeenCalled();
    expect(deleteRegistration).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ errors: 1, deletedRegistered: 0 });
  });

  it("releases a recovered referenced claim only after re-proving the provider generation", async () => {
    const candidate = registration({
      pathname: path("room_a", 0),
      roomId: "room_a",
      status: "cleanup-claimed",
    });
    const releaseCleanupClaim = releaseCleanupClaimMock([candidate]);
    const headBlob = vi.fn().mockResolvedValue(providerMetadata(candidate.pathname));
    const dependencies = {
      listCandidates: vi.fn().mockResolvedValue([candidate]),
      getRegistrations: vi.fn().mockResolvedValue(new Map()),
      getRoom: vi.fn().mockResolvedValue(room("room_a", [candidate.pathname])),
      headBlob,
      listBlobs: vi.fn().mockResolvedValue({ blobs: [], hasMore: false }),
      deleteBlob: vi.fn(),
      finalizeRegistration: vi.fn(),
      deleteRegistration: vi.fn(),
      deferCleanup: vi.fn(),
      claimRegistration: claimRegistrationMock([candidate]),
      releaseCleanupClaim,
    } as unknown as BlobAssetCleanupDependencies;

    const summary = await cleanupPrivateBlobAssets({ now: NOW, dependencies });

    expect(headBlob.mock.invocationCallOrder[0]).toBeLessThan(
      releaseCleanupClaim.mock.invocationCallOrder[0],
    );
    expect(releaseCleanupClaim).toHaveBeenCalledWith({
      pathname: candidate.pathname,
      roomId: candidate.roomId,
      claimId: "cleanup-claim-0",
      nextCheckAt: NOW + DAY,
    });
    expect(dependencies.deleteBlob).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      recoveredCleanupClaims: 1,
      deferredReferenced: 1,
      errors: 0,
    });
  });

  it("completes a recovered unreferenced claim when the provider object is already absent", async () => {
    const candidate = registration({
      pathname: path("room_a", 0),
      roomId: "room_a",
      status: "cleanup-claimed",
    });
    const claimRegistration = claimRegistrationMock([candidate]);
    const deleteRegistration = vi.fn().mockResolvedValue(candidate);
    const deleteBlob = vi.fn();
    const dependencies = {
      listCandidates: vi.fn().mockResolvedValue([candidate]),
      getRegistrations: vi.fn().mockResolvedValue(new Map()),
      getRoom: vi.fn().mockResolvedValue(null),
      headBlob: vi.fn().mockResolvedValue(null),
      listBlobs: vi.fn().mockResolvedValue({ blobs: [], hasMore: false }),
      deleteBlob,
      finalizeRegistration: vi.fn(),
      deleteRegistration,
      deferCleanup: vi.fn(),
      claimRegistration,
      releaseCleanupClaim: releaseCleanupClaimMock([candidate]),
    } as unknown as BlobAssetCleanupDependencies;

    const summary = await cleanupPrivateBlobAssets({ now: NOW, dependencies });

    expect(deleteBlob).not.toHaveBeenCalled();
    expect(deleteRegistration).toHaveBeenCalledWith({
      pathname: candidate.pathname,
      expectedEtag: candidate.etag,
      expectedStatus: "cleanup-claimed",
      expectedCleanupClaimId: "cleanup-claim-0",
    });
    expect(summary).toMatchObject({
      recoveredCleanupClaims: 1,
      deletedRegistered: 1,
      errors: 0,
    });
  });

  it("keeps a recovered claim when its provider generation no longer matches", async () => {
    const candidate = registration({
      pathname: path("room_a", 0),
      roomId: "room_a",
      status: "cleanup-claimed",
    });
    const deleteRegistration = vi.fn();
    const deleteBlob = vi.fn();
    const dependencies = {
      listCandidates: vi.fn().mockResolvedValue([candidate]),
      getRegistrations: vi.fn().mockResolvedValue(new Map()),
      getRoom: vi.fn().mockResolvedValue(null),
      headBlob: vi.fn().mockResolvedValue({
        ...providerMetadata(candidate.pathname),
        etag: '"replacement-generation"',
      }),
      listBlobs: vi.fn().mockResolvedValue({ blobs: [], hasMore: false }),
      deleteBlob,
      finalizeRegistration: vi.fn(),
      deleteRegistration,
      deferCleanup: vi.fn(),
      claimRegistration: claimRegistrationMock([candidate]),
      releaseCleanupClaim: releaseCleanupClaimMock([candidate]),
    } as unknown as BlobAssetCleanupDependencies;

    const summary = await cleanupPrivateBlobAssets({ now: NOW, dependencies });

    expect(deleteBlob).not.toHaveBeenCalled();
    expect(deleteRegistration).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      recoveredCleanupClaims: 1,
      deletedRegistered: 0,
      errors: 1,
    });
  });

  it("reclaims stale reservations quickly without shortening committed retention", async () => {
    const staleReservation = registration({
      pathname: path("room_a", 0),
      roomId: "room_a",
      status: "reserved",
    });
    staleReservation.createdAt = NOW - 20 * 60_000;
    const recentCommitted = registration({
      pathname: path("room_b", 1),
      roomId: "room_b",
      status: "committed",
    });
    recentCommitted.createdAt = NOW - 30 * 60_000;
    recentCommitted.finalizedAt = NOW - 10 * 60_000;
    const registered = [staleReservation, recentCommitted];
    const claimRegistration = claimRegistrationMock(registered);
    const dependencies = {
      listCandidates: vi.fn().mockResolvedValue(registered),
      getRegistrations: vi.fn().mockResolvedValue(new Map()),
      getRoom: vi.fn().mockResolvedValue(null),
      headBlob: vi.fn().mockResolvedValue(null),
      listBlobs: vi.fn().mockResolvedValue({ blobs: [], hasMore: false }),
      deleteBlob: vi.fn(),
      finalizeRegistration: vi.fn(),
      deleteRegistration: vi.fn(),
      deferCleanup: vi.fn(),
      claimRegistration,
      releaseCleanupClaim: releaseCleanupClaimMock(registered),
    } as unknown as BlobAssetCleanupDependencies;

    const summary = await cleanupPrivateBlobAssets({
      now: NOW,
      retentionMs: DAY,
      reservationRetentionMs: 15 * 60_000,
      dependencies,
    });

    expect(dependencies.listCandidates).toHaveBeenCalledWith(
      NOW - 15 * 60_000,
      expect.any(Number),
    );
    expect(dependencies.deleteRegistration).toHaveBeenCalledWith({
      pathname: staleReservation.pathname,
      expectedStatus: "reserved",
      expectedCreatedAt: staleReservation.createdAt,
    });
    expect(dependencies.deleteBlob).not.toHaveBeenCalledWith(
      expect.objectContaining({ pathname: recentCommitted.pathname }),
    );
    expect(dependencies.deferCleanup).toHaveBeenCalledWith(
      recentCommitted.pathname,
      recentCommitted.finalizedAt! + DAY,
    );
    expect(summary).toMatchObject({ deletedRegistered: 1, deferredRetention: 1 });
    expect(claimRegistration).not.toHaveBeenCalled();
  });

  it("claims a stale reservation before deleting its provider object", async () => {
    const candidate = registration({
      pathname: path("room_a", 0),
      roomId: "room_a",
      status: "reserved",
    });
    const deleteBlob = vi.fn();
    const deleteRegistration = vi.fn().mockResolvedValue(candidate);
    const dependencies = {
      listCandidates: vi.fn().mockResolvedValue([candidate]),
      getRegistrations: vi.fn().mockResolvedValue(new Map()),
      getRoom: vi.fn().mockResolvedValue(null),
      headBlob: vi.fn().mockResolvedValue(providerMetadata(candidate.pathname)),
      listBlobs: vi.fn().mockResolvedValue({ blobs: [], hasMore: false }),
      deleteBlob,
      finalizeRegistration: vi.fn(),
      deleteRegistration,
      deferCleanup: vi.fn(),
      claimRegistration: claimRegistrationMock([candidate]),
      releaseCleanupClaim: releaseCleanupClaimMock([candidate]),
    } as unknown as BlobAssetCleanupDependencies;

    await cleanupPrivateBlobAssets({ now: NOW, dependencies });

    expect(deleteRegistration.mock.invocationCallOrder[0]).toBeLessThan(
      deleteBlob.mock.invocationCallOrder[0],
    );
    expect(dependencies.deleteRegistration).toHaveBeenCalledWith({
      pathname: candidate.pathname,
      expectedStatus: "reserved",
      expectedCreatedAt: candidate.createdAt,
    });
    expect(dependencies.deleteBlob).toHaveBeenCalledWith({
      pathname: candidate.pathname,
      ifMatch: candidate.etag ?? providerMetadata(candidate.pathname).etag,
    });
  });
});
