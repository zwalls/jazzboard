/// <reference types="webmcp-types" />

import { expect, test, type Page } from "@playwright/test";

import { createRoomFromLanding, expectBuiltInTldrawWatermark, getRoom } from "./helpers";

const LANDING_WEBMCP_TOOL_NAMES = [
  "create_room",
  "join_room",
  "list_recent_rooms",
  "open_recent_room",
  "remove_recent_room",
] as const;

const SHARED_ROOM_READ_TOOL_NAMES = [
  "read_room_state",
  "read_selection",
  "read_collaboration_state",
  "query_objects",
  "read_neighborhood",
  "find_diagrams",
  "read_diagram",
  "describe_diagram",
  "list_activity",
  "read_activity",
  "export_canvas_artifact",
  "list_agent_edit_proposals",
  "read_agent_edit_proposal",
] as const;

const PARTICIPANT_ONLY_READ_TOOL_NAMES = [
  "create_diagram_template",
  "list_readonly_snapshots",
] as const;

const ROOM_MUTATION_TOOL_NAMES = [
  "create_text",
  "create_shape",
  "create_node",
  "add_image",
  "create_drawing",
  "draw_connection",
  "update_object",
  "move_objects",
  "group_objects",
  "delete_objects",
  "focus_viewport",
  "follow_participant",
  "stop_following",
  "start_spotlight",
  "request_spotlight",
  "stop_spotlight",
  "join_spotlight",
  "leave_spotlight",
  "approve_spotlight_handoff",
  "dismiss_spotlight_request",
  "leave_room",
  "apply_canvas_transaction",
  "layout_objects",
  "create_diagram",
  "edit_diagram",
  "revert_activity",
  "create_readonly_snapshot",
  "revoke_readonly_snapshot",
  "instantiate_diagram_template",
  "enable_agent_review",
] as const;

const PARTICIPANT_ROOM_TOOL_NAMES = [
  ...SHARED_ROOM_READ_TOOL_NAMES,
  ...PARTICIPANT_ONLY_READ_TOOL_NAMES,
  ...ROOM_MUTATION_TOOL_NAMES,
] as const;
const SPECTATOR_ROOM_TOOL_NAMES = [...SHARED_ROOM_READ_TOOL_NAMES] as const;

const WEBMCP_TEXT = "Written through browser WebMCP";
const REJECTED_LABEL = "MUST_NOT_COMMIT_E2E";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAQKc7S8AAAAASUVORK5CYII=",
  "base64",
);

type WebMcpToolResult<T> =
  | { ok: true; tool: string; data: T }
  | { ok: false; tool: string; error: { code: string; message: string; details?: unknown } };

type ToolMetadata = {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
};

type LandingRoomData = {
  room: { id: string; code: string; title: string };
  role: "participant" | "spectator";
  path: string;
};

type RecentRoomsData = {
  scope: "current_browser_and_signed_session";
  rooms: Array<{ roomId: string; code: string; title: string; role: string }>;
};

type CanvasObjectData = {
  id: string;
  kind: string;
  revision: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  content?: string;
  nodeType?: string | null;
  start?: { objectId: string | null };
  end?: { objectId: string | null };
};

type DiagramData = {
  id: string;
  title: string;
  description: string;
  diagramType: string;
  category: string | null;
  tags: string[];
  memberObjectIds: string[];
  connectorIds: string[];
  bounds: { x: number; y: number; width: number; height: number };
  revision: number;
  createdBy: { participantId: string; kind: "human" | "agent" };
  lastEditedBy: { participantId: string; kind: "human" | "agent" };
};

type TransactionData = {
  roomRevision: number;
  temporaryReferences: Record<string, string>;
  changedObjectIds: string[];
  changedDiagramIds: string[];
  objects: CanvasObjectData[];
  diagrams: DiagramData[];
};

type ReadDiagramData = {
  roomRevision: number;
  diagram: DiagramData;
  objects: CanvasObjectData[];
  connectors: CanvasObjectData[];
};

type QueryData = {
  roomRevision: number;
  totalMatched: number;
  truncated: boolean;
  objects: CanvasObjectData[];
};

type NeighborhoodData = {
  roomRevision: number;
  rootObjectIds: string[];
  missingObjectIds: string[];
  depthReached: number;
  truncated: boolean;
  objects: CanvasObjectData[];
  connectors: CanvasObjectData[];
  diagrams: DiagramData[];
};

type LayoutData = {
  roomRevision: number;
  changedObjectIds: string[];
  changedDiagramIds: string[];
  positions: Array<{ objectId: string; x: number; y: number }>;
  diagrams: DiagramData[];
};

type CreateObjectData = {
  changedObjectIds: string[];
  objects: CanvasObjectData[];
};

type ReadRoomData = {
  room: { id: string; roomRevision: number };
  objects: CanvasObjectData[];
  participants: Array<{ participantId: string; role: string; agentActive: boolean }>;
};

async function installWebMcpShim(page: Page) {
  await page.addInitScript(() => {
    const tools = new Map<string, WebMCP.ModelContextTool>();
    const browserWindow = window as Window & {
      __jazzboardWebMcpTools?: Map<string, WebMCP.ModelContextTool>;
    };
    browserWindow.__jazzboardWebMcpTools = tools;

    const modelContext = new EventTarget() as WebMCP.ModelContext;
    modelContext.ontoolchange = null;
    modelContext.registerTool = async (tool, options) => {
      tools.set(tool.name, tool);
      options?.signal?.addEventListener(
        "abort",
        () => {
          if (tools.get(tool.name) === tool) tools.delete(tool.name);
        },
        { once: true },
      );
    };
    modelContext.getTools = async () =>
      [...tools.values()].map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        window,
        origin: window.location.origin,
        annotations: tool.annotations,
      }));

    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: modelContext,
    });
  });
}

async function registeredToolMetadata(page: Page): Promise<ToolMetadata[]> {
  return page.evaluate(() => {
    const tools = (window as Window & {
      __jazzboardWebMcpTools?: Map<string, WebMCP.ModelContextTool>;
    }).__jazzboardWebMcpTools;
    return [...(tools?.values() ?? [])]
      .map((tool) => ({ name: tool.name, annotations: tool.annotations }))
      .sort((left, right) => left.name.localeCompare(right.name));
  });
}

async function registeredToolNames(page: Page): Promise<string[]> {
  return (await registeredToolMetadata(page)).map((tool) => tool.name);
}

async function expectRegisteredSurface(
  page: Page,
  expectedNames: readonly string[],
): Promise<ToolMetadata[]> {
  const expected = [...expectedNames].sort();
  await expect.poll(() => registeredToolNames(page), { timeout: 15_000 }).toEqual(expected);
  return registeredToolMetadata(page);
}

async function callWebMcpTool<T>(page: Page, name: string, input: Record<string, unknown>) {
  return page.evaluate(
    async ({ toolName, toolInput }) => {
      const tools = (window as Window & {
        __jazzboardWebMcpTools?: Map<string, WebMCP.ModelContextTool>;
      }).__jazzboardWebMcpTools;
      const tool = tools?.get(toolName);
      if (!tool) throw new Error(`WebMCP tool ${toolName} is not registered.`);
      return tool.execute(toolInput, { signal: new AbortController().signal });
    },
    { toolName: name, toolInput: input },
  ) as Promise<WebMcpToolResult<T>>;
}

async function callNavigationTool<T>(
  page: Page,
  name: string,
  input: Record<string, unknown>,
  expectedUrl: RegExp,
): Promise<WebMcpToolResult<T>> {
  const navigation = page.waitForURL(expectedUrl, { timeout: 20_000 });
  const result = await callWebMcpTool<T>(page, name, input);
  await navigation;
  return result;
}

function successData<T>(result: WebMcpToolResult<T>): T {
  if (!result.ok) throw new Error(`${result.tool} failed: ${result.error.code} ${result.error.message}`);
  return result.data;
}

function expectReadOnlySurface(metadata: ToolMetadata[], expectedNames: readonly string[]) {
  expect(metadata.map((tool) => tool.name)).toEqual([...expectedNames].sort());
  for (const tool of metadata) {
    expect(tool.annotations?.readOnlyHint, `${tool.name} must be truthfully read-only`).toBe(true);
    expect(tool.annotations?.untrustedContentHint, `${tool.name} returns room/session content`).toBe(true);
  }
}

test.describe("WebMCP browser acceptance", () => {
  test("covers private landing actions, 45 participant tools, lifecycle actions, and semantic Diagram operations", async ({
    browser,
    page,
  }) => {
    test.setTimeout(180_000);
    expect(PARTICIPANT_ROOM_TOOL_NAMES).toHaveLength(45);
    expect(SPECTATOR_ROOM_TOOL_NAMES).toHaveLength(13);

    await installWebMcpShim(page);
    await page.goto("/");
    const landingMetadata = await expectRegisteredSurface(page, LANDING_WEBMCP_TOOL_NAMES);
    expect(landingMetadata.find((tool) => tool.name === "list_recent_rooms")?.annotations?.readOnlyHint).toBe(true);
    for (const toolName of ["create_room", "join_room", "open_recent_room", "remove_recent_room"]) {
      expect(landingMetadata.find((tool) => tool.name === toolName)?.annotations?.readOnlyHint).not.toBe(true);
    }

    const emptyRecents = successData(
      await callWebMcpTool<RecentRoomsData>(page, "list_recent_rooms", {}),
    );
    expect(emptyRecents).toEqual({ scope: "current_browser_and_signed_session", rooms: [] });

    const invalidJoin = await callWebMcpTool<never>(page, "join_room", {
      code: "42",
      displayName: "Invalid exact-code attempt",
      role: "participant",
    });
    expect(invalidJoin).toMatchObject({
      ok: false,
      tool: "join_room",
      error: { code: "INVALID_TOOL_INPUT" },
    });

    const created = successData(
      await callNavigationTool<LandingRoomData>(
        page,
        "create_room",
        { displayName: "WebMCP Host", title: "WebMCP semantic acceptance" },
        /\/room\/room_[^/?#]+$/,
      ),
    );
    expect(created).toMatchObject({
      role: "participant",
      room: { code: expect.stringMatching(/^\d{4}$/), title: "WebMCP semantic acceptance" },
    });
    await expect(page.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });

    const participantMetadata = await expectRegisteredSurface(page, PARTICIPANT_ROOM_TOOL_NAMES);
    await expect(page.getByTitle("WebMCP site tools status")).toContainText("45 site tools");
    for (const toolName of [...SHARED_ROOM_READ_TOOL_NAMES, ...PARTICIPANT_ONLY_READ_TOOL_NAMES]) {
      expect(participantMetadata.find((tool) => tool.name === toolName)?.annotations?.readOnlyHint).toBe(true);
    }
    for (const toolName of ROOM_MUTATION_TOOL_NAMES) {
      expect(participantMetadata.find((tool) => tool.name === toolName)?.annotations?.readOnlyHint).not.toBe(true);
    }

    const hostBefore = successData(await callWebMcpTool<ReadRoomData>(page, "read_room_state", {}));
    const hostMembershipBefore = hostBefore.participants.find(
      (participant) => participant.participantId === (hostBefore.participants.find((item) => item.role === "participant")?.participantId),
    );
    expect(hostMembershipBefore?.agentActive).toBe(false);

    const transaction = successData(
      await callWebMcpTool<TransactionData>(page, "apply_canvas_transaction", {
        operations: [
          {
            op: "create_node",
            tempRef: "web_client",
            label: "Web client",
            nodeType: "component",
          },
          {
            op: "create_node",
            tempRef: "room_api",
            label: "Room API",
            nodeType: "service",
          },
          {
            op: "create_node",
            tempRef: "guest_session",
            label: "Guest-session authorization",
            nodeType: "requirement",
          },
          {
            op: "create_node",
            tempRef: "redis_store",
            label: "Redis room state",
            nodeType: "service",
          },
          {
            op: "connect",
            tempRef: "client_api",
            start: { tempRef: "web_client" },
            end: { tempRef: "room_api" },
            direction: "end",
            label: "exact-code request",
          },
          {
            op: "connect",
            tempRef: "api_session",
            start: { tempRef: "room_api" },
            end: { tempRef: "guest_session" },
            direction: "end",
            label: "authorize signed cookie",
          },
          {
            op: "connect",
            tempRef: "session_redis",
            start: { tempRef: "guest_session" },
            end: { tempRef: "redis_store" },
            direction: "end",
            label: "load membership",
          },
          {
            op: "create_diagram",
            tempRef: "auth_flow",
            diagramId: "diagram_authentication_request_flow_e2e",
            title: "Authentication request flow",
            description: "Shows how the web client, room API, guest-session authorization, and Redis interact.",
            diagramType: "flow",
            category: "security",
            tags: ["authentication", "guest-session", "redis"],
            members: [
              { tempRef: "web_client" },
              { tempRef: "room_api" },
              { tempRef: "guest_session" },
              { tempRef: "redis_store" },
            ],
            connectors: [
              { tempRef: "client_api" },
              { tempRef: "api_session" },
              { tempRef: "session_redis" },
            ],
          },
        ],
      }),
    );

    expect(transaction.changedObjectIds).toHaveLength(7);
    expect(transaction.changedDiagramIds).toHaveLength(1);
    expect(Object.keys(transaction.temporaryReferences)).toEqual(
      expect.arrayContaining([
        "web_client",
        "room_api",
        "guest_session",
        "redis_store",
        "client_api",
        "api_session",
        "session_redis",
        "auth_flow",
      ]),
    );

    const refs = transaction.temporaryReferences;
    const diagramId = refs.auth_flow;
    expect(diagramId).toBe("diagram_authentication_request_flow_e2e");
    const memberIds = [refs.web_client, refs.room_api, refs.guest_session, refs.redis_store];
    const connectorIds = [refs.client_api, refs.api_session, refs.session_redis];
    expect(transaction.diagrams[0]).toMatchObject({
      id: diagramId,
      title: "Authentication request flow",
      diagramType: "flow",
      category: "security",
      tags: ["authentication", "guest-session", "redis"],
      memberObjectIds: memberIds,
      connectorIds,
      revision: 1,
      createdBy: { kind: "agent" },
      lastEditedBy: { kind: "agent" },
    });

    // A server-projected, bound tldraw arrow must settle. Binding geometry is
    // derived UI state and must not echo back as perpetual human edits.
    await page.waitForTimeout(900);
    const settledProjection = await getRoom(page.request, created.room.id);
    const settledDiagramRevision = settledProjection.room.diagrams[diagramId].revision;
    const settledConnectorRevisions = connectorIds.map(
      (connectorId) => settledProjection.room.objects[connectorId].revision,
    );
    await page.waitForTimeout(900);
    const idleProjection = await getRoom(page.request, created.room.id);
    expect(idleProjection.room.diagrams[diagramId].revision).toBe(settledDiagramRevision);
    expect(
      connectorIds.map((connectorId) => idleProjection.room.objects[connectorId].revision),
    ).toEqual(settledConnectorRevisions);
    expect(Object.keys(idleProjection.room.leases)).toEqual([]);

    const drawing = successData(
      await callWebMcpTool<CreateObjectData>(page, "create_drawing", {
        points: [
          { x: 80, y: 540 },
          { x: 140, y: 500 },
          { x: 220, y: 550 },
          { x: 300, y: 510 },
        ],
        color: "red",
        size: "m",
      }),
    );
    expect(drawing).toMatchObject({
      changedObjectIds: [expect.any(String)],
      objects: [{ kind: "draw", revision: 1 }],
    });

    const found = successData(
      await callWebMcpTool<{ totalMatched: number; diagrams: DiagramData[] }>(page, "find_diagrams", {
        text: "Authentication request flow",
        tags: ["guest-session"],
      }),
    );
    expect(found).toMatchObject({
      totalMatched: 1,
      diagrams: [{ id: diagramId, description: expect.stringContaining("Redis interact") }],
    });

    const described = successData(
      await callWebMcpTool<{
        diagram: DiagramData;
        counts: { members: number; connectors: number; nodeTypes: Record<string, number> };
      }>(page, "describe_diagram", { diagramId }),
    );
    expect(described).toMatchObject({
      diagram: { id: diagramId, title: "Authentication request flow", revision: 1 },
      counts: {
        members: 4,
        connectors: 3,
        nodeTypes: { component: 1, service: 2, requirement: 1, decision: 0, open_question: 0 },
      },
    });

    const diagramBeforeLayout = successData(
      await callWebMcpTool<ReadDiagramData>(page, "read_diagram", { diagramId }),
    );
    expect(diagramBeforeLayout.objects.map((object) => object.id)).toEqual(memberIds);
    expect(diagramBeforeLayout.connectors.map((object) => object.id)).toEqual(connectorIds);
    expect(diagramBeforeLayout.connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: refs.client_api,
          start: expect.objectContaining({ objectId: refs.web_client }),
          end: expect.objectContaining({ objectId: refs.room_api }),
        }),
      ]),
    );

    const serviceQuery = successData(
      await callWebMcpTool<QueryData>(page, "query_objects", {
        diagramId,
        kinds: ["shape"],
        nodeTypes: ["service"],
        limit: 10,
      }),
    );
    expect(serviceQuery).toMatchObject({ totalMatched: 2, truncated: false });
    expect(serviceQuery.objects.map((object) => object.id).sort()).toEqual(
      [refs.room_api, refs.redis_store].sort(),
    );
    expect(serviceQuery.objects.every((object) => object.nodeType === "service")).toBe(true);

    const neighborhood = successData(
      await callWebMcpTool<NeighborhoodData>(page, "read_neighborhood", {
        objectIds: [refs.room_api],
        depth: 1,
        direction: "both",
        includeDiagramPeers: false,
        maxObjects: 20,
      }),
    );
    expect(neighborhood).toMatchObject({
      rootObjectIds: [refs.room_api],
      missingObjectIds: [],
      depthReached: 1,
      truncated: false,
      diagrams: [{ id: diagramId }],
    });
    expect(neighborhood.objects.map((object) => object.id)).toEqual(
      expect.arrayContaining([refs.web_client, refs.room_api, refs.guest_session]),
    );
    expect(neighborhood.objects.map((object) => object.id)).not.toContain(refs.redis_store);
    expect(neighborhood.connectors.map((object) => object.id).sort()).toEqual(
      [refs.client_api, refs.api_session].sort(),
    );

    const layout = successData(
      await callWebMcpTool<LayoutData>(page, "layout_objects", {
        layout: "flow",
        direction: "right",
        origin: { x: 120, y: 160 },
        primaryGap: 80,
        secondaryGap: 60,
        diagramId,
        expectedDiagramRevision: diagramBeforeLayout.diagram.revision,
        targets: diagramBeforeLayout.objects.map((object) => ({
          objectId: object.id,
          expectedRevision: object.revision,
        })),
      }),
    );
    expect(layout.positions).toEqual([
      { objectId: refs.web_client, x: 120, y: 160 },
      { objectId: refs.room_api, x: 480, y: 160 },
      { objectId: refs.guest_session, x: 840, y: 160 },
      { objectId: refs.redis_store, x: 1_200, y: 160 },
    ]);
    expect(layout.changedObjectIds).toEqual(expect.arrayContaining([...memberIds, ...connectorIds]));
    expect(layout.changedDiagramIds).toEqual([diagramId]);

    const diagramAfterLayout = successData(
      await callWebMcpTool<ReadDiagramData>(page, "read_diagram", { diagramId }),
    );
    expect(diagramAfterLayout.diagram).toMatchObject({
      id: diagramId,
      revision: 2,
      bounds: { x: 120, y: 160, width: 1_360, height: 152 },
      memberObjectIds: memberIds,
      connectorIds,
      lastEditedBy: { kind: "agent" },
    });
    expect(diagramAfterLayout.connectors).toEqual(
      expect.arrayContaining(
        connectorIds.map((id) => expect.objectContaining({ id, revision: 2 })),
      ),
    );

    const editedDiagram = successData(
      await callWebMcpTool<{ diagram: DiagramData }>(page, "edit_diagram", {
        diagramId,
        expectedRevision: diagramAfterLayout.diagram.revision,
        description: "Production-ready semantic authentication flow with authorization and persistence boundaries.",
        tags: ["authentication", "guest-session", "redis", "production"],
      }),
    );
    expect(editedDiagram.diagram).toMatchObject({
      id: diagramId,
      revision: 3,
      description: expect.stringContaining("Production-ready semantic authentication flow"),
      tags: ["authentication", "guest-session", "redis", "production"],
      memberObjectIds: memberIds,
      connectorIds,
      bounds: diagramAfterLayout.diagram.bounds,
    });

    const rejected = await callWebMcpTool<TransactionData>(page, "apply_canvas_transaction", {
      operations: [
        {
          op: "create_node",
          tempRef: "must_not_commit",
          label: REJECTED_LABEL,
          nodeType: "open_question",
        },
        {
          op: "update",
          objectId: refs.room_api,
          expectedRevision: 1,
          patch: { label: "Stale update must fail" },
        },
      ],
    });
    expect(rejected).toMatchObject({
      ok: false,
      tool: "apply_canvas_transaction",
      error: { code: "REVISION_CONFLICT" },
    });
    const absentRejectedNode = successData(
      await callWebMcpTool<QueryData>(page, "query_objects", { text: REJECTED_LABEL }),
    );
    expect(absentRejectedNode).toMatchObject({ totalMatched: 0, objects: [] });

    const semanticExport = successData(
      await callWebMcpTool<{
        format: string;
        artifact: { title: string; objects: CanvasObjectData[]; diagrams: DiagramData[] };
        sourceDiagramRevision: number;
      }>(page, "export_canvas_artifact", {
        format: "semantic_json",
        scope: { kind: "diagram", diagramId },
      }),
    );
    expect(semanticExport).toMatchObject({
      format: "semantic_json",
      artifact: {
        title: "Authentication request flow",
        objects: expect.arrayContaining(memberIds.map((id) => expect.objectContaining({ id }))),
        diagrams: [expect.objectContaining({ id: diagramId })],
      },
    });

    const mermaidExport = successData(
      await callWebMcpTool<{ format: string; content: string }>(page, "export_canvas_artifact", {
        format: "mermaid",
        scope: { kind: "diagram", diagramId },
      }),
    );
    expect(mermaidExport.content).toContain("flowchart LR");
    expect(mermaidExport.content).toContain("Room API");

    const svgExport = successData(
      await callWebMcpTool<{ format: string; content: string }>(page, "export_canvas_artifact", {
        format: "svg",
        scope: { kind: "diagram", diagramId },
      }),
    );
    expect(svgExport.content).toMatch(/^<svg[^>]+>/);
    expect(svgExport.content).not.toMatch(/<script|<foreignObject|\shref=/i);

    const templateExport = successData(
      await callWebMcpTool<{ template: Record<string, unknown>; sourceDiagramRevision: number }>(
        page,
        "create_diagram_template",
        { diagramId },
      ),
    );
    expect(templateExport).toMatchObject({
      template: { kind: "template", title: "Authentication request flow" },
      sourceDiagramRevision: expect.any(Number),
    });

    let currentDiagramForSnapshot = successData(
      await callWebMcpTool<ReadDiagramData>(page, "read_diagram", { diagramId }),
    );
    type CreateSnapshotData = {
        ok: true;
        snapshot: { id: string; path: string; title: string; expiresAt: number };
      };
    const createSnapshot = () =>
      callWebMcpTool<CreateSnapshotData>(page, "create_readonly_snapshot", {
        expectedRoomRevision: currentDiagramForSnapshot.roomRevision,
        scope: {
          kind: "diagram",
          diagramId,
          expectedDiagramRevision: currentDiagramForSnapshot.diagram.revision,
        },
        expiresInHours: 24,
      });
    let createSnapshotResult = await createSnapshot();
    if (!createSnapshotResult.ok && createSnapshotResult.error.code === "REVISION_CONFLICT") {
      currentDiagramForSnapshot = successData(
        await callWebMcpTool<ReadDiagramData>(page, "read_diagram", { diagramId }),
      );
      createSnapshotResult = await createSnapshot();
    }
    const createdSnapshot = successData(createSnapshotResult);
    expect(createdSnapshot.snapshot).toMatchObject({
      id: expect.stringMatching(/^snapshot_/),
      path: expect.stringMatching(/^\/snapshot\/[A-Za-z0-9_-]{43}$/),
      title: "Authentication request flow",
    });
    const snapshotResponse = await page.request.get(
      new URL(createdSnapshot.snapshot.path, page.url()).toString(),
    );
    expect(snapshotResponse.status()).toBe(200);
    expect(await snapshotResponse.text()).toContain("Read-only snapshot");
    const listedSnapshots = successData(
      await callWebMcpTool<{ ok: true; snapshots: Array<{ id: string }> }>(
        page,
        "list_readonly_snapshots",
        {},
      ),
    );
    expect(listedSnapshots.snapshots).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: createdSnapshot.snapshot.id })]),
    );

    const reviewEnabled = successData(
      await callWebMcpTool<{ policy: string; changed: boolean; roomRevision: number }>(
        page,
        "enable_agent_review",
        {},
      ),
    );
    expect(reviewEnabled).toMatchObject({ policy: "review", changed: true });

    const currentRoomApi = successData(
      await callWebMcpTool<ReadRoomData>(page, "read_room_state", { objectIds: [refs.room_api] }),
    ).objects[0];
    const proposedUpdate = successData(
      await callWebMcpTool<{
        outcome: "applied" | "proposed";
        changedObjectIds: string[];
        proposal: { id: string; revision: number; status: string } | null;
      }>(page, "update_object", {
        objectId: refs.room_api,
        expectedRevision: currentRoomApi.revision,
        patch: { label: "Authorized room API" },
        intent: "Clarify the server authorization boundary",
        summary: "Rename Room API after human review",
      }),
    );
    expect(proposedUpdate).toMatchObject({
      outcome: "proposed",
      changedObjectIds: [],
      proposal: { status: "pending" },
    });
    if (!proposedUpdate.proposal) throw new Error("Review mode did not return a proposal.");

    const pendingProposals = successData(
      await callWebMcpTool<{
        policy: string;
        proposals: Array<{ id: string; revision: number; intent: string | null }>;
      }>(page, "list_agent_edit_proposals", { status: "pending", limit: 20 }),
    );
    expect(pendingProposals).toMatchObject({
      policy: "review",
      proposals: [expect.objectContaining({
        id: proposedUpdate.proposal.id,
        intent: "Clarify the server authorization boundary",
      })],
    });
    const exactProposal = successData(
      await callWebMcpTool<{ id: string; request: { kind: string } }>(
        page,
        "read_agent_edit_proposal",
        { proposalId: proposedUpdate.proposal.id },
      ),
    );
    expect(exactProposal).toMatchObject({
      id: proposedUpdate.proposal.id,
      request: { kind: "canvas_command" },
    });

    const approvalResponse = await page.request.post(
      `/api/rooms/${encodeURIComponent(created.room.id)}/review/${encodeURIComponent(proposedUpdate.proposal.id)}`,
      {
        data: {
          action: "approve",
          expectedProposalRevision: proposedUpdate.proposal.revision,
          note: "Approved by the human WebMCP acceptance flow",
        },
      },
    );
    expect(approvalResponse.status()).toBe(200);
    expect(await approvalResponse.json()).toMatchObject({
      ok: true,
      outcome: "applied",
      proposal: { status: "applied", review: { decision: "approved" } },
    });
    const approvedQuery = successData(
      await callWebMcpTool<QueryData>(page, "query_objects", { text: "Authorized room API" }),
    );
    expect(approvedQuery).toMatchObject({ totalMatched: 1, objects: [{ id: refs.room_api }] });

    const beforeTemplateProposal = successData(
      await callWebMcpTool<ReadRoomData>(page, "read_room_state", {}),
    );
    const proposedTemplate = successData(
      await callWebMcpTool<{
        outcome: "applied" | "proposed";
        changedObjectIds: string[];
        proposal: { id: string; revision: number; status: string } | null;
      }>(page, "instantiate_diagram_template", {
        expectedRoomRevision: beforeTemplateProposal.room.roomRevision,
        template: templateExport.template,
        origin: { x: 120, y: 520 },
        intent: "Reuse the authentication flow",
      }),
    );
    expect(proposedTemplate).toMatchObject({ outcome: "proposed", changedObjectIds: [], proposal: { status: "pending" } });
    if (!proposedTemplate.proposal) throw new Error("Template instantiation bypassed review mode.");
    const rejectionResponse = await page.request.post(
      `/api/rooms/${encodeURIComponent(created.room.id)}/review/${encodeURIComponent(proposedTemplate.proposal.id)}`,
      {
        data: {
          action: "reject",
          expectedProposalRevision: proposedTemplate.proposal.revision,
          note: "Acceptance test keeps one Diagram",
        },
      },
    );
    expect(rejectionResponse.status()).toBe(200);
    expect(await rejectionResponse.json()).toMatchObject({ ok: true, outcome: "rejected" });

    const activityList = successData(
      await callWebMcpTool<{ activities: Array<{ id: string; actor: { kind: string } }> }>(
        page,
        "list_activity",
        { actorKind: "agent", limit: 20 },
      ),
    );
    expect(activityList.activities.some((item) => item.actor.kind === "agent")).toBe(true);

    const revokedSnapshot = successData(
      await callWebMcpTool<{ ok: true; snapshotId: string; revoked: boolean }>(
        page,
        "revoke_readonly_snapshot",
        { snapshotId: createdSnapshot.snapshot.id },
      ),
    );
    expect(revokedSnapshot).toMatchObject({
      snapshotId: createdSnapshot.snapshot.id,
      revoked: true,
    });
    expect((await page.request.get(new URL(createdSnapshot.snapshot.path, page.url()).toString())).status()).toBe(404);

    const host = await getRoom(page.request, created.room.id);
    expect(host.room.participants[host.participantId].agentActive).toBe(true);

    const collaboratorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const collaboratorPage = await collaboratorContext.newPage();
      await installWebMcpShim(collaboratorPage);
      await collaboratorPage.goto("/");
      await expectRegisteredSurface(collaboratorPage, LANDING_WEBMCP_TOOL_NAMES);

      const joined = successData(
        await callNavigationTool<LandingRoomData>(
          collaboratorPage,
          "join_room",
          { code: created.room.code, displayName: "Lifecycle Collaborator", role: "participant" },
          /\/room\/room_[^/?#]+$/,
        ),
      );
      expect(joined).toMatchObject({ room: { id: created.room.id }, role: "participant" });
      await expect(collaboratorPage.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });
      await expectRegisteredSurface(collaboratorPage, PARTICIPANT_ROOM_TOOL_NAMES);

      const collaboratorRoom = await getRoom(collaboratorContext.request, created.room.id);
      expect(collaboratorRoom.room.participants[collaboratorRoom.participantId].agentActive).toBe(false);
      successData(
        await callWebMcpTool<Record<string, unknown>>(collaboratorPage, "focus_viewport", {
          x: 0,
          y: 0,
          width: 900,
          height: 700,
          zoom: 1,
        }),
      );

      successData(
        await callWebMcpTool<Record<string, unknown>>(page, "follow_participant", {
          participantId: collaboratorRoom.participantId,
          target: "agent",
        }),
      );
      const following = successData(
        await callWebMcpTool<{
          follow: { mode: string; target: { participantId: string; kind: string } | null };
        }>(page, "read_collaboration_state", {}),
      );
      expect(following.follow).toMatchObject({
        mode: "private",
        target: { participantId: collaboratorRoom.participantId, kind: "agent" },
      });
      successData(await callWebMcpTool<Record<string, unknown>>(page, "stop_following", {}));

      successData(
        await callWebMcpTool<Record<string, unknown>>(page, "start_spotlight", { target: "agent" }),
      );
      successData(
        await callWebMcpTool<Record<string, unknown>>(collaboratorPage, "join_spotlight", {}),
      );
      successData(
        await callWebMcpTool<Record<string, unknown>>(collaboratorPage, "request_spotlight", {
          target: "agent",
        }),
      );
      successData(
        await callWebMcpTool<Record<string, unknown>>(page, "approve_spotlight_handoff", {}),
      );
      successData(await callWebMcpTool<Record<string, unknown>>(page, "join_spotlight", {}));
      successData(await callWebMcpTool<Record<string, unknown>>(page, "leave_spotlight", {}));
      successData(
        await callWebMcpTool<Record<string, unknown>>(collaboratorPage, "stop_spotlight", {}),
      );

      successData(
        await callWebMcpTool<Record<string, unknown>>(page, "start_spotlight", { target: "human" }),
      );
      successData(
        await callWebMcpTool<Record<string, unknown>>(collaboratorPage, "request_spotlight", {
          target: "human",
        }),
      );
      successData(
        await callWebMcpTool<Record<string, unknown>>(page, "dismiss_spotlight_request", {}),
      );
      successData(await callWebMcpTool<Record<string, unknown>>(page, "stop_spotlight", {}));

      const left = successData(
        await callNavigationTool<{ leftRoomId: string; path: string; membershipRetained: boolean }>(
          collaboratorPage,
          "leave_room",
          {},
          /\/$/,
        ),
      );
      expect(left).toMatchObject({
        leftRoomId: created.room.id,
        path: "/",
        membershipRetained: true,
      });
      await expectRegisteredSurface(collaboratorPage, LANDING_WEBMCP_TOOL_NAMES);

      const recents = successData(
        await callWebMcpTool<RecentRoomsData>(collaboratorPage, "list_recent_rooms", {}),
      );
      expect(recents.rooms).toEqual([
        expect.objectContaining({
          roomId: created.room.id,
          code: created.room.code,
          role: "participant",
        }),
      ]);

      const reopened = successData(
        await callNavigationTool<LandingRoomData>(
          collaboratorPage,
          "open_recent_room",
          { roomId: created.room.id },
          /\/room\/room_[^/?#]+$/,
        ),
      );
      expect(reopened).toMatchObject({
        room: { id: created.room.id },
        role: "participant",
        authorizationVerified: true,
      });
      await expectRegisteredSurface(collaboratorPage, PARTICIPANT_ROOM_TOOL_NAMES);
      successData(
        await callNavigationTool<Record<string, unknown>>(
          collaboratorPage,
          "leave_room",
          {},
          /\/$/,
        ),
      );
      await expectRegisteredSurface(collaboratorPage, LANDING_WEBMCP_TOOL_NAMES);

      const removed = successData(
        await callWebMcpTool<{
          sharedRoomDeleted: boolean;
          remainingCount: number;
        }>(collaboratorPage, "remove_recent_room", { roomId: created.room.id }),
      );
      expect(removed).toMatchObject({ sharedRoomDeleted: false, remainingCount: 0 });
      expect((await getRoom(page.request, created.room.id)).room.id).toBe(created.room.id);
    } finally {
      await collaboratorContext.close();
    }

    const spectatorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const spectatorPage = await spectatorContext.newPage();
      await installWebMcpShim(spectatorPage);
      await spectatorPage.goto("/");
      await expectRegisteredSurface(spectatorPage, LANDING_WEBMCP_TOOL_NAMES);
      successData(
        await callNavigationTool<LandingRoomData>(
          spectatorPage,
          "join_room",
          { code: created.room.code, displayName: "Read-only Spectator", role: "spectator" },
          /\/room\/room_[^/?#]+$/,
        ),
      );
      await expect(spectatorPage.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });
      await expect(spectatorPage.locator("header").getByText("spectator", { exact: true })).toBeVisible();
      await expect(spectatorPage.getByTitle("WebMCP site tools status")).toContainText("13 read-only tools");
      const spectatorMetadata = await expectRegisteredSurface(spectatorPage, SPECTATOR_ROOM_TOOL_NAMES);
      expectReadOnlySurface(spectatorMetadata, SPECTATOR_ROOM_TOOL_NAMES);

      const spectatorRoom = await getRoom(spectatorContext.request, created.room.id);
      expect(spectatorRoom.room.participants[spectatorRoom.participantId].agentActive).toBe(false);

      successData(await callWebMcpTool<ReadRoomData>(spectatorPage, "read_room_state", {}));
      successData(await callWebMcpTool<Record<string, unknown>>(spectatorPage, "read_selection", {}));
      successData(
        await callWebMcpTool<Record<string, unknown>>(spectatorPage, "read_collaboration_state", {}),
      );
      const spectatorQuery = successData(
        await callWebMcpTool<QueryData>(spectatorPage, "query_objects", {
          text: "Room API",
          diagramId,
        }),
      );
      expect(spectatorQuery.objects).toEqual([
        expect.objectContaining({ id: refs.room_api, nodeType: "service" }),
      ]);
      successData(
        await callWebMcpTool<NeighborhoodData>(spectatorPage, "read_neighborhood", {
          objectIds: [refs.room_api],
          depth: 1,
        }),
      );
      successData(
        await callWebMcpTool<{ diagrams: DiagramData[] }>(spectatorPage, "find_diagrams", {
          text: "Authentication request flow",
        }),
      );
      successData(
        await callWebMcpTool<ReadDiagramData>(spectatorPage, "read_diagram", { diagramId }),
      );
      const spectatorDescription = successData(
        await callWebMcpTool<{ diagram: DiagramData }>(spectatorPage, "describe_diagram", { diagramId }),
      );
      expect(spectatorDescription.diagram).toMatchObject({
        id: diagramId,
        tags: ["authentication", "guest-session", "redis", "production"],
        memberObjectIds: memberIds,
        connectorIds,
      });
      expect(spectatorDescription.diagram.revision).toBeGreaterThanOrEqual(3);

      const spectatorActivities = successData(
        await callWebMcpTool<{ activities: Array<{ id: string }> }>(
          spectatorPage,
          "list_activity",
          { limit: 5 },
        ),
      );
      if (spectatorActivities.activities[0]) {
        successData(
          await callWebMcpTool<Record<string, unknown>>(
            spectatorPage,
            "read_activity",
            { activityId: spectatorActivities.activities[0].id },
          ),
        );
      }
      const spectatorExport = successData(
        await callWebMcpTool<{ format: string; artifact: { diagrams: DiagramData[] } }>(
          spectatorPage,
          "export_canvas_artifact",
          { format: "semantic_json", scope: { kind: "diagram", diagramId } },
        ),
      );
      expect(spectatorExport).toMatchObject({
        format: "semantic_json",
        artifact: { diagrams: [expect.objectContaining({ id: diagramId })] },
      });
      const spectatorProposals = successData(
        await callWebMcpTool<{ proposals: Array<{ id: string }> }>(
          spectatorPage,
          "list_agent_edit_proposals",
          { limit: 10 },
        ),
      );
      if (spectatorProposals.proposals[0]) {
        successData(
          await callWebMcpTool<Record<string, unknown>>(
            spectatorPage,
            "read_agent_edit_proposal",
            { proposalId: spectatorProposals.proposals[0].id },
          ),
        );
      }

      const afterPassiveReads = await getRoom(spectatorContext.request, created.room.id);
      expect(afterPassiveReads.room.participants[spectatorRoom.participantId].agentActive).toBe(false);
      await expect(
        callWebMcpTool(spectatorPage, "apply_canvas_transaction", { operations: [] }),
      ).rejects.toThrow("WebMCP tool apply_canvas_transaction is not registered");
      await expect(
        callWebMcpTool(spectatorPage, "follow_participant", {
          participantId: host.participantId,
          target: "human",
        }),
      ).rejects.toThrow("WebMCP tool follow_participant is not registered");
    } finally {
      await spectatorContext.close();
    }
  });

  test("shares agent text, a human freehand gesture, and a picked PNG through authoritative room state", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await installWebMcpShim(page);
    const host = await createRoomFromLanding(page, "Browser Acceptance");
    await expect(page.locator("header").getByText(/^(Live|Synced)$/)).toBeVisible({
      timeout: 15_000,
    });

    await expectRegisteredSurface(page, PARTICIPANT_ROOM_TOOL_NAMES);
    await expect(page.getByTitle("WebMCP site tools status")).toContainText("45 site tools");

    const created = await callWebMcpTool<CreateObjectData>(page, "create_text", {
      content: WEBMCP_TEXT,
      x: 120,
      y: 120,
      width: 320,
      height: 96,
    });
    expect(created).toMatchObject({
      ok: true,
      tool: "create_text",
      data: {
        changedObjectIds: [expect.any(String)],
        objects: [{ kind: "text", content: WEBMCP_TEXT }],
      },
    });

    const observed = await callWebMcpTool<ReadRoomData>(page, "read_room_state", {});
    expect(observed).toMatchObject({ ok: true, tool: "read_room_state" });
    if (!observed.ok) throw new Error(observed.error.message);
    expect(observed.data.room.id).toBe(host.room.id);
    expect(observed.data.objects).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "text", content: WEBMCP_TEXT })]),
    );

    await page.getByTestId("tools.draw").click();
    const canvasBox = await page.getByTestId("canvas").boundingBox();
    if (!canvasBox) throw new Error("The tldraw canvas has no browser layout box.");
    const start = {
      x: canvasBox.x + canvasBox.width * 0.57,
      y: canvasBox.y + canvasBox.height * 0.58,
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const [dx, dy] of [
      [24, -18],
      [50, 8],
      [76, -22],
      [104, 16],
      [132, -8],
    ]) {
      await page.mouse.move(start.x + dx, start.y + dy, { steps: 4 });
    }
    await page.mouse.up();

    await expect
      .poll(
        async () => Object.values((await getRoom(page.request, host.room.id)).room.objects).filter(
          (object) => object.kind === "draw",
        ).length,
        { timeout: 15_000 },
      )
      .toBe(1);

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: /Media/ }).click(),
    ]);
    await chooser.setFiles({
      name: "browser-acceptance.png",
      mimeType: "image/png",
      buffer: TINY_PNG,
    });

    await expect
      .poll(
        async () => {
          const state = await getRoom(page.request, host.room.id);
          return new Set(Object.values(state.room.objects).map((object) => object.kind));
        },
        { timeout: 20_000 },
      )
      .toEqual(new Set(["text", "draw", "image"]));

    const authoritative = await getRoom(page.request, host.room.id);
    const objects = Object.values(authoritative.room.objects);
    expect(objects.find((object) => object.kind === "text")).toMatchObject({
      kind: "text",
      content: WEBMCP_TEXT,
      createdBy: { kind: "agent", participantId: host.participantId },
    });
    expect(objects.find((object) => object.kind === "draw")).toMatchObject({
      kind: "draw",
      createdBy: { kind: "human", participantId: host.participantId },
    });
    const image = objects.find((object) => object.kind === "image");
    expect(image).toMatchObject({
      kind: "image",
      alt: "browser-acceptance.png",
      mimeType: "image/png",
      createdBy: { kind: "human", participantId: host.participantId },
    });
    const storedImage = await page.request.get(String(image?.url));
    expect(storedImage.status()).toBe(200);
    expect(storedImage.headers()["content-type"]).toBe("image/png");
    expect(Buffer.from(await storedImage.body())).toEqual(TINY_PNG);

    await expect
      .poll(() =>
        page.locator(".tl-shape:not(.tl-shape-background)").evaluateAll((elements) =>
          [...new Set(elements.map((element) => element.getAttribute("data-shape-id")))].sort(),
        ),
      )
      .toEqual(objects.map((object) => `shape:${object.id}`).sort());

    await expect(page.getByTestId("tools.select")).toBeVisible();
    await expectBuiltInTldrawWatermark(page);
  });
});
