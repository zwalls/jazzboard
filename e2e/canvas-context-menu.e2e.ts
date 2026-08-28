import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  createRoomViaApi,
  joinRoomViaApi,
  jsonBody,
  shapeObject,
  textObject,
  type RoomState,
} from "./helpers";

const LEFT_ID = "context-left-service";
const RIGHT_ID = "context-right-service";
const NOTE_ID = "context-independent-note";
const GROUP_ID = "context-service-group";

type SemanticTransactionResponse = {
  ok: true;
  room: RoomState;
  changedObjectIds: string[];
};

async function seedContextMenuScene(request: APIRequestContext, roomId: string): Promise<void> {
  const response = await request.post(`/api/rooms/${encodeURIComponent(roomId)}/semantic`, {
    data: {
      action: "transaction",
      transaction: {
        commands: [
          {
            type: "create",
            object: {
              ...shapeObject(LEFT_ID, "Web client", 140, 160, "blue"),
              groupId: GROUP_ID,
              nodeType: "component",
            },
          },
          {
            type: "create",
            object: {
              ...shapeObject(RIGHT_ID, "Room API", 520, 160, "green"),
              groupId: GROUP_ID,
              nodeType: "service",
            },
          },
          {
            type: "create",
            object: textObject(NOTE_ID, "Independent deployment note", 900, 420),
          },
        ],
        diagramCommands: [],
      },
    },
  });
  const result = await jsonBody<SemanticTransactionResponse>(response);
  expect(new Set(result.changedObjectIds)).toEqual(new Set([LEFT_ID, RIGHT_ID, NOTE_ID]));
}

async function rightClickObject(page: Page, objectId: string): Promise<void> {
  const object = page.locator(`[data-object-id="${objectId}"]`);
  await expect(object).toBeVisible();
  await object.click({ button: "right", position: { x: 24, y: 24 } });
}

async function rightClickBlankCanvas(page: Page): Promise<void> {
  const point = await page.getByTestId("semantic-canvas").evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    for (let y = rect.bottom - 64; y >= rect.top + 120; y -= 32) {
      for (let x = rect.left + 48; x <= rect.right - 48; x += 32) {
        const target = document.elementFromPoint(x, y);
        if (
          target
          && canvas.contains(target)
          && !target.closest("[data-object-id]")
          && !target.closest("[data-semantic-selection-controls='true']")
        ) {
          return { x, y };
        }
      }
    }
    throw new Error("Could not locate unobstructed canvas background for a real right click.");
  });
  await page.mouse.click(point.x, point.y, { button: "right" });
}

test("owns participant and spectator right-click actions on the semantic canvas", async ({
  browser,
  page,
}) => {
  test.setTimeout(60_000);

  const host = await createRoomViaApi(page.request, "Casey Context", "Context menu acceptance");
  await seedContextMenuScene(page.request, host.room.id);
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });

  await rightClickObject(page, LEFT_ID);
  const participantMenu = page.getByRole("menu", { name: "Object actions" });
  await expect(participantMenu).toBeVisible();
  await expect(page.getByTestId("canvas-selection-count")).toHaveText("2 selected");
  await expect(participantMenu.getByRole("menuitem", { name: "Copy" })).toBeVisible();
  await expect(participantMenu.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
  await expect(participantMenu.getByRole("menuitem", { name: "Ungroup" })).toBeVisible();
  await expect(participantMenu.getByRole("menuitem", { name: "Delete" })).toBeVisible();

  await participantMenu.getByRole("menuitem", { name: "Select all" }).click();
  await expect(page.getByTestId("canvas-selection-count")).toHaveText("3 selected");

  // Opening one member of an existing larger selection must not collapse it.
  await rightClickObject(page, LEFT_ID);
  await expect(page.getByRole("menu", { name: "Object actions" })).toBeVisible();
  await expect(page.getByTestId("canvas-selection-count")).toHaveText("3 selected");
  await page.getByRole("menuitem", { name: "Copy" }).click();

  await rightClickBlankCanvas(page);
  const canvasMenu = page.getByRole("menu", { name: "Canvas actions" });
  await expect(canvasMenu).toBeVisible();
  await expect(canvasMenu.getByRole("menuitem", { name: "Paste" })).toBeVisible();
  await expect(canvasMenu.getByRole("menuitem", { name: "Select all" })).toBeVisible();
  await expect(canvasMenu.getByRole("menuitem", { name: "Fit board" })).toBeVisible();
  await page.keyboard.press("Escape");

  const configuredBaseUrl = test.info().project.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("The context-menu regression requires Playwright use.baseURL.");
  }
  const spectatorContext = await browser.newContext({ baseURL: configuredBaseUrl });
  try {
    await joinRoomViaApi(spectatorContext.request, {
      code: host.room.code,
      displayName: "Rory Reader",
      role: "spectator",
    });
    const spectatorPage = await spectatorContext.newPage();
    await spectatorPage.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(spectatorPage.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });

    await rightClickObject(spectatorPage, LEFT_ID);
    const spectatorMenu = spectatorPage.getByRole("menu", { name: "Object actions" });
    await expect(spectatorMenu).toBeVisible();
    await expect(spectatorMenu.getByRole("menuitem", { name: "Copy" })).toBeVisible();
    await expect(spectatorMenu.getByRole("menuitem", { name: "Select all" })).toBeVisible();
    for (const mutation of [
      "Edit label",
      "Cut",
      "Duplicate",
      "Group",
      "Ungroup",
      "Bring to front",
      "Bring forward",
      "Send backward",
      "Send to back",
      "Delete",
    ]) {
      await expect(spectatorMenu.getByRole("menuitem", { name: mutation, exact: true })).toHaveCount(0);
    }
  } finally {
    await spectatorContext.close();
  }
});
