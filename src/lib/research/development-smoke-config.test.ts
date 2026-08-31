import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import developmentManifest from "../../../research/benchmarks/development-v1.json";
import developmentRubrics from "../../../research/benchmarks/development-evaluator-rubrics-v1.json";
import developmentFixtureSpecs from "../../../research/benchmarks/development-fixture-specs-v1.json";
import diagnosticReviewConfig from "../../../research/data/exp-0000-v3-primary-review-config.json";
import smokeConfig from "../../../research/data/exp-0000-run-config-v1.json";
import supplementalSmokeConfig from "../../../research/data/exp-0000-run-config-v2.json";
import diagnosticSmokeConfig from "../../../research/data/exp-0000-run-config-v3.json";

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

  it("preserves historical v1/v2/v3 bindings while allowing the current runner to evolve", () => {
    const parentProtocol = readFileSync("research/protocols/exp-0000-live-author-smoke.md", "utf8");
    const amendmentOne = readFileSync("research/protocols/exp-0000-amendment-1.md", "utf8");
    const runnerBytes = readFileSync("research/scripts/clean-room-live-runner.mjs");
    const receiptBytes = readFileSync("research/data/baseline-live-contract-v1.json");
    const currentRunnerDigest = `sha256:${createHash("sha256").update(runnerBytes).digest("hex")}`;
    const currentReceiptDigest = `sha256:${createHash("sha256").update(receiptBytes).digest("hex")}`;

    const v1RunnerDigest = "sha256:03ab941fcf2663ed713b19258ae5e81f0dd581098fd5b3dff88a8b2c59584f04";
    const v2RunnerDigest = "sha256:c2cbeaf5b216a5699b7e7fcc88326ff78763988d33943256f8eb193112426c24";
    const v2ReceiptDigest = "sha256:d71dc2052428ac644ad09361358c65d4832823c2cc98ddb04773732f190716fd";

    expect(parentProtocol).toContain(v1RunnerDigest);
    expect(amendmentOne).toContain(v1RunnerDigest);
    expect(amendmentOne).toContain(v2RunnerDigest);
    expect(amendmentOne).toContain(v2ReceiptDigest);
    expect(currentRunnerDigest).not.toBe("sha256:699d803722f6425547246c9a70c7ec96e56ff525043638a6c21f48f94ca5ec12");
    expect(currentReceiptDigest).toBe("sha256:799997c344a5525be92824380e8115d65f4c7224aeb6f64f6c3938d607a12cff");
    expect(amendmentOne).not.toContain(currentRunnerDigest);
    expect(amendmentOne).not.toContain(currentReceiptDigest);
  });

  it("freezes amendment 2 to only the v3 identifier and input-budget changes from v2", () => {
    const differingKeys = [...new Set([
      ...Object.keys(supplementalSmokeConfig),
      ...Object.keys(diagnosticSmokeConfig),
    ])].filter((key) => (
      JSON.stringify(supplementalSmokeConfig[key as keyof typeof supplementalSmokeConfig])
      !== JSON.stringify(diagnosticSmokeConfig[key as keyof typeof diagnosticSmokeConfig])
    )).sort();

    expect(differingKeys).toEqual(["attemptId", "inputTokenBudget"]);
    expect(diagnosticSmokeConfig).toMatchObject({
      attemptId: "smoke-exp0000-checkout-solmax-v3",
      inputTokenBudget: 400_000,
      outputTokenBudget: 40_000,
      perResponseMaxOutputTokens: 20_000,
    });
    expect(diagnosticSmokeConfig.allowedToolNames).toEqual(supplementalSmokeConfig.allowedToolNames);
    expect(diagnosticSmokeConfig.model).toBe(supplementalSmokeConfig.model);
    expect(diagnosticSmokeConfig.reasoningEffort).toBe(supplementalSmokeConfig.reasoningEffort);
    expect(diagnosticSmokeConfig.baseUrl).toBe(supplementalSmokeConfig.baseUrl);
  });

  it("preserves the exact compiler-derived public brief in v3", () => {
    const task = compileBenchmarkTaskExecution(bundle, "dev-architecture-create-checkout");

    expect(diagnosticSmokeConfig.brief).toBe(supplementalSmokeConfig.brief);
    expect(diagnosticSmokeConfig.brief).toBe(smokeConfig.brief);
    expect(diagnosticSmokeConfig.brief).toBe(task.author.renderedBrief);
  });

  it("pins exact v1/v2 history and amendment 2 config, runner, evaluator, receipt, and contract hashes", () => {
    const fileDigest = (file: string) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
    const amendmentTwo = readFileSync("research/protocols/exp-0000-amendment-2.md", "utf8");

    expect(fileDigest("research/data/exp-0000-run-config-v1.json"))
      .toBe("sha256:6cb2004e123f67e2885f2057fb5f4a0c027ba2f5982fed3587afa79df1099790");
    expect(hashCanonicalJson(smokeConfig))
      .toBe("sha256:9e9831e82edbe7551572d147748fddf611221d22a6b6f852829522db3778ddad");
    expect(fileDigest("research/data/exp-0000-run-config-v2.json"))
      .toBe("sha256:fb7b08b62ed8da156b94634ffe118ced119e1143372d82518140a71b8e5de9f2");
    expect(hashCanonicalJson(supplementalSmokeConfig))
      .toBe("sha256:dfc1884328ebdeb381950a7f9f4a130a5540805d17c73d6a29b1dbd894817146");
    expect(fileDigest("research/data/exp-0000-run-config-v3.json"))
      .toBe("sha256:a46f725395f1884ca0551862c8f6eef604967b7068bdc0641010c71fa2423add");
    expect(hashCanonicalJson(diagnosticSmokeConfig))
      .toBe("sha256:530a33e0ae1e14f15d25de015899f4854e3ecbd648fa0ce6a5d842f671555cfd");
    expect(fileDigest("research/scripts/clean-room-live-runner.mjs"))
      .not.toBe("sha256:699d803722f6425547246c9a70c7ec96e56ff525043638a6c21f48f94ca5ec12");
    expect(fileDigest("research/scripts/blinded-evaluator-runner.mjs"))
      .not.toBe("sha256:1888105ca84a46a69f16a1439b704222201f7d04a7bb9afa3d8c87a462c4c5a6");
    expect(fileDigest("research/data/baseline-live-contract-v1.json"))
      .toBe("sha256:799997c344a5525be92824380e8115d65f4c7224aeb6f64f6c3938d607a12cff");

    for (const digest of [
      "sha256:699d803722f6425547246c9a70c7ec96e56ff525043638a6c21f48f94ca5ec12",
      "sha256:1888105ca84a46a69f16a1439b704222201f7d04a7bb9afa3d8c87a462c4c5a6",
      "sha256:799997c344a5525be92824380e8115d65f4c7224aeb6f64f6c3938d607a12cff",
      "sha256:69d4f769bbd0be98c9a5ab144d35913533e5db86ad214df61c56d9411dee121b",
      "sha256:e32b76c48f4e651fa5dcc69a514756807b1846a3883df2ea21297e91ce871cb7",
    ]) expect(amendmentTwo).toContain(digest);
  });

  it("freezes the post-seal v3 blinded review before evaluator delivery", () => {
    const fileDigest = (file: string) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
    const supplement = readFileSync("research/protocols/exp-0000-evaluator-supplement-1.md", "utf8");

    expect(diagnosticReviewConfig).toStrictEqual({
      attemptDirectory: "research/results/runs/smoke-exp0000-checkout-solmax-v3",
      expectedAttemptBundleSha256: "4d688dbfa7f7b1dc6e17511a44a9596c49fc069cb1d417547f00741a0adc98ae",
      expectedArtifactRoot: "7a33f2e367bc0c70cfbace8db24fcc6c395313f8553231f85cfaaaa38a9745b5",
      expectedAuthorEvidenceRoot: "51e0cd6a857773d7cd78b0ca1b9b9a27e78d5a52ee13fc3fbdd41834b5b130e1",
      taskId: "dev-architecture-create-checkout",
      expectedRubricSha256: "sha256:6fbd874f70c42f8119a3ae71234b40a987720514347dfa8aa1075a3754832cce",
      reviewerId: "rvw-7f4c2d91",
      reviewerRole: "primary",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      inputTokenBudget: 60_000,
      outputTokenBudget: 8_000,
      pricing: {
        currency: "USD",
        inputUsdPerMillionTokens: 4,
        cachedInputUsdPerMillionTokens: 0.4,
        outputUsdPerMillionTokens: 20,
        source: "openai-gpt-5.6-sol-2026-08-30",
      },
    });
    expect(fileDigest("research/data/exp-0000-v3-primary-review-config.json"))
      .toBe("sha256:4f004adeaccdd52c0e4f7595a5401e0b00f5e388bbf2b7b70c21ffdc3de31805");
    expect(hashCanonicalJson(diagnosticReviewConfig))
      .toBe("sha256:4d4aa23df44837b2a86ef189aecc1e868a1e38c55ee2fffdb2e901a3f93f1806");
    for (const digest of [
      "sha256:4f004adeaccdd52c0e4f7595a5401e0b00f5e388bbf2b7b70c21ffdc3de31805",
      "sha256:4d4aa23df44837b2a86ef189aecc1e868a1e38c55ee2fffdb2e901a3f93f1806",
      "sha256:1888105ca84a46a69f16a1439b704222201f7d04a7bb9afa3d8c87a462c4c5a6",
    ]) expect(supplement).toContain(digest);
  });
});
