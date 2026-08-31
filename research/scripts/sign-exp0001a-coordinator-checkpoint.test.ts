import { generateKeyPairSync, verify as verifyEd25519 } from "node:crypto";
import { describe, expect, it } from "vitest";

const signerModulePath: string = "./sign-exp0001a-coordinator-checkpoint.mjs";
const {
  canonicalJson,
  createExp0001aCoordinatorCheckpointSignatureForTesting,
  parseExp0001aCoordinatorCheckpointSignerArgs,
} = await import(signerModulePath);

const digest = (character: string) => `sha256:${character.repeat(64)}`;

describe("EXP-0001A coordinator checkpoint signer", () => {
  it("accepts only one normalized absolute config path", () => {
    expect(parseExp0001aCoordinatorCheckpointSignerArgs([
      "--config",
      "/tmp/exp0001a/checkpoint-config.json",
    ])).toEqual({ configPath: "/tmp/exp0001a/checkpoint-config.json" });
    expect(() => parseExp0001aCoordinatorCheckpointSignerArgs(["--config", "relative.json"]))
      .toThrow(/Usage/);
    expect(() => parseExp0001aCoordinatorCheckpointSignerArgs(["--config", "/"]))
      .toThrow(/Usage/);
  });

  it("signs a test draft only through an explicitly supplied ephemeral key", () => {
    const draft = { checkpointId: "checkpoint-test", authorizedActionDigest: digest("4") };
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signature = createExp0001aCoordinatorCheckpointSignatureForTesting({
      draft,
      signedAt: "2026-08-30T10:00:00.000Z",
      authority: { privateKey, publicKey },
    });
    const { signatureBase64, ...signatureContent } = signature;
    const message = Buffer.from(
      `Jazzboard EXP-0001A Codex authority v1\0${canonicalJson(signatureContent)}`,
      "utf8",
    );
    expect(verifyEd25519(null, message, publicKey, Buffer.from(signatureBase64, "base64"))).toBe(true);
  });
});
// @vitest-environment node
