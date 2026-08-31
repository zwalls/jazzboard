// @vitest-environment node

import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_BROWSER_SKILL_PATH,
  computePrivateRoomAccessBinding,
  publicCodexWebMcpAaGateSchema,
  publicCodexWebMcpSpikeEvidenceSchema,
  verifyCodexWebMcpAaGateAuthority,
  type CodexWebMcpSpikeEvidenceContent,
} from "../../src/lib/research/codex-webmcp-spike";
import {
  EXP0001A_CODEX_AUTHORITY_KEY_ID,
  EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_DIGEST,
  EXP0001A_CODEX_AUTHORITY_SIGNATURE_VERSION,
  type Exp0001aCodexAuthoritySignature,
} from "../../src/lib/research/exp0001a-codex-authority";
import {
  CodexWebMcpSpikeSealError,
  retainAuthorizedCodexWebMcpAaGateFromDisk,
  sealCodexWebMcpSpikeFromDisk,
  type SealCodexWebMcpSpikeOptions,
} from "../../src/lib/research/codex-webmcp-spike-sealer";
import { canonicalJson, hashCanonicalJson } from "../../src/lib/research/provenance-crypto";

// Executable ESM wrapper intentionally has no declaration file.
// @ts-expect-error committed executable ESM wrapper intentionally has no typings
import { runCodexWebMcpSpikeSealCli } from "./seal-codex-webmcp-spike.mjs";
// @ts-expect-error committed executable ESM wrapper intentionally has no typings
import { runCodexWebMcpSpikeGateSignerCli } from "./sign-codex-webmcp-spike-gate.mjs";

const START = "2026-08-30T20:00:00.000Z";
const END = "2026-08-30T20:01:00.000Z";
const ROOM_ID = "room_12345678-abcd-efgh-ijkl-1234567890ab";
const ROOM_CODE = "ABC234";
const ROOM_URL = `https://www.jazzboard.xyz/#join=${ROOM_CODE}`;
const roots: string[] = [];

// Public, non-secret fixture over the deterministic gate draft produced below.
const FIXTURE_GATE_SIGNATURE: Exp0001aCodexAuthoritySignature = Object.freeze({
  schemaVersion: EXP0001A_CODEX_AUTHORITY_SIGNATURE_VERSION,
  protocolId: "EXP-0001A",
  kind: "codex-authority-signature",
  algorithm: "Ed25519",
  keyId: EXP0001A_CODEX_AUTHORITY_KEY_ID,
  publicKeyDigest: EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_DIGEST,
  signedAt: "2026-08-30T20:01:02.000Z",
  purpose: "spike_gate",
  payloadDigest: "sha256:2bb94e7ea7bfffbdfaadc1a0c7ba8d53ce45223e9aef779208210d611dd68b66",
  signatureBase64: "kuuFvZ9+GiRNRFySqtPWe/eM3Udla88/Wko4UbFmRTA6g9IFC3QtTpDPwvtSjpnf9iDXoWQ7u42bEN8MixqjCA==",
});

const ARTIFACT_FILES = {
  authPreflight: "artifacts/auth-preflight.json",
  promptEnvelope: "artifacts/prompt-envelope.json",
  taskCreationReceipt: "artifacts/task-creation.json",
  roomCreationReceipt: "artifacts/room-creation.json",
  platformBootstrapTrace: "artifacts/platform-bootstrap.json",
  isolationAttestation: "artifacts/isolation.json",
  webMcpTrace: "artifacts/webmcp-trace.json",
  terminalResult: "artifacts/terminal.json",
  semanticState: "artifacts/semantic-state.json",
  canvasImage: "artifacts/canvas.png",
} as const;

type ArtifactName = keyof typeof ARTIFACT_FILES;
type PassContent = Extract<CodexWebMcpSpikeEvidenceContent, { status: "pass" }>;

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digest(label: string): string {
  return digestBytes(Buffer.from(label, "utf8"));
}

function artifactSetRoot(artifacts: Record<string, { sha256: string; bytes: number; mimeType: string }>): string {
  return hashCanonicalJson({
    schemaVersion: 1,
    artifacts: Object.entries(artifacts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, artifact]) => ({ name, ...artifact })),
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp("/private/tmp/jazzboard-codex-spike-sealer-");
  roots.push(root);
  return root;
}

type Fixture = {
  root: string;
  requestFile: string;
  artifacts: PassContent["artifacts"];
  artifactBytes: Record<ArtifactName, Buffer>;
  artifactPaths: Record<ArtifactName, string>;
  content: PassContent;
  options: SealCodexWebMcpSpikeOptions;
};

async function passFixture(): Promise<Fixture> {
  const root = await temporaryRoot();
  const artifactsDirectory = path.join(root, "artifacts");
  await mkdir(artifactsDirectory, { recursive: true });
  const artifactBytes = {} as Record<ArtifactName, Buffer>;
  const artifactPaths = {} as Record<ArtifactName, string>;
  const mutableArtifacts = {} as Record<ArtifactName, { sha256: string; bytes: number; mimeType: string }>;
  for (const [name, relativePath] of Object.entries(ARTIFACT_FILES) as Array<[ArtifactName, string]>) {
    const bytes = name === "canvasImage"
      ? Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture-canvas")])
      : Buffer.from(canonicalJson(name === "promptEnvelope"
        ? { artifactRole: name, privateContext: ROOM_URL }
        : { artifactRole: name }), "utf8");
    const filePath = path.join(root, ...relativePath.split("/"));
    await writeFile(filePath, bytes, { mode: 0o600 });
    artifactBytes[name] = bytes;
    artifactPaths[name] = filePath;
    mutableArtifacts[name] = {
      sha256: digestBytes(bytes),
      bytes: bytes.length,
      mimeType: name === "canvasImage" ? "image/png" : "application/json",
    };
  }
  const artifacts: PassContent["artifacts"] = {
    ...mutableArtifacts,
    canvasImage: { ...mutableArtifacts.canvasImage, mimeType: "image/png" },
  };

  const toolNames = ["create_shape", "inspect_canvas", "join_room", "read_room_state"];
  const content: PassContent = {
    schemaVersion: 1,
    kind: "codex-webmcp-disposable-spike-evidence",
    spikeId: "spike-disposable-1",
    status: "pass",
    failureReasons: [],
    startedAt: START,
    completedAt: END,
    wallTimeMs: 60_000,
    auth: {
      method: "chatgpt",
      observedAt: "2026-08-30T20:00:01.000Z",
      preflightReceiptDigest: artifacts.authPreflight.sha256,
    },
    promptEnvelopeDigest: artifacts.promptEnvelope.sha256,
    task: {
      taskId: "codex-task-disposable-1",
      hostId: "local",
      createdAt: "2026-08-30T20:00:03.000Z",
      creationReceiptDigest: artifacts.taskCreationReceipt.sha256,
      creationMode: "fresh_projectless_task",
      workspaceKind: "projectless",
      projectId: null,
      sourceTaskId: null,
      forkedFromTaskId: null,
      sharedHistory: false,
      requestedModel: { id: "gpt-5.6-sol", reasoningEffort: "max", settingsFrozen: true },
      observedModel: { id: "unobservable", reasoningEffort: "unobservable" },
    },
    room: {
      roomId: ROOM_ID,
      privateRoomUrl: ROOM_URL,
      accessMode: "invite",
      privateAccessBindingDigest: computePrivateRoomAccessBinding({ privateRoomUrl: ROOM_URL, roomId: ROOM_ID }),
      createdAt: "unobservable",
      creationReceiptDigest: artifacts.roomCreationReceipt.sha256,
      creationMode: "fresh_private_room",
      visibility: "private",
    },
    platformBootstrap: {
      observed: true,
      at: "unobservable",
      operation: "read_installed_browser_skill",
      skillPath: CODEX_BROWSER_SKILL_PATH,
      skillFileDigest: digest("browser-skill"),
      traceArtifactDigest: artifacts.platformBootstrapTrace.sha256,
      workingDirectoryKind: "empty_projectless_workspace",
      commandExecutionCount: 1,
      filesystemReadCount: 1,
      filesystemWriteCount: 0,
      projectOrRepositoryReadCount: 0,
      otherCommandExecutionCount: 0,
      directHttpRequestCount: 0,
    },
    isolation: {
      repositoryAccess: "absent",
      privateApiAccess: "absent",
      openAiApiKeyAvailable: false,
      directProviderApiRequestCount: 0,
      directHttpRequestCount: 0,
      filesystemProjectContext: "empty_projectless_workspace",
      attestationDigest: artifacts.isolationAttestation.sha256,
    },
    webMcp: {
      surface: "browser-exposed",
      discoveredAt: "unobservable",
      toolNames,
      inventoryDigest: hashCanonicalJson({ surface: "browser-exposed", toolNames }),
      calls: [
        { sequence: 0, at: "unobservable", toolName: "join_room", kind: "lifecycle", status: "succeeded", argumentsDigest: digest("join-args"), resultDigest: digest("join-result"), failureCode: null, authoritativeRoomRevision: 0 },
        { sequence: 1, at: "unobservable", toolName: "read_room_state", kind: "read", status: "succeeded", argumentsDigest: digest("initial-args"), resultDigest: digest("initial-result"), failureCode: null, authoritativeRoomRevision: 0 },
        { sequence: 2, at: "2026-08-30T20:00:15.000Z", toolName: "create_shape", kind: "mutation", status: "succeeded", argumentsDigest: digest("create-args"), resultDigest: digest("create-result"), failureCode: null, authoritativeRoomRevision: 1 },
        { sequence: 3, at: "2026-08-30T20:00:25.000Z", toolName: "inspect_canvas", kind: "inspection", status: "succeeded", argumentsDigest: digest("inspect-args"), resultDigest: digest("inspect-result"), failureCode: null, authoritativeRoomRevision: 1 },
        { sequence: 4, at: "2026-08-30T20:00:35.000Z", toolName: "read_room_state", kind: "read", status: "succeeded", argumentsDigest: digest("final-args"), resultDigest: digest("final-result"), failureCode: null, authoritativeRoomRevision: 1 },
      ],
      traceArtifactDigest: artifacts.webMcpTrace.sha256,
    },
    terminal: {
      status: "completed",
      completedAt: END,
      resultDigest: artifacts.terminalResult.sha256,
    },
    authoritativeCanvas: {
      finalRoomRevision: 1,
      objectCount: 1,
      revisionObservations: [
        { sequence: 0, at: "unobservable", roomRevision: 0, sourceToolCallSequence: 1, semanticStateDigest: null, final: false },
        { sequence: 1, at: "unobservable", roomRevision: 1, sourceToolCallSequence: 4, semanticStateDigest: artifacts.semanticState.sha256, final: true },
      ],
      objectRevisions: [{ semanticObjectId: "shape-service-1", revision: 1 }],
      semanticStateDigest: artifacts.semanticState.sha256,
      canvasImageDigest: artifacts.canvasImage.sha256,
    },
    artifacts,
    artifactSetRoot: artifactSetRoot(artifacts),
  };
  const requestFile = path.join(root, "spike-input.json");
  await writeFile(requestFile, canonicalJson({
    schemaVersion: "codex-webmcp-spike-seal-request/v1",
    evidenceContent: content,
    artifactFiles: ARTIFACT_FILES,
  }), { mode: 0o600 });
  const privateRoot = path.join(root, ".research-private");
  return {
    root,
    requestFile,
    artifacts,
    artifactBytes,
    artifactPaths,
    content,
    options: {
      inputPath: root,
      privateRoot,
      privateEvidenceOutputPath: path.join(privateRoot, "spikes", "sealed-evidence.json"),
      publicEvidenceOutputPath: path.join(root, "public", "spike-evidence.json"),
      aaGateDraftOutputPath: path.join(privateRoot, "gates", "aa-allow.draft.json"),
      evaluatedAt: "2026-08-30T20:01:01.000Z",
    },
  };
}

async function expectSealCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => (
    error instanceof CodexWebMcpSpikeSealError && error.code === code
  ));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex/WebMCP spike evidence sealing CLI", () => {
  it("hashes exact artifacts, atomically retains private evidence, publishes only redacted evidence, and retains a verified PASS gate draft", async () => {
    const fixture = await passFixture();
    const result = await sealCodexWebMcpSpikeFromDisk(fixture.options);
    expect(result).toMatchObject({ status: "pass", aaGateDraftCreated: true });
    expect(result.privateEvidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.publicEvidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.aaGateDraftDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const privateBytes = await readFile(fixture.options.privateEvidenceOutputPath);
    expect(privateBytes.toString("utf8")).toContain(ROOM_ID);
    expect(privateBytes.toString("utf8")).toContain(ROOM_URL);
    const publicBytes = await readFile(fixture.options.publicEvidenceOutputPath);
    const publicEvidence = publicCodexWebMcpSpikeEvidenceSchema.parse(JSON.parse(publicBytes.toString("utf8")));
    expect(publicEvidence.room.privateLocation).toBe("[REDACTED]");
    expect(publicEvidence.task.taskIdentityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(publicBytes.toString("utf8")).not.toContain("codex-task-disposable-1");
    expect(publicBytes.toString("utf8")).not.toContain(ROOM_ID);
    expect(publicBytes.toString("utf8")).not.toContain(ROOM_CODE);
    expect(publicBytes.toString("utf8")).not.toContain(ROOM_URL);
    expect((await stat(fixture.options.privateEvidenceOutputPath)).mode & 0o777).toBe(0o600);
    expect((await stat(fixture.options.publicEvidenceOutputPath)).mode & 0o777).toBe(0o644);
    expect((await stat(fixture.options.aaGateDraftOutputPath)).mode & 0o777).toBe(0o600);

    await expect(sealCodexWebMcpSpikeFromDisk(fixture.options)).resolves.toEqual(result);
  });

  it("authorizes the exact retained draft with a committed non-secret signature fixture and publishes only a read-back-verified projection", async () => {
    const fixture = await passFixture();
    await sealCodexWebMcpSpikeFromDisk(fixture.options);
    const signedGateOutputPath = path.join(fixture.options.privateRoot, "gates", "aa-allow.signed.json");
    const publicGateOutputPath = path.join(fixture.root, "public", "aa-allow.json");
    const result = await retainAuthorizedCodexWebMcpAaGateFromDisk({
      privateRoot: fixture.options.privateRoot,
      privateEvidencePath: fixture.options.privateEvidenceOutputPath,
      aaGateDraftPath: fixture.options.aaGateDraftOutputPath,
      signedGateOutputPath,
      publicGateOutputPath,
      authoritySignature: FIXTURE_GATE_SIGNATURE,
    });

    expect(result).toMatchObject({
      status: "authorized",
      aaGateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      signedGateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      publicGateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    const signedGate = JSON.parse((await readFile(signedGateOutputPath, "utf8")));
    expect(verifyCodexWebMcpAaGateAuthority(signedGate).authoritySignature).toEqual(FIXTURE_GATE_SIGNATURE);
    const publicBytes = await readFile(publicGateOutputPath, "utf8");
    expect(publicCodexWebMcpAaGateSchema.parse(JSON.parse(publicBytes)).authoritySignature).toEqual(FIXTURE_GATE_SIGNATURE);
    expect(publicBytes).not.toContain(ROOM_ID);
    expect(publicBytes).not.toContain(ROOM_CODE);
    expect(publicBytes).not.toContain(ROOM_URL);
    expect((await stat(signedGateOutputPath)).mode & 0o777).toBe(0o600);
    expect((await stat(publicGateOutputPath)).mode & 0o777).toBe(0o644);
  });

  it("rejects a caller-forged spike-gate signature before retaining either signed output", async () => {
    const fixture = await passFixture();
    await sealCodexWebMcpSpikeFromDisk(fixture.options);
    const signedGateOutputPath = path.join(fixture.options.privateRoot, "gates", "forged.json");
    const publicGateOutputPath = path.join(fixture.root, "public", "forged.json");
    await expectSealCode(retainAuthorizedCodexWebMcpAaGateFromDisk({
      privateRoot: fixture.options.privateRoot,
      privateEvidencePath: fixture.options.privateEvidenceOutputPath,
      aaGateDraftPath: fixture.options.aaGateDraftOutputPath,
      signedGateOutputPath,
      publicGateOutputPath,
      authoritySignature: {
        ...FIXTURE_GATE_SIGNATURE,
        signatureBase64: `${FIXTURE_GATE_SIGNATURE.signatureBase64.slice(0, -3)}AAA`,
      },
    }), "AUTHORITY_SIGNATURE_INVALID");
    await expect(stat(signedGateOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(publicGateOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects byte-count and same-length digest mismatches before sealing anything", async () => {
    const bytesFixture = await passFixture();
    await writeFile(bytesFixture.artifactPaths.webMcpTrace, Buffer.concat([
      bytesFixture.artifactBytes.webMcpTrace,
      Buffer.from("x"),
    ]));
    await expectSealCode(sealCodexWebMcpSpikeFromDisk(bytesFixture.options), "ARTIFACT_BYTE_MISMATCH");

    const digestFixture = await passFixture();
    const changed = Buffer.from(digestFixture.artifactBytes.semanticState);
    changed[changed.length - 2] = changed[changed.length - 2] === 0x41 ? 0x42 : 0x41;
    await writeFile(digestFixture.artifactPaths.semanticState, changed);
    await expectSealCode(sealCodexWebMcpSpikeFromDisk(digestFixture.options), "ARTIFACT_DIGEST_MISMATCH");
  });

  it("fails closed when any referenced artifact is missing", async () => {
    const fixture = await passFixture();
    await unlink(fixture.artifactPaths.canvasImage);
    await expectSealCode(sealCodexWebMcpSpikeFromDisk(fixture.options), "ARTIFACT_MISSING");
    await expect(stat(fixture.options.privateEvidenceOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to create or retain any gate before the verified PASS completion time", async () => {
    const fixture = await passFixture();
    await expectSealCode(sealCodexWebMcpSpikeFromDisk({
      ...fixture.options,
      evaluatedAt: "2026-08-30T20:00:59.999Z",
    }), "AA_GATE_NOT_ALLOWED");
    await expect(stat(fixture.options.privateEvidenceOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.options.publicEvidenceOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.options.aaGateDraftOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a verified failure publicly and privately but never creates an allow gate", async () => {
    const fixture = await passFixture();
    const failContent: CodexWebMcpSpikeEvidenceContent = {
      schemaVersion: 1,
      kind: "codex-webmcp-disposable-spike-evidence",
      spikeId: "spike-failed-1",
      status: "fail",
      failureReasons: [{ code: "USAGE_LIMIT", phase: "author", at: END, message: "Usage limit interrupted the disposable task." }],
      startedAt: START,
      completedAt: END,
      wallTimeMs: 60_000,
      auth: null,
      promptEnvelopeDigest: null,
      task: null,
      room: null,
      platformBootstrap: null,
      isolation: null,
      webMcp: null,
      terminal: null,
      authoritativeCanvas: null,
      artifacts: {},
      artifactSetRoot: null,
    };
    await writeFile(fixture.requestFile, canonicalJson({
      schemaVersion: "codex-webmcp-spike-seal-request/v1",
      evidenceContent: failContent,
      artifactFiles: {},
    }), { mode: 0o600 });
    const result = await sealCodexWebMcpSpikeFromDisk(fixture.options);
    expect(result).toMatchObject({ status: "fail", aaGateDraftCreated: false, aaGateDraftDigest: null });
    await expect(stat(fixture.options.aaGateDraftOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("the executable CLI emits only digests/status and never private room material", async () => {
    const fixture = await passFixture();
    let stdout = "";
    let stderr = "";
    const exitCode = await runCodexWebMcpSpikeSealCli([
      "--input", ".",
      "--private-output", "cli/sealed.json",
      "--public-output", "public/cli.json",
      "--gate-draft-output", "cli/gate.draft.json",
      "--evaluated-at", "2026-08-30T20:01:01.000Z",
    ], {
      stdout: { write: (value: string) => { stdout += value; } },
      stderr: { write: (value: string) => { stderr += value; } },
    }, fixture.root);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain('"status":"pass"');
    expect(stdout).not.toContain(ROOM_ID);
    expect(stdout).not.toContain(ROOM_CODE);
    expect(stdout).not.toContain(ROOM_URL);
    expect(stdout).not.toContain(fixture.root);
  }, 30_000);

  it("the production signer CLI accepts no signature input and fails closed without its fixed mode-0600 private key", async () => {
    const fixture = await passFixture();
    await sealCodexWebMcpSpikeFromDisk(fixture.options);
    let stdout = "";
    let stderr = "";
    const exitCode = await runCodexWebMcpSpikeGateSignerCli([
      "--private-evidence", "spikes/sealed-evidence.json",
      "--gate-draft", "gates/aa-allow.draft.json",
      "--signed-gate-output", "gates/aa-allow.signed.json",
      "--public-gate-output", "public/aa-allow.json",
      "--signed-at", "2026-08-30T20:01:02.000Z",
    ], {
      stdout: { write: (value: string) => { stdout += value; } },
      stderr: { write: (value: string) => { stderr += value; } },
    }, fixture.root);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain('"errorCode":"AUTHORITY_PRIVATE_KEY_INVALID"');
    expect(stderr).not.toContain(ROOM_ID);
    expect(stderr).not.toContain(ROOM_CODE);
    expect(stderr).not.toContain(ROOM_URL);
  }, 30_000);
});
