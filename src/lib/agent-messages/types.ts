import type { ActorRef, CanvasBounds, CanvasObject, DiagramType } from "@/lib/domain/types";

export type AgentMessageState = "pending" | "claimed" | "answered";
export type AgentMessageOutcome = "completed" | "needs_input" | "failed";

export type AgentMessageDiagramSummary = {
  id: string;
  title: string;
  description: string;
  diagramType: DiagramType;
  category: string | null;
  tags: string[];
  memberObjectIds: string[];
  connectorIds: string[];
  bounds: CanvasBounds;
  revision: number;
};

export type AgentMessageContext = {
  room: {
    id: string;
    title: string;
    roomRevision: number;
  };
  selection: {
    /** Stable caller selection, de-duplicated without reordering. */
    objectIds: string[];
    /** Authoritative immutable object snapshots found at submission time. */
    objects: CanvasObject[];
    missingObjectIds: string[];
    /** Authoritative summaries for diagrams containing selected objects. */
    diagrams: AgentMessageDiagramSummary[];
    bounds: CanvasBounds | null;
  };
};

export type AgentMessageReply = {
  id: string;
  text: string;
  outcome: AgentMessageOutcome;
  createdAt: number;
  author: ActorRef;
};

export type AgentMessage = {
  id: string;
  sequence: number;
  version: number;
  state: AgentMessageState;
  prompt: string;
  createdAt: number;
  author: ActorRef;
  context: AgentMessageContext;
  claimedUntil: number | null;
  reply: AgentMessageReply | null;
};

export type CreateAgentMessageRequest = {
  messageId: string;
  prompt: string;
  selectedObjectIds: string[];
};

export type ClaimAgentMessageRequest = {
  claimId: string;
  leaseSeconds: number;
};

export type ReplyAgentMessageRequest = {
  replyId: string;
  claimToken: string;
  text: string;
  outcome: AgentMessageOutcome;
};

export type AgentMessageListResult = {
  messages: AgentMessage[];
  totalMatched: number;
  truncated: boolean;
};
