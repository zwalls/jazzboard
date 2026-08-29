import {
  commitAgentCanvasDraftRequestSchema,
  discardAgentCanvasDraftRequestSchema,
  replaceAgentCanvasDraftRequestSchema,
  stageAgentCanvasDraftRequestSchema,
} from "@/lib/agent-drafts/schemas";
import {
  commitAgentCanvasDraft,
  discardAgentCanvasDraft,
  listAgentCanvasDrafts,
  readAgentCanvasDraft,
  replaceAgentCanvasDraft,
  stageAgentCanvasDraft,
} from "@/lib/server/agent-draft-service";

import { errorResponse, json, readJsonBody, runMutationRequest } from "./http";
import { requireGuestParticipantId } from "./session";

const MAX_AGENT_DRAFT_REQUEST_BYTES = 256 * 1024;

type RoomRouteContext = { params: Promise<{ roomId: string }> };
type DraftRouteContext = { params: Promise<{ roomId: string; draftId: string }> };

export async function handleListAgentCanvasDrafts(
  request: Request,
  context: RoomRouteContext,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    return json({ ok: true, ...(await listAgentCanvasDrafts({ roomId, participantId })) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleReadAgentCanvasDraft(
  request: Request,
  context: DraftRouteContext,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId, draftId } = await context.params;
    return json({ ok: true, ...(await readAgentCanvasDraft({ roomId, draftId, participantId })) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleStageAgentCanvasDraft(
  request: Request,
  context: RoomRouteContext,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = stageAgentCanvasDraftRequestSchema.parse(
      await readJsonBody(request, { maximumBytes: MAX_AGENT_DRAFT_REQUEST_BYTES }),
    );
    const draft = await runMutationRequest({
      request,
      participantId,
      roomId,
      operation: "room.agent.draft.stage",
      actorKind: "agent",
      parsedBody: body,
      execute: () => stageAgentCanvasDraft({ roomId, participantId, request: body }),
    });
    return json({ ok: true, draft }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleReplaceAgentCanvasDraft(
  request: Request,
  context: DraftRouteContext,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId, draftId } = await context.params;
    const body = replaceAgentCanvasDraftRequestSchema.parse(
      await readJsonBody(request, { maximumBytes: MAX_AGENT_DRAFT_REQUEST_BYTES }),
    );
    const draft = await runMutationRequest({
      request,
      participantId,
      roomId,
      operation: "room.agent.draft.replace",
      actorKind: "agent",
      parsedBody: { draftId, ...body },
      execute: () => replaceAgentCanvasDraft({ roomId, draftId, participantId, request: body }),
    });
    return json({ ok: true, draft });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleDiscardAgentCanvasDraft(
  request: Request,
  context: DraftRouteContext,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId, draftId } = await context.params;
    const body = discardAgentCanvasDraftRequestSchema.parse(
      await readJsonBody(request, { maximumBytes: MAX_AGENT_DRAFT_REQUEST_BYTES }),
    );
    const result = await runMutationRequest({
      request,
      participantId,
      roomId,
      operation: "room.agent.draft.discard",
      actorKind: "agent",
      parsedBody: { draftId, ...body },
      execute: () => discardAgentCanvasDraft({ roomId, draftId, participantId, request: body }),
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleCommitAgentCanvasDraft(
  request: Request,
  context: DraftRouteContext,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId, draftId } = await context.params;
    const body = commitAgentCanvasDraftRequestSchema.parse(
      await readJsonBody(request, { maximumBytes: MAX_AGENT_DRAFT_REQUEST_BYTES }),
    );
    const result = await runMutationRequest({
      request,
      participantId,
      roomId,
      operation: "room.agent.draft.commit",
      actorKind: "agent",
      parsedBody: { draftId, ...body },
      execute: () => commitAgentCanvasDraft({ roomId, draftId, participantId, request: body }),
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
