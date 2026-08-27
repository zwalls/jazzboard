import { randomUUID } from "node:crypto";

import type {
  ActivityMutationMetadata,
  ActivityRevisionGuard,
  ActorRef,
  AgentEditProposal,
  AgentEditProposalPurpose,
  AgentEditProposalRequest,
  AgentEditProposalSummary,
  CanvasBounds,
  CanvasCommand,
  RoomActivity,
  RoomActivityAction,
  RoomActivitySummary,
  RoomState,
} from "./types";

export const MAX_ROOM_REVIEW_PROPOSALS = 100;

const uniqueSorted = (values: readonly string[]) => [...new Set(values)].sort();

function guardFor(entity: { revision: number } | undefined): ActivityRevisionGuard {
  return entity ? { state: "present", revision: entity.revision } : { state: "absent" };
}

function unionBounds(bounds: readonly CanvasBounds[]): CanvasBounds | null {
  if (!bounds.length) return null;
  const x = Math.min(...bounds.map((item) => item.x));
  const y = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const bottom = Math.max(...bounds.map((item) => item.y + item.height));
  return { x, y, width: Math.max(right - x, 1), height: Math.max(bottom - y, 1) };
}

export type BuildRoomActivityInput = {
  before: RoomState;
  after: RoomState;
  actor: ActorRef;
  action: RoomActivityAction;
  label: string;
  changedObjectIds: readonly string[];
  changedDiagramIds: readonly string[];
  membershipObjectIds?: readonly string[];
  metadata?: ActivityMutationMetadata;
  id?: string;
  occurredAt?: number;
  revertsActivityId?: string | null;
};

/**
 * Captures a private, immutable mutation record. Direct object changes and
 * derived Diagram reverse-index changes are distinguished so a later revert
 * restores authoritative Diagram membership instead of overwriting objects.
 */
export function buildRoomActivity(input: BuildRoomActivityInput): RoomActivity {
  const directObjectIds = new Set(input.changedObjectIds);
  const affectedObjectIds = uniqueSorted([
    ...input.changedObjectIds,
    ...(input.membershipObjectIds ?? []),
  ]);
  const affectedDiagramIds = uniqueSorted(input.changedDiagramIds);
  const objectChanges = affectedObjectIds.map((objectId) => ({
    objectId,
    mode: directObjectIds.has(objectId) ? "direct" as const : "derived_membership" as const,
    before: input.before.objects[objectId] ? structuredClone(input.before.objects[objectId]) : null,
    after: input.after.objects[objectId] ? structuredClone(input.after.objects[objectId]) : null,
  }));
  const diagramChanges = affectedDiagramIds.map((diagramId) => ({
    diagramId,
    before: input.before.diagrams?.[diagramId]
      ? structuredClone(input.before.diagrams[diagramId])
      : null,
    after: input.after.diagrams?.[diagramId]
      ? structuredClone(input.after.diagrams[diagramId])
      : null,
  }));
  const affectedBounds = unionBounds([
    ...objectChanges.flatMap((change) => [change.before, change.after]
      .filter((object) => object !== null)
      .map((object) => ({ x: object.x, y: object.y, width: object.width, height: object.height }))),
    ...diagramChanges.flatMap((change) => [change.before?.bounds, change.after?.bounds]
      .filter((bounds): bounds is CanvasBounds => bounds !== undefined)),
  ]);

  return {
    id: input.id ?? `activity_${randomUUID()}`,
    roomId: input.after.id,
    roomRevision: input.after.roomRevision,
    occurredAt: input.occurredAt ?? input.after.updatedAt,
    actor: structuredClone(input.actor),
    action: input.action,
    label: input.label,
    intent: input.metadata?.intent ?? null,
    summary: input.metadata?.summary ?? null,
    affectedObjectIds,
    affectedDiagramIds,
    affectedBounds,
    objectChanges,
    diagramChanges,
    objectGuards: Object.fromEntries(
      affectedObjectIds.map((objectId) => [objectId, guardFor(input.after.objects[objectId])]),
    ),
    diagramGuards: Object.fromEntries(
      affectedDiagramIds.map((diagramId) => [diagramId, guardFor(input.after.diagrams?.[diagramId])]),
    ),
    revertsActivityId: input.revertsActivityId ?? null,
  };
}

/** Removes private before/after snapshots from the authorized API projection. */
export function roomActivitySummary(activity: RoomActivity): RoomActivitySummary {
  const summary = structuredClone(activity) as Partial<RoomActivity>;
  delete summary.objectChanges;
  delete summary.diagramChanges;
  return summary as RoomActivitySummary;
}

export function canvasCommandActivityDescriptor(command: CanvasCommand, changedCount: number): {
  action: RoomActivityAction;
  label: string;
} {
  const suffix = `${changedCount} object${changedCount === 1 ? "" : "s"}`;
  switch (command.type) {
    case "create":
      return { action: "canvas.create", label: `Created ${suffix}` };
    case "update":
      return { action: "canvas.update", label: `Updated ${suffix}` };
    case "move":
      return { action: "canvas.move", label: `Moved ${suffix}` };
    case "group":
      return { action: "canvas.group", label: `Grouped ${suffix}` };
    case "delete":
      return { action: "canvas.delete", label: `Deleted ${suffix}` };
  }
}

function commandObjectIds(command: CanvasCommand): string[] {
  if (command.type === "create") return [command.object.id];
  if (command.type === "update") return [command.objectId];
  return command.targets.map((target) => target.objectId);
}

export function agentEditProposalPurpose(request: AgentEditProposalRequest): AgentEditProposalPurpose {
  if (request.kind === "canvas_command") {
    const objectIds = uniqueSorted(commandObjectIds(request.command));
    const descriptor = canvasCommandActivityDescriptor(request.command, objectIds.length);
    return {
      kind: request.kind,
      label: `Proposed: ${descriptor.label}`,
      operationCount: 1,
      objectIds,
      diagramIds: [],
      layout: null,
    };
  }
  if (request.kind === "layout") {
    return {
      kind: request.kind,
      label: `Proposed ${request.layout.layout} layout for ${request.layout.targets.length} object${request.layout.targets.length === 1 ? "" : "s"}`,
      operationCount: 1,
      objectIds: uniqueSorted(request.layout.targets.map((target) => target.objectId)),
      diagramIds: request.layout.diagramId ? [request.layout.diagramId] : [],
      layout: request.layout.layout,
    };
  }
  if (request.kind === "activity_revert") {
    return {
      kind: request.kind,
      label: `Proposed reverting activity ${request.revert.activityId}`,
      operationCount: 1,
      objectIds: uniqueSorted(request.revert.objectExpectations.map((item) => item.objectId)),
      diagramIds: uniqueSorted(request.revert.diagramExpectations.map((item) => item.diagramId)),
      layout: null,
    };
  }
  const diagramMemberIds = request.transaction.diagramCommands.flatMap((command) =>
    command.type === "diagram.create"
      ? [...command.diagram.memberObjectIds, ...command.diagram.connectorIds]
      : [...(command.patch.memberObjectIds ?? []), ...(command.patch.connectorIds ?? [])],
  );
  const objectIds = uniqueSorted([
    ...request.transaction.commands.flatMap(commandObjectIds),
    ...diagramMemberIds,
    ...(request.transaction.autoLayout?.targets.map((target) => target.objectId) ?? []),
  ]);
  const diagramIds = uniqueSorted([
    ...request.transaction.diagramCommands.map((command) =>
      command.type === "diagram.create" ? command.diagram.id : command.diagramId,
    ),
    ...(request.transaction.autoLayout?.diagramId ? [request.transaction.autoLayout.diagramId] : []),
  ]);
  const operationCount =
    request.transaction.commands.length +
    request.transaction.diagramCommands.length +
    (request.transaction.autoLayout ? 1 : 0);
  const layoutSuffix = request.transaction.autoLayout
    ? ` with ${request.transaction.autoLayout.density ?? "comfortable"} ${request.transaction.autoLayout.layout} layout`
    : "";
  return {
    kind: request.kind,
    label: `Proposed ${operationCount} semantic operation${operationCount === 1 ? "" : "s"}${layoutSuffix}`,
    operationCount,
    objectIds,
    diagramIds,
    layout: request.transaction.autoLayout?.layout ?? null,
  };
}

export function buildAgentEditProposal(input: {
  room: RoomState;
  actor: ActorRef;
  request: AgentEditProposalRequest;
  metadata?: ActivityMutationMetadata;
  id?: string;
  now?: number;
}): AgentEditProposal {
  const now = input.now ?? Date.now();
  return {
    id: input.id ?? `proposal_${randomUUID()}`,
    roomId: input.room.id,
    revision: 1,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    baselineRoomRevision: input.room.roomRevision,
    author: structuredClone(input.actor),
    intent: input.metadata?.intent ?? null,
    summary: input.metadata?.summary ?? null,
    purpose: agentEditProposalPurpose(input.request),
    request: structuredClone(input.request),
    review: null,
  };
}

export function agentEditProposalSummary(proposal: AgentEditProposal): AgentEditProposalSummary {
  const summary = structuredClone(proposal) as Partial<AgentEditProposal>;
  delete summary.request;
  return summary as AgentEditProposalSummary;
}
