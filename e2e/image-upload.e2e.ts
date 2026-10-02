import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { createRoomViaApi, getRoom, selectBoardMenuItem } from "./helpers";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z7DlPwMewIRPcvgoAADJ3wLCTMjowgAAAABJRU5ErkJggg==",
  "base64",
);

test("preserves a reviewed image after upload failure, permits cancellation, and saves a retry", async ({ page }) => {
  const host = await createRoomViaApi(page.request, "Image recovery editor", "Synthetic image recovery");
  await page.goto(`/room/${host.room.id}`);
  await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
  const assetUrl = `**/api/rooms/${host.room.id}/assets`;
  let failNextUpload = true;
  await page.route(assetUrl, async (route) => {
    if (route.request().method() === "POST" && failNextUpload) {
      failNextUpload = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({
        ok: false, error: { code: "REQUEST_FAILED", message: "Synthetic upload failure" },
      }) });
    } else await route.continue();
  });
  const offer = async () => {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Image tool", exact: true }).click()]);
    await chooser.setFiles({ name: "synthetic-recovery.png", mimeType: "image/png", buffer: TINY_PNG });
  };
  await offer();
  const dialog = page.getByRole("dialog", { name: "Add an accessible image" });
  await dialog.getByLabel("Image description").fill("Reviewed recovery image");
  await dialog.getByRole("button", { name: "Add to canvas" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Synthetic upload failure");
  await expect(dialog.getByLabel("Image description")).toHaveValue("Reviewed recovery image");
  expect(Object.keys((await getRoom(page.request, host.room.id)).room.objects)).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel image selection" }).click();
  await expect(dialog).toHaveCount(0);
  await offer();
  await dialog.getByLabel("Image description").fill("Successful retry image");
  await dialog.getByRole("button", { name: "Add to canvas" }).click();
  await expect(page.locator('[data-object-kind="image"]')).toHaveCount(1);
  await expect.poll(async () => Object.values((await getRoom(page.request, host.room.id)).room.objects).map((object) => object.alt)).toEqual(["Successful retry image"]);
  await page.reload();
  await expect(page.locator('[data-object-kind="image"]')).toBeVisible({ timeout: 20_000 });
});

test("ignores a completed image upload response after cancellation and permits a new upload", async ({ page }) => {
  const host = await createRoomViaApi(page.request, "Late-upload editor", "Synthetic upload cancellation");
  await page.goto(`/room/${host.room.id}`);
  await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  let markStored!: () => void;
  const stored = new Promise<void>((resolve) => { markStored = resolve; });
  let holdNext = true;
  await page.route(`**/api/rooms/${host.room.id}/assets`, async (route) => {
    if (route.request().method() !== "POST" || !holdNext) { await route.continue(); return; }
    holdNext = false;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    markStored();
    await responseGate;
    // The cancelled browser request may already be handled; its completion
    // must never become a semantic object or interfere with the new picker.
    await route.fulfill({ response }).catch(() => undefined);
  });
  const offer = async () => {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Image tool", exact: true }).click()]);
    await chooser.setFiles({ name: "synthetic-cancel.png", mimeType: "image/png", buffer: TINY_PNG });
  };
  try {
    await offer();
    const dialog = page.getByRole("dialog", { name: "Add an accessible image" });
    await dialog.getByRole("button", { name: "Add to canvas" }).click();
    await stored;
    await dialog.getByRole("button", { name: "Cancel image upload" }).click();
    releaseResponse();
    await expect(dialog).toHaveCount(0);
    expect(Object.keys((await getRoom(page.request, host.room.id)).room.objects)).toEqual([]);
    await offer();
    await dialog.getByLabel("Image description").fill("New upload after cancellation");
    await dialog.getByRole("button", { name: "Add to canvas" }).click();
    await expect.poll(async () => Object.values((await getRoom(page.request, host.room.id)).room.objects).map((object) => object.alt)).toEqual(["New upload after cancellation"]);
    await page.reload();
    await expect(page.locator('[data-object-kind="image"]')).toHaveCount(1);
  } finally {
    releaseResponse();
  }
});

test("adds and exports an accessible screenshot-style image through the semantic canvas", async ({ page }) => {
  const host = await createRoomViaApi(page.request, "Iris Illustrator", "Image annotation");
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  await expect(page.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Image tool" }).click(),
  ]);
  await chooser.setFiles({ name: "website-screenshot.png", mimeType: "image/png", buffer: TINY_PNG });
  const imageDialog = page.getByRole("dialog", { name: "Add an accessible image" });
  await expect(imageDialog).toBeVisible();
  await imageDialog.getByLabel("Image description").fill("Website screenshot showing the Jazzboard home page");
  const storedAsset = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/rooms/${host.room.id}/assets` &&
      response.ok(),
  );
  await imageDialog.getByRole("button", { name: "Add to canvas" }).click();
  await storedAsset;
  const imageShape = page.locator('[data-object-kind="image"]');
  await expect(imageShape).toBeVisible();

  const image = await expect
    .poll(
      async () => {
        const state = await getRoom(page.request, host.room.id);
        return Object.values(state.room.objects).find((object) => object.kind === "image") ?? null;
      },
      { timeout: 15_000 },
    )
    .not.toBeNull();
  void image;

  const state = await getRoom(page.request, host.room.id);
  const storedImage = Object.values(state.room.objects).find((object) => object.kind === "image");
  expect(storedImage).toMatchObject({ kind: "image", mimeType: "image/png", revision: 1 });
  expect(String(storedImage?.url)).toMatch(
    new RegExp(`/api/rooms/${host.room.id}/assets\\?assetId=`),
  );

  const assetResponse = await page.request.get(String(storedImage?.url));
  expect(assetResponse.status()).toBe(200);
  expect(assetResponse.headers()["content-type"]).toBe("image/png");
  expect(Buffer.from(await assetResponse.body())).toEqual(TINY_PNG);

  await expect
    .poll(() =>
      page.locator("[data-object-id]").evaluateAll((elements) =>
        [...new Set(elements.map((element) => element.getAttribute("data-object-id")))].sort(),
      ),
    )
    .toEqual(Object.keys(state.room.objects).sort());

  const imageBounds = await imageShape.boundingBox();
  expect(imageBounds).not.toBeNull();
  await page.mouse.click(
    imageBounds!.x + imageBounds!.width / 2,
    imageBounds!.y + imageBounds!.height / 2,
    { button: "right" },
  );
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Download original" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Export/i })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await selectBoardMenuItem(page, /^Canvas outline/);
  const outline = page.getByRole("complementary", { name: "Canvas outline" });
  await expect(outline.getByText("1 objects")).toBeVisible();
  await expect(
    outline.getByText("Website screenshot showing the Jazzboard home page", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Close canvas outline" }).click();
  await selectBoardMenuItem(page, "Export");
  const exportPanel = page.getByRole("complementary", { name: "Export board" });
  const [pngDownload] = await Promise.all([
    page.waitForEvent("download"),
    exportPanel.getByRole("button", { name: "PNG" }).click(),
  ]);
  expect(pngDownload.suggestedFilename()).toBe("image-annotation.png");
  const pngPath = await pngDownload.path();
  expect(pngPath).not.toBeNull();
  const exportedPng = await readFile(pngPath!);
  expect(exportedPng.subarray(1, 4).toString("ascii")).toBe("PNG");

  const pixels = await page.evaluate(async (base64) => {
    const response = await fetch(`data:image/png;base64,${base64}`);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas decoding is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let sourceColorPixels = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] > 220 && data[index + 1] < 40 && data[index + 2] > 140 && data[index + 3] > 240) {
        sourceColorPixels += 1;
      }
    }
    return { width: bitmap.width, height: bitmap.height, sourceColorPixels };
  }, exportedPng.toString("base64"));
  expect(pixels.width).toBeGreaterThan(0);
  expect(pixels.height).toBeGreaterThan(0);
  expect(pixels.sourceColorPixels).toBeGreaterThan(0);
});
