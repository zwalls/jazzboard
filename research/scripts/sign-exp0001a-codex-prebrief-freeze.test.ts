// @vitest-environment node

import { generateKeyPairSync, verify as verifyEd25519 } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const signerModulePath: string = "./sign-exp0001a-codex-prebrief-freeze.mjs";
const {
  EXP0001A_CODEX_PREBRIEF_SIGNATURE_DOMAIN,
  assertNoExp0001aReleaseEvidenceForTesting,
  canonicalPrebriefFreezeJson,
  createExp0001aPrebriefFreezeSignatureForTesting,
  parseExp0001aPrebriefFreezeSignerArgs,
} = await import(signerModulePath);

describe("EXP-0001A immutable prebrief freeze signer", () => {
  it("signs only the exact freeze payload under the dedicated authority purpose", () => {
    const authority = generateKeyPairSync("ed25519");
    const freeze = Object.freeze({
      schemaVersion: "exp-0001a-codex-prebrief-freeze/v2",
      executionStateAtFreeze: "not_started",
      briefReleaseAuthorized: false,
      freezeDigest: `sha256:${"1".repeat(64)}`,
    });
    const signature = createExp0001aPrebriefFreezeSignatureForTesting({
      freeze,
      signedAt: "2026-08-31T06:00:00.000Z",
      authority,
    });
    const { signatureBase64, ...content } = signature;
    expect(content.purpose).toBe("prebrief_freeze");
    expect(verifyEd25519(
      null,
      Buffer.from(`${EXP0001A_CODEX_PREBRIEF_SIGNATURE_DOMAIN}${canonicalPrebriefFreezeJson(content)}`, "utf8"),
      authority.publicKey,
      Buffer.from(signatureBase64, "base64"),
    )).toBe(true);
    expect(signature.payloadDigest).not.toBe(
      createExp0001aPrebriefFreezeSignatureForTesting({
        freeze: { ...freeze, briefReleaseAuthorized: true },
        signedAt: signature.signedAt,
        authority,
      }).payloadDigest,
    );
  });

  it("exposes no caller-controlled path, key, payload, or signing time", () => {
    expect(parseExp0001aPrebriefFreezeSignerArgs(["--sign"])).toEqual({ mode: "sign" });
    expect(parseExp0001aPrebriefFreezeSignerArgs(["--check-readiness"])).toEqual({ mode: "check-readiness" });
    expect(() => parseExp0001aPrebriefFreezeSignerArgs([
      "--sign", "--freeze", "/tmp/forged.json",
    ])).toThrow(/Usage/);
    expect(() => parseExp0001aPrebriefFreezeSignerArgs([
      "--sign", "--signed-at", "2020-01-01T00:00:00.000Z",
    ])).toThrow(/Usage/);
  });

  it("finds nested and renamed protocol evidence across the full inventory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "exp0001a-no-release-scan-"));
    try {
      const publicRoot = path.join(root, "public");
      await mkdir(path.join(publicRoot, "innocent-name", "deep"), { recursive: true });
      await writeFile(path.join(publicRoot, "innocent-name", "deep", "opaque.json"),
        JSON.stringify({ protocolId: "EXP-0001A", kind: "codex-coordinator-journal" }));
      await expect(assertNoExp0001aReleaseEvidenceForTesting([
        { root: publicRoot, mode: "protocol_marker" },
      ])).rejects.toThrow(/REFUSES_EXISTING_RELEASE_EVIDENCE:innocent-name\/deep\/opaque.json/);

      const privateRoot = path.join(root, "private");
      await mkdir(path.join(privateRoot, "arbitrary-output", "authority-journal"), { recursive: true });
      await writeFile(path.join(privateRoot, "arbitrary-output", "authority-journal", "000001.json"), "{}");
      await expect(assertNoExp0001aReleaseEvidenceForTesting([
        { root: privateRoot, mode: "private_inventory" },
      ])).rejects.toThrow(/REFUSES_EXISTING_RELEASE_EVIDENCE:arbitrary-output\/authority-journal\/000001.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only schema-bounded disposable-spike rejection prerequisites", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "exp0001a-spike-rejection-scan-"));
    try {
      const privateRoot = path.join(root, "private");
      const rejectionRoot = path.join(privateRoot, "exp0001a-spike-rejections");
      await mkdir(rejectionRoot, { recursive: true });
      const rejection = {
        schemaVersion: 1,
        kind: "disposable-codex-webmcp-spike-rejection",
        spikeVersion: 12,
        taskId: "01a056b7-8d0b-7dc3-8f51-7a996d84b133",
        roomIdentityDigest: `sha256:${"a".repeat(64)}`,
        terminalOutcome: "infra_failure",
        reason: "Disposable transport spike stopped before eligibility.",
        begunAt: 100,
        terminalAt: 101,
        retainedEvidenceDirectory: "../exp0001a-codex-spike-v12",
      };
      const filePath = path.join(rejectionRoot, "v12.json");
      await writeFile(filePath, JSON.stringify(rejection));
      await expect(assertNoExp0001aReleaseEvidenceForTesting([
        { root: privateRoot, mode: "private_inventory" },
      ])).resolves.toBeUndefined();

      await writeFile(filePath, JSON.stringify({ ...rejection, experimentBrief: "must remain forbidden" }));
      await expect(assertNoExp0001aReleaseEvidenceForTesting([
        { root: privateRoot, mode: "private_inventory" },
      ])).rejects.toThrow(/REFUSES_EXISTING_RELEASE_EVIDENCE:exp0001a-spike-rejections\/v12.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
