import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";

import {
  createExp0001aAdjudicationReviewSubject,
  createExp0001aAdjudicatorTaskEnvelopeFromSubject,
  createExp0001aPairwiseReviewSubject,
  createExp0001aPairwiseVisualJudgeTaskEnvelopeFromSubject,
  createExp0001aPrimaryReviewSubject,
  createExp0001aPrimaryReviewerTaskEnvelopeFromSubject,
  exp0001aAdjudicationReviewSubjectSchema,
  exp0001aCodexArtifactPacketReadyReceiptSchema,
  exp0001aCodexTaskLifecycleSchema,
  exp0001aCodexTaskTransportPlanSchema,
  exp0001aPairwiseReviewSubjectSchema,
  exp0001aPrimaryReviewSubjectSchema,
  materializeExp0001aAdjudicationReviewSubjectArtifactPacket,
  materializeExp0001aPairwiseReviewSubjectArtifactPacket,
  materializeExp0001aPrimaryReviewSubjectArtifactPacket,
  probeExp0001aCodexArtifactPacket,
  type Exp0001aAdjudicationReviewSubject,
  type Exp0001aCodexArtifactPacketReadyReceipt,
  type Exp0001aCodexTaskEnvelope,
  type Exp0001aCodexTaskLifecycle,
  type Exp0001aCodexTaskTransportPlan,
  type Exp0001aRetainedPrimaryPair,
  type Exp0001aPairwiseReviewSubject,
  type Exp0001aPrimaryReviewSubject,
} from "./exp0001a-codex-task-transport";
import { canonicalJson, hashCanonicalJson, sha256Digest, SHA256_DIGEST_PATTERN, type JsonValue } from "./provenance-crypto";

export const EXP0001A_CODEX_ARTIFACT_PACKET_SERVER_VERSION = "exp-0001a-codex-artifact-packet-server/v2" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const packetRoleSchema = z.enum(["primary_reviewer", "adjudicator", "pairwise_visual_judge"]);
const subjectKindSchema = z.enum([
  "adjudication-review-subject",
  "primary-review-success-subject",
  "primary-review-author-failure-subject",
  "pairwise-review-success-subject",
  "pairwise-review-unavailable-subject",
]);
const requestCountsSchema = z.object({
  get: z.number().int().nonnegative(), head: z.number().int().nonnegative(),
  rejectedWrite: z.number().int().nonnegative(), notFound: z.number().int().nonnegative(),
  rejectedHost: z.number().int().nonnegative(),
}).strict();
const servedFileSchema = z.object({
  relativePath: z.string().min(1).max(512), sha256: digestSchema,
  bytes: z.number().int().positive(), mimeType: z.enum(["image/png", "application/json"]),
  getCount: z.number().int().positive(), headCount: z.number().int().nonnegative(),
}).strict();

const startReceiptContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_ARTIFACT_PACKET_SERVER_VERSION),
  kind: z.literal("codex-review-artifact-packet-server-start"), startedAt: timestampSchema,
  role: packetRoleSchema, subjectKind: subjectKindSchema, subjectDigest: digestSchema,
  reviewerEnvelopeDigest: digestSchema, origin: z.string().url().regex(/^http:\/\/127\.0\.0\.1:\d+\/$/),
  manifestUrl: z.string().url(), manifestDigest: digestSchema, manifestBytes: z.number().int().positive(),
  fileCount: z.number().int().positive().max(14), fileRoot: digestSchema,
  bindAddress: z.literal("127.0.0.1"), ephemeralPort: z.literal(true),
  allowedMethods: z.tuple([z.literal("GET"), z.literal("HEAD")]), directoryListing: z.literal(false),
  writesAccepted: z.literal(false), lifetime: z.literal("single-task"),
}).strict();
export const exp0001aCodexArtifactPacketServerStartReceiptSchema = startReceiptContentSchema
  .extend({ receiptDigest: digestSchema }).strict().superRefine((receipt, context) => {
    const { receiptDigest: _receiptDigest, ...content } = receipt; void _receiptDigest;
    if (hashCanonicalJson(content) !== receipt.receiptDigest) {
      context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Artifact packet server start receipt digest is invalid." });
    }
  });
export type Exp0001aCodexArtifactPacketServerStartReceipt = z.infer<typeof exp0001aCodexArtifactPacketServerStartReceiptSchema>;

const stopReceiptContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_ARTIFACT_PACKET_SERVER_VERSION),
  kind: z.literal("codex-review-artifact-packet-server-stop"), stoppedAt: timestampSchema,
  startReceiptDigest: digestSchema, readyReceiptDigest: digestSchema, reviewerEnvelopeDigest: digestSchema,
  subjectDigest: digestSchema, requestCounts: requestCountsSchema,
  servedFiles: z.array(servedFileSchema).min(1).max(14), everyFileOpened: z.literal(true),
  serverClosed: z.literal(true), lifetime: z.literal("single-task"),
}).strict();
export const exp0001aCodexArtifactPacketServerStopReceiptSchema = stopReceiptContentSchema
  .extend({ receiptDigest: digestSchema }).strict().superRefine((receipt, context) => {
    const { receiptDigest: _receiptDigest, ...content } = receipt; void _receiptDigest;
    if (hashCanonicalJson(content) !== receipt.receiptDigest) {
      context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Artifact packet server stop receipt digest is invalid." });
    }
  });
export type Exp0001aCodexArtifactPacketServerStopReceipt = z.infer<typeof exp0001aCodexArtifactPacketServerStopReceiptSchema>;

type ReviewEnvelope = Exclude<Exp0001aCodexTaskEnvelope, { role: "author" }>;
export type Exp0001aCodexArtifactPacketServer<TEnvelope extends ReviewEnvelope = ReviewEnvelope> = Readonly<{
  envelope: TEnvelope;
  startReceipt: Exp0001aCodexArtifactPacketServerStartReceipt;
  readyReceipt: Exp0001aCodexArtifactPacketReadyReceipt;
  stop: (input?: Readonly<{ stoppedAt?: string }>) => Promise<Exp0001aCodexArtifactPacketServerStopReceipt>;
}>;
type RetainedPacketFile = Readonly<{
  relativePath: string; sha256: string; bytes: number;
  mimeType: "image/png" | "application/json"; contentBase64: string;
}>;

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
function listenLoopback(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
        reject(new Error("EXP0001A_ARTIFACT_PACKET_SERVER_NOT_LOOPBACK")); return;
      }
      resolve(address);
    });
  });
}

type ServedRoute = Readonly<{ body: Buffer; mimeType: string; relativePath: string | null }>;
function serveExact(
  request: IncomingMessage,
  response: ServerResponse,
  expectedHost: string,
  routes: ReadonlyMap<string, ServedRoute>,
  fileReads: Map<string, { get: number; head: number }>,
  counts: z.infer<typeof requestCountsSchema>,
): void {
  const method = request.method ?? "";
  if (request.headers.host !== expectedHost) {
    counts.rejectedHost += 1; response.writeHead(421, { "cache-control": "no-store", connection: "close" }); response.end(); return;
  }
  if (method !== "GET" && method !== "HEAD") {
    counts.rejectedWrite += 1;
    response.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store", connection: "close" }); response.end(); return;
  }
  const requested = new URL(request.url ?? "/", `http://${expectedHost}`);
  const route = requested.search === "" ? routes.get(requested.pathname) : undefined;
  if (route === undefined) {
    counts.notFound += 1; response.writeHead(404, { "cache-control": "no-store", connection: "close" }); response.end(); return;
  }
  if (method === "GET") counts.get += 1; else counts.head += 1;
  if (route.relativePath !== null) {
    const read = fileReads.get(route.relativePath)!;
    if (method === "GET") read.get += 1; else read.head += 1;
  }
  response.writeHead(200, {
    "cache-control": "no-store", "content-length": String(route.body.byteLength),
    "content-type": route.mimeType, "x-content-type-options": "nosniff", connection: "close",
  });
  response.end(method === "HEAD" ? undefined : route.body);
}

async function startPacketServer<TEnvelope extends ReviewEnvelope>(input: Readonly<{
  role: TEnvelope["role"];
  subjectKind: z.infer<typeof subjectKindSchema>;
  subjectDigest: string;
  makeEnvelope: (origin: string) => TEnvelope;
  materialize: (envelope: TEnvelope) => Readonly<{ manifest: JsonValue; files: readonly RetainedPacketFile[] }>;
  now?: () => string;
}>): Promise<Exp0001aCodexArtifactPacketServer<TEnvelope>> {
  const counts = { get: 0, head: 0, rejectedWrite: 0, notFound: 0, rejectedHost: 0 };
  const fileReads = new Map<string, { get: number; head: number }>();
  let routing: Readonly<{ expectedHost: string; routes: ReadonlyMap<string, ServedRoute> }> | null = null;
  const server = createServer((request, response) => {
    if (routing === null) { response.writeHead(503, { "cache-control": "no-store", connection: "close" }); response.end(); return; }
    serveExact(request, response, routing.expectedHost, routing.routes, fileReads, counts);
  });
  let closed = false;
  try {
    const address = await listenLoopback(server);
    const origin = `http://127.0.0.1:${address.port}/`;
    const envelope = input.makeEnvelope(origin);
    if (envelope.role !== input.role) throw new Error("EXP0001A_ARTIFACT_PACKET_ENVELOPE_ROLE_DRIFT");
    const packet = envelope.artifactPacket;
    const materialized = input.materialize(envelope);
    const manifestBytes = Buffer.from(canonicalJson(materialized.manifest), "utf8");
    if (hashCanonicalJson(materialized.manifest) !== packet.manifestDigest
        || canonicalJson(packet.files) !== canonicalJson(materialized.files.map(({ contentBase64: _contentBase64, ...metadata }) => metadata))) {
      throw new Error("EXP0001A_ARTIFACT_PACKET_MATERIALIZATION_DRIFT");
    }
    const expectedHost = `127.0.0.1:${address.port}`;
    const manifestUrl = new URL(packet.manifestUrl);
    if (manifestUrl.host !== expectedHost || packet.origin !== origin) throw new Error("EXP0001A_ARTIFACT_PACKET_ORIGIN_DRIFT");
    const routes = new Map<string, ServedRoute>();
    routes.set(manifestUrl.pathname, { body: manifestBytes, mimeType: "application/json; charset=utf-8", relativePath: null });
    const rootUrl = new URL("./", packet.manifestUrl);
    for (const file of materialized.files) {
      const bytes = Buffer.from(file.contentBase64, "base64");
      if (Buffer.from(bytes).toString("base64") !== file.contentBase64 || bytes.byteLength !== file.bytes
          || sha256Digest(bytes) !== file.sha256) throw new Error(`EXP0001A_ARTIFACT_PACKET_FILE_DRIFT:${file.relativePath}`);
      const url = new URL(file.relativePath, rootUrl);
      if (url.host !== expectedHost || url.search !== "" || routes.has(url.pathname)) {
        throw new Error(`EXP0001A_ARTIFACT_PACKET_FILE_ROUTE_INVALID:${file.relativePath}`);
      }
      routes.set(url.pathname, { body: bytes, mimeType: file.mimeType, relativePath: file.relativePath });
      fileReads.set(file.relativePath, { get: 0, head: 0 });
    }
    routing = Object.freeze({ expectedHost, routes });
    const now = input.now ?? (() => new Date().toISOString());
    const startContent = startReceiptContentSchema.parse({
      schemaVersion: EXP0001A_CODEX_ARTIFACT_PACKET_SERVER_VERSION,
      kind: "codex-review-artifact-packet-server-start", startedAt: now(), role: input.role,
      subjectKind: input.subjectKind, subjectDigest: input.subjectDigest, reviewerEnvelopeDigest: hashCanonicalJson(envelope),
      origin, manifestUrl: packet.manifestUrl, manifestDigest: packet.manifestDigest, manifestBytes: manifestBytes.byteLength,
      fileCount: packet.files.length, fileRoot: hashCanonicalJson(packet.files), bindAddress: "127.0.0.1",
      ephemeralPort: true, allowedMethods: ["GET", "HEAD"], directoryListing: false, writesAccepted: false, lifetime: "single-task",
    });
    const startReceipt = freezeDeep(exp0001aCodexArtifactPacketServerStartReceiptSchema.parse({
      ...startContent, receiptDigest: hashCanonicalJson(startContent),
    }));
    const readyReceipt = await probeExp0001aCodexArtifactPacket({ envelope, now });
    const stop = async (stopInput: Readonly<{ stoppedAt?: string }> = {}) => {
      if (closed) throw new Error("EXP0001A_ARTIFACT_PACKET_SERVER_ALREADY_STOPPED");
      closed = true; await closeServer(server);
      const servedFiles = materialized.files.map((file) => {
        const read = fileReads.get(file.relativePath)!;
        if (read.get < 1) throw new Error(`EXP0001A_ARTIFACT_PACKET_FILE_NEVER_OPENED:${file.relativePath}`);
        return { relativePath: file.relativePath, sha256: file.sha256, bytes: file.bytes, mimeType: file.mimeType,
          getCount: read.get, headCount: read.head };
      });
      const stopContent = stopReceiptContentSchema.parse({
        schemaVersion: EXP0001A_CODEX_ARTIFACT_PACKET_SERVER_VERSION,
        kind: "codex-review-artifact-packet-server-stop", stoppedAt: stopInput.stoppedAt ?? now(),
        startReceiptDigest: startReceipt.receiptDigest, readyReceiptDigest: readyReceipt.receiptDigest,
        reviewerEnvelopeDigest: hashCanonicalJson(envelope), subjectDigest: input.subjectDigest,
        requestCounts: counts, servedFiles, everyFileOpened: true, serverClosed: true, lifetime: "single-task",
      });
      return freezeDeep(exp0001aCodexArtifactPacketServerStopReceiptSchema.parse({
        ...stopContent, receiptDigest: hashCanonicalJson(stopContent),
      }));
    };
    return Object.freeze({ envelope, startReceipt, readyReceipt: exp0001aCodexArtifactPacketReadyReceiptSchema.parse(readyReceipt), stop });
  } catch (error) {
    if (!closed) { closed = true; await closeServer(server).catch(() => undefined); }
    throw error;
  }
}

function primaryPublicMaterial(subject: Exp0001aPrimaryReviewSubject) {
  return subject.kind === "primary-review-success-subject"
    ? { publicRequirement: subject.evidence.publicRequirement, rubric: subject.evidence.rubric }
    : { publicRequirement: subject.publicRequirement, rubric: subject.rubric };
}

export async function startExp0001aCodexPrimaryArtifactPacketServer(input: Readonly<{
  subject: Exp0001aPrimaryReviewSubject;
  authorPlan: Exp0001aCodexTaskTransportPlan;
  authorLifecycle: Exp0001aCodexTaskLifecycle;
  now?: () => string;
}>): Promise<Exp0001aCodexArtifactPacketServer<Extract<Exp0001aCodexTaskEnvelope, { role: "primary_reviewer" }>>> {
  const subject = exp0001aPrimaryReviewSubjectSchema.parse(input.subject);
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.authorPlan);
  const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(input.authorLifecycle);
  const expected = createExp0001aPrimaryReviewSubject({ ...primaryPublicMaterial(subject), authorPlan: plan, authorLifecycle: lifecycle });
  if (canonicalJson(expected) !== canonicalJson(subject)) throw new Error("EXP0001A_PRIMARY_PACKET_SUBJECT_NOT_AUTHORITATIVE");
  return startPacketServer({
    role: "primary_reviewer", subjectKind: subject.kind, subjectDigest: subject.subjectDigest,
    makeEnvelope: (origin) => createExp0001aPrimaryReviewerTaskEnvelopeFromSubject({ subject, artifactPacketOrigin: origin }),
    materialize: (envelope) => materializeExp0001aPrimaryReviewSubjectArtifactPacket({ subject, envelope }), now: input.now,
  });
}

export async function startExp0001aCodexPairwiseArtifactPacketServer(input: Readonly<{
  subject: Exp0001aPairwiseReviewSubject;
  sides: readonly [
    Readonly<{ authorPlan: Exp0001aCodexTaskTransportPlan; authorLifecycle: Exp0001aCodexTaskLifecycle }>,
    Readonly<{ authorPlan: Exp0001aCodexTaskTransportPlan; authorLifecycle: Exp0001aCodexTaskLifecycle }>,
  ];
  now?: () => string;
}>): Promise<Exp0001aCodexArtifactPacketServer<Extract<Exp0001aCodexTaskEnvelope, { role: "pairwise_visual_judge" }>>> {
  const subject = exp0001aPairwiseReviewSubjectSchema.parse(input.subject);
  const expected = createExp0001aPairwiseReviewSubject({ publicRequirement: subject.publicRequirement, rubric: subject.rubric, sides: input.sides });
  if (canonicalJson(expected) !== canonicalJson(subject)) throw new Error("EXP0001A_PAIRWISE_PACKET_SUBJECT_NOT_AUTHORITATIVE");
  return startPacketServer({
    role: "pairwise_visual_judge", subjectKind: subject.kind, subjectDigest: subject.subjectDigest,
    makeEnvelope: (origin) => createExp0001aPairwiseVisualJudgeTaskEnvelopeFromSubject({ subject, artifactPacketOrigin: origin }),
    materialize: (envelope) => materializeExp0001aPairwiseReviewSubjectArtifactPacket({ subject, envelope }), now: input.now,
  });
}

export async function startExp0001aCodexAdjudicationArtifactPacketServer(input: Readonly<{
  subject: Exp0001aAdjudicationReviewSubject;
  primarySubject: Exp0001aPrimaryReviewSubject;
  primaryReviews: Exp0001aRetainedPrimaryPair;
  now?: () => string;
}>): Promise<Exp0001aCodexArtifactPacketServer<Extract<Exp0001aCodexTaskEnvelope, { role: "adjudicator" }>>> {
  const subject = exp0001aAdjudicationReviewSubjectSchema.parse(input.subject);
  const expected = createExp0001aAdjudicationReviewSubject({
    primarySubject: input.primarySubject,
    primaryReviews: input.primaryReviews,
  });
  if (canonicalJson(expected) !== canonicalJson(subject)) {
    throw new Error("EXP0001A_ADJUDICATION_PACKET_SUBJECT_NOT_AUTHORITATIVE");
  }
  return startPacketServer({
    role: "adjudicator",
    subjectKind: subject.kind,
    subjectDigest: subject.subjectDigest,
    makeEnvelope: (origin) => createExp0001aAdjudicatorTaskEnvelopeFromSubject({ subject, artifactPacketOrigin: origin }),
    materialize: (envelope) => materializeExp0001aAdjudicationReviewSubjectArtifactPacket({ subject, envelope }),
    now: input.now,
  });
}

/** Backward-compatible primary-only name; callers still cannot supply bytes. */
export const startExp0001aCodexArtifactPacketServer = startExp0001aCodexPrimaryArtifactPacketServer;
