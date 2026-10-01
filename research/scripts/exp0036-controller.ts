import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { RoomState } from "@/lib/domain/types";
import { createJazzboardSemanticWebMcpTools } from "@/lib/webmcp/semantic-tools";
import type { JazzboardToolResult, JazzboardWebMcpBinding, WebMcpRequest } from "@/lib/webmcp/types";

import {
  createExp0036FrozenPacketBundle,
  createExp0036ProvisioningFixture,
  gradeExp0036ContextFixture,
  sanitizeExp0036FinalState,
} from "./exp0036-frozen-packet.mjs";

const CLIENT_CAPABILITIES = "split-state-v1";
const USAGE = "Usage: exp0036-controller.mjs provision|snapshot|grade --attempt attempt01 --origin http://127.0.0.1:PORT --output /absolute/output [--author-origin http://UNIQUE.localhost:PORT] [--final-answer-file /absolute/answer.txt]";

type Command = "provision" | "snapshot" | "grade";
type Args = {
  command: Command;
  attemptId: string;
  origin: string;
  output: string;
  authorOrigin?: string;
  finalAnswerFile?: string;
};
type FrozenAssignment = {
  ordinal: number;
  attemptId: string;
  pairId: string;
  taskId: string;
  arm: "A0" | "A1";
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

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

function parseArgs(argv: string[]): Args {
  const command = argv[0] as Command;
  assert(["provision", "snapshot", "grade"].includes(command), USAGE);
  const values: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    assert(flag?.startsWith("--") && value !== undefined, USAGE);
    values[flag.slice(2)] = value;
  }
  assert(/^attempt0[1-8]$/.test(values.attempt ?? ""), USAGE);
  const parsedOrigin = new URL(values.origin ?? "invalid:");
  assert(parsedOrigin.protocol === "http:" && parsedOrigin.origin === values.origin
    && ["127.0.0.1", "localhost"].includes(parsedOrigin.hostname),
  "Controller origin must be an exact loopback HTTP origin. Use a separate unique *.localhost author origin.");
  assert(path.isAbsolute(values.output ?? ""), "Controller output must be an absolute path.");
  if (values["final-answer-file"]) assert(path.isAbsolute(values["final-answer-file"]), "Final answer path must be absolute.");
  let authorOrigin: string | undefined;
  if (values["author-origin"]) {
    const parsedAuthorOrigin = new URL(values["author-origin"]);
    assert(parsedAuthorOrigin.protocol === "http:" && parsedAuthorOrigin.origin === values["author-origin"]
      && parsedAuthorOrigin.hostname.endsWith(".localhost") && parsedAuthorOrigin.hostname !== "localhost",
    "Author origin must be an exact unique *.localhost HTTP origin.");
    assert(parsedAuthorOrigin.port === parsedOrigin.port,
      "Author and controller origins must address the same frozen server port.");
    authorOrigin = parsedAuthorOrigin.origin;
  }
  assert(command !== "provision" || authorOrigin,
    "Provision requires --author-origin so the isolated author URL is bound before room creation.");
  return {
    command,
    attemptId: values.attempt,
    origin: parsedOrigin.origin,
    output: path.resolve(values.output),
    ...(authorOrigin ? { authorOrigin } : {}),
    ...(values["final-answer-file"] ? { finalAnswerFile: path.resolve(values["final-answer-file"]) } : {}),
  };
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
    assert(/^jazzboard_guest=/.test(first), "Controller did not receive the signed Jazzboard guest cookie.");
    this.cookie = first;
  }

  setCookie(cookie: string): void {
    assert(/^jazzboard_guest=/.test(cookie), "Stored controller cookie is invalid.");
    this.cookie = cookie;
  }

  getCookie(): string {
    assert(this.cookie, "Controller signed cookie is missing.");
    return this.cookie;
  }

  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("x-jazzboard-client-capabilities", CLIENT_CAPABILITIES);
    if (this.cookie) headers.set("cookie", this.cookie);
    if (init.body) headers.set("content-type", "application/json");
    const method = (init.method ?? "GET").toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) headers.set("idempotency-key", randomUUID());
    const response = await fetch(new URL(url, this.origin), { ...init, headers, cache: "no-store" });
    this.captureCookie(response);
    const text = await response.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch {
      throw new Error(`${method} ${url} returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    if (!response.ok || (data as { ok?: boolean }).ok === false) {
      throw new Error(`${method} ${url} failed HTTP ${response.status}: ${JSON.stringify(data)}`);
    }
    return data as T;
  }
}

function assignment(attemptId: string) {
  const { authorManifest, graderManifest } = createExp0036FrozenPacketBundle();
  const frozen = graderManifest.fixedAttemptOrder.find((item: FrozenAssignment) => item.attemptId === attemptId) as FrozenAssignment | undefined;
  assert(frozen, `Frozen grader manifest does not contain ${attemptId}.`);
  const task = authorManifest.taskPackets.find((item: { id: string }) => item.id === frozen.taskId);
  assert(task, `Frozen author manifest does not contain ${frozen.taskId}.`);
  const build = graderManifest.builds[frozen.arm];
  return { frozen, task, build, graderManifest };
}

function counts(room: RoomState): Record<string, number> {
  return Object.values(room.objects).reduce<Record<string, number>>((result, object) => {
    result[object.kind] = (result[object.kind] ?? 0) + 1;
    return result;
  }, {});
}

function targets(room: RoomState) {
  return Object.values(room.objects).filter((object) => object.kind === "shape"
    && object.nodeType === "open_question" && object.nodeMetadata?.kind === "open_question"
    && object.nodeMetadata.status === "open" && object.nodeMetadata.owner === "Mira");
}

function verifyInitial(taskId: string, room: RoomState) {
  const objectCounts = counts(room);
  if (taskId === "exp0036-existing-inventory") {
    assert(Object.keys(room.objects).length === 360
      && canonical(objectCounts) === canonical({ shape: 180, text: 90, path: 90 })
      && Object.keys(room.diagrams).length === 6 && targets(room).length === 8,
    "Inventory fixture cardinality mismatch.");
  } else if (taskId === "exp0036-existing-metadata-edit") {
    assert(Object.keys(room.objects).length === 240
      && canonical(objectCounts) === canonical({ shape: 120, text: 60, path: 60 })
      && Object.keys(room.diagrams).length === 0 && targets(room).length === 12,
    "Metadata-edit fixture cardinality mismatch.");
  } else {
    assert(Object.keys(room.objects).length === 0 && Object.keys(room.diagrams).length === 0,
      "Creation task did not start from a blank room.");
  }
  return { roomRevision: room.roomRevision, objectCounts, objectCount: Object.keys(room.objects).length, diagramCount: Object.keys(room.diagrams).length };
}

async function ensureDirectories(output: string) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const privateDirectory = path.join(output, ".private");
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  return privateDirectory;
}

async function assertNotProvisioned(output: string): Promise<void> {
  try {
    await readFile(path.join(output, "provision.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Output already contains provision evidence: ${output}`);
}

async function provision(args: Args): Promise<void> {
  await assertNotProvisioned(args.output);
  const privateDirectory = await ensureDirectories(args.output);
  const { frozen, task, build, graderManifest } = assignment(args.attemptId);
  const transport = new CookieRequest(args.origin);
  const created = await transport.request<{ ok: true; participantId: string; room: RoomState }>("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ action: "create", displayName: "EXP-0036 Controller", title: `EXP-0036 ${frozen.attemptId} ${frozen.taskId}` }),
  });
  let room = created.room;
  let fixture: ReturnType<typeof createExp0036ProvisioningFixture> | null = null;
  const transactionReceipts: unknown[] = [];
  if (frozen.taskId.startsWith("exp0036-existing-")) {
    fixture = createExp0036ProvisioningFixture(frozen.taskId);
    let idSequence = 0;
    const binding: JazzboardWebMcpBinding = {
      roomId: room.id,
      participantId: created.participantId,
      role: "participant",
      context: {
        getRoom: () => room, getSelection: () => [], getViewport: () => null,
        getFollowTarget: () => null, acceptRoom: (next) => { room = next; },
        setFollowTarget: () => {}, setDeclinedSpotlight: () => {}, leaveRoomView: () => {},
      },
    };
    const tool = createJazzboardSemanticWebMcpTools(binding, {
      request: transport.request.bind(transport) as WebMcpRequest,
      createId: (prefix) => `${prefix}_e36_${args.attemptId.slice(-2)}_${++idSequence}`,
    }).find((candidate) => candidate.name === "apply_canvas_transaction");
    assert(tool, "Registered apply_canvas_transaction tool is missing.");
    for (const transaction of fixture.provisioning.transactions) {
      const result = await tool.execute(transaction, { signal: new AbortController().signal }) as JazzboardToolResult;
      assert(result.ok, `Fixture transaction failed: ${JSON.stringify(result)}`);
      transactionReceipts.push(result);
    }
  }
  const authoritative = await transport.request<{ ok: true; participantId: string; room: RoomState }>(
    `/api/rooms/${encodeURIComponent(room.id)}`, { method: "GET" },
  );
  room = authoritative.room;
  const initial = verifyInitial(frozen.taskId, room);
  const privateEvidence = {
    schemaVersion: "jazzboard-exp0036-controller-private/v1",
    provisionedAt: new Date().toISOString(),
    assignment: { ...frozen, commit: build.commit, archiveSha256: build.archiveSha256 },
    controllerOrigin: args.origin,
    authorOrigin: args.authorOrigin,
    controllerParticipantId: created.participantId,
    controllerCookie: transport.getCookie(),
    roomCode: room.code,
    fixture,
    transactionReceipts,
    beforeRoom: room,
    graderManifestSha256: sha256(canonical(graderManifest)),
  };
  const privatePath = path.join(privateDirectory, "controller.json");
  await saveJson(privatePath, privateEvidence);
  const privateBytes = await readFile(privatePath);
  const publicReceipt = {
    schemaVersion: "jazzboard-exp0036-provision-receipt/v1",
    attemptId: frozen.attemptId,
    pairId: frozen.pairId,
    taskId: frozen.taskId,
    controllerOrigin: args.origin,
    authorOrigin: args.authorOrigin,
    roomId: room.id,
    roomCode: room.code,
    authorRoomUrl: `${args.authorOrigin}/room/${encodeURIComponent(room.id)}`,
    publicTask: task,
    initial,
    beforeRoomSha256: sha256(canonical(room)),
    privateEvidenceFileSha256: sha256(privateBytes),
    signedControllerCookieStoredSeparately: true,
    authorGuestSessionCreated: false,
    authorTaskCreated: false,
  };
  const receiptPath = path.join(args.output, "provision.json");
  await saveJson(receiptPath, publicReceipt);
  process.stdout.write(`${JSON.stringify({ ok: true, command: "provision", receiptPath, ...publicReceipt })}\n`);
}

async function loadPrivate(args: Args) {
  const privatePath = path.join(args.output, ".private/controller.json");
  const bytes = await readFile(privatePath);
  const evidence = JSON.parse(bytes.toString("utf8")) as {
    assignment: FrozenAssignment;
    controllerOrigin: string;
    authorOrigin: string;
    controllerCookie: string;
    beforeRoom: RoomState;
  };
  assert(evidence.assignment.attemptId === args.attemptId && evidence.controllerOrigin === args.origin,
    "Controller evidence does not match attempt/origin arguments.");
  if (args.authorOrigin) assert(evidence.authorOrigin === args.authorOrigin,
    "Controller evidence does not match the author origin argument.");
  const provisionBytes = await readFile(path.join(args.output, "provision.json"));
  const receipt = JSON.parse(provisionBytes.toString("utf8")) as {
    attemptId: string;
    controllerOrigin: string;
    authorOrigin: string;
    roomId: string;
    beforeRoomSha256: string;
    privateEvidenceFileSha256: string;
  };
  assert(receipt.attemptId === args.attemptId && receipt.controllerOrigin === args.origin
    && receipt.authorOrigin === evidence.authorOrigin && receipt.roomId === evidence.beforeRoom.id,
  "Public provision receipt does not match private controller evidence.");
  assert(receipt.beforeRoomSha256 === sha256(canonical(evidence.beforeRoom))
    && receipt.privateEvidenceFileSha256 === sha256(bytes),
  "Provision receipt digest verification failed.");
  return { evidence, bytes };
}

async function snapshot(args: Args): Promise<void> {
  const { evidence } = await loadPrivate(args);
  const transport = new CookieRequest(args.origin);
  transport.setCookie(evidence.controllerCookie);
  const response = await transport.request<{ ok: true; room: RoomState }>(
    `/api/rooms/${encodeURIComponent(evidence.beforeRoom.id)}`, { method: "GET" },
  );
  assert(response.room.id === evidence.beforeRoom.id, "Snapshot returned a different room.");
  const snapshotPath = path.join(args.output, ".private/after.json");
  await saveJson(snapshotPath, response.room);
  process.stdout.write(`${JSON.stringify({ ok: true, command: "snapshot", attemptId: args.attemptId, snapshotPath, roomRevision: response.room.roomRevision, afterRoomSha256: sha256(canonical(response.room)) })}\n`);
}

async function grade(args: Args): Promise<void> {
  const { evidence, bytes } = await loadPrivate(args);
  const afterPath = path.join(args.output, ".private/after.json");
  const afterBytes = await readFile(afterPath);
  const afterRoom = JSON.parse(afterBytes.toString("utf8")) as RoomState;
  assert(afterRoom.id === evidence.beforeRoom.id, "After snapshot is for a different room.");
  const creation = !evidence.assignment.taskId.startsWith("exp0036-existing-");
  const finalAnswer = args.finalAnswerFile ? await readFile(args.finalAnswerFile, "utf8") : undefined;
  assert(creation || finalAnswer !== undefined, "Context task grading requires --final-answer-file.");
  const semanticGrade = creation ? {
    schemaVersion: "jazzboard-exp0036-creation-grade-pending/v1",
    passed: null,
    reason: "Deterministic and blinded creation grading requires sanitized final state, exact-revision pixels, and two independent reviews.",
  } : gradeExp0036ContextFixture({
    family: evidence.assignment.taskId === "exp0036-existing-inventory" ? "inventory" : "repair",
    beforeRoom: evidence.beforeRoom,
    afterRoom,
    finalAnswer,
  });
  const result = {
    schemaVersion: "jazzboard-exp0036-controller-grade/v1",
    attemptId: args.attemptId,
    taskId: evidence.assignment.taskId,
    inputDigests: {
      privateEvidenceFile: sha256(bytes), beforeRoom: sha256(canonical(evidence.beforeRoom)),
      afterSnapshotFile: sha256(afterBytes), afterRoom: sha256(canonical(afterRoom)),
      finalAnswerFile: args.finalAnswerFile ? sha256(await readFile(args.finalAnswerFile)) : null,
    },
    semanticGrade,
    reviewArtifact: creation ? sanitizeExp0036FinalState(afterRoom) : null,
  };
  const gradePath = path.join(args.output, ".private/grade.json");
  await saveJson(gradePath, result);
  process.stdout.write(`${JSON.stringify({ ok: true, command: "grade", attemptId: args.attemptId, taskId: evidence.assignment.taskId, deterministicPassed: semanticGrade.passed, gradePath, gradeSha256: sha256(await readFile(gradePath)) })}\n`);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "provision") await provision(args);
if (args.command === "snapshot") await snapshot(args);
if (args.command === "grade") await grade(args);
