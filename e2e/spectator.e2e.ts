import { expect, test } from "@playwright/test";

import {
  createCanvasObject,
  createRoomViaApi,
  getRoom,
  joinRoomFromLanding,
  jsonBody,
  textObject,
  type ApiFailure,
} from "./helpers";

test("enforces spectator authorization until the person explicitly upgrades", async ({ browser, page }) => {
  const host = await createRoomViaApi(page.request, "Priya Host", "Spectator review");
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  await expect(page.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });

  const spectatorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const spectatorPage = await spectatorContext.newPage();
    const spectator = await joinRoomFromLanding(spectatorPage, {
      code: host.room.code,
      displayName: "Sam Spectator",
      role: "spectator",
    });

    expect(spectator.room.id).toBe(host.room.id);
    const spectatorPeople = spectatorPage.getByRole("button", { name: "Show people in this room" });
    await spectatorPeople.hover();
    await expect(spectatorPage.getByRole("tooltip")).toContainText("Your role: spectator");
    await spectatorPage.mouse.move(0, 0);
    await expect(spectatorPage.getByTestId("site-tools-status")).toHaveCount(0);
    await expect(spectatorPage.getByRole("button", { name: "Become a participant" })).toBeVisible();
    await expect(spectatorPage.getByRole("button", { name: "Spotlight", exact: true })).toHaveCount(0);

    const deniedObject = textObject("spectator-denied-note", "This must not be created", 120, 120);
    for (const endpoint of ["commands", "agent/commands"]) {
      const response = await spectatorContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/${endpoint}`,
        { data: { command: { type: "create", object: deniedObject } } },
      );
      const failure = await jsonBody<ApiFailure>(response, 403);
      expect(failure).toMatchObject({
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Spectators cannot change the canvas.",
          details: { role: "spectator" },
        },
      });
    }

    const beforeUpgrade = await getRoom(page.request, host.room.id);
    expect(beforeUpgrade.room.objects).toEqual({});
    expect(beforeUpgrade.room.participants[spectator.participantId].agentActive).toBe(false);

    await spectatorPage.getByRole("button", { name: "Become a participant" }).click();
    await expect(spectatorPage.getByRole("button", { name: "Become a participant" })).toHaveCount(0);
    await expect(spectatorPage.getByRole("button", { name: "Spotlight", exact: true })).toBeVisible();
    await spectatorPeople.hover();
    await expect(spectatorPage.getByRole("tooltip")).toContainText("Your role: participant");
    await spectatorPage.mouse.move(0, 0);

    const accepted = await createCanvasObject(
      spectatorContext.request,
      host.room.id,
      textObject("upgraded-note", "Upgrade unlocks semantic editing", 160, 180),
    );
    expect(accepted.changedObjectIds).toEqual(["upgraded-note"]);
    expect(accepted.room.participants[spectator.participantId]).toMatchObject({
      role: "participant",
      agentActive: true,
    });

    await spectatorPage.getByRole("button", { name: "Canvas outline" }).click();
    const outline = spectatorPage.getByRole("complementary", { name: "Canvas outline" });
    await expect(outline.getByText("1 objects")).toBeVisible();
    await expect(outline.getByText("Upgrade unlocks semantic editing", { exact: true })).toBeVisible();
  } finally {
    await spectatorContext.close();
  }
});
