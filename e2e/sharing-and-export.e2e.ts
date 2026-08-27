import { expect, test } from "@playwright/test";

import { createRoomViaApi } from "./helpers";

test("shares the live board by private invite while keeping exports separate", async ({ browser, page }) => {
  const host = await createRoomViaApi(page.request, "Avery Host", "Architecture review");
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  await expect(page.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as Window & { __jazzboardCopiedInvite?: string }).__jazzboardCopiedInvite = value;
        },
      },
    });
  });

  await page.getByRole("button", { name: "Share board" }).click();
  const sharePanel = page.getByRole("complementary", { name: "Share board" });
  await expect(sharePanel).toBeVisible();
  await expect(sharePanel.getByText("Collaborate live")).toBeVisible();
  await expect(sharePanel.getByText(host.room.code, { exact: true })).toBeVisible();
  await expect(sharePanel.getByText("Share read-only")).toBeVisible();
  await expect(sharePanel.getByRole("button", { name: "Semantic JSON" })).toHaveCount(0);

  await page.getByRole("button", { name: "Show people in this room" }).click();
  await expect(sharePanel).toHaveCount(0);
  await expect(page.getByText("In this room", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show people in this room" }).click();

  await page.getByRole("button", { name: "Share board" }).click();
  await expect(sharePanel).toBeVisible();
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(sharePanel).toHaveCount(0);
  await expect(page.getByText("Choose a live target", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Follow", exact: true }).click();

  await page.getByRole("button", { name: "Share board" }).click();
  await expect(sharePanel).toBeVisible();

  await sharePanel.getByRole("button", { name: "Copy invite" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __jazzboardCopiedInvite?: string }).__jazzboardCopiedInvite ?? "",
      ),
    )
    .not.toBe("");

  const inviteText = await page.evaluate(
    () => (window as Window & { __jazzboardCopiedInvite?: string }).__jazzboardCopiedInvite ?? "",
  );
  expect(inviteText).toContain(`Room code: ${host.room.code}`);
  const inviteUrl = inviteText.split("\n").find((line) => line.includes("#join="));
  expect(inviteUrl).toBeTruthy();
  expect(new URL(inviteUrl!).hash).toBe(`#join=${host.room.code}`);

  await sharePanel.getByRole("button", { name: "Close share board" }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const exportPanel = page.getByRole("complementary", { name: "Export board" });
  await expect(exportPanel).toBeVisible();
  await expect(exportPanel.getByRole("button", { name: "Semantic JSON" })).toBeEnabled();
  await expect(exportPanel.getByRole("button", { name: "SVG" })).toBeEnabled();
  await expect(exportPanel.getByRole("button", { name: "PNG" })).toBeEnabled();
  await expect(exportPanel.getByRole("button", { name: "Mermaid" })).toBeDisabled();
  await expect(exportPanel.getByRole("button", { name: /Save diagram template/ })).toBeVisible();

  const invitedContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const invitedPage = await invitedContext.newPage();
    await invitedPage.goto(inviteUrl!);

    await expect(invitedPage.getByRole("tab", { name: "Join by code", selected: true })).toBeVisible();
    await expect(invitedPage.getByLabel("Room code")).toHaveValue(host.room.code);
    await expect(invitedPage.getByRole("radio", { name: /^Participant/i })).toBeChecked();

    await invitedPage.getByLabel("Your display name").fill("Sam Spectator");
    await invitedPage.getByRole("radio", { name: /^Spectator/i }).check();
    await invitedPage.getByRole("button", { name: "Join this Jazzboard" }).click();
    await expect(invitedPage).toHaveURL(/\/room\/room_[^/?#]+$/, { timeout: 20_000 });
    await expect(invitedPage.locator("header").getByText("spectator", { exact: true })).toBeVisible();

    await invitedPage.getByRole("button", { name: "Share board" }).click();
    const spectatorShare = invitedPage.getByRole("complementary", { name: "Share board" });
    await expect(spectatorShare.getByRole("button", { name: "Copy invite" })).toBeVisible();
    await expect(spectatorShare.getByText(/Only participants can issue frozen read-only snapshot links/)).toBeVisible();
    await expect(spectatorShare.getByText("Share read-only")).toHaveCount(0);

    await spectatorShare.getByRole("button", { name: "Close share board" }).click();
    await invitedPage.getByRole("button", { name: "Export", exact: true }).click();
    const spectatorExport = invitedPage.getByRole("complementary", { name: "Export board" });
    await expect(spectatorExport.getByRole("button", { name: "Semantic JSON" })).toBeEnabled();
    await expect(spectatorExport.getByText(/Spectators can download passive exports/)).toBeVisible();
    await expect(spectatorExport.getByText("Reuse")).toHaveCount(0);
  } finally {
    await invitedContext.close();
  }
});
