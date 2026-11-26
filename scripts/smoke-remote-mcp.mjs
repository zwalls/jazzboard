// Run after npm run build. Requires a local redis-server binary and installed Chromium.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { chromium, expect } from "@playwright/test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import Redis from "ioredis";

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

const temp = await mkdtemp(join(tmpdir(), "jazzboard-mcp-smoke-"));
const resultDir = process.env.JAZZBOARD_MCP_SMOKE_OUTPUT ?? temp;
await mkdir(resultDir, { recursive: true });
const port = await localPort();
const redisPort = await localPort();
const base = `http://localhost:${port}`;
const endpoint = `${base}/api/mcp`;
const redisUrl = `redis://127.0.0.1:${redisPort}`;
const keys = await generateKeyPair("RS256");
const publicJwk = { ...await exportJWK(keys.publicKey), alg: "RS256", kid: "mcp-local-smoke" };
const issuerServer = createServer((request, response) => {
  if (request.url !== "/jwks") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: [publicJwk] }));
});
const issuer = `http://127.0.0.1:${await listen(issuerServer)}`;
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

async function startNext(grants) {
  next = spawn(process.execPath, [
    "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port),
  ], {
    stdio: "inherit",
    env: {
      ...commonEnv,
      JAZZBOARD_REMOTE_MCP_ENABLED: grants ? "1" : "0",
      JAZZBOARD_REMOTE_MCP_RESOURCE: endpoint,
      JAZZBOARD_REMOTE_MCP_ISSUER: issuer,
      JAZZBOARD_REMOTE_MCP_JWKS_URL: `${issuer}/jwks`,
      JAZZBOARD_REMOTE_MCP_ROOM_GRANTS: JSON.stringify(grants ?? []),
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
  const { participantId } = await joined.json();
  const grant = {
    subject: "local-test-subject",
    clientId: "local-test-client",
    roomId: room.id,
    participantId,
    access: "write",
  };
  await stop(next);
  await startNext([grant]);

  const unauthenticated = await fetch(endpoint, { method: "POST" });
  assert.equal(unauthenticated.status, 401);
  const discovery = await fetch(`${base}/.well-known/oauth-protected-resource/api/mcp`);
  assert.equal(discovery.status, 200);
  assert.equal((await discovery.json()).resource, endpoint);

  const token = await new SignJWT({ client_id: grant.clientId, scope: "room:read room:write" })
    .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "mcp-local-smoke" })
    .setSubject(grant.subject).setIssuer(issuer).setAudience(endpoint)
    .setJti(randomUUID()).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);

  const start = performance.now();
  mcp = new Client({ name: "jazzboard-smoke", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(endpoint), { authProvider: { token: async () => token } }));
  const toolNames = (await mcp.listTools()).tools.map(({ name }) => name).sort();
  assert(toolNames.includes("apply_canvas_edits"));
  assert(toolNames.includes("read_canvas"));
  const setupMs = performance.now() - start;
  const call = (name, args = {}) => mcp.callTool({ name, arguments: { roomId: room.id, ...args } });
  const read = async () => unpack(await call("read_canvas"));
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

  let preview;
  if (toolNames.includes("render_canvas_preview")) {
    const rendered = await call("render_canvas_preview", {
      scope: { kind: "group", groupId, expectedRoomRevision: after.roomRevision },
    });
    preview = unpack(rendered);
    const image = rendered.content.find((block) => block.type === "image");
    assert.equal(image?.mimeType, "image/png");
    const bytes = Buffer.from(image.data, "base64");
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    await writeFile(join(resultDir, "targeted-preview.png"), bytes);
  }
  await page.screenshot({ path: join(resultDir, "editable-room.png") });
  let portrait;
  if (process.env.JAZZBOARD_MCP_SMOKE_PORTRAIT) {
    const { fixture } = await import(pathToFileURL(process.env.JAZZBOARD_MCP_SMOKE_PORTRAIT).href);
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
    if (preview) {
      const result = await call("render_canvas_preview", {
        scope: { kind: "group", groupId, expectedRoomRevision: (await read()).roomRevision },
        padding: 0,
      });
      const image = result.content.find((block) => block.type === "image");
      assert.equal(image?.mimeType, "image/png");
      const png = Buffer.from(image.data, "base64");
      await writeFile(join(resultDir, "mona-lisa.png"), png);
    }
    await page.screenshot({ path: join(resultDir, "mona-lisa-browser.png") });
    const kinds = fixture.reduce((counts, command) => {
      const kind = command.object.kind;
      counts[kind] = (counts[kind] ?? 0) + 1;
      return counts;
    }, {});
    portrait = { groupId, kinds, roomRevision: portraitSave.roomRevision, applyMs, browserVisibleMs, verifiedReload: true };
  }
  const report = { toolNames, setupMs, create, after, preview, portrait, verifiedBrowserNudge: true, verifiedReload: true };
  console.log(JSON.stringify(report, null, 2));
  if (resultDir !== temp) await writeFile(join(resultDir, "smoke-report.json"), JSON.stringify(report, null, 2));
} finally {
  await mcp?.close();
  await browser?.close();
  await stop(next);
  await stop(redis);
  await close(issuerServer);
  await rm(temp, { recursive: true, force: true });
}
