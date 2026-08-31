// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  EXP0001A_COMPLETION_AUTHORITY_BLOCKERS,
  EXP0001A_REVOKED_COMPLETION_PAYLOAD_DIGESTS,
  assertExp0001aCompletionPayloadNotRevoked,
  createExp0001aCodexCompletionAttestation,
  exp0001aCodexCompletionAttestationDraftSchema,
  exp0001aCodexCompletionAttestationSchema,
  retainExp0001aCodexCompletionAttestation,
  verifyExp0001aCodexCompletionAttestation,
} from "./exp0001a-completion-attestation";

describe("EXP-0001A Codex-native completion authority", () => {
  it("installs the fixed detached authority while permanently denying the leaked synthetic payload", () => {
    expect(EXP0001A_COMPLETION_AUTHORITY_BLOCKERS).toEqual([]);
    expect(EXP0001A_REVOKED_COMPLETION_PAYLOAD_DIGESTS).toEqual([
      "sha256:4b061142c4dffa3b6393d7966515926c343647f6cb3c40457b7382df4a03f757",
    ]);
    expect(() => assertExp0001aCompletionPayloadNotRevoked(
      EXP0001A_REVOKED_COMPLETION_PAYLOAD_DIGESTS[0],
    )).toThrow(/PAYLOAD_REVOKED/);
    expect(() => assertExp0001aCompletionPayloadNotRevoked(`sha256:${"b".repeat(64)}`)).not.toThrow();
  });

  it("rejects unsigned, provider-era, caller-built, and unverified retention claims", async () => {
    expect(() => exp0001aCodexCompletionAttestationSchema.parse({})).toThrow();
    expect(() => exp0001aCodexCompletionAttestationDraftSchema.parse({
      schemaVersion: "exp-0001a-codex-completion-attestation/v2",
      authorizedMaximumUsd: 100,
    })).toThrow();
    expect(() => createExp0001aCodexCompletionAttestation({} as never)).toThrow();
    expect(() => verifyExp0001aCodexCompletionAttestation({} as never)).toThrow();
    await expect(retainExp0001aCodexCompletionAttestation({} as never)).rejects.toThrow();
  });
});
