import { expect, test } from "@playwright/test";

import { createCanvasObject, createRoomViaApi, getRoom, joinRoomViaApi, jsonBody, textObject, type ApiFailure } from "./helpers";

test("holds an edit lease for a live human text gesture and gives an agent structured busy context", async ({ browser, page }) => {
  const host = await createRoomViaApi(page.request, "Hana Human", "Human lease conflict");
  await createCanvasObject(page.request, host.room.id, textObject("leased-copy", "Edit me live", 360, 250), "human");
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });

  const collaboratorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const collaborator = await joinRoomViaApi(collaboratorContext.request, {
      code: host.room.code,
      displayName: "Arlo Agent",
      role: "participant",
    });

    await page
      .getByTestId("semantic-canvas")
      .locator('[data-object-id="leased-copy"][data-object-kind]')
      .dblclick();
    await expect
      .poll(async () => (await getRoom(page.request, host.room.id)).room.leases["leased-copy"]?.operation ?? null)
      .toBe("edit");

    const blockedResponse = await collaboratorContext.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/commands`,
      {
        data: {
          command: {
            type: "update",
            objectId: "leased-copy",
            expectedRevision: 1,
            operation: "edit",
            patch: { content: "Agent should adapt" },
          },
        },
      },
    );
    const blocked = await jsonBody<ApiFailure>(blockedResponse, 409);
    expect(blocked).toMatchObject({
      ok: false,
      error: {
        code: "OBJECT_BUSY",
        details: {
          objectId: "leased-copy",
          operation: "edit",
          currentRevision: 1,
          actor: { participantId: host.participantId, displayName: "Hana Human", kind: "human" },
        },
      },
    });
    expect(collaborator.participantId).not.toBe(host.participantId);

    await page.keyboard.press("Escape");
    await expect
      .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
      .toEqual([]);
  } finally {
    await collaboratorContext.close();
  }
});
