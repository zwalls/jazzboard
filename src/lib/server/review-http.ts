import { z } from "zod";

import {
  agentEditPolicyRequestSchema,
  reviewProposalDecisionSchema,
  reviewProposalListQuerySchema,
} from "@/lib/domain/schemas";
import type { ActorKind } from "@/lib/domain/types";
import { errorResponse, json } from "@/lib/server/http";
import {
  listAgentEditProposals,
  readAgentEditProposal,
  reviewAgentEditProposal,
  setAgentEditPolicy,
} from "@/lib/server/room-service";
import { requireGuestParticipantId } from "@/lib/server/session";

type RoomContext = { params: Promise<{ roomId: string }> };
type ProposalContext = { params: Promise<{ roomId: string; proposalId: string }> };
const proposalIdSchema = z.string().min(1).max(128);

function reviewErrorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return json(
      {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "The review request does not match Jazzboard's schema.",
          details: { issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
        },
      },
      { status: 400 },
    );
  }
  return errorResponse(error);
}

export async function handleReviewList(request: Request, context: RoomContext): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const query = reviewProposalListQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return json({ ok: true, ...(await listAgentEditProposals({ roomId, participantId, ...query })) });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}

export async function handleReviewRead(request: Request, context: ProposalContext): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId, proposalId: rawProposalId } = await context.params;
    const proposalId = proposalIdSchema.parse(rawProposalId);
    const proposal = await readAgentEditProposal({ roomId, participantId, proposalId });
    return json({ ok: true, proposal });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}

export async function handleReviewPolicy(
  request: Request,
  context: RoomContext,
  actorKind: ActorKind,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = agentEditPolicyRequestSchema.parse(await request.json());
    return json({
      ok: true,
      ...(await setAgentEditPolicy({ roomId, participantId, actorKind, policy: body.policy })),
    });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}

export async function handleReviewDecision(
  request: Request,
  context: ProposalContext,
  actorKind: ActorKind,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId, proposalId: rawProposalId } = await context.params;
    const proposalId = proposalIdSchema.parse(rawProposalId);
    const body = reviewProposalDecisionSchema.parse(await request.json());
    return json({
      ok: true,
      ...(await reviewAgentEditProposal({ roomId, participantId, actorKind, proposalId, ...body })),
    });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
