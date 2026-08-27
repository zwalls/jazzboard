import { randomUUID } from "node:crypto";

import {
  acquireObjectLease,
  applyActivityRevert,
  applyLayoutCommand,
  applySemanticTransaction,
  actorFor,
  releaseObjectLease,
  renewObjectLease,
  requireMutationRole,
  requireParticipant,
} from "@/lib/domain/engine";
import { DomainError } from "@/lib/domain/errors";
import {
  agentEditProposalSummary,
  buildAgentEditProposal,
  buildRoomActivity,
  canvasCommandActivityDescriptor,
  MAX_ROOM_REVIEW_PROPOSALS,
  roomActivitySummary,
} from "@/lib/domain/review";
import type {
  ActivityMutationMetadata,
  ActorKind,
  AgentEditPolicy,
  AgentEditProposal,
  AgentEditProposalRequest,
  AgentEditProposalStatus,
  AgentEditProposalSummary,
  AgentActivity,
  CanvasCommand,
  LayoutCommand,
  LeaseOperation,
  RoomState,
  Spotlight,
  Viewport,
  Point,
  RevertActivityRequest,
  RoomActivity,
  RoomActivityAction,
  RoomActivitySummary,
  RoomPresenceDelta,
  SemanticTransaction,
} from "@/lib/domain/types";

import { getRoomStore } from "./room-store";

type MutationResultFields = {
  room: RoomState;
  changedObjectIds: string[];
  changedDiagramIds: string[];
  membershipObjectIds: string[];
  positions?: Array<{ objectId: string; x: number; y: number }>;
};

export type CanvasMutationOutcome =
  | (MutationResultFields & {
      outcome: "applied";
      activity: RoomActivitySummary;
      proposal: null;
    })
  | (MutationResultFields & {
      outcome: "proposed";
      activity: null;
      proposal: AgentEditProposalSummary;
    });

export type ReviewDecisionOutcome =
  | {
      outcome: "rejected";
      room: RoomState;
      proposal: AgentEditProposalSummary;
    }
  | (MutationResultFields & {
      outcome: "applied";
      activity: RoomActivitySummary;
      proposal: AgentEditProposalSummary;
    });

export async function readAuthorizedRoom(roomId: string, participantId: string): Promise<RoomState> {
  const room = await getRoomStore().getRoom(roomId);
  if (!room) throw new DomainError("ROOM_NOT_FOUND", "This Jazzboard no longer exists.");
  requireParticipant(room, participantId);
  return room;
}

function queueAgentEdit(
  room: RoomState,
  participantId: string,
  request: AgentEditProposalRequest,
  metadata?: ActivityMutationMetadata,
) {
  const participant = requireParticipant(room, participantId);
  requireMutationRole(participant, "agent");
  if (room.agentEditPolicy !== "review") {
    throw new DomainError("INVALID_OPERATION", "Agent edit proposals require review mode.");
  }
  const now = Date.now();
  const proposal = buildAgentEditProposal({
    room,
    actor: actorFor(participant, "agent"),
    request,
    metadata,
    now,
  });
  const proposals = room.reviewProposals ?? [];
  if (proposals.length >= MAX_ROOM_REVIEW_PROPOSALS) {
    let removableIndex = -1;
    for (let index = proposals.length - 1; index >= 0; index -= 1) {
      if (proposals[index].status !== "pending") {
        removableIndex = index;
        break;
      }
    }
    if (removableIndex < 0) {
      throw new DomainError(
        "INVALID_OPERATION",
        `The agent review queue already contains ${MAX_ROOM_REVIEW_PROPOSALS} pending proposals. Review one before adding another.`,
      );
    }
    proposals.splice(removableIndex, 1);
  }
  room.reviewProposals = [proposal, ...proposals];
  room.roomRevision += 1;
  room.updatedAt = now;
  markSemanticAgentActivity(
    room,
    participantId,
    proposal.purpose.objectIds,
    `${proposal.purpose.label} — awaiting human review`,
    request.kind === "layout" ? "moving" : "creating",
  );
  return {
    room,
    result: {
      outcome: "proposed" as const,
      room,
      changedObjectIds: [] as string[],
      changedDiagramIds: [] as string[],
      membershipObjectIds: [] as string[],
      activity: null,
      proposal: agentEditProposalSummary(proposal),
      ...(request.kind === "layout" ? { positions: [] as Array<{ objectId: string; x: number; y: number }> } : {}),
    },
    eventActor: proposal.author,
  };
}

export async function runCanvasCommand(input: {
  roomId: string;
  participantId: string;
  actorKind: ActorKind;
  command: CanvasCommand;
  metadata?: ActivityMutationMetadata;
}): Promise<CanvasMutationOutcome> {
  return getRoomStore().transact<CanvasMutationOutcome>(
    input.roomId,
    (room) => {
      if (input.actorKind === "agent" && room.agentEditPolicy === "review") {
        return queueAgentEdit(
          room,
          input.participantId,
          { kind: "canvas_command", command: input.command },
          input.metadata,
        );
      }
      const baseline = structuredClone(room);
      const result = applySemanticTransaction(
        room,
        input.participantId,
        input.actorKind,
        { commands: [input.command], diagramCommands: [] },
      );
      if (input.actorKind === "agent") {
        const participant = requireParticipant(result.room, input.participantId);
        const changedObjects = result.changedObjectIds
          .map((objectId) => result.room.objects[objectId])
          .filter((object) => object !== undefined);
        const focusedObject = changedObjects[0];
        const previousCursor = participant.agent.cursor;
        const previousViewport = participant.agent.viewport;
        const nextCursor = focusedObject
          ? { x: focusedObject.x + focusedObject.width / 2, y: focusedObject.y + focusedObject.height / 2 }
          : participant.agent.cursor;
        const activityFromCursor = previousCursor ?? (previousViewport
          ? {
              x: previousViewport.x + previousViewport.width / 2,
              y: previousViewport.y + previousViewport.height / 2,
            }
          : nextCursor);
        const agentViewport = changedObjects.length
          ? (() => {
              const padding = 120;
              const minX = Math.min(...changedObjects.map((object) => object.x));
              const minY = Math.min(...changedObjects.map((object) => object.y));
              const maxX = Math.max(...changedObjects.map((object) => object.x + object.width));
              const maxY = Math.max(...changedObjects.map((object) => object.y + object.height));
              return {
                x: minX - padding,
                y: minY - padding,
                width: maxX - minX + padding * 2,
                height: maxY - minY + padding * 2,
                zoom: participant.agent.viewport?.zoom ?? 1,
              };
            })()
          : participant.agent.viewport;
        const activityType = {
          create:
            input.command.type === "create" && input.command.object.kind === "text"
              ? "typing"
              : input.command.type === "create" && input.command.object.kind === "draw"
                ? "drawing"
                : input.command.type === "create" && input.command.object.kind === "connector"
                  ? "connecting"
                  : input.command.type === "create" && input.command.object.kind === "image"
                    ? "annotating"
                    : "creating",
          update:
            input.command.type === "update" && input.command.operation === "connect"
              ? "connecting"
              : input.command.type === "update" && input.command.operation === "annotate"
                ? "annotating"
                : "typing",
          move: "moving",
          group: "moving",
          delete: "annotating",
        }[input.command.type] as AgentActivity["type"];
        const activityLabel = {
          create:
            input.command.type === "create" && input.command.object.kind === "text"
              ? "Typing canvas text"
              : input.command.type === "create" && input.command.object.kind === "connector"
                ? "Drawing a connection"
                : input.command.type === "create" && input.command.object.kind === "draw"
                  ? "Drawing an annotation"
                  : input.command.type === "create" && input.command.object.kind === "image"
                    ? "Placing an image"
                    : "Building a canvas object",
          update: "Editing a canvas object",
          move: `Moving ${result.changedObjectIds.length} object${result.changedObjectIds.length === 1 ? "" : "s"}`,
          group: `Grouping ${result.changedObjectIds.length} object${result.changedObjectIds.length === 1 ? "" : "s"}`,
          delete: `Removing ${result.changedObjectIds.length} object${result.changedObjectIds.length === 1 ? "" : "s"}`,
        }[input.command.type];
        const now = Date.now();
        participant.agentActive = true;
        participant.agent = {
          ...participant.agent,
          cursor: nextCursor,
          viewport: agentViewport,
          lastSeenAt: now,
          activity: activity({
            type: activityType,
            label: activityLabel,
            objectIds: result.changedObjectIds,
            progress: 0,
            durationMs: Math.min(1_900, 850 + result.changedObjectIds.length * 180),
            fromCursor: activityFromCursor,
            toCursor: nextCursor,
          }),
        };
        participant.lastSeenAt = now;
        participant.connected = true;
      }
      const activityActor = actorFor(requireParticipant(result.room, input.participantId), input.actorKind);
      const descriptor = canvasCommandActivityDescriptor(input.command, result.changedObjectIds.length);
      const activityRecord = buildRoomActivity({
        before: baseline,
        after: result.room,
        actor: activityActor,
        ...descriptor,
        changedObjectIds: result.changedObjectIds,
        changedDiagramIds: result.changedDiagramIds,
        membershipObjectIds: result.membershipObjectIds,
        metadata: input.metadata,
      });
      return {
        room: result.room,
        result: {
          ...result,
          outcome: "applied" as const,
          activity: roomActivitySummary(activityRecord),
          proposal: null,
        },
        eventActor: activityActor,
        activity: activityRecord,
      };
    },
    input.actorKind === "agent" ? "agent.activity" : "room.updated",
  );
}

function markSemanticAgentActivity(
  room: RoomState,
  participantId: string,
  changedObjectIds: readonly string[],
  label: string,
  type: AgentActivity["type"],
): void {
  const participant = requireParticipant(room, participantId);
  const changedObjects = changedObjectIds.flatMap((objectId) => room.objects[objectId] ?? []);
  const previousCursor = participant.agent.cursor;
  const previousViewport = participant.agent.viewport;
  const focused = changedObjects[0];
  const nextCursor = focused
    ? { x: focused.x + focused.width / 2, y: focused.y + focused.height / 2 }
    : previousCursor;
  const fromCursor = previousCursor ?? (previousViewport
    ? {
        x: previousViewport.x + previousViewport.width / 2,
        y: previousViewport.y + previousViewport.height / 2,
      }
    : nextCursor);
  const viewport = changedObjects.length
    ? (() => {
        const padding = 120;
        const minX = Math.min(...changedObjects.map((object) => object.x));
        const minY = Math.min(...changedObjects.map((object) => object.y));
        const maxX = Math.max(...changedObjects.map((object) => object.x + object.width));
        const maxY = Math.max(...changedObjects.map((object) => object.y + object.height));
        return {
          x: minX - padding,
          y: minY - padding,
          width: maxX - minX + padding * 2,
          height: maxY - minY + padding * 2,
          zoom: previousViewport?.zoom ?? 1,
        };
      })()
    : previousViewport;
  const now = Date.now();
  participant.agentActive = true;
  participant.agent = {
    ...participant.agent,
    cursor: nextCursor,
    viewport,
    lastSeenAt: now,
    activity: activity({
      type,
      label,
      objectIds: [...changedObjectIds],
      progress: 0,
      durationMs: Math.min(3_000, 1_000 + changedObjectIds.length * 120),
      fromCursor,
      toCursor: nextCursor,
    }),
  };
  participant.connected = true;
  participant.lastSeenAt = now;
}

export async function runSemanticTransaction(input: {
  roomId: string;
  participantId: string;
  actorKind: ActorKind;
  transaction: SemanticTransaction;
  metadata?: ActivityMutationMetadata;
  expectedRoomRevision?: number;
}): Promise<CanvasMutationOutcome> {
  return getRoomStore().transact<CanvasMutationOutcome>(
    input.roomId,
    (room) => {
      const participant = requireParticipant(room, input.participantId);
      requireMutationRole(participant, input.actorKind);
      if (
        input.expectedRoomRevision !== undefined &&
        room.roomRevision !== input.expectedRoomRevision
      ) {
        throw new DomainError(
          "REVISION_CONFLICT",
          `Room revision changed from ${input.expectedRoomRevision} to ${room.roomRevision}.`,
          {
            expectedRevision: input.expectedRoomRevision,
            currentRevision: room.roomRevision,
          },
        );
      }
      if (input.actorKind === "agent" && room.agentEditPolicy === "review") {
        return queueAgentEdit(
          room,
          input.participantId,
          { kind: "semantic_transaction", transaction: input.transaction },
          input.metadata,
        );
      }
      const baseline = structuredClone(room);
      const result = applySemanticTransaction(
        room,
        input.participantId,
        input.actorKind,
        input.transaction,
      );
      if (input.actorKind === "agent") {
        markSemanticAgentActivity(
          result.room,
          input.participantId,
          result.changedObjectIds,
          `Applying ${input.transaction.commands.length + input.transaction.diagramCommands.length} semantic operation${input.transaction.commands.length + input.transaction.diagramCommands.length === 1 ? "" : "s"}`,
          input.transaction.commands.some((command) => command.type === "move") ? "moving" : "creating",
        );
      }
      const activityActor = actorFor(requireParticipant(result.room, input.participantId), input.actorKind);
      const operationCount = input.transaction.commands.length + input.transaction.diagramCommands.length;
      const activityRecord = buildRoomActivity({
        before: baseline,
        after: result.room,
        actor: activityActor,
        action: "canvas.transaction",
        label: `Applied ${operationCount} semantic operation${operationCount === 1 ? "" : "s"}`,
        changedObjectIds: result.changedObjectIds,
        changedDiagramIds: result.changedDiagramIds,
        membershipObjectIds: result.membershipObjectIds,
        metadata: input.metadata,
      });
      return {
        room: result.room,
        result: {
          ...result,
          outcome: "applied" as const,
          activity: roomActivitySummary(activityRecord),
          proposal: null,
        },
        eventActor: activityActor,
        activity: activityRecord,
      };
    },
    input.actorKind === "agent" ? "agent.activity" : "room.updated",
  );
}

export async function runLayoutCommand(input: {
  roomId: string;
  participantId: string;
  actorKind: ActorKind;
  layout: LayoutCommand;
  metadata?: ActivityMutationMetadata;
}): Promise<CanvasMutationOutcome> {
  return getRoomStore().transact<CanvasMutationOutcome>(
    input.roomId,
    (room) => {
      if (input.actorKind === "agent" && room.agentEditPolicy === "review") {
        return queueAgentEdit(
          room,
          input.participantId,
          { kind: "layout", layout: input.layout },
          input.metadata,
        );
      }
      const baseline = structuredClone(room);
      const result = applyLayoutCommand(
        room,
        input.participantId,
        input.actorKind,
        input.layout,
      );
      if (input.actorKind === "agent") {
        markSemanticAgentActivity(
          result.room,
          input.participantId,
          result.changedObjectIds,
          `Arranging ${input.layout.targets.length} objects as a ${input.layout.layout}`,
          "moving",
        );
      }
      const activityActor = actorFor(requireParticipant(result.room, input.participantId), input.actorKind);
      const activityRecord = buildRoomActivity({
        before: baseline,
        after: result.room,
        actor: activityActor,
        action: "canvas.layout",
        label: `Arranged ${input.layout.targets.length} object${input.layout.targets.length === 1 ? "" : "s"} as a ${input.layout.layout}`,
        changedObjectIds: result.changedObjectIds,
        changedDiagramIds: result.changedDiagramIds,
        membershipObjectIds: result.membershipObjectIds,
        metadata: input.metadata,
      });
      return {
        room: result.room,
        result: {
          ...result,
          outcome: "applied" as const,
          activity: roomActivitySummary(activityRecord),
          proposal: null,
        },
        eventActor: activityActor,
        activity: activityRecord,
      };
    },
    input.actorKind === "agent" ? "agent.activity" : "room.updated",
  );
}

export async function setAgentEditPolicy(input: {
  roomId: string;
  participantId: string;
  actorKind: ActorKind;
  policy: AgentEditPolicy;
}) {
  return getRoomStore().transact(
    input.roomId,
    (room) => {
      const participant = requireParticipant(room, input.participantId);
      requireMutationRole(participant, input.actorKind);
      if (input.actorKind === "agent" && input.policy !== "review") {
        throw new DomainError("FORBIDDEN", "An agent may enable review mode but cannot disable it.");
      }
      const changed = room.agentEditPolicy !== input.policy;
      const now = Date.now();
      if (changed) {
        room.agentEditPolicy = input.policy;
        room.roomRevision += 1;
        room.updatedAt = now;
      }
      if (input.actorKind === "agent") {
        participant.agentActive = true;
        participant.agent.lastSeenAt = now;
        participant.lastSeenAt = now;
        participant.connected = true;
        if (!changed) {
          room.roomRevision += 1;
          room.updatedAt = now;
        }
      }
      return {
        room,
        result: { room, policy: room.agentEditPolicy, changed },
        eventActor: actorFor(participant, input.actorKind),
      };
    },
    "room.updated",
  );
}

export async function listAgentEditProposals(input: {
  roomId: string;
  participantId: string;
  limit?: number;
  status?: AgentEditProposalStatus;
  authorParticipantId?: string;
}): Promise<{
  policy: AgentEditPolicy;
  proposals: AgentEditProposalSummary[];
  totalMatched: number;
  truncated: boolean;
}> {
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const matching = room.reviewProposals
    .filter((proposal) => input.status === undefined || proposal.status === input.status)
    .filter((proposal) => input.authorParticipantId === undefined || proposal.author.participantId === input.authorParticipantId);
  return {
    policy: room.agentEditPolicy,
    proposals: matching.slice(0, limit).map(agentEditProposalSummary),
    totalMatched: matching.length,
    truncated: matching.length > limit,
  };
}

export async function readAgentEditProposal(input: {
  roomId: string;
  participantId: string;
  proposalId: string;
}): Promise<AgentEditProposal> {
  const room = await readAuthorizedRoom(input.roomId, input.participantId);
  const proposal = room.reviewProposals.find((item) => item.id === input.proposalId);
  if (!proposal) {
    throw new DomainError("INVALID_OPERATION", "That agent edit proposal is not available in this room.", {
      proposalId: input.proposalId,
    });
  }
  return structuredClone(proposal);
}

function requirePendingProposal(
  room: RoomState,
  proposalId: string,
  expectedProposalRevision: number,
): AgentEditProposal {
  const proposal = room.reviewProposals.find((item) => item.id === proposalId);
  if (!proposal) {
    throw new DomainError("INVALID_OPERATION", "That agent edit proposal is not available in this room.", {
      proposalId,
    });
  }
  if (proposal.revision !== expectedProposalRevision || proposal.status !== "pending") {
    throw new DomainError("REVISION_CONFLICT", "The proposal changed after it was read.", {
      proposalId,
      expectedRevision: expectedProposalRevision,
      currentRevision: proposal.revision,
      status: proposal.status,
    });
  }
  return proposal;
}

function proposalActivityDescriptor(
  proposal: AgentEditProposal,
  changedObjectCount: number,
): { action: RoomActivityAction; label: string } {
  if (proposal.request.kind === "canvas_command") {
    return canvasCommandActivityDescriptor(proposal.request.command, changedObjectCount);
  }
  if (proposal.request.kind === "layout") {
    return {
      action: "canvas.layout",
      label: `Arranged ${proposal.request.layout.targets.length} object${proposal.request.layout.targets.length === 1 ? "" : "s"} as a ${proposal.request.layout.layout}`,
    };
  }
  if (proposal.request.kind === "activity_revert") {
    return {
      action: "canvas.revert",
      label: `Reverted activity ${proposal.request.revert.activityId}`,
    };
  }
  const count = proposal.request.transaction.commands.length + proposal.request.transaction.diagramCommands.length;
  return {
    action: "canvas.transaction",
    label: `Applied ${count} semantic operation${count === 1 ? "" : "s"}`,
  };
}

export async function reviewAgentEditProposal(input: {
  roomId: string;
  participantId: string;
  actorKind: ActorKind;
  proposalId: string;
  expectedProposalRevision: number;
  action: "approve" | "reject";
  note?: string;
}): Promise<ReviewDecisionOutcome> {
  if (input.actorKind !== "human") {
    throw new DomainError("FORBIDDEN", "Agents cannot approve or reject agent edit proposals.");
  }
  const authorizedRoom = await readAuthorizedRoom(input.roomId, input.participantId);
  requireMutationRole(requireParticipant(authorizedRoom, input.participantId), "human");
  const store = getRoomStore();
  await store.assertMutationNotReplayed(input.roomId);
  const anticipatedProposal = authorizedRoom.reviewProposals.find((item) => item.id === input.proposalId);
  let revertTarget: RoomActivity | null = null;
  if (anticipatedProposal?.request.kind === "activity_revert") {
    revertTarget = await store.getActivity(
      input.roomId,
      anticipatedProposal.request.revert.activityId,
    );
    if (!revertTarget) {
      throw new DomainError("INVALID_OPERATION", "The activity targeted by this proposal is no longer available.", {
        proposalId: input.proposalId,
        activityId: anticipatedProposal.request.revert.activityId,
      });
    }
  }
  return store.transact<ReviewDecisionOutcome>(
    input.roomId,
    (room) => {
      const reviewerParticipant = requireParticipant(room, input.participantId);
      requireMutationRole(reviewerParticipant, "human");
      const reviewer = actorFor(reviewerParticipant, "human");
      const proposal = requirePendingProposal(room, input.proposalId, input.expectedProposalRevision);
      const now = Date.now();

      if (input.action === "reject") {
        proposal.status = "rejected";
        proposal.revision += 1;
        proposal.updatedAt = now;
        proposal.review = {
          decision: "rejected",
          reviewer,
          reviewedAt: now,
          note: input.note ?? null,
          appliedRoomRevision: null,
          activityId: null,
        };
        room.roomRevision += 1;
        room.updatedAt = now;
        return {
          room,
          result: { outcome: "rejected" as const, room, proposal: agentEditProposalSummary(proposal) },
          eventActor: reviewer,
        };
      }

      const baseline = structuredClone(room);
      const semanticResult = proposal.request.kind === "canvas_command"
        ? applySemanticTransaction(
            room,
            proposal.author.participantId,
            "agent",
            { commands: [proposal.request.command], diagramCommands: [] },
            now,
            proposal.author,
          )
        : proposal.request.kind === "semantic_transaction"
          ? applySemanticTransaction(
              room,
              proposal.author.participantId,
              "agent",
              proposal.request.transaction,
              now,
              proposal.author,
            )
          : proposal.request.kind === "layout"
            ? applyLayoutCommand(
                room,
                proposal.author.participantId,
                "agent",
                proposal.request.layout,
                now,
                proposal.author,
              )
            : applyActivityRevert(
                room,
                proposal.author.participantId,
                "agent",
                revertTarget!,
                proposal.request.revert,
                now,
                proposal.author,
              );
      markSemanticAgentActivity(
        semanticResult.room,
        proposal.author.participantId,
        semanticResult.changedObjectIds,
        `Applying approved proposal: ${proposal.purpose.label}`,
        proposal.request.kind === "layout" ? "moving" : "creating",
      );
      const descriptor = proposalActivityDescriptor(proposal, semanticResult.changedObjectIds.length);
      const activityRecord = buildRoomActivity({
        before: baseline,
        after: semanticResult.room,
        actor: proposal.author,
        ...descriptor,
        changedObjectIds: semanticResult.changedObjectIds,
        changedDiagramIds: semanticResult.changedDiagramIds,
        membershipObjectIds: semanticResult.membershipObjectIds,
        metadata: {
          ...(proposal.intent ? { intent: proposal.intent } : {}),
          ...(proposal.summary ? { summary: proposal.summary } : {}),
        },
        revertsActivityId: proposal.request.kind === "activity_revert"
          ? proposal.request.revert.activityId
          : null,
      });
      const appliedProposal = semanticResult.room.reviewProposals.find((item) => item.id === proposal.id)!;
      appliedProposal.status = "applied";
      appliedProposal.revision += 1;
      appliedProposal.updatedAt = now;
      appliedProposal.review = {
        decision: "approved",
        reviewer,
        reviewedAt: now,
        note: input.note ?? null,
        appliedRoomRevision: semanticResult.room.roomRevision,
        activityId: activityRecord.id,
      };
      return {
        room: semanticResult.room,
        result: {
          ...semanticResult,
          outcome: "applied" as const,
          activity: roomActivitySummary(activityRecord),
          proposal: agentEditProposalSummary(appliedProposal),
        },
        eventActor: reviewer,
        activity: activityRecord,
      };
    },
    "room.updated",
  );
}

export type RoomActivityListInput = {
  roomId: string;
  participantId: string;
  limit?: number;
  beforeRoomRevision?: number;
  actorKind?: ActorKind;
  objectId?: string;
  diagramId?: string;
};

export async function listRoomActivities(input: RoomActivityListInput): Promise<{
  activities: RoomActivitySummary[];
  hasMore: boolean;
  nextBeforeRoomRevision: number | null;
}> {
  await readAuthorizedRoom(input.roomId, input.participantId);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const matching = (await getRoomStore().listActivities(input.roomId))
    .filter((item) => input.beforeRoomRevision === undefined || item.roomRevision < input.beforeRoomRevision)
    .filter((item) => input.actorKind === undefined || item.actor.kind === input.actorKind)
    .filter((item) => input.objectId === undefined || item.affectedObjectIds.includes(input.objectId))
    .filter((item) => input.diagramId === undefined || item.affectedDiagramIds.includes(input.diagramId));
  const page = matching.slice(0, limit);
  return {
    activities: page,
    hasMore: matching.length > limit,
    nextBeforeRoomRevision: matching.length > limit ? page.at(-1)?.roomRevision ?? null : null,
  };
}

export async function readRoomActivity(input: {
  roomId: string;
  participantId: string;
  activityId: string;
}): Promise<RoomActivitySummary> {
  await readAuthorizedRoom(input.roomId, input.participantId);
  const activityRecord = await getRoomStore().getActivity(input.roomId, input.activityId);
  if (!activityRecord) {
    throw new DomainError("INVALID_OPERATION", "That activity is no longer available in this room's review history.", {
      activityId: input.activityId,
    });
  }
  return roomActivitySummary(activityRecord);
}

export async function runActivityRevert(input: {
  roomId: string;
  participantId: string;
  actorKind: ActorKind;
  revert: RevertActivityRequest;
}): Promise<CanvasMutationOutcome> {
  const authorizedRoom = await readAuthorizedRoom(input.roomId, input.participantId);
  requireMutationRole(requireParticipant(authorizedRoom, input.participantId), input.actorKind);
  const store = getRoomStore();
  await store.assertMutationNotReplayed(input.roomId);
  const targetActivity = await store.getActivity(input.roomId, input.revert.activityId);
  if (!targetActivity) {
    throw new DomainError("INVALID_OPERATION", "That activity is no longer available to revert.", {
      activityId: input.revert.activityId,
    });
  }

  return store.transact<CanvasMutationOutcome>(
    input.roomId,
    (room) => {
      if (input.actorKind === "agent" && room.agentEditPolicy === "review") {
        return queueAgentEdit(
          room,
          input.participantId,
          { kind: "activity_revert", revert: input.revert },
          input.revert.metadata,
        );
      }
      const baseline = structuredClone(room);
      const result = applyActivityRevert(
        room,
        input.participantId,
        input.actorKind,
        targetActivity,
        input.revert,
      );
      if (input.actorKind === "agent") {
        markSemanticAgentActivity(
          result.room,
          input.participantId,
          result.changedObjectIds,
          `Reverting: ${targetActivity.label}`,
          "annotating",
        );
      }
      const activityActor = actorFor(requireParticipant(result.room, input.participantId), input.actorKind);
      const activityRecord = buildRoomActivity({
        before: baseline,
        after: result.room,
        actor: activityActor,
        action: "canvas.revert",
        label: `Reverted: ${targetActivity.label}`,
        changedObjectIds: result.changedObjectIds,
        changedDiagramIds: result.changedDiagramIds,
        membershipObjectIds: result.membershipObjectIds,
        metadata: input.revert.metadata,
        revertsActivityId: targetActivity.id,
      });
      return {
        room: result.room,
        result: {
          ...result,
          outcome: "applied" as const,
          activity: roomActivitySummary(activityRecord),
          proposal: null,
        },
        eventActor: activityActor,
        activity: activityRecord,
      };
    },
    input.actorKind === "agent" ? "agent.activity" : "room.updated",
  );
}

export async function runLeaseAction(input:
  | {
      action: "acquire";
      roomId: string;
      participantId: string;
      actorKind: ActorKind;
      objectId: string;
      expectedRevision: number;
      operation: LeaseOperation;
    }
  | {
      action: "renew" | "release";
      roomId: string;
      participantId: string;
      actorKind: ActorKind;
      objectId: string;
      leaseId: string;
    },
): Promise<{ room: RoomState; lease: RoomState["leases"][string] | null }> {
  return getRoomStore().transact<{ room: RoomState; lease: RoomState["leases"][string] | null }>(
    input.roomId,
    (room) => {
      const now = Date.now();
      let result: { room: RoomState; lease: RoomState["leases"][string] | null };
      if (input.action === "acquire") {
        const acquired = acquireObjectLease(
          room,
          input.participantId,
          input.actorKind,
          input.objectId,
          input.expectedRevision,
          input.operation,
          now,
        );
        result = { room: acquired.room, lease: acquired.lease };
      } else if (input.action === "renew") {
        const renewed = renewObjectLease(
          room,
          input.participantId,
          input.actorKind,
          input.objectId,
          input.leaseId,
          now,
        );
        result = { room: renewed.room, lease: renewed.lease };
      } else {
        const released = releaseObjectLease(
          room,
          input.participantId,
          input.actorKind,
          input.objectId,
          input.leaseId,
          now,
        );
        result = { room: released, lease: null };
      }

      const participant = requireParticipant(result.room, input.participantId);
      if (input.actorKind === "agent") {
        participant.agentActive = true;
        participant.agent.lastSeenAt = now;
        participant.lastSeenAt = now;
        participant.connected = true;
      }
      return {
        room: result.room,
        result,
        eventActor: actorFor(participant, input.actorKind),
      };
    },
    "lease.updated",
  );
}

export async function updatePresence(input: {
  roomId: string;
  participantId: string;
  actorKind: ActorKind;
  cursor: Point | null;
  viewport: Viewport | null;
  activity: AgentActivity | null;
}): Promise<RoomPresenceDelta> {
  return getRoomStore().updatePresence(input);
}

export async function updateSpotlight(input: {
  roomId: string;
  participantId: string;
  actorKind?: ActorKind;
  action: "start" | "request" | "stop" | "handoff" | "dismiss_request" | "join" | "leave";
  target?: ActorKind;
}): Promise<RoomState> {
  return getRoomStore().transact(
    input.roomId,
    (room) => {
      const participant = requireParticipant(room, input.participantId);
      const actorKind = input.actorKind ?? "human";
      const now = Date.now();
      if (actorKind === "agent") {
        requireMutationRole(participant, "agent");
        participant.agentActive = true;
        participant.agent.lastSeenAt = now;
        participant.lastSeenAt = now;
        participant.connected = true;
      }
      if (input.action === "start") {
        requireMutationRole(participant, "human");
        if (room.spotlight && room.spotlight.presenterId !== input.participantId) {
          throw new DomainError("INVALID_OPERATION", "Another participant currently has the Spotlight.");
        }
        if (input.target === "agent" && !participant.agentActive) {
          throw new DomainError("INVALID_OPERATION", "Your agent becomes spotlightable after its first successful tool call.");
        }
        room.spotlight = {
          presenterId: input.participantId,
          target: input.target ?? "human",
          startedAt: now,
          autoFollowAt: now + 5_000,
          followingParticipantIds: [input.participantId],
          handoffRequest: null,
        } satisfies Spotlight;
      } else if (input.action === "request") {
        requireMutationRole(participant, "human");
        if (!room.spotlight || room.spotlight.presenterId === input.participantId) {
          throw new DomainError("INVALID_OPERATION", "Spotlight can only be requested from another presenter.");
        }
        if (input.target === "agent" && !participant.agentActive) {
          throw new DomainError("INVALID_OPERATION", "Your agent becomes spotlightable after its first successful tool call.");
        }
        if (
          room.spotlight.handoffRequest &&
          room.spotlight.handoffRequest.requesterId !== input.participantId
        ) {
          throw new DomainError("INVALID_OPERATION", "Another Spotlight handoff request is already waiting.");
        }
        room.spotlight.handoffRequest = {
          requesterId: input.participantId,
          target: input.target ?? "human",
          requestedAt: now,
        };
      } else if (input.action === "stop") {
        if (room.spotlight?.presenterId !== input.participantId) {
          throw new DomainError("FORBIDDEN", "Only the current presenter can stop Spotlight.");
        }
        room.spotlight = null;
      } else if (input.action === "handoff") {
        if (room.spotlight?.presenterId !== input.participantId) {
          throw new DomainError("FORBIDDEN", "Only the current presenter can approve a Spotlight handoff.");
        }
        const request = room.spotlight.handoffRequest;
        if (!request) throw new DomainError("INVALID_OPERATION", "There is no Spotlight handoff request to approve.");
        const nextPresenter = requireParticipant(room, request.requesterId);
        requireMutationRole(nextPresenter, "human");
        if (request.target === "agent" && !nextPresenter.agentActive) {
          throw new DomainError("INVALID_OPERATION", "The requested agent is no longer active.");
        }
        room.spotlight = {
          presenterId: request.requesterId,
          target: request.target,
          startedAt: now,
          autoFollowAt: now + 5_000,
          followingParticipantIds: [request.requesterId],
          handoffRequest: null,
        };
      } else if (input.action === "dismiss_request") {
        if (room.spotlight?.presenterId !== input.participantId) {
          throw new DomainError("FORBIDDEN", "Only the current presenter can dismiss a Spotlight handoff request.");
        }
        room.spotlight.handoffRequest = null;
      } else {
        if (!room.spotlight) throw new DomainError("INVALID_OPERATION", "There is no active Spotlight.");
        const followers = new Set(room.spotlight.followingParticipantIds);
        if (input.action === "join") followers.add(input.participantId);
        else followers.delete(input.participantId);
        room.spotlight.followingParticipantIds = [...followers];
      }
      room.stateRevision = (room.stateRevision ?? room.roomRevision) + 1;
      return {
        room,
        result: room,
        eventActor: actorFor(participant, actorKind),
      };
    },
    "spotlight.updated",
  );
}

export async function upgradeMembership(roomId: string, participantId: string): Promise<RoomState> {
  return getRoomStore().transact(
    roomId,
    (room) => {
      const participant = requireParticipant(room, participantId);
      participant.role = "participant";
      participant.lastSeenAt = Date.now();
      room.roomRevision += 1;
      room.updatedAt = Date.now();
      return {
        room,
        result: room,
        eventActor: actorFor(participant, "human"),
      };
    },
    "presence.updated",
  );
}

export function activity(input: Omit<AgentActivity, "id" | "startedAt">): AgentActivity {
  return { ...input, id: randomUUID(), startedAt: Date.now() };
}
