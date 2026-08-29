import { expect, test, type Request } from "@playwright/test";

import { createRoomViaApi, getRoom, joinRoomViaApi, jsonBody } from "./helpers";

test("parks an idle agent locally and restores authoritative motion when work resumes", async ({
  browser,
  page,
}) => {
  test.setTimeout(45_000);
  const host = await createRoomViaApi(page.request, "Maya Host", "Idle agent parking");
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  await expect(page.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });

  const collaboratorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const collaborator = await joinRoomViaApi(collaboratorContext.request, {
      code: host.room.code,
      displayName: "Orbit Architect",
      role: "participant",
    });
    const authoritativeCursor = { x: 260, y: 220 };
    const idlePresenceResponse = await collaboratorContext.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/presence`,
      {
        headers: { "x-jazzboard-presence-protocol": "delta-v1" },
        data: { cursor: authoritativeCursor, viewport: null, activity: null },
      },
    );
    await jsonBody(idlePresenceResponse);

    const marker = page.getByTestId(`agent-cursor-${collaborator.participantId}`);
    await expect(marker).toBeVisible({ timeout: 10_000 });
    await expect(marker).toHaveAttribute("data-agent-draggable", "true");
    await expect(marker).toHaveAttribute("data-working", "false");
    await expect(marker).toHaveAttribute("data-local-parked", "false");
    const agentNameTagStyle = await marker.locator('[data-agent-cursor-label="true"]').evaluate((element) => {
      const tagStyle = getComputedStyle(element);
      const markerStyle = getComputedStyle(element.parentElement!);
      const avatarColor = markerStyle.getPropertyValue("--agent-avatar-color").trim();
      const colorProbe = document.createElement("span");
      colorProbe.style.color = avatarColor;
      document.body.append(colorProbe);
      const resolvedAvatarColor = getComputedStyle(colorProbe).color;
      colorProbe.remove();
      return {
        avatarColor,
        backgroundColor: tagStyle.backgroundColor,
        borderColor: tagStyle.borderColor,
        boxShadow: tagStyle.boxShadow,
        color: tagStyle.color,
        draftingDot: getComputedStyle(element.parentElement!, "::after").content,
        markerColor: markerStyle.color,
        resolvedAvatarColor,
      };
    });
    expect(agentNameTagStyle).toMatchObject({
      backgroundColor: "rgb(255, 255, 255)",
      borderColor: agentNameTagStyle.resolvedAvatarColor,
      draftingDot: "none",
    });
    expect(agentNameTagStyle.avatarColor).toMatch(/^#[\da-f]{6}$/i);
    expect(agentNameTagStyle.color).not.toBe(agentNameTagStyle.markerColor);
    expect(agentNameTagStyle.boxShadow).not.toBe("none");

    const sharedMutationRequests: string[] = [];
    const observeRequests = (request: Request) => {
      if (request.method() !== "POST") return;
      const path = new URL(request.url()).pathname;
      if (/\/(?:agent\/)?(?:commands|leases)$/.test(path) || /\/agent\/presence$/.test(path)) {
        sharedMutationRequests.push(path);
      }
    };
    page.on("request", observeRequests);

    const before = await marker.boundingBox();
    if (!before) throw new Error("The idle agent marker did not have a browser layout box.");
    expect(before.width).toBeGreaterThanOrEqual(70);
    expect(before.height).toBeGreaterThanOrEqual(70);
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + 190, before.y + 130, { steps: 8 });
    await page.mouse.up();

    await expect(marker).toHaveAttribute("data-local-parked", "true");
    const parked = await marker.boundingBox();
    if (!parked) throw new Error("The parked agent marker did not have a browser layout box.");
    expect(parked.x - before.x).toBeGreaterThan(120);
    expect(parked.y - before.y).toBeGreaterThan(70);
    expect(sharedMutationRequests).toEqual([]);
    page.off("request", observeRequests);

    const authoritative = await getRoom(collaboratorContext.request, host.room.id);
    const authoritativeAgent = authoritative.room.participants[collaborator.participantId] as
      | { agent?: { cursor?: { x: number; y: number } | null } }
      | undefined;
    expect(authoritativeAgent?.agent?.cursor).toEqual(authoritativeCursor);

    const workingPresenceResponse = await collaboratorContext.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/presence`,
      {
        headers: { "x-jazzboard-presence-protocol": "delta-v1" },
        data: {
          cursor: { x: 160, y: 150 },
          viewport: null,
          activity: {
            id: "activity_resume_after_parking",
            type: "moving",
            label: "Arranging the board",
            objectIds: [],
            progress: 0.5,
            startedAt: Date.now(),
            durationMs: 10_000,
            fromCursor: { x: 140, y: 140 },
            toCursor: { x: 160, y: 150 },
          },
        },
      },
    );
    await jsonBody(workingPresenceResponse);

    await expect(marker).toHaveAttribute("data-working", "true", { timeout: 10_000 });
    await expect(marker).toHaveAttribute("data-local-parked", "false");
    await expect(marker).not.toHaveAttribute("data-agent-draggable");
    expect(await marker.evaluate((element) => element.tagName)).toBe("DIV");

    const working = await marker.boundingBox();
    if (!working) throw new Error("The working agent marker did not have a browser layout box.");
    expect(Math.abs(working.x - parked.x)).toBeGreaterThan(80);
  } finally {
    await collaboratorContext.close();
  }
});
