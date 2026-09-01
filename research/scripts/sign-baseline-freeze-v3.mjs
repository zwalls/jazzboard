#!/usr/bin/env node

import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const temporary = await mkdtemp(path.join(tmpdir(), "jazzboard-baseline-v3-signer-"));

try {
  const bundlePath = path.join(temporary, "signer.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "src/lib/research/baseline-freeze-v3-signer.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    absWorkingDir: repositoryRoot,
    logLevel: "silent",
  });
  const { runBaselineFreezeV3SignerCli } = await import(pathToFileURL(bundlePath).href);
  process.exitCode = await runBaselineFreezeV3SignerCli(
    process.argv.slice(2),
    { stdout: process.stdout, stderr: process.stderr },
    repositoryRoot,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
