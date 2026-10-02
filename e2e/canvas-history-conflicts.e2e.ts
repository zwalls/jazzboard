import { expect, test, type Page } from "@playwright/test";

import { createCanvasObject, createRoomViaApi, getRoom, joinRoomViaApi, selectBoardMenuItem, shapeObject } from "./helpers";

const OBJECT_ID = "history-shared-note";

function object(page: Page) {
  return page.getByTestId("semantic-canvas")
    .locator(`[data-object-id="${OBJECT_ID}"][data-object-kind]`);
}

test("undo preserves a collaborator's saved label instead of overwriting it", async ({ page, browser }) => {
  test.setTimeout(60_000);
  const host = await createRoomViaApi(page.request, "History author", "Synthetic history conflict");
  await createCanvasObject(page.request, host.room.id, shapeObject(OBJECT_ID, "Original", 240, 220), "human");
  await page.goto(`/room/${host.room.id}`);
  await expect(object(page)).toBeVisible({ timeout: 20_000 });

  await object(page).focus();
  await object(page).press("Enter");
  await object(page).press("ArrowRight");
  await expect.poll(async () => (await getRoom(page.request, host.room.id)).room.objects[OBJECT_ID].revision).toBe(2);
  await expect.poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases)).toEqual([]);

  const collaborator = await browser.newContext();
  try {
    const other = await collaborator.newPage();
    await joinRoomViaApi(other.request, { code: host.room.code, displayName: "Collaborator", role: "participant" });
    await other.goto(`/room/${host.room.id}`);
    await expect(object(other)).toBeVisible({ timeout: 20_000 });
    await object(other).dblclick();
    const editor = other.getByRole("textbox", { name: `Edit shape label for object ${OBJECT_ID}` });
    await editor.fill("Collaborator's saved work");
    await editor.press("ControlOrMeta+Enter");
    await expect.poll(async () => (await getRoom(page.request, host.room.id)).room.objects[OBJECT_ID].label).toBe("Collaborator's saved work");
    await expect.poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases)).toEqual([]);
    await expect(object(page)).toHaveAttribute("data-object-revision", "3", { timeout: 12_000 });

    await page.getByTestId("semantic-canvas").press("ControlOrMeta+z");
    await expect(object(page)).toContainText("Collaborator's saved work");
    await expect(page.getByRole("alert").filter({ hasText: "changed since this history step" })).toBeVisible();
    const saved = (await getRoom(page.request, host.room.id)).room.objects[OBJECT_ID];
    expect(saved).toMatchObject({ label: "Collaborator's saved work", revision: 3 });
    // Repeated attempts through the board menu remain harmless and retryable.
    await selectBoardMenuItem(page, /^Undo/);
    await expect(page.getByRole("alert").filter({ hasText: "changed since this history step" })).toBeVisible();
    expect((await getRoom(page.request, host.room.id)).room.objects[OBJECT_ID])
      .toMatchObject({ label: "Collaborator's saved work", revision: 3 });
    await page.reload();
    await expect(object(page)).toContainText("Collaborator's saved work");
    await page.screenshot({ path: test.info().outputPath("preserved-collaborator-work.png") });
  } finally {
    await collaborator.close();
  }
});

test("repeated deletion undo and redo follow each new object incarnation", async ({ page }) => {
  const host = await createRoomViaApi(page.request, "History cycles", "Synthetic repeated history");
  await createCanvasObject(page.request, host.room.id, shapeObject(OBJECT_ID, "Keep this work", 240, 220), "human");
  await page.goto(`/room/${host.room.id}`);
  await expect(object(page)).toBeVisible({ timeout: 20_000 });
  await object(page).focus();
  await object(page).press("Enter");
  await page.getByTestId("semantic-canvas").press("Delete");
  await expect.poll(async () => (await getRoom(page.request, host.room.id)).room.objects[OBJECT_ID] ?? null).toBeNull();
  let previousIncarnation = 0;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.getByTestId("semantic-canvas").press("ControlOrMeta+z");
    await expect(object(page)).toContainText("Keep this work");
    await expect.poll(async () => (await getRoom(page.request, host.room.id)).room.objects[OBJECT_ID]?.label).toBe("Keep this work");
    const restored = (await getRoom(page.request, host.room.id)).room.objects[OBJECT_ID];
    expect(Number(restored.createdAt)).toBeGreaterThan(previousIncarnation);
    previousIncarnation = Number(restored.createdAt);
    await expect.poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases)).toEqual([]);
    await page.getByTestId("semantic-canvas").press("ControlOrMeta+Shift+z");
    await expect.poll(async () => (await getRoom(page.request, host.room.id)).room.objects[OBJECT_ID] ?? null).toBeNull();
    await expect(object(page)).toHaveCount(0);
  }
  await page.getByTestId("semantic-canvas").press("ControlOrMeta+z");
  await expect(object(page)).toContainText("Keep this work");
  await expect.poll(async () => (await getRoom(page.request, host.room.id)).room.objects[OBJECT_ID]?.label).toBe("Keep this work");
  // Cancelled text work must not enter history or leak into the durable document.
  await object(page).dblclick();
  const editor = page.getByRole("textbox", { name: `Edit shape label for object ${OBJECT_ID}` });
  await editor.fill("Cancelled draft");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(object(page)).toContainText("Keep this work");
  await expect.poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases)).toEqual([]);
  await page.reload();
  await expect(object(page)).toContainText("Keep this work");
});

test("a rejected history save recovers and can be retried without losing work", async ({ page }) => {
  const host = await createRoomViaApi(page.request, "History errors", "Synthetic failed undo");
  await createCanvasObject(page.request, host.room.id, shapeObject(OBJECT_ID, "Saved label", 240, 220), "human");
  await page.goto(`/room/${host.room.id}`);
  await expect(object(page)).toBeVisible({ timeout: 20_000 });
  await object(page).focus();
  await object(page).press("Enter");
  await object(page).press("ArrowRight");
  await expect.poll(async () => (await getRoom(page.request, host.room.id)).room.objects[OBJECT_ID].revision).toBe(2);
  await expect.poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases)).toEqual([]);
  const saved = (await getRoom(page.request, host.room.id)).room.objects[OBJECT_ID];
  await page.route(`**/api/rooms/${host.room.id}/commands`, async (route) => {
    await route.fulfill({ status: 409, json: { ok: false, error: { code: "REVISION_CONFLICT", message: "Synthetic rejected history save" } } });
  }, { times: 1 });
  await page.getByTestId("semantic-canvas").press("ControlOrMeta+z");
  await expect(page.getByRole("alert").filter({ hasText: "Synthetic rejected history save" })).toBeVisible();
  await expect(object(page)).toHaveAttribute("data-object-x", String(saved.x));
  await expect.poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases)).toEqual([]);
  expect((await getRoom(page.request, host.room.id)).room.objects[OBJECT_ID]).toMatchObject({ label: "Saved label", revision: 2 });
  await page.getByTestId("semantic-canvas").press("ControlOrMeta+z");
  await expect.poll(async () => (await getRoom(page.request, host.room.id)).room.objects[OBJECT_ID].x).toBe(240);
  await expect(object(page)).toContainText("Saved label");
  await page.reload();
  await expect(object(page)).toHaveAttribute("data-object-x", "240");
});
