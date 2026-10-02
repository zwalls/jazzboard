import { expect, test, type Page } from "@playwright/test";
import { CLIENT_CAPABILITIES_HEADER, SPLIT_STATE_CLIENT_CAPABILITY } from "@/lib/realtime/protocol";
import { createRoomViaApi } from "./helpers";

test.describe.configure({ timeout: 60_000 });

async function authorizationFor(tab: Page) {
  return tab.evaluate(async ([header, capability]) => {
    const roomId = location.pathname.split("/").at(-1);
    const response = await fetch(`/api/rooms/${roomId}`, { credentials: "same-origin", headers: { [header]: capability } });
    return { status: response.status, body: await response.json() };
  }, [CLIENT_CAPABILITIES_HEADER, SPLIT_STATE_CLIENT_CAPABILITY]);
}

test("keeps both rooms authorized when two fresh tabs create at the same time", async ({ context, page }) => {
  const other = await context.newPage();
  await Promise.all([page.goto("/"), other.goto("/")]);
  await page.getByLabel("Your display name").fill("Synthetic first tab");
  await other.getByLabel("Your display name").fill("Synthetic second tab");
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirst = resolve; });
  let requests = 0;
  const initialCookies: string[] = [];
  await context.route("**/api/rooms", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    const requestHeaders = await route.request().allHeaders();
    initialCookies.push(requestHeaders.cookie ?? "");
    if (++requests === 1) { markFirst(); await gate; }
    // Preserve the credentials actually sent before the delayed processing,
    // rather than picking up a different tab's cookie during route.fetch.
    const response = await route.fetch({ headers: { ...requestHeaders, cookie: requestHeaders.cookie ?? "" } });
    expect(response.ok()).toBe(true);
    await route.fulfill({ response });
  });
  try {
    const clicks = Promise.all([
      page.getByRole("button", { name: "Create my Jazzboard" }).click(),
      other.getByRole("button", { name: "Create my Jazzboard" }).click(),
    ]);
    await firstStarted;
    await page.waitForTimeout(350);
    releaseFirst();
    await clicks;
    await Promise.all([
      expect(page).toHaveURL(/\/room\/room_[^/?#]+$/, { timeout: 20_000 }),
      expect(other).toHaveURL(/\/room\/room_[^/?#]+$/, { timeout: 20_000 }),
    ]);
    expect(initialCookies[0]).toBe("");
    const authorization = await Promise.all([page, other].map(authorizationFor));
    expect(authorization.map((result) => result.status)).toEqual([200, 200]);
    expect(authorization[0].body.participantId).toBe(authorization[1].body.participantId);
    await Promise.all([page.reload({ waitUntil: "domcontentloaded" }), other.reload({ waitUntil: "domcontentloaded" })]);
    await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
    await expect(other.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
  } finally { releaseFirst(); await other.close(); }
});

test("closing a queued entry tab sends no mutation and a replacement tab can enter", async ({ context, page }) => {
  const cancelled = await context.newPage();
  await Promise.all([page.goto("/"), cancelled.goto("/")]);
  await page.getByLabel("Your display name").fill("Synthetic held entry");
  await cancelled.getByLabel("Your display name").fill("Synthetic cancelled tab");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const names: string[] = [];
  await context.route("**/api/rooms", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    names.push(route.request().postDataJSON().displayName);
    if (names.length === 1) { markStarted(); await gate; }
    await route.continue();
  });
  let replacement: Page | null = null;
  try {
    await page.getByRole("button", { name: "Create my Jazzboard" }).click();
    await started;
    await cancelled.getByRole("button", { name: "Create my Jazzboard" }).click();
    await page.waitForTimeout(350);
    expect(names).toEqual(["Synthetic held entry"]);
    await cancelled.close();
    replacement = await context.newPage();
    await replacement.goto("/");
    await replacement.getByLabel("Your display name").fill("Synthetic replacement tab");
    await replacement.getByRole("button", { name: "Create my Jazzboard" }).click();
    await page.waitForTimeout(350);
    expect(names).toEqual(["Synthetic held entry"]);
    release();
    await expect(page).toHaveURL(/\/room\/room_[^/?#]+$/, { timeout: 20_000 });
    await expect(replacement).toHaveURL(/\/room\/room_[^/?#]+$/, { timeout: 20_000 });
    const authorization = await Promise.all([page, replacement].map(authorizationFor));
    expect(authorization.map((result) => result.status)).toEqual([200, 200]);
    expect(authorization[0].body.participantId).toBe(authorization[1].body.participantId);
    expect(names).toEqual(["Synthetic held entry", "Synthetic replacement tab"]);
    await replacement.reload({ waitUntil: "domcontentloaded" });
    await expect(replacement.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
  } finally {
    release();
    if (!cancelled.isClosed()) await cancelled.close();
    await replacement?.close();
  }
});

test("a failed entry releases the queue for spectator joining and an authorized retry", async ({ browser, context, page }) => {
  const hostContext = await browser.newContext();
  const host = await createRoomViaApi(hostContext.request, "Synthetic independent host", "Synthetic joining target");
  await hostContext.close();
  const joining = await context.newPage();
  await Promise.all([page.goto("/"), joining.goto("/")]);
  await page.getByLabel("Your display name").fill("Synthetic retry creator");
  await joining.getByRole("tab", { name: "Join by code" }).click();
  await joining.getByLabel("Room code").fill(host.room.code);
  await joining.getByLabel("Your display name").fill("Synthetic queued spectator");
  await joining.getByRole("radio", { name: /^spectator/i }).check();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let requests = 0;
  await context.route("**/api/rooms", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    if (++requests === 1) {
      markStarted();
      await gate;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({
        ok: false, error: { code: "REQUEST_FAILED", message: "Synthetic entry unavailable" },
      }) });
    } else await route.continue();
  });
  try {
    await page.getByRole("button", { name: "Create my Jazzboard" }).click();
    await started;
    await joining.getByRole("button", { name: "Join this Jazzboard" }).click();
    await page.waitForTimeout(350);
    expect(requests).toBe(1);
    release();
    await expect(page.getByText("Synthetic entry unavailable", { exact: true })).toBeVisible();
    await expect(joining).toHaveURL(`/room/${host.room.id}`, { timeout: 20_000 });
    await page.getByRole("button", { name: "Create my Jazzboard" }).click();
    await expect(page).toHaveURL(/\/room\/room_[^/?#]+$/, { timeout: 20_000 });
    const authorization = await Promise.all([page, joining].map(authorizationFor));
    expect(authorization.map((result) => result.status)).toEqual([200, 200]);
    const participantId = authorization[0].body.participantId;
    expect(participantId).toBe(authorization[1].body.participantId);
    expect(authorization[0].body.room.participants[participantId].role).toBe("participant");
    expect(authorization[1].body.room.participants[participantId].role).toBe("spectator");
    expect(requests).toBe(3);
    await Promise.all([page.reload({ waitUntil: "domcontentloaded" }), joining.reload({ waitUntil: "domcontentloaded" })]);
    await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
    await expect(joining.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
  } finally { release(); await joining.close(); }
});
