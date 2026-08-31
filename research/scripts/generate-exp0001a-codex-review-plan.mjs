#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
export const EXP0001A_CODEX_REVIEW_PLAN_PATH =
  "research/data/exp0001a-codex-review-plan-v1.json";

async function readPlainFile(filePath) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`EXP-0001A review-plan input is not a plain file: ${filePath}`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function loadRuntime(bytes) {
  const directory = await mkdtemp(path.join(tmpdir(), "exp0001a-review-plan-"));
  const modulePath = path.join(directory, "generator.bundle.mjs");
  await writeFile(modulePath, bytes, { mode: 0o600, flag: "wx" });
  try {
    return await import(`${pathToFileURL(modulePath).href}?nonce=${Date.now()}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function buildReviewPlanGeneratorBytes() {
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: ["src/lib/research/exp0001a-codex-review-runtime.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node22"],
    write: false,
    treeShaking: true,
  });
  if (result.outputFiles?.length !== 1) {
    throw new Error("EXP-0001A review-plan generator did not produce one deterministic module.");
  }
  return Buffer.from(result.outputFiles[0].contents);
}

export async function generateExp0001aCodexReviewPlanBytes() {
  const active = await loadRuntime(await buildReviewPlanGeneratorBytes());
  if (typeof active.createExp0001aCodexReviewPlanManifest !== "function"
      || typeof active.verifyExp0001aCodexReviewPlanManifest !== "function") {
    throw new Error("Active runtime bundle does not export the frozen review-plan generator/verifier.");
  }
  const manifestPath = path.join(REPO_ROOT, "research/data/development-execution-manifest-v1.json");
  const executionManifest = JSON.parse((await readPlainFile(manifestPath)).toString("utf8"));
  const reviewPlan = active.createExp0001aCodexReviewPlanManifest({ executionManifest });
  active.verifyExp0001aCodexReviewPlanManifest({ manifest: reviewPlan, executionManifest });
  return Buffer.from(`${JSON.stringify(reviewPlan, null, 2)}\n`, "utf8");
}

async function retainAtomically(targetPath, bytes) {
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  const handle = await open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function runExp0001aCodexReviewPlanGenerator(argv = process.argv.slice(2)) {
  if (argv.some((argument) => argument !== "--check")) {
    throw new Error("Usage: generate-exp0001a-codex-review-plan.mjs [--check]");
  }
  const expected = await generateExp0001aCodexReviewPlanBytes();
  const targetPath = path.join(REPO_ROOT, EXP0001A_CODEX_REVIEW_PLAN_PATH);
  if (argv.includes("--check")) {
    const retained = await readPlainFile(targetPath);
    if (!retained.equals(expected)) {
      throw new Error("Committed EXP-0001A Codex review plan differs from deterministic generation.");
    }
    return Object.freeze({ mode: "check", path: EXP0001A_CODEX_REVIEW_PLAN_PATH });
  }
  await retainAtomically(targetPath, expected);
  const retained = await readPlainFile(targetPath);
  if (!retained.equals(expected)) throw new Error("EXP-0001A review-plan atomic readback failed.");
  return Object.freeze({ mode: "write", path: EXP0001A_CODEX_REVIEW_PLAN_PATH });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runExp0001aCodexReviewPlanGenerator()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
