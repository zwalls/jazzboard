/// <reference types="webmcp-types" />

import { z } from "zod";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import type {
  AgentEditPolicy,
  AgentEditProposal,
  AgentEditProposalSummary,
  RoomState,
} from "@/lib/domain/types";

import type {
  JazzboardToolFailure,
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpDependencies,
  WebMcpRequest,
} from "./types";

const id = z.string().min(1).max(128);
const listInput = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    status: z.enum(["pending", "applied", "rejected"]).optional(),
    authorParticipantId: id.optional(),
  })
  .strict();
const readInput = z.object({ proposalId: id }).strict();
const emptyInput = z.object({}).strict();

type ListResponse = {
  ok: true;
  policy: AgentEditPolicy;
  proposals: AgentEditProposalSummary[];
  totalMatched: number;
  truncated: boolean;
};
type ReadResponse = { ok: true; proposal: AgentEditProposal };
type PolicyResponse = { ok: true; room: RoomState; policy: AgentEditPolicy; changed: boolean };

function failure(tool: string, error: unknown): JazzboardToolFailure {
  if (error instanceof JazzboardApiError) return { ok: false, tool, error: error.failure };
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "The tool input does not match Jazzboard's agent-review schema.",
        details: { issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
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
      message: error instanceof Error ? error.message : "Jazzboard could not execute this review tool.",
    },
  };
}

function defineTool<TSchema extends z.ZodType>(input: {
  name: string;
  title: string;
  description: string;
  schema: TSchema;
  annotations?: WebMCP.ToolAnnotations;
  execute: (value: z.output<TSchema>, signal: AbortSignal) => Promise<unknown>;
}): WebMCP.ModelContextTool {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema: z.toJSONSchema(input.schema, { io: "input", reused: "ref" }) as WebMCP.ModelContextTool["inputSchema"],
    annotations: input.annotations,
    async execute(rawInput, options): Promise<JazzboardToolResult> {
      try {
        const parsed = input.schema.parse(rawInput);
        const signal = options?.signal ?? new AbortController().signal;
        return { ok: true, tool: input.name, data: await input.execute(parsed, signal) };
      } catch (error) {
        return failure(input.name, error);
      }
    },
  };
}

function reviewUrl(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/review`;
}

export const JAZZBOARD_REVIEW_READ_TOOL_NAMES = [
  "list_agent_edit_proposals",
  "read_agent_edit_proposal",
] as const;
export const JAZZBOARD_REVIEW_MUTATION_TOOL_NAMES = ["enable_agent_review"] as const;
export const JAZZBOARD_REVIEW_TOOL_NAMES = [
  ...JAZZBOARD_REVIEW_READ_TOOL_NAMES,
  ...JAZZBOARD_REVIEW_MUTATION_TOOL_NAMES,
] as const;

export function createJazzboardReviewWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies: JazzboardWebMcpDependencies = {},
): WebMCP.ModelContextTool[] {
  const request = dependencies.request ?? (apiRequest as WebMcpRequest);
  const reads: WebMCP.ModelContextTool[] = [
    defineTool({
      name: "list_agent_edit_proposals",
      title: "List agent edit proposals",
      description:
        "List this room's bounded review queue by status or agent, with purpose, attribution, revisions, and outcome.",
      schema: listInput,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, signal) {
        const query = new URLSearchParams({ limit: String(input.limit) });
        if (input.status) query.set("status", input.status);
        if (input.authorParticipantId) query.set("authorParticipantId", input.authorParticipantId);
        const response = await request<ListResponse>(`${reviewUrl(binding.roomId)}?${query}`, {
          method: "GET",
          signal,
        });
        return {
          policy: response.policy,
          proposals: response.proposals,
          totalMatched: response.totalMatched,
          truncated: response.truncated,
        };
      },
    }),
    defineTool({
      name: "read_agent_edit_proposal",
      title: "Read agent edit proposal",
      description:
        "Read one proposal's request, attribution, baseline revision, intent, status, and human review record.",
      schema: readInput,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, signal) {
        const response = await request<ReadResponse>(
          `${reviewUrl(binding.roomId)}/${encodeURIComponent(input.proposalId)}`,
          { method: "GET", signal },
        );
        return response.proposal;
      },
    }),
  ];
  if (binding.role !== "participant") return reads;

  return [
    ...reads,
    defineTool({
      name: "enable_agent_review",
      title: "Require review for agent edits",
      description:
        "Require review before agent edits apply. Only humans can disable review or decide proposals.",
      schema: emptyInput,
      annotations: { untrustedContentHint: true },
      async execute(_input, signal) {
        const response = await request<PolicyResponse>(
          `/api/rooms/${encodeURIComponent(binding.roomId)}/agent/review/policy`,
          { method: "POST", body: JSON.stringify({ policy: "review" }), signal },
        );
        binding.context.acceptRoom(response.room);
        return { policy: response.policy, changed: response.changed, roomRevision: response.room.roomRevision };
      },
    }),
  ];
}
