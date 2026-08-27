/// <reference types="webmcp-types" />

import { z } from "zod";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import type { AgentEditProposalSummary, RoomActivitySummary, RoomState } from "@/lib/domain/types";

import type {
  JazzboardToolFailure,
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpDependencies,
  WebMcpRequest,
} from "./types";

const id = z.string().min(1).max(128);
const listActivityInput = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    beforeRoomRevision: z.number().int().positive().optional(),
    actorKind: z.enum(["human", "agent"]).optional(),
    objectId: id.optional(),
    diagramId: id.optional(),
  })
  .strict();
const readActivityInput = z.object({ activityId: id }).strict();
const objectExpectation = z.discriminatedUnion("state", [
  z.object({ objectId: id, state: z.literal("present"), expectedRevision: z.number().int().positive(), leaseId: id.optional() }).strict(),
  z.object({ objectId: id, state: z.literal("absent") }).strict(),
]);
const diagramExpectation = z.discriminatedUnion("state", [
  z.object({ diagramId: id, state: z.literal("present"), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ diagramId: id, state: z.literal("absent") }).strict(),
]);
const revertActivityInput = z
  .object({
    activityId: id,
    objectExpectations: z.array(objectExpectation).max(500),
    diagramExpectations: z.array(diagramExpectation).max(200),
    intent: z.string().trim().min(1).max(1_000).optional(),
    summary: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const objectIds = input.objectExpectations.map((item) => item.objectId);
    if (new Set(objectIds).size !== objectIds.length) {
      context.addIssue({ code: "custom", message: "Object expectations must be unique." });
    }
    const diagramIds = input.diagramExpectations.map((item) => item.diagramId);
    if (new Set(diagramIds).size !== diagramIds.length) {
      context.addIssue({ code: "custom", message: "Diagram expectations must be unique." });
    }
  });

type ActivityListResponse = {
  ok: true;
  activities: RoomActivitySummary[];
  hasMore: boolean;
  nextBeforeRoomRevision: number | null;
};

type ActivityReadResponse = { ok: true; activity: RoomActivitySummary };
type ActivityRevertResponse = {
  ok: true;
  room: RoomState;
  changedObjectIds: string[];
  changedDiagramIds: string[];
  membershipObjectIds: string[];
  outcome: "applied" | "proposed";
  activity: RoomActivitySummary | null;
  proposal: AgentEditProposalSummary | null;
};

function failure(tool: string, error: unknown): JazzboardToolFailure {
  if (error instanceof JazzboardApiError) return { ok: false, tool, error: error.failure };
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "The tool input does not match Jazzboard's activity-review schema.",
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
      message: error instanceof Error ? error.message : "Jazzboard could not execute this activity tool.",
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
    inputSchema: compactInputSchema(input.schema),
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

function compactInputSchema(schema: z.ZodType): WebMCP.ModelContextTool["inputSchema"] {
  const generated = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  const compact = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(compact);
      return;
    }
    const record = value as Record<string, unknown>;
    delete record.$schema;
    if (record.maximum === Number.MAX_SAFE_INTEGER) delete record.maximum;
    if (record.type === "integer" && record.exclusiveMinimum === 0) {
      delete record.exclusiveMinimum;
      record.minimum = 1;
    }
    if (record.const !== undefined || Array.isArray(record.enum)) delete record.type;
    Object.values(record).forEach(compact);
  };
  compact(generated);
  return generated;
}

function activityCollectionUrl(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/activity`;
}

function activityUrl(roomId: string, activityId: string): string {
  return `${activityCollectionUrl(roomId)}/${encodeURIComponent(activityId)}`;
}

export const JAZZBOARD_ACTIVITY_READ_TOOL_NAMES = ["list_activity", "read_activity"] as const;
export const JAZZBOARD_ACTIVITY_MUTATION_TOOL_NAMES = ["revert_activity"] as const;
export const JAZZBOARD_ACTIVITY_TOOL_NAMES = [
  ...JAZZBOARD_ACTIVITY_READ_TOOL_NAMES,
  ...JAZZBOARD_ACTIVITY_MUTATION_TOOL_NAMES,
] as const;

export function createJazzboardActivityWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies: JazzboardWebMcpDependencies = {},
): WebMCP.ModelContextTool[] {
  const request = dependencies.request ?? (apiRequest as WebMcpRequest);
  const reads: WebMCP.ModelContextTool[] = [
    defineTool({
      name: "list_activity",
      title: "List recent room activity",
      description:
        "List authorized activity summaries by actor, object, Diagram, or revision cursor, including exact post-state guards.",
      schema: listActivityInput,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, signal) {
        const query = new URLSearchParams({ limit: String(input.limit) });
        if (input.beforeRoomRevision !== undefined) query.set("beforeRoomRevision", String(input.beforeRoomRevision));
        if (input.actorKind) query.set("actorKind", input.actorKind);
        if (input.objectId) query.set("objectId", input.objectId);
        if (input.diagramId) query.set("diagramId", input.diagramId);
        const response = await request<ActivityListResponse>(`${activityCollectionUrl(binding.roomId)}?${query}`, {
          method: "GET",
          signal,
        });
        return {
          activities: response.activities,
          hasMore: response.hasMore,
          nextBeforeRoomRevision: response.nextBeforeRoomRevision,
        };
      },
    }),
    defineTool({
      name: "read_activity",
      title: "Read one room activity",
      description:
        "Read one activity by stable ID with attribution, intent, affected object and Diagram IDs, bounds, and the exact guards required for a safe revert.",
      schema: readActivityInput,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, signal) {
        const response = await request<ActivityReadResponse>(activityUrl(binding.roomId, input.activityId), {
          method: "GET",
          signal,
        });
        return response.activity;
      },
    }),
  ];
  if (binding.role !== "participant") return reads;

  return [
    ...reads,
    defineTool({
      name: "revert_activity",
      title: "Safely revert one room activity",
      description:
        "Compensate one activity without rewriting history. Supply every read_activity guard; conflicts fail atomically and review mode returns `proposed`.",
      schema: revertActivityInput,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const { activityId, intent, summary, ...expectations } = input;
        const metadata = intent || summary ? { intent, summary } : undefined;
        const response = await request<ActivityRevertResponse>(
          `${activityUrl(binding.roomId, activityId).replace("/activity/", "/agent/activity/")}/revert`,
          {
            method: "POST",
            body: JSON.stringify({ ...expectations, metadata }),
            signal,
          },
        );
        binding.context.acceptRoom(response.room);
        return {
          outcome: response.outcome,
          roomRevision: response.room.roomRevision,
          changedObjectIds: response.changedObjectIds,
          changedDiagramIds: response.changedDiagramIds,
          membershipObjectIds: response.membershipObjectIds,
          activity: response.activity,
          proposal: response.proposal,
          objects: response.changedObjectIds.flatMap((objectId) => response.room.objects[objectId] ?? []),
          diagrams: response.changedDiagramIds.flatMap((diagramId) => response.room.diagrams?.[diagramId] ?? []),
        };
      },
    }),
  ];
}
