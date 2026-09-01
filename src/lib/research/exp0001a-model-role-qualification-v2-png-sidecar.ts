import { createServer, type Server } from "node:http";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  canonicalJson,
  hashCanonicalJson,
  sha256Digest,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const opaqueKeySchema = z.string().regex(/^[a-f0-9]{32}$/);

export const qualificationV2EvidenceSidecarManifestSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-evidence-sidecar-manifest/v2"),
  opaqueArtifactKey: opaqueKeySchema,
  mediaType: z.literal("image/png"),
  byteDigest: digestSchema,
  byteLength: z.number().int().positive(),
  sourceRoomRevision: z.number().int().positive(),
}).strict();

export const qualificationV2EvidenceSidecarReadReceiptSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-evidence-sidecar-read-receipt/v2"),
  manifestDigest: digestSchema,
  requestPath: z.string().regex(/^\/evidence\/[a-f0-9]{32}\.png$/),
  method: z.literal("GET"),
  responseStatus: z.literal(200),
  responseCacheControl: z.literal("no-store, max-age=0"),
  servedByteDigest: digestSchema,
  servedByteLength: z.number().int().positive(),
  readOrdinal: z.literal(1),
  servedAt: timestampSchema,
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest: _receiptDigest, ...content } = receipt;
  void _receiptDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== receipt.receiptDigest) {
    context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Evidence read receipt digest is invalid." });
  }
});

export type QualificationV2EvidenceSidecarManifest = z.infer<typeof qualificationV2EvidenceSidecarManifestSchema>;
export type QualificationV2EvidenceSidecarReadReceipt = z.infer<typeof qualificationV2EvidenceSidecarReadReceiptSchema>;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

async function readPlainFile(filePath: string, label: string): Promise<Buffer> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a singly linked plain file.`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseManifest(bytes: Buffer): QualificationV2EvidenceSidecarManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("QUALIFICATION_V2_EVIDENCE_MANIFEST_JSON_INVALID");
  }
  return qualificationV2EvidenceSidecarManifestSchema.parse(value);
}

/** Performs a strict structural pass without decoding or rewriting the PNG. */
export function assertQualificationV2PngStructure(bytes: Buffer): void {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error("QUALIFICATION_V2_EVIDENCE_PNG_SIGNATURE_INVALID");
  }
  let offset = 8;
  let chunkIndex = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("QUALIFICATION_V2_EVIDENCE_PNG_TRUNCATED");
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || next > bytes.length) {
      throw new Error("QUALIFICATION_V2_EVIDENCE_PNG_CHUNK_INVALID");
    }
    const crcInput = bytes.subarray(offset + 4, offset + 8 + length);
    if (crc32(crcInput) !== bytes.readUInt32BE(offset + 8 + length)) {
      throw new Error("QUALIFICATION_V2_EVIDENCE_PNG_CHUNK_CRC_INVALID");
    }
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) {
      throw new Error("QUALIFICATION_V2_EVIDENCE_PNG_IHDR_INVALID");
    }
    if (type === "IHDR") {
      if (sawIhdr || length !== 13) throw new Error("QUALIFICATION_V2_EVIDENCE_PNG_IHDR_INVALID");
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (width === 0 || height === 0) throw new Error("QUALIFICATION_V2_EVIDENCE_PNG_DIMENSIONS_INVALID");
      sawIhdr = true;
    } else if (!sawIhdr) {
      throw new Error("QUALIFICATION_V2_EVIDENCE_PNG_IHDR_MISSING");
    }
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      if (length !== 0 || sawIend || next !== bytes.length) {
        throw new Error("QUALIFICATION_V2_EVIDENCE_PNG_IEND_INVALID");
      }
      sawIend = true;
    }
    offset = next;
    chunkIndex += 1;
  }
  if (!sawIhdr || !sawIdat || !sawIend || offset !== bytes.length) {
    throw new Error("QUALIFICATION_V2_EVIDENCE_PNG_STRUCTURE_INVALID");
  }
}

async function writeExclusivePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.qualification-v2-sidecar-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // A hard-link publish gives us atomic no-replace semantics on the same
    // filesystem. `rename` would silently overwrite an earlier read receipt.
    await link(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function sealReadReceipt(content: Omit<QualificationV2EvidenceSidecarReadReceipt, "receiptDigest">) {
  return qualificationV2EvidenceSidecarReadReceiptSchema.parse({
    ...content,
    receiptDigest: hashCanonicalJson(content as unknown as JsonValue),
  });
}

export type QualificationV2PngEvidenceSidecar = Readonly<{
  url: string;
  manifest: QualificationV2EvidenceSidecarManifest;
  manifestDigest: string;
  close: () => Promise<void>;
  address: Readonly<{ host: "127.0.0.1"; port: number; path: string }>;
}>;

export async function startQualificationV2PngEvidenceSidecar(input: Readonly<{
  manifestPath: string;
  pngPath: string;
  readReceiptPath: string;
  port?: number;
  now?: () => string;
}>): Promise<QualificationV2PngEvidenceSidecar> {
  const [manifestBytes, pngBytes] = await Promise.all([
    readPlainFile(input.manifestPath, "Qualification-v2 evidence manifest"),
    readPlainFile(input.pngPath, "Qualification-v2 exact-revision PNG"),
  ]);
  const manifest = parseManifest(manifestBytes);
  assertQualificationV2PngStructure(pngBytes);
  if (manifest.byteLength !== pngBytes.length || manifest.byteDigest !== sha256Digest(pngBytes)) {
    throw new Error("QUALIFICATION_V2_EVIDENCE_PNG_MANIFEST_MISMATCH");
  }
  const expectedPath = `/evidence/${manifest.opaqueArtifactKey}.png`;
  const manifestDigest = hashCanonicalJson(manifest as unknown as JsonValue);
  const retainedPngBytes = Buffer.from(pngBytes);
  const retainedManifestBytes = Buffer.from(manifestBytes);
  if (sha256Digest(retainedPngBytes) !== manifest.byteDigest
      || parseManifest(retainedManifestBytes).opaqueArtifactKey !== manifest.opaqueArtifactKey) {
    throw new Error("QUALIFICATION_V2_EVIDENCE_RETAINED_BYTES_MISMATCH");
  }
  let successfulReads = 0;
  let receiptWritten = false;
  const server: Server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end();
      return;
    }
    if (request.url !== expectedPath) {
      response.statusCode = 404;
      response.end();
      return;
    }
    if (successfulReads !== 0) {
      response.statusCode = 410;
      response.end();
      return;
    }
    successfulReads = 1;
    response.statusCode = 200;
    response.setHeader("Content-Type", "image/png");
    response.setHeader("Content-Length", String(retainedPngBytes.length));
    response.end(retainedPngBytes, () => {
      if (receiptWritten) return;
      receiptWritten = true;
      const receipt = sealReadReceipt({
        schemaVersion: "exp-0001a-qualification-evidence-sidecar-read-receipt/v2",
        manifestDigest,
        requestPath: expectedPath,
        method: "GET",
        responseStatus: 200,
        responseCacheControl: "no-store, max-age=0",
        servedByteDigest: sha256Digest(retainedPngBytes),
        servedByteLength: retainedPngBytes.length,
        readOrdinal: 1,
        servedAt: (input.now ?? (() => new Date().toISOString()))(),
      });
      void writeExclusivePrivateJson(input.readReceiptPath, receipt).catch(() => {
        // The immutable in-memory read count still prevents another successful
        // response. Operators must treat a missing receipt as non-evaluable.
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(input.port ?? 0, "127.0.0.1");
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("QUALIFICATION_V2_EVIDENCE_SIDECAR_ADDRESS_INVALID");
  }
  const close = async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}${expectedPath}`,
    manifest,
    manifestDigest,
    close,
    address: Object.freeze({ host: "127.0.0.1" as const, port: address.port, path: expectedPath }),
  });
}

export function verifyQualificationV2EvidenceReadReceipt(input: Readonly<{
  receipt: unknown;
  manifest: unknown;
}>): QualificationV2EvidenceSidecarReadReceipt {
  const receipt = qualificationV2EvidenceSidecarReadReceiptSchema.parse(input.receipt);
  const manifest = qualificationV2EvidenceSidecarManifestSchema.parse(input.manifest);
  if (receipt.manifestDigest !== hashCanonicalJson(manifest as unknown as JsonValue)
      || receipt.requestPath !== `/evidence/${manifest.opaqueArtifactKey}.png`
      || receipt.servedByteDigest !== manifest.byteDigest
      || receipt.servedByteLength !== manifest.byteLength) {
    throw new Error("QUALIFICATION_V2_EVIDENCE_READ_RECEIPT_BINDING_INVALID");
  }
  return receipt;
}
