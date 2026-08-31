// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import executionManifestJson from "../data/development-execution-manifest-v1.json";

// The committed builder is executable ESM and intentionally has no ambient declaration file.
// @ts-expect-error committed ESM build script intentionally has no typings
import { assertExp0001aRuntimeBuildPolicy, buildExp0001aRuntimeBytes, EXP0001A_APPROVED_RUNTIME_EXTERNALS, EXP0001A_ESBUILD_VERSION, EXP0001A_REQUIRED_RUNTIME_INPUTS, EXP0001A_RETIRED_RUNTIME_INPUTS, EXP0001A_RUNTIME_ENTRY, EXP0001A_RUNTIME_OUTPUT } from "./build-exp0001a-runtime.mjs";

function policyMetafile(imports: Array<{ path: string; kind: string; external: boolean }> = []) {
  return {
    inputs: Object.fromEntries(EXP0001A_REQUIRED_RUNTIME_INPUTS.map((sourcePath: string) => [sourcePath, { imports: [] }])),
    outputs: { "runtime.mjs": { imports } },
  };
}

describe("EXP-0001A deterministic runtime bundle", () => {
  it("builds the exact fixed composition twice with stable bytes and a repository-local source graph", async () => {
    const first = await buildExp0001aRuntimeBytes();
    const second = await buildExp0001aRuntimeBytes();

    expect(EXP0001A_ESBUILD_VERSION).toBe("0.25.12");
    expect(EXP0001A_RUNTIME_ENTRY).toBe("src/lib/research/exp0001a-runtime-composition.ts");
    expect(EXP0001A_RUNTIME_OUTPUT).toBe("research/runtime/exp0001a-runtime.bundle.mjs");
    expect(first.bundleDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.bundleDigest).toBe(first.bundleDigest);
    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    expect(first.inputs).toContain(EXP0001A_RUNTIME_ENTRY);
    expect(first.inputs).toEqual(expect.arrayContaining(EXP0001A_REQUIRED_RUNTIME_INPUTS));
    expect(first.inputs).not.toEqual(expect.arrayContaining(EXP0001A_RETIRED_RUNTIME_INPUTS));
    expect(first.inputs).not.toContain("research/scripts/exp0001a-batch-command.mjs");
    expect(first.inputs.length).toBeGreaterThan(10);
    expect(first.inputs.every((sourcePath: string) => (
      !sourcePath.startsWith("/")
        && !sourcePath.includes("\\")
        && !sourcePath.startsWith("../")
        && !sourcePath.includes("/../")
    ))).toBe(true);

    const text = Buffer.from(first.bytes).toString("utf8");
    expect(text).toContain("GENERATED FILE");
    expect(text).toContain("runExp0001aCodexRuntime");
    expect(text).toContain("prepareExp0001aCodexTaskTransport");
    expect(text).not.toContain("recordExp0001aCodexTaskObservability");
    expect(text).not.toMatch(/runtime bundle has not been built/i);
    expect(text).not.toMatch(/sourceMappingURL|\.research-private|\/Users\/|\/Volumes\/|\/home\/|\.codex(?:\/|\\)|plugins\/cache/i);
    // Browser bootstrap source is retained as inert prompt text and may contain
    // an `import()` example. Executable dynamic imports are rejected from the
    // esbuild metafile by `assertExp0001aRuntimeBuildPolicy`.
  }, 30_000);

  it("rejects unapproved externals, computed local imports, and embedding the outer launcher", () => {
    expect(EXP0001A_APPROVED_RUNTIME_EXTERNALS).toEqual([]);
    expect(() => assertExp0001aRuntimeBuildPolicy(
      policyMetafile([{ path: "../../../research/scripts/attacker.mjs", kind: "dynamic-import", external: true }]),
      Buffer.from("export {};\n"),
    )).toThrow(/unapproved external/i);

    const withDynamicImport = policyMetafile();
    withDynamicImport.inputs[EXP0001A_RUNTIME_ENTRY].imports = [
      { path: "./attacker.mjs", kind: "dynamic-import", external: false },
    ];
    expect(() => assertExp0001aRuntimeBuildPolicy(
      withDynamicImport,
      Buffer.from("export {};\n"),
    )).toThrow(/repository-local or computed dynamic import/i);

    const withOuterLauncher = policyMetafile();
    withOuterLauncher.inputs["research/scripts/exp0001a-batch-command.mjs"] = {};
    expect(() => assertExp0001aRuntimeBuildPolicy(withOuterLauncher, Buffer.from("export {};\n")))
      .toThrow(/must not embed the outer exact-byte launcher/i);

    const withRetiredProvider = policyMetafile();
    withRetiredProvider.inputs["src/lib/research/exp0001a-spend-ledger.ts"] = {};
    expect(() => assertExp0001aRuntimeBuildPolicy(withRetiredProvider, Buffer.from("export {};\n")))
      .toThrow(/retired provider-era input/i);
  });

  it("exports the complete provider-free scientific review transition surface", async () => {
    const built = await buildExp0001aRuntimeBytes();
    const directory = await mkdtemp(path.join(tmpdir(), "exp0001a-bundle-review-"));
    const modulePath = path.join(directory, "runtime.mjs");
    try {
      await writeFile(modulePath, built.bytes, { mode: 0o600 });
      const runtime = await import(`${pathToFileURL(modulePath).href}?digest=${built.bundleDigest}`);
      for (const exportName of [
        "sealExp0001aCodexAuthorArtifactCatalog",
        "createExp0001aCodexPrimaryReviewWorkOrder",
        "recordExp0001aCodexPrimaryReviewResults",
        "createExp0001aCodexAdjudicationWorkOrder",
        "recordExp0001aCodexAdjudicationResults",
        "lockExp0001aCodexClassifications",
        "createExp0001aCodexPairwiseWorkOrder",
        "recordExp0001aCodexPairwiseResults",
        "createExp0001aCodexAnalysisReceipt",
      ]) {
        expect(runtime[exportName], exportName).toBeTypeOf("function");
      }
      expect(runtime.recordExp0001aCodexTaskObservability).toBeUndefined();
      const plan = runtime.createExp0001aCodexReviewPlanManifest({ executionManifest: executionManifestJson });
      expect(runtime.verifyExp0001aCodexReviewPlanManifest({
        manifest: plan,
        executionManifest: executionManifestJson,
      }).manifestDigest).toBe("sha256:595509ee99142d4c7e78a42a7034f4f28dfdba70b870819f59f74f8e88995e6c");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
