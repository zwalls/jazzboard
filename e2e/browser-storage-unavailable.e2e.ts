import { expect, test, type Page } from "@playwright/test";

import { createRoomViaApi } from "./helpers";
import { CLIENT_CAPABILITIES_HEADER, SPLIT_STATE_CLIENT_CAPABILITY } from "../src/lib/realtime/protocol";

declare global {
  interface Window {
    __storageTestTools: Map<string, WebMCP.ModelContextTool>;
  }
}

async function blockBrowserStorage(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new DOMException("Synthetic storage access denial", "SecurityError"); },
    });
    const tools = new Map<string, WebMCP.ModelContextTool>();
    window.__storageTestTools = tools;
    const context = new EventTarget() as WebMCP.ModelContext;
    context.ontoolchange = null;
    context.registerTool = async (tool, options) => {
      tools.set(tool.name, tool);
      options?.signal?.addEventListener("abort", () => tools.delete(tool.name), { once: true });
    };
    Object.defineProperty(document, "modelContext", { configurable: true, value: context });
  });
}

test("creates and reloads a room when localStorage access is denied", async ({ page }) => {
  test.setTimeout(60_000);
  await blockBrowserStorage(page);
  await page.goto("/");
  await page.getByLabel("Your display name").fill("Storage-denied creator");
  const created = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/rooms" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create my Jazzboard" }).click();
  const payload = await (await created).json();
  expect(payload.ok).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/room/${payload.room.id}$`));
  await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
  const membership = await page.evaluate(async ({ roomId, header, capability }) => {
    const response = await fetch(`/api/rooms/${roomId}`, { headers: { [header]: capability } });
    return { status: response.status, body: await response.json() };
  }, { roomId: payload.room.id, header: CLIENT_CAPABILITIES_HEADER, capability: SPLIT_STATE_CLIENT_CAPABILITY });
  expect(membership.status).toBe(200);
  expect(membership.body.participantId).toBe(payload.participantId);
  await page.reload();
  await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: test.info().outputPath("storage-denied-room-open.png") });
});

test("keeps exact-code joining and agent discovery usable without local storage", async ({ page, request }) => {
  test.setTimeout(60_000);
  const host = await createRoomViaApi(request, "Storage test host", "Synthetic storage-denied join");
  await blockBrowserStorage(page);
  await page.goto("/");
  await expect.poll(() => page.evaluate(() =>
    [...window.__storageTestTools.keys()],
  )).toEqual(["create_room", "join_room", "list_recent_rooms", "open_recent_room", "remove_recent_room"]);
  const recent = await page.evaluate(async () => {
    const tool = window.__storageTestTools.get("list_recent_rooms")!;
    return tool.execute({}, { signal: new AbortController().signal });
  });
  expect(recent).toMatchObject({ ok: true, data: { rooms: [] } });
  await page.getByRole("tab", { name: "Join by code" }).click();
  await page.getByLabel("Room code").fill("ABO234");
  await page.getByLabel("Your display name").fill("Storage-denied joiner");
  await page.getByRole("button", { name: "Join this Jazzboard" }).click();
  await expect(page.getByText("Enter the six-character Jazzboard code. Older rooms may use four digits.")).toBeVisible();
  await page.getByLabel("Room code").fill(host.room.code);
  await page.getByRole("button", { name: "Join this Jazzboard" }).click();
  await expect(page).toHaveURL(new RegExp(`/room/${host.room.id}$`));
  await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
});
