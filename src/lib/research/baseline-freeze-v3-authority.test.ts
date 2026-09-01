// @vitest-environment node

import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BASELINE_FREEZE_V3_AUTHORITY_KEY_PURPOSE,
  BASELINE_FREEZE_V3_AUTHORITY_SIGNATURE_VERSION,
  baselineFreezeV3AuthoritySignatureSchema,
  verifyBaselineFreezeV3AuthoritySignature,
} from "./baseline-freeze-v3-authority";
import {
  createBaselineFreezeV3AuthoritySignature,
  parseBaselineFreezeV3SignerArgs,
} from "./baseline-freeze-v3-signer";

describe("baseline-freeze/v3 authority", () => {
  it("uses a dedicated versioned purpose and rejects a non-authority key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const receipt = { schemaVersion: "baseline-freeze/v3", receiptDigest: `sha256:${"1".repeat(64)}` };
    const signature = createBaselineFreezeV3AuthoritySignature({
      receipt,
      signedAt: "2026-09-01T22:00:00.000Z",
      privateKey,
      publicKey,
    });
    expect(signature).toMatchObject({
      schemaVersion: BASELINE_FREEZE_V3_AUTHORITY_SIGNATURE_VERSION,
      keyPurpose: BASELINE_FREEZE_V3_AUTHORITY_KEY_PURPOSE,
      payloadSchema: "baseline-freeze/v3",
    });
    expect(() => verifyBaselineFreezeV3AuthoritySignature({ receipt, signature }))
      .toThrow("BASELINE_V3_AUTHORITY_SIGNATURE_INVALID");
  });

  it("rejects purpose substitution before crypto verification", () => {
    const invalid = {
      schemaVersion: BASELINE_FREEZE_V3_AUTHORITY_SIGNATURE_VERSION,
      kind: "baseline-freeze-authority-signature",
      algorithm: "Ed25519",
      keyId: "exp0001a-launch-authority-2026-08-30",
      publicKeyDigest: "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de",
      signedAt: "2026-09-01T22:00:00.000Z",
      keyPurpose: "qualification_plan",
      payloadSchema: "baseline-freeze/v3",
      payloadDigest: `sha256:${"1".repeat(64)}`,
      signatureBase64: `${"A".repeat(86)}==`,
    };
    expect(baselineFreezeV3AuthoritySignatureSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts only explicit absolute signer paths", () => {
    expect(parseBaselineFreezeV3SignerArgs([
      "--input", "/tmp/baseline-freeze-v3.json",
      "--output", "/tmp/baseline-freeze-v3-signature.json",
    ])).toEqual({
      inputPath: "/tmp/baseline-freeze-v3.json",
      outputPath: "/tmp/baseline-freeze-v3-signature.json",
    });
    expect(() => parseBaselineFreezeV3SignerArgs(["--input", "relative.json", "--output", "/tmp/out.json"]))
      .toThrow("BASELINE_FREEZE_V3_SIGNER_PATH_INVALID");
  });
});
