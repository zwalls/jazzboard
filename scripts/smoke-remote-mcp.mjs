// Run after npm run build. Requires a local redis-server binary and installed Chromium.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { chromium, expect } from "@playwright/test";
import Redis from "ioredis";
import sharp from "sharp";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function localPort() {
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

async function waitFor(check, limit = 20_000) {
  const end = Date.now() + limit;
  do {
    if (await check()) return;
    await setTimeout(100);
  } while (Date.now() < end);
  throw new Error("The isolated smoke test timed out waiting for readiness.");
}

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

function unpack(result) {
  const body = result.content.find((entry) => entry.type === "text");
  assert(body, "Expected MCP text content");
  const data = JSON.parse(body.text);
  assert(!result.isError, JSON.stringify(data));
  return data;
}

function unpackPreview(result) {
  const metadata = unpack(result);
  const image = result.content.find((entry) => entry.type === "image");
  assert.equal(image?.mimeType, "image/png");
  const bytes = Buffer.from(image.data, "base64");
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  assert.equal(metadata.byteLength, bytes.length);
  return { bytes, metadata, base64Bytes: Buffer.byteLength(image.data) };
}

async function countColors(bytes, palette) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  const counts = Object.fromEntries(palette.map((color) => [color, 0]));
  const pixels = new Map(palette.map((color) => [Number.parseInt(color.slice(1), 16), color]));
  for (let i = 0; i < data.length; i += 4) {
    const color = pixels.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    if (color && data[i + 3] > 0) counts[color] += 1;
  }
  return counts;
}

const temp = await mkdtemp(join(tmpdir(), "jazzboard-mcp-smoke-"));
const resultDir = process.env.JAZZBOARD_MCP_SMOKE_OUTPUT ?? temp;
await mkdir(resultDir, { recursive: true });
const port = await localPort();
const redisPort = await localPort();
const base = `http://localhost:${port}`;
const endpoint = `${base}/api/mcp`;
const redisUrl = `redis://127.0.0.1:${redisPort}`;
const session = randomBytes(32).toString("hex");
const commonEnv = {
  ...process.env,
  HOSTNAME: "127.0.0.1",
  REDIS_URL: redisUrl,
  SESSION_SECRET: session,
  VERCEL: "",
  VERCEL_ENV: "",
  JAZZBOARD_PRIVATE_READ_WRITE_TOKEN: "",
  BLOB_READ_WRITE_TOKEN: "",
  CRON_SECRET: "",
  NEXT_TELEMETRY_DISABLED: "1",
};

let next;
let redis;
let browser;
let mcp;
let reader;

async function startNext(enabled) {
  next = spawn(process.execPath, [
    "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port),
  ], {
    stdio: "inherit",
    env: {
      ...commonEnv,
      JAZZBOARD_REMOTE_MCP_ENABLED: enabled ? "1" : "0",
      JAZZBOARD_REMOTE_MCP_RESOURCE: endpoint,
    },
  });
  await waitFor(async () => {
    if (next.exitCode !== null) throw new Error("Next exited before becoming ready.");
    const health = await fetch(`${base}/api/health`).catch(() => null);
    return health?.ok;
  });
}

try {
  redis = spawn(process.env.REDIS_SERVER_BIN ?? "redis-server", [
    "--bind", "127.0.0.1", "--port", String(redisPort), "--protected-mode", "yes",
    "--save", "", "--appendonly", "no", "--dir", temp,
  ], { stdio: "inherit" });
  await once(redis, "spawn");
  await waitFor(async () => {
    if (redis.exitCode !== null) throw new Error("Redis exited before becoming ready.");
    const probe = new Redis(redisUrl, { lazyConnect: true, retryStrategy: () => null, connectTimeout: 500 });
    probe.on("error", () => {});
    try {
      return await probe.ping() === "PONG";
    } catch {
      return false;
    } finally {
      probe.disconnect();
    }
  });

  await startNext();
  assert.equal((await fetch(endpoint, { method: "POST" })).status, 404);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
  const studio = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 960 } });
  const agent = await browser.newContext({ baseURL: base });
  const created = await studio.request.post("/api/rooms", {
    data: { action: "create", displayName: "Local human", title: "Remote MCP smoke test" },
  });
  assert(created.ok(), await created.text());
  const { room } = await created.json();
  const joined = await agent.request.post("/api/rooms", {
    data: { action: "join", code: room.code, displayName: "Local MCP agent", role: "participant" },
  });
  assert(joined.ok(), await joined.text());
  await stop(next);
  await startNext(true);

  const unauthenticated = await fetch(endpoint, { method: "POST" });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("www-authenticate"), 'Bearer realm="Jazzboard MCP"');

  const connectionsPage = await agent.newPage();
  await connectionsPage.goto(`/room/${room.id}`);
  await connectionsPage.getByRole("button", { name: "Share board", exact: true }).click();
  await connectionsPage.getByRole("link", { name: "Manage MCP connections" }).click();
  await expect(connectionsPage.getByRole("heading", { name: "MCP connections" })).toBeVisible();
  async function createConnection(label, access) {
    await connectionsPage.getByLabel("Connection name").fill(label);
    await connectionsPage.getByLabel("Permission").selectOption(access);
    await connectionsPage.getByRole("button", { name: "Create connection" }).click();
    await expect(connectionsPage.getByLabel("Server URL")).toHaveValue(endpoint);
    await expect(connectionsPage.getByLabel("Room ID")).toHaveValue(room.id);
    const secret = await connectionsPage.getByLabel("Bearer token").inputValue();
    assert(secret.startsWith("jb_mcp_v1."), "Expected a guest connection token.");
    await connectionsPage.getByRole("button", { name: "Hide token" }).click();
    return secret;
  }
  const token = await createConnection("Editor smoke", "write");
  const readerToken = await createConnection("Reader smoke", "read");

  const start = performance.now();
  mcp = new Client({ name: "jazzboard-smoke", version: "1.0.0" });
  let capturedBody;
  await mcp.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    authProvider: { token: async () => token },
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      const request = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (request.method === "tools/call" && request.params?.name === "render_canvas_preview") {
        capturedBody = { contentType: response.headers.get("content-type"), bytes: (await response.clone().arrayBuffer()).byteLength };
      }
      return response;
    },
  }));
  const toolNames = (await mcp.listTools()).tools.map(({ name }) => name).sort();
  assert(toolNames.includes("apply_canvas_edits"));
  assert(toolNames.includes("read_canvas"));
  assert(toolNames.includes("render_canvas_preview"));
  const setupMs = performance.now() - start;
  const call = (name, args = {}) => mcp.callTool({ name, arguments: { roomId: room.id, ...args } });
  const read = async () => unpack(await call("read_canvas"));
  const render = async (scope, padding) => unpackPreview(await call("render_canvas_preview", { scope, padding }));
  const apply = async (commands, roomRevision) => unpack(await call("apply_canvas_edits", {
    commands, expectedRoomRevision: roomRevision, idempotencyKey: randomUUID(),
  }));

  const page = await studio.newPage();
  await page.goto(`/room/${room.id}`);
  const canvas = page.locator("[data-testid='semantic-canvas']");
  await expect(canvas).toBeVisible();
  const groupId = "mcp-smoke-group";
  const before = await read();
  const create = await apply([{
    type: "create",
    object: {
      id: "mcp-smoke-shape", kind: "shape", x: 60, y: 80, width: 220, height: 100, zIndex: 0,
      shape: "rectangle", label: "Editable through Jazzboard", fill: "#e0ebf4", stroke: "#365e81", groupId,
    },
  }, {
    type: "create",
    object: {
      id: "mcp-smoke-path", kind: "path", x: 130, y: 230, width: 210, height: 105, zIndex: 1,
      start: { x: 0.08, y: 0.8 }, segments: [{
        kind: "quadratic", control: { x: 0.65, y: 0.05 }, to: { x: 0.92, y: 0.4 },
      }],
      stroke: "#365e81", strokeWidth: 7, groupId,
    },
  }], before.roomRevision);
  assert.equal(create.outcome, "applied");
  assert.equal(create.changedObjectIds.length, 2);
  const shape = page.locator('[data-object-id="mcp-smoke-shape"]');
  await expect(shape).toHaveAttribute("data-object-x", "60", { timeout: 15_000 });
  await expect(page.locator('[data-object-id="mcp-smoke-path"]')).toBeVisible();

  await shape.click();
  await canvas.press("ArrowRight");
  await expect.poll(async () => (await read()).objects.find(({ id }) => id === "mcp-smoke-shape")?.x, {
    timeout: 10_000,
  }).toBe(61);
  await page.reload();
  await expect(shape).toHaveAttribute("data-object-x", "61", { timeout: 15_000 });
  const after = await read();

  const groupPreview = await render({ kind: "group", groupId, expectedRoomRevision: after.roomRevision });
  assert.deepEqual(groupPreview.metadata.objectRevisions.map(({ objectId }) => objectId).sort(), ["mcp-smoke-path", "mcp-smoke-shape"]);
  await writeFile(join(resultDir, "targeted-preview.png"), groupPreview.bytes);
  reader = new Client({ name: "jazzboard-smoke-reader", version: "1.0.0" });
  await reader.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${readerToken}` } },
  }));
  const readOnlyPreview = await reader.callTool({
    name: "render_canvas_preview",
    arguments: { roomId: room.id, scope: { kind: "group", groupId, expectedRoomRevision: after.roomRevision } },
  });
  assert.deepEqual(unpackPreview(readOnlyPreview).bytes, groupPreview.bytes);

  const readOnlyEdit = await reader.callTool({
    name: "apply_canvas_edits",
    arguments: {
      roomId: room.id, expectedRoomRevision: after.roomRevision, idempotencyKey: randomUUID(),
      commands: [{
        type: "update", objectId: "mcp-smoke-shape", expectedRevision: 2, operation: "move", patch: { x: 62 },
      }],
    },
  });
  assert.equal(readOnlyEdit.isError, true);
  assert.match(readOnlyEdit.content[0].text, /FORBIDDEN/);

  const other = await studio.request.post("/api/rooms", {
    data: { action: "create", displayName: "Local human", title: "Separate smoke test room" },
  });
  assert(other.ok());
  const otherRoomId = (await other.json()).room.id;
  const crossRoom = await reader.callTool({ name: "read_canvas", arguments: { roomId: otherRoomId } });
  assert.equal(crossRoom.isError, true);
  assert.match(crossRoom.content[0].text, /FORBIDDEN/);
  assert.equal((await read()).roomRevision, after.roomRevision);

  let inspector;
  if (process.env.JAZZBOARD_MCP_INSPECTOR_CLI) {
    const invoke = promisify(execFile);
    const configPath = join(temp, "inspector-fixture.json");
    await writeFile(configPath, JSON.stringify({
      mcpServers: { jazzboard: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${readerToken}` } } },
    }), { mode: 0o600 });
    const cli = process.env.JAZZBOARD_MCP_INSPECTOR_CLI;
    async function inspectorCall(tool, entries) {
      const args = [
        "--cli", "--config", configPath, "--server", "jazzboard", "--quiet", "--format", "json",
        "--method", "tools/call", "--tool-name", tool,
      ];
      for (const [key, value] of entries) args.push("--tool-arg", `${key}=${value}`);
      const node = process.env.JAZZBOARD_MCP_INSPECTOR_NODE;
      const { stdout } = await invoke(node ?? cli, node ? [cli, ...args] : args, {
        timeout: 15_000,
        env: { ...process.env, MCP_STORAGE_DIR: temp, MCP_INSPECTOR_SECRET_STORE: "memory" },
      });
      return JSON.parse(stdout).result;
    }
    try {
      const result = unpack(await inspectorCall("read_canvas", [["roomId", room.id]]));
      assert.equal(result.roomId, room.id);
      const resultPreview = unpackPreview(await inspectorCall("render_canvas_preview", [
        ["roomId", room.id], ["scope", JSON.stringify({ kind: "group", groupId, expectedRoomRevision: after.roomRevision })],
      ]));
      assert.deepEqual(resultPreview.bytes, groupPreview.bytes);
      inspector = { roomId: room.id, tools: ["read_canvas", "render_canvas_preview"], pngBytes: resultPreview.bytes.length };
    } catch (error) {
      if (typeof error.stderr === "string") console.error(error.stderr.replaceAll(readerToken, "[redacted]").slice(0, 1500));
      throw new Error("MCP Inspector CLI could not complete the authenticated room read and preview.");
    } finally {
      await rm(configPath, { force: true });
    }
  }

  await connectionsPage.reload();
  await expect(connectionsPage.getByLabel("Bearer token")).toHaveCount(0);
  await connectionsPage.getByRole("button", { name: "Revoke Reader smoke" }).click();
  await expect(connectionsPage.getByText("Connection revoked.")).toBeVisible();
  await assert.rejects(() => reader.callTool({ name: "read_canvas", arguments: { roomId: room.id } }));
  assert.equal((await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${readerToken}` } })).status, 401);

  await page.screenshot({ path: join(resultDir, "editable-room.png") });
  let portrait;
  if (process.env.JAZZBOARD_MCP_SMOKE_PORTRAIT) {
    const { fixture, review } = await import(pathToFileURL(process.env.JAZZBOARD_MCP_SMOKE_PORTRAIT).href);
    const submitted = performance.now();
    const portraitSave = await apply(fixture, after.roomRevision);
    const applyMs = performance.now() - submitted;
    assert.equal(portraitSave.changedObjectIds.length, fixture.length);
    const targets = page.locator('[data-object-id^="portrait-"]');
    await expect(targets).toHaveCount(fixture.length, { timeout: 15_000 });
    const browserVisibleMs = performance.now() - submitted;
    await page.reload();
    await expect(targets).toHaveCount(fixture.length);
    const groupId = fixture[0].object.groupId;
    let correction;
    if (review) {
      const toInspect = (names) => names.map((semanticName) => {
        const command = fixture.find(({ object }) => object.semanticName === semanticName);
        assert(command, `Missing portrait role: ${semanticName}`);
        return { objectId: command.object.id, expectedRevision: 1 };
      });
      for (const [name, names] of Object.entries(review.focus)) {
        const inspection = await render({ kind: "objects", targets: toInspect(names) }, 10);
        await writeFile(join(resultDir, `mona-lisa-${name}.png`), inspection.bytes);
      }
      const [{ objectId, expectedRevision }] = toInspect([review.correction.semanticName]);
      const corrected = await apply([{
        type: "update", objectId, expectedRevision, operation: "edit", patch: review.correction.patch,
      }], (await read()).roomRevision);
      assert.equal(corrected.outcome, "applied");
      await page.reload();
      await expect(page.locator(`[data-object-id="${objectId}"]`)).toHaveAttribute("data-object-revision", "2");
      correction = { ...review.correction, roomRevision: corrected.roomRevision };
    }
    const rendered = await render({ kind: "group", groupId, expectedRoomRevision: (await read()).roomRevision }, 0);
    assert.equal(rendered.metadata.objectRevisions.length, fixture.length);
    await writeFile(join(resultDir, "mona-lisa.png"), rendered.bytes);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("button", { name: "Fit board", exact: true }).click();
    await page.screenshot({ path: join(resultDir, "mona-lisa-browser.png") });
    const kinds = fixture.reduce((counts, command) => {
      const kind = command.object.kind;
      counts[kind] = (counts[kind] ?? 0) + 1;
      return counts;
    }, {});
    portrait = { groupId, kinds, roomRevision: portraitSave.roomRevision, applyMs, browserVisibleMs, correction, png: rendered.metadata, verifiedReload: true };
  }
  const positions = [{ x: 800, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 160 }];
  const palette = ["#be323c", "#2a9d8f", "#633dc0"];
  const paletteOffset = randomInt(3);
  const ellipseIndex = randomInt(3);
  const targets = positions.map(({ x, y }, position) => ({
    id: randomUUID(), kind: "shape", shape: position === ellipseIndex ? "ellipse" : "rectangle",
    x, y, width: 72, height: 64, zIndex: 10 + position,
    fill: palette[(position + paletteOffset) % palette.length], stroke: "none",
  }));
  const decoy = {
    id: randomUUID(), kind: "shape", shape: "rectangle", x: 895, y: 95,
    width: 56, height: 60, zIndex: 99, fill: "#ff00ff", stroke: "none",
  };
  const staged = await apply([...targets, decoy].map((object) => ({ type: "create", object })), (await read()).roomRevision);
  assert.equal(staged.changedObjectIds.length, 4);
  const started = performance.now();
  const selected = await render({
    kind: "objects", targets: targets.map(({ id }) => ({ objectId: id, expectedRevision: 1 })),
  }, 0);
  const captureMs = performance.now() - started;
  const serializedResponse = capturedBody;
  const expectedColorPixelCounts = await countColors(selected.bytes, [...palette, decoy.fill]);
  for (const color of palette) assert(expectedColorPixelCounts[color] > 100);
  assert.equal(expectedColorPixelCounts[decoy.fill], 0);
  assert(serializedResponse?.bytes > selected.base64Bytes);
  assert.deepEqual(selected.metadata.objectRevisions.map(({ objectId }) => objectId).sort(), targets.map(({ id }) => id).sort());
  const bounds = selected.metadata.bounds;
  assert(decoy.x >= bounds.x && decoy.y >= bounds.y);
  assert(decoy.x + decoy.width <= bounds.x + bounds.width && decoy.y + decoy.height <= bounds.y + bounds.height);

  const decoyOnly = await render({ kind: "objects", targets: [{ objectId: decoy.id, expectedRevision: 1 }] }, 0);
  const decoyControlPixels = (await countColors(decoyOnly.bytes, [decoy.fill]))[decoy.fill];
  assert(decoyControlPixels > 100);
  await writeFile(join(resultDir, "opaque-scope-preview.png"), selected.bytes);
  const scopeProof = {
    targets: targets.map(({ id, x, y, fill, shape }) => ({ id, x, y, fill, shape })),
    decoy, expectedColorPixelCounts, excludedDecoyPixels: 0, decoyControlPixels, metadata: selected.metadata,
    pngBytes: selected.bytes.length, base64Bytes: selected.base64Bytes, serializedResponse, captureMs,
  };
  const report = {
    toolNames, setupMs, create, after, preview: groupPreview.metadata, portrait, scopeProof, inspector,
    verifiedConnectionUi: true, verifiedReadOnly: true, verifiedCrossRoomDenial: true, verifiedRevocation: true,
    verifiedBrowserNudge: true, verifiedReload: true,
  };
  console.log(JSON.stringify(report, null, 2));
  if (resultDir !== temp) await writeFile(join(resultDir, "smoke-report.json"), JSON.stringify(report, null, 2));
} finally {
  await reader?.close();
  await mcp?.close();
  await browser?.close();
  await stop(next);
  await stop(redis);
  await rm(temp, { recursive: true, force: true });
}
