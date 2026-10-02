import { expect, test } from "@playwright/test";
import { createRoomViaApi, getRoom, joinRoomViaApi, jsonBody, selectBoardMenuItem, shapeObject } from "./helpers";

test.describe.configure({ timeout: 60_000 });

type Activity = {
  id: string;
  objectGuards: Record<string, { state: "present"; revision: number } | { state: "absent" }>;
  diagramGuards: Record<string, { state: "present"; revision: number } | { state: "absent" }>;
};

function revertBody(activity: Activity) {
  return {
    objectExpectations: Object.entries(activity.objectGuards).map(([objectId, guard]) => guard.state === "present"
      ? { objectId, state: "present", expectedRevision: guard.revision } : { objectId, state: "absent" }),
    diagramExpectations: Object.entries(activity.diagramGuards).map(([diagramId, guard]) => guard.state === "present"
      ? { diagramId, state: "present", expectedRevision: guard.revision } : { diagramId, state: "absent" }),
  };
}

test("an old activity cannot delete a collaborator's replacement object or the rest of its creation", async ({ browser, page }) => {
  const host = await createRoomViaApi(page.request, "Synthetic activity owner", "Synthetic activity incarnations");
  const original = await jsonBody<{ activity: Activity }>(await page.request.post(`/api/rooms/${host.room.id}/semantic`, {
    data: { action: "transaction", transaction: {
      commands: [
        { type: "create", object: shapeObject("activity-reused", "Original object", 180, 210) },
        { type: "create", object: shapeObject("activity-second", "Keep this untouched", 600, 210) },
      ], diagramCommands: [],
    }, metadata: { summary: "Synthetic original pair" } },
  }));
  const beforeReplacement = await getRoom(page.request, host.room.id);
  const collaborator = await browser.newContext();
  try {
    await joinRoomViaApi(collaborator.request, { code: host.room.code, displayName: "Synthetic replacement editor", role: "participant" });
    await jsonBody(await collaborator.request.post(`/api/rooms/${host.room.id}/commands`, { data: {
      command: { type: "delete", targets: [{ objectId: "activity-reused", expectedRevision: 1 }] },
    } }));
    await jsonBody(await collaborator.request.post(`/api/rooms/${host.room.id}/commands`, { data: {
      command: { type: "create", object: shapeObject("activity-reused", "Collaborator replacement", 360, 210) },
    } }));
    const replacement = (await getRoom(page.request, host.room.id)).room.objects["activity-reused"];
    expect(replacement.revision).toBe(1);
    expect(replacement.createdAt).not.toBe(beforeReplacement.room.objects["activity-reused"].createdAt);
    await jsonBody(await page.request.get(`/api/rooms/${host.room.id}/activity?limit=60`));
    await page.goto(`/room/${host.room.id}`, { waitUntil: "domcontentloaded" });
    const shape = page.locator('[data-object-id="activity-reused"][data-object-kind]');
    await expect(shape).toContainText("Collaborator replacement", { timeout: 20_000 });
    await selectBoardMenuItem(page, "Activity");
    const panel = page.getByRole("complementary", { name: "Room activity" });
    const originalCard = panel.locator("article").filter({ hasText: "Synthetic original pair" });
    await expect(originalCard).toBeVisible();
    const responded = page.waitForResponse((response) => response.url().endsWith(`/activity/${original.activity.id}/revert`) && response.request().method() === "POST");
    await originalCard.getByRole("button", { name: "Revert safely" }).click();
    const response = await responded;
    const durableAfter = (await getRoom(page.request, host.room.id)).room;
    expect(durableAfter.objects["activity-reused"]).toMatchObject({ label: "Collaborator replacement", revision: 1, createdAt: replacement.createdAt });
    expect(durableAfter.objects["activity-second"]).toMatchObject({ label: "Keep this untouched", revision: 1 });
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe("REVISION_CONFLICT");
    await expect(panel.getByRole("alert")).toContainText("recreated");
    const retry = page.waitForResponse((result) => result.url().endsWith(`/activity/${original.activity.id}/revert`) && result.request().method() === "POST");
    await originalCard.getByRole("button", { name: "Revert safely" }).click();
    expect((await retry).status()).toBe(409);
    await panel.getByRole("button", { name: "Close room activity" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(shape).toContainText("Collaborator replacement", { timeout: 20_000 });
    await expect(page.locator('[data-object-id="activity-second"][data-object-kind]')).toBeVisible();
  } finally { await collaborator.close(); }
});

test("reverting an older Diagram creation cannot remove a later Diagram with the same ID", async ({ page }) => {
  const host = await createRoomViaApi(page.request, "Synthetic diagram owner", "Synthetic diagram incarnations");
  const createDiagram = async (title: string) => jsonBody<{ activity: Activity }>(await page.request.post(`/api/rooms/${host.room.id}/semantic`, {
    data: { action: "transaction", transaction: { commands: [], diagramCommands: [{ type: "diagram.create", diagram: {
      id: "reused-diagram", title, description: "Synthetic persisted diagram metadata", diagramType: "architecture",
      category: "system", tags: ["synthetic"], memberObjectIds: [], connectorIds: [],
    } }] }, metadata: { summary: `Synthetic ${title} creation` } },
  }));
  const original = await createDiagram("Original diagram");
  await jsonBody(await page.request.post(`/api/rooms/${host.room.id}/activity/${original.activity.id}/revert`, { data: revertBody(original.activity) }));
  const replacement = await createDiagram("Replacement diagram");
  const before = (await getRoom(page.request, host.room.id)).room;
  await jsonBody(await page.request.get(`/api/rooms/${host.room.id}/activity?limit=60`));
  await page.goto(`/room/${host.room.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
  await selectBoardMenuItem(page, "Activity");
  const panel = page.getByRole("complementary", { name: "Room activity" });
  const originalCard = panel.locator("article").filter({ hasText: "Synthetic Original diagram creation" });
  const rejected = page.waitForResponse((response) => response.url().endsWith(`/activity/${original.activity.id}/revert`) && response.request().method() === "POST");
  await originalCard.getByRole("button", { name: "Revert safely" }).click();
  const response = await rejected;
  const after = (await getRoom(page.request, host.room.id)).room;
  expect(after.diagrams["reused-diagram"]).toMatchObject({ title: "Replacement diagram", revision: 1, createdAt: before.diagrams["reused-diagram"].createdAt });
  expect(response.status()).toBe(409);
  // A fresh creation's compensation remains valid, demonstrating retry safety
  // without disabling the useful activity workflow.
  const accepted = page.waitForResponse((response) => response.url().endsWith(`/activity/${replacement.activity.id}/revert`) && response.request().method() === "POST");
  await panel.locator("article").filter({ hasText: "Synthetic Replacement diagram creation" }).getByRole("button", { name: "Revert safely" }).click();
  expect((await accepted).status()).toBe(200);
  expect((await getRoom(page.request, host.room.id)).room.diagrams).not.toHaveProperty("reused-diagram");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
});

test("a valid activity compensation remains retryable after an error and survives reload", async ({ page }) => {
  const host = await createRoomViaApi(page.request, "Synthetic retry editor", "Synthetic activity retry");
  await jsonBody(await page.request.post(`/api/rooms/${host.room.id}/commands`, { data: {
    command: { type: "create", object: shapeObject("activity-valid", "Original label", 180, 210) },
  } }));
  const target = await jsonBody<{ activity: Activity }>(await page.request.post(`/api/rooms/${host.room.id}/commands`, { data: {
    command: { type: "update", objectId: "activity-valid", expectedRevision: 1, operation: "edit", patch: { label: "Saved change" } },
    metadata: { summary: "Synthetic reversible label edit" },
  } }));
  await jsonBody(await page.request.get(`/api/rooms/${host.room.id}/activity?limit=60`));
  await page.goto(`/room/${host.room.id}`, { waitUntil: "domcontentloaded" });
  const shape = page.locator('[data-object-id="activity-valid"][data-object-kind]');
  await expect(shape).toContainText("Saved change", { timeout: 20_000 });
  let attempts = 0;
  let failNext = true;
  await page.route(`**/api/rooms/${host.room.id}/activity/${target.activity.id}/revert`, async (route) => {
    attempts += 1;
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({
        ok: false, error: { code: "REQUEST_FAILED", message: "Synthetic activity unavailable" },
      }) });
    } else await route.continue();
  });
  await selectBoardMenuItem(page, "Activity");
  const panel = page.getByRole("complementary", { name: "Room activity" });
  await panel.getByRole("button", { name: "Close room activity" }).click();
  expect(attempts).toBe(0);
  await selectBoardMenuItem(page, "Activity");
  const card = panel.locator("article").filter({ hasText: "Synthetic reversible label edit" });
  await card.getByRole("button", { name: "Revert safely" }).click();
  await expect(panel.getByRole("alert")).toContainText("Synthetic activity unavailable");
  expect((await getRoom(page.request, host.room.id)).room.objects["activity-valid"]).toMatchObject({ label: "Saved change", revision: 2 });
  await card.getByRole("button", { name: "Revert safely" }).click();
  await expect(shape).toContainText("Original label");
  expect(attempts).toBe(2);
  expect((await getRoom(page.request, host.room.id)).room.objects["activity-valid"]).toMatchObject({ label: "Original label", revision: 3 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(shape).toContainText("Original label", { timeout: 20_000 });
});
