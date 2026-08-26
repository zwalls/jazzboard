import { expect, test } from "@playwright/test";

import {
  createRoomFromLanding,
  expectBuiltInTldrawWatermark,
  joinRoomFromLanding,
  jsonBody,
  type ApiFailure,
} from "./helpers";

test.describe("landing and room entry", () => {
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
    await expect(page.locator("header").getByText("Untitled Jazzboard", { exact: true })).toBeVisible();
    await expect(page.locator("header").getByText(`Room ${host.room.code}`, { exact: true })).toBeVisible();
    await expect(page.locator("header").getByText("participant", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Canvas outline" }).click();
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
      await expect(collaboratorPage.locator("header").getByText(`Room ${host.room.code}`, { exact: true })).toBeVisible();
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
