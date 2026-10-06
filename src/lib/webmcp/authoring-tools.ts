/// <reference types="webmcp-types" />
import { z } from "zod";
import {
  fitSemanticText,
  measureSemanticText,
  semanticTextMeasurer,
  SemanticTextMeasurementError,
} from "@/lib/canvas/semantic-text-measurement";
import { standaloneAuthoringContract } from "./tools";
import { transactionOperationContract } from "./semantic-tools";
import { withActionableRecovery } from "./actionable-failure";
import type { JazzboardToolResult } from "./types";

export const JAZZBOARD_AUTHORING_READ_TOOL_NAMES = ["get_canvas_tool_schema", "measure_canvas_text"] as const;

const discoveryInput = z.object({
  toolName: z.string().min(1).max(128),
  operation: z.string().min(1).max(64).optional(),
}).strict();
const measurementInput = z.object({
  content: z.string().min(1).max(20_000),
  width: z.number().finite().positive().max(100_000).default(320),
  height: z.number().finite().positive().max(100_000).optional(),
  size: z.enum(["s", "m", "l", "xl"]).default("m"),
  align: z.enum(["start", "middle", "end"]).default("start"),
}).strict();

function readTool<T extends z.ZodType>(name: string, description: string, schema: T,
  execute: (input: z.output<T>, signal: AbortSignal) => Promise<unknown>): WebMCP.ModelContextTool {
  return {
    name, title: name === "get_canvas_tool_schema" ? "Discover one canvas tool contract" : "Measure canvas text before creating it",
    description, inputSchema: z.toJSONSchema(schema, { io: "input" }), annotations: { readOnlyHint: true },
    async execute(raw, options): Promise<JazzboardToolResult> {
      try {
        const input = schema.parse(raw);
        const signal = options?.signal ?? new AbortController().signal;
        if (signal.aborted) throw new DOMException("Authoring read cancelled.", "AbortError");
        return { ok: true, tool: name, data: await execute(input, signal) };
      } catch (error) {
        return withActionableRecovery({ ok: false, tool: name, error: {
          code: error instanceof z.ZodError ? "INVALID_TOOL_INPUT" : error instanceof SemanticTextMeasurementError ? error.code
            : error instanceof DOMException && error.name === "AbortError" ? "TOOL_ABORTED" : "TOOL_EXECUTION_FAILED",
          message: error instanceof Error ? error.message : "Authoring read failed.", details: { stateChanged: false },
        } });
      }
    },
  };
}

export function createJazzboardAuthoringReadTools(getTools: () => readonly WebMCP.ModelContextTool[]): WebMCP.ModelContextTool[] {
  return [
    readTool("get_canvas_tool_schema",
      "Fetch one registered tool's schema. For apply_canvas_transaction, provide operation for its runtime-generated exact field contract and validated example. Cross-field rules are listed separately. Discovery grants no permissions.",
      discoveryInput, async (input) => {
        const tool = getTools().find((candidate) => candidate.name === input.toolName);
        if (!tool) throw new Error(`Tool ${input.toolName} is not registered for this role.`);
        if (input.operation && input.toolName !== "apply_canvas_transaction") throw new Error("operation is only valid for apply_canvas_transaction.");
        const contract = input.operation ? transactionOperationContract(input.operation) : standaloneAuthoringContract(input.toolName);
        if (input.operation && !contract) throw new Error(`Unknown transaction operation ${input.operation}.`);
        return { toolName: input.toolName, ...(input.operation ? { operation: input.operation } : {}),
          schemaSource: contract ? "runtime_validator" : "registered_descriptor",
          ...(contract ?? { inputSchema: tool.inputSchema, example: null, constraints: ["The runtime validator, current revisions, leases, permissions and review policy remain authoritative."] }),
          ...(input.toolName === "apply_canvas_transaction" && !input.operation ? { nextStep: "Request one operation by name for its exact fields and an example, rather than guessing from the compact registration schema." } : {}) };
      }),
    readTool("measure_canvas_text",
      "Read loaded-font text bounds before mutation. Omit height to fit content (width is a minimum); provide height to inspect explicit bounds. Same lines/font/baselines as canvas and PNG. Ink bounds are object-local and unrotated; six-line renderer cap still applies.",
      measurementInput, async (input, signal) => {
        const measure = await semanticTextMeasurer(signal);
        const dimensions = input.height === undefined ? fitSemanticText(input.content, input.width, input.size, input.align, measure)
          : { width: input.width, height: input.height };
        const { lines, ...measurement } = measureSemanticText(input.content, dimensions.width, dimensions.height, input.size, input.align, measure);
        return { ...dimensions, ...measurement, lineCount: lines.length, coordinateSpace: "object_local_unrotated", visualInspectionStatus: "not_performed" };
      }),
  ];
}
