/// <reference types="webmcp-types" />

import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { getRoom } from "./helpers";

const LANDING_WEBMCP_TOOL_NAMES = [
  "create_room",
  "join_room",
  "list_recent_rooms",
  "open_recent_room",
  "remove_recent_room",
] as const;

const SHARED_ROOM_READ_TOOL_NAMES = [
  "get_canvas_capabilities",
  "read_room_state",
  "read_selection",
  "read_collaboration_state",
  "query_objects",
  "read_neighborhood",
  "find_diagrams",
  "read_diagram",
  "describe_diagram",
  "analyze_diagram_layout",
  "list_activity",
  "read_activity",
  "export_canvas_artifact",
  "list_agent_edit_proposals",
  "read_agent_edit_proposal",
  "read_canvas_drafts",
  "inspect_canvas_scope",
] as const;

const PARTICIPANT_ONLY_READ_TOOL_NAMES = [
  "create_diagram_template",
  "list_agent_messages",
] as const;

// Legacy rendering does not mutate shared room state, but it intentionally
// paints a temporary local surface and remains participant-only. The unified
// inspect_canvas_scope entry point is shared and explicitly read-only.
const PARTICIPANT_LOCAL_PREVIEW_TOOL_NAMES = ["render_canvas_preview"] as const;
const AUTHORIZED_LOCAL_DOWNLOAD_TOOL_NAMES = ["export_canvas_png"] as const;

const ROOM_MUTATION_TOOL_NAMES = [
  "create_text",
  "create_shape",
  "create_node",
  "add_image",
  "create_drawing",
  "create_path",
  "create_polygon",
  "draw_connection",
  "update_object",
  "move_objects",
  "group_objects",
  "delete_objects",
  "focus_viewport",
  "follow_participant",
  "stop_following",
  "start_spotlight",
  "request_spotlight",
  "stop_spotlight",
  "join_spotlight",
  "leave_spotlight",
  "approve_spotlight_handoff",
  "dismiss_spotlight_request",
  "leave_room",
  "apply_canvas_transaction",
  "finish_canvas_draft",
  "layout_objects",
  "create_diagram",
  "edit_diagram",
  "revert_activity",
  "instantiate_diagram_template",
  "enable_agent_review",
  "claim_agent_message",
  "reply_to_agent_message",
] as const;

const PARTICIPANT_ROOM_TOOL_NAMES = [
  ...SHARED_ROOM_READ_TOOL_NAMES,
  ...PARTICIPANT_ONLY_READ_TOOL_NAMES,
  ...PARTICIPANT_LOCAL_PREVIEW_TOOL_NAMES,
  ...AUTHORIZED_LOCAL_DOWNLOAD_TOOL_NAMES,
  ...ROOM_MUTATION_TOOL_NAMES,
] as const;
const SPECTATOR_ROOM_TOOL_NAMES = [
  ...SHARED_ROOM_READ_TOOL_NAMES,
  ...AUTHORIZED_LOCAL_DOWNLOAD_TOOL_NAMES,
] as const;

const WEBMCP_TEXT = "Written through browser WebMCP";
const REJECTED_LABEL = "MUST_NOT_COMMIT_E2E";
const LONG_CONNECTOR_LABEL =
  "Authorize the signed guest session before loading protected room state";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z7DlPwMewIRPcvgoAADJ3wLCTMjowgAAAABJRU5ErkJggg==",
  "base64",
);

type WebMcpToolResult<T> =
  | { ok: true; tool: string; data: T }
  | { ok: false; tool: string; error: { code: string; message: string; details?: unknown } };

type ToolMetadata = {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
};

type LandingRoomData = {
  room: { id: string; code: string; title: string };
  role: "participant" | "spectator";
  path: string;
};

type RecentRoomsData = {
  scope: "current_browser_and_signed_session";
  rooms: Array<{ roomId: string; code: string; title: string; role: string }>;
};

type CanvasPointData = { x: number; y: number };

type ConnectorEndpointData = CanvasPointData & {
  objectId: string | null;
  normalizedAnchor?: CanvasPointData | null;
  isPrecise?: boolean | null;
  isExact?: boolean | null;
  snap?: "center" | "edge-point" | "edge" | "none" | null;
};

type ConnectorRoutingData = {
  mode: "auto" | "straight" | "curved" | "elbow";
  kind: "straight" | "curved" | "elbow";
  bend: number;
  elbowMidPoint: number;
  labelPosition: number;
};

type CanvasObjectData = {
  id: string;
  kind: string;
  revision: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  content?: string;
  nodeType?: string | null;
  start?: ConnectorEndpointData;
  end?: ConnectorEndpointData;
  routing?: ConnectorRoutingData;
};

type DiagramData = {
  id: string;
  title: string;
  description: string;
  diagramType: string;
  category: string | null;
  tags: string[];
  memberObjectIds: string[];
  connectorIds: string[];
  bounds: { x: number; y: number; width: number; height: number };
  revision: number;
  createdBy: { participantId: string; kind: "human" | "agent" };
  lastEditedBy: { participantId: string; kind: "human" | "agent" };
};

type TransactionData = {
  roomRevision: number;
  temporaryReferences: Record<string, string>;
  changedObjectIds: string[];
  changedDiagramIds: string[];
  positions?: Array<{ objectId: string; x: number; y: number }>;
  objects: CanvasObjectData[];
  diagrams: DiagramData[];
};

type CanvasPreviewData = {
  previewId: string;
  presentation: "live_canvas";
  visualInspectionStatus: "not_performed";
  geometryQualityStatus: "pass" | "warning" | "fail" | "unknown";
  nextStep: string;
  screenshotClip: {
    coordinateSpace: "viewport-css-pixels";
    x: number;
    y: number;
    width: number;
    height: number;
  };
  expiresAt: number;
  mimeType: "image/png";
  width: number;
  height: number;
  byteLength: number;
  scope: { kind: "diagram"; diagramId: string; expectedRevision: number };
  sourceRevisions: {
    roomRevision: number;
    diagramRevision: number;
    objects: Array<{ objectId: string; revision: number }>;
  };
  targets: Array<{ objectId: string; revision: number }>;
};

type CanvasInspectionData = {
  previewId: string;
  presentation: "live_canvas";
  visualInspectionStatus: "not_performed";
  geometryQualityStatus: "pass" | "warning" | "fail" | "unknown";
  screenshotClip: CanvasPreviewData["screenshotClip"];
  sourceRevisions: {
    roomRevision: number;
    diagramRevision: number | null;
    objects: Array<{ objectId: string; revision: number }>;
    visualContributors: Array<{ objectId: string; revision: number }>;
  };
  targets: Array<{ objectId: string; revision: number }>;
  semanticEvidence: {
    schemaVersion: 1;
    objects: Array<{
      objectId: string;
      revision: number;
      kind: string;
      inRequestedScope: boolean;
      semantic: { kind: string; segmentCount?: number; closed?: boolean };
    }>;
    intersections: { totalCount: number; truncated: boolean };
    occlusions: { totalCount: number; truncated: boolean };
    coverage: {
      geometry: "complete" | "partial";
      unsupported: Array<{ objectId?: string; analysis: string }>;
      omittedUnsupportedCount: number;
    };
  };
};

type CanvasCapabilitiesData = {
  schemaVersion: 1;
  role: "participant" | "spectator";
  authority: {
    currentPageToolRegistryIsAuthoritative: true;
    roleCanMutateCanvas: boolean;
  };
  coordinateSystem: {
    unit: "canvas-unit";
    xDirection: "right";
    yDirection: "down";
    rotation: { unit: "radian"; positiveDirectionOnScreen: "clockwise" };
    authoredPointSpaces: {
      createDrawingPathAndPolygonInput: "absolute-canvas";
      persistedAndPatchDrawingPoints: "object-local-canvas-units";
      persistedAndPatchPathAndPolygonPoints: "normalized-object-local-0-to-1";
    };
  };
  paintOrder: { field: "zIndex"; higherValue: "front" };
  primitives: {
    path: { supported: true; segments: ["line", "quadratic", "cubic"] };
    polygon: { supported: true; representation: "closed-path" };
  };
  inspection: { preferredTool: "inspect_canvas_scope" };
};

type ReadDiagramData = {
  roomRevision: number;
  diagram: DiagramData;
  objects: CanvasObjectData[];
  connectors: CanvasObjectData[];
};

type QueryData = {
  roomRevision: number;
  totalMatched: number;
  truncated: boolean;
  objects: CanvasObjectData[];
};

type NeighborhoodData = {
  roomRevision: number;
  rootObjectIds: string[];
  missingObjectIds: string[];
  depthReached: number;
  truncated: boolean;
  objects: CanvasObjectData[];
  connectors: CanvasObjectData[];
  diagrams: DiagramData[];
};

type LayoutData = {
  roomRevision: number;
  changedObjectIds: string[];
  changedDiagramIds: string[];
  positions: Array<{ objectId: string; x: number; y: number }>;
  diagrams: DiagramData[];
};

type CreateObjectData = {
  changedObjectIds: string[];
  objects: CanvasObjectData[];
};

type ReadRoomData = {
  room: { id: string; roomRevision: number };
  objects: CanvasObjectData[];
  participants: Array<{ participantId: string; role: string; agentActive: boolean }>;
};

async function installWebMcpShim(page: Page) {
  await page.addInitScript(() => {
    const tools = new Map<string, WebMCP.ModelContextTool>();
    const browserWindow = window as Window & {
      __jazzboardWebMcpTools?: Map<string, WebMCP.ModelContextTool>;
    };
    browserWindow.__jazzboardWebMcpTools = tools;

    const modelContext = new EventTarget() as WebMCP.ModelContext;
    modelContext.ontoolchange = null;
    modelContext.registerTool = async (tool, options) => {
      tools.set(tool.name, tool);
      options?.signal?.addEventListener(
        "abort",
        () => {
          if (tools.get(tool.name) === tool) tools.delete(tool.name);
        },
        { once: true },
      );
    };
    modelContext.getTools = async () =>
      [...tools.values()].map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        window,
        origin: window.location.origin,
        annotations: tool.annotations,
      }));

    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: modelContext,
    });
  });
}

async function registeredToolMetadata(page: Page): Promise<ToolMetadata[]> {
  return page.evaluate(() => {
    const tools = (window as Window & {
      __jazzboardWebMcpTools?: Map<string, WebMCP.ModelContextTool>;
    }).__jazzboardWebMcpTools;
    return [...(tools?.values() ?? [])]
      .map((tool) => ({ name: tool.name, annotations: tool.annotations }))
      .sort((left, right) => left.name.localeCompare(right.name));
  });
}

async function registeredToolNames(page: Page): Promise<string[]> {
  return (await registeredToolMetadata(page)).map((tool) => tool.name);
}

async function expectRegisteredSurface(
  page: Page,
  expectedNames: readonly string[],
): Promise<ToolMetadata[]> {
  const expected = [...expectedNames].sort();
  await expect.poll(() => registeredToolNames(page), { timeout: 15_000 }).toEqual(expected);
  return registeredToolMetadata(page);
}

async function callWebMcpTool<T>(page: Page, name: string, input: Record<string, unknown>) {
  return page.evaluate(
    async ({ toolName, toolInput }) => {
      const tools = (window as Window & {
        __jazzboardWebMcpTools?: Map<string, WebMCP.ModelContextTool>;
      }).__jazzboardWebMcpTools;
      const tool = tools?.get(toolName);
      if (!tool) throw new Error(`WebMCP tool ${toolName} is not registered.`);
      return tool.execute(toolInput, { signal: new AbortController().signal });
    },
    { toolName: name, toolInput: input },
  ) as Promise<WebMcpToolResult<T>>;
}

async function callNavigationTool<T>(
  page: Page,
  name: string,
  input: Record<string, unknown>,
  expectedUrl: RegExp,
): Promise<WebMcpToolResult<T>> {
  const navigation = page.waitForURL(expectedUrl, { timeout: 20_000 });
  const result = await callWebMcpTool<T>(page, name, input);
  await navigation;
  return result;
}

function successData<T>(result: WebMcpToolResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `${result.tool} failed: ${result.error.code} ${result.error.message} ${JSON.stringify(result.error.details ?? {})}`,
    );
  }
  return result.data;
}

function requireConnector(
  objects: readonly CanvasObjectData[],
  objectId: string,
): CanvasObjectData & {
  start: ConnectorEndpointData;
  end: ConnectorEndpointData;
  routing: ConnectorRoutingData;
} {
  const object = objects.find((candidate) => candidate.id === objectId);
  expect(object).toMatchObject({ id: objectId, kind: "connector" });
  if (!object?.start || !object.end || !object.routing) {
    throw new Error(`Connector ${objectId} is missing canonical endpoint or routing metadata.`);
  }
  return object as CanvasObjectData & {
    start: ConnectorEndpointData;
    end: ConnectorEndpointData;
    routing: ConnectorRoutingData;
  };
}

function connectorPortDirection(anchor: CanvasPointData): CanvasPointData {
  const candidates = [
    { direction: { x: 1, y: 0 }, distance: Math.abs(1 - anchor.x), order: 0 },
    { direction: { x: 0, y: 1 }, distance: Math.abs(1 - anchor.y), order: 1 },
    { direction: { x: -1, y: 0 }, distance: Math.abs(anchor.x), order: 2 },
    { direction: { x: 0, y: -1 }, distance: Math.abs(anchor.y), order: 3 },
  ];
  return candidates.sort(
    (left, right) => left.distance - right.distance || left.order - right.order,
  )[0].direction;
}

function elbowRoutePoints(connector: ReturnType<typeof requireConnector>): CanvasPointData[] {
  if (!connector.start.normalizedAnchor || !connector.end.normalizedAnchor) {
    throw new Error(`Elbow connector ${connector.id} is missing exact normalized anchors.`);
  }
  const startDirection = connectorPortDirection(connector.start.normalizedAnchor);
  const endDirection = connectorPortDirection(connector.end.normalizedAnchor);
  const startOut = {
    x: connector.start.x + startDirection.x * 36,
    y: connector.start.y + startDirection.y * 36,
  };
  const endOut = {
    x: connector.end.x + endDirection.x * 36,
    y: connector.end.y + endDirection.y * 36,
  };
  const startHorizontal = startDirection.x !== 0;
  const endHorizontal = endDirection.x !== 0;
  const points: CanvasPointData[] = [connector.start, startOut];
  if (startHorizontal && endHorizontal) {
    const laneX =
      startOut.x + (endOut.x - startOut.x) * connector.routing.elbowMidPoint;
    points.push({ x: laneX, y: startOut.y }, { x: laneX, y: endOut.y });
  } else if (!startHorizontal && !endHorizontal) {
    const laneY =
      startOut.y + (endOut.y - startOut.y) * connector.routing.elbowMidPoint;
    points.push({ x: startOut.x, y: laneY }, { x: endOut.x, y: laneY });
  } else if (startHorizontal) {
    points.push({ x: endOut.x, y: startOut.y });
  } else {
    points.push({ x: startOut.x, y: endOut.y });
  }
  points.push(endOut, connector.end);
  return points.filter(
    (point, index) =>
      index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y,
  );
}

function curvedRoutePoints(connector: ReturnType<typeof requireConnector>): CanvasPointData[] {
  const start = connector.start;
  const end = connector.end;
  const chordLength = Math.hypot(end.x - start.x, end.y - start.y);
  if (chordLength === 0 || Math.abs(connector.routing.bend) < 8) return [start, end];
  const unit = { x: (end.x - start.x) / chordLength, y: (end.y - start.y) / chordLength };
  const middle = {
    x: (start.x + end.x) / 2 - unit.y * connector.routing.bend,
    y: (start.y + end.y) / 2 + unit.x * connector.routing.bend,
  };
  const denominator =
    2 *
    (start.x * (end.y - middle.y) +
      end.x * (middle.y - start.y) +
      middle.x * (start.y - end.y));
  if (Math.abs(denominator) < Number.EPSILON) return [start, end];
  const startSquared = start.x * start.x + start.y * start.y;
  const endSquared = end.x * end.x + end.y * end.y;
  const middleSquared = middle.x * middle.x + middle.y * middle.y;
  const center = {
    x:
      (startSquared * (end.y - middle.y) +
        endSquared * (middle.y - start.y) +
        middleSquared * (start.y - end.y)) /
      denominator,
    y:
      (startSquared * (middle.x - end.x) +
        endSquared * (start.x - middle.x) +
        middleSquared * (end.x - start.x)) /
      denominator,
  };
  const normalizeAngle = (angle: number) => ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const middleAngle = Math.atan2(middle.y - center.y, middle.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const counterClockwiseSweep = normalizeAngle(endAngle - startAngle);
  const middleCounterClockwise = normalizeAngle(middleAngle - startAngle);
  const sweep =
    middleCounterClockwise <= counterClockwiseSweep
      ? counterClockwiseSweep
      : -(Math.PI * 2 - counterClockwiseSweep);
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  return Array.from({ length: 49 }, (_, index) => {
    if (index === 0) return start;
    if (index === 48) return end;
    const angle = startAngle + sweep * (index / 48);
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
  });
}

function canonicalRoutePoints(connector: ReturnType<typeof requireConnector>): CanvasPointData[] {
  if (connector.routing.kind === "elbow") return elbowRoutePoints(connector);
  if (connector.routing.kind === "curved") return curvedRoutePoints(connector);
  return [connector.start, connector.end];
}

function segmentIntersectsBounds(
  start: CanvasPointData,
  end: CanvasPointData,
  bounds: Pick<CanvasObjectData, "x" | "y" | "width" | "height">,
): boolean {
  let minimum = 0;
  let maximum = 1;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  for (const [p, q] of [
    [-dx, start.x - bounds.x],
    [dx, bounds.x + bounds.width - start.x],
    [-dy, start.y - bounds.y],
    [dy, bounds.y + bounds.height - start.y],
  ] as const) {
    if (Math.abs(p) < Number.EPSILON) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }
  return true;
}

function routeIntersectsBounds(
  points: readonly CanvasPointData[],
  bounds: Pick<CanvasObjectData, "x" | "y" | "width" | "height">,
): boolean {
  return points
    .slice(1)
    .some((point, index) => segmentIntersectsBounds(points[index], point, bounds));
}

type BrowserBounds = { x: number; y: number; width: number; height: number };

type RenderedConnectorData = {
  pathData: string;
  pathSegments: CanvasPointData[][];
  labelText: string;
  labelBounds: BrowserBounds;
  semanticLabelBounds: BrowserBounds;
};

type RenderedRouteKey = "auto" | "straight" | "curved" | "elbow";

function semanticCanvas(page: Page) {
  return page.locator('[data-canvas-renderer="jazzboard-semantic-v1"]');
}

function renderedObject(page: Page, objectId: string) {
  return semanticCanvas(page).locator(`[data-object-id="${objectId}"]`);
}

async function expectSemanticCanvas(page: Page): Promise<void> {
  const canvas = semanticCanvas(page);
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect(canvas).toHaveAttribute("data-canvas-renderer", "jazzboard-semantic-v1");
}

async function createRoomFromLanding(page: Page, displayName: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /Make room for every idea/i })).toBeVisible();
  await page.getByLabel("Your display name").fill(displayName);
  await page.getByRole("button", { name: "Create my Jazzboard" }).click();
  await expect(page).toHaveURL(/\/room\/room_[^/?#]+$/, { timeout: 20_000 });
  await expectSemanticCanvas(page);
  const roomId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "");
  return getRoom(page.request, roomId);
}

function expectRenderedConnectorParity(
  actual: RenderedConnectorData,
  expected: RenderedConnectorData,
  routeName: RenderedRouteKey,
): void {
  expect(actual.labelText, `${routeName} label text should match`).toBe(expected.labelText);
  expect(actual.pathData, `${routeName} should expose the same semantic SVG route`).toBe(
    expected.pathData,
  );
  const labelDeltas = (
    Object.keys(actual.semanticLabelBounds) as Array<keyof BrowserBounds>
  ).map((key) => Math.abs(actual.semanticLabelBounds[key] - expected.semanticLabelBounds[key]));
  expect(
    Math.max(...labelDeltas),
    `${routeName} label should occupy the same semantic canvas bounds`,
  ).toBeLessThanOrEqual(0.001);
}

async function renderedShapeBounds(page: Page, objectId: string): Promise<BrowserBounds> {
  const shape = renderedObject(page, objectId);
  await expect(shape).toBeVisible({ timeout: 15_000 });
  return shape.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  });
}

async function readRenderedConnector(
  page: Page,
  objectId: string,
  expectedLabel: string,
): Promise<RenderedConnectorData> {
  const shape = renderedObject(page, objectId);
  await expect(shape).toBeVisible({ timeout: 15_000 });
  await expect(shape).toHaveAttribute("data-object-kind", "connector");
  const overlay = page.locator(`[data-connector-overlay-id="${objectId}"]`);
  await expect(overlay.locator(".semantic-canvas-object__connector-label-text")).toContainText(expectedLabel, {
    timeout: 15_000,
  });
  return shape.evaluate((element, connectorId) => {
    const path = element.querySelector<SVGPathElement>(
      ".semantic-canvas-object__connector-path",
    );
    if (!path) {
      throw new Error(`Rendered connector ${element.getAttribute("data-object-id")} has no path.`);
    }
    const length = path.getTotalLength();
    const matrix = path.getScreenCTM();
    if (!matrix) throw new Error("Rendered connector path has no screen transform.");
    const sampleCount = Math.max(128, Math.min(384, Math.ceil(length / 3)));
    const points = Array.from({ length: sampleCount + 1 }, (_, index) => {
      const point = path.getPointAtLength((length * index) / sampleCount);
      const screenPoint = new DOMPoint(point.x, point.y).matrixTransform(matrix);
      return { x: screenPoint.x, y: screenPoint.y };
    });
    const distances = points.slice(1).map((point, index) =>
      Math.hypot(point.x - points[index].x, point.y - points[index].y),
    );
    const sortedDistances = [...distances].sort((left, right) => left - right);
    const typicalDistance = sortedDistances[Math.floor(sortedDistances.length / 2)] ?? 0;
    const discontinuityThreshold = Math.max(typicalDistance * 8, 24);
    const pathSegments: CanvasPointData[][] = [[points[0]]];
    for (let index = 1; index < points.length; index += 1) {
      if (distances[index - 1] > discontinuityThreshold) pathSegments.push([]);
      pathSegments.at(-1)!.push(points[index]);
    }
    const label = element.ownerDocument
      .querySelector<SVGGElement>(`[data-connector-overlay-id="${CSS.escape(connectorId)}"]`)
      ?.querySelector<SVGGElement>(".semantic-canvas-object__connector-label");
    if (!label) throw new Error("Rendered connector is missing its semantic label.");
    const labelBounds = label.getBoundingClientRect();
    if (labelBounds.width <= 2 || labelBounds.height <= 2) {
      throw new Error("Rendered connector label has no visible geometry.");
    }
    const labelBackground = label.querySelector<SVGRectElement>("rect");
    if (!labelBackground) throw new Error("Rendered connector label has no semantic bounds.");
    const semanticLabelBounds = {
      x: Number(labelBackground.getAttribute("x")),
      y: Number(labelBackground.getAttribute("y")),
      width: Number(labelBackground.getAttribute("width")),
      height: Number(labelBackground.getAttribute("height")),
    };
    if (Object.values(semanticLabelBounds).some((value) => !Number.isFinite(value))) {
      throw new Error("Rendered connector label exposes invalid semantic bounds.");
    }
    return {
      pathData: path.getAttribute("d") ?? "",
      pathSegments,
      labelText: (label.textContent ?? "").replace(/\s+/g, " ").trim(),
      labelBounds: {
        x: labelBounds.x,
        y: labelBounds.y,
        width: labelBounds.width,
        height: labelBounds.height,
      },
      semanticLabelBounds,
    };
  }, objectId);
}

async function waitForRenderedShapeRevision(
  page: Page,
  objectId: string,
  expectedRevision: number,
): Promise<void> {
  const shape = renderedObject(page, objectId);
  await expect(shape).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      () => shape.getAttribute("data-object-revision").then((value) => Number(value)),
      {
        timeout: 15_000,
        message: `semantic object ${objectId} should project authoritative revision ${expectedRevision}`,
      },
    )
    .toBe(expectedRevision);
}

function boundsOverlap(left: BrowserBounds, right: BrowserBounds, padding = 0): boolean {
  return !(
    left.x + left.width + padding <= right.x ||
    right.x + right.width + padding <= left.x ||
    left.y + left.height + padding <= right.y ||
    right.y + right.height + padding <= left.y
  );
}

function renderedRouteReadiness(
  rendered: Record<RenderedRouteKey, RenderedConnectorData>,
  sourceBounds: BrowserBounds,
  blockerBounds: BrowserBounds,
): string[] {
  const failures: string[] = [];
  if (!rendered.straight.pathSegments.some((points) => routeIntersectsBounds(points, blockerBounds))) {
    failures.push("straight route has not reached the blocker");
  }
  if (rendered.auto.pathSegments.some((points) => routeIntersectsBounds(points, blockerBounds))) {
    failures.push("auto route still intersects the blocker");
  }
  if (
    rendered.curved.pathData === rendered.straight.pathData ||
    rendered.elbow.pathData === rendered.straight.pathData ||
    rendered.curved.pathData === rendered.elbow.pathData
  ) {
    failures.push("route kinds are not visually distinct");
  }
  const routes = Object.entries(rendered) as Array<[RenderedRouteKey, RenderedConnectorData]>;
  for (const [key, route] of routes) {
    if (route.labelBounds.width <= 80 || route.labelBounds.height > 81) {
      failures.push(`${key} label has not completed layout`);
    }
    if (boundsOverlap(route.labelBounds, sourceBounds)) failures.push(`${key} label overlaps source`);
    if (boundsOverlap(route.labelBounds, blockerBounds)) failures.push(`${key} label overlaps blocker`);
  }
  for (let left = 0; left < routes.length; left += 1) {
    for (let right = left + 1; right < routes.length; right += 1) {
      if (boundsOverlap(routes[left][1].labelBounds, routes[right][1].labelBounds, 2)) {
        failures.push(`${routes[left][0]} and ${routes[right][0]} labels overlap`);
      }
    }
  }
  return failures;
}

async function readAndAssertRenderedRoutes(
  page: Page,
  refs: Record<string, string>,
  expectedRevisions: Record<RenderedRouteKey, number>,
): Promise<Record<RenderedRouteKey, RenderedConnectorData>> {
  await Promise.all(
    (["auto", "straight", "curved", "elbow"] as const).map((key) =>
      waitForRenderedShapeRevision(page, refs[`${key}_route`], expectedRevisions[key]),
    ),
  );
  const sourceBounds = await renderedShapeBounds(page, refs.source);
  const blockerBounds = await renderedShapeBounds(page, refs.blocker);
  const readRendered = async (): Promise<Record<RenderedRouteKey, RenderedConnectorData>> => ({
    auto: await readRenderedConnector(page, refs.auto_route, "Obstacle-aware auto route"),
    straight: await readRenderedConnector(page, refs.straight_route, "Intentional straight overlay"),
    curved: await readRenderedConnector(page, refs.curved_route, "Explicit curved route"),
    elbow: await readRenderedConnector(page, refs.elbow_route, "Explicit elbow route"),
  });
  await expect
    .poll(async () => renderedRouteReadiness(await readRendered(), sourceBounds, blockerBounds), {
      timeout: 15_000,
      message: "the semantic canvas should finish route and label layout without overlaps",
    })
    .toEqual([]);
  const rendered = await readRendered();

  expect(
    rendered.straight.pathSegments.some((points) => routeIntersectsBounds(points, blockerBounds)),
  ).toBe(true);
  expect(
    rendered.auto.pathSegments.some((points) => routeIntersectsBounds(points, blockerBounds)),
  ).toBe(false);
  expect(rendered.curved.pathData).not.toBe(rendered.straight.pathData);
  expect(rendered.elbow.pathData).not.toBe(rendered.straight.pathData);
  expect(rendered.curved.pathData).not.toBe(rendered.elbow.pathData);

  const routes = Object.values(rendered);
  const labels = routes.map(({ labelBounds }) => labelBounds);
  for (const [index, route] of routes.entries()) {
    const routeName = ["auto", "straight", "curved", "elbow"][index];
    expect(route.labelText).toBe([
      "Obstacle-aware auto route",
      "Intentional straight overlay",
      "Explicit curved route",
      "Explicit elbow route",
    ][index]);
    expect.soft(
      route.labelBounds.width,
      `${routeName} label should have enough horizontal room to remain readable`,
    ).toBeGreaterThan(80);
    expect.soft(
      route.labelBounds.height,
      `${routeName} label should not collapse into more than three lines`,
    ).toBeLessThanOrEqual(81);
    expect.soft(
      boundsOverlap(route.labelBounds, sourceBounds),
      `${routeName} label should stay clear of the source node`,
    ).toBe(false);
    expect.soft(
      boundsOverlap(route.labelBounds, blockerBounds),
      `${routeName} label should stay clear of the unrelated blocker`,
    ).toBe(false);
  }
  for (let left = 0; left < labels.length; left += 1) {
    for (let right = left + 1; right < labels.length; right += 1) {
      expect.soft(
        boundsOverlap(labels[left], labels[right], 2),
        `connector labels ${left} and ${right} should not overlap`,
      ).toBe(false);
    }
  }
  return rendered;
}

test.describe("WebMCP browser acceptance", () => {
  test("covers private landing actions, 54 participant tools, lifecycle actions, and semantic Diagram operations", async ({
    browser,
    page,
  }) => {
    test.setTimeout(180_000);
    expect(PARTICIPANT_ROOM_TOOL_NAMES).toHaveLength(54);
    expect(SPECTATOR_ROOM_TOOL_NAMES).toHaveLength(18);

    await installWebMcpShim(page);
    await page.goto("/");
    const landingMetadata = await expectRegisteredSurface(page, LANDING_WEBMCP_TOOL_NAMES);
    expect(landingMetadata.find((tool) => tool.name === "list_recent_rooms")?.annotations?.readOnlyHint).toBe(true);
    for (const toolName of ["create_room", "join_room", "open_recent_room", "remove_recent_room"]) {
      expect(landingMetadata.find((tool) => tool.name === toolName)?.annotations?.readOnlyHint).not.toBe(true);
    }

    const emptyRecents = successData(
      await callWebMcpTool<RecentRoomsData>(page, "list_recent_rooms", {}),
    );
    expect(emptyRecents).toEqual({ scope: "current_browser_and_signed_session", rooms: [] });

    const invalidJoin = await callWebMcpTool<never>(page, "join_room", {
      code: "42",
      displayName: "Invalid exact-code attempt",
      role: "participant",
    });
    expect(invalidJoin).toMatchObject({
      ok: false,
      tool: "join_room",
      error: { code: "INVALID_TOOL_INPUT" },
    });

    const created = successData(
      await callNavigationTool<LandingRoomData>(
        page,
        "create_room",
        { displayName: "WebMCP Host", title: "WebMCP semantic acceptance" },
        /\/room\/room_[^/?#]+$/,
      ),
    );
    expect(created).toMatchObject({
      role: "participant",
      room: { code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/), title: "WebMCP semantic acceptance" },
    });
    await expectSemanticCanvas(page);

    const participantMetadata = await expectRegisteredSurface(page, PARTICIPANT_ROOM_TOOL_NAMES);
    await expect(page.getByTestId("site-tools-status")).toHaveCount(0);
    for (const toolName of [...SHARED_ROOM_READ_TOOL_NAMES, ...PARTICIPANT_ONLY_READ_TOOL_NAMES]) {
      expect(participantMetadata.find((tool) => tool.name === toolName)?.annotations?.readOnlyHint).toBe(true);
    }
    for (const toolName of ROOM_MUTATION_TOOL_NAMES) {
      expect(participantMetadata.find((tool) => tool.name === toolName)?.annotations?.readOnlyHint).not.toBe(true);
    }
    expect(
      participantMetadata.find((tool) => tool.name === "render_canvas_preview"),
    ).toMatchObject({
      name: "render_canvas_preview",
      annotations: { untrustedContentHint: true },
    });
    expect(
      participantMetadata.find((tool) => tool.name === "render_canvas_preview")?.annotations
        ?.readOnlyHint,
    ).not.toBe(true);
    expect(participantMetadata.find((tool) => tool.name === "inspect_canvas_scope")).toMatchObject({
      name: "inspect_canvas_scope",
      annotations: { readOnlyHint: true, untrustedContentHint: true },
    });
    expect(
      participantMetadata.find((tool) => tool.name === "export_canvas_png"),
    ).toMatchObject({
      name: "export_canvas_png",
      annotations: { untrustedContentHint: true },
    });
    expect(
      participantMetadata.find((tool) => tool.name === "export_canvas_png")?.annotations
        ?.readOnlyHint,
    ).not.toBe(true);

    const capabilities = successData(
      await callWebMcpTool<CanvasCapabilitiesData>(page, "get_canvas_capabilities", {}),
    );
    expect(capabilities).toMatchObject({
      schemaVersion: 1,
      role: "participant",
      authority: {
        currentPageToolRegistryIsAuthoritative: true,
        roleCanMutateCanvas: true,
      },
      coordinateSystem: {
        unit: "canvas-unit",
        xDirection: "right",
        yDirection: "down",
        rotation: { unit: "radian", positiveDirectionOnScreen: "clockwise" },
        authoredPointSpaces: {
          createDrawingPathAndPolygonInput: "absolute-canvas",
          persistedAndPatchDrawingPoints: "object-local-canvas-units",
          persistedAndPatchPathAndPolygonPoints: "normalized-object-local-0-to-1",
        },
      },
      paintOrder: { field: "zIndex", higherValue: "front" },
      primitives: {
        path: { supported: true, segments: ["line", "quadratic", "cubic"] },
        polygon: { supported: true, representation: "closed-path" },
      },
      inspection: { preferredTool: "inspect_canvas_scope" },
    });

    const hostBefore = successData(await callWebMcpTool<ReadRoomData>(page, "read_room_state", {}));
    const hostMembershipBefore = hostBefore.participants.find(
      (participant) => participant.participantId === (hostBefore.participants.find((item) => item.role === "participant")?.participantId),
    );
    expect(hostMembershipBefore?.agentActive).toBe(false);

    const transaction = successData(
      await callWebMcpTool<TransactionData>(page, "apply_canvas_transaction", {
        operations: [
          {
            op: "create_node",
            tempRef: "web_client",
            label: "Web client",
            nodeType: "component",
          },
          {
            op: "create_node",
            tempRef: "room_api",
            label: "Room API",
            nodeType: "service",
          },
          {
            op: "create_node",
            tempRef: "guest_session",
            label: "Guest-session authorization",
            nodeType: "requirement",
          },
          {
            op: "create_node",
            tempRef: "redis_store",
            label: "Redis room state",
            nodeType: "service",
          },
          {
            op: "connect",
            tempRef: "client_api",
            start: { tempRef: "web_client" },
            end: { tempRef: "room_api" },
            direction: "end",
            label: "exact-code request",
          },
          {
            op: "connect",
            tempRef: "api_session",
            start: { tempRef: "room_api" },
            end: { tempRef: "guest_session" },
            direction: "end",
            label: LONG_CONNECTOR_LABEL,
          },
          {
            op: "connect",
            tempRef: "session_redis",
            start: { tempRef: "guest_session" },
            end: { tempRef: "redis_store" },
            direction: "end",
            label: "load membership",
          },
          {
            op: "create_diagram",
            tempRef: "auth_flow",
            diagramId: "diagram_authentication_request_flow_e2e",
            title: "Authentication request flow",
            description: "Shows how the web client, room API, guest-session authorization, and Redis interact.",
            diagramType: "flow",
            category: "security",
            tags: ["authentication", "guest-session", "redis"],
            members: [
              { tempRef: "web_client" },
              { tempRef: "room_api" },
              { tempRef: "guest_session" },
              { tempRef: "redis_store" },
            ],
            connectors: [
              { tempRef: "client_api" },
              { tempRef: "api_session" },
              { tempRef: "session_redis" },
            ],
          },
          {
            op: "auto_layout",
            layout: "flow",
            layoutDirection: "right",
            density: "comfortable",
            origin: { x: 120, y: 160 },
            targets: ["web_client", "room_api", "guest_session", "redis_store"],
            diagramTempRef: "auth_flow",
          },
        ],
      }),
    );

    expect(transaction.changedObjectIds).toHaveLength(7);
    expect(transaction.changedDiagramIds).toHaveLength(1);
    expect(Object.keys(transaction.temporaryReferences)).toEqual(
      expect.arrayContaining([
        "web_client",
        "room_api",
        "guest_session",
        "redis_store",
        "client_api",
        "api_session",
        "session_redis",
        "auth_flow",
      ]),
    );

    const refs = transaction.temporaryReferences;
    const diagramId = refs.auth_flow;
    expect(diagramId).toBe("diagram_authentication_request_flow_e2e");
    const memberIds = [refs.web_client, refs.room_api, refs.guest_session, refs.redis_store];
    const connectorIds = [refs.client_api, refs.api_session, refs.session_redis];
    const transactionObjectById = new Map(
      transaction.objects.map((object) => [object.id, object] as const),
    );
    expect(transaction.positions).toEqual(
      memberIds.map((objectId) => ({
        objectId,
        x: transactionObjectById.get(objectId)?.x,
        y: transactionObjectById.get(objectId)?.y,
      })),
    );
    expect(transaction.objects).toHaveLength(7);
    expect(transaction.objects.every((object) => object.revision === 1)).toBe(true);
    expect(transaction.diagrams[0]).toMatchObject({
      id: diagramId,
      title: "Authentication request flow",
      diagramType: "flow",
      category: "security",
      tags: ["authentication", "guest-session", "redis"],
      memberObjectIds: memberIds,
      connectorIds,
      revision: 1,
      createdBy: { kind: "agent" },
      lastEditedBy: { kind: "agent" },
    });

    const expectedRelationships = [
      { connectorId: refs.client_api, startId: refs.web_client, endId: refs.room_api },
      { connectorId: refs.api_session, startId: refs.room_api, endId: refs.guest_session },
      { connectorId: refs.session_redis, startId: refs.guest_session, endId: refs.redis_store },
    ];
    for (const relationship of expectedRelationships) {
      const connector = transactionObjectById.get(relationship.connectorId);
      const start = transactionObjectById.get(relationship.startId);
      const end = transactionObjectById.get(relationship.endId);
      expect(connector).toMatchObject({
        kind: "connector",
        revision: 1,
        start: { objectId: relationship.startId },
        end: { objectId: relationship.endId },
      });
      expect(start).toBeDefined();
      expect(end).toBeDefined();
      expect(end!.y).toBe(start!.y);
      expect(end!.x - (start!.x + start!.width)).toBeGreaterThanOrEqual(160);
    }
    const longLabelClearance =
      transactionObjectById.get(refs.guest_session)!.x -
      (transactionObjectById.get(refs.room_api)!.x +
        transactionObjectById.get(refs.room_api)!.width);
    expect(longLabelClearance).toBeGreaterThan(300);

    // A server-projected semantic connector must settle. Binding geometry is
    // derived UI state and must not echo back as perpetual human edits.
    await page.waitForTimeout(900);
    const settledProjection = await getRoom(page.request, created.room.id);
    const settledDiagramRevision = settledProjection.room.diagrams[diagramId].revision;
    const settledConnectorRevisions = connectorIds.map(
      (connectorId) => settledProjection.room.objects[connectorId].revision,
    );
    expect(
      memberIds.map((memberId) => settledProjection.room.objects[memberId].revision),
    ).toEqual([1, 1, 1, 1]);
    expect(settledConnectorRevisions).toEqual([1, 1, 1]);
    expect(settledDiagramRevision).toBe(1);
    await page.waitForTimeout(900);
    const idleProjection = await getRoom(page.request, created.room.id);
    expect(idleProjection.room.diagrams[diagramId].revision).toBe(settledDiagramRevision);
    expect(
      connectorIds.map((connectorId) => idleProjection.room.objects[connectorId].revision),
    ).toEqual(settledConnectorRevisions);
    expect(Object.keys(idleProjection.room.leases)).toEqual([]);

    const preview = successData(
      await callWebMcpTool<CanvasPreviewData>(page, "render_canvas_preview", {
        scope: { kind: "diagram", diagramId, expectedRevision: 1 },
        maxWidth: 1_000,
        maxHeight: 600,
      }),
    );
    expect(preview).toMatchObject({
      previewId: expect.stringMatching(/^preview_/),
      visualInspectionStatus: "not_performed",
      geometryQualityStatus: "pass",
      nextStep: expect.stringMatching(/Framing is not visual QA.*screenshotClip/),
      screenshotClip: {
        coordinateSpace: "viewport-css-pixels",
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      },
      mimeType: "image/png",
      width: expect.any(Number),
      height: expect.any(Number),
      byteLength: expect.any(Number),
      scope: { kind: "diagram", diagramId, expectedRevision: 1 },
      sourceRevisions: {
        diagramRevision: 1,
        objects: expect.arrayContaining(
          [...memberIds, ...connectorIds].map((objectId) => ({ objectId, revision: 1 })),
        ),
      },
      targets: expect.arrayContaining(
        [...memberIds, ...connectorIds].map((objectId) => ({ objectId, revision: 1 })),
      ),
    });
    expect(preview.expiresAt).toBeGreaterThan(Date.now() + 50_000);
    expect(preview.byteLength).toBeGreaterThan(0);
    expect(preview).not.toHaveProperty("previewUrl");
    expect(preview).not.toHaveProperty("imageUrl");
    expect(preview).not.toHaveProperty("dataUrl");

    expect(preview.presentation).toBe("live_canvas");
    await expect(page.getByRole("dialog", { name: "Canvas preview" })).toHaveCount(0);
    const liveCanvasBounds = await page.getByTestId("semantic-canvas").boundingBox();
    expect(liveCanvasBounds).not.toBeNull();
    expect(preview.screenshotClip.x).toBeGreaterThanOrEqual(liveCanvasBounds!.x - 1);
    expect(preview.screenshotClip.y).toBeGreaterThanOrEqual(liveCanvasBounds!.y - 1);
    expect(preview.screenshotClip.x + preview.screenshotClip.width).toBeLessThanOrEqual(
      liveCanvasBounds!.x + liveCanvasBounds!.width + 1,
    );
    expect(preview.screenshotClip.y + preview.screenshotClip.height).toBeLessThanOrEqual(
      liveCanvasBounds!.y + liveCanvasBounds!.height + 1,
    );
    expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual({
      x: 0,
      y: 0,
    });
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    expect(preview.screenshotClip.x).toBeGreaterThanOrEqual(0);
    expect(preview.screenshotClip.y).toBeGreaterThanOrEqual(0);
    expect(preview.screenshotClip.x + preview.screenshotClip.width).toBeLessThanOrEqual(
      viewport!.width,
    );
    expect(preview.screenshotClip.y + preview.screenshotClip.height).toBeLessThanOrEqual(
      viewport!.height,
    );
    const previewPng = await page.screenshot({
      type: "png",
      clip: {
        x: preview.screenshotClip.x,
        y: preview.screenshotClip.y,
        width: preview.screenshotClip.width,
        height: preview.screenshotClip.height,
      },
    });
    expect(previewPng.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(previewPng.length).toBeGreaterThan(512);
    expect(previewPng.readUInt32BE(16)).toBeGreaterThan(64);
    expect(previewPng.readUInt32BE(20)).toBeGreaterThan(32);

    const drawing = successData(
      await callWebMcpTool<CreateObjectData>(page, "create_drawing", {
        points: [
          { x: 80, y: 540 },
          { x: 140, y: 500 },
          { x: 220, y: 550 },
          { x: 300, y: 510 },
        ],
        color: "red",
        size: "m",
      }),
    );
    expect(drawing).toMatchObject({
      changedObjectIds: [expect.any(String)],
      objects: [{ kind: "draw", revision: 1 }],
    });

    const polygon = successData(
      await callWebMcpTool<CreateObjectData>(page, "create_polygon", {
        points: [
          { x: 440, y: 700 },
          { x: 600, y: 700 },
          { x: 640, y: 820 },
          { x: 480, y: 850 },
        ],
        fill: "yellow",
        stroke: "violet",
        strokeWidth: 6,
        opacity: 0.85,
      }),
    );
    expect(polygon).toMatchObject({
      changedObjectIds: [expect.any(String)],
      objects: [{ kind: "path", revision: 1 }],
    });
    const polygonId = polygon.changedObjectIds[0];
    const polygonInspection = successData(
      await callWebMcpTool<CanvasInspectionData>(page, "inspect_canvas_scope", {
        scope: {
          kind: "objects",
          targets: [{ objectId: polygonId, expectedRevision: 1 }],
        },
      }),
    );
    expect(polygonInspection).toMatchObject({
      previewId: expect.stringMatching(/^preview_/),
      presentation: "live_canvas",
      visualInspectionStatus: "not_performed",
      geometryQualityStatus: "unknown",
      sourceRevisions: {
        objects: [{ objectId: polygonId, revision: 1 }],
        visualContributors: expect.arrayContaining([{ objectId: polygonId, revision: 1 }]),
      },
      targets: [{ objectId: polygonId, revision: 1 }],
      semanticEvidence: {
        schemaVersion: 1,
        intersections: { totalCount: expect.any(Number), truncated: false },
        occlusions: { totalCount: expect.any(Number), truncated: false },
      },
    });
    expect(
      polygonInspection.semanticEvidence.objects.find((object) => object.objectId === polygonId),
    ).toMatchObject({
      objectId: polygonId,
      revision: 1,
      kind: "path",
      inRequestedScope: true,
      semantic: { kind: "path", segmentCount: 3, closed: true },
    });
    expect(polygonInspection.semanticEvidence.coverage).toMatchObject({
      geometry: "partial",
      omittedUnsupportedCount: 0,
    });
    expect(polygonInspection.semanticEvidence.coverage.unsupported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectId: polygonId, analysis: "vector_path_geometry" }),
      ]),
    );
    expect(polygonInspection.screenshotClip.width).toBeGreaterThan(0);
    expect(polygonInspection.screenshotClip.height).toBeGreaterThan(0);
    expect(polygonInspection.semanticEvidence.intersections.totalCount).toBeGreaterThanOrEqual(0);
    expect(polygonInspection.semanticEvidence.occlusions.totalCount).toBeGreaterThanOrEqual(0);

    const overlapTransaction = successData(
      await callWebMcpTool<TransactionData>(page, "apply_canvas_transaction", {
        operations: [
          {
            op: "create_shape",
            tempRef: "stack_base",
            label: "Intentional layered base",
            shape: "rectangle",
            x: 80,
            y: 720,
            width: 240,
            height: 180,
          },
          {
            op: "create_shape",
            tempRef: "stack_detail",
            label: "Intentional layered detail",
            shape: "ellipse",
            x: 80,
            y: 720,
            width: 240,
            height: 180,
          },
        ],
      }),
    );
    const overlapIds = [
      overlapTransaction.temporaryReferences.stack_base,
      overlapTransaction.temporaryReferences.stack_detail,
    ];
    expect(overlapTransaction.positions).toBeUndefined();
    expect(overlapTransaction.objects).toEqual(
      expect.arrayContaining(
        overlapIds.map((id) =>
          expect.objectContaining({ id, x: 80, y: 720, width: 240, height: 180, revision: 1 }),
        ),
      ),
    );
    const persistedOverlap = await getRoom(page.request, created.room.id);
    expect(overlapIds.map((id) => persistedOverlap.room.objects[id])).toEqual(
      overlapIds.map((id) =>
        expect.objectContaining({ id, x: 80, y: 720, width: 240, height: 180, revision: 1 }),
      ),
    );

    const found = successData(
      await callWebMcpTool<{ totalMatched: number; diagrams: DiagramData[] }>(page, "find_diagrams", {
        text: "Authentication request flow",
        tags: ["guest-session"],
      }),
    );
    expect(found).toMatchObject({
      totalMatched: 1,
      diagrams: [{ id: diagramId, description: expect.stringContaining("Redis interact") }],
    });

    const described = successData(
      await callWebMcpTool<{
        diagram: DiagramData;
        counts: { members: number; connectors: number; nodeTypes: Record<string, number> };
      }>(page, "describe_diagram", { diagramId }),
    );
    expect(described).toMatchObject({
      diagram: { id: diagramId, title: "Authentication request flow", revision: 1 },
      counts: {
        members: 4,
        connectors: 3,
        nodeTypes: { component: 1, service: 2, requirement: 1, decision: 0, open_question: 0 },
      },
    });

    const diagramBeforeLayout = successData(
      await callWebMcpTool<ReadDiagramData>(page, "read_diagram", { diagramId }),
    );
    expect(diagramBeforeLayout.objects.map((object) => object.id)).toEqual(memberIds);
    expect(diagramBeforeLayout.connectors.map((object) => object.id)).toEqual(connectorIds);
    expect(diagramBeforeLayout.connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: refs.client_api,
          start: expect.objectContaining({ objectId: refs.web_client }),
          end: expect.objectContaining({ objectId: refs.room_api }),
        }),
      ]),
    );

    const serviceQuery = successData(
      await callWebMcpTool<QueryData>(page, "query_objects", {
        diagramId,
        kinds: ["shape"],
        nodeTypes: ["service"],
        limit: 10,
      }),
    );
    expect(serviceQuery).toMatchObject({ totalMatched: 2, truncated: false });
    expect(serviceQuery.objects.map((object) => object.id).sort()).toEqual(
      [refs.room_api, refs.redis_store].sort(),
    );
    expect(serviceQuery.objects.every((object) => object.nodeType === "service")).toBe(true);

    const neighborhood = successData(
      await callWebMcpTool<NeighborhoodData>(page, "read_neighborhood", {
        objectIds: [refs.room_api],
        depth: 1,
        direction: "both",
        includeDiagramPeers: false,
        maxObjects: 20,
      }),
    );
    expect(neighborhood).toMatchObject({
      rootObjectIds: [refs.room_api],
      missingObjectIds: [],
      depthReached: 1,
      truncated: false,
      diagrams: [{ id: diagramId }],
    });
    expect(neighborhood.objects.map((object) => object.id)).toEqual(
      expect.arrayContaining([refs.web_client, refs.room_api, refs.guest_session]),
    );
    expect(neighborhood.objects.map((object) => object.id)).not.toContain(refs.redis_store);
    expect(neighborhood.connectors.map((object) => object.id).sort()).toEqual(
      [refs.client_api, refs.api_session].sort(),
    );

    const layout = successData(
      await callWebMcpTool<LayoutData>(page, "layout_objects", {
        layout: "flow",
        direction: "right",
        density: "comfortable",
        origin: { x: 180, y: 200 },
        diagramId,
        expectedDiagramRevision: diagramBeforeLayout.diagram.revision,
        targets: diagramBeforeLayout.objects.map((object) => ({
          objectId: object.id,
          expectedRevision: object.revision,
        })),
      }),
    );
    const atomicPositionById = new Map(
      transaction.positions!.map((position) => [position.objectId, position] as const),
    );
    expect(layout.positions).toEqual(
      memberIds.map((objectId) => ({
        objectId,
        x: atomicPositionById.get(objectId)!.x + 60,
        y: atomicPositionById.get(objectId)!.y + 40,
      })),
    );
    expect(layout.changedObjectIds).toEqual(expect.arrayContaining([...memberIds, ...connectorIds]));
    expect(layout.changedDiagramIds).toEqual([diagramId]);

    const diagramAfterLayout = successData(
      await callWebMcpTool<ReadDiagramData>(page, "read_diagram", { diagramId }),
    );
    expect(diagramAfterLayout.diagram).toMatchObject({
      id: diagramId,
      revision: 2,
      bounds: {
        x: 180,
        y: 200,
        width: transaction.diagrams[0].bounds.width,
        height: transaction.diagrams[0].bounds.height,
      },
      memberObjectIds: memberIds,
      connectorIds,
      lastEditedBy: { kind: "agent" },
    });
    expect(diagramAfterLayout.connectors).toEqual(
      expect.arrayContaining(
        connectorIds.map((id) => expect.objectContaining({ id, revision: 2 })),
      ),
    );

    const editedDiagram = successData(
      await callWebMcpTool<{ diagram: DiagramData }>(page, "edit_diagram", {
        diagramId,
        expectedRevision: diagramAfterLayout.diagram.revision,
        description: "Production-ready semantic authentication flow with authorization and persistence boundaries.",
        tags: ["authentication", "guest-session", "redis", "production"],
      }),
    );
    expect(editedDiagram.diagram).toMatchObject({
      id: diagramId,
      revision: 3,
      description: expect.stringContaining("Production-ready semantic authentication flow"),
      tags: ["authentication", "guest-session", "redis", "production"],
      memberObjectIds: memberIds,
      connectorIds,
      bounds: diagramAfterLayout.diagram.bounds,
    });

    const rejected = await callWebMcpTool<TransactionData>(page, "apply_canvas_transaction", {
      operations: [
        {
          op: "create_node",
          tempRef: "must_not_commit",
          label: REJECTED_LABEL,
          nodeType: "open_question",
        },
        {
          op: "update",
          objectId: refs.room_api,
          expectedRevision: 1,
          patch: { label: "Stale update must fail" },
        },
      ],
    });
    expect(rejected).toMatchObject({
      ok: false,
      tool: "apply_canvas_transaction",
      error: { code: "REVISION_CONFLICT" },
    });
    const absentRejectedNode = successData(
      await callWebMcpTool<QueryData>(page, "query_objects", { text: REJECTED_LABEL }),
    );
    expect(absentRejectedNode).toMatchObject({ totalMatched: 0, objects: [] });

    const semanticExport = successData(
      await callWebMcpTool<{
        format: string;
        artifact: { title: string; objects: CanvasObjectData[]; diagrams: DiagramData[] };
        sourceDiagramRevision: number;
      }>(page, "export_canvas_artifact", {
        format: "semantic_json",
        scope: { kind: "diagram", diagramId },
      }),
    );
    expect(semanticExport).toMatchObject({
      format: "semantic_json",
      artifact: {
        title: "Authentication request flow",
        objects: expect.arrayContaining(memberIds.map((id) => expect.objectContaining({ id }))),
        diagrams: [expect.objectContaining({ id: diagramId })],
      },
    });

    const mermaidExport = successData(
      await callWebMcpTool<{ format: string; content: string }>(page, "export_canvas_artifact", {
        format: "mermaid",
        scope: { kind: "diagram", diagramId },
      }),
    );
    expect(mermaidExport.content).toContain("flowchart LR");
    expect(mermaidExport.content).toContain("Room API");

    const svgExport = successData(
      await callWebMcpTool<{ format: string; content: string }>(page, "export_canvas_artifact", {
        format: "svg",
        scope: { kind: "diagram", diagramId },
      }),
    );
    expect(svgExport.content).toMatch(/^<svg[^>]+>/);
    expect(svgExport.content).not.toMatch(/<script|<foreignObject|\shref=/i);

    const templateExport = successData(
      await callWebMcpTool<{ template: Record<string, unknown>; sourceDiagramRevision: number }>(
        page,
        "create_diagram_template",
        { diagramId },
      ),
    );
    expect(templateExport).toMatchObject({
      template: { kind: "template", title: "Authentication request flow" },
      sourceDiagramRevision: expect.any(Number),
    });

    const currentDiagramForPng = successData(
      await callWebMcpTool<ReadDiagramData>(page, "read_diagram", { diagramId }),
    );
    const [pngDownload, pngToolResult] = await Promise.all([
      page.waitForEvent("download"),
      callWebMcpTool<{
        filename: string;
        mimeType: string;
        width: number;
        height: number;
        byteLength: number;
        persistedByJazzboard: boolean;
      }>(page, "export_canvas_png", {
        scope: {
          kind: "diagram",
          diagramId,
          expectedRevision: currentDiagramForPng.diagram.revision,
        },
      }),
    ]);
    const pngExport = successData(pngToolResult);
    expect(pngExport).toMatchObject({
      filename: "authentication-request-flow.png",
      mimeType: "image/png",
      width: expect.any(Number),
      height: expect.any(Number),
      byteLength: expect.any(Number),
      persistedByJazzboard: false,
    });
    expect(pngDownload.suggestedFilename()).toBe(pngExport.filename);
    expect(await pngDownload.path()).not.toBeNull();

    const reviewEnabled = successData(
      await callWebMcpTool<{ policy: string; changed: boolean; roomRevision: number }>(
        page,
        "enable_agent_review",
        {},
      ),
    );
    expect(reviewEnabled).toMatchObject({ policy: "review", changed: true });

    const currentRoomApi = successData(
      await callWebMcpTool<ReadRoomData>(page, "read_room_state", { objectIds: [refs.room_api] }),
    ).objects[0];
    const proposedUpdate = successData(
      await callWebMcpTool<{
        outcome: "applied" | "proposed";
        changedObjectIds: string[];
        proposal: { id: string; revision: number; status: string } | null;
      }>(page, "update_object", {
        objectId: refs.room_api,
        expectedRevision: currentRoomApi.revision,
        patch: { label: "Authorized room API" },
        intent: "Clarify the server authorization boundary",
        summary: "Rename Room API after human review",
      }),
    );
    expect(proposedUpdate).toMatchObject({
      outcome: "proposed",
      changedObjectIds: [],
      proposal: { status: "pending" },
    });
    if (!proposedUpdate.proposal) throw new Error("Review mode did not return a proposal.");

    const pendingProposals = successData(
      await callWebMcpTool<{
        policy: string;
        proposals: Array<{ id: string; revision: number; intent: string | null }>;
      }>(page, "list_agent_edit_proposals", { status: "pending", limit: 20 }),
    );
    expect(pendingProposals).toMatchObject({
      policy: "review",
      proposals: [expect.objectContaining({
        id: proposedUpdate.proposal.id,
        intent: "Clarify the server authorization boundary",
      })],
    });
    const exactProposal = successData(
      await callWebMcpTool<{ id: string; request: { kind: string } }>(
        page,
        "read_agent_edit_proposal",
        { proposalId: proposedUpdate.proposal.id },
      ),
    );
    expect(exactProposal).toMatchObject({
      id: proposedUpdate.proposal.id,
      request: { kind: "canvas_command" },
    });

    const approvalResponse = await page.request.post(
      `/api/rooms/${encodeURIComponent(created.room.id)}/review/${encodeURIComponent(proposedUpdate.proposal.id)}`,
      {
        data: {
          action: "approve",
          expectedProposalRevision: proposedUpdate.proposal.revision,
          note: "Approved by the human WebMCP acceptance flow",
        },
      },
    );
    expect(approvalResponse.status()).toBe(200);
    expect(await approvalResponse.json()).toMatchObject({
      ok: true,
      outcome: "applied",
      proposal: { status: "applied", review: { decision: "approved" } },
    });
    const approvedQuery = successData(
      await callWebMcpTool<QueryData>(page, "query_objects", { text: "Authorized room API" }),
    );
    expect(approvedQuery).toMatchObject({ totalMatched: 1, objects: [{ id: refs.room_api }] });

    const beforeTemplateProposal = successData(
      await callWebMcpTool<ReadRoomData>(page, "read_room_state", {}),
    );
    const proposedTemplate = successData(
      await callWebMcpTool<{
        outcome: "applied" | "proposed";
        changedObjectIds: string[];
        proposal: { id: string; revision: number; status: string } | null;
      }>(page, "instantiate_diagram_template", {
        expectedRoomRevision: beforeTemplateProposal.room.roomRevision,
        template: templateExport.template,
        origin: { x: 120, y: 520 },
        intent: "Reuse the authentication flow",
      }),
    );
    expect(proposedTemplate).toMatchObject({ outcome: "proposed", changedObjectIds: [], proposal: { status: "pending" } });
    if (!proposedTemplate.proposal) throw new Error("Template instantiation bypassed review mode.");
    const rejectionResponse = await page.request.post(
      `/api/rooms/${encodeURIComponent(created.room.id)}/review/${encodeURIComponent(proposedTemplate.proposal.id)}`,
      {
        data: {
          action: "reject",
          expectedProposalRevision: proposedTemplate.proposal.revision,
          note: "Acceptance test keeps one Diagram",
        },
      },
    );
    expect(rejectionResponse.status()).toBe(200);
    expect(await rejectionResponse.json()).toMatchObject({ ok: true, outcome: "rejected" });

    const activityList = successData(
      await callWebMcpTool<{ activities: Array<{ id: string; actor: { kind: string } }> }>(
        page,
        "list_activity",
        { actorKind: "agent", limit: 20 },
      ),
    );
    expect(activityList.activities.some((item) => item.actor.kind === "agent")).toBe(true);

    const host = await getRoom(page.request, created.room.id);
    expect(host.room.participants[host.participantId].agentActive).toBe(true);

    const collaboratorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const collaboratorPage = await collaboratorContext.newPage();
      await installWebMcpShim(collaboratorPage);
      await collaboratorPage.goto("/");
      await expectRegisteredSurface(collaboratorPage, LANDING_WEBMCP_TOOL_NAMES);

      const joined = successData(
        await callNavigationTool<LandingRoomData>(
          collaboratorPage,
          "join_room",
          { code: created.room.code, displayName: "Lifecycle Collaborator", role: "participant" },
          /\/room\/room_[^/?#]+$/,
        ),
      );
      expect(joined).toMatchObject({ room: { id: created.room.id }, role: "participant" });
      await expectSemanticCanvas(collaboratorPage);
      await expectRegisteredSurface(collaboratorPage, PARTICIPANT_ROOM_TOOL_NAMES);

      const collaboratorRoom = await getRoom(collaboratorContext.request, created.room.id);
      expect(collaboratorRoom.room.participants[collaboratorRoom.participantId].agentActive).toBe(false);
      successData(
        await callWebMcpTool<Record<string, unknown>>(collaboratorPage, "focus_viewport", {
          x: 0,
          y: 0,
          width: 900,
          height: 700,
          zoom: 1,
        }),
      );

      successData(
        await callWebMcpTool<Record<string, unknown>>(page, "follow_participant", {
          participantId: collaboratorRoom.participantId,
          target: "agent",
        }),
      );
      const following = successData(
        await callWebMcpTool<{
          follow: { mode: string; target: { participantId: string; kind: string } | null };
        }>(page, "read_collaboration_state", {}),
      );
      expect(following.follow).toMatchObject({
        mode: "private",
        target: { participantId: collaboratorRoom.participantId, kind: "agent" },
      });
      successData(await callWebMcpTool<Record<string, unknown>>(page, "stop_following", {}));

      successData(
        await callWebMcpTool<Record<string, unknown>>(page, "start_spotlight", { target: "agent" }),
      );
      successData(
        await callWebMcpTool<Record<string, unknown>>(collaboratorPage, "join_spotlight", {}),
      );
      successData(
        await callWebMcpTool<Record<string, unknown>>(collaboratorPage, "request_spotlight", {
          target: "agent",
        }),
      );
      successData(
        await callWebMcpTool<Record<string, unknown>>(page, "approve_spotlight_handoff", {}),
      );
      successData(await callWebMcpTool<Record<string, unknown>>(page, "join_spotlight", {}));
      successData(await callWebMcpTool<Record<string, unknown>>(page, "leave_spotlight", {}));
      successData(
        await callWebMcpTool<Record<string, unknown>>(collaboratorPage, "stop_spotlight", {}),
      );

      successData(
        await callWebMcpTool<Record<string, unknown>>(page, "start_spotlight", { target: "human" }),
      );
      successData(
        await callWebMcpTool<Record<string, unknown>>(collaboratorPage, "request_spotlight", {
          target: "human",
        }),
      );
      successData(
        await callWebMcpTool<Record<string, unknown>>(page, "dismiss_spotlight_request", {}),
      );
      successData(await callWebMcpTool<Record<string, unknown>>(page, "stop_spotlight", {}));

      const left = successData(
        await callNavigationTool<{ leftRoomId: string; path: string; membershipRetained: boolean }>(
          collaboratorPage,
          "leave_room",
          {},
          /\/$/,
        ),
      );
      expect(left).toMatchObject({
        leftRoomId: created.room.id,
        path: "/",
        membershipRetained: true,
      });
      await expectRegisteredSurface(collaboratorPage, LANDING_WEBMCP_TOOL_NAMES);

      const recents = successData(
        await callWebMcpTool<RecentRoomsData>(collaboratorPage, "list_recent_rooms", {}),
      );
      expect(recents.rooms).toEqual([
        expect.objectContaining({
          roomId: created.room.id,
          code: created.room.code,
          role: "participant",
        }),
      ]);

      const reopened = successData(
        await callNavigationTool<LandingRoomData>(
          collaboratorPage,
          "open_recent_room",
          { roomId: created.room.id },
          /\/room\/room_[^/?#]+$/,
        ),
      );
      expect(reopened).toMatchObject({
        room: { id: created.room.id },
        role: "participant",
        authorizationVerified: true,
      });
      await expectRegisteredSurface(collaboratorPage, PARTICIPANT_ROOM_TOOL_NAMES);
      successData(
        await callNavigationTool<Record<string, unknown>>(
          collaboratorPage,
          "leave_room",
          {},
          /\/$/,
        ),
      );
      await expectRegisteredSurface(collaboratorPage, LANDING_WEBMCP_TOOL_NAMES);

      const removed = successData(
        await callWebMcpTool<{
          sharedRoomDeleted: boolean;
          remainingCount: number;
        }>(collaboratorPage, "remove_recent_room", { roomId: created.room.id }),
      );
      expect(removed).toMatchObject({ sharedRoomDeleted: false, remainingCount: 0 });
      expect((await getRoom(page.request, created.room.id)).room.id).toBe(created.room.id);
    } finally {
      await collaboratorContext.close();
    }

    const spectatorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const spectatorPage = await spectatorContext.newPage();
      await installWebMcpShim(spectatorPage);
      await spectatorPage.goto("/");
      await expectRegisteredSurface(spectatorPage, LANDING_WEBMCP_TOOL_NAMES);
      successData(
        await callNavigationTool<LandingRoomData>(
          spectatorPage,
          "join_room",
          { code: created.room.code, displayName: "Read-only Spectator", role: "spectator" },
          /\/room\/room_[^/?#]+$/,
        ),
      );
      await expectSemanticCanvas(spectatorPage);
      const spectatorPeople = spectatorPage.getByRole("button", { name: "Show people in this room" });
      await spectatorPeople.hover();
      await expect(spectatorPage.getByRole("tooltip")).toContainText("Your role: spectator");
      await spectatorPage.mouse.move(0, 0);
      await expect(spectatorPage.getByTestId("site-tools-status")).toHaveCount(0);
      const spectatorMetadata = await expectRegisteredSurface(spectatorPage, SPECTATOR_ROOM_TOOL_NAMES);
      for (const toolName of SHARED_ROOM_READ_TOOL_NAMES) {
        expect(spectatorMetadata.find((tool) => tool.name === toolName)?.annotations?.readOnlyHint).toBe(true);
      }
      expect(spectatorMetadata.find((tool) => tool.name === "inspect_canvas_scope")).toMatchObject({
        name: "inspect_canvas_scope",
        annotations: { readOnlyHint: true, untrustedContentHint: true },
      });
      expect(spectatorMetadata.find((tool) => tool.name === "export_canvas_png")?.annotations).toEqual({
        untrustedContentHint: true,
      });

      const spectatorRoom = await getRoom(spectatorContext.request, created.room.id);
      expect(spectatorRoom.room.participants[spectatorRoom.participantId].agentActive).toBe(false);

      const spectatorCapabilities = successData(
        await callWebMcpTool<CanvasCapabilitiesData>(
          spectatorPage,
          "get_canvas_capabilities",
          {},
        ),
      );
      expect(spectatorCapabilities).toMatchObject({
        schemaVersion: 1,
        role: "spectator",
        authority: {
          currentPageToolRegistryIsAuthoritative: true,
          roleCanMutateCanvas: false,
        },
        inspection: { preferredTool: "inspect_canvas_scope" },
      });

      successData(await callWebMcpTool<ReadRoomData>(spectatorPage, "read_room_state", {}));
      successData(await callWebMcpTool<Record<string, unknown>>(spectatorPage, "read_selection", {}));
      successData(
        await callWebMcpTool<Record<string, unknown>>(spectatorPage, "read_collaboration_state", {}),
      );
      const spectatorQuery = successData(
        await callWebMcpTool<QueryData>(spectatorPage, "query_objects", {
          text: "Room API",
          diagramId,
        }),
      );
      expect(spectatorQuery.objects).toEqual([
        expect.objectContaining({ id: refs.room_api, nodeType: "service" }),
      ]);
      successData(
        await callWebMcpTool<NeighborhoodData>(spectatorPage, "read_neighborhood", {
          objectIds: [refs.room_api],
          depth: 1,
        }),
      );
      successData(
        await callWebMcpTool<{ diagrams: DiagramData[] }>(spectatorPage, "find_diagrams", {
          text: "Authentication request flow",
        }),
      );
      successData(
        await callWebMcpTool<ReadDiagramData>(spectatorPage, "read_diagram", { diagramId }),
      );
      const spectatorDescription = successData(
        await callWebMcpTool<{ diagram: DiagramData }>(spectatorPage, "describe_diagram", { diagramId }),
      );
      expect(spectatorDescription.diagram).toMatchObject({
        id: diagramId,
        tags: ["authentication", "guest-session", "redis", "production"],
        memberObjectIds: memberIds,
        connectorIds,
      });
      expect(spectatorDescription.diagram.revision).toBeGreaterThanOrEqual(3);

      const spectatorActivities = successData(
        await callWebMcpTool<{ activities: Array<{ id: string }> }>(
          spectatorPage,
          "list_activity",
          { limit: 5 },
        ),
      );
      if (spectatorActivities.activities[0]) {
        successData(
          await callWebMcpTool<Record<string, unknown>>(
            spectatorPage,
            "read_activity",
            { activityId: spectatorActivities.activities[0].id },
          ),
        );
      }
      const spectatorExport = successData(
        await callWebMcpTool<{ format: string; artifact: { diagrams: DiagramData[] } }>(
          spectatorPage,
          "export_canvas_artifact",
          { format: "semantic_json", scope: { kind: "diagram", diagramId } },
        ),
      );
      expect(spectatorExport).toMatchObject({
        format: "semantic_json",
        artifact: { diagrams: [expect.objectContaining({ id: diagramId })] },
      });
      const spectatorProposals = successData(
        await callWebMcpTool<{ proposals: Array<{ id: string }> }>(
          spectatorPage,
          "list_agent_edit_proposals",
          { limit: 10 },
        ),
      );
      if (spectatorProposals.proposals[0]) {
        successData(
          await callWebMcpTool<Record<string, unknown>>(
            spectatorPage,
            "read_agent_edit_proposal",
            { proposalId: spectatorProposals.proposals[0].id },
          ),
        );
      }

      const afterPassiveReads = await getRoom(spectatorContext.request, created.room.id);
      expect(afterPassiveReads.room.participants[spectatorRoom.participantId].agentActive).toBe(false);
      await expect(
        callWebMcpTool(spectatorPage, "apply_canvas_transaction", { operations: [] }),
      ).rejects.toThrow("WebMCP tool apply_canvas_transaction is not registered");
      await expect(
        callWebMcpTool(spectatorPage, "render_canvas_preview", {
          scope: { kind: "diagram", diagramId, expectedRevision: spectatorDescription.diagram.revision },
        }),
      ).rejects.toThrow("WebMCP tool render_canvas_preview is not registered");
      await expect(
        callWebMcpTool(spectatorPage, "follow_participant", {
          participantId: host.participantId,
          target: "human",
        }),
      ).rejects.toThrow("WebMCP tool follow_participant is not registered");
    } finally {
      await spectatorContext.close();
    }
  });

  test("keeps semantic connector routes clean, explicit, layout-safe, and exactly previewable", async ({
    browser,
    page,
  }) => {
    test.setTimeout(120_000);
    await installWebMcpShim(page);
    const host = await createRoomFromLanding(page, "Routing Acceptance");
    await expectRegisteredSurface(page, PARTICIPANT_ROOM_TOOL_NAMES);

    const created = successData(
      await callWebMcpTool<TransactionData>(page, "apply_canvas_transaction", {
        operations: [
          {
            op: "create_node",
            tempRef: "source",
            label: "Request source",
            nodeType: "component",
            x: 120,
            y: 240,
            width: 220,
            height: 120,
          },
          {
            op: "create_node",
            tempRef: "blocker",
            label: "Unrelated service",
            nodeType: "service",
            x: 480,
            y: 240,
            width: 220,
            height: 120,
          },
          {
            op: "create_node",
            tempRef: "target",
            label: "Request target",
            nodeType: "service",
            x: 840,
            y: 240,
            width: 220,
            height: 120,
          },
          {
            op: "connect",
            tempRef: "auto_route",
            start: { tempRef: "source" },
            end: { tempRef: "target" },
            direction: "end",
            label: "Obstacle-aware auto route",
          },
          {
            op: "connect",
            tempRef: "straight_route",
            start: { tempRef: "source" },
            end: { tempRef: "target" },
            direction: "end",
            label: "Intentional straight overlay",
            routing: { mode: "straight", labelPosition: 0.2 },
          },
          {
            op: "connect",
            tempRef: "curved_route",
            start: { tempRef: "source" },
            end: { tempRef: "target" },
            direction: "end",
            label: "Explicit curved route",
            routing: { mode: "curved", bend: -180, labelPosition: 0.5 },
          },
          {
            op: "connect",
            tempRef: "elbow_route",
            start: { tempRef: "source" },
            end: { tempRef: "target" },
            direction: "end",
            label: "Explicit elbow route",
            routing: { mode: "elbow", elbowMidPoint: 0.72, labelPosition: 0.75 },
          },
          {
            op: "create_diagram",
            tempRef: "routing_diagram",
            diagramId: "diagram_connector_routing_e2e",
            title: "Connector routing acceptance",
            description:
              "Exercises auto obstacle avoidance while preserving explicit straight, curved, and elbow intent.",
            diagramType: "architecture",
            category: "routing",
            tags: ["connectors", "routing", "obstacle-avoidance"],
            members: [{ tempRef: "source" }, { tempRef: "blocker" }, { tempRef: "target" }],
            connectors: [
              { tempRef: "auto_route" },
              { tempRef: "straight_route" },
              { tempRef: "curved_route" },
              { tempRef: "elbow_route" },
            ],
          },
        ],
      }),
    );

    expect(created.changedObjectIds).toHaveLength(7);
    expect(created.changedDiagramIds).toEqual(["diagram_connector_routing_e2e"]);
    const refs = created.temporaryReferences;
    const nodeIds = [refs.source, refs.blocker, refs.target];
    const connectorIds = [
      refs.auto_route,
      refs.straight_route,
      refs.curved_route,
      refs.elbow_route,
    ];
    const blocker = created.objects.find((object) => object.id === refs.blocker);
    if (!blocker) throw new Error("The routing blocker was not returned by the transaction.");

    const autoRoute = requireConnector(created.objects, refs.auto_route);
    const straightRoute = requireConnector(created.objects, refs.straight_route);
    const curvedRoute = requireConnector(created.objects, refs.curved_route);
    const elbowRoute = requireConnector(created.objects, refs.elbow_route);
    expect(autoRoute.routing).toMatchObject({ mode: "auto" });
    expect(autoRoute.routing.kind).not.toBe("straight");
    expect(routeIntersectsBounds(canonicalRoutePoints(autoRoute), blocker)).toBe(false);
    expect(straightRoute.routing).toEqual({
      mode: "straight",
      kind: "straight",
      bend: 0,
      elbowMidPoint: 0.5,
      labelPosition: 0.2,
    });
    expect(routeIntersectsBounds(canonicalRoutePoints(straightRoute), blocker)).toBe(true);
    expect(curvedRoute.routing).toEqual({
      mode: "curved",
      kind: "curved",
      bend: -180,
      elbowMidPoint: 0.5,
      labelPosition: 0.5,
    });
    expect(elbowRoute.routing).toEqual({
      mode: "elbow",
      kind: "elbow",
      bend: 0,
      elbowMidPoint: 0.72,
      labelPosition: 0.75,
    });

    for (const connector of [autoRoute, straightRoute, curvedRoute, elbowRoute]) {
      expect(connector.start).toMatchObject({
        objectId: refs.source,
        normalizedAnchor: { x: expect.any(Number), y: expect.any(Number) },
        isPrecise: expect.any(Boolean),
        isExact: expect.any(Boolean),
        snap: expect.stringMatching(/^(center|edge-point|edge|none)$/),
      });
      expect(connector.end).toMatchObject({
        objectId: refs.target,
        normalizedAnchor: { x: expect.any(Number), y: expect.any(Number) },
        isPrecise: expect.any(Boolean),
        isExact: expect.any(Boolean),
        snap: expect.stringMatching(/^(center|edge-point|edge|none)$/),
      });
    }
    if (autoRoute.routing.kind === "curved") {
      expect(autoRoute.start).toMatchObject({ isPrecise: true, isExact: true });
      expect(autoRoute.end).toMatchObject({ isPrecise: true, isExact: true });
    }
    for (const connector of [straightRoute, curvedRoute, elbowRoute]) {
      expect(connector.start.isExact).toBe(false);
      expect(connector.end.isExact).toBe(false);
    }
    for (const endpoint of [elbowRoute.start, elbowRoute.end]) {
      expect(endpoint.isPrecise).toBe(true);
      expect(endpoint.normalizedAnchor).toBeDefined();
      const anchor = endpoint.normalizedAnchor!;
      expect(Math.min(anchor.x, anchor.y, 1 - anchor.x, 1 - anchor.y)).toBe(0);
    }

    const updatedCurve = successData(
      await callWebMcpTool<CreateObjectData>(page, "update_object", {
        objectId: refs.curved_route,
        expectedRevision: curvedRoute.revision,
        operation: "connect",
        patch: { routing: { mode: "curved", bend: -220, labelPosition: 0.4 } },
      }),
    );
    expect(requireConnector(updatedCurve.objects, refs.curved_route).routing).toEqual({
      mode: "curved",
      kind: "curved",
      bend: -220,
      elbowMidPoint: 0.5,
      labelPosition: 0.4,
    });

    const beforeLayout = successData(
      await callWebMcpTool<ReadDiagramData>(page, "read_diagram", {
        diagramId: "diagram_connector_routing_e2e",
      }),
    );
    successData(
      await callWebMcpTool<LayoutData>(page, "layout_objects", {
        layout: "grid",
        direction: "right",
        density: "comfortable",
        columns: 3,
        origin: { x: 160, y: 220 },
        diagramId: beforeLayout.diagram.id,
        expectedDiagramRevision: beforeLayout.diagram.revision,
        targets: beforeLayout.objects.map((object) => ({
          objectId: object.id,
          expectedRevision: object.revision,
        })),
      }),
    );

    const afterLayout = successData(
      await callWebMcpTool<ReadDiagramData>(page, "read_diagram", {
        diagramId: beforeLayout.diagram.id,
      }),
    );
    expect(afterLayout.diagram).toMatchObject({
      id: "diagram_connector_routing_e2e",
      memberObjectIds: nodeIds,
      connectorIds,
      lastEditedBy: { kind: "agent" },
    });
    const routedAfterLayout = {
      auto: requireConnector(afterLayout.connectors, refs.auto_route),
      straight: requireConnector(afterLayout.connectors, refs.straight_route),
      curved: requireConnector(afterLayout.connectors, refs.curved_route),
      elbow: requireConnector(afterLayout.connectors, refs.elbow_route),
    };
    expect(routedAfterLayout.auto.routing.mode).toBe("auto");
    expect(routedAfterLayout.straight.routing).toMatchObject({
      mode: "straight",
      kind: "straight",
      labelPosition: 0.2,
    });
    expect(routedAfterLayout.curved.routing).toMatchObject({
      mode: "curved",
      kind: "curved",
      bend: -220,
      labelPosition: 0.4,
    });
    expect(routedAfterLayout.elbow.routing).toMatchObject({
      mode: "elbow",
      kind: "elbow",
      elbowMidPoint: 0.72,
      labelPosition: 0.75,
    });
    const blockerAfterLayout = afterLayout.objects.find((object) => object.id === refs.blocker);
    if (!blockerAfterLayout) throw new Error("The laid-out routing blocker is missing.");
    expect(
      routeIntersectsBounds(canonicalRoutePoints(routedAfterLayout.auto), blockerAfterLayout),
    ).toBe(false);
    expect(
      routeIntersectsBounds(canonicalRoutePoints(routedAfterLayout.straight), blockerAfterLayout),
    ).toBe(true);

    const expectedRenderedRevisions = {
      auto: routedAfterLayout.auto.revision,
      straight: routedAfterLayout.straight.revision,
      curved: routedAfterLayout.curved.revision,
      elbow: routedAfterLayout.elbow.revision,
    };
    const hostRendering = await readAndAssertRenderedRoutes(
      page,
      refs,
      expectedRenderedRevisions,
    );

    const collaboratorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const collaboratorPage = await collaboratorContext.newPage();
      await installWebMcpShim(collaboratorPage);
      await collaboratorPage.goto("/");
      await expectRegisteredSurface(collaboratorPage, LANDING_WEBMCP_TOOL_NAMES);
      successData(
        await callNavigationTool<LandingRoomData>(
          collaboratorPage,
          "join_room",
          { code: host.room.code, displayName: "Routing Collaborator", role: "participant" },
          /\/room\/room_[^/?#]+$/,
        ),
      );
      await expectSemanticCanvas(collaboratorPage);
      await expectRegisteredSurface(collaboratorPage, PARTICIPANT_ROOM_TOOL_NAMES);

      const collaboratorDiagram = successData(
        await callWebMcpTool<ReadDiagramData>(collaboratorPage, "read_diagram", {
          diagramId: afterLayout.diagram.id,
        }),
      );
      expect(collaboratorDiagram.diagram.revision).toBe(afterLayout.diagram.revision);
      for (const [key, objectId] of [
        ["auto", refs.auto_route],
        ["straight", refs.straight_route],
        ["curved", refs.curved_route],
        ["elbow", refs.elbow_route],
      ] as const) {
        expect(requireConnector(collaboratorDiagram.connectors, objectId).routing).toEqual(
          routedAfterLayout[key].routing,
        );
      }

      const collaboratorRendering = await readAndAssertRenderedRoutes(
        collaboratorPage,
        refs,
        expectedRenderedRevisions,
      );
      for (const key of ["auto", "straight", "curved", "elbow"] as const) {
        // Private camera state can place the same shared connector at different
        // page coordinates. Compare exact semantic canvas geometry here; each
        // client independently proves visual obstacle and label clearance above.
        expectRenderedConnectorParity(collaboratorRendering[key], hostRendering[key], key);
      }
    } finally {
      await collaboratorContext.close();
    }

    const preview = successData(
      await callWebMcpTool<CanvasPreviewData>(page, "render_canvas_preview", {
        scope: {
          kind: "diagram",
          diagramId: afterLayout.diagram.id,
          expectedRevision: afterLayout.diagram.revision,
        },
        maxWidth: 1_100,
        maxHeight: 600,
      }),
    );
    const revisionByObjectId = new Map(
      [...afterLayout.objects, ...afterLayout.connectors].map((object) => [
        object.id,
        object.revision,
      ]),
    );
    expect(preview).toMatchObject({
      previewId: expect.stringMatching(/^preview_/),
      screenshotClip: {
        coordinateSpace: "viewport-css-pixels",
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      },
      mimeType: "image/png",
      scope: {
        kind: "diagram",
        diagramId: afterLayout.diagram.id,
        expectedRevision: afterLayout.diagram.revision,
      },
      sourceRevisions: {
        diagramRevision: afterLayout.diagram.revision,
        objects: expect.arrayContaining(
          [...nodeIds, ...connectorIds].map((objectId) => ({
            objectId,
            revision: revisionByObjectId.get(objectId),
          })),
        ),
      },
    });
    expect(preview.byteLength).toBeGreaterThan(0);
    expect(preview.presentation).toBe("live_canvas");
    await expect(page.getByRole("dialog", { name: "Canvas preview" })).toHaveCount(0);
    const exactPreviewPng = await page.screenshot({
      type: "png",
      clip: preview.screenshotClip,
    });
    expect(exactPreviewPng.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(exactPreviewPng.length).toBeGreaterThan(512);
    const authoritative = await getRoom(page.request, host.room.id);
    expect(authoritative.room.diagrams[afterLayout.diagram.id]).toMatchObject({
      id: afterLayout.diagram.id,
      revision: afterLayout.diagram.revision,
      connectorIds,
    });
    expect(Object.keys(authoritative.room.leases)).toEqual([]);
  });

  test("shares agent text, a human freehand gesture, and a picked PNG through authoritative room state", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await installWebMcpShim(page);
    const host = await createRoomFromLanding(page, "Browser Acceptance");
    await expect(page.getByTestId("connection-status")).toHaveAccessibleName(/Connection: (Live|Synced)/, {
      timeout: 15_000,
    });

    await expectRegisteredSurface(page, PARTICIPANT_ROOM_TOOL_NAMES);
    await expect(page.getByTestId("site-tools-status")).toHaveCount(0);

    const created = await callWebMcpTool<CreateObjectData>(page, "create_text", {
      content: WEBMCP_TEXT,
      x: 120,
      y: 120,
      width: 320,
      height: 96,
    });
    expect(created).toMatchObject({
      ok: true,
      tool: "create_text",
      data: {
        changedObjectIds: [expect.any(String)],
        objects: [{ kind: "text", content: WEBMCP_TEXT }],
      },
    });

    const observed = await callWebMcpTool<ReadRoomData>(page, "read_room_state", {});
    expect(observed).toMatchObject({ ok: true, tool: "read_room_state" });
    if (!observed.ok) throw new Error(observed.error.message);
    expect(observed.data.room.id).toBe(host.room.id);
    expect(observed.data.objects).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "text", content: WEBMCP_TEXT })]),
    );

    await expectSemanticCanvas(page);
    await page.getByRole("button", { name: "Draw tool" }).click();
    const canvasBox = await semanticCanvas(page).boundingBox();
    if (!canvasBox) throw new Error("The semantic canvas has no browser layout box.");
    const start = {
      x: canvasBox.x + canvasBox.width * 0.57,
      y: canvasBox.y + canvasBox.height * 0.58,
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const [dx, dy] of [
      [24, -18],
      [50, 8],
      [76, -22],
      [104, 16],
      [132, -8],
    ]) {
      await page.mouse.move(start.x + dx, start.y + dy, { steps: 4 });
    }
    await page.mouse.up();

    await expect
      .poll(
        async () => Object.values((await getRoom(page.request, host.room.id)).room.objects).filter(
          (object) => object.kind === "draw",
        ).length,
        { timeout: 15_000 },
      )
      .toBe(1);

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "Image tool" }).click(),
    ]);
    await chooser.setFiles({
      name: "browser-acceptance.png",
      mimeType: "image/png",
      buffer: TINY_PNG,
    });
    const imageReview = page.getByRole("dialog", { name: "Add an accessible image" });
    await expect(imageReview.getByLabel("Image description")).toHaveValue("browser acceptance");
    await imageReview.getByRole("button", { name: "Add to canvas" }).click();

    await expect
      .poll(
        async () => {
          const state = await getRoom(page.request, host.room.id);
          return new Set(Object.values(state.room.objects).map((object) => object.kind));
        },
        { timeout: 20_000 },
      )
      .toEqual(new Set(["text", "draw", "image"]));

    const authoritative = await getRoom(page.request, host.room.id);
    const objects = Object.values(authoritative.room.objects);
    expect(objects.find((object) => object.kind === "text")).toMatchObject({
      kind: "text",
      content: WEBMCP_TEXT,
      createdBy: { kind: "agent", participantId: host.participantId },
    });
    expect(objects.find((object) => object.kind === "draw")).toMatchObject({
      kind: "draw",
      createdBy: { kind: "human", participantId: host.participantId },
    });
    const image = objects.find((object) => object.kind === "image");
    expect(image).toMatchObject({
      kind: "image",
      alt: "browser acceptance",
      mimeType: "image/png",
      createdBy: { kind: "human", participantId: host.participantId },
    });
    expect(String(image?.url)).toMatch(
      new RegExp(`^/api/rooms/${host.room.id}/assets\\?(?:pathname|assetId)=`),
    );
    expect(String(image?.url)).not.toContain("blob.vercel-storage.com");
    const storedImage = await page.request.get(String(image?.url));
    expect(storedImage.status()).toBe(200);
    expect(storedImage.headers()["content-type"]).toBe("image/png");
    expect(Buffer.from(await storedImage.body())).toEqual(TINY_PNG);

    if (!image) throw new Error("The authoritative image object is missing.");
    const [webMcpPngDownload, webMcpPngResult] = await Promise.all([
      page.waitForEvent("download"),
      callWebMcpTool<{
        filename: string;
        mimeType: string;
        width: number;
        height: number;
        byteLength: number;
        persistedByJazzboard: boolean;
      }>(page, "export_canvas_png", {
        scope: {
          kind: "objects",
          targets: [{ objectId: image.id, expectedRevision: image.revision }],
        },
        filename: "Browser acceptance image",
      }),
    ]);
    expect(successData(webMcpPngResult)).toMatchObject({
      filename: "browser-acceptance-image.png",
      mimeType: "image/png",
      persistedByJazzboard: false,
    });
    const webMcpPngPath = await webMcpPngDownload.path();
    expect(webMcpPngPath).not.toBeNull();
    const webMcpPng = await readFile(webMcpPngPath!);
    const webMcpPixels = await page.evaluate(async (base64) => {
      const response = await fetch(`data:image/png;base64,${base64}`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas decoding is unavailable.");
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let sourceColorPixels = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] > 220 && data[index + 1] < 40 && data[index + 2] > 140 && data[index + 3] > 240) {
          sourceColorPixels += 1;
        }
      }
      return sourceColorPixels;
    }, webMcpPng.toString("base64"));
    expect(webMcpPixels).toBeGreaterThan(0);

    await expect
      .poll(() =>
        semanticCanvas(page).locator("[data-object-id]").evaluateAll((elements) =>
          [...new Set(elements.map((element) => element.getAttribute("data-object-id")))].sort(),
        ),
      )
      .toEqual(objects.map((object) => object.id).sort());

    await expect(page.getByRole("button", { name: "Select tool" })).toBeVisible();
    await expectSemanticCanvas(page);
  });
});
