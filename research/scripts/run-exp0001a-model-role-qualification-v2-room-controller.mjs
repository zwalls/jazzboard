#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const ENTRY_PATH = path.join(
  REPOSITORY_ROOT,
  "src/lib/research/exp0001a-model-role-qualification-v2-room-controller.ts",
);
const PRIVATE_RUNTIME_ROOT = path.join(REPOSITORY_ROOT, ".research-private", "exp0001a-qualification-v2-runtime");
const DEPENDENCY_LOCK_PATH = path.join(REPOSITORY_ROOT, "package-lock.json");
const execFileAsync = promisify(execFile);

let runtimePromise;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function harnessRuntimeProvenance(bundleBytes) {
  const [wrapperBytes, lockfileBytes, commitResult, treeResult, statusResult] = await Promise.all([
    readFile(SCRIPT_PATH),
    readFile(DEPENDENCY_LOCK_PATH),
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }),
    execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
  ]);
  if (statusResult.stdout.trim().length !== 0) {
    throw new Error("QUALIFICATION_V2_HARNESS_WORKTREE_NOT_CLEAN");
  }
  return {
    controllerBundleDigest: sha256(bundleBytes),
    wrapperSourceDigest: sha256(wrapperBytes),
    dependencyLockfileDigest: sha256(lockfileBytes),
    gitCommit: commitResult.stdout.trim(),
    gitTree: treeResult.stdout.trim(),
    worktreeClean: true,
  };
}

async function runtime() {
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
    if (result.outputFiles?.length !== 1) {
      throw new Error("QUALIFICATION_V2_ROOM_CONTROLLER_BUILD_FAILED");
    }
    const bundleBytes = result.outputFiles[0].contents;
    const provenance = await harnessRuntimeProvenance(bundleBytes);
    await mkdir(PRIVATE_RUNTIME_ROOT, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(PRIVATE_RUNTIME_ROOT, ".room-controller-runtime-"));
    await chmod(directory, 0o700);
    const runtimePath = path.join(directory, "runtime.mjs");
    await writeFile(runtimePath, bundleBytes, { flag: "wx", mode: 0o600 });
    try {
      return {
        module: await import(pathToFileURL(runtimePath).href),
        provenance,
        cleanup: () => rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  })();
  return runtimePromise;
}

export async function runQualificationV2RoomController(argv = process.argv.slice(2), io = {
  stdout: process.stdout,
  stderr: process.stderr,
}) {
  let loaded;
  try {
    loaded = await runtime();
    return await loaded.module.runQualificationV2RoomControllerCli(
      argv,
      io,
      REPOSITORY_ROOT,
      loaded.provenance,
    );
  } catch {
    io.stderr.write('{"errorCode":"QUALIFICATION_V2_ROOM_CONTROLLER_INTERNAL_ERROR","status":"error"}\n');
    return 1;
  } finally {
    await loaded?.cleanup().catch(() => undefined);
    runtimePromise = undefined;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = await runQualificationV2RoomController();
}
