/// <reference types="webmcp-types" />

import { afterEach, describe, expect, it, vi } from "vitest";

import { JazzboardApiError } from "@/lib/client/api";
import type { RoomState } from "@/lib/domain/types";
import {
  JAZZBOARD_ARTIFACT_FORMAT,
  JAZZBOARD_ARTIFACT_SCHEMA_URL,
  JAZZBOARD_ARTIFACT_VERSION,
  type JazzboardSemanticArtifactV1,
  type JazzboardTemplateV1,
} from "@/lib/interchange/types";

import {
  createJazzboardInterchangeWebMcpTools,
  JAZZBOARD_INTERCHANGE_PARTICIPANT_TOOL_NAMES,
  JAZZBOARD_INTERCHANGE_SPECTATOR_TOOL_NAMES,
} from "./interchange-tools";
import type { JazzboardToolResult, JazzboardWebMcpBinding, WebMcpRequest } from "./types";

afterEach(() => vi.unstubAllGlobals());

function semanticArtifact(): JazzboardSemanticArtifactV1 {
  return {
    $schema: JAZZBOARD_ARTIFACT_SCHEMA_URL,
    format: JAZZBOARD_ARTIFACT_FORMAT,
    version: JAZZBOARD_ARTIFACT_VERSION,
    kind: "board",
    title: "Portable room",
    description: "Safe room export.",
    source: { roomRevision: 8, diagramId: null, diagramRevision: null },
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    objects: [],
    diagrams: [],
    warnings: [],
  };
}

function template(): JazzboardTemplateV1 {
  return {
    $schema: JAZZBOARD_ARTIFACT_SCHEMA_URL,
    format: JAZZBOARD_ARTIFACT_FORMAT,
    version: JAZZBOARD_ARTIFACT_VERSION,
    kind: "template",
    title: "Authorization flow",
    description: "Reusable authorization flow.",
    source: null,
    bounds: { x: 0, y: 0, width: 200, height: 100 },
    objects: [
      {
        id: "node_gateway",
        kind: "shape",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        rotation: 0,
        zIndex: 0,
        groupId: null,
        shape: "rectangle",
        nodeType: "service",
        nodeMetadata: null,
        label: "Gateway",
        fill: "blue",
        stroke: "black",
      },
    ],
    diagrams: [
      {
        id: "diagram_auth",
        title: "Authorization flow",
        description: "Reusable authorization flow.",
        diagramType: "flow",
        category: "security",
        tags: ["authorization"],
        memberObjectIds: ["node_gateway"],
        connectorIds: [],
      },
    ],
    warnings: [],
  };
}

function binding(
  role: "participant" | "spectator" = "participant",
  acceptRoom = vi.fn(),
): JazzboardWebMcpBinding {
  return {
    roomId: "room/a b",
    participantId: "p_owner",
    role,
    context: {
      getRoom: () => null,
      getSelection: () => [],
      getViewport: () => null,
      getFollowTarget: () => null,
      acceptRoom,
      setFollowTarget: () => undefined,
      setDeclinedSpotlight: () => undefined,
      leaveRoomView: () => undefined,
    },
  };
}

function findTool(tools: WebMCP.ModelContextTool[], name: string): WebMCP.ModelContextTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

async function execute(
  tools: WebMCP.ModelContextTool[],
  name: string,
  input: Record<string, unknown>,
): Promise<JazzboardToolResult> {
  return await findTool(tools, name).execute(input, {
    signal: new AbortController().signal,
  }) as JazzboardToolResult;
}

function exportEnvelope(
  format: "semantic_json" | "mermaid" | "svg" | "template",
  content: string,
) {
  return {
    ok: true as const,
    export: {
      format,
      mediaType: format === "svg" ? "image/svg+xml" : "application/json",
      filename: `artifact.${format}`,
      content,
      warnings: [],
      sourceRoomRevision: 8,
      sourceDiagramRevision: format === "template" ? 3 : null,
    },
  };
}

describe("interchange WebMCP tools", () => {
  it("registers one spectator read and all participant operations with truthful annotations", () => {
    const spectatorTools = createJazzboardInterchangeWebMcpTools(binding("spectator"));
    const participantTools = createJazzboardInterchangeWebMcpTools(binding());

    expect(spectatorTools.map((tool) => tool.name)).toEqual(JAZZBOARD_INTERCHANGE_SPECTATOR_TOOL_NAMES);
    expect(participantTools.map((tool) => tool.name)).toEqual(JAZZBOARD_INTERCHANGE_PARTICIPANT_TOOL_NAMES);
    expect(findTool(spectatorTools, "export_canvas_artifact").annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(findTool(participantTools, "create_diagram_template").annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(findTool(participantTools, "instantiate_diagram_template").annotations).toEqual({
      untrustedContentHint: true,
    });
    expect(findTool(participantTools, "import_mermaid_flowchart").annotations).toEqual({
      untrustedContentHint: true,
    });
    expect(findTool(participantTools, "import_svg_artwork").annotations).toEqual({
      untrustedContentHint: true,
    });
    expect(findTool(participantTools, "instantiate_diagram_template").inputSchema).toMatchObject({
      properties: {
        template: {
          allOf: [
            { $ref: JAZZBOARD_ARTIFACT_SCHEMA_URL },
            { properties: { kind: { const: "template" } }, required: ["kind"] },
          ],
        },
      },
      additionalProperties: false,
    });
  });

  it("exports structured semantic JSON and exact selection SVG through the signed agent route", async () => {
    const request = vi.fn(async (url: string) => {
      if (url.includes("format=svg")) return exportEnvelope("svg", "<svg></svg>");
      return exportEnvelope("semantic_json", JSON.stringify(semanticArtifact()));
    }) as unknown as WebMcpRequest;
    const tools = createJazzboardInterchangeWebMcpTools(binding("spectator"), { request });

    const semantic = await execute(tools, "export_canvas_artifact", {});
    expect(semantic).toMatchObject({
      ok: true,
      data: {
        format: "semantic_json",
        sourceRoomRevision: 8,
        artifact: { format: "jazzboard.semantic", kind: "board" },
      },
    });
    expect(request).toHaveBeenLastCalledWith(
      "/api/rooms/room%2Fa%20b/agent/artifacts?format=semantic_json&scope=room",
      { method: "GET", signal: expect.any(AbortSignal) },
    );

    const svg = await execute(tools, "export_canvas_artifact", {
      format: "svg",
      scope: { kind: "selection", objectIds: ["node a", "connector/1"] },
    });
    expect(svg).toMatchObject({ ok: true, data: { format: "svg", content: "<svg></svg>" } });
    expect(request).toHaveBeenLastCalledWith(
      "/api/rooms/room%2Fa%20b/agent/artifacts?format=svg&scope=selection&objectId=node+a&objectId=connector%2F1",
      { method: "GET", signal: expect.any(AbortSignal) },
    );
  });

  it("returns a parsed, audit-free template without mutating local room state", async () => {
    const acceptRoom = vi.fn();
    const request = vi.fn(async () => exportEnvelope("template", JSON.stringify(template()))) as unknown as WebMcpRequest;
    const tools = createJazzboardInterchangeWebMcpTools(binding("participant", acceptRoom), { request });

    const result = await execute(tools, "create_diagram_template", { diagramId: "diagram/auth" });

    expect(result).toMatchObject({
      ok: true,
      data: {
        template: { kind: "template", diagrams: [{ id: "diagram_auth" }] },
        sourceRoomRevision: 8,
        sourceDiagramRevision: 3,
      },
    });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/artifacts?format=template&scope=diagram&diagramId=diagram%2Fauth",
      { method: "GET", signal: expect.any(AbortSignal) },
    );
    expect(acceptRoom).not.toHaveBeenCalled();
  });

  it("instantiates with an exact revision and accepts only the returned authoritative room", async () => {
    const acceptRoom = vi.fn();
    const authoritativeRoom = {
      id: "room/a b",
      roomRevision: 9,
      objects: { node_new: { id: "node_new", kind: "shape" } },
      diagrams: { diagram_new: { id: "diagram_new" } },
    } as unknown as RoomState;
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      room: authoritativeRoom,
      changedObjectIds: ["node_new"],
      changedDiagramIds: ["diagram_new"],
      membershipObjectIds: ["node_new"],
      idMap: {
        objects: { node_gateway: "node_new" },
        diagrams: { diagram_auth: "diagram_new" },
        groups: {},
      },
      bounds: { x: 500, y: 700, width: 200, height: 100 },
      warnings: [],
      activity: { id: "activity_new" },
      proposal: null,
    })) as unknown as WebMcpRequest;
    const tools = createJazzboardInterchangeWebMcpTools(binding("participant", acceptRoom), { request });
    const input = {
      expectedRoomRevision: 8,
      template: template(),
      origin: { x: 500, y: 700 },
      intent: "Reuse an approved flow",
      summary: "Added the authorization Diagram",
    };

    const result = await execute(tools, "instantiate_diagram_template", input);

    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/artifacts",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    const sent = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(sent.body))).toEqual(input);
    expect(acceptRoom).toHaveBeenCalledWith(authoritativeRoom);
    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "applied",
        roomRevision: 9,
        changedObjectIds: ["node_new"],
        idMap: { objects: { node_gateway: "node_new" } },
        objects: [{ id: "node_new" }],
        diagrams: [{ id: "diagram_new" }],
      },
    });
  });

  it("imports Mermaid as native objects and returns a compact exact-revision inspection receipt", async () => {
    const acceptRoom = vi.fn();
    const acceptAgentDraft = vi.fn();
    const authoritativeRoom = {
      id: "room/a b",
      roomRevision: 9,
      objects: {
        node_api: { id: "node_api", kind: "shape", revision: 1 },
        node_db: { id: "node_db", kind: "shape", revision: 1 },
        edge_api_db: { id: "edge_api_db", kind: "connector", revision: 1 },
      },
      diagrams: {
        diagram_import: {
          id: "diagram_import",
          revision: 1,
          memberObjectIds: ["node_api", "node_db"],
          connectorIds: ["edge_api_db"],
        },
      },
    } as unknown as RoomState;
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      room: authoritativeRoom,
      changedObjectIds: ["node_api", "node_db", "edge_api_db"],
      changedDiagramIds: ["diagram_import"],
      membershipObjectIds: ["node_api", "node_db", "edge_api_db"],
      idMap: {
        nodes: { api: "node_api", db: "node_db" },
        edges: { "edge-0": "edge_api_db" },
        groups: {},
        diagramId: "diagram_import",
      },
      counts: { nodes: 2, edges: 1, groups: 0, diagrams: 1 },
      bounds: { x: 400, y: 600, width: 700, height: 240 },
      warnings: ["Flat subgraphs preserve membership and palette without enclosing boxes."],
      activity: { id: "activity_import" },
      proposal: null,
      presentation: {
        id: "draft_mermaid_reveal",
        roomId: authoritativeRoom.id,
        revision: 1,
        status: "presenting",
      },
    })) as unknown as WebMcpRequest;
    const toolBinding = binding("participant", acceptRoom);
    toolBinding.context.acceptAgentDraft = acceptAgentDraft;
    const tools = createJazzboardInterchangeWebMcpTools(toolBinding, { request });
    const input = {
      expectedRoomRevision: 8,
      source: "flowchart LR\n  api[API] --> db[(Database)]",
      title: "Service path",
      origin: { x: 400, y: 600 },
      grouping: "boxed",
      intent: "Import the supplied architecture",
    };

    const result = await execute(tools, "import_mermaid_flowchart", input);

    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/artifacts",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    const sent = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(sent.body))).toEqual({ action: "import_mermaid_flowchart", ...input });
    expect(acceptRoom).toHaveBeenCalledWith(authoritativeRoom);
    expect(acceptAgentDraft).toHaveBeenCalledWith(expect.objectContaining({
      id: "draft_mermaid_reveal",
      status: "presenting",
    }));
    expect(acceptAgentDraft.mock.invocationCallOrder[0]).toBeLessThan(
      acceptRoom.mock.invocationCallOrder[0]!,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "applied",
        roomRevision: 9,
        idMap: {
          nodes: { api: "node_api", db: "node_db" },
          edges: { "edge-0": "edge_api_db" },
          diagramId: "diagram_import",
        },
        counts: { nodes: 2, edges: 1, groups: 0, diagrams: 1 },
        bounds: { x: 400, y: 600, width: 700, height: 240 },
        nativeEditable: true,
        geometryInspectionStatus: "not_performed",
        recommendedInspection: {
          tool: "inspect_canvas_scope",
          input: {
            scope: { kind: "diagram", diagramId: "diagram_import", expectedRevision: 1 },
            representation: "overview",
          },
        },
        activityId: "activity_import",
      },
    });
    expect((result as { data?: Record<string, unknown> }).data).not.toHaveProperty("objects");
    expect((result as { data?: Record<string, unknown> }).data).not.toHaveProperty("diagrams");
    expect((result as { data?: Record<string, unknown> }).data).not.toHaveProperty("changedObjectIds");
    expect((result as { data?: Record<string, unknown> }).data).not.toHaveProperty("membershipObjectIds");
    expect((result as { data?: Record<string, unknown> }).data).not.toHaveProperty("activity");
  });

  it("imports SVG once as native paths with exact source IDs, bounds, timing, and next inspection", async () => {
    const acceptRoom = vi.fn();
    const acceptAgentDraft = vi.fn();
    const authoritativeRoom = {
      id: "room/a b",
      roomRevision: 9,
      objects: {
        path_petals: { id: "path_petals", kind: "path", revision: 1 },
        path_center: { id: "path_center", kind: "path", revision: 1 },
      },
      diagrams: {
        diagram_svg: {
          id: "diagram_svg",
          revision: 1,
          memberObjectIds: ["path_petals", "path_center"],
          connectorIds: [],
        },
      },
    } as unknown as RoomState;
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      room: authoritativeRoom,
      changedObjectIds: ["path_petals", "path_center"],
      changedDiagramIds: ["diagram_svg"],
      membershipObjectIds: ["path_petals", "path_center"],
      idMap: {
        parts: [
          { sourceIndex: 0, sourceName: "petals", nativeObjectId: "path_petals" },
          { sourceIndex: 1, sourceName: "center", nativeObjectId: "path_center" },
        ],
      },
      counts: { parts: 2, paths: 2 },
      bounds: { x: 400, y: 600, width: 180, height: 220 },
      warnings: [],
      importTiming: { parseDurationMs: 4, transactionDurationMs: 7, totalServerDurationMs: 12 },
      activity: { id: "activity_svg_import" },
      proposal: null,
      presentation: {
        id: "draft_svg_reveal",
        roomId: authoritativeRoom.id,
        revision: 1,
        status: "presenting",
      },
    })) as unknown as WebMcpRequest;
    const toolBinding = binding("participant", acceptRoom);
    toolBinding.context.acceptAgentDraft = acceptAgentDraft;
    const tools = createJazzboardInterchangeWebMcpTools(toolBinding, { request });
    const input = {
      expectedRoomRevision: 8,
      source: '<svg width="18" height="22" viewBox="0 0 18 22"><path id="petals" d="M0 0 L18 0 Z"/><circle id="center" cx="9" cy="11" r="3"/></svg>',
      title: "Editable flower",
      origin: { x: 400, y: 600 },
      intent: "Import the supplied vector flower",
    };

    const result = await execute(tools, "import_svg_artwork", input);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/artifacts",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    const sent = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(sent.body))).toEqual({ action: "import_svg_artwork", ...input });
    expect(acceptRoom).toHaveBeenCalledWith(authoritativeRoom);
    expect(acceptAgentDraft).toHaveBeenCalledWith(expect.objectContaining({
      id: "draft_svg_reveal",
      status: "presenting",
    }));
    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "applied",
        roomRevision: 9,
        idMap: {
          parts: [
            { sourceIndex: 0, sourceName: "petals", nativeObjectId: "path_petals" },
            { sourceIndex: 1, sourceName: "center", nativeObjectId: "path_center" },
          ],
        },
        counts: { parts: 2, paths: 2 },
        bounds: { x: 400, y: 600, width: 180, height: 220 },
        nativeEditable: true,
        geometryInspectionStatus: "not_performed",
        importTiming: { parseDurationMs: 4, transactionDurationMs: 7, totalServerDurationMs: 12 },
        recommendedInspection: {
          tool: "inspect_canvas_scope",
          input: {
            scope: { kind: "diagram", diagramId: "diagram_svg", expectedRevision: 1 },
            representation: "overview",
          },
        },
        executionTiming: {
          handlerDurationMs: expect.any(Number),
          measurement: "request_start_to_result_preparation",
          includes: ["svg_parse", "revision_guarded_transaction"],
          excludes: ["webmcp_transport", "pixel_render", "pixel_inspection"],
        },
        activityId: "activity_svg_import",
        proposal: null,
      },
    });
  });

  it("returns review-mode SVG proposals without claiming an inspection happened", async () => {
    const acceptRoom = vi.fn();
    const acceptAgentDraft = vi.fn();
    const reviewRoom = {
      id: "room/a b",
      roomRevision: 8,
      objects: {},
      diagrams: {},
    } as unknown as RoomState;
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "proposed",
      room: reviewRoom,
      changedObjectIds: ["path_review"],
      changedDiagramIds: [],
      membershipObjectIds: [],
      idMap: {
        parts: [{ sourceIndex: 0, sourceName: "mark", nativeObjectId: "path_review" }],
      },
      counts: { parts: 1, paths: 1 },
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      warnings: [],
      importTiming: { parseDurationMs: 2, transactionDurationMs: 3, totalServerDurationMs: 6 },
      activity: null,
      proposal: { id: "proposal_svg" },
      presentation: null,
    })) as unknown as WebMcpRequest;
    const bound = binding("participant", acceptRoom);
    bound.context.acceptAgentDraft = acceptAgentDraft;
    const tools = createJazzboardInterchangeWebMcpTools(bound, { request });

    const result = await execute(tools, "import_svg_artwork", {
      expectedRoomRevision: 8,
      source: '<svg width="10" height="10" viewBox="0 0 10 10"><rect id="mark" width="10" height="10"/></svg>',
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(acceptRoom).toHaveBeenCalledWith(reviewRoom);
    expect(acceptAgentDraft).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "proposed",
        roomRevision: 8,
        nativeEditable: true,
        geometryInspectionStatus: "not_performed",
        recommendedInspection: null,
        proposal: { id: "proposal_svg" },
      },
    });
  });

  it.each([
    ["REVISION_CONFLICT", "after_refresh"],
    ["INVALID_OPERATION", "after_correction"],
    ["IDEMPOTENCY_CONFLICT", "verify_before_retry"],
  ])("preserves SVG %s failures without installing speculative state", async (code, retry) => {
    const acceptRoom = vi.fn();
    const acceptAgentDraft = vi.fn();
    const request = vi.fn(async () => {
      throw new JazzboardApiError(409, { code, message: "Import rejected", details: { currentRoomRevision: 9 } });
    }) as unknown as WebMcpRequest;
    const bound = binding("participant", acceptRoom);
    bound.context.acceptAgentDraft = acceptAgentDraft;
    const result = await execute(createJazzboardInterchangeWebMcpTools(bound, { request }), "import_svg_artwork", {
      expectedRoomRevision: 8, source: '<svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    });
    expect(result).toMatchObject({
      ok: false, tool: "import_svg_artwork",
      error: { code, details: { currentRoomRevision: 9 }, recovery: { retry } },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(acceptRoom).not.toHaveBeenCalled();
    expect(acceptAgentDraft).not.toHaveBeenCalled();
  });

  it("keeps the SVG mutation identity on transport retry and surfaces the committed replay receipt", async () => {
    const acceptRoom = vi.fn();
    const requests: RequestInit[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(init!);
      if (requests.length === 1) throw new TypeError("Response lost after commit");
      return new Response(JSON.stringify({
        ok: false,
        error: {
          code: "MUTATION_OUTCOME_UNKNOWN", message: "The mutation already committed; refresh authority.",
          details: { replayed: true, outcome: "applied", committedRoomRevision: 9 },
        },
      }), { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await execute(createJazzboardInterchangeWebMcpTools(binding("participant", acceptRoom)), "import_svg_artwork", {
      expectedRoomRevision: 8, source: '<svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstKey = new Headers(requests[0].headers).get("idempotency-key");
    expect(firstKey).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Headers(requests[1].headers).get("idempotency-key")).toBe(firstKey);
    expect(requests[1].body).toBe(requests[0].body);
    expect(result).toMatchObject({
      ok: false, tool: "import_svg_artwork",
      error: {
        code: "MUTATION_OUTCOME_UNKNOWN", details: { replayed: true, outcome: "applied", committedRoomRevision: 9 },
        recovery: {
          retry: "verify_before_retry",
          instructions: expect.stringMatching(/confirms the SVG import was applied.*Do not import the source again/),
        },
      },
    });
    expect(acceptRoom).not.toHaveBeenCalled();
  });

  it("recovers a proven review proposal without claiming its artwork was applied", async () => {
    const details = { replayed: true, outcome: "proposed", committedRoomRevision: 8, verificationUnavailable: true };
    const request = vi.fn(async () => {
      throw new JazzboardApiError(503, { code: "MUTATION_OUTCOME_UNKNOWN", message: "Original receipt unavailable", details });
    }) as unknown as WebMcpRequest;
    const acceptRoom = vi.fn();
    const result = await execute(createJazzboardInterchangeWebMcpTools(binding("participant", acceptRoom), { request }), "import_svg_artwork", {
      expectedRoomRevision: 8, source: "<svg/>",
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "MUTATION_OUTCOME_UNKNOWN", message: "Original receipt unavailable", details,
        recovery: {
          retry: "verify_before_retry",
          instructions: expect.stringMatching(/proposal was saved.*does not confirm applied artwork.*Do not import the source again/),
          suggestedTools: ["list_agent_edit_proposals", "read_agent_edit_proposal"],
        },
      },
    });
    expect(acceptRoom).not.toHaveBeenCalled();
  });

  it.each([
    { replayed: false, verificationUnavailable: true },
    { replayed: true, committedRoomRevision: 9 },
    { replayed: true, outcome: "applied", committedRoomRevision: -1 },
    { replayed: true, outcome: "applied", committedRoomRevision: Number.NaN },
  ])("does not claim an SVG commit without a complete verified replay receipt: %j", async (details) => {
    const request = vi.fn(async () => {
      throw new JazzboardApiError(503, { code: "MUTATION_OUTCOME_UNKNOWN", message: "Commit unverified", details });
    }) as unknown as WebMcpRequest;
    const result = await execute(createJazzboardInterchangeWebMcpTools(binding(), { request }), "import_svg_artwork", {
      expectedRoomRevision: 8, source: "<svg/>",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { details, recovery: { retry: "verify_before_retry", instructions: expect.stringMatching(/may have succeeded/) } },
    });
    expect(JSON.stringify(result)).not.toContain("receipt confirms");
  });

  it.each([
    ["zero revision", { expectedRoomRevision: 0 }],
    ["fractional revision", { expectedRoomRevision: 1.5 }],
    ["empty source", { source: "" }],
    ["oversized source", { source: "x".repeat(65_537) }],
    ["nonfinite origin", { origin: { x: Number.NaN, y: 0 } }],
    ["unknown field", { unexpected: true }],
  ])("rejects invalid SVG input before requesting a mutation: %s", async (_label, invalid) => {
    const request = vi.fn() as unknown as WebMcpRequest;
    const result = await execute(createJazzboardInterchangeWebMcpTools(binding(), { request }), "import_svg_artwork", {
      expectedRoomRevision: 8, source: "<svg/>", ...invalid,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects PNG, malformed templates, and stale-looking inputs locally before any request", async () => {
    const request = vi.fn() as unknown as WebMcpRequest;
    const tools = createJazzboardInterchangeWebMcpTools(binding(), { request });

    await expect(execute(tools, "export_canvas_artifact", { format: "png", scope: { kind: "room" } }))
      .resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    await expect(execute(tools, "instantiate_diagram_template", {
      expectedRoomRevision: 0,
      template: { ...template(), objects: [{ kind: "image", url: "https://private.invalid/x.png" }] },
      origin: { x: 0, y: 0 },
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    await expect(execute(tools, "import_mermaid_flowchart", {
      expectedRoomRevision: 8,
      source: "",
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    await expect(execute(tools, "import_svg_artwork", {
      source: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0 L10 10"/></svg>',
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });
});
