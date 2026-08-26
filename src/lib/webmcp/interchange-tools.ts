/// <reference types="webmcp-types" />

import { z } from "zod";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import type { AgentEditProposalSummary, RoomActivitySummary, RoomState } from "@/lib/domain/types";
import { jazzboardTemplateV1Schema, parseJazzboardArtifactV1, parseJazzboardTemplateV1 } from "@/lib/interchange/schemas";
import { JAZZBOARD_ARTIFACT_SCHEMA_URL } from "@/lib/interchange/types";
import type {
  JazzboardArtifactWarning,
  JazzboardTemplateV1,
  TemplateIdMap,
} from "@/lib/interchange/types";

import type {
  JazzboardToolFailure,
  JazzboardToolResult,
  JazzboardWebMcpBinding,
  JazzboardWebMcpDependencies,
  WebMcpRequest,
} from "./types";

const id = z.string().min(1).max(128);
const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("room") }).strict(),
  z.object({ kind: z.literal("diagram"), diagramId: id }).strict(),
  z.object({ kind: z.literal("selection"), objectIds: z.array(id).min(1).max(500) }).strict(),
]);
const exportArtifactInput = z
  .object({
    format: z.enum(["semantic_json", "mermaid", "svg"]).default("semantic_json"),
    scope: scope.default({ kind: "room" }),
  })
  .strict();
const createTemplateInput = z.object({ diagramId: id }).strict();
const instantiateTemplateInput = z
  .object({
    expectedRoomRevision: z.number().int().positive(),
    template: jazzboardTemplateV1Schema,
    origin: point,
    baseZIndex: z.number().int().min(0).max(1_000_000).optional(),
    intent: z.string().trim().min(1).max(1_000).optional(),
    summary: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
const instantiateTemplateDescriptorInput = z
  .object({
    expectedRoomRevision: z.number().int().positive(),
    template: z.unknown(),
    origin: point,
    baseZIndex: z.number().int().min(0).max(1_000_000).optional(),
    intent: z.string().trim().min(1).max(1_000).optional(),
    summary: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

function compactInstantiateTemplateInputSchema(): WebMCP.ModelContextTool["inputSchema"] {
  const generated = z.toJSONSchema(instantiateTemplateDescriptorInput, {
    io: "input",
    reused: "ref",
  }) as Record<string, unknown> & { properties: Record<string, unknown> };
  return {
    ...generated,
    properties: {
      ...generated.properties,
      template: {
        description:
          "A strict Jazzboard v1 create-only Diagram template, normally returned by create_diagram_template.",
        allOf: [
          { $ref: JAZZBOARD_ARTIFACT_SCHEMA_URL },
          {
            type: "object",
            properties: { kind: { const: "template" } },
            required: ["kind"],
          },
        ],
      },
    },
  };
}

type ArtifactExportEnvelope = {
  ok: true;
  export: {
    format: "semantic_json" | "mermaid" | "svg" | "template";
    mediaType: string;
    filename: string;
    content: string;
    warnings: JazzboardArtifactWarning[];
    sourceRoomRevision: number;
    sourceDiagramRevision: number | null;
  };
};

type InstantiateTemplateResponse = {
  ok: true;
  outcome: "applied" | "proposed";
  room: RoomState;
  changedObjectIds: string[];
  changedDiagramIds: string[];
  membershipObjectIds: string[];
  idMap: TemplateIdMap;
  bounds: { x: number; y: number; width: number; height: number };
  warnings: JazzboardArtifactWarning[];
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
        message: "The tool input does not match Jazzboard's portable artifact schema.",
        details: {
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      },
    };
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
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
      message: error instanceof Error ? error.message : "Jazzboard could not complete this artifact action.",
    },
  };
}

function defineTool<TSchema extends z.ZodType>(input: {
  name: string;
  title: string;
  description: string;
  schema: TSchema;
  inputSchema?: WebMCP.ModelContextTool["inputSchema"];
  readOnly?: boolean;
  execute: (value: z.output<TSchema>, signal: AbortSignal) => Promise<unknown>;
}): WebMCP.ModelContextTool {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema
      ?? z.toJSONSchema(input.schema, { io: "input", reused: "ref" }) as WebMCP.ModelContextTool["inputSchema"],
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

function artifactsUrl(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/agent/artifacts`;
}

function exportUrl(
  roomId: string,
  format: "semantic_json" | "mermaid" | "svg" | "template",
  exportScope: z.output<typeof scope>,
): string {
  const query = new URLSearchParams({ format, scope: exportScope.kind });
  if (exportScope.kind === "diagram") query.set("diagramId", exportScope.diagramId);
  if (exportScope.kind === "selection") {
    for (const objectId of exportScope.objectIds) query.append("objectId", objectId);
  }
  return `${artifactsUrl(roomId)}?${query.toString()}`;
}

export const JAZZBOARD_INTERCHANGE_SPECTATOR_TOOL_NAMES = ["export_canvas_artifact"] as const;
export const JAZZBOARD_INTERCHANGE_READ_TOOL_NAMES = [
  "export_canvas_artifact",
  "create_diagram_template",
] as const;
export const JAZZBOARD_INTERCHANGE_MUTATION_TOOL_NAMES = ["instantiate_diagram_template"] as const;
export const JAZZBOARD_INTERCHANGE_PARTICIPANT_TOOL_NAMES = [
  ...JAZZBOARD_INTERCHANGE_READ_TOOL_NAMES,
  ...JAZZBOARD_INTERCHANGE_MUTATION_TOOL_NAMES,
] as const;
export const JAZZBOARD_INTERCHANGE_TOOL_NAMES = JAZZBOARD_INTERCHANGE_PARTICIPANT_TOOL_NAMES;

export function createJazzboardInterchangeWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies: JazzboardWebMcpDependencies = {},
): WebMCP.ModelContextTool[] {
  const request = dependencies.request ?? (apiRequest as WebMcpRequest);
  const exportTool = defineTool({
    name: "export_canvas_artifact",
    title: "Export semantic canvas artifact",
    description:
      "Export this authorized room, one Diagram, or an exact selection as redacted semantic JSON, safe Mermaid, or fixed-vocabulary SVG. Omits room/session secrets, presence, leases, colors, and private image URLs. PNG is client-derived from safe SVG.",
    schema: exportArtifactInput,
    readOnly: true,
    async execute(input, signal) {
      const response = await request<ArtifactExportEnvelope>(
        exportUrl(binding.roomId, input.format, input.scope),
        { method: "GET", signal },
      );
      const common = {
        format: response.export.format,
        mediaType: response.export.mediaType,
        filename: response.export.filename,
        warnings: response.export.warnings,
        sourceRoomRevision: response.export.sourceRoomRevision,
        sourceDiagramRevision: response.export.sourceDiagramRevision,
      };
      return input.format === "semantic_json"
        ? { ...common, artifact: parseJazzboardArtifactV1(JSON.parse(response.export.content)) }
        : { ...common, content: response.export.content };
    },
  });

  if (binding.role !== "participant") return [exportTool];

  const createTemplateTool = defineTool({
    name: "create_diagram_template",
    title: "Create reusable Diagram template",
    description:
      "Read one exact authorized Diagram as a strict create-only template. Preserves semantic node types, lifecycle metadata, groups, connectors, layout, and Diagram metadata; strips revisions, attribution, room/session state, and media. Image-bearing Diagrams are rejected.",
    schema: createTemplateInput,
    readOnly: true,
    async execute(input, signal) {
      const response = await request<ArtifactExportEnvelope>(
        exportUrl(binding.roomId, "template", { kind: "diagram", diagramId: input.diagramId }),
        { method: "GET", signal },
      );
      return {
        format: response.export.format,
        mediaType: response.export.mediaType,
        filename: response.export.filename,
        template: parseJazzboardTemplateV1(JSON.parse(response.export.content)),
        warnings: response.export.warnings,
        sourceRoomRevision: response.export.sourceRoomRevision,
        sourceDiagramRevision: response.export.sourceDiagramRevision,
      };
    },
  });

  const instantiateTemplateTool = defineTool({
    name: "instantiate_diagram_template",
    title: "Instantiate reusable Diagram template",
    description:
      "Instantiate a strict template at an origin through the normal agent-edit policy using the exact room revision. Live mode applies one atomic create-only transaction with fresh IDs and attribution; review mode returns a human proposal. Any conflict rejects all changes.",
    schema: instantiateTemplateInput,
    inputSchema: compactInstantiateTemplateInputSchema(),
    async execute(input, signal) {
      const response = await request<InstantiateTemplateResponse>(artifactsUrl(binding.roomId), {
        method: "POST",
        body: JSON.stringify(input),
        signal,
      });
      binding.context.acceptRoom(response.room);
      return {
        outcome: response.outcome,
        roomRevision: response.room.roomRevision,
        changedObjectIds: response.changedObjectIds,
        changedDiagramIds: response.changedDiagramIds,
        membershipObjectIds: response.membershipObjectIds,
        idMap: response.idMap,
        bounds: response.bounds,
        warnings: response.warnings,
        activity: response.activity,
        proposal: response.proposal,
        objects: response.changedObjectIds.flatMap((objectId) => response.room.objects[objectId] ?? []),
        diagrams: response.changedDiagramIds.flatMap((diagramId) => response.room.diagrams?.[diagramId] ?? []),
      };
    },
  });

  return [exportTool, createTemplateTool, instantiateTemplateTool];
}

export type { JazzboardTemplateV1 };
