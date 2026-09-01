// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import receiptJson from "../../../research/data/baseline-freeze-v3.json";
import signatureJson from "../../../research/data/baseline-freeze-v3-authority-signature.json";
import evidenceJson from "../../../research/data/baseline-production-evidence-v3.json";
import inventoryJson from "../../../research/data/baseline-webmcp-inventory-v3.json";
import {
  computeBaselineFreezeReceiptV3Digest,
  verifyBaselineV3ExecutionReady,
  type BaselineV3ArtifactBytes,
} from "./baseline-freeze-v3";
import {
  baselineFreezeV3AuthoritySignatureSchema,
  verifyBaselineFreezeV3AuthoritySignature,
} from "./baseline-freeze-v3-authority";
import { sha256Digest, type JsonValue } from "./provenance-crypto";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const privateRoot = path.join(repositoryRoot, ".research-private/exp0001a-baseline-v3-capture-20260901-run2");

function read(relativePath: string) {
  return readFileSync(path.join(repositoryRoot, relativePath));
}

function exactArtifacts(): BaselineV3ArtifactBytes {
  return {
    receiptFileBytes: read("research/data/baseline-freeze-v3.json"),
    inventoryFileBytes: read("research/data/baseline-webmcp-inventory-v3.json"),
    evidenceFileBytes: read("research/data/baseline-production-evidence-v3.json"),
    captureScriptBytes: read("research/scripts/capture-baseline-v3.mjs"),
    privateInventoryFileBytes: readFileSync(path.join(privateRoot, "baseline-webmcp-inventory-private-v2.json")),
    semanticArtifactFileBytes: readFileSync(path.join(privateRoot, "baseline-semantic-artifact-redacted-v2.json")),
    semanticHandlerFileBytes: readFileSync(path.join(privateRoot, "baseline-semantic-handler-redacted-v2.json")),
    authoritativeStateFileBytes: readFileSync(path.join(privateRoot, "baseline-authoritative-state-redacted-v2.json")),
    captureHistoryFileBytes: read(".research-private/exp0001a-baseline-v2-capture-history-run5.json"),
    exactRevisionPngBytes: readFileSync(path.join(privateRoot, "baseline-exact-revision-v2.png")),
    progressiveDraftStageFileBytes: readFileSync(path.join(privateRoot, "baseline-progressive-draft-stage-call-result-v3.json")),
    progressiveDraftFinishFileBytes: readFileSync(path.join(privateRoot, "baseline-progressive-draft-finish-call-result-v3.json")),
    authoritySignature: baselineFreezeV3AuthoritySignatureSchema.parse(signatureJson),
    authoritySignatureFileBytes: read("research/data/baseline-freeze-v3-authority-signature.json"),
    authorityPublicKeyFileBytes: read("research/data/exp0001a-execution-authority-public.pem"),
    predecessorReceiptFileBytes: read("research/data/baseline-freeze-v2.json"),
    predecessorAuthoritySignatureFileBytes: read("research/data/baseline-freeze-v2-authority-signature.json"),
    transportSpikeFileBytes: read("research/data/exp0001a-browser-attached-transport-spike-public-v1.json"),
  };
}

describe("EXP-0001A additive signed production baseline v3", () => {
  it("verifies the current deployment and every retained byte required for execution readiness", () => {
    const result = verifyBaselineV3ExecutionReady(receiptJson, inventoryJson, evidenceJson, exactArtifacts());
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(Object.values(result.verifiedBytes).every((digest) => digest !== null)).toBe(true);
    expect(computeBaselineFreezeReceiptV3Digest(result.receipt)).toBe(receiptJson.receiptDigest);
    expect(verifyBaselineFreezeV3AuthoritySignature({
      receipt: result.receipt as unknown as JsonValue,
      signature: baselineFreezeV3AuthoritySignatureSchema.parse(signatureJson),
      notBefore: result.receipt.frozenAt,
    })).toMatchObject({ keyPurpose: "baseline_freeze_v3" });
  });

  it("preserves the signed v2 predecessor byte-for-byte", () => {
    expect(sha256Digest(read("research/data/baseline-freeze-v2.json")))
      .toBe("sha256:db6431ea6f553f479d2eac3c6d58c996ff0cfc4778676e917c2d3bf704375b48");
    expect(sha256Digest(read("research/data/baseline-freeze-v2-authority-signature.json")))
      .toBe("sha256:f9bddd094f5d14b51783f808b4bb83bb97fed2f7b5887cba8199dbd7d83d3a19");
    expect(sha256Digest(read("research/data/baseline-webmcp-inventory-v2.json")))
      .toBe("sha256:0023a4729045292fff22a314d75bb2ec8e3e4b87d3e973eddb180942b84d15a8");
    expect(sha256Digest(read("research/data/baseline-production-evidence-v2.json")))
      .toBe("sha256:05dae0fc61193b577d5e3a5d77bf339c708744d0e4ee050504cf65f524e27d84");
    expect(sha256Digest(read("research/scripts/capture-baseline-v2.mjs")))
      .toBe("sha256:102ac23118d91d8a8782bf303885065f7afdef7fe208afe22bb6c85baf54b601");
    expect(receiptJson.supersedes.predecessorBytesMutated).toBe(false);
  });

  it("fails closed without the authority chain and retained exact bytes", () => {
    const result = verifyBaselineV3ExecutionReady(receiptJson, inventoryJson, evidenceJson, {});
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/authority signature|exact bytes/)]),
    });
  });

  it("rejects a substituted deployment identity", () => {
    const tampered = structuredClone(receiptJson) as Record<string, unknown>;
    (tampered.deployment as Record<string, unknown>).buildId = "bld_substituted";
    const result = verifyBaselineV3ExecutionReady(tampered, inventoryJson, evidenceJson, exactArtifacts());
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects altered progressive finish bytes even when the public summary is unchanged", () => {
    const exact = exactArtifacts();
    const finish = JSON.parse(Buffer.from(exact.progressiveDraftFinishFileBytes!).toString("utf8"));
    finish.data.roomRevision += 1;
    const artifacts: BaselineV3ArtifactBytes = {
      ...exact,
      progressiveDraftFinishFileBytes: Buffer.from(`${JSON.stringify(finish, null, 2)}\n`),
    };
    const result = verifyBaselineV3ExecutionReady(receiptJson, inventoryJson, evidenceJson, artifacts);
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/progressiveDraftFinishFile|finish evidence digest/)]),
    });
  });
});
