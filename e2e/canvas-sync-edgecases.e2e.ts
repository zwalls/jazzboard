import { expect, test, type Page, type Request, type Response, type Route } from "@playwright/test";

import type { RoomState } from "@/lib/domain/types";

import {
  connectorObject,
  createRoomViaApi,
  getRoom,
  joinRoomViaApi,
  jsonBody,
  shapeObject,
  type LeaseResponse,
} from "./helpers";

const LEFT_ID = "sync-left";
const RIGHT_ID = "sync-right";
const CONNECTOR_ID = "sync-connector";
const COMPLEX_GROUP_NODE_IDS = Array.from({ length: 5 }, (_, index) => `sync-group-node-${index + 1}`);
const COMPLEX_GROUP_CONNECTOR_IDS = Array.from(
  { length: 4 },
  (_, index) => `sync-group-connector-${index + 1}`,
);
const COMPLEX_GROUP_IDS = [...COMPLEX_GROUP_NODE_IDS, ...COMPLEX_GROUP_CONNECTOR_IDS];

async function seedPair(page: Page, roomId: string, includeConnector = false) {
  const response = await page.request.post(`/api/rooms/${encodeURIComponent(roomId)}/semantic`, {
    data: {
      action: "transaction",
      transaction: {
        commands: [
          { type: "create", object: shapeObject(LEFT_ID, "Left service", 180, 210, "blue") },
          { type: "create", object: shapeObject(RIGHT_ID, "Right service", 620, 210, "green") },
          ...(includeConnector
            ? [
                {
                  type: "create" as const,
                  object: connectorObject(CONNECTOR_ID, "syncs to", LEFT_ID, RIGHT_ID),
                },
              ]
            : []),
        ],
        diagramCommands: [],
      },
    },
  });
  expect(response.ok()).toBe(true);
}

async function seedComplexGroupMembers(page: Page, roomId: string) {
  const response = await page.request.post(`/api/rooms/${encodeURIComponent(roomId)}/semantic`, {
    data: {
      action: "transaction",
      transaction: {
        commands: [
          ...COMPLEX_GROUP_NODE_IDS.map((objectId, index) => ({
            type: "create" as const,
            object: shapeObject(
              objectId,
              `Architecture service ${index + 1}`,
              150 + index * 190,
              240 + (index % 2) * 90,
              index % 2 === 0 ? "blue" : "green",
            ),
          })),
          ...COMPLEX_GROUP_CONNECTOR_IDS.map((objectId, index) => ({
            type: "create" as const,
            object: connectorObject(
              objectId,
              `route ${index + 1}`,
              COMPLEX_GROUP_NODE_IDS[index],
              COMPLEX_GROUP_NODE_IDS[index + 1],
            ),
          })),
        ],
        diagramCommands: [],
      },
    },
  });
  expect(response.ok()).toBe(true);
}

function renderedShape(page: Page, objectId: string) {
  return page.locator(`.tl-shape[data-shape-id="shape:${objectId}"]`);
}

async function centerOf(page: Page, objectId: string) {
  const bounds = await renderedShape(page, objectId).boundingBox();
  if (!bounds) throw new Error(`Shape ${objectId} has no rendered bounds.`);
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

async function selectPair(page: Page) {
  await page.keyboard.press("Escape");
  const left = await renderedShape(page, LEFT_ID).boundingBox();
  const right = await renderedShape(page, RIGHT_ID).boundingBox();
  if (!left || !right) throw new Error("The pair is not rendered for marquee selection.");
  const start = {
    x: Math.min(left.x, right.x) - 36,
    y: Math.min(left.y, right.y) - 36,
  };
  const end = {
    x: Math.max(left.x + left.width, right.x + right.width) + 36,
    y: Math.max(left.y + left.height, right.y + right.height) + 36,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("canvas-selection-count")).toHaveText("2 selected");
}

async function selectObjects(page: Page, objectIds: readonly string[]) {
  await page.keyboard.press("Escape");
  const first = await centerOf(page, objectIds[0]);
  await page.mouse.click(first.x, first.y);
  await page.keyboard.press("Control+a");
  await expect(page.getByTestId("canvas-selection-count")).toHaveText(`${objectIds.length} selected`);
}

async function dragFrom(page: Page, objectId: string, dx: number, dy: number) {
  const start = await centerOf(page, objectId);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 });
  await page.mouse.up();
}

function semanticTransactionRequest(request: Request, roomId: string) {
  const url = new URL(request.url());
  return (
    request.method() === "POST" &&
    url.pathname === `/api/rooms/${encodeURIComponent(roomId)}/semantic` &&
    (request.postDataJSON() as { action?: string }).action === "transaction"
  );
}

test.describe("canvas synchronization edge cases", () => {
  test("acknowledges a verified replay without rolling back a newer local generation", async ({ page }) => {
    test.setTimeout(45_000);
    const host = await createRoomViaApi(page.request, "Replay Mover", "Replay reconciliation");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const baseline = (await getRoom(page.request, host.room.id)).room;

    let releaseReplay!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let markFirstCommitted!: () => void;
    const firstCommitted = new Promise<void>((resolve) => {
      markFirstCommitted = resolve;
    });
    let firstCommand = true;
    const commandUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}/commands`;
    const commandHandler = async (route: Route, request: Request) => {
      if (request.method() !== "POST" || !firstCommand) {
        await route.continue();
        return;
      }
      firstCommand = false;
      const upstream = await route.fetch();
      const payload = (await upstream.json()) as { room: RoomState };
      markFirstCommitted();
      await replayGate;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: {
            code: "MUTATION_OUTCOME_UNKNOWN",
            message: "The exact mutation already committed.",
            details: {
              replayed: true,
              committedRoomRevision: payload.room.roomRevision,
            },
          },
        }),
      });
    };
    await page.route(commandUrl, commandHandler);

    let holdRefresh = false;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let markRefreshHeld!: () => void;
    const refreshHeld = new Promise<void>((resolve) => {
      markRefreshHeld = resolve;
    });
    let refreshWasHeld = false;
    const roomUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}`;
    const roomHandler = async (route: Route, request: Request) => {
      if (request.method() === "GET" && holdRefresh) {
        if (!refreshWasHeld) {
          refreshWasHeld = true;
          markRefreshHeld();
        }
        await refreshGate;
      }
      await route.continue();
    };
    await page.route(roomUrl, roomHandler);

    try {
      await dragFrom(page, LEFT_ID, 65, 20);
      await firstCommitted;
      const afterFirst = await centerOf(page, LEFT_ID);

      // Generation N+1 is rendered while generation N's committed response is
      // still ambiguous and its serialized queue task remains in flight.
      await dragFrom(page, LEFT_ID, 90, 45);
      const afterSecond = await centerOf(page, LEFT_ID);
      expect(afterSecond.x - afterFirst.x).toBeGreaterThan(70);

      holdRefresh = true;
      releaseReplay();
      await refreshHeld;
      await page.waitForTimeout(500);
      const whileReconciling = await centerOf(page, LEFT_ID);
      expect(whileReconciling.x).toBeCloseTo(afterSecond.x, 0);
      expect(whileReconciling.y).toBeCloseTo(afterSecond.y, 0);
      expect(Object.keys((await getRoom(page.request, host.room.id)).room.leases)).toContain(LEFT_ID);

      holdRefresh = false;
      releaseRefresh();
      await expect
        .poll(async () => (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID]?.revision)
        .toBe(3);
      const committed = (await getRoom(page.request, host.room.id)).room;
      expect(Number(committed.objects[LEFT_ID].x) - Number(baseline.objects[LEFT_ID].x)).toBeCloseTo(155, 0);
      expect(Number(committed.objects[LEFT_ID].y) - Number(baseline.objects[LEFT_ID].y)).toBeCloseTo(65, 0);
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);
      await expect(page.getByText("The exact mutation already committed.")).toHaveCount(0);
    } finally {
      releaseReplay();
      releaseRefresh();
      await page.unroute(commandUrl, commandHandler).catch(() => undefined);
      await page.unroute(roomUrl, roomHandler).catch(() => undefined);
    }
  });

  test("saves a multi-selection move as one atomic semantic transaction", async ({ page }) => {
    const host = await createRoomViaApi(page.request, "Batch Mover", "Atomic multi-move");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    await expect(renderedShape(page, RIGHT_ID)).toBeVisible();
    const baseline = await getRoom(page.request, host.room.id);

    await selectPair(page);
    const transactionRequest = page.waitForRequest((request) =>
      semanticTransactionRequest(request, host.room.id),
    );
    await dragFrom(page, LEFT_ID, 110, 65);
    const request = await transactionRequest;
    const transaction = request.postDataJSON() as {
      transaction: { commands: Array<{ type: string; objectId?: string }> };
    };
    expect(transaction.transaction.commands).toHaveLength(2);
    expect(new Set(transaction.transaction.commands.map((command) => command.objectId))).toEqual(
      new Set([LEFT_ID, RIGHT_ID]),
    );

    await expect
      .poll(async () => {
        const room = (await getRoom(page.request, host.room.id)).room;
        return [room.objects[LEFT_ID]?.revision, room.objects[RIGHT_ID]?.revision];
      })
      .toEqual([2, 2]);
    const saved = (await getRoom(page.request, host.room.id)).room;
    expect(Number(saved.objects[LEFT_ID].x) - Number(baseline.room.objects[LEFT_ID].x)).toBeCloseTo(110, 0);
    expect(Number(saved.objects[RIGHT_ID].x) - Number(baseline.room.objects[RIGHT_ID].x)).toBeCloseTo(110, 0);
    await expect
      .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
      .toEqual([]);
  });

  test("pointer-drags a complex selected group with one atomic lease cohort", async ({ page }) => {
    test.setTimeout(45_000);
    const host = await createRoomViaApi(page.request, "Complex Group Mover", "Atomic group leases");
    await seedComplexGroupMembers(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, COMPLEX_GROUP_IDS[0])).toBeVisible({ timeout: 20_000 });
    await selectObjects(page, COMPLEX_GROUP_IDS);
    await page.keyboard.press("Control+g");
    await expect
      .poll(async () => {
        const objects = (await getRoom(page.request, host.room.id)).room.objects;
        const groupIds = COMPLEX_GROUP_IDS.map((objectId) => objects[objectId]?.groupId);
        return groupIds.every((groupId) => typeof groupId === "string") && new Set(groupIds).size === 1;
      })
      .toBe(true);
    await expect
      .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
      .toEqual([]);
    const baseline = (await getRoom(page.request, host.room.id)).room;

    const leaseRequests: Array<{ action?: string; targets?: Array<{ objectId: string }> }> = [];
    const failedLeaseStatuses: number[] = [];
    const recordRequest = (request: Request) => {
      const url = new URL(request.url());
      if (request.method() !== "POST" || url.pathname !== `/api/rooms/${host.room.id}/leases`) return;
      leaseRequests.push(request.postDataJSON());
    };
    const recordResponse = (response: Response) => {
      const url = new URL(response.url());
      if (url.pathname === `/api/rooms/${host.room.id}/leases` && response.status() === 409) {
        failedLeaseStatuses.push(response.status());
      }
    };
    page.on("request", recordRequest);
    page.on("response", recordResponse);
    try {
      const transactionRequest = page.waitForRequest((request) =>
        semanticTransactionRequest(request, host.room.id),
      );
      await dragFrom(page, COMPLEX_GROUP_IDS[4], 120, 70);
      const transaction = (await transactionRequest).postDataJSON() as {
        transaction: { commands: Array<{ objectId?: string }> };
      };
      expect(new Set(transaction.transaction.commands.map((command) => command.objectId))).toEqual(
        new Set(COMPLEX_GROUP_NODE_IDS),
      );

      await expect
        .poll(async () => {
          const objects = (await getRoom(page.request, host.room.id)).room.objects;
          return COMPLEX_GROUP_IDS.map((objectId) => objects[objectId]?.revision);
        })
        .toEqual(COMPLEX_GROUP_IDS.map(() => 3));
      const moved = (await getRoom(page.request, host.room.id)).room;
      for (const objectId of COMPLEX_GROUP_NODE_IDS) {
        expect(Number(moved.objects[objectId].x) - Number(baseline.objects[objectId].x)).toBeCloseTo(120, 0);
        expect(Number(moved.objects[objectId].y) - Number(baseline.objects[objectId].y)).toBeCloseTo(70, 0);
      }
      for (const [index, objectId] of COMPLEX_GROUP_CONNECTOR_IDS.entries()) {
        const connector = moved.objects[objectId];
        expect(connector).toMatchObject({
          kind: "connector",
          start: { objectId: COMPLEX_GROUP_NODE_IDS[index] },
          end: { objectId: COMPLEX_GROUP_NODE_IDS[index + 1] },
        });
      }
      const acquireMany = leaseRequests.filter((request) => request.action === "acquire-many");
      expect(acquireMany).toHaveLength(1);
      expect(new Set(acquireMany[0].targets?.map((target) => target.objectId))).toEqual(
        new Set(COMPLEX_GROUP_IDS),
      );
      expect(failedLeaseStatuses).toEqual([]);
      await expect(page.getByText("Canvas changed elsewhere")).toHaveCount(0);
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);
      const releaseMany = leaseRequests.filter((request) => request.action === "release-many");
      expect(releaseMany).toHaveLength(1);
      expect(new Set(releaseMany[0].targets?.map((target) => target.objectId))).toEqual(
        new Set(COMPLEX_GROUP_IDS),
      );
    } finally {
      page.off("request", recordRequest);
      page.off("response", recordResponse);
    }
  });

  test("leases a keyboard-edited node and bound connector before debounce", async ({ browser, page }) => {
    test.setTimeout(35_000);
    const host = await createRoomViaApi(page.request, "Keyboard Mover", "Immediate keyboard leases");
    await seedPair(page, host.room.id, true);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const agentContext = await browser.newContext({ baseURL: new URL(page.url()).origin });

    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let markMutationBlocked!: () => void;
    const mutationBlocked = new Promise<void>((resolve) => {
      markMutationBlocked = resolve;
    });
    let markedMutation = false;
    const mutationUrls = [
      `**/api/rooms/${encodeURIComponent(host.room.id)}/commands`,
      `**/api/rooms/${encodeURIComponent(host.room.id)}/semantic`,
    ];
    const mutationHandler = async (route: Route, request: Request) => {
      if (request.method() === "POST") {
        if (!markedMutation) {
          markedMutation = true;
          markMutationBlocked();
        }
        await mutationGate;
      }
      await route.continue();
    };

    try {
      await joinRoomViaApi(agentContext.request, {
        code: host.room.code,
        displayName: "Keyboard Lease Challenger",
        role: "participant",
      });
      const left = await centerOf(page, LEFT_ID);
      const selectionLeaseReleased = page.waitForResponse((response) => {
        const request = response.request();
        const url = new URL(request.url());
        if (
          request.method() !== "POST" ||
          url.pathname !== `/api/rooms/${encodeURIComponent(host.room.id)}/leases`
        ) {
          return false;
        }
        const body = request.postDataJSON() as { action?: string; objectId?: string };
        return body.action === "release" && body.objectId === LEFT_ID;
      });
      await page.mouse.click(left.x, left.y);
      await selectionLeaseReleased;
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);
      const baseline = (await getRoom(page.request, host.room.id)).room;

      for (const url of mutationUrls) await page.route(url, mutationHandler);
      const renewalRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        if (
          request.method() !== "POST" ||
          url.pathname !== `/api/rooms/${encodeURIComponent(host.room.id)}/leases`
        ) {
          return false;
        }
        const body = request.postDataJSON() as {
          action?: string;
          targets?: Array<{ objectId?: string }>;
        };
        return body.action === "renew-many";
      });
      await page.keyboard.press("ArrowRight");
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases).sort())
        .toEqual([CONNECTOR_ID, LEFT_ID]);

      const blocked = await agentContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
        {
          data: {
            action: "acquire",
            objectId: CONNECTOR_ID,
            expectedRevision: baseline.objects[CONNECTOR_ID].revision,
            operation: "connect",
          },
        },
      );
      const failure = (await blocked.json()) as { error?: { code?: string; details?: { objectId?: string } } };
      expect(blocked.status()).toBe(409);
      expect(failure.error).toMatchObject({
        code: "OBJECT_BUSY",
        details: { objectId: CONNECTOR_ID },
      });

      await mutationBlocked;
      const renewal = (await renewalRequest).postDataJSON() as {
        targets: Array<{ objectId: string }>;
      };
      expect(new Set(renewal.targets.map((target) => target.objectId))).toEqual(
        new Set([LEFT_ID, CONNECTOR_ID]),
      );
      releaseMutation();
      await expect
        .poll(async () => {
          const room = (await getRoom(page.request, host.room.id)).room;
          return [room.objects[LEFT_ID]?.revision, room.objects[CONNECTOR_ID]?.revision];
        })
        .toEqual([2, 2]);
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);
    } finally {
      releaseMutation();
      for (const url of mutationUrls) await page.unroute(url, mutationHandler).catch(() => undefined);
      await agentContext.close();
    }
  });

  test("cancels a delayed lease when a keyboard edit returns to authoritative state", async ({
    browser,
    page,
  }) => {
    test.setTimeout(35_000);
    const host = await createRoomViaApi(page.request, "Lease Canceller", "Cancelled lease intent");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const agentContext = await browser.newContext({ baseURL: new URL(page.url()).origin });

    let releaseFirstAcquire!: () => void;
    const firstAcquireGate = new Promise<void>((resolve) => {
      releaseFirstAcquire = resolve;
    });
    let markFirstAcquireBlocked!: () => void;
    const firstAcquireBlocked = new Promise<void>((resolve) => {
      markFirstAcquireBlocked = resolve;
    });
    let firstAcquire = true;
    const humanLeaseUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}/leases`;
    const humanLeaseHandler = async (route: Route, request: Request) => {
      const body = request.postDataJSON() as { action?: string; objectId?: string };
      if (body.action === "acquire" && body.objectId === LEFT_ID && firstAcquire) {
        firstAcquire = false;
        markFirstAcquireBlocked();
        await firstAcquireGate;
      }
      await route.continue();
    };

    let agentLease: LeaseResponse["lease"] = null;
    try {
      await joinRoomViaApi(agentContext.request, {
        code: host.room.code,
        displayName: "Lease Cancellation Challenger",
        role: "participant",
      });
      const left = await centerOf(page, LEFT_ID);
      const selectionLeaseReleased = page.waitForResponse((response) => {
        const request = response.request();
        const url = new URL(request.url());
        if (
          request.method() !== "POST" ||
          url.pathname !== `/api/rooms/${encodeURIComponent(host.room.id)}/leases`
        ) {
          return false;
        }
        const body = request.postDataJSON() as { action?: string; objectId?: string };
        return body.action === "release" && body.objectId === LEFT_ID;
      });
      await page.mouse.click(left.x, left.y);
      await selectionLeaseReleased;
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);
      const baseline = (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID];

      await page.route(humanLeaseUrl, humanLeaseHandler);
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ControlOrMeta+z");
      await firstAcquireBlocked;
      // Let the exact-authority draft pass the debounce and settle as a no-op
      // while lease acquisition is still blocked.
      await page.waitForTimeout(350);
      releaseFirstAcquire();

      // A stale acquisition must not install a new renewing lease after the
      // settled edit has already cancelled its lease intent.
      await page.waitForTimeout(3_300);
      const settled = (await getRoom(page.request, host.room.id)).room;
      expect(settled.objects[LEFT_ID]).toMatchObject({
        revision: baseline.revision,
        x: baseline.x,
        y: baseline.y,
      });
      expect(settled.leases[LEFT_ID]).toBeUndefined();

      const agentLeaseResponse = await agentContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
        {
          data: {
            action: "acquire",
            objectId: LEFT_ID,
            expectedRevision: baseline.revision,
            operation: "move",
          },
        },
      );
      agentLease = (await jsonBody<LeaseResponse>(agentLeaseResponse)).lease;
      expect(agentLease?.objectId).toBe(LEFT_ID);
    } finally {
      releaseFirstAcquire();
      await page.unroute(humanLeaseUrl, humanLeaseHandler).catch(() => undefined);
      if (agentLease) {
        await agentContext.request.post(`/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`, {
          data: {
            action: "release",
            objectId: LEFT_ID,
            leaseId: agentLease.leaseId,
          },
        });
      }
      await agentContext.close();
    }
  });

  test("keeps a newer human edit leased across stale acquire cleanup", async ({ browser, page }) => {
    test.setTimeout(45_000);
    const host = await createRoomViaApi(page.request, "Lease Barrier", "Serialized stale lease cleanup");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const agentContext = await browser.newContext({ baseURL: new URL(page.url()).origin });

    let releaseFirstAcquire!: () => void;
    const firstAcquireGate = new Promise<void>((resolve) => {
      releaseFirstAcquire = resolve;
    });
    let markFirstAcquireBlocked!: () => void;
    const firstAcquireBlocked = new Promise<void>((resolve) => {
      markFirstAcquireBlocked = resolve;
    });
    let releaseStaleCleanup!: () => void;
    const staleCleanupGate = new Promise<void>((resolve) => {
      releaseStaleCleanup = resolve;
    });
    let markStaleCleanupBlocked!: () => void;
    const staleCleanupBlocked = new Promise<void>((resolve) => {
      markStaleCleanupBlocked = resolve;
    });
    let firstAcquire = true;
    let firstCleanup = true;
    let newerAcquireRequests = 0;
    const humanLeaseUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}/leases`;
    const humanLeaseHandler = async (route: Route, request: Request) => {
      const body = request.postDataJSON() as {
        action?: string;
        objectId?: string;
        operation?: string;
      };
      if (body.action === "acquire" && body.objectId === LEFT_ID && firstAcquire) {
        firstAcquire = false;
        markFirstAcquireBlocked();
        await firstAcquireGate;
      } else if (body.action === "release" && body.objectId === LEFT_ID && firstCleanup) {
        firstCleanup = false;
        markStaleCleanupBlocked();
        await staleCleanupGate;
      } else if (
        body.action === "acquire" &&
        body.objectId === LEFT_ID &&
        body.operation === "edit"
      ) {
        newerAcquireRequests += 1;
      }
      await route.continue();
    };

    let releaseHumanCommand!: () => void;
    const humanCommandGate = new Promise<void>((resolve) => {
      releaseHumanCommand = resolve;
    });
    let markHumanCommandBlocked!: () => void;
    const humanCommandBlocked = new Promise<void>((resolve) => {
      markHumanCommandBlocked = resolve;
    });
    let markedHumanCommand = false;
    const mutationUrls = [
      `**/api/rooms/${encodeURIComponent(host.room.id)}/commands`,
      `**/api/rooms/${encodeURIComponent(host.room.id)}/semantic`,
    ];
    const mutationHandler = async (route: Route, request: Request) => {
      if (request.method() === "POST") {
        if (!markedHumanCommand) {
          markedHumanCommand = true;
          markHumanCommandBlocked();
        }
        await humanCommandGate;
      }
      await route.continue();
    };

    let agentLease: LeaseResponse["lease"] = null;
    try {
      await joinRoomViaApi(agentContext.request, {
        code: host.room.code,
        displayName: "Lease Barrier Challenger",
        role: "participant",
      });
      const left = await centerOf(page, LEFT_ID);
      const selectionLeaseReleased = page.waitForResponse((response) => {
        const request = response.request();
        const url = new URL(request.url());
        if (
          request.method() !== "POST" ||
          url.pathname !== `/api/rooms/${encodeURIComponent(host.room.id)}/leases`
        ) {
          return false;
        }
        const body = request.postDataJSON() as { action?: string; objectId?: string };
        return body.action === "release" && body.objectId === LEFT_ID;
      });
      await page.mouse.click(left.x, left.y);
      await selectionLeaseReleased;
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);
      const baseline = (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID];

      await page.route(humanLeaseUrl, humanLeaseHandler);
      for (const url of mutationUrls) await page.route(url, mutationHandler);

      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ControlOrMeta+z");
      await firstAcquireBlocked;
      await page.waitForTimeout(350);
      releaseFirstAcquire();
      await staleCleanupBlocked;

      const newerAcquireResponse = page.waitForResponse((response) => {
        const request = response.request();
        const url = new URL(request.url());
        if (
          request.method() !== "POST" ||
          url.pathname !== `/api/rooms/${encodeURIComponent(host.room.id)}/leases`
        ) {
          return false;
        }
        const body = request.postDataJSON() as {
          action?: string;
          objectId?: string;
          operation?: string;
        };
        return body.action === "acquire" && body.objectId === LEFT_ID && body.operation === "edit";
      });
      await page.getByRole("radio", { name: "Color — Red" }).click();

      // A broken implementation lets the new acquire overtake stale cleanup.
      // Exercise that ordering when it occurs; a serialized implementation
      // releases cleanup first and only then sends the new acquire.
      await page.waitForTimeout(250);
      if (newerAcquireRequests > 0) {
        await newerAcquireResponse;
        releaseStaleCleanup();
      } else {
        releaseStaleCleanup();
        await newerAcquireResponse;
      }
      await humanCommandBlocked;

      const agentAcquireResponse = await agentContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
        {
          data: {
            action: "acquire",
            objectId: LEFT_ID,
            expectedRevision: baseline.revision,
            operation: "move",
          },
        },
      );
      const agentAcquireBody = (await agentAcquireResponse.json()) as {
        lease?: LeaseResponse["lease"];
        error?: { code?: string; details?: { objectId?: string } };
      };
      agentLease = agentAcquireBody.lease ?? null;
      expect(agentAcquireResponse.status()).toBe(409);
      expect(agentAcquireBody.error).toMatchObject({
        code: "OBJECT_BUSY",
        details: { objectId: LEFT_ID },
      });

      releaseHumanCommand();
      await expect
        .poll(async () => (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID]?.revision, {
          timeout: 10_000,
        })
        .toBe(2);
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);
      expect((await getRoom(page.request, host.room.id)).room.objects[LEFT_ID]).toMatchObject({
        revision: 2,
        fill: "red",
        stroke: "red",
      });
    } finally {
      releaseFirstAcquire();
      releaseStaleCleanup();
      if (agentLease) {
        await agentContext.request.post(`/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`, {
          data: {
            action: "release",
            objectId: LEFT_ID,
            leaseId: agentLease.leaseId,
          },
        });
      }
      releaseHumanCommand();
      await page.unroute(humanLeaseUrl, humanLeaseHandler).catch(() => undefined);
      for (const url of mutationUrls) await page.unroute(url, mutationHandler).catch(() => undefined);
      await agentContext.close();
    }
  });

  test("serializes renewal and releases an ambiguously failed lease after acknowledgement", async ({
    browser,
    page,
  }) => {
    test.setTimeout(45_000);
    const host = await createRoomViaApi(page.request, "Renewal Serializer", "Ambiguous renewal release");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const agentContext = await browser.newContext({ baseURL: new URL(page.url()).origin });

    let abortFirstRenew!: () => void;
    const firstRenewGate = new Promise<void>((resolve) => {
      abortFirstRenew = resolve;
    });
    let markFirstRenewBlocked!: () => void;
    const firstRenewBlocked = new Promise<void>((resolve) => {
      markFirstRenewBlocked = resolve;
    });
    let markFirstRenewAborted!: () => void;
    const firstRenewAborted = new Promise<void>((resolve) => {
      markFirstRenewAborted = resolve;
    });
    let renewRequests = 0;
    const humanLeaseUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}/leases`;
    const humanLeaseHandler = async (route: Route, request: Request) => {
      const body = request.postDataJSON() as { action?: string; objectId?: string };
      if (body.action === "renew" && body.objectId === LEFT_ID) {
        renewRequests += 1;
        if (renewRequests === 1) {
          markFirstRenewBlocked();
          await firstRenewGate;
          await route.abort("failed");
          markFirstRenewAborted();
          return;
        }
      }
      await route.continue();
    };

    let releaseHumanCommand!: () => void;
    const humanCommandGate = new Promise<void>((resolve) => {
      releaseHumanCommand = resolve;
    });
    let markHumanCommandBlocked!: () => void;
    const humanCommandBlocked = new Promise<void>((resolve) => {
      markHumanCommandBlocked = resolve;
    });
    let markedHumanCommand = false;
    const mutationUrls = [
      `**/api/rooms/${encodeURIComponent(host.room.id)}/commands`,
      `**/api/rooms/${encodeURIComponent(host.room.id)}/semantic`,
    ];
    const mutationHandler = async (route: Route, request: Request) => {
      if (request.method() === "POST") {
        if (!markedHumanCommand) {
          markedHumanCommand = true;
          markHumanCommandBlocked();
        }
        await humanCommandGate;
      }
      await route.continue();
    };

    let agentLease: LeaseResponse["lease"] = null;
    try {
      await joinRoomViaApi(agentContext.request, {
        code: host.room.code,
        displayName: "Renewal Challenger",
        role: "participant",
      });
      const left = await centerOf(page, LEFT_ID);
      const selectionLeaseReleased = page.waitForResponse((response) => {
        const request = response.request();
        const url = new URL(request.url());
        if (
          request.method() !== "POST" ||
          url.pathname !== `/api/rooms/${encodeURIComponent(host.room.id)}/leases`
        ) {
          return false;
        }
        const body = request.postDataJSON() as { action?: string; objectId?: string };
        return body.action === "release" && body.objectId === LEFT_ID;
      });
      await page.mouse.click(left.x, left.y);
      await selectionLeaseReleased;
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);

      await page.route(humanLeaseUrl, humanLeaseHandler);
      for (const url of mutationUrls) await page.route(url, mutationHandler);
      await page.getByRole("radio", { name: "Color — Red" }).click();
      await humanCommandBlocked;
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([LEFT_ID]);

      await firstRenewBlocked;
      // Cross the following 1.5 s interval while renewal #1 remains unresolved.
      // A serialized renewal loop must not start a second request behind it.
      await page.waitForTimeout(1_700);
      const renewCountWhileBlocked = renewRequests;
      abortFirstRenew();
      await firstRenewAborted;
      await page.waitForTimeout(50);

      const releaseAfterAcknowledgement = page.waitForResponse(
        (response) => {
          const request = response.request();
          const url = new URL(request.url());
          if (
            request.method() !== "POST" ||
            url.pathname !== `/api/rooms/${encodeURIComponent(host.room.id)}/leases`
          ) {
            return false;
          }
          const body = request.postDataJSON() as { action?: string; objectId?: string };
          return body.action === "release" && body.objectId === LEFT_ID;
        },
        { timeout: 1_500 },
      );
      releaseHumanCommand();
      await releaseAfterAcknowledgement;
      expect(renewCountWhileBlocked).toBe(1);

      await expect
        .poll(async () => {
          const room = (await getRoom(page.request, host.room.id)).room;
          return {
            revision: room.objects[LEFT_ID]?.revision,
            fill: room.objects[LEFT_ID]?.kind === "shape" ? room.objects[LEFT_ID].fill : null,
            leased: Boolean(room.leases[LEFT_ID]),
          };
        })
        .toEqual({ revision: 2, fill: "red", leased: false });

      const agentLeaseResponse = await agentContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
        {
          data: {
            action: "acquire",
            objectId: LEFT_ID,
            expectedRevision: 2,
            operation: "move",
          },
        },
      );
      expect(agentLeaseResponse.status()).toBe(200);
      agentLease = (await jsonBody<LeaseResponse>(agentLeaseResponse)).lease;
      expect(agentLease?.objectId).toBe(LEFT_ID);
    } finally {
      abortFirstRenew();
      releaseHumanCommand();
      await page.unroute(humanLeaseUrl, humanLeaseHandler).catch(() => undefined);
      for (const url of mutationUrls) await page.unroute(url, mutationHandler).catch(() => undefined);
      if (agentLease) {
        await agentContext.request.post(`/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`, {
          data: {
            action: "release",
            objectId: LEFT_ID,
            leaseId: agentLease.leaseId,
          },
        });
      }
      await agentContext.close();
    }
  });

  test("reconciles a group when one renewal token is stale and releases valid siblings", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const host = await createRoomViaApi(page.request, "Stale Cohort", "Definitive lease-loss recovery");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    await selectPair(page);
    await expect
      .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
      .toEqual([]);

    const leaseUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}/leases`;
    const leaseActions: Array<{
      action?: string;
      objectId?: string;
      targets?: Array<{ objectId: string; leaseId: string }>;
    }> = [];
    let staleTokenInjected = false;
    let replacementLeaseId: string | null = null;
    let staleObjectId: string | null = null;
    let markRenewManySeen!: () => void;
    const renewManySeen = new Promise<void>((resolve) => {
      markRenewManySeen = resolve;
    });
    const leaseHandler = async (route: Route, request: Request) => {
      if (request.method() !== "POST") {
        await route.continue();
        return;
      }
      const body = request.postDataJSON() as (typeof leaseActions)[number];
      leaseActions.push(body);
      if (body.action === "renew-many" && !staleTokenInjected) {
        staleTokenInjected = true;
        const victim = body.targets?.[0];
        if (!victim) throw new Error("The renewal cohort did not include a victim lease.");
        const invalidated = await page.request.post(
          `/api/rooms/${encodeURIComponent(host.room.id)}/leases`,
          { data: { action: "release", ...victim } },
        );
        expect(invalidated.ok()).toBe(true);
        const replacement = await page.request.post(
          `/api/rooms/${encodeURIComponent(host.room.id)}/leases`,
          {
            data: {
              action: "acquire",
              objectId: victim.objectId,
              expectedRevision: 1,
              operation: "move",
            },
          },
        );
        expect(replacement.ok()).toBe(true);
        const replacementBody = await jsonBody<LeaseResponse>(replacement);
        replacementLeaseId = replacementBody.lease?.leaseId ?? null;
        staleObjectId = victim.objectId;
        markRenewManySeen();
      }
      await route.continue();
    };

    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let markMutationBlocked!: () => void;
    const mutationBlocked = new Promise<void>((resolve) => {
      markMutationBlocked = resolve;
    });
    let mutationIsBlocked = false;
    const mutationUrls = [
      `**/api/rooms/${encodeURIComponent(host.room.id)}/commands`,
      `**/api/rooms/${encodeURIComponent(host.room.id)}/semantic`,
    ];
    const mutationHandler = async (route: Route, request: Request) => {
      if (request.method() === "POST" && !mutationIsBlocked) {
        mutationIsBlocked = true;
        markMutationBlocked();
        await mutationGate;
      }
      await route.continue();
    };

    try {
      await page.route(leaseUrl, leaseHandler);
      for (const url of mutationUrls) await page.route(url, mutationHandler);
      await page.getByRole("radio", { name: "Color — Red" }).click();
      await mutationBlocked;
      await renewManySeen;

      await expect
        .poll(() => leaseActions.filter((item) => item.action === "renew").length)
        .toBeGreaterThanOrEqual(2);
      await expect
        .poll(() => leaseActions.filter((item) => item.action === "release-many").length)
        .toBeGreaterThanOrEqual(1);
      await expect
        .poll(() => leaseActions.filter((item) => item.action === "release").length)
        .toBeGreaterThanOrEqual(2);
      await expect
        .poll(async () => {
          const leases = (await getRoom(page.request, host.room.id)).room.leases;
          return {
            objectIds: Object.keys(leases),
            replacementLeaseId: staleObjectId ? leases[staleObjectId]?.leaseId ?? null : null,
          };
        })
        .toEqual({ objectIds: [staleObjectId], replacementLeaseId });
      expect(
        new Set(
          leaseActions
            .filter((item) => item.action === "release")
            .map((item) => item.objectId),
        ),
      ).toEqual(new Set([LEFT_ID, RIGHT_ID]));
      await expect(
        page.getByRole("alert").filter({ hasText: "Canvas changed elsewhere" }),
      ).toContainText("active-object lease is missing");

      releaseMutation();
      await expect
        .poll(async () => {
          const room = (await getRoom(page.request, host.room.id)).room;
          return {
            revisions: [room.objects[LEFT_ID]?.revision, room.objects[RIGHT_ID]?.revision],
            leased: Object.keys(room.leases),
          };
        })
        .toEqual({ revisions: [1, 1], leased: [staleObjectId] });
    } finally {
      releaseMutation();
      await page.unroute(leaseUrl, leaseHandler).catch(() => undefined);
      for (const url of mutationUrls) await page.unroute(url, mutationHandler).catch(() => undefined);
      if (staleObjectId && replacementLeaseId) {
        await page.request.post(`/api/rooms/${encodeURIComponent(host.room.id)}/leases`, {
          data: {
            action: "release",
            objectId: staleObjectId,
            leaseId: replacementLeaseId,
          },
        });
      }
    }
  });

  test("keeps rapid keyboard edits on disjoint selections isolated", async ({ browser, page }) => {
    test.setTimeout(40_000);
    const host = await createRoomViaApi(page.request, "Keyboard Isolator", "Disjoint keyboard batches");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const agentContext = await browser.newContext({ baseURL: new URL(page.url()).origin });

    let releaseBlockedAcquire!: () => void;
    const blockedAcquireGate = new Promise<void>((resolve) => {
      releaseBlockedAcquire = resolve;
    });
    let markAcquireBlocked!: () => void;
    const acquireBlocked = new Promise<void>((resolve) => {
      markAcquireBlocked = resolve;
    });
    const humanLeaseUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}/leases`;
    const humanLeaseHandler = async (route: Route, request: Request) => {
      const body = request.postDataJSON() as { action?: string; objectId?: string };
      if (body.action === "acquire" && body.objectId === LEFT_ID) {
        markAcquireBlocked();
        await blockedAcquireGate;
      }
      await route.continue();
    };

    let agentLease: LeaseResponse["lease"] = null;
    try {
      await joinRoomViaApi(agentContext.request, {
        code: host.room.code,
        displayName: "Disjoint Keyboard Challenger",
        role: "participant",
      });
      const left = await centerOf(page, LEFT_ID);
      const right = await centerOf(page, RIGHT_ID);
      const selectionLeaseReleased = page.waitForResponse((response) => {
        const request = response.request();
        const url = new URL(request.url());
        if (
          request.method() !== "POST" ||
          url.pathname !== `/api/rooms/${encodeURIComponent(host.room.id)}/leases`
        ) {
          return false;
        }
        const body = request.postDataJSON() as { action?: string; objectId?: string };
        return body.action === "release" && body.objectId === LEFT_ID;
      });
      await page.mouse.click(left.x, left.y);
      await selectionLeaseReleased;
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);
      const baseline = (await getRoom(page.request, host.room.id)).room;

      const agentLeaseResponse = await agentContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
        {
          data: {
            action: "acquire",
            objectId: LEFT_ID,
            expectedRevision: baseline.objects[LEFT_ID].revision,
            operation: "move",
          },
        },
      );
      agentLease = (await jsonBody<LeaseResponse>(agentLeaseResponse)).lease;
      expect(agentLease?.objectId).toBe(LEFT_ID);

      await page.route(humanLeaseUrl, humanLeaseHandler);
      await page.keyboard.press("ArrowRight");
      await page.mouse.click(right.x, right.y);
      await page.keyboard.press("ArrowRight");
      await acquireBlocked;

      // B must be able to save while A's unrelated lease acquisition remains
      // blocked. A single global keyboard batch would queue one atomic A+B save.
      await expect
        .poll(async () => (await getRoom(page.request, host.room.id)).room.objects[RIGHT_ID]?.revision, {
          timeout: 2_500,
          intervals: [50],
        })
        .toBe(2);
      expect((await getRoom(page.request, host.room.id)).room.objects[LEFT_ID]).toMatchObject({
        revision: baseline.objects[LEFT_ID].revision,
        x: baseline.objects[LEFT_ID].x,
      });

      releaseBlockedAcquire();
      await expect
        .poll(async () => {
          const room = (await getRoom(page.request, host.room.id)).room;
          return [room.objects[LEFT_ID]?.revision, room.objects[RIGHT_ID]?.revision];
        })
        .toEqual([1, 2]);
    } finally {
      releaseBlockedAcquire();
      await page.unroute(humanLeaseUrl, humanLeaseHandler).catch(() => undefined);
      if (agentLease) {
        await agentContext.request.post(`/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`, {
          data: {
            action: "release",
            objectId: LEFT_ID,
            leaseId: agentLease.leaseId,
          },
        });
      }
      await agentContext.close();
    }
  });

  test("lets a pointer gesture absorb an overlapping keyboard interaction", async ({ page }) => {
    test.setTimeout(35_000);
    const host = await createRoomViaApi(page.request, "Input Handoff", "Keyboard to pointer ownership");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });

    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let markMutationBlocked!: () => void;
    const mutationBlocked = new Promise<void>((resolve) => {
      markMutationBlocked = resolve;
    });
    let mutationRequests = 0;
    let pointerDown = false;
    const mutationUrls = [
      `**/api/rooms/${encodeURIComponent(host.room.id)}/commands`,
      `**/api/rooms/${encodeURIComponent(host.room.id)}/semantic`,
    ];
    const mutationHandler = async (route: Route, request: Request) => {
      if (request.method() === "POST") {
        mutationRequests += 1;
        markMutationBlocked();
        await mutationGate;
      }
      await route.continue();
    };

    try {
      const left = await centerOf(page, LEFT_ID);
      const selectionLeaseReleased = page.waitForResponse((response) => {
        const request = response.request();
        const url = new URL(request.url());
        if (
          request.method() !== "POST" ||
          url.pathname !== `/api/rooms/${encodeURIComponent(host.room.id)}/leases`
        ) {
          return false;
        }
        const body = request.postDataJSON() as { action?: string; objectId?: string };
        return body.action === "release" && body.objectId === LEFT_ID;
      });
      await page.mouse.click(left.x, left.y);
      await selectionLeaseReleased;
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);

      for (const url of mutationUrls) await page.route(url, mutationHandler);
      await page.keyboard.press("ArrowRight");
      await page.mouse.move(left.x, left.y);
      await page.mouse.down();
      pointerDown = true;
      for (let step = 1; step <= 6; step += 1) {
        await page.waitForTimeout(60);
        await page.mouse.move(left.x + step * 14, left.y + step * 4);
      }

      // The original keyboard timer has elapsed, but it must not end or flush
      // the newer pointer gesture while pointer movement is still active.
      expect(mutationRequests).toBe(0);
      await page.mouse.up();
      pointerDown = false;
      await mutationBlocked;
      expect(mutationRequests).toBe(1);

      releaseMutation();
      await expect
        .poll(async () => (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID]?.revision)
        .toBe(2);
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);
    } finally {
      if (pointerDown) await page.mouse.up().catch(() => undefined);
      releaseMutation();
      for (const url of mutationUrls) await page.unroute(url, mutationHandler).catch(() => undefined);
    }
  });

  test("rolls back every member when one selected object is busy without a partial save", async ({
    browser,
    page,
  }) => {
    const host = await createRoomViaApi(page.request, "Conflict Mover", "Atomic conflict rollback");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const agentContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      await joinRoomViaApi(agentContext.request, {
        code: host.room.code,
        displayName: "Lease Holder",
        role: "participant",
      });
      const baseline = await getRoom(page.request, host.room.id);
      const agentLeaseResponse = await agentContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
        {
          data: {
            action: "acquire",
            objectId: RIGHT_ID,
            expectedRevision: baseline.room.objects[RIGHT_ID].revision,
            operation: "move",
          },
        },
      );
      const agentLease = await jsonBody<LeaseResponse>(agentLeaseResponse);
      expect(agentLease.lease?.objectId).toBe(RIGHT_ID);

      let releaseBusyAcquire!: () => void;
      const busyGate = new Promise<void>((resolve) => {
        releaseBusyAcquire = resolve;
      });
      const humanLeaseUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}/leases`;
      await page.route(humanLeaseUrl, async (route, request) => {
        const body = request.postDataJSON() as {
          action?: string;
          objectId?: string;
          targets?: Array<{ objectId?: string }>;
        };
        const acquiresBusyObject =
          (body.action === "acquire" && body.objectId === RIGHT_ID) ||
          (body.action === "acquire-many" &&
            body.targets?.some((target) => target.objectId === RIGHT_ID));
        if (acquiresBusyObject) await busyGate;
        await route.continue();
      });

      await selectPair(page);

      const leftBefore = await centerOf(page, LEFT_ID);
      const rightBefore = await centerOf(page, RIGHT_ID);
      await dragFrom(page, LEFT_ID, 125, 75);
      const locallyMovedLeft = await centerOf(page, LEFT_ID);
      const locallyMovedRight = await centerOf(page, RIGHT_ID);
      expect(locallyMovedLeft.x - leftBefore.x).toBeGreaterThan(50);
      expect(locallyMovedRight.x - rightBefore.x).toBeGreaterThan(50);

      releaseBusyAcquire();
      await expect
        .poll(async () => (await centerOf(page, LEFT_ID)).x, { timeout: 10_000 })
        .toBeCloseTo(leftBefore.x, 0);
      await expect.poll(async () => (await centerOf(page, RIGHT_ID)).x).toBeCloseTo(rightBefore.x, 0);
      const after = (await getRoom(page.request, host.room.id)).room;
      expect(after.objects[LEFT_ID]).toMatchObject({ revision: 1, x: baseline.room.objects[LEFT_ID].x });
      expect(after.objects[RIGHT_ID]).toMatchObject({ revision: 1, x: baseline.room.objects[RIGHT_ID].x });
      expect(after.leases[LEFT_ID]).toBeUndefined();

      const release = await agentContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
        {
          data: {
            action: "release",
            objectId: RIGHT_ID,
            leaseId: agentLease.lease?.leaseId,
          },
        },
      );
      expect(release.ok()).toBe(true);
    } finally {
      await agentContext.close();
    }
  });

  test("does not couple unrelated debounced edits when one object conflicts", async ({ browser, page }) => {
    const host = await createRoomViaApi(page.request, "Independent Editor", "Per-object debounce isolation");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const baseline = (await getRoom(page.request, host.room.id)).room;
    const agentContext = await browser.newContext({ baseURL: new URL(page.url()).origin });

    let releaseBusyAcquire!: () => void;
    const busyAcquireGate = new Promise<void>((resolve) => {
      releaseBusyAcquire = resolve;
    });
    const humanLeaseUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}/leases`;
    const humanLeaseHandler = async (route: Route, request: Request) => {
      const body = request.postDataJSON() as { action?: string; objectId?: string };
      if (body.action === "acquire" && body.objectId === LEFT_ID) await busyAcquireGate;
      await route.continue();
    };

    let agentLease: LeaseResponse["lease"] = null;
    try {
      await joinRoomViaApi(agentContext.request, {
        code: host.room.code,
        displayName: "Unrelated Lease Holder",
        role: "participant",
      });
      const left = await centerOf(page, LEFT_ID);
      await page.mouse.click(left.x, left.y);
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);

      const agentLeaseResponse = await agentContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
        {
          data: {
            action: "acquire",
            objectId: LEFT_ID,
            expectedRevision: baseline.objects[LEFT_ID].revision,
            operation: "move",
          },
        },
      );
      agentLease = (await jsonBody<LeaseResponse>(agentLeaseResponse)).lease;
      expect(agentLease?.objectId).toBe(LEFT_ID);

      await page.route(humanLeaseUrl, humanLeaseHandler);
      await page.keyboard.press("ArrowRight");
      await dragFrom(page, RIGHT_ID, 85, 45);

      await expect
        .poll(async () => (await getRoom(page.request, host.room.id)).room.objects[RIGHT_ID]?.revision)
        .toBe(2);
      releaseBusyAcquire();
      await expect
        .poll(async () => {
          const room = (await getRoom(page.request, host.room.id)).room;
          return [room.objects[LEFT_ID]?.revision, room.objects[RIGHT_ID]?.revision];
        })
        .toEqual([1, 2]);
      const saved = (await getRoom(page.request, host.room.id)).room;
      expect(saved.objects[LEFT_ID].x).toBe(baseline.objects[LEFT_ID].x);
      expect(Number(saved.objects[RIGHT_ID].x)).toBeGreaterThan(Number(baseline.objects[RIGHT_ID].x));
    } finally {
      releaseBusyAcquire();
      await page.unroute(humanLeaseUrl, humanLeaseHandler).catch(() => undefined);
      if (agentLease) {
        await agentContext.request.post(`/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`, {
          data: {
            action: "release",
            objectId: LEFT_ID,
            leaseId: agentLease.leaseId,
          },
        });
      }
      await agentContext.close();
    }
  });

  test("does not let an older queued save steal a newer atomic gesture", async ({ browser, page }) => {
    test.setTimeout(45_000);
    const host = await createRoomViaApi(page.request, "Queue Racer", "Queued generation boundary");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const baseline = (await getRoom(page.request, host.room.id)).room;
    const agentContext = await browser.newContext({ baseURL: new URL(page.url()).origin });

    let releaseFirstCommand!: () => void;
    const firstCommandGate = new Promise<void>((resolve) => {
      releaseFirstCommand = resolve;
    });
    let markFirstCommandBlocked!: () => void;
    const firstCommandBlocked = new Promise<void>((resolve) => {
      markFirstCommandBlocked = resolve;
    });
    let firstCommand = true;
    const commandUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}/commands`;
    const commandHandler = async (route: Route, request: Request) => {
      if (request.method() === "POST" && firstCommand) {
        firstCommand = false;
        markFirstCommandBlocked();
        await firstCommandGate;
      }
      await route.continue();
    };
    await page.route(commandUrl, commandHandler);

    let releaseBusyAcquire!: () => void;
    const busyAcquireGate = new Promise<void>((resolve) => {
      releaseBusyAcquire = resolve;
    });
    const humanLeaseUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}/leases`;
    const humanLeaseHandler = async (route: Route, request: Request) => {
      const body = request.postDataJSON() as { action?: string; objectId?: string };
      if (body.action === "acquire" && body.objectId === RIGHT_ID) await busyAcquireGate;
      await route.continue();
    };

    let agentLease: LeaseResponse["lease"] = null;
    try {
      await joinRoomViaApi(agentContext.request, {
        code: host.room.code,
        displayName: "Atomic Lease Holder",
        role: "participant",
      });

      await dragFrom(page, LEFT_ID, 70, 25);
      await firstCommandBlocked;
      await dragFrom(page, LEFT_ID, 55, 20);

      const agentLeaseResponse = await agentContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
        {
          data: {
            action: "acquire",
            objectId: RIGHT_ID,
            expectedRevision: baseline.objects[RIGHT_ID].revision,
            operation: "move",
          },
        },
      );
      agentLease = (await jsonBody<LeaseResponse>(agentLeaseResponse)).lease;
      expect(agentLease?.objectId).toBe(RIGHT_ID);

      await page.route(humanLeaseUrl, humanLeaseHandler);
      await selectPair(page);
      await dragFrom(page, LEFT_ID, 100, 55);

      releaseFirstCommand();
      await expect
        .poll(async () => (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID]?.revision, {
          timeout: 10_000,
        })
        .toBeGreaterThanOrEqual(2);
      await page.waitForTimeout(450);
      const beforeConflict = (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID];
      // Either queued single-object draft may commit in order, but neither may
      // steal the later A+B gesture's pixels before its B lease is resolved.
      expect(Number(beforeConflict.x)).toBeLessThan(Number(baseline.objects[LEFT_ID].x) + 180);

      releaseBusyAcquire();
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases), {
          timeout: 10_000,
        })
        .toEqual([RIGHT_ID]);
      const finalRoom = (await getRoom(page.request, host.room.id)).room;
      expect(finalRoom.objects[LEFT_ID]).toMatchObject({
        revision: beforeConflict.revision,
        x: beforeConflict.x,
        y: beforeConflict.y,
      });
      expect(finalRoom.objects[RIGHT_ID]).toMatchObject({
        revision: 1,
        x: baseline.objects[RIGHT_ID].x,
        y: baseline.objects[RIGHT_ID].y,
      });
    } finally {
      releaseFirstCommand();
      releaseBusyAcquire();
      await page.unroute(commandUrl, commandHandler);
      await page.unroute(humanLeaseUrl, humanLeaseHandler).catch(() => undefined);
      if (agentLease) {
        await agentContext.request.post(`/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`, {
          data: {
            action: "release",
            objectId: RIGHT_ID,
            leaseId: agentLease.leaseId,
          },
        });
      }
      await agentContext.close();
    }
  });

  test("rolls back a pending multi-object gesture when an older member save fails", async ({ page }) => {
    test.setTimeout(45_000);
    const host = await createRoomViaApi(page.request, "Failure Racer", "Recovery batch boundary");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const baseline = (await getRoom(page.request, host.room.id)).room;
    const initialLeftCenter = await centerOf(page, LEFT_ID);
    const initialRightCenter = await centerOf(page, RIGHT_ID);

    let releaseFirstFailure!: () => void;
    const firstFailureGate = new Promise<void>((resolve) => {
      releaseFirstFailure = resolve;
    });
    let markFirstCommandBlocked!: () => void;
    const firstCommandBlocked = new Promise<void>((resolve) => {
      markFirstCommandBlocked = resolve;
    });
    let firstCommand = true;
    const commandUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}/commands`;
    const commandHandler = async (route: Route, request: Request) => {
      if (request.method() !== "POST" || !firstCommand) {
        await route.continue();
        return;
      }
      firstCommand = false;
      markFirstCommandBlocked();
      await firstFailureGate;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "Injected older save failure." },
        }),
      });
    };
    await page.route(commandUrl, commandHandler);

    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const roomUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}`;
    const roomHandler = async (route: Route, request: Request) => {
      if (request.method() === "GET") await recoveryGate;
      await route.continue();
    };
    await page.route(roomUrl, roomHandler);

    try {
      await dragFrom(page, LEFT_ID, 70, 25);
      await firstCommandBlocked;
      await selectPair(page);

      const leftBefore = await centerOf(page, LEFT_ID);
      const rightBefore = await centerOf(page, RIGHT_ID);
      await page.mouse.move(leftBefore.x, leftBefore.y);
      await page.mouse.down();
      await page.mouse.move(leftBefore.x + 90, leftBefore.y + 50, { steps: 6 });
      const movedLeft = await centerOf(page, LEFT_ID);
      const movedRight = await centerOf(page, RIGHT_ID);
      expect(movedLeft.x - leftBefore.x).toBeGreaterThan(40);
      expect(movedRight.x - rightBefore.x).toBeGreaterThan(40);

      releaseFirstFailure();
      await expect(page.getByText("Injected older save failure.")).toBeVisible();
      await page.mouse.up();
      await page.waitForTimeout(350);

      const beforeRecovery = (await getRoom(page.request, host.room.id)).room;
      expect(beforeRecovery.objects[LEFT_ID]).toMatchObject({
        revision: 1,
        x: baseline.objects[LEFT_ID].x,
        y: baseline.objects[LEFT_ID].y,
      });
      expect(beforeRecovery.objects[RIGHT_ID]).toMatchObject({
        revision: 1,
        x: baseline.objects[RIGHT_ID].x,
        y: baseline.objects[RIGHT_ID].y,
      });

      releaseRecovery();
      await expect
        .poll(async () => (await centerOf(page, LEFT_ID)).x, { timeout: 10_000 })
        .toBeCloseTo(initialLeftCenter.x, 0);
      await expect
        .poll(async () => (await centerOf(page, RIGHT_ID)).x)
        .toBeCloseTo(initialRightCenter.x, 0);
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);
      const finalRoom = (await getRoom(page.request, host.room.id)).room;
      expect(finalRoom.objects[LEFT_ID].revision).toBe(1);
      expect(finalRoom.objects[RIGHT_ID].revision).toBe(1);
    } finally {
      releaseFirstFailure();
      releaseRecovery();
      await page.unroute(commandUrl, commandHandler).catch(() => undefined);
      await page.unroute(roomUrl, roomHandler).catch(() => undefined);
    }
  });

  test("rolls back a queued multi-object gesture in one recovery cohort", async ({ page }) => {
    test.setTimeout(45_000);
    const host = await createRoomViaApi(page.request, "Queued Failure Racer", "Queued recovery cohort");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const baseline = (await getRoom(page.request, host.room.id)).room;
    const initialLeftCenter = await centerOf(page, LEFT_ID);
    const initialRightCenter = await centerOf(page, RIGHT_ID);

    let releaseFirstFailure!: () => void;
    const firstFailureGate = new Promise<void>((resolve) => {
      releaseFirstFailure = resolve;
    });
    let markFirstCommandBlocked!: () => void;
    const firstCommandBlocked = new Promise<void>((resolve) => {
      markFirstCommandBlocked = resolve;
    });
    let firstCommand = true;
    const commandUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}/commands`;
    const commandHandler = async (route: Route, request: Request) => {
      if (request.method() !== "POST" || !firstCommand) {
        await route.continue();
        return;
      }
      firstCommand = false;
      markFirstCommandBlocked();
      await firstFailureGate;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "Injected queued save failure." },
        }),
      });
    };
    await page.route(commandUrl, commandHandler);

    type HeldRoomRequest = { release: () => void };
    const heldRoomRequests: HeldRoomRequest[] = [];
    let holdRoomRequests = false;
    const roomUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}`;
    const roomHandler = async (route: Route, request: Request) => {
      if (request.method() !== "GET" || !holdRoomRequests) {
        await route.continue();
        return;
      }
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      heldRoomRequests.push({ release });
      await gate;
      await route.continue();
    };
    await page.route(roomUrl, roomHandler);

    try {
      await dragFrom(page, LEFT_ID, 70, 25);
      await firstCommandBlocked;
      await selectPair(page);
      await dragFrom(page, LEFT_ID, 90, 50);
      const movedLeft = await centerOf(page, LEFT_ID);
      const movedRight = await centerOf(page, RIGHT_ID);
      expect(movedLeft.x - initialLeftCenter.x).toBeGreaterThan(100);
      expect(movedRight.x - initialRightCenter.x).toBeGreaterThan(40);

      // Pointer-up has flushed A+B out of the debounce/gesture refs. It is now
      // queued behind the older A-only command and must remain discoverable as
      // one atomic recovery cohort.
      await page.waitForTimeout(350);
      holdRoomRequests = true;
      releaseFirstFailure();
      await expect(page.getByText("Injected queued save failure.")).toBeVisible();
      await expect(page.getByText(/related canvas change was invalidated/i)).toHaveCount(0);

      let rolledBack = false;
      for (let index = 0; index < 4 && !rolledBack; index += 1) {
        await expect.poll(() => heldRoomRequests.length, { timeout: 5_000 }).toBeGreaterThan(index);
        heldRoomRequests[index].release();
        await page.waitForTimeout(180);
        const left = await centerOf(page, LEFT_ID);
        const right = await centerOf(page, RIGHT_ID);
        const leftRolledBack = Math.abs(left.x - initialLeftCenter.x) < 2;
        const rightRolledBack = Math.abs(right.x - initialRightCenter.x) < 2;
        expect(
          leftRolledBack,
          "one member visibly rolled back before the rest of its queued atomic gesture",
        ).toBe(rightRolledBack);
        rolledBack = leftRolledBack && rightRolledBack;
      }
      expect(rolledBack, "the queued A+B gesture never reached authoritative state").toBe(true);

      holdRoomRequests = false;
      for (const held of heldRoomRequests) held.release();
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
        .toEqual([]);
      const finalRoom = (await getRoom(page.request, host.room.id)).room;
      expect(finalRoom.objects[LEFT_ID]).toMatchObject({
        revision: 1,
        x: baseline.objects[LEFT_ID].x,
        y: baseline.objects[LEFT_ID].y,
      });
      expect(finalRoom.objects[RIGHT_ID]).toMatchObject({
        revision: 1,
        x: baseline.objects[RIGHT_ID].x,
        y: baseline.objects[RIGHT_ID].y,
      });
    } finally {
      holdRoomRequests = false;
      releaseFirstFailure();
      for (const held of heldRoomRequests) held.release();
      await page.unroute(commandUrl, commandHandler).catch(() => undefined);
      await page.unroute(roomUrl, roomHandler).catch(() => undefined);
    }
  });

  test("treats a tldraw duplicate as a new semantic object", async ({ page }) => {
    const host = await createRoomViaApi(page.request, "Clone Maker", "Duplicate identity");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const baseline = (await getRoom(page.request, host.room.id)).room;

    const start = await centerOf(page, LEFT_ID);
    await page.mouse.click(start.x, start.y);
    await page.mouse.click(start.x, start.y, { button: "right" });
    await page.getByRole("menuitem", { name: /Duplicate/i }).click();

    await expect
      .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.objects).length)
      .toBe(3);
    const saved = (await getRoom(page.request, host.room.id)).room;
    expect(saved.objects[LEFT_ID]).toMatchObject({
      revision: baseline.objects[LEFT_ID].revision,
      x: baseline.objects[LEFT_ID].x,
      y: baseline.objects[LEFT_ID].y,
    });
    const clone = Object.values(saved.objects).find(
      (object) => object.id !== LEFT_ID && object.id !== RIGHT_ID,
    );
    expect(clone).toMatchObject({ kind: "shape", label: "Left service", revision: 1 });
  });

  test("duplicates a group with a fresh shared semantic group identity", async ({ page }) => {
    const host = await createRoomViaApi(page.request, "Group Cloner", "Grouped duplicate identity");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });

    await selectPair(page);
    await page.keyboard.press("Control+g");
    await expect
      .poll(async () => {
        const room = (await getRoom(page.request, host.room.id)).room;
        return [room.objects[LEFT_ID]?.groupId, room.objects[RIGHT_ID]?.groupId];
      })
      .toEqual([expect.any(String), expect.any(String)]);
    const grouped = (await getRoom(page.request, host.room.id)).room;
    const originalGroupId = grouped.objects[LEFT_ID].groupId;
    expect(originalGroupId).toBe(grouped.objects[RIGHT_ID].groupId);

    await page.keyboard.press("Control+d");

    await expect
      .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.objects).length)
      .toBe(4);
    const saved = (await getRoom(page.request, host.room.id)).room;
    const clones = Object.values(saved.objects).filter(
      (object) => object.id !== LEFT_ID && object.id !== RIGHT_ID,
    );
    expect(clones).toHaveLength(2);
    expect(new Set(clones.map((object) => object.groupId)).size).toBe(1);
    expect(clones[0].groupId).toEqual(expect.any(String));
    expect(clones[0].groupId).not.toBe(originalGroupId);
    expect(saved.objects[LEFT_ID].groupId).toBe(originalGroupId);
    expect(saved.objects[RIGHT_ID].groupId).toBe(originalGroupId);
  });

  test("does not copy a singleton semantic group identity when duplicating its survivor", async ({ page }) => {
    const host = await createRoomViaApi(page.request, "Singleton Cloner", "Singleton group identity");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });

    await selectPair(page);
    await page.keyboard.press("Control+g");
    await expect
      .poll(async () => (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID]?.groupId)
      .toEqual(expect.any(String));
    const grouped = (await getRoom(page.request, host.room.id)).room;
    const groupId = grouped.objects[LEFT_ID].groupId;
    expect(groupId).toBe(grouped.objects[RIGHT_ID].groupId);

    const leaseResponse = await page.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
      {
        data: {
          action: "acquire",
          objectId: RIGHT_ID,
          expectedRevision: grouped.objects[RIGHT_ID].revision,
          operation: "delete",
        },
      },
    );
    const deletionLease = await jsonBody<LeaseResponse>(leaseResponse);
    const deleteResponse = await page.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/commands`,
      {
        data: {
          command: {
            type: "delete",
            targets: [
              {
                objectId: RIGHT_ID,
                expectedRevision: grouped.objects[RIGHT_ID].revision,
                leaseId: deletionLease.lease?.leaseId,
              },
            ],
          },
        },
      },
    );
    expect(deleteResponse.ok()).toBe(true);
    await expect(renderedShape(page, RIGHT_ID)).toHaveCount(0);
    await expect
      .poll(async () => (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID]?.groupId)
      .toBe(groupId);

    const left = await centerOf(page, LEFT_ID);
    await page.mouse.click(left.x, left.y);
    await page.mouse.click(left.x, left.y, { button: "right" });
    await page.getByRole("menuitem", { name: /Duplicate/i }).click();
    await expect
      .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.objects).length)
      .toBe(2);

    const saved = (await getRoom(page.request, host.room.id)).room;
    const clone = Object.values(saved.objects).find((object) => object.id !== LEFT_ID);
    expect(saved.objects[LEFT_ID].groupId).toBe(groupId);
    expect(clone).toMatchObject({ groupId: null, revision: 1 });
  });

  test("persists keyboard movement of a semantic group through its members", async ({ page }) => {
    const host = await createRoomViaApi(page.request, "Group Nudger", "Keyboard group movement");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });

    await selectPair(page);
    await page.keyboard.press("Control+g");
    await expect
      .poll(async () => {
        const room = (await getRoom(page.request, host.room.id)).room;
        return [room.objects[LEFT_ID]?.groupId, room.objects[RIGHT_ID]?.groupId];
      })
      .toEqual([expect.any(String), expect.any(String)]);
    await expect
      .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases))
      .toEqual([]);
    const grouped = (await getRoom(page.request, host.room.id)).room;

    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => {
        const room = (await getRoom(page.request, host.room.id)).room;
        return [room.objects[LEFT_ID]?.revision, room.objects[RIGHT_ID]?.revision];
      })
      .toEqual([
        Number(grouped.objects[LEFT_ID].revision) + 1,
        Number(grouped.objects[RIGHT_ID].revision) + 1,
      ]);
    const moved = (await getRoom(page.request, host.room.id)).room;
    expect(Number(moved.objects[LEFT_ID].x)).toBeGreaterThan(Number(grouped.objects[LEFT_ID].x));
    expect(Number(moved.objects[RIGHT_ID].x)).toBeGreaterThan(Number(grouped.objects[RIGHT_ID].x));
    expect(moved.objects[LEFT_ID].groupId).toBe(grouped.objects[LEFT_ID].groupId);
    expect(moved.objects[RIGHT_ID].groupId).toBe(grouped.objects[RIGHT_ID].groupId);
  });

  test("recreates a deleted object on undo with a fresh authoritative incarnation", async ({ page }) => {
    const host = await createRoomViaApi(page.request, "Undo Maker", "Delete undo");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const baseline = (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID];

    const center = await centerOf(page, LEFT_ID);
    await page.mouse.click(center.x, center.y);
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID] ?? null).toBeNull();

    await page.keyboard.press("Meta+z");
    await expect(renderedShape(page, LEFT_ID)).toBeVisible();
    await expect
      .poll(async () => (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID]?.revision ?? null)
      .toBe(1);
    const recreated = (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID];
    expect(Number(recreated.createdAt)).toBeGreaterThan(Number(baseline.createdAt));

    await dragFrom(page, LEFT_ID, 70, 40);
    await expect
      .poll(async () => (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID]?.revision ?? null)
      .toBe(2);
  });

  test("keeps an undone failed deletion locked until authoritative recovery completes", async ({
    browser,
    page,
  }) => {
    test.setTimeout(45_000);
    const host = await createRoomViaApi(page.request, "Recovery Undoer", "Failed delete undo recovery");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const baseline = (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID];
    const agentContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    let agentLease: LeaseResponse["lease"] = null;

    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let markRefreshBlocked!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      markRefreshBlocked = resolve;
    });
    let markedRefresh = false;
    const roomUrl = `**/api/rooms/${encodeURIComponent(host.room.id)}`;
    const roomHandler = async (route: Route, request: Request) => {
      const url = new URL(request.url());
      if (
        request.method() === "GET" &&
        url.pathname === `/api/rooms/${encodeURIComponent(host.room.id)}`
      ) {
        if (!markedRefresh) {
          markedRefresh = true;
          markRefreshBlocked();
        }
        await refreshGate;
      }
      await route.continue();
    };

    try {
      await joinRoomViaApi(agentContext.request, {
        code: host.room.code,
        displayName: "Delete Lease Holder",
        role: "participant",
      });
      const center = await centerOf(page, LEFT_ID);
      await page.mouse.click(center.x, center.y);
      await expect
        .poll(async () => (await getRoom(page.request, host.room.id)).room.leases[LEFT_ID] ?? null)
        .toBeNull();

      const acquired = await agentContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
        {
          data: {
            action: "acquire",
            objectId: LEFT_ID,
            expectedRevision: baseline.revision,
            operation: "delete",
          },
        },
      );
      agentLease = (await jsonBody<LeaseResponse>(acquired)).lease;
      expect(agentLease?.objectId).toBe(LEFT_ID);

      await page.route(roomUrl, roomHandler);
      const busyResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.status() === 409 &&
          response.request().method() === "POST" &&
          url.pathname === `/api/rooms/${encodeURIComponent(host.room.id)}/leases`
        );
      });
      await page.keyboard.press("Delete");
      await busyResponse;
      await refreshBlocked;

      await page.keyboard.press("Meta+z");
      await expect(renderedShape(page, LEFT_ID)).toBeVisible();
      const recoveringPosition = await centerOf(page, LEFT_ID);
      await dragFrom(page, LEFT_ID, 90, 55);
      const afterBlockedDrag = await centerOf(page, LEFT_ID);
      expect(afterBlockedDrag.x).toBeCloseTo(recoveringPosition.x, 0);
      expect(afterBlockedDrag.y).toBeCloseTo(recoveringPosition.y, 0);
      expect((await getRoom(page.request, host.room.id)).room.objects[LEFT_ID]).toMatchObject({
        revision: baseline.revision,
        x: baseline.x,
        y: baseline.y,
      });

      const refreshResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.status() === 200 &&
          response.request().method() === "GET" &&
          url.pathname === `/api/rooms/${encodeURIComponent(host.room.id)}`
        );
      });
      releaseRefresh();
      await refreshResponse;

      const released = await agentContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
        {
          data: {
            action: "release",
            objectId: LEFT_ID,
            leaseId: agentLease?.leaseId,
          },
        },
      );
      expect(released.ok()).toBe(true);
      agentLease = null;
      await expect
        .poll(async () => (await getRoom(page.request, host.room.id)).room.leases[LEFT_ID] ?? null)
        .toBeNull();
      await page.waitForTimeout(180);

      await dragFrom(page, LEFT_ID, 65, 35);
      await expect
        .poll(async () => (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID]?.revision, {
          timeout: 10_000,
        })
        .toBe(2);
    } finally {
      releaseRefresh();
      await page.unroute(roomUrl, roomHandler).catch(() => undefined);
      if (agentLease) {
        await agentContext.request.post(`/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`, {
          data: {
            action: "release",
            objectId: LEFT_ID,
            leaseId: agentLease.leaseId,
          },
        });
      }
      await agentContext.close();
    }
  });

  test("flushes a pending keyboard edit when the canvas unmounts", async ({ page }) => {
    const host = await createRoomViaApi(page.request, "Fast Navigator", "Unmount flush");
    await seedPair(page, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(renderedShape(page, LEFT_ID)).toBeVisible({ timeout: 20_000 });
    const baseline = (await getRoom(page.request, host.room.id)).room.objects[LEFT_ID];

    const center = await centerOf(page, LEFT_ID);
    await page.mouse.click(center.x, center.y);
    const saveRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        request.method() === "POST" &&
        (url.pathname.endsWith(`/rooms/${encodeURIComponent(host.room.id)}/commands`) ||
          url.pathname.endsWith(`/rooms/${encodeURIComponent(host.room.id)}/semantic`))
      );
    });
    await page.keyboard.press("ArrowRight");
    await page.getByLabel("Back to Jazzboard home").click();
    await saveRequest;
    await expect(page).toHaveURL(/\/$/);
    await expect
      .poll(async () => Number((await getRoom(page.request, host.room.id)).room.objects[LEFT_ID]?.x))
      .toBeGreaterThan(Number(baseline.x));
  });
});
