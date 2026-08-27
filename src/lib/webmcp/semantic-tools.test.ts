/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

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

function fixture(initialRoom = room(), role: "participant" | "spectator" = "participant") {
  let current = initialRoom;
  const accepted: RoomState[] = [];
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
  };
  const binding: JazzboardWebMcpBinding = {
    roomId: "room/a b",
    participantId: "alice",
    role,
    context,
  };
  return { binding, context, accepted, getRoom: () => current };
}

function tool(tools: WebMCP.ModelContextTool[], name: string) {
  const match = tools.find((candidate) => candidate.name === name);
  if (!match) throw new Error(`Missing ${name}`);
  return match;
}

type JsonSchema = {
  type?: string;
  const?: unknown;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  minProperties?: number;
  minLength?: number;
  maxLength?: number;
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
  if (!conditional) throw new Error(`Missing JSON Schema operation ${op}`);
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

    const layoutRequired = schemaFor(tools, "layout_objects").required ?? [];
    expect(layoutRequired).toEqual(expect.arrayContaining(["layout", "targets"]));
    for (const field of ["direction", "primaryGap", "secondaryGap"]) expect(layoutRequired).not.toContain(field);

    const createDiagramRequired = schemaFor(tools, "create_diagram").required ?? [];
    expect(createDiagramRequired).toEqual(["title"]);
    for (const field of ["diagramId", "description", "diagramType", "category", "tags", "memberObjectIds", "connectorIds"]) {
      expect(createDiagramRequired).not.toContain(field);
    }

    const transactionSchema = schemaFor(tools, "apply_canvas_transaction");
    const connectionRequired = operationSchema(transactionSchema, "connect").required ?? [];
    expect(connectionRequired).toEqual(expect.arrayContaining(["op", "tempRef", "start", "end"]));
    for (const field of ["direction", "label", "color"]) expect(connectionRequired).not.toContain(field);
    expect(operationSchema(transactionSchema, "create_node").required).toEqual(
      expect.arrayContaining(["op", "tempRef", "label", "nodeType"]),
    );
    const batchDiagramRequired = operationSchema(transactionSchema, "create_diagram").required ?? [];
    expect(batchDiagramRequired).toEqual(expect.arrayContaining(["op", "tempRef", "title"]));
    expect(batchDiagramRequired).not.toContain("diagramId");

    const autoLayoutRequired = operationSchema(transactionSchema, "auto_layout").required ?? [];
    expect(autoLayoutRequired).toEqual(expect.arrayContaining(["op", "layout", "targets"]));
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
    const patchSchema = transactionSchema.$defs?.patch;
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
      direction: "both",
      alt: "Accessible description",
      locked: true,
    };

    expect(patchSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      minProperties: 1,
    });
    expect(Object.keys(patchSchema?.properties ?? {})).toEqual(Object.keys(acceptedPatch));
    expect(patchSchema?.properties?.width).toMatchObject({
      type: "number",
      exclusiveMinimum: 0,
      maximum: 100_000,
    });
    expect(patchSchema?.properties?.content).toMatchObject({ type: "string", maxLength: 20_000 });
    expect(patchSchema?.properties?.start).toEqual({ $ref: "#/$defs/connectorEndpoint" });
    expect(patchSchema?.properties?.nodeMetadata?.anyOf).toEqual([
      { $ref: "#/$defs/nodeMetadata" },
      { type: "null" },
    ]);
    const metadataVariants = transactionSchema.$defs?.nodeMetadata?.oneOf ?? [];
    for (const [kind, unresolvedStatus, resolvedStatuses] of [
      ["decision", "proposed", ["accepted", "rejected", "superseded"]],
      ["open_question", "open", ["answered", "deferred", "closed"]],
    ] as const) {
      const variant = metadataVariants.find((candidate) => candidate.properties?.kind?.const === kind);
      expect(variant).toMatchObject({ additionalProperties: false, required: ["kind"] });
      expect(variant?.allOf).toEqual(expect.arrayContaining([
        expect.objectContaining({
          if: { properties: { status: { const: unresolvedStatus } } },
          then: { properties: { resolution: { type: "null" } } },
        }),
        expect.objectContaining({
          if: {
            required: ["status"],
            properties: { status: { enum: [...resolvedStatuses] } },
          },
          then: expect.objectContaining({ required: ["resolution"] }),
        }),
      ]));
    }

    const accepted = await execute(tool(tools, "apply_canvas_transaction"), {
      operations: [{ op: "update", objectId: "api", expectedRevision: 1, patch: acceptedPatch }],
    });
    expect(accepted).toMatchObject({ ok: true });
    const requestBody = JSON.parse(String(
      ((request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit).body,
    ));
    expect(requestBody.transaction.commands[0].patch).toEqual(acceptedPatch);

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
});

describe("transactional semantic mutations", () => {
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
      return { ok: true, ...result };
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
