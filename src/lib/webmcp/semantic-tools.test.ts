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

    const createDiagramRequired = schemaFor(tools, "create_diagram").required ?? [];
    expect(createDiagramRequired).toEqual(["title"]);
    for (const field of ["diagramId", "description", "diagramType", "category", "tags", "memberObjectIds", "connectorIds"]) {
      expect(createDiagramRequired).not.toContain(field);
    }

    const transactionSchema = schemaFor(tools, "apply_canvas_transaction");
    expect(transactionSchema.properties?.operations?.items?.properties?.routing).toEqual({ type: "object" });
    const connectionRequired = operationSchema(transactionSchema, "connect").required ?? [];
    expect(connectionRequired).toEqual(["op"]);
    for (const field of ["direction", "label", "color"]) expect(connectionRequired).not.toContain(field);
    expect(transactionSchema.properties?.operations?.items?.properties?.start?.description)
      .toMatch(/objectId\|tempRef/);
    const createNodeSchema = operationSchema(transactionSchema, "create_node");
    expect(createNodeSchema.required).toEqual(["op"]);
    expect(transactionSchema.properties?.operations?.items?.properties?.nodeMetadata).toEqual({ type: "object" });
    const batchDiagramRequired = operationSchema(transactionSchema, "create_diagram").required ?? [];
    expect(batchDiagramRequired).toEqual(["op"]);
    expect(batchDiagramRequired).not.toContain("diagramId");
    expect(operationSchema(transactionSchema, "edit_diagram").required).toEqual(["op"]);

    const autoLayoutRequired = operationSchema(transactionSchema, "auto_layout").required ?? [];
    expect(autoLayoutRequired).toEqual(["op"]);
    expect(autoLayoutRequired).not.toContain("density");
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
      description: expect.stringMatching(/normalized object-local 0\.\.1/),
    });
    expect(transactionSchema.properties?.operations?.items?.properties?.segments?.description)
      .toMatch(/quadratic.*control.*cubic.*control1\/control2/);

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

    const rejected = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [{ op: "update", objectId: "api", expectedRevision: 1, patch: { surprise: true } }],
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
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
    expect(request).toHaveBeenCalledTimes(1);
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
  it("advertises and enforces the optional create-or-replace draft delivery contract", async () => {
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
    });
    expect(validates({ operations, delivery: { mode: "draft" } })).toBe(true);
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
      data: { totalMatched: 1, objects: [{ id: "api", nodeType: "service" }] },
    });
    expect(request).toHaveBeenCalledWith("/api/rooms/room%2Fa%20b", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(local.getRoom().participants.alice).toMatchObject({ agentActive: false, agent: { activity: null } });
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
        connectors: [{ id: "api-db", start: { objectId: "api" }, end: { objectId: "db" } }],
        diagrams: [{ id: "architecture", revision: 1 }],
      },
    });
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
    expect(authoritative.objects.node_1).toMatchObject({ nodeType: "service", diagramIds: ["checkout-architecture"] });
    expect(authoritative.objects.node_1).toMatchObject({ x: 0, y: 0 });
    expect(authoritative.objects.node_2).toMatchObject({ x: 500, y: 0 });
    expect(authoritative.objects.connector_1).toMatchObject({
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
      return { ok: true, ...result };
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

    expect(result).toMatchObject({ ok: true, data: { changedDiagramIds: ["architecture"] } });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/agent/semantic",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    expect(local.accepted).toHaveLength(1);
    expect(local.getRoom().objects["api-db"].revision).toBe(2);
    expect(local.getRoom().diagrams?.architecture.revision).toBe(2);
  });
});
