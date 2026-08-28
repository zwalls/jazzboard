import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";

import {
  connectorObject,
  createRoomViaApi,
  getRoom,
  joinRoomViaApi,
  jsonBody,
  shapeObject,
  textObject,
  type ApiFailure,
  type RoomState,
} from "./helpers";

const SOURCE_ID = "local-first-source";
const TARGET_ID = "local-first-target";
const CONNECTOR_ID = "local-first-connector";
const TEXT_ID = "local-first-text";
const DIAGRAM_ID = "local-first-diagram";
const ORIGINAL_TEXT = "Persisted decision: keep the API synchronous";
const EDITED_TEXT = "Persisted decision: process the API asynchronously";

type SemanticTransactionResponse = {
  ok: true;
  room: RoomState;
  changedObjectIds: string[];
  changedDiagramIds: string[];
  membershipObjectIds: string[];
};

type VisibleShape = {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
};

type VisibleFrame = {
  at: number;
  shapes: Record<string, VisibleShape | null>;
};

type RenderedShape = VisibleShape & {
  at: number;
  objectX: number;
  objectY: number;
};

type CanvasCommand = {
  type?: string;
  objectId?: string;
  expectedRevision?: number;
  targets?: Array<{ objectId?: string; expectedRevision?: number }>;
  [key: string]: unknown;
};

type DelayedHumanCommands = {
  firstBlockedAt: Promise<number>;
  commands: CanvasCommand[];
  release: () => void;
  dispose: () => Promise<void>;
};

async function seedPersistedDiagram(request: APIRequestContext, roomId: string): Promise<RoomState> {
  const response = await request.post(`/api/rooms/${encodeURIComponent(roomId)}/semantic`, {
    data: {
      action: "transaction",
      transaction: {
        commands: [
          {
            type: "create",
            object: shapeObject(SOURCE_ID, "Browser client", 160, 190, "blue"),
          },
          {
            type: "create",
            object: shapeObject(TARGET_ID, "Orders service", 720, 210, "green"),
          },
          {
            type: "create",
            object: connectorObject(CONNECTOR_ID, "POST /orders", SOURCE_ID, TARGET_ID),
          },
          {
            type: "create",
            object: textObject(TEXT_ID, ORIGINAL_TEXT, 390, 430),
          },
        ],
        diagramCommands: [
          {
            type: "diagram.create",
            diagram: {
              id: DIAGRAM_ID,
              title: "Local-first checkout flow",
              description: "Persisted diagram used to exercise human edits while server state is stale.",
              diagramType: "architecture",
              category: "e2e",
              tags: ["local-first"],
              memberObjectIds: [SOURCE_ID, TARGET_ID, TEXT_ID],
              connectorIds: [CONNECTOR_ID],
            },
          },
        ],
      },
    },
  });
  const seeded = await jsonBody<SemanticTransactionResponse>(response);
  expect(new Set(seeded.changedObjectIds)).toEqual(
    new Set([SOURCE_ID, TARGET_ID, CONNECTOR_ID, TEXT_ID]),
  );
  expect(seeded.changedDiagramIds).toEqual([DIAGRAM_ID]);
  expect(new Set(seeded.membershipObjectIds)).toEqual(
    new Set([SOURCE_ID, TARGET_ID, CONNECTOR_ID, TEXT_ID]),
  );
  return seeded.room;
}

function renderedShape(page: Page, objectId: string) {
  return page
    .getByTestId("semantic-canvas")
    .locator(`[data-object-id="${objectId}"][data-object-kind]`);
}

async function readRenderedShape(page: Page, objectId: string): Promise<RenderedShape> {
  return renderedShape(page, objectId).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const objectId = element.getAttribute("data-object-id");
    const editingText = objectId
      ? document.querySelector<HTMLTextAreaElement>(
          `[data-semantic-text-editor="true"][data-object-id="${CSS.escape(objectId)}"] textarea`,
        )
      : null;
    const accessibleText = element.getAttribute("aria-label")?.replace(/^Text:\s*/, "");
    return {
      at: performance.now(),
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      objectX: Number(element.getAttribute("data-object-x")),
      objectY: Number(element.getAttribute("data-object-y")),
      text: (editingText?.value ?? accessibleText ?? element.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    };
  });
}

async function startVisibleSampler(page: Page, objectIds: string[], key: string): Promise<void> {
  await page.evaluate(
    ({ ids, stateKey }) => {
      type SamplerState = {
        frames: VisibleFrame[];
        animationFrame: number;
        observer: MutationObserver;
      };
      const target = window as unknown as Record<string, SamplerState>;
      const frames: VisibleFrame[] = [];
      let lastSignature = "";
      let lastRecordedAt = Number.NEGATIVE_INFINITY;

      const capture = () => {
        const at = performance.now();
        const shapes = Object.fromEntries(
          ids.map((objectId) => {
            const element = document.querySelector<SVGGElement>(
              `[data-testid="semantic-canvas"] [data-object-id="${CSS.escape(objectId)}"][data-object-kind]`,
            );
            if (!element) return [objectId, null];
            const bounds = element.getBoundingClientRect();
            const editingText = document.querySelector<HTMLTextAreaElement>(
              `[data-semantic-text-editor="true"][data-object-id="${CSS.escape(objectId)}"] textarea`,
            );
            const accessibleText = element.getAttribute("aria-label")?.replace(/^Text:\s*/, "");
            return [
              objectId,
              {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
                text: (editingText?.value ?? accessibleText ?? element.textContent ?? "")
                  .replace(/\s+/g, " ")
                  .trim(),
              },
            ];
          }),
        ) as Record<string, VisibleShape | null>;
        const signature = JSON.stringify(shapes);
        if (signature !== lastSignature || at - lastRecordedAt >= 15) {
          frames.push({ at, shapes });
          lastSignature = signature;
          lastRecordedAt = at;
        }
      };

      capture();
      let animationFrame = 0;
      const captureFrame = () => {
        capture();
        animationFrame = window.requestAnimationFrame(captureFrame);
        target[stateKey].animationFrame = animationFrame;
      };
      animationFrame = window.requestAnimationFrame(captureFrame);
      const observer = new MutationObserver(capture);
      observer.observe(document.querySelector('[data-testid="semantic-canvas"]') ?? document.body, {
        attributes: true,
        attributeFilter: ["style"],
        characterData: true,
        childList: true,
        subtree: true,
      });
      target[stateKey] = { frames, animationFrame, observer };
    },
    { ids: objectIds, stateKey: key },
  );
}

async function stopVisibleSampler(page: Page, key: string): Promise<VisibleFrame[]> {
  return page.evaluate((stateKey) => {
    type SamplerState = {
      frames: VisibleFrame[];
      animationFrame: number;
      observer: MutationObserver;
    };
    const target = window as unknown as Record<string, SamplerState | undefined>;
    const state = target[stateKey];
    if (!state) return [];
    window.cancelAnimationFrame(state.animationFrame);
    state.observer.disconnect();
    delete target[stateKey];
    return state.frames;
  }, key);
}

async function delayHumanCommands(page: Page, roomId: string): Promise<DelayedHumanCommands> {
  const urls = [
    `**/api/rooms/${encodeURIComponent(roomId)}/commands`,
    `**/api/rooms/${encodeURIComponent(roomId)}/semantic`,
  ];
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let markFirstBlocked!: (at: number) => void;
  const firstBlockedAt = new Promise<number>((resolve) => {
    markFirstBlocked = resolve;
  });
  let markedFirst = false;
  const commands: CanvasCommand[] = [];
  const handler = async (route: Route, request: Request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const body = request.postDataJSON() as {
      action?: string;
      command?: CanvasCommand;
      transaction?: { commands?: CanvasCommand[] };
    };
    if (body.command) commands.push(body.command);
    if (body.action === "transaction" && body.transaction?.commands) {
      commands.push(...body.transaction.commands);
    }
    if (!markedFirst) {
      markedFirst = true;
      markFirstBlocked(Date.now());
    }
    await gate;
    await route.continue();
  };
  for (const url of urls) await page.route(url, handler);
  return {
    firstBlockedAt,
    commands,
    release: releaseGate,
    async dispose() {
      releaseGate();
      for (const url of urls) await page.unroute(url, handler).catch(() => undefined);
    },
  };
}

function watchBackgroundRoomTraffic(page: Page, roomId: string) {
  const counts = { polls: 0, presence: 0 };
  const roomPath = `/api/rooms/${encodeURIComponent(roomId)}`;
  const listener = (request: Request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === roomPath) counts.polls += 1;
    if (request.method() === "POST" && url.pathname === `${roomPath}/presence`) counts.presence += 1;
  };
  page.on("requestfinished", listener);
  return {
    counts,
    stop: () => page.off("requestfinished", listener),
  };
}

async function keepGateClosedPastTwoSeconds(
  page: Page,
  blockedAt: number,
  counts: { polls: number; presence: number },
): Promise<void> {
  await page.mouse.move(1_090, 570);
  await page.waitForTimeout(120);
  await page.mouse.move(1_130, 610);
  await expect.poll(() => counts.presence, { timeout: 2_000 }).toBeGreaterThan(0);
  await expect
    .poll(
      async () => counts.polls > 0 || await page.getByLabel("Connection: Live").isVisible(),
      { timeout: 5_500 },
    )
    .toBe(true);
  const remaining = 2_150 - (Date.now() - blockedAt);
  if (remaining > 0) await page.waitForTimeout(remaining);
  expect(Date.now() - blockedAt).toBeGreaterThanOrEqual(2_000);
}

function framesSince(frames: VisibleFrame[], objectId: string, since: number) {
  return frames
    .filter((frame) => frame.at >= since)
    .flatMap((frame) => {
      const shape = frame.shapes[objectId];
      return shape ? [{ ...shape, at: frame.at }] : [];
    });
}

test.describe("persisted canvas changes stay local-first until acknowledged", () => {
  test("keeps a moved diagram node and its bound connector visible while the human save is delayed", async ({
    browser,
    page,
  }) => {
    test.setTimeout(45_000);
    const host = await createRoomViaApi(page.request, "Mira Mover", "Local-first node move");
    await seedPersistedDiagram(page.request, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel("Canvas zoom controls")).toContainText(/\d+%/);
    await expect(renderedShape(page, SOURCE_ID)).toBeVisible();
    await expect(renderedShape(page, CONNECTOR_ID)).toBeVisible();

    const agentContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    const delayed = await delayHumanCommands(page, host.room.id);
    const traffic = watchBackgroundRoomTraffic(page, host.room.id);
    const samplerKey = "__jazzboard_local_first_move_samples__";
    let samples: VisibleFrame[] = [];
    try {
      const agent = await joinRoomViaApi(agentContext.request, {
        code: host.room.code,
        displayName: "Arlo Agent",
        role: "participant",
      });
      expect(agent.participantId).not.toBe(host.participantId);
      const baseline = await getRoom(page.request, host.room.id);
      const sourceBefore = baseline.room.objects[SOURCE_ID];
      const connectorBefore = baseline.room.objects[CONNECTOR_ID];
      const diagramBefore = baseline.room.diagrams[DIAGRAM_ID];
      const sourceBeforeX = Number(sourceBefore.x);
      expect(sourceBefore).toMatchObject({ kind: "shape", revision: 1, x: 160, y: 190 });
      expect(connectorBefore).toMatchObject({
        kind: "connector",
        revision: 1,
        start: { objectId: SOURCE_ID },
        end: { objectId: TARGET_ID },
      });
      expect(diagramBefore).toMatchObject({ revision: 1 });

      const sourceStart = await readRenderedShape(page, SOURCE_ID);
      const connectorStart = await readRenderedShape(page, CONNECTOR_ID);
      await startVisibleSampler(page, [SOURCE_ID, CONNECTOR_ID], samplerKey);

      const center = {
        x: sourceStart.x + sourceStart.width / 2,
        y: sourceStart.y + sourceStart.height / 2,
      };
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      // Let the pointer-down protection's initial no-op generation settle.
      // The final gesture generation must still keep both the node and its
      // bound connector leased through the delayed save acknowledgement.
      await page.waitForTimeout(320);
      await page.mouse.move(center.x + 45, center.y + 30, { steps: 4 });
      await page.mouse.move(center.x + 95, center.y + 58, { steps: 4 });
      await page.mouse.move(center.x + 140, center.y + 82, { steps: 4 });
      await page.mouse.up();

      const localSource = await readRenderedShape(page, SOURCE_ID);
      const localConnector = await readRenderedShape(page, CONNECTOR_ID);
      expect(localSource.x - sourceStart.x).toBeGreaterThan(120);
      expect(localSource.y - sourceStart.y).toBeGreaterThan(65);
      expect(localConnector.x - connectorStart.x).toBeGreaterThan(100);
      expect(
        Math.abs(
          localConnector.x + localConnector.width - (connectorStart.x + connectorStart.width),
        ),
      ).toBeLessThan(5);

      const blockedAt = await delayed.firstBlockedAt;
      traffic.counts.polls = 0;
      traffic.counts.presence = 0;
      await keepGateClosedPastTwoSeconds(page, blockedAt, traffic.counts);

      const blockedResponse = await agentContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/agent/commands`,
        {
          data: {
            command: {
              type: "update",
              objectId: SOURCE_ID,
              expectedRevision: sourceBefore.revision,
              operation: "move",
              patch: { x: sourceBeforeX - 20 },
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
            objectId: SOURCE_ID,
            operation: "move",
            currentRevision: sourceBefore.revision,
            actor: {
              participantId: host.participantId,
              displayName: "Mira Mover",
              kind: "human",
            },
          },
        },
      });

      const blockedConnectorLeaseResponse = await agentContext.request.post(
        `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
        {
          data: {
            action: "acquire",
            objectId: CONNECTOR_ID,
            expectedRevision: connectorBefore.revision,
            operation: "connect",
          },
        },
      );
      const blockedConnectorLease = await jsonBody<ApiFailure>(blockedConnectorLeaseResponse, 409);
      expect(blockedConnectorLease).toMatchObject({
        ok: false,
        error: {
          code: "OBJECT_BUSY",
          details: {
            objectId: CONNECTOR_ID,
            operation: "connect",
            actor: { participantId: host.participantId, kind: "human" },
          },
        },
      });

      delayed.release();
      await expect
        .poll(async () => (await getRoom(page.request, host.room.id)).room.objects[SOURCE_ID].revision, {
          timeout: 10_000,
        })
        .toBeGreaterThan(sourceBefore.revision);
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases), {
          timeout: 10_000,
        })
        .toEqual([]);
      await page.waitForTimeout(180);
      samples = await stopVisibleSampler(page, samplerKey);

      const finalState = await getRoom(page.request, host.room.id);
      const finalSource = finalState.room.objects[SOURCE_ID];
      const finalConnector = finalState.room.objects[CONNECTOR_ID];
      const finalDiagram = finalState.room.diagrams[DIAGRAM_ID];
      const sourceMutations = delayed.commands.flatMap((command) => {
        if (command.type === "update" && command.objectId === SOURCE_ID) return [command];
        if (command.type !== "move") return [];
        return (command.targets ?? []).filter((target) => target.objectId === SOURCE_ID);
      });
      expect(sourceMutations.length).toBeGreaterThan(0);
      expect(sourceMutations.map((command) => command.expectedRevision)).toEqual(
        sourceMutations.map((_, index) => sourceBefore.revision + index),
      );
      expect(finalSource).toMatchObject({
        revision: sourceBefore.revision + sourceMutations.length,
        lastEditedBy: { participantId: host.participantId, kind: "human" },
      });
      expect(Number(finalSource.x)).toBeCloseTo(
        localSource.objectX,
        1,
      );
      expect(Number(finalSource.y)).toBeCloseTo(
        localSource.objectY,
        1,
      );
      expect(finalConnector).toMatchObject({
        kind: "connector",
        start: { objectId: SOURCE_ID },
        end: { objectId: TARGET_ID },
      });
      expect(finalConnector.revision).toBeGreaterThan(connectorBefore.revision);
      expect(finalDiagram.revision).toBeGreaterThan(diagramBefore.revision);
      await expect(renderedShape(page, SOURCE_ID)).toHaveAttribute(
        "data-object-revision",
        String(finalSource.revision),
      );
      await expect(renderedShape(page, CONNECTOR_ID)).toHaveAttribute(
        "data-object-revision",
        String(finalConnector.revision),
      );

      const sourceSamples = framesSince(samples, SOURCE_ID, localSource.at);
      expect(sourceSamples.length).toBeGreaterThan(40);
      const sourceRollbacks = sourceSamples.filter(
        (sample) =>
          Math.abs(sample.x - localSource.x) > 2 || Math.abs(sample.y - localSource.y) > 2,
      );
      expect(sourceRollbacks, "the moved node visibly returned to stale server coordinates").toEqual([]);

      const connectorSamples = framesSince(samples, CONNECTOR_ID, localSource.at);
      const connectorRollbacks = connectorSamples.filter(
        (sample) =>
          Math.abs(sample.x - localConnector.x) > 4 ||
          Math.abs(
            sample.x + sample.width - (localConnector.x + localConnector.width),
          ) > 4,
      );
      expect(
        connectorRollbacks,
        `the bound connector visibly detached or returned to its stale geometry: ${JSON.stringify({
          localConnector,
          connectorRollbacks,
          commands: delayed.commands,
          finalConnector,
        })}`,
      ).toEqual([]);
    } finally {
      traffic.stop();
      delayed.release();
      if (samples.length === 0) await stopVisibleSampler(page, samplerKey).catch(() => []);
      await delayed.dispose();
      await agentContext.close();
    }
  });

  test("keeps an edited persisted text value visible while the human save is delayed", async ({ page }) => {
    test.setTimeout(40_000);
    const host = await createRoomViaApi(page.request, "Tess Typist", "Local-first text edit");
    await seedPersistedDiagram(page.request, host.room.id);
    await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
    await expect(renderedShape(page, TEXT_ID)).toBeVisible();

    const baseline = await getRoom(page.request, host.room.id);
    const textBefore = baseline.room.objects[TEXT_ID];
    const diagramBefore = baseline.room.diagrams[DIAGRAM_ID];
    expect(textBefore).toMatchObject({ kind: "text", content: ORIGINAL_TEXT, revision: 1 });

    const delayed = await delayHumanCommands(page, host.room.id);
    const traffic = watchBackgroundRoomTraffic(page, host.room.id);
    const samplerKey = "__jazzboard_local_first_text_samples__";
    let samples: VisibleFrame[] = [];
    try {
      await renderedShape(page, TEXT_ID).dblclick();
      await expect
        .poll(
          async () =>
            (await getRoom(page.request, host.room.id)).room.leases[TEXT_ID]?.operation ?? null,
        )
        .toBe("edit");
      const editor = page.locator(
        `[data-semantic-text-editor="true"][data-object-id="${TEXT_ID}"] textarea`,
      );
      await expect(editor).toBeVisible();
      await startVisibleSampler(page, [TEXT_ID], samplerKey);
      await editor.fill(EDITED_TEXT);
      const localText = await readRenderedShape(page, TEXT_ID);
      expect(localText.text).toBe(EDITED_TEXT);
      await editor.press("ControlOrMeta+Enter");

      const blockedAt = await delayed.firstBlockedAt;
      traffic.counts.polls = 0;
      traffic.counts.presence = 0;
      await keepGateClosedPastTwoSeconds(page, blockedAt, traffic.counts);
      delayed.release();

      await expect
        .poll(
          async () => (await getRoom(page.request, host.room.id)).room.objects[TEXT_ID],
          { timeout: 10_000 },
        )
        .toMatchObject({ content: EDITED_TEXT, revision: textBefore.revision + 1 });
      await expect
        .poll(async () => Object.keys((await getRoom(page.request, host.room.id)).room.leases), {
          timeout: 10_000,
        })
        .toEqual([]);
      await page.waitForTimeout(180);
      samples = await stopVisibleSampler(page, samplerKey);

      const finalState = await getRoom(page.request, host.room.id);
      expect(finalState.room.objects[TEXT_ID]).toMatchObject({
        kind: "text",
        content: EDITED_TEXT,
        revision: textBefore.revision + 1,
        lastEditedBy: { participantId: host.participantId, kind: "human" },
      });
      expect(finalState.room.diagrams[DIAGRAM_ID].revision).toBe(diagramBefore.revision + 1);
      await expect(renderedShape(page, TEXT_ID)).toHaveAttribute(
        "data-object-revision",
        String(textBefore.revision + 1),
      );
      expect(
        delayed.commands.some(
          (command) => command.type === "update" && command.objectId === TEXT_ID,
        ),
      ).toBe(true);

      const textSamples = framesSince(samples, TEXT_ID, localText.at);
      expect(textSamples.length).toBeGreaterThan(40);
      const textRollbacks = textSamples.filter((sample) => sample.text !== EDITED_TEXT);
      expect(textRollbacks, "the edited text visibly returned to stale server content").toEqual([]);
    } finally {
      traffic.stop();
      delayed.release();
      if (samples.length === 0) await stopVisibleSampler(page, samplerKey).catch(() => []);
      await delayed.dispose();
    }
  });
});
