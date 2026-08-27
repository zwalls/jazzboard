import { expect, test } from "@playwright/test";

import { createRoomViaApi, getRoom } from "./helpers";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAQKc7S8AAAAASUVORK5CYII=",
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

  await page.getByRole("button", { name: "Canvas outline" }).click();
  const outline = page.getByRole("complementary", { name: "Canvas outline" });
  await expect(outline.getByText("1 objects")).toBeVisible();
  await expect(outline.getByText("website-screenshot.png", { exact: true })).toBeVisible();
});
