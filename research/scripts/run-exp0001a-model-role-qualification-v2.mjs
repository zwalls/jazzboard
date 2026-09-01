#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const ENTRY_PATH = path.join(
  REPOSITORY_ROOT,
  "src/lib/research/exp0001a-model-role-qualification-v2-coordinator-cli.ts",
);
const PRIVATE_RUNTIME_ROOT = path.join(REPOSITORY_ROOT, ".research-private", "exp0001a-qualification-v2");

let runtimePromise;

async function loadRuntime() {
  runtimePromise ??= (async () => {
    const result = await build({
      absWorkingDir: REPOSITORY_ROOT,
      entryPoints: [ENTRY_PATH],
      bundle: true,
      platform: "node",
      format: "esm",
      target: ["node22"],
      packages: "external",
      write: false,
      sourcemap: false,
      legalComments: "none",
      logLevel: "silent",
    });
    if (result.outputFiles?.length !== 1) throw new Error("QUALIFICATION_V2_COORDINATOR_BUILD_FAILED");
    await mkdir(PRIVATE_RUNTIME_ROOT, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(PRIVATE_RUNTIME_ROOT, ".coordinator-runtime-"));
    await chmod(directory, 0o700);
    const runtimePath = path.join(directory, "runtime.mjs");
    await writeFile(runtimePath, result.outputFiles[0].contents, { flag: "wx", mode: 0o600 });
    try {
      return {
        module: await import(pathToFileURL(runtimePath).href),
        cleanup: () => rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  })();
  return runtimePromise;
}

export async function runQualificationV2Coordinator(argv = process.argv.slice(2), io = {
  stdout: process.stdout,
  stderr: process.stderr,
}) {
  let loaded;
  try {
    loaded = await loadRuntime();
    return await loaded.module.runQualificationV2CoordinatorCli(argv, io, REPOSITORY_ROOT);
  } catch {
    io.stderr.write('{"errorCode":"QUALIFICATION_V2_COORDINATOR_INTERNAL_ERROR","status":"error"}\n');
    return 1;
  } finally {
    await loaded?.cleanup().catch(() => undefined);
    runtimePromise = undefined;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = await runQualificationV2Coordinator();
}
