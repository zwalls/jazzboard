import {
  agentMessageIdSchema,
  agentMessageListQuerySchema,
  claimAgentMessageSchema,
  createAgentMessageSchema,
  replyAgentMessageSchema,
} from "@/lib/agent-messages/schemas";

import { errorResponse, json, readJsonBody, runMutationRequest } from "./http";
import {
  claimAgentMessage,
  createAgentMessage,
  listAgentMessages,
  replyAgentMessage,
} from "./agent-message-service";
import { requireGuestParticipantId } from "./session";

type RoomContext = { params: Promise<{ roomId: string }> };
type MessageContext = { params: Promise<{ roomId: string; messageId: string }> };

export async function handleAgentMessageList(
  request: Request,
  context: RoomContext,
  order: "oldest" | "newest",
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const query = agentMessageListQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const result = await listAgentMessages({ roomId, participantId, ...query, order });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleAgentMessageCreate(
  request: Request,
  context: RoomContext,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = createAgentMessageSchema.parse(await readJsonBody(request));
    const message = await runMutationRequest({
      request,
      participantId,
      roomId,
      operation: "room.agent-message.create",
      actorKind: "human",
      parsedBody: body,
      execute: () => createAgentMessage({ roomId, participantId, ...body }),
    });
    return json({ ok: true, message });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleAgentMessageClaim(
  request: Request,
  context: MessageContext,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId, messageId: rawMessageId } = await context.params;
    const messageId = agentMessageIdSchema.parse(rawMessageId);
    const body = claimAgentMessageSchema.parse(await readJsonBody(request));
    const result = await runMutationRequest({
      request,
      participantId,
      roomId,
      operation: "room.agent-message.claim",
      actorKind: "agent",
      parsedBody: { messageId, ...body },
      execute: () => claimAgentMessage({ roomId, participantId, messageId, ...body }),
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleAgentMessageReply(
  request: Request,
  context: MessageContext,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId, messageId: rawMessageId } = await context.params;
    const messageId = agentMessageIdSchema.parse(rawMessageId);
    const body = replyAgentMessageSchema.parse(await readJsonBody(request));
    const message = await runMutationRequest({
      request,
      participantId,
      roomId,
      operation: "room.agent-message.reply",
      actorKind: "agent",
      parsedBody: { messageId, ...body },
      execute: () => replyAgentMessage({ roomId, participantId, messageId, ...body }),
    });
    return json({ ok: true, message });
  } catch (error) {
    return errorResponse(error);
  }
}
