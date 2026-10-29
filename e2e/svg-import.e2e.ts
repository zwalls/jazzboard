/// <reference types="webmcp-types" />

import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

import { CLIENT_CAPABILITIES_HEADER } from "../src/lib/realtime/protocol";
import { createRoomViaApi, getRoom, jsonBody } from "./helpers";

type ToolResult<T> =
  | { ok: true; tool: string; data: T }
  | { ok: false; tool: string; error: { code: string; message: string } };

type ImportReceipt = {
  outcome: "applied";
  roomRevision: number;
  nativeEditable: boolean;
  counts: { parts: number; paths: number };
  idMap: { parts: Array<{ sourceIndex: number; sourceName: string; nativeObjectId: string }> };
};

// The same registration harness used by deployed-webmcp.e2e.ts. Calls still
// execute the application's registered handlers and real room API routes.
async function installWebMcpShim(page: Page) {
  await page.addInitScript(() => {
    const tools = new Map<string, WebMCP.ModelContextTool>();
    (window as Window & { __jazzboardWebMcpTools?: typeof tools }).__jazzboardWebMcpTools = tools;
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
      window,
      origin: window.location.origin,
      annotations: tool.annotations,
    }));
    Object.defineProperty(document, "modelContext", { configurable: true, value: modelContext });
  });
}

async function callTool<T>(page: Page, name: string, input: Record<string, unknown>) {
  return page.evaluate(async ({ name, input }) => {
    const tool = (window as Window & {
      __jazzboardWebMcpTools?: Map<string, WebMCP.ModelContextTool>;
    }).__jazzboardWebMcpTools?.get(name);
    if (!tool) throw new Error(`WebMCP tool ${name} is not registered.`);
    return tool.execute(input, { signal: new AbortController().signal });
  }, { name, input }) as Promise<ToolResult<T>>;
}

function successData<T>(result: ToolResult<T>): T {
  if (!result.ok) throw new Error(`${result.tool}: ${result.error.code} ${result.error.message}`);
  return result.data;
}

async function expectPaintedPixels(png: Buffer, hex: string) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  let matches = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (rgb.every((channel, index) => data[offset + index] === channel)) matches += 1;
  }
  expect(matches, `Rendered pixels must include the literal SVG paint ${hex}`).toBeGreaterThan(20);
}

const artwork = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="160" viewBox="0 0 520 160">
  <rect id="rect-panel" x="10" y="35" width="75" height="70" fill="green"/>
  <ellipse id="ellipse-petal" cx="150" cy="70" rx="40" ry="30" fill="purple"/>
  <circle id="circle-center" cx="250" cy="70" r="35" fill="blue"/>
  <polygon id="polygon-leaf" points="310,105 350,30 390,105" fill="#70A979"/>
  <path id="curved-ribbon" d="m430 45 c0 -25 60 -25 60 0 q20 35 -30 65 q-50 -30 -30 -65z" fill="rgb(184,74,90)"/>
</svg>`;
const parts = [
  { name: "rect-panel", fill: "#008000" },
  { name: "ellipse-petal", fill: "#800080" },
  { name: "circle-center", fill: "#0000ff" },
  { name: "polygon-leaf", fill: "#70a979" },
  { name: "curved-ribbon", fill: "#b84a5a" },
];

test("imports literal SVG paints as editable paths with atomic numeric rejection and PNG export", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await installWebMcpShim(page);
  const host = await createRoomViaApi(page.request, "SVG browser reviewer", "Editable SVG artwork");
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  await expect(page.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (window as Window & {
    __jazzboardWebMcpTools?: Map<string, WebMCP.ModelContextTool>;
  }).__jazzboardWebMcpTools?.has("import_svg_artwork")), { timeout: 15_000 }).toBe(true);

  const before = await getRoom(page.request, host.room.id);
  const receipt = successData(await callTool<ImportReceipt>(page, "import_svg_artwork", {
    expectedRoomRevision: before.room.roomRevision,
    source: artwork,
    title: "Editable SVG artwork",
    origin: { x: 120, y: 100 },
  }));
  expect(receipt).toMatchObject({
    outcome: "applied",
    nativeEditable: true,
    roomRevision: before.room.roomRevision + 1,
    counts: { parts: 5, paths: 5 },
  });
  expect(receipt.idMap.parts.map(({ sourceIndex, sourceName }) => ({ sourceIndex, sourceName })))
    .toEqual(parts.map((part, sourceIndex) => ({ sourceIndex, sourceName: part.name })));
  const nativeIds = receipt.idMap.parts.map((part) => part.nativeObjectId);
  expect(new Set(nativeIds).size).toBe(5);

  const imported = await getRoom(page.request, host.room.id);
  expect(Object.keys(imported.room.objects).sort()).toEqual([...nativeIds].sort());
  const diagrams = Object.values(imported.room.diagrams);
  expect(diagrams).toHaveLength(1);
  expect(diagrams[0].memberObjectIds).toEqual(nativeIds);
  for (const [index, part] of parts.entries()) {
    expect(imported.room.objects[nativeIds[index]]).toMatchObject({
      kind: "path", semanticName: part.name, fill: part.fill, closed: true,
    });
  }
  expect(imported.room.objects[nativeIds[4]].segments).toEqual([
    expect.objectContaining({ kind: "cubic" }),
    expect.objectContaining({ kind: "quadratic" }),
    expect.objectContaining({ kind: "quadratic" }),
  ]);

  successData(await callTool(page, "control_local_viewport", { action: "fit_objects", objectIds: nativeIds }));
  const canvas = page.getByTestId("semantic-canvas");
  for (const [index, part] of parts.entries()) {
    const object = canvas.locator(`[data-object-id="${nativeIds[index]}"]`);
    await expect(object).toHaveAttribute("data-object-kind", "path");
    await expect(object).toBeVisible({ timeout: 20_000 });
    await expect(object.locator("image, canvas")).toHaveCount(0);
    const path = object.locator(".semantic-canvas-object__path");
    await expect(path).toHaveAttribute("fill", part.fill);
    await expectPaintedPixels(await path.screenshot(), part.fill);
  }
  const screenshotPath = testInfo.outputPath("imported-native-svg-artwork.png");
  await canvas.screenshot({ path: screenshotPath });
  await testInfo.attach("imported-native-svg-artwork", { path: screenshotPath, contentType: "image/png" });

  // A receipt's native ID remains directly editable after import.
  const editedFill = "#26593e";
  successData(await callTool(page, "update_object", {
    objectId: nativeIds[0],
    expectedRevision: imported.room.objects[nativeIds[0]].revision,
    patch: { fill: editedFill },
  }));
  const editedPath = canvas.locator(`[data-object-id="${nativeIds[0]}"] .semantic-canvas-object__path`);
  await expect(editedPath).toHaveAttribute("fill", editedFill);
  // The agent's temporary edit highlight can tint the committed path until
  // its reveal completes; assert the final pixels without a fixed delay.
  await expect(async () => {
    await expectPaintedPixels(await editedPath.screenshot(), editedFill);
  }).toPass({ timeout: 15_000 });

  const beforeRejections = await getRoom(page.request, host.room.id);
  for (const malformedPart of [
    '<rect width="0x20" height="20"/>',
    '<path d="M0 0 L20 1e"/>',
    '<polygon points="0,0 20,0 20"/>',
  ]) {
    const result = await callTool(page, "import_svg_artwork", {
      expectedRoomRevision: beforeRejections.room.roomRevision,
      source: `<svg width="100" height="100" viewBox="0 0 100 100"><rect id="must-not-commit" width="10" height="10"/>${malformedPart}</svg>`,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_OPERATION" } });
    const after = await getRoom(page.request, host.room.id);
    expect(after.room.roomRevision).toBe(beforeRejections.room.roomRevision);
    expect(after.room.objects).toEqual(beforeRejections.room.objects);
    expect(after.room.diagrams).toEqual(beforeRejections.room.diagrams);
  }

  const currentDiagram = Object.values(beforeRejections.room.diagrams)[0];
  const [download, pngResult] = await Promise.all([
    page.waitForEvent("download"),
    callTool<{ filename: string; mimeType: string; byteLength: number }>(page, "export_canvas_png", {
      scope: { kind: "diagram", diagramId: currentDiagram.id, expectedRevision: currentDiagram.revision },
    }),
  ]);
  const pngReceipt = successData(pngResult);
  expect(pngReceipt.mimeType).toBe("image/png");
  expect(download.suggestedFilename()).toBe(pngReceipt.filename);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("PNG download has no local file.");
  const png = await readFile(downloadPath);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.length).toBe(pngReceipt.byteLength);
  for (const fill of [editedFill, ...parts.slice(1).map((part) => part.fill)]) await expectPaintedPixels(png, fill);
  const exportPath = testInfo.outputPath("editable-svg-export.png");
  await download.saveAs(exportPath);
  await testInfo.attach("editable-svg-export", { path: exportPath, contentType: "image/png" });
});

test("recognizes a committed SVG retry without duplicating native parts or presentation", async ({ page }) => {
  await installWebMcpShim(page);
  const host = await createRoomViaApi(page.request, "SVG retry reviewer", "SVG retry receipt");
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  await expect(page.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (window as Window & {
    __jazzboardWebMcpTools?: Map<string, WebMCP.ModelContextTool>;
  }).__jazzboardWebMcpTools?.has("import_svg_artwork")), { timeout: 15_000 }).toBe(true);
  const before = await getRoom(page.request, host.room.id);
  const importRequestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().endsWith(`/api/rooms/${host.room.id}/agent/artifacts`),
  );
  const receipt = successData(await callTool<ImportReceipt>(page, "import_svg_artwork", {
    expectedRoomRevision: before.room.roomRevision,
    source: artwork,
  }));
  const importRequest = await importRequestPromise;
  expect((await importRequest.response())?.status()).toBe(201);
  const imported = await getRoom(page.request, host.room.id);
  const draftsUrl = `/api/rooms/${encodeURIComponent(host.room.id)}/drafts`;
  type DraftList = { drafts: Array<{ id: string; status: string; expiresAt: number; hardExpiresAt: number }> };
  const presentationsBefore = await jsonBody<DraftList>(await page.request.get(draftsUrl));
  expect(presentationsBefore.drafts).toHaveLength(1);
  expect(presentationsBefore.drafts[0].status).toBe("presenting");
  const idempotencyKey = importRequest.headers()["idempotency-key"];
  expect(idempotencyKey).toBeTruthy();
  // The shared mutation protocol reports a verified prior commit without
  // reconstructing its response. Recover the original IDs from room state.
  const replay = await jsonBody<{
    ok: false;
    error: { code: string; details: { replayed: boolean; outcome: string; committedRoomRevision: number } };
  }>(
    await page.request.post(importRequest.url(), {
      headers: {
        "idempotency-key": idempotencyKey,
        [CLIENT_CAPABILITIES_HEADER]: importRequest.headers()[CLIENT_CAPABILITIES_HEADER],
      },
      data: importRequest.postDataJSON(),
    }),
    503,
  );
  expect(replay).toMatchObject({
    ok: false,
    error: {
      code: "MUTATION_OUTCOME_UNKNOWN",
      details: { replayed: true, outcome: "applied", committedRoomRevision: receipt.roomRevision },
    },
  });
  const after = await getRoom(page.request, host.room.id);
  expect(after.room.roomRevision).toBe(imported.room.roomRevision);
  expect(Object.keys(after.room.objects).sort())
    .toEqual(receipt.idMap.parts.map((part) => part.nativeObjectId).sort());
  expect(after.room.objects).toEqual(imported.room.objects);
  expect(after.room.diagrams).toEqual(imported.room.diagrams);
  const presentationsAfter = await jsonBody<DraftList>(await page.request.get(draftsUrl));
  // The short-lived presentation may expire during the reads, but a retry
  // must never create a replacement or extend the original expiry.
  expect(presentationsAfter.drafts.length).toBeLessThanOrEqual(presentationsBefore.drafts.length);
  for (const draft of presentationsAfter.drafts) {
    expect(presentationsBefore.drafts).toContainEqual(expect.objectContaining({
      id: draft.id,
      expiresAt: draft.expiresAt,
      hardExpiresAt: draft.hardExpiresAt,
    }));
  }
});
