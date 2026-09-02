import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";

import {
  EXP0001A_SUCCESSOR_EVALUATOR_EVIDENCE_V3_VERSION,
  exp0001aSuccessorEvaluatorFileMetadataV3Schema,
  exp0001aSuccessorEvaluatorPacketPointerV3Schema,
  type Exp0001aSuccessorEvaluatorFileMetadataV3,
} from "./exp0001a-successor-evaluator-evidence-v3";
import { canonicalJson, hashCanonicalJson, sha256Digest, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

export const EXP0001A_SUCCESSOR_EVALUATOR_SIDECAR_V3_VERSION =
  "exp-0001a-successor-evaluator-sidecar/v3" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });

export const exp0001aSuccessorEvaluatorRetainedFileV3Schema =
  exp0001aSuccessorEvaluatorFileMetadataV3Schema.extend({
    contentBase64: z.string().min(1).max(14 * 1024 * 1024),
  }).strict();
export type Exp0001aSuccessorEvaluatorRetainedFileV3 = z.infer<
  typeof exp0001aSuccessorEvaluatorRetainedFileV3Schema
>;

const routeReadSchema = z.object({
  exactUrl: z.string().url(),
  relativePath: z.string().nullable(),
  sha256: digestSchema,
  readinessGetCount: z.number().int().positive(),
  postReleaseGetCount: z.number().int().positive(),
  postReleaseHeadCount: z.number().int().nonnegative(),
}).strict();

export const exp0001aSuccessorEvaluatorSidecarReleaseReceiptV3Schema = z.object({
  schemaVersion: z.literal(EXP0001A_SUCCESSOR_EVALUATOR_SIDECAR_V3_VERSION),
  kind: z.literal("successor-evaluator-sidecar-release"),
  reviewerTaskId: z.string().trim().min(1).max(200),
  releasedAt: timestampSchema,
  manifestDigest: digestSchema,
  readinessReadRoot: digestSchema,
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest: _receiptDigest, ...content } = receipt;
  void _receiptDigest;
  if (hashCanonicalJson(content) !== receipt.receiptDigest) {
    context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Sidecar release receipt digest is invalid." });
  }
});
export type Exp0001aSuccessorEvaluatorSidecarReleaseReceiptV3 = z.infer<
  typeof exp0001aSuccessorEvaluatorSidecarReleaseReceiptV3Schema
>;

export const exp0001aSuccessorEvaluatorSidecarStopReceiptV3Schema = z.object({
  schemaVersion: z.literal(EXP0001A_SUCCESSOR_EVALUATOR_SIDECAR_V3_VERSION),
  kind: z.literal("successor-evaluator-sidecar-stop"),
  stoppedAt: timestampSchema,
  releaseReceiptDigest: digestSchema,
  manifestDigest: digestSchema,
  exactUrlCount: z.number().int().positive().max(15),
  exactUrlReads: z.array(routeReadSchema).min(2).max(15),
  everyExactUrlOpenedAfterRelease: z.literal(true),
  distinctUrlAccounting: z.literal(true),
  serverClosed: z.literal(true),
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest: _receiptDigest, ...content } = receipt;
  void _receiptDigest;
  if (receipt.exactUrlCount !== receipt.exactUrlReads.length
      || new Set(receipt.exactUrlReads.map((entry) => entry.exactUrl)).size !== receipt.exactUrlReads.length
      || hashCanonicalJson(content) !== receipt.receiptDigest) {
    context.addIssue({ code: "custom", message: "Sidecar stop receipt is invalid or collapses exact URLs." });
  }
});
export type Exp0001aSuccessorEvaluatorSidecarStopReceiptV3 = z.infer<
  typeof exp0001aSuccessorEvaluatorSidecarStopReceiptV3Schema
>;

type Route = {
  exactUrl: string;
  relativePath: string | null;
  body: Buffer;
  mimeType: string;
  sha256: string;
  readinessGet: number;
  readinessHead: number;
  postReleaseGet: number;
  postReleaseHead: number;
};

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
        reject(new Error("SUCCESSOR_EVALUATOR_SIDECAR_NOT_LOOPBACK"));
      } else resolve(address);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

function serve(
  request: IncomingMessage,
  response: ServerResponse,
  expectedHost: string,
  routes: ReadonlyMap<string, Route>,
  released: () => boolean,
): void {
  if (request.headers.host !== expectedHost) {
    response.writeHead(421, { "cache-control": "no-store", connection: "close" }); response.end(); return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store", connection: "close" }); response.end(); return;
  }
  const url = new URL(request.url ?? "/", `http://${expectedHost}`);
  const route = url.search === "" ? routes.get(url.pathname) : undefined;
  if (route === undefined) {
    response.writeHead(404, { "cache-control": "no-store", connection: "close" }); response.end(); return;
  }
  const postRelease = released();
  if (request.method === "GET") {
    if (postRelease) route.postReleaseGet += 1; else route.readinessGet += 1;
  } else if (postRelease) route.postReleaseHead += 1;
  else route.readinessHead += 1;
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": String(route.body.byteLength),
    "content-type": route.mimeType,
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  response.end(request.method === "HEAD" ? undefined : route.body);
}

export type Exp0001aSuccessorEvaluatorSidecarV3 = Readonly<{
  packet: z.infer<typeof exp0001aSuccessorEvaluatorPacketPointerV3Schema>;
  releaseReviewer: (input: { reviewerTaskId: string; releasedAt?: string }) => Exp0001aSuccessorEvaluatorSidecarReleaseReceiptV3;
  stop: (input?: { stoppedAt?: string }) => Promise<Exp0001aSuccessorEvaluatorSidecarStopReceiptV3>;
  abort: () => Promise<void>;
}>;

export async function startExp0001aSuccessorEvaluatorSidecarV3(input: {
  files: readonly Exp0001aSuccessorEvaluatorRetainedFileV3[];
  now?: () => string;
}): Promise<Exp0001aSuccessorEvaluatorSidecarV3> {
  const files = input.files.map((file) => exp0001aSuccessorEvaluatorRetainedFileV3Schema.parse(file))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (new Set(files.map((file) => file.relativePath)).size !== files.length) {
    throw new Error("SUCCESSOR_EVALUATOR_SIDECAR_DUPLICATE_PATH");
  }
  for (const file of files) {
    const body = Buffer.from(file.contentBase64, "base64");
    if (body.toString("base64") !== file.contentBase64 || body.byteLength !== file.bytes || sha256Digest(body) !== file.sha256) {
      throw new Error(`SUCCESSOR_EVALUATOR_SIDECAR_FILE_BYTES_INVALID:${file.relativePath}`);
    }
  }
  const metadata: Exp0001aSuccessorEvaluatorFileMetadataV3[] = files.map((file) => ({
    relativePath: file.relativePath,
    sha256: file.sha256,
    bytes: file.bytes,
    mimeType: file.mimeType,
  }));
  const manifest = {
    schemaVersion: EXP0001A_SUCCESSOR_EVALUATOR_EVIDENCE_V3_VERSION,
    kind: "successor-evaluator-packet-manifest" as const,
    files: metadata,
  };
  const manifestBody = Buffer.from(canonicalJson(manifest), "utf8");
  const manifestDigest = hashCanonicalJson(manifest);
  const routes = new Map<string, Route>();
  let releaseReceipt: Exp0001aSuccessorEvaluatorSidecarReleaseReceiptV3 | null = null;
  let closed = false;
  let expectedHost = "";
  const server = createServer((request, response) => serve(
    request, response, expectedHost, routes, () => releaseReceipt !== null,
  ));
  try {
    const address = await listen(server);
    expectedHost = `127.0.0.1:${address.port}`;
    const root = `http://${expectedHost}/exp0001a/evaluator/${manifestDigest.slice("sha256:".length)}/`;
    const manifestUrl = new URL("manifest.json", root).href;
    const addRoute = (exactUrl: string, relativePath: string | null, body: Buffer, mimeType: string, sha256: string) => {
      const pathname = new URL(exactUrl).pathname;
      if (routes.has(pathname)) throw new Error("SUCCESSOR_EVALUATOR_SIDECAR_ROUTE_COLLISION");
      routes.set(pathname, {
        exactUrl, relativePath, body, mimeType, sha256,
        readinessGet: 0, readinessHead: 0, postReleaseGet: 0, postReleaseHead: 0,
      });
    };
    addRoute(manifestUrl, null, manifestBody, "application/json; charset=utf-8", manifestDigest);
    for (const file of files) {
      addRoute(new URL(file.relativePath, root).href, file.relativePath, Buffer.from(file.contentBase64, "base64"), file.mimeType, file.sha256);
    }
    const packet = exp0001aSuccessorEvaluatorPacketPointerV3Schema.parse({
      kind: "read-only-loopback-evaluator-packet",
      manifestUrl,
      manifestDigest,
      files: metadata,
      allowedMethods: ["GET", "HEAD"],
      postReleaseGetRequiredPerExactUrl: true,
    });
    for (const route of routes.values()) {
      const response = await fetch(route.exactUrl, { cache: "no-store" });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!response.ok || sha256Digest(bytes) !== route.sha256) {
        throw new Error(`SUCCESSOR_EVALUATOR_SIDECAR_READINESS_PROBE_FAILED:${route.exactUrl}`);
      }
    }
    const now = input.now ?? (() => new Date().toISOString());
    const releaseReviewer = (releaseInput: { reviewerTaskId: string; releasedAt?: string }) => {
      if (closed || releaseReceipt !== null) throw new Error("SUCCESSOR_EVALUATOR_SIDECAR_RELEASE_NOT_AVAILABLE");
      const readinessReads = [...routes.values()].map((route) => ({ exactUrl: route.exactUrl, getCount: route.readinessGet }));
      if (readinessReads.some((entry) => entry.getCount < 1)) throw new Error("SUCCESSOR_EVALUATOR_SIDECAR_NOT_READY");
      const content = {
        schemaVersion: EXP0001A_SUCCESSOR_EVALUATOR_SIDECAR_V3_VERSION,
        kind: "successor-evaluator-sidecar-release" as const,
        reviewerTaskId: releaseInput.reviewerTaskId,
        releasedAt: releaseInput.releasedAt ?? now(),
        manifestDigest,
        readinessReadRoot: hashCanonicalJson(readinessReads),
      };
      releaseReceipt = exp0001aSuccessorEvaluatorSidecarReleaseReceiptV3Schema.parse({
        ...content,
        receiptDigest: hashCanonicalJson(content),
      });
      return releaseReceipt;
    };
    const stop = async (stopInput: { stoppedAt?: string } = {}) => {
      if (closed) throw new Error("SUCCESSOR_EVALUATOR_SIDECAR_ALREADY_CLOSED");
      if (releaseReceipt === null) throw new Error("SUCCESSOR_EVALUATOR_SIDECAR_NOT_RELEASED");
      const reads = [...routes.values()].map((route) => ({
        exactUrl: route.exactUrl,
        relativePath: route.relativePath,
        sha256: route.sha256,
        readinessGetCount: route.readinessGet,
        postReleaseGetCount: route.postReleaseGet,
        postReleaseHeadCount: route.postReleaseHead,
      }));
      const missing = reads.filter((route) => route.postReleaseGetCount < 1).map((route) => route.exactUrl);
      if (missing.length > 0) {
        throw new Error(`SUCCESSOR_EVALUATOR_SIDECAR_POST_RELEASE_GET_MISSING:${missing.join(",")}`);
      }
      closed = true;
      await close(server);
      const content = {
        schemaVersion: EXP0001A_SUCCESSOR_EVALUATOR_SIDECAR_V3_VERSION,
        kind: "successor-evaluator-sidecar-stop" as const,
        stoppedAt: stopInput.stoppedAt ?? now(),
        releaseReceiptDigest: releaseReceipt.receiptDigest,
        manifestDigest,
        exactUrlCount: reads.length,
        exactUrlReads: reads,
        everyExactUrlOpenedAfterRelease: true as const,
        distinctUrlAccounting: true as const,
        serverClosed: true as const,
      };
      return exp0001aSuccessorEvaluatorSidecarStopReceiptV3Schema.parse({
        ...content,
        receiptDigest: hashCanonicalJson(content),
      });
    };
    const abort = async () => {
      if (!closed) {
        closed = true;
        await close(server);
      }
    };
    return Object.freeze({ packet, releaseReviewer, stop, abort });
  } catch (error) {
    if (!closed) {
      closed = true;
      await close(server).catch(() => undefined);
    }
    throw error;
  }
}
