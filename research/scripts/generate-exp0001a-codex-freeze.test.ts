// @vitest-environment node

import { describe, expect, it } from "vitest";

// @ts-expect-error committed ESM generator intentionally has no declarations
import { generateExp0001aCodexFreezeArtifacts } from "./generate-exp0001a-codex-freeze.mjs";
// @ts-expect-error committed ESM builder intentionally has no declarations
import { EXP0001A_REQUIRED_RUNTIME_INPUTS } from "./build-exp0001a-runtime.mjs";
import { EXP0001A_ACTIVE_RUNTIME_REQUIRED_SOURCE_PATHS } from "../../src/lib/research/exp0001a-codex-prebrief-freeze";
import { EXP0001A_OUTER_EXECUTION_REQUIRED_SOURCE_PATHS } from "../../src/lib/research/exp0001a-codex-prebrief-freeze";

describe("EXP-0001A deterministic Codex-native freeze", () => {
  it("derives exact runtime, source, schedule, review, gate, and analysis commitments without releasing a brief", async () => {
    const first = await generateExp0001aCodexFreezeArtifacts();
    const second = await generateExp0001aCodexFreezeArtifacts();
    expect(first.freezeBytes.equals(second.freezeBytes)).toBe(true);
    expect(first.runtimeBytes.equals(second.runtimeBytes)).toBe(true);
    expect(first.freeze).toMatchObject({
      executionStateAtFreeze: "not_started",
      briefReleaseAuthorized: false,
      transport: { authentication: "chatgpt_only", directHttpRequests: false },
      activeRuntime: { bundleDigest: first.runtimeBundleDigest },
      reviewCommitments: { primaryReviewerTaskCount: 96, pairwiseComparisonCount: 24 },
      accounting: { monetaryAccounting: "not_collected", estimatesPermitted: false },
    });
    expect(first.freeze.outerExecution.sourceCommitments.every(
      (source: { digest: string }) => source.digest !== `sha256:${"0".repeat(64)}`,
    )).toBe(true);
    expect([...EXP0001A_ACTIVE_RUNTIME_REQUIRED_SOURCE_PATHS].sort())
      .toEqual([...EXP0001A_REQUIRED_RUNTIME_INPUTS].sort());
    expect(first.freeze.outerExecution.sourceCommitments.map((source: { path: string }) => source.path))
      .toEqual([...EXP0001A_OUTER_EXECUTION_REQUIRED_SOURCE_PATHS]);
    expect(EXP0001A_OUTER_EXECUTION_REQUIRED_SOURCE_PATHS).toEqual(expect.arrayContaining([
      "research/scripts/exp0001a-coordinator-transaction.mjs",
      "research/scripts/exp0001a-outer-source-verifier.mjs",
      "research/scripts/generate-exp0001a-codex-review-plan.mjs",
    ]));
  }, 60_000);
});
