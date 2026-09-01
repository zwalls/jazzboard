#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const ENTRY_PATH = path.join(
  REPOSITORY_ROOT,
  "src/lib/research/exp0001a-model-role-qualification-v2-task-runner-cli.ts",
);

let runtimePromise;
async function runtime() {
  runtimePromise ??= build({
    absWorkingDir: REPOSITORY_ROOT,
    entryPoints: [ENTRY_PATH],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node22"],
    write: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  }).then((result) => import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`));
  return runtimePromise;
}

export async function runQualificationV2TaskRunner(argv = process.argv.slice(2), io = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
}) {
  try {
    return await (await runtime()).runQualificationV2TaskRunnerCli(argv, io, REPOSITORY_ROOT);
  } catch {
    io.stderr.write('{"errorCode":"QUALIFICATION_V2_TASK_RUNNER_INTERNAL_ERROR","status":"error"}\n');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = await runQualificationV2TaskRunner();
}
