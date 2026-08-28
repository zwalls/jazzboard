import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";

import {
  createRoomViaApi,
  jsonBody,
  selectBoardMenuItem,
  type RoomState,
} from "./helpers";

const TEXT_ID = "aesthetic-text";
const GENERIC_ID = "aesthetic-generic";
const SERVICE_ID = "aesthetic-service";
const REQUIREMENT_ID = "aesthetic-requirement";
const DECISION_ID = "aesthetic-decision";
const QUESTION_ID = "aesthetic-question";
const CONNECTOR_ID = "aesthetic-connector";
const DRAW_ID = "aesthetic-draw";

const FONT_FAMILY = "Shantell Sans,Comic Sans MS,Comic Sans,cursive";
const FONT_URL = "/fonts/shantell-sans-latin-400-normal.woff2";

type SemanticTransactionResponse = {
  ok: true;
  room: RoomState;
  changedObjectIds: string[];
};

function shape(
  id: string,
  input: {
    x: number;
    y: number;
    label: string;
    fill: string;
    stroke: string;
    nodeType: "service" | "requirement" | "decision" | "open_question" | null;
    geometry?: "rectangle" | "ellipse" | "diamond";
  },
) {
  return {
    id,
    kind: "shape" as const,
    x: input.x,
    y: input.y,
    width: 240,
    height: 140,
    rotation: 0,
    zIndex: 1,
    groupId: null,
    shape: input.geometry ?? "rectangle",
    nodeType: input.nodeType,
    label: input.label,
    fill: input.fill,
    stroke: input.stroke,
  };
}

async function seedAestheticScene(request: APIRequestContext, roomId: string): Promise<void> {
  const response = await request.post(`/api/rooms/${encodeURIComponent(roomId)}/semantic`, {
    data: {
      action: "transaction",
      transaction: {
        commands: [
          {
            type: "create",
            object: {
              id: TEXT_ID,
              kind: "text",
              x: 150,
              y: 90,
              width: 420,
              height: 80,
              rotation: 0,
              zIndex: 3,
              groupId: null,
              content: "Friendly, semantic architecture",
              color: "black",
              size: "m",
              align: "start",
            },
          },
          {
            type: "create",
            object: shape(GENERIC_ID, {
              x: 150,
              y: 230,
              label: "Generic canvas shape",
              fill: "blue",
              stroke: "blue",
              nodeType: null,
            }),
          },
          {
            type: "create",
            object: shape(SERVICE_ID, {
              x: 520,
              y: 230,
              label: "Room service",
              fill: "green",
              stroke: "green",
              nodeType: "service",
              geometry: "ellipse",
            }),
          },
          {
            type: "create",
            object: shape(REQUIREMENT_ID, {
              x: 890,
              y: 230,
              label: "Fast feedback",
              fill: "yellow",
              stroke: "orange",
              nodeType: "requirement",
            }),
          },
          {
            type: "create",
            object: shape(DECISION_ID, {
              x: 150,
              y: 500,
              label: "Use semantic state",
              fill: "violet",
              stroke: "violet",
              nodeType: "decision",
              geometry: "diamond",
            }),
          },
          {
            type: "create",
            object: shape(QUESTION_ID, {
              x: 520,
              y: 500,
              label: "What should we test next?",
              fill: "light-red",
              stroke: "red",
              nodeType: "open_question",
            }),
          },
          {
            type: "create",
            object: {
              id: CONNECTOR_ID,
              kind: "connector",
              x: 390,
              y: 270,
              width: 130,
              height: 60,
              rotation: 0,
              zIndex: 2,
              groupId: null,
              start: {
                x: 390,
                y: 300,
                objectId: GENERIC_ID,
                normalizedAnchor: { x: 1, y: 0.5 },
                isPrecise: true,
                isExact: false,
                snap: "edge",
              },
              end: {
                x: 520,
                y: 300,
                objectId: SERVICE_ID,
                normalizedAnchor: { x: 0, y: 0.5 },
                isPrecise: true,
                isExact: false,
                snap: "edge",
              },
              routing: {
                mode: "elbow",
                kind: "elbow",
                bend: 0,
                elbowMidPoint: 0.5,
                labelPosition: 0.5,
              },
              direction: "end",
              label: "semantic event",
              color: "orange",
            },
          },
          {
            type: "create",
            object: {
              id: DRAW_ID,
              kind: "draw",
              x: 880,
              y: 520,
              width: 210,
              height: 100,
              rotation: 0,
              zIndex: 4,
              groupId: null,
              points: [
                { x: 0, y: 70 },
                { x: 40, y: 20 },
                { x: 90, y: 78 },
                { x: 145, y: 14 },
                { x: 210, y: 58 },
              ],
              color: "green",
              size: "m",
            },
          },
        ],
        diagramCommands: [],
      },
    },
  });
  const seeded = await jsonBody<SemanticTransactionResponse>(response);
  expect(new Set(seeded.changedObjectIds)).toEqual(new Set([
    TEXT_ID,
    GENERIC_ID,
    SERVICE_ID,
    REQUIREMENT_ID,
    DECISION_ID,
    QUESTION_ID,
    CONNECTOR_ID,
    DRAW_ID,
  ]));
}

function object(canvas: Locator, id: string): Locator {
  return canvas.locator(`[data-object-id="${id}"]`);
}

async function expectShapePalette(
  canvas: Locator,
  id: string,
  expected: { fill: string; stroke: string },
): Promise<void> {
  const geometry = object(canvas, id).locator(".semantic-canvas-object__shape");
  await expect(geometry).toHaveAttribute("fill", expected.fill);
  await expect(geometry).toHaveAttribute("stroke", expected.stroke);
  await expect(geometry).toHaveAttribute("stroke-width", "3.5");

  const label = object(canvas, id).locator(".semantic-canvas-object__label");
  await expect(label).toHaveAttribute("fill", expected.stroke);
  await expect(label).toHaveAttribute("font-size", "22");
  await expect(label).toHaveAttribute("font-family", FONT_FAMILY);
}

test("keeps the first-party canvas on Jazzboard's tldraw-inspired visual contract", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const host = await createRoomViaApi(page.request, "Avery Aesthetic", "Canvas aesthetic contract");
  await seedAestheticScene(page.request, host.room.id);
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);

  const canvas = page.getByTestId("semantic-canvas");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect(canvas).toHaveAttribute("data-canvas-renderer", "jazzboard-semantic-v1");

  const font = await page.evaluate(async ({ family, textId, url }) => {
    const response = await fetch(url);
    const byteLength = (await response.arrayBuffer()).byteLength;
    const faces = await document.fonts.load(`24px "${family}"`, "Canvas aesthetic");
    await document.fonts.ready;
    const text = document.querySelector<SVGTextElement>(
      `[data-object-id="${textId}"] .semantic-canvas-object__text`,
    );
    if (!text) throw new Error("The representative canvas text was not rendered.");
    return {
      byteLength,
      contentType: response.headers.get("content-type"),
      faces: faces.length,
      available: document.fonts.check(`24px "${family}"`, "Canvas aesthetic"),
      computedFamily: getComputedStyle(text).fontFamily,
    };
  }, { family: "Shantell Sans", textId: TEXT_ID, url: FONT_URL });
  expect(font).toMatchObject({
    available: true,
    computedFamily: '"Shantell Sans", "Comic Sans MS", "Comic Sans", cursive',
  });
  expect(font.faces).toBeGreaterThan(0);
  expect(font.byteLength).toBeGreaterThan(40_000);
  expect(font.contentType).toMatch(/font|woff|octet-stream/i);

  const text = object(canvas, TEXT_ID).locator(".semantic-canvas-object__text");
  await expect(text).toHaveAttribute("font-family", FONT_FAMILY);
  await expect(text).toHaveAttribute("font-size", "24");
  await expect(text).toHaveAttribute("fill", "#1d1d1d");

  await expectShapePalette(canvas, GENERIC_ID, { fill: "#dce1f8", stroke: "#4465e9" });
  await expectShapePalette(canvas, SERVICE_ID, { fill: "#d3e9e3", stroke: "#099268" });
  await expectShapePalette(canvas, REQUIREMENT_ID, { fill: "#f9f0e6", stroke: "#e16919" });
  await expectShapePalette(canvas, DECISION_ID, { fill: "#ecdcf2", stroke: "#ae3ec9" });
  await expectShapePalette(canvas, QUESTION_ID, { fill: "#f4dadb", stroke: "#e03131" });

  const connector = object(canvas, CONNECTOR_ID);
  const connectorPath = connector.locator(".semantic-canvas-object__connector-path");
  await expect(connectorPath).toHaveAttribute("stroke", "#e16919");
  await expect(connectorPath).toHaveAttribute("stroke-width", "3.5");
  const connectorLabel = connector.locator(".semantic-canvas-object__connector-label-text");
  await expect(connectorLabel).toHaveAttribute("font-family", FONT_FAMILY);
  await expect(connectorLabel).toHaveAttribute("font-size", "20");
  await expect(connectorLabel).toHaveAttribute("fill", "#e16919");
  const connectorMask = connector.locator(".semantic-canvas-object__connector-label rect");
  await expect(connectorMask).toHaveAttribute("fill", "#f9fafb");
  await expect(connectorMask).toHaveAttribute("stroke", "none");
  expect(await connectorMask.evaluate((element) => getComputedStyle(element).stroke)).toBe("none");

  const draw = object(canvas, DRAW_ID).locator(".semantic-canvas-object__draw");
  await expect(draw).toHaveAttribute("stroke", "#099268");
  await expect(draw).toHaveAttribute("stroke-width", "4.5");

  const generic = object(canvas, GENERIC_ID);
  await generic.click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(generic).toHaveAttribute("data-selected", "true");
  await expect(generic.locator(".semantic-canvas-object__selection")).toHaveCount(0);

  const frame = page.getByTestId("semantic-selection-frame");
  await expect(frame).toHaveCount(1);
  const frameStyle = await frame.evaluate((element) => {
    const style = getComputedStyle(element);
    let declaredBorderWidth = "";
    for (const sheet of document.styleSheets) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSStyleRule) || !element.matches(rule.selectorText)) continue;
        const width = rule.style.getPropertyValue("border-top-width");
        if (width) declaredBorderWidth = width;
      }
    }
    return {
      borderColor: style.borderTopColor,
      borderStyle: style.borderTopStyle,
      declaredBorderWidth,
      boxShadow: style.boxShadow,
    };
  });
  expect(frameStyle).toEqual({
    borderColor: "rgb(49, 130, 237)",
    borderStyle: "solid",
    declaredBorderWidth: "1.5px",
    boxShadow: "none",
  });

  const resizeHandles = frame.locator('[data-transform-handle^="resize-"]');
  await expect(resizeHandles).toHaveCount(8);
  const selectionHandles = frame.locator(
    '[data-transform-handle^="resize-"], [data-transform-handle="rotate"]',
  );
  await expect(selectionHandles).toHaveCount(9);
  const handleStyles = await selectionHandles.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    let declaredBorderWidth = "";
    for (const sheet of document.styleSheets) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSStyleRule) || !element.matches(rule.selectorText)) continue;
        const width = rule.style.getPropertyValue("border-top-width");
        if (width) declaredBorderWidth = width;
      }
    }
    return {
      width: style.width,
      height: style.height,
      borderColor: style.borderTopColor,
      declaredBorderWidth,
      boxShadow: style.boxShadow,
    };
  }));
  for (const style of handleStyles) {
    expect(style).toEqual({
      width: "8px",
      height: "8px",
      borderColor: "rgb(49, 130, 237)",
      declaredBorderWidth: "1.5px",
      boxShadow: "none",
    });
  }

  await selectBoardMenuItem(page, "Export");
  const exportPanel = page.getByRole("complementary", { name: "Export board" });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportPanel.getByRole("button", { name: "PNG" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("canvas-aesthetic-contract.png");
  const pngPath = await download.path();
  if (!pngPath) throw new Error("The aesthetic PNG export did not produce a file.");
  const png = await readFile(pngPath);
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  expect(png.byteLength).toBeGreaterThan(2_000);
});
