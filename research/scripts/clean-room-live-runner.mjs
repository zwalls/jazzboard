#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const PRIVATE_KEY_PATTERN = /^(?:room(?:id|code)|room_id|room_code|session(?:id|key|token)?|session_id|participantid|participant_id|selfparticipantid|previewid|recentroom|recentrooms|cookie|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)$/i;
const SAFE_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/;
const FROZEN_SPECTATOR_TOOL_NAMES = new Set([
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
  "read_canvas_drafts",
  "list_activity",
  "read_activity",
  "export_canvas_artifact",
  "export_canvas_png",
  "list_agent_edit_proposals",
  "read_agent_edit_proposal",
  "inspect_canvas_scope",
]);
const NON_MUTATING_PARTICIPANT_TOOL_NAMES = new Set([
  ...FROZEN_SPECTATOR_TOOL_NAMES,
  "focus_viewport",
  "render_canvas_preview",
  "create_diagram_template",
]);

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertFreshRoomCode(value) {
  if (typeof value !== "string" || !/^[A-HJ-NP-Z2-9]{6}$/.test(value)) {
    throw new Error("Fresh room creation returned a legacy, malformed, or low-entropy join code.");
  }
  return value;
}

function redactString(value, secrets) {
  let redacted = value;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 3) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
    try {
      redacted = redacted.split(encodeURIComponent(secret)).join("[REDACTED]");
    } catch {
      // A malformed URI fragment is still covered by the literal replacement.
    }
  }
  return redacted;
}

export function sanitizeForResearch(value, options = {}) {
  const secrets = [...new Set((options.secrets ?? []).filter((item) => typeof item === "string"))]
    .sort((left, right) => right.length - left.length);
  const seen = new WeakSet();
  function visit(item, key = "", parentKey = "") {
    if (PRIVATE_KEY_PATTERN.test(key)) return "[REDACTED]";
    if (/^room$/i.test(parentKey) && /^(?:id|code)$/i.test(key)) return "[REDACTED]";
    if (typeof item === "string") return redactString(item, secrets);
    if (item === null || typeof item === "number" || typeof item === "boolean") return item;
    if (item === undefined) return undefined;
    if (Array.isArray(item)) return item.map((entry) => visit(entry, "", key));
    if (typeof item === "object") {
      if (seen.has(item)) throw new TypeError("Cannot sanitize cyclic evidence.");
      seen.add(item);
      const output = {};
      for (const [childKey, childValue] of Object.entries(item)) {
        output[childKey] = visit(childValue, childKey, key);
      }
      seen.delete(item);
      return output;
    }
    return String(item);
  }
  return visit(value);
}

export function hashArtifactSet(artifacts) {
  const leaves = Object.entries(artifacts)
    .map(([artifactPath, contents]) => ({
      path: artifactPath.replaceAll(path.sep, "/"),
      bytes: Buffer.byteLength(contents),
      sha256: sha256(contents),
    }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  return { algorithm: "sha256", leaves, root: sha256(canonicalJson(leaves)) };
}

function normalizeToolDescriptor(tool) {
  if (!tool || typeof tool !== "object" || !SAFE_TOOL_NAME.test(tool.name ?? "")) {
    throw new Error("The live page registered an invalid WebMCP tool descriptor.");
  }
  if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
    throw new Error(`WebMCP tool ${tool.name} has no object input schema.`);
  }
  return {
    name: tool.name,
    title: typeof tool.title === "string" ? tool.title : tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    inputSchema: tool.inputSchema,
    annotations: tool.annotations && typeof tool.annotations === "object" ? tool.annotations : {},
  };
}

export function toolContractHash(tools) {
  return sha256(canonicalJson(tools.map(normalizeToolDescriptor).sort((a, b) => compareCodeUnits(a.name, b.name))));
}

export function buildResponsesTools(liveTools, allowedToolNames) {
  const byName = new Map(liveTools.map((tool) => {
    const descriptor = normalizeToolDescriptor(tool);
    return [descriptor.name, descriptor];
  }));
  const selected = allowedToolNames.map((name) => {
    const descriptor = byName.get(name);
    if (!descriptor) throw new Error(`Allowed tool ${name} is not registered by the live room.`);
    return {
      type: "function",
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.inputSchema,
      strict: false,
      defer_loading: true,
      allowed_callers: ["direct"],
    };
  });
  return [
    { type: "tool_search", execution: "server" },
    {
      type: "namespace",
      name: "jazzboard",
      description: "Live Jazzboard room tools. Load only the tools needed for the current step.",
      tools: selected,
    },
  ];
}

export function assertSpectatorToolIsolation(liveTools) {
  const descriptors = liveTools.map(normalizeToolDescriptor);
  const unexpected = descriptors.map((tool) => tool.name).filter((name) => !FROZEN_SPECTATOR_TOOL_NAMES.has(name));
  if (unexpected.length) {
    throw new Error(`Spectator context exposed tools outside the frozen read/export allowlist: ${unexpected.join(", ")}.`);
  }
  return descriptors;
}

export function accumulateResponseUsage(current, usage, budgets) {
  const inputTokens = Number(usage?.input_tokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? 0);
  if (![inputTokens, outputTokens].every((value) => Number.isInteger(value) && value >= 0)) {
    throw new Error("Responses API returned invalid token usage.");
  }
  const totals = {
    inputTokens: current.inputTokens + inputTokens,
    outputTokens: current.outputTokens + outputTokens,
    totalTokens: current.totalTokens + inputTokens + outputTokens,
  };
  return {
    totals,
    turn: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    exhausted: {
      input: totals.inputTokens >= budgets.inputTokenBudget,
      output: totals.outputTokens >= budgets.outputTokenBudget,
    },
    remaining: {
      input: Math.max(0, budgets.inputTokenBudget - totals.inputTokens),
      output: Math.max(0, budgets.outputTokenBudget - totals.outputTokens),
    },
  };
}

export function buildAuthorVisibleSpec(config, dryRun = false) {
  return {
    attemptId: config.attemptId,
    model: dryRun ? null : config.model,
    brief: config.brief,
    allowedToolNames: config.allowedToolNames,
    budgets: {
      wallMs: config.wallBudgetMs,
      toolCalls: config.toolCallBudget,
      perToolTimeoutMs: config.perToolTimeoutMs,
      inputTokens: config.inputTokenBudget,
      outputTokens: config.outputTokenBudget,
    },
  };
}

export function classifyAuthorToolObservation(tool, result) {
  if (!tool || result?.ok === false) return [];
  const observations = [];
  if (tool.name === "inspect_canvas_scope" || tool.name === "render_canvas_preview") {
    observations.push("first_visual_inspection");
  }
  if (tool.name === "apply_canvas_transaction"
      && (result?.data?.outcome === "drafted" || result?.outcome === "drafted")) {
    observations.push("first_draft_staged");
  }
  const readOnly = tool.annotations?.readOnlyHint === true;
  const receiptSuggestsMutation = [
    result?.data?.changedObjectIds,
    result?.data?.changedDiagramIds,
    result?.changedObjectIds,
    result?.changedDiagramIds,
  ].some((value) => Array.isArray(value) && value.length > 0)
    || typeof result?.data?.outcome === "string"
    || typeof result?.outcome === "string";
  if (!readOnly && !NON_MUTATING_PARTICIPANT_TOOL_NAMES.has(tool.name) && (result?.ok === true || receiptSuggestsMutation)) {
    observations.push("first_author_mutation");
  }
  return observations;
}

function namespacedToolName(item) {
  const rawName = typeof item?.name === "string" ? item.name : "";
  const explicitNamespace = item?.namespace ?? item?.tool_namespace ?? item?.toolNamespace;
  if (explicitNamespace !== undefined) {
    return explicitNamespace === "jazzboard" ? rawName : null;
  }
  for (const separator of [".", "__", "/"]) {
    const prefix = `jazzboard${separator}`;
    if (rawName.startsWith(prefix)) return rawName.slice(prefix.length);
  }
  return null;
}

export function extractFunctionCalls(response, allowedToolNames) {
  const allowed = new Set(allowedToolNames);
  const calls = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== "function_call") continue;
    const name = namespacedToolName(item);
    if (!name || !allowed.has(name)) {
      throw new Error(`Responses API attempted an unlisted or unnamespaced tool: ${item?.name ?? "unknown"}.`);
    }
    if (typeof item.call_id !== "string" || !item.call_id) {
      throw new Error(`Responses API returned ${name} without a call_id.`);
    }
    let input;
    try {
      input = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
    } catch {
      throw new Error(`Responses API returned malformed JSON arguments for ${name}.`);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error(`Responses API returned non-object arguments for ${name}.`);
    }
    calls.push({ callId: item.call_id, name, input });
  }
  return calls;
}

function finiteRectangle(value) {
  const left = Number(value?.x ?? value?.left);
  const top = Number(value?.y ?? value?.top);
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (![left, top, width, height].every(Number.isFinite) || left < 0 || top < 0 || width <= 0 || height <= 0) {
    throw new Error("WebMCP preview returned an invalid screenshot clip.");
  }
  return { left: Math.floor(left), top: Math.floor(top), width: Math.ceil(width), height: Math.ceil(height) };
}

export function extractPixelCapture(toolName, result, viewport, now = Date.now()) {
  if (toolName !== "inspect_canvas_scope" && toolName !== "render_canvas_preview") return null;
  if (result?.ok !== true || result?.tool !== toolName || result?.data?.presentation !== "live_canvas") {
    throw new Error(`${toolName} did not return a successful live-canvas presentation.`);
  }
  const clip = finiteRectangle(result.data.screenshotClip);
  if (clip.left + clip.width > viewport.width || clip.top + clip.height > viewport.height) {
    throw new Error(`${toolName} returned a screenshot clip outside the clean viewport.`);
  }
  const selector = result.data.validation?.activeSelector;
  if (typeof selector !== "string" || !selector) {
    throw new Error(`${toolName} did not return an active validation selector.`);
  }
  const expiresAt = Date.parse(result.data.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error(`${toolName} pixel lease has expired.`);
  const roomRevision = toolName === "inspect_canvas_scope"
    ? result.data.sceneContext?.revisions?.roomRevision
    : result.data.sourceRevisions?.roomRevision;
  if (!Number.isInteger(roomRevision) || roomRevision < 0) {
    throw new Error(`${toolName} did not bind its pixels to a room revision.`);
  }
  return { clip, selector, expiresAt: result.data.expiresAt, roomRevision };
}

export function validateRunnerConfig(raw, dryRun = false) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Runner config must be a JSON object.");
  const attemptId = String(raw.attemptId ?? "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(attemptId)) {
    throw new Error("attemptId must be a safe 1-80 character artifact identifier.");
  }
  const baseUrl = new URL(String(raw.baseUrl ?? ""));
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== "/") {
    throw new Error("baseUrl must be an HTTP(S) deployment origin without credentials, path, query, or fragment.");
  }
  const brief = String(raw.brief ?? "").trim();
  if (!dryRun && !brief) throw new Error("A non-empty author brief is required for a live run.");
  const allowedToolNames = [...new Set(raw.allowedToolNames ?? [])];
  if (allowedToolNames.some((name) => typeof name !== "string" || !SAFE_TOOL_NAME.test(name))) {
    throw new Error("allowedToolNames contains an invalid tool name.");
  }
  if (!dryRun && allowedToolNames.length === 0) throw new Error("A live run requires an explicit non-empty allowedToolNames list.");
  const participantToolContractHash = raw.participantToolContractHash;
  if (!dryRun && !/^[a-f0-9]{64}$/.test(participantToolContractHash ?? "")) {
    throw new Error("A live run requires the participant tool-contract hash produced by contract mode.");
  }
  const spectatorToolContractHash = raw.spectatorToolContractHash;
  if (!dryRun && !/^[a-f0-9]{64}$/.test(spectatorToolContractHash ?? "")) {
    throw new Error("A live run requires the spectator tool-contract hash produced by contract mode.");
  }
  const model = String(raw.model ?? "").trim();
  if (!dryRun && !model) throw new Error("A live run requires an explicit Responses API model.");
  const wallBudgetMs = Number(raw.wallBudgetMs ?? 900_000);
  const toolCallBudget = Number(raw.toolCallBudget ?? 80);
  const perToolTimeoutMs = Number(raw.perToolTimeoutMs ?? 30_000);
  const inputTokenBudget = Number(raw.inputTokenBudget ?? (dryRun ? 1 : Number.NaN));
  const outputTokenBudget = Number(raw.outputTokenBudget ?? (dryRun ? 1 : Number.NaN));
  const perResponseMaxOutputTokens = Number(raw.perResponseMaxOutputTokens ?? outputTokenBudget);
  if (!Number.isInteger(wallBudgetMs) || wallBudgetMs < 10_000 || wallBudgetMs > 3_600_000) throw new Error("wallBudgetMs is out of range.");
  if (!Number.isInteger(toolCallBudget) || toolCallBudget < 1 || toolCallBudget > 500) throw new Error("toolCallBudget is out of range.");
  if (!Number.isInteger(perToolTimeoutMs) || perToolTimeoutMs < 1_000 || perToolTimeoutMs > 120_000) throw new Error("perToolTimeoutMs is out of range.");
  if (!Number.isInteger(inputTokenBudget) || inputTokenBudget < 1 || inputTokenBudget > 10_000_000) throw new Error("inputTokenBudget is out of range.");
  if (!Number.isInteger(outputTokenBudget) || outputTokenBudget < 1 || outputTokenBudget > 10_000_000) throw new Error("outputTokenBudget is out of range.");
  if (!Number.isInteger(perResponseMaxOutputTokens) || perResponseMaxOutputTokens < 1 || perResponseMaxOutputTokens > outputTokenBudget) {
    throw new Error("perResponseMaxOutputTokens must be within the cumulative output-token budget.");
  }
  if (raw.maxOutputTokens !== undefined) throw new Error("Use perResponseMaxOutputTokens; maxOutputTokens is ambiguous with the cumulative budget.");
  if (raw.allowedBrowserOrigins !== undefined && !Array.isArray(raw.allowedBrowserOrigins)) throw new Error("allowedBrowserOrigins must be an array.");
  const allowedBrowserOrigins = [...new Set([baseUrl.origin, ...(raw.allowedBrowserOrigins ?? [])])].map((origin) => new URL(origin).origin);
  const normalizeOperations = (operations, label) => {
    if (!Array.isArray(operations)) throw new Error(`${label} must be an array.`);
    return operations.map((operation, index) => {
      if (!operation || typeof operation !== "object" || !SAFE_TOOL_NAME.test(operation.tool ?? "")) {
        throw new Error(`${label}[${index}] has an invalid WebMCP tool name.`);
      }
      if (!operation.input || typeof operation.input !== "object" || Array.isArray(operation.input)) {
        throw new Error(`${label}[${index}] requires an object input.`);
      }
      return { tool: operation.tool, input: structuredClone(operation.input) };
    });
  };
  const setupOperations = normalizeOperations(raw.setupOperations ?? [], "setupOperations");
  const concurrentEventCallbackHash = raw.concurrentEventCallbackHash ?? null;
  if (concurrentEventCallbackHash !== null && !/^[a-f0-9]{64}$/.test(concurrentEventCallbackHash)) {
    throw new Error("concurrentEventCallbackHash must be a frozen SHA-256 digest.");
  }
  const concurrentEvents = (raw.concurrentEvents ?? []).map((event, index) => {
    const id = event?.id ?? event?.eventFixtureId;
    if (!event || typeof event !== "object" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id ?? "")) {
      throw new Error(`concurrentEvents[${index}] requires a safe unique id.`);
    }
    const observableTrigger = event.observableTrigger ?? event.trigger;
    let trigger;
    if (observableTrigger) {
      if (observableTrigger.kind !== undefined && observableTrigger.kind !== "after_observable") {
        throw new Error(`concurrentEvents[${index}] has an unsupported observable trigger kind.`);
      }
      if (!["first_author_mutation", "first_visual_inspection", "first_draft_staged"].includes(observableTrigger.observable)) {
        throw new Error(`concurrentEvents[${index}] has an unsupported observable.`);
      }
      if (!Number.isInteger(observableTrigger.occurrence) || observableTrigger.occurrence < 1 || observableTrigger.occurrence > toolCallBudget) {
        throw new Error(`concurrentEvents[${index}] occurrence must be within the author tool-call budget.`);
      }
      trigger = { observable: observableTrigger.observable, occurrence: observableTrigger.occurrence };
    } else {
      if (!Number.isInteger(event.afterAuthorToolCall) || event.afterAuthorToolCall < 1 || event.afterAuthorToolCall > toolCallBudget) {
        throw new Error(`concurrentEvents[${index}] requires an observable trigger or valid legacy author-tool ordinal.`);
      }
      trigger = { afterAuthorToolCall: event.afterAuthorToolCall };
    }
    const operations = concurrentEventCallbackHash
      ? structuredClone(event.operations ?? [])
      : normalizeOperations(event.operations, `concurrentEvents[${index}].operations`);
    if (!Array.isArray(operations)) throw new Error(`concurrentEvents[${index}].operations must be an array.`);
    if (operations.length === 0) throw new Error(`concurrentEvents[${index}] must contain an operation.`);
    return { id, trigger, operations };
  });
  if (new Set(concurrentEvents.map((event) => event.id)).size !== concurrentEvents.length) {
    throw new Error("concurrent event ids must be unique.");
  }
  return {
    attemptId,
    baseUrl: baseUrl.href,
    brief,
    model,
    reasoningEffort: raw.reasoningEffort ?? "high",
    allowedToolNames,
    participantToolContractHash,
    spectatorToolContractHash,
    wallBudgetMs,
    toolCallBudget,
    perToolTimeoutMs,
    inputTokenBudget,
    outputTokenBudget,
    perResponseMaxOutputTokens,
    allowedBrowserOrigins,
    displayName: String(raw.displayName ?? "Research Author").slice(0, 48),
    roomTitle: String(raw.roomTitle ?? `Research ${attemptId}`).slice(0, 100),
    spectatorDisplayName: String(raw.spectatorDisplayName ?? "Research Evaluator").slice(0, 48),
    setupActorDisplayName: String(raw.setupActorDisplayName ?? "Research Fixture").slice(0, 48),
    eventActorDisplayName: String(raw.eventActorDisplayName ?? "Research Collaborator").slice(0, 48),
    setupOperations,
    setupCallbackHash: raw.setupCallbackHash ?? null,
    concurrentEvents,
    concurrentEventCallbackHash,
    headless: raw.headless !== false,
  };
}

export async function executePreBriefSetup({ operations, execute, callback, callbackHash, captureState }) {
  if (callback && !/^[a-f0-9]{64}$/.test(callbackHash ?? "")) {
    throw new Error("A trusted setup callback requires its frozen SHA-256 digest.");
  }
  const plan = { operations, callbackHash: callback ? callbackHash : null };
  const planHash = sha256(canonicalJson(plan));
  const receipts = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    receipts.push({ index, tool: operation.tool, result: await execute(operation.tool, operation.input) });
  }
  const callbackReceipt = callback ? await callback({ execute }) : null;
  const state = await captureState();
  return {
    status: "completed",
    plan,
    planHash,
    receipts,
    callbackReceipt,
    initialStateHash: sha256(canonicalJson(state)),
  };
}

export function createConcurrentEventController(definitions, execute, now = Date.now, options = {}) {
  const normalizedDefinitions = definitions.map((event) => ({
    ...event,
    trigger: event.trigger ?? { afterAuthorToolCall: event.afterAuthorToolCall },
  }));
  const pending = new Map(normalizedDefinitions.map((event) => [event.id, event]));
  const planHash = sha256(canonicalJson({ definitions: normalizedDefinitions, executorHash: options.executorHash ?? null }));
  const receipts = [];
  const observableOccurrences = new Map();
  return {
    planHash,
    receipts,
    async afterAuthorToolCall(observation, attemptStartedAt) {
      const normalized = typeof observation === "number"
        ? { ordinal: observation, name: null, observations: [] }
        : observation;
      for (const observable of normalized.observations ?? []) {
        observableOccurrences.set(observable, (observableOccurrences.get(observable) ?? 0) + 1);
      }
      const due = [...pending.values()]
        .filter((event) => event.trigger?.afterAuthorToolCall === normalized.ordinal
          || (event.trigger?.observable
            && (normalized.observations ?? []).includes(event.trigger.observable)
            && observableOccurrences.get(event.trigger.observable) === event.trigger.occurrence))
        .sort((left, right) => compareCodeUnits(left.id, right.id));
      for (const event of due) {
        const receipt = {
          id: event.id,
          trigger: {
            ...event.trigger,
            authorToolOrdinal: normalized.ordinal,
            authorToolName: normalized.name,
          },
          elapsedMs: now() - attemptStartedAt,
          operationDigest: sha256(canonicalJson(event.operations)),
          status: "running",
          operations: [],
        };
        receipts.push(receipt);
        pending.delete(event.id);
        try {
          if (options.eventExecutor) {
            receipt.callbackReceipt = await options.eventExecutor({
              event: structuredClone({ id: event.id, trigger: event.trigger, operations: event.operations }),
              execute,
            });
          } else {
            for (let index = 0; index < event.operations.length; index += 1) {
              const operation = event.operations[index];
              receipt.operations.push({ index, tool: operation.tool, result: await execute(operation.tool, operation.input) });
            }
          }
          receipt.status = "completed";
        } catch (error) {
          receipt.status = "failed";
          receipt.error = { message: error instanceof Error ? error.message : String(error) };
          throw error;
        }
      }
      return due.map((event) => event.id);
    },
    unresolved() {
      return [...pending.values()].map((event) => ({ id: event.id, trigger: event.trigger }));
    },
  };
}

function eventRecorder(startedAt, secrets) {
  const events = [];
  return {
    events,
    add(type, data = {}) {
      events.push(sanitizeForResearch({
        sequence: events.length,
        elapsedMs: Date.now() - startedAt,
        type,
        data,
      }, { secrets }));
    },
  };
}

function installWebMcpHostShim() {
  const tools = new Map();
  Object.defineProperty(window, "__jazzboardResearchTools", { configurable: true, value: tools });
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

function normalizeRequestOrigin(url) {
  const parsed = new URL(url);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  return parsed.origin;
}

async function createCleanContext(browser, config, events, label) {
  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
  });
  const allowedOrigins = new Set(config.allowedBrowserOrigins);
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:") || allowedOrigins.has(normalizeRequestOrigin(requestUrl))) {
      await route.continue();
    } else {
      events.add("browser_request_blocked", { label, origin: normalizeRequestOrigin(requestUrl) });
      await route.abort("blockedbyclient");
    }
  });
  await context.addInitScript(installWebMcpHostShim);
  const page = await context.newPage();
  return { context, page };
}

async function waitForTool(page, name, timeoutMs = 30_000) {
  await page.waitForFunction((toolName) => window.__jazzboardResearchTools?.has(toolName), name, { timeout: timeoutMs });
}

async function liveTools(page) {
  return page.evaluate(async () => document.modelContext.getTools());
}

async function executeLiveTool(page, name, input, timeoutMs) {
  return page.evaluate(async ({ toolName, toolInput, toolTimeoutMs }) => {
    const tool = window.__jazzboardResearchTools?.get(toolName);
    if (!tool) throw new Error(`WebMCP tool is not registered: ${toolName}`);
    const controller = new AbortController();
    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`WEBMCP_TOOL_TIMEOUT:${toolName}`));
      }, toolTimeoutMs);
    });
    try {
      return await Promise.race([tool.execute(toolInput, { signal: controller.signal }), deadline]);
    } finally {
      clearTimeout(timeout);
    }
  }, { toolName: name, toolInput: input, toolTimeoutMs: timeoutMs });
}

async function captureBoundPixels(page, toolName, result) {
  const capture = extractPixelCapture(toolName, result, DEFAULT_VIEWPORT);
  if (!capture) return null;
  const active = page.locator(capture.selector);
  if (await active.count() !== 1 || !(await active.isVisible())) {
    throw new Error(`${toolName} validation selector was not uniquely active at capture time.`);
  }
  const fullViewport = await page.screenshot({ type: "png", animations: "disabled" });
  const { default: sharp } = await import("sharp");
  const png = await sharp(fullViewport).extract(capture.clip).png().toBuffer();
  return { ...capture, png };
}

function outputText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  return (response?.output ?? []).flatMap((item) => item?.content ?? [])
    .filter((content) => content?.type === "output_text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("\n");
}

async function responsesRequest(body, apiKey, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await response.json();
    if (!response.ok) throw new Error(`Responses API failed with HTTP ${response.status}: ${json?.error?.message ?? "unknown error"}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function replayableOutput(output) {
  // These items stay in volatile process memory only. Replaying them verbatim
  // is required for stateless reasoning/tool-search continuity with store:false.
  return structuredClone(Array.isArray(output) ? output : []);
}

function providerString(value, maxLength) {
  if (typeof value !== "string" || !/^[\x20-\x7e]+$/.test(value)) return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : null;
}

/** Selects only durable provider provenance; response IDs and payload contents are intentionally excluded. */
export function responseProviderObservation(response) {
  return Object.freeze({
    model: providerString(response?.model, 200),
    serviceTier: providerString(response?.service_tier, 80),
  });
}

export function summarizeObservedProvider(observations) {
  const normalized = observations.map((observation) => ({
    model: providerString(observation?.model, 200),
    serviceTier: providerString(observation?.serviceTier, 80),
  }));
  const observedModels = [...new Set(normalized.flatMap((observation) => observation.model ? [observation.model] : []))]
    .sort(compareCodeUnits);
  const observedServiceTiers = [...new Set(normalized.flatMap((observation) => observation.serviceTier ? [observation.serviceTier] : []))]
    .sort(compareCodeUnits);
  return Object.freeze({
    provider: "openai_responses",
    completedTurns: normalized.length,
    observedModels: Object.freeze(observedModels),
    observedServiceTiers: Object.freeze(observedServiceTiers),
    allTurnsReportedModel: normalized.length > 0 && normalized.every((observation) => observation.model !== null),
    allTurnsReportedServiceTier: normalized.length > 0 && normalized.every((observation) => observation.serviceTier !== null),
  });
}

export function responsesRequestCompletedData(turn, usage, cumulativeUsage, response) {
  return Object.freeze({
    turn,
    usage,
    cumulativeUsage,
    status: response?.status ?? null,
    provider: responseProviderObservation(response),
  });
}

async function runAuthor({ config, page, tools, events, secrets, artifacts, startedAt, concurrentEvents }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for a live run and is read only from the process environment.");
  const responseTools = buildResponsesTools(tools, config.allowedToolNames);
  const descriptorsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const conversation = [{ role: "user", content: [{ type: "input_text", text: config.brief }] }];
  const instructions = [
    "You are the isolated author for a Jazzboard benchmark attempt.",
    "Use only tools in the jazzboard namespace. You have no shell, repository, DOM, browser-automation, filesystem, evaluator, or raw-network access.",
    "Use tool_search to load only the Jazzboard tools needed for the current step.",
    "All tool calls are sequential. Inspect exact revision-bound pixels with inspect_canvas_scope or render_canvas_preview before declaring the work complete.",
  ].join(" ");
  let toolCalls = 0;
  let finalText = "";
  let termination = "author_completed";
  let usageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const usageByTurn = [];
  const providerByTurn = [];
  while (true) {
    const remaining = config.wallBudgetMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      termination = "wall_budget_exceeded";
      break;
    }
    const remainingOutputTokens = config.outputTokenBudget - usageTotals.outputTokens;
    if (remainingOutputTokens <= 0 || usageTotals.inputTokens >= config.inputTokenBudget) {
      termination = remainingOutputTokens <= 0 ? "output_token_budget_exceeded" : "input_token_budget_exceeded";
      break;
    }
    const turn = usageByTurn.length + 1;
    events.add("responses_request_started", { turn, remainingOutputTokens });
    let response;
    try {
      response = await responsesRequest({
        model: config.model,
        instructions,
        input: conversation,
        tools: responseTools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: config.reasoningEffort },
        max_output_tokens: Math.min(config.perResponseMaxOutputTokens, remainingOutputTokens),
      }, apiKey, remaining);
    } catch (error) {
      events.add("responses_request_failed", { message: error instanceof Error ? error.message : String(error) });
      termination = error instanceof DOMException && error.name === "AbortError" ? "wall_budget_exceeded" : "responses_api_failed";
      break;
    }
    const usage = accumulateResponseUsage(usageTotals, response.usage, config);
    usageTotals = usage.totals;
    usageByTurn.push({ turn, ...usage.turn });
    const completed = responsesRequestCompletedData(turn, usage.turn, usageTotals, response);
    providerByTurn.push(completed.provider);
    events.add("responses_request_completed", completed);
    for (const item of response.output ?? []) {
      if (item?.type === "tool_search_call" || item?.type === "tool_search_output") {
        const trace = structuredClone(item);
        delete trace.id;
        delete trace.call_id;
        delete trace.encrypted_content;
        events.add("model_tool_search", { item: trace });
      }
    }
    finalText = outputText(response);
    const calls = extractFunctionCalls(response, config.allowedToolNames);
    if (usage.exhausted.input || usage.exhausted.output) {
      termination = usage.exhausted.output ? "output_token_budget_exceeded" : "input_token_budget_exceeded";
      events.add("token_budget_exhausted", { termination, totals: usageTotals });
      for (const call of calls) events.add("author_tool_rejected", { name: call.name, reason: termination });
      break;
    }
    if (response.status === "incomplete") {
      termination = "responses_incomplete";
      events.add("responses_incomplete", { details: response.incomplete_details ?? null });
      for (const call of calls) events.add("author_tool_rejected", { name: call.name, reason: termination });
      break;
    }
    conversation.push(...replayableOutput(response.output));
    if (calls.length === 0) {
      break;
    }
    for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
      const call = calls[callIndex];
      if (toolCalls >= config.toolCallBudget) {
        termination = "tool_budget_exceeded";
        for (const rejected of calls.slice(callIndex)) {
          events.add("author_tool_rejected", { name: rejected.name, reason: termination });
        }
        break;
      }
      toolCalls += 1;
      const ordinal = toolCalls;
      events.add("author_tool_started", { ordinal, name: call.name, input: call.input });
      let result;
      let pixel = null;
      try {
        const remainingForTool = Math.min(config.perToolTimeoutMs, config.wallBudgetMs - (Date.now() - startedAt));
        if (remainingForTool <= 0) throw new DOMException("Attempt wall budget expired.", "AbortError");
        result = await executeLiveTool(page, call.name, call.input, remainingForTool);
        if (call.name === "inspect_canvas_scope" || call.name === "render_canvas_preview") {
          pixel = await captureBoundPixels(page, call.name, result);
          const pixelPath = `author-pixels/call-${String(ordinal).padStart(4, "0")}-r${pixel.roomRevision}.png`;
          artifacts.set(pixelPath, pixel.png);
          events.add("author_pixel_captured", {
            ordinal,
            name: call.name,
            roomRevision: pixel.roomRevision,
            artifactPath: pixelPath,
            sha256: sha256(pixel.png),
          });
        }
        events.add("author_tool_completed", { ordinal, name: call.name, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = message.includes("WEBMCP_TOOL_TIMEOUT:");
        result = { ok: false, tool: call.name, error: { code: timedOut ? "HOST_TOOL_TIMEOUT" : "HOST_TOOL_FAILURE", message } };
        events.add("author_tool_failed", { ordinal, name: call.name, error: result.error });
        if (timedOut) termination = "tool_timeout";
      }
      if (result?.ok === false && termination === "author_completed") {
        events.add("author_tool_returned_failure", { ordinal, name: call.name, error: result.error ?? null });
      }
      const safeResult = sanitizeForResearch(result, { secrets });
      const output = pixel
        ? [
            { type: "input_text", text: JSON.stringify(safeResult) },
            { type: "input_image", image_url: `data:image/png;base64,${pixel.png.toString("base64")}`, detail: "high" },
          ]
        : JSON.stringify(safeResult);
      conversation.push({ type: "function_call_output", call_id: call.callId, output });
      if (termination !== "author_completed") break;
      try {
        const observations = classifyAuthorToolObservation(descriptorsByName.get(call.name), result);
        const injected = await concurrentEvents.afterAuthorToolCall({ ordinal, name: call.name, observations }, startedAt);
        if (injected.length) events.add("trusted_concurrent_event_observed", {
          authorToolOrdinal: ordinal,
          authorToolName: call.name,
          observations,
          eventCount: injected.length,
        });
      } catch (error) {
        events.add("trusted_concurrent_event_failed", { afterAuthorToolCall: ordinal, message: error instanceof Error ? error.message : String(error) });
        termination = "concurrent_event_failed";
        break;
      }
    }
    if (termination !== "author_completed") break;
  }
  return {
    termination,
    finalText: redactString(finalText, secrets),
    toolCalls,
    usage: { totals: usageTotals, byTurn: usageByTurn },
    observedProvider: summarizeObservedProvider(providerByTurn),
  };
}

function inspectionInputFromState(state) {
  const data = state?.data ?? state;
  const diagram = (data?.diagrams ?? []).find((item) => Array.isArray(item.memberObjectIds) && item.memberObjectIds.length > 0);
  if (diagram && Number.isInteger(diagram.revision)) {
    return { scope: { kind: "diagram", diagramId: diagram.id, expectedRevision: diagram.revision }, representation: "overview", padding: 32 };
  }
  const targets = (data?.objects ?? []).slice(0, 1_000).map((item) => ({ objectId: item.id, expectedRevision: item.revision }));
  return targets.length ? { scope: { kind: "objects", targets }, representation: "overview", padding: 32 } : null;
}

async function writeArtifacts(outputDir, artifacts) {
  for (const [relativePath, contents] of artifacts) {
    const destination = path.join(outputDir, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
}

function jsonArtifact(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonlArtifact(values) {
  return values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : "");
}

function assertNoSecretLeak(artifacts, secrets) {
  for (const [artifactPath, contents] of artifacts) {
    if (Buffer.isBuffer(contents) || artifactPath.endsWith(".png")) continue;
    const text = String(contents);
    for (const secret of secrets) {
      if (secret.length >= 3 && (text.includes(secret) || text.includes(encodeURIComponent(secret)))) {
        throw new Error(`Secret leakage detected in ${artifactPath}.`);
      }
    }
  }
}

export async function runCleanRoomAttempt(rawConfig, options = {}) {
  const dryRun = options.dryRun === true;
  const config = validateRunnerConfig(rawConfig, dryRun);
  if (options.concurrentEventExecutor && !config.concurrentEventCallbackHash) {
    throw new Error("A trusted concurrent-event executor requires its frozen SHA-256 digest.");
  }
  if (!dryRun && config.concurrentEventCallbackHash && !options.concurrentEventExecutor) {
    throw new Error("The frozen concurrent-event plan requires its trusted executor callback.");
  }
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const outputRoot = path.resolve(repoRoot, "research/results/runs");
  const outputDir = path.join(outputRoot, config.attemptId);
  await mkdir(outputRoot, { recursive: true });
  await mkdir(outputDir);
  const startedAt = Date.now();
  const secrets = [];
  const events = eventRecorder(startedAt, secrets);
  const artifacts = new Map();
  let browser;
  let authorContext;
  let spectatorContext;
  let eventActorContext;
  let setupContext;
  let resultStatus = "runner_failed";
  let failure = null;
  let authorEvidenceRoot = null;
  let authorResult = {
    termination: dryRun ? "contract_only" : "not_started",
    finalText: "",
    toolCalls: 0,
    usage: { totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, byTurn: [] },
    observedProvider: summarizeObservedProvider([]),
  };
  let participantContract = null;
  let spectatorContract = null;
  let setupProvenance = null;
  let concurrentController = createConcurrentEventController([], async () => null);
  let authorEvents = null;
  let authorEventsSealed = false;
  let attemptStartedAt = null;
  let browserVersion = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: config.headless });
    browserVersion = browser.version();
    const author = await createCleanContext(browser, config, events, "author");
    authorContext = author.context;
    await author.page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
    await waitForTool(author.page, "create_room");
    const createResult = await executeLiveTool(author.page, "create_room", {
      displayName: config.displayName,
      title: config.roomTitle,
    }, config.perToolTimeoutMs);
    const roomId = createResult?.data?.room?.id;
    const roomCode = createResult?.data?.room?.code;
    if (createResult?.ok !== true || typeof roomId !== "string" || typeof roomCode !== "string") {
      throw new Error("create_room did not return an in-memory room ID and join code.");
    }
    assertFreshRoomCode(roomCode);
    secrets.push(roomId, roomCode);
    events.add("private_room_created", { role: "participant" });
    await waitForTool(author.page, "read_room_state");
    const participantTools = (await liveTools(author.page)).map(normalizeToolDescriptor).sort((a, b) => compareCodeUnits(a.name, b.name));
    participantContract = { hash: toolContractHash(participantTools), tools: participantTools };
    if (!dryRun && participantContract.hash !== config.participantToolContractHash) {
      throw new Error(`Live participant WebMCP contract drifted: expected ${config.participantToolContractHash}, received ${participantContract.hash}.`);
    }
    for (const name of config.allowedToolNames) {
      if (!participantTools.some((tool) => tool.name === name)) throw new Error(`Allowed tool ${name} is absent from the live room.`);
    }
    events.add("participant_contract_verified", { hash: participantContract.hash, toolCount: participantTools.length });

    const setupPlan = { operations: config.setupOperations, callbackHash: options.setupCallback ? config.setupCallbackHash : null };
    setupProvenance = { status: "started", plan: setupPlan, planHash: sha256(canonicalJson(setupPlan)) };
    let setupPage = author.page;
    const hasTrustedSetupActor = config.setupOperations.length > 0 || Boolean(options.setupCallback);
    if (hasTrustedSetupActor) {
      const setupActor = await createCleanContext(browser, config, events, "setup_actor");
      setupContext = setupActor.context;
      setupPage = setupActor.page;
      await setupPage.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
      await waitForTool(setupPage, "join_room");
      const setupJoin = await executeLiveTool(setupPage, "join_room", {
        code: roomCode,
        displayName: config.setupActorDisplayName,
        role: "participant",
      }, config.perToolTimeoutMs);
      if (setupJoin?.ok !== true || setupJoin?.data?.role !== "participant") throw new Error("Trusted setup context could not join as a participant.");
      await waitForTool(setupPage, "read_room_state");
      const setupTools = await liveTools(setupPage);
      for (const operation of config.setupOperations) {
        if (!setupTools.some((tool) => tool.name === operation.tool)) {
          throw new Error(`Trusted setup requires unavailable tool ${operation.tool}.`);
        }
      }
    }
    try {
      setupProvenance = await executePreBriefSetup({
        operations: config.setupOperations,
        execute: (name, input) => executeLiveTool(setupPage, name, input, config.perToolTimeoutMs),
        callback: options.setupCallback,
        callbackHash: config.setupCallbackHash,
        captureState: async () => sanitizeForResearch(
          await executeLiveTool(setupPage, "read_room_state", {}, config.perToolTimeoutMs),
          { secrets },
        ),
      });
    } catch (error) {
      setupProvenance.status = "failed";
      setupProvenance.error = { message: error instanceof Error ? error.message : String(error) };
      artifacts.set("setup-provenance.json", jsonArtifact(sanitizeForResearch(setupProvenance, { secrets })));
      throw error;
    }
    setupProvenance.actor = {
      kind: hasTrustedSetupActor ? "separate_trusted_participant" : "none",
      separateFromAuthor: hasTrustedSetupActor,
      closedBeforeBrief: hasTrustedSetupActor ? false : null,
    };
    await setupContext?.close();
    setupContext = null;
    if (hasTrustedSetupActor) setupProvenance.actor.closedBeforeBrief = true;
    const postSetupInitialState = sanitizeForResearch(
      await executeLiveTool(author.page, "read_room_state", {}, config.perToolTimeoutMs),
      { secrets },
    );
    setupProvenance.initialStateHash = sha256(canonicalJson(postSetupInitialState));

    if (config.concurrentEvents.length) {
      const eventActor = await createCleanContext(browser, config, events, "concurrent_event_actor");
      eventActorContext = eventActor.context;
      await eventActor.page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
      await waitForTool(eventActor.page, "join_room");
      const eventJoin = await executeLiveTool(eventActor.page, "join_room", {
        code: roomCode,
        displayName: config.eventActorDisplayName,
        role: "participant",
      }, config.perToolTimeoutMs);
      if (eventJoin?.ok !== true || eventJoin?.data?.role !== "participant") throw new Error("Concurrent-event context could not join as a participant.");
      await waitForTool(eventActor.page, "read_room_state");
      const eventTools = await liveTools(eventActor.page);
      if (!options.concurrentEventExecutor) {
        for (const event of config.concurrentEvents) {
          for (const operation of event.operations) {
            if (!eventTools.some((tool) => tool.name === operation.tool)) {
              throw new Error(`Concurrent event ${event.id} requires unavailable tool ${operation.tool}.`);
            }
          }
        }
      }
      concurrentController = createConcurrentEventController(
        config.concurrentEvents,
        (name, input) => executeLiveTool(eventActor.page, name, input, config.perToolTimeoutMs),
        Date.now,
        { eventExecutor: options.concurrentEventExecutor, executorHash: config.concurrentEventCallbackHash },
      );
      events.add("concurrent_event_actor_ready", { planHash: concurrentController.planHash, eventCount: config.concurrentEvents.length });
      const actualInitialState = sanitizeForResearch(
        await executeLiveTool(author.page, "read_room_state", {}, config.perToolTimeoutMs),
        { secrets },
      );
      setupProvenance.initialStateHash = sha256(canonicalJson(actualInitialState));
    }
    events.add("trusted_setup_completed", {
      planHash: setupProvenance.planHash,
      initialStateHash: setupProvenance.initialStateHash,
      operationCount: config.setupOperations.length,
      callback: Boolean(options.setupCallback),
      separateActor: hasTrustedSetupActor,
    });
    artifacts.set("author-brief.json", jsonArtifact(sanitizeForResearch(buildAuthorVisibleSpec(config, dryRun), { secrets })));
    artifacts.set("participant-tool-contract.json", jsonArtifact(participantContract));

    attemptStartedAt = Date.now();
    authorEvents = eventRecorder(attemptStartedAt, secrets);
    if (!dryRun) {
      authorEvents.add("brief_delivered", { briefHash: sha256(config.brief) });
      authorResult = await runAuthor({
        config,
        page: author.page,
        tools: participantTools,
        events: authorEvents,
        secrets,
        artifacts,
        startedAt: attemptStartedAt,
        concurrentEvents: concurrentController,
      });
    }
    let authorFinalState;
    if (authorResult.termination === "tool_timeout") {
      authorFinalState = { ok: false, error: { code: "FINAL_STATE_CAPTURE_SKIPPED_AFTER_TIMEOUT", message: "The author context must close before any further coordinator calls." } };
    } else {
      try {
        authorFinalState = await executeLiveTool(author.page, "read_room_state", {}, config.perToolTimeoutMs);
      } catch (error) {
        authorFinalState = { ok: false, error: { code: "FINAL_STATE_CAPTURE_FAILED", message: error instanceof Error ? error.message : String(error) } };
        events.add("author_final_state_failed", authorFinalState);
      }
    }
    artifacts.set("author-final.json", jsonArtifact(sanitizeForResearch(authorResult, { secrets })));
    artifacts.set("author-final-state.json", jsonArtifact(sanitizeForResearch(authorFinalState, { secrets })));
    artifacts.set("author-events.jsonl", jsonlArtifact(authorEvents.events));
    authorEventsSealed = true;
    artifacts.set("setup-provenance.json", jsonArtifact(sanitizeForResearch(setupProvenance, { secrets })));
    artifacts.set("concurrent-event-provenance.json", jsonArtifact(sanitizeForResearch({
      planHash: concurrentController.planHash,
      receipts: concurrentController.receipts,
      unresolved: concurrentController.unresolved(),
    }, { secrets })));
    const authorArtifacts = Object.fromEntries([...artifacts].filter(([name]) => name.startsWith("author-") || name.startsWith("author-pixels/")));
    authorEvidenceRoot = hashArtifactSet(authorArtifacts);
    artifacts.set("author-evidence-seal.json", jsonArtifact(authorEvidenceRoot));
    assertNoSecretLeak(artifacts, secrets);
    await writeArtifacts(outputDir, artifacts);
    events.add("author_evidence_sealed", { root: authorEvidenceRoot.root, artifactCount: authorEvidenceRoot.leaves.length });
    await authorContext.close();
    authorContext = null;
    await eventActorContext?.close();
    eventActorContext = null;

    const spectator = await createCleanContext(browser, config, events, "spectator");
    spectatorContext = spectator.context;
    await spectator.page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
    await waitForTool(spectator.page, "join_room");
    const joinResult = await executeLiveTool(spectator.page, "join_room", {
      code: roomCode,
      displayName: config.spectatorDisplayName,
      role: "spectator",
    }, config.perToolTimeoutMs);
    if (joinResult?.ok !== true || joinResult?.data?.role !== "spectator") throw new Error("Fresh evaluator context could not join as spectator.");
    await waitForTool(spectator.page, "read_room_state");
    const spectatorTools = assertSpectatorToolIsolation(await liveTools(spectator.page)).sort((a, b) => compareCodeUnits(a.name, b.name));
    spectatorContract = { hash: toolContractHash(spectatorTools), tools: spectatorTools };
    if (!dryRun && spectatorContract.hash !== config.spectatorToolContractHash) {
      throw new Error(`Live spectator WebMCP contract drifted: expected ${config.spectatorToolContractHash}, received ${spectatorContract.hash}.`);
    }
    const spectatorState = await executeLiveTool(spectator.page, "read_room_state", {}, config.perToolTimeoutMs);
    let spectatorInspection = null;
    const inspectInput = inspectionInputFromState(spectatorState);
    if (inspectInput && spectatorTools.some((tool) => tool.name === "inspect_canvas_scope")) {
      const inspectionResult = await executeLiveTool(spectator.page, "inspect_canvas_scope", inspectInput, config.perToolTimeoutMs);
      try {
        const pixels = await captureBoundPixels(spectator.page, "inspect_canvas_scope", inspectionResult);
        artifacts.set(`spectator-final-r${pixels.roomRevision}.png`, pixels.png);
        spectatorInspection = { result: inspectionResult, pixel: { roomRevision: pixels.roomRevision, sha256: sha256(pixels.png) } };
      } catch (error) {
        spectatorInspection = { result: inspectionResult, pixelError: error instanceof Error ? error.message : String(error) };
      }
    }
    artifacts.set("spectator-tool-contract.json", jsonArtifact(spectatorContract));
    artifacts.set("spectator-final-state.json", jsonArtifact(sanitizeForResearch(spectatorState, { secrets })));
    artifacts.set("spectator-inspection.json", jsonArtifact(sanitizeForResearch(spectatorInspection ?? {
      status: "not_available",
      reason: inspectInput ? "inspect_canvas_scope_not_registered" : "room_has_no_inspectable_objects",
    }, { secrets })));
    resultStatus = dryRun ? "contract_verified" : authorResult.termination;
  } catch (error) {
    failure = sanitizeForResearch({ message: error instanceof Error ? error.message : String(error) }, { secrets });
    events.add("runner_failed", failure);
    if (setupProvenance && !artifacts.has("setup-provenance.json")) {
      artifacts.set("setup-provenance.json", jsonArtifact(sanitizeForResearch(setupProvenance, { secrets })));
    }
    if (authorEvents && !authorEventsSealed) {
      authorEvents.add("author_attempt_interrupted", failure);
      const completedTurns = authorEvents.events.filter((event) => event.type === "responses_request_completed");
      const retainedUsage = {
        totals: completedTurns.at(-1)?.data?.cumulativeUsage ?? authorResult.usage.totals,
        byTurn: completedTurns.map((event) => ({ turn: event.data.turn, ...event.data.usage })),
      };
      authorResult = {
        termination: "runner_failed",
        finalText: "",
        toolCalls: authorEvents.events.filter((event) => event.type === "author_tool_started").length,
        usage: retainedUsage,
        observedProvider: summarizeObservedProvider(completedTurns.map((event) => event.data.provider)),
      };
      artifacts.set("author-final.json", jsonArtifact(sanitizeForResearch(authorResult, { secrets })));
      artifacts.set("author-events.jsonl", jsonlArtifact(authorEvents.events));
      const authorArtifacts = Object.fromEntries([...artifacts].filter(([name]) => name.startsWith("author-") || name.startsWith("author-pixels/")));
      authorEvidenceRoot = hashArtifactSet(authorArtifacts);
      artifacts.set("author-evidence-seal.json", jsonArtifact(authorEvidenceRoot));
      authorEventsSealed = true;
      assertNoSecretLeak(artifacts, secrets);
      await writeArtifacts(outputDir, artifacts);
    }
  } finally {
    await spectatorContext?.close().catch(() => {});
    await eventActorContext?.close().catch(() => {});
    await setupContext?.close().catch(() => {});
    await authorContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (!authorEventsSealed) artifacts.set("author-events.jsonl", jsonlArtifact(authorEvents?.events ?? []));
    artifacts.set("coordinator-events.jsonl", jsonlArtifact(events.events));
    const allBeforeBundle = Object.fromEntries(artifacts);
    const artifactIndex = hashArtifactSet(allBeforeBundle);
    const bundle = sanitizeForResearch({
      schemaVersion: "clean-room-live-attempt/v1",
      attemptId: config.attemptId,
      mode: dryRun ? "contract" : "live",
      status: resultStatus,
      failure,
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      attemptStartedAt: attemptStartedAt ? new Date(attemptStartedAt).toISOString() : null,
      participantContract: participantContract ? { hash: participantContract.hash, toolCount: participantContract.tools.length } : null,
      spectatorContract: spectatorContract ? { hash: spectatorContract.hash, toolCount: spectatorContract.tools.length } : null,
      author: authorResult,
      authorEvidenceRoot,
      setup: setupProvenance ? { planHash: setupProvenance.planHash, initialStateHash: setupProvenance.initialStateHash } : null,
      concurrentEvents: {
        planHash: concurrentController.planHash,
        fired: concurrentController.receipts.length,
        unresolved: concurrentController.unresolved(),
      },
      artifactIndex,
      isolation: {
        authorContextClosedBeforeEvaluation: authorContext === null,
        evaluatorRole: "spectator",
        apiTransport: dryRun ? "disabled" : "raw_fetch",
        parallelToolCalls: false,
        persistence: "store_false_stateless_replay",
      },
      environment: {
        node: process.version,
        browser: { engine: "chromium", version: browserVersion },
        viewport: DEFAULT_VIEWPORT,
        baseUrl: config.baseUrl,
      },
    }, { secrets });
    artifacts.set("attempt-bundle.json", jsonArtifact(bundle));
    assertNoSecretLeak(artifacts, secrets);
    await writeArtifacts(outputDir, artifacts);
  }
  if (failure) throw new Error(`${failure.message} Attempt evidence: ${outputDir}`);
  return {
    outputDir,
    status: resultStatus,
    participantContractHash: participantContract.hash,
    spectatorContractHash: spectatorContract.hash,
  };
}

function parseCli(argv) {
  let configPath;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config") configPath = argv[++index];
    else if (argv[index] === "--dry-run" || argv[index] === "--contract") dryRun = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!configPath) throw new Error("Usage: clean-room-live-runner.mjs --config <config.json> [--dry-run|--contract]");
  return { configPath, dryRun };
}

async function main() {
  const { configPath, dryRun } = parseCli(process.argv.slice(2));
  const rawConfig = JSON.parse(await readFile(path.resolve(configPath), "utf8"));
  const result = await runCleanRoomAttempt(rawConfig, { dryRun });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
