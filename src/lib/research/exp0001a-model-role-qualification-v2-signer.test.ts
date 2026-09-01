// @vitest-environment node

import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createQualificationV2AuthoritySignature,
  parseQualificationV2SignerArgs,
} from "./exp0001a-model-role-qualification-v2-signer";
import { hashCanonicalJson } from "./provenance-crypto";

describe("EXP-0001A qualification-v2 signer", () => {
  it("parses only exact absolute plan, launch-binding, and result commands", () => {
    expect(parseQualificationV2SignerArgs([
      "--purpose", "launch-binding",
      "--input", "/private/input.json",
      "--output", "/private/output.json",
    ])).toMatchObject({ purpose: "qualification_launch_binding" });
    expect(() => parseQualificationV2SignerArgs([
      "--purpose", "result",
      "--input", "relative.json",
      "--state", "/private/state.json",
      "--attestation", "/private/attestation.json",
      "--output", "/private/output.json",
    ])).toThrow("PATH_INVALID");
    expect(parseQualificationV2SignerArgs([
      "--purpose", "result",
      "--input", "/private/result.json",
      "--state", "/private/state.json",
      "--attestation", "/private/attestation.json",
      "--output", "/private/output.json",
    ])).toMatchObject({
      purpose: "qualification_result",
      statePath: "/private/state.json",
      attestationPath: "/private/attestation.json",
    });
    expect(() => parseQualificationV2SignerArgs([
      "--purpose", "provider",
      "--input", "/private/input.json",
      "--output", "/private/output.json",
    ])).toThrow("PURPOSE_INVALID");
  });

  it("signs the exact canonical payload and self-checks Ed25519 bytes", () => {
    const authority = generateKeyPairSync("ed25519");
    const payload = { schemaVersion: "fixture/v1", decision: "pass" } as const;
    const signature = createQualificationV2AuthoritySignature({
      payload,
      purpose: "qualification_result",
      signedAt: "2026-08-31T21:00:00.000Z",
      privateKey: authority.privateKey,
      publicKey: authority.publicKey,
    });
    expect(signature).toMatchObject({
      purpose: "qualification_result",
      payloadDigest: hashCanonicalJson(payload),
      algorithm: "Ed25519",
    });
    expect(Buffer.from(signature.signatureBase64, "base64")).toHaveLength(64);
  });
});
