import { expect, test, type Locator, type Page } from "@playwright/test";

import { createRoomViaApi } from "./helpers";

type Bounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

type ChromeBounds = Readonly<{
  topLeft: Bounds;
  topRight: Bounds;
  bottomCenter: Bounds;
  bottomRight: Bounds;
}>;

const POSITION_TOLERANCE_PX = 1.5;

function persistentChrome(page: Page) {
  return {
    topLeft: page.getByTestId("combined-left-panel"),
    topRight: page.getByTestId("room-controls"),
    bottomCenter: page.getByRole("toolbar", { name: "Canvas tools" }),
    bottomRight: page.getByLabel("Canvas zoom controls"),
  } as const;
}

async function visibleBounds(locator: Locator, label: string): Promise<Bounds> {
  await expect(locator, `${label} should remain visible`).toBeVisible();
  const bounds = await locator.boundingBox();
  expect(bounds, `${label} should remain measurable`).not.toBeNull();
  return bounds!;
}

async function readChromeBounds(page: Page): Promise<ChromeBounds> {
  const chrome = persistentChrome(page);
  return {
    topLeft: await visibleBounds(chrome.topLeft, "top-left room card"),
    topRight: await visibleBounds(chrome.topRight, "top-right collaboration controls"),
    bottomCenter: await visibleBounds(chrome.bottomCenter, "bottom-center canvas tools"),
    bottomRight: await visibleBounds(chrome.bottomRight, "bottom-right zoom controls"),
  };
}

async function expectPersistentChromeUsesStablePaint(page: Page): Promise<void> {
  for (const [label, locator] of Object.entries(persistentChrome(page))) {
    const filters = await locator.evaluate((element) => {
      const style = getComputedStyle(element);
      let current: Element | null = element;
      let hasFixedContainingLayer = false;
      while (current) {
        if (getComputedStyle(current).position === "fixed") {
          hasFixedContainingLayer = true;
          break;
        }
        current = current.parentElement;
      }
      return {
        backdropFilter: style.backdropFilter,
        hasFixedContainingLayer,
        webkitBackdropFilter: style.getPropertyValue("-webkit-backdrop-filter"),
      };
    });
    expect(filters.backdropFilter, `${label} should not depend on a backdrop compositor layer`).toBe("none");
    expect(
      filters.webkitBackdropFilter || "none",
      `${label} should not depend on a prefixed backdrop compositor layer`,
    ).toBe("none");
    expect(filters.hasFixedContainingLayer, `${label} should live in viewport-fixed chrome`).toBe(true);
  }
}

function expectBoundsToStayFixed(actual: ChromeBounds, baseline: ChromeBounds): void {
  for (const position of Object.keys(baseline) as Array<keyof ChromeBounds>) {
    for (const dimension of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(actual[position][dimension] - baseline[position][dimension]),
        `${position} ${dimension} should stay fixed while the canvas camera zooms`,
      ).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
    }
  }
}

async function expectChromeToBeClickable(page: Page): Promise<void> {
  const boardMenuButton = page.getByTestId("main-menu.button");
  await boardMenuButton.click();
  await expect(page.getByRole("menu", { name: "Board actions" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(boardMenuButton).toHaveAttribute("aria-expanded", "false");

  const peopleButton = page.getByRole("button", { name: "Show people in this room" });
  await peopleButton.click();
  await expect(peopleButton).toHaveAttribute("aria-expanded", "true");
  await peopleButton.click();
  await expect(peopleButton).toHaveAttribute("aria-expanded", "false");

  const handTool = page.getByRole("button", { name: "Hand tool" });
  await handTool.click();
  await expect(handTool).toHaveAttribute("aria-pressed", "true");
  const selectTool = page.getByRole("button", { name: "Select tool" });
  await selectTool.click();
  await expect(selectTool).toHaveAttribute("aria-pressed", "true");
}

test("keeps floating canvas controls visible, clickable, and screen-fixed through repeated zoom cycles", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  const host = await createRoomViaApi(page.request, "Zoey Zoom", "Persistent canvas chrome");
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });

  const zoomControls = page.getByLabel("Canvas zoom controls");
  const zoomOut = zoomControls.getByRole("button", { name: "Zoom out" });
  const zoomIn = zoomControls.getByRole("button", { name: "Zoom in" });
  await expect(zoomControls).toContainText("100%");

  const baseline = await readChromeBounds(page);
  await expectPersistentChromeUsesStablePaint(page);
  await expectChromeToBeClickable(page);

  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (const expectedZoom of [83, 69, 58, 48, 40]) {
      await zoomOut.click();
      await expect(zoomControls).toContainText(`${expectedZoom}%`);
      expectBoundsToStayFixed(await readChromeBounds(page), baseline);
    }

    await expectChromeToBeClickable(page);

    for (const expectedZoom of [48, 58, 69, 83, 100]) {
      await zoomIn.click();
      await expect(zoomControls).toContainText(`${expectedZoom}%`);
      expectBoundsToStayFixed(await readChromeBounds(page), baseline);
    }

    await expectChromeToBeClickable(page);
    await expectPersistentChromeUsesStablePaint(page);
  }

  const canvasBounds = await page.getByTestId("semantic-canvas").boundingBox();
  expect(canvasBounds).not.toBeNull();
  if (!canvasBounds) throw new Error("The semantic canvas must have measurable bounds.");
  await page.mouse.move(
    canvasBounds.x + canvasBounds.width / 2,
    canvasBounds.y + canvasBounds.height / 2,
  );
  await page.keyboard.down("Control");
  try {
    await page.mouse.wheel(0, 240);
    await expect(zoomControls).not.toContainText("100%");
    expectBoundsToStayFixed(await readChromeBounds(page), baseline);

    await page.mouse.wheel(0, -240);
    await expect(zoomControls).toContainText("100%");
    expectBoundsToStayFixed(await readChromeBounds(page), baseline);
  } finally {
    await page.keyboard.up("Control");
  }
});
