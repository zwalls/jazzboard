import {
  requireMutationRole,
  requireParticipant,
} from "@/lib/domain/engine";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import type {
  ActivityMutationMetadata,
  ActorKind,
  Point,
} from "@/lib/domain/types";
import { renderDiagramMermaid } from "@/lib/interchange/mermaid";
import { projectJazzboardArtifact, serializeJazzboardArtifact } from "@/lib/interchange/project";
import { renderJazzboardSvg } from "@/lib/interchange/svg";
import { createJazzboardTemplate, planTemplateInstantiation } from "@/lib/interchange/templates";
import {
  JazzboardInterchangeError,
  type JazzboardArtifactWarning,
  type JazzboardTemplateV1,
  type ProjectArtifactScope,
  type TemplateCreateIdKind,
  type TemplateIdMap,
} from "@/lib/interchange/types";

import {
  readAuthorizedRoom,
  runSemanticTransaction,
  type CanvasMutationOutcome,
} from "./room-service";
import { getRoomStore } from "./room-store";

export const JAZZBOARD_ARTIFACT_EXPORT_FORMATS = [
  "semantic_json",
  "mermaid",
  "svg",
  "template",
] as const;

export type JazzboardArtifactExportFormat = (typeof JAZZBOARD_ARTIFACT_EXPORT_FORMATS)[number];

export type AuthorizedArtifactExport = {
  format: JazzboardArtifactExportFormat;
  mediaType: string;
  filename: string;
  content: string;
  warnings: JazzboardArtifactWarning[];
  sourceRoomRevision: number;
  sourceDiagramRevision: number | null;
};

function safeFileStem(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "jazzboard";
}

function asDomainError(error: unknown): never {
  if (isDomainError(error)) throw error;
  if (error instanceof JazzboardInterchangeError) {
    const code = error.code === "DIAGRAM_NOT_FOUND"
      ? "DIAGRAM_NOT_FOUND"
      : error.code === "TEMPLATE_ID_COLLISION"
        ? "REVISION_CONFLICT"
        : "INVALID_OPERATION";
    throw new DomainError(code, error.message, error.details);
  }
  throw error;
}

/** Export only from a room state already authorized to this signed session. */
export async function exportAuthorizedRoomArtifact(input: {
  roomId: string;
  participantId: string;
  actorKind: ActorKind;
  format: JazzboardArtifactExportFormat;
  scope: ProjectArtifactScope;
}): Promise<AuthorizedArtifactExport> {
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  const participant = requireParticipant(room, input.participantId);
  if (input.format === "template") {
    requireMutationRole(participant, input.actorKind);
    if (input.scope.kind !== "diagram") {
      throw new DomainError(
        "INVALID_OPERATION",
        "A reusable template must be exported from one exact Diagram scope.",
      );
    }
  }

  try {
    const artifact = projectJazzboardArtifact(room, input.scope);
    const sourceDiagramRevision = artifact.source.diagramRevision;
    if (input.format === "semantic_json") {
      return {
        format: input.format,
        mediaType: "application/vnd.jazzboard.semantic+json; charset=utf-8",
        filename: `${safeFileStem(artifact.title)}.jazzboard.json`,
        content: serializeJazzboardArtifact(artifact),
        warnings: artifact.warnings,
        sourceRoomRevision: artifact.source.roomRevision,
        sourceDiagramRevision,
      };
    }
    if (input.format === "mermaid") {
      const rendered = renderDiagramMermaid(artifact);
      return {
        format: input.format,
        mediaType: "text/vnd.mermaid; charset=utf-8",
        filename: `${safeFileStem(artifact.title)}.mmd`,
        content: rendered.source,
        warnings: rendered.warnings,
        sourceRoomRevision: artifact.source.roomRevision,
        sourceDiagramRevision,
      };
    }
    if (input.format === "svg") {
      const rendered = renderJazzboardSvg(artifact);
      return {
        format: input.format,
        mediaType: "image/svg+xml; charset=utf-8",
        filename: `${safeFileStem(artifact.title)}.svg`,
        content: rendered.svg,
        warnings: rendered.warnings,
        sourceRoomRevision: artifact.source.roomRevision,
        sourceDiagramRevision,
      };
    }

    const template = createJazzboardTemplate(artifact);
    return {
      format: input.format,
      mediaType: "application/vnd.jazzboard.template+json; charset=utf-8",
      filename: `${safeFileStem(template.title)}.jazzboard-template.json`,
      content: serializeJazzboardArtifact(template),
      warnings: template.warnings,
      sourceRoomRevision: artifact.source.roomRevision,
      sourceDiagramRevision,
    };
  } catch (error) {
    return asDomainError(error);
  }
}

export type TemplateInstantiationResult = CanvasMutationOutcome & {
  idMap: TemplateIdMap;
  bounds: { x: number; y: number; width: number; height: number };
  warnings: JazzboardArtifactWarning[];
};

type TemplateInstantiationDependencies = {
  createId?: (kind: TemplateCreateIdKind, sourceId: string) => string;
};

/**
 * Instantiate inside one room-store transaction so the room revision guard,
 * collision checks, semantic creates, activity record, and realtime event are
 * committed or rejected together.
 */
export async function instantiateAuthorizedRoomTemplate(
  input: {
    roomId: string;
    participantId: string;
    actorKind: ActorKind;
    expectedRoomRevision: number;
    template: JazzboardTemplateV1;
    origin: Point;
    baseZIndex?: number;
    metadata?: ActivityMutationMetadata;
  },
  dependencies: TemplateInstantiationDependencies = {},
): Promise<TemplateInstantiationResult> {
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  const participant = requireParticipant(room, input.participantId);
  requireMutationRole(participant, input.actorKind);
  // Template planning happens before the authoritative room transaction so it
  // can reserve fresh IDs. Check a verified receipt first: otherwise a retry of
  // an already-committed template could fail its now-stale revision or collide
  // with its own generated IDs before the store gets a chance to identify it.
  await getRoomStore().assertMutationNotReplayed(input.roomId);

  try {
    const reservedIds = new Set<string>([
      ...Object.keys(room.objects),
      ...Object.keys(room.diagrams ?? {}),
      ...Object.values(room.objects).flatMap((object) => object.groupId ? [object.groupId] : []),
    ]);
    const plan = planTemplateInstantiation(input.template, {
      origin: input.origin,
      baseZIndex: input.baseZIndex,
      reservedIds,
      createId: dependencies.createId,
    });
    const result = await runSemanticTransaction({
      roomId: input.roomId,
      participantId: input.participantId,
      actorKind: input.actorKind,
      transaction: plan.transaction,
      metadata: input.metadata,
      expectedRoomRevision: input.expectedRoomRevision,
    });
    return {
      ...result,
      idMap: plan.idMap,
      bounds: plan.bounds,
      warnings: plan.warnings,
    };
  } catch (error) {
    return asDomainError(error);
  }
}
