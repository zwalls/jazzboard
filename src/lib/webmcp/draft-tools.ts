/// <reference types="webmcp-types" />

import { z } from "zod";

import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import type { AgentEditProposalSummary, RoomActivitySummary, RoomState } from "@/lib/domain/types";

import type {
  JazzboardToolFailure,
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpDependencies,
  WebMcpRequest,
} from "./types";

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
        return failure(input.name, error);
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
  dependencies: Pick<JazzboardWebMcpDependencies, "request"> = {},
): WebMCP.ModelContextTool[] {
  const request = dependencies.request ?? (apiRequest as WebMcpRequest);
  const reads: WebMCP.ModelContextTool[] = [
    defineTool({
      name: "read_canvas_drafts",
      title: "Read canvas drafts",
      description:
        "Read active agent drafts in this authorized room, or one exact draft by ID, including preview objects and stable temporary references.",
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
          return { draft: response.draft, serverTime: response.serverTime };
        }
        const response = await request<DraftListResponse>(readableDraftsUrl(binding.roomId), {
          method: "GET",
          signal,
        });
        response.drafts.forEach((draft) => binding.context.acceptAgentDraft?.(draft));
        return { drafts: response.drafts, serverTime: response.serverTime };
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
        "Commit one exact draft atomically, or discard it, using its latest draft revision. A review-mode commit may return proposed instead of applied.",
      schema: finishDraftInput,
      inputSchema: FINISH_DRAFT_INPUT_SCHEMA,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
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
        } else {
          binding.context.removeAgentDraft?.(input.draftId, removedRevision);
        }
        return {
          draftId: response.draftId ?? input.draftId,
          action: input.action,
          outcome,
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
              : outcome === "proposed"
                ? "The draft became a review proposal and is not yet applied to the canvas."
                : "The draft was applied atomically to the authoritative canvas.",
        };
      },
    }),
  ];
}
