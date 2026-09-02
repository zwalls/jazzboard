/// <reference types="webmcp-types" />

import { z } from "zod";

import type { CanvasBounds, DiagramNodeType, ObjectKind } from "@/lib/domain/types";
import { renderDiagramMermaid } from "@/lib/interchange/mermaid";
import { serializeJazzboardArtifact } from "@/lib/interchange/project";
import { renderJazzboardSvg } from "@/lib/interchange/svg";
import {
  JazzboardInterchangeError,
  type JazzboardArtifactV1,
  type PortableCanvasObject,
} from "@/lib/interchange/types";
import type { PublicReadonlySnapshot } from "@/lib/server/snapshot-service";

import type { JazzboardToolFailure, JazzboardToolResult } from "./types";
import { withActionableRecovery } from "./actionable-failure";

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const emptyInputSchema = z.object({}).strict();
const regionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();
const queryInputSchema = z
  .object({
    text: z.string().trim().min(1).max(500).optional(),
    kinds: z.array(z.enum(["text", "shape", "connector", "image", "draw", "path"])).max(6).optional(),
    nodeTypes: z
      .array(z.enum(["service", "component", "requirement", "decision", "open_question"]))
      .max(5)
      .optional(),
    diagramId: z.string().min(1).max(128).optional(),
    region: regionSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
const readDiagramInputSchema = z.object({ diagramId: z.string().min(1).max(128) }).strict();
const exportInputSchema = z
  .object({
    format: z.enum(["semantic_json", "mermaid", "svg"]),
    diagramId: z.string().min(1).max(128).optional(),
  })
  .strict();

const QUERY_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Case-insensitive label, content, alternative-text, or connector-label search.",
    },
    kinds: {
      type: "array",
      items: { enum: ["text", "shape", "connector", "image", "draw", "path"] },
      maxItems: 5,
    },
    nodeTypes: {
      type: "array",
      items: { enum: ["service", "component", "requirement", "decision", "open_question"] },
      maxItems: 5,
    },
    diagramId: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Restrict results to one exact first-class Diagram ID in this snapshot.",
    },
    region: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number", exclusiveMinimum: 0 },
        height: { type: "number", exclusiveMinimum: 0 },
      },
      required: ["x", "y", "width", "height"],
      additionalProperties: false,
    },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
  additionalProperties: false,
} as const;

type SnapshotToolBinding = { snapshot: PublicReadonlySnapshot };

class SnapshotToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SnapshotToolError";
  }
}

function failure(tool: string, error: unknown): JazzboardToolFailure {
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "The tool input does not match Jazzboard's read-only snapshot schema.",
        details: {
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      },
    };
  }
  if (error instanceof SnapshotToolError || error instanceof JazzboardInterchangeError) {
    return {
      ok: false,
      tool,
      error: { code: error.code, message: error.message, details: error.details },
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
      message: error instanceof Error ? error.message : "Jazzboard could not read this snapshot.",
    },
  };
}

function defineTool<TSchema extends z.ZodType>(input: {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  schema: TSchema;
  execute: (input: z.output<TSchema>, signal: AbortSignal) => Promise<unknown> | unknown;
}): WebMCP.ModelContextTool {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(rawInput, options): Promise<JazzboardToolResult> {
      try {
        const parsed = input.schema.parse(rawInput);
        const signal = options?.signal ?? new AbortController().signal;
        if (signal.aborted) throw new DOMException("Tool call aborted.", "AbortError");
        return { ok: true, tool: input.name, data: await input.execute(parsed, signal) };
      } catch (error) {
        return withActionableRecovery(failure(input.name, error));
      }
    },
  };
}

function searchableText(object: PortableCanvasObject): string {
  if (object.kind === "text") return object.content;
  if (object.kind === "shape") return object.label;
  if (object.kind === "connector") return object.label;
  if (object.kind === "image") return object.alt;
  return "";
}

function intersects(object: PortableCanvasObject, region: CanvasBounds): boolean {
  return (
    object.x < region.x + region.width &&
    object.x + object.width > region.x &&
    object.y < region.y + region.height &&
    object.y + object.height > region.y
  );
}

function fileStem(title: string): string {
  return (
    title
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 80) || "jazzboard-snapshot"
  );
}

function requireSemanticArtifact(artifact: JazzboardArtifactV1) {
  if (artifact.kind === "template") {
    throw new SnapshotToolError("SNAPSHOT_INVALID", "A read-only snapshot cannot contain a template artifact.");
  }
  return artifact;
}

export const JAZZBOARD_SNAPSHOT_WEBMCP_TOOL_NAMES = [
  "read_snapshot_state",
  "query_snapshot_objects",
  "read_snapshot_diagram",
  "export_snapshot_artifact",
] as const;

/** All tools on a public snapshot are local, read-only projections of its frozen artifact. */
export function createJazzboardSnapshotWebMcpTools(
  binding: SnapshotToolBinding,
): WebMCP.ModelContextTool[] {
  const artifact = structuredClone(requireSemanticArtifact(binding.snapshot.artifact));

  return [
    defineTool({
      name: "read_snapshot_state",
      title: "Read frozen Jazzboard snapshot",
      description:
        "Read this exact-token, immutable Jazzboard snapshot with semantic object IDs, first-class Diagram metadata, revisions, bounds, and privacy-safe attribution. This page exposes no room session or mutation capability.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      schema: emptyInputSchema,
      execute() {
        return {
          snapshot: {
            title: binding.snapshot.title,
            createdAt: binding.snapshot.createdAt,
            expiresAt: binding.snapshot.expiresAt,
            creator: binding.snapshot.creator,
          },
          artifact: structuredClone(artifact),
        };
      },
    }),
    defineTool({
      name: "query_snapshot_objects",
      title: "Query frozen snapshot objects",
      description:
        "Find a bounded set of immutable snapshot objects by semantic text, object kind, explicit node classification, exact Diagram membership, or canvas region without loading unrelated board content.",
      inputSchema: QUERY_INPUT_JSON_SCHEMA,
      schema: queryInputSchema,
      execute(input) {
        let candidates = artifact.objects;
        if (input.diagramId) {
          const diagram = artifact.diagrams.find((candidate) => candidate.id === input.diagramId);
          if (!diagram) {
            throw new SnapshotToolError(
              "DIAGRAM_NOT_FOUND",
              `Diagram ${input.diagramId} is not present in this snapshot.`,
              { diagramId: input.diagramId },
            );
          }
          const memberIds = new Set([...diagram.memberObjectIds, ...diagram.connectorIds]);
          candidates = candidates.filter((object) => memberIds.has(object.id));
        }
        const kinds = input.kinds ? new Set<ObjectKind>(input.kinds) : null;
        const nodeTypes = input.nodeTypes ? new Set<DiagramNodeType>(input.nodeTypes) : null;
        const text = input.text?.toLocaleLowerCase();
        const matches = candidates.filter((object) => {
          if (kinds && !kinds.has(object.kind)) return false;
          if (nodeTypes && (object.kind !== "shape" || !object.nodeType || !nodeTypes.has(object.nodeType))) {
            return false;
          }
          if (text && !searchableText(object).toLocaleLowerCase().includes(text)) return false;
          if (input.region && !intersects(object, input.region)) return false;
          return true;
        });
        return {
          totalMatched: matches.length,
          returned: Math.min(matches.length, input.limit),
          objects: structuredClone(matches.slice(0, input.limit)),
          frozen: true,
        };
      },
    }),
    defineTool({
      name: "read_snapshot_diagram",
      title: "Read a snapshot Diagram",
      description:
        "Read one first-class Diagram by its exact stable ID, including its title, purpose, category, tags, revision, bounds, members, and semantic connectors. Unrelated snapshot objects are omitted.",
      inputSchema: {
        type: "object",
        properties: { diagramId: { type: "string", minLength: 1, maxLength: 128 } },
        required: ["diagramId"],
        additionalProperties: false,
      },
      schema: readDiagramInputSchema,
      execute(input) {
        const diagram = artifact.diagrams.find((candidate) => candidate.id === input.diagramId);
        if (!diagram) {
          throw new SnapshotToolError(
            "DIAGRAM_NOT_FOUND",
            `Diagram ${input.diagramId} is not present in this snapshot.`,
            { diagramId: input.diagramId },
          );
        }
        const memberIds = new Set(diagram.memberObjectIds);
        const connectorIds = new Set(diagram.connectorIds);
        return {
          diagram: structuredClone(diagram),
          members: structuredClone(artifact.objects.filter((object) => memberIds.has(object.id))),
          connectors: structuredClone(artifact.objects.filter((object) => connectorIds.has(object.id))),
          frozen: true,
        };
      },
    }),
    defineTool({
      name: "export_snapshot_artifact",
      title: "Export frozen Jazzboard snapshot",
      description:
        "Return this immutable snapshot as canonical semantic JSON, safe deterministic SVG, or directive-free Mermaid for one exact Diagram. The tool returns content and does not download, mutate, or publish anything.",
      inputSchema: {
        type: "object",
        properties: {
          format: { enum: ["semantic_json", "mermaid", "svg"] },
          diagramId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            description: "Required for Mermaid when the snapshot contains more than one Diagram.",
          },
        },
        required: ["format"],
        additionalProperties: false,
      },
      schema: exportInputSchema,
      execute(input) {
        const stem = fileStem(binding.snapshot.title);
        if (input.format === "semantic_json") {
          return {
            format: input.format,
            filename: `${stem}.jazzboard.json`,
            mimeType: "application/vnd.jazzboard.semantic+json",
            content: serializeJazzboardArtifact(artifact),
            warnings: artifact.warnings,
          };
        }
        if (input.format === "mermaid") {
          const rendered = renderDiagramMermaid(artifact, input.diagramId);
          return {
            format: input.format,
            filename: `${stem}.mmd`,
            mimeType: "text/vnd.mermaid",
            content: rendered.source,
            warnings: rendered.warnings,
          };
        }
        const rendered = renderJazzboardSvg(artifact, { maxWidth: 2_400, maxHeight: 1_600 });
        return {
          format: input.format,
          filename: `${stem}.svg`,
          mimeType: "image/svg+xml",
          content: rendered.svg,
          width: rendered.width,
          height: rendered.height,
          warnings: rendered.warnings,
        };
      },
    }),
  ];
}
