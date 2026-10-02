import { expect, test } from "@playwright/test";
import { createRoomViaApi, getRoom, joinRoomViaApi, jsonBody, selectBoardMenuItem, shapeObject } from "./helpers";

test.describe.configure({ timeout: 60_000 });

test("a stale queued deletion preserves a collaborator replacement through repeat, close, reload and rejection retry", async ({ browser, page }) => {
  const host = await createRoomViaApi(page.request, "Synthetic reviewer", "Synthetic stale proposal");
  const roomUrl = `/api/rooms/${host.room.id}`;
  await jsonBody(await page.request.post(`${roomUrl}/commands`, { data: { command: { type: "create", object: shapeObject("queued-reused", "Original", 180, 210) } } }));
  await jsonBody(await page.request.post(`${roomUrl}/review/policy`, { data: { policy: "review" } }));
  const proposed = await jsonBody<{ proposal: { id: string } }>(await page.request.post(`${roomUrl}/agent/commands`, { data: {
    command: { type: "delete", targets: [{ objectId: "queued-reused", expectedRevision: 1 }] }, metadata: { summary: "Synthetic stale deletion" },
  } }));
  const collaborator = await browser.newContext();
  try {
    await joinRoomViaApi(collaborator.request, { code: host.room.code, displayName: "Synthetic replacement author", role: "participant" });
    await jsonBody(await collaborator.request.post(`${roomUrl}/commands`, { data: { command: { type: "delete", targets: [{ objectId: "queued-reused", expectedRevision: 1 }] } } }));
    await jsonBody(await collaborator.request.post(`${roomUrl}/commands`, { data: { command: { type: "create", object: shapeObject("queued-reused", "Saved collaborator replacement", 360, 210) } } }));
    await jsonBody(await page.request.get(`${roomUrl}/review?status=pending&limit=100`));
    await jsonBody(await page.request.get(`${roomUrl}/review/${proposed.proposal.id}`));
    await page.goto(`/room/${host.room.id}`, { waitUntil: "domcontentloaded" });
    const shape = page.locator('[data-object-id="queued-reused"][data-object-kind]');
    await expect(shape).toContainText("Saved collaborator replacement", { timeout: 20_000 });
    await selectBoardMenuItem(page, /^Review/);
    const panel = page.getByRole("complementary", { name: "Agent edit review" });
    const card = panel.locator("article").filter({ hasText: "Synthetic stale deletion" });
    await expect(card).toBeVisible();
    const decisionUrl = `${roomUrl}/review/${proposed.proposal.id}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const responsePromise = page.waitForResponse((response) => response.url().endsWith(decisionUrl) && response.request().method() === "POST");
      await card.getByRole("button", { name: "Approve & apply" }).click();
      const response = await responsePromise;
      expect((await getRoom(page.request, host.room.id)).room.objects["queued-reused"]).toMatchObject({ label: "Saved collaborator replacement", revision: 1 });
      expect(response.status()).toBe(409);
      await expect(panel.getByRole("alert")).toContainText("changed");
    }
    await panel.getByRole("button", { name: "Close agent edit review" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(shape).toContainText("Saved collaborator replacement", { timeout: 20_000 });
    await selectBoardMenuItem(page, /^Review/);
    await expect(card).toBeVisible();
    let rejectAttempts = 0;
    await page.route(`**${decisionUrl}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      rejectAttempts += 1;
      if (rejectAttempts === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "MUTATION_OUTCOME_UNKNOWN", message: "Synthetic rejection failure" } }) });
      return route.continue();
    });
    await card.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("Synthetic rejection failure");
    await expect(card).toBeVisible();
    const rejected = page.waitForResponse((response) => response.url().endsWith(decisionUrl) && response.request().method() === "POST" && response.status() === 200);
    await card.getByRole("button", { name: "Reject", exact: true }).click();
    expect((await rejected).status()).toBe(200);
    await expect(card).toHaveCount(0);
    expect(rejectAttempts).toBe(2);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(shape).toContainText("Saved collaborator replacement", { timeout: 20_000 });
  } finally { await collaborator.close(); }
});

test("an unchanged queued target remains approvable after unrelated edits and an API error", async ({ page }) => {
  const host = await createRoomViaApi(page.request, "Synthetic reviewer", "Synthetic valid proposal");
  const roomUrl = `/api/rooms/${host.room.id}`;
  await jsonBody(await page.request.post(`${roomUrl}/commands`, { data: { command: { type: "create", object: shapeObject("queued-valid", "Original label", 180, 210) } } }));
  await jsonBody(await page.request.post(`${roomUrl}/review/policy`, { data: { policy: "review" } }));
  const proposed = await jsonBody<{ proposal: { id: string } }>(await page.request.post(`${roomUrl}/agent/commands`, { data: {
    command: { type: "update", objectId: "queued-valid", expectedRevision: 1, operation: "edit", patch: { label: "Approved label" } }, metadata: { summary: "Synthetic valid update" },
  } }));
  await jsonBody(await page.request.post(`${roomUrl}/commands`, { data: { command: { type: "create", object: shapeObject("unrelated", "Keep unrelated", 600, 210) } } }));
  await jsonBody(await page.request.get(`${roomUrl}/review?status=pending&limit=100`));
  await jsonBody(await page.request.get(`${roomUrl}/review/${proposed.proposal.id}`));
  await page.goto(`/room/${host.room.id}`, { waitUntil: "domcontentloaded" });
  const shape = page.locator('[data-object-id="queued-valid"][data-object-kind]');
  await expect(shape).toContainText("Original label", { timeout: 20_000 });
  await selectBoardMenuItem(page, /^Review/);
  const panel = page.getByRole("complementary", { name: "Agent edit review" });
  const card = panel.locator("article").filter({ hasText: "Synthetic valid update" });
  await expect(card).toBeVisible();
  await panel.getByRole("button", { name: "Close agent edit review" }).click();
  expect((await getRoom(page.request, host.room.id)).room.objects["queued-valid"]).toMatchObject({ label: "Original label", revision: 1 });
  await selectBoardMenuItem(page, /^Review/);
  let attempts = 0;
  const decisionUrl = `${roomUrl}/review/${proposed.proposal.id}`;
  await page.route(`**${decisionUrl}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts += 1;
    if (attempts === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "MUTATION_OUTCOME_UNKNOWN", message: "Synthetic approval failure" } }) });
    return route.continue();
  });
  await card.getByRole("button", { name: "Approve & apply" }).click();
  await expect(panel.getByRole("alert")).toContainText("Synthetic approval failure");
  expect((await getRoom(page.request, host.room.id)).room.objects["queued-valid"]).toMatchObject({ label: "Original label", revision: 1 });
  const accepted = page.waitForResponse((response) => response.url().endsWith(decisionUrl) && response.request().method() === "POST" && response.status() === 200);
  await card.getByRole("button", { name: "Approve & apply" }).click();
  expect((await accepted).status()).toBe(200);
  await expect(shape).toContainText("Approved label");
  expect(attempts).toBe(2);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(shape).toContainText("Approved label", { timeout: 20_000 });
  await expect(page.locator('[data-object-id="unrelated"][data-object-kind]')).toContainText("Keep unrelated");
  expect((await getRoom(page.request, host.room.id)).room.objects["queued-valid"].revision).toBe(2);
});
