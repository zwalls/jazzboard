#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright";

import {
  createExp0036ArtifactMetadata,
  createExp0036FrozenPacketBundle,
  sanitizeExp0036FinalState,
} from "./exp0036-frozen-packet.mjs";

const VIEWPORT = Object.freeze({ width: 1400, height: 1000 });
const PADDING = 32;
const TIMEOUT_MS = 120_000;
const CLIENT_CAPABILITIES = "split-state-v1";
const USAGE = "Usage: exp0036-capture.mjs --attempt attempt05 --origin http://127.0.0.1:PORT --output /absolute/attempt-output";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function documentState(room) {
  const document = { ...room };
  delete document.stateRevision;
  delete document.participants;
  return document;
}

function changedRoomKeys(left, right) {
  return Object.keys({ ...left, ...right }).filter((key) => canonical(left?.[key]) !== canonical(right?.[key])).sort();
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    assert(flag?.startsWith("--") && value !== undefined, USAGE);
    values[flag.slice(2)] = value;
  }
  assert(/^attempt0[5-8]$/.test(values.attempt ?? ""), USAGE);
  const origin = new URL(values.origin ?? "invalid:");
  assert(origin.protocol === "http:" && origin.origin === values.origin
    && ["127.0.0.1", "localhost"].includes(origin.hostname),
  "Capture origin must be an exact loopback HTTP origin.");
  assert(path.isAbsolute(values.output ?? ""), "Capture output must be an absolute path.");
  return { attemptId: values.attempt, origin: origin.origin, output: path.resolve(values.output) };
}

function installWebMcpHostShim() {
  const tools = new Map();
  Object.defineProperty(window, "__jazzboardExp0036CaptureTools", { configurable: true, value: tools });
  const modelContext = new EventTarget();
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
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? {},
  }));
  Object.defineProperty(document, "modelContext", { configurable: true, value: modelContext });
}

async function executeTool(page, name, input, timeoutMs = TIMEOUT_MS) {
  return page.evaluate(async ({ toolName, toolInput, toolTimeoutMs }) => {
    const tool = window.__jazzboardExp0036CaptureTools?.get(toolName);
    if (!tool) throw new Error(`EXP0036_CAPTURE_TOOL_NOT_REGISTERED:${toolName}`);
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`EXP0036_CAPTURE_TOOL_TIMEOUT:${toolName}`));
      }, toolTimeoutMs);
    });
    try {
      return await Promise.race([tool.execute(toolInput, { signal: controller.signal }), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }, { toolName: name, toolInput: input, toolTimeoutMs: timeoutMs });
}

async function supportedToolInput(page, name, preferred) {
  return page.evaluate(({ toolName, preferredInput }) => {
    const tool = window.__jazzboardExp0036CaptureTools?.get(toolName);
    if (!tool) throw new Error(`EXP0036_CAPTURE_TOOL_NOT_REGISTERED:${toolName}`);
    const properties = tool.inputSchema?.properties;
    if (!properties || typeof properties !== "object") return {};
    return Object.fromEntries(Object.entries(preferredInput).filter(([key]) => key in properties));
  }, { toolName: name, preferredInput: preferred });
}

function successfulTool(result, name) {
  assert(result?.ok === true && result.tool === name && result.data && typeof result.data === "object",
    `EXP0036 ${name} failed: ${JSON.stringify(result)}`);
  return result.data;
}

function normalizedOrigin(value) {
  const url = new URL(value);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url.origin;
}

function parseCookie(cookie) {
  const separator = cookie.indexOf("=");
  assert(separator > 0 && cookie.slice(0, separator) === "jazzboard_guest",
    "Stored controller cookie is invalid.");
  return { name: cookie.slice(0, separator), value: cookie.slice(separator + 1) };
}

async function authoritativeRoom(origin, roomId, cookie) {
  const response = await fetch(new URL(`/api/rooms/${encodeURIComponent(roomId)}`, origin), {
    method: "GET",
    headers: { cookie, "x-jazzboard-client-capabilities": CLIENT_CAPABILITIES },
    cache: "no-store",
  });
  const body = await response.json();
  assert(response.ok && body?.ok === true && body.room?.id === roomId,
    `Authoritative room read failed HTTP ${response.status}.`);
  return body.room;
}

async function readDownload(download) {
  const failure = await download.failure();
  assert(!failure, `EXP0036 PNG download failed: ${failure}`);
  const stream = await download.createReadStream();
  assert(stream, "EXP0036 PNG download stream is unavailable.");
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function pngDimensions(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert(bytes.length >= 45 && bytes.subarray(0, 8).equals(signature), "EXP0036 PNG structure is invalid.");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert(width > 0 && height > 0, "EXP0036 PNG dimensions are invalid.");
  return { width, height };
}

async function saveExclusive(filePath, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
}

function reviewBindings(attemptId) {
  const { graderManifest } = createExp0036FrozenPacketBundle();
  return graderManifest.blindedPairReview.assignments.flatMap((assignment) =>
    ["left", "right"].flatMap((side) => assignment.display[side].attemptId === attemptId
      ? [{ reviewSlotId: assignment.reviewSlotId, side }]
      : []));
}

async function capture(args) {
  const privateDirectory = path.join(args.output, ".private");
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const controllerPath = path.join(privateDirectory, "controller.json");
  const controllerBytes = await readFile(controllerPath);
  const controller = JSON.parse(controllerBytes.toString("utf8"));
  assert(controller?.assignment?.attemptId === args.attemptId
    && controller.controllerOrigin === args.origin
    && /^room_[A-Za-z0-9_-]+$/.test(controller.beforeRoom?.id ?? ""),
  "Capture arguments do not match the private controller evidence.");

  const snapshotPath = path.join(privateDirectory, "after.json");
  const snapshotBytes = await readFile(snapshotPath);
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  const before = await authoritativeRoom(args.origin, controller.beforeRoom.id, controller.controllerCookie);
  assert(snapshot?.id === controller.beforeRoom.id
    && canonical(documentState(snapshot)) === canonical(documentState(before)),
  "Controller after snapshot is absent, stale, or has different document state.");
  const revision = before.roomRevision;
  assert(Number.isSafeInteger(revision) && revision > 0 && Object.keys(before.objects ?? {}).length > 0,
    "Creation capture requires a non-empty positive-revision room.");

  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC",
      serviceWorkers: "block",
      acceptDownloads: true,
    });
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("blob:") || normalizedOrigin(url) === args.origin) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    await context.addInitScript(installWebMcpHostShim);
    const parsedCookie = parseCookie(controller.controllerCookie);
    await context.addCookies([{ ...parsedCookie, url: args.origin }]);
    const page = await context.newPage();
    const response = await page.goto(
      `${args.origin}/room/${encodeURIComponent(controller.beforeRoom.id)}`,
      { waitUntil: "domcontentloaded" },
    );
    assert(response?.ok(), `Controller browser navigation failed HTTP ${response?.status() ?? "unknown"}.`);
    await page.waitForFunction(() => {
      const tools = window.__jazzboardExp0036CaptureTools;
      return tools?.has("read_room_state") && tools.has("inspect_canvas_scope") && tools.has("export_canvas_png");
    }, undefined, { timeout: 30_000 });

    const readRoomStateInput = await supportedToolInput(page, "read_room_state", {
      detail: "full",
      expectedRoomRevision: revision,
    });
    const openingRead = await executeTool(page, "read_room_state", readRoomStateInput, 30_000);
    const openingData = successfulTool(openingRead, "read_room_state");
    assert(openingData.room?.roomRevision === revision, "Browser opening read does not match the authoritative revision.");

    const inspection = await executeTool(page, "inspect_canvas_scope", {
      scope: { kind: "room", expectedRevision: revision },
      representation: "overview",
      padding: PADDING,
    }, 30_000);
    const inspectionData = successfulTool(inspection, "inspect_canvas_scope");
    assert(inspectionData.sceneContext?.revisions?.roomRevision === revision,
      "Inspection is not bound to the authoritative revision.");
    const selector = inspectionData.validation?.activeSelector;
    assert(typeof selector === "string" && selector.length > 0, "Inspection did not return an active clean-canvas selector.");
    const active = page.locator(selector);
    assert(await active.count() === 1 && await active.isVisible(), "Clean-canvas validation is not uniquely active.");
    const cleanViewportPng = await page.screenshot({ type: "png", fullPage: false, animations: "disabled" });
    const cleanViewportDimensions = pngDimensions(cleanViewportPng);
    assert(cleanViewportDimensions.width === VIEWPORT.width && cleanViewportDimensions.height === VIEWPORT.height,
      "Clean viewport screenshot dimensions drifted from the frozen capture viewport.");

    const downloadPromise = page.waitForEvent("download", { timeout: TIMEOUT_MS });
    const exportPromise = executeTool(page, "export_canvas_png", {
      scope: { kind: "room", expectedRevision: revision },
      filename: `exp0036-${args.attemptId}-final-r${revision}`,
      padding: PADDING,
      pixelRatio: 1,
    });
    const [download, exportResult] = await Promise.all([downloadPromise, exportPromise]);
    const exportData = successfulTool(exportResult, "export_canvas_png");
    const png = await readDownload(download);
    const dimensions = pngDimensions(png);
    assert(exportData.sourceRevisions?.kind === "room"
      && exportData.sourceRevisions.roomRevision === revision
      && exportData.mimeType === "image/png"
      && exportData.persistedByJazzboard === false
      && exportData.byteLength === png.length
      && exportData.width === dimensions.width
      && exportData.height === dimensions.height
      && download.suggestedFilename() === exportData.filename,
    "Exported PNG bytes or revision provenance do not match the tool receipt.");

    const closingRead = await executeTool(page, "read_room_state", readRoomStateInput, 30_000);
    const closingData = successfulTool(closingRead, "read_room_state");
    assert(closingData.room?.roomRevision === revision, "Browser closing read observed a revision change.");
    const after = await authoritativeRoom(args.origin, controller.beforeRoom.id, controller.controllerCookie);
    assert(canonical(documentState(after)) === canonical(documentState(before)),
      "Authoritative document changed during final evidence capture.");

    const finalPngPath = path.join(privateDirectory, `final-r${revision}.png`);
    const cleanViewportPath = path.join(privateDirectory, `clean-viewport-r${revision}.png`);
    const finalStatePath = path.join(privateDirectory, "final-state.json");
    const sanitizedStatePath = path.join(privateDirectory, "sanitized-final-state.json");
    const inspectionPath = path.join(privateDirectory, "inspection.json");
    const roomStateDiffPath = path.join(privateDirectory, "capture-room-state-diff.json");
    const pngDigest = sha256(png);
    const bindings = reviewBindings(args.attemptId).map(({ reviewSlotId, side }) => ({
      reviewSlotId,
      side,
      metadata: createExp0036ArtifactMetadata({
        finalRevision: revision,
        finalState: after,
        pixels: {
          revision,
          mimeType: "image/png",
          width: dimensions.width,
          height: dimensions.height,
          sha256: pngDigest,
          attachmentReference: `attachment:${reviewSlotId}-${side}`,
        },
      }),
    }));

    await saveExclusive(finalPngPath, png);
    await saveExclusive(cleanViewportPath, cleanViewportPng);
    await saveExclusive(finalStatePath, after);
    await saveExclusive(sanitizedStatePath, sanitizeExp0036FinalState(after));
    await saveExclusive(inspectionPath, { openingRead, inspection, exportResult, closingRead });
    const roomStateDiff = {
      schemaVersion: "jazzboard-exp0036-capture-room-state-diff/v1",
      documentStateUnchanged: true,
      documentStateSha256: sha256(Buffer.from(canonical(documentState(after)), "utf8")),
      snapshotToOpeningChangedKeys: changedRoomKeys(snapshot, before),
      openingToClosingChangedKeys: changedRoomKeys(before, after),
      snapshot: { stateRevision: snapshot.stateRevision, participants: snapshot.participants },
      opening: { stateRevision: before.stateRevision, participants: before.participants },
      closing: { stateRevision: after.stateRevision, participants: after.participants },
    };
    await saveExclusive(roomStateDiffPath, roomStateDiff);
    const bindingReceipts = [];
    for (const binding of bindings) {
      const metadataPath = path.join(
        privateDirectory,
        `artifact-metadata-${binding.reviewSlotId}-${binding.side}.json`,
      );
      await saveExclusive(metadataPath, binding.metadata);
      bindingReceipts.push({ reviewSlotId: binding.reviewSlotId, side: binding.side, metadataPath });
    }
    const receipt = {
      schemaVersion: "jazzboard-exp0036-controller-capture/v1",
      attemptId: args.attemptId,
      taskId: controller.assignment.taskId,
      finalRevision: revision,
      authoritativeFinalStateSha256: sha256(Buffer.from(canonical(after), "utf8")),
      sanitizedFinalStateSha256: sha256(Buffer.from(canonical(sanitizeExp0036FinalState(after)), "utf8")),
      pixels: {
        path: finalPngPath,
        mimeType: "image/png",
        width: dimensions.width,
        height: dimensions.height,
        byteLength: png.length,
        sha256: pngDigest,
        source: "export_canvas_png",
        padding: PADDING,
        pixelRatio: 1,
      },
      independentCleanViewportEvidence: {
        path: cleanViewportPath,
        width: cleanViewportDimensions.width,
        height: cleanViewportDimensions.height,
        deviceScaleFactor: 1,
        sha256: sha256(cleanViewportPng),
      },
      reviewerArtifactMetadata: bindingReceipts,
      controllerEvidenceFileSha256: sha256(controllerBytes),
      controllerAfterSnapshotFileSha256: sha256(snapshotBytes),
      captureRoomStateDiff: {
        path: roomStateDiffPath,
        sha256: sha256(Buffer.from(`${JSON.stringify(roomStateDiff, null, 2)}\n`, "utf8")),
      },
      browser: { engine: "chromium", version: browser.version() },
      capturedAt: new Date().toISOString(),
    };
    const receiptPath = path.join(privateDirectory, "capture.json");
    await saveExclusive(receiptPath, receipt);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      attemptId: args.attemptId,
      finalRevision: revision,
      finalPngPath,
      receiptPath,
      reviewerMetadataCount: bindingReceipts.length,
    })}\n`);
  } finally {
    await context?.close();
    await browser.close();
  }
}

const args = parseArgs(process.argv.slice(2));
await capture(args);
