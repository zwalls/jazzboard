/// <reference types="webmcp-types" />

import { z } from "zod";

import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import type { AgentDraftPresentationStatus } from "@/lib/canvas/agent-draft-reveal";
import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import type { AgentEditProposalSummary, RoomActivitySummary, RoomState } from "@/lib/domain/types";

import type {
  JazzboardToolFailure,
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpDependencies,
  WebMcpRequest,
} from "./types";
import { withActionableRecovery } from "./actionable-failure";

const draftId = z.string().regex(/^draft_[A-Za-z0-9_-]{1,120}$/);
const readDraftsInput = z.object({ draftId: draftId.optional() }).strict();
const finishDraftInput = z
  .object({
    draftId,
    expectedDraftRevision: z.number().int().positive(),
    action: z.enum(["commit", "discard"]),
  })
  .strict();

const READ_DRAFTS_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    draftId: { type: "string", pattern: "^draft_[A-Za-z0-9_-]{1,120}$" },
  },
} as const;

const FINISH_DRAFT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["draftId", "expectedDraftRevision", "action"],
  properties: {
    draftId: { type: "string", pattern: "^draft_[A-Za-z0-9_-]{1,120}$" },
    expectedDraftRevision: { type: "integer", minimum: 1 },
    action: { enum: ["commit", "discard"] },
  },
} as const;

type DraftResponse = {
  ok: true;
  draft: AgentCanvasDraftSnapshot;
  serverTime?: number;
};

type DraftListResponse = {
  ok: true;
  drafts: AgentCanvasDraftSnapshot[];
  serverTime: number;
};

type DraftCommitMutation = {
  room: RoomState;
  changedObjectIds: string[];
  changedDiagramIds: string[];
  membershipObjectIds: string[];
  positions?: Array<{ objectId: string; x: number; y: number }>;
  outcome: "applied" | "proposed";
  activity: RoomActivitySummary | null;
  proposal: AgentEditProposalSummary | null;
};

type FinishDraftResponse = {
  ok: true;
  outcome?: "applied" | "proposed";
  sidecarStatus?: "settled" | "cleanup_pending";
  room?: RoomState;
  draft?: AgentCanvasDraftSnapshot | null;
  mutation?: DraftCommitMutation;
  draftId?: string;
  draftRevision?: number;
  discarded?: true;
  revision?: number;
  changedObjectIds?: string[];
  changedDiagramIds?: string[];
  membershipObjectIds?: string[];
  positions?: Array<{ objectId: string; x: number; y: number }>;
  activity?: RoomActivitySummary | null;
  proposal?: AgentEditProposalSummary | null;
  [key: string]: unknown;
};

function readableDraftsUrl(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/drafts`;
}

function agentDraftsUrl(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/agent/drafts`;
}

function exactReadableDraftUrl(roomId: string, candidateDraftId: string): string {
  return `${readableDraftsUrl(roomId)}/${encodeURIComponent(candidateDraftId)}`;
}

function exactAgentDraftUrl(roomId: string, candidateDraftId: string): string {
  return `${agentDraftsUrl(roomId)}/${encodeURIComponent(candidateDraftId)}`;
}

function exactAgentDraftKeepaliveUrl(roomId: string, candidateDraftId: string): string {
  return `${exactAgentDraftUrl(roomId, candidateDraftId)}/keepalive`;
}

function exactPresentationStatus(
  binding: JazzboardWebMcpBinding,
  candidateDraftId: string,
  requestedRevision: number,
): AgentDraftPresentationStatus {
  return binding.context.getAgentDraftPresentation?.(candidateDraftId, requestedRevision) ?? {
    source: "client-local",
    draftId: candidateDraftId,
    requestedRevision,
    observedRevision: null,
    state: "unavailable",
    complete: false,
    objectCount: 0,
    completedObjectCount: 0,
  };
}

function presentationStatus(
  binding: JazzboardWebMcpBinding,
  draft: AgentCanvasDraftSnapshot,
): AgentDraftPresentationStatus {
  return exactPresentationStatus(binding, draft.id, draft.revision);
}

const PRESENTATION_WAIT_TIMEOUT_MS = 12_000;
const PRESENTATION_POLL_INTERVAL_MS = 80;

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("The WebMCP tool call was cancelled.", "AbortError"));
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("The WebMCP tool call was cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitForExactPresentation(
  binding: JazzboardWebMcpBinding,
  candidateDraftId: string,
  requestedRevision: number,
  signal: AbortSignal,
): Promise<AgentDraftPresentationStatus> {
  const deadline = Date.now() + PRESENTATION_WAIT_TIMEOUT_MS;
  let presentation = exactPresentationStatus(binding, candidateDraftId, requestedRevision);
  while (
    !presentation.complete &&
    presentation.state !== "superseded" &&
    Date.now() < deadline
  ) {
    await waitForDelay(Math.min(PRESENTATION_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 1)), signal);
    presentation = exactPresentationStatus(binding, candidateDraftId, requestedRevision);
  }
  return presentation;
}

function failure(tool: string, error: unknown): JazzboardToolFailure {
  if (error instanceof JazzboardApiError) return { ok: false, tool, error: error.failure };
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "The tool input does not match Jazzboard's draft schema.",
        details: {
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
    };
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return { ok: false, tool, error: { code: "TOOL_ABORTED", message: "The WebMCP tool call was cancelled." } };
  }
  return {
    ok: false,
    tool,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: error instanceof Error ? error.message : "Jazzboard could not execute this draft tool.",
    },
  };
}

function defineTool<TSchema extends z.ZodType>(input: {
  name: string;
  title: string;
  description: string;
  schema: TSchema;
  inputSchema: WebMCP.ModelContextTool["inputSchema"];
  annotations: WebMCP.ToolAnnotations;
  execute: (value: z.output<TSchema>, signal: AbortSignal) => Promise<unknown>;
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
        return {
          ok: true,
          tool: input.name,
          data: await input.execute(
            parsed,
            options?.signal ?? new AbortController().signal,
          ),
        };
      } catch (error) {
        return withActionableRecovery(failure(input.name, error));
      }
    },
  };
}

export const JAZZBOARD_DRAFT_READ_TOOL_NAMES = ["read_canvas_drafts"] as const;
export const JAZZBOARD_DRAFT_MUTATION_TOOL_NAMES = ["finish_canvas_draft"] as const;
export const JAZZBOARD_DRAFT_TOOL_NAMES = [
  ...JAZZBOARD_DRAFT_READ_TOOL_NAMES,
  ...JAZZBOARD_DRAFT_MUTATION_TOOL_NAMES,
] as const;

/** Role-scoped lifecycle tools for genuine, server-persisted agent draft previews. */
export function createJazzboardDraftWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies: Pick<JazzboardWebMcpDependencies, "request" | "waitForDraftPresentation"> = {},
): WebMCP.ModelContextTool[] {
  const request = dependencies.request ?? (apiRequest as WebMcpRequest);
  const waitForDraftPresentation = dependencies.waitForDraftPresentation ?? (
    (candidateDraftId: string, revision: number, signal: AbortSignal) =>
      waitForExactPresentation(binding, candidateDraftId, revision, signal)
  );
  const reads: WebMCP.ModelContextTool[] = [
    defineTool({
      name: "read_canvas_drafts",
      title: "Read canvas drafts",
      description:
        "Read active agent drafts in this authorized room, or one exact draft by ID, including preview objects, stable temporary references, and browser-local presentation state. presentation.state=complete means both every object reveal and the exact revision's closing inspection motion have finished.",
      schema: readDraftsInput,
      inputSchema: READ_DRAFTS_INPUT_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, signal) {
        if (input.draftId) {
          const response = await request<DraftResponse>(
            exactReadableDraftUrl(binding.roomId, input.draftId),
            { method: "GET", signal },
          );
          binding.context.acceptAgentDraft?.(response.draft);
          return {
            draft: response.draft,
            serverTime: response.serverTime,
            presentation: presentationStatus(binding, response.draft),
          };
        }
        const response = await request<DraftListResponse>(readableDraftsUrl(binding.roomId), {
          method: "GET",
          signal,
        });
        response.drafts.forEach((draft) => binding.context.acceptAgentDraft?.(draft));
        return {
          drafts: response.drafts,
          serverTime: response.serverTime,
          presentations: response.drafts.map((draft) => presentationStatus(binding, draft)),
        };
      },
    }),
  ];

  if (binding.role !== "participant") return reads;

  return [
    ...reads,
    defineTool({
      name: "finish_canvas_draft",
      title: "Finish a canvas draft",
      description:
        "Complete one exact progressive draft. Commit is autonomous and needs no extra user confirmation: draft delivery is visible construction, not review. It keeps the draft alive, waits inside this call for the exact revision's presentation, then applies atomically. If presentation cannot complete, no authoritative canvas mutation is sent and the draft remains recoverable. Discard only for intentional cancellation. outcome=proposed means actual room review and is not applied.",
      schema: finishDraftInput,
      inputSchema: FINISH_DRAFT_INPUT_SCHEMA,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        if (input.action === "commit") {
          const keepalive = await request<DraftResponse>(
            exactAgentDraftKeepaliveUrl(binding.roomId, input.draftId),
            {
              method: "POST",
              body: JSON.stringify({ expectedDraftRevision: input.expectedDraftRevision }),
              signal,
            },
          );
          binding.context.acceptAgentDraft?.(keepalive.draft);
          const presentation = await waitForDraftPresentation(
            input.draftId,
            input.expectedDraftRevision,
            signal,
          );
          if (presentation.state !== "complete" || !presentation.complete) {
            const reasonCode = presentation.state === "superseded"
              ? "PRESENTATION_SUPERSEDED"
              : "PRESENTATION_TIMEOUT";
            return {
              draftId: input.draftId,
              draftRevision: input.expectedDraftRevision,
              action: input.action,
              outcome: "not_applied",
              reasonCode,
              authoritativeMutationApplied: false,
              authoritativeMutationRequestSent: false,
              keepaliveSent: true,
              presentation,
              nextStep:
                presentation.state === "superseded"
                  ? "Read the latest draft revision, preserve its cumulative candidate, and finish that exact revision. Do not bypass progressive delivery with a direct transaction."
                  : "The owned draft remains alive. Retry finish_canvas_draft for this same exact revision; do not bypass progressive delivery with a direct transaction.",
            };
          }
        }
        const url = exactAgentDraftUrl(binding.roomId, input.draftId);
        const response = await request<FinishDraftResponse>(
          input.action === "commit" ? `${url}/commit` : url,
          {
            method: input.action === "commit" ? "POST" : "DELETE",
            body: JSON.stringify({ expectedDraftRevision: input.expectedDraftRevision }),
            signal,
          },
        );
        const authoritativeRoom = response.room ?? response.mutation?.room;
        const outcome = response.outcome ?? response.mutation?.outcome;
        if (authoritativeRoom) binding.context.acceptRoom(authoritativeRoom);
        const removedRevision = typeof response.revision === "number"
          ? response.revision
          : typeof response.draftRevision === "number"
            ? response.draftRevision
            : undefined;
        if (input.action === "commit" && outcome === "proposed") {
          if (response.draft) binding.context.acceptAgentDraft?.(response.draft);
        } else if (
          input.action === "commit" &&
          outcome === "applied" &&
          authoritativeRoom &&
          binding.context.retireCommittedAgentDraft
        ) {
          binding.context.retireCommittedAgentDraft(
            input.draftId,
            removedRevision ?? input.expectedDraftRevision,
            authoritativeRoom.roomRevision,
          );
        } else {
          binding.context.removeAgentDraft?.(input.draftId, removedRevision);
        }
        return {
          draftId: response.draftId ?? input.draftId,
          action: input.action,
          outcome,
          sidecarStatus: response.sidecarStatus,
          discarded: response.discarded,
          draft: response.draft,
          roomRevision: authoritativeRoom?.roomRevision,
          changedObjectIds: response.changedObjectIds ?? response.mutation?.changedObjectIds,
          changedDiagramIds: response.changedDiagramIds ?? response.mutation?.changedDiagramIds,
          membershipObjectIds:
            response.membershipObjectIds ?? response.mutation?.membershipObjectIds,
          positions: response.positions ?? response.mutation?.positions,
          activity: response.activity ?? response.mutation?.activity,
          proposal: response.proposal ?? response.mutation?.proposal,
          nextStep:
            input.action === "discard"
              ? "The draft is removed; no canvas mutation was applied."
              : response.sidecarStatus === "cleanup_pending"
                ? outcome === "proposed"
                  ? "The room's review policy created the proposal, but draft-sidecar cleanup is pending. Report awaiting human review and do not replay or discard; authorized reads will reconcile cleanup."
                  : "The authoritative canvas mutation applied, but non-authoritative draft-sidecar cleanup is pending. Treat the canvas result as committed, continue inspection, and do not replay; authorized reads will reconcile cleanup."
              : outcome === "proposed"
                ? "The room's true review policy converted the commit into a proposal. It is not applied; report it as awaiting human review and do not claim publication or ask for a second agent-side commit."
                : "The draft was applied atomically to the authoritative canvas. Continue with exact-revision semantic and pixel inspection; no user confirmation was required.",
        };
      },
    }),
  ];
}
