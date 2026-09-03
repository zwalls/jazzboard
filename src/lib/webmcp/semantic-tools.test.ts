/// <reference types="webmcp-types" />

import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";

import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import { applyLayoutCommand, applySemanticTransaction, normalizeRoomSemanticState } from "@/lib/domain/engine";
import type { ActorRef, CanvasObject, Diagram, Participant, RoomState, Viewport } from "@/lib/domain/types";

import {
  createJazzboardSemanticWebMcpTools,
  JAZZBOARD_SEMANTIC_MUTATION_TOOL_NAMES,
  JAZZBOARD_SEMANTIC_READ_TOOL_NAMES,
  JAZZBOARD_SEMANTIC_TOOL_NAMES,
} from "./semantic-tools";
import type { JazzboardToolResult, JazzboardWebMcpBinding, JazzboardWebMcpContext, WebMcpRequest } from "./types";

const NOW = 5_000_000;

function actor(kind: "human" | "agent" = "human"): ActorRef {
  return { participantId: "alice", displayName: "Alice", color: "blue", kind };
}

function participant(): Participant {
  const presence = { cursor: null, viewport: null, lastSeenAt: NOW, activity: null };
  return {
    participantId: "alice",
    displayName: "Alice",
    color: "blue",
    role: "participant",
    joinedAt: NOW,
    lastSeenAt: NOW,
    connected: true,
    agentActive: false,
    human: { ...presence },
    agent: { ...presence },
  };
}

function node(
  id: string,
  label: string,
  nodeType: "service" | "component" | "decision" | "open_question",
  x: number,
): CanvasObject {
  return {
    id,
    kind: "shape",
    x,
    y: 100,
    width: 200,
    height: 100,
    rotation: 0,
    zIndex: 1,
    revision: 1,
    groupId: null,
    diagramIds: ["architecture"],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(),
    lastEditedBy: actor(),
    shape: "rectangle",
    nodeType,
    label,
    fill: "blue",
    stroke: "blue",
  };
}

function connector(): CanvasObject {
  return {
    id: "api-db",
    kind: "connector",
    x: 200,
    y: 150,
    width: 200,
    height: 1,
    rotation: 0,
    zIndex: 0,
    revision: 1,
    groupId: null,
    diagramIds: ["architecture"],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(),
    lastEditedBy: actor(),
    start: { x: 200, y: 150, objectId: "api" },
    end: { x: 400, y: 150, objectId: "db" },
    direction: "end",
    label: "writes",
    color: "black",
  };
}

function drawing(id = "freehand-note"): CanvasObject {
  return {
    id,
    kind: "draw",
    x: 700,
    y: 100,
    width: 120,
    height: 80,
    rotation: 0,
    zIndex: 2,
    revision: 1,
    groupId: null,
    diagramIds: ["architecture"],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(),
    lastEditedBy: actor(),
    points: [{ x: 0, y: 0 }, { x: 120, y: 80 }],
    color: "black",
    size: "m",
  };
}

function diagram(): Diagram {
  return {
    id: "architecture",
    title: "Checkout architecture",
    description: "Request path",
    diagramType: "architecture",
    category: "checkout",
    tags: ["critical"],
    memberObjectIds: ["api", "db"],
    connectorIds: ["api-db"],
    bounds: { x: 0, y: 0, width: 600, height: 200 },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(),
    lastEditedBy: actor(),
  };
}

function room(objects: CanvasObject[] = [node("api", "Checkout API", "service", 0), node("db", "Orders DB", "component", 400), connector()]): RoomState {
  return normalizeRoomSemanticState({
    id: "room/a b",
    code: "1234",
    title: "Architecture",
    roomRevision: 7,
    createdAt: NOW,
    updatedAt: NOW,
    participants: { alice: participant() },
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: objects.length ? { architecture: diagram() } : {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  });
}

function agentDraft(
  overrides: Partial<AgentCanvasDraftSnapshot> = {},
): AgentCanvasDraftSnapshot {
  return {
    schemaVersion: 1,
    id: "draft_architecture",
    roomId: "room/a b",
    ownerParticipantId: "alice",
    author: actor("agent"),
    revision: 2,
    baselineRoomRevision: 7,
    status: "active",
    temporaryReferences: { apiNode: "node_stable" },
    previewObjects: [],
    previewDiagrams: [],
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 60_000,
    hardExpiresAt: NOW + 600_000,
    ...overrides,
  };
}

function fixture(initialRoom = room(), role: "participant" | "spectator" = "participant") {
  let current = initialRoom;
  const accepted: RoomState[] = [];
  const acceptedDrafts: AgentCanvasDraftSnapshot[] = [];
  const context: JazzboardWebMcpContext = {
    getRoom: () => current,
    getSelection: () => [],
    getViewport: () => ({ x: 0, y: 0, width: 1_200, height: 800, zoom: 1 } satisfies Viewport),
    getFollowTarget: () => null,
    setFollowTarget: () => undefined,
    setDeclinedSpotlight: () => undefined,
    leaveRoomView: () => undefined,
    acceptRoom(next) {
      current = next;
      accepted.push(next);
    },
    acceptAgentDraft(next) {
      acceptedDrafts.push(next);
    },
  };
  const binding: JazzboardWebMcpBinding = {
    roomId: "room/a b",
    participantId: "alice",
    role,
    context,
  };
  return { binding, context, accepted, acceptedDrafts, getRoom: () => current };
}

function tool(tools: WebMCP.ModelContextTool[], name: string) {
  const match = tools.find((candidate) => candidate.name === name);
  if (!match) throw new Error(`Missing ${name}`);
  return match;
}

type JsonSchema = {
  type?: string;
  description?: string;
  const?: unknown;
  enum?: unknown[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  minProperties?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  propertyNames?: JsonSchema;
  dependentRequired?: Record<string, string[]>;
};

function schemaFor(tools: WebMCP.ModelContextTool[], name: string): JsonSchema {
  return tool(tools, name).inputSchema as unknown as JsonSchema;
}

function operationSchema(schema: JsonSchema, op: string): JsonSchema {
  const items = schema.properties?.operations?.items;
  const variants = items?.oneOf ?? items?.anyOf ?? [];
  const match = variants.find((variant) => variant.properties?.op?.const === op);
  if (match) {
    return {
      ...items,
      ...match,
      required: [...(items?.required ?? []), ...(match.required ?? [])],
    };
  }
  const conditional = items?.allOf?.find(
    (variant) => variant.if?.properties?.op?.const === op,
  );
  if (!conditional) {
    if (items?.properties?.op?.enum?.includes(op)) return items;
    throw new Error(`Missing JSON Schema operation ${op}`);
  }
  return {
    ...items,
    required: [...(items?.required ?? []), ...(conditional.then?.required ?? [])],
  };
}

async function execute(toolToRun: WebMCP.ModelContextTool, input: Record<string, unknown>) {
  return (await toolToRun.execute(input, { signal: new AbortController().signal })) as JazzboardToolResult;
}

describe("role-scoped semantic tool registration", () => {
  it("exposes all semantic tools to participants and only untrusted read-only tools to spectators", () => {
    const participantTools = createJazzboardSemanticWebMcpTools(fixture().binding);
    const spectatorTools = createJazzboardSemanticWebMcpTools(fixture(room(), "spectator").binding);

    expect(participantTools.map((candidate) => candidate.name)).toEqual(JAZZBOARD_SEMANTIC_TOOL_NAMES);
    expect(spectatorTools.map((candidate) => candidate.name)).toEqual(JAZZBOARD_SEMANTIC_READ_TOOL_NAMES);
    for (const candidate of spectatorTools) {
      expect(candidate.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    }
    for (const name of JAZZBOARD_SEMANTIC_MUTATION_TOOL_NAMES) {
      expect(tool(participantTools, name).annotations).toEqual({ untrustedContentHint: true });
    }
  });

  it("generates caller-input JSON Schemas where defaulted fields remain optional", () => {
    const tools = createJazzboardSemanticWebMcpTools(fixture().binding);

    expect(schemaFor(tools, "query_objects").required ?? []).not.toContain("limit");
    expect(schemaFor(tools, "query_objects").properties?.detail).toEqual({ enum: ["summary", "full"] });
    expect(schemaFor(tools, "read_neighborhood").properties?.detail).toEqual({ enum: ["summary", "full"] });
    expect(schemaFor(tools, "find_diagrams").required ?? []).not.toContain("limit");
    expect(schemaFor(tools, "analyze_diagram_layout").required).toEqual([
      "diagramId",
      "expectedDiagramRevision",
    ]);

    const layoutRequired = schemaFor(tools, "layout_objects").required ?? [];
    expect(layoutRequired).toEqual(expect.arrayContaining(["layout", "targets"]));
    for (const field of ["direction", "primaryGap", "secondaryGap"]) expect(layoutRequired).not.toContain(field);
    expect(schemaFor(tools, "layout_objects").dependentRequired).toEqual({
      diagramId: ["expectedDiagramRevision"],
      expectedDiagramRevision: ["diagramId"],
    });
    expect(schemaFor(tools, "layout_objects").properties?.responseDetail)
      .toEqual({ enum: ["concise", "detailed"] });

    const createDiagramRequired = schemaFor(tools, "create_diagram").required ?? [];
    expect(createDiagramRequired).toEqual(["title"]);
    for (const field of ["diagramId", "description", "diagramType", "category", "tags", "memberObjectIds", "connectorIds"]) {
      expect(createDiagramRequired).not.toContain(field);
    }

    const transactionSchema = schemaFor(tools, "apply_canvas_transaction");
    expect(transactionSchema.additionalProperties).toBe(false);
    expect(transactionSchema.properties).not.toHaveProperty("expectedRoomRevision");
    expect(transactionSchema.properties?.responseDetail).toEqual({ enum: ["concise", "detailed"] });
    expect(transactionSchema.properties?.operations?.items?.properties?.routing).toMatchObject({
      type: "object",
      description: expect.stringMatching(/curved.*bend.*elbowMidPoint/i),
    });
    expect(transactionSchema.properties?.operations?.items?.properties?.semanticName).toMatchObject({
      type: "string",
      maxLength: 160,
    });
    expect(transactionSchema.properties?.operations?.items?.properties?.semanticRole).toMatchObject({
      type: "string",
      maxLength: 128,
    });
    expect(transactionSchema.properties?.relationshipAssertions).toMatchObject({
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["connectorTempRef", "fromTempRef", "toTempRef", "direction"],
        properties: expect.objectContaining({
          connectorTempRef: { type: "string" },
          fromTempRef: { type: "string" },
          toTempRef: { type: "string" },
          direction: { enum: ["none", "end", "both"] },
          exactLabel: { type: "string" },
        }),
      },
    });
    expect(transactionSchema.properties?.operations?.items?.properties?.op?.enum).toEqual(
      expect.arrayContaining(["connect", "draw_connection", "update", "update_object"]),
    );
    expect(transactionSchema.properties?.operations?.items?.properties).toEqual(expect.objectContaining({
      memberObjectRefs: expect.objectContaining({ type: "array" }),
      connectorRefs: expect.objectContaining({ type: "array" }),
      addMembers: expect.objectContaining({ type: "array" }),
      addConnectors: expect.objectContaining({ type: "array" }),
      diagramTempRef: { type: "string" },
    }));
    expect(transactionSchema.properties?.operations?.items?.properties?.intent).toEqual({ type: "string" });
    expect(transactionSchema.properties?.operations?.items?.properties?.summary).toEqual({ type: "string" });
    const connectionRequired = operationSchema(transactionSchema, "connect").required ?? [];
    expect(connectionRequired).toEqual(["op"]);
    for (const field of ["direction", "label", "color"]) expect(connectionRequired).not.toContain(field);
    expect(transactionSchema.properties?.operations?.items?.properties?.start?.description)
      .toMatch(/point.*object.*tempRef/i);
    const createNodeSchema = operationSchema(transactionSchema, "create_node");
    expect(createNodeSchema.required).toEqual(["op"]);
    expect(transactionSchema.properties?.operations?.items?.properties?.nodeMetadata).toMatchObject({
      type: "object",
      additionalProperties: false,
      description: expect.stringMatching(/decision.*question lifecycle/i),
    });
    const batchDiagramRequired = operationSchema(transactionSchema, "create_diagram").required ?? [];
    expect(batchDiagramRequired).toEqual(["op"]);
    expect(batchDiagramRequired).not.toContain("diagramId");
    expect(operationSchema(transactionSchema, "edit_diagram").required).toEqual(["op"]);

    const autoLayoutRequired = operationSchema(transactionSchema, "auto_layout").required ?? [];
    expect(autoLayoutRequired).toEqual(["op"]);
    expect(autoLayoutRequired).not.toContain("density");
  });

  it("checks caller-authored relationship facts in the same successful transaction", async () => {
    const baseline = room([]);
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        transaction: Parameters<typeof applySemanticTransaction>[3];
      };
      const result = applySemanticTransaction(baseline, "alice", "agent", body.transaction, NOW + 1);
      return {
        ok: true,
        outcome: "applied",
        ...result,
        activity: null,
        proposal: null,
      };
    }) as unknown as WebMcpRequest;
    let nextId = 0;
    const tools = createJazzboardSemanticWebMcpTools(fixture(baseline).binding, {
      request,
      createId: (prefix) => `${prefix}_${++nextId}`,
    });

    const result = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [
        { op: "create_node", tempRef: "source", label: "Source", nodeType: "component" },
        { op: "create_node", tempRef: "target", label: "Target", nodeType: "service" },
        {
          op: "connect",
          tempRef: "source_to_target",
          start: { tempRef: "source" },
          end: { tempRef: "target" },
          direction: "end",
          label: "request",
        },
        { op: "create_diagram", tempRef: "diagram", title: "System flow" },
      ],
      relationshipAssertions: [{
        connectorTempRef: "source_to_target",
        fromTempRef: "source",
        toTempRef: "target",
        direction: "end",
        exactLabel: "request",
      }],
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        relationshipAssertionReview: {
          status: "pass",
          authority: expect.stringMatching(/caller-authored.*inferred no task facts/i),
          checkedRelationshipCount: 1,
          connectorTempRefs: ["source_to_target"],
        },
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(
      ((request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit).body,
    ));
    expect(body).not.toHaveProperty("relationshipAssertions");
    expect(body.transaction).not.toHaveProperty("relationshipAssertions");
  });

  it("rejects a reversed relationship assertion before any direct state change", async () => {
    const baseline = room([]);
    const request = vi.fn(async () => {
      throw new Error("A failed assertion must not reach the server.");
    }) as unknown as WebMcpRequest;
    let nextId = 0;
    const tools = createJazzboardSemanticWebMcpTools(fixture(baseline).binding, {
      request,
      createId: (prefix) => `${prefix}_${++nextId}`,
    });

    const result = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [
        { op: "create_node", tempRef: "source", label: "Source", nodeType: "component" },
        { op: "create_node", tempRef: "target", label: "Target", nodeType: "service" },
        {
          op: "connect",
          tempRef: "source_to_target",
          semanticName: "Source requests Target",
          start: { tempRef: "target" },
          end: { tempRef: "source" },
          direction: "end",
          label: "request",
        },
      ],
      relationshipAssertions: [{
        connectorTempRef: "source_to_target",
        fromTempRef: "source",
        toTempRef: "target",
        direction: "end",
        exactLabel: "request",
      }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "RELATIONSHIP_ASSERTION_FAILED",
        message: expect.stringMatching(/1 mismatch.*no Jazzboard state changed/i),
        details: {
          stateChanged: false,
          authority: expect.stringMatching(/did not infer, reverse, route, or repair/i),
          violations: [{
            code: "ENDPOINT_MISMATCH",
            connectorTempRef: "source_to_target",
            expected: expect.objectContaining({
              fromTempRef: "source",
              toTempRef: "target",
              direction: "end",
              exactLabel: "request",
            }),
            actual: expect.objectContaining({ direction: "end", label: "request" }),
          }],
        },
        recovery: {
          retry: "after_correction",
          instructions: expect.stringMatching(/fromTempRef.*actual start.*changed no state/i),
          suggestedTools: ["get_canvas_capabilities"],
        },
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("requires complete, resolvable coverage when relationship assertions are supplied", async () => {
    const baseline = room([]);
    const request = vi.fn() as unknown as WebMcpRequest;
    let nextId = 0;
    const tools = createJazzboardSemanticWebMcpTools(fixture(baseline).binding, {
      request,
      createId: (prefix) => `${prefix}_${++nextId}`,
    });
    const operations = [
      { op: "create_node", tempRef: "source", label: "Source", nodeType: "component" },
      { op: "create_node", tempRef: "target", label: "Target", nodeType: "service" },
      { op: "connect", tempRef: "request", start: { tempRef: "source" }, end: { tempRef: "target" } },
      { op: "connect", tempRef: "response", start: { tempRef: "target" }, end: { tempRef: "source" } },
    ];

    const incomplete = await execute(tool(tools, "apply_canvas_transaction"), {
      operations,
      relationshipAssertions: [{
        connectorTempRef: "request",
        fromTempRef: "source",
        toTempRef: "target",
        direction: "end",
      }],
    });
    expect(incomplete).toMatchObject({
      ok: false,
      error: {
        code: "RELATIONSHIP_ASSERTION_FAILED",
        details: {
          violations: [expect.objectContaining({
            code: "ASSERTION_MISSING_FOR_CONNECTOR_OPERATION",
            connectorTempRef: "response",
          })],
        },
      },
    });

    const unresolved = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: operations.slice(0, 3),
      relationshipAssertions: [{
        connectorTempRef: "request",
        fromTempRef: "missing_source",
        toTempRef: "target",
        direction: "end",
      }],
    });
    expect(unresolved).toMatchObject({
      ok: false,
      error: {
        code: "RELATIONSHIP_ASSERTION_FAILED",
        details: {
          violations: [expect.objectContaining({
            code: "TEMP_REF_UNRESOLVED",
            connectorTempRef: "request",
            expected: { unresolvedTempRefs: ["missing_source"] },
          })],
        },
      },
    });

    const semanticMismatch = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: operations.slice(0, 3),
      relationshipAssertions: [{
        connectorTempRef: "request",
        fromTempRef: "source",
        toTempRef: "target",
        direction: "both",
        exactLabel: "different label",
      }],
    });
    expect(semanticMismatch).toMatchObject({
      ok: false,
      error: {
        code: "RELATIONSHIP_ASSERTION_FAILED",
        details: {
          violations: [
            expect.objectContaining({ code: "DIRECTION_MISMATCH", connectorTempRef: "request" }),
            expect.objectContaining({ code: "LABEL_MISMATCH", connectorTempRef: "request" }),
          ],
        },
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a mismatched exact draft connector patch without replacing the draft", async () => {
    const previewApi = { ...node("api", "API", "service", 0), authority: "draft" as const };
    const previewDb = { ...node("db", "DB", "component", 400), authority: "draft" as const };
    const previewConnector = { ...connector(), authority: "draft" as const };
    const existingDraft = agentDraft({
      temporaryReferences: { api: "api", db: "db", request: "api-db" },
      previewObjects: [previewApi, previewDb, previewConnector],
    });
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") return { ok: true, draft: existingDraft };
      throw new Error("A failed assertion must not patch the draft.");
    }) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(room([])).binding, { request });

    const result = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [{
        op: "update_draft_connector",
        tempRef: "request",
        start: { tempRef: "db" },
        end: { tempRef: "api" },
      }],
      relationshipAssertions: [{
        connectorTempRef: "request",
        fromTempRef: "api",
        toTempRef: "db",
        direction: "end",
        exactLabel: "writes",
      }],
      delivery: {
        mode: "draft",
        draftId: existingDraft.id,
        expectedDraftRevision: existingDraft.revision,
        updateMode: "patch",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "RELATIONSHIP_ASSERTION_FAILED",
        details: { stateChanged: false },
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect((request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("keeps the advertised transaction update patch aligned with strict runtime validation", async () => {
    const state = room();
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      room: state,
      changedObjectIds: [],
      changedDiagramIds: [],
      membershipObjectIds: [],
      activity: null,
      proposal: null,
    })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, { request });
    const transactionSchema = schemaFor(tools, "apply_canvas_transaction");
    const patchSchema = transactionSchema.properties?.operations?.items?.properties?.patch;
    const acceptedPatch = {
      semanticName: null,
      semanticRole: null,
      x: 1,
      y: 2,
      width: 300,
      height: 180,
      rotation: 0.25,
      zIndex: 8,
      groupId: null,
      content: "Updated content",
      color: "black",
      size: "l",
      align: "middle",
      shape: "ellipse",
      nodeType: "decision",
      nodeMetadata: {
        kind: "decision",
        status: "accepted",
        owner: "Platform",
        resolution: "Use signed sessions.",
      },
      label: "Updated label",
      fill: "blue",
      stroke: "black",
      start: { x: 10, y: 20, objectId: null },
      end: { x: 30, y: 40, objectId: "db" },
      routing: { mode: "elbow", elbowMidPoint: 0.35, labelPosition: 0.62 },
      direction: "both",
      alt: "Accessible description",
      locked: true,
      segments: [{ kind: "line", to: { x: 1, y: 1 } }],
      closed: true,
      strokeWidth: 4,
      opacity: 0.8,
      lineCap: "round",
      lineJoin: "bevel",
      fillRule: "evenodd",
    };

    expect(patchSchema).toMatchObject({
      type: "object",
      description: expect.stringMatching(/patch.*path coordinates.*documented/i),
    });
    expect(transactionSchema.properties?.operations?.items?.properties?.segments?.description)
      .toMatch(/quadratic.*control.*cubic.*controls/);

    const accepted = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [{ op: "update", objectId: "api", expectedRevision: 1, patch: acceptedPatch }],
    });
    expect(accepted).toMatchObject({ ok: true });
    const requestBody = JSON.parse(String(
      ((request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit).body,
    ));
    expect(requestBody.transaction.commands[0].patch).toEqual({
      ...acceptedPatch,
      routing: {
        mode: "elbow",
        kind: "elbow",
        bend: 0,
        elbowMidPoint: 0.35,
        labelPosition: 0.62,
      },
    });

    const aliasAccepted = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [{
        op: "update_object",
        objectId: "api",
        expectedRevision: 1,
        operation: "connect",
        patch: { routing: { mode: "elbow", elbowMidPoint: 0.4 } },
      }],
    });
    expect(aliasAccepted).toMatchObject({ ok: true });
    const aliasRequestBody = JSON.parse(String(
      ((request as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as RequestInit).body,
    ));
    expect(aliasRequestBody.transaction.commands[0]).toMatchObject({
      type: "update",
      objectId: "api",
      expectedRevision: 1,
      operation: "connect",
      patch: { routing: { mode: "elbow", kind: "elbow", bend: 0, elbowMidPoint: 0.4, labelPosition: 0.5 } },
    });

    const rejected = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [{ op: "update", objectId: "api", expectedRevision: 1, patch: { surprise: true } }],
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_TOOL_INPUT",
        recovery: {
          retry: "after_correction",
          suggestedTools: ["get_canvas_capabilities"],
        },
      },
    });
    for (const nodeMetadata of [
      { kind: "decision", status: "proposed", resolution: "Too early" },
      { kind: "decision", status: "accepted", resolution: null },
      { kind: "open_question", status: "open", resolution: "Too early" },
      { kind: "open_question", status: "closed", resolution: null },
    ]) {
      const lifecycleRejected = await execute(tool(tools, "apply_canvas_transaction"), {
        operations: [{ op: "update", objectId: "api", expectedRevision: 1, patch: { nodeMetadata } }],
      });
      expect(lifecycleRejected).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    }
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("tolerates inert operation activity notes and advances omitted paint order past explicit candidates", async () => {
    const state = room([]);
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      room: state,
      changedObjectIds: [],
      changedDiagramIds: [],
      membershipObjectIds: [],
      activity: null,
      proposal: null,
    })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, { request });

    const result = await execute(tool(tools, "apply_canvas_transaction"), {
      intent: "Show an outside-to-inside request path.",
      summary: "One boundary, two nodes, and one request.",
      operations: [
        {
          op: "create_shape",
          tempRef: "boundary",
          label: "Commerce trust boundary",
          semanticRole: "architecture.trust_boundary",
          x: 300,
          y: 80,
          width: 820,
          height: 440,
          zIndex: 0,
          intent: "Frame internal services.",
          summary: "Commerce boundary.",
        },
        {
          op: "create_node",
          tempRef: "shopper",
          label: "Shopper Browser",
          nodeType: "component",
          x: 20,
          y: 240,
          width: 180,
          height: 70,
          zIndex: 2,
          intent: "Show the external actor.",
          summary: "External browser.",
        },
        {
          op: "create_node",
          tempRef: "checkout",
          label: "Checkout API",
          nodeType: "service",
          x: 420,
          y: 240,
          width: 180,
          height: 70,
          zIndex: 2,
          intent: "Show the internal service.",
          summary: "Checkout service.",
        },
        {
          op: "connect",
          tempRef: "request",
          start: { tempRef: "shopper" },
          end: { tempRef: "checkout" },
          label: "checkout request",
          intent: "Connect the supplied entities.",
          summary: "Directed request.",
        },
      ],
    });

    expect(result).toMatchObject({ ok: true });
    const requestBody = JSON.parse(String(
      ((request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit).body,
    ));
    const createdObjects = requestBody.transaction.commands
      .filter((command: { type: string }) => command.type === "create")
      .map((command: { object: CanvasObject }) => command.object);
    expect(createdObjects.find((object: CanvasObject) => object.semanticRole === "architecture.trust_boundary")?.zIndex)
      .toBe(0);
    expect(createdObjects.filter((object: CanvasObject) => object.kind === "shape" && object.nodeType !== null))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ zIndex: 2 }),
        expect.objectContaining({ zIndex: 2 }),
      ]));
    expect(createdObjects.find((object: CanvasObject) => object.kind === "connector")?.zIndex).toBe(3);
    for (const object of createdObjects) {
      expect(object).not.toHaveProperty("intent");
      expect(object).not.toHaveProperty("summary");
    }
  });

  it("rejects cross-operation fields in the authoritative strict runtime validator", async () => {
    const state = room();
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      room: state,
      changedObjectIds: [],
      changedDiagramIds: [],
      membershipObjectIds: [],
      activity: null,
      proposal: null,
    })) as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(fixture(state).binding, { request }),
      "apply_canvas_transaction",
    );
    const validatesAdvertisedSchema = new Ajv({ allErrors: true, logger: false }).compile(
      transactionTool.inputSchema as object,
    );
    const operations: Array<Record<string, unknown>> = [
      { op: "create_node", tempRef: "newNode", label: "New node", nodeType: "service" },
      { op: "create_shape", tempRef: "newShape" },
      { op: "create_text", tempRef: "newText", content: "Note" },
      { op: "connect", tempRef: "newEdge", start: { x: 0, y: 0 }, end: { x: 100, y: 100 } },
      { op: "update", objectId: "api", expectedRevision: 1, patch: { label: "API" } },
      { op: "create_diagram", tempRef: "newDiagram", title: "New Diagram" },
      { op: "edit_diagram", diagramId: "architecture", expectedRevision: 1, title: "Updated" },
      {
        op: "auto_layout",
        layout: "grid",
        targets: ["newNode", "newShape", "newText"],
        diagramTempRef: "newDiagram",
      },
    ];
    const validInput = { operations };
    expect(validatesAdvertisedSchema(validInput), JSON.stringify(validatesAdvertisedSchema.errors)).toBe(true);
    await expect(execute(transactionTool, validInput)).resolves.toMatchObject({ ok: true });

    const irrelevantFields = [
      [0, "description", "not a node field"],
      [1, "content", "not a shape field"],
      [2, "shape", "ellipse"],
      [3, "width", 200],
      [4, "title", "not an update field"],
      [5, "patch", { label: "not a Diagram create field" }],
      [6, "tempRef", "notAllowed"],
      [7, "label", "not a layout field"],
    ] as const;
    for (const [operationIndex, field, value] of irrelevantFields) {
      const invalidInput = structuredClone(validInput);
      invalidInput.operations[operationIndex][field] = value;
      await expect(execute(transactionTool, invalidInput)).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_TOOL_INPUT" },
      });
    }
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps compact lifecycle discovery plus exact runtime lifecycle validation", async () => {
    const state = room();
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      room: state,
      changedObjectIds: [],
      changedDiagramIds: [],
      membershipObjectIds: [],
      activity: null,
      proposal: null,
    })) as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(fixture(state).binding, { request }),
      "apply_canvas_transaction",
    );
    const validatesAdvertisedSchema = new Ajv({ allErrors: true, logger: false }).compile(
      transactionTool.inputSchema as object,
    );
    const acceptedInputs = [
      {
        operations: [{
          op: "create_node",
          tempRef: "decisionNode",
          label: "Pending decision",
          nodeType: "decision",
          nodeMetadata: { kind: "decision" },
        }],
      },
      {
        operations: [{
          op: "create_node",
          tempRef: "questionNode",
          label: "Answered question",
          nodeType: "open_question",
          nodeMetadata: { kind: "open_question", status: "answered", resolution: "Documented." },
        }],
      },
    ];
    const rejectedInputs = [
      {
        operations: [{
          op: "create_node",
          tempRef: "prematureNode",
          label: "Premature",
          nodeType: "decision",
          nodeMetadata: { kind: "decision", resolution: "Status was omitted." },
        }],
      },
      {
        operations: [{
          op: "create_node",
          tempRef: "mismatchNode",
          label: "Mismatched",
          nodeType: "decision",
          nodeMetadata: { kind: "open_question" },
        }],
      },
    ];

    for (const input of acceptedInputs) {
      expect(validatesAdvertisedSchema(input), JSON.stringify(validatesAdvertisedSchema.errors)).toBe(true);
      await expect(execute(transactionTool, input)).resolves.toMatchObject({ ok: true });
    }
    for (const input of rejectedInputs) {
      await expect(execute(transactionTool, input)).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_TOOL_INPUT" },
      });
    }
    expect(request).toHaveBeenCalledTimes(acceptedInputs.length);
  });
});

describe("progressive draft delivery", () => {
  it("advertises progressive delivery as the preferred visible-composition contract and enforces create-or-replace inputs", async () => {
    const request = vi.fn() as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(fixture().binding, { request }),
      "apply_canvas_transaction",
    );
    const schema = schemaFor([transactionTool], "apply_canvas_transaction");
    const validates = new Ajv({ allErrors: true, logger: false }).compile(
      transactionTool.inputSchema as object,
    );
    const operations = [{
      op: "create_text",
      tempRef: "note",
      content: "Draft note",
    }];

    expect(schema.properties?.delivery).toMatchObject({
      type: "object",
      required: ["mode"],
      oneOf: expect.any(Array),
      description: expect.stringMatching(/visible new multi-object composition/i),
    });
    expect(transactionTool.description).toMatch(/visible multi-object work.*delivery\.mode=draft/i);
    expect(transactionTool.description).toMatch(/bot-traced.*not review/i);
    expect(transactionTool.description).toMatch(/finish_canvas_draft.*yourself.*no confirmation/i);
    expect(transactionTool.description).toMatch(/edits.*omit delivery/i);
    expect(transactionTool.description).toMatch(/root:.*no expectedRoomRevision/i);
    expect(transactionTool.description).toMatch(/per-op intent\/summary.*inert/i);
    expect(transactionTool.description).toMatch(/updateMode=patch.*affected stable tempRefs/i);
    expect(validates({ operations, delivery: { mode: "draft" } })).toBe(true);
    expect(validates({ operations, expectedRoomRevision: 7 })).toBe(false);
    expect(validates({
      operations,
      delivery: {
        mode: "draft",
        draftId: "draft_architecture",
        expectedDraftRevision: 2,
      },
    })).toBe(true);
    expect(validates({
      operations,
      delivery: { mode: "draft", draftId: "draft_architecture" },
    })).toBe(false);
    expect(validates({
      operations,
      delivery: { mode: "draft", updateMode: "patch" },
    })).toBe(false);
    expect(validates({
      operations,
      delivery: {
        mode: "draft",
        draftId: "draft_architecture",
        expectedDraftRevision: 2,
        updateMode: "patch",
      },
    })).toBe(true);

    await expect(execute(transactionTool, {
      operations,
      delivery: { mode: "draft", expectedDraftRevision: 2 },
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    await expect(execute(transactionTool, {
      operations: [{
        op: "update",
        objectId: "api",
        expectedRevision: 1,
        patch: { label: "Existing-object edit" },
      }],
      delivery: { mode: "draft" },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_TOOL_INPUT", message: expect.stringContaining("schema") },
    });
    await expect(execute(transactionTool, {
      operations: [{
        op: "update_draft_connector",
        tempRef: "request",
        routing: { mode: "curved", bend: 80 },
      }],
      delivery: { mode: "draft" },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_TOOL_INPUT" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("stages a new draft without mutating or accepting an authoritative room", async () => {
    const state = fixture();
    const createId = vi.fn((prefix: string) => `${prefix}_stable`);
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        draftId: string;
        baselineRoomRevision: number;
        temporaryReferences: Record<string, string>;
      };
      return {
        ok: true,
        draft: agentDraft({
          id: body.draftId,
          revision: 1,
          baselineRoomRevision: body.baselineRoomRevision,
          temporaryReferences: body.temporaryReferences,
        }),
      };
    }) as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(state.binding, { request, createId }),
      "apply_canvas_transaction",
    );

    const result = await execute(transactionTool, {
      operations: [{
        op: "create_node",
        tempRef: "apiNode",
        label: "API",
        nodeType: "service",
      }],
      delivery: { mode: "draft" },
      intent: "Draft an architecture",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "drafted",
        draftId: "draft_stable",
        draftRevision: 1,
        baselineRoomRevision: 7,
        temporaryReferences: { apiNode: "node_stable" },
      },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("/api/rooms/room%2Fa%20b/agent/drafts", {
      method: "POST",
      body: expect.any(String),
      signal: expect.any(AbortSignal),
    });
    const body = JSON.parse(String(
      ((request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit).body,
    ));
    expect(body).toMatchObject({
      draftId: "draft_stable",
      baselineRoomRevision: 7,
      temporaryReferences: { apiNode: "node_stable" },
      metadata: { intent: "Draft an architecture" },
      transaction: {
        commands: [{ type: "create", object: { id: "node_stable", label: "API" } }],
        diagramCommands: [],
      },
    });
    expect(state.accepted).toEqual([]);
    expect(state.acceptedDrafts).toHaveLength(1);
  });

  it("normalizes standalone-derived transaction aliases before strict validation", async () => {
    const state = fixture(room([]));
    let idCounter = 0;
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        draftId: string;
        baselineRoomRevision: number;
        temporaryReferences: Record<string, string>;
      };
      return {
        ok: true,
        draft: agentDraft({
          id: body.draftId,
          revision: 1,
          baselineRoomRevision: body.baselineRoomRevision,
          temporaryReferences: body.temporaryReferences,
        }),
      };
    }) as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(state.binding, {
        request,
        createId: (prefix) => `${prefix}_alias_${++idCounter}`,
      }),
      "apply_canvas_transaction",
    );

    await expect(execute(transactionTool, {
      operations: [
        { op: "create_node", tempRef: "source", label: "Source", nodeType: "component", x: 0, y: 0 },
        { op: "create_node", tempRef: "target", label: "Target", nodeType: "service", x: 400, y: 0 },
        {
          op: "draw_connection",
          tempRef: "request",
          start: { tempRef: "source" },
          end: { tempRef: "target" },
          label: "request",
        },
        {
          op: "create_diagram",
          tempRef: "diagram",
          title: "Aliased flow",
          memberObjectRefs: ["source", "target"],
          connectorRefs: ["request"],
        },
      ],
      delivery: { mode: "draft" },
    })).resolves.toMatchObject({ ok: true, data: { outcome: "drafted" } });

    const post = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(post.body));
    expect(body.transaction.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "create", object: expect.objectContaining({ kind: "connector", label: "request" }) }),
    ]));
    expect(body.transaction.diagramCommands).toEqual([
      expect.objectContaining({
        type: "diagram.create",
        diagram: expect.objectContaining({
          title: "Aliased flow",
          memberObjectIds: expect.arrayContaining([
            body.temporaryReferences.source,
            body.temporaryReferences.target,
          ]),
          connectorIds: [body.temporaryReferences.request],
        }),
      }),
    ]);
  });

  it("defaults draft results to compact preview records while detailed preserves the legacy snapshot", async () => {
    const previewObject = {
      ...node("node_preview", "Preview API", "service", 40),
      semanticName: "Preview API service",
      semanticRole: "architecture.service",
      authority: "draft" as const,
    };
    const previewDiagram = {
      ...diagram(),
      id: "diagram_preview",
      title: "Preview architecture",
      memberObjectIds: [previewObject.id],
      connectorIds: [],
      authority: "draft" as const,
    };
    const draft = agentDraft({
      id: "draft_preview",
      revision: 4,
      temporaryReferences: { apiNode: previewObject.id, architecture: previewDiagram.id },
      previewObjects: [previewObject],
      previewDiagrams: [previewDiagram],
    });
    const state = fixture();
    const getPresentation = vi.fn((draftId: string, revision: number) => ({
      source: "client-local" as const,
      draftId,
      requestedRevision: revision,
      observedRevision: revision,
      state: "pending" as const,
      complete: false,
      objectCount: 1,
      completedObjectCount: 0,
    }));
    state.context.getAgentDraftPresentation = getPresentation;
    const request = vi.fn(async () => ({ ok: true, draft })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(state.binding, {
      request,
      createId: (prefix) => prefix === "draft" ? "draft_generated" : `${prefix}_generated`,
    });
    const operations = [{
      op: "create_node",
      tempRef: "apiNode",
      label: "Preview API",
      nodeType: "service",
    }];

    const concise = await execute(tool(tools, "apply_canvas_transaction"), {
      operations,
      delivery: { mode: "draft" },
    });
    expect(concise).toMatchObject({
      ok: true,
      data: {
        outcome: "drafted",
        draftId: "draft_preview",
        draftRevision: 4,
        baselineRoomRevision: 7,
        draftStatus: "active",
        temporaryReferenceCount: 2,
        previewObjectCount: 1,
        previewDiagramCount: 1,
        presentation: {
          source: "client-local",
          requestedRevision: 4,
          observedRevision: 4,
          state: "pending",
          complete: false,
        },
        completion: {
          requiredTool: "finish_canvas_draft",
          action: "commit",
          expectedDraftRevision: 4,
          userConfirmationRequired: false,
          authorityBoundary: expect.stringMatching(/not human review.*finish autonomously/i),
        },
        nextStep: expect.stringMatching(
          /call finish_canvas_draft once.*exact recommended inspection/i,
        ),
        draftValidation: {
          geometryQualityStatus: "pass",
          totalChangedDiagramCount: 1,
          findingCount: 0,
          findings: [],
          authority: expect.stringMatching(/intent-unaware.*preserve deliberate/i),
        },
        previewObjects: [{
          id: "node_preview",
          revision: 1,
          kind: "shape",
          semanticName: "Preview API service",
          semanticRole: "architecture.service",
          bounds: { x: 40, y: 100, width: 200, height: 100 },
          authority: "draft",
        }],
        previewDiagrams: [{
          id: "diagram_preview",
          revision: 1,
          title: "Preview architecture",
          memberObjectCount: 1,
          connectorCount: 0,
          authority: "draft",
        }],
        visualInspectionStatus: "not_performed",
      },
    });
    const conciseData = (concise as { ok: true; data: Record<string, unknown> }).data;
    expect(conciseData).not.toHaveProperty("draft");
    expect((conciseData.previewObjects as Array<Record<string, unknown>>)[0]).not.toHaveProperty("label");
    expect((conciseData.previewObjects as Array<Record<string, unknown>>)[0]).not.toHaveProperty("createdAt");

    const detailed = await execute(tool(tools, "apply_canvas_transaction"), {
      operations,
      delivery: { mode: "draft" },
      responseDetail: "detailed",
    });
    expect(detailed).toMatchObject({
      ok: true,
      data: {
        outcome: "drafted",
        draft: {
          id: "draft_preview",
          previewObjects: [{ id: "node_preview", label: "Preview API", createdAt: NOW }],
          previewDiagrams: [{ id: "diagram_preview", memberObjectIds: ["node_preview"] }],
        },
        previewObjects: [{ id: "node_preview", label: "Preview API", createdAt: NOW }],
        previewDiagrams: [{ id: "diagram_preview", memberObjectIds: ["node_preview"] }],
        presentation: {
          source: "client-local",
          requestedRevision: 4,
          observedRevision: 4,
          state: "pending",
          complete: false,
        },
        completion: {
          requiredTool: "finish_canvas_draft",
          action: "commit",
          expectedDraftRevision: 4,
          userConfirmationRequired: false,
        },
        nextStep: expect.stringMatching(
          /call finish_canvas_draft once.*exact recommended inspection/i,
        ),
        draftValidation: {
          geometryQualityStatus: "pass",
          findingCount: 0,
          findings: [],
        },
      },
    });
    expect(getPresentation).toHaveBeenCalledTimes(2);
  });

  it("reports bounded intent-unaware draft preflight guidance before commit", async () => {
    const previewApi = {
      ...node("api", "Checkout API", "service", 0),
      authority: "draft" as const,
    };
    const previewDb = {
      ...node("db", "Orders DB", "component", 100),
      authority: "draft" as const,
    };
    const previewConnector = {
      ...connector(),
      authority: "draft" as const,
    };
    const previewDiagram = {
      ...diagram(),
      authority: "draft" as const,
    };
    const draft = agentDraft({
      id: "draft_cramped",
      revision: 1,
      temporaryReferences: {
        api: previewApi.id,
        db: previewDb.id,
        request: previewConnector.id,
        diagram: previewDiagram.id,
      },
      previewObjects: [previewApi, previewDb, previewConnector],
      previewDiagrams: [previewDiagram],
    });
    const state = fixture(room([]));
    const request = vi.fn(async () => ({ ok: true, draft })) as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(state.binding, {
        request,
        createId: (prefix) => `${prefix}_generated`,
      }),
      "apply_canvas_transaction",
    );

    const result = await execute(transactionTool, {
      operations: [{ op: "create_node", tempRef: "api", label: "Checkout API", nodeType: "service" }],
      delivery: { mode: "draft" },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "drafted",
        draftId: "draft_cramped",
        draftValidation: {
          geometryQualityStatus: "fail",
          failCount: expect.any(Number),
          authority: expect.stringMatching(/intent-unaware.*correct only unintended/i),
          findingCoverage: {
            limit: 24,
            truncated: false,
          },
          reasoningContext: {
            objects: expect.arrayContaining([
              expect.objectContaining({
                id: "api",
                semanticName: null,
                displayText: "Checkout API",
                bounds: { x: 0, y: 100, width: 200, height: 100 },
              }),
              expect.objectContaining({
                id: "db",
                displayText: "Orders DB",
              }),
            ]),
            connectors: expect.arrayContaining([
              expect.objectContaining({
                id: "api-db",
                label: "writes",
                startObjectId: "api",
                endObjectId: "db",
                points: expect.any(Array),
                labelBounds: expect.any(Object),
              }),
            ]),
          },
        },
        relationshipReview: {
          authority: expect.stringMatching(/actual authored endpoint state.*prose never overrides/i),
          requiredAction: expect.stringMatching(/before finish or completion.*actual start -> end.*requested relationship facts/i),
          coverage: {
            totalConnectorCount: 1,
            returnedConnectorCount: 1,
            limit: 200,
            truncated: false,
            omittedConnectorCount: 0,
          },
          items: [{
            connectorId: "api-db",
            connectorTempRef: "request",
            semanticName: null,
            label: "writes",
            direction: "end",
            start: {
              objectId: "api",
              tempRef: "api",
              semanticName: null,
              displayText: "Checkout API",
            },
            end: {
              objectId: "db",
              tempRef: "db",
              semanticName: null,
              displayText: "Orders DB",
            },
          }],
        },
        recommendedDraftCorrection: {
          tool: "apply_canvas_transaction",
          delivery: {
            mode: "draft",
            draftId: "draft_cramped",
            expectedDraftRevision: 1,
            updateMode: "patch",
          },
          affectedTempRefs: expect.arrayContaining(["api", "db", "request"]),
          connectorTempRefs: ["request"],
          connectorOperation: {
            op: "update_draft_connector",
            rule: expect.stringMatching(/only agent-chosen.*do not use authoritative update/i),
          },
        },
        nextStep: expect.stringMatching(
          /relationshipReview.*requested facts.*review draftValidation.*update_draft_connector.*updateMode=replace.*deliberate geometry is valid/i,
        ),
      },
    });
    const data = (result as {
      ok: true;
      data: { draftValidation: { findings: Array<Record<string, unknown>> } };
    }).data;
    expect(data.draftValidation.findings.length).toBeLessThanOrEqual(24);
    expect(data.draftValidation.findings.find((finding) => finding.code === "MEMBER_OBJECT_OVERLAP"))
      .toMatchObject({
        diagramId: "architecture",
        status: "fail",
        summary: expect.stringMatching(/overlap.*unintended/i),
        objectIds: expect.arrayContaining(["api", "db"]),
        details: { overlapArea: expect.any(Number) },
      });
  });

  it("keeps tempRef IDs stable when a cumulative draft omits and later reintroduces a candidate", async () => {
    const state = fixture();
    const prefixCounts = new Map<string, number>();
    const createId = vi.fn((prefix: string) => {
      const count = (prefixCounts.get(prefix) ?? 0) + 1;
      prefixCounts.set(prefix, count);
      return `${prefix}_${count}`;
    });
    let persistedDraft: AgentCanvasDraftSnapshot | null = null;
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") return { ok: true, draft: persistedDraft };
      const body = JSON.parse(String(init?.body)) as {
        draftId?: string;
        expectedDraftRevision?: number;
        baselineRoomRevision: number;
        transaction: unknown;
        temporaryReferences: Record<string, string>;
      };
      if (init?.method === "POST") {
        persistedDraft = agentDraft({
          id: body.draftId ?? "draft_missing",
          revision: 1,
          baselineRoomRevision: body.baselineRoomRevision,
          temporaryReferences: body.temporaryReferences,
        });
      } else {
        const previous = persistedDraft;
        if (!previous) throw new Error("Expected an existing draft before replacement.");
        persistedDraft = agentDraft({
          id: previous.id,
          revision: (body.expectedDraftRevision ?? previous.revision) + 1,
          baselineRoomRevision: body.baselineRoomRevision,
          // The server keeps reservations for the lifetime of the draft even
          // though the current cumulative preview includes only active refs.
          temporaryReferences: {
            ...previous.temporaryReferences,
            ...body.temporaryReferences,
          },
        });
      }
      return { ok: true, draft: persistedDraft };
    }) as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(state.binding, { request, createId }),
      "apply_canvas_transaction",
    );
    const firstOperations = [
      { op: "create_shape", tempRef: "recoverable", label: "Candidate" },
      { op: "create_text", tempRef: "anchor", content: "Anchor" },
    ];

    const first = await execute(transactionTool, {
      operations: firstOperations,
      delivery: { mode: "draft" },
    });
    expect(first).toMatchObject({
      ok: true,
      data: {
        draftId: "draft_1",
        draftRevision: 1,
        temporaryReferences: {
          recoverable: "shape_1",
          anchor: "text_1",
        },
      },
    });

    const omitted = await execute(transactionTool, {
      operations: [{ op: "create_text", tempRef: "anchor", content: "Anchor only" }],
      delivery: {
        mode: "draft",
        draftId: "draft_1",
        expectedDraftRevision: 1,
      },
    });
    expect(omitted).toMatchObject({
      ok: true,
      data: {
        draftRevision: 2,
        temporaryReferences: {
          recoverable: "shape_1",
          anchor: "text_1",
        },
      },
    });

    const reintroduced = await execute(transactionTool, {
      operations: [
        { op: "create_text", tempRef: "anchor", content: "Anchor restored" },
        { op: "create_shape", tempRef: "recoverable", label: "Candidate restored" },
      ],
      delivery: {
        mode: "draft",
        draftId: "draft_1",
        expectedDraftRevision: 2,
      },
    });
    expect(reintroduced).toMatchObject({
      ok: true,
      data: {
        draftRevision: 3,
        temporaryReferences: {
          recoverable: "shape_1",
          anchor: "text_1",
        },
      },
    });

    expect(createId.mock.calls).toEqual([["shape"], ["text"], ["draft"]]);
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/rooms/room%2Fa%20b/drafts/draft_1",
      { method: "GET", signal: expect.any(AbortSignal) },
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      "/api/rooms/room%2Fa%20b/drafts/draft_1",
      { method: "GET", signal: expect.any(AbortSignal) },
    );
    const calls = (request as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const omittedBody = JSON.parse(String((calls[2]?.[1] as RequestInit).body));
    const reintroducedBody = JSON.parse(String((calls[4]?.[1] as RequestInit).body));
    expect(omittedBody.temporaryReferences).toEqual({ anchor: "text_1" });
    expect(omittedBody.transaction.commands).toEqual([
      expect.objectContaining({
        type: "create",
        object: expect.objectContaining({ id: "text_1", content: "Anchor only" }),
      }),
    ]);
    expect(reintroducedBody.temporaryReferences).toEqual({
      recoverable: "shape_1",
      anchor: "text_1",
    });
    expect(reintroducedBody.transaction.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "create",
        object: expect.objectContaining({ id: "shape_1", label: "Candidate restored" }),
      }),
    ]));
    expect(state.acceptedDrafts.map(({ revision }) => revision)).toEqual([1, 1, 2, 2, 3]);
  });

  it("sends a targeted exact-revision patch without resending unaffected draft operations", async () => {
    const state = fixture();
    const existing = agentDraft({
      revision: 3,
      temporaryReferences: { note: "text_stable", untouched: "shape_stable" },
    });
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") return { ok: true, draft: existing };
      return {
        ok: true,
        draft: agentDraft({
          revision: 4,
          temporaryReferences: existing.temporaryReferences,
        }),
      };
    }) as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(state.binding, { request }),
      "apply_canvas_transaction",
    );

    await expect(execute(transactionTool, {
      operations: [{
        op: "create_text",
        tempRef: "note",
        content: "Only this candidate changed",
        x: 40,
        y: 50,
      }],
      delivery: {
        mode: "draft",
        draftId: existing.id,
        expectedDraftRevision: existing.revision,
        updateMode: "patch",
      },
    })).resolves.toMatchObject({ ok: true, data: { draftRevision: 4 } });

    const put = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(put.body));
    expect(body).toMatchObject({
      expectedDraftRevision: 3,
      updateMode: "patch",
      temporaryReferences: { note: "text_stable" },
    });
    expect(body.transaction.commands).toEqual([
      expect.objectContaining({
        type: "create",
        object: expect.objectContaining({ id: "text_stable", content: "Only this candidate changed" }),
      }),
    ]);
  });

  it("updates one unpublished connector by stable tempRef without resending the draft", async () => {
    const previewApi = { ...node("api", "Checkout API", "service", 0), authority: "draft" as const };
    const previewDb = { ...node("db", "Orders DB", "component", 400), authority: "draft" as const };
    const previewConnector = {
      ...(connector() as Extract<CanvasObject, { kind: "connector" }>),
      authority: "draft" as const,
    };
    const existing = agentDraft({
      revision: 3,
      temporaryReferences: { api: "api", db: "db", request: "api-db" },
      previewObjects: [previewApi, previewDb, previewConnector],
      previewDiagrams: [],
    });
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") return { ok: true, draft: existing };
      return {
        ok: true,
        draft: agentDraft({
          revision: 4,
          temporaryReferences: existing.temporaryReferences,
          previewObjects: existing.previewObjects,
        }),
      };
    }) as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(fixture(room([])).binding, { request }),
      "apply_canvas_transaction",
    );

    await expect(execute(transactionTool, {
      operations: [{
        op: "update_draft_connector",
        tempRef: "request",
        label: "query",
        routing: { mode: "curved", bend: 120, labelPosition: 0.35 },
      }],
      delivery: {
        mode: "draft",
        draftId: existing.id,
        expectedDraftRevision: existing.revision,
        updateMode: "patch",
      },
    })).resolves.toMatchObject({ ok: true, data: { draftRevision: 4 } });

    const put = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(put.body));
    expect(body).toMatchObject({
      expectedDraftRevision: 3,
      updateMode: "patch",
      temporaryReferences: { request: "api-db" },
    });
    expect(body.transaction.commands).toEqual([{
      type: "create",
      object: expect.objectContaining({
        id: "api-db",
        kind: "connector",
        label: "query",
        start: previewConnector.start,
        end: previewConnector.end,
        routing: expect.objectContaining({ mode: "curved", bend: 120, labelPosition: 0.35 }),
      }),
    }]);
  });

  it("patches one unpublished Diagram by stable tempRef without an authoritative edit", async () => {
    const previewApi = { ...node("api", "Checkout API", "service", 0), authority: "draft" as const };
    const previewDb = { ...node("db", "Orders DB", "component", 400), authority: "draft" as const };
    const previewDiagram = { ...diagram(), authority: "draft" as const };
    const existing = agentDraft({
      revision: 3,
      temporaryReferences: { api: "api", db: "db", diagram: "architecture" },
      previewObjects: [previewApi, previewDb],
      previewDiagrams: [previewDiagram],
    });
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") return { ok: true, draft: existing };
      return {
        ok: true,
        draft: agentDraft({
          ...existing,
          revision: 4,
          previewDiagrams: [{
            ...previewDiagram,
            title: "Checkout path",
            memberObjectIds: ["api"],
          }],
        }),
      };
    }) as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(fixture(room([])).binding, { request }),
      "apply_canvas_transaction",
    );

    await expect(execute(transactionTool, {
      operations: [{
        op: "edit_diagram",
        diagramTempRef: "diagram",
        title: "Checkout path",
        members: [{ tempRef: "api" }],
      }],
      delivery: {
        mode: "draft",
        draftId: existing.id,
        expectedDraftRevision: existing.revision,
        updateMode: "patch",
      },
    })).resolves.toMatchObject({ ok: true, data: { draftRevision: 4 } });

    const put = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(put.body));
    expect(body).toMatchObject({
      expectedDraftRevision: 3,
      updateMode: "patch",
      temporaryReferences: {},
    });
    expect(body.transaction.commands).toEqual([]);
    expect(body.transaction.diagramCommands).toEqual([{
      type: "diagram.create",
      diagram: expect.objectContaining({
        id: "architecture",
        title: "Checkout path",
        description: previewDiagram.description,
        memberObjectIds: ["api"],
        connectorIds: previewDiagram.connectorIds,
      }),
    }]);
  });

  it("atomically creates a caption and appends it to authoritative Diagram membership", async () => {
    const state = room();
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      room: state,
      changedObjectIds: [],
      changedDiagramIds: [],
      membershipObjectIds: [],
      activity: null,
      proposal: null,
    })) as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(fixture(state).binding, { request }),
      "apply_canvas_transaction",
    );

    await expect(execute(transactionTool, {
      operations: [
        {
          op: "create_text",
          tempRef: "caption",
          content: "evaluates",
          semanticName: "Evaluation caption",
          semanticRole: "architecture.edge_label",
          x: 260,
          y: 40,
          width: 120,
          height: 28,
        },
        {
          op: "edit_diagram",
          diagramId: "architecture",
          expectedRevision: 1,
          addMembers: [{ tempRef: "caption" }],
        },
      ],
      responseDetail: "concise",
    })).resolves.toMatchObject({ ok: true });

    const post = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(post.body));
    const captionId = body.transaction.commands[0].object.id;
    expect(body.transaction.commands[0]).toMatchObject({
      type: "create",
      object: { id: captionId, kind: "text", content: "evaluates" },
    });
    expect(body.transaction.diagramCommands).toEqual([{
      type: "diagram.update",
      diagramId: "architecture",
      expectedRevision: 1,
      patch: { memberObjectIds: ["api", "db", captionId] },
    }]);
  });

  it("rejects replacement and additive Diagram membership in the same operation", async () => {
    const request = vi.fn() as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(fixture().binding, { request }),
      "apply_canvas_transaction",
    );

    await expect(execute(transactionTool, {
      operations: [{
        op: "edit_diagram",
        diagramId: "architecture",
        expectedRevision: 1,
        members: [{ objectId: "api" }],
        addMembers: [{ objectId: "db" }],
      }],
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects draft Diagram tempRef edits without an exact draft patch", async () => {
    const request = vi.fn() as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(fixture().binding, { request }),
      "apply_canvas_transaction",
    );

    await expect(execute(transactionTool, {
      operations: [{
        op: "edit_diagram",
        diagramTempRef: "diagram",
        title: "Checkout path",
      }],
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("stops after exact-read when the persisted draft revision has changed", async () => {
    const state = fixture();
    const request = vi.fn(async () => ({
      ok: true,
      draft: agentDraft({ revision: 3 }),
    })) as unknown as WebMcpRequest;
    const transactionTool = tool(
      createJazzboardSemanticWebMcpTools(state.binding, { request }),
      "apply_canvas_transaction",
    );

    await expect(execute(transactionTool, {
      operations: [{ op: "create_text", tempRef: "note", content: "Draft" }],
      delivery: {
        mode: "draft",
        draftId: "draft_architecture",
        expectedDraftRevision: 2,
      },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "DRAFT_REVISION_CONFLICT",
        details: { currentDraftRevision: 3, expectedDraftRevision: 2 },
      },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(state.acceptedDrafts).toEqual([expect.objectContaining({ revision: 3 })]);
  });
});

describe("bounded semantic reads", () => {
  it("queries classified diagram members through an authorized GET without activating the agent", async () => {
    const state = room();
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const local = fixture(state);
    const tools = createJazzboardSemanticWebMcpTools(local.binding, { request });

    const result = await execute(tool(tools, "query_objects"), {
      text: "checkout",
      nodeTypes: ["service"],
      diagramId: "architecture",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        totalMatched: 1,
        objects: [{
          id: "api",
          revision: 1,
          nodeType: "service",
          bounds: { x: 0, y: 100, width: 200, height: 100 },
          label: "Checkout API",
        }],
        diagrams: [{ id: "architecture", revision: 1, memberObjectCount: 2, connectorCount: 1 }],
      },
    });
    const summaryData = (result as { ok: true; data: { objects: Array<Record<string, unknown>> } }).data;
    expect(summaryData.objects[0]).not.toHaveProperty("createdAt");
    expect(summaryData.objects[0]).not.toHaveProperty("nodeMetadata");

    const full = await execute(tool(tools, "query_objects"), {
      text: "checkout",
      nodeTypes: ["service"],
      diagramId: "architecture",
      detail: "full",
    });
    expect(full).toMatchObject({
      ok: true,
      data: { objects: [{ id: "api", createdAt: NOW, nodeType: "service" }] },
    });
    expect((full as { ok: true; data: Record<string, unknown> }).data).not.toHaveProperty("diagrams");
    expect(request).toHaveBeenCalledWith("/api/rooms/room%2Fa%20b", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(local.getRoom().participants.alice).toMatchObject({ agentActive: false, agent: { activity: null } });
  });

  it("filters and searches object identity while describing named architecture relationships", async () => {
    const state = room();
    state.objects.api.semanticName = "Netflix API gateway";
    state.objects.api.semanticRole = "architecture.edge_service";
    state.objects.db.semanticName = "Netflix playback metadata store";
    state.objects.db.semanticRole = "architecture.database";
    state.objects["api-db"].semanticName = "Playback metadata lookup";
    state.objects["api-db"].semanticRole = "architecture.request_flow";
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, { request });

    const filtered = await execute(tool(tools, "query_objects"), {
      semanticName: "api gateway",
      semanticRole: "edge_service",
    });
    expect(filtered).toMatchObject({
      ok: true,
      data: {
        totalMatched: 1,
        objects: [{ id: "api", semanticName: "Netflix API gateway", semanticRole: "architecture.edge_service" }],
      },
    });

    const searched = await execute(tool(tools, "query_objects"), { text: "request_flow" });
    expect(searched).toMatchObject({
      ok: true,
      data: {
        totalMatched: 1,
        objects: [{
          id: "api-db",
          start: { objectId: "api" },
          end: { objectId: "db" },
          route: { points: expect.any(Array), bounds: expect.any(Object) },
        }],
      },
    });

    const described = await execute(tool(tools, "describe_diagram"), { diagramId: "architecture" });
    expect(described).toMatchObject({
      ok: true,
      data: {
        members: expect.arrayContaining([
          expect.objectContaining({
            id: "api",
            semanticName: "Netflix API gateway",
            semanticRole: "architecture.edge_service",
            label: "Checkout API",
          }),
        ]),
        relationships: [expect.objectContaining({
          connectorId: "api-db",
          semanticName: "Playback metadata lookup",
          semanticRole: "architecture.request_flow",
        })],
      },
    });
  });

  it("returns a connector-bounded outgoing neighborhood and its diagram metadata", async () => {
    const state = room();
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, { request });

    const result = await execute(tool(tools, "read_neighborhood"), {
      objectIds: ["api"],
      direction: "outgoing",
      depth: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        objects: expect.arrayContaining([
          expect.objectContaining({ id: "api" }),
          expect.objectContaining({ id: "db" }),
        ]),
        connectors: [{
          id: "api-db",
          start: { objectId: "api" },
          end: { objectId: "db" },
          routing: { mode: "straight", kind: "straight" },
          route: { points: expect.any(Array), bounds: expect.any(Object) },
        }],
        diagrams: [{ id: "architecture", revision: 1, memberObjectCount: 2, connectorCount: 1 }],
      },
    });
    const summaryData = (result as {
      ok: true;
      data: { objects: Array<Record<string, unknown>>; diagrams: Array<Record<string, unknown>> };
    }).data;
    expect(summaryData.objects[0]).not.toHaveProperty("createdAt");
    expect(summaryData.diagrams[0]).not.toHaveProperty("memberObjectIds");

    const full = await execute(tool(tools, "read_neighborhood"), {
      objectIds: ["api"],
      direction: "outgoing",
      depth: 1,
      detail: "full",
    });
    expect(full).toMatchObject({
      ok: true,
      data: {
        objects: expect.arrayContaining([expect.objectContaining({ id: "api", createdAt: NOW })]),
        diagrams: [{ id: "architecture", memberObjectIds: ["api", "db"], connectorIds: ["api-db"] }],
      },
    });
  });

  it("bounds deterministic Diagram summaries for one object with hundreds of Diagram memberships", async () => {
    const diagramIds = Array.from({ length: 300 }, (_, index) =>
      `diagram-${String(index).padStart(3, "0")}`);
    const state = room();
    state.objects = {
      api: {
        ...state.objects.api,
        diagramIds: [...diagramIds].reverse(),
      },
    };
    state.diagrams = Object.fromEntries(diagramIds.map((diagramId, index) => [
      diagramId,
      {
        ...diagram(),
        id: diagramId,
        title: `Diagram ${index}`,
        revision: index + 1,
        memberObjectIds: ["api"],
        connectorIds: [],
      },
    ]));
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, { request });
    const expectedCoverage = {
      totalDiagramCount: 300,
      returnedDiagramCount: 32,
      limit: 32,
      truncated: true,
      omittedDiagramCount: 268,
      omittedDiagramIds: diagramIds.slice(32, 96),
      omittedDiagramIdsTruncated: true,
    };

    const querySummary = await execute(tool(tools, "query_objects"), {
      text: "checkout",
      limit: 1,
    });
    expect(querySummary).toMatchObject({
      ok: true,
      data: {
        totalMatched: 1,
        truncated: false,
        objects: [{
          id: "api",
          diagramIds: diagramIds.slice(0, 16),
          diagramMembershipCoverage: {
            totalDiagramCount: 300,
            returnedDiagramCount: 16,
            limit: 16,
            truncated: true,
            omittedDiagramCount: 284,
            omittedDiagramIds: diagramIds.slice(16, 32),
            omittedDiagramIdsTruncated: true,
          },
        }],
        diagrams: diagramIds.slice(0, 32).map((id) => ({ id })),
        diagramSummaryCoverage: expectedCoverage,
      },
    });
    const queryFull = await execute(tool(tools, "query_objects"), {
      text: "checkout",
      limit: 1,
      detail: "full",
    });
    expect(queryFull).toMatchObject({
      ok: true,
      data: {
        objects: [{ id: "api", diagramIds: [...diagramIds].reverse() }],
      },
    });
    expect((queryFull as { ok: true; data: Record<string, unknown> }).data)
      .not.toHaveProperty("diagramSummaryCoverage");

    const neighborhoodSummary = await execute(tool(tools, "read_neighborhood"), {
      objectIds: ["api"],
      maxObjects: 1,
    });
    expect(neighborhoodSummary).toMatchObject({
      ok: true,
      data: {
        objects: [{
          id: "api",
          diagramIds: diagramIds.slice(0, 16),
          diagramMembershipCoverage: {
            totalDiagramCount: 300,
            returnedDiagramCount: 16,
            limit: 16,
            truncated: true,
            omittedDiagramCount: 284,
            omittedDiagramIds: diagramIds.slice(16, 32),
            omittedDiagramIdsTruncated: true,
          },
        }],
        diagrams: diagramIds.slice(0, 32).map((id) => ({ id })),
        diagramSummaryCoverage: expectedCoverage,
      },
    });
    const neighborhoodFull = await execute(tool(tools, "read_neighborhood"), {
      objectIds: ["api"],
      maxObjects: 1,
      detail: "full",
    });
    const neighborhoodFullData = (neighborhoodFull as {
      ok: true;
      data: { diagrams: Diagram[] };
    }).data;
    expect(neighborhoodFullData.diagrams).toHaveLength(300);
    expect(neighborhoodFullData.diagrams[0]).toMatchObject({ id: "diagram-299", memberObjectIds: ["api"] });
    expect(neighborhoodFullData).not.toHaveProperty("diagramSummaryCoverage");
  });

  it("bounds repeated membership indexes across 200 objects in 500 Diagrams", async () => {
    const objectIds = Array.from({ length: 200 }, (_, index) =>
      `object-${String(index).padStart(3, "0")}`);
    const diagramIds = Array.from({ length: 500 }, (_, index) =>
      `diagram-${String(index).padStart(3, "0")}`);
    const state = room([]);
    state.objects = Object.fromEntries(objectIds.map((objectId, index) => [
      objectId,
      {
        ...node(objectId, `Shared node ${index}`, "component", index * 240),
        zIndex: index,
        diagramIds: [...diagramIds].reverse(),
      },
    ]));
    state.diagrams = Object.fromEntries(diagramIds.map((diagramId, index) => [
      diagramId,
      {
        ...diagram(),
        id: diagramId,
        title: `Shared Diagram ${index}`,
        revision: index + 1,
        memberObjectIds: objectIds,
        connectorIds: [],
      },
    ]));
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, { request });

    const querySummary = await execute(tool(tools, "query_objects"), {
      text: "shared node",
      limit: 200,
    });
    const querySummaryData = (querySummary as {
      ok: true;
      data: { objects: Array<Record<string, unknown>> };
    }).data;
    expect(querySummaryData.objects).toHaveLength(200);
    expect(querySummaryData.objects[0]).toMatchObject({
      diagramIds: diagramIds.slice(0, 16),
      diagramMembershipCoverage: {
        totalDiagramCount: 500,
        returnedDiagramCount: 16,
        limit: 16,
        truncated: true,
        omittedDiagramCount: 484,
        omittedDiagramIds: diagramIds.slice(16, 32),
        omittedDiagramIdsTruncated: true,
      },
    });
    expect(querySummaryData.objects[199]).toMatchObject({
      diagramIds: diagramIds.slice(0, 16),
      diagramMembershipCoverage: {
        totalDiagramCount: 500,
        omittedDiagramCount: 484,
        omittedDiagramIds: diagramIds.slice(16, 32),
        omittedDiagramIdsTruncated: true,
      },
    });

    const neighborhoodSummary = await execute(tool(tools, "read_neighborhood"), {
      objectIds: [objectIds[0]],
      includeDiagramPeers: true,
      maxObjects: 300,
    });
    const neighborhoodSummaryData = (neighborhoodSummary as {
      ok: true;
      data: { objects: Array<Record<string, unknown>> };
    }).data;
    expect(neighborhoodSummaryData.objects).toHaveLength(200);
    expect(neighborhoodSummaryData.objects[0]).toMatchObject({
      diagramIds: diagramIds.slice(0, 16),
      diagramMembershipCoverage: {
        totalDiagramCount: 500,
        omittedDiagramCount: 484,
        omittedDiagramIds: diagramIds.slice(16, 32),
        omittedDiagramIdsTruncated: true,
      },
    });

    const queryFull = await execute(tool(tools, "query_objects"), {
      text: "shared node",
      limit: 200,
      detail: "full",
    });
    const queryFullData = (queryFull as {
      ok: true;
      data: { objects: CanvasObject[] };
    }).data;
    expect(queryFullData.objects).toHaveLength(200);
    expect(queryFullData.objects[0].diagramIds).toEqual([...diagramIds].reverse());
    expect(queryFullData.objects[0]).not.toHaveProperty("diagramMembershipCoverage");

    const querySummaryBytes = new TextEncoder().encode(JSON.stringify(querySummary)).byteLength;
    const neighborhoodSummaryBytes = new TextEncoder().encode(JSON.stringify(neighborhoodSummary)).byteLength;
    const queryFullBytes = new TextEncoder().encode(JSON.stringify(queryFull)).byteLength;
    expect(querySummaryBytes).toBeLessThan(500_000);
    expect(neighborhoodSummaryBytes).toBeLessThan(500_000);
    expect(querySummaryBytes * 3).toBeLessThan(queryFullBytes);
  });

  it("finds authoritative lifecycle nodes by status and owner without reading the whole room", async () => {
    const decision = {
      ...node("auth-decision", "Use signed guest sessions", "decision", 800),
      nodeMetadata: {
        kind: "decision" as const,
        status: "accepted" as const,
        owner: "Platform team",
        resolution: "Keep authorization server-side.",
        resolvedAt: NOW - 1_000,
      },
    };
    const state = room([...Object.values(room().objects), decision]);
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, { request });

    const result = await execute(tool(tools, "query_objects"), {
      nodeTypes: ["decision"],
      nodeStatuses: ["accepted"],
      nodeOwner: "platform",
      detail: "full",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        totalMatched: 1,
        objects: [
          {
            id: "auth-decision",
            nodeType: "decision",
            nodeMetadata: {
              kind: "decision",
              status: "accepted",
              owner: "Platform team",
              resolution: "Keep authorization server-side.",
              resolvedAt: NOW - 1_000,
            },
          },
        ],
      },
    });
  });

  it("returns exact route geometry and a truthful deterministic diagram-quality report", async () => {
    const state = room();
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, { request });

    const result = await execute(tool(tools, "analyze_diagram_layout"), {
      diagramId: "architecture",
      expectedDiagramRevision: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        report: {
          diagramId: "architecture",
          diagramRevision: 1,
          status: "pass",
          metrics: { memberObjectCount: 2, connectorCount: 1, findingCount: 0 },
        },
        routes: [{
          connectorId: "api-db",
          connectorRevision: 1,
          points: [{ x: 200, y: 150 }, { x: 400, y: 150 }],
          labelBounds: expect.any(Object),
        }],
        routeCoverage: {
          totalConnectorCount: 1,
          returnedConnectorCount: 1,
          truncated: false,
          omittedConnectorCount: 0,
          omittedConnectorIds: [],
          omittedConnectorIdsTruncated: false,
        },
        visualInspectionStatus: "not_performed",
        nextStep: expect.stringMatching(/intent-unaware.*preserve deliberate overlap.*Geometry analysis alone is not visual QA/i),
      },
    });

    const stale = await execute(tool(tools, "analyze_diagram_layout"), {
      diagramId: "architecture",
      expectedDiagramRevision: 99,
    });
    expect(stale).toMatchObject({
      ok: false,
      error: {
        code: "REVISION_CONFLICT",
        details: { expectedRevision: 99, currentRevision: 1 },
      },
    });
  });

  it("returns all routes for the schema-maximum 500-member and 500-connector Diagram", async () => {
    const state = room();
    const memberIds = Array.from({ length: 500 }, (_, index) => `member-${String(index).padStart(3, "0")}`);
    const connectorIds = Array.from({ length: 500 }, (_, index) => `route-${String(index).padStart(3, "0")}`);
    const members = memberIds.map((memberId, index) => ({
      ...node(memberId, `Member ${index}`, "component", index * 400),
      diagramIds: ["architecture"],
    }));
    const connectors = connectorIds.map((connectorId, index) => ({
      ...connector(),
      id: connectorId,
      x: index * 400 + 200,
      width: index === connectorIds.length - 1 ? (connectorIds.length - 1) * 400 : 200,
      start: {
        x: index * 400 + 200,
        y: 150,
        objectId: memberIds[index],
      },
      end: {
        x: index === connectorIds.length - 1 ? 0 : (index + 1) * 400,
        y: 150,
        objectId: memberIds[(index + 1) % memberIds.length],
      },
    }));
    state.objects = {
      ...Object.fromEntries(members.map((member) => [member.id, member])),
      ...Object.fromEntries(connectors.map((item) => [item.id, item])),
    };
    state.diagrams.architecture = {
      ...state.diagrams.architecture,
      memberObjectIds: memberIds,
      connectorIds,
    };
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, { request });

    const result = await execute(tool(tools, "analyze_diagram_layout"), {
      diagramId: "architecture",
      expectedDiagramRevision: 1,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        report: {
          metrics: {
            memberObjectCount: memberIds.length,
            connectorCount: connectorIds.length,
            findingsTruncated: true,
          },
        },
        routeCoverage: {
          totalConnectorCount: connectorIds.length,
          returnedConnectorCount: connectorIds.length,
          truncated: false,
          omittedConnectorCount: 0,
          omittedConnectorIds: [],
          omittedConnectorIdsTruncated: false,
        },
      },
    });
    const data = (result as { ok: true; data: { routes: unknown[] } }).data;
    expect(data.routes).toHaveLength(connectorIds.length);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(1_000_000);
  });

  it("bounds omitted legacy route IDs while preserving exact coverage counts", async () => {
    const state = room();
    const connectorIds = Array.from({ length: 570 }, (_, index) =>
      `legacy-route-${String(index).padStart(3, "0")}`);
    state.objects = {
      api: state.objects.api,
      db: state.objects.db,
      ...Object.fromEntries(connectorIds.map((connectorId) => [
        connectorId,
        { ...connector(), id: connectorId, label: "" },
      ])),
    };
    state.diagrams.architecture = { ...diagram(), connectorIds };
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, { request });

    const result = await execute(tool(tools, "analyze_diagram_layout"), {
      diagramId: "architecture",
      expectedDiagramRevision: 1,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        routeCoverage: {
          totalConnectorCount: connectorIds.length,
          returnedConnectorCount: 500,
          truncated: true,
          omittedConnectorCount: 70,
          omittedConnectorIds: connectorIds.slice(500, 564),
          omittedConnectorIdsTruncated: true,
        },
      },
    });
    const data = (result as { ok: true; data: { routes: unknown[] } }).data;
    expect(data.routes).toHaveLength(500);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(1_000_000);
  });

  it("counts missing and non-connector legacy declarations as omitted routes", async () => {
    const state = room();
    state.diagrams.architecture = {
      ...diagram(),
      connectorIds: ["missing-connector", "api", "api-db"],
    };
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, { request });

    const result = await execute(tool(tools, "analyze_diagram_layout"), {
      diagramId: "architecture",
      expectedDiagramRevision: 1,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        routes: [{ connectorId: "api-db" }],
        routeCoverage: {
          totalConnectorCount: 3,
          returnedConnectorCount: 1,
          truncated: true,
          omittedConnectorCount: 2,
          omittedConnectorIds: ["api", "missing-connector"],
          omittedConnectorIdsTruncated: false,
        },
      },
    });
  });
});

describe("transactional semantic mutations", () => {
  it("defaults applied results to certain compact receipts while detailed preserves legacy objects", async () => {
    const baseline = room([]);
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        transaction: Parameters<typeof applySemanticTransaction>[3];
      };
      const result = applySemanticTransaction(baseline, "alice", "agent", body.transaction, NOW + 10);
      return {
        ok: true,
        outcome: "applied",
        ...result,
        activity: null,
        proposal: null,
      };
    }) as unknown as WebMcpRequest;
    const counts = new Map<string, number>();
    const tools = createJazzboardSemanticWebMcpTools(fixture(baseline).binding, {
      request,
      createId(prefix) {
        const count = (counts.get(prefix) ?? 0) + 1;
        counts.set(prefix, count);
        return `${prefix}_${count}`;
      },
    });
    const operations = [
      {
        op: "create_node",
        tempRef: "api",
        semanticName: "Checkout API",
        semanticRole: "architecture.service",
        label: "Checkout API",
        nodeType: "service",
        x: 0,
        y: 0,
      },
      {
        op: "create_node",
        tempRef: "db",
        semanticName: "Orders database",
        semanticRole: "architecture.database",
        label: "Orders DB",
        nodeType: "component",
        x: 500,
        y: 0,
      },
      {
        op: "connect",
        tempRef: "writes",
        semanticName: "Writes orders",
        semanticRole: "architecture.request_flow",
        start: { tempRef: "api" },
        end: { tempRef: "db" },
        label: "writes",
      },
      {
        op: "create_diagram",
        tempRef: "architecture",
        title: "Checkout architecture",
      },
    ];

    const concise = await execute(tool(tools, "apply_canvas_transaction"), { operations });
    expect(concise).toMatchObject({
      ok: true,
      data: {
        outcome: "applied",
        roomRevision: 8,
        temporaryReferences: {
          api: "node_1",
          db: "node_2",
          writes: "connector_1",
          architecture: "diagram_1",
        },
        changedObjectIds: ["node_1", "node_2", "connector_1"],
        deletedObjectIds: [],
        changedDiagramIds: ["diagram_1"],
        deletedDiagramIds: [],
        objects: expect.arrayContaining([
          expect.objectContaining({
            id: "node_1",
            revision: 1,
            kind: "shape",
            semanticName: "Checkout API",
            semanticRole: "architecture.service",
            bounds: { x: 0, y: 0, width: 280, height: 152 },
          }),
          expect.objectContaining({
            id: "connector_1",
            kind: "connector",
            startObjectId: "node_1",
            endObjectId: "node_2",
          }),
        ]),
        diagrams: [{
          id: "diagram_1",
          revision: 1,
          title: "Checkout architecture",
          bounds: expect.any(Object),
          memberObjectCount: 2,
          connectorCount: 1,
        }],
        relationshipReview: {
          coverage: {
            totalConnectorCount: 1,
            returnedConnectorCount: 1,
            limit: 200,
            truncated: false,
            omittedConnectorCount: 0,
          },
          items: [{
            connectorId: "connector_1",
            connectorTempRef: "writes",
            semanticName: "Writes orders",
            label: "writes",
            direction: "end",
            start: {
              objectId: "node_1",
              tempRef: "api",
              semanticName: "Checkout API",
              displayText: "Checkout API",
            },
            end: {
              objectId: "node_2",
              tempRef: "db",
              semanticName: "Orders database",
              displayText: "Orders DB",
            },
          }],
        },
        validation: {
          totalChangedDiagramCount: 1,
          analyzedDiagramCount: 1,
          diagrams: [{ diagramId: "diagram_1", diagramRevision: 1 }],
        },
        visualInspectionStatus: "not_performed",
        recommendedInspection: {
          tool: "inspect_canvas_scope",
          input: {
            scope: { kind: "diagram", diagramId: "diagram_1", expectedRevision: 1 },
            padding: 24,
            representation: "working_set",
          },
        },
        activity: null,
        proposal: null,
      },
    });
    const conciseData = (concise as { ok: true; data: Record<string, unknown> }).data;
    expect(conciseData).not.toHaveProperty("positions");
    expect(conciseData).not.toHaveProperty("visualQuality");
    expect(conciseData).not.toHaveProperty("verification");
    expect((conciseData.objects as Array<Record<string, unknown>>)[0]).not.toHaveProperty("label");
    expect((conciseData.objects as Array<Record<string, unknown>>)[0]).not.toHaveProperty("createdAt");
    expect((conciseData.diagrams as Array<Record<string, unknown>>)[0]).not.toHaveProperty("memberObjectIds");

    const detailed = await execute(tool(tools, "apply_canvas_transaction"), {
      operations,
      responseDetail: "detailed",
    });
    expect(detailed).toMatchObject({
      ok: true,
      data: {
        outcome: "applied",
        roomRevision: 8,
        temporaryReferences: {
          api: "node_3",
          db: "node_4",
          writes: "connector_2",
          architecture: "diagram_2",
        },
        objects: expect.arrayContaining([
          expect.objectContaining({ id: "node_3", label: "Checkout API", createdAt: NOW + 10 }),
        ]),
        diagrams: [{
          id: "diagram_2",
          memberObjectIds: ["node_3", "node_4"],
          connectorIds: ["connector_2"],
        }],
        relationshipReview: {
          items: [{
            connectorId: "connector_2",
            connectorTempRef: "writes",
            start: expect.objectContaining({ objectId: "node_3", tempRef: "api" }),
            end: expect.objectContaining({ objectId: "node_4", tempRef: "db" }),
          }],
        },
        visualQuality: [{ diagramId: "diagram_2", diagramRevision: 1 }],
        verification: { visualInspectionStatus: "not_performed" },
      },
    });
    const detailedData = (detailed as { ok: true; data: Record<string, unknown> }).data;
    expect(detailedData).not.toHaveProperty("positions");
    expect(detailedData).not.toHaveProperty("recommendedInspection");
    expect(detailedData).not.toHaveProperty("validation");
  });

  it("keeps a 200-operation concise receipt bounded and materially smaller than detailed", async () => {
    const baseline = room([]);
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        transaction: Parameters<typeof applySemanticTransaction>[3];
      };
      const result = applySemanticTransaction(baseline, "alice", "agent", body.transaction, NOW + 20);
      return {
        ok: true,
        outcome: "applied",
        ...result,
        activity: null,
        proposal: null,
      };
    }) as unknown as WebMcpRequest;
    let nextId = 0;
    const tools = createJazzboardSemanticWebMcpTools(fixture(baseline).binding, {
      request,
      createId: (prefix) => `${prefix}_${++nextId}`,
    });
    const operations = Array.from({ length: 200 }, (_, index) => ({
      op: "create_text",
      tempRef: `note_${String(index).padStart(3, "0")}`,
      content: `Record ${index}: ${"x".repeat(2_048)}`,
    }));

    const concise = await execute(tool(tools, "apply_canvas_transaction"), { operations });
    const detailed = await execute(tool(tools, "apply_canvas_transaction"), {
      operations,
      responseDetail: "detailed",
    });
    expect(concise).toMatchObject({
      ok: true,
      data: {
        outcome: "applied",
        changedObjectIds: expect.arrayContaining(["text_1", "text_200"]),
        objects: expect.arrayContaining([
          expect.objectContaining({ id: "text_1", revision: 1, kind: "text", bounds: expect.any(Object) }),
        ]),
        recommendedInspection: {
          tool: "inspect_canvas_scope",
          input: {
            scope: { kind: "objects", targets: expect.any(Array) },
            representation: "overview",
          },
        },
      },
    });
    const conciseData = (concise as {
      ok: true;
      data: {
        objects: Array<Record<string, unknown>>;
        recommendedInspection: { input: { scope: { targets: unknown[] } } };
      };
    }).data;
    const detailedData = (detailed as {
      ok: true;
      data: { objects: Array<Record<string, unknown>> };
    }).data;
    expect(conciseData.objects).toHaveLength(200);
    expect(conciseData.objects[0]).not.toHaveProperty("content");
    expect(conciseData.objects[0]).not.toHaveProperty("createdBy");
    expect(conciseData.recommendedInspection.input.scope.targets).toHaveLength(200);
    expect(detailedData.objects).toHaveLength(200);
    expect(detailedData.objects[0]).toHaveProperty("content", operations[0].content);

    const conciseBytes = new TextEncoder().encode(JSON.stringify(concise)).byteLength;
    const detailedBytes = new TextEncoder().encode(JSON.stringify(detailed)).byteLength;
    expect(conciseBytes).toBeLessThan(100_000);
    expect(conciseBytes * 2).toBeLessThan(detailedBytes);
  });

  it("recommends exact whole-room composition context when new work joins existing content", async () => {
    const baseline = room([node("existing", "Existing board content", "component", 40)]);
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        transaction: Parameters<typeof applySemanticTransaction>[3];
      };
      const result = applySemanticTransaction(baseline, "alice", "agent", body.transaction, NOW + 20);
      return {
        ok: true,
        outcome: "applied",
        ...result,
        activity: null,
        proposal: null,
      };
    }) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(baseline).binding, {
      request,
      createId: () => "text_new",
    });

    const result = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [{
        op: "create_text",
        tempRef: "new_caption",
        content: "New composition",
        x: 900,
        y: 120,
      }],
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        recommendedInspection: {
          tool: "inspect_canvas_scope",
          input: {
            scope: {
              kind: "objects",
              targets: [{ objectId: "text_new", expectedRevision: 1 }],
            },
          },
        },
        recommendedCompositionInspection: {
          tool: "inspect_canvas_scope",
          input: {
            scope: { kind: "room", expectedRevision: 8 },
            padding: 24,
            representation: "overview",
          },
        },
      },
    });
  });

  it("recommends an overview for an exact Diagram scope above the working-set ceiling", async () => {
    const memberObjectIds = Array.from({ length: 121 }, (_, index) =>
      `node-${String(index).padStart(3, "0")}`);
    const state = room([]);
    state.roomRevision = 8;
    state.objects = Object.fromEntries(memberObjectIds.map((objectId, index) => [
      objectId,
      {
        ...node(objectId, `Node ${index}`, "component", index * 240),
        diagramIds: ["large-diagram"],
      },
    ]));
    state.diagrams = {
      "large-diagram": {
        ...diagram(),
        id: "large-diagram",
        revision: 9,
        title: "Large Diagram",
        memberObjectIds,
        connectorIds: [],
        bounds: { x: 0, y: 100, width: 121 * 240, height: 100 },
      },
    };
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      room: state,
      changedObjectIds: [],
      changedDiagramIds: ["large-diagram"],
      membershipObjectIds: memberObjectIds,
      activity: null,
      proposal: null,
    })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, {
      request,
      createId: (prefix) => `${prefix}_1`,
    });

    const result = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [{ op: "create_text", tempRef: "note", content: "Ignored by mock" }],
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        recommendedInspection: {
          tool: "inspect_canvas_scope",
          input: {
            scope: { kind: "diagram", diagramId: "large-diagram", expectedRevision: 9 },
            padding: 24,
            representation: "overview",
          },
        },
      },
    });
  });

  it("bounds automatic quality reports and names every Diagram requiring explicit analysis", async () => {
    const state = room();
    const diagramIds = Array.from({ length: 80 }, (_, index) =>
      `architecture-${String(index).padStart(3, "0")}`);
    state.diagrams = Object.fromEntries(diagramIds.map((diagramId, index) => [
      diagramId,
      { ...diagram(), id: diagramId, revision: index + 1 },
    ]));
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      room: state,
      changedObjectIds: [],
      changedDiagramIds: [...diagramIds].reverse(),
      membershipObjectIds: [],
      activity: null,
      proposal: null,
    })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, {
      request,
      createId: () => "text-1",
    });

    const result = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [{ op: "create_text", tempRef: "note", content: "Bounded quality" }],
      responseDetail: "detailed",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        visualQuality: diagramIds.slice(0, 8).map((diagramId) => ({ diagramId })),
        visualQualityOmittedDiagramIds: diagramIds.slice(8, 72),
        visualQualityOmittedDiagramCount: 72,
        visualQualityOmittedDiagramIdsTruncated: true,
        verification: {
          geometryQualityStatus: "unknown",
          coverageStatus: "partial",
          omittedDiagramCount: 72,
          omittedDiagramIdsTruncated: true,
          completionStatus: "verification_required",
          nextStep: expect.stringContaining(diagramIds[8]),
        },
      },
    });
    const bounded = (result as {
      ok: true;
      data: { visualQualityOmittedDiagramIds: string[]; verification: { nextStep: string } };
    }).data;
    expect(bounded.visualQualityOmittedDiagramIds).toHaveLength(64);
    expect(bounded.verification.nextStep).not.toContain(diagramIds.at(-1)!);
    expect(bounded.verification.nextStep).toContain("additional IDs omitted");
  });

  it("marks freehand geometry coverage partial without hiding a known deterministic failure", async () => {
    const run = async (overlap: boolean) => {
      const stroke = drawing();
      const state = room([
        node("api", "Checkout API", "service", 0),
        node("db", "Orders DB", "component", overlap ? 100 : 400),
        connector(),
        stroke,
      ]);
      state.diagrams.architecture = {
        ...diagram(),
        memberObjectIds: ["api", "db", stroke.id],
      };
      const request = vi.fn(async () => ({
        ok: true,
        outcome: "applied",
        room: state,
        changedObjectIds: [],
        changedDiagramIds: ["architecture"],
        membershipObjectIds: [],
        activity: null,
        proposal: null,
      })) as unknown as WebMcpRequest;
      const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, {
        request,
        createId: () => "text-1",
      });
      return execute(tool(tools, "apply_canvas_transaction"), {
        operations: [{ op: "create_text", tempRef: "note", content: "Coverage check" }],
        responseDetail: "detailed",
      });
    };

    const partialPass = await run(false);
    expect(partialPass).toMatchObject({
      ok: true,
      data: {
        visualQuality: [{
          status: "pass",
          geometryCoverage: {
            status: "partial",
            unsupportedDrawObjectIds: ["freehand-note"],
          },
          metrics: { unsupportedDrawMemberCount: 1 },
        }],
        verification: {
          geometryQualityStatus: "unknown",
          coverageStatus: "partial",
          partialGeometryDiagramIds: ["architecture"],
          visualInspectionStatus: "not_performed",
          nextStep: expect.stringMatching(/report\.status alone cannot certify/i),
        },
      },
    });

    const partialFailure = await run(true);
    expect(partialFailure).toMatchObject({
      ok: true,
      data: {
        visualQuality: [{ status: "fail", geometryCoverage: { status: "partial" } }],
        verification: {
          geometryQualityStatus: "fail",
          coverageStatus: "partial",
          partialGeometryDiagramIds: ["architecture"],
        },
      },
    });
  });

  it("returns an explicit proposed outcome when review mode queues the atomic transaction", async () => {
    const state = { ...room([]), agentEditPolicy: "review" as const };
    const local = fixture(state);
    const proposal = {
      id: "proposal_1",
      roomId: state.id,
      revision: 1,
      status: "pending" as const,
      createdAt: NOW,
      updatedAt: NOW,
      baselineRoomRevision: state.roomRevision,
      author: actor("agent"),
      intent: "Draft the session boundary",
      summary: null,
      purpose: {
        kind: "semantic_transaction" as const,
        label: "Apply 1 semantic operation",
        operationCount: 1,
        objectIds: ["node_1"],
        diagramIds: [],
        layout: null,
      },
      review: null,
    };
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "proposed",
      room: { ...state, roomRevision: state.roomRevision + 1 },
      changedObjectIds: [],
      changedDiagramIds: [],
      membershipObjectIds: [],
      activity: null,
      proposal,
    })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(local.binding, {
      request,
      createId: () => "node_1",
    });

    const result = await execute(tool(tools, "apply_canvas_transaction"), {
      intent: "Draft the session boundary",
      operations: [
        { op: "create_node", tempRef: "session", label: "Session service", nodeType: "service" },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "proposed",
        temporaryReferences: { session: "node_1" },
        changedObjectIds: [],
        objects: [],
        activity: null,
        proposal: { id: "proposal_1", status: "pending" },
      },
    });
  });

  it("resolves operation-specific temporary references only within one request", async () => {
    const local = fixture(room([]));
    let authoritative = local.getRoom();
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        action: "transaction";
        transaction: Parameters<typeof applySemanticTransaction>[3];
      };
      const result = applySemanticTransaction(authoritative, "alice", "agent", body.transaction, NOW + 100);
      authoritative = result.room;
      return { ok: true, outcome: "applied", ...result };
    }) as unknown as WebMcpRequest;
    const counts = new Map<string, number>();
    const tools = createJazzboardSemanticWebMcpTools(local.binding, {
      request,
      createId(prefix) {
        const next = (counts.get(prefix) ?? 0) + 1;
        counts.set(prefix, next);
        return `${prefix}_${next}`;
      },
    });

    const created = await execute(tool(tools, "apply_canvas_transaction"), {
      responseDetail: "detailed",
      operations: [
        { op: "create_node", tempRef: "api", label: "Checkout API", nodeType: "service", x: 0, y: 0 },
        { op: "create_node", tempRef: "db", label: "Orders DB", nodeType: "component", x: 500, y: 0 },
        {
          op: "connect",
          tempRef: "writes",
          start: { tempRef: "api" },
          end: { tempRef: "db" },
          label: "writes",
        },
        {
          op: "create_diagram",
          tempRef: "checkout",
          diagramId: "checkout-architecture",
          title: "Checkout architecture",
          diagramType: "architecture",
          members: [{ tempRef: "api" }, { tempRef: "db" }],
          connectors: [{ tempRef: "writes" }],
        },
      ],
    });

    expect(created).toMatchObject({
      ok: true,
      data: {
        temporaryReferences: {
          api: "node_1",
          db: "node_2",
          writes: "connector_1",
          checkout: "checkout-architecture",
        },
        changedDiagramIds: ["checkout-architecture"],
        visualQuality: [{ diagramId: "checkout-architecture", status: "pass" }],
        verification: {
          geometryQualityStatus: "pass",
          visualInspectionStatus: "not_performed",
          completionStatus: "verification_required",
        },
      },
    });
    expect(authoritative.objects.node_1).toMatchObject({
      semanticName: "api",
      nodeType: "service",
      diagramIds: ["checkout-architecture"],
    });
    expect(authoritative.objects.node_1).toMatchObject({ x: 0, y: 0 });
    expect(authoritative.objects.node_2).toMatchObject({ x: 500, y: 0 });
    expect(authoritative.objects.connector_1).toMatchObject({
      semanticName: "writes",
      start: { objectId: "node_1" },
      end: { objectId: "node_2" },
      diagramIds: ["checkout-architecture"],
    });
    expect(authoritative.diagrams?.["checkout-architecture"]).toMatchObject({
      memberObjectIds: ["node_1", "node_2"],
      connectorIds: ["connector_1"],
    });

    const callsBefore = (request as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const leakedAlias = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [
        {
          op: "connect",
          tempRef: "second_edge",
          start: { tempRef: "api" },
          end: { objectId: "node_2" },
        },
      ],
    });

    expect(leakedAlias).toMatchObject({ ok: false, error: { code: "UNRESOLVED_TEMP_REF" } });
    expect((request as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(callsBefore);
  });

  it("assigns explicit or tempRef-derived identity to every transaction-created canvas object", async () => {
    const state = room();
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      room: state,
      changedObjectIds: [],
      changedDiagramIds: [],
      membershipObjectIds: [],
      activity: null,
      proposal: null,
    })) as unknown as WebMcpRequest;
    const counts = new Map<string, number>();
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, {
      request,
      createId(prefix) {
        const next = (counts.get(prefix) ?? 0) + 1;
        counts.set(prefix, next);
        return `${prefix}_${next}`;
      },
    });

    const result = await execute(tool(tools, "apply_canvas_transaction"), {
      responseDetail: "detailed",
      operations: [
        {
          op: "create_drawing",
          tempRef: "mona_hair_contour",
          semanticRole: "portrait.hair.contour",
          points: [{ x: 0, y: 0 }, { x: 20, y: 30 }],
        },
        {
          op: "create_path",
          tempRef: "mona_left_eye",
          semanticName: "Mona Lisa left eye",
          semanticRole: "portrait.eye.contour",
          start: { x: 10, y: 10 },
          segments: [{ kind: "line", to: { x: 30, y: 10 } }],
        },
        {
          op: "create_polygon",
          tempRef: "mona_face_plane",
          points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 30 }],
        },
        {
          op: "create_shape",
          tempRef: "netflix_cdn_region",
          semanticRole: "architecture.region",
          label: "CDN region",
        },
        {
          op: "create_text",
          tempRef: "netflix_caption",
          content: "Netflix streaming architecture",
        },
        {
          op: "create_node",
          tempRef: "netflix_api_gateway",
          semanticName: "Netflix API gateway",
          semanticRole: "architecture.edge_service",
          label: "API gateway",
          nodeType: "service",
        },
        {
          op: "connect",
          tempRef: "netflix_request_flow",
          semanticRole: "architecture.request_flow",
          start: { tempRef: "netflix_api_gateway" },
          end: { objectId: "api" },
        },
        {
          op: "update",
          objectId: "api",
          expectedRevision: 1,
          patch: { semanticName: null, semanticRole: null },
        },
      ],
    });

    expect(result).toMatchObject({ ok: true });
    const body = JSON.parse(String(
      ((request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit).body,
    ));
    const commands = body.transaction.commands as Array<{
      type: string;
      object?: { id: string; semanticName?: string; semanticRole?: string };
      objectId?: string;
      patch?: Record<string, unknown>;
    }>;
    const created = Object.fromEntries(
      commands.flatMap((command) => command.type === "create" && command.object
        ? [[command.object.id, command.object]]
        : []),
    );
    expect(created).toMatchObject({
      draw_1: { semanticName: "mona hair contour", semanticRole: "portrait.hair.contour" },
      path_1: { semanticName: "Mona Lisa left eye", semanticRole: "portrait.eye.contour" },
      path_2: { semanticName: "mona face plane" },
      shape_1: { semanticName: "netflix cdn region", semanticRole: "architecture.region" },
      text_1: { semanticName: "netflix caption" },
      node_1: { semanticName: "Netflix API gateway", semanticRole: "architecture.edge_service" },
      connector_1: { semanticName: "netflix request flow", semanticRole: "architecture.request_flow" },
    });
    expect(commands).toContainEqual(expect.objectContaining({
      type: "update",
      objectId: "api",
      patch: { semanticName: null, semanticRole: null },
    }));
  });

  it("authors precise bound connector ports without detaching semantic endpoints", async () => {
    const state = room([]);
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      room: state,
      changedObjectIds: [],
      changedDiagramIds: [],
      membershipObjectIds: [],
      activity: null,
      proposal: null,
    })) as unknown as WebMcpRequest;
    let createdId = 0;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, {
      request,
      createId: (prefix) => `${prefix}_${++createdId}`,
    });

    await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [
        {
          op: "create_node",
          tempRef: "source",
          label: "Source",
          nodeType: "service",
          x: 100,
          y: 200,
          width: 200,
          height: 100,
        },
        {
          op: "create_node",
          tempRef: "target",
          label: "Target",
          nodeType: "service",
          x: 600,
          y: 200,
          width: 200,
          height: 100,
        },
        {
          op: "connect",
          tempRef: "edge",
          start: { tempRef: "source", port: { side: "right", position: 0.25 } },
          end: { tempRef: "target", port: { side: "left", position: 0.75 } },
          routing: { mode: "elbow" },
        },
      ],
    });

    const body = JSON.parse(String((request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body)) as {
      transaction: { commands: Array<{ object?: CanvasObject }> };
    };
    const createdConnector = body.transaction.commands
      .flatMap((command) => command.object?.kind === "connector" ? [command.object] : [])
      .at(0);
    expect(createdConnector).toMatchObject({
      kind: "connector",
      start: {
        objectId: expect.any(String),
        x: 300,
        y: 225,
        normalizedAnchor: { x: 1, y: 0.25 },
        isPrecise: true,
        isExact: false,
        snap: "edge-point",
      },
      end: {
        objectId: expect.any(String),
        x: 600,
        y: 275,
        normalizedAnchor: { x: 0, y: 0.75 },
        isPrecise: true,
        isExact: false,
        snap: "edge-point",
      },
    });
  });

  it("batches drawings and native paths while inferring omitted Diagram membership", async () => {
    const local = fixture(room([]));
    let authoritative = local.getRoom();
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        transaction: Parameters<typeof applySemanticTransaction>[3];
      };
      const result = applySemanticTransaction(authoritative, "alice", "agent", body.transaction, NOW + 105);
      authoritative = result.room;
      return { ok: true, outcome: "applied", ...result };
    }) as unknown as WebMcpRequest;
    const counts = new Map<string, number>();
    const tools = createJazzboardSemanticWebMcpTools(local.binding, {
      request,
      createId(prefix) {
        const count = (counts.get(prefix) ?? 0) + 1;
        counts.set(prefix, count);
        return `${prefix}_${count}`;
      },
    });

    const result = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [
        { op: "create_drawing", tempRef: "shadow", points: [{ x: 10, y: 20 }, { x: 40, y: 50 }] },
        {
          op: "create_path",
          tempRef: "curve",
          start: { x: 100, y: 100 },
          segments: [{ kind: "quadratic", control: { x: 150, y: 50 }, to: { x: 200, y: 100 } }],
          stroke: "#12345678",
          strokeWidth: 5,
        },
        {
          op: "create_polygon",
          tempRef: "face",
          points: [{ x: 110, y: 120 }, { x: 190, y: 120 }, { x: 150, y: 200 }],
          fill: "light-red",
          stroke: "none",
        },
        { op: "create_diagram", tempRef: "portrait", title: "Portrait" },
      ],
    });

    expect(result).toMatchObject({ ok: true, data: { outcome: "applied" } });
    expect(request).toHaveBeenCalledOnce();
    expect(authoritative.diagrams.diagram_1).toMatchObject({
      memberObjectIds: ["draw_1", "path_1", "path_2"],
      connectorIds: [],
    });
    expect(authoritative.objects.draw_1).toMatchObject({ x: 10, y: 20, width: 30, height: 30, diagramIds: ["diagram_1"] });
    expect(authoritative.objects.path_1).toMatchObject({ kind: "path", start: { x: 0, y: 1 }, diagramIds: ["diagram_1"] });
  });

  it("preserves explicit empty Diagram membership and rejects ambiguous multi-Diagram inference", async () => {
    const state = room([]);
    const request = vi.fn(async () => ({
      ok: true,
      outcome: "applied",
      room: state,
      changedObjectIds: [],
      changedDiagramIds: [],
      membershipObjectIds: [],
      activity: null,
      proposal: null,
    })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(state).binding, { request });

    await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [
        { op: "create_drawing", tempRef: "mark", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
        { op: "create_diagram", tempRef: "empty", title: "Empty", members: [], connectors: [] },
      ],
    });
    const explicitBody = JSON.parse(String((request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
    expect(explicitBody.transaction.diagramCommands[0].diagram).toMatchObject({ memberObjectIds: [], connectorIds: [] });

    const ambiguous = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [
        { op: "create_text", tempRef: "note", content: "Shared?" },
        { op: "create_diagram", tempRef: "one", title: "One" },
        { op: "create_diagram", tempRef: "two", title: "Two" },
      ],
    });
    expect(ambiguous).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).toHaveBeenCalledOnce();
  });

  it("resolves temporary object and Diagram refs into one atomic comfortable auto-layout", async () => {
    const local = fixture(room([]));
    let authoritative = local.getRoom();
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        action: "transaction";
        transaction: Parameters<typeof applySemanticTransaction>[3];
      };
      const result = applySemanticTransaction(authoritative, "alice", "agent", body.transaction, NOW + 110);
      authoritative = result.room;
      return { ok: true, ...result };
    }) as unknown as WebMcpRequest;
    const ids = ["node_client", "node_api", "connector_auth", "diagram_auth"];
    const tools = createJazzboardSemanticWebMcpTools(local.binding, {
      request,
      createId: () => ids.shift()!,
    });

    const result = await execute(tool(tools, "apply_canvas_transaction"), {
      responseDetail: "detailed",
      operations: [
        { op: "create_node", tempRef: "client", label: "Client", nodeType: "component" },
        { op: "create_node", tempRef: "api", label: "API", nodeType: "service" },
        {
          op: "connect",
          tempRef: "auth",
          start: { tempRef: "client" },
          end: { tempRef: "api" },
          label: "authorize signed cookie",
        },
        {
          op: "create_diagram",
          tempRef: "diagram",
          title: "Authorization",
          members: [{ tempRef: "client" }, { tempRef: "api" }],
          connectors: [{ tempRef: "auth" }],
        },
        {
          op: "auto_layout",
          layout: "flow",
          density: "comfortable",
          origin: { x: 100, y: 200 },
          targets: ["client", "api"],
          diagramTempRef: "diagram",
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        positions: [
          { objectId: "node_client", x: 100, y: 200 },
          { objectId: "node_api", x: 690, y: 200 },
        ],
      },
    });
    expect(authoritative.objects.node_client).toMatchObject({ revision: 1, x: 100, y: 200 });
    expect(authoritative.objects.node_api).toMatchObject({ revision: 1, x: 690, y: 200 });
    expect(authoritative.objects.connector_auth).toMatchObject({ revision: 1 });
    expect(authoritative.diagrams.diagram_auth).toMatchObject({ revision: 1 });
  });

  it("rejects explicit coordinates on auto-layout targets before mutation", async () => {
    const request = vi.fn() as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(fixture(room([])).binding, {
      request,
      createId: () => "node_1",
    });

    const result = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [
        { op: "create_node", tempRef: "node", label: "Layered node", nodeType: "component", x: 40, y: 40 },
        { op: "auto_layout", layout: "flow", targets: ["node"] },
      ],
    });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("uses shared comfortable spacing and column maxima for unspecified batch coordinates", async () => {
    const local = fixture(room([]));
    let authoritative = local.getRoom();
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        transaction: Parameters<typeof applySemanticTransaction>[3];
      };
      const result = applySemanticTransaction(authoritative, "alice", "agent", body.transaction, NOW + 115);
      authoritative = result.room;
      return { ok: true, ...result };
    }) as unknown as WebMcpRequest;
    const ids = ["wide", "next"];
    const tools = createJazzboardSemanticWebMcpTools(local.binding, {
      request,
      createId: () => ids.shift()!,
    });

    await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [
        { op: "create_shape", tempRef: "wide", width: 700 },
        { op: "create_shape", tempRef: "next" },
      ],
    });

    expect(authoritative.objects.wide).toMatchObject({ x: 80, y: 80, width: 700 });
    expect(authoritative.objects.next).toMatchObject({ x: 940, y: 80 });
  });

  it("carries lifecycle metadata and review intent through one atomic transaction", async () => {
    const local = fixture(room([]));
    let authoritative = local.getRoom();
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        action: "transaction";
        transaction: Parameters<typeof applySemanticTransaction>[3];
        metadata?: { intent?: string; summary?: string };
      };
      const result = applySemanticTransaction(authoritative, "alice", "agent", body.transaction, NOW + 125);
      authoritative = result.room;
      return { ok: true, ...result };
    }) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(local.binding, {
      request,
      createId: () => "decision_1",
    });

    const result = await execute(tool(tools, "apply_canvas_transaction"), {
      intent: "Record the agreed authorization boundary",
      summary: "Added the accepted guest-session decision",
      operations: [
        {
          op: "create_node",
          tempRef: "decision",
          label: "Use signed guest sessions",
          nodeType: "decision",
          nodeMetadata: {
            kind: "decision",
            status: "accepted",
            owner: "Platform team",
            resolution: "Keep authorization server-side.",
          },
        },
      ],
    });

    expect(result).toMatchObject({ ok: true, data: { temporaryReferences: { decision: "decision_1" } } });
    expect(authoritative.objects.decision_1).toMatchObject({
      nodeType: "decision",
      nodeMetadata: {
        kind: "decision",
        status: "accepted",
        owner: "Platform team",
        resolution: "Keep authorization server-side.",
        resolvedAt: NOW + 125,
      },
    });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/semantic",
      expect.objectContaining({ method: "POST" }),
    );
    const requestInit = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      action: "transaction",
      transaction: { commands: [expect.any(Object)] },
      metadata: {
        intent: "Record the agreed authorization boundary",
        summary: "Added the accepted guest-session decision",
      },
    });
  });

  it("uses a caller-chosen stable ID for convenience Diagram creation", async () => {
    const local = fixture(room([]));
    let authoritative = local.getRoom();
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        action: "transaction";
        transaction: Parameters<typeof applySemanticTransaction>[3];
      };
      const result = applySemanticTransaction(authoritative, "alice", "agent", body.transaction, NOW + 150);
      authoritative = result.room;
      return { ok: true, ...result };
    }) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(local.binding, { request });

    const result = await execute(tool(tools, "create_diagram"), {
      diagramId: "payments-architecture",
      title: "Payments architecture",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { diagram: { id: "payments-architecture", title: "Payments architecture", revision: 1 } },
    });
    expect(authoritative.diagrams["payments-architecture"]).toMatchObject({
      id: "payments-architecture",
      description: "",
      diagramType: "architecture",
    });
  });

  it("rejects caller-chosen Diagram IDs that collide with room state or request-local refs before mutation", async () => {
    const existing = room();
    const local = fixture(existing);
    const request = vi.fn() as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(local.binding, {
      request,
      createId: () => "generated-node",
    });

    const roomCollision = await execute(tool(tools, "create_diagram"), {
      diagramId: "api",
      title: "Conflicting ID",
    });
    expect(roomCollision).toMatchObject({ ok: false, error: { code: "DUPLICATE_SEMANTIC_ID", details: { id: "api" } } });

    const diagramCollision = await execute(tool(tools, "create_diagram"), {
      diagramId: "architecture",
      title: "Conflicting Diagram ID",
    });
    expect(diagramCollision).toMatchObject({
      ok: false,
      error: { code: "DUPLICATE_SEMANTIC_ID", details: { id: "architecture" } },
    });

    const requestRefCollision = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [
        { op: "create_node", tempRef: "node", label: "Node", nodeType: "component" },
        { op: "create_diagram", tempRef: "diagram", diagramId: "generated-node", title: "Conflicting ref" },
      ],
    });
    expect(requestRefCollision).toMatchObject({
      ok: false,
      error: { code: "DUPLICATE_SEMANTIC_ID", details: { id: "generated-node" } },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("posts deterministic layout to the agent-only semantic endpoint and accepts the authoritative response", async () => {
    const state = room();
    const local = fixture(state);
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        action: "layout";
        layout: Parameters<typeof applyLayoutCommand>[3];
      };
      const result = applyLayoutCommand(state, "alice", "agent", body.layout, NOW + 200);
      return { ok: true, outcome: "applied", ...result, activity: null, proposal: null };
    }) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(local.binding, { request });

    const result = await execute(tool(tools, "layout_objects"), {
      layout: "flow",
      targets: [
        { objectId: "api", expectedRevision: 1 },
        { objectId: "db", expectedRevision: 1 },
      ],
      diagramId: "architecture",
      expectedDiagramRevision: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "applied",
        roomRevision: 8,
        changedDiagramIds: ["architecture"],
        objects: expect.arrayContaining([
          expect.objectContaining({ id: "api", revision: 2, kind: "shape", bounds: expect.any(Object) }),
        ]),
        diagrams: [{ id: "architecture", revision: 2, memberObjectCount: 2, connectorCount: 1 }],
        visualInspectionStatus: "not_performed",
        recommendedInspection: {
          tool: "inspect_canvas_scope",
          input: {
            scope: { kind: "diagram", diagramId: "architecture", expectedRevision: 2 },
          },
        },
      },
    });
    const conciseData = (result as { ok: true; data: Record<string, unknown> }).data;
    expect(conciseData).not.toHaveProperty("positions");
    expect((conciseData.objects as Array<Record<string, unknown>>)[0]).not.toHaveProperty("label");

    const detailed = await execute(tool(tools, "layout_objects"), {
      layout: "flow",
      targets: [
        { objectId: "api", expectedRevision: 1 },
        { objectId: "db", expectedRevision: 1 },
      ],
      diagramId: "architecture",
      expectedDiagramRevision: 1,
      responseDetail: "detailed",
    });
    expect(detailed).toMatchObject({
      ok: true,
      data: {
        positions: [
          { objectId: "api", x: expect.any(Number), y: expect.any(Number) },
          { objectId: "db", x: expect.any(Number), y: expect.any(Number) },
        ],
        objects: expect.arrayContaining([expect.objectContaining({ id: "api", label: "Checkout API" })]),
        diagrams: [{ id: "architecture", memberObjectIds: ["api", "db"] }],
        visualQuality: [{ diagramId: "architecture" }],
      },
    });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/semantic",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    expect(local.accepted).toHaveLength(2);
    expect(local.getRoom().objects["api-db"].revision).toBe(2);
    expect(local.getRoom().diagrams?.architecture.revision).toBe(2);
  });
});
