import { createHash, randomBytes } from "node:crypto";

import { actorFor, requireMutationRole, requireParticipant } from "@/lib/domain/engine";
import { DomainError } from "@/lib/domain/errors";
import type { ActorKind } from "@/lib/domain/types";
import { projectJazzboardArtifact } from "@/lib/interchange/project";
import { parseJazzboardArtifactV1 } from "@/lib/interchange/schemas";

import { readAuthorizedRoom } from "./room-service";
import {
  getSnapshotStore,
  type ReadonlySnapshotRecord,
  type SnapshotScope,
} from "./snapshot-store";

const SNAPSHOT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_EXPIRY_HOURS = 24;
const MAX_EXPIRY_HOURS = 7 * 24;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type PublicReadonlySnapshot = ReturnType<typeof publicSnapshot>;

function publicSnapshot(record: ReadonlySnapshotRecord) {
  return {
    title: record.title,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    creator: {
      displayName: record.creator.displayName,
      kind: record.creator.kind,
    },
    artifact: record.artifact,
  };
}

export async function createReadonlySnapshot(input: {
  roomId: string;
  participantId: string;
  actorKind: ActorKind;
  expectedRoomRevision: number;
  scope: SnapshotScope;
  expiresInHours?: number;
  title?: string;
}) {
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  const participant = requireParticipant(room, input.participantId);
  requireMutationRole(participant, input.actorKind);
  if (room.roomRevision !== input.expectedRoomRevision) {
    throw new DomainError(
      "REVISION_CONFLICT",
      `Room revision changed from ${input.expectedRoomRevision} to ${room.roomRevision}.`,
      { expectedRevision: input.expectedRoomRevision, currentRevision: room.roomRevision },
    );
  }
  if (input.scope.kind === "diagram") {
    const diagram = room.diagrams[input.scope.diagramId];
    if (!diagram) {
      throw new DomainError("DIAGRAM_NOT_FOUND", `Diagram ${input.scope.diagramId} is not in this room.`);
    }
    if (diagram.revision !== input.scope.expectedDiagramRevision) {
      throw new DomainError(
        "REVISION_CONFLICT",
        `Diagram ${diagram.id} changed from revision ${input.scope.expectedDiagramRevision} to ${diagram.revision}.`,
        {
          diagramId: diagram.id,
          expectedRevision: input.scope.expectedDiagramRevision,
          currentRevision: diagram.revision,
        },
      );
    }
  }

  const projectedArtifact = projectJazzboardArtifact(
    room,
    input.scope.kind === "room"
      ? { kind: "room" }
      : { kind: "diagram", diagramId: input.scope.diagramId },
  );
  const artifact = { ...projectedArtifact, kind: "snapshot" as const };
  const token = randomBytes(32).toString("base64url");
  const createdAt = Date.now();
  const expiresInHours = Math.min(
    Math.max(input.expiresInHours ?? DEFAULT_EXPIRY_HOURS, 1),
    MAX_EXPIRY_HOURS,
  );
  const record = await getSnapshotStore().create({
    tokenHash: hashToken(token),
    sourceRoomId: room.id,
    sourceRoomRevision: room.roomRevision,
    creatorParticipantId: participant.participantId,
    creator: actorFor(participant, input.actorKind),
    scope: input.scope,
    title: input.title?.trim() || artifact.title,
    createdAt,
    expiresAt: createdAt + expiresInHours * 60 * 60 * 1_000,
    artifact,
  });
  return {
    snapshot: {
      id: record.id,
      title: record.title,
      scope: record.scope,
      sourceRoomRevision: record.sourceRoomRevision,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      path: `/snapshot/${token}`,
    },
  };
}

export async function listReadonlySnapshots(input: {
  roomId: string;
  participantId: string;
  actorKind: ActorKind;
}) {
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  const participant = requireParticipant(room, input.participantId);
  requireMutationRole(participant, input.actorKind);
  return {
    snapshots: await getSnapshotStore().listForCreator(input.roomId, input.participantId),
  };
}

export async function revokeReadonlySnapshot(input: {
  roomId: string;
  participantId: string;
  actorKind: ActorKind;
  snapshotId: string;
}) {
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  const participant = requireParticipant(room, input.participantId);
  requireMutationRole(participant, input.actorKind);
  const revoked = await getSnapshotStore().revoke(
    input.roomId,
    input.participantId,
    input.snapshotId,
  );
  if (!revoked) {
    throw new DomainError("SNAPSHOT_NOT_FOUND", "That snapshot is unavailable.");
  }
  return { snapshotId: input.snapshotId, revoked: true };
}

export async function readPublicSnapshot(token: string) {
  if (!SNAPSHOT_TOKEN_PATTERN.test(token)) {
    throw new DomainError("SNAPSHOT_NOT_FOUND", "That snapshot is unavailable.");
  }
  const record = await getSnapshotStore().getByTokenHash(hashToken(token));
  if (!record) throw new DomainError("SNAPSHOT_NOT_FOUND", "That snapshot is unavailable.");
  try {
    const artifact = parseJazzboardArtifactV1(record.artifact);
    if (artifact.kind !== "snapshot") {
      throw new DomainError("SNAPSHOT_NOT_FOUND", "That snapshot is unavailable.");
    }
    return publicSnapshot({ ...record, artifact });
  } catch {
    throw new DomainError("SNAPSHOT_NOT_FOUND", "That snapshot is unavailable.");
  }
}
