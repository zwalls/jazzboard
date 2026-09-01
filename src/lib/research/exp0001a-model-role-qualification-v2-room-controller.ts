import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { z } from "zod";
import type { Browser, BrowserContext, Download, Page, Response } from "playwright";

import developmentBenchmarkJson from "../../../research/benchmarks/development-v2.json";
import developmentFixtureSpecsJson from "../../../research/benchmarks/development-fixture-specs-v2.json";
import developmentRubricsJson from "../../../research/benchmarks/development-evaluator-rubrics-v2.json";
import baselineReceiptJson from "../../../research/data/baseline-freeze-v3.json";
import baselineInventoryJson from "../../../research/data/baseline-webmcp-inventory-v3.json";
import productionBindingJson from "../../../research/data/exp0001a-model-role-qualification-launch-binding-v3.json";
import {
  compileBenchmarkTaskExecution,
  parseBenchmarkExecutionBundle,
  type BenchmarkCanvasOperation,
} from "./benchmark-execution";
import {
  qualificationV2RoomReceiptSchema,
  sealQualificationV2RoomReceipt,
} from "./exp0001a-model-role-qualification-v2-coordinator";
import { assertQualificationV2PngStructure } from "./exp0001a-model-role-qualification-v2-png-sidecar";
import {
  canonicalJson,
  hashCanonicalJson,
  sha256Digest,
  type JsonValue,
} from "./provenance-crypto";
import {
  parseQualificationV2ProvisionControllerReceipt,
  parseQualificationV2CaptureAuthorization,
  parseQualificationV2CaptureReleaseJournal,
  qualificationV3CaptureControllerReceiptContentSchema,
  qualificationV2HarnessRuntimeProvenanceSchema,
  qualificationV3ProvisionControllerReceiptContentSchema,
  sealQualificationV2CaptureTerminalReceipt,
  sealQualificationV3CaptureControllerReceipt,
  sealQualificationV3ProvisionControllerReceipt,
} from "./exp0001a-model-role-qualification-v2-room-controller-receipts";

const BASE_URL = "https://www.jazzboard.xyz" as const;
const PLAYWRIGHT_VERSION = (createRequire(import.meta.url)("playwright/package.json") as { version: string }).version;
const TASK_IDS = [
  "dev-architecture-create-checkout",
  "dev-architecture-edit-uncertainty",
  "dev-drawing-create-wayfinding-icon",
] as const;
const taskIdSchema = z.enum(TASK_IDS);
const absolutePathSchema = z.string().refine((value) => (
  path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root
), "Path must be absolute, normalized, and non-root.");
const timestampSchema = z.string().datetime({ offset: true });

const controllerRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("provision_room"),
    taskId: taskIdSchema,
    outputDirectory: absolutePathSchema,
    at: timestampSchema,
  }).strict(),
  z.object({
    operation: z.literal("capture_author_evidence"),
    roomReceiptPath: absolutePathSchema,
    provisionControllerReceiptPath: absolutePathSchema,
    storageStatePath: absolutePathSchema,
    outputDirectory: absolutePathSchema,
    at: timestampSchema,
    captureAuthorization: z.unknown(),
    captureReleaseJournal: z.unknown(),
  }).strict(),
]);

type ToolResult = Readonly<{
  ok: boolean;
  tool: string;
  data?: Record<string, unknown>;
  error?: Record<string, unknown>;
}>;

const QUALIFICATION_V2_DEFAULT_WEBMCP_TIMEOUT_MS = 30_000;
const QUALIFICATION_V2_PNG_EXPORT_TIMEOUT_MS = 120_000;

type RegisteredTool = Readonly<{
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}>;

type BrowserTool = RegisteredTool & Readonly<{
  execute: (input: unknown, options: Readonly<{ signal: AbortSignal }>) => Promise<unknown>;
}>;

type BrowserStorageState = Exclude<
  NonNullable<Parameters<Browser["newContext"]>[0]>["storageState"],
  string | undefined
>;

function cloneJson(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertPrivatePath(
  repositoryRoot: string,
  candidate: string,
  allowMissingLeaf = false,
  expectedPrivateRoot?: string,
) {
  const allowedRoots = [
    path.join(repositoryRoot, ".research-private", "exp0001a-qualification-v2"),
    path.join(repositoryRoot, ".research-private", "exp0001a-qualification-v3"),
  ];
  const absolute = path.resolve(candidate);
  const selectedRoot = expectedPrivateRoot ?? allowedRoots.find((root) => isStrictDescendant(root, absolute));
  if (selectedRoot === undefined || !allowedRoots.includes(selectedRoot)) {
    throw new Error("QUALIFICATION_V2_ROOM_CONTROLLER_PATH_NOT_PRIVATE");
  }
  const privateRoot = await realpath(selectedRoot);
  if (privateRoot !== selectedRoot) {
    throw new Error("QUALIFICATION_V2_ROOM_CONTROLLER_PRIVATE_ROOT_INVALID");
  }
  const rootMetadata = await lstat(privateRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
      || (rootMetadata.mode & 0o777) !== 0o700) {
    throw new Error("QUALIFICATION_V2_ROOM_CONTROLLER_PRIVATE_ROOT_INVALID");
  }
  const resolved = allowMissingLeaf
    ? path.join(await realpath(path.dirname(candidate)), path.basename(candidate))
    : await realpath(candidate);
  if (!isStrictDescendant(privateRoot, resolved)) {
    throw new Error("QUALIFICATION_V2_ROOM_CONTROLLER_PATH_NOT_PRIVATE");
  }
  return { privateRoot, resolved };
}

async function readPrivate(filePath: string, label: string) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must be a singly linked mode-600 plain file.`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function readPrivateJson(filePath: string, label: string) {
  const bytes = await readPrivate(filePath, label);
  try { return JSON.parse(bytes.toString("utf8")) as unknown; } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(filePath: string, bytes: Uint8Array) {
  await mkdir(path.dirname(filePath), { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const readback = await readPrivate(filePath, "Room-controller output");
  if (!readback.equals(Buffer.from(bytes))) throw new Error("QUALIFICATION_V2_ROOM_CONTROLLER_READBACK_MISMATCH");
  await syncDirectory(path.dirname(filePath));
}

async function writeExclusiveJson(filePath: string, value: unknown) {
  await writeExclusive(filePath, Buffer.from(`${canonicalJson(value)}\n`, "utf8"));
}

function installWebMcpHostShim() {
  const tools = new Map<string, BrowserTool>();
  const hostWindow = window as unknown as {
    __jazzboardQualificationTools?: Map<string, BrowserTool>;
  };
  Object.defineProperty(hostWindow, "__jazzboardQualificationTools", { configurable: true, value: tools });
  const modelContext = new EventTarget() as EventTarget & {
    ontoolchange: null;
    registerTool: (tool: BrowserTool, options?: Readonly<{ signal?: AbortSignal }>) => Promise<void>;
    getTools: () => Promise<RegisteredTool[]>;
  };
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

async function liveTools(page: Page): Promise<RegisteredTool[]> {
  return page.evaluate(async () => {
    const hostWindow = window as unknown as { __jazzboardQualificationTools?: Map<string, BrowserTool> };
    return [...(hostWindow.__jazzboardQualificationTools?.values() ?? [])].map((tool) => ({
      name: tool.name,
      title: tool.title ?? tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      annotations: tool.annotations ?? {},
    }));
  });
}

async function executeTool(
  page: Page,
  name: string,
  input: unknown,
  timeoutMs = QUALIFICATION_V2_DEFAULT_WEBMCP_TIMEOUT_MS,
): Promise<ToolResult> {
  const raw = await page.evaluate(async ({ toolName, toolInput, toolTimeoutMs }) => {
    const hostWindow = window as unknown as { __jazzboardQualificationTools?: Map<string, BrowserTool> };
    const tool = hostWindow.__jazzboardQualificationTools?.get(toolName);
    if (!tool) throw new Error(`QUALIFICATION_V2_WEBMCP_TOOL_NOT_REGISTERED:${toolName}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), toolTimeoutMs);
    try { return await tool.execute(toolInput, { signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }, { toolName: name, toolInput: input, toolTimeoutMs: timeoutMs });
  const cloned = cloneJson(raw);
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") {
    throw new Error(`QUALIFICATION_V2_WEBMCP_RESULT_INVALID:${name}`);
  }
  return cloned as unknown as ToolResult;
}

function successfulTool(result: ToolResult, name: string): Record<string, unknown> {
  if (result.ok !== true || result.tool !== name || result.data === undefined) {
    throw new Error(`QUALIFICATION_V2_WEBMCP_TOOL_FAILED:${name}`);
  }
  return result.data;
}

function normalizeDescriptors(tools: readonly RegisteredTool[]) {
  return [...tools].map((tool) => ({
    name: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? null,
    annotations: tool.annotations ?? {},
  })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function toolContract(tools: readonly RegisteredTool[]) {
  const descriptors = normalizeDescriptors(tools);
  const entries = descriptors.map((descriptor) => ({
    name: descriptor.name,
    definitionDigest: hashCanonicalJson(descriptor as unknown as JsonValue),
  }));
  return {
    descriptors,
    toolCount: descriptors.length,
    inventoryDigest: hashCanonicalJson(entries as unknown as JsonValue),
    contractDigest: hashCanonicalJson(descriptors as unknown as JsonValue),
    tools: entries,
  };
}

function assertFrozenToolContract(
  actual: ReturnType<typeof toolContract>,
  expected: { toolCount: number; inventoryDigest: string; contractDigest: string; tools: unknown[] },
  label: string,
) {
  if (actual.toolCount !== expected.toolCount
      || actual.inventoryDigest !== expected.inventoryDigest
      || actual.contractDigest !== expected.contractDigest
      || canonicalJson(actual.tools as unknown as JsonValue) !== canonicalJson(expected.tools as unknown as JsonValue)) {
    throw new Error(`QUALIFICATION_V2_${label}_TOOL_CONTRACT_DRIFT`);
  }
}

async function waitForFrozenToolContract(
  page: Page,
  expected: { toolCount: number; inventoryDigest: string; contractDigest: string; tools: unknown[] },
  label: string,
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const tools = await liveTools(page);
    if (tools.length === expected.toolCount) {
      const first = toolContract(tools);
      try {
        assertFrozenToolContract(first, expected, label);
        await page.waitForTimeout(100);
        const second = toolContract(await liveTools(page));
        assertFrozenToolContract(second, expected, label);
        return second;
      } catch {
        // Registration can be incremental. Only fail after the bounded wait.
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`QUALIFICATION_V2_${label}_TOOL_CONTRACT_DRIFT`);
}

async function assertFrozenDeployment(response: Response | null) {
  if (response === null || response.status() !== 200) {
    throw new Error("QUALIFICATION_V2_PRODUCTION_NAVIGATION_FAILED");
  }
  const html = await response.text();
  const deploymentId = /data-dpl-id=["'](dpl_[A-Za-z0-9]+)["']/.exec(html)?.[1] ?? null;
  if (deploymentId !== baselineReceiptJson.deployment.deploymentId) {
    throw new Error("QUALIFICATION_V2_PRODUCTION_DEPLOYMENT_DRIFT");
  }
  return deploymentId;
}

async function reobserveFrozenDeployment(context: BrowserContext) {
  const page = await context.newPage();
  try {
    return await assertFrozenDeployment(await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" }));
  } finally {
    await page.close();
  }
}

function roomStateData(result: ToolResult) {
  const data = successfulTool(result, "read_room_state");
  const room = data.room;
  if (room === null || Array.isArray(room) || typeof room !== "object") {
    throw new Error("QUALIFICATION_V2_ROOM_STATE_ROOM_INVALID");
  }
  if (!Array.isArray(data.objects) || !Array.isArray(data.diagrams) || !Array.isArray(data.participants)) {
    throw new Error("QUALIFICATION_V2_ROOM_STATE_COLLECTIONS_INVALID");
  }
  const objects = data.objects as Array<Record<string, unknown>>;
  const diagrams = data.diagrams as Array<Record<string, unknown>>;
  const participants = data.participants as Array<Record<string, unknown>>;
  const roomRecord = room as Record<string, unknown>;
  if (typeof roomRecord.id !== "string" || typeof roomRecord.code !== "string" || typeof roomRecord.title !== "string"
      || typeof roomRecord.selfParticipantId !== "string" || !Number.isSafeInteger(roomRecord.roomRevision)
      || Number(roomRecord.roomRevision) < 0) {
    throw new Error("QUALIFICATION_V2_ROOM_STATE_IDENTITY_INVALID");
  }
  const ids = [...objects, ...diagrams].map((record) => {
    if (record === null || Array.isArray(record) || typeof record !== "object"
        || typeof record.id !== "string" || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1) {
      throw new Error("QUALIFICATION_V2_ROOM_STATE_RECORD_INVALID");
    }
    return record.id;
  });
  if (new Set(ids).size !== ids.length) throw new Error("QUALIFICATION_V2_ROOM_STATE_RECORD_ID_DUPLICATE");
  for (const participant of participants) {
    if (participant === null || Array.isArray(participant) || typeof participant !== "object"
        || typeof participant.participantId !== "string" || typeof participant.displayName !== "string"
        || (participant.role !== "participant" && participant.role !== "spectator")) {
      throw new Error("QUALIFICATION_V2_ROOM_STATE_PARTICIPANT_INVALID");
    }
  }
  return { data, room: roomRecord, objects, diagrams, participants };
}

function exactObjectScope(objects: readonly Record<string, unknown>[]) {
  if (objects.length === 0 || objects.length > 1_000) {
    throw new Error("QUALIFICATION_V2_EVIDENCE_OBJECT_SCOPE_SIZE_INVALID");
  }
  const targets = objects.map((object) => {
    if (typeof object.id !== "string" || object.id.length === 0 || object.id.length > 128
        || !Number.isSafeInteger(object.revision) || Number(object.revision) < 1) {
      throw new Error("QUALIFICATION_V2_EVIDENCE_OBJECT_TARGET_INVALID");
    }
    return { objectId: object.id, expectedRevision: Number(object.revision) };
  }).sort((left, right) => left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0);
  if (new Set(targets.map((target) => target.objectId)).size !== targets.length) {
    throw new Error("QUALIFICATION_V2_EVIDENCE_OBJECT_TARGET_DUPLICATE");
  }
  return { kind: "objects" as const, targets };
}

function assertExactRevisionList(
  value: unknown,
  expectedTargets: readonly { objectId: string; expectedRevision: number }[],
  label: string,
) {
  if (!Array.isArray(value)) throw new Error(`QUALIFICATION_V2_${label}_REVISIONS_INVALID`);
  const actual = value.map((item) => {
    if (item === null || Array.isArray(item) || typeof item !== "object") {
      throw new Error(`QUALIFICATION_V2_${label}_REVISIONS_INVALID`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.objectId !== "string" || !Number.isSafeInteger(record.revision)) {
      throw new Error(`QUALIFICATION_V2_${label}_REVISIONS_INVALID`);
    }
    return { objectId: record.objectId, expectedRevision: Number(record.revision) };
  }).sort((left, right) => left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0);
  if (new Set(actual.map((item) => item.objectId)).size !== actual.length
      || canonicalJson(actual as unknown as JsonValue) !== canonicalJson(expectedTargets as unknown as JsonValue)) {
    throw new Error(`QUALIFICATION_V2_${label}_REVISIONS_MISMATCH`);
  }
}

function stableFNV1aDigest(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function assertExactInspectionSceneContext(
  data: Record<string, unknown>,
  expectedTargets: readonly { objectId: string; expectedRevision: number }[],
  roomRevision: number,
) {
  const sceneContext = data.sceneContext;
  if (sceneContext === null || Array.isArray(sceneContext) || typeof sceneContext !== "object") {
    throw new Error("QUALIFICATION_V2_INSPECTION_SCENE_CONTEXT_INVALID");
  }
  const scene = sceneContext as Record<string, unknown>;
  const scope = scene.scope;
  const revisions = scene.revisions;
  const coverage = scene.coverage;
  if (scene.schemaVersion !== 2 || scope === null || Array.isArray(scope) || typeof scope !== "object"
      || (scope as Record<string, unknown>).kind !== "objects"
      || revisions === null || Array.isArray(revisions) || typeof revisions !== "object"
      || coverage === null || Array.isArray(coverage) || typeof coverage !== "object") {
    throw new Error("QUALIFICATION_V2_INSPECTION_SCENE_CONTEXT_INVALID");
  }
  const revisionRecord = revisions as Record<string, unknown>;
  const coverageRecord = coverage as Record<string, unknown>;
  const revisionCoverage = revisionRecord.explicitObjectRevisionCoverage;
  if (revisionRecord.roomRevision !== roomRevision
      || revisionCoverage === null || Array.isArray(revisionCoverage) || typeof revisionCoverage !== "object") {
    throw new Error("QUALIFICATION_V2_INSPECTION_REVISION_MISMATCH");
  }
  const exactRevisions = expectedTargets.map((target) => ({
    objectId: target.objectId,
    revision: target.expectedRevision,
  }));
  const revisionCoverageRecord = revisionCoverage as Record<string, unknown>;
  const returnedCount = revisionCoverageRecord.returnedCount;
  const expectedPrefix = exactRevisions.slice(0, typeof returnedCount === "number" ? returnedCount : 0);
  if (revisionCoverageRecord.totalCount !== exactRevisions.length
      || !Number.isSafeInteger(returnedCount) || Number(returnedCount) < 0
      || revisionCoverageRecord.omittedCount !== exactRevisions.length - Number(returnedCount)
      || revisionCoverageRecord.truncated !== (Number(returnedCount) < exactRevisions.length)
      || revisionCoverageRecord.fullSetDigest !== stableFNV1aDigest(exactRevisions)
      || canonicalJson(revisionRecord.explicitObjectRevisions as JsonValue) !== canonicalJson(expectedPrefix as unknown as JsonValue)
      || coverageRecord.scopeObjectCount !== exactRevisions.length
      || coverageRecord.visualContributorCount !== exactRevisions.length
      || coverageRecord.allExplicitTargetsRepresented !== true) {
    throw new Error("QUALIFICATION_V2_INSPECTION_EXACT_SCOPE_MISMATCH");
  }
}

function sortedRecords(records: readonly Record<string, unknown>[]) {
  return [...records].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function resolveOperationReference(
  reference: { tempRef: string } | { objectId: string },
  references: Record<string, unknown>,
) {
  const resolved = "tempRef" in reference ? references[reference.tempRef] : reference.objectId;
  if (typeof resolved !== "string") throw new Error("QUALIFICATION_V2_FIXTURE_REFERENCE_UNRESOLVED");
  return resolved;
}

function assertRecordProjection(record: Record<string, unknown>, expected: Record<string, unknown>, label: string) {
  for (const [key, value] of Object.entries(expected)) {
    if (canonicalJson(record[key] as JsonValue) !== canonicalJson(value as JsonValue)) {
      throw new Error(`QUALIFICATION_V2_FIXTURE_DECLARATION_MISMATCH:${label}:${key}`);
    }
  }
}

function verifyFixtureOperation(
  operation: BenchmarkCanvasOperation,
  record: Record<string, unknown>,
  references: Record<string, unknown>,
) {
  if (operation.op === "update") throw new Error("QUALIFICATION_V2_FIXTURE_UPDATE_FORBIDDEN");
  if (record.revision !== 1) throw new Error(`QUALIFICATION_V2_FIXTURE_RECORD_REVISION_INVALID:${operation.op}`);
  if (operation.op === "create_diagram") {
    assertRecordProjection(record, {
      title: operation.title,
      description: operation.description,
      diagramType: operation.diagramType,
      category: operation.category,
      tags: operation.tags,
    }, operation.tempRef);
    const expectedMembers = operation.members.map((reference) => resolveOperationReference(reference, references)).sort();
    const expectedConnectors = operation.connectors.map((reference) => resolveOperationReference(reference, references)).sort();
    const actualMembers = Array.isArray(record.memberObjectIds) ? [...record.memberObjectIds].sort() : null;
    const actualConnectors = Array.isArray(record.connectorIds) ? [...record.connectorIds].sort() : null;
    if (actualMembers === null || actualConnectors === null
        || new Set(actualMembers).size !== actualMembers.length
        || new Set(actualConnectors).size !== actualConnectors.length
        || canonicalJson(actualMembers as JsonValue) !== canonicalJson(expectedMembers as JsonValue)
        || canonicalJson(actualConnectors as JsonValue) !== canonicalJson(expectedConnectors as JsonValue)) {
      throw new Error(`QUALIFICATION_V2_FIXTURE_DIAGRAM_MEMBERSHIP_MISMATCH:${operation.tempRef}`);
    }
    return;
  }
  const semantic = {
    semanticName: operation.semanticName,
    semanticRole: operation.semanticRole,
  };
  if (operation.op === "create_node") {
    assertRecordProjection(record, {
      ...semantic, kind: "shape", shape: "rectangle", label: operation.label, nodeType: operation.nodeType,
      x: operation.x, y: operation.y, width: operation.width, height: operation.height, zIndex: operation.zIndex,
    }, operation.tempRef);
  } else if (operation.op === "create_shape") {
    assertRecordProjection(record, {
      ...semantic, kind: "shape", shape: operation.shape, label: operation.label,
      fill: operation.fill, stroke: operation.stroke,
      x: operation.x, y: operation.y, width: operation.width, height: operation.height, zIndex: operation.zIndex,
    }, operation.tempRef);
  } else if (operation.op === "create_text") {
    assertRecordProjection(record, {
      ...semantic, kind: "text", content: operation.content, color: operation.color,
      size: operation.size, align: operation.align,
      x: operation.x, y: operation.y, width: operation.width, height: operation.height, zIndex: operation.zIndex,
    }, operation.tempRef);
  } else if (operation.op === "connect") {
    const start = record.start as Record<string, unknown> | undefined;
    const end = record.end as Record<string, unknown> | undefined;
    const routing = record.routing as Record<string, unknown> | undefined;
    if (start?.objectId !== resolveOperationReference(operation.start, references)
        || end?.objectId !== resolveOperationReference(operation.end, references)
        || routing?.mode !== operation.routing.mode
        || ("bend" in operation.routing && routing.bend !== operation.routing.bend)
        || ("elbowMidPoint" in operation.routing && routing.elbowMidPoint !== operation.routing.elbowMidPoint)) {
      throw new Error(`QUALIFICATION_V2_FIXTURE_CONNECTOR_MISMATCH:${operation.tempRef}`);
    }
    assertRecordProjection(record, {
      ...semantic, kind: "connector", direction: operation.direction, label: operation.label, color: operation.color,
    }, operation.tempRef);
  } else if (operation.op === "create_drawing") {
    assertRecordProjection(record, {
      ...semantic, kind: "draw", color: operation.color, size: operation.size,
      rotation: operation.rotation, zIndex: operation.zIndex, groupId: operation.groupId,
    }, operation.tempRef);
  } else {
    assertRecordProjection(record, {
      ...semantic, kind: "path", fill: operation.fill, stroke: operation.stroke,
      strokeWidth: operation.strokeWidth, opacity: operation.opacity, lineCap: operation.lineCap,
      lineJoin: operation.lineJoin, fillRule: operation.fillRule, rotation: operation.rotation,
      zIndex: operation.zIndex, groupId: operation.groupId,
    }, operation.tempRef);
  }
}

function verifyCompiledFixture(
  taskId: z.infer<typeof taskIdSchema>,
  transactionResult: ToolResult,
  stateResult: ToolResult,
  blankStateResult: ToolResult,
) {
  const bundle = parseBenchmarkExecutionBundle(
    developmentBenchmarkJson,
    developmentRubricsJson,
    developmentFixtureSpecsJson,
  );
  const execution = compileBenchmarkTaskExecution(bundle, taskId);
  const setup = execution.trustedCoordinator.preBriefSetup;
  const preflight = execution.trustedCoordinator.seedReadabilityPreflight;
  if (setup === null || preflight === null) throw new Error("QUALIFICATION_V2_EXPECTED_FIXTURE_MISSING");
  const transaction = successfulTool(transactionResult, setup.toolName);
  if (transaction.outcome !== "applied" || typeof transaction.roomRevision !== "number") {
    throw new Error("QUALIFICATION_V2_FIXTURE_TRANSACTION_NOT_APPLIED");
  }
  const temporaryReferences = transaction.temporaryReferences;
  if (temporaryReferences === null || Array.isArray(temporaryReferences) || typeof temporaryReferences !== "object") {
    throw new Error("QUALIFICATION_V2_FIXTURE_TEMP_REFS_MISSING");
  }
  const refs = temporaryReferences as Record<string, unknown>;
  const blank = roomStateData(blankStateResult);
  const state = roomStateData(stateResult);
  if (blank.objects.length !== 0 || blank.diagrams.length !== 0
      || state.room.id !== blank.room.id
      || transaction.roomRevision !== Number(blank.room.roomRevision) + 1
      || state.room.roomRevision !== transaction.roomRevision) {
    throw new Error("QUALIFICATION_V2_FIXTURE_ATOMIC_TRANSITION_MISMATCH");
  }
  const objectOperations = setup.input.operations.filter((operation) => operation.op !== "create_diagram");
  const diagramOperations = setup.input.operations.filter((operation) => operation.op === "create_diagram");
  const expectedTempRefs = setup.input.operations.flatMap((operation) => (
    "tempRef" in operation ? [operation.tempRef] : []
  )).sort();
  if (canonicalJson(Object.keys(refs).sort()) !== canonicalJson(expectedTempRefs)
      || Object.values(refs).some((value) => typeof value !== "string")
      || new Set(Object.values(refs)).size !== expectedTempRefs.length) {
    throw new Error("QUALIFICATION_V2_FIXTURE_TEMP_REF_SET_MISMATCH");
  }
  const byId = new Map(state.objects.map((object) => [object.id, object]));
  const diagramsById = new Map(state.diagrams.map((diagram) => [diagram.id, diagram]));
  if (state.objects.length !== objectOperations.length) {
    throw new Error("QUALIFICATION_V2_FIXTURE_OBJECT_COUNT_MISMATCH");
  }
  if (state.diagrams.length !== diagramOperations.length) {
    throw new Error("QUALIFICATION_V2_FIXTURE_DIAGRAM_COUNT_MISMATCH");
  }
  for (const operation of setup.input.operations) {
    if (!("tempRef" in operation)) throw new Error("QUALIFICATION_V2_FIXTURE_OPERATION_WITHOUT_TEMP_REF");
    const recordId = refs[operation.tempRef];
    const record = operation.op === "create_diagram" ? diagramsById.get(recordId) : byId.get(recordId);
    if (typeof recordId !== "string" || record === undefined) {
      throw new Error(`QUALIFICATION_V2_FIXTURE_RECORD_MISSING:${operation.tempRef}`);
    }
    verifyFixtureOperation(operation, record, refs);
  }
  const expectedDiagramIdsByObjectId = new Map<string, string[]>();
  for (const operation of diagramOperations) {
    const diagramId = refs[operation.tempRef];
    if (typeof diagramId !== "string") throw new Error("QUALIFICATION_V2_FIXTURE_DIAGRAM_REFERENCE_INVALID");
    for (const reference of [...operation.members, ...operation.connectors]) {
      const objectId = resolveOperationReference(reference, refs);
      expectedDiagramIdsByObjectId.set(objectId, [
        ...(expectedDiagramIdsByObjectId.get(objectId) ?? []),
        diagramId,
      ]);
    }
  }
  for (const object of state.objects) {
    const expectedDiagramIds = [...(expectedDiagramIdsByObjectId.get(String(object.id)) ?? [])].sort();
    const actualDiagramIds = Array.isArray(object.diagramIds) ? [...object.diagramIds].sort() : null;
    if (actualDiagramIds === null || new Set(actualDiagramIds).size !== actualDiagramIds.length
        || canonicalJson(actualDiagramIds as JsonValue) !== canonicalJson(expectedDiagramIds as JsonValue)) {
      throw new Error(`QUALIFICATION_V2_FIXTURE_REVERSE_DIAGRAM_MEMBERSHIP_MISMATCH:${String(object.id)}`);
    }
  }
  const transactionObjects = Array.isArray(transaction.objects) ? transaction.objects as Record<string, unknown>[] : null;
  const transactionDiagrams = Array.isArray(transaction.diagrams) ? transaction.diagrams as Record<string, unknown>[] : null;
  const expectedObjectIds = objectOperations.map((operation) => {
    if (!("tempRef" in operation)) throw new Error("QUALIFICATION_V2_FIXTURE_UPDATE_FORBIDDEN");
    return refs[operation.tempRef];
  }).sort();
  const expectedDiagramIds = diagramOperations.map((operation) => refs[operation.tempRef]).sort();
  if (transactionObjects === null || transactionDiagrams === null
      || canonicalJson(sortedRecords(transactionObjects) as unknown as JsonValue) !== canonicalJson(sortedRecords(state.objects) as unknown as JsonValue)
      || canonicalJson(sortedRecords(transactionDiagrams) as unknown as JsonValue) !== canonicalJson(sortedRecords(state.diagrams) as unknown as JsonValue)
      || canonicalJson(Array.isArray(transaction.changedObjectIds) ? [...transaction.changedObjectIds].sort() as JsonValue : null) !== canonicalJson(expectedObjectIds as JsonValue)
      || canonicalJson(Array.isArray(transaction.changedDiagramIds) ? [...transaction.changedDiagramIds].sort() as JsonValue : null) !== canonicalJson(expectedDiagramIds as JsonValue)) {
    throw new Error("QUALIFICATION_V2_FIXTURE_RESULT_STATE_MISMATCH");
  }
  return { execution, preflight, state };
}

function asCallToolResult(result: ToolResult, pngBytes: Buffer | null = null) {
  return Object.freeze({
    content: [
      { type: "text" as const, text: canonicalJson(result as unknown as JsonValue) },
      ...(pngBytes === null ? [] : [{ type: "image" as const, data: pngBytes.toString("base64"), mimeType: "image/png" as const }]),
    ],
    isError: false,
  });
}

function pngDimensions(bytes: Buffer) {
  if (bytes.length < 24) throw new Error("QUALIFICATION_V2_PNG_DIMENSIONS_MISSING");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function normalizedOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return url.origin;
}

async function browserContext(
  browser: Browser,
  storageState?: BrowserStorageState,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    acceptDownloads: true,
    ...(storageState === undefined ? {} : { storageState }),
  });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("data:") || url.startsWith("blob:") || normalizedOrigin(url) === BASE_URL) {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
  await context.addInitScript(installWebMcpHostShim);
  return context;
}

async function readDownload(download: Download) {
  const failure = await download.failure();
  if (failure) throw new Error(`QUALIFICATION_V2_PNG_DOWNLOAD_FAILED:${failure}`);
  const stream = await download.createReadStream();
  if (!stream) throw new Error("QUALIFICATION_V2_PNG_DOWNLOAD_STREAM_MISSING");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function provisionRoom(
  request: Extract<z.infer<typeof controllerRequestSchema>, { operation: "provision_room" }>,
  harnessRuntimeProvenance: z.infer<typeof qualificationV2HarnessRuntimeProvenanceSchema>,
) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browserContext(browser);
    const page = await context.newPage();
    const landingResponse = await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    const deploymentId = await assertFrozenDeployment(landingResponse);
    const landingTools = await waitForFrozenToolContract(page, baselineInventoryJson.landing, "LANDING");
    const navigation = page.waitForURL(/\/room\/room_[^/?#]+$/, { timeout: 30_000 });
    const created = await executeTool(page, "create_room", {
      displayName: "Qualification Controller",
      title: "Qualification workspace",
    });
    const createdData = successfulTool(created, "create_room");
    await navigation;
    const createdRoom = createdData.room;
    if (createdRoom === null || Array.isArray(createdRoom) || typeof createdRoom !== "object") {
      throw new Error("QUALIFICATION_V2_CREATED_ROOM_INVALID");
    }
    const roomId = (createdRoom as Record<string, unknown>).id;
    const roomCode = (createdRoom as Record<string, unknown>).code;
    const roomTitle = (createdRoom as Record<string, unknown>).title;
    if (typeof roomId !== "string" || !/^room_[A-Za-z0-9_-]+$/.test(roomId)
        || typeof roomCode !== "string" || !/^[A-HJ-NP-Z2-9]{6}$/.test(roomCode)
        || roomTitle !== "Qualification workspace" || createdData.role !== "participant") {
      throw new Error("QUALIFICATION_V2_CREATED_ROOM_IDENTITY_INVALID");
    }
    const participantTools = await waitForFrozenToolContract(page, baselineInventoryJson.participant, "PARTICIPANT");

    const bundle = parseBenchmarkExecutionBundle(
      developmentBenchmarkJson,
      developmentRubricsJson,
      developmentFixtureSpecsJson,
    );
    const execution = compileBenchmarkTaskExecution(bundle, request.taskId);
    const blankStateResult = await executeTool(page, "read_room_state", {});
    const blankState = roomStateData(blankStateResult);
    if (blankState.room.id !== roomId || blankState.room.code !== roomCode || blankState.room.title !== roomTitle
        || blankState.objects.length !== 0 || blankState.diagrams.length !== 0) {
      throw new Error("QUALIFICATION_V2_FRESH_ROOM_BASELINE_INVALID");
    }
    let stateResult: ToolResult;
    let transactionResult: ToolResult | null = null;
    let initialStateKind: "blank" | "validated_fixture";
    let fixturePreflightDigest: string | null;
    if (execution.trustedCoordinator.preBriefSetup === null) {
      stateResult = await executeTool(page, "read_room_state", {});
      const state = roomStateData(stateResult);
      if (state.room.roomRevision !== blankState.room.roomRevision
          || state.objects.length !== 0 || state.diagrams.length !== 0) {
        throw new Error("QUALIFICATION_V2_BLANK_ROOM_NOT_EMPTY");
      }
      initialStateKind = "blank";
      fixturePreflightDigest = null;
    } else {
      transactionResult = await executeTool(
        page,
        execution.trustedCoordinator.preBriefSetup.toolName,
        execution.trustedCoordinator.preBriefSetup.input,
      );
      stateResult = await executeTool(page, "read_room_state", {});
      const verified = verifyCompiledFixture(request.taskId, transactionResult, stateResult, blankStateResult);
      initialStateKind = "validated_fixture";
      fixturePreflightDigest = verified.preflight.receiptDigest;
    }
    const state = roomStateData(stateResult);
    const self = state.participants.find((participant) => participant.participantId === state.room.selfParticipantId);
    if (state.room.id !== roomId || state.room.code !== roomCode || state.room.title !== roomTitle
        || !Number.isSafeInteger(state.room.roomRevision)
        || self?.displayName !== "Qualification Controller" || self.role !== "participant") {
      throw new Error("QUALIFICATION_V2_PROVISIONED_ROOM_STATE_INVALID");
    }
    const privateRoomInviteUrl = `${BASE_URL}/#join=${roomCode}`;
    const receipt = sealQualificationV2RoomReceipt({
      schemaVersion: "exp-0001a-qualification-room-receipt/v2",
      taskId: request.taskId,
      preparedAt: request.at,
      roomId,
      privateRoomInviteUrl,
      inviteAuthorizationBindingDigest: hashCanonicalJson({ roomId, privateRoomInviteUrl }),
      authorization: "exact_private_invite_only",
      globalDirectoryUsed: false,
      roomCreationReceiptDigest: hashCanonicalJson(created as unknown as JsonValue),
      initialStateKind,
      initialRoomRevision: state.room.roomRevision,
      initialObjectCount: state.objects.length,
      fixturePreflightDigest,
    });
    const closingDeploymentId = await reobserveFrozenDeployment(context);
    const storageState = await context.storageState();
    if (!Array.isArray(storageState.cookies) || storageState.cookies.length === 0) {
      throw new Error("QUALIFICATION_V2_AUTHORIZED_STORAGE_STATE_EMPTY");
    }
    const createCallResult = asCallToolResult(created);
    const blankCallResult = asCallToolResult(blankStateResult);
    const transactionCallResult = transactionResult === null ? null : asCallToolResult(transactionResult);
    const preAuthorCallResult = asCallToolResult(stateResult);
    await writeExclusiveJson(path.join(request.outputDirectory, "create-room-call-result.json"), createCallResult);
    await writeExclusiveJson(path.join(request.outputDirectory, "blank-read-room-state-call-result.json"), blankCallResult);
    if (transactionCallResult !== null) {
      await writeExclusiveJson(path.join(request.outputDirectory, "fixture-transaction-call-result.json"), transactionCallResult);
    }
    await writeExclusiveJson(path.join(request.outputDirectory, "pre-author-read-room-state-call-result.json"), preAuthorCallResult);
    await writeExclusiveJson(path.join(request.outputDirectory, "room-receipt.json"), receipt);
    await writeExclusiveJson(path.join(request.outputDirectory, "authorized-storage-state.json"), storageState);
    const controllerReceiptContent = qualificationV3ProvisionControllerReceiptContentSchema.parse({
      schemaVersion: "exp-0001a-qualification-room-controller-provision/v3",
      taskId: request.taskId,
      roomReceiptDigest: receipt.receiptDigest,
      storageStateDigest: hashCanonicalJson(storageState as unknown as JsonValue),
      productionBindingDigest: productionBindingJson.bindingDigest,
      baselineFreezeDigest: baselineReceiptJson.receiptDigest,
      deploymentId,
      deploymentObservations: [deploymentId, closingDeploymentId],
      landingToolContractDigest: landingTools.contractDigest,
      participantToolContractDigest: participantTools.contractDigest,
      playwrightVersion: PLAYWRIGHT_VERSION,
      chromiumVersion: browser.version(),
      runtime: { node: process.version, platform: process.platform, architecture: process.arch },
      harnessRuntimeProvenance,
      createRoomCallResultDigest: hashCanonicalJson(createCallResult as unknown as JsonValue),
      blankReadCallResultDigest: hashCanonicalJson(blankCallResult as unknown as JsonValue),
      fixtureTransactionCallResultDigest: transactionCallResult === null
        ? null
        : hashCanonicalJson(transactionCallResult as unknown as JsonValue),
      preAuthorReadCallResultDigest: hashCanonicalJson(preAuthorCallResult as unknown as JsonValue),
      frozenFixtureDeclarationDigest: execution.trustedCoordinator.preBriefSetup === null
        ? null
        : hashCanonicalJson(execution.trustedCoordinator.preBriefSetup.input as unknown as JsonValue),
      authoritativeInitialStateDigest: hashCanonicalJson(state.data as unknown as JsonValue),
      initialRoomRevision: receipt.initialRoomRevision,
      initialObjectCount: receipt.initialObjectCount,
      retainedAt: request.at,
    });
    const controllerReceipt = sealQualificationV3ProvisionControllerReceipt(controllerReceiptContent);
    await writeExclusiveJson(path.join(request.outputDirectory, "provision-controller-receipt.json"), controllerReceipt);
    return { receipt, controllerReceipt };
  } finally {
    await context?.close();
    await browser.close();
  }
}

function assertCaptureProvisionBinding(
  provisionControllerReceipt: Readonly<{
    schemaVersion: string;
    taskId: string;
    roomReceiptDigest: string;
    storageStateDigest: string;
    harnessRuntimeProvenance: z.infer<typeof qualificationV2HarnessRuntimeProvenanceSchema>;
    productionBindingDigest?: string;
    baselineFreezeDigest?: string;
  }>,
  roomReceipt: Readonly<{ taskId: string; receiptDigest: string }>,
  storageStateDigest: string,
  harnessRuntimeProvenance: z.infer<typeof qualificationV2HarnessRuntimeProvenanceSchema>,
): void {
  if (provisionControllerReceipt.schemaVersion !== "exp-0001a-qualification-room-controller-provision/v3"
      || provisionControllerReceipt.productionBindingDigest !== productionBindingJson.bindingDigest
      || provisionControllerReceipt.baselineFreezeDigest !== baselineReceiptJson.receiptDigest
      || provisionControllerReceipt.taskId !== roomReceipt.taskId
      || provisionControllerReceipt.roomReceiptDigest !== roomReceipt.receiptDigest
      || provisionControllerReceipt.storageStateDigest !== storageStateDigest
      || hashCanonicalJson(provisionControllerReceipt.harnessRuntimeProvenance as unknown as JsonValue)
        !== hashCanonicalJson(harnessRuntimeProvenance as unknown as JsonValue)) {
    throw new Error("QUALIFICATION_V2_CAPTURE_PROVISION_BINDING_MISMATCH");
  }
}

async function captureAuthorEvidence(
  request: Extract<z.infer<typeof controllerRequestSchema>, { operation: "capture_author_evidence" }>,
  harnessRuntimeProvenance: z.infer<typeof qualificationV2HarnessRuntimeProvenanceSchema>,
) {
  const roomReceipt = qualificationV2RoomReceiptSchema.parse(
    await readPrivateJson(request.roomReceiptPath, "Qualification room receipt"),
  );
  const provisionControllerReceipt = parseQualificationV2ProvisionControllerReceipt(
    await readPrivateJson(request.provisionControllerReceiptPath, "Qualification provision-controller receipt"),
  );
  const storageState = z.object({ cookies: z.array(z.unknown()).min(1), origins: z.array(z.unknown()) }).passthrough().parse(
    await readPrivateJson(request.storageStatePath, "Qualification authorized storage state"),
  ) as unknown as BrowserStorageState;
  const storageStateDigest = hashCanonicalJson(storageState as unknown as JsonValue);
  const captureAuthorization = parseQualificationV2CaptureAuthorization(request.captureAuthorization);
  assertCaptureProvisionBinding(
    provisionControllerReceipt,
    roomReceipt,
    storageStateDigest,
    harnessRuntimeProvenance,
  );
  if (captureAuthorization.taskId !== roomReceipt.taskId
      || captureAuthorization.roomReceiptDigest !== roomReceipt.receiptDigest
      || captureAuthorization.provisionControllerReceiptDigest !== provisionControllerReceipt.receiptDigest
      || captureAuthorization.storageStateDigest !== storageStateDigest) {
    throw new Error("QUALIFICATION_V2_CAPTURE_AUTHORIZATION_EVIDENCE_BINDING_INVALID");
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browserContext(browser, storageState);
    const page = await context.newPage();
    const roomResponse = await page.goto(
      `${BASE_URL}/room/${encodeURIComponent(roomReceipt.roomId)}`,
      { waitUntil: "domcontentloaded" },
    );
    const deploymentId = await assertFrozenDeployment(roomResponse);
    const participantTools = await waitForFrozenToolContract(
      page,
      baselineInventoryJson.participant,
      "PARTICIPANT",
    );
    const before = await executeTool(page, "read_room_state", {});
    const beforeState = roomStateData(before);
    const roomRevision = beforeState.room.roomRevision;
    const self = beforeState.participants.find(
      (participant) => participant.participantId === beforeState.room.selfParticipantId,
    );
    if (beforeState.room.id !== roomReceipt.roomId || !Number.isSafeInteger(roomRevision) || Number(roomRevision) < 1
        || beforeState.objects.length === 0 || self?.role !== "participant") {
      throw new Error("QUALIFICATION_V2_CLOSING_ROOM_STATE_INVALID");
    }
    const scope = exactObjectScope(beforeState.objects);
    const inspection = await executeTool(page, "inspect_canvas_scope", { scope, representation: "overview" });
    const inspectionData = successfulTool(inspection, "inspect_canvas_scope");
    assertExactInspectionSceneContext(inspectionData, scope.targets, Number(roomRevision));
    const downloadPromise = page.waitForEvent("download", {
      timeout: QUALIFICATION_V2_PNG_EXPORT_TIMEOUT_MS,
    });
    const pngPromise = executeTool(page, "export_canvas_png", {
      scope,
      filename: `qualification-${roomReceipt.taskId}`,
    }, QUALIFICATION_V2_PNG_EXPORT_TIMEOUT_MS);
    const [download, pngResult] = await Promise.all([downloadPromise, pngPromise]);
    const pngBytes = await readDownload(download);
    assertQualificationV2PngStructure(pngBytes);
    const dimensions = pngDimensions(pngBytes);
    const pngData = successfulTool(pngResult, "export_canvas_png");
    const pngRevisions = pngData.sourceRevisions;
    if (pngRevisions === null || Array.isArray(pngRevisions) || typeof pngRevisions !== "object"
        || (pngRevisions as Record<string, unknown>).roomRevision !== roomRevision
        || (pngRevisions as Record<string, unknown>).kind !== "objects"
        || pngData.mimeType !== "image/png" || pngData.persistedByJazzboard !== false
        || pngData.byteLength !== pngBytes.length
        || pngData.width !== dimensions.width
        || pngData.height !== dimensions.height
        || download.suggestedFilename() !== pngData.filename) {
      throw new Error("QUALIFICATION_V2_PNG_REVISION_OR_BYTES_MISMATCH");
    }
    const pngRevisionRecord = pngRevisions as Record<string, unknown>;
    const pngScope = pngRevisionRecord.targets;
    if (canonicalJson(pngScope as JsonValue) !== canonicalJson(scope.targets as unknown as JsonValue)) {
      throw new Error("QUALIFICATION_V2_PNG_SCOPE_ECHO_MISMATCH");
    }
    assertExactRevisionList(pngRevisionRecord.objectRevisions, scope.targets, "PNG_TARGET");
    assertExactRevisionList(pngRevisionRecord.visualContributorRevisions, scope.targets, "PNG_CONTRIBUTOR");
    const closing = await executeTool(page, "read_room_state", {});
    const closingState = roomStateData(closing);
    if (closingState.room.id !== roomReceipt.roomId || closingState.room.roomRevision !== roomRevision
        || canonicalJson(sortedRecords(closingState.objects) as unknown as JsonValue)
          !== canonicalJson(sortedRecords(beforeState.objects) as unknown as JsonValue)
        || canonicalJson(sortedRecords(closingState.diagrams) as unknown as JsonValue)
          !== canonicalJson(sortedRecords(beforeState.diagrams) as unknown as JsonValue)) {
      throw new Error("QUALIFICATION_V2_ROOM_CHANGED_DURING_EVIDENCE_CAPTURE");
    }
    const closingDeploymentId = await reobserveFrozenDeployment(context);
    const closingCallResult = asCallToolResult(closing);
    const inspectionCallResult = asCallToolResult(inspection);
    const pngCallResult = asCallToolResult(pngResult, pngBytes);
    await writeExclusiveJson(path.join(request.outputDirectory, "closing-read-room-state-call-result.json"), closingCallResult);
    await writeExclusiveJson(path.join(request.outputDirectory, "closing-inspect-canvas-scope-call-result.json"), inspectionCallResult);
    await writeExclusiveJson(path.join(request.outputDirectory, "closing-export-canvas-png-call-result.json"), pngCallResult);
    await writeExclusive(path.join(request.outputDirectory, "closing-exact-revision.png"), pngBytes);
    const content = qualificationV3CaptureControllerReceiptContentSchema.parse({
      schemaVersion: "exp-0001a-qualification-room-controller-capture/v3",
      taskId: roomReceipt.taskId,
      roomReceiptDigest: roomReceipt.receiptDigest,
      provisionControllerReceiptDigest: provisionControllerReceipt.receiptDigest,
      storageStateDigest,
      productionBindingDigest: productionBindingJson.bindingDigest,
      baselineFreezeDigest: baselineReceiptJson.receiptDigest,
      deploymentId,
      deploymentObservations: [deploymentId, closingDeploymentId],
      participantToolContractDigest: participantTools.contractDigest,
      playwrightVersion: PLAYWRIGHT_VERSION,
      chromiumVersion: browser.version(),
      runtime: { node: process.version, platform: process.platform, architecture: process.arch },
      harnessRuntimeProvenance,
      roomRevision,
      objectCount: closingState.objects.length,
      diagramCount: closingState.diagrams.length,
      closingReadCallResultDigest: hashCanonicalJson(closingCallResult as unknown as JsonValue),
      inspectionCallResultDigest: hashCanonicalJson(inspectionCallResult as unknown as JsonValue),
      pngCallResultDigest: hashCanonicalJson(pngCallResult as unknown as JsonValue),
      pngByteDigest: sha256Digest(pngBytes),
      pngByteLength: pngBytes.length,
      persistedByJazzboard: false,
      retainedAt: request.at,
    });
    const controllerReceipt = sealQualificationV3CaptureControllerReceipt(content);
    await writeExclusiveJson(path.join(request.outputDirectory, "capture-controller-receipt.json"), controllerReceipt);
    return { controllerReceipt };
  } finally {
    await context?.close();
    await browser.close();
  }
}

function assertCaptureDispatchBinding(
  captureAuthorization: ReturnType<typeof parseQualificationV2CaptureAuthorization>,
  captureReleaseJournal: ReturnType<typeof parseQualificationV2CaptureReleaseJournal>,
  requestBasis: Record<string, unknown>,
) {
  if (canonicalJson(captureAuthorization.request) !== canonicalJson(requestBasis)
      || captureAuthorization.requestBindingDigest
        !== hashCanonicalJson(requestBasis as unknown as JsonValue)
      || captureReleaseJournal.captureActionDigest !== captureAuthorization.actionDigest
      || captureReleaseJournal.captureNonce !== captureAuthorization.captureNonce
      || captureReleaseJournal.requestBindingDigest !== captureAuthorization.requestBindingDigest
      || captureReleaseJournal.invocationOrdinal !== 1
      || captureReleaseJournal.retryPermitted !== false) {
    throw new Error("QUALIFICATION_V2_CAPTURE_AUTHORIZATION_REQUEST_BINDING_INVALID");
  }
}

export async function runQualificationV2RoomControllerCli(
  argv: readonly string[],
  io: { stdout: Pick<NodeJS.WriteStream, "write">; stderr: Pick<NodeJS.WriteStream, "write"> },
  repositoryRoot: string,
  rawHarnessRuntimeProvenance: unknown,
) {
  let incidentDirectory: string | null = null;
  let incidentOperation: string | null = null;
  let captureAuthorization: ReturnType<typeof parseQualificationV2CaptureAuthorization> | null = null;
  let captureReleaseJournal: ReturnType<typeof parseQualificationV2CaptureReleaseJournal> | null = null;
  let captureRetainedAt: string | null = null;
  try {
    if (argv.length !== 2 || argv[0] !== "--request") {
      throw new Error("Usage: --request /absolute/private-request.json");
    }
    const requestPath = absolutePathSchema.parse(argv[1]);
    const harnessRuntimeProvenance = qualificationV2HarnessRuntimeProvenanceSchema.parse(rawHarnessRuntimeProvenance);
    const qualificationPrivateRoot = (await assertPrivatePath(repositoryRoot, requestPath)).privateRoot;
    if (path.basename(qualificationPrivateRoot) !== "exp0001a-qualification-v3") {
      throw new Error("QUALIFICATION_V3_ROOM_CONTROLLER_PRIVATE_ROOT_REQUIRED");
    }
    const request = controllerRequestSchema.parse(await readPrivateJson(requestPath, "Room-controller request"));
    incidentOperation = request.operation;
    if (request.operation === "capture_author_evidence") {
      captureAuthorization = parseQualificationV2CaptureAuthorization(request.captureAuthorization);
      captureReleaseJournal = parseQualificationV2CaptureReleaseJournal(request.captureReleaseJournal);
      const {
        captureAuthorization: _captureAuthorization,
        captureReleaseJournal: _captureReleaseJournal,
        ...requestBasis
      } = request;
      void _captureAuthorization;
      void _captureReleaseJournal;
      assertCaptureDispatchBinding(captureAuthorization, captureReleaseJournal, requestBasis);
      captureRetainedAt = captureReleaseJournal.invokedAt;
    }
    await assertPrivatePath(repositoryRoot, request.outputDirectory, true, qualificationPrivateRoot);
    const existing = await lstat(request.outputDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing !== null) throw new Error("QUALIFICATION_V2_ROOM_CONTROLLER_OUTPUT_EXISTS");
    await mkdir(request.outputDirectory, { mode: 0o700 });
    incidentDirectory = request.outputDirectory;
    const createdOutputDirectory = await realpath(request.outputDirectory);
    const expectedOutputDirectory = path.join(await realpath(path.dirname(request.outputDirectory)), path.basename(request.outputDirectory));
    if (createdOutputDirectory !== expectedOutputDirectory) {
      throw new Error("QUALIFICATION_V2_ROOM_CONTROLLER_OUTPUT_PATH_CHANGED");
    }
    if (request.operation === "capture_author_evidence") {
      if (captureAuthorization === null || captureReleaseJournal === null) {
        throw new Error("QUALIFICATION_V2_CAPTURE_DISPATCH_ACKNOWLEDGEMENT_MISSING");
      }
      await writeExclusiveJson(
        path.join(request.outputDirectory, "capture-release-journal.json"),
        captureReleaseJournal,
      );
    }
    if (request.operation === "provision_room") {
      const result = await provisionRoom(request, harnessRuntimeProvenance);
      io.stdout.write(`${canonicalJson({
        status: "room_provisioned",
        taskId: request.taskId,
        roomReceiptDigest: result.receipt.receiptDigest,
        controllerReceiptDigest: result.controllerReceipt.receiptDigest,
      })}\n`);
    } else {
      await assertPrivatePath(repositoryRoot, request.roomReceiptPath, false, qualificationPrivateRoot);
      await assertPrivatePath(repositoryRoot, request.provisionControllerReceiptPath, false, qualificationPrivateRoot);
      await assertPrivatePath(repositoryRoot, request.storageStatePath, false, qualificationPrivateRoot);
      const result = await captureAuthorEvidence(request, harnessRuntimeProvenance);
      if (captureAuthorization === null || captureReleaseJournal === null) {
        throw new Error("QUALIFICATION_V2_CAPTURE_RELEASE_JOURNAL_MISSING");
      }
      const terminalReceipt = sealQualificationV2CaptureTerminalReceipt({
        schemaVersion: "exp-0001a-qualification-capture-terminal/v2",
        taskId: result.controllerReceipt.taskId,
        captureActionDigest: captureAuthorization.actionDigest,
        captureNonce: captureAuthorization.captureNonce,
        requestBindingDigest: captureAuthorization.requestBindingDigest,
        releaseJournalDigest: captureReleaseJournal.journalDigest,
        outcome: "succeeded",
        captureControllerReceiptDigest: result.controllerReceipt.receiptDigest,
        failureCode: null,
        retainedAt: captureRetainedAt ?? request.at,
      });
      await writeExclusiveJson(
        path.join(request.outputDirectory, "capture-terminal-receipt.json"),
        terminalReceipt,
      );
      io.stdout.write(`${canonicalJson({
        status: "author_evidence_captured",
        taskId: result.controllerReceipt.taskId,
        roomRevision: result.controllerReceipt.roomRevision,
        captureReceiptDigest: result.controllerReceipt.receiptDigest,
        pngByteDigest: result.controllerReceipt.pngByteDigest,
      })}\n`);
    }
    return 0;
  } catch (error) {
    if (incidentDirectory !== null && captureAuthorization !== null
        && captureReleaseJournal !== null && captureRetainedAt !== null) {
      const terminalReceipt = sealQualificationV2CaptureTerminalReceipt({
        schemaVersion: "exp-0001a-qualification-capture-terminal/v2",
        taskId: captureAuthorization.taskId,
        captureActionDigest: captureAuthorization.actionDigest,
        captureNonce: captureAuthorization.captureNonce,
        requestBindingDigest: captureAuthorization.requestBindingDigest,
        releaseJournalDigest: captureReleaseJournal.journalDigest,
        outcome: "failed",
        captureControllerReceiptDigest: null,
        failureCode: "QUALIFICATION_V2_CAPTURE_FAILED",
        retainedAt: captureRetainedAt,
      });
      await writeExclusiveJson(
        path.join(incidentDirectory, "capture-terminal-receipt.json"),
        terminalReceipt,
      ).catch(() => undefined);
    }
    if (incidentDirectory !== null) {
      const detail = {
        schemaVersion: "exp-0001a-qualification-room-controller-incident/v2",
        operation: incidentOperation,
        occurredAt: new Date().toISOString(),
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : "Unknown room-controller failure.",
        errorStackDigest: error instanceof Error && typeof error.stack === "string"
          ? sha256Digest(error.stack)
          : null,
      };
      await writeExclusiveJson(path.join(incidentDirectory, "room-controller-incident.json"), {
        ...detail,
        incidentDigest: hashCanonicalJson(detail as unknown as JsonValue),
      }).catch(() => undefined);
    }
    io.stderr.write(`${canonicalJson({
      status: "error",
      errorCode: "QUALIFICATION_V2_ROOM_CONTROLLER_OPERATION_FAILED",
    })}\n`);
    return 1;
  }
}

export const qualificationV2RoomControllerInternalsForTesting = Object.freeze({
  timeouts: Object.freeze({
    defaultWebMcpMs: QUALIFICATION_V2_DEFAULT_WEBMCP_TIMEOUT_MS,
    pngExportMs: QUALIFICATION_V2_PNG_EXPORT_TIMEOUT_MS,
  }),
  asCallToolResult,
  roomStateData,
  exactObjectScope,
  assertExactRevisionList,
  assertExactInspectionSceneContext,
  stableFNV1aDigest,
  verifyCompiledFixture,
  assertCaptureProvisionBinding,
  assertCaptureDispatchBinding,
  toolContract,
  assertFrozenToolContract,
});
