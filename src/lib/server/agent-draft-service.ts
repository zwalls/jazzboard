import { randomUUID } from "node:crypto";

import type {
  AgentCanvasDraft,
  AgentCanvasDraftListResult,
  AgentCanvasDraftSnapshot,
  CommitAgentCanvasDraftRequest,
  DiscardAgentCanvasDraftRequest,
  ReplaceAgentCanvasDraftRequest,
  StageAgentCanvasDraftRequest,
} from "@/lib/agent-drafts/types";
import { AGENT_CANVAS_DRAFT_SCHEMA_VERSION } from "@/lib/agent-drafts/types";
import {
  actorFor,
  applySemanticTransaction,
  requireMutationRole,
  requireParticipant,
} from "@/lib/domain/engine";
import { DomainError } from "@/lib/domain/errors";
import type { AgentEditProposal, RoomState, SemanticTransaction } from "@/lib/domain/types";

import {
  AGENT_DRAFT_HARD_TTL_MS,
  AGENT_DRAFT_SLIDING_TTL_MS,
  getAgentCanvasDraftStore,
} from "./agent-draft-store";
import { currentMutationContext } from "./mutation-context";
import { getRoomStore } from "./room-store";
import { readAuthorizedRoom, runSemanticTransaction } from "./room-service";

const MAX_TEMPORARY_REFERENCE_RESERVATIONS = 256;

function snapshot(draft: AgentCanvasDraft): AgentCanvasDraftSnapshot {
  const { transaction, committing, authoritativeCommit, ...publicDraft } = draft;
  void transaction;
  void committing;
  void authoritativeCommit;
  return publicDraft;
}

function requireAgentParticipant(room: RoomState, participantId: string) {
  const participant = requireParticipant(room, participantId);
  requireMutationRole(participant, "agent");
  return participant;
}

function assertExactBaseline(room: RoomState, baselineRoomRevision: number): void {
  if (room.roomRevision !== baselineRoomRevision) {
    throw new DomainError(
      "REVISION_CONFLICT",
      `Room revision changed from ${baselineRoomRevision} to ${room.roomRevision}.`,
      { expectedRevision: baselineRoomRevision, currentRevision: room.roomRevision },
    );
  }
}

function validateCreateOnlyTransaction(
  transaction: SemanticTransaction,
): { objectIds: string[]; diagramIds: string[] } {
  const objectIds: string[] = [];
  for (const command of transaction.commands) {
    if (command.type !== "create") {
      throw new DomainError(
        "INVALID_OPERATION",
        "Agent canvas drafts currently support only create object/connector operations.",
      );
    }
    objectIds.push(command.object.id);
  }
  const diagramIds: string[] = [];
  for (const command of transaction.diagramCommands) {
    if (command.type !== "diagram.create") {
      throw new DomainError(
        "INVALID_OPERATION",
        "Agent canvas drafts currently support only Diagram creation.",
      );
    }
    diagramIds.push(command.diagram.id);
  }
  const allIds = [...objectIds, ...diagramIds];
  if (new Set(allIds).size !== allIds.length) {
    throw new DomainError("INVALID_OPERATION", "Draft candidate IDs must be unique.");
  }
  if (transaction.autoLayout) {
    const objectIdSet = new Set(objectIds);
    for (const target of transaction.autoLayout.targets) {
      if (!objectIdSet.has(target.objectId) || target.expectedRevision !== 1) {
        throw new DomainError(
          "INVALID_OPERATION",
          "Draft auto-layout may target only objects created in the same draft at candidate revision 1.",
          { objectId: target.objectId },
        );
      }
    }
    if (
      transaction.autoLayout.diagramId &&
      (!diagramIds.includes(transaction.autoLayout.diagramId) ||
        transaction.autoLayout.expectedDiagramRevision !== 1)
    ) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Draft auto-layout may target only a Diagram created in the same draft at candidate revision 1.",
      );
    }
  }
  return { objectIds, diagramIds };
}

function requireCurrentCandidateReferences(
  temporaryReferences: Record<string, string>,
  ids: { objectIds: string[]; diagramIds: string[] },
): void {
  const candidateIds = new Set([...ids.objectIds, ...ids.diagramIds]);
  for (const [temporaryReference, candidateId] of Object.entries(temporaryReferences)) {
    if (!candidateIds.has(candidateId)) {
      throw new DomainError(
        "INVALID_OPERATION",
        `Temporary reference ${temporaryReference} does not resolve to a created object or Diagram candidate ID.`,
        { temporaryReference, candidateId },
      );
    }
  }
}

function mergeTemporaryReferenceReservations(input: {
  current: Record<string, string>;
  requested: Record<string, string>;
  ids: { objectIds: string[]; diagramIds: string[] };
}): Record<string, string> {
  const merged = structuredClone(input.current);
  const candidateIds = new Set([...input.ids.objectIds, ...input.ids.diagramIds]);
  const reservedIds = new Map(Object.entries(merged).map(([reference, id]) => [id, reference]));
  for (const [temporaryReference, candidateId] of Object.entries(input.requested)) {
    const existingId = merged[temporaryReference];
    if (existingId !== undefined && existingId !== candidateId) {
      throw new DomainError(
        "INVALID_OPERATION",
        `Temporary reference ${temporaryReference} cannot be remapped within one draft.`,
        { temporaryReference, candidateId: existingId, attemptedCandidateId: candidateId },
      );
    }
    if (existingId === undefined && !candidateIds.has(candidateId)) {
      throw new DomainError(
        "INVALID_OPERATION",
        `New temporary reference ${temporaryReference} does not resolve to a current candidate ID.`,
        { temporaryReference, candidateId },
      );
    }
    const existingReference = reservedIds.get(candidateId);
    if (existingReference !== undefined && existingReference !== temporaryReference) {
      throw new DomainError(
        "INVALID_OPERATION",
        `Candidate ID ${candidateId} is already reserved by temporary reference ${existingReference}.`,
        { temporaryReference, existingReference, candidateId },
      );
    }
    merged[temporaryReference] = candidateId;
    reservedIds.set(candidateId, temporaryReference);
  }
  if (Object.keys(merged).length > MAX_TEMPORARY_REFERENCE_RESERVATIONS) {
    throw new DomainError(
      "REQUEST_TOO_LARGE",
      `An agent canvas draft may reserve at most ${MAX_TEMPORARY_REFERENCE_RESERVATIONS} temporary references.`,
    );
  }
  return merged;
}

function previewDraft(input: {
  room: RoomState;
  participantId: string;
  transaction: SemanticTransaction;
  ids: { objectIds: string[]; diagramIds: string[] };
  now: number;
}) {
  const result = applySemanticTransaction(
    input.room,
    input.participantId,
    "agent",
    input.transaction,
    input.now,
  );
  return {
    previewObjects: input.ids.objectIds.map((id) => {
      const object = result.room.objects[id];
      if (!object) {
        throw new DomainError("INVALID_OPERATION", `Draft preview did not create candidate object ${id}.`);
      }
      return { ...object, authority: "draft" as const };
    }),
    previewDiagrams: input.ids.diagramIds.map((id) => {
      const diagram = result.room.diagrams?.[id];
      if (!diagram) {
        throw new DomainError("INVALID_OPERATION", `Draft preview did not create candidate Diagram ${id}.`);
      }
      return { ...diagram, authority: "draft" as const };
    }),
  };
}

function sameTransaction(left: SemanticTransaction, right: SemanticTransaction): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchingProposal(room: RoomState, draft: AgentCanvasDraft): AgentEditProposal | null {
  const linkedId = draft.awaitingReview?.proposalId;
  if (linkedId) {
    return room.reviewProposals.find((proposal) => proposal.id === linkedId) ?? null;
  }
  if (draft.status !== "committing") return null;
  return [...room.reviewProposals]
    .reverse()
    .find((proposal) =>
      proposal.author.kind === "agent" &&
      proposal.author.participantId === draft.ownerParticipantId &&
      proposal.baselineRoomRevision === draft.baselineRoomRevision &&
      proposal.createdAt >= (draft.committing?.startedAt ?? draft.updatedAt) &&
      proposal.request.kind === "semantic_transaction" &&
      sameTransaction(proposal.request.transaction, draft.transaction)
    ) ?? null;
}

function awaitingReviewDraft(
  draft: AgentCanvasDraft,
  proposalId: string,
  now: number,
): AgentCanvasDraft {
  return {
    ...structuredClone(draft),
    status: "awaiting_review",
    revision: draft.status === "awaiting_review" ? draft.revision : draft.revision + 1,
    awaitingReview: { proposalId, proposedAt: now },
    committing: null,
    updatedAt: now,
    expiresAt: draft.hardExpiresAt,
  };
}

async function removeCanonicalDraft(input: {
  room: RoomState;
  draft: AgentCanvasDraft;
  reason: "committed" | "discarded";
  authoritativeRoomRevision?: number;
  now: number;
}): Promise<void> {
  try {
    if (input.reason === "committed") {
      await getAgentCanvasDraftStore().remove({
        roomId: input.draft.roomId,
        draftId: input.draft.id,
        ownerParticipantId: input.draft.ownerParticipantId,
        reason: input.reason,
        authoritativeRoomRevision: input.authoritativeRoomRevision ?? input.room.roomRevision,
        now: input.now,
      });
    } else {
      await getAgentCanvasDraftStore().remove({
        roomId: input.draft.roomId,
        draftId: input.draft.id,
        ownerParticipantId: input.draft.ownerParticipantId,
        reason: input.reason,
        now: input.now,
      });
    }
  } catch {
    // The private commit fence or authoritative proposal already proves the
    // outcome. Keep reads truthful and retry cleanup on the next authorized
    // reconciliation.
  }
}

async function reconcileAgentCanvasDrafts(input: {
  room: RoomState;
  drafts: AgentCanvasDraft[];
  now: number;
}): Promise<AgentCanvasDraft[]> {
  const store = getAgentCanvasDraftStore();
  const retained: AgentCanvasDraft[] = [];
  for (const draft of input.drafts) {
    if (draft.status === "active") {
      retained.push(draft);
      continue;
    }

    if (draft.authoritativeCommit) {
      await removeCanonicalDraft({
        room: input.room,
        draft,
        reason: "committed",
        authoritativeRoomRevision: draft.authoritativeCommit.roomRevision,
        now: input.now,
      });
      continue;
    }

    const proposal = matchingProposal(input.room, draft);
    if (proposal?.status === "applied") {
      await removeCanonicalDraft({ room: input.room, draft, reason: "committed", now: input.now });
      continue;
    }
    if (proposal?.status === "rejected") {
      await removeCanonicalDraft({ room: input.room, draft, reason: "discarded", now: input.now });
      continue;
    }
    if (proposal?.status === "pending") {
      if (draft.status === "awaiting_review") {
        retained.push(draft);
        continue;
      }
      const mutationId = draft.committing?.mutationId;
      if (!mutationId) {
        retained.push(awaitingReviewDraft(draft, proposal.id, input.now));
        continue;
      }
      try {
        retained.push(await store.markAwaitingReview({
          roomId: draft.roomId,
          draftId: draft.id,
          ownerParticipantId: draft.ownerParticipantId,
          mutationId,
          proposalId: proposal.id,
          now: input.now,
        }));
      } catch {
        const current = await store.get(draft.roomId, draft.id, input.now).catch(() => null);
        retained.push(
          current?.status === "awaiting_review" && current.awaitingReview?.proposalId === proposal.id
            ? current
            : awaitingReviewDraft(current ?? draft, proposal.id, input.now),
        );
      }
      continue;
    }

    retained.push(draft);
  }
  return retained;
}

export async function listAgentCanvasDrafts(input: {
  roomId: string;
  participantId: string;
  now?: number;
}): Promise<AgentCanvasDraftListResult> {
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  const now = input.now ?? Date.now();
  const drafts = await getAgentCanvasDraftStore().list(input.roomId, now);
  const reconciled = await reconcileAgentCanvasDrafts({ room, drafts, now });
  return { drafts: reconciled.map(snapshot), serverTime: now };
}

export async function readAgentCanvasDraft(input: {
  roomId: string;
  draftId: string;
  participantId: string;
  now?: number;
}): Promise<{ draft: AgentCanvasDraftSnapshot; serverTime: number }> {
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  const now = input.now ?? Date.now();
  const draft = await getAgentCanvasDraftStore().get(input.roomId, input.draftId, now);
  if (!draft) throw new DomainError("INVALID_OPERATION", "That agent canvas draft is unavailable or expired.");
  const [reconciled] = await reconcileAgentCanvasDrafts({ room, drafts: [draft], now });
  if (!reconciled) throw new DomainError("INVALID_OPERATION", "That agent canvas draft is unavailable or expired.");
  return { draft: snapshot(reconciled), serverTime: now };
}

export async function stageAgentCanvasDraft(input: {
  roomId: string;
  participantId: string;
  request: StageAgentCanvasDraftRequest;
  now?: number;
}): Promise<AgentCanvasDraftSnapshot> {
  const now = input.now ?? Date.now();
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  const participant = requireAgentParticipant(room, input.participantId);
  const store = getAgentCanvasDraftStore();
  const existing = await store.list(input.roomId, now);
  await reconcileAgentCanvasDrafts({ room, drafts: existing, now });
  assertExactBaseline(room, input.request.baselineRoomRevision);
  const ids = validateCreateOnlyTransaction(input.request.transaction);
  requireCurrentCandidateReferences(input.request.temporaryReferences, ids);
  const preview = previewDraft({
    room,
    participantId: input.participantId,
    transaction: input.request.transaction,
    ids,
    now,
  });
  const draft: AgentCanvasDraft = {
    schemaVersion: AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
    id: input.request.draftId,
    roomId: input.roomId,
    ownerParticipantId: input.participantId,
    author: actorFor(participant, "agent"),
    revision: 1,
    baselineRoomRevision: input.request.baselineRoomRevision,
    status: "active",
    transaction: structuredClone(input.request.transaction),
    temporaryReferences: structuredClone(input.request.temporaryReferences),
    ...preview,
    metadata: input.request.metadata ? structuredClone(input.request.metadata) : null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + AGENT_DRAFT_SLIDING_TTL_MS,
    hardExpiresAt: now + AGENT_DRAFT_HARD_TTL_MS,
    awaitingReview: null,
    committing: null,
    authoritativeCommit: null,
  };
  return snapshot(await store.create(draft));
}

export async function replaceAgentCanvasDraft(input: {
  roomId: string;
  draftId: string;
  participantId: string;
  request: ReplaceAgentCanvasDraftRequest;
  now?: number;
}): Promise<AgentCanvasDraftSnapshot> {
  const now = input.now ?? Date.now();
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  requireAgentParticipant(room, input.participantId);
  assertExactBaseline(room, input.request.baselineRoomRevision);
  const current = await getAgentCanvasDraftStore().get(input.roomId, input.draftId, now);
  if (!current) throw new DomainError("INVALID_OPERATION", "That agent canvas draft is unavailable or expired.");
  if (current.ownerParticipantId !== input.participantId) {
    throw new DomainError("FORBIDDEN", "Only the participant that owns this draft may change it.");
  }
  const ids = validateCreateOnlyTransaction(input.request.transaction);
  const temporaryReferences = mergeTemporaryReferenceReservations({
    current: current.temporaryReferences,
    requested: input.request.temporaryReferences,
    ids,
  });
  const preview = previewDraft({
    room,
    participantId: input.participantId,
    transaction: input.request.transaction,
    ids,
    now,
  });
  const draft: AgentCanvasDraft = {
    ...current,
    revision: input.request.expectedDraftRevision + 1,
    baselineRoomRevision: input.request.baselineRoomRevision,
    transaction: structuredClone(input.request.transaction),
    temporaryReferences,
    ...preview,
    metadata: input.request.metadata ? structuredClone(input.request.metadata) : null,
    updatedAt: now,
    expiresAt: Math.min(current.hardExpiresAt, now + AGENT_DRAFT_SLIDING_TTL_MS),
    awaitingReview: null,
    committing: null,
    status: "active",
  };
  return snapshot(await getAgentCanvasDraftStore().replace({
    draft,
    expectedRevision: input.request.expectedDraftRevision,
  }));
}

export async function discardAgentCanvasDraft(input: {
  roomId: string;
  draftId: string;
  participantId: string;
  request: DiscardAgentCanvasDraftRequest;
  now?: number;
}): Promise<{ discarded: true; draftId: string }> {
  const now = input.now ?? Date.now();
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  requireAgentParticipant(room, input.participantId);
  await getAgentCanvasDraftStore().remove({
    roomId: input.roomId,
    draftId: input.draftId,
    ownerParticipantId: input.participantId,
    expectedRevision: input.request.expectedDraftRevision,
    requiredStatus: "active",
    reason: "discarded",
    now,
  });
  return { discarded: true, draftId: input.draftId };
}

export type AgentCanvasDraftCommitResult = {
  outcome: "applied" | "proposed";
  draft: AgentCanvasDraftSnapshot | null;
  /** Whether the non-authoritative draft sidecar reached its canonical terminal state. */
  sidecarStatus: "settled" | "cleanup_pending";
  mutation: Awaited<ReturnType<typeof runSemanticTransaction>>;
};

export async function commitAgentCanvasDraft(input: {
  roomId: string;
  draftId: string;
  participantId: string;
  request: CommitAgentCanvasDraftRequest;
  now?: number;
}): Promise<AgentCanvasDraftCommitResult> {
  const now = input.now ?? Date.now();
  const roomStore = getRoomStore();
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  requireAgentParticipant(room, input.participantId);
  await roomStore.assertMutationNotReplayed(input.roomId);
  const context = currentMutationContext();
  const mutationId = context?.idempotency?.scopedKeyHash ?? context?.requestId ?? `draft_commit_${randomUUID()}`;
  const store = getAgentCanvasDraftStore();
  const draft = await store.beginCommit({
    roomId: input.roomId,
    draftId: input.draftId,
    ownerParticipantId: input.participantId,
    expectedRevision: input.request.expectedDraftRevision,
    mutationId,
    now,
  });

  let mutation: Awaited<ReturnType<typeof runSemanticTransaction>>;
  try {
    mutation = await runSemanticTransaction({
      roomId: input.roomId,
      participantId: input.participantId,
      actorKind: "agent",
      transaction: draft.transaction,
      metadata: draft.metadata ?? undefined,
      expectedRoomRevision: draft.baselineRoomRevision,
    });
  } catch (error) {
    if (!(error instanceof DomainError && error.code === "MUTATION_OUTCOME_UNKNOWN")) {
      await store.restoreActive({
        roomId: input.roomId,
        draftId: input.draftId,
        ownerParticipantId: input.participantId,
        mutationId,
        now: Date.now(),
      }).catch(() => undefined);
    }
    throw error;
  }

  if (mutation.outcome === "proposed") {
    const settledAt = Date.now();
    try {
      const awaiting = await store.markAwaitingReview({
        roomId: input.roomId,
        draftId: input.draftId,
        ownerParticipantId: input.participantId,
        mutationId,
        proposalId: mutation.proposal.id,
        now: settledAt,
      });
      return { outcome: "proposed", draft: snapshot(awaiting), sidecarStatus: "settled", mutation };
    } catch {
      const current = await store.get(input.roomId, input.draftId, settledAt).catch(() => null);
      if (current?.status === "awaiting_review" && current.awaitingReview?.proposalId === mutation.proposal.id) {
        return { outcome: "proposed", draft: snapshot(current), sidecarStatus: "settled", mutation };
      }
      return {
        outcome: "proposed",
        draft: snapshot(awaitingReviewDraft(current ?? draft, mutation.proposal.id, settledAt)),
        sidecarStatus: "cleanup_pending",
        mutation,
      };
    }
  }

  const settledAt = Date.now();
  let committedDraft: AgentCanvasDraft;
  try {
    committedDraft = await store.markAuthoritativelyCommitted({
      roomId: input.roomId,
      draftId: input.draftId,
      ownerParticipantId: input.participantId,
      mutationId,
      authoritativeRoomRevision: mutation.room.roomRevision,
      now: settledAt,
    });
  } catch {
    const current = await store.get(input.roomId, input.draftId, settledAt).catch(() => null);
    if (
      !current?.authoritativeCommit ||
      current.authoritativeCommit.mutationId !== mutationId ||
      current.authoritativeCommit.roomRevision !== mutation.room.roomRevision
    ) {
      return {
        outcome: "applied",
        draft: null,
        sidecarStatus: "cleanup_pending",
        mutation,
      };
    }
    committedDraft = current;
  }
  try {
    await store.remove({
      roomId: input.roomId,
      draftId: input.draftId,
      ownerParticipantId: input.participantId,
      committingMutationId: committedDraft.authoritativeCommit?.mutationId ?? mutationId,
      reason: "committed",
      authoritativeRoomRevision: mutation.room.roomRevision,
      now: settledAt,
    });
    return { outcome: "applied", draft: null, sidecarStatus: "settled", mutation };
  } catch {
    const current = await store.get(input.roomId, input.draftId, settledAt).catch(() => null);
    return {
      outcome: "applied",
      draft: null,
      sidecarStatus: current ? "cleanup_pending" : "settled",
      mutation,
    };
  }
}
