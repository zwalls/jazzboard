#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const entry = path.join(repositoryRoot, "research/scripts/exp0035-controller.ts");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "exp0035-controller-"));
const runtimePath = path.join(temporaryDirectory, "runtime.mjs");

try {
  process.env.EXP0035_REPOSITORY_ROOT = repositoryRoot;
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node22"],
    write: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  });
  if (result.outputFiles?.length !== 1) throw new Error("EXP-0035 controller bundle failed.");
  await writeFile(runtimePath, result.outputFiles[0].contents, { mode: 0o600 });
  await import(pathToFileURL(runtimePath).href);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
