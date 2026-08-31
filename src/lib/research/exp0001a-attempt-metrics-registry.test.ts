// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import developmentManifest from "../../../research/benchmarks/development-v1.json";

import {
  computeExp0001aAttemptMetricsSpecDigest,
  computeExp0001aAttemptMetricsTaskDigest,
  EXP0001A_ATTEMPT_METRICS_EXTRACTOR_SOURCE_PATH,
  EXP0001A_ATTEMPT_METRICS_EXTRACTOR_VERSION,
  EXP0001A_ATTEMPT_METRICS_SCORER_SOURCE_PATH,
  EXP0001A_ATTEMPT_METRICS_SCORER_VERSION,
  extractExp0001aAttemptMetrics,
  type AttemptArtifactBytes,
  type AttemptMetricsExtractionInput,
} from "./attempt-metrics";
import {
  createExp0001aAttemptMetricsRegistry,
  createExp0001aAttemptMetricsRegistryBinding,
  EXP0001A_ATTEMPT_METRICS_REGISTRY_SOURCE_PATH,
  EXP0001A_ATTEMPT_METRICS_REGISTRY_VERSION,
} from "./exp0001a-attempt-metrics-registry";
import { canonicalJson, hashCanonicalJson } from "./provenance-crypto";

function digest(label: string): string {
  return hashCanonicalJson({ label });
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactSet(artifacts: AttemptArtifactBytes) {
  const leaves = Object.entries(artifacts).map(([artifactPath, contents]) => {
    const content = typeof contents === "string" ? Buffer.from(contents) : Buffer.from(contents);
    return { path: artifactPath, bytes: content.byteLength, sha256: sha256(content) };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { algorithm: "sha256", leaves, root: sha256(canonicalJson(leaves)) };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const spec = {
  costRatesUsdPerMillion: { uncachedInput: 4, cachedInput: 1, cacheWriteInput: 2, output: 20 },
  presentationCriteria: {
    maximumTimeToFirstVisibleObjectMs: 2_000,
    minimumVisibleActivityRatio: 0.5,
    minimumRevealEventCount: 2,
    minimumSemanticRevealOrderRate: 1,
    maximumFlickerCount: 0,
    maximumDuplicatePresentationFrameCount: 0,
    maximumViewportInstabilityCount: 0,
    maximumHandoffGapMs: 1_000,
  },
  efficiencyBudgets: {
    toolCalls: 20,
    roundTrips: 10,
    inputTokens: 10_000,
    outputTokens: 2_000,
    contextBytes: 20_000,
    receiptBytes: 100_000,
    wallTimeMs: 30_000,
    timeToUsefulDraftMs: 10_000,
    costUsd: 1,
  },
  qualityScaleId: "public-criteria-quality-v1",
  possibleIssueOpportunityCount: 20,
};

const sourceBindings = {
  extractor: {
    sourcePath: EXP0001A_ATTEMPT_METRICS_EXTRACTOR_SOURCE_PATH,
    sourceDigest: digest("attempt-metrics-source"),
    version: EXP0001A_ATTEMPT_METRICS_EXTRACTOR_VERSION,
  },
  scorer: {
    sourcePath: EXP0001A_ATTEMPT_METRICS_SCORER_SOURCE_PATH,
    sourceDigest: digest("scoring-source"),
    version: EXP0001A_ATTEMPT_METRICS_SCORER_VERSION,
  },
  evaluatorAuthority: {
    reviewRegistryRoot: digest("metrics-evaluator-review-registry"),
    policyDigest: digest("metrics-evaluator-policy"),
    allowedIdentityCommitments: [digest("metrics-evaluator-identity")],
  },
  registry: {
    sourcePath: EXP0001A_ATTEMPT_METRICS_REGISTRY_SOURCE_PATH,
    sourceDigest: digest("attempt-metrics-registry-source"),
    version: EXP0001A_ATTEMPT_METRICS_REGISTRY_VERSION,
  },
};

const expectedAttemptSlots = Array.from({ length: 48 }, (_, index) => {
  const pairOrdinal = Math.floor(index / 2);
  const task = developmentManifest.tasks[Math.floor(pairOrdinal / 2)];
  return {
    attemptId: `attempt-${index.toString().padStart(2, "0")}`,
    pairId: `pair-${pairOrdinal.toString().padStart(2, "0")}`,
    taskId: task.id,
    taskDigest: computeExp0001aAttemptMetricsTaskDigest(task),
    treatment: index % 2 === 0 ? "A0" as const : "A1" as const,
  };
});

const scoringSpecDigest = computeExp0001aAttemptMetricsSpecDigest(spec);

function metricsExtractionInput(index: number, overrides: {
  taskOffset?: number;
  specQualityScaleId?: string;
  extractorSourceDigest?: string;
  evaluatorPolicyDigest?: string;
  failureMessage?: string;
} = {}): AttemptMetricsExtractionInput {
  const expected = expectedAttemptSlots[index];
  const expectedTaskIndex = developmentManifest.tasks.findIndex((task) => task.id === expected.taskId);
  const task = developmentManifest.tasks[
    (expectedTaskIndex + (overrides.taskOffset ?? 0)) % developmentManifest.tasks.length
  ];
  const selectedSpec = overrides.specQualityScaleId
    ? { ...spec, qualityScaleId: overrides.specQualityScaleId }
    : spec;
  const author = {
    termination: "runner_failed",
    finalText: "",
    toolCalls: 0,
    usage: {
      totals: {
        inputTokens: 0,
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      byTurn: [],
      costInputs: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
      },
    },
  };
  const authorArtifacts: Record<string, string> = {
    "author-brief.json": json({ taskId: task.id, brief: "Exact isolated author brief." }),
    "author-events.jsonl": "",
    "author-final-state.json": json({ ok: false }),
    "author-final.json": json(author),
  };
  const authorEvidenceRoot = artifactSet(authorArtifacts);
  const artifacts = {
    ...authorArtifacts,
    "author-evidence-seal.json": json(authorEvidenceRoot),
    "coordinator-events.jsonl": "",
  };
  const bundle = {
    schemaVersion: "clean-room-live-attempt/v1",
    attemptId: expected.attemptId,
    mode: "live",
    status: "runner_failed",
    failure: { message: overrides.failureMessage ?? "fixture interruption" },
    startedAt: "2026-08-30T00:00:00.000Z",
    elapsedMs: 0,
    attemptStartedAt: null,
    author,
    providerIntent: {
      provider: "openai_responses",
      requestedModelIdentifier: "gpt-5.6-sol",
      requestedServiceTier: "default",
      immutableModelSnapshotVerified: false,
    },
    authorEvidenceRoot,
    artifactIndex: artifactSet(artifacts),
    isolation: {
      authorContextClosedBeforeEvaluation: true,
      evaluatorRole: "spectator",
      apiTransport: "raw_fetch",
    },
  };
  return {
    attemptBundleBytes: json(bundle),
    artifacts,
    task,
    spec: selectedSpec,
    frozenBindings: {
      taskDigest: computeExp0001aAttemptMetricsTaskDigest(task),
      scoringSpecDigest: computeExp0001aAttemptMetricsSpecDigest(selectedSpec),
      extractor: {
        ...sourceBindings.extractor,
        sourceDigest: overrides.extractorSourceDigest ?? sourceBindings.extractor.sourceDigest,
      },
      scorer: sourceBindings.scorer,
      evaluatorAuthority: {
        ...sourceBindings.evaluatorAuthority,
        policyDigest: overrides.evaluatorPolicyDigest ?? sourceBindings.evaluatorAuthority.policyDigest,
      },
    },
  };
}

const expectedAttempts = expectedAttemptSlots.map((slot, index) => {
  const provenance = extractExp0001aAttemptMetrics(metricsExtractionInput(index)).scoreArtifact.provenance;
  return {
    ...slot,
    attemptBundleDigest: provenance.attemptBundleDigest,
    artifactRoot: provenance.artifactRoot,
    authorEvidenceRoot: provenance.authorEvidenceRoot,
    rawEvidenceRoot: provenance.rawEvidence.rawEvidenceRoot,
    evaluatorAssessmentEnvelopeDigest: null,
  };
});

const binding = createExp0001aAttemptMetricsRegistryBinding({
  schemaVersion: 1,
  protocolId: "EXP-0001A",
  authorizationReceiptDigest: digest("execution-authorization"),
  expectedAttempts,
  scoringSpecDigest,
  ...sourceBindings,
});

async function withRegistry(
  callback: (input: {
    directory: string;
    registry: ReturnType<typeof createExp0001aAttemptMetricsRegistry>;
  }) => Promise<void>,
) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "jazzboard-attempt-metrics-"));
  const directory = path.join(parent, "registry");
  let tick = 0;
  const registry = createExp0001aAttemptMetricsRegistry({
    directory,
    binding,
    authorizedBindingRoot: binding.bindingRoot,
    authorizationReceiptDigest: binding.authorizationReceiptDigest,
    now: () => new Date(Date.UTC(2026, 7, 30, 1, 0, tick++)).toISOString(),
  });
  try {
    await callback({ directory, registry });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

describe("EXP-0001A immutable attempt-metrics registry", () => {
  it("retains exactly 48 full artifacts, seals the denominator, and verifies durable modes/readback", async () => {
    await withRegistry(async ({ directory, registry }) => {
      for (let index = 0; index < 48; index += 1) await registry.append(metricsExtractionInput(index));
      const beforeSeal = await registry.read();
      expect(beforeSeal.summary).toMatchObject({
        expectedAttemptCount: 48,
        retainedAttemptCount: 48,
        denominatorComplete: false,
        remainingAttemptIds: [],
      });

      const eventName = (await readdir(directory)).find((name) => name.startsWith("000000-"));
      expect(eventName).toBeDefined();
      expect((await stat(path.join(directory, eventName!))).mode & 0o777).toBe(0o600);

      const seal = await registry.seal();
      const complete = await registry.requireComplete(seal.sealDigest);
      expect(complete.summary).toMatchObject({
        retainedAttemptCount: 48,
        denominatorComplete: true,
        completionSealDigest: seal.sealDigest,
      });
      expect(complete.events[47].metricsArtifact.attemptId).toBe("attempt-47");

      const names = (await readdir(directory)).filter((name) => /^\d{6}-/.test(name)).sort();
      await unlink(path.join(directory, names[47]));
      await expect(registry.read()).rejects.toThrow(/completion seal does not match/);
      await unlink(path.join(directory, "completion.json"));
      await expect(registry.requireComplete(seal.sealDigest)).rejects.toThrow(/denominator is incomplete/);
    });
  });

  it("rejects duplicate/out-of-order attempts and task, spec, source, or authority drift", async () => {
    expect(() => createExp0001aAttemptMetricsRegistryBinding({
      schemaVersion: 1,
      protocolId: "EXP-0001A",
      authorizationReceiptDigest: binding.authorizationReceiptDigest,
      expectedAttempts: expectedAttempts.map((attempt, index) => ({ ...attempt, pairId: `forged-pair-${index}` })),
      scoringSpecDigest,
      ...sourceBindings,
    })).toThrow(/exactly 24 pairs/);
    expect(() => createExp0001aAttemptMetricsRegistryBinding({
      schemaVersion: 1,
      protocolId: "EXP-0001A",
      authorizationReceiptDigest: binding.authorizationReceiptDigest,
      expectedAttempts: expectedAttempts.map((attempt, index) => index === 2
        ? { ...attempt, taskDigest: digest("same-task-different-digest") }
        : attempt),
      scoringSpecDigest,
      ...sourceBindings,
    })).toThrow(/changes its frozen digest/);
    expect(() => createExp0001aAttemptMetricsRegistry({
      directory: "/tmp/never-created-metrics-registry",
      binding,
      authorizedBindingRoot: digest("forged-binding-root"),
      authorizationReceiptDigest: binding.authorizationReceiptDigest,
    })).toThrow(/not the execution-authorized binding root/);
    expect(() => createExp0001aAttemptMetricsRegistry({
      directory: "/tmp/never-created-metrics-registry",
      binding,
      authorizedBindingRoot: binding.bindingRoot,
      authorizationReceiptDigest: digest("other-execution-authorization"),
    })).toThrow(/another execution authorization receipt/);

    await withRegistry(async ({ registry }) => {
      await expect(registry.append(metricsExtractionInput(1))).rejects.toThrow(/frozen sequence 0/);
      await registry.append(metricsExtractionInput(0));
      await expect(registry.append(metricsExtractionInput(0))).rejects.toThrow(/Duplicate attempt metrics/);
      await expect(registry.append(metricsExtractionInput(1, { taskOffset: 1 })))
        .rejects.toThrow(/frozen sequence 1/);
      await expect(registry.append(metricsExtractionInput(1, { specQualityScaleId: "wrong-spec" })))
        .rejects.toThrow(/frozen sequence 1/);
      await expect(registry.append(metricsExtractionInput(1, { extractorSourceDigest: digest("wrong-source") })))
        .rejects.toThrow(/frozen sequence 1/);
      await expect(registry.append(metricsExtractionInput(1, { evaluatorPolicyDigest: digest("wrong-evaluator-policy") })))
        .rejects.toThrow(/frozen sequence 1/);
      await expect(registry.append(metricsExtractionInput(1, { failureMessage: "fabricated attempt bytes" })))
        .rejects.toThrow(/frozen sequence 1/);
    });
  });

  it("fails closed on unexpected files, tampering, interior gaps, and active/crashed locks", async () => {
    await withRegistry(async ({ directory, registry }) => {
      await registry.append(metricsExtractionInput(0));
      await writeFile(path.join(directory, "attacker.json"), "{}", "utf8");
      await expect(registry.read()).rejects.toThrow(/unexpected entries: attacker.json/);
    });

    await withRegistry(async ({ directory, registry }) => {
      await registry.append(metricsExtractionInput(0));
      const eventName = (await readdir(directory)).find((name) => name.startsWith("000000-"))!;
      const eventPath = path.join(directory, eventName);
      const event = JSON.parse(await readFile(eventPath, "utf8")) as Record<string, unknown>;
      event.retainedAt = "2026-08-30T09:00:00.000Z";
      await writeFile(eventPath, canonicalJson(event), "utf8");
      await expect(registry.read()).rejects.toThrow(/hash chain is invalid/);
    });

    await withRegistry(async ({ directory, registry }) => {
      await registry.append(metricsExtractionInput(0));
      await registry.append(metricsExtractionInput(1));
      await registry.append(metricsExtractionInput(2));
      const names = (await readdir(directory)).filter((name) => /^\d{6}-/.test(name)).sort();
      await unlink(path.join(directory, names[1]));
      await expect(registry.read()).rejects.toThrow(/event order/);
    });

    await withRegistry(async ({ directory, registry }) => {
      await registry.read();
      await writeFile(path.join(directory, ".append.lock"), "crashed", { mode: 0o600 });
      await expect(registry.read()).rejects.toThrow(/unexpected entries|locked/);
      await expect(registry.append(metricsExtractionInput(0))).rejects.toThrow(/already locked/);
    });
  });
});
