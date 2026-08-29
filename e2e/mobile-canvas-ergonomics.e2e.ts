import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

import {
  createCanvasObject,
  createRoomViaApi,
  joinRoomViaApi,
  shapeObject,
} from "./helpers";

type MobileViewport = Readonly<{ width: number; height: number; name: string }>;
type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

const MOBILE_VIEWPORTS: readonly MobileViewport[] = [
  { width: 320, height: 568, name: "small portrait" },
  { width: 390, height: 844, name: "modern portrait" },
  { width: 844, height: 390, name: "short landscape" },
];

function configuredBaseUrl(): string {
  const baseURL = test.info().project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Mobile regressions require Playwright use.baseURL.");
  return baseURL;
}

async function mobileContext(browser: Browser, viewport: MobileViewport): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: configuredBaseUrl(),
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    viewport: { width: viewport.width, height: viewport.height },
  });
}

async function rect(locator: Locator): Promise<Rect> {
  const bounds = await locator.boundingBox();
  expect(bounds, `${await locator.getAttribute("aria-label") ?? "control"} should have bounds`).not.toBeNull();
  if (!bounds) throw new Error("Expected visible control bounds.");
  return bounds;
}

function expectInsideViewport(bounds: Rect, viewport: MobileViewport, label: string): void {
  expect(bounds.x, `${label} starts outside the left edge at ${viewport.name}`).toBeGreaterThanOrEqual(-1);
  expect(bounds.y, `${label} starts outside the top edge at ${viewport.name}`).toBeGreaterThanOrEqual(-1);
  expect(bounds.x + bounds.width, `${label} overflows right at ${viewport.name}`).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height, `${label} overflows bottom at ${viewport.name}`).toBeLessThanOrEqual(viewport.height + 1);
}

async function expectLocatorInsideViewport(
  locator: Locator,
  viewport: MobileViewport,
  label: string,
): Promise<void> {
  await expect.poll(async () => {
    const bounds = await rect(locator);
    return bounds.x >= -1
      && bounds.y >= -1
      && bounds.x + bounds.width <= viewport.width + 1
      && bounds.y + bounds.height <= viewport.height + 1;
  }, { message: `${label} should settle fully inside the ${viewport.name} viewport` }).toBe(true);
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

async function expectMinimumTargets(surface: Locator, minimum = 44): Promise<void> {
  const undersized = await surface.locator("button:not([disabled])").evaluateAll((buttons, target) => buttons
    .map((button) => {
      const bounds = button.getBoundingClientRect();
      return {
        label: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "button",
        width: bounds.width,
        height: bounds.height,
      };
    })
    .filter(({ width, height }) => width > 0 && height > 0 && (width < target || height < target)), minimum);
  expect(undersized, `interactive targets smaller than ${minimum}px: ${JSON.stringify(undersized)}`).toEqual([]);
}

async function openParticipantRoom(page: Page, title: string) {
  const room = await createRoomViaApi(page.request, "Mobile QA", title);
  await page.goto(`/room/${encodeURIComponent(room.room.id)}`);
  await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
  return room;
}

test("keeps compact mobile chrome reachable and non-overlapping in portrait and landscape", async ({ browser }) => {
  test.setTimeout(90_000);

  for (const viewport of MOBILE_VIEWPORTS) {
    const context = await mobileContext(browser, viewport);
    try {
      const page = await context.newPage();
      await openParticipantRoom(page, `Mobile chrome ${viewport.name}`);

      await expect(page.getByTestId("room-controls")).toBeHidden();
      const back = page.getByRole("link", { name: "Back to Jazzboard home" });
      const identity = page.getByTestId("combined-left-panel");
      const collaboration = page.getByTestId("mobile-collaboration-launcher");
      const dock = page.getByRole("toolbar", { name: "Mobile canvas controls" });

      for (const [label, locator] of [
        ["back", back],
        ["room identity", identity],
        ["collaboration launcher", collaboration],
        ["canvas dock", dock],
      ] as const) {
        await expect(locator, `${label} visible at ${viewport.name}`).toBeVisible();
        expectInsideViewport(await rect(locator), viewport, label);
      }

      const identityBounds = await rect(identity);
      const collaborationBounds = await rect(collaboration);
      const dockBounds = await rect(dock);
      expect(overlapArea(identityBounds, collaborationBounds), `top controls overlap at ${viewport.name}`).toBe(0);
      expect(overlapArea(identityBounds, dockBounds), `room identity overlaps canvas dock at ${viewport.name}`).toBe(0);
      expect(overlapArea(collaborationBounds, dockBounds), `collaboration overlaps canvas dock at ${viewport.name}`).toBe(0);
      await expectMinimumTargets(dock);

      if (viewport.width === 390) {
        await page.getByRole("button", { name: /Edit room title, currently/ }).tap();
        const titleInput = page.getByRole("textbox", { name: "Room name" });
        await expect(titleInput).toBeVisible();
        const editingIdentityBounds = await rect(identity);
        const editingCollaborationBounds = await rect(collaboration);
        expect(
          overlapArea(editingIdentityBounds, editingCollaborationBounds),
          "editing the room title must not cover collaboration controls",
        ).toBe(0);
        expectInsideViewport(await rect(titleInput), viewport, "room title editor");
        await titleInput.press("Escape");
      }
    } finally {
      await context.close();
    }
  }
});

test("collaboration and tool sheets expose the complete mobile workflow and dismiss outside", async ({ browser }) => {
  const viewport = MOBILE_VIEWPORTS[1];
  const context = await mobileContext(browser, viewport);
  try {
    const page = await context.newPage();
    await openParticipantRoom(page, "Mobile surface lifecycle");

    const collaborationLauncher = page.getByTestId("mobile-collaboration-launcher");
    await collaborationLauncher.tap();
    const collaborationSheet = page.getByRole("dialog", { name: "Collaborate" });
    await expect(collaborationSheet).toBeVisible();
    await expect(collaborationSheet.getByRole("status", { name: /Connection:/ })).toBeVisible();
    for (const capability of ["People", "Follow", "Spotlight", "Share"]) {
      await expect(collaborationSheet.getByRole("button", { name: new RegExp(capability) })).toBeVisible();
    }
    await expectLocatorInsideViewport(collaborationSheet, viewport, "collaboration sheet");
    await expectMinimumTargets(collaborationSheet);
    await page.getByTestId("mobile-collaboration-backdrop").tap({ position: { x: 4, y: 4 } });
    await expect(collaborationSheet).toBeHidden();

    const toolsLauncher = page.getByRole("button", { name: /active\. Choose a canvas tool/ });
    await toolsLauncher.tap();
    const toolsSheet = page.getByRole("dialog", { name: "Canvas tools" });
    await expect(toolsSheet).toBeVisible();
    for (const tool of [
      "Select and move",
      "Pan canvas",
      "Draw freehand",
      "Add text",
      "Add rectangle",
      "Add ellipse",
      "Add diamond",
      "Connect objects",
      "Add image",
    ]) {
      await expect(toolsSheet.getByRole("button", { name: tool })).toBeVisible();
    }
    await expectLocatorInsideViewport(toolsSheet, viewport, "canvas tools sheet");
    await expectMinimumTargets(toolsSheet);
    await page.getByTestId("mobile-tools-backdrop").tap({ position: { x: 4, y: 4 } });
    await expect(toolsSheet).toBeHidden();

    const boardMenuButton = page.getByTestId("main-menu.button");
    await boardMenuButton.tap();
    await expect(page.getByRole("menu", { name: "Board actions" })).toBeVisible();
    const canvas = page.getByTestId("semantic-canvas");
    const canvasBounds = await rect(canvas);
    // The mobile board menu is a bottom sheet, so tap the exposed canvas band
    // above it rather than the geometric center that the sheet may cover.
    await page.touchscreen.tap(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + 160);
    await expect(page.getByRole("menu", { name: "Board actions" })).toBeHidden();
  } finally {
    await context.close();
  }
});

test("mobile spectator keeps camera and collaboration access without mutation tools", async ({ browser }) => {
  const hostContext = await mobileContext(browser, MOBILE_VIEWPORTS[1]);
  const spectatorContext = await mobileContext(browser, MOBILE_VIEWPORTS[0]);
  try {
    const hostPage = await hostContext.newPage();
    const host = await openParticipantRoom(hostPage, "Mobile spectator permissions");
    await joinRoomViaApi(spectatorContext.request, {
      code: host.room.code,
      displayName: "Mobile spectator",
      role: "spectator",
    });
    const spectator = await spectatorContext.newPage();
    await spectator.goto(`/room/${encodeURIComponent(host.room.id)}`);
    const canvas = spectator.getByTestId("semantic-canvas");
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    await expect(canvas).toHaveAttribute("data-canvas-editing", "disabled");

    const dock = spectator.getByRole("toolbar", { name: "Mobile canvas controls" });
    await expect(dock.getByRole("button", { name: "Fit board" })).toBeVisible();
    await expect(dock.getByRole("button", { name: /canvas tool/i })).toHaveCount(0);
    await expect(dock.getByRole("button", { name: "Undo" })).toHaveCount(0);
    await expect(dock.getByRole("button", { name: "Redo" })).toHaveCount(0);

    await spectator.getByTestId("mobile-collaboration-launcher").tap();
    const collaborationSheet = spectator.getByRole("dialog", { name: "Collaborate" });
    await expect(collaborationSheet.getByRole("button", { name: /People/ })).toBeVisible();
    await expect(collaborationSheet.getByRole("button", { name: /Follow/ })).toBeVisible();
    await expect(collaborationSheet.getByRole("button", { name: /Share/ })).toBeVisible();
    await expect(collaborationSheet.getByRole("button", { name: /Spotlight/ })).toHaveCount(0);
  } finally {
    await hostContext.close();
    await spectatorContext.close();
  }
});

test("mobile selection inspector stays above the dock and exposes style and arrange actions", async ({ browser }) => {
  const viewport = MOBILE_VIEWPORTS[1];
  const context = await mobileContext(browser, viewport);
  try {
    const page = await context.newPage();
    const host = await createRoomViaApi(page.request, "Selection QA", "Mobile selection inspector");
    await createCanvasObject(page.request, host.room.id, {
      ...shapeObject("mobile-inspector-shape", "Inspectable component", 120, 190, "blue"),
      nodeType: "component",
    });
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    const shape = page.locator('[data-object-id="mobile-inspector-shape"][data-object-kind="shape"]');
    await expect(shape).toBeVisible({ timeout: 20_000 });
    await shape.tap();

    const quickActions = page.getByRole("toolbar", { name: "Selection quick actions" });
    const canvasDock = page.getByRole("toolbar", { name: "Mobile canvas controls" });
    await expect(quickActions.getByRole("button", { name: "Style & actions" })).toBeVisible();
    const quickBounds = await rect(quickActions);
    const dockBounds = await rect(canvasDock);
    expectInsideViewport(quickBounds, viewport, "selection quick actions");
    expect(overlapArea(quickBounds, dockBounds), "selection controls must not cover the canvas dock").toBe(0);
    expect(quickBounds.y + quickBounds.height, "selection controls should sit above the dock").toBeLessThanOrEqual(dockBounds.y);

    await quickActions.getByRole("button", { name: "Style & actions" }).tap();
    const sheet = page.getByRole("dialog", { name: "Selection style and actions" });
    await expect(sheet).toBeVisible();
    await expectLocatorInsideViewport(sheet, viewport, "selection inspector sheet");
    await expect(sheet.getByRole("region", { name: "Selection style" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Fill: blue" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Stroke: blue" })).toBeVisible();
    await expect(sheet.getByRole("region", { name: "Selection actions" })).toBeVisible();
    for (const action of ["Bring forward", "Send backward", "Delete"]) {
      await expect(sheet.getByRole("button", { name: action, exact: true })).toBeVisible();
    }
    await expectMinimumTargets(sheet);
    await page.getByTestId("mobile-selection-actions-backdrop").tap({ position: { x: 4, y: 4 } });
    await expect(sheet).toBeHidden();
  } finally {
    await context.close();
  }
});

test("trusted touch input taps and drags objects, pans blank canvas, and pinches the camera", async ({ browser }) => {
  test.setTimeout(60_000);
  const viewport = MOBILE_VIEWPORTS[1];
  const context = await mobileContext(browser, viewport);
  try {
    const page = await context.newPage();
    const host = await createRoomViaApi(page.request, "Touch QA", "Touch gesture acceptance");
    await createCanvasObject(page.request, host.room.id, {
      ...shapeObject("mobile-touch-shape", "Touch target", 120, 190, "blue"),
      nodeType: "component",
    });
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });

    const shape = page.locator('[data-object-id="mobile-touch-shape"][data-object-kind="shape"]');
    await expect(shape).toBeVisible();
    await shape.tap();
    await expect(page.getByTestId("canvas-selection-count")).toHaveText("1 selected");

    const cdp = await context.newCDPSession(page);
    const transformHandle = page.locator('[data-transform-handle="resize-east"]');
    await expect(transformHandle).toBeVisible();
    const transformBounds = await rect(transformHandle);
    const transformPoint = {
      x: transformBounds.x + transformBounds.width / 2,
      y: transformBounds.y + transformBounds.height / 2,
    };
    const cameraZoom = page.getByLabel(/Canvas zoom \d+%/);
    const beforeTransformPinchZoom = Number.parseInt(
      (await cameraZoom.getAttribute("aria-label"))?.match(/\d+/)?.[0] ?? "0",
      10,
    );
    const secondTransformPoint = { x: 24, y: Math.min(viewport.height - 150, transformPoint.y + 130) };
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...transformPoint, id: 20 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...transformPoint, id: 20 }, { ...secondTransformPoint, id: 21 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { ...transformPoint, id: 20 },
        { x: 2, y: Math.min(viewport.height - 150, secondTransformPoint.y + 54), id: 21 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => Number.parseInt(
      (await cameraZoom.getAttribute("aria-label"))?.match(/\d+/)?.[0] ?? "0",
      10,
    )).toBeGreaterThan(beforeTransformPinchZoom);
    await page.getByRole("button", { name: "Fit board" }).tap();

    const beforeDrag = await rect(shape);
    const start = { x: beforeDrag.x + beforeDrag.width / 2, y: beforeDrag.y + beforeDrag.height / 2 };
    const moved = { x: start.x + 54, y: start.y + 38 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...moved, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await rect(shape)).x).toBeGreaterThan(beforeDrag.x + 30);

    const afterObjectDrag = await rect(shape);
    const blank = { x: viewport.width - 28, y: viewport.height - 150 };
    const blankTarget = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-object-id]") === null, blank);
    expect(blankTarget, "chosen touch-pan point must be blank canvas").toBe(true);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...blank, id: 2 }] });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: blank.x - 45, y: blank.y - 32, id: 2 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await rect(shape)).x).toBeLessThan(afterObjectDrag.x - 20);

    await page.touchscreen.tap(blank.x - 45, blank.y - 32);
    await expect(page.getByTestId("canvas-selection-count")).toHaveText("0 selected");

    const zoom = page.getByLabel(/Canvas zoom \d+%/);
    const beforeZoom = Number.parseInt((await zoom.getAttribute("aria-label"))?.match(/\d+/)?.[0] ?? "0", 10);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 100, y: 500, id: 3 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 100, y: 500, id: 3 }, { x: 290, y: 500, id: 4 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 70, y: 500, id: 3 }, { x: 320, y: 500, id: 4 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => Number.parseInt(
      (await zoom.getAttribute("aria-label"))?.match(/\d+/)?.[0] ?? "0",
      10,
    )).toBeGreaterThan(beforeZoom);

    await page.getByRole("button", { name: "Fit board" }).tap();
    await expect(shape).toBeVisible();
    const longPressBounds = await rect(shape);
    const longPressPoint = {
      x: longPressBounds.x + longPressBounds.width / 2,
      y: longPressBounds.y + longPressBounds.height / 2,
    };
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...longPressPoint, id: 10 }],
    });
    await page.waitForTimeout(550);
    const longPressMenu = page.getByRole("menu", { name: "Object actions" });
    await expect(longPressMenu).toBeVisible();
    await expect(longPressMenu.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  } finally {
    await context.close();
  }
});
