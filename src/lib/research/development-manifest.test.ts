// @vitest-environment node

import { describe, expect, it } from "vitest";

import developmentBundle from "../../../research/benchmarks/development-v1.json";
import prospectiveDevelopmentBundle from "../../../research/benchmarks/development-v2.json";
import checkedInManifest from "../../../research/data/development-execution-manifest-v1.json";
import prospectiveCheckedInManifest from "../../../research/data/development-execution-manifest-v2.json";
import {
  DEVELOPMENT_AA_TREATMENT_DIGEST,
  DEVELOPMENT_EXECUTION_SEED,
  computeDevelopmentManifestDigest,
  createDevelopmentExecutionManifest,
  developmentExecutionManifestSchema,
  loadDevelopmentBundle,
  verifyDevelopmentExecutionManifest,
  type DevelopmentExecutionManifest,
} from "./development-manifest";
import { hashCanonicalJson } from "./provenance-crypto";

function cloneManifest(): DevelopmentExecutionManifest {
  return developmentExecutionManifestSchema.parse(structuredClone(checkedInManifest));
}

describe("EXP-0001A development execution manifest", () => {
  it("loads the 12-task public development bundle and matches the checked-in manifest", () => {
    const bundle = loadDevelopmentBundle(developmentBundle);
    const generated = createDevelopmentExecutionManifest(bundle, DEVELOPMENT_EXECUTION_SEED);

    expect(bundle.tasks).toHaveLength(12);
    expect(generated).toEqual(checkedInManifest);
    expect(verifyDevelopmentExecutionManifest(checkedInManifest, bundle)).toMatchObject({ ok: true });
  });

  it("keeps v1 immutable while generating and verifying the prospective v2 manifest independently", () => {
    const generated = createDevelopmentExecutionManifest(prospectiveDevelopmentBundle, DEVELOPMENT_EXECUTION_SEED);

    expect(generated).toEqual(prospectiveCheckedInManifest);
    expect(generated).toMatchObject({
      manifestId: "exp-0001a-development-execution-v2",
      benchmark: {
        path: "research/benchmarks/development-v2.json",
        benchmarkId: "jazzboard-development-v2",
      },
    });
    expect(verifyDevelopmentExecutionManifest(prospectiveCheckedInManifest, prospectiveDevelopmentBundle))
      .toMatchObject({ ok: true });
    expect(createDevelopmentExecutionManifest(developmentBundle)).toEqual(checkedInManifest);
  });

  it("rejects cross-version manifest and benchmark pairings", () => {
    expect(verifyDevelopmentExecutionManifest(prospectiveCheckedInManifest, developmentBundle)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["BENCHMARK_ID_MISMATCH"]),
    });
  });

  it("is deterministic and binds every task and pair canonically", () => {
    const first = createDevelopmentExecutionManifest(developmentBundle);
    const second = createDevelopmentExecutionManifest(structuredClone(developmentBundle));

    expect(first).toEqual(second);
    expect(computeDevelopmentManifestDigest(first)).toBe(first.manifestDigest);
    expect(first.tasks.map((task) => task.taskDigest)).toHaveLength(new Set(first.tasks.map((task) => task.taskDigest)).size);
    expect(first.assignments.every((pair) => pair.pairDigest.startsWith("sha256:"))).toBe(true);
  });

  it("allocates exactly two fresh opaque-label attempts to every task-replicate pair", () => {
    const manifest = cloneManifest();
    const attempts = manifest.assignments.flatMap((pair) => pair.attempts);

    expect(manifest.assignments).toHaveLength(24);
    expect(attempts).toHaveLength(48);
    expect(new Set(manifest.assignments.map((pair) => `${pair.taskId}:${pair.replicateIndex}`)).size).toBe(24);
    expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(48);
    expect(manifest.assignments.every((pair) => new Set(pair.order).size === 2)).toBe(true);
    expect(attempts.every((attempt) => attempt.freshAuthorContext && attempt.freshRoom)).toBe(true);
  });

  it("balances order globally and within family-replicate blocks and interleaves families", () => {
    const manifest = cloneManifest();
    expect(manifest.assignments.filter((pair) => pair.order[0] === "A0")).toHaveLength(12);
    expect(manifest.assignments.filter((pair) => pair.order[0] === "A1")).toHaveLength(12);
    for (const family of ["architecture", "drawing"] as const) {
      for (const replicateIndex of [0, 1] as const) {
        const block = manifest.assignments.filter(
          (pair) => pair.taskFamily === family && pair.replicateIndex === replicateIndex,
        );
        expect(block.filter((pair) => pair.order[0] === "A0")).toHaveLength(3);
        expect(block.filter((pair) => pair.order[0] === "A1")).toHaveLength(3);
      }
    }
    manifest.assignments.forEach((pair, index) => {
      if (index > 0) expect(pair.taskFamily).not.toBe(manifest.assignments[index - 1].taskFamily);
    });
  });

  it("uses byte-identical frozen-baseline treatments behind A0 and A1", () => {
    const manifest = cloneManifest();
    expect(manifest.treatments).toEqual({
      A0: DEVELOPMENT_AA_TREATMENT_DIGEST,
      A1: DEVELOPMENT_AA_TREATMENT_DIGEST,
    });
    expect(new Set(manifest.assignments.flatMap((pair) => pair.attempts.map((attempt) => attempt.treatmentDigest))))
      .toEqual(new Set([DEVELOPMENT_AA_TREATMENT_DIGEST]));
  });

  it("detects task, pair, and manifest tampering", () => {
    const manifest = cloneManifest();
    manifest.assignments[0].taskDigest = hashCanonicalJson({ tampered: true });

    expect(verifyDevelopmentExecutionManifest(manifest, developmentBundle)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "MANIFEST_DIGEST_INVALID",
        expect.stringMatching(/PAIR_DIGEST_INVALID/),
        "MANIFEST_NOT_DETERMINISTIC_EXPECTATION",
      ]),
    });
  });

  it("rejects unknown fields and non-fixed seeds", () => {
    expect(developmentExecutionManifestSchema.safeParse({ ...checkedInManifest, unknown: true }).success).toBe(false);
    expect(() => createDevelopmentExecutionManifest(developmentBundle, DEVELOPMENT_EXECUTION_SEED + 1))
      .toThrow(/requires fixed seed/);
  });

  it("contains no sealed label, secret field, or room/session credential", () => {
    const serialized = JSON.stringify(checkedInManifest);
    expect(serialized).not.toMatch(/sealed/i);
    expect(serialized).not.toMatch(/roomId|roomCode|session|cookie|authorization|password|secret|token/i);
    expect(verifyDevelopmentExecutionManifest(checkedInManifest, developmentBundle)).toMatchObject({ ok: true });
  });
});
