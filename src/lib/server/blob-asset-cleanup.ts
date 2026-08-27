import {
  isDedicatedPrivateBlobPathname,
  isSupportedImageMimeType,
  parseRoomAssetProxyReference,
} from "@/lib/assets/policy";
import type { RoomState } from "@/lib/domain/types";

import {
  BLOB_ASSET_ORPHAN_RETENTION_MS,
  BLOB_ASSET_RESERVATION_RETENTION_MS,
  BLOB_ASSET_CLEANUP_CLAIM_LEASE_MS,
  claimCommittedPrivateBlobAssetForCleanup,
  deferPrivateBlobAssetCleanup,
  deletePrivateBlobAssetRegistration,
  finalizePrivateBlobAssetRegistration,
  getPrivateBlobAssetRegistrations,
  listPrivateBlobAssetCleanupCandidates,
  releasePrivateBlobAssetCleanupClaim,
  type BlobAssetCleanupClaim,
  type BlobAssetRegistration,
} from "./blob-asset-registry";
import {
  deletePrivateBlob,
  headPrivateBlob,
  listPrivateBlobAssets,
} from "./private-blob-assets";
import { getRoomStore } from "./room-store";

const MAX_REGISTRY_CANDIDATES_PER_RUN = 500;
const MAX_UNREGISTERED_BLOBS_PER_RUN = 1_000;

export type PrivateBlobCleanupSummary = {
  registryCandidates: number;
  deletedRegistered: number;
  finalizedReferenced: number;
  deferredReferenced: number;
  deferredRetention: number;
  cleanupClaimsBusy: number;
  recoveredCleanupClaims: number;
  deletedUnregistered: number;
  unsafeProviderEntriesSkipped: number;
  errors: number;
  providerListTruncated: boolean;
};

export type BlobAssetCleanupDependencies = {
  listCandidates: typeof listPrivateBlobAssetCleanupCandidates;
  getRegistrations: typeof getPrivateBlobAssetRegistrations;
  getRoom: (roomId: string) => Promise<RoomState | null>;
  headBlob: typeof headPrivateBlob;
  listBlobs: typeof listPrivateBlobAssets;
  deleteBlob: typeof deletePrivateBlob;
  finalizeRegistration: typeof finalizePrivateBlobAssetRegistration;
  deleteRegistration: typeof deletePrivateBlobAssetRegistration;
  deferCleanup: typeof deferPrivateBlobAssetCleanup;
  claimRegistration: typeof claimCommittedPrivateBlobAssetForCleanup;
  releaseCleanupClaim: typeof releasePrivateBlobAssetCleanupClaim;
};

const productionDependencies: BlobAssetCleanupDependencies = {
  listCandidates: listPrivateBlobAssetCleanupCandidates,
  getRegistrations: getPrivateBlobAssetRegistrations,
  getRoom: (roomId) => getRoomStore().getRoom(roomId),
  headBlob: headPrivateBlob,
  listBlobs: listPrivateBlobAssets,
  deleteBlob: deletePrivateBlob,
  finalizeRegistration: finalizePrivateBlobAssetRegistration,
  deleteRegistration: deletePrivateBlobAssetRegistration,
  deferCleanup: deferPrivateBlobAssetCleanup,
  claimRegistration: claimCommittedPrivateBlobAssetForCleanup,
  releaseCleanupClaim: releasePrivateBlobAssetCleanupClaim,
};

function roomReferencesPathname(room: RoomState | null, registration: BlobAssetRegistration): boolean {
  if (!room) return false;
  return Object.values(room.objects).some((object) => {
    if (object.kind !== "image") return false;
    const reference = parseRoomAssetProxyReference(object.url);
    return (
      reference?.roomId === registration.roomId &&
      reference.pathname === registration.pathname
    );
  });
}

export async function cleanupPrivateBlobAssets(input: {
  now?: number;
  retentionMs?: number;
  reservationRetentionMs?: number;
  dependencies?: BlobAssetCleanupDependencies;
} = {}): Promise<PrivateBlobCleanupSummary> {
  const now = input.now ?? Date.now();
  const retentionMs = input.retentionMs ?? BLOB_ASSET_ORPHAN_RETENTION_MS;
  const reservationRetentionMs =
    input.reservationRetentionMs ?? BLOB_ASSET_RESERVATION_RETENTION_MS;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(retentionMs) ||
    retentionMs < 1 ||
    !Number.isSafeInteger(reservationRetentionMs) ||
    reservationRetentionMs < 1
  ) {
    throw new Error("Blob cleanup timestamps must be positive safe integers.");
  }
  const committedOlderThan = now - retentionMs;
  const reservationOlderThan = now - reservationRetentionMs;
  const dependencies = input.dependencies ?? productionDependencies;
  const candidates = await dependencies.listCandidates(
    reservationOlderThan,
    MAX_REGISTRY_CANDIDATES_PER_RUN,
  );
  const summary: PrivateBlobCleanupSummary = {
    registryCandidates: candidates.length,
    deletedRegistered: 0,
    finalizedReferenced: 0,
    deferredReferenced: 0,
    deferredRetention: 0,
    cleanupClaimsBusy: 0,
    recoveredCleanupClaims: 0,
    deletedUnregistered: 0,
    unsafeProviderEntriesSkipped: 0,
    errors: 0,
    providerListTruncated: false,
  };
  const roomReads = new Map<string, Promise<RoomState | null>>();
  const readRoom = (roomId: string) => {
    let pending = roomReads.get(roomId);
    if (!pending) {
      pending = dependencies.getRoom(roomId);
      roomReads.set(roomId, pending);
    }
    return pending;
  };
  const committedCandidatesByRoom = new Map<string, BlobAssetRegistration[]>();

  for (const registration of candidates) {
    try {
      if (!isDedicatedPrivateBlobPathname(registration.pathname)) {
        summary.unsafeProviderEntriesSkipped += 1;
        continue;
      }
      if (registration.status === "committed" || registration.status === "cleanup-claimed") {
        const committedAt = registration.finalizedAt ?? registration.createdAt;
        const eligibleAt = committedAt + retentionMs;
        if (registration.status === "committed" && eligibleAt > now) {
          await dependencies.deferCleanup(registration.pathname, eligibleAt);
          summary.deferredRetention += 1;
          continue;
        }
        if (!registration.etag) {
          summary.errors += 1;
          continue;
        }
        const roomCandidates = committedCandidatesByRoom.get(registration.roomId) ?? [];
        roomCandidates.push(registration);
        committedCandidatesByRoom.set(registration.roomId, roomCandidates);
        continue;
      }

      const referenced = roomReferencesPathname(
        await readRoom(registration.roomId),
        registration,
      );
      const metadata = await dependencies.headBlob(registration.pathname);
      if (!metadata) {
        await dependencies.deleteRegistration({
          pathname: registration.pathname,
          expectedStatus: "reserved",
          expectedCreatedAt: registration.createdAt,
        });
        summary.deletedRegistered += 1;
        continue;
      }
      if (metadata.pathname !== registration.pathname) {
        summary.errors += 1;
        continue;
      }
      const metadataIsValid =
        metadata.size >= 1 &&
        metadata.size <= registration.reservationBytes &&
        isSupportedImageMimeType(metadata.contentType);
      if (referenced && metadataIsValid) {
        await dependencies.finalizeRegistration({
          pathname: registration.pathname,
          roomId: registration.roomId,
          size: metadata.size,
          contentType: metadata.contentType,
          etag: metadata.etag,
          now,
        });
        await dependencies.deferCleanup(registration.pathname, now + retentionMs);
        summary.finalizedReferenced += 1;
        continue;
      }
      const deletedReservation = await dependencies.deleteRegistration({
        pathname: registration.pathname,
        expectedStatus: "reserved",
        expectedCreatedAt: registration.createdAt,
      });
      if (!deletedReservation) continue;
      await dependencies.deleteBlob({
        pathname: registration.pathname,
        ifMatch: metadata.etag,
      });
      summary.deletedRegistered += 1;
    } catch {
      // An unavailable room or provider is uncertainty, not evidence that an
      // asset is orphaned. Keep the registration so a later daily run can retry.
      summary.errors += 1;
    }
  }

  for (const [roomId, roomCandidates] of committedCandidatesByRoom) {
    const claims: BlobAssetCleanupClaim[] = [];
    // Claim and reconcile one bounded room at a time. This keeps the durable
    // claim window short and limits the blast radius if the serverless cleanup
    // invocation is interrupted before it can release or delete registrations.
    for (const registration of roomCandidates) {
      try {
        const attempt = await dependencies.claimRegistration({
          pathname: registration.pathname,
          roomId,
          expectedEtag: registration.etag!,
          now,
        });
        if (attempt.outcome === "busy") {
          summary.cleanupClaimsBusy += 1;
          continue;
        }
        if (attempt.outcome !== "claimed") continue;
        if (attempt.claim.disposition === "recovered") {
          summary.recoveredCleanupClaims += 1;
        }
        claims.push(attempt.claim);
      } catch {
        summary.errors += 1;
      }
    }
    if (!claims.length) continue;

    let room: RoomState | null;
    try {
      // This read intentionally happens after every candidate registration in
      // the room is claimed. A room transaction that WATCHes those registration
      // keys either commits first and is visible here, or aborts on the claim.
      room = await dependencies.getRoom(roomId);
    } catch {
      for (const claim of claims) {
        try {
          await dependencies.releaseCleanupClaim({
            pathname: claim.registration.pathname,
            roomId,
            claimId: claim.claimId,
            nextCheckAt: now + BLOB_ASSET_CLEANUP_CLAIM_LEASE_MS,
          });
        } catch {
          // A durable claim is safe to leave behind. A later cleanup can recover
          // it after the lease once authoritative room state is readable again.
        }
        summary.errors += 1;
      }
      continue;
    }

    for (const claim of claims) {
      const registration = claim.registration;
      try {
        let recoveredMetadata: Awaited<ReturnType<typeof headPrivateBlob>> | undefined;
        if (claim.disposition === "recovered") {
          recoveredMetadata = await dependencies.headBlob(registration.pathname);
        }
        if (roomReferencesPathname(room, registration)) {
          if (claim.disposition === "recovered") {
            if (
              !recoveredMetadata ||
              recoveredMetadata.pathname !== registration.pathname ||
              recoveredMetadata.etag !== registration.etag ||
              recoveredMetadata.size !== registration.size ||
              recoveredMetadata.contentType !== registration.contentType
            ) {
              // A recovered claim may represent an ambiguous prior provider
              // deletion. Keep it non-reference-eligible until existence is
              // positively re-established.
              summary.errors += 1;
              continue;
            }
          }
          await dependencies.releaseCleanupClaim({
            pathname: registration.pathname,
            roomId,
            claimId: claim.claimId,
            nextCheckAt: now + retentionMs,
          });
          summary.deferredReferenced += 1;
          continue;
        }

        if (claim.disposition === "recovered") {
          if (!recoveredMetadata) {
            // A prior provider deletion may have committed even if its response
            // was lost. With an authoritative unreferenced room and the exact
            // recovered claim generation, removing only the registry record is
            // the safe completion of that interrupted cleanup.
            await dependencies.deleteRegistration({
              pathname: registration.pathname,
              expectedEtag: registration.etag,
              expectedStatus: "cleanup-claimed",
              expectedCleanupClaimId: claim.claimId,
            });
            summary.deletedRegistered += 1;
            continue;
          }
          if (
            recoveredMetadata.pathname !== registration.pathname ||
            recoveredMetadata.etag !== registration.etag ||
            recoveredMetadata.size !== registration.size ||
            recoveredMetadata.contentType !== registration.contentType
          ) {
            // A different provider generation must never be deleted under a
            // stale cleanup claim. Keep the claim for operator-visible retry.
            summary.errors += 1;
            continue;
          }
        }

        const refreshed = await dependencies.claimRegistration({
          pathname: registration.pathname,
          roomId,
          expectedEtag: registration.etag!,
          claimId: claim.claimId,
          now: input.now === undefined ? Date.now() : now,
        });
        if (
          refreshed.outcome !== "claimed" ||
          refreshed.claim.claimId !== claim.claimId
        ) {
          summary.cleanupClaimsBusy += 1;
          continue;
        }
        await dependencies.deleteBlob({
          pathname: registration.pathname,
          ifMatch: registration.etag ?? undefined,
        });
        await dependencies.deleteRegistration({
          pathname: registration.pathname,
          expectedEtag: registration.etag,
          expectedStatus: "cleanup-claimed",
          expectedCleanupClaimId: claim.claimId,
        });
        summary.deletedRegistered += 1;
      } catch {
        // Provider or registry ambiguity leaves a durable claim. It remains
        // readable for existing room objects but blocks new references until a
        // later cleanup can prove provider state and recover the generation.
        summary.errors += 1;
      }
    }
  }

  const providerPage = await dependencies.listBlobs({
    limit: MAX_UNREGISTERED_BLOBS_PER_RUN,
  });
  summary.providerListTruncated = providerPage.hasMore;
  const eligibleProviderBlobs = providerPage.blobs.filter((blob) => {
    if (!isDedicatedPrivateBlobPathname(blob.pathname)) {
      summary.unsafeProviderEntriesSkipped += 1;
      return false;
    }
    return blob.uploadedAt.getTime() <= committedOlderThan;
  });
  const registrations = await dependencies.getRegistrations(
    eligibleProviderBlobs.map((blob) => blob.pathname),
  );
  for (const blob of eligibleProviderBlobs) {
    if (registrations.has(blob.pathname)) continue;
    try {
      await dependencies.deleteBlob({ pathname: blob.pathname, ifMatch: blob.etag });
      summary.deletedUnregistered += 1;
    } catch {
      summary.errors += 1;
    }
  }

  return summary;
}
