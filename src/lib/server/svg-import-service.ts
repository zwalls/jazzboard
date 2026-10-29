import { randomUUID } from "node:crypto";
import { actorFor, requireMutationRole, requireParticipant } from "@/lib/domain/engine";
import { DomainError } from "@/lib/domain/errors";
import type { ActivityMutationMetadata, ActorKind, Point, SemanticTransaction } from "@/lib/domain/types";
import { importSvgToNativeObjects, SvgNativeImportError } from "@/lib/interchange/svg-import";
import { readAuthorizedRoom, runSemanticTransaction } from "./room-service";
import { getRoomStore } from "./room-store";
import { getAgentCanvasDraftStore } from "./agent-draft-store";
import { AGENT_CANVAS_DRAFT_SCHEMA_VERSION, AGENT_COMMITTED_REVEAL_DURATION_MS } from "@/lib/agent-drafts/types";
import type { AgentCanvasDraft, AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";

/** A deliberately bounded SVG compiler feeding the ordinary atomic mutation path. */
export async function importAuthorizedRoomSvgArtwork(input: {
  roomId: string;
  participantId: string;
  actorKind: ActorKind;
  expectedRoomRevision: number;
  source: string;
  title?: string;
  origin?: Point;
  metadata?: ActivityMutationMetadata;
}) {
  const startedAt = performance.now();
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  const participant = requireParticipant(room, input.participantId);
  requireMutationRole(participant, input.actorKind);
  await getRoomStore().assertMutationNotReplayed(input.roomId);
  if (room.roomRevision !== input.expectedRoomRevision) {
    throw new DomainError("REVISION_CONFLICT", "The board changed. Read its current revision before importing artwork.");
  }
  // Loaded only for SVG imports. Neither the board client nor ordinary room startup needs JSDOM.
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("");
  const parseStartedAt = performance.now();
  let objects;
  try {
    objects = importSvgToNativeObjects(input.source, {
      parser: new dom.window.DOMParser(),
      maxElements: 199,
      maxSourceLength: 65_536,
      origin: input.origin,
      zIndexStart: Math.max(0, ...Object.values(room.objects).map(object => object.zIndex + 1)),
      idForPart: () => `path_${randomUUID()}`,
    });
  } catch (error) {
    if (error instanceof SvgNativeImportError) throw new DomainError("INVALID_OPERATION", error.message);
    throw error;
  } finally {
    dom.window.close();
  }
  if (!objects.length || objects.length > 199) {
    throw new DomainError("INVALID_OPERATION", "SVG imports support 1–199 editable parts per import.");
  }
  const parseDurationMs = performance.now() - parseStartedAt;
  const diagramId = `diagram_${randomUUID()}`;
  const transaction: SemanticTransaction = {
    commands: objects.map(object => ({ type: "create", object })),
    diagramCommands: [{ type: "diagram.create", diagram: {
      id: diagramId,
      title: input.title || "Imported SVG artwork",
      description: "Editable native artwork imported from a supported SVG subset.",
      diagramType: "custom",
      category: "illustration",
      tags: ["svg", "editable-art"],
      memberObjectIds: objects.map(object => object.id),
      connectorIds: [],
    } }],
  };
  const transactionStartedAt = performance.now();
  const result = await runSemanticTransaction({
    roomId: input.roomId, participantId: input.participantId, actorKind: input.actorKind,
    expectedRoomRevision: input.expectedRoomRevision, transaction, metadata: input.metadata,
  });
  const transactionDurationMs = performance.now() - transactionStartedAt;
  let presentation: AgentCanvasDraftSnapshot | null = null;
  if (result.outcome === "applied") {
    const now = Date.now();
    const draft: AgentCanvasDraft = {
      schemaVersion: AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
      id: `draft_svg_reveal_${randomUUID().replaceAll("-", "")}`,
      roomId: input.roomId,
      ownerParticipantId: input.participantId,
      author: actorFor(participant, input.actorKind),
      revision: 1,
      baselineRoomRevision: input.expectedRoomRevision,
      status: "presenting",
      transaction: structuredClone(transaction),
      temporaryReferences: {},
      previewObjects: result.changedObjectIds.flatMap((objectId) => {
        const object = result.room.objects[objectId];
        return object ? [{ ...structuredClone(object), authority: "draft" as const }] : [];
      }),
      previewDiagrams: result.changedDiagramIds.flatMap((diagramId) => {
        const diagram = result.room.diagrams?.[diagramId];
        return diagram ? [{ ...structuredClone(diagram), authority: "draft" as const }] : [];
      }),
      metadata: input.metadata ? structuredClone(input.metadata) : null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + AGENT_COMMITTED_REVEAL_DURATION_MS,
      hardExpiresAt: now + AGENT_COMMITTED_REVEAL_DURATION_MS,
      awaitingReview: null,
      committing: null,
      authoritativeCommit: {
        mutationId: `svg_reveal_${result.room.roomRevision}`,
        roomRevision: result.room.roomRevision,
        committedAt: now,
      },
    };
    try {
      const saved = await getAgentCanvasDraftStore().create(draft);
      const { transaction: hiddenTransaction, committing, authoritativeCommit, ...snapshot } = saved;
      void hiddenTransaction; void committing; void authoritativeCommit;
      presentation = snapshot;
    } catch {
      // Presentation is intentionally best effort. The authoritative SVG
      // import has already committed and must never be rolled back by a
      // transient collaboration-sidecar failure.
    }
  }
  const x = Math.min(...objects.map(object => object.x));
  const y = Math.min(...objects.map(object => object.y));
  return {
    ...result,
    idMap: { parts: objects.map((object, sourceIndex) => ({ sourceIndex, sourceName: object.semanticName ?? `part-${sourceIndex + 1}`, nativeObjectId: object.id })) },
    counts: { parts: objects.length, paths: objects.filter(object => object.kind === "path").length },
    bounds: { x, y, width: Math.max(...objects.map(object => object.x + object.width)) - x, height: Math.max(...objects.map(object => object.y + object.height)) - y },
    warnings: ["Limited SVG subset. Imported bounds describe geometry; inspect rendered strokes and composition."],
    presentation,
    importTiming: { parseDurationMs, transactionDurationMs, totalServerDurationMs: performance.now() - startedAt },
  };
}
