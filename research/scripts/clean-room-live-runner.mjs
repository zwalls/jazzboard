#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CODEX_NATIVE_TRANSPORT_REQUIRED =
  "CODEX_NATIVE_TRANSPORT_REQUIRED: direct provider execution is disabled; run the ChatGPT-authenticated Codex task preflight and disposable WebMCP spike.";
// JSON UTF-8 bytes are a conservative upper bound for content tokens because
// no token can encode fewer than one source byte. This fixed allowance covers
// provider-side message/tool framing that is not present in the serialized
// request. A request is never released if that bound could cross the frozen
// cumulative input-token budget.
export const RESPONSES_INPUT_FRAMING_MARGIN_TOKENS = 16_384;
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const PRIVATE_KEY_PATTERN = /^(?:room(?:id|code)|room_id|room_code|session(?:id|key|token)?|session_id|participantid|participant_id|selfparticipantid|previewid|recentroom|recentrooms|cookie|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)$/i;
const SAFE_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/;
const AUTHOR_IDENTITY_ARTIFACT_PATH = "author-identity-commitment.json";
const AUTHOR_IDENTITY_ARTIFACT_VERSION = "author-identity-commitment/v1";
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function normalizedMediaType(value) {
  if (typeof value !== "string") return null;
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return mediaType || null;
}

function pngDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }
  let offset = PNG_SIGNATURE.byteLength;
  let width = 0;
  let height = 0;
  let ordinal = 0;
  let sawImageData = false;
  let sawEnd = false;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) return null;
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const next = offset + length + 12;
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

/**
 * Builds a secret-free receipt before enforcing the semantic export contract.
 * Keeping construction and assertion separate ensures an HTML/404 response is
 * still hash-addressed in the terminal attempt evidence.
 */
export function buildSemanticExportEvidenceReceipt(input) {
  const body = Buffer.isBuffer(input.bodyBytes)
    ? input.bodyBytes
    : Buffer.from(input.bodyBytes ?? "");
  const result = input.toolResult;
  return Object.freeze({
    schemaVersion: "jazzboard-semantic-export-evidence/v1",
    expectedRoomRevision: input.expectedRoomRevision,
    response: Object.freeze({
      status: input.status,
      contentType: typeof input.contentType === "string" ? input.contentType : null,
      mediaType: normalizedMediaType(input.contentType),
      byteLength: body.byteLength,
      bodySha256: sha256(body),
    }),
    tool: Object.freeze({
      status: result?.ok === true ? "succeeded" : "failed",
      failureCode: result?.ok === false && typeof result?.error?.code === "string"
        ? result.error.code
        : null,
      format: typeof result?.data?.format === "string" ? result.data.format : null,
      declaredMediaType: typeof result?.data?.mediaType === "string" ? result.data.mediaType : null,
      sourceRoomRevision: Number.isSafeInteger(result?.data?.sourceRoomRevision)
        ? result.data.sourceRoomRevision
        : null,
      artifactSourceRoomRevision: Number.isSafeInteger(result?.data?.artifact?.source?.roomRevision)
        ? result.data.artifact.source.roomRevision
        : null,
    }),
  });
}

export function assertSemanticExportEvidence(receipt) {
  if (!Number.isSafeInteger(receipt?.expectedRoomRevision) || receipt.expectedRoomRevision < 1) {
    throw new Error("SEMANTIC_EXPORT_EXPECTED_REVISION_INVALID");
  }
  if (receipt?.response?.status !== 200) {
    throw new Error(`SEMANTIC_EXPORT_HTTP_STATUS_INVALID:${receipt?.response?.status ?? "missing"}`);
  }
  if (receipt.response.mediaType !== "application/json"
      && !receipt.response.mediaType?.endsWith("+json")) {
    throw new Error(`SEMANTIC_EXPORT_CONTENT_TYPE_INVALID:${receipt.response.mediaType ?? "missing"}`);
  }
  if (!Number.isSafeInteger(receipt.response.byteLength) || receipt.response.byteLength < 1
      || !/^[a-f0-9]{64}$/.test(receipt.response.bodySha256 ?? "")) {
    throw new Error("SEMANTIC_EXPORT_RESPONSE_BODY_INVALID");
  }
  if (receipt.tool.status !== "succeeded" || receipt.tool.format !== "semantic_json") {
    throw new Error(`SEMANTIC_EXPORT_TOOL_FAILED:${receipt.tool.failureCode ?? "invalid_result"}`);
  }
  if (normalizedMediaType(receipt.tool.declaredMediaType) !== "application/vnd.jazzboard.semantic+json") {
    throw new Error("SEMANTIC_EXPORT_DECLARED_MEDIA_TYPE_INVALID");
  }
  if (receipt.tool.sourceRoomRevision !== receipt.expectedRoomRevision
      || receipt.tool.artifactSourceRoomRevision !== receipt.expectedRoomRevision) {
    throw new Error("SEMANTIC_EXPORT_REVISION_BINDING_INVALID");
  }
  return receipt;
}

/** Builds a PNG receipt from selected tool metadata and the exact downloaded bytes. */
export function buildPngExportEvidenceReceipt(input) {
  const bytes = Buffer.isBuffer(input.downloadBytes) ? input.downloadBytes : null;
  const dimensions = bytes ? pngDimensions(bytes) : null;
  const result = input.toolResult;
  return Object.freeze({
    schemaVersion: "jazzboard-png-export-evidence/v1",
    expectedRoomRevision: input.expectedRoomRevision,
    tool: Object.freeze({
      status: result?.ok === true ? "succeeded" : "failed",
      failureCode: result?.ok === false && typeof result?.error?.code === "string"
        ? result.error.code
        : null,
      filename: typeof result?.data?.filename === "string" ? result.data.filename : null,
      declaredMimeType: typeof result?.data?.mimeType === "string" ? result.data.mimeType : null,
      width: Number.isSafeInteger(result?.data?.width) ? result.data.width : null,
      height: Number.isSafeInteger(result?.data?.height) ? result.data.height : null,
      declaredByteLength: Number.isSafeInteger(result?.data?.byteLength) ? result.data.byteLength : null,
      sourceRoomRevision: Number.isSafeInteger(result?.data?.sourceRevisions?.roomRevision)
        ? result.data.sourceRevisions.roomRevision
        : null,
      persistedByJazzboard: result?.data?.persistedByJazzboard === false ? false : null,
    }),
    download: Object.freeze({
      status: bytes ? "captured" : "failed",
      failure: typeof input.downloadFailure === "string" ? input.downloadFailure.slice(0, 240) : null,
      filename: typeof input.downloadFilename === "string" ? input.downloadFilename : null,
      observedMimeType: dimensions ? "image/png" : null,
      byteLength: bytes?.byteLength ?? null,
      sha256: bytes ? sha256(bytes) : null,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    }),
  });
}

export function assertPngExportEvidence(receipt) {
  if (!Number.isSafeInteger(receipt?.expectedRoomRevision) || receipt.expectedRoomRevision < 1) {
    throw new Error("PNG_EXPORT_EXPECTED_REVISION_INVALID");
  }
  if (receipt?.tool?.status !== "succeeded") {
    throw new Error(`PNG_EXPORT_TOOL_FAILED:${receipt?.tool?.failureCode ?? "invalid_result"}`);
  }
  if (receipt.download.status !== "captured" || receipt.download.observedMimeType !== "image/png") {
    throw new Error(`PNG_EXPORT_DOWNLOAD_INVALID:${receipt.download.failure ?? "missing_png"}`);
  }
  if (normalizedMediaType(receipt.tool.declaredMimeType) !== "image/png") {
    throw new Error("PNG_EXPORT_DECLARED_MEDIA_TYPE_INVALID");
  }
  if (receipt.tool.sourceRoomRevision !== receipt.expectedRoomRevision) {
    throw new Error("PNG_EXPORT_REVISION_BINDING_INVALID");
  }
  if (receipt.tool.persistedByJazzboard !== false) {
    throw new Error("PNG_EXPORT_PERSISTENCE_METADATA_INVALID");
  }
  if (!receipt.tool.filename?.toLowerCase().endsWith(".png")
      || receipt.tool.filename !== receipt.download.filename) {
    throw new Error("PNG_EXPORT_FILENAME_INVALID");
  }
  if (receipt.tool.declaredByteLength !== receipt.download.byteLength
      || receipt.tool.width !== receipt.download.width
      || receipt.tool.height !== receipt.download.height
      || !/^[a-f0-9]{64}$/.test(receipt.download.sha256 ?? "")) {
    throw new Error("PNG_EXPORT_BYTE_METADATA_INVALID");
  }
  return receipt;
}

export function createAuthorIdentityEvidence(attemptId, identityCommitment) {
  if (typeof attemptId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(attemptId)) {
    throw new Error("Author identity evidence requires a safe attempt ID.");
  }
  if (typeof identityCommitment !== "string" || !/^sha256:[a-f0-9]{64}$/.test(identityCommitment)) {
    throw new Error("Author identity evidence requires a trusted registry SHA-256 commitment.");
  }
  const record = {
    attemptId,
    identityCommitment,
    schemaVersion: AUTHOR_IDENTITY_ARTIFACT_VERSION,
  };
  const bytes = Buffer.from(canonicalJson(record), "utf8");
  return Object.freeze({
    path: AUTHOR_IDENTITY_ARTIFACT_PATH,
    record: Object.freeze(record),
    bytes,
    artifactSha256: `sha256:${sha256(bytes)}`,
  });
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

export function emptyResponseUsageTotals() {
  return {
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function tokenCount(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Responses API returned invalid token usage for ${field}.`);
  }
  return value;
}

function optionalTokenDetails(value, field) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Responses API returned invalid token usage for ${field}.`);
  }
  return value;
}

export function responseUsageCostInputs(totals) {
  return Object.freeze({
    uncachedInputTokens: totals.uncachedInputTokens ?? totals.inputTokens ?? 0,
    cachedInputTokens: totals.cachedInputTokens ?? 0,
    cacheWriteInputTokens: totals.cacheWriteInputTokens ?? 0,
    outputTokens: totals.outputTokens ?? 0,
  });
}

export function accumulateResponseUsage(current, usage, budgets) {
  const inputDetails = optionalTokenDetails(usage?.input_tokens_details, "input_tokens_details");
  const outputDetails = optionalTokenDetails(usage?.output_tokens_details, "output_tokens_details");
  const inputTokens = tokenCount(usage?.input_tokens ?? 0, "input_tokens");
  const cachedInputTokens = tokenCount(inputDetails.cached_tokens ?? 0, "input_tokens_details.cached_tokens");
  const cacheWriteInputTokens = tokenCount(inputDetails.cache_write_tokens ?? 0, "input_tokens_details.cache_write_tokens");
  const outputTokens = tokenCount(usage?.output_tokens ?? 0, "output_tokens");
  const reasoningOutputTokens = tokenCount(outputDetails.reasoning_tokens ?? 0, "output_tokens_details.reasoning_tokens");
  if (usage?.total_tokens !== undefined
      && tokenCount(usage.total_tokens, "total_tokens") !== inputTokens + outputTokens) {
    throw new Error("Responses API total token usage does not equal input_tokens plus output_tokens.");
  }
  if (cachedInputTokens + cacheWriteInputTokens > inputTokens) {
    throw new Error("Responses API token usage details exceed input_tokens.");
  }
  if (reasoningOutputTokens > outputTokens) {
    throw new Error("Responses API reasoning token usage exceeds output_tokens.");
  }
  const uncachedInputTokens = inputTokens - cachedInputTokens - cacheWriteInputTokens;
  const totals = {
    inputTokens: current.inputTokens + inputTokens,
    uncachedInputTokens: (current.uncachedInputTokens ?? current.inputTokens) + uncachedInputTokens,
    cachedInputTokens: (current.cachedInputTokens ?? 0) + cachedInputTokens,
    cacheWriteInputTokens: (current.cacheWriteInputTokens ?? 0) + cacheWriteInputTokens,
    outputTokens: current.outputTokens + outputTokens,
    reasoningOutputTokens: (current.reasoningOutputTokens ?? 0) + reasoningOutputTokens,
    totalTokens: current.totalTokens + inputTokens + outputTokens,
  };
  return {
    totals,
    turn: {
      inputTokens,
      uncachedInputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens: inputTokens + outputTokens,
    },
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
    sessionAlias: config.sessionAlias,
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
  const rawExpiresAt = result.data.expiresAt;
  const isoMatch = typeof rawExpiresAt === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(rawExpiresAt)
    : null;
  if (isoMatch) {
    const [, year, month, day, hour, minute, second] = isoMatch.map(Number);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
        || hour > 23 || minute > 59 || second > 59) {
      throw new Error(`${toolName} returned an invalid pixel lease expiry.`);
    }
  }
  const expiresAtMs = typeof rawExpiresAt === "number"
    ? rawExpiresAt
    : isoMatch
      ? Date.parse(rawExpiresAt)
      : Number.NaN;
  if (!Number.isSafeInteger(expiresAtMs)) throw new Error(`${toolName} returned an invalid pixel lease expiry.`);
  let expiresAt;
  try {
    expiresAt = new Date(expiresAtMs).toISOString();
  } catch {
    throw new Error(`${toolName} returned an invalid pixel lease expiry.`);
  }
  if (expiresAtMs <= now) throw new Error(`${toolName} pixel lease has expired.`);
  const roomRevision = toolName === "inspect_canvas_scope"
    ? result.data.sceneContext?.revisions?.roomRevision
    : result.data.sourceRevisions?.roomRevision;
  if (!Number.isInteger(roomRevision) || roomRevision < 0) {
    throw new Error(`${toolName} did not bind its pixels to a room revision.`);
  }
  return { clip, selector, expiresAt, roomRevision };
}

export function validateRunnerConfig(raw, dryRun = false) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Runner config must be a JSON object.");
  const attemptId = String(raw.attemptId ?? "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(attemptId)) {
    throw new Error("attemptId must be a safe 1-80 character artifact identifier.");
  }
  const sessionAlias = String(raw.sessionAlias ?? "");
  if (!/^session-[a-f0-9]{12}$/.test(sessionAlias)) {
    throw new Error("sessionAlias must be a trusted opaque session identifier.");
  }
  const authorIdentityCommitment = raw.authorIdentityCommitment ?? null;
  if (!dryRun && (typeof authorIdentityCommitment !== "string" || !/^sha256:[a-f0-9]{64}$/.test(authorIdentityCommitment))) {
    throw new Error("A live run requires the trusted author identity-registry commitment frozen into its runner config.");
  }
  if (authorIdentityCommitment !== null
      && (typeof authorIdentityCommitment !== "string" || !/^sha256:[a-f0-9]{64}$/.test(authorIdentityCommitment))) {
    throw new Error("authorIdentityCommitment must be a SHA-256 identity-registry commitment.");
  }
  const baseUrl = new URL(String(raw.baseUrl ?? ""));
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== "/") {
    throw new Error("baseUrl must be an HTTP(S) deployment origin without credentials, path, query, or fragment.");
  }
  const expectedRuntime = raw.expectedRuntime;
  if (!expectedRuntime || typeof expectedRuntime !== "object" || Array.isArray(expectedRuntime)
      || expectedRuntime.nodeVersion !== "22.22.0"
      || expectedRuntime.browserVersion !== "151.0.7922.34") {
    throw new Error("expectedRuntime must bind the frozen Node and browser versions.");
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
  if (raw.serviceTier !== "default") throw new Error("Responses serviceTier must be explicitly frozen to default pricing.");
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
    sessionAlias,
    authorIdentityCommitment,
    baseUrl: baseUrl.href,
    expectedRuntime: structuredClone(expectedRuntime),
    brief,
    model,
    serviceTier: "default",
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
    roomTitle: String(raw.roomTitle ?? `Jazzboard ${sessionAlias.slice("session-".length).toUpperCase()}`).slice(0, 100),
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

function isSemanticArtifactResponse(response) {
  try {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && /^\/api\/rooms\/[^/]+\/agent\/artifacts$/.test(url.pathname)
      && url.searchParams.get("format") === "semantic_json"
      && url.searchParams.get("scope") === "room";
  } catch {
    return false;
  }
}

async function captureSemanticExportEvidence(page, expectedRoomRevision, timeoutMs) {
  const responsePromise = page.waitForResponse(isSemanticArtifactResponse, { timeout: timeoutMs });
  const [toolResult, response] = await Promise.all([
    executeLiveTool(page, "export_canvas_artifact", {
      format: "semantic_json",
      scope: { kind: "room" },
    }, timeoutMs),
    responsePromise,
  ]);
  const bodyBytes = Buffer.from(await response.body());
  const receipt = buildSemanticExportEvidenceReceipt({
    expectedRoomRevision,
    status: response.status(),
    contentType: response.headers()["content-type"] ?? null,
    bodyBytes,
    toolResult,
  });
  return { receipt, toolResult };
}

async function readPlaywrightDownload(download) {
  const failure = await download.failure();
  if (failure) throw new Error(failure);
  const stream = await download.createReadStream();
  if (!stream) throw new Error("The browser did not expose the downloaded PNG bytes.");
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function capturePngExportEvidence(page, expectedRoomRevision, timeoutMs) {
  let resolveDownload;
  let rejectDownload;
  let timeout;
  const downloadPromise = new Promise((resolve, reject) => {
    resolveDownload = resolve;
    rejectDownload = reject;
  });
  // The tool call and download wait share the same deadline. Attach a handler
  // immediately so a download timeout cannot become an unhandled rejection
  // while the page-side tool is still resolving.
  void downloadPromise.catch(() => {});
  const onDownload = (download) => {
    clearTimeout(timeout);
    resolveDownload(download);
  };
  page.once("download", onDownload);
  timeout = setTimeout(() => {
    page.off("download", onDownload);
    rejectDownload(new Error("The exact-revision PNG download did not begin before the evidence deadline."));
  }, timeoutMs);

  let toolResult;
  try {
    toolResult = await executeLiveTool(page, "export_canvas_png", {
      scope: { kind: "room", expectedRevision: expectedRoomRevision },
    }, timeoutMs);
  } catch (error) {
    clearTimeout(timeout);
    page.off("download", onDownload);
    throw error;
  }

  if (toolResult?.ok !== true) {
    clearTimeout(timeout);
    page.off("download", onDownload);
    return {
      bytes: null,
      receipt: buildPngExportEvidenceReceipt({
        expectedRoomRevision,
        toolResult,
        downloadFailure: "The WebMCP export tool failed before starting a download.",
      }),
    };
  }

  let download;
  let downloadBytes = null;
  let downloadFailure = null;
  try {
    download = await downloadPromise;
    downloadBytes = await readPlaywrightDownload(download);
  } catch (error) {
    downloadFailure = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
    page.off("download", onDownload);
  }
  return {
    bytes: downloadBytes,
    receipt: buildPngExportEvidenceReceipt({
      expectedRoomRevision,
      toolResult,
      downloadFilename: download?.suggestedFilename(),
      downloadBytes,
      downloadFailure,
    }),
  };
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

async function responsesRequest() {
  throw new Error(CODEX_NATIVE_TRANSPORT_REQUIRED);
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

export function responsesRequestCompletedData(turn, usage, cumulativeUsage, response, requestContextBytes) {
  if (!Number.isSafeInteger(requestContextBytes) || requestContextBytes < 0) {
    throw new Error("Completed Responses request requires its exact serialized request byte length.");
  }
  return Object.freeze({
    turn,
    usage,
    cumulativeUsage,
    status: response?.status ?? null,
    provider: responseProviderObservation(response),
    requestContextBytes,
  });
}

export function responsesRequestInputExposure(serializedRequest, framingMarginTokens = RESPONSES_INPUT_FRAMING_MARGIN_TOKENS) {
  if (typeof serializedRequest !== "string") throw new Error("Responses request must be serialized exactly once before release.");
  if (!Number.isSafeInteger(framingMarginTokens) || framingMarginTokens < 0) throw new Error("Responses framing margin must be a non-negative integer.");
  const requestContextBytes = Buffer.byteLength(serializedRequest, "utf8");
  return Object.freeze({
    requestContextBytes,
    maximumInputTokens: requestContextBytes + framingMarginTokens,
    framingMarginTokens,
  });
}

export function assertFrozenRuntimeEnvironment(expected, observed) {
  if (!expected || !observed || expected.nodeVersion !== observed.nodeVersion) {
    throw new Error(`RUNTIME_NODE_VERSION_DRIFT: expected ${expected?.nodeVersion ?? "missing"}, received ${observed?.nodeVersion ?? "missing"}.`);
  }
  if (expected.browserVersion !== observed.browserVersion) {
    throw new Error(`RUNTIME_BROWSER_VERSION_DRIFT: expected ${expected.browserVersion}, received ${observed.browserVersion ?? "missing"}.`);
  }
  return Object.freeze({ nodeVersion: observed.nodeVersion, browserVersion: observed.browserVersion });
}

/** Rebuilds durable usage from completed response events after an interrupted run. */
export function recoverCompletedResponseUsage(events, fallbackTotals = emptyResponseUsageTotals()) {
  const completedTurns = events.filter((event) => event?.type === "responses_request_completed");
  const totals = structuredClone(completedTurns.at(-1)?.data?.cumulativeUsage ?? fallbackTotals);
  return {
    totals,
    byTurn: completedTurns.map((event) => ({ turn: event.data.turn, ...structuredClone(event.data.usage) })),
    costInputs: responseUsageCostInputs(totals),
  };
}

export async function notifyBriefDelivered(callback, deliveredAtMs) {
  if (!Number.isSafeInteger(deliveredAtMs) || deliveredAtMs < 0) {
    throw new Error("Brief-delivery time must be a safe epoch-millisecond value.");
  }
  const deliveredAt = new Date(deliveredAtMs).toISOString();
  if (callback !== undefined) {
    if (typeof callback !== "function") throw new Error("onBriefDelivered must be a function when supplied.");
    const effectiveAt = await callback(deliveredAt);
    if (effectiveAt !== undefined) {
      if (typeof effectiveAt !== "string" || !Number.isFinite(Date.parse(effectiveAt))
          || Date.parse(effectiveAt) < deliveredAtMs) {
        throw new Error("onBriefDelivered returned an invalid or pre-gate effective timestamp.");
      }
      return new Date(Date.parse(effectiveAt)).toISOString();
    }
  }
  return deliveredAt;
}

export async function runAuthor({ config, page, tools, events, secrets, artifacts, startedAt, concurrentEvents }) {
  if (CODEX_NATIVE_TRANSPORT_REQUIRED.length > 0) {
    events.add("legacy_author_transport_blocked", {
      reasonCode: "CODEX_NATIVE_TRANSPORT_REQUIRED",
      providerCallMayHaveOccurred: false,
    });
    const totals = emptyResponseUsageTotals();
    return {
      termination: "codex_native_transport_required",
      finalText: "",
      toolCalls: 0,
      usage: { totals, byTurn: [], costInputs: responseUsageCostInputs(totals) },
      observedProvider: summarizeObservedProvider([]),
    };
  }
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
  let usageTotals = emptyResponseUsageTotals();
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
    const requestBody = {
      model: config.model,
      service_tier: config.serviceTier,
      instructions,
      input: conversation,
      tools: responseTools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: config.reasoningEffort },
      max_output_tokens: Math.min(config.perResponseMaxOutputTokens, remainingOutputTokens),
    };
    const serializedRequest = JSON.stringify(requestBody);
    const requestExposure = responsesRequestInputExposure(serializedRequest);
    if (usageTotals.inputTokens + requestExposure.maximumInputTokens > config.inputTokenBudget) {
      termination = "input_token_budget_preflight_exceeded";
      events.add("responses_request_preflight_rejected", {
        turn,
        requestContextBytes: requestExposure.requestContextBytes,
        framingMarginTokens: requestExposure.framingMarginTokens,
        maximumInputTokens: requestExposure.maximumInputTokens,
        cumulativeInputTokens: usageTotals.inputTokens,
        inputTokenBudget: config.inputTokenBudget,
        termination,
      });
      break;
    }
    events.add("responses_request_started", {
      turn,
      remainingOutputTokens,
      requestContextBytes: requestExposure.requestContextBytes,
      maximumInputTokens: requestExposure.maximumInputTokens,
    });
    let response;
    try {
      response = await responsesRequest();
    } catch (error) {
      events.add("responses_request_failed", {
        turn,
        message: error instanceof Error ? error.message : String(error),
        providerCallMayHaveOccurred: true,
        costObservability: "unobservable",
      });
      termination = error instanceof DOMException && error.name === "AbortError" ? "wall_budget_exceeded" : "responses_api_failed";
      break;
    }
    const usage = accumulateResponseUsage(usageTotals, response.usage, config);
    usageTotals = usage.totals;
    usageByTurn.push({ turn, ...usage.turn });
    const completed = responsesRequestCompletedData(
      turn,
      usage.turn,
      usageTotals,
      response,
      requestExposure.requestContextBytes,
    );
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
    if (response.status !== "completed") {
      termination = response.status === "incomplete" ? "responses_incomplete" : "responses_provider_failed";
      events.add("responses_noncompleted", {
        status: response.status ?? null,
        error: response.error ?? null,
        incompleteDetails: response.incomplete_details ?? null,
        termination,
      });
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
    usage: { totals: usageTotals, byTurn: usageByTurn, costInputs: responseUsageCostInputs(usageTotals) },
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

async function syncPlainDirectory(directory, label) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a plain directory.`);
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableArtifactWrite(outputDir, relativePath, contents, exclusive = false) {
  if (typeof relativePath !== "string" || relativePath.startsWith("/") || relativePath.includes("\\")
      || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe retained artifact path: ${relativePath}`);
  }
  const destination = path.join(outputDir, relativePath);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent || (parent !== outputDir && !isStrictDescendant(outputDir, parent))) {
    throw new Error(`Retained artifact parent escaped the attempt directory: ${relativePath}`);
  }
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW
    | (exclusive ? fsConstants.O_EXCL : fsConstants.O_TRUNC);
  const handle = await open(destination, flags, 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const retained = await readFile(destination);
  const expected = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents));
  if (!retained.equals(expected)) throw new Error(`Durable artifact readback differs: ${relativePath}`);
  await syncPlainDirectory(parent, `Retained artifact parent for ${relativePath}`);
}

async function writeArtifacts(outputDir, artifacts) {
  for (const [relativePath, contents] of artifacts) {
    if (relativePath === "attempt-bundle.json") {
      throw new Error("The terminal attempt bundle must be retained only by the exclusive commit path.");
    }
    await durableArtifactWrite(outputDir, relativePath, contents, false);
  }
}

async function retainedArtifactInventory(root, current = "") {
  const directory = current ? path.join(root, current) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const inventory = new Map();
  for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Retained attempt contains a symbolic link: ${relative}`);
    if (stat.isDirectory()) {
      for (const [childPath, childBytes] of await retainedArtifactInventory(root, relative)) {
        inventory.set(childPath, childBytes);
      }
    } else if (stat.isFile()) {
      inventory.set(relative, await readFile(absolute));
    } else {
      throw new Error(`Retained attempt contains a non-file artifact: ${relative}`);
    }
  }
  return inventory;
}

export async function commitCleanRoomAttemptEvidence(outputDir, stagedArtifacts, bundle) {
  if (!(stagedArtifacts instanceof Map) || stagedArtifacts.has("attempt-bundle.json")) {
    throw new Error("Attempt commit requires staged non-bundle artifacts in a Map.");
  }
  const expectedIndex = hashArtifactSet(Object.fromEntries(stagedArtifacts));
  if (canonicalJson(bundle?.artifactIndex) !== canonicalJson(expectedIndex)) {
    throw new Error("Attempt bundle artifact index does not match the exact staged bytes.");
  }
  const bundleBytes = jsonArtifact(bundle);
  await writeArtifacts(outputDir, stagedArtifacts);
  await durableArtifactWrite(outputDir, "attempt-bundle.json", bundleBytes, true);
  await syncPlainDirectory(outputDir, "Committed attempt directory");

  return verifyCommittedCleanRoomAttemptEvidence(outputDir, stagedArtifacts, bundle);
}

export async function verifyCommittedCleanRoomAttemptEvidence(outputDir, stagedArtifacts, bundle) {
  if (!(stagedArtifacts instanceof Map) || stagedArtifacts.has("attempt-bundle.json")) {
    throw new Error("Attempt verification requires staged non-bundle artifacts in a Map.");
  }
  const expectedIndex = hashArtifactSet(Object.fromEntries(stagedArtifacts));
  if (canonicalJson(bundle?.artifactIndex) !== canonicalJson(expectedIndex)) {
    throw new Error("Attempt bundle artifact index does not match the exact staged bytes.");
  }
  const bundleBytes = jsonArtifact(bundle);
  const retained = await retainedArtifactInventory(outputDir);
  const expectedPaths = [...stagedArtifacts.keys(), "attempt-bundle.json"].sort(compareCodeUnits);
  const actualPaths = [...retained.keys()].sort(compareCodeUnits);
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) {
    throw new Error("Committed attempt directory contains missing or unexpected artifacts.");
  }
  for (const [artifactPath, contents] of stagedArtifacts) {
    const expected = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents));
    if (!retained.get(artifactPath)?.equals(expected)) {
      throw new Error(`Committed attempt readback differs: ${artifactPath}`);
    }
  }
  if (!retained.get("attempt-bundle.json")?.equals(Buffer.from(bundleBytes))) {
    throw new Error("Committed attempt-bundle readback differs.");
  }
  const retainedNonBundle = Object.fromEntries([...retained]
    .filter(([artifactPath]) => artifactPath !== "attempt-bundle.json")
    .map(([artifactPath, contents]) => [artifactPath, contents]));
  if (canonicalJson(hashArtifactSet(retainedNonBundle)) !== canonicalJson(expectedIndex)) {
    throw new Error("Committed attempt artifact index does not match durable readback.");
  }
  return Object.freeze({ artifactIndex: expectedIndex, attemptBundleSha256: sha256(bundleBytes) });
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

function isStrictDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function statNoFollow(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Resolve the trusted batch-owned attempt directory before browser or brief
 * setup. The internal expectedOutputDir option is supplied by the batch
 * executor and is deliberately absent from the author-visible runner config. */
export async function resolveCleanRoomAttemptOutputDirectory({
  attemptId,
  allowedRunsRoot,
  expectedOutputDir,
}) {
  if (typeof attemptId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(attemptId)) {
    throw new Error("Attempt output resolution requires a safe attempt ID.");
  }
  if (typeof allowedRunsRoot !== "string" || !path.isAbsolute(allowedRunsRoot)
      || path.normalize(allowedRunsRoot) !== allowedRunsRoot) {
    throw new Error("Allowed research runs root must be absolute and normalized.");
  }
  const allowedStat = await statNoFollow(allowedRunsRoot);
  if (!allowedStat?.isDirectory() || allowedStat.isSymbolicLink()
      || await realpath(allowedRunsRoot) !== allowedRunsRoot) {
    throw new Error("Allowed research runs root must be one canonical plain directory.");
  }
  const outputDir = expectedOutputDir ?? path.join(allowedRunsRoot, attemptId);
  if (typeof outputDir !== "string" || !path.isAbsolute(outputDir)
      || path.normalize(outputDir) !== outputDir || path.basename(outputDir) !== attemptId) {
    throw new Error("Expected attempt output must be an absolute normalized path with the exact attempt ID leaf.");
  }
  const parent = path.dirname(outputDir);
  if (parent !== allowedRunsRoot && !isStrictDescendant(allowedRunsRoot, parent)) {
    throw new Error("Expected attempt output must remain beneath the fixed research runs root.");
  }
  const parentStat = await statNoFollow(parent);
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink() || await realpath(parent) !== parent) {
    throw new Error("Expected attempt output parent must be one canonical plain directory.");
  }
  if (await statNoFollow(outputDir)) {
    throw new Error("Expected attempt output already exists; refusing overwrite or ambiguous resume.");
  }
  return outputDir;
}

export async function runCleanRoomAttempt(rawConfig, options = {}) {
  const dryRun = options.dryRun === true;
  const config = validateRunnerConfig(rawConfig, dryRun);
  if (!dryRun) throw new Error(CODEX_NATIVE_TRANSPORT_REQUIRED);
  if (options.expectedOutputDir !== undefined && typeof options.verifyRuntimeDependencies !== "function") {
    throw new Error("Trusted batch execution requires runtime dependency verification before browser load.");
  }
  if (options.concurrentEventExecutor && !config.concurrentEventCallbackHash) {
    throw new Error("A trusted concurrent-event executor requires its frozen SHA-256 digest.");
  }
  if (!dryRun && config.concurrentEventCallbackHash && !options.concurrentEventExecutor) {
    throw new Error("The frozen concurrent-event plan requires its trusted executor callback.");
  }
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const outputRoot = path.resolve(repoRoot, "research/results/runs");
  await mkdir(outputRoot, { recursive: true });
  const outputDir = await resolveCleanRoomAttemptOutputDirectory({
    attemptId: config.attemptId,
    allowedRunsRoot: outputRoot,
    expectedOutputDir: options.expectedOutputDir,
  });
  await mkdir(outputDir, { mode: 0o700 });
  const startedAt = Date.now();
  const secrets = [];
  const events = eventRecorder(startedAt, secrets);
  const artifacts = new Map();
  const authorIdentity = config.authorIdentityCommitment
    ? createAuthorIdentityEvidence(config.attemptId, config.authorIdentityCommitment)
    : null;
  if (authorIdentity) artifacts.set(authorIdentity.path, authorIdentity.bytes);
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
    usage: {
      totals: emptyResponseUsageTotals(),
      byTurn: [],
      costInputs: responseUsageCostInputs(emptyResponseUsageTotals()),
    },
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
  let runtimeDependencyVerification = null;
  try {
    const observedNodeVersion = process.version.replace(/^v/, "");
    if (observedNodeVersion !== config.expectedRuntime.nodeVersion) assertFrozenRuntimeEnvironment(config.expectedRuntime, {
      nodeVersion: observedNodeVersion,
      browserVersion: config.expectedRuntime.browserVersion,
    });
    if (typeof options.verifyRuntimeDependencies === "function") {
      const verification = await options.verifyRuntimeDependencies();
      if (!verification || typeof verification !== "object"
          || typeof verification.receiptDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(verification.receiptDigest)
          || typeof verification.componentSetRoot !== "string" || !/^sha256:[a-f0-9]{64}$/.test(verification.componentSetRoot)
          || verification.verificationScope !== "critical-load-and-executable-subset"
          || !Number.isSafeInteger(verification.verificationDurationMs)
          || verification.verificationDurationMs < 0) {
        throw new Error("Runtime dependency verifier returned an invalid critical verification receipt.");
      }
      runtimeDependencyVerification = {
        receiptDigest: verification.receiptDigest,
        componentSetRoot: verification.componentSetRoot,
        verificationScope: verification.verificationScope,
        verificationDurationMs: verification.verificationDurationMs,
      };
      events.add("runtime_dependencies_verified", runtimeDependencyVerification);
    }
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: config.headless });
    browserVersion = browser.version();
    assertFrozenRuntimeEnvironment(config.expectedRuntime, { nodeVersion: observedNodeVersion, browserVersion });
    events.add("runtime_environment_verified", {
      nodeVersion: observedNodeVersion,
      browserVersion,
    });
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

    if (!dryRun) {
      const briefReleaseRequestedAt = Date.now();
      const effectiveBriefDeliveredAt = await notifyBriefDelivered(options.onBriefDelivered, briefReleaseRequestedAt);
      attemptStartedAt = Date.parse(effectiveBriefDeliveredAt);
      authorEvents = eventRecorder(attemptStartedAt, secrets);
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
    } else {
      authorEvents = eventRecorder(startedAt, secrets);
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
    const finalRoomRevision = spectatorState?.data?.room?.roomRevision;
    if (!Number.isSafeInteger(finalRoomRevision) || finalRoomRevision < 1) {
      throw new Error("Spectator final state did not expose a positive authoritative room revision.");
    }
    const semanticExport = await captureSemanticExportEvidence(
      spectator.page,
      finalRoomRevision,
      config.perToolTimeoutMs,
    );
    artifacts.set(
      "spectator-semantic-export-receipt.json",
      jsonArtifact(semanticExport.receipt),
    );
    let spectatorInspection = null;
    const inspectInput = inspectionInputFromState(spectatorState);
    if (inspectInput && spectatorTools.some((tool) => tool.name === "inspect_canvas_scope")) {
      const inspectionResult = await executeLiveTool(spectator.page, "inspect_canvas_scope", inspectInput, config.perToolTimeoutMs);
      spectatorInspection = { result: inspectionResult };
    }
    const pngExport = await capturePngExportEvidence(
      spectator.page,
      finalRoomRevision,
      config.perToolTimeoutMs,
    );
    artifacts.set("spectator-png-export-receipt.json", jsonArtifact(pngExport.receipt));
    if (pngExport.bytes) {
      artifacts.set(`spectator-final-r${finalRoomRevision}.png`, pngExport.bytes);
      spectatorInspection = {
        ...(spectatorInspection ?? {}),
        pixel: {
          roomRevision: finalRoomRevision,
          sha256: pngExport.receipt.download.sha256,
          source: "export_canvas_png",
        },
      };
    } else {
      spectatorInspection = {
        ...(spectatorInspection ?? {}),
        pixelError: pngExport.receipt.download.failure ?? "Exact-revision PNG bytes were not captured.",
      };
    }
    artifacts.set("spectator-tool-contract.json", jsonArtifact(spectatorContract));
    artifacts.set("spectator-final-state.json", jsonArtifact(sanitizeForResearch(spectatorState, { secrets })));
    artifacts.set("spectator-inspection.json", jsonArtifact(sanitizeForResearch(spectatorInspection ?? {
      status: "not_available",
      reason: inspectInput ? "inspect_canvas_scope_not_registered" : "room_has_no_inspectable_objects",
    }, { secrets })));
    // Persist every response/download receipt before enforcing acceptance so a
    // non-JSON route response or corrupt download remains diagnosable.
    assertSemanticExportEvidence(semanticExport.receipt);
    assertPngExportEvidence(pngExport.receipt);
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
      const retainedUsage = recoverCompletedResponseUsage(authorEvents.events, authorResult.usage.totals);
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
      providerIntent: {
        provider: "openai_responses",
        requestedModelIdentifier: config.model,
        requestedServiceTier: config.serviceTier,
        immutableModelSnapshotVerified: false,
      },
      author: authorResult,
      authorIdentity: authorIdentity ? {
        identityCommitment: authorIdentity.record.identityCommitment,
        artifactPath: authorIdentity.path,
        artifactSha256: authorIdentity.artifactSha256,
      } : null,
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
        runtimeDependencies: runtimeDependencyVerification,
      },
    }, { secrets });
    const bundleBytes = jsonArtifact(bundle);
    assertNoSecretLeak(new Map([...artifacts, ["attempt-bundle.json", bundleBytes]]), secrets);
    await commitCleanRoomAttemptEvidence(outputDir, artifacts, bundle);
    artifacts.set("attempt-bundle.json", bundleBytes);
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
