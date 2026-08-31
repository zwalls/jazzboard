import { describe, expect, it } from "vitest";

import {
  verifyExp0001aCodexAuthoritySignature,
  verifyExp0001aCodexAuthoritySignatureEnvelope,
  type Exp0001aCodexAuthoritySignature,
} from "./exp0001a-codex-authority";

const payload = { kind: "fixture", value: 1 } as const;
const signature: Exp0001aCodexAuthoritySignature = {
  schemaVersion: "exp-0001a-codex-authority-signature/v1",
  protocolId: "EXP-0001A",
  kind: "codex-authority-signature",
  algorithm: "Ed25519",
  keyId: "exp0001a-launch-authority-2026-08-30",
  publicKeyDigest: "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de",
  signedAt: "2026-08-31T05:00:00.000Z",
  purpose: "coordinator_checkpoint",
  payloadDigest: "sha256:49d5e583b34fb41ecb0290c0b443fea2b5d7298166d6d5484f432cce224570e1",
  signatureBase64: "zhkvx7HldJxyxlYtUOwarCd2d8AcY1RdHH0z05Tt6l0k+KWFhxIKkoHbcN28/4ioCvsAdp7pUjOFpDuXRxxoDg==",
};

describe("EXP-0001A fixed Codex authority", () => {
  it("accepts a payload only under the precommitted Ed25519 trust anchor", () => {
    expect(verifyExp0001aCodexAuthoritySignature({
      payload,
      signature,
      purpose: "coordinator_checkpoint",
    })).toEqual(signature);
  });

  it("rejects caller rehashes, wrong purpose, and signature tampering", () => {
    expect(() => verifyExp0001aCodexAuthoritySignature({
      payload: { ...payload, value: 2 },
      signature,
      purpose: "coordinator_checkpoint",
    })).toThrow(/PAYLOAD_BINDING/);
    expect(() => verifyExp0001aCodexAuthoritySignature({
      payload,
      signature,
      purpose: "completion_attestation",
    })).toThrow(/PAYLOAD_BINDING/);
    expect(() => verifyExp0001aCodexAuthoritySignature({
      payload,
      signature: { ...signature, signatureBase64: `${signature.signatureBase64.slice(0, -3)}AAA` },
      purpose: "coordinator_checkpoint",
    })).toThrow();
  });

  it("verifies a redacted public projection's fixed-key signature envelope without claiming its private payload", () => {
    expect(verifyExp0001aCodexAuthoritySignatureEnvelope({
      signature,
      purpose: "coordinator_checkpoint",
      notBefore: "2026-08-31T04:59:59.000Z",
    })).toEqual(signature);
    expect(() => verifyExp0001aCodexAuthoritySignatureEnvelope({
      signature,
      purpose: "spike_gate",
    })).toThrow(/PURPOSE/);
  });
});
