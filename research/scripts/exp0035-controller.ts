import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { RoomState } from "@/lib/domain/types";
import { createJazzboardSemanticWebMcpTools } from "@/lib/webmcp/semantic-tools";
import type { JazzboardToolResult, JazzboardWebMcpBinding, WebMcpRequest } from "@/lib/webmcp/types";

import {
  createExp0035ContextFixture,
  gradeExp0035ContextFixture,
} from "./exp0035-context-fixture.mjs";
import { summarizeExp0035Session } from "./exp0035-session-metrics.mjs";

const REPOSITORY_ROOT = process.env.EXP0035_REPOSITORY_ROOT
  ? path.resolve(process.env.EXP0035_REPOSITORY_ROOT)
  : path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PRIVATE_ROOT = "/private/tmp/exp0035";
const CLIENT_CAPABILITIES = "split-state-v1";
const BASELINE_COMMIT = "f7762da4ea7d1603671a35b4912143c4bff83f34";
const CANDIDATE_COMMIT = "55ed2446fa0b8b91c9602d50881ebc38a61d3514";

type Family = "inventory" | "repair";
type Arm = "A0" | "A1";

type Assignment = {
  attemptId: string;
  pairId: string;
  family: Family;
  seed: string;
  arm: Arm;
  origin: string;
  commit: string;
};

const SCHEDULE: Assignment[] = [
  { attemptId: "attempt01", pairId: "pair01", family: "inventory", seed: "20260904-inventory-1", arm: "A0", origin: "http://127.0.0.1:3101", commit: BASELINE_COMMIT },
  { attemptId: "attempt02", pairId: "pair01", family: "inventory", seed: "20260904-inventory-1", arm: "A1", origin: "http://127.0.0.1:3102", commit: CANDIDATE_COMMIT },
  { attemptId: "attempt03", pairId: "pair02", family: "repair", seed: "20260904-repair-1", arm: "A1", origin: "http://127.0.0.1:3102", commit: CANDIDATE_COMMIT },
  { attemptId: "attempt04", pairId: "pair02", family: "repair", seed: "20260904-repair-1", arm: "A0", origin: "http://127.0.0.1:3101", commit: BASELINE_COMMIT },
  { attemptId: "attempt05", pairId: "pair03", family: "inventory", seed: "20260904-inventory-2", arm: "A1", origin: "http://127.0.0.1:3102", commit: CANDIDATE_COMMIT },
  { attemptId: "attempt06", pairId: "pair03", family: "inventory", seed: "20260904-inventory-2", arm: "A0", origin: "http://127.0.0.1:3101", commit: BASELINE_COMMIT },
  { attemptId: "attempt07", pairId: "pair04", family: "repair", seed: "20260904-repair-2", arm: "A0", origin: "http://127.0.0.1:3101", commit: BASELINE_COMMIT },
  { attemptId: "attempt08", pairId: "pair04", family: "repair", seed: "20260904-repair-2", arm: "A1", origin: "http://127.0.0.1:3102", commit: CANDIDATE_COMMIT },
];

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function saveJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

class CookieRequest {
  private cookie = "";

  constructor(readonly origin: string) {}

  private captureCookie(response: Response): void {
    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) return;
    const first = setCookie.split(";")[0];
    assert(first.includes("="), "Malformed Set-Cookie response.");
    this.cookie = first;
  }

  setCookie(cookie: string): void {
    this.cookie = cookie;
  }

  getCookie(): string {
    return this.cookie;
  }

  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("x-jazzboard-client-capabilities", CLIENT_CAPABILITIES);
    if (this.cookie) headers.set("cookie", this.cookie);
    if (init.body) headers.set("content-type", "application/json");
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") headers.set("idempotency-key", randomUUID());
    const response = await fetch(new URL(url, this.origin), { ...init, headers, cache: "no-store" });
    this.captureCookie(response);
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${url} returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    if (!response.ok || (data as { ok?: boolean }).ok === false) {
      throw new Error(`${method} ${url} failed HTTP ${response.status}: ${JSON.stringify(data)}`);
    }
    return data as T;
  }
}

function counts(room: RoomState): Record<string, number> {
  return Object.values(room.objects).reduce<Record<string, number>>((result, object) => {
    result[object.kind] = (result[object.kind] ?? 0) + 1;
    return result;
  }, {});
}

function qualifyingTargets(room: RoomState) {
  return Object.values(room.objects).filter((object) => object.kind === "shape"
    && object.nodeType === "open_question"
    && object.nodeMetadata?.kind === "open_question"
    && object.nodeMetadata.status === "open"
    && object.nodeMetadata.owner === "Mira");
}

function verifyBeforeRoom(family: Family, room: RoomState): Record<string, unknown> {
  const objectCounts = counts(room);
  if (family === "inventory") {
    assert(Object.keys(room.objects).length === 360, "Inventory fixture object cardinality mismatch.");
    assert(canonical(objectCounts) === canonical({ shape: 180, text: 90, path: 90 }), "Inventory kind counts mismatch.");
    assert(Object.keys(room.diagrams ?? {}).length === 6, "Inventory Diagram cardinality mismatch.");
    assert(qualifyingTargets(room).length === 8, "Inventory Mira open-question cardinality mismatch.");
  } else {
    assert(Object.keys(room.objects).length === 240, "Repair fixture object cardinality mismatch.");
    assert(canonical(objectCounts) === canonical({ shape: 120, text: 60, path: 60 }), "Repair kind counts mismatch.");
    assert(Object.keys(room.diagrams ?? {}).length === 0, "Repair fixture unexpectedly contains Diagrams.");
    assert(qualifyingTargets(room).length === 12, "Repair target cardinality mismatch.");
  }
  assert(new Set(Object.values(room.objects).map((object) => object.semanticName)).size === Object.keys(room.objects).length,
    "Fixture semantic names are not unique.");
  return {
    roomRevision: room.roomRevision,
    objectCount: Object.keys(room.objects).length,
    objectCounts,
    diagramCount: Object.keys(room.diagrams ?? {}).length,
    qualifyingMiraOpenQuestionCount: qualifyingTargets(room).length,
  };
}

async function provision(assignment: Assignment) {
  const fixture = createExp0035ContextFixture({ family: assignment.family, seed: assignment.seed });
  const transport = new CookieRequest(assignment.origin);
  const created = await transport.request<{ ok: true; participantId: string; room: RoomState }>("/api/rooms", {
    method: "POST",
    body: JSON.stringify({
      action: "create",
      displayName: "EXP-0035 Controller",
      title: `EXP-0035 ${assignment.attemptId} ${assignment.family}`,
    }),
  });
  let room = created.room;
  let idSequence = 0;
  const request = transport.request.bind(transport) as WebMcpRequest;
  const binding: JazzboardWebMcpBinding = {
    roomId: room.id,
    participantId: created.participantId,
    role: "participant",
    context: {
      getRoom: () => room,
      getSelection: () => [],
      getViewport: () => null,
      getFollowTarget: () => null,
      acceptRoom: (next) => { room = next; },
      setFollowTarget: () => {},
      setDeclinedSpotlight: () => {},
      leaveRoomView: () => {},
    },
  };
  const tool = createJazzboardSemanticWebMcpTools(binding, {
    request,
    createId: (prefix) => `${prefix}_e35_${assignment.attemptId.slice(-2)}_${++idSequence}`,
  }).find((candidate) => candidate.name === "apply_canvas_transaction");
  assert(tool, "Registered apply_canvas_transaction tool is missing.");
  const transactionReceipts: unknown[] = [];
  for (const transaction of fixture.provisioning.transactions) {
    const result = await tool.execute(transaction, { signal: new AbortController().signal }) as JazzboardToolResult;
    assert(result.ok, `Fixture transaction failed: ${JSON.stringify(result)}`);
    transactionReceipts.push(result);
  }
  const authoritative = await transport.request<{ ok: true; participantId: string; room: RoomState }>(
    `/api/rooms/${encodeURIComponent(room.id)}`,
    { method: "GET" },
  );
  room = authoritative.room;
  const cardinality = verifyBeforeRoom(assignment.family, room);
  const evidence = {
    schemaVersion: "jazzboard-exp0035-controller-evidence/v1",
    provisionedAt: new Date().toISOString(),
    assignment,
    controllerParticipantId: created.participantId,
    cookie: transport.getCookie(),
    roomCode: room.code,
    fixture,
    transactionReceipts,
    beforeRoom: room,
    cardinality,
  };
  const evidencePath = path.join(PRIVATE_ROOT, `${assignment.attemptId}.private.json`);
  await saveJson(evidencePath, evidence);
  const evidenceBytes = await readFile(evidencePath);
  return {
    ...assignment,
    roomId: room.id,
    roomCode: room.code,
    roomUrl: `${assignment.origin}/room/${encodeURIComponent(room.id)}`,
    publicBrief: fixture.public.brief,
    fixtureDigest: sha256(canonical(fixture)),
    beforeRoomDigest: sha256(canonical(room)),
    privateEvidenceDigest: sha256(evidenceBytes),
    cardinality,
  };
}

async function provisionAll(): Promise<void> {
  await mkdir(PRIVATE_ROOT, { recursive: true, mode: 0o700 });
  const protocolPath = path.join(REPOSITORY_ROOT, "research/protocols/exp-0035-context-recovery.md");
  const fixturePath = path.join(REPOSITORY_ROOT, "research/scripts/exp0035-context-fixture.mjs");
  const authorPacketPath = path.join(REPOSITORY_ROOT, "research/scripts/exp0035-author-packet.mjs");
  const protocolBytes = await readFile(protocolPath);
  const fixtureBytes = await readFile(fixturePath);
  const authorPacketBytes = await readFile(authorPacketPath);
  const attempts = [];
  for (const assignment of SCHEDULE) {
    const attempt = await provision(assignment);
    attempts.push(attempt);
    process.stdout.write(`${assignment.attemptId} ready ${attempt.arm} ${attempt.family} ${attempt.origin} ${attempt.roomCode}\n`);
  }
  const manifest = {
    schemaVersion: "jazzboard-exp0035-run-manifest/v1",
    protocolId: "EXP-0035",
    frozenAt: new Date().toISOString(),
    controllerMode: "authenticated_localhost_api_via_registered_semantic_tool_binding",
    protocolDigest: sha256(protocolBytes),
    fixtureSourceDigest: sha256(fixtureBytes),
    authorPacketSourceDigest: sha256(authorPacketBytes),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    productConditions: {
      A0: { commit: BASELINE_COMMIT, origin: "http://127.0.0.1:3101" },
      A1: { commit: CANDIDATE_COMMIT, origin: "http://127.0.0.1:3102" },
    },
    attemptCount: attempts.length,
    attempts,
  };
  await saveJson(path.join(PRIVATE_ROOT, "manifest.sanitized.json"), manifest);
  process.stdout.write(`${path.join(PRIVATE_ROOT, "manifest.sanitized.json")}\n`);
}

async function snapshot(attemptId: string): Promise<void> {
  assert(/^attempt0[1-8]$/.test(attemptId), "Snapshot requires attempt01 through attempt08.");
  const evidencePath = path.join(PRIVATE_ROOT, `${attemptId}.private.json`);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
    assignment: Assignment;
    cookie: string;
    beforeRoom: RoomState;
  };
  const transport = new CookieRequest(evidence.assignment.origin);
  transport.setCookie(evidence.cookie);
  const response = await transport.request<{ ok: true; participantId: string; room: RoomState }>(
    `/api/rooms/${encodeURIComponent(evidence.beforeRoom.id)}`,
    { method: "GET" },
  );
  const outputPath = path.join(PRIVATE_ROOT, `${attemptId}.after.json`);
  await saveJson(outputPath, response.room);
  process.stdout.write(`${outputPath} ${sha256(canonical(response.room))}\n`);
}

function releaseThreadId(raw: string): string | null {
  const release = JSON.parse(raw) as {
    content?: Array<{ type?: string; text?: string }>;
    threadId?: string;
  };
  if (typeof release.threadId === "string") return release.threadId;
  for (const item of release.content ?? []) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    try {
      const embedded = JSON.parse(item.text) as { threadId?: string };
      if (typeof embedded.threadId === "string") return embedded.threadId;
    } catch {
      // A non-JSON text block cannot establish the released task identity.
    }
  }
  return null;
}

async function grade(attemptId: string): Promise<void> {
  assert(/^attempt0[1-8]$/.test(attemptId), "Grade requires attempt01 through attempt08.");
  const evidencePath = path.join(PRIVATE_ROOT, `${attemptId}.private.json`);
  const afterPath = path.join(PRIVATE_ROOT, `${attemptId}.after.json`);
  const sessionPath = path.join(PRIVATE_ROOT, `${attemptId}.session.jsonl`);
  const releasePath = path.join(PRIVATE_ROOT, `${attemptId}.release.json`);
  const manifestPath = path.join(PRIVATE_ROOT, "manifest.sanitized.json");
  const fixtureSourcePath = path.join(REPOSITORY_ROOT, "research/scripts/exp0035-context-fixture.mjs");
  const metricsSourcePath = path.join(REPOSITORY_ROOT, "research/scripts/exp0035-session-metrics.mjs");

  const [
    evidenceBytes,
    afterBytes,
    sessionBytes,
    releaseBytes,
    manifestBytes,
    fixtureSourceBytes,
    metricsSourceBytes,
  ] = await Promise.all([
    readFile(evidencePath),
    readFile(afterPath),
    readFile(sessionPath),
    readFile(releasePath),
    readFile(manifestPath),
    readFile(fixtureSourcePath),
    readFile(metricsSourcePath),
  ]);
  const evidence = JSON.parse(evidenceBytes.toString("utf8")) as {
    assignment: Assignment;
    beforeRoom: RoomState;
  };
  const afterRoom = JSON.parse(afterBytes.toString("utf8")) as RoomState;
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    fixtureSourceDigest: string;
    attempts: Array<Assignment & {
      roomId: string;
      beforeRoomDigest: string;
      privateEvidenceDigest: string;
    }>;
  };
  const manifestAttempt = manifest.attempts.find((attempt) => attempt.attemptId === attemptId);
  assert(manifestAttempt, `Frozen manifest does not contain ${attemptId}.`);
  assert(manifest.fixtureSourceDigest === sha256(fixtureSourceBytes), "Frozen scorer source digest does not match the current fixture/scorer source.");
  assert(manifestAttempt.privateEvidenceDigest === sha256(evidenceBytes), `${attemptId} private evidence digest does not match the frozen manifest.`);
  assert(manifestAttempt.beforeRoomDigest === sha256(canonical(evidence.beforeRoom)), `${attemptId} before-room digest does not match the frozen manifest.`);
  assert(canonical({
    attemptId: evidence.assignment.attemptId,
    pairId: evidence.assignment.pairId,
    family: evidence.assignment.family,
    seed: evidence.assignment.seed,
    arm: evidence.assignment.arm,
    origin: evidence.assignment.origin,
    commit: evidence.assignment.commit,
  }) === canonical({
    attemptId: manifestAttempt.attemptId,
    pairId: manifestAttempt.pairId,
    family: manifestAttempt.family,
    seed: manifestAttempt.seed,
    arm: manifestAttempt.arm,
    origin: manifestAttempt.origin,
    commit: manifestAttempt.commit,
  }), `${attemptId} assignment does not match the frozen manifest.`);
  assert(evidence.beforeRoom.id === manifestAttempt.roomId, `${attemptId} before-room ID does not match the frozen manifest.`);
  assert(afterRoom.id === evidence.beforeRoom.id, `${attemptId} after snapshot is for a different room.`);

  const threadId = releaseThreadId(releaseBytes.toString("utf8"));
  assert(threadId, `${attemptId} release receipt does not contain a task thread ID.`);
  const metrics = summarizeExp0035Session(sessionBytes.toString("utf8"), {
    attemptId,
    threadId,
  }) as {
    schemaVersion: string;
    status: string;
    threadId: string | null;
    turnId: string | null;
    finalText: { status: string; source: string | null; utf8Bytes: number | null; text: string | null };
    timing: { totalWallMs: number; hostExecutionMs: number };
    hostCalls: { completedCount: number; failedCount: number };
    webMcp: {
      nativeMetadata?: {
        status: string;
        observedEntryCount: number;
        completeOutputCount: number;
        completeOutputUtf8Bytes: number;
        truncatedInputCount: number;
        truncatedOutputCount: number;
      };
      readOutput: { status: string; observedHostCallCount: number; observedUtf8Bytes: number | null };
    };
  };
  const semanticGrade = gradeExp0035ContextFixture({
    family: evidence.assignment.family,
    beforeRoom: evidence.beforeRoom,
    afterRoom,
    finalAnswer: metrics.finalText.status === "observed" ? metrics.finalText.text : undefined,
  });
  const metricsPath = path.join(PRIVATE_ROOT, `${attemptId}.metrics.json`);
  await saveJson(metricsPath, metrics);
  const metricsBytes = await readFile(metricsPath);
  const result = {
    schemaVersion: "jazzboard-exp0035-attempt-grade/v1",
    attempt: {
      attemptId,
      pairId: evidence.assignment.pairId,
      family: evidence.assignment.family,
      seed: evidence.assignment.seed,
      arm: evidence.assignment.arm,
      commit: evidence.assignment.commit,
      threadId,
      turnId: metrics.turnId,
    },
    inputDigests: {
      frozenManifestFile: sha256(manifestBytes),
      privateEvidenceFile: sha256(evidenceBytes),
      beforeRoomCanonical: sha256(canonical(evidence.beforeRoom)),
      afterSnapshotFile: sha256(afterBytes),
      afterRoomCanonical: sha256(canonical(afterRoom)),
      sessionTraceFile: sha256(sessionBytes),
      releaseReceiptFile: sha256(releaseBytes),
      scorerSourceFile: sha256(fixtureSourceBytes),
      metricsParserSourceFile: sha256(metricsSourceBytes),
      metricsFile: sha256(metricsBytes),
    },
    metrics,
    semanticGrade,
  };
  const gradePath = path.join(PRIVATE_ROOT, `${attemptId}.grade.json`);
  await saveJson(gradePath, result);
  process.stdout.write(`${JSON.stringify({
    attemptId,
    arm: evidence.assignment.arm,
    family: evidence.assignment.family,
    taskStatus: metrics.status,
    semanticPassed: semanticGrade.passed,
    failedCheckCount: semanticGrade.failedCheckCount,
    finalTextStatus: metrics.finalText.status,
    totalWallMs: metrics.timing.totalWallMs,
    hostCallCount: metrics.hostCalls.completedCount,
    failedHostCallCount: metrics.hostCalls.failedCount,
    observedReadOutputStatus: metrics.webMcp.readOutput.status,
    observedReadOutputUtf8Bytes: metrics.webMcp.readOutput.observedUtf8Bytes,
    nativeMetadataStatus: metrics.webMcp.nativeMetadata?.status ?? "unavailable",
    nativeObservedEntryCount: metrics.webMcp.nativeMetadata?.observedEntryCount ?? 0,
    nativeCompleteOutputCount: metrics.webMcp.nativeMetadata?.completeOutputCount ?? 0,
    nativeCompleteOutputUtf8Bytes: metrics.webMcp.nativeMetadata?.completeOutputUtf8Bytes ?? null,
    nativeTruncatedOutputCount: metrics.webMcp.nativeMetadata?.truncatedOutputCount ?? 0,
    gradePath,
    gradeFileDigest: sha256(await readFile(gradePath)),
  })}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "provision";
  if (command === "provision") return provisionAll();
  if (command === "snapshot") return snapshot(process.argv[3] ?? "");
  if (command === "grade") return grade(process.argv[3] ?? "");
  throw new Error("Usage: exp0035-controller.mjs [provision | snapshot attempt01 | grade attempt01]");
}

await main();
