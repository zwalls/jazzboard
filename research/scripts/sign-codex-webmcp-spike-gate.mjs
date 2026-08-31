#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const ENTRY_PATH = path.join(REPOSITORY_ROOT, "src/lib/research/codex-webmcp-spike-sealer.ts");

let runtimePromise;

async function loadRuntime() {
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
  }).then((result) => {
    if (result.outputFiles?.length !== 1) throw new Error("SPIKE_GATE_SIGN_RUNTIME_BUILD_FAILED");
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`;
    return import(moduleUrl);
  });
  return runtimePromise;
}

export async function runCodexWebMcpSpikeGateSignerCli(argv = process.argv.slice(2), io = {
  stdout: process.stdout,
  stderr: process.stderr,
}, cwd = process.cwd()) {
  try {
    const runtime = await loadRuntime();
    return await runtime.runCodexWebMcpSpikeGateSignerCli(argv, io, cwd);
  } catch {
    io.stderr.write('{"errorCode":"INTERNAL_ERROR","status":"error"}\n');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = await runCodexWebMcpSpikeGateSignerCli();
}
