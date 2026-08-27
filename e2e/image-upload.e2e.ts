import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { createRoomViaApi, getRoom } from "./helpers";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z7DlPwMewIRPcvgoAADJ3wLCTMjowgAAAABJRU5ErkJggg==",
  "base64",
);

test("adds a screenshot-style image through tldraw's standard media picker and local demo storage", async ({ page }) => {
  let releaseDrawFont: () => void = () => undefined;
  let reportDrawFontRequest: () => void = () => undefined;
  const drawFontGate = new Promise<void>((resolve) => {
    releaseDrawFont = resolve;
  });
  const drawFontRequested = new Promise<void>((resolve) => {
    reportDrawFontRequest = resolve;
  });
  await page.route("**/fonts/Shantell_Sans-Informal_Regular.woff2", async (route) => {
    reportDrawFontRequest();
    await drawFontGate;
    await route.continue();
  });

  const host = await createRoomViaApi(page.request, "Iris Illustrator", "Image annotation");
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  await expect(page.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });
  await drawFontRequested;

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: /Media/ }).click(),
  ]);
  const storedAsset = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/rooms/${host.room.id}/assets` &&
      response.ok(),
  );
  await chooser.setFiles({ name: "website-screenshot.png", mimeType: "image/png", buffer: TINY_PNG });
  await storedAsset;
  await expect(page.locator('.tl-shape[data-shape-type="image"]')).toBeVisible();

  // The canvas is interactive before its font-gated persistence effect is
  // ready. Releasing the font after the image is already visible proves the
  // mount-time reconciliation sweep persists edits whose store events were
  // necessarily earlier than the listener.
  releaseDrawFont();

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
      page.locator(".tl-shape:not(.tl-shape-background)").evaluateAll((elements) =>
        [...new Set(elements.map((element) => element.getAttribute("data-shape-id")))].sort(),
      ),
    )
    .toEqual(Object.keys(state.room.objects).map((id) => `shape:${id}`).sort());

  await page.getByRole("button", { name: "Canvas outline", exact: true }).click();
  const outline = page.getByRole("complementary", { name: "Canvas outline" });
  await expect(outline.getByText("1 objects")).toBeVisible();
  await expect(outline.getByText("website-screenshot.png", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Canvas outline", exact: true }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
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
