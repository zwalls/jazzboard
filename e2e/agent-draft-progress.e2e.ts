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

type ChoreographyFrame = {
  draft: boolean;
  x: number;
  y: number;
  phase: string;
  objectId: string;
  revision: number;
  at: number;
};

type ArtworkObjectFrame = {
  objectId: string;
  fingerprint: string;
  state: string;
  phase: string;
  progress: number;
  visibleParts: number;
};

type ArtworkFrame = {
  at: number;
  objects: ArtworkObjectFrame[];
};

const NODE_REFS = [
  "clients",
  "edge_gateway",
  "room_api",
  "presence",
  "guest_identity",
  "redis_state",
  "blob_assets",
  "webmcp_runtime",
  "agent_workspace",
  "telemetry",
] as const;
const CONNECTOR_REFS = [
  "clients_gateway",
  "gateway_room",
  "room_presence",
  "gateway_identity",
  "room_redis",
  "room_blob",
  "webmcp_room",
  "agent_webmcp",
  "identity_webmcp",
  "room_telemetry",
  "redis_telemetry",
] as const;
const DIAGRAM_REF = "jazzboard_system_architecture";

const CHOREOGRAPHY_MINIMUM_COMPRESSED_SEGMENT_MS = 40;
const CHOREOGRAPHY_SAMPLER_CADENCE_FACTOR = 5;
const CHOREOGRAPHY_POSITION_TOLERANCE_PX = 16;
const CHOREOGRAPHY_BOUNDARY_LIMIT_PX = 100;
const SINE_EASING_PEAK_RATE = Math.PI / 2;

/**
 * Upper screen-space rates for the shortest queue-compressed segments. The
 * choreography durations are calculated from screen distance, so live zoom is
 * already represented in these rates. The sampling factor accounts for the bot
 * and observer running in separate rAF loops plus recording backpressure on a
 * long queue compressed to the seven-second cap. It still rejects cross-board
 * teleports while allowing one observed frame to span several producer writes.
 */
const CHOREOGRAPHY_PHASE_SPEED_LIMITS: Readonly<Record<string, number>> = {
  travel: 760 * (120 / CHOREOGRAPHY_MINIMUM_COMPRESSED_SEGMENT_MS) * SINE_EASING_PEAK_RATE * CHOREOGRAPHY_SAMPLER_CADENCE_FACTOR,
  outline: 520 * (240 / CHOREOGRAPHY_MINIMUM_COMPRESSED_SEGMENT_MS) * CHOREOGRAPHY_SAMPLER_CADENCE_FACTOR,
  trace: 520 * (240 / CHOREOGRAPHY_MINIMUM_COMPRESSED_SEGMENT_MS) * CHOREOGRAPHY_SAMPLER_CADENCE_FACTOR,
  label: 360 * (180 / CHOREOGRAPHY_MINIMUM_COMPRESSED_SEGMENT_MS) * SINE_EASING_PEAK_RATE * CHOREOGRAPHY_SAMPLER_CADENCE_FACTOR,
  inspect: 300 * (260 / CHOREOGRAPHY_MINIMUM_COMPRESSED_SEGMENT_MS) * SINE_EASING_PEAK_RATE * CHOREOGRAPHY_SAMPLER_CADENCE_FACTOR,
};

function continuousChoreographyDistanceLimit(elapsedMs: number, phase: string): number {
  const fallback = CHOREOGRAPHY_PHASE_SPEED_LIMITS.travel!;
  const pixelsPerSecond = CHOREOGRAPHY_PHASE_SPEED_LIMITS[phase] ?? fallback;
  return pixelsPerSecond * elapsedMs / 1_000 + CHOREOGRAPHY_POSITION_TOLERANCE_PX;
}

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
    width: 190,
    height: 100,
  };
}

type ConnectorPortPlacement = {
  side: "left" | "right" | "top" | "bottom";
  position: number;
};

function connection(
  tempRef: typeof CONNECTOR_REFS[number],
  start: typeof NODE_REFS[number],
  end: typeof NODE_REFS[number],
  label: string,
  placement: {
    start: ConnectorPortPlacement;
    end: ConnectorPortPlacement;
    mode: "straight" | "elbow";
    elbowMidPoint?: number;
    labelPosition?: number;
  },
) {
  return {
    op: "connect",
    tempRef,
    start: { tempRef: start, port: { ...placement.start, exact: true } },
    end: { tempRef: end, port: { ...placement.end, exact: true } },
    direction: "end",
    label,
    color: "black",
    routing: {
      mode: placement.mode,
      ...(placement.mode === "elbow" ? { elbowMidPoint: placement.elbowMidPoint ?? 0.5 } : {}),
      labelPosition: placement.labelPosition ?? 0.5,
    },
  };
}

const NODES = [
  node("clients", "Web + Mobile Clients", "component", 70, 120),
  node("edge_gateway", "Edge Session Gateway", "service", 400, 120),
  node("room_api", "Room Command API", "service", 730, 330),
  node("presence", "Presence Fanout", "service", 730, 120),
  node("guest_identity", "Guest Identity", "service", 400, 330),
  node("redis_state", "Redis Room State", "component", 1_060, 330),
  node("blob_assets", "Vercel Blob Assets", "component", 1_060, 120),
  node("webmcp_runtime", "WebMCP Tool Runtime", "service", 400, 540),
  node("agent_workspace", "Agent Workspace", "component", 70, 540),
  node("telemetry", "Telemetry + Review", "component", 730, 540),
] as const;

const CONNECTORS = [
  connection("clients_gateway", "clients", "edge_gateway", "HTTPS / WS", {
    start: { side: "right", position: 0.5 }, end: { side: "left", position: 0.5 }, mode: "straight",
  }),
  connection("gateway_room", "edge_gateway", "room_api", "commands", {
    start: { side: "right", position: 0.68 }, end: { side: "left", position: 0.28 }, mode: "elbow", labelPosition: 0.35,
  }),
  connection("room_presence", "room_api", "presence", "realtime deltas", {
    start: { side: "top", position: 0.65 }, end: { side: "bottom", position: 0.65 }, mode: "straight",
  }),
  connection("gateway_identity", "edge_gateway", "guest_identity", "authorize", {
    start: { side: "bottom", position: 0.35 }, end: { side: "top", position: 0.35 }, mode: "straight",
  }),
  connection("room_redis", "room_api", "redis_state", "CAS", {
    start: { side: "right", position: 0.72 }, end: { side: "left", position: 0.72 }, mode: "straight",
  }),
  connection("room_blob", "room_api", "blob_assets", "asset refs", {
    start: { side: "right", position: 0.15 }, end: { side: "left", position: 0.75 }, mode: "elbow", labelPosition: 0.7,
  }),
  connection("webmcp_room", "webmcp_runtime", "room_api", "semantic", {
    start: { side: "right", position: 0.25 }, end: { side: "left", position: 0.75 }, mode: "elbow", labelPosition: 0.7,
  }),
  connection("agent_webmcp", "agent_workspace", "webmcp_runtime", "tool calls", {
    start: { side: "right", position: 0.5 }, end: { side: "left", position: 0.5 }, mode: "straight",
  }),
  connection("identity_webmcp", "webmcp_runtime", "guest_identity", "session claims", {
    start: { side: "top", position: 0.35 }, end: { side: "bottom", position: 0.35 }, mode: "straight",
  }),
  connection("room_telemetry", "room_api", "telemetry", "activity", {
    start: { side: "bottom", position: 0.65 }, end: { side: "top", position: 0.65 }, mode: "straight",
  }),
  connection("redis_telemetry", "redis_state", "telemetry", "snapshots", {
    start: { side: "bottom", position: 0.35 }, end: { side: "right", position: 0.75 }, mode: "elbow", elbowMidPoint: 0.55, labelPosition: 0.6,
  }),
] as const;

const DRAFT_STAGES = {
  core: { nodeCount: 4, connectorCount: 3 },
  persistence: { nodeCount: 7, connectorCount: 6 },
  complete: { nodeCount: 10, connectorCount: 11 },
} as const;

function cumulativeOperations(stage: keyof typeof DRAFT_STAGES) {
  const { nodeCount, connectorCount } = DRAFT_STAGES[stage];
  const nodes = NODES.slice(0, nodeCount);
  const connectors = CONNECTORS.slice(0, connectorCount);
  return [
    ...nodes,
    ...connectors,
    {
      op: "create_diagram",
      tempRef: DIAGRAM_REF,
      title: "Jazzboard agent-native collaboration architecture",
      description: "The multi-branch client, identity, command, presence, persistence, media, WebMCP, agent, and observability architecture behind Jazzboard.",
      diagramType: "architecture",
      category: "collaborative-canvas-platform",
      tags: ["jazzboard", "webmcp", "realtime", "agents", "multiplayer"],
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
    const sample = (timestamp: number) => {
      const canvas = document.querySelector('[data-testid="semantic-canvas"]');
      frames.push({
        authoritative: canvas?.querySelectorAll("[data-object-id]").length ?? 0,
        draft: document.querySelectorAll("[data-agent-draft-object-id]").length,
        at: timestamp,
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

async function startChoreographySampler(page: Page, participantId: string): Promise<void> {
  await page.evaluate((targetParticipantId) => {
    const frames: ChoreographyFrame[] = [];
    const browserWindow = window as Window & {
      __agentDraftChoreography?: { frames: ChoreographyFrame[]; animationFrame: number };
    };
    const sample = (timestamp: number) => {
      const marker = document.querySelector<HTMLElement>(
        `[data-testid="agent-cursor-${CSS.escape(targetParticipantId)}"]`,
      );
      if (marker) {
        const bounds = marker.getBoundingClientRect();
        frames.push({
          draft: marker.dataset.agentDraftChoreography === "true",
          x: bounds.x,
          y: bounds.y,
          phase: marker.dataset.agentDraftChoreographyPhase ?? "",
          objectId: marker.dataset.agentDraftChoreographyObjectId ?? "",
          revision: Number(marker.dataset.agentDraftChoreographyRevision ?? 0),
          at: timestamp,
        });
      }
      if (browserWindow.__agentDraftChoreography) {
        browserWindow.__agentDraftChoreography.animationFrame = requestAnimationFrame(sample);
      }
    };
    browserWindow.__agentDraftChoreography = { frames, animationFrame: requestAnimationFrame(sample) };
  }, participantId);
}

async function stopChoreographySampler(page: Page): Promise<ChoreographyFrame[]> {
  return page.evaluate(() => {
    const browserWindow = window as Window & {
      __agentDraftChoreography?: { frames: ChoreographyFrame[]; animationFrame: number };
    };
    const state = browserWindow.__agentDraftChoreography;
    if (!state) return [];
    cancelAnimationFrame(state.animationFrame);
    delete browserWindow.__agentDraftChoreography;
    return state.frames;
  });
}

async function startArtworkSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: ArtworkFrame[] = [];
    const browserWindow = window as Window & {
      __agentDraftArtwork?: { frames: ArtworkFrame[]; animationFrame: number };
    };
    const sample = (timestamp: number) => {
      const objects = [...document.querySelectorAll<SVGGElement>("[data-agent-draft-object-id]")]
        .map((element) => ({
          objectId: element.dataset.agentDraftObjectId ?? "",
          fingerprint: element.dataset.agentDraftRevealFingerprint ?? "",
          state: element.dataset.agentDraftRevealState ?? "",
          phase: element.dataset.agentDraftRevealPhase ?? "",
          progress: Number(element.style.getPropertyValue("--agent-draft-reveal-progress") || 0),
          visibleParts: [...element.querySelectorAll<SVGElement>("[data-agent-draft-reveal-part]")]
            .filter((part) => Number.parseFloat(getComputedStyle(part).opacity || "1") > 0.01)
            .length,
        }));
      frames.push({ at: timestamp, objects });
      if (browserWindow.__agentDraftArtwork) {
        browserWindow.__agentDraftArtwork.animationFrame = requestAnimationFrame(sample);
      }
    };
    browserWindow.__agentDraftArtwork = { frames, animationFrame: requestAnimationFrame(sample) };
  });
}

async function stopArtworkSampler(page: Page): Promise<ArtworkFrame[]> {
  return page.evaluate(() => {
    const browserWindow = window as Window & {
      __agentDraftArtwork?: { frames: ArtworkFrame[]; animationFrame: number };
    };
    const state = browserWindow.__agentDraftArtwork;
    if (!state) return [];
    cancelAnimationFrame(state.animationFrame);
    delete browserWindow.__agentDraftArtwork;
    return state.frames;
  });
}

test("progressively previews a real WebMCP draft and commits it atomically", async ({ browser, page }, testInfo) => {
  test.setTimeout(90_000);
  const configuredBaseUrl = testInfo.project.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("Agent draft progress E2E requires Playwright use.baseURL.");
  }

  const host = await createRoomViaApi(
    page.request,
    "Architecture QA",
    "Jazzboard System Architecture — WebMCP Regression",
  );
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

    const viewerMutationRequests: string[] = [];
    const roomApiPrefix = `/api/rooms/${encodeURIComponent(host.room.id)}`;
    viewerPage.on("request", (request) => {
      if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return;
      const pathname = new URL(request.url()).pathname;
      if (pathname === roomApiPrefix || pathname.startsWith(`${roomApiPrefix}/`)) {
        viewerMutationRequests.push(`${request.method()} ${pathname}`);
      }
    });
    await startChoreographySampler(viewerPage, host.participantId);
    await startArtworkSampler(viewerPage);

    const initial = await authoritativeState(page);
    expect(initial.objects).toEqual([]);
    expect(initial.diagrams).toEqual([]);
    const baselineRoomRevision = initial.room.roomRevision;

    const first = await callTool<DraftedResult>(page, "apply_canvas_transaction", {
      operations: cumulativeOperations("core"),
      delivery: { mode: "draft" },
      intent: "Progressively build Jazzboard's multi-branch agent-native collaboration architecture before one atomic commit.",
      summary: "Stage clients, commands, and presence",
    });
    expect(first).toMatchObject({ outcome: "drafted", draftRevision: 1, baselineRoomRevision });
    expect(first.draft.previewObjects).toHaveLength(7);
    await expectDraftProjection(viewerPage, { draftId: first.draftId, revision: 1, objectCount: 7 });
    const agentNameTag = viewerPage
      .getByTestId(`agent-cursor-${host.participantId}`)
      .locator('[data-agent-cursor-label="true"]');
    await expect(agentNameTag).toHaveText("Architecture QA");
    const agentNameTagStyle = await agentNameTag.evaluate((element) => {
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
    const draftPillName = viewerPage.locator(`[data-agent-draft-pill="${first.draftId}"] strong`);
    await expect(draftPillName).toHaveText("Architecture QA");
    expect(await draftPillName.evaluate((element) => (
      getComputedStyle(element.parentElement!, "::before").content
    ))).toBe("none");
    await page.waitForTimeout(450);

    const second = await callTool<DraftedResult>(page, "apply_canvas_transaction", {
      operations: cumulativeOperations("persistence"),
      delivery: { mode: "draft", draftId: first.draftId, expectedDraftRevision: 1 },
      intent: "Progressively build Jazzboard's multi-branch agent-native collaboration architecture before one atomic commit.",
      summary: "Add identity, revision-safe state, and media storage",
    });
    expect(second).toMatchObject({ outcome: "drafted", draftId: first.draftId, draftRevision: 2 });
    for (const [temporaryReference, candidateId] of Object.entries(first.temporaryReferences)) {
      expect(second.temporaryReferences[temporaryReference]).toBe(candidateId);
    }
    await expectDraftProjection(viewerPage, { draftId: first.draftId, revision: 2, objectCount: 13 });
    await page.waitForTimeout(450);

    const third = await callTool<DraftedResult>(page, "apply_canvas_transaction", {
      operations: cumulativeOperations("complete"),
      delivery: { mode: "draft", draftId: first.draftId, expectedDraftRevision: 2 },
      intent: "Progressively build Jazzboard's multi-branch agent-native collaboration architecture before one atomic commit.",
      summary: "Complete WebMCP, agent workspace, and observability paths",
    });
    expect(third).toMatchObject({ outcome: "drafted", draftId: first.draftId, draftRevision: 3 });
    for (const [temporaryReference, candidateId] of Object.entries(second.temporaryReferences)) {
      expect(third.temporaryReferences[temporaryReference]).toBe(candidateId);
    }
    expect(Object.keys(third.temporaryReferences)).toHaveLength(22);
    await expectDraftProjection(viewerPage, { draftId: first.draftId, revision: 3, objectCount: 21 });
    await expectDraftProjection(spectatorPage, { draftId: first.draftId, revision: 3, objectCount: 21 });

    const spectatorRead = await callTool<ReadDraftResult>(spectatorPage, "read_canvas_drafts", {
      draftId: first.draftId,
    });
    expect(spectatorRead.draft).toMatchObject({ revision: 3, status: "active" });
    expect(spectatorRead.draft.previewObjects).toHaveLength(21);

    await expect.poll(
      () => viewerPage!.locator('[data-agent-draft-choreography="true"]').getAttribute("data-agent-draft-choreography-phase"),
      { timeout: 12_000, intervals: [80, 120, 160] },
    ).toBe("trace");
    await viewerPage.waitForTimeout(320);

    for (const currentPage of [page, viewerPage, spectatorPage]) {
      const state = await authoritativeState(currentPage);
      expect(state.room.roomRevision).toBe(baselineRoomRevision);
      expect(state.objects).toEqual([]);
      expect(state.diagrams).toEqual([]);
      const query = await callTool<QueryResult>(currentPage, "query_objects", {
        text: "Room Command API",
        limit: 50,
      });
      expect(query).toMatchObject({ roomRevision: baselineRoomRevision, totalMatched: 0, objects: [] });
    }
    await page.waitForTimeout(700);

    const latePage = await spectatorContext.newPage();
    try {
      await installWebMcpShim(latePage);
      await latePage.goto(`/room/${encodeURIComponent(host.room.id)}`);
      await expect(latePage.getByTestId("semantic-canvas")).toBeVisible({ timeout: 20_000 });
      await expect(latePage.locator("[data-agent-draft-object-id]")).toHaveCount(21, { timeout: 15_000 });
      await expect(latePage.locator('[data-agent-draft-reveal-state="complete"]')).toHaveCount(21);
      await latePage.waitForTimeout(250);
      await expect(latePage.locator('[data-agent-draft-reveal-state="pending"]')).toHaveCount(0);
      await expect(latePage.locator('[data-agent-draft-reveal-state="active"]')).toHaveCount(0);
    } finally {
      await latePage.close();
    }

    // Let the richer multi-branch graph finish its visible construction before
    // committing, so the recording proves every draft object is actually
    // traced instead of cutting the choreography short.
    await expect(viewerPage.locator('[data-agent-draft-reveal-state="complete"]')).toHaveCount(21, {
      timeout: 20_000,
    });
    await viewerPage.waitForTimeout(350);

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
    await expect(viewerPage.getByTestId("semantic-canvas").locator("[data-object-id]")).toHaveCount(21, {
      timeout: 15_000,
    });
    await expect(viewerPage.locator("[data-agent-draft-object-id]")).toHaveCount(0);
    await expect(viewerPage.locator("[data-agent-draft-pill]")).toHaveCount(0);
    await expect(viewerPage.locator('[data-agent-draft-choreography="true"]')).toHaveCount(0);
    await page.waitForTimeout(500);
    const choreography = await stopChoreographySampler(viewerPage);
    const artwork = await stopArtworkSampler(viewerPage);
    expect(choreography.length).toBeGreaterThan(20);
    expect(new Set(choreography.map((frame) => `${Math.round(frame.x)},${Math.round(frame.y)}`)).size).toBeGreaterThan(8);
    expect(choreography.some((frame) => frame.phase === "outline")).toBe(true);
    expect(choreography.some((frame) => frame.phase === "trace")).toBe(true);
    expect(choreography.some((frame) => !frame.draft)).toBe(true);
    const sampledDraftRevisions = [...new Set(
      choreography.filter((frame) => frame.draft).map((frame) => frame.revision),
    )];
    expect(sampledDraftRevisions).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(sampledDraftRevisions.every((revision) => revision >= 1 && revision <= 4)).toBe(true);
    const artworkObjects = artwork.flatMap((frame) => frame.objects);
    const firstVisibleArtworkFrame = artwork.find((frame) => frame.objects.length > 0);
    expect(firstVisibleArtworkFrame?.objects).toHaveLength(7);
    expect(
      firstVisibleArtworkFrame?.objects.every((object) => object.state !== "complete"),
      JSON.stringify(firstVisibleArtworkFrame),
    ).toBe(true);
    const firstRevisionObjectIds = [
      "clients",
      "edge_gateway",
      "room_api",
      "presence",
      "clients_gateway",
      "gateway_room",
      "room_presence",
    ]
      .map((temporaryReference) => first.temporaryReferences[temporaryReference]!);
    for (const objectId of firstRevisionObjectIds) {
      const objectFrames = artwork
        .flatMap((frame) => frame.objects)
        .filter((object) => object.objectId === objectId);
      const pendingIndex = objectFrames.findIndex((object) => (
        object.state === "pending" && object.visibleParts === 0
      ));
      const activeIndex = objectFrames.findIndex((object) => (
        object.state === "active" && object.progress > 0 && object.progress < 1
      ));
      const completeIndex = objectFrames.findIndex((object) => object.state === "complete");
      expect(pendingIndex, JSON.stringify(objectFrames)).toBeGreaterThanOrEqual(0);
      expect(activeIndex, JSON.stringify(objectFrames)).toBeGreaterThan(pendingIndex);
      expect(completeIndex, JSON.stringify(objectFrames)).toBeGreaterThan(activeIndex);
    }
    expect(artworkObjects.some((object) => object.state === "pending" && object.visibleParts === 0)).toBe(true);
    expect(artworkObjects.some((object) =>
      object.state === "active" &&
      object.progress > 0 &&
      object.progress < 1 &&
      object.visibleParts > 0,
    )).toBe(true);
    const completedFingerprints = new Set<string>();
    for (const frame of artwork) {
      for (const object of frame.objects) {
        const key = `${object.objectId}:${object.fingerprint}`;
        if (completedFingerprints.has(key)) {
          expect(object.state, JSON.stringify({ frame, object })).toBe("complete");
        }
        if (object.state === "complete") completedFingerprints.add(key);
      }
    }
    expect(completedFingerprints.size).toBeGreaterThan(2);
    for (let index = 1; index < choreography.length; index += 1) {
      const previous = choreography[index - 1]!;
      const current = choreography[index]!;
      const elapsed = current.at - previous.at;
      if (elapsed <= 0 || elapsed > 100) continue;
      const crossedPlaybackBoundary = (
        previous.draft !== current.draft ||
        previous.revision !== current.revision ||
        previous.objectId !== current.objectId ||
        previous.phase !== current.phase
      );
      const travelled = Math.hypot(current.x - previous.x, current.y - previous.y);
      const maximumTravel = crossedPlaybackBoundary
        ? CHOREOGRAPHY_BOUNDARY_LIMIT_PX
        : continuousChoreographyDistanceLimit(elapsed, current.phase);
      // Inside one segment, enforce the actual maximum screen-space rate after
      // the shortest legal queue compression and independent-rAF cadence. At a
      // semantic or phase boundary, retain the stricter teleport guard that
      // caught the original section snap.
      expect(
        travelled,
        JSON.stringify({ previous, current, elapsed, travelled, maximumTravel, crossedPlaybackBoundary }),
      ).toBeLessThanOrEqual(maximumTravel);
    }
    expect(viewerMutationRequests).toEqual([]);
    const transition = await stopTransitionSampler(viewerPage);
    expect(transition.some((frame) => frame.authoritative === 21)).toBe(true);
    expect(transition.filter((frame) => frame.authoritative > 0).every((frame) => frame.authoritative === 21)).toBe(true);
    expect(transition.every((frame) => frame.draft === 21 || frame.authoritative === 21)).toBe(true);
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
    const analysis = await callTool<{
      report: {
        status: "pass" | "warning" | "fail";
        findings: Array<{ code: string }>;
        metrics: {
          memberObjectCount: number;
          connectorCount: number;
          findingCount: number;
        };
      };
    }>(page, "analyze_diagram_layout", {
      diagramId: final.diagrams[0]!.id,
      expectedDiagramRevision: final.diagrams[0]!.revision,
    });
    expect(analysis.report).toMatchObject({
      status: "pass",
      findings: [],
      metrics: {
        memberObjectCount: NODE_REFS.length,
        connectorCount: CONNECTOR_REFS.length,
        findingCount: 0,
      },
    });
    expect(new Set(finish.changedObjectIds)).toEqual(new Set(expectedObjectIds));
    expect(finish.changedDiagramIds).toEqual([third.temporaryReferences[DIAGRAM_REF]]);
    const drafts = await callTool<ReadDraftsResult>(page, "read_canvas_drafts", {});
    expect(drafts.drafts).toEqual([]);
    await expect(spectatorPage.getByTestId("semantic-canvas").locator("[data-object-id]")).toHaveCount(21);
    await expect(spectatorPage.locator("[data-agent-draft-object-id]")).toHaveCount(0);
    await page.waitForTimeout(700);
  } finally {
    await spectatorContext.close();
    await viewerContext.close();
    if (viewerVideo) {
      const output = testInfo.outputPath("jazzboard-system-architecture-webmcp.webm");
      await viewerVideo.saveAs(output);
      await testInfo.attach("jazzboard-system-architecture-webmcp", { path: output, contentType: "video/webm" });
    }
  }
});
