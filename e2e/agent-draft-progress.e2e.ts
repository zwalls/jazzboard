/// <reference types="webmcp-types" />

import { expect, test, type Page } from "@playwright/test";

import { createRoomViaApi, joinRoomViaApi } from "./helpers";

type WebMcpFailure = {
  ok: false;
  tool: string;
  error: { code: string; message: string };
};

type WebMcpSuccess<T> = { ok: true; tool: string; data: T };
type WebMcpResult<T> = WebMcpSuccess<T> | WebMcpFailure;

type DraftSnapshot = {
  id: string;
  roomId: string;
  revision: number;
  baselineRoomRevision: number;
  status: "active" | "committing" | "awaiting_review";
  temporaryReferences: Record<string, string>;
  previewObjects: Array<{ id: string; kind: string; authority: "draft" }>;
  previewDiagrams: Array<{ id: string; memberObjectIds: string[]; connectorIds: string[] }>;
};

type DraftedResult = {
  outcome: "drafted";
  draft: DraftSnapshot;
  draftId: string;
  draftRevision: number;
  baselineRoomRevision: number;
  temporaryReferences: Record<string, string>;
};

type ReadDraftResult = { draft: DraftSnapshot; serverTime: number };
type ReadDraftsResult = { drafts: DraftSnapshot[]; serverTime: number };

type ReadRoomResult = {
  room: { id: string; roomRevision: number };
  objects: Array<{ id: string; revision: number }>;
  diagrams: Array<{ id: string; revision: number; memberObjectIds: string[]; connectorIds: string[] }>;
};

type FinishDraftResult = {
  draftId: string;
  action: "commit";
  outcome: "applied" | "proposed";
  roomRevision: number;
  changedObjectIds: string[];
  changedDiagramIds: string[];
};

type QueryResult = { roomRevision: number; totalMatched: number; objects: Array<{ id: string }> };

type TransitionFrame = {
  authoritative: number;
  draft: number;
  at: number;
};

const NODE_REFS = ["browser", "gateway", "api", "queue", "worker", "database"] as const;
const CONNECTOR_REFS = ["browser_gateway", "gateway_api", "api_queue", "queue_worker", "worker_database"] as const;
const DIAGRAM_REF = "demo_architecture";

function node(
  tempRef: typeof NODE_REFS[number],
  label: string,
  nodeType: "component" | "service",
  x: number,
  y: number,
) {
  return {
    op: "create_node",
    tempRef,
    label,
    nodeType,
    x,
    y,
    width: 170,
    height: 92,
  };
}

function connection(
  tempRef: typeof CONNECTOR_REFS[number],
  start: typeof NODE_REFS[number],
  end: typeof NODE_REFS[number],
  label: string,
  sides: { start: "right" | "bottom"; end: "left" | "top" },
) {
  return {
    op: "connect",
    tempRef,
    start: { tempRef: start, port: { side: sides.start, position: 0.5 } },
    end: { tempRef: end, port: { side: sides.end, position: 0.5 } },
    direction: "end",
    label,
    color: "black",
    routing: { mode: "elbow", elbowMidPoint: 0.5, labelPosition: 0.5 },
  };
}

const NODES = [
  node("browser", "Draft Demo · Browser", "component", 100, 150),
  node("gateway", "Draft Demo · Gateway", "service", 350, 150),
  node("api", "Draft Demo · Room API", "service", 600, 150),
  node("queue", "Draft Demo · Event Queue", "component", 600, 390),
  node("worker", "Draft Demo · Worker", "service", 840, 390),
  node("database", "Draft Demo · Database", "component", 1_060, 390),
] as const;

const CONNECTORS = [
  connection("browser_gateway", "browser", "gateway", "HTTPS", { start: "right", end: "left" }),
  connection("gateway_api", "gateway", "api", "authorized request", { start: "right", end: "left" }),
  connection("api_queue", "api", "queue", "enqueue", { start: "bottom", end: "top" }),
  connection("queue_worker", "queue", "worker", "deliver", { start: "right", end: "left" }),
  connection("worker_database", "worker", "database", "persist", { start: "right", end: "left" }),
] as const;

function cumulativeOperations(nodeCount: 2 | 4 | 6) {
  const connectorCount = nodeCount - 1;
  const nodes = NODES.slice(0, nodeCount);
  const connectors = CONNECTORS.slice(0, connectorCount);
  return [
    ...nodes,
    ...connectors,
    {
      op: "create_diagram",
      tempRef: DIAGRAM_REF,
      title: "Progressive agent draft architecture",
      description: "A six-node request-to-storage flow staged visibly before one atomic commit.",
      diagramType: "architecture",
      category: "acceptance-test",
      tags: ["draft", "progressive", "atomic"],
      members: nodes.map(({ tempRef }) => ({ tempRef })),
      connectors: connectors.map(({ tempRef }) => ({ tempRef })),
    },
  ];
}

async function installWebMcpShim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tools = new Map<string, WebMCP.ModelContextTool>();
    const browserWindow = window as Window & {
      __agentDraftProgressTools?: Map<string, WebMCP.ModelContextTool>;
    };
    browserWindow.__agentDraftProgressTools = tools;
    const modelContext = new EventTarget() as WebMCP.ModelContext;
    modelContext.ontoolchange = null;
    modelContext.registerTool = async (tool, options) => {
      tools.set(tool.name, tool);
      options?.signal?.addEventListener("abort", () => {
        if (tools.get(tool.name) === tool) tools.delete(tool.name);
      }, { once: true });
    };
    modelContext.getTools = async () => [...tools.values()].map((tool) => ({
      name: tool.name,
      title: tool.title ?? tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      window,
      origin: window.location.origin,
    }));
    Object.defineProperty(document, "modelContext", { configurable: true, value: modelContext });
  });
}

async function toolNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tools = (window as Window & {
      __agentDraftProgressTools?: Map<string, WebMCP.ModelContextTool>;
    }).__agentDraftProgressTools;
    return [...(tools?.keys() ?? [])].sort();
  });
}

async function callTool<T>(page: Page, name: string, input: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(async ({ toolName, toolInput }) => {
    const tools = (window as Window & {
      __agentDraftProgressTools?: Map<string, WebMCP.ModelContextTool>;
    }).__agentDraftProgressTools;
    const tool = tools?.get(toolName);
    if (!tool) throw new Error(`WebMCP tool ${toolName} is not registered.`);
    return tool.execute(toolInput, { signal: new AbortController().signal });
  }, { toolName: name, toolInput: input }) as WebMcpResult<T>;
  if (!result.ok) throw new Error(`${result.tool}: ${result.error.code} ${result.error.message}`);
  return result.data;
}

async function expectDraftProjection(
  page: Page,
  input: { draftId: string; revision: number; objectCount: number },
): Promise<void> {
  const layer = page.getByTestId("agent-draft-layer");
  await expect(layer).toBeVisible({ timeout: 15_000 });
  await expect(layer).toHaveCSS("pointer-events", "none");
  await expect(layer.locator("svg")).toHaveAttribute("aria-hidden", "true");
  await expect(layer.locator(`[data-agent-draft-pill="${input.draftId}"]`)).toContainText(
    `${input.objectCount} elements`,
  );
  await expect(layer.locator("[data-agent-draft-object-id]")).toHaveCount(input.objectCount);
  await expect(layer.locator("[data-agent-draft-object-id][role]")).toHaveCount(0);
  await expect(layer.locator("[data-agent-draft-object-id][tabindex]")).toHaveCount(0);
  await expect(page.getByTestId("semantic-canvas").locator("[data-object-id]")).toHaveCount(0);

  const read = await callTool<ReadDraftResult>(page, "read_canvas_drafts", { draftId: input.draftId });
  expect(read.draft).toMatchObject({ id: input.draftId, revision: input.revision, status: "active" });
  expect(read.draft.previewObjects).toHaveLength(input.objectCount);
}

async function authoritativeState(page: Page): Promise<ReadRoomResult> {
  return callTool<ReadRoomResult>(page, "read_room_state", {});
}

async function startTransitionSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: TransitionFrame[] = [];
    const browserWindow = window as Window & {
      __agentDraftTransition?: { frames: TransitionFrame[]; animationFrame: number };
    };
    const sample = () => {
      const canvas = document.querySelector('[data-testid="semantic-canvas"]');
      frames.push({
        authoritative: canvas?.querySelectorAll("[data-object-id]").length ?? 0,
        draft: document.querySelectorAll("[data-agent-draft-object-id]").length,
        at: performance.now(),
      });
      if (browserWindow.__agentDraftTransition) {
        browserWindow.__agentDraftTransition.animationFrame = requestAnimationFrame(sample);
      }
    };
    browserWindow.__agentDraftTransition = { frames, animationFrame: requestAnimationFrame(sample) };
  });
}

async function stopTransitionSampler(page: Page): Promise<TransitionFrame[]> {
  return page.evaluate(() => {
    const browserWindow = window as Window & {
      __agentDraftTransition?: { frames: TransitionFrame[]; animationFrame: number };
    };
    const state = browserWindow.__agentDraftTransition;
    if (!state) return [];
    cancelAnimationFrame(state.animationFrame);
    delete browserWindow.__agentDraftTransition;
    return state.frames;
  });
}

test("progressively previews a real WebMCP draft and commits it atomically", async ({ browser, page }, testInfo) => {
  test.setTimeout(90_000);
  const configuredBaseUrl = testInfo.project.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("Agent draft progress E2E requires Playwright use.baseURL.");
  }

  const host = await createRoomViaApi(page.request, "Ari Agent Owner", "Progressive draft demo");
  const viewerContext = await browser.newContext({
    baseURL: configuredBaseUrl,
    viewport: { width: 1_280, height: 720 },
    recordVideo: {
      dir: testInfo.outputPath("viewer-video"),
      size: { width: 1_280, height: 720 },
    },
  });
  const spectatorContext = await browser.newContext({
    baseURL: configuredBaseUrl,
    viewport: { width: 1_280, height: 720 },
  });
  let viewerPage: Page | null = null;
  let viewerVideo: ReturnType<Page["video"]> = null;

  try {
    await joinRoomViaApi(viewerContext.request, {
      code: host.room.code,
      displayName: "Harper Human Viewer",
      role: "participant",
    });
    await joinRoomViaApi(spectatorContext.request, {
      code: host.room.code,
      displayName: "Sky Spectator",
      role: "spectator",
    });

    viewerPage = await viewerContext.newPage();
    const spectatorPage = await spectatorContext.newPage();
    viewerVideo = viewerPage.video();
    await Promise.all([
      installWebMcpShim(page),
      installWebMcpShim(viewerPage),
      installWebMcpShim(spectatorPage),
    ]);
    await Promise.all([
      page.goto(`/room/${encodeURIComponent(host.room.id)}`),
      viewerPage.goto(`/room/${encodeURIComponent(host.room.id)}`),
      spectatorPage.goto(`/room/${encodeURIComponent(host.room.id)}`),
    ]);
    await Promise.all([
      expect(page.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 }),
      expect(viewerPage.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 }),
      expect(spectatorPage.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 }),
    ]);

    await expect.poll(() => toolNames(page), { timeout: 15_000 }).toEqual(
      expect.arrayContaining(["apply_canvas_transaction", "finish_canvas_draft", "read_canvas_drafts"]),
    );
    await expect.poll(() => toolNames(viewerPage!), { timeout: 15_000 }).toEqual(
      expect.arrayContaining(["read_canvas_drafts", "read_room_state"]),
    );
    await expect.poll(() => toolNames(spectatorPage), { timeout: 15_000 }).toEqual(
      expect.arrayContaining(["read_canvas_drafts", "read_room_state"]),
    );
    const spectatorTools = await toolNames(spectatorPage);
    expect(spectatorTools).toContain("read_canvas_drafts");
    expect(spectatorTools).not.toContain("apply_canvas_transaction");
    expect(spectatorTools).not.toContain("finish_canvas_draft");

    const initial = await authoritativeState(page);
    expect(initial.objects).toEqual([]);
    expect(initial.diagrams).toEqual([]);
    const baselineRoomRevision = initial.room.roomRevision;

    const first = await callTool<DraftedResult>(page, "apply_canvas_transaction", {
      operations: cumulativeOperations(2),
      delivery: { mode: "draft" },
      intent: "Progressively show a coherent request-to-storage architecture before committing it.",
      summary: "Stage browser and gateway",
    });
    expect(first).toMatchObject({ outcome: "drafted", draftRevision: 1, baselineRoomRevision });
    expect(first.draft.previewObjects).toHaveLength(3);
    await expectDraftProjection(viewerPage, { draftId: first.draftId, revision: 1, objectCount: 3 });
    await page.waitForTimeout(450);

    const second = await callTool<DraftedResult>(page, "apply_canvas_transaction", {
      operations: cumulativeOperations(4),
      delivery: { mode: "draft", draftId: first.draftId, expectedDraftRevision: 1 },
      intent: "Progressively show a coherent request-to-storage architecture before committing it.",
      summary: "Add the room API and event queue",
    });
    expect(second).toMatchObject({ outcome: "drafted", draftId: first.draftId, draftRevision: 2 });
    for (const [temporaryReference, candidateId] of Object.entries(first.temporaryReferences)) {
      expect(second.temporaryReferences[temporaryReference]).toBe(candidateId);
    }
    await expectDraftProjection(viewerPage, { draftId: first.draftId, revision: 2, objectCount: 7 });
    await page.waitForTimeout(450);

    const third = await callTool<DraftedResult>(page, "apply_canvas_transaction", {
      operations: cumulativeOperations(6),
      delivery: { mode: "draft", draftId: first.draftId, expectedDraftRevision: 2 },
      intent: "Progressively show a coherent request-to-storage architecture before committing it.",
      summary: "Complete the worker and database flow",
    });
    expect(third).toMatchObject({ outcome: "drafted", draftId: first.draftId, draftRevision: 3 });
    for (const [temporaryReference, candidateId] of Object.entries(second.temporaryReferences)) {
      expect(third.temporaryReferences[temporaryReference]).toBe(candidateId);
    }
    expect(Object.keys(third.temporaryReferences)).toHaveLength(12);
    await expectDraftProjection(viewerPage, { draftId: first.draftId, revision: 3, objectCount: 11 });
    await expectDraftProjection(spectatorPage, { draftId: first.draftId, revision: 3, objectCount: 11 });

    const spectatorRead = await callTool<ReadDraftResult>(spectatorPage, "read_canvas_drafts", {
      draftId: first.draftId,
    });
    expect(spectatorRead.draft).toMatchObject({ revision: 3, status: "active" });
    expect(spectatorRead.draft.previewObjects).toHaveLength(11);

    for (const currentPage of [page, viewerPage, spectatorPage]) {
      const state = await authoritativeState(currentPage);
      expect(state.room.roomRevision).toBe(baselineRoomRevision);
      expect(state.objects).toEqual([]);
      expect(state.diagrams).toEqual([]);
      const query = await callTool<QueryResult>(currentPage, "query_objects", {
        text: "Draft Demo",
        limit: 50,
      });
      expect(query).toMatchObject({ roomRevision: baselineRoomRevision, totalMatched: 0, objects: [] });
    }
    await page.waitForTimeout(700);

    await startTransitionSampler(viewerPage);
    const finish = await callTool<FinishDraftResult>(page, "finish_canvas_draft", {
      action: "commit",
      draftId: first.draftId,
      expectedDraftRevision: third.draftRevision,
    });
    expect(finish).toMatchObject({
      action: "commit",
      outcome: "applied",
      draftId: first.draftId,
    });
    await expect(viewerPage.getByTestId("semantic-canvas").locator("[data-object-id]")).toHaveCount(11, {
      timeout: 15_000,
    });
    await expect(viewerPage.locator("[data-agent-draft-object-id]")).toHaveCount(0);
    await expect(viewerPage.locator("[data-agent-draft-pill]")).toHaveCount(0);
    await page.waitForTimeout(500);
    const transition = await stopTransitionSampler(viewerPage);
    expect(transition.some((frame) => frame.authoritative === 11)).toBe(true);
    expect(transition.filter((frame) => frame.authoritative > 0).every((frame) => frame.authoritative === 11)).toBe(true);
    expect(transition.every((frame) => frame.draft === 11 || frame.authoritative === 11)).toBe(true);
    expect(transition.every((frame) => !(frame.authoritative > 0 && frame.draft > 0))).toBe(true);

    const final = await authoritativeState(page);
    const expectedObjectIds = [...NODE_REFS, ...CONNECTOR_REFS]
      .map((temporaryReference) => third.temporaryReferences[temporaryReference])
      .sort();
    expect(final.objects.map(({ id }) => id).sort()).toEqual(expectedObjectIds);
    expect(final.diagrams).toHaveLength(1);
    expect(final.diagrams[0]).toMatchObject({
      id: third.temporaryReferences[DIAGRAM_REF],
      memberObjectIds: NODE_REFS.map((temporaryReference) => third.temporaryReferences[temporaryReference]),
      connectorIds: CONNECTOR_REFS.map((temporaryReference) => third.temporaryReferences[temporaryReference]),
    });
    expect(new Set(finish.changedObjectIds)).toEqual(new Set(expectedObjectIds));
    expect(finish.changedDiagramIds).toEqual([third.temporaryReferences[DIAGRAM_REF]]);
    const drafts = await callTool<ReadDraftsResult>(page, "read_canvas_drafts", {});
    expect(drafts.drafts).toEqual([]);
    await expect(spectatorPage.getByTestId("semantic-canvas").locator("[data-object-id]")).toHaveCount(11);
    await expect(spectatorPage.locator("[data-agent-draft-object-id]")).toHaveCount(0);
    await page.waitForTimeout(700);
  } finally {
    await spectatorContext.close();
    await viewerContext.close();
    if (viewerVideo) {
      const output = testInfo.outputPath("agent-draft-demo.webm");
      await viewerVideo.saveAs(output);
      await testInfo.attach("agent-draft-demo", { path: output, contentType: "video/webm" });
    }
  }
});
