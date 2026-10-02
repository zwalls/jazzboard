import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { createCanvasObject, createRoomViaApi, getRoom, jsonBody, selectBoardMenuItem, shapeObject } from "./helpers";

test("waits for a visible pending edit before exporting semantic state and permits retry", async ({ page }) => {
  test.setTimeout(60_000);
  const host = await createRoomViaApi(page.request, "Export editor", "Synthetic export persistence");
  await createCanvasObject(page.request, host.room.id, shapeObject("export-shape", "Exported shape", 180, 210), "human");
  await page.goto(`/room/${host.room.id}`);
  const shape = page.locator('[data-object-id="export-shape"][data-object-kind]');
  await expect(shape).toBeVisible({ timeout: 20_000 });
  expect((await page.request.get(`/api/rooms/${host.room.id}/artifacts?format=semantic_json&scope=room`)).ok()).toBe(true);
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  let markSaving!: () => void;
  const saving = new Promise<void>((resolve) => { markSaving = resolve; });
  let holdSave = true;
  await page.route(`**/api/rooms/${host.room.id}/commands`, async (route) => {
    if (route.request().method() === "POST" && holdSave) {
      holdSave = false;
      markSaving();
      await saveGate;
    }
    await route.continue();
  });
  let artifactReads = 0;
  let failNextExport = false;
  await page.route(`**/api/rooms/${host.room.id}/artifacts?**`, async (route) => {
    artifactReads += 1;
    if (failNextExport) {
      failNextExport = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({
        ok: false, error: { code: "REQUEST_FAILED", message: "Synthetic export unavailable" },
      }) });
    } else await route.continue();
  });
  try {
    await shape.click();
    await page.getByTestId("semantic-canvas").press("ArrowRight");
    await saving;
    await expect(shape).toHaveAttribute("data-object-x", "181");
    expect((await getRoom(page.request, host.room.id)).room.objects["export-shape"].x).toBe(180);
    await selectBoardMenuItem(page, "Export");
    const panel = page.getByRole("complementary", { name: "Export board" });
    const downloaded = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Semantic JSON" }).click();
    await page.waitForTimeout(350);
    if (artifactReads > 0) {
      const premature = JSON.parse(await readFile((await (await downloaded).path())!, "utf8"));
      expect(premature.objects.find((object: { id: string }) => object.id === "export-shape").x).toBe(181);
    }
    expect(artifactReads).toBe(0);
    releaseSave();
    const file = await downloaded;
    const artifact = JSON.parse(await readFile((await file.path())!, "utf8"));
    expect(artifact.objects.find((object: { id: string }) => object.id === "export-shape").x).toBe(181);
    failNextExport = true;
    await panel.getByRole("button", { name: "Semantic JSON" }).click();
    await expect(panel.getByRole("alert")).toHaveText("Synthetic export unavailable");
    const retried = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Semantic JSON" }).click();
    const retryArtifact = JSON.parse(await readFile((await (await retried).path())!, "utf8"));
    expect(retryArtifact.objects.find((object: { id: string }) => object.id === "export-shape").x).toBe(181);
    await page.reload();
    await expect(shape).toHaveAttribute("data-object-x", "181", { timeout: 20_000 });
  } finally {
    releaseSave();
  }
});

test("cancels a delayed semantic download when its panel closes", async ({ page }) => {
  const host = await createRoomViaApi(page.request, "Cancel export editor", "Synthetic cancelled export");
  await page.goto(`/room/${host.room.id}`);
  await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
  await page.request.get(`/api/rooms/${host.room.id}/artifacts?format=semantic_json&scope=room`);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  let markReleased!: () => void;
  const released = new Promise<void>((resolve) => { markReleased = resolve; });
  let downloads = 0;
  page.on("download", () => { downloads += 1; });
  await page.route(`**/api/rooms/${host.room.id}/artifacts?**`, async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    markReady();
    await gate;
    await route.fulfill({ response }).catch(() => undefined);
    markReleased();
  });
  try {
    await selectBoardMenuItem(page, "Export");
    const panel = page.getByRole("complementary", { name: "Export board" });
    await panel.getByRole("button", { name: "Semantic JSON" }).click();
    await ready;
    await panel.getByRole("button", { name: "Close export" }).click();
    release();
    await released;
    await page.waitForTimeout(350);
    expect(downloads).toBe(0);
    await selectBoardMenuItem(page, "Export");
    await expect(panel.getByRole("button", { name: "Semantic JSON" })).toBeEnabled();
  } finally { release(); }
});

test("closing a template import during file reading prevents its later board mutation", async ({ page }) => {
  test.setTimeout(60_000);
  const host = await createRoomViaApi(page.request, "Cancel import editor", "Synthetic cancelled import");
  await jsonBody(await page.request.post(`/api/rooms/${host.room.id}/semantic`, { data: {
    action: "transaction", transaction: {
      commands: [{ type: "create", object: shapeObject("template-source", "Template source", 180, 210) }],
      diagramCommands: [{ type: "diagram.create", diagram: {
        id: "template-diagram", title: "Synthetic template", description: "Local cancellation QA", diagramType: "flow",
        category: "system", tags: [], memberObjectIds: ["template-source"], connectorIds: [],
      } }],
    },
  } }));
  const exported = await jsonBody<{ export: { content: string } }>(await page.request.get(
    `/api/rooms/${host.room.id}/artifacts?format=template&scope=diagram&diagramId=template-diagram`,
  ));
  await page.goto(`/room/${host.room.id}`);
  await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = async function () {
      const text = await original.call(this);
      if (this.name !== "synthetic-cancel-template.json") return text;
      document.documentElement.dataset.templateReading = "true";
      return new Promise<string>((resolve) => {
        window.addEventListener("synthetic-template-read-release", () => resolve(text), { once: true });
      });
    };
  });
  let mutations = 0;
  let failNextImport = false;
  let markCommitted!: () => void;
  const committed = new Promise<void>((resolve) => { markCommitted = resolve; });
  await page.route(`**/api/rooms/${host.room.id}/artifacts`, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    mutations += 1;
    if (failNextImport) {
      failNextImport = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({
        ok: false, error: { code: "REQUEST_FAILED", message: "Synthetic import unavailable" },
      }) });
      return;
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    markCommitted();
    await route.fulfill({ response });
  });
  await selectBoardMenuItem(page, "Export");
  const panel = page.getByRole("complementary", { name: "Export board" });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), panel.getByRole("button", { name: "Add template here" }).click()]);
  await chooser.setFiles({ name: "synthetic-cancel-template.json", mimeType: "application/json", buffer: Buffer.from(exported.export.content) });
  await expect(page.locator("html")).toHaveAttribute("data-template-reading", "true");
  await panel.getByRole("button", { name: "Close export" }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("synthetic-template-read-release")));
  await page.waitForTimeout(350);
  if (mutations > 0) await committed;
  expect(Object.keys((await getRoom(page.request, host.room.id)).room.objects)).toEqual(["template-source"]);
  expect(mutations).toBe(0);

  await selectBoardMenuItem(page, "Export");
  const chooseTemplate = async () => {
    const [retryChooser] = await Promise.all([
      page.waitForEvent("filechooser"), panel.getByRole("button", { name: "Add template here" }).click(),
    ]);
    await retryChooser.setFiles({ name: "synthetic-retry-template.json", mimeType: "application/json", buffer: Buffer.from(exported.export.content) });
  };
  failNextImport = true;
  await chooseTemplate();
  await expect(panel.getByRole("alert")).toHaveText("Synthetic import unavailable");
  expect(Object.keys((await getRoom(page.request, host.room.id)).room.objects)).toHaveLength(1);
  await chooseTemplate();
  await expect(page.locator('[data-object-kind="shape"]')).toHaveCount(2);
  expect(mutations).toBe(2);
  const importedIds = Object.keys((await getRoom(page.request, host.room.id)).room.objects);
  expect(importedIds).toHaveLength(2);
  expect(importedIds).toContain("template-source");
  await page.reload();
  await expect(page.locator('[data-object-kind="shape"]')).toHaveCount(2, { timeout: 20_000 });
  expect(Object.keys((await getRoom(page.request, host.room.id)).room.objects).sort()).toEqual(importedIds.sort());
});
