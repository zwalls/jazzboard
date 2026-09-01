// @vitest-environment node

import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BASELINE_FREEZE_V2_AUTHORITY_KEY_PURPOSE,
  BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_VERSION,
  baselineFreezeV2AuthoritySignatureSchema,
  verifyBaselineFreezeV2AuthoritySignature,
} from "./baseline-freeze-v2-authority";
import {
  createBaselineFreezeV2AuthoritySignature,
  parseBaselineFreezeV2SignerArgs,
} from "./baseline-freeze-v2-signer";

describe("baseline-freeze/v2 authority", () => {
  it("uses a dedicated versioned purpose and rejects a non-authority key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const receipt = { schemaVersion: "baseline-freeze/v2", receiptDigest: `sha256:${"1".repeat(64)}` };
    const signature = createBaselineFreezeV2AuthoritySignature({
      receipt,
      signedAt: "2026-08-31T20:00:00.000Z",
      privateKey,
      publicKey,
    });
    expect(signature).toMatchObject({
      schemaVersion: BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_VERSION,
      keyPurpose: BASELINE_FREEZE_V2_AUTHORITY_KEY_PURPOSE,
      payloadSchema: "baseline-freeze/v2",
    });
    expect(() => verifyBaselineFreezeV2AuthoritySignature({ receipt, signature }))
      .toThrow("BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_INVALID");
  });

  it("rejects purpose or schema substitution before crypto verification", () => {
    const invalid = {
      schemaVersion: BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_VERSION,
      protocolId: "EXP-0001A",
      kind: "baseline-freeze-authority-signature",
      algorithm: "Ed25519",
      keyId: "exp0001a-launch-authority-2026-08-30",
      keyPurpose: "qualification_plan",
      publicKeyPath: "research/data/exp0001a-execution-authority-public.pem",
      publicKeyDigest: "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de",
      signedAt: "2026-08-31T20:00:00.000Z",
      payloadSchema: "baseline-freeze/v2",
      payloadDigest: `sha256:${"1".repeat(64)}`,
      signatureBase64: `${"A".repeat(86)}==`,
    };
    expect(baselineFreezeV2AuthoritySignatureSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts only two explicit absolute signer paths", () => {
    expect(parseBaselineFreezeV2SignerArgs([
      "--input", "/tmp/baseline-freeze-v2.json",
      "--output", "/tmp/baseline-freeze-v2-signature.json",
    ])).toEqual({
      inputPath: "/tmp/baseline-freeze-v2.json",
      outputPath: "/tmp/baseline-freeze-v2-signature.json",
    });
    expect(() => parseBaselineFreezeV2SignerArgs(["--input", "relative.json", "--output", "/tmp/out.json"]))
      .toThrow("BASELINE_FREEZE_V2_SIGNER_PATH_INVALID");
  });
});
