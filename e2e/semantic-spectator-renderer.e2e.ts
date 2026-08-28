/// <reference types="webmcp-types" />

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  createRoomViaApi,
  joinRoomViaApi,
  jsonBody,
  shapeObject,
  textObject,
  type ApiFailure,
  type RoomState,
} from "./helpers";

const SERVICE_ID = "semantic-spectator-service";
const WORKER_ID = "semantic-spectator-worker";
const DECISION_ID = "semantic-spectator-decision";
const NOTE_ID = "semantic-spectator-note";
const CONNECTOR_ID = "semantic-spectator-route";
const GROUP_ID = "semantic-spectator-group";

const SPECTATOR_TOOL_NAMES = [
  "describe_diagram",
  "export_canvas_artifact",
  "export_canvas_png",
  "find_diagrams",
  "list_activity",
  "list_agent_edit_proposals",
  "query_objects",
  "read_activity",
  "read_agent_edit_proposal",
  "read_collaboration_state",
  "read_diagram",
  "read_neighborhood",
  "read_room_state",
  "read_selection",
] as const;

const MUTATION_TOOL_NAMES = [
  "apply_canvas_transaction",
  "create_node",
  "delete_objects",
  "draw_connection",
  "edit_diagram",
  "focus_viewport",
  "follow_participant",
  "group_objects",
  "layout_objects",
  "move_objects",
] as const;

type SemanticTransactionResponse = {
  ok: true;
  room: RoomState;
  changedObjectIds: string[];
};

async function seedSemanticScene(request: APIRequestContext, roomId: string): Promise<RoomState> {
  const response = await request.post(`/api/rooms/${encodeURIComponent(roomId)}/semantic`, {
    data: {
      action: "transaction",
      transaction: {
        commands: [
          {
            type: "create",
            object: {
              ...shapeObject(SERVICE_ID, "Gateway service", 120, 180, "blue"),
              groupId: GROUP_ID,
              nodeType: "service",
            },
          },
          {
            type: "create",
            object: {
              ...shapeObject(WORKER_ID, "Queue worker", 500, 180, "green"),
              groupId: GROUP_ID,
              nodeType: "component",
              shape: "ellipse",
            },
          },
          {
            type: "create",
            object: {
              ...shapeObject(DECISION_ID, "Ship the spectator experience", 880, 160, "violet"),
              nodeType: "decision",
              shape: "diamond",
              nodeMetadata: {
                kind: "decision",
                status: "accepted",
                owner: "Canvas team",
                resolution: "Keep semantic rendering passive until editing parity is proven.",
              },
            },
          },
          {
            type: "create",
            object: textObject(NOTE_ID, "Read-only semantic review", 450, 430),
          },
          {
            type: "create",
            object: {
              id: CONNECTOR_ID,
              kind: "connector",
              x: 340,
              y: 240,
              width: 540,
              height: 60,
              rotation: 0,
              zIndex: 2,
              groupId: null,
              start: {
                x: 340,
                y: 240,
                objectId: SERVICE_ID,
                normalizedAnchor: { x: 1, y: 0.5 },
                isPrecise: true,
                isExact: false,
                snap: "edge",
              },
              end: {
                x: 880,
                y: 220,
                objectId: DECISION_ID,
                normalizedAnchor: { x: 0, y: 0.5 },
                isPrecise: true,
                isExact: false,
                snap: "edge",
              },
              routing: {
                mode: "elbow",
                kind: "elbow",
                bend: 0,
                elbowMidPoint: 0.62,
                labelPosition: 0.55,
              },
              direction: "end",
              label: "authoritative elbow route",
              color: "black",
            },
          },
        ],
        diagramCommands: [],
      },
    },
  });
  const seeded = await jsonBody<SemanticTransactionResponse>(response);
  expect(new Set(seeded.changedObjectIds)).toEqual(
    new Set([SERVICE_ID, WORKER_ID, DECISION_ID, NOTE_ID, CONNECTOR_ID]),
  );
  return seeded.room;
}

async function installWebMcpShim(page: Page): Promise<void> {
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

async function registeredToolNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tools = (window as Window & {
      __jazzboardWebMcpTools?: Map<string, WebMCP.ModelContextTool>;
    }).__jazzboardWebMcpTools;
    return [...(tools?.keys() ?? [])].sort();
  });
}

async function executeWebMcpTool(
  page: Page,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  return page.evaluate(async ({ name, input }) => {
    const tools = (window as Window & {
      __jazzboardWebMcpTools?: Map<string, WebMCP.ModelContextTool>;
    }).__jazzboardWebMcpTools;
    const tool = tools?.get(name);
    if (!tool) throw new Error(`WebMCP tool ${name} is not registered.`);
    return tool.execute(input, { signal: new AbortController().signal });
  }, { name, input });
}

function viewportTransform(page: Page) {
  return page.getByTestId("semantic-canvas").locator("svg > g").getAttribute("transform");
}

test("renders the first-party spectator canvas without mutation authority", async ({
  browser,
  page,
}) => {
  test.setTimeout(60_000);

  const host = await createRoomViaApi(page.request, "Riley Host", "Semantic spectator acceptance");
  const seededRoom = await seedSemanticScene(page.request, host.room.id);
  expect(seededRoom.objects[CONNECTOR_ID]).toMatchObject({
    kind: "connector",
    routing: { mode: "elbow", kind: "elbow" },
  });

  const presenceResponse = await page.request.post(
    `/api/rooms/${encodeURIComponent(host.room.id)}/presence`,
    {
      headers: { "x-jazzboard-presence-protocol": "delta-v1" },
      data: {
        cursor: { x: 2_820, y: 1_220 },
        viewport: { x: 2_400, y: 900, width: 840, height: 640, zoom: 0.8 },
        activity: null,
      },
    },
  );
  await jsonBody(presenceResponse);

  const configuredBaseUrl = test.info().project.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("The semantic spectator regression requires Playwright use.baseURL.");
  }
  const spectatorContext = await browser.newContext({ baseURL: configuredBaseUrl });
  try {
    await joinRoomViaApi(spectatorContext.request, {
      code: host.room.code,
      displayName: "Sam Spectator",
      role: "spectator",
    });
    const spectatorPage = await spectatorContext.newPage();
    await installWebMcpShim(spectatorPage);
    await spectatorPage.goto(`/room/${encodeURIComponent(host.room.id)}`);

    const canvas = spectatorPage.getByTestId("semantic-canvas");
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    await expect(canvas).toHaveAttribute("data-canvas-renderer", "jazzboard-semantic-v1");
    await expect(spectatorPage.getByTestId("jazzboard-canvas")).toHaveAttribute(
      "data-canvas-surface",
      "jazzboard-semantic-v1",
    );

    const service = canvas.locator(`[data-object-id="${SERVICE_ID}"]`);
    const worker = canvas.locator(`[data-object-id="${WORKER_ID}"]`);
    const decision = canvas.locator(`[data-object-id="${DECISION_ID}"]`);
    const note = canvas.locator(`[data-object-id="${NOTE_ID}"]`);
    const connector = canvas.locator(`[data-object-id="${CONNECTOR_ID}"]`);

    await expect(service).toHaveAttribute("data-node-type", "service");
    await expect(worker).toHaveAttribute("data-node-type", "component");
    await expect(decision).toHaveAttribute("data-node-type", "decision");
    await expect(note).toHaveAttribute("data-object-kind", "text");
    await expect(spectatorPage.getByRole("button", { name: "service: Gateway service" })).toBeVisible();
    await expect(spectatorPage.getByRole("button", { name: "component: Queue worker" })).toBeVisible();
    await expect(spectatorPage.getByRole("button", { name: "decision: Ship the spectator experience" })).toBeVisible();
    await expect(spectatorPage.getByRole("button", { name: "Text: Read-only semantic review" })).toBeVisible();

    const connectorPath = connector.locator(".semantic-canvas-object__connector-path");
    await expect(connectorPath).toBeVisible();
    const pathData = await connectorPath.getAttribute("d");
    expect(pathData).toMatch(/^M [-\d.]+ [-\d.]+(?: L [-\d.]+ [-\d.]+){2,}$/);
    await expect(connector.locator(".semantic-canvas-object__connector-label-text")).toHaveText(
      "authoritative elbow route",
    );
    await expect(connector.locator(".semantic-canvas-object__arrowhead--end")).toHaveCount(1);

    await service.click();
    await expect(service).toHaveAttribute("data-selected", "true");
    await expect(worker).toHaveAttribute("data-selected", "true");
    await expect(decision).toHaveAttribute("data-selected", "false");
    await expect(spectatorPage.getByTestId("canvas-selection-count")).toHaveText("2 selected");

    await spectatorPage.getByRole("button", { name: "Board menu" }).click();
    await spectatorPage.getByRole("menuitem", { name: "Canvas outline" }).click();
    const outline = spectatorPage.getByRole("complementary", { name: "Canvas outline" });
    await outline.getByRole("button", { name: /decision Ship the spectator experience r1/i }).click();
    await expect(decision).toHaveAttribute("data-selected", "true");
    await expect(service).toHaveAttribute("data-selected", "false");
    await expect(spectatorPage.getByTestId("canvas-selection-count")).toHaveText("1 selected");
    await expect(canvas.getByText("125%", { exact: true })).toBeVisible();

    await canvas.getByRole("button", { name: "Zoom in" }).click();
    await expect(canvas.getByText("150%", { exact: true })).toBeVisible();
    const beforePan = await viewportTransform(spectatorPage);
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("Semantic canvas did not have a browser layout box.");
    await spectatorPage.mouse.move(
      canvasBox.x + canvasBox.width / 2,
      canvasBox.y + canvasBox.height / 2,
    );
    await spectatorPage.mouse.wheel(160, 120);
    await expect.poll(() => viewportTransform(spectatorPage)).not.toBe(beforePan);
    await expect(canvas.getByText("150%", { exact: true })).toBeVisible();

    await spectatorPage.getByRole("button", { name: /^Follow/ }).click();
    await spectatorPage.getByRole("button", { name: "Follow Riley Host's cursor" }).click();
    await expect(spectatorPage.getByText("Following: Riley Host’s human")).toBeVisible();
    await expect(canvas.getByText("80%", { exact: true })).toBeVisible();
    const followingTransform = await viewportTransform(spectatorPage);
    expect(followingTransform).not.toBe(beforePan);

    await spectatorPage.mouse.move(
      canvasBox.x + canvasBox.width / 2,
      canvasBox.y + canvasBox.height / 2,
    );
    await spectatorPage.mouse.wheel(0, 100);
    await expect(spectatorPage.getByText("Following: Riley Host’s human")).toHaveCount(0);
    await expect.poll(() => viewportTransform(spectatorPage)).not.toBe(followingTransform);

    await expect.poll(() => registeredToolNames(spectatorPage), { timeout: 15_000 }).toEqual(
      [...SPECTATOR_TOOL_NAMES].sort(),
    );
    const tools = await registeredToolNames(spectatorPage);
    expect(tools.filter((name) => MUTATION_TOOL_NAMES.includes(name as never))).toEqual([]);
    expect(tools).toContain("export_canvas_png");
    await expect(spectatorPage.getByRole("button", { name: "Spotlight", exact: true })).toHaveCount(0);

    const downloadPromise = spectatorPage.waitForEvent("download");
    const exportResultPromise = executeWebMcpTool(spectatorPage, "export_canvas_png", {
      scope: {
        kind: "objects",
        targets: [
          { objectId: SERVICE_ID, expectedRevision: seededRoom.objects[SERVICE_ID].revision },
          { objectId: CONNECTOR_ID, expectedRevision: seededRoom.objects[CONNECTOR_ID].revision },
          { objectId: DECISION_ID, expectedRevision: seededRoom.objects[DECISION_ID].revision },
        ],
      },
      filename: "semantic-renderer-acceptance",
      pixelRatio: 1,
    });
    const [download, exportResult] = await Promise.all([downloadPromise, exportResultPromise]);
    expect(download.suggestedFilename()).toBe("semantic-renderer-acceptance.png");
    expect(await download.failure()).toBeNull();
    expect(exportResult).toMatchObject({
      ok: true,
      tool: "export_canvas_png",
      data: {
        filename: "semantic-renderer-acceptance.png",
        mimeType: "image/png",
        persistedByJazzboard: false,
      },
    });

    const deniedResponse = await spectatorContext.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/semantic`,
      {
        data: {
          action: "transaction",
          transaction: {
            commands: [
              {
                type: "create",
                object: textObject("spectator-mutation-must-not-commit", "Must not commit", 40, 40),
              },
            ],
            diagramCommands: [],
          },
        },
      },
    );
    const denied = await jsonBody<ApiFailure>(deniedResponse, 403);
    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "Spectators cannot change the canvas.",
        details: { role: "spectator" },
      },
    });
  } finally {
    await spectatorContext.close();
  }
});
