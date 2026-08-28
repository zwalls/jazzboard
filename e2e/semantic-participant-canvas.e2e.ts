/// <reference types="webmcp-types" />

import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";
import { readFile } from "node:fs/promises";

import {
  connectorObject,
  createRoomViaApi,
  getRoom,
  joinRoomViaApi,
  jsonBody,
  shapeObject,
  textObject,
  type ApiFailure,
  type CommandResponse,
  type RoomState,
} from "./helpers";

const SOURCE_ID = "semantic-edit-source";
const TARGET_ID = "semantic-edit-target";
const CONNECTOR_ID = "semantic-edit-connector";
const TEXT_ID = "semantic-edit-text";
const GROUP_ID = "semantic-edit-group";
const DIAGRAM_ID = "semantic-edit-diagram";
const ORIGINAL_TEXT = "Authoritative decision before the local edit";
const EDITED_TEXT = "Authoritative decision after the local-first edit";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z7DlPwMewIRPcvgoAADJ3wLCTMjowgAAAABJRU5ErkJggg==",
  "base64",
);

const PARTICIPANT_MUTATION_TOOLS = [
  "apply_canvas_transaction",
  "create_shape",
  "delete_objects",
  "follow_participant",
  "group_objects",
  "move_objects",
  "stop_following",
  "update_object",
] as const;

type SemanticTransactionResponse = {
  ok: true;
  room: RoomState;
  changedObjectIds: string[];
  changedDiagramIds: string[];
};

type WebMcpResult<T> =
  | { ok: true; tool: string; data: T }
  | { ok: false; tool: string; error: { code: string; message: string; details?: unknown } };

type SampledFrame = {
  at: number;
  bounds: { x: number; y: number; width: number; height: number } | null;
  text: string;
};

type DelayedCommands = {
  firstBlockedAt: Promise<number>;
  captured: Array<Record<string, unknown>>;
  release(): void;
  dispose(): Promise<void>;
};

function semanticObject(page: Page, objectId: string) {
  return page.getByTestId("semantic-canvas").locator(`[data-object-id="${objectId}"]`);
}

async function objectUnionBounds(page: Page, objectIds: readonly string[]) {
  return page.evaluate((ids) => {
    const boxes = ids.map((id) => {
      const element = document.querySelector<SVGGElement>(`[data-object-id="${CSS.escape(id)}"]`);
      if (!element) throw new Error(`Semantic object ${id} is not rendered.`);
      return element.getBoundingClientRect();
    });
    const x = Math.min(...boxes.map((box) => box.x));
    const y = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.right));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    return { x, y, width: right - x, height: bottom - y };
  }, objectIds);
}

async function seedSemanticEditScene(request: APIRequestContext, roomId: string): Promise<RoomState> {
  const response = await request.post(`/api/rooms/${encodeURIComponent(roomId)}/semantic`, {
    data: {
      action: "transaction",
      transaction: {
        commands: [
          {
            type: "create",
            object: {
              ...shapeObject(SOURCE_ID, "Browser client", 150, 170, "blue"),
              nodeType: "component",
            },
          },
          {
            type: "create",
            object: {
              ...shapeObject(TARGET_ID, "Orders service", 650, 190, "green"),
              nodeType: "service",
            },
          },
          {
            type: "create",
            object: {
              ...connectorObject(CONNECTOR_ID, "POST /orders", SOURCE_ID, TARGET_ID),
              start: {
                x: 370,
                y: 230,
                objectId: SOURCE_ID,
                normalizedAnchor: { x: 1, y: 0.5 },
                isPrecise: true,
                isExact: false,
                snap: "edge",
              },
              end: {
                x: 650,
                y: 250,
                objectId: TARGET_ID,
                normalizedAnchor: { x: 0, y: 0.5 },
                isPrecise: true,
                isExact: false,
                snap: "edge",
              },
              routing: {
                mode: "elbow",
                kind: "elbow",
                bend: 0,
                elbowMidPoint: 0.5,
                labelPosition: 0.5,
              },
            },
          },
          { type: "create", object: textObject(TEXT_ID, ORIGINAL_TEXT, 330, 430) },
        ],
        diagramCommands: [
          {
            type: "diagram.create",
            diagram: {
              id: DIAGRAM_ID,
              title: "Semantic participant acceptance",
              description: "A renderer-neutral diagram used by the first-party canvas acceptance suite.",
              diagramType: "architecture",
              category: "e2e",
              tags: ["semantic-edit", "local-first"],
              memberObjectIds: [SOURCE_ID, TARGET_ID, TEXT_ID],
              connectorIds: [CONNECTOR_ID],
            },
          },
        ],
      },
    },
  });
  const seeded = await jsonBody<SemanticTransactionResponse>(response);
  expect(new Set(seeded.changedObjectIds)).toEqual(
    new Set([SOURCE_ID, TARGET_ID, CONNECTOR_ID, TEXT_ID]),
  );
  expect(seeded.changedDiagramIds).toEqual([DIAGRAM_ID]);

  const groupResponse = await request.post(
    `/api/rooms/${encodeURIComponent(roomId)}/agent/commands`,
    {
      data: {
        command: {
          type: "group",
          groupId: GROUP_ID,
          targets: [SOURCE_ID, TARGET_ID, CONNECTOR_ID].map((objectId) => ({
            objectId,
            expectedRevision: seeded.room.objects[objectId].revision,
          })),
        },
      },
    },
  );
  return (await jsonBody<CommandResponse>(groupResponse)).room;
}

async function delayHumanCommands(page: Page, roomId: string): Promise<DelayedCommands> {
  const patterns = [
    `**/api/rooms/${encodeURIComponent(roomId)}/commands`,
    `**/api/rooms/${encodeURIComponent(roomId)}/semantic`,
  ];
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  let markBlocked!: (at: number) => void;
  const firstBlockedAt = new Promise<number>((resolve) => { markBlocked = resolve; });
  let marked = false;
  let released = false;
  const captured: Array<Record<string, unknown>> = [];
  const handler = async (route: Route, request: Request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const body = request.postDataJSON() as {
      command?: Record<string, unknown>;
      transaction?: { commands?: Array<Record<string, unknown>> };
    };
    if (body.command) captured.push(body.command);
    if (body.transaction?.commands) captured.push(...body.transaction.commands);
    if (!marked) {
      marked = true;
      markBlocked(Date.now());
    }
    await gate;
    await route.continue();
  };
  for (const pattern of patterns) await page.route(pattern, handler);
  return {
    firstBlockedAt,
    captured,
    release() {
      if (released) return;
      released = true;
      releaseGate();
    },
    async dispose() {
      if (!released) releaseGate();
      released = true;
      for (const pattern of patterns) await page.unroute(pattern, handler);
    },
  };
}

async function startFrameSampler(page: Page, objectIds: readonly string[], key: string) {
  await page.evaluate(({ ids, samplerKey }) => {
    type State = { frames: SampledFrame[]; animationFrame: number };
    const registry = window as unknown as Record<string, State>;
    const frames: SampledFrame[] = [];
    const sample = () => {
      const elements = ids.flatMap((id) => {
        const element = document.querySelector<SVGGElement>(`[data-object-id="${CSS.escape(id)}"]`);
        return element ? [element] : [];
      });
      let bounds: SampledFrame["bounds"] = null;
      if (elements.length) {
        const boxes = elements.map((element) => element.getBoundingClientRect());
        const x = Math.min(...boxes.map((box) => box.x));
        const y = Math.min(...boxes.map((box) => box.y));
        const right = Math.max(...boxes.map((box) => box.right));
        const bottom = Math.max(...boxes.map((box) => box.bottom));
        bounds = { x, y, width: right - x, height: bottom - y };
      }
      frames.push({
        at: performance.now(),
        bounds,
        text: elements.map((element) => element.textContent ?? "").join(" ").replace(/\s+/g, " ").trim(),
      });
      registry[samplerKey].animationFrame = requestAnimationFrame(sample);
    };
    registry[samplerKey] = { frames, animationFrame: requestAnimationFrame(sample) };
  }, { ids: objectIds, samplerKey: key });
}

async function stopFrameSampler(page: Page, key: string): Promise<SampledFrame[]> {
  return page.evaluate((samplerKey) => {
    type State = { frames: SampledFrame[]; animationFrame: number };
    const registry = window as unknown as Record<string, State | undefined>;
    const state = registry[samplerKey];
    if (!state) return [];
    cancelAnimationFrame(state.animationFrame);
    delete registry[samplerKey];
    return state.frames;
  }, key);
}

async function installWebMcpShim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tools = new Map<string, WebMCP.ModelContextTool>();
    const target = window as Window & {
      __semanticAcceptanceTools?: Map<string, WebMCP.ModelContextTool>;
    };
    target.__semanticAcceptanceTools = tools;
    const modelContext = new EventTarget() as WebMCP.ModelContext;
    modelContext.ontoolchange = null;
    modelContext.registerTool = async (tool, options) => {
      tools.set(tool.name, tool);
      options?.signal?.addEventListener("abort", () => {
        if (tools.get(tool.name) === tool) tools.delete(tool.name);
      }, { once: true });
    };
    modelContext.getTools = async () => [...tools.values()].map((tool) => ({
      name: tool.name,
      title: tool.title ?? tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      window,
      origin: window.location.origin,
    }));
    Object.defineProperty(document, "modelContext", { configurable: true, value: modelContext });
  });
}

async function webMcpToolNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tools = (window as Window & {
      __semanticAcceptanceTools?: Map<string, WebMCP.ModelContextTool>;
    }).__semanticAcceptanceTools;
    return [...(tools?.keys() ?? [])].sort();
  });
}

async function callWebMcpTool<T>(page: Page, name: string, input: Record<string, unknown>) {
  return page.evaluate(async ({ toolName, toolInput }) => {
    const tools = (window as Window & {
      __semanticAcceptanceTools?: Map<string, WebMCP.ModelContextTool>;
    }).__semanticAcceptanceTools;
    const tool = tools?.get(toolName);
    if (!tool) throw new Error(`WebMCP tool ${toolName} is not registered.`);
    return tool.execute(toolInput, { signal: new AbortController().signal });
  }, { toolName: name, toolInput: input }) as Promise<WebMcpResult<T>>;
}

function successData<T>(result: WebMcpResult<T>): T {
  if (!result.ok) throw new Error(`${result.tool}: ${result.error.code} ${result.error.message}`);
  return result.data;
}

async function expectSemanticParticipant(page: Page) {
  const canvas = page.getByTestId("semantic-canvas");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect(canvas).toHaveAttribute("data-canvas-renderer", "jazzboard-semantic-v1");
  await expect(canvas).toHaveAttribute("data-canvas-editing", "enabled");
  await expect(page.getByRole("toolbar", { name: "Canvas tools" })).toBeVisible();
  return canvas;
}

async function sourceColorPixels(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (base64) => {
    const response = await fetch(`data:image/png;base64,${base64}`);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas decoding is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 220 && pixels[index + 1] < 40 && pixels[index + 2] > 140 && pixels[index + 3] > 240) {
        count += 1;
      }
    }
    return count;
  }, png.toString("base64"));
}

async function joinContext(
  context: BrowserContext,
  room: { id: string; code: string },
  displayName: string,
  role: "participant" | "spectator",
) {
  return joinRoomViaApi(context.request, { code: room.code, displayName, role });
}

test.describe("first-party semantic participant canvas", () => {
  test.describe.configure({ mode: "serial" });

  test("never repaints stale grouped or text state while saves are delayed", async ({ browser, page }) => {
    test.setTimeout(90_000);
    const host = await createRoomViaApi(page.request, "Mira Local", "Semantic local-first acceptance");
    const seeded = await seedSemanticEditScene(page.request, host.room.id);
    const collaboratorContext = await browser.newContext({ baseURL: new URL(test.info().project.use.baseURL as string).origin });
    let moveSampler: SampledFrame[] = [];
    let textSampler: SampledFrame[] = [];
    try {
      await installWebMcpShim(page);
      await joinContext(collaboratorContext, host.room, "Arlo Agent", "participant");
      const collaboratorPage = await collaboratorContext.newPage();
      await installWebMcpShim(collaboratorPage);
      await Promise.all([
        page.goto(`/room/${encodeURIComponent(host.room.id)}`),
        collaboratorPage.goto(`/room/${encodeURIComponent(host.room.id)}`),
      ]);
      await Promise.all([expectSemanticParticipant(page), expectSemanticParticipant(collaboratorPage)]);
      await expect.poll(() => webMcpToolNames(collaboratorPage), { timeout: 15_000 }).toContain("update_object");

      const source = semanticObject(page, SOURCE_ID);
      const connector = semanticObject(page, CONNECTOR_ID);
      await expect(source).toBeVisible();
      await expect(connector).toBeVisible();
      await expect(page.getByTestId("canvas-selection-count")).toHaveText("0 selected");

      const originalSourceBounds = await source.boundingBox();
      const originalGroupBounds = await objectUnionBounds(
        page,
        [SOURCE_ID, TARGET_ID, CONNECTOR_ID],
      );
      const originalConnectorPath = await connector.locator(".semantic-canvas-object__connector-path").getAttribute("d");
      if (!originalSourceBounds || !originalConnectorPath) throw new Error("The seeded semantic diagram is not measurable.");

      const moveDelay = await delayHumanCommands(page, host.room.id);
      const moveSamplerKey = "__semantic_group_move_frames__";
      await startFrameSampler(page, [SOURCE_ID, TARGET_ID, CONNECTOR_ID], moveSamplerKey);
      try {
        const sourceHitBounds = await source.locator(".semantic-canvas-object__shape").boundingBox();
        if (!sourceHitBounds) throw new Error("The source shape has no pointer target.");
        const start = {
          x: sourceHitBounds.x + sourceHitBounds.width * 0.2,
          y: sourceHitBounds.y + sourceHitBounds.height * 0.75,
        };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await expect(page.getByTestId("canvas-selection-count")).toHaveText("3 selected");
        await expect.poll(
          async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases).sort(),
          { timeout: 10_000 },
        ).toEqual([CONNECTOR_ID, SOURCE_ID, TARGET_ID].sort());
        await page.mouse.move(start.x + 55, start.y + 30, { steps: 4 });
        await page.mouse.move(start.x + 105, start.y + 58, { steps: 4 });
        await page.mouse.move(start.x + 145, start.y + 82, { steps: 4 });
        await page.mouse.up();

        const localSourceBounds = await source.boundingBox();
        const localGroupBounds = await objectUnionBounds(
          page,
          [SOURCE_ID, TARGET_ID, CONNECTOR_ID],
        );
        if (!localSourceBounds) throw new Error("The locally moved source is not measurable.");
        expect(localSourceBounds.x - originalSourceBounds.x).toBeGreaterThan(125);
        expect(localSourceBounds.y - originalSourceBounds.y).toBeGreaterThan(65);

        const blockedAt = await moveDelay.firstBlockedAt;
        const busy = await callWebMcpTool<Record<string, unknown>>(
          collaboratorPage,
          "update_object",
          {
            objectId: SOURCE_ID,
            expectedRevision: seeded.objects[SOURCE_ID].revision,
            operation: "move",
            patch: { x: Number(seeded.objects[SOURCE_ID].x) - 25 },
          },
        );
        expect(busy).toMatchObject({
          ok: false,
          tool: "update_object",
          error: { code: "OBJECT_BUSY", details: { objectId: SOURCE_ID } },
        });

        await page.mouse.move(1_050, 620);
        await expect(page.getByTestId("connection-status")).toHaveAccessibleName(/Connection: (Live|Synced)/);
        const remaining = 2_200 - (Date.now() - blockedAt);
        if (remaining > 0) await page.waitForTimeout(remaining);
        expect(Date.now() - blockedAt).toBeGreaterThanOrEqual(2_000);
        expect((await getRoom(page.request, host.room.id)).room.objects[SOURCE_ID]).toMatchObject({
          x: seeded.objects[SOURCE_ID].x,
          y: seeded.objects[SOURCE_ID].y,
        });

        moveDelay.release();
        await expect.poll(
          async () => (await getRoom(page.request, host.room.id)).room.objects[SOURCE_ID].revision,
          { timeout: 15_000 },
        ).toBeGreaterThan(seeded.objects[SOURCE_ID].revision);
        await expect.poll(
          async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases),
          { timeout: 10_000 },
        ).toEqual([]);
        await page.waitForTimeout(180);
        moveSampler = await stopFrameSampler(page, moveSamplerKey);

        const settledIndex = moveSampler.findIndex((frame) =>
          frame.bounds
          && Math.abs(frame.bounds.x - localGroupBounds.x) < 4
          && Math.abs(frame.bounds.y - localGroupBounds.y) < 4,
        );
        expect(settledIndex).toBeGreaterThanOrEqual(0);
        const snappedBack = moveSampler.slice(settledIndex).filter((frame) =>
          frame.bounds
          && Math.abs(frame.bounds.x - originalGroupBounds.x) < 8
          && Math.abs(frame.bounds.y - originalGroupBounds.y) < 8,
        );
        expect(snappedBack, "the grouped semantic bounds returned to their original position").toEqual([]);

        const final = (await getRoom(page.request, host.room.id)).room;
        expect(final.objects[CONNECTOR_ID]).toMatchObject({
          kind: "connector",
          start: { objectId: SOURCE_ID },
          end: { objectId: TARGET_ID },
        });
        await expect(collaboratorPage.locator(`[data-object-id="${SOURCE_ID}"]`)).toHaveAttribute(
          "data-object-x",
          String(final.objects[SOURCE_ID].x),
        );
        const finalConnectorPath = await connector.locator(".semantic-canvas-object__connector-path").getAttribute("d");
        expect(finalConnectorPath).not.toBe(originalConnectorPath);
      } finally {
        moveDelay.release();
        if (!moveSampler.length) moveSampler = await stopFrameSampler(page, moveSamplerKey).catch(() => []);
        await moveDelay.dispose();
      }

      await semanticObject(page, TEXT_ID).focus();
      await semanticObject(page, TEXT_ID).press("Enter");
      await expect(page.getByTestId("canvas-selection-count")).toHaveText("1 selected");
      await semanticObject(page, TEXT_ID).press("F2");
      const editor = page.getByRole("textbox", { name: "Edit text content" });
      await expect(editor).toBeVisible();
      const textDelay = await delayHumanCommands(page, host.room.id);
      const textSamplerKey = "__semantic_text_edit_frames__";
      await startFrameSampler(page, [TEXT_ID], textSamplerKey);
      try {
        await editor.fill(EDITED_TEXT);
        await editor.press("ControlOrMeta+Enter");
        const blockedAt = await textDelay.firstBlockedAt;
        await expect(semanticObject(page, TEXT_ID)).toContainText(EDITED_TEXT);

        await page.getByRole("button", { name: "Board menu" }).click();
        await page.getByRole("menuitem", { name: "Ask agent" }).click();
        await page.waitForTimeout(350);
        await expect(page.getByRole("complementary", { name: "Ask your agent" })).toHaveCount(0);

        const remaining = 2_150 - (Date.now() - blockedAt);
        if (remaining > 0) await page.waitForTimeout(remaining);
        textDelay.release();

        const askPanel = page.getByRole("complementary", { name: "Ask your agent" });
        await expect(askPanel).toBeVisible({ timeout: 15_000 });
        await expect(askPanel.getByLabel("Selected context")).toContainText(EDITED_TEXT);
        await expect(askPanel.getByLabel("Selected context")).toContainText("r2");
        await expect.poll(
          async () => (await getRoom(page.request, host.room.id)).room.objects[TEXT_ID],
          { timeout: 10_000 },
        ).toMatchObject({ content: EDITED_TEXT, revision: 2 });
        await page.waitForTimeout(180);
        textSampler = await stopFrameSampler(page, textSamplerKey);
        const editedIndex = textSampler.findIndex((frame) => frame.text.includes(EDITED_TEXT));
        expect(editedIndex).toBeGreaterThanOrEqual(0);
        expect(
          textSampler.slice(editedIndex).filter((frame) => frame.text.includes(ORIGINAL_TEXT)),
          "the semantic text visibly reverted while its command was pending",
        ).toEqual([]);
      } finally {
        textDelay.release();
        if (!textSampler.length) textSampler = await stopFrameSampler(page, textSamplerKey).catch(() => []);
        await textDelay.dispose();
      }
    } finally {
      await collaboratorContext.close();
    }
  });

  test("authors transforms, styles, clipboard operations, and a reviewed private image", async ({ browser, page }) => {
    test.setTimeout(120_000);
    const host = await createRoomViaApi(page.request, "Avery Author", "Semantic authoring acceptance");
    await seedSemanticEditScene(page.request, host.room.id);
    await installWebMcpShim(page);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    const canvas = await expectSemanticParticipant(page);
    await expect.poll(() => webMcpToolNames(page), { timeout: 15_000 }).toEqual(
      expect.arrayContaining([...PARTICIPANT_MUTATION_TOOLS, "render_canvas_preview", "export_canvas_png"]),
    );

    // Ungroup the seed so selection controls exercise one-object transforms.
    const grouped = (await getRoom(page.request, host.room.id)).room;
    const ungroupResponse = await page.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/commands`,
      {
        data: {
          command: {
            type: "group",
            groupId: null,
            targets: [SOURCE_ID, TARGET_ID, CONNECTOR_ID].map((objectId) => ({
              objectId,
              expectedRevision: grouped.objects[objectId].revision,
            })),
          },
        },
      },
    );
    await jsonBody<CommandResponse>(ungroupResponse);
    await expect.poll(
      async () => (await getRoom(page.request, host.room.id)).room.objects[SOURCE_ID].groupId,
    ).toBeNull();
    await page.reload();
    await expectSemanticParticipant(page);

    await semanticObject(page, SOURCE_ID).click();
    await expect(page.getByTestId("semantic-selection-frame")).toHaveAttribute("data-selection-count", "1");
    const beforeTransform = (await getRoom(page.request, host.room.id)).room.objects[SOURCE_ID];
    const resize = page.getByRole("button", { name: "Resize selection from south-east" });
    const resizeBox = await resize.boundingBox();
    if (!resizeBox) throw new Error("The semantic south-east resize handle is not measurable.");
    await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeBox.x + 90, resizeBox.y + 55, { steps: 8 });
    await page.mouse.up();
    await expect.poll(
      async () => (await getRoom(page.request, host.room.id)).room.objects[SOURCE_ID].revision,
      { timeout: 10_000 },
    ).toBeGreaterThan(beforeTransform.revision);

    await page.getByRole("button", { name: /^Fill:/ }).click();
    const redFill = page.getByRole("button", { name: "Red fill", exact: true });
    await redFill.focus();
    await redFill.press("Enter");
    await page.getByLabel("Node type").selectOption("service");
    await expect.poll(async () => (await getRoom(page.request, host.room.id)).room.objects[SOURCE_ID]).toMatchObject({
      fill: "red",
      nodeType: "service",
    });
    const transformed = (await getRoom(page.request, host.room.id)).room.objects[SOURCE_ID];
    expect(Number(transformed.width)).toBeGreaterThan(Number(beforeTransform.width) + 40);
    expect(Number(transformed.height)).toBeGreaterThan(Number(beforeTransform.height) + 20);

    const countObjects = async () => Object.keys((await getRoom(page.request, host.room.id)).room.objects).length;
    const initialCount = await countObjects();
    await canvas.press("ControlOrMeta+d");
    await expect.poll(countObjects).toBe(initialCount + 1);
    await canvas.press("Delete");
    await expect.poll(countObjects).toBe(initialCount);

    await semanticObject(page, SOURCE_ID).click();
    await canvas.press("ControlOrMeta+c");
    await canvas.press("ControlOrMeta+v");
    await expect.poll(countObjects).toBe(initialCount + 1);
    await canvas.press("Delete");
    await expect.poll(countObjects).toBe(initialCount);

    await semanticObject(page, SOURCE_ID).click();
    await semanticObject(page, TARGET_ID).click({ modifiers: ["Shift"] });
    await expect(page.getByTestId("canvas-selection-count")).toHaveText("2 selected");
    await canvas.press("ControlOrMeta+g");
    await expect.poll(async () => {
      const room = (await getRoom(page.request, host.room.id)).room;
      return [room.objects[SOURCE_ID].groupId, room.objects[TARGET_ID].groupId];
    }).toEqual([expect.any(String), expect.any(String)]);
    const regrouped = (await getRoom(page.request, host.room.id)).room;
    expect(regrouped.objects[SOURCE_ID].groupId).toBe(regrouped.objects[TARGET_ID].groupId);
    await canvas.press("ControlOrMeta+]");
    await expect.poll(
      async () => (await getRoom(page.request, host.room.id)).room.objects[SOURCE_ID].revision,
    ).toBeGreaterThan(regrouped.objects[SOURCE_ID].revision);
    await canvas.press("ControlOrMeta+Shift+g");
    await expect.poll(async () => {
      const room = (await getRoom(page.request, host.room.id)).room;
      return [room.objects[SOURCE_ID].groupId, room.objects[TARGET_ID].groupId];
    }).toEqual([null, null]);

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "Image tool" }).click(),
    ]);
    await chooser.setFiles({ name: "semantic-private.png", mimeType: "image/png", buffer: TINY_PNG });
    const imageDialog = page.getByRole("dialog", { name: "Add an accessible image" });
    await expect(imageDialog).toBeVisible();
    await imageDialog.getByLabel("Image description").fill("Magenta private architecture marker");
    await imageDialog.getByText("I confirm this description truthfully identifies the image.").click();
    await imageDialog.getByRole("button", { name: "Add to canvas" }).click();
    const image = await expect.poll(async () => {
      const objects = Object.values((await getRoom(page.request, host.room.id)).room.objects);
      return objects.find((object) => object.kind === "image") ?? null;
    }, { timeout: 20_000 }).not.toBeNull();
    void image;
    const imageState = Object.values((await getRoom(page.request, host.room.id)).room.objects)
      .find((object) => object.kind === "image");
    if (!imageState) throw new Error("The reviewed private image did not persist.");
    expect(imageState).toMatchObject({
      kind: "image",
      alt: "Magenta private architecture marker",
      mimeType: "image/png",
      createdBy: { participantId: host.participantId, kind: "human" },
    });
    expect(String(imageState.url)).toMatch(
      new RegExp(`^/api/rooms/${host.room.id}/assets\\?(?:assetId|pathname)=`),
    );
    await expect(semanticObject(page, imageState.id).locator("image.semantic-canvas-object__image")).toBeVisible();

    const preview = successData(await callWebMcpTool<{
      screenshotClip: { x: number; y: number; width: number; height: number };
    }>(page, "render_canvas_preview", {
      scope: { kind: "objects", targets: [{ objectId: imageState.id, expectedRevision: imageState.revision }] },
      padding: 24,
    }));
    const previewImage = page.getByRole("dialog", { name: "Canvas preview" })
      .getByAltText("Exact rendered Jazzboard canvas preview");
    await expect(previewImage).toBeVisible();
    const previewPng = await page.screenshot({ clip: preview.screenshotClip });
    expect(await sourceColorPixels(page, previewPng)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Dismiss canvas preview" }).click();

    await page.getByRole("button", { name: "Board menu" }).click();
    await page.getByRole("menuitem", { name: "Export" }).click();
    const participantExport = page.getByRole("complementary", { name: "Export board" });
    const [participantDownload] = await Promise.all([
      page.waitForEvent("download"),
      participantExport.getByRole("button", { name: "PNG" }).click(),
    ]);
    const participantPngPath = await participantDownload.path();
    if (!participantPngPath) throw new Error("Participant PNG export did not produce a file.");
    expect(await sourceColorPixels(page, await readFile(participantPngPath))).toBeGreaterThan(0);

    const spectatorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      await joinContext(spectatorContext, host.room, "Sam Spectator", "spectator");
      const spectatorPage = await spectatorContext.newPage();
      await installWebMcpShim(spectatorPage);
      await spectatorPage.goto(`/room/${encodeURIComponent(host.room.id)}`);
      const spectatorCanvas = spectatorPage.getByTestId("semantic-canvas");
      await expect(spectatorCanvas).toBeVisible({ timeout: 20_000 });
      await expect(spectatorCanvas).toHaveAttribute("data-canvas-editing", "disabled");
      await expect(spectatorPage.getByRole("toolbar", { name: "Canvas tools" })).toHaveCount(0);
      await expect(spectatorPage.locator('[data-semantic-selection-controls="true"]')).toHaveCount(0);
      await expect(semanticObject(spectatorPage, imageState.id).locator("image.semantic-canvas-object__image")).toBeVisible();

      await expect.poll(() => webMcpToolNames(spectatorPage), { timeout: 15_000 }).toContain("read_room_state");
      const spectatorTools = await webMcpToolNames(spectatorPage);
      expect(spectatorTools).toContain("export_canvas_png");
      expect(spectatorTools).not.toContain("render_canvas_preview");
      for (const tool of PARTICIPANT_MUTATION_TOOLS) expect(spectatorTools).not.toContain(tool);

      const beforeDeleteAttempt = (await getRoom(spectatorContext.request, host.room.id)).room;
      await semanticObject(spectatorPage, SOURCE_ID).click();
      await spectatorCanvas.press("Delete");
      await spectatorPage.waitForTimeout(350);
      const afterDeleteAttempt = (await getRoom(spectatorContext.request, host.room.id)).room;
      expect(afterDeleteAttempt.roomRevision).toBe(beforeDeleteAttempt.roomRevision);
      expect(afterDeleteAttempt.objects[SOURCE_ID]).toEqual(beforeDeleteAttempt.objects[SOURCE_ID]);

      const hostCanvasBounds = await canvas.boundingBox();
      if (!hostCanvasBounds) throw new Error("The participant canvas is not measurable for presence.");
      await page.mouse.move(hostCanvasBounds.x + hostCanvasBounds.width * 0.7, hostCanvasBounds.y + hostCanvasBounds.height * 0.65);
      await spectatorPage.getByRole("button", { name: /^Follow/ }).click();
      const followHost = spectatorPage.getByRole("button", { name: "Follow Avery Author's cursor" });
      await expect(followHost).toBeEnabled({ timeout: 10_000 });
      await followHost.click();
      await expect(spectatorPage.getByText("Following: Avery Author’s human")).toBeVisible();
      const spectatorBounds = await spectatorCanvas.boundingBox();
      if (!spectatorBounds) throw new Error("The spectator canvas is not measurable for direct control.");
      await spectatorPage.mouse.move(spectatorBounds.x + spectatorBounds.width / 2, spectatorBounds.y + spectatorBounds.height / 2);
      await spectatorPage.mouse.wheel(0, 140);
      await expect(spectatorPage.getByText("Following: Avery Author’s human")).toHaveCount(0);

      const [spectatorDownload, spectatorResult] = await Promise.all([
        spectatorPage.waitForEvent("download"),
        callWebMcpTool<{
          filename: string;
          mimeType: string;
          persistedByJazzboard: boolean;
        }>(spectatorPage, "export_canvas_png", {
          scope: { kind: "objects", targets: [{ objectId: imageState.id, expectedRevision: imageState.revision }] },
          filename: "spectator-private-image",
          pixelRatio: 2,
        }),
      ]);
      expect(successData(spectatorResult)).toMatchObject({
        filename: "spectator-private-image.png",
        mimeType: "image/png",
        persistedByJazzboard: false,
      });
      const spectatorPngPath = await spectatorDownload.path();
      if (!spectatorPngPath) throw new Error("Spectator PNG export did not produce a file.");
      expect(await sourceColorPixels(spectatorPage, await readFile(spectatorPngPath))).toBeGreaterThan(0);

      const denied = await spectatorContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/commands`,
        {
          data: {
            command: {
              type: "delete",
              targets: [{
                objectId: SOURCE_ID,
                expectedRevision: afterDeleteAttempt.objects[SOURCE_ID].revision,
              }],
            },
          },
        },
      );
      const deniedBody = await jsonBody<ApiFailure>(denied, 403);
      expect(deniedBody).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    } finally {
      await spectatorContext.close();
    }
  });
});
