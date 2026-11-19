/// <reference types="webmcp-types" />

import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";

import type { ActorRef, CanvasObject, Diagram, RoomState, Viewport } from "@/lib/domain/types";

import { createJazzboardSemanticWebMcpTools } from "./semantic-tools";
import type { JazzboardToolResult, JazzboardWebMcpBinding, WebMcpRequest } from "./types";

const NOW = 9_000_000;

function actor(): ActorRef {
  return { participantId: "reader", displayName: "Reader", color: "blue", kind: "human" };
}

function object(id: string, zIndex: number): CanvasObject {
  return {
    id,
    kind: "shape",
    x: zIndex * 10,
    y: 0,
    width: 100,
    height: 60,
    rotation: 0,
    zIndex,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(),
    lastEditedBy: actor(),
    shape: "rectangle",
    nodeType: "component",
    label: `Object ${id}`,
    fill: "blue",
    stroke: "blue",
  };
}

function diagram(id: string, updatedAt: number): Diagram {
  return {
    id,
    title: `Diagram ${id}`,
    description: "Paginated diagram",
    diagramType: "architecture",
    category: null,
    tags: [],
    memberObjectIds: [],
    connectorIds: [],
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    revision: 1,
    createdAt: NOW,
    updatedAt,
    createdBy: actor(),
    lastEditedBy: actor(),
  };
}

function room(objectCount: number, diagramCount: number, roomRevision = 10): RoomState {
  const objects = Array.from({ length: objectCount }, (_, index) => {
    const id = `object-${String(index).padStart(3, "0")}`;
    return object(id, index);
  });
  const diagrams = Array.from({ length: diagramCount }, (_, index) => {
    const id = `diagram-${String(index).padStart(3, "0")}`;
    return diagram(id, NOW - index);
  });
  return {
    id: "pagination-room",
    code: "PAGE10",
    title: "Pagination",
    roomRevision,
    createdAt: NOW,
    updatedAt: NOW,
    participants: {},
    objects: Object.fromEntries(objects.map((item) => [item.id, item])),
    diagrams: Object.fromEntries(diagrams.map((item) => [item.id, item])),
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function binding(role: "participant" | "spectator" = "participant"): JazzboardWebMcpBinding {
  return {
    roomId: "pagination-room",
    participantId: "reader",
    role,
    context: {
      getRoom: () => null,
      getSelection: () => [],
      getViewport: () => ({ x: 0, y: 0, width: 1_200, height: 800, zoom: 1 } satisfies Viewport),
      getFollowTarget: () => null,
      acceptRoom: () => undefined,
      setFollowTarget: () => undefined,
      setDeclinedSpotlight: () => undefined,
      leaveRoomView: () => undefined,
    },
  };
}

function tool(tools: WebMCP.ModelContextTool[], name: string): WebMCP.ModelContextTool {
  const match = tools.find((candidate) => candidate.name === name);
  if (!match) throw new Error(`Missing ${name}`);
  return match;
}

async function execute(toolToRun: WebMCP.ModelContextTool, input: Record<string, unknown>) {
  return (await toolToRun.execute(input, { signal: new AbortController().signal })) as JazzboardToolResult;
}

type PageData<T> = {
  roomRevision: number;
  offset: number;
  nextOffset: number | null;
  totalMatched: number;
  truncated: boolean;
  nextPageInput: Record<string, unknown> | null;
  objects?: T[];
  diagrams?: T[];
  missingObjectIds?: string[];
};

function data<T>(result: JazzboardToolResult): PageData<T> {
  if (!result.ok) throw new Error(`Expected successful page, received ${result.error.code}`);
  return result.data as PageData<T>;
}

describe("revision-pinned semantic pagination", () => {
  it("reads every object and all 500 diagrams without skips or duplicates", async () => {
    const state = room(475, 500);
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(binding(), { request });

    const objectIds: string[] = [];
    let objectInput: Record<string, unknown> | null = { limit: 137 };
    while (objectInput) {
      const page: PageData<{ id: string }> = data(await execute(
        tool(tools, "query_objects"),
        objectInput,
      ));
      objectIds.push(...page.objects!.map(({ id }) => id));
      expect(page.totalMatched).toBe(475);
      expect(page.truncated).toBe(page.nextOffset !== null);
      objectInput = page.nextPageInput;
    }
    expect(objectIds).toHaveLength(475);
    expect(new Set(objectIds).size).toBe(475);
    expect(objectIds).toEqual(Array.from({ length: 475 }, (_, index) =>
      `object-${String(index).padStart(3, "0")}`));

    const diagramIds: string[] = [];
    let diagramInput: Record<string, unknown> | null = { limit: 100 };
    while (diagramInput) {
      const page: PageData<{ id: string }> = data(await execute(
        tool(tools, "find_diagrams"),
        diagramInput,
      ));
      diagramIds.push(...page.diagrams!.map(({ id }) => id));
      expect(page.totalMatched).toBe(500);
      diagramInput = page.nextPageInput;
    }
    expect(diagramIds).toHaveLength(500);
    expect(new Set(diagramIds).size).toBe(500);
    expect(diagramIds).toEqual(Array.from({ length: 500 }, (_, index) =>
      `diagram-${String(index).padStart(3, "0")}`));
  });

  it("filters exact object IDs and reports only nonexistent requested IDs as missing", async () => {
    const state = room(5, 0);
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const query = tool(createJazzboardSemanticWebMcpTools(binding(), { request }), "query_objects");

    const result = data<{ id: string }>(await execute(query, {
      objectIds: ["object-003", "missing", "object-001"],
      text: "object object-001",
    }));

    expect(result.objects?.map(({ id }) => id)).toEqual(["object-001"]);
    expect(result.totalMatched).toBe(1);
    expect(result.missingObjectIds).toEqual(["missing"]);
  });

  it("rejects stale continuation pages without returning partial data", async () => {
    const firstRoom = room(120, 0, 10);
    const editedRoom = room(121, 0, 11);
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true, room: firstRoom })
      .mockResolvedValueOnce({ ok: true, room: editedRoom }) as unknown as WebMcpRequest;
    const query = tool(createJazzboardSemanticWebMcpTools(binding(), { request }), "query_objects");
    const first = data<{ id: string }>(await execute(query, { limit: 50 }));

    expect(first.nextPageInput).toMatchObject({
      limit: 50,
      offset: 50,
      expectedRoomRevision: 10,
    });
    const stale = await execute(query, first.nextPageInput!);
    expect(stale).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: "ROOM_REVISION_CONFLICT",
        details: { expectedRoomRevision: 10, actualRoomRevision: 11 },
      }),
    }));
    expect(stale).not.toHaveProperty("data");
  });

  it("keeps runtime validation and compact discovery schemas in parity", async () => {
    const state = room(3, 3);
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(binding(), { request });

    for (const name of ["query_objects", "find_diagrams"]) {
      const read = tool(tools, name);
      const validates = new Ajv({ allErrors: true, strict: false }).compile(read.inputSchema as object);
      expect(validates({ offset: 1 })).toBe(false);
      expect(validates({ offset: 0 })).toBe(true);
      expect(validates({ offset: 1, expectedRoomRevision: 10 })).toBe(true);
      await expect(execute(read, { offset: 1 })).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_TOOL_INPUT" },
      });
    }

    expect((tool(tools, "query_objects").inputSchema as {
      properties: { offset: { maximum: number } };
    }).properties.offset.maximum).toBe(5_000);
    expect((tool(tools, "find_diagrams").inputSchema as {
      properties: { offset: { maximum: number } };
    }).properties.offset.maximum).toBe(500);
    await expect(execute(tool(tools, "query_objects"), {
      offset: 5_001,
      expectedRoomRevision: 10,
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    await expect(execute(tool(tools, "find_diagrams"), {
      offset: 501,
      expectedRoomRevision: 10,
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });

    const querySchema = tool(tools, "query_objects").inputSchema as {
      properties: { objectIds: { minItems: number; maxItems: number } };
    };
    expect(querySchema.properties.objectIds).toMatchObject({ minItems: 1, maxItems: 200 });
    await expect(execute(tool(tools, "query_objects"), {
      objectIds: Array.from({ length: 201 }, (_, index) => `id-${index}`),
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
  });

  it("allows spectators to paginate through the same read-only tools", async () => {
    const state = room(60, 125);
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const tools = createJazzboardSemanticWebMcpTools(binding("spectator"), { request });
    const query = tool(tools, "query_objects");
    const diagrams = tool(tools, "find_diagrams");

    expect(query.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    expect(diagrams.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    const objectFirst = data<{ id: string }>(await execute(query, { limit: 50 }));
    const objectSecond = data<{ id: string }>(await execute(query, objectFirst.nextPageInput!));
    expect([...objectFirst.objects!, ...objectSecond.objects!]).toHaveLength(60);
    const diagramFirst = data<{ id: string }>(await execute(diagrams, { limit: 100 }));
    const diagramSecond = data<{ id: string }>(await execute(diagrams, diagramFirst.nextPageInput!));
    expect([...diagramFirst.diagrams!, ...diagramSecond.diagrams!]).toHaveLength(125);
  });
});


describe("compact authoring inspection", () => {
  it("returns all 64 IDs, geometry and styles in two bounded revision-pinned pages", async () => {
    const state = room(64, 0);
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const query = tool(createJazzboardSemanticWebMcpTools(binding(), { request }), "query_objects");
    const first = data<Record<string, unknown>>(await execute(query, { detail: "compact" }));
    const second = data<Record<string, unknown>>(await execute(query, first.nextPageInput!));
    expect(first.objects).toHaveLength(50);
    expect(second.objects).toHaveLength(14);
    expect(first.nextPageInput).toMatchObject({ detail: "compact", offset: 50, expectedRoomRevision: state.roomRevision });
    const objects = [...first.objects!, ...second.objects!];
    expect(new Set(objects.map((object) => object.id)).size).toBe(64);
    expect(first.objects![0]).toMatchObject({ geometry: { x: 0, y: 0, width: 100, height: 60 }, fill: "blue", stroke: "blue" });
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThan(45_000);
    expect(await execute(query, { detail: "compact", limit: 51 })).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(await execute(query, { detail: "summary", measureText: true })).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
  });

  it("rejects a compact continuation after a concurrent edit", async () => {
    const initial = room(64, 0);
    const request = vi.fn().mockResolvedValueOnce({ ok: true, room: initial }).mockResolvedValueOnce({ ok: true, room: { ...initial, roomRevision: initial.roomRevision + 1 } }) as unknown as WebMcpRequest;
    const query = tool(createJazzboardSemanticWebMcpTools(binding(), { request }), "query_objects");
    const first = data(await execute(query, { detail: "compact" }));
    expect(await execute(query, first.nextPageInput!)).toMatchObject({ ok: false, error: { code: "ROOM_REVISION_CONFLICT" } });
  });
});


describe("compact UTF-8 response byte budget", () => {
  it("shrinks pages for large Unicode metadata without dropping or repeating objects", async () => {
    const state = room(80, 0);
    for (const object of Object.values(state.objects)) {
      object.semanticName = "界".repeat(160);
      object.semanticRole = "界".repeat(128);
      if (object.kind === "shape") object.label = "界".repeat(10_000);
    }
    const request = vi.fn(async () => ({ ok: true, room: state })) as unknown as WebMcpRequest;
    const query = tool(createJazzboardSemanticWebMcpTools(binding(), { request }), "query_objects");
    let input: Record<string, unknown> | null = { detail: "compact" };
    const ids: unknown[] = [];
    const counts: number[] = [];
    while (input) {
      const page: PageData<Record<string, unknown>> = data(await execute(query, input));
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(60_000);
      expect(page.objects!.length).toBeGreaterThan(0);
      counts.push(page.objects!.length);
      ids.push(...page.objects!.map((object) => object.id));
      input = page.nextPageInput;
    }
    expect(counts[0]).toBeLessThan(50);
    expect(ids).toHaveLength(80);
    expect(new Set(ids).size).toBe(80);
    expect(new Set(ids)).toEqual(new Set(Object.keys(state.objects)));
  });
});
