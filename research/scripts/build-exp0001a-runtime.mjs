#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, version as esbuildVersion } from "esbuild";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");

export const EXP0001A_RUNTIME_ENTRY = "src/lib/research/exp0001a-runtime-composition.ts";
export const EXP0001A_RUNTIME_OUTPUT = "research/runtime/exp0001a-runtime.bundle.mjs";
export const EXP0001A_ESBUILD_VERSION = "0.25.12";
export const EXP0001A_APPROVED_RUNTIME_EXTERNALS = Object.freeze([]);
export const EXP0001A_REQUIRED_RUNTIME_INPUTS = Object.freeze([
  EXP0001A_RUNTIME_ENTRY,
  "research/scripts/codex-auth-preflight.mjs",
  "src/lib/research/codex-webmcp-spike.ts",
  "src/lib/research/codex-webmcp-spike-recovery.ts",
  "src/lib/research/exp0001a-attempt-provisioning.ts",
  "src/lib/research/exp0001a-codex-accounting.ts",
  "src/lib/research/exp0001a-codex-accounting-finalizer.ts",
  "src/lib/research/exp0001a-codex-analysis.ts",
  "src/lib/research/exp0001a-codex-artifact-packet-server.ts",
  "src/lib/research/exp0001a-codex-authority.ts",
  "src/lib/research/exp0001a-codex-coordinator.ts",
  "src/lib/research/exp0001a-codex-prebrief-freeze.ts",
  "src/lib/research/exp0001a-codex-review-runtime.ts",
  "src/lib/research/exp0001a-codex-runtime-contract.ts",
  "src/lib/research/exp0001a-codex-scientific-runtime.ts",
  "src/lib/research/exp0001a-codex-task-transport.ts",
  "src/lib/research/exp0001a-completion-attestation.ts",
  "src/lib/research/statistics.ts",
]);
export const EXP0001A_RETIRED_RUNTIME_INPUTS = Object.freeze([
  "research/scripts/blinded-evaluator-runner.mjs",
  "research/scripts/clean-room-live-runner.mjs",
  "research/scripts/exp0001a-launch-authority.mjs",
  "research/scripts/exp0001a-runtime-dependencies.mjs",
  "src/lib/research/exp0001a-analysis-runtime.ts",
  "src/lib/research/exp0001a-analysis.ts",
  "src/lib/research/exp0001a-batch-command.ts",
  "src/lib/research/exp0001a-batch-coordinator.ts",
  "src/lib/research/exp0001a-execution-gate.ts",
  "src/lib/research/exp0001a-live-review-runner.ts",
  "src/lib/research/exp0001a-metrics-runtime.ts",
  "src/lib/research/exp0001a-pairwise-runtime.ts",
  "src/lib/research/exp0001a-spend-ledger.ts",
  "research/data/development-runner-profile-v1.json",
  "research/data/exp0001a-attempt-metrics-spec-v1.json",
]);

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedRepositoryInput(inputPath) {
  if (path.isAbsolute(inputPath) || inputPath.includes("\\")) {
    throw new Error(`Runtime build reported a non-portable input path: ${inputPath}`);
  }
  const normalized = path.posix.normalize(inputPath);
  if (normalized !== inputPath || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Runtime build input escaped the repository: ${inputPath}`);
  }
  return normalized;
}

function buildOptions() {
  if (esbuildVersion !== EXP0001A_ESBUILD_VERSION) {
    throw new Error(`EXP-0001A requires esbuild ${EXP0001A_ESBUILD_VERSION}; observed ${esbuildVersion}.`);
  }
  return {
    absWorkingDir: REPO_ROOT,
    entryPoints: [EXP0001A_RUNTIME_ENTRY],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node22"],
    // Bundle every non-Node dependency into the authority-bound bytes. The
    // subscription transport is an orchestration plan, not a browser/runtime
    // client, so no provider or native package remains external.
    external: [...EXP0001A_APPROVED_RUNTIME_EXTERNALS],
    treeShaking: true,
    minify: false,
    charset: "utf8",
    legalComments: "none",
    sourcemap: false,
    metafile: true,
    write: false,
    banner: {
      js: `// GENERATED FILE. Source: ${EXP0001A_RUNTIME_ENTRY}; esbuild: ${EXP0001A_ESBUILD_VERSION}.`,
    },
  };
}

/** Fail closed if the all-transitive runtime leaves any repository-selected
 * executable outside the authenticated bundle. Only Node built-ins and the
 * separately tree-attested Playwright/Sharp runtimes may remain external. */
export function assertExp0001aRuntimeBuildPolicy(metafile, bytes) {
  if (!metafile || typeof metafile !== "object" || !metafile.inputs || !metafile.outputs
      || !(bytes instanceof Uint8Array)) {
    throw new Error("EXP-0001A runtime build policy requires exact metafile and output bytes.");
  }
  const inputs = Object.keys(metafile.inputs).map(normalizedRepositoryInput);
  for (const required of EXP0001A_REQUIRED_RUNTIME_INPUTS) {
    if (inputs.filter((input) => input === required).length !== 1) {
      throw new Error(`EXP-0001A runtime build omitted or duplicated required static input: ${required}`);
    }
  }
  for (const retired of EXP0001A_RETIRED_RUNTIME_INPUTS) {
    if (inputs.includes(retired)) {
      throw new Error(`EXP-0001A runtime bundle reached retired provider-era input: ${retired}`);
    }
  }
  if (inputs.includes("research/scripts/exp0001a-batch-command.mjs")) {
    throw new Error("EXP-0001A runtime bundle must not embed the outer exact-byte launcher.");
  }
  const outputs = Object.values(metafile.outputs);
  if (outputs.length !== 1 || !Array.isArray(outputs[0]?.imports)) {
    throw new Error("EXP-0001A runtime build policy requires exactly one auditable output import table.");
  }
  for (const imported of outputs[0].imports) {
    if (!imported || imported.external !== true || typeof imported.path !== "string"
        || typeof imported.kind !== "string") {
      throw new Error("EXP-0001A runtime output contains an unresolved non-external import edge.");
    }
    const nodeBuiltin = imported.path.startsWith("node:");
    if (!nodeBuiltin) {
      throw new Error(`EXP-0001A runtime output contains an unapproved external import: ${imported.path}`);
    }
    if (nodeBuiltin && imported.kind !== "import-statement") {
      throw new Error(`EXP-0001A runtime Node built-in must use a static import: ${imported.path}`);
    }
  }
  const text = Buffer.from(bytes).toString("utf8");
  const dynamicImports = Object.entries(metafile.inputs).flatMap(([inputPath, input]) =>
    (input.imports ?? [])
      .filter((edge) => edge.kind === "dynamic-import")
      .map((edge) => ({ inputPath, importedPath: edge.path })),
  );
  if (dynamicImports.length > 0) {
    throw new Error("EXP-0001A runtime bundle contains a repository-local or computed dynamic import.");
  }
  const retiredProviderOrBillingLiterals = [
    "OPENAI_API_KEY",
    "api.openai.com",
    "costUsd",
    "maximumUsd",
    "pricing",
    "serviceTier",
    "spendAuthorization",
    "tokenBudget",
  ];
  const retainedLiteral = retiredProviderOrBillingLiterals.find((literal) => text.includes(literal));
  if (retainedLiteral !== undefined) {
    throw new Error(`EXP-0001A runtime bundle contains retired provider/billing literal: ${retainedLiteral}`);
  }
}

async function oneBuild() {
  const result = await build(buildOptions());
  if (result.outputFiles?.length !== 1 || !result.metafile) {
    throw new Error("EXP-0001A runtime build did not produce one auditable in-memory bundle.");
  }
  const bytes = Buffer.from(result.outputFiles[0].contents);
  assertExp0001aRuntimeBuildPolicy(result.metafile, bytes);
  const inputs = Object.keys(result.metafile.inputs)
    .map(normalizedRepositoryInput)
    .sort(compareCodeUnits);
  if (inputs.length === 0 || inputs[0] === undefined || !inputs.includes(EXP0001A_RUNTIME_ENTRY)) {
    throw new Error("EXP-0001A runtime build omitted its fixed composition entry point.");
  }
  if (new Set(inputs).size !== inputs.length) {
    throw new Error("EXP-0001A runtime build reported duplicate source inputs.");
  }
  const text = bytes.toString("utf8");
  if (text.includes(REPO_ROOT)
      || /(?:\/Users\/|\/Volumes\/|\/home\/|\.codex(?:\/|\\)|plugins\/cache|\.research-private)/i.test(text)
      || /sourceMappingURL/i.test(text)) {
    throw new Error("EXP-0001A runtime bundle contains a host-specific path, private path, cache path, or source-map reference.");
  }
  return Object.freeze({ bytes, inputs: Object.freeze(inputs), bundleDigest: digest(bytes) });
}

/**
 * Build twice in separate esbuild invocations. A mismatch is a hard failure;
 * callers never receive either candidate as an executable artifact.
 */
export async function buildExp0001aRuntimeBytes() {
  const first = await oneBuild();
  const second = await oneBuild();
  if (!first.bytes.equals(second.bytes)
      || first.bundleDigest !== second.bundleDigest
      || JSON.stringify(first.inputs) !== JSON.stringify(second.inputs)) {
    throw new Error("EXP-0001A runtime bundle or transitive input inventory is nondeterministic.");
  }
  return first;
}

async function plainFileBytes(filePath) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Committed EXP-0001A runtime output must be a plain non-symbolic-link file.");
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function verifyExp0001aRuntimeBundle() {
  const built = await buildExp0001aRuntimeBytes();
  const outputPath = path.join(REPO_ROOT, EXP0001A_RUNTIME_OUTPUT);
  const retained = await plainFileBytes(outputPath);
  if (!retained.equals(built.bytes)) {
    throw new Error(`Committed runtime bundle differs from the deterministic build (${digest(retained)} != ${built.bundleDigest}).`);
  }
  return built;
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeExp0001aRuntimeBundle() {
  const built = await buildExp0001aRuntimeBytes();
  const outputPath = path.join(REPO_ROOT, EXP0001A_RUNTIME_OUTPUT);
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o644,
    );
    await handle.writeFile(built.bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!Buffer.from(await readFile(temporaryPath)).equals(built.bytes)) {
      throw new Error("Temporary runtime bundle readback differs from the deterministic build.");
    }
    await rename(temporaryPath, outputPath);
    await syncDirectory(path.dirname(outputPath));
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  const retained = await plainFileBytes(outputPath);
  if (!retained.equals(built.bytes)) {
    throw new Error("Retained runtime bundle readback differs from the deterministic build.");
  }
  return built;
}

function parseMode(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--check")) return "check";
  if (argv.length === 1 && argv[0] === "--write") return "write";
  throw new Error("Usage: node research/scripts/build-exp0001a-runtime.mjs [--check|--write]");
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const result = mode === "write"
    ? await writeExp0001aRuntimeBundle()
    : await verifyExp0001aRuntimeBundle();
  process.stdout.write(`${JSON.stringify({
    mode,
    esbuildVersion,
    bundlePath: EXP0001A_RUNTIME_OUTPUT,
    bundleDigest: result.bundleDigest,
    transitiveInputCount: result.inputs.length,
    transitiveInputs: result.inputs,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
