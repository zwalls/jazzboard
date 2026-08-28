import { expect, test, type Locator } from "@playwright/test";

import {
  createCanvasObject,
  createRoomViaApi,
  shapeObject,
} from "./helpers";

const SHAPE_ID = "responsive-selection-toolbar-shape";

type ToolbarLayout = {
  bounds: { left: number; right: number; top: number; bottom: number };
  clientWidth: number;
  flexWrap: string;
  scrollWidth: number;
  controls: Array<{
    label: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>;
};

async function expectControlsInsideToolbar(toolbar: Locator): Promise<void> {
  await expect(toolbar).toBeVisible();
  const layout = await toolbar.evaluate((element): ToolbarLayout => {
    const bounds = element.getBoundingClientRect();
    const controls = Array.from(element.querySelectorAll<HTMLElement>("button, select"))
      .map((control) => {
        const rect = control.getBoundingClientRect();
        return {
          label: control.getAttribute("aria-label") ?? control.textContent?.trim() ?? control.tagName,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        };
      })
      .filter((control) => control.right > control.left && control.bottom > control.top);

    return {
      bounds: {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
      },
      clientWidth: element.clientWidth,
      flexWrap: getComputedStyle(element).flexWrap,
      scrollWidth: element.scrollWidth,
      controls,
    };
  });

  expect(layout.flexWrap).toBe("wrap");
  expect(layout.scrollWidth, "toolbar content should not overflow horizontally").toBeLessThanOrEqual(
    layout.clientWidth + 1,
  );
  expect(layout.controls.length).toBeGreaterThan(0);
  for (const control of layout.controls) {
    expect(control.left, `${control.label} starts before the toolbar`).toBeGreaterThanOrEqual(
      layout.bounds.left - 1,
    );
    expect(control.right, `${control.label} ends after the toolbar`).toBeLessThanOrEqual(
      layout.bounds.right + 1,
    );
    expect(control.top, `${control.label} starts above the toolbar`).toBeGreaterThanOrEqual(
      layout.bounds.top - 1,
    );
    expect(control.bottom, `${control.label} ends below the toolbar`).toBeLessThanOrEqual(
      layout.bounds.bottom + 1,
    );
  }
}

test("keeps the full shape selection toolbar inside its container at responsive widths", async ({ page }) => {
  const host = await createRoomViaApi(page.request, "Riley Responsive", "Responsive selection toolbar");
  await createCanvasObject(
    page.request,
    host.room.id,
    {
      ...shapeObject(SHAPE_ID, "Responsive service", 220, 240, "blue"),
      nodeType: null,
    },
  );

  for (const viewport of [
    { width: 900, height: 700 },
    { width: 360, height: 740 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });

    const shape = page
      .getByTestId("semantic-canvas")
      .locator(`[data-object-id="${SHAPE_ID}"][data-object-kind="shape"]`);
    await expect(shape).toBeVisible();
    await shape.click();

    const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
    await expect(toolbar.getByRole("button", { name: "Fill: blue" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Stroke: blue" })).toBeVisible();
    await expect(toolbar.getByRole("combobox", { name: "Node type" })).toHaveValue("__generic__");
    await expect(toolbar.getByRole("button", { name: "Edit label" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Bring forward" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Send backward" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Delete" })).toBeVisible();
    await expectControlsInsideToolbar(toolbar);
  }
});
