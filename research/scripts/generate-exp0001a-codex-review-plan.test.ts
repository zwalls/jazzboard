// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  EXP0001A_CODEX_REVIEW_PLAN_PATH,
  generateExp0001aCodexReviewPlanBytes,
  runExp0001aCodexReviewPlanGenerator,
// @ts-expect-error committed ESM generator intentionally has no declaration file
} from "./generate-exp0001a-codex-review-plan.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("EXP-0001A Codex review-plan generator", () => {
  it("reproduces the committed provider-free bytes exactly", async () => {
    const generated = await generateExp0001aCodexReviewPlanBytes();
    const retained = await readFile(path.join(REPO_ROOT, EXP0001A_CODEX_REVIEW_PLAN_PATH));
    expect(generated).toEqual(retained);
    await expect(runExp0001aCodexReviewPlanGenerator(["--check"]))
      .resolves.toEqual({ mode: "check", path: EXP0001A_CODEX_REVIEW_PLAN_PATH });
  });

  it("rejects non-check command-line arguments", async () => {
    await expect(runExp0001aCodexReviewPlanGenerator(["--execute"]))
      .rejects.toThrow("Usage:");
  });
});
