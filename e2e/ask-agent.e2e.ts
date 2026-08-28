/// <reference types="webmcp-types" />

import { expect, test, type Page } from "@playwright/test";

import type { AgentMessage } from "../src/lib/agent-messages/types";
import {
  createCanvasObject,
  createRoomViaApi,
  getRoom,
  joinRoomViaApi,
  jsonBody,
  openBoardMenu,
  shapeObject,
  type ApiFailure,
} from "./helpers";

const OBJECT_ID = "ask-agent-boundary";
const OBJECT_LABEL = "Payments boundary";
const PROMPT = "Check whether this boundary is clear and tell me what to improve.";
const REPLY = "The boundary is clear. Add the retry policy beside the payment service.";
const MESSAGE_TOOL_NAMES = [
  "list_agent_messages",
  "claim_agent_message",
  "reply_to_agent_message",
] as const;

type WebMcpToolResult<T> =
  | { ok: true; tool: string; data: T }
  | { ok: false; tool: string; error: { code: string; message: string; details?: unknown } };

type MessageListData = {
  messages: AgentMessage[];
  totalMatched: number;
  truncated: boolean;
  pollAfterMs: number;
};

type ClaimData = {
  message: AgentMessage;
  claimToken: string;
};

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

function successData<T>(result: WebMcpToolResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `${result.tool} failed: ${result.error.code} ${result.error.message} ${JSON.stringify(result.error.details ?? {})}`,
    );
  }
  return result.data;
}

test("sends selected context through the private Ask inbox and exposes replies to its participant", async ({
  browser,
  page,
}) => {
  const host = await createRoomViaApi(page.request, "Ari Host", "Ask agent acceptance");
  const seeded = await createCanvasObject(
    page.request,
    host.room.id,
    shapeObject(OBJECT_ID, OBJECT_LABEL, 280, 220, "blue"),
  );
  const seededObject = seeded.room.objects[OBJECT_ID];
  const canvasRevision = seeded.room.roomRevision;

  await installWebMcpShim(page);
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  await expect(page.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => registeredToolNames(page), { timeout: 15_000 })
    .toEqual(expect.arrayContaining([...MESSAGE_TOOL_NAMES]));

  const shape = page.locator(`.tl-shape[data-shape-id="shape:${OBJECT_ID}"]`);
  await expect(shape).toBeVisible({ timeout: 15_000 });
  const bounds = await shape.boundingBox();
  if (!bounds) throw new Error(`Shape ${OBJECT_ID} has no rendered bounds.`);
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);

  await openBoardMenu(page);
  const askButton = page.getByRole("menuitem", { name: /^Ask agent/ });
  await expect(askButton).toContainText("1 selected");
  await askButton.click();

  const panel = page.getByRole("complementary", { name: "Ask your agent" });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Selected context")).toContainText(`${OBJECT_LABEL} r${seededObject.revision}`);
  await panel.getByLabel("What should your agent do?").fill(PROMPT);
  await panel.getByRole("button", { name: "Send to agent" }).click();
  await expect(panel.getByText(PROMPT, { exact: true })).toBeVisible();
  await expect(panel.getByText("pending", { exact: true })).toBeVisible();

  const pendingList = successData(
    await callWebMcpTool<MessageListData>(page, "list_agent_messages", {
      status: "pending",
      limit: 20,
    }),
  );
  expect(pendingList).toMatchObject({ totalMatched: 1, truncated: false });
  expect(pendingList.pollAfterMs).toBeGreaterThan(0);
  expect(pendingList.messages).toHaveLength(1);
  const pending = pendingList.messages[0];
  expect(pending).toMatchObject({
    id: expect.stringMatching(/^message_/),
    state: "pending",
    prompt: PROMPT,
    context: {
      room: {
        id: host.room.id,
        title: "Ask agent acceptance",
        roomRevision: canvasRevision,
      },
      selection: {
        objectIds: [OBJECT_ID],
        missingObjectIds: [],
        diagrams: [],
        objects: [
          expect.objectContaining({
            id: OBJECT_ID,
            kind: "shape",
            label: OBJECT_LABEL,
            revision: seededObject.revision,
          }),
        ],
      },
    },
  });
  const immutableContext = structuredClone(pending.context);

  const claimed = successData(
    await callWebMcpTool<ClaimData>(page, "claim_agent_message", {
      messageId: pending.id,
      leaseSeconds: 60,
    }),
  );
  expect(claimed.claimToken.length).toBeGreaterThanOrEqual(32);
  expect(claimed.message).toMatchObject({ id: pending.id, state: "claimed" });
  expect(claimed.message.context).toEqual(immutableContext);
  expect(claimed.message.context.selection.objects[0]?.revision).toBe(seededObject.revision);

  await panel.getByRole("button", { name: "Refresh" }).click();
  await expect(panel.getByText("claimed", { exact: true })).toBeVisible();
  await expect(panel.getByText("Your agent is working on this", { exact: true })).toBeVisible();

  const answered = successData(
    await callWebMcpTool<AgentMessage>(page, "reply_to_agent_message", {
      messageId: pending.id,
      claimToken: claimed.claimToken,
      text: REPLY,
      outcome: "completed",
    }),
  );
  expect(answered).toMatchObject({
    id: pending.id,
    state: "answered",
    reply: { text: REPLY, outcome: "completed" },
  });
  expect(answered.context).toEqual(immutableContext);

  await panel.getByRole("button", { name: "Refresh" }).click();
  await expect(panel.getByText("answered", { exact: true })).toBeVisible();
  await expect(panel.getByText(REPLY, { exact: true })).toBeVisible();
  await expect(panel.getByText("Completed", { exact: true })).toBeVisible();

  const answeredList = successData(
    await callWebMcpTool<MessageListData>(page, "list_agent_messages", {
      status: "answered",
      limit: 20,
    }),
  );
  expect(answeredList.messages).toHaveLength(1);
  expect(answeredList.messages[0]).toMatchObject({ id: pending.id, state: "answered" });
  expect(answeredList.messages[0]?.context).toEqual(immutableContext);

  const afterPrivateMessaging = await getRoom(page.request, host.room.id);
  expect(afterPrivateMessaging.room.roomRevision).toBe(canvasRevision);
  expect(afterPrivateMessaging.room.objects[OBJECT_ID]?.revision).toBe(seededObject.revision);

  const spectatorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const spectator = await joinRoomViaApi(spectatorContext.request, {
      code: host.room.code,
      displayName: "Sam Spectator",
      role: "spectator",
    });
    expect(spectator.room.id).toBe(host.room.id);

    const spectatorPage = await spectatorContext.newPage();
    await installWebMcpShim(spectatorPage);
    await spectatorPage.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(spectatorPage.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });
    await openBoardMenu(spectatorPage);
    await expect(spectatorPage.getByRole("menuitem", { name: "Become a participant" })).toBeVisible();
    await expect.poll(() => registeredToolNames(spectatorPage), { timeout: 15_000 }).toContain("read_room_state");
    const spectatorTools = await registeredToolNames(spectatorPage);
    for (const toolName of MESSAGE_TOOL_NAMES) expect(spectatorTools).not.toContain(toolName);
    await expect(spectatorPage.getByRole("menuitem", { name: /^Ask agent/ })).toHaveCount(0);
    await expect(
      callWebMcpTool(spectatorPage, "list_agent_messages", { status: "all", limit: 20 }),
    ).rejects.toThrow("WebMCP tool list_agent_messages is not registered");

    const privateRead = await spectatorContext.request.get(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/messages?limit=20`,
    );
    const denied = await jsonBody<ApiFailure>(privateRead, 403);
    expect(denied).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  } finally {
    await spectatorContext.close();
  }
});
