/// <reference types="webmcp-types" />

import { z } from "zod";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import type { ActorKind, FollowTarget, Participant, RoomState } from "@/lib/domain/types";

import type {
  JazzboardToolFailure,
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpDependencies,
  WebMcpRequest,
} from "./types";

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const emptyInputSchema = z.object({}).strict();
const actorKindSchema = z.enum(["human", "agent"]);
const followParticipantInputSchema = z
  .object({
    participantId: z.string().min(1).max(128),
    target: actorKindSchema,
  })
  .strict();
const spotlightTargetInputSchema = z.object({ target: actorKindSchema }).strict();

type RoomResponse = {
  ok: true;
  room: RoomState;
  participantId?: string;
};

type SpotlightAction =
  | { action: "start" | "request"; target: ActorKind }
  | { action: "stop" | "handoff" | "dismiss_request" | "join" | "leave" };

class LifecycleToolFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LifecycleToolFailure";
  }
}

function failure(tool: string, error: unknown): JazzboardToolFailure {
  if (error instanceof JazzboardApiError) {
    return { ok: false, tool, error: error.failure };
  }
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "The tool input does not match Jazzboard's collaboration lifecycle schema.",
        details: {
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      },
    };
  }
  if (error instanceof LifecycleToolFailure) {
    return {
      ok: false,
      tool,
      error: { code: error.code, message: error.message, details: error.details },
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      ok: false,
      tool,
      error: { code: "TOOL_ABORTED", message: "The WebMCP tool call was cancelled." },
    };
  }
  return {
    ok: false,
    tool,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: error instanceof Error ? error.message : "Jazzboard could not execute this tool.",
    },
  };
}

function defineTool<TSchema extends z.ZodType>(input: {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  schema: TSchema;
  annotations?: WebMCP.ToolAnnotations;
  execute: (input: z.output<TSchema>, signal: AbortSignal) => Promise<unknown>;
}): WebMCP.ModelContextTool {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema,
    annotations: input.annotations,
    async execute(rawInput, options): Promise<JazzboardToolResult> {
      try {
        const parsed = input.schema.parse(rawInput);
        const signal = options?.signal ?? new AbortController().signal;
        const data = await input.execute(parsed, signal);
        return { ok: true, tool: input.name, data };
      } catch (error) {
        return failure(input.name, error);
      }
    },
  };
}

function roomUrl(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}`;
}

function spotlightUrl(roomId: string): string {
  return `${roomUrl(roomId)}/agent/spotlight`;
}

function participantSummary(participant: Participant) {
  return {
    participantId: participant.participantId,
    displayName: participant.displayName,
    color: participant.color,
    role: participant.role,
    connected: participant.connected,
    agentActive: participant.agentActive,
    human: participant.human,
    agent: participant.agent,
  };
}

function requireSelf(room: RoomState, participantId: string): Participant {
  const self = room.participants[participantId];
  if (!self) {
    throw new LifecycleToolFailure(
      "ROOM_ACCESS_INVALID",
      "The authorized room response did not contain this browser session's membership.",
      { participantId },
    );
  }
  return self;
}

function requireFollowTarget(room: RoomState, participantId: string, target: ActorKind): Participant {
  const participant = room.participants[participantId];
  if (!participant || participant.role !== "participant") {
    throw new LifecycleToolFailure(
      "FOLLOW_TARGET_NOT_FOUND",
      "Follow requires the exact participant ID of a participant in this room.",
      { participantId },
    );
  }
  if (target === "agent" && !participant.agentActive) {
    throw new LifecycleToolFailure(
      "AGENT_NOT_ACTIVE",
      `${participant.displayName}'s agent is not active yet.`,
      { participantId },
    );
  }
  return participant;
}

function spotlightFollowTarget(room: RoomState, participantId: string): FollowTarget {
  const spotlight = room.spotlight;
  if (!spotlight?.followingParticipantIds.includes(participantId)) return null;
  return { participantId: spotlight.presenterId, kind: spotlight.target };
}

function followSummary(room: RoomState, participantId: string, localTarget: FollowTarget) {
  const spotlightTarget = spotlightFollowTarget(room, participantId);
  const effectiveTarget = spotlightTarget ?? localTarget;
  const participant = effectiveTarget ? room.participants[effectiveTarget.participantId] : null;
  return {
    mode: spotlightTarget ? "spotlight" : effectiveTarget ? "private" : "none",
    target: effectiveTarget && participant
      ? { ...effectiveTarget, displayName: participant.displayName, connected: participant.connected }
      : null,
    localTarget,
  };
}

function spotlightSummary(room: RoomState, participantId: string) {
  if (!room.spotlight) return null;
  const presenter = room.participants[room.spotlight.presenterId];
  const requester = room.spotlight.handoffRequest
    ? room.participants[room.spotlight.handoffRequest.requesterId]
    : null;
  return {
    ...room.spotlight,
    presenter: presenter ? participantSummary(presenter) : null,
    handoffRequester: requester ? participantSummary(requester) : null,
    self: {
      presenting: room.spotlight.presenterId === participantId,
      following: room.spotlight.followingParticipantIds.includes(participantId),
      requestedHandoff: room.spotlight.handoffRequest?.requesterId === participantId,
    },
  };
}

function collaborationSnapshot(
  room: RoomState,
  binding: JazzboardWebMcpBinding,
  localTarget = binding.context.getFollowTarget(),
) {
  const self = requireSelf(room, binding.participantId);
  return {
    room: {
      id: room.id,
      code: room.code,
      title: room.title,
      roomRevision: room.roomRevision,
      agentEditPolicy: room.agentEditPolicy,
      pendingAgentEditProposalCount: room.reviewProposals.filter((proposal) => proposal.status === "pending").length,
    },
    session: {
      participantId: binding.participantId,
      role: self.role,
      connected: self.connected,
      agentActive: self.agentActive,
    },
    participants: Object.values(room.participants).map(participantSummary),
    follow: followSummary(room, binding.participantId, localTarget),
    spotlight: spotlightSummary(room, binding.participantId),
  };
}

export const JAZZBOARD_LIFECYCLE_READ_TOOL_NAMES = ["read_collaboration_state"] as const;

export const JAZZBOARD_LIFECYCLE_PARTICIPANT_TOOL_NAMES = [
  "follow_participant",
  "stop_following",
  "start_spotlight",
  "request_spotlight",
  "stop_spotlight",
  "join_spotlight",
  "leave_spotlight",
  "approve_spotlight_handoff",
  "dismiss_spotlight_request",
  "leave_room",
] as const;

export const JAZZBOARD_LIFECYCLE_TOOL_NAMES = [
  ...JAZZBOARD_LIFECYCLE_READ_TOOL_NAMES,
  ...JAZZBOARD_LIFECYCLE_PARTICIPANT_TOOL_NAMES,
] as const;

/**
 * Collaboration and room-view lifecycle tools. Spectators receive only the
 * strictly read-only collaboration snapshot; every state-changing operation is
 * participant-scoped and remains server-authorized by the signed guest session.
 */
export function createJazzboardLifecycleWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies: JazzboardWebMcpDependencies = {},
): WebMCP.ModelContextTool[] {
  const request = dependencies.request ?? (apiRequest as WebMcpRequest);

  async function readAuthorizedRoom(signal: AbortSignal): Promise<RoomState> {
    const response = await request<RoomResponse>(roomUrl(binding.roomId), {
      method: "GET",
      signal,
    });
    binding.context.acceptRoom(response.room);
    requireSelf(response.room, binding.participantId);
    return response.room;
  }

  async function updateSpotlight(action: SpotlightAction, signal: AbortSignal): Promise<RoomState> {
    const response = await request<RoomResponse>(spotlightUrl(binding.roomId), {
      method: "POST",
      body: JSON.stringify(action),
      signal,
    });
    binding.context.acceptRoom(response.room);
    return response.room;
  }

  const readTools = [
    defineTool({
      name: "read_collaboration_state",
      title: "Read Jazzboard collaboration state",
      description:
        "Read the signed session's room role, live human-and-agent presence, private Follow target, complete Spotlight lifecycle state, and current live-versus-review agent edit policy without changing shared state.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      schema: emptyInputSchema,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(_input, signal) {
        const room = await readAuthorizedRoom(signal);
        return collaborationSnapshot(room, binding);
      },
    }),
  ];

  if (binding.role !== "participant") return readTools;

  const participantTools = [
    defineTool({
      name: "follow_participant",
      title: "Privately follow a room participant",
      description:
        "Make this browser privately follow the exact in-room participant's human cursor or active agent viewport. If this browser is in Spotlight, it leaves Spotlight first.",
      inputSchema: {
        type: "object",
        properties: {
          participantId: { type: "string", minLength: 1, maxLength: 128 },
          target: { enum: ["human", "agent"] },
        },
        required: ["participantId", "target"],
        additionalProperties: false,
      },
      schema: followParticipantInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        let room = await readAuthorizedRoom(signal);
        const participant = requireFollowTarget(room, input.participantId, input.target);
        if (input.participantId === binding.participantId && input.target === "human") {
          throw new LifecycleToolFailure(
            "SELF_FOLLOW_INVALID",
            "Following your own human cursor is not meaningful; use stop_following instead.",
          );
        }
        const currentSpotlight = room.spotlight;
        const leftSpotlight = Boolean(currentSpotlight?.followingParticipantIds.includes(binding.participantId));
        if (leftSpotlight) {
          room = await updateSpotlight({ action: "leave" }, signal);
          binding.context.setDeclinedSpotlight(currentSpotlight?.startedAt ?? null);
        }
        const target: Exclude<FollowTarget, null> = {
          participantId: participant.participantId,
          kind: input.target,
        };
        binding.context.setFollowTarget(target);
        return {
          follow: followSummary(room, binding.participantId, target),
          leftSpotlight,
          roomRevision: room.roomRevision,
        };
      },
    }),
    defineTool({
      name: "stop_following",
      title: "Stop following in Jazzboard",
      description:
        "Stop this browser's private Follow target and, when currently following an active Spotlight, explicitly leave that Spotlight as one conflict-free lifecycle action.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      schema: emptyInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(_input, signal) {
        let room = await readAuthorizedRoom(signal);
        const previous = followSummary(room, binding.participantId, binding.context.getFollowTarget());
        const currentSpotlight = room.spotlight;
        const leftSpotlight = Boolean(currentSpotlight?.followingParticipantIds.includes(binding.participantId));
        if (leftSpotlight) {
          room = await updateSpotlight({ action: "leave" }, signal);
          binding.context.setDeclinedSpotlight(currentSpotlight?.startedAt ?? null);
        }
        binding.context.setFollowTarget(null);
        return {
          stopped: previous.mode !== "none",
          previous,
          follow: followSummary(room, binding.participantId, null),
          leftSpotlight,
          roomRevision: room.roomRevision,
        };
      },
    }),
    defineTool({
      name: "start_spotlight",
      title: "Start a Jazzboard Spotlight",
      description:
        "Start Spotlight as this participant, presenting either the human cursor or this participant's active agent viewport to the room after the normal five-second invitation window.",
      inputSchema: {
        type: "object",
        properties: { target: { enum: ["human", "agent"] } },
        required: ["target"],
        additionalProperties: false,
      },
      schema: spotlightTargetInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const room = await updateSpotlight({ action: "start", target: input.target }, signal);
        binding.context.setDeclinedSpotlight(null);
        binding.context.setFollowTarget(null);
        return { spotlight: spotlightSummary(room, binding.participantId), roomRevision: room.roomRevision };
      },
    }),
    defineTool({
      name: "request_spotlight",
      title: "Request a Jazzboard Spotlight handoff",
      description:
        "Request that the current presenter hand Spotlight to this participant's human cursor or active agent viewport; the presenter must explicitly approve the request.",
      inputSchema: {
        type: "object",
        properties: { target: { enum: ["human", "agent"] } },
        required: ["target"],
        additionalProperties: false,
      },
      schema: spotlightTargetInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const room = await updateSpotlight({ action: "request", target: input.target }, signal);
        return { spotlight: spotlightSummary(room, binding.participantId), roomRevision: room.roomRevision };
      },
    }),
    defineTool({
      name: "stop_spotlight",
      title: "Stop the active Jazzboard Spotlight",
      description:
        "Stop the active Spotlight when this signed participant is its current presenter. Server authorization rejects every other caller.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      schema: emptyInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(_input, signal) {
        const room = await updateSpotlight({ action: "stop" }, signal);
        binding.context.setDeclinedSpotlight(null);
        return { spotlight: null, roomRevision: room.roomRevision };
      },
    }),
    defineTool({
      name: "join_spotlight",
      title: "Join the active Jazzboard Spotlight",
      description:
        "Follow the current presenter through the active Spotlight and clear any earlier decline for this Spotlight in the visual room experience.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      schema: emptyInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(_input, signal) {
        const room = await updateSpotlight({ action: "join" }, signal);
        binding.context.setDeclinedSpotlight(null);
        binding.context.setFollowTarget(null);
        return { spotlight: spotlightSummary(room, binding.participantId), roomRevision: room.roomRevision };
      },
    }),
    defineTool({
      name: "leave_spotlight",
      title: "Leave the active Jazzboard Spotlight",
      description:
        "Decline or leave the current shared Spotlight for this participant while keeping the room open and preserving any separately chosen private Follow target.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      schema: emptyInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(_input, signal) {
        const room = await updateSpotlight({ action: "leave" }, signal);
        binding.context.setDeclinedSpotlight(room.spotlight?.startedAt ?? null);
        return { spotlight: spotlightSummary(room, binding.participantId), roomRevision: room.roomRevision };
      },
    }),
    defineTool({
      name: "approve_spotlight_handoff",
      title: "Approve the waiting Spotlight handoff",
      description:
        "Approve the current Spotlight handoff request when this participant is the presenter, making the waiting requester the new presenter after server authorization.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      schema: emptyInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(_input, signal) {
        const room = await updateSpotlight({ action: "handoff" }, signal);
        return { spotlight: spotlightSummary(room, binding.participantId), roomRevision: room.roomRevision };
      },
    }),
    defineTool({
      name: "dismiss_spotlight_request",
      title: "Dismiss the waiting Spotlight request",
      description:
        "Dismiss the current handoff request while retaining this participant's active Spotlight; only the signed current presenter is authorized.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      schema: emptyInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(_input, signal) {
        const room = await updateSpotlight({ action: "dismiss_request" }, signal);
        return { spotlight: spotlightSummary(room, binding.participantId), roomRevision: room.roomRevision };
      },
    }),
    defineTool({
      name: "leave_room",
      title: "Leave the current Jazzboard room view",
      description:
        "Navigate this browser back to Jazzboard home without deleting the private room or revoking this signed guest session's existing membership.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      schema: emptyInputSchema,
      async execute(_input, signal) {
        signal.throwIfAborted();
        binding.context.leaveRoomView();
        return {
          leftRoomId: binding.roomId,
          path: "/",
          membershipRetained: true,
          roomDeleted: false,
        };
      },
    }),
  ];

  return [...readTools, ...participantTools];
}
