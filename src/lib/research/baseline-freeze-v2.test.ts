// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import receiptJson from "../../../research/data/baseline-freeze-v2.json";
import signatureJson from "../../../research/data/baseline-freeze-v2-authority-signature.json";
import evidenceJson from "../../../research/data/baseline-production-evidence-v2.json";
import inventoryJson from "../../../research/data/baseline-webmcp-inventory-v2.json";
import {
  baselineFreezeReceiptV2Schema,
  computeBaselineFreezeReceiptV2Digest,
  verifyBaselineV2,
  verifyBaselineV2ExecutionReady,
  type BaselineFreezeReceiptV2,
  type BaselineV2ArtifactBytes,
} from "./baseline-freeze-v2";
import { verifyBaselineFreezeV2AuthoritySignature } from "./baseline-freeze-v2-authority";
import { hashCanonicalJson, sha256Digest, type JsonValue } from "./provenance-crypto";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const privateRoot = path.join(
  repositoryRoot,
  ".research-private/exp0001a-baseline-v2-capture-20260831-run5",
);

function read(relativePath: string) {
  return readFileSync(path.join(repositoryRoot, relativePath));
}

function exactArtifacts(): BaselineV2ArtifactBytes {
  return {
    receiptFileBytes: read("research/data/baseline-freeze-v2.json"),
    inventoryFileBytes: read("research/data/baseline-webmcp-inventory-v2.json"),
    evidenceFileBytes: read("research/data/baseline-production-evidence-v2.json"),
    captureScriptBytes: read("research/scripts/capture-baseline-v2.mjs"),
    privateInventoryFileBytes: readFileSync(path.join(privateRoot, "baseline-webmcp-inventory-private-v2.json")),
    semanticArtifactFileBytes: readFileSync(path.join(privateRoot, "baseline-semantic-artifact-redacted-v2.json")),
    semanticHandlerFileBytes: readFileSync(path.join(privateRoot, "baseline-semantic-handler-redacted-v2.json")),
    authoritativeStateFileBytes: readFileSync(path.join(privateRoot, "baseline-authoritative-state-redacted-v2.json")),
    captureHistoryFileBytes: read(".research-private/exp0001a-baseline-v2-capture-history-run5.json"),
    exactRevisionPngBytes: readFileSync(path.join(privateRoot, "baseline-exact-revision-v2.png")),
    authoritySignature: signatureJson,
    authoritySignatureFileBytes: read("research/data/baseline-freeze-v2-authority-signature.json"),
    authorityPublicKeyFileBytes: read("research/data/exp0001a-execution-authority-public.pem"),
  };
}

describe("EXP-0001A signed production baseline v2", () => {
  it("verifies every public and private byte required for execution readiness", () => {
    const result = verifyBaselineV2ExecutionReady(receiptJson, inventoryJson, evidenceJson, exactArtifacts());
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(Object.values(result.verifiedBytes).every((digest) => digest !== null)).toBe(true);
    expect(computeBaselineFreezeReceiptV2Digest(result.receipt)).toBe(receiptJson.receiptDigest);
    expect(verifyBaselineFreezeV2AuthoritySignature({
      receipt: result.receipt as unknown as JsonValue,
      signature: signatureJson,
      notBefore: result.receipt.frozenAt,
    })).toMatchObject({ keyPurpose: "baseline_freeze_v2" });
  });

  it("preserves v1 byte-for-byte and explicitly supersedes both of its identities", () => {
    const v1Bytes = read("research/data/baseline-freeze-v1.json");
    expect(sha256Digest(v1Bytes)).toBe("sha256:399c72b595b8d06bc11a03f0d44fb99938e5e5de8dcb8f3e708700b01579d165");
    expect(receiptJson.supersedes).toEqual({
      receiptPath: "research/data/baseline-freeze-v1.json",
      receiptFileDigest: "sha256:399c72b595b8d06bc11a03f0d44fb99938e5e5de8dcb8f3e708700b01579d165",
      receiptDigest: "sha256:32fddd038f6ec696f633bc5ee28ec587540282dbbd1e451e5d2debeb67069b23",
    });
  });

  it("fails closed without private descriptors, semantic bytes, PNG, key, and signature", () => {
    expect(verifyBaselineV2(receiptJson, inventoryJson, evidenceJson)).toMatchObject({ ok: true });
    expect(verifyBaselineV2ExecutionReady(receiptJson, inventoryJson, evidenceJson, {})).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/authority signature|exact bytes/)]),
    });
  });

  it("rejects product substitution even with a recomputed self hash", () => {
    const tampered = structuredClone(receiptJson) as unknown as BaselineFreezeReceiptV2;
    (tampered.product as { gitCommit: string }).gitCommit = "0".repeat(40);
    tampered.receiptDigest = computeBaselineFreezeReceiptV2Digest(
      baselineFreezeReceiptV2Schema.parse({ ...receiptJson, receiptDigest: receiptJson.receiptDigest }),
    );
    expect(verifyBaselineV2(tampered, inventoryJson, evidenceJson, exactArtifacts())).toMatchObject({ ok: false });
  });

  it("rejects a private schema/annotation change that leaves the compact public names unchanged", () => {
    const artifacts = exactArtifacts();
    const privateInventory = JSON.parse(Buffer.from(artifacts.privateInventoryFileBytes!).toString("utf8"));
    privateInventory.participant.descriptors[0].annotations.readOnlyHint = true;
    artifacts.privateInventoryFileBytes = Buffer.from(`${JSON.stringify(privateInventory, null, 2)}\n`);
    const result = verifyBaselineV2ExecutionReady(receiptJson, inventoryJson, evidenceJson, artifacts);
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/private inventory|definition projection/)]),
    });
  });

  it("rejects receipt tampering under the fixed authority signature", () => {
    const tampered = structuredClone(receiptJson) as unknown as BaselineFreezeReceiptV2;
    (tampered.capture.exactRevisionPng as { width: number }).width += 1;
    const content = structuredClone(tampered) as Record<string, unknown>;
    delete content.receiptDigest;
    tampered.receiptDigest = hashCanonicalJson(content);
    const result = verifyBaselineV2ExecutionReady(tampered, inventoryJson, evidenceJson, exactArtifacts());
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/Authority signature|receipt file/)]),
    });
  });
});
