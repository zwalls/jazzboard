import type {
  ActivityMutationMetadata,
  ActorRef,
  CanvasObject,
  Diagram,
  SemanticTransaction,
} from "@/lib/domain/types";

export const AGENT_CANVAS_DRAFT_SCHEMA_VERSION = 1 as const;

export type AgentCanvasDraftStatus = "active" | "committing" | "awaiting_review";
export type AgentCanvasDraftRemovalReason = "discarded" | "committed" | "proposed";

export type AgentCanvasDraftAuthoritativeCommit = {
  /** The exact in-flight mutation that produced the authoritative outcome. */
  mutationId: string;
  /** Durable document fence at which the candidate became authoritative. */
  roomRevision: number;
  committedAt: number;
};

/**
 * A render-ready object produced by applying a candidate transaction to a
 * cloned room. Its object revision and attribution are previews only and must
 * never be used as authoritative mutation guards.
 */
export type AgentDraftCanvasObject = CanvasObject & { authority: "draft" };
export type AgentDraftDiagram = Diagram & { authority: "draft" };

export type AgentCanvasDraft = {
  schemaVersion: typeof AGENT_CANVAS_DRAFT_SCHEMA_VERSION;
  id: string;
  roomId: string;
  ownerParticipantId: string;
  author: ActorRef;
  /** Draft-local compare-and-swap revision. It is unrelated to RoomState revisions. */
  revision: number;
  /** Exact durable semantic revision against which commit is allowed. */
  baselineRoomRevision: number;
  status: AgentCanvasDraftStatus;
  transaction: SemanticTransaction;
  /** Stable WebMCP tempRef -> eventual authoritative object/Diagram IDs. */
  temporaryReferences: Record<string, string>;
  previewObjects: AgentDraftCanvasObject[];
  previewDiagrams: AgentDraftDiagram[];
  metadata: ActivityMutationMetadata | null;
  createdAt: number;
  updatedAt: number;
  /** Sliding idle expiry, capped by hardExpiresAt. */
  expiresAt: number;
  hardExpiresAt: number;
  awaitingReview?: {
    proposalId: string;
    proposedAt: number;
  } | null;
  committing: {
    mutationId: string;
    startedAt: number;
  } | null;
  /**
   * Server-private terminal evidence written after the room commit and before
   * best-effort sidecar deletion. Optional for pre-field stored records.
   */
  authoritativeCommit?: AgentCanvasDraftAuthoritativeCommit | null;
};

/**
 * Public renderable draft state. The exact transaction and in-flight commit
 * mutation identity are deliberately server-private.
 */
export type AgentCanvasDraftSnapshot = Omit<
  AgentCanvasDraft,
  "transaction" | "committing" | "authoritativeCommit"
>;

export type AgentCanvasDraftEvent = {
  schemaVersion: typeof AGENT_CANVAS_DRAFT_SCHEMA_VERSION;
  id: string;
  roomId: string;
  occurredAt: number;
} & (
  | {
    type: "draft.upsert";
    draftId: string;
    ownerParticipantId: string;
    revision: number;
    status: AgentCanvasDraftStatus;
    expiresAt: number;
  }
  | {
    type: "draft.removed";
    draftId: string;
    revision: number;
  } & (
    | {
      reason: "committed";
      /** Authoritative document fence at which the draft became durable. */
      authoritativeRoomRevision: number;
    }
    | {
      reason: Exclude<AgentCanvasDraftRemovalReason, "committed">;
      authoritativeRoomRevision?: never;
    }
  )
);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Bounded structural guard; detailed draft contents are validated at the HTTP/store boundary. */
export function isAgentCanvasDraftEvent(value: unknown): value is AgentCanvasDraftEvent {
  const event = record(value);
  if (
    !event ||
    event.schemaVersion !== AGENT_CANVAS_DRAFT_SCHEMA_VERSION ||
    typeof event.id !== "string" ||
    event.id.length < 1 ||
    event.id.length > 160 ||
    typeof event.roomId !== "string" ||
    event.roomId.length < 1 ||
    event.roomId.length > 160 ||
    !Number.isSafeInteger(event.occurredAt) ||
    Number(event.occurredAt) < 0
  ) {
    return false;
  }
  if (
    typeof event.draftId !== "string" ||
    event.draftId.length < 1 ||
    event.draftId.length > 128 ||
    !Number.isSafeInteger(event.revision) ||
    Number(event.revision) < 1
  ) {
    return false;
  }
  if (event.type === "draft.upsert") {
    return typeof event.ownerParticipantId === "string" &&
      event.ownerParticipantId.length > 0 &&
      event.ownerParticipantId.length <= 160 &&
      (event.status === "active" || event.status === "committing" || event.status === "awaiting_review") &&
      Number.isSafeInteger(event.expiresAt) &&
      Number(event.expiresAt) >= 0;
  }
  if (event.type !== "draft.removed") return false;
  if (event.reason === "committed") {
    return Number.isSafeInteger(event.authoritativeRoomRevision) &&
      Number(event.authoritativeRoomRevision) >= 0;
  }
  return (event.reason === "discarded" || event.reason === "proposed") &&
    event.authoritativeRoomRevision === undefined;
}

export type AgentCanvasDraftListResult = {
  drafts: AgentCanvasDraftSnapshot[];
  serverTime: number;
};

export type StageAgentCanvasDraftRequest = {
  draftId: string;
  baselineRoomRevision: number;
  transaction: SemanticTransaction;
  temporaryReferences: Record<string, string>;
  metadata?: ActivityMutationMetadata;
};

export type ReplaceAgentCanvasDraftRequest = Omit<StageAgentCanvasDraftRequest, "draftId"> & {
  expectedDraftRevision: number;
  /**
   * replace keeps the historical full-candidate behavior. patch replaces or
   * appends only candidate creates carrying the submitted stable IDs, so an
   * author can repair a route without resending the whole composition.
   */
  updateMode?: "replace" | "patch";
};

export type KeepaliveAgentCanvasDraftRequest = {
  expectedDraftRevision: number;
};

export type CommitAgentCanvasDraftRequest = {
  expectedDraftRevision: number;
  /**
   * Required only when exact-revision deterministic fail findings are
   * deliberately preserved. This is agent deliberation, never user approval.
   */
  intentionalFindingAcknowledgements?: Record<string, string>;
  /** Bounded fallback when the analyzer has more fail findings than it can return individually. */
  intentionalOmittedFindingsAcknowledgement?: string;
};

export type DiscardAgentCanvasDraftRequest = {
  expectedDraftRevision: number;
};
