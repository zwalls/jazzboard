#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, request as playwrightRequest } from "@playwright/test";

const BASE_URL = "https://www.jazzboard.xyz";
const EXPECTED_DEPLOYMENT_ID = "dpl_46pyqWtLXGfzeU1JsqXEWQjTBfd8";
const EXPECTED_LANDING_COUNT = 5;
const EXPECTED_PARTICIPANT_COUNT = 54;
const EXPECTED_SPECTATOR_COUNT = 18;
const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const MUTATING_TOOL_PREFIX = /^(?:add|apply|approve|claim|create|delete|dismiss|draw|edit|enable|finish|focus|follow|group|instantiate|join|leave|move|remove|reply|request|revert|start|stop|update)_/;

function usage() {
  return [
    "Usage: node research/scripts/capture-baseline-v2.mjs --output-dir /absolute/path --capture-history-log /absolute/path.json",
    "",
    "Runs one fresh browser-only production capture into a new private directory.",
    "It writes a compact public projection plus reproducible private evidence:",
    "  baseline-webmcp-inventory-v2.json",
    "  baseline-production-evidence-v2.json",
    "  baseline-webmcp-inventory-private-v2.json",
    "  baseline-semantic-artifact-redacted-v2.json",
    "  baseline-semantic-handler-redacted-v2.json",
    "  baseline-authoritative-state-redacted-v2.json",
    "  baseline-exact-revision-v2.png",
    "",
    "The script never writes a room ID, room code, participant ID, cookie, or session credential.",
  ].join("\n");
}

function parseArguments(argv) {
  if (argv.includes("--help")) return { help: true };
  const outputIndex = argv.indexOf("--output-dir");
  const historyIndex = argv.indexOf("--capture-history-log");
  if (outputIndex < 0 || outputIndex === argv.length - 1) {
    throw new Error("An explicit --output-dir is required.");
  }
  if (historyIndex < 0 || historyIndex === argv.length - 1) {
    throw new Error("An explicit --capture-history-log is required.");
  }
  const outputDir = path.resolve(argv[outputIndex + 1]);
  const captureHistoryLog = path.resolve(argv[historyIndex + 1]);
  if (argv.length !== 4) throw new Error("Only --output-dir and --capture-history-log are supported.");
  return { help: false, outputDir, captureHistoryLog };
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value, at = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${at}.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${at}/${index}`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Only plain JSON objects are supported at ${at}.`);
    }
    return Object.fromEntries(Object.keys(value).sort(compareCodeUnits).map((key) => {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new TypeError(`Non-JSON value at ${at}/${key}.`);
      }
      return [key, canonicalize(item, `${at}/${key}`)];
    }));
  }
  throw new TypeError(`Non-JSON value at ${at}.`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashCanonicalJson(value) {
  return sha256(canonicalJson(value));
}

function normalizedAnnotations(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return canonicalize(value);
}

export function normalizeToolDescriptor(tool) {
  if (!tool || typeof tool !== "object" || !SAFE_TOOL_NAME.test(tool.name ?? "")) {
    throw new Error("The live page registered an invalid WebMCP tool name.");
  }
  if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
    throw new Error(`WebMCP tool ${tool.name} has no object input schema.`);
  }
  return canonicalize({
    name: tool.name,
    title: typeof tool.title === "string" ? tool.title : tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    inputSchema: tool.inputSchema,
    annotations: normalizedAnnotations(tool.annotations),
  });
}

export function buildInventoryScope(tools) {
  const descriptors = tools.map(normalizeToolDescriptor).sort((left, right) => compareCodeUnits(left.name, right.name));
  const names = descriptors.map((tool) => tool.name);
  if (new Set(names).size !== names.length) throw new Error("The live page registered duplicate WebMCP tool names.");
  const entries = descriptors.map((tool) => ({
    name: tool.name,
    definitionDigest: hashCanonicalJson(tool),
  }));
  return {
    toolCount: entries.length,
    inventoryDigest: hashCanonicalJson(entries),
    contractDigest: hashCanonicalJson(descriptors),
    tools: entries,
    descriptors,
  };
}

export function projectPublicInventoryScope(scope) {
  return {
    toolCount: scope.toolCount,
    inventoryDigest: scope.inventoryDigest,
    contractDigest: scope.contractDigest,
    tools: scope.tools,
  };
}

export function assertPrivateInventoryScope(scope, label = "inventory") {
  if (!Array.isArray(scope?.descriptors) || scope.descriptors.length !== scope.toolCount) {
    throw new Error(`${label} full descriptor count does not match its tool count.`);
  }
  if (hashCanonicalJson(scope.descriptors) !== scope.contractDigest) {
    throw new Error(`${label} full descriptor contract digest is not reproducible.`);
  }
  const expectedEntries = scope.descriptors.map((descriptor) => ({
    name: descriptor.name,
    definitionDigest: hashCanonicalJson(descriptor),
  }));
  if (canonicalJson(expectedEntries) !== canonicalJson(scope.tools)) {
    throw new Error(`${label} compact definition digests do not match the retained descriptors.`);
  }
  return scope;
}

export function pngDimensions(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 45 || !bytes.subarray(0, 8).equals(signature)) return null;
  let offset = 8;
  let ordinal = 0;
  let width = 0;
  let height = 0;
  let sawImageData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const next = offset + 12 + length;
    if (next > bytes.byteLength) return null;
    if (ordinal === 0) {
      if (type !== "IHDR" || length !== 13) return null;
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      if (width < 1 || height < 1) return null;
    }
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      if (length !== 0 || next !== bytes.byteLength) return null;
      sawEnd = true;
    }
    offset = next;
    ordinal += 1;
  }
  return sawImageData && sawEnd ? { width, height } : null;
}

export function assertCapturedInventory(inventory) {
  const expected = {
    landing: EXPECTED_LANDING_COUNT,
    participant: EXPECTED_PARTICIPANT_COUNT,
    spectator: EXPECTED_SPECTATOR_COUNT,
  };
  for (const [role, count] of Object.entries(expected)) {
    const scope = inventory?.[role];
    if (scope?.toolCount !== count || scope?.tools?.length !== count) {
      throw new Error(`${role} WebMCP inventory expected exactly ${count} tools.`);
    }
    if (scope.inventoryDigest !== hashCanonicalJson(scope.tools)) {
      throw new Error(`${role} WebMCP inventory digest is not reproducible.`);
    }
    if (scope.tools.some((tool, index) => (
      !SAFE_TOOL_NAME.test(tool.name)
      || index > 0 && compareCodeUnits(scope.tools[index - 1].name, tool.name) >= 0
    ))) {
      throw new Error(`${role} WebMCP inventory is not uniquely code-unit sorted.`);
    }
  }
  const participantNames = new Set(inventory.participant.tools.map((tool) => tool.name));
  const spectatorNames = inventory.spectator.tools.map((tool) => tool.name);
  if (spectatorNames.some((name) => !participantNames.has(name))) {
    throw new Error("Spectator WebMCP inventory is not a participant subset.");
  }
  if (spectatorNames.some((name) => MUTATING_TOOL_PREFIX.test(name))) {
    throw new Error("Spectator WebMCP inventory exposes a mutation or collaboration-control tool.");
  }
  return inventory;
}

async function installWebMcpShim(page) {
  await page.addInitScript(() => {
    const tools = new Map();
    window.__jazzboardBaselineTools = tools;
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
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      window,
      origin: window.location.origin,
    }));
    Object.defineProperty(document, "modelContext", { configurable: true, value: modelContext });
  });
}

async function registeredTools(page) {
  return page.evaluate(() => [...(window.__jazzboardBaselineTools?.values() ?? [])].map((tool) => ({
    name: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? {},
  })));
}

async function waitForToolCount(page, expected, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const tools = await registeredTools(page);
    if (tools.length === expected) return tools;
    await page.waitForTimeout(100);
  }
  const names = (await registeredTools(page)).map((tool) => tool.name).sort(compareCodeUnits);
  throw new Error(`${label} registered ${names.length} tools instead of ${expected}: ${names.join(", ")}`);
}

async function callTool(page, name, input) {
  return page.evaluate(async ({ toolName, toolInput }) => {
    const tool = window.__jazzboardBaselineTools?.get(toolName);
    if (!tool) throw new Error(`WebMCP tool ${toolName} is not registered.`);
    return tool.execute(toolInput, { signal: new AbortController().signal });
  }, { toolName: name, toolInput: input });
}

function successfulTool(result, expectedName) {
  if (result?.ok !== true || result.tool !== expectedName) {
    const error = result?.error;
    throw new Error(`${expectedName} failed: ${error?.code ?? "unknown"} ${error?.message ?? ""}`.trim());
  }
  return result.data;
}

function normalizedMediaType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : null;
}

export function redactCaptureIdentities(value, identityValues) {
  const secrets = [...new Set(identityValues.filter((item) => typeof item === "string" && item.length > 0))]
    .sort((left, right) => right.length - left.length);
  const identityKey = /^(?:room(?:_?id|_?code)?|code|participant_?id|self_?participant_?id|session(?:_?id|_?token)?|cookie|token)$/i;
  const visit = (input, key = "") => {
    if (typeof input === "string") {
      let output = identityKey.test(key) ? "[REDACTED]" : input;
      for (const secret of secrets) output = output.replaceAll(secret, "[REDACTED]");
      return output;
    }
    if (Array.isArray(input)) return input.map((item) => visit(item, key));
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([childKey, item]) => [childKey, visit(item, childKey)]));
    }
    return input;
  };
  const redacted = visit(value);
  const serialized = canonicalJson(redacted);
  if (/room_[A-Za-z0-9_-]{8,}/.test(serialized) || secrets.some((secret) => serialized.includes(secret))) {
    throw new Error("The redacted capture still contains a room or participant identity.");
  }
  return redacted;
}

export function collectCaptureIdentityValues(...values) {
  const identities = new Set();
  const identityKey = /^(?:room(?:_?id|_?code)?|code|participant_?id|self_?participant_?id|session(?:_?id|_?token)?|cookie|token)$/i;
  const visit = (value, key = "") => {
    if (typeof value === "string") {
      if (identityKey.test(key) || /^room_[A-Za-z0-9_-]{8,}$/.test(value)) identities.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, item] of Object.entries(value)) visit(item, childKey);
    }
  };
  for (const value of values) visit(value);
  return [...identities].sort(compareCodeUnits);
}

async function responseEvidence(response) {
  const bytes = Buffer.from(await response.body());
  let body;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    body = null;
  }
  return {
    status: response.status(),
    contentType: response.headers()["content-type"] ?? null,
    mediaType: normalizedMediaType(response.headers()["content-type"]),
    cacheControl: response.headers()["cache-control"] ?? null,
    matchedPath: response.headers()["x-matched-path"] ?? null,
    byteLength: bytes.byteLength,
    bodyDigest: sha256(bytes),
    canonicalBodyDigest: body === null ? null : hashCanonicalJson(body),
    body,
  };
}

async function readCaptureHistory(captureHistoryPath) {
  const bytes = await readFile(captureHistoryPath);
  const value = JSON.parse(bytes.toString("utf8"));
  if (value?.schemaVersion !== "baseline-v2-capture-history/v2"
      || value.stoppedRunCount !== 3
      || !Array.isArray(value.runs)
      || value.runs.length !== value.stoppedRunCount
      || value.runs.some((run, index) => (
        run?.sequence !== index + 1
        || run?.status !== "stopped_before_receipt"
        || run?.roomIdentifierRetained !== false
        || run?.roomDisposition !== "left_untouched"
      ))
      || value.supersededCompletedRun?.sequence !== 4
      || value.supersededCompletedRun?.status !== "completed_superseded"
      || value.supersededCompletedRun?.reasonCode !== "PRIVATE_EVIDENCE_INCOMPLETE"
      || !/^sha256:[a-f0-9]{64}$/.test(value.supersededCompletedRun?.inventoryCanonicalDigest ?? "")
      || !/^sha256:[a-f0-9]{64}$/.test(value.supersededCompletedRun?.evidenceCanonicalDigest ?? "")
      || !/^sha256:[a-f0-9]{64}$/.test(value.supersededCompletedRun?.pngDigest ?? "")
      || value.currentRun?.sequence !== 5
      || value.currentRun?.reasonCode !== "EVIDENCE_COMPLETENESS_CORRECTION") {
    throw new Error("The private capture-history log does not preserve three stopped runs and superseded run 4.");
  }
  return {
    currentRunSequence: 5,
    priorStoppedRunCount: value.stoppedRunCount,
    priorCompletedSupersededCount: 1,
    privateCaptureHistoryByteDigest: sha256(bytes),
    privateCaptureHistoryCanonicalDigest: hashCanonicalJson(value),
    supersededRunInventoryDigest: value.supersededCompletedRun.inventoryCanonicalDigest,
    supersededRunEvidenceDigest: value.supersededCompletedRun.evidenceCanonicalDigest,
    supersededRunPngDigest: value.supersededCompletedRun.pngDigest,
  };
}

function assertAnonymousArtifactProbe(probe, expectedPath) {
  if (probe.status !== 401 || probe.mediaType !== "application/json" || probe.cacheControl !== "no-store") {
    throw new Error(`${expectedPath} did not return a no-store JSON authorization response.`);
  }
  if (probe.matchedPath !== expectedPath) throw new Error(`${expectedPath} was not matched by the deployed handler.`);
  if (probe.body?.ok !== false || probe.body?.error?.code !== "AUTH_REQUIRED") {
    throw new Error(`${expectedPath} did not preserve guest-session authorization.`);
  }
}

async function captureProduction(outputDir, captureHistoryPath) {
  const captureHistory = await readCaptureHistory(captureHistoryPath);
  // Fail before creating a room if this evidence path has ever been used. A
  // capture run is append-only; a correction always receives a fresh path.
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  const capturedAt = new Date().toISOString();
  const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL });
  let health;
  let artifactHandlers;
  try {
    const landingResponse = await anonymous.get("/");
    if (landingResponse.status() !== 200) throw new Error(`Production landing returned ${landingResponse.status()}.`);
    const landingHtml = await landingResponse.text();
    const deploymentId = /data-dpl-id=["'](dpl_[A-Za-z0-9]+)["']/.exec(landingHtml)?.[1] ?? null;
    if (deploymentId !== EXPECTED_DEPLOYMENT_ID) {
      throw new Error(`Production alias resolved to ${deploymentId ?? "no deployment ID"}, expected ${EXPECTED_DEPLOYMENT_ID}.`);
    }

    const healthResponse = await anonymous.get("/api/health");
    health = await responseEvidence(healthResponse);
    if (health.status !== 200 || health.mediaType !== "application/json" || health.body?.ok !== true) {
      throw new Error("Production health did not return an operational JSON body.");
    }

    const human = await responseEvidence(await anonymous.get(
      "/api/rooms/baseline_v2_probe/artifacts?format=semantic_json&scope=room",
    ));
    const agent = await responseEvidence(await anonymous.get(
      "/api/rooms/baseline_v2_probe/agent/artifacts?format=semantic_json&scope=room",
    ));
    assertAnonymousArtifactProbe(human, "/api/rooms/[roomId]/artifacts");
    assertAnonymousArtifactProbe(agent, "/api/rooms/[roomId]/agent/artifacts");
    artifactHandlers = { human, agent };
  } finally {
    await anonymous.dispose();
  }

  const browser = await chromium.launch({ headless: true });
  let inventory;
  let semanticExport;
  let pngExport;
  let pngCaptureBytes;
  let browserVersion;
  let spectatorObservedRoomRevision;
  let semanticArtifactRedacted;
  let semanticHandlerRedacted;
  let authoritativeStateRedacted;
  try {
    browserVersion = browser.version();
    const participantContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      acceptDownloads: true,
    });
    const page = await participantContext.newPage();
    await installWebMcpShim(page);
    await page.goto("/");
    const landingTools = await waitForToolCount(page, EXPECTED_LANDING_COUNT, "landing");

    const navigation = page.waitForURL(/\/room\/room_[^/?#]+$/, { timeout: 20_000 });
    const created = successfulTool(await callTool(page, "create_room", {
      displayName: "Baseline Capture",
      title: "EXP-0001A baseline v2",
    }), "create_room");
    await navigation;
    const participantTools = await waitForToolCount(page, EXPECTED_PARTICIPANT_COUNT, "participant");

    const createdShape = successfulTool(await callTool(page, "create_shape", {
      label: "Baseline exact-revision evidence",
      semanticName: "Baseline exact-revision evidence",
      semanticRole: "verification-marker",
      shape: "rectangle",
      x: 120,
      y: 100,
      width: 360,
      height: 180,
      fill: "light-blue",
      stroke: "blue",
    }), "create_shape");
    if (!Array.isArray(createdShape.changedObjectIds) || createdShape.changedObjectIds.length !== 1) {
      throw new Error("Baseline marker creation did not return exactly one object ID.");
    }
    const objectId = createdShape.changedObjectIds[0];
    const state = successfulTool(await callTool(page, "read_room_state", {}), "read_room_state");
    const roomRevision = state?.room?.roomRevision;
    const object = state?.objects?.find((candidate) => candidate.id === objectId);
    if (!Number.isSafeInteger(roomRevision) || roomRevision < 1 || !Number.isSafeInteger(object?.revision) || object.revision < 1) {
      throw new Error("Authoritative state did not expose exact positive room and object revisions.");
    }

    const semanticToolData = successfulTool(await callTool(page, "export_canvas_artifact", {
      format: "semantic_json",
      scope: { kind: "room" },
    }), "export_canvas_artifact");
    if (semanticToolData.sourceRoomRevision !== roomRevision
        || semanticToolData.artifact?.source?.roomRevision !== roomRevision) {
      throw new Error("Semantic export was not bound to the authoritative room revision.");
    }
    const roomId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "");
    if (!roomId.startsWith("room_")) throw new Error("The participant page did not expose a private room path.");
    const semanticHttp = await page.evaluate(async ({ privateRoomId }) => {
      const response = await fetch(`/api/rooms/${encodeURIComponent(privateRoomId)}/agent/artifacts?format=semantic_json&scope=room`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        text: await response.text(),
      };
    }, { privateRoomId: roomId });
    const semanticHttpBytes = Buffer.from(semanticHttp.text, "utf8");
    const semanticEnvelope = JSON.parse(semanticHttp.text);
    const semanticArtifact = JSON.parse(semanticEnvelope.export.content);
    if (semanticHttp.status !== 200
        || normalizedMediaType(semanticHttp.contentType) !== "application/json"
        || semanticEnvelope.export.sourceRoomRevision !== roomRevision
        || semanticArtifact.source?.roomRevision !== roomRevision
        || hashCanonicalJson(semanticArtifact) !== hashCanonicalJson(semanticToolData.artifact)) {
      throw new Error("Authenticated semantic handler and WebMCP tool did not return the same exact-revision artifact.");
    }

    const identityValues = collectCaptureIdentityValues(roomId, created, state, semanticEnvelope, semanticArtifact);
    semanticArtifactRedacted = redactCaptureIdentities(semanticArtifact, identityValues);
    authoritativeStateRedacted = redactCaptureIdentities(state, identityValues);
    semanticHandlerRedacted = redactCaptureIdentities({
      ...semanticEnvelope,
      export: {
        ...semanticEnvelope.export,
        content: canonicalJson(semanticArtifactRedacted),
      },
    }, identityValues);
    const redactedSemanticArtifactBytes = Buffer.from(`${JSON.stringify(semanticArtifactRedacted, null, 2)}\n`, "utf8");
    const redactedSemanticHandlerBytes = Buffer.from(`${JSON.stringify(semanticHandlerRedacted, null, 2)}\n`, "utf8");
    const redactedStateBytes = Buffer.from(`${JSON.stringify(authoritativeStateRedacted, null, 2)}\n`, "utf8");
    semanticExport = {
      expectedRoomRevision: roomRevision,
      authoritativeState: {
        filename: "baseline-authoritative-state-redacted-v2.json",
        byteLength: redactedStateBytes.byteLength,
        fileDigest: sha256(redactedStateBytes),
        canonicalDigest: hashCanonicalJson(authoritativeStateRedacted),
      },
      response: {
        status: semanticHttp.status,
        contentType: semanticHttp.contentType,
        mediaType: normalizedMediaType(semanticHttp.contentType),
        cacheControl: semanticHttp.cacheControl,
        filename: "baseline-semantic-handler-redacted-v2.json",
        byteLength: redactedSemanticHandlerBytes.byteLength,
        bodyDigest: sha256(redactedSemanticHandlerBytes),
        canonicalBodyDigest: hashCanonicalJson(semanticHandlerRedacted),
      },
      tool: {
        name: "export_canvas_artifact",
        format: semanticToolData.format,
        declaredMediaType: semanticToolData.mediaType,
        sourceRoomRevision: semanticToolData.sourceRoomRevision,
        artifactSourceRoomRevision: semanticToolData.artifact.source.roomRevision,
        artifactFilename: "baseline-semantic-artifact-redacted-v2.json",
        artifactByteLength: redactedSemanticArtifactBytes.byteLength,
        artifactFileDigest: sha256(redactedSemanticArtifactBytes),
        artifactDigest: hashCanonicalJson(semanticArtifactRedacted),
        objectCount: semanticToolData.artifact.objects.length,
        diagramCount: semanticToolData.artifact.diagrams.length,
      },
    };

    const pngPromise = page.waitForEvent("download", { timeout: 30_000 });
    const pngToolPromise = callTool(page, "export_canvas_png", {
      scope: {
        kind: "objects",
        targets: [{ objectId, expectedRevision: object.revision }],
      },
      filename: "EXP-0001A baseline v2",
    });
    const [download, pngToolResult] = await Promise.all([pngPromise, pngToolPromise]);
    const pngToolData = successfulTool(pngToolResult, "export_canvas_png");
    const pngPath = await download.path();
    if (!pngPath) throw new Error("PNG export did not produce local downloaded bytes.");
    const pngBytes = await readFile(pngPath);
    pngCaptureBytes = pngBytes;
    const dimensions = pngDimensions(pngBytes);
    const pngChecks = {
      structure: dimensions !== null,
      mimeType: pngToolData.mimeType === "image/png",
      roomRevision: pngToolData.sourceRevisions?.roomRevision === roomRevision,
      contributorCount: pngToolData.sourceRevisions?.objectRevisions?.length === 1,
      contributorIdentity: pngToolData.sourceRevisions?.objectRevisions?.[0]?.objectId === objectId,
      contributorRevision: pngToolData.sourceRevisions?.objectRevisions?.[0]?.revision === object.revision,
      byteLength: pngToolData.byteLength === pngBytes.byteLength,
      width: pngToolData.width === dimensions?.width,
      height: pngToolData.height === dimensions?.height,
      persistence: pngToolData.persistedByJazzboard === false,
      filename: download.suggestedFilename() === pngToolData.filename,
    };
    if (Object.values(pngChecks).includes(false)) {
      throw new Error(`PNG download bytes, metadata, target revision, and WebMCP receipt did not agree: ${JSON.stringify(pngChecks)}`);
    }
    pngExport = {
      expectedRoomRevision: roomRevision,
      expectedObjectRevision: object.revision,
      targetCount: 1,
      tool: {
        name: "export_canvas_png",
        filename: pngToolData.filename,
        declaredMimeType: pngToolData.mimeType,
        width: pngToolData.width,
        height: pngToolData.height,
        declaredByteLength: pngToolData.byteLength,
        sourceRoomRevision: pngToolData.sourceRevisions.roomRevision,
        sourceObjectRevisions: pngToolData.sourceRevisions.objectRevisions.map((source) => source.revision),
        visualContributorCount: (
          pngToolData.sourceRevisions.visualContributorRevisions
          ?? pngToolData.sourceRevisions.objectRevisions
        ).length,
        persistedByJazzboard: pngToolData.persistedByJazzboard,
      },
      download: {
        filename: download.suggestedFilename(),
        observedMimeType: "image/png",
        byteLength: pngBytes.byteLength,
        sha256: sha256(pngBytes),
        width: dimensions.width,
        height: dimensions.height,
        pngStructureValidated: true,
      },
    };

    const spectatorContext = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 720 } });
    const spectatorPage = await spectatorContext.newPage();
    await installWebMcpShim(spectatorPage);
    await spectatorPage.goto("/");
    await waitForToolCount(spectatorPage, EXPECTED_LANDING_COUNT, "spectator landing");
    const spectatorNavigation = spectatorPage.waitForURL(/\/room\/room_[^/?#]+$/, { timeout: 20_000 });
    successfulTool(await callTool(spectatorPage, "join_room", {
      code: created.room.code,
      displayName: "Baseline Spectator",
      role: "spectator",
    }), "join_room");
    await spectatorNavigation;
    const spectatorTools = await waitForToolCount(spectatorPage, EXPECTED_SPECTATOR_COUNT, "spectator");
    const spectatorState = successfulTool(await callTool(spectatorPage, "read_room_state", {}), "read_room_state");
    spectatorObservedRoomRevision = spectatorState.room.roomRevision;
    if (!Number.isSafeInteger(spectatorObservedRoomRevision)
        || spectatorObservedRoomRevision < roomRevision) {
      throw new Error("Spectator read returned a revision older than the exact-revision artifacts.");
    }

    inventory = assertCapturedInventory({
      schemaVersion: 2,
      capturedAt,
      deploymentId: EXPECTED_DEPLOYMENT_ID,
      origin: BASE_URL,
      captureMethod: "browser-exposed-webmcp-registry",
      landing: buildInventoryScope(landingTools),
      participant: buildInventoryScope(participantTools),
      spectator: buildInventoryScope(spectatorTools),
    });
    assertPrivateInventoryScope(inventory.landing, "landing");
    assertPrivateInventoryScope(inventory.participant, "participant");
    assertPrivateInventoryScope(inventory.spectator, "spectator");
    await spectatorContext.close();
    await participantContext.close();
  } finally {
    await browser.close();
  }

  if (!semanticArtifactRedacted || !semanticHandlerRedacted || !authoritativeStateRedacted) {
    throw new Error("The redacted semantic evidence was not retained.");
  }
  const publicInventory = {
    ...inventory,
    landing: projectPublicInventoryScope(inventory.landing),
    participant: projectPublicInventoryScope(inventory.participant),
    spectator: projectPublicInventoryScope(inventory.spectator),
  };
  const evidence = {
    schemaVersion: 2,
    kind: "production-browser-webmcp-baseline-evidence",
    capturedAt,
    captureCompletedAt: new Date().toISOString(),
    deploymentId: EXPECTED_DEPLOYMENT_ID,
    origin: BASE_URL,
    runtime: {
      node: process.version,
      browser: { engine: "chromium", version: browserVersion },
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      transport: "browser-webmcp",
      codexNativeOnly: true,
    },
    captureHistory,
    health,
    artifactHandlers,
    semanticExport,
    pngExport,
    roleIsolation: {
      participantCanMutate: true,
      spectatorCanMutate: false,
      spectatorObservedRoomRevision,
      artifactRoomRevision: semanticExport.expectedRoomRevision,
    },
    privacy: {
      roomIdentifiersPersisted: false,
      roomCodesPersisted: false,
      participantIdentifiersPersisted: false,
      sessionCredentialsPersisted: false,
      imageBytesIncludedInPublicReceipt: false,
      privatePngBytesRetained: true,
      privateFullDescriptorsRetained: true,
      privateRedactedSemanticBytesRetained: true,
    },
  };

  const serialized = [
    ["baseline-webmcp-inventory-v2.json", publicInventory],
    ["baseline-production-evidence-v2.json", evidence],
    ["baseline-webmcp-inventory-private-v2.json", inventory],
    ["baseline-semantic-artifact-redacted-v2.json", semanticArtifactRedacted],
    ["baseline-semantic-handler-redacted-v2.json", semanticHandlerRedacted],
    ["baseline-authoritative-state-redacted-v2.json", authoritativeStateRedacted],
  ];
  if (!pngCaptureBytes) throw new Error("The exact-revision PNG bytes were not retained.");
  for (const [filename, value] of serialized) {
    await writeFile(path.join(outputDir, filename), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  await writeFile(path.join(outputDir, "baseline-exact-revision-v2.png"), pngCaptureBytes, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    capturedAt,
    completedAt: evidence.captureCompletedAt,
    publicInventoryDigest: hashCanonicalJson(publicInventory),
    privateInventoryDigest: hashCanonicalJson(inventory),
    evidenceDigest: hashCanonicalJson(evidence),
    landingTools: inventory.landing.toolCount,
    participantTools: inventory.participant.toolCount,
    spectatorTools: inventory.spectator.toolCount,
    roomRevision: semanticExport.expectedRoomRevision,
    pngDigest: pngExport.download.sha256,
    captureRunSequence: captureHistory.currentRunSequence,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const summary = await captureProduction(args.outputDir, args.captureHistoryLog);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`baseline-v2 capture failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
