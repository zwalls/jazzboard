// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DevelopmentAttemptConfig } from "./development-attempt-config";
import {
  createCleanRoomBatchExecutor,
  retainedAttemptResult,
} from "./clean-room-batch-executor";
import { canonicalJson } from "./provenance-crypto";

const ATTEMPT_ID = "attempt-exp0001a-001";
const AUTHOR_IDENTITY_COMMITMENT = `sha256:${"1".repeat(64)}`;
const EXPECTED_PROVIDER_INTENT = {
  requestedModelIdentifier: "gpt-5.6-sol",
  requestedServiceTier: "default",
} as const;
const STARTED_AT = "2026-08-31T00:00:00.000Z";
const BRIEF_AT = "2026-08-31T00:00:01.000Z";
const USAGE = {
  inputTokens: 30,
  uncachedInputTokens: 10,
  cachedInputTokens: 15,
  cacheWriteInputTokens: 5,
  outputTokens: 7,
  reasoningOutputTokens: 3,
  totalTokens: 37,
} as const;
const RUNTIME_DEPENDENCY_VERIFICATION = {
  receiptDigest: `sha256:${"a".repeat(64)}`,
  componentSetRoot: `sha256:${"b".repeat(64)}`,
  verificationScope: "critical-load-and-executable-subset" as const,
  verificationDurationMs: 7,
};
const verifyRuntimeDependencies = async () => RUNTIME_DEPENDENCY_VERIFICATION;

const CONFIG = {
  attempt: { attemptId: ATTEMPT_ID },
  runnerConfig: {
    attemptId: ATTEMPT_ID,
    authorIdentityCommitment: AUTHOR_IDENTITY_COMMITMENT,
    model: EXPECTED_PROVIDER_INTENT.requestedModelIdentifier,
    serviceTier: EXPECTED_PROVIDER_INTENT.requestedServiceTier,
  },
} as unknown as DevelopmentAttemptConfig;

const temporaryRoots: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jazzboard-clean-room-executor-"));
  temporaryRoots.push(root);
  return root;
}

async function leaf(outputDir: string, artifactPath: string) {
  const contents = await readFile(path.join(outputDir, artifactPath));
  return { path: artifactPath, bytes: contents.byteLength, sha256: sha256(contents) };
}

function evidenceRoot(leaves: Array<{ path: string; bytes: number; sha256: string }>) {
  const ordered = [...leaves].sort((left, right) => compareCodeUnits(left.path, right.path));
  return { algorithm: "sha256" as const, leaves: ordered, root: sha256(canonicalJson(ordered)) };
}

async function writeRetainedAttempt(
  outputRoot: string,
  options: {
    status?: string;
    termination?: string;
    failure?: { message: string } | null;
    attemptStartedAt?: string | null;
    identityCommitment?: string;
    requestedModelIdentifier?: string;
    authorEvents?: unknown[];
    observedProvider?: {
      provider: "openai_responses";
      completedTurns: number;
      observedModels: string[];
      observedServiceTiers: string[];
      allTurnsReportedModel: boolean;
      allTurnsReportedServiceTier: boolean;
    };
  } = {},
): Promise<string> {
  const outputDir = path.join(outputRoot, ATTEMPT_ID);
  const completedTurns = options.observedProvider?.completedTurns ?? 1;
  const zeroUsage = {
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  const usageByTurn = Array.from({ length: completedTurns }, (_, index) => ({
    turn: index + 1,
    ...(index === completedTurns - 1 ? USAGE : zeroUsage),
  }));
  const defaultAuthorEvents = Array.from({ length: completedTurns }, (_, index) => [
    { sequence: index * 2, type: "responses_request_started", data: { turn: index + 1 } },
    { sequence: index * 2 + 1, type: "responses_request_completed", data: { turn: index + 1 } },
  ]).flat();
  await mkdir(outputDir, { recursive: true });
  const artifacts: Record<string, string | Buffer> = {
    "author-brief.json": JSON.stringify({ task: "frozen" }),
    "author-events.jsonl": (options.authorEvents ?? defaultAuthorEvents)
      .map((event) => JSON.stringify(event)).join("\n") + "\n",
    "author-final.json": JSON.stringify({ final: "done" }),
    "author-identity-commitment.json": canonicalJson({
      attemptId: ATTEMPT_ID,
      identityCommitment: options.identityCommitment ?? AUTHOR_IDENTITY_COMMITMENT,
      schemaVersion: "author-identity-commitment/v1",
    }),
    "coordinator-events.jsonl": `${JSON.stringify({ kind: "attempt_finished" })}\n`,
    "participant-tool-contract.json": JSON.stringify({ hash: "participant" }),
    "spectator-final-state.json": JSON.stringify({ revision: 4, objects: [] }),
    "spectator-inspection.json": JSON.stringify({ ok: true }),
    "spectator-tool-contract.json": JSON.stringify({ hash: "spectator" }),
    "spectator-final-r4.png": Buffer.from("exact-pixel-capture"),
  };
  for (const [artifactPath, contents] of Object.entries(artifacts)) {
    await writeFile(path.join(outputDir, artifactPath), contents);
  }
  const authorLeaves = await Promise.all([
    "author-brief.json",
    "author-events.jsonl",
    "author-final.json",
    "author-identity-commitment.json",
  ].map((artifactPath) => leaf(outputDir, artifactPath)));
  const authorEvidenceRoot = evidenceRoot(authorLeaves);
  await writeFile(path.join(outputDir, "author-evidence-seal.json"), JSON.stringify(authorEvidenceRoot));

  const indexedPaths = [...Object.keys(artifacts), "author-evidence-seal.json"];
  const artifactIndex = evidenceRoot(await Promise.all(indexedPaths.map((artifactPath) => leaf(outputDir, artifactPath))));
  const identityLeaf = await leaf(outputDir, "author-identity-commitment.json");
  const bundle = {
    schemaVersion: "clean-room-live-attempt/v1",
    attemptId: ATTEMPT_ID,
    mode: "live",
    status: options.status ?? "author_completed",
    failure: options.failure ?? null,
    startedAt: STARTED_AT,
    elapsedMs: 2_000,
    attemptStartedAt: options.attemptStartedAt === undefined ? BRIEF_AT : options.attemptStartedAt,
    author: {
      termination: options.termination ?? "author_completed",
      usage: { totals: USAGE, byTurn: usageByTurn },
      observedProvider: options.observedProvider ?? {
        provider: "openai_responses",
        completedTurns: 1,
        observedModels: ["gpt-5.6-sol"],
        observedServiceTiers: ["default"],
        allTurnsReportedModel: true,
        allTurnsReportedServiceTier: true,
      },
    },
    providerIntent: {
      provider: "openai_responses",
      requestedModelIdentifier: options.requestedModelIdentifier ?? "gpt-5.6-sol",
      requestedServiceTier: "default",
      immutableModelSnapshotVerified: false,
    },
    authorIdentity: {
      identityCommitment: options.identityCommitment ?? AUTHOR_IDENTITY_COMMITMENT,
      artifactPath: "author-identity-commitment.json",
      artifactSha256: `sha256:${identityLeaf.sha256}`,
    },
    authorEvidenceRoot,
    artifactIndex,
  };
  await writeFile(path.join(outputDir, "attempt-bundle.json"), JSON.stringify(bundle));
  return outputDir;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("retainedAttemptResult", () => {
  it("recomputes both evidence roots and returns exact retained usage and artifacts", async () => {
    const root = await temporaryRoot();
    const outputDir = await writeRetainedAttempt(root);

    const result = await retainedAttemptResult(outputDir, ATTEMPT_ID, AUTHOR_IDENTITY_COMMITMENT, EXPECTED_PROVIDER_INTENT, BRIEF_AT);

    expect(result.kind).toBe("begun");
    expect(result.outcome).toBe("completed");
    expect(result.finishedAt).toBe("2026-08-31T00:00:02.000Z");
    expect(result.usage).toEqual(USAGE);
    expect(result.artifactRoot).toMatch(/^[a-f0-9]{64}$/);
    expect(result.authorEvidenceRoot).toMatch(/^[a-f0-9]{64}$/);
    expect(result.attemptBundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.artifacts.map((artifact) => artifact.path)).toContain("spectator-final-r4.png");
    expect(result.hardIncident).toBe(false);
  });

  it("rejects identity, brief timestamp, byte, and symlink drift", async () => {
    const root = await temporaryRoot();
    const outputDir = await writeRetainedAttempt(root);
    await expect(retainedAttemptResult(outputDir, "wrong-attempt", AUTHOR_IDENTITY_COMMITMENT, EXPECTED_PROVIDER_INTENT, BRIEF_AT)).rejects.toThrow(/identity/);
    await expect(retainedAttemptResult(
      outputDir, ATTEMPT_ID, AUTHOR_IDENTITY_COMMITMENT, EXPECTED_PROVIDER_INTENT, "2026-08-31T00:00:09.000Z",
    )).rejects.toThrow(/brief-delivery timestamp/);

    await writeFile(path.join(outputDir, "spectator-final-state.json"), JSON.stringify({ revision: 99 }));
    await expect(retainedAttemptResult(outputDir, ATTEMPT_ID, AUTHOR_IDENTITY_COMMITMENT, EXPECTED_PROVIDER_INTENT, BRIEF_AT)).rejects.toThrow(/artifact index/);

    const symlinkRoot = await temporaryRoot();
    const symlinkOutput = await writeRetainedAttempt(symlinkRoot);
    await symlink(path.join(symlinkOutput, "author-final.json"), path.join(symlinkOutput, "linked-author-final.json"));
    await expect(retainedAttemptResult(symlinkOutput, ATTEMPT_ID, AUTHOR_IDENTITY_COMMITMENT, EXPECTED_PROVIDER_INTENT, BRIEF_AT)).rejects.toThrow(/symbolic link/);
  });

  it("rejects a self-consistent author identity rewrite that differs from the frozen config", async () => {
    const root = await temporaryRoot();
    const forgedIdentity = `sha256:${"2".repeat(64)}`;
    const outputDir = await writeRetainedAttempt(root, { identityCommitment: forgedIdentity });

    await expect(retainedAttemptResult(
      outputDir,
      ATTEMPT_ID,
      AUTHOR_IDENTITY_COMMITMENT,
      EXPECTED_PROVIDER_INTENT,
      BRIEF_AT,
    )).rejects.toThrow(/trusted commitment frozen into its runner config/);
  });

  it("maps retained noncompletion and detects falsification language", async () => {
    const root = await temporaryRoot();
    const outputDir = await writeRetainedAttempt(root, {
      status: "runner_failed",
      termination: "not_started",
      failure: { message: "Participant tool contract drift detected." },
    });

    const result = await retainedAttemptResult(outputDir, ATTEMPT_ID, AUTHOR_IDENTITY_COMMITMENT, EXPECTED_PROVIDER_INTENT, BRIEF_AT);

    expect(result.outcome).toBe("infra_failure");
    expect(result.hardIncident).toBe(true);
    expect(result.falsification).toBe(true);
    expect(result.incidentCode).toBe("runner_failure");
  });

  it("accepts one stable dated provider identifier while retaining the requested alias as a diagnostic", async () => {
    const root = await temporaryRoot();
    const outputDir = await writeRetainedAttempt(root, {
      observedProvider: {
        provider: "openai_responses",
        completedTurns: 2,
        observedModels: ["gpt-5.6-sol-2026-08-29"],
        observedServiceTiers: ["default"],
        allTurnsReportedModel: true,
        allTurnsReportedServiceTier: true,
      },
    });
    const result = await retainedAttemptResult(outputDir, ATTEMPT_ID, AUTHOR_IDENTITY_COMMITMENT, EXPECTED_PROVIDER_INTENT, BRIEF_AT);
    expect(result.providerIdentity).toMatchObject({
      status: "observed",
      requestedModelIdentifier: "gpt-5.6-sol",
      requestedServiceTier: "default",
      observedModelIdentifiers: ["gpt-5.6-sol-2026-08-29"],
      observedServiceTiers: ["default"],
      requestedAliasExactMatch: false,
    });
    expect(result.falsification).toBe(false);
  });

  it.each([
    {
      label: "missing service tier",
      observedProvider: {
        provider: "openai_responses" as const,
        completedTurns: 1,
        observedModels: ["gpt-5.6-sol-2026-08-29"],
        observedServiceTiers: [],
        allTurnsReportedModel: true,
        allTurnsReportedServiceTier: false,
      },
    },
    {
      label: "drifting service tiers",
      observedProvider: {
        provider: "openai_responses" as const,
        completedTurns: 2,
        observedModels: ["gpt-5.6-sol-2026-08-29"],
        observedServiceTiers: ["default", "priority"],
        allTurnsReportedModel: true,
        allTurnsReportedServiceTier: true,
      },
    },
    {
      label: "drifting model identifiers",
      observedProvider: {
        provider: "openai_responses" as const,
        completedTurns: 2,
        observedModels: ["gpt-5.6-sol-2026-08-29", "gpt-5.6-sol-2026-08-30"],
        observedServiceTiers: ["default"],
        allTurnsReportedModel: true,
        allTurnsReportedServiceTier: true,
      },
    },
  ])("falsifies completed author evidence with $label", async ({ observedProvider }) => {
    const root = await temporaryRoot();
    const outputDir = await writeRetainedAttempt(root, { observedProvider });
    const result = await retainedAttemptResult(outputDir, ATTEMPT_ID, AUTHOR_IDENTITY_COMMITMENT, EXPECTED_PROVIDER_INTENT, BRIEF_AT);
    expect(result.providerIdentity.status).toBe("falsified");
    expect(result).toMatchObject({
      hardIncident: true,
      falsification: true,
      incidentCode: "provider_identity_drift",
    });
  });

  it.each([
    {
      label: "a self-consistent request for the wrong model",
      requestedModelIdentifier: "gpt-4o",
      observedModels: ["gpt-4o"],
    },
    {
      label: "an unrelated model returned for the frozen alias",
      requestedModelIdentifier: "gpt-5.6-sol",
      observedModels: ["gpt-4o-2026-08-29"],
    },
    {
      label: "an invalid dated resolution",
      requestedModelIdentifier: "gpt-5.6-sol",
      observedModels: ["gpt-5.6-sol-2026-99-99"],
    },
    {
      label: "a resolution dated after the retained provider observation",
      requestedModelIdentifier: "gpt-5.6-sol",
      observedModels: ["gpt-5.6-sol-2026-09-01"],
    },
  ])("falsifies $label", async ({ requestedModelIdentifier, observedModels }) => {
    const root = await temporaryRoot();
    const outputDir = await writeRetainedAttempt(root, {
      requestedModelIdentifier,
      observedProvider: {
        provider: "openai_responses",
        completedTurns: 1,
        observedModels,
        observedServiceTiers: ["default"],
        allTurnsReportedModel: true,
        allTurnsReportedServiceTier: true,
      },
    });

    const result = await retainedAttemptResult(
      outputDir,
      ATTEMPT_ID,
      AUTHOR_IDENTITY_COMMITMENT,
      EXPECTED_PROVIDER_INTENT,
      BRIEF_AT,
    );
    expect(result).toMatchObject({
      providerIdentity: { status: "falsified" },
      hardIncident: true,
      falsification: true,
      incidentCode: "provider_identity_drift",
    });
  });
});

describe("createCleanRoomBatchExecutor", () => {
  it("awaits durable brief registration before the author runner proceeds", async () => {
    const root = await temporaryRoot();
    await writeRetainedAttempt(root);
    const order: string[] = [];
    let releaseRegistry!: () => void;
    const registryGate = new Promise<void>((resolve) => { releaseRegistry = resolve; });
    const executor = createCleanRoomBatchExecutor({
      outputRoot: root,
      verifyRuntimeDependencies,
      runCleanRoomAttempt: async (_config, controls) => {
        expect(controls.expectedOutputDir).toBe(path.join(root, ATTEMPT_ID));
        await expect(controls.verifyRuntimeDependencies()).resolves.toEqual(RUNTIME_DEPENDENCY_VERIFICATION);
        order.push("runner-before-brief");
        await controls.onBriefDelivered(BRIEF_AT);
        order.push("runner-after-brief");
        return { outputDir: path.join(root, ATTEMPT_ID), status: "author_completed", participantContractHash: "p", spectatorContractHash: "s" };
      },
    });
    const execution = executor(CONFIG, {
      onBriefDelivered: async () => {
        order.push("registry-start");
        await registryGate;
        order.push("registry-durable");
        // The durable release gate returns the effective brief-delivery
        // timestamp. Receipt digests are retained by the registry itself and
        // must never be mistaken for an author timeline value.
        return BRIEF_AT;
      },
    });

    await vi.waitFor(() => expect(order).toEqual(["runner-before-brief", "registry-start"]));
    releaseRegistry();
    const result = await execution;

    expect(order).toEqual(["runner-before-brief", "registry-start", "registry-durable", "runner-after-brief"]);
    expect(result).toMatchObject({ kind: "begun", outcome: "completed" });
  });

  it("keeps the full author reservation unobservable when a completed turn is followed by an unresolved provider start", async () => {
    const root = await temporaryRoot();
    const outputDir = await writeRetainedAttempt(root, {
      status: "responses_api_failed",
      termination: "responses_api_failed",
      authorEvents: [
        { sequence: 0, type: "responses_request_started", data: { turn: 1, requestContextBytes: 100 } },
        { sequence: 1, type: "responses_request_completed", data: { turn: 1, requestContextBytes: 100 } },
        { sequence: 2, type: "responses_request_started", data: { turn: 2, requestContextBytes: 200 } },
        { sequence: 3, type: "responses_request_failed", data: { message: "network ambiguity" } },
      ],
    });
    const result = await retainedAttemptResult(outputDir, ATTEMPT_ID, AUTHOR_IDENTITY_COMMITMENT, EXPECTED_PROVIDER_INTENT, BRIEF_AT);
    expect(result).toMatchObject({
      kind: "begun",
      costObservability: "unobservable",
      providerEvidenceDigest: expect.stringMatching(/^sha256:/),
    });
    expect(result.usage.inputTokens).toBe(USAGE.inputTokens);
  });

  it("reports a true not-started attempt when the runner fails before brief delivery", async () => {
    const root = await temporaryRoot();
    const executor = createCleanRoomBatchExecutor({
      outputRoot: root,
      verifyRuntimeDependencies,
      now: () => "2026-08-31T00:00:03.000Z",
      runCleanRoomAttempt: async () => { throw new Error("browser unavailable"); },
    });

    await expect(executor(CONFIG, { onBriefDelivered: vi.fn() })).resolves.toEqual({
      kind: "not_started",
      at: "2026-08-31T00:00:03.000Z",
      incidentCode: "runner_failed_before_brief",
      message: "browser unavailable",
      hardIncident: false,
      falsification: false,
    });
  });

  it("fails closed before brief delivery when the mandatory runtime dependency check rejects", async () => {
    const root = await temporaryRoot();
    const onBriefDelivered = vi.fn();
    const executor = createCleanRoomBatchExecutor({
      outputRoot: root,
      now: () => "2026-08-31T00:00:03.000Z",
      verifyRuntimeDependencies: async () => { throw new Error("runtime dependency root drift"); },
      runCleanRoomAttempt: async (_config, controls) => {
        await controls.verifyRuntimeDependencies();
        await controls.onBriefDelivered(BRIEF_AT);
        throw new Error("unreachable");
      },
    });

    await expect(executor(CONFIG, { onBriefDelivered })).resolves.toMatchObject({
      kind: "not_started",
      incidentCode: "runner_failed_before_brief",
      message: "runtime dependency root drift",
    });
    expect(onBriefDelivered).not.toHaveBeenCalled();
  });

  it("hard-stops a failed durable brief registration before the author receives the brief", async () => {
    const root = await temporaryRoot();
    const executor = createCleanRoomBatchExecutor({
      outputRoot: root,
      verifyRuntimeDependencies,
      now: () => "2026-08-31T00:00:03.000Z",
      runCleanRoomAttempt: async (_config, controls) => {
        await controls.onBriefDelivered(BRIEF_AT);
        throw new Error("unreachable");
      },
    });

    await expect(executor(CONFIG, {
      onBriefDelivered: async () => { throw new Error("registry fsync failed"); },
    })).resolves.toEqual({
      kind: "not_started",
      at: "2026-08-31T00:00:03.000Z",
      incidentCode: "brief_registry_persistence_failure",
      message: "registry fsync failed",
      hardIncident: true,
      falsification: false,
    });
  });

  it("retains post-brief evidence and marks the runner exception as a hard incident", async () => {
    const root = await temporaryRoot();
    await writeRetainedAttempt(root);
    const executor = createCleanRoomBatchExecutor({
      outputRoot: root,
      verifyRuntimeDependencies,
      runCleanRoomAttempt: async (_config, controls) => {
        await controls.onBriefDelivered(BRIEF_AT);
        throw new Error("connection closed after evidence write");
      },
    });

    const result = await executor(CONFIG, { onBriefDelivered: vi.fn() });

    expect(result).toMatchObject({
      kind: "begun",
      outcome: "completed",
      hardIncident: true,
      falsification: false,
      incidentCode: "runner_threw_after_brief",
    });
  });

  it("fails closed when the runner reports an output path outside the assignment", async () => {
    const root = await temporaryRoot();
    await writeRetainedAttempt(root);
    const executor = createCleanRoomBatchExecutor({
      outputRoot: root,
      verifyRuntimeDependencies,
      runCleanRoomAttempt: async (_config, controls) => {
        await controls.onBriefDelivered(BRIEF_AT);
        return { outputDir: path.join(root, "other-attempt"), status: "author_completed", participantContractHash: "p", spectatorContractHash: "s" };
      },
    });

    const result = await executor(CONFIG, { onBriefDelivered: vi.fn() });

    expect(result).toMatchObject({
      kind: "begun",
      hardIncident: true,
      falsification: true,
      incidentCode: "runner_output_path_drift",
    });
  });
});
