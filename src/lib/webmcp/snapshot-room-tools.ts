/// <reference types="webmcp-types" />

import { z } from "zod";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";

import type {
  JazzboardToolFailure,
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpDependencies,
  WebMcpRequest,
} from "./types";

const snapshotScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("room") }).strict(),
  z
    .object({
      kind: z.literal("diagram"),
      diagramId: z.string().min(1).max(128),
      expectedDiagramRevision: z.number().int().positive(),
    })
    .strict(),
]);
const createSnapshotInputSchema = z
  .object({
    expectedRoomRevision: z.number().int().positive(),
    scope: snapshotScopeSchema,
    title: z.string().trim().min(1).max(160).optional(),
    expiresInHours: z.number().int().min(1).max(168).default(24),
  })
  .strict();
const emptyInputSchema = z.object({}).strict();
const revokeSnapshotInputSchema = z
  .object({ snapshotId: z.string().regex(/^snapshot_[0-9a-f-]{36}$/i) })
  .strict();

const CREATE_SNAPSHOT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    expectedRoomRevision: {
      type: "integer",
      minimum: 1,
      description: "Exact room revision; stale creation fails.",
    },
    scope: {
      oneOf: [
        {
          type: "object",
          properties: { kind: { const: "room" } },
          required: ["kind"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { const: "diagram" },
            diagramId: { type: "string", minLength: 1, maxLength: 128 },
            expectedDiagramRevision: { type: "integer", minimum: 1 },
          },
          required: ["kind", "diagramId", "expectedDiagramRevision"],
          additionalProperties: false,
        },
      ],
    },
    title: { type: "string", minLength: 1, maxLength: 160 },
    expiresInHours: {
      type: "integer",
      minimum: 1,
      maximum: 168,
      default: 24,
      description: "Lifetime in hours; maximum seven days.",
    },
  },
  required: ["expectedRoomRevision", "scope"],
  additionalProperties: false,
} as const;

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

function failure(tool: string, error: unknown): JazzboardToolFailure {
  if (error instanceof JazzboardApiError) {
    return { ok: false, tool, error: error.failure };
  }
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "The tool input does not match Jazzboard's private snapshot schema.",
        details: {
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      },
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      ok: false,
      tool,
      error: { code: "TOOL_ABORTED", message: "The WebMCP tool call was cancelled." },
    };
  }
  return {
    ok: false,
    tool,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: error instanceof Error ? error.message : "Jazzboard could not complete this snapshot action.",
    },
  };
}

function defineTool<TSchema extends z.ZodType>(input: {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  schema: TSchema;
  readOnly?: boolean;
  execute: (input: z.output<TSchema>, signal: AbortSignal) => Promise<unknown>;
}): WebMCP.ModelContextTool {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema,
    annotations: {
      ...(input.readOnly ? { readOnlyHint: true } : {}),
      untrustedContentHint: true,
    },
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

function snapshotsUrl(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/agent/snapshots`;
}

export const JAZZBOARD_SNAPSHOT_ROOM_TOOL_NAMES = [
  "create_readonly_snapshot",
  "list_readonly_snapshots",
  "revoke_readonly_snapshot",
] as const;

/**
 * Participant-only private snapshot lifecycle tools. Spectators receive none;
 * the signed guest session and agent route select the server-side actor.
 */
export function createJazzboardSnapshotRoomWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies: JazzboardWebMcpDependencies = {},
): WebMCP.ModelContextTool[] {
  if (binding.role !== "participant") return [];
  const request = dependencies.request ?? (apiRequest as WebMcpRequest);
  const url = snapshotsUrl(binding.roomId);

  return [
    defineTool({
      name: "create_readonly_snapshot",
      title: "Create private read-only snapshot",
      description:
        "Create an immutable exact-token snapshot of this room or one exact Diagram revision. The private path is returned once, expires within seven days, reveals no source identifiers or private image URLs, and grants no room access.",
      inputSchema: CREATE_SNAPSHOT_INPUT_SCHEMA,
      schema: createSnapshotInputSchema,
      async execute(input, signal) {
        return request(url, { method: "POST", body: JSON.stringify(input), signal });
      },
    }),
    defineTool({
      name: "list_readonly_snapshots",
      title: "List my private snapshots",
      description:
        "List only snapshot summaries created by this signed participant in this room. Hashed share tokens cannot be recovered or enumerated.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      schema: emptyInputSchema,
      readOnly: true,
      async execute(_input, signal) {
        return request(url, { method: "GET", signal });
      },
    }),
    defineTool({
      name: "revoke_readonly_snapshot",
      title: "Revoke one private snapshot",
      description:
        "Permanently revoke one exact creator-visible snapshot ID. Unknown, expired, and other creators' IDs return the same generic not-found result.",
      inputSchema: {
        type: "object",
        properties: {
          snapshotId: {
            type: "string",
            pattern: "^snapshot_[0-9a-fA-F-]{36}$",
            description: "Exact snapshot ID, not a token or room ID.",
          },
        },
        required: ["snapshotId"],
        additionalProperties: false,
      },
      schema: revokeSnapshotInputSchema,
      async execute(input, signal) {
        return request(url, { method: "DELETE", body: JSON.stringify(input), signal });
      },
    }),
  ];
}
