import { expect, test, type Page } from "@playwright/test";

import {
  createRoomFromLanding,
  expectBuiltInTldrawWatermark,
  joinRoomFromLanding,
  jsonBody,
  openBoardMenu,
  selectBoardMenuItem,
  type ApiFailure,
} from "./helpers";

async function expectTopNavigationToClearCanvasChrome(page: Page) {
  const layout = await page.evaluate(() => {
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
      };
    };
    const panel = document.querySelector('[data-testid="combined-left-panel"]');
    const identity = panel?.firstElementChild ?? null;
    const menu = panel?.querySelector(".tlui-menu-zone") ?? null;
    const controls = document.querySelector('[data-testid="room-controls"]');
    const stylePanel = document.querySelector(".tlui-style-panel__wrapper");
    const overlaps = (first: Element, second: Element) => {
      const a = rect(first);
      const b = rect(second);
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    };

    return {
      controls: controls ? rect(controls) : null,
      identity: identity ? rect(identity) : null,
      menu: menu ? rect(menu) : null,
      panel: panel ? rect(panel) : null,
      panelControlsOverlap: panel && controls ? overlaps(panel, controls) : null,
      stylePanel: stylePanel ? rect(stylePanel) : null,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });

  expect(layout.panel).not.toBeNull();
  expect(layout.identity).not.toBeNull();
  expect(layout.menu).not.toBeNull();
  expect(layout.controls).not.toBeNull();
  expect(layout.panelControlsOverlap).toBe(false);

  for (const box of [layout.panel!, layout.controls!]) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(layout.viewportWidth);
  }

  expect(layout.identity!.left).toBeGreaterThanOrEqual(layout.panel!.left);
  expect(layout.identity!.right).toBeLessThanOrEqual(layout.panel!.right);
  expect(layout.menu!.left).toBeGreaterThanOrEqual(layout.panel!.left);
  expect(layout.menu!.right).toBeLessThanOrEqual(layout.panel!.right);
  expect(layout.menu!.top).toBeGreaterThanOrEqual(layout.identity!.bottom - 1);
  expect(layout.menu!.bottom).toBeLessThanOrEqual(layout.panel!.bottom);
  if (layout.stylePanel) {
    expect(layout.stylePanel.top).toBeGreaterThanOrEqual(layout.controls!.bottom + 8);
    expect(layout.stylePanel.bottom).toBeLessThanOrEqual(layout.viewportHeight);
  } else {
    expect(layout.viewportWidth).toBeLessThanOrEqual(480);
  }
}

test.describe("landing and room entry", () => {
  test("keeps the top navigation clear of the canvas controls", async ({ page }) => {
    await createRoomFromLanding(page, "Layout Tester");

    for (const viewport of [
      { width: 1_659, height: 303 },
      { width: 1_024, height: 768 },
      { width: 800, height: 740 },
      { width: 721, height: 740 },
      { width: 720, height: 800 },
      { width: 480, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await expectTopNavigationToClearCanvasChrome(page);
    }

    await page.setViewportSize({ width: 1_659, height: 303 });
    const controls = page.getByTestId("room-controls");
    for (const indicator of [
      controls.getByTestId("connection-status"),
      controls.getByRole("button", { name: "Show people in this room" }),
    ]) {
      const box = await indicator.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeLessThanOrEqual(34);
      expect(box!.width).toBeLessThanOrEqual(48);
    }
    await expect(controls.getByRole("button", { name: "Follow", exact: true })).toBeVisible();
    const spotlightButton = controls.getByRole("button", { name: "Spotlight", exact: true });
    const shareButton = controls.getByRole("button", { name: "Share board", exact: true });
    for (const button of [spotlightButton, shareButton]) {
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBe(37);
      expect(box!.width).toBe(37);
    }

    await controls.getByTestId("connection-status").hover();
    await expect(page.getByRole("tooltip")).toHaveText(/^(Connecting|Live|Synced)$/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(controls.getByTestId("site-tools-status")).toHaveCount(0);
    await expect(controls.getByText("44", { exact: true })).toHaveCount(0);

    await spotlightButton.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Spotlight");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    await shareButton.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Share board");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    const peopleButton = controls.getByRole("button", { name: "Show people in this room" });
    await peopleButton.hover();
    await expect(page.getByRole("tooltip")).toContainText("Your role: participant");
    await peopleButton.click();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(controls.getByText("In this room", { exact: true })).toBeVisible();
    await peopleButton.click();

    await expect(page.getByRole("button", { name: "Page 1", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Export", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Zoom/ })).toBeVisible();

    await openBoardMenu(page);
    await expect(page.getByRole("menuitem", { name: "Canvas outline", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Export", exact: true })).toHaveCount(1);
    await expect(page.getByRole("menuitem", { name: /Export all as/i })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Ask agent", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("main-menu.button")).toBeFocused();
    await page.getByRole("button", { name: "Share board", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Share board" })).toBeVisible();
    await page.getByRole("button", { name: "Close share board" }).click();
  });

  test("renders the product entry points and protects room URLs without a guest session", async ({ browser, page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle(/Jazzboard/i);
    await expect(page.getByRole("heading", { level: 1, name: /Make room for every idea/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Create a room", selected: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Join by code", selected: false })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Recent Jazzboards" })).toBeVisible();
    await expect(page.getByText("Your boards will wait here.")).toBeVisible();

    await page.getByRole("tab", { name: "Join by code" }).click();
    await page.getByLabel("Room code").fill("1a2b");
    await expect(page.getByLabel("Room code")).toHaveValue("12");
    await page.getByLabel("Room code").fill("12345");
    await expect(page.getByLabel("Room code")).toHaveValue("1234");
    await expect(page.getByRole("radio", { name: /^Participant/i })).toBeChecked();
    await expect(page.getByRole("radio", { name: /^Spectator/i })).not.toBeChecked();

    const outsider = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const response = await outsider.request.get("/api/rooms/room_not-a-member");
      const failure = await jsonBody<ApiFailure>(response, 401);
      expect(failure).toMatchObject({
        ok: false,
        error: { code: "AUTH_REQUIRED", message: "A guest session is required." },
      });

      const outsiderPage = await outsider.newPage();
      await outsiderPage.goto("/room/room_not-a-member");
      await expect(outsiderPage.getByRole("heading", { name: "Room access needed" })).toBeVisible();
      await expect(outsiderPage.getByText("A guest session is required.")).toBeVisible();
      await expect(outsiderPage.getByRole("link", { name: "Return to Jazzboard" })).toHaveAttribute("href", "/");
    } finally {
      await outsider.close();
    }
  });

  test("creates a room, remembers it locally, and joins it as a second participant", async ({ browser, page }) => {
    const host = await createRoomFromLanding(page, "Maya Host");

    await expectBuiltInTldrawWatermark(page);

    expect(host.room.code).toMatch(/^\d{4}$/);
    expect(host.room.participants[host.participantId]).toMatchObject({
      displayName: "Maya Host",
      role: "participant",
    });
    await expect(page.getByTestId("combined-left-panel").getByText("Untitled Jazzboard", { exact: true })).toBeVisible();
    await expect(page.getByTestId("combined-left-panel").getByText(`Room ${host.room.code}`, { exact: true })).toBeVisible();
    const hostPeopleButton = page.getByRole("button", { name: "Show people in this room" });
    await hostPeopleButton.hover();
    await expect(page.getByRole("tooltip")).toContainText("Your role: participant");
    await page.mouse.move(0, 0);

    await selectBoardMenuItem(page, "Canvas outline");
    await expect(page.getByRole("complementary", { name: "Canvas outline" }).getByText("0 objects")).toBeVisible();
    await expect(page.getByText("Objects will appear here as people and agents add them.")).toBeVisible();
    await page.getByRole("button", { name: "Close canvas outline" }).click();

    await page.getByRole("link", { name: "Back to Jazzboard home" }).click();
    const recentLink = page.getByRole("link", {
      name: `Open Untitled Jazzboard, room ${host.room.code}`,
    });
    await expect(recentLink).toBeVisible();
    await expect(recentLink.getByText("Participant", { exact: true })).toBeVisible();
    await recentLink.click();
    await expect(page.getByTestId("jazzboard-canvas")).toBeVisible();

    const collaboratorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const collaboratorPage = await collaboratorContext.newPage();
      const joined = await joinRoomFromLanding(collaboratorPage, {
        code: host.room.code,
        displayName: "Devon Collaborator",
        role: "participant",
      });

      expect(joined.room.id).toBe(host.room.id);
      expect(joined.participantId).not.toBe(host.participantId);
      expect(joined.room.participants[joined.participantId]).toMatchObject({
        displayName: "Devon Collaborator",
        role: "participant",
      });
      await expect(collaboratorPage.getByTestId("combined-left-panel").getByText(`Room ${host.room.code}`, { exact: true })).toBeVisible();
      await expect(collaboratorPage.getByRole("button", { name: "Show people in this room" })).toContainText("2");

      const peopleButton = collaboratorPage.getByRole("button", { name: "Show people in this room" });
      await peopleButton.click();
      const peoplePopover = peopleButton.locator("..");
      await expect(peoplePopover.getByText("Maya Host", { exact: true })).toBeVisible();
      await expect(peoplePopover.getByText("Devon Collaborator (you)", { exact: true })).toBeVisible();
    } finally {
      await collaboratorContext.close();
    }
  });
});
