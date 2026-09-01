import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";

import { apiRequest } from "./api";

export const AGENT_DRAFT_KEEPALIVE_INTERVAL_MS = 60_000;

type DraftKeepaliveResponse = {
  ok: true;
  draft: AgentCanvasDraftSnapshot;
  serverTime: number;
};

type AgentDraftKeepaliveRequest = (
  url: string,
  init?: RequestInit,
) => Promise<DraftKeepaliveResponse>;

export async function keepAliveOwnedAgentDrafts(input: {
  roomId: string;
  participantId: string;
  drafts: AgentCanvasDraftSnapshot[];
  signal: AbortSignal;
  acceptDraft: (draft: AgentCanvasDraftSnapshot) => unknown;
  request?: AgentDraftKeepaliveRequest;
}): Promise<number> {
  const request = input.request ?? (
    (url: string, init?: RequestInit) => apiRequest<DraftKeepaliveResponse>(url, init)
  );
  const ownedActiveDrafts = input.drafts.filter((draft) => (
    draft.roomId === input.roomId &&
    draft.ownerParticipantId === input.participantId &&
    draft.status === "active"
  ));

  for (const draft of ownedActiveDrafts) {
    const response = await request(
      `/api/rooms/${encodeURIComponent(input.roomId)}/agent/drafts/${encodeURIComponent(draft.id)}/keepalive`,
      {
        method: "POST",
        body: JSON.stringify({ expectedDraftRevision: draft.revision }),
        signal: input.signal,
      },
    );
    input.acceptDraft(response.draft);
  }

  return ownedActiveDrafts.length;
}
