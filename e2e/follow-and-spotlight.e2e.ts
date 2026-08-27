import { expect, test } from "@playwright/test";

import { createCanvasObject, createRoomViaApi, joinRoomViaApi, jsonBody, shapeObject } from "./helpers";

test("follows a live agent viewport and enters or leaves agent Spotlight immediately", async ({ browser, page }) => {
  test.setTimeout(60_000);
  const host = await createRoomViaApi(page.request, "Maya Host", "Follow and Spotlight");
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  await expect(page.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });

  const collaboratorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const collaborator = await joinRoomViaApi(collaboratorContext.request, {
      code: host.room.code,
      displayName: "Blair Builder",
      role: "participant",
    });
    const collaboratorPage = await collaboratorContext.newPage();
    await collaboratorPage.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(collaboratorPage.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });

    await createCanvasObject(
      collaboratorContext.request,
      host.room.id,
      shapeObject("far-agent-target", "Live agent focus", 1_800, 620, "green"),
    );
    const presenceResponse = await collaboratorContext.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/presence`,
      {
        headers: { "x-jazzboard-presence-protocol": "delta-v1" },
        data: {
          cursor: { x: 1_910, y: 680 },
          viewport: { x: 1_500, y: 380, width: 820, height: 620, zoom: 1 },
          activity: null,
        },
      },
    );
    const presence = await jsonBody<{
      ok: true;
      presence: {
        roomId: string;
        roomRevision: number;
        stateRevision: number;
        participantId: string;
        actorKind: "agent";
      };
    }>(presenceResponse);
    expect(presence).toMatchObject({
      ok: true,
      presence: {
        roomId: host.room.id,
        participantId: collaborator.participantId,
        actorKind: "agent",
      },
    });
    expect(JSON.stringify(presence).length).toBeLessThan(2_048);

    await page.getByRole("button", { name: /^Follow/ }).click();
    const followAgent = page.getByRole("button", { name: "Follow Blair Builder's agent" });
    await expect(followAgent).toBeEnabled({ timeout: 10_000 });
    await followAgent.click();
    await expect(page.getByText("Following: Blair Builder’s agent")).toBeVisible();
    await expect(page.getByTestId(`agent-cursor-${collaborator.participantId}`)).toBeInViewport();

    const canvas = page.getByTestId("jazzboard-canvas");
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("Canvas did not have a browser layout box.");
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await page.mouse.wheel(0, 220);
    await expect(page.getByText("Following: Blair Builder’s agent")).toHaveCount(0);

    await collaboratorPage.getByRole("button", { name: "Spotlight", exact: true }).click();
    await collaboratorPage.getByRole("button", { name: /My agent/ }).click();
    await expect(page.getByText("Blair Builder is spotlighting their agent")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Follow now" }).click();
    await expect(page.getByText("Spotlight: Blair Builder’s agent")).toBeVisible();
    await expect(page.getByTestId(`agent-cursor-${collaborator.participantId}`)).toBeInViewport();
    await expect(collaboratorPage.getByText(/1 following/)).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Leave" }).click();
    await expect(page.getByText("Spotlight: Blair Builder’s agent")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Rejoin Blair Builder’s Spotlight/ })).toBeVisible();
  } finally {
    await collaboratorContext.close();
  }
});
