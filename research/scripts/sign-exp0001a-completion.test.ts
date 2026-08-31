// @vitest-environment node

import { createHash, generateKeyPairSync, randomUUID, verify as verifyEd25519 } from "node:crypto";
import { link, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const signerModulePath: string = "./sign-exp0001a-completion.mjs";
const {
  COMPLETION_SIGNATURE_DOMAIN,
  canonicalJson,
  createExp0001aCompletionSignature,
  parseExp0001aCompletionDraft,
  parseExp0001aCompletionSignerArgs,
  publishExp0001aCompletionAttestation,
} = await import(signerModulePath);

const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const d = digest("fixture");

function draft() {
  const content = {
    schemaVersion: "exp-0001a-codex-completion-attestation/v2",
    kind: "exp-0001a-codex-experiment-complete",
    protocolId: "EXP-0001A",
    completedAt: "2026-08-31T05:00:00.000Z",
    lineage: { freezeDigest: d },
    schedule: { assignmentCount: 48, terminalAssignmentCount: 48 },
    transport: { begunTerminalTaskCount: 168 },
    review: { analysisReportDigest: d },
    accounting: { codexTaskCount: 168 },
    scientificControls: { chatGptSubscriptionTransportOnly: true },
  };
  return { ...content, completionDigest: digest(canonicalJson(content)) };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function publicationFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "exp0001a-completion-publication-"));
  temporaryDirectories.push(directory);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyBytes = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyBytes = publicKey.export({ type: "spki", format: "pem" });
  const expectedPublicKeyDigest = digest(publicKeyBytes);
  const expectedKeyId = "fixture-key";
  const completionDraft = draft();
  const signAt = (signedAt: string, candidate = completionDraft) => createExp0001aCompletionSignature({
    draft: candidate,
    privateKeyBytes,
    publicKeyBytes,
    expectedPublicKeyDigest,
    expectedKeyId,
    signedAt,
  });
  return {
    directory,
    outputPath: path.join(directory, "codex-completion-attestation.json"),
    completionDraft,
    publicKeyBytes,
    expectedPublicKeyDigest,
    expectedKeyId,
    signAt,
  };
}

describe("EXP-0001A fixed completion signer", () => {
  it("signs the exact v2 draft with a matching Ed25519 key and Codex authority domain", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyBytes = privateKey.export({ type: "pkcs8", format: "pem" });
    const publicKeyBytes = publicKey.export({ type: "spki", format: "pem" });
    const publicKeyDigest = digest(publicKeyBytes);
    const signed = createExp0001aCompletionSignature({
      draft: draft(),
      privateKeyBytes,
      publicKeyBytes,
      expectedPublicKeyDigest: publicKeyDigest,
      expectedKeyId: "fixture-key",
      signedAt: "2026-08-31T05:05:00.000Z",
    });
    const { signatureBase64, ...content } = signed.authoritySignature;
    expect(content.purpose).toBe("completion_attestation");
    expect(content.payloadDigest).toBe(digest(canonicalJson(draft())));
    expect(verifyEd25519(
      null,
      Buffer.from(`${COMPLETION_SIGNATURE_DOMAIN}${canonicalJson(content)}`, "utf8"),
      publicKey,
      Buffer.from(signatureBase64, "base64"),
    )).toBe(true);
  });

  it("rejects stale, pre-evidence, wrong-key, tampered, provider-billed, and legacy drafts", () => {
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ed25519");
    const privateKeyBytes = first.privateKey.export({ type: "pkcs8", format: "pem" });
    const publicKeyBytes = first.publicKey.export({ type: "spki", format: "pem" });
    const publicKeyDigest = digest(publicKeyBytes);
    const base = { draft: draft(), privateKeyBytes, publicKeyBytes, expectedPublicKeyDigest: publicKeyDigest, expectedKeyId: "fixture-key" };
    expect(() => createExp0001aCompletionSignature({ ...base, signedAt: "2026-08-31T04:59:59.000Z" })).toThrow(/signing window/);
    expect(() => createExp0001aCompletionSignature({ ...base, signedAt: "2026-08-31T05:15:00.001Z" })).toThrow(/signing window/);
    expect(() => createExp0001aCompletionSignature({ ...base,
      publicKeyBytes: second.publicKey.export({ type: "spki", format: "pem" }), signedAt: "2026-08-31T05:01:00.000Z" })).toThrow(/trust anchor/);
    expect(() => parseExp0001aCompletionDraft({ ...draft(), completedAt: "2026-09-01T00:00:00.000Z" })).toThrow(/digest/);
    expect(() => parseExp0001aCompletionDraft({ ...draft(), authorizedMaximumUsd: 10 })).toThrow(/schema/);
    expect(() => parseExp0001aCompletionDraft({ ...draft(), schemaVersion: "exp-0001a-completion-attestation/v1" })).toThrow(/v2 schema/);
  });

  it("requires an explicit approved completion digest for a run", () => {
    expect(parseExp0001aCompletionSignerArgs(["--check-readiness"])).toEqual({ mode: "check-readiness" });
    expect(() => parseExp0001aCompletionSignerArgs(["--run-root", "/tmp/run"])).toThrow(/Usage/);
    expect(() => parseExp0001aCompletionSignerArgs([
      "--run-root", "/tmp/run", "--approved-completion-digest", d,
      "--signed-at", "2026-08-31T05:01:00.000Z",
    ])).toThrow(/Unknown/);
    expect(parseExp0001aCompletionSignerArgs([
      "--run-root", "/tmp/run", "--approved-completion-digest", d,
    ])).toMatchObject({ mode: "sign", runRoot: "/tmp/run", approvedCompletionDigest: d });
  });

  it("atomically publishes once and deterministically reuses the original signedAt and signature", async () => {
    const fixture = await publicationFixture();
    const firstAttestation = fixture.signAt("2026-08-31T05:01:00.000Z");
    const laterAttestation = fixture.signAt("2026-08-31T05:02:00.000Z");
    const base = {
      outputPath: fixture.outputPath,
      draft: fixture.completionDraft,
      publicKeyBytes: fixture.publicKeyBytes,
      expectedPublicKeyDigest: fixture.expectedPublicKeyDigest,
      expectedKeyId: fixture.expectedKeyId,
    };
    const first = await publishExp0001aCompletionAttestation({ ...base, attestation: firstAttestation });
    const retainedBytes = await readFile(fixture.outputPath);
    const replay = await publishExp0001aCompletionAttestation({ ...base, attestation: laterAttestation });

    expect(first.reused).toBe(false);
    expect(replay.reused).toBe(true);
    expect(replay.attestation.authoritySignature.signedAt).toBe("2026-08-31T05:01:00.000Z");
    expect(replay.attestation.authoritySignature.signatureBase64)
      .toBe(firstAttestation.authoritySignature.signatureBase64);
    expect(await readFile(fixture.outputPath)).toEqual(retainedBytes);
    expect((await lstat(fixture.outputPath)).nlink).toBe(1);
  });

  it("survives an orphan partial temporary and recovers the valid post-link pre-cleanup boundary", async () => {
    const fixture = await publicationFixture();
    const attestation = fixture.signAt("2026-08-31T05:01:00.000Z");
    const orphanTemporary = path.join(
      fixture.directory,
      `.codex-completion-attestation.json-${process.pid}-${randomUUID()}.tmp`,
    );
    await writeFile(orphanTemporary, "{\"truncated\":", { mode: 0o600 });
    const base = {
      outputPath: fixture.outputPath,
      draft: fixture.completionDraft,
      attestation,
      publicKeyBytes: fixture.publicKeyBytes,
      expectedPublicKeyDigest: fixture.expectedPublicKeyDigest,
      expectedKeyId: fixture.expectedKeyId,
    };
    await expect(publishExp0001aCompletionAttestation(base)).resolves.toMatchObject({ reused: false });

    const second = await publicationFixture();
    const boundaryAttestation = second.signAt("2026-08-31T05:03:00.000Z");
    const publicationTemporary = path.join(
      second.directory,
      `.codex-completion-attestation.json-${process.pid}-${randomUUID()}.tmp`,
    );
    await writeFile(publicationTemporary, `${canonicalJson(boundaryAttestation)}\n`, { mode: 0o600 });
    await link(publicationTemporary, second.outputPath);
    expect((await lstat(second.outputPath)).nlink).toBe(2);
    const replay = await publishExp0001aCompletionAttestation({
      outputPath: second.outputPath,
      draft: second.completionDraft,
      attestation: second.signAt("2026-08-31T05:04:00.000Z"),
      publicKeyBytes: second.publicKeyBytes,
      expectedPublicKeyDigest: second.expectedPublicKeyDigest,
      expectedKeyId: second.expectedKeyId,
    });
    expect(replay.reused).toBe(true);
    expect(replay.attestation.authoritySignature.signedAt).toBe("2026-08-31T05:03:00.000Z");
    expect((await lstat(second.outputPath)).nlink).toBe(1);
    expect(await readdir(second.directory)).toEqual(["codex-completion-attestation.json"]);
  });

  it("refuses to overwrite a partial canonical file or a valid conflicting attestation", async () => {
    const partial = await publicationFixture();
    await writeFile(partial.outputPath, "{\"truncated\":", { mode: 0o600 });
    await expect(publishExp0001aCompletionAttestation({
      outputPath: partial.outputPath,
      draft: partial.completionDraft,
      attestation: partial.signAt("2026-08-31T05:01:00.000Z"),
      publicKeyBytes: partial.publicKeyBytes,
      expectedPublicKeyDigest: partial.expectedPublicKeyDigest,
      expectedKeyId: partial.expectedKeyId,
    })).rejects.toThrow(/not valid JSON; refusing to overwrite/);
    expect(await readFile(partial.outputPath, "utf8")).toBe("{\"truncated\":");

    const conflict = await publicationFixture();
    const { completionDigest: _priorDigest, ...otherContent } = conflict.completionDraft;
    void _priorDigest;
    const changedContent = { ...otherContent, schedule: { assignmentCount: 47, terminalAssignmentCount: 47 } };
    const changedDraft = { ...changedContent, completionDigest: digest(canonicalJson(changedContent)) };
    const conflictingAttestation = conflict.signAt("2026-08-31T05:01:00.000Z", changedDraft);
    await writeFile(conflict.outputPath, `${canonicalJson(conflictingAttestation)}\n`, { mode: 0o600 });
    await expect(publishExp0001aCompletionAttestation({
      outputPath: conflict.outputPath,
      draft: conflict.completionDraft,
      attestation: conflict.signAt("2026-08-31T05:02:00.000Z"),
      publicKeyBytes: conflict.publicKeyBytes,
      expectedPublicKeyDigest: conflict.expectedPublicKeyDigest,
      expectedKeyId: conflict.expectedKeyId,
    })).rejects.toThrow(/conflicts with the exact reconstructed draft/);
  });

  it("serializes concurrent no-clobber publications onto one valid authority result", async () => {
    const fixture = await publicationFixture();
    const base = {
      outputPath: fixture.outputPath,
      draft: fixture.completionDraft,
      publicKeyBytes: fixture.publicKeyBytes,
      expectedPublicKeyDigest: fixture.expectedPublicKeyDigest,
      expectedKeyId: fixture.expectedKeyId,
    };
    const results = await Promise.all([
      publishExp0001aCompletionAttestation({
        ...base,
        attestation: fixture.signAt("2026-08-31T05:01:00.000Z"),
      }),
      publishExp0001aCompletionAttestation({
        ...base,
        attestation: fixture.signAt("2026-08-31T05:02:00.000Z"),
      }),
    ]);
    expect(results.filter((result: { reused: boolean }) => !result.reused)).toHaveLength(1);
    expect(new Set(results.map((result: { attestation: { authoritySignature: { signatureBase64: string } } }) =>
      result.attestation.authoritySignature.signatureBase64)).size).toBe(1);
    expect(await readdir(fixture.directory)).toEqual(["codex-completion-attestation.json"]);
  });
});
