import type {
  AgentMessage,
  AgentMessageContext,
  AgentMessageDiagramSummary,
  AgentMessageListResult,
  AgentMessageOutcome,
} from "@/lib/agent-messages/types";
import { actorFor, requireParticipant } from "@/lib/domain/engine";
import { DomainError } from "@/lib/domain/errors";
import type { CanvasBounds, CanvasObject, Diagram, RoomState } from "@/lib/domain/types";

import {
  agentMessageReplyFingerprint,
  agentMessageRequestFingerprint,
  getAgentMessageStore,
} from "./agent-message-store";
import { getRoomStore } from "./room-store";

async function readParticipantRoom(roomId: string, participantId: string): Promise<{
  room: RoomState;
  participant: RoomState["participants"][string];
}> {
  const room = await getRoomStore().getRoom(roomId);
  if (!room) throw new DomainError("ROOM_NOT_FOUND", "This Jazzboard no longer exists.");
  const participant = requireParticipant(room, participantId);
  // Private human-to-agent channels are deliberately unavailable to spectators,
  // including reads, because their linked agent cannot act in this room.
  if (participant.role !== "participant") {
    throw new DomainError(
      "FORBIDDEN",
      "Only room participants can use the private agent inbox.",
      { role: participant.role },
    );
  }
  return { room, participant };
}

function unionBounds(objects: readonly CanvasObject[]): CanvasBounds | null {
  if (!objects.length) return null;
  const minX = Math.min(...objects.map((object) => object.x));
  const minY = Math.min(...objects.map((object) => object.y));
  const maxX = Math.max(...objects.map((object) => object.x + object.width));
  const maxY = Math.max(...objects.map((object) => object.y + object.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function diagramSummary(diagram: Diagram): AgentMessageDiagramSummary {
  return {
    id: diagram.id,
    title: diagram.title,
    description: diagram.description,
    diagramType: diagram.diagramType,
    category: diagram.category,
    tags: [...diagram.tags],
    memberObjectIds: [...diagram.memberObjectIds],
    connectorIds: [...diagram.connectorIds],
    bounds: structuredClone(diagram.bounds),
    revision: diagram.revision,
  };
}

export function snapshotAgentMessageContext(
  room: RoomState,
  selectedObjectIds: readonly string[],
): AgentMessageContext {
  const objectIds = [...selectedObjectIds];
  const objects = objectIds
    .map((objectId) => room.objects[objectId])
    .filter((object): object is CanvasObject => object !== undefined)
    .map((object) => structuredClone(object));
  const foundObjectIds = new Set(objects.map((object) => object.id));
  const missingObjectIds = objectIds.filter((objectId) => !foundObjectIds.has(objectId));
  const selectedSet = new Set(objectIds);
  const diagramIds = new Set(objects.flatMap((object) => object.diagramIds));
  for (const diagram of Object.values(room.diagrams)) {
    if (
      diagram.memberObjectIds.some((objectId) => selectedSet.has(objectId)) ||
      diagram.connectorIds.some((objectId) => selectedSet.has(objectId))
    ) {
      diagramIds.add(diagram.id);
    }
  }
  const diagrams = [...diagramIds]
    .map((diagramId) => room.diagrams[diagramId])
    .filter((diagram): diagram is Diagram => diagram !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(diagramSummary);
  return {
    room: { id: room.id, title: room.title, roomRevision: room.roomRevision },
    selection: {
      objectIds,
      objects,
      missingObjectIds,
      diagrams,
      bounds: unionBounds(objects),
    },
  };
}

export async function createAgentMessage(input: {
  roomId: string;
  participantId: string;
  messageId: string;
  prompt: string;
  selectedObjectIds: string[];
}): Promise<AgentMessage> {
  if (input.selectedObjectIds.length === 0) {
    throw new DomainError("INVALID_OPERATION", "Select at least one canvas object before asking the agent.");
  }
  const { room, participant } = await readParticipantRoom(input.roomId, input.participantId);
  const createdAt = Date.now();
  return getAgentMessageStore().create(
    { roomId: room.id, participantId: participant.participantId },
    {
      id: input.messageId,
      prompt: input.prompt,
      createdAt,
      author: actorFor(participant, "human"),
      context: snapshotAgentMessageContext(room, input.selectedObjectIds),
      requestFingerprint: agentMessageRequestFingerprint(input),
    },
  );
}

export async function listAgentMessages(input: {
  roomId: string;
  participantId: string;
  status?: "pending" | "claimed" | "answered";
  limit: number;
  afterSequence?: number;
  order?: "oldest" | "newest";
}): Promise<AgentMessageListResult> {
  const { room, participant } = await readParticipantRoom(input.roomId, input.participantId);
  return getAgentMessageStore().list(
    { roomId: room.id, participantId: participant.participantId },
    { status: input.status, limit: input.limit, afterSequence: input.afterSequence, order: input.order },
  );
}

export async function claimAgentMessage(input: {
  roomId: string;
  participantId: string;
  messageId: string;
  claimId: string;
  leaseSeconds: number;
}): Promise<{ message: AgentMessage; claimToken: string }> {
  const { room, participant } = await readParticipantRoom(input.roomId, input.participantId);
  return getAgentMessageStore().claim({
    scope: { roomId: room.id, participantId: participant.participantId },
    messageId: input.messageId,
    claimId: input.claimId,
    leaseSeconds: input.leaseSeconds,
    now: Date.now(),
  });
}

export async function replyAgentMessage(input: {
  roomId: string;
  participantId: string;
  messageId: string;
  replyId: string;
  claimToken: string;
  text: string;
  outcome: AgentMessageOutcome;
}): Promise<AgentMessage> {
  const { room, participant } = await readParticipantRoom(input.roomId, input.participantId);
  const now = Date.now();
  return getAgentMessageStore().reply({
    scope: { roomId: room.id, participantId: participant.participantId },
    messageId: input.messageId,
    claimToken: input.claimToken,
    replyFingerprint: agentMessageReplyFingerprint(input),
    now,
    reply: {
      id: input.replyId,
      text: input.text,
      outcome: input.outcome,
      createdAt: now,
      author: actorFor(participant, "agent"),
    },
  });
}
