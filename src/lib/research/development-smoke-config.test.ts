import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import developmentManifest from "../../../research/benchmarks/development-v1.json";
import developmentRubrics from "../../../research/benchmarks/development-evaluator-rubrics-v1.json";
import developmentFixtureSpecs from "../../../research/benchmarks/development-fixture-specs-v1.json";
import smokeConfig from "../../../research/data/exp-0000-run-config-v1.json";
import supplementalSmokeConfig from "../../../research/data/exp-0000-run-config-v2.json";

import {
  compileBenchmarkTaskExecution,
  parseBenchmarkExecutionBundle,
} from "./benchmark-execution";
import { hashCanonicalJson } from "./provenance-crypto";

const bundle = parseBenchmarkExecutionBundle(
  developmentManifest,
  developmentRubrics,
  developmentFixtureSpecs,
);

describe("EXP-0000 frozen smoke configuration", () => {
  it("uses the compiler's exact public brief without evaluator or fixture leakage", () => {
    const task = compileBenchmarkTaskExecution(bundle, "dev-architecture-create-checkout");
    expect(smokeConfig.brief).toBe(task.author.renderedBrief);
    expect(task.trustedCoordinator.preBriefSetup).toBeNull();
    expect(task.trustedCoordinator.concurrentEvent).toBeNull();
    expect(smokeConfig.setupOperations).toEqual([]);
    expect(smokeConfig.concurrentEvents).toEqual([]);
    expect(smokeConfig.brief).not.toMatch(/evaluatorProcedure|passCondition|semanticReference|geometryThresholds|issueTags|fixture-/);
  });

  it("pins the public baseline contracts, Sol max, and conservative smoke budgets", () => {
    expect(smokeConfig).toMatchObject({
      attemptId: "smoke-exp0000-checkout-solmax-v1",
      baseUrl: "https://www.jazzboard.xyz/",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      participantToolContractHash: "d64cf3d25b9e275003438597b3b01c35419063d71613082d45aaf2f97c388b8e",
      spectatorToolContractHash: "1760c6b1ec8cc4d8814b3de6a8f4516b3f4c215da69069c50072f23128541be2",
      wallBudgetMs: 600_000,
      toolCallBudget: 40,
      inputTokenBudget: 80_000,
      outputTokenBudget: 12_000,
      perResponseMaxOutputTokens: 4_000,
    });
    expect(new Set(smokeConfig.allowedToolNames).size).toBe(smokeConfig.allowedToolNames.length);
    expect(smokeConfig.allowedToolNames).toContain("apply_canvas_transaction");
    expect(smokeConfig.allowedToolNames).toContain("inspect_canvas_scope");
    expect(smokeConfig.allowedToolNames).not.toContain("create_room");
    expect(smokeConfig.allowedToolNames).not.toContain("join_room");
    expect(smokeConfig.allowedToolNames).not.toContain("leave_room");
  });

  it("keeps the exact checked-in config byte-stable until execution", () => {
    const bytes = readFileSync("research/data/exp-0000-run-config-v1.json");
    expect(bytes.length).toBeGreaterThan(1_000);
    expect(hashCanonicalJson(smokeConfig)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("freezes amendment 1 to exactly the permitted identifier and token-budget changes", () => {
    const differingKeys = [...new Set([
      ...Object.keys(smokeConfig),
      ...Object.keys(supplementalSmokeConfig),
    ])].filter((key) => (
      JSON.stringify(smokeConfig[key as keyof typeof smokeConfig])
      !== JSON.stringify(supplementalSmokeConfig[key as keyof typeof supplementalSmokeConfig])
    )).sort();

    expect(differingKeys).toEqual([
      "attemptId",
      "inputTokenBudget",
      "outputTokenBudget",
      "perResponseMaxOutputTokens",
    ]);
    expect(supplementalSmokeConfig).toMatchObject({
      attemptId: "smoke-exp0000-checkout-solmax-v2",
      inputTokenBudget: 150_000,
      outputTokenBudget: 40_000,
      perResponseMaxOutputTokens: 20_000,
    });
    expect(supplementalSmokeConfig.wallBudgetMs).toBe(smokeConfig.wallBudgetMs);
    expect(supplementalSmokeConfig.toolCallBudget).toBe(smokeConfig.toolCallBudget);
  });

  it("preserves the exact compiler-derived brief in both smoke configs", () => {
    const task = compileBenchmarkTaskExecution(bundle, "dev-architecture-create-checkout");

    expect(supplementalSmokeConfig.brief).toBe(smokeConfig.brief);
    expect(supplementalSmokeConfig.brief).toBe(task.author.renderedBrief);
  });

  it("matches amendment 1's preregistered byte and canonical config digests", () => {
    const bytes = readFileSync("research/data/exp-0000-run-config-v2.json");

    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`)
      .toBe("sha256:fb7b08b62ed8da156b94634ffe118ced119e1143372d82518140a71b8e5de9f2");
    expect(hashCanonicalJson(supplementalSmokeConfig))
      .toBe("sha256:dfc1884328ebdeb381950a7f9f4a130a5540805d17c73d6a29b1dbd894817146");
  });

  it("binds supplemental execution to the authorized provenance runner and live receipt", () => {
    const runnerBytes = readFileSync("research/scripts/clean-room-live-runner.mjs");
    const receiptBytes = readFileSync("research/data/baseline-live-contract-v1.json");

    expect(`sha256:${createHash("sha256").update(runnerBytes).digest("hex")}`)
      .toBe("sha256:c2cbeaf5b216a5699b7e7fcc88326ff78763988d33943256f8eb193112426c24");
    expect(`sha256:${createHash("sha256").update(receiptBytes).digest("hex")}`)
      .toBe("sha256:d71dc2052428ac644ad09361358c65d4832823c2cc98ddb04773732f190716fd");
  });
});
