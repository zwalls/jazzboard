// @vitest-environment node

import { describe, expect, it } from "vitest";

// The committed builder is executable ESM and intentionally has no ambient
// declaration file.
// @ts-expect-error committed ESM build script intentionally has no typings
import { buildExp0001aRuntimeBytes } from "../../../research/scripts/build-exp0001a-runtime.mjs";

describe("EXP-0001A production analysis runtime bundle boundary", () => {
  it("tree-shakes every synthetic/normalized runtime seam out of production bytes", async () => {
    const built = await buildExp0001aRuntimeBytes();
    const text = Buffer.from(built.bytes).toString("utf8");

    expect(built.inputs).not.toContain(
      "src/lib/research/exp0001a-analysis-runtime.synthetic-test-helper.ts",
    );
    expect(text).not.toMatch(/createExp0001aNormalizedAnalysisRuntimeForTesting/);
    expect(text).not.toMatch(/synthetic_analysis_complete|synthetic_analysis_fixture/);
    expect(text).not.toMatch(/process\.env\.NODE_ENV|normalized analysis-runtime seam/i);
  });
});
