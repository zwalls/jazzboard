// @vitest-environment node

import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  qualificationV2EvidenceSidecarReadReceiptSchema,
  startQualificationV2PngEvidenceSidecar,
  verifyQualificationV2EvidenceReadReceipt,
} from "./exp0001a-model-role-qualification-v2-png-sidecar";
import { canonicalJson, hashCanonicalJson, sha256Digest, type JsonValue } from "./provenance-crypto";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "qualification-v2-sidecar-"));
  const manifestPath = path.join(root, "manifest.json");
  const pngPath = path.join(root, "artifact.png");
  const readReceiptPath = path.join(root, "read-receipt.json");
  const manifest = {
    schemaVersion: "exp-0001a-qualification-evidence-sidecar-manifest/v2",
    opaqueArtifactKey: "0123456789abcdef0123456789abcdef",
    mediaType: "image/png",
    byteDigest: sha256Digest(PNG_BYTES),
    byteLength: PNG_BYTES.length,
    sourceRoomRevision: 42,
  } as const;
  await writeFile(manifestPath, `${canonicalJson(manifest as unknown as JsonValue)}\n`, { mode: 0o600 });
  await writeFile(pngPath, PNG_BYTES, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  await chmod(pngPath, 0o600);
  return { root, manifestPath, pngPath, readReceiptPath, manifest };
}

async function waitForReceipt(filePath: string) {
  for (let index = 0; index < 30; index += 1) {
    const bytes = await readFile(filePath).catch(() => null);
    if (bytes !== null) return JSON.parse(bytes.toString("utf8")) as unknown;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("receipt unavailable");
}

describe("EXP-0001A qualification-v2 opaque PNG sidecar", () => {
  it("serves the exact retained PNG once without caching and seals a bound read receipt", async () => {
    const item = await fixture();
    const sidecar = await startQualificationV2PngEvidenceSidecar({
      ...item,
      now: () => "2026-08-31T21:00:00.000Z",
    });
    try {
      expect(sidecar.url).toBe(`http://127.0.0.1:${sidecar.address.port}${sidecar.address.path}`);
      const response = await fetch(sidecar.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);
      const receipt = qualificationV2EvidenceSidecarReadReceiptSchema.parse(
        await waitForReceipt(item.readReceiptPath),
      );
      expect(receipt).toMatchObject({
        manifestDigest: hashCanonicalJson(item.manifest as unknown as JsonValue),
        servedByteDigest: item.manifest.byteDigest,
        servedByteLength: item.manifest.byteLength,
        readOrdinal: 1,
      });
      expect(verifyQualificationV2EvidenceReadReceipt({ receipt, manifest: item.manifest })).toEqual(receipt);
    } finally {
      await sidecar.close();
    }
  });

  it("rejects wrong paths, query variants, methods, and every read after the first", async () => {
    const item = await fixture();
    const sidecar = await startQualificationV2PngEvidenceSidecar(item);
    try {
      const origin = `http://127.0.0.1:${sidecar.address.port}`;
      expect((await fetch(`${origin}/evidence/not-the-key.png`)).status).toBe(404);
      expect((await fetch(`${sidecar.url}?leak=1`)).status).toBe(404);
      expect((await fetch(sidecar.url, { method: "HEAD" })).status).toBe(405);
      expect((await fetch(sidecar.url)).status).toBe(200);
      const originalReceipt = await waitForReceipt(item.readReceiptPath);
      expect((await fetch(sidecar.url)).status).toBe(410);
      expect(JSON.parse(await readFile(item.readReceiptPath, "utf8"))).toEqual(originalReceipt);
    } finally {
      await sidecar.close();
    }
  });

  it("fails before listening for missing, tampered, or malformed PNG evidence", async () => {
    const missing = await fixture();
    await expect(startQualificationV2PngEvidenceSidecar({
      ...missing,
      pngPath: path.join(missing.root, "missing.png"),
    })).rejects.toThrow();

    const tampered = await fixture();
    await writeFile(tampered.pngPath, Buffer.concat([PNG_BYTES, Buffer.from([0])]), { mode: 0o600 });
    await expect(startQualificationV2PngEvidenceSidecar(tampered)).rejects.toThrow(/PNG|MANIFEST/);

    const malformed = await fixture();
    const bytes = Buffer.from(PNG_BYTES);
    bytes[0] = 0;
    await writeFile(malformed.pngPath, bytes, { mode: 0o600 });
    const malformedManifest = { ...malformed.manifest, byteDigest: sha256Digest(bytes) };
    await writeFile(malformed.manifestPath, `${canonicalJson(malformedManifest as unknown as JsonValue)}\n`, { mode: 0o600 });
    await expect(startQualificationV2PngEvidenceSidecar(malformed)).rejects.toThrow(/PNG_SIGNATURE/);
  });
});
