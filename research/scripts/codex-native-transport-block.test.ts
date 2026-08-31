// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const batchModulePath: string = "./exp0001a-batch-command.mjs";
const evaluatorModulePath: string = "./blinded-evaluator-runner.mjs";
const authorModulePath: string = "./clean-room-live-runner.mjs";
const retiredLaunchSignerModulePath: string = "./sign-exp0001a-launch.mjs";
const { runExp0001aBatchCommand } = await import(batchModulePath);
const { recoverBlindedEvaluation, runBlindedEvaluation } = await import(evaluatorModulePath);
const { runCleanRoomAttempt } = await import(authorModulePath);
const { rejectRetiredExp0001aProviderLaunchSigner } = await import(retiredLaunchSignerModulePath);

const activeTransportSources = [
  "research/scripts/clean-room-live-runner.mjs",
  "research/scripts/blinded-evaluator-runner.mjs",
  "research/scripts/exp0001a-batch-command.mjs",
  "research/scripts/sign-exp0001a-launch.mjs",
  "research/runtime/exp0001a-runtime.bundle.mjs",
  "src/lib/research/exp0001a-runtime-composition.ts",
  "src/lib/research/exp0001a-pairwise-runtime.ts",
] as const;

describe("removed direct-provider experiment transport", () => {
  it("routes both dry-run and execute through the Codex-native runtime boundary", async () => {
    const missingConfig = path.join(process.cwd(), "research", "results", "never-created-codex-transport-test.json");
    const dependencies = {
      verifyRuntimeBundle: async () => ({ bundleDigest: `sha256:${"1".repeat(64)}` }),
      loadRuntime: async () => { throw new Error("CODEX_NATIVE_RUNTIME_REACHED"); },
    };

    await expect(runExp0001aBatchCommand(["--config", missingConfig, "--execute"], dependencies))
      .rejects.toThrow(/CODEX_NATIVE_RUNTIME_REACHED/);
    await expect(runExp0001aBatchCommand(["--config", missingConfig], dependencies))
      .rejects.toThrow(/CODEX_NATIVE_RUNTIME_REACHED/);
  });

  it("blocks direct evaluator release and recovery before parsing provider configuration", async () => {
    await expect(runBlindedEvaluation({ malicious: "config" }, {
      fetch: () => { throw new Error("must not be reached"); },
    })).rejects.toThrow(/CODEX_NATIVE_TRANSPORT_REQUIRED/);
    await expect(recoverBlindedEvaluation({ malicious: "config" }, {
      fetch: () => { throw new Error("must not be reached"); },
    })).rejects.toThrow(/CODEX_NATIVE_TRANSPORT_REQUIRED/);
  });

  it("blocks the former live author runner before browser or attempt-directory work", async () => {
    await expect(runCleanRoomAttempt({
      attemptId: "removed-provider-transport-1",
      sessionAlias: "session-0123456789ab",
      expectedRuntime: { nodeVersion: "22.22.0", browserVersion: "151.0.7922.34" },
      authorIdentityCommitment: `sha256:${"9".repeat(64)}`,
      baseUrl: "https://jazzboard.example",
      brief: "Create and inspect one small public architecture diagram.",
      model: "gpt-5.6-sol",
      serviceTier: "default",
      allowedToolNames: ["read_room_state"],
      participantToolContractHash: "a".repeat(64),
      spectatorToolContractHash: "b".repeat(64),
      inputTokenBudget: 20_000,
      outputTokenBudget: 5_000,
      perResponseMaxOutputTokens: 2_000,
    })).rejects.toThrow(/CODEX_NATIVE_TRANSPORT_REQUIRED/);
  });

  it("keeps the provider-era dollar-spend launch signer as a fail-closed tombstone", () => {
    expect(() => rejectRetiredExp0001aProviderLaunchSigner())
      .toThrow(/CODEX_NATIVE_SUBSCRIPTION_TRANSPORT_REQUIRED/);
  });

  it("contains neither an API-key requirement nor the removed Responses endpoint in active transport source", async () => {
    for (const sourcePath of activeTransportSources) {
      const text = await readFile(path.join(process.cwd(), sourcePath), "utf8");
      expect(text, sourcePath).not.toContain("OPENAI_API_KEY");
      expect(text, sourcePath).not.toContain("api.openai.com/v1/responses");
    }
  });
});
