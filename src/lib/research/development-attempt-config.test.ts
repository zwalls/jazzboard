// @vitest-environment node

import { describe, expect, it } from "vitest";

import fixtureSpecs from "../../../research/benchmarks/development-fixture-specs-v1.json";
import checkedInManifest from "../../../research/data/development-execution-manifest-v1.json";
import checkedInProfile from "../../../research/data/development-runner-profile-v1.json";
import {
  FROZEN_DEVELOPMENT_RUNNER_PROFILE,
  createDevelopmentAttemptConfig,
  developmentAttemptConfigSchema,
  listDevelopmentAttemptIds,
  verifyDevelopmentAttemptConfig,
} from "./development-attempt-config";
import { hashCanonicalJson } from "./provenance-crypto";

// The executable remains plain ESM. This non-literal import lets Vitest exercise
// its pure validators without bringing the runner into the product typecheck.
const runnerModulePath: string = "../../../research/scripts/clean-room-live-runner.mjs";
const { buildAuthorVisibleSpec, validateRunnerConfig } = await import(runnerModulePath);

const PREFLIGHT = Object.freeze({
  batchId: "exp-0001a-batch-01",
  method: "authenticated-vercel-cli-or-api",
  authenticated: true,
  alias: "https://www.jazzboard.xyz",
  resolvedDeploymentId: "dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD",
  verifiedAt: "2026-08-30T22:00:00.000Z",
});

function authorIdentityCommitment(attemptId: string): string {
  return hashCanonicalJson({ attemptId, registry: "test-author-identity-registry-v1" });
}

function createAllConfigs() {
  return listDevelopmentAttemptIds().map((attemptId) => createDevelopmentAttemptConfig({
    attemptId,
    authorIdentityCommitment: authorIdentityCommitment(attemptId),
    aliasPreflight: PREFLIGHT,
  }));
}

function rehashProfile(profile: typeof checkedInProfile): typeof checkedInProfile {
  const content = Object.fromEntries(Object.entries(profile).filter(([key]) => key !== "profileDigest"));
  return { ...profile, profileDigest: hashCanonicalJson(content) };
}

describe("EXP-0001A development attempt bridge", () => {
  it("compiles exactly 48 unique frozen attempts into configs accepted by the live runner", () => {
    const configs = createAllConfigs();

    expect(configs).toHaveLength(48);
    expect(new Set(configs.map((config) => config.attempt.attemptId)).size).toBe(48);
    expect(new Set(configs.map((config) => config.configDigest)).size).toBe(48);
    expect(configs.every((config) => developmentAttemptConfigSchema.safeParse(config).success)).toBe(true);
    for (const config of configs) {
      expect(() => validateRunnerConfig(config.runnerConfig, false)).not.toThrow();
      expect(verifyDevelopmentAttemptConfig(config)).toEqual(config);
    }
  });

  it("resolves every A0 and A1 label to one byte-identical treatment configuration", () => {
    const configs = createAllConfigs();
    const byPair = Map.groupBy(configs, (config) => config.attempt.pairId);

    expect(new Set(configs.map((config) => config.treatmentConfigurationDigest)).size).toBe(1);
    expect(new Set(configs.map((config) => hashCanonicalJson(config.treatmentConfiguration))).size).toBe(1);
    for (const pair of byPair.values()) {
      expect(pair).toHaveLength(2);
      expect(new Set(pair.map((config) => config.attempt.opaqueLabel))).toEqual(new Set(["A0", "A1"]));
      expect(pair[0].treatmentConfiguration).toEqual(pair[1].treatmentConfiguration);
    }
  });

  it("keeps fixture and concurrent event operations in trusted runner fields", () => {
    const configs = createAllConfigs();
    const configsWithSetup = configs.filter((config) => config.runnerConfig.setupOperations.length > 0);
    const configsWithEvents = configs.filter((config) => config.runnerConfig.concurrentEvents.length > 0);

    expect(configsWithSetup.length).toBeGreaterThan(0);
    expect(configsWithEvents.length).toBeGreaterThan(0);
    for (const config of configs) {
      expect(config.runnerConfig.setupOperations.every((item) => item.tool === "apply_canvas_transaction")).toBe(true);
      expect(config.runnerConfig.concurrentEvents.flatMap((event) => event.operations)
        .every((item) => item.tool === "apply_canvas_transaction")).toBe(true);
      expect(config.runnerConfig.setupCallbackHash).toBeNull();
      expect(config.runnerConfig.concurrentEventCallbackHash).toBeNull();
    }
  });

  it("exposes only the public brief, author allowlist, and budgets to the author", () => {
    for (const config of createAllConfigs()) {
      const visible = buildAuthorVisibleSpec(config.runnerConfig, false);
      const serializedVisible = JSON.stringify(visible);

      expect(Object.keys(visible).sort()).toEqual(["allowedToolNames", "brief", "budgets", "model", "sessionAlias"]);
      expect(serializedVisible).not.toMatch(/setupOperations|concurrentEvents|sourceCommitments|"rubric"/i);
      expect(visible.sessionAlias).toMatch(/^session-[a-f0-9]{12}$/);
      expect(serializedVisible).not.toContain(config.attempt.attemptId);
      expect(serializedVisible).not.toMatch(/(?:-a[01]\b)|"opaqueLabel"|"pairId"|"orderIndex"|"timeBlock"/i);
      expect(config.runnerConfig.roomTitle).not.toContain(config.attempt.attemptId);
      for (const fixture of fixtureSpecs.fixtures) expect(serializedVisible).not.toContain(fixture.fixtureId);
      for (const event of fixtureSpecs.concurrentEvents) expect(serializedVisible).not.toContain(event.eventFixtureId);
    }
  });

  it("pins the conservative Sol/max runtime, viewport, budgets, contracts, and participant allowlist", () => {
    const profile = FROZEN_DEVELOPMENT_RUNNER_PROFILE;
    const participantTools = new Set(profile.allowedToolNames);

    expect(profile.model).toEqual({ id: "gpt-5.6-sol", reasoningEffort: "max", serviceTier: "default" });
    expect(profile.viewport).toEqual({
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      locale: "en-US",
      timezone: "UTC",
    });
    expect(profile.budgets).toMatchObject({
      wallBudgetMs: 900_000,
      toolCallBudget: 120,
      inputTokenBudget: 600_000,
      outputTokenBudget: 80_000,
      perResponseMaxOutputTokens: 20_000,
      maxCorrectionRounds: 3,
    });
    expect(participantTools.has("apply_canvas_transaction")).toBe(true);
    expect(profile.participantToolContractHash).toBe("d64cf3d25b9e275003438597b3b01c35419063d71613082d45aaf2f97c388b8e");
    expect(profile.spectatorToolContractHash).toBe("1760c6b1ec8cc4d8814b3de6a8f4516b3f4c215da69069c50072f23128541be2");
  });

  it("is deterministic and binds brief, setup, event, treatment, and full config hashes", () => {
    const attemptId = listDevelopmentAttemptIds()[0];
    const first = createDevelopmentAttemptConfig({
      attemptId,
      authorIdentityCommitment: authorIdentityCommitment(attemptId),
      aliasPreflight: PREFLIGHT,
    });
    const second = createDevelopmentAttemptConfig({
      attemptId,
      authorIdentityCommitment: authorIdentityCommitment(attemptId),
      aliasPreflight: structuredClone(PREFLIGHT),
    });

    expect(first).toEqual(second);
    expect(first.hashes.brief).toBe(hashCanonicalJson(first.runnerConfig.brief));
    expect(first.hashes.setup).toBe(hashCanonicalJson(first.runnerConfig.setupOperations));
    expect(first.hashes.event).toBe(hashCanonicalJson(first.runnerConfig.concurrentEvents));
    expect(first.treatmentConfigurationDigest).toBe(hashCanonicalJson(first.treatmentConfiguration));
    const unsigned = Object.fromEntries(Object.entries(first).filter(([key]) => key !== "configDigest"));
    expect(first.configDigest).toBe(hashCanonicalJson(unsigned));
  });

  it("refuses missing/stale alias preflight and frozen build or contract drift", () => {
    const attemptId = listDevelopmentAttemptIds()[0];
    expect(() => createDevelopmentAttemptConfig({
      attemptId,
      authorIdentityCommitment: authorIdentityCommitment(attemptId),
      aliasPreflight: {},
    })).toThrow();
    expect(() => createDevelopmentAttemptConfig({
      attemptId,
      authorIdentityCommitment: authorIdentityCommitment(attemptId),
      aliasPreflight: { ...PREFLIGHT, resolvedDeploymentId: "dpl_wrong" },
    })).toThrow();

    const buildDrift = structuredClone(checkedInProfile);
    buildDrift.expectedDeployment.buildId = "bld_drift";
    expect(() => createDevelopmentAttemptConfig({
      attemptId,
      authorIdentityCommitment: authorIdentityCommitment(attemptId),
      aliasPreflight: PREFLIGHT,
      runnerProfile: rehashProfile(buildDrift),
    })).toThrow();

    const contractDrift = structuredClone(checkedInProfile);
    contractDrift.participantToolContractHash = "0".repeat(64);
    expect(() => createDevelopmentAttemptConfig({
      attemptId,
      authorIdentityCommitment: authorIdentityCommitment(attemptId),
      aliasPreflight: PREFLIGHT,
      runnerProfile: rehashProfile(contractDrift),
    })).toThrow();
  });

  it("refuses execution-manifest tampering and unknown config fields", () => {
    const attemptId = listDevelopmentAttemptIds()[0];
    const manifest = structuredClone(checkedInManifest);
    manifest.assignments[0].attempts[0].attemptId = "attempt-tampered";
    expect(() => createDevelopmentAttemptConfig({
      attemptId,
      authorIdentityCommitment: authorIdentityCommitment(attemptId),
      aliasPreflight: PREFLIGHT,
      manifest,
    })).toThrow(/manifest verification failed/i);

    const valid = createDevelopmentAttemptConfig({
      attemptId,
      authorIdentityCommitment: authorIdentityCommitment(attemptId),
      aliasPreflight: PREFLIGHT,
    });
    expect(developmentAttemptConfigSchema.safeParse({ ...valid, evaluator: true }).success).toBe(false);
  });

  it("requires and cryptographically binds the trusted author identity commitment", () => {
    const attemptId = listDevelopmentAttemptIds()[0];
    const first = createDevelopmentAttemptConfig({
      attemptId,
      authorIdentityCommitment: `sha256:${"1".repeat(64)}`,
      aliasPreflight: PREFLIGHT,
    });
    const second = createDevelopmentAttemptConfig({
      attemptId,
      authorIdentityCommitment: `sha256:${"2".repeat(64)}`,
      aliasPreflight: PREFLIGHT,
    });

    expect(first.runnerConfig.authorIdentityCommitment).toBe(`sha256:${"1".repeat(64)}`);
    expect(first.runnerConfig.sessionAlias).toMatch(/^session-[a-f0-9]{12}$/);
    expect(first.runnerConfig.sessionAlias).not.toBe(second.runnerConfig.sessionAlias);
    expect(first.configDigest).not.toBe(second.configDigest);
    expect(buildAuthorVisibleSpec(first.runnerConfig, false)).not.toHaveProperty("authorIdentityCommitment");
    expect(() => createDevelopmentAttemptConfig({
      attemptId,
      authorIdentityCommitment: "not-a-commitment",
      aliasPreflight: PREFLIGHT,
    })).toThrow();
    expect(() => createDevelopmentAttemptConfig({
      attemptId,
      aliasPreflight: PREFLIGHT,
    } as never)).toThrow();
  });

  it("contains no sealed content or credential-bearing fields", () => {
    for (const config of createAllConfigs()) {
      const serialized = JSON.stringify(config);
      expect(serialized).not.toMatch(/sealed/i);
      expect(serialized).not.toMatch(/room_[A-Za-z0-9_-]{8,}/);
      const keys: string[] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (value === null || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          keys.push(key);
          visit(child);
        }
      };
      visit(config);
      expect(keys.some((key) => /^(roomId|roomCode|sessionId|sessionToken|authorization|cookie|password|apiKey)$/i.test(key)))
        .toBe(false);
    }
  });
});
